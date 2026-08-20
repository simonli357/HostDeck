import {
  compareSelectedSessionListOrder,
  type SessionCatalogEvent,
  sessionCatalogEventSchema,
  sharedSessionCatalogEntrySchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  createBrowserSessionCatalogReducerState,
  reduceBrowserSessionCatalogEvent
} from "./session-catalog-state.js";

const streamA = "catalog_reducer_stream_a";
const streamB = "catalog_reducer_stream_b";
const timestamp = "2026-08-15T12:00:00.000Z";

describe("browser session catalog reducer", () => {
  it("commits a complete sorted bootstrap atomically", () => {
    let state = createBrowserSessionCatalogReducerState();
    state = apply(state, reset(100, 2));
    state = apply(state, upsert(101, sessionEntry("b")));
    state = apply(state, upsert(102, sessionEntry("a", { attention: "watch" })));

    expect(state).toMatchObject({ phase: "resetting", data: null });
    expect(state.reset?.sessions).toHaveLength(2);
    state = apply(state, ready(103, 2));

    expect(state).toMatchObject({
      phase: "current",
      reset: null,
      boundary: null,
      data: { streamId: streamA, cursor: 103, endpointGeneration: 4 }
    });
    expect(state.data?.sessions.map((item) => item.session.id)).toEqual([
      "sess_catalog_a",
      "sess_catalog_b"
    ]);
    const [first, second] = requireData(state).sessions;
    if (first === undefined || second === undefined) {
      throw new Error("Expected two sorted catalog sessions.");
    }
    expect(compareSelectedSessionListOrder(first.session, second.session)).toBeLessThan(0);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.data)).toBe(true);
    expect(Object.isFrozen(state.data?.sessions)).toBe(true);
    expect(Object.isFrozen(state.data?.sessions[0]?.session)).toBe(true);
  });

  it("retains the committed catalog until a replacement reset is complete", () => {
    let state = bootstrap();
    const committed = state.data;

    state = apply(state, reset(200, 1, streamB));
    state = apply(state, upsert(201, sessionEntry("b"), streamB));
    expect(state.phase).toBe("resetting");
    expect(state.data).toBe(committed);

    state = apply(state, ready(202, 1, streamB));
    expect(state.data).not.toBe(committed);
    expect(state.data).toMatchObject({ streamId: streamB, cursor: 202 });
    expect(state.data?.sessions.map((item) => item.session.id)).toEqual([
      "sess_catalog_b"
    ]);
  });

  it("applies live upserts and exact removals without losing stable identities", () => {
    let state = bootstrap();
    state = apply(
      state,
      upsert(
        103,
        sessionEntry("a", {
          attention: "watch",
          summary: "Updated live summary.",
          updatedAt: "2026-08-15T12:01:00.000Z"
        })
      )
    );
    expect(state.data?.sessions).toHaveLength(1);
    expect(state.data?.sessions[0]?.session.recent_summary).toBe(
      "Updated live summary."
    );

    state = apply(state, remove(104, "a"));
    expect(state).toMatchObject({
      phase: "current",
      data: { cursor: 104, sessions: [] }
    });
  });

  it("makes a boundary explicit, retains committed data, and accepts only a new reset", () => {
    let state = bootstrap();
    const committed = state.data;
    state = apply(state, boundary(103));
    expect(state).toMatchObject({
      phase: "boundary",
      data: committed,
      reset: null,
      boundary: { cursor: 103, reason: "lag" }
    });
    expect(() => apply(state, ready(104, 1))).toThrow(
      "session catalog event is invalid"
    );

    state = apply(state, reset(300, 0, streamB));
    state = apply(state, ready(301, 0, streamB));
    expect(state).toMatchObject({
      phase: "current",
      boundary: null,
      data: { streamId: streamB, sessions: [] }
    });
  });

  it("rejects incomplete bootstrap, duplicate identity, stream drift, and stale time", () => {
    const idle = createBrowserSessionCatalogReducerState();
    expect(() => apply(idle, upsert(1, sessionEntry("a")))).toThrow(TypeError);

    let duplicate = apply(idle, reset(1, 2));
    duplicate = apply(duplicate, upsert(2, sessionEntry("a")));
    expect(() => apply(duplicate, upsert(3, sessionEntry("a")))).toThrow(TypeError);

    const count = apply(idle, reset(1, 1));
    expect(() => apply(count, ready(2, 0))).toThrow(TypeError);

    const drift = apply(idle, reset(1, 0));
    expect(() => apply(drift, ready(2, 0, streamB))).toThrow(TypeError);

    const stale = bootstrap();
    expect(() =>
      apply(
        stale,
        upsert(
          103,
          sessionEntry("a"),
          streamA,
          "2026-08-15T11:59:59.000Z"
        )
      )
    ).toThrow(TypeError);
  });
});

function bootstrap() {
  let state = createBrowserSessionCatalogReducerState();
  state = apply(state, reset(100, 1));
  state = apply(state, upsert(101, sessionEntry("a")));
  return apply(state, ready(102, 1));
}

function apply(
  state: ReturnType<typeof createBrowserSessionCatalogReducerState>,
  event: SessionCatalogEvent
) {
  return reduceBrowserSessionCatalogEvent(state, event);
}

function reset(
  cursor: number,
  expected: number,
  streamId = streamA
): SessionCatalogEvent {
  return event({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "catalog_reset",
    reason: "initial",
    expected_session_count: expected
  });
}

function upsert(
  cursor: number,
  session: ReturnType<typeof sessionEntry>,
  streamId = streamA,
  emittedAt = timestamp
): SessionCatalogEvent {
  return event({
    stream_id: streamId,
    cursor,
    emitted_at: emittedAt,
    type: "session_upsert",
    session
  });
}

function ready(
  cursor: number,
  count: number,
  streamId = streamA
): SessionCatalogEvent {
  return event({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "catalog_ready",
    session_count: count,
    endpoint_generation: 4
  });
}

function remove(cursor: number, suffix: string): SessionCatalogEvent {
  return event({
    stream_id: streamA,
    cursor,
    emitted_at: timestamp,
    type: "session_remove",
    native_thread_id: nativeId(suffix),
    internal_session_id: `sess_catalog_${suffix}`,
    reason: "archived"
  });
}

function boundary(cursor: number): SessionCatalogEvent {
  return event({
    stream_id: streamA,
    cursor,
    emitted_at: timestamp,
    type: "catalog_boundary",
    reason: "lag",
    reset_required: true,
    detail: "Catalog receiver must reconnect."
  });
}

function event(candidate: unknown): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse(candidate);
}

function sessionEntry(
  suffix: string,
  options: {
    readonly attention?: "none" | "watch";
    readonly summary?: string;
    readonly updatedAt?: string;
  } = {}
) {
  const id = `sess_catalog_${suffix}`;
  const native = nativeId(suffix);
  const updatedAt = options.updatedAt ?? timestamp;
  return sharedSessionCatalogEntrySchema.parse({
    tracked: {
      native_thread_id: native,
      internal_session_id: id,
      alias: `catalog-${suffix}`,
      cwd: `/workspace/catalog-${suffix}`,
      project_cue: `catalog-${suffix}`,
      branch: "main",
      runtime_version: "0.148.0",
      runtime_source: "codex_app_server",
      enrollment_origin: "loaded_before",
      archived: false,
      created_at: timestamp,
      updated_at: updatedAt,
      archived_at: null
    },
    projection: {
      id,
      name: `catalog-${suffix}`,
      codex_thread_id: native,
      cwd: `/workspace/catalog-${suffix}`,
      runtime_source: "codex_app_server",
      runtime_version: "0.148.0",
      created_at: timestamp,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: options.attention ?? "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: updatedAt,
      last_activity_at: updatedAt,
      branch: "main",
      model: "gpt-5.5-codex",
      settings: null,
      goal: null,
      recent_summary: options.summary ?? "Bounded reducer fixture.",
      last_event_cursor: null
    }
  });
}

function nativeId(suffix: string): string {
  return suffix === "a"
    ? "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4"
    : "019fc8c8-f71a-7080-9d4d-d5cdbe484587";
}

function requireData(
  state: ReturnType<typeof createBrowserSessionCatalogReducerState>
) {
  if (state.data === null) throw new Error("Expected catalog data.");
  return state.data;
}
