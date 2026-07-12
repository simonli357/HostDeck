import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget } from "@hostdeck/contracts";
import {
  type AuthorizeSelectedBrowserWriteInput,
  createAuthDeviceRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  HostDeckAuthRepositoryError,
  HostDeckSelectedAuditRepositoryError,
  hashSecret,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertHostDeckCsrfPolicy,
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  type HostDeckCsrfAuthorizationReceipt,
  type HostDeckCsrfPolicy,
  hostDeckCsrfPolicySnapshot,
  hostDeckCsrfRouteRegistrationId,
  requireHostDeckRequestCsrfWriteAuthorization
} from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckRoutePluginRegistration
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
import {
  createSecurityMutationAuditExecutor,
  type SecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";

const tempDirs: string[] = [];
const openAuditDatabases: Array<ReturnType<typeof openMigratedDatabase>> = [];
const deviceId = `client_${"c".repeat(24)}`;
const readDeviceId = `client_${"r".repeat(24)}`;
const rawDeviceToken = "B".repeat(43);
const readDeviceToken = "D".repeat(43);
const invalidDeviceToken = "I".repeat(43);
const expiredDeviceToken = "E".repeat(43);
const revokedDeviceToken = "V".repeat(43);
const initialCsrfToken = "C".repeat(43);
const rotatedCsrfToken = "R".repeat(43);
const nextCsrfToken = "N".repeat(43);
const createdAt = "2026-07-12T15:00:00.000Z";
const authenticatedAt = "2026-07-12T15:01:00.000Z";
const rotatedAt = "2026-07-12T15:02:00.000Z";
const writeAuthorizedAt = "2026-07-12T15:03:00.000Z";
const loopbackOrigin = "http://localhost";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: [loopbackOrigin],
  mode: "loopback",
  transport: "http"
});

afterEach(() => {
  for (const open of openAuditDatabases.splice(0)) {
    if (open.db.open) open.db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("selected CSRF bootstrap and browser-write boundary", () => {
  it("brands exact policy and route inputs while snapshotting detached ports", () => {
    const rotate = () => frozenRotation(deviceId, 2, rotatedCsrfToken, rotatedAt);
    const authorize = () => frozenAuthentication("write", deviceId, 1, writeAuthorizedAt);
    const mutablePort = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        authorizeBrowserWrite: authorize,
        rotateBootstrap: rotate
      }
    );
    const policyInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      csrf: mutablePort,
      now: () => new Date(rotatedAt)
    });
    const policy = createHostDeckCsrfPolicy(policyInput as never);
    expect(Object.keys(policy).sort()).toEqual([
      "authorizeBrowserWrite",
      "now",
      "rotateBootstrap"
    ]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.rotateBootstrap).toBe(rotate);
    expect(policy.authorizeBrowserWrite).toBe(authorize);
    expect(() => assertHostDeckCsrfPolicy(policy)).not.toThrow();
    expect(() => assertHostDeckCsrfPolicy(Object.freeze({ ...policy }))).toThrow();
    expect(hostDeckCsrfPolicySnapshot(policy)).toEqual(emptyCsrfSnapshot());
    expect(Object.isFrozen(hostDeckCsrfPolicySnapshot(policy))).toBe(true);

    mutablePort.rotateBootstrap = () => {
      throw new Error("mutated-port-private-sentinel");
    };
    mutablePort.authorizeBrowserWrite = () => {
      throw new Error("mutated-port-private-sentinel");
    };
    expect(policy.rotateBootstrap).toBe(rotate);
    expect(policy.authorizeBrowserWrite).toBe(authorize);

    const audit = createFixtureAuditExecutor();
    const routeInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      audit,
      csrf: policy
    });
    const registration = createHostDeckCsrfRouteRegistration(routeInput as never);
    expect(registration.id).toBe(hostDeckCsrfRouteRegistrationId);
    expect(registration.surface).toBe("api");
    expect(Object.isFrozen(registration)).toBe(true);

    let accessorCalls = 0;
    const inputAccessor = Object.defineProperty({}, "csrf", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("policy-input-private-sentinel");
      }
    });
    const portAccessor = Object.defineProperty(
      { rotateBootstrap: rotate },
      "authorizeBrowserWrite",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("policy-port-private-sentinel");
        }
      }
    );
    const hostileProxy = new Proxy(
      { csrf: mutablePort, now: () => new Date(rotatedAt) },
      {
        ownKeys() {
          throw new Error("policy-proxy-private-sentinel");
        }
      }
    );
    for (const candidate of [
      null,
      [],
      {},
      { csrf: mutablePort },
      { csrf: mutablePort, now: null },
      { csrf: mutablePort, now: () => new Date(rotatedAt), extra: true },
      Object.assign(Object.create({ inherited: true }), {
        csrf: mutablePort,
        now: () => new Date(rotatedAt)
      }),
      { csrf: {}, now: () => new Date(rotatedAt) },
      {
        csrf: { authorizeBrowserWrite: authorize, rotateBootstrap: rotate, extra: true },
        now: () => new Date(rotatedAt)
      },
      { csrf: portAccessor, now: () => new Date(rotatedAt) },
      inputAccessor,
      hostileProxy
    ]) {
      expect(() => createHostDeckCsrfPolicy(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);

    const auditAccessor = Object.freeze(
      Object.defineProperty(
        { reject: audit.reject, snapshot: audit.snapshot },
        "execute",
        {
          enumerable: true,
          get() {
            accessorCalls += 1;
            throw new Error("audit-accessor-private-sentinel");
          }
        }
      )
    );
    const frozenAuditProxy = new Proxy(audit, {
      ownKeys() {
        throw new Error("audit-proxy-private-sentinel");
      }
    });
    for (const candidate of [
      null,
      {},
      { audit, csrf: policy, extra: true },
      Object.assign(Object.create({ inherited: true }), { audit, csrf: policy }),
      { audit: { ...audit }, csrf: policy },
      { audit: Object.freeze({ ...audit, extra: true }), csrf: policy },
      { audit: auditAccessor, csrf: policy },
      { audit: frozenAuditProxy, csrf: policy },
      { audit, csrf: Object.freeze({ ...policy }) }
    ]) {
      expect(() => createHostDeckCsrfRouteRegistration(candidate as never)).toThrow(
        TypeError
      );
    }
    expect(accessorCalls).toBe(0);
  });

  it("authorizes one exact paired write, scrubs retained CSRF input, and bypasses only local admin", async () => {
    const events: string[] = [];
    let authorizeThis: unknown = "not-called";
    let nowThis: unknown = "not-called";
    let retainedInput: AuthorizeSelectedBrowserWriteInput | undefined;
    let observedReceipt: HostDeckCsrfAuthorizationReceipt | undefined;
    const authorizeBrowserWrite = function authorizeBrowserWrite(
      this: void,
      input: AuthorizeSelectedBrowserWriteInput
    ) {
      authorizeThis = this;
      retainedInput = input;
      events.push("csrf");
      expect(Object.keys(input).sort()).toEqual([
        "deviceId",
        "expectedCsrfGeneration",
        "now",
        "rawCsrfToken"
      ]);
      expect(input).toMatchObject({
        deviceId,
        expectedCsrfGeneration: 1,
        rawCsrfToken: initialCsrfToken
      });
      expect(input.now.toISOString()).toBe(writeAuthorizedAt);
      return frozenAuthentication("write", deviceId, 1, writeAuthorizedAt);
    };
    const now = function now(this: void) {
      nowThis = this;
      return new Date(writeAuthorizedAt);
    };
    const policy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite,
        rotateBootstrap: () => frozenRotation(deviceId, 2, rotatedCsrfToken, rotatedAt)
      },
      now
    });
    const app = createWriteFixtureApp(policy, {
      authenticateDeviceToken({ rawDeviceToken: candidate }) {
        events.push("authenticate");
        expect(candidate).toBe(rawDeviceToken);
        return frozenAuthentication("write", deviceId, 1, authenticatedAt);
      },
      onReceipt(receipt) {
        observedReceipt = receipt;
        events.push("downstream");
      }
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/fixture/write",
        headers: {
          ...deviceCookie(rawDeviceToken),
          "X-HostDeck-CSRF": initialCsrfToken,
          "x-HOSTDECK-csrf-generation": "1"
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        authority: "paired_device",
        device_id: deviceId,
        permission: "write",
        csrf_generation: 1,
        verified_at: writeAuthorizedAt
      });
      expect(events).toEqual(["authenticate", "csrf", "downstream"]);
      expect(authorizeThis).toBeUndefined();
      expect(nowThis).toBeUndefined();
      expect(Object.isFrozen(observedReceipt)).toBe(true);
      expect(JSON.stringify(observedReceipt)).not.toContain(initialCsrfToken);
      expect(retainedInput?.rawCsrfToken).toBeNull();
      expect(hostDeckCsrfPolicySnapshot(policy)).toEqual({
        ...emptyCsrfSnapshot(),
        write_authorizations: 1
      });
    } finally {
      await app.close();
    }

    let localPortCalls = 0;
    const localPolicy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          localPortCalls += 1;
          throw new Error("local-admin-port-private-sentinel");
        },
        rotateBootstrap() {
          localPortCalls += 1;
          throw new Error("local-admin-port-private-sentinel");
        }
      },
      now() {
        localPortCalls += 1;
        throw new Error("local-admin-clock-private-sentinel");
      }
    });
    const localApp = createWriteFixtureApp(localPolicy);
    await localApp.ready();
    try {
      const local = await localApp.inject({ method: "POST", url: "/fixture/write" });
      expect(local.statusCode, local.body).toBe(200);
      expect(local.json()).toEqual({
        authority: "local_admin",
        device_id: null,
        permission: "local_admin",
        csrf_generation: null,
        verified_at: null
      });
      expect(localPortCalls).toBe(0);

      const deviceOnly = createWriteFixtureApp(localPolicy, {
        mechanism: "device_cookie"
      });
      await deviceOnly.ready();
      try {
        expectStableError(
          await deviceOnly.inject({ method: "POST", url: "/fixture/write" }),
          401,
          "permission_denied"
        );
      } finally {
        await deviceOnly.close();
      }
    } finally {
      await localApp.close();
    }
  });

  it("rejects read authority and every malformed CSRF header before the authorization port", async () => {
    let authorizationCalls = 0;
    const policy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          authorizationCalls += 1;
          return frozenAuthentication("write", deviceId, 1, writeAuthorizedAt);
        },
        rotateBootstrap: () => frozenRotation(deviceId, 2, rotatedCsrfToken, rotatedAt)
      },
      now: () => new Date(writeAuthorizedAt)
    });
    const readApp = createWriteFixtureApp(policy, {
      authenticateDeviceToken: () =>
        frozenAuthentication("read", readDeviceId, 1, authenticatedAt)
    });
    await readApp.ready();
    try {
      expectStableError(
        await readApp.inject({
          method: "POST",
          url: "/fixture/write",
          headers: validWriteHeaders(readDeviceToken)
        }),
        403,
        "read_only"
      );
      expect(authorizationCalls).toBe(0);
    } finally {
      await readApp.close();
    }

    const app = createWriteFixtureApp(policy);
    await app.ready();
    try {
      const malformedHeaders: readonly Readonly<Record<string, string>>[] = [
        deviceCookie(rawDeviceToken),
        { ...deviceCookie(rawDeviceToken), "x-hostdeck-csrf": initialCsrfToken },
        {
          ...deviceCookie(rawDeviceToken),
          "x-hostdeck-csrf-generation": "1"
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf": "A".repeat(42)
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf": `${initialCsrfToken},${initialCsrfToken}`
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf": `${"A".repeat(42)}=`
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf": `%${"A".repeat(42)}`
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf-generation": "0"
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf-generation": "01"
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf-generation": "+1"
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf-generation": "1,2"
        },
        {
          ...validWriteHeaders(rawDeviceToken),
          "x-hostdeck-csrf-generation": "9007199254740992"
        }
      ];
      for (const headers of malformedHeaders) {
        const response = await app.inject({
          method: "POST",
          url: "/fixture/write",
          headers
        });
        expectStableError(response, 403, "permission_denied");
        expect(response.body).not.toContain(initialCsrfToken);
      }
      expect(authorizationCalls).toBe(0);
      expect(hostDeckCsrfPolicySnapshot(policy)).toMatchObject({
        authority_rejections: 1,
        header_rejections: malformedHeaders.length
      });
    } finally {
      await app.close();
    }

    const staleContext = createWriteFixtureApp(policy, {
      authenticateDeviceToken: () =>
        frozenAuthentication("write", deviceId, 2, authenticatedAt)
    });
    await staleContext.ready();
    try {
      expectStableError(
        await staleContext.inject({
          method: "POST",
          url: "/fixture/write",
          headers: validWriteHeaders(rawDeviceToken)
        }),
        403,
        "permission_denied"
      );
      expect(authorizationCalls).toBe(0);
    } finally {
      await staleContext.close();
    }
  });

  it("binds the exact bootstrap HTTP surface and authenticates before strict request validation", async () => {
    const events: string[] = [];
    const executions: unknown[] = [];
    let rotations = 0;
    let authentications = 0;
    const policy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: () =>
          frozenAuthentication("write", deviceId, 1, writeAuthorizedAt),
        rotateBootstrap(input) {
          rotations += 1;
          events.push("rotate");
          return frozenRotation(
            input.deviceId,
            input.expectedCsrfGeneration + 1,
            rotatedCsrfToken,
            input.now.toISOString()
          );
        }
      },
      now: () => new Date(rotatedAt)
    });
    const audit = createFixtureAuditExecutor({ events, executions });
    const app = createCsrfApp(policy, audit, {
      authenticateDeviceToken({ rawDeviceToken: candidate }) {
        authentications += 1;
        events.push("authenticate");
        if (candidate === rawDeviceToken) {
          return frozenAuthentication("write", deviceId, 1, authenticatedAt);
        }
        if (candidate === readDeviceToken) {
          return frozenAuthentication("read", readDeviceId, 1, authenticatedAt);
        }
        if (candidate === expiredDeviceToken) {
          throw new HostDeckAuthRepositoryError("device_expired", "private-expired");
        }
        if (candidate === revokedDeviceToken) {
          throw new HostDeckAuthRepositoryError("device_revoked", "private-revoked");
        }
        throw new HostDeckAuthRepositoryError("device_not_found", "private-invalid");
      }
    });
    await app.ready();
    try {
      const success = await injectBootstrap(app, rawDeviceToken, {
        operation_id: "op_csrf_route_write"
      });
      expect(success.statusCode, success.body).toBe(200);
      expect(success.headers["cache-control"]).toBe("no-store");
      expect(success.headers.pragma).toBe("no-cache");
      expect(success.headers["set-cookie"]).toBeUndefined();
      expect(success.json()).toEqual({
        csrf_token: rotatedCsrfToken,
        csrf_generation: 2,
        rotated_at: rotatedAt
      });

      const read = await injectBootstrap(app, readDeviceToken, {
        operation_id: "op_csrf_route_read"
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ csrf_generation: 2 });
      expect(rotations).toBe(2);
      expect(executions).toHaveLength(2);
      expect(executions[0]).toMatchObject({
        operation_id: "op_csrf_route_write",
        action: "csrf_bootstrap",
        actor: {
          type: "dashboard",
          device_id: deviceId,
          permission: "write",
          origin: loopbackOrigin
        },
        target: { type: "device", device_id: deviceId },
        payload_summary: { schema_version: 1, csrf_generation_before: 1 },
        phase: "accepted",
        outcome: "accepted"
      });
      expect(JSON.stringify(executions)).not.toContain(rawDeviceToken);
      expect(JSON.stringify(executions)).not.toContain(initialCsrfToken);
      expect(events.slice(0, 4)).toEqual([
        "authenticate",
        "audit:accepted",
        "rotate",
        "audit:terminal"
      ]);

      const beforeMalformed = { authentications, rotations };
      const unknownBody = await app.inject({
        method: "POST",
        url: "/api/v1/access/csrf",
        headers: deviceCookie(rawDeviceToken),
        payload: { operation_id: "op_csrf_unknown", extra: true }
      });
      const unknownQuery = await app.inject({
        method: "POST",
        url: "/api/v1/access/csrf?extra=1",
        headers: deviceCookie(rawDeviceToken),
        payload: { operation_id: "op_csrf_query" }
      });
      const malformedJson = await app.inject({
        method: "POST",
        url: "/api/v1/access/csrf",
        headers: {
          ...deviceCookie(rawDeviceToken),
          "content-type": "application/json"
        },
        payload: "{"
      });
      const unsupportedMedia = await app.inject({
        method: "POST",
        url: "/api/v1/access/csrf",
        headers: {
          ...deviceCookie(rawDeviceToken),
          "content-type": "text/plain"
        },
        payload: "private-body"
      });
      expectStableError(unknownBody, 400, "validation_error", "body");
      expectStableError(unknownQuery, 400, "validation_error", "query");
      expectStableError(malformedJson, 400, "malformed_request");
      expectStableError(unsupportedMedia, 415, "unsupported_media_type");
      for (const response of [
        unknownBody,
        unknownQuery,
        malformedJson,
        unsupportedMedia
      ]) {
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers.pragma).toBe("no-cache");
      }
      expect(rotations).toBe(beforeMalformed.rotations);
      expect(authentications).toBe(beforeMalformed.authentications + 3);

      const wrongMethod = await app.inject({
        method: "GET",
        url: "/api/v1/access/csrf"
      });
      const implicitHead = await app.inject({
        method: "HEAD",
        url: "/api/v1/access/csrf"
      });
      const trailingSlash = await app.inject({
        method: "POST",
        url: "/api/v1/access/csrf/",
        headers: deviceCookie(rawDeviceToken),
        payload: { operation_id: "op_csrf_slash" }
      });
      const wrongCase = await app.inject({
        method: "POST",
        url: "/api/v1/access/CSRF",
        headers: deviceCookie(rawDeviceToken),
        payload: { operation_id: "op_csrf_case" }
      });
      expectStableError(wrongMethod, 405, "method_not_allowed");
      expectStableError(implicitHead, 405, "method_not_allowed");
      expectStableError(trailingSlash, 404, "route_not_found");
      expectStableError(wrongCase, 404, "route_not_found");
      expect(rotations).toBe(beforeMalformed.rotations);

      for (const [token, expectedCode] of [
        [invalidDeviceToken, "permission_denied"],
        [expiredDeviceToken, "permission_denied"],
        [revokedDeviceToken, "permission_denied"]
      ] as const) {
        const response = await injectBootstrap(app, token, {
          operation_id: `op_csrf_reject_${token[0]?.toLowerCase()}`
        });
        expectStableError(response, 401, expectedCode);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers.pragma).toBe("no-cache");
        expect(response.body).not.toMatch(/private|cookie|bearer/iu);
      }
      const unpaired = await app.inject({
        method: "POST",
        url: "/api/v1/access/csrf",
        payload: { operation_id: "op_csrf_unpaired" }
      });
      expectStableError(unpaired, 401, "permission_denied");
      expect(rotations).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("composes real SQLite authentication, rotation, write verification, and durable audit truth", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: () => new Date(createdAt) });
    openAuditDatabases.push(open);
    const auth = createAuthDeviceRepository(open.db);
    auth.create({
      id: deviceId,
      rawDeviceToken,
      rawCsrfToken: initialCsrfToken,
      permission: "write",
      clientLabel: "Android debug phone",
      createdAt: new Date(createdAt)
    });
    const selectedCsrf = createSelectedCsrfAuthorizationRepository(open.db, {
      generateCsrfToken: () => rotatedCsrfToken
    });
    const auditRepository = createSelectedAuditRepository(open.db);
    const auditTimes = [
      "2026-07-12T15:01:30.000Z",
      "2026-07-12T15:02:30.000Z",
      "2026-07-12T15:05:30.000Z"
    ];
    let auditTimeIndex = 0;
    let auditIdIndex = 0;
    const audit = createSecurityMutationAuditExecutor({
      repository: auditRepository,
      now: () => requiredClock(auditTimes, auditTimeIndex++),
      create_record_id: () => `audit:csrf:real:${auditIdIndex++}`
    });
    const csrfTimes = [rotatedAt, writeAuthorizedAt];
    let csrfTimeIndex = 0;
    const policy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: (input) =>
          selectedCsrf.authorizeBrowserWrite(input),
        rotateBootstrap: (input) => selectedCsrf.rotateBootstrap(input)
      },
      now: () => new Date(requiredClock(csrfTimes, csrfTimeIndex++))
    });
    const authenticationTimes = [
      authenticatedAt,
      "2026-07-12T15:03:00.000Z",
      "2026-07-12T15:05:00.000Z"
    ];
    let authenticationTimeIndex = 0;
    const app = createCsrfApp(
      policy,
      audit,
      {
        authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
        now: () =>
          new Date(requiredClock(authenticationTimes, authenticationTimeIndex++))
      },
      {
        extraRoutePlugins: [
          writeFixtureRegistration(policy, { mechanism: "device_cookie" })
        ]
      }
    );
    await app.ready();
    try {
      const operationId = "op_csrf_real_sqlite";
      const bootstrap = await injectBootstrap(app, rawDeviceToken, {
        operation_id: operationId
      });
      expect(bootstrap.statusCode, bootstrap.body).toBe(200);
      expect(bootstrap.json()).toEqual({
        csrf_token: rotatedCsrfToken,
        csrf_generation: 2,
        rotated_at: rotatedAt
      });
      expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
        csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 }),
        csrf_generation: 2,
        csrf_rotated_at: rotatedAt,
        last_used_at: authenticatedAt,
        revoked_at: null
      });
      const trail = auditRepository.require(operationId);
      expect(trail).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            actor: { device_id: deviceId, permission: "write" },
            target: { type: "device", device_id: deviceId },
            payload_summary: {
              schema_version: 1,
              csrf_generation_before: 1
            }
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: {
              schema_version: 1,
              csrf_generation_after: 2,
              rotated: true
            },
            error_code: null
          }
        ]
      });

      const write = await app.inject({
        method: "POST",
        url: "/fixture/write",
        headers: {
          ...deviceCookie(rawDeviceToken),
          "x-hostdeck-csrf": rotatedCsrfToken,
          "x-hostdeck-csrf-generation": "2"
        }
      });
      expect(write.statusCode, write.body).toBe(200);
      expect(write.json()).toMatchObject({
        authority: "paired_device",
        device_id: deviceId,
        csrf_generation: 2,
        verified_at: writeAuthorizedAt
      });
      expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
        csrf_generation: 2,
        csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 }),
        last_used_at: writeAuthorizedAt
      });

      const duplicate = await injectBootstrap(app, rawDeviceToken, {
        operation_id: operationId
      });
      expectStableError(duplicate, 409, "operation_conflict");
      expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
        csrf_generation: 2,
        csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 })
      });
      expect(auditRepository.require(operationId)).toEqual(trail);
      expect(hostDeckCsrfPolicySnapshot(policy)).toMatchObject({
        audit_failures: 1,
        bootstrap_rotations: 1,
        write_authorizations: 1
      });

      const auditJson = JSON.stringify(
        open.db
          .prepare("SELECT record_json FROM selected_audit_events ORDER BY id")
          .all()
      );
      expect(auditJson).not.toContain(rawDeviceToken);
      expect(auditJson).not.toContain(initialCsrfToken);
      expect(auditJson).not.toContain(rotatedCsrfToken);
      for (const file of sqliteFiles(path)) {
        const bytes = readFileSync(file);
        for (const secret of [
          rawDeviceToken,
          initialCsrfToken,
          rotatedCsrfToken
        ]) {
          expect(bytes.includes(Buffer.from(secret))).toBe(false);
        }
      }
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }

    const reopened = openMigratedDatabase(path, { now: () => new Date(createdAt) });
    openAuditDatabases.push(reopened);
    try {
      expect(rawDeviceRow(reopened.db, deviceId)).toMatchObject({
        csrf_generation: 2,
        csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 }),
        last_used_at: "2026-07-12T15:05:00.000Z"
      });
      expect(createSelectedAuditRepository(reopened.db).require("op_csrf_real_sqlite"))
        .toMatchObject({ state: "terminal" });
    } finally {
      reopened.db.close();
    }
  });

  it("never rotates before accepted audit and never delivers a token after terminal audit failure", async () => {
    for (const stage of ["accepted", "terminal"] as const) {
      const open = openMigratedDatabase(tempDbPath(), {
        now: () => new Date(createdAt)
      });
      openAuditDatabases.push(open);
      createAuthDeviceRepository(open.db).create({
        id: deviceId,
        rawDeviceToken,
        rawCsrfToken: initialCsrfToken,
        permission: "write",
        clientLabel: "Android audit-failure phone",
        createdAt: new Date(createdAt)
      });
      let entropyCalls = 0;
      const selectedCsrf = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken() {
          entropyCalls += 1;
          return rotatedCsrfToken;
        }
      });
      const repository = createSelectedAuditRepository(open.db);
      const unavailable = () => {
        throw new HostDeckSelectedAuditRepositoryError(
          "audit_unavailable",
          "audit-private-unavailable-sentinel"
        );
      };
      const wrapped = repositoryWith(repository, {
        ...(stage === "accepted" ? { recordAccepted: unavailable } : {}),
        ...(stage === "terminal" ? { recordTerminal: unavailable } : {})
      });
      let auditClock = 0;
      let auditId = 0;
      const audit = createSecurityMutationAuditExecutor({
        repository: wrapped,
        now: () =>
          new Date(Date.parse(authenticatedAt) + auditClock++ * 60_000).toISOString(),
        create_record_id: () => `audit:csrf:${stage}:${auditId++}`
      });
      const policy = createHostDeckCsrfPolicy({
        csrf: {
          authorizeBrowserWrite: (input) =>
            selectedCsrf.authorizeBrowserWrite(input),
          rotateBootstrap: (input) => selectedCsrf.rotateBootstrap(input)
        },
        now: () => new Date(rotatedAt)
      });
      const app = createCsrfApp(policy, audit, {
        authenticateDeviceToken: () =>
          frozenAuthentication("write", deviceId, 1, authenticatedAt)
      });
      await app.ready();
      try {
        const operationId = `op_csrf_audit_${stage}`;
        const response = await injectBootstrap(app, rawDeviceToken, {
          operation_id: operationId
        });
        expectStableError(
          response,
          503,
          "audit_unavailable",
          undefined,
          stage === "accepted"
        );
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers.pragma).toBe("no-cache");
        expect(response.body).not.toContain(rotatedCsrfToken);
        expect(response.body).not.toContain("audit-private-unavailable-sentinel");
        expect(entropyCalls).toBe(stage === "accepted" ? 0 : 1);
        expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
          csrf_generation: stage === "accepted" ? 1 : 2,
          csrf_token_hash:
            stage === "accepted"
              ? hashSecret(initialCsrfToken, { minLength: 24 })
              : hashSecret(rotatedCsrfToken, { minLength: 24 })
        });
        if (stage === "accepted") {
          expect(repository.get(operationId)).toBeNull();
        } else {
          expect(repository.require(operationId)).toMatchObject({
            state: "pending",
            records: [{ phase: "accepted", outcome: "accepted" }]
          });
        }
        expect(hostDeckCsrfPolicySnapshot(policy)).toMatchObject({
          audit_failures: 1,
          bootstrap_rotations: stage === "accepted" ? 0 : 1
        });
      } finally {
        await app.close();
        if (open.db.open) open.db.close();
      }
    }
  });

  it("records known rotation conflict as failed and uncertain output as incomplete", async () => {
    const open = openMigratedDatabase(tempDbPath(), {
      now: () => new Date(createdAt)
    });
    openAuditDatabases.push(open);
    const repository = createSelectedAuditRepository(open.db);
    let auditClock = 0;
    let auditId = 0;
    const audit = createSecurityMutationAuditExecutor({
      repository,
      now: () =>
        new Date(Date.parse(authenticatedAt) + auditClock++ * 1_000).toISOString(),
      create_record_id: () => `audit:csrf:rotation-failure:${auditId++}`
    });
    let rotationCalls = 0;
    const privateSentinel = "rotation-private-failure-sentinel";
    const policy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: () =>
          frozenAuthentication("write", deviceId, 1, writeAuthorizedAt),
        rotateBootstrap(input) {
          rotationCalls += 1;
          if (rotationCalls === 1) {
            throw new HostDeckAuthRepositoryError(
              "csrf_rotation_conflict",
              privateSentinel
            );
          }
          if (rotationCalls === 2) throw new Error(privateSentinel);
          if (rotationCalls === 3) {
            return frozenRotation(deviceId, 3, rotatedCsrfToken, rotatedAt);
          }
          input.now.setTime(Date.parse("2026-07-12T15:06:00.000Z"));
          return frozenRotation(
            deviceId,
            2,
            rotatedCsrfToken,
            input.now.toISOString()
          );
        }
      },
      now: () => new Date(rotatedAt)
    });
    const app = createCsrfApp(policy, audit, {
      authenticateDeviceToken: () =>
        frozenAuthentication("write", deviceId, 1, authenticatedAt)
    });
    await app.ready();
    try {
      const cases = [
        {
          operationId: "op_csrf_rotation_conflict",
          status: 409,
          code: "operation_conflict",
          outcome: "failed"
        },
        {
          operationId: "op_csrf_rotation_throw",
          status: 500,
          code: "internal_error",
          outcome: "incomplete"
        },
        {
          operationId: "op_csrf_rotation_incoherent",
          status: 500,
          code: "internal_error",
          outcome: "incomplete"
        },
        {
          operationId: "op_csrf_rotation_mutated_clock",
          status: 500,
          code: "internal_error",
          outcome: "incomplete"
        }
      ] as const;
      for (const testCase of cases) {
        const response = await injectBootstrap(app, rawDeviceToken, {
          operation_id: testCase.operationId
        });
        expectStableError(response, testCase.status, testCase.code);
        expect(response.body).not.toContain(privateSentinel);
        expect(response.body).not.toContain(rotatedCsrfToken);
        expect(repository.require(testCase.operationId)).toMatchObject({
          state: "terminal",
          records: [
            { phase: "accepted", outcome: "accepted" },
            {
              phase: "terminal",
              outcome: testCase.outcome,
              payload_summary: { schema_version: 1 },
              error_code:
                testCase.code === "operation_conflict"
                  ? "operation_conflict"
                  : "internal_error"
            }
          ]
        });
      }
      expect(rotationCalls).toBe(4);
      expect(hostDeckCsrfPolicySnapshot(policy)).toMatchObject({
        bootstrap_failures: 4,
        operation_conflicts: 1,
        storage_failures: 3
      });
      expect(JSON.stringify(open.db.prepare("SELECT * FROM selected_audit_events").all()))
        .not.toContain(privateSentinel);
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });

  it("serializes two stale bootstrap contexts to one winner and permits the next generation", async () => {
    const open = openMigratedDatabase(tempDbPath(), {
      now: () => new Date(createdAt)
    });
    openAuditDatabases.push(open);
    createAuthDeviceRepository(open.db).create({
      id: deviceId,
      rawDeviceToken,
      rawCsrfToken: initialCsrfToken,
      permission: "write",
      clientLabel: "Android race phone",
      createdAt: new Date(createdAt)
    });
    const generatedTokens = [rotatedCsrfToken, nextCsrfToken];
    let generatedTokenIndex = 0;
    const selectedCsrf = createSelectedCsrfAuthorizationRepository(open.db, {
      generateCsrfToken: () =>
        requiredClock(generatedTokens, generatedTokenIndex++)
    });
    const repository = createSelectedAuditRepository(open.db);
    let auditClock = 0;
    let auditId = 0;
    const audit = createSecurityMutationAuditExecutor({
      repository,
      now: () =>
        new Date(Date.parse(authenticatedAt) + auditClock++ * 1_000).toISOString(),
      create_record_id: () => `audit:csrf:race:${auditId++}`
    });
    const rotationTimes = [
      rotatedAt,
      rotatedAt,
      "2026-07-12T15:04:00.000Z"
    ];
    let rotationTimeIndex = 0;
    const policy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: (input) =>
          selectedCsrf.authorizeBrowserWrite(input),
        rotateBootstrap: (input) => selectedCsrf.rotateBootstrap(input)
      },
      now: () =>
        new Date(requiredClock(rotationTimes, rotationTimeIndex++))
    });
    let authenticationCalls = 0;
    const app = createCsrfApp(policy, audit, {
      authenticateDeviceToken: () => {
        authenticationCalls += 1;
        return frozenAuthentication(
          "write",
          deviceId,
          authenticationCalls <= 2 ? 1 : 2,
          authenticatedAt
        );
      }
    });
    await app.ready();
    try {
      const operationIds = ["op_csrf_race_alpha", "op_csrf_race_bravo"] as const;
      const firstPair = await Promise.all(
        operationIds.map((operationId) =>
          injectBootstrap(app, rawDeviceToken, { operation_id: operationId })
        )
      );
      expect(firstPair.map((response) => response.statusCode).sort()).toEqual([
        200, 409
      ]);
      const winner = firstPair.find((response) => response.statusCode === 200);
      const loser = firstPair.find((response) => response.statusCode === 409);
      expect(winner?.json()).toEqual({
        csrf_token: rotatedCsrfToken,
        csrf_generation: 2,
        rotated_at: rotatedAt
      });
      expect(loser?.json()).toMatchObject({
        error: { code: "operation_conflict", retryable: false }
      });
      expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
        csrf_generation: 2,
        csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 })
      });
      expect(
        operationIds.map(
          (operationId) =>
            repository.require(operationId).records.at(-1)?.outcome
        ).sort()
      ).toEqual(["failed", "succeeded"]);

      const next = await injectBootstrap(app, rawDeviceToken, {
        operation_id: "op_csrf_race_next"
      });
      expect(next.statusCode, next.body).toBe(200);
      expect(next.json()).toEqual({
        csrf_token: nextCsrfToken,
        csrf_generation: 3,
        rotated_at: "2026-07-12T15:04:00.000Z"
      });
      expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
        csrf_generation: 3,
        csrf_token_hash: hashSecret(nextCsrfToken, { minLength: 24 })
      });
      expect(generatedTokenIndex).toBe(2);
      expect(hostDeckCsrfPolicySnapshot(policy)).toMatchObject({
        bootstrap_failures: 1,
        bootstrap_rotations: 2,
        operation_conflicts: 1
      });
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });

  it("maps contextual write authority failures without reflecting secrets or advancing downstream", async () => {
    const privateSentinel = "write-authority-private-sentinel";
    const cases = [
      {
        error: new HostDeckAuthRepositoryError("csrf_mismatch", privateSentinel),
        status: 403,
        code: "permission_denied"
      },
      {
        error: new HostDeckAuthRepositoryError("read_only", privateSentinel),
        status: 403,
        code: "read_only"
      },
      {
        error: new HostDeckAuthRepositoryError("device_revoked", privateSentinel),
        status: 401,
        code: "permission_denied"
      },
      {
        error: new HostDeckAuthRepositoryError(
          "authentication_conflict",
          privateSentinel
        ),
        status: 409,
        code: "operation_conflict"
      },
      {
        error: new HostDeckAuthRepositoryError(
          "invalid_csrf_authorization",
          privateSentinel
        ),
        status: 500,
        code: "storage_error"
      }
    ] as const;
    for (const testCase of cases) {
      let downstreamCalls = 0;
      let retained: { rawCsrfToken?: unknown } | undefined;
      const policy = createHostDeckCsrfPolicy({
        csrf: {
          authorizeBrowserWrite(input) {
            retained = input;
            throw testCase.error;
          },
          rotateBootstrap: () =>
            frozenRotation(deviceId, 2, rotatedCsrfToken, rotatedAt)
        },
        now: () => new Date(writeAuthorizedAt)
      });
      const app = createWriteFixtureApp(policy, {
        onReceipt() {
          downstreamCalls += 1;
        }
      });
      await app.ready();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/fixture/write",
          headers: validWriteHeaders(rawDeviceToken)
        });
        expectStableError(response, testCase.status, testCase.code);
        expect(response.body).not.toContain(privateSentinel);
        expect(response.body).not.toContain(initialCsrfToken);
        expect(retained?.rawCsrfToken).toBeNull();
        expect(downstreamCalls).toBe(0);
      } finally {
        await app.close();
      }
    }
  });

  it("parses raw CSRF headers deterministically across duplicate and hostile Node shapes", async () => {
    let authorizationCalls = 0;
    const policy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: () => {
          authorizationCalls += 1;
          return frozenAuthentication("write", deviceId, 1, writeAuthorizedAt);
        },
        rotateBootstrap: () => frozenRotation(deviceId, 2, rotatedCsrfToken, rotatedAt)
      },
      now: () => new Date(writeAuthorizedAt)
    });
    const port = await getAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = createWriteFixtureApp(policy, {
      trustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigins: [origin],
        mode: "loopback",
        transport: "http"
      })
    });
    await app.listen({ host: "127.0.0.1", port, listenTextResolver: () => "" });
    try {
      const valid = await rawExchange(
        port,
        rawWriteRequest(port, [
          `X-HostDeck-CSRF: ${initialCsrfToken}`,
          "x-HOSTDECK-csrf-generation: 1"
        ])
      );
      expect(statusCode(valid)).toBe(200);
      expect(valid).not.toContain(rawDeviceToken);
      expect(valid).not.toContain(initialCsrfToken);

      const duplicateToken = await rawExchange(
        port,
        rawWriteRequest(port, [
          `X-HostDeck-CSRF: ${initialCsrfToken}`,
          `x-hostdeck-csrf: ${initialCsrfToken}`,
          "X-HostDeck-CSRF-Generation: 1"
        ])
      );
      expect(statusCode(duplicateToken)).toBe(403);
      expect(duplicateToken).not.toContain(rawDeviceToken);
      expect(duplicateToken).not.toContain(initialCsrfToken);

      const duplicateGeneration = await rawExchange(
        port,
        rawWriteRequest(port, [
          `X-HostDeck-CSRF: ${initialCsrfToken}`,
          "X-HostDeck-CSRF-Generation: 1",
          "x-hostdeck-csrf-generation: 1"
        ])
      );
      expect(statusCode(duplicateGeneration)).toBe(403);
      expect(duplicateGeneration).not.toContain(initialCsrfToken);
      expect(authorizationCalls).toBe(1);
    } finally {
      await app.close();
    }

    const bootstrapPort = await getAvailablePort();
    const bootstrapOrigin = `http://127.0.0.1:${bootstrapPort}`;
    const bootstrapPolicy = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: () =>
          frozenAuthentication("write", deviceId, 1, writeAuthorizedAt),
        rotateBootstrap: (input) =>
          frozenRotation(
            input.deviceId,
            input.expectedCsrfGeneration + 1,
            rotatedCsrfToken,
            input.now.toISOString()
          )
      },
      now: () => new Date(rotatedAt)
    });
    const bootstrapApp = createCsrfApp(
      bootstrapPolicy,
      createFixtureAuditExecutor(),
      {
        authenticateDeviceToken: () =>
          frozenAuthentication("write", deviceId, 1, authenticatedAt)
      },
      {
        trustPolicy: createHostDeckRequestTrustPolicy({
          allowedOrigins: [bootstrapOrigin],
          mode: "loopback",
          transport: "http"
        })
      }
    );
    await bootstrapApp.listen({
      host: "127.0.0.1",
      port: bootstrapPort,
      listenTextResolver: () => ""
    });
    try {
      const rawBootstrap = await rawExchange(
        bootstrapPort,
        rawBootstrapRequest(bootstrapPort, "op_csrf_raw_bootstrap")
      );
      const normalized = rawBootstrap.toLowerCase();
      expect(statusCode(rawBootstrap)).toBe(200);
      expect(normalized).toContain("cache-control: no-store");
      expect(normalized).toContain("pragma: no-cache");
      expect(normalized).not.toContain("set-cookie:");
      expect(rawBootstrap).toContain(rotatedCsrfToken);
      expect(rawBootstrap).not.toContain(rawDeviceToken);
    } finally {
      await bootstrapApp.close();
    }

    const accessorHeaders = [...rawHeaderFixture()];
    Object.defineProperty(accessorHeaders, "2", {
      enumerable: true,
      get() {
        throw new Error("raw-header-accessor-private-sentinel");
      }
    });
    const proxyHeaders = new Proxy(rawHeaderFixture(), {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("raw-header-proxy-private-sentinel");
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const oversizedHeaders = Array.from(
      { length: 514 },
      (_, index) => (index % 2 === 0 ? `x-unrelated-${index}` : "value")
    );
    for (const rawHeaders of [
      ["x-hostdeck-csrf", initialCsrfToken, "odd"],
      accessorHeaders,
      proxyHeaders,
      oversizedHeaders
    ]) {
      const hostileApp = createWriteFixtureApp(policy, { rawHeaders });
      await hostileApp.ready();
      try {
        const response = await hostileApp.inject({
          method: "POST",
          url: "/fixture/write",
          headers: validWriteHeaders(rawDeviceToken)
        });
        expectStableError(response, 403, "permission_denied");
        expect(response.body).not.toMatch(/raw-header|private-sentinel/iu);
      } finally {
        await hostileApp.close();
      }
    }
    expect(authorizationCalls).toBe(1);
  });

  it("sanitizes malformed and throwing CSRF ports and audit executors", async () => {
    const privateSentinel = "csrf-private-contract-sentinel";
    const writeCases: readonly ((input: AuthorizeSelectedBrowserWriteInput) => unknown)[] = [
      () => ({ ...frozenAuthentication("write", deviceId, 1, writeAuthorizedAt) }),
      () => Promise.resolve(frozenAuthentication("write", deviceId, 1, writeAuthorizedAt)),
      () =>
        Object.freeze({
          ...frozenAuthentication("write", deviceId, 1, writeAuthorizedAt),
          extra: privateSentinel
        }),
      () =>
        Object.freeze({
          ...frozenAuthentication("write", deviceId, 1, writeAuthorizedAt),
          readOnly: true
        }),
      () => {
        throw new Error(privateSentinel);
      },
      (input) => {
        input.now.setTime(Date.parse("2026-07-12T15:04:00.000Z"));
        return frozenAuthentication(
          "write",
          deviceId,
          1,
          input.now.toISOString()
        );
      }
    ];
    for (const returned of writeCases) {
      const observations: HostDeckInternalErrorObservation[] = [];
      let retained: { rawCsrfToken?: unknown } | undefined;
      const policy = createHostDeckCsrfPolicy({
        csrf: {
          authorizeBrowserWrite(input) {
            retained = input;
            return returned(input);
          },
          rotateBootstrap: () =>
            frozenRotation(deviceId, 2, rotatedCsrfToken, rotatedAt)
        },
        now: () => new Date(writeAuthorizedAt)
      });
      const app = createWriteFixtureApp(policy, { observations });
      await app.ready();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/fixture/write",
          headers: validWriteHeaders(rawDeviceToken)
        });
        expectStableError(response, 500, "storage_error");
        expect(response.body).not.toContain(privateSentinel);
        expect(response.body).not.toContain(initialCsrfToken);
        expect(retained?.rawCsrfToken).toBeNull();
        expect(observations).toHaveLength(0);
      } finally {
        await app.close();
      }
    }

    const executorCases: readonly (() => unknown)[] = [
      () => {
        throw new Error(privateSentinel);
      },
      () => ({ outcome: "succeeded", response: bootstrapResponse() }),
      () => Object.freeze({ outcome: "succeeded", response: bootstrapResponse() }),
      () => Object.freeze({ outcome: "failed", error_code: "private_invalid_code" }),
      () => Object.freeze({ outcome: "unknown", response: bootstrapResponse() })
    ];
    for (const executeResult of executorCases) {
      const policy = createHostDeckCsrfPolicy({
        csrf: {
          authorizeBrowserWrite: () =>
            frozenAuthentication("write", deviceId, 1, writeAuthorizedAt),
          rotateBootstrap: () =>
            frozenRotation(deviceId, 2, rotatedCsrfToken, rotatedAt)
        },
        now: () => new Date(rotatedAt)
      });
      const forged = auditExecutorWith(async () => executeResult());
      expect(() =>
        createHostDeckCsrfRouteRegistration({ audit: forged, csrf: policy })
      ).toThrow(
        "HostDeck security mutation audit executor must be created by createSecurityMutationAuditExecutor."
      );
    }
  });
});

interface CreateFixtureAuditExecutorOptions {
  readonly events?: string[];
  readonly executions?: unknown[];
}

function createFixtureAuditExecutor(
  options: CreateFixtureAuditExecutorOptions = {}
): SecurityMutationAuditExecutor {
  const open = openMigratedDatabase(tempDbPath(), {
    now: () => new Date(createdAt)
  });
  openAuditDatabases.push(open);
  const repository = createSelectedAuditRepository(open.db);
  const observedRepository = repositoryWith(repository, {
    recordAccepted(record) {
      const trail = repository.recordAccepted(record);
      options.executions?.push(record);
      options.events?.push("audit:accepted");
      return trail;
    },
    recordTerminal(record) {
      const trail = repository.recordTerminal(record);
      options.events?.push("audit:terminal");
      return trail;
    }
  });
  let clockIndex = 0;
  let recordIndex = 0;
  return createSecurityMutationAuditExecutor({
    repository: observedRepository,
    now: () =>
      new Date(Date.parse(rotatedAt) + clockIndex++ * 1_000).toISOString(),
    create_record_id: () => `audit:csrf:fixture:${recordIndex++}`
  });
}

interface WriteFixtureOptions {
  readonly authenticateDeviceToken?: HostDeckDeviceAuthenticationPort;
  readonly mechanism?: "device_cookie" | "local_admin_or_device_cookie";
  readonly observations?: HostDeckInternalErrorObservation[];
  readonly onReceipt?: (receipt: HostDeckCsrfAuthorizationReceipt) => void;
  readonly rawHeaders?: readonly string[];
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createWriteFixtureApp(
  policy: HostDeckCsrfPolicy,
  options: WriteFixtureOptions = {}
) {
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => options.observations?.push(observation),
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken:
        options.authenticateDeviceToken ??
        (({ rawDeviceToken: candidate }) => {
          if (candidate === rawDeviceToken) {
            return frozenAuthentication("write", deviceId, 1, authenticatedAt);
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Fixture device is unavailable."
          );
        }),
      now: () => new Date(authenticatedAt)
    }),
    requestTrustPolicy: options.trustPolicy ?? loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [writeFixtureRegistration(policy, options)]
  });
}

function writeFixtureRegistration(
  policy: HostDeckCsrfPolicy,
  options: WriteFixtureOptions
): HostDeckRoutePluginRegistration {
  const registration: HostDeckRoutePluginRegistration = {
    id: "csrf-write-fixture",
    surface: "api",
    register(app) {
      app.post(
        "/fixture/write",
        {
          schema: {
            response: {
              200: z
                .object({
                  authority: z.enum(["local_admin", "paired_device"]),
                  device_id: z.string().nullable(),
                  permission: z.enum(["local_admin", "write"]),
                  csrf_generation: z.number().int().positive().nullable(),
                  verified_at: z.string().datetime().nullable()
                })
                .strict()
            }
          }
        },
        async (request) => {
          if (options.rawHeaders !== undefined) {
            Object.defineProperty(request.raw, "rawHeaders", {
              configurable: true,
              value: options.rawHeaders,
              writable: true
            });
          }
          const receipt = requireHostDeckRequestCsrfWriteAuthorization(
            request,
            options.mechanism ?? "local_admin_or_device_cookie",
            policy
          );
          options.onReceipt?.(receipt);
          return receipt;
        }
      );
    }
  };
  return Object.freeze(registration);
}

interface CreateCsrfAppOptions {
  readonly extraRoutePlugins?: readonly HostDeckRoutePluginRegistration[];
  readonly observations?: HostDeckInternalErrorObservation[];
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createCsrfApp(
  policy: HostDeckCsrfPolicy,
  audit: SecurityMutationAuditExecutor,
  authentication: {
    readonly authenticateDeviceToken: HostDeckDeviceAuthenticationPort;
    readonly now?: () => Date;
  },
  options: CreateCsrfAppOptions = {}
) {
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => options.observations?.push(observation),
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: authentication.authenticateDeviceToken,
      now: authentication.now ?? (() => new Date(authenticatedAt))
    }),
    requestTrustPolicy: options.trustPolicy ?? loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [
      createHostDeckCsrfRouteRegistration({ audit, csrf: policy }),
      ...(options.extraRoutePlugins ?? [])
    ]
  });
}

function frozenAuthentication(
  permission: "read" | "write",
  id: string,
  generation: number,
  lastUsedAt: string
) {
  const device = Object.freeze({
    id,
    token_hash: `sha256:${"a".repeat(64)}`,
    csrf_token_hash: `sha256:${"b".repeat(64)}`,
    csrf_generation: generation,
    csrf_rotated_at: createdAt,
    client_label: "Android phone",
    permission,
    created_at: createdAt,
    last_used_at: lastUsedAt,
    expires_at: null,
    revoked_at: null
  });
  return Object.freeze({
    trusted: true as const,
    readOnly: permission === "read",
    device
  });
}

function frozenRotation(
  id: string,
  generation: number,
  token: string,
  at: string
) {
  return Object.freeze({
    deviceId: id,
    rawCsrfToken: token,
    csrfGeneration: generation,
    rotatedAt: at
  });
}

function emptyCsrfSnapshot() {
  return {
    audit_failures: 0,
    authority_rejections: 0,
    bootstrap_failures: 0,
    bootstrap_rotations: 0,
    header_rejections: 0,
    operation_conflicts: 0,
    storage_failures: 0,
    write_authorizations: 0
  };
}

function bootstrapResponse() {
  return Object.freeze({
    csrf_token: rotatedCsrfToken,
    csrf_generation: 2,
    rotated_at: rotatedAt
  });
}

function auditExecutorWith(execute: unknown): SecurityMutationAuditExecutor {
  return Object.freeze({
    execute,
    reject: () => Object.freeze({ outcome: "rejected", error_code: "internal_error" }),
    snapshot: () =>
      Object.freeze({
        accepted_operations: 0,
        emergency_lock_audit_deferrals: 0,
        failed_operations: 0,
        incomplete_operations: 0,
        rejected_operations: 0,
        response_preparation_failures: 0,
        succeeded_operations: 0,
        terminal_audit_failures: 0,
        transition_contract_failures: 0
      })
  }) as SecurityMutationAuditExecutor;
}

function repositoryWith(
  repository: SelectedAuditRepository,
  overrides: Partial<SelectedAuditRepository>
): SelectedAuditRepository {
  return {
    get: overrides.get ?? repository.get,
    require: overrides.require ?? repository.require,
    recordAccepted: overrides.recordAccepted ?? repository.recordAccepted,
    recordRejected: overrides.recordRejected ?? repository.recordRejected,
    recordTerminal: overrides.recordTerminal ?? repository.recordTerminal
  };
}

function deviceCookie(token: string): Readonly<Record<string, string>> {
  return { cookie: `${hostDeckDeviceCookieName}=${token}` };
}

function validWriteHeaders(token: string): Readonly<Record<string, string>> {
  return {
    ...deviceCookie(token),
    "x-hostdeck-csrf": initialCsrfToken,
    "x-hostdeck-csrf-generation": "1"
  };
}

function rawHeaderFixture(): string[] {
  return [
    "cookie",
    `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
    "x-hostdeck-csrf",
    initialCsrfToken,
    "x-hostdeck-csrf-generation",
    "1"
  ];
}

function rawWriteRequest(port: number, csrfHeaders: readonly string[]): string {
  return [
    "POST /fixture/write HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Cookie: ${hostDeckDeviceCookieName}=${rawDeviceToken}`,
    ...csrfHeaders,
    "Content-Length: 0",
    "Connection: close",
    "",
    ""
  ].join("\r\n");
}

function rawBootstrapRequest(port: number, operationId: string): string {
  const body = JSON.stringify({ operation_id: operationId });
  return [
    "POST /api/v1/access/csrf HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Cookie: ${hostDeckDeviceCookieName}=${rawDeviceToken}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
    "Connection: close",
    "",
    body
  ].join("\r\n");
}

function injectBootstrap(
  app: ReturnType<typeof createCsrfApp>,
  token: string,
  payload: Readonly<Record<string, unknown>>
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/access/csrf",
    headers: deviceCookie(token),
    payload
  });
}

function expectStableError(
  response: Awaited<ReturnType<ReturnType<typeof createCsrfApp>["inject"]>>,
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

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Missing probe address.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.end(request);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function statusCode(response: string): number {
  const match = /^HTTP\/1\.1 (\d{3}) /u.exec(response);
  if (match?.[1] === undefined) throw new Error("Raw response has no status line.");
  return Number(match[1]);
}

function requiredClock(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture clock value ${index}.`);
  return value;
}

function rawDeviceRow(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  id: string
): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Missing auth device ${id}.`);
  return row as Readonly<Record<string, unknown>>;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-csrf-route-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function sqliteFiles(path: string): readonly string[] {
  return [path, `${path}-wal`, `${path}-shm`].filter(existsSync);
}
