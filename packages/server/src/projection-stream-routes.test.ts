import { type ClientRequest, get as httpGet, type IncomingMessage } from "node:http";
import {
  defaultResourceBudget,
  resolveResourceBudget,
  type SelectedProjectionEvent,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import type { OutputCursor } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  createHostDeckFastifyApp,
  hostDeckFastifyResourceSnapshot
} from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import type { HostDeckSseFailureObservation } from "./fastify-sse-transport.js";
import {
  HostDeckProjectionHandoffError,
  type OpenProjectionReplayLiveHandoffInput,
  type ProjectionHandoffFailure,
  type ProjectionReplayLiveHandoff,
  type ProjectionReplayLiveHandoffService
} from "./projection-replay-live-handoff.js";
import {
  createHostDeckProjectionStreamRouteRegistration,
  hostDeckProjectionStreamRouteRegistrationId
} from "./projection-stream-routes.js";
import {
  createProjectionSubscriberStreamService,
  type ProjectionSubscriberFailure,
  type ProjectionSubscriberStreamService
} from "./projection-subscriber-stream.js";

const sessionId = "sess_projection_stream_route";
const timestamp = "2026-07-16T15:00:00.000Z";
const deviceToken = "D".repeat(43);
const deviceId = "client_projection_stream_route";

const loopbackTrust = createHostDeckRequestTrustPolicy({
  allowedOrigins: ["http://localhost"],
  mode: "loopback",
  transport: "http"
});

describe("selected projection event-stream route", () => {
  it("requires exact branded composition and the frozen selected manifest row", () => {
    const fixture = createFixture();
    const registration = createHostDeckProjectionStreamRouteRegistration({
      observe_error: () => undefined,
      subscribers: fixture.subscribers
    });
    expect(registration.id).toBe(hostDeckProjectionStreamRouteRegistrationId);
    expect(registration.surface).toBe("sse");
    expect(Object.isFrozen(registration)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "subscribers", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private route accessor");
      }
    });
    for (const candidate of [
      null,
      {},
      { observe_error: () => undefined, subscribers: fixture.subscribers, extra: true },
      { observe_error: undefined, subscribers: fixture.subscribers },
      { observe_error: () => undefined, subscribers: {} },
      accessor
    ]) {
      expect(() =>
        createHostDeckProjectionStreamRouteRegistration(candidate as never)
      ).toThrow();
    }
    expect(accessorCalls).toBe(0);
  });

  it("streams framed replay through the Readable path and releases local admission", async () => {
    const fixture = createFixture([projectionEvent(1, "replayed")]);
    const app = createApp(fixture.subscribers, fixture.failures);
    await app.ready();
    try {
      const pending = app.inject({
        headers: { accept: "text/event-stream" },
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events/stream`
      });
      await waitUntil(() => fixture.subscribers.snapshot().active_subscribers === 1);
      expect(fixture.subscribers.snapshot()).toMatchObject({
        active_device_buckets: 0,
        active_subscribers: 1
      });
      fixture.subscribers.close();
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream");
      expect(response.body).toContain("id: 1\nevent: message\ndata: ");
      expect(response.body).toContain('"text":"replayed"');
      expect(fixture.handoff.openInputs[0]).toMatchObject({
        after: null,
        session_id: sessionId,
        subscriber_id: expect.stringMatching(/^stream:req_/u)
      });
      expect(fixture.handoff.openInputs[0]?.authorization).toMatchObject({
        state: "unpaired",
        device_id: null
      });
      expect(fixture.failures).toEqual([]);
      expect(fixture.subscribers.snapshot().active_subscribers).toBe(0);
      await waitUntil(() => hostDeckFastifyResourceSnapshot(app).in_flight_requests === 0);
    } finally {
      await app.close();
    }
  });

  it("derives the paired-device bucket only from authenticated cookie authority", async () => {
    const fixture = createFixture();
    let authenticationPolicy: HostDeckRequestAuthenticationPolicy | undefined;
    const app = createApp(
      fixture.subscribers,
      fixture.failures,
      true,
      defaultResourceBudget,
      (policy) => {
        authenticationPolicy = policy;
      }
    );
    await app.ready();
    try {
      const pending = app.inject({
        headers: {
          accept: "text/event-stream",
          cookie: `${hostDeckDeviceCookieName}=${deviceToken}`
        },
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events/stream`
      });
      await waitUntil(() => fixture.subscribers.snapshot().active_subscribers === 1);
      expect(fixture.subscribers.snapshot()).toMatchObject({
        active_device_buckets: 1,
        active_subscribers: 1
      });
      expect(fixture.handoff.openInputs[0]?.authorization).toMatchObject({
        state: "paired_device",
        device_id: deviceId
      });
      expect(authenticationPolicy?.activeDeviceAuthority.invalidate(deviceId)).toMatchObject({
        closedLeases: 1
      });
      expect((await pending).statusCode).toBe(200);
      expect(fixture.subscribers.snapshot()).toMatchObject({
        aborted_subscribers: 1,
        active_device_buckets: 0,
        active_subscribers: 0
      });
    } finally {
      await app.close();
    }
  });

  it("preserves authentication, source, session, cursor, and capacity errors", async () => {
    const invalidAuth = createFixture();
    const invalidAuthApp = createApp(invalidAuth.subscribers, invalidAuth.failures);
    await invalidAuthApp.ready();
    try {
      const response = await invalidAuthApp.inject({
        headers: {
          accept: "text/event-stream",
          cookie: `${hostDeckDeviceCookieName}=invalid`
        },
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events/stream`
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "permission_denied" }
      });
      expect(invalidAuth.handoff.openInputs).toHaveLength(0);
    } finally {
      await invalidAuthApp.close();
    }

    for (const testCase of [
      { code: "authorization_failed" as const, status: 403, publicCode: "permission_denied" },
      { code: "session_not_found" as const, status: 404, publicCode: "session_not_found" },
      { code: "session_archived" as const, status: 409, publicCode: "stale_session" },
      { code: "future_cursor" as const, status: 409, publicCode: "stale_session" },
      { code: "replay_limit" as const, status: 503, publicCode: "service_overloaded" },
      { code: "storage_unavailable" as const, status: 500, publicCode: "storage_error" }
    ]) {
      const fixture = createFixture();
      fixture.handoff.nextError = testCase.code;
      const app = createApp(fixture.subscribers, fixture.failures);
      await app.ready();
      try {
        const response = await app.inject({
          headers: { accept: "text/event-stream" },
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/events/stream${
            testCase.code === "future_cursor" ? "?after=9" : ""
          }`
        });
        expect(response.statusCode).toBe(testCase.status);
        expect(response.json()).toMatchObject({
          error: { code: testCase.publicCode }
        });
        if (testCase.code === "future_cursor") {
          expect(response.json()).toMatchObject({
            error: { field: "after" }
          });
        }
        expect(fixture.subscribers.snapshot().active_subscribers).toBe(0);
      } finally {
        await app.close();
      }
    }

    const budget = resolveResourceBudget({
      sse_max_subscribers: 1,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 1
    });
    const capacity = createFixture([], budget);
    const capacityApp = createApp(capacity.subscribers, capacity.failures, false, budget);
    await capacityApp.ready();
    try {
      const first = capacityApp.inject({
        headers: { accept: "text/event-stream" },
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events/stream`
      });
      await waitUntil(() => capacity.subscribers.snapshot().active_subscribers === 1);
      const second = await capacityApp.inject({
        headers: { accept: "text/event-stream" },
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events/stream`
      });
      expect(second.statusCode).toBe(503);
      expect(second.json()).toMatchObject({
        error: { code: "service_overloaded" }
      });
      capacity.subscribers.close();
      expect((await first).statusCode).toBe(200);
    } finally {
      await capacityApp.close();
    }
  });

  it("actively terminates a real paused client when its live queue overflows", async () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 2,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 2,
      sse_queue_max_events: 8,
      sse_replay_max_events: 8
    });
    const fixture = createFixture([], budget);
    const app = createApp(fixture.subscribers, fixture.failures, false, budget);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    try {
      const opened = openPausedResponse(
        `${address}/api/v1/sessions/${sessionId}/events/stream`
      );
      request = opened.request;
      await waitUntil(() => fixture.subscribers.snapshot().active_subscribers === 1);
      fixture.handoff.publish(projectionEvent(1, "first"));
      response = await opened.response;
      const clientEnded = new Promise<void>((resolve) => {
        response?.once("end", resolve);
        response?.once("close", resolve);
      });

      for (let cursor = 2; cursor <= 11; cursor += 1) {
        const startedAt = performance.now();
        fixture.handoff.publish(projectionEvent(cursor, "queued"));
        expect(performance.now() - startedAt).toBeLessThan(50);
      }
      await waitUntil(() => fixture.subscribers.snapshot().active_subscribers === 0);
      await waitUntil(() => hostDeckFastifyResourceSnapshot(app).in_flight_requests === 0);

      expect(fixture.subscribers.snapshot()).toMatchObject({
        active_subscribers: 0,
        overflowed_subscribers: 1,
        queued_events: 0,
        queued_wire_bytes: 0
      });
      expect(fixture.subscriberFailures).toHaveLength(1);
      expect(fixture.subscriberFailures[0]).toMatchObject({ code: "queue_overflow" });
      expect(fixture.failures).toEqual([]);
      response.resume();
      await withTimeout(clientEnded, 1_000, "overflowed client response");
    } finally {
      response?.destroy();
      request?.destroy();
      await app.close();
    }
  });

  it("releases the queue and handoff once after a real client disconnect", async () => {
    const fixture = createFixture();
    const app = createApp(fixture.subscribers, fixture.failures);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    try {
      const opened = openPausedResponse(
        `${address}/api/v1/sessions/${sessionId}/events/stream`
      );
      request = opened.request;
      await waitUntil(() => fixture.subscribers.snapshot().active_subscribers === 1);
      fixture.handoff.publish(projectionEvent(1, "disconnect"));
      response = await opened.response;
      response.destroy();
      request.destroy();
      await waitUntil(() => fixture.subscribers.snapshot().active_subscribers === 0);
      await waitUntil(() => hostDeckFastifyResourceSnapshot(app).in_flight_requests === 0);

      expect(fixture.subscribers.snapshot()).toMatchObject({
        aborted_subscribers: 1,
        active_device_buckets: 0,
        active_session_buckets: 0,
        active_subscribers: 0,
        queued_events: 0,
        queued_wire_bytes: 0
      });
      expect(fixture.failures).toEqual([]);
      expect(fixture.handoff.activeSinkCount).toBe(0);
    } finally {
      response?.destroy();
      request?.destroy();
      await app.close();
    }
  });
});

class FakeHandoffService implements ProjectionReplayLiveHandoffService {
  readonly openInputs: OpenProjectionReplayLiveHandoffInput[] = [];
  nextError:
    | "authorization_failed"
    | "future_cursor"
    | "replay_limit"
    | "session_archived"
    | "session_not_found"
    | "storage_unavailable"
    | null = null;
  private liveSink: ((event: SelectedProjectionEvent) => void) | null = null;

  get activeSinkCount(): number {
    return this.liveSink === null ? 0 : 1;
  }

  constructor(private readonly replayEvents: readonly SelectedProjectionEvent[]) {}

  publish(event: SelectedProjectionEvent): void {
    this.liveSink?.(event);
  }

  open(candidate: unknown): ProjectionReplayLiveHandoff {
    const input = candidate as OpenProjectionReplayLiveHandoffInput;
    this.openInputs.push(input);
    if (this.nextError !== null) {
      const code = this.nextError;
      this.nextError = null;
      throw new HostDeckProjectionHandoffError(code, "Bounded fake handoff failure.");
    }
    let closed = false;
    let live = false;
    let sink: ((event: SelectedProjectionEvent) => void) | null = null;
    const thisService = this;
    const lifecycleController = new AbortController();
    const replayEvents = Object.freeze([...this.replayEvents]);
    const highWater = (replayEvents.at(-1)?.cursor ?? input.after) as
      | OutputCursor
      | null;
    return Object.freeze({
      activate(activation: unknown) {
        sink = (activation as { on_event: (event: SelectedProjectionEvent) => void }).on_event;
        thisService.liveSink = sink;
        live = true;
        return Object.freeze({
          drained_event_count: 0,
          live_after_cursor: highWater
        });
      },
      after: input.after as OutputCursor | null,
      close() {
        if (closed) return false;
        closed = true;
        sink = null;
        thisService.liveSink = null;
        lifecycleController.abort(new Error("Fake handoff closed."));
        return true;
      },
      failure: null as ProjectionHandoffFailure | null,
      high_water_cursor: highWater,
      observed_fanout_cursor: null,
      paused_event_count: 0,
      paused_wire_bytes: 0,
      replay_event_count: replayEvents.length,
      replay_events: replayEvents,
      replay_wire_bytes: 0,
      session_id: input.session_id,
      signal: lifecycleController.signal,
      get state() {
        return closed ? "closed" : live ? "live" : "paused";
      },
      subscriber_id: input.subscriber_id,
      truncated: false
    });
  }
}

function createFixture(
  replayEvents: readonly SelectedProjectionEvent[] = [],
  resourceBudget = defaultResourceBudget
) {
  const handoff = new FakeHandoffService(replayEvents);
  const failures: HostDeckSseFailureObservation[] = [];
  const subscriberFailures: ProjectionSubscriberFailure[] = [];
  const subscribers = createProjectionSubscriberStreamService({
    handoff: Object.freeze({ open: (candidate: unknown) => handoff.open(candidate) }),
    observe_failure(failure) {
      subscriberFailures.push(failure);
    },
    resource_budget: resourceBudget
  });
  return { failures, handoff, subscriberFailures, subscribers };
}

function createApp(
  subscribers: ProjectionSubscriberStreamService,
  failures: HostDeckSseFailureObservation[],
  paired = false,
  resourceBudget = defaultResourceBudget,
  captureAuthenticationPolicy?: (policy: HostDeckRequestAuthenticationPolicy) => void
) {
  const requestAuthenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: ({ rawDeviceToken }) => {
      if (!paired || rawDeviceToken !== deviceToken) {
        throw new Error("Unknown test device token.");
      }
      return authenticatedDevice();
    },
    now: () => new Date(timestamp)
  });
  captureAuthenticationPolicy?.(requestAuthenticationPolicy);
  return createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy,
    requestTrustPolicy: loopbackTrust,
    resourceBudget,
    routePlugins: [
      createHostDeckProjectionStreamRouteRegistration({
        observe_error: (failure) => failures.push(failure),
        subscribers
      })
    ]
  });
}

function authenticatedDevice() {
  return {
    device: {
      client_label: "Projection stream phone",
      created_at: timestamp,
      csrf_generation: 1,
      csrf_rotated_at: timestamp,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      expires_at: null,
      id: deviceId,
      last_used_at: timestamp,
      permission: "read" as const,
      revoked_at: null,
      token_hash: `sha256:${"a".repeat(64)}`
    },
    readOnly: true,
    trusted: true as const
  };
}

function projectionEvent(cursor: number, text: string): SelectedProjectionEvent {
  return Object.freeze(selectedProjectionEventSchema.parse({
    captured_at: timestamp,
    codex_event_id: `event-${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_notice: null,
    content_state: "complete",
    cursor,
    item_id: null,
    phase: "delta",
    role: "agent",
    session_id: sessionId,
    text,
    type: "message",
    upstream_at: null
  }));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function openPausedResponse(url: string): {
  readonly request: ClientRequest;
  readonly response: Promise<IncomingMessage>;
} {
  let resolveResponse!: (response: IncomingMessage) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpGet(url, {
    headers: { accept: "text/event-stream", host: "localhost" }
  });
  request.once("error", rejectResponse);
  request.once("response", (incoming) => {
    incoming.pause();
    resolveResponse(incoming);
  });
  return { request, response };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
