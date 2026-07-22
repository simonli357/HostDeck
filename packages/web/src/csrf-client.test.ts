import { describe, expect, it, vi } from "vitest";
import {
  type BrowserCsrfClient,
  browserCsrfInvalidationReasons,
  createBrowserCsrfClient,
  HostDeckBrowserCsrfError
} from "./csrf-client.js";
import {
  type BrowserHttpFetchPort,
  type BrowserHttpRequestInit,
  type BrowserHttpResponsePort,
  createBrowserHttpClient
} from "./http-client.js";
import { browserHttpRouteContracts } from "./http-route-contracts.js";

const remoteOrigin = "https://hostdeck-csrf.fixture-tailnet.ts.net";
const rotatedAt = "2026-07-22T17:00:00.000Z";
const laterAt = "2026-07-22T17:01:00.000Z";
const rawToken = "C".repeat(43);
const newerToken = "D".repeat(43);
const sessionId = "sess_browser_csrf_test";

describe("browser CSRF authority lifecycle", () => {
  it("accepts only factory-created bounded HTTP clients and starts token-free", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperties({}, {
      createOperationId: {
        enumerable: true,
        value: () => "op_browser_csrf_ctor"
      },
      httpClient: {
      enumerable: true,
      get() {
        getterCalls += 1;
        return createBrowserHttpClient({ origin: remoteOrigin, fetch: vi.fn() });
      }
      }
    });
    expect(() => createBrowserCsrfClient(accessor as never)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
    expect(() =>
      createBrowserCsrfClient({
        httpClient: Object.freeze({ request: vi.fn() }) as never,
        createOperationId: () => "op_browser_csrf_structural"
      })
    ).toThrow(TypeError);
    expect(() =>
      createBrowserCsrfClient({
        httpClient: createBrowserHttpClient({ origin: remoteOrigin, fetch: vi.fn() }),
        createOperationId: () => "op_browser_csrf_extra",
        extra: true
      } as never)
    ).toThrow(TypeError);

    const client = harness().client;
    expect(client.snapshot()).toEqual({
      phase: "idle",
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: "not_bootstrapped"
    });
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.snapshot())).toBe(true);
    expect(JSON.stringify(client.snapshot())).not.toContain(rawToken);
  });

  it("locks the exact rotate and protected-route inventory", () => {
    const rotate = Object.values(browserHttpRouteContracts)
      .filter(({ csrf }) => csrf === "rotate")
      .map(({ id }) => id);
    const protectedRoutes = Object.values(browserHttpRouteContracts)
      .filter(({ csrf }) => csrf === "required_for_device")
      .map(({ id }) => id);

    expect(rotate).toEqual(["csrf_bootstrap"]);
    expect(protectedRoutes).toEqual([
      "session_start",
      "session_archive",
      "prompt_dispatch",
      "model_select",
      "goal_mutate",
      "plan_select",
      "compact_start",
      "approval_respond",
      "turn_interrupt",
      "device_revoke",
      "host_lock"
    ]);
  });

  it("bootstraps once without prior CSRF and exposes only generation metadata", async () => {
    const test = harness({
      fetch: async () => jsonResponse(200, bootstrapPayload(rawToken, 2, rotatedAt))
    });

    const snapshot = await test.client.bootstrap();

    expect(test.operationIds).toBe(1);
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]).toMatchObject({
      path: "/api/v1/access/csrf",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json"
        }
      }
    });
    expect(test.requests[0]?.init.headers).not.toHaveProperty("x-hostdeck-csrf");
    expect(test.requests[0]?.init.headers).not.toHaveProperty(
      "x-hostdeck-csrf-generation"
    );
    expect(JSON.parse(test.requests[0]?.init.body ?? "")).toEqual({
      operation_id: "op_browser_csrf_bootstrap_0001"
    });
    expect(snapshot).toEqual({
      phase: "ready",
      generation: 2,
      rotatedAt,
      failure: null,
      invalidationReason: null
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(rawToken);
  });

  it("coalesces concurrent bootstrap callers into one rotation", async () => {
    const response = deferred<BrowserHttpResponsePort>();
    const test = harness({ fetch: async () => await response.promise });

    const first = test.client.bootstrap();
    const second = test.client.bootstrap();
    const third = test.client.bootstrap();
    expect(test.client.snapshot().phase).toBe("bootstrapping");
    await Promise.resolve();
    expect(test.operationIds).toBe(1);
    expect(test.requests).toHaveLength(1);

    response.resolve(jsonResponse(200, bootstrapPayload(rawToken, 2, rotatedAt)));
    const snapshots = await Promise.all([first, second, third]);
    expect(snapshots.every((snapshot) => snapshot === snapshots[0])).toBe(true);
    expect(test.operationIds).toBe(1);
    expect(test.requests).toHaveLength(1);
  });

  it("installs single-flight ownership before invoking a reentrant operation-id port", async () => {
    let client!: BrowserCsrfClient;
    let reentrant: Promise<unknown> | null = null;
    let operationIds = 0;
    let fetches = 0;
    const httpClient = createBrowserHttpClient({
      origin: remoteOrigin,
      fetch: async () => {
        fetches += 1;
        return jsonResponse(200, bootstrapPayload(rawToken, 2, rotatedAt));
      }
    });
    client = createBrowserCsrfClient({
      httpClient,
      createOperationId: () => {
        operationIds += 1;
        reentrant = client.bootstrap();
        return "op_browser_csrf_reentrant";
      }
    });

    const first = client.bootstrap();
    await first;
    expect(reentrant).toBe(first);
    expect(operationIds).toBe(1);
    expect(fetches).toBe(1);
  });

  it("fails closed before fetch when operation-id creation throws or returns invalid data", async () => {
    for (const createOperationId of [
      () => {
        throw new Error(`${rawToken}:private-operation-id-failure`);
      },
      () => "invalid operation id"
    ]) {
      const fetch = vi.fn();
      const client = createBrowserCsrfClient({
        httpClient: createBrowserHttpClient({ origin: remoteOrigin, fetch }),
        createOperationId
      });
      client.adoptBootstrap(bootstrapPayload(rawToken, 1, rotatedAt));

      const error = await expectCsrfFailure(client.bootstrap(), "client_contract");

      expect(fetch).not.toHaveBeenCalled();
      expect(client.snapshot()).toMatchObject({
        phase: "failed",
        generation: null,
        failure: { reason: "client_contract" }
      });
      expect(JSON.stringify({ error, snapshot: client.snapshot() })).not.toContain(
        rawToken
      );
    }
  });

  it("clears prior authority before rotation and never restores it after response loss", async () => {
    const response = deferred<BrowserHttpResponsePort>();
    const test = harness({ fetch: async () => await response.promise });
    test.client.adoptBootstrap(bootstrapPayload(rawToken, 1, rotatedAt));

    const pending = test.client.bootstrap();
    expect(test.client.snapshot()).toMatchObject({
      phase: "bootstrapping",
      generation: null
    });
    await expectCsrfFailure(
      test.client.request("host_lock", {
        body: { operation_id: "op_browser_csrf_blocked", confirmed: true }
      }),
      "not_ready"
    );

    response.reject(new Error(`${rawToken}:private-bootstrap-loss`));
    await expectCsrfFailure(pending, "bootstrap_unavailable");
    expect(test.client.snapshot()).toMatchObject({
      phase: "failed",
      generation: null,
      rotatedAt: null
    });
    expect(JSON.stringify(test.client.snapshot())).not.toContain(rawToken);
    expect(test.requests).toHaveLength(1);
  });

  it("maps malformed and API bootstrap failures without restoring old authority", async () => {
    const scenarios = [
      {
        response: jsonResponse(200, {
          csrf_token: "short",
          csrf_generation: 2,
          rotated_at: rotatedAt
        }),
        reason: "invalid_response"
      },
      {
        response: apiErrorResponse(503, "runtime_unavailable", true),
        reason: "api_error"
      },
      {
        response: apiErrorResponse(403, "permission_denied", false),
        reason: "authority_rejected"
      },
      {
        response: apiErrorResponse(409, "operation_conflict", false),
        reason: "stale_generation"
      }
    ] as const;

    for (const scenario of scenarios) {
      const test = harness({ fetch: async () => scenario.response });
      test.client.adoptBootstrap(bootstrapPayload(rawToken, 1, rotatedAt));

      await expectCsrfFailure(test.client.bootstrap(), scenario.reason);

      expect(test.requests).toHaveLength(1);
      expect(test.client.snapshot()).toMatchObject({
        phase: "failed",
        generation: null,
        rotatedAt: null,
        failure: { reason: scenario.reason }
      });
      expect(JSON.stringify(test.client.snapshot())).not.toContain(rawToken);
    }
  });

  it("arbitrates adopted generation, timestamp, duplicate, and pairing boundaries", () => {
    const test = harness();
    const first = test.client.adoptBootstrap(
      bootstrapPayload(rawToken, 4, rotatedAt)
    );
    const lower = test.client.adoptBootstrap(
      bootstrapPayload("B".repeat(43), 3, "2026-07-22T16:59:00.000Z")
    );
    expect(lower).toBe(first);
    expect(test.client.adoptBootstrap(bootstrapPayload(rawToken, 4, rotatedAt))).toBe(
      first
    );

    expect(
      test.client.adoptBootstrap(bootstrapPayload(newerToken, 6, laterAt))
    ).toMatchObject({ phase: "ready", generation: 6, rotatedAt: laterAt });
    expect(() =>
      test.client.adoptBootstrap(bootstrapPayload("E".repeat(43), 6, laterAt))
    ).toThrow(expect.objectContaining({ reason: "stale_generation" }));
    expect(test.client.snapshot()).toMatchObject({ phase: "failed", generation: null });

    test.client.invalidate("pairing_replaced");
    expect(
      test.client.adoptBootstrap(bootstrapPayload("F".repeat(43), 1, rotatedAt))
    ).toMatchObject({ phase: "ready", generation: 1 });

    const regressing = harness().client;
    regressing.adoptBootstrap(bootstrapPayload(rawToken, 2, laterAt));
    expect(() =>
      regressing.adoptBootstrap(bootstrapPayload(newerToken, 3, rotatedAt))
    ).toThrow(expect.objectContaining({ reason: "client_contract" }));
    expect(regressing.snapshot().phase).toBe("failed");
  });

  it("rejects malformed adoption without invoking accessors or retaining values", () => {
    const test = harness();
    test.client.adoptBootstrap(bootstrapPayload(rawToken, 1, rotatedAt));
    let getterCalls = 0;
    const hostile = Object.defineProperty(
      {
        csrf_generation: 2,
        rotated_at: laterAt
      },
      "csrf_token",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return newerToken;
        }
      }
    );

    expect(() => test.client.adoptBootstrap(hostile as never)).toThrow(
      expect.objectContaining({ reason: "client_contract" })
    );
    expect(getterCalls).toBe(0);
    expect(test.client.snapshot().phase).toBe("failed");
    expect(JSON.stringify(test.client.snapshot())).not.toContain(rawToken);
    expect(JSON.stringify(test.client.snapshot())).not.toContain(newerToken);
  });

  it("discards an old bootstrap response after explicit authority invalidation", async () => {
    const response = deferred<BrowserHttpResponsePort>();
    const test = harness({ fetch: async () => await response.promise });
    const pending = test.client.bootstrap();

    const invalidated = test.client.invalidate("remote_authority_changed");
    response.resolve(jsonResponse(200, bootstrapPayload(rawToken, 9, rotatedAt)));

    await expectCsrfFailure(pending, "authority_changed");
    expect(test.client.snapshot()).toBe(invalidated);
    expect(test.client.snapshot()).toEqual({
      phase: "idle",
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: "remote_authority_changed"
    });
  });

  it("keeps newer adopted authority when an older bootstrap settles late", async () => {
    const response = deferred<BrowserHttpResponsePort>();
    const test = harness({ fetch: async () => await response.promise });
    const pending = test.client.bootstrap();
    await Promise.resolve();

    const adopted = test.client.adoptBootstrap(
      bootstrapPayload(newerToken, 7, laterAt)
    );
    await expectCsrfFailure(pending, "authority_changed");
    response.resolve(
      jsonResponse(200, bootstrapPayload("E".repeat(43), 8, laterAt))
    );

    expect(test.client.snapshot()).toBe(adopted);
    expect(test.client.snapshot()).toMatchObject({
      phase: "ready",
      generation: 7,
      rotatedAt: laterAt
    });
    expect(JSON.stringify(test.client.snapshot())).not.toContain(newerToken);
    expect(JSON.stringify(test.client.snapshot())).not.toContain("E".repeat(43));
  });

  it("injects the exact current credential into all 11 protected routes", async () => {
    const test = harness({
      fetch: async () => apiErrorResponse(503, "runtime_unavailable", false)
    });
    test.client.adoptBootstrap(bootstrapPayload(rawToken, 27, rotatedAt));

    await expectCsrfFailure(
      test.client.request("session_start", {
        body: {
          operation_id: "op_csrf_route_session_start",
          name: "csrf-route-test",
          cwd: "/tmp/hostdeck-csrf-route"
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("session_archive", {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_csrf_route_archive",
          kind: "archive",
          confirm: true
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("prompt_dispatch", {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_csrf_route_prompt",
          kind: "prompt",
          text: "Continue."
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("model_select", {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_csrf_route_model",
          kind: "model",
          model_id: "gpt-5.5-codex",
          reasoning_effort: "high",
          expected_pending_revision: null
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("goal_mutate", {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_csrf_route_goal",
          kind: "goal",
          action: "set",
          objective: "Complete the selected task.",
          expected_goal_revision: null
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("plan_select", {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_csrf_route_plan",
          kind: "plan",
          action: "enter",
          expected_pending_revision: null
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("compact_start", {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_csrf_route_compact",
          kind: "compact",
          confirm: true
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("approval_respond", {
        params: {
          session_id: sessionId,
          request_id: "string:browser-csrf-approval"
        },
        body: {
          operation_id: "op_csrf_route_approval",
          kind: "approval_response",
          decision: "approve",
          confirm: true
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("turn_interrupt", {
        params: { session_id: sessionId, turn_id: "turn-browser-csrf" },
        body: {
          operation_id: "op_csrf_route_interrupt",
          kind: "interrupt",
          confirm: true
        }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("device_revoke", {
        params: { device_id: "client_browser_csrf_other" },
        body: { operation_id: "op_csrf_route_revoke", confirmed: true }
      }),
      "api_error"
    );
    await expectCsrfFailure(
      test.client.request("host_lock", {
        body: { operation_id: "op_csrf_route_lock", confirmed: true }
      }),
      "api_error"
    );

    expect(test.requests).toHaveLength(11);
    expect(
      test.requests.every(
        ({ init }) =>
          init.headers["x-hostdeck-csrf"] === rawToken &&
          init.headers["x-hostdeck-csrf-generation"] === "27"
      )
    ).toBe(true);
    expect(test.client.snapshot()).toMatchObject({ phase: "ready", generation: 27 });
    expect(test.operationIds).toBe(0);
  });

  it("rejects non-protected routes and caller credential overrides before fetch", async () => {
    const test = harness();
    test.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    const request = test.client.request as unknown as (
      routeId: string,
      input: unknown,
      options?: unknown
    ) => Promise<unknown>;

    await expectCsrfFailure(request("health_liveness", {}), "client_contract");
    await expectCsrfFailure(
      request(
        "host_lock",
        { body: { operation_id: "op_csrf_override", confirmed: true } },
        { csrfToken: newerToken, csrfGeneration: "99" }
      ),
      "client_contract"
    );
    expect(test.requests).toHaveLength(0);
    expect(test.client.snapshot().phase).toBe("ready");
  });

  it("clears authority on permission, read-only, and conflict responses without bootstrap", async () => {
    for (const scenario of [
      { code: "permission_denied", status: 403, reason: "authority_rejected" },
      { code: "read_only", status: 403, reason: "authority_rejected" },
      { code: "operation_conflict", status: 409, reason: "stale_generation" }
    ] as const) {
      const test = harness({
        fetch: async () => apiErrorResponse(scenario.status, scenario.code, false)
      });
      test.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));

      await expectCsrfFailure(
        test.client.request("host_lock", {
          body: { operation_id: `op_csrf_${scenario.code}`, confirmed: true }
        }),
        scenario.reason
      );
      expect(test.client.snapshot()).toMatchObject({
        phase: "failed",
        generation: null,
        failure: { reason: scenario.reason }
      });
      expect(test.requests).toHaveLength(1);
      expect(test.operationIds).toBe(0);
      await expectCsrfFailure(
        test.client.request("host_lock", {
          body: { operation_id: "op_csrf_no_loop", confirmed: true }
        }),
        "not_ready"
      );
      expect(test.requests).toHaveLength(1);
    }
  });

  it("preserves authority across non-authority API, transport, and caller failures", async () => {
    const api = harness({
      fetch: async () => apiErrorResponse(503, "runtime_unavailable", true)
    });
    api.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    const apiError = await expectCsrfFailure(
      api.client.request("host_lock", {
        body: { operation_id: "op_csrf_api_failure", confirmed: true }
      }),
      "api_error"
    );
    expect(apiError.apiError).toMatchObject({
      code: "runtime_unavailable",
      retryable: true
    });
    expect(api.client.snapshot().phase).toBe("ready");
    expect(api.requests).toHaveLength(1);

    const transport = harness({
      fetch: async () => {
        throw new Error(`${rawToken}:transport-private`);
      }
    });
    transport.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    await expectCsrfFailure(
      transport.client.request("host_lock", {
        body: { operation_id: "op_csrf_transport_failure", confirmed: true }
      }),
      "api_error"
    );
    expect(transport.client.snapshot().phase).toBe("ready");

    const aborted = harness();
    aborted.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    const controller = new AbortController();
    controller.abort();
    await expectCsrfFailure(
      aborted.client.request(
        "host_lock",
        { body: { operation_id: "op_csrf_caller_abort", confirmed: true } },
        { signal: controller.signal }
      ),
      "caller_aborted"
    );
    expect(aborted.requests).toHaveLength(0);
    expect(aborted.client.snapshot().phase).toBe("ready");
  });

  it("aborts active mutations on invalidation and rejects late success by epoch", async () => {
    const responses = [
      deferred<BrowserHttpResponsePort>(),
      deferred<BrowserHttpResponsePort>()
    ];
    let responseIndex = 0;
    const test = harness({
      fetch: async () => {
        const response = responses[responseIndex++];
        if (response === undefined) throw new Error("Unexpected third mutation.");
        return await response.promise;
      }
    });
    test.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    const first = test.client.request("host_lock", {
      body: { operation_id: "op_csrf_active_invalidate", confirmed: true }
    });
    const second = test.client.request("host_lock", {
      body: { operation_id: "op_csrf_active_invalidate_2", confirmed: true }
    });
    await Promise.resolve();

    const invalidated = test.client.invalidate("access_lost");
    await Promise.all([
      expectCsrfFailure(first, "authority_changed"),
      expectCsrfFailure(second, "authority_changed")
    ]);
    expect(test.requests).toHaveLength(2);
    expect(test.requests.every(({ init }) => init.signal.aborted)).toBe(true);
    for (const response of responses) {
      response.resolve(
        jsonResponse(200, {
          authentication_state: "paired_device",
          device_id: "client_browser_csrf",
          permission: "write",
          device_expires_at: "2026-07-23T17:00:00.000Z",
          configured_origin: remoteOrigin,
          network_mode: "remote",
          transport: "https",
          locked: true,
          can_read_sessions: true,
          can_write_sessions: false,
          can_lock: true,
          can_unlock: false
        })
      );
    }
    expect(test.client.snapshot()).toBe(invalidated);
    expect(test.client.snapshot().invalidationReason).toBe("access_lost");
  });

  it("aborts active mutations before bootstrap and rejects their late success", async () => {
    const mutationResponse = deferred<BrowserHttpResponsePort>();
    const test = harness({
      fetch: async (path) =>
        path === "/api/v1/access/lock"
          ? await mutationResponse.promise
          : jsonResponse(200, bootstrapPayload(newerToken, 3, laterAt))
    });
    test.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    const mutation = test.client.request("host_lock", {
      body: { operation_id: "op_csrf_rotation_abort", confirmed: true }
    });
    await Promise.resolve();

    const bootstrap = test.client.bootstrap();
    await expectCsrfFailure(mutation, "authority_changed");
    await expect(bootstrap).resolves.toMatchObject({
      phase: "ready",
      generation: 3,
      rotatedAt: laterAt
    });
    mutationResponse.resolve(
      jsonResponse(200, {
        authentication_state: "paired_device",
        device_id: "client_browser_csrf",
        permission: "write",
        device_expires_at: null,
        configured_origin: remoteOrigin,
        network_mode: "remote",
        transport: "https",
        locked: true,
        can_read_sessions: true,
        can_write_sessions: false,
        can_lock: true,
        can_unlock: false
      })
    );
    expect(test.requests.map(({ path }) => path)).toEqual([
      "/api/v1/access/lock",
      "/api/v1/access/csrf"
    ]);
    expect(test.client.snapshot()).toMatchObject({ phase: "ready", generation: 3 });
  });

  it("applies every explicit invalidation reason without fetch and rejects unknown reasons", async () => {
    for (const reason of browserCsrfInvalidationReasons) {
      const test = harness();
      test.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));

      const first = test.client.invalidate(reason);
      const repeated = test.client.invalidate(reason);

      expect(first).toEqual({
        phase: "idle",
        generation: null,
        rotatedAt: null,
        failure: null,
        invalidationReason: reason
      });
      expect(repeated).toEqual(first);
      expect(test.requests).toHaveLength(0);
    }

    const retained = harness().client;
    retained.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    expect(() => retained.invalidate("unknown" as never)).toThrow(
      expect.objectContaining({ reason: "client_contract" })
    );
    expect(retained.snapshot()).toMatchObject({ phase: "ready", generation: 2 });
  });

  it("closes idempotently, aborts bootstrap, and permits no later authority", async () => {
    const response = deferred<BrowserHttpResponsePort>();
    const test = harness({ fetch: async () => await response.promise });
    const pending = test.client.bootstrap();
    const closed = test.client.close();
    expect(test.client.close()).toBe(closed);
    expect(closed.phase).toBe("closed");
    await expectCsrfFailure(pending, "closed");
    await expectCsrfFailure(test.client.bootstrap(), "closed");
    await expectCsrfFailure(
      test.client.request("host_lock", {
        body: { operation_id: "op_csrf_closed", confirmed: true }
      }),
      "closed"
    );
    expect(() =>
      test.client.adoptBootstrap(bootstrapPayload(rawToken, 3, laterAt))
    ).toThrow(expect.objectContaining({ reason: "closed" }));
    expect(test.client.invalidate("caller_reset")).toBe(closed);
    expect(test.requests).toHaveLength(0);
  });

  it("keeps public state and failures immutable and token-free", async () => {
    const privateIdentity = "private-user@example.test";
    const test = harness({
      fetch: async () => {
        throw new Error(`${rawToken}:${privateIdentity}:${remoteOrigin}`);
      }
    });
    test.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    const error = await expectCsrfFailure(
      test.client.request("host_lock", {
        body: { operation_id: "op_csrf_privacy", confirmed: true }
      }),
      "api_error"
    );
    const serialized = JSON.stringify({ error, snapshot: test.client.snapshot() });
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain(privateIdentity);
    expect(serialized).not.toContain(remoteOrigin);
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.keys(error).sort()).toEqual([
      "apiError",
      "name",
      "operation",
      "reason",
      "routeId",
      "status",
      "transport"
    ]);
    expect(Object.isFrozen(test.client.snapshot())).toBe(true);
    expect(browserCsrfInvalidationReasons).toEqual([
      "access_lost",
      "remote_authority_changed",
      "device_revoked",
      "pairing_replaced",
      "caller_reset"
    ]);

    const echoed = harness({
      fetch: async () =>
        jsonResponse(503, {
          error: {
            code: "runtime_unavailable",
            message: `${rawToken}:${privateIdentity}:${remoteOrigin}`,
            retryable: true
          }
        })
    });
    echoed.client.adoptBootstrap(bootstrapPayload(rawToken, 2, rotatedAt));
    const echoedError = await expectCsrfFailure(
      echoed.client.request("host_lock", {
        body: { operation_id: "op_csrf_echoed_api_failure", confirmed: true }
      }),
      "api_error"
    );
    expect(echoedError.apiError).toEqual({
      code: "runtime_unavailable",
      message: "The HostDeck API request failed.",
      retryable: true
    });
    expect(Object.isFrozen(echoedError.apiError)).toBe(true);
    expect(JSON.stringify(echoedError)).not.toContain(rawToken);
    expect(JSON.stringify(echoedError)).not.toContain(privateIdentity);
    expect(JSON.stringify(echoedError)).not.toContain(remoteOrigin);
  });
});

function harness(options: {
  readonly fetch?: BrowserHttpFetchPort;
} = {}): {
  readonly client: BrowserCsrfClient;
  readonly requests: Array<{ readonly path: string; readonly init: BrowserHttpRequestInit }>;
  readonly operationIds: number;
} {
  const requests: Array<{ path: string; init: BrowserHttpRequestInit }> = [];
  let operationIds = 0;
  const fetch: BrowserHttpFetchPort = async (path, init) => {
    requests.push({ path, init });
    return options.fetch === undefined
      ? jsonResponse(200, bootstrapPayload(rawToken, 2, rotatedAt))
      : await options.fetch(path, init);
  };
  const client = createBrowserCsrfClient({
    httpClient: createBrowserHttpClient({ origin: remoteOrigin, fetch }),
    createOperationId: () => {
      operationIds += 1;
      return `op_browser_csrf_bootstrap_${String(operationIds).padStart(4, "0")}`;
    }
  });
  return {
    client,
    requests,
    get operationIds() {
      return operationIds;
    }
  };
}

function bootstrapPayload(token: string, generation: number, at: string) {
  return Object.freeze({
    csrf_token: token,
    csrf_generation: generation,
    rotated_at: at
  });
}

function apiErrorResponse(
  status: number,
  code: "operation_conflict" | "permission_denied" | "read_only" | "runtime_unavailable",
  retryable: boolean
): BrowserHttpResponsePort {
  return jsonResponse(status, {
    error: {
      code,
      message: "Bounded browser CSRF fixture failure.",
      retryable
    }
  });
}

function jsonResponse(status: number, payload: unknown): BrowserHttpResponsePort {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let read = false;
  return Object.freeze({
    status,
    ok: status >= 200 && status < 300,
    headers: Object.freeze({
      get(name: string) {
        if (name.toLowerCase() === "content-type") return "application/json";
        if (name.toLowerCase() === "content-length") return String(bytes.byteLength);
        return null;
      }
    }),
    body: Object.freeze({
      getReader() {
        return Object.freeze({
          async read() {
            if (read) return Object.freeze({ done: true as const });
            read = true;
            return Object.freeze({ done: false as const, value: bytes });
          },
          async cancel() {
            read = true;
          },
          releaseLock() {}
        });
      }
    })
  });
}

async function expectCsrfFailure(
  operation: Promise<unknown>,
  reason: HostDeckBrowserCsrfError["reason"]
): Promise<HostDeckBrowserCsrfError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckBrowserCsrfError);
    expect(error).toMatchObject({ reason });
    return error as HostDeckBrowserCsrfError;
  }
  throw new Error("Expected browser CSRF operation to fail.");
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
