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
import type { OutputCursor } from "@hostdeck/core";
import {
  HostDeckSelectedStateRepositoryError,
  type SelectedSessionState,
  selectedProjectedEventByteLength
} from "@hostdeck/storage";
import { describe, expect, it, vi } from "vitest";
import { selectedProjectionSseWireByteLength } from "./fastify-sse-source.js";
import {
  createProjectionFanoutHub,
  type ProjectionFanoutHub
} from "./projection-fanout-hub.js";
import {
  createProjectionReplayLiveHandoffService,
  type OpenProjectionReplayLiveHandoffInput,
  type ProjectionReplayLiveHandoff
} from "./projection-replay-live-handoff.js";
import {
  createProjectionSubscriberStreamService,
  HostDeckProjectionSubscriberError,
  type ProjectionSubscriberErrorCode,
  type ProjectionSubscriberFailure,
  type ProjectionSubscriberStream,
  type ProjectionSubscriberStreamService
} from "./projection-subscriber-stream.js";

const sessionA = "sess_subscriber_a";
const sessionB = "sess_subscriber_b";
const sessionC = "sess_subscriber_c";
const createdAt = "2026-07-16T12:00:00.000Z";

describe("bounded projection subscriber streams", () => {
  it("rejects malformed config and exact open input before handoff work", () => {
    let openCalls = 0;
    const handoff = {
      open() {
        openCalls += 1;
        throw new Error("must not open");
      }
    };
    const service = createProjectionSubscriberStreamService({
      handoff,
      observe_failure: () => undefined,
      resource_budget: defaultResourceBudget
    });
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "after", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private accessor");
      }
    });

    for (const candidate of [
      null,
      {},
      { ...openInput(sessionA, "sub-a"), extra: true },
      { ...openInput(sessionA, "sub-a"), device_id: "bad id" },
      { ...openInput(sessionA, "bad id") },
      accessor
    ]) {
      expectSubscriberError(() => service.open(candidate), "invalid_input");
    }
    const aborted = new AbortController();
    aborted.abort();
    expectSubscriberError(
      () => service.open(openInput(sessionA, "sub-aborted", null, aborted.signal)),
      "aborted"
    );
    expect(openCalls).toBe(0);
    expect(accessorCalls).toBe(0);

    expectSubscriberError(
      () =>
        createProjectionSubscriberStreamService({
          handoff,
          observe_failure: () => undefined,
          resource_budget: { ...defaultResourceBudget }
        }),
      "invalid_config"
    );
    expectSubscriberError(
      () =>
        createProjectionSubscriberStreamService({
          handoff,
          observe_failure: undefined
        } as never),
      "invalid_config"
    );

    const closeMalformedSource = vi.fn(() => true);
    const malformedSource = createProjectionSubscriberStreamService({
      handoff: Object.freeze({
        open: () => Object.freeze({ close: closeMalformedSource })
      }) as never,
      observe_failure: () => undefined,
      resource_budget: defaultResourceBudget
    });
    expectSubscriberError(
      () => malformedSource.open(openInput(sessionA, "sub-malformed-source")),
      "source_failed"
    );
    expect(malformedSource.snapshot()).toMatchObject({
      active_subscribers: 0,
      source_failed_subscribers: 1,
      source_open_failures: 1
    });
    expect(closeMalformedSource).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed replay claims without invoking claim accessors or retaining totals", () => {
    const event = activityEvent(sessionA, 1);
    const eventWireBytes = selectedProjectionSseWireByteLength(event);
    let accessorCalls = 0;
    let eventAccessorCalls = 0;
    const accessorClaim = Object.freeze(
      Object.defineProperty({}, "event_count", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return 1;
        }
      })
    );
    const accessorEvent = Object.freeze(
      Object.defineProperty({ ...event }, "title", {
        configurable: false,
        enumerable: true,
        get() {
          eventAccessorCalls += 1;
          throw new Error("private replay event accessor");
        }
      })
    );
    const cases = [
      {
        claim: accessorClaim,
        eventCount: 1,
        highWater: 1 as OutputCursor,
        wireBytes: eventWireBytes
      },
      {
        claim: Object.freeze({
          event_count: 1,
          events: Object.freeze([event]),
          wire_bytes: eventWireBytes - 1
        }),
        eventCount: 1,
        highWater: 1 as OutputCursor,
        wireBytes: eventWireBytes - 1
      },
      {
        claim: Object.freeze({
          event_count: 1,
          events: Object.freeze([activityEvent(sessionA, 2)]),
          wire_bytes: selectedProjectionSseWireByteLength(
            activityEvent(sessionA, 2)
          )
        }),
        eventCount: 1,
        highWater: 2 as OutputCursor,
        wireBytes: selectedProjectionSseWireByteLength(
          activityEvent(sessionA, 2)
        )
      },
      {
        claim: Object.freeze({
          event_count: 1,
          events: Object.freeze([accessorEvent]),
          wire_bytes: eventWireBytes
        }),
        eventCount: 1,
        highWater: 1 as OutputCursor,
        wireBytes: eventWireBytes
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const close = vi.fn(() => true);
      const service = createProjectionSubscriberStreamService({
        handoff: Object.freeze({
          open: (candidate: unknown) =>
            fakePausedHandoff(
              candidate as OpenProjectionReplayLiveHandoffInput,
              close,
              {
                claim: testCase.claim,
                highWater: testCase.highWater,
                replayEventCount: testCase.eventCount,
                replayWireBytes: testCase.wireBytes
              }
            )
        }),
        observe_failure: () => undefined,
        resource_budget: defaultResourceBudget
      });
      expectSubscriberError(
        () => service.open(openInput(sessionA, `malformed-claim-${index}`)),
        "source_failed"
      );
      expect(close).toHaveBeenCalledTimes(1);
      expect(service.snapshot()).toMatchObject({
        active_device_buckets: 0,
        active_session_buckets: 0,
        active_subscribers: 0,
        queued_events: 0,
        replay_events: 0,
        retained_events: 0,
        source_failed_subscribers: 1,
        source_open_failures: 1
      });
    }
    expect(accessorCalls).toBe(0);
    expect(eventAccessorCalls).toBe(0);
  });

  it("retains one immutable replay payload without cloning it", async () => {
    const event = deepFreeze(activityEvent(sessionA, 1));
    const wireBytes = selectedProjectionSseWireByteLength(event);
    const close = vi.fn(() => true);
    const service = createProjectionSubscriberStreamService({
      handoff: Object.freeze({
        open: (candidate: unknown) =>
          fakePausedHandoff(
            candidate as OpenProjectionReplayLiveHandoffInput,
            close,
            {
              claim: Object.freeze({
                event_count: 1,
                events: Object.freeze([event]),
                wire_bytes: wireBytes
              }),
              highWater: 1 as OutputCursor,
              replayEventCount: 1,
              replayWireBytes: wireBytes
            }
          )
      }),
      observe_failure: () => undefined,
      resource_budget: defaultResourceBudget
    });

    const stream = service.open(openInput(sessionA, "single-replay-payload"));
    const iterator = stream[Symbol.asyncIterator]();
    const replay = await iterator.next();
    expect(replay).toMatchObject({ done: false, value: { cursor: 1 } });
    expect(replay.value).toBe(event);
    expect(stream.remaining_replay_event_count).toBe(0);
    expect(service.snapshot()).toMatchObject({
      replay_events: 0,
      retained_events: 0
    });

    await iterator.return?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("composes real replay and live handoff without a gap or duplicate", async () => {
    const harness = createHarness();
    harness.state.add(sessionA, [activityEvent(sessionA, 1)]);
    const stream = harness.service.open(openInput(sessionA, "subscriber-replay"));
    expect(Object.isFrozen(stream)).toBe(true);
    expect(stream.replay_event_count).toBe(1);

    harness.publish(activityEvent(sessionA, 2));
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { cursor: 1 }
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { cursor: 2 }
    });
    const pending = iterator.next();
    harness.publish(activityEvent(sessionA, 3));
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { cursor: 3 }
    });

    expect(stream.failure).toBeNull();
    expect(stream.queued_event_count).toBe(0);
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 1,
      queued_events: 0,
      opened_subscribers: 1
    });
    await iterator.return?.();
    expect(stream.state).toBe("closed");
    expect(harness.hub.subscriber_count).toBe(0);
    expect(harness.service.snapshot().active_subscribers).toBe(0);
  });

  it("accounts for replay plus live retention and releases each reference as consumed", async () => {
    const harness = createHarness();
    const replayEvents = [
      activityEvent(sessionA, 1),
      activityEvent(sessionA, 2),
      activityEvent(sessionA, 3)
    ];
    harness.state.add(sessionA, replayEvents);
    const replayWireBytes = replayEvents.reduce(
      (sum, event) => sum + selectedProjectionSseWireByteLength(event),
      0
    );
    const stream = harness.service.open(
      openInput(sessionA, "subscriber-retained-accounting")
    );

    expect(stream).toMatchObject({
      remaining_replay_event_count: 3,
      remaining_replay_wire_bytes: replayWireBytes,
      replay_event_count: 3
    });
    expect(harness.service.snapshot()).toMatchObject({
      peak_replay_events: 3,
      peak_replay_wire_bytes: replayWireBytes,
      peak_retained_events: 3,
      peak_retained_wire_bytes: replayWireBytes,
      replay_events: 3,
      replay_wire_bytes: replayWireBytes,
      retained_events: 3,
      retained_wire_bytes: replayWireBytes
    });

    const live = activityEvent(sessionA, 4);
    const liveWireBytes = selectedProjectionSseWireByteLength(live);
    harness.publish(live);
    expect(harness.service.snapshot()).toMatchObject({
      peak_retained_events: 4,
      peak_retained_wire_bytes: replayWireBytes + liveWireBytes,
      queued_events: 1,
      queued_wire_bytes: liveWireBytes,
      replay_events: 3,
      replay_wire_bytes: replayWireBytes,
      retained_events: 4,
      retained_wire_bytes: replayWireBytes + liveWireBytes
    });

    const iterator = stream[Symbol.asyncIterator]();
    let remainingReplayBytes = replayWireBytes;
    for (const event of replayEvents) {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { cursor: event.cursor }
      });
      remainingReplayBytes -= selectedProjectionSseWireByteLength(event);
      expect(stream).toMatchObject({
        remaining_replay_event_count: replayEvents.length - event.cursor,
        remaining_replay_wire_bytes: remainingReplayBytes
      });
      expect(harness.service.snapshot()).toMatchObject({
        replay_events: replayEvents.length - event.cursor,
        replay_wire_bytes: remainingReplayBytes,
        retained_events: replayEvents.length - event.cursor + 1,
        retained_wire_bytes: remainingReplayBytes + liveWireBytes
      });
    }
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { cursor: 4 }
    });
    expect(harness.service.snapshot()).toMatchObject({
      queued_events: 0,
      queued_wire_bytes: 0,
      replay_events: 0,
      replay_wire_bytes: 0,
      retained_events: 0,
      retained_wire_bytes: 0
    });
    await iterator.return?.();
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 0,
      peak_retained_events: 4,
      peak_retained_wire_bytes: replayWireBytes + liveWireBytes,
      retained_events: 0,
      retained_wire_bytes: 0
    });
  });

  it("closes one count-overflowed slow subscriber without blocking a healthy peer", async () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 4,
      sse_max_subscribers_per_device: 2,
      sse_max_subscribers_per_session: 4,
      sse_queue_max_events: 8,
      sse_replay_max_events: 8
    });
    const harness = createHarness(budget);
    harness.state.add(sessionA, []);
    const slow = harness.service.open(
      openInput(sessionA, "subscriber-slow", "client_slow")
    );
    const healthy = harness.service.open(
      openInput(sessionA, "subscriber-healthy", "client_healthy")
    );
    const healthyIterator = healthy[Symbol.asyncIterator]();

    for (let cursor = 1; cursor <= 8; cursor += 1) {
      const next = healthyIterator.next();
      const startedAt = performance.now();
      harness.publish(activityEvent(sessionA, cursor));
      expect(performance.now() - startedAt).toBeLessThan(50);
      await expect(next).resolves.toMatchObject({
        done: false,
        value: { cursor }
      });
    }

    expect(slow.state).toBe("open");
    expect(slow.queued_event_count).toBe(8);
    const ninth = healthyIterator.next();
    harness.publish(activityEvent(sessionA, 9));
    await expect(ninth).resolves.toMatchObject({
      done: false,
      value: { cursor: 9 }
    });

    expect(slow.state).toBe("failed");
    expect(slow.failure).toEqual({ code: "queue_overflow", cursor: 9 });
    expect(healthy.state).toBe("open");
    expect(harness.failures).toEqual([{ code: "queue_overflow", cursor: 9 }]);
    expect(harness.hub.failure).toBeNull();
    expect(harness.hub.subscriber_count).toBe(1);
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 1,
      overflowed_subscribers: 1,
      queued_events: 0,
      queued_wire_bytes: 0
    });

    const tenth = healthyIterator.next();
    harness.publish(activityEvent(sessionA, 10));
    await expect(tenth).resolves.toMatchObject({ value: { cursor: 10 } });
    await healthyIterator.return?.();
    expect(harness.hub.subscriber_count).toBe(0);
  });

  it("isolates simultaneous stalled subscribers across sessions during a burst", async () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 4,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 2,
      sse_queue_max_events: 8,
      sse_replay_max_events: 8
    });
    const harness = createHarness(budget);
    harness.state.add(sessionA, []);
    harness.state.add(sessionB, []);
    const slowA = harness.service.open(
      openInput(sessionA, "burst-slow-a", "client_burst_slow_a")
    );
    const healthyA = harness.service.open(
      openInput(sessionA, "burst-healthy-a", "client_burst_healthy_a")
    );
    const slowB = harness.service.open(
      openInput(sessionB, "burst-slow-b", "client_burst_slow_b")
    );
    const healthyB = harness.service.open(
      openInput(sessionB, "burst-healthy-b", "client_burst_healthy_b")
    );
    const iteratorA = healthyA[Symbol.asyncIterator]();
    const iteratorB = healthyB[Symbol.asyncIterator]();

    for (let cursor = 1; cursor <= 8; cursor += 1) {
      const nextA = iteratorA.next();
      const nextB = iteratorB.next();
      const startedAt = performance.now();
      harness.publish(activityEvent(sessionA, cursor));
      harness.publish(activityEvent(sessionB, cursor));
      expect(performance.now() - startedAt).toBeLessThan(50);
      await expect(nextA).resolves.toMatchObject({ value: { cursor } });
      await expect(nextB).resolves.toMatchObject({ value: { cursor } });
    }
    expect(slowA.queued_event_count).toBe(8);
    expect(slowB.queued_event_count).toBe(8);
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 4,
      queued_events: 16,
      retained_events: 16
    });

    const ninthA = iteratorA.next();
    const ninthB = iteratorB.next();
    harness.publish(activityEvent(sessionA, 9));
    harness.publish(activityEvent(sessionB, 9));
    await expect(ninthA).resolves.toMatchObject({ value: { cursor: 9 } });
    await expect(ninthB).resolves.toMatchObject({ value: { cursor: 9 } });
    expect(slowA.failure).toEqual({ code: "queue_overflow", cursor: 9 });
    expect(slowB.failure).toEqual({ code: "queue_overflow", cursor: 9 });
    expect(healthyA.state).toBe("open");
    expect(healthyB.state).toBe("open");
    expect(harness.failures).toEqual([
      { code: "queue_overflow", cursor: 9 },
      { code: "queue_overflow", cursor: 9 }
    ]);
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 2,
      overflowed_subscribers: 2,
      peak_queued_events: 16,
      peak_retained_events: 16,
      queued_events: 0,
      retained_events: 0
    });
    expect(harness.hub.failure).toBeNull();

    const tenthA = iteratorA.next();
    const tenthB = iteratorB.next();
    harness.publish(activityEvent(sessionA, 10));
    harness.publish(activityEvent(sessionB, 10));
    await expect(tenthA).resolves.toMatchObject({ value: { cursor: 10 } });
    await expect(tenthB).resolves.toMatchObject({ value: { cursor: 10 } });
    await iteratorA.return?.();
    await iteratorB.return?.();
    expect(harness.hub.subscriber_count).toBe(0);
    expect(harness.service.snapshot()).toMatchObject({
      active_device_buckets: 0,
      active_session_buckets: 0,
      active_subscribers: 0,
      queued_events: 0,
      replay_events: 0,
      retained_events: 0
    });
  });

  it("accepts the exact queue-byte boundary and rejects the first aggregate byte overage", () => {
    const budget = resolveResourceBudget({
      sse_queue_max_bytes: 65_536,
      sse_queue_max_events: 8,
      sse_replay_max_bytes: 65_536,
      sse_replay_max_events: 8
    });
    const harness = createHarness(budget);
    harness.state.add(sessionA, []);
    const stream = harness.service.open(openInput(sessionA, "subscriber-bytes"));

    let exactEvents: readonly SelectedProjectionEvent[] | null = null;
    for (let count = 1; count <= budget.sse_queue_max_events; count += 1) {
      const emptyEvents = Array.from({ length: count }, (_, index) =>
        messageEvent(sessionA, index + 1, "")
      );
      let remainingTextBytes =
        budget.sse_queue_max_bytes -
        emptyEvents.reduce(
          (sum, event) => sum + selectedProjectionSseWireByteLength(event),
          0
        );
      if (remainingTextBytes < 0 || remainingTextBytes > count * 12_000) continue;
      exactEvents = Object.freeze(
        emptyEvents.map((event) => {
          const textBytes = Math.min(12_000, remainingTextBytes);
          remainingTextBytes -= textBytes;
          return messageEvent(sessionA, event.cursor, "x".repeat(textBytes));
        })
      );
      break;
    }
    expect(exactEvents).not.toBeNull();
    const exact = exactEvents ?? [];
    expect(
      exact.reduce(
        (sum, event) => sum + selectedProjectionSseWireByteLength(event),
        0
      )
    ).toBe(budget.sse_queue_max_bytes);
    for (const event of exact) harness.publish(event);
    expect(currentStreamState(stream)).toBe("open");
    expect(stream.queued_event_count).toBe(exact.length);
    expect(stream.queued_wire_bytes).toBe(budget.sse_queue_max_bytes);

    const overflowCursor = exact.length + 1;
    harness.publish(activityEvent(sessionA, overflowCursor));
    expect(stream.failure).toEqual({
      code: "queue_overflow",
      cursor: overflowCursor
    });
    expect(harness.service.snapshot()).toMatchObject({
      queued_events: 0,
      queued_wire_bytes: 0,
      overflowed_subscribers: 1
    });
    expect(harness.hub.failure).toBeNull();
  });

  it("enforces unique, global, paired-device, and session admission with exact release", () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 4,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 2
    });
    const harness = createHarness(budget);
    for (const sessionId of [sessionA, sessionB, sessionC]) {
      harness.state.add(sessionId, []);
    }

    const first = harness.service.open(
      openInput(sessionA, "subscriber-first", "client_device_a")
    );
    expectSubscriberError(
      () =>
        harness.service.open(
          openInput(sessionB, "subscriber-same-device", "client_device_a")
        ),
      "subscriber_device_limit"
    );
    expectSubscriberError(
      () =>
        harness.service.open(
          openInput(sessionB, "subscriber-first", "client_device_b")
        ),
      "subscriber_exists"
    );
    const localA = harness.service.open(openInput(sessionA, "subscriber-local-a"));
    expectSubscriberError(
      () =>
        harness.service.open(
          openInput(sessionA, "subscriber-session-full", "client_device_b")
        ),
      "subscriber_session_limit"
    );
    const deviceB = harness.service.open(
      openInput(sessionB, "subscriber-device-b", "client_device_b")
    );
    const localB = harness.service.open(openInput(sessionB, "subscriber-local-b"));
    expectSubscriberError(
      () => harness.service.open(openInput(sessionC, "subscriber-global-full")),
      "subscriber_global_limit"
    );

    expect(harness.service.snapshot()).toMatchObject({
      active_device_buckets: 2,
      active_session_buckets: 2,
      active_subscribers: 4,
      admission_rejections: 4
    });
    expect(first.close()).toBe(true);
    const replacement = harness.service.open(
      openInput(sessionC, "subscriber-device-a-reused", "client_device_a")
    );
    expect(replacement.state).toBe("open");
    expect(first.close()).toBe(false);
    localA.close();
    deviceB.close();
    localB.close();
    replacement.close();
    expect(harness.service.snapshot()).toMatchObject({
      active_device_buckets: 0,
      active_session_buckets: 0,
      active_subscribers: 0
    });
  });

  it("bounds replay-heavy reconnect storms and reuses every released bucket", async () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 8,
      sse_max_subscribers_per_device: 2,
      sse_max_subscribers_per_session: 4,
      sse_queue_max_events: 8,
      sse_replay_max_events: 8
    });
    const harness = createHarness(budget);
    const eventsA = Array.from({ length: 8 }, (_unused, index) =>
      activityEvent(sessionA, index + 1)
    );
    const eventsB = Array.from({ length: 8 }, (_unused, index) =>
      activityEvent(sessionB, index + 1)
    );
    harness.state.add(sessionA, eventsA);
    harness.state.add(sessionB, eventsB);
    const admitted = Array.from({ length: 8 }, (_unused, index) =>
      harness.service.open(
        openInput(
          index < 4 ? sessionA : sessionB,
          `storm-admitted-${index}`,
          `client_storm_${Math.floor(index / 2)}`
        )
      )
    );
    const expectedReplayBytes =
      4 *
      [...eventsA, ...eventsB].reduce(
        (sum, event) => sum + selectedProjectionSseWireByteLength(event),
        0
      );
    expect(harness.service.snapshot()).toMatchObject({
      active_device_buckets: 4,
      active_session_buckets: 2,
      active_subscribers: 8,
      replay_events: 64,
      replay_wire_bytes: expectedReplayBytes,
      retained_events: 64,
      retained_wire_bytes: expectedReplayBytes
    });

    for (let attempt = 0; attempt < 32; attempt += 1) {
      expectSubscriberError(
        () =>
          harness.service.open(
            openInput(sessionA, `storm-rejected-${attempt}`)
          ),
        "subscriber_global_limit"
      );
    }
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 8,
      admission_rejections: 32,
      replay_events: 64,
      retained_events: 64
    });

    for (const stream of admitted) expect(stream.close()).toBe(true);
    expect(harness.service.snapshot()).toMatchObject({
      active_device_buckets: 0,
      active_session_buckets: 0,
      active_subscribers: 0,
      replay_events: 0,
      replay_wire_bytes: 0,
      retained_events: 0,
      retained_wire_bytes: 0
    });
    expect(harness.hub.subscriber_count).toBe(0);

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const stream = harness.service.open({
        ...openInput(
          attempt % 2 === 0 ? sessionA : sessionB,
          `storm-replacement-${attempt}`,
          `client_replacement_${attempt % 4}`
        ),
        after: 4
      });
      const iterator = stream[Symbol.asyncIterator]();
      for (let consumed = 0; consumed < attempt % 5; consumed += 1) {
        await expect(iterator.next()).resolves.toMatchObject({ done: false });
      }
      expect(stream.close()).toBe(true);
      expect(harness.service.snapshot()).toMatchObject({
        active_device_buckets: 0,
        active_session_buckets: 0,
        active_subscribers: 0,
        queued_events: 0,
        queued_wire_bytes: 0,
        replay_events: 0,
        replay_wire_bytes: 0,
        retained_events: 0,
        retained_wire_bytes: 0
      });
      expect(harness.hub.subscriber_count).toBe(0);
    }
    expect(harness.service.snapshot()).toMatchObject({
      opened_subscribers: 72,
      peak_replay_events: 64,
      peak_replay_wire_bytes: expectedReplayBytes,
      peak_retained_events: 64,
      peak_retained_wire_bytes: expectedReplayBytes
    });
  });

  it("cleans pending readers exactly once on abort, archive, source error, and service close", async () => {
    const harness = createHarness(
      resolveResourceBudget({
        sse_max_subscribers: 4,
        sse_max_subscribers_per_device: 2,
        sse_max_subscribers_per_session: 2
      })
    );
    harness.state.add(sessionA, []);
    harness.state.add(sessionB, []);
    const abortA = new AbortController();
    const addAbortListener = vi.spyOn(abortA.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(abortA.signal, "removeEventListener");
    const streamA = harness.service.open(
      openInput(sessionA, "subscriber-abort", "client_device_a", abortA.signal)
    );
    const streamB = harness.service.open(
      openInput(sessionB, "subscriber-archive", "client_device_b")
    );
    const iteratorA = streamA[Symbol.asyncIterator]();
    const iteratorB = streamB[Symbol.asyncIterator]();
    const pendingA = iteratorA.next();
    const pendingB = iteratorB.next();

    abortA.abort(new Error("private revoke reason"));
    await expect(pendingA).resolves.toEqual({ done: true, value: undefined });
    expect(streamA.state).toBe("closed");
    expect(addAbortListener).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(harness.service.archive_session(sessionB)).toBe(1);
    await expect(pendingB).rejects.toMatchObject({ code: "session_archived" });
    expect(streamB.failure).toEqual({ code: "session_archived", cursor: null });
    expect(harness.service.archive_session(sessionB)).toBe(0);

    harness.state.add(sessionC, []);
    const source = harness.service.open(openInput(sessionC, "subscriber-source"));
    const sourceIterator = source[Symbol.asyncIterator]();
    await expect(sourceIterator.throw?.(new Error("private source failure"))).rejects.toMatchObject({
      code: "source_failed"
    });
    expect(source.failure).toEqual({ code: "source_failed", cursor: null });

    const remaining = harness.service.open(
      openInput(sessionA, "subscriber-service-close")
    );
    const remainingIterator = remaining[Symbol.asyncIterator]();
    const pendingRemaining = remainingIterator.next();
    expect(harness.service.close()).toBe(1);
    await expect(pendingRemaining).resolves.toEqual({ done: true, value: undefined });
    expect(harness.service.close()).toBe(0);
    expectSubscriberError(
      () => harness.service.open(openInput(sessionA, "subscriber-after-close")),
      "service_closed"
    );
    expect(harness.service.snapshot()).toMatchObject({
      aborted_subscribers: 1,
      active_subscribers: 0,
      archived_subscribers: 1,
      closed: true,
      service_closed_subscribers: 1,
      source_failed_subscribers: 1
    });
    expect(JSON.stringify(harness.failures)).not.toContain("private");
    expect(harness.hub.subscriber_count).toBe(0);
    addAbortListener.mockRestore();
    removeAbortListener.mockRestore();
  });

  it("clears mixed replay, queue, pending-read, and device ownership on aggregate close", async () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 6,
      sse_max_subscribers_per_device: 2,
      sse_max_subscribers_per_session: 3,
      sse_queue_max_events: 8,
      sse_replay_max_events: 8
    });
    const harness = createHarness(budget);
    harness.state.add(
      sessionA,
      Array.from({ length: 4 }, (_unused, index) =>
        activityEvent(sessionA, index + 1)
      )
    );
    harness.state.add(
      sessionB,
      Array.from({ length: 4 }, (_unused, index) =>
        activityEvent(sessionB, index + 1)
      )
    );
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const streams = controllers.map((controller, index) =>
      harness.service.open(
        openInput(
          index < 3 ? sessionA : sessionB,
          `shutdown-mixed-${index}`,
          `client_shutdown_${index % 3}`,
          controller.signal
        )
      )
    );
    const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());

    await iterators[1]?.next();
    await iterators[4]?.next();
    for (const index of [2, 5]) {
      for (let replay = 0; replay < 4; replay += 1) {
        await iterators[index]?.next();
      }
    }
    const pendingA = iterators[2]?.next();
    const pendingB = iterators[5]?.next();
    harness.publish(activityEvent(sessionA, 5));
    harness.publish(activityEvent(sessionB, 5));
    await expect(pendingA).resolves.toMatchObject({ value: { cursor: 5 } });
    await expect(pendingB).resolves.toMatchObject({ value: { cursor: 5 } });
    const closingPendingA = iterators[2]?.next();
    const closingPendingB = iterators[5]?.next();
    expect(harness.service.snapshot()).toMatchObject({
      active_device_buckets: 3,
      active_session_buckets: 2,
      active_subscribers: 6,
      queued_events: 4,
      replay_events: 14,
      retained_events: 18
    });

    controllers[1]?.abort(new Error("private revoke A"));
    controllers[4]?.abort(new Error("private revoke B"));
    expect(harness.service.close()).toBe(4);
    await expect(closingPendingA).resolves.toEqual({ done: true, value: undefined });
    await expect(closingPendingB).resolves.toEqual({ done: true, value: undefined });
    expect(harness.service.close()).toBe(0);
    expect(harness.service.snapshot()).toMatchObject({
      aborted_subscribers: 2,
      active_device_buckets: 0,
      active_session_buckets: 0,
      active_subscribers: 0,
      closed: true,
      queued_events: 0,
      queued_wire_bytes: 0,
      replay_events: 0,
      replay_wire_bytes: 0,
      retained_events: 0,
      retained_wire_bytes: 0,
      service_closed_subscribers: 4
    });
    expect(harness.hub.subscriber_count).toBe(0);
    expect(harness.failures).toEqual([]);
  });

  it("wakes and fails a pending reader when the shared fanout source stops", async () => {
    const harness = createHarness();
    harness.state.add(sessionA, []);
    const stream = harness.service.open(openInput(sessionA, "subscriber-fanout-loss"));
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    expect(harness.hub.close()).toBe(1);
    await expect(pending).rejects.toMatchObject({ code: "source_failed" });
    expect(stream).toMatchObject({
      failure: { code: "source_failed", cursor: null },
      state: "failed"
    });
    expect(harness.failures).toEqual([{ code: "source_failed", cursor: null }]);
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 0,
      queued_events: 0,
      source_failed_subscribers: 1
    });
  });

  it("closes an opening subscriber when archive races durable high-water", () => {
    const harness = createHarness();
    harness.state.add(sessionA, []);
    harness.state.onRequire = () => {
      expect(harness.service.archive_session(sessionA)).toBe(1);
    };

    expectSubscriberError(
      () => harness.service.open(openInput(sessionA, "subscriber-opening-archive")),
      "session_archived"
    );
    expect(harness.service.snapshot()).toMatchObject({
      active_subscribers: 0,
      archived_subscribers: 1,
      source_open_failures: 1
    });
    expect(harness.hub.subscriber_count).toBe(0);
  });

  it("closes a noncooperative handoff returned after opening termination", () => {
    const close = vi.fn(() => true);
    let service!: ProjectionSubscriberStreamService;
    const handoff = Object.freeze({
      open(candidate: unknown) {
        const input = candidate as OpenProjectionReplayLiveHandoffInput;
        expect(service.archive_session(sessionA)).toBe(1);
        return fakePausedHandoff(input, close);
      }
    });
    service = createProjectionSubscriberStreamService({
      handoff,
      observe_failure: () => undefined,
      resource_budget: defaultResourceBudget
    });

    expectSubscriberError(
      () => service.open(openInput(sessionA, "subscriber-late-handoff")),
      "session_archived"
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toMatchObject({
      active_subscribers: 0,
      archived_subscribers: 1,
      source_open_failures: 1
    });
  });

  it("releases owned state and reports a bounded failure when handoff close throws", () => {
    const failures: ProjectionSubscriberFailure[] = [];
    const close = vi.fn(() => {
      throw new Error("private handoff close failure");
    });
    const service = createProjectionSubscriberStreamService({
      handoff: Object.freeze({
        open: (candidate: unknown) =>
          fakePausedHandoff(
            candidate as OpenProjectionReplayLiveHandoffInput,
            close
          )
      }),
      observe_failure: (failure) => failures.push(failure),
      resource_budget: defaultResourceBudget
    });
    const stream = service.open(openInput(sessionA, "subscriber-close-failure"));

    expect(stream.close()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stream.state).toBe("closed");
    expect(failures).toEqual([{ code: "source_failed", cursor: null }]);
    expect(service.snapshot()).toMatchObject({
      active_device_buckets: 0,
      active_session_buckets: 0,
      active_subscribers: 0,
      explicit_closures: 1,
      source_failed_subscribers: 1
    });
    expect(JSON.stringify(failures)).not.toContain("private");
  });

  it("contains hostile failure observers and concurrent iterator ownership", async () => {
    const state = new MemoryProjectionState();
    state.add(sessionA, []);
    const hub = createProjectionFanoutHub();
    const handoff = createProjectionReplayLiveHandoffService({
      authorize: () => ({ ok: true }),
      fanout: hub,
      resource_budget: defaultResourceBudget,
      state
    });
    const service = createProjectionSubscriberStreamService({
      handoff,
      observe_failure: (() => Promise.reject(new Error("observer secret"))) as never,
      resource_budget: defaultResourceBudget
    });
    const stream = service.open(openInput(sessionA, "subscriber-iterator"));
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    expect(() => stream[Symbol.asyncIterator]()).toThrowError(
      expect.objectContaining({ code: "concurrent_iteration" })
    );
    await expect(pending).rejects.toMatchObject({ code: "concurrent_iteration" });
    await Promise.resolve();
    expect(service.snapshot()).toMatchObject({
      active_subscribers: 0,
      observer_failures: 1,
      source_failed_subscribers: 1
    });
    expect(hub.failure).toBeNull();
  });
});

interface Harness {
  readonly failures: ProjectionSubscriberFailure[];
  readonly hub: ProjectionFanoutHub;
  readonly publish: (event: SelectedProjectionEvent) => void;
  readonly service: ProjectionSubscriberStreamService;
  readonly state: MemoryProjectionState;
}

interface MemorySession {
  archived: boolean;
  events: SelectedProjectionEvent[];
  highWater: number | null;
}

class MemoryProjectionState {
  readonly sessions = new Map<string, MemorySession>();
  onRequire: (() => void) | null = null;

  add(sessionId: string, events: readonly SelectedProjectionEvent[]): void {
    this.sessions.set(sessionId, {
      archived: false,
      events: [...events],
      highWater: events.at(-1)?.cursor ?? null
    });
  }

  append(event: SelectedProjectionEvent): void {
    const session = this.requireMemory(event.session_id);
    if (event.cursor !== (session.highWater ?? 0) + 1) {
      throw new Error("Test projection cursor is not contiguous.");
    }
    session.events.push(event);
    session.highWater = event.cursor;
  }

  require(sessionId: string): SelectedSessionState {
    this.onRequire?.();
    return selectedState(sessionId, this.requireMemory(sessionId));
  }

  listEvents(
    sessionId: string,
    input: { readonly after?: number | null; readonly limit?: number } = {}
  ): SelectedSessionEventStream {
    const session = this.requireMemory(sessionId);
    const after = input.after ?? null;
    if (after !== null && after > (session.highWater ?? 0)) {
      throw new HostDeckSelectedStateRepositoryError(
        "invalid_replay",
        "Future replay cursor."
      );
    }
    const events = session.events
      .filter((event) => after === null || event.cursor > after)
      .slice(0, input.limit ?? 500);
    return {
      events,
      next_cursor: events.at(-1)?.cursor ?? session.highWater ?? 0,
      session_id: sessionId,
      truncated: false
    } as SelectedSessionEventStream;
  }

  private requireMemory(sessionId: string): MemorySession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new HostDeckSelectedStateRepositoryError(
        "session_not_found",
        "Missing test session."
      );
    }
    return session;
  }
}

function createHarness(
  resourceBudget: ResourceBudget = defaultResourceBudget
): Harness {
  const state = new MemoryProjectionState();
  const hub = createProjectionFanoutHub({
    max_subscribers: resourceBudget.sse_max_subscribers,
    max_subscribers_per_session:
      resourceBudget.sse_max_subscribers_per_session
  });
  const handoff = createProjectionReplayLiveHandoffService({
    authorize: () => ({ ok: true }),
    fanout: hub,
    resource_budget: resourceBudget,
    state
  });
  const failures: ProjectionSubscriberFailure[] = [];
  const service = createProjectionSubscriberStreamService({
    handoff,
    observe_failure(failure) {
      failures.push(failure);
    },
    resource_budget: resourceBudget
  });
  return {
    failures,
    hub,
    publish(event) {
      state.append(event);
      hub.publish(committedCandidate(event));
    },
    service,
    state
  };
}

function openInput(
  sessionId: string,
  subscriberId: string,
  deviceId: string | null = null,
  signal: AbortSignal = new AbortController().signal
) {
  return {
    after: null,
    authorization: Object.freeze({ allowed: true }),
    device_id: deviceId,
    session_id: sessionId,
    signal,
    subscriber_id: subscriberId
  };
}

function fakePausedHandoff(
  input: OpenProjectionReplayLiveHandoffInput,
  close: () => boolean,
  options: {
    readonly claim?: unknown;
    readonly highWater?: OutputCursor | null;
    readonly replayEventCount?: number;
    readonly replayWireBytes?: number;
  } = {}
): ProjectionReplayLiveHandoff {
  let claimed = false;
  return Object.freeze({
    activate: () =>
      Object.freeze({ drained_event_count: 0, live_after_cursor: null }),
    after: input.after as OutputCursor | null,
    claim_replay: () => {
      if (claimed) throw new Error("Replay already claimed.");
      claimed = true;
      if (options.claim !== undefined) return options.claim as never;
      return Object.freeze({
        event_count: 0,
        events: Object.freeze([]),
        wire_bytes: 0
      });
    },
    close,
    get failure() {
      return null;
    },
    high_water_cursor: options.highWater ?? null,
    observed_fanout_cursor: null,
    get paused_event_count() {
      return 0;
    },
    get paused_wire_bytes() {
      return 0;
    },
    replay_event_count: options.replayEventCount ?? 0,
    replay_wire_bytes: options.replayWireBytes ?? 0,
    session_id: input.session_id,
    signal: new AbortController().signal,
    get state() {
      return "paused" as const;
    },
    subscriber_id: input.subscriber_id,
    truncated: false
  });
}

function activityEvent(sessionId: string, cursor: number): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    activity: "thread",
    captured_at: eventAt(cursor),
    codex_event_id: `event-${sessionId}-${cursor}`,
    codex_event_type: "thread/status/changed",
    content_notice: null,
    content_state: "complete",
    cursor,
    detail: null,
    item_id: null,
    session_id: sessionId,
    state: "updated",
    title: "Thread state updated",
    type: "activity",
    upstream_at: null
  });
}

function messageEvent(
  sessionId: string,
  cursor: number,
  text: string
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    captured_at: eventAt(cursor),
    codex_event_id: `event-${sessionId}-${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_notice: null,
    content_state: "complete",
    cursor,
    item_id: `item-${cursor}`,
    phase: "delta",
    role: "agent",
    session_id: sessionId,
    text,
    type: "message",
    upstream_at: null
  });
}

function selectedState(
  sessionId: string,
  memory: MemorySession
): SelectedSessionState {
  const updatedAt = eventAt(memory.highWater ?? 0);
  const retainedBytes = memory.events.reduce(
    (sum, event) => sum + selectedProjectedEventByteLength(event),
    0
  );
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      archived_at: memory.archived ? updatedAt : null,
      codex_thread_id: `thread-${sessionId}`,
      created_at: createdAt,
      cwd: `/tmp/${sessionId}`,
      disposition: "selected",
      id: sessionId,
      name: sessionId,
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      updated_at: updatedAt
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      earliest_retained_cursor: memory.events[0]?.cursor ?? null,
      retained_event_bytes: retainedBytes,
      retained_event_count: memory.events.length,
      retention_boundary_cursor: null,
      session: {
        archived_at: memory.archived ? updatedAt : null,
        attention: "none",
        branch: null,
        codex_thread_id: `thread-${sessionId}`,
        created_at: createdAt,
        cwd: `/tmp/${sessionId}`,
        freshness: "current",
        freshness_reason: null,
        goal: null,
        id: sessionId,
        last_activity_at: memory.highWater === null ? null : updatedAt,
        last_event_cursor: memory.highWater,
        model: null,
        name: sessionId,
        recent_summary: "Subscriber test projection.",
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        session_state: memory.archived ? "archived" : "active",
        turn_state: "idle",
        updated_at: updatedAt
      }
    })
  };
}

function committedCandidate(event: SelectedProjectionEvent) {
  const byteLength = selectedProjectedEventByteLength(event);
  return deepFreeze({
    event: { byte_length: byteLength, event },
    projection: {
      earliest_retained_cursor: 1,
      retained_event_bytes: byteLength * event.cursor,
      retained_event_count: event.cursor,
      retention_boundary_cursor: null,
      session: {
        archived_at: null,
        attention: "none",
        branch: null,
        codex_thread_id: `thread-${event.session_id}`,
        created_at: createdAt,
        cwd: `/tmp/${event.session_id}`,
        freshness: "current",
        freshness_reason: null,
        goal: null,
        id: event.session_id,
        last_activity_at: event.captured_at,
        last_event_cursor: event.cursor,
        model: null,
        name: event.session_id,
        recent_summary: `Committed cursor ${event.cursor}.`,
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        session_state: "active",
        turn_state: "idle",
        updated_at: event.captured_at
      }
    },
    revision: {
      last_event_cursor: event.cursor,
      mapping_updated_at: createdAt,
      projection_updated_at: event.captured_at
    }
  });
}

function expectSubscriberError(
  operation: () => unknown,
  code: ProjectionSubscriberErrorCode
): HostDeckProjectionSubscriberError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckProjectionSubscriberError);
  expect((caught as HostDeckProjectionSubscriberError).code).toBe(code);
  return caught as HostDeckProjectionSubscriberError;
}

function eventAt(cursor: number): string {
  return new Date(Date.parse(createdAt) + cursor * 1_000).toISOString();
}

function currentStreamState(stream: ProjectionSubscriberStream) {
  return stream.state;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
