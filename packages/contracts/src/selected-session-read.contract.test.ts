import type { AttentionLevel } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  compareSelectedSessionListOrder,
  decodeSelectedSessionListCursor,
  encodeSelectedSessionListCursor,
  selectedSessionDetailResponseSchema,
  selectedSessionEventWindowSchema,
  selectedSessionListCursorMaxLength,
  selectedSessionListCursorSchema,
  selectedSessionListCursorValueSchema,
  selectedSessionListDefaultPageSize,
  selectedSessionListInputSchema,
  selectedSessionListMaximumActiveSessions,
  selectedSessionListMaxPageSize,
  selectedSessionListPageSchema,
  selectedSessionListQuerySchema,
  selectedSessionListResponseSchema,
  selectedSessionListSortKey,
  selectedSessionReadAccessSchema,
  selectedSessionReadItemSchema,
  selectedSessionReadMaximumCwdLength
} from "./selected-session-read.js";

const timestamp = "2026-07-16T12:00:00.000Z";
const laterTimestamp = "2026-07-16T12:01:00.000Z";
const snapshot = "a".repeat(64);

interface ProjectionOptions {
  readonly archived?: boolean;
  readonly attention?: AttentionLevel;
  readonly cwd?: string;
  readonly freshness?: "current" | "stale" | "disconnected" | "incompatible";
  readonly id?: string;
  readonly lastActivityAt?: string | null;
  readonly lastEventCursor?: number | null;
  readonly sessionState?: "starting" | "active" | "archived" | "stale" | "incompatible" | "unknown";
}

interface ItemOptions extends ProjectionOptions {
  readonly boundaryCursor?: number | null;
  readonly earliestRetainedCursor?: number | null;
  readonly retainedEventCount?: number;
  readonly windowState?: "empty" | "contiguous" | "bounded";
}

describe("selected session-read contracts", () => {
  it("publishes the frozen pagination and public-cwd limits", () => {
    expect(selectedSessionListDefaultPageSize).toBe(50);
    expect(selectedSessionListMaxPageSize).toBe(100);
    expect(selectedSessionListMaximumActiveSessions).toBe(4_096);
    expect(selectedSessionReadMaximumCwdLength).toBe(4_096);
    expect(selectedSessionListCursorMaxLength).toBe(196);
  });

  it("parses exact canonical list queries into detached frozen repository input", () => {
    const defaults = selectedSessionListQuerySchema.parse({});
    expect(defaults).toEqual({
      after: null,
      expected_order_snapshot: null,
      limit: selectedSessionListDefaultPageSize
    });

    const cursor = encodeSelectedSessionListCursor(
      cursorValue(50, timestamp, "sess_query_01")
    );
    const input = { cursor, limit: "100" };
    const parsed = selectedSessionListQuerySchema.parse(input);
    expect(parsed).toEqual({
      after: {
        attention_rank: 50,
        last_activity_at: timestamp,
        session_id: "sess_query_01"
      },
      expected_order_snapshot: snapshot,
      limit: 100
    });
    expect(parsed).not.toBe(input);
    expectFrozenTree(parsed);
  });

  it("rejects repeated, unknown, noncanonical, and contradictory list input", () => {
    for (const limit of ["", "0", "00", "01", "+1", "1.0", " 1", "101", "1000", 1, ["1", "2"]]) {
      expect(selectedSessionListQuerySchema.safeParse({ limit }).success, String(limit)).toBe(false);
    }
    expect(selectedSessionListQuerySchema.safeParse({ extra: "1" }).success).toBe(false);
    expect(
      selectedSessionListInputSchema.safeParse({
        after: null,
        expected_order_snapshot: snapshot,
        limit: 10
      }).success
    ).toBe(false);
    expect(
      selectedSessionListInputSchema.safeParse({
        after: { attention_rank: 0, last_activity_at: null, session_id: "sess_input_01" },
        expected_order_snapshot: null,
        limit: 10
      }).success
    ).toBe(false);
  });

  it("round-trips every cursor rank and canonicalizes timestamp offsets", () => {
    for (const attentionRank of [0, 20, 30, 40, 50, 60] as const) {
      for (const lastActivityAt of [null, timestamp, "2026-07-16T17:30:00.000+05:30"] as const) {
        const cursor = encodeSelectedSessionListCursor(
          cursorValue(attentionRank, lastActivityAt, "sess_cursor_01")
        );
        expect(selectedSessionListCursorSchema.parse(cursor)).toBe(cursor);
        const decoded = decodeSelectedSessionListCursor(cursor);
        expect(decoded.after.last_activity_at).toBe(lastActivityAt === null ? null : timestamp);
        expect(encodeSelectedSessionListCursor(decoded)).toBe(cursor);
        expectFrozenTree(decoded);
      }
    }

    const shortest = encodeSelectedSessionListCursor(cursorValue(0, null, "sess_123456"));
    const longest = encodeSelectedSessionListCursor(
      cursorValue(60, timestamp, `sess_${"a".repeat(64)}`)
    );
    expect(shortest).toHaveLength(87);
    expect(longest).toHaveLength(selectedSessionListCursorMaxLength);
  });

  it("rejects malformed, noncanonical, oversized, and tampered cursors", () => {
    const cursor = encodeSelectedSessionListCursor(
      cursorValue(60, timestamp, "sess_cursor_02")
    );
    const candidates = [
      "",
      cursor.replace(/^v1/u, "v2"),
      cursor.replace(snapshot, snapshot.toUpperCase()),
      cursor.replace(".60.", ".06."),
      cursor.replace(".60.", ".10."),
      `${cursor}=`,
      `${cursor}.extra`,
      `v1.${snapshot}.0.-.${"A".repeat(93)}`,
      cursor.slice(0, -1),
      cursor.replace(/.$/u, "*")
    ];
    for (const candidate of candidates) {
      expect(selectedSessionListCursorSchema.safeParse(candidate).success, candidate).toBe(false);
      expect(() => decodeSelectedSessionListCursor(candidate)).toThrow(TypeError);
    }
  });

  it("accepts only coherent empty, contiguous, and bounded event windows", () => {
    const windows = [
      {
        boundary_cursor: null,
        earliest_retained_cursor: null,
        retained_event_count: 0,
        state: "empty"
      },
      {
        boundary_cursor: null,
        earliest_retained_cursor: 0,
        retained_event_count: 3,
        state: "contiguous"
      },
      {
        boundary_cursor: 4,
        earliest_retained_cursor: 5,
        retained_event_count: 3,
        state: "bounded"
      }
    ] as const;
    for (const window of windows) {
      expect(selectedSessionEventWindowSchema.parse(window)).toEqual(window);
    }

    for (const window of [
      { ...windows[0], retained_event_count: 1 },
      { ...windows[1], boundary_cursor: 0 },
      { ...windows[2], boundary_cursor: 3 },
      { ...windows[2], earliest_retained_cursor: null },
      { ...windows[2], state: "contiguous" }
    ]) {
      expect(selectedSessionEventWindowSchema.safeParse(window).success).toBe(false);
    }
  });

  it("binds retained window metadata exactly to the projection last cursor", () => {
    expect(selectedSessionReadItemSchema.parse(readItem())).toBeTruthy();
    expect(
      selectedSessionReadItemSchema.parse(
        readItem({ earliestRetainedCursor: 0, lastEventCursor: 2, retainedEventCount: 3, windowState: "contiguous" })
      )
    ).toBeTruthy();
    expect(
      selectedSessionReadItemSchema.parse(
        readItem({
          boundaryCursor: 4,
          earliestRetainedCursor: 5,
          lastEventCursor: 7,
          retainedEventCount: 3,
          windowState: "bounded"
        })
      )
    ).toBeTruthy();

    for (const item of [
      readItem({ lastEventCursor: 0 }),
      readItem({ earliestRetainedCursor: 2, lastEventCursor: 1, retainedEventCount: 1, windowState: "contiguous" }),
      readItem({ earliestRetainedCursor: 1, lastEventCursor: 3, retainedEventCount: 2, windowState: "contiguous" }),
      readItem({ boundaryCursor: 1, earliestRetainedCursor: 3, lastEventCursor: 3, retainedEventCount: 1, windowState: "bounded" })
    ]) {
      expect(selectedSessionReadItemSchema.safeParse(item).success).toBe(false);
    }
  });

  it("enforces the public cwd limit and archive success policy", () => {
    const maximumCwd = `/${"a".repeat(selectedSessionReadMaximumCwdLength - 1)}`;
    expect(selectedSessionReadItemSchema.parse(readItem({ cwd: maximumCwd }))).toBeTruthy();
    expect(selectedSessionReadItemSchema.safeParse(readItem({ cwd: `${maximumCwd}a` })).success).toBe(false);

    const archived = readItem({ archived: true });
    expect(selectedSessionReadItemSchema.parse(archived)).toBeTruthy();
    expect(
      selectedSessionDetailResponseSchema.safeParse({ access: localAccess(), session: archived }).success
    ).toBe(false);
    expect(
      selectedSessionListPageSchema.safeParse({
        has_more: false,
        next_after: null,
        order_snapshot: snapshot,
        sessions: [archived]
      }).success
    ).toBe(false);
  });

  it("uses one strict attention, activity, null, and id order", () => {
    const sessions = [
      readItem({ attention: "needs_approval", id: "sess_order_01" }),
      readItem({ attention: "needs_input", id: "sess_order_02" }),
      readItem({ attention: "failed", id: "sess_order_03" }),
      readItem({ attention: "stuck", id: "sess_order_04", lastActivityAt: laterTimestamp }),
      readItem({ attention: "unknown", id: "sess_order_05", lastActivityAt: laterTimestamp }),
      readItem({ attention: "unknown", id: "sess_order_06", lastActivityAt: null }),
      readItem({ attention: "watch", id: "sess_order_07" }),
      readItem({ attention: "none", id: "sess_order_08" })
    ].map((item) => selectedSessionReadItemSchema.parse(item));
    expect(sessions.map((item) => selectedSessionListSortKey(item.session).attention_rank)).toEqual([
      60, 50, 40, 30, 30, 30, 20, 0
    ]);
    for (let index = 1; index < sessions.length; index += 1) {
      const previous = requiredAt(sessions, index - 1);
      const current = requiredAt(sessions, index);
      expect(compareSelectedSessionListOrder(previous.session, current.session)).toBeLessThan(0);
    }
    expect(
      selectedSessionListPageSchema.parse({
        has_more: false,
        next_after: null,
        order_snapshot: snapshot,
        sessions
      }).sessions
    ).toHaveLength(sessions.length);

    const swapped = [...sessions];
    const firstTie = requiredAt(swapped, 3);
    const secondTie = requiredAt(swapped, 4);
    swapped[3] = secondTie;
    swapped[4] = firstTie;
    expect(
      selectedSessionListPageSchema.safeParse({
        has_more: false,
        next_after: null,
        order_snapshot: snapshot,
        sessions: swapped
      }).success
    ).toBe(false);
    expect(
      selectedSessionListPageSchema.safeParse({
        has_more: false,
        next_after: null,
        order_snapshot: snapshot,
        sessions: [sessions[0], sessions[0]]
      }).success
    ).toBe(false);
  });

  it("requires continuation metadata to identify the final returned row", () => {
    const sessions = [
      readItem({ attention: "needs_input", id: "sess_page_01" }),
      readItem({ attention: "watch", id: "sess_page_02" })
    ].map((item) => selectedSessionReadItemSchema.parse(item));
    const firstSession = requiredAt(sessions, 0);
    const finalSession = requiredAt(sessions, 1);
    const nextAfter = selectedSessionListSortKey(finalSession.session);
    const page = selectedSessionListPageSchema.parse({
      has_more: true,
      next_after: nextAfter,
      order_snapshot: snapshot,
      sessions
    });
    const nextCursor = encodeSelectedSessionListCursor(
      selectedSessionListCursorValueSchema.parse({ after: nextAfter, order_snapshot: page.order_snapshot })
    );
    expect(
      selectedSessionListResponseSchema.parse({
        access: localAccess(),
        has_more: true,
        next_cursor: nextCursor,
        sessions
      }).next_cursor
    ).toBe(nextCursor);

    for (const candidate of [
      { has_more: true, next_after: null, order_snapshot: snapshot, sessions },
      { has_more: false, next_after: nextAfter, order_snapshot: snapshot, sessions },
      {
        has_more: true,
        next_after: selectedSessionListSortKey(firstSession.session),
        order_snapshot: snapshot,
        sessions
      }
    ]) {
      expect(selectedSessionListPageSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      selectedSessionListResponseSchema.safeParse({
        access: localAccess(),
        has_more: true,
        next_cursor: encodeSelectedSessionListCursor(
          selectedSessionListCursorValueSchema.parse({
            after: selectedSessionListSortKey(firstSession.session),
            order_snapshot: snapshot
          })
        ),
        sessions
      }).success
    ).toBe(false);
  });

  it("accepts only coherent request-access projections", () => {
    for (const access of [
      localAccess(),
      { mode: "local_admin", network_mode: "loopback", transport: "http" },
      { mode: "paired_read", network_mode: "loopback", transport: "http" },
      { mode: "paired_write", network_mode: "remote", transport: "https" },
      { mode: "paired_read", network_mode: "remote", transport: "https" }
    ]) {
      expect(selectedSessionReadAccessSchema.parse(access)).toEqual(access);
    }
    for (const access of [
      { mode: "loopback_read", network_mode: "lan", transport: "https" },
      { mode: "local_admin", network_mode: "lan", transport: "https" },
      { mode: "paired_read", network_mode: "remote", transport: "http" },
      { mode: "paired_write", network_mode: "lan", transport: "http" },
      { mode: "paired_write", network_mode: "loopback", transport: "https" },
      { mode: "paired_read", network_mode: "remote", transport: "https", device_id: "secret" }
    ]) {
      expect(selectedSessionReadAccessSchema.safeParse(access).success).toBe(false);
    }
  });

  it("rejects hostile object trees and arrays without invoking accessors", () => {
    let reads = 0;
    const getterItem = readItem();
    Object.defineProperty(getterItem.session.settings, "runtime_model", {
      enumerable: true,
      get() {
        reads += 1;
        return "gpt-5.5-codex";
      }
    });
    expect(selectedSessionReadItemSchema.safeParse(getterItem).success).toBe(false);
    expect(reads).toBe(0);

    const symbolItem = readItem();
    Object.defineProperty(symbolItem.session.goal, Symbol("private"), {
      enumerable: true,
      value: "secret"
    });
    expect(selectedSessionReadItemSchema.safeParse(symbolItem).success).toBe(false);

    const classItem = Object.assign(new (class SessionItem {})(), readItem());
    expect(selectedSessionReadItemSchema.safeParse(classItem).success).toBe(false);

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(
      selectedSessionListResponseSchema.safeParse({
        access: localAccess(),
        has_more: false,
        next_cursor: null,
        sessions: sparse
      }).success
    ).toBe(false);

    const forged = [readItem()];
    Object.setPrototypeOf(forged, null);
    expect(
      selectedSessionListResponseSchema.safeParse({
        access: localAccess(),
        has_more: false,
        next_cursor: null,
        sessions: forged
      }).success
    ).toBe(false);

    const proxy = new Proxy(readItem(), {
      ownKeys() {
        throw new Error("hostile proxy");
      }
    });
    expect(selectedSessionReadItemSchema.safeParse(proxy).success).toBe(false);
  });

  it("returns detached recursively frozen output with no adjacent private surfaces", () => {
    const input = {
      access: localAccess(),
      has_more: false,
      next_cursor: null,
      sessions: [readItem({ id: "sess_frozen_01" })]
    };
    const parsed = selectedSessionListResponseSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.sessions).not.toBe(input.sessions);
    const parsedItem = requiredAt(parsed.sessions, 0);
    const inputItem = requiredAt(input.sessions, 0);
    expect(parsedItem.session).not.toBe(inputItem.session);
    expectFrozenTree(parsed);

    inputItem.session.settings.runtime_model = "changed-after-parse";
    expect(parsedItem.session.settings?.runtime_model).toBe("gpt-5.5-codex");

    for (const privateField of [
      "events",
      "pending_approvals",
      "device_id",
      "cookie",
      "csrf_token",
      "write_eligibility",
      "source_key",
      "ingress_generation"
    ]) {
      expect(
        selectedSessionListResponseSchema.safeParse({ ...input, [privateField]: "private" }).success,
        privateField
      ).toBe(false);
    }
  });
});

function projection(options: ProjectionOptions = {}) {
  const archived = options.archived ?? false;
  const freshness = options.freshness ?? "current";
  const id = options.id ?? "sess_read_01";
  return {
    archived_at: archived ? laterTimestamp : null,
    attention: options.attention ?? "none",
    branch: "main",
    codex_thread_id: `thread-${id}`,
    created_at: timestamp,
    cwd: options.cwd ?? "/workspace/hostdeck",
    freshness,
    freshness_reason: freshness === "current" ? null : `Projection is ${freshness}.`,
    goal: {
      objective: "Complete the current HostDeck task.",
      state: "active"
    },
    id,
    last_activity_at: options.lastActivityAt === undefined ? timestamp : options.lastActivityAt,
    last_event_cursor: options.lastEventCursor ?? null,
    model: "gpt-5.5-codex",
    name: id.slice(5),
    recent_summary: "A bounded public summary.",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    session_state: options.sessionState ?? (archived ? "archived" : "active"),
    settings: {
      collaboration_mode: "default",
      observed_at: timestamp,
      reasoning_effort: "high",
      runtime_model: "gpt-5.5-codex"
    },
    turn_state: "idle",
    updated_at: laterTimestamp
  };
}

function readItem(options: ItemOptions = {}) {
  return {
    event_window: {
      boundary_cursor: options.boundaryCursor ?? null,
      earliest_retained_cursor: options.earliestRetainedCursor ?? null,
      retained_event_count: options.retainedEventCount ?? 0,
      state: options.windowState ?? "empty"
    },
    session: projection(options)
  };
}

function localAccess() {
  return {
    mode: "loopback_read",
    network_mode: "loopback",
    transport: "http"
  } as const;
}

function cursorValue(
  attentionRank: 0 | 20 | 30 | 40 | 50 | 60,
  lastActivityAt: string | null,
  sessionId: string
) {
  return selectedSessionListCursorValueSchema.parse({
    after: {
      attention_rank: attentionRank,
      last_activity_at: lastActivityAt,
      session_id: sessionId
    },
    order_snapshot: snapshot
  });
}

function expectFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectFrozenTree(child);
}

function requiredAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing test value at index ${index}.`);
  return value;
}
