import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectSystemdCommandRunner } from "./systemd-user-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-056 direct systemd command boundary", () => {
  it("preserves exact arguments and uses a fixed working directory", async () => {
    const root = fixtureRoot();
    const observation = join(root, "observation.json");
    const executable = executableFixture(
      root,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(observation)}, JSON.stringify({`,
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "  private_env: process.env.HOSTDECK_PRIVATE_SENTINEL ?? null",
        "}));",
        'process.stdout.write("ready");',
        'process.stderr.write("diagnostic");'
      ].join("\n")
    );
    const previousSentinel = process.env.HOSTDECK_PRIVATE_SENTINEL;
    process.env.HOSTDECK_PRIVATE_SENTINEL = "must-not-cross-boundary";
    const run = createDirectSystemdCommandRunner(executable);
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(["--user", "show", "hostdeck.service"], bounds());
    } finally {
      if (previousSentinel === undefined) {
        delete process.env.HOSTDECK_PRIVATE_SENTINEL;
      } else {
        process.env.HOSTDECK_PRIVATE_SENTINEL = previousSentinel;
      }
    }

    expect(result).toEqual({
      exit_code: 0,
      stderr: "diagnostic",
      stdout: "ready"
    });
    expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({
      argv: ["--user", "show", "hostdeck.service"],
      cwd: "/",
      private_env: null
    });
  });

  it("bounds aggregate stdout and stderr", async () => {
    const root = fixtureRoot();
    const run = createDirectSystemdCommandRunner(
      executableFixture(
        root,
        'process.stdout.write("x".repeat(60)); process.stderr.write("y".repeat(60));'
      )
    );

    await expect(
      run(["--user"], { max_output_bytes: 100, timeout_ms: 1_000 })
    ).rejects.toMatchObject({ code: "output_exceeded" });
  });

  it("rejects output that is not valid UTF-8", async () => {
    const root = fixtureRoot();
    const run = createDirectSystemdCommandRunner(
      executableFixture(
        root,
        "process.stdout.write(Buffer.from([0xc3, 0x28]));"
      )
    );

    await expect(run(["--user"], bounds())).rejects.toMatchObject({
      code: "invalid_output"
    });
  });

  it("kills the complete owned process group on timeout", async () => {
    const root = fixtureRoot();
    const childPidPath = join(root, "child.pid");
    const run = createDirectSystemdCommandRunner(
      executableFixture(
        root,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          "const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], { stdio: \"ignore\" });",
          `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
          "setInterval(() => {}, 1000);"
        ].join("\n")
      )
    );

    await expect(
      run(["--user"], { max_output_bytes: 1_024, timeout_ms: 500 })
    ).rejects.toMatchObject({ code: "timed_out" });
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(await processIsRunning(childPid)).toBe(false);
  });

  it("kills the process group when aborted", async () => {
    const root = fixtureRoot();
    const run = createDirectSystemdCommandRunner(
      executableFixture(root, "setInterval(() => {}, 1000);")
    );
    const controller = new AbortController();
    const pending = run(["--user"], {
      max_output_bytes: 1_024,
      signal: controller.signal,
      timeout_ms: 1_000
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects an executable removed after runner creation", async () => {
    const root = fixtureRoot();
    const executable = executableFixture(root, "process.exit(0);");
    const run = createDirectSystemdCommandRunner(executable);
    rmSync(executable);

    await expect(run(["--user"], bounds())).rejects.toMatchObject({
      code: "manager_unavailable"
    });
  });

  it("kills and rejects descendants left behind by a successful command", async () => {
    const root = fixtureRoot();
    const childPidPath = join(root, "child.pid");
    const run = createDirectSystemdCommandRunner(
      executableFixture(
        root,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          "const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], { stdio: \"ignore\" });",
          `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
          "child.unref();"
        ].join("\n")
      )
    );

    await expect(run(["--user"], bounds())).rejects.toMatchObject({
      code: "cleanup_failed"
    });
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(await processIsRunning(childPid)).toBe(false);
  });

  it("rejects writable or non-canonical executables before spawning", () => {
    const root = fixtureRoot();
    const executable = executableFixture(root, "process.exit(0);");
    chmodSync(executable, 0o775);

    expect(() => createDirectSystemdCommandRunner(executable)).toThrowError(
      expect.objectContaining({ code: "manager_unavailable" })
    );
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(homedir(), ".hostdeck-systemd-runner-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function executableFixture(root: string, body: string): string {
  const executable = join(root, "systemctl.mjs");
  writeFileSync(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  chmodSync(executable, 0o755);
  return executable;
}

function bounds(): {
  readonly max_output_bytes: number;
  readonly timeout_ms: number;
} {
  return { max_output_bytes: 1_024, timeout_ms: 1_000 };
}

async function processIsRunning(pid: number): Promise<boolean> {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
      if (state === "Z" || state === "X") return false;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
