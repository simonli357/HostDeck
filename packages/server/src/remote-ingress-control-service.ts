import { isDeepStrictEqual } from "node:util";
import {
  hostDeckLoopbackOriginSchema,
  projectRemoteIngressPublicState,
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  type RemoteIngressObservationSnapshot,
  type RemoteIngressPublicState,
  type RemoteIngressState,
  type RemoteServeDescriptor,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  remoteIngressAdmissionProofSchema,
  remoteIngressPublicStateSchema
} from "@hostdeck/contracts";
import type { ErrorCode, RemoteIngressUnavailableReason } from "@hostdeck/core";
import {
  assertRemoteIngressAdmissionProofRepository,
  assertRemoteIngressStateRepository,
  HostDeckRemoteIngressStateRepositoryError,
  type RemoteIngressAdmissionProofRepository,
  type RemoteIngressStateRepository
} from "@hostdeck/storage";
import {
  acceptedSummary,
  candidateEnableReason,
  configuredEnableReason,
  disabledCleanupState,
  errorCodeForReason,
  failedEnableBeforeManager,
  incompleteDisable,
  isDurablyReady,
  isVerifiedAbsent,
  materiallyDifferent,
  normalizedManagerReason,
  observationFromState,
  observationInput,
  operationFailureForReason, 
  type ParsedManagerResult,
  parseManagerResult,
  parseObservation,
  selectedState,
  serveDescriptor,
  stateFromObservation,
  terminalSummary,
  unconfiguredDisabledState
} from "./remote-ingress-control-model.js";
import {
  assertHostDeckSecurityMutationAuditExecutor,
  type ExecuteSecurityMutationInput,
  HostDeckSecurityMutationAuditExecutorError,
  type SecurityMutationAuditExecutor,
  type SecurityMutationExecutionResult
} from "./security-mutation-audit-executor.js";
import type { TailscaleObserver } from "./tailscale-observer.js";
import {
  HostDeckTailscaleServeManagerError,
  type TailscaleServeManager
} from "./tailscale-serve-manager.js";
import type { TailscaleServeRemoteAdmissionSnapshot } from "./tailscale-serve-proxy-trust.js";

export type RemoteIngressControlOperation = "disable" | "enable" | "status";

export type RemoteIngressControlServiceErrorCode =
  | "audit_unavailable"
  | "clock_invalid"
  | "contract_violation"
  | "invalid_input"
  | "mutation_failed"
  | "mutation_incomplete"
  | "observation_unavailable"
  | "operation_busy"
  | "proof_unavailable"
  | "selection_conflict"
  | "storage_unavailable";

export class HostDeckRemoteIngressControlServiceError extends Error {
  constructor(
    readonly code: RemoteIngressControlServiceErrorCode,
    readonly api_code: ErrorCode,
    readonly retryable: boolean,
    message: string
  ) {
    super(message);
    this.name = "HostDeckRemoteIngressControlServiceError";
    Object.freeze(this);
  }
}

export interface RemoteIngressControlServiceSnapshot {
  readonly active_operation: RemoteIngressControlOperation | null;
  readonly admission_open_reads: number;
  readonly admission_reads: number;
  readonly audit_failures: number;
  readonly busy_rejections: number;
  readonly clock_failures: number;
  readonly disable_attempts: number;
  readonly enable_attempts: number;
  readonly lease_renewals: number;
  readonly manager_calls: number;
  readonly mutation_failures: number;
  readonly observation_failures: number;
  readonly proof_failures: number;
  readonly status_reads: number;
  readonly storage_failures: number;
}

export interface RemoteIngressControlService {
  readonly disable: (
    request: RemoteDisableRequest
  ) => Promise<RemoteIngressPublicState>;
  readonly enable: (
    request: RemoteEnableRequest
  ) => Promise<RemoteIngressPublicState>;
  readonly readAdmission: () => TailscaleServeRemoteAdmissionSnapshot;
  readonly readStatus: () => Promise<RemoteIngressPublicState>;
  readonly snapshot: () => RemoteIngressControlServiceSnapshot;
}

export interface CreateRemoteIngressControlServiceOptions {
  readonly admissionProofs: RemoteIngressAdmissionProofRepository;
  readonly audit: SecurityMutationAuditExecutor;
  readonly localOrigin: string;
  readonly manager: TailscaleServeManager;
  readonly monotonicNow: () => number;
  readonly now: () => Date;
  readonly observer: TailscaleObserver;
  readonly states: RemoteIngressStateRepository;
}

interface MutableCounters {
  admissionOpenReads: number;
  admissionReads: number;
  auditFailures: number;
  busyRejections: number;
  clockFailures: number;
  disableAttempts: number;
  enableAttempts: number;
  leaseRenewals: number;
  managerCalls: number;
  mutationFailures: number;
  observationFailures: number;
  proofFailures: number;
  statusReads: number;
  storageFailures: number;
}

interface ObservationLease {
  readonly external_origin: string;
  readonly generation: number;
  readonly valid_until: number;
}

interface ActiveOperation {
  readonly kind: RemoteIngressControlOperation;
  readonly promise: Promise<RemoteIngressPublicState>;
}

interface EnablePreflight {
  readonly expected_profile_key: string;
  readonly expected_serve: RemoteServeDescriptor;
  readonly observation: RemoteIngressObservationSnapshot;
  readonly state: RemoteIngressState | null;
}

interface EnableTransitionResponse {
  readonly state: RemoteIngressState;
}

interface DisableTransitionResponse {
  readonly state: RemoteIngressState;
}

const optionKeys = [
  "admissionProofs",
  "audit",
  "localOrigin",
  "manager",
  "monotonicNow",
  "now",
  "observer",
  "states"
] as const;
const acceptedServices = new WeakSet<object>();
const maxCounter = Number.MAX_SAFE_INTEGER;

const cliActor = Object.freeze({
  type: "cli" as const,
  device_id: null,
  permission: "local_admin" as const,
  origin: null
});
const hostTarget = Object.freeze({
  type: "host" as const,
  host_id: "local_host" as const
});
const closedAdmission: TailscaleServeRemoteAdmissionSnapshot = Object.freeze({
  admission: "closed",
  external_origin: null,
  generation: 0
});

export function createRemoteIngressControlService(
  rawOptions: CreateRemoteIngressControlServiceOptions
): RemoteIngressControlService {
  const options = readExactDataObject(rawOptions, optionKeys);
  assertRemoteIngressAdmissionProofRepository(options.admissionProofs);
  assertHostDeckSecurityMutationAuditExecutor(options.audit);
  assertRemoteIngressStateRepository(options.states);
  assertObserver(options.observer);
  assertManager(options.manager);
  if (typeof options.now !== "function" || typeof options.monotonicNow !== "function") {
    throw new TypeError("Remote ingress control service clocks are invalid.");
  }
  const localOriginResult = hostDeckLoopbackOriginSchema.safeParse(options.localOrigin);
  if (!localOriginResult.success) {
    throw new TypeError("Remote ingress control service loopback origin is invalid.");
  }

  const admissionProofs = options.admissionProofs;
  const audit = options.audit;
  const localOrigin = localOriginResult.data;
  const manager = options.manager;
  const monotonicNow = options.monotonicNow as () => number;
  const now = options.now as () => Date;
  const observer = options.observer;
  const states = options.states;
  const counters: MutableCounters = {
    admissionOpenReads: 0,
    admissionReads: 0,
    auditFailures: 0,
    busyRejections: 0,
    clockFailures: 0,
    disableAttempts: 0,
    enableAttempts: 0,
    leaseRenewals: 0,
    managerCalls: 0,
    mutationFailures: 0,
    observationFailures: 0,
    proofFailures: 0,
    statusReads: 0,
    storageFailures: 0
  };
  let active: ActiveOperation | null = null;
  let lease: ObservationLease | null = null;
  let lastMonotonicTime: number | null = null;
  let lastWallTime: number | null = null;

  function clearLease(): void {
    lease = null;
  }

  function readMonotonicTime(): number {
    let value: unknown;
    try {
      value = monotonicNow();
    } catch {
      counters.clockFailures = increment(counters.clockFailures);
      throw serviceError("clock_invalid");
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (lastMonotonicTime !== null && value < lastMonotonicTime)
    ) {
      counters.clockFailures = increment(counters.clockFailures);
      throw serviceError("clock_invalid");
    }
    lastMonotonicTime = value;
    return value;
  }

  function readWallTimestamp(minimums: readonly (string | null)[] = []): string {
    let value: unknown;
    try {
      value = now();
    } catch {
      counters.clockFailures = increment(counters.clockFailures);
      throw serviceError("clock_invalid");
    }
    if (!(value instanceof Date)) {
      counters.clockFailures = increment(counters.clockFailures);
      throw serviceError("clock_invalid");
    }
    const timestamp = Date.prototype.getTime.call(value);
    if (
      !Number.isFinite(timestamp) ||
      (lastWallTime !== null && timestamp < lastWallTime) ||
      minimums.some(
        (minimum) => minimum !== null && timestamp < Date.parse(minimum)
      )
    ) {
      counters.clockFailures = increment(counters.clockFailures);
      throw serviceError("clock_invalid");
    }
    lastWallTime = timestamp;
    return new Date(timestamp).toISOString();
  }

  function renewLease(state: RemoteIngressState): void {
    if (!isDurablyReady(state) || state.external_origin === null) {
      clearLease();
      throw serviceError("contract_violation");
    }
    const observedAt = readMonotonicTime();
    const validUntil = observedAt + observer.poll_interval_ms;
    if (!Number.isFinite(validUntil) || validUntil <= observedAt) {
      counters.clockFailures = increment(counters.clockFailures);
      clearLease();
      throw serviceError("clock_invalid");
    }
    lease = Object.freeze({
      external_origin: state.external_origin,
      generation: state.generation,
      valid_until: validUntil
    });
    counters.leaseRenewals = increment(counters.leaseRenewals);
  }

  function readState(): RemoteIngressState | null {
    try {
      return states.read();
    } catch {
      counters.storageFailures = increment(counters.storageFailures);
      throw serviceError("storage_unavailable");
    }
  }

  function writeState(
    before: RemoteIngressState | null,
    after: RemoteIngressState
  ): RemoteIngressState {
    try {
      return states.compareAndSet({
        expected_generation: before?.generation ?? null,
        state: after
      }).after;
    } catch (error) {
      counters.storageFailures = increment(counters.storageFailures);
      if (
        error instanceof HostDeckRemoteIngressStateRepositoryError &&
        (error.code === "remote_ingress_conflict" ||
          error.code === "remote_ingress_selection_conflict" ||
          error.code === "remote_ingress_generation_exhausted" ||
          error.code === "remote_ingress_time_conflict")
      ) {
        throw serviceError("selection_conflict");
      }
      throw serviceError("storage_unavailable");
    }
  }

  function readAdmission(): TailscaleServeRemoteAdmissionSnapshot {
    counters.admissionReads = increment(counters.admissionReads);
    let generation = 0;
    try {
      const stateBefore = states.read();
      generation = stateBefore?.generation ?? 0;
      const proofBefore = admissionProofs.read();
      const stateAfter = states.read();
      const proofAfter = admissionProofs.read();
      generation = stateAfter?.generation ?? generation;
      if (
        stateBefore === null ||
        stateAfter === null ||
        proofBefore === null ||
        proofAfter === null ||
        !isDeepStrictEqual(stateBefore, stateAfter) ||
        !isDeepStrictEqual(proofBefore, proofAfter) ||
        !isDurablyReady(stateAfter) ||
        stateAfter.external_origin === null ||
        proofAfter.generation !== stateAfter.generation ||
        lease === null ||
        lease.generation !== stateAfter.generation ||
        lease.external_origin !== stateAfter.external_origin ||
        readMonotonicTime() >= lease.valid_until
      ) {
        if (lease !== null && lease.generation !== stateAfter?.generation) {
          clearLease();
        }
        return closedSnapshot(generation);
      }
      counters.admissionOpenReads = increment(counters.admissionOpenReads);
      return Object.freeze({
        admission: "open",
        external_origin: stateAfter.external_origin,
        generation: stateAfter.generation
      });
    } catch {
      clearLease();
      return closedSnapshot(generation);
    }
  }

  async function performStatus(): Promise<RemoteIngressPublicState> {
    counters.statusReads = increment(counters.statusReads);
    let state = readState();
    if (state === null) {
      clearLease();
      return disabledPublicState();
    }
    const selected = selectedState(state);
    if (selected === null) {
      clearLease();
      return effectivePublicState(state);
    }

    let observation: RemoteIngressObservationSnapshot;
    try {
      observation = parseObservation(
        await observer.observeConfigured(observationInput(selected))
      );
    } catch {
      counters.observationFailures = increment(counters.observationFailures);
      clearLease();
      throw serviceError("observation_unavailable");
    }
    const candidate = stateFromObservation({
      generation: nextGeneration(state),
      intent: state.intent,
      observation,
      expectedServe: selected.expected_serve,
      operationFailure:
        state.intent === "disabled" &&
        state.operation_failure === "cleanup_incomplete"
          ? "cleanup_incomplete"
          : state.intent === "enabled"
            ? observation.failure
            : null,
      observationOverride: null,
      updatedAt: readWallTimestamp([state.updated_at, observation.observed_at])
    });
    if (materiallyDifferent(state, candidate)) {
      clearLease();
      state = writeState(state, candidate);
    }
    await establishReadyProofAndLease(state, true);
    return effectivePublicState(state);
  }

  async function performEnable(
    request: RemoteEnableRequest
  ): Promise<RemoteIngressPublicState> {
    counters.enableAttempts = increment(counters.enableAttempts);
    const preflight = await prepareEnable(request);
    clearLease();
    const result = await executeAudit<
      EnableTransitionResponse,
      RemoteIngressPublicState
    >({
      operation_id: request.operation_id,
      actor: cliActor,
      action: "remote_enable",
      target: hostTarget,
      accepted_summary: acceptedSummary(
        "remote_enable",
        preflight.observation
      ),
      emergency_lock_on_audit_unavailable: false,
      transition: async () => executeEnableTransition(preflight),
      prepare_response: ({ state }) => projectRemoteIngressPublicState(state)
    });
    const response = requireSuccessfulAuditResult(result);
    const durable = readState();
    if (
      durable === null ||
      durable.generation !== response.generation ||
      !isDurablyReady(durable)
    ) {
      counters.proofFailures = increment(counters.proofFailures);
      throw serviceError("proof_unavailable");
    }
    try {
      admissionProofs.prove(remoteIngressAdmissionProofSchema.parse({
        schema_version: 1,
        operation_id: request.operation_id,
        generation: durable.generation,
        proven_at: readWallTimestamp([durable.updated_at])
      }));
    } catch {
      counters.proofFailures = increment(counters.proofFailures);
      clearLease();
      throw serviceError("proof_unavailable");
    }
    try {
      renewLease(durable);
    } catch {
      clearLease();
      throw serviceError("proof_unavailable");
    }
    const admission = readAdmission();
    if (
      admission.admission !== "open" ||
      admission.generation !== durable.generation ||
      admission.external_origin !== durable.external_origin
    ) {
      counters.proofFailures = increment(counters.proofFailures);
      clearLease();
      throw serviceError("proof_unavailable");
    }
    return response;
  }

  async function prepareEnable(
    request: RemoteEnableRequest
  ): Promise<EnablePreflight> {
    let state = readState();
    if (state === null) {
      let observation: RemoteIngressObservationSnapshot;
      try {
        observation = parseObservation(await observer.observeCandidate());
      } catch {
        counters.observationFailures = increment(counters.observationFailures);
        rejectEnable(request, null, "observation_failed");
      }
      const reason = candidateEnableReason(observation);
      if (reason !== null) rejectEnable(request, observation, reason);
      const expectedProfileKey = observation.profile.comparison.expected_profile_key;
      if (expectedProfileKey === null || observation.external_origin === null) {
        rejectEnable(request, observation, "observation_failed");
      }
      return Object.freeze({
        expected_profile_key: expectedProfileKey,
        expected_serve: serveDescriptor(observation.external_origin, localOrigin),
        observation,
        state: null
      });
    }

    const selected = selectedState(state);
    if (selected === null) {
      let observation: RemoteIngressObservationSnapshot;
      try {
        observation = parseObservation(await observer.observeCandidate());
      } catch {
        counters.observationFailures = increment(counters.observationFailures);
        rejectEnable(request, null, "observation_failed");
      }
      const reason = candidateEnableReason(observation);
      if (reason !== null) rejectEnable(request, observation, reason);
      const expectedProfileKey = observation.profile.comparison.expected_profile_key;
      if (expectedProfileKey === null || observation.external_origin === null) {
        rejectEnable(request, observation, "observation_failed");
      }
      return Object.freeze({
        expected_profile_key: expectedProfileKey,
        expected_serve: serveDescriptor(observation.external_origin, localOrigin),
        observation,
        state
      });
    }

    let observation: RemoteIngressObservationSnapshot;
    try {
      observation = parseObservation(
        await observer.observeConfigured(observationInput(selected))
      );
    } catch {
      counters.observationFailures = increment(counters.observationFailures);
      clearLease();
      rejectEnable(request, null, "observation_failed");
    }
    const observedState = stateFromObservation({
      generation: nextGeneration(state),
      intent: state.intent,
      observation,
      expectedServe: selected.expected_serve,
      operationFailure:
        state.intent === "disabled" &&
        state.operation_failure === "cleanup_incomplete"
          ? "cleanup_incomplete"
          : state.intent === "enabled"
            ? observation.failure
            : null,
      observationOverride: null,
      updatedAt: readWallTimestamp([state.updated_at, observation.observed_at])
    });
    if (materiallyDifferent(state, observedState)) {
      clearLease();
      state = writeState(state, observedState);
    }
    const reason = configuredEnableReason(
      observation,
      selected.expected_profile_key,
      selected.expected_serve,
      state.operation_failure
    );
    if (reason !== null) rejectEnable(request, observation, reason);
    return Object.freeze({
      expected_profile_key: selected.expected_profile_key,
      expected_serve: selected.expected_serve,
      observation,
      state
    });
  }

  function rejectEnable(
    request: RemoteEnableRequest,
    observation: RemoteIngressObservationSnapshot | null,
    reason: RemoteIngressUnavailableReason
  ): never {
    const errorCode = errorCodeForReason(reason);
    try {
      audit.reject({
        operation_id: request.operation_id,
        actor: cliActor,
        action: "remote_enable",
        target: hostTarget,
        payload_summary: terminalSummary({
          action: "remote_enable",
          observation,
          outcome: "rejected",
          admission: "closed",
          intentPersisted: false,
          serveResult: "not_attempted",
          reason
        }),
        error_code: errorCode
      });
    } catch (error) {
      counters.auditFailures = increment(counters.auditFailures);
      throw auditServiceError(error);
    }
    throw serviceError("selection_conflict", errorCode);
  }

  async function executeEnableTransition(
    preflight: EnablePreflight
  ): Promise<
    | Readonly<{
        outcome: "failed" | "incomplete";
        error_code: ErrorCode;
        payload_summary: unknown;
      }>
    | Readonly<{
        outcome: "succeeded";
        payload_summary: unknown;
        response: EnableTransitionResponse;
      }>
  > {
    let intentState: RemoteIngressState;
    try {
      const current = readState();
      if (
        (preflight.state === null && current !== null) ||
        (preflight.state !== null &&
          (current === null || current.generation !== preflight.state.generation))
      ) {
        throw serviceError("selection_conflict");
      }
      const updatedAt = readWallTimestamp([
        current?.updated_at ?? null,
        preflight.observation.observed_at
      ]);
      intentState = writeState(
        current,
        stateFromObservation({
          generation: current === null ? 1 : nextGeneration(current),
          intent: "enabled",
          observation: preflight.observation,
          expectedServe: preflight.expected_serve,
          operationFailure: null,
          observationOverride: null,
          updatedAt
        })
      );
    } catch (error) {
      return failedEnableBeforeManager(
        preflight.observation,
        error instanceof HostDeckRemoteIngressControlServiceError
          ? error.api_code
          : "internal_error"
      );
    }

    let managerResult: ParsedManagerResult;
    counters.managerCalls = increment(counters.managerCalls);
    try {
      managerResult = parseManagerResult(
        await manager.enable({
          expected_profile_key: preflight.expected_profile_key,
          expected_serve: preflight.expected_serve
        }),
        "enable"
      );
    } catch (error) {
      const knownNotStarted =
        error instanceof HostDeckTailscaleServeManagerError &&
        error.mutation_outcome === "not_started";
      const outcome = knownNotStarted ? "failed" : "incomplete";
      const serveResult = knownNotStarted ? "not_attempted" : "unknown";
      const reason: RemoteIngressUnavailableReason = "observation_failed";
      const errorCode: ErrorCode = knownNotStarted
        ? "runtime_unavailable"
        : "internal_error";
      return Object.freeze({
        outcome,
        error_code: errorCode,
        payload_summary: terminalSummary({
          action: "remote_enable",
          observation: preflight.observation,
          outcome,
          admission: "closed",
          intentPersisted: true,
          serveResult,
          reason
        })
      });
    }

    if (
      managerResult.outcome === "succeeded" &&
      managerResult.after !== null &&
      configuredEnableReason(
        managerResult.after,
        preflight.expected_profile_key,
        preflight.expected_serve,
        null
      ) === null &&
      managerResult.after.serve === "exact"
    ) {
      try {
        const ready = writeState(
          intentState,
          stateFromObservation({
            generation: nextGeneration(intentState),
            intent: "enabled",
            observation: managerResult.after,
            expectedServe: preflight.expected_serve,
            operationFailure: null,
            observationOverride: null,
            updatedAt: readWallTimestamp([
              intentState.updated_at,
              managerResult.after.observed_at
            ])
          })
        );
        if (!isDurablyReady(ready)) throw serviceError("contract_violation");
        return Object.freeze({
          outcome: "succeeded",
          response: Object.freeze({ state: ready }),
          payload_summary: terminalSummary({
            action: "remote_enable",
            observation: managerResult.after,
            outcome: "succeeded",
            admission: "open",
            intentPersisted: true,
            serveResult: managerResult.serve_result,
            reason: null
          })
        });
      } catch {
        return Object.freeze({
          outcome: "incomplete",
          error_code: "storage_error",
          payload_summary: terminalSummary({
            action: "remote_enable",
            observation: managerResult.after,
            outcome: "incomplete",
            admission: "closed",
            intentPersisted: true,
            serveResult: "unknown",
            reason: "observation_failed"
          })
        });
      }
    }

    const outcome =
      managerResult.outcome === "incomplete" ? "incomplete" : "failed";
    const reason = normalizedManagerReason(managerResult.reason);
    try {
      const evidence = managerResult.after ?? managerResult.before;
      const failedState = stateFromObservation({
        generation: nextGeneration(intentState),
        intent: "enabled",
        observation: evidence,
        expectedServe: preflight.expected_serve,
        operationFailure: operationFailureForReason(reason, evidence),
        observationOverride:
          managerResult.outcome === "incomplete" && managerResult.after === null
            ? "failed"
            : null,
        updatedAt: readWallTimestamp([
          intentState.updated_at,
          evidence.observed_at
        ])
      });
      writeState(intentState, failedState);
    } catch {
      return Object.freeze({
        outcome: "incomplete",
        error_code: "storage_error",
        payload_summary: terminalSummary({
          action: "remote_enable",
          observation: managerResult.after ?? managerResult.before,
          outcome: "incomplete",
          admission: "closed",
          intentPersisted: true,
          serveResult: "unknown",
          reason: "observation_failed"
        })
      });
    }
    return Object.freeze({
      outcome,
      error_code: errorCodeForReason(reason),
      payload_summary: terminalSummary({
        action: "remote_enable",
        observation: managerResult.after ?? managerResult.before,
        outcome,
        admission: "closed",
        intentPersisted: true,
        serveResult: managerResult.serve_result,
        reason
      })
    });
  }

  async function performDisable(
    request: RemoteDisableRequest
  ): Promise<RemoteIngressPublicState> {
    counters.disableAttempts = increment(counters.disableAttempts);
    clearLease();
    const initial = readState();
    const result = await executeAudit<
      DisableTransitionResponse,
      RemoteIngressPublicState
    >({
      operation_id: request.operation_id,
      actor: cliActor,
      action: "remote_disable",
      target: hostTarget,
      accepted_summary: acceptedSummary(
        "remote_disable",
        initial === null ? null : observationFromState(initial)
      ),
      emergency_lock_on_audit_unavailable: false,
      transition: async () => executeDisableTransition(initial),
      prepare_response: ({ state }) => projectRemoteIngressPublicState(state)
    });
    return requireSuccessfulAuditResult(result);
  }

  async function executeDisableTransition(
    initial: RemoteIngressState | null
  ): Promise<
    | Readonly<{
        outcome: "incomplete";
        error_code: ErrorCode;
        payload_summary: unknown;
      }>
    | Readonly<{
        outcome: "succeeded";
        payload_summary: unknown;
        response: DisableTransitionResponse;
      }>
  > {
    const selected = initial === null ? null : selectedState(initial);
    if (selected === null) {
      try {
        const current = readState();
        if (
          (initial === null && current !== null) ||
          (initial !== null &&
            (current === null || current.generation !== initial.generation))
        ) {
          throw serviceError("selection_conflict");
        }
        const disabled = writeState(
          current,
          unconfiguredDisabledState(
            current === null ? 1 : nextGeneration(current),
            readWallTimestamp([current?.updated_at ?? null])
          )
        );
        return Object.freeze({
          outcome: "succeeded",
          response: Object.freeze({ state: disabled }),
          payload_summary: terminalSummary({
            action: "remote_disable",
            observation: null,
            outcome: "succeeded",
            admission: "closed",
            intentPersisted: true,
            serveResult: "unchanged",
            reason: null
          })
        });
      } catch {
        return incompleteDisable(null, false, "storage_error");
      }
    }

    let latched: RemoteIngressState;
    try {
      const current = readState();
      if (current === null || current.generation !== initial?.generation) {
        throw serviceError("selection_conflict");
      }
      latched = writeState(
        current,
        disabledCleanupState(
          current,
          nextGeneration(current),
          readWallTimestamp([current.updated_at])
        )
      );
    } catch {
      return incompleteDisable(
        observationFromState(initial as RemoteIngressState),
        false,
        "storage_error"
      );
    }

    let managerResult: ParsedManagerResult;
    counters.managerCalls = increment(counters.managerCalls);
    try {
      managerResult = parseManagerResult(
        await manager.disable({
          expected_profile_key: selected.expected_profile_key,
          expected_serve: selected.expected_serve
        }),
        "disable"
      );
    } catch {
      return incompleteDisable(
        observationFromState(latched),
        true,
        "runtime_unavailable"
      );
    }

    if (
      managerResult.outcome === "succeeded" &&
      managerResult.after !== null &&
      isVerifiedAbsent(
        managerResult.after,
        selected.expected_profile_key,
        selected.expected_serve
      )
    ) {
      try {
        const clean = writeState(
          latched,
          unconfiguredDisabledState(
            nextGeneration(latched),
            readWallTimestamp([
              latched.updated_at,
              managerResult.after.observed_at
            ]),
            managerResult.after.observed_at
          )
        );
        return Object.freeze({
          outcome: "succeeded",
          response: Object.freeze({ state: clean }),
          payload_summary: terminalSummary({
            action: "remote_disable",
            observation: managerResult.after,
            outcome: "succeeded",
            admission: "closed",
            intentPersisted: true,
            serveResult: managerResult.serve_result,
            reason: null
          })
        });
      } catch {
        return incompleteDisable(managerResult.after, true, "storage_error");
      }
    }

    const evidence = managerResult.after ?? managerResult.before;
    return incompleteDisable(
      evidence,
      true,
      errorCodeForReason(normalizedManagerReason(managerResult.reason))
    );
  }

  async function establishReadyProofAndLease(
    state: RemoteIngressState,
    allowCarry: boolean
  ): Promise<boolean> {
    if (!isDurablyReady(state)) {
      clearLease();
      return false;
    }
    try {
      let proof = admissionProofs.read();
      if (proof === null || proof.generation > state.generation) {
        clearLease();
        return false;
      }
      if (proof.generation < state.generation) {
        if (!allowCarry) {
          clearLease();
          return false;
        }
        proof = admissionProofs.prove(remoteIngressAdmissionProofSchema.parse({
          schema_version: 1,
          operation_id: proof.operation_id,
          generation: state.generation,
          proven_at: readWallTimestamp([state.updated_at, proof.proven_at])
        })).after;
      }
      if (proof.generation !== state.generation) {
        clearLease();
        return false;
      }
      renewLease(state);
      return true;
    } catch {
      counters.proofFailures = increment(counters.proofFailures);
      clearLease();
      return false;
    }
  }

  function effectivePublicState(
    state: RemoteIngressState
  ): RemoteIngressPublicState {
    if (state.availability !== "ready") {
      return projectRemoteIngressPublicState(state);
    }
    const admission = readAdmission();
    if (
      admission.admission === "open" &&
      admission.generation === state.generation &&
      admission.external_origin === state.external_origin
    ) {
      return projectRemoteIngressPublicState(state);
    }
    return remoteIngressPublicStateSchema.parse({
      generation: state.generation,
      availability: "unavailable",
      reason: "observation_failed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: state.observed_at
    });
  }

  function startStatus(): Promise<RemoteIngressPublicState> {
    if (active !== null) {
      if (active.kind === "status") return active.promise;
      return busyRejection();
    }
    return startOperation("status", performStatus);
  }

  function startMutation(
    kind: "disable" | "enable",
    operation: () => Promise<RemoteIngressPublicState>
  ): Promise<RemoteIngressPublicState> {
    if (active !== null) return busyRejection();
    return startOperation(kind, operation);
  }

  function startOperation(
    kind: RemoteIngressControlOperation,
    operation: () => Promise<RemoteIngressPublicState>
  ): Promise<RemoteIngressPublicState> {
    const promise = operation().catch((error: unknown) => {
      clearLease();
      if (kind !== "status") {
        counters.mutationFailures = increment(counters.mutationFailures);
      }
      if (error instanceof HostDeckRemoteIngressControlServiceError) throw error;
      throw serviceError("contract_violation");
    });
    active = Object.freeze({ kind, promise });
    void promise
      .finally(() => {
        if (active?.promise === promise) active = null;
      })
      .catch(() => undefined);
    return promise;
  }

  function busyRejection(): Promise<never> {
    counters.busyRejections = increment(counters.busyRejections);
    return Promise.reject(serviceError("operation_busy"));
  }

  const service: RemoteIngressControlService = Object.freeze({
    disable(rawRequest: RemoteDisableRequest) {
      const parsed = remoteDisableRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return Promise.reject(serviceError("invalid_input"));
      return startMutation("disable", () => performDisable(parsed.data));
    },
    enable(rawRequest: RemoteEnableRequest) {
      const parsed = remoteEnableRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return Promise.reject(serviceError("invalid_input"));
      return startMutation("enable", () => performEnable(parsed.data));
    },
    readAdmission,
    readStatus: startStatus,
    snapshot() {
      return Object.freeze({
        active_operation: active?.kind ?? null,
        admission_open_reads: counters.admissionOpenReads,
        admission_reads: counters.admissionReads,
        audit_failures: counters.auditFailures,
        busy_rejections: counters.busyRejections,
        clock_failures: counters.clockFailures,
        disable_attempts: counters.disableAttempts,
        enable_attempts: counters.enableAttempts,
        lease_renewals: counters.leaseRenewals,
        manager_calls: counters.managerCalls,
        mutation_failures: counters.mutationFailures,
        observation_failures: counters.observationFailures,
        proof_failures: counters.proofFailures,
        status_reads: counters.statusReads,
        storage_failures: counters.storageFailures
      });
    }
  });
  acceptedServices.add(service);
  return service;

  async function executeAudit<TResponse, TPreparedResponse>(
    input: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>
  ): Promise<SecurityMutationExecutionResult<TPreparedResponse>> {
    try {
      return await audit.execute(input);
    } catch (error) {
      counters.auditFailures = increment(counters.auditFailures);
      throw auditServiceError(error);
    }
  }
}

export function assertRemoteIngressControlService(
  candidate: unknown
): asserts candidate is RemoteIngressControlService {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedServices.has(candidate)
  ) {
    throw new TypeError(
      "Remote ingress control service must be created by createRemoteIngressControlService."
    );
  }
}

function requireSuccessfulAuditResult<T>(
  result: SecurityMutationExecutionResult<T>
): T {
  if (result.outcome === "succeeded") return result.response;
  throw new HostDeckRemoteIngressControlServiceError(
    result.outcome === "incomplete" ? "mutation_incomplete" : "mutation_failed",
    result.error_code,
    false,
    result.outcome === "incomplete"
      ? "Remote ingress mutation outcome is incomplete."
      : "Remote ingress mutation failed."
  );
}

function auditServiceError(error: unknown): HostDeckRemoteIngressControlServiceError {
  if (error instanceof HostDeckSecurityMutationAuditExecutorError) {
    return new HostDeckRemoteIngressControlServiceError(
      "audit_unavailable",
      error.api_code,
      error.retry_safe,
      "Remote ingress security audit is unavailable."
    );
  }
  return serviceError("audit_unavailable");
}

function serviceError(
  code: RemoteIngressControlServiceErrorCode,
  apiCode?: ErrorCode
): HostDeckRemoteIngressControlServiceError {
  const defaults: Record<
    RemoteIngressControlServiceErrorCode,
    Readonly<{ api: ErrorCode; message: string; retryable: boolean }>
  > = {
    audit_unavailable: {
      api: "audit_unavailable",
      message: "Remote ingress security audit is unavailable.",
      retryable: false
    },
    clock_invalid: {
      api: "internal_error",
      message: "Remote ingress clock is invalid.",
      retryable: false
    },
    contract_violation: {
      api: "internal_error",
      message: "Remote ingress contract validation failed.",
      retryable: false
    },
    invalid_input: {
      api: "validation_error",
      message: "Remote ingress request is invalid.",
      retryable: false
    },
    mutation_failed: {
      api: "runtime_unavailable",
      message: "Remote ingress mutation failed.",
      retryable: false
    },
    mutation_incomplete: {
      api: "unknown_error",
      message: "Remote ingress mutation outcome is incomplete.",
      retryable: false
    },
    observation_unavailable: {
      api: "runtime_unavailable",
      message: "Remote ingress observation is unavailable.",
      retryable: true
    },
    operation_busy: {
      api: "service_overloaded",
      message: "A remote ingress operation is already active.",
      retryable: true
    },
    proof_unavailable: {
      api: "storage_error",
      message: "Remote ingress admission proof is unavailable.",
      retryable: false
    },
    selection_conflict: {
      api: "operation_conflict",
      message: "Remote ingress selection conflicts with current state.",
      retryable: false
    },
    storage_unavailable: {
      api: "storage_error",
      message: "Remote ingress storage is unavailable.",
      retryable: false
    }
  };
  const fallback = defaults[code];
  return new HostDeckRemoteIngressControlServiceError(
    code,
    apiCode ?? fallback.api,
    fallback.retryable,
    fallback.message
  );
}

function disabledPublicState(): RemoteIngressPublicState {
  return remoteIngressPublicStateSchema.parse({
    generation: 0,
    availability: "disabled",
    reason: "remote_disabled",
    external_origin: null,
    laptop_action_required: true,
    observed_at: null
  });
}

function closedSnapshot(generation: number): TailscaleServeRemoteAdmissionSnapshot {
  if (generation === 0) return closedAdmission;
  return Object.freeze({
    admission: "closed",
    external_origin: null,
    generation:
      Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
  });
}

function nextGeneration(state: RemoteIngressState): number {
  if (state.generation >= Number.MAX_SAFE_INTEGER) {
    throw serviceError("selection_conflict");
  }
  return state.generation + 1;
}

function assertObserver(candidate: unknown): asserts candidate is TailscaleObserver {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as TailscaleObserver).observeCandidate !== "function" ||
    typeof (candidate as TailscaleObserver).observeConfigured !== "function" ||
    !Number.isSafeInteger((candidate as TailscaleObserver).poll_interval_ms) ||
    (candidate as TailscaleObserver).poll_interval_ms <= 0
  ) {
    throw new TypeError("Remote ingress control service observer is invalid.");
  }
}

function assertManager(candidate: unknown): asserts candidate is TailscaleServeManager {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as TailscaleServeManager).enable !== "function" ||
    typeof (candidate as TailscaleServeManager).disable !== "function" ||
    typeof (candidate as TailscaleServeManager).snapshot !== "function"
  ) {
    throw new TypeError("Remote ingress control service manager is invalid.");
  }
}

function readExactDataObject<const Key extends string>(
  input: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Remote ingress control service data object is invalid.");
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== expectedKeys.length ||
      keys.some((key) => {
        if (typeof key !== "string" || !expectedKeys.includes(key as Key)) return true;
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      })
    ) {
      throw new TypeError("Remote ingress control service data object is invalid.");
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => [key, descriptors[key as string]?.value])
      ) as Record<Key, unknown>
    );
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "Remote ingress control service data object is invalid."
    ) {
      throw error;
    }
    throw new TypeError("Remote ingress control service data object is invalid.");
  }
}

function increment(value: number): number {
  return value >= maxCounter ? maxCounter : value + 1;
}
