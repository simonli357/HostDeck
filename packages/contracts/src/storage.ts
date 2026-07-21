import { z } from "zod";
import {
  absoluteCwdSchema,
  isoTimestampSchema,
  positiveSafeIntegerSchema,
} from "./scalars.js";

const storageLimits = {
  idLength: 120,
  labelLength: 120,
  fieldKeyLength: 64,
  payloadFieldCount: 16,
  payloadStringLength: 256,
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
const selectedSecretHashPattern = /^sha256:[a-f0-9]{64}$/u;
const permissionModeSchema = z.enum(["read", "write"]);

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
    schema_version: positiveSafeIntegerSchema,
    state_dir: absoluteCwdSchema,
    bind_port: z.number().int().min(1).max(65_535),
    locked: z.boolean(),
    retention: retentionPolicySchema,
    updated_at: isoTimestampSchema
  })
  .strict();

export const authDeviceRecordSchema = z
  .object({
    id: recordIdSchema,
    token_hash: secretHashSchema,
    csrf_token_hash: secretHashSchema,
    csrf_generation: positiveSafeIntegerSchema,
    csrf_rotated_at: isoTimestampSchema,
    client_label: nullableLabelSchema,
    permission: permissionModeSchema,
    created_at: isoTimestampSchema,
    last_used_at: isoTimestampSchema.nullable(),
    expires_at: isoTimestampSchema.nullable(),
    revoked_at: isoTimestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const createdAt = Date.parse(value.created_at);
    const csrfRotatedAt = Date.parse(value.csrf_rotated_at);
    const expiresAt = value.expires_at === null ? null : Date.parse(value.expires_at);
    const lastUsedAt = value.last_used_at === null ? null : Date.parse(value.last_used_at);
    const revokedAt = value.revoked_at === null ? null : Date.parse(value.revoked_at);
    if (csrfRotatedAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "CSRF rotation time cannot precede device creation.",
        path: ["csrf_rotated_at"]
      });
    }
    if (lastUsedAt !== null && lastUsedAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Auth device last-used time cannot precede device creation.",
        path: ["last_used_at"]
      });
    }
    if (
      lastUsedAt !== null &&
      expiresAt !== null &&
      lastUsedAt >= expiresAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Auth device last-used time must precede device expiry.",
        path: ["last_used_at"]
      });
    }
    if (expiresAt !== null && expiresAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Auth device expiry cannot precede device creation.",
        path: ["expires_at"]
      });
    }
    if (expiresAt !== null && csrfRotatedAt > expiresAt) {
      context.addIssue({
        code: "custom",
        message: "CSRF rotation time cannot follow device expiry.",
        path: ["csrf_rotated_at"]
      });
    }
    if (revokedAt !== null && revokedAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Auth device revocation cannot precede device creation.",
        path: ["revoked_at"]
      });
    }
    if (revokedAt !== null && revokedAt < csrfRotatedAt) {
      context.addIssue({
        code: "custom",
        message: "Auth device revocation cannot precede current CSRF rotation.",
        path: ["revoked_at"]
      });
    }
    if (revokedAt !== null && lastUsedAt !== null && revokedAt < lastUsedAt) {
      context.addIssue({
        code: "custom",
        message: "Auth device revocation cannot precede last use.",
        path: ["revoked_at"]
      });
    }
  });

export const pairingCodeRecordSchema = z
  .object({
    id: recordIdSchema,
    code_hash: secretHashSchema,
    permission: permissionModeSchema,
    client_label: nullableLabelSchema,
    created_at: isoTimestampSchema,
    expires_at: isoTimestampSchema,
    used_at: isoTimestampSchema.nullable(),
    revoked_at: isoTimestampSchema.nullable(),
    claim_contract_version: z.literal(1).nullable(),
    claimed_device_id: recordIdSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const createdAt = Date.parse(value.created_at);
    const expiresAt = Date.parse(value.expires_at);
    const usedAt = value.used_at === null ? null : Date.parse(value.used_at);
    const revokedAt = value.revoked_at === null ? null : Date.parse(value.revoked_at);

    if (usedAt !== null && usedAt < createdAt) {
      context.addIssue({ code: "custom", message: "Pairing-code use cannot precede creation.", path: ["used_at"] });
    }
    if (revokedAt !== null && revokedAt < createdAt) {
      context.addIssue({ code: "custom", message: "Pairing-code revocation cannot precede creation.", path: ["revoked_at"] });
    }
    if (value.claim_contract_version === null) {
      if (value.claimed_device_id !== null) {
        context.addIssue({
          code: "custom",
          message: "Legacy pairing-code rows cannot claim selected device ownership.",
          path: ["claimed_device_id"]
        });
      }
      return;
    }
    if (expiresAt <= createdAt) {
      context.addIssue({ code: "custom", message: "Selected pairing-code expiry must follow creation.", path: ["expires_at"] });
    }
    if (!selectedSecretHashPattern.test(value.code_hash)) {
      context.addIssue({
        code: "custom",
        message: "Selected pairing-code hashes must use exact SHA-256 encoding.",
        path: ["code_hash"]
      });
    }
    if ((value.used_at === null) !== (value.claimed_device_id === null)) {
      context.addIssue({
        code: "custom",
        message: "Selected pairing-code use and claimed-device ownership must appear together."
      });
    }
    if (usedAt !== null && usedAt >= expiresAt) {
      context.addIssue({ code: "custom", message: "Selected pairing-code use must precede expiry.", path: ["used_at"] });
    }
    if (value.used_at !== null && value.revoked_at !== null) {
      context.addIssue({ code: "custom", message: "Selected pairing codes cannot be both used and revoked." });
    }
  });

export type SchemaMigrationRecord = z.infer<typeof schemaMigrationRecordSchema>;
export type SettingsRecord = z.infer<typeof settingsRecordSchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type AuthDeviceRecord = z.infer<typeof authDeviceRecordSchema>;
export type PairingCodeRecord = z.infer<typeof pairingCodeRecordSchema>;
