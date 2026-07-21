import type {
  CodexSkillsClient,
  CodexSkillsListing
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  skillsOperationIntentSchema,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import type { OperationDeadline } from "@hostdeck/core";
import {
  HostDeckAuthRepositoryError,
  type SelectedSessionState,
  type SelectedStateRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexSkillsControlErrorCode,
  type CodexSkillsControlService,
  createCodexSkillsControlService,
  HostDeckCodexSkillsControlError
} from "./codex-skills-control-service.js";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import { hostDeckLoopbackTestOrigin, injectHostDeckLoopback } from "./fastify-loopback-test-request.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckDeviceAuthenticationPort,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  type HostDeckRequestTrustPolicy
} from "./fastify-request-trust.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import {
  createHostDeckSkillsRouteRegistration,
  hostDeckSkillsRouteRegistrationId
} from "./skills-routes.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

const apps: HostDeckFastifyInstance[] = [];
const sessionId = "sess_skills_route_001";
const otherSessionId = "sess_skills_route_002";
const threadId = "thread-skills-route-001";
const otherThreadId = "thread-skills-route-002";
const selectedCwd = "/tmp/hostdeck-skills-route";
const createdAt = "2026-07-15T14:00:00.000Z";
const observedAt = "2026-07-15T14:05:00.000Z";
const readToken = "R".repeat(43);
const writeToken = "W".repeat(43);
const expiredToken = "E".repeat(43);
const storageToken = "S".repeat(43);
const loopbackOrigin = hostDeckLoopbackTestOrigin;
const remoteLocalOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-skills.fixture-tailnet.ts.net";
const remoteSource = "100.90.80.71";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigin: loopbackOrigin
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

describe("selected skills read route", () => {
  it("requires exact accessor-free ports and snapshots receiverless methods", async () => {
    let stateThis: unknown = "not-called";
    let skillsThis: unknown = "not-called";
    let observedIntent: unknown;
    let observedDeadline: OperationDeadline | undefined;
    const mutableState: { get: SelectedStateRepository["get"] } = {
      get: function getState(this: void) {
        stateThis = this;
        return selectedState();
      }
    };
    const mutableSkills: { list: CodexSkillsControlService["list"] } = {
      list: async function listSkills(this: void, intent, deadline) {
        skillsThis = this;
        observedIntent = intent;
        observedDeadline = deadline;
        return skillsSnapshot();
      }
    };
    const registration = createHostDeckSkillsRouteRegistration({
      skills: mutableSkills,
      state: mutableState
    });
    expect(registration).toMatchObject({
      id: hostDeckSkillsRouteRegistrationId,
      surface: "api"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    mutableState.get = () => {
      throw new Error("mutated-state-private-sentinel");
    };
    mutableSkills.list = async () => {
      throw new Error("mutated-skills-private-sentinel");
    };
    const app = createSkillsAppFromRegistration(registration);
    await app.ready();
    const response = await injectHostDeckLoopback(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/skills`
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(stateThis).toBeUndefined();
    expect(skillsThis).toBeUndefined();
    expect(skillsOperationIntentSchema.parse(observedIntent)).toMatchObject({
      kind: "skills",
      operation_id: expect.stringMatching(/^op_skills_read_[0-9a-f]{32}$/u),
      target: {
        type: "managed_session",
        session_id: sessionId,
        codex_thread_id: threadId
      }
    });
    expect(observedDeadline?.signal).toBeInstanceOf(AbortSignal);

    const nullState = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { get: () => selectedState() }
    );
    const nullSkills = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { list: async () => skillsSnapshot() }
    );
    const nullInput = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { skills: nullSkills, state: nullState }
    );
    expect(() =>
      createHostDeckSkillsRouteRegistration(nullInput as never)
    ).not.toThrow();

    let accessorCalls = 0;
    const inputAccessor = Object.defineProperty({}, "state", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("input-accessor-private-sentinel");
      }
    });
    Object.defineProperty(inputAccessor, "skills", {
      enumerable: true,
      value: { list: async () => skillsSnapshot() }
    });
    const skillsAccessor = Object.defineProperty({}, "list", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("skills-accessor-private-sentinel");
      }
    });
    const hostileProxy = new Proxy(
      {
        skills: { list: async () => skillsSnapshot() },
        state: { get: () => selectedState() }
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
      {
        skills: { list: async () => skillsSnapshot() },
        state: { get: () => selectedState() },
        extra: true
      },
      Object.assign(Object.create({ inherited: true }), {
        skills: { list: async () => skillsSnapshot() },
        state: { get: () => selectedState() }
      }),
      { skills: null, state: { get: () => selectedState() } },
      { skills: {}, state: { get: () => selectedState() } },
      { skills: { list: null }, state: { get: () => selectedState() } },
      {
        skills: { list: async () => skillsSnapshot(), extra: true },
        state: { get: () => selectedState() }
      },
      { skills: { list: async () => skillsSnapshot() }, state: null },
      { skills: { list: async () => skillsSnapshot() }, state: {} },
      {
        skills: { list: async () => skillsSnapshot() },
        state: { get: null }
      },
      {
        skills: { list: async () => skillsSnapshot() },
        state: { get: () => selectedState(), extra: true }
      },
      inputAccessor,
      { skills: skillsAccessor, state: { get: () => selectedState() } },
      hostileProxy
    ]) {
      expect(() =>
        createHostDeckSkillsRouteRegistration(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("composes the real control service on the exact no-store GET and propagates cancellation", async () => {
    let stateReads = 0;
    let listCalls = 0;
    let observedInput: unknown;
    const state = selectedState();
    const states = {
      get(candidate: string) {
        stateReads += 1;
        return candidate === sessionId ? state : null;
      }
    };
    const runtime: CodexSkillsClient = {
      get runtime_version() {
        return "0.144.0";
      },
      get connection_generation() {
        return 3;
      },
      async listForCwd(input) {
        listCalls += 1;
        observedInput = input;
        return skillsListing();
      }
    };
    const skills = createCodexSkillsControlService({ states, skills: runtime });
    const app = createSkillsApp(
      { get: states.get },
      { list: skills.list }
    );
    await app.ready();

    const response = await injectHostDeckLoopback(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/skills`
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(skillsSnapshot());
    expect(stateReads).toBe(3);
    expect(listCalls).toBe(1);
    expect(observedInput).toMatchObject({ cwd: selectedCwd });
    expect(
      (observedInput as { deadline?: OperationDeadline }).deadline?.signal
    ).toBeInstanceOf(AbortSignal);
    expect(response.body).not.toMatch(
      /hostdeck-skills-route|skill-private|dependency-private|prompt-private/iu
    );

    const readsBeforeInvalid = stateReads;
    for (const request of [
      {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/skills?cwd=%2Fprivate&forceReload=false`,
        status: 400,
        code: "validation_error",
        field: "query"
      },
      {
        method: "GET",
        url: "/api/v1/sessions/session%20with%20spaces/skills",
        status: 400,
        code: "validation_error",
        field: "params"
      },
      {
        method: "HEAD",
        url: `/api/v1/sessions/${sessionId}/skills`,
        status: 405,
        code: "method_not_allowed"
      },
      {
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/skills`,
        status: 405,
        code: "method_not_allowed"
      },
      {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/skills/`,
        status: 404,
        code: "route_not_found"
      },
      {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/Skills`,
        status: 404,
        code: "route_not_found"
      }
    ] as const) {
      const invalid = await injectHostDeckLoopback(app, request);
      expectStableError(
        invalid,
        request.status,
        request.code,
        "field" in request ? request.field : undefined
      );
    }
    expect(stateReads).toBe(readsBeforeInvalid);
    expect(listCalls).toBe(1);
  });

  it("authenticates before validation, state resolution, and runtime access", async () => {
    let stateReads = 0;
    let skillsReads = 0;
    const app = createSkillsApp(
      {
        get() {
          stateReads += 1;
          return selectedState();
        }
      },
      {
        async list() {
          skillsReads += 1;
          return skillsSnapshot();
        }
      },
      {
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_skills_reader");
          }
          if (rawDeviceToken === writeToken) {
            return authenticatedDevice("write", "client_skills_writer");
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
        await injectHostDeckLoopback(app, {
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/skills`
        })
      ).statusCode
    ).toBe(200);
    for (const token of [readToken, writeToken]) {
      const paired = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/skills`,
        headers: deviceCookie(token)
      });
      expect(paired.statusCode, paired.body).toBe(200);
    }
    expect(stateReads).toBe(3);
    expect(skillsReads).toBe(3);

    for (const token of [expiredToken, "U".repeat(43)]) {
      const denied = await injectHostDeckLoopback(app, {
        method: "GET",
        url: "/api/v1/sessions/bad%20target/skills?cwd=private",
        headers: deviceCookie(token)
      });
      expectStableError(denied, 401, "permission_denied");
      expect(denied.body).not.toMatch(/private|auth|cookie|token/iu);
    }
    const storage = await injectHostDeckLoopback(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/skills`,
      headers: deviceCookie(storageToken)
    });
    expectStableError(storage, 500, "storage_error");
    expect(storage.body).not.toContain("auth-storage-private-sentinel");
    const duplicate = await injectHostDeckLoopback(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/skills`,
      headers: {
        cookie: `${hostDeckDeviceCookieName}=${readToken}; ${hostDeckDeviceCookieName}=${readToken}`
      }
    });
    expectStableError(duplicate, 401, "permission_denied");
    expect(stateReads).toBe(3);
    expect(skillsReads).toBe(3);
  });

  it("requires HostDeck pairing inside admitted Tailscale Serve context", async () => {
    let stateReads = 0;
    let skillsReads = 0;
    const remoteRequestAuthority =
      createHostDeckRemoteIngressRequestAuthorityPolicy();
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice(
              "read",
              "client_remote_skills_reader"
            );
          }
          if (rawDeviceToken === writeToken) {
            return authenticatedDevice(
              "write",
              "client_remote_skills_writer"
            );
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
        createHostDeckSkillsRouteRegistration({
          skills: {
            async list() {
              skillsReads += 1;
              return skillsSnapshot();
            }
          },
          state: {
            get() {
              stateReads += 1;
              return selectedState();
            }
          }
        })
      ],
      remoteIngressRequestAuthority: remoteRequestAuthority,
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: remoteLocalOrigin,
        readRemoteAdmission: () =>
          remoteRequestAuthority.synchronize({
            admission: "open",
            external_origin: externalOrigin,
            generation: 7
          })
      })
    });
    apps.push(app);
    await app.ready();

    const identityOnly = await injectHostDeckLoopback(app, {
      method: "GET",
      url: "/api/v1/sessions/bad%20target/skills?cwd=private",
      headers: remoteHeaders({ identity: true })
    });
    expectStableError(identityOnly, 401, "permission_denied");
    expect(stateReads).toBe(0);
    expect(skillsReads).toBe(0);
    expect(identityOnly.body).not.toMatch(
      /identity-does-not-authorize|remote-auth-private|100\.90\.80\.71/iu
    );

    for (const token of [readToken, writeToken]) {
      const paired = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/skills`,
        headers: remoteHeaders({ cookie: token, identity: true })
      });
      expect(paired.statusCode, paired.body).toBe(200);
      expect(paired.headers["cache-control"]).toBe("no-store");
    }
    expect(stateReads).toBe(2);
    expect(skillsReads).toBe(2);
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
          mapping: { ...selectedState().mapping, id: otherSessionId }
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
    let skillsReads = 0;
    for (const candidate of candidates) {
      const app = createSkillsApp(
        { get: candidate.get },
        {
          async list() {
            skillsReads += 1;
            return skillsSnapshot();
          }
        }
      );
      await app.ready();
      const response = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/skills`
      });
      expectStableError(response, candidate.status, candidate.code);
      expect(response.body).not.toMatch(/private-sentinel|thread-skills/iu);
    }
    expect(skillsReads).toBe(0);
  });

  it("maps every typed skills-control failure without leaking runtime causes", async () => {
    const cases: Array<{
      readonly code: CodexSkillsControlErrorCode;
      readonly apiCode: ConstructorParameters<
        typeof HostDeckCodexSkillsControlError
      >[1];
      readonly expectedCode: string;
      readonly retrySafe: boolean;
      readonly status: number;
    }> = [
      {
        code: "capability_unsupported",
        apiCode: "capability_unavailable",
        expectedCode: "capability_unavailable",
        retrySafe: false,
        status: 409
      },
      {
        code: "invalid_request",
        apiCode: "validation_error",
        expectedCode: "internal_error",
        retrySafe: true,
        status: 500
      },
      {
        code: "runtime_protocol_error",
        apiCode: "protocol_error",
        expectedCode: "protocol_error",
        retrySafe: false,
        status: 502
      },
      {
        code: "runtime_unavailable",
        apiCode: "runtime_unavailable",
        expectedCode: "runtime_unavailable",
        retrySafe: true,
        status: 503
      },
      {
        code: "operation_timeout",
        apiCode: "operation_timeout",
        expectedCode: "operation_timeout",
        retrySafe: true,
        status: 504
      },
      {
        code: "service_overloaded",
        apiCode: "service_overloaded",
        expectedCode: "service_overloaded",
        retrySafe: true,
        status: 503
      },
      {
        code: "state_unavailable",
        apiCode: "storage_error",
        expectedCode: "storage_error",
        retrySafe: true,
        status: 500
      },
      {
        code: "target_mismatch",
        apiCode: "invalid_session_id",
        expectedCode: "invalid_session_id",
        retrySafe: false,
        status: 409
      },
      {
        code: "target_not_found",
        apiCode: "session_not_found",
        expectedCode: "session_not_found",
        retrySafe: false,
        status: 404
      },
      {
        code: "target_not_readable",
        apiCode: "session_not_writable",
        expectedCode: "session_not_writable",
        retrySafe: false,
        status: 409
      },
      {
        code: "target_stale",
        apiCode: "stale_session",
        expectedCode: "stale_session",
        retrySafe: true,
        status: 409
      }
    ];

    for (const testCase of cases) {
      const app = createSkillsApp(
        { get: () => selectedState() },
        {
          async list() {
            throw new HostDeckCodexSkillsControlError(
              testCase.code,
              testCase.apiCode,
              `${testCase.code}-private-runtime-sentinel`,
              testCase.retrySafe,
              { cause: new Error("skills-cause-private-sentinel") }
            );
          }
        }
      );
      await app.ready();
      const response = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/skills`
      });
      const expectedRetry = [
        "operation_timeout",
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
      expect(response.body).not.toMatch(/private-runtime|skills-cause/iu);
    }
  });

  it("treats malformed, cross-target, path-bearing, and unexpected service output as internal failures", async () => {
    const observations: HostDeckInternalErrorObservation[] = [];
    const hostile = Object.defineProperty({}, "target", {
      enumerable: true,
      get() {
        throw new Error("hostile-output-private-sentinel");
      }
    });
    const candidates: Array<() => unknown> = [
      () => ({
        ...skillsSnapshot(),
        target: { ...skillsSnapshot().target, session_id: otherSessionId }
      }),
      () => ({
        ...skillsSnapshot(),
        target: {
          ...skillsSnapshot().target,
          codex_thread_id: otherThreadId
        }
      }),
      () => ({ ...skillsSnapshot(), cwd: "/private/cwd" }),
      () => ({
        ...skillsSnapshot(),
        skills: [
          {
            ...skillsSnapshot().skills[0],
            path: "/private/skill-path"
          }
        ]
      }),
      () => null,
      () => hostile,
      () => {
        throw new Error("unexpected-skills-private-sentinel");
      }
    ];
    for (const candidate of candidates) {
      const app = createSkillsApp(
        { get: () => selectedState() },
        { list: candidate as CodexSkillsControlService["list"] },
        { observations }
      );
      await app.ready();
      const response = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/skills`
      });
      expectStableError(response, 500, "internal_error");
      expect(response.body).not.toMatch(
        /private|skill-path|thread-skills-route/iu
      );
    }
    expect(observations).toHaveLength(candidates.length);
  });
});

interface SkillsAppOptions {
  readonly authenticateDeviceToken?: HostDeckDeviceAuthenticationPort;
  readonly observations?: HostDeckInternalErrorObservation[];
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createSkillsApp(
  state: Pick<SelectedStateRepository, "get">,
  skills: Pick<CodexSkillsControlService, "list">,
  options: SkillsAppOptions = {}
): HostDeckFastifyInstance {
  return createSkillsAppFromRegistration(
    createHostDeckSkillsRouteRegistration({ skills, state }),
    options
  );
}

function createSkillsAppFromRegistration(
  registration: ReturnType<typeof createHostDeckSkillsRouteRegistration>,
  options: SkillsAppOptions = {}
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
            return authenticatedDevice("read", "client_skills_reader");
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
      name: "skills-route",
      codex_thread_id: threadId,
      cwd: selectedCwd,
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
        name: "skills-route",
        codex_thread_id: threadId,
        cwd: selectedCwd,
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

function skillsListing(): CodexSkillsListing {
  const snapshot = skillsSnapshot();
  return {
    runtime_version: snapshot.runtime_version,
    connection_generation: snapshot.connection_generation,
    observed_at: snapshot.observed_at as CodexSkillsListing["observed_at"],
    state: snapshot.state,
    skills: snapshot.skills,
    error_count: snapshot.error_count
  };
}

function skillsSnapshot() {
  return skillsSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.144.0",
    connection_generation: 3,
    observed_at: observedAt,
    state: "content",
    skills: [
      {
        name: "alpha",
        description: "Alpha skill.",
        scope: "repo",
        enabled: true
      },
      {
        name: "beta",
        description: null,
        scope: "system",
        enabled: false
      }
    ],
    error_count: 0
  });
}

function authenticatedDevice(
  permission: "read" | "write",
  deviceId: string
) {
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
