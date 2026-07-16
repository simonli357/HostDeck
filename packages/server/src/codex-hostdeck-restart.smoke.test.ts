import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn
} from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  codexBindingDescriptor,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  acquireHostDeckDaemonLease,
  HostDeckDaemonLeaseError
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type HostDeckRestartWorkerMode,
  type HostDeckRestartWorkerReadyReport,
  type HostDeckRestartWorkerResultReport,
  isProcessAlive,
  readHostDeckRestartWorkerReport,
  socketIdentity,
  writeHostDeckRestartPrivateJson
} from "./codex-hostdeck-restart-smoke-support.js";
import { requirePrivateLifecycleReportPath } from "./codex-runtime-lifecycle-files.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_CODEX_RESTART_SMOKE === "1";
const codexBin = resolve(process.env.HOSTDECK_CODEX_BIN ?? "codex");
const defaultEvidencePath = resolve(
  "artifacts/int-v1-030-hostdeck-restart-evidence.json"
);
const configuredEvidencePath = process.env.HOSTDECK_CODEX_RESTART_REPORT;
const evidencePath = resolve(
  configuredEvidencePath ?? defaultEvidencePath
);
const workerTestPath = resolve(
  "packages/server/src/codex-hostdeck-restart.worker.test.ts"
);
const requireFromHere = createRequire(import.meta.url);
const vitestPath = join(
  dirname(requireFromHere.resolve("vitest/package.json")),
  "vitest.mjs"
);
const maxWorkerOutputBytes = 64 * 1024;

describe.skipIf(!requireSmoke)("exact Codex HostDeck restart continuity smoke", () => {
  it(
    "proves service survival and opposite foreground ownership across HostDeck processes",
    async () => {
      assertEvidencePath(evidencePath);
      rmSync(evidencePath, { force: true });
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1024
        })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);
      const root = mkdtempSync(
        join(tmpdir(), "hostdeck-process-restart-smoke-")
      );
      chmodSync(root, 0o700);
      const workers = new Set<WorkerHandle>();
      let service: ChildProcess | null = null;
      let serviceSocketIdentityForCleanup: string | null = null;
      let serviceStoppedByOuterOwner = false;
      let primaryError: unknown = null;
      const cleanupErrors: unknown[] = [];
      let evidence: RedactedEvidence | null = null;

      try {
        const codexHome = prepareCodexHome(root);
        const projectDir = join(root, "project");
        mkdirSync(projectDir, { mode: 0o700 });
        execFileSync("git", ["init", "-q", "-b", "main", projectDir], {
          timeout: 10_000
        });
        writeFileSync(join(projectDir, "README.md"), "# Restart proof\n", {
          mode: 0o600
        });

        const serviceLayout = createLayout(
          root,
          "service",
          codexHome,
          projectDir
        );
        mkdirSync(serviceLayout.runtime_dir, { mode: 0o700 });
        service = startServiceRuntime(
          codexBin,
          serviceLayout.socket_path,
          codexHome
        );
        await waitForSocket(serviceLayout.socket_path, service);
        const servicePid = requireChildPid(service);
        const serviceSocketIdentity = socketIdentity(
          serviceLayout.socket_path
        );
        serviceSocketIdentityForCleanup = serviceSocketIdentity;

        const serviceA = startWorker(
          "service_initial",
          serviceLayout,
          servicePid
        );
        workers.add(serviceA);
        const serviceAReady = await serviceA.waitReady();
        assertLeaseHeld(serviceLayout.lease_path);
        expect(serviceAReady).toMatchObject({
          mode: "service_initial",
          runtime_pid: servicePid,
          lease_replaced_stale_metadata: false,
          socket_identity: serviceSocketIdentity,
          generation: null,
          boundary_count: 0,
          resumed_count: 0,
          ready_count: 0,
          turn_start_request_count: 1,
          accepted_model_turn_count: 1,
          supervisor: {
            mode: "service_owned",
            spawn_attempts: 0,
            term_signals: 0,
            kill_signals: 0,
            cleanup_failures: 0
          }
        });
        expect(serviceAReady.hostdeck_pid).not.toBe(servicePid);
        publishRelease(serviceA.release_path);
        const serviceAResult = await serviceA.waitResult();
        await serviceA.waitExit();
        workers.delete(serviceA);
        expect(serviceAResult).toMatchObject({
          runtime_pid: servicePid,
          runtime_alive_after_close: true,
          socket_present_after_close: true,
          lease_released: true,
          database_closed: true,
          controller_closed: true,
          cleanup_failures: 0
        });
        expect(isProcessAlive(servicePid)).toBe(true);
        expect(socketIdentity(serviceLayout.socket_path)).toBe(
          serviceSocketIdentity
        );

        const serviceB = startWorker(
          "service_restart",
          serviceLayout,
          servicePid
        );
        workers.add(serviceB);
        const serviceBReady = await serviceB.waitReady();
        assertLeaseHeld(serviceLayout.lease_path);
        expect(serviceBReady).toMatchObject({
          mode: "service_restart",
          runtime_pid: servicePid,
          lease_replaced_stale_metadata: true,
          socket_identity: serviceSocketIdentity,
          thread_id: serviceAReady.thread_id,
          turn_id: serviceAReady.turn_id,
          turn_state: "in_progress",
          generation: 1,
          boundary_count: 1,
          resumed_count: 1,
          ready_count: 1,
          turn_start_request_count: 0,
          accepted_model_turn_count: 0,
          supervisor: {
            mode: "service_owned",
            spawn_attempts: 0,
            term_signals: 0,
            kill_signals: 0,
            cleanup_failures: 0
          }
        });
        expect(serviceBReady.hostdeck_pid).not.toBe(
          serviceAReady.hostdeck_pid
        );
        const serviceBResult = await serviceB.waitResult(140_000);
        await serviceB.waitExit();
        workers.delete(serviceB);
        expect(serviceBResult).toMatchObject({
          runtime_pid: servicePid,
          runtime_alive_after_close: true,
          socket_present_after_close: true,
          lease_released: true,
          database_closed: true,
          controller_closed: true,
          cleanup_failures: 0
        });
        expect(isProcessAlive(servicePid)).toBe(true);
        expect(socketIdentity(serviceLayout.socket_path)).toBe(
          serviceSocketIdentity
        );

        const foregroundLayout = createLayout(
          root,
          "foreground",
          codexHome,
          projectDir
        );
        const foregroundA = startWorker(
          "foreground_first",
          foregroundLayout,
          null
        );
        workers.add(foregroundA);
        const foregroundAReady = await foregroundA.waitReady();
        assertLeaseHeld(foregroundLayout.lease_path);
        expect(foregroundAReady).toMatchObject({
          mode: "foreground_first",
          lease_replaced_stale_metadata: false,
          thread_id: null,
          turn_id: null,
          turn_state: null,
          supervisor: {
            mode: "foreground_child",
            spawn_attempts: 1,
            term_signals: 0,
            kill_signals: 0,
            cleanup_failures: 0
          }
        });
        expect(isProcessAlive(foregroundAReady.runtime_pid)).toBe(true);
        publishRelease(foregroundA.release_path);
        const foregroundAResult = await foregroundA.waitResult();
        await foregroundA.waitExit();
        workers.delete(foregroundA);
        expect(foregroundAResult).toMatchObject({
          runtime_alive_after_close: false,
          socket_present_after_close: false,
          lease_released: true,
          database_closed: true,
          controller_closed: true,
          cleanup_failures: 0
        });
        expect(isProcessAlive(foregroundAReady.runtime_pid)).toBe(false);
        expect(existsSync(foregroundLayout.socket_path)).toBe(false);

        const foregroundB = startWorker(
          "foreground_second",
          foregroundLayout,
          null
        );
        workers.add(foregroundB);
        const foregroundBReady = await foregroundB.waitReady();
        assertLeaseHeld(foregroundLayout.lease_path);
        expect(foregroundBReady).toMatchObject({
          mode: "foreground_second",
          lease_replaced_stale_metadata: true,
          supervisor: {
            mode: "foreground_child",
            spawn_attempts: 1,
            term_signals: 0,
            kill_signals: 0,
            cleanup_failures: 0
          }
        });
        expect(foregroundBReady.hostdeck_pid).not.toBe(
          foregroundAReady.hostdeck_pid
        );
        expect(foregroundBReady.runtime_pid).not.toBe(
          foregroundAReady.runtime_pid
        );
        expect(foregroundBReady.socket_identity).not.toBe(
          foregroundAReady.socket_identity
        );
        expect(
          new Set([
            serviceAReady.hostdeck_pid,
            serviceBReady.hostdeck_pid,
            foregroundAReady.hostdeck_pid,
            foregroundBReady.hostdeck_pid
          ]).size
        ).toBe(4);
        publishRelease(foregroundB.release_path);
        const foregroundBResult = await foregroundB.waitResult();
        await foregroundB.waitExit();
        workers.delete(foregroundB);
        expect(foregroundBResult).toMatchObject({
          runtime_alive_after_close: false,
          socket_present_after_close: false,
          lease_released: true,
          database_closed: true,
          controller_closed: true,
          cleanup_failures: 0
        });
        expect(isProcessAlive(foregroundBReady.runtime_pid)).toBe(false);
        expect(existsSync(foregroundLayout.socket_path)).toBe(false);

        const readyReports = [
          serviceAReady,
          serviceBReady,
          foregroundAReady,
          foregroundBReady
        ];
        const turnStartRequestCount = readyReports.reduce(
          (total, report) => total + report.turn_start_request_count,
          0
        );
        const acceptedModelTurnCount = readyReports.reduce(
          (total, report) => total + report.accepted_model_turn_count,
          0
        );
        const mutationRetryCount =
          turnStartRequestCount - acceptedModelTurnCount;
        if (
          turnStartRequestCount !== 1 ||
          acceptedModelTurnCount !== 1 ||
          mutationRetryCount !== 0
        ) {
          throw new Error("Exact restart turn budget is invalid.");
        }
        expect(turnStartRequestCount).toBe(1);
        expect(acceptedModelTurnCount).toBe(1);
        expect(mutationRetryCount).toBe(0);

        evidence = Object.freeze({
          schema_version: 1,
          task: "INT-V1-030",
          observed_at: new Date().toISOString(),
          hostdeck_commit: currentCommit(),
          process_boundary: {
            hostdeck_process_count: 4,
            hostdeck_processes_distinct: true
          },
          runtime: {
            version,
            exact_binding: true,
            service_runtime_pid_stable: true,
            service_socket_identity_stable: true,
            foreground_runtime_pid_replaced: true,
            foreground_socket_identity_replaced: true
          },
          service_owned: {
            hostdeck_process_count: 2,
            hostdeck_processes_distinct: true,
            lease_contention_proven: true,
            lease_reacquired: true,
            runtime_spawn_count_by_hostdeck: 0,
            runtime_signal_count_by_hostdeck: 0,
            managed_thread_identity_stable: true,
            active_turn_identity_stable: true,
            active_turn_observed_after_restart: true,
            completion_observed_after_restart: true,
            restart_boundary_count: 1,
            no_override_resume_count: 1,
            ready_count: 1,
            turn_start_request_count: turnStartRequestCount,
            model_turn_count: acceptedModelTurnCount,
            mutation_retry_count: mutationRetryCount
          },
          foreground_child: {
            hostdeck_process_count: 2,
            hostdeck_processes_distinct: true,
            lease_contention_proven: true,
            lease_reacquired: true,
            runtime_process_count: 2,
            runtime_processes_distinct: true,
            owned_runtime_exit_count: 2,
            owned_socket_cleanup_count: 2
          },
          privacy: {
            contains_pid: false,
            contains_path: false,
            contains_socket_identity: false,
            contains_thread_or_turn_id: false,
            contains_model_prompt_output_or_auth: false
          },
          cleanup: {
            workers_remaining: 0,
            foreground_runtimes_remaining: 0,
            foreground_sockets_remaining: 0,
            service_runtime_stopped_by_outer_owner: false,
            service_socket_remaining: true,
            temporary_root_removed: false
          }
        } satisfies RedactedEvidence);
      } catch (error) {
        primaryError = error;
      } finally {
        for (const worker of workers) {
          await collectCleanup(worker.stop(), cleanupErrors);
        }
        workers.clear();
        if (service !== null) {
          try {
            serviceStoppedByOuterOwner = await stopChild(service);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        const serviceSocketPath = join(
          root,
          "service-runtime",
          "app-server.sock"
        );
        if (service !== null && existsSync(serviceSocketPath)) {
          await collectCleanup(
            removeStoppedServiceSocket(
              service,
              serviceSocketPath,
              serviceSocketIdentityForCleanup
            ),
            cleanupErrors
          );
        }
        if (cleanupErrors.length === 0) {
          try {
            rmSync(root, { recursive: true, force: true, maxRetries: 5 });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }

      if (evidence !== null && !serviceStoppedByOuterOwner) {
        cleanupErrors.push(
          new Error("Exact service runtime was not stopped by its outer owner.")
        );
      }
      if (evidence !== null && existsSync(root)) {
        cleanupErrors.push(
          new Error("Exact restart proof temporary root remains after cleanup.")
        );
      }

      if (primaryError !== null || cleanupErrors.length > 0) {
        rmSync(evidencePath, { force: true });
        const errors = [
          ...(primaryError === null ? [] : [primaryError]),
          ...cleanupErrors
        ];
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(
              errors,
              "HostDeck restart continuity and cleanup failed."
            );
      }
      if (evidence === null) {
        throw new Error("HostDeck restart evidence was not assembled.");
      }
      const completedEvidence: RedactedEvidence = {
        ...evidence,
        cleanup: {
          workers_remaining: 0,
          foreground_runtimes_remaining: 0,
          foreground_sockets_remaining: 0,
          service_runtime_stopped_by_outer_owner: true,
          service_socket_remaining: false,
          temporary_root_removed: true
        }
      };
      writeHostDeckRestartPrivateJson(evidencePath, completedEvidence);
      expect(readRedactedEvidence(evidencePath)).toEqual(completedEvidence);
    },
    240_000
  );
});

interface RestartLayout {
  readonly root: string;
  readonly state_dir: string;
  readonly config_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
  readonly socket_path: string;
  readonly lease_path: string;
  readonly codex_home: string;
  readonly project_dir: string;
  readonly marker_path: string;
  readonly shared_path: string;
}

interface WorkerHandle {
  readonly mode: HostDeckRestartWorkerMode;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready_path: string;
  readonly result_path: string;
  readonly release_path: string | null;
  readonly waitReady: (
    timeoutMs?: number
  ) => Promise<HostDeckRestartWorkerReadyReport>;
  readonly waitResult: (
    timeoutMs?: number
  ) => Promise<HostDeckRestartWorkerResultReport>;
  readonly waitExit: (timeoutMs?: number) => Promise<void>;
  readonly stop: () => Promise<void>;
}

interface RedactedEvidence {
  readonly schema_version: 1;
  readonly task: "INT-V1-030";
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly process_boundary: {
    readonly hostdeck_process_count: 4;
    readonly hostdeck_processes_distinct: true;
  };
  readonly runtime: {
    readonly version: string;
    readonly exact_binding: true;
    readonly service_runtime_pid_stable: true;
    readonly service_socket_identity_stable: true;
    readonly foreground_runtime_pid_replaced: true;
    readonly foreground_socket_identity_replaced: true;
  };
  readonly service_owned: {
    readonly hostdeck_process_count: 2;
    readonly hostdeck_processes_distinct: true;
    readonly lease_contention_proven: true;
    readonly lease_reacquired: true;
    readonly runtime_spawn_count_by_hostdeck: 0;
    readonly runtime_signal_count_by_hostdeck: 0;
    readonly managed_thread_identity_stable: true;
    readonly active_turn_identity_stable: true;
    readonly active_turn_observed_after_restart: true;
    readonly completion_observed_after_restart: true;
    readonly restart_boundary_count: 1;
    readonly no_override_resume_count: 1;
    readonly ready_count: 1;
    readonly turn_start_request_count: 1;
    readonly model_turn_count: 1;
    readonly mutation_retry_count: 0;
  };
  readonly foreground_child: {
    readonly hostdeck_process_count: 2;
    readonly hostdeck_processes_distinct: true;
    readonly lease_contention_proven: true;
    readonly lease_reacquired: true;
    readonly runtime_process_count: 2;
    readonly runtime_processes_distinct: true;
    readonly owned_runtime_exit_count: 2;
    readonly owned_socket_cleanup_count: 2;
  };
  readonly privacy: {
    readonly contains_pid: false;
    readonly contains_path: false;
    readonly contains_socket_identity: false;
    readonly contains_thread_or_turn_id: false;
    readonly contains_model_prompt_output_or_auth: false;
  };
  readonly cleanup: {
    readonly workers_remaining: 0;
    readonly foreground_runtimes_remaining: 0;
    readonly foreground_sockets_remaining: 0;
    readonly service_runtime_stopped_by_outer_owner: boolean;
    readonly service_socket_remaining: boolean;
    readonly temporary_root_removed: boolean;
  };
}

function createLayout(
  root: string,
  label: string,
  codexHome: string,
  projectDir: string
): RestartLayout {
  const stateDir = join(root, `${label}-state`);
  const runtimeDir = join(root, `${label}-runtime`);
  return {
    root,
    state_dir: stateDir,
    config_dir: join(root, `${label}-config`),
    runtime_dir: runtimeDir,
    database_path: join(stateDir, "hostdeck.sqlite"),
    socket_path: join(runtimeDir, "app-server.sock"),
    lease_path: join(stateDir, "hostdeck.lock"),
    codex_home: codexHome,
    project_dir: projectDir,
    marker_path: join(projectDir, "restart-marker"),
    shared_path: join(root, `${label}-shared.json`)
  };
}

function startWorker(
  mode: HostDeckRestartWorkerMode,
  layout: RestartLayout,
  servicePid: number | null
): WorkerHandle {
  const readyPath = join(layout.root, `${mode}-ready.json`);
  const resultPath = join(layout.root, `${mode}-result.json`);
  const releasePath =
    mode === "service_restart"
      ? null
      : join(layout.root, `${mode}-release`);
  for (const path of [
    readyPath,
    resultPath,
    ...(releasePath === null ? [] : [releasePath])
  ]) {
    rmSync(path, { force: true });
  }
  const child = spawn(
    process.execPath,
    [
      vitestPath,
      "run",
      workerTestPath,
      "--pool=threads",
      "--maxWorkers=1"
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        CODEX_HOME: layout.codex_home,
        HOSTDECK_RESTART_WORKER_MODE: mode,
        HOSTDECK_RESTART_ROOT: layout.root,
        HOSTDECK_RESTART_STATE_DIR: layout.state_dir,
        HOSTDECK_RESTART_CONFIG_DIR: layout.config_dir,
        HOSTDECK_RESTART_RUNTIME_DIR: layout.runtime_dir,
        HOSTDECK_RESTART_DATABASE_PATH: layout.database_path,
        HOSTDECK_RESTART_CODEX_HOME: layout.codex_home,
        HOSTDECK_RESTART_CODEX_BIN: codexBin,
        HOSTDECK_RESTART_PROJECT_DIR: layout.project_dir,
        HOSTDECK_RESTART_MARKER_PATH: layout.marker_path,
        HOSTDECK_RESTART_SHARED_PATH: layout.shared_path,
        HOSTDECK_RESTART_READY_PATH: readyPath,
        HOSTDECK_RESTART_RESULT_PATH: resultPath,
        ...(releasePath === null
          ? {}
          : { HOSTDECK_RESTART_RELEASE_PATH: releasePath }),
        ...(servicePid === null
          ? {}
          : { HOSTDECK_RESTART_SERVICE_PID: String(servicePid) })
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  const workerPid = requireChildPid(child);
  const output = captureWorkerOutput(child);
  const waitExit = (timeoutMs = 30_000) =>
    waitForWorkerExit(child, output, timeoutMs);
  return {
    mode,
    child,
    ready_path: readyPath,
    result_path: resultPath,
    release_path: releasePath,
    async waitReady(timeoutMs = 100_000) {
      await waitForReportOrExit(child, readyPath, output, timeoutMs);
      return readHostDeckRestartWorkerReport(
        readyPath,
        "ready"
      ) as HostDeckRestartWorkerReadyReport;
    },
    async waitResult(timeoutMs = 30_000) {
      await waitForReportOrExit(child, resultPath, output, timeoutMs);
      return readHostDeckRestartWorkerReport(
        resultPath,
        "completed"
      ) as HostDeckRestartWorkerResultReport;
    },
    waitExit,
    async stop() {
      await stopWorkerProcessGroup(child, workerPid, mode);
    }
  };
}

function startServiceRuntime(
  binary: string,
  socketPath: string,
  codexHome: string
): ChildProcess {
  return spawn(
    binary,
    [
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
      "app-server",
      "--listen",
      `unix://${socketPath}`
    ],
    {
      cwd: "/",
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "ignore", "ignore"],
      shell: false
    }
  );
}

function prepareCodexHome(root: string): string {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  const sourceMetadata = lstatSync(source);
  if (
    !sourceMetadata.isFile() ||
    sourceMetadata.isSymbolicLink() ||
    sourceMetadata.nlink !== 1 ||
    (sourceMetadata.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && sourceMetadata.uid !== process.getuid())
  ) {
    throw new Error(
      "Exact restart proof requires one private regular Codex auth.json."
    );
  }
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { mode: 0o700 });
  const destination = join(codexHome, "auth.json");
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  return codexHome;
}

async function waitForSocket(
  path: string,
  child: ChildProcess
): Promise<void> {
  await waitFor(
    () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          "Exact service runtime exited before socket readiness."
        );
      }
      try {
        return lstatSync(path).isSocket();
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    },
    10_000,
    "Exact service runtime did not create its Unix socket."
  );
}

function assertLeaseHeld(leasePath: string): void {
  try {
    const unexpected = acquireHostDeckDaemonLease({
      lease_path: leasePath
    });
    unexpected.release();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckDaemonLeaseError);
    expect(error).toMatchObject({ code: "lease_held" });
    return;
  }
  throw new Error("Concurrent HostDeck restart lease acquisition succeeded.");
}

function publishRelease(path: string | null): void {
  if (path === null) {
    throw new Error("HostDeck restart worker has no release path.");
  }
  writeFileSync(path, "release\n", { mode: 0o600, flag: "wx" });
}

function captureWorkerOutput(child: ChildProcessWithoutNullStreams): {
  readonly read: () => {
    readonly stdout: string;
    readonly stderr: string;
    readonly overflow: boolean;
  };
} {
  let stdout = "";
  let stderr = "";
  let total = 0;
  let overflow = false;
  const append = (current: string, chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > maxWorkerOutputBytes) overflow = true;
    return `${current}${chunk.toString("utf8")}`.slice(
      -maxWorkerOutputBytes
    );
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  return {
    read: () => ({ stdout, stderr, overflow })
  };
}

async function waitForReportOrExit(
  child: ChildProcessWithoutNullStreams,
  path: string,
  output: ReturnType<typeof captureWorkerOutput>,
  timeoutMs: number
): Promise<void> {
  await waitFor(
    () => {
      if (existsSync(path)) return true;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw workerFailure(child, output, "before publishing its report");
      }
      return false;
    },
    timeoutMs,
    "HostDeck restart worker did not publish its report before timeout."
  );
}

async function waitForWorkerExit(
  child: ChildProcessWithoutNullStreams,
  output: ReturnType<typeof captureWorkerOutput>,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit").then(() => true as const);
    if (!(await settlesWithin(exited, timeoutMs))) {
      throw new Error("HostDeck restart worker did not exit before timeout.");
    }
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw workerFailure(child, output, "with a nonzero result");
  }
  if (output.read().overflow) {
    throw new Error("HostDeck restart worker exceeded its output bound.");
  }
}

function workerFailure(
  child: ChildProcessWithoutNullStreams,
  output: ReturnType<typeof captureWorkerOutput>,
  stage: string
): Error {
  const captured = output.read();
  return new Error(
    `HostDeck restart worker exited ${stage} (code=${String(
      child.exitCode
    )}, signal=${String(child.signalCode)}, stdout=${
      captured.stdout || "empty"
    }, stderr=${captured.stderr || "empty"}).`
  );
}

async function stopChild(
  child: ChildProcess
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 3_000)) return true;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 2_000))) {
    throw new Error("Exact service runtime did not stop.");
  }
  return true;
}

async function stopWorkerProcessGroup(
  child: ChildProcess,
  processGroupId: number,
  mode: HostDeckRestartWorkerMode
): Promise<void> {
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit").then(() => undefined);
  signalProcessGroup(processGroupId, "SIGTERM");
  if (!(await waitForProcessGroupAbsence(processGroupId, 2_000))) {
    signalProcessGroup(processGroupId, "SIGKILL");
    if (!(await waitForProcessGroupAbsence(processGroupId, 2_000))) {
      throw new Error(
        `HostDeck restart worker ${mode} process group did not stop.`
      );
    }
  }
  if (!(await settlesWithin(exited, 2_000))) {
    throw new Error(`HostDeck restart worker ${mode} did not exit.`);
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

async function waitForProcessGroupAbsence(
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> {
  const started = Date.now();
  while (isProcessGroupAlive(processGroupId)) {
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return true;
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

async function waitForAbsence(path: string): Promise<void> {
  await waitFor(
    () => !existsSync(path),
    10_000,
    "Exact service runtime socket remained after owner cleanup."
  );
}

async function removeStoppedServiceSocket(
  child: ChildProcess,
  path: string,
  expectedIdentity: string | null
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(
      "Refusing to remove a service socket before its owner exits."
    );
  }
  if (expectedIdentity === null || socketIdentity(path) !== expectedIdentity) {
    throw new Error(
      "Refusing to remove a replaced service runtime socket."
    );
  }
  rmSync(path);
  await waitForAbsence(path);
}

async function collectCleanup(
  operation: Promise<void>,
  errors: unknown[]
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started >= timeoutMs) throw new Error(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function settlesWithin<T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolveExpired) => {
    timeout = setTimeout(() => resolveExpired(false), milliseconds);
    timeout.unref();
  });
  const result = await Promise.race([
    promise.then(() => true as const),
    expired
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

function requireChildPid(child: ChildProcess): number {
  if (!Number.isSafeInteger(child.pid) || (child.pid as number) < 1) {
    throw new Error("Exact service runtime has no valid pid.");
  }
  return child.pid as number;
}

function currentCommit(): string {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024
    }
  ).trim();
  if (status !== "") {
    throw new Error("HostDeck restart evidence requires a clean worktree.");
  }
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("HostDeck restart evidence commit is invalid.");
  }
  return value;
}

function readRedactedEvidence(path: string): unknown {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 2 ||
    metadata.size > 16 * 1024
  ) {
    throw new Error("HostDeck restart redacted evidence file is invalid.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertEvidencePath(path: string): void {
  if (configuredEvidencePath !== undefined) {
    requirePrivateLifecycleReportPath(path, "restart-report.json");
    return;
  }
  const artifacts = resolve("artifacts");
  const relationship = relative(artifacts, path);
  if (
    !isAbsolute(path) ||
    relationship === "" ||
    relationship === ".." ||
    relationship.startsWith("../") ||
    isAbsolute(relationship) ||
    !path.endsWith(".json")
  ) {
    throw new Error(
      "HostDeck restart evidence path must be a JSON file under artifacts."
    );
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String(error.code) === code
  );
}
