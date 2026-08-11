import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodexWindowsRuntimeProcessRequest
} from "./codex-windows-runtime-supervisor.js";
import {
  type CodexWindowsRuntimeJob,
  type CodexWindowsRuntimeJobPort,
  createNodeCodexWindowsRuntimeProcessPort,
  HostDeckCodexWindowsRuntimeNativeError
} from "./codex-windows-runtime-supervisor-node.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Codex Windows runtime Node process port", () => {
  it("captures one validated endpoint and terminates only its assigned process", async () => {
    const fixture = createFixture(`
process.stderr.write("listening on: ws://127.0.0.1:32001\\n");
setInterval(() => {}, 1000);
`);
    const jobs = createFakeJobPort();
    const port = createNodeCodexWindowsRuntimeProcessPort(
      jobs.port,
      () => "win32"
    );
    const child = port.spawn(request(fixture.executable, fixture.root));

    await expect(child.endpoint).resolves.toEqual({
      schema_version: 1,
      target: "windows-x64",
      kind: "authenticated_loopback_websocket",
      address: "ws://127.0.0.1:32001",
      port_allocation: "ephemeral_random",
      credential_source: "protected_environment"
    });
    expect(jobs.assignedPids).toHaveLength(1);
    expect(child.isRunning()).toBe(true);
    expect(child.terminateTree()).toBe(true);
    await expect(child.exit).resolves.toEqual({
      kind: "terminated",
      code: null,
      spawn_failure: null
    });
    expect(jobs.terminatedPids).toEqual(jobs.assignedPids);
    expect(child.isRunning()).toBe(false);
  });

  it("rejects ambiguous and oversized stderr without retaining raw output", async () => {
    const fixtures = [
      createFixture(`
process.stderr.write("listening on: ws://127.0.0.1:32001\\nlistening on: ws://127.0.0.1:32002\\n");
setInterval(() => {}, 1000);
`),
      createFixture(`
process.stderr.write("x".repeat(70 * 1024));
setInterval(() => {}, 1000);
`)
    ];
    for (const fixture of fixtures) {
      const jobs = createFakeJobPort();
      const child = createNodeCodexWindowsRuntimeProcessPort(
        jobs.port,
        () => "win32"
      ).spawn(request(fixture.executable, fixture.root));
      await expect(child.endpoint).rejects.toEqual(
        expect.objectContaining({
          name: "HostDeckCodexWindowsRuntimeNativeError",
          code: "process_io_failed",
          message: "Codex Windows runtime native operation failed."
        })
      );
      expect(child.terminateTree()).toBe(true);
      await child.exit;
    }
  });

  it("closes the owned job when the root exits and reports bounded exit truth", async () => {
    const fixture = createFixture(`
process.stderr.write("listening on: ws://127.0.0.1:32003\\n");
process.exitCode = 7;
`);
    const jobs = createFakeJobPort();
    const child = createNodeCodexWindowsRuntimeProcessPort(
      jobs.port,
      () => "win32"
    ).spawn(request(fixture.executable, fixture.root));
    await child.endpoint;
    await expect(child.exit).resolves.toEqual({
      kind: "exited",
      code: 7,
      spawn_failure: null
    });
    expect(jobs.closedPids).toEqual(jobs.assignedPids);
  });

  it("normalizes a numeric exit after accepted Job termination", async () => {
    const fixture = createFixture(`
process.stderr.write("listening on: ws://127.0.0.1:32004\\n");
setTimeout(() => process.exit(7), 250);
`);
    const jobs = createFakeJobPort({ killOnTerminate: false });
    const child = createNodeCodexWindowsRuntimeProcessPort(
      jobs.port,
      () => "win32"
    ).spawn(request(fixture.executable, fixture.root));
    await child.endpoint;

    expect(child.terminateTree()).toBe(true);
    await expect(child.exit).resolves.toEqual({
      kind: "terminated",
      code: null,
      spawn_failure: null
    });
  });

  it("fails before returning authority on unsupported platform or job assignment", () => {
    const fixture = createFixture("setInterval(() => {}, 1000);");
    const jobs = createFakeJobPort();
    expect(() =>
      createNodeCodexWindowsRuntimeProcessPort(jobs.port, () => "linux").spawn(
        request(fixture.executable, fixture.root)
      )
    ).toThrowError(
      expect.objectContaining({
        name: "HostDeckCodexWindowsRuntimeNativeError",
        code: "process_io_failed"
      })
    );

    const rejecting: CodexWindowsRuntimeJobPort = Object.freeze({
      createKillOnClose: () =>
        Object.freeze({
          assign() {
            throw new Error("private assignment detail");
          },
          terminate: () => false,
          close: () => undefined
        })
    });
    expect(() =>
      createNodeCodexWindowsRuntimeProcessPort(rejecting, () => "win32").spawn(
        request(fixture.executable, fixture.root)
      )
    ).toThrowError(
      expect.objectContaining({
        name: "HostDeckCodexWindowsRuntimeNativeError",
        code: "job_io_failed",
        message: "Codex Windows runtime native operation failed."
      })
    );
  });
});

function createFixture(body: string): { readonly executable: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-windows-process-port-"));
  roots.push(root);
  const executable = join(root, "fixture-codex.exe");
  writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`, {
    encoding: "utf8",
    mode: 0o700
  });
  chmodSync(executable, 0o700);
  return Object.freeze({ executable, root });
}

function request(
  executable: string,
  cwd: string
): CodexWindowsRuntimeProcessRequest {
  const args: CodexWindowsRuntimeProcessRequest["args"] = Object.freeze([
    "app-server",
    "--strict-config",
    "--listen",
    "ws://127.0.0.1:0",
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    join(cwd, "app-server.credential")
  ]);
  return Object.freeze({
    executable,
    args,
    cwd,
    environment: Object.freeze({ PATH: process.env.PATH ?? "/usr/bin" })
  });
}

function createFakeJobPort(
  options: { readonly killOnTerminate?: boolean } = {}
) {
  const assignedPids: number[] = [];
  const terminatedPids: number[] = [];
  const closedPids: number[] = [];
  const port: CodexWindowsRuntimeJobPort = Object.freeze({
    createKillOnClose() {
      let pid: number | null = null;
      let closed = false;
      const job: CodexWindowsRuntimeJob = Object.freeze({
        assign(candidate: number) {
          if (pid !== null || closed) throw new Error("duplicate assignment");
          pid = candidate;
          assignedPids.push(candidate);
        },
        terminate() {
          if (pid === null || closed) return false;
          terminatedPids.push(pid);
          if (options.killOnTerminate !== false) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
          return true;
        },
        close() {
          if (closed) return;
          closed = true;
          if (pid !== null) closedPids.push(pid);
        }
      });
      return job;
    }
  });
  return { assignedPids, closedPids, port, terminatedPids };
}

void HostDeckCodexWindowsRuntimeNativeError;
