import { spawn } from "node:child_process";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import {
  HostDeckLocalPathError,
  secureHostDeckSocket
} from "@hostdeck/storage";
import type {
  CodexRuntimeChildProcess,
  CodexRuntimeProcessExit,
  CodexRuntimeProcessPort,
  CodexRuntimeProcessRequest,
  CodexRuntimeSocketInspectionPolicy,
  CodexRuntimeSocketObservation,
  CodexRuntimeSocketPort,
  CodexRuntimeSocketProbe,
  CodexRuntimeSupervisorClock
} from "./codex-runtime-supervisor.js";

export const nodeCodexRuntimeSupervisorClock: CodexRuntimeSupervisorClock =
  Object.freeze({
    sleep(milliseconds: number, signal: AbortSignal) {
      return abortableSleep(milliseconds, signal);
    }
  });

export const nodeCodexRuntimeProcessPort: CodexRuntimeProcessPort =
  Object.freeze({
    spawn: spawnCodexRuntimeChild
  });

export const nodeCodexRuntimeSocketPort: CodexRuntimeSocketPort = Object.freeze(
  {
    inspect: inspectCodexRuntimeSocket,
    probe: probeCodexRuntimeSocket,
    remove: removeCodexRuntimeSocket
  }
);

function spawnCodexRuntimeChild(
  request: CodexRuntimeProcessRequest
): CodexRuntimeChildProcess {
  const child = spawn(request.executable, request.args, {
    cwd: request.cwd,
    env: process.env,
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
    detached: false
  });
  let settled = false;
  let running = true;
  let pendingSpawnFailure: CodexRuntimeProcessExit["spawn_failure"] = null;
  let resolveExit: (exit: CodexRuntimeProcessExit) => void = () => undefined;
  const exit = new Promise<CodexRuntimeProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (result: CodexRuntimeProcessExit) => {
    if (settled) return;
    settled = true;
    running = false;
    resolveExit(result);
  };
  child.once("error", (error: NodeJS.ErrnoException) => {
    pendingSpawnFailure =
      error.code === "ENOENT"
        ? "missing_binary"
        : error.code === "EACCES"
          ? "not_executable"
          : "failed";
    settle(
      Object.freeze({
        kind: "spawn_failed",
        code: null,
        signal: null,
        spawn_failure: pendingSpawnFailure
      })
    );
  });
  child.once("close", (code, signal) => {
    if (pendingSpawnFailure !== null || settled) return;
    if (signal !== null) {
      settle(
        Object.freeze({
          kind: "signaled",
          code: null,
          signal,
          spawn_failure: null
        })
      );
      return;
    }
    if (code === null) {
      settle(
        Object.freeze({
          kind: "spawn_failed",
          code: null,
          signal: null,
          spawn_failure: "failed"
        })
      );
      return;
    }
    settle(
      Object.freeze({
        kind: "exited",
        code,
        signal: null,
        spawn_failure: null
      })
    );
  });

  return Object.freeze({
    exit,
    isRunning: () =>
      running && child.exitCode === null && child.signalCode === null,
    signal: (signal: "SIGTERM" | "SIGKILL") => {
      if (!running || child.exitCode !== null || child.signalCode !== null) {
        return false;
      }
      return child.kill(signal);
    }
  });
}

function inspectCodexRuntimeSocket(
  socketPath: string,
  policy: CodexRuntimeSocketInspectionPolicy
): CodexRuntimeSocketObservation {
  assertPrivateSocketParent(socketPath);
  if (
    policy === null ||
    typeof policy !== "object" ||
    !Object.isFrozen(policy) ||
    Reflect.ownKeys(policy).length !== 1 ||
    typeof policy.repair_mode !== "boolean"
  ) {
    throw new TypeError("Codex socket inspection policy is invalid.");
  }
  try {
    lstatSync(socketPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return Object.freeze({ state: "missing" });
    throw error;
  }
  const repair = secureHostDeckSocket(socketPath, {
    label: "Codex app-server socket",
    mode: 0o600,
    repair_mode: policy.repair_mode
  });
  const metadata = lstatSync(socketPath);
  return Object.freeze({
    state: "socket",
    identity: socketIdentity(metadata.dev, metadata.ino),
    mode_repaired: repair !== null
  });
}

function probeCodexRuntimeSocket(
  socketPath: string,
  signal: AbortSignal
): Promise<CodexRuntimeSocketProbe> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (result: CodexRuntimeSocketProbe) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      resolve(result);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(cause);
    };
    const onConnect = () => finish("ready");
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("missing");
      else if (error.code === "ECONNREFUSED") finish("refused");
      else fail(error);
    };
    const onAbort = () => fail(signal.reason);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function removeCodexRuntimeSocket(
  socketPath: string,
  identity: string
): "removed" | "missing" {
  assertPrivateSocketParent(socketPath);
  try {
    lstatSync(socketPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
  secureHostDeckSocket(socketPath, {
    label: "Codex app-server socket",
    mode: 0o600,
    repair_mode: false
  });
  const before = lstatSync(socketPath);
  if (socketIdentity(before.dev, before.ino) !== identity) {
    throw new TypeError("Codex socket identity changed before cleanup.");
  }
  const metadata = lstatSync(socketPath);
  if (socketIdentity(metadata.dev, metadata.ino) !== identity) {
    throw new TypeError("Codex socket identity changed during cleanup.");
  }
  unlinkSync(socketPath);
  return "removed";
}

function assertPrivateSocketParent(socketPath: string): void {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new HostDeckLocalPathError(
      "unsupported_platform",
      "Codex runtime supervision requires Linux uid semantics.",
      null
    );
  }
  const parent = dirname(socketPath);
  const metadata = lstatSync(parent);
  if (metadata.isSymbolicLink()) {
    throw new HostDeckLocalPathError(
      "symlink_rejected",
      "Codex runtime directory must not be a symlink.",
      parent
    );
  }
  if (!metadata.isDirectory()) {
    throw new HostDeckLocalPathError(
      "path_type_mismatch",
      "Codex runtime parent must be a directory.",
      parent
    );
  }
  if (metadata.uid !== process.getuid()) {
    throw new HostDeckLocalPathError(
      "wrong_owner",
      "Codex runtime directory must be owned by the current user.",
      parent
    );
  }
  if ((metadata.mode & 0o7777) !== 0o700) {
    throw new HostDeckLocalPathError(
      "runtime_parent_insecure",
      "Codex runtime directory must have exact mode 0700.",
      parent
    );
  }
  if (realpathSync(parent) !== parent) {
    throw new HostDeckLocalPathError(
      "path_not_canonical",
      "Codex runtime directory must be canonical.",
      parent
    );
  }
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 300_000
  ) {
    return Promise.reject(
      new TypeError("Codex supervisor retry delay is invalid.")
    );
  }
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    timer.unref();
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function socketIdentity(device: number, inode: number): string {
  if (
    !Number.isSafeInteger(device) ||
    device < 0 ||
    !Number.isSafeInteger(inode) ||
    inode < 1
  ) {
    throw new TypeError("Codex socket filesystem identity is invalid.");
  }
  return `${device}:${inode}`;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
