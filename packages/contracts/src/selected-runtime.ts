import type {
  ClientOperationId,
  CodexItemId,
  CodexThreadId,
  CodexTurnId,
  RuntimeRequestId
} from "@hostdeck/core";
import {
  attentionLevels,
  errorCodes,
  managedSessionStates,
  parseClientOperationId,
  parseCodexItemId,
  parseCodexThreadId,
  parseCodexTurnId,
  parseRuntimeRequestId,
  projectionActivityKinds,
  projectionContentStates,
  projectionFreshnessStates,
  requiredRuntimeCapabilities,
  runtimeCapabilities,
  runtimeCapabilityStates,
  runtimeConnectionStates,
  runtimeMutationPolicies,
  selectedRuntimeSource,
  structuredControlKinds,
  turnStates
} from "@hostdeck/core";
import { z } from "zod";
import {
  absoluteCwdSchema,
  isoTimestampSchema,
  outputCursorSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";

export const codexModelContractLimits = Object.freeze({
  identityLength: 160,
  reasoningEffortLength: 80
});

const selectedRuntimeLimits = {
  versionLength: 64,
  bindingIdLength: 192,
  reasonLength: 240,
  modelLength: codexModelContractLimits.identityLength,
  branchLength: 240,
  summaryLength: 512,
  eventTypeLength: 160,
  eventTextLength: 12_000,
  eventLabelLength: 240,
  eventDetailLength: 2_000,
  approvalFieldLength: 1_000
} as const;

function brandedIdSchema<T>(
  name: string,
  parser: (value: string) => { ok: true; value: T } | { ok: false; message: string }
) {
  return z
    .string()
    .superRefine((value, context) => {
      const result = parser(value);
      if (!result.ok) context.addIssue({ code: "custom", message: result.message });
    })
    .transform((value, context) => {
      const result = parser(value);
      if (!result.ok) {
        context.addIssue({ code: "custom", message: `${name} failed validation after refinement.` });
        return z.NEVER;
      }
      return result.value;
    });
}

export const codexThreadIdSchema = brandedIdSchema<CodexThreadId>("codex_thread_id", parseCodexThreadId);
export const codexTurnIdSchema = brandedIdSchema<CodexTurnId>("codex_turn_id", parseCodexTurnId);
export const codexItemIdSchema = brandedIdSchema<CodexItemId>("codex_item_id", parseCodexItemId);
export const runtimeRequestIdSchema = brandedIdSchema<RuntimeRequestId>("runtime_request_id", parseRuntimeRequestId);
export const clientOperationIdSchema = brandedIdSchema<ClientOperationId>("client_operation_id", parseClientOperationId);

export const codexVersionSchema = z
  .string()
  .min(1)
  .max(selectedRuntimeLimits.versionLength)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);

export const bindingIdentitySchema = z
  .string()
  .min(1)
  .max(selectedRuntimeLimits.bindingIdLength)
  .regex(/^\S+$/u);

export const runtimeCapabilityEntrySchema = z
  .object({
    name: z.enum(runtimeCapabilities),
    state: z.enum(runtimeCapabilityStates),
    reason: z.string().min(1).max(selectedRuntimeLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "available" && value.reason !== null) {
      context.addIssue({ code: "custom", message: "Available runtime capabilities must not carry a reason." });
    }
    if (value.state !== "available" && value.reason === null) {
      context.addIssue({ code: "custom", message: "Unavailable or unknown capabilities must explain why." });
    }
  });

export const runtimeCapabilitySetSchema = z
  .array(runtimeCapabilityEntrySchema)
  .length(runtimeCapabilities.length)
  .superRefine((entries, context) => {
    const names = new Set(entries.map((entry) => entry.name));
    if (names.size !== entries.length) {
      context.addIssue({ code: "custom", message: "Runtime capability entries must be unique." });
    }
    for (const capability of runtimeCapabilities) {
      if (!names.has(capability)) {
        context.addIssue({ code: "custom", message: `Runtime capability set is missing ${capability}.` });
      }
    }
  });

export const runtimeCompatibilitySchema = z
  .object({
    source: z.literal(selectedRuntimeSource),
    state: z.enum(runtimeConnectionStates),
    mutation_policy: z.enum(runtimeMutationPolicies),
    observed_version: codexVersionSchema.nullable(),
    binding_id: bindingIdentitySchema.nullable(),
    capabilities: runtimeCapabilitySetSchema,
    checked_at: isoTimestampSchema,
    reason: z.string().min(1).max(selectedRuntimeLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const capabilityByName = new Map(value.capabilities.map((capability) => [capability.name, capability.state]));
    const unavailableRequired = requiredRuntimeCapabilities.filter(
      (capability) => capabilityByName.get(capability) !== "available"
    );

    if (value.state === "ready" || value.state === "degraded") {
      if (value.observed_version === null || value.binding_id === null) {
        context.addIssue({
          code: "custom",
          message: "Connected runtime compatibility requires version and binding identity."
        });
      }
      if (unavailableRequired.length > 0) {
        context.addIssue({
          code: "custom",
          message: `Connected runtime compatibility is missing required capabilities: ${unavailableRequired.join(", ")}.`
        });
      }
      if (value.state === "ready" && value.capabilities.some((capability) => capability.state === "unknown")) {
        context.addIssue({ code: "custom", message: "Ready runtime compatibility cannot contain unknown capability states." });
      }
    }

    if (value.state === "ready" && value.reason !== null) {
      context.addIssue({ code: "custom", message: "Ready runtime compatibility must not carry a failure reason." });
    }
    if (value.state === "ready" && value.mutation_policy !== "allowed") {
      context.addIssue({ code: "custom", message: "Ready runtime compatibility must allow selected mutations." });
    }
    if (["incompatible", "disconnected"].includes(value.state) && value.mutation_policy !== "blocked") {
      context.addIssue({ code: "custom", message: "Incompatible or disconnected runtimes cannot allow mutations." });
    }
    if (value.state !== "ready" && value.reason === null) {
      context.addIssue({ code: "custom", message: "Non-ready runtime compatibility must include a reason." });
    }

    if (value.state === "incompatible" && unavailableRequired.length === 0) {
      context.addIssue({ code: "custom", message: "Incompatible runtime compatibility must identify a missing required capability." });
    }
  });

export const goalCueSchema = z
  .object({
    objective: z.string().min(1).max(selectedRuntimeLimits.summaryLength),
    state: z.enum(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"])
  })
  .strict();

export const managedSessionIdentitySchema = z
  .object({
    id: sessionIdSchema,
    name: sessionNameSchema,
    codex_thread_id: codexThreadIdSchema,
    cwd: absoluteCwdSchema,
    runtime_source: z.literal(selectedRuntimeSource),
    runtime_version: codexVersionSchema,
    created_at: isoTimestampSchema,
    archived_at: isoTimestampSchema.nullable()
  })
  .strict();

export const managedSessionProjectionSchema = managedSessionIdentitySchema
  .extend({
    session_state: z.enum(managedSessionStates),
    turn_state: z.enum(turnStates),
    attention: z.enum(attentionLevels),
    freshness: z.enum(projectionFreshnessStates),
    freshness_reason: z.string().min(1).max(selectedRuntimeLimits.reasonLength).nullable(),
    updated_at: isoTimestampSchema,
    last_activity_at: isoTimestampSchema.nullable(),
    branch: z.string().min(1).max(selectedRuntimeLimits.branchLength).nullable(),
    model: z.string().min(1).max(selectedRuntimeLimits.modelLength).nullable(),
    goal: goalCueSchema.nullable(),
    recent_summary: z.string().max(selectedRuntimeLimits.summaryLength),
    last_event_cursor: outputCursorSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.freshness === "current" && value.freshness_reason !== null) {
      context.addIssue({ code: "custom", message: "Current projections must not carry a freshness failure reason." });
    }
    if (value.freshness !== "current" && value.freshness_reason === null) {
      context.addIssue({ code: "custom", message: "Non-current projections must explain why they are stale." });
    }
    if (value.session_state === "archived" && ["in_progress", "waiting_for_input", "waiting_for_approval"].includes(value.turn_state)) {
      context.addIssue({ code: "custom", message: "Archived sessions cannot expose an active or waiting turn." });
    }
    if ((value.session_state === "archived") !== (value.archived_at !== null)) {
      context.addIssue({ code: "custom", message: "Archived session state and archived_at must agree." });
    }
  });

const eventBaseShape = {
  session_id: sessionIdSchema,
  cursor: outputCursorSchema,
  captured_at: isoTimestampSchema,
  upstream_at: isoTimestampSchema.nullable(),
  codex_event_id: z.string().min(1).max(160).nullable(),
  codex_event_type: z.string().min(1).max(selectedRuntimeLimits.eventTypeLength).nullable(),
  content_state: z.enum(projectionContentStates),
  content_notice: z.string().min(1).max(selectedRuntimeLimits.reasonLength).nullable()
};

export const messageProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("message"),
    role: z.enum(["user", "agent"]),
    phase: z.enum(["delta", "completed"]),
    item_id: codexItemIdSchema.nullable(),
    text: z.string().max(selectedRuntimeLimits.eventTextLength)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role === "user" && value.phase === "delta") {
      context.addIssue({ code: "custom", message: "User messages must be projected as completed items." });
    }
  });

export const turnProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("turn"),
    turn_id: codexTurnIdSchema,
    state: z.enum(turnStates),
    error: z
      .object({
        code: z.enum(errorCodes),
        message: z.string().min(1).max(selectedRuntimeLimits.reasonLength)
      })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "failed" && value.error === null) {
      context.addIssue({ code: "custom", message: "Failed turn events must carry a bounded error." });
    }
    if (value.state !== "failed" && value.error !== null) {
      context.addIssue({ code: "custom", message: "Only failed turn events may carry an error." });
    }
  });

export const activityProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("activity"),
    activity: z.enum(projectionActivityKinds),
    state: z.enum(["started", "updated", "completed", "failed"]),
    item_id: codexItemIdSchema.nullable(),
    title: z.string().min(1).max(selectedRuntimeLimits.eventLabelLength),
    detail: z.string().max(selectedRuntimeLimits.eventDetailLength).nullable()
  })
  .strict();

export const approvalProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("approval"),
    request_id: runtimeRequestIdSchema,
    state: z.enum(["pending", "approved", "denied", "expired", "superseded"]),
    action: z.string().min(1).max(selectedRuntimeLimits.approvalFieldLength),
    scope: z.string().min(1).max(selectedRuntimeLimits.approvalFieldLength),
    reason: z.string().max(selectedRuntimeLimits.approvalFieldLength).nullable(),
    risk: z.enum(["normal", "elevated", "broad"]),
    expires_at: isoTimestampSchema.nullable(),
    decision: z.enum(["approve", "deny"]).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "pending" && value.decision !== null) {
      context.addIssue({ code: "custom", message: "Pending approvals must not carry a decision." });
    }
    if (value.state === "approved" && value.decision !== "approve") {
      context.addIssue({ code: "custom", message: "Approved events must record an approve decision." });
    }
    if (value.state === "denied" && value.decision !== "deny") {
      context.addIssue({ code: "custom", message: "Denied events must record a deny decision." });
    }
    if (["expired", "superseded"].includes(value.state) && value.decision !== null) {
      context.addIssue({ code: "custom", message: "Expired or superseded approvals must not invent a user decision." });
    }
  });

export const controlProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("control"),
    control: z.enum(structuredControlKinds),
    state: z.enum(["available", "updating", "active", "paused", "complete", "failed", "unsupported"]),
    value_summary: z.string().max(selectedRuntimeLimits.summaryLength).nullable()
  })
  .strict();

export const runtimeProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("runtime"),
    state: z.enum(runtimeConnectionStates),
    message: z.string().min(1).max(selectedRuntimeLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state !== "ready" && value.message === null) {
      context.addIssue({ code: "custom", message: "Non-ready runtime events must explain the state." });
    }
    if (value.state === "ready" && value.message !== null) {
      context.addIssue({ code: "custom", message: "Ready runtime events must not carry a failure message." });
    }
  });

export const replayBoundaryProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("replay_boundary"),
    after: outputCursorSchema.nullable(),
    next_cursor: outputCursorSchema,
    reason: z.enum(["retention", "disconnect", "restart", "schema_change"])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.after !== null && value.next_cursor <= value.after) {
      context.addIssue({ code: "custom", message: "Replay boundaries must advance beyond the requested cursor." });
    }
    if (value.cursor !== value.next_cursor) {
      context.addIssue({ code: "custom", message: "Replay boundary event cursor must equal next_cursor." });
    }
  });

export const unknownOptionalProjectionEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("unknown_optional"),
    upstream_type: z.string().min(1).max(selectedRuntimeLimits.eventTypeLength),
    summary: z.string().min(1).max(selectedRuntimeLimits.summaryLength)
  })
  .strict();

export const selectedProjectionEventSchema = z
  .discriminatedUnion("type", [
    messageProjectionEventSchema,
    turnProjectionEventSchema,
    activityProjectionEventSchema,
    approvalProjectionEventSchema,
    controlProjectionEventSchema,
    runtimeProjectionEventSchema,
    replayBoundaryProjectionEventSchema,
    unknownOptionalProjectionEventSchema
  ])
  .superRefine((value, context) => {
    if (value.content_state === "complete" && value.content_notice !== null) {
      context.addIssue({ code: "custom", message: "Complete projected events must not carry a content limitation notice." });
    }
    if (value.content_state !== "complete" && value.content_notice === null) {
      context.addIssue({ code: "custom", message: "Redacted or truncated projected events must explain the limitation." });
    }
  });

export const selectedSessionEventStreamSchema = z
  .object({
    session_id: sessionIdSchema,
    events: z.array(selectedProjectionEventSchema),
    next_cursor: outputCursorSchema,
    truncated: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    let previous = -1;
    let hasReplayBoundary = false;
    for (const [index, event] of value.events.entries()) {
      if (event.session_id !== value.session_id) {
        context.addIssue({
          code: "custom",
          message: "Selected event streams must not mix sessions.",
          path: ["events", index, "session_id"]
        });
      }
      if (event.cursor <= previous) {
        context.addIssue({
          code: "custom",
          message: "Selected event stream cursors must be strictly increasing.",
          path: ["events", index, "cursor"]
        });
      }
      if (event.cursor > value.next_cursor) {
        context.addIssue({
          code: "custom",
          message: "Stream next_cursor must not precede an event cursor.",
          path: ["next_cursor"]
        });
      }
      if (event.type === "replay_boundary") {
        if (hasReplayBoundary || index !== 0) {
          context.addIssue({
            code: "custom",
            message: "A replay boundary may appear at most once and must be the first event in the stream.",
            path: ["events", index]
          });
        }
        hasReplayBoundary = true;
      }
      previous = event.cursor;
    }
    if (value.truncated !== hasReplayBoundary) {
      context.addIssue({
        code: "custom",
        message: "Truncated event streams must contain one visible replay boundary, and contiguous streams must not."
      });
    }
  });

export type RuntimeCompatibility = z.infer<typeof runtimeCompatibilitySchema>;
export type ManagedSessionIdentity = z.infer<typeof managedSessionIdentitySchema>;
export type ManagedSessionProjection = z.infer<typeof managedSessionProjectionSchema>;
export type SelectedProjectionEvent = z.infer<typeof selectedProjectionEventSchema>;
export type SelectedSessionEventStream = z.infer<typeof selectedSessionEventStreamSchema>;
export type ApprovalProjectionEvent = z.infer<typeof approvalProjectionEventSchema>;
