import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createDeviceRevocationRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration
} from "./csrf-routes.js";
import {
  createHostDeckDeviceRevokeRouteRegistration,
  hostDeckDeviceRevokeRouteRegistrationId,
  hostDeckDeviceRevokeRouteSnapshot
} from "./device-revoke-routes.js";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { createHostDeckSseTransportRegistration } from "./fastify-sse-transport.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

const tempDirectories: string[] = [];
const createdAt = new Date("2026-07-13T12:00:00.000Z");
const localOrigin = "http://127.0.0.1:3777";
const secureOrigin = "https://hostdeck-device-revoke.fixture-tailnet.ts.net";
const remoteSource = "100.90.80.70";
const actorId = "client_revoke_actor";
const targetId = "client_revoke_target";
const actorToken = "A".repeat(43);
const targetToken = "T".repeat(43);
const actorCsrf = "C".repeat(43);
const targetCsrf = "D".repeat(43);
const rotatedCsrf = "N".repeat(43);
const deletionCookie = `${hostDeckDeviceCookieName}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected paired-device revoke route", () => {
  it("requires strict branded composition and registers the exact selected route once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration.id).toBe(hostDeckDeviceRevokeRouteRegistrationId);
      expect(harness.registration.surface).toBe("api");
      expect(Object.isFrozen(harness.registration)).toBe(true);
      expect(hostDeckDeviceRevokeRouteSnapshot(harness.registration)).toEqual({
        attempts: 0,
        conflicts: 0,
        cookie_deletions: 0,
        other_revocations: 0,
        self_revocations: 0,
        storage_failures: 0,
        successful_revocations: 0
      });
      expect(() =>
        harness.registration.register(harness.app, {
          resourceBudget: defaultResourceBudget,
          surface: "api"
        })
      ).toThrow("already registered");

      let accessorCalls = 0;
      const accessor = Object.defineProperty({}, "activeDeviceAuthority", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("private-accessor-sentinel");
        }
      });
      for (const candidate of [
        null,
        {},
        { ...harness.routeInput, extra: true },
        { ...harness.routeInput, admission: undefined },
        {
          ...harness.routeInput,
          admission: Object.freeze({ ...harness.routeInput.admission })
        },
        { ...harness.routeInput, now: null },
        { ...harness.routeInput, devices: {} },
        { ...harness.routeInput, devices: { revoke: harness.routeInput.devices.revoke, extra: true } },
        accessor
      ]) {
        expect(() =>
          createHostDeckDeviceRevokeRouteRegistration(candidate as never)
        ).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("revokes one other device through admitted Serve authority, SQLite, CSRF, audit, and live authority", async () => {
    const harness = await createHarness({ includeProtectedRoute: true });
    const targetBefore = rawDevice(harness, targetId);
    const sessionBefore = rawSession(harness);
    try {
      const response = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_other_001",
          confirmed: true
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        operation_id: "op_device_revoke_other_001",
        device_id: targetId,
        revoked_at: rawDevice(harness, targetId).revoked_at,
        authority_invalidated: true,
        self_revoked: false
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["set-cookie"]).toBeUndefined();

      const targetAfter = rawDevice(harness, targetId);
      expect(targetAfter).toMatchObject({
        ...targetBefore,
        revoked_at: response.json().revoked_at
      });
      expect(rawSession(harness)).toEqual(sessionBefore);
      expect(harness.auditRepository.require("op_device_revoke_other_001")).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            actor: { type: "dashboard", device_id: actorId, permission: "write" },
            action: "device_revoke",
            target: { type: "device", device_id: targetId },
            payload_summary: { schema_version: 1, previously_revoked: false }
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            target: { type: "device", device_id: targetId },
            payload_summary: { schema_version: 1, authority_invalidated: true },
            error_code: null
          }
        ]
      });
      expect(harness.authenticationPolicy.activeDeviceAuthority.snapshot()).toMatchObject({
        tracked_revocations: 1
      });
      expect(hostDeckDeviceRevokeRouteSnapshot(harness.registration)).toMatchObject({
        attempts: 1,
        other_revocations: 1,
        successful_revocations: 1,
        cookie_deletions: 0
      });

      const revokedRead = await secureJsonRequest(harness, {
        method: "GET",
        path: "/fixture/protected",
        token: targetToken
      });
      expectStableError(revokedRead, 401, "permission_denied");
      const actorRead = await secureJsonRequest(harness, {
        method: "GET",
        path: "/fixture/protected",
        token: actorToken
      });
      expect(actorRead.statusCode, actorRead.body).toBe(200);
      expect(actorRead.json()).toEqual({ protected: true });

      const serialized = JSON.stringify({
        body: response.body,
        audit: harness.auditRepository.require("op_device_revoke_other_001"),
        observations: harness.internalObservations
      });
      for (const secret of [actorToken, targetToken, actorCsrf, targetCsrf]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await harness.close();
    }
    assertRawFilesExclude(harness.databasePath, [
      actorToken,
      targetToken,
      actorCsrf,
      targetCsrf
    ]);
  });

  it("allows audited self-revoke of the final device, deletes only its cookie, and reports later conflict", async () => {
    const harness = await createHarness({ includeProtectedRoute: true, includeTarget: false });
    try {
      const response = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${actorId}/revoke`,
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_self_001",
          confirmed: true
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        operation_id: "op_device_revoke_self_001",
        device_id: actorId,
        authority_invalidated: true,
        self_revoked: true
      });
      expect(response.headers["set-cookie"]).toEqual([deletionCookie]);
      expect(hostDeckDeviceRevokeRouteSnapshot(harness.registration)).toMatchObject({
        self_revocations: 1,
        other_revocations: 0,
        cookie_deletions: 1,
        successful_revocations: 1
      });
      expect(harness.authenticationPolicy.activeDeviceAuthority.snapshot()).toMatchObject({
        active_leases: 0,
        signaled_leases: 1,
        tracked_revocations: 1
      });

      const denied = await secureJsonRequest(harness, {
        method: "GET",
        path: "/fixture/protected",
        token: actorToken
      });
      expectStableError(denied, 401, "permission_denied");

      await harness.app.close();
      const loopback = createLoopbackRevokeApp(harness);
      await loopback.ready();
      try {
        const conflict = await loopback.inject({
          method: "POST",
          url: `/api/v1/access/devices/${actorId}/revoke`,
          headers: { host: new URL(localOrigin).host },
          payload: {
            operation_id: "op_device_revoke_self_conflict_001",
            confirmed: true
          }
        });
        expectStableError(conflict, 409, "operation_conflict");
        expect(conflict.headers["set-cookie"]).toBeUndefined();
        expect(
          harness.auditRepository.require("op_device_revoke_self_conflict_001")
        ).toMatchObject({
          state: "terminal",
          records: [
            { phase: "accepted", payload_summary: { previously_revoked: false } },
            { phase: "terminal", outcome: "failed", error_code: "operation_conflict" }
          ]
        });
      } finally {
        await loopback.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("closes concurrent protected response and active SSE authority for only the revoked device", async () => {
    const harness = await createHarness({
      includeProtectedRoute: true,
      includeSlowRoute: true,
      includeSseRoute: true
    });
    try {
      const slowResponse = secureJsonRequest(harness, {
        method: "GET",
        path: "/fixture/slow",
        token: targetToken
      });
      await harness.slowStarted.promise;
      const stream = openSecureStream(harness, targetToken);
      await stream.firstEvent;

      const revoked = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_live_001",
          confirmed: true
        }
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      harness.releaseSlow.resolve();

      const slow = await slowResponse;
      expectStableError(slow, 401, "permission_denied");
      expect(slow.body).not.toContain("protected");
      await withTimeout(stream.closed, 2_000, "revoked SSE did not close");
      await withTimeout(harness.sseIteratorClosed.promise, 2_000, "SSE iterator did not close");
      expect(stream.body()).toContain("event: message");
      expect(harness.authenticationPolicy.activeDeviceAuthority.snapshot()).toMatchObject({
        active_leases: 0,
        signaled_leases: 2,
        tracked_revocations: 1
      });

      const actorRead = await secureJsonRequest(harness, {
        method: "GET",
        path: "/fixture/protected",
        token: actorToken
      });
      expect(actorRead.statusCode, actorRead.body).toBe(200);
    } finally {
      harness.releaseSlow.resolve();
      await harness.close();
    }
  });

  it("aborts paired authority while an SSE source is still opening", async () => {
    const harness = await createHarness({
      delaySseOpen: true,
      includeSseRoute: true
    });
    const stream = openSecureStream(harness, targetToken);
    try {
      await harness.sseOpenStarted.promise;
      const revoked = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_opening_sse_001",
          confirmed: true
        }
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      await withTimeout(
        harness.sseOpenAborted.promise,
        2_000,
        "opening SSE source did not observe revocation"
      );
      await withTimeout(stream.closed, 2_000, "opening SSE response did not close");
      expect(stream.body()).not.toContain("event: message");
      expect(harness.authenticationPolicy.activeDeviceAuthority.snapshot()).toMatchObject({
        active_leases: 0,
        signaled_leases: 1,
        tracked_revocations: 1
      });
    } finally {
      stream.abort();
      await harness.close();
    }
  });

  it("serializes two operation ids for one target into one success and one visible conflict", async () => {
    const harness = await createHarness();
    try {
      const requests = ["op_device_revoke_race_001", "op_device_revoke_race_002"].map(
        (operationId) =>
          secureJsonRequest(harness, {
            method: "POST",
            path: `/api/v1/access/devices/${targetId}/revoke`,
            token: actorToken,
            csrf: actorCsrf,
            payload: { operation_id: operationId, confirmed: true }
          })
      );
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([
        200, 409
      ]);
      expect(responses.filter((response) => response.headers["set-cookie"] !== undefined)).toHaveLength(0);
      expect(rawDevice(harness, targetId).revoked_at).not.toBeNull();
      const trails = [
        harness.auditRepository.require("op_device_revoke_race_001"),
        harness.auditRepository.require("op_device_revoke_race_002")
      ];
      expect(trails.filter((trail) => trail.records[1]?.outcome === "succeeded")).toHaveLength(1);
      expect(trails.filter((trail) => trail.records[1]?.error_code === "operation_conflict")).toHaveLength(1);
      expect(hostDeckDeviceRevokeRouteSnapshot(harness.registration)).toMatchObject({
        attempts: 2,
        conflicts: 1,
        successful_revocations: 1
      });
    } finally {
      await harness.close();
    }
  });

  it("suppresses a rotated CSRF token when revocation wins before response publication", async () => {
    const harness = await createHarness({
      includeCsrfRoute: true,
      includeTarget: true,
      revokeDuringBootstrap: true
    });
    try {
      const response = await secureJsonRequest(harness, {
        method: "POST",
        path: "/api/v1/access/csrf",
        token: targetToken,
        payload: { operation_id: "op_csrf_revoke_race_001" }
      });
      expectStableError(response, 401, "permission_denied");
      expect(response.body).not.toContain(rotatedCsrf);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(rawDevice(harness, targetId).revoked_at).not.toBeNull();
      expect(harness.auditRepository.require("op_csrf_revoke_race_001")).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", action: "csrf_bootstrap" },
          { phase: "terminal", outcome: "succeeded", action: "csrf_bootstrap" }
        ]
      });
      expect(harness.authenticationPolicy.activeDeviceAuthority.snapshot()).toMatchObject({
        signaled_leases: 1,
        tracked_revocations: 1
      });
    } finally {
      await harness.close();
    }
  });

  it("publishes no cookie or success when terminal audit fails after durable invalidation", async () => {
    const harness = await createHarness({ terminalAuditFailure: true });
    try {
      const response = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_terminal_failure_001",
          confirmed: true
        }
      });
      expectStableError(response, 503, "audit_unavailable");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toContain(targetId);
      expect(rawDevice(harness, targetId).revoked_at).not.toBeNull();
      expect(
        harness.auditRepository.require("op_device_revoke_terminal_failure_001")
      ).toMatchObject({ state: "pending", records: [{ phase: "accepted" }] });
      expect(harness.authenticationPolicy.activeDeviceAuthority.snapshot()).toMatchObject({
        tracked_revocations: 1
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed, unpaired, read-only, stale-CSRF, and missing targets before unsafe success", async () => {
    const harness = await createHarness({ actorPermission: "read" });
    try {
      const malformed = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_malformed_001",
          confirmed: false
        }
      });
      expectStableError(malformed, 400, "validation_error");

      const readOnly = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_read_001",
          confirmed: true
        }
      });
      expectStableError(readOnly, 403, "read_only");

      const unpaired = await secureJsonRequest(harness, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        payload: {
          operation_id: "op_device_revoke_unpaired_001",
          confirmed: true
        }
      });
      expectStableError(unpaired, 401, "permission_denied");
      expect(rawDevice(harness, targetId).revoked_at).toBeNull();
      expect(() => harness.auditRepository.require("op_device_revoke_read_001")).toThrow();
      expect(() => harness.auditRepository.require("op_device_revoke_unpaired_001")).toThrow();
    } finally {
      await harness.close();
    }

    const writer = await createHarness();
    try {
      const staleCsrf = await secureJsonRequest(writer, {
        method: "POST",
        path: `/api/v1/access/devices/${targetId}/revoke`,
        token: actorToken,
        csrf: "Z".repeat(43),
        payload: {
          operation_id: "op_device_revoke_csrf_001",
          confirmed: true
        }
      });
      expectStableError(staleCsrf, 403, "permission_denied");
      expect(rawDevice(writer, targetId).revoked_at).toBeNull();

      const missing = await secureJsonRequest(writer, {
        method: "POST",
        path: "/api/v1/access/devices/client_missing_target/revoke",
        token: actorToken,
        csrf: actorCsrf,
        payload: {
          operation_id: "op_device_revoke_missing_001",
          confirmed: true
        }
      });
      expectStableError(missing, 409, "operation_conflict");
      expect(writer.auditRepository.require("op_device_revoke_missing_001")).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted" },
          { phase: "terminal", outcome: "failed", error_code: "operation_conflict" }
        ]
      });
    } finally {
      await writer.close();
    }
  });
});

interface HarnessOptions {
  readonly actorPermission?: "read" | "write";
  readonly delaySseOpen?: boolean;
  readonly includeCsrfRoute?: boolean;
  readonly includeProtectedRoute?: boolean;
  readonly includeSlowRoute?: boolean;
  readonly includeSseRoute?: boolean;
  readonly includeTarget?: boolean;
  readonly revokeDuringBootstrap?: boolean;
  readonly terminalAuditFailure?: boolean;
}

interface RouteInputFixture {
  readonly activeDeviceAuthority: ReturnType<
    typeof createHostDeckRequestAuthenticationPolicy
  >["activeDeviceAuthority"];
  readonly admission: ReturnType<typeof createHostDeckSelectedWriteAdmissionPolicy>;
  readonly audit: ReturnType<typeof createSecurityMutationAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly devices: { readonly revoke: ReturnType<typeof createDeviceRevocationRepository>["revoke"] };
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly now: () => Date;
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly authenticationPolicy: ReturnType<typeof createHostDeckRequestAuthenticationPolicy>;
  readonly databasePath: string;
  readonly internalObservations: HostDeckInternalErrorObservation[];
  readonly open: ReturnType<typeof openMigratedDatabase>;
  readonly registration: HostDeckRoutePluginRegistration;
  readonly releaseSlow: Deferred<void>;
  readonly routeInput: RouteInputFixture;
  readonly slowStarted: Deferred<void>;
  readonly sseOpenAborted: Deferred<void>;
  readonly sseOpenStarted: Deferred<void>;
  readonly sseIteratorClosed: Deferred<void>;
  readonly nextDate: () => Date;
  readonly close: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = temporaryDirectory("hostdeck-device-revoke-");
  const databasePath = join(directory, "state.sqlite");
  const open = openMigratedDatabase(databasePath, { now: () => createdAt });
  open.db.pragma("busy_timeout = 2000");
  const auth = createAuthDeviceRepository(open.db);
  auth.create({
    id: actorId,
    rawDeviceToken: actorToken,
    rawCsrfToken: actorCsrf,
    permission: options.actorPermission ?? "write",
    clientLabel: "Actor phone",
    createdAt
  });
  if (options.includeTarget !== false) {
    auth.create({
      id: targetId,
      rawDeviceToken: targetToken,
      rawCsrfToken: targetCsrf,
      permission: "write",
      clientLabel: "Target phone",
      createdAt
    });
  }
  open.db
    .prepare(
      `INSERT INTO sessions (
        id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
        lifecycle_state, created_at, updated_at, stale_reason
      ) VALUES (?, ?, ?, 'tmux', ?, NULL, NULL, 'running', ?, ?, NULL)`
    )
    .run(
      "sess_revoke_preserved",
      "revoke-preserved",
      "/tmp/revoke-preserved",
      "hostdeck-revoke-preserved",
      createdAt.toISOString(),
      createdAt.toISOString()
    );

  let clock = createdAt.getTime() + 60_000;
  const nextDate = () => {
    const result = new Date(clock);
    clock += 1_000;
    return result;
  };
  const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
    now: nextDate
  });
  const revocations = createDeviceRevocationRepository(open.db);
  const selectedCsrf = createSelectedCsrfAuthorizationRepository(open.db, {
    generateCsrfToken: () => rotatedCsrf
  });
  const baseAuditRepository = createSelectedAuditRepository(open.db);
  const auditRepository: SelectedAuditRepository = options.terminalAuditFailure
    ? {
        ...baseAuditRepository,
        recordTerminal() {
          throw new HostDeckSelectedAuditRepositoryError(
            "audit_write_failed",
            "private-terminal-audit-sentinel"
          );
        }
      }
    : baseAuditRepository;
  let auditId = 0;
  const audit = createSecurityMutationAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit:device-revoke:${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) => selectedCsrf.authorizeBrowserWrite(input),
      rotateBootstrap(input) {
        const result = selectedCsrf.rotateBootstrap(input);
        if (options.revokeDuringBootstrap) {
          revocations.revoke({ deviceId: input.deviceId, now: nextDate() });
          authenticationPolicy.activeDeviceAuthority.invalidate(input.deviceId);
        }
        return result;
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => {
        throw new Error("device revoke must not read host lock");
      },
      transition: () => {
        throw new Error("device revoke must not transition host lock");
      }
    },
    now: nextDate
  });
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    activeDeviceAuthority: authenticationPolicy.activeDeviceAuthority,
    audit,
    csrf,
    devices: { revoke: (input) => revocations.revoke(input) },
    lock,
    now: nextDate
  };
  const registration = createHostDeckDeviceRevokeRouteRegistration(routeInput);
  const releaseSlow = deferred<void>();
  const slowStarted = deferred<void>();
  const sseOpenAborted = deferred<void>();
  const sseOpenStarted = deferred<void>();
  const sseIteratorClosed = deferred<void>();
  const routePlugins: HostDeckRoutePluginRegistration[] = [registration];
  if (options.includeCsrfRoute) {
    routePlugins.push(createHostDeckCsrfRouteRegistration({ audit, csrf }));
  }
  if (options.includeProtectedRoute || options.includeSlowRoute) {
    routePlugins.push(
      protectedFixtureRegistration({
        includeSlow: options.includeSlowRoute === true,
        releaseSlow,
        slowStarted
      })
    );
  }
  if (options.includeSseRoute) {
    routePlugins.push(
      sseFixtureRegistration({
        delayOpen: options.delaySseOpen === true,
        iteratorClosed: sseIteratorClosed,
        openAborted: sseOpenAborted,
        openStarted: sseOpenStarted
      })
    );
  }

  const internalObservations: HostDeckInternalErrorObservation[] = [];
  const remoteRequestAuthority = createHostDeckRemoteIngressRequestAuthorityPolicy();
  const app = createHostDeckTailscaleServeFastifyApp({
    observeInternalError: (observation) => internalObservations.push(observation),
    requestAuthenticationPolicy: authenticationPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins,
    remoteIngressRequestAuthority: remoteRequestAuthority,
    tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
      localOrigin,
      readRemoteAdmission: () =>
        remoteRequestAuthority.synchronize({
          admission: "open",
          external_origin: secureOrigin,
          generation: 1
        })
    })
  });
  await app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
  let closed = false;
  return {
    app,
    auditRepository: baseAuditRepository,
    authenticationPolicy,
    databasePath,
    internalObservations,
    open,
    registration,
    releaseSlow,
    routeInput,
    slowStarted,
    sseOpenAborted,
    sseOpenStarted,
    sseIteratorClosed,
    nextDate,
    async close() {
      if (closed) return;
      closed = true;
      releaseSlow.resolve();
      await app.close();
      if (open.db.open) open.db.close();
    }
  };
}

function createLoopbackRevokeApp(harness: Harness): HostDeckFastifyInstance {
  const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: () => {
      throw new Error("loopback revoke must not authenticate a device");
    },
    now: harness.nextDate
  });
  const registration = createHostDeckDeviceRevokeRouteRegistration({
    ...harness.routeInput,
    activeDeviceAuthority: authenticationPolicy.activeDeviceAuthority
  });
  return createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authenticationPolicy,
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigin: localOrigin
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
}

function protectedFixtureRegistration(input: {
  readonly includeSlow: boolean;
  readonly releaseSlow: Deferred<void>;
  readonly slowStarted: Deferred<void>;
}): HostDeckRoutePluginRegistration {
  return Object.freeze({
    id: "device-revoke-protected-fixture",
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      app.get(
        "/fixture/protected",
        {
          async onRequest(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: z.object({ protected: z.literal(true) }).strict() } }
        },
        async () => ({ protected: true as const })
      );
      if (input.includeSlow) {
        app.get(
          "/fixture/slow",
          {
            async onRequest(request) {
              requireHostDeckRequestAuthentication(request, "device_cookie");
            },
            schema: { response: { 200: z.object({ protected: z.literal(true) }).strict() } }
          },
          async () => {
            input.slowStarted.resolve();
            await input.releaseSlow.promise;
            return { protected: true as const };
          }
        );
      }
    }
  });
}

function sseFixtureRegistration(input: {
  readonly delayOpen: boolean;
  readonly iteratorClosed: Deferred<void>;
  readonly openAborted: Deferred<void>;
  readonly openStarted: Deferred<void>;
}): HostDeckRoutePluginRegistration {
  return createHostDeckSseTransportRegistration({
    id: "device-revoke-sse-fixture",
    path: "/fixture/events",
    observeError: () => undefined,
    source: {
      async open({ request, signal }) {
        requireHostDeckRequestAuthentication(request, "device_cookie");
        if (input.delayOpen) {
          input.openStarted.resolve();
          await waitForAbort(signal);
          input.openAborted.resolve();
          throw new Error("SSE source opening continued after authority revocation.");
        }
        let nextCalls = 0;
        let closed = false;
        const pending = deferred<IteratorResult<unknown>>();
        const iterator: AsyncIterator<unknown> = {
          next() {
            nextCalls += 1;
            if (nextCalls === 1) {
              return Promise.resolve({
                done: false as const,
                value: projectionEvent(1)
              });
            }
            return pending.promise;
          },
          return() {
            if (!closed) {
              closed = true;
              input.iteratorClosed.resolve();
              pending.resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: true, value: undefined });
          }
        };
        return Object.freeze({
          [Symbol.asyncIterator]: () => iterator
        });
      }
    }
  });
}

function projectionEvent(cursor: number) {
  return selectedProjectionEventSchema.parse({
    captured_at: "2026-07-13T12:00:00.000Z",
    codex_event_id: `event-${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_notice: null,
    content_state: "complete",
    cursor,
    item_id: null,
    phase: "delta",
    role: "agent",
    session_id: "sess_revoke_preserved",
    text: "authorized before revoke",
    type: "message",
    upstream_at: null
  });
}

interface SecureJsonRequestInput {
  readonly csrf?: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly token?: string;
}

interface HttpResult {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly json: () => Record<string, unknown>;
}

async function secureJsonRequest(
  harness: Harness,
  input: SecureJsonRequestInput
): Promise<HttpResult> {
  const payload = input.payload === undefined ? null : JSON.stringify(input.payload);
  const authority = new URL(secureOrigin).host;
  const headers: Record<string, string | number> = {
    host: authority,
    accept: "application/json",
    "x-forwarded-for": remoteSource,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (input.method === "POST") headers.origin = secureOrigin;
  if (input.token !== undefined) {
    headers.cookie = `${hostDeckDeviceCookieName}=${input.token}`;
  }
  if (input.csrf !== undefined) {
    headers["x-hostdeck-csrf"] = input.csrf;
    headers["x-hostdeck-csrf-generation"] = "1";
  }
  if (payload !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  return httpExchange(harness, {
    method: input.method,
    path: input.path,
    headers
  }, payload);
}

function httpExchange(
  harness: Harness,
  options: RequestOptions,
  payload: string | null
): Promise<HttpResult> {
  const address = harness.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Device-revoke loopback listener is unavailable.");
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        ...options
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
            headers: response.headers,
            json: () => JSON.parse(body) as Record<string, unknown>
          });
        });
      }
    );
    request.once("error", reject);
    request.end(payload ?? undefined);
  });
}

function openSecureStream(harness: Harness, token: string): {
  readonly abort: () => void;
  readonly firstEvent: Promise<void>;
  readonly closed: Promise<void>;
  readonly body: () => string;
} {
  const address = harness.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Device-revoke loopback listener is unavailable.");
  }
  const firstEvent = deferred<void>();
  const closed = deferred<void>();
  const chunks: Buffer[] = [];
  const authority = new URL(secureOrigin).host;
  const request = httpRequest({
    host: "127.0.0.1",
    port: address.port,
    method: "GET",
    path: "/fixture/events",
    headers: {
      host: authority,
      accept: "text/event-stream",
      cookie: `${hostDeckDeviceCookieName}=${token}`,
      "x-forwarded-for": remoteSource,
      "x-forwarded-host": authority,
      "x-forwarded-proto": "https"
    }
  });
  request.on("response", (response) => {
    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString("utf8").includes("event: message")) {
        firstEvent.resolve();
      }
    });
    response.on("end", () => closed.resolve());
    response.on("close", () => closed.resolve());
  });
  request.once("error", (error) => {
    firstEvent.reject(error);
    closed.reject(error);
  });
  request.end();
  return {
    abort: () => request.destroy(),
    firstEvent: firstEvent.promise,
    closed: closed.promise,
    body: () => Buffer.concat(chunks).toString("utf8")
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function rawDevice(harness: Harness, deviceId: string): Record<string, unknown> {
  const row = harness.open.db
    .prepare("SELECT * FROM auth_devices WHERE id = ?")
    .get(deviceId);
  if (row === undefined) throw new Error("Expected auth device is missing.");
  return row as Record<string, unknown>;
}

function rawSession(harness: Harness): Record<string, unknown> {
  const row = harness.open.db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get("sess_revoke_preserved");
  if (row === undefined) throw new Error("Preserved session is missing.");
  return row as Record<string, unknown>;
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({
    error: { code, retryable: false }
  });
}

function assertRawFilesExclude(databasePath: string, values: readonly string[]): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${databasePath}${suffix}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    for (const value of values) expect(bytes.includes(Buffer.from(value))).toBe(false);
  }
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
