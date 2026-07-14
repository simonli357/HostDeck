import {
  evaluateRemoteIngressAvailability,
  remoteIngressAdmissionStates,
  remoteIngressAvailabilityStates,
  remoteIngressIntentStates,
  remoteIngressObservationStates,
  remoteIngressOperationFailureReasons,
  remoteIngressUnavailableReasons,
  remoteProfileRelations,
  remoteProfileStates,
  remoteServeStates,
  selectedAuditOutcomes,
  tailscaleClientStates
} from "@hostdeck/core";
import { z } from "zod";
import { exactDataObject } from "./exact-data-object.js";
import { isoTimestampSchema, nonNegativeSafeIntegerSchema } from "./scalars.js";
import { clientOperationIdSchema } from "./selected-runtime.js";

const remoteLimits = {
  dnsNameLength: 134,
  originLength: 142
} as const;

export const remoteComparisonKeySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const remoteSourceKeySchema = remoteComparisonKeySchema;

export const remoteExternalOriginSchema = z
  .string()
  .min(1)
  .max(remoteLimits.originLength)
  .url()
  .superRefine((value, context) => {
    const parsed = parseUrl(value);
    if (
      parsed === null ||
      parsed.origin !== value ||
      parsed.protocol !== "https:" ||
      parsed.port !== "" ||
      !isTailscaleDnsName(parsed.hostname)
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote external origin must be one canonical private Tailscale HTTPS origin."
      });
    }
  });

export const hostDeckLoopbackOriginSchema = z
  .string()
  .min(1)
  .max(remoteLimits.originLength)
  .url()
  .superRefine((value, context) => {
    const parsed = parseUrl(value);
    if (
      parsed === null ||
      parsed.origin !== value ||
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port === ""
    ) {
      context.addIssue({ code: "custom", message: "HostDeck target must be one canonical IPv4 loopback HTTP origin with a port." });
    }
  });

const remoteProfileComparisonDataSchema = z
  .object({
    relation: z.enum(remoteProfileRelations),
    expected_profile_key: remoteComparisonKeySchema.nullable(),
    active_profile_key: remoteComparisonKeySchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    switch (value.relation) {
      case "unconfigured":
        if (value.expected_profile_key !== null || value.active_profile_key !== null) {
          addIssue(context, "relation", "Unconfigured profile comparison cannot retain profile keys.");
        }
        break;
      case "missing":
        if (value.expected_profile_key === null || value.active_profile_key !== null) {
          addIssue(context, "relation", "Missing profile comparison requires only the expected comparison key.");
        }
        break;
      case "match":
        if (
          value.expected_profile_key === null ||
          value.active_profile_key === null ||
          value.expected_profile_key !== value.active_profile_key
        ) {
          addIssue(context, "relation", "Matching profile comparison requires two equal comparison keys.");
        }
        break;
      case "different":
        if (
          value.expected_profile_key === null ||
          value.active_profile_key === null ||
          value.expected_profile_key === value.active_profile_key
        ) {
          addIssue(context, "relation", "Different profile comparison requires two distinct comparison keys.");
        }
        break;
      case "unknown":
        if (value.active_profile_key !== null) {
          addIssue(context, "active_profile_key", "Unknown profile comparison cannot expose an untrusted active key.");
        }
        break;
    }
  });

export const remoteProfileComparisonSchema = exactDataObject(remoteProfileComparisonDataSchema);

const remoteProfileObservationDataSchema = z
  .object({
    state: z.enum(remoteProfileStates),
    comparison: remoteProfileComparisonSchema
  })
  .strict()
  .superRefine((value, context) => {
    const relation = value.comparison.relation;
    if (value.state === "dedicated" && relation !== "match") {
      addIssue(context, "comparison", "Dedicated profile state requires an exact comparison match.");
    }
    if (value.state === "other" && relation !== "different") {
      addIssue(context, "comparison", "Other-profile state requires a different active comparison key.");
    }
    if (value.state === "absent" && relation !== "unconfigured" && relation !== "missing") {
      addIssue(context, "comparison", "Absent profile state requires unconfigured or missing comparison metadata.");
    }
    if ((value.state === "signed_out" || value.state === "unknown") && relation !== "unknown") {
      addIssue(context, "comparison", "Signed-out and unknown profile states require unknown comparison metadata.");
    }
    if (value.state === "stopped" && !["match", "different", "unknown"].includes(relation)) {
      addIssue(context, "comparison", "Stopped profile state may retain only bounded match, difference, or unknown metadata.");
    }
  });

export const remoteProfileObservationSchema = exactDataObject(remoteProfileObservationDataSchema);

const remoteServeDescriptorDataSchema = z
  .object({
    external_origin: remoteExternalOriginSchema,
    https_port: z.literal(443),
    path: z.literal("/"),
    proxy_origin: hostDeckLoopbackOriginSchema,
    visibility: z.literal("private")
  })
  .strict();

export const remoteServeDescriptorSchema = exactDataObject(remoteServeDescriptorDataSchema);

const remoteIngressStateDataSchema = z
  .object({
    schema_version: z.literal(1),
    generation: nonNegativeSafeIntegerSchema,
    intent: z.enum(remoteIngressIntentStates),
    availability: z.enum(remoteIngressAvailabilityStates),
    admission: z.enum(remoteIngressAdmissionStates),
    observation: z.enum(remoteIngressObservationStates),
    client: z.enum(tailscaleClientStates),
    profile: remoteProfileObservationSchema,
    serve: z.enum(remoteServeStates).nullable(),
    expected_serve: remoteServeDescriptorSchema.nullable(),
    external_origin: remoteExternalOriginSchema.nullable(),
    operation_failure: z.enum(remoteIngressOperationFailureReasons).nullable(),
    reason: z.enum(remoteIngressUnavailableReasons).nullable(),
    observed_at: isoTimestampSchema.nullable(),
    updated_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.observation !== "failed" && value.observed_at === null) {
      addIssue(context, "observed_at", "Current and stale remote snapshots require the last bounded observation time.");
    }
    if (value.observed_at !== null && Date.parse(value.observed_at) > Date.parse(value.updated_at)) {
      addIssue(context, "observed_at", "Remote observation cannot occur after the snapshot update.");
    }
    if (value.intent === "enabled") {
      if (value.profile.comparison.expected_profile_key === null || value.expected_serve === null) {
        context.addIssue({ code: "custom", message: "Enabled remote intent requires bounded expected profile and Serve metadata." });
      }
    }
    if (value.expected_serve === null && value.external_origin !== null) {
      addIssue(context, "external_origin", "External origin requires an expected Serve descriptor.");
    }
    if (value.expected_serve !== null && value.external_origin !== value.expected_serve.external_origin) {
      addIssue(context, "external_origin", "External origin must exactly match the expected Serve descriptor.");
    }
    if (value.client === "not_installed" && (value.profile.state !== "absent" || value.serve !== null)) {
      addIssue(context, "client", "An absent Tailscale client cannot expose profile or Serve observations.");
    }
    if ((value.client === "unsupported" || value.client === "error") && value.profile.state !== "unknown") {
      addIssue(context, "profile", "Unsupported or failed client observation requires unknown normalized profile state.");
    }
    if ((value.client === "unsupported" || value.client === "error") && value.serve !== null) {
      addIssue(context, "serve", "Unsupported or failed client observation cannot expose a trusted Serve classification.");
    }
    const serveBelongsToSelectedProfile =
      value.profile.state === "dedicated" || (value.profile.state === "stopped" && value.profile.comparison.relation === "match");
    if (value.serve !== null && !serveBelongsToSelectedProfile) {
      addIssue(context, "serve", "Serve classification is valid only for the selected dedicated profile.");
    }
    if ((value.client === "not_installed" || value.client === "unsupported") && value.operation_failure !== null) {
      addIssue(context, "operation_failure", "Absent and unsupported client states are already the complete bounded failure.");
    }
    if (value.operation_failure === "cleanup_incomplete" && value.intent !== "disabled") {
      addIssue(context, "operation_failure", "Cleanup failure is valid only after remote admission has been disabled.");
    }
    if (value.operation_failure !== null && value.operation_failure !== "cleanup_incomplete" && value.intent !== "enabled") {
      addIssue(context, "operation_failure", "Enable and observation failures require enabled remote intent.");
    }
    if (value.observation === "stale" && value.operation_failure !== null) {
      addIssue(context, "operation_failure", "Stale observations cannot retain a newer operation failure as current truth.");
    }
    if (
      value.operation_failure !== null &&
      !["cleanup_incomplete", "profile_changed"].includes(value.operation_failure) &&
      value.observation !== "failed" &&
      value.profile.state !== "dedicated"
    ) {
      addIssue(context, "operation_failure", "Current profile-scoped operation failure requires the dedicated profile.");
    }

    const decision = evaluateRemoteIngressAvailability({
      intent: value.intent,
      observation: value.observation,
      client: value.client,
      profile: value.profile.state,
      serve: value.serve,
      externalOriginValid: value.external_origin !== null,
      operationFailure: value.operation_failure
    });
    if (value.availability !== decision.availability) {
      addIssue(context, "availability", "Remote availability contradicts normalized ingress evidence.");
    }
    if (value.admission !== decision.admission) {
      addIssue(context, "admission", "Remote admission contradicts normalized ingress evidence.");
    }
    if (value.reason !== decision.reason) {
      addIssue(context, "reason", "Remote reason contradicts normalized ingress evidence.");
    }
  });

export const remoteIngressStateSchema = exactDataObject(remoteIngressStateDataSchema);

export const remoteIngressPublicReasonSchema = z.union([z.literal("remote_disabled"), z.enum(remoteIngressUnavailableReasons)]);

const remoteIngressPublicStateDataSchema = z
  .object({
    generation: nonNegativeSafeIntegerSchema,
    availability: z.enum(remoteIngressAvailabilityStates),
    reason: remoteIngressPublicReasonSchema.nullable(),
    external_origin: remoteExternalOriginSchema.nullable(),
    laptop_action_required: z.boolean(),
    observed_at: isoTimestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.availability === "ready") {
      if (
        value.reason !== null ||
        value.external_origin === null ||
        value.laptop_action_required ||
        value.observed_at === null
      ) {
        context.addIssue({ code: "custom", message: "Ready public remote state requires current origin and no laptop action." });
      }
      return;
    }
    const validDisabledReason = value.reason === "remote_disabled" || value.reason === "cleanup_incomplete";
    if (
      value.reason === null ||
      !value.laptop_action_required ||
      (value.availability === "disabled"
        ? !validDisabledReason
        : value.reason === "remote_disabled" || value.reason === "cleanup_incomplete")
    ) {
      context.addIssue({ code: "custom", message: "Non-ready public remote state requires one bounded reason and laptop action." });
    }
  });

export const remoteIngressPublicStateSchema = exactDataObject(remoteIngressPublicStateDataSchema);

const remoteMutationRequestShape = {
  operation_id: clientOperationIdSchema,
  confirmed: z.literal(true)
} as const;

export const remoteEnableRequestSchema = exactDataObject(
  z.object(remoteMutationRequestShape).strict()
);
export const remoteDisableRequestSchema = exactDataObject(
  z.object(remoteMutationRequestShape).strict()
);

export function projectRemoteIngressPublicState(
  state: RemoteIngressState
): RemoteIngressPublicState {
  const parsedState = remoteIngressStateSchema.parse(state);
  return remoteIngressPublicStateSchema.parse({
    generation: parsedState.generation,
    availability: parsedState.availability,
    reason: parsedState.availability === "disabled" ? (parsedState.reason ?? "remote_disabled") : parsedState.reason,
    external_origin: parsedState.external_origin,
    laptop_action_required: parsedState.availability !== "ready",
    observed_at: parsedState.observed_at
  });
}

export const tailscaleForwardingHeaderNames = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"] as const;
export const tailscaleStandardIdentityHeaderNames = [
  "tailscale-headers-info",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic"
] as const;
export const tailscaleUntrustedLookalikeHeaderNames = ["x-tailscale-user-login", "x-tailscale-user-name"] as const;
export const tailscaleUntrustedHeaderPrefix = "x-tailscale-" as const;

export const remoteProxyTrustRejectionReasons = [
  "direct_non_loopback",
  "missing_forwarding_header",
  "duplicate_forwarding_header",
  "invalid_forwarded_proto",
  "host_mismatch",
  "origin_mismatch",
  "source_invalid",
  "standard_identity_invalid",
  "untrusted_tailscale_lookalike",
  "remote_generation_stale",
  "unknown_proxy_context"
] as const;

const remoteProxyRequiredForwardingByReason: Partial<
  Record<(typeof remoteProxyTrustRejectionReasons)[number], "absent" | "exact" | "invalid">
> = {
  missing_forwarding_header: "absent",
  duplicate_forwarding_header: "invalid",
  invalid_forwarded_proto: "invalid",
  host_mismatch: "exact",
  origin_mismatch: "exact",
  source_invalid: "invalid",
  standard_identity_invalid: "exact",
  untrusted_tailscale_lookalike: "exact",
  remote_generation_stale: "exact",
  unknown_proxy_context: "exact"
};

const localRequestProvenanceSchema = z
  .object({
    kind: z.literal("local_loopback"),
    transport: z.literal("loopback_http"),
    origin: hostDeckLoopbackOriginSchema,
    remote_generation: z.null(),
    source_key: z.null(),
    tailnet_identity_present: z.literal(false),
    app_authorization: z.literal("not_evaluated")
  })
  .strict();

const remoteRequestProvenanceSchema = z
  .object({
    kind: z.literal("admitted_remote"),
    transport: z.literal("tailscale_serve_https"),
    origin: remoteExternalOriginSchema,
    remote_generation: nonNegativeSafeIntegerSchema,
    source_key: remoteSourceKeySchema,
    tailnet_identity_present: z.boolean(),
    app_authorization: z.literal("not_evaluated")
  })
  .strict();

const requestIngressProvenanceDataSchema = z.discriminatedUnion("kind", [
  localRequestProvenanceSchema,
  remoteRequestProvenanceSchema
]);

export const requestIngressProvenanceSchema = exactDataObject(requestIngressProvenanceDataSchema);

const remoteProxyHeaderAssessmentDataSchema = z
  .object({
    forwarding: z.enum(["absent", "exact", "invalid"]),
    standard_identity: z.enum(["absent", "present", "invalid"]),
    untrusted_lookalike_present: z.boolean()
  })
  .strict();

export const remoteProxyHeaderAssessmentSchema = exactDataObject(remoteProxyHeaderAssessmentDataSchema);

const remoteProxyTrustDecisionDataSchema = z
  .object({
    decision: z.enum(["admitted", "rejected"]),
    provenance: requestIngressProvenanceSchema.nullable(),
    headers: remoteProxyHeaderAssessmentSchema,
    reason: z.enum(remoteProxyTrustRejectionReasons).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "rejected") {
      if (value.provenance !== null || value.reason === null) {
        context.addIssue({ code: "custom", message: "Rejected proxy context cannot produce trusted provenance." });
      }
      if (
        value.headers.untrusted_lookalike_present !== (value.reason === "untrusted_tailscale_lookalike")
      ) {
        addIssue(context, "reason", "Untrusted Tailscale lookalikes require their exact rejection reason.");
      }
      if ((value.headers.standard_identity === "invalid") !== (value.reason === "standard_identity_invalid")) {
        addIssue(context, "reason", "Invalid standard identity headers require their exact rejection reason.");
      }
      const requiredForwarding = value.reason === null ? undefined : remoteProxyRequiredForwardingByReason[value.reason];
      if (requiredForwarding !== undefined && value.headers.forwarding !== requiredForwarding) {
        addIssue(context, "headers", "Proxy rejection reason must match the normalized forwarding-header assessment.");
      }
      return;
    }

    if (value.provenance === null || value.reason !== null || value.headers.untrusted_lookalike_present) {
      context.addIssue({ code: "custom", message: "Admitted proxy context requires trusted provenance and no rejection signal." });
      return;
    }
    if (value.provenance.kind === "local_loopback") {
      if (value.headers.forwarding !== "absent" || value.headers.standard_identity !== "absent") {
        context.addIssue({ code: "custom", message: "Local loopback provenance cannot carry proxy or Tailscale identity headers." });
      }
    } else if (
      value.headers.forwarding !== "exact" ||
      value.headers.standard_identity === "invalid" ||
      (value.headers.standard_identity === "present") !== value.provenance.tailnet_identity_present
    ) {
      context.addIssue({ code: "custom", message: "Admitted remote provenance requires exact forwarding and matching identity presence." });
    }
  });

export const remoteProxyTrustDecisionSchema = exactDataObject(remoteProxyTrustDecisionDataSchema);

const remotePairingLinkIntentDataSchema = z
  .object({
    external_origin: remoteExternalOriginSchema,
    claim_path: z.literal("/pair"),
    code_placement: z.literal("url_fragment"),
    fragment_key: z.literal("code"),
    strip_fragment_before_request: z.literal(true),
    referrer_contains_code: z.literal(false)
  })
  .strict();

export const remotePairingLinkIntentSchema = exactDataObject(remotePairingLinkIntentDataSchema);

export const remoteIngressAuditActions = ["remote_enable", "remote_disable"] as const;

const remoteIngressAuditCommonShape = {
  schema_version: z.literal(1),
  action: z.enum(remoteIngressAuditActions),
  requested_intent: z.enum(remoteIngressIntentStates),
  profile_state: z.enum(remoteProfileStates),
  serve_state: z.enum(remoteServeStates).nullable()
} as const;

const remoteIngressAcceptedAuditSchema = z
  .object({
    ...remoteIngressAuditCommonShape,
    phase: z.literal("accepted"),
    outcome: z.literal("accepted")
  })
  .strict();

const remoteIngressTerminalAuditSchema = z
  .object({
    ...remoteIngressAuditCommonShape,
    phase: z.literal("terminal"),
    outcome: z.enum(selectedAuditOutcomes).exclude(["accepted"]),
    admission: z.enum(remoteIngressAdmissionStates),
    intent_persisted: z.union([z.boolean(), z.literal("unknown")]),
    serve_result: z.enum(["not_attempted", "unchanged", "applied", "removed", "unknown"]),
    reason: z.enum(remoteIngressUnavailableReasons).nullable(),
    reconciliation_reason: z.literal("host_restart_without_terminal").optional()
  })
  .strict();

const remoteIngressAuditSummaryDataSchema = z
  .discriminatedUnion("phase", [remoteIngressAcceptedAuditSchema, remoteIngressTerminalAuditSchema])
  .superRefine((value, context) => {
    const expectedIntent = value.action === "remote_enable" ? "enabled" : "disabled";
    if (value.requested_intent !== expectedIntent) {
      addIssue(context, "requested_intent", "Remote audit action must match its requested intent.");
    }
    if (value.phase === "accepted") {
      if (
        value.profile_state !== "dedicated" ||
        (value.serve_state !== "absent" && value.serve_state !== "exact")
      ) {
        context.addIssue({
          code: "custom",
          message: "Accepted remote mutation requires the dedicated profile and absent or already-exact owned Serve state."
        });
      }
      return;
    }

    if (value.action === "remote_disable" && value.admission !== "closed") {
      addIssue(context, "admission", "Remote disable terminal state must keep admission closed.");
    }
    if (value.action === "remote_enable" && value.outcome !== "succeeded" && value.admission !== "closed") {
      addIssue(context, "admission", "Unsuccessful remote enable cannot leave remote admission open.");
    }
    if (value.action === "remote_enable" && value.reason === "cleanup_incomplete") {
      addIssue(context, "reason", "Serve cleanup failure belongs only to remote disable.");
    }
    if (value.action === "remote_disable" && value.serve_result === "applied") {
      addIssue(context, "serve_result", "Remote disable cannot report an applied Serve mapping.");
    }
    if (value.serve_result === "unknown" && value.outcome !== "incomplete") {
      addIssue(context, "serve_result", "Unknown Serve outcome requires an incomplete terminal audit result.");
    }
    if (value.intent_persisted === "unknown" && value.outcome !== "incomplete") {
      addIssue(context, "intent_persisted", "Unknown intent persistence requires an incomplete terminal audit result.");
    }
    if (
      value.reconciliation_reason !== undefined &&
      (value.outcome !== "incomplete" ||
        value.intent_persisted !== "unknown" ||
        value.serve_result !== "unknown" ||
        value.reason !== "observation_failed")
    ) {
      addIssue(
        context,
        "reconciliation_reason",
        "Restart reconciliation requires an incomplete result with unknown persistence and Serve outcome."
      );
    }
    if (
      value.outcome === "rejected" &&
      (value.admission !== "closed" || value.intent_persisted !== false || value.serve_result !== "not_attempted")
    ) {
      context.addIssue({ code: "custom", message: "Rejected remote operation must be closed, unpersisted, and not attempted." });
    }
    if (
      value.reason === "cleanup_incomplete" &&
      (value.outcome !== "incomplete" || value.intent_persisted !== true || value.serve_result !== "unknown")
    ) {
      addIssue(
        context,
        "reason",
        "Cleanup failure requires persisted disabled intent and an incomplete unknown Serve result."
      );
    }
    if (value.outcome === "succeeded") {
      if (value.reason !== null || value.intent_persisted !== true) {
        context.addIssue({ code: "custom", message: "Successful remote audit terminal requires persisted intent and no error reason." });
      }
      if (value.action === "remote_enable" && (value.admission !== "open" || !["applied", "unchanged"].includes(value.serve_result))) {
        context.addIssue({ code: "custom", message: "Successful remote enable requires open admission and exact Serve result." });
      }
      if (value.action === "remote_enable" && (value.profile_state !== "dedicated" || value.serve_state !== "exact")) {
        context.addIssue({ code: "custom", message: "Successful remote enable requires dedicated-profile exact Serve read-back." });
      }
      if (value.action === "remote_disable" && !["removed", "unchanged"].includes(value.serve_result)) {
        addIssue(context, "serve_result", "Successful remote disable requires removed or already-absent Serve state.");
      }
      if (value.action === "remote_disable" && (value.profile_state !== "dedicated" || value.serve_state !== "absent")) {
        context.addIssue({ code: "custom", message: "Successful remote disable requires dedicated-profile absent Serve read-back." });
      }
    } else if (value.reason === null) {
      addIssue(context, "reason", "Failed, rejected, or incomplete remote audit terminal requires one bounded reason.");
    }
  });

export const remoteIngressAuditSummarySchema = exactDataObject(remoteIngressAuditSummaryDataSchema);

export type RemoteProfileComparison = z.infer<typeof remoteProfileComparisonSchema>;
export type RemoteProfileObservation = z.infer<typeof remoteProfileObservationSchema>;
export type RemoteServeDescriptor = z.infer<typeof remoteServeDescriptorSchema>;
export type RemoteIngressState = z.infer<typeof remoteIngressStateSchema>;
export type RemoteIngressPublicState = z.infer<typeof remoteIngressPublicStateSchema>;
export type RemoteEnableRequest = z.infer<typeof remoteEnableRequestSchema>;
export type RemoteDisableRequest = z.infer<typeof remoteDisableRequestSchema>;
export type RequestIngressProvenance = z.infer<typeof requestIngressProvenanceSchema>;
export type RemoteProxyTrustDecision = z.infer<typeof remoteProxyTrustDecisionSchema>;
export type RemotePairingLinkIntent = z.infer<typeof remotePairingLinkIntentSchema>;
export type RemoteIngressAuditSummary = z.infer<typeof remoteIngressAuditSummarySchema>;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isTailscaleDnsName(hostname: string): boolean {
  const labels = hostname.split(".");
  return (
    hostname.length <= remoteLimits.dnsNameLength &&
    labels.length === 4 &&
    labels.at(-2) === "ts" &&
    labels.at(-1) === "net" &&
    labels.slice(0, -2).every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}

function addIssue(context: z.RefinementCtx, field: string, message: string): void {
  context.addIssue({ code: "custom", message, path: [field] });
}
