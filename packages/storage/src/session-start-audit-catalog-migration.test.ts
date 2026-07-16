import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HostDeckMigrationError, openMigratedDatabase, runMigrations } from "./migration-runner.js";
import {
  defaultMigrations,
  hostDeckSessionStartAuditCatalogMigration,
  type StorageMigration
} from "./migrations.js";
import {
  createSelectedAuditRepository,
  reconcileSelectedAuditOrphansBatch
} from "./selected-audit-repository.js";

const tempDirectories: string[] = [];
const acceptedAt = "2026-07-15T12:00:00.000Z";
const terminalAt = "2026-07-15T12:01:00.000Z";

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("session-start audit catalog migration", () => {
  it("preserves prior bytes and restores every audit index and trigger", () => {
    const open = openMigratedDatabase(tempDbPath(), {
      migrations: migrationsBeforeSessionStartAudit(),
      now: fixedNow
    });
    try {
      const prior = promptRejected();
      insertRaw(open.db, prior);
      const before = rawRows(open.db);

      expect(runMigrations(open.db, { migrations: defaultMigrations, now: fixedNow }).applied).toEqual([
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(rawRows(open.db)).toEqual(before);
      expect(schemaObjects(open.db, "index")).toEqual([
        "selected_audit_events_at_idx",
        "selected_audit_events_phase_at_operation_idx"
      ]);
      expect(schemaObjects(open.db, "trigger")).toEqual([
        "selected_audit_events_no_update",
        "selected_audit_events_start_requires_empty",
        "selected_audit_events_terminal_requires_accepted",
        "selected_remote_ingress_admission_proof_invalidate"
      ]);
      expect(() =>
        open.db.prepare("UPDATE selected_audit_events SET outcome = 'failed' WHERE id = ?").run(prior.id)
      ).toThrow("selected audit events are append-only");
    } finally {
      open.db.close();
    }
  });

  it("writes, reads, and reconciles strict session-start trails with null security provenance", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const accepted = sessionStartAccepted("op_session_start_migration_live");
      repository.recordAccepted(accepted);
      repository.recordTerminal(sessionStartTerminal(accepted));
      expect(repository.require(accepted.operation_id)).toMatchObject({
        state: "terminal",
        records: [{ action: "session_start" }, { outcome: "succeeded" }]
      });
      expect(
        open.db
          .prepare("SELECT DISTINCT security_schema_version FROM selected_audit_events WHERE operation_id = ?")
          .all(accepted.operation_id)
      ).toEqual([{ security_schema_version: null }]);

      const orphan = sessionStartAccepted("op_session_start_migration_orphan");
      repository.recordAccepted(orphan);
      expect(
        reconcileSelectedAuditOrphansBatch(open.db, {
          eligible_before: "2026-07-15T12:00:30.000Z",
          reconciled_at: terminalAt,
          max_reconciled_operations: 10
        })
      ).toMatchObject({ reconciled_operation_count: 1, remaining: false });
      expect(repository.require(orphan.operation_id).records[1]).toMatchObject({
        action: "session_start",
        outcome: "incomplete",
        error_code: "runtime_unavailable",
        payload_summary: {
          schema_version: 1,
          reconciliation_reason: "host_restart_without_terminal"
        }
      });

      for (const invalid of [
        { ...sessionStartAccepted("op_session_start_invalid_actor"), actor: systemActor() },
        { ...sessionStartAccepted("op_session_start_invalid_summary"), payload_summary: { schema_version: 1, cwd: "/private" } },
        { ...sessionStartAccepted("op_session_start_invalid_target"), target: { type: "host", host_id: "other" } }
      ]) {
        expect(() => repository.recordAccepted(invalid)).toThrowError(
          expect.objectContaining({ code: "invalid_audit_record" })
        );
      }
      expect(() =>
        repository.recordRejected({
          ...sessionStartAccepted("op_session_start_rejected"),
          id: "audit:op_session_start_rejected:terminal",
          phase: "terminal",
          outcome: "rejected",
          payload_summary: { schema_version: 1 },
          error_code: "validation_error"
        })
      ).toThrowError(expect.objectContaining({ code: "invalid_audit_record" }));

      expect(() =>
        insertRaw(
          open.db,
          sessionStartAccepted("op_session_start_invalid_provenance"),
          1
        )
      ).toThrow();
      expect(() =>
        insertRaw(open.db, {
          ...sessionStartAccepted("op_session_start_unsupported_action"),
          action: "session_start_unselected"
        })
      ).toThrow();
    } finally {
      open.db.close();
    }
  });

  it("reconciles one accepted session-start trail after restart without rewriting accepted bytes", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const accepted = sessionStartAccepted("op_session_start_restart_orphan");
    createSelectedAuditRepository(first.db).recordAccepted(accepted);
    const acceptedJson = rawRecordJson(first.db, accepted.operation_id, "accepted");
    first.db.close();

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(reopened.result.applied).toEqual([]);
      expect(createSelectedAuditRepository(reopened.db).require(accepted.operation_id)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
      expect(
        reconcileSelectedAuditOrphansBatch(reopened.db, {
          eligible_before: "2026-07-15T12:00:30.000Z",
          reconciled_at: terminalAt,
          max_reconciled_operations: 1
        })
      ).toMatchObject({ reconciled_operation_count: 1, remaining: false });
      expect(createSelectedAuditRepository(reopened.db).require(accepted.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          {
            phase: "terminal",
            outcome: "incomplete",
            error_code: "runtime_unavailable",
            payload_summary: {
              schema_version: 1,
              reconciliation_reason: "host_restart_without_terminal"
            }
          }
        ]
      });
      expect(rawRecordJson(reopened.db, accepted.operation_id, "accepted")).toBe(acceptedJson);
    } finally {
      reopened.db.close();
    }
  });

  it("rolls back a failed table rebuild without changing prior schema or rows", () => {
    const open = openMigratedDatabase(tempDbPath(), {
      migrations: migrationsBeforeSessionStartAudit(),
      now: fixedNow
    });
    try {
      insertRaw(open.db, promptRejected());
      const beforeSql = tableSql(open.db);
      const beforeRows = rawRows(open.db);
      const interrupted = {
        ...hostDeckSessionStartAuditCatalogMigration,
        sql: `${hostDeckSessionStartAuditCatalogMigration.sql}\nSELECT * FROM forced_session_start_migration_failure;`
      } satisfies StorageMigration;
      expect(() =>
        runMigrations(open.db, {
          migrations: [...migrationsBeforeSessionStartAudit(), interrupted],
          now: fixedNow
        })
      ).toThrow(HostDeckMigrationError);
      expect(tableSql(open.db)).toBe(beforeSql);
      expect(rawRows(open.db)).toEqual(beforeRows);
    } finally {
      open.db.close();
    }
  });
});

function migrationsBeforeSessionStartAudit(): readonly StorageMigration[] {
  const index = defaultMigrations.findIndex(
    (migration) => migration.version === "202607150016_session_start_audit_catalog"
  );
  if (index < 0) throw new Error("Session-start audit migration is missing.");
  const migrations = defaultMigrations.slice(0, index);
  if (migrations.at(-1)?.version !== "202607130015_remote_admission_proof") {
    throw new Error("Session-start audit migration is not the next forward-only migration.");
  }
  return migrations;
}

function sessionStartAccepted(operationId: string) {
  return {
    id: `audit:${operationId}:accepted`,
    operation_id: operationId,
    at: acceptedAt,
    actor: cliActor(),
    action: "session_start" as const,
    target: hostTarget(),
    phase: "accepted" as const,
    outcome: "accepted" as const,
    payload_summary: { schema_version: 1, name_length: 12, cwd_present: true },
    error_code: null
  };
}

function sessionStartTerminal(accepted: ReturnType<typeof sessionStartAccepted>) {
  return {
    ...accepted,
    id: `audit:${accepted.operation_id}:terminal`,
    at: terminalAt,
    phase: "terminal" as const,
    outcome: "succeeded" as const,
    payload_summary: { schema_version: 1, created: true }
  };
}

function promptRejected() {
  return {
    id: "audit:session-start:migration:prior",
    operation_id: "op_session_start_migration_prior",
    at: acceptedAt,
    actor: cliActor(),
    action: "prompt",
    target: {
      type: "managed_session",
      session_id: "sess_session_start_prior",
      codex_thread_id: "thread-session-start-prior"
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

function systemActor() {
  return { type: "system" as const, device_id: null, permission: null, origin: null };
}

function hostTarget() {
  return { type: "host" as const, host_id: "local_host" as const };
}

function insertRaw(
  db: Database.Database,
  record: Readonly<Record<string, unknown>>,
  securitySchemaVersion: 1 | null = null
): void {
  db.prepare(
    `
      INSERT INTO selected_audit_events (
        id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json
      ) VALUES (@id, @operation_id, @at, @action, @security_schema_version, @phase, @outcome, @error_code, @record_json)
    `
  ).run({
    ...record,
    security_schema_version: securitySchemaVersion,
    record_json: JSON.stringify(record)
  });
}

function rawRows(db: Database.Database) {
  return db
    .prepare(
      "SELECT id, operation_id, at, action, security_schema_version, phase, outcome, error_code, " +
        "record_json, hex(CAST(record_json AS BLOB)) AS record_hex FROM selected_audit_events ORDER BY id"
    )
    .all();
}

function rawRecordJson(db: Database.Database, operationId: string, phase: string): string {
  const row = db
    .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? AND phase = ?")
    .get(operationId, phase) as { record_json: string } | undefined;
  if (row === undefined) throw new Error("Selected audit record is missing.");
  return row.record_json;
}

function schemaObjects(db: Database.Database, type: "index" | "trigger"): readonly string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND (name LIKE 'selected_audit_%' OR name = 'selected_remote_ingress_admission_proof_invalidate') ORDER BY name").all(type) as Array<{ name: string }>).map(
    (row) => row.name
  );
}

function tableSql(db: Database.Database): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'selected_audit_events'").get() as
    | { sql: string }
    | undefined;
  if (row === undefined) throw new Error("Selected audit table is missing.");
  return row.sql;
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-session-start-audit-"));
  tempDirectories.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(acceptedAt);
}
