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
  nonNegativeSafeIntegerSchema,
  outputCursorSchema,
  positiveSafeIntegerSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";
import {
  clientOperationIdSchema,
  codexModelContractLimits,
  codexThreadIdSchema,
  codexTurnIdSchema,
  codexVersionSchema,
  managedSessionProjectionSchema,
  runtimeRequestIdSchema
} from "./selected-runtime.js";

const operationLimits = {
  promptLength: 20_000,
  modelIdLength: codexModelContractLimits.identityLength,
  effortLength: codexModelContractLimits.reasoningEffortLength,
  goalLength: 512,
  summaryLength: 512,
  approvalFieldLength: 1_000,
  skillNameLength: 160,
  skillDescriptionLength: 4_096
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

const promptTextSchema = z.string().trim().min(1).max(operationLimits.promptLength);

export const promptOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
    kind: z.literal("prompt"),
    text: promptTextSchema
  })
  .strict();

export const promptSessionRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    kind: z.literal("prompt"),
    text: promptTextSchema
  })
  .strict();

export const promptDispatchResponseSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    kind: z.literal("prompt"),
    target: managedSessionTargetSchema,
    state: z.literal("accepted"),
    accepted_at: isoTimestampSchema,
    audit_record_id: z.string().min(1).max(120),
    turn_id: codexTurnIdSchema,
    action: z.enum(["start", "steer"])
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

export const modelSelectionRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
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
    objective: z.string().trim().min(1).max(operationLimits.goalLength).nullable(),
    expected_goal_revision: z.string().regex(/^[a-f0-9]{64}$/u).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "set" && value.objective === null) {
      context.addIssue({ code: "custom", message: "Setting a goal requires an objective." });
    }
    if (value.action !== "set" && value.objective !== null) {
      context.addIssue({ code: "custom", message: "Only the set goal action may carry an objective." });
    }
    if (value.action !== "set" && value.expected_goal_revision === null) {
      context.addIssue({ code: "custom", message: "Existing-goal actions require the observed goal revision." });
    }
  });

export const goalMutationRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    kind: z.literal("goal"),
    action: z.enum(["set", "pause", "resume", "complete", "clear"]),
    objective: z.string().trim().min(1).max(operationLimits.goalLength).nullable(),
    expected_goal_revision: z.string().regex(/^[a-f0-9]{64}$/u).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "set" && value.objective === null) {
      context.addIssue({ code: "custom", message: "Setting a goal requires an objective." });
    }
    if (value.action !== "set" && value.objective !== null) {
      context.addIssue({ code: "custom", message: "Only the set goal action may carry an objective." });
    }
    if (value.action !== "set" && value.expected_goal_revision === null) {
      context.addIssue({ code: "custom", message: "Existing-goal actions require the observed goal revision." });
    }
  });

export const planOperationIntentSchema = z
  .object({
    ...managedOperationBaseShape,
    kind: z.literal("plan"),
    action: z.enum(["enter", "exit"]),
    expected_pending_revision: positiveSafeIntegerSchema.nullable()
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

export const archiveSessionRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
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

export const promptTurnControlSnapshotSchema = z
  .object({
    phase: z.enum(["idle", "starting", "accepted", "steerable", "steering", "unknown", "conflict"]),
    last_action: z.enum(["start", "steer"]).nullable(),
    operation_id: clientOperationIdSchema.nullable(),
    turn_id: codexTurnIdSchema.nullable(),
    model_revision: positiveSafeIntegerSchema.nullable(),
    plan_revision: positiveSafeIntegerSchema.nullable(),
    requested_at: isoTimestampSchema.nullable(),
    accepted_at: isoTimestampSchema.nullable(),
    started_at: isoTimestampSchema.nullable(),
    error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const idleShape =
      value.last_action === null &&
      value.operation_id === null &&
      value.turn_id === null &&
      value.model_revision === null &&
      value.plan_revision === null &&
      value.requested_at === null &&
      value.accepted_at === null &&
      value.started_at === null &&
      value.error === null;
    if ((value.phase === "idle") !== idleShape) {
      context.addIssue({ code: "custom", message: "Idle prompt control cannot claim a turn operation or outcome." });
    }
    if (
      value.phase !== "idle" &&
      (value.last_action === null || value.operation_id === null || value.requested_at === null)
    ) {
      context.addIssue({ code: "custom", message: "Non-idle prompt control requires one exact operation and request time." });
    }
    if (value.phase === "starting" && (value.last_action !== "start" || value.turn_id !== null || value.accepted_at !== null)) {
      context.addIssue({ code: "custom", message: "Starting prompt control cannot claim an accepted turn." });
    }
    if ((value.turn_id === null) !== (value.accepted_at === null)) {
      context.addIssue({ code: "custom", message: "Prompt acceptance time and exact turn identity must appear together." });
    }
    if (["accepted", "steerable", "steering"].includes(value.phase) && (value.turn_id === null || value.accepted_at === null)) {
      context.addIssue({ code: "custom", message: "Accepted prompt control requires the exact accepted turn." });
    }
    if (["steerable", "steering"].includes(value.phase) && value.started_at === null) {
      context.addIssue({ code: "custom", message: "Steerable prompt control requires matching turn-start evidence." });
    }
    if (value.phase === "accepted" && value.started_at !== null) {
      context.addIssue({ code: "custom", message: "Accepted-only prompt control cannot claim turn-start evidence." });
    }
    if (value.started_at !== null && (value.turn_id === null || value.accepted_at === null)) {
      context.addIssue({ code: "custom", message: "Prompt turn-start evidence requires prior exact acceptance." });
    }
    if (value.phase === "accepted" && value.last_action !== "start") {
      context.addIssue({ code: "custom", message: "Accepted-only prompt state must come from turn start." });
    }
    if (value.phase === "steering" && value.last_action !== "steer") {
      context.addIssue({ code: "custom", message: "Steering prompt state must come from turn steer." });
    }
    if (
      value.phase === "conflict" &&
      (value.last_action !== "steer" || value.turn_id === null || value.accepted_at === null || value.started_at === null)
    ) {
      context.addIssue({ code: "custom", message: "Prompt conflict must retain the exact event-proven steer target." });
    }
    if (
      value.phase === "unknown" &&
      value.last_action === "steer" &&
      (value.turn_id === null || value.accepted_at === null || value.started_at === null)
    ) {
      context.addIssue({ code: "custom", message: "Unknown prompt steer must retain the exact event-proven target." });
    }
    if (
      value.last_action === "start" &&
      value.requested_at !== null &&
      value.accepted_at !== null &&
      value.accepted_at < value.requested_at
    ) {
      context.addIssue({ code: "custom", message: "Prompt acceptance cannot predate its request." });
    }
    if (value.accepted_at !== null && value.started_at !== null && value.started_at < value.accepted_at) {
      context.addIssue({ code: "custom", message: "Prompt turn-start evidence cannot predate acceptance tracking." });
    }
    if (["unknown", "conflict"].includes(value.phase) !== (value.error !== null)) {
      context.addIssue({ code: "custom", message: "Only unknown or conflicting prompt control requires an error." });
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

export const goalRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const goalControlValueSchema = z
  .object({
    revision: goalRevisionSchema,
    objective: z.string().min(1).max(4_000),
    status: z.enum(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]),
    token_budget: nonNegativeSafeIntegerSchema.nullable(),
    tokens_used: nonNegativeSafeIntegerSchema,
    time_used_seconds: z.number().finite().min(0),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updated_at < value.created_at) {
      context.addIssue({ code: "custom", message: "Goal update time cannot precede creation time." });
    }
  });

export const uncertainGoalMutationSchema = z
  .object({
    action: z.enum(["set", "pause", "resume", "complete", "clear"]),
    phase: z.enum(["unknown", "conflict"]),
    requested_at: isoTimestampSchema,
    baseline_revision: goalRevisionSchema.nullable(),
    requested_objective: z.string().min(1).max(operationLimits.goalLength).nullable(),
    requested_status: z.enum(["active", "paused", "complete"]).nullable(),
    error: apiErrorEnvelopeSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "set" && (value.requested_objective === null || value.requested_status !== "paused")) {
      context.addIssue({ code: "custom", message: "Uncertain goal set must preserve its paused objective intent." });
    }
    if (value.action !== "set" && value.requested_objective !== null) {
      context.addIssue({ code: "custom", message: "Only uncertain goal set may preserve an objective." });
    }
    const expectedStatus = value.action === "pause" ? "paused" : value.action === "resume" ? "active" : value.action === "complete" ? "complete" : null;
    if (value.action !== "set" && value.requested_status !== expectedStatus) {
      context.addIssue({ code: "custom", message: "Uncertain goal mutation status does not match its action." });
    }
  });

export const goalControlSnapshotSchema = z
  .object({
    goal: goalControlValueSchema.nullable(),
    uncertain_mutation: uncertainGoalMutationSchema.nullable()
  })
  .strict();

export const planModeSchema = z.enum(["default", "plan"]);

export const planModeCatalogEntrySchema = z
  .object({
    name: z.string().min(1).max(80),
    mode: planModeSchema,
    preset_model: z.string().min(1).max(operationLimits.modelIdLength).nullable(),
    preset_reasoning_effort: z.string().min(1).max(operationLimits.effortLength).nullable()
  })
  .strict();

export const currentPlanModeSchema = z
  .object({
    state: z.enum(["confirmed", "unknown"]),
    mode: planModeSchema.nullable(),
    runtime_model: z.string().min(1).max(operationLimits.modelIdLength).nullable(),
    reasoning_effort: z.string().min(1).max(operationLimits.effortLength).nullable(),
    observed_at: isoTimestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const confirmedFieldsPresent = value.mode !== null && value.runtime_model !== null && value.observed_at !== null;
    if ((value.state === "confirmed") !== confirmedFieldsPresent) {
      context.addIssue({ code: "custom", message: "Confirmed Plan mode requires one complete settings observation." });
    }
    if (
      value.state === "unknown" &&
      (value.mode !== null || value.runtime_model !== null || value.reasoning_effort !== null || value.observed_at !== null)
    ) {
      context.addIssue({ code: "custom", message: "Unknown Plan mode cannot claim partially observed settings." });
    }
  });

export const resolvedPlanSettingsSchema = z
  .object({
    runtime_model: z.string().min(1).max(operationLimits.modelIdLength),
    reasoning_effort: z.string().min(1).max(operationLimits.effortLength).nullable()
  })
  .strict();

export const pendingPlanSelectionSchema = z
  .object({
    revision: positiveSafeIntegerSchema,
    selection_operation_id: clientOperationIdSchema,
    mode: planModeSchema,
    catalog_state: z.enum(["available", "unknown"]),
    phase: z.enum(["pending", "dispatching", "awaiting_confirmation", "unknown", "conflict"]),
    selected_at: isoTimestampSchema,
    turn_id: codexTurnIdSchema.nullable(),
    resolved_settings: resolvedPlanSettingsSchema.nullable(),
    error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (["pending", "dispatching"].includes(value.phase) && value.turn_id !== null) {
      context.addIssue({ code: "custom", message: "Unaccepted Plan selections cannot claim a turn id." });
    }
    if (value.phase === "pending" && value.resolved_settings !== null) {
      context.addIssue({ code: "custom", message: "Undispatched Plan selections cannot claim resolved turn settings." });
    }
    if (["dispatching", "awaiting_confirmation", "unknown"].includes(value.phase) && value.resolved_settings === null) {
      context.addIssue({ code: "custom", message: "Dispatched Plan selections must preserve their resolved turn settings." });
    }
    if (value.phase === "awaiting_confirmation" && value.turn_id === null) {
      context.addIssue({ code: "custom", message: "Accepted Plan selections require the exact turn id." });
    }
    if (["unknown", "conflict"].includes(value.phase) !== (value.error !== null)) {
      context.addIssue({ code: "custom", message: "Only unknown or conflicting Plan selections require an error." });
    }
    if (value.catalog_state === "unknown" && !["unknown", "conflict"].includes(value.phase)) {
      context.addIssue({ code: "custom", message: "Unavailable Plan catalog entries must expose an unknown or conflict phase." });
    }
  });

export const planExecutionSnapshotSchema = z
  .object({
    turn_id: codexTurnIdSchema.nullable(),
    state: z.enum(["idle", "awaiting_evidence", "active", "complete", "failed", "interrupted", "unknown"]),
    evidence: z.enum(["none", "plan_update", "plan_item", "plan_delta"]),
    summary: z.string().max(operationLimits.summaryLength).nullable(),
    updated_at: isoTimestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const idleShape = value.turn_id === null && value.evidence === "none" && value.summary === null && value.updated_at === null;
    if ((value.state === "idle") !== idleShape) {
      context.addIssue({ code: "custom", message: "Idle Plan execution cannot claim turn evidence." });
    }
    if (value.state !== "idle" && (value.turn_id === null || value.updated_at === null)) {
      context.addIssue({ code: "custom", message: "Non-idle Plan execution requires an exact turn and observation time." });
    }
    if (value.state === "awaiting_evidence" && (value.evidence !== "none" || value.summary !== null)) {
      context.addIssue({ code: "custom", message: "Awaiting Plan execution cannot claim unobserved plan evidence." });
    }
    if (["active", "complete"].includes(value.state) && value.evidence === "none") {
      context.addIssue({ code: "custom", message: "Active or complete Plan execution requires plan-specific evidence." });
    }
  });

export const planControlSnapshotSchema = z
  .object({
    catalog_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    catalog_observed_at: isoTimestampSchema,
    current: currentPlanModeSchema,
    pending: pendingPlanSelectionSchema.nullable(),
    execution: planExecutionSnapshotSchema,
    modes: z.array(planModeCatalogEntrySchema).min(2).max(8)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.modes.map((entry) => entry.name)).size !== value.modes.length) {
      context.addIssue({ code: "custom", message: "Plan catalogs cannot contain duplicate names." });
    }
    if (new Set(value.modes.map((entry) => entry.mode)).size !== value.modes.length) {
      context.addIssue({ code: "custom", message: "Plan catalogs cannot contain duplicate modes." });
    }
    if (!value.modes.some((entry) => entry.mode === "plan") || !value.modes.some((entry) => entry.mode === "default")) {
      context.addIssue({ code: "custom", message: "Plan catalogs must expose both Plan and Default modes." });
    }
    if (value.pending !== null && !value.modes.some((entry) => entry.mode === value.pending?.mode)) {
      context.addIssue({ code: "custom", message: "Pending Plan mode must exist in the current catalog." });
    }
  });

export const usageContractLimits = Object.freeze({ dailyBuckets: 10_000 });

export const usageCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .superRefine((value, context) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      context.addIssue({ code: "custom", message: "Usage bucket date must be a real calendar date." });
    }
  });

export const usageTokenBreakdownSchema = z
  .object({
    total_tokens: nonNegativeSafeIntegerSchema,
    input_tokens: nonNegativeSafeIntegerSchema,
    cached_input_tokens: nonNegativeSafeIntegerSchema,
    output_tokens: nonNegativeSafeIntegerSchema,
    reasoning_output_tokens: nonNegativeSafeIntegerSchema
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"] as const) {
      if (value[field] > value.total_tokens) {
        context.addIssue({
          code: "custom",
          message: "Usage token components cannot exceed total tokens.",
          path: [field]
        });
      }
    }
    if (value.cached_input_tokens > value.input_tokens) {
      context.addIssue({
        code: "custom",
        message: "Cached input tokens cannot exceed input tokens.",
        path: ["cached_input_tokens"]
      });
    }
    if (value.reasoning_output_tokens > value.output_tokens) {
      context.addIssue({
        code: "custom",
        message: "Reasoning output tokens cannot exceed output tokens.",
        path: ["reasoning_output_tokens"]
      });
    }
  });

export const usageAccountSummarySchema = z
  .object({
    lifetime_tokens: nonNegativeSafeIntegerSchema.nullable(),
    peak_daily_tokens: nonNegativeSafeIntegerSchema.nullable(),
    longest_running_turn_seconds: nonNegativeSafeIntegerSchema.nullable(),
    current_streak_days: nonNegativeSafeIntegerSchema.nullable(),
    longest_streak_days: nonNegativeSafeIntegerSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.current_streak_days !== null &&
      value.longest_streak_days !== null &&
      value.current_streak_days > value.longest_streak_days
    ) {
      context.addIssue({ code: "custom", message: "Current usage streak cannot exceed the longest streak." });
    }
    if (
      value.peak_daily_tokens !== null &&
      value.lifetime_tokens !== null &&
      value.peak_daily_tokens > value.lifetime_tokens
    ) {
      context.addIssue({ code: "custom", message: "Peak daily usage cannot exceed lifetime usage." });
    }
  });

export const usageDailyBucketSchema = z
  .object({
    start_date: usageCalendarDateSchema,
    tokens: nonNegativeSafeIntegerSchema
  })
  .strict();

export const usageAccountSnapshotSchema = z
  .object({
    scope: z.literal("account"),
    summary: usageAccountSummarySchema,
    daily_buckets: z.array(usageDailyBucketSchema).max(usageContractLimits.dailyBuckets).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.daily_buckets === null) return;
    let priorDate: string | null = null;
    for (const [index, bucket] of value.daily_buckets.entries()) {
      if (priorDate !== null && bucket.start_date <= priorDate) {
        context.addIssue({
          code: "custom",
          message: "Usage daily buckets must have unique ascending dates.",
          path: ["daily_buckets", index, "start_date"]
        });
      }
      if (value.summary.peak_daily_tokens !== null && bucket.tokens > value.summary.peak_daily_tokens) {
        context.addIssue({
          code: "custom",
          message: "A usage bucket cannot exceed the reported peak daily usage.",
          path: ["daily_buckets", index, "tokens"]
        });
      }
      priorDate = bucket.start_date;
    }
  });

export const usageThreadObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_observed"), scope: z.literal("thread") }).strict(),
  z
    .object({
      state: z.literal("observed"),
      scope: z.literal("thread"),
      observed_at: isoTimestampSchema,
      turn_id: codexTurnIdSchema,
      total: usageTokenBreakdownSchema,
      last: usageTokenBreakdownSchema,
      model_context_window: positiveSafeIntegerSchema.nullable()
    })
    .strict()
]);

export const usageRateLimitWindowSchema = z
  .object({
    used_percent: z.number().finite().min(0).max(100),
    window_duration_minutes: nonNegativeSafeIntegerSchema.nullable(),
    resets_at: isoTimestampSchema.nullable()
  })
  .strict();

export const usageRateLimitObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_observed"), scope: z.literal("runtime") }).strict(),
  z
    .object({
      state: z.literal("observed"),
      scope: z.literal("runtime"),
      observed_at: isoTimestampSchema,
      primary: usageRateLimitWindowSchema.nullable(),
      secondary: usageRateLimitWindowSchema.nullable(),
      reached_type: z
        .enum([
          "rate_limit_reached",
          "workspace_owner_credits_depleted",
          "workspace_member_credits_depleted",
          "workspace_owner_usage_limit_reached",
          "workspace_member_usage_limit_reached"
        ])
        .nullable()
    })
    .strict()
]);

export const usageSnapshotSchema = z
  .object({
    target: managedSessionTargetSchema,
    runtime_version: codexVersionSchema,
    connection_generation: positiveSafeIntegerSchema,
    measured_at: isoTimestampSchema,
    account: usageAccountSnapshotSchema,
    thread: usageThreadObservationSchema,
    rate_limits: usageRateLimitObservationSchema
  })
  .strict()
  .superRefine((value, context) => {
    const measuredAt = Date.parse(value.measured_at);
    for (const [field, observedAt] of [
      ["thread", value.thread.state === "observed" ? value.thread.observed_at : null],
      ["rate_limits", value.rate_limits.state === "observed" ? value.rate_limits.observed_at : null]
    ] as const) {
      if (observedAt !== null && Date.parse(observedAt) > measuredAt) {
        context.addIssue({
          code: "custom",
          message: "Usage observations cannot occur after the snapshot measurement.",
          path: [field, "observed_at"]
        });
      }
    }
  });

export const skillSummarySchema = z
  .object({
    name: z.string().min(1).max(operationLimits.skillNameLength),
    description: z.string().max(operationLimits.skillDescriptionLength).nullable(),
    scope: z.enum(["user", "repo", "system", "admin"]),
    enabled: z.boolean()
  })
  .strict();

export const skillSnapshotStates = ["content", "empty", "partial", "error"] as const;

export const skillsSnapshotSchema = z
  .object({
    target: managedSessionTargetSchema,
    runtime_version: codexVersionSchema,
    connection_generation: positiveSafeIntegerSchema,
    observed_at: isoTimestampSchema,
    state: z.enum(skillSnapshotStates),
    skills: z.array(skillSummarySchema).max(1_024),
    error_count: nonNegativeSafeIntegerSchema.max(256)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.skills.map((skill) => skill.name)).size !== value.skills.length) {
      context.addIssue({ code: "custom", message: "Skill snapshots cannot contain duplicate skill names." });
    }
    for (let index = 1; index < value.skills.length; index += 1) {
      if ((value.skills[index - 1]?.name ?? "") >= (value.skills[index]?.name ?? "")) {
        context.addIssue({ code: "custom", message: "Skill snapshots must use strict deterministic name order." });
        break;
      }
    }
    const expectedState =
      value.skills.length === 0
        ? value.error_count === 0
          ? "empty"
          : "error"
        : value.error_count === 0
          ? "content"
          : "partial";
    if (value.state !== expectedState) {
      context.addIssue({ code: "custom", message: "Skill snapshot state contradicts its content and error count." });
    }
  });

export const selectedStartSessionRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    name: sessionNameSchema,
    cwd: absoluteCwdSchema
  })
  .strict();

export const selectedSessionStartResponseSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    session: managedSessionProjectionSchema
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
export type PromptSessionRequest = z.infer<typeof promptSessionRequestSchema>;
export type PromptDispatchResponse = z.infer<typeof promptDispatchResponseSchema>;
export type ModelSelectionRequest = z.infer<typeof modelSelectionRequestSchema>;
export type GoalMutationRequest = z.infer<typeof goalMutationRequestSchema>;
export type ArchiveSessionRequest = z.infer<typeof archiveSessionRequestSchema>;
export type SelectedOperationDispatch = z.infer<typeof selectedOperationDispatchSchema>;
export type SelectedOperationTerminalOutcome = z.infer<typeof selectedOperationTerminalOutcomeSchema>;
export type SelectedOperationProgress = z.infer<typeof selectedOperationProgressSchema>;
export type SelectedControlState = z.infer<typeof selectedControlStateSchema>;
export type PromptTurnControlSnapshot = z.infer<typeof promptTurnControlSnapshotSchema>;
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;
export type ModelControlSnapshot = z.infer<typeof modelControlSnapshotSchema>;
export type PendingModelSelection = z.infer<typeof pendingModelSelectionSchema>;
export type GoalControlSnapshot = z.infer<typeof goalControlSnapshotSchema>;
export type GoalControlValue = z.infer<typeof goalControlValueSchema>;
export type UncertainGoalMutation = z.infer<typeof uncertainGoalMutationSchema>;
export type PlanMode = z.infer<typeof planModeSchema>;
export type PlanModeCatalogEntry = z.infer<typeof planModeCatalogEntrySchema>;
export type CurrentPlanMode = z.infer<typeof currentPlanModeSchema>;
export type ResolvedPlanSettings = z.infer<typeof resolvedPlanSettingsSchema>;
export type PendingPlanSelection = z.infer<typeof pendingPlanSelectionSchema>;
export type PlanExecutionSnapshot = z.infer<typeof planExecutionSnapshotSchema>;
export type PlanControlSnapshot = z.infer<typeof planControlSnapshotSchema>;
export type UsageTokenBreakdown = z.infer<typeof usageTokenBreakdownSchema>;
export type UsageAccountSummary = z.infer<typeof usageAccountSummarySchema>;
export type UsageDailyBucket = z.infer<typeof usageDailyBucketSchema>;
export type UsageAccountSnapshot = z.infer<typeof usageAccountSnapshotSchema>;
export type UsageThreadObservation = z.infer<typeof usageThreadObservationSchema>;
export type UsageRateLimitWindow = z.infer<typeof usageRateLimitWindowSchema>;
export type UsageRateLimitObservation = z.infer<typeof usageRateLimitObservationSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SkillsSnapshot = z.infer<typeof skillsSnapshotSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type SelectedStartSessionRequest = z.infer<typeof selectedStartSessionRequestSchema>;
export type SelectedSessionStartResponse = z.infer<typeof selectedSessionStartResponseSchema>;

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
  value: {
    readonly kind: SelectedOperationKind;
    readonly target: SelectedOperationTarget;
    readonly state: string;
    readonly turn_id: z.infer<typeof codexTurnIdSchema> | null;
  },
  context: z.RefinementCtx
): void {
  if (value.kind === "interrupt" && value.target.type === "turn" && value.turn_id !== value.target.turn_id) {
    context.addIssue({
      code: "custom",
      message: "Interrupt outcomes must preserve the exact targeted turn id.",
      path: ["turn_id"]
    });
  }
  if (value.kind !== "compact") return;
  if (value.state === "accepted" && value.turn_id !== null) {
    context.addIssue({
      code: "custom",
      message: "Accepted-only compact progress cannot claim an event-proven turn id.",
      path: ["turn_id"]
    });
  }
  if (["running", "completed", "interrupted", "failed", "succeeded"].includes(value.state) && value.turn_id === null) {
    context.addIssue({
      code: "custom",
      message: "Event-proven compact progress requires the exact compact turn id.",
      path: ["turn_id"]
    });
  }
}
