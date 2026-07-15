import { isDeepStrictEqual } from "node:util";
import {
  clientOperationIdSchema,
  type SelectedAuditActor,
  type SelectedAuditEventRecord,
  type SelectedAuditTarget,
  selectedAuditActorSchema,
  selectedAuditEventRecordSchema,
  selectedAuditTargetSchema,
  selectedAuditTrailSchema,
  selectedSessionStartAuditEventRecordSchema
} from "@hostdeck/contracts";
import {
  type ErrorCode,
  selectedMutationOperationKinds
} from "@hostdeck/core";
import {
  HostDeckSelectedAuditRepositoryError,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import type {
  SecurityMutationExecutionResult,
  SecurityMutationTransition
} from "./security-mutation-audit-executor.js";
import {
  type ParsedSelectedWriteTransition,
  parseSelectedWriteAuditSummary,
  parseSelectedWriteTransition,
  readExactDataObject
} from "./selected-write-gate-contracts.js";

export const hostDeckSelectedWriteAuditActions = Object.freeze(
  ["session_start", ...selectedMutationOperationKinds] as const
);
export type HostDeckSelectedWriteAuditAction = (typeof hostDeckSelectedWriteAuditActions)[number];

export type HostDeckSelectedWriteAuditState = "none" | "pending" | "terminal" | "unproven";
export type HostDeckSelectedWriteMutationOutcome = "failed" | "incomplete" | "not_started" | "succeeded";
export type HostDeckSelectedWriteAuditStage =
  | "accepted_audit"
  | "input"
  | "response_preparation"
  | "terminal_audit"
  | "transition";
export type HostDeckSelectedWriteAuditExecutorErrorCode =
  | "audit_preflight_failed"
  | "invalid_input"
  | "response_preparation_failed"
  | "terminal_audit_failed"
  | "transition_failed"
  | "transition_result_invalid";

export class HostDeckSelectedWriteAuditExecutorError extends Error {
  constructor(
    readonly code: HostDeckSelectedWriteAuditExecutorErrorCode,
    readonly api_code: ErrorCode,
    readonly stage: HostDeckSelectedWriteAuditStage,
    readonly mutation_outcome: HostDeckSelectedWriteMutationOutcome,
    readonly audit_state: HostDeckSelectedWriteAuditState,
    readonly retry_safe: boolean
  ) {
    super(errorMessages[code]);
    this.name = "HostDeckSelectedWriteAuditExecutorError";
    Object.freeze(this);
  }
}

export interface ExecuteHostDeckSelectedWriteAuditInput<TResponse, TPreparedResponse> {
  readonly operation_id: string;
  readonly actor: SelectedAuditActor;
  readonly action: HostDeckSelectedWriteAuditAction;
  readonly target: SelectedAuditTarget;
  readonly accepted_summary: unknown;
  readonly emergency_lock_on_audit_unavailable: false;
  readonly transition: (
    this: void,
    context: Readonly<{ readonly audit_state: "accepted" }>
  ) => Promise<SecurityMutationTransition<TResponse>> | SecurityMutationTransition<TResponse>;
  readonly prepare_response: (
    this: void,
    response: TResponse
  ) => Promise<TPreparedResponse> | TPreparedResponse;
}

export interface HostDeckSelectedWriteAuditExecutor {
  readonly execute: <TResponse, TPreparedResponse>(
    input: ExecuteHostDeckSelectedWriteAuditInput<TResponse, TPreparedResponse>
  ) => Promise<SecurityMutationExecutionResult<TPreparedResponse>>;
  readonly snapshot: () => HostDeckSelectedWriteAuditSnapshot;
}

export interface CreateHostDeckSelectedWriteAuditExecutorInput {
  readonly repository: SelectedAuditRepository;
  readonly now: () => string;
  readonly create_record_id: () => string;
}

export interface HostDeckSelectedWriteAuditSnapshot {
  readonly accepted_operations: number;
  readonly failed_operations: number;
  readonly incomplete_operations: number;
  readonly response_preparation_failures: number;
  readonly succeeded_operations: number;
  readonly terminal_audit_failures: number;
  readonly transition_contract_failures: number;
}

interface ParsedExecutorOptions {
  readonly repository: Pick<SelectedAuditRepository, "recordAccepted" | "recordTerminal">;
  readonly now: () => string;
  readonly createRecordId: () => string;
}

interface ParsedExecutionInput<TResponse, TPreparedResponse> {
  readonly operationId: SelectedAuditEventRecord["operation_id"];
  readonly actor: SelectedAuditActor;
  readonly action: HostDeckSelectedWriteAuditAction;
  readonly target: SelectedAuditTarget;
  readonly acceptedSummary: SelectedAuditEventRecord["payload_summary"];
  readonly transition: ExecuteHostDeckSelectedWriteAuditInput<TResponse, TPreparedResponse>["transition"];
  readonly prepareResponse: ExecuteHostDeckSelectedWriteAuditInput<TResponse, TPreparedResponse>["prepare_response"];
}

interface MutableCounters {
  acceptedOperations: number;
  failedOperations: number;
  incompleteOperations: number;
  responsePreparationFailures: number;
  succeededOperations: number;
  terminalAuditFailures: number;
  transitionContractFailures: number;
}

const acceptedContext = Object.freeze({ audit_state: "accepted" as const });
const incompleteSummary = Object.freeze({ schema_version: 1 as const });
const acceptedExecutors = new WeakSet<object>();
const errorMessages: Record<HostDeckSelectedWriteAuditExecutorErrorCode, string> = {
  audit_preflight_failed: "Selected-write audit preflight failed before dispatch.",
  invalid_input: "Selected-write audit input is invalid.",
  response_preparation_failed: "Selected write succeeded but response preparation failed.",
  terminal_audit_failed: "Selected-write terminal audit could not be proven.",
  transition_failed: "Selected-write transition ended with an unknown outcome.",
  transition_result_invalid: "Selected-write transition returned an invalid result."
};

export function createHostDeckSelectedWriteAuditExecutor(
  input: CreateHostDeckSelectedWriteAuditExecutorInput
): HostDeckSelectedWriteAuditExecutor {
  const implementation = new DefaultSelectedWriteAuditExecutor(parseOptions(input));
  const executor: HostDeckSelectedWriteAuditExecutor = Object.freeze({
    execute: <TResponse, TPreparedResponse>(
      execution: ExecuteHostDeckSelectedWriteAuditInput<TResponse, TPreparedResponse>
    ) => implementation.execute(execution),
    snapshot: () => implementation.snapshot()
  });
  acceptedExecutors.add(executor);
  return executor;
}

export function assertHostDeckSelectedWriteAuditExecutor(
  candidate: unknown
): asserts candidate is HostDeckSelectedWriteAuditExecutor {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedExecutors.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck selected-write audit executor must be created by createHostDeckSelectedWriteAuditExecutor."
    );
  }
}

class DefaultSelectedWriteAuditExecutor {
  private readonly counters: MutableCounters = {
    acceptedOperations: 0,
    failedOperations: 0,
    incompleteOperations: 0,
    responsePreparationFailures: 0,
    succeededOperations: 0,
    terminalAuditFailures: 0,
    transitionContractFailures: 0
  };

  constructor(private readonly options: ParsedExecutorOptions) {}

  snapshot(): HostDeckSelectedWriteAuditSnapshot {
    return Object.freeze({
      accepted_operations: this.counters.acceptedOperations,
      failed_operations: this.counters.failedOperations,
      incomplete_operations: this.counters.incompleteOperations,
      response_preparation_failures: this.counters.responsePreparationFailures,
      succeeded_operations: this.counters.succeededOperations,
      terminal_audit_failures: this.counters.terminalAuditFailures,
      transition_contract_failures: this.counters.transitionContractFailures
    });
  }

  async execute<TResponse, TPreparedResponse>(
    input: ExecuteHostDeckSelectedWriteAuditInput<TResponse, TPreparedResponse>
  ): Promise<SecurityMutationExecutionResult<TPreparedResponse>> {
    let parsed: ParsedExecutionInput<TResponse, TPreparedResponse>;
    try {
      parsed = parseExecutionInput(input);
    } catch {
      throw executorError("invalid_input", "validation_error", "input", "not_started", "none", true);
    }

    let accepted: SelectedAuditEventRecord;
    try {
      accepted = this.createRecord({
        operation_id: parsed.operationId,
        actor: parsed.actor,
        action: parsed.action,
        target: parsed.target,
        phase: "accepted",
        outcome: "accepted",
        payload_summary: parsed.acceptedSummary,
        error_code: null
      });
    } catch {
      throw executorError("audit_preflight_failed", "internal_error", "accepted_audit", "not_started", "none", false);
    }

    let returnedTrail: unknown;
    try {
      returnedTrail = Reflect.apply(this.options.repository.recordAccepted, undefined, [accepted]);
    } catch (error) {
      throw acceptedAuditError(error);
    }
    try {
      proveAcceptedTrail(returnedTrail, accepted);
    } catch {
      throw acceptedAuditError(undefined, "unproven");
    }
    increment(this.counters, "acceptedOperations");

    let rawTransition: unknown;
    try {
      rawTransition = await Reflect.apply(parsed.transition, undefined, [acceptedContext]);
    } catch {
      return this.finishUnknownTransition(accepted, "transition_failed");
    }

    let transition: ReturnType<typeof parseSelectedWriteTransition<TResponse>>;
    try {
      transition = parseSelectedWriteTransition<TResponse>(parsed.action, rawTransition);
    } catch {
      return this.finishUnknownTransition(accepted, "transition_result_invalid");
    }

    if (transition.outcome !== "succeeded") {
      this.recordTerminal(accepted, transition);
      increment(
        this.counters,
        transition.outcome === "failed" ? "failedOperations" : "incompleteOperations"
      );
      return Object.freeze({ outcome: transition.outcome, error_code: transition.error_code });
    }

    let prepared: TPreparedResponse | undefined;
    let preparationFailed = false;
    try {
      prepared = await Reflect.apply(parsed.prepareResponse, undefined, [transition.response]);
    } catch {
      preparationFailed = true;
      increment(this.counters, "responsePreparationFailures");
    }

    this.recordTerminal(accepted, transition);
    increment(this.counters, "succeededOperations");
    if (preparationFailed) {
      throw executorError(
        "response_preparation_failed",
        "internal_error",
        "response_preparation",
        "succeeded",
        "terminal",
        false
      );
    }
    return Object.freeze({ outcome: "succeeded", response: prepared as TPreparedResponse });
  }

  private finishUnknownTransition(
    accepted: SelectedAuditEventRecord,
    code: "transition_failed" | "transition_result_invalid"
  ): never {
    increment(this.counters, "transitionContractFailures");
    this.recordTerminal(accepted, {
      outcome: "incomplete",
      payload_summary: incompleteSummary,
      error_code: "internal_error"
    });
    increment(this.counters, "incompleteOperations");
    throw executorError(code, "internal_error", "transition", "incomplete", "terminal", false);
  }

  private recordTerminal(
    accepted: SelectedAuditEventRecord,
    transition: ParsedSelectedWriteTransition<unknown>
  ): void {
    let terminal: SelectedAuditEventRecord;
    try {
      terminal = this.createRecord({
        operation_id: accepted.operation_id,
        actor: accepted.actor,
        action: accepted.action as HostDeckSelectedWriteAuditAction,
        target: accepted.target,
        phase: "terminal",
        outcome: transition.outcome,
        payload_summary: transition.payload_summary,
        error_code: transition.outcome === "succeeded" ? null : transition.error_code
      });
      if (Date.parse(terminal.at) < Date.parse(accepted.at)) throw new TypeError();
    } catch {
      this.throwTerminalAuditError(transition.outcome, "pending", "internal_error");
    }

    let returnedTrail: unknown;
    try {
      returnedTrail = Reflect.apply(this.options.repository.recordTerminal, undefined, [terminal]);
    } catch (error) {
      const mapped = mapRepositoryFailure(error);
      this.throwTerminalAuditError(
        transition.outcome,
        terminalRepositoryFailureState(error),
        mapped.apiCode
      );
    }
    try {
      proveTerminalTrail(returnedTrail, accepted, terminal);
    } catch {
      this.throwTerminalAuditError(transition.outcome, "unproven", "internal_error");
    }
  }

  private throwTerminalAuditError(
    mutationOutcome: "failed" | "incomplete" | "succeeded",
    auditState: "pending" | "unproven",
    apiCode: ErrorCode
  ): never {
    increment(this.counters, "terminalAuditFailures");
    throw executorError(
      "terminal_audit_failed",
      apiCode,
      "terminal_audit",
      mutationOutcome,
      auditState,
      false
    );
  }

  private createRecord(
    input: Omit<SelectedAuditEventRecord, "at" | "id" | "action"> & {
      readonly action: HostDeckSelectedWriteAuditAction;
    }
  ): SelectedAuditEventRecord {
    const candidate = {
      ...input,
      id: Reflect.apply(this.options.createRecordId, undefined, []),
      at: Reflect.apply(this.options.now, undefined, [])
    };
    return parseWriteRecord(candidate, input.action);
  }
}

function parseOptions(input: unknown): ParsedExecutorOptions {
  const values = readExactDataObject(
    input,
    ["create_record_id", "now", "repository"],
    "HostDeck selected-write audit executor input is invalid."
  );
  if (typeof values.create_record_id !== "function" || typeof values.now !== "function") {
    throw new TypeError("HostDeck selected-write audit executor clock and id factory are invalid.");
  }
  const repository = readExactDataObject(
    values.repository,
    ["get", "recordAccepted", "recordRejected", "recordTerminal", "require"],
    "HostDeck selected-write audit repository port is invalid."
  );
  if (typeof repository.recordAccepted !== "function" || typeof repository.recordTerminal !== "function") {
    throw new TypeError("HostDeck selected-write audit repository port is invalid.");
  }
  return Object.freeze({
    repository: Object.freeze({
      recordAccepted: repository.recordAccepted as SelectedAuditRepository["recordAccepted"],
      recordTerminal: repository.recordTerminal as SelectedAuditRepository["recordTerminal"]
    }),
    now: values.now as () => string,
    createRecordId: values.create_record_id as () => string
  });
}

function parseExecutionInput<TResponse, TPreparedResponse>(
  input: unknown
): ParsedExecutionInput<TResponse, TPreparedResponse> {
  const values = readExactDataObject(
    input,
    [
      "accepted_summary",
      "action",
      "actor",
      "emergency_lock_on_audit_unavailable",
      "operation_id",
      "prepare_response",
      "target",
      "transition"
    ],
    "HostDeck selected-write audit execution input is invalid."
  );
  if (
    values.emergency_lock_on_audit_unavailable !== false ||
    typeof values.transition !== "function" ||
    typeof values.prepare_response !== "function" ||
    typeof values.action !== "string" ||
    !(hostDeckSelectedWriteAuditActions as readonly string[]).includes(values.action)
  ) {
    throw new TypeError();
  }
  assertSafeDataTree(values.actor);
  assertSafeDataTree(values.target);
  assertSafeDataTree(values.accepted_summary);
  const operationId = clientOperationIdSchema.parse(values.operation_id);
  const actor = selectedAuditActorSchema.parse(values.actor);
  if (actor.type !== "cli" && !(actor.type === "dashboard" && actor.permission === "write")) {
    throw new TypeError();
  }
  const action = values.action as HostDeckSelectedWriteAuditAction;
  const target = selectedAuditTargetSchema.parse(values.target);
  const acceptedSummary = parseSelectedWriteAuditSummary(
    action,
    "accepted",
    "accepted",
    values.accepted_summary
  );
  parseWriteRecord(
    {
      id: "audit:selected-write:validation",
      operation_id: operationId,
      at: "2000-01-01T00:00:00.000Z",
      actor,
      action,
      target,
      phase: "accepted",
      outcome: "accepted",
      payload_summary: acceptedSummary,
      error_code: null
    },
    action
  );
  return Object.freeze({
    operationId,
    actor: deepFreeze(actor),
    action,
    target: deepFreeze(target),
    acceptedSummary,
    transition: values.transition as ParsedExecutionInput<TResponse, TPreparedResponse>["transition"],
    prepareResponse: values.prepare_response as ParsedExecutionInput<TResponse, TPreparedResponse>["prepareResponse"]
  });
}

function parseWriteRecord(
  candidate: unknown,
  action: HostDeckSelectedWriteAuditAction
): SelectedAuditEventRecord {
  assertSafeDataTree(candidate);
  const result =
    action === "session_start"
      ? selectedSessionStartAuditEventRecordSchema.safeParse(candidate)
      : selectedAuditEventRecordSchema.safeParse(candidate);
  if (
    !result.success ||
    result.data.action !== action ||
    result.data.outcome === "rejected"
  ) {
    throw new TypeError();
  }
  parseSelectedWriteAuditSummary(
    action,
    result.data.phase,
    result.data.outcome,
    result.data.payload_summary
  );
  return deepFreeze(result.data);
}

function proveAcceptedTrail(candidate: unknown, accepted: SelectedAuditEventRecord): void {
  const trail = parseWriteTrail(candidate, accepted.action as HostDeckSelectedWriteAuditAction);
  if (
    trail.state !== "pending" ||
    trail.records.length !== 1 ||
    !isDeepStrictEqual(trail.records[0], accepted)
  ) {
    throw new TypeError();
  }
}

function proveTerminalTrail(
  candidate: unknown,
  accepted: SelectedAuditEventRecord,
  terminal: SelectedAuditEventRecord
): void {
  const trail = parseWriteTrail(candidate, accepted.action as HostDeckSelectedWriteAuditAction);
  if (
    trail.state !== "terminal" ||
    trail.records.length !== 2 ||
    !isDeepStrictEqual(trail.records[0], accepted) ||
    !isDeepStrictEqual(trail.records[1], terminal)
  ) {
    throw new TypeError();
  }
}

function parseWriteTrail(candidate: unknown, action: HostDeckSelectedWriteAuditAction) {
  assertSafeDataTree(candidate);
  const parsed = selectedAuditTrailSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError();
  const records = parsed.data.records.map((record) => parseWriteRecord(record, action));
  const coherent = selectedAuditTrailSchema.safeParse({ ...parsed.data, records });
  if (!coherent.success) throw new TypeError();
  return deepFreeze(coherent.data);
}

function acceptedAuditError(
  error: unknown,
  auditState?: HostDeckSelectedWriteAuditState
): HostDeckSelectedWriteAuditExecutorError {
  const mapped = mapRepositoryFailure(error);
  return executorError(
    "audit_preflight_failed",
    mapped.apiCode,
    "accepted_audit",
    "not_started",
    auditState ?? mapped.auditState,
    mapped.retrySafe
  );
}

function mapRepositoryFailure(error: unknown): {
  readonly apiCode: ErrorCode;
  readonly auditState: HostDeckSelectedWriteAuditState;
  readonly retrySafe: boolean;
} {
  if (!(error instanceof HostDeckSelectedAuditRepositoryError)) {
    return { apiCode: "internal_error", auditState: "unproven", retrySafe: false };
  }
  if (error.code === "audit_unavailable" || error.code === "audit_write_failed") {
    return { apiCode: "audit_unavailable", auditState: "none", retrySafe: true };
  }
  if (
    [
      "audit_operation_conflict",
      "audit_operation_exists",
      "audit_operation_terminal",
      "audit_record_exists"
    ].includes(error.code)
  ) {
    return { apiCode: "operation_conflict", auditState: "unproven", retrySafe: false };
  }
  if (error.code === "invalid_audit_operation_id" || error.code === "invalid_audit_record") {
    return { apiCode: "validation_error", auditState: "none", retrySafe: true };
  }
  return { apiCode: "storage_error", auditState: "unproven", retrySafe: false };
}

function terminalRepositoryFailureState(error: unknown): "pending" | "unproven" {
  if (!(error instanceof HostDeckSelectedAuditRepositoryError)) return "unproven";
  return [
    "audit_operation_conflict",
    "audit_record_exists",
    "audit_unavailable",
    "audit_write_failed",
    "invalid_audit_record"
  ].includes(error.code)
    ? "pending"
    : "unproven";
}

function executorError(
  code: HostDeckSelectedWriteAuditExecutorErrorCode,
  apiCode: ErrorCode,
  stage: HostDeckSelectedWriteAuditStage,
  mutationOutcome: HostDeckSelectedWriteMutationOutcome,
  auditState: HostDeckSelectedWriteAuditState,
  retrySafe: boolean
): HostDeckSelectedWriteAuditExecutorError {
  return new HostDeckSelectedWriteAuditExecutorError(
    code,
    apiCode,
    stage,
    mutationOutcome,
    auditState,
    retrySafe
  );
}

function assertSafeDataTree(candidate: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object") return;
    if (depth > 8 || nodes >= 128 || seen.has(value)) throw new TypeError();
    seen.add(value);
    nodes += 1;
    try {
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype || value.length > 256) throw new TypeError();
      } else if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > 512 || keys.some((key) => typeof key !== "string")) throw new TypeError();
      if (Array.isArray(value)) {
        const expected = [...value.keys()].map(String);
        if (
          keys.length !== expected.length + 1 ||
          !Object.hasOwn(descriptors, "length") ||
          expected.some((key) => !Object.hasOwn(descriptors, key))
        ) {
          throw new TypeError();
        }
      }
      for (const key of keys as string[]) {
        if (Array.isArray(value) && key === "length") continue;
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) {
          throw new TypeError();
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      seen.delete(value);
    }
  };
  visit(candidate, 0);
}

function deepFreeze<T>(candidate: T): T {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}

function increment(counters: MutableCounters, key: keyof MutableCounters): void {
  if (counters[key] < Number.MAX_SAFE_INTEGER) counters[key] += 1;
}
