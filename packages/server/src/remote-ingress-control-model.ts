import { isDeepStrictEqual } from "node:util";
import {
  type RemoteIngressAuditSummary,
  type RemoteIngressObservationSnapshot,
  type RemoteIngressState,
  type RemoteServeDescriptor,
  remoteIngressAuditSummarySchema,
  remoteIngressObservationSnapshotSchema,
  remoteIngressStateSchema,
  remoteServeDescriptorSchema
} from "@hostdeck/contracts";
import {
  type ErrorCode,
  evaluateRemoteIngressAvailability,
  type RemoteIngressOperationFailureReason,
  type RemoteIngressUnavailableReason,
  remoteIngressOperationFailureReasons,
  remoteIngressUnavailableReasons
} from "@hostdeck/core";
import type { TailscaleConfiguredObservationInput } from "./tailscale-observer.js";
import type {
  TailscaleServeManagerOutcome,
  TailscaleServeManagerReason,
  TailscaleServeManagerServeResult
} from "./tailscale-serve-manager.js";

export interface SelectedRemoteState {
  readonly expected_profile_key: string;
  readonly expected_serve: RemoteServeDescriptor;
  readonly state: RemoteIngressState;
}

export interface ParsedManagerResult {
  readonly action: "disable" | "enable";
  readonly outcome: TailscaleServeManagerOutcome;
  readonly serve_result: TailscaleServeManagerServeResult;
  readonly reason: TailscaleServeManagerReason | null;
  readonly command_attempted: boolean;
  readonly before: RemoteIngressObservationSnapshot;
  readonly after: RemoteIngressObservationSnapshot | null;
}

const managerResultKeys = [
  "action",
  "outcome",
  "serve_result",
  "reason",
  "command_attempted",
  "before",
  "after"
] as const;
const managerOutcomes = ["succeeded", "failed", "incomplete", "rejected"] as const;
const managerServeResults = [
  "not_attempted",
  "unchanged",
  "applied",
  "removed",
  "unknown"
] as const;
const managerReasons = [...remoteIngressUnavailableReasons, "operation_aborted"] as const;

export function selectedState(
  state: RemoteIngressState
): SelectedRemoteState | null {
  const expectedProfileKey = state.profile.comparison.expected_profile_key;
  const expectedServe = state.expected_serve;
  if (expectedProfileKey === null && expectedServe === null) return null;
  if (expectedProfileKey === null || expectedServe === null) throw invalidModel();
  return Object.freeze({
    expected_profile_key: expectedProfileKey,
    expected_serve: expectedServe,
    state
  });
}

export function observationInput(
  selected: SelectedRemoteState
): TailscaleConfiguredObservationInput {
  return Object.freeze({
    expected_profile_key: selected.expected_profile_key,
    expected_serve: selected.expected_serve
  });
}

export function parseObservation(
  candidate: unknown
): RemoteIngressObservationSnapshot {
  const parsed = remoteIngressObservationSnapshotSchema.safeParse(candidate);
  if (!parsed.success) throw invalidModel();
  return deepFreeze(parsed.data);
}

export function serveDescriptor(
  externalOrigin: string,
  localOrigin: string
): RemoteServeDescriptor {
  const parsed = remoteServeDescriptorSchema.safeParse({
    external_origin: externalOrigin,
    https_port: 443,
    path: "/",
    proxy_origin: localOrigin,
    visibility: "private"
  });
  if (!parsed.success) throw invalidModel();
  return deepFreeze(parsed.data);
}

export function stateFromObservation(input: {
  readonly expectedServe: RemoteServeDescriptor;
  readonly generation: number;
  readonly intent: "disabled" | "enabled";
  readonly observation: RemoteIngressObservationSnapshot;
  readonly observationOverride: "failed" | null;
  readonly operationFailure: RemoteIngressOperationFailureReason | null;
  readonly updatedAt: string;
}): RemoteIngressState {
  const observation =
    input.observationOverride ??
    (input.observation.failure === null ? "current" : "failed");
  const decision = evaluateRemoteIngressAvailability({
    intent: input.intent,
    observation,
    client: input.observation.client,
    profile: input.observation.profile.state,
    serve: input.observation.serve,
    externalOriginValid: true,
    operationFailure: input.operationFailure
  });
  const result = remoteIngressStateSchema.safeParse({
    schema_version: 1,
    generation: input.generation,
    intent: input.intent,
    availability: decision.availability,
    admission: decision.admission,
    observation,
    client: input.observation.client,
    profile: input.observation.profile,
    serve: input.observation.serve,
    expected_serve: input.expectedServe,
    external_origin: input.expectedServe.external_origin,
    operation_failure: input.operationFailure,
    reason: decision.reason,
    observed_at: input.observation.observed_at,
    updated_at: input.updatedAt
  });
  if (result.success) return deepFreeze(result.data);
  if (
    input.intent === "disabled" &&
    input.operationFailure === "cleanup_incomplete"
  ) {
    return cleanupFallbackState(input);
  }
  throw invalidModel();
}

export function unconfiguredDisabledState(
  generation: number,
  updatedAt: string,
  observedAt: string | null = null
): RemoteIngressState {
  const result = remoteIngressStateSchema.safeParse({
    schema_version: 1,
    generation,
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    observation: observedAt === null ? "failed" : "current",
    client: "available",
    profile: {
      state: "absent",
      comparison: {
        relation: "unconfigured",
        expected_profile_key: null,
        active_profile_key: null
      }
    },
    serve: null,
    expected_serve: null,
    external_origin: null,
    operation_failure: null,
    reason: null,
    observed_at: observedAt,
    updated_at: updatedAt
  });
  if (!result.success) throw invalidModel();
  return deepFreeze(result.data);
}

export function disabledCleanupState(
  before: RemoteIngressState,
  generation: number,
  updatedAt: string
): RemoteIngressState {
  const result = remoteIngressStateSchema.safeParse({
    ...before,
    generation,
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    observation: before.observation === "stale" ? "failed" : before.observation,
    operation_failure: "cleanup_incomplete",
    reason: "cleanup_incomplete",
    updated_at: updatedAt
  });
  if (result.success) return deepFreeze(result.data);
  const expectedProfileKey = before.profile.comparison.expected_profile_key;
  if (expectedProfileKey === null || before.expected_serve === null) {
    throw invalidModel();
  }
  const fallback = remoteIngressStateSchema.safeParse({
    schema_version: 1,
    generation,
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    observation: "failed",
    client: "error",
    profile: {
      state: "unknown",
      comparison: {
        relation: "unknown",
        expected_profile_key: expectedProfileKey,
        active_profile_key: null
      }
    },
    serve: null,
    expected_serve: before.expected_serve,
    external_origin: before.expected_serve.external_origin,
    operation_failure: "cleanup_incomplete",
    reason: "cleanup_incomplete",
    observed_at: before.observed_at ?? before.updated_at,
    updated_at: updatedAt
  });
  if (!fallback.success) throw invalidModel();
  return deepFreeze(fallback.data);
}

export function observationFromState(
  state: RemoteIngressState
): RemoteIngressObservationSnapshot {
  const failure =
    state.observation === "failed" &&
    state.operation_failure !== null &&
    state.operation_failure !== "cleanup_incomplete" &&
    remoteIngressOperationFailureReasons.includes(state.operation_failure)
      ? state.operation_failure === "consent_required" ||
        state.operation_failure === "permission_denied"
        ? "command_failed"
        : state.operation_failure
      : null;
  const parsed = remoteIngressObservationSnapshotSchema.safeParse({
    schema_version: 1,
    client: state.client,
    profile: state.profile,
    serve: state.serve,
    external_origin: state.expected_serve === null ? null : state.external_origin,
    failure,
    observed_at: state.observed_at ?? state.updated_at
  });
  if (parsed.success) return deepFreeze(parsed.data);
  const fallback = remoteIngressObservationSnapshotSchema.safeParse({
    schema_version: 1,
    client: "available",
    profile: {
      state: "unknown",
      comparison: {
        relation: "unknown",
        expected_profile_key: state.profile.comparison.expected_profile_key,
        active_profile_key: null
      }
    },
    serve: null,
    external_origin: null,
    failure: "profile_changed",
    observed_at: state.observed_at ?? state.updated_at
  });
  if (!fallback.success) throw invalidModel();
  return deepFreeze(fallback.data);
}

export function materiallyDifferent(
  before: RemoteIngressState,
  after: RemoteIngressState
): boolean {
  return !isDeepStrictEqual(materialState(before), materialState(after));
}

export function candidateEnableReason(
  observation: RemoteIngressObservationSnapshot
): RemoteIngressUnavailableReason | null {
  const common = commonObservationReason(observation);
  if (common !== null) return common;
  if (
    observation.profile.state !== "dedicated" ||
    observation.profile.comparison.relation !== "match" ||
    observation.profile.comparison.expected_profile_key === null ||
    observation.profile.comparison.active_profile_key !==
      observation.profile.comparison.expected_profile_key
  ) {
    return "profile_unknown";
  }
  if (observation.external_origin === null) return "external_origin_invalid";
  if (observation.serve !== "absent") return reasonForServe(observation.serve);
  return null;
}

export function configuredEnableReason(
  observation: RemoteIngressObservationSnapshot,
  expectedProfileKey: string,
  expectedServe: RemoteServeDescriptor,
  operationFailure: RemoteIngressOperationFailureReason | null
): RemoteIngressUnavailableReason | null {
  if (operationFailure === "cleanup_incomplete") return "cleanup_incomplete";
  const common = commonObservationReason(observation);
  if (common !== null) return common;
  if (
    observation.profile.state !== "dedicated" ||
    observation.profile.comparison.relation !== "match" ||
    observation.profile.comparison.expected_profile_key !== expectedProfileKey ||
    observation.profile.comparison.active_profile_key !== expectedProfileKey
  ) {
    return "profile_changed";
  }
  if (observation.external_origin !== expectedServe.external_origin) {
    return "external_origin_invalid";
  }
  if (observation.serve !== "absent" && observation.serve !== "exact") {
    return reasonForServe(observation.serve);
  }
  return null;
}

export function isVerifiedAbsent(
  observation: RemoteIngressObservationSnapshot,
  expectedProfileKey: string,
  expectedServe: RemoteServeDescriptor
): boolean {
  return (
    configuredEnableReason(
      observation,
      expectedProfileKey,
      expectedServe,
      null
    ) === null && observation.serve === "absent"
  );
}

export function isDurablyReady(state: RemoteIngressState): boolean {
  return (
    state.intent === "enabled" &&
    state.availability === "ready" &&
    state.admission === "open" &&
    state.observation === "current" &&
    state.client === "available" &&
    state.profile.state === "dedicated" &&
    state.serve === "exact" &&
    state.external_origin !== null &&
    state.operation_failure === null &&
    state.reason === null
  );
}

export function parseManagerResult(
  candidate: unknown,
  expectedAction: "disable" | "enable"
): ParsedManagerResult {
  const value = readExactDataObject(candidate, managerResultKeys);
  const before = remoteIngressObservationSnapshotSchema.safeParse(value.before);
  const after =
    value.after === null
      ? null
      : remoteIngressObservationSnapshotSchema.safeParse(value.after);
  if (
    value.action !== expectedAction ||
    !managerOutcomes.includes(value.outcome as TailscaleServeManagerOutcome) ||
    !managerServeResults.includes(
      value.serve_result as TailscaleServeManagerServeResult
    ) ||
    (value.reason !== null &&
      !managerReasons.includes(value.reason as TailscaleServeManagerReason)) ||
    typeof value.command_attempted !== "boolean" ||
    !before.success ||
    (after !== null && !after.success)
  ) {
    throw invalidModel();
  }
  const result = {
    action: expectedAction,
    outcome: value.outcome as TailscaleServeManagerOutcome,
    serve_result: value.serve_result as TailscaleServeManagerServeResult,
    reason: value.reason as TailscaleServeManagerReason | null,
    command_attempted: value.command_attempted,
    before: before.data,
    after: after === null ? null : after.data
  };
  if (!validManagerResultShape(result)) throw invalidModel();
  return deepFreeze(result);
}

export function acceptedSummary(
  action: "remote_disable" | "remote_enable",
  observation: RemoteIngressObservationSnapshot | null
): RemoteIngressAuditSummary {
  return remoteIngressAuditSummarySchema.parse({
    schema_version: 1,
    action,
    requested_intent: action === "remote_enable" ? "enabled" : "disabled",
    profile_state: observation?.profile.state ?? "absent",
    serve_state: observation?.serve ?? null,
    phase: "accepted",
    outcome: "accepted"
  });
}

export function terminalSummary(input: {
  readonly action: "remote_disable" | "remote_enable";
  readonly admission: "closed" | "open";
  readonly intentPersisted: boolean | "unknown";
  readonly observation: RemoteIngressObservationSnapshot | null;
  readonly outcome: "failed" | "incomplete" | "rejected" | "succeeded";
  readonly reason: RemoteIngressUnavailableReason | null;
  readonly serveResult: TailscaleServeManagerServeResult;
}): RemoteIngressAuditSummary {
  return remoteIngressAuditSummarySchema.parse({
    schema_version: 1,
    action: input.action,
    requested_intent:
      input.action === "remote_enable" ? "enabled" : "disabled",
    profile_state: input.observation?.profile.state ?? "absent",
    serve_state: input.observation?.serve ?? null,
    phase: "terminal",
    outcome: input.outcome,
    admission: input.admission,
    intent_persisted: input.intentPersisted,
    serve_result: input.serveResult,
    reason: input.reason
  });
}

export function failedEnableBeforeManager(
  observation: RemoteIngressObservationSnapshot,
  errorCode: ErrorCode
): Readonly<{
  outcome: "failed";
  error_code: ErrorCode;
  payload_summary: RemoteIngressAuditSummary;
}> {
  return Object.freeze({
    outcome: "failed",
    error_code: errorCode,
    payload_summary: terminalSummary({
      action: "remote_enable",
      observation,
      outcome: "failed",
      admission: "closed",
      intentPersisted: false,
      serveResult: "not_attempted",
      reason: "observation_failed"
    })
  });
}

export function incompleteDisable(
  observation: RemoteIngressObservationSnapshot | null,
  intentPersisted: boolean,
  errorCode: ErrorCode
): Readonly<{
  outcome: "incomplete";
  error_code: ErrorCode;
  payload_summary: RemoteIngressAuditSummary;
}> {
  return Object.freeze({
    outcome: "incomplete",
    error_code: errorCode,
    payload_summary: terminalSummary({
      action: "remote_disable",
      observation,
      outcome: "incomplete",
      admission: "closed",
      intentPersisted: intentPersisted ? true : "unknown",
      serveResult: "unknown",
      reason: intentPersisted ? "cleanup_incomplete" : "observation_failed"
    })
  });
}

export function normalizedManagerReason(
  reason: TailscaleServeManagerReason | null
): RemoteIngressUnavailableReason {
  if (reason === null || reason === "operation_aborted") {
    return "observation_failed";
  }
  return reason;
}

export function operationFailureForReason(
  reason: RemoteIngressUnavailableReason,
  observation: RemoteIngressObservationSnapshot
): RemoteIngressOperationFailureReason | null {
  if (
    remoteIngressOperationFailureReasons.includes(
      reason as RemoteIngressOperationFailureReason
    ) &&
    reason !== "cleanup_incomplete" &&
    !(observation.client === "not_installed" ||
      observation.client === "unsupported")
  ) {
    return reason as RemoteIngressOperationFailureReason;
  }
  return observation.failure;
}

export function errorCodeForReason(
  reason: RemoteIngressUnavailableReason
): ErrorCode {
  switch (reason) {
    case "permission_denied":
      return "permission_denied";
    case "command_timeout":
      return "operation_timeout";
    case "client_not_installed":
      return "missing_binary";
    case "client_unsupported":
      return "incompatible_runtime";
    case "profile_absent":
    case "profile_other":
    case "profile_unknown":
    case "profile_changed":
    case "serve_foreign":
    case "serve_colliding":
    case "serve_drifted":
    case "serve_public":
    case "external_origin_invalid":
    case "cleanup_incomplete":
      return "operation_conflict";
    case "schema_invalid":
      return "protocol_error";
    case "consent_required":
      return "capability_unavailable";
    case "client_error":
    case "client_stopped":
    case "client_signed_out":
    case "serve_absent":
    case "observation_stale":
    case "observation_failed":
    case "command_failed":
    case "output_oversized":
      return "runtime_unavailable";
  }
}

function cleanupFallbackState(input: {
  readonly expectedServe: RemoteServeDescriptor;
  readonly generation: number;
  readonly observation: RemoteIngressObservationSnapshot;
  readonly updatedAt: string;
}): RemoteIngressState {
  const expectedProfileKey =
    input.observation.profile.comparison.expected_profile_key;
  if (expectedProfileKey === null) throw invalidModel();
  const result = remoteIngressStateSchema.safeParse({
    schema_version: 1,
    generation: input.generation,
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    observation: "failed",
    client: "error",
    profile: {
      state: "unknown",
      comparison: {
        relation: "unknown",
        expected_profile_key: expectedProfileKey,
        active_profile_key: null
      }
    },
    serve: null,
    expected_serve: input.expectedServe,
    external_origin: input.expectedServe.external_origin,
    operation_failure: "cleanup_incomplete",
    reason: "cleanup_incomplete",
    observed_at: input.observation.observed_at,
    updated_at: input.updatedAt
  });
  if (!result.success) throw invalidModel();
  return deepFreeze(result.data);
}

function materialState(state: RemoteIngressState): Record<string, unknown> {
  const {
    generation: _generation,
    observed_at: _observedAt,
    updated_at: _updatedAt,
    ...material
  } = state;
  return material;
}

function commonObservationReason(
  observation: RemoteIngressObservationSnapshot
): RemoteIngressUnavailableReason | null {
  if (observation.failure !== null) return observation.failure;
  if (observation.client === "not_installed") return "client_not_installed";
  if (observation.client === "unsupported") return "client_unsupported";
  if (observation.client === "error") return "client_error";
  if (observation.profile.state === "absent") return "profile_absent";
  if (observation.profile.state === "stopped") return "client_stopped";
  if (observation.profile.state === "signed_out") return "client_signed_out";
  if (observation.profile.state === "other") return "profile_other";
  if (observation.profile.state === "unknown") return "profile_unknown";
  return null;
}

function reasonForServe(
  serve: RemoteIngressObservationSnapshot["serve"]
): RemoteIngressUnavailableReason {
  switch (serve) {
    case "absent":
      return "serve_absent";
    case "foreign":
      return "serve_foreign";
    case "colliding":
      return "serve_colliding";
    case "drifted":
      return "serve_drifted";
    case "public":
      return "serve_public";
    case "exact":
    case null:
      return "observation_failed";
  }
}

function validManagerResultShape(result: ParsedManagerResult): boolean {
  return (
    (result.outcome === "rejected" &&
      result.serve_result === "not_attempted" &&
      result.reason !== null &&
      !result.command_attempted &&
      result.after === null) ||
    (result.outcome === "failed" &&
      result.serve_result === "unchanged" &&
      result.reason !== null &&
      result.command_attempted &&
      result.after !== null) ||
    (result.outcome === "incomplete" &&
      result.serve_result === "unknown" &&
      result.reason !== null &&
      result.command_attempted) ||
    (result.outcome === "succeeded" &&
      result.reason === null &&
      result.after !== null &&
      ((result.serve_result === "unchanged" && !result.command_attempted) ||
        (result.action === "enable" &&
          result.serve_result === "applied" &&
          result.command_attempted) ||
        (result.action === "disable" &&
          result.serve_result === "removed" &&
          result.command_attempted)))
  );
}

function readExactDataObject<const Key extends string>(
  input: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidModel();
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
      throw invalidModel();
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => [key, descriptors[key as string]?.value])
      ) as Record<Key, unknown>
    );
  } catch (error) {
    if (error instanceof TypeError && error.message === invalidModelMessage) {
      throw error;
    }
    throw invalidModel();
  }
}

function invalidModel(): TypeError {
  return new TypeError(invalidModelMessage);
}

const invalidModelMessage = "Remote ingress control model is invalid.";

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
