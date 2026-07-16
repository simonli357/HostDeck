import { defaultResourceBudget, resourceBudgetDefinitionByKey } from "@hostdeck/contracts";
import { boundedProtocolText, HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexRequestId,
  type DecodedCodexInboundMessage,
  decodeCodexInboundFrame,
  encodeCodexClientNotification,
  encodeCodexClientRequest,
  encodeCodexServerError
} from "./protocol.js";
import type { CodexTextTransport, CodexTransportEvent, UnsubscribeCodexTransport } from "./transport.js";

export type CodexRequestKind = "mutation" | "read";
export type CodexProtocolIssueSeverity = "degraded" | "fatal";

export interface CodexProtocolIssue {
  readonly severity: CodexProtocolIssueSeverity;
  readonly code: "late_response" | "protocol_violation" | "unknown_notification" | "unsupported_server_request";
  readonly message: string;
  readonly method: string | null;
}

export interface CodexRequestInput {
  readonly method: string;
  readonly params: unknown;
  readonly kind: CodexRequestKind;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
}

export interface CodexRequestBrokerOptions {
  readonly max_in_flight?: number;
  readonly request_timeout_ms?: number;
  readonly max_server_requests?: number;
  readonly on_notification?: (message: Extract<DecodedCodexInboundMessage, { readonly kind: "notification" }>) => void;
  readonly on_response_observed?: (
    method: string,
    message: Extract<DecodedCodexInboundMessage, { readonly kind: "response" }>
  ) => void;
  readonly on_server_request_observed?: (message: Extract<DecodedCodexInboundMessage, { readonly kind: "server_request" }>) => void;
  readonly on_server_request?: (message: Extract<DecodedCodexInboundMessage, { readonly kind: "server_request" }>) => void;
  readonly on_protocol_issue?: (issue: CodexProtocolIssue) => void;
}

export interface CodexRequestBroker {
  readonly pending_request_count: number;
  readonly pending_server_request_count: number;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
  readonly notify: (method: string) => Promise<void>;
  readonly respondToServerRequest: (id: CodexRequestId, result: unknown) => Promise<void>;
  readonly rejectServerRequest: (id: CodexRequestId, code: number, message: string) => Promise<void>;
  readonly close: () => void;
}

interface PendingRequest {
  readonly id: number;
  readonly method: string;
  readonly kind: CodexRequestKind;
  readonly generation: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: HostDeckCodexAdapterError) => void;
  readonly timeout: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
  sent: boolean;
}

interface PendingServerRequest {
  readonly method: string;
  readonly generation: number;
  state: "pending" | "responding";
}

const brokerDefaults = {
  max_in_flight: defaultResourceBudget.protocol_max_in_flight_requests,
  request_timeout_ms: defaultResourceBudget.protocol_mutation_timeout_ms,
  max_server_requests: defaultResourceBudget.protocol_max_pending_server_requests
} as const;

export function createCodexRequestBroker(transport: CodexTextTransport, options: CodexRequestBrokerOptions = {}): CodexRequestBroker {
  const parsed = parseBrokerOptions(options);
  return new DefaultCodexRequestBroker(transport, parsed);
}

class DefaultCodexRequestBroker implements CodexRequestBroker {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingServerRequests = new Map<CodexRequestId, PendingServerRequest>();
  private readonly retired = new Set<number>();
  private readonly completed = new Set<number>();
  private readonly unsubscribe: UnsubscribeCodexTransport;
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly transport: CodexTextTransport,
    private readonly options: Required<Pick<CodexRequestBrokerOptions, "max_in_flight" | "request_timeout_ms" | "max_server_requests">> &
      Omit<CodexRequestBrokerOptions, "max_in_flight" | "request_timeout_ms" | "max_server_requests">
  ) {
    this.unsubscribe = transport.subscribe((event) => this.receiveTransportEvent(event));
  }

  get pending_request_count(): number {
    return this.pending.size;
  }

  get pending_server_request_count(): number {
    return this.pendingServerRequests.size;
  }

  request(input: CodexRequestInput): Promise<unknown> {
    if (input === null || typeof input !== "object" || !["mutation", "read"].includes(input.kind)) {
      return Promise.reject(brokerError("protocol_violation", "Codex request input is invalid.", "not_sent", true));
    }
    if (this.closed) return Promise.reject(brokerError("broker_closed", "Codex request broker is closed.", "not_sent", true));
    if (this.transport.state !== "open") {
      return Promise.reject(brokerError("transport_not_open", "Codex request broker transport is not open.", "not_sent", true));
    }
    if (this.pending.size >= this.options.max_in_flight) {
      return Promise.reject(brokerError("broker_overloaded", "Codex request broker in-flight limit is reached.", "not_sent", true));
    }
    if (input.signal?.aborted === true) {
      return Promise.reject(brokerError("request_aborted", "Codex request was aborted before dispatch.", "not_sent", true));
    }
    let timeoutMs: number;
    let id: number;
    let frame: string;
    try {
      timeoutMs = parseRequestTimeout(input.timeout_ms, this.options.request_timeout_ms);
      id = this.allocateRequestId();
      frame = encodeCodexClientRequest(input.method, id, input.params);
    } catch (error) {
      return Promise.reject(asAdapterError(error, "invalid_protocol_message", "Unable to encode Codex client request."));
    }

    return new Promise((resolve, reject) => {
      const abort = input.signal === undefined ? undefined : () => this.cancelRequest(id, "request_aborted", "Codex request was aborted.");
      const timeout = setTimeout(() => this.cancelRequest(id, "request_timeout", `Codex request ${input.method} timed out.`), timeoutMs);
      timeout.unref();
      const pending: PendingRequest = {
        id,
        method: input.method,
        kind: input.kind,
        generation: this.transport.generation,
        resolve,
        reject,
        timeout,
        signal: input.signal,
        abort,
        sent: false
      };
      this.pending.set(id, pending);
      input.signal?.addEventListener("abort", abort as () => void, { once: true });
      pending.sent = true;

      void this.transport.sendText(frame).then(
        () => undefined,
        (error: unknown) => {
          const current = this.takePending(id);
          if (current === null) return;
          this.remember(this.retired, id);
          current.reject(this.requestFailureFromTransport(current, error));
        }
      );
    });
  }

  async notify(method: string): Promise<void> {
    if (this.closed) throw brokerError("broker_closed", "Codex request broker is closed.", "not_sent", true);
    let frame: string;
    try {
      frame = encodeCodexClientNotification(method);
    } catch (error) {
      throw asAdapterError(error, "invalid_protocol_message", "Unable to encode Codex client notification.");
    }
    await this.transport.sendText(frame);
  }

  async respondToServerRequest(id: CodexRequestId, result: unknown): Promise<void> {
    const frame = serializeEnvelope({ id, result });
    await this.sendServerResponse(id, frame);
  }

  async rejectServerRequest(id: CodexRequestId, code: number, message: string): Promise<void> {
    const frame = encodeCodexServerError(id, code, message);
    await this.sendServerResponse(id, frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.failPendingForDisconnect("Codex request broker closed.");
    this.pendingServerRequests.clear();
  }

  private receiveTransportEvent(event: CodexTransportEvent): void {
    if (this.closed) return;
    if (event.type === "message") {
      if (event.generation !== this.transport.generation) {
        this.fatal(brokerError("protocol_violation", "Codex transport delivered a frame from a stale connection generation."));
        return;
      }
      this.receiveFrame(event.text, event.generation);
      return;
    }
    if (event.type === "close") {
      this.failPendingForDisconnect(`Codex transport closed: ${event.reason}`);
      this.pendingServerRequests.clear();
    }
  }

  private receiveFrame(frame: string, generation: number): void {
    let message: DecodedCodexInboundMessage;
    try {
      message = decodeCodexInboundFrame(frame, this.transport.max_frame_bytes);
    } catch (error) {
      this.fatal(asAdapterError(error, "invalid_protocol_message", "Codex transport delivered a malformed protocol frame."));
      return;
    }
    if (message.kind === "response") this.receiveResponse(message, generation);
    else if (message.kind === "notification") this.receiveNotification(message);
    else this.receiveServerRequest(message, generation);
  }

  private receiveResponse(message: Extract<DecodedCodexInboundMessage, { readonly kind: "response" }>, generation: number): void {
    if (typeof message.id !== "number") {
      this.fatal(brokerError("protocol_violation", "Codex response id does not belong to the numeric HostDeck request namespace."));
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      if (this.retired.delete(message.id)) {
        this.issue({
          severity: "degraded",
          code: "late_response",
          message: `Codex returned a late response for retired request ${message.id}.`,
          method: null
        });
        return;
      }
      const detail = this.completed.has(message.id) ? "duplicate terminal response" : "unknown response id";
      this.fatal(brokerError("protocol_violation", `Codex returned ${detail} ${message.id}.`));
      return;
    }
    if (pending.generation !== generation) {
      this.fatal(brokerError("protocol_violation", `Codex response ${message.id} crossed connection generations.`));
      return;
    }
    try {
      this.options.on_response_observed?.(pending.method, message);
    } catch (error) {
      this.fatal(asAdapterError(error, "protocol_violation", "Codex response observer failed."));
      return;
    }
    const current = this.takePending(message.id);
    if (current === null) return;
    this.remember(this.completed, message.id);
    if (message.error === null) current.resolve(message.result);
    else {
      current.reject(
        new HostDeckCodexAdapterError("remote_error", `Codex ${current.method} rejected: ${message.error.message}`, {
          outcome: "remote_rejected",
          retry_safe: current.kind === "read",
          rpc_code: message.error.code
        })
      );
    }
  }

  private receiveNotification(message: Extract<DecodedCodexInboundMessage, { readonly kind: "notification" }>): void {
    if (message.classification === "unknown") {
      this.issue({
        severity: "degraded",
        code: "unknown_notification",
        message: `Codex emitted unknown notification ${message.method}.`,
        method: message.method
      });
    }
    try {
      this.options.on_notification?.(message);
    } catch (error) {
      this.fatal(asAdapterError(error, "protocol_violation", "Codex notification consumer failed."));
    }
  }

  private receiveServerRequest(
    message: Extract<DecodedCodexInboundMessage, { readonly kind: "server_request" }>,
    generation: number
  ): void {
    try {
      this.options.on_server_request_observed?.(message);
    } catch (error) {
      this.fatal(asAdapterError(error, "protocol_violation", "Codex server-request observer failed."));
      return;
    }
    if (message.classification !== "supported") {
      this.issue({
        severity: "degraded",
        code: "unsupported_server_request",
        message: `Codex requested unsupported server method ${message.method}.`,
        method: message.method
      });
      void this.transport
        .sendText(encodeCodexServerError(message.id, -32601, "HostDeck does not support this app-server request method."))
        .catch((error: unknown) => this.fatal(asAdapterError(error, "transport_send_failed", "Unable to reject unsupported server request.")));
      return;
    }
    if (this.pendingServerRequests.has(message.id)) {
      this.fatal(brokerError("protocol_violation", "Codex repeated an unresolved server request id."));
      return;
    }
    if (this.pendingServerRequests.size >= this.options.max_server_requests) {
      this.issue({
        severity: "degraded",
        code: "unsupported_server_request",
        message: "Codex server-request capacity is exhausted.",
        method: message.method
      });
      void this.transport
        .sendText(encodeCodexServerError(message.id, -32001, "HostDeck server-request capacity is exhausted."))
        .catch((error: unknown) => this.fatal(asAdapterError(error, "transport_send_failed", "Unable to reject excess server request.")));
      return;
    }
    this.pendingServerRequests.set(message.id, { method: message.method, generation, state: "pending" });
    try {
      this.options.on_server_request?.(message);
    } catch (error) {
      this.pendingServerRequests.delete(message.id);
      this.fatal(asAdapterError(error, "protocol_violation", "Codex server-request consumer failed."));
    }
  }

  private cancelRequest(id: number, code: "request_aborted" | "request_timeout", message: string): void {
    const pending = this.takePending(id);
    if (pending === null) return;
    this.remember(this.retired, id);
    const sent = pending.sent;
    pending.reject(
      new HostDeckCodexAdapterError(code, message, {
        outcome: sent ? "unknown" : "not_sent",
        retry_safe: !sent || pending.kind === "read"
      })
    );
  }

  private takePending(id: number): PendingRequest | null {
    const pending = this.pending.get(id);
    if (pending === undefined) return null;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.abort !== undefined) pending.signal?.removeEventListener("abort", pending.abort);
    return pending;
  }

  private claimServerRequest(id: CodexRequestId): PendingServerRequest {
    const pending = this.pendingServerRequests.get(id);
    if (pending === undefined) {
      throw brokerError("protocol_violation", "Codex server request is missing, duplicated, or already resolved.", "not_sent", false);
    }
    if (pending.generation !== this.transport.generation || this.transport.state !== "open") {
      this.pendingServerRequests.delete(id);
      throw brokerError("unknown_outcome", "Codex server request belongs to a closed connection generation.", "unknown", false);
    }
    if (pending.state !== "pending") {
      throw brokerError("protocol_violation", "Codex server request already has a response in flight.", "not_sent", false);
    }
    pending.state = "responding";
    return pending;
  }

  private async sendServerResponse(id: CodexRequestId, frame: string): Promise<void> {
    const pending = this.claimServerRequest(id);
    try {
      await this.transport.sendText(frame);
      if (this.pendingServerRequests.get(id) === pending) this.pendingServerRequests.delete(id);
    } catch (error) {
      if (this.pendingServerRequests.get(id) === pending) {
        if (
          error instanceof HostDeckCodexAdapterError &&
          error.outcome === "not_sent" &&
          pending.generation === this.transport.generation &&
          this.transport.state === "open"
        ) {
          pending.state = "pending";
        } else {
          this.pendingServerRequests.delete(id);
        }
      }
      throw error;
    }
  }

  private requestFailureFromTransport(pending: PendingRequest, error: unknown): HostDeckCodexAdapterError {
    if (error instanceof HostDeckCodexAdapterError) {
      if (error.outcome === "unknown" && pending.kind === "mutation") {
        return new HostDeckCodexAdapterError("unknown_outcome", `Codex ${pending.method} send outcome is unknown.`, {
          cause: error,
          outcome: "unknown",
          retry_safe: false
        });
      }
      return error;
    }
    return new HostDeckCodexAdapterError(pending.kind === "mutation" ? "unknown_outcome" : "transport_send_failed", `Codex ${pending.method} could not be sent.`, {
      cause: error,
      outcome: "unknown",
      retry_safe: pending.kind === "read"
    });
  }

  private failPendingForDisconnect(message: string): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.takePending(id);
      if (pending === null) continue;
      this.remember(this.retired, id);
      const sent = pending.sent;
      pending.reject(
        new HostDeckCodexAdapterError(sent && pending.kind === "mutation" ? "unknown_outcome" : "transport_closed", message, {
          outcome: sent ? "unknown" : "not_sent",
          retry_safe: !sent || pending.kind === "read"
        })
      );
    }
  }

  private fatal(error: HostDeckCodexAdapterError): void {
    this.issue({ severity: "fatal", code: "protocol_violation", message: error.message, method: null });
    this.transport.terminate(error);
  }

  private issue(issue: CodexProtocolIssue): void {
    try {
      this.options.on_protocol_issue?.({ ...issue, message: boundedProtocolText(issue.message) });
    } catch {
      this.transport.terminate(brokerError("protocol_violation", "Codex protocol issue consumer failed."));
    }
  }

  private allocateRequestId(): number {
    if (!Number.isSafeInteger(this.nextRequestId) || this.nextRequestId > Number.MAX_SAFE_INTEGER) {
      throw brokerError("broker_closed", "Codex request id space is exhausted.", "not_sent", false);
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  private remember(set: Set<number>, id: number): void {
    set.add(id);
    const limit = Math.min(1_024, this.options.max_in_flight * 8);
    while (set.size > limit) {
      const oldest = set.values().next().value as number | undefined;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }
}

function parseBrokerOptions(options: CodexRequestBrokerOptions) {
  return {
    ...options,
    max_in_flight: boundedInteger(
      options.max_in_flight,
      brokerDefaults.max_in_flight,
      resourceBudgetDefinitionByKey.protocol_max_in_flight_requests.minimum,
      resourceBudgetDefinitionByKey.protocol_max_in_flight_requests.maximum,
      "max_in_flight"
    ),
    request_timeout_ms: boundedInteger(
      options.request_timeout_ms,
      brokerDefaults.request_timeout_ms,
      50,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.maximum,
      "request_timeout_ms"
    ),
    max_server_requests: boundedInteger(
      options.max_server_requests,
      brokerDefaults.max_server_requests,
      resourceBudgetDefinitionByKey.protocol_max_pending_server_requests.minimum,
      resourceBudgetDefinitionByKey.protocol_max_pending_server_requests.maximum,
      "max_server_requests"
    )
  };
}

function parseRequestTimeout(candidate: number | undefined, fallback: number): number {
  return boundedInteger(
    candidate,
    fallback,
    50,
    resourceBudgetDefinitionByKey.protocol_start_timeout_ms.maximum,
    "timeout_ms"
  );
}

function boundedInteger(candidate: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw brokerError("protocol_violation", `Codex broker ${label} must be a safe integer between ${min} and ${max}.`, "not_sent", true);
  }
  return candidate;
}

function serializeEnvelope(candidate: unknown): string {
  try {
    const serialized = JSON.stringify(candidate);
    if (serialized === undefined) throw new TypeError("JSON serialization returned undefined.");
    return serialized;
  } catch (error) {
    throw new HostDeckCodexAdapterError("invalid_protocol_message", "Codex response payload is not JSON serializable.", {
      cause: error,
      outcome: "not_sent",
      retry_safe: true
    });
  }
}

function asAdapterError(error: unknown, code: HostDeckCodexAdapterError["code"], message: string): HostDeckCodexAdapterError {
  return error instanceof HostDeckCodexAdapterError
    ? error
    : new HostDeckCodexAdapterError(code, message, { cause: error, outcome: "not_applicable", retry_safe: false });
}

function brokerError(
  code: HostDeckCodexAdapterError["code"],
  message: string,
  outcome: HostDeckCodexAdapterError["outcome"] = "not_applicable",
  retrySafe = false
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, { outcome, retry_safe: retrySafe });
}
