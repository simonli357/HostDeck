import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexLifecycleScenarioError,
  runOwnedLifecycleScenario
} from "./codex-runtime-lifecycle-process.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0).reverse()) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("owned lifecycle scenario process runner", () => {
  it("runs one detached zero-exit process and returns count-only output facts", async () => {
    const root = privateRoot();
    const result = await runOwnedLifecycleScenario(
      command(root, ["-e", "setTimeout(() => process.exit(0), 50)"])
    );

    expect(result).toEqual({
      scenario: "fixture",
      exit_code: 0,
      stdout_bytes: 0,
      stderr_bytes: 0
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("reports nonzero exit without retaining child output", async () => {
    const root = privateRoot();
    await expect(
      runOwnedLifecycleScenario(
        command(root, [
          "-e",
          "setTimeout(() => { process.stdout.write('private'); process.exit(3); }, 30)"
        ])
      )
    ).rejects.toMatchObject({
      name: "CodexLifecycleScenarioError",
      code: "nonzero_exit",
      scenario: "fixture",
      message: "Lifecycle scenario exited unsuccessfully."
    });
  });

  it("terminates the complete owned group on timeout", async () => {
    const root = privateRoot();
    const pidPath = join(root, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn('/usr/bin/sleep', ['60'], { stdio: 'ignore' });",
      "writeFileSync(process.env.HOSTDECK_FIXTURE_PID, String(child.pid));",
      "setInterval(() => undefined, 1000);"
    ].join("");

    await expect(
      runOwnedLifecycleScenario({
        ...command(root, ["-e", script]),
        env: {
          ...process.env,
          HOSTDECK_FIXTURE_PID: pidPath
        },
        timeout_ms: 150
      })
    ).rejects.toMatchObject({ code: "timeout" });

    const descendantPid = Number(readFileSync(pidPath, "utf8"));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(isProcessAlive(descendantPid)).toBe(false);
  });

  it("escalates to KILL when the owned group ignores TERM", async () => {
    const root = privateRoot();
    const started = Date.now();

    await expect(
      runOwnedLifecycleScenario({
        ...command(root, [
          "-e",
          "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"
        ]),
        timeout_ms: 100
      })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  });

  it("terminates the owned group when combined output exceeds its bound", async () => {
    const root = privateRoot();
    await expect(
      runOwnedLifecycleScenario({
        ...command(root, [
          "-e",
          "process.stdout.write('x'.repeat(2048)); setInterval(() => undefined, 1000)"
        ]),
        max_output_bytes: 1_024
      })
    ).rejects.toMatchObject({ code: "output_overflow" });
  });

  it("rejects accessor options before process creation", async () => {
    const root = privateRoot();
    const candidate = command(root, ["-e", "process.exit(0)"]);
    Object.defineProperty(candidate, "scenario", {
      configurable: true,
      enumerable: true,
      get: () => "fixture"
    });

    await expect(runOwnedLifecycleScenario(candidate)).rejects.toBeInstanceOf(
      CodexLifecycleScenarioError
    );
    await expect(runOwnedLifecycleScenario(candidate)).rejects.toMatchObject({
      code: "invalid_command"
    });
  });

  it("rejects an oversized inherited environment before process creation", async () => {
    const root = privateRoot();
    const env = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`HOSTDECK_${index}`, "x"])
    );

    await expect(
      runOwnedLifecycleScenario({
        ...command(root, ["-e", "process.exit(0)"]),
        env
      })
    ).rejects.toMatchObject({ code: "invalid_command" });
  });
});

function command(root: string, args: readonly string[]) {
  return {
    scenario: "fixture",
    executable: process.execPath,
    args,
    cwd: root,
    env: { ...process.env },
    timeout_ms: 5_000,
    max_output_bytes: 4_096
  };
}

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-lifecycle-process-"));
  chmodSync(root, 0o700);
  cleanup.push(root);
  return root;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ESRCH"
    );
  }
}
