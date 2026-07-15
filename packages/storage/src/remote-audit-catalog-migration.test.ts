import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HostDeckMigrationError, openMigratedDatabase, runMigrations } from "./migration-runner.js";
import {
  defaultMigrations,
  hostDeckRemoteAuditCatalogMigration,
  type StorageMigration
} from "./migrations.js";
import { createSelectedAuditRepository } from "./selected-audit-repository.js";

const tempDirectories: string[] = [];
const acceptedAt = "2026-07-13T20:00:00.000Z";
const terminalAt = "2026-07-13T20:01:00.000Z";

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("remote audit catalog migration", () => {
  it("preserves historical rows byte-for-byte and restores the append-only query boundary", () => {
    const open = openMigratedDatabase(tempDbPath(), {
      migrations: migrationsBeforeRemoteAudit(),
      now: fixedNow
    });
    try {
      const versioned = historicalAccepted("lan_configure", "op_remote_audit_migration_v1", {
        schema_version: 1,
        bind_address_family: "ipv4",
        bind_port: 3777,
        certificate_change_requested: true
      });
      const versionedTerminal = historicalTerminal(versioned, {
        schema_version: 1,
        configuration_changed: true
      });
      const generic = historicalRejected("certificate_rotate", "op_remote_audit_migration_null", {
        legacy_note: "preserve exact historical JSON ordering"
      });
      insertRaw(open.db, versioned, 1);
      insertRaw(open.db, versionedTerminal, 1);
      insertRaw(open.db, generic, null);
      const before = rawRows(open.db);

      const result = runMigrations(open.db, { migrations: defaultMigrations, now: fixedNow });
      expect(result.applied).toEqual([
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog"
      ]);
      expect(rawRows(open.db)).toEqual(before);
      expect(createSelectedAuditRepository(open.db).require(versioned.operation_id).records).toHaveLength(2);
      expect(createSelectedAuditRepository(open.db).require(generic.operation_id).records[0]?.payload_summary).toEqual(
        generic.payload_summary
      );
      expect(schemaObjects(open.db, "index")).toEqual([
        "selected_audit_events_at_idx",
        "selected_audit_events_phase_at_operation_idx"
      ]);
      expect(schemaObjects(open.db, "trigger")).toEqual([
        "selected_audit_events_no_update",
        "selected_audit_events_start_requires_empty",
        "selected_audit_events_terminal_requires_accepted"
      ]);
      expect(() =>
        open.db.prepare("UPDATE selected_audit_events SET outcome = 'failed' WHERE id = ?").run(versioned.id)
      ).toThrow("selected audit events are append-only");
    } finally {
      open.db.close();
    }
  });

  it("enforces exact null, version-1, and version-2 action provenance", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordRejected(remoteRejected("remote_enable", "op_remote_audit_valid_v2"));
      expect(
        open.db
          .prepare("SELECT action, security_schema_version FROM selected_audit_events WHERE operation_id = ?")
          .get("op_remote_audit_valid_v2")
      ).toEqual({ action: "remote_enable", security_schema_version: 2 });

      for (const [index, [action, version]] of [
        ["remote_enable", null],
        ["remote_enable", 1],
        ["lan_enable", 2],
        ["prompt", 1],
        ["lock", 3],
        ["unknown_action", null]
      ].entries()) {
        expect(() => insertRejectedColumns(open.db, action, version, index)).toThrow();
      }
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 1 });
    } finally {
      open.db.close();
    }
  });

  it("rolls back a failed catalog rebuild without changing the prior table or rows", () => {
    const open = openMigratedDatabase(tempDbPath(), {
      migrations: migrationsBeforeRemoteAudit(),
      now: fixedNow
    });
    try {
      const historical = historicalRejected("lan_disable", "op_remote_audit_rollback", {
        schema_version: 1
      });
      insertRaw(open.db, historical, 1);
      const beforeSql = tableSql(open.db);
      const beforeRows = rawRows(open.db);
      const interrupted = {
        ...hostDeckRemoteAuditCatalogMigration,
        sql: `${hostDeckRemoteAuditCatalogMigration.sql}\nSELECT * FROM forced_remote_audit_migration_failure;`
      } satisfies StorageMigration;

      expect(() =>
        runMigrations(open.db, {
          migrations: [...migrationsBeforeRemoteAudit(), interrupted],
          now: fixedNow
        })
      ).toThrow(HostDeckMigrationError);
      expect(tableSql(open.db)).toBe(beforeSql);
      expect(rawRows(open.db)).toEqual(beforeRows);
      expect(
        open.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?").get(interrupted.version)
      ).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });
});

function migrationsBeforeRemoteAudit(): readonly StorageMigration[] {
  const migrations = defaultMigrations.slice(0, -3);
  if (migrations.at(-1)?.version !== "202607130013_remote_ingress_state") {
    throw new Error("Remote audit migration is not the next forward-only migration.");
  }
  return migrations;
}

function historicalAccepted(action: string, operationId: string, payloadSummary: Readonly<Record<string, unknown>>) {
  return {
    id: `audit:remote-migration:${action}:accepted`,
    operation_id: operationId,
    at: acceptedAt,
    actor: cliActor(),
    action,
    target: hostTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: payloadSummary,
    error_code: null
  } as const;
}

function historicalTerminal(
  accepted: ReturnType<typeof historicalAccepted>,
  payloadSummary: Readonly<Record<string, unknown>>
) {
  return {
    ...accepted,
    id: `${accepted.id}:terminal`,
    at: terminalAt,
    phase: "terminal",
    outcome: "succeeded",
    payload_summary: payloadSummary
  } as const;
}

function historicalRejected(action: string, operationId: string, payloadSummary: Readonly<Record<string, unknown>>) {
  return {
    ...historicalAccepted(action, operationId, payloadSummary),
    id: `audit:remote-migration:${action}:rejected`,
    phase: "terminal",
    outcome: "rejected",
    error_code: "validation_error"
  } as const;
}

function remoteRejected(action: "remote_disable" | "remote_enable", operationId: string) {
  return {
    id: `audit:remote-migration:${action}:rejected`,
    operation_id: operationId,
    at: terminalAt,
    actor: cliActor(),
    action,
    target: hostTarget(),
    phase: "terminal",
    outcome: "rejected",
    payload_summary: {
      schema_version: 1,
      action,
      requested_intent: action === "remote_enable" ? "enabled" : "disabled",
      profile_state: "other",
      serve_state: null,
      phase: "terminal",
      outcome: "rejected",
      admission: "closed",
      intent_persisted: false,
      serve_result: "not_attempted",
      reason: "profile_other"
    },
    error_code: "validation_error"
  } as const;
}

function insertRaw(
  db: Database.Database,
  record: Readonly<Record<string, unknown>>,
  securitySchemaVersion: 1 | null
): void {
  db.prepare(
    `
      INSERT INTO selected_audit_events (
        id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json
      ) VALUES (
        @id, @operation_id, @at, @action, @security_schema_version, @phase, @outcome, @error_code, @record_json
      )
    `
  ).run({ ...record, record_json: JSON.stringify(record), security_schema_version: securitySchemaVersion });
}

function insertRejectedColumns(db: Database.Database, action: unknown, version: unknown, index: number): void {
  db.prepare(
    `
      INSERT INTO selected_audit_events (
        id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json
      ) VALUES (?, ?, ?, ?, ?, 'terminal', 'rejected', 'validation_error', '{}')
    `
  ).run(`audit:remote-migration:invalid:${index}`, `op_remote_audit_invalid_${index}`, terminalAt, action, version);
}

function rawRows(db: Database.Database) {
  return db
    .prepare(
      "SELECT id, operation_id, at, action, security_schema_version, phase, outcome, error_code, " +
        "record_json, hex(CAST(record_json AS BLOB)) AS record_hex " +
        "FROM selected_audit_events ORDER BY operation_id, phase, id"
    )
    .all();
}

function schemaObjects(db: Database.Database, type: "index" | "trigger"): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'selected_audit_events_%' ORDER BY name"
      )
      .all(type) as Array<{ readonly name: string }>
  ).map((row) => row.name);
}

function tableSql(db: Database.Database): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'selected_audit_events'")
    .get() as { readonly sql: string } | undefined;
  if (row === undefined) throw new Error("Missing selected audit table.");
  return row.sql;
}

function cliActor() {
  return { type: "cli", device_id: null, permission: "local_admin", origin: null } as const;
}

function hostTarget() {
  return { type: "host", host_id: "local_host" } as const;
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-remote-audit-migration-"));
  tempDirectories.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-13T19:59:00.000Z");
}
