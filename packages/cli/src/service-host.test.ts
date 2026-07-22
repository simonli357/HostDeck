import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HostDeckProductionServiceServe,
  HostDeckProductionServiceServeSnapshot,
  StartHostDeckProductionServiceServeInput
} from "@hostdeck/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mainHostDeckServiceHost,
  runHostDeckServiceHost
} from "./service-host.js";

const roots: string[] = [];

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-086 packaged service-host process", () => {
  it("rejects every argument before environment or service access", async () => {
    let envRead = false;
    const env = Object.defineProperty({}, "HOSTDECK_CODEX_BIN", {
      enumerable: true,
      get() {
        envRead = true;
        return "/private/codex";
      }
    }) as Readonly<Record<string, string | undefined>>;
    const startService = vi.fn();

    await expect(
      runHostDeckServiceHost(["serve"], { env, startService })
    ).rejects.toThrow("does not accept arguments");
    expect(envRead).toBe(false);
    expect(startService).not.toHaveBeenCalled();
  });

  it("requires explicit Codex identity before config or service access", async () => {
    let configRead = false;
    const env = Object.defineProperty(
      { PATH: "/usr/bin" },
      "HOME",
      {
        enumerable: true,
        get() {
          configRead = true;
          return "/private/home";
        }
      }
    ) as Readonly<Record<string, string | undefined>>;
    const startService = vi.fn();

    await expect(
      runHostDeckServiceHost([], { env, startService })
    ).rejects.toThrow("HOSTDECK_CODEX_BIN is required");
    expect(configRead).toBe(false);
    expect(startService).not.toHaveBeenCalled();
  });

  it("starts one exact service-owned process input and publishes readiness once", async () => {
    const layout = fixtureLayout("ready");
    const owner = fakeServiceOwner(layout.origin);
    const observedInputs: StartHostDeckProductionServiceServeInput[] = [];
    const ready: string[] = [];
    const running = runHostDeckServiceHost([], {
      env: layout.env,
      packageRoot: layout.packageRoot,
      startService: async (input) => {
        observedInputs.push(input);
        return owner.service;
      },
      writeReady: (output) => ready.push(output)
    });

    await vi.waitFor(() => expect(observedInputs).toHaveLength(1));
    const observedInput = observedInputs[0];
    expect(observedInput).toMatchObject({
      browser_routes: ["/", "/sessions/:session_id"],
      codex_bin: layout.codexBin,
      config_dir: join(layout.configHome, "hostdeck"),
      database_path: join(layout.stateHome, "hostdeck", "hostdeck.sqlite"),
      loopback_port: layout.port,
      runtime_dir: join(layout.runtimeHome, "hostdeck"),
      state_dir: join(layout.stateHome, "hostdeck"),
      static_build_root: join(layout.packageRoot, "web")
    });
    expect(Object.isFrozen(observedInput?.browser_routes)).toBe(true);
    expect(ready).toEqual([`HostDeck service ready at ${layout.origin}.\n`]);

    owner.finishClosed();
    await expect(running).resolves.toBe("");
    expect(owner.closeCalls).toBe(0);
  });

  it("closes on readiness-output failure and rejects contradictory terminal state", async () => {
    const outputLayout = fixtureLayout("output-failure");
    const outputOwner = fakeServiceOwner(outputLayout.origin);
    await expect(
      runHostDeckServiceHost([], {
        env: outputLayout.env,
        packageRoot: outputLayout.packageRoot,
        startService: async () => outputOwner.service,
        writeReady: () => {
          throw new Error("private output failure");
        }
      })
    ).rejects.toThrow("private output failure");
    expect(outputOwner.closeCalls).toBe(1);

    const asyncOutputLayout = fixtureLayout("async-output-failure");
    const asyncOutputOwner = fakeServiceOwner(asyncOutputLayout.origin);
    await expect(
      runHostDeckServiceHost([], {
        env: asyncOutputLayout.env,
        packageRoot: asyncOutputLayout.packageRoot,
        startService: async () => asyncOutputOwner.service,
        writeReady: async () => undefined
      })
    ).rejects.toThrow("writer must be synchronous");
    expect(asyncOutputOwner.closeCalls).toBe(1);

    const terminalLayout = fixtureLayout("terminal-failure");
    const terminalOwner = fakeServiceOwner(terminalLayout.origin);
    const running = runHostDeckServiceHost([], {
      env: terminalLayout.env,
      packageRoot: terminalLayout.packageRoot,
      startService: async () => terminalOwner.service,
      writeReady: () => undefined
    });
    terminalOwner.finishFailed();
    await expect(running).rejects.toBeDefined();
    expect(terminalOwner.closeCalls).toBe(1);
  });

  it("maps all direct-process failures to one bounded generic stderr line", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await expect(
      mainHostDeckServiceHost(["unexpected"], {
        env: Object.freeze({})
      })
    ).resolves.toBe(1);
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(
      "HostDeck service failed to start or stop cleanly.\n"
    );
  });
});

interface FixtureLayout {
  readonly codexBin: string;
  readonly configHome: string;
  readonly env: Readonly<Record<string, string>>;
  readonly origin: string;
  readonly packageRoot: string;
  readonly port: number;
  readonly runtimeHome: string;
  readonly stateHome: string;
}

function fixtureLayout(label: string): FixtureLayout {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-service-host-${label}-`));
  roots.push(root);
  chmodSync(root, 0o700);
  const packageRoot = join(root, "package");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const runtimeHome = join(root, "runtime");
  const home = join(root, "home");
  for (const path of [packageRoot, configHome, stateHome, runtimeHome, home]) {
    mkdirSync(path, { mode: 0o700 });
  }
  const codexBin = join(root, "codex");
  writeFileSync(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(codexBin, 0o700);
  const port = 47_000 + roots.length;
  const origin = `http://127.0.0.1:${port}`;
  return Object.freeze({
    codexBin,
    configHome,
    env: Object.freeze({
      HOME: home,
      HOSTDECK_CODEX_BIN: codexBin,
      HOSTDECK_PORT: String(port),
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtimeHome,
      XDG_STATE_HOME: stateHome
    }),
    origin,
    packageRoot,
    port,
    runtimeHome,
    stateHome
  });
}

interface FakeServiceOwner {
  readonly service: HostDeckProductionServiceServe;
  readonly finishClosed: () => void;
  readonly finishFailed: () => void;
  readonly closeCalls: number;
}

function fakeServiceOwner(origin: string): FakeServiceOwner {
  let closeCalls = 0;
  let phase: HostDeckProductionServiceServeSnapshot["phase"] = "ready";
  let resolveTerminated!: (
    snapshot: HostDeckProductionServiceServeSnapshot
  ) => void;
  const terminated = new Promise<HostDeckProductionServiceServeSnapshot>(
    (resolve) => {
      resolveTerminated = resolve;
    }
  );
  const snapshot = (): HostDeckProductionServiceServeSnapshot =>
    ({
      phase,
      termination_trigger: phase === "ready" ? null : "manual",
      application: Object.freeze({}),
      listener: Object.freeze({
        listening: phase === "ready",
        phase: phase === "ready" ? "ready" : phase
      }),
      listener_health: phase === "ready" ? "ready" : phase,
      remote_phase: phase === "ready" ? "running" : phase,
      remote_availability: "unknown",
      remote_reason: "not_observed",
      reported_issue_count: 0,
      observer_failure_count: 0,
      last_issue: null
    }) as HostDeckProductionServiceServeSnapshot;
  const finish = (selected: "closed" | "failed") => {
    phase = selected;
    resolveTerminated(snapshot());
  };
  const service: HostDeckProductionServiceServe = Object.freeze({
    local_origin: origin,
    async close() {
      closeCalls += 1;
      finish("closed");
    },
    snapshot,
    terminated
  });
  return {
    service,
    finishClosed: () => finish("closed"),
    finishFailed: () => finish("failed"),
    get closeCalls() {
      return closeCalls;
    }
  };
}
