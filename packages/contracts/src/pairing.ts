import { z } from "zod";
import { isoTimestampSchema, positiveSafeIntegerSchema } from "./scalars.js";

export const pairingClaimSourceKeySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const selectedRawPairingCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u);
export const selectedRawDeviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const pairingClientLabelSchema = z.string().min(1).max(120).nullable();

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
