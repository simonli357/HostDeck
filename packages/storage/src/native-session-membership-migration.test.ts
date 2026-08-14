import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HostDeckMigrationError, openMigratedDatabase, runMigrations } from "./migration-runner.js";
import {
  defaultMigrations,
  hostDeckNativeSessionMembershipMigration,
  type StorageMigration
} from "./migrations.js";
import {
  createSelectedAuditRepository,
  reconcileSelectedAuditOrphansBatch
} from "./selected-audit-repository.js";

const tempDirectories: string[] = [];
const acceptedAt = "2026-08-12T16:00:00.000Z";
const terminalAt = "2026-08-12T16:01:00.000Z";

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("native session membership migration", () => {
  it("preserves existing audit bytes and adds immutable membership plus lifecycle actions", () => {
    const open = openMigratedDatabase(tempDbPath(), {
      migrations: migrationsBeforeNativeMembership(),
      now: fixedNow
    });
    try {
      const prior = promptRejected();
      insertRaw(open.db, prior);
      const priorJson = rawRecordJson(open.db, prior.operation_id, "terminal");

      expect(runMigrations(open.db, { migrations: defaultMigrations, now: fixedNow }).applied).toEqual([
        hostDeckNativeSessionMembershipMigration.version,
        "202608140021_automatic_session_membership"
      ]);
      expect(rawRecordJson(open.db, prior.operation_id, "terminal")).toBe(priorJson);
      expect(tableExists(open.db, "selected_native_session_memberships")).toBe(true);

      const audit = createSelectedAuditRepository(open.db);
      const adopt = adoptionAccepted("op_native_adopt_migration");
      audit.recordAccepted(adopt);
      audit.recordTerminal({
        ...adopt,
        id: `${adopt.id}:terminal`,
        at: terminalAt,
        phase: "terminal",
        outcome: "succeeded",
        payload_summary: { schema_version: 1, history_turn_count: 2, adopted: true }
      });
      const unmanage = unmanageAccepted("op_native_unmanage_migration");
      audit.recordAccepted(unmanage);
      audit.recordTerminal({
        ...unmanage,
        id: `${unmanage.id}:terminal`,
        at: terminalAt,
        phase: "terminal",
        outcome: "succeeded",
        payload_summary: { schema_version: 1, unmanaged: true }
      });
      expect(audit.require(adopt.operation_id).records.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
        { action: "session_adopt", outcome: "accepted" },
        { action: "session_adopt", outcome: "succeeded" }
      ]);
      expect(audit.require(unmanage.operation_id).records.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
        { action: "session_unmanage", outcome: "accepted" },
        { action: "session_unmanage", outcome: "succeeded" }
      ]);
      expect(
        open.db
          .prepare("SELECT DISTINCT security_schema_version FROM selected_audit_events WHERE action IN (?, ?) ORDER BY security_schema_version")
          .all("session_adopt", "session_unmanage")
      ).toEqual([{ security_schema_version: null }]);
    } finally {
      open.db.close();
    }
  });

  it("reconciles accepted-only adoption and unmanage trails without inventing success", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const adoption = adoptionAccepted("op_native_adopt_orphan");
    const unmanage = unmanageAccepted("op_native_unmanage_orphan");
    const audit = createSelectedAuditRepository(first.db);
    audit.recordAccepted(adoption);
    audit.recordAccepted(unmanage);
    const acceptedBytes = [adoption, unmanage].map((record) =>
      rawRecordJson(first.db, record.operation_id, "accepted")
    );
    first.db.close();

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(
        reconcileSelectedAuditOrphansBatch(reopened.db, {
          eligible_before: "2026-08-12T16:00:30.000Z",
          reconciled_at: terminalAt,
          max_reconciled_operations: 2
        })
      ).toMatchObject({ reconciled_operation_count: 2, remaining: false });
      const repository = createSelectedAuditRepository(reopened.db);
      expect(repository.require(adoption.operation_id).records[1]).toMatchObject({
        action: "session_adopt",
        outcome: "incomplete",
        error_code: "runtime_unavailable",
        payload_summary: { schema_version: 1, activation_pending: true }
      });
      expect(repository.require(unmanage.operation_id).records[1]).toMatchObject({
        action: "session_unmanage",
        outcome: "incomplete",
        error_code: "runtime_unavailable",
        payload_summary: { schema_version: 1 }
      });
      expect([adoption, unmanage].map((record) => rawRecordJson(reopened.db, record.operation_id, "accepted"))).toEqual(
        acceptedBytes
      );
    } finally {
      reopened.db.close();
    }
  });

  it("rolls back an interrupted catalog rebuild and membership creation together", () => {
    const migrations = migrationsBeforeNativeMembership();
    const open = openMigratedDatabase(tempDbPath(), { migrations, now: fixedNow });
    try {
      const prior = promptRejected();
      insertRaw(open.db, prior);
      const beforeSql = auditTableSql(open.db);
      const interrupted = {
        ...hostDeckNativeSessionMembershipMigration,
        sql: `${hostDeckNativeSessionMembershipMigration.sql}\nSELECT * FROM forced_native_membership_failure;`
      } satisfies StorageMigration;
      expect(() => runMigrations(open.db, { migrations: [...migrations, interrupted], now: fixedNow })).toThrow(
        HostDeckMigrationError
      );
      expect(tableExists(open.db, "selected_native_session_memberships")).toBe(false);
      expect(auditTableSql(open.db)).toBe(beforeSql);
      expect(rawRecordJson(open.db, prior.operation_id, "terminal")).toBe(JSON.stringify(prior));
    } finally {
      open.db.close();
    }
  });
});

function migrationsBeforeNativeMembership(): readonly StorageMigration[] {
  const index = defaultMigrations.findIndex(
    (migration) => migration.version === hostDeckNativeSessionMembershipMigration.version
  );
  if (index < 1) throw new Error("Native membership migration is missing or unordered.");
  const migrations = defaultMigrations.slice(0, index);
  if (migrations.at(-1)?.version !== "202608110019_cross_platform_cwd") {
    throw new Error("Native membership migration must follow cross-platform cwd migration.");
  }
  return migrations;
}

function adoptionAccepted(operationId: string) {
  return {
    id: `audit:${operationId}:accepted`,
    operation_id: operationId,
    at: acceptedAt,
    actor: cliActor(),
    action: "session_adopt" as const,
    target: { type: "native_codex_thread" as const, codex_thread_id: "thread-native-audit-001" },
    phase: "accepted" as const,
    outcome: "accepted" as const,
    payload_summary: { schema_version: 1, handoff_confirmed: true, name_length: 14 },
    error_code: null
  };
}

function unmanageAccepted(operationId: string) {
  return {
    id: `audit:${operationId}:accepted`,
    operation_id: operationId,
    at: acceptedAt,
    actor: cliActor(),
    action: "session_unmanage" as const,
    target: {
      type: "managed_session" as const,
      session_id: "sess_native_audit_001",
      codex_thread_id: "thread-native-audit-001"
    },
    phase: "accepted" as const,
    outcome: "accepted" as const,
    payload_summary: { schema_version: 1, confirm: true },
    error_code: null
  };
}

function promptRejected() {
  return {
    id: "audit:native-membership:prior",
    operation_id: "op_native_membership_prior",
    at: acceptedAt,
    actor: cliActor(),
    action: "prompt",
    target: {
      type: "managed_session",
      session_id: "sess_native_prior",
      codex_thread_id: "thread-native-prior"
    },
    phase: "terminal",
    outcome: "rejected",
    payload_summary: { schema_version: 1 },
    error_code: "validation_error"
  } as const;
}

function cliActor() {
  return { type: "cli" as const, device_id: null, permission: "local_admin" as const, origin: null };
}

function insertRaw(db: Database.Database, record: Readonly<Record<string, unknown>>): void {
  db.prepare(
    `
      INSERT INTO selected_audit_events (
        id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json
      ) VALUES (@id, @operation_id, @at, @action, NULL, @phase, @outcome, @error_code, @record_json)
    `
  ).run({ ...record, record_json: JSON.stringify(record) });
}

function rawRecordJson(db: Database.Database, operationId: string, phase: string): string {
  const row = db
    .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? AND phase = ?")
    .get(operationId, phase) as { readonly record_json: string } | undefined;
  if (row === undefined) throw new Error("Selected audit record is missing.");
  return row.record_json;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function auditTableSql(db: Database.Database): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'selected_audit_events'")
    .get() as { readonly sql: string } | undefined;
  if (row === undefined) throw new Error("Selected audit table is missing.");
  return row.sql;
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-native-membership-"));
  tempDirectories.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(acceptedAt);
}
