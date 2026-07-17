import {
  defaultResourceBudget,
  remoteIngressPublicStateSchema
} from "@hostdeck/contracts";
import { HostDeckAuthRepositoryError } from "@hostdeck/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import {
  createHostDeckHealthRouteRegistration,
  hostDeckHealthRouteRegistrationId
} from "./health-routes.js";
import {
  createHostDeckHostHealthService,
  type HostDeckHostHealthService,
  type HostDeckLocalHealthComponent,
  type HostDeckReportedLocalHealthReason
} from "./host-health.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

const apps: HostDeckFastifyInstance[] = [];
const initialTime = Date.parse("2026-07-16T21:00:00.000Z");
const createdAt = "2026-07-16T20:00:00.000Z";
const loopbackOrigin = "http://localhost";
const remoteLocalOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-health-route.fixture-tailnet.ts.net";
const remoteSource = "100.91.82.73";
const readToken = "R".repeat(43);
const writeToken = "W".repeat(43);
const expiredToken = "E".repeat(43);
const invalidToken = "I".repeat(43);
const storageToken = "S".repeat(43);
const readDeviceId = "client_health_reader";
const writeDeviceId = "client_health_writer";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: [loopbackOrigin],
  mode: "loopback",
  transport: "http"
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

describe("selected health and host-status routes", () => {
  it("requires one branded health service and returns one immutable registration", () => {
    const health = healthHarness().service;
    const registration = createHostDeckHealthRouteRegistration({ health });
    expect(registration).toMatchObject({
      id: hostDeckHealthRouteRegistrationId,
      surface: "api"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    expect(() => createHostDeckHealthRouteRegistration({ health })).toThrow(
      "already owns"
    );

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "health", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return health;
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { health, extra: true },
      Object.assign(Object.create({ inherited: true }), { health }),
      { health: Object.freeze({ ...health }) },
      accessor
    ]) {
      expect(() =>
        createHostDeckHealthRouteRegistration(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("keeps liveness public, exact, no-store, and independent of auth and health state", async () => {
    const health = healthHarness();
    let authCalls = 0;
    const harness = createLoopbackApp(health.service, {
      authenticateDeviceToken() {
        authCalls += 1;
        throw new Error("liveness-private-auth-sentinel");
      }
    });
    await harness.app.ready();
    const localBefore = health.service.localSnapshot();
    const remoteBefore = health.service.remoteSnapshot();

    const live = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health/live",
      headers: deviceCookie(invalidToken)
    });
    expect(live.statusCode, live.body).toBe(200);
    expectNoStore(live);
    expect(live.json()).toEqual({ status: "alive" });
    expect(Object.keys(live.json())).toEqual(["status"]);
    expect(authCalls).toBe(0);
    expect(health.clock.calls).toBe(1);
    expect(health.service.localSnapshot()).toBe(localBefore);
    expect(health.service.remoteSnapshot()).toBe(remoteBefore);

    expectStableError(
      await harness.app.inject({
        method: "GET",
        url: "/api/v1/health/live?extra=true"
      }),
      400,
      "validation_error"
    );
    expectStableError(
      await harness.app.inject({ method: "HEAD", url: "/api/v1/health/live" }),
      405,
      "method_not_allowed"
    );
    expectStableError(
      await harness.app.inject({ method: "POST", url: "/api/v1/health/live" }),
      405,
      "method_not_allowed"
    );
    expectStableError(
      await harness.app.inject({ method: "GET", url: "/api/v1/health/live/" }),
      404,
      "route_not_found"
    );
    expect(authCalls).toBe(0);
    expect(harness.observations).toEqual([]);
  });

  it("detaches and deeply freezes public payloads before serialization", async () => {
    const health = healthHarness();
    makeReady(health);
    const harness = createLoopbackApp(health.service);
    const payloads: unknown[] = [];
    harness.app.addHook("preSerialization", async (request, reply, payload) => {
      if (
        reply.statusCode === 200 &&
        [
          "/api/v1/health/live",
          "/api/v1/health/ready",
          "/api/v1/host/status"
        ].includes(request.url)
      ) {
        payloads.push(payload);
      }
      return payload;
    });
    await harness.app.ready();
    const local = health.service.localSnapshot();
    const remote = health.service.remoteSnapshot();

    for (const [url, headers] of [
      ["/api/v1/health/live", {}],
      ["/api/v1/health/ready", {}],
      ["/api/v1/host/status", localAdminHeaders()]
    ] as const) {
      const response = await harness.app.inject({ method: "GET", url, headers });
      expect(response.statusCode, response.body).toBe(200);
    }

    expect(payloads).toHaveLength(3);
    for (const payload of payloads) expectDeepFrozenData(payload);
    const readiness = payloads[1] as {
      readonly components: readonly { readonly causes: readonly string[] }[];
    };
    const status = payloads[2] as {
      readonly local: {
        readonly components: readonly { readonly causes: readonly string[] }[];
      };
      readonly remote: object;
    };
    expect(readiness).not.toBe(local);
    expect(readiness.components).not.toBe(local.components);
    expect(readiness.components[0]?.causes).not.toBe(local.components[0]?.reasons);
    expect(status.local.components).not.toBe(local.components);
    expect(status.remote).not.toBe(remote);
    expect(JSON.stringify(payloads)).not.toMatch(
      /source_generation|device_id|csrf|cookie|token|session|thread|cwd/iu
    );
  });

  it("maps every aggregate state and explicit recovery to exact 503/200 readiness", async () => {
    const health = healthHarness();
    const harness = createLoopbackApp(health.service);
    await harness.app.ready();

    const initial = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health/ready",
      headers: { origin: loopbackOrigin }
    });
    expect(initial.statusCode, initial.body).toBe(503);
    expectNoStore(initial);
    expect(initial.json()).toMatchObject({
      generation: 0,
      state: "unknown",
      readiness: "not_ready"
    });
    expect(initial.json().components).toHaveLength(7);
    expect(initial.body).not.toMatch(
      /mutation_admission|remote|source_generation|session|thread|cwd|token/iu
    );

    makeReady(health);
    const ready = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health/ready"
    });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json()).toMatchObject({
      generation: 7,
      state: "ready",
      readiness: "ready"
    });
    expect(
      ready
        .json()
        .components.every(
          (component: { state: string; causes: unknown[] }) =>
            component.state === "ready" && component.causes.length === 0
        )
    ).toBe(true);

    const proof = health.service.admitMutation();
    health.tick();
    health.service.updateRemote({
      source_generation: 1,
      state: unavailableRemote(1, "client_stopped")
    });
    expect(health.service.assertMutation(proof).generation).toBe(7);
    const remoteOnly = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health/ready"
    });
    expect(remoteOnly.statusCode, remoteOnly.body).toBe(200);
    expect(remoteOnly.json().generation).toBe(7);

    health.tick();
    health.service.updateLocal({
      component: "runtime",
      source_generation: 2,
      state: "degraded",
      reasons: ["runtime_disconnected"]
    });
    const degraded = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health/ready"
    });
    expect(degraded.statusCode, degraded.body).toBe(503);
    expect(degraded.json()).toMatchObject({
      generation: 8,
      state: "degraded",
      readiness: "not_ready"
    });
    expect(degraded.json().components[1]).toMatchObject({
      component: "runtime",
      state: "degraded",
      causes: ["runtime_disconnected"]
    });

    for (const [sourceGeneration, state, reason, generation] of [
      [3, "stale", "source_stale", 9],
      [4, "unknown", "source_unknown", 10],
      [5, "failed", "runtime_failed", 11]
    ] as const) {
      health.tick();
      health.service.updateLocal({
        component: "runtime",
        source_generation: sourceGeneration,
        state,
        reasons: [reason]
      });
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/v1/health/ready"
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({
        generation,
        state,
        readiness: "not_ready"
      });
    }

    health.tick();
    health.service.updateLocal({
      component: "runtime",
      source_generation: 6,
      state: "ready",
      reasons: []
    });
    const recovered = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health/ready"
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      generation: 12,
      state: "ready",
      readiness: "ready"
    });
    expect(health.service.localSnapshot().generation).toBe(12);
    expect(harness.observations).toEqual([]);
  });

  it("closes readiness when any selected local component fails", async () => {
    const health = healthHarness();
    makeReady(health);
    const harness = createLoopbackApp(health.service);
    await harness.app.ready();

    const failures = [
      ["storage", "storage_unavailable"],
      ["runtime", "runtime_failed"],
      ["compatibility", "runtime_incompatible"],
      ["projector", "projector_failed"],
      ["fanout", "fanout_failed"],
      ["listener", "listener_failed"],
      ["lease", "lease_failed"]
    ] as const satisfies readonly (readonly [
      HostDeckLocalHealthComponent,
      HostDeckReportedLocalHealthReason
    ])[];
    for (const [index, [component, reason]] of failures.entries()) {
      health.tick();
      health.service.updateLocal({
        component,
        source_generation: 2,
        state: "failed",
        reasons: [reason]
      });
      const failed = await harness.app.inject({
        method: "GET",
        url: "/api/v1/health/ready"
      });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json()).toMatchObject({
        generation: 8 + index * 2,
        state: "failed",
        readiness: "not_ready"
      });
      expect(failed.json().components[index]).toMatchObject({
        component,
        state: "failed",
        causes: [reason]
      });

      health.tick();
      health.service.updateLocal({
        component,
        source_generation: 3,
        state: "ready",
        reasons: []
      });
    }

    const recovered = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health/ready"
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      generation: 21,
      state: "ready",
      readiness: "ready"
    });
  });

  it("reports local and remote health independently without leaking internal source truth", async () => {
    const health = healthHarness();
    makeReady(health);
    const harness = createLoopbackApp(health.service);
    await harness.app.ready();

    health.tick();
    health.service.failRemote({
      source_generation: 1,
      reason: "observation_failed"
    });
    const failedRemote = await harness.app.inject({
      method: "GET",
      url: "/api/v1/host/status",
      headers: localAdminHeaders()
    });
    expect(failedRemote.statusCode, failedRemote.body).toBe(200);
    expectNoStore(failedRemote);
    expect(failedRemote.json()).toEqual({
      local: {
        generation: 7,
        state: "ready",
        readiness: "ready",
        updated_at: health.service.localSnapshot().updated_at,
        components: health.service.localSnapshot().components.map((component) => ({
          component: component.component,
          state: component.state,
          checked_at: component.checked_at,
          causes: component.reasons
        })),
        mutation_admission: "open"
      },
      remote: {
        generation: 1,
        state_generation: null,
        availability: "unavailable",
        cause: "observation_failed",
        external_origin: null,
        laptop_action_required: true,
        observed_at: null,
        checked_at: health.service.remoteSnapshot().checked_at,
        updated_at: health.service.remoteSnapshot().updated_at
      },
      access: {
        mode: "local_admin",
        network_mode: "loopback",
        transport: "http",
        write_eligibility: {
          scope: "host_health_and_authority",
          eligible: true,
          causes: []
        }
      }
    });

    health.tick();
    health.service.updateRemote({
      source_generation: 2,
      state: readyRemote(2)
    });
    const recovered = await harness.app.inject({
      method: "GET",
      url: "/api/v1/host/status"
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      local: { generation: 7, readiness: "ready", mutation_admission: "open" },
      remote: {
        generation: 2,
        state_generation: 2,
        availability: "ready",
        cause: null,
        external_origin: externalOrigin,
        laptop_action_required: false
      },
      access: {
        mode: "loopback_read",
        write_eligibility: {
          eligible: false,
          causes: ["read_only_access"]
        }
      }
    });
    for (const forbidden of [
      "source_generation",
      "reasons",
      "device_id",
      "csrf_generation",
      "token_hash",
      "session_id",
      "codex_thread_id",
      "/private/project"
    ]) {
      expect(recovered.body).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(recovered.body, "utf8")).toBeLessThan(8_192);
  });

  it("fails atomically with one bounded error when public projection cannot be proven", async () => {
    const health = healthHarness();
    makeReady(health);
    const harness = createLoopbackApp(health.service);
    await harness.app.ready();
    const localBefore = health.service.localSnapshot();
    const remoteBefore = health.service.remoteSnapshot();
    const parse = vi.spyOn(Date, "parse").mockImplementation(() => {
      throw new Error("projection-private-sentinel");
    });

    let response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>;
    try {
      response = await harness.app.inject({
        method: "GET",
        url: "/api/v1/host/status",
        headers: localAdminHeaders()
      });
    } finally {
      parse.mockRestore();
    }

    expectStableError(response, 500, "internal_error");
    expect(response.body).not.toMatch(
      /components|runtime|compatibility|source_generation|projection-private-sentinel/iu
    );
    expect(health.service.localSnapshot()).toBe(localBefore);
    expect(health.service.remoteSnapshot()).toBe(remoteBefore);
    expect(harness.observations).toHaveLength(1);
    expect(harness.observations[0]).toMatchObject({
      request_id: response.headers["x-request-id"],
      error: {
        name: "HostDeckHealthRouteContractError",
        message: "Selected host health route contract failed.",
        stack:
          "HostDeckHealthRouteContractError: Selected host health route contract failed."
      }
    });
    expect(harness.observations[0]?.error).not.toHaveProperty("cause");
  });

  it("derives local browser, local-admin, paired-read, and paired-write preflight exactly", async () => {
    const health = healthHarness();
    const harness = createLoopbackApp(health.service);
    await harness.app.ready();

    const initialCases = [
      [
        {},
        "loopback_read",
        ["read_only_access", "host_not_ready"]
      ],
      [localAdminHeaders(), "local_admin", ["host_not_ready"]],
      [deviceCookie(readToken), "paired_read", ["read_only_access", "host_not_ready"]],
      [deviceCookie(writeToken), "paired_write", ["host_not_ready"]]
    ] as const;
    for (const [headers, mode, causes] of initialCases) {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/v1/host/status",
        headers
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().access).toMatchObject({
        mode,
        network_mode: "loopback",
        transport: "http",
        write_eligibility: { eligible: false, causes }
      });
    }

    makeReady(health);
    for (const [headers, mode, eligible, causes] of [
      [{}, "loopback_read", false, ["read_only_access"]],
      [localAdminHeaders(), "local_admin", true, []],
      [deviceCookie(readToken), "paired_read", false, ["read_only_access"]],
      [deviceCookie(writeToken), "paired_write", true, []]
    ] as const) {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/v1/host/status",
        headers
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().access).toMatchObject({
        mode,
        write_eligibility: {
          scope: "host_health_and_authority",
          eligible,
          causes
        }
      });
    }
    expect(harness.authCalls()).toBe(4);
  });

  it("rejects invalid, expired, storage-failed, and unpaired remote authority before health disclosure", async () => {
    const health = healthHarness();
    makeReady(health);
    const loopback = createLoopbackApp(health.service);
    await loopback.app.ready();
    const localBefore = health.service.localSnapshot();
    const remoteBefore = health.service.remoteSnapshot();

    for (const [token, status, code] of [
      [invalidToken, 401, "permission_denied"],
      [expiredToken, 401, "permission_denied"],
      [storageToken, 500, "storage_error"]
    ] as const) {
      const response = await loopback.app.inject({
        method: "GET",
        url: "/api/v1/host/status",
        headers: deviceCookie(token)
      });
      expectStableError(response, status, code);
      expect(response.body).not.toMatch(
        /components|runtime|compatibility|fanout|listener|lease|private-auth/iu
      );
    }
    expect(health.service.localSnapshot()).toBe(localBefore);
    expect(health.service.remoteSnapshot()).toBe(remoteBefore);

    const remoteHealth = healthHarness();
    makeReady(remoteHealth);
    remoteHealth.tick();
    remoteHealth.service.updateRemote({
      source_generation: 1,
      state: readyRemote(7)
    });
    const remote = createRemoteApp(remoteHealth.service);
    await remote.app.ready();
    const unpaired = await remote.app.inject({
      method: "GET",
      url: "/api/v1/host/status",
      headers: remoteHeaders({ identity: true })
    });
    expectStableError(unpaired, 401, "permission_denied");
    expect(unpaired.body).not.toMatch(
      /components|runtime|fixture-tailnet|identity-does-not-authorize/iu
    );

    const paired = await remote.app.inject({
      method: "GET",
      url: "/api/v1/host/status",
      headers: remoteHeaders({ cookie: readToken, identity: true })
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json()).toMatchObject({
      remote: {
        state_generation: 7,
        availability: "ready",
        external_origin: externalOrigin
      },
      access: {
        mode: "paired_read",
        network_mode: "remote",
        transport: "https",
        write_eligibility: {
          eligible: false,
          causes: ["read_only_access"]
        }
      }
    });
  });

  it("suppresses a typed non-ready body when paired authority is revoked before delivery", async () => {
    const health = healthHarness();
    const policy = authenticationPolicy();
    const observations: HostDeckInternalErrorObservation[] = [];
    const app = createHostDeckFastifyApp({
      observeInternalError: (observation) => observations.push(observation),
      requestAuthenticationPolicy: policy,
      requestTrustPolicy: loopbackTrustPolicy,
      resourceBudget: defaultResourceBudget,
      routePlugins: [createHostDeckHealthRouteRegistration({ health: health.service })]
    });
    apps.push(app);
    let invalidated = false;
    app.addHook("preSerialization", async (request, reply, payload) => {
      if (
        !invalidated &&
        request.url === "/api/v1/health/ready" &&
        reply.statusCode === 503
      ) {
        invalidated = true;
        policy.activeDeviceAuthority.invalidate(writeDeviceId);
      }
      return payload;
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health/ready",
      headers: deviceCookie(writeToken)
    });
    expectStableError(response, 401, "permission_denied");
    expect(response.body).not.toMatch(
      /components|not_observed|storage|runtime|compatibility|projector|fanout|listener|lease/iu
    );
    expect(invalidated).toBe(true);
    expect(observations).toEqual([]);
    expect(policy.activeDeviceAuthority.snapshot()).toMatchObject({
      active_leases: 0,
      invalidations: 1,
      signaled_leases: 1
    });
  });

  it("suppresses a typed non-ready body when remote ingress changes before delivery", async () => {
    const health = healthHarness();
    const observations: HostDeckInternalErrorObservation[] = [];
    let ingressGeneration = 7;
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: (observation) => observations.push(observation),
      requestAuthenticationPolicy: authenticationPolicy(),
      resourceBudget: defaultResourceBudget,
      routePlugins: [createHostDeckHealthRouteRegistration({ health: health.service })],
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: remoteLocalOrigin,
        readRemoteAdmission: () => ({
          admission: "open",
          external_origin: externalOrigin,
          generation: ingressGeneration
        })
      })
    });
    apps.push(app);
    let invalidated = false;
    app.addHook("preSerialization", async (request, reply, payload) => {
      if (
        !invalidated &&
        request.url === "/api/v1/health/ready" &&
        reply.statusCode === 503
      ) {
        invalidated = true;
        ingressGeneration = 8;
      }
      return payload;
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health/ready",
      headers: remoteHeaders({ cookie: writeToken, identity: true })
    });
    expectStableError(response, 403, "invalid_origin");
    expect(response.body).not.toMatch(
      /components|not_observed|storage|runtime|compatibility|projector|fanout|listener|lease/iu
    );
    expect(invalidated).toBe(true);
    expect(observations).toEqual([]);
  });

  it("normalizes malformed queries and preserves snapshots across read-only requests", async () => {
    const health = healthHarness();
    makeReady(health);
    const harness = createLoopbackApp(health.service);
    await harness.app.ready();
    const local = health.service.localSnapshot();
    const remote = health.service.remoteSnapshot();

    for (const path of [
      "/api/v1/health/ready?extra=true",
      "/api/v1/host/status?after=1",
      "/api/v1/host/status?session_id=sess_private"
    ]) {
      const response = await harness.app.inject({ method: "GET", url: path });
      expectStableError(response, 400, "validation_error");
    }
    expect(health.service.localSnapshot()).toBe(local);
    expect(health.service.remoteSnapshot()).toBe(remote);
    expect(harness.authCalls()).toBe(0);
    expect(harness.observations).toEqual([]);
  });
});

interface HealthHarness {
  readonly service: HostDeckHostHealthService;
  readonly clock: { calls: number; value: number };
  readonly tick: () => void;
}

function healthHarness(): HealthHarness {
  const clock = { calls: 0, value: initialTime };
  const service = createHostDeckHostHealthService({
    now() {
      clock.calls += 1;
      return new Date(clock.value);
    }
  });
  return {
    service,
    clock,
    tick() {
      clock.value += 1_000;
    }
  };
}

function makeReady(health: HealthHarness): void {
  for (const component of [
    "storage",
    "runtime",
    "compatibility",
    "projector",
    "fanout",
    "listener",
    "lease"
  ] as const satisfies readonly HostDeckLocalHealthComponent[]) {
    health.tick();
    health.service.updateLocal({
      component,
      source_generation: 1,
      state: "ready",
      reasons: []
    });
  }
}

function createLoopbackApp(
  health: HostDeckHostHealthService,
  options: {
    readonly authenticateDeviceToken?: HostDeckRequestAuthenticationPolicy["authenticateDeviceToken"];
  } = {}
): {
  readonly app: HostDeckFastifyInstance;
  readonly observations: HostDeckInternalErrorObservation[];
  readonly authCalls: () => number;
} {
  let authCalls = 0;
  const observations: HostDeckInternalErrorObservation[] = [];
  const authenticate =
    options.authenticateDeviceToken ??
    (({ rawDeviceToken }) => {
      if (rawDeviceToken === readToken) {
        return authenticatedDevice("read", readDeviceId);
      }
      if (rawDeviceToken === writeToken) {
        return authenticatedDevice("write", writeDeviceId);
      }
      if (rawDeviceToken === expiredToken) {
        throw new HostDeckAuthRepositoryError(
          "device_expired",
          "expired-private-auth-sentinel"
        );
      }
      if (rawDeviceToken === storageToken) {
        throw new Error("storage-private-auth-sentinel");
      }
      throw new HostDeckAuthRepositoryError(
        "device_not_found",
        "missing-private-auth-sentinel"
      );
    });
  const app = createHostDeckFastifyApp({
    observeInternalError: (observation) => observations.push(observation),
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken(input) {
        authCalls += 1;
        return Reflect.apply(authenticate, undefined, [input]);
      },
      now: () => new Date(initialTime)
    }),
    requestTrustPolicy: loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [createHostDeckHealthRouteRegistration({ health })]
  });
  apps.push(app);
  return { app, observations, authCalls: () => authCalls };
}

function createRemoteApp(health: HostDeckHostHealthService): {
  readonly app: HostDeckFastifyInstance;
} {
  const app = createHostDeckTailscaleServeFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authenticationPolicy(),
    resourceBudget: defaultResourceBudget,
    routePlugins: [createHostDeckHealthRouteRegistration({ health })],
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
  return { app };
}

function authenticationPolicy(): HostDeckRequestAuthenticationPolicy {
  return createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken({ rawDeviceToken }) {
      if (rawDeviceToken === readToken) {
        return authenticatedDevice("read", readDeviceId);
      }
      if (rawDeviceToken === writeToken) {
        return authenticatedDevice("write", writeDeviceId);
      }
      throw new HostDeckAuthRepositoryError(
        "device_not_found",
        "remote-private-auth-sentinel"
      );
    },
    now: () => new Date(initialTime)
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
      client_label: "Health Phone",
      permission,
      created_at: createdAt,
      last_used_at: new Date(initialTime).toISOString(),
      expires_at: null,
      revoked_at: null
    }
  };
}

function readyRemote(generation: number) {
  return remoteIngressPublicStateSchema.parse({
    generation,
    availability: "ready",
    reason: null,
    external_origin: externalOrigin,
    laptop_action_required: false,
    observed_at: new Date(initialTime).toISOString()
  });
}

function unavailableRemote(generation: number, reason: "client_stopped") {
  return remoteIngressPublicStateSchema.parse({
    generation,
    availability: "unavailable",
    reason,
    external_origin: null,
    laptop_action_required: true,
    observed_at: new Date(initialTime).toISOString()
  });
}

function deviceCookie(rawDeviceToken: string): Readonly<Record<string, string>> {
  return { cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}` };
}

function localAdminHeaders(): Readonly<Record<string, string>> {
  return {
    [hostDeckLocalAdminRequestHeaderName]: hostDeckLocalAdminRequestHeaderValue
  };
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
    headers["tailscale-headers-info"] = "https://tailscale.com/s/serve-headers";
    headers["tailscale-user-login"] =
      "identity-does-not-authorize@example.test";
    headers["tailscale-user-name"] = "Identity Does Not Authorize";
    headers["tailscale-user-profile-pic"] = "https://example.test/avatar";
  }
  return headers;
}

function expectNoStore(
  response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>
): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers.pragma).toBe("no-cache");
}

function expectDeepFrozenData(candidate: unknown, seen = new Set<object>()): void {
  if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) {
    return;
  }
  seen.add(candidate);
  expect(Object.isFrozen(candidate)).toBe(true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
    if (!("value" in descriptor)) {
      throw new TypeError("Public health payload contains an accessor.");
    }
    expectDeepFrozenData(descriptor.value, seen);
  }
}

function expectStableError(
  response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>,
  status: number,
  code: string
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.json()).toMatchObject({
    error: {
      code,
      retryable: false,
      details: { request_id: response.headers["x-request-id"] }
    }
  });
}
