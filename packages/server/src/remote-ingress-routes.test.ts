import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  remoteIngressObservationSnapshotSchema
} from "@hostdeck/contracts";
import {
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  HostDeckAuthRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import { hostDeckLoopbackTestOrigin, injectHostDeckLoopback } from "./fastify-loopback-test-request.js";
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
  createRemoteIngressControlService,
  type RemoteIngressControlService
} from "./remote-ingress-control-service.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import {
  createHostDeckRemoteIngressRouteRegistration,
  hostDeckRemoteIngressRouteRegistrationId
} from "./remote-ingress-routes.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import type { TailscaleObserver } from "./tailscale-observer.js";
import type {
  TailscaleServeManager,
  TailscaleServeManagerResult,
  TailscaleServeMutationInput
} from "./tailscale-serve-manager.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

const roots: string[] = [];
const apps: HostDeckFastifyInstance[] = [];
const databases: Array<{ close: () => unknown }> = [];
const loopbackOrigin = hostDeckLoopbackTestOrigin;
const localOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-route.fixture-tailnet.ts.net";
const profileKey = `sha256:${"1".repeat(64)}`;
const pairedToken = "P".repeat(43);
const expiredToken = "E".repeat(43);
const deviceId = "client_remote_route_phone";
const observedAt = "2026-07-13T19:00:00.000Z";
const baseTime = Date.parse("2026-07-13T20:00:00.000Z");

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("selected remote-ingress API routes", () => {
  it("accepts only one branded service and returns one immutable registration", () => {
    const harness = createHarness();
    const registration = harness.registration;
    expect(registration).toMatchObject({
      id: hostDeckRemoteIngressRouteRegistrationId,
      surface: "api"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    expect(() =>
      createHostDeckRemoteIngressRouteRegistration({ service: harness.service })
    ).toThrow("already owns");

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "service", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return harness.service;
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { service: harness.service, extra: true },
      Object.assign(Object.create({ inherited: true }), {
        service: harness.service
      }),
      { service: { ...harness.service } },
      accessor
    ]) {
      expect(() =>
        createHostDeckRemoteIngressRouteRegistration(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("binds the exact no-store surface and performs one audited lifecycle", async () => {
    const harness = createHarness();
    await harness.app.ready();

    const initial = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: localAdminHeaders()
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expectNoStore(initial.headers);
    expect(initial.json()).toEqual({
      generation: 0,
      availability: "disabled",
      reason: "remote_disabled",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null
    });
    expect(harness.calls).toEqual({
      candidate: 0,
      configured: 0,
      disable: 0,
      enable: 0
    });
    expect(harness.auditCount()).toBe(0);

    const enabled = await injectHostDeckLoopback(harness.app, {
      method: "POST",
      url: "/api/v1/remote/enable",
      payload: mutation("op_remote_route_enable_001")
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expectNoStore(enabled.headers);
    expect(enabled.json()).toMatchObject({
      generation: 2,
      availability: "ready",
      reason: null,
      external_origin: externalOrigin,
      laptop_action_required: false
    });
    expect(harness.calls).toMatchObject({ candidate: 1, enable: 1 });
    expect(harness.auditCount()).toBe(2);

    const refreshed = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: localAdminHeaders()
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json()).toMatchObject({
      generation: 2,
      availability: "ready",
      external_origin: externalOrigin
    });
    expect(harness.calls.configured).toBe(1);
    expect(harness.auditCount()).toBe(2);

    const disabled = await injectHostDeckLoopback(harness.app, {
      method: "POST",
      url: "/api/v1/remote/disable",
      payload: mutation("op_remote_route_disable_001")
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expectNoStore(disabled.headers);
    expect(disabled.json()).toMatchObject({
      availability: "disabled",
      reason: "remote_disabled",
      external_origin: null,
      laptop_action_required: true
    });
    expect(harness.calls.disable).toBe(1);
    expect(harness.auditCount()).toBe(4);

    expectStableError(
      await injectHostDeckLoopback(harness.app, {
        method: "HEAD",
        url: "/api/v1/remote/status"
      }),
      405,
      "method_not_allowed"
    );
    expectStableError(
      await injectHostDeckLoopback(harness.app, {
        method: "GET",
        url: "/api/v1/remote/status/"
      }),
      404,
      "route_not_found"
    );
    expectStableError(
      await injectHostDeckLoopback(harness.app, {
        method: "GET",
        url: "/api/v1/remote/enable"
      }),
      405,
      "method_not_allowed"
    );
  });

  it("admits local-admin or paired status but keeps both mutations local-admin-only", async () => {
    const harness = createHarness();
    await harness.app.ready();

    const localStatus = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: localAdminHeaders()
    });
    expect(localStatus.statusCode, localStatus.body).toBe(200);

    const unpaired = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: { origin: loopbackOrigin }
    });
    expectStableError(unpaired, 401, "permission_denied");

    const paired = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: pairedHeaders()
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(harness.authenticationCalls()).toBe(1);

    for (const path of [
      "/api/v1/remote/enable",
      "/api/v1/remote/disable"
    ]) {
      const denied = await injectHostDeckLoopback(harness.app, {
        method: "POST",
        url: path,
        headers: pairedHeaders(),
        payload: mutation(`op_paired_denied_${path.endsWith("enable") ? "enable" : "disable"}`)
      });
      expectStableError(denied, 403, "permission_denied");
      expectNoStore(denied.headers);
    }
    expect(harness.calls.enable).toBe(0);
    expect(harness.calls.disable).toBe(0);
    expect(harness.auditCount()).toBe(0);

    const expired = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: {
        cookie: `${hostDeckDeviceCookieName}=${expiredToken}`,
        origin: loopbackOrigin
      }
    });
    expectStableError(expired, 401, "permission_denied");
  });

  it("rejects malformed bodies and queries before audit, observation, or mutation", async () => {
    const harness = createHarness();
    await harness.app.ready();

    for (const payload of [
      {},
      { operation_id: "op_remote_route_bad_false", confirmed: false },
      { operation_id: "op_remote_route_bad_extra", confirmed: true, extra: true },
      { operation_id: "bad", confirmed: true }
    ]) {
      const response = await injectHostDeckLoopback(harness.app, {
        method: "POST",
        url: "/api/v1/remote/enable",
        payload
      });
      expectStableError(response, 400, "validation_error");
      expectNoStore(response.headers);
    }
    for (const request of [
      { method: "GET" as const, url: "/api/v1/remote/status?refresh=true" },
      {
        method: "POST" as const,
        url: "/api/v1/remote/disable?force=true",
        payload: mutation("op_remote_route_query_reject")
      }
    ]) {
      const response = await injectHostDeckLoopback(harness.app, request);
      expectStableError(response, 400, "validation_error");
      expectNoStore(response.headers);
    }
    expect(harness.calls).toEqual({
      candidate: 0,
      configured: 0,
      disable: 0,
      enable: 0
    });
    expect(harness.auditCount()).toBe(0);
  });

  it("maps busy, observer, and selection failures to bounded public errors", async () => {
    const busy = createHarness();
    await busy.app.ready();
    await enable(busy, "op_remote_route_busy_seed");
    const observation = deferred<RemoteIngressObservationSnapshot>();
    busy.setConfiguredHandler(() => observation.promise);
    const pendingStatus = injectHostDeckLoopback(busy.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: localAdminHeaders()
    });
    await eventually(() => expect(busy.calls.configured).toBe(1));
    const rejected = await injectHostDeckLoopback(busy.app, {
      method: "POST",
      url: "/api/v1/remote/enable",
      payload: mutation("op_remote_route_busy_reject")
    });
    expectStableError(rejected, 503, "service_overloaded", true);
    expect(rejected.body).not.toContain(profileKey);
    expect(busy.calls.enable).toBe(1);
    observation.resolve(snapshot("exact"));
    expect((await pendingStatus).statusCode).toBe(200);

    const observer = createHarness();
    await observer.app.ready();
    await enable(observer, "op_remote_route_observer_seed");
    observer.setConfiguredHandler(() =>
      Promise.reject(new Error("private-observer-profile-and-command-output"))
    );
    const unavailable = await injectHostDeckLoopback(observer.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: localAdminHeaders()
    });
    expectStableError(unavailable, 503, "runtime_unavailable", true);
    expect(unavailable.body).not.toContain("private-observer");
    expectNoStore(unavailable.headers);

    const conflict = createHarness();
    await conflict.app.ready();
    conflict.queueCandidate(snapshot("foreign"));
    const denied = await injectHostDeckLoopback(conflict.app, {
      method: "POST",
      url: "/api/v1/remote/enable",
      payload: mutation("op_remote_route_foreign")
    });
    expectStableError(denied, 409, "operation_conflict");
    expect(conflict.calls.enable).toBe(0);
    expect(denied.body).not.toContain(profileKey);
  });

  it("withholds paired status success when device authority is revoked in flight", async () => {
    const harness = createHarness();
    await harness.app.ready();
    await enable(harness, "op_remote_route_revoke_seed");
    const observation = deferred<RemoteIngressObservationSnapshot>();
    harness.setConfiguredHandler(() => observation.promise);

    const responsePromise = injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: pairedHeaders()
    });
    await eventually(() => expect(harness.calls.configured).toBe(1));
    expect(
      harness.authenticationPolicy.activeDeviceAuthority.invalidate(deviceId)
    ).toMatchObject({ closedLeases: 1 });
    observation.resolve(snapshot("exact"));

    const response = await responsePromise;
    expectStableError(response, 401, "permission_denied");
    expect(response.body).not.toContain(externalOrigin);
    expectNoStore(response.headers);
  });

  it("composes paired status and local-only mutations through the selected Serve boundary", async () => {
    const harness = createHarness({ selectedRemote: true });
    await harness.app.ready();

    const localStatus = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: { ...localSelectedHeaders(), ...localAdminHeaders() }
    });
    expect(localStatus.statusCode, localStatus.body).toBe(200);
    expectNoStore(localStatus.headers);

    const unpaired = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: remoteHeaders(false)
    });
    expectStableError(unpaired, 401, "permission_denied");

    const paired = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: remoteHeaders(true)
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expectNoStore(paired.headers);

    const signaledRemote = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: {
        ...remoteHeaders(true),
        [hostDeckLocalAdminRequestHeaderName]: hostDeckLocalAdminRequestHeaderValue
      }
    });
    expectStableError(signaledRemote, 403, "invalid_origin");

    const remoteMutation = await injectHostDeckLoopback(harness.app, {
      method: "POST",
      url: "/api/v1/remote/enable",
      headers: { ...remoteHeaders(true), origin: externalOrigin },
      payload: mutation("op_remote_route_proxy_denied")
    });
    expectStableError(remoteMutation, 403, "permission_denied");
    expect(harness.calls.enable).toBe(0);
    expect(harness.auditCount()).toBe(0);

    const enabled = await injectHostDeckLoopback(harness.app, {
      method: "POST",
      url: "/api/v1/remote/enable",
      headers: localSelectedHeaders(),
      payload: mutation("op_remote_route_proxy_seed")
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const observation = deferred<RemoteIngressObservationSnapshot>();
    harness.setConfiguredHandler(() => observation.promise);
    const pending = injectHostDeckLoopback(harness.app, {
      method: "GET",
      url: "/api/v1/remote/status",
      headers: remoteHeaders(true)
    });
    await eventually(() => expect(harness.calls.configured).toBe(1));
    harness.setRemoteAdmission(8);
    observation.resolve(snapshot("exact"));

    const stale = await pending;
    expectStableError(stale, 403, "invalid_origin");
    expect(stale.body).not.toContain(externalOrigin);
    expect(stale.headers.connection).toBe("close");
    expectNoStore(stale.headers);
  });
});

interface HarnessOptions {
  readonly selectedRemote?: boolean;
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly authenticationCalls: () => number;
  readonly authenticationPolicy: HostDeckRequestAuthenticationPolicy;
  readonly auditCount: () => number;
  readonly calls: {
    candidate: number;
    configured: number;
    disable: number;
    enable: number;
  };
  readonly queueCandidate: (...snapshots: RemoteIngressObservationSnapshot[]) => void;
  readonly registration: ReturnType<
    typeof createHostDeckRemoteIngressRouteRegistration
  >;
  readonly service: RemoteIngressControlService;
  readonly setConfiguredHandler: (
    handler: () => Promise<RemoteIngressObservationSnapshot>
  ) => void;
  readonly setRemoteAdmission: (generation: number) => void;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-remote-routes-"));
  roots.push(root);
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(baseTime)
  });
  databases.push(opened.db);
  const states = createRemoteIngressStateRepository(opened.db);
  const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
  const audit = createSelectedAuditRepository(opened.db);
  const calls = { candidate: 0, configured: 0, disable: 0, enable: 0 };
  const candidateQueue: RemoteIngressObservationSnapshot[] = [];
  let configuredHandler: (() => Promise<RemoteIngressObservationSnapshot>) | null =
    null;
  let wallTime = baseTime;
  let auditIndex = 0;
  const now = () => {
    wallTime += 1_000;
    return new Date(wallTime);
  };

  const observer: TailscaleObserver = Object.freeze({
    poll_interval_ms: 5_000,
    async observeCandidate() {
      calls.candidate += 1;
      return candidateQueue.shift() ?? snapshot("absent");
    },
    async observeConfigured() {
      calls.configured += 1;
      return configuredHandler === null
        ? snapshot("exact")
        : configuredHandler();
    }
  });
  const manager = Object.freeze({
    async disable(
      input: TailscaleServeMutationInput
    ): Promise<TailscaleServeManagerResult> {
      calls.disable += 1;
      return Object.freeze({
        action: "disable" as const,
        outcome: "succeeded" as const,
        serve_result: "removed" as const,
        reason: null,
        command_attempted: true,
        before: snapshot("exact"),
        after: snapshot("absent", input.expected_profile_key)
      });
    },
    async enable(
      input: TailscaleServeMutationInput
    ): Promise<TailscaleServeManagerResult> {
      calls.enable += 1;
      return Object.freeze({
        action: "enable" as const,
        outcome: "succeeded" as const,
        serve_result: "applied" as const,
        reason: null,
        command_attempted: true,
        before: snapshot("absent", input.expected_profile_key),
        after: snapshot("exact", input.expected_profile_key)
      });
    },
    snapshot() {
      return Object.freeze({
        active: false,
        busy_rejections: 0,
        command_attempts: calls.disable + calls.enable,
        failed_operations: 0,
        incomplete_operations: 0,
        rejected_operations: 0,
        started_operations: calls.disable + calls.enable,
        succeeded_operations: calls.disable + calls.enable
      });
    }
  }) as TailscaleServeManager;
  const auditPort: SelectedAuditRepository = audit;
  const executor = createSecurityMutationAuditExecutor({
    repository: auditPort,
    now: () => now().toISOString(),
    create_record_id: () => `audit:remote-route:${++auditIndex}`
  });
  const service = createRemoteIngressControlService({
    admissionProofs: proofs,
    audit: executor,
    localOrigin,
    manager,
    monotonicNow: () => 0,
    now,
    observer,
    states
  });
  let authenticationCalls = 0;
  const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken({ rawDeviceToken }) {
      authenticationCalls += 1;
      if (rawDeviceToken === pairedToken) return authenticatedDevice();
      if (rawDeviceToken === expiredToken) {
        throw new HostDeckAuthRepositoryError(
          "device_expired",
          "private expired device state"
        );
      }
      throw new HostDeckAuthRepositoryError(
        "device_not_found",
        "private unknown device state"
      );
    },
    now: () => new Date(baseTime)
  });
  const registration = createHostDeckRemoteIngressRouteRegistration({ service });
  let remoteAdmissionGeneration = 7;
  const commonAppInput = {
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authenticationPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  } as const;
  const remoteRequestAuthority =
    createHostDeckRemoteIngressRequestAuthorityPolicy();
  const app = options.selectedRemote
    ? createHostDeckTailscaleServeFastifyApp({
        ...commonAppInput,
        remoteIngressRequestAuthority: remoteRequestAuthority,
        tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
          localOrigin,
          readRemoteAdmission: () =>
            remoteRequestAuthority.synchronize({
              admission: "open" as const,
              external_origin: externalOrigin,
              generation: remoteAdmissionGeneration
            })
        })
      })
    : createHostDeckFastifyApp({
        ...commonAppInput,
        requestTrustPolicy: createHostDeckRequestTrustPolicy({
          allowedOrigin: loopbackOrigin
        })
      });
  apps.push(app);

  return {
    app,
    authenticationCalls: () => authenticationCalls,
    authenticationPolicy,
    auditCount: () => {
      const row = opened.db
        .prepare("SELECT COUNT(*) AS count FROM selected_audit_events")
        .get() as { readonly count: number };
      return row.count;
    },
    calls,
    queueCandidate(...snapshots) {
      candidateQueue.push(...snapshots);
    },
    registration,
    service,
    setConfiguredHandler(handler) {
      configuredHandler = handler;
    },
    setRemoteAdmission(generation) {
      remoteAdmissionGeneration = generation;
    }
  };
}

function snapshot(
  serve: RemoteIngressObservationSnapshot["serve"],
  selectedProfileKey: string = profileKey
): RemoteIngressObservationSnapshot {
  return remoteIngressObservationSnapshotSchema.parse({
    schema_version: 1,
    client: "available",
    profile: {
      state: "dedicated",
      comparison: {
        relation: "match",
        expected_profile_key: selectedProfileKey,
        active_profile_key: selectedProfileKey
      }
    },
    serve,
    external_origin: externalOrigin,
    failure: null,
    observed_at: observedAt
  });
}

function authenticatedDevice() {
  const timestamp = new Date(baseTime).toISOString();
  return {
    trusted: true as const,
    readOnly: true,
    device: {
      id: deviceId,
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: timestamp,
      client_label: "Route phone",
      permission: "read" as const,
      created_at: timestamp,
      last_used_at: timestamp,
      expires_at: null,
      revoked_at: null
    }
  };
}

function mutation(operationId: string) {
  return { operation_id: operationId, confirmed: true as const };
}

function pairedHeaders(): Readonly<Record<string, string>> {
  return {
    cookie: `${hostDeckDeviceCookieName}=${pairedToken}`,
    origin: loopbackOrigin
  };
}

function localAdminHeaders(): Readonly<Record<string, string>> {
  return {
    [hostDeckLocalAdminRequestHeaderName]: hostDeckLocalAdminRequestHeaderValue
  };
}

function localSelectedHeaders(): Readonly<Record<string, string>> {
  return { host: new URL(localOrigin).host };
}

function remoteHeaders(paired: boolean): Readonly<Record<string, string>> {
  const authority = new URL(externalOrigin).host;
  return {
    host: authority,
    "x-forwarded-for": "100.64.0.1",
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https",
    ...(paired
      ? { cookie: `${hostDeckDeviceCookieName}=${pairedToken}` }
      : {})
  };
}

async function enable(harness: Harness, operationId: string): Promise<void> {
  const response = await injectHostDeckLoopback(harness.app, {
    method: "POST",
    url: "/api/v1/remote/enable",
    payload: mutation(operationId)
  });
  expect(response.statusCode, response.body).toBe(200);
}

function expectNoStore(headers: Readonly<Record<string, unknown>>): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers.pragma).toBe("no-cache");
}

function expectStableError(
  response: {
    readonly body: string;
    readonly headers: Readonly<Record<string, unknown>>;
    readonly json: () => unknown;
    readonly statusCode: number;
  },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({
    error: { code, retryable }
  });
  expect(response.body).not.toMatch(
    /profile_key|node_key|auth_key|raw_command|proof_id|audit_id|raw_credential/iu
  );
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw failure;
}
