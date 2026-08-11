import { Buffer } from "node:buffer";
import {
  defaultResourceBudget,
  resourceBudgetDefinitionByKey
} from "@hostdeck/contracts";
import { HostDeckCodexAdapterError } from "./errors.js";
import type {
  CodexTextTransport,
  CodexTransportEvent,
  CodexTransportListener,
  CodexTransportState,
  UnsubscribeCodexTransport
} from "./transport.js";

export interface CodexRotatingTransportAcquireInput {
  readonly previous_generation: number;
  readonly signal: AbortSignal;
}

export interface CodexRotatingTransportProvider {
  readonly acquire: (
    input: CodexRotatingTransportAcquireInput
  ) => Promise<CodexTextTransport>;
}

export interface CodexRotatingTextTransportOptions {
  readonly provider: CodexRotatingTransportProvider;
  readonly max_frame_bytes?: number;
}

interface ParsedOptions {
  readonly provider: CodexRotatingTransportProvider;
  readonly maxFrameBytes: number;
}

interface InnerLease {
  readonly id: number;
  readonly transport: CodexTextTransport;
  innerGeneration: number | null;
  publicGeneration: number | null;
  contractFailure: HostDeckCodexAdapterError | null;
  unsubscribe: UnsubscribeCodexTransport | null;
}

const optionKeys = Object.freeze(["max_frame_bytes", "provider"] as const);
const providerKeys = Object.freeze(["acquire"] as const);
const maximumCloseReasonLength = 1_024;

export function createCodexRotatingTextTransport(
  options: CodexRotatingTextTransportOptions
): CodexTextTransport {
  return new DefaultCodexRotatingTextTransport(parseOptions(options));
}

class DefaultCodexRotatingTextTransport implements CodexTextTransport {
  private readonly listeners = new Set<CodexTransportListener>();
  private currentState: CodexTransportState = "idle";
  private currentGeneration = 0;
  private nextLeaseId = 1;
  private operationEpoch = 0;
  private inner: InnerLease | null = null;
  private activeAbort: AbortController | null = null;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private terminalFailure: HostDeckCodexAdapterError | null = null;

  constructor(private readonly options: ParsedOptions) {}

  get state(): CodexTransportState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get max_frame_bytes(): number {
    return this.options.maxFrameBytes;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      return Promise.reject(invalidConfiguration());
    }
    if (
      this.currentState === "connecting" ||
      this.currentState === "open" ||
      this.currentState === "closing" ||
      this.connectPromise !== null ||
      this.closePromise !== null
    ) {
      return Promise.reject(
        transportFailure(
          "transport_connect_failed",
          "Codex rotating transport is already active.",
          true
        )
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(abortedFailure());
    }
    if (this.terminalFailure !== null) {
      return Promise.reject(this.terminalFailure);
    }

    let operation: Promise<void>;
    operation = this.connectInternal(signal).finally(() => {
      if (this.connectPromise === operation) this.connectPromise = null;
    });
    this.connectPromise = operation;
    return operation;
  }

  async sendText(text: string): Promise<void> {
    const lease = this.inner;
    if (
      this.currentState !== "open" ||
      lease === null ||
      lease.publicGeneration !== this.currentGeneration ||
      lease.innerGeneration !== lease.transport.generation ||
      lease.transport.state !== "open"
    ) {
      throw transportFailure(
        "transport_not_open",
        "Codex rotating transport is not open.",
        true
      );
    }
    let operation: unknown;
    try {
      operation = lease.transport.sendText(text);
    } catch (cause) {
      throw sanitizeTransportFailure(cause, "send");
    }
    if (!isPromiseLike(operation)) throw invalidInnerContract();
    try {
      await operation;
    } catch (cause) {
      throw sanitizeTransportFailure(cause, "send");
    }
  }

  close(reason: string): Promise<void> {
    if (
      typeof reason !== "string" ||
      reason.length > maximumCloseReasonLength ||
      containsControl(reason)
    ) {
      return Promise.reject(invalidConfiguration());
    }
    if (this.closePromise !== null) return this.closePromise;

    let operation: Promise<void>;
    operation = this.closeInternal(reason).finally(() => {
      if (this.closePromise === operation) this.closePromise = null;
    });
    this.closePromise = operation;
    return operation;
  }

  terminate(error: HostDeckCodexAdapterError): void {
    if (!(error instanceof HostDeckCodexAdapterError)) {
      throw new TypeError("Codex rotating transport termination error is invalid.");
    }
    const lease = this.inner;
    if (lease === null) {
      this.currentState = "closed";
      this.emit({ type: "error", generation: this.currentGeneration, error });
      return;
    }
    try {
      lease.transport.terminate(error);
    } catch {
      this.releaseLease(lease);
      this.currentState = "closed";
      this.emit({
        type: "error",
        generation: this.currentGeneration,
        error: transportFailure(
          "transport_closed",
          "Codex rotating transport termination failed.",
          false
        )
      });
    }
  }

  subscribe(listener: CodexTransportListener): UnsubscribeCodexTransport {
    if (typeof listener !== "function") {
      throw new TypeError("Codex rotating transport listener is invalid.");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async connectInternal(signal: AbortSignal | undefined): Promise<void> {
    this.releaseClosedInner();
    this.currentState = "connecting";
    const epoch = this.operationEpoch + 1;
    this.operationEpoch = epoch;
    const abort = new AbortController();
    this.activeAbort = abort;
    const activeSignal =
      signal === undefined
        ? abort.signal
        : AbortSignal.any([signal, abort.signal]);
    let lease: InnerLease | null = null;

    try {
      let acquisition: unknown;
      try {
        acquisition = Reflect.apply(this.options.provider.acquire, this.options.provider, [
          Object.freeze({
            previous_generation: this.currentGeneration,
            signal: activeSignal
          })
        ]);
      } catch (cause) {
        throw sanitizeProviderFailure(cause, activeSignal);
      }
      if (!isPromiseLike(acquisition)) throw invalidInnerContract();

      let candidate: unknown;
      try {
        candidate = await settleAcquisition(
          acquisition,
          activeSignal,
          this.options.maxFrameBytes
        );
      } catch (cause) {
        throw sanitizeProviderFailure(cause, activeSignal);
      }
      const transport = parseInnerTransport(candidate, this.options.maxFrameBytes);
      if (
        activeSignal.aborted ||
        this.operationEpoch !== epoch ||
        this.currentState !== "connecting"
      ) {
        await closeUnadmittedTransport(transport);
        throw abortedFailure();
      }

      lease = {
        id: this.nextLeaseId,
        transport,
        innerGeneration: null,
        publicGeneration: null,
        contractFailure: null,
        unsubscribe: null
      };
      this.nextLeaseId = incrementSafeInteger(this.nextLeaseId);
      lease.unsubscribe = parseUnsubscribe(
        transport.subscribe((event) => this.receiveInnerEvent(lease as InnerLease, event))
      );
      this.inner = lease;

      let connection: unknown;
      try {
        connection = transport.connect(activeSignal);
      } catch (cause) {
        throw sanitizeTransportFailure(cause, "connect");
      }
      if (!isPromiseLike(connection)) throw invalidInnerContract();
      try {
        await connection;
      } catch (cause) {
        throw sanitizeTransportFailure(cause, "connect");
      }

      if (lease.contractFailure !== null) throw lease.contractFailure;
      if (
        activeSignal.aborted ||
        this.operationEpoch !== epoch ||
        this.inner !== lease
      ) {
        throw abortedFailure();
      }
      if (
        lease.publicGeneration !== this.currentGeneration ||
        lease.innerGeneration !== transport.generation ||
        transport.state !== "open" ||
        (this.currentState as CodexTransportState) !== "open"
      ) {
        throw invalidInnerContract();
      }
    } catch (cause) {
      if (lease !== null) await this.closeFailedLease(lease);
      if ((this.currentState as CodexTransportState) !== "closing") {
        this.currentState = "closed";
      }
      if (activeSignal.aborted) throw abortedFailure();
      if (cause instanceof HostDeckCodexAdapterError) throw cause;
      throw invalidInnerContract();
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private async closeInternal(reason: string): Promise<void> {
    this.currentState = "closing";
    this.operationEpoch = incrementSafeInteger(this.operationEpoch);
    this.activeAbort?.abort(abortedFailure());
    const pendingConnect = this.connectPromise;
    if (pendingConnect !== null) await pendingConnect.catch(() => undefined);

    const lease = this.inner;
    if (lease !== null) {
      let close: unknown;
      try {
        close = lease.transport.close(reason);
      } catch (cause) {
        this.releaseLease(lease);
        this.currentState = "closed";
        throw sanitizeTransportFailure(cause, "close");
      }
      if (!isPromiseLike(close)) {
        this.releaseLease(lease);
        this.currentState = "closed";
        throw invalidInnerContract();
      }
      try {
        await close;
      } catch (cause) {
        this.releaseLease(lease);
        this.currentState = "closed";
        throw sanitizeTransportFailure(cause, "close");
      }
      this.releaseLease(lease);
    }
    this.currentState = "closed";
  }

  private receiveInnerEvent(lease: InnerLease, candidate: CodexTransportEvent): void {
    if (this.inner !== lease) return;
    let event: CodexTransportEvent;
    try {
      event = parseInnerEvent(candidate, this.options.maxFrameBytes);
    } catch {
      this.failLeaseContract(lease);
      return;
    }
    if (event.type === "open") {
      if (
        this.currentState !== "connecting" ||
        lease.innerGeneration !== null ||
        event.generation !== lease.transport.generation ||
        event.generation < 1 ||
        this.currentGeneration >= Number.MAX_SAFE_INTEGER
      ) {
        lease.contractFailure = invalidInnerContract();
        return;
      }
      this.currentGeneration += 1;
      lease.innerGeneration = event.generation;
      lease.publicGeneration = this.currentGeneration;
      this.currentState = "open";
      this.emit({ type: "open", generation: this.currentGeneration });
      return;
    }

    if (
      lease.innerGeneration === null ||
      lease.publicGeneration === null ||
      event.generation !== lease.innerGeneration
    ) {
      return;
    }
    const generation = lease.publicGeneration;
    if (event.type === "message") {
      if (this.currentState === "open") {
        this.emit({ type: "message", generation, text: event.text });
      }
      return;
    }
    if (event.type === "error") {
      this.emit({
        type: "error",
        generation,
        error: sanitizeTransportFailure(event.error, "event")
      });
      return;
    }

    this.releaseLease(lease);
    this.currentState = "closed";
    this.emit({
      type: "close",
      generation,
      code: event.code,
      reason: "Codex inner transport closed.",
      clean: event.clean
    });
  }

  private emit(event: CodexTransportEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        const lease = this.inner;
        if (lease !== null) {
          this.terminalFailure ??= invalidInnerContract();
          this.releaseLease(lease);
          this.currentState = "closed";
          try {
            lease.transport.terminate(
              transportFailure(
                "transport_closed",
                "Codex rotating transport listener failed.",
                false
              )
            );
          } catch {
            // The stable transport is already detached and closed.
          }
        }
        return;
      }
    }
  }

  private failLeaseContract(lease: InnerLease): void {
    if (this.inner !== lease) return;
    const failure = invalidInnerContract();
    this.terminalFailure ??= failure;
    const generation = lease.publicGeneration;
    this.releaseLease(lease);
    this.currentState = "closed";
    try {
      lease.transport.terminate(failure);
    } catch {
      // The invalid inner contract is already detached and terminal.
    }
    if (generation !== null) {
      this.emit({ type: "error", generation, error: failure });
      this.emit({
        type: "close",
        generation,
        code: 1006,
        reason: "Codex inner transport contract failed.",
        clean: false
      });
    }
  }

  private async closeFailedLease(lease: InnerLease): Promise<void> {
    if (this.inner !== lease) return;
    try {
      const close = lease.transport.close(
        "HostDeck rejected an unadmitted Codex transport generation."
      );
      if (isPromiseLike(close)) await close.catch(() => undefined);
    } catch {
      // The primary connect failure remains authoritative.
    }
    this.releaseLease(lease);
  }

  private releaseClosedInner(): void {
    const lease = this.inner;
    if (lease === null) return;
    if (lease.transport.state !== "closed") throw invalidInnerContract();
    this.releaseLease(lease);
  }

  private releaseLease(lease: InnerLease): void {
    if (this.inner === lease) this.inner = null;
    const unsubscribe = lease.unsubscribe;
    lease.unsubscribe = null;
    if (unsubscribe !== null) {
      try {
        unsubscribe();
      } catch {
        // Detachment is idempotent; stale events still fail the lease identity check.
      }
    }
  }
}

function parseOptions(candidate: unknown): ParsedOptions {
  const values = exactData(candidate, optionKeys, ["provider"]);
  const providerValues = exactData(values.provider, providerKeys, providerKeys);
  if (typeof providerValues.acquire !== "function") throw invalidConfiguration();
  const maxFrameBytes =
    values.max_frame_bytes === undefined
      ? defaultResourceBudget.protocol_max_frame_bytes
      : values.max_frame_bytes;
  const bounds = resourceBudgetDefinitionByKey.protocol_max_frame_bytes;
  if (
    typeof maxFrameBytes !== "number" ||
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < bounds.minimum ||
    maxFrameBytes > bounds.maximum
  ) {
    throw invalidConfiguration();
  }
  return Object.freeze({
    provider: Object.freeze({
      acquire: providerValues.acquire as CodexRotatingTransportProvider["acquire"]
    }),
    maxFrameBytes
  });
}

function parseInnerTransport(
  candidate: unknown,
  expectedMaxFrameBytes: number
): CodexTextTransport {
  try {
    if (candidate === null || typeof candidate !== "object") throw new TypeError();
    const transport = candidate as CodexTextTransport;
    if (
      typeof transport.connect !== "function" ||
      typeof transport.sendText !== "function" ||
      typeof transport.close !== "function" ||
      typeof transport.terminate !== "function" ||
      typeof transport.subscribe !== "function" ||
      (transport.state !== "idle" && transport.state !== "closed") ||
      !Number.isSafeInteger(transport.generation) ||
      transport.generation < 0 ||
      transport.max_frame_bytes !== expectedMaxFrameBytes
    ) {
      throw new TypeError();
    }
    return transport;
  } catch {
    throw invalidInnerContract();
  }
}

function parseUnsubscribe(candidate: unknown): UnsubscribeCodexTransport {
  if (typeof candidate !== "function") throw invalidInnerContract();
  return candidate as UnsubscribeCodexTransport;
}

async function closeUnadmittedTransport(transport: CodexTextTransport): Promise<void> {
  try {
    const close = transport.close(
      "HostDeck abandoned an expired Codex transport acquisition."
    );
    if (isPromiseLike(close)) await close.catch(() => undefined);
  } catch {
    // Expired acquisition cleanup cannot replace the authoritative abort.
  }
}

function settleAcquisition(
  acquisition: Promise<unknown>,
  signal: AbortSignal,
  expectedMaxFrameBytes: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortedFailure());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void Promise.resolve(acquisition).then(
      (candidate) => {
        if (settled) {
          try {
            const transport = parseInnerTransport(
              candidate,
              expectedMaxFrameBytes
            );
            void closeUnadmittedTransport(transport);
          } catch {
            // A malformed late result has no authority to retain.
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(candidate);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      }
    );
  });
}

function sanitizeProviderFailure(
  cause: unknown,
  signal: AbortSignal
): HostDeckCodexAdapterError {
  if (signal.aborted) return abortedFailure();
  if (cause instanceof HostDeckCodexAdapterError) {
    return sanitizeTransportFailure(cause, "provider");
  }
  return invalidInnerContract();
}

function sanitizeTransportFailure(
  cause: unknown,
  stage: "close" | "connect" | "event" | "provider" | "send"
): HostDeckCodexAdapterError {
  if (!(cause instanceof HostDeckCodexAdapterError)) {
    return stage === "provider" ? invalidInnerContract() : transportFailure(
      stage === "send" ? "transport_send_failed" : "transport_connect_failed",
      `Codex rotating transport ${stage} failed.`,
      stage !== "close"
    );
  }
  const messages: Readonly<Record<HostDeckCodexAdapterError["code"], string>> = {
    broker_closed: "Codex rotating transport broker is closed.",
    broker_overloaded: "Codex rotating transport broker is overloaded.",
    handshake_failed: "Codex rotating transport handshake failed.",
    invalid_protocol_message: "Codex rotating transport received an invalid protocol message.",
    invalid_transport_config: "Codex rotating transport configuration is invalid.",
    protocol_violation: "Codex rotating transport protocol contract failed.",
    remote_error: "Codex rotating transport remote request failed.",
    request_aborted: "Codex rotating transport request was aborted.",
    request_timeout: "Codex rotating transport request timed out.",
    transport_aborted: "Codex rotating transport operation was aborted.",
    transport_closed: "Codex rotating transport closed unexpectedly.",
    transport_connect_failed: "Codex rotating transport could not connect.",
    transport_not_open: "Codex rotating transport is not open.",
    transport_overloaded: "Codex rotating transport is overloaded.",
    transport_send_failed: "Codex rotating transport could not send the frame.",
    unknown_outcome: "Codex rotating transport operation outcome is unknown.",
    unsupported_method: "Codex rotating transport method is unsupported."
  };
  return new HostDeckCodexAdapterError(cause.code, messages[cause.code], {
    outcome: cause.outcome,
    retry_safe: cause.retry_safe,
    rpc_code: cause.rpc_code
  });
}

function parseInnerEvent(
  candidate: unknown,
  maxFrameBytes: number
): CodexTransportEvent {
  const base = exactData(
    candidate,
    ["clean", "code", "error", "generation", "reason", "text", "type"],
    ["generation", "type"]
  );
  if (
    typeof base.generation !== "number" ||
    !Number.isSafeInteger(base.generation) ||
    base.generation < 0
  ) {
    throw invalidInnerContract();
  }
  const generation = base.generation;
  if (base.type === "open") {
    requireExactEventKeys(base, ["generation", "type"]);
    return Object.freeze({ type: "open", generation });
  }
  if (base.type === "message") {
    requireExactEventKeys(base, ["generation", "text", "type"]);
    if (
      typeof base.text !== "string" ||
      Buffer.byteLength(base.text, "utf8") > maxFrameBytes
    ) {
      throw invalidInnerContract();
    }
    return Object.freeze({ type: "message", generation, text: base.text });
  }
  if (base.type === "error") {
    requireExactEventKeys(base, ["error", "generation", "type"]);
    if (!(base.error instanceof HostDeckCodexAdapterError)) {
      throw invalidInnerContract();
    }
    return Object.freeze({
      type: "error",
      generation,
      error: sanitizeTransportFailure(base.error, "event")
    });
  }
  if (base.type === "close") {
    requireExactEventKeys(base, ["clean", "code", "generation", "reason", "type"]);
    if (
      typeof base.code !== "number" ||
      !Number.isSafeInteger(base.code) ||
      base.code < 0 ||
      base.code > 65_535 ||
      typeof base.reason !== "string" ||
      base.reason.length > maximumCloseReasonLength ||
      typeof base.clean !== "boolean"
    ) {
      throw invalidInnerContract();
    }
    return Object.freeze({
      type: "close",
      generation,
      code: base.code,
      reason: "Codex inner transport closed.",
      clean: base.clean
    });
  }
  throw invalidInnerContract();
}

function requireExactEventKeys(
  event: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): void {
  const keys = Object.keys(event).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw invalidInnerContract();
  }
}

function exactData<const Key extends string>(
  candidate: unknown,
  allowed: readonly Key[],
  required: readonly Key[]
): Readonly<Record<Key, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) => typeof key !== "string" || !allowed.includes(key as Key)
      ) ||
      required.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError();
    }
    const output = Object.create(null) as Record<Key, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      output[key as Key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch {
    throw invalidConfiguration();
  }
}

function incrementSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw invalidInnerContract();
  }
  return value + 1;
}

function isPromiseLike(candidate: unknown): candidate is Promise<unknown> {
  return (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "function") &&
    typeof (candidate as { readonly then?: unknown }).then === "function"
  );
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });
}

function invalidConfiguration(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "invalid_transport_config",
    "Codex rotating transport configuration is invalid.",
    { outcome: "not_sent", retry_safe: false }
  );
}

function invalidInnerContract(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "invalid_transport_config",
    "Codex rotating transport provider returned an invalid transport contract.",
    { outcome: "not_sent", retry_safe: false }
  );
}

function abortedFailure(): HostDeckCodexAdapterError {
  return transportFailure(
    "transport_aborted",
    "Codex rotating transport operation was aborted.",
    true
  );
}

function transportFailure(
  code: HostDeckCodexAdapterError["code"],
  message: string,
  retrySafe: boolean
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, {
    outcome: "not_sent",
    retry_safe: retrySafe
  });
}
