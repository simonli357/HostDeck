import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import {
  defaultResourceBudget,
  resourceBudgetDefinitionByKey,
  type SupportedHostTarget
} from "@hostdeck/contracts";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { boundedProtocolText, HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexAuthenticatedLoopbackWebSocketEndpoint,
  type CodexProtectedEnvironmentCredentialSource,
  type CodexUnixSocketEndpoint,
  createCodexUnixSocketEndpoint,
  formatCodexUnixRemoteAddress,
  parseCodexUnixSocketPath,
  type ResolvedCodexEndpointConnection,
  resolveCodexEndpointConnection
} from "./transport-endpoint.js";

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

interface CodexTransportResourceOptions {
  readonly handshake_timeout_ms?: number;
  readonly close_timeout_ms?: number;
  readonly heartbeat_interval_ms?: number;
  readonly heartbeat_timeout_ms?: number;
  readonly max_frame_bytes?: number;
  readonly max_buffered_bytes?: number;
}

export type CodexLocalWebSocketTransportOptions = Readonly<
  CodexTransportResourceOptions &
    (
      | {
          readonly host_target: "linux-x64";
          readonly endpoint: CodexUnixSocketEndpoint;
          readonly credential?: never;
        }
      | {
          readonly host_target: "windows-x64";
          readonly endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint;
          readonly credential: CodexProtectedEnvironmentCredentialSource;
        }
    )
>;

export interface CodexUnixWebSocketTransportOptions extends CodexTransportResourceOptions {
  readonly socket_path: string;
}

interface ParsedTransportOptions {
  readonly connection: ResolvedCodexEndpointConnection;
  readonly handshake_timeout_ms: number;
  readonly close_timeout_ms: number;
  readonly heartbeat_interval_ms: number;
  readonly heartbeat_timeout_ms: number;
  readonly max_frame_bytes: number;
  readonly max_buffered_bytes: number;
}

const transportDefaults = {
  handshake_timeout_ms: defaultResourceBudget.protocol_connect_timeout_ms,
  close_timeout_ms: defaultResourceBudget.protocol_close_timeout_ms,
  heartbeat_interval_ms: defaultResourceBudget.protocol_heartbeat_interval_ms,
  heartbeat_timeout_ms: defaultResourceBudget.protocol_heartbeat_timeout_ms,
  max_frame_bytes: defaultResourceBudget.protocol_max_frame_bytes,
  max_buffered_bytes: defaultResourceBudget.protocol_max_buffered_bytes
} as const;

export function createCodexUnixWebSocketTransport(options: unknown): CodexTextTransport {
  return new CodexLocalWebSocketTransport(parseUnixTransportOptions(options));
}

export function createCodexLocalWebSocketTransport(
  options: CodexLocalWebSocketTransportOptions
): CodexTextTransport {
  return new CodexLocalWebSocketTransport(parseLocalTransportOptions(options));
}

export { formatCodexUnixRemoteAddress };

class CodexLocalWebSocketTransport implements CodexTextTransport {
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
    const clientOptions: ClientOptions = {
      followRedirects: false,
      handshakeTimeout: this.options.handshake_timeout_ms,
      maxPayload: this.options.max_frame_bytes,
      perMessageDeflate: false,
      ...(this.options.connection.authorization_header === null
        ? {}
        : {
            headers: {
              Authorization: this.options.connection.authorization_header
            }
          })
    };
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        this.options.connection.web_socket_address,
        clientOptions
      );
    } catch {
      this.currentState = "closed";
      throw transportError(
        "transport_connect_failed",
        "Unable to create the private Codex local transport.",
        "not_sent",
        true
      );
    }
    this.socket = socket;
    this.attachSocket(socket);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onCloseBeforeOpen);
        socket.off("unexpected-response", onUnexpectedResponse);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: HostDeckCodexAdapterError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.socket === socket) {
          this.currentState = "closed";
          this.socket = null;
        }
        try {
          socket.terminate();
        } catch {
          // The typed rejection remains authoritative if ws is already torn down.
        }
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
      const onError = () =>
        rejectOnce(
          transportError(
            "transport_connect_failed",
            "Unable to connect to the private Codex local endpoint.",
            "not_sent",
            true
          )
        );
      const onCloseBeforeOpen = () => {
        rejectOnce(
          transportError(
            "transport_connect_failed",
            "Codex local endpoint closed before WebSocket handshake.",
            "not_sent",
            true
          )
        );
      };
      const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
        response.resume();
        rejectOnce(
          transportError(
            "transport_connect_failed",
            "Codex local endpoint rejected the WebSocket handshake.",
            "not_sent",
            true
          )
        );
      };
      const onAbort = () => rejectOnce(transportError("transport_aborted", "Codex transport connection was aborted.", "not_sent", true));

      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onCloseBeforeOpen);
      socket.once("unexpected-response", onUnexpectedResponse);
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
          else
            reject(
              transportError(
                "transport_send_failed",
                "Codex transport could not confirm the outbound frame write.",
                "unknown",
                false
              )
            );
        });
      } catch {
        release();
        reject(
          transportError(
            "transport_send_failed",
            "Codex transport rejected the outbound frame.",
            "not_sent",
            true
          )
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
      socket.close(
        1000,
        websocketCloseReason(
          redactTransportCredential(
            reason,
            this.options.connection.authorization_header
          )
        )
      );
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
    socket.on("error", () => {
      if (this.socket !== socket) return;
      this.emit({
        type: "error",
        generation: this.currentGeneration,
        error: transportError(
          "transport_closed",
          "Codex WebSocket transport reported an error.",
          "not_applicable",
          false
        )
      });
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.clearHeartbeat();
      this.outboundReservations.delete(socket);
      this.socket = null;
      this.currentState = "closed";
      const boundedReason = boundedProtocolText(
        redactTransportCredential(
          reason.toString("utf8"),
          this.options.connection.authorization_header
        ),
        "Codex transport closed without a reason."
      );
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
      } catch {
        this.terminate(
          transportError(
            "transport_closed",
            "Codex heartbeat ping failed.",
            "not_applicable",
            false
          )
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

const resourceOptionKeys = Object.freeze([
  "close_timeout_ms",
  "handshake_timeout_ms",
  "heartbeat_interval_ms",
  "heartbeat_timeout_ms",
  "max_buffered_bytes",
  "max_frame_bytes"
] as const);
const localTransportOptionKeys = Object.freeze([
  ...resourceOptionKeys,
  "credential",
  "endpoint",
  "host_target"
].sort());
const unixTransportOptionKeys = Object.freeze([
  ...resourceOptionKeys,
  "socket_path"
].sort());

function parseLocalTransportOptions(candidate: unknown): ParsedTransportOptions {
  const value = parseTransportOptionsRecord(candidate);
  requireAllowedTransportKeys(value, localTransportOptionKeys);
  const resources = parseTransportResources(value);
  const hostTarget = parseNativeHostTarget(value.host_target);
  if (hostTarget === "linux-x64" && Object.hasOwn(value, "credential")) {
    throw invalidTransportConfig(
      "Unix endpoints cannot declare a credential source"
    );
  }
  return Object.freeze({
    connection: resolveCodexEndpointConnection(
      value.endpoint,
      hostTarget,
      value.credential
    ),
    ...resources
  });
}

function parseUnixTransportOptions(candidate: unknown): ParsedTransportOptions {
  const value = parseTransportOptionsRecord(candidate);
  requireAllowedTransportKeys(value, unixTransportOptionKeys);
  const resources = parseTransportResources(value);
  const hostTarget = parseNativeHostTarget("linux-x64");
  return Object.freeze({
    connection: resolveCodexEndpointConnection(
      createCodexUnixSocketEndpoint(
        parseCodexUnixSocketPath(value.socket_path)
      ),
      hostTarget,
      undefined
    ),
    ...resources
  });
}

function parseTransportResources(
  value: Readonly<Record<string, unknown>>
): Omit<ParsedTransportOptions, "connection"> {
  const handshakeTimeout = parseBoundedInteger(
    value.handshake_timeout_ms,
    transportDefaults.handshake_timeout_ms,
    50,
    resourceBudgetDefinitionByKey.protocol_connect_timeout_ms.maximum,
    "handshake_timeout_ms"
  );
  const closeTimeout = parseBoundedInteger(
    value.close_timeout_ms,
    transportDefaults.close_timeout_ms,
    50,
    resourceBudgetDefinitionByKey.protocol_close_timeout_ms.maximum,
    "close_timeout_ms"
  );
  const heartbeatInterval = parseBoundedInteger(
    value.heartbeat_interval_ms,
    transportDefaults.heartbeat_interval_ms,
    50,
    resourceBudgetDefinitionByKey.protocol_heartbeat_interval_ms.maximum,
    "heartbeat_interval_ms"
  );
  const heartbeatTimeout = parseBoundedInteger(
    value.heartbeat_timeout_ms,
    transportDefaults.heartbeat_timeout_ms,
    50,
    resourceBudgetDefinitionByKey.protocol_heartbeat_timeout_ms.maximum,
    "heartbeat_timeout_ms"
  );
  const maxFrameBytes = parseBoundedInteger(
    value.max_frame_bytes,
    transportDefaults.max_frame_bytes,
    resourceBudgetDefinitionByKey.protocol_max_frame_bytes.minimum,
    resourceBudgetDefinitionByKey.protocol_max_frame_bytes.maximum,
    "max_frame_bytes"
  );
  const maxBufferedBytes = parseBoundedInteger(
    value.max_buffered_bytes,
    transportDefaults.max_buffered_bytes,
    Math.max(maxFrameBytes, resourceBudgetDefinitionByKey.protocol_max_buffered_bytes.minimum),
    resourceBudgetDefinitionByKey.protocol_max_buffered_bytes.maximum,
    "max_buffered_bytes"
  );
  return Object.freeze({
    handshake_timeout_ms: handshakeTimeout,
    close_timeout_ms: closeTimeout,
    heartbeat_interval_ms: heartbeatInterval,
    heartbeat_timeout_ms: heartbeatTimeout,
    max_frame_bytes: maxFrameBytes,
    max_buffered_bytes: maxBufferedBytes
  });
}

function parseTransportOptionsRecord(candidate: unknown): Record<string, unknown> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw invalidTransportConfig("options must be a plain object");
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidTransportConfig("options must be a plain object");
    }
    const value: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== "string") {
        throw invalidTransportConfig("options contain an unknown field");
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw invalidTransportConfig("options must use readable data fields");
      }
      value[key] = descriptor.value;
    }
    return value;
  } catch {
    throw invalidTransportConfig("options are invalid");
  }
}

function requireAllowedTransportKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): void {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw invalidTransportConfig("options contain an unknown field");
  }
}

function parseNativeHostTarget(candidate: unknown): SupportedHostTarget {
  const currentTarget =
    process.arch === "x64" && process.platform === "linux"
      ? "linux-x64"
      : process.arch === "x64" && process.platform === "win32"
        ? "windows-x64"
        : null;
  if (candidate !== currentTarget || currentTarget === null) {
    throw invalidTransportConfig(
      "endpoint target does not match the native host"
    );
  }
  return currentTarget;
}

function parseBoundedInteger(candidate: unknown, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw invalidTransportConfig(`${label} must be a safe integer between ${min} and ${max}`);
  }
  return candidate;
}

function invalidTransportConfig(detail: string): HostDeckCodexAdapterError {
  return transportError(
    "invalid_transport_config",
    `Invalid Codex local transport configuration: ${detail}.`,
    "not_sent",
    true
  );
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

function redactTransportCredential(
  value: string,
  authorizationHeader: string | null
): string {
  if (authorizationHeader === null) return value;
  const token = authorizationHeader.slice("Bearer ".length);
  return value
    .split(authorizationHeader)
    .join("[credential redacted]")
    .split(token)
    .join("[credential redacted]");
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
