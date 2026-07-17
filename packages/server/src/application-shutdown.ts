import {
  assertResolvedResourceBudget,
  type ResourceBudget,
  resourceBudgetDefinitions
} from "@hostdeck/contracts";
import {
  createOperationDeadline,
  type OperationDeadline,
  OperationDeadlineExceededError
} from "@hostdeck/core";
import {
  assertHostDeckSelectedWriteAdmissionPolicy,
  type HostDeckSelectedWriteAdmissionPolicy
} from "./selected-write-admission-policy.js";
import { readExactDataObject } from "./selected-write-gate-contracts.js";

export const hostDeckApplicationShutdownStages = [
  "admission",
  "subscribers",
  "approvals",
  "reconnect",
  "writes",
  "audit",
  "projection",
  "supervisor",
  "storage",
  "lease"
] as const;
export type HostDeckApplicationShutdownStage =
  (typeof hostDeckApplicationShutdownStages)[number];

export const hostDeckApplicationShutdownStageStates = [
  "pending",
  "running",
  "succeeded",
  "failed"
] as const;
export type HostDeckApplicationShutdownStageState =
  (typeof hostDeckApplicationShutdownStageStates)[number];

export type HostDeckApplicationShutdownPhase =
  | "open"
  | "draining"
  | "closed"
  | "failed";

export type HostDeckApplicationShutdownFailureReason =
  | "aborted"
  | "contract_invalid"
  | "failed"
  | "timed_out";

export class HostDeckApplicationShutdownStageError extends Error {
  constructor(
    readonly stage: HostDeckApplicationShutdownStage,
    readonly reason: HostDeckApplicationShutdownFailureReason,
    cause: unknown
  ) {
    super(`HostDeck application shutdown stage ${stage} ${stageFailureMessage(reason)}.`, {
      cause
    });
    this.name = "HostDeckApplicationShutdownStageError";
  }
}

export class HostDeckApplicationShutdownError extends Error {
  constructor(
    readonly failed_stages: readonly HostDeckApplicationShutdownStage[],
    cause: AggregateError
  ) {
    super("HostDeck application shutdown did not complete cleanly.", { cause });
    this.name = "HostDeckApplicationShutdownError";
  }
}

export interface HostDeckApplicationAdmissionDrainAcknowledgement {
  readonly admission: "closed";
  readonly active_operations: number;
}

export interface HostDeckApplicationWriteDrainAcknowledgement {
  readonly active_operations: 0;
}

export interface HostDeckApplicationAuditBarrierAcknowledgement {
  readonly pending_operations: 0;
  readonly reconciled_operations: number;
}

export interface HostDeckApplicationProjectionBarrierAcknowledgement {
  readonly last_sequence: number;
  readonly pending_notifications: 0;
}

export interface HostDeckApplicationWriteShutdownPort {
  readonly beginDrain: (
    this: void
  ) => HostDeckApplicationAdmissionDrainAcknowledgement;
  readonly drain: (
    this: void,
    deadline: OperationDeadline
  ) =>
    | HostDeckApplicationWriteDrainAcknowledgement
    | Promise<HostDeckApplicationWriteDrainAcknowledgement>;
}

export interface HostDeckApplicationClosePort {
  readonly close: (
    this: void,
    deadline: OperationDeadline
  ) => void | Promise<void>;
}

export interface HostDeckApplicationAuditBarrierPort {
  readonly barrier: (
    this: void,
    deadline: OperationDeadline
  ) =>
    | HostDeckApplicationAuditBarrierAcknowledgement
    | Promise<HostDeckApplicationAuditBarrierAcknowledgement>;
}

export interface HostDeckApplicationProjectionBarrierPort {
  readonly barrier: (
    this: void,
    deadline: OperationDeadline
  ) =>
    | HostDeckApplicationProjectionBarrierAcknowledgement
    | Promise<HostDeckApplicationProjectionBarrierAcknowledgement>;
}

export interface HostDeckApplicationLeaseReleasePort {
  readonly release: (
    this: void,
    deadline: OperationDeadline
  ) => void | Promise<void>;
}

export interface CreateHostDeckApplicationShutdownInput {
  readonly approvals: HostDeckApplicationClosePort;
  readonly audit: HostDeckApplicationAuditBarrierPort;
  readonly lease: HostDeckApplicationLeaseReleasePort;
  readonly projection: HostDeckApplicationProjectionBarrierPort;
  readonly reconnect: HostDeckApplicationClosePort;
  readonly resource_budget: ResourceBudget;
  readonly storage: HostDeckApplicationClosePort;
  readonly subscribers: HostDeckApplicationClosePort;
  readonly supervisor: HostDeckApplicationClosePort;
  readonly writes: HostDeckApplicationWriteShutdownPort;
}

export interface HostDeckApplicationShutdownStageSnapshot {
  readonly stage: HostDeckApplicationShutdownStage;
  readonly state: HostDeckApplicationShutdownStageState;
  readonly failure: HostDeckApplicationShutdownFailureReason | null;
}

export interface HostDeckApplicationShutdownSnapshot {
  readonly phase: HostDeckApplicationShutdownPhase;
  readonly completed_stage_count: number;
  readonly failed_stage_count: number;
  readonly active_write_operations: number | null;
  readonly pending_audit_operations: number | null;
  readonly reconciled_audit_operations: number;
  readonly pending_projection_notifications: number | null;
  readonly projection_last_sequence: number | null;
  readonly stages: readonly HostDeckApplicationShutdownStageSnapshot[];
}

export interface HostDeckApplicationShutdown {
  readonly beginDrain: () => void;
  readonly closeSse: (deadline: OperationDeadline) => Promise<void>;
  readonly closeRuntime: (deadline: OperationDeadline) => Promise<void>;
  readonly closeStartup: (deadline: OperationDeadline) => Promise<void>;
  readonly snapshot: () => HostDeckApplicationShutdownSnapshot;
}

export interface CreateHostDeckSelectedWriteShutdownPortInput {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
}

interface MutableStageRecord {
  readonly stage: HostDeckApplicationShutdownStage;
  state: HostDeckApplicationShutdownStageState;
  failure: HostDeckApplicationShutdownFailureReason | null;
}

interface ParsedShutdownInput {
  readonly budget: ResourceBudget;
  readonly callbacks: Readonly<
    Record<
      Exclude<HostDeckApplicationShutdownStage, "admission" | "writes" | "audit" | "projection" | "lease">,
      HostDeckApplicationClosePort["close"]
    > & {
      readonly admission: HostDeckApplicationWriteShutdownPort["beginDrain"];
      readonly writes: HostDeckApplicationWriteShutdownPort["drain"];
      readonly audit: HostDeckApplicationAuditBarrierPort["barrier"];
      readonly projection: HostDeckApplicationProjectionBarrierPort["barrier"];
      readonly lease: HostDeckApplicationLeaseReleasePort["release"];
    }
  >;
}

type StageValidator = (candidate: unknown) => void;

const acceptedShutdownControllers = new WeakSet<object>();
const acceptedSelectedWriteShutdownPorts = new WeakSet<object>();

export function createHostDeckApplicationShutdown(
  input: CreateHostDeckApplicationShutdownInput
): HostDeckApplicationShutdown {
  const implementation = new DefaultHostDeckApplicationShutdown(parseInput(input));
  const controller: HostDeckApplicationShutdown = Object.freeze({
    beginDrain: () => implementation.beginDrain(),
    closeSse: (deadline: OperationDeadline) => implementation.closeSse(deadline),
    closeRuntime: (deadline: OperationDeadline) =>
      implementation.closeRuntime(deadline),
    closeStartup: (deadline: OperationDeadline) =>
      implementation.closeStartup(deadline),
    snapshot: () => implementation.snapshot()
  });
  acceptedShutdownControllers.add(controller);
  return controller;
}

export function assertHostDeckApplicationShutdown(
  candidate: unknown
): asserts candidate is HostDeckApplicationShutdown {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedShutdownControllers.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck application shutdown must be created by its factory."
    );
  }
}

export function createHostDeckSelectedWriteShutdownPort(
  input: CreateHostDeckSelectedWriteShutdownPortInput
): HostDeckApplicationWriteShutdownPort {
  const values = readExactDataObject(
    input,
    ["admission"],
    "HostDeck selected-write shutdown port input is invalid."
  );
  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  const admission = values.admission as HostDeckSelectedWriteAdmissionPolicy;
  const port: HostDeckApplicationWriteShutdownPort = Object.freeze({
    beginDrain() {
      const snapshot = admission.beginDrain();
      return Object.freeze({
        admission: "closed" as const,
        active_operations: snapshot.active_owners
      });
    },
    async drain(deadline: OperationDeadline) {
      assertOperationDeadline(deadline);
      const snapshot = await admission.drain(deadline.signal);
      if (snapshot.phase !== "closed" || snapshot.active_owners !== 0) {
        throw new TypeError(
          "Selected-write admission drain returned contradictory state."
        );
      }
      return Object.freeze({ active_operations: 0 as const });
    }
  });
  acceptedSelectedWriteShutdownPorts.add(port);
  return port;
}

export function assertHostDeckSelectedWriteShutdownPort(
  candidate: unknown
): asserts candidate is HostDeckApplicationWriteShutdownPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedSelectedWriteShutdownPorts.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck selected-write shutdown port must be created by its factory."
    );
  }
}

class DefaultHostDeckApplicationShutdown {
  private phase: HostDeckApplicationShutdownPhase = "open";
  private readonly stages = new Map<
    HostDeckApplicationShutdownStage,
    MutableStageRecord
  >();
  private admissionInvoked = false;
  private admissionError: HostDeckApplicationShutdownStageError | null = null;
  private ssePromise: Promise<void> | null = null;
  private runtimePromise: Promise<void> | null = null;
  private startupPromise: Promise<void> | null = null;
  private activeWriteOperations: number | null = null;
  private pendingAuditOperations: number | null = null;
  private reconciledAuditOperations = 0;
  private pendingProjectionNotifications: number | null = null;
  private projectionLastSequence: number | null = null;

  constructor(private readonly input: ParsedShutdownInput) {
    for (const stage of hostDeckApplicationShutdownStages) {
      this.stages.set(stage, { stage, state: "pending", failure: null });
    }
  }

  beginDrain(): void {
    if (this.admissionInvoked) {
      if (this.admissionError !== null) throw this.admissionError;
      return;
    }
    this.admissionInvoked = true;
    this.phase = "draining";
    const record = this.requireStage("admission");
    record.state = "running";
    let rawAcknowledgement: unknown;
    try {
      rawAcknowledgement = Reflect.apply(
        this.input.callbacks.admission,
        undefined,
        []
      );
    } catch (cause) {
      const error = this.failStage(record, "failed", cause);
      this.admissionError = error;
      throw error;
    }
    try {
      const acknowledgement = parseAdmissionAcknowledgement(rawAcknowledgement);
      this.activeWriteOperations = acknowledgement.active_operations;
      record.state = "succeeded";
    } catch (cause) {
      observePromiseRejection(rawAcknowledgement);
      const error = this.failStage(
        record,
        "contract_invalid",
        cause
      );
      this.admissionError = error;
      throw error;
    }
  }

  closeSse(deadline: OperationDeadline): Promise<void> {
    if (this.ssePromise !== null) return this.ssePromise;
    assertOperationDeadline(deadline);
    this.ssePromise = this.runSegment(deadline, [
      {
        stage: "subscribers",
        callback: this.input.callbacks.subscribers,
        maximumMs: this.input.budget.sse_shutdown_timeout_ms,
        validate: requireVoidAcknowledgement
      }
    ]);
    return this.ssePromise;
  }

  closeRuntime(deadline: OperationDeadline): Promise<void> {
    if (this.runtimePromise !== null) return this.runtimePromise;
    assertOperationDeadline(deadline);
    this.runtimePromise = this.runSegment(deadline, [
      this.voidStep("approvals", this.input.callbacks.approvals),
      this.voidStep(
        "reconnect",
        this.input.callbacks.reconnect,
        this.input.budget.protocol_close_timeout_ms
      ),
      {
        stage: "writes",
        callback: this.input.callbacks.writes,
        maximumMs: this.input.budget.lifecycle_cleanup_step_timeout_ms,
        validate: (candidate) => {
          const acknowledgement = parseWriteDrainAcknowledgement(candidate);
          this.activeWriteOperations = acknowledgement.active_operations;
        }
      },
      {
        stage: "audit",
        callback: this.input.callbacks.audit,
        maximumMs: this.input.budget.lifecycle_cleanup_step_timeout_ms,
        validate: (candidate) => {
          const acknowledgement = parseAuditAcknowledgement(candidate);
          this.pendingAuditOperations = acknowledgement.pending_operations;
          this.reconciledAuditOperations = acknowledgement.reconciled_operations;
        }
      },
      {
        stage: "projection",
        callback: this.input.callbacks.projection,
        maximumMs: this.input.budget.lifecycle_cleanup_step_timeout_ms,
        validate: (candidate) => {
          const acknowledgement = parseProjectionAcknowledgement(candidate);
          this.pendingProjectionNotifications =
            acknowledgement.pending_notifications;
          this.projectionLastSequence = acknowledgement.last_sequence;
        }
      },
      this.voidStep("supervisor", this.input.callbacks.supervisor)
    ]);
    return this.runtimePromise;
  }

  closeStartup(deadline: OperationDeadline): Promise<void> {
    if (this.startupPromise !== null) return this.startupPromise;
    assertOperationDeadline(deadline);
    this.startupPromise = this.runSegment(deadline, [
      this.voidStep("storage", this.input.callbacks.storage),
      {
        stage: "lease",
        callback: this.input.callbacks.lease,
        maximumMs: this.input.budget.lifecycle_cleanup_step_timeout_ms,
        validate: requireVoidAcknowledgement
      }
    ]).finally(() => {
      const records = [...this.stages.values()];
      if (records.some((record) => record.state === "failed")) {
        this.phase = "failed";
      } else if (records.every((record) => record.state === "succeeded")) {
        this.phase = "closed";
      } else {
        this.phase = "draining";
      }
    });
    return this.startupPromise;
  }

  snapshot(): HostDeckApplicationShutdownSnapshot {
    const stages = Object.freeze(
      hostDeckApplicationShutdownStages.map((stage) => {
        const record = this.requireStage(stage);
        return Object.freeze({
          stage,
          state: record.state,
          failure: record.failure
        });
      })
    );
    return Object.freeze({
      phase: this.phase,
      completed_stage_count: stages.filter(
        (stage) => stage.state === "succeeded"
      ).length,
      failed_stage_count: stages.filter((stage) => stage.state === "failed")
        .length,
      active_write_operations: this.activeWriteOperations,
      pending_audit_operations: this.pendingAuditOperations,
      reconciled_audit_operations: this.reconciledAuditOperations,
      pending_projection_notifications: this.pendingProjectionNotifications,
      projection_last_sequence: this.projectionLastSequence,
      stages
    });
  }

  private voidStep(
    stage: Exclude<
      HostDeckApplicationShutdownStage,
      "admission" | "writes" | "audit" | "projection" | "lease"
    >,
    callback: HostDeckApplicationClosePort["close"],
    maximumMs = this.input.budget.lifecycle_cleanup_step_timeout_ms
  ): ShutdownStep {
    return { stage, callback, maximumMs, validate: requireVoidAcknowledgement };
  }

  private async runSegment(
    deadline: OperationDeadline,
    steps: readonly ShutdownStep[]
  ): Promise<void> {
    const errors: HostDeckApplicationShutdownStageError[] = [];
    for (const step of steps) {
      const error = await this.runStage(deadline, step);
      if (error !== null) errors.push(error);
    }
    if (errors.length > 0) {
      const failedStages = Object.freeze(errors.map((error) => error.stage));
      throw new HostDeckApplicationShutdownError(
        failedStages,
        new AggregateError(errors, "HostDeck application shutdown stages failed.")
      );
    }
  }

  private async runStage(
    parent: OperationDeadline,
    step: ShutdownStep
  ): Promise<HostDeckApplicationShutdownStageError | null> {
    const record = this.requireStage(step.stage);
    if (record.state !== "pending") {
      return this.failStage(
        record,
        "contract_invalid",
        new TypeError("HostDeck shutdown stage was invoked more than once.")
      );
    }
    record.state = "running";
    const deadline = createChildDeadline(parent, step.maximumMs);
    let operation: Promise<unknown>;
    try {
      operation = Promise.resolve(
        Reflect.apply(step.callback, undefined, [deadline])
      );
    } catch (cause) {
      deadline.dispose();
      return this.failStage(record, failureReason(cause, deadline), cause);
    }

    let settled: unknown;
    try {
      settled = await awaitWithSignal(operation, deadline.signal);
    } catch (cause) {
      const reason = failureReason(cause, deadline);
      deadline.dispose();
      return this.failStage(record, reason, cause);
    }

    try {
      step.validate(settled);
    } catch (cause) {
      deadline.dispose();
      return this.failStage(record, "contract_invalid", cause);
    }
    deadline.dispose();
    record.state = "succeeded";
    return null;
  }

  private failStage(
    record: MutableStageRecord,
    reason: HostDeckApplicationShutdownFailureReason,
    cause: unknown
  ): HostDeckApplicationShutdownStageError {
    record.state = "failed";
    record.failure = reason;
    return new HostDeckApplicationShutdownStageError(record.stage, reason, cause);
  }

  private requireStage(
    stage: HostDeckApplicationShutdownStage
  ): MutableStageRecord {
    const record = this.stages.get(stage);
    if (record === undefined) {
      throw new Error("HostDeck application shutdown stage registry is incomplete.");
    }
    return record;
  }
}

interface ShutdownStep {
  readonly stage: Exclude<HostDeckApplicationShutdownStage, "admission">;
  readonly callback: (deadline: OperationDeadline) => unknown;
  readonly maximumMs: number;
  readonly validate: StageValidator;
}

function parseInput(input: unknown): ParsedShutdownInput {
  const values = readExactDataObject(
    input,
    [
      "approvals",
      "audit",
      "lease",
      "projection",
      "reconnect",
      "resource_budget",
      "storage",
      "subscribers",
      "supervisor",
      "writes"
    ],
    "HostDeck application shutdown input is invalid."
  );
  assertDescriptorSafeResourceBudget(values.resource_budget);
  assertResolvedResourceBudget(values.resource_budget);
  const writes = readPort(values.writes, ["beginDrain", "drain"], "writes");
  const approvals = readPort(values.approvals, ["close"], "approvals");
  const audit = readPort(values.audit, ["barrier"], "audit");
  const lease = readPort(values.lease, ["release"], "lease");
  const projection = readPort(values.projection, ["barrier"], "projection");
  const reconnect = readPort(values.reconnect, ["close"], "reconnect");
  const storage = readPort(values.storage, ["close"], "storage");
  const subscribers = readPort(values.subscribers, ["close"], "subscribers");
  const supervisor = readPort(values.supervisor, ["close"], "supervisor");
  return Object.freeze({
    budget: values.resource_budget as ResourceBudget,
    callbacks: Object.freeze({
      admission: writes.beginDrain as HostDeckApplicationWriteShutdownPort["beginDrain"],
      writes: writes.drain as HostDeckApplicationWriteShutdownPort["drain"],
      approvals: approvals.close as HostDeckApplicationClosePort["close"],
      audit: audit.barrier as HostDeckApplicationAuditBarrierPort["barrier"],
      lease: lease.release as HostDeckApplicationLeaseReleasePort["release"],
      projection: projection.barrier as HostDeckApplicationProjectionBarrierPort["barrier"],
      reconnect: reconnect.close as HostDeckApplicationClosePort["close"],
      storage: storage.close as HostDeckApplicationClosePort["close"],
      subscribers: subscribers.close as HostDeckApplicationClosePort["close"],
      supervisor: supervisor.close as HostDeckApplicationClosePort["close"]
    })
  });
}

function readPort<const TKey extends string>(
  candidate: unknown,
  keys: readonly TKey[],
  label: string
): Readonly<Record<TKey, unknown>> {
  const values = readExactDataObject(
    candidate,
    keys,
    `HostDeck application shutdown ${label} port is invalid.`
  );
  for (const key of keys) {
    if (typeof values[key] !== "function") {
      throw new TypeError(
        `HostDeck application shutdown ${label} port is invalid.`
      );
    }
  }
  return values;
}

function parseAdmissionAcknowledgement(
  candidate: unknown
): HostDeckApplicationAdmissionDrainAcknowledgement {
  const values = readFrozenAcknowledgement(candidate, [
    "active_operations",
    "admission"
  ]);
  if (
    values.admission !== "closed" ||
    !isNonNegativeSafeInteger(values.active_operations)
  ) {
    throw new TypeError("HostDeck admission-drain acknowledgement is invalid.");
  }
  return candidate as HostDeckApplicationAdmissionDrainAcknowledgement;
}

function parseWriteDrainAcknowledgement(
  candidate: unknown
): HostDeckApplicationWriteDrainAcknowledgement {
  const values = readFrozenAcknowledgement(candidate, ["active_operations"]);
  if (values.active_operations !== 0) {
    throw new TypeError("HostDeck write-drain acknowledgement is invalid.");
  }
  return candidate as HostDeckApplicationWriteDrainAcknowledgement;
}

function parseAuditAcknowledgement(
  candidate: unknown
): HostDeckApplicationAuditBarrierAcknowledgement {
  const values = readFrozenAcknowledgement(candidate, [
    "pending_operations",
    "reconciled_operations"
  ]);
  if (
    values.pending_operations !== 0 ||
    !isNonNegativeSafeInteger(values.reconciled_operations)
  ) {
    throw new TypeError("HostDeck audit-barrier acknowledgement is invalid.");
  }
  return candidate as HostDeckApplicationAuditBarrierAcknowledgement;
}

function parseProjectionAcknowledgement(
  candidate: unknown
): HostDeckApplicationProjectionBarrierAcknowledgement {
  const values = readFrozenAcknowledgement(candidate, [
    "last_sequence",
    "pending_notifications"
  ]);
  if (
    values.pending_notifications !== 0 ||
    !isNonNegativeSafeInteger(values.last_sequence)
  ) {
    throw new TypeError(
      "HostDeck projection-barrier acknowledgement is invalid."
    );
  }
  return candidate as HostDeckApplicationProjectionBarrierAcknowledgement;
}

function readFrozenAcknowledgement<const TKey extends string>(
  candidate: unknown,
  keys: readonly TKey[]
): Readonly<Record<TKey, unknown>> {
  const values = readExactDataObject(
    candidate,
    keys,
    "HostDeck application shutdown acknowledgement is invalid."
  );
  if (!Object.isFrozen(candidate)) {
    throw new TypeError(
      "HostDeck application shutdown acknowledgement must be frozen."
    );
  }
  return values;
}

function requireVoidAcknowledgement(candidate: unknown): void {
  if (candidate !== undefined) {
    throw new TypeError(
      "HostDeck application shutdown close port must return only void."
    );
  }
}

function assertOperationDeadline(
  candidate: unknown
): asserts candidate is OperationDeadline {
  let values: Readonly<
    Record<
      | "dispose"
      | "expiresAtMs"
      | "remainingMs"
      | "signal"
      | "startedAtMs"
      | "throwIfAborted"
      | "timeoutMs",
      unknown
    >
  >;
  try {
    values = readExactDataObject(
      candidate,
      [
        "dispose",
        "expiresAtMs",
        "remainingMs",
        "signal",
        "startedAtMs",
        "throwIfAborted",
        "timeoutMs"
      ],
      "HostDeck application shutdown deadline is invalid."
    );
  } catch {
    throw new TypeError("HostDeck application shutdown deadline is invalid.");
  }
  if (
    !Object.isFrozen(candidate) ||
    typeof values.startedAtMs !== "number" ||
    typeof values.expiresAtMs !== "number" ||
    !Number.isFinite(values.startedAtMs) ||
    !Number.isFinite(values.expiresAtMs) ||
    values.expiresAtMs < values.startedAtMs ||
    !isAbortSignal(values.signal) ||
    typeof values.remainingMs !== "function" ||
    typeof values.timeoutMs !== "function" ||
    typeof values.throwIfAborted !== "function" ||
    typeof values.dispose !== "function"
  ) {
    throw new TypeError("HostDeck application shutdown deadline is invalid.");
  }
}

function assertDescriptorSafeResourceBudget(candidate: unknown): void {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("HostDeck application shutdown resource budget is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== resourceBudgetDefinitions.length ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw new TypeError("HostDeck application shutdown resource budget is invalid.");
  }
  for (const definition of resourceBudgetDefinitions) {
    const descriptor = descriptors[definition.key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw new TypeError("HostDeck application shutdown resource budget is invalid.");
    }
  }
}

function observePromiseRejection(candidate: unknown): void {
  if (candidate instanceof Promise) void candidate.catch(() => undefined);
}

function createChildDeadline(
  parent: OperationDeadline,
  maximumMs: number
): OperationDeadline {
  let timeoutMs = 1;
  if (!parent.signal.aborted) {
    try {
      timeoutMs = Math.max(
        1,
        Math.min(maximumMs, Math.ceil(parent.remainingMs()))
      );
    } catch {
      timeoutMs = 1;
    }
  }
  return createOperationDeadline({ timeoutMs, parentSignal: parent.signal });
}

function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause))
    );
    if (signal.aborted) onAbort();
  });
}

function failureReason(
  cause: unknown,
  deadline: OperationDeadline
): HostDeckApplicationShutdownFailureReason {
  if (
    cause instanceof OperationDeadlineExceededError ||
    deadline.signal.reason instanceof OperationDeadlineExceededError
  ) {
    return "timed_out";
  }
  return deadline.signal.aborted ? "aborted" : "failed";
}

function stageFailureMessage(
  reason: HostDeckApplicationShutdownFailureReason
): string {
  switch (reason) {
    case "aborted":
      return "was aborted";
    case "contract_invalid":
      return "returned invalid contract state";
    case "failed":
      return "failed";
    case "timed_out":
      return "timed out";
  }
}

function isNonNegativeSafeInteger(candidate: unknown): candidate is number {
  return Number.isSafeInteger(candidate) && (candidate as number) >= 0;
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  if (!(candidate instanceof AbortSignal)) return false;
  try {
    AbortSignal.any([candidate]);
    return true;
  } catch {
    return false;
  }
}
