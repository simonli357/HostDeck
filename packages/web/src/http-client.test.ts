import {
  type BrowserHttpClientLimits,
  defaultBrowserHttpClientLimits
} from "@hostdeck/contracts/browser-http-resource-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserHttpFetchPort,
  type BrowserHttpRequestInit,
  type BrowserHttpResponsePort,
  createBrowserHttpClient,
  HostDeckBrowserHttpError
} from "./http-client.js";

const loopbackOrigin = "http://127.0.0.1:5173";
const remoteOrigin = "https://hostdeck-http-client.fixture-tailnet.ts.net";
const sessionId = "sess_http_client_001";
const csrfToken = "C".repeat(43);
const csrfGeneration = "7";

afterEach(() => {
  vi.useRealTimers();
});

describe("FE-V1-019 bounded browser HTTP client", () => {
  it("uses only selected current-document HTTP/HTTPS origins and strict fetch policy", async () => {
    for (const origin of [loopbackOrigin, remoteOrigin]) {
      const requests: Array<{
        readonly path: string;
        readonly init: BrowserHttpRequestInit;
      }> = [];
      const client = createBrowserHttpClient({
        origin,
        fetch: async (path, init) => {
          requests.push({ path, init });
          return jsonResponse(200, { status: "alive" });
        }
      });

      const result = await client.request("health_liveness", {});

      expect(result).toEqual({ status: 200, data: { status: "alive" } });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/api/v1/health/live",
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          },
          cache: "no-store",
          credentials: "same-origin",
          mode: "same-origin",
          redirect: "error",
          referrerPolicy: "no-referrer"
        }
      });
      expect(requests[0]?.init.body).toBeUndefined();
      expect(requests[0]?.path.startsWith("/")).toBe(true);
      expect(JSON.stringify(requests[0])).not.toContain(origin);
    }

    for (const origin of [
      "http://localhost:5173",
      "http://hostdeck-http-client.fixture-tailnet.ts.net",
      "https://example.com",
      "https://user:secret@hostdeck-http-client.fixture-tailnet.ts.net",
      `${remoteOrigin}/path`
    ]) {
      expect(() => createBrowserHttpClient({ origin, fetch: vi.fn() })).toThrow(
        "current origin is not selected"
      );
    }
  });

  it("rejects malformed constructor ports and resource limits without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "origin", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return loopbackOrigin;
      }
    });
    for (const options of [
      accessor,
      { origin: loopbackOrigin, fetch: null },
      { origin: loopbackOrigin, fetch: vi.fn(), extra: true },
      {
        origin: loopbackOrigin,
        fetch: vi.fn(),
        limits: selectedLimits({ requestTimeoutMs: 999 })
      },
      {
        origin: loopbackOrigin,
        fetch: vi.fn(),
        limits: { ...defaultBrowserHttpClientLimits, extra: 1 }
      }
    ]) {
      expect(() => createBrowserHttpClient(options as never)).toThrow(TypeError);
    }
    expect(getterCalls).toBe(0);
  });

  it("validates and canonically builds params, queries, bodies, and CSRF headers", async () => {
    const requests: Array<{ path: string; init: BrowserHttpRequestInit }> = [];
    const fetch: BrowserHttpFetchPort = async (path, init) => {
      requests.push({ path, init });
      return apiErrorResponse(409, "stale_session", true);
    };
    const client = createBrowserHttpClient({ origin: remoteOrigin, fetch });

    await expectFailure(
      client.request("session_events", {
        params: { session_id: sessionId },
        query: { after: "17", limit: "25" }
      }),
      "api_error"
    );
    await expectFailure(
      client.request(
        "device_revoke",
        {
          params: { device_id: "device:phone" },
          body: { operation_id: "op_http_revoke_0001", confirmed: true }
        },
        { csrfToken, csrfGeneration }
      ),
      "api_error"
    );

    expect(requests[0]?.path).toBe(
      `/api/v1/sessions/${sessionId}/events?after=17&limit=25`
    );
    expect(requests[1]?.path).toBe(
      "/api/v1/access/devices/device%3Aphone/revoke"
    );
    expect(requests[1]?.init).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-hostdeck-csrf": csrfToken,
        "x-hostdeck-csrf-generation": csrfGeneration
      }
    });
    expect(JSON.parse(requests[1]?.init.body ?? "")).toEqual({
      operation_id: "op_http_revoke_0001",
      confirmed: true
    });
  });

  it("rejects hostile or malformed request data before fetch", async () => {
    let fetches = 0;
    let getterCalls = 0;
    const client = createBrowserHttpClient({
      origin: loopbackOrigin,
      fetch: async () => {
        fetches += 1;
        return jsonResponse(200, { status: "alive" });
      }
    });
    const accessor = Object.defineProperty({}, "session_id", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return sessionId;
      }
    });
    const structuralSignal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {}
    };
    const cases: ReadonlyArray<() => Promise<unknown>> = [
      () => client.request("health_liveness", { extra: true } as never),
      () => client.request("session_detail", {} as never),
      () => client.request("session_detail", { params: accessor } as never),
      () =>
        client.request("session_detail", {
          params: { session_id: "../private" }
        } as never),
      () =>
        client.request("session_list", {
          query: { limit: "01" }
        } as never),
      () =>
        client.request(
          "host_lock",
          { body: { operation_id: "op_http_lock_0001", confirmed: true } },
          { csrfToken, csrfGeneration: "0" } as never
        ),
      () =>
        client.request("health_liveness", {}, {
          signal: structuralSignal as unknown as AbortSignal
        })
    ];

    for (const createOperation of cases) {
      await expectFailure(createOperation(), "request_contract");
    }
    expect(fetches).toBe(0);
    expect(getterCalls).toBe(0);
  });

  it("bounds exact and oversized encoded mutation bodies without retry", async () => {
    const limits = selectedLimits({ requestBodyMaxBytes: 1_024 });
    let fetches = 0;
    const client = createBrowserHttpClient({
      origin: remoteOrigin,
      limits,
      fetch: async () => {
        fetches += 1;
        return apiErrorResponse(503, "service_overloaded", true);
      }
    });
    const base = {
      operation_id: "op_http_prompt_0001",
      kind: "prompt" as const,
      text: ""
    };
    const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const exactBody = { ...base, text: "x".repeat(1_024 - overhead) };
    const oversizedBody = { ...base, text: `${exactBody.text}x` };

    await expectFailure(
      client.request(
        "prompt_dispatch",
        { params: { session_id: sessionId }, body: exactBody },
        { csrfToken, csrfGeneration }
      ),
      "api_error"
    );
    await expectFailure(
      client.request(
        "prompt_dispatch",
        { params: { session_id: sessionId }, body: oversizedBody },
        { csrfToken, csrfGeneration }
      ),
      "request_too_large"
    );
    expect(fetches).toBe(1);
  });

  it("accepts exact bounded JSON and rejects declared or streamed overflow", async () => {
    const limits = selectedLimits({ responseMaxBytes: 1_024 });
    const valid = JSON.stringify({ status: "alive" });
    const exact = `${valid}${" ".repeat(1_024 - valid.length)}`;
    const responses = [
      textResponse(200, exact, { "content-length": "1024" }),
      textResponse(200, `${exact} `),
      declaredOversizedResponse(1_025)
    ];
    const client = createBrowserHttpClient({
      origin: loopbackOrigin,
      limits,
      fetch: async () => responses.shift() as BrowserHttpResponsePort
    });

    await expect(client.request("health_liveness", {})).resolves.toEqual({
      status: 200,
      data: { status: "alive" }
    });
    await expectFailure(
      client.request("health_liveness", {}),
      "response_too_large"
    );
    await expectFailure(
      client.request("health_liveness", {}),
      "response_too_large"
    );
  });

  it("fails closed for malformed response shape, media, UTF-8, JSON, and schema", async () => {
    const responses: unknown[] = [
      { status: 200, ok: false, headers: new Headers(), body: null },
      invalidMediaResponse(),
      byteResponse(200, Uint8Array.of(0xff)),
      textResponse(200, "{"),
      jsonResponse(200, { status: "not-alive" }),
      jsonResponse(201, { status: "alive" }),
      textResponse(200, JSON.stringify({ status: "alive" }), {
        "content-length": "01"
      }),
      zeroChunkResponse(),
      hostileReadResultResponse(),
      releaseFailureResponse()
    ];
    const responseCount = responses.length;
    const client = createBrowserHttpClient({
      origin: loopbackOrigin,
      fetch: async () => responses.shift() as BrowserHttpResponsePort
    });

    for (let index = 0; index < responseCount; index += 1) {
      await expectFailure(
        client.request("health_liveness", {}),
        "invalid_response"
      );
    }
  });

  it("snapshots response and reader ports once before consuming them", async () => {
    const response = singleReadPortResponse();
    const client = createBrowserHttpClient({
      origin: loopbackOrigin,
      fetch: async () => response.value
    });

    await expect(client.request("health_liveness", {})).resolves.toEqual({
      status: 200,
      data: { status: "alive" }
    });
    expect(response.propertyReads).toEqual({
      status: 1,
      ok: 1,
      headers: 1,
      body: 1,
      get: 1,
      getReader: 1,
      read: 1,
      cancel: 1,
      releaseLock: 1
    });
    expect(response.readCalls).toBe(2);
    expect(response.cancelCalls).toBe(0);
    expect(response.releaseCalls).toBe(1);
  });

  it("preserves readiness 503 as typed selected data", async () => {
    const readiness = readyReadiness();
    const client = createBrowserHttpClient({
      origin: loopbackOrigin,
      fetch: async () => jsonResponse(503, readiness)
    });

    await expect(client.request("health_readiness", {})).resolves.toEqual({
      status: 503,
      data: readiness
    });
  });

  it("maps exact API envelopes and never retries retryable or uncertain failures", async () => {
    let fetches = 0;
    const client = createBrowserHttpClient({
      origin: remoteOrigin,
      fetch: async () => {
        fetches += 1;
        return apiErrorResponse(503, "service_overloaded", true);
      }
    });

    const error = await expectFailure(
      client.request("health_liveness", {}),
      "api_error"
    );
    expect(error).toMatchObject({
      status: 503,
      transport: "https",
      apiError: {
        code: "service_overloaded",
        message: "Selected request capacity is unavailable.",
        retryable: true
      }
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.apiError)).toBe(true);
    expect(fetches).toBe(1);

    const malformed = createBrowserHttpClient({
      origin: remoteOrigin,
      fetch: async () => jsonResponse(503, { error: { code: "unknown" } })
    });
    await expectFailure(
      malformed.request("health_liveness", {}),
      "invalid_response"
    );
  });

  it("keeps network-like failures bounded without inventing a HostDeck diagnosis", async () => {
    for (const origin of [loopbackOrigin, remoteOrigin]) {
      for (const privateCause of [
        "offline-private-cause",
        "certificate-private-cause",
        "profile-switch-private-cause",
        "serve-loss-private-cause"
      ]) {
        let fetches = 0;
        const client = createBrowserHttpClient({
          origin,
          fetch: async () => {
            fetches += 1;
            throw new TypeError(privateCause);
          }
        });
        const error = await expectFailure(
          client.request("health_liveness", {}),
          "transport_unavailable"
        );
        expect(error.transport).toBe(origin.startsWith("https:") ? "https" : "http");
        expect(JSON.stringify(error)).not.toContain(privateCause);
        expect(error).not.toHaveProperty("cause");
        expect(fetches).toBe(1);
      }
    }
  });

  it("composes caller abort and deadline across fetch and body reads with cleanup", async () => {
    vi.useFakeTimers();
    const limits = selectedLimits({ requestTimeoutMs: 1_000 });
    let fetches = 0;
    const before = new AbortController();
    before.abort("private-abort-reason");
    const pendingFetch = deferred<BrowserHttpResponsePort>();
    const client = createBrowserHttpClient({
      origin: loopbackOrigin,
      limits,
      fetch: async () => {
        fetches += 1;
        return await pendingFetch.promise;
      }
    });

    await expectFailure(
      client.request("health_liveness", {}, { signal: before.signal }),
      "caller_aborted"
    );
    expect(fetches).toBe(0);

    const during = new AbortController();
    const aborted = client.request("health_liveness", {}, {
      signal: during.signal
    });
    during.abort("second-private-abort");
    during.abort("ignored-repeat");
    const abortError = await expectFailure(aborted, "caller_aborted");
    expect(JSON.stringify(abortError)).not.toMatch(/private-abort|ignored-repeat/u);

    const timed = client.request("health_liveness", {});
    const timedFailure = expectFailure(timed, "deadline_exceeded");
    await vi.advanceTimersByTimeAsync(1_000);
    await timedFailure;

    const bodyClient = createBrowserHttpClient({
      origin: loopbackOrigin,
      limits,
      fetch: async () => hangingBodyResponse()
    });
    const bodyTimed = bodyClient.request("health_liveness", {});
    const bodyFailure = expectFailure(bodyTimed, "deadline_exceeded");
    await vi.advanceTimersByTimeAsync(1_000);
    await bodyFailure;

    const bodyAbortController = new AbortController();
    const bodyAborted = bodyClient.request("health_liveness", {}, {
      signal: bodyAbortController.signal
    });
    const bodyAbortFailure = expectFailure(bodyAborted, "caller_aborted");
    bodyAbortController.abort("private-body-abort");
    const bodyAbortError = await bodyAbortFailure;
    expect(JSON.stringify(bodyAbortError)).not.toContain("private-body-abort");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces per-client capacity and releases it exactly once", async () => {
    const gate = deferred<BrowserHttpResponsePort>();
    let fetches = 0;
    const client = createBrowserHttpClient({
      origin: loopbackOrigin,
      limits: selectedLimits({ maxInFlightRequests: 1 }),
      fetch: async () => {
        fetches += 1;
        return await gate.promise;
      }
    });
    const first = client.request("health_liveness", {});
    await expectFailure(
      client.request("health_liveness", {}),
      "capacity_exhausted"
    );
    expect(fetches).toBe(1);
    gate.resolve(jsonResponse(200, { status: "alive" }));
    await expect(first).resolves.toMatchObject({ data: { status: "alive" } });

    await expect(
      createBrowserHttpClient({
        origin: loopbackOrigin,
        fetch: async () => jsonResponse(200, { status: "alive" }),
        limits: selectedLimits({ maxInFlightRequests: 1 })
      }).request("health_liveness", {})
    ).resolves.toMatchObject({ data: { status: "alive" } });
  });

  it("does not retain sensitive request, origin, identity, or raw failure values", async () => {
    const pairingCode = "AbCdEfGhIjKlMnOpQrSt_1";
    const identity = "private-user@example.test";
    const rawFailure = `${csrfToken}:${pairingCode}:${identity}`;
    let observedBody = "";
    const client = createBrowserHttpClient({
      origin: remoteOrigin,
      fetch: async (_path, init) => {
        observedBody = init.body ?? "";
        throw new Error(rawFailure);
      }
    });
    const error = await expectFailure(
      client.request("pair_claim", {
        body: {
          operation_id: "op_http_pair_claim_0001",
          code: pairingCode
        }
      }),
      "transport_unavailable"
    );

    expect(observedBody).toContain(pairingCode);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(pairingCode);
    expect(serialized).not.toContain(csrfToken);
    expect(serialized).not.toContain(identity);
    expect(serialized).not.toContain(remoteOrigin);
    expect(Object.keys(error).sort()).toEqual([
      "apiError",
      "name",
      "reason",
      "routeId",
      "status",
      "transport"
    ]);
  });
});

async function expectFailure(
  operation: Promise<unknown>,
  reason: HostDeckBrowserHttpError["reason"]
): Promise<HostDeckBrowserHttpError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckBrowserHttpError);
    expect(error).toMatchObject({ reason });
    return error as HostDeckBrowserHttpError;
  }
  throw new Error(`Expected browser HTTP failure ${reason}.`);
}

function selectedLimits(
  override: Partial<BrowserHttpClientLimits>
): BrowserHttpClientLimits {
  return Object.freeze({ ...defaultBrowserHttpClientLimits, ...override });
}

function jsonResponse(status: number, payload: unknown): BrowserHttpResponsePort {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  }) as unknown as BrowserHttpResponsePort;
}

function apiErrorResponse(
  status: number,
  code: "service_overloaded" | "stale_session",
  retryable: boolean
): BrowserHttpResponsePort {
  return jsonResponse(status, {
    error: {
      code,
      message: "Selected request capacity is unavailable.",
      retryable
    }
  });
}

function textResponse(
  status: number,
  text: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): BrowserHttpResponsePort {
  return new Response(text, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  }) as unknown as BrowserHttpResponsePort;
}

function byteResponse(
  status: number,
  bytes: Uint8Array
): BrowserHttpResponsePort {
  return new Response(bytes as unknown as BodyInit, {
    status,
    headers: { "content-type": "application/json" }
  }) as unknown as BrowserHttpResponsePort;
}

function declaredOversizedResponse(bytes: number): BrowserHttpResponsePort {
  let cancelled = 0;
  return {
    status: 200,
    ok: true,
    headers: new Headers({
      "content-type": "application/json",
      "content-length": String(bytes)
    }),
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("declared overflow must not read");
          },
          async cancel() {
            cancelled += 1;
            throw new Error("private cancel failure");
          },
          releaseLock() {
            expect(cancelled).toBe(1);
          }
        };
      }
    }
  };
}

function zeroChunkResponse(): BrowserHttpResponsePort {
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        return {
          async read() {
            return { done: false, value: new Uint8Array() };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function invalidMediaResponse(): BrowserHttpResponsePort {
  let cancelled = 0;
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "text/plain" }),
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("invalid media must not be read");
          },
          async cancel() {
            cancelled += 1;
          },
          releaseLock() {
            expect(cancelled).toBe(1);
          }
        };
      }
    }
  };
}

function hostileReadResultResponse(): BrowserHttpResponsePort {
  let cancelled = 0;
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        return {
          async read() {
            return Object.defineProperty({}, "done", {
              get() {
                throw new Error("private read-result getter failure");
              }
            }) as never;
          },
          async cancel() {
            cancelled += 1;
          },
          releaseLock() {
            expect(cancelled).toBe(1);
          }
        };
      }
    }
  };
}

function releaseFailureResponse(): BrowserHttpResponsePort {
  const bytes = new TextEncoder().encode(JSON.stringify({ status: "alive" }));
  let reads = 0;
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            return reads === 1
              ? { done: false, value: bytes }
              : { done: true };
          },
          async cancel() {
            throw new Error("successful read must not be cancelled");
          },
          releaseLock() {
            throw new Error("private release failure");
          }
        };
      }
    }
  };
}

function singleReadPortResponse() {
  const propertyReads: Record<string, number> = {
    status: 0,
    ok: 0,
    headers: 0,
    body: 0,
    get: 0,
    getReader: 0,
    read: 0,
    cancel: 0,
    releaseLock: 0
  };
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const once = <Value>(key: string, value: Value) => ({
    enumerable: true,
    get() {
      propertyReads[key] = (propertyReads[key] ?? 0) + 1;
      if (propertyReads[key] !== 1) throw new Error(`${key} read more than once`);
      return value;
    }
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ status: "alive" }));
  const reader = Object.defineProperties({}, {
    read: once("read", async () => {
      readCalls += 1;
      return readCalls === 1 ? { done: false, value: bytes } : { done: true };
    }),
    cancel: once("cancel", async () => {
      cancelCalls += 1;
    }),
    releaseLock: once("releaseLock", () => {
      releaseCalls += 1;
    })
  });
  const body = Object.defineProperties({}, {
    getReader: once("getReader", () => reader)
  });
  const headers = Object.defineProperties({}, {
    get: once("get", (name: string) =>
      name === "content-type" ? "application/json" : null
    )
  });
  const value = Object.defineProperties({}, {
    status: once("status", 200),
    ok: once("ok", true),
    headers: once("headers", headers),
    body: once("body", body)
  }) as BrowserHttpResponsePort;

  return {
    value,
    propertyReads,
    get readCalls() {
      return readCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    get releaseCalls() {
      return releaseCalls;
    }
  };
}

function hangingBodyResponse(): BrowserHttpResponsePort {
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        return {
          async read() {
            return await new Promise<never>(() => undefined);
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function readyReadiness() {
  const checkedAt = "2026-07-22T12:00:00.000Z";
  return {
    generation: 7,
    state: "ready",
    readiness: "ready",
    updated_at: checkedAt,
    components: [
      "storage",
      "runtime",
      "compatibility",
      "projector",
      "fanout",
      "listener",
      "lease"
    ].map((component) => ({
      component,
      state: "ready",
      checked_at: checkedAt,
      causes: []
    }))
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
