import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
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
  restoreHostDeckDatabaseBackup
} from "./database-recovery.js";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  nativeHostDeckLocalPathAdapter,
  openSecureHostDeckRegularFile,
  prepareHostDeckStatePaths,
  resolveNativeWindowsHostDeckDefaultPaths
} from "./secure-local-paths.js";
import { nativeWindowsFileSecurityPort } from "./windows-native-file-security.js";

const cleanup: string[] = [];
const leases: HostDeckDaemonLease[] = [];
const at = "2026-08-11T12:00:00.000Z";

afterEach(() => {
  for (const lease of leases.splice(0).reverse()) lease.release();
  for (const root of cleanup.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("native state hardening", () => {
  it("enforces native authority, security, tamper, repair, restore, and residue boundaries", async () => {
    expect(["linux", "win32"]).toContain(process.platform);
    expect(process.arch).toBe("x64");
    expect(process.versions.modules).toBe("127");

    const root = secureStateRoot();
    const databasePath = join(root, "hostdeck.sqlite");
    const backupPath = join(root, "retained.sqlite");
    const aliasPath = join(root, "database-alias.sqlite");
    const leasePath = join(root, "hostdeck.lock");
    prepareHostDeckStatePaths({ state_dir: root, database_path: databasePath });

    const opened = openMigratedDatabase(databasePath, { now: fixedNow });
    opened.db
      .prepare(
        `
          INSERT INTO settings (
            id, schema_version, state_dir, bind_port, locked,
            output_event_limit, output_byte_limit, audit_event_limit,
            audit_retention_days, updated_at
          ) VALUES ('hostdeck_settings', 1, ?, 4177, 0, 1000, 1048576, 1000, 30, ?)
        `
      )
      .run(root, at);

    let lease = acquireHostDeckDaemonLease({
      lease_path: leasePath,
      now: fixedNow
    });
    leases.push(lease);
    expect(() =>
      acquireHostDeckDaemonLease({ lease_path: leasePath, now: fixedNow })
    ).toThrowError(expect.objectContaining({ code: "lease_held" }));

    linkSync(databasePath, aliasPath);
    await expect(
      createHostDeckDatabaseBackup({
        database: opened.db,
        destination_path: backupPath,
        lease,
        state_dir: root
      })
    ).rejects.toMatchObject({ code: "state_insecure" });
    unlinkSync(aliasPath);

    await createHostDeckDatabaseBackup({
      database: opened.db,
      destination_path: backupPath,
      lease,
      state_dir: root
    });
    const backupSha256 = sha256(backupPath);
    assertNativeSecurity(root, databasePath, backupPath, leasePath);
    exerciseNativeRepair(root, databasePath);

    opened.db
      .prepare("UPDATE settings SET locked = 1, updated_at = ? WHERE id = 'hostdeck_settings'")
      .run("2026-08-11T12:01:00.000Z");
    opened.db.close();
    lease.release();
    lease = acquireHostDeckDaemonLease({
      lease_path: leasePath,
      now: () => new Date("2026-08-11T12:02:00.000Z")
    });
    leases.push(lease);
    expect(lease.replaced_stale_metadata).toBe(true);

    await restoreHostDeckDatabaseBackup({
      backup_path: backupPath,
      database_path: databasePath,
      lease,
      state_dir: root
    });
    expect(sha256(backupPath)).toBe(backupSha256);

    const restored = openMigratedDatabase(databasePath, { now: fixedNow });
    try {
      expect(
        restored.db
          .prepare("SELECT locked FROM settings WHERE id = 'hostdeck_settings'")
          .get()
      ).toEqual({ locked: 0 });
      expect(restored.db.pragma("quick_check")).toEqual([
        { quick_check: "ok" }
      ]);
      expect(restored.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.db.close();
    }

    assertNativeSecurity(root, databasePath, backupPath, leasePath);
    expect(
      readdirSync(root).filter(
        (name) =>
          name.includes(".partial-") ||
          name.endsWith("-journal") ||
          name.endsWith("-shm") ||
          name.endsWith("-wal")
      )
    ).toEqual([]);
    process.stdout.write(
      `[DAT-V1-104] ${JSON.stringify({
        files_checked: 3,
        path_security: nativeHostDeckLocalPathAdapter.path_security,
        target: nativeHostDeckLocalPathAdapter.target
      })}\n`
    );
  });
});

function secureStateRoot(): string {
  const root =
    process.platform === "win32"
      ? join(
          resolveNativeWindowsHostDeckDefaultPaths().state_dir,
          "Tests",
          `native-state-hardening-${randomUUID()}`
        )
      : mkdtempSync(join(tmpdir(), "hostdeck-native-state-hardening-"));
  cleanup.push(root);
  return root;
}

function exerciseNativeRepair(root: string, databasePath: string): void {
  if (process.platform === "linux") {
    chmodSync(databasePath, 0o640);
    expect(() =>
      openSecureHostDeckRegularFile(databasePath, {
        label: "database",
        mode: 0o600
      })
    ).toThrowError(
      expect.objectContaining({ code: "permission_update_failed" })
    );
    expect(
      prepareHostDeckStatePaths({
        state_dir: root,
        database_path: databasePath
      }).repairs
    ).toContainEqual(
      expect.objectContaining({
        from_mode: 0o640,
        kind: "file",
        to_mode: 0o600
      })
    );
    return;
  }

  const inheritedSource = join(
    nativeWindowsFileSecurityPort.currentUserRoots().local_app_data,
    `hostdeck-inherited-${randomUUID()}.sqlite`
  );
  const inheritedDestination = join(root, "inherited.sqlite");
  try {
    writeFileSync(inheritedSource, "inherited");
    renameSync(inheritedSource, inheritedDestination);
    expect(
      nativeWindowsFileSecurityPort.inspectPath(inheritedDestination)
        .acl_current_user_only
    ).toBe(false);
    expect(
      prepareHostDeckStatePaths({
        state_dir: root,
        database_path: inheritedDestination
      }).repairs
    ).toContainEqual(
      expect.objectContaining({
        from_acl: "not_current_user_only",
        kind: "file",
        to_acl: "current_user_only"
      })
    );
    expect(
      nativeWindowsFileSecurityPort.inspectPath(inheritedDestination)
        .acl_current_user_only
    ).toBe(true);
  } finally {
    rmSync(inheritedSource, { force: true });
    rmSync(inheritedDestination, { force: true });
  }
}

function assertNativeSecurity(
  root: string,
  databasePath: string,
  backupPath: string,
  leasePath: string
): void {
  if (process.platform === "linux") {
    const directory = lstatSync(root);
    expect(directory.uid).toBe(process.getuid?.());
    expect(directory.mode & 0o7777).toBe(0o700);
    for (const path of [databasePath, backupPath, leasePath]) {
      const file = lstatSync(path);
      expect(file.isFile()).toBe(true);
      expect(file.isSymbolicLink()).toBe(false);
      expect(file.uid).toBe(process.getuid?.());
      expect(file.mode & 0o7777).toBe(0o600);
      expect(file.nlink).toBe(1);
    }
  } else {
    for (const [path, isDirectory] of [
      [root, true],
      [databasePath, false],
      [backupPath, false],
      [leasePath, false]
    ] as const) {
      const inspection = nativeWindowsFileSecurityPort.inspectPath(path);
      expect(inspection.file_system).toBe("NTFS");
      expect(inspection.is_directory).toBe(isDirectory);
      expect(inspection.owner_current_user).toBe(true);
      expect(inspection.acl_current_user_only).toBe(true);
      expect(inspection.is_reparse_point).toBe(false);
      expect(inspection.has_named_streams).toBe(false);
      if (!isDirectory) expect(inspection.link_count).toBe(1);
    }
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixedNow(): Date {
  return new Date(at);
}
