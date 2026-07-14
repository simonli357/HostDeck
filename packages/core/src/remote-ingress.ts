export const remoteIngressIntentStates = ["disabled", "enabled"] as const;
export type RemoteIngressIntent = (typeof remoteIngressIntentStates)[number];

export const remoteIngressAvailabilityStates = ["disabled", "ready", "unavailable"] as const;
export type RemoteIngressAvailability = (typeof remoteIngressAvailabilityStates)[number];

export const remoteIngressAdmissionStates = ["closed", "open"] as const;
export type RemoteIngressAdmission = (typeof remoteIngressAdmissionStates)[number];

export const remoteIngressObservationStates = ["current", "stale", "failed"] as const;
export type RemoteIngressObservationState = (typeof remoteIngressObservationStates)[number];

export const tailscaleClientStates = ["available", "not_installed", "unsupported", "error"] as const;
export type TailscaleClientState = (typeof tailscaleClientStates)[number];

export const remoteProfileStates = ["absent", "stopped", "signed_out", "dedicated", "other", "unknown"] as const;
export type RemoteProfileState = (typeof remoteProfileStates)[number];

export const remoteProfileRelations = ["unconfigured", "missing", "match", "different", "unknown"] as const;
export type RemoteProfileRelation = (typeof remoteProfileRelations)[number];

export const remoteServeStates = ["absent", "exact", "foreign", "colliding", "drifted", "public"] as const;
export type RemoteServeState = (typeof remoteServeStates)[number];

export const remoteIngressOperationFailureReasons = [
  "consent_required",
  "permission_denied",
  "command_failed",
  "command_timeout",
  "output_oversized",
  "schema_invalid",
  "profile_changed",
  "cleanup_incomplete"
] as const;
export type RemoteIngressOperationFailureReason = (typeof remoteIngressOperationFailureReasons)[number];

export const remoteIngressUnavailableReasons = [
  "client_not_installed",
  "client_unsupported",
  "client_error",
  "client_stopped",
  "client_signed_out",
  "profile_absent",
  "profile_other",
  "profile_unknown",
  "serve_absent",
  "serve_foreign",
  "serve_colliding",
  "serve_drifted",
  "serve_public",
  "external_origin_invalid",
  "observation_stale",
  "observation_failed",
  ...remoteIngressOperationFailureReasons
] as const;
export type RemoteIngressUnavailableReason = (typeof remoteIngressUnavailableReasons)[number];

export interface RemoteIngressAvailabilityInput {
  readonly intent: RemoteIngressIntent;
  readonly observation: RemoteIngressObservationState;
  readonly client: TailscaleClientState;
  readonly profile: RemoteProfileState;
  readonly serve: RemoteServeState | null;
  readonly externalOriginValid: boolean;
  readonly operationFailure: RemoteIngressOperationFailureReason | null;
}

export interface RemoteIngressAvailabilityDecision {
  readonly availability: RemoteIngressAvailability;
  readonly admission: RemoteIngressAdmission;
  readonly reason: RemoteIngressUnavailableReason | null;
}

export function evaluateRemoteIngressAvailability(
  input: RemoteIngressAvailabilityInput
): RemoteIngressAvailabilityDecision {
  if (input.intent === "disabled") {
    return {
      availability: "disabled",
      admission: "closed",
      reason: input.operationFailure === "cleanup_incomplete" ? "cleanup_incomplete" : null
    };
  }

  if (input.observation === "stale") return unavailable("observation_stale");
  if (input.observation === "failed") {
    return unavailable(input.operationFailure ?? "observation_failed");
  }

  switch (input.client) {
    case "not_installed":
      return unavailable("client_not_installed");
    case "unsupported":
      return unavailable("client_unsupported");
    case "error":
      return unavailable(input.operationFailure ?? "client_error");
    case "available":
      break;
  }

  if (input.operationFailure === "profile_changed") return unavailable("profile_changed");

  switch (input.profile) {
    case "absent":
      return unavailable("profile_absent");
    case "stopped":
      return unavailable("client_stopped");
    case "signed_out":
      return unavailable("client_signed_out");
    case "other":
      return unavailable("profile_other");
    case "unknown":
      return unavailable("profile_unknown");
    case "dedicated":
      break;
  }

  if (input.operationFailure !== null) return unavailable(input.operationFailure);

  switch (input.serve) {
    case "absent":
      return unavailable("serve_absent");
    case "foreign":
      return unavailable("serve_foreign");
    case "colliding":
      return unavailable("serve_colliding");
    case "drifted":
      return unavailable("serve_drifted");
    case "public":
      return unavailable("serve_public");
    case null:
      return unavailable("observation_failed");
    case "exact":
      break;
  }

  if (!input.externalOriginValid) return unavailable("external_origin_invalid");

  return { availability: "ready", admission: "open", reason: null };
}

function unavailable(reason: RemoteIngressUnavailableReason): RemoteIngressAvailabilityDecision {
  return { availability: "unavailable", admission: "closed", reason };
}
