import { z } from "zod";
import { selectedRawDeviceSecretSchema } from "./pairing.js";
import { isoTimestampSchema, positiveSafeIntegerSchema } from "./scalars.js";
import { clientOperationIdSchema } from "./selected-runtime.js";

export const selectedCsrfTokenHeaderName = "x-hostdeck-csrf";
export const selectedCsrfGenerationHeaderName = "x-hostdeck-csrf-generation";

export const selectedRawCsrfTokenSchema = selectedRawDeviceSecretSchema;

export const selectedCsrfGenerationHeaderValueSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .transform((value) => Number(value))
  .pipe(positiveSafeIntegerSchema);

export const selectedCsrfBootstrapRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema
  })
  .strict();

export const selectedCsrfBootstrapResponseSchema = z
  .object({
    csrf_token: selectedRawCsrfTokenSchema,
    csrf_generation: positiveSafeIntegerSchema,
    rotated_at: isoTimestampSchema
  })
  .strict();

export type SelectedCsrfBootstrapRequest = z.infer<
  typeof selectedCsrfBootstrapRequestSchema
>;
export type SelectedCsrfBootstrapResponse = z.infer<
  typeof selectedCsrfBootstrapResponseSchema
>;
