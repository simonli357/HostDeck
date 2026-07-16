import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseHostDeckRestartWorkerEnvironment,
  parseHostDeckRestartWorkerReport,
  readBoundedProcessCommandLine,
  readCodexSmokePrivateJson,
  readDirectChildProcessIds,
  readHostDeckRestartWorkerReport,
  writeCodexSmokePrivateJson,
  writeHostDeckRestartWorkerReport
} from "./codex-hostdeck-restart-smoke-support.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("HostDeck restart smoke support", () => {
  it("parses one strict mode-specific environment and rejects path escape", () => {
    const root = tempRoot();
    const env = validEnvironment(root, "service_initial");
    expect(parseHostDeckRestartWorkerEnvironment(env)).toMatchObject({
      mode: "service_initial",
      root,
      service_pid: 1234
    });
    expect(() =>
      parseHostDeckRestartWorkerEnvironment({
        ...env,
        HOSTDECK_RESTART_RESULT_PATH: join(root, "..", "escaped.json")
      })
    ).toThrow(/strict descendant/u);
    expect(() =>
      parseHostDeckRestartWorkerEnvironment({
        ...env,
        HOSTDECK_RESTART_RELEASE_PATH: ""
      })
    ).toThrow(/release path/u);
    expect(
      parseHostDeckRestartWorkerEnvironment(
        validEnvironment(root, "service_restart")
      ).release_path
    ).toBeNull();
  });

  it("round-trips a private atomic report and rejects mutation or insecure files", () => {
    const root = tempRoot();
    const path = join(root, "ready.json");
    const report = readyReport();
    writeHostDeckRestartWorkerReport(path, report);
    expect(readHostDeckRestartWorkerReport(path, "ready")).toEqual(report);
    expect(Object.isFrozen(readHostDeckRestartWorkerReport(path, "ready"))).toBe(
      true
    );
    expect(() => writeHostDeckRestartWorkerReport(path, report)).toThrow();

    const genericPath = join(root, "generic.json");
    writeCodexSmokePrivateJson(genericPath, { proof: true });
    expect(readCodexSmokePrivateJson(genericPath)).toEqual({ proof: true });
    expect(() =>
      writeCodexSmokePrivateJson(join(root, "undefined.json"), undefined)
    ).toThrow("not JSON serializable");

    const insecure = join(root, "insecure.json");
    writeFileSync(insecure, JSON.stringify(report), { mode: 0o644 });
    chmodSync(insecure, 0o644);
    expect(() => readHostDeckRestartWorkerReport(insecure, "ready")).toThrow(
      /insecure/u
    );

    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify(report), { mode: 0o600 });
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expect(() => readHostDeckRestartWorkerReport(link, "ready")).toThrow(
      /insecure/u
    );
  });

  it("rejects extra fields, cross-mode identities, unsafe counters, and wrong phases", () => {
    const valid = readyReport();
    expect(() =>
      parseHostDeckRestartWorkerReport({ ...valid, extra: true })
    ).toThrow(/fields/u);
    expect(() =>
      parseHostDeckRestartWorkerReport({
        ...valid,
        mode: "foreground_first"
      })
    ).toThrow(/identity/u);
    expect(() =>
      parseHostDeckRestartWorkerReport({
        ...valid,
        boundary_count: -1
      })
    ).toThrow(/boundary count/u);

    const root = tempRoot();
    const path = join(root, "ready.json");
    writeHostDeckRestartWorkerReport(path, valid);
    expect(() => readHostDeckRestartWorkerReport(path, "completed")).toThrow(
      /phase/u
    );
  });

  it("finds a direct child spawned from the active Vitest worker thread", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore"
    });
    if (child.pid === undefined) throw new Error("Child process did not publish a pid.");
    try {
      const found = await waitForChild(child.pid);
      expect(found).toBe(child.pid);
      expect(readBoundedProcessCommandLine(found)).toContain("setTimeout");
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
});

async function waitForChild(expectedPid: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    const found = readDirectChildProcessIds().find((pid) => pid === expectedPid);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Direct child was absent from the bounded process inventory.");
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-restart-support-"));
  roots.push(root);
  return root;
}

function validEnvironment(
  root: string,
  mode:
    | "foreground_first"
    | "service_initial"
    | "service_restart"
): NodeJS.ProcessEnv {
  return {
    HOSTDECK_RESTART_WORKER_MODE: mode,
    HOSTDECK_RESTART_ROOT: root,
    HOSTDECK_RESTART_STATE_DIR: join(root, "state"),
    HOSTDECK_RESTART_CONFIG_DIR: join(root, "config"),
    HOSTDECK_RESTART_RUNTIME_DIR: join(root, "runtime"),
    HOSTDECK_RESTART_DATABASE_PATH: join(root, "state", "hostdeck.sqlite"),
    HOSTDECK_RESTART_CODEX_HOME: join(root, "codex-home"),
    HOSTDECK_RESTART_CODEX_BIN: "/tmp/codex",
    HOSTDECK_RESTART_PROJECT_DIR: join(root, "project"),
    HOSTDECK_RESTART_MARKER_PATH: join(root, "project", "marker"),
    HOSTDECK_RESTART_SHARED_PATH: join(root, "shared.json"),
    HOSTDECK_RESTART_READY_PATH: join(root, "ready.json"),
    HOSTDECK_RESTART_RESULT_PATH: join(root, "result.json"),
    HOSTDECK_RESTART_RELEASE_PATH: join(root, "release"),
    HOSTDECK_RESTART_SERVICE_PID: "1234"
  };
}

function readyReport() {
  return {
    schema_version: 1,
    phase: "ready",
    mode: "service_initial",
    hostdeck_pid: 22,
    runtime_pid: 11,
    lease_pid: 22,
    lease_replaced_stale_metadata: false,
    socket_identity: "1:2",
    thread_id: "thread-a",
    turn_id: "turn-a",
    turn_state: "in_progress",
    compatibility_state: "ready",
    generation: null,
    boundary_count: 0,
    resumed_count: 0,
    ready_count: 0,
    supervisor: {
      mode: "service_owned",
      phase: "ready",
      spawn_attempts: 0,
      term_signals: 0,
      kill_signals: 0,
      cleanup_failures: 0
    }
  } as const;
}
