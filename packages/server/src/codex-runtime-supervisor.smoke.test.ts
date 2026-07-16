import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexBindingDescriptor,
  createCodexAppServerConnection,
  createCodexUnixWebSocketTransport,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  readCodexSmokePrivateJson,
  writeCodexSmokePrivateJson
} from "./codex-hostdeck-restart-smoke-support.js";
import { parseSupervisorScenarioEvidence } from "./codex-runtime-lifecycle-acceptance.js";
import { requirePrivateLifecycleReportPath } from "./codex-runtime-lifecycle-files.js";
import { createCodexRuntimeSupervisor } from "./codex-runtime-supervisor.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_CODEX_SUPERVISOR_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";
const reportPath = parseOptionalReportPath(
  process.env.HOSTDECK_CODEX_SUPERVISOR_REPORT
);

describe.skipIf(!requireSmoke)("exact Codex runtime supervisor smoke", () => {
  it(
    "proves foreground ownership and service non-ownership without a model call",
    async () => {
      const commit = reportPath === null ? null : currentCommit();
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1024
        })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const foregroundDir = privateRuntimeDirectory("foreground");
      const foregroundSocket = join(foregroundDir, "app-server.sock");
      const foreground = createCodexRuntimeSupervisor({
        mode: "foreground_child",
        codex_bin: codexBin,
        socket_path: foregroundSocket
      });
      let foregroundStarted:
        | Awaited<ReturnType<typeof foreground.start>>
        | undefined;
      let foregroundCompatibilityReady = false;
      let foregroundOwnedExitCount = 0;
      let foregroundSocketCleanupCount = 0;
      try {
        foregroundStarted = await startSupervisor(foreground);
        expect(lstatSync(foregroundSocket).isSocket()).toBe(true);
        expect(lstatSync(foregroundSocket).mode & 0o7777).toBe(0o600);
        await proveCompatibility(foregroundSocket, version);
        foregroundCompatibilityReady = true;
        await closeSupervisor(foreground);
        await expect(foregroundStarted.process_exit).resolves.toMatchObject({
          expected: true
        });
        foregroundOwnedExitCount = 1;
        expect(existsSync(foregroundSocket)).toBe(false);
        foregroundSocketCleanupCount = 1;
        expect(foreground.snapshot()).toMatchObject({
          phase: "closed",
          claim_held: false,
          process_state: "exited",
          spawn_attempts: 1,
          cleanup_failures: 0
        });
      } finally {
        if (foreground.snapshot().phase !== "closed") {
          await closeSupervisor(foreground).catch(() => undefined);
        }
        rmSync(foregroundDir, { recursive: true, force: true });
      }

      const serviceDir = privateRuntimeDirectory("service");
      const serviceSocket = join(serviceDir, "app-server.sock");
      const sibling = spawn(
        codexBin,
        ["app-server", "--listen", `unix://${serviceSocket}`],
        {
          cwd: "/",
          shell: false,
          stdio: ["ignore", "ignore", "ignore"],
          detached: true
        }
      );
      const siblingPid = requireChildPid(sibling);
      const service = createCodexRuntimeSupervisor({
        mode: "service_owned",
        socket_path: serviceSocket
      });
      let serviceCompatibilityReady = false;
      let siblingSurvivedHostDeckClose = false;
      let outerOwnerStoppedRuntime = false;
      let serviceSocketCleanupCount = 0;
      try {
        assertOwnedProcessGroupLeader(siblingPid);
        const serviceStarted = await startSupervisor(service);
        expect(serviceStarted.process_exit).toBeNull();
        expect(lstatSync(serviceSocket).isSocket()).toBe(true);
        expect(lstatSync(serviceSocket).mode & 0o7777).toBe(0o600);
        await proveCompatibility(serviceSocket, version);
        serviceCompatibilityReady = true;
        await closeSupervisor(service);
        expect(sibling.exitCode).toBeNull();
        expect(sibling.signalCode).toBeNull();
        expect(existsSync(serviceSocket)).toBe(true);
        siblingSurvivedHostDeckClose = true;
        expect(service.snapshot()).toMatchObject({
          phase: "closed",
          process_state: "not_applicable",
          spawn_attempts: 0,
          term_signals: 0,
          kill_signals: 0,
          cleanup_failures: 0
        });
      } finally {
        if (service.snapshot().phase !== "closed") {
          await closeSupervisor(service).catch(() => undefined);
        }
        await stopExternalChild(sibling, siblingPid);
        outerOwnerStoppedRuntime = true;
        try {
          await waitFor(
            () => !existsSync(serviceSocket),
            2_000,
            "Exact service-owned Codex socket remained after outer cleanup."
          );
          serviceSocketCleanupCount = 1;
        } finally {
          rmSync(serviceDir, { recursive: true, force: true });
        }
      }

      expect(existsSync(foregroundDir)).toBe(false);
      expect(existsSync(serviceDir)).toBe(false);
      if (reportPath !== null && commit !== null) {
        const evidence = parseSupervisorScenarioEvidence(
          {
            schema_version: 1,
            scenario: "exact_supervisor",
            observed_at: new Date().toISOString(),
            hostdeck_commit: commit,
            runtime: {
              version: "0.144.0",
              exact_binding: true,
              app_server_process_count: 2
            },
            foreground_child: {
              compatibility_ready: foregroundCompatibilityReady,
              runtime_process_count: 1,
              owned_runtime_exit_count: foregroundOwnedExitCount,
              owned_socket_cleanup_count: foregroundSocketCleanupCount
            },
            service_owned: {
              compatibility_ready: serviceCompatibilityReady,
              runtime_process_count: 1,
              hostdeck_spawn_count: service.snapshot().spawn_attempts,
              hostdeck_signal_count:
                service.snapshot().term_signals +
                service.snapshot().kill_signals,
              sibling_survived_hostdeck_close: siblingSurvivedHostDeckClose,
              outer_owner_stopped_runtime: outerOwnerStoppedRuntime,
              owned_socket_cleanup_count: serviceSocketCleanupCount
            },
            privacy: {
              contains_pid: false,
              contains_path: false,
              contains_socket_identity: false,
              contains_thread_or_turn_id: false,
              contains_model_prompt_output_or_auth: false
            },
            cleanup: {
              app_server_processes_remaining: 0,
              unix_sockets_remaining: 0,
              temporary_roots_remaining: 0
            }
          },
          commit
        );
        writeCodexSmokePrivateJson(reportPath, evidence);
        expect(
          parseSupervisorScenarioEvidence(
            readCodexSmokePrivateJson(reportPath),
            commit
          )
        ).toEqual(evidence);
      }
    },
    30_000
  );
});

async function proveCompatibility(
  socketPath: string,
  observedVersion: string
): Promise<void> {
  const transport = createCodexUnixWebSocketTransport({
    socket_path: socketPath
  });
  const connection = createCodexAppServerConnection({
    transport,
    observed_version: observedVersion
  });
  try {
    await expect(connection.connect()).resolves.toMatchObject({
      state: "ready",
      mutation_policy: "allowed"
    });
    expect(connection.state).toBe("ready");
  } finally {
    await connection.close("HostDeck runtime supervisor smoke completed.");
  }
}

async function startSupervisor(
  supervisor: ReturnType<typeof createCodexRuntimeSupervisor>
) {
  const deadline = createOperationDeadline({ timeoutMs: 10_000 });
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
  supervisor: ReturnType<typeof createCodexRuntimeSupervisor>
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs: 3_000 });
  try {
    await supervisor.close({ deadline });
  } finally {
    deadline.dispose();
  }
}

function privateRuntimeDirectory(label: string): string {
  const directory = mkdtempSync(
    join(tmpdir(), `hostdeck-supervisor-smoke-${label}-`)
  );
  chmodSync(directory, 0o700);
  return directory;
}

async function stopExternalChild(
  child: ChildProcess,
  processGroupId: number
): Promise<void> {
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "close").then(() => undefined);
  signalProcessGroup(processGroupId, "SIGTERM");
  if (
    (await settlesWithin(closed, 2_000)) &&
    (await waitForProcessGroupGone(processGroupId, 2_000))
  ) {
    return;
  }
  signalProcessGroup(processGroupId, "SIGKILL");
  if (
    !(await settlesWithin(closed, 1_000)) ||
    !(await waitForProcessGroupGone(processGroupId, 1_000))
  ) {
    throw new Error("Exact service-owned Codex app-server did not exit.");
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH")) throw error;
  }
}

async function waitForProcessGroupGone(
  processGroupId: number,
  milliseconds: number
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started <= milliseconds) {
    if (!isProcessGroupAlive(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessGroupAlive(processGroupId);
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function assertOwnedProcessGroupLeader(pid: number): void {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = raw.lastIndexOf(")");
  const fields = commandEnd < 0 ? [] : raw.slice(commandEnd + 2).trim().split(/\s+/u);
  if (Number(fields[2]) !== pid || Number(fields[3]) !== pid) {
    throw new Error("Exact service-owned Codex process group is not isolated.");
  }
}

function requireChildPid(child: ChildProcess): number {
  if (!Number.isSafeInteger(child.pid) || (child.pid as number) < 1) {
    throw new Error("Exact service-owned Codex process has no valid pid.");
  }
  return child.pid as number;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function parseOptionalReportPath(candidate: string | undefined): string | null {
  if (candidate === undefined) return null;
  return requirePrivateLifecycleReportPath(
    candidate,
    "supervisor-report.json"
  );
}

function currentCommit(): string {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1_024
    }
  ).trim();
  if (status !== "") {
    throw new Error("Exact supervisor evidence requires a clean worktree.");
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1_024
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Exact supervisor evidence commit is invalid.");
  }
  return commit;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
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
