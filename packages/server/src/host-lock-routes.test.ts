import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget, defaultRetentionPolicy } from "@hostdeck/contracts";
import {
  createSelectedAuditRepository,
  HostDeckAuthRepositoryError,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import { createHostDeckFastifyApp } from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
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
const rawDeviceToken = "D".repeat(43);
const rawCsrfToken = "C".repeat(43);
const createdAt = "2026-07-12T12:00:00.000Z";
const authenticatedAt = "2026-07-12T12:01:00.000Z";
const csrfAt = "2026-07-12T12:02:00.000Z";
const transitionAt = "2026-07-12T12:03:00.000Z";

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

  it("requires paired-writer CSRF, denies read-only lock and every paired unlock, and exposes no credential material", async () => {
    const fixture = createFixture({ paired: true });
    await fixture.app.ready();
    try {
      const headers = pairedHeaders();
      const deniedCsrf = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/access/lock",
        headers: { origin, cookie: headers.cookie },
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
        type: "dashboard", device_id: "client_phone", permission: "write", origin
      });

      const pairedUnlock = await fixture.app.inject({ method: "POST", url: "/api/v1/access/unlock", headers, payload: request("op_pair_unlock") });
      expect(pairedUnlock.statusCode).toBe(403);
      expect(fixture.repository.get("op_pair_unlock")).toBeNull();
    } finally {
      await fixture.app.close();
    }

    const readOnly = createFixture({ paired: true, permission: "read" });
    await readOnly.app.ready();
    try {
      const denied = await readOnly.app.inject({ method: "POST", url: "/api/v1/access/lock", headers: pairedHeaders(), payload: request("op_read_lock") });
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
});

interface FixtureOptions {
  readonly failAudit?: boolean;
  readonly paired?: boolean;
  readonly permission?: "read" | "write";
  readonly trust?: ReturnType<typeof createHostDeckRequestTrustPolicy>;
}

function createFixture(options: FixtureOptions = {}) {
  let current = settings(false, createdAt);
  const settingsPort = {
    read: () => current,
    transition(input: { readonly locked: boolean; readonly now: Date }) {
      const before = Object.freeze({ locked: current.locked, settings_updated_at: current.updated_at });
      const changed = before.locked !== input.locked;
      if (changed) current = settings(input.locked, input.now.toISOString());
      const after = Object.freeze({ locked: current.locked, settings_updated_at: current.updated_at });
      return Object.freeze({ before, after, changed });
    }
  };
  const lock = createHostDeckHostLockPolicy({ settings: settingsPort, now: () => new Date(transitionAt) });
  const repository = auditRepository();
  const auditPort: SelectedAuditRepository = options.failAudit
    ? {
        ...repository,
        recordAccepted() {
          throw new HostDeckSelectedAuditRepositoryError("audit_unavailable", "Audit unavailable.");
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
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: ({ rawDeviceToken: candidate }) => {
        if (options.paired && candidate === rawDeviceToken) return frozenAuthentication(permission, authenticatedAt);
        throw new HostDeckAuthRepositoryError("device_not_found", "Device unavailable.");
      },
      now: () => new Date(authenticatedAt)
    }),
    requestTrustPolicy: options.trust ?? createHostDeckRequestTrustPolicy({ allowedOrigins: [origin], mode: "loopback", transport: "http" }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  return { app, current: () => current, lock, repository };
}

function auditRepository() {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-lock-route-"));
  dirs.push(dir);
  const open = openMigratedDatabase(join(dir, "hostdeck.db"), { now: () => new Date(createdAt) });
  databases.push(open.db);
  return createSelectedAuditRepository(open.db);
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

function pairedHeaders() {
  return {
    origin,
    cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
    "x-hostdeck-csrf": rawCsrfToken,
    "x-hostdeck-csrf-generation": "1"
  };
}

function request(operationId: string) {
  return { operation_id: operationId, confirmed: true };
}
