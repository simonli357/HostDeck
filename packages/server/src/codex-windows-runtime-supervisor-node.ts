import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { win32 } from "node:path";
import {
  createCodexLocalWebSocketTransport,
  parseCodexLocalEndpoint
} from "@hostdeck/codex-adapter";
import {
  type HostDeckFileLock,
  nativeHostDeckFileLockPort,
  openSecureHostDeckRegularFile
} from "@hostdeck/storage";
import koffi from "koffi";
import type {
  CodexWindowsRuntimeAuthority,
  CodexWindowsRuntimeAuthorityPort,
  CodexWindowsRuntimeChildProcess,
  CodexWindowsRuntimeProcessExit,
  CodexWindowsRuntimeProcessPort,
  CodexWindowsRuntimeProcessRequest,
  CodexWindowsRuntimeReadinessInput,
  CodexWindowsRuntimeReadinessPort
} from "./codex-windows-runtime-supervisor.js";

export type CodexWindowsRuntimeNativeErrorCode =
  | "authority_io_failed"
  | "job_io_failed"
  | "process_io_failed";

export class HostDeckCodexWindowsRuntimeNativeError extends Error {
  constructor(readonly code: CodexWindowsRuntimeNativeErrorCode) {
    super("Codex Windows runtime native operation failed.");
    this.name = "HostDeckCodexWindowsRuntimeNativeError";
  }
}

export interface CodexWindowsRuntimeJob {
  readonly assign: (pid: number) => void;
  readonly terminate: () => boolean;
  readonly close: () => void;
}

export interface CodexWindowsRuntimeJobPort {
  readonly createKillOnClose: () => CodexWindowsRuntimeJob;
}

const maximumStderrBytes = 64 * 1_024;
const endpointPattern = /listening on:\s*(ws:\/\/127\.0\.0\.1:([0-9]{1,5}))/gu;
const credentialFileName = "app-server.credential";
const processSetQuota = 0x0000_0100;
const processTerminate = 0x0000_0001;
const jobObjectExtendedLimitInformation = 9;
const jobObjectLimitKillOnJobClose = 0x0000_2000;
const forcedProcessExitCode = 1;

export const nodeCodexWindowsRuntimeAuthorityPort: CodexWindowsRuntimeAuthorityPort =
  Object.freeze({
    tryAcquire: acquireRuntimeAuthority
  });

export const nativeCodexWindowsRuntimeJobPort: CodexWindowsRuntimeJobPort =
  Object.freeze({
    createKillOnClose: createNativeKillOnCloseJob
  });

export const nodeCodexWindowsRuntimeProcessPort: CodexWindowsRuntimeProcessPort =
  createNodeCodexWindowsRuntimeProcessPort();

export const nodeCodexWindowsRuntimeReadinessPort: CodexWindowsRuntimeReadinessPort =
  Object.freeze({
    async authenticate(input: CodexWindowsRuntimeReadinessInput) {
      const transport = createCodexLocalWebSocketTransport({
        host_target: "windows-x64",
        endpoint: input.endpoint,
        credential: input.credential,
        handshake_timeout_ms:
          input.resource_budget.protocol_connect_timeout_ms,
        close_timeout_ms: input.resource_budget.protocol_close_timeout_ms,
        heartbeat_interval_ms:
          input.resource_budget.protocol_heartbeat_interval_ms,
        heartbeat_timeout_ms:
          input.resource_budget.protocol_heartbeat_timeout_ms,
        max_frame_bytes: input.resource_budget.protocol_max_frame_bytes,
        max_buffered_bytes: input.resource_budget.protocol_max_buffered_bytes
      });
      await transport.connect(input.signal);
      await transport.close("readiness-complete");
    }
  });

export function createNodeCodexWindowsRuntimeProcessPort(
  jobPort: CodexWindowsRuntimeJobPort = nativeCodexWindowsRuntimeJobPort,
  platformPort: () => string = () => process.platform
): CodexWindowsRuntimeProcessPort {
  if (
    jobPort === null ||
    typeof jobPort !== "object" ||
    typeof jobPort.createKillOnClose !== "function" ||
    typeof platformPort !== "function"
  ) {
    throw nativeError("job_io_failed");
  }
  return Object.freeze({
    spawn: (request: CodexWindowsRuntimeProcessRequest) =>
      spawnOwnedProcess(request, jobPort, platformPort)
  });
}

export function codexWindowsRuntimeCredentialPath(
  endpointFilePath: string
): string {
  return win32.join(win32.dirname(endpointFilePath), credentialFileName);
}

function acquireRuntimeAuthority(
  endpointFilePath: string
): CodexWindowsRuntimeAuthority | null {
  let descriptor: number | null = null;
  let lock: HostDeckFileLock | null = null;
  try {
    const opened = openSecureHostDeckRegularFile(endpointFilePath, {
      label: "Codex Windows runtime owner",
      mode: 0o600,
      create: true,
      repair_mode: true,
      writable: true
    });
    descriptor = opened.descriptor;
    lock = nativeHostDeckFileLockPort.tryAcquireExclusive(descriptor);
    if (lock === null) {
      closeSync(descriptor);
      return null;
    }
    opened.verifyPath();
    ftruncateSync(descriptor, 0);
    fsyncSync(descriptor);
    opened.verifyPath();
    return createRuntimeAuthority(
      endpointFilePath,
      opened.verifyPath,
      descriptor,
      lock
    );
  } catch {
    if (lock !== null) {
      try {
        lock.release();
      } catch {}
    }
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    throw nativeError("authority_io_failed");
  }
}

function createRuntimeAuthority(
  endpointFilePath: string,
  verifyEndpointPath: () => void,
  endpointDescriptor: number,
  lock: HostDeckFileLock
): CodexWindowsRuntimeAuthority {
  const credentialPath = codexWindowsRuntimeCredentialPath(endpointFilePath);
  let credential:
    | {
        readonly descriptor: number;
        readonly verifyPath: () => void;
      }
    | null = null;
  let released = false;

  const discardCredential = (): void => {
    const active = credential;
    if (active === null) return;
    credential = null;
    let failed = false;
    try {
      active.verifyPath();
      ftruncateSync(active.descriptor, 0);
      fsyncSync(active.descriptor);
      active.verifyPath();
    } catch {
      failed = true;
    }
    try {
      closeSync(active.descriptor);
    } catch {
      failed = true;
    }
    try {
      unlinkSync(credentialPath);
    } catch {
      failed = true;
    }
    if (failed) throw nativeError("authority_io_failed");
  };

  return Object.freeze({
    stageCredential(token: string) {
      if (released || credential !== null) {
        throw nativeError("authority_io_failed");
      }
      let opened: ReturnType<typeof openSecureHostDeckRegularFile> | null = null;
      try {
        verifyEndpointPath();
        opened = openSecureHostDeckRegularFile(credentialPath, {
          label: "Codex Windows runtime credential",
          mode: 0o600,
          create: true,
          repair_mode: true,
          writable: true
        });
        const replacedStaleCredential = fstatSync(opened.descriptor).size > 0;
        opened.verifyPath();
        ftruncateSync(opened.descriptor, 0);
        writeAll(opened.descriptor, Buffer.from(`${token}\n`, "utf8"));
        fsyncSync(opened.descriptor);
        opened.verifyPath();
        credential = Object.freeze({
          descriptor: opened.descriptor,
          verifyPath: opened.verifyPath
        });
        return Object.freeze({
          credential_path: credentialPath,
          replaced_stale_credential: replacedStaleCredential
        });
      } catch {
        if (opened !== null) {
          try {
            ftruncateSync(opened.descriptor, 0);
          } catch {}
          try {
            closeSync(opened.descriptor);
          } catch {}
        }
        throw nativeError("authority_io_failed");
      }
    },
    discardCredential,
    release() {
      if (released) return;
      released = true;
      let failed = false;
      try {
        discardCredential();
      } catch {
        failed = true;
      }
      try {
        verifyEndpointPath();
        ftruncateSync(endpointDescriptor, 0);
        fsyncSync(endpointDescriptor);
        verifyEndpointPath();
      } catch {
        failed = true;
      }
      try {
        lock.release();
      } catch {
        failed = true;
      }
      try {
        closeSync(endpointDescriptor);
      } catch {
        failed = true;
      }
      if (failed) throw nativeError("authority_io_failed");
    }
  });
}

function spawnOwnedProcess(
  request: CodexWindowsRuntimeProcessRequest,
  jobPort: CodexWindowsRuntimeJobPort,
  platformPort: () => string
): CodexWindowsRuntimeChildProcess {
  let platform: string;
  try {
    platform = platformPort();
  } catch {
    throw nativeError("process_io_failed");
  }
  if (platform !== "win32") throw nativeError("process_io_failed");
  let job: CodexWindowsRuntimeJob;
  try {
    job = parseJob(jobPort.createKillOnClose());
  } catch {
    throw nativeError("job_io_failed");
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: { ...request.environment },
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: false
    });
  } catch {
    closeJobQuietly(job);
    throw nativeError("process_io_failed");
  }
  if (child.pid === undefined) {
    child.kill();
    closeJobQuietly(job);
    throw nativeError("process_io_failed");
  }
  try {
    job.assign(child.pid);
  } catch {
    child.kill();
    closeJobQuietly(job);
    throw nativeError("job_io_failed");
  }

  let running = true;
  let settled = false;
  let endpointSettled = false;
  let treeTerminationRequested = false;
  let stderrBytes = 0;
  let stderr = "";
  let resolveEndpoint: (endpoint: unknown) => void = () => undefined;
  let rejectEndpoint: (error: unknown) => void = () => undefined;
  let resolveExit: (exit: CodexWindowsRuntimeProcessExit) => void =
    () => undefined;
  let rejectExit: (error: unknown) => void = () => undefined;
  const endpoint = new Promise<unknown>((resolve, reject) => {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });
  const exit = new Promise<CodexWindowsRuntimeProcessExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const failEndpoint = () => {
    if (endpointSettled) return;
    endpointSettled = true;
    rejectEndpoint(nativeError("process_io_failed"));
  };
  const settle = (result: CodexWindowsRuntimeProcessExit) => {
    if (settled) return;
    settled = true;
    running = false;
    failEndpoint();
    try {
      job.close();
      resolveExit(result);
    } catch {
      rejectExit(nativeError("job_io_failed"));
    }
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    if (endpointSettled) return;
    stderrBytes += chunk.byteLength;
    if (stderrBytes > maximumStderrBytes) {
      stderr = "";
      failEndpoint();
      return;
    }
    stderr += chunk.toString("utf8");
    const matches = [...stderr.matchAll(endpointPattern)];
    if (matches.length > 1) {
      stderr = "";
      failEndpoint();
      return;
    }
    const match = matches[0];
    if (match === undefined) return;
    try {
      const parsed = parseCodexLocalEndpoint({
        schema_version: 1,
        target: "windows-x64",
        kind: "authenticated_loopback_websocket",
        address: match[1],
        port_allocation: "ephemeral_random",
        credential_source: "protected_environment"
      });
      if (parsed.kind !== "authenticated_loopback_websocket") throw new TypeError();
      endpointSettled = true;
      stderr = "";
      resolveEndpoint(parsed);
    } catch {
      stderr = "";
      failEndpoint();
    }
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    settle(
      Object.freeze({
        kind: "spawn_failed",
        code: null,
        spawn_failure:
          error.code === "ENOENT"
            ? "missing_binary"
            : error.code === "EACCES"
              ? "not_executable"
              : "failed"
      })
    );
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settle(
      !treeTerminationRequested && signal === null && code !== null
        ? Object.freeze({
            kind: "exited",
            code,
            spawn_failure: null
          })
        : Object.freeze({
            kind: "terminated",
            code: null,
            spawn_failure: null
          })
    );
  });

  return Object.freeze({
    endpoint,
    exit,
    isRunning: () =>
      running && child.exitCode === null && child.signalCode === null,
    terminateTree: () => {
      if (!running || child.exitCode !== null || child.signalCode !== null) {
        return false;
      }
      const accepted = job.terminate();
      if (accepted) treeTerminationRequested = true;
      return accepted;
    }
  });
}

function createNativeKillOnCloseJob(): CodexWindowsRuntimeJob {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw nativeError("job_io_failed");
  }
  const bindings = windowsJobBindings();
  const handle = bindings.CreateJobObjectW(null, null) as bigint | null;
  if (isInvalidHandle(handle)) throw nativeError("job_io_failed");
  const jobHandle = handle as bigint;
  try {
    const limits = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0n,
        PerJobUserTimeLimit: 0n,
        LimitFlags: jobObjectLimitKillOnJobClose,
        MinimumWorkingSetSize: 0n,
        MaximumWorkingSetSize: 0n,
        ActiveProcessLimit: 0,
        Affinity: 0n,
        PriorityClass: 0,
        SchedulingClass: 0
      },
      IoInfo: {
        ReadOperationCount: 0n,
        WriteOperationCount: 0n,
        OtherOperationCount: 0n,
        ReadTransferCount: 0n,
        WriteTransferCount: 0n,
        OtherTransferCount: 0n
      },
      ProcessMemoryLimit: 0n,
      JobMemoryLimit: 0n,
      PeakProcessMemoryUsed: 0n,
      PeakJobMemoryUsed: 0n
    };
    if (
      !(bindings.SetInformationJobObject(
        jobHandle,
        jobObjectExtendedLimitInformation,
        limits,
        koffi.sizeof(bindings.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
      ) as boolean)
    ) {
      throw nativeError("job_io_failed");
    }
  } catch {
    bindings.CloseHandle(jobHandle);
    throw nativeError("job_io_failed");
  }
  let closed = false;
  return Object.freeze({
    assign(pid: number) {
      if (closed || !Number.isSafeInteger(pid) || pid < 1) {
        throw nativeError("job_io_failed");
      }
      const processHandle = bindings.OpenProcess(
        processSetQuota | processTerminate,
        0,
        pid
      ) as bigint | null;
      if (isInvalidHandle(processHandle)) throw nativeError("job_io_failed");
      try {
        if (!(bindings.AssignProcessToJobObject(jobHandle, processHandle) as boolean)) {
          throw nativeError("job_io_failed");
        }
      } finally {
        bindings.CloseHandle(processHandle);
      }
    },
    terminate() {
      if (closed) return false;
      if (!(bindings.TerminateJobObject(jobHandle, forcedProcessExitCode) as boolean)) {
        throw nativeError("job_io_failed");
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      if (!(bindings.CloseHandle(jobHandle) as boolean)) {
        throw nativeError("job_io_failed");
      }
    }
  });
}

let cachedWindowsJobBindings: ReturnType<typeof createWindowsJobBindings> | null =
  null;

function windowsJobBindings(): ReturnType<typeof createWindowsJobBindings> {
  cachedWindowsJobBindings ??= createWindowsJobBindings();
  return cachedWindowsJobBindings;
}

function createWindowsJobBindings() {
  const kernel32 = koffi.load("kernel32.dll");
  const handleValue = koffi.opaque("HOSTDECK_CODEX_JOB_HANDLE_VALUE");
  koffi.pointer("HOSTDECK_CODEX_JOB_HANDLE", handleValue);
  const basic = koffi.struct("HOSTDECK_CODEX_JOB_BASIC_LIMIT_INFORMATION", {
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t"
  });
  const io = koffi.struct("HOSTDECK_CODEX_JOB_IO_COUNTERS", {
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t"
  });
  const extended = koffi.struct(
    "HOSTDECK_CODEX_JOB_EXTENDED_LIMIT_INFORMATION",
    {
      BasicLimitInformation: basic,
      IoInfo: io,
      ProcessMemoryLimit: "uintptr_t",
      JobMemoryLimit: "uintptr_t",
      PeakProcessMemoryUsed: "uintptr_t",
      PeakJobMemoryUsed: "uintptr_t"
    }
  );
  return Object.freeze({
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION: extended,
    AssignProcessToJobObject: kernel32.func(
      "int32_t __stdcall AssignProcessToJobObject(HOSTDECK_CODEX_JOB_HANDLE hJob, HOSTDECK_CODEX_JOB_HANDLE hProcess)"
    ),
    CloseHandle: kernel32.func(
      "int32_t __stdcall CloseHandle(HOSTDECK_CODEX_JOB_HANDLE hObject)"
    ),
    CreateJobObjectW: kernel32.func(
      "HOSTDECK_CODEX_JOB_HANDLE __stdcall CreateJobObjectW(void *lpJobAttributes, const char16_t *lpName)"
    ),
    OpenProcess: kernel32.func(
      "HOSTDECK_CODEX_JOB_HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, int32_t bInheritHandle, uint32_t dwProcessId)"
    ),
    SetInformationJobObject: kernel32.func(
      "int32_t __stdcall SetInformationJobObject(HOSTDECK_CODEX_JOB_HANDLE hJob, int32_t JobObjectInformationClass, HOSTDECK_CODEX_JOB_EXTENDED_LIMIT_INFORMATION *lpJobObjectInfo, uint32_t cbJobObjectInfoLength)"
    ),
    TerminateJobObject: kernel32.func(
      "int32_t __stdcall TerminateJobObject(HOSTDECK_CODEX_JOB_HANDLE hJob, uint32_t uExitCode)"
    )
  });
}

function parseJob(candidate: unknown): CodexWindowsRuntimeJob {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as CodexWindowsRuntimeJob).assign !== "function" ||
    typeof (candidate as CodexWindowsRuntimeJob).terminate !== "function" ||
    typeof (candidate as CodexWindowsRuntimeJob).close !== "function"
  ) {
    throw nativeError("job_io_failed");
  }
  return candidate as CodexWindowsRuntimeJob;
}

function closeJobQuietly(job: CodexWindowsRuntimeJob): void {
  try {
    job.close();
  } catch {}
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(
      descriptor,
      data,
      offset,
      data.byteLength - offset,
      offset
    );
    if (written < 1) throw nativeError("authority_io_failed");
    offset += written;
  }
}

function isInvalidHandle(handle: bigint | null): boolean {
  return handle === null || handle === 0n || handle === -1n;
}

function nativeError(
  code: CodexWindowsRuntimeNativeErrorCode
): HostDeckCodexWindowsRuntimeNativeError {
  return new HostDeckCodexWindowsRuntimeNativeError(code);
}
