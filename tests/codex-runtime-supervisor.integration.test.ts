import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultResourceBudget } from "../packages/contracts/src/index.js";
import { createOperationDeadline } from "../packages/core/src/index.js";
import {
  createCodexRuntimeSupervisor,
  type HostDeckCodexRuntimeSupervisor
} from "../packages/server/src/index.js";

const roots: string[] = [];
const externalChildren: ChildProcess[] = [];

afterEach(async () => {
  for (const child of externalChildren.splice(0)) {
    await stopExternalChild(child);
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Codex runtime supervisor Linux process/socket boundary", () => {
  it("spawns the fixed foreground command, repairs the private socket, and reverses cleanup", async () => {
    const layout = fixtureLayout("foreground", "graceful");
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: layout.executable,
      socket_path: layout.socketPath
    });
    const started = await startSupervisor(supervisor);

    expect(JSON.parse(readFileSync(layout.argvPath, "utf8"))).toEqual([
      "app-server",
      "--listen",
      `unix://${layout.socketPath}`
    ]);
    expect(lstatSync(layout.runtimeDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.socketPath).isSocket()).toBe(true);
    expect(lstatSync(layout.socketPath).mode & 0o7777).toBe(0o600);
    expect(started).toMatchObject({
      ownership: "foreground_child",
      socket_mode_repaired: true,
      stale_socket_removed: false
    });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      process_state: "running",
      socket_ready: true,
      spawn_attempts: 1
    });

    await closeSupervisor(supervisor, 2_000);
    await expect(started.process_exit).resolves.toMatchObject({
      kind: "exited",
      expected: true,
      code: 0,
      signal: null
    });
    expect(existsSync(layout.socketPath)).toBe(false);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "closed",
      claim_held: false,
      socket_ready: false,
      process_state: "exited",
      term_signals: 1,
      kill_signals: 0,
      cleanup_failures: 0
    });

    const restarted = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: layout.executable,
      socket_path: layout.socketPath
    });
    await startSupervisor(restarted);
    await closeSupervisor(restarted, 2_000);
    expect(existsSync(layout.socketPath)).toBe(false);
  });

  it("observes a service sibling but does not signal or unlink it on close or conflict", async () => {
    const layout = fixtureLayout("service", "graceful");
    const sibling = spawn(
      layout.executable,
      ["app-server", "--listen", `unix://${layout.socketPath}`],
      {
        cwd: "/",
        shell: false,
        stdio: "ignore"
      }
    );
    externalChildren.push(sibling);

    const service = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: layout.socketPath
    });
    const started = await startSupervisor(service);
    expect(started.process_exit).toBeNull();
    expect(lstatSync(layout.socketPath).mode & 0o7777).toBe(0o600);
    await closeSupervisor(service, 1_000);
    expect(sibling.exitCode).toBeNull();
    expect(sibling.signalCode).toBeNull();
    expect(existsSync(layout.socketPath)).toBe(true);
    expect(service.snapshot()).toMatchObject({
      phase: "closed",
      process_state: "not_applicable",
      spawn_attempts: 0,
      term_signals: 0,
      kill_signals: 0
    });

    const foreground = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: layout.executable,
      socket_path: layout.socketPath
    });
    await expectStartError(foreground, "socket_active");
    expect(foreground.snapshot().spawn_attempts).toBe(0);
    expect(sibling.exitCode).toBeNull();
    expect(sibling.signalCode).toBeNull();
    expect(existsSync(layout.socketPath)).toBe(true);
  });

  it("maps real asynchronous missing and non-executable spawn failures", async () => {
    const missing = fixtureLayout("missing", "graceful", false);
    const missingSupervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: join(missing.root, "not-installed-codex"),
      socket_path: missing.socketPath
    });
    await expectStartError(missingSupervisor, "binary_missing");
    expect(existsSync(missing.socketPath)).toBe(false);
    expect(missingSupervisor.snapshot()).toMatchObject({
      claim_held: false,
      process_state: "exited"
    });

    const denied = fixtureLayout("denied", "graceful");
    chmodSync(denied.executable, 0o600);
    const deniedSupervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: denied.executable,
      socket_path: denied.socketPath
    });
    await expectStartError(deniedSupervisor, "binary_not_executable");
    expect(existsSync(denied.socketPath)).toBe(false);
    expect(deniedSupervisor.snapshot().claim_held).toBe(false);
  });

  it("rejects insecure parents and hostile socket path types before process creation", async () => {
    const insecure = fixtureLayout("insecure", "graceful");
    chmodSync(insecure.runtimeDir, 0o755);
    const insecureSupervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: insecure.executable,
      socket_path: insecure.socketPath
    });
    await expectStartError(insecureSupervisor, "socket_insecure");
    expect(existsSync(insecure.argvPath)).toBe(false);
    expect(insecureSupervisor.snapshot().spawn_attempts).toBe(0);

    const hostile = fixtureLayout("hostile", "graceful");
    const target = join(hostile.runtimeDir, "target-file");
    writeFileSync(target, "not a socket", { mode: 0o600 });
    symlinkSync(target, hostile.socketPath);
    const hostileSupervisor = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: hostile.socketPath
    });
    await expectStartError(hostileSupervisor, "socket_insecure");
    expect(lstatSync(hostile.socketPath).isSymbolicLink()).toBe(true);
    expect(hostileSupervisor.snapshot()).toMatchObject({
      claim_held: false,
      spawn_attempts: 0
    });
  });

  it("escalates a real owned child that ignores TERM and removes its socket", async () => {
    const layout = fixtureLayout("kill", "ignore-term");
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: layout.executable,
      socket_path: layout.socketPath
    });
    const started = await startSupervisor(supervisor);
    await closeSupervisor(supervisor, 600);
    await expect(started.process_exit).resolves.toMatchObject({
      kind: "signaled",
      expected: true,
      code: null,
      signal: "SIGKILL"
    });
    expect(existsSync(layout.socketPath)).toBe(false);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "closed",
      term_signals: 1,
      kill_signals: 1,
      cleanup_failures: 0
    });
  });
});

async function startSupervisor(
  supervisor: HostDeckCodexRuntimeSupervisor
) {
  const deadline = createOperationDeadline({ timeoutMs: 3_000 });
  try {
    return await supervisor.start({
      deadline,
      resourceBudget: defaultResourceBudget
    });
  } finally {
    deadline.dispose();
  }
}

async function closeSupervisor(
  supervisor: HostDeckCodexRuntimeSupervisor,
  timeoutMs: number
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs });
  try {
    await supervisor.close({ deadline });
  } finally {
    deadline.dispose();
  }
}

async function expectStartError(
  supervisor: HostDeckCodexRuntimeSupervisor,
  code: string
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs: 1_000 });
  try {
    await expect(
      supervisor.start({
        deadline,
        resourceBudget: defaultResourceBudget
      })
    ).rejects.toMatchObject({
      name: "HostDeckCodexRuntimeSupervisorError",
      code
    });
  } finally {
    deadline.dispose();
  }
}

function fixtureLayout(
  label: string,
  behavior: "graceful" | "ignore-term",
  createExecutable = true
): {
  readonly root: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly executable: string;
  readonly argvPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-supervisor-${label}-`));
  roots.push(root);
  chmodSync(root, 0o700);
  const runtimeDir = root;
  const socketPath = join(runtimeDir, "app-server.sock");
  const executable = join(root, "codex-fixture.mjs");
  const argvPath = `${socketPath}.argv`;
  if (createExecutable) {
    writeFileSync(executable, fixtureSource(behavior), { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  return { root, runtimeDir, socketPath, executable, argvPath };
}

function fixtureSource(behavior: "graceful" | "ignore-term"): string {
  return `#!/usr/bin/env node
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "app-server" || args[1] !== "--listen" || !args[2].startsWith("unix://")) process.exit(64);
const socketPath = args[2].slice("unix://".length);
writeFileSync(socketPath + ".argv", JSON.stringify(args), { mode: 0o600 });
const server = createServer((socket) => socket.destroy());
server.on("error", () => process.exit(70));
server.listen(socketPath, () => chmodSync(socketPath, 0o666));
process.on("SIGTERM", () => {
  if (${JSON.stringify(behavior)} === "ignore-term") return;
  server.close(() => process.exit(0));
});
`;
}

async function stopExternalChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(closed, 1_000)) return;
  child.kill("SIGKILL");
  await settlesWithin(closed, 1_000);
}

async function settlesWithin(
  promise: Promise<void>,
  milliseconds: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  const result = await Promise.race([promise.then(() => true as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
