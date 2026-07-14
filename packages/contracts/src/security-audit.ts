import {
  type HistoricalSelectedNetworkAuditAction,
  historicalSelectedNetworkAuditActions,
  type PersistedSelectedSecurityAuditAction,
  persistedSelectedSecurityAuditActions,
  type SelectedSecurityAuditAction,
  type SelectedSecurityAuditV1Action,
  selectedAuditOutcomes,
  selectedSecurityAuditActions,
  selectedSecurityAuditV1Actions
} from "@hostdeck/core";
import { z } from "zod";
import { remoteIngressAuditSummarySchema } from "./remote-ingress.js";
import { isoTimestampSchema, positiveSafeIntegerSchema } from "./scalars.js";

const securityAuditIdSchema = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/u);
const permissionSchema = z.enum(["read", "write"]);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const reconciliationReasonSchema = z.literal("host_restart_without_terminal");

const commonSummaryShape = {
  schema_version: z.literal(1),
  reconciliation_reason: reconciliationReasonSchema.optional()
} as const;

const pairRequestSummarySchema = z
  .object({
    ...commonSummaryShape,
    permission: permissionSchema.optional(),
    client_label_present: z.boolean().optional(),
    expires_at: isoTimestampSchema.optional(),
    pairing_id: securityAuditIdSchema.optional()
  })
  .strict();

const pairClaimSummarySchema = z
  .object({
    ...commonSummaryShape,
    permission: permissionSchema.optional(),
    client_label_present: z.boolean().optional(),
    device_created: z.literal(true).optional(),
    device_id: securityAuditIdSchema.optional()
  })
  .strict();

const csrfBootstrapSummarySchema = z
  .object({
    ...commonSummaryShape,
    csrf_generation_before: positiveSafeIntegerSchema.optional(),
    csrf_generation_after: positiveSafeIntegerSchema.optional(),
    rotated: z.literal(true).optional()
  })
  .strict();

const deviceRevokeSummarySchema = z
  .object({
    ...commonSummaryShape,
    previously_revoked: z.boolean().optional(),
    authority_invalidated: z.literal(true).optional()
  })
  .strict();

const lockSummarySchema = z
  .object({
    ...commonSummaryShape,
    requested_locked: z.literal(true).optional(),
    locked: z.literal(true).optional()
  })
  .strict();

const unlockSummarySchema = z
  .object({
    ...commonSummaryShape,
    requested_locked: z.literal(false).optional(),
    locked: z.literal(false).optional()
  })
  .strict();

const lanConfigureSummarySchema = z
  .object({
    ...commonSummaryShape,
    bind_address_family: z.enum(["ipv4", "ipv6", "dns"]).optional(),
    bind_port: z.number().int().min(1).max(65_535).optional(),
    certificate_change_requested: z.boolean().optional(),
    configuration_changed: z.boolean().optional()
  })
  .strict();

const lanEnableSummarySchema = z
  .object({
    ...commonSummaryShape,
    requested_lan_enabled: z.literal(true).optional(),
    lan_enabled: z.literal(true).optional()
  })
  .strict();

const lanDisableSummarySchema = z
  .object({
    ...commonSummaryShape,
    requested_lan_enabled: z.literal(false).optional(),
    lan_enabled: z.literal(false).optional()
  })
  .strict();

const certificateRotateSummarySchema = z
  .object({
    ...commonSummaryShape,
    rotation_requested: z.literal(true).optional(),
    certificate_changed: z.literal(true).optional(),
    certificate_fingerprint_sha256: fingerprintSchema.optional(),
    certificate_expires_at: isoTimestampSchema.optional()
  })
  .strict();

export const selectedSecurityAuditV1PayloadEnvelopeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pair_request"), payload_summary: pairRequestSummarySchema }).strict(),
  z.object({ action: z.literal("pair_claim"), payload_summary: pairClaimSummarySchema }).strict(),
  z.object({ action: z.literal("csrf_bootstrap"), payload_summary: csrfBootstrapSummarySchema }).strict(),
  z.object({ action: z.literal("device_revoke"), payload_summary: deviceRevokeSummarySchema }).strict(),
  z.object({ action: z.literal("lock"), payload_summary: lockSummarySchema }).strict(),
  z.object({ action: z.literal("unlock"), payload_summary: unlockSummarySchema }).strict(),
  z.object({ action: z.literal("lan_configure"), payload_summary: lanConfigureSummarySchema }).strict(),
  z.object({ action: z.literal("lan_enable"), payload_summary: lanEnableSummarySchema }).strict(),
  z.object({ action: z.literal("lan_disable"), payload_summary: lanDisableSummarySchema }).strict(),
  z.object({ action: z.literal("certificate_rotate"), payload_summary: certificateRotateSummarySchema }).strict()
]);

export const selectedSecurityAuditPayloadEnvelopeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pair_request"), payload_summary: pairRequestSummarySchema }).strict(),
  z.object({ action: z.literal("pair_claim"), payload_summary: pairClaimSummarySchema }).strict(),
  z.object({ action: z.literal("csrf_bootstrap"), payload_summary: csrfBootstrapSummarySchema }).strict(),
  z.object({ action: z.literal("device_revoke"), payload_summary: deviceRevokeSummarySchema }).strict(),
  z.object({ action: z.literal("lock"), payload_summary: lockSummarySchema }).strict(),
  z.object({ action: z.literal("unlock"), payload_summary: unlockSummarySchema }).strict(),
  z.object({ action: z.literal("remote_enable"), payload_summary: remoteIngressAuditSummarySchema }).strict(),
  z.object({ action: z.literal("remote_disable"), payload_summary: remoteIngressAuditSummarySchema }).strict()
]);

export const selectedSecurityAuditPayloadContractSchema = z
  .object({
    action: z.enum(selectedSecurityAuditActions),
    phase: z.enum(["accepted", "terminal"]),
    outcome: z.enum(selectedAuditOutcomes),
    payload_summary: z.unknown()
  })
  .strict()
  .superRefine((value, context) => {
    const envelope = selectedSecurityAuditPayloadEnvelopeSchema.safeParse({
      action: value.action,
      payload_summary: value.payload_summary
    });
    if (!envelope.success) {
      context.addIssue({
        code: "custom",
        message: "Security audit payload summary does not match its action contract.",
        path: ["payload_summary"]
      });
      return;
    }

    if (value.action === "remote_enable" || value.action === "remote_disable") {
      const summary = remoteIngressAuditSummarySchema.safeParse(value.payload_summary);
      if (
        !summary.success ||
        summary.data.action !== value.action ||
        summary.data.phase !== value.phase ||
        summary.data.outcome !== value.outcome
      ) {
        context.addIssue({
          code: "custom",
          message: "Remote audit summary action, phase, and outcome must match its durable record.",
          path: ["payload_summary"]
        });
      }
      return;
    }

    const summary = envelope.data.payload_summary as Readonly<Record<string, unknown>>;
    const requirements = summaryRequirements[value.action];
    validateSummaryRequirements(value.phase, value.outcome, summary, requirements, context);
  });

export const selectedSecurityAuditV1PayloadContractSchema = z
  .object({
    action: z.enum(selectedSecurityAuditV1Actions),
    phase: z.enum(["accepted", "terminal"]),
    outcome: z.enum(selectedAuditOutcomes),
    payload_summary: z.unknown()
  })
  .strict()
  .superRefine((value, context) => {
    const envelope = selectedSecurityAuditV1PayloadEnvelopeSchema.safeParse({
      action: value.action,
      payload_summary: value.payload_summary
    });
    if (!envelope.success) {
      context.addIssue({
        code: "custom",
        message: "Version-1 security audit payload summary does not match its action contract.",
        path: ["payload_summary"]
      });
      return;
    }

    const summary = envelope.data.payload_summary as Readonly<Record<string, unknown>>;
    const requirements = summaryRequirements[value.action];
    validateSummaryRequirements(value.phase, value.outcome, summary, requirements, context);
  });

function validateSummaryRequirements(
  phase: "accepted" | "terminal",
  outcome: (typeof selectedAuditOutcomes)[number],
  summary: Readonly<Record<string, unknown>>,
  requirements: SummaryRequirements,
  context: z.RefinementCtx
): void {
    if (phase === "accepted") requireFields(summary, requirements.intent, context);
    if (outcome === "succeeded") requireFields(summary, requirements.success, context);
    else forbidFields(summary, requirements.resultOnly, context);

    if (summary.reconciliation_reason !== undefined && outcome !== "incomplete") {
      context.addIssue({
        code: "custom",
        message: "Only incomplete security audit records may carry a reconciliation reason.",
        path: ["payload_summary", "reconciliation_reason"]
      });
    }
}

interface SummaryRequirements {
  readonly intent: readonly string[];
  readonly success: readonly string[];
  readonly resultOnly: readonly string[];
}

const summaryRequirements = {
  pair_request: {
    intent: ["permission", "client_label_present", "expires_at"],
    success: ["pairing_id"],
    resultOnly: ["pairing_id"]
  },
  pair_claim: {
    intent: ["client_label_present"],
    success: ["permission", "device_created", "device_id"],
    resultOnly: ["device_created", "device_id"]
  },
  csrf_bootstrap: {
    intent: ["csrf_generation_before"],
    success: ["csrf_generation_after", "rotated"],
    resultOnly: ["csrf_generation_after", "rotated"]
  },
  device_revoke: {
    intent: ["previously_revoked"],
    success: ["authority_invalidated"],
    resultOnly: ["authority_invalidated"]
  },
  lock: {
    intent: ["requested_locked"],
    success: ["locked"],
    resultOnly: ["locked"]
  },
  unlock: {
    intent: ["requested_locked"],
    success: ["locked"],
    resultOnly: ["locked"]
  },
  lan_configure: {
    intent: ["bind_address_family", "bind_port", "certificate_change_requested"],
    success: ["configuration_changed"],
    resultOnly: ["configuration_changed"]
  },
  lan_enable: {
    intent: ["requested_lan_enabled"],
    success: ["lan_enabled"],
    resultOnly: ["lan_enabled"]
  },
  lan_disable: {
    intent: ["requested_lan_enabled"],
    success: ["lan_enabled"],
    resultOnly: ["lan_enabled"]
  },
  certificate_rotate: {
    intent: ["rotation_requested"],
    success: ["certificate_changed", "certificate_fingerprint_sha256", "certificate_expires_at"],
    resultOnly: ["certificate_changed", "certificate_fingerprint_sha256", "certificate_expires_at"]
  }
} as const satisfies Record<SelectedSecurityAuditV1Action, SummaryRequirements>;

const securityActionSet = new Set<string>(selectedSecurityAuditActions);
const securityV1ActionSet = new Set<string>(selectedSecurityAuditV1Actions);
const persistedSecurityActionSet = new Set<string>(persistedSelectedSecurityAuditActions);
const historicalNetworkActionSet = new Set<string>(historicalSelectedNetworkAuditActions);

export function isSelectedSecurityAuditAction(candidate: unknown): candidate is SelectedSecurityAuditAction {
  return typeof candidate === "string" && securityActionSet.has(candidate);
}

export function isSelectedSecurityAuditV1Action(candidate: unknown): candidate is SelectedSecurityAuditV1Action {
  return typeof candidate === "string" && securityV1ActionSet.has(candidate);
}

export function isPersistedSelectedSecurityAuditAction(
  candidate: unknown
): candidate is PersistedSelectedSecurityAuditAction {
  return typeof candidate === "string" && persistedSecurityActionSet.has(candidate);
}

export function isHistoricalSelectedNetworkAuditAction(
  candidate: unknown
): candidate is HistoricalSelectedNetworkAuditAction {
  return typeof candidate === "string" && historicalNetworkActionSet.has(candidate);
}

function requireFields(
  summary: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  context: z.RefinementCtx
): void {
  for (const field of fields) {
    if (summary[field] === undefined) {
      context.addIssue({
        code: "custom",
        message: `Security audit payload summary requires ${field}.`,
        path: ["payload_summary", field]
      });
    }
  }
}

function forbidFields(
  summary: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  context: z.RefinementCtx
): void {
  for (const field of fields) {
    if (summary[field] !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Only succeeded security audit records may carry ${field}.`,
        path: ["payload_summary", field]
      });
    }
  }
}

export type SelectedSecurityAuditPayloadEnvelope = z.infer<typeof selectedSecurityAuditPayloadEnvelopeSchema>;
