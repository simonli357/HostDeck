import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HostDeckMigrationError, openMigratedDatabase, runMigrations } from "./migration-runner.js";
import { defaultMigrations, type StorageMigration } from "./migrations.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("SQLite migration runner", () => {
  it("preserves the checksums of every migration published before selected runtime state", () => {
    expect(
      Object.fromEntries(
        defaultMigrations.slice(0, -1).map((migration) => [
          migration.version,
          createHash("sha256").update(migration.sql).digest("hex")
        ])
      )
    ).toEqual({
      "202607080001_base_schema": "5947edef9a1b7f5813506a74073def0591ae1496bad0fdfa6a642dc7847e1b3b",
      "202607080002_session_metadata_failed_status": "7329f746d832c3ed4893a724572dd498e0e072860425ddc8d9278fa23e248b08",
      "202607080003_auth_device_csrf_hash": "0a4ad8c4692806e0bde02856f1d8a7b21ec2fe1426a8941e5b07ecb5d65f37d2",
      "202607080004_retention_boundary_scope_checks": "1a22e20b6c6679a2045469f0447c0b6e014ca72b95635a65c45cdbe6cafe8adf",
      "202607080005_pairing_code_revoked_at": "43a464010577c15677426c81a530328f2d76425d29eaa8d2d5446e737392aa70"
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
        "202607090006_selected_runtime_state"
      ]);
      expect(tableNames(db)).toEqual([
        "audit_events",
        "auth_devices",
        "legacy_session_dispositions",
        "output_events",
        "pairing_codes",
        "retention_boundaries",
        "schema_migrations",
        "selected_projected_events",
        "selected_runtime_compatibility",
        "selected_session_projections",
        "selected_session_start_recovery",
        "selected_sessions",
        "session_metadata",
        "sessions",
        "settings"
      ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
    } finally {
      db.close();
    }
  });

  it("marks prior tmux sessions as legacy without creating selected mappings", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: defaultMigrations.slice(0, -1),
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
      expect(migrated.result.applied).toEqual(["202607090006_selected_runtime_state"]);
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
      migrations: defaultMigrations.slice(0, -1),
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
