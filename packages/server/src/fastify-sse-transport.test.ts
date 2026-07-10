import { readFileSync } from "node:fs";
import { type ClientRequest, get as httpGet, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import {
  defaultResourceBudget,
  type ResourceBudget,
  resolveResourceBudget,
  type SelectedProjectionEvent,
  selectedProjectionEventSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHostDeckFastifyApp, hostDeckFastifyResourceSnapshot } from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  createHostDeckSseTransportRegistration,
  type HostDeckSseFailureObservation,
  type HostDeckSseSourceInput
} from "./fastify-sse-transport.js";

const sessionId = "sess_sse_transport_01";

describe("bounded Fastify SSE transport", () => {
  it("fails composition for missing source/observer, invalid paths, or unvalidated route parameters", () => {
    const base = {
      id: "strict-events",
      observeError: () => undefined,
      path: "/api/events" as const,
      source: { open: () => finiteEvents([]) }
    };
    const registration = createHostDeckSseTransportRegistration(base);
    expect(Object.isFrozen(registration)).toBe(true);
    expect(registration.surface).toBe("sse");

    expect(() =>
      createHostDeckSseTransportRegistration({
        ...base,
        source: undefined
      } as unknown as Parameters<typeof createHostDeckSseTransportRegistration>[0])
    ).toThrow("HostDeck SSE transport requires an event source.");
    expect(() =>
      createHostDeckSseTransportRegistration({
        ...base,
        observeError: undefined
      } as unknown as Parameters<typeof createHostDeckSseTransportRegistration>[0])
    ).toThrow("HostDeck SSE transport requires an error observer.");
    expect(() =>
      createHostDeckSseTransportRegistration({
        ...base,
        path: "/api/events/:session_id"
      })
    ).toThrow("HostDeck SSE parameterized routes require a Zod params schema.");
    expect(() =>
      createHostDeckSseTransportRegistration({
        ...base,
        path: "/api/../events"
      })
    ).toThrow("HostDeck SSE transport route path is invalid.");
  });

  it("reconciles query and Last-Event-ID cursors and emits cursor-bearing selected events", async () => {
    const opened: HostDeckSseSourceInput[] = [];
    const failures: HostDeckSseFailureObservation[] = [];
    const internal: HostDeckInternalErrorObservation[] = [];
    const events = [projectionEvent(1, "one"), projectionEvent(2, "two"), projectionEvent(3, "three")];
    const source = {
      open(input: HostDeckSseSourceInput) {
        opened.push(input);
        return finiteEvents(events.filter((event) => input.after === null || event.cursor > input.after));
      }
    };
    const app = createSseApp(source, failures, internal);
    await app.ready();

    try {
      const query = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events?after=1`,
        headers: { accept: "text/event-stream" }
      });
      expect(query.statusCode).toBe(200);
      expect(query.headers["content-type"]).toBe("text/event-stream");
      expect(query.body).not.toContain("id: 1\n");
      expect(query.body).toContain("id: 2\nevent: message\ndata: ");
      expect(query.body).toContain("id: 3\nevent: message\ndata: ");
      expect(query.body).toContain('"text":"two"');
      expect(opened[0]?.after).toBe(1);
      expect(opened[0]?.params).toEqual({ session_id: sessionId });
      expect(opened[0]?.signal).toBe(opened[0]?.request.signal);

      const header = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events`,
        headers: { accept: "text/event-stream", "last-event-id": "2" }
      });
      expect(header.statusCode).toBe(200);
      expect(header.body).toContain("id: 3\n");
      expect(header.body).not.toContain("id: 2\n");
      expect(opened[1]?.after).toBe(2);

      const identical = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events?after=2`,
        headers: { accept: "text/event-stream", "last-event-id": "2" }
      });
      expect(identical.statusCode).toBe(200);
      expect(opened[2]?.after).toBe(2);

      const empty = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events?after=3`,
        headers: { accept: "text/event-stream" }
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.headers["content-type"]).toBe("text/event-stream");
      expect(empty.body).toBe("");
      expect(opened[3]?.after).toBe(3);

      const conflicting = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events?after=1`,
        headers: { accept: "text/event-stream", "last-event-id": "2" }
      });
      expectError(conflicting, 400, "validation_error", "after");
      expect(opened).toHaveLength(4);

      const malformedHeader = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events`,
        headers: { accept: "text/event-stream", "last-event-id": "01" }
      });
      expectError(malformedHeader, 400, "validation_error", "last-event-id");

      const malformedQuery = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events?after=01`,
        headers: { accept: "text/event-stream" }
      });
      expectError(malformedQuery, 400, "validation_error", "query");

      const unknownQuery = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events?cursor=1`,
        headers: { accept: "text/event-stream" }
      });
      expectError(unknownQuery, 400, "validation_error", "query");

      const refused = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events`,
        headers: { accept: "application/json" }
      });
      expectError(refused, 406, "not_acceptable");
      expect(opened).toHaveLength(4);

      const explicitlyRefused = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events`,
        headers: { accept: "*/*, text/event-stream;q=0" }
      });
      expectError(explicitlyRefused, 406, "not_acceptable");
      expect(opened).toHaveLength(4);

      const wildcard = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events`
      });
      expect(wildcard.statusCode).toBe(200);
      expect(opened.at(-1)?.after).toBeNull();

      const weighted = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events?after=2`,
        headers: { accept: "application/json, text/event-stream;q=0.5" }
      });
      expect(weighted.statusCode).toBe(200);
      expect(opened.at(-1)?.after).toBe(2);

      expect(failures).toEqual([]);
      expect(internal).toEqual([]);
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("uses the configured heartbeat while a finite Readable-backed source is idle", async () => {
    const budget = resolveResourceBudget({ sse_heartbeat_interval_ms: 1_000 });
    const app = createSseApp(
      {
        open: () =>
          (async function* () {
            yield projectionEvent(1, "before-heartbeat");
            await wait(1_100);
            yield projectionEvent(2, "after-heartbeat");
          })()
      },
      [],
      [],
      budget
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events`,
        headers: { accept: "text/event-stream" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("id: 1");
      expect(response.body).toContain(": heartbeat");
      expect(response.body).toContain("id: 2");
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("observes open, iteration, validation, size, and cleanup failures without leaking source details", async () => {
    const failures: HostDeckSseFailureObservation[] = [];
    const finalized: string[] = [];
    const budget = resolveResourceBudget({ sse_event_max_bytes: 1_024 });
    const source = {
      open(input: HostDeckSseSourceInput): AsyncIterable<unknown> {
        const mode = (input.params as { mode: string }).mode;
        if (mode === "open") throw new Error("secret-open-failure");
        if (mode === "invalid") return finiteEvents([{}], () => finalized.push(mode));
        if (mode === "wrong_session") {
          return finiteEvents(
            [{ ...projectionEvent(1, "wrong-session"), session_id: "sess_sse_transport_02" }],
            () => finalized.push(mode)
          );
        }
        if (mode === "order") {
          return finiteEvents(
            [projectionEvent(2, "first-cursor"), projectionEvent(2, "duplicate-cursor")],
            () => finalized.push(mode)
          );
        }
        if (mode === "oversized") {
          return finiteEvents([projectionEvent(1, "x".repeat(2_000))], () => finalized.push(mode));
        }
        return (async function* () {
          try {
            yield projectionEvent(1, "before-source-failure");
            throw new Error("secret-source-failure");
          } finally {
            finalized.push(mode);
          }
        })();
      }
    };
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      resourceBudget: budget,
      routePlugins: [
        createHostDeckSseTransportRegistration({
          id: "failure-events",
          observeError: (failure) => failures.push(failure),
          paramsSchema: sessionIdParamsSchema.extend({
            mode: z.enum(["open", "invalid", "wrong_session", "order", "oversized", "source"])
          }),
          path: "/api/sessions/:session_id/events/:mode",
          source
        })
      ]
    });
    await app.ready();

    try {
      const open = await withTestTimeout(eventRequest(app, "open"), 1_000, "open failure response");
      expectError(open, 500, "internal_error");
      expect(open.body).not.toContain("secret-open-failure");

      const invalid = await withTestTimeout(eventRequest(app, "invalid"), 1_000, "invalid event response");
      expect(invalid.statusCode).toBe(200);
      expect(invalid.body).not.toContain("ZodError");

      const wrongSession = await withTestTimeout(
        eventRequest(app, "wrong_session"),
        1_000,
        "wrong-session event response"
      );
      expect(wrongSession.statusCode).toBe(200);
      expect(wrongSession.body).not.toContain("sess_sse_transport_02");

      const invalidOrder = await withTestTimeout(
        eventRequest(app, "order"),
        1_000,
        "invalid cursor order response"
      );
      expect(invalidOrder.statusCode).toBe(200);
      expect(invalidOrder.body.match(/id: 2\n/gu)).toHaveLength(1);

      const oversized = await withTestTimeout(eventRequest(app, "oversized"), 1_000, "oversized event response");
      expect(oversized.statusCode).toBe(200);
      expect(oversized.body).not.toContain("x".repeat(200));

      const sourceFailure = await withTestTimeout(eventRequest(app, "source"), 1_000, "source failure response");
      expect(sourceFailure.statusCode).toBe(200);
      expect(sourceFailure.body).toContain("before-source-failure");
      expect(sourceFailure.body).not.toContain("secret-source-failure");

      expect(failures.map((failure) => failure.code)).toEqual([
        "source_open_failed",
        "invalid_event",
        "invalid_event",
        "invalid_cursor_order",
        "event_too_large",
        "source_iteration_failed"
      ]);
      expect(failures[0]?.error.cause).toMatchObject({ message: "secret-open-failure" });
      expect(finalized.sort()).toEqual(["invalid", "order", "oversized", "source", "wrong_session"]);
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("stops a cooperative source under real paused-client backpressure", async () => {
    const disconnected = deferred<void>();
    let produced = 0;
    let sourceFinalized = false;
    let sourceObservedAbort = false;
    let sourceSignalMatches = false;
    const app = createSseApp(
      {
        open(input) {
          sourceSignalMatches = input.signal === input.request.signal;
          input.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
          return (async function* () {
            try {
              while (!input.signal.aborted && produced < 10_000) {
                produced += 1;
                yield projectionEvent(produced, "x".repeat(8_000));
              }
            } finally {
              sourceObservedAbort = input.signal.aborted;
              sourceFinalized = true;
            }
          })();
        }
      },
      [],
      []
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;

    try {
      ({ request, response } = await openPausedResponse(`${address}/api/sessions/${sessionId}/events`));
      await wait(30);
      response.destroy();
      request.destroy();
      await withTestTimeout(disconnected.promise, 1_000, "request abort");
      await withTestTimeout(waitUntil(() => sourceFinalized), 1_000, "source finalization");
      await withTestTimeout(
        waitUntil(() => hostDeckFastifyResourceSnapshot(app).in_flight_requests === 0),
        1_000,
        "handler settlement"
      );

      expect(sourceSignalMatches).toBe(true);
      expect(sourceObservedAbort).toBe(true);
      expect(produced).toBeGreaterThan(0);
      expect(produced).toBeLessThan(10_000);
    } finally {
      response?.destroy();
      request?.destroy();
      await app.close();
    }
  });

  it("bounds a noncooperative iterator return after real disconnect", async () => {
    const failures: HostDeckSseFailureObservation[] = [];
    let returnCalls = 0;
    let requestSignal: AbortSignal | undefined;
    const budget = resolveResourceBudget({ sse_disconnect_cleanup_timeout_ms: 50 });
    const app = createSseApp(
      {
        open(input) {
          requestSignal = input.signal;
          let first = true;
          const iterator: AsyncIterableIterator<unknown> = {
            [Symbol.asyncIterator]() {
              return iterator;
            },
            next() {
              if (first) {
                first = false;
                return Promise.resolve({ done: false as const, value: projectionEvent(1, "first") });
              }
              return new Promise<IteratorResult<unknown>>(() => undefined);
            },
            return() {
              returnCalls += 1;
              return new Promise<IteratorResult<unknown>>(() => undefined);
            }
          };
          return iterator;
        }
      },
      failures,
      [],
      budget
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;

    try {
      ({ request, response } = await openPausedResponse(`${address}/api/sessions/${sessionId}/events`));
      response.destroy();
      request.destroy();
      await withTestTimeout(
        waitUntil(() => failures.some((failure) => failure.code === "source_cleanup_timeout")),
        1_000,
        "cleanup timeout observation"
      );
      await withTestTimeout(
        waitUntil(() => hostDeckFastifyResourceSnapshot(app).in_flight_requests === 0),
        1_000,
        "bounded handler settlement"
      );

      expect(requestSignal?.aborted).toBe(true);
      expect(returnCalls).toBe(1);
      expect(failures.map((failure) => failure.code)).toEqual(["source_cleanup_timeout"]);
    } finally {
      response?.destroy();
      request?.destroy();
      await app.close();
    }
  });

  it("keeps the plugin direct-AsyncIterable send path structurally absent", () => {
    const registrationSource = readFileSync(
      fileURLToPath(new URL("./fastify-sse-transport.ts", import.meta.url)),
      "utf8"
    );
    const lifecycleSource = readFileSync(
      fileURLToPath(new URL("./fastify-sse-source.ts", import.meta.url)),
      "utf8"
    );
    expect(registrationSource.match(/\.sse\.send\(/gu)).toHaveLength(1);
    expect(registrationSource).toContain("await reply.sse.send(readable);");
    expect(lifecycleSource).toContain(
      "Readable.from(managedSseMessages(input), { highWaterMark: 1, objectMode: true })"
    );
  });
});

function createSseApp(
  source: { readonly open: (input: HostDeckSseSourceInput) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> },
  failures: HostDeckSseFailureObservation[],
  internal: HostDeckInternalErrorObservation[],
  resourceBudget: ResourceBudget = defaultResourceBudget
) {
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => internal.push(observation),
    resourceBudget,
    routePlugins: [
      createHostDeckSseTransportRegistration({
        id: "session-events",
        observeError: (failure) => failures.push(failure),
        paramsSchema: sessionIdParamsSchema,
        path: "/api/sessions/:session_id/events",
        source
      })
    ]
  });
}

function projectionEvent(cursor: number, text: string): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    captured_at: "2026-07-09T08:00:00.000Z",
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
  });
}

async function* finiteEvents(
  events: readonly unknown[],
  finalized: () => void = () => undefined
): AsyncGenerator<unknown> {
  try {
    for (const event of events) yield event;
  } finally {
    finalized();
  }
}

async function eventRequest(
  app: ReturnType<typeof createSseApp>,
  mode: string
) {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/events/${mode}`,
    headers: { accept: "text/event-stream" }
  });
}

function expectError(
  response: Awaited<ReturnType<ReturnType<typeof createSseApp>["inject"]>>,
  status: number,
  code: string,
  field?: string
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.json()).toMatchObject({
    error: {
      code,
      details: { request_id: response.headers["x-request-id"] },
      retryable: false,
      ...(field !== undefined ? { field } : {})
    }
  });
}

async function openPausedResponse(url: string): Promise<{
  request: ClientRequest;
  response: IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers: { accept: "text/event-stream" } });
    request.once("error", reject);
    request.once("response", (response) => {
      response.pause();
      response.once("readable", () => resolve({ request, response }));
    });
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await wait(5);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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
