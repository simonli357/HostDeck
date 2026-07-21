import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthDeviceRepository } from "./auth-repository.js";
import {
  HostDeckMigrationError,
  openMigratedDatabase
} from "./migration-runner.js";
import { defaultMigrations } from "./migrations.js";
import { openExistingHostDeckReadOnlyDatabase } from "./read-only-database.js";
import { HostDeckLocalPathError } from "./secure-local-paths.js";
import { createDeviceListingRepository } from "./selected-device-listing-repository.js";

const tempDirs: string[] = [];
const fixedNow = new Date("2026-07-20T20:00:00.000Z");

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("existing HostDeck read-only database", () => {
  it("opens one exact current database read-only and closes idempotently", () => {
    const harness = createHarness();
    seedDevice(harness.databasePath, "client_readonly_open_001");
    const before = databaseSnapshot(harness.databasePath);

    const opened = openExistingHostDeckReadOnlyDatabase({
      state_dir: harness.stateDir,
      database_path: harness.databasePath
    });
    expect(Object.isFrozen(opened)).toBe(true);
    expect(opened.db.readonly).toBe(true);
    expect(opened.db.pragma("query_only", { simple: true })).toBe(1);
    expect(opened.db.pragma("temp_store", { simple: true })).toBe(2);
    expect(opened.db.pragma("trusted_schema", { simple: true })).toBe(0);
    expect(opened.migration).toEqual({
      applied: [],
      currentVersion: defaultMigrations.at(-1)?.version
    });
    expect(Object.isFrozen(opened.migration)).toBe(true);
    expect(Object.isFrozen(opened.migration.applied)).toBe(true);
    expect(
      createDeviceListingRepository(opened.db).list({
        limit: 1,
        afterDeviceId: null
      })
    ).toMatchObject({
      devices: [{ deviceId: "client_readonly_open_001" }],
      hasMore: false,
      nextAfterDeviceId: null
    });
    expect(() =>
      opened.db.prepare("DELETE FROM auth_devices").run()
    ).toThrow(/readonly|read-only/iu);
    opened.verifyPath();
    opened.close();
    opened.close();

    expect(databaseSnapshot(harness.databasePath)).toEqual(before);
    expect(lstatSync(harness.stateDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(harness.databasePath).mode & 0o7777).toBe(0o600);
  });

  it("rejects missing paths without creating or repairing state", () => {
    const root = tempRoot();
    const missingState = join(root, "missing-state");
    const missingDatabase = join(missingState, "hostdeck.sqlite");
    expect(() =>
      openExistingHostDeckReadOnlyDatabase({
        state_dir: missingState,
        database_path: missingDatabase
      })
    ).toThrow(HostDeckLocalPathError);
    expect(existsSync(missingState)).toBe(false);

    const stateDir = join(root, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const databasePath = join(stateDir, "hostdeck.sqlite");
    expect(() =>
      openExistingHostDeckReadOnlyDatabase({
        state_dir: stateDir,
        database_path: databasePath
      })
    ).toThrow(HostDeckLocalPathError);
    expect(existsSync(databasePath)).toBe(false);

    chmodSync(stateDir, 0o750);
    expect(() =>
      openExistingHostDeckReadOnlyDatabase({
        state_dir: stateDir,
        database_path: databasePath
      })
    ).toThrow(HostDeckLocalPathError);
    expect(lstatSync(stateDir).mode & 0o7777).toBe(0o750);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("rejects insecure file and nested-parent modes without repairing either", () => {
    const harness = createHarness("nested");
    chmodSync(harness.databasePath, 0o640);
    expect(() => openHarness(harness)).toThrow(HostDeckLocalPathError);
    expect(lstatSync(harness.databasePath).mode & 0o7777).toBe(0o640);

    chmodSync(harness.databasePath, 0o600);
    chmodSync(harness.databaseDir, 0o750);
    expect(() => openHarness(harness)).toThrow(HostDeckLocalPathError);
    expect(lstatSync(harness.databaseDir).mode & 0o7777).toBe(0o750);
  });

  it("rejects hard links and hostile input before opening SQLite", () => {
    const harness = createHarness();
    const linked = join(harness.stateDir, "linked.sqlite");
    linkSync(harness.databasePath, linked);
    expect(() => openHarness(harness)).toThrowError(
      expect.objectContaining({ code: "hard_link_rejected" })
    );

    let accessorCalls = 0;
    const hostile = Object.defineProperty(
      { database_path: harness.databasePath },
      "state_dir",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return harness.stateDir;
        }
      }
    );
    expect(() =>
      openExistingHostDeckReadOnlyDatabase(hostile as never)
    ).toThrow(TypeError);
    expect(accessorCalls).toBe(0);
  });

  it("rejects stale, checksum-mismatched, and corrupt databases without migration", () => {
    const stale = createHarness(undefined, defaultMigrations.slice(0, -1));
    const staleBefore = databaseSnapshot(stale.databasePath);
    expect(() => openHarness(stale)).toThrowError(
      expect.objectContaining({ code: "schema_not_current" })
    );
    expect(databaseSnapshot(stale.databasePath)).toEqual(staleBefore);

    const checksum = createHarness();
    const writable = openMigratedDatabase(checksum.databasePath);
    try {
      writable.db
        .prepare(
          "UPDATE schema_migrations SET checksum = ? WHERE version = ?"
        )
        .run("0".repeat(64), defaultMigrations.at(-1)?.version);
    } finally {
      writable.db.close();
      chmodSync(checksum.databasePath, 0o600);
    }
    expect(() => openHarness(checksum)).toThrowError(
      expect.objectContaining({ code: "migration_checksum_mismatch" })
    );

    const corruptRoot = tempRoot();
    const corruptPath = join(corruptRoot, "hostdeck.sqlite");
    writeFileSync(corruptPath, "not a sqlite database", { mode: 0o600 });
    expect(() =>
      openExistingHostDeckReadOnlyDatabase({
        state_dir: corruptRoot,
        database_path: corruptPath
      })
    ).toThrow(HostDeckMigrationError);
  });

  it("detects database substitution while retaining and closing the guarded inode", () => {
    const harness = createHarness();
    const opened = openHarness(harness);
    const retainedPath = join(harness.stateDir, "retained.sqlite");
    renameSync(harness.databasePath, retainedPath);
    createDatabase(harness.databasePath);

    expect(() => opened.verifyPath()).toThrowError(
      expect.objectContaining({ code: "path_substitution" })
    );
    expect(() => opened.close()).toThrowError(
      expect.objectContaining({ code: "path_substitution" })
    );
    expect(() => opened.close()).not.toThrow();
  });

  it("rejects WAL format without sidecars before a read can create them", () => {
    const harness = createHarness();
    const writer = openMigratedDatabase(harness.databasePath);
    writer.db.pragma("journal_mode = WAL");
    writer.db.close();
    chmodSync(harness.databasePath, 0o600);
    expect(readdirSync(harness.stateDir).sort()).toEqual(["hostdeck.sqlite"]);

    expect(() => openHarness(harness)).toThrow(HostDeckLocalPathError);
    expect(readdirSync(harness.stateDir).sort()).toEqual(["hostdeck.sqlite"]);
  });

  it("reads current WAL state while a writer remains open", () => {
    const harness = createHarness();
    const writer = openMigratedDatabase(harness.databasePath);
    writer.db.pragma("journal_mode = WAL");
    writer.db.pragma("wal_autocheckpoint = 0");
    const auth = createAuthDeviceRepository(writer.db);
    auth.create({
      id: "client_readonly_wal_001",
      rawDeviceToken: `device-token:${"D".repeat(32)}`,
      rawCsrfToken: `csrf-token:${"C".repeat(32)}`,
      permission: "write",
      clientLabel: "Xiaomi 15 Pro",
      createdAt: fixedNow
    });
    const revokedAt = "2026-07-20T20:01:00.000Z";
    writer.db.exec("BEGIN IMMEDIATE");
    writer.db
      .prepare("UPDATE auth_devices SET revoked_at = ? WHERE id = ?")
      .run(revokedAt, "client_readonly_wal_001");
    chmodSync(harness.databasePath, 0o600);
    const beforeFiles = readdirSync(harness.stateDir).sort();
    expect(beforeFiles).toEqual([
      "hostdeck.sqlite",
      "hostdeck.sqlite-shm",
      "hostdeck.sqlite-wal"
    ]);
    for (const file of beforeFiles) {
      expect(lstatSync(join(harness.stateDir, file)).mode & 0o7777).toBe(0o600);
    }

    const opened = openHarness(harness);
    try {
      expect(
        createDeviceListingRepository(opened.db).list({
          limit: 10,
          afterDeviceId: null
        })
      ).toMatchObject({
        devices: [
          { deviceId: "client_readonly_wal_001", revokedAt: null }
        ]
      });
      expect(writer.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()).toEqual({
        count: 1
      });
    } finally {
      opened.close();
      expect(readdirSync(harness.stateDir).sort()).toEqual(beforeFiles);
    }
    writer.db.exec("COMMIT");
    const afterCommit = openHarness(harness);
    try {
      expect(
        createDeviceListingRepository(afterCommit.db).list({
          limit: 10,
          afterDeviceId: null
        })
      ).toMatchObject({
        devices: [
          { deviceId: "client_readonly_wal_001", revokedAt }
        ]
      });
    } finally {
      afterCommit.close();
      writer.db.close();
    }
  });
});

interface Harness {
  readonly stateDir: string;
  readonly databaseDir: string;
  readonly databasePath: string;
}

function createHarness(
  nested?: "nested",
  migrations = defaultMigrations
): Harness {
  const stateDir = tempRoot();
  const databaseDir =
    nested === undefined ? stateDir : join(stateDir, "database");
  if (nested !== undefined) mkdirSync(databaseDir, { mode: 0o700 });
  const databasePath = join(databaseDir, "hostdeck.sqlite");
  createDatabase(databasePath, migrations);
  return { stateDir, databaseDir, databasePath };
}

function createDatabase(
  databasePath: string,
  migrations = defaultMigrations
): void {
  const opened = openMigratedDatabase(databasePath, {
    migrations,
    now: () => fixedNow
  });
  opened.db.close();
  chmodSync(databasePath, 0o600);
}

function openHarness(harness: Harness) {
  return openExistingHostDeckReadOnlyDatabase({
    state_dir: harness.stateDir,
    database_path: harness.databasePath
  });
}

function seedDevice(databasePath: string, id: string): void {
  const opened = openMigratedDatabase(databasePath);
  try {
    createAuthDeviceRepository(opened.db).create({
      id,
      rawDeviceToken: `device-token:${id}:${"D".repeat(24)}`,
      rawCsrfToken: `csrf-token:${id}:${"C".repeat(24)}`,
      permission: "read",
      clientLabel: "Android read-only fixture",
      createdAt: fixedNow
    });
  } finally {
    opened.db.close();
    chmodSync(databasePath, 0o600);
  }
}

function databaseSnapshot(databasePath: string) {
  const db = new Database(databasePath, { fileMustExist: true, readonly: true });
  try {
    return {
      migrations: db
        .prepare(
          "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version ASC"
        )
        .all(),
      devices: db.prepare("SELECT * FROM auth_devices ORDER BY id ASC").all()
    };
  } finally {
    db.close();
  }
}

function tempRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-readonly-db-"));
  tempDirs.push(directory);
  return directory;
}
