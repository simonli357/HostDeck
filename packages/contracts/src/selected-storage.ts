import { errorCodes, selectedAuditActions, selectedAuditOutcomes, selectedOperationKinds, selectedRuntimeSource } from "@hostdeck/core";
import { z } from "zod";
import {
  absoluteCwdSchema,
  isoTimestampSchema,
  outputCursorSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";
import { managedSessionTargetSchema } from "./selected-operations.js";
import {
  clientOperationIdSchema,
  codexThreadIdSchema,
  codexVersionSchema,
  managedSessionProjectionSchema,
  runtimeCompatibilitySchema,
  runtimeRequestIdSchema,
  selectedProjectionEventSchema
} from "./selected-runtime.js";
import { auditPayloadSummarySchema } from "./storage.js";

const selectedStorageLimits = {
  idLength: 120,
  labelLength: 120,
  reasonLength: 240,
  eventBytes: 1_000_000,
  projectionEvents: 1_000_000,
  projectionBytes: 1_000_000_000
} as const;

const selectedRecordIdSchema = z.string().min(1).max(selectedStorageLimits.idLength).regex(/^[a-zA-Z0-9_.:-]+$/u);

export const selectedSessionMappingRecordSchema = z
  .object({
    id: sessionIdSchema,
    name: sessionNameSchema,
    codex_thread_id: codexThreadIdSchema,
    cwd: absoluteCwdSchema,
    runtime_source: z.literal(selectedRuntimeSource),
    runtime_version: codexVersionSchema,
    disposition: z.enum(["selected", "recovery_required"]),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    archived_at: isoTimestampSchema.nullable()
  })
  .strict();

export const legacySessionDispositionRecordSchema = z
  .object({
    id: sessionIdSchema,
    name: sessionNameSchema,
    cwd: absoluteCwdSchema,
    disposition: z.literal("legacy_unmigrated"),
    reason: z.string().min(1).max(selectedStorageLimits.reasonLength),
    updated_at: isoTimestampSchema
  })
  .strict();

export const selectedSessionProjectionRecordSchema = z
  .object({
    session: managedSessionProjectionSchema,
    retained_event_count: z.number().int().nonnegative().max(selectedStorageLimits.projectionEvents),
    retained_event_bytes: z.number().int().nonnegative().max(selectedStorageLimits.projectionBytes),
    earliest_retained_cursor: outputCursorSchema.nullable(),
    retention_boundary_cursor: outputCursorSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retained_event_count === 0 && value.earliest_retained_cursor !== null) {
      context.addIssue({ code: "custom", message: "An empty projection cannot advertise an earliest retained cursor." });
    }
    if (value.retained_event_count > 0 && value.earliest_retained_cursor === null) {
      context.addIssue({ code: "custom", message: "A non-empty projection must record its earliest retained cursor." });
    }
    if (
      value.retention_boundary_cursor !== null &&
      value.earliest_retained_cursor !== null &&
      value.retention_boundary_cursor >= value.earliest_retained_cursor
    ) {
      context.addIssue({ code: "custom", message: "A retention boundary must precede the earliest retained event cursor." });
    }
  });

export const selectedProjectedEventRecordSchema = z
  .object({
    event: selectedProjectionEventSchema,
    byte_length: z.number().int().positive().max(selectedStorageLimits.eventBytes)
  })
  .strict();

export const selectedRuntimeCompatibilityRecordSchema = z
  .object({
    id: z.literal("hostdeck_runtime"),
    compatibility: runtimeCompatibilitySchema,
    recorded_at: isoTimestampSchema
  })
  .strict();

export const selectedSessionStartRecoveryRecordSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    session_id: sessionIdSchema,
    name: sessionNameSchema,
    cwd: absoluteCwdSchema,
    codex_thread_id: codexThreadIdSchema.nullable(),
    state: z.enum(["reserved", "thread_created", "persisted", "failed"]),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    error_code: z.enum(errorCodes).nullable(),
    error_message: z.string().min(1).max(selectedStorageLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (["thread_created", "persisted"].includes(value.state) && value.codex_thread_id === null) {
      context.addIssue({ code: "custom", message: "Thread-created and persisted recovery states require the returned thread id." });
    }
    if (value.state === "failed" && (value.error_code === null || value.error_message === null)) {
      context.addIssue({ code: "custom", message: "Failed session-start recovery records must preserve a bounded cause." });
    }
    if (value.state !== "failed" && (value.error_code !== null || value.error_message !== null)) {
      context.addIssue({ code: "custom", message: "Only failed session-start recovery records may carry an error." });
    }
  });

export const selectedAuditActorSchema = z
  .object({
    type: z.enum(["system", "cli", "dashboard"]),
    device_id: selectedRecordIdSchema.nullable(),
    permission: z.enum(["local_admin", "read", "write"]).nullable(),
    origin: z.string().min(1).max(253).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "dashboard" && (value.device_id === null || value.permission === null || value.origin === null)) {
      context.addIssue({ code: "custom", message: "Dashboard audit actors require device, permission, and origin identity." });
    }
    if (value.type === "system" && (value.device_id !== null || value.permission !== null || value.origin !== null)) {
      context.addIssue({ code: "custom", message: "System audit actors must not carry client authority." });
    }
    if (value.type === "cli" && value.permission !== "local_admin") {
      context.addIssue({ code: "custom", message: "CLI audit actors must use local-admin authority." });
    }
  });

export const selectedSessionAuditTargetSchema = managedSessionTargetSchema.extend({
  type: z.literal("managed_session")
});

export const selectedApprovalAuditTargetSchema = z
  .object({
    type: z.literal("approval"),
    session_id: sessionIdSchema,
    codex_thread_id: codexThreadIdSchema,
    request_id: runtimeRequestIdSchema
  })
  .strict();

export const selectedDeviceAuditTargetSchema = z
  .object({
    type: z.literal("device"),
    device_id: selectedRecordIdSchema
  })
  .strict();

export const selectedHostAuditTargetSchema = z
  .object({
    type: z.literal("host"),
    host_id: z.literal("local_host")
  })
  .strict();

export const selectedAuditTargetSchema = z.discriminatedUnion("type", [
  selectedSessionAuditTargetSchema,
  selectedApprovalAuditTargetSchema,
  selectedDeviceAuditTargetSchema,
  selectedHostAuditTargetSchema
]);

export const selectedAuditEventRecordSchema = z
  .object({
    id: selectedRecordIdSchema,
    operation_id: clientOperationIdSchema,
    at: isoTimestampSchema,
    actor: selectedAuditActorSchema,
    action: z.enum(selectedAuditActions),
    target: selectedAuditTargetSchema,
    phase: z.enum(["accepted", "terminal"]),
    outcome: z.enum(selectedAuditOutcomes),
    payload_summary: auditPayloadSummarySchema,
    error_code: z.enum(errorCodes).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const sessionActions = new Set<string>(selectedOperationKinds.filter((action) => action !== "approval_response"));

    if (sessionActions.has(value.action) && value.target.type !== "managed_session") {
      context.addIssue({ code: "custom", message: "Session operations must audit one managed-session target." });
    }
    if (value.action === "approval_response" && value.target.type !== "approval") {
      context.addIssue({ code: "custom", message: "Approval responses must audit one exact approval request target." });
    }
    if (value.action === "device_revoke" && value.target.type !== "device") {
      context.addIssue({ code: "custom", message: "Device revocation must audit one exact device target." });
    }
    if (
      !sessionActions.has(value.action) &&
      value.action !== "approval_response" &&
      value.action !== "device_revoke" &&
      value.target.type !== "host"
    ) {
      context.addIssue({ code: "custom", message: "Host access and network actions must audit the local host target." });
    }
    if (value.phase === "accepted" && value.outcome !== "accepted") {
      context.addIssue({ code: "custom", message: "Accepted audit phases must use the accepted outcome." });
    }
    if (value.phase === "terminal" && value.outcome === "accepted") {
      context.addIssue({ code: "custom", message: "Terminal audit phases cannot use the non-terminal accepted outcome." });
    }
    const failed = ["failed", "rejected", "incomplete"].includes(value.outcome);
    if (failed && value.error_code === null) {
      context.addIssue({ code: "custom", message: "Failed, rejected, or incomplete audit outcomes must preserve an error code." });
    }
    if (!failed && value.error_code !== null) {
      context.addIssue({ code: "custom", message: "Accepted or succeeded audit outcomes must not carry an error code." });
    }
  });

export type SelectedSessionMappingRecord = z.infer<typeof selectedSessionMappingRecordSchema>;
export type LegacySessionDispositionRecord = z.infer<typeof legacySessionDispositionRecordSchema>;
export type SelectedSessionProjectionRecord = z.infer<typeof selectedSessionProjectionRecordSchema>;
export type SelectedProjectedEventRecord = z.infer<typeof selectedProjectedEventRecordSchema>;
export type SelectedRuntimeCompatibilityRecord = z.infer<typeof selectedRuntimeCompatibilityRecordSchema>;
export type SelectedSessionStartRecoveryRecord = z.infer<typeof selectedSessionStartRecoveryRecordSchema>;
export type SelectedAuditActor = z.infer<typeof selectedAuditActorSchema>;
export type SelectedAuditTarget = z.infer<typeof selectedAuditTargetSchema>;
export type SelectedAuditEventRecord = z.infer<typeof selectedAuditEventRecordSchema>;
