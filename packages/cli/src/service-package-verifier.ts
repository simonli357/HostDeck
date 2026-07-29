import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export type HostDeckServicePackageVerifierErrorCode =
  | "aborted"
  | "cleanup_failed"
  | "command_failed"
  | "invalid_input"
  | "output_invalid"
  | "output_oversized"
  | "spawn_failed"
  | "timed_out";

export class HostDeckServicePackageVerifierError extends Error {
  constructor(readonly code: HostDeckServicePackageVerifierErrorCode) {
    super("HostDeck service package verification failed.");
    this.name = "HostDeckServicePackageVerifierError";
  }
}

export interface RunHostDeckServicePackageVerifierInput {
  readonly node_bin: string;
  readonly package_root: string;
  readonly signal: AbortSignal;
  readonly timeout_ms: number;
}

const maximumOutputBytes = 4_096;
const maximumPathBytes = 4_096;
const maximumTimeoutMs = 120_000;

export async function runHostDeckServicePackageVerifier(
  candidate: RunHostDeckServicePackageVerifierInput
): Promise<void> {
  const input = parseInput(candidate);
  if (input.signal.aborted) throw verifierError("aborted");
  const verifierPath = join(input.packageRoot, "verify.mjs");
  assertVerifier(verifierPath);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.nodeBin, [verifierPath, input.packageRoot], {
      cwd: "/",
      detached: true,
      env: {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch {
    throw verifierError("spawn_failed");
  }
  child.once("error", () => undefined);
  const pid = child.pid;
  if (
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    child.stdout === null ||
    child.stderr === null
  ) {
    killOwnedProcessGroup(child, pid);
    throw verifierError("spawn_failed");
  }

  let outputBytes = 0;
  let stderrBytes = 0;
  const output: Buffer[] = [];
  let pendingFailure: HostDeckServicePackageVerifierErrorCode | null = null;
  const fail = (code: HostDeckServicePackageVerifierErrorCode): void => {
    pendingFailure ??= code;
    killOwnedProcessGroup(child, pid);
  };
  const capture = (stream: "stderr" | "stdout", chunk: Buffer): void => {
    if (!Buffer.isBuffer(chunk)) {
      fail("output_invalid");
      return;
    }
    outputBytes += chunk.byteLength;
    if (stream === "stderr") stderrBytes += chunk.byteLength;
    if (outputBytes > maximumOutputBytes) fail("output_oversized");
    else output.push(Buffer.from(chunk));
  };
  const onAbort = (): void => fail("aborted");
  const outcome = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly spawn_failed: boolean;
  }>((resolve) => {
    let settled = false;
    const settle = (value: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly spawn_failed: boolean;
    }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", () =>
      settle({ code: null, signal: null, spawn_failed: true })
    );
    child.once("close", (code, signal) =>
      settle({ code, signal, spawn_failed: false })
    );
  });
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  const timer = setTimeout(() => fail("timed_out"), input.timeoutMs);
  timer.unref();

  let result: Awaited<typeof outcome>;
  try {
    result = await outcome;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
  }
  const groupSurvivedCommand = isProcessGroupAlive(pid);
  if (
    !(await settleOwnedProcessGroup(pid)) ||
    (pendingFailure === null && groupSurvivedCommand)
  ) {
    throw verifierError("cleanup_failed");
  }
  if (pendingFailure !== null) throw verifierError(pendingFailure);
  if (
    result.spawn_failed ||
    result.signal !== null ||
    result.code === null ||
    result.code !== 0
  ) {
    throw verifierError(result.spawn_failed ? "spawn_failed" : "command_failed");
  }
  if (stderrBytes !== 0) throw verifierError("output_invalid");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output));
  } catch {
    throw verifierError("output_invalid");
  }
}

function parseInput(candidate: unknown): {
  readonly nodeBin: string;
  readonly packageRoot: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
} {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw verifierError("invalid_input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const expected = ["node_bin", "package_root", "signal", "timeout_ms"];
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("\0") !== expected.sort().join("\0") ||
    expected.some((key) =>
      descriptors[key] === undefined ||
      !("value" in (descriptors[key] as PropertyDescriptor))
    )
  ) {
    throw verifierError("invalid_input");
  }
  const nodeBin = descriptors.node_bin?.value;
  const packageRoot = descriptors.package_root?.value;
  const signal = descriptors.signal?.value;
  const timeoutMs = descriptors.timeout_ms?.value;
  if (
    !isSafeAbsolutePath(nodeBin) ||
    !isSafeAbsolutePath(packageRoot) ||
    !(signal instanceof AbortSignal) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maximumTimeoutMs
  ) {
    throw verifierError("invalid_input");
  }
  return Object.freeze({ nodeBin, packageRoot, signal, timeoutMs });
}

function isSafeAbsolutePath(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    isAbsolute(candidate) &&
    candidate !== "/" &&
    normalize(candidate) === candidate &&
    Buffer.byteLength(candidate, "utf8") <= maximumPathBytes &&
    !/[\0\r\n]/u.test(candidate)
  );
}

function assertVerifier(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== 0o644 ||
      realpathSync.native(path) !== path
    ) {
      throw new TypeError();
    }
  } catch {
    throw verifierError("invalid_input");
  }
}

function killOwnedProcessGroup(
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
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function verifierError(
  code: HostDeckServicePackageVerifierErrorCode
): HostDeckServicePackageVerifierError {
  return new HostDeckServicePackageVerifierError(code);
}
