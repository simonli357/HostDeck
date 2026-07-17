import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type ResourceBudget,
  resolveResourceBudget,
  type SelectedProjectionEvent,
  type SelectedSessionEventStream,
  selectedProjectionEventSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import {
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  openMigratedDatabase,
  type SelectedSessionState,
  type SelectedStateRepository,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  selectedProjectionSseWireByteLength,
  serializeSseJson
} from "./fastify-sse-source.js";
import {
  createProjectionFanoutHub,
  type ProjectionFanoutHub,
  type ProjectionFanoutSubscriber
} from "./projection-fanout-hub.js";
import {
  createProjectionReplayLiveHandoffService,
  HostDeckProjectionHandoffError,
  type ProjectionHandoffErrorCode
} from "./projection-replay-live-handoff.js";

const sessionA = "sess_handoff_a";
const sessionB = "sess_handoff_b";
const createdAt = "2026-07-11T16:00:00.000Z";

describe("projection replay-to-live handoff", () => {
  it("uses the exact SSE framing byte count shared with transport", () => {
    const event = activityEvent(sessionA, 7);
    const expected = Buffer.byteLength(
      `id: 7\nevent: activity\ndata: ${serializeSseJson(event)}\n\n`,
      "utf8"
    );

    expect(selectedProjectionSseWireByteLength(event)).toBe(expected);
    expect(() => selectedProjectionSseWireByteLength({ ...event, extra: true })).toThrow();
  });

  it("validates config and exact open input before authorization, fanout, or storage", () => {
    const state = new MemoryProjectionState();
    state.addSession(sessionA, []);
    const hub = createProjectionFanoutHub();
    let authorizationCalls = 0;
    let subscribeCalls = 0;
    const service = createProjectionReplayLiveHandoffService({
      authorize(input) {
        authorizationCalls += 1;
        expect(Object.isFrozen(input)).toBe(true);
        return { ok: true };
      },
      fanout: {
        get failure() {
          return hub.failure;
        },
        subscribe(input) {
          subscribeCalls += 1;
          return hub.subscribe(input);
        }
      },
      resource_budget: defaultResourceBudget,
      state
    });

    expectHandoffError(() => service.open(null), "invalid_input");
    expectHandoffError(
      () => service.open({ ...openInput(sessionA, null), subscriber_id: "bad id" }),
      "invalid_input"
    );
    expectHandoffError(
      () => service.open({ ...openInput(sessionA, null), unknown: true }),
      "invalid_input"
    );
    expect(authorizationCalls).toBe(0);
    expect(subscribeCalls).toBe(0);
    expect(state.requireCalls).toBe(0);

    expectHandoffError(
      () =>
        createProjectionReplayLiveHandoffService({
          authorize: () => ({ ok: true }),
          fanout: hub,
          resource_budget: { ...defaultResourceBudget },
          state
        }),
      "invalid_config"
    );
  });

  it("denies or aborts before registration and rejects non-synchronous authorization contracts", () => {
    const cases: Array<{
      readonly authorize: () => unknown;
      readonly code: ProjectionHandoffErrorCode;
    }> = [
      { authorize: () => ({ ok: false }), code: "authorization_failed" },
      { authorize: () => ({ ok: true, extra: true }), code: "authorization_failed" },
      { authorize: () => Promise.resolve({ ok: true }), code: "authorization_failed" },
      {
        authorize: () => {
          throw new Error("secret authorization failure");
        },
        code: "authorization_failed"
      }
    ];

    for (const testCase of cases) {
      const state = new MemoryProjectionState();
      state.addSession(sessionA, []);
      const hub = createProjectionFanoutHub();
      const service = createProjectionReplayLiveHandoffService({
        authorize: testCase.authorize as () => { readonly ok: true },
        fanout: hub,
        resource_budget: defaultResourceBudget,
        state
      });
      expectHandoffError(() => service.open(openInput(sessionA, null)), testCase.code);
      expect(hub.subscriber_count).toBe(0);
      expect(state.requireCalls).toBe(0);
    }

    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    const state = new MemoryProjectionState();
    state.addSession(sessionA, []);
    let authorized = false;
    const service = createProjectionReplayLiveHandoffService({
      authorize: () => {
        authorized = true;
        return { ok: true };
      },
      fanout: createProjectionFanoutHub(),
      resource_budget: defaultResourceBudget,
      state
    });
    expectHandoffError(() => service.open(openInput(sessionA, null, controller.signal)), "aborted");
    expect(authorized).toBe(false);
    expect(state.requireCalls).toBe(0);
  });

  it("covers every valid current cursor and produces immutable contiguous replay", () => {
    for (let highWater = 0; highWater <= 6; highWater += 1) {
      const candidates = [null, ...Array.from({ length: highWater + 1 }, (_unused, index) => index)];
      for (const after of candidates) {
        const state = new MemoryProjectionState();
        state.addSession(sessionA, events(sessionA, highWater));
        const hub = createProjectionFanoutHub();
        const service = handoffService(state, hub);
        const handoff = service.open(openInput(sessionA, after, new AbortController().signal, `sub-${highWater}-${after}`));
        const expectedStart = after === null ? 1 : after + 1;
        const expected = Array.from(
          { length: Math.max(0, highWater - expectedStart + 1) },
          (_unused, index) => expectedStart + index
        );

        expect(handoff.replay_events.map((event) => event.cursor)).toEqual(expected);
        expect(handoff.high_water_cursor).toBe(highWater === 0 ? null : highWater);
        expect(handoff.truncated).toBe(false);
        expect(Object.isFrozen(handoff)).toBe(true);
        expect(Object.isFrozen(handoff.replay_events)).toBe(true);
        expect(handoff.replay_events.every((event) => Object.isFrozen(event))).toBe(true);
        expect(handoff.signal.aborted).toBe(false);
        expect(handoff.close()).toBe(true);
        expect(handoff.signal.aborted).toBe(true);
        expect(handoff.close()).toBe(false);
        expect(hub.subscriber_count).toBe(0);
      }
    }
  });

  it("rejects missing, archived, future, corrupt, and unavailable durable state without leaking tokens", () => {
    const missing = new MemoryProjectionState();
    const missingHub = createProjectionFanoutHub();
    expectHandoffError(
      () => handoffService(missing, missingHub).open(openInput(sessionA, null)),
      "session_not_found"
    );
    expect(missingHub.subscriber_count).toBe(0);

    const archived = new MemoryProjectionState();
    archived.addSession(sessionA, events(sessionA, 1), { archived: true });
    const archivedHub = createProjectionFanoutHub();
    expectHandoffError(
      () => handoffService(archived, archivedHub).open(openInput(sessionA, null)),
      "session_archived"
    );
    expect(archivedHub.subscriber_count).toBe(0);

    const future = new MemoryProjectionState();
    future.addSession(sessionA, events(sessionA, 2));
    const futureHub = createProjectionFanoutHub();
    expectHandoffError(
      () => handoffService(future, futureHub).open(openInput(sessionA, 3)),
      "future_cursor"
    );
    expect(futureHub.subscriber_count).toBe(0);

    const corruptHub = createProjectionFanoutHub();
    const corruptState = {
      require: () => ({}),
      listEvents: () => ({})
    } as unknown as Pick<SelectedStateRepository, "listEvents" | "require">;
    expectHandoffError(
      () => handoffService(corruptState, corruptHub).open(openInput(sessionA, null)),
      "replay_inconsistent"
    );
    expect(corruptHub.subscriber_count).toBe(0);

    const unavailable = new MemoryProjectionState();
    unavailable.addSession(sessionA, events(sessionA, 1));
    unavailable.onList = () => {
      throw new Error("database unavailable");
    };
    const unavailableHub = createProjectionFanoutHub();
    expectHandoffError(
      () => handoffService(unavailable, unavailableHub).open(openInput(sessionA, null)),
      "storage_unavailable"
    );
    expect(unavailableHub.subscriber_count).toBe(0);
  });

  it("rejects fanout ahead of durable state and contradictory buffered duplicates", () => {
    const aheadState = new MemoryProjectionState();
    aheadState.addSession(sessionA, events(sessionA, 4));
    const aheadHub = createProjectionFanoutHub({ max_subscribers: 2, max_subscribers_per_session: 2 });
    const anchor = aheadHub.subscribe({ id: "anchor", on_event: () => undefined, session_id: sessionA });
    aheadHub.publish(committedCandidate(activityEvent(sessionA, 5)));
    expectHandoffError(
      () => handoffService(aheadState, aheadHub).open(openInput(sessionA, 4)),
      "replay_inconsistent"
    );
    expect(aheadHub.failure).toBeNull();
    expect(aheadHub.subscriber_count).toBe(1);
    anchor.unsubscribe();

    const duplicateState = new MemoryProjectionState();
    duplicateState.addSession(sessionA, events(sessionA, 2));
    const duplicateHub = createProjectionFanoutHub();
    duplicateState.onRequire = (_sessionId, call) => {
      if (call !== 1) return;
      const durable = activityEvent(sessionA, 2);
      duplicateHub.publish(
        committedCandidate(
          selectedProjectionEventSchema.parse({
            ...durable,
            title: "Contradictory committed content"
          })
        )
      );
    };
    expectHandoffError(
      () => handoffService(duplicateState, duplicateHub).open(openInput(sessionA, 1)),
      "replay_inconsistent"
    );
    expect(duplicateHub.failure).toBeNull();
    expect(duplicateHub.subscriber_count).toBe(0);
  });

  it("restarts replay when retention advances behind the current page and keeps only the newest boundary", () => {
    const state = new MemoryProjectionState();
    state.addSession(sessionA, events(sessionA, 8), { pageSize: 2 });
    state.onList = (_sessionId, call) => {
      if (call === 2) state.replaceWithRetentionBoundary(sessionA, 1);
      if (call === 6) state.replaceWithRetentionBoundary(sessionA, 3);
    };
    const hub = createProjectionFanoutHub();
    const handoff = handoffService(state, hub).open(openInput(sessionA, 0));

    expect(handoff.truncated).toBe(true);
    expect(handoff.replay_events.map((event) => [event.type, event.cursor])).toEqual([
      ["replay_boundary", 4],
      ["activity", 5],
      ["activity", 6],
      ["activity", 7],
      ["activity", 8]
    ]);
    expect(handoff.replay_events.filter((event) => event.type === "replay_boundary")).toHaveLength(1);
    expect(handoff.replay_wire_bytes).toBe(
      handoff.replay_events.reduce((sum, event) => sum + selectedProjectionSseWireByteLength(event), 0)
    );
    expect(state.listCalls).toBeGreaterThan(6);
    handoff.close();
  });

  it("captures committed events before and after high-water, de-duplicates replay, and drains dynamic arrivals exactly once", () => {
    const state = new MemoryProjectionState();
    state.addSession(sessionA, events(sessionA, 2));
    const hub = createProjectionFanoutHub();
    state.onRequire = (_sessionId, call) => {
      if (call === 1) appendAndPublish(state, hub, activityEvent(sessionA, 3));
    };
    state.onList = (_sessionId, call) => {
      if (call === 1) appendAndPublish(state, hub, activityEvent(sessionA, 4));
    };

    const handoff = handoffService(state, hub).open(openInput(sessionA, 1));
    expect(handoff.high_water_cursor).toBe(3);
    expect(handoff.replay_events.map((event) => event.cursor)).toEqual([2, 3]);
    expect(handoff.paused_event_count).toBe(1);
    appendAndPublish(state, hub, activityEvent(sessionA, 5));
    expect(handoff.paused_event_count).toBe(2);

    const delivered: number[] = [];
    const activated = handoff.activate({
      on_event(event: SelectedProjectionEvent) {
        delivered.push(event.cursor);
        if (event.cursor === 4) appendAndPublish(state, hub, activityEvent(sessionA, 6));
      }
    });
    expect(activated).toEqual({ drained_event_count: 3, live_after_cursor: 6 });
    expect(delivered).toEqual([4, 5, 6]);
    expect(handoff.state).toBe("live");

    appendAndPublish(state, hub, activityEvent(sessionA, 7));
    expect(delivered).toEqual([4, 5, 6, 7]);
    expect(handoff.paused_event_count).toBe(0);
    expect(handoff.failure).toBeNull();
    expect(hub.failure).toBeNull();
    handoff.close();
  });

  it("self-unsubscribes on queue overflow or oversized committed events without poisoning shared fanout", () => {
    const queueBudget = resolveResourceBudget({
      sse_queue_max_events: 8,
      sse_replay_max_events: 8
    });
    const queueState = new MemoryProjectionState();
    queueState.addSession(sessionA, []);
    const queueHub = createProjectionFanoutHub();
    queueState.onRequire = (_sessionId, call) => {
      if (call !== 1) return;
      for (let cursor = 1; cursor <= 9; cursor += 1) {
        appendAndPublish(queueState, queueHub, activityEvent(sessionA, cursor));
      }
    };
    expectHandoffError(
      () => handoffService(queueState, queueHub, queueBudget).open(openInput(sessionA, null)),
      "paused_queue_overflow"
    );
    expect(queueHub.failure).toBeNull();
    expect(queueHub.subscriber_count).toBe(0);

    const eventBudget = resolveResourceBudget({ sse_event_max_bytes: 1_024 });
    const eventState = new MemoryProjectionState();
    eventState.addSession(sessionA, []);
    const eventHub = createProjectionFanoutHub();
    eventState.onRequire = (_sessionId, call) => {
      if (call === 1) appendAndPublish(eventState, eventHub, messageEvent(sessionA, 1, "x".repeat(2_000)));
    };
    expectHandoffError(
      () => handoffService(eventState, eventHub, eventBudget).open(openInput(sessionA, null)),
      "event_too_large"
    );
    expect(eventHub.failure).toBeNull();
    expect(eventHub.subscriber_count).toBe(0);

    const byteBudget = resolveResourceBudget({
      sse_queue_max_bytes: 65_536,
      sse_replay_max_bytes: 65_536
    });
    const byteState = new MemoryProjectionState();
    byteState.addSession(sessionA, []);
    const byteHub = createProjectionFanoutHub();
    byteState.onRequire = (_sessionId, call) => {
      if (call !== 1) return;
      for (let cursor = 1; cursor <= 9; cursor += 1) {
        appendAndPublish(byteState, byteHub, messageEvent(sessionA, cursor, "x".repeat(8_000)));
      }
    };
    expectHandoffError(
      () => handoffService(byteState, byteHub, byteBudget).open(openInput(sessionA, null)),
      "paused_queue_overflow"
    );
    expect(byteHub.failure).toBeNull();
    expect(byteHub.subscriber_count).toBe(0);
  });

  it("enforces replay count, aggregate wire-byte, and per-event limits with cleanup", () => {
    const countState = new MemoryProjectionState();
    countState.addSession(sessionA, events(sessionA, 9));
    const countHub = createProjectionFanoutHub();
    const countBudget = resolveResourceBudget({
      sse_queue_max_events: 8,
      sse_replay_max_events: 8
    });
    expectHandoffError(
      () => handoffService(countState, countHub, countBudget).open(openInput(sessionA, 0)),
      "replay_limit"
    );
    expect(countHub.subscriber_count).toBe(0);

    const bytesState = new MemoryProjectionState();
    bytesState.addSession(
      sessionA,
      Array.from({ length: 9 }, (_unused, index) => messageEvent(sessionA, index + 1, "x".repeat(8_000)))
    );
    const bytesHub = createProjectionFanoutHub();
    const bytesBudget = resolveResourceBudget({
      sse_queue_max_bytes: 65_536,
      sse_queue_max_events: 8,
      sse_replay_max_bytes: 65_536,
      sse_replay_max_events: 10
    });
    expectHandoffError(
      () => handoffService(bytesState, bytesHub, bytesBudget).open(openInput(sessionA, 0)),
      "replay_limit"
    );
    expect(bytesHub.subscriber_count).toBe(0);

    const eventState = new MemoryProjectionState();
    eventState.addSession(sessionA, [messageEvent(sessionA, 1, "x".repeat(2_000))]);
    const eventHub = createProjectionFanoutHub();
    expectHandoffError(
      () =>
        handoffService(eventState, eventHub, resolveResourceBudget({ sse_event_max_bytes: 1_024 })).open(
          openInput(sessionA, 0)
        ),
      "event_too_large"
    );
    expect(eventHub.subscriber_count).toBe(0);
  });

  it("cleans up when abort occurs during registration, replay, or after open", () => {
    const duringRegistration = new AbortController();
    const registrationState = new MemoryProjectionState();
    registrationState.addSession(sessionA, []);
    const registrationHub = createProjectionFanoutHub();
    const registrationService = createProjectionReplayLiveHandoffService({
      authorize: () => ({ ok: true }),
      fanout: {
        get failure() {
          return registrationHub.failure;
        },
        subscribe(input) {
          const token = registrationHub.subscribe(input);
          duringRegistration.abort();
          return token;
        }
      },
      resource_budget: defaultResourceBudget,
      state: registrationState
    });
    expectHandoffError(
      () => registrationService.open(openInput(sessionA, null, duringRegistration.signal)),
      "aborted"
    );
    expect(registrationHub.subscriber_count).toBe(0);

    const duringReplay = new AbortController();
    const replayState = new MemoryProjectionState();
    replayState.addSession(sessionA, events(sessionA, 2), { pageSize: 1 });
    const replayHub = createProjectionFanoutHub();
    replayState.onList = (_sessionId, call) => {
      if (call === 1) duringReplay.abort();
    };
    expectHandoffError(
      () => handoffService(replayState, replayHub).open(openInput(sessionA, 0, duringReplay.signal)),
      "aborted"
    );
    expect(replayHub.subscriber_count).toBe(0);

    const afterOpen = new AbortController();
    const openState = new MemoryProjectionState();
    openState.addSession(sessionA, []);
    const openHub = createProjectionFanoutHub();
    const handoff = handoffService(openState, openHub).open(openInput(sessionA, null, afterOpen.signal));
    afterOpen.abort();
    expect(handoff.state).toBe("closed");
    expect(handoff.close()).toBe(false);
    expect(openHub.subscriber_count).toBe(0);
  });

  it("makes external fanout loss observable before activation", () => {
    const state = new MemoryProjectionState();
    state.addSession(sessionA, events(sessionA, 1));
    const hub = createProjectionFanoutHub();
    const handoff = handoffService(state, hub).open(openInput(sessionA, 1));

    expect(hub.close()).toBe(1);
    expect(handoff.state).toBe("failed");
    expect(handoff.signal.aborted).toBe(true);
    expect(handoff.failure).toEqual({ code: "fanout_unavailable", cursor: 1 });
    expectHandoffError(() => handoff.activate({ on_event: () => undefined }), "fanout_unavailable");
  });

  it("requires a synchronous nonthrowing live sink and isolates every sink failure", async () => {
    const sinkCases: Array<{
      readonly sink: (event: SelectedProjectionEvent) => unknown;
    }> = [
      {
        sink: () => {
          throw new Error("sink failed");
        }
      },
      { sink: () => 1 },
      { sink: () => Promise.reject(new Error("async sink failed")) }
    ];

    for (const [index, testCase] of sinkCases.entries()) {
      const state = new MemoryProjectionState();
      state.addSession(sessionA, events(sessionA, 1));
      const hub = createProjectionFanoutHub();
      const handoff = handoffService(state, hub).open(openInput(sessionA, 1, new AbortController().signal, `sink-${index}`));
      appendAndPublish(state, hub, activityEvent(sessionA, 2));
      expectHandoffError(
        () => handoff.activate({ on_event: testCase.sink as (event: SelectedProjectionEvent) => void }),
        "live_delivery_failed"
      );
      expect(handoff.state).toBe("failed");
      expect(handoff.failure).toEqual({ code: "live_delivery_failed", cursor: 2 });
      expect(hub.failure).toBeNull();
      expect(hub.subscriber_count).toBe(0);
    }
    await Promise.resolve();
  });

  it("handles invalid, repeated, reentrant, and close-during activation deterministically", () => {
    const state = new MemoryProjectionState();
    state.addSession(sessionA, events(sessionA, 1));
    const hub = createProjectionFanoutHub();
    const handoff = handoffService(state, hub).open(openInput(sessionA, 1));
    expectHandoffError(() => handoff.activate(null), "invalid_live_sink");
    expect(handoff.state).toBe("paused");
    expect(handoff.activate({ on_event: () => undefined })).toEqual({
      drained_event_count: 0,
      live_after_cursor: 1
    });
    expectHandoffError(() => handoff.activate({ on_event: () => undefined }), "already_activated");
    expect(handoff.close()).toBe(true);
    expectHandoffError(() => handoff.activate({ on_event: () => undefined }), "handoff_closed");

    const closingState = new MemoryProjectionState();
    closingState.addSession(sessionA, events(sessionA, 1));
    const closingHub = createProjectionFanoutHub();
    const closing = handoffService(closingState, closingHub).open(
      openInput(sessionA, 1, new AbortController().signal, "closing")
    );
    appendAndPublish(closingState, closingHub, activityEvent(sessionA, 2));
    expectHandoffError(
      () =>
        closing.activate({
          on_event() {
            expectHandoffError(
              () => closing.activate({ on_event: () => undefined }),
              "activation_reentrant"
            );
            expect(closing.close()).toBe(true);
          }
        }),
      "handoff_closed"
    );
    expect(closing.state).toBe("closed");
    expect(closing.close()).toBe(false);
    expect(closingHub.failure).toBeNull();
  });

  it("contains direct-live sink failure to one handoff while shared fanout continues", () => {
    const state = new MemoryProjectionState();
    state.addSession(sessionA, events(sessionA, 1));
    const hub = createProjectionFanoutHub({ max_subscribers: 3, max_subscribers_per_session: 3 });
    const handoff = handoffService(state, hub).open(openInput(sessionA, 1));
    handoff.activate({
      on_event() {
        throw new Error("direct live sink failed");
      }
    });
    const peerEvents: number[] = [];
    hub.subscribe({
      id: "peer",
      on_event: (committed: Parameters<ProjectionFanoutSubscriber>[0]) => {
        peerEvents.push(committed.event.event.cursor);
      },
      session_id: sessionA
    });

    appendAndPublish(state, hub, activityEvent(sessionA, 2));
    expect(peerEvents).toEqual([2]);
    expect(handoff.state).toBe("failed");
    expect(handoff.failure).toEqual({ code: "live_delivery_failed", cursor: 2 });
    expect(hub.failure).toBeNull();
    expect(hub.subscriber_count).toBe(1);
  });

  it("preserves concurrent client and session isolation while respecting fanout capacity", () => {
    const state = new MemoryProjectionState();
    state.addSession(sessionA, events(sessionA, 1));
    state.addSession(sessionB, events(sessionB, 10));
    const hub = createProjectionFanoutHub({ max_subscribers: 4, max_subscribers_per_session: 2 });
    const service = handoffService(state, hub);
    const firstA = service.open(openInput(sessionA, 1, new AbortController().signal, "client-a-1"));
    const secondA = service.open(openInput(sessionA, 1, new AbortController().signal, "client-a-2"));
    const firstB = service.open(openInput(sessionB, 10, new AbortController().signal, "client-b-1"));
    expectHandoffError(
      () => service.open(openInput(sessionA, 1, new AbortController().signal, "client-a-3")),
      "fanout_unavailable"
    );

    const deliveredA1: number[] = [];
    const deliveredA2: number[] = [];
    const deliveredB: number[] = [];
    firstA.activate({ on_event: (event: SelectedProjectionEvent) => void deliveredA1.push(event.cursor) });
    secondA.activate({ on_event: (event: SelectedProjectionEvent) => void deliveredA2.push(event.cursor) });
    firstB.activate({ on_event: (event: SelectedProjectionEvent) => void deliveredB.push(event.cursor) });
    appendAndPublish(state, hub, activityEvent(sessionA, 2));
    appendAndPublish(state, hub, activityEvent(sessionB, 11));

    expect(deliveredA1).toEqual([2]);
    expect(deliveredA2).toEqual([2]);
    expect(deliveredB).toEqual([11]);
    expect(hub.failure).toBeNull();
    expect(hub.subscriber_count).toBe(3);
    firstA.close();
    secondA.close();
    firstB.close();
    expect(hub.subscriber_count).toBe(0);
  });

  it("replays and enters direct live mode against a migrated SQLite repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostdeck-handoff-"));
    const open = openMigratedDatabase(join(dir, "hostdeck.sqlite"), { now: () => new Date(createdAt) });
    try {
      const repository = createSelectedStateRepository(open.db);
      const initialMemory: MemorySession = {
        archived: false,
        events: [],
        highWater: null,
        pageSize: 500,
        retentionBoundaryCursor: null
      };
      let current = repository.create(selectedState(sessionA, initialMemory));
      const hub = createProjectionFanoutHub();
      current = appendStoredProjection(repository, hub, current, activityEvent(sessionA, 1));
      current = appendStoredProjection(repository, hub, current, activityEvent(sessionA, 2));
      const handoff = handoffService(repository, hub).open(openInput(sessionA, 1));
      expect(handoff.replay_events.map((event) => event.cursor)).toEqual([2]);

      const delivered: number[] = [];
      handoff.activate({ on_event: (event: SelectedProjectionEvent) => void delivered.push(event.cursor) });
      current = appendStoredProjection(repository, hub, current, activityEvent(sessionA, 3));
      expect(current.projection.session.last_event_cursor).toBe(3);
      expect(delivered).toEqual([3]);
      expect(handoff.failure).toBeNull();
      expect(hub.failure).toBeNull();
      handoff.close();
    } finally {
      open.db.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

interface MemorySessionOptions {
  readonly archived?: boolean;
  readonly pageSize?: number;
  readonly retentionBoundaryCursor?: number | null;
}

interface MemorySession {
  archived: boolean;
  events: SelectedProjectionEvent[];
  highWater: number | null;
  pageSize: number;
  retentionBoundaryCursor: number | null;
}

class MemoryProjectionState implements Pick<SelectedStateRepository, "listEvents" | "require"> {
  readonly sessions = new Map<string, MemorySession>();
  listCalls = 0;
  requireCalls = 0;
  onList: ((sessionId: string, call: number) => void) | null = null;
  onRequire: ((sessionId: string, call: number) => void) | null = null;

  addSession(sessionId: string, selectedEvents: readonly SelectedProjectionEvent[], options: MemorySessionOptions = {}): void {
    this.sessions.set(sessionId, {
      archived: options.archived ?? false,
      events: [...selectedEvents],
      highWater: selectedEvents.at(-1)?.cursor ?? null,
      pageSize: options.pageSize ?? 500,
      retentionBoundaryCursor: options.retentionBoundaryCursor ?? null
    });
  }

  append(event: SelectedProjectionEvent): void {
    const session = this.requireMemorySession(event.session_id);
    const expected = (session.highWater ?? 0) + 1;
    if (event.cursor !== expected) throw new Error(`Expected cursor ${expected}, received ${event.cursor}.`);
    session.events.push(event);
    session.highWater = event.cursor;
  }

  replaceWithRetentionBoundary(sessionId: string, after: number): void {
    const session = this.requireMemorySession(sessionId);
    const cursor = after + 1;
    if (session.highWater === null || cursor >= session.highWater) {
      throw new Error("Test retention must leave at least one later event.");
    }
    session.events = [
      replayBoundaryEvent(sessionId, cursor, after),
      ...session.events.filter((event) => event.cursor > cursor)
    ];
    session.retentionBoundaryCursor = after;
  }

  require(sessionId: string): SelectedSessionState {
    this.requireCalls += 1;
    this.onRequire?.(sessionId, this.requireCalls);
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new HostDeckSelectedStateRepositoryError("session_not_found", `Missing ${sessionId}.`);
    }
    return selectedState(sessionId, session);
  }

  listEvents(sessionId: string, input: { readonly after?: number | null; readonly limit?: number } = {}): SelectedSessionEventStream {
    this.listCalls += 1;
    this.onList?.(sessionId, this.listCalls);
    const session = this.requireMemorySession(sessionId);
    const after = input.after ?? null;
    if (after !== null && after > (session.highWater ?? 0)) {
      throw new HostDeckSelectedStateRepositoryError("invalid_replay", "Future replay cursor.");
    }
    const limit = Math.min(input.limit ?? 100, session.pageSize);
    const selected = session.events
      .filter((event) => after === null || event.cursor > after)
      .slice(0, limit);
    return {
      session_id: sessionId,
      events: selected,
      next_cursor: selected.at(-1)?.cursor ?? session.highWater ?? 0,
      truncated: selected[0]?.type === "replay_boundary"
    } as SelectedSessionEventStream;
  }

  private requireMemorySession(sessionId: string): MemorySession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new HostDeckSelectedStateRepositoryError("session_not_found", `Missing ${sessionId}.`);
    }
    return session;
  }
}

function handoffService(
  state: Pick<SelectedStateRepository, "listEvents" | "require">,
  fanout: Pick<ProjectionFanoutHub, "failure" | "subscribe">,
  resourceBudget: ResourceBudget = defaultResourceBudget
) {
  return createProjectionReplayLiveHandoffService({
    authorize: () => ({ ok: true }),
    fanout,
    resource_budget: resourceBudget,
    state
  });
}

function openInput(
  sessionId: string,
  after: number | null,
  signal: AbortSignal = new AbortController().signal,
  subscriberId = "handoff-client"
) {
  return {
    after,
    authorization: Object.freeze({ device_id: "device-test" }),
    session_id: sessionId,
    signal,
    subscriber_id: subscriberId
  };
}

function appendAndPublish(
  state: MemoryProjectionState,
  hub: Pick<ProjectionFanoutHub, "publish">,
  event: SelectedProjectionEvent
): void {
  state.append(event);
  hub.publish(committedCandidate(event));
}

function appendStoredProjection(
  repository: SelectedStateRepository,
  hub: Pick<ProjectionFanoutHub, "publish">,
  current: SelectedSessionState,
  event: SelectedProjectionEvent
): SelectedSessionState {
  const byteLength = selectedProjectedEventByteLength(event);
  const nextProjection = selectedSessionProjectionRecordSchema.parse({
    ...current.projection,
    session: {
      ...current.projection.session,
      updated_at: event.captured_at,
      last_activity_at: event.captured_at,
      recent_summary: `Stored cursor ${event.cursor}.`,
      last_event_cursor: event.cursor
    },
    retained_event_count: current.projection.retained_event_count + 1,
    retained_event_bytes: current.projection.retained_event_bytes + byteLength,
    earliest_retained_cursor: current.projection.earliest_retained_cursor ?? event.cursor
  });
  const committed = repository.appendEvent(
    { event, byte_length: byteLength },
    nextProjection,
    selectedStateRevision(current)
  );
  hub.publish(deepFreeze(committed));
  return repository.require(current.mapping.id);
}

function committedCandidate(event: SelectedProjectionEvent) {
  const byteLength = selectedProjectedEventByteLength(event);
  const capturedAt = event.captured_at;
  return deepFreeze({
    event: { event, byte_length: byteLength },
    projection: {
      session: {
        id: event.session_id,
        name: event.session_id.replace(/^sess_/u, ""),
        codex_thread_id: `thread-${event.session_id}`,
        cwd: `/tmp/${event.session_id}`,
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
        recent_summary: `Committed cursor ${event.cursor}.`,
        last_event_cursor: event.cursor
      },
      retained_event_count: Math.max(1, event.cursor),
      retained_event_bytes: Math.max(byteLength, byteLength * event.cursor),
      earliest_retained_cursor: 1,
      retention_boundary_cursor: null
    },
    revision: {
      mapping_updated_at: createdAt,
      projection_updated_at: capturedAt,
      last_event_cursor: event.cursor
    }
  });
}

function selectedState(sessionId: string, memory: MemorySession): SelectedSessionState {
  const archivedAt = memory.archived ? eventAt(memory.highWater ?? 1) : null;
  const updatedAt = eventAt(memory.highWater ?? 0);
  const retainedBytes = memory.events.reduce((sum, event) => sum + selectedProjectedEventByteLength(event), 0);
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: sessionId,
      name: sessionId.replace(/^sess_/u, ""),
      codex_thread_id: `thread-${sessionId}`,
      cwd: `/tmp/${sessionId}`,
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      disposition: "selected",
      created_at: createdAt,
      updated_at: updatedAt,
      archived_at: archivedAt
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: sessionId,
        name: sessionId.replace(/^sess_/u, ""),
        codex_thread_id: `thread-${sessionId}`,
        cwd: `/tmp/${sessionId}`,
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        created_at: createdAt,
        archived_at: archivedAt,
        session_state: memory.archived ? "archived" : "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: updatedAt,
        last_activity_at: memory.highWater === null ? null : updatedAt,
        branch: null,
        model: null,
        goal: null,
        recent_summary: memory.highWater === null ? "" : `Cursor ${memory.highWater}.`,
        last_event_cursor: memory.highWater
      },
      retained_event_count: memory.events.length,
      retained_event_bytes: retainedBytes,
      earliest_retained_cursor: memory.events[0]?.cursor ?? null,
      retention_boundary_cursor: memory.retentionBoundaryCursor
    })
  };
}

function events(sessionId: string, count: number): SelectedProjectionEvent[] {
  return Array.from({ length: count }, (_unused, index) => activityEvent(sessionId, index + 1));
}

function activityEvent(sessionId: string, cursor: number): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: eventAt(cursor),
    upstream_at: null,
    codex_event_id: `upstream-${sessionId}-${cursor}`,
    codex_event_type: "thread/status/changed",
    content_state: "complete",
    content_notice: null,
    type: "activity",
    activity: "thread",
    state: "updated",
    item_id: null,
    title: "Thread state updated",
    detail: null
  });
}

function messageEvent(sessionId: string, cursor: number, text: string): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: eventAt(cursor),
    upstream_at: null,
    codex_event_id: `upstream-${sessionId}-${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_state: "complete",
    content_notice: null,
    type: "message",
    role: "agent",
    phase: "delta",
    item_id: `item-${cursor}`,
    text
  });
}

function replayBoundaryEvent(sessionId: string, cursor: number, after: number | null): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: eventAt(cursor),
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason: "retention"
  });
}

function expectHandoffError(fn: () => unknown, code: ProjectionHandoffErrorCode): HostDeckProjectionHandoffError {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckProjectionHandoffError);
  expect((caught as HostDeckProjectionHandoffError).code).toBe(code);
  return caught as HostDeckProjectionHandoffError;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function eventAt(cursor: number): string {
  return new Date(Date.parse(createdAt) + cursor * 1_000).toISOString();
}
