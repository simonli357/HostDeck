import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckDatabaseBackup,
  HostDeckDatabaseRecoveryError,
  restoreHostDeckDatabaseBackup
} from "./database-recovery.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { defaultMigrations } from "./migrations.js";

const cleanup: string[] = [];
const priorMigrations = defaultMigrations.slice(0, -1);
const at = "2026-08-11T12:00:00.000Z";

afterEach(() => {
  for (const root of cleanup.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("HostDeck database backup and restore", () => {
  it("publishes a validated snapshot and restores selected user state", async () => {
    const layout = createLayout();
    const live = openMigratedDatabase(layout.database, { now: fixedNow });
    insertSelectedSession(live.db, "sess_backup_01", "before-backup");

    const backup = await createHostDeckDatabaseBackup({
      database: live.db,
      destination_path: layout.backup
    });
    expect(backup).toMatchObject({
      migration: {
        applied: [],
        currentVersion: defaultMigrations.at(-1)?.version
      }
    });
    expect(backup.page_count).toBeGreaterThan(0);
    expect(existsSync(layout.backup)).toBe(true);
    expect(sqliteFiles(layout.root)).toEqual(["hostdeck-backup.sqlite", "hostdeck.sqlite"]);
    const backupIdentity = sha256(layout.backup);
    const alias = join(layout.root, "backup-alias.sqlite");
    linkSync(layout.backup, alias);
    await expect(
      restoreHostDeckDatabaseBackup({
        backup_path: layout.backup,
        database_path: layout.database
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    rmSync(alias);

    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: layout.backup
      })
    ).rejects.toMatchObject({ code: "destination_exists" });
    live.db
      .prepare("UPDATE selected_sessions SET name = ? WHERE id = ?")
      .run("after-backup", "sess_backup_01");
    live.db.close();

    const restored = await restoreHostDeckDatabaseBackup({
      backup_path: layout.backup,
      database_path: layout.database
    });
    expect(restored.page_count).toBeGreaterThan(0);
    expect(sha256(layout.backup)).toBe(backupIdentity);
    const reopened = openMigratedDatabase(layout.database, { now: fixedNow });
    try {
      expect(
        reopened.db
          .prepare("SELECT name, cwd FROM selected_sessions WHERE id = ?")
          .get("sess_backup_01")
      ).toEqual({ name: "before-backup", cwd: nativeCwd() });
      expect(reopened.db.pragma("quick_check")).toEqual([
        { quick_check: "ok" }
      ]);
      expect(reopened.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      reopened.db.close();
    }
  });

  it("rejects ambiguous inputs and removes aborted or invalid partial output", async () => {
    const layout = createLayout();
    const live = openMigratedDatabase(layout.database, { now: fixedNow });
    const abort = new AbortController();
    abort.abort();

    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: join(layout.root, "aborted.sqlite"),
        signal: abort.signal
      })
    ).rejects.toMatchObject({ code: "aborted" });
    expect(existsSync(join(layout.root, "aborted.sqlite"))).toBe(false);
    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: layout.database
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: "relative.sqlite"
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    live.db.close();
    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: layout.backup
      })
    ).rejects.toMatchObject({ code: "source_closed" });

    const destinationIdentity = sha256(layout.database);
    writeFileSync(layout.backup, "not sqlite", { mode: 0o600 });
    await expect(
      restoreHostDeckDatabaseBackup({
        backup_path: layout.backup,
        database_path: layout.database
      })
    ).rejects.toBeInstanceOf(HostDeckDatabaseRecoveryError);
    expect(sha256(layout.database)).toBe(destinationIdentity);
    rmSync(layout.backup);
    const invalid = openMigratedDatabase(layout.backup, { now: fixedNow });
    invalid.db.pragma("foreign_keys = OFF");
    invalid.db
      .prepare(
        `
          INSERT INTO output_events (
            session_id, cursor, event_order, captured_at, kind, payload,
            truncated_before
          ) VALUES ('missing-parent', 1, 1, ?, 'output', 'invalid', NULL)
        `
      )
      .run(at);
    invalid.db.close();
    await expect(
      restoreHostDeckDatabaseBackup({
        backup_path: layout.backup,
        database_path: layout.database
      })
    ).rejects.toMatchObject({ code: "backup_invalid" });
    rmSync(layout.backup);
    expect(existsSync(layout.backup)).toBe(false);
    expect(
      sqliteFiles(layout.root).filter((name) => name.includes("partial"))
    ).toEqual([]);
  });

  it("restores a retained prior release and permits a lossless re-upgrade", async () => {
    const layout = createLayout();
    const prior = openMigratedDatabase(layout.database, {
      migrations: priorMigrations,
      now: fixedNow
    });
    insertSelectedSession(prior.db, "sess_retained_01", "retained-user-state");
    await createHostDeckDatabaseBackup({
      database: prior.db,
      destination_path: layout.backup,
      migrations: priorMigrations
    });
    prior.db.close();

    const upgraded = openMigratedDatabase(layout.database, { now: fixedNow });
    expect(upgraded.result.applied).toEqual([
      defaultMigrations.at(-1)?.version
    ]);
    insertSelectedSession(upgraded.db, "sess_new_release_01", "new-release-state");
    upgraded.db.close();

    await restoreHostDeckDatabaseBackup({
      backup_path: layout.backup,
      database_path: layout.database,
      migrations: priorMigrations
    });
    const retained = openMigratedDatabase(layout.database, {
      migrations: priorMigrations,
      now: fixedNow
    });
    expect(
      retained.db.prepare("SELECT id, name FROM selected_sessions ORDER BY id").all()
    ).toEqual([{ id: "sess_retained_01", name: "retained-user-state" }]);
    retained.db.close();

    const reupgraded = openMigratedDatabase(layout.database, { now: fixedNow });
    try {
      expect(reupgraded.result.applied).toEqual([
        defaultMigrations.at(-1)?.version
      ]);
      expect(
        reupgraded.db
          .prepare("SELECT id, name, cwd FROM selected_sessions ORDER BY id")
          .all()
      ).toEqual([
        {
          id: "sess_retained_01",
          name: "retained-user-state",
          cwd: nativeCwd()
        }
      ]);
      expect(reupgraded.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      reupgraded.db.close();
    }
  });
});

function insertSelectedSession(
  db: import("better-sqlite3").Database,
  id: string,
  name: string
): void {
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'codex_app_server', '0.144.0', 'selected', ?, ?, NULL)
    `
  ).run(id, name, `thread-${id}`, nativeCwd(), at, at);
}

function nativeCwd(): string {
  return process.platform === "win32"
    ? "C:\\Users\\selected\\HostDeck Project"
    : "/home/selected/HostDeck Project";
}

function createLayout(): {
  readonly backup: string;
  readonly database: string;
  readonly root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-database-recovery-"));
  cleanup.push(root);
  return {
    backup: join(root, "hostdeck-backup.sqlite"),
    database: join(root, "hostdeck.sqlite"),
    root
  };
}

function sqliteFiles(root: string): readonly string[] {
  return [
    "hostdeck-backup.sqlite",
    "hostdeck-backup.sqlite-journal",
    "hostdeck-backup.sqlite-shm",
    "hostdeck-backup.sqlite-wal",
    "hostdeck.sqlite",
    "hostdeck.sqlite-journal",
    "hostdeck.sqlite-shm",
    "hostdeck.sqlite-wal"
  ].filter((name) => existsSync(join(root, name)));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixedNow(): Date {
  return new Date(at);
}
