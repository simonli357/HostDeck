import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HostDeckProductionForegroundServe,
  HostDeckProductionForegroundServeError,
  type HostDeckProductionForegroundServeSnapshot,
  type StartHostDeckProductionForegroundServeInput
} from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import { runCli } from "./shell.js";

describe("packaged executable dispatch", () => {
  it("loads a supplied version lazily only after valid version grammar", async () => {
    let loads = 0;
    const version = () => {
      loads += 1;
      return "1.2.3-test";
    };

    expect(await runCli(["help"], { version })).toMatchObject({
      exitCode: cliExitCodes.ok
    });
    expect(await runCli(["unknown"], { version })).toMatchObject({
      exitCode: cliExitCodes.usage
    });
    expect(loads).toBe(0);
    expect(await runCli(["version"], { version })).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: "codexdeck 1.2.3-test\n",
      stderr: ""
    });
    expect(loads).toBe(1);
  });

  it("resolves exact foreground inputs and waits for one accepted owner", async () => {
    const fixture = createFixture();
    let startCalls = 0;
    let captured: StartHostDeckProductionForegroundServeInput | null = null;
    const owner = createOwner(4888);
    try {
      const result = await runCli(
        [
          "--port=4888",
          "--state-dir",
          fixture.stateDir,
          "--database",
          fixture.databasePath,
          "serve"
        ],
        {
          env: fixture.env,
          packageRoot: fixture.packageRoot,
          startForegroundServe: async (input) => {
            startCalls += 1;
            captured = input;
            return owner;
          }
        }
      );

      expect(result).toEqual({
        exitCode: cliExitCodes.ok,
        stdout: "HostDeck foreground service ready at http://127.0.0.1:4888.\n",
        stderr: ""
      });
      expect(startCalls).toBe(1);
      expect(captured).toMatchObject({
        browser_routes: ["/", "/sessions/:session_id"],
        codex_bin: fixture.codexBin,
        config_dir: fixture.configDir,
        database_path: fixture.databasePath,
        loopback_port: 4888,
        runtime_dir: fixture.runtimeDir,
        state_dir: fixture.stateDir,
        static_build_root: join(fixture.packageRoot, "web")
      });
      const selectedInput = captured as unknown as StartHostDeckProductionForegroundServeInput;
      expect(selectedInput.observe_issue({ source: "serve", code: "private_issue" })).toBeUndefined();
      expect(selectedInput.resource_budget).toBeDefined();
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves Codex through a bounded absolute PATH", async () => {
    const fixture = createFixture();
    let captured: StartHostDeckProductionForegroundServeInput | null = null;
    try {
      const result = await runCli(["serve"], {
        env: {
          ...fixture.env,
          HOSTDECK_CODEX_BIN: undefined,
          PATH: fixture.commandDir
        },
        packageRoot: fixture.packageRoot,
        startForegroundServe: async (input) => {
          captured = input;
          return createOwner(3777);
        }
      });

      expect(result.exitCode).toBe(cliExitCodes.ok);
      expect(captured).toMatchObject({ codex_bin: fixture.codexBin });
    } finally {
      fixture.cleanup();
    }
  });

  it("publishes readiness before terminal shutdown without duplicate output", async () => {
    const fixture = createFixture();
    const terminal = deferred<HostDeckProductionForegroundServeSnapshot>();
    const owner = createOwner(3777, { terminated: terminal.promise });
    const writes: string[] = [];
    try {
      const pending = runCli(["serve"], {
        env: fixture.env,
        packageRoot: fixture.packageRoot,
        startForegroundServe: async () => owner,
        writeServeReady: (output) => writes.push(output)
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toEqual([
        "HostDeck foreground service ready at http://127.0.0.1:3777.\n"
      ]);
      terminal.resolve(closedSnapshot());
      await expect(pending).resolves.toEqual({
        exitCode: cliExitCodes.ok,
        stdout: "",
        stderr: ""
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects invalid serve configuration before invoking the owner", async () => {
    const fixture = createFixture();
    let starts = 0;
    const startForegroundServe = async () => {
      starts += 1;
      return createOwner(3777);
    };
    try {
      const missingRuntime = await runCli(["serve"], {
        env: {
          HOME: fixture.root,
          HOSTDECK_CODEX_BIN: fixture.codexBin
        },
        packageRoot: fixture.packageRoot,
        startForegroundServe
      });
      const invalidCodex = await runCli(["serve"], {
        env: {
          ...fixture.env,
          HOSTDECK_CODEX_BIN: join(fixture.root, "private-missing-codex")
        },
        packageRoot: fixture.packageRoot,
        startForegroundServe
      });
      const relativePath = await runCli(["serve"], {
        env: {
          ...fixture.env,
          HOSTDECK_CODEX_BIN: undefined,
          PATH: "relative-bin"
        },
        packageRoot: fixture.packageRoot,
        startForegroundServe
      });
      const noncanonicalPackage = await runCli(["serve"], {
        env: fixture.env,
        packageRoot: `${fixture.packageRoot}/.`,
        startForegroundServe
      });

      expect(missingRuntime).toMatchObject({
        exitCode: cliExitCodes.config,
        stdout: ""
      });
      expect(invalidCodex).toMatchObject({
        exitCode: cliExitCodes.config,
        stdout: ""
      });
      expect(invalidCodex.stderr).not.toContain(fixture.root);
      expect(relativePath).toMatchObject({
        exitCode: cliExitCodes.config,
        stdout: ""
      });
      expect(noncanonicalPackage).toMatchObject({
        exitCode: cliExitCodes.config,
        stdout: ""
      });
      expect(noncanonicalPackage.stderr).not.toContain(fixture.root);
      expect(starts).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("maps startup and failed termination without exposing raw causes", async () => {
    const fixture = createFixture();
    try {
      const startup = await runCli(["serve"], {
        env: fixture.env,
        packageRoot: fixture.packageRoot,
        startForegroundServe: async () => {
          throw new HostDeckProductionForegroundServeError(
            "listener_start_failed",
            "listener",
            `private cause ${fixture.root}`
          );
        }
      });
      const failed = await runCli(["serve"], {
        env: fixture.env,
        packageRoot: fixture.packageRoot,
        startForegroundServe: async () =>
          createOwner(3777, { terminated: Promise.resolve(failedSnapshot()) })
      });

      expect(startup).toMatchObject({
        exitCode: cliExitCodes.apiError,
        stdout: ""
      });
      expect(startup.stderr).toContain("failed during listener");
      expect(startup.stderr).not.toContain(fixture.root);
      expect(failed).toMatchObject({
        exitCode: cliExitCodes.apiError,
        stdout: ""
      });
      expect(failed.stderr).toContain("terminated in a failed state");
    } finally {
      fixture.cleanup();
    }
  });

  it("closes the owner when readiness output or state validation fails", async () => {
    const fixture = createFixture();
    let outputCloseCalls = 0;
    let stateCloseCalls = 0;
    try {
      const output = await runCli(["serve"], {
        env: fixture.env,
        packageRoot: fixture.packageRoot,
        startForegroundServe: async () =>
          createOwner(3777, {
            close: async () => {
              outputCloseCalls += 1;
            }
          }),
        writeServeReady: () => {
          throw new Error(`private output ${fixture.root}`);
        }
      });
      const state = await runCli(["serve"], {
        env: fixture.env,
        packageRoot: fixture.packageRoot,
        startForegroundServe: async () =>
          createOwner(3777, {
            close: async () => {
              stateCloseCalls += 1;
            },
            snapshot: () => ({
              ...readySnapshot(),
              listener_health: "not_ready"
            })
          })
      });

      expect(output).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(output.stderr).not.toContain(fixture.root);
      expect(state).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(outputCloseCalls).toBe(1);
      expect(stateCloseCalls).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("closes rejected and contradictory terminal owners without exposing causes", async () => {
    const fixture = createFixture();
    const rejectedTerminal = deferred<HostDeckProductionForegroundServeSnapshot>();
    const readyWrites: string[] = [];
    let rejectedCloseCalls = 0;
    let contradictoryCloseCalls = 0;
    try {
      const pendingRejected = runCli(["serve"], {
        env: fixture.env,
        packageRoot: fixture.packageRoot,
        startForegroundServe: async () =>
          createOwner(3777, {
            close: async () => {
              rejectedCloseCalls += 1;
            },
            terminated: rejectedTerminal.promise
          }),
        writeServeReady: (output) => readyWrites.push(output)
      });
      await Promise.resolve();
      await Promise.resolve();
      rejectedTerminal.reject(new Error(`private terminal ${fixture.root}`));
      const rejected = await pendingRejected;
      const contradictory = await runCli(["serve"], {
        env: fixture.env,
        packageRoot: fixture.packageRoot,
        startForegroundServe: async () =>
          createOwner(3777, {
            close: async () => {
              contradictoryCloseCalls += 1;
              throw new Error(`private cleanup ${fixture.root}`);
            },
            terminated: Promise.resolve({
              ...closedSnapshot(),
              listener: { listening: true }
            } as HostDeckProductionForegroundServeSnapshot)
          })
      });

      expect(readyWrites).toEqual([
        "HostDeck foreground service ready at http://127.0.0.1:3777.\n"
      ]);
      expect(rejected).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(rejected.stderr).not.toContain(fixture.root);
      expect(contradictory).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(contradictory.stderr).not.toContain(fixture.root);
      expect(rejectedCloseCalls).toBe(1);
      expect(contradictoryCloseCalls).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-executable-cli-"));
  const packageRoot = join(root, "package");
  const configDir = join(root, "config", "hostdeck");
  const stateDir = join(root, "state", "hostdeck");
  const runtimeDir = join(root, "runtime", "hostdeck");
  const databasePath = join(stateDir, "hostdeck.sqlite");
  const commandDir = join(root, "bin");
  const codexBin = join(commandDir, "codex");
  mkdirSync(packageRoot, { mode: 0o700, recursive: true });
  mkdirSync(commandDir, { mode: 0o700, recursive: true });
  writeFileSync(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(codexBin, 0o700);
  return {
    root,
    packageRoot,
    configDir,
    stateDir,
    runtimeDir,
    databasePath,
    commandDir,
    codexBin,
    env: {
      HOME: root,
      HOSTDECK_CODEX_BIN: codexBin,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state")
    },
    cleanup: () => rmSync(root, { force: true, recursive: true })
  };
}

function createOwner(
  port: number,
  overrides: Partial<{
    close: HostDeckProductionForegroundServe["close"];
    snapshot: HostDeckProductionForegroundServe["snapshot"];
    terminated: HostDeckProductionForegroundServe["terminated"];
  }> = {}
): HostDeckProductionForegroundServe {
  return Object.freeze({
    local_origin: `http://127.0.0.1:${port}`,
    close: overrides.close ?? (async () => undefined),
    snapshot: overrides.snapshot ?? readySnapshot,
    terminated: overrides.terminated ?? Promise.resolve(closedSnapshot())
  });
}

function readySnapshot(): HostDeckProductionForegroundServeSnapshot {
  return {
    phase: "ready",
    listener_health: "ready"
  } as unknown as HostDeckProductionForegroundServeSnapshot;
}

function closedSnapshot(): HostDeckProductionForegroundServeSnapshot {
  return {
    phase: "closed",
    listener_health: "closed",
    listener: { listening: false }
  } as unknown as HostDeckProductionForegroundServeSnapshot;
}

function failedSnapshot(): HostDeckProductionForegroundServeSnapshot {
  return {
    phase: "failed",
    listener_health: "failed",
    listener: { listening: false }
  } as unknown as HostDeckProductionForegroundServeSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((selectedResolve, selectedReject) => {
    resolve = selectedResolve;
    reject = selectedReject;
  });
  return { promise, reject, resolve };
}
