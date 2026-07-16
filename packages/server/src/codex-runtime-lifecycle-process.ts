import { type ChildProcess, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync
} from "node:fs";
import { isAbsolute } from "node:path";

export type CodexLifecycleScenarioFailureCode =
  | "cleanup_failed"
  | "invalid_command"
  | "nonzero_exit"
  | "output_overflow"
  | "ownership_invalid"
  | "signaled"
  | "spawn_failed"
  | "timeout";

export class CodexLifecycleScenarioError extends Error {
  readonly code: CodexLifecycleScenarioFailureCode;
  readonly scenario: string;

  constructor(
    code: CodexLifecycleScenarioFailureCode,
    scenario: string,
    message: string
  ) {
    super(message);
    this.name = "CodexLifecycleScenarioError";
    this.code = code;
    this.scenario = scenario;
  }
}

export interface OwnedLifecycleScenarioCommand {
  readonly scenario: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
}

export interface OwnedLifecycleScenarioResult {
  readonly scenario: string;
  readonly exit_code: 0;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawn_failed: boolean;
}

export async function runOwnedLifecycleScenario(
  input: OwnedLifecycleScenarioCommand
): Promise<OwnedLifecycleScenarioResult> {
  const command = parseCommand(input);
  if (process.platform !== "linux") {
    throw scenarioError(
      "ownership_invalid",
      command.scenario,
      "Lifecycle scenario process ownership requires Linux."
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw scenarioError(
      "spawn_failed",
      command.scenario,
      "Lifecycle scenario could not be spawned."
    );
  }

  const pid = requireChildPid(child, command.scenario);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let forcedFailure: CodexLifecycleScenarioFailureCode | null = null;
  let stopPromise: Promise<void> | null = null;
  const stopOwnedGroup = () => {
    stopPromise ??= terminateOwnedProcessGroup(pid, command.scenario);
    return stopPromise;
  };
  const recordOutput = (stream: "stderr" | "stdout", chunk: Buffer) => {
    if (stream === "stdout") stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    if (
      stdoutBytes > command.max_output_bytes ||
      stderrBytes > command.max_output_bytes ||
      stdoutBytes + stderrBytes > command.max_output_bytes
    ) {
      forcedFailure ??= "output_overflow";
      void stopOwnedGroup();
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => recordOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => recordOutput("stderr", chunk));

  let timeout: NodeJS.Timeout | null = null;
  const outcomePromise = new Promise<ChildOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", () =>
      settle({ code: null, signal: null, spawn_failed: true })
    );
    child.once("close", (code, signal) =>
      settle({ code, signal, spawn_failed: false })
    );
  });

  try {
    await waitForSpawn(child, command.scenario);
    assertOwnedProcessGroupLeader(pid, command.scenario);
    timeout = setTimeout(() => {
      forcedFailure ??= "timeout";
      void stopOwnedGroup();
    }, command.timeout_ms);
    const outcome = await outcomePromise;
    if (timeout !== null) clearTimeout(timeout);
    if (stopPromise !== null) await stopPromise;

    if (forcedFailure !== null) {
      throw scenarioFailure(forcedFailure, command.scenario);
    }
    if (outcome.spawn_failed) {
      throw scenarioFailure("spawn_failed", command.scenario);
    }
    if (outcome.signal !== null) {
      throw scenarioFailure("signaled", command.scenario);
    }
    if (outcome.code !== 0) {
      throw scenarioFailure("nonzero_exit", command.scenario);
    }
    if (!(await waitForProcessGroupGone(pid, 2_000))) {
      await stopOwnedGroup();
      throw scenarioFailure("cleanup_failed", command.scenario);
    }
    return Object.freeze({
      scenario: command.scenario,
      exit_code: 0,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes
    });
  } catch (error) {
    if (timeout !== null) clearTimeout(timeout);
    try {
      await stopOwnedGroup();
    } catch {
      throw scenarioFailure("cleanup_failed", command.scenario);
    }
    if (error instanceof CodexLifecycleScenarioError) throw error;
    throw scenarioFailure("ownership_invalid", command.scenario);
  } finally {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
  }
}

export function isLifecycleProcessGroupAlive(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function parseCommand(
  input: OwnedLifecycleScenarioCommand
): OwnedLifecycleScenarioCommand {
  if (!isPlainDataObject(input)) {
    throw scenarioError(
      "invalid_command",
      "invalid",
      "Lifecycle scenario command must be plain data."
    );
  }
  assertExactKeys(input, [
    "args",
    "cwd",
    "env",
    "executable",
    "max_output_bytes",
    "scenario",
    "timeout_ms"
  ]);
  const scenario = requireBoundedText(input.scenario, "scenario", 64);
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(scenario)) {
    throw scenarioError(
      "invalid_command",
      "invalid",
      "Lifecycle scenario name is invalid."
    );
  }
  const executable = requireAbsoluteFile(input.executable, scenario);
  const cwd = requireAbsoluteDirectory(input.cwd, scenario);
  if (!Array.isArray(input.args) || input.args.length < 1 || input.args.length > 32) {
    throw scenarioFailure("invalid_command", scenario);
  }
  const args = input.args.map((value) =>
    requireBoundedText(value, "argument", 8_192)
  );
  if (!isPlainDataObject(input.env)) {
    throw scenarioFailure("invalid_command", scenario);
  }
  const environmentEntries = Object.entries(input.env);
  if (environmentEntries.length > 256) {
    throw scenarioFailure("invalid_command", scenario);
  }
  const env: NodeJS.ProcessEnv = {};
  let environmentBytes = 0;
  for (const [key, value] of environmentEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw scenarioFailure("invalid_command", scenario);
    }
    if (value !== undefined) {
      const parsedValue = requireBoundedEnvironmentValue(value);
      environmentBytes += Buffer.byteLength(key, "utf8");
      environmentBytes += Buffer.byteLength(parsedValue, "utf8");
      if (environmentBytes > 512 * 1_024) {
        throw scenarioFailure("invalid_command", scenario);
      }
      env[key] = parsedValue;
    }
  }
  const timeoutMs = requireBoundedInteger(
    input.timeout_ms,
    100,
    300_000,
    scenario
  );
  const maxOutputBytes = requireBoundedInteger(
    input.max_output_bytes,
    1_024,
    1_048_576,
    scenario
  );
  return Object.freeze({
    scenario,
    executable,
    args: Object.freeze(args),
    cwd,
    env: Object.freeze(env),
    timeout_ms: timeoutMs,
    max_output_bytes: maxOutputBytes
  });
}

async function waitForSpawn(child: ChildProcess, scenario: string): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(scenarioFailure("spawn_failed", scenario));
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return;
  }
  throw scenarioFailure("spawn_failed", scenario);
}

async function terminateOwnedProcessGroup(
  processGroupId: number,
  scenario: string
): Promise<void> {
  if (!isLifecycleProcessGroupAlive(processGroupId)) return;
  sendGroupSignal(processGroupId, "SIGTERM", scenario);
  if (await waitForProcessGroupGone(processGroupId, 2_000)) return;
  sendGroupSignal(processGroupId, "SIGKILL", scenario);
  if (!(await waitForProcessGroupGone(processGroupId, 1_000))) {
    throw scenarioFailure("cleanup_failed", scenario);
  }
}

function sendGroupSignal(
  processGroupId: number,
  signal: NodeJS.Signals,
  scenario: string
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH")) {
      throw scenarioFailure("cleanup_failed", scenario);
    }
  }
}

async function waitForProcessGroupGone(
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (!isLifecycleProcessGroupAlive(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isLifecycleProcessGroupAlive(processGroupId);
}

function assertOwnedProcessGroupLeader(pid: number, scenario: string): void {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    throw scenarioFailure("ownership_invalid", scenario);
  }
  const commandEnd = raw.lastIndexOf(")");
  const fields = commandEnd < 0 ? [] : raw.slice(commandEnd + 2).trim().split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  if (processGroupId !== pid || sessionId !== pid) {
    throw scenarioFailure("ownership_invalid", scenario);
  }
}

function requireChildPid(child: ChildProcess, scenario: string): number {
  if (!Number.isSafeInteger(child.pid) || (child.pid as number) < 1) {
    throw scenarioFailure("spawn_failed", scenario);
  }
  return child.pid as number;
}

function requireAbsoluteFile(candidate: unknown, scenario: string): string {
  const value = requireBoundedText(candidate, "executable", 4_096);
  if (!isAbsolute(value)) throw scenarioFailure("invalid_command", scenario);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(value);
    accessSync(value, constants.X_OK);
  } catch {
    throw scenarioFailure("invalid_command", scenario);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw scenarioFailure("invalid_command", scenario);
  }
  return value;
}

function requireAbsoluteDirectory(candidate: unknown, scenario: string): string {
  const value = requireBoundedText(candidate, "cwd", 4_096);
  if (!isAbsolute(value)) throw scenarioFailure("invalid_command", scenario);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(value);
  } catch {
    throw scenarioFailure("invalid_command", scenario);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw scenarioFailure("invalid_command", scenario);
  }
  return value;
}

function requireBoundedText(
  candidate: unknown,
  label: string,
  maximumBytes: number
): string {
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    Buffer.byteLength(candidate, "utf8") > maximumBytes ||
    candidate.includes("\0")
  ) {
    throw scenarioError(
      "invalid_command",
      "invalid",
      `Lifecycle scenario ${label} is invalid.`
    );
  }
  return candidate;
}

function requireBoundedEnvironmentValue(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    Buffer.byteLength(candidate, "utf8") > 32_768 ||
    candidate.includes("\0")
  ) {
    throw scenarioFailure("invalid_command", "invalid");
  }
  return candidate;
}

function requireBoundedInteger(
  candidate: unknown,
  minimum: number,
  maximum: number,
  scenario: string
): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw scenarioFailure("invalid_command", scenario);
  }
  return candidate;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): void {
  const observed = Object.keys(value).sort();
  if (
    observed.length !== expected.length ||
    observed.some((key, index) => key !== expected[index])
  ) {
    throw scenarioError(
      "invalid_command",
      "invalid",
      "Lifecycle scenario command keys are invalid."
    );
  }
}

function isPlainDataObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor
  );
}

function scenarioFailure(
  code: CodexLifecycleScenarioFailureCode,
  scenario: string
): CodexLifecycleScenarioError {
  const messages: Record<CodexLifecycleScenarioFailureCode, string> = {
    cleanup_failed: "Lifecycle scenario cleanup failed.",
    invalid_command: "Lifecycle scenario command is invalid.",
    nonzero_exit: "Lifecycle scenario exited unsuccessfully.",
    output_overflow: "Lifecycle scenario output exceeded its bound.",
    ownership_invalid: "Lifecycle scenario process ownership is invalid.",
    signaled: "Lifecycle scenario exited from an unexpected signal.",
    spawn_failed: "Lifecycle scenario could not start.",
    timeout: "Lifecycle scenario exceeded its deadline."
  };
  return scenarioError(code, scenario, messages[code]);
}

function scenarioError(
  code: CodexLifecycleScenarioFailureCode,
  scenario: string,
  message: string
): CodexLifecycleScenarioError {
  return new CodexLifecycleScenarioError(code, scenario, message);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
