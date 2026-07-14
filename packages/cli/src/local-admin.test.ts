import { chmodSync, linkSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuditEventRepository,
  createLegacyPairingCodeRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalAdmin } from "./local-admin.js";

const tempDirs: string[] = [];
const fixedNow = new Date("2026-07-09T08:00:00.000Z");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("CLI local admin commands", () => {
  it("creates one-time pairing codes without durable token exposure", () => {
    const harness = createHarness({ pairingCode: "654321" });

    const result = harness.admin.createPairingCode({
      permission: "write",
      ttlMinutes: 10,
      label: "phone"
    });

    expect(result).toMatchObject({
      pairing_id: "pair_001",
      code: "654321",
      permission: "write",
      client_label: "phone",
      created_at: "2026-07-09T08:00:00.000Z",
      expires_at: "2026-07-09T08:10:00.000Z",
      audit_event_id: "audit_001"
    });

    const opened = openMigratedDatabase(harness.databasePath);
    try {
      const pairing = createLegacyPairingCodeRepository(opened.db).require(result.pairing_id);
      expect(pairing.code_hash).not.toBe(result.code);
      expect(pairing.code_hash).toMatch(/^sha256:/u);
      expect(opened.db.prepare("SELECT id, token_hash FROM auth_devices").all()).toHaveLength(0);
      expect(createLegacyPairingCodeRepository(opened.db).claimLegacy({
        rawCode: result.code,
        deviceId: "client_phone",
        rawDeviceToken: "device_token_from_claim_test_123456",
        rawCsrfToken: "csrf_token_from_claim_test_123456",
        clientLabel: "phone",
        now: fixedNow
      }).device.client_label).toBe("phone");

      const pairingRows = opened.db.prepare("SELECT id, code_hash FROM pairing_codes").all() as Array<{ readonly id: string; readonly code_hash: string }>;
      const authDeviceRows = opened.db.prepare("SELECT id, token_hash FROM auth_devices").all() as Array<{ readonly id: string; readonly token_hash: string }>;
      const auditEvent = createAuditEventRepository(opened.db).require(result.audit_event_id);

      expect(pairingRows).toEqual([{ id: result.pairing_id, code_hash: pairing.code_hash }]);
      expect(authDeviceRows).toHaveLength(1);
      expect(authDeviceRows[0]?.token_hash).not.toContain(result.code);
      expect(auditEvent).toMatchObject({
        actor: {
          type: "cli",
          client_id: "local_admin",
          permission: "write"
        },
        action: "pair",
        session_id: null,
        result: "succeeded",
        error_code: null
      });
      expect(JSON.stringify(auditEvent.payload_summary)).not.toContain(result.code);
      expect(JSON.stringify(auditEvent.payload_summary)).not.toContain("device_token_from_claim_test_123456");
    } finally {
      opened.db.close();
    }
  });

  it("persists lock and unlock changes with CLI audit events", () => {
    const harness = createHarness();

    expect(harness.admin.setLock({ locked: true, reason: "local maintenance" })).toMatchObject({
      locked: true,
      updated_at: "2026-07-09T08:00:00.000Z",
      audit_event_id: "audit_001"
    });
    expect(harness.admin.setLock({ locked: false })).toMatchObject({
      locked: false,
      updated_at: "2026-07-09T08:00:00.000Z",
      audit_event_id: "audit_002"
    });

    const opened = openMigratedDatabase(harness.databasePath);
    try {
      expect(createSettingsRepository(opened.db).require().locked).toBe(false);
      expect(createAuditEventRepository(opened.db).list().map((event) => event.action)).toEqual(["unlock", "lock"]);
    } finally {
      opened.db.close();
    }
  });

  it("repairs owner mode drift and rejects a hard-linked database before admin writes", () => {
    const harness = createHarness();
    harness.admin.setLock({ locked: true });
    chmodSync(harness.databasePath, 0o644);

    harness.admin.setLock({ locked: false });
    expect(lstatSync(harness.databasePath).mode & 0o7777).toBe(0o600);

    linkSync(harness.databasePath, join(harness.stateDir, "hostdeck-copy.sqlite"));
    expect(() => harness.admin.setLock({ locked: true })).toThrow(/not secure/u);
  });
});

function createHarness(input: { readonly pairingCode?: string } = {}): {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly admin: ReturnType<typeof createLocalAdmin>;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "hostdeck-cli-admin-"));
  const databasePath = join(stateDir, "hostdeck.sqlite");
  let pairCount = 0;
  let auditCount = 0;

  tempDirs.push(stateDir);

  return {
    stateDir,
    databasePath,
    admin: createLocalAdmin({
      stateDir,
      databasePath,
      now: () => fixedNow,
      makePairingCode: () => input.pairingCode ?? "135790",
      makePairingId: () => {
        pairCount += 1;
        return `pair_${String(pairCount).padStart(3, "0")}`;
      },
      makeAuditEventId: () => {
        auditCount += 1;
        return `audit_${String(auditCount).padStart(3, "0")}`;
      }
    })
  };
}
