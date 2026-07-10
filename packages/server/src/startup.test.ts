import { chmodSync, lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageSessionRecord } from "@hostdeck/contracts";
import { parseAbsoluteCwd, parseIsoTimestamp, parseSessionId, parseSessionName } from "@hostdeck/core";
import {
  createSessionRepository,
  createSettingsRepository,
  HostDeckMigrationError,
  openMigratedDatabase
} from "@hostdeck/storage";
import {
  type ExpectedTmuxTarget,
  parseSessionIdFromTmuxSessionName,
  type RealTmuxDiscoveredTarget,
  type RealTmuxTargetDiscovery,
  type TmuxTarget,
  tmuxSessionNameForSession
} from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { HostDeckStartupError, isHostReady, startHostAgent } from "./startup.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("host startup", () => {
  it("repairs and reports real startup path modes before ready", async () => {
    const stateDir = tempDir("hostdeck-startup-mode-state-");
    const configDir = tempDir("hostdeck-startup-mode-config-");
    const runtimeParent = tempDir("hostdeck-startup-mode-runtime-parent-");
    const runtimeDir = join(runtimeParent, "hostdeck");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    writeFileSync(databasePath, "", { mode: 0o644 });
    chmodSync(stateDir, 0o755);
    chmodSync(configDir, 0o750);
    chmodSync(databasePath, 0o644);

    const result = await startHostAgent({
      version: "0.0.0-test",
      configDir,
      stateDir,
      runtimeDir,
      databasePath,
      checkNetworkBind: noopNetworkBindCheck,
      discovery: emptyDiscovery(),
      now: fixedNow
    });
    result.close();

    expect(new Set(result.paths.repairs.map((repair) => repair.path))).toEqual(
      new Set([stateDir, configDir, databasePath])
    );
    expect(fileMode(stateDir)).toBe(0o700);
    expect(fileMode(configDir)).toBe(0o700);
    expect(fileMode(runtimeDir)).toBe(0o700);
    expect(fileMode(databasePath)).toBe(0o600);
    expect(fileMode(join(stateDir, "hostdeck.lock"))).toBe(0o600);
  });

  it("reports ready only after storage, settings, tmux, reconciliation, and reader checks pass", async () => {
    const stateDir = tempDir("hostdeck-startup-state-");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    const setup = openMigratedDatabase(databasePath, { now: fixedNow });

    try {
      createSettingsRepository(setup.db).getOrCreateDefault({ stateDir, bindPort: 4111, now: fixedNow });
      const sessions = createSessionRepository(setup.db);
      const live = sessions.create(sessionRecord("sess_startup_live_01", "startup-live"));
      const missing = sessions.create(sessionRecord("sess_startup_missing_01", "startup-missing"));
      setup.db.close();

      const unmanaged = discoveredTarget("sess_startup_unmanaged_01", "%9");
      const readerStarts: string[] = [];
      const result = await startHostAgent({
        version: "0.0.0-test",
        ...localPaths(),
        stateDir,
        databasePath,
        checkNetworkBind: noopNetworkBindCheck,
        discovery: fakeDiscovery({
          liveTargets: [targetForSession(live, "%7")],
          staleTargets: [
            {
              sessionId: missing.id,
              sessionName: missing.name,
              cwd: missing.cwd,
              tmuxSession: missing.backend.tmux_session,
              staleReason: "tmux target missing"
            }
          ],
          unmanagedTargets: [unmanaged]
        }),
        now: laterNow,
        startOutputReader(target) {
          readerStarts.push(target.sessionId);
        }
      });

      try {
        expect(isHostReady(result.status)).toBe(true);
        expect(result.status).toMatchObject({
          version: "0.0.0-test",
          bind: { mode: "localhost", host: "127.0.0.1", port: 4111 },
          locked: false,
          lan_enabled: false,
          storage: { state: "ok" },
          tmux: { state: "ok" },
          stream: { state: "ok" },
          stale_session_count: 1,
          last_error: null
        });
        expect(result.status.startup_checks.map((check) => [check.name, check.state])).toEqual([
          ["state_dir", "ok"],
          ["daemon_lease", "ok"],
          ["local_paths", "ok"],
          ["database_file", "ok"],
          ["storage_migrations", "ok"],
          ["settings", "ok"],
          ["network_bind", "ok"],
          ["tmux", "ok"],
          ["registry_reconciliation", "ok"]
        ]);
        expect(readerStarts).toEqual([live.id]);
        expect(result.reconciliation).toMatchObject({
          staleSessionIds: [missing.id],
          unmanagedTargets: [unmanaged]
        });
        expect(result.sessions.require(missing.id)).toMatchObject({
          lifecycle_state: "stale",
          stale_reason: "tmux target missing"
        });
      } finally {
        result.close();
      }
    } finally {
      if (setup.db.open) {
        setup.db.close();
      }
    }
  });

  it("fails before ready when tmux is missing", async () => {
    const stateDir = tempDir("hostdeck-startup-state-");
    const paths = localPaths();
    const error = await expectStartupFailure(
      startHostAgent({
        version: "0.0.0-test",
        ...paths,
        stateDir,
        tmuxBinary: join(tempDir("hostdeck-missing-tmux-"), "missing-tmux"),
        checkNetworkBind: noopNetworkBindCheck,
        now: fixedNow
      })
    );

    expect(error).toMatchObject({ code: "tmux_unavailable" });
    expect(isHostReady(error.status)).toBe(false);
    expect(error.status).toMatchObject({
      storage: { state: "ok" },
      tmux: { state: "error" },
      stream: { state: "unknown" },
      last_error: { code: "missing_binary", field: "tmux" }
    });
    expect(error.status.startup_checks.at(-1)).toMatchObject({ name: "tmux", state: "error" });

    const recovered = await startHostAgent({
      version: "0.0.0-test",
      ...paths,
      stateDir,
      checkNetworkBind: noopNetworkBindCheck,
      discovery: emptyDiscovery(),
      now: fixedNow
    });
    recovered.close();
  });

  it("rejects a second daemon before database or bind mutation and releases on idempotent close", async () => {
    const stateDir = tempDir("hostdeck-startup-lease-state-");
    const paths = localPaths();
    const first = await startHostAgent({
      version: "0.0.0-test",
      ...paths,
      stateDir,
      checkNetworkBind: noopNetworkBindCheck,
      discovery: emptyDiscovery(),
      now: fixedNow
    });
    let openCalls = 0;
    let bindCalls = 0;
    const secondRoot = tempDir("hostdeck-startup-second-owner-root-");
    const secondRuntimeParent = tempDir("hostdeck-startup-second-owner-runtime-parent-");
    const secondConfigDir = join(secondRoot, "config");
    const secondRuntimeDir = join(secondRuntimeParent, "hostdeck");
    try {
      const error = await expectStartupFailure(
        startHostAgent({
          version: "0.0.0-test",
          configDir: secondConfigDir,
          runtimeDir: secondRuntimeDir,
          stateDir,
          openDatabase() {
            openCalls += 1;
            throw new Error("Database must not open for a second daemon.");
          },
          checkNetworkBind() {
            bindCalls += 1;
          },
          discovery: emptyDiscovery(),
          now: fixedNow
        })
      );
      expect(error).toMatchObject({ code: "daemon_lease_held" });
      expect(error.status.startup_checks.at(-1)).toMatchObject({ name: "daemon_lease", state: "error" });
      expect(openCalls).toBe(0);
      expect(bindCalls).toBe(0);
      expect(() => lstatSync(secondConfigDir)).toThrow();
      expect(() => lstatSync(secondRuntimeDir)).toThrow();
    } finally {
      first.close();
      first.close();
    }

    const restarted = await startHostAgent({
      version: "0.0.0-test",
      ...paths,
      stateDir,
      checkNetworkBind: noopNetworkBindCheck,
      discovery: emptyDiscovery(),
      now: laterNow
    });
    restarted.close();
  });

  it("rejects relative programmatic paths before database startup", async () => {
    let openCalls = 0;
    const error = await expectStartupFailure(
      startHostAgent({
        version: "0.0.0-test",
        ...localPaths(),
        stateDir: "relative-state",
        openDatabase() {
          openCalls += 1;
          throw new Error("Database must not open for relative paths.");
        },
        now: fixedNow
      })
    );

    expect(error).toMatchObject({ code: "invalid_state_dir" });
    expect(error.status.startup_checks).toEqual([
      expect.objectContaining({ name: "state_dir", state: "error" })
    ]);
    expect(openCalls).toBe(0);
  });

  it("detects database path substitution across SQLite open and releases the lease", async () => {
    const stateDir = tempDir("hostdeck-startup-substitution-state-");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    const movedPath = join(stateDir, "hostdeck.sqlite.opened");
    const paths = localPaths();
    const error = await expectStartupFailure(
      startHostAgent({
        version: "0.0.0-test",
        ...paths,
        stateDir,
        databasePath,
        checkNetworkBind: noopNetworkBindCheck,
        discovery: emptyDiscovery(),
        now: fixedNow,
        openDatabase(path, options) {
          const opened = openMigratedDatabase(path, options);
          renameSync(path, movedPath);
          writeFileSync(path, "replacement", { mode: 0o600 });
          return opened;
        }
      })
    );

    expect(error).toMatchObject({ code: "invalid_state_dir" });
    expect(error.status.startup_checks.at(-1)).toMatchObject({ name: "database_file", state: "error" });

    rmSync(databasePath);
    renameSync(movedPath, databasePath);
    const recovered = await startHostAgent({
      version: "0.0.0-test",
      ...paths,
      stateDir,
      databasePath,
      checkNetworkBind: noopNetworkBindCheck,
      discovery: emptyDiscovery(),
      now: laterNow
    });
    recovered.close();
  });

  it("fails before storage when the state directory is invalid", async () => {
    const filePath = join(tempDir("hostdeck-startup-state-file-"), "not-a-dir");
    writeFileSync(filePath, "not a directory");
    const error = await expectStartupFailure(
      startHostAgent({
        version: "0.0.0-test",
        ...localPaths(),
        stateDir: filePath,
        now: fixedNow
      })
    );

    expect(error).toMatchObject({ code: "invalid_state_dir" });
    expect(isHostReady(error.status)).toBe(false);
    expect(error.status).toMatchObject({
      storage: { state: "unknown" },
      tmux: { state: "unknown" },
      last_error: { code: "invalid_config", field: "state_dir" }
    });
    expect(error.status.startup_checks).toEqual([
      expect.objectContaining({ name: "state_dir", state: "error" })
    ]);
  });

  it("fails before ready when bind port settings are invalid", async () => {
    const error = await expectStartupFailure(
      startHostAgent({
        version: "0.0.0-test",
        ...localPaths(),
        stateDir: tempDir("hostdeck-startup-state-"),
        bindPort: 0,
        checkNetworkBind: noopNetworkBindCheck,
        discovery: emptyDiscovery(),
        now: fixedNow
      })
    );

    expect(error).toMatchObject({ code: "invalid_settings" });
    expect(isHostReady(error.status)).toBe(false);
    expect(error.status).toMatchObject({
      storage: { state: "error" },
      tmux: { state: "unknown" },
      last_error: { code: "invalid_config", field: "settings" }
    });
    expect(error.status.startup_checks.at(-1)).toMatchObject({ name: "settings", state: "error" });
  });

  it("fails before ready when migrations fail", async () => {
    const error = await expectStartupFailure(
      startHostAgent({
        version: "0.0.0-test",
        ...localPaths(),
        stateDir: tempDir("hostdeck-startup-state-"),
        now: fixedNow,
        openDatabase() {
          throw new HostDeckMigrationError("failed_migration", "simulated migration failure");
        }
      })
    );

    expect(error).toMatchObject({ code: "migration_failed" });
    expect(isHostReady(error.status)).toBe(false);
    expect(error.status).toMatchObject({
      storage: { state: "error" },
      tmux: { state: "unknown" },
      last_error: { code: "storage_error" }
    });
    expect(error.status.startup_checks.at(-1)).toMatchObject({ name: "storage_migrations", state: "error" });
  });

  it("fails before ready when a live session output reader cannot start", async () => {
    const stateDir = tempDir("hostdeck-startup-state-");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    const setup = openMigratedDatabase(databasePath, { now: fixedNow });

    try {
      const live = createSessionRepository(setup.db).create(sessionRecord("sess_startup_reader_fail_01", "startup-reader-fail"));
      setup.db.close();
      const error = await expectStartupFailure(
        startHostAgent({
          version: "0.0.0-test",
          ...localPaths(),
          stateDir,
          databasePath,
          checkNetworkBind: noopNetworkBindCheck,
          discovery: fakeDiscovery({
            liveTargets: [targetForSession(live, "%8")],
            staleTargets: [],
            unmanagedTargets: []
          }),
          now: laterNow,
          startOutputReader() {
            throw new Error("pipe failed");
          }
        })
      );

      expect(error).toMatchObject({ code: "output_reader_start_failed" });
      expect(isHostReady(error.status)).toBe(false);
      expect(error.status).toMatchObject({
        storage: { state: "ok" },
        tmux: { state: "ok" },
        stream: { state: "error" },
        last_error: { code: "internal_error" }
      });
      expect(error.status.startup_checks.at(-1)).toMatchObject({ name: "registry_reconciliation", state: "error" });
    } finally {
      if (setup.db.open) {
        setup.db.close();
      }
    }
  });
});

async function expectStartupFailure(startup: Promise<unknown>): Promise<HostDeckStartupError> {
  try {
    await startup;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckStartupError);
    return error as HostDeckStartupError;
  }

  throw new Error("Expected startup to fail.");
}

function noopNetworkBindCheck(): void {
  return;
}

function emptyDiscovery(): RealTmuxTargetDiscovery {
  return fakeDiscovery({
    liveTargets: [],
    staleTargets: [],
    unmanagedTargets: []
  });
}

function fakeDiscovery(result: {
  readonly liveTargets: readonly TmuxTarget[];
  readonly staleTargets: readonly {
    readonly sessionId: ExpectedTmuxTarget["sessionId"];
    readonly sessionName: ExpectedTmuxTarget["sessionName"];
    readonly cwd: ExpectedTmuxTarget["cwd"];
    readonly tmuxSession: string;
    readonly staleReason: string;
  }[];
  readonly unmanagedTargets: readonly RealTmuxDiscoveredTarget[];
}): RealTmuxTargetDiscovery {
  return {
    tmuxSessionNameForSession,
    parseSessionIdFromTmuxSessionName,
    async listTargets() {
      return result.unmanagedTargets;
    },
    async getTargetBySessionId() {
      return null;
    },
    async reconcileTargets(expectedTargets) {
      const expectedIds = new Set(expectedTargets.map((target) => target.sessionId));
      return {
        liveTargets: result.liveTargets.filter((target) => expectedIds.has(target.sessionId)),
        staleTargets: result.staleTargets.filter((target) => expectedIds.has(target.sessionId)),
        unmanagedTargets: result.unmanagedTargets
      };
    }
  };
}

function sessionRecord(id: string, name: string): StorageSessionRecord {
  const sessionId = parseRequiredSessionId(id);

  return {
    id: sessionId,
    name: parseRequiredSessionName(name),
    cwd: parseRequiredCwd(tempDir("hostdeck-startup-cwd-")),
    backend: {
      type: "tmux",
      tmux_session: tmuxSessionNameForSession(sessionId),
      tmux_window: "codex",
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: parseRequiredIso("2026-07-08T22:00:00.000Z"),
    updated_at: parseRequiredIso("2026-07-08T22:00:00.000Z"),
    stale_reason: null
  };
}

function targetForSession(session: StorageSessionRecord, pane: string): TmuxTarget {
  return {
    sessionId: session.id,
    sessionName: session.name,
    cwd: session.cwd,
    tmuxSession: session.backend.tmux_session,
    tmuxWindow: "codex",
    tmuxPane: pane,
    lifecycleState: "running",
    staleReason: null,
    createdAt: session.created_at,
    updatedAt: parseRequiredIso("2026-07-08T22:04:00.000Z")
  };
}

function discoveredTarget(id: string, pane: string): RealTmuxDiscoveredTarget {
  const sessionId = parseRequiredSessionId(id);

  return {
    sessionId,
    tmuxSession: tmuxSessionNameForSession(sessionId),
    tmuxWindow: "codex",
    tmuxPane: pane,
    currentPath: parseRequiredCwd(tempDir("hostdeck-startup-cwd-")),
    createdAt: parseRequiredIso("2026-07-08T22:03:00.000Z"),
    updatedAt: parseRequiredIso("2026-07-08T22:04:00.000Z")
  };
}

function parseRequiredSessionId(value: string) {
  const result = parseSessionId(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredSessionName(value: string) {
  const result = parseSessionName(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredCwd(value: string) {
  const result = parseAbsoluteCwd(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredIso(value: string) {
  const result = parseIsoTimestamp(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fileMode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function localPaths(): { readonly configDir: string; readonly runtimeDir: string } {
  const runtimeParent = tempDir("hostdeck-startup-runtime-parent-");
  return {
    configDir: tempDir("hostdeck-startup-config-"),
    runtimeDir: join(runtimeParent, "hostdeck")
  };
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
