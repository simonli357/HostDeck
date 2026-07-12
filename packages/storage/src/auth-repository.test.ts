import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthRepositoryErrorCode,
  createAuthDeviceRepository,
  createLegacyPairingCodeRepository,
  HostDeckAuthRepositoryError
} from "./auth-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";

const tempDirs: string[] = [];
const rawCode = "123456";
const rawDeviceToken = "device_token_for_phone_writes_123456";
const rawCsrfToken = "csrf_token_for_phone_writes_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("auth devices and pairing-code repositories", () => {
  it("claims one-time pairing codes and stores only secret hashes", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const pairingCodes = createLegacyPairingCodeRepository(open.db);
      const devices = createAuthDeviceRepository(open.db);
      const pairing = pairingCodes.createLegacy({
        id: "pair_phone",
        rawCode,
        permission: "write",
        clientLabel: "phone",
        createdAt: fixedNow(),
        expiresAt: laterNow()
      });

      expect(pairing.code_hash).not.toBe(rawCode);
      expect(pairingRow(open.db, "pair_phone")).toMatchObject({
        id: "pair_phone",
        code_hash: pairing.code_hash,
        used_at: null,
        revoked_at: null
      });

      const claim = pairingCodes.claimLegacy({
        rawCode,
        deviceId: "client_phone",
        rawDeviceToken,
        rawCsrfToken,
        now: fixedNow()
      });

      expect(claim.pairingCode.used_at).toBe("2026-07-08T22:00:00.000Z");
      expect(claim.device).toMatchObject({
        id: "client_phone",
        csrf_generation: 1,
        csrf_rotated_at: "2026-07-08T22:00:00.000Z",
        client_label: "phone",
        permission: "write",
        revoked_at: null
      });

      const storedPairing = pairingRow(open.db, "pair_phone");
      expect(JSON.stringify(storedPairing)).not.toContain(rawCode);
      expect(storedPairing.used_at).toBe("2026-07-08T22:00:00.000Z");

      const storedDevice = authDeviceRow(open.db, "client_phone");
      expect(JSON.stringify(storedDevice)).not.toContain(rawDeviceToken);
      expect(JSON.stringify(storedDevice)).not.toContain(rawCsrfToken);
      expect(storedDevice.token_hash).toBe(claim.device.token_hash);
      expect(storedDevice.csrf_token_hash).toBe(claim.device.csrf_token_hash);
      expect(storedDevice.csrf_generation).toBe(1);
      expect(storedDevice.csrf_rotated_at).toBe("2026-07-08T22:00:00.000Z");

      expect(devices.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken, now: laterNow() }).last_used_at).toBe(
        "2026-07-08T22:05:00.000Z"
      );
    } finally {
      open.db.close();
    }
  });

  it("rejects revoked, expired, and already-used pairing codes", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const pairingCodes = createLegacyPairingCodeRepository(open.db);
      pairingCodes.createLegacy({
        id: "pair_revoked",
        rawCode: "246810",
        permission: "write",
        createdAt: fixedNow(),
        expiresAt: laterNow()
      });
      expect(pairingCodes.revokeLegacy("pair_revoked", { now: laterNow() }).revoked_at).toBe(
        "2026-07-08T22:05:00.000Z"
      );

      expectAuthError(
        () =>
          pairingCodes.claimLegacy({
            rawCode: "246810",
            deviceId: "client_revoked_pair",
            rawDeviceToken,
            rawCsrfToken,
            now: fixedNow()
          }),
        "pairing_code_revoked"
      );

      pairingCodes.createLegacy({
        id: "pair_expired",
        rawCode: "654321",
        permission: "write",
        createdAt: fixedNow(),
        expiresAt: fixedNow()
      });

      expectAuthError(
        () =>
          pairingCodes.claimLegacy({
            rawCode: "654321",
            deviceId: "client_expired",
            rawDeviceToken,
            rawCsrfToken,
            now: laterNow()
          }),
        "pairing_code_expired"
      );

      pairingCodes.createLegacy({
        id: "pair_once",
        rawCode,
        permission: "write",
        createdAt: fixedNow(),
        expiresAt: laterNow()
      });
      pairingCodes.claimLegacy({
        rawCode,
        deviceId: "client_phone",
        rawDeviceToken,
        rawCsrfToken,
        now: fixedNow()
      });

      expectAuthError(
        () =>
          pairingCodes.claimLegacy({
            rawCode,
            deviceId: "client_other",
            rawDeviceToken: "device_token_for_other_client_123456",
            rawCsrfToken: "csrf_token_for_other_client_123456",
            now: fixedNow()
          }),
        "pairing_code_used"
      );
    } finally {
      open.db.close();
    }
  });

  it("distinguishes read-only authentication from writable browser authorization", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const devices = createAuthDeviceRepository(open.db);
      devices.create({
        id: "client_read",
        rawDeviceToken: "device_token_for_read_only_client_123",
        rawCsrfToken: "csrf_token_for_read_only_client_123",
        permission: "read",
        clientLabel: "read-phone",
        createdAt: fixedNow()
      });
      devices.create({
        id: "client_write",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        clientLabel: "write-phone",
        createdAt: fixedNow()
      });

      expect(
        devices.authenticateDeviceToken({
          rawDeviceToken: "device_token_for_read_only_client_123",
          now: laterNow()
        }).readOnly
      ).toBe(true);

      expectAuthError(
        () =>
          devices.authorizeBrowserWrite({
            rawDeviceToken: "device_token_for_read_only_client_123",
            rawCsrfToken: "csrf_token_for_read_only_client_123",
            now: laterNow()
          }),
        "read_only"
      );

      expectAuthError(
        () =>
          devices.authorizeBrowserWrite({
            rawDeviceToken,
            rawCsrfToken: "wrong_csrf_token_for_phone_writes_123",
            now: laterNow()
          }),
        "csrf_mismatch"
      );

      expect(devices.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken, now: laterNow() }).permission).toBe("write");
    } finally {
      open.db.close();
    }
  });

  it("rejects revoked and expired device tokens", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const devices = createAuthDeviceRepository(open.db);
      devices.create({
        id: "client_expired",
        rawDeviceToken: "device_token_expired_client_123456",
        rawCsrfToken: "csrf_token_expired_client_123456",
        permission: "write",
        clientLabel: "expired-phone",
        createdAt: fixedNow(),
        expiresAt: fixedNow()
      });
      devices.create({
        id: "client_revoked",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        clientLabel: "revoked-phone",
        createdAt: fixedNow()
      });
      devices.revoke("client_revoked", { now: laterNow() });

      expectAuthError(
        () =>
          devices.authorizeBrowserWrite({
            rawDeviceToken: "device_token_expired_client_123456",
            rawCsrfToken: "csrf_token_expired_client_123456",
            now: laterNow()
          }),
        "device_expired"
      );

      expectAuthError(() => devices.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken, now: laterNow() }), "device_revoked");
    } finally {
      open.db.close();
    }
  });

  it("reloads durable auth state after database reopen", () => {
    const path = tempDbPath();
    const firstOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      createAuthDeviceRepository(firstOpen.db).create({
        id: "client_phone",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        clientLabel: "phone",
        createdAt: fixedNow()
      });
    } finally {
      firstOpen.db.close();
    }

    const secondOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      expect(createAuthDeviceRepository(secondOpen.db).authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken, now: laterNow() }).id).toBe(
        "client_phone"
      );
    } finally {
      secondOpen.db.close();
    }
  });

  it("blocks invalid persisted auth rows on read", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      open.db
        .prepare(
          `
            INSERT INTO auth_devices (
              id,
              token_hash,
              csrf_token_hash,
              csrf_generation,
              csrf_rotated_at,
              client_label,
              permission,
              created_at,
              last_used_at,
              expires_at,
              revoked_at
            ) VALUES (
              'client_bad',
              'raw-token',
              'raw-csrf',
              1,
              '2026-07-08T22:00:00.000Z',
              'bad',
              'write',
              '2026-07-08T22:00:00.000Z',
              NULL,
              NULL,
              NULL
            )
          `
        )
        .run();

      expectAuthError(() => createAuthDeviceRepository(open.db).require("client_bad"), "invalid_auth_device");
    } finally {
      open.db.close();
    }
  });
});

function authDeviceRow(db: { prepare: (sql: string) => { get: (id: string) => unknown } }, id: string) {
  return db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(id) as Record<string, unknown>;
}

function pairingRow(db: { prepare: (sql: string) => { get: (id: string) => unknown } }, id: string) {
  return db.prepare("SELECT * FROM pairing_codes WHERE id = ?").get(id) as Record<string, unknown>;
}

function expectAuthError(fn: () => unknown, code: AuthRepositoryErrorCode): void {
  expect(fn).toThrow(HostDeckAuthRepositoryError);

  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckAuthRepositoryError);
    expect((error as HostDeckAuthRepositoryError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckAuthRepositoryError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-auth-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
