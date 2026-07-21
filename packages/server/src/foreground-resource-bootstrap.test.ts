import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget } from "@hostdeck/contracts";
import {
  acquireHostDeckDaemonLease,
  defaultMigrations,
  HostDeckDaemonLeaseError,
  prepareHostDeckDaemonLeasePath,
  resolveHostDeckLocalPaths
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CloseCodexRuntimeSupervisorInput,
  CodexRuntimeSupervisorSnapshot,
  CreateCodexRuntimeSupervisorInput,
  createCodexRuntimeSupervisor,
  HostDeckCodexRuntimeSupervisor,
  StartCodexRuntimeSupervisorInput,
  StartedCodexRuntime
} from "./codex-runtime-supervisor.js";
import {
  HostDeckForegroundResourceError,
  type StartHostDeckForegroundResourcesInput,
  startHostDeckForegroundResources
} from "./foreground-resource-bootstrap.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("HostDeck foreground resource bootstrap", () => {
  it("rejects hostile or unusable configuration before owned mutation", async () => {
    const layout = fixtureLayout("invalid");
    const runtime = fakeRuntime();
    const nonExecutable = join(layout.root, "not-executable");
    const executableLink = join(layout.root, "codex-link");
    writeFileSync(nonExecutable, "not executable", { mode: 0o600 });
    symlinkSync(layout.executable, executableLink);

    let accessorRead = false;
    const hostile = Object.defineProperty(
      { ...layout.input },
      "codex_bin",
      {
        enumerable: true,
        get() {
          accessorRead = true;
          return layout.executable;
        }
      }
    );
    const candidates: unknown[] = [
      { ...layout.input, codex_bin: "codex" },
      { ...layout.input, codex_bin: join(layout.root, "missing") },
      { ...layout.input, codex_bin: nonExecutable },
      { ...layout.input, codex_bin: executableLink },
      { ...layout.input, loopback_port: 80 },
      { ...layout.input, resource_budget: { ...defaultResourceBudget } },
      { ...layout.input, unexpected: true },
      hostile
    ];

    for (const candidate of candidates) {
      const error = await captureStartError(
        candidate as StartHostDeckForegroundResourcesInput,
        runtime.factory
      );
      expect(error).toMatchObject({
        name: "HostDeckForegroundResourceError",
        code: "invalid_config",
        stage: "configuration"
      });
      expect(String(error)).not.toContain(layout.root);
      expect(JSON.stringify(error)).not.toContain(layout.root);
      expect(existsSync(layout.stateDir)).toBe(false);
    }

    let runtimeAccessorRead = false;
    const accessorFactory = (() =>
      Object.defineProperty(
        {
          close: async () => undefined,
          snapshot: () => snapshot("idle")
        },
        "start",
        {
          enumerable: true,
          get() {
            runtimeAccessorRead = true;
            return async () => runtime.started;
          }
        }
      )) as unknown as typeof createCodexRuntimeSupervisor;
    const runtimeError = await captureStartError(layout.input, accessorFactory);
    expect(runtimeError).toMatchObject({
      code: "invalid_config",
      stage: "configuration"
    });

    expect(accessorRead).toBe(false);
    expect(runtimeAccessorRead).toBe(false);
    expect(existsSync(layout.stateDir)).toBe(false);
    expect(runtime.factoryCalls).toBe(0);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.closeCalls).toBe(0);
  });

  it("acquires resources in order and closes runtime, database, then lease exactly once", async () => {
    const layout = fixtureLayout("success");
    const events: string[] = [];
    const runtime = fakeRuntime({
      onStart() {
        events.push("runtime:start");
        expect(existsSync(layout.configDir)).toBe(true);
        expect(existsSync(layout.runtimeDir)).toBe(true);
        expect(existsSync(layout.databasePath)).toBe(true);
        expectLeaseHeld(layout.leasePath);
      },
      onClose() {
        events.push("runtime:close");
        expect(existsSync(layout.databasePath)).toBe(true);
        expectLeaseHeld(layout.leasePath);
      }
    });

    const resources = await startHostDeckForegroundResources(layout.input, {
      runtimeSupervisorFactory: runtime.factory,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      pid: 12_345
    });

    expect(runtime.factoryInput).toEqual({
      mode: "foreground_child",
      codex_bin: layout.executable,
      socket_path: layout.socketPath
    });
    expect(resources.bind).toEqual({
      host: "127.0.0.1",
      port: layout.input.loopback_port,
      transport: "http"
    });
    expect(resources.paths.database_path).toBe(layout.databasePath);
    expect(resources.resource_budget).toBe(defaultResourceBudget);
    expect(resources.database.open).toBe(true);
    expect(resources.database.readonly).toBe(false);
    expect(resources.migration.currentVersion).toBe(
      defaultMigrations.at(-1)?.version
    );
    expect(resources.runtime).toEqual(runtime.started);
    expect(Object.isFrozen(resources.runtime)).toBe(true);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(resources.bind)).toBe(true);
    expect(Object.isFrozen(resources.path_repairs)).toBe(true);
    expect(lstatSync(layout.configDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.stateDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.runtimeDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.databasePath).mode & 0o7777).toBe(0o600);
    expect(JSON.parse(readFileSync(layout.leasePath, "utf8"))).toEqual({
      pid: 12_345,
      acquired_at: "2026-07-20T12:00:00.000Z"
    });
    expect(resources.snapshot()).toMatchObject({
      phase: "ready",
      database_open: true,
      lease_held: true,
      runtime: { phase: "ready" }
    });

    const firstClose = resources.close();
    const repeatedClose = resources.close();
    expect(repeatedClose).toBe(firstClose);
    await firstClose;

    expect(events).toEqual(["runtime:start", "runtime:close"]);
    expect(runtime.startCalls).toBe(1);
    expect(runtime.closeCalls).toBe(1);
    expect(resources.database.open).toBe(false);
    expect(resources.snapshot()).toMatchObject({
      phase: "closed",
      database_open: false,
      lease_held: false
    });
    acquireAndRelease(layout.leasePath);
  });

  it("stops at a held lease before later path, database, or runtime mutation", async () => {
    const layout = fixtureLayout("held");
    const paths = resolveHostDeckLocalPaths(layout.input);
    prepareHostDeckDaemonLeasePath(paths);
    const owner = acquireHostDeckDaemonLease({
      lease_path: paths.lease_path
    });
    const runtime = fakeRuntime();

    try {
      const error = await captureStartError(layout.input, runtime.factory);
      expect(error).toMatchObject({
        code: "lease_held",
        stage: "lease"
      });
      expect(runtime.factoryCalls).toBe(1);
      expect(runtime.startCalls).toBe(0);
      expect(runtime.closeCalls).toBe(0);
      expect(existsSync(layout.configDir)).toBe(false);
      expect(existsSync(layout.runtimeDir)).toBe(false);
      expect(existsSync(layout.databasePath)).toBe(false);
    } finally {
      owner.release();
    }
  });

  it("releases the lease after insecure later paths without leaking private paths", async () => {
    const layout = fixtureLayout("insecure-parent");
    const runtimeParent = join(layout.root, "runtime-parent");
    const runtimeDir = join(runtimeParent, "runtime");
    mkdirSync(runtimeParent, { mode: 0o755 });
    chmodSync(runtimeParent, 0o755);
    const input = {
      ...layout.input,
      runtime_dir: runtimeDir
    };
    const runtime = fakeRuntime();

    const error = await captureStartError(input, runtime.factory);
    expect(error).toMatchObject({ code: "path_failed", stage: "paths" });
    expect(String(error)).not.toContain(layout.root);
    expect(JSON.stringify(error)).not.toContain(layout.root);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.closeCalls).toBe(0);
    expect(existsSync(layout.configDir)).toBe(true);
    expect(existsSync(runtimeDir)).toBe(false);
    expect(existsSync(layout.databasePath)).toBe(false);
    acquireAndRelease(layout.leasePath);
  });

  it("closes and unlocks a corrupt database failure before runtime startup", async () => {
    const layout = fixtureLayout("corrupt-database");
    mkdirSync(layout.stateDir, { mode: 0o700 });
    writeFileSync(layout.databasePath, "not sqlite", { mode: 0o600 });
    const runtime = fakeRuntime();

    const error = await captureStartError(layout.input, runtime.factory);
    expect(error).toMatchObject({
      code: "database_failed",
      stage: "database"
    });
    expect(runtime.startCalls).toBe(0);
    expect(runtime.closeCalls).toBe(0);
    expect(readFileSync(layout.databasePath, "utf8")).toBe("not sqlite");
    acquireAndRelease(layout.leasePath);
  });

  it("detects database path substitution during migration and rolls back ownership", async () => {
    const layout = fixtureLayout("database-substitution");
    const runtime = fakeRuntime();
    let clockCalls = 0;
    const now = () => {
      clockCalls += 1;
      if (clockCalls === 2) {
        renameSync(layout.databasePath, `${layout.databasePath}.original`);
        writeFileSync(layout.databasePath, "substituted", { mode: 0o600 });
      }
      return new Date("2026-07-20T13:00:00.000Z");
    };

    const error = await captureStartError(layout.input, runtime.factory, now);
    expect(error).toMatchObject({
      code: "database_failed",
      stage: "database"
    });
    expect(clockCalls).toBeGreaterThanOrEqual(2);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.closeCalls).toBe(0);
    expect(readFileSync(layout.databasePath, "utf8")).toBe("substituted");
    acquireAndRelease(layout.leasePath);
  });

  it("rolls back runtime rejection, abort, and invalid startup state", async () => {
    const cases = [
      {
        label: "rejected",
        expectedCode: "runtime_failed",
        runtime: (_controller: AbortController) =>
          fakeRuntime({
            onStart() {
              throw new Error("private runtime failure");
            }
          })
      },
      {
        label: "aborted",
        expectedCode: "startup_aborted",
        runtime(controller: AbortController) {
          return fakeRuntime({
            onStart() {
              const reason = new Error("private abort reason");
              controller.abort(reason);
              throw reason;
            }
          });
        }
      },
      {
        label: "invalid-result",
        expectedCode: "runtime_failed",
        runtime: (_controller: AbortController) =>
          fakeRuntime({ startResult: Object.freeze({}) })
      }
    ] as const;

    for (const testCase of cases) {
      const layout = fixtureLayout(testCase.label);
      const controller = new AbortController();
      const runtime = testCase.runtime(controller);
      const input = {
        ...layout.input,
        ...(testCase.label === "aborted" ? { signal: controller.signal } : {})
      };

      const error = await captureStartError(input, runtime.factory);
      expect(error).toMatchObject({
        code: testCase.expectedCode,
        stage: "runtime"
      });
      expect(String(error)).not.toContain(layout.root);
      expect(runtime.startCalls).toBe(1);
      expect(runtime.closeCalls).toBe(1);
      expect(existsSync(layout.socketPath)).toBe(false);
      acquireAndRelease(layout.leasePath);
    }
  });

  it("continues database and lease cleanup when runtime close fails", async () => {
    const layout = fixtureLayout("cleanup-failure");
    const runtime = fakeRuntime({
      onClose() {
        throw new Error(`private close failure at ${layout.root}`);
      }
    });
    const resources = await startHostDeckForegroundResources(layout.input, {
      runtimeSupervisorFactory: runtime.factory
    });

    const firstClose = resources.close();
    expect(resources.close()).toBe(firstClose);
    let closeError: unknown;
    try {
      await firstClose;
    } catch (error) {
      closeError = error;
    }

    expect(closeError).toBeInstanceOf(HostDeckForegroundResourceError);
    expect(closeError).toMatchObject({
      code: "cleanup_failed",
      stage: "cleanup"
    });
    expect(String(closeError)).not.toContain(layout.root);
    expect(JSON.stringify(closeError)).not.toContain(layout.root);
    expect(runtime.closeCalls).toBe(1);
    expect(resources.database.open).toBe(false);
    expect(resources.snapshot()).toMatchObject({
      phase: "failed",
      database_open: false,
      lease_held: false
    });
    expect(resources.close()).toBe(firstClose);
    acquireAndRelease(layout.leasePath);
  });
});

interface FixtureLayout {
  readonly root: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
  readonly databasePath: string;
  readonly leasePath: string;
  readonly socketPath: string;
  readonly executable: string;
  readonly input: StartHostDeckForegroundResourcesInput;
}

function fixtureLayout(label: string): FixtureLayout {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-bootstrap-${label}-`));
  roots.push(root);
  chmodSync(root, 0o700);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const databasePath = join(stateDir, "hostdeck.sqlite");
  const leasePath = join(stateDir, "hostdeck.lock");
  const socketPath = join(runtimeDir, "app-server.sock");
  const executable = join(root, "codex-fixture");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  return {
    root,
    configDir,
    stateDir,
    runtimeDir,
    databasePath,
    leasePath,
    socketPath,
    executable,
    input: Object.freeze({
      config_dir: configDir,
      state_dir: stateDir,
      runtime_dir: runtimeDir,
      database_path: databasePath,
      codex_bin: executable,
      loopback_port: 46_217,
      resource_budget: defaultResourceBudget
    })
  };
}

interface FakeRuntimeOptions {
  readonly onStart?: (
    input: StartCodexRuntimeSupervisorInput,
    factoryInput: CreateCodexRuntimeSupervisorInput
  ) => unknown | Promise<unknown>;
  readonly onClose?: (
    input: CloseCodexRuntimeSupervisorInput,
    factoryInput: CreateCodexRuntimeSupervisorInput
  ) => unknown | Promise<unknown>;
  readonly startResult?: unknown;
}

interface FakeRuntimeHarness {
  factoryCalls: number;
  startCalls: number;
  closeCalls: number;
  factoryInput: CreateCodexRuntimeSupervisorInput | null;
  started: StartedCodexRuntime;
  factory: typeof createCodexRuntimeSupervisor;
}

function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntimeHarness {
  const processExit = Promise.resolve({
    kind: "exited" as const,
    expected: true,
    code: 0,
    signal: null
  });
  const started = Object.freeze({
    mode: "foreground_child" as const,
    ownership: "foreground_child" as const,
    socket_path: "pending",
    socket_mode_repaired: true,
    stale_socket_removed: false,
    process_exit: processExit
  });
  const harness: FakeRuntimeHarness = {
    factoryCalls: 0,
    startCalls: 0,
    closeCalls: 0,
    factoryInput: null,
    started,
    factory: (() => {
      throw new Error("Uninitialized fake runtime factory.");
    }) as typeof createCodexRuntimeSupervisor
  };
  harness.factory = ((factoryInput: CreateCodexRuntimeSupervisorInput) => {
    harness.factoryCalls += 1;
    harness.factoryInput = factoryInput;
    const validStarted = Object.freeze({
      ...started,
      socket_path: factoryInput.socket_path
    });
    harness.started = validStarted;
    let phase: CodexRuntimeSupervisorSnapshot["phase"] = "idle";
    const supervisor: HostDeckCodexRuntimeSupervisor = {
      async start(input) {
        harness.startCalls += 1;
        phase = "starting";
        const callbackResult = await options.onStart?.(input, factoryInput);
        phase = "ready";
        return (options.startResult ?? callbackResult ?? validStarted) as StartedCodexRuntime;
      },
      async close(input) {
        harness.closeCalls += 1;
        phase = "closing";
        await options.onClose?.(input, factoryInput);
        phase = "closed";
      },
      snapshot() {
        return snapshot(phase);
      }
    };
    return supervisor;
  }) as typeof createCodexRuntimeSupervisor;
  return harness;
}

function snapshot(
  phase: CodexRuntimeSupervisorSnapshot["phase"]
): CodexRuntimeSupervisorSnapshot {
  return Object.freeze({
    mode: "foreground_child",
    phase,
    ownership: "foreground_child",
    claim_held: phase === "ready",
    socket_ready: phase === "ready",
    socket_mode_repaired: phase === "ready",
    stale_socket_removed: false,
    process_state: phase === "ready" ? "running" : "not_started",
    process_exit: null,
    spawn_attempts: phase === "idle" ? 0 : 1,
    startup_retries: 0,
    term_signals: 0,
    kill_signals: 0,
    cleanup_failures: 0
  });
}

async function captureStartError(
  input: StartHostDeckForegroundResourcesInput,
  runtimeSupervisorFactory: typeof createCodexRuntimeSupervisor,
  now?: () => Date
): Promise<unknown> {
  try {
    await startHostDeckForegroundResources(input, {
      runtimeSupervisorFactory,
      ...(now === undefined ? {} : { now })
    });
  } catch (error) {
    return error;
  }
  throw new Error("Expected HostDeck foreground resource startup to fail.");
}

function expectLeaseHeld(leasePath: string): void {
  try {
    acquireHostDeckDaemonLease({ lease_path: leasePath });
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckDaemonLeaseError);
    expect(error).toMatchObject({ code: "lease_held" });
    return;
  }
  throw new Error("Expected HostDeck daemon lease to be held.");
}

function acquireAndRelease(leasePath: string): void {
  const lease = acquireHostDeckDaemonLease({ lease_path: leasePath });
  lease.release();
}
