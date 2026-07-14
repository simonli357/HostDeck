import type {
  RemoteIngressAuditSummary,
  RemoteIngressState,
  RemotePairingLinkIntent,
  RemoteProfileObservation,
  RemoteProxyTrustDecision
} from "@hostdeck/contracts";
import {
  projectRemoteIngressPublicState,
  remoteIngressAuditSummarySchema,
  remoteIngressStateSchema,
  remotePairingLinkIntentSchema,
  remoteProfileObservationSchema,
  remoteProxyTrustDecisionSchema
} from "@hostdeck/contracts";

export const remoteFixtureTimestamp = "2026-07-13T16:00:00.000Z";
export const remoteFixtureOrigin = "https://hostdeck-fixture.fixture-tailnet.ts.net";
export const remoteFixtureProfileKey = `sha256:${"1".repeat(64)}`;
export const remoteFixtureOtherProfileKey = `sha256:${"2".repeat(64)}`;
export const remoteFixtureSourceKey = `sha256:${"3".repeat(64)}`;

export const remoteFixtureServeDescriptor = {
  external_origin: remoteFixtureOrigin,
  https_port: 443,
  path: "/",
  proxy_origin: "http://127.0.0.1:3777",
  visibility: "private"
} as const;

export const requiredRemoteProfileFixtureIds = [
  "profile_absent",
  "profile_stopped",
  "profile_signed_out",
  "profile_dedicated",
  "profile_other",
  "profile_unknown"
] as const;
export type RemoteProfileFixtureId = (typeof requiredRemoteProfileFixtureIds)[number];

export interface RemoteProfileFixture {
  readonly id: RemoteProfileFixtureId;
  readonly profile: RemoteProfileObservation;
}

export const remoteProfileFixtures: readonly RemoteProfileFixture[] = [
  profileFixture("profile_absent", "absent", "missing", remoteFixtureProfileKey, null),
  profileFixture("profile_stopped", "stopped", "match", remoteFixtureProfileKey, remoteFixtureProfileKey),
  profileFixture("profile_signed_out", "signed_out", "unknown", remoteFixtureProfileKey, null),
  profileFixture("profile_dedicated", "dedicated", "match", remoteFixtureProfileKey, remoteFixtureProfileKey),
  profileFixture("profile_other", "other", "different", remoteFixtureProfileKey, remoteFixtureOtherProfileKey),
  profileFixture("profile_unknown", "unknown", "unknown", remoteFixtureProfileKey, null)
];

export const requiredRemoteIngressFixtureIds = [
  "disabled",
  "disabled_cleanup_incomplete",
  "ready",
  "client_not_installed",
  "client_unsupported",
  "client_error",
  "profile_absent",
  "profile_stopped",
  "profile_signed_out",
  "profile_other",
  "profile_unknown",
  "observation_stale",
  "observation_failed",
  "serve_absent",
  "serve_foreign",
  "serve_colliding",
  "serve_drifted",
  "serve_public",
  "consent_required",
  "permission_denied",
  "command_failed",
  "command_timeout",
  "output_oversized",
  "schema_invalid",
  "profile_changed"
] as const;
export type RemoteIngressFixtureId = (typeof requiredRemoteIngressFixtureIds)[number];

export interface RemoteIngressFixture {
  readonly id: RemoteIngressFixtureId;
  readonly state: RemoteIngressState;
}

const readyState = remoteState();

export const remoteIngressFixtures: readonly RemoteIngressFixture[] = [
  ingressFixture("disabled", { intent: "disabled", availability: "disabled", admission: "closed" }),
  ingressFixture("disabled_cleanup_incomplete", {
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    operation_failure: "cleanup_incomplete",
    reason: "cleanup_incomplete"
  }),
  { id: "ready", state: readyState },
  ingressFixture("client_not_installed", {
    availability: "unavailable",
    admission: "closed",
    client: "not_installed",
    profile: profileById("profile_absent"),
    serve: null,
    operation_failure: null,
    reason: "client_not_installed"
  }),
  ingressFixture("client_unsupported", {
    availability: "unavailable",
    admission: "closed",
    client: "unsupported",
    profile: profileById("profile_unknown"),
    serve: null,
    operation_failure: null,
    reason: "client_unsupported"
  }),
  ingressFixture("client_error", {
    availability: "unavailable",
    admission: "closed",
    client: "error",
    profile: profileById("profile_unknown"),
    serve: null,
    operation_failure: null,
    reason: "client_error"
  }),
  profileIngressFixture("profile_absent", "profile_absent", null),
  profileIngressFixture("profile_stopped", "client_stopped", "exact"),
  profileIngressFixture("profile_signed_out", "client_signed_out", null),
  profileIngressFixture("profile_other", "profile_other", null),
  profileIngressFixture("profile_unknown", "profile_unknown", null),
  ingressFixture("observation_stale", {
    availability: "unavailable",
    admission: "closed",
    observation: "stale",
    reason: "observation_stale"
  }),
  ingressFixture("observation_failed", {
    availability: "unavailable",
    admission: "closed",
    observation: "failed",
    profile: profileById("profile_unknown"),
    serve: null,
    reason: "observation_failed",
    observed_at: null
  }),
  serveIngressFixture("serve_absent", "absent", "serve_absent"),
  serveIngressFixture("serve_foreign", "foreign", "serve_foreign"),
  serveIngressFixture("serve_colliding", "colliding", "serve_colliding"),
  serveIngressFixture("serve_drifted", "drifted", "serve_drifted"),
  serveIngressFixture("serve_public", "public", "serve_public"),
  failureIngressFixture("consent_required"),
  failureIngressFixture("permission_denied"),
  failureIngressFixture("command_failed"),
  failureIngressFixture("command_timeout"),
  failureIngressFixture("output_oversized"),
  failureIngressFixture("schema_invalid"),
  failureIngressFixture("profile_changed")
];

export const requiredRemoteProxyFixtureIds = [
  "local_admitted",
  "remote_admitted",
  "remote_admitted_with_identity",
  "reject_untrusted_lookalike",
  "reject_missing_forwarding",
  "reject_duplicate_forwarding",
  "reject_forwarded_proto",
  "reject_host",
  "reject_origin",
  "reject_source",
  "reject_identity",
  "reject_generation",
  "reject_non_loopback",
  "reject_unknown"
] as const;
export type RemoteProxyFixtureId = (typeof requiredRemoteProxyFixtureIds)[number];

export interface RemoteProxyFixture {
  readonly id: RemoteProxyFixtureId;
  readonly decision: RemoteProxyTrustDecision;
}

export const remoteProxyFixtures: readonly RemoteProxyFixture[] = [
  proxyFixture("local_admitted", {
    decision: "admitted",
    provenance: {
      kind: "local_loopback",
      transport: "loopback_http",
      origin: "http://127.0.0.1:3777",
      remote_generation: null,
      source_key: null,
      tailnet_identity_present: false,
      app_authorization: "not_evaluated"
    },
    headers: { forwarding: "absent", standard_identity: "absent", untrusted_lookalike_present: false },
    reason: null
  }),
  admittedRemoteProxyFixture("remote_admitted", false),
  admittedRemoteProxyFixture("remote_admitted_with_identity", true),
  rejectedProxyFixture("reject_untrusted_lookalike", "untrusted_tailscale_lookalike", {
    forwarding: "exact",
    standard_identity: "present",
    untrusted_lookalike_present: true
  }),
  rejectedProxyFixture("reject_missing_forwarding", "missing_forwarding_header", {
    forwarding: "absent",
    standard_identity: "absent",
    untrusted_lookalike_present: false
  }),
  rejectedProxyFixture("reject_duplicate_forwarding", "duplicate_forwarding_header"),
  rejectedProxyFixture("reject_forwarded_proto", "invalid_forwarded_proto"),
  rejectedProxyFixture("reject_host", "host_mismatch"),
  rejectedProxyFixture("reject_origin", "origin_mismatch"),
  rejectedProxyFixture("reject_source", "source_invalid"),
  rejectedProxyFixture("reject_identity", "standard_identity_invalid", {
    forwarding: "exact",
    standard_identity: "invalid",
    untrusted_lookalike_present: false
  }),
  rejectedProxyFixture("reject_generation", "remote_generation_stale"),
  rejectedProxyFixture("reject_non_loopback", "direct_non_loopback"),
  rejectedProxyFixture("reject_unknown", "unknown_proxy_context")
];

export const remotePairingLinkFixture: RemotePairingLinkIntent = remotePairingLinkIntentSchema.parse({
  external_origin: remoteFixtureOrigin,
  claim_path: "/pair",
  code_placement: "url_fragment",
  fragment_key: "code",
  strip_fragment_before_request: true,
  referrer_contains_code: false
});

export const remoteIngressAuditFixtures: readonly RemoteIngressAuditSummary[] = [
  remoteAudit({
    schema_version: 1,
    action: "remote_enable",
    requested_intent: "enabled",
    profile_state: "dedicated",
    serve_state: "absent",
    phase: "accepted",
    outcome: "accepted"
  }),
  remoteAudit({
    schema_version: 1,
    action: "remote_enable",
    requested_intent: "enabled",
    profile_state: "dedicated",
    serve_state: "exact",
    phase: "terminal",
    outcome: "succeeded",
    admission: "open",
    intent_persisted: true,
    serve_result: "applied",
    reason: null
  }),
  remoteAudit({
    schema_version: 1,
    action: "remote_disable",
    requested_intent: "disabled",
    profile_state: "other",
    serve_state: null,
    phase: "accepted",
    outcome: "accepted"
  }),
  remoteAudit({
    schema_version: 1,
    action: "remote_disable",
    requested_intent: "disabled",
    profile_state: "other",
    serve_state: null,
    phase: "terminal",
    outcome: "incomplete",
    admission: "closed",
    intent_persisted: true,
    serve_result: "unknown",
    reason: "cleanup_incomplete"
  })
];

export const readyRemoteIngressState = readyState;
export const readyRemoteIngressPublicState = projectRemoteIngressPublicState(readyState);

export function remoteIngressFixtureById(id: RemoteIngressFixtureId): RemoteIngressFixture {
  const fixture = remoteIngressFixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new TypeError(`Missing remote ingress fixture: ${id}`);
  return fixture;
}

function profileFixture(
  id: RemoteProfileFixtureId,
  state: RemoteProfileObservation["state"],
  relation: RemoteProfileObservation["comparison"]["relation"],
  expectedProfileKey: string | null,
  activeProfileKey: string | null
): RemoteProfileFixture {
  return {
    id,
    profile: remoteProfileObservationSchema.parse({
      state,
      comparison: {
        relation,
        expected_profile_key: expectedProfileKey,
        active_profile_key: activeProfileKey
      }
    })
  };
}

function profileById(id: RemoteProfileFixtureId): RemoteProfileObservation {
  const fixture = remoteProfileFixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new TypeError(`Missing remote profile fixture: ${id}`);
  return fixture.profile;
}

function remoteState(overrides: Readonly<Record<string, unknown>> = {}): RemoteIngressState {
  return remoteIngressStateSchema.parse({
    schema_version: 1,
    revision: 7,
    intent: "enabled",
    availability: "ready",
    admission: "open",
    observation: "current",
    client: "available",
    profile: profileById("profile_dedicated"),
    serve: "exact",
    expected_serve: remoteFixtureServeDescriptor,
    external_origin: remoteFixtureOrigin,
    operation_failure: null,
    reason: null,
    observed_at: remoteFixtureTimestamp,
    updated_at: remoteFixtureTimestamp,
    ...overrides
  });
}

function ingressFixture(id: RemoteIngressFixtureId, overrides: Readonly<Record<string, unknown>>): RemoteIngressFixture {
  return { id, state: remoteState(overrides) };
}

function profileIngressFixture(
  id: Exclude<RemoteProfileFixtureId, "profile_dedicated">,
  reason: RemoteIngressState["reason"],
  serve: RemoteIngressState["serve"]
): RemoteIngressFixture {
  return ingressFixture(id, {
    availability: "unavailable",
    admission: "closed",
    profile: profileById(id),
    serve,
    reason
  });
}

function serveIngressFixture(
  id: Extract<RemoteIngressFixtureId, `serve_${string}`>,
  serve: NonNullable<RemoteIngressState["serve"]>,
  reason: RemoteIngressState["reason"]
): RemoteIngressFixture {
  return ingressFixture(id, { availability: "unavailable", admission: "closed", serve, reason });
}

function failureIngressFixture(
  reason: Extract<
    RemoteIngressFixtureId,
    "consent_required" | "permission_denied" | "command_failed" | "command_timeout" | "output_oversized" | "schema_invalid" | "profile_changed"
  >
): RemoteIngressFixture {
  return ingressFixture(reason, {
    availability: "unavailable",
    admission: "closed",
    serve: "absent",
    ...(reason === "profile_changed" ? { profile: profileById("profile_other"), serve: null } : {}),
    operation_failure: reason,
    reason
  });
}

function proxyFixture(id: RemoteProxyFixtureId, value: RemoteProxyTrustDecision): RemoteProxyFixture {
  return { id, decision: remoteProxyTrustDecisionSchema.parse(value) };
}

function admittedRemoteProxyFixture(id: RemoteProxyFixtureId, identityPresent: boolean): RemoteProxyFixture {
  return proxyFixture(id, {
    decision: "admitted",
    provenance: {
      kind: "admitted_remote",
      transport: "tailscale_serve_https",
      origin: remoteFixtureOrigin,
      remote_generation: 7,
      source_key: remoteFixtureSourceKey,
      tailnet_identity_present: identityPresent,
      app_authorization: "not_evaluated"
    },
    headers: {
      forwarding: "exact",
      standard_identity: identityPresent ? "present" : "absent",
      untrusted_lookalike_present: false
    },
    reason: null
  });
}

function rejectedProxyFixture(
  id: RemoteProxyFixtureId,
  reason: NonNullable<RemoteProxyTrustDecision["reason"]>,
  headers: RemoteProxyTrustDecision["headers"] = {
    forwarding: "invalid",
    standard_identity: "absent",
    untrusted_lookalike_present: false
  }
): RemoteProxyFixture {
  return proxyFixture(id, { decision: "rejected", provenance: null, headers, reason });
}

function remoteAudit(value: RemoteIngressAuditSummary): RemoteIngressAuditSummary {
  return remoteIngressAuditSummarySchema.parse(value);
}
