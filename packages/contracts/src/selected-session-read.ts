import { attentionLevels, mobileAttentionPriority } from "@hostdeck/core";
import { z } from "zod";
import { exactDataTree } from "./exact-data-object.js";
import { selectedHostAccessModes } from "./host-health.js";
import { selectedRequestNetworkModes } from "./request-authentication.js";
import {
  isoTimestampSchema,
  nonNegativeSafeIntegerSchema,
  outputCursorSchema,
  sessionIdSchema
} from "./scalars.js";
import { managedSessionProjectionSchema } from "./selected-runtime.js";

export const selectedSessionListDefaultPageSize = 50;
export const selectedSessionListMaxPageSize = 100;
export const selectedSessionListMaximumActiveSessions = 4_096;
export const selectedSessionReadMaximumCwdLength = 4_096;
export const selectedSessionListCursorVersion = "v1";
export const selectedSessionListCursorMaxLength = 196;

const selectedSessionListAttentionRanks = Object.freeze([0, 20, 30, 40, 50, 60] as const);
const canonicalPageLimitTextSchema = z
  .string()
  .min(1)
  .max(3)
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u);

export const selectedSessionListOrderSnapshotSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);

export const selectedSessionListOrderEntrySchema = frozenExactData(
  z
    .object({
      attention: z.enum(attentionLevels),
      id: sessionIdSchema,
      last_activity_at: isoTimestampSchema.nullable()
    })
    .strict()
);

export const selectedSessionListSortKeySchema = frozenExactData(
  z
    .object({
      attention_rank: z.union([
        z.literal(0),
        z.literal(20),
        z.literal(30),
        z.literal(40),
        z.literal(50),
        z.literal(60)
      ]),
      last_activity_at: isoTimestampSchema.nullable(),
      session_id: sessionIdSchema
    })
    .strict()
);

export const selectedSessionListCursorValueSchema = frozenExactData(
  z
    .object({
      order_snapshot: selectedSessionListOrderSnapshotSchema,
      after: selectedSessionListSortKeySchema
    })
    .strict()
);

export const selectedSessionListCursorSchema = z
  .string()
  .min(87)
  .max(selectedSessionListCursorMaxLength)
  .regex(
    /^v1\.[0-9a-f]{64}\.(?:0|20|30|40|50|60)\.(?:-|[A-Za-z0-9_-]{32})\.[A-Za-z0-9_-]{15,92}$/u
  )
  .superRefine((value, context) => {
    try {
      decodeSelectedSessionListCursor(value);
    } catch {
      context.addIssue({ code: "custom", message: "Selected session-list cursor is invalid." });
    }
  });

export const selectedSessionListInputSchema = frozenExactData(
  z
    .object({
      limit: z.number().int().min(1).max(selectedSessionListMaxPageSize),
      expected_order_snapshot: selectedSessionListOrderSnapshotSchema.nullable(),
      after: selectedSessionListSortKeySchema.nullable()
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.expected_order_snapshot === null) !== (value.after === null)) {
        context.addIssue({
          code: "custom",
          message: "Selected session-list snapshot and continuation key must be present together."
        });
      }
    })
);

export const selectedSessionListQuerySchema = frozenExactData(
  z
    .object({
      limit: canonicalPageLimitTextSchema.optional(),
      cursor: selectedSessionListCursorSchema.optional()
    })
    .strict()
)
  .transform((value) => {
    const cursor = value.cursor === undefined ? null : decodeSelectedSessionListCursor(value.cursor);
    return selectedSessionListInputSchema.parse({
      limit: value.limit === undefined ? selectedSessionListDefaultPageSize : Number(value.limit),
      expected_order_snapshot: cursor?.order_snapshot ?? null,
      after: cursor?.after ?? null
    });
  });

const selectedSessionReadProjectionSchema = frozenExactData(managedSessionProjectionSchema);

export const selectedSessionEventWindowSchema = frozenExactData(
  z
    .object({
      state: z.enum(["empty", "contiguous", "bounded"]),
      retained_event_count: nonNegativeSafeIntegerSchema.max(1_000_000),
      earliest_retained_cursor: outputCursorSchema.nullable(),
      boundary_cursor: outputCursorSchema.nullable()
    })
    .strict()
    .superRefine((value, context) => {
      const empty =
        value.retained_event_count === 0 &&
        value.earliest_retained_cursor === null &&
        value.boundary_cursor === null;
      const contiguous =
        value.retained_event_count > 0 &&
        value.earliest_retained_cursor !== null &&
        value.boundary_cursor === null;
      const bounded =
        value.retained_event_count > 0 &&
        value.earliest_retained_cursor !== null &&
        value.boundary_cursor !== null &&
        value.boundary_cursor + 1 === value.earliest_retained_cursor;
      const valid =
        (value.state === "empty" && empty) ||
        (value.state === "contiguous" && contiguous) ||
        (value.state === "bounded" && bounded);
      if (!valid) {
        context.addIssue({
          code: "custom",
          message: "Selected session event-window state contradicts its retained cursor layout."
        });
      }
    })
);

export const selectedSessionReadItemSchema = frozenExactData(
  z
    .object({
      session: selectedSessionReadProjectionSchema,
      event_window: selectedSessionEventWindowSchema
    })
    .strict()
    .superRefine((value, context) => {
      const session = value.session;
      const window = value.event_window;
      if (session.cwd.length > selectedSessionReadMaximumCwdLength) {
        context.addIssue({
          code: "custom",
          message: "Selected session public cwd exceeds the read-contract limit.",
          path: ["session", "cwd"]
        });
      }
      if (window.retained_event_count === 0) {
        if (session.last_event_cursor !== null) {
          context.addIssue({
            code: "custom",
            message: "An empty selected session event window cannot retain a last cursor.",
            path: ["session", "last_event_cursor"]
          });
        }
        return;
      }
      const earliest = window.earliest_retained_cursor;
      const latest = session.last_event_cursor;
      if (
        earliest === null ||
        latest === null ||
        earliest > latest ||
        window.retained_event_count !== latest - earliest + 1
      ) {
        context.addIssue({
          code: "custom",
          message: "Selected session event-window count and projection cursor disagree.",
          path: ["event_window"]
        });
      }
    })
);

export const selectedSessionReadAccessSchema = frozenExactData(
  z
    .object({
      mode: z.enum(selectedHostAccessModes),
      network_mode: z.enum(selectedRequestNetworkModes),
      transport: z.enum(["http", "https"])
    })
    .strict()
    .superRefine((value, context) => {
      if (value.mode === "loopback_read" && value.network_mode !== "loopback") {
        context.addIssue({
          code: "custom",
          message: "Loopback-read session access requires loopback network mode."
        });
      }
      if (
        ["lan", "remote"].includes(value.network_mode) &&
        (value.transport !== "https" || !["paired_read", "paired_write"].includes(value.mode))
      ) {
        context.addIssue({
          code: "custom",
          message: "Non-loopback session access requires paired HTTPS authority."
        });
      }
      if (value.mode === "local_admin" && value.network_mode === "remote") {
        context.addIssue({
          code: "custom",
          message: "Remote session reads cannot acquire local-admin authority."
        });
      }
    })
);

const selectedSessionReadItemsSchema = frozenExactData(
  z.array(selectedSessionReadItemSchema).max(selectedSessionListMaxPageSize)
);

export const selectedSessionListPageSchema = frozenExactData(
  z
    .object({
      sessions: selectedSessionReadItemsSchema,
      order_snapshot: selectedSessionListOrderSnapshotSchema,
      next_after: selectedSessionListSortKeySchema.nullable(),
      has_more: z.boolean()
    })
    .strict()
    .superRefine((value, context) => {
      validateSelectedSessionList(value.sessions, context);
      const final = value.sessions.at(-1);
      const finalKey = final === undefined ? null : selectedSessionListSortKey(final.session);
      if (value.has_more !== (value.next_after !== null)) {
        context.addIssue({
          code: "custom",
          message: "Selected session-list page continuation and has-more state must agree."
        });
      }
      if (value.next_after !== null && (finalKey === null || compareSelectedSessionListSortKeys(value.next_after, finalKey) !== 0)) {
        context.addIssue({
          code: "custom",
          message: "Selected session-list page continuation must identify its final row.",
          path: ["next_after"]
        });
      }
    })
);

export const selectedSessionListResponseSchema = frozenExactData(
  z
    .object({
      access: selectedSessionReadAccessSchema,
      sessions: selectedSessionReadItemsSchema,
      next_cursor: selectedSessionListCursorSchema.nullable(),
      has_more: z.boolean()
    })
    .strict()
    .superRefine((value, context) => {
      validateSelectedSessionList(value.sessions, context);
      if (value.has_more !== (value.next_cursor !== null)) {
        context.addIssue({
          code: "custom",
          message: "Selected session-list response continuation and has-more state must agree."
        });
      }
      if (value.next_cursor !== null) {
        const final = value.sessions.at(-1);
        const decoded = decodeCursorForRefinement(value.next_cursor);
        if (
          final === undefined ||
          decoded === null ||
          compareSelectedSessionListSortKeys(decoded.after, selectedSessionListSortKey(final.session)) !== 0
        ) {
          context.addIssue({
            code: "custom",
            message: "Selected session-list response cursor must identify its final row.",
            path: ["next_cursor"]
          });
        }
      }
    })
);

export const selectedSessionDetailResponseSchema = frozenExactData(
  z
    .object({
      access: selectedSessionReadAccessSchema,
      session: selectedSessionReadItemSchema
    })
    .strict()
    .superRefine((value, context) => {
      if (isArchived(value.session)) {
        context.addIssue({
          code: "custom",
          message: "Archived sessions cannot parse as selected session-detail success.",
          path: ["session"]
        });
      }
    })
);

export type SelectedSessionListSortKey = z.infer<typeof selectedSessionListSortKeySchema>;
export type SelectedSessionListOrderEntry = z.infer<typeof selectedSessionListOrderEntrySchema>;
export type SelectedSessionListCursorValue = z.infer<typeof selectedSessionListCursorValueSchema>;
export type SelectedSessionListInput = z.infer<typeof selectedSessionListInputSchema>;
export type SelectedSessionEventWindow = z.infer<typeof selectedSessionEventWindowSchema>;
export type SelectedSessionReadItem = z.infer<typeof selectedSessionReadItemSchema>;
export type SelectedSessionReadAccess = z.infer<typeof selectedSessionReadAccessSchema>;
export type SelectedSessionListPage = z.infer<typeof selectedSessionListPageSchema>;
export type SelectedSessionListResponse = z.infer<typeof selectedSessionListResponseSchema>;
export type SelectedSessionDetailResponse = z.infer<typeof selectedSessionDetailResponseSchema>;

export function selectedSessionListSortKey(
  session: SelectedSessionListOrderEntry
): SelectedSessionListSortKey {
  return Object.freeze(
    selectedSessionListSortKeySchema.parse({
      attention_rank: mobileAttentionPriority(session.attention),
      last_activity_at: session.last_activity_at,
      session_id: session.id
    })
  );
}

export function compareSelectedSessionListSortKeys(
  left: SelectedSessionListSortKey,
  right: SelectedSessionListSortKey
): number {
  if (left.attention_rank !== right.attention_rank) return right.attention_rank - left.attention_rank;
  if (left.last_activity_at === null && right.last_activity_at !== null) return 1;
  if (left.last_activity_at !== null && right.last_activity_at === null) return -1;
  if (left.last_activity_at !== right.last_activity_at) {
    return (left.last_activity_at ?? "") > (right.last_activity_at ?? "") ? -1 : 1;
  }
  if (left.session_id === right.session_id) return 0;
  return left.session_id < right.session_id ? -1 : 1;
}

export function compareSelectedSessionListOrder(
  left: SelectedSessionListOrderEntry,
  right: SelectedSessionListOrderEntry
): number {
  return compareSelectedSessionListSortKeys(selectedSessionListSortKey(left), selectedSessionListSortKey(right));
}

export function encodeSelectedSessionListCursor(value: SelectedSessionListCursorValue): string {
  const parsed = selectedSessionListCursorValueSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Selected session-list cursor value is invalid.");
  const key = parsed.data.after;
  const activity = key.last_activity_at === null ? "-" : encodeBase64UrlAscii(key.last_activity_at);
  const encoded = `${selectedSessionListCursorVersion}.${parsed.data.order_snapshot}.${key.attention_rank}.${activity}.${encodeBase64UrlAscii(key.session_id)}`;
  if (encoded.length > selectedSessionListCursorMaxLength) {
    throw new TypeError("Selected session-list cursor is too long.");
  }
  return encoded;
}

export function decodeSelectedSessionListCursor(cursor: string): SelectedSessionListCursorValue {
  if (typeof cursor !== "string" || cursor.length < 87 || cursor.length > selectedSessionListCursorMaxLength) {
    throw new TypeError("Selected session-list cursor is invalid.");
  }
  const parts = cursor.split(".");
  if (parts.length !== 5 || parts[0] !== selectedSessionListCursorVersion) {
    throw new TypeError("Selected session-list cursor is invalid.");
  }
  const [, snapshot, rankText, activityText, sessionText] = parts;
  const rank = Number(rankText);
  if (
    snapshot === undefined ||
    rankText === undefined ||
    activityText === undefined ||
    sessionText === undefined ||
    !selectedSessionListAttentionRanks.includes(rank as (typeof selectedSessionListAttentionRanks)[number])
  ) {
    throw new TypeError("Selected session-list cursor is invalid.");
  }
  const parsed = selectedSessionListCursorValueSchema.safeParse({
    order_snapshot: snapshot,
    after: {
      attention_rank: rank,
      last_activity_at: activityText === "-" ? null : decodeBase64UrlAscii(activityText),
      session_id: decodeBase64UrlAscii(sessionText)
    }
  });
  if (!parsed.success || encodeSelectedSessionListCursor(parsed.data) !== cursor) {
    throw new TypeError("Selected session-list cursor is invalid.");
  }
  return deepFreeze(parsed.data);
}

function validateSelectedSessionList(
  sessions: readonly SelectedSessionReadItem[],
  context: z.RefinementCtx
): void {
  const ids = new Set<string>();
  for (const [index, item] of sessions.entries()) {
    if (isArchived(item)) {
      context.addIssue({
        code: "custom",
        message: "Selected session-list success cannot contain archived sessions.",
        path: ["sessions", index]
      });
    }
    if (ids.has(item.session.id)) {
      context.addIssue({
        code: "custom",
        message: "Selected session lists cannot contain duplicate managed identities.",
        path: ["sessions", index, "session", "id"]
      });
    }
    ids.add(item.session.id);
    const previous = sessions[index - 1];
    if (previous !== undefined && compareSelectedSessionListOrder(previous.session, item.session) >= 0) {
      context.addIssue({
        code: "custom",
        message: "Selected session lists must use strict attention, activity, and id order.",
        path: ["sessions", index]
      });
    }
  }
}

function isArchived(item: SelectedSessionReadItem): boolean {
  return item.session.archived_at !== null || item.session.session_state === "archived";
}

function encodeBase64UrlAscii(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value.charCodeAt(index);
    const second = index + 1 < value.length ? value.charCodeAt(index + 1) : null;
    const third = index + 2 < value.length ? value.charCodeAt(index + 2) : null;
    if (first > 0x7f || (second !== null && second > 0x7f) || (third !== null && third > 0x7f)) {
      throw new TypeError("Selected session-list cursor text must be ASCII.");
    }
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== null) encoded += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third !== null) encoded += alphabet[third & 0x3f];
  }
  return encoded;
}

function decodeBase64UrlAscii(payload: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  if (payload.length % 4 === 1) throw new TypeError("Selected session-list cursor is invalid.");
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];
  for (const character of payload) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new TypeError("Selected session-list cursor is invalid.");
    bits = (bits << 6) | value;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >> bitCount) & 0xff);
      bits &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
    }
  }
  if (bitCount !== 0 && bits !== 0) throw new TypeError("Selected session-list cursor is invalid.");
  if (bytes.length < 1 || bytes.some((value) => value > 0x7f)) {
    throw new TypeError("Selected session-list cursor is invalid.");
  }
  return String.fromCharCode(...bytes);
}

function decodeCursorForRefinement(cursor: string): SelectedSessionListCursorValue | null {
  try {
    return decodeSelectedSessionListCursor(cursor);
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function frozenExactData<const Schema extends z.ZodType>(schema: Schema) {
  return exactDataTree(schema).transform((value) => deepFreeze(value));
}
