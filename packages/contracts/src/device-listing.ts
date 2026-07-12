import { z } from "zod";
import { selectedDeviceIdSchema } from "./device-revocation.js";
import { isoTimestampSchema } from "./scalars.js";

export const selectedDeviceListMaxPageSize = 100;

export const selectedDeviceListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(selectedDeviceListMaxPageSize),
    afterDeviceId: selectedDeviceIdSchema.nullable()
  })
  .strict();

export const selectedDeviceListItemSchema = z
  .object({
    deviceId: selectedDeviceIdSchema,
    clientLabel: z.string().min(1).max(120).nullable(),
    permission: z.enum(["read", "write"]),
    createdAt: isoTimestampSchema,
    lastUsedAt: isoTimestampSchema.nullable(),
    expiresAt: isoTimestampSchema.nullable(),
    revokedAt: isoTimestampSchema.nullable()
  })
  .strict();

export const selectedDeviceListPageSchema = z
  .object({
    devices: z.array(selectedDeviceListItemSchema).max(selectedDeviceListMaxPageSize),
    nextAfterDeviceId: selectedDeviceIdSchema.nullable(),
    hasMore: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.devices.length; index += 1) {
      const previous = value.devices[index - 1];
      const current = value.devices[index];
      if (previous !== undefined && current !== undefined && previous.deviceId >= current.deviceId) {
        context.addIssue({
          code: "custom",
          message: "Selected device-list items must be in strictly ascending id order.",
          path: ["devices", index, "deviceId"]
        });
      }
    }
    const lastDeviceId = value.devices.at(-1)?.deviceId ?? null;
    if (value.hasMore !== (value.nextAfterDeviceId !== null)) {
      context.addIssue({
        code: "custom",
        message: "Selected device-list continuation and has-more state must agree."
      });
    }
    if (value.nextAfterDeviceId !== null && value.nextAfterDeviceId !== lastDeviceId) {
      context.addIssue({
        code: "custom",
        message: "Selected device-list continuation must equal the final returned device id.",
        path: ["nextAfterDeviceId"]
      });
    }
  });

export type SelectedDeviceListInput = z.infer<typeof selectedDeviceListInputSchema>;
export type SelectedDeviceListItem = z.infer<typeof selectedDeviceListItemSchema>;
export type SelectedDeviceListPage = z.infer<typeof selectedDeviceListPageSchema>;
