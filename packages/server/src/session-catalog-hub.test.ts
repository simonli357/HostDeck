import {
  defaultResourceBudget,
  resolveResourceBudget,
  type SessionCatalogEvent,
  type SharedSessionCatalogEntry,
  sharedSessionCatalogEntrySchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  createSessionCatalogHub,
  HostDeckSessionCatalogHubError,
  type SessionCatalogHub,
  type SessionCatalogHubErrorCode,
  type SessionCatalogStream
} from "./session-catalog-hub.js";
import type { SessionCatalogStateReader } from "./session-catalog-state-reader.js";
import { createSseSubscriberAdmissionService } from "./sse-subscriber-admission.js";

const timestamp = "2026-08-15T12:00:00.000Z";
const threadA = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4";
const sessionA = "sess_catalog_a";

describe("bounded live session catalog hub", () => {
  it("publishes a private bootstrap and post-snapshot upsert/remove changes in cursor order", async () => {
    const reader = createReader([catalogEntry()]);
    const hub = createHub(reader.reader);
    hub.initialize(7);
    const stream = open(hub, "catalog:first");
    const iterator = stream[Symbol.asyncIterator]();
    const bootstrap = await take(iterator, 3);

    expect(bootstrap.map((event) => event.type)).toEqual([
      "catalog_reset",
      "session_upsert",
      "catalog_ready"
    ]);
    expect(bootstrap[0]).toMatchObject({
      cursor: 101,
      expected_session_count: 1,
      reason: "initial",
      stream_id: "catalog_test_0001"
    });
    expect(bootstrap[2]).toMatchObject({
      cursor: 103,
      endpoint_generation: 7,
      session_count: 1
    });
    expect(JSON.stringify(bootstrap)).not.toContain("private prompt transcript");
    expect(JSON.stringify(bootstrap)).not.toContain('"messages"');
    expect(JSON.stringify(bootstrap)).not.toContain('"events"');

    reader.set(catalogEntry({ recentSummary: "Updated bounded summary." }));
    const liveUpsert = iterator.next();
    hub.synchronize(sessionA, "reconciled");
    expect(await liveUpsert).toMatchObject({
      done: false,
      value: {
        cursor: 104,
        type: "session_upsert",
        session: { projection: { recent_summary: "Updated bounded summary." } }
      }
    });

    reader.delete(sessionA);
    const liveRemove = iterator.next();
    hub.synchronize(sessionA, "archived");
    expect(await liveRemove).toMatchObject({
      done: false,
      value: {
        cursor: 105,
        type: "session_remove",
        internal_session_id: sessionA,
        native_thread_id: threadA,
        reason: "archived"
      }
    });
    expect(hub.snapshot()).toMatchObject({
      active_subscribers: 1,
      catalog_sessions: 0,
      failure_code: null,
      history_events: 5,
      state: "ready"
    });
    expect(stream.close()).toBe(true);
    expect(stream.close()).toBe(false);
  });

  it("hands replay into live publication without a cursor gap or duplicate", async () => {
    const reader = createReader([catalogEntry()]);
    const hub = createHub(reader.reader);
    hub.initialize(1);
    const original = open(hub, "catalog:original");
    const originalIterator = original[Symbol.asyncIterator]();
    const bootstrap = await take(originalIterator, 3);
    const readyCursor = requireEvent(bootstrap.at(-1)).cursor;

    reader.set(catalogEntry({ recentSummary: "Replay delta." }));
    hub.synchronize(sessionA, "reconciled");
    const originalDelta = requireValue(await originalIterator.next());

    const reconnect = open(hub, "catalog:reconnect", readyCursor);
    const reconnectIterator = reconnect[Symbol.asyncIterator]();
    const replayDelta = requireValue(await reconnectIterator.next());
    reader.set(
      catalogEntry({
        recentSummary: "Live delta.",
        updatedAt: "2026-08-15T12:01:00.000Z"
      })
    );
    hub.synchronize(sessionA, "reconciled");
    const liveDelta = requireValue(await reconnectIterator.next());

    expect(replayDelta).toEqual(originalDelta);
    expect(liveDelta.cursor).toBe(replayDelta.cursor + 1);
    expect([replayDelta.cursor, liveDelta.cursor]).toEqual([
      ...new Set([replayDelta.cursor, liveDelta.cursor])
    ]);
    expect(reconnect.replay_event_count).toBe(1);
    original.close();
    reconnect.close();
  });

  it("rotates stale cursors through an explicit boundary/reset and rejects future cursors", async () => {
    const reader = createReader([catalogEntry()]);
    const hub = createHub(reader.reader);
    hub.initialize(3);
    const existing = open(hub, "catalog:existing");
    const existingIterator = existing[Symbol.asyncIterator]();
    const initial = await take(existingIterator, 3);

    expectHubError(
      () => open(hub, "catalog:future", requireEvent(initial.at(-1)).cursor + 1_000),
      "future_cursor"
    );
    const stale = open(hub, "catalog:stale", 1);
    const staleIterator = stale[Symbol.asyncIterator]();
    const boundary = requireValue(await existingIterator.next());
    const reset = requireValue(await staleIterator.next());

    expect(boundary).toMatchObject({
      type: "catalog_boundary",
      reason: "lag",
      reset_required: true
    });
    expect((await existingIterator.next()).done).toBe(true);
    expect(reset).toMatchObject({ type: "catalog_reset", reason: "reconnect" });
    expect(reset.stream_id).not.toBe(initial[0]?.stream_id);
    stale.close();
  });

  it("closes a slow subscriber at one overflow boundary and rebuilds from current state", async () => {
    const budget = resolveResourceBudget({
      sse_queue_max_events: 8,
      sse_replay_max_events: 16
    });
    const reader = createReader();
    const hub = createHub(reader.reader, budget);
    hub.initialize(4);
    const slow = open(hub, "catalog:slow");

    for (let index = 0; index < 9; index += 1) {
      reader.set(
        catalogEntry({
          recentSummary: `Catalog update ${index}.`,
          updatedAt: `2026-08-15T12:00:${String(index).padStart(2, "0")}.000Z`
        })
      );
      hub.synchronize(sessionA, "reconciled");
    }

    const slowIterator = slow[Symbol.asyncIterator]();
    expect(requireValue(await slowIterator.next())).toMatchObject({
      type: "catalog_boundary",
      reason: "overflow",
      reset_required: true
    });
    expect((await slowIterator.next()).done).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      active_subscribers: 0,
      catalog_sessions: 1,
      overflow_boundaries: 1,
      state: "ready"
    });

    const rebuilt = open(hub, "catalog:rebuilt");
    const events = await take(rebuilt[Symbol.asyncIterator](), 3);
    expect(events).toMatchObject([
      { type: "catalog_reset", reason: "reconnect", expected_session_count: 1 },
      {
        type: "session_upsert",
        session: { projection: { recent_summary: "Catalog update 8." } }
      },
      { type: "catalog_ready", session_count: 1 }
    ]);
    rebuilt.close();
  });

  it("surfaces storage failure, closes subscribers with a boundary, and requires explicit reconcile", async () => {
    const reader = createReader();
    const hub = createHub(reader.reader);
    hub.initialize(5);
    const stream = open(hub, "catalog:storage");
    const iterator = stream[Symbol.asyncIterator]();
    await take(iterator, 2);
    const pendingBoundary = iterator.next();
    reader.readOneFailure = new Error("sqlite unavailable");

    expectHubError(
      () => hub.synchronize(sessionA, "missing"),
      "storage_unavailable"
    );
    expect(requireValue(await pendingBoundary)).toMatchObject({
      type: "catalog_boundary",
      reason: "storage",
      reset_required: true
    });
    expect((await iterator.next()).done).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      active_subscribers: 0,
      failure_code: "storage_unavailable",
      state: "failed",
      stream_id: null
    });
    expectHubError(() => open(hub, "catalog:failed"), "storage_unavailable");

    reader.readOneFailure = null;
    reader.set(catalogEntry());
    hub.reconcile(6);
    const recovered = open(hub, "catalog:recovered");
    expect(await take(recovered[Symbol.asyncIterator](), 3)).toMatchObject([
      { type: "catalog_reset", reason: "reconciliation" },
      { type: "session_upsert" },
      { type: "catalog_ready", endpoint_generation: 6 }
    ]);
    expect(hub.snapshot()).toMatchObject({ failure_code: null, state: "ready" });
    recovered.close();
  });

  it("turns malformed publication into a boundary and a recoverable failed state", async () => {
    const reader = createReader();
    const hub = createHub(reader.reader);
    hub.initialize(1);
    const stream = open(hub, "catalog:malformed");
    const iterator = stream[Symbol.asyncIterator]();
    await take(iterator, 2);
    reader.rawOne = Object.freeze({ private_transcript: "must not escape" });
    const pendingBoundary = iterator.next();

    expectHubError(
      () => hub.synchronize(sessionA, "reconciled"),
      "publication_failed"
    );
    expect(requireValue(await pendingBoundary)).toMatchObject({
      type: "catalog_boundary",
      reason: "unknown_required_event"
    });
    expect((await iterator.next()).done).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      failure_code: "publication_failed",
      state: "failed"
    });
    expectHubError(() => open(hub, "catalog:publication-failed"), "publication_failed");
  });

  it("fails at an explicit boundary when one valid catalog event exceeds its wire budget", async () => {
    const budget = resolveResourceBudget({ sse_event_max_bytes: 1_024 });
    const reader = createReader();
    const hub = createHub(reader.reader, budget);
    hub.initialize(1);
    const stream = open(hub, "catalog:wire-limit");
    const iterator = stream[Symbol.asyncIterator]();
    await take(iterator, 2);
    reader.set(catalogEntry({ cwd: `/home/${"a".repeat(850)}` }));
    const pendingBoundary = iterator.next();

    let thrown: unknown;
    try {
      hub.synchronize(sessionA, "reconciled");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostDeckSessionCatalogHubError);
    expect((thrown as HostDeckSessionCatalogHubError).code).toBe(
      "publication_failed"
    );
    expect((thrown as HostDeckSessionCatalogHubError).cause).toMatchObject({
      code: "event_too_large"
    });
    expect(requireValue(await pendingBoundary)).toMatchObject({
      type: "catalog_boundary",
      reason: "unknown_required_event"
    });
    expect((await iterator.next()).done).toBe(true);
  });

  it("rejects unauthorized, aborted, duplicate, and exhausted subscribers and releases all leases on close", async () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 2,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 2
    });
    const admission = createSseSubscriberAdmissionService(budget);
    const reader = createReader();
    const hub = createHub(reader.reader, budget, admission);
    hub.initialize(1);

    expectHubError(
      () => open(hub, "catalog:unauthorized", null, null, "wrong-token"),
      "authorization_failed"
    );
    const aborted = new AbortController();
    aborted.abort();
    expectHubError(
      () => open(hub, "catalog:aborted", null, null, "catalog-token", aborted.signal),
      "aborted"
    );
    const first = open(hub, "catalog:first-device", null, "client_catalog_a");
    expectHubError(
      () => open(hub, "catalog:second-device", null, "client_catalog_a"),
      "subscriber_device_limit"
    );
    expectHubError(
      () => open(hub, "catalog:first-device", null, null),
      "subscriber_exists"
    );
    const local = open(hub, "catalog:local");
    expectHubError(
      () => open(hub, "catalog:global", null, "client_catalog_b"),
      "subscriber_global_limit"
    );
    expect(hub.close()).toBe(2);
    expect(hub.close()).toBe(0);
    expect(admission.snapshot().active_subscribers).toBe(0);
    expect((await first[Symbol.asyncIterator]().next()).done).toBe(true);
    expect((await local[Symbol.asyncIterator]().next()).done).toBe(true);
    expectHubError(() => open(hub, "catalog:closed"), "catalog_closed");
  });
});

interface MutableReader {
  reader: SessionCatalogStateReader;
  readFailure: Error | null;
  readOneFailure: Error | null;
  rawOne: unknown | null;
  readonly delete: (sessionId: string) => void;
  readonly set: (entry: SharedSessionCatalogEntry) => void;
}

function createReader(
  initial: readonly SharedSessionCatalogEntry[] = []
): MutableReader {
  const entries = new Map<string, SharedSessionCatalogEntry>(
    initial.map((entry) => [entry.tracked.internal_session_id, entry])
  );
  const mutable: MutableReader = {
    readFailure: null,
    readOneFailure: null,
    rawOne: null,
    delete: (sessionId) => entries.delete(sessionId),
    set: (entry) => entries.set(entry.tracked.internal_session_id, entry),
    reader: undefined as never
  };
  mutable.reader = Object.freeze({
    read() {
      if (mutable.readFailure !== null) throw mutable.readFailure;
      return Object.freeze([...entries.values()]);
    },
    readOne(sessionId: string) {
      if (mutable.readOneFailure !== null) throw mutable.readOneFailure;
      if (mutable.rawOne !== null) return mutable.rawOne as SharedSessionCatalogEntry;
      return entries.get(sessionId) ?? null;
    }
  });
  return mutable;
}

function createHub(
  reader: SessionCatalogStateReader,
  budget = defaultResourceBudget,
  admission = createSseSubscriberAdmissionService(budget)
): SessionCatalogHub {
  let streamOrdinal = 0;
  return createSessionCatalogHub({
    admission,
    authorize: ({ authorization }) =>
      authorization === "catalog-token" ? { ok: true } : { ok: false },
    create_stream_id() {
      streamOrdinal += 1;
      return `catalog_test_${String(streamOrdinal).padStart(4, "0")}`;
    },
    initial_cursor: 100,
    now: () => new Date(timestamp),
    reader,
    resource_budget: budget
  });
}

function open(
  hub: SessionCatalogHub,
  subscriberId: string,
  after: number | null = null,
  deviceId: string | null = null,
  authorization: unknown = "catalog-token",
  signal: AbortSignal = new AbortController().signal
): SessionCatalogStream {
  return hub.open({
    after,
    authorization,
    device_id: deviceId,
    signal,
    subscriber_id: subscriberId
  });
}

async function take(
  iterator: AsyncIterator<SessionCatalogEvent>,
  count: number
): Promise<SessionCatalogEvent[]> {
  const events: SessionCatalogEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push(requireValue(await iterator.next()));
  }
  return events;
}

function requireValue(
  result: IteratorResult<SessionCatalogEvent>
): SessionCatalogEvent {
  if (result.done) throw new Error("Catalog stream ended before the expected event.");
  return result.value;
}

function requireEvent(
  event: SessionCatalogEvent | undefined
): SessionCatalogEvent {
  if (event === undefined) throw new Error("Expected a catalog event.");
  return event;
}

function expectHubError(
  operation: () => unknown,
  code: SessionCatalogHubErrorCode
): void {
  try {
    operation();
    throw new Error("Expected session catalog operation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSessionCatalogHubError);
    expect((error as HostDeckSessionCatalogHubError).code).toBe(code);
  }
}

function catalogEntry(
  input: {
    readonly cwd?: string;
    readonly recentSummary?: string;
    readonly updatedAt?: string;
  } = {}
): SharedSessionCatalogEntry {
  const updatedAt = input.updatedAt ?? timestamp;
  const cwd = input.cwd ?? "/home/simonli/Videos/apps/side_cue_app";
  return sharedSessionCatalogEntrySchema.parse({
    tracked: {
      native_thread_id: threadA,
      internal_session_id: sessionA,
      alias: "sidecue-deck",
      cwd,
      project_cue: "side_cue_app",
      branch: "main",
      runtime_version: "0.147.0",
      runtime_source: "codex_app_server",
      enrollment_origin: "loaded_before",
      archived: false,
      created_at: timestamp,
      updated_at: updatedAt,
      archived_at: null
    },
    projection: {
      id: sessionA,
      name: "sidecue-deck",
      codex_thread_id: threadA,
      cwd,
      runtime_source: "codex_app_server",
      runtime_version: "0.147.0",
      created_at: timestamp,
      archived_at: null,
      session_state: "active",
      turn_state: "in_progress",
      attention: "watch",
      freshness: "current",
      freshness_reason: null,
      updated_at: updatedAt,
      last_activity_at: updatedAt,
      branch: "main",
      model: "gpt-5.5-codex",
      settings: null,
      goal: null,
      recent_summary: input.recentSummary ?? "Bounded catalog summary.",
      last_event_cursor: 12
    }
  });
}
