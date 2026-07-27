import { spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { parseCodexCliVersionOutput } from "@hostdeck/codex-adapter";

export const codexVersionProbeErrorCodes = Object.freeze([
  "aborted",
  "cleanup_failed",
  "command_failed",
  "command_timeout",
  "invalid_config",
  "output_invalid",
  "output_oversized",
  "spawn_failed"
] as const);

export type CodexVersionProbeErrorCode =
  (typeof codexVersionProbeErrorCodes)[number];

export interface CodexVersionProbeInput {
  readonly executable: string;
  readonly signal: AbortSignal;
  readonly timeout_ms: number;
}

export type CodexVersionProbe = (
  input: CodexVersionProbeInput
) => Promise<string>;

export const codexVersionProbeLimits = Object.freeze({
  cleanup_timeout_ms: 2_000,
  max_executable_bytes: 4_096,
  max_output_bytes: 4_096,
  maximum_timeout_ms: 10_000
});

export class HostDeckCodexVersionProbeError extends Error {
  constructor(readonly code: CodexVersionProbeErrorCode) {
    super(errorMessages[code]);
    this.name = "HostDeckCodexVersionProbeError";
    Object.freeze(this);
  }
}

interface ParsedInput {
  readonly executable: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnFailed: boolean;
}

const inputKeys = ["executable", "signal", "timeout_ms"] as const;
const errorMessages: Readonly<Record<CodexVersionProbeErrorCode, string>> =
  Object.freeze({
    aborted: "Codex version observation was aborted.",
    cleanup_failed: "Codex version observation did not clean up.",
    command_failed: "Codex version observation failed.",
    command_timeout: "Codex version observation timed out.",
    invalid_config: "Codex version observation configuration is invalid.",
    output_invalid: "Codex version output is invalid.",
    output_oversized: "Codex version output exceeded its bound.",
    spawn_failed: "Codex version observation could not start."
  });

export async function probeCodexVersion(
  input: CodexVersionProbeInput
): Promise<string> {
  const parsed = parseInput(input);
  if (parsed.signal.aborted) throw probeError("aborted");
  if (process.platform !== "linux") throw probeError("invalid_config");

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(parsed.executable, ["--version"], {
      cwd: "/",
      detached: true,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch {
    throw probeError("spawn_failed");
  }
  // Node may emit ENOENT before the validated outcome owner is installed.
  child.once("error", () => undefined);

  const pid = child.pid;
  if (
    !Number.isSafeInteger(pid) ||
    pid === undefined ||
    pid < 1 ||
    child.stdout === null ||
    child.stderr === null
  ) {
    killChild(child, pid);
    throw probeError("spawn_failed");
  }

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let pendingFailure: CodexVersionProbeErrorCode | null = null;
  let timeout: NodeJS.Timeout | null = null;
  const markFailure = (code: CodexVersionProbeErrorCode): void => {
    pendingFailure ??= code;
    killChild(child, pid);
  };
  const capture = (stream: "stderr" | "stdout", chunk: Buffer): void => {
    if (!Buffer.isBuffer(chunk)) {
      markFailure("output_invalid");
      return;
    }
    if (stream === "stdout") stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    if (
      stdoutBytes > codexVersionProbeLimits.max_output_bytes ||
      stderrBytes > codexVersionProbeLimits.max_output_bytes ||
      stdoutBytes + stderrBytes > codexVersionProbeLimits.max_output_bytes
    ) {
      markFailure("output_oversized");
      return;
    }
    if (stream === "stdout") stdout.push(Buffer.from(chunk));
  };
  const onAbort = (): void => markFailure("aborted");
  const outcome = new Promise<ChildOutcome>((resolve) => {
    let settled = false;
    const settle = (value: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", () => {
      pendingFailure ??= "spawn_failed";
      settle({ code: null, signal: null, spawnFailed: true });
    });
    child.once("close", (code, signal) =>
      settle({ code, signal, spawnFailed: false })
    );
  });

  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  parsed.signal.addEventListener("abort", onAbort, { once: true });
  if (parsed.signal.aborted) onAbort();
  timeout = setTimeout(
    () => markFailure("command_timeout"),
    parsed.timeoutMs
  );
  timeout.unref();

  let result: ChildOutcome;
  try {
    result = await outcome;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    parsed.signal.removeEventListener("abort", onAbort);
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
  }

  if (!(await settleOwnedProcessGroup(pid))) {
    throw probeError("cleanup_failed");
  }
  if (pendingFailure !== null) throw probeError(pendingFailure);
  if (result.spawnFailed) throw probeError("spawn_failed");
  if (result.signal !== null || result.code === null) {
    throw probeError("command_failed");
  }
  if (result.code !== 0) throw probeError("command_failed");
  if (stderrBytes !== 0) throw probeError("output_invalid");

  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(stdout, stdoutBytes)
    );
    return parseCodexCliVersionOutput(output);
  } catch {
    throw probeError("output_invalid");
  }
}

function parseInput(candidate: unknown): ParsedInput {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw probeError("invalid_config");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== inputKeys.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !inputKeys.includes(key as (typeof inputKeys)[number])
    )
  ) {
    throw probeError("invalid_config");
  }
  const values: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of inputKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw probeError("invalid_config");
    }
    values[key] = descriptor.value;
  }
  const executable = values.executable;
  const signal = values.signal;
  const timeoutMs = values.timeout_ms;
  if (
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    executable === "/" ||
    normalize(executable) !== executable ||
    Buffer.byteLength(executable, "utf8") >
      codexVersionProbeLimits.max_executable_bytes ||
    containsControl(executable) ||
    !isAbortSignal(signal) ||
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > codexVersionProbeLimits.maximum_timeout_ms
  ) {
    throw probeError("invalid_config");
  }
  return Object.freeze({ executable, signal, timeoutMs });
}

function killChild(
  child: ReturnType<typeof spawn>,
  pid: number | undefined
): void {
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch (error) {
      if (!isErrno(error, "ESRCH")) {
        try {
          child.kill("SIGKILL");
        } catch {
          return;
        }
        return;
      }
    }
  }
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  } catch {
    return;
  }
}

async function settleOwnedProcessGroup(pid: number): Promise<boolean> {
  if (!isProcessGroupAlive(pid)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isErrno(error, "ESRCH")) return false;
  }
  const startedAt = Date.now();
  while (
    Date.now() - startedAt <= codexVersionProbeLimits.cleanup_timeout_ms
  ) {
    if (!isProcessGroupAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  try {
    return (
      candidate instanceof AbortSignal &&
      typeof candidate.aborted === "boolean" &&
      typeof candidate.addEventListener === "function" &&
      typeof candidate.removeEventListener === "function"
    );
  } catch {
    return false;
  }
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function probeError(
  code: CodexVersionProbeErrorCode
): HostDeckCodexVersionProbeError {
  return new HostDeckCodexVersionProbeError(code);
}
