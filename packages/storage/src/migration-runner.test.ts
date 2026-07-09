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
        "202607080004_retention_boundary_scope_checks"
      ]);
      expect(tableNames(db)).toEqual([
        "audit_events",
        "auth_devices",
        "output_events",
        "pairing_codes",
        "retention_boundaries",
        "schema_migrations",
        "session_metadata",
        "sessions",
        "settings"
      ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 4 });
    } finally {
      db.close();
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
