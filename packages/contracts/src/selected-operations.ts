import {
  operationCapability,
  runtimeCapabilities,
  runtimeCapabilityStates,
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
  positiveSafeIntegerSchema,
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

export const approvalOperationTargetSchema = z
  .object({
    type: z.literal("approval"),
    session_id: sessionIdSchema,
    codex_thread_id: codexThreadIdSchema,
    request_id: runtimeRequestIdSchema
  })
  .strict();

export const turnOperationTargetSchema = z
  .object({
    type: z.literal("turn"),
    session_id: sessionIdSchema,
    codex_thread_id: codexThreadIdSchema,
    turn_id: codexTurnIdSchema
  })
  .strict();

export const selectedOperationTargetSchema = z.discriminatedUnion("type", [
  managedSessionTargetSchema,
  approvalOperationTargetSchema,
  turnOperationTargetSchema
]);

const managedOperationBaseShape = {
  operation_id: clientOperationIdSchema,
  target: managedSessionTargetSchema
};

export const promptOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
    kind: z.literal("prompt"),
    text: z.string().trim().min(1).max(operationLimits.promptLength)
  })
  .strict();

export const modelOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
    kind: z.literal("model"),
    model_id: z.string().min(1).max(operationLimits.modelIdLength),
    reasoning_effort: z.string().min(1).max(operationLimits.effortLength).nullable(),
    expected_pending_revision: positiveSafeIntegerSchema.nullable()
  })
  .strict();

export const goalOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
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
    ...managedOperationBaseShape,
    kind: z.literal("plan"),
    action: z.enum(["enter", "exit"])
  })
  .strict();

export const usageOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
    kind: z.literal("usage")
  })
  .strict();

export const compactOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
    kind: z.literal("compact"),
    confirm: z.literal(true)
  })
  .strict();

export const skillsOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
    kind: z.literal("skills")
  })
  .strict();

export const approvalResponseOperationIntentSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    target: approvalOperationTargetSchema,
    kind: z.literal("approval_response"),
    decision: z.enum(["approve", "deny"]),
    confirm: z.literal(true)
  })
  .strict();

export const interruptOperationIntentSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    target: turnOperationTargetSchema,
    kind: z.literal("interrupt"),
    confirm: z.literal(true)
  })
  .strict();

export const archiveOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
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
    target: approvalOperationTargetSchema,
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
  target: selectedOperationTargetSchema
};

export const selectedOperationAcceptedSchema = z
  .object({
    ...operationReceiptBaseShape,
    state: z.literal("accepted"),
    accepted_at: isoTimestampSchema,
    audit_record_id: z.string().min(1).max(120)
  })
  .strict()
  .superRefine(assertOperationTargetMatchesKind);

export const selectedOperationRejectedSchema = z
  .object({
    ...operationReceiptBaseShape,
    state: z.literal("rejected"),
    rejected_at: isoTimestampSchema,
    error: apiErrorEnvelopeSchema
  })
  .strict()
  .superRefine(assertOperationTargetMatchesKind);

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
    assertOperationTargetMatchesKind(value, context);
    assertOperationTurnIdentity(value, context);
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
    assertOperationTargetMatchesKind(value, context);
    assertOperationTurnIdentity(value, context);
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
    capability_state: z.enum(runtimeCapabilityStates),
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
    if (["available", "blocked"].includes(value.availability) && value.capability_state !== "available") {
      context.addIssue({ code: "custom", message: "Available or policy-blocked controls require an available capability." });
    }
    if (value.availability === "unsupported" && value.capability_state !== "unavailable") {
      context.addIssue({ code: "custom", message: "Unsupported controls require an unavailable capability." });
    }
    if (value.availability === "unknown" && value.capability_state !== "unknown") {
      context.addIssue({ code: "custom", message: "Unknown controls require an unknown capability state." });
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

export const modelReasoningEffortSchema = z
  .object({
    id: z.string().min(1).max(operationLimits.modelIdLength),
    description: z.string().max(operationLimits.summaryLength).nullable(),
    is_default: z.boolean()
  })
  .strict();

export const modelCatalogEntrySchema = z
  .object({
    id: z.string().min(1).max(operationLimits.modelIdLength),
    runtime_model: z.string().min(1).max(operationLimits.modelIdLength),
    label: z.string().min(1).max(operationLimits.modelIdLength),
    description: z.string().max(operationLimits.summaryLength).nullable(),
    is_default: z.boolean(),
    input_modalities: z.array(z.enum(["text", "image"])).min(1).max(2),
    reasoning_efforts: z.array(modelReasoningEffortSchema).min(1).max(16)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.input_modalities).size !== value.input_modalities.length) {
      context.addIssue({ code: "custom", message: "Model input modalities must be unique." });
    }
    if (new Set(value.reasoning_efforts.map((effort) => effort.id)).size !== value.reasoning_efforts.length) {
      context.addIssue({ code: "custom", message: "Model reasoning efforts must be unique." });
    }
    if (value.reasoning_efforts.filter((effort) => effort.is_default).length !== 1) {
      context.addIssue({ code: "custom", message: "Each model must expose exactly one default reasoning effort." });
    }
  });

export const currentModelSelectionSchema = z
  .object({
    model_id: z.string().min(1).max(operationLimits.modelIdLength).nullable(),
    runtime_model: z.string().min(1).max(operationLimits.modelIdLength),
    reasoning_effort: z.string().min(1).max(operationLimits.effortLength).nullable(),
    catalog_state: z.enum(["available", "unknown"]),
    observed_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.catalog_state === "available" && value.model_id === null) {
      context.addIssue({ code: "custom", message: "Available current models require a catalog model id." });
    }
    if (value.catalog_state === "unknown" && value.model_id !== null) {
      context.addIssue({ code: "custom", message: "Unknown current models cannot claim a catalog model id." });
    }
  });

export const pendingModelSelectionSchema = z
  .object({
    revision: positiveSafeIntegerSchema,
    selection_operation_id: clientOperationIdSchema,
    model_id: z.string().min(1).max(operationLimits.modelIdLength),
    runtime_model: z.string().min(1).max(operationLimits.modelIdLength),
    reasoning_effort: z.string().min(1).max(operationLimits.effortLength),
    catalog_state: z.enum(["available", "unknown"]),
    phase: z.enum(["pending", "dispatching", "awaiting_confirmation", "unknown", "conflict"]),
    selected_at: isoTimestampSchema,
    turn_id: codexTurnIdSchema.nullable(),
    error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (["pending", "dispatching"].includes(value.phase) && value.turn_id !== null) {
      context.addIssue({ code: "custom", message: "Undispatched model selections cannot claim a turn id." });
    }
    if (value.phase === "awaiting_confirmation" && value.turn_id === null) {
      context.addIssue({ code: "custom", message: "Accepted model selections require the exact turn id." });
    }
    if (["unknown", "conflict"].includes(value.phase) !== (value.error !== null)) {
      context.addIssue({ code: "custom", message: "Only unknown or conflicting model selections require an error." });
    }
    if (value.catalog_state === "unknown" && !["unknown", "conflict"].includes(value.phase)) {
      context.addIssue({ code: "custom", message: "Unavailable pending catalog entries must expose an unknown or conflict phase." });
    }
  });

export const modelControlSnapshotSchema = z
  .object({
    catalog_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    catalog_observed_at: isoTimestampSchema,
    current: currentModelSelectionSchema,
    pending: pendingModelSelectionSchema.nullable(),
    models: z.array(modelCatalogEntrySchema).max(128)
  })
  .strict()
  .superRefine((value, context) => {
    const modelIds = new Set(value.models.map((model) => model.id));
    if (modelIds.size !== value.models.length) {
      context.addIssue({ code: "custom", message: "Model catalogs cannot contain duplicate model ids." });
    }
    if (new Set(value.models.map((model) => model.runtime_model)).size !== value.models.length) {
      context.addIssue({ code: "custom", message: "Model catalogs cannot contain duplicate runtime model names." });
    }
    if (value.models.filter((model) => model.is_default).length !== 1) {
      context.addIssue({ code: "custom", message: "Model catalogs must expose exactly one default model." });
    }
    const current = value.models.find((model) => model.id === value.current.model_id);
    if (value.current.catalog_state === "available" && current?.runtime_model !== value.current.runtime_model) {
      context.addIssue({ code: "custom", message: "Current model identity must match the runtime catalog." });
    }
    if (
      value.current.catalog_state === "available" &&
      value.current.reasoning_effort !== null &&
      current !== undefined &&
      !current.reasoning_efforts.some((effort) => effort.id === value.current.reasoning_effort)
    ) {
      context.addIssue({ code: "custom", message: "Current reasoning effort must be offered by its catalog model." });
    }
    if (value.pending !== null) {
      const pending = value.models.find((model) => model.id === value.pending?.model_id);
      if (value.pending.catalog_state === "available" && pending?.runtime_model !== value.pending.runtime_model) {
        context.addIssue({ code: "custom", message: "Pending model identity must match the current runtime catalog." });
      }
      if (
        value.pending.catalog_state === "available" &&
        !pending?.reasoning_efforts.some((effort) => effort.id === value.pending?.reasoning_effort)
      ) {
        context.addIssue({ code: "custom", message: "Pending reasoning effort must be offered by its catalog model." });
      }
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
    limit: positiveSafeIntegerSchema.max(500).optional()
  })
  .strict();

export type ManagedSessionTarget = z.infer<typeof managedSessionTargetSchema>;
export type ApprovalOperationTarget = z.infer<typeof approvalOperationTargetSchema>;
export type TurnOperationTarget = z.infer<typeof turnOperationTargetSchema>;
export type SelectedOperationTarget = z.infer<typeof selectedOperationTargetSchema>;
export type SelectedOperationIntent = z.infer<typeof selectedOperationIntentSchema>;
export type SelectedOperationDispatch = z.infer<typeof selectedOperationDispatchSchema>;
export type SelectedOperationTerminalOutcome = z.infer<typeof selectedOperationTerminalOutcomeSchema>;
export type SelectedOperationProgress = z.infer<typeof selectedOperationProgressSchema>;
export type SelectedControlState = z.infer<typeof selectedControlStateSchema>;
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;
export type ModelControlSnapshot = z.infer<typeof modelControlSnapshotSchema>;
export type PendingModelSelection = z.infer<typeof pendingModelSelectionSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type SelectedStartSessionRequest = z.infer<typeof selectedStartSessionRequestSchema>;

export function selectedOperationKind(intent: SelectedOperationIntent): SelectedOperationKind {
  return intent.kind;
}

function assertOperationTargetMatchesKind(
  value: { readonly kind: SelectedOperationKind; readonly target: SelectedOperationTarget },
  context: z.RefinementCtx
): void {
  const expectedTarget = value.kind === "approval_response" ? "approval" : value.kind === "interrupt" ? "turn" : "managed_session";
  if (value.target.type !== expectedTarget) {
    context.addIssue({
      code: "custom",
      message: `${value.kind} operations require one ${expectedTarget} target.`,
      path: ["target"]
    });
  }
}

function assertOperationTurnIdentity(
  value: { readonly kind: SelectedOperationKind; readonly target: SelectedOperationTarget; readonly turn_id: z.infer<typeof codexTurnIdSchema> | null },
  context: z.RefinementCtx
): void {
  if (value.kind === "interrupt" && value.target.type === "turn" && value.turn_id !== value.target.turn_id) {
    context.addIssue({
      code: "custom",
      message: "Interrupt outcomes must preserve the exact targeted turn id.",
      path: ["turn_id"]
    });
  }
}
