import { z } from "zod";
import { selectedDeviceIdSchema } from "./device-revocation.js";
import { isoTimestampSchema } from "./scalars.js";

export const selectedDeviceListMaxPageSize = 100;
export const selectedDeviceListDefaultPageSize = selectedDeviceListMaxPageSize;
export const selectedDeviceListCursorVersion = "v1";
export const selectedDeviceListCursorMaxLength = 163;

const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const canonicalPageLimitTextSchema = z
  .string()
  .min(1)
  .max(3)
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u);

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

export const selectedDeviceListCursorSchema = z
  .string()
  .min(5)
  .max(selectedDeviceListCursorMaxLength)
  .regex(/^v1\.[A-Za-z0-9_-]{2,160}$/u)
  .superRefine((value, context) => {
    try {
      decodeSelectedDeviceListCursor(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Selected device-list cursor is invalid."
      });
    }
  });

export const selectedDeviceListQuerySchema = z
  .object({
    limit: canonicalPageLimitTextSchema.optional(),
    cursor: selectedDeviceListCursorSchema.optional()
  })
  .strict()
  .transform((value) =>
    Object.freeze({
      limit: value.limit === undefined ? selectedDeviceListDefaultPageSize : Number(value.limit),
      afterDeviceId:
        value.cursor === undefined ? null : decodeSelectedDeviceListCursor(value.cursor)
    })
  );

export const selectedDeviceListResponseItemSchema = z
  .object({
    device_id: selectedDeviceIdSchema,
    client_label: selectedDeviceListItemSchema.shape.clientLabel,
    permission: selectedDeviceListItemSchema.shape.permission,
    created_at: isoTimestampSchema,
    last_used_at: isoTimestampSchema.nullable(),
    expires_at: isoTimestampSchema.nullable(),
    revoked_at: isoTimestampSchema.nullable()
  })
  .strict();

export const selectedDeviceListResponseSchema = z
  .object({
    devices: z.array(selectedDeviceListResponseItemSchema).max(selectedDeviceListMaxPageSize),
    next_cursor: selectedDeviceListCursorSchema.nullable(),
    has_more: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.devices.length; index += 1) {
      const previous = value.devices[index - 1];
      const current = value.devices[index];
      if (previous !== undefined && current !== undefined && previous.device_id >= current.device_id) {
        context.addIssue({
          code: "custom",
          message: "Selected device-list response items must be in strictly ascending id order.",
          path: ["devices", index, "device_id"]
        });
      }
    }

    if (value.has_more !== (value.next_cursor !== null)) {
      context.addIssue({
        code: "custom",
        message: "Selected device-list response continuation and has-more state must agree."
      });
    }

    const finalDeviceId = value.devices.at(-1)?.device_id ?? null;
    if (
      value.next_cursor !== null &&
      decodeCursorForRefinement(value.next_cursor) !== finalDeviceId
    ) {
      context.addIssue({
        code: "custom",
        message: "Selected device-list response cursor must encode the final returned device id.",
        path: ["next_cursor"]
      });
    }
  });

export function encodeSelectedDeviceListCursor(deviceId: string): string {
  const parsed = selectedDeviceIdSchema.safeParse(deviceId);
  if (!parsed.success) throw new TypeError("Selected device-list cursor device id is invalid.");
  return `${selectedDeviceListCursorVersion}.${encodeBase64UrlAscii(parsed.data)}`;
}

export function decodeSelectedDeviceListCursor(cursor: string): string {
  if (
    typeof cursor !== "string" ||
    cursor.length < 5 ||
    cursor.length > selectedDeviceListCursorMaxLength ||
    !cursor.startsWith(`${selectedDeviceListCursorVersion}.`)
  ) {
    throw new TypeError("Selected device-list cursor is invalid.");
  }
  const payload = cursor.slice(selectedDeviceListCursorVersion.length + 1);
  if (!/^[A-Za-z0-9_-]{2,160}$/u.test(payload)) {
    throw new TypeError("Selected device-list cursor is invalid.");
  }
  const deviceId = decodeBase64UrlAscii(payload);
  const parsed = selectedDeviceIdSchema.safeParse(deviceId);
  if (!parsed.success || encodeBase64UrlAscii(parsed.data) !== payload) {
    throw new TypeError("Selected device-list cursor is invalid.");
  }
  return parsed.data;
}

function encodeBase64UrlAscii(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value.charCodeAt(index);
    const second = index + 1 < value.length ? value.charCodeAt(index + 1) : null;
    const third = index + 2 < value.length ? value.charCodeAt(index + 2) : null;
    if (first > 0x7f || (second !== null && second > 0x7f) || (third !== null && third > 0x7f)) {
      throw new TypeError("Selected device-list cursor device id is invalid.");
    }
    encoded += base64UrlAlphabet[first >> 2];
    encoded += base64UrlAlphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== null) {
      encoded += base64UrlAlphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== null) encoded += base64UrlAlphabet[third & 0x3f];
  }
  return encoded;
}

function decodeBase64UrlAscii(payload: string): string {
  if (payload.length % 4 === 1) throw new TypeError("Selected device-list cursor is invalid.");
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];
  for (const character of payload) {
    const value = base64UrlAlphabet.indexOf(character);
    if (value < 0) throw new TypeError("Selected device-list cursor is invalid.");
    bits = (bits << 6) | value;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >> bitCount) & 0xff);
      bits &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
    }
  }
  if (bitCount !== 0 && bits !== 0) throw new TypeError("Selected device-list cursor is invalid.");
  if (bytes.length < 1 || bytes.length > 120 || bytes.some((value) => value > 0x7f)) {
    throw new TypeError("Selected device-list cursor is invalid.");
  }
  return String.fromCharCode(...bytes);
}

function decodeCursorForRefinement(cursor: string): string | null {
  try {
    return decodeSelectedDeviceListCursor(cursor);
  } catch {
    return null;
  }
}

export type SelectedDeviceListInput = z.infer<typeof selectedDeviceListInputSchema>;
export type SelectedDeviceListItem = z.infer<typeof selectedDeviceListItemSchema>;
export type SelectedDeviceListPage = z.infer<typeof selectedDeviceListPageSchema>;
export type SelectedDeviceListQuery = z.infer<typeof selectedDeviceListQuerySchema>;
export type SelectedDeviceListResponseItem = z.infer<typeof selectedDeviceListResponseItemSchema>;
export type SelectedDeviceListResponse = z.infer<typeof selectedDeviceListResponseSchema>;
