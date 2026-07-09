import {
  operationCapability,
  runtimeCapabilities,
  type SelectedOperationKind, 
  selectedAuditOutcomes,
  selectedOperationKinds,
  structuredControlKinds
} from "@hostdeck/core";
import { z } from "zod";
import { apiErrorEnvelopeSchema } from "./api.js";
import {
  absoluteCwdSchema,
  isoTimestampSchema,
  outputCursorSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";
import {
  clientOperationIdSchema,
  codexThreadIdSchema,
  codexTurnIdSchema,
  goalCueSchema,
  managedSessionProjectionSchema,
  runtimeRequestIdSchema
} from "./selected-runtime.js";

const operationLimits = {
  promptLength: 20_000,
  modelIdLength: 160,
  effortLength: 80,
  goalLength: 512,
  summaryLength: 512,
  approvalFieldLength: 1_000,
  skillNameLength: 160,
  skillDescriptionLength: 512,
  quotaLabelLength: 120
} as const;

export const managedSessionTargetSchema = z
  .object({
    type: z.literal("managed_session"),
    session_id: sessionIdSchema,
    codex_thread_id: codexThreadIdSchema
  })
  .strict();

const operationBaseShape = {
  operation_id: clientOperationIdSchema,
  target: managedSessionTargetSchema
};

export const promptOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("prompt"),
    text: z.string().trim().min(1).max(operationLimits.promptLength)
  })
  .strict();

export const modelOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("model"),
    model_id: z.string().min(1).max(operationLimits.modelIdLength),
    reasoning_effort: z.string().min(1).max(operationLimits.effortLength).nullable()
  })
  .strict();

export const goalOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("goal"),
    action: z.enum(["set", "pause", "resume", "complete", "clear"]),
    objective: z.string().trim().min(1).max(operationLimits.goalLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "set" && value.objective === null) {
      context.addIssue({ code: "custom", message: "Setting a goal requires an objective." });
    }
    if (value.action !== "set" && value.objective !== null) {
      context.addIssue({ code: "custom", message: "Only the set goal action may carry an objective." });
    }
  });

export const planOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("plan"),
    action: z.enum(["enter", "exit"])
  })
  .strict();

export const usageOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("usage")
  })
  .strict();

export const compactOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("compact"),
    confirm: z.literal(true)
  })
  .strict();

export const skillsOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("skills")
  })
  .strict();

export const approvalResponseOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("approval_response"),
    request_id: runtimeRequestIdSchema,
    decision: z.enum(["approve", "deny"]),
    confirm: z.literal(true)
  })
  .strict();

export const interruptOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("interrupt"),
    turn_id: codexTurnIdSchema,
    confirm: z.literal(true)
  })
  .strict();

export const archiveOperationIntentSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal("archive"),
    confirm: z.literal(true)
  })
  .strict();

export const selectedOperationIntentSchema = z.discriminatedUnion("kind", [
  promptOperationIntentSchema,
  modelOperationIntentSchema,
  goalOperationIntentSchema,
  planOperationIntentSchema,
  usageOperationIntentSchema,
  compactOperationIntentSchema,
  skillsOperationIntentSchema,
  approvalResponseOperationIntentSchema,
  interruptOperationIntentSchema,
  archiveOperationIntentSchema
]);

export const pendingApprovalSchema = z
  .object({
    target: managedSessionTargetSchema,
    request_id: runtimeRequestIdSchema,
    action: z.string().min(1).max(operationLimits.approvalFieldLength),
    scope: z.string().min(1).max(operationLimits.approvalFieldLength),
    reason: z.string().max(operationLimits.approvalFieldLength).nullable(),
    risk: z.enum(["normal", "elevated", "broad"]),
    grant_scope: z.enum(["one_time", "session"]),
    state: z.enum(["pending", "responding", "approved", "denied", "expired", "superseded"]),
    created_at: isoTimestampSchema,
    expires_at: isoTimestampSchema.nullable(),
    decision: z.enum(["approve", "deny"]).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (["pending", "responding"].includes(value.state) && value.decision !== null) {
      context.addIssue({ code: "custom", message: "Unresolved approvals must not carry a terminal decision." });
    }
    if (value.state === "approved" && value.decision !== "approve") {
      context.addIssue({ code: "custom", message: "Approved requests must record the approve decision." });
    }
    if (value.state === "denied" && value.decision !== "deny") {
      context.addIssue({ code: "custom", message: "Denied requests must record the deny decision." });
    }
    if (["expired", "superseded"].includes(value.state) && value.decision !== null) {
      context.addIssue({ code: "custom", message: "Expired or superseded requests must not invent a decision." });
    }
  });

const operationReceiptBaseShape = {
  operation_id: clientOperationIdSchema,
  kind: z.enum(selectedOperationKinds),
  target: managedSessionTargetSchema
};

export const selectedOperationAcceptedSchema = z
  .object({
    ...operationReceiptBaseShape,
    state: z.literal("accepted"),
    accepted_at: isoTimestampSchema,
    audit_record_id: z.string().min(1).max(120)
  })
  .strict();

export const selectedOperationRejectedSchema = z
  .object({
    ...operationReceiptBaseShape,
    state: z.literal("rejected"),
    rejected_at: isoTimestampSchema,
    error: apiErrorEnvelopeSchema
  })
  .strict();

export const selectedOperationDispatchSchema = z.discriminatedUnion("state", [
  selectedOperationAcceptedSchema,
  selectedOperationRejectedSchema
]);

export const selectedOperationTerminalOutcomeSchema = z
  .object({
    ...operationReceiptBaseShape,
    state: z.enum(selectedAuditOutcomes).exclude(["accepted", "rejected"]),
    finished_at: isoTimestampSchema,
    turn_id: codexTurnIdSchema.nullable(),
    result_summary: z.string().max(operationLimits.summaryLength).nullable(),
    error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "succeeded" && value.error !== null) {
      context.addIssue({ code: "custom", message: "Succeeded operations must not carry an error." });
    }
    if (value.state !== "succeeded" && value.error === null) {
      context.addIssue({ code: "custom", message: "Failed or incomplete operations must preserve a bounded cause." });
    }
  });

export const selectedOperationProgressSchema = z
  .object({
    ...operationReceiptBaseShape,
    state: z.enum(["accepted", "running", "completed", "interrupted", "failed", "incomplete"]),
    updated_at: isoTimestampSchema,
    turn_id: codexTurnIdSchema.nullable(),
    error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (["failed", "incomplete"].includes(value.state) && value.error === null) {
      context.addIssue({ code: "custom", message: "Failed or incomplete operation progress must preserve a bounded cause." });
    }
    if (!["failed", "incomplete"].includes(value.state) && value.error !== null) {
      context.addIssue({ code: "custom", message: "Only failed or incomplete operation progress may carry an error." });
    }
  });

export const selectedControlStateSchema = z
  .object({
    control: z.enum(structuredControlKinds),
    capability: z.enum(runtimeCapabilities),
    availability: z.enum(["available", "unsupported", "unknown", "blocked"]),
    phase: z.enum(["idle", "loading", "success", "failure", "conflict"]),
    current_value: z.string().max(operationLimits.summaryLength).nullable(),
    disabled_reason: z.string().min(1).max(240).nullable(),
    error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.capability !== operationCapability(value.control)) {
      context.addIssue({ code: "custom", message: "Control state capability does not match its structured control." });
    }
    if (value.availability === "available" && value.disabled_reason !== null) {
      context.addIssue({ code: "custom", message: "Available controls must not carry a disabled reason." });
    }
    if (value.availability !== "available" && value.disabled_reason === null) {
      context.addIssue({ code: "custom", message: "Unavailable controls must explain why they are disabled." });
    }
    if (value.phase === "failure" && value.error === null) {
      context.addIssue({ code: "custom", message: "Failed controls must preserve a bounded error." });
    }
    if (value.phase !== "failure" && value.error !== null) {
      context.addIssue({ code: "custom", message: "Only failed controls may carry an error." });
    }
  });

export const modelCatalogEntrySchema = z
  .object({
    id: z.string().min(1).max(operationLimits.modelIdLength),
    label: z.string().min(1).max(operationLimits.modelIdLength),
    description: z.string().max(operationLimits.summaryLength).nullable(),
    reasoning_efforts: z.array(z.string().min(1).max(operationLimits.effortLength)).max(16)
  })
  .strict();

export const modelControlSnapshotSchema = z
  .object({
    selected_model_id: z.string().min(1).max(operationLimits.modelIdLength).nullable(),
    selected_reasoning_effort: z.string().min(1).max(operationLimits.effortLength).nullable(),
    models: z.array(modelCatalogEntrySchema).max(128)
  })
  .strict()
  .superRefine((value, context) => {
    const modelIds = new Set(value.models.map((model) => model.id));
    if (modelIds.size !== value.models.length) {
      context.addIssue({ code: "custom", message: "Model catalogs cannot contain duplicate model ids." });
    }
    const selected = value.models.find((model) => model.id === value.selected_model_id);
    if (value.selected_model_id !== null && selected === undefined) {
      context.addIssue({ code: "custom", message: "Selected model id must exist in the runtime model catalog." });
    }
    if (value.selected_model_id === null && value.selected_reasoning_effort !== null) {
      context.addIssue({ code: "custom", message: "Reasoning effort cannot be selected without a model." });
    }
    if (
      value.selected_reasoning_effort !== null &&
      selected !== undefined &&
      !selected.reasoning_efforts.includes(value.selected_reasoning_effort)
    ) {
      context.addIssue({ code: "custom", message: "Selected reasoning effort must be offered by the selected model." });
    }
  });

export const goalControlSnapshotSchema = goalCueSchema.nullable();

export const planControlSnapshotSchema = z
  .object({
    mode: z.enum(["default", "plan"]),
    state: z.enum(["idle", "active", "complete", "failed", "unsupported"]),
    summary: z.string().max(operationLimits.summaryLength).nullable()
  })
  .strict();

export const usageSnapshotSchema = z
  .object({
    measured_at: isoTimestampSchema,
    quotas: z
      .array(
        z
          .object({
            label: z.string().min(1).max(operationLimits.quotaLabelLength),
            used_percent: z.number().min(0).max(100).nullable(),
            resets_at: isoTimestampSchema.nullable(),
            unlimited: z.boolean()
          })
          .strict()
      )
      .max(16)
  })
  .strict()
  .superRefine((value, context) => {
    const labels = new Set(value.quotas.map((quota) => quota.label));
    if (labels.size !== value.quotas.length) {
      context.addIssue({ code: "custom", message: "Usage snapshots cannot contain duplicate quota labels." });
    }
    for (const [index, quota] of value.quotas.entries()) {
      if (quota.unlimited && (quota.used_percent !== null || quota.resets_at !== null)) {
        context.addIssue({
          code: "custom",
          message: "Unlimited usage quotas must not invent utilization or reset data.",
          path: ["quotas", index]
        });
      }
      if (!quota.unlimited && quota.used_percent === null) {
        context.addIssue({
          code: "custom",
          message: "Limited usage quotas must expose bounded utilization.",
          path: ["quotas", index, "used_percent"]
        });
      }
    }
  });

export const skillSummarySchema = z
  .object({
    name: z.string().min(1).max(operationLimits.skillNameLength),
    description: z.string().max(operationLimits.skillDescriptionLength).nullable(),
    enabled: z.boolean()
  })
  .strict();

export const skillsSnapshotSchema = z
  .object({
    skills: z.array(skillSummarySchema).max(256)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.skills.map((skill) => skill.name)).size !== value.skills.length) {
      context.addIssue({ code: "custom", message: "Skill snapshots cannot contain duplicate skill names." });
    }
  });

export const selectedStartSessionRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    name: sessionNameSchema,
    cwd: absoluteCwdSchema
  })
  .strict();

export const selectedSessionListResponseSchema = z
  .object({
    sessions: z.array(managedSessionProjectionSchema)
  })
  .strict();

export const selectedSessionDetailResponseSchema = z
  .object({
    session: managedSessionProjectionSchema,
    pending_approvals: z.array(pendingApprovalSchema).max(64)
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, approval] of value.pending_approvals.entries()) {
      if (approval.target.session_id !== value.session.id || approval.target.codex_thread_id !== value.session.codex_thread_id) {
        context.addIssue({
          code: "custom",
          message: "Session detail approvals must target the selected session and thread.",
          path: ["pending_approvals", index, "target"]
        });
      }
    }
  });

export const selectedEventQuerySchema = z
  .object({
    after: outputCursorSchema.optional(),
    limit: z.number().int().positive().max(500).optional()
  })
  .strict();

export type ManagedSessionTarget = z.infer<typeof managedSessionTargetSchema>;
export type SelectedOperationIntent = z.infer<typeof selectedOperationIntentSchema>;
export type SelectedOperationDispatch = z.infer<typeof selectedOperationDispatchSchema>;
export type SelectedOperationTerminalOutcome = z.infer<typeof selectedOperationTerminalOutcomeSchema>;
export type SelectedOperationProgress = z.infer<typeof selectedOperationProgressSchema>;
export type SelectedControlState = z.infer<typeof selectedControlStateSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type SelectedStartSessionRequest = z.infer<typeof selectedStartSessionRequestSchema>;

export function selectedOperationKind(intent: SelectedOperationIntent): SelectedOperationKind {
  return intent.kind;
}
