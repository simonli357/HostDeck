import {
  type SelectedProjectionEvent,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import {
  type BrowserSseClientLimits,
  defaultBrowserSseClientLimits
} from "@hostdeck/contracts/browser-sse-resource-policy";
import { describe, expect, it } from "vitest";
import {
  type BrowserSseBodyReaderPort,
  type BrowserSseClockPort,
  type BrowserSseRequestInit,
  type BrowserSseResponsePort,
  createBrowserSseClient
} from "./sse-client.js";

const origin = "http://127.0.0.1:5173";
const remoteOrigin = "https://hostdeck-client.fixture-tailnet.ts.net";
const sessionId = "sess_browser_sse_001";
const timestamp = "2026-07-22T12:00:00.000Z";

describe("bounded browser SSE client", () => {
  it("uses the exact selected same-origin request and delivers an immutable event", async () => {
    const clock = new ManualClock();
    const reader = new ControlledReader();
    const requests: Array<{ path: string; init: BrowserSseRequestInit }> = [];
    const delivered: SelectedProjectionEvent[] = [];
    const client = createBrowserSseClient({
      origin,
      clock: clock.port,
      fetch: async (path, init) => {
        requests.push({ path, init });
        return sseResponse(reader);
      }
    });
    const connection = client.connect({
      sessionId,
      onEvent(event) {
        delivered.push(event);
      }
    });

    await waitFor(() => requests.length === 1);
    reader.pushText(eventFrame(messageEvent(1, "hello")));
    await waitFor(() => connection.snapshot().cursor === 1);

    expect(requests[0]?.path).toBe(
      `/api/v1/sessions/${sessionId}/events/stream`
    );
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "cache-control": "no-store"
      },
      cache: "no-store",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(delivered).toHaveLength(1);
    expect(Object.isFrozen(delivered[0])).toBe(true);
    expect(connection.snapshot()).toMatchObject({
      phase: "connected",
      cursor: 1,
      continuity: "contiguous",
      retryCount: 0,
      failure: null
    });
    expect(Object.isFrozen(connection.snapshot())).toBe(true);
    expect(JSON.stringify(requests[0])).not.toContain(origin);

    connection.close("route_changed");
    expect(connection.snapshot()).toMatchObject({
      phase: "closed",
      closeReason: "route_changed"
    });
    expect(reader.cancelCalls).toBe(1);
    expect(reader.releaseCalls).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("rejects hostile constructor/connect inputs, duplicates, and capacity before fetch", async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "origin", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return origin;
      }
    });
    expect(() => createBrowserSseClient(hostile)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
    expect(() =>
      createBrowserSseClient({
        origin,
        fetch: async () => sseResponse(new ControlledReader()),
        extra: true
      } as never)
    ).toThrow(TypeError);
    expect(() =>
      createBrowserSseClient({
        origin,
        fetch: async () => sseResponse(new ControlledReader()),
        clock: {
          now: () => -1,
          setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
          clearTimeout: (handle) =>
            clearTimeout(handle as ReturnType<typeof setTimeout>)
        }
      })
    ).toThrow(TypeError);

    let fetches = 0;
    const client = createBrowserSseClient({
      origin,
      limits: selectedLimits({ maxConcurrentStreams: 1 }),
      fetch: async () => {
        fetches += 1;
        return sseResponse(new ControlledReader());
      }
    });
    const first = client.connect({ sessionId, onEvent() {} });
    expect(() => client.connect({ sessionId, onEvent() {} })).toThrow(
      "already has an active connection"
    );
    expect(() =>
      client.connect({
        sessionId: "sess_browser_sse_002",
        onEvent() {}
      })
    ).toThrow("capacity is exhausted");
    expect(() =>
      client.connect({
        sessionId,
        onEvent() {},
        after: 0,
        extra: true
      } as never)
    ).toThrow(TypeError);
    first.close();
    client.close();
    expect(() => client.connect({ sessionId, onEvent() {} })).toThrow(
      "client is closed"
    );
    await settle();
    expect(fetches).toBe(0);
  });

  it("rejects every malformed connection field and limit before fetch", async () => {
    let fetches = 0;
    let getterCalls = 0;
    const client = createBrowserSseClient({
      origin,
      fetch: async () => {
        fetches += 1;
        return sseResponse(new ControlledReader());
      }
    });
    const accessor = Object.defineProperty({}, "sessionId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return sessionId;
      }
    });
    for (const candidate of [
      accessor,
      { sessionId: "../private", onEvent() {} },
      { sessionId, after: -1, onEvent() {} },
      { sessionId, after: 1.5, onEvent() {} },
      { sessionId, signal: { aborted: false }, onEvent() {} },
      { sessionId, onEvent: null },
      { sessionId, onEvent() {}, onState: 1 }
    ]) {
      expect(() => client.connect(candidate as never)).toThrow(TypeError);
    }
    for (const limits of [
      selectedLimits({ eventMaxBytes: 1_000 }),
      { ...defaultBrowserSseClientLimits, extra: 1 },
      selectedLimits({
        reconnectInitialDelayMs: 5_000,
        reconnectMaxDelayMs: 100
      })
    ]) {
      expect(() =>
        createBrowserSseClient({
          origin,
          limits: limits as BrowserSseClientLimits,
          fetch: async () => {
            fetches += 1;
            return sseResponse(new ControlledReader());
          }
        })
      ).toThrow(TypeError);
    }
    await settle();
    expect(fetches).toBe(0);
    expect(getterCalls).toBe(0);
  });

  it("closes a pre-aborted connection without reserving capacity or fetching", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetches = 0;
    const client = createBrowserSseClient({
      origin,
      fetch: async () => {
        fetches += 1;
        return sseResponse(new ControlledReader());
      }
    });
    const connection = client.connect({
      sessionId,
      signal: controller.signal,
      onEvent() {}
    });
    expect(connection.snapshot()).toMatchObject({
      phase: "closed",
      closeReason: "caller_aborted"
    });
    const active = client.connect({
      sessionId,
      onEvent() {}
    });
    await waitFor(() => fetches === 1);
    active.close();
  });

  it("accepts a first replay boundary and keeps discontinuity visible", async () => {
    const reader = new ControlledReader();
    const delivered: number[] = [];
    const connection = createBrowserSseClient({
      origin: remoteOrigin,
      fetch: async () => sseResponse(reader)
    }).connect({
      sessionId,
      after: 5,
      onEvent(event) {
        delivered.push(event.cursor);
      }
    });
    await settle();
    reader.pushText(
      eventFrame(boundaryEvent(9, 5, "retention")) +
        eventFrame(messageEvent(10, "after boundary"))
    );
    await waitFor(() => connection.snapshot().cursor === 10);
    expect(delivered).toEqual([9, 10]);
    expect(connection.snapshot()).toMatchObject({
      transport: "https",
      continuity: "boundary",
      boundary: {
        after: 5,
        cursor: 9,
        reason: "retention"
      }
    });
    expect(Object.isFrozen(connection.snapshot().boundary)).toBe(true);

    reader.pushText(eventFrame(boundaryEvent(11, 10, "restart")));
    await waitFor(() => connection.snapshot().phase === "failed");
    expect(connection.snapshot()).toMatchObject({
      cursor: 10,
      continuity: "boundary",
      failure: { reason: "invalid_event" }
    });
  });

  it("delivers every selected non-boundary projection event type", async () => {
    const reader = new ControlledReader();
    const delivered: string[] = [];
    const connection = createBrowserSseClient({
      origin,
      fetch: async () => sseResponse(reader)
    }).connect({
      sessionId,
      onEvent(event) {
        delivered.push(event.type);
      }
    });
    await settle();
    const events = selectedEventVariants();
    reader.pushText(events.map((event) => eventFrame(event)).join(""));
    await waitFor(() => connection.snapshot().cursor === events.length);
    expect(delivered).toEqual([
      "message",
      "turn",
      "activity",
      "approval",
      "control",
      "runtime",
      "unknown_optional"
    ]);
    connection.close();
  });

  it.each([
    ["duplicate", [messageEvent(1), messageEvent(1)], "duplicate_event"],
    ["out of order", [messageEvent(1), messageEvent(0)], "out_of_order_event"],
    ["unmarked gap", [messageEvent(1), messageEvent(3)], "cursor_gap"]
  ] as const)(
    "fails a %s without advancing past the committed cursor",
    async (_label, events, reason) => {
      const reader = new ControlledReader();
      const connection = createBrowserSseClient({
        origin,
        fetch: async () => sseResponse(reader)
      }).connect({ sessionId, onEvent() {} });
      await settle();
      reader.pushText(events.map((event) => eventFrame(event)).join(""));
      await waitFor(() => connection.snapshot().phase === "failed");
      expect(connection.snapshot()).toMatchObject({
        cursor: 1,
        failure: { reason }
      });
    }
  );

  it.each([
    ["retry field", "retry: 1\n\n", "malformed_stream"],
    ["unknown comment", ": keepalive\n\n", "malformed_stream"],
    ["incomplete frame", "id: 1\n", "malformed_stream"],
    [
      "invalid event payload",
      "id: 1\nevent: message\ndata: {}\n\n",
      "invalid_event"
    ],
    [
      "mismatched event id",
      eventFrame(messageEvent(1), { id: "2" }),
      "invalid_event"
    ],
    [
      "mismatched event name",
      eventFrame(messageEvent(1), { name: "runtime" }),
      "invalid_event"
    ],
    [
      "mismatched session",
      eventFrame(
        selectedProjectionEventSchema.parse({
          ...messageEvent(1),
          session_id: "sess_browser_sse_other"
        })
      ),
      "invalid_event"
    ]
  ] as const)("fails a %s terminally", async (_label, wire, reason) => {
    const clock = new ManualClock();
    const reader = new ControlledReader();
    reader.pushText(wire);
    reader.end();
    const connection = createBrowserSseClient({
      origin,
      clock: clock.port,
      fetch: async () => sseResponse(reader)
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => connection.snapshot().phase === "failed");
    expect(connection.snapshot().failure?.reason).toBe(reason);
    expect(clock.pendingCount).toBe(0);
  });

  it("fails fatal UTF-8 and an oversized partial frame", async () => {
    for (const bytes of [
      new Uint8Array([0xff]),
      new TextEncoder().encode("x".repeat(1_025))
    ]) {
      const reader = new ControlledReader();
      reader.pushBytes(bytes);
      const connection = createBrowserSseClient({
        origin,
        limits: selectedLimits({ eventMaxBytes: 1_024 }),
        fetch: async () => sseResponse(reader)
      }).connect({ sessionId, onEvent() {} });
      await waitFor(() => connection.snapshot().phase === "failed");
      expect(connection.snapshot().failure?.reason).toBe("malformed_stream");
    }
  });

  it("uses deterministic capped reconnects and stops exactly at exhaustion", async () => {
    const clock = new ManualClock(1_000);
    let fetches = 0;
    const connection = createBrowserSseClient({
      origin,
      clock: clock.port,
      limits: selectedLimits({
        maxReconnectAttempts: 2,
        reconnectInitialDelayMs: 500,
        reconnectMaxDelayMs: 10_000
      }),
      fetch: async () => {
        fetches += 1;
        throw new Error("private transport detail");
      }
    }).connect({ sessionId, onEvent() {} });

    await waitFor(() => connection.snapshot().phase === "reconnecting");
    expect(connection.snapshot()).toMatchObject({
      retryCount: 1,
      retryAt: 1_500,
      failure: { reason: "transport_unavailable" }
    });
    clock.advance(499);
    await settle();
    expect(fetches).toBe(1);
    clock.advance(1);
    await waitFor(() => fetches === 2 && connection.snapshot().retryCount === 2);
    expect(connection.snapshot().retryAt).toBe(2_500);
    clock.advance(1_000);
    await waitFor(() => connection.snapshot().phase === "failed");
    expect(fetches).toBe(3);
    expect(connection.snapshot().failure).toMatchObject({
      reason: "reconnect_exhausted",
      previousReason: "transport_unavailable",
      status: null,
      apiError: null
    });
    expect(clock.pendingCount).toBe(0);
    expect(JSON.stringify(connection.snapshot())).not.toContain(
      "private transport detail"
    );
  });

  it("resets retry backoff on liveness and reconnects from the committed cursor", async () => {
    const clock = new ManualClock();
    const firstReader = new ControlledReader();
    const secondReader = new ControlledReader();
    const paths: string[] = [];
    let attempt = 0;
    const connection = createBrowserSseClient({
      origin,
      clock: clock.port,
      fetch: async (path) => {
        paths.push(path);
        attempt += 1;
        if (attempt === 1) throw new Error("first transport failure");
        return sseResponse(attempt === 2 ? firstReader : secondReader);
      }
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => connection.snapshot().retryCount === 1);
    clock.advance(500);
    await waitFor(() => connection.snapshot().phase === "connected");
    firstReader.pushText(eventFrame(messageEvent(1)));
    await waitFor(() => connection.snapshot().cursor === 1);
    expect(connection.snapshot().retryCount).toBe(0);

    firstReader.end();
    await waitFor(() => connection.snapshot().phase === "reconnecting");
    expect(connection.snapshot()).toMatchObject({
      retryCount: 1,
      retryAt: 1_000
    });
    clock.advance(500);
    await waitFor(() => paths.length === 3);
    expect(paths).toEqual([
      `/api/v1/sessions/${sessionId}/events/stream`,
      `/api/v1/sessions/${sessionId}/events/stream`,
      `/api/v1/sessions/${sessionId}/events/stream?after=1`
    ]);
    connection.close();
  });

  it("times out a connect, cancels a late response, and never leaks its reader", async () => {
    const clock = new ManualClock();
    const lateReader = new ControlledReader();
    let resolveFetch!: (response: BrowserSseResponsePort) => void;
    const fetchPromise = new Promise<BrowserSseResponsePort>((resolve) => {
      resolveFetch = resolve;
    });
    const connection = createBrowserSseClient({
      origin,
      clock: clock.port,
      limits: selectedLimits({
        connectTimeoutMs: 1_000,
        reconnectInitialDelayMs: 50,
        maxReconnectAttempts: 1
      }),
      fetch: async () => fetchPromise
    }).connect({ sessionId, onEvent() {} });
    await settle();
    clock.advance(1_000);
    await waitFor(() => connection.snapshot().phase === "reconnecting");
    expect(connection.snapshot().failure?.reason).toBe("connect_timeout");

    resolveFetch(sseResponse(lateReader));
    await waitFor(() => lateReader.releaseCalls === 1);
    expect(lateReader.cancelCalls).toBe(1);
    connection.close();
    clock.advance(1_000);
    await settle();
    expect(connection.snapshot().phase).toBe("closed");
  });

  it("does not treat arbitrary bytes as liveness and reconnects on idle", async () => {
    const clock = new ManualClock(1_000);
    const reader = new ControlledReader();
    const connection = createBrowserSseClient({
      origin,
      clock: clock.port,
      limits: selectedLimits({ idleTimeoutMs: 5_000 }),
      fetch: async () => sseResponse(reader)
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => connection.snapshot().phase === "connected");
    clock.advance(4_000);
    reader.pushText("id");
    await settle();
    clock.advance(1_000);
    await waitFor(() => connection.snapshot().phase === "reconnecting");
    expect(connection.snapshot().failure?.reason).toBe("idle_timeout");
    expect(reader.cancelCalls).toBe(1);
    expect(reader.releaseCalls).toBe(1);
    connection.close();
  });

  it("resets idle and consecutive failures only on an exact heartbeat", async () => {
    const clock = new ManualClock(1_000);
    const reader = new ControlledReader();
    const connection = createBrowserSseClient({
      origin,
      clock: clock.port,
      limits: selectedLimits({ idleTimeoutMs: 5_000 }),
      fetch: async () => sseResponse(reader)
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => connection.snapshot().phase === "connected");
    clock.advance(4_000);
    reader.pushText(": heartbeat\n\n");
    await waitFor(() => connection.snapshot().lastHeartbeatAt === 5_000);
    expect(connection.snapshot().continuity).toBe("contiguous");
    clock.advance(4_999);
    await settle();
    expect(connection.snapshot().phase).toBe("connected");
    clock.advance(1);
    await waitFor(() => connection.snapshot().phase === "reconnecting");
    connection.close();
  });

  it("validates bounded API errors and retries only when the envelope allows it", async () => {
    const terminal = createBrowserSseClient({
      origin,
      fetch: async () =>
        jsonResponse(403, {
          error: {
            code: "permission_denied",
            message: "Pairing is required.",
            retryable: false
          }
        })
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => terminal.snapshot().phase === "failed");
    expect(terminal.snapshot().failure).toMatchObject({
      reason: "api_error",
      status: 403,
      apiError: {
        code: "permission_denied",
        retryable: false
      }
    });
    expect(Object.isFrozen(terminal.snapshot().failure?.apiError)).toBe(true);

    const clock = new ManualClock();
    const retrying = createBrowserSseClient({
      origin,
      clock: clock.port,
      fetch: async () =>
        jsonResponse(503, {
          error: {
            code: "service_overloaded",
            message: "Try again.",
            retryable: true
          }
        })
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => retrying.snapshot().phase === "reconnecting");
    expect(retrying.snapshot().failure).toMatchObject({
      reason: "api_error",
      status: 503,
      apiError: { retryable: true }
    });
    retrying.close();
  });

  it("rejects malformed and oversized error responses without retry", async () => {
    const cases: Array<{
      response: BrowserSseResponsePort;
      reason: string;
    }> = [
      {
        response: textResponse(403, "not json", "text/plain"),
        reason: "invalid_response"
      },
      {
        response: textResponse(403, "{}", "application/json"),
        reason: "invalid_response"
      },
      {
        response: textResponse(
          503,
          "x",
          "application/json",
          { "content-length": "1025" }
        ),
        reason: "response_too_large"
      }
    ];
    for (const testCase of cases) {
      const connection = createBrowserSseClient({
        origin,
        limits: selectedLimits({ errorResponseMaxBytes: 1_024 }),
        fetch: async () => testCase.response
      }).connect({ sessionId, onEvent() {} });
      await waitFor(() => connection.snapshot().phase === "failed");
      expect(connection.snapshot().failure?.reason).toBe(testCase.reason);
    }
  });

  it("accepts an exact-cap error body and rejects streamed overflow", async () => {
    const envelope = JSON.stringify({
      error: {
        code: "permission_denied",
        message: "Pairing is required.",
        retryable: false
      }
    });
    const exact = `${envelope}${" ".repeat(1_024 - envelope.length)}`;
    const exactConnection = createBrowserSseClient({
      origin,
      limits: selectedLimits({ errorResponseMaxBytes: 1_024 }),
      fetch: async () =>
        textResponse(401, exact, "application/json", {
          "content-length": "1024"
        })
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => exactConnection.snapshot().phase === "failed");
    expect(exactConnection.snapshot().failure?.reason).toBe("api_error");

    const overflowReader = new ControlledReader();
    overflowReader.pushText(exact);
    overflowReader.pushText(" ");
    overflowReader.end();
    const overflowConnection = createBrowserSseClient({
      origin,
      limits: selectedLimits({ errorResponseMaxBytes: 1_024 }),
      fetch: async () =>
        response(503, overflowReader, {
          "content-type": "application/json"
        })
    }).connect({ sessionId, onEvent() {} });
    await waitFor(() => overflowConnection.snapshot().phase === "failed");
    expect(overflowConnection.snapshot().failure?.reason).toBe(
      "response_too_large"
    );
  });

  it("rejects invalid success status, media type, and body without retry", async () => {
    const invalidResponses: BrowserSseResponsePort[] = [
      textResponse(200, "event", "text/plain"),
      {
        status: 200,
        ok: true,
        headers: { get: () => "text/event-stream" },
        body: null
      },
      jsonResponse(204, {
        error: {
          code: "internal_error",
          message: "Invalid success status.",
          retryable: false
        }
      })
    ];
    for (const invalidResponse of invalidResponses) {
      const connection = createBrowserSseClient({
        origin,
        fetch: async () => invalidResponse
      }).connect({ sessionId, onEvent() {} });
      await waitFor(() => connection.snapshot().phase === "failed");
      expect(connection.snapshot().failure?.reason).toBe("invalid_response");
    }
  });

  it("does not commit a cursor when event or state consumers violate synchronous ports", async () => {
    const eventReader = new ControlledReader();
    const eventConnection = createBrowserSseClient({
      origin,
      fetch: async () => sseResponse(eventReader)
    }).connect({
      sessionId,
      onEvent: async () => {
        throw new Error("private consumer detail");
      }
    });
    await settle();
    eventReader.pushText(eventFrame(messageEvent(1)));
    await waitFor(() => eventConnection.snapshot().phase === "failed");
    expect(eventConnection.snapshot()).toMatchObject({
      cursor: null,
      failure: { reason: "consumer_error" }
    });

    let fetches = 0;
    const stateConnection = createBrowserSseClient({
      origin,
      fetch: async () => {
        fetches += 1;
        return sseResponse(new ControlledReader());
      }
    }).connect({
      sessionId,
      onEvent() {},
      onState() {
        throw new Error("private observer detail");
      }
    });
    await settle();
    expect(fetches).toBe(0);
    expect(stateConnection.snapshot().failure?.reason).toBe("consumer_error");
  });

  it("cancels active reads and backoff on caller, unmount, and client close", async () => {
    const clock = new ManualClock();
    const reader = new ControlledReader();
    const controller = new AbortController();
    const client = createBrowserSseClient({
      origin,
      clock: clock.port,
      fetch: async () => sseResponse(reader)
    });
    const caller = client.connect({
      sessionId,
      signal: controller.signal,
      onEvent() {}
    });
    await waitFor(() => caller.snapshot().phase === "connected");
    controller.abort();
    expect(caller.snapshot()).toMatchObject({
      phase: "closed",
      closeReason: "caller_aborted"
    });
    expect(reader.cancelCalls).toBe(1);

    const unmounted = client.connect({
      sessionId,
      onEvent() {}
    });
    await settle();
    unmounted.close("unmounted");
    expect(unmounted.snapshot().closeReason).toBe("unmounted");

    const another = client.connect({
      sessionId: "sess_browser_sse_002",
      onEvent() {}
    });
    await settle();
    client.close();
    expect(another.snapshot()).toMatchObject({
      phase: "closed",
      closeReason: "client_closed"
    });
    expect(clock.pendingCount).toBe(0);
  });
});

class ManualClock {
  readonly port: BrowserSseClockPort;
  private value: number;
  private sequence = 0;
  private readonly timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  constructor(value = 0) {
    this.value = value;
    this.port = Object.freeze({
      now: () => this.now(),
      setTimeout: (callback: () => void, delayMs: number) =>
        this.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => this.clearTimeout(handle)
    });
  }

  now(): number {
    return this.value;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = ++this.sequence;
    this.timers.set(handle, { at: this.value + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(delayMs: number): void {
    const target = this.value + delayMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) =>
          left[1].at === right[1].at
            ? left[0] - right[0]
            : left[1].at - right[1].at
        )[0];
      if (due === undefined) break;
      this.value = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.value = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

class ControlledReader implements BrowserSseBodyReaderPort {
  private readonly queued: Array<
    | { readonly done: false; readonly value: Uint8Array }
    | { readonly done: true }
  > = [];
  private readonly waiting: Array<
    (value: { readonly done: boolean; readonly value?: Uint8Array }) => void
  > = [];
  cancelCalls = 0;
  releaseCalls = 0;

  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> {
    const next = this.queued.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    while (this.waiting.length > 0) this.waiting.shift()?.({ done: true });
  }

  releaseLock(): void {
    this.releaseCalls += 1;
  }

  pushText(value: string): void {
    this.pushBytes(new TextEncoder().encode(value));
  }

  pushBytes(value: Uint8Array): void {
    const next = { done: false as const, value };
    const waiting = this.waiting.shift();
    if (waiting === undefined) this.queued.push(next);
    else waiting(next);
  }

  end(): void {
    const next = { done: true as const };
    const waiting = this.waiting.shift();
    if (waiting === undefined) this.queued.push(next);
    else waiting(next);
  }
}

function sseResponse(reader: ControlledReader): BrowserSseResponsePort {
  return response(200, reader, { "content-type": "text/event-stream" });
}

function jsonResponse(status: number, value: unknown): BrowserSseResponsePort {
  return textResponse(status, JSON.stringify(value), "application/json");
}

function textResponse(
  status: number,
  value: string,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): BrowserSseResponsePort {
  const reader = new ControlledReader();
  reader.pushText(value);
  reader.end();
  return response(status, reader, {
    "content-type": contentType,
    ...extraHeaders
  });
}

function response(
  status: number,
  reader: ControlledReader,
  headers: Readonly<Record<string, string>>
): BrowserSseResponsePort {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      }
    },
    body: {
      getReader() {
        return reader;
      }
    }
  };
}

function messageEvent(
  cursor: number,
  text = `message-${cursor}`
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: null,
    text
  });
}

function selectedEventVariants(): SelectedProjectionEvent[] {
  const base = (cursor: number) => ({
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete" as const,
    content_notice: null
  });
  return [
    messageEvent(1),
    selectedProjectionEventSchema.parse({
      ...base(2),
      type: "turn",
      turn_id: "turn-browser-sse-1",
      state: "completed",
      error: null
    }),
    selectedProjectionEventSchema.parse({
      ...base(3),
      type: "activity",
      activity: "tool",
      state: "updated",
      item_id: null,
      title: "Tool activity",
      detail: null
    }),
    selectedProjectionEventSchema.parse({
      ...base(4),
      type: "approval",
      request_id: "request-browser-sse-1",
      state: "pending",
      action: "Run command",
      scope: "workspace",
      reason: null,
      risk: "normal",
      expires_at: null,
      decision: null
    }),
    selectedProjectionEventSchema.parse({
      ...base(5),
      type: "control",
      control: "model",
      state: "active",
      value_summary: "gpt-test"
    }),
    selectedProjectionEventSchema.parse({
      ...base(6),
      type: "runtime",
      state: "ready",
      message: null
    }),
    selectedProjectionEventSchema.parse({
      ...base(7),
      type: "unknown_optional",
      upstream_type: "future/optional",
      summary: "Optional event"
    })
  ];
}

function boundaryEvent(
  cursor: number,
  after: number | null,
  reason: "retention" | "disconnect" | "restart" | "schema_change"
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason
  });
}

function eventFrame(
  event: SelectedProjectionEvent,
  override: { readonly id?: string; readonly name?: string } = {}
): string {
  return `id: ${override.id ?? String(event.cursor)}\nevent: ${
    override.name ?? event.type
  }\ndata: ${JSON.stringify(event)}\n\n`;
}

function selectedLimits(
  override: Partial<BrowserSseClientLimits>
): BrowserSseClientLimits {
  return { ...defaultBrowserSseClientLimits, ...override };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for browser SSE state.");
}
