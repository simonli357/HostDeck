import {
  type SelectedAuditActor,
  type SelectedAuditTarget,
  type SelectedSecurityAuditEventRecord,
  selectedSecurityAuditEventRecordSchema
} from "@hostdeck/contracts";
import type { ErrorCode, SelectedSecurityAuditAction } from "@hostdeck/core";
import {
  HostDeckSelectedAuditRepositoryError,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import {
  deepFreeze,
  type InternalExecutorOptions,
  type ParsedExecutionInput,
  type ParsedTransition,
  parseExecutionInput,
  parseExecutorOptions,
  parseRejectionInput,
  parseTransition,
  proveAcceptedTrail,
  proveRejectedTrail,
  proveTerminalTrail,
  recordIdentity,
  type TerminalOutcome,
  validationRecordFor
} from "./security-mutation-audit-validation.js";

export type SecurityMutationAuditState = "deferred" | "none" | "pending" | "terminal" | "unproven";
export type SecurityMutationOutcome = "failed" | "incomplete" | "not_started" | "succeeded";
export type SecurityMutationAuditStage =
  | "accepted_audit"
  | "emergency_lock"
  | "input"
  | "rejected_audit"
  | "response_preparation"
  | "terminal_audit"
  | "transition";

export type SecurityMutationAuditExecutorErrorCode =
  | "audit_preflight_failed"
  | "emergency_lock_audit_deferred"
  | "invalid_input"
  | "rejection_audit_failed"
  | "response_preparation_failed"
  | "terminal_audit_failed"
  | "transition_failed"
  | "transition_result_invalid";

export class HostDeckSecurityMutationAuditExecutorError extends Error {
  constructor(
    readonly code: SecurityMutationAuditExecutorErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly stage: SecurityMutationAuditStage,
    readonly mutation_outcome: SecurityMutationOutcome,
    readonly audit_state: SecurityMutationAuditState,
    readonly retry_safe: boolean
  ) {
    super(message);
    this.name = "HostDeckSecurityMutationAuditExecutorError";
    Object.freeze(this);
  }
}

export interface SecurityMutationAuditContext {
  readonly audit_state: "accepted" | "deferred";
}

export interface SecurityMutationSucceededTransition<TResponse> {
  readonly outcome: "succeeded";
  readonly payload_summary: unknown;
  readonly response: TResponse;
}

export interface SecurityMutationFailedTransition {
  readonly outcome: "failed" | "incomplete";
  readonly error_code: ErrorCode;
  readonly payload_summary: unknown;
}

export type SecurityMutationTransition<TResponse> =
  | SecurityMutationFailedTransition
  | SecurityMutationSucceededTransition<TResponse>;

export interface ExecuteSecurityMutationInput<TResponse, TPreparedResponse> {
  readonly operation_id: string;
  readonly actor: SelectedAuditActor;
  readonly action: SelectedSecurityAuditAction;
  readonly target: SelectedAuditTarget;
  readonly accepted_summary: unknown;
  readonly emergency_lock_on_audit_unavailable: boolean;
  readonly transition: (
    this: void,
    context: SecurityMutationAuditContext
  ) => Promise<SecurityMutationTransition<TResponse>> | SecurityMutationTransition<TResponse>;
  readonly prepare_response: (
    this: void,
    response: TResponse
  ) => Promise<TPreparedResponse> | TPreparedResponse;
}

export interface RejectSecurityMutationInput {
  readonly operation_id: string;
  readonly actor: SelectedAuditActor;
  readonly action: SelectedSecurityAuditAction;
  readonly target: SelectedAuditTarget;
  readonly payload_summary: unknown;
  readonly error_code: ErrorCode;
}

export type SecurityMutationExecutionResult<TPreparedResponse> =
  | Readonly<{ outcome: "failed" | "incomplete"; error_code: ErrorCode }>
  | Readonly<{ outcome: "succeeded"; response: TPreparedResponse }>;

export type SecurityMutationRejectionResult = Readonly<{
  outcome: "rejected";
  error_code: ErrorCode;
}>;

export interface SecurityMutationAuditSnapshot {
  readonly accepted_operations: number;
  readonly emergency_lock_audit_deferrals: number;
  readonly failed_operations: number;
  readonly incomplete_operations: number;
  readonly rejected_operations: number;
  readonly response_preparation_failures: number;
  readonly succeeded_operations: number;
  readonly terminal_audit_failures: number;
  readonly transition_contract_failures: number;
}

export interface SecurityMutationAuditExecutor {
  readonly execute: <TResponse, TPreparedResponse>(
    input: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>
  ) => Promise<SecurityMutationExecutionResult<TPreparedResponse>>;
  readonly reject: (input: RejectSecurityMutationInput) => SecurityMutationRejectionResult;
  readonly snapshot: () => SecurityMutationAuditSnapshot;
}

export interface CreateSecurityMutationAuditExecutorInput {
  readonly repository: SelectedAuditRepository;
  readonly now: () => string;
  readonly create_record_id: () => string;
}

interface MutableCounters {
  acceptedOperations: number;
  emergencyLockAuditDeferrals: number;
  failedOperations: number;
  incompleteOperations: number;
  rejectedOperations: number;
  responsePreparationFailures: number;
  succeededOperations: number;
  terminalAuditFailures: number;
  transitionContractFailures: number;
}

const acceptedAuditContext: SecurityMutationAuditContext = Object.freeze({
  audit_state: "accepted"
});
const deferredAuditContext: SecurityMutationAuditContext = Object.freeze({
  audit_state: "deferred"
});
const fixedIncompleteSummary = Object.freeze({ schema_version: 1 as const });

const executorErrorMessages: Record<SecurityMutationAuditExecutorErrorCode, string> = {
  audit_preflight_failed: "Security mutation audit preflight failed before dispatch.",
  emergency_lock_audit_deferred: "Emergency host lock ran while durable audit was unavailable.",
  invalid_input: "Security mutation audit input is invalid.",
  rejection_audit_failed: "Security mutation rejection could not be durably proven.",
  response_preparation_failed: "Security mutation succeeded but client response preparation failed.",
  terminal_audit_failed: "Security mutation terminal audit could not be durably proven.",
  transition_failed: "Security mutation transition ended with an unknown outcome.",
  transition_result_invalid: "Security mutation transition returned an invalid result."
};

export function createSecurityMutationAuditExecutor(
  input: CreateSecurityMutationAuditExecutorInput
): SecurityMutationAuditExecutor {
  const implementation = new DefaultSecurityMutationAuditExecutor(parseExecutorOptions(input));
  return Object.freeze({
    execute: <TResponse, TPreparedResponse>(
      execution: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>
    ) => implementation.execute(execution),
    reject: (rejection: RejectSecurityMutationInput) => implementation.reject(rejection),
    snapshot: () => implementation.snapshot()
  });
}

class DefaultSecurityMutationAuditExecutor {
  private readonly counters: MutableCounters = {
    acceptedOperations: 0,
    emergencyLockAuditDeferrals: 0,
    failedOperations: 0,
    incompleteOperations: 0,
    rejectedOperations: 0,
    responsePreparationFailures: 0,
    succeededOperations: 0,
    terminalAuditFailures: 0,
    transitionContractFailures: 0
  };

  constructor(private readonly options: InternalExecutorOptions) {}

  snapshot(): SecurityMutationAuditSnapshot {
    return Object.freeze({
      accepted_operations: this.counters.acceptedOperations,
      emergency_lock_audit_deferrals: this.counters.emergencyLockAuditDeferrals,
      failed_operations: this.counters.failedOperations,
      incomplete_operations: this.counters.incompleteOperations,
      rejected_operations: this.counters.rejectedOperations,
      response_preparation_failures: this.counters.responsePreparationFailures,
      succeeded_operations: this.counters.succeededOperations,
      terminal_audit_failures: this.counters.terminalAuditFailures,
      transition_contract_failures: this.counters.transitionContractFailures
    });
  }

  reject(input: RejectSecurityMutationInput): SecurityMutationRejectionResult {
    let parsed: SelectedSecurityAuditEventRecord;
    try {
      parsed = parseRejectionInput(input);
    } catch {
      throw executorError("invalid_input", "validation_error", "input", "not_started", "none", true);
    }

    let record: SelectedSecurityAuditEventRecord;
    try {
      record = this.createRecord({
        ...recordIdentity(parsed),
        phase: "terminal",
        outcome: "rejected",
        payload_summary: parsed.payload_summary,
        error_code: parsed.error_code
      });
    } catch {
      throw executorError(
        "rejection_audit_failed",
        "internal_error",
        "rejected_audit",
        "not_started",
        "none",
        false
      );
    }

    let returnedTrail: unknown;
    try {
      returnedTrail = this.options.repository.recordRejected(record);
    } catch (error) {
      throw rejectionAuditError(error);
    }
    try {
      proveRejectedTrail(returnedTrail, record);
    } catch {
      throw rejectionAuditError(undefined, "unproven");
    }
    increment(this.counters, "rejectedOperations");
    return Object.freeze({ outcome: "rejected", error_code: record.error_code as ErrorCode });
  }

  async execute<TResponse, TPreparedResponse>(
    input: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>
  ): Promise<SecurityMutationExecutionResult<TPreparedResponse>> {
    let parsed: ParsedExecutionInput<TResponse, TPreparedResponse>;
    try {
      parsed = parseExecutionInput(input);
    } catch {
      throw executorError("invalid_input", "validation_error", "input", "not_started", "none", true);
    }

    let accepted: SelectedSecurityAuditEventRecord;
    try {
      accepted = this.createRecord({
        operation_id: parsed.operation_id,
        actor: parsed.actor,
        action: parsed.action,
        target: parsed.target,
        phase: "accepted",
        outcome: "accepted",
        payload_summary: parsed.accepted_summary,
        error_code: null
      });
    } catch {
      throw executorError(
        "audit_preflight_failed",
        "internal_error",
        "accepted_audit",
        "not_started",
        "none",
        false
      );
    }

    let returnedTrail: unknown;
    try {
      returnedTrail = this.options.repository.recordAccepted(accepted);
    } catch (error) {
      if (parsed.emergency_lock_on_audit_unavailable && isEmergencyAuditAvailabilityFailure(error)) {
        return this.executeDeferredEmergencyLock(parsed);
      }
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
      const transition = parsed.transition;
      rawTransition = await transition(acceptedAuditContext);
    } catch {
      return this.finishUnknownTransition(parsed, accepted, "transition_failed");
    }

    let transition: ParsedTransition<TResponse>;
    try {
      transition = parseTransition(rawTransition, accepted);
    } catch {
      return this.finishUnknownTransition(parsed, accepted, "transition_result_invalid");
    }

    if (transition.outcome !== "succeeded") {
      this.recordTerminal(accepted, transition, transition.outcome);
      return Object.freeze({
        outcome: transition.outcome,
        error_code: transition.error_code as ErrorCode
      });
    }

    let prepared: TPreparedResponse | undefined;
    let responsePreparationFailed = false;
    try {
      const prepareResponse = parsed.prepare_response;
      prepared = await prepareResponse(transition.response as TResponse);
    } catch {
      responsePreparationFailed = true;
      increment(this.counters, "responsePreparationFailures");
    }

    this.recordTerminal(accepted, transition, "succeeded");
    if (responsePreparationFailed) {
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

  private async executeDeferredEmergencyLock<TResponse, TPreparedResponse>(
    input: ParsedExecutionInput<TResponse, TPreparedResponse>
  ): Promise<never> {
    increment(this.counters, "emergencyLockAuditDeferrals");
    let mutationOutcome: SecurityMutationOutcome = "incomplete";
    try {
      const transition = input.transition;
      const raw = await transition(deferredAuditContext);
      try {
        mutationOutcome = parseTransition(raw, validationRecordFor(input)).outcome;
      } catch {
        increment(this.counters, "transitionContractFailures");
      }
    } catch {
      increment(this.counters, "transitionContractFailures");
    }
    throw executorError(
      "emergency_lock_audit_deferred",
      "audit_unavailable",
      "emergency_lock",
      mutationOutcome,
      "deferred",
      false
    );
  }

  private async finishUnknownTransition<TResponse, TPreparedResponse>(
    _input: ParsedExecutionInput<TResponse, TPreparedResponse>,
    accepted: SelectedSecurityAuditEventRecord,
    code: "transition_failed" | "transition_result_invalid"
  ): Promise<never> {
    increment(this.counters, "transitionContractFailures");
    this.recordTerminal(
      accepted,
      {
        outcome: "incomplete",
        payload_summary: fixedIncompleteSummary,
        error_code: "internal_error"
      },
      "incomplete"
    );
    throw executorError(code, "internal_error", "transition", "incomplete", "terminal", false);
  }

  private recordTerminal(
    accepted: SelectedSecurityAuditEventRecord,
    transition: Pick<ParsedTransition<unknown>, "error_code" | "outcome" | "payload_summary">,
    mutationOutcome: TerminalOutcome
  ): void {
    let terminal: SelectedSecurityAuditEventRecord;
    try {
      terminal = this.createRecord({
        ...recordIdentity(accepted),
        phase: "terminal",
        outcome: transition.outcome,
        payload_summary: transition.payload_summary,
        error_code: transition.error_code
      });
      if (Date.parse(terminal.at) < Date.parse(accepted.at)) throw new TypeError("Regressing audit clock.");
    } catch {
      this.throwTerminalAuditError(mutationOutcome, "pending", "internal_error");
    }

    let returnedTrail: unknown;
    try {
      returnedTrail = this.options.repository.recordTerminal(terminal);
    } catch (error) {
      const mapped = mapRepositoryFailure(error);
      this.throwTerminalAuditError(mutationOutcome, terminalRepositoryFailureState(error), mapped.apiCode);
    }
    try {
      proveTerminalTrail(returnedTrail, accepted, terminal);
    } catch {
      this.throwTerminalAuditError(mutationOutcome, "unproven", "internal_error");
    }

    if (mutationOutcome === "succeeded") increment(this.counters, "succeededOperations");
    else if (mutationOutcome === "failed") increment(this.counters, "failedOperations");
    else increment(this.counters, "incompleteOperations");
  }

  private throwTerminalAuditError(
    mutationOutcome: TerminalOutcome,
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
    input: Omit<SelectedSecurityAuditEventRecord, "at" | "id">
  ): SelectedSecurityAuditEventRecord {
    const result = selectedSecurityAuditEventRecordSchema.safeParse({
      ...input,
      id: this.options.createRecordId(),
      at: this.options.now()
    });
    if (!result.success) throw new TypeError("Security audit record construction failed.");
    return deepFreeze(result.data);
  }
}

function acceptedAuditError(
  error: unknown,
  auditState?: SecurityMutationAuditState
): HostDeckSecurityMutationAuditExecutorError {
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

function rejectionAuditError(
  error: unknown,
  auditState?: SecurityMutationAuditState
): HostDeckSecurityMutationAuditExecutorError {
  const mapped = mapRepositoryFailure(error);
  return executorError(
    "rejection_audit_failed",
    mapped.apiCode,
    "rejected_audit",
    "not_started",
    auditState ?? mapped.auditState,
    mapped.retrySafe
  );
}

function mapRepositoryFailure(error: unknown): {
  readonly apiCode: ErrorCode;
  readonly auditState: SecurityMutationAuditState;
  readonly retrySafe: boolean;
} {
  if (!(error instanceof HostDeckSelectedAuditRepositoryError)) {
    return { apiCode: "internal_error", auditState: "unproven", retrySafe: false };
  }
  if (["audit_unavailable", "audit_write_failed"].includes(error.code)) {
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

function isEmergencyAuditAvailabilityFailure(error: unknown): boolean {
  return (
    error instanceof HostDeckSelectedAuditRepositoryError &&
    (error.code === "audit_unavailable" || error.code === "audit_write_failed")
  );
}

function executorError(
  code: SecurityMutationAuditExecutorErrorCode,
  apiCode: ErrorCode,
  stage: SecurityMutationAuditStage,
  mutationOutcome: SecurityMutationOutcome,
  auditState: SecurityMutationAuditState,
  retrySafe: boolean
): HostDeckSecurityMutationAuditExecutorError {
  return new HostDeckSecurityMutationAuditExecutorError(
    code,
    apiCode,
    executorErrorMessages[code],
    stage,
    mutationOutcome,
    auditState,
    retrySafe
  );
}

function increment(counters: MutableCounters, key: keyof MutableCounters): void {
  if (counters[key] < Number.MAX_SAFE_INTEGER) counters[key] += 1;
}
