import type { NativeCodexThreadId } from "@hostdeck/core";
import { parseNativeCodexThreadId, selectedRuntimeSource } from "@hostdeck/core";
import { z } from "zod";
import { selectedNativeSessionMembershipRecordSchema } from "./native-session.js";
import { resourceBudgetDefinitionByKey } from "./resource-policy.js";
import {
  isoTimestampSchema,
  nonNegativeSafeIntegerSchema,
  outputCursorSchema,
  positiveSafeIntegerSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";
import { codexVersionSchema, managedSessionProjectionSchema } from "./selected-runtime.js";

export const sharedCodexRuntimeVersion = "0.147.0" as const;

export const sharedCodexRuntimeContractLimits = Object.freeze({
  pathLength: 4_096,
  nameLength: 160,
  projectCueLength: 160,
  branchLength: 240,
  diagnosticLength: 240,
  methodLength: 128,
  pendingThreads: resourceBudgetDefinitionByKey.protocol_enrollment_max_pending_threads.maximum,
  pendingEventsPerThread: resourceBudgetDefinitionByKey.protocol_enrollment_pending_events_per_thread.maximum,
  pendingBytesPerThread: resourceBudgetDefinitionByKey.protocol_enrollment_pending_bytes_per_thread.maximum,
  pendingTimeoutMs: resourceBudgetDefinitionByKey.protocol_enrollment_pending_timeout_ms.maximum,
  pendingAttempts: 10_000,
  recentTurns: 20,
  recentEvents: resourceBudgetDefinitionByKey.sse_replay_max_events.maximum,
  catalogSessions: resourceBudgetDefinitionByKey.protocol_thread_max_loaded_reads.maximum
});

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

export const nativeCodexThreadIdSchema = brandedIdSchema<NativeCodexThreadId>(
  "native_codex_thread_id",
  parseNativeCodexThreadId
);

const boundedCandidateTextSchema = z.string().min(1).max(sharedCodexRuntimeContractLimits.nameLength);
const boundedProjectCueSchema = z.string().min(1).max(sharedCodexRuntimeContractLimits.projectCueLength);
const candidateCwdSchema = z.string().min(1).max(sharedCodexRuntimeContractLimits.pathLength);
const unixAbsolutePathSchema = candidateCwdSchema
  .regex(/^\//u, "Shared Codex paths must be absolute Unix paths.")
  .refine((value) => !value.includes("\0"), "Shared Codex paths must not contain NUL bytes.")
  .refine(
    (value) =>
      value === "/" ||
      (!value.endsWith("/") && !value.includes("//") && !value.split("/").some((segment) => segment === "." || segment === "..")),
    "Shared Codex paths must be normalized."
  );

const secretDiagnosticPattern = /(?:bearer\s+|openai[_-]?api[_-]?key|sk-[a-z0-9]|tskey-|(?:access[_-]?)?token\s*[=:])/iu;

export const privacySafeRuntimeDiagnosticSchema = z
  .string()
  .min(1)
  .max(sharedCodexRuntimeContractLimits.diagnosticLength)
  .refine(
    (value) => !value.includes("/") && !value.includes("\\") && !hasControlCharacter(value),
    "Runtime diagnostics must not contain paths or control characters."
  )
  .refine((value) => !secretDiagnosticPattern.test(value), "Runtime diagnostics must not contain credentials.");

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export const sharedSessionTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("native_codex_thread"),
      native_thread_id: nativeCodexThreadIdSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("internal_session"),
      internal_session_id: sessionIdSchema
    })
    .strict()
]);

export const sharedSessionTargetIdSchema = z.union([nativeCodexThreadIdSchema, sessionIdSchema]);

export const sharedSessionEnrollmentOrigins = [
  "loaded_before",
  "created_after",
  "resumed_after",
  "hostdeck_start",
  "reconciliation"
] as const;

export const trackedSessionSchema = z
  .object({
    native_thread_id: nativeCodexThreadIdSchema,
    internal_session_id: sessionIdSchema,
    alias: sessionNameSchema,
    cwd: unixAbsolutePathSchema,
    project_cue: boundedProjectCueSchema,
    branch: z.string().min(1).max(sharedCodexRuntimeContractLimits.branchLength).nullable(),
    runtime_version: codexVersionSchema,
    runtime_source: z.literal(selectedRuntimeSource),
    enrollment_origin: z.enum(sharedSessionEnrollmentOrigins),
    archived: z.boolean(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    archived_at: isoTimestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (String(value.native_thread_id) === String(value.internal_session_id)) {
      context.addIssue({ code: "custom", message: "Native and internal session identifiers must remain distinct." });
    }
    if (value.updated_at < value.created_at) {
      context.addIssue({ code: "custom", message: "Tracked-session update cannot precede creation." });
    }
    if (value.archived !== (value.archived_at !== null)) {
      context.addIssue({ code: "custom", message: "Tracked-session archive state and timestamp must agree." });
    }
    if (value.archived_at !== null && value.archived_at < value.created_at) {
      context.addIssue({ code: "custom", message: "Tracked-session archive cannot precede creation." });
    }
    if (value.archived_at !== null && value.archived_at > value.updated_at) {
      context.addIssue({ code: "custom", message: "Tracked-session archive cannot follow its latest update." });
    }
  });

export const loadedThreadSources = ["cli", "app_server", "vscode", "exec", "subagent", "custom", "unknown"] as const;
export const loadedThreadStatuses = ["not_loaded", "idle", "active", "system_error"] as const;
export const loadedThreadActiveFlags = ["waiting_on_approval", "waiting_on_user_input"] as const;
export const loadedThreadRejectionReasons = [
  "archived",
  "child_or_subagent",
  "contradictory_metadata",
  "ephemeral",
  "incompatible_runtime",
  "invalid_cwd",
  "missing",
  "non_interactive_source",
  "runtime_error"
] as const;
export type LoadedThreadRejectionReason = (typeof loadedThreadRejectionReasons)[number];

const loadedThreadEligibilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("eligible"), reason: z.null() }).strict(),
  z.object({ state: z.literal("ineligible"), reason: z.enum(loadedThreadRejectionReasons) }).strict()
]);

export const loadedThreadCandidateSchema = z
  .object({
    native_thread_id: nativeCodexThreadIdSchema,
    root_thread_id: nativeCodexThreadIdSchema,
    parent_thread_id: nativeCodexThreadIdSchema.nullable(),
    forked_from_id: nativeCodexThreadIdSchema.nullable(),
    name: boundedCandidateTextSchema.nullable(),
    project_cue: boundedProjectCueSchema,
    cwd: candidateCwdSchema,
    source: z.enum(loadedThreadSources),
    ephemeral: z.boolean(),
    archived: z.boolean(),
    runtime_version: codexVersionSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    status: z.enum(loadedThreadStatuses),
    active_flags: z.array(z.enum(loadedThreadActiveFlags)).max(loadedThreadActiveFlags.length),
    eligibility: loadedThreadEligibilitySchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.active_flags).size !== value.active_flags.length) {
      context.addIssue({ code: "custom", path: ["active_flags"], message: "Loaded-thread active flags must be unique." });
    }
    if (value.status !== "active" && value.active_flags.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["active_flags"],
        message: "Only active loaded threads may carry active flags."
      });
    }

    const expectedReason = expectedLoadedThreadRejectionReason(value);
    if (expectedReason === null && value.eligibility.state !== "eligible") {
      context.addIssue({ code: "custom", path: ["eligibility"], message: "Eligible metadata cannot carry a rejection reason." });
    }
    if (
      expectedReason !== null &&
      (value.eligibility.state !== "ineligible" || value.eligibility.reason !== expectedReason)
    ) {
      context.addIssue({
        code: "custom",
        path: ["eligibility"],
        message: `Loaded-thread metadata requires rejection reason ${expectedReason}.`
      });
    }
  });

function expectedLoadedThreadRejectionReason(
  value: Omit<z.input<typeof loadedThreadCandidateSchema>, "eligibility">
): LoadedThreadRejectionReason | null {
  if (
    value.updated_at < value.created_at ||
    value.parent_thread_id === value.native_thread_id ||
    value.forked_from_id === value.native_thread_id ||
    (value.root_thread_id === value.native_thread_id && value.parent_thread_id !== null) ||
    (value.source === "subagent" && value.root_thread_id === value.native_thread_id)
  ) {
    return "contradictory_metadata";
  }
  if (value.runtime_version !== sharedCodexRuntimeVersion) return "incompatible_runtime";
  if (value.archived) return "archived";
  if (value.ephemeral) return "ephemeral";
  if (
    value.root_thread_id !== value.native_thread_id ||
    value.parent_thread_id !== null ||
    value.source === "subagent"
  ) {
    return "child_or_subagent";
  }
  if (value.source !== "cli" && value.source !== "app_server") return "non_interactive_source";
  if (!unixAbsolutePathSchema.safeParse(value.cwd).success) return "invalid_cwd";
  if (value.status === "not_loaded") return "missing";
  if (value.status === "system_error") return "runtime_error";
  return null;
}

export const sharedCodexEndpointLocationSchema = z
  .object({
    kind: z.literal("standard_unix"),
    codex_home: unixAbsolutePathSchema,
    socket_path: unixAbsolutePathSchema
  })
  .strict()
  .superRefine((value, context) => {
    const expected = `${value.codex_home === "/" ? "" : value.codex_home}/app-server-control/app-server-control.sock`;
    if (value.socket_path !== expected) {
      context.addIssue({
        code: "custom",
        path: ["socket_path"],
        message: "Shared Codex socket must use the standard endpoint below CODEX_HOME."
      });
    }
  });

export const sharedCodexEndpointStates = ["absent", "starting", "ready", "incompatible", "failed", "stopping"] as const;
export const sharedCodexEndpointOwnershipStates = ["none", "attached", "owned"] as const;

export const sharedCodexEndpointSchema = z
  .object({
    kind: z.literal("standard_unix"),
    state: z.enum(sharedCodexEndpointStates),
    ownership: z.enum(sharedCodexEndpointOwnershipStates),
    generation: nonNegativeSafeIntegerSchema,
    observed_version: codexVersionSchema.nullable(),
    reason: privacySafeRuntimeDiagnosticSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "absent") {
      if (value.ownership !== "none" || value.observed_version !== null || value.reason !== null) {
        context.addIssue({ code: "custom", message: "An absent shared endpoint cannot retain ownership, version, or failure data." });
      }
      return;
    }
    if (value.state === "starting" || value.state === "stopping") {
      if (
        value.ownership !== "owned" ||
        value.reason !== null ||
        (value.state === "starting" && value.observed_version !== null) ||
        (value.state === "stopping" && value.observed_version !== sharedCodexRuntimeVersion)
      ) {
        context.addIssue({ code: "custom", message: "Starting or stopping is valid only for an owned endpoint without a failure reason." });
      }
      return;
    }
    if (value.state === "ready") {
      if (
        value.ownership === "none" ||
        value.observed_version !== sharedCodexRuntimeVersion ||
        value.reason !== null
      ) {
        context.addIssue({ code: "custom", message: "A ready shared endpoint requires compatible attached or owned runtime evidence." });
      }
      return;
    }
    if (value.state === "incompatible") {
      if (value.ownership === "none" || value.reason === null) {
        context.addIssue({ code: "custom", message: "An incompatible endpoint requires attached or owned runtime evidence and a reason." });
      }
      return;
    }
    if (value.reason === null || value.ownership === "attached") {
      context.addIssue({ code: "custom", message: "A failed endpoint requires a reason and cannot claim attachment." });
    }
  });

export const pendingEnrollmentPhases = ["pending_metadata", "pending_materialization", "pending_mapping"] as const;

export const pendingEnrollmentNotificationSchema = z
  .object({
    native_thread_id: nativeCodexThreadIdSchema,
    ordinal: positiveSafeIntegerSchema,
    method: z
      .string()
      .min(3)
      .max(sharedCodexRuntimeContractLimits.methodLength)
      .regex(/^[a-z][A-Za-z0-9]*(?:\/[a-z][A-Za-z0-9]*)+$/u),
    received_at: isoTimestampSchema,
    wire_bytes: positiveSafeIntegerSchema.max(resourceBudgetDefinitionByKey.protocol_max_frame_bytes.maximum)
  })
  .strict();

export const pendingEnrollmentSnapshotSchema = z
  .object({
    native_thread_id: nativeCodexThreadIdSchema,
    origin: z.enum(sharedSessionEnrollmentOrigins),
    phase: z.enum(pendingEnrollmentPhases),
    candidate: loadedThreadCandidateSchema.nullable(),
    first_seen_at: isoTimestampSchema,
    last_attempt_at: isoTimestampSchema,
    next_retry_at: isoTimestampSchema,
    deadline_at: isoTimestampSchema,
    attempt_count: positiveSafeIntegerSchema.max(sharedCodexRuntimeContractLimits.pendingAttempts),
    buffered_notifications: z
      .array(pendingEnrollmentNotificationSchema)
      .max(sharedCodexRuntimeContractLimits.pendingEventsPerThread),
    buffered_bytes: nonNegativeSafeIntegerSchema.max(sharedCodexRuntimeContractLimits.pendingBytesPerThread),
    boundary_required: z.literal(false)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.phase === "pending_metadata" && value.candidate !== null) {
      context.addIssue({ code: "custom", path: ["candidate"], message: "Pending metadata cannot claim a normalized candidate." });
    }
    if (value.phase !== "pending_metadata" && value.candidate?.eligibility.state !== "eligible") {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "Pending materialization or mapping requires one eligible normalized candidate."
      });
    }
    if (
      value.last_attempt_at < value.first_seen_at ||
      value.next_retry_at <= value.last_attempt_at ||
      value.deadline_at <= value.first_seen_at ||
      value.next_retry_at > value.deadline_at
    ) {
      context.addIssue({ code: "custom", message: "Pending enrollment timestamps must preserve attempt, retry, and deadline order." });
    }
    const pendingDuration = Date.parse(value.deadline_at) - Date.parse(value.first_seen_at);
    const retryDelay = Date.parse(value.next_retry_at) - Date.parse(value.last_attempt_at);
    if (pendingDuration > sharedCodexRuntimeContractLimits.pendingTimeoutMs) {
      context.addIssue({ code: "custom", path: ["deadline_at"], message: "Pending enrollment exceeds its hard timeout bound." });
    }
    if (retryDelay > resourceBudgetDefinitionByKey.protocol_enrollment_retry_interval_ms.maximum) {
      context.addIssue({ code: "custom", path: ["next_retry_at"], message: "Pending enrollment exceeds its hard retry interval bound." });
    }

    let byteTotal = 0;
    let previousOrdinal = 0;
    let previousReceivedAt: string | null = null;
    for (const [index, notification] of value.buffered_notifications.entries()) {
      byteTotal += notification.wire_bytes;
      if (notification.native_thread_id !== value.native_thread_id) {
        context.addIssue({
          code: "custom",
          path: ["buffered_notifications", index, "native_thread_id"],
          message: "Pending notifications must target their owning enrollment."
        });
      }
      if (notification.ordinal <= previousOrdinal || (previousReceivedAt !== null && notification.received_at < previousReceivedAt)) {
        context.addIssue({
          code: "custom",
          path: ["buffered_notifications", index],
          message: "Pending notifications must preserve strict ordinal and timestamp order."
        });
      }
      if (notification.received_at < value.first_seen_at || notification.received_at > value.deadline_at) {
        context.addIssue({
          code: "custom",
          path: ["buffered_notifications", index, "received_at"],
          message: "Pending notifications must fall within the enrollment window."
        });
      }
      previousOrdinal = notification.ordinal;
      previousReceivedAt = notification.received_at;
    }
    if (byteTotal !== value.buffered_bytes) {
      context.addIssue({ code: "custom", path: ["buffered_bytes"], message: "Pending enrollment byte count must match its notifications." });
    }
    if (value.candidate !== null && value.candidate.native_thread_id !== value.native_thread_id) {
      context.addIssue({ code: "custom", path: ["candidate"], message: "Pending candidate must match its native thread target." });
    }
  });

export const pendingEnrollmentRegistrySchema = z
  .array(pendingEnrollmentSnapshotSchema)
  .max(sharedCodexRuntimeContractLimits.pendingThreads)
  .superRefine((entries, context) => {
    if (new Set(entries.map((entry) => entry.native_thread_id)).size !== entries.length) {
      context.addIssue({ code: "custom", message: "Pending enrollment registry cannot repeat a native thread." });
    }
  });

export const sharedEnrollmentHistorySchema = z
  .object({
    turns_loaded: nonNegativeSafeIntegerSchema.max(sharedCodexRuntimeContractLimits.recentTurns),
    events_loaded: nonNegativeSafeIntegerSchema.max(sharedCodexRuntimeContractLimits.recentEvents),
    truncated_before: z.boolean(),
    boundary_cursor: outputCursorSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.truncated_before !== (value.boundary_cursor !== null)) {
      context.addIssue({ code: "custom", message: "Truncated enrollment history requires one explicit boundary cursor." });
    }
  });

export const sharedSessionEnrollmentSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), pending: pendingEnrollmentSnapshotSchema }).strict(),
  z
    .object({
      state: z.literal("enrolled"),
      session: trackedSessionSchema,
      subscribed: z.literal(true),
      enrolled_at: isoTimestampSchema,
      history: sharedEnrollmentHistorySchema,
      boundary_required: z.literal(false)
    })
    .strict()
    .superRefine((value, context) => {
      if (value.enrolled_at < value.session.created_at) {
        context.addIssue({ code: "custom", message: "Enrollment cannot precede native session creation." });
      }
    }),
  z
    .object({
      state: z.literal("ineligible"),
      candidate: loadedThreadCandidateSchema,
      rejected_at: isoTimestampSchema,
      boundary_required: z.literal(false)
    })
    .strict()
    .superRefine((value, context) => {
      if (value.candidate.eligibility.state !== "ineligible") {
        context.addIssue({ code: "custom", path: ["candidate"], message: "An ineligible enrollment requires an ineligible candidate." });
      }
      if (value.rejected_at < value.candidate.updated_at) {
        context.addIssue({ code: "custom", path: ["rejected_at"], message: "Candidate rejection cannot precede its metadata revision." });
      }
    }),
  z
    .object({
      state: z.literal("failed"),
      native_thread_id: nativeCodexThreadIdSchema,
      phase: z.enum(pendingEnrollmentPhases),
      failure: z.enum([
        "metadata_failure",
        "pending_overflow",
        "pending_timeout",
        "runtime_boundary",
        "storage_failure",
        "subscription_failure"
      ]),
      failed_at: isoTimestampSchema,
      detail: privacySafeRuntimeDiagnosticSchema,
      boundary_required: z.literal(true)
    })
    .strict()
]);

export const automaticSessionMembershipRecordSchema = z
  .object({
    session_id: sessionIdSchema,
    native_thread_id: nativeCodexThreadIdSchema,
    origin: z.literal("automatic"),
    enrollment_origin: z.enum(sharedSessionEnrollmentOrigins),
    enrolled_at: isoTimestampSchema
  })
  .strict();

export const sharedSessionMembershipRecordSchema = z.discriminatedUnion("origin", [
  automaticSessionMembershipRecordSchema,
  selectedNativeSessionMembershipRecordSchema
]);

export const sharedSessionCatalogEntrySchema = z
  .object({
    tracked: trackedSessionSchema,
    projection: managedSessionProjectionSchema
  })
  .strict()
  .superRefine((value, context) => {
    const strictNativeId = nativeCodexThreadIdSchema.safeParse(value.projection.codex_thread_id);
    if (!strictNativeId.success || strictNativeId.data !== value.tracked.native_thread_id) {
      context.addIssue({ code: "custom", path: ["projection", "codex_thread_id"], message: "Catalog projection must use its tracked native UUID." });
    }
    if (
      value.projection.id !== value.tracked.internal_session_id ||
      value.projection.name !== value.tracked.alias ||
      value.projection.cwd !== value.tracked.cwd ||
      value.projection.runtime_source !== value.tracked.runtime_source ||
      value.projection.runtime_version !== value.tracked.runtime_version ||
      value.projection.created_at !== value.tracked.created_at ||
      value.projection.branch !== value.tracked.branch ||
      (value.projection.session_state === "archived") !== value.tracked.archived ||
      value.projection.archived_at !== value.tracked.archived_at
    ) {
      context.addIssue({ code: "custom", message: "Catalog projection identity must exactly match its tracked session." });
    }
  });

const catalogStreamIdSchema = z
  .string()
  .min(12)
  .max(96)
  .regex(/^catalog_[a-z0-9][a-z0-9_-]{3,87}$/u);
const catalogEventBaseShape = {
  stream_id: catalogStreamIdSchema,
  cursor: outputCursorSchema,
  emitted_at: isoTimestampSchema
};

export const sessionCatalogEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...catalogEventBaseShape,
      type: z.literal("catalog_reset"),
      reason: z.enum(["initial", "reconnect", "reconciliation"]),
      expected_session_count: nonNegativeSafeIntegerSchema.max(sharedCodexRuntimeContractLimits.catalogSessions)
    })
    .strict(),
  z
    .object({
      ...catalogEventBaseShape,
      type: z.literal("session_upsert"),
      session: sharedSessionCatalogEntrySchema
    })
    .strict(),
  z
    .object({
      ...catalogEventBaseShape,
      type: z.literal("session_remove"),
      native_thread_id: nativeCodexThreadIdSchema,
      internal_session_id: sessionIdSchema,
      reason: z.enum(["archived", "ineligible", "missing", "reconciled"])
    })
    .strict(),
  z
    .object({
      ...catalogEventBaseShape,
      type: z.literal("catalog_ready"),
      session_count: nonNegativeSafeIntegerSchema.max(sharedCodexRuntimeContractLimits.catalogSessions),
      endpoint_generation: nonNegativeSafeIntegerSchema
    })
    .strict(),
  z
    .object({
      ...catalogEventBaseShape,
      type: z.literal("catalog_boundary"),
      reason: z.enum(["lag", "overflow", "reconciliation", "runtime", "storage", "unknown_required_event"]),
      reset_required: z.literal(true),
      detail: privacySafeRuntimeDiagnosticSchema
    })
    .strict()
]);

export const sessionCatalogBootstrapSchema = z
  .array(sessionCatalogEventSchema)
  .min(2)
  .max(sharedCodexRuntimeContractLimits.catalogSessions + 2)
  .superRefine((events, context) => {
    const first = events[0];
    const last = events.at(-1);
    if (first?.type !== "catalog_reset") {
      context.addIssue({ code: "custom", path: [0], message: "Catalog bootstrap must begin with reset metadata." });
      return;
    }
    if (last?.type !== "catalog_ready") {
      context.addIssue({ code: "custom", path: [events.length - 1], message: "Catalog bootstrap must end with ready metadata." });
      return;
    }

    const nativeIds = new Set<string>();
    const internalIds = new Set<string>();
    for (const [index, event] of events.entries()) {
      if (event.stream_id !== first.stream_id) {
        context.addIssue({ code: "custom", path: [index, "stream_id"], message: "Catalog bootstrap must use one stream id." });
      }
      const previous = events[index - 1];
      if (previous !== undefined && event.cursor !== previous.cursor + 1) {
        context.addIssue({ code: "custom", path: [index, "cursor"], message: "Catalog bootstrap cursors must be contiguous." });
      }
      if (previous !== undefined && event.emitted_at < previous.emitted_at) {
        context.addIssue({ code: "custom", path: [index, "emitted_at"], message: "Catalog bootstrap timestamps cannot regress." });
      }
      if (index > 0 && index < events.length - 1 && event.type !== "session_upsert") {
        context.addIssue({ code: "custom", path: [index], message: "Catalog bootstrap may contain only session upserts between reset and ready." });
      }
      if (event.type === "session_upsert") {
        if (nativeIds.has(event.session.tracked.native_thread_id) || internalIds.has(event.session.tracked.internal_session_id)) {
          context.addIssue({ code: "custom", path: [index], message: "Catalog bootstrap cannot repeat a session identity." });
        }
        nativeIds.add(event.session.tracked.native_thread_id);
        internalIds.add(event.session.tracked.internal_session_id);
      }
    }
    if (nativeIds.size !== first.expected_session_count || nativeIds.size !== last.session_count) {
      context.addIssue({ code: "custom", message: "Catalog reset, upserts, and ready counts must agree." });
    }
  });

export type SharedSessionTarget = z.infer<typeof sharedSessionTargetSchema>;
export type TrackedSession = z.infer<typeof trackedSessionSchema>;
export type LoadedThreadCandidate = z.infer<typeof loadedThreadCandidateSchema>;
export type SharedCodexEndpointLocation = z.infer<typeof sharedCodexEndpointLocationSchema>;
export type SharedCodexEndpoint = z.infer<typeof sharedCodexEndpointSchema>;
export type PendingEnrollmentNotification = z.infer<typeof pendingEnrollmentNotificationSchema>;
export type PendingEnrollmentSnapshot = z.infer<typeof pendingEnrollmentSnapshotSchema>;
export type SharedSessionEnrollment = z.infer<typeof sharedSessionEnrollmentSchema>;
export type AutomaticSessionMembershipRecord = z.infer<typeof automaticSessionMembershipRecordSchema>;
export type SharedSessionMembershipRecord = z.infer<typeof sharedSessionMembershipRecordSchema>;
export type SharedSessionCatalogEntry = z.infer<typeof sharedSessionCatalogEntrySchema>;
export type SessionCatalogEvent = z.infer<typeof sessionCatalogEventSchema>;
