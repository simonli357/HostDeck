import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import {
  prepareHostDeckLocalPaths,
  resolveNativeWindowsHostDeckDefaultPaths,
  secureHostDeckRegularFile
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexWindowsRuntimeChildProcess,
  type CodexWindowsRuntimeProcessPort,
  type CodexWindowsRuntimeProcessRequest,
  createCodexWindowsRuntimeSupervisor
} from "./codex-windows-runtime-supervisor.js";
import {
  codexWindowsRuntimeCredentialPath,
  createNodeCodexWindowsRuntimeProcessPort
} from "./codex-windows-runtime-supervisor-node.js";

const crashWorkerEnvironment = "HOSTDECK_WINDOWS_SUPERVISOR_CRASH_WORKER";
const crashFixtureDirectoryEnvironment =
  "HOSTDECK_WINDOWS_SUPERVISOR_CRASH_FIXTURE";
const crashPidFileEnvironment = "HOSTDECK_WINDOWS_SUPERVISOR_CRASH_PID_FILE";
const crashArmedFileEnvironment =
  "HOSTDECK_WINDOWS_SUPERVISOR_CRASH_ARMED_FILE";
const thisFile = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(thisFile), "../../..");

if (process.env[crashWorkerEnvironment] === "1") {
  describe("Codex Windows Job crash worker", () => {
    it("starts an owned descendant tree and exits without supervisor cleanup", async () => {
      if (process.platform !== "win32") process.exit(92);
      const cwd = requiredEnvironment(crashFixtureDirectoryEnvironment);
      const child = createNodeCodexWindowsRuntimeProcessPort().spawn(
        processFixtureRequest(cwd, requiredEnvironment(crashPidFileEnvironment))
      );
      await child.endpoint;
      await waitForFile(requiredEnvironment(crashPidFileEnvironment));
      writeFileSync(requiredEnvironment(crashArmedFileEnvironment), "armed\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      process.kill(process.pid, "SIGKILL");
      throw new Error("Codex Windows crash worker remained active.");
    });
  });
} else {
  describe("Codex Windows runtime native contract", () => {
    it("fails closed through the native adapter away from Windows", () => {
      if (process.platform === "win32") return;
      expect(() =>
        createNodeCodexWindowsRuntimeProcessPort().spawn(
          processFixtureRequest("C:\\HostDeck", "C:\\HostDeck\\pids.json")
        )
      ).toThrowError(
        expect.objectContaining({
          name: "HostDeckCodexWindowsRuntimeNativeError",
          code: "process_io_failed"
        })
      );
    });

    it("proves exact Codex ownership, authenticated readiness, rotation, and cleanup", async () => {
      if (process.platform !== "win32") return;
      expect(process.arch).toBe("x64");
      const layout = createNativeLayout();
      const runtime = locateExactWindowsCodex();
      const staleToken = randomBytes(48).toString("base64url");
      const credentialPath = codexWindowsRuntimeCredentialPath(
        layout.paths.app_server_socket_path
      );
      writeFileSync(credentialPath, `${staleToken}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      secureHostDeckRegularFile(credentialPath, {
        label: "Codex Windows runtime stale credential",
        mode: 0o600,
        repair_mode: true
      });
      const nativeProcessPort = createNodeCodexWindowsRuntimeProcessPort();
      const spawnedChildren: CodexWindowsRuntimeChildProcess[] = [];
      const processPort: CodexWindowsRuntimeProcessPort = Object.freeze({
        spawn(request: CodexWindowsRuntimeProcessRequest) {
          const child = nativeProcessPort.spawn(request);
          spawnedChildren.push(child);
          return child;
        }
      });
      const supervisor = createCodexWindowsRuntimeSupervisor({
        codex_bin: runtime.executable,
        cwd: layout.paths.runtime_dir,
        endpoint_file_path: layout.paths.app_server_socket_path,
        environment: {
          ...process.env,
          CODEX_HOME: layout.paths.config_dir,
          CODEX_MANAGED_BY_PNPM: "1",
          CODEX_MANAGED_PACKAGE_ROOT: runtime.managedPackageRoot,
          PATH: `${runtime.pathDirectory};${requiredEnvironment("PATH")}`,
          NO_COLOR: "1"
        },
        process_port: processPort
      });
      const duplicate = createCodexWindowsRuntimeSupervisor({
        codex_bin: runtime.executable,
        cwd: layout.paths.runtime_dir,
        endpoint_file_path: layout.paths.app_server_socket_path,
        environment: {
          ...process.env,
          CODEX_HOME: layout.paths.config_dir,
          PATH: `${runtime.pathDirectory};${requiredEnvironment("PATH")}`
        }
      });

      try {
        const first = await start(supervisor);
        const firstToken = first.credential.read(
          "HOSTDECK_CODEX_REMOTE_AUTH"
        );
        if (firstToken === undefined) {
          throw new TypeError("Codex Windows runtime credential is unavailable.");
        }
        expect(firstToken).toMatch(/^[A-Za-z0-9_-]{64}$/u);
        expect(firstToken).not.toBe(staleToken);
        expect(first.endpoint.address).toMatch(
          /^ws:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/u
        );
        expect(existsSync(credentialPath)).toBe(false);
        expect(supervisor.snapshot()).toMatchObject({
          target: "windows-x64",
          phase: "ready",
          claim_held: true,
          endpoint_ready: true,
          credential_file_present: false,
          generation: 1,
          process_state: "running",
          stale_credential_replacements: 1
        });
        expect(JSON.stringify({ first, snapshot: supervisor.snapshot() })).not.toContain(
          firstToken
        );

        await expect(start(duplicate)).rejects.toEqual(
          expect.objectContaining({
            code: "duplicate_supervisor",
            stage: "claim"
          })
        );

        const firstChild = spawnedChildren[0];
        if (firstChild === undefined || !firstChild.terminateTree()) {
          throw new TypeError("Codex Windows runtime crash injection failed.");
        }
        await expect(first.process_exit).resolves.toEqual({
          kind: "terminated",
          expected: false,
          code: null
        });
        expect(supervisor.snapshot()).toMatchObject({
          phase: "exited",
          claim_held: true,
          endpoint_ready: false,
          process_state: "exited"
        });
        expect(
          first.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")
        ).toBeUndefined();

        const second = await restart(supervisor);
        const secondToken = second.credential.read(
          "HOSTDECK_CODEX_REMOTE_AUTH"
        );
        if (secondToken === undefined) {
          throw new TypeError("Codex Windows runtime credential is unavailable.");
        }
        expect(second.generation).toBe(2);
        expect(second.endpoint.address).not.toBe(first.endpoint.address);
        expect(secondToken).toMatch(/^[A-Za-z0-9_-]{64}$/u);
        expect(secondToken).not.toBe(firstToken);
        expect(
          first.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")
        ).toBeUndefined();
        expect(existsSync(credentialPath)).toBe(false);

        const firstPort = endpointPort(first.endpoint.address);
        const secondPort = endpointPort(second.endpoint.address);
        await close(supervisor);
        await waitForClosedPort(firstPort);
        await waitForClosedPort(secondPort);
        expect(statSync(layout.paths.app_server_socket_path).size).toBe(0);
        expect(existsSync(credentialPath)).toBe(false);
        expect(
          second.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")
        ).toBeUndefined();
      } finally {
        await closeQuietly(supervisor);
        await closeQuietly(duplicate);
        layout.cleanup();
      }
    }, 60_000);

    it("kills the assigned process tree when the supervisor process exits abruptly", async () => {
      if (process.platform !== "win32") return;
      const root = join(
        resolveNativeWindowsHostDeckDefaultPaths().runtime_dir,
        `JobCrash-${process.pid}-${Date.now()}`
      );
      const paths = prepareHostDeckLocalPaths({
        config_dir: join(
          resolveNativeWindowsHostDeckDefaultPaths().config_dir,
          win32.basename(root)
        ),
        state_dir: join(
          resolveNativeWindowsHostDeckDefaultPaths().state_dir,
          win32.basename(root)
        ),
        runtime_dir: root,
        database_path: join(
          resolveNativeWindowsHostDeckDefaultPaths().state_dir,
          win32.basename(root),
          "hostdeck.sqlite"
        )
      });
      const pidFile = join(paths.runtime_dir, "owned-pids.json");
      const armedFile = join(paths.runtime_dir, "crash-armed");
      writeProcessTreeFixture(paths.runtime_dir);
      const vitestEntry = join(
        dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
        "vitest.mjs"
      );
      try {
        const result = spawnSync(
          process.execPath,
          [
            vitestEntry,
            "run",
            thisFile,
            "--config",
            join(repositoryRoot, "vitest.contract.config.ts"),
            "--pool=forks",
            "--maxWorkers=1"
          ],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              [crashWorkerEnvironment]: "1",
              [crashFixtureDirectoryEnvironment]: paths.runtime_dir,
              [crashPidFileEnvironment]: pidFile,
              [crashArmedFileEnvironment]: armedFile
            },
            maxBuffer: 128 * 1_024,
            shell: false,
            timeout: 20_000,
            windowsHide: true
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(readFileSync(armedFile, "utf8")).toBe("armed\n");
        expect(existsSync(pidFile)).toBe(true);
        const pids = parsePidFile(pidFile);
        await waitForProcessExit(pids.root_pid);
        await waitForProcessExit(pids.descendant_pid);
      } finally {
        rmSync(paths.config_dir, { force: true, recursive: true });
        rmSync(paths.state_dir, { force: true, recursive: true });
        rmSync(paths.runtime_dir, { force: true, recursive: true });
      }
    }, 30_000);
  });
}

function createNativeLayout() {
  const defaults = resolveNativeWindowsHostDeckDefaultPaths();
  const suffix = `Supervisor-${process.pid}-${Date.now()}`;
  const input = {
    config_dir: join(defaults.config_dir, suffix),
    state_dir: join(defaults.state_dir, suffix),
    runtime_dir: join(defaults.runtime_dir, suffix),
    database_path: join(defaults.state_dir, suffix, "hostdeck.sqlite")
  };
  const paths = prepareHostDeckLocalPaths(input);
  const fakeApiCredential = randomBytes(48).toString("base64url");
  writeFileSync(
    join(paths.config_dir, "auth.json"),
    `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: fakeApiCredential })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  writeFileSync(
    join(paths.config_dir, "config.toml"),
    ['check_for_update_on_startup = false', '[features]', 'goals = true', 'plugins = false', ''].join("\n"),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  for (const name of ["auth.json", "config.toml"]) {
    secureHostDeckRegularFile(join(paths.config_dir, name), {
      label: `Codex Windows ${name}`,
      mode: 0o600,
      repair_mode: true
    });
  }
  return Object.freeze({
    paths,
    cleanup() {
      rmSync(paths.config_dir, { force: true, recursive: true });
      rmSync(paths.state_dir, { force: true, recursive: true });
      rmSync(paths.runtime_dir, { force: true, recursive: true });
    }
  });
}

function locateExactWindowsCodex() {
  const requireFromRoot = createRequire(join(repositoryRoot, "package.json"));
  const mainPackagePath = requireFromRoot.resolve("@openai/codex/package.json");
  const mainPackage = JSON.parse(readFileSync(mainPackagePath, "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
  };
  if (mainPackage.name !== "@openai/codex" || mainPackage.version !== "0.144.0") {
    throw new TypeError("Exact Codex package is unavailable.");
  }
  const requireFromCodex = createRequire(mainPackagePath);
  const nativePackagePath = requireFromCodex.resolve(
    "@openai/codex-win32-x64/package.json"
  );
  const nativeRoot = realpathSync(dirname(nativePackagePath));
  const vendorRoot = join(nativeRoot, "vendor", "x86_64-pc-windows-msvc");
  const executable = realpathSync(join(vendorRoot, "bin", "codex.exe"));
  if (!statSync(executable).isFile()) {
    throw new TypeError("Exact Codex Windows executable is unavailable.");
  }
  if (
    createHash("sha256").update(readFileSync(executable)).digest("hex") !==
    "2b3c18d9393ed794531ae3da13f43a6de3bcd91dc577222bd31a17c59f7de0aa"
  ) {
    throw new TypeError("Exact Codex Windows executable identity is invalid.");
  }
  return Object.freeze({
    executable,
    managedPackageRoot: realpathSync(dirname(mainPackagePath)),
    pathDirectory: join(vendorRoot, "codex-path")
  });
}

function writeProcessTreeFixture(cwd: string): void {
  writeFileSync(
    join(cwd, "app-server"),
    [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const pidFile = process.env.HOSTDECK_WINDOWS_SUPERVISOR_CRASH_PID_FILE;',
      'if (typeof pidFile !== "string") process.exit(2);',
      'setTimeout(() => {',
      '  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
      '  if (descendant.pid === undefined) process.exit(3);',
      '  writeFileSync(pidFile, JSON.stringify({ root_pid: process.pid, descendant_pid: descendant.pid }) + "\\n", { flag: "wx" });',
      '  process.stderr.write("listening on: ws://127.0.0.1:33001\\n");',
      '}, 250);',
      'setInterval(() => {}, 1000);',
      ''
    ].join("\n"),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
}

function processFixtureRequest(
  cwd: string,
  pidFile: string
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
    executable: process.execPath,
    args,
    cwd,
    environment: Object.freeze({
      ...process.env,
      [crashPidFileEnvironment]: pidFile
    }) as Readonly<Record<string, string>>
  });
}

async function start(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>
) {
  const deadline = createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_startup_timeout_ms
  });
  try {
    return await supervisor.start({
      deadline,
      resourceBudget: defaultResourceBudget
    });
  } finally {
    deadline.dispose();
  }
}

async function restart(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>
) {
  const deadline = createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_startup_timeout_ms
  });
  try {
    return await supervisor.restart({
      deadline,
      resourceBudget: defaultResourceBudget
    });
  } finally {
    deadline.dispose();
  }
}

async function close(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs: 10_000 });
  try {
    await supervisor.close({ deadline });
  } finally {
    deadline.dispose();
  }
}

async function closeQuietly(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>
): Promise<void> {
  try {
    await close(supervisor);
  } catch {}
}

async function waitForClosedPort(port: number): Promise<void> {
  const { createConnection } = await import("node:net");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolveOpen(true);
      });
      socket.once("error", () => resolveOpen(false));
    });
    if (!open) return;
    await delay(50);
  }
  throw new Error("Codex Windows listener remained open.");
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await delay(25);
  }
  throw new Error("Owned process fixture did not publish its pid file.");
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error("Owned Windows process remained after Job handle closure.");
}

function parsePidFile(path: string): {
  readonly root_pid: number;
  readonly descendant_pid: number;
} {
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    readonly root_pid?: unknown;
    readonly descendant_pid?: unknown;
  };
  if (
    !Number.isSafeInteger(value.root_pid) ||
    (value.root_pid as number) < 1 ||
    !Number.isSafeInteger(value.descendant_pid) ||
    (value.descendant_pid as number) < 1
  ) {
    throw new TypeError("Owned process pid evidence is invalid.");
  }
  return Object.freeze({
    root_pid: value.root_pid as number,
    descendant_pid: value.descendant_pid as number
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError("Required native-test environment is unavailable.");
  }
  return value;
}

function endpointPort(address: string): number {
  const port = Number(address.split(":").at(-1));
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new TypeError("Codex Windows runtime endpoint port is invalid.");
  }
  return port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
