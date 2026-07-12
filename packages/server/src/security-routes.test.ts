import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthDeviceRepository, createPairingCodeRepository, createSettingsRepository, openMigratedDatabase } from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createSecurityRouteHandlers } from "./index.js";

const tempDirs: string[] = [];
const rawCode = "135790";
const rawDeviceToken = "device_token_for_route_phone_123456";
const rawCsrfToken = "csrf_token_for_route_phone_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("security and pairing route handlers", () => {
  it("claims a pairing code with an HttpOnly cookie token and CSRF response", () => {
    const harness = createHarness();

    try {
      harness.pairingCodes.create({
        id: "pair_phone",
        rawCode,
        permission: "write",
        clientLabel: "bootstrap-phone",
        createdAt: fixedNow(),
        expiresAt: laterNow()
      });

      const result = harness.handlers.claimPairingCode({
        body: {
          code: rawCode,
          client_label: "phone"
        }
      });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        trusted: true,
        read_only: false,
        locked: false,
        lan_enabled: false,
        client_id: "client_route_phone",
        auth_transport: "http_only_cookie",
        csrf_token: rawCsrfToken
      });
      expect(result.cookies).toEqual([
        {
          name: "hostdeck_device",
          value: rawDeviceToken,
          httpOnly: true,
          sameSite: "lax",
          secure: false,
          path: "/",
          expiresAt: null
        }
      ]);
      expect(JSON.stringify(result.body)).not.toContain(rawDeviceToken);
      expect(harness.authDevices.require("client_route_phone").client_label).toBe("phone");
    } finally {
      harness.close();
    }
  });

  it("rejects malformed, invalid, revoked, expired, and used pairing claims", () => {
    const harness = createHarness({ now: laterNow });

    try {
      harness.pairingCodes.create({
        id: "pair_revoked",
        rawCode: "246810",
        permission: "write",
        createdAt: fixedNow(),
        expiresAt: laterNow()
      });
      harness.pairingCodes.revoke("pair_revoked", { now: laterNow() });
      harness.pairingCodes.create({
        id: "pair_expired",
        rawCode,
        permission: "write",
        createdAt: fixedNow(),
        expiresAt: fixedNow()
      });
      expect(harness.handlers.claimPairingCode({ body: { code: "123" } })).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "validation_error"
          }
        }
      });
      expect(harness.handlers.claimPairingCode({ body: { code: "000000" } })).toMatchObject({
        status: 401,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
      expect(harness.handlers.claimPairingCode({ body: { code: "246810" } })).toMatchObject({
        status: 401,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
      expect(harness.handlers.claimPairingCode({ body: { code: rawCode } })).toMatchObject({
        status: 401,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
    } finally {
      harness.close();
    }

    const usedHarness = createHarness();
    try {
      usedHarness.pairingCodes.create({
        id: "pair_used",
        rawCode,
        permission: "write",
        createdAt: fixedNow(),
        expiresAt: laterNow()
      });
      expect(usedHarness.handlers.claimPairingCode({ body: { code: rawCode } }).status).toBe(200);
      expect(usedHarness.handlers.claimPairingCode({ body: { code: rawCode } })).toMatchObject({
        status: 401,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
    } finally {
      usedHarness.close();
    }
  });

  it("exposes trusted, read-only, locked, and LAN state without granting ambient writes", () => {
    const harness = createHarness();

    try {
      harness.settings.setLanEnabled(true, { bindHost: "0.0.0.0", now: laterNow });
      harness.authDevices.create({
        id: "client_read",
        rawDeviceToken: "device_token_for_read_route_123456",
        rawCsrfToken: "csrf_token_for_read_route_123456",
        permission: "read",
        createdAt: fixedNow()
      });
      harness.authDevices.create({
        id: "client_write",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });

      expect(harness.handlers.pairStatus({ rawDeviceToken: "device_token_for_read_route_123456" }).body).toMatchObject({
        trusted: true,
        read_only: true,
        lan_enabled: true,
        csrf_token: null
      });
      expect(harness.handlers.securityState({ rawDeviceToken }).body).toMatchObject({
        trusted: false,
        auth_transport: "none",
        csrf_token: null
      });
      expect(harness.handlers.securityState({ rawDeviceToken, rawCsrfToken }).body).toMatchObject({
        trusted: true,
        read_only: false,
        csrf_token: rawCsrfToken
      });

      harness.settings.setLocked(true, { now: laterNow });
      expect(harness.handlers.securityState({ rawDeviceToken }).body).toMatchObject({
        trusted: true,
        locked: true,
        csrf_token: null
      });
    } finally {
      harness.close();
    }
  });

  it("locks from a trusted dashboard write and rejects missing or mismatched CSRF", () => {
    const harness = createHarness();

    try {
      harness.authDevices.create({
        id: "client_write",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });

      expect(harness.handlers.lockFromDashboard({ body: { lock: true }, rawDeviceToken })).toMatchObject({
        status: 401,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
      expect(
        harness.handlers.lockFromDashboard({
          body: { lock: true },
          rawDeviceToken,
          rawCsrfToken: "wrong_csrf_token_for_route_123456"
        })
      ).toMatchObject({
        status: 403,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
      expect(harness.settings.require().locked).toBe(false);

      expect(harness.handlers.lockFromDashboard({ body: { lock: true }, rawDeviceToken, rawCsrfToken })).toMatchObject({
        status: 200,
        body: {
          trusted: true,
          locked: true,
          csrf_token: null
        }
      });
      expect(harness.settings.require().locked).toBe(true);
    } finally {
      harness.close();
    }
  });

  it("classifies monotonic authentication conflicts and storage failures without locking", () => {
    const conflictHarness = createHarness();
    try {
      conflictHarness.authDevices.create({
        id: "client_write",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });
      conflictHarness.authDevices.authenticateDeviceToken({ rawDeviceToken, now: laterNow() });

      expect(
        conflictHarness.handlers.lockFromDashboard({ body: { lock: true }, rawDeviceToken, rawCsrfToken })
      ).toMatchObject({
        status: 409,
        body: { error: { code: "operation_conflict" } }
      });
      expect(conflictHarness.settings.require().locked).toBe(false);
    } finally {
      conflictHarness.close();
    }

    const failureHarness = createHarness({ now: laterNow });
    try {
      failureHarness.authDevices.create({
        id: "client_write",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });
      failureHarness.db.exec(`
        CREATE TRIGGER fail_route_auth_touch
        BEFORE UPDATE OF last_used_at ON auth_devices
        BEGIN
          SELECT RAISE(ABORT, 'forced route auth failure');
        END;
      `);

      const failed = failureHarness.handlers.lockFromDashboard({ body: { lock: true }, rawDeviceToken, rawCsrfToken });
      expect(failed).toMatchObject({
        status: 500,
        body: { error: { code: "storage_error", message: "Auth device authentication failed." } }
      });
      expect(JSON.stringify(failed)).not.toMatch(/forced route auth|device_token|csrf_token/iu);
      expect(failureHarness.settings.require().locked).toBe(false);
    } finally {
      failureHarness.close();
    }
  });

  it("rejects dashboard unlock and LAN mutation while exposing network state", () => {
    const harness = createHarness();

    try {
      expect(harness.handlers.unlockFromDashboard()).toMatchObject({
        status: 403,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
      expect(harness.handlers.mutateLanFromDashboard()).toMatchObject({
        status: 403,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
      expect(harness.handlers.networkState().body).toEqual({
        mode: "localhost",
        host: "127.0.0.1",
        port: 3777,
        lan_enabled: false
      });

      harness.settings.setLanEnabled(true, { bindHost: "0.0.0.0", now: laterNow });
      expect(harness.handlers.networkState().body).toEqual({
        mode: "lan",
        host: "0.0.0.0",
        port: 3777,
        lan_enabled: true
      });
    } finally {
      harness.close();
    }
  });
});

function createHarness(input: { readonly now?: () => Date } = {}) {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  const settings = createSettingsRepository(open.db);
  settings.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
  const authDevices = createAuthDeviceRepository(open.db);
  const pairingCodes = createPairingCodeRepository(open.db);
  const handlers = createSecurityRouteHandlers({
    authDevices,
    pairingCodes,
    settings,
    now: input.now ?? fixedNow,
    createDeviceId: () => "client_route_phone",
    createDeviceToken: () => rawDeviceToken,
    createCsrfToken: () => rawCsrfToken
  });

  return {
    authDevices,
    db: open.db,
    pairingCodes,
    settings,
    handlers,
    close: () => open.db.close()
  };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-server-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-server-state-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
