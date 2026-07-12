import { z } from "zod";
import { isoTimestampSchema, positiveSafeIntegerSchema } from "./scalars.js";
import { clientOperationIdSchema } from "./selected-runtime.js";

export const pairingClaimSourceKeySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const selectedRawPairingCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u);
export const selectedRawDeviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const selectedPairingIdSchema = z.string().regex(/^pair_[A-Za-z0-9_-]{24}$/u);
export const selectedPairingDeviceIdSchema = z.string().regex(/^client_[A-Za-z0-9_-]{24}$/u);
export const selectedPairingPermissionSchema = z.enum(["read", "write"]);

const invalidPairingLabelCharacterPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export const selectedPairingClientLabelSchema = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (value) => value.trim() === value && !invalidPairingLabelCharacterPattern.test(value),
    "Pairing client labels must be trimmed and contain no control or format characters."
  );
export const pairingClientLabelSchema = selectedPairingClientLabelSchema.nullable();

export const selectedPairRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    permission: selectedPairingPermissionSchema,
    client_label: selectedPairingClientLabelSchema.optional()
  })
  .strict();

export const selectedPairRequestResponseSchema = z
  .object({
    pairing_id: selectedPairingIdSchema,
    code: selectedRawPairingCodeSchema,
    permission: selectedPairingPermissionSchema,
    client_label: pairingClientLabelSchema,
    created_at: isoTimestampSchema,
    expires_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
      context.addIssue({
        code: "custom",
        message: "Pairing-code response expiry must follow creation.",
        path: ["expires_at"]
      });
    }
  });

export const selectedPairClaimRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    code: selectedRawPairingCodeSchema,
    client_label: selectedPairingClientLabelSchema.optional()
  })
  .strict();

export const selectedPairClaimResponseSchema = z
  .object({
    device_id: selectedPairingDeviceIdSchema,
    permission: selectedPairingPermissionSchema,
    client_label: pairingClientLabelSchema,
    created_at: isoTimestampSchema,
    expires_at: isoTimestampSchema,
    csrf_bootstrap_required: z.literal(true)
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
      context.addIssue({
        code: "custom",
        message: "Paired-device response expiry must follow creation.",
        path: ["expires_at"]
      });
    }
  });

export const pairingClaimRateSourceRecordSchema = z
  .object({
    source_key: pairingClaimSourceKeySchema,
    window_started_at: isoTimestampSchema,
    attempt_count: positiveSafeIntegerSchema,
    last_attempt_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.last_attempt_at) < Date.parse(value.window_started_at)) {
      context.addIssue({
        code: "custom",
        message: "Pair-claim source activity cannot precede its window start.",
        path: ["last_attempt_at"]
      });
    }
  });

export const pairingClaimRateGlobalRecordSchema = z
  .object({
    id: z.literal("pair_claim_global"),
    window_started_at: isoTimestampSchema,
    attempt_count: positiveSafeIntegerSchema,
    last_attempt_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.last_attempt_at) < Date.parse(value.window_started_at)) {
      context.addIssue({
        code: "custom",
        message: "Global pair-claim activity cannot precede its window start.",
        path: ["last_attempt_at"]
      });
    }
  });

export type PairingClaimRateSourceRecord = z.infer<typeof pairingClaimRateSourceRecordSchema>;
export type PairingClaimRateGlobalRecord = z.infer<typeof pairingClaimRateGlobalRecordSchema>;
export type SelectedPairRequest = z.infer<typeof selectedPairRequestSchema>;
export type SelectedPairRequestResponse = z.infer<typeof selectedPairRequestResponseSchema>;
export type SelectedPairClaimRequest = z.infer<typeof selectedPairClaimRequestSchema>;
export type SelectedPairClaimResponse = z.infer<typeof selectedPairClaimResponseSchema>;
