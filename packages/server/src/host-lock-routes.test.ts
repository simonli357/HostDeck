import "reflect-metadata";

import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget, defaultRetentionPolicy } from "@hostdeck/contracts";
import {
  createSelectedAuditRepository,
  createSettingsRepository,
  HostDeckAuthRepositoryError,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import {
  BasicConstraintsExtension,
  cryptoProvider,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator
} from "@peculiar/x509";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import {
  HostDeckHttpError,
  installHostDeckErrorPolicy
} from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  installHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  installHostDeckRequestTrustGate
} from "./fastify-request-trust.js";
import { installHostDeckZodCompilers } from "./fastify-zod.js";
import {
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  hostDeckHostLockPolicySnapshot,
  requireHostDeckHostUnlocked
} from "./host-lock-routes.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";

const dirs: string[] = [];
const databases: Array<{ close: () => unknown }> = [];
const origin = "http://localhost";
const secureOrigin = "https://localhost";
const rawDeviceToken = "D".repeat(43);
const rawCsrfToken = "C".repeat(43);
const createdAt = "2026-07-12T12:00:00.000Z";
const authenticatedAt = "2026-07-12T12:01:00.000Z";
const csrfAt = "2026-07-12T12:02:00.000Z";
const transitionAt = "2026-07-12T12:03:00.000Z";

cryptoProvider.set(globalThis.crypto);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected host-lock authority boundary", () => {
  it("brands exact detached ports, reads fresh durable state, and gates locked hosts with one fixed 423", () => {
    let state = settings(false, createdAt);
    let observedThis: unknown = "not-called";
    const policy = createHostDeckHostLockPolicy({
      settings: {
        read: function read(this: void) {
          observedThis = this;
          return state;
        },
        transition: function transition(this: void) {
          observedThis = this;
          throw new Error("not used");
        }
      },
      now: () => new Date(transitionAt)
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(requireHostDeckHostUnlocked(policy)).toEqual({ locked: false, settings_updated_at: createdAt });
    state = settings(true, transitionAt);
    let caught: unknown;
    try {
      requireHostDeckHostUnlocked(policy);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostDeckHttpError);
    expect(caught).toMatchObject({ statusCode: 423, code: "host_locked", envelope: { retryable: false } });
    expect(String(caught)).not.toContain("C:/hostdeck/state");
    expect(observedThis).toBeUndefined();
    expect(hostDeckHostLockPolicySnapshot(policy)).toEqual({
      access_reads: 2,
      audit_failures: 0,
      gate_checks: 2,
      gate_rejections: 1,
      lock_changes: 0,
      lock_noops: 0,
      storage_failures: 0,
      transitions: 0
    });
    expect(Object.isFrozen(hostDeckHostLockPolicySnapshot(policy))).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "settings", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return {};
      }
    });
    for (const candidate of [
      null,
      {},
      { settings: { read: () => state, transition: () => undefined }, now: () => new Date(), extra: true },
      { settings: { read: () => state }, now: () => new Date() },
      { settings: { read: () => state, transition: () => undefined, extra: true }, now: () => new Date() },
      Object.assign(Object.create({ inherited: true }), { settings: {}, now: () => new Date() }),
      accessor
    ]) {
      expect(() => createHostDeckHostLockPolicy(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);

    const unavailable = createHostDeckHostLockPolicy({
      settings: {
        read: () => {
          throw new Error("private settings failure");
        },
        transition: () => undefined
      },
      now: () => new Date(transitionAt)
    });
    expect(() => requireHostDeckHostUnlocked(unavailable)).toThrowError(
      expect.objectContaining({ code: "storage_error", statusCode: 500 })
    );
    expect(hostDeckHostLockPolicySnapshot(unavailable)).toMatchObject({
      gate_checks: 1,
      storage_failures: 1
    });
  });

  it("binds only the selected routes and durably audits local-admin lock, no-op, and unlock", async () => {
    const fixture = createFixture();
    const app = fixture.app;
    await app.ready();
    try {
      const browserRead = await app.inject({ method: "GET", url: "/api/v1/access", headers: { origin } });
      expect(browserRead.statusCode, browserRead.body).toBe(200);
      expect(browserRead.headers["cache-control"]).toBe("no-store");
      expect(browserRead.headers.pragma).toBe("no-cache");
      expect(browserRead.json()).toEqual({
        authentication_state: "unpaired",
        device_id: null,
        permission: null,
        device_expires_at: null,
        configured_origin: origin,
        network_mode: "loopback",
        transport: "http",
        locked: false,
        can_read_sessions: true,
        can_write_sessions: false,
        can_lock: false,
        can_unlock: false
      });

      const locked = await app.inject({ method: "POST", url: "/api/v1/access/lock", payload: request("op_lock_local") });
      expect(locked.statusCode, locked.body).toBe(200);
      expect(locked.json()).toMatchObject({ authentication_state: "local_admin", locked: true, can_lock: true, can_unlock: true });
      const noOp = await app.inject({ method: "POST", url: "/api/v1/access/lock", payload: request("op_lock_noop") });
      expect(noOp.statusCode, noOp.body).toBe(200);
      expect(noOp.json().locked).toBe(true);
      const unlocked = await app.inject({ method: "POST", url: "/api/v1/access/unlock", payload: request("op_unlock_local") });
      expect(unlocked.statusCode, unlocked.body).toBe(200);
      expect(unlocked.json()).toMatchObject({ locked: false, can_write_sessions: true });

      expect(fixture.repository.require("op_lock_local").records).toMatchObject([
        { phase: "accepted", action: "lock", actor: { type: "cli" }, payload_summary: { schema_version: 1, requested_locked: true } },
        { phase: "terminal", outcome: "succeeded", payload_summary: { schema_version: 1, locked: true } }
      ]);
      expect(fixture.repository.require("op_unlock_local").records[1]).toMatchObject({ action: "unlock", outcome: "succeeded" });
      expect(hostDeckHostLockPolicySnapshot(fixture.lock)).toMatchObject({ transitions: 3, lock_changes: 2, lock_noops: 1 });

      const malformed = await app.inject({ method: "POST", url: "/api/v1/access/lock", payload: { operation_id: "op_malformed_request", confirmed: false } });
      expect(malformed.statusCode).toBe(400);
      expect(fixture.repository.get("op_malformed_request")).toBeNull();
      expect((await app.inject({ method: "HEAD", url: "/api/v1/access" })).statusCode).toBe(405);
      expect((await app.inject({ method: "GET", url: "/api/v1/access?extra=true" })).statusCode).toBe(400);
      expect((await app.inject({ method: "DELETE", url: "/api/v1/access/lock" })).statusCode).toBe(405);
    } finally {
      await app.close();
    }
  });

  it("composes the route with atomic SQLite settings and transitions one operation id once", async () => {
    const fixture = createFixture({ realSettings: true });
    await fixture.app.ready();
    try {
      const first = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        payload: request("op_sqlite_lock_once")
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(fixture.current()).toMatchObject({
        locked: true,
        updated_at: transitionAt
      });

      const duplicate = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        payload: request("op_sqlite_lock_once")
      });
      expect(duplicate.statusCode, duplicate.body).toBe(409);
      expect(duplicate.json()).toMatchObject({
        error: { code: "operation_conflict", retryable: false }
      });
      expect(hostDeckHostLockPolicySnapshot(fixture.lock)).toMatchObject({
        lock_changes: 1,
        transitions: 1
      });
      expect(() => requireHostDeckHostUnlocked(fixture.lock)).toThrowError(
        expect.objectContaining({ code: "host_locked", statusCode: 423 })
      );
    } finally {
      await fixture.app.close();
    }
  });

  it("requires paired-writer CSRF, denies read-only lock and every paired unlock, and exposes no credential material", async () => {
    const plaintext = createFixture({ paired: true });
    await plaintext.app.ready();
    try {
      const denied = await plaintext.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        headers: pairedHeaders(origin),
        payload: request("op_plaintext_pair_lock")
      });
      expect(denied.statusCode).toBe(426);
      expect(plaintext.repository.get("op_plaintext_pair_lock")).toBeNull();
      expect(plaintext.authenticationCalls()).toBe(0);
      expect(hostDeckHostLockPolicySnapshot(plaintext.lock).transitions).toBe(0);
    } finally {
      await plaintext.app.close();
    }

    const fixture = createFixture({ paired: true, secure: true });
    await fixture.app.ready();
    try {
      const headers = pairedHeaders(secureOrigin);
      const deniedCsrf = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        headers: { host: "localhost", origin: secureOrigin, cookie: headers.cookie },
        payload: request("op_missing_csrf")
      });
      expect(deniedCsrf.statusCode).toBe(403);
      expect(fixture.repository.get("op_missing_csrf")).toBeNull();

      const locked = await fixture.app.inject({ method: "POST", url: "/api/v1/access/lock", headers, payload: request("op_pair_lock") });
      expect(locked.statusCode, locked.body).toBe(200);
      expect(locked.json()).toMatchObject({
        authentication_state: "paired_device",
        device_id: "client_phone",
        permission: "write",
        locked: true,
        can_write_sessions: false,
        can_lock: true,
        can_unlock: false
      });
      for (const privateValue of [rawDeviceToken, rawCsrfToken, "token_hash", "csrf_token_hash", "csrf_generation", "settings_updated_at"]) {
        expect(locked.body).not.toContain(privateValue);
      }
      expect(fixture.repository.require("op_pair_lock").records[0]?.actor).toMatchObject({
        type: "dashboard", device_id: "client_phone", permission: "write", origin: secureOrigin
      });

      const pairedUnlock = await fixture.app.inject({ method: "POST", url: "/api/v1/access/unlock", headers, payload: request("op_pair_unlock") });
      expect(pairedUnlock.statusCode).toBe(403);
      expect(fixture.repository.get("op_pair_unlock")).toBeNull();
    } finally {
      await fixture.app.close();
    }

    const readOnly = createFixture({ paired: true, permission: "read", secure: true });
    await readOnly.app.ready();
    try {
      const denied = await readOnly.app.inject({ method: "POST", url: "/api/v1/access/lock", headers: pairedHeaders(secureOrigin), payload: request("op_read_lock") });
      expect(denied.statusCode).toBe(403);
      expect(readOnly.repository.get("op_read_lock")).toBeNull();
      expect(hostDeckHostLockPolicySnapshot(readOnly.lock).transitions).toBe(0);
    } finally {
      await readOnly.app.close();
    }
  });

  it("runs emergency lock on accepted-audit outage, returns fixed 503, and leaves unlock fail-closed", async () => {
    const fixture = createFixture({ failAudit: true });
    await fixture.app.ready();
    try {
      const response = await fixture.app.inject({ method: "POST", url: "/api/v1/access/lock", payload: request("op_emergency_lock") });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "audit_unavailable", retryable: false } });
      expect(response.body).toContain("Refresh access state");
      expect(fixture.current().locked).toBe(true);
      expect(hostDeckHostLockPolicySnapshot(fixture.lock)).toMatchObject({ transitions: 1, lock_changes: 1, audit_failures: 1 });

      const unlock = await fixture.app.inject({ method: "POST", url: "/api/v1/access/unlock", payload: request("op_failed_unlock") });
      expect(unlock.statusCode).toBe(503);
      expect(fixture.current().locked).toBe(true);
      expect(hostDeckHostLockPolicySnapshot(fixture.lock).transitions).toBe(1);
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps emergency lock output truthful when the deferred transition fails", async () => {
    const fixture = createFixture({ failAudit: true, failTransition: true });
    await fixture.app.ready();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        payload: request("op_emergency_failed_lock")
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "audit_unavailable", retryable: false }
      });
      expect(response.body).toContain("Refresh access state");
      expect(response.body).not.toContain("was locked");
      expect(fixture.current().locked).toBe(false);
    } finally {
      await fixture.app.close();
    }
  });

  it("suppresses success when terminal audit fails after a durable lock", async () => {
    const fixture = createFixture({ failTerminalAudit: true, realSettings: true });
    await fixture.app.ready();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        payload: request("op_terminal_audit_lock")
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "audit_unavailable", retryable: false }
      });
      expect(response.body).not.toContain('"locked":true');
      expect(fixture.current().locked).toBe(true);
      expect(fixture.repository.require("op_terminal_audit_lock")).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
    } finally {
      await fixture.app.close();
    }
  });

  it("preserves durable lock and terminal audit when response delivery fails", async () => {
    const fixture = createFixture({
      failOnSend: true,
      realSettings: true,
      secure: true
    });
    await fixture.app.ready();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        headers: { host: "localhost" },
        payload: request("op_lock_send_failure")
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('"locked":true');
      expect(response.body).not.toContain("private lock send failure");
      expect(fixture.current().locked).toBe(true);
      expect(fixture.repository.require("op_lock_send_failure")).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "succeeded" }
        ]
      });
    } finally {
      await fixture.app.close();
    }
  });

  it("validates route input before authentication and rejects duplicate policy registration", async () => {
    const fixture = createFixture({ paired: true, secure: true });
    await fixture.app.ready();
    try {
      const malformedLock = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        headers: pairedHeaders(secureOrigin),
        payload: { operation_id: "op_invalid_before_auth", confirmed: false }
      });
      expect(malformedLock.statusCode).toBe(400);
      expect(fixture.authenticationCalls()).toBe(0);

      const malformedRead = await fixture.app.inject({
        method: "GET",
        url: "/api/v1/access?extra=true",
        headers: {
          host: "localhost",
          origin: secureOrigin,
          cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`
        }
      });
      expect(malformedRead.statusCode).toBe(400);
      expect(fixture.authenticationCalls()).toBe(0);

      expect(() =>
        createHostDeckHostLockRouteRegistration({
          audit: fixture.audit,
          csrf: fixture.csrf,
          lock: fixture.lock
        })
      ).toThrow("already owns a route registration");
      expect(() =>
        fixture.registration.register(
          fixture.app,
          Object.freeze({ resourceBudget: defaultResourceBudget, surface: "api" })
        )
      ).toThrow("already registered");
    } finally {
      await fixture.app.close();
    }
  });

  it("projects invalid, expired, revoked, read, and write access states without authority leakage", async () => {
    const cases = [
      { authError: "device_not_found", state: "invalid_device" },
      { authError: "device_expired", state: "expired_device" },
      { authError: "device_revoked", state: "revoked_device" }
    ] as const;
    for (const item of cases) {
      const fixture = createFixture({ authError: item.authError, secure: true });
      await fixture.app.ready();
      try {
        const response = await fixture.app.inject({
          method: "GET",
          url: "/api/v1/access",
          headers: {
            host: "localhost",
            origin: secureOrigin,
            cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`
          }
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          authentication_state: item.state,
          device_id: null,
          permission: null,
          can_read_sessions: false,
          can_write_sessions: false,
          can_lock: false,
          can_unlock: false
        });
      } finally {
        await fixture.app.close();
      }
    }

    for (const permission of ["read", "write"] as const) {
      const fixture = createFixture({ paired: true, permission, secure: true });
      await fixture.app.ready();
      try {
        const response = await fixture.app.inject({
          method: "GET",
          url: "/api/v1/access",
          headers: {
            host: "localhost",
            origin: secureOrigin,
            cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`
          }
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          authentication_state: "paired_device",
          device_id: "client_phone",
          permission,
          can_read_sessions: true,
          can_write_sessions: permission === "write",
          can_lock: permission === "write",
          can_unlock: false
        });
      } finally {
        await fixture.app.close();
      }
    }
  });

  it("rejects unpaired and invalid credential lock attempts before CSRF, audit, or transition", async () => {
    const cases = [
      { authError: undefined, paired: false },
      { authError: "device_not_found", paired: false },
      { authError: "device_expired", paired: false },
      { authError: "device_revoked", paired: false }
    ] as const;
    for (const [index, item] of cases.entries()) {
      const fixture = createFixture({
        ...(item.authError === undefined ? {} : { authError: item.authError }),
        paired: item.paired,
        secure: true
      });
      await fixture.app.ready();
      try {
        const operationId = `op_denied_lock_state_${index}`;
        const response = await fixture.app.inject({
          method: "POST",
          url: "/api/v1/access/lock",
          headers:
            index === 0
              ? { host: "localhost", origin: secureOrigin }
              : pairedHeaders(secureOrigin),
          payload: request(operationId)
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: "permission_denied", retryable: false }
        });
        expect(fixture.repository.get(operationId)).toBeNull();
        expect(hostDeckHostLockPolicySnapshot(fixture.lock).transitions).toBe(0);
      } finally {
        await fixture.app.close();
      }
    }

    const crossOrigin = createFixture({ paired: true, secure: true });
    await crossOrigin.app.ready();
    try {
      const response = await crossOrigin.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        headers: {
          ...pairedHeaders(secureOrigin),
          origin: "https://foreign.example"
        },
        payload: request("op_cross_origin_lock")
      });
      expect(response.statusCode).toBe(403);
      expect(crossOrigin.authenticationCalls()).toBe(0);
      expect(crossOrigin.repository.get("op_cross_origin_lock")).toBeNull();
    } finally {
      await crossOrigin.app.close();
    }
  });

  it("rejects LAN plaintext at policy construction and before route settings on an HTTPS-only LAN policy", async () => {
    expect(() => createHostDeckRequestTrustPolicy({ allowedOrigins: ["http://hostdeck.test"], mode: "lan", transport: "http" })).toThrow("requires HTTPS");
    const fixture = createFixture({
      trust: createHostDeckRequestTrustPolicy({ allowedOrigins: ["https://hostdeck.test"], mode: "lan", transport: "https" })
    });
    await fixture.app.ready();
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/v1/access", headers: { host: "hostdeck.test" } });
      expect(response.statusCode).toBe(426);
      expect(hostDeckHostLockPolicySnapshot(fixture.lock).access_reads).toBe(0);
    } finally {
      await fixture.app.close();
    }
  });

  it("locks a paired writer over a real TLS listener with exact wire policy", async () => {
    const tls = await generateTestTlsMaterial();
    const port = await getAvailablePort();
    const requestOrigin = `https://localhost:${port}`;
    const fixture = createFixture({
      configuredOrigin: requestOrigin,
      paired: true,
      realSettings: true,
      tls
    });
    try {
      await fixture.app.listen({ host: "127.0.0.1", port });
      const response = await realTlsLockRequest(
        port,
        requestOrigin,
        request("op_real_tls_host_lock")
      );
      expect(response.status, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(JSON.parse(response.body)).toMatchObject({
        authentication_state: "paired_device",
        permission: "write",
        transport: "https",
        locked: true,
        can_write_sessions: false
      });
      expect(response.body).not.toContain(rawDeviceToken);
      expect(response.body).not.toContain(rawCsrfToken);
      expect(fixture.current().locked).toBe(true);
      assertSecretsAbsentFromSqlite(fixture.dbPath, [
        rawDeviceToken,
        rawCsrfToken
      ]);
    } finally {
      await fixture.app.close();
    }
  });
});

interface FixtureOptions {
  readonly authError?:
    | "device_expired"
    | "device_not_found"
    | "device_revoked";
  readonly configuredOrigin?: string;
  readonly failAudit?: boolean;
  readonly failOnSend?: boolean;
  readonly failTerminalAudit?: boolean;
  readonly failTransition?: boolean;
  readonly paired?: boolean;
  readonly permission?: "read" | "write";
  readonly realSettings?: boolean;
  readonly secure?: boolean;
  readonly tls?: {
    readonly certificate: string;
    readonly privateKey: string;
  };
  readonly trust?: ReturnType<typeof createHostDeckRequestTrustPolicy>;
}

function createFixture(options: FixtureOptions = {}) {
  let current = settings(false, createdAt);
  let authenticationCalls = 0;
  const open = fixtureDatabase();
  const settingsRepository = options.realSettings
    ? createSettingsRepository(open.db)
    : null;
  settingsRepository?.getOrCreateDefault({
    stateDir: `/tmp/hostdeck-lock-route-state-${process.pid}`,
    now: () => new Date(createdAt)
  });
  const settingsPort =
    settingsRepository === null
      ? {
          read: () => current,
          transition(input: { readonly locked: boolean; readonly now: Date }) {
            if (options.failTransition) {
              throw new Error("private transition failure");
            }
            const before = Object.freeze({
              locked: current.locked,
              settings_updated_at: current.updated_at
            });
            const changed = before.locked !== input.locked;
            if (changed) current = settings(input.locked, input.now.toISOString());
            const after = Object.freeze({
              locked: current.locked,
              settings_updated_at: current.updated_at
            });
            return Object.freeze({ before, after, changed });
          }
        }
      : {
          read: () => settingsRepository.require(),
          transition: (input: { readonly locked: boolean; readonly now: Date }) =>
            settingsRepository.transitionHostLock(input)
        };
  const lock = createHostDeckHostLockPolicy({ settings: settingsPort, now: () => new Date(transitionAt) });
  const repository = createSelectedAuditRepository(open.db);
  const auditPort: SelectedAuditRepository = options.failAudit
    ? {
        ...repository,
        recordAccepted() {
          throw new HostDeckSelectedAuditRepositoryError("audit_unavailable", "Audit unavailable.");
        }
      }
    : options.failTerminalAudit
      ? {
          ...repository,
          recordTerminal() {
            throw new HostDeckSelectedAuditRepositoryError(
              "audit_write_failed",
              "Terminal audit unavailable."
            );
          }
        }
      : repository;
  let auditIndex = 0;
  const audit = createSecurityMutationAuditExecutor({
    repository: auditPort,
    now: () => new Date(Date.parse(transitionAt) + ++auditIndex * 1_000).toISOString(),
    create_record_id: () => `audit:host-lock:${auditIndex}`
  });
  const permission = options.permission ?? "write";
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: () => frozenAuthentication(permission, csrfAt),
      rotateBootstrap: () => {
        throw new Error("not used");
      }
    },
    now: () => new Date(csrfAt)
  });
  const registration = createHostDeckHostLockRouteRegistration({ audit, csrf, lock });
  const requestAuthenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: ({ rawDeviceToken: candidate }) => {
      authenticationCalls += 1;
      if (options.authError !== undefined) {
        throw new HostDeckAuthRepositoryError(
          options.authError,
          "Device unavailable."
        );
      }
      if (options.paired && candidate === rawDeviceToken) {
        return frozenAuthentication(permission, authenticatedAt);
      }
      throw new HostDeckAuthRepositoryError("device_not_found", "Device unavailable.");
    },
    now: () => new Date(authenticatedAt)
  });
  const secure = options.secure || options.tls !== undefined;
  const configuredOrigin =
    options.configuredOrigin ?? (secure ? secureOrigin : origin);
  const requestTrustPolicy =
    options.trust ??
    createHostDeckRequestTrustPolicy({
      allowedOrigins: [configuredOrigin],
      mode: "loopback",
      transport: secure ? "https" : "http"
    });
  let app: HostDeckFastifyInstance;
  if (secure) {
    app = Fastify({
      logger: false,
      ...(options.tls === undefined
        ? {}
        : {
            https: {
              cert: options.tls.certificate,
              key: options.tls.privateKey
            }
          })
    }).withTypeProvider() as HostDeckFastifyInstance;
    installHostDeckZodCompilers(app);
    installHostDeckErrorPolicy(app, () => undefined);
    if (options.tls === undefined) {
      app.addHook("onRequest", async (request) => {
        Object.defineProperty(request.raw.socket, "encrypted", {
          configurable: true,
          value: true
        });
      });
    }
    installHostDeckRequestTrustGate(app, requestTrustPolicy, () => undefined);
    installHostDeckRequestAuthentication(app, requestAuthenticationPolicy);
    if (options.failOnSend) {
      app.addHook("onSend", async (request, reply, payload) => {
        if (
          request.url === "/api/v1/access/lock" &&
          reply.statusCode >= 200 &&
          reply.statusCode < 300
        ) {
          throw new Error("private lock send failure");
        }
        return payload;
      });
    }
    registration.register(
      app,
      Object.freeze({ resourceBudget: defaultResourceBudget, surface: "api" })
    );
  } else {
    app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy,
      requestTrustPolicy,
      resourceBudget: defaultResourceBudget,
      routePlugins: [registration]
    });
  }
  return {
    app,
    audit,
    authenticationCalls: () => authenticationCalls,
    csrf,
    current: () => settingsRepository?.require() ?? current,
    dbPath: open.path,
    lock,
    registration,
    repository
  };
}

function fixtureDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-lock-route-"));
  dirs.push(dir);
  const path = join(dir, "hostdeck.db");
  const open = openMigratedDatabase(path, { now: () => new Date(createdAt) });
  databases.push(open.db);
  return { ...open, path };
}

function settings(locked: boolean, updatedAt: string) {
  return {
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/home/hostdeck/state",
    bind_mode: "localhost" as const,
    bind_host: "127.0.0.1",
    bind_port: 3210,
    lan_enabled: false,
    locked,
    retention: { ...defaultRetentionPolicy },
    updated_at: updatedAt
  };
}

function frozenAuthentication(permission: "read" | "write", lastUsedAt: string) {
  return Object.freeze({
    trusted: true as const,
    readOnly: permission === "read",
    device: Object.freeze({
      id: "client_phone",
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: createdAt,
      client_label: "Phone",
      permission,
      created_at: createdAt,
      last_used_at: lastUsedAt,
      expires_at: null,
      revoked_at: null
    })
  });
}

function pairedHeaders(requestOrigin: string) {
  return {
    host: "localhost",
    origin: requestOrigin,
    cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
    "x-hostdeck-csrf": rawCsrfToken,
    "x-hostdeck-csrf-generation": "1"
  };
}

function request(operationId: string) {
  return { operation_id: operationId, confirmed: true };
}

function assertSecretsAbsentFromSqlite(
  dbPath: string,
  secrets: readonly string[]
): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const secret of secrets) {
      expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
    }
  }
}

async function generateTestTlsMaterial(): Promise<{
  readonly certificate: string;
  readonly privateKey: string;
}> {
  const algorithm = {
    hash: "SHA-256",
    modulusLength: 2_048,
    name: "RSASSA-PKCS1-v1_5",
    publicExponent: new Uint8Array([1, 0, 1])
  } as const;
  const keys = await globalThis.crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify"
  ]);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(
        KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment,
        true
      ),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension([{ type: "dns", value: "localhost" }])
    ],
    keys,
    name: "CN=HostDeck Lock Test",
    notAfter: new Date(Date.parse(createdAt) + 86_400_000),
    notBefore: new Date(Date.parse(createdAt) - 86_400_000),
    serialNumber: "1234567890abcdef",
    signingAlgorithm: { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" }
  });
  const der = Buffer.from(
    await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey)
  );
  const body = der.toString("base64").match(/.{1,64}/gu)?.join("\n");
  if (body === undefined) throw new TypeError("Test TLS private key did not encode.");
  return Object.freeze({
    certificate: certificate.toString("pem"),
    privateKey: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
  });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new TypeError("Unable to reserve host-lock TLS port."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function realTlsLockRequest(
  port: number,
  requestOrigin: string,
  payload: Readonly<Record<string, unknown>>
): Promise<{
  readonly body: string;
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly status: number;
}> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const clientRequest = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/access/lock",
        rejectUnauthorized: false,
        servername: "localhost",
        headers: {
          host: `localhost:${port}`,
          origin: requestOrigin,
          cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
          "x-hostdeck-csrf": rawCsrfToken,
          "x-hostdeck-csrf-generation": "1",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body, "utf8"),
          connection: "close"
        }
      },
      (response) => {
        let output = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          output += chunk;
          if (output.length > 65_536) {
            clientRequest.destroy(
              new Error("TLS host-lock response exceeded its bound.")
            );
          }
        });
        response.once("end", () => {
          resolve({
            body: output,
            headers: response.headers,
            status: response.statusCode ?? 0
          });
        });
      }
    );
    clientRequest.setTimeout(5_000, () => {
      clientRequest.destroy(new Error("TLS host-lock request timed out."));
    });
    clientRequest.once("error", reject);
    clientRequest.end(body);
  });
}
