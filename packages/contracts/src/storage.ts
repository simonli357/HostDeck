import { attentionLevels, commandIntents, errorCodes, lifecycleStates, sessionStatuses } from "@hostdeck/core";
import { z } from "zod";
import {
  absoluteCwdSchema,
  bindModeSchema,
  isoTimestampSchema,
  outputCursorSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";

const storageLimits = {
  idLength: 120,
  labelLength: 120,
  fieldKeyLength: 64,
  payloadFieldCount: 16,
  payloadStringLength: 256,
  summaryLength: 512,
  outputTextLength: 12_000,
  staleReasonLength: 240,
  hashLength: 256,
  maxRetentionEvents: 1_000_000,
  maxRetentionBytes: 1_000_000_000,
  maxRetentionDays: 365
} as const;

const boundedKeyPattern = /^[a-zA-Z0-9_.-]+$/u;
const sensitiveKeyPattern = /(authorization|cookie|password|secret|token)/iu;

const recordIdSchema = z.string().min(1).max(storageLimits.idLength);
const labelSchema = z.string().min(1).max(storageLimits.labelLength);
const nullableLabelSchema = labelSchema.nullable();
const secretHashSchema = z.string().min(32).max(storageLimits.hashLength).regex(/^\S+$/u);
const permissionModeSchema = z.enum(["read", "write"]);
const auditResultSchema = z.enum(["accepted", "rejected", "succeeded", "failed"]);
const outputEventKindSchema = z.enum(["output", "replay_boundary", "system"]);
const retentionScopeSchema = z.enum(["output", "audit"]);
const retentionReasonSchema = z.enum(["event_limit", "byte_limit", "age_limit", "manual_cleanup"]);

const payloadSummaryValueSchema = z.union([
  z.string().max(storageLimits.payloadStringLength),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

export const auditPayloadSummarySchema = z
  .record(z.string(), payloadSummaryValueSchema)
  .superRefine((value, context) => {
    const entries = Object.entries(value);

    if (entries.length > storageLimits.payloadFieldCount) {
      context.addIssue({
        code: "custom",
        message: `Audit payload summary must have ${storageLimits.payloadFieldCount} fields or fewer.`
      });
    }

    for (const [key] of entries) {
      if (key.length === 0 || key.length > storageLimits.fieldKeyLength || !boundedKeyPattern.test(key)) {
        context.addIssue({
          code: "custom",
          message: `Audit payload key "${key}" is invalid.`
        });
        continue;
      }

      if (sensitiveKeyPattern.test(key)) {
        context.addIssue({
          code: "custom",
          message: `Audit payload key "${key}" appears sensitive.`
        });
      }
    }
  });

export const schemaMigrationRecordSchema = z
  .object({
    version: recordIdSchema,
    applied_at: isoTimestampSchema,
    checksum: z.string().min(32).max(128).optional()
  })
  .strict();

export const retentionPolicySchema = z
  .object({
    output_event_limit: z.number().int().positive().max(storageLimits.maxRetentionEvents),
    output_byte_limit: z.number().int().positive().max(storageLimits.maxRetentionBytes),
    audit_event_limit: z.number().int().positive().max(storageLimits.maxRetentionEvents),
    audit_retention_days: z.number().int().positive().max(storageLimits.maxRetentionDays)
  })
  .strict();

export const defaultRetentionPolicy = {
  output_event_limit: 10_000,
  output_byte_limit: 10_000_000,
  audit_event_limit: 5_000,
  audit_retention_days: 30
} as const;

export const settingsRecordSchema = z
  .object({
    id: z.literal("hostdeck_settings"),
    schema_version: z.number().int().positive(),
    state_dir: absoluteCwdSchema,
    bind_mode: bindModeSchema,
    bind_host: z.string().min(1).max(253),
    bind_port: z.number().int().min(1).max(65_535),
    lan_enabled: z.boolean(),
    locked: z.boolean(),
    retention: retentionPolicySchema,
    updated_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.bind_mode === "lan") !== value.lan_enabled) {
      context.addIssue({
        code: "custom",
        message: "Stored bind mode and LAN flag must describe the same configured network state."
      });
    }
  });

export const storageSessionRecordSchema = z
  .object({
    id: sessionIdSchema,
    name: sessionNameSchema,
    cwd: absoluteCwdSchema,
    backend: z
      .object({
        type: z.literal("tmux"),
        tmux_session: z.string().min(1).max(storageLimits.labelLength),
        tmux_window: z.string().min(1).max(storageLimits.labelLength).nullable(),
        tmux_pane: z.string().min(1).max(storageLimits.labelLength).nullable()
      })
      .strict(),
    lifecycle_state: z.enum(lifecycleStates),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    stale_reason: z.string().min(1).max(storageLimits.staleReasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lifecycle_state === "stale" && value.stale_reason === null) {
      context.addIssue({
        code: "custom",
        message: "Stale sessions must record a stale reason."
      });
    }

    if (value.lifecycle_state !== "stale" && value.stale_reason !== null) {
      context.addIssue({
        code: "custom",
        message: "Only stale sessions may carry a stale reason."
      });
    }
  });

export const sessionMetadataRecordSchema = z
  .object({
    session_id: sessionIdSchema,
    branch: z.string().min(1).max(240).nullable(),
    last_activity_at: isoTimestampSchema.nullable(),
    status: z.enum(sessionStatuses),
    attention: z.enum(attentionLevels),
    summary: z.string().max(storageLimits.summaryLength).nullable(),
    last_output_cursor: outputCursorSchema.nullable(),
    updated_at: isoTimestampSchema
  })
  .strict();

export const outputEventRecordSchema = z
  .object({
    session_id: sessionIdSchema,
    cursor: outputCursorSchema,
    order: z.number().int().nonnegative(),
    captured_at: isoTimestampSchema.nullable(),
    kind: outputEventKindSchema,
    payload: z.string().max(storageLimits.outputTextLength).nullable(),
    truncated_before: outputCursorSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "output" && value.payload === null) {
      context.addIssue({
        code: "custom",
        message: "Output events must carry a payload."
      });
    }

    if (value.kind === "replay_boundary" && value.truncated_before === null) {
      context.addIssue({
        code: "custom",
        message: "Replay boundary events must record the truncated cursor."
      });
    }
  });

export const retentionBoundaryRecordSchema = z
  .object({
    id: recordIdSchema,
    scope: retentionScopeSchema,
    session_id: sessionIdSchema.nullable(),
    reason: retentionReasonSchema,
    truncated_before_cursor: outputCursorSchema.nullable(),
    truncated_before_at: isoTimestampSchema.nullable(),
    retained_record_count: z.number().int().nonnegative(),
    applied_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === "output" && value.session_id === null) {
      context.addIssue({
        code: "custom",
        message: "Output retention boundaries must reference a session."
      });
    }

    if (value.scope === "output" && value.truncated_before_cursor === null) {
      context.addIssue({
        code: "custom",
        message: "Output retention boundaries must record a cursor boundary."
      });
    }

    if (value.scope === "audit" && value.session_id !== null) {
      context.addIssue({
        code: "custom",
        message: "Audit retention boundaries must be global."
      });
    }

    if (value.scope === "audit" && value.truncated_before_cursor !== null) {
      context.addIssue({
        code: "custom",
        message: "Audit retention boundaries must not record an output cursor."
      });
    }
  });

export const authDeviceRecordSchema = z
  .object({
    id: recordIdSchema,
    token_hash: secretHashSchema,
    csrf_token_hash: secretHashSchema,
    client_label: nullableLabelSchema,
    permission: permissionModeSchema,
    created_at: isoTimestampSchema,
    last_used_at: isoTimestampSchema.nullable(),
    expires_at: isoTimestampSchema.nullable(),
    revoked_at: isoTimestampSchema.nullable()
  })
  .strict();

export const pairingCodeRecordSchema = z
  .object({
    id: recordIdSchema,
    code_hash: secretHashSchema,
    permission: permissionModeSchema,
    client_label: nullableLabelSchema,
    created_at: isoTimestampSchema,
    expires_at: isoTimestampSchema,
    used_at: isoTimestampSchema.nullable(),
    revoked_at: isoTimestampSchema.nullable()
  })
  .strict();

export const auditEventRecordSchema = z
  .object({
    id: recordIdSchema,
    at: isoTimestampSchema,
    actor: z
      .object({
        type: z.enum(["system", "cli", "dashboard"]),
        client_id: recordIdSchema.nullable(),
        permission: permissionModeSchema.nullable()
      })
      .strict(),
    action: z.enum(commandIntents),
    session_id: sessionIdSchema.nullable(),
    payload_summary: auditPayloadSummarySchema,
    result: auditResultSchema,
    error_code: z.enum(errorCodes).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const failed = value.result === "rejected" || value.result === "failed";
    const sessionScopedActions = new Set(["prompt", "slash", "stop", "raw_input"]);

    if (failed && value.error_code === null) {
      context.addIssue({
        code: "custom",
        message: "Rejected or failed audit events must carry an error code."
      });
    }

    if (!failed && value.error_code !== null) {
      context.addIssue({
        code: "custom",
        message: "Accepted or succeeded audit events must not carry an error code."
      });
    }

    if (value.actor.type === "dashboard" && (value.actor.client_id === null || value.actor.permission === null)) {
      context.addIssue({
        code: "custom",
        message: "Dashboard audit actors must include client identity and permission mode."
      });
    }

    if (value.actor.type === "system" && (value.actor.client_id !== null || value.actor.permission !== null)) {
      context.addIssue({
        code: "custom",
        message: "System audit actors must not carry client identity or permission mode."
      });
    }

    if (sessionScopedActions.has(value.action) && value.session_id === null) {
      context.addIssue({
        code: "custom",
        message: "Session write audit actions must reference the selected session."
      });
    }
  });

export type SchemaMigrationRecord = z.infer<typeof schemaMigrationRecordSchema>;
export type SettingsRecord = z.infer<typeof settingsRecordSchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type StorageSessionRecord = z.infer<typeof storageSessionRecordSchema>;
export type SessionMetadataRecord = z.infer<typeof sessionMetadataRecordSchema>;
export type OutputEventRecord = z.infer<typeof outputEventRecordSchema>;
export type RetentionBoundaryRecord = z.infer<typeof retentionBoundaryRecordSchema>;
export type AuthDeviceRecord = z.infer<typeof authDeviceRecordSchema>;
export type PairingCodeRecord = z.infer<typeof pairingCodeRecordSchema>;
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;
