import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityProjectionEventSchema, isoTimestampSchema } from "@hostdeck/contracts";
import {
  createProductionProjectionAppendPort,
  createSelectedStateRepository,
  openMigratedDatabase,
  type ProductionProjectionAppendInput,
  type SelectedSessionState,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectionFanoutHub,
  HostDeckProjectionFanoutError,
  type ProjectionFanoutErrorCode,
  type ProjectionFanoutSubscription
} from "./projection-fanout-hub.js";

const tempDirs: string[] = [];
const createdAt = "2026-07-10T20:00:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("commit-only projection fanout hub", () => {
  it("rejects invalid composition limits and unknown option fields", () => {
    expect(() => createProjectionFanoutHub(null as never)).toThrow(TypeError);
    expect(() => createProjectionFanoutHub({ max_subscribers: 0 })).toThrow(TypeError);
    expect(() => createProjectionFanoutHub({ max_subscribers: null as never })).toThrow(TypeError);
    expect(() => createProjectionFanoutHub({ max_subscribers: 513 })).toThrow(TypeError);
    expect(() => createProjectionFanoutHub({ max_subscribers_per_session: 33 })).toThrow(TypeError);
    expect(() => createProjectionFanoutHub({ max_subscribers: 1, max_subscribers_per_session: 2 })).toThrow(TypeError);
    expect(() => createProjectionFanoutHub({ unknown: 1 } as never)).toThrow(TypeError);

    const hub = createProjectionFanoutHub();
    expect(hub).toMatchObject({ closed: false, failure: null, subscriber_count: 0, tracked_session_count: 0 });
  });

  it("validates no-subscriber publications without retaining session or event state", () => {
    const hub = createProjectionFanoutHub();
    expect(hub.publish(committedCandidate({ cursor: 4 }))).toBeUndefined();
    expect(hub.tracked_session_count).toBe(0);

    const delivered: number[] = [];
    const first = hub.subscribe(subscriptionInput("subscriber:first", "sess_fanout_a", (committed) => {
      delivered.push(committed.event.event.cursor);
    }));
    expect(first.observed_high_water_cursor).toBeNull();
    hub.publish(committedCandidate({ cursor: 5 }));

    const second = hub.subscribe(subscriptionInput("subscriber:second", "sess_fanout_a", () => undefined));
    expect(second.observed_high_water_cursor).toBe(5);
    expect(delivered).toEqual([5]);
  });

  it("preserves independent strict order for two subscribed sessions", () => {
    const hub = createProjectionFanoutHub({ max_subscribers: 4, max_subscribers_per_session: 2 });
    const deliveredA: number[] = [];
    const deliveredB: number[] = [];
    hub.subscribe(subscriptionInput("subscriber:a", "sess_fanout_a", (committed) => {
      expect(Object.isFrozen(committed)).toBe(true);
      expect(Object.isFrozen(committed.event.event)).toBe(true);
      deliveredA.push(committed.event.event.cursor);
    }));
    hub.subscribe(subscriptionInput("subscriber:b", "sess_fanout_b", (committed) => {
      deliveredB.push(committed.event.event.cursor);
    }));

    hub.publish(committedCandidate({ cursor: 10, sessionId: "sess_fanout_a" }));
    hub.publish(committedCandidate({ cursor: 40, sessionId: "sess_fanout_b" }));
    hub.publish(committedCandidate({ cursor: 11, sessionId: "sess_fanout_a" }));
    hub.publish(committedCandidate({ cursor: 41, sessionId: "sess_fanout_b" }));

    expect(deliveredA).toEqual([10, 11]);
    expect(deliveredB).toEqual([40, 41]);
    expect(hub.failure).toBeNull();
  });

  it("stops and clears registrations on duplicate, backward, or gapped live cursors", () => {
    const cases = [
      [5, "publication_duplicate"],
      [4, "publication_backward"],
      [7, "publication_gap"]
    ] as const;

    for (const [invalidCursor, code] of cases) {
      const hub = createProjectionFanoutHub();
      const subscription = hub.subscribe(subscriptionInput(`subscriber:${code}`, "sess_fanout_a", () => undefined));
      hub.publish(committedCandidate({ cursor: 5 }));

      expectFanoutError(() => hub.publish(committedCandidate({ cursor: invalidCursor })), code);
      expect(hub.failure).toEqual({
        code,
        cursor: invalidCursor,
        failed_subscriber_count: 0,
        session_id: "sess_fanout_a"
      });
      expect(hub.subscriber_count).toBe(0);
      expect(hub.tracked_session_count).toBe(0);
      expect(subscription.active).toBe(false);
      expectFanoutError(() => hub.publish(committedCandidate({ cursor: 6 })), "fanout_stopped");
      expectFanoutError(
        () => hub.subscribe(subscriptionInput(`subscriber:${code}:late`, "sess_fanout_a", () => undefined)),
        "fanout_stopped"
      );
    }
  });

  it("stops on unfrozen, malformed, or internally contradictory committed receipts", () => {
    const candidates = [
      unfrozenCommittedCandidate({ cursor: 1 }),
      committedCandidate({ byteLengthDelta: 1, cursor: 1 }),
      committedCandidate({ cursor: 1, projectionSessionId: "sess_fanout_b" }),
      committedCandidate({ cursor: 1, projectionCursor: 2 }),
      committedCandidate({ cursor: 1, revisionCursor: 2 }),
      committedCandidate({ cursor: 1, revisionProjectionUpdatedAt: "2026-07-10T20:02:00.000Z" }),
      deepFreeze({ ...unfrozenCommittedCandidate({ cursor: 1 }), extra: true })
    ];

    for (const candidate of candidates) {
      const hub = createProjectionFanoutHub();
      expectFanoutError(() => hub.publish(candidate), "invalid_publication");
      expect(hub.failure).toMatchObject({ code: "invalid_publication" });
      expect(hub.subscriber_count).toBe(0);
    }
  });

  it("enforces unique ids and policy-backed global and per-session capacity without poisoning the hub", () => {
    const hub = createProjectionFanoutHub({ max_subscribers: 2, max_subscribers_per_session: 1 });
    expectFanoutError(() => hub.subscribe(null), "invalid_subscription");
    expectFanoutError(
      () => hub.subscribe({ ...subscriptionInput("bad id", "sess_fanout_a", () => undefined), extra: true }),
      "invalid_subscription"
    );

    const first = hub.subscribe(subscriptionInput("subscriber:one", "sess_fanout_a", () => undefined));
    expectFanoutError(
      () => hub.subscribe(subscriptionInput("subscriber:one", "sess_fanout_b", () => undefined)),
      "subscriber_exists"
    );
    expectFanoutError(
      () => hub.subscribe(subscriptionInput("subscriber:same-session", "sess_fanout_a", () => undefined)),
      "subscriber_session_limit"
    );
    hub.subscribe(subscriptionInput("subscriber:two", "sess_fanout_b", () => undefined));
    expectFanoutError(
      () => hub.subscribe(subscriptionInput("subscriber:three", "sess_fanout_c", () => undefined)),
      "subscriber_limit"
    );
    expect(hub.failure).toBeNull();

    expect(first.unsubscribe()).toBe(true);
    expect(first.unsubscribe()).toBe(false);
    const replacement = hub.subscribe(subscriptionInput("subscriber:one", "sess_fanout_c", () => undefined));
    expect(first.active).toBe(false);
    expect(first.unsubscribe()).toBe(false);
    expect(replacement.active).toBe(true);
    expect(hub).toMatchObject({ subscriber_count: 2, tracked_session_count: 2 });
  });

  it("uses a dispatch snapshot when subscribers register or leave during publication", () => {
    const hub = createProjectionFanoutHub({ max_subscribers: 4, max_subscribers_per_session: 4 });
    const deliveredA: number[] = [];
    const deliveredB: number[] = [];
    const deliveredC: number[] = [];
    const dynamic: { second?: ProjectionFanoutSubscription } = {};
    let third: ProjectionFanoutSubscription;

    hub.subscribe(subscriptionInput("subscriber:a", "sess_fanout_a", (committed) => {
      deliveredA.push(committed.event.event.cursor);
      if (committed.event.event.cursor === 1) {
        expect(third.unsubscribe()).toBe(true);
        dynamic.second = hub.subscribe(subscriptionInput("subscriber:b", "sess_fanout_a", (next) => {
          deliveredB.push(next.event.event.cursor);
        }));
      }
    }));
    third = hub.subscribe(subscriptionInput("subscriber:c", "sess_fanout_a", (committed) => {
      deliveredC.push(committed.event.event.cursor);
    }));

    hub.publish(committedCandidate({ cursor: 1 }));
    expect(dynamic.second?.observed_high_water_cursor).toBeNull();
    expect(deliveredA).toEqual([1]);
    expect(deliveredB).toEqual([]);
    expect(deliveredC).toEqual([]);

    hub.publish(committedCandidate({ cursor: 2 }));
    expect(deliveredA).toEqual([1, 2]);
    expect(deliveredB).toEqual([2]);
    expect(deliveredC).toEqual([]);
  });

  it("attempts the dispatch snapshot then stops on throwing, non-void, or async sinks", async () => {
    const throwingHub = createProjectionFanoutHub();
    const attempts: string[] = [];
    throwingHub.subscribe(subscriptionInput("subscriber:before", "sess_fanout_a", () => {
      attempts.push("before");
    }));
    throwingHub.subscribe(subscriptionInput("subscriber:throw", "sess_fanout_a", () => {
      attempts.push("throw");
      throw new Error("subscriber failed");
    }));
    throwingHub.subscribe(subscriptionInput("subscriber:after", "sess_fanout_a", () => {
      attempts.push("after");
    }));

    expectFanoutError(() => throwingHub.publish(committedCandidate({ cursor: 1 })), "subscriber_delivery_failed");
    expect(attempts).toEqual(["before", "throw", "after"]);
    expect(throwingHub.failure).toMatchObject({ failed_subscriber_count: 1 });

    const nonVoidHub = createProjectionFanoutHub();
    nonVoidHub.subscribe(subscriptionInput("subscriber:non-void", "sess_fanout_a", (() => 1) as () => void));
    expectFanoutError(() => nonVoidHub.publish(committedCandidate({ cursor: 1 })), "subscriber_delivery_failed");

    const asyncHub = createProjectionFanoutHub();
    asyncHub.subscribe(subscriptionInput("subscriber:async", "sess_fanout_a", (async () => undefined) as () => void));
    expectFanoutError(() => asyncHub.publish(committedCandidate({ cursor: 1 })), "subscriber_delivery_failed");
    await Promise.resolve();
  });

  it("stops on reentrant publication even when the subscriber catches the nested error", () => {
    const hub = createProjectionFanoutHub();
    hub.subscribe(subscriptionInput("subscriber:reentrant", "sess_fanout_a", () => {
      try {
        hub.publish(committedCandidate({ cursor: 2 }));
      } catch {
        // The outer publication must still observe the latched fatal state.
      }
    }));

    expectFanoutError(() => hub.publish(committedCandidate({ cursor: 1 })), "fanout_stopped");
    expect(hub.failure).toEqual({
      code: "publication_reentrant",
      cursor: null,
      failed_subscriber_count: 0,
      session_id: null
    });
  });

  it("closes idempotently, invalidates subscription handles, and rejects later work", () => {
    const hub = createProjectionFanoutHub();
    const first = hub.subscribe(subscriptionInput("subscriber:close-a", "sess_fanout_a", () => undefined));
    const second = hub.subscribe(subscriptionInput("subscriber:close-b", "sess_fanout_b", () => undefined));

    expect(hub.close()).toBe(2);
    expect(hub.close()).toBe(0);
    expect(hub).toMatchObject({ closed: true, subscriber_count: 0, tracked_session_count: 0 });
    expect(first.active).toBe(false);
    expect(second.active).toBe(false);
    expect(first.unsubscribe()).toBe(false);
    expectFanoutError(() => hub.publish(committedCandidate({ cursor: 1 })), "fanout_closed");
    expectFanoutError(
      () => hub.subscribe(subscriptionInput("subscriber:late", "sess_fanout_a", () => undefined)),
      "fanout_closed"
    );
  });

  it("stops the current dispatch immediately when lifecycle close occurs inside a sink", () => {
    const hub = createProjectionFanoutHub();
    const delivered: string[] = [];
    hub.subscribe(subscriptionInput("subscriber:closing", "sess_fanout_a", () => {
      delivered.push("closing");
      expect(hub.close()).toBe(2);
    }));
    hub.subscribe(subscriptionInput("subscriber:after-close", "sess_fanout_a", () => {
      delivered.push("after-close");
    }));

    expectFanoutError(() => hub.publish(committedCandidate({ cursor: 1 })), "fanout_closed");
    expect(delivered).toEqual(["closing"]);
    expect(hub).toMatchObject({ closed: true, failure: null, subscriber_count: 0, tracked_session_count: 0 });
  });

  it("receives only durable production appends and never sees a rolled-back insert", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      let current = repository.create(stateCandidate("sess_fanout_a", "thread-fanout-a"));
      const hub = createProjectionFanoutHub();
      const delivered: number[] = [];
      hub.subscribe(subscriptionInput("subscriber:production", current.mapping.id, (committed) => {
        const durable = repository.listEvents(current.mapping.id).events.at(-1);
        expect(durable).toEqual(committed.event.event);
        delivered.push(committed.event.event.cursor);
      }));
      const port = createProductionProjectionAppendPort({ repository, publish: hub.publish });

      await port.append(appendCandidate(current, "upstream-fanout-first", "2026-07-10T20:01:00.000Z"));
      current = repository.require(current.mapping.id);
      installProjectionFailure(open.db, "upstream-fanout-rollback");
      await expect(
        port.append(appendCandidate(current, "upstream-fanout-rollback", "2026-07-10T20:02:00.000Z"))
      ).rejects.toThrow();
      expect(delivered).toEqual([1]);
      expect(repository.listEvents(current.mapping.id).events.map((event) => event.cursor)).toEqual([1]);

      open.db.exec("DROP TRIGGER force_projection_fanout_rollback");
      await port.append(appendCandidate(current, "upstream-fanout-second", "2026-07-10T20:03:00.000Z"));
      expect(delivered).toEqual([1, 2]);
      expect(hub.failure).toBeNull();
    } finally {
      open.db.close();
    }
  });
});

function subscriptionInput(id: string, sessionId: string, onEvent: (committed: ReturnType<typeof committedCandidate>) => void) {
  return { id, on_event: onEvent, session_id: sessionId };
}

interface CommittedCandidateOptions {
  readonly byteLengthDelta?: number;
  readonly cursor: number;
  readonly projectionCursor?: number;
  readonly projectionSessionId?: string;
  readonly revisionCursor?: number;
  readonly revisionProjectionUpdatedAt?: string;
  readonly sessionId?: string;
}

function committedCandidate(options: CommittedCandidateOptions) {
  return deepFreeze(unfrozenCommittedCandidate(options));
}

function unfrozenCommittedCandidate(options: CommittedCandidateOptions) {
  const sessionId = options.sessionId ?? "sess_fanout_a";
  const capturedAt = eventAt(options.cursor);
  const event = projectedEvent(sessionId, options.cursor, capturedAt);
  const byteLength = selectedProjectedEventByteLength(event) + (options.byteLengthDelta ?? 0);
  const projectionSessionId = options.projectionSessionId ?? sessionId;
  const projectionCursor = options.projectionCursor ?? options.cursor;
  return {
    event: { event, byte_length: byteLength },
    projection: {
      session: {
        id: projectionSessionId,
        name: projectionSessionId.replace(/^sess_/u, ""),
        codex_thread_id: `thread-${projectionSessionId}`,
        cwd: `/tmp/${projectionSessionId}`,
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        created_at: createdAt,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: capturedAt,
        last_activity_at: capturedAt,
        branch: null,
        model: null,
        goal: null,
        recent_summary: `Committed cursor ${options.cursor}.`,
        last_event_cursor: projectionCursor
      },
      retained_event_count: Math.max(1, options.cursor),
      retained_event_bytes: Math.max(byteLength, byteLength * options.cursor),
      earliest_retained_cursor: 1,
      retention_boundary_cursor: null
    },
    revision: {
      mapping_updated_at: createdAt,
      projection_updated_at: options.revisionProjectionUpdatedAt ?? capturedAt,
      last_event_cursor: options.revisionCursor ?? options.cursor
    }
  };
}

function projectedEvent(sessionId: string, cursor: number, capturedAt: string) {
  return {
    session_id: sessionId,
    cursor,
    captured_at: capturedAt,
    upstream_at: null,
    codex_event_id: `upstream-fanout-${sessionId}-${cursor}`,
    codex_event_type: "thread/status/changed",
    content_state: "complete",
    content_notice: null,
    type: "activity",
    activity: "thread",
    state: "updated",
    item_id: null,
    title: "Thread state updated",
    detail: null
  } as const;
}

function stateCandidate(sessionId: string, threadId: string) {
  const name = sessionId.replace(/^sess_/u, "");
  const session = {
    id: sessionId,
    name,
    codex_thread_id: threadId,
    cwd: `/tmp/${sessionId}`,
    runtime_source: "codex_app_server" as const,
    runtime_version: "0.144.0",
    created_at: createdAt,
    archived_at: null,
    session_state: "active" as const,
    turn_state: "idle" as const,
    attention: "none" as const,
    freshness: "current" as const,
    freshness_reason: null,
    updated_at: createdAt,
    last_activity_at: null,
    branch: null,
    model: null,
    goal: null,
    recent_summary: "",
    last_event_cursor: null
  };
  return {
    mapping: {
      id: sessionId,
      name,
      codex_thread_id: threadId,
      cwd: `/tmp/${sessionId}`,
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      disposition: "selected",
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: null
    },
    projection: {
      session,
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function appendCandidate(current: SelectedSessionState, upstreamId: string, capturedAt: string): ProductionProjectionAppendInput {
  const { last_event_cursor: _lastEventCursor, ...nextSession } = current.projection.session;
  const addressedEvent = activityProjectionEventSchema.parse(projectedEvent(current.mapping.id, 1, capturedAt));
  const { cursor: _cursor, session_id: _sessionId, ...event } = addressedEvent;
  const parsedCapturedAt = isoTimestampSchema.parse(capturedAt);
  return {
    session_id: current.mapping.id,
    expected_revision: selectedStateRevision(current),
    event: {
      ...event,
      codex_event_id: upstreamId
    },
    next_session: {
      ...nextSession,
      updated_at: parsedCapturedAt,
      last_activity_at: parsedCapturedAt,
      recent_summary: upstreamId
    }
  };
}

function installProjectionFailure(db: { readonly exec: (sql: string) => unknown }, upstreamId: string): void {
  db.exec(`
    CREATE TRIGGER force_projection_fanout_rollback
    AFTER INSERT ON selected_projected_events
    WHEN NEW.codex_event_id = '${upstreamId}'
    BEGIN
      SELECT RAISE(ABORT, 'forced projection fanout rollback');
    END;
  `);
}

function expectFanoutError(fn: () => unknown, code: ProjectionFanoutErrorCode): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckProjectionFanoutError);
  expect((caught as HostDeckProjectionFanoutError).code).toBe(code);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function eventAt(cursor: number): string {
  return new Date(Date.parse(createdAt) + cursor * 1_000).toISOString();
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-projection-fanout-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(createdAt);
}
