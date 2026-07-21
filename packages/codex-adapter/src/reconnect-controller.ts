import {
  assertResolvedResourceBudget,
  type ResourceBudget,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema
} from "@hostdeck/contracts";
import {
  createOperationDeadline,
  type MonotonicDeadlineClock,
  type OperationDeadline,
  OperationDeadlineExceededError
} from "@hostdeck/core";
import type {
  CodexProtocolIssue,
  CodexRequestInput,
  CodexServerResponseOptions
} from "./broker.js";
import {
  type CodexAppServerConnection,
  type CodexConnectionNotification,
  type CodexConnectionServerRequest,
  type CodexConnectionState,
  createCodexAppServerConnection
} from "./connection.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { CodexRequestId } from "./protocol.js";
import type { CodexTextTransport, CodexTransportEvent, UnsubscribeCodexTransport } from "./transport.js";

export const codexReconnectPhases = [
  "idle",
  "connecting",
  "reconciling",
  "resubscribing",
  "ready",
  "disconnected",
  "backing_off",
  "incompatible",
  "failed",
  "closing",
  "closed"
] as const;

export type CodexReconnectPhase = (typeof codexReconnectPhases)[number];

export const codexReconnectStages = [
  "configuration",
  "disconnect",
  "backoff",
  "connect",
  "reconcile",
  "resubscribe",
  "ready",
  "inbound",
  "shutdown"
] as const;

export type CodexReconnectStage = (typeof codexReconnectStages)[number];

export const codexReconnectErrorCodes = [
  "aborted",
  "closed",
  "generation_changed",
  "incompatible",
  "invalid_contract",
  "lifecycle_conflict",
  "lifecycle_failed",
  "operation_timeout",
  "protocol_failed",
  "transport_failed"
] as const;

export type CodexReconnectErrorCode = (typeof codexReconnectErrorCodes)[number];

export type CodexReconnectContinuity = "boundary_required" | "continuous";

export const codexReconnectReadMethods = Object.freeze([
  "model/list",
  "thread/goal/get",
  "thread/items/list",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/turns/list"
] as const);

export type CodexReconnectReadMethod = (typeof codexReconnectReadMethods)[number];

export const codexReconnectResubscribeMethods = Object.freeze(["thread/resume"] as const);

export type CodexReconnectResubscribeMethod = (typeof codexReconnectResubscribeMethods)[number];

export interface CodexReconnectReadRequestInput extends Omit<CodexRequestInput, "kind" | "method"> {
  readonly kind: "read";
  readonly method: CodexReconnectReadMethod;
}

export interface CodexReconnectResubscribeRequestInput extends Omit<CodexRequestInput, "kind" | "method"> {
  readonly kind: "read";
  readonly method: CodexReconnectReadMethod | CodexReconnectResubscribeMethod;
}

export class HostDeckCodexReconnectError extends Error {
  constructor(
    readonly code: CodexReconnectErrorCode,
    readonly stage: CodexReconnectStage,
    message: string
  ) {
    super(message);
    this.name = "HostDeckCodexReconnectError";
  }
}

const ownedReconnectErrors = new WeakSet<HostDeckCodexReconnectError>();

export interface CodexReconnectClock extends MonotonicDeadlineClock {
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface CodexReconnectRuntimeIdentity {
  readonly compatibility: RuntimeCompatibility;
  readonly generation: number;
}

export interface CodexReconnectReadPort extends CodexReconnectRuntimeIdentity {
  readonly request: (input: CodexReconnectReadRequestInput) => Promise<unknown>;
}

export interface CodexReconnectResubscribePort extends CodexReconnectRuntimeIdentity {
  readonly request: (input: CodexReconnectResubscribeRequestInput) => Promise<unknown>;
}

export interface CodexReconnectDisconnectedInput {
  readonly generation: number;
  readonly previous_admitted_generation: number | null;
  readonly deadline: OperationDeadline;
}

export interface CodexReconnectReconcileInput {
  readonly generation: number;
  readonly previous_admitted_generation: number | null;
  readonly compatibility: RuntimeCompatibility;
  readonly deadline: OperationDeadline;
  readonly runtime: CodexReconnectReadPort;
}

export interface CodexReconnectReconciliation {
  readonly continuity: CodexReconnectContinuity;
}

export interface CodexReconnectResubscribeInput {
  readonly generation: number;
  readonly previous_admitted_generation: number | null;
  readonly compatibility: RuntimeCompatibility;
  readonly deadline: OperationDeadline;
  readonly runtime: CodexReconnectResubscribePort;
  readonly reconciliation: CodexReconnectReconciliation;
}

export interface CodexReconnectReadyInput {
  readonly generation: number;
  readonly previous_admitted_generation: number | null;
  readonly compatibility: RuntimeCompatibility;
  readonly deadline: OperationDeadline;
  readonly runtime: CodexReconnectRuntimeIdentity;
  readonly reconciliation: CodexReconnectReconciliation;
}

export interface CodexReconnectLifecyclePort {
  readonly disconnected: (input: CodexReconnectDisconnectedInput) => void | Promise<void>;
  readonly reconcile: (
    input: CodexReconnectReconcileInput
  ) => CodexReconnectReconciliation | Promise<CodexReconnectReconciliation>;
  readonly resubscribe: (input: CodexReconnectResubscribeInput) => void | Promise<void>;
  readonly ready: (input: CodexReconnectReadyInput) => void | Promise<void>;
}

export interface CodexRuntimeReconnectControllerOptions {
  readonly transport: CodexTextTransport;
  readonly observed_version: string | null;
  readonly resource_budget: ResourceBudget;
  readonly lifecycle: CodexReconnectLifecyclePort;
  readonly client_version?: string;
  readonly clock?: CodexReconnectClock;
  readonly random?: () => number;
  readonly on_notification?: (message: CodexConnectionNotification) => void;
  readonly on_server_request?: (message: CodexConnectionServerRequest) => void;
  readonly on_protocol_issue?: (issue: CodexProtocolIssue) => void;
  readonly on_background_error: (error: HostDeckCodexReconnectError) => void;
}

export interface CodexReconnectReady {
  readonly compatibility: RuntimeCompatibility;
  readonly continuity: CodexReconnectContinuity;
  readonly generation: number;
  readonly reconnected: boolean;
}

export interface CodexReconnectFailureSummary {
  readonly code: CodexReconnectErrorCode;
  readonly stage: CodexReconnectStage;
}

export interface CodexReconnectSnapshot {
  readonly phase: CodexReconnectPhase;
  readonly connection_state: CodexConnectionState;
  readonly current_generation: number;
  readonly admitted_generation: number | null;
  readonly connect_attempts: number;
  readonly consecutive_retryable_failures: number;
  readonly completed_reconnects: number;
  readonly disconnect_cleanups: number;
  readonly next_delay_ms: number | null;
  readonly held_notifications: number;
  readonly held_server_requests: number;
  readonly last_failure: CodexReconnectFailureSummary | null;
}

export interface CodexRuntimeReconnectController {
  readonly compatibility: RuntimeCompatibility;
  readonly generation: number;
  readonly start: (signal?: AbortSignal) => Promise<CodexReconnectReady>;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
  readonly respondToServerRequest: (
    id: CodexRequestId,
    result: unknown,
    options?: CodexServerResponseOptions
  ) => Promise<void>;
  readonly rejectServerRequest: (
    id: CodexRequestId,
    code: number,
    message: string,
    options?: CodexServerResponseOptions
  ) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly snapshot: () => CodexReconnectSnapshot;
}

interface ParsedOptions {
  readonly transport: CodexTextTransport;
  readonly observedVersion: string | null;
  readonly resourceBudget: ResourceBudget;
  readonly lifecycle: CodexReconnectLifecyclePort;
  readonly clientVersion: string | undefined;
  readonly clock: CodexReconnectClock;
  readonly random: () => number;
  readonly onNotification: ((message: CodexConnectionNotification) => void) | undefined;
  readonly onServerRequest: ((message: CodexConnectionServerRequest) => void) | undefined;
  readonly onProtocolIssue: ((issue: CodexProtocolIssue) => void) | undefined;
  readonly onBackgroundError: (error: HostDeckCodexReconnectError) => void;
}

type HeldInbound =
  | {
      readonly kind: "notification";
      readonly generation: number;
      readonly message: CodexConnectionNotification;
    }
  | {
      readonly kind: "server_request";
      readonly generation: number;
      readonly message: CodexConnectionServerRequest;
    };

interface MutableCounters {
  connectAttempts: number;
  consecutiveRetryableFailures: number;
  completedReconnects: number;
  disconnectCleanups: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface LifecycleRuntimeLease {
  active: boolean;
  stage: "ready" | "reconcile" | "resubscribe";
}

const optionKeys = [
  "client_version",
  "clock",
  "lifecycle",
  "observed_version",
  "on_background_error",
  "on_notification",
  "on_protocol_issue",
  "on_server_request",
  "random",
  "resource_budget",
  "transport"
] as const;

const lifecycleKeys = ["disconnected", "ready", "reconcile", "resubscribe"] as const;

const defaultClock: CodexReconnectClock = Object.freeze({
  now: () => globalThis.performance.now(),
  setTimeout: (callback: () => void, delayMs: number) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") {
      handle.unref();
    }
    return handle;
  },
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  sleep: (milliseconds: number, signal: AbortSignal) => abortableSleep(milliseconds, signal)
});

export function createCodexRuntimeReconnectController(
  options: CodexRuntimeReconnectControllerOptions
): CodexRuntimeReconnectController {
  const implementation = new DefaultCodexRuntimeReconnectController(parseOptions(options));
  return Object.freeze({
    get compatibility() {
      return implementation.compatibility;
    },
    get generation() {
      return implementation.generation;
    },
    start: (signal?: AbortSignal) => implementation.start(signal),
    request: (input: CodexRequestInput) => implementation.request(input),
    respondToServerRequest: (
      id: CodexRequestId,
      result: unknown,
      responseOptions?: CodexServerResponseOptions
    ) => implementation.respondToServerRequest(id, result, responseOptions),
    rejectServerRequest: (
      id: CodexRequestId,
      code: number,
      message: string,
      responseOptions?: CodexServerResponseOptions
    ) => implementation.rejectServerRequest(id, code, message, responseOptions),
    close: () => implementation.close(),
    snapshot: () => implementation.snapshot()
  });
}

class DefaultCodexRuntimeReconnectController implements CodexRuntimeReconnectController {
  private readonly connection: CodexAppServerConnection;
  private readonly unsubscribeTransport: UnsubscribeCodexTransport;
  private readonly lifecycleAbort = new AbortController();
  private readonly counters: MutableCounters = {
    connectAttempts: 0,
    consecutiveRetryableFailures: 0,
    completedReconnects: 0,
    disconnectCleanups: 0
  };
  private readonly initialReady = deferred<CodexReconnectReady>();
  private readonly heldInbound: HeldInbound[] = [];
  private phase: CodexReconnectPhase = "idle";
  private admittedGeneration: number | null = null;
  private lifecycleInboundGeneration: number | null = null;
  private previousAdmittedGeneration: number | null = null;
  private heldNotificationCount = 0;
  private heldServerRequestCount = 0;
  private inboundCompatibilityGeneration: number | null = null;
  private pendingDisconnectGeneration: number | null = null;
  private lastDisconnectedGeneration = 0;
  private pendingFatal: HostDeckCodexReconnectError | null = null;
  private lastFailure: CodexReconnectFailureSummary | null = null;
  private nextDelayMs: number | null = null;
  private activeCycleAbort: AbortController | null = null;
  private wakeResolve: (() => void) | null = null;
  private runPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private started = false;
  private everReady = false;
  private closing = false;
  private resourcesClosed = false;
  private transportUnsubscribed = false;

  constructor(private readonly options: ParsedOptions) {
    this.connection = createCodexAppServerConnection({
      transport: options.transport,
      observed_version: options.observedVersion,
      ...(options.clientVersion === undefined ? {} : { client_version: options.clientVersion }),
      handshake_timeout_ms: options.resourceBudget.protocol_handshake_timeout_ms,
      max_in_flight: options.resourceBudget.protocol_max_in_flight_requests,
      max_server_requests: options.resourceBudget.protocol_max_pending_server_requests,
      on_notification: (message) => this.receiveInbound({
        kind: "notification",
        generation: this.options.transport.generation,
        message
      }),
      on_server_request: (message) => this.receiveInbound({
        kind: "server_request",
        generation: this.options.transport.generation,
        message
      }),
      on_protocol_issue: (issue) => this.receiveProtocolIssue(issue)
    });
    this.unsubscribeTransport = options.transport.subscribe((event) => this.receiveTransportEvent(event));
  }

  get compatibility(): RuntimeCompatibility {
    return this.publicCompatibility();
  }

  get generation(): number {
    return this.admittedGeneration ?? this.connection.generation;
  }

  start(signal?: AbortSignal): Promise<CodexReconnectReady> {
    if (!isAbortSignalOrUndefined(signal)) {
      return Promise.reject(reconnectError("invalid_contract", "configuration", "Reconnect start signal is invalid."));
    }
    if (this.started || this.closing || this.phase !== "idle") {
      return Promise.reject(reconnectError("lifecycle_conflict", "configuration", "Reconnect controller can start only once."));
    }
    if (signal?.aborted === true) {
      return Promise.reject(reconnectError("aborted", "connect", "Reconnect startup was aborted."));
    }
    this.started = true;
    this.runPromise = this.run(signal).catch((error: unknown) => this.recordTerminal(error));
    return this.initialReady.promise;
  }

  request(input: CodexRequestInput): Promise<unknown> {
    if (!this.isAdmitted()) return Promise.reject(blockedAdapterError());
    return this.connection.request(input);
  }

  respondToServerRequest(
    id: CodexRequestId,
    result: unknown,
    options?: CodexServerResponseOptions
  ): Promise<void> {
    if (!this.isAdmitted()) return Promise.reject(blockedAdapterError());
    return this.connection.respondToServerRequest(id, result, options);
  }

  rejectServerRequest(
    id: CodexRequestId,
    code: number,
    message: string,
    options?: CodexServerResponseOptions
  ): Promise<void> {
    if (!this.isAdmitted()) return Promise.reject(blockedAdapterError());
    return this.connection.rejectServerRequest(id, code, message, options);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.phase = "closing";
    this.admittedGeneration = null;
    this.clearHeldInbound();
    this.lifecycleAbort.abort(reconnectError("closed", "shutdown", "Reconnect controller is closing."));
    this.activeCycleAbort?.abort(reconnectError("closed", "shutdown", "Reconnect controller is closing."));
    this.signalWake();
    if (this.started && !this.everReady) {
      this.initialReady.reject(reconnectError("closed", "shutdown", "Reconnect controller closed before startup."));
    }
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  snapshot(): CodexReconnectSnapshot {
    return deepFreeze({
      phase: this.phase,
      connection_state: this.connection.state,
      current_generation: this.connection.generation,
      admitted_generation: this.admittedGeneration,
      connect_attempts: this.counters.connectAttempts,
      consecutive_retryable_failures: this.counters.consecutiveRetryableFailures,
      completed_reconnects: this.counters.completedReconnects,
      disconnect_cleanups: this.counters.disconnectCleanups,
      next_delay_ms: this.nextDelayMs,
      held_notifications: this.heldNotificationCount,
      held_server_requests: this.heldServerRequestCount,
      last_failure: this.lastFailure === null ? null : Object.freeze({ ...this.lastFailure })
    });
  }

  private async run(initialSignal: AbortSignal | undefined): Promise<void> {
    let delayExponent: number | null = null;
    while (!this.closing) {
      this.throwPendingFatal();
      await this.runPendingDisconnectCleanup(initialSignal);
      this.throwPendingFatal();
      if (delayExponent !== null) await this.sleepBeforeRetry(delayExponent, initialSignal);
      if (this.closing) return;

      try {
        const ready = await this.runConnectionCycle(initialSignal);
        const wasReconnect = this.everReady;
        this.everReady = true;
        this.counters.consecutiveRetryableFailures = 0;
        delayExponent = 0;
        if (!wasReconnect) this.initialReady.resolve(Object.freeze({ ...ready, reconnected: false }));
        await this.waitForWake(this.lifecycleAbort.signal);
      } catch (error) {
        if (this.closing) return;
        this.throwPendingFatal();
        const normalized = normalizeCycleError(error, this.phase, this.connection);
        if (!normalized.retrySafe) throw normalized.error;
        increment(this.counters, "consecutiveRetryableFailures");
        this.lastFailure = Object.freeze({ code: normalized.error.code, stage: normalized.error.stage });
        delayExponent = delayExponent === null ? 0 : saturatingIncrement(delayExponent);
      }
    }
  }

  private async runPendingDisconnectCleanup(initialSignal: AbortSignal | undefined): Promise<void> {
    const generation = this.pendingDisconnectGeneration;
    if (generation === null || generation <= this.lastDisconnectedGeneration) return;
    this.pendingDisconnectGeneration = null;
    const deadline = this.createCycleDeadline(initialSignal);
    try {
      this.phase = "disconnected";
      await settleByDeadline(
        this.options.lifecycle.disconnected({
          generation,
          previous_admitted_generation: this.previousAdmittedGeneration,
          deadline
        }),
        deadline,
        "disconnect"
      );
      deadline.throwIfAborted();
      this.lastDisconnectedGeneration = generation;
      increment(this.counters, "disconnectCleanups");
    } catch (error) {
      throw lifecycleFailure("disconnect", error);
    } finally {
      deadline.dispose();
    }
  }

  private async sleepBeforeRetry(exponent: number, initialSignal: AbortSignal | undefined): Promise<void> {
    const signal = this.activeSignal(initialSignal);
    const delay = this.jitteredDelay(exponent);
    this.phase = "backing_off";
    this.nextDelayMs = delay;
    try {
      let sleep: unknown;
      try {
        sleep = this.options.clock.sleep(delay, signal);
      } catch (error) {
        throw reconnectError("invalid_contract", "backoff", "Reconnect clock sleep failed synchronously.", error);
      }
      if (!isPromiseLike(sleep)) {
        throw reconnectError("invalid_contract", "backoff", "Reconnect clock sleep must return a promise.");
      }
      await settleByAbortSignal(sleep, signal);
      throwIfAborted(signal, "backoff");
    } catch (error) {
      if (this.closing) return;
      if (signal.aborted) throw normalizeAbortOrTimeout(error, "backoff");
      if (isOwnedReconnectError(error)) throw error;
      throw reconnectError("invalid_contract", "backoff", "Reconnect clock sleep failed.", error);
    } finally {
      this.nextDelayMs = null;
    }
  }

  private async runConnectionCycle(initialSignal: AbortSignal | undefined): Promise<Omit<CodexReconnectReady, "reconnected">> {
    const cycleAbort = new AbortController();
    const runtimeLease: LifecycleRuntimeLease = { active: true, stage: "reconcile" };
    let lifecycleStage: CodexReconnectStage = "connect";
    let ownedDeadline: OperationDeadline | null = null;
    this.activeCycleAbort = cycleAbort;
    try {
      const parentSignal = AbortSignal.any([this.activeSignal(initialSignal), cycleAbort.signal]);
      const deadline = this.createDeadline(parentSignal);
      ownedDeadline = deadline;
      this.phase = "connecting";
      increment(this.counters, "connectAttempts");
      const compatibility = freezeCompatibility(
        await settleByDeadline(this.connection.connect(deadline.signal), deadline, "connect")
      );
      const generation = this.connection.generation;
      this.assertCurrentGeneration(generation, deadline, "connect");

      const runtime = this.readOnlyPort(generation, deadline, compatibility, runtimeLease);
      lifecycleStage = "reconcile";
      runtimeLease.stage = "reconcile";
      this.phase = "reconciling";
      const reconciliation = parseReconciliation(
        await settleByDeadline(
          this.options.lifecycle.reconcile({
            generation,
            previous_admitted_generation: this.previousAdmittedGeneration,
            compatibility,
            deadline,
            runtime
          }),
          deadline,
          "reconcile"
        )
      );
      this.assertCurrentGeneration(generation, deadline, "reconcile");

      lifecycleStage = "resubscribe";
      runtimeLease.stage = "resubscribe";
      this.phase = "resubscribing";
      const shared = {
        generation,
        previous_admitted_generation: this.previousAdmittedGeneration,
        compatibility,
        deadline,
        runtime,
        reconciliation
      } as const;
      await settleByDeadline(this.options.lifecycle.resubscribe(shared), deadline, "resubscribe");
      this.assertCurrentGeneration(generation, deadline, "resubscribe");
      this.drainHeldInbound(generation, deadline, "resubscribe");
      lifecycleStage = "ready";
      runtimeLease.stage = "ready";
      this.lifecycleInboundGeneration = generation;
      try {
        await settleByDeadline(this.options.lifecycle.ready(shared), deadline, "ready");
      } finally {
        if (this.lifecycleInboundGeneration === generation) this.lifecycleInboundGeneration = null;
      }
      this.assertCurrentGeneration(generation, deadline, "ready");
      this.drainHeldInbound(generation, deadline, "ready");
      this.assertCurrentGeneration(generation, deadline, "ready");

      if (this.everReady) increment(this.counters, "completedReconnects");
      this.previousAdmittedGeneration = generation;
      this.admittedGeneration = generation;
      this.phase = "ready";
      this.lastFailure = null;
      return Object.freeze({
        compatibility: this.publicCompatibility(),
        continuity: reconciliation.continuity,
        generation
      });
    } catch (error) {
      if (lifecycleStage !== "connect") {
        if (isGenerationChange(error)) throw error;
        if (error instanceof OperationDeadlineExceededError) {
          throw reconnectError("operation_timeout", lifecycleStage, "Reconnect lifecycle step timed out.", error);
        }
        if (isOwnedReconnectError(error)) throw error;
        throw lifecycleFailure(lifecycleStage, error);
      }
      throw error;
    } finally {
      runtimeLease.active = false;
      ownedDeadline?.dispose();
      if (this.activeCycleAbort === cycleAbort) this.activeCycleAbort = null;
    }
  }

  private readOnlyPort(
    generation: number,
    deadline: OperationDeadline,
    compatibility: RuntimeCompatibility,
    lease: LifecycleRuntimeLease
  ): CodexReconnectResubscribePort {
    const controller = this;
    return Object.freeze({
      compatibility,
      generation,
      async request(input: CodexRequestInput) {
        controller.assertRuntimeLease(lease);
        const method = input !== null && typeof input === "object" ? input.method : undefined;
        const allowedRead =
          typeof method === "string" && (codexReconnectReadMethods as readonly string[]).includes(method);
        const allowedResubscribe =
          lease.stage === "resubscribe" &&
          typeof method === "string" &&
          (codexReconnectResubscribeMethods as readonly string[]).includes(method);
        if (
          input === null ||
          typeof input !== "object" ||
          input.kind !== "read" ||
          !isAbortSignalOrUndefined(input.signal) ||
          (!allowedRead && !allowedResubscribe)
        ) {
          throw reconnectError(
            "invalid_contract",
            lease.stage,
            "Reconnect lifecycle request is not allowed in the current stage."
          );
        }
        controller.assertCurrentGeneration(generation, deadline, lease.stage);
        const signal = input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
        const result = await controller.connection.request({ ...input, kind: "read", signal });
        controller.assertRuntimeLease(lease);
        controller.assertCurrentGeneration(generation, deadline, lease.stage);
        return result;
      }
    });
  }

  private assertRuntimeLease(lease: LifecycleRuntimeLease): void {
    if (!lease.active) {
      throw reconnectError("lifecycle_conflict", lease.stage, "Reconnect lifecycle runtime lease is no longer active.");
    }
    if (lease.stage === "ready") {
      throw reconnectError("lifecycle_conflict", "ready", "Reconnect ready publication cannot issue runtime requests.");
    }
  }

  private receiveTransportEvent(event: CodexTransportEvent): void {
    if (event.type !== "close" || this.closing) return;
    const phaseAtClose = this.phase;
    this.admittedGeneration = null;
    this.clearHeldInbound();
    if (event.generation > 0 && event.generation > this.lastDisconnectedGeneration) {
      this.pendingDisconnectGeneration = Math.max(this.pendingDisconnectGeneration ?? 0, event.generation);
    }
    if (this.phase !== "incompatible" && this.phase !== "failed") this.phase = "disconnected";
    if (phaseAtClose !== "connecting") {
      this.activeCycleAbort?.abort(
        reconnectError(
          "generation_changed",
          stageForPhase(phaseAtClose),
          "Codex connection generation changed during reconnect work."
        )
      );
    }
    this.signalWake();
  }

  private receiveProtocolIssue(issue: CodexProtocolIssue): void {
    try {
      assertSynchronousCallbackResult(this.options.onProtocolIssue?.(issue));
    } catch (error) {
      this.setPendingFatal(reconnectError("protocol_failed", "inbound", "Codex protocol issue observer failed.", error));
      throw error;
    }
    if (issue.severity === "fatal" || (issue.severity === "degraded" && issue.code !== "late_response")) {
      const error = reconnectError("protocol_failed", "inbound", "Codex protocol semantics became unsafe for admission.");
      this.setPendingFatal(error);
      throw error;
    }
  }

  private receiveInbound(inbound: HeldInbound): void {
    if (
      (this.isAdmitted() && inbound.generation === this.admittedGeneration) ||
      inbound.generation === this.lifecycleInboundGeneration
    ) {
      this.deliverInbound(inbound);
      return;
    }
    if (inbound.generation !== this.options.transport.generation || inbound.generation < 1) {
      const error = reconnectError("generation_changed", "inbound", "Codex callback belongs to a stale connection generation.");
      this.setPendingFatal(error);
      throw error;
    }
    const limit =
      inbound.kind === "notification"
        ? this.options.resourceBudget.protocol_max_pending_notifications
        : this.options.resourceBudget.protocol_max_pending_server_requests;
    const current = inbound.kind === "notification" ? this.heldNotificationCount : this.heldServerRequestCount;
    if (current >= limit) {
      const error = reconnectError("protocol_failed", "inbound", "Codex pre-admission callback capacity is exhausted.");
      this.setPendingFatal(error);
      throw error;
    }
    this.heldInbound.push(inbound);
    if (inbound.kind === "notification") this.heldNotificationCount += 1;
    else this.heldServerRequestCount += 1;
  }

  private drainHeldInbound(
    generation: number,
    deadline: OperationDeadline,
    stage: "ready" | "resubscribe"
  ): void {
    while (this.heldInbound.length > 0) {
      this.assertCurrentGeneration(generation, deadline, stage);
      const inbound = this.heldInbound.shift();
      if (inbound === undefined) break;
      if (inbound.kind === "notification") this.heldNotificationCount -= 1;
      else this.heldServerRequestCount -= 1;
      if (inbound.generation !== generation) {
        throw reconnectError("generation_changed", "inbound", "Held Codex callback crossed connection generations.");
      }
      this.deliverInbound(inbound);
    }
  }

  private deliverInbound(inbound: HeldInbound): void {
    const previousCompatibilityGeneration = this.inboundCompatibilityGeneration;
    this.inboundCompatibilityGeneration = inbound.generation;
    try {
      const result =
        inbound.kind === "notification"
          ? this.options.onNotification?.(inbound.message)
          : this.options.onServerRequest?.(inbound.message);
      assertSynchronousCallbackResult(result);
    } catch (error) {
      const normalized = reconnectError("protocol_failed", "inbound", "Codex application callback failed.", error);
      this.setPendingFatal(normalized);
      throw normalized;
    } finally {
      this.inboundCompatibilityGeneration = previousCompatibilityGeneration;
    }
  }

  private clearHeldInbound(): void {
    this.heldInbound.length = 0;
    this.heldNotificationCount = 0;
    this.heldServerRequestCount = 0;
    this.lifecycleInboundGeneration = null;
    this.inboundCompatibilityGeneration = null;
  }

  private assertCurrentGeneration(
    generation: number,
    deadline: OperationDeadline,
    stage: CodexReconnectStage
  ): void {
    deadline.throwIfAborted();
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      this.connection.generation !== generation ||
      this.options.transport.generation !== generation ||
      this.options.transport.state !== "open" ||
      this.pendingDisconnectGeneration === generation
    ) {
      throw reconnectError("generation_changed", stage, "Codex connection generation changed during reconnect work.");
    }
  }

  private isAdmitted(): boolean {
    return (
      this.phase === "ready" &&
      this.admittedGeneration !== null &&
      this.admittedGeneration === this.connection.generation &&
      this.options.transport.state === "open" &&
      ["degraded", "ready"].includes(this.connection.state) &&
      this.connection.compatibility.mutation_policy === "allowed"
    );
  }

  private publicCompatibility(): RuntimeCompatibility {
    const compatibility = this.connection.compatibility;
    const registeringCurrentInbound =
      this.inboundCompatibilityGeneration !== null &&
      this.inboundCompatibilityGeneration === this.connection.generation &&
      this.options.transport.state === "open";
    if (this.isAdmitted() || registeringCurrentInbound) return freezeCompatibility(compatibility);
    if (compatibility.state === "incompatible") return freezeCompatibility(compatibility);
    if (["degraded", "ready"].includes(compatibility.state)) {
      return freezeCompatibility({
        ...compatibility,
        state: "degraded",
        mutation_policy: "blocked",
        reason: "Codex runtime reconciliation is incomplete."
      });
    }
    return freezeCompatibility({
      ...compatibility,
      state: "disconnected",
      mutation_policy: "blocked",
      reason: "Codex runtime is disconnected.",
      capabilities: compatibility.capabilities.map((capability) => ({
        ...capability,
        reason: capability.state === "available" ? null : "Runtime compatibility is unavailable."
      }))
    });
  }

  private jitteredDelay(exponent: number): number {
    const initial = this.options.resourceBudget.protocol_reconnect_initial_delay_ms;
    const maximum = this.options.resourceBudget.protocol_reconnect_max_delay_ms;
    const safeExponent = Math.min(exponent, 52);
    const base = Math.min(maximum, initial * 2 ** safeExponent);
    let random: number;
    try {
      random = this.options.random();
    } catch (error) {
      throw reconnectError("invalid_contract", "backoff", "Reconnect random source failed.", error);
    }
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw reconnectError("invalid_contract", "backoff", "Reconnect random source must return a finite value in [0, 1).");
    }
    return Math.min(maximum, Math.ceil(base / 2 + (base / 2) * random));
  }

  private activeSignal(initialSignal: AbortSignal | undefined): AbortSignal {
    if (this.everReady || initialSignal === undefined) return this.lifecycleAbort.signal;
    return AbortSignal.any([initialSignal, this.lifecycleAbort.signal]);
  }

  private createCycleDeadline(initialSignal: AbortSignal | undefined): OperationDeadline {
    return this.createDeadline(this.activeSignal(initialSignal));
  }

  private createDeadline(parentSignal: AbortSignal): OperationDeadline {
    try {
      return createOperationDeadline({
        timeoutMs: this.options.resourceBudget.lifecycle_startup_timeout_ms,
        parentSignal,
        clock: this.options.clock
      });
    } catch (error) {
      throw reconnectError("invalid_contract", "configuration", "Reconnect deadline clock contract is invalid.", error);
    }
  }

  private setPendingFatal(error: HostDeckCodexReconnectError): void {
    this.pendingFatal ??= error;
    this.admittedGeneration = null;
    this.activeCycleAbort?.abort(error);
    this.signalWake();
  }

  private throwPendingFatal(): void {
    if (this.pendingFatal !== null) throw this.pendingFatal;
  }

  private waitForWake(signal: AbortSignal): Promise<void> {
    if (this.pendingDisconnectGeneration !== null || this.pendingFatal !== null || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", finish);
        if (this.wakeResolve === finish) this.wakeResolve = null;
        resolve();
      };
      this.wakeResolve = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (this.pendingDisconnectGeneration !== null || this.pendingFatal !== null || signal.aborted) finish();
    });
  }

  private signalWake(): void {
    this.wakeResolve?.();
  }

  private async recordTerminal(error: unknown): Promise<void> {
    if (this.closing) return;
    let normalized = asReconnectError(error, stageForPhase(this.phase));
    const terminalPhase = normalized.code === "incompatible" ? "incompatible" : "failed";
    this.phase = terminalPhase;
    this.admittedGeneration = null;
    this.clearHeldInbound();
    try {
      await this.closeOwnedConnection("HostDeck stopped the Codex reconnect controller after terminal failure.");
    } catch {
      // The connection owns bounded forced shutdown. Preserve the initiating failure for public truth.
    }
    if (this.closing) return;
    try {
      await this.runPendingDisconnectCleanup(undefined);
    } catch (cleanupError) {
      normalized = asReconnectError(cleanupError, "disconnect");
    }
    this.lastFailure = Object.freeze({ code: normalized.code, stage: normalized.stage });
    this.phase = normalized.code === "incompatible" ? "incompatible" : "failed";
    if (!this.everReady) {
      this.initialReady.reject(normalized);
      return;
    }
    try {
      assertSynchronousCallbackResult(this.options.onBackgroundError(normalized));
    } catch {
      this.lastFailure = Object.freeze({ code: "invalid_contract", stage: "configuration" });
    }
  }

  private async closeInternal(): Promise<void> {
    let failure: unknown;
    try {
      await this.closeOwnedConnection("HostDeck closed the Codex reconnect controller.");
    } catch (error) {
      failure = error;
    }
    try {
      await this.runPromise;
    } catch (error) {
      failure ??= error;
    }
    this.unsubscribeOwnedTransport();
    this.phase = "closed";
    if (failure !== undefined) {
      throw reconnectError("transport_failed", "shutdown", "Reconnect controller shutdown failed.", failure);
    }
  }

  private async closeOwnedConnection(reason: string): Promise<void> {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    try {
      await this.connection.close(reason);
    } finally {
      this.unsubscribeOwnedTransport();
    }
  }

  private unsubscribeOwnedTransport(): void {
    if (!this.resourcesClosed || this.transportUnsubscribed) return;
    this.transportUnsubscribed = true;
    this.unsubscribeTransport();
  }
}

function parseOptions(candidate: unknown): ParsedOptions {
  const value = requirePlainRecord(candidate, "Codex reconnect controller options must be a plain object.");
  assertAllowedKeys(
    value,
    optionKeys,
    ["lifecycle", "observed_version", "on_background_error", "resource_budget", "transport"],
    "Codex reconnect controller options"
  );
  const resourceBudgetCandidate = dataProperty(value, "resource_budget");
  try {
    assertResolvedResourceBudget(resourceBudgetCandidate);
  } catch (error) {
    throw reconnectError("invalid_contract", "configuration", "Reconnect controller requires a complete resolved resource budget.", error);
  }
  const resourceBudget = resourceBudgetCandidate;
  const transport = parseTransport(dataProperty(value, "transport"), resourceBudget.protocol_max_frame_bytes);
  const observedVersion = dataProperty(value, "observed_version");
  if (observedVersion !== null && typeof observedVersion !== "string") {
    throw reconnectError("invalid_contract", "configuration", "Reconnect observed version must be a string or null.");
  }
  const clientVersion = parseClientVersion(dataProperty(value, "client_version"));
  return Object.freeze({
    transport,
    observedVersion,
    resourceBudget,
    lifecycle: parseLifecycle(dataProperty(value, "lifecycle")),
    clientVersion,
    clock: parseClock(dataProperty(value, "clock")),
    random:
      (parseCallback(dataProperty(value, "random"), "Reconnect random source", false) as
        | (() => number)
        | undefined) ?? Math.random,
    onNotification: parseCallback(
      dataProperty(value, "on_notification"),
      "Reconnect notification callback",
      false
    ) as ((message: CodexConnectionNotification) => void) | undefined,
    onServerRequest: parseCallback(
      dataProperty(value, "on_server_request"),
      "Reconnect server-request callback",
      false
    ) as ((message: CodexConnectionServerRequest) => void) | undefined,
    onProtocolIssue: parseCallback(
      dataProperty(value, "on_protocol_issue"),
      "Reconnect protocol-issue callback",
      false
    ) as ((issue: CodexProtocolIssue) => void) | undefined,
    onBackgroundError: parseCallback(
      dataProperty(value, "on_background_error"),
      "Reconnect background-error callback",
      true
    ) as (error: HostDeckCodexReconnectError) => void
  });
}

function parseLifecycle(candidate: unknown): CodexReconnectLifecyclePort {
  const value = requirePlainRecord(candidate, "Codex reconnect lifecycle port must be a plain object.");
  assertExactKeys(value, lifecycleKeys, "Codex reconnect lifecycle port");
  return Object.freeze({
    disconnected: parseCallback(dataProperty(value, "disconnected"), "Reconnect disconnected callback", true) as CodexReconnectLifecyclePort["disconnected"],
    reconcile: parseCallback(dataProperty(value, "reconcile"), "Reconnect reconcile callback", true) as CodexReconnectLifecyclePort["reconcile"],
    resubscribe: parseCallback(dataProperty(value, "resubscribe"), "Reconnect resubscribe callback", true) as CodexReconnectLifecyclePort["resubscribe"],
    ready: parseCallback(dataProperty(value, "ready"), "Reconnect ready callback", true) as CodexReconnectLifecyclePort["ready"]
  });
}

function parseTransport(candidate: unknown, expectedMaxFrameBytes: number): CodexTextTransport {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw reconnectError("invalid_contract", "configuration", "Reconnect controller requires a transport object.");
  }
  for (const key of ["connect", "sendText", "close", "terminate", "subscribe"] as const) {
    if (typeof methodProperty(candidate, key) !== "function") {
      throw reconnectError("invalid_contract", "configuration", `Reconnect transport ${key} must be a function.`);
    }
  }
  const transport = candidate as CodexTextTransport;
  let unsubscribe: unknown;
  try {
    unsubscribe = transport.subscribe(() => undefined);
    if (typeof unsubscribe !== "function") {
      throw new TypeError("Transport subscribe returned no unsubscribe function.");
    }
    unsubscribe();
  } catch (error) {
    throw reconnectError("invalid_contract", "configuration", "Reconnect transport subscription contract is invalid.", error);
  }
  let state: unknown;
  let generation: unknown;
  let maxFrameBytes: unknown;
  try {
    state = transport.state;
    generation = transport.generation;
    maxFrameBytes = transport.max_frame_bytes;
  } catch (error) {
    throw reconnectError("invalid_contract", "configuration", "Reconnect transport properties are not readable.", error);
  }
  if (
    typeof state !== "string" ||
    !["closed", "closing", "connecting", "idle", "open"].includes(state) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 0 ||
    !Number.isSafeInteger(maxFrameBytes) ||
    (maxFrameBytes as number) < 1
  ) {
    throw reconnectError("invalid_contract", "configuration", "Reconnect transport state, generation, or frame bound is invalid.");
  }
  if (state !== "idle" || generation !== 0) {
    throw reconnectError("invalid_contract", "configuration", "Reconnect controller requires a fresh idle transport.");
  }
  if (maxFrameBytes !== expectedMaxFrameBytes) {
    throw reconnectError(
      "invalid_contract",
      "configuration",
      "Reconnect transport frame bound must match the selected resource budget."
    );
  }
  return transport;
}

function parseClock(candidate: unknown): CodexReconnectClock {
  if (candidate === undefined) return defaultClock;
  const value = requirePlainRecord(candidate, "Codex reconnect clock must be a plain object.");
  assertExactKeys(value, ["clearTimeout", "now", "setTimeout", "sleep"], "Codex reconnect clock");
  const callbacks: Record<string, unknown> = {};
  for (const key of ["clearTimeout", "now", "setTimeout", "sleep"] as const) {
    const callback = dataProperty(value, key);
    if (typeof callback !== "function") {
      throw reconnectError("invalid_contract", "configuration", `Reconnect clock ${key} must be a function.`);
    }
    callbacks[key] = callback;
  }
  return Object.freeze(callbacks) as unknown as CodexReconnectClock;
}

function parseClientVersion(candidate: unknown): string | undefined {
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 64) {
    throw reconnectError(
      "invalid_contract",
      "configuration",
      "Reconnect client version must be a non-empty string of at most 64 characters."
    );
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) {
      throw reconnectError("invalid_contract", "configuration", "Reconnect client version contains a control character.");
    }
  }
  return candidate;
}

function parseCallback<T extends (...args: never[]) => unknown>(
  candidate: unknown,
  label: string,
  required: boolean
): T | undefined {
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "function") {
    throw reconnectError("invalid_contract", "configuration", `${label} must be a function.`);
  }
  return candidate as T;
}

function parseReconciliation(candidate: unknown): CodexReconnectReconciliation {
  const value = requirePlainRecord(candidate, "Reconnect reconciliation result must be a plain object.");
  assertExactKeys(value, ["continuity"], "Reconnect reconciliation result");
  const continuity = dataProperty(value, "continuity");
  if (continuity !== "continuous" && continuity !== "boundary_required") {
    throw reconnectError("invalid_contract", "reconcile", "Reconnect reconciliation continuity is invalid.");
  }
  return Object.freeze({ continuity });
}

function normalizeCycleError(
  error: unknown,
  phase: CodexReconnectPhase,
  connection: CodexAppServerConnection
): { readonly error: HostDeckCodexReconnectError; readonly retrySafe: boolean } {
  if (isOwnedReconnectError(error)) {
    return {
      error,
      retrySafe:
        error.code === "generation_changed" ||
        error.code === "transport_failed" ||
        (error.code === "operation_timeout" && error.stage === "connect")
    };
  }
  if (error instanceof OperationDeadlineExceededError) {
    return {
      error: reconnectError("operation_timeout", stageForPhase(phase), "Codex reconnect attempt timed out.", error),
      retrySafe: phase === "connecting"
    };
  }
  if (error instanceof HostDeckCodexAdapterError) {
    if (connection.state === "incompatible" || (error.code === "handshake_failed" && !error.retry_safe)) {
      return {
        error: reconnectError("incompatible", "connect", "Codex runtime compatibility check failed.", error),
        retrySafe: false
      };
    }
    return {
      error: reconnectError("transport_failed", "connect", "Codex runtime connection attempt failed.", error),
      retrySafe: error.retry_safe
    };
  }
  return {
    error: reconnectError("lifecycle_failed", stageForPhase(phase), "Codex reconnect lifecycle failed.", error),
    retrySafe: false
  };
}

function normalizeAbortOrTimeout(error: unknown, stage: CodexReconnectStage): HostDeckCodexReconnectError {
  if (isOwnedReconnectError(error)) return error;
  if (error instanceof OperationDeadlineExceededError) {
    return reconnectError("operation_timeout", stage, "Reconnect operation timed out.", error);
  }
  return reconnectError("aborted", stage, "Reconnect operation was aborted.", error);
}

function lifecycleFailure(stage: CodexReconnectStage, cause: unknown): HostDeckCodexReconnectError {
  if (isOwnedReconnectError(cause)) return cause;
  if (cause instanceof OperationDeadlineExceededError) {
    return reconnectError("operation_timeout", stage, "Reconnect lifecycle step timed out.", cause);
  }
  return reconnectError("lifecycle_failed", stage, "Reconnect lifecycle step failed.", cause);
}

function asReconnectError(error: unknown, stage: CodexReconnectStage): HostDeckCodexReconnectError {
  if (isOwnedReconnectError(error)) return error;
  if (error instanceof OperationDeadlineExceededError) {
    return reconnectError("operation_timeout", stage, "Reconnect operation timed out.", error);
  }
  if (error instanceof HostDeckCodexAdapterError) {
    return reconnectError(
      error.code === "handshake_failed" ? "incompatible" : "transport_failed",
      stage,
      "Codex reconnect operation failed.",
      error
    );
  }
  return reconnectError("lifecycle_failed", stage, "Codex reconnect operation failed.", error);
}

function reconnectError(
  code: CodexReconnectErrorCode,
  stage: CodexReconnectStage,
  message: string,
  cause?: unknown
): HostDeckCodexReconnectError {
  void cause;
  const error = new HostDeckCodexReconnectError(code, stage, message);
  ownedReconnectErrors.add(error);
  return error;
}

function blockedAdapterError(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "transport_not_open",
    "Codex application request is blocked until reconnect reconciliation is ready.",
    { outcome: "not_sent", retry_safe: true }
  );
}

function stageForPhase(phase: CodexReconnectPhase): CodexReconnectStage {
  if (phase === "connecting") return "connect";
  if (phase === "reconciling") return "reconcile";
  if (phase === "resubscribing") return "resubscribe";
  if (phase === "ready") return "ready";
  if (phase === "backing_off") return "backoff";
  if (phase === "closing" || phase === "closed") return "shutdown";
  if (phase === "disconnected") return "disconnect";
  return "configuration";
}

function isGenerationChange(error: unknown): boolean {
  return isOwnedReconnectError(error) && error.code === "generation_changed";
}

function isOwnedReconnectError(error: unknown): error is HostDeckCodexReconnectError {
  return error instanceof HostDeckCodexReconnectError && ownedReconnectErrors.has(error);
}

function throwIfAborted(signal: AbortSignal, stage: CodexReconnectStage): void {
  if (!signal.aborted) return;
  throw reconnectError("aborted", stage, "Reconnect operation was aborted.", signal.reason);
}

function isAbortSignalOrUndefined(candidate: unknown): candidate is AbortSignal | undefined {
  if (candidate === undefined) return true;
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !(candidate instanceof AbortSignal) ||
      typeof (candidate as AbortSignal).aborted !== "boolean" ||
      typeof (candidate as AbortSignal).addEventListener !== "function" ||
      typeof (candidate as AbortSignal).removeEventListener !== "function"
    ) {
      return false;
    }
    AbortSignal.any([candidate as AbortSignal]);
    return true;
  } catch {
    return false;
  }
}

function isPromiseLike<T = unknown>(candidate: unknown): candidate is PromiseLike<T> {
  if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) return false;
  try {
    return typeof Reflect.get(candidate, "then") === "function";
  } catch {
    return false;
  }
}

function settleByAbortSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
    if (signal.aborted) abort();
  });
}

function assertSynchronousCallbackResult(candidate: unknown): void {
  if (candidate !== null && (typeof candidate === "object" || typeof candidate === "function")) {
    const then = Reflect.get(candidate, "then");
    if (typeof then === "function") {
      void Promise.resolve(candidate).catch(() => undefined);
      throw reconnectError("invalid_contract", "inbound", "Reconnect observer callbacks must be synchronous.");
    }
  }
}

function requirePlainRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw reconnectError("invalid_contract", "configuration", message);
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw reconnectError("invalid_contract", "configuration", message);
  }
  return candidate as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => typeof key === "string" && !expected.includes(key))
  ) {
    throw reconnectError("invalid_contract", "configuration", `${label} must contain exactly the supported keys.`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => typeof key === "string" && !allowed.includes(key))
  ) {
    throw reconnectError("invalid_contract", "configuration", `${label} contains missing or unsupported keys.`);
  }
}

function dataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw reconnectError("invalid_contract", "configuration", `Reconnect ${key} must be a data property.`);
  }
  return descriptor.value;
}

function methodProperty(value: object, key: string): unknown {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw reconnectError("invalid_contract", "configuration", `Reconnect transport ${key} must be a data method.`);
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function increment(counters: MutableCounters, key: keyof MutableCounters): void {
  counters[key] = saturatingIncrement(counters[key]);
}

function saturatingIncrement(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function freezeCompatibility(candidate: unknown): RuntimeCompatibility {
  return deepFreeze(runtimeCompatibilitySchema.parse(candidate));
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function settleByDeadline<T>(
  operation: T | PromiseLike<T>,
  deadline: OperationDeadline,
  stage: CodexReconnectStage
): Promise<T> {
  deadline.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      deadline.signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () =>
      finish(() => {
        const reason = deadline.signal.reason;
        reject(
          isOwnedReconnectError(reason)
            ? reason
            : reason instanceof OperationDeadlineExceededError
              ? reconnectError("operation_timeout", stage, "Reconnect lifecycle step exceeded its deadline.", reason)
              : reconnectError("aborted", stage, "Reconnect lifecycle step was aborted.", reason)
        );
      });
    deadline.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
    if (deadline.signal.aborted) abort();
  });
}
