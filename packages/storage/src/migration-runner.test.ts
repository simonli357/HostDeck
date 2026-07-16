import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HostDeckMigrationError, openMigratedDatabase, runMigrations } from "./migration-runner.js";
import { defaultMigrations, type StorageMigration } from "./migrations.js";
import { createSelectedStateRepository, selectedStateRevision } from "./selected-state-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("SQLite migration runner", () => {
  it("preserves the checksums of every published migration", () => {
    expect(
      Object.fromEntries(
        defaultMigrations.map((migration) => [
          migration.version,
          createHash("sha256").update(migration.sql).digest("hex")
        ])
      )
    ).toEqual({
      "202607080001_base_schema": "5947edef9a1b7f5813506a74073def0591ae1496bad0fdfa6a642dc7847e1b3b",
      "202607080002_session_metadata_failed_status": "7329f746d832c3ed4893a724572dd498e0e072860425ddc8d9278fa23e248b08",
      "202607080003_auth_device_csrf_hash": "0a4ad8c4692806e0bde02856f1d8a7b21ec2fe1426a8941e5b07ecb5d65f37d2",
      "202607080004_retention_boundary_scope_checks": "1a22e20b6c6679a2045469f0447c0b6e014ca72b95635a65c45cdbe6cafe8adf",
      "202607080005_pairing_code_revoked_at": "43a464010577c15677426c81a530328f2d76425d29eaa8d2d5446e737392aa70",
      "202607090006_selected_runtime_state": "b82cd7abd76ab71ab73d7b361cd318dd862edd64749ce64942598c6f972e90fa",
      "202607100007_selected_audit_state": "965189761889f62c787c07f190b5c0aa76d90f17b00b4f97fcbe46121bfec9f2",
      "202607100008_selected_retention_indexes": "e07bb8c5f498294775002c96052b1ae94282e2daf6b8afdd6dd49b08e9e9e8ae",
      "202607110009_auth_device_csrf_rotation": "464b37ea4aafd1d094d7abf4297cc012403d482871d06554f21fdda7d170d5ce",
      "202607110010_security_audit_catalog": "1db9a127f80ba20f120cd8bbf9b65bc57fc2ca859d82e50a4f213f10d16ba0ab",
      "202607110011_selected_pairing_claim": "6491026ff2fd23c5346273dbda5b3f5f6927d7c8b953b403ba512b5af83db927",
      "202607120012_selected_lan_configuration": "fe01df684e04d66f6efa859fd0845ba77b39ec1ce497065f942fa4bc9d84761e",
      "202607130013_remote_ingress_state": "342f963fc3fd349353ee2487346ec4862b2ec16e5b0275b49de3a577fc95258d",
      "202607130014_remote_audit_catalog": "c8c94dda5c2cf3a2af5a85e8ce58f53feadbfcccfcc84f3a57715415d78eaf65",
      "202607130015_remote_admission_proof": "7b080b4cb2054274001f8bbedb35a04b9f904b6b6bbf362c3ddd222382054d12",
      "202607150016_session_start_audit_catalog": "4d6ebd8346b5e329cae5aa6e4f396eb130e73ccbf153388e0f1807821e5c806f",
      "202607160017_selected_session_settings_projection": "c6382889bd40b65cf2f421c03bfb750588483edf47cacefacc5f0a910fa78ff7"
    });
  });

  it("creates the current schema on a fresh database", () => {
    const path = tempDbPath();
    const { db, result } = openMigratedDatabase(path, {
      now: fixedNow
    });

    try {
      expect(result.applied).toEqual([
        "202607080001_base_schema",
        "202607080002_session_metadata_failed_status",
        "202607080003_auth_device_csrf_hash",
        "202607080004_retention_boundary_scope_checks",
        "202607080005_pairing_code_revoked_at",
        "202607090006_selected_runtime_state",
        "202607100007_selected_audit_state",
        "202607100008_selected_retention_indexes",
        "202607110009_auth_device_csrf_rotation",
        "202607110010_security_audit_catalog",
        "202607110011_selected_pairing_claim",
        "202607120012_selected_lan_configuration",
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(tableNames(db)).toEqual([
        "audit_events",
        "auth_devices",
        "legacy_session_dispositions",
        "output_events",
        "pairing_claim_rate_global",
        "pairing_claim_rate_sources",
        "pairing_codes",
        "retention_boundaries",
        "schema_migrations",
        "selected_audit_events",
        "selected_lan_configuration",
        "selected_projected_events",
        "selected_remote_ingress_admission_proof",
        "selected_remote_ingress_state",
        "selected_runtime_compatibility",
        "selected_session_projections",
        "selected_session_start_recovery",
        "selected_sessions",
        "session_metadata",
        "sessions",
        "settings"
      ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 17 });
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("selected_audit_events_phase_at_operation_idx")
      ).toEqual({ name: "selected_audit_events_phase_at_operation_idx" });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("auth_devices_csrf_token_hash_idx")
      ).toEqual({ name: "auth_devices_csrf_token_hash_idx" });
    } finally {
      db.close();
    }
  });

  it("adds nullable structured session settings without rewriting prior projection truth", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607150016_session_start_audit_catalog"),
      now: fixedNow
    });
    const createdAt = "2026-07-16T12:00:00.000Z";
    prior.db
      .prepare(
        `
          INSERT INTO selected_sessions (
            id, name, codex_thread_id, cwd, runtime_source, runtime_version,
            disposition, created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, 'codex_app_server', '0.144.0', 'selected', ?, ?, NULL)
        `
      )
      .run("sess_settings_migration", "settings-migration", "thread-settings-migration", "/tmp/settings-migration", createdAt, createdAt);
    prior.db
      .prepare(
        `
          INSERT INTO selected_session_projections (
            session_id, session_state, turn_state, attention, freshness, freshness_reason,
            updated_at, last_activity_at, branch, model, goal_json, recent_summary,
            last_event_cursor, retained_event_count, retained_event_bytes,
            earliest_retained_cursor, retention_boundary_cursor
          ) VALUES (?, 'active', 'idle', 'none', 'current', NULL, ?, NULL, NULL, NULL, NULL, '', NULL, 0, 0, NULL, NULL)
        `
      )
      .run("sess_settings_migration", createdAt);
    const before = prior.db.prepare("SELECT * FROM selected_session_projections").get() as Record<string, unknown>;
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    expect(migrated.result.applied).toEqual(["202607160017_selected_session_settings_projection"]);
    const raw = migrated.db.prepare("SELECT * FROM selected_session_projections").get() as Record<string, unknown>;
    expect(raw.settings_json).toBeNull();
    expect(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "settings_json"))).toEqual(before);

    const repository = createSelectedStateRepository(migrated.db);
    const current = repository.require("sess_settings_migration");
    expect(current.projection.session.settings).toBeNull();
    const observedAt = "2026-07-16T12:00:01.000Z";
    repository.replace(
      {
        mapping: { ...current.mapping, updated_at: observedAt },
        projection: {
          ...current.projection,
          session: {
            ...current.projection.session,
            updated_at: observedAt,
            model: "gpt-5.5-codex",
            settings: {
              collaboration_mode: "plan",
              runtime_model: "gpt-5.5-codex",
              reasoning_effort: "high",
              observed_at: observedAt
            }
          }
        }
      },
      selectedStateRevision(current)
    );
    migrated.db.close();

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(createSelectedStateRepository(reopened.db).require("sess_settings_migration").projection.session.settings).toEqual({
        collaboration_mode: "plan",
        runtime_model: "gpt-5.5-codex",
        reasoning_effort: "high",
        observed_at: observedAt
      });
      reopened.db
        .prepare("UPDATE selected_session_projections SET settings_json = '{}' WHERE session_id = ?")
        .run("sess_settings_migration");
      expect(() => createSelectedStateRepository(reopened.db).require("sess_settings_migration")).toThrow(
        "Selected session projection is invalid"
      );
    } finally {
      reopened.db.close();
    }
  });

  it("rolls back the structured-settings column when its migration transaction fails", () => {
    const path = tempDbPath();
    const priorMigrations = migrationsThrough("202607150016_session_start_audit_catalog");
    const prior = openMigratedDatabase(path, { migrations: priorMigrations, now: fixedNow });
    prior.db.close();
    const settingsMigration = defaultMigrations.at(-1);
    if (settingsMigration?.version !== "202607160017_selected_session_settings_projection") {
      throw new Error("Structured-settings migration is not the latest migration.");
    }
    const failingMigration: StorageMigration = {
      ...settingsMigration,
      sql: `${settingsMigration.sql}\nSELECT * FROM missing_settings_migration_dependency;`
    };

    expect(() =>
      openMigratedDatabase(path, {
        migrations: [...priorMigrations, failingMigration],
        now: fixedNow
      })
    ).toThrow(HostDeckMigrationError);

    const inspected = new Database(path);
    try {
      const columns = inspected
        .prepare("PRAGMA table_info(selected_session_projections)")
        .all() as Array<{ readonly name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("settings_json");
      expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 16 });
    } finally {
      inspected.close();
    }
  });

  it("adds selected audit state without rewriting historical audit rows", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607090006_selected_runtime_state"),
      now: fixedNow
    });
    prior.db
      .prepare(
        `
          INSERT INTO audit_events (
            id, at, actor_type, actor_client_id, actor_permission, action,
            session_id, payload_summary_json, result, error_code
          ) VALUES (?, ?, 'system', NULL, NULL, 'lock', NULL, '{}', 'accepted', NULL)
        `
      )
      .run("audit_legacy_preserved", fixedNow().toISOString());
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607100007_selected_audit_state",
        "202607100008_selected_retention_indexes",
        "202607110009_auth_device_csrf_rotation",
        "202607110010_security_audit_catalog",
        "202607110011_selected_pairing_claim",
        "202607120012_selected_lan_configuration",
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(migrated.db.prepare("SELECT id FROM audit_events WHERE id = 'audit_legacy_preserved'").get()).toEqual({
        id: "audit_legacy_preserved"
      });
      expect(migrated.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 0 });
    } finally {
      migrated.db.close();
    }
  });

  it("adds selected retention indexes without rewriting existing selected audit rows", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607100007_selected_audit_state"),
      now: fixedNow
    });
    prior.db
      .prepare(
        `
          INSERT INTO selected_audit_events (
            id, operation_id, at, action, phase, outcome, error_code, record_json
          ) VALUES (?, ?, ?, 'prompt', 'terminal', 'rejected', 'validation_error', ?)
        `
      )
      .run(
        "audit:index:preserved",
        "op_index_preserved",
        fixedNow().toISOString(),
        JSON.stringify({
          id: "audit:index:preserved",
          operation_id: "op_index_preserved",
          at: fixedNow().toISOString(),
          actor: {
            type: "dashboard",
            device_id: "device:index:migration",
            permission: "write",
            origin: "https://hostdeck.local"
          },
          action: "prompt",
          target: {
            type: "managed_session",
            session_id: "sess_index_migration",
            codex_thread_id: "thread-index-migration"
          },
          phase: "terminal",
          outcome: "rejected",
          payload_summary: { reason: "migration_fixture" },
          error_code: "validation_error"
        })
      );
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607100008_selected_retention_indexes",
        "202607110009_auth_device_csrf_rotation",
        "202607110010_security_audit_catalog",
        "202607110011_selected_pairing_claim",
        "202607120012_selected_lan_configuration",
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(migrated.db.prepare("SELECT id FROM selected_audit_events WHERE operation_id = ?").get("op_index_preserved")).toEqual({
        id: "audit:index:preserved"
      });
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("selected_audit_events_phase_at_operation_idx")
      ).toEqual({ name: "selected_audit_events_phase_at_operation_idx" });
    } finally {
      migrated.db.close();
    }
  });

  it("adds CSRF rotation state without rewriting existing auth-device identity or hashes", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607100008_selected_retention_indexes"),
      now: fixedNow
    });
    const tokenHash = `sha256:${"1".repeat(64)}`;
    const csrfHash = `sha256:${"2".repeat(64)}`;
    prior.db
      .prepare(
        `
          INSERT INTO auth_devices (
            id, token_hash, csrf_token_hash, client_label, permission,
            created_at, last_used_at, expires_at, revoked_at
          ) VALUES (?, ?, ?, ?, 'write', ?, ?, ?, NULL)
        `
      )
      .run(
        "client_csrf_migration",
        tokenHash,
        csrfHash,
        "migration-phone",
        fixedNow().toISOString(),
        "2026-07-08T22:01:00.000Z",
        "2027-07-08T22:00:00.000Z"
      );
    prior.db
      .prepare(
        `
          INSERT INTO auth_devices (
            id, token_hash, csrf_token_hash, client_label, permission,
            created_at, last_used_at, expires_at, revoked_at
          ) VALUES (?, ?, ?, NULL, 'read', ?, NULL, NULL, ?)
        `
      )
      .run(
        "client_csrf_migration_revoked",
        `sha256:${"3".repeat(64)}`,
        csrfHash,
        "2026-07-08T21:00:00.000Z",
        "2026-07-08T22:02:00.000Z"
      );
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607110009_auth_device_csrf_rotation",
        "202607110010_security_audit_catalog",
        "202607110011_selected_pairing_claim",
        "202607120012_selected_lan_configuration",
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(migrated.db.prepare("SELECT * FROM auth_devices WHERE id = ?").get("client_csrf_migration")).toEqual({
        id: "client_csrf_migration",
        token_hash: tokenHash,
        csrf_token_hash: csrfHash,
        csrf_generation: 1,
        csrf_rotated_at: fixedNow().toISOString(),
        client_label: "migration-phone",
        permission: "write",
        created_at: fixedNow().toISOString(),
        last_used_at: "2026-07-08T22:01:00.000Z",
        expires_at: "2027-07-08T22:00:00.000Z",
        revoked_at: null
      });
      expect(migrated.db.prepare("SELECT * FROM auth_devices WHERE id = ?").get("client_csrf_migration_revoked")).toMatchObject({
        csrf_token_hash: csrfHash,
        csrf_generation: 1,
        csrf_rotated_at: "2026-07-08T21:00:00.000Z",
        permission: "read",
        created_at: "2026-07-08T21:00:00.000Z",
        revoked_at: "2026-07-08T22:02:00.000Z"
      });
      for (const invalidGeneration of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() =>
          migrated.db
            .prepare("UPDATE auth_devices SET csrf_generation = ? WHERE id = ?")
            .run(invalidGeneration, "client_csrf_migration")
        ).toThrow();
      }
      expect(() =>
        migrated.db.prepare("UPDATE auth_devices SET csrf_rotated_at = NULL WHERE id = ?").run("client_csrf_migration")
      ).toThrow();
      expect(
        migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("auth_devices_csrf_token_hash_idx")
      ).toEqual({ name: "auth_devices_csrf_token_hash_idx" });
      const queryPlan = migrated.db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM auth_devices WHERE csrf_token_hash = ? LIMIT 1")
        .all(csrfHash) as Array<{ readonly detail: string }>;
      expect(queryPlan.some(({ detail }) => detail.includes("auth_devices_csrf_token_hash_idx"))).toBe(true);
    } finally {
      migrated.db.close();
    }
  });

  it("adds CSRF bootstrap audit storage while preserving rows, indexes, triggers, and rollback", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607110009_auth_device_csrf_rotation"),
      now: fixedNow
    });
    const operationId = "op_security_migration_legacy";
    const accepted = {
      id: "audit:security:migration:accepted",
      operation_id: operationId,
      at: "2026-07-11T20:00:00.000Z",
      actor: { type: "cli", device_id: null, permission: "local_admin", origin: null },
      action: "pair_request",
      target: { type: "host", host_id: "local_host" },
      phase: "accepted",
      outcome: "accepted",
      payload_summary: { legacy_note: "preserve-byte-for-byte" },
      error_code: null
    } as const;
    const terminal = {
      ...accepted,
      id: "audit:security:migration:terminal",
      at: "2026-07-11T20:01:00.000Z",
      phase: "terminal",
      outcome: "succeeded",
      payload_summary: { legacy_result: "preserved" }
    } as const;
    insertSelectedAuditRecord(prior.db, accepted);
    insertSelectedAuditRecord(prior.db, terminal);
    const rowsBefore = prior.db
      .prepare(
        "SELECT id, operation_id, at, action, phase, outcome, error_code, record_json " +
          "FROM selected_audit_events ORDER BY phase"
      )
      .all();
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607110010_security_audit_catalog",
        "202607110011_selected_pairing_claim",
        "202607120012_selected_lan_configuration",
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(
        migrated.db
          .prepare(
            "SELECT id, operation_id, at, action, phase, outcome, error_code, record_json " +
              "FROM selected_audit_events ORDER BY phase"
          )
          .all()
      ).toEqual(rowsBefore);
      expect(
        migrated.db.prepare("SELECT DISTINCT security_schema_version FROM selected_audit_events").all()
      ).toEqual([{ security_schema_version: null }]);
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'selected_audit_events_%' ORDER BY name")
          .all()
      ).toEqual([
        { name: "selected_audit_events_at_idx" },
        { name: "selected_audit_events_phase_at_operation_idx" }
      ]);
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'selected_audit_events_%' ORDER BY name")
          .all()
      ).toEqual([
        { name: "selected_audit_events_no_update" },
        { name: "selected_audit_events_start_requires_empty" },
        { name: "selected_audit_events_terminal_requires_accepted" }
      ]);

      const csrfAccepted = {
        id: "audit:security:csrf:accepted",
        operation_id: "op_security_csrf_migration",
        at: "2026-07-11T20:02:00.000Z",
        actor: {
          type: "dashboard",
          device_id: "client_security_migration",
          permission: "read",
          origin: "https://hostdeck.local"
        },
        action: "csrf_bootstrap",
        target: { type: "device", device_id: "client_security_migration" },
        phase: "accepted",
        outcome: "accepted",
        payload_summary: { schema_version: 1, csrf_generation_before: 1 },
        error_code: null
      } as const;
      insertSelectedAuditRecord(migrated.db, csrfAccepted, 1);
      expect(
        migrated.db.prepare("SELECT action FROM selected_audit_events WHERE id = ?").get(csrfAccepted.id)
      ).toEqual({ action: "csrf_bootstrap" });
      expect(() =>
        insertSelectedAuditRecord(migrated.db, {
          ...csrfAccepted,
          id: "audit:security:csrf:missing-version",
          operation_id: "op_security_csrf_missing_version"
        })
      ).toThrow();
      expect(() =>
        migrated.db
          .prepare(
            "INSERT INTO selected_audit_events " +
              "(id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json) " +
              "VALUES (?, ?, ?, 'prompt', 1, 'terminal', 'rejected', 'validation_error', '{}')"
          )
          .run("audit:security:wrong-version-action", "op_security_wrong_version_action", csrfAccepted.at)
      ).toThrow();
      expect(() =>
        migrated.db
          .prepare(
            "INSERT INTO selected_audit_events " +
              "(id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json) " +
              "VALUES (?, ?, ?, 'lock', 3, 'terminal', 'rejected', 'validation_error', '{}')"
          )
          .run("audit:security:unknown-version", "op_security_unknown_version", csrfAccepted.at)
      ).toThrow();
      expect(() =>
        insertSelectedAuditRecord(
          migrated.db,
          { ...csrfAccepted, id: "audit:security:unknown", action: "unknown_action" },
          1
        )
      ).toThrow();
      expect(() =>
        migrated.db.prepare("UPDATE selected_audit_events SET outcome = 'succeeded' WHERE id = ?").run(csrfAccepted.id)
      ).toThrow("selected audit events are append-only");
      expect(() =>
        insertSelectedAuditRecord(
          migrated.db,
          {
            ...csrfAccepted,
            id: "audit:security:csrf:early-terminal",
            operation_id: "op_security_csrf_early",
            phase: "terminal",
            outcome: "succeeded"
          },
          1
        )
      ).toThrow("selected audit terminal requires accepted");
      const plan = migrated.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT operation_id FROM selected_audit_events WHERE phase = 'terminal' AND at < ? ORDER BY at, operation_id"
        )
        .all("2027-01-01T00:00:00.000Z") as Array<{ readonly detail: string }>;
      expect(plan.some(({ detail }) => detail.includes("selected_audit_events_phase_at_operation_idx"))).toBe(true);
    } finally {
      migrated.db.close();
    }

    const rollbackPath = tempDbPath();
    const rollback = openMigratedDatabase(rollbackPath, {
      migrations: migrationsThrough("202607110009_auth_device_csrf_rotation"),
      now: fixedNow
    });
    try {
      insertSelectedAuditRecord(rollback.db, accepted);
      const forcedFailure: StorageMigration = {
        version: "202607110012_forced_security_audit_failure",
        sql: "CREATE TABLE security_audit_failure_probe (id TEXT); SELECT * FROM missing_security_audit_table;"
      };
      expect(() =>
        runMigrations(rollback.db, { migrations: [...defaultMigrations, forcedFailure], now: fixedNow })
      ).toThrow(HostDeckMigrationError);
      expect(rollback.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 9 });
      const tableSql = rollback.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'selected_audit_events'")
        .get() as { readonly sql: string };
      expect(tableSql.sql).not.toContain("csrf_bootstrap");
      expect(tableSql.sql).not.toContain("security_schema_version");
      expect(rollback.db.prepare("SELECT * FROM selected_audit_events").all()).toHaveLength(1);
      expect(
        rollback.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_failure_probe'").get()
      ).toBeUndefined();
    } finally {
      rollback.db.close();
    }
  });

  it("adds selected pairing ownership and bounded rate state without inventing legacy owners", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607110010_security_audit_catalog"),
      now: fixedNow
    });
    const oldRows = [
      {
        id: "pair_migration_unused",
        code_hash: `sha256:${"1".repeat(64)}`,
        permission: "write",
        client_label: "old-phone",
        created_at: "2026-07-11T20:00:00.000Z",
        expires_at: "2026-07-11T20:05:00.000Z",
        used_at: null,
        revoked_at: null
      },
      {
        id: "pair_migration_used",
        code_hash: `sha256:${"2".repeat(64)}`,
        permission: "read",
        client_label: null,
        created_at: "2026-07-11T20:00:00.000Z",
        expires_at: "2026-07-11T20:05:00.000Z",
        used_at: "2026-07-11T20:01:00.000Z",
        revoked_at: null
      },
      {
        id: "pair_migration_revoked",
        code_hash: `sha256:${"3".repeat(64)}`,
        permission: "write",
        client_label: null,
        created_at: "2026-07-11T20:00:00.000Z",
        expires_at: "2026-07-11T20:05:00.000Z",
        used_at: null,
        revoked_at: "2026-07-11T20:02:00.000Z"
      }
    ] as const;
    for (const row of oldRows) {
      prior.db
        .prepare(
          `
            INSERT INTO pairing_codes (
              id, code_hash, permission, client_label, created_at, expires_at, used_at, revoked_at
            ) VALUES (
              @id, @code_hash, @permission, @client_label, @created_at, @expires_at, @used_at, @revoked_at
            )
          `
        )
        .run(row);
    }
    const rowsBefore = prior.db
      .prepare(
        "SELECT id, code_hash, permission, client_label, created_at, expires_at, used_at, revoked_at " +
          "FROM pairing_codes ORDER BY id"
      )
      .all();
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607110011_selected_pairing_claim",
        "202607120012_selected_lan_configuration",
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(
        migrated.db
          .prepare(
            "SELECT id, code_hash, permission, client_label, created_at, expires_at, used_at, revoked_at " +
              "FROM pairing_codes ORDER BY id"
          )
          .all()
      ).toEqual(rowsBefore);
      expect(
        migrated.db
          .prepare("SELECT DISTINCT claim_contract_version, claimed_device_id FROM pairing_codes")
          .all()
      ).toEqual([{ claim_contract_version: null, claimed_device_id: null }]);
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pairing_claim_rate_%' ORDER BY name")
          .all()
      ).toEqual([{ name: "pairing_claim_rate_global" }, { name: "pairing_claim_rate_sources" }]);
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pairing_claim_rate_sources_last_attempt_idx'")
          .get()
      ).toEqual({ name: "pairing_claim_rate_sources_last_attempt_idx" });

      insertMigrationAuthDevice(migrated.db, "client_pair_migration_owner");
      const selected = {
        id: "pair_migration_selected",
        code_hash: `sha256:${"4".repeat(64)}`,
        permission: "write",
        client_label: "selected-phone",
        created_at: "2026-07-11T20:00:00.000Z",
        expires_at: "2026-07-11T20:05:00.000Z",
        used_at: "2026-07-11T20:01:00.000Z",
        revoked_at: null,
        claim_contract_version: 1,
        claimed_device_id: "client_pair_migration_owner"
      } as const;
      insertMigrationPairingCode(migrated.db, selected);
      expect(() =>
        insertMigrationPairingCode(migrated.db, {
          ...selected,
          id: "pair_migration_missing_owner",
          code_hash: `sha256:${"5".repeat(64)}`,
          claimed_device_id: null
        })
      ).toThrow();
      expect(() =>
        insertMigrationPairingCode(migrated.db, {
          ...selected,
          id: "pair_migration_foreign_owner",
          code_hash: `sha256:${"6".repeat(64)}`,
          claimed_device_id: "client_pair_migration_missing"
        })
      ).toThrow();
      expect(() =>
        insertMigrationPairingCode(migrated.db, {
          ...selected,
          id: "pair_migration_duplicate_owner",
          code_hash: `sha256:${"7".repeat(64)}`
        })
      ).toThrow();
      for (const candidate of [
        {
          ...selected,
          id: "pair_migration_non_sha256",
          code_hash: `legacy:${"a".repeat(64)}`,
          used_at: null,
          claimed_device_id: null
        },
        {
          ...selected,
          id: "pair_migration_early_revoke",
          code_hash: `sha256:${"b".repeat(64)}`,
          used_at: null,
          revoked_at: "2026-07-11T19:59:59.999Z",
          claimed_device_id: null
        },
        {
          ...selected,
          id: "pair_migration_equal_expiry",
          code_hash: `sha256:${"c".repeat(64)}`,
          expires_at: selected.created_at,
          used_at: null,
          claimed_device_id: null
        },
        {
          ...selected,
          id: "pair_migration_unknown_provenance",
          code_hash: `sha256:${"d".repeat(64)}`,
          used_at: null,
          claim_contract_version: 2,
          claimed_device_id: null
        }
      ]) {
        expect(() => insertMigrationPairingCode(migrated.db, candidate)).toThrow();
      }

      const sourceKey = `sha256:${"a".repeat(64)}`;
      migrated.db
        .prepare(
          "INSERT INTO pairing_claim_rate_sources " +
            "(source_key, window_started_at, attempt_count, last_attempt_at) VALUES (?, ?, 1, ?)"
        )
        .run(sourceKey, "2026-07-11T20:00:00.000Z", "2026-07-11T20:01:00.000Z");
      migrated.db
        .prepare(
          "INSERT INTO pairing_claim_rate_global " +
            "(id, window_started_at, attempt_count, last_attempt_at) VALUES ('pair_claim_global', ?, 1, ?)"
        )
        .run("2026-07-11T20:00:00.000Z", "2026-07-11T20:01:00.000Z");
      for (const invalidSource of ["sha256:short", `sha256:${"A".repeat(64)}`]) {
        expect(() =>
          migrated.db
            .prepare(
              "INSERT INTO pairing_claim_rate_sources " +
                "(source_key, window_started_at, attempt_count, last_attempt_at) VALUES (?, ?, 1, ?)"
            )
            .run(invalidSource, "2026-07-11T20:00:00.000Z", "2026-07-11T20:01:00.000Z")
        ).toThrow();
      }
      expect(() =>
        migrated.db
          .prepare("UPDATE pairing_claim_rate_sources SET attempt_count = 0 WHERE source_key = ?")
          .run(sourceKey)
      ).toThrow();
      expect(() =>
        migrated.db
          .prepare("UPDATE pairing_claim_rate_global SET id = 'other' WHERE id = 'pair_claim_global'")
          .run()
      ).toThrow();
      expect(() =>
        migrated.db
          .prepare("UPDATE pairing_claim_rate_sources SET last_attempt_at = ? WHERE source_key = ?")
          .run("2026-07-11T19:59:59.999Z", sourceKey)
      ).toThrow();
      expect(() =>
        migrated.db
          .prepare("UPDATE pairing_claim_rate_global SET attempt_count = ? WHERE id = 'pair_claim_global'")
          .run(Number.MAX_SAFE_INTEGER + 1)
      ).toThrow();
      const plan = migrated.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT source_key FROM pairing_claim_rate_sources " +
            "WHERE last_attempt_at <= ? ORDER BY last_attempt_at, source_key LIMIT ?"
        )
        .all("2027-01-01T00:00:00.000Z", 64) as Array<{ readonly detail: string }>;
      expect(plan.some(({ detail }) => detail.includes("pairing_claim_rate_sources_last_attempt_idx"))).toBe(true);
    } finally {
      migrated.db.close();
    }

    const rollbackPath = tempDbPath();
    const rollback = openMigratedDatabase(rollbackPath, {
      migrations: migrationsThrough("202607110010_security_audit_catalog"),
      now: fixedNow
    });
    try {
      rollback.db
        .prepare(
          "INSERT INTO pairing_codes " +
            "(id, code_hash, permission, client_label, created_at, expires_at, used_at, revoked_at) " +
            "VALUES ('pair_rollback_preserved', ?, 'write', NULL, ?, ?, NULL, NULL)"
        )
        .run(`sha256:${"8".repeat(64)}`, "2026-07-11T20:00:00.000Z", "2026-07-11T20:05:00.000Z");
      const forcedFailure: StorageMigration = {
        version: "202607110012_forced_pairing_claim_failure",
        sql: "CREATE TABLE pairing_claim_failure_probe (id TEXT); SELECT * FROM missing_pairing_claim_table;"
      };
      expect(() =>
        runMigrations(rollback.db, { migrations: [...defaultMigrations, forcedFailure], now: fixedNow })
      ).toThrow(HostDeckMigrationError);
      expect(rollback.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 10 });
      const tableSql = rollback.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pairing_codes'")
        .get() as { readonly sql: string };
      expect(tableSql.sql).not.toContain("claim_contract_version");
      expect(rollback.db.prepare("SELECT id FROM pairing_codes").all()).toEqual([{ id: "pair_rollback_preserved" }]);
      expect(tableNames(rollback.db)).not.toContain("pairing_claim_rate_sources");
      expect(tableNames(rollback.db)).not.toContain("pairing_claim_failure_probe");
    } finally {
      rollback.db.close();
    }
  });

  it("marks prior tmux sessions as legacy without creating selected mappings", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607080005_pairing_code_revoked_at"),
      now: fixedNow
    });

    prior.db
      .prepare(
        `
          INSERT INTO sessions (
            id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
            lifecycle_state, created_at, updated_at, stale_reason
          ) VALUES (?, ?, ?, 'tmux', ?, NULL, ?, 'running', ?, ?, NULL)
        `
      )
      .run(
        "sess_legacy_001",
        "legacy-session",
        "/home/simonli/work/legacy",
        "hostdeck-legacy-session",
        "%1",
        fixedNow().toISOString(),
        fixedNow().toISOString()
      );
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607090006_selected_runtime_state",
        "202607100007_selected_audit_state",
        "202607100008_selected_retention_indexes",
        "202607110009_auth_device_csrf_rotation",
        "202607110010_security_audit_catalog",
        "202607110011_selected_pairing_claim",
        "202607120012_selected_lan_configuration",
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof",
        "202607150016_session_start_audit_catalog",
        "202607160017_selected_session_settings_projection"
      ]);
      expect(migrated.db.prepare("SELECT COUNT(*) AS count FROM selected_sessions").get()).toEqual({ count: 0 });
      expect(migrated.db.prepare("SELECT * FROM legacy_session_dispositions").get()).toMatchObject({
        id: "sess_legacy_001",
        name: "legacy-session",
        disposition: "legacy_unmigrated"
      });
      migrated.db
        .prepare(
          `
            INSERT INTO sessions (
              id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
              lifecycle_state, created_at, updated_at, stale_reason
            ) VALUES (?, ?, ?, 'tmux', ?, NULL, ?, 'running', ?, ?, NULL)
          `
        )
        .run(
          "sess_legacy_002",
          "legacy-after-migration",
          "/home/simonli/work/legacy-two",
          "hostdeck-legacy-two",
          "%2",
          fixedNow().toISOString(),
          fixedNow().toISOString()
        );
      expect(migrated.db.prepare("SELECT disposition FROM legacy_session_dispositions WHERE id = 'sess_legacy_002'").get()).toEqual({
        disposition: "legacy_unmigrated"
      });
    } finally {
      migrated.db.close();
    }
  });

  it("rolls back selected-state migration when a prior legacy row cannot be classified safely", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: migrationsThrough("202607080005_pairing_code_revoked_at"),
      now: fixedNow
    });
    prior.db
      .prepare(
        `
          INSERT INTO sessions (
            id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
            lifecycle_state, created_at, updated_at, stale_reason
          ) VALUES (?, ?, ?, 'tmux', ?, NULL, ?, 'running', ?, ?, NULL)
        `
      )
      .run(
        "sess_legacy_bad",
        "legacy-bad",
        "relative/path",
        "hostdeck-legacy-bad",
        "%3",
        fixedNow().toISOString(),
        fixedNow().toISOString()
      );
    prior.db.close();

    expect(() => openMigratedDatabase(path, { now: fixedNow })).toThrow(HostDeckMigrationError);
    const inspected = new Database(path);
    try {
      expect(tableNames(inspected)).not.toContain("selected_sessions");
      expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 5 });
    } finally {
      inspected.close();
    }
  });

  it("applies pending migrations without rerunning applied migrations", () => {
    const path = tempDbPath();
    const firstMigration = {
      version: "202607080001_first",
      sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);"
    } satisfies StorageMigration;
    const secondMigration = {
      version: "202607080002_second",
      sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY);"
    } satisfies StorageMigration;

    const firstOpen = openMigratedDatabase(path, {
      migrations: [firstMigration],
      now: fixedNow
    });
    firstOpen.db.close();

    const secondOpen = openMigratedDatabase(path, {
      migrations: [firstMigration, secondMigration],
      now: fixedNow
    });

    try {
      expect(secondOpen.result.applied).toEqual(["202607080002_second"]);
      expect(tableNames(secondOpen.db)).toEqual(["first_table", "schema_migrations", "second_table"]);
    } finally {
      secondOpen.db.close();
    }
  });

  it("rolls back a failed pending migration", () => {
    const path = tempDbPath();
    const db = new Database(path);
    const migrations = [
      {
        version: "202607080001_ok",
        sql: "CREATE TABLE ok_table (id TEXT PRIMARY KEY);"
      },
      {
        version: "202607080002_bad",
        sql: "CREATE TABLE broken (id TEXT PRIMARY KEY"
      }
    ] satisfies readonly StorageMigration[];

    try {
      expect(() => runMigrations(db, { migrations, now: fixedNow })).toThrow(HostDeckMigrationError);
      expect(tableNames(db)).toEqual(["schema_migrations"]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects unknown applied migrations", () => {
    const path = tempDbPath();
    const db = new Database(path);

    try {
      db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);");
      db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)").run(
        "209901010000_future",
        "sha256:unknown",
        fixedNow().toISOString()
      );

      expect(() => runMigrations(db, { migrations: defaultMigrations, now: fixedNow })).toThrow(HostDeckMigrationError);
    } finally {
      db.close();
    }
  });

  it("rejects untracked schema without migration history", () => {
    const path = tempDbPath();
    const db = new Database(path);

    try {
      db.exec("CREATE TABLE unmanaged_table (id TEXT PRIMARY KEY);");

      expect(() => runMigrations(db, { migrations: defaultMigrations, now: fixedNow })).toThrow(HostDeckMigrationError);
    } finally {
      db.close();
    }
  });

  it("rejects corrupt database files", () => {
    const path = tempDbPath();
    writeFileSync(path, "not a sqlite database");

    expect(() => openMigratedDatabase(path, { now: fixedNow })).toThrow(HostDeckMigrationError);
  });
});

function migrationsThrough(version: string): readonly StorageMigration[] {
  const index = defaultMigrations.findIndex((migration) => migration.version === version);
  if (index < 0) throw new Error(`Unknown migration boundary ${version}.`);
  return defaultMigrations.slice(0, index + 1);
}

function insertSelectedAuditRecord(
  db: Database.Database,
  record: Readonly<Record<string, unknown>>,
  securitySchemaVersion?: 1
): void {
  if (securitySchemaVersion === undefined) {
    db.prepare(
      `
        INSERT INTO selected_audit_events (
          id, operation_id, at, action, phase, outcome, error_code, record_json
        ) VALUES (
          @id, @operation_id, @at, @action, @phase, @outcome, @error_code, @record_json
        )
      `
    ).run({ ...record, record_json: JSON.stringify(record) });
    return;
  }
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

function insertMigrationAuthDevice(db: Database.Database, id: string): void {
  db.prepare(
    `
      INSERT INTO auth_devices (
        id, token_hash, csrf_token_hash, csrf_generation, csrf_rotated_at,
        client_label, permission, created_at, last_used_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, 1, ?, NULL, 'write', ?, NULL, NULL, NULL)
    `
  ).run(
    id,
    `sha256:${"9".repeat(64)}`,
    `sha256:${"0".repeat(64)}`,
    "2026-07-11T20:00:00.000Z",
    "2026-07-11T20:00:00.000Z"
  );
}

function insertMigrationPairingCode(db: Database.Database, row: Readonly<Record<string, unknown>>): void {
  db.prepare(
    `
      INSERT INTO pairing_codes (
        id, code_hash, permission, client_label, created_at, expires_at,
        used_at, revoked_at, claim_contract_version, claimed_device_id
      ) VALUES (
        @id, @code_hash, @permission, @client_label, @created_at, @expires_at,
        @used_at, @revoked_at, @claim_contract_version, @claimed_device_id
      )
    `
  ).run(row);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-storage-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ readonly name: string }>;

  return rows.map((row) => row.name);
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}
