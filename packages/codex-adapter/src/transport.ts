import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import WebSocket, { type RawData } from "ws";
import { boundedProtocolText, HostDeckCodexAdapterError } from "./errors.js";

export type CodexTransportState = "closed" | "closing" | "connecting" | "idle" | "open";

export type CodexTransportEvent =
  | { readonly type: "open"; readonly generation: number }
  | { readonly type: "message"; readonly generation: number; readonly text: string }
  | {
      readonly type: "close";
      readonly generation: number;
      readonly code: number;
      readonly reason: string;
      readonly clean: boolean;
    }
  | { readonly type: "error"; readonly generation: number; readonly error: HostDeckCodexAdapterError };

export type CodexTransportListener = (event: CodexTransportEvent) => void;
export type UnsubscribeCodexTransport = () => void;

export interface CodexTextTransport {
  readonly state: CodexTransportState;
  readonly generation: number;
  readonly max_frame_bytes: number;
  readonly connect: (signal?: AbortSignal) => Promise<void>;
  readonly sendText: (text: string) => Promise<void>;
  readonly close: (reason: string) => Promise<void>;
  readonly terminate: (error: HostDeckCodexAdapterError) => void;
  readonly subscribe: (listener: CodexTransportListener) => UnsubscribeCodexTransport;
}

export interface CodexUnixWebSocketTransportOptions {
  readonly socket_path: string;
  readonly handshake_timeout_ms?: number;
  readonly close_timeout_ms?: number;
  readonly heartbeat_interval_ms?: number;
  readonly heartbeat_timeout_ms?: number;
  readonly max_frame_bytes?: number;
  readonly max_buffered_bytes?: number;
}

interface ParsedTransportOptions {
  readonly socket_path: string;
  readonly handshake_timeout_ms: number;
  readonly close_timeout_ms: number;
  readonly heartbeat_interval_ms: number;
  readonly heartbeat_timeout_ms: number;
  readonly max_frame_bytes: number;
  readonly max_buffered_bytes: number;
}

const transportDefaults = {
  handshake_timeout_ms: 5_000,
  close_timeout_ms: 2_000,
  heartbeat_interval_ms: 15_000,
  heartbeat_timeout_ms: 5_000,
  max_frame_bytes: 1_048_576,
  max_buffered_bytes: 2_097_152
} as const;

export function createCodexUnixWebSocketTransport(options: unknown): CodexTextTransport {
  return new CodexUnixWebSocketTransport(parseTransportOptions(options));
}

class CodexUnixWebSocketTransport implements CodexTextTransport {
  private readonly listeners = new Set<CodexTransportListener>();
  private readonly closeWaiters = new Set<() => void>();
  private readonly outboundReservations = new WeakMap<WebSocket, number>();
  private socket: WebSocket | null = null;
  private currentState: CodexTransportState = "idle";
  private currentGeneration = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatDeadline: NodeJS.Timeout | null = null;

  constructor(private readonly options: ParsedTransportOptions) {}

  get state(): CodexTransportState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get max_frame_bytes(): number {
    return this.options.max_frame_bytes;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.currentState === "connecting" || this.currentState === "open" || this.currentState === "closing") {
      throw transportError("transport_connect_failed", `Cannot connect Codex transport while it is ${this.currentState}.`, "not_sent", true);
    }
    if (signal?.aborted === true) throw transportError("transport_aborted", "Codex transport connection was aborted.", "not_sent", true);

    this.clearHeartbeat();
    this.currentState = "connecting";
    const socket = new WebSocket(`ws+unix:${this.options.socket_path}`, {
      followRedirects: false,
      handshakeTimeout: this.options.handshake_timeout_ms,
      maxPayload: this.options.max_frame_bytes,
      perMessageDeflate: false
    });
    this.socket = socket;
    this.attachSocket(socket);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onCloseBeforeOpen);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: HostDeckCodexAdapterError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.socket === socket) this.currentState = "closed";
        socket.terminate();
        reject(error);
      };
      const onOpen = () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        cleanup();
        this.currentState = "open";
        this.currentGeneration += 1;
        this.scheduleHeartbeat(socket);
        this.emit({ type: "open", generation: this.currentGeneration });
        resolve();
      };
      const onError = (cause: Error) => {
        rejectOnce(
          new HostDeckCodexAdapterError("transport_connect_failed", "Unable to connect to the private Codex Unix socket.", {
            cause,
            outcome: "not_sent",
            retry_safe: true
          })
        );
      };
      const onCloseBeforeOpen = () => {
        rejectOnce(transportError("transport_connect_failed", "Codex Unix socket closed before WebSocket handshake.", "not_sent", true));
      };
      const onAbort = () => rejectOnce(transportError("transport_aborted", "Codex transport connection was aborted.", "not_sent", true));

      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onCloseBeforeOpen);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async sendText(text: string): Promise<void> {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes < 1 || bytes > this.options.max_frame_bytes) {
      throw transportError(
        "transport_overloaded",
        `Codex outbound frame must contain 1 to ${this.options.max_frame_bytes} UTF-8 bytes.`,
        "not_sent",
        true
      );
    }
    const socket = this.socket;
    if (this.currentState !== "open" || socket === null || socket.readyState !== WebSocket.OPEN) {
      throw transportError("transport_not_open", "Codex transport is not open.", "not_sent", true);
    }
    const reservedBytes = this.outboundReservations.get(socket) ?? 0;
    if (reservedBytes + bytes > this.options.max_buffered_bytes || socket.bufferedAmount + bytes > this.options.max_buffered_bytes) {
      throw transportError("transport_overloaded", "Codex outbound transport queue is full.", "not_sent", true);
    }
    this.outboundReservations.set(socket, reservedBytes + bytes);

    await new Promise<void>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const current = this.outboundReservations.get(socket) ?? 0;
        this.outboundReservations.set(socket, Math.max(0, current - bytes));
      };
      try {
        socket.send(text, { binary: false, compress: false }, (cause) => {
          release();
          if (cause === undefined || cause === null) resolve();
          else {
            reject(
              new HostDeckCodexAdapterError("transport_send_failed", "Codex transport could not confirm the outbound frame write.", {
                cause,
                outcome: "unknown",
                retry_safe: false
              })
            );
          }
        });
      } catch (cause) {
        release();
        reject(
          new HostDeckCodexAdapterError("transport_send_failed", "Codex transport rejected the outbound frame.", {
            cause,
            outcome: "not_sent",
            retry_safe: true
          })
        );
      }
    });
  }

  async close(reason: string): Promise<void> {
    const socket = this.socket;
    if (socket === null || this.currentState === "idle" || this.currentState === "closed") {
      this.currentState = "closed";
      return;
    }
    this.clearHeartbeat();
    this.currentState = "closing";
    const closed = this.waitForClose();
    try {
      socket.close(1000, websocketCloseReason(reason));
    } catch {
      socket.terminate();
    }
    if (await settlesWithin(closed, this.options.close_timeout_ms)) return;
    socket.terminate();
    if (!(await settlesWithin(closed, 1_000))) {
      this.currentState = "closed";
      this.socket = null;
      this.closeWaiters.clear();
      throw transportError("transport_closed", "Codex transport did not close after forced termination.", "not_applicable", false);
    }
  }

  terminate(error: HostDeckCodexAdapterError): void {
    this.clearHeartbeat();
    this.emit({ type: "error", generation: this.currentGeneration, error });
    const socket = this.socket;
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  subscribe(listener: CodexTransportListener): UnsubscribeCodexTransport {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private attachSocket(socket: WebSocket): void {
    socket.on("message", (data, isBinary) => {
      if (this.socket !== socket || this.currentState !== "open") return;
      if (isBinary) {
        this.terminate(transportError("protocol_violation", "Codex app-server sent a binary WebSocket frame.", "not_applicable", false));
        return;
      }
      const text = rawDataToText(data);
      if (Buffer.byteLength(text, "utf8") > this.options.max_frame_bytes) {
        this.terminate(transportError("protocol_violation", "Codex app-server frame exceeded the configured bound.", "not_applicable", false));
        return;
      }
      this.emit({ type: "message", generation: this.currentGeneration, text });
    });
    socket.on("pong", () => {
      if (this.socket !== socket || this.currentState !== "open" || this.heartbeatDeadline === null) return;
      clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = null;
      this.scheduleHeartbeat(socket);
    });
    socket.on("error", (cause) => {
      if (this.socket !== socket) return;
      this.emit({
        type: "error",
        generation: this.currentGeneration,
        error: new HostDeckCodexAdapterError("transport_closed", "Codex WebSocket transport reported an error.", {
          cause,
          outcome: "not_applicable",
          retry_safe: false
        })
      });
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.clearHeartbeat();
      this.outboundReservations.delete(socket);
      this.socket = null;
      this.currentState = "closed";
      const boundedReason = boundedProtocolText(reason.toString("utf8"), "Codex transport closed without a reason.");
      this.emit({ type: "close", generation: this.currentGeneration, code, reason: boundedReason, clean: code === 1000 });
      for (const resolve of this.closeWaiters) resolve();
      this.closeWaiters.clear();
    });
  }

  private emit(event: CodexTransportEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        const socket = this.socket;
        if (socket !== null && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }
    }
  }

  private waitForClose(): Promise<void> {
    if (this.currentState === "closed" || this.socket === null) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.add(resolve));
  }

  private scheduleHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    const timer = setTimeout(() => {
      if (this.heartbeatTimer === timer) this.heartbeatTimer = null;
      if (this.socket !== socket || this.currentState !== "open") return;
      try {
        socket.ping();
      } catch (cause) {
        this.terminate(
          new HostDeckCodexAdapterError("transport_closed", "Codex heartbeat ping failed.", {
            cause,
            outcome: "not_applicable",
            retry_safe: false
          })
        );
        return;
      }
      const deadline = setTimeout(() => {
        if (this.heartbeatDeadline === deadline) this.heartbeatDeadline = null;
        if (this.socket !== socket || this.currentState !== "open") return;
        this.terminate(transportError("transport_closed", "Codex heartbeat timed out.", "not_applicable", false));
      }, this.options.heartbeat_timeout_ms);
      deadline.unref();
      this.heartbeatDeadline = deadline;
    }, this.options.heartbeat_interval_ms);
    timer.unref();
    this.heartbeatTimer = timer;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    if (this.heartbeatDeadline !== null) clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = null;
    this.heartbeatDeadline = null;
  }
}

function parseTransportOptions(candidate: unknown): ParsedTransportOptions {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidTransportConfig("options must be an object");
  const value = candidate as Record<string, unknown>;
  const allowed = [
    "close_timeout_ms",
    "handshake_timeout_ms",
    "heartbeat_interval_ms",
    "heartbeat_timeout_ms",
    "max_buffered_bytes",
    "max_frame_bytes",
    "socket_path"
  ];
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !allowed.includes(key))) throw invalidTransportConfig(`unknown option ${keys.find((key) => !allowed.includes(key))}`);

  const socketPath = value.socket_path;
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    socketPath.length < 2 ||
    Buffer.byteLength(socketPath, "utf8") > 107 ||
    [":", "?", "#", "%"].some((character) => socketPath.includes(character)) ||
    containsControlCharacter(socketPath)
  ) {
    throw invalidTransportConfig(
      "socket_path must be an absolute Linux Unix-socket path of at most 107 UTF-8 bytes without URL delimiters, escapes, or control characters"
    );
  }

  const handshakeTimeout = parseBoundedInteger(value.handshake_timeout_ms, transportDefaults.handshake_timeout_ms, 50, 30_000, "handshake_timeout_ms");
  const closeTimeout = parseBoundedInteger(value.close_timeout_ms, transportDefaults.close_timeout_ms, 50, 10_000, "close_timeout_ms");
  const heartbeatInterval = parseBoundedInteger(
    value.heartbeat_interval_ms,
    transportDefaults.heartbeat_interval_ms,
    50,
    120_000,
    "heartbeat_interval_ms"
  );
  const heartbeatTimeout = parseBoundedInteger(
    value.heartbeat_timeout_ms,
    transportDefaults.heartbeat_timeout_ms,
    50,
    30_000,
    "heartbeat_timeout_ms"
  );
  const maxFrameBytes = parseBoundedInteger(value.max_frame_bytes, transportDefaults.max_frame_bytes, 1_024, 8_388_608, "max_frame_bytes");
  const maxBufferedBytes = parseBoundedInteger(
    value.max_buffered_bytes,
    transportDefaults.max_buffered_bytes,
    maxFrameBytes,
    16_777_216,
    "max_buffered_bytes"
  );
  return {
    socket_path: socketPath,
    handshake_timeout_ms: handshakeTimeout,
    close_timeout_ms: closeTimeout,
    heartbeat_interval_ms: heartbeatInterval,
    heartbeat_timeout_ms: heartbeatTimeout,
    max_frame_bytes: maxFrameBytes,
    max_buffered_bytes: maxBufferedBytes
  };
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseBoundedInteger(candidate: unknown, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw invalidTransportConfig(`${label} must be a safe integer between ${min} and ${max}`);
  }
  return candidate;
}

function invalidTransportConfig(detail: string): HostDeckCodexAdapterError {
  return transportError("invalid_transport_config", `Invalid Codex Unix transport configuration: ${detail}.`, "not_sent", true);
}

function transportError(
  code: HostDeckCodexAdapterError["code"],
  message: string,
  outcome: HostDeckCodexAdapterError["outcome"],
  retrySafe: boolean
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, { outcome, retry_safe: retrySafe });
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function websocketCloseReason(value: string): string {
  const characters = [...boundedProtocolText(value)];
  while (Buffer.byteLength(characters.join(""), "utf8") > 100) characters.pop();
  return characters.join("");
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), milliseconds);
    timeout.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}
