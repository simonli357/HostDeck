import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRetentionPolicy } from "@hostdeck/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditRepositoryErrorCode, createAuditEventRepository, HostDeckAuditRepositoryError } from "./audit-repository.js";
import {
  type AuthRepositoryErrorCode,
  createAuthDeviceRepository,
  createPairingCodeRepository,
  HostDeckAuthRepositoryError
} from "./auth-repository.js";
import { HostDeckMigrationError, type MigrationErrorCode, openMigratedDatabase, runMigrations } from "./migration-runner.js";
import {
  defaultMigrations,
  hostDeckAuthDeviceCsrfHashMigration,
  hostDeckBaseSchemaMigration,
  hostDeckSessionMetadataFailedStatusMigration,
  type StorageMigration
} from "./migrations.js";
import { createRetentionRepository } from "./retention-repository.js";
import { createSessionRepository } from "./session-repository.js";

const tempDirs: string[] = [];
const sessionId = "sess_hardening_01";
const rawCode = "654321";
const rawDeviceToken = "device_token_for_hardening_writes_123456";
const rawCsrfToken = "csrf_token_for_hardening_writes_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("storage hardening", () => {
  it("fails loudly for migration checksum drift and sequence gaps", () => {
    const firstMigration = {
      version: "202607080001_first",
      sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);"
    } satisfies StorageMigration;
    const secondMigration = {
      version: "202607080002_second",
      sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY);"
    } satisfies StorageMigration;

    const checksumDb = new Database(tempDbPath());
    try {
      runMigrations(checksumDb, { migrations: [firstMigration], now: fixedNow });

      expectMigrationError(
        () =>
          runMigrations(checksumDb, {
            migrations: [
              {
                ...firstMigration,
                sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY, label TEXT);"
              }
            ],
            now: fixedNow
          }),
        "migration_checksum_mismatch"
      );
    } finally {
      checksumDb.close();
    }

    const sequenceDb = new Database(tempDbPath());
    try {
      runMigrations(sequenceDb, { migrations: [firstMigration, secondMigration], now: fixedNow });
      sequenceDb.prepare("DELETE FROM schema_migrations WHERE version = ?").run(firstMigration.version);

      expectMigrationError(
        () => runMigrations(sequenceDb, { migrations: [firstMigration, secondMigration], now: fixedNow }),
        "migration_sequence_gap"
      );
    } finally {
      sequenceDb.close();
    }
  });

  it("rejects pre-hardening audit boundaries that contain output cursor state", () => {
    const db = new Database(tempDbPath());
    const preHardeningMigrations = [
      hostDeckBaseSchemaMigration,
      hostDeckSessionMetadataFailedStatusMigration,
      hostDeckAuthDeviceCsrfHashMigration
    ] satisfies readonly StorageMigration[];

    try {
      runMigrations(db, { migrations: preHardeningMigrations, now: fixedNow });
      db.prepare(
        `
          INSERT INTO retention_boundaries (
            id,
            scope,
            session_id,
            reason,
            truncated_before_cursor,
            truncated_before_at,
            retained_record_count,
            applied_at
          ) VALUES (
            'retention_audit_bad_cursor',
            'audit',
            NULL,
            'event_limit',
            10,
            NULL,
            5,
            '2026-07-08T22:00:00.000Z'
          )
        `
      ).run();

      expectMigrationError(() => runMigrations(db, { migrations: defaultMigrations, now: fixedNow }), "failed_migration");
    } finally {
      db.close();
    }
  });

  it("rejects malformed raw auth secrets before durable rows or auth decisions", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const pairingCodes = createPairingCodeRepository(open.db);
      const devices = createAuthDeviceRepository(open.db);

      expectAuthError(
        () =>
          pairingCodes.create({
            id: "pair_short",
            rawCode: "12345",
            permission: "write",
            createdAt: fixedNow(),
            expiresAt: laterNow()
          }),
        "invalid_secret"
      );
      expectAuthError(
        () =>
          devices.create({
            id: "client_short_token",
            rawDeviceToken: "short",
            rawCsrfToken,
            permission: "write",
            createdAt: fixedNow()
          }),
        "invalid_secret"
      );
      expectAuthError(
        () =>
          devices.create({
            id: "client_bad_csrf",
            rawDeviceToken,
            rawCsrfToken: "csrf token with whitespace 123456",
            permission: "write",
            createdAt: fixedNow()
          }),
        "invalid_secret"
      );

      expect(rowCount(open.db, "pairing_codes")).toBe(0);
      expect(rowCount(open.db, "auth_devices")).toBe(0);

      devices.create({
        id: "client_valid",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });

      expectAuthError(() => devices.authenticateDeviceToken({ rawDeviceToken: "short", now: laterNow() }), "invalid_secret");
      expectAuthError(
        () => devices.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: "short", now: laterNow() }),
        "invalid_secret"
      );
    } finally {
      open.db.close();
    }
  });

  it("reports audit storage unavailability distinctly", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    const audit = createAuditEventRepository(open.db);
    open.db.close();

    expectAuditError(() => audit.append(lockAuditEvent("audit_closed_db")), "audit_unavailable");
  });

  it("keeps raw secrets and unbounded prompt text out of local SQLite rows", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    const fullPrompt = "Summarize this deployment log before continuing. ".repeat(20);

    try {
      createSessionRepository(open.db).create(sessionRecord());
      createPairingCodeRepository(open.db).create({
        id: "pair_privacy",
        rawCode,
        permission: "write",
        clientLabel: "phone",
        createdAt: fixedNow(),
        expiresAt: laterNow()
      });
      createPairingCodeRepository(open.db).claim({
        rawCode,
        deviceId: "client_privacy",
        rawDeviceToken,
        rawCsrfToken,
        now: fixedNow()
      });
      createAuditEventRepository(open.db).append({
        ...dashboardPromptAuditEvent(),
        action: "prompt",
        session_id: sessionId,
        payload_summary: {
          text_length: fullPrompt.length,
          text_preview: "Summarize this deployment log before continuing."
        },
        result: "accepted",
        error_code: null
      });

      const localState = JSON.stringify({
        auth: open.db.prepare("SELECT * FROM auth_devices").all(),
        pairing: open.db.prepare("SELECT * FROM pairing_codes").all(),
        audit: open.db.prepare("SELECT * FROM audit_events").all()
      });

      expect(localState).not.toContain(rawCode);
      expect(localState).not.toContain(rawDeviceToken);
      expect(localState).not.toContain(rawCsrfToken);
      expect(localState).not.toContain(fullPrompt);
    } finally {
      open.db.close();
    }
  });

  it("keeps the newest output event visible under an extreme byte cap", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const retention = createRetentionRepository(open.db);
      const policy = {
        ...defaultRetentionPolicy,
        output_event_limit: 10,
        output_byte_limit: 2
      };

      expect(retention.appendOutputEvent(outputEvent(1, "old"), { now: fixedNow, retention: policy }).boundary).toBeNull();
      expect(outputCursors(open.db)).toEqual([1]);

      const result = retention.appendOutputEvent(outputEvent(2, "new"), { now: fixedNow, retention: policy });

      expect(result.boundary).toMatchObject({
        reason: "byte_limit",
        retained_record_count: 1,
        truncated_before_cursor: 1
      });
      expect(outputCursors(open.db)).toEqual([2]);

      const replay = retention.listOutputReplay(sessionId, { after: 0, limit: 10 });
      expect(replay.truncated).toBe(true);
      expect(replay.events.map((event) => event.cursor)).toEqual([2]);
      expect(replay.next_cursor).toBe(3);
    } finally {
      open.db.close();
    }
  });
});

function sessionRecord() {
  return {
    id: sessionId,
    name: "hardening-demo",
    cwd: tempCwd(),
    backend: {
      type: "tmux",
      tmux_session: "hostdeck-hardening-demo",
      tmux_window: null,
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: "2026-07-08T22:00:00.000Z",
    updated_at: "2026-07-08T22:00:00.000Z",
    stale_reason: null
  };
}

function outputEvent(cursor: number, payload: string) {
  return {
    session_id: sessionId,
    cursor,
    order: cursor - 1,
    captured_at: "2026-07-08T22:00:00.000Z",
    kind: "output",
    payload,
    truncated_before: null
  };
}

function dashboardPromptAuditEvent() {
  return {
    id: "audit_privacy_prompt",
    at: "2026-07-08T22:00:00.000Z",
    actor: {
      type: "dashboard",
      client_id: "client_privacy",
      permission: "write"
    },
    action: "prompt",
    session_id: sessionId,
    payload_summary: {
      text_length: 8,
      text_preview: "Continue"
    },
    result: "accepted",
    error_code: null
  };
}

function lockAuditEvent(id: string) {
  return {
    id,
    at: "2026-07-08T22:00:00.000Z",
    actor: {
      type: "system",
      client_id: null,
      permission: null
    },
    action: "lock",
    session_id: null,
    payload_summary: {
      reason: "hardening"
    },
    result: "accepted",
    error_code: null
  };
}

function rowCount(db: Database.Database, tableName: "auth_devices" | "pairing_codes"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { readonly count: number };
  return row.count;
}

function outputCursors(db: Database.Database): number[] {
  return (db.prepare("SELECT cursor FROM output_events WHERE session_id = ? ORDER BY cursor ASC").all(sessionId) as Array<{ readonly cursor: number }>).map(
    (row) => row.cursor
  );
}

function expectMigrationError(fn: () => unknown, code: MigrationErrorCode): void {
  expect(fn).toThrow(HostDeckMigrationError);

  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckMigrationError);
    expect((error as HostDeckMigrationError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckMigrationError ${code}.`);
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

function expectAuditError(fn: () => unknown, code: AuditRepositoryErrorCode): void {
  expect(fn).toThrow(HostDeckAuditRepositoryError);

  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckAuditRepositoryError);
    expect((error as HostDeckAuditRepositoryError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckAuditRepositoryError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-hardening-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-hardening-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
