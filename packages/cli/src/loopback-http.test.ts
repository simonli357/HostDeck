import { Buffer } from "node:buffer";
import { EventEmitter, getEventListeners, once } from "node:events";
import {
  type ClientRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket
} from "node:net";
import { defaultResourceBudget, resolveResourceBudget } from "@hostdeck/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpFetch, HttpRequestInit, HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

const getRequest: HttpRequestInit = Object.freeze({
  headers: Object.freeze({
    accept: "application/json",
    "cache-control": "no-store"
  }),
  method: "GET"
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("IFC-V1-051 bounded loopback HTTP transport", () => {
  it("rejects hostile injected responses, invalid JSON, and wrong success status generically", async () => {
    const classResponse = new (class {
      readonly json = async () => ({});
      readonly ok = true;
      readonly status = 200;
    })();
    await expect(injectedRequest(async () => classResponse)).rejects.toMatchObject({
      code: "internal_error"
    });

    let statusGetterCalls = 0;
    const accessorResponse = {
      json: async () => ({}),
      ok: true
    } as Record<string, unknown>;
    Object.defineProperty(accessorResponse, "status", {
      enumerable: true,
      get() {
        statusGetterCalls += 1;
        return 200;
      }
    });
    await expect(
      injectedRequest(async () => accessorResponse as unknown as HttpResponse)
    ).rejects.toMatchObject({ code: "internal_error" });
    expect(statusGetterCalls).toBe(0);

    const privateJsonCause = "private-json-rejection-sentinel";
    const invalidJson = await injectedRequest(async () => ({
      json: async () => {
        throw new Error(privateJsonCause);
      },
      ok: true,
      status: 200
    })).catch((error: unknown) => error);
    expect(invalidJson).toMatchObject({ code: "internal_error" });
    expect(String((invalidJson as Error).message)).not.toContain(privateJsonCause);

    const wrongStatus = await injectedRequest(
      async () => jsonResponse(202, {}),
      200,
      "Canonical invalid selected response."
    ).catch((error: unknown) => error);
    expect(wrongStatus).toMatchObject({
      code: "internal_error",
      message: "Canonical invalid selected response."
    });
  });

  it("reduces typed API errors to canonical public fields and rejects hostile sanitizers", async () => {
    const privateSentinel = "private-server-error-sentinel";
    const payload = {
      error: {
        code: "operation_conflict",
        message: privateSentinel,
        retryable: true,
        field: "private_server_field",
        session_id: "sess_cli_transport_private",
        details: { reason: privateSentinel }
      }
    };
    const { payload: parsedPayload, response } = await injectedRequest(
      async () => jsonResponse(409, payload),
      200
    );
    const canonical = captureThrown(() =>
      throwCliApiFailure({
        context: "transport-test",
        payload: parsedPayload,
        sanitize: (error) => ({
          code: error.code,
          message: "Canonical selected conflict.",
          retryable: error.retryable
        }),
        status: response.status
      })
    );
    expect(canonical).toMatchObject({
      apiError: {
        code: "operation_conflict",
        message: "Canonical selected conflict.",
        retryable: true
      },
      code: "operation_conflict",
      exitCode: cliExitCodes.apiError,
      kind: "api_error",
      message: "Canonical selected conflict.",
      retryable: true,
      status: 409
    });
    expect(JSON.stringify(canonical)).not.toContain(privateSentinel);
    expect(canonical).toMatchObject({ field: undefined, causeValue: undefined });

    for (const hostileSanitizer of [
      () => {
        throw new Error(privateSentinel);
      },
      () => ({
        code: "operation_conflict" as const,
        details: { reason: "must-not-survive" },
        message: "Canonical selected conflict.",
        retryable: false
      })
    ]) {
      const failure = captureThrown(() =>
        throwCliApiFailure({
          context: "transport-test",
          payload,
          sanitize: hostileSanitizer,
          status: 409
        })
      );
      expect(failure).toMatchObject({ code: "internal_error" });
      expect(String((failure as Error).message)).not.toContain(privateSentinel);
    }

    for (const malformed of [
      { error: payload.error, extra: privateSentinel },
      { error: { code: "operation_conflict", message: privateSentinel }, extra: true },
      { error: "not-an-envelope" }
    ]) {
      const failure = captureThrown(() =>
        throwCliApiFailure({
          context: "transport-test",
          payload: malformed,
          sanitize: (error) => error,
          status: 409
        })
      );
      expect(failure).toMatchObject({ code: "internal_error" });
      expect(String((failure as Error).message)).not.toContain(privateSentinel);
    }
  });

  it("rejects hostile transport, URL, request, header, and budget inputs before I/O", async () => {
    for (const candidate of [null, [], { extra: true }, Object.create({})]) {
      expect(() =>
        createBoundedLoopbackFetch(candidate as never)
      ).toThrow("transport options are invalid");
    }
    expect(() =>
      createBoundedLoopbackFetch(
        Object.defineProperty({}, "signal", { enumerable: true, get: () => undefined })
      )
    ).toThrow("transport options are invalid");
    expect(() =>
      createBoundedLoopbackFetch({ budget: { ...defaultResourceBudget, cli_connect_timeout_ms: 1 } })
    ).toThrow("transport budget is invalid");
    expect(() =>
      createBoundedLoopbackFetch({
        budget: { ...defaultResourceBudget } as never
      })
    ).toThrow("transport budget is invalid");
    expect(() =>
      createBoundedLoopbackFetch({
        budget: { cli_response_max_bytes: 1_024 } as never
      })
    ).toThrow("transport budget is invalid");

    for (const origin of [
      "https://127.0.0.1:3777",
      "http://localhost:3777",
      "http://127.0.0.2:3777",
      "http://[::1]:3777",
      "http://127.0.0.1:80",
      "http://127.0.0.1:3777/prefix",
      "http://user@127.0.0.1:3777",
      "http://127.0.0.1:3777?private=yes",
      "http://127.0.0.1:3777#private"
    ]) {
      expect(() => requireLoopbackBaseUrl(new URL(origin))).toThrow(
        "direct loopback HTTP API"
      );
    }

    let allocations = 0;
    const fetch = createBoundedLoopbackFetch({
      request: () => {
        allocations += 1;
        return new RefusedFakeClientRequest() as unknown as ClientRequest;
      }
    });
    for (const url of [
      "not a URL",
      "http://127.0.0.1:3777/",
      "http://127.0.0.1:3777/api/v1/status?private=yes",
      "http://127.0.0.1:3777/api/v1/status#private"
    ]) {
      await expect(fetch(url, getRequest)).rejects.toMatchObject({
        code: "invalid_config",
        exitCode: cliExitCodes.config,
        field: "--api-url",
        kind: "invalid_config",
        retryable: false,
        status: undefined
      });
    }
    await expect(
      fetch("http://127.0.0.1:3777/api/v1/status", {
        ...getRequest,
        method: "POST"
      })
    ).rejects.toMatchObject({ code: "internal_error" });
    await expect(
      fetch("http://127.0.0.1:3777/api/v1/status", {
        ...getRequest,
        headers: { ...getRequest.headers, authorization: "private" }
      })
    ).rejects.toMatchObject({ code: "internal_error" });
    await expect(
      fetch("http://127.0.0.1:3777/api/v1/status", {
        ...getRequest,
        body: ""
      })
    ).rejects.toMatchObject({ code: "internal_error" });
    await expect(
      fetch("http://127.0.0.1:3777/api/v1/status", {
        body: "private-invalid-json",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json"
        },
        method: "POST"
      })
    ).rejects.toMatchObject({ code: "internal_error" });
    await expect(
      fetch(
        { toString: () => "http://127.0.0.1:3777/api/v1/status" } as never,
        getRequest
      )
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(allocations).toBe(0);
  });

  it("sends exact bounded GET and POST requests and parses complete JSON once", async () => {
    const observed: Array<{
      readonly body: string;
      readonly headers: IncomingMessage["headers"];
      readonly method: string | undefined;
      readonly path: string | undefined;
    }> = [];
    const server = await listen(async (request, response) => {
      const body = await readBody(request);
      observed.push({
        body,
        headers: request.headers,
        method: request.method,
        path: request.url
      });
      sendJson(response, request.method === "GET" ? 200 : 202, {
        method: request.method
      });
    });
    try {
      const fetch = createBoundedLoopbackFetch();
      const get = await fetch(`${server.origin}/api/v1/status`, getRequest);
      expect(await get.json()).toEqual({ method: "GET" });
      const body = JSON.stringify({ operation_id: "op_cli_transport_001" });
      const post = await fetch(`${server.origin}/api/v1/mutate`, {
        body,
        headers: Object.freeze({
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json",
          "x-hostdeck-local-admin": "cli-v1"
        }),
        method: "POST"
      });
      expect(post).toMatchObject({ ok: true, status: 202 });
      expect(await post.json()).toEqual({ method: "POST" });
      expect(observed).toHaveLength(2);
      expect(observed[0]).toMatchObject({ body: "", method: "GET", path: "/api/v1/status" });
      expect(observed[1]).toMatchObject({ body, method: "POST", path: "/api/v1/mutate" });
      expect(observed[1]?.headers).toMatchObject({
        accept: "application/json",
        "accept-encoding": "identity",
        connection: "close",
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
        "x-hostdeck-local-admin": "cli-v1"
      });
    } finally {
      await server.close();
    }
  });

  it("enforces exact request and declared/observed response byte limits", async () => {
    const budget = resolveResourceBudget({
      cli_request_body_max_bytes: 1_024,
      cli_response_max_bytes: 1_024
    });
    let calls = 0;
    const server = await listen((request, response) => {
      calls += 1;
      if (request.url === "/api/v1/request") {
        sendJson(response, 200, { accepted: true });
        return;
      }
      if (request.url === "/api/v1/declared") {
        response.writeHead(200, {
          "content-length": "1025",
          "content-type": "application/json"
        });
        response.end();
        return;
      }
      if (request.url === "/api/v1/exact-response") {
        const body = jsonBodyOfBytes(1_024);
        response.writeHead(200, {
          "content-length": String(Buffer.byteLength(body)),
          "content-type": "application/json"
        });
        response.end(body);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked"
      });
      response.end(JSON.stringify({ value: "x".repeat(1_024) }));
    });
    try {
      const fetch = createBoundedLoopbackFetch({ budget });
      const exactBody = jsonBodyOfBytes(1_024);
      await expect(
        fetch(`${server.origin}/api/v1/request`, postRequest(exactBody))
      ).resolves.toMatchObject({ ok: true, status: 200 });
      expect(calls).toBe(1);
      await expect(
        fetch(`${server.origin}/api/v1/request`, postRequest(`${exactBody} `))
      ).rejects.toMatchObject({
        code: "request_too_large",
        exitCode: cliExitCodes.apiError,
        kind: "api_error",
        message: "HostDeck CLI request body exceeds its selected limit.",
        retryable: false,
        status: undefined
      });
      expect(calls).toBe(1);
      await expect(
        fetch(`${server.origin}/api/v1/declared`, getRequest)
      ).rejects.toMatchObject({
        code: "service_overloaded",
        exitCode: cliExitCodes.apiError,
        kind: "api_error",
        message: "HostDeck CLI response exceeds its selected limit.",
        retryable: false,
        status: undefined
      });
      expect(calls).toBe(2);
      await expect(
        fetch(`${server.origin}/api/v1/exact-response`, getRequest)
      ).resolves.toMatchObject({ ok: true, status: 200 });
      expect(calls).toBe(3);
      await expect(
        fetch(`${server.origin}/api/v1/observed`, getRequest)
      ).rejects.toMatchObject({
        code: "service_overloaded",
        exitCode: cliExitCodes.apiError,
        kind: "api_error",
        retryable: false,
        status: undefined
      });
      expect(calls).toBe(4);
    } finally {
      await server.close();
    }
  });

  it("maps refusal and deterministic connect timeout to daemon unavailable without retaining causes", async () => {
    const closed = await listen((_request, response) => sendJson(response, 200, {}));
    const origin = closed.origin;
    await closed.close();
    const fetch = createBoundedLoopbackFetch();
    const refused = await fetch(`${origin}/api/v1/status`, getRequest).catch(
      (error: unknown) => error
    );
    expect(refused).toMatchObject({
      code: "daemon_unavailable",
      exitCode: cliExitCodes.daemonUnavailable,
      kind: "daemon_unavailable",
      message: `Unable to reach HostDeck daemon at ${origin}.`,
      retryable: true,
      status: undefined
    });
    expect(refused).toMatchObject({ causeValue: undefined });

    vi.useFakeTimers();
    const fakeRequest = new FakeClientRequest();
    const timedFetch = createBoundedLoopbackFetch({
      request: () => fakeRequest as unknown as ClientRequest
    });
    const pending = timedFetch(
      "http://127.0.0.1:3777/api/v1/status",
      getRequest
    );
    const timedAssertion = expect(pending).rejects.toMatchObject({
      code: "daemon_unavailable",
      exitCode: cliExitCodes.daemonUnavailable,
      kind: "daemon_unavailable",
      message: "Unable to reach HostDeck daemon at http://127.0.0.1:3777.",
      retryable: true,
      status: undefined
    });
    await vi.advanceTimersByTimeAsync(defaultResourceBudget.cli_connect_timeout_ms);
    await timedAssertion;
    expect(fakeRequest.destroyed).toBe(true);
    expect(getEventListeners(fakeRequest, "error")).toHaveLength(0);
    expect(getEventListeners(fakeRequest, "socket")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles tied connect/request deadlines once with connect precedence", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fakeRequest = new FakeClientRequest();
    const fetch = createBoundedLoopbackFetch({
      budget: resolveResourceBudget({
        cli_connect_timeout_ms: 30_000,
        cli_request_timeout_ms: 30_000
      }),
      request: () => fakeRequest as unknown as ClientRequest,
      signal: controller.signal
    });
    const pending = fetch(
      "http://127.0.0.1:3777/api/v1/status",
      getRequest
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "daemon_unavailable",
      exitCode: cliExitCodes.daemonUnavailable,
      kind: "daemon_unavailable",
      retryable: true
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    controller.abort();

    expect(fakeRequest.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes complete-request timeout for GET and POST without retry", async () => {
    vi.useFakeTimers();
    const getRequestPort = new ConnectedFakeClientRequest();
    const getFetch = createBoundedLoopbackFetch({
      request: () => getRequestPort as unknown as ClientRequest
    });
    const getPending = getFetch(
      "http://127.0.0.1:3777/api/v1/status",
      getRequest
    );
    const getAssertion = expect(getPending).rejects.toMatchObject({
      code: "operation_timeout",
      exitCode: cliExitCodes.apiError,
      kind: "api_error",
      message: "HostDeck CLI request timed out.",
      retryable: true,
      status: undefined
    });
    await vi.advanceTimersByTimeAsync(defaultResourceBudget.cli_request_timeout_ms);
    await getAssertion;
    expect(getRequestPort.endCalls).toBe(1);
    expect(getEventListeners(getRequestPort, "error")).toHaveLength(0);
    expect(getEventListeners(getRequestPort, "socket")).toHaveLength(0);
    expect(getEventListeners(getRequestPort.socket, "connect")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    const postRequestPort = new ConnectedFakeClientRequest();
    const postFetch = createBoundedLoopbackFetch({
      request: () => postRequestPort as unknown as ClientRequest
    });
    const postPending = postFetch(
      "http://127.0.0.1:3777/api/v1/mutate",
      postRequest(JSON.stringify({ operation_id: "op_cli_timeout_001" }))
    );
    const postAssertion = expect(postPending).rejects.toMatchObject({
      code: "operation_timeout",
      exitCode: cliExitCodes.apiError,
      kind: "api_error",
      message: "HostDeck CLI request timed out.",
      retryable: false,
      status: undefined
    });
    await vi.advanceTimersByTimeAsync(defaultResourceBudget.cli_request_timeout_ms);
    await postAssertion;
    expect(postRequestPort.endCalls).toBe(1);
    expect(getEventListeners(postRequestPort, "error")).toHaveLength(0);
    expect(getEventListeners(postRequestPort, "socket")).toHaveLength(0);
    expect(getEventListeners(postRequestPort.socket, "connect")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the whole-request deadline authoritative across response dribble and releases all owned resources", async () => {
    vi.useFakeTimers();
    const budget = resolveResourceBudget({
      cli_connect_timeout_ms: 500,
      cli_request_timeout_ms: 30_000,
      cli_stream_idle_timeout_ms: 5_000,
      sse_heartbeat_interval_ms: 1_000
    });
    const incoming = new FakeIncomingResponse();
    let allocated: RespondingFakeClientRequest | undefined;
    const fetch = createBoundedLoopbackFetch({
      budget,
      request: (_url, _options, callback) => {
        allocated = new RespondingFakeClientRequest(callback, incoming);
        return allocated as unknown as ClientRequest;
      }
    });
    const pending = fetch(
      "http://127.0.0.1:3777/api/v1/status",
      getRequest
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "operation_timeout",
      exitCode: cliExitCodes.apiError,
      kind: "api_error",
      retryable: true,
      status: undefined
    });

    for (let elapsed = 0; elapsed < 28_000; elapsed += 4_000) {
      incoming.emit("data", Buffer.from(" "));
      await vi.advanceTimersByTimeAsync(4_000);
    }
    incoming.emit("data", Buffer.from(" "));
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(allocated?.destroyed).toBe(true);
    expect(incoming.destroyed).toBe(true);
    expect(getEventListeners(incoming, "data")).toHaveLength(0);
    expect(getEventListeners(incoming, "end")).toHaveLength(0);
    expect(getEventListeners(incoming, "aborted")).toHaveLength(0);
    expect(getEventListeners(incoming, "error")).toHaveLength(0);
    expect(getEventListeners(incoming, "close")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parses one-byte chunk dribble from one bounded buffer and cleans success listeners", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const incoming = new FakeIncomingResponse();
    let allocated: RespondingFakeClientRequest | undefined;
    const fetch = createBoundedLoopbackFetch({
      request: (_url, _options, callback) => {
        allocated = new RespondingFakeClientRequest(callback, incoming);
        return allocated as unknown as ClientRequest;
      },
      signal: controller.signal
    });
    const pending = fetch(
      "http://127.0.0.1:3777/api/v1/status",
      getRequest
    );
    incoming.emit("data", Buffer.from("{"));
    incoming.emit("data", Buffer.from("}"));
    incoming.complete = true;
    incoming.emit("end");

    const response = await pending;
    await expect(response.json()).resolves.toEqual({});
    expect(allocated?.destroyed).toBe(true);
    expect(incoming.destroyed).toBe(true);
    expect(getEventListeners(incoming, "data")).toHaveLength(0);
    expect(getEventListeners(incoming, "end")).toHaveLength(0);
    expect(getEventListeners(incoming, "aborted")).toHaveLength(0);
    expect(getEventListeners(incoming, "error")).toHaveLength(0);
    expect(getEventListeners(incoming, "close")).toHaveLength(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans pre-allocation deadlines and capacity after synchronous request-port failure", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let allocations = 0;
    const fetch = createBoundedLoopbackFetch({
      budget: resolveResourceBudget({ cli_max_in_flight_requests: 1 }),
      request: () => {
        allocations += 1;
        throw new Error("private-request-construction-sentinel");
      },
      signal: controller.signal
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        fetch("http://127.0.0.1:3777/api/v1/status", getRequest)
      ).rejects.toMatchObject({ code: "internal_error", retryable: false });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(allocations).toBe(2);

    const failedWrite = new ThrowingEndFakeClientRequest();
    const writeFetch = createBoundedLoopbackFetch({
      request: () => failedWrite as unknown as ClientRequest,
      signal: controller.signal
    });
    await expect(
      writeFetch("http://127.0.0.1:3777/api/v1/status", getRequest)
    ).rejects.toMatchObject({
      code: "internal_error",
      exitCode: cliExitCodes.internal,
      kind: "internal",
      message: "HostDeck CLI HTTP request could not be written.",
      retryable: false
    });
    expect(failedWrite.destroyed).toBe(true);
    expect(getEventListeners(failedWrite, "error")).toHaveLength(0);
    expect(getEventListeners(failedWrite, "socket")).toHaveLength(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts before allocation or during I/O and removes the exact signal listener", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    let allocations = 0;
    const preFetch = createBoundedLoopbackFetch({
      request: () => {
        allocations += 1;
        return new FakeClientRequest() as unknown as ClientRequest;
      },
      signal: preAborted.signal
    });
    await expect(
      preFetch("http://127.0.0.1:3777/api/v1/status", getRequest)
    ).rejects.toMatchObject({
      code: "unknown_error",
      exitCode: cliExitCodes.apiError,
      kind: "api_error",
      message: "HostDeck CLI request was cancelled.",
      retryable: true,
      status: undefined
    });
    expect(allocations).toBe(0);
    expect(getEventListeners(preAborted.signal, "abort")).toHaveLength(0);

    const controller = new AbortController();
    const fakeRequest = new ConnectedFakeClientRequest();
    const fetch = createBoundedLoopbackFetch({
      request: () => fakeRequest as unknown as ClientRequest,
      signal: controller.signal
    });
    const pending = fetch(
      "http://127.0.0.1:3777/api/v1/mutate",
      postRequest(JSON.stringify({ operation_id: "op_cli_abort_001" }))
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "unknown_error",
      exitCode: cliExitCodes.apiError,
      kind: "api_error",
      message: "HostDeck CLI request was cancelled.",
      retryable: false,
      status: undefined
    });
    expect(fakeRequest.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(fakeRequest, "error")).toHaveLength(0);
    expect(getEventListeners(fakeRequest, "socket")).toHaveLength(0);
  });

  it("enforces process-wide in-flight capacity across transport factories", async () => {
    const controller = new AbortController();
    const budget = resolveResourceBudget({ cli_max_in_flight_requests: 1 });
    const firstRequest = new ConnectedFakeClientRequest();
    const first = createBoundedLoopbackFetch({
      budget,
      request: () => firstRequest as unknown as ClientRequest,
      signal: controller.signal
    });
    const releasedRequest = new RefusedFakeClientRequest();
    const second = createBoundedLoopbackFetch({
      budget,
      request: () => releasedRequest as unknown as ClientRequest
    });
    const pending = first(
      "http://127.0.0.1:3777/api/v1/status",
      getRequest
    );
    await expect(
      second("http://127.0.0.1:3777/api/v1/status", getRequest)
    ).rejects.toMatchObject({
      code: "service_overloaded",
      exitCode: cliExitCodes.apiError,
      kind: "api_error",
      message: "Too many HostDeck CLI requests are active.",
      retryable: true,
      status: undefined
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "unknown_error" });
    await expect(
      second("http://127.0.0.1:3777/api/v1/status", getRequest)
    ).rejects.toMatchObject({ code: "daemon_unavailable" });
  });

  it("rejects invalid media, encoding, UTF-8, JSON, and truncated framing generically", async () => {
    const server = await listen((request, response) => {
      switch (request.url) {
        case "/api/v1/media":
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("{}");
          return;
        case "/api/v1/encoding":
          response.writeHead(200, {
            "content-encoding": "gzip",
            "content-type": "application/json"
          });
          response.end("{}");
          return;
        case "/api/v1/utf8":
          response.writeHead(200, { "content-type": "application/json" });
          response.end(Buffer.from([0xc3, 0x28]));
          return;
        case "/api/v1/json":
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{private-invalid-json");
          return;
        case "/api/v1/empty":
          response.writeHead(200, {
            "content-length": "0",
            "content-type": "application/json"
          });
          response.end();
          return;
        default:
          response.writeHead(200, {
            "connection": "close",
            "content-length": "100",
            "content-type": "application/json"
          });
          response.end("{}");
      }
    });
    try {
      const fetch = createBoundedLoopbackFetch();
      for (const path of ["media", "encoding", "utf8", "json", "empty"]) {
        const error = await fetch(`${server.origin}/api/v1/${path}`, getRequest).catch(
          (candidate: unknown) => candidate
        );
        expect(error).toMatchObject({ code: "internal_error", exitCode: 1 });
        expect(String((error as Error).message)).not.toContain("private-invalid-json");
      }
      await expect(
        fetch(`${server.origin}/api/v1/truncated`, getRequest)
      ).rejects.toMatchObject({
        code: "unknown_error",
        exitCode: cliExitCodes.apiError,
        kind: "api_error",
        message: "HostDeck CLI response ended before completion.",
        retryable: true,
        status: undefined
      });
      await expect(
        fetch(
          `${server.origin}/api/v1/truncated-post`,
          postRequest(JSON.stringify({ operation_id: "op_cli_incomplete_001" }))
        )
      ).rejects.toMatchObject({
        code: "unknown_error",
        exitCode: cliExitCodes.apiError,
        kind: "api_error",
        message: "HostDeck CLI response ended before completion.",
        retryable: false,
        status: undefined
      });
    } finally {
      await server.close();
    }
  });

  it("accepts exact real chunked framing and rejects malformed raw HTTP framing", async () => {
    const valid = await listenRaw(
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "2",
        "{}",
        "0",
        "",
        ""
      ].join("\r\n")
    );
    try {
      const response = await createBoundedLoopbackFetch()(
        `${valid.origin}/api/v1/chunked`,
        getRequest
      );
      await expect(response.json()).resolves.toEqual({});
    } finally {
      await valid.close();
    }

    const malformedResponses = [
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Content-Type: application/json",
        "Content-Length: 2",
        "Connection: close",
        "",
        "{}"
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Transfer-Encoding: gzip",
        "Connection: close",
        "",
        "{}"
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Connection: close",
        "",
        "{}"
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Content-Length: 2",
        "Content-Length: 2",
        "Connection: close",
        "",
        "{}"
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Content-Length: 2",
        "Connection: close",
        "",
        "{}unexpected-extra-bytes"
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "not-a-size",
        "{}",
        "0",
        "",
        ""
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "2",
        "{}",
        "0",
        "X-Private-Trailer: rejected",
        "",
        ""
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Content-Length: 2",
        ...Array.from(
          { length: defaultResourceBudget.http_headers_max_count },
          (_, index) => `X-Bounded-${index}: value`
        ),
        "Connection: close",
        "",
        "{}"
      ],
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        `X-Oversized: ${"x".repeat(
          defaultResourceBudget.http_headers_max_bytes
        )}`,
        "Content-Length: 2",
        "Connection: close",
        "",
        "{}"
      ]
    ];

    for (const lines of malformedResponses) {
      const server = await listenRaw(lines.join("\r\n"));
      try {
        await expect(
          createBoundedLoopbackFetch()(
            `${server.origin}/api/v1/malformed-framing`,
            getRequest
          )
        ).rejects.toMatchObject({ code: "internal_error", retryable: false });
      } finally {
        await server.close();
      }
    }
  });

  it("enforces response-idle timeout without extending the whole request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let wroteFirstChunk: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      wroteFirstChunk = resolve;
    });
    const server = await listen((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked"
      });
      response.write('{"state":');
      wroteFirstChunk?.();
    });
    const budget = resolveResourceBudget({
      cli_request_timeout_ms: 60_000,
      cli_stream_idle_timeout_ms: 5_000,
      sse_heartbeat_interval_ms: 1_000
    });
    try {
      const pending = createBoundedLoopbackFetch({ budget })(
        `${server.origin}/api/v1/stall`,
        getRequest
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: "operation_timeout",
        retryable: true
      });
      await firstChunk;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      await server.close();
    }
  });

  it("leaves no client socket, timer, server connection, or process listener residue after aggregate success", async () => {
    const server = await listen((_request, response) => {
      sendJson(response, 200, { ok: true });
    });
    const beforeResources = selectedActiveResourceCounts();
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const controller = new AbortController();
    try {
      const fetch = createBoundedLoopbackFetch({ signal: controller.signal });
      for (let index = 0; index < 12; index += 1) {
        const response = await fetch(
          `${server.origin}/api/v1/sequential-${index}`,
          getRequest
        );
        await expect(response.json()).resolves.toEqual({ ok: true });
      }
      for (let batch = 0; batch < 4; batch += 1) {
        const responses = await Promise.all(
          Array.from({ length: defaultResourceBudget.cli_max_in_flight_requests }, (_, index) =>
            fetch(`${server.origin}/api/v1/concurrent-${batch}-${index}`, getRequest)
          )
        );
        await Promise.all(responses.map((response) => response.json()));
      }
      await settleIoTurns(4);

      expect(await server.connectionCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
      expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
      const afterResources = selectedActiveResourceCounts();
      expect(afterResources.TCPSocketWrap).toBeLessThanOrEqual(
        beforeResources.TCPSocketWrap
      );
      expect(afterResources.Timeout).toBeLessThanOrEqual(beforeResources.Timeout);
    } finally {
      await server.close();
    }
  });
});

class FakeClientRequest extends EventEmitter {
  destroyed = false;
  endCalls = 0;

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  end(): this {
    this.endCalls += 1;
    return this;
  }
}

class ConnectedFakeClientRequest extends FakeClientRequest {
  readonly socket = new FakeSocket();

  override end(): this {
    super.end();
    this.emit("socket", this.socket);
    return this;
  }
}

class ThrowingEndFakeClientRequest extends FakeClientRequest {
  override end(): this {
    throw new Error("private-request-write-sentinel");
  }
}

class RefusedFakeClientRequest extends FakeClientRequest {
  override end(): this {
    super.end();
    const error = Object.assign(new Error("private refused cause"), {
      code: "ECONNREFUSED"
    });
    this.emit("error", error);
    return this;
  }
}

class RespondingFakeClientRequest extends ConnectedFakeClientRequest {
  constructor(
    private readonly callback: (response: IncomingMessage) => void,
    private readonly response: FakeIncomingResponse
  ) {
    super();
  }

  override end(): this {
    super.end();
    this.callback(this.response as unknown as IncomingMessage);
    return this;
  }
}

class FakeIncomingResponse extends EventEmitter {
  complete = false;
  destroyed = false;
  readonly rawHeaders = [
    "Content-Type",
    "application/json",
    "Transfer-Encoding",
    "chunked"
  ];
  readonly rawTrailers: string[] = [];
  readonly statusCode = 200;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeSocket extends EventEmitter {
  readonly connecting = false;
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<{
  readonly close: () => Promise<void>;
  readonly connectionCount: () => Promise<number>;
  readonly origin: string;
}> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => closeServer(server),
    connectionCount: async () =>
      new Promise<number>((resolve, reject) => {
        server.getConnections((error, count) =>
          error === null ? resolve(count) : reject(error)
        );
      }),
    origin: `http://127.0.0.1:${address.port}`
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function listenRaw(
  rawResponse: string
): Promise<{ readonly close: () => Promise<void>; readonly origin: string }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      socket.end(Buffer.from(rawResponse, "latin1"));
    });
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => closeNetServer(server, sockets),
    origin: `http://127.0.0.1:${address.port}`
  });
}

async function closeNetServer(server: NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function selectedActiveResourceCounts(): {
  readonly TCPSocketWrap: number;
  readonly Timeout: number;
} {
  const resources = process.getActiveResourcesInfo();
  return Object.freeze({
    TCPSocketWrap: resources.filter((resource) => resource === "TCPSocketWrap").length,
    Timeout: resources.filter((resource) => resource === "Timeout").length
  });
}

async function settleIoTurns(turns: number): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(body);
}

function jsonResponse(status: number, payload: unknown): HttpResponse {
  return Object.freeze({
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status
  });
}

function injectedRequest(
  fetch: HttpFetch,
  expectedStatus = 200,
  invalidSuccessStatusMessage = "Canonical invalid selected response."
) {
  const baseUrl = new URL("http://127.0.0.1:3777");
  return requestCliJson({
    baseUrl,
    context: "HostDeck transport-test",
    expectedStatus,
    fetch,
    init: getRequest,
    invalidSuccessStatusMessage,
    url: new URL("/api/v1/status", baseUrl)
  });
}

function captureThrown(operation: () => never): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}

function postRequest(body: string): HttpRequestInit {
  return Object.freeze({
    body,
    headers: Object.freeze({
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json"
    }),
    method: "POST"
  });
}

function jsonBodyOfBytes(bytes: number): string {
  const empty = JSON.stringify({ value: "" });
  const body = JSON.stringify({ value: "x".repeat(bytes - Buffer.byteLength(empty)) });
  expect(Buffer.byteLength(body)).toBe(bytes);
  return body;
}
