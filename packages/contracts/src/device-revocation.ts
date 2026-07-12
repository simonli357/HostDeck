import { z } from "zod";
import { isoTimestampSchema } from "./scalars.js";

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
