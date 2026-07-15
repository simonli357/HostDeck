import type {
  CodexAccountUsageRead,
  CodexUsageClient
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  usageOperationIntentSchema,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import {
  HostDeckAuthRepositoryError,
  type SelectedSessionState,
  type SelectedStateRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexUsageControlErrorCode,
  type CodexUsageControlService,
  createCodexUsageControlService,
  HostDeckCodexUsageControlError
} from "./codex-usage-control-service.js";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckDeviceAuthenticationPort,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  type HostDeckRequestTrustPolicy
} from "./fastify-request-trust.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";
import {
  createHostDeckUsageRouteRegistration,
  hostDeckUsageRouteRegistrationId
} from "./usage-routes.js";

const apps: HostDeckFastifyInstance[] = [];
const sessionId = "sess_usage_route_001";
const otherSessionId = "sess_usage_route_002";
const threadId = "thread-usage-route-001";
const otherThreadId = "thread-usage-route-002";
const createdAt = "2026-07-15T12:00:00.000Z";
const measuredAt = "2026-07-15T12:05:00.000Z";
const readToken = "R".repeat(43);
const writeToken = "W".repeat(43);
const expiredToken = "E".repeat(43);
const storageToken = "S".repeat(43);
const loopbackOrigin = "http://localhost";
const remoteLocalOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-usage.fixture-tailnet.ts.net";
const remoteSource = "100.90.80.70";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: [loopbackOrigin],
  mode: "loopback",
  transport: "http"
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

describe("selected usage read route", () => {
  it("requires exact accessor-free ports and snapshots receiverless methods", async () => {
    let stateThis: unknown = "not-called";
    let usageThis: unknown = "not-called";
    let observedIntent: unknown;
    let observedSignal: AbortSignal | undefined;
    const mutableState: { get: SelectedStateRepository["get"] } = {
      get: function getState(this: void) {
        stateThis = this;
        return selectedState();
      }
    };
    const mutableUsage: { read: CodexUsageControlService["read"] } = {
      read: async function readUsage(this: void, intent, signal) {
        usageThis = this;
        observedIntent = intent;
        observedSignal = signal;
        return usageSnapshot();
      }
    };
    const registration = createHostDeckUsageRouteRegistration({
      state: mutableState,
      usage: mutableUsage
    });
    expect(registration).toMatchObject({
      id: hostDeckUsageRouteRegistrationId,
      surface: "api"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    mutableState.get = () => {
      throw new Error("mutated-state-private-sentinel");
    };
    mutableUsage.read = async () => {
      throw new Error("mutated-usage-private-sentinel");
    };
    const app = createUsageAppFromRegistration(registration);
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/usage`
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(stateThis).toBeUndefined();
    expect(usageThis).toBeUndefined();
    expect(usageOperationIntentSchema.parse(observedIntent)).toMatchObject({
      kind: "usage",
      operation_id: expect.stringMatching(/^op_usage_read_[0-9a-f]{32}$/u),
      target: {
        type: "managed_session",
        session_id: sessionId,
        codex_thread_id: threadId
      }
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);

    const nullState = Object.assign(Object.create(null) as Record<string, unknown>, {
      get: () => selectedState()
    });
    const nullUsage = Object.assign(Object.create(null) as Record<string, unknown>, {
      read: async () => usageSnapshot()
    });
    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      state: nullState,
      usage: nullUsage
    });
    expect(() =>
      createHostDeckUsageRouteRegistration(nullInput as never)
    ).not.toThrow();

    let accessorCalls = 0;
    const inputAccessor = Object.defineProperty({}, "state", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("input-accessor-private-sentinel");
      }
    });
    Object.defineProperty(inputAccessor, "usage", {
      enumerable: true,
      value: { read: async () => usageSnapshot() }
    });
    const stateAccessor = Object.defineProperty({}, "get", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("state-accessor-private-sentinel");
      }
    });
    const hostileProxy = new Proxy(
      {
        state: { get: () => selectedState() },
        usage: { read: async () => usageSnapshot() }
      },
      {
        ownKeys() {
          throw new Error("route-proxy-private-sentinel");
        }
      }
    );
    for (const candidate of [
      null,
      [],
      {},
      { state: { get: () => selectedState() }, usage: { read: async () => usageSnapshot() }, extra: true },
      Object.assign(Object.create({ inherited: true }), {
        state: { get: () => selectedState() },
        usage: { read: async () => usageSnapshot() }
      }),
      { state: null, usage: { read: async () => usageSnapshot() } },
      { state: {}, usage: { read: async () => usageSnapshot() } },
      { state: { get: null }, usage: { read: async () => usageSnapshot() } },
      { state: { get: () => selectedState(), extra: true }, usage: { read: async () => usageSnapshot() } },
      { state: { get: () => selectedState() }, usage: null },
      { state: { get: () => selectedState() }, usage: {} },
      { state: { get: () => selectedState() }, usage: { read: null } },
      { state: { get: () => selectedState() }, usage: { read: async () => usageSnapshot(), extra: true } },
      inputAccessor,
      { state: stateAccessor, usage: { read: async () => usageSnapshot() } },
      hostileProxy
    ]) {
      expect(() =>
        createHostDeckUsageRouteRegistration(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("composes the real control service on the exact no-store GET and propagates cancellation", async () => {
    let stateReads = 0;
    let accountReads = 0;
    let observedSignal: AbortSignal | undefined;
    const state = selectedState();
    const states = {
      get(candidate: string) {
        stateReads += 1;
        return candidate === sessionId ? state : null;
      },
      getByThreadId(candidate: string) {
        return candidate === threadId ? state : null;
      }
    };
    const runtime: CodexUsageClient = {
      get runtime_version() {
        return "0.144.0";
      },
      get connection_generation() {
        return 3;
      },
      async readAccount(signal) {
        accountReads += 1;
        observedSignal = signal;
        return accountUsageRead();
      }
    };
    const usage = createCodexUsageControlService({ states, usage: runtime });
    const app = createUsageApp(
      { get: states.get },
      { read: usage.read }
    );
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/usage`
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(usageSnapshot());
    expect(stateReads).toBe(3);
    expect(accountReads).toBe(1);
    expect(observedSignal).toBeInstanceOf(AbortSignal);

    const readsBeforeInvalid = stateReads;
    for (const request of [
      { method: "GET", url: `/api/v1/sessions/${sessionId}/usage?thread_id=${threadId}`, status: 400, code: "validation_error", field: "query" },
      { method: "GET", url: "/api/v1/sessions/session%20with%20spaces/usage", status: 400, code: "validation_error", field: "params" },
      { method: "HEAD", url: `/api/v1/sessions/${sessionId}/usage`, status: 405, code: "method_not_allowed" },
      { method: "POST", url: `/api/v1/sessions/${sessionId}/usage`, status: 405, code: "method_not_allowed" },
      { method: "GET", url: `/api/v1/sessions/${sessionId}/usage/`, status: 404, code: "route_not_found" },
      { method: "GET", url: `/api/v1/sessions/${sessionId}/Usage`, status: 404, code: "route_not_found" }
    ] as const) {
      const invalid = await app.inject(request);
      expectStableError(
        invalid,
        request.status,
        request.code,
        "field" in request ? request.field : undefined
      );
    }
    expect(stateReads).toBe(readsBeforeInvalid);
    expect(accountReads).toBe(1);
  });

  it("authenticates before validation, state resolution, and runtime access", async () => {
    let stateReads = 0;
    let usageReads = 0;
    const app = createUsageApp(
      {
        get() {
          stateReads += 1;
          return selectedState();
        }
      },
      {
        async read() {
          usageReads += 1;
          return usageSnapshot();
        }
      },
      {
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_usage_reader");
          }
          if (rawDeviceToken === writeToken) {
            return authenticatedDevice("write", "client_usage_writer");
          }
          if (rawDeviceToken === expiredToken) {
            throw new HostDeckAuthRepositoryError(
              "device_expired",
              "expired-auth-private-sentinel"
            );
          }
          if (rawDeviceToken === storageToken) {
            throw new Error("auth-storage-private-sentinel");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "unknown-auth-private-sentinel"
          );
        }
      }
    );
    await app.ready();

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/usage`
        })
      ).statusCode
    ).toBe(200);
    for (const token of [readToken, writeToken]) {
      const paired = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/usage`,
        headers: deviceCookie(token)
      });
      expect(paired.statusCode, paired.body).toBe(200);
    }
    expect(stateReads).toBe(3);
    expect(usageReads).toBe(3);

    for (const token of [expiredToken, "U".repeat(43)]) {
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/sessions/bad%20target/usage?thread_id=private",
        headers: deviceCookie(token)
      });
      expectStableError(denied, 401, "permission_denied");
      expect(denied.body).not.toMatch(/private|auth|cookie|token/iu);
    }
    const storage = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/usage`,
      headers: deviceCookie(storageToken)
    });
    expectStableError(storage, 500, "storage_error");
    expect(storage.body).not.toContain("auth-storage-private-sentinel");
    const duplicate = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/usage`,
      headers: {
        cookie: `${hostDeckDeviceCookieName}=${readToken}; ${hostDeckDeviceCookieName}=${readToken}`
      }
    });
    expectStableError(duplicate, 401, "permission_denied");
    expect(stateReads).toBe(3);
    expect(usageReads).toBe(3);
  });

  it("requires HostDeck pairing inside admitted Tailscale Serve context", async () => {
    let stateReads = 0;
    let usageReads = 0;
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_remote_usage_reader");
          }
          if (rawDeviceToken === writeToken) {
            return authenticatedDevice("write", "client_remote_usage_writer");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "remote-auth-private-sentinel"
          );
        },
        now: () => new Date(createdAt)
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        createHostDeckUsageRouteRegistration({
          state: {
            get() {
              stateReads += 1;
              return selectedState();
            }
          },
          usage: {
            async read() {
              usageReads += 1;
              return usageSnapshot();
            }
          }
        })
      ],
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: remoteLocalOrigin,
        readRemoteAdmission: () => ({
          admission: "open",
          external_origin: externalOrigin,
          generation: 7
        })
      })
    });
    apps.push(app);
    await app.ready();

    const identityOnly = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/bad%20target/usage?thread_id=private",
      headers: remoteHeaders({ identity: true })
    });
    expectStableError(identityOnly, 401, "permission_denied");
    expect(stateReads).toBe(0);
    expect(usageReads).toBe(0);
    expect(identityOnly.body).not.toMatch(
      /identity-does-not-authorize|remote-auth-private|100\.90\.80\.70/iu
    );

    for (const token of [readToken, writeToken]) {
      const paired = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/usage`,
        headers: remoteHeaders({ cookie: token, identity: true })
      });
      expect(paired.statusCode, paired.body).toBe(200);
      expect(paired.headers["cache-control"]).toBe("no-store");
    }
    expect(stateReads).toBe(2);
    expect(usageReads).toBe(2);
  });

  it("fails closed on missing, unavailable, or inconsistent selected state", async () => {
    const candidates: Array<{
      readonly get: Pick<SelectedStateRepository, "get">["get"];
      readonly status: number;
      readonly code: string;
    }> = [
      { get: () => null, status: 404, code: "session_not_found" },
      {
        get() {
          throw new Error("state-read-private-sentinel");
        },
        status: 500,
        code: "storage_error"
      },
      {
        get: () => ({ ...selectedState(), extra: true }) as never,
        status: 500,
        code: "storage_error"
      },
      {
        get: () => ({
          ...selectedState(),
          mapping: {
            ...selectedState().mapping,
            id: otherSessionId
          }
        }) as never,
        status: 500,
        code: "storage_error"
      },
      {
        get: () => ({
          ...selectedState(),
          projection: {
            ...selectedState().projection,
            session: {
              ...selectedState().projection.session,
              codex_thread_id: otherThreadId
            }
          }
        }) as never,
        status: 500,
        code: "storage_error"
      }
    ];
    let usageReads = 0;
    for (const candidate of candidates) {
      const app = createUsageApp(
        { get: candidate.get },
        {
          async read() {
            usageReads += 1;
            return usageSnapshot();
          }
        }
      );
      await app.ready();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/usage`
      });
      expectStableError(response, candidate.status, candidate.code);
      expect(response.body).not.toMatch(/private-sentinel|thread-usage/iu);
    }
    expect(usageReads).toBe(0);
  });

  it("maps every typed usage-control failure without leaking runtime causes", async () => {
    const cases: Array<{
      readonly code: CodexUsageControlErrorCode;
      readonly apiCode: ConstructorParameters<typeof HostDeckCodexUsageControlError>[1];
      readonly expectedCode: string;
      readonly retrySafe: boolean;
      readonly status: number;
    }> = [
      { code: "capability_unsupported", apiCode: "capability_unavailable", expectedCode: "capability_unavailable", retrySafe: false, status: 409 },
      { code: "invalid_request", apiCode: "validation_error", expectedCode: "internal_error", retrySafe: true, status: 500 },
      { code: "observation_conflict", apiCode: "protocol_error", expectedCode: "protocol_error", retrySafe: false, status: 502 },
      { code: "runtime_protocol_error", apiCode: "protocol_error", expectedCode: "protocol_error", retrySafe: false, status: 502 },
      { code: "runtime_unavailable", apiCode: "runtime_unavailable", expectedCode: "runtime_unavailable", retrySafe: true, status: 503 },
      { code: "service_overloaded", apiCode: "service_overloaded", expectedCode: "service_overloaded", retrySafe: true, status: 503 },
      { code: "state_unavailable", apiCode: "storage_error", expectedCode: "storage_error", retrySafe: true, status: 500 },
      { code: "target_mismatch", apiCode: "invalid_session_id", expectedCode: "invalid_session_id", retrySafe: false, status: 409 },
      { code: "target_not_found", apiCode: "session_not_found", expectedCode: "session_not_found", retrySafe: false, status: 404 },
      { code: "target_not_readable", apiCode: "session_not_writable", expectedCode: "session_not_writable", retrySafe: false, status: 409 },
      { code: "target_stale", apiCode: "stale_session", expectedCode: "stale_session", retrySafe: true, status: 409 }
    ];
    for (const testCase of cases) {
      const app = createUsageApp(
        { get: () => selectedState() },
        {
          async read() {
            throw new HostDeckCodexUsageControlError(
              testCase.code,
              testCase.apiCode,
              `${testCase.code}-private-runtime-sentinel`,
              testCase.retrySafe,
              { cause: new Error("usage-cause-private-sentinel") }
            );
          }
        }
      );
      await app.ready();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/usage`
      });
      const expectedRetry = [
        "runtime_unavailable",
        "service_overloaded",
        "state_unavailable",
        "target_stale"
      ].includes(testCase.code)
        ? testCase.retrySafe
        : false;
      expectStableError(
        response,
        testCase.status,
        testCase.expectedCode,
        undefined,
        expectedRetry
      );
      expect(response.json()).toMatchObject({
        error: { session_id: sessionId }
      });
      expect(response.body).not.toMatch(/private-runtime|usage-cause/iu);
    }
  });

  it("treats malformed, cross-target, and unexpected service output as internal failures", async () => {
    const observations: HostDeckInternalErrorObservation[] = [];
    const candidates: Array<() => unknown> = [
      () => ({
        ...usageSnapshot(),
        target: {
          ...usageSnapshot().target,
          session_id: otherSessionId
        }
      }),
      () => ({
        ...usageSnapshot(),
        target: {
          ...usageSnapshot().target,
          codex_thread_id: otherThreadId
        }
      }),
      () => ({ ...usageSnapshot(), terminal_output: "private terminal" }),
      () => null,
      () => {
        throw new Error("unexpected-usage-private-sentinel");
      }
    ];
    for (const candidate of candidates) {
      const app = createUsageApp(
        { get: () => selectedState() },
        { read: candidate as CodexUsageControlService["read"] },
        { observations }
      );
      await app.ready();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/usage`
      });
      expectStableError(response, 500, "internal_error");
      expect(response.body).not.toMatch(
        /private|terminal|thread-usage-route/iu
      );
    }
    expect(observations).toHaveLength(candidates.length);
  });
});

interface UsageAppOptions {
  readonly authenticateDeviceToken?: HostDeckDeviceAuthenticationPort;
  readonly observations?: HostDeckInternalErrorObservation[];
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createUsageApp(
  state: Pick<SelectedStateRepository, "get">,
  usage: Pick<CodexUsageControlService, "read">,
  options: UsageAppOptions = {}
): HostDeckFastifyInstance {
  return createUsageAppFromRegistration(
    createHostDeckUsageRouteRegistration({ state, usage }),
    options
  );
}

function createUsageAppFromRegistration(
  registration: ReturnType<typeof createHostDeckUsageRouteRegistration>,
  options: UsageAppOptions = {}
): HostDeckFastifyInstance {
  const app = createHostDeckFastifyApp({
    observeInternalError(observation) {
      options.observations?.push(observation);
    },
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken:
        options.authenticateDeviceToken ??
        (({ rawDeviceToken }) => {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_usage_reader");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Device authentication failed."
          );
        }),
      now: () => new Date(createdAt)
    }),
    requestTrustPolicy: options.trustPolicy ?? loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  apps.push(app);
  return app;
}

function selectedState(): SelectedSessionState {
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: sessionId,
      name: "usage-route",
      codex_thread_id: threadId,
      cwd: "/tmp/hostdeck-usage-route",
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      disposition: "selected",
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: null
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: sessionId,
        name: "usage-route",
        codex_thread_id: threadId,
        cwd: "/tmp/hostdeck-usage-route",
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        created_at: createdAt,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: createdAt,
        last_activity_at: null,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

function accountUsageRead(): CodexAccountUsageRead {
  return {
    runtime_version: "0.144.0",
    connection_generation: 3,
    observed_at: measuredAt as CodexAccountUsageRead["observed_at"],
    account: usageSnapshot().account
  };
}

function usageSnapshot() {
  return usageSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.144.0",
    connection_generation: 3,
    measured_at: measuredAt,
    account: {
      scope: "account",
      summary: {
        lifetime_tokens: 100,
        peak_daily_tokens: 60,
        longest_running_turn_seconds: 30,
        current_streak_days: 2,
        longest_streak_days: 4
      },
      daily_buckets: [
        { start_date: "2026-07-14", tokens: 40 },
        { start_date: "2026-07-15", tokens: 60 }
      ]
    },
    thread: { state: "not_observed", scope: "thread" },
    rate_limits: { state: "not_observed", scope: "runtime" }
  });
}

function authenticatedDevice(permission: "read" | "write", deviceId: string) {
  return {
    trusted: true as const,
    readOnly: permission === "read",
    device: {
      id: deviceId,
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: createdAt,
      client_label: "Phone",
      permission,
      created_at: createdAt,
      last_used_at: createdAt,
      expires_at: null,
      revoked_at: null
    }
  };
}

function deviceCookie(rawDeviceToken: string): Readonly<Record<string, string>> {
  return { cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}` };
}

function remoteHeaders(options: {
  readonly cookie?: string;
  readonly identity?: boolean;
}): Record<string, string> {
  const authority = new URL(externalOrigin).host;
  const headers: Record<string, string> = {
    host: authority,
    "x-forwarded-for": remoteSource,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (options.cookie !== undefined) {
    headers.cookie = `${hostDeckDeviceCookieName}=${options.cookie}`;
  }
  if (options.identity) {
    headers["tailscale-headers-info"] =
      "https://tailscale.com/s/serve-headers";
    headers["tailscale-user-login"] =
      "identity-does-not-authorize@example.test";
    headers["tailscale-user-name"] = "Identity Does Not Authorize";
    headers["tailscale-user-profile-pic"] = "https://example.test/avatar";
  }
  return headers;
}

function expectStableError(
  response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>,
  status: number,
  code: string,
  field?: string,
  retryable = false
): void {
  const requestId = response.headers["x-request-id"];
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.json()).toMatchObject({
    error: {
      code,
      retryable,
      details: { request_id: requestId },
      ...(field === undefined ? {} : { field })
    }
  });
}
