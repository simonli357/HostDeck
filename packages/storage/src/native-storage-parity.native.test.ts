import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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
  defaultMigrations,
  hostDeckAutomaticSessionMembershipMigration,
  hostDeckCrossPlatformCwdMigration,
} from "./migrations.js";
import {
  prepareHostDeckStatePaths,
  resolveNativeWindowsHostDeckDefaultPaths
} from "./secure-local-paths.js";

const testFile = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(testFile), "../../.."));
const storageManifest = join(repositoryRoot, "packages", "storage", "package.json");
const requireFromStorage = createRequire(storageManifest);
const workerPath = fileURLToPath(
  new URL("../test-support/native-storage-crash-worker.mjs", import.meta.url)
);
const crossPlatformMigrationIndex = defaultMigrations.findIndex(
  ({ version }) => version === hostDeckCrossPlatformCwdMigration.version
);
if (crossPlatformMigrationIndex < 1) throw new Error("Cross-platform cwd migration is missing or unordered.");
const priorMigrations = defaultMigrations.slice(0, crossPlatformMigrationIndex);
const crossPlatformMigrations = defaultMigrations.slice(0, crossPlatformMigrationIndex + 1);
const cleanup: string[] = [];
const leases: HostDeckDaemonLease[] = [];
const at = "2026-08-11T12:00:00.000Z";
const expectedSchemaSha256 =
  "1102c68f83e1708e7a9df53082e91c51908cc282ab985cddd8ea262c6d647286";

afterEach(() => {
  for (const lease of leases.splice(0).reverse()) lease.release();
  for (const root of cleanup.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("native SQLite storage parity", () => {
  it("loads the exact target-native SQLite binary from the frozen package graph", () => {
    expect(["linux", "win32"]).toContain(process.platform);
    expect(process.arch).toBe("x64");
    expect(process.versions.modules).toBe("127");

    const packageManifestPath = realpathSync(
      requireFromStorage.resolve("better-sqlite3/package.json")
    );
    const packageRoot = dirname(packageManifestPath);
    const mainPath = realpathSync(requireFromStorage.resolve("better-sqlite3"));
    const binaryPath = realpathSync(
      requireFromStorage.resolve(
        "better-sqlite3/build/Release/better_sqlite3.node"
      )
    );
    const nodeModulesRoot = realpathSync(join(repositoryRoot, "node_modules"));
    const manifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));

    expect(manifest.version).toBe("12.11.1");
    expectContained(nodeModulesRoot, packageRoot);
    expectContained(packageRoot, mainPath);
    expectContained(packageRoot, binaryPath);
    expect(lstatSync(binaryPath).isFile()).toBe(true);
    expect(lstatSync(binaryPath).isSymbolicLink()).toBe(false);
    expect(
      readdirSync(dirname(binaryPath)).filter((name) => name.endsWith(".node"))
    ).toEqual(["better_sqlite3.node"]);
    expectNativeX64Binary(binaryPath);
    expect(sha256(binaryPath)).toMatch(/^[a-f0-9]{64}$/u);

    const database = new Database(":memory:");
    try {
      expect(
        database.prepare("SELECT sqlite_version() AS version").get()
      ).toEqual({ version: "3.53.2" });
      expect(database.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      database.close();
    }
  });

  it("matches the frozen schema and indexed query plans with a native cwd", () => {
    const root = temporaryRoot("hostdeck-native-schema-");
    const path = join(root, "hostdeck.sqlite");
    const opened = openMigratedDatabase(path, { now: fixedNow });
    try {
      insertSelectedSession(opened.db, "sess_native_schema_01", "native-schema");
      expect(opened.result.currentVersion).toBe(
        hostDeckAutomaticSessionMembershipMigration.version
      );
      expect(schemaSha256(opened.db)).toBe(expectedSchemaSha256);
      expectPlanUses(
        opened.db,
        "SELECT * FROM selected_projected_events WHERE session_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
        ["sess_native_schema_01", 0, 100],
        "selected_projected_events_session_cursor_idx"
      );
      expectPlanUses(
        opened.db,
        "SELECT operation_id FROM selected_audit_events WHERE phase = ? AND at < ? ORDER BY at, operation_id LIMIT ?",
        ["terminal", at, 100],
        "selected_audit_events_phase_at_operation_idx"
      );
      expectPlanUses(
        opened.db,
        "SELECT source_key FROM pairing_claim_rate_sources ORDER BY last_attempt_at, source_key LIMIT ?",
        [100],
        "pairing_claim_rate_sources_last_attempt_idx"
      );
      expect(opened.db.pragma("quick_check")).toEqual([
        { quick_check: "ok" }
      ]);
      expect(opened.db.pragma("foreign_key_check")).toEqual([]);
      expect(
        opened.db
          .prepare("SELECT cwd FROM selected_sessions WHERE id = ?")
          .get("sess_native_schema_01")
      ).toEqual({ cwd: nativeCwd() });
    } finally {
      opened.db.close();
    }
  });

  it(
    "recovers the prior schema and rows after process death inside the real migration",
    async () => {
      const root = temporaryRoot("hostdeck-native-migration-crash-");
      const path = join(root, "hostdeck.sqlite");
      const migrationPath = join(root, "migration.json");
      const signalPath = join(root, "migration.ready");
      const prior = openMigratedDatabase(path, {
        migrations: priorMigrations,
        now: fixedNow
      });
      insertLegacySession(prior.db, "sess_crash_prior_01", "prior-row", 2);
      prior.db.close();
      writeFileSync(
        migrationPath,
        `${JSON.stringify(hostDeckCrossPlatformCwdMigration)}\n`,
        { mode: 0o600 }
      );

      const worker = spawnWorker([
        "migration",
        path,
        migrationPath,
        signalPath
      ]);
      await waitForSignal(worker, signalPath);
      await terminateWorker(worker);

      const recovered = openMigratedDatabase(path, {
        migrations: priorMigrations,
        now: fixedNow
      });
      try {
        expect(
          recovered.db
            .prepare("SELECT id, name FROM sessions ORDER BY id")
            .all()
        ).toEqual([{ id: "sess_crash_prior_01", name: "prior-row" }]);
        expect(
          recovered.db
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .all()
        ).toHaveLength(priorMigrations.length);
        expect(
          schemaNames(recovered.db).filter((name) => name.endsWith("_next"))
        ).toEqual([]);
        expect(recovered.db.pragma("quick_check")).toEqual([
          { quick_check: "ok" }
        ]);
      } finally {
        recovered.db.close();
      }

      const crossPlatform = openMigratedDatabase(path, {
        migrations: crossPlatformMigrations,
        now: fixedNow
      });
      try {
        expect(crossPlatform.result.applied).toEqual([
          hostDeckCrossPlatformCwdMigration.version
        ]);
        expect(crossPlatform.db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        crossPlatform.db.close();
      }
      expect(ownedResidue(root)).toEqual([]);
    },
    30_000
  );

  it(
    "keeps the live snapshot atomic after process death during retained-backup restore",
    async () => {
      const root = temporaryRoot("hostdeck-native-restore-crash-");
      const sourcePath = join(root, "source.sqlite");
      const backupPath = join(root, "retained.sqlite");
      const destinationPath = join(root, "live.sqlite");
      const signalPath = join(root, "restore.ready");
      prepareHostDeckStatePaths({
        state_dir: root,
        database_path: sourcePath
      });
      const source = openMigratedDatabase(sourcePath, { now: fixedNow });
      insertLegacySession(source.db, "sess_retained_source_01", "retained-source", 256);
      let lease = acquireHostDeckDaemonLease({
        lease_path: join(root, "hostdeck.lock"),
        now: fixedNow
      });
      leases.push(lease);
      await createHostDeckDatabaseBackup({
        database: source.db,
        destination_path: backupPath,
        lease,
        state_dir: root
      });
      source.db.close();
      const backupIdentity = sha256(backupPath);

      prepareHostDeckStatePaths({
        state_dir: root,
        database_path: destinationPath
      });
      const destination = openMigratedDatabase(destinationPath, {
        now: fixedNow
      });
      insertLegacySession(destination.db, "sess_live_01", "live-before-restore", 8);
      const liveBefore = legacySnapshot(destination.db);
      destination.db.close();

      lease.release();

      const worker = spawnWorker([
        "restore",
        backupPath,
        destinationPath,
        signalPath,
        join(root, "hostdeck.lock")
      ]);
      await waitForSignal(worker, signalPath);
      await terminateWorker(worker);

      const recovered = openMigratedDatabase(destinationPath, { now: fixedNow });
      try {
        expect(legacySnapshot(recovered.db)).toEqual(liveBefore);
        expect(recovered.db.pragma("quick_check")).toEqual([
          { quick_check: "ok" }
        ]);
        expect(recovered.db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        recovered.db.close();
      }
      expect(sha256(backupPath)).toBe(backupIdentity);

      lease = acquireHostDeckDaemonLease({
        lease_path: join(root, "hostdeck.lock"),
        now: fixedNow
      });
      leases.push(lease);
      await restoreHostDeckDatabaseBackup({
        backup_path: backupPath,
        database_path: destinationPath,
        lease,
        state_dir: root
      });
      const restored = openMigratedDatabase(destinationPath, { now: fixedNow });
      try {
        expect(
          restored.db.prepare("SELECT id, name FROM sessions ORDER BY id").all()
        ).toEqual([
          { id: "sess_retained_source_01", name: "retained-source" }
        ]);
        expect(restored.db.prepare("SELECT COUNT(*) AS count FROM output_events").get()).toEqual({
          count: 256
        });
      } finally {
        restored.db.close();
      }
      expect(sha256(backupPath)).toBe(backupIdentity);
      expect(ownedResidue(root)).toEqual([]);
    },
    30_000
  );
});

function spawnWorker(arguments_: readonly string[]): ChildProcess {
  return spawn(process.execPath, [workerPath, ...arguments_], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
      WINDIR: process.env.WINDIR
    },
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
}

async function waitForSignal(
  child: ChildProcess,
  signalPath: string
): Promise<void> {
  const started = Date.now();
  while (!existsSync(signalPath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Native storage worker exited before its interruption boundary: ${await readChildError(child)}`
      );
    }
    if (Date.now() - started > 10_000) {
      await terminateWorker(child);
      throw new Error("Native storage worker did not reach its interruption boundary.");
    }
    await delay(20);
  }
}

async function terminateWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (!child.kill("SIGKILL")) {
    throw new Error("Native storage worker could not be terminated.");
  }
  await exited;
}

async function readChildError(child: ChildProcess): Promise<string> {
  const stream = child.stderr;
  if (stream === null) return "no diagnostic";
  let value = "";
  for await (const chunk of stream) {
    value = `${value}${String(chunk)}`.slice(-512);
  }
  return value.trim() || "no diagnostic";
}

function insertSelectedSession(
  db: Database.Database,
  id: string,
  name: string
): void {
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'codex_app_server', '0.147.0', 'selected', ?, ?, NULL)
    `
  ).run(id, name, `thread-${id}`, nativeCwd(), at, at);
}

function insertLegacySession(
  db: Database.Database,
  id: string,
  name: string,
  outputCount: number
): void {
  db.prepare(
    `
      INSERT INTO sessions (
        id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
        lifecycle_state, created_at, updated_at, stale_reason
      ) VALUES (?, ?, ?, 'tmux', ?, NULL, NULL, 'running', ?, ?, NULL)
    `
  ).run(id, name, legacyCwd, `tmux-${id}`, at, at);
  const insert = db.prepare(
    `
      INSERT INTO output_events (
        session_id, cursor, event_order, captured_at, kind, payload,
        truncated_before
      ) VALUES (?, ?, ?, ?, 'output', ?, NULL)
    `
  );
  const transaction = db.transaction(() => {
    for (let index = 1; index <= outputCount; index += 1) {
      insert.run(id, index, index, at, `${name}:${index}:${"x".repeat(16_384)}`);
    }
  });
  transaction();
}

function legacySnapshot(db: Database.Database): unknown {
  return {
    events: db
      .prepare(
        "SELECT session_id, cursor, length(payload) AS bytes FROM output_events ORDER BY session_id, cursor"
      )
      .all(),
    sessions: db.prepare("SELECT id, name, cwd FROM sessions ORDER BY id").all()
  };
}

function schemaSha256(db: Database.Database): string {
  const schema = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all();
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

function expectPlanUses(
  db: Database.Database,
  sql: string,
  parameters: readonly (number | string)[],
  index: string
): void {
  const details = (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{
      readonly detail: string;
    }>
  ).map(({ detail }) => detail);
  expect(details.some((detail) => detail.includes(index)), details.join("\n")).toBe(
    true
  );
}

function schemaNames(db: Database.Database): readonly string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ readonly name: string }>
  ).map(({ name }) => name);
}

function expectContained(parent: string, child: string): void {
  const path = relative(parent, child);
  expect(path).not.toBe("");
  expect(path.startsWith("..")).toBe(false);
  expect(isAbsolute(path)).toBe(false);
}

function expectNativeX64Binary(path: string): void {
  const bytes = readFileSync(path);
  if (process.platform === "linux") {
    expect([...bytes.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(bytes[4]).toBe(2);
    expect(bytes[5]).toBe(1);
    expect(bytes.readUInt16LE(18)).toBe(0x3e);
    return;
  }
  expect(bytes.subarray(0, 2).toString("ascii")).toBe("MZ");
  const peOffset = bytes.readUInt32LE(0x3c);
  expect(bytes.subarray(peOffset, peOffset + 4).toString("binary")).toBe(
    "PE\0\0"
  );
  expect(bytes.readUInt16LE(peOffset + 4)).toBe(0x8664);
}

function ownedResidue(root: string): readonly string[] {
  return readdirSync(root)
    .filter(
      (name) =>
        name.endsWith("-journal") ||
        name.endsWith("-shm") ||
        name.endsWith("-wal") ||
        name.includes(".partial-")
    )
    .sort();
}

function temporaryRoot(prefix: string): string {
  const root =
    process.platform === "win32"
      ? join(
          resolveNativeWindowsHostDeckDefaultPaths().state_dir,
          "Tests",
          `${prefix}${randomUUID()}`
        )
      : mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(root);
  const bootstrapPath = join(root, ".state-bootstrap.sqlite");
  prepareHostDeckStatePaths({
    state_dir: root,
    database_path: bootstrapPath
  });
  rmSync(bootstrapPath, { force: true });
  return root;
}

function nativeCwd(): string {
  return process.platform === "win32"
    ? "C:\\Users\\selected\\Native Project"
    : "/home/selected/Native Project";
}

const legacyCwd = "/home/selected/Native Project";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixedNow(): Date {
  return new Date(at);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
