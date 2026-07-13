import { z } from "zod";
import { isoTimestampSchema } from "./scalars.js";
import { clientOperationIdSchema } from "./selected-runtime.js";

export const selectedDeviceIdSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/u);

export const selectedDeviceRevocationResultSchema = z
  .object({
    deviceId: selectedDeviceIdSchema,
    revokedAt: isoTimestampSchema,
    previouslyRevoked: z.boolean(),
    authorityInvalidated: z.literal(true)
  })
  .strict();

export type SelectedDeviceRevocationResult = z.infer<typeof selectedDeviceRevocationResultSchema>;

export const selectedDeviceRevokeParamsSchema = z
  .object({
    device_id: selectedDeviceIdSchema
  })
  .strict();

export const selectedDeviceRevokeRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    confirmed: z.literal(true)
  })
  .strict();

export const selectedDeviceRevokeResponseSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    device_id: selectedDeviceIdSchema,
    revoked_at: isoTimestampSchema,
    authority_invalidated: z.literal(true),
    self_revoked: z.boolean()
  })
  .strict();

export type SelectedDeviceRevokeParams = z.infer<
  typeof selectedDeviceRevokeParamsSchema
>;
export type SelectedDeviceRevokeRequest = z.infer<
  typeof selectedDeviceRevokeRequestSchema
>;
export type SelectedDeviceRevokeResponse = z.infer<
  typeof selectedDeviceRevokeResponseSchema
>;
