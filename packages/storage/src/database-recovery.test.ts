import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHostDeckDaemonLease,
  type HostDeckDaemonLease
} from "./daemon-lease.js";
import {
  createHostDeckDatabaseBackup,
  HostDeckDatabaseRecoveryError,
  restoreHostDeckDatabaseBackup
} from "./database-recovery.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { defaultMigrations } from "./migrations.js";
import {
  prepareHostDeckStatePaths,
  resolveNativeWindowsHostDeckDefaultPaths
} from "./secure-local-paths.js";

const cleanup: string[] = [];
const leases: HostDeckDaemonLease[] = [];
const priorMigrations = defaultMigrations.slice(0, -1);
const at = "2026-08-11T12:00:00.000Z";

afterEach(() => {
  for (const lease of leases.splice(0).reverse()) {
    lease.release();
  }
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
      destination_path: layout.backup,
      ...recoveryAuthority(layout)
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
        database_path: layout.database,
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "state_insecure" });
    rmSync(alias);

    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: layout.backup,
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "destination_exists" });
    live.db
      .prepare("UPDATE selected_sessions SET name = ? WHERE id = ?")
      .run("after-backup", "sess_backup_01");
    live.db.close();

    const restored = await restoreHostDeckDatabaseBackup({
      backup_path: layout.backup,
      database_path: layout.database,
      ...recoveryAuthority(layout)
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
        signal: abort.signal,
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "aborted" });
    expect(existsSync(join(layout.root, "aborted.sqlite"))).toBe(false);
    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: layout.database,
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: "relative.sqlite",
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    live.db.close();
    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: layout.backup,
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "source_closed" });

    const destinationIdentity = sha256(layout.database);
    writeFileSync(layout.backup, "not sqlite", { mode: 0o600 });
    await expect(
      restoreHostDeckDatabaseBackup({
        backup_path: layout.backup,
        database_path: layout.database,
        ...recoveryAuthority(layout)
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
    prepareHostDeckStatePaths({
      state_dir: layout.root,
      database_path: layout.backup
    });
    await expect(
      restoreHostDeckDatabaseBackup({
        backup_path: layout.backup,
        database_path: layout.database,
        ...recoveryAuthority(layout)
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
    insertSelectedSession(
      prior.db,
      "sess_retained_01",
      "retained-user-state",
      legacyCwd
    );
    await createHostDeckDatabaseBackup({
      database: prior.db,
      destination_path: layout.backup,
      migrations: priorMigrations,
      ...recoveryAuthority(layout)
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
      migrations: priorMigrations,
      ...recoveryAuthority(layout)
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
          cwd: legacyCwd
        }
      ]);
      expect(reupgraded.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      reupgraded.db.close();
    }
  });

  it("rejects fake, mismatched, released, insecure, and invalid recovery authority before output", async () => {
    const layout = createLayout();
    const other = createLayout();
    const live = openMigratedDatabase(layout.database, { now: fixedNow });
    const fakeLease = { ...layout.lease } as HostDeckDaemonLease;
    const fakeDestination = join(layout.root, "fake.sqlite");

    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: fakeDestination,
        lease: fakeLease,
        state_dir: layout.root
      })
    ).rejects.toMatchObject({ code: "authority_invalid" });
    expect(existsSync(fakeDestination)).toBe(false);

    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: fakeDestination,
        lease: other.lease,
        state_dir: layout.root
      })
    ).rejects.toMatchObject({ code: "authority_invalid" });
    expect(existsSync(fakeDestination)).toBe(false);

    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: fakeDestination,
        lease: layout.lease,
        migrations: [{ version: "private_invalid_version", sql: "SELECT 1;" }],
        state_dir: layout.root
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(existsSync(fakeDestination)).toBe(false);

    if (process.platform === "linux") {
      chmodSync(layout.database, 0o640);
      await expect(
        createHostDeckDatabaseBackup({
          database: live.db,
          destination_path: fakeDestination,
          ...recoveryAuthority(layout)
        })
      ).rejects.toMatchObject({ code: "state_insecure" });
      expect(existsSync(fakeDestination)).toBe(false);
      prepareHostDeckStatePaths({
        state_dir: layout.root,
        database_path: layout.database
      });
    }

    layout.lease.release();
    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: fakeDestination,
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "authority_invalid" });
    expect(existsSync(fakeDestination)).toBe(false);
    live.db.close();
  });

  it("fails and cleans partial output when lease authority is released during transfer", async () => {
    const layout = createLayout();
    const live = openMigratedDatabase(layout.database, { now: fixedNow });
    const destination = join(layout.root, "released-during-transfer.sqlite");
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        if (reads === 2) layout.lease.release();
        return false;
      }
    } as AbortSignal;

    await expect(
      createHostDeckDatabaseBackup({
        database: live.db,
        destination_path: destination,
        signal,
        ...recoveryAuthority(layout)
      })
    ).rejects.toMatchObject({ code: "authority_invalid" });
    expect(existsSync(destination)).toBe(false);
    expect(
      readdirSync(layout.root).filter((name) => name.includes(".partial-"))
    ).toEqual([]);
    live.db.close();
  });
});

function insertSelectedSession(
  db: import("better-sqlite3").Database,
  id: string,
  name: string,
  cwd = nativeCwd()
): void {
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'codex_app_server', '0.144.0', 'selected', ?, ?, NULL)
    `
  ).run(id, name, `thread-${id}`, cwd, at, at);
}

const legacyCwd = "/home/selected/HostDeck Project";

function nativeCwd(): string {
  return process.platform === "win32"
    ? "C:\\Users\\selected\\HostDeck Project"
    : "/home/selected/HostDeck Project";
}

function createLayout(): {
  readonly backup: string;
  readonly database: string;
  readonly lease: HostDeckDaemonLease;
  readonly root: string;
} {
  const root =
    process.platform === "win32"
      ? join(
          resolveNativeWindowsHostDeckDefaultPaths().state_dir,
          "Tests",
          `database-recovery-${randomUUID()}`
        )
      : mkdtempSync(join(tmpdir(), "hostdeck-database-recovery-"));
  cleanup.push(root);
  const database = join(root, "hostdeck.sqlite");
  prepareHostDeckStatePaths({ state_dir: root, database_path: database });
  const lease = acquireHostDeckDaemonLease({
    lease_path: join(root, "hostdeck.lock"),
    now: fixedNow
  });
  leases.push(lease);
  return { backup: join(root, "hostdeck-backup.sqlite"), database, lease, root };
}

function recoveryAuthority(layout: {
  readonly lease: HostDeckDaemonLease;
  readonly root: string;
}): { readonly lease: HostDeckDaemonLease; readonly state_dir: string } {
  return { lease: layout.lease, state_dir: layout.root };
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
