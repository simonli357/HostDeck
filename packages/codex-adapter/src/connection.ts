import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import {
  defaultResourceBudget,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey,
  runtimeCompatibilitySchema
} from "@hostdeck/contracts";
import { type CodexProtocolIssue, type CodexRequestInput, createCodexRequestBroker } from "./broker.js";
import { assessCodexCompatibility, HostDeckCodexCompatibilityError } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { CodexRequestId, DecodedCodexInboundMessage } from "./protocol.js";
import type { CodexTextTransport, CodexTransportEvent, UnsubscribeCodexTransport } from "./transport.js";

export type CodexConnectionState =
  | "closing"
  | "connecting"
  | "degraded"
  | "disconnected"
  | "handshaking"
  | "idle"
  | "incompatible"
  | "ready";

export type CodexConnectionNotification = Extract<DecodedCodexInboundMessage, { readonly kind: "notification" }>;
export type CodexConnectionServerRequest = Extract<DecodedCodexInboundMessage, { readonly kind: "server_request" }>;

export interface CodexAppServerConnectionOptions {
  readonly transport: CodexTextTransport;
  readonly observed_version: string | null;
  readonly client_version?: string;
  readonly handshake_timeout_ms?: number;
  readonly max_in_flight?: number;
  readonly max_server_requests?: number;
  readonly now?: () => string;
  readonly on_notification?: (message: CodexConnectionNotification) => void;
  readonly on_server_request?: (message: CodexConnectionServerRequest) => void;
  readonly on_protocol_issue?: (issue: CodexProtocolIssue) => void;
}

export interface CodexAppServerConnection {
  readonly state: CodexConnectionState;
  readonly generation: number;
  readonly compatibility: RuntimeCompatibility;
  readonly pending_request_count: number;
  readonly pending_server_request_count: number;
  readonly connect: (signal?: AbortSignal) => Promise<RuntimeCompatibility>;
  readonly reconnect: (signal?: AbortSignal) => Promise<RuntimeCompatibility>;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
  readonly respondToServerRequest: (id: CodexRequestId, result: unknown) => Promise<void>;
  readonly rejectServerRequest: (id: CodexRequestId, code: number, message: string) => Promise<void>;
  readonly close: (reason?: string) => Promise<void>;
}

interface InitializeProbe {
  readonly user_agent: string;
  readonly platform_family: string;
  readonly platform_os: string;
  readonly codex_home: string;
}

const defaults = {
  client_version: "0.0.0",
  handshake_timeout_ms: defaultResourceBudget.protocol_handshake_timeout_ms
} as const;

export function createCodexAppServerConnection(options: CodexAppServerConnectionOptions): CodexAppServerConnection {
  return new DefaultCodexAppServerConnection(parseConnectionOptions(options));
}

class DefaultCodexAppServerConnection implements CodexAppServerConnection {
  private currentState: CodexConnectionState = "idle";
  private currentCompatibility: RuntimeCompatibility;
  private protocolInitialized = false;
  private connectAbort: AbortController | null = null;
  private readonly unsubscribeTransport: UnsubscribeCodexTransport;
  private readonly broker;
  private permanentlyClosed = false;
  private lastTransportClose: { readonly generation: number; readonly reason: string } | null = null;

  constructor(private readonly options: ParsedConnectionOptions) {
    this.currentCompatibility = this.assess({ state: "not_attempted" });
    this.broker = createCodexRequestBroker(options.transport, {
      ...(options.max_in_flight === undefined ? {} : { max_in_flight: options.max_in_flight }),
      request_timeout_ms: options.handshake_timeout_ms,
      ...(options.max_server_requests === undefined ? {} : { max_server_requests: options.max_server_requests }),
      on_notification: (message) => this.receiveNotification(message),
      on_server_request_observed: (message) => this.assertProtocolInitialized(`Codex requested ${message.method}`),
      on_server_request: (message) => this.receiveServerRequest(message),
      on_protocol_issue: (issue) => this.receiveProtocolIssue(issue)
    });
    this.unsubscribeTransport = options.transport.subscribe((event) => this.receiveTransportEvent(event));
  }

  get state(): CodexConnectionState {
    return this.currentState;
  }

  get generation(): number {
    return this.options.transport.generation;
  }

  get compatibility(): RuntimeCompatibility {
    return this.currentCompatibility;
  }

  get pending_request_count(): number {
    return this.broker.pending_request_count;
  }

  get pending_server_request_count(): number {
    return this.broker.pending_server_request_count;
  }

  async connect(signal?: AbortSignal): Promise<RuntimeCompatibility> {
    if (this.permanentlyClosed) throw connectionError("broker_closed", "Codex app-server connection is permanently closed.");
    if (["closing", "connecting", "degraded", "handshaking", "ready"].includes(this.currentState)) {
      throw connectionError("transport_connect_failed", `Cannot connect Codex app-server while connection is ${this.currentState}.`);
    }
    if (signal?.aborted === true) throw connectionError("transport_aborted", "Codex app-server connection was aborted.");

    const checkedAt = this.options.now();
    const preflight = assessSafely(this.options.observed_version, checkedAt, { state: "not_attempted" });
    this.currentCompatibility = preflight;
    if (preflight.state === "incompatible") {
      this.currentState = "incompatible";
      throw handshakeError(preflight.reason ?? "Codex compatibility preflight failed.");
    }

    this.currentState = "connecting";
    this.protocolInitialized = false;
    this.lastTransportClose = null;
    const internalAbort = new AbortController();
    this.connectAbort = internalAbort;
    const connectSignal = signal === undefined ? internalAbort.signal : AbortSignal.any([signal, internalAbort.signal]);

    try {
      await this.options.transport.connect(connectSignal);
      this.currentState = "handshaking";
      const initialized = parseInitializeResponse(
        await this.broker.request({
          method: "initialize",
          params: {
            clientInfo: { name: "hostdeck", title: "HostDeck", version: this.options.client_version },
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              optOutNotificationMethods: []
            }
          },
          kind: "read",
          timeout_ms: this.options.handshake_timeout_ms,
          signal: connectSignal
        })
      );
      throwIfAborted(connectSignal);
      this.protocolInitialized = true;
      try {
        await this.broker.notify("initialized");
      } catch (error) {
        this.protocolInitialized = false;
        throw error;
      }
      throwIfAborted(connectSignal);
      const collaborationModes = parseCollaborationModes(
        await this.broker.request({
          method: "collaborationMode/list",
          params: {},
          kind: "read",
          timeout_ms: this.options.handshake_timeout_ms,
          signal: connectSignal
        })
      );

      const compatibility = assessSafely(this.options.observed_version, checkedAt, {
        state: "initialized",
        user_agent: initialized.user_agent,
        platform_family: initialized.platform_family,
        platform_os: initialized.platform_os,
        collaboration_modes: collaborationModes
      });
      this.currentCompatibility = compatibility;
      if (compatibility.state !== "ready" || compatibility.mutation_policy !== "allowed") {
        this.currentState = "incompatible";
        throw handshakeError(compatibility.reason ?? "Codex app-server compatibility gate did not become ready.");
      }
      this.currentState = "ready";
      return compatibility;
    } catch (error) {
      const initialError = normalizeConnectError(error);
      const incompatible = this.currentCompatibility.state === "incompatible";
      await closeWithoutMasking(this.options.transport, "HostDeck rejected the Codex app-server handshake.");
      const normalized = this.withHandshakeCloseReason(initialError);
      if (!incompatible) {
        this.currentCompatibility = this.assess({ state: "failed", reason: normalized.message });
      }
      this.protocolInitialized = false;
      this.currentState = incompatible ? "incompatible" : "disconnected";
      throw normalized;
    } finally {
      if (this.connectAbort === internalAbort) this.connectAbort = null;
    }
  }

  request(input: CodexRequestInput): Promise<unknown> {
    if (!["degraded", "ready"].includes(this.currentState) || this.currentCompatibility.mutation_policy !== "allowed") {
      return Promise.reject(connectionError("transport_not_open", "Codex application request is blocked until compatibility is ready."));
    }
    return this.broker.request(input);
  }

  async reconnect(signal?: AbortSignal): Promise<RuntimeCompatibility> {
    if (this.permanentlyClosed) throw connectionError("broker_closed", "Codex app-server connection is permanently closed.");
    if (signal?.aborted === true) throw connectionError("transport_aborted", "Codex app-server reconnect was aborted.");
    if (
      ["closing", "connecting", "handshaking"].includes(this.currentState) ||
      ["closing", "connecting"].includes(this.options.transport.state)
    ) {
      throw connectionError("transport_connect_failed", `Cannot reconnect Codex app-server while connection is ${this.currentState}.`);
    }
    if (this.options.transport.state === "open") {
      this.currentState = "closing";
      await this.options.transport.close("HostDeck explicitly recycled the Codex app-server connection.");
    }
    this.protocolInitialized = false;
    this.currentState = "disconnected";
    return this.connect(signal);
  }

  respondToServerRequest(id: CodexRequestId, result: unknown): Promise<void> {
    if (!["degraded", "ready"].includes(this.currentState) || this.currentCompatibility.mutation_policy !== "allowed") {
      return Promise.reject(connectionError("transport_not_open", "Codex server request cannot be resolved before compatibility is ready."));
    }
    return this.broker.respondToServerRequest(id, result);
  }

  rejectServerRequest(id: CodexRequestId, code: number, message: string): Promise<void> {
    if (!["degraded", "ready"].includes(this.currentState) || this.currentCompatibility.mutation_policy !== "allowed") {
      return Promise.reject(connectionError("transport_not_open", "Codex server request cannot be rejected before compatibility is ready."));
    }
    return this.broker.rejectServerRequest(id, code, message);
  }

  async close(reason = "HostDeck closed the Codex app-server connection."): Promise<void> {
    if (this.permanentlyClosed) return;
    this.permanentlyClosed = true;
    this.connectAbort?.abort();
    try {
      if (this.options.transport.state !== "idle" && this.options.transport.state !== "closed") {
        this.currentState = "closing";
        await this.options.transport.close(reason);
      }
    } finally {
      this.broker.close();
      this.unsubscribeTransport();
      this.protocolInitialized = false;
      this.currentCompatibility = this.assess({ state: "failed", reason });
      this.currentState = "disconnected";
    }
  }

  private receiveNotification(message: CodexConnectionNotification): void {
    this.assertProtocolInitialized(`Codex sent ${message.method}`);
    this.options.on_notification?.(message);
  }

  private receiveServerRequest(message: CodexConnectionServerRequest): void {
    this.options.on_server_request?.(message);
  }

  private assertProtocolInitialized(subject: string): void {
    if (!this.protocolInitialized) {
      throw connectionError("protocol_violation", `${subject} before the initialized notification.`);
    }
  }

  private receiveProtocolIssue(issue: CodexProtocolIssue): void {
    if (issue.severity === "degraded" && ["degraded", "ready"].includes(this.currentCompatibility.state)) {
      const mutationAllowed = issue.code === "late_response" && this.currentCompatibility.mutation_policy === "allowed";
      this.currentCompatibility = runtimeCompatibilitySchema.parse({
        ...this.currentCompatibility,
        state: "degraded",
        mutation_policy: mutationAllowed ? "allowed" : "blocked",
        checked_at: this.options.now(),
        reason: issue.message
      });
      this.currentState = "degraded";
    }
    this.options.on_protocol_issue?.(issue);
  }

  private receiveTransportEvent(event: CodexTransportEvent): void {
    if (event.type !== "close") return;
    this.lastTransportClose = { generation: event.generation, reason: event.reason };
    this.protocolInitialized = false;
    if (this.currentState === "incompatible") return;
    this.currentCompatibility = this.assess({ state: "failed", reason: `transport closed: ${event.reason}` });
    if (this.currentState !== "connecting" && this.currentState !== "handshaking") this.currentState = "disconnected";
  }

  private assess(handshake: Parameters<typeof assessCodexCompatibility>[0]["handshake"]): RuntimeCompatibility {
    return assessSafely(this.options.observed_version, this.options.now(), handshake);
  }

  private withHandshakeCloseReason(error: HostDeckCodexAdapterError): HostDeckCodexAdapterError {
    if (
      !["transport_closed", "transport_not_open"].includes(error.code) ||
      this.lastTransportClose?.generation !== this.options.transport.generation
    ) {
      return error;
    }
    return new HostDeckCodexAdapterError(
      "transport_closed",
      `Codex transport closed during handshake: ${this.lastTransportClose.reason}`,
      { cause: error, outcome: "not_sent", retry_safe: true }
    );
  }
}

interface ParsedConnectionOptions extends Omit<CodexAppServerConnectionOptions, "client_version" | "handshake_timeout_ms" | "now"> {
  readonly client_version: string;
  readonly handshake_timeout_ms: number;
  readonly now: () => string;
}

function parseConnectionOptions(options: CodexAppServerConnectionOptions): ParsedConnectionOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw connectionError("handshake_failed", "Codex app-server connection options must be an object.");
  }
  if (options.transport === null || typeof options.transport !== "object") {
    throw connectionError("handshake_failed", "Codex app-server connection requires a transport.");
  }
  if (options.observed_version !== null && typeof options.observed_version !== "string") {
    throw connectionError("handshake_failed", "Codex observed version must be a string or null.");
  }
  return {
    ...options,
    client_version: parsePrintableString(options.client_version ?? defaults.client_version, "HostDeck client version", 64),
    handshake_timeout_ms: parseBoundedInteger(
      options.handshake_timeout_ms,
      defaults.handshake_timeout_ms,
      50,
      resourceBudgetDefinitionByKey.protocol_handshake_timeout_ms.maximum,
      "handshake_timeout_ms"
    ),
    now: options.now ?? (() => new Date().toISOString())
  };
}

function parseInitializeResponse(candidate: unknown): InitializeProbe {
  const value = requireRecord(candidate, "Codex initialize result must be an object.");
  const codexHome = parsePrintableString(value.codexHome, "Codex initialize codexHome", 4_096);
  if (!isAbsolute(codexHome) || Buffer.byteLength(codexHome, "utf8") > 4_096) {
    throw handshakeError("Codex initialize codexHome must be a bounded absolute path.");
  }
  return {
    user_agent: parsePrintableString(value.userAgent, "Codex initialize userAgent", 240),
    platform_family: parsePrintableString(value.platformFamily, "Codex initialize platformFamily", 64),
    platform_os: parsePrintableString(value.platformOs, "Codex initialize platformOs", 64),
    codex_home: codexHome
  };
}

function parseCollaborationModes(candidate: unknown): readonly string[] {
  const value = requireRecord(candidate, "Codex collaboration-mode result must be an object.");
  if (!Array.isArray(value.data) || value.data.length < 1 || value.data.length > 64) {
    throw handshakeError("Codex collaboration-mode catalog must contain 1 to 64 entries.");
  }
  const modes = value.data.map((entry) => {
    const mode = requireRecord(entry, "Codex collaboration-mode entry must be an object.");
    return parsePrintableString(mode.name, "Codex collaboration-mode name", 80);
  });
  if (new Set(modes.map((mode) => mode.toLowerCase())).size !== modes.length) {
    throw handshakeError("Codex collaboration-mode catalog contains duplicate names.");
  }
  return modes;
}

function assessSafely(
  observedVersion: string | null,
  checkedAt: string,
  handshake: Parameters<typeof assessCodexCompatibility>[0]["handshake"]
): RuntimeCompatibility {
  try {
    return assessCodexCompatibility({ observed_version: observedVersion, checked_at: checkedAt, handshake });
  } catch (error) {
    if (error instanceof HostDeckCodexCompatibilityError) {
      throw new HostDeckCodexAdapterError("handshake_failed", error.message, { cause: error, outcome: "not_sent", retry_safe: false });
    }
    throw error;
  }
}

function normalizeConnectError(error: unknown): HostDeckCodexAdapterError {
  if (error instanceof HostDeckCodexAdapterError) return error;
  return new HostDeckCodexAdapterError("handshake_failed", "Codex app-server handshake failed unexpectedly.", {
    cause: error,
    outcome: "not_sent",
    retry_safe: true
  });
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw handshakeError(message);
  return candidate as Record<string, unknown>;
}

function parsePrintableString(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > maxLength) {
    throw handshakeError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw handshakeError(`${label} contains a control character.`);
  }
  return candidate;
}

function parseBoundedInteger(candidate: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw connectionError("handshake_failed", `Codex connection ${label} must be a safe integer between ${min} and ${max}.`);
  }
  return candidate;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw connectionError("transport_aborted", "Codex app-server connection was aborted.");
}

async function closeWithoutMasking(transport: CodexTextTransport, reason: string): Promise<void> {
  try {
    await transport.close(reason);
  } catch {
    // Preserve the handshake failure as the primary error.
  }
}

function handshakeError(message: string): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("handshake_failed", message, { outcome: "not_sent", retry_safe: false });
}

function connectionError(code: HostDeckCodexAdapterError["code"], message: string): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, { outcome: "not_sent", retry_safe: true });
}
