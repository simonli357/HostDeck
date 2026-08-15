import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

export const hostDeckCodexSystemdUnitName = "hostdeck-codex.service";
export const hostDeckSystemdUnitName = "hostdeck.service";

export type HostDeckSystemdUnitName =
  | typeof hostDeckCodexSystemdUnitName
  | typeof hostDeckSystemdUnitName;

export type HostDeckSystemdManagerErrorCode =
  | "aborted"
  | "cleanup_failed"
  | "command_failed"
  | "invalid_output"
  | "manager_unavailable"
  | "output_exceeded"
  | "timed_out";

export type HostDeckSystemdManagerStage =
  | "daemon_reload"
  | "disable"
  | "enable"
  | "restart_hostdeck"
  | "show_codex"
  | "show_hostdeck"
  | "start_codex"
  | "start_hostdeck"
  | "stop_codex"
  | "stop_hostdeck";

export interface HostDeckSystemdUnitState {
  readonly active_state: string;
  readonly fragment_path: string;
  readonly load_state: string;
  readonly main_pid: number;
  readonly need_daemon_reload: boolean;
  readonly sub_state: string;
  readonly unit_file_state: string;
}

export interface HostDeckSystemdUserManager {
  readonly daemonReload: () => Promise<void>;
  readonly disableHostDeck: () => Promise<void>;
  readonly enableHostDeck: () => Promise<void>;
  readonly restartHostDeck: () => Promise<void>;
  readonly show: (
    unit: HostDeckSystemdUnitName
  ) => Promise<HostDeckSystemdUnitState>;
  readonly startCodex: () => Promise<void>;
  readonly startHostDeck: () => Promise<void>;
  readonly stopCodex: () => Promise<void>;
  readonly stopHostDeck: () => Promise<void>;
}

export interface HostDeckSystemdCommandResult {
  readonly exit_code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type HostDeckSystemdCommandRunner = (
  args: readonly string[],
  input: {
    readonly max_output_bytes: number;
    readonly signal?: AbortSignal;
    readonly timeout_ms: number;
  }
) => Promise<HostDeckSystemdCommandResult>;

export interface CreateHostDeckSystemdUserManagerOptions {
  readonly run?: HostDeckSystemdCommandRunner;
  readonly signal?: AbortSignal;
  readonly systemctl_path?: string;
}

export class HostDeckSystemdManagerError extends Error {
  constructor(
    readonly code: HostDeckSystemdManagerErrorCode,
    readonly stage: HostDeckSystemdManagerStage,
    options?: ErrorOptions
  ) {
    super("HostDeck systemd user-manager operation failed.", options);
    this.name = "HostDeckSystemdManagerError";
  }
}

const maximumOutputBytes = 65_536;
const shortCommandTimeoutMs = 30_000;
const lifecycleCommandTimeoutMs = 120_000;
const showProperties = Object.freeze([
  "LoadState",
  "UnitFileState",
  "ActiveState",
  "SubState",
  "MainPID",
  "FragmentPath",
  "NeedDaemonReload"
] as const);
const stateTokenPattern = /^[a-z0-9_-]{1,64}$/u;
const maximumPathBytes = 4_096;

export function createHostDeckSystemdUserManager(
  options: CreateHostDeckSystemdUserManagerOptions = {}
): HostDeckSystemdUserManager {
  const run =
    options.run ??
    createDirectSystemdCommandRunner(
      options.systemctl_path ?? "/usr/bin/systemctl"
    );
  if (typeof run !== "function") {
    throw new TypeError("HostDeck systemd command runner is invalid.");
  }
  if (
    options.signal !== undefined &&
    !(options.signal instanceof AbortSignal)
  ) {
    throw new TypeError("HostDeck systemd manager signal is invalid.");
  }
  const signal = options.signal;

  const execute = async (
    stage: HostDeckSystemdManagerStage,
    args: readonly string[],
    timeoutMs: number
  ): Promise<HostDeckSystemdCommandResult> => {
    let result: HostDeckSystemdCommandResult;
    try {
      result = await run(
        Object.freeze(["--user", "--no-pager", ...args]),
        signal === undefined
          ? {
              max_output_bytes: maximumOutputBytes,
              timeout_ms: timeoutMs
            }
          : {
              max_output_bytes: maximumOutputBytes,
              signal,
              timeout_ms: timeoutMs
            }
      );
    } catch (error) {
      if (error instanceof HostDeckSystemdManagerError) {
        throw managerError(error.code, stage, error);
      }
      throw managerError("manager_unavailable", stage, error);
    }
    result = validateCommandResult(result, stage);
    if (result.exit_code !== 0) {
      throw managerError("command_failed", stage);
    }
    return result;
  };

  return Object.freeze({
    async daemonReload() {
      await execute("daemon_reload", ["daemon-reload"], shortCommandTimeoutMs);
    },
    async disableHostDeck() {
      await execute(
        "disable",
        ["disable", hostDeckSystemdUnitName],
        shortCommandTimeoutMs
      );
    },
    async enableHostDeck() {
      await execute(
        "enable",
        ["enable", hostDeckSystemdUnitName],
        shortCommandTimeoutMs
      );
    },
    async restartHostDeck() {
      await execute(
        "restart_hostdeck",
        ["restart", hostDeckSystemdUnitName],
        lifecycleCommandTimeoutMs
      );
    },
    async show(unit: HostDeckSystemdUnitName) {
      if (
        unit !== hostDeckSystemdUnitName &&
        unit !== hostDeckCodexSystemdUnitName
      ) {
        throw managerError("invalid_output", "show_hostdeck");
      }
      const stage =
        unit === hostDeckSystemdUnitName ? "show_hostdeck" : "show_codex";
      const result = await execute(
        stage,
        [
          "show",
          unit,
          ...showProperties.map((property) => `--property=${property}`)
        ],
        shortCommandTimeoutMs
      );
      return parseUnitState(result.stdout, stage);
    },
    async startHostDeck() {
      await execute(
        "start_hostdeck",
        ["start", hostDeckSystemdUnitName],
        lifecycleCommandTimeoutMs
      );
    },
    async startCodex() {
      await execute(
        "start_codex",
        ["start", hostDeckCodexSystemdUnitName],
        lifecycleCommandTimeoutMs
      );
    },
    async stopCodex() {
      await execute(
        "stop_codex",
        ["stop", hostDeckCodexSystemdUnitName],
        lifecycleCommandTimeoutMs
      );
    },
    async stopHostDeck() {
      await execute(
        "stop_hostdeck",
        ["stop", hostDeckSystemdUnitName],
        lifecycleCommandTimeoutMs
      );
    }
  });
}

export function createDirectSystemdCommandRunner(
  candidate: string
): HostDeckSystemdCommandRunner {
  const executable = resolveSystemctlExecutable(candidate);
  const environment = resolveSystemctlEnvironment();
  return async (args, input) =>
    await runDirectSystemctl(executable, args, input, environment);
}

function resolveSystemctlExecutable(candidate: string): string {
  try {
    if (
      typeof candidate !== "string" ||
      !isAbsolute(candidate) ||
      normalize(candidate) !== candidate ||
      Buffer.byteLength(candidate, "utf8") > maximumPathBytes ||
      /[\0\r\n]/u.test(candidate)
    ) {
      throw new TypeError();
    }
    const canonical = realpathSync.native(candidate);
    const metadata = lstatSync(canonical);
    if (
      canonical !== candidate ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.uid !== 0 && metadata.uid !== process.getuid?.()) ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new TypeError();
    }
    accessSync(canonical, fsConstants.X_OK);
    assertSecureDirectoryChain(dirname(canonical));
    return canonical;
  } catch (error) {
    throw managerError("manager_unavailable", "daemon_reload", error);
  }
}

async function runDirectSystemctl(
  executable: string,
  args: readonly string[],
  input: {
    readonly max_output_bytes: number;
    readonly signal?: AbortSignal;
    readonly timeout_ms: number;
  },
  environment: Readonly<Record<string, string>>
): Promise<HostDeckSystemdCommandResult> {
  if (
    !Array.isArray(args) ||
    args.length < 1 ||
    args.length > 64 ||
    args.some(
      (arg) =>
        typeof arg !== "string" ||
        arg.length < 1 ||
        Buffer.byteLength(arg, "utf8") > maximumPathBytes ||
        /[\0\r\n]/u.test(arg)
    ) ||
    !Number.isSafeInteger(input.max_output_bytes) ||
    input.max_output_bytes < 1 ||
    input.max_output_bytes > maximumOutputBytes ||
    !Number.isSafeInteger(input.timeout_ms) ||
    input.timeout_ms < 1 ||
    input.timeout_ms > lifecycleCommandTimeoutMs ||
    (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    throw new TypeError("HostDeck systemd command bounds are invalid.");
  }
  if (input.signal?.aborted === true) {
    throw managerError("aborted", "daemon_reload");
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, [...args], {
      cwd: "/",
      detached: true,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw managerError("manager_unavailable", "daemon_reload", error);
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
    throw managerError("manager_unavailable", "daemon_reload");
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let pendingError: HostDeckSystemdManagerError | null = null;
  const terminate = (error: HostDeckSystemdManagerError): void => {
    pendingError ??= error;
    killOwnedProcessGroup(child, pid);
  };
  const capture = (target: Buffer[], chunk: Buffer): void => {
    if (!Buffer.isBuffer(chunk)) {
      terminate(managerError("invalid_output", "daemon_reload"));
      return;
    }
    outputBytes += chunk.byteLength;
    if (outputBytes > input.max_output_bytes) {
      terminate(managerError("output_exceeded", "daemon_reload"));
      return;
    }
    target.push(Buffer.from(chunk));
  };
  const onAbort = (): void =>
    terminate(managerError("aborted", "daemon_reload"));
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
    }): void => {
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
  child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal !== undefined && signalIsAborted(input.signal)) onAbort();
  const timer = setTimeout(
    () => terminate(managerError("timed_out", "daemon_reload")),
    input.timeout_ms
  );
  timer.unref();

  let result: Awaited<typeof outcome>;
  try {
    result = await outcome;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
  }
  const groupSurvivedCommand = isProcessGroupAlive(pid);
  if (
    !(await settleOwnedProcessGroup(pid)) ||
    (pendingError === null && groupSurvivedCommand)
  ) {
    throw managerError("cleanup_failed", "daemon_reload");
  }
  if (pendingError !== null) throw pendingError;
  if (result.spawn_failed) {
    throw managerError("manager_unavailable", "daemon_reload");
  }
  if (result.signal !== null || result.code === null) {
    throw managerError("command_failed", "daemon_reload");
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return Object.freeze({
      exit_code: result.code,
      stderr: decoder.decode(Buffer.concat(stderr)),
      stdout: decoder.decode(Buffer.concat(stdout))
    });
  } catch (error) {
    throw managerError("invalid_output", "daemon_reload", error);
  }
}

function resolveSystemctlEnvironment(): Readonly<Record<string, string>> {
  try {
    const uid = process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) {
      throw new TypeError();
    }
    const runtimeDir = `/run/user/${uid}`;
    const runtimeMetadata = lstatSync(runtimeDir);
    if (
      runtimeMetadata.isSymbolicLink() ||
      !runtimeMetadata.isDirectory() ||
      runtimeMetadata.uid !== uid ||
      (runtimeMetadata.mode & 0o7777) !== 0o700 ||
      realpathSync.native(runtimeDir) !== runtimeDir
    ) {
      throw new TypeError();
    }
    const home = parseEnvironmentPath(process.env.HOME);
    const configHome = process.env.XDG_CONFIG_HOME;
    return Object.freeze({
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
      HOME: home,
      LANG: "C",
      LC_ALL: "C",
      SYSTEMD_COLORS: "0",
      SYSTEMD_PAGER: "cat",
      SYSTEMD_PAGERSECURE: "1",
      XDG_RUNTIME_DIR: runtimeDir,
      ...(configHome === undefined
        ? {}
        : { XDG_CONFIG_HOME: parseEnvironmentPath(configHome) })
    });
  } catch (error) {
    throw managerError("manager_unavailable", "daemon_reload", error);
  }
}

function parseEnvironmentPath(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    !isAbsolute(candidate) ||
    candidate === "/" ||
    normalize(candidate) !== candidate ||
    Buffer.byteLength(candidate, "utf8") > maximumPathBytes ||
    /[\0\r\n]/u.test(candidate)
  ) {
    throw new TypeError();
  }
  return candidate;
}

function assertSecureDirectoryChain(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new TypeError();
  let cursor = path;
  for (;;) {
    const metadata = lstatSync(cursor);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.uid !== 0 && metadata.uid !== uid) ||
      (metadata.mode & 0o022) !== 0 ||
      realpathSync.native(cursor) !== cursor
    ) {
      throw new TypeError();
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
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

function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function validateCommandResult(
  candidate: HostDeckSystemdCommandResult,
  stage: HostDeckSystemdManagerStage
): HostDeckSystemdCommandResult {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw managerError("invalid_output", stage);
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const expectedKeys = ["exit_code", "stderr", "stdout"];
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("\0") !== expectedKeys.join("\0") ||
    expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor);
    })
  ) {
    throw managerError("invalid_output", stage);
  }
  const exitCode = descriptors.exit_code?.value;
  const stdout = descriptors.stdout?.value;
  const stderr = descriptors.stderr?.value;
  if (
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255 ||
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") >
      maximumOutputBytes ||
    /\0/u.test(stdout) ||
    /\0/u.test(stderr)
  ) {
    throw managerError("invalid_output", stage);
  }
  return Object.freeze({ exit_code: exitCode, stderr, stdout });
}

function parseUnitState(
  output: string,
  stage: HostDeckSystemdManagerStage
): HostDeckSystemdUnitState {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw managerError("invalid_output", stage);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      !showProperties.includes(key as (typeof showProperties)[number]) ||
      values.has(key)
    ) {
      throw managerError("invalid_output", stage);
    }
    values.set(key, value);
  }
  if (
    values.size !== showProperties.length ||
    showProperties.some((property) => !values.has(property))
  ) {
    throw managerError("invalid_output", stage);
  }
  const loadState = parseStateToken(values.get("LoadState"), stage);
  const unitFileState = parseStateToken(values.get("UnitFileState"), stage, true);
  const activeState = parseStateToken(values.get("ActiveState"), stage);
  const subState = parseStateToken(values.get("SubState"), stage);
  const mainPid = parseMainPid(values.get("MainPID"), stage);
  const fragmentPath = parseFragmentPath(values.get("FragmentPath"), stage);
  const reload = values.get("NeedDaemonReload");
  if (reload !== "yes" && reload !== "no") {
    throw managerError("invalid_output", stage);
  }
  if (
    activeState === "active" && mainPid < 1
  ) {
    throw managerError("invalid_output", stage);
  }
  return Object.freeze({
    active_state: activeState,
    fragment_path: fragmentPath,
    load_state: loadState,
    main_pid: mainPid,
    need_daemon_reload: reload === "yes",
    sub_state: subState,
    unit_file_state: unitFileState
  });
}

function parseStateToken(
  candidate: string | undefined,
  stage: HostDeckSystemdManagerStage,
  allowEmpty = false
): string {
  if (
    candidate === undefined ||
    (!allowEmpty && candidate.length === 0) ||
    (candidate.length > 0 && !stateTokenPattern.test(candidate))
  ) {
    throw managerError("invalid_output", stage);
  }
  return candidate;
}

function parseMainPid(
  candidate: string | undefined,
  stage: HostDeckSystemdManagerStage
): number {
  if (candidate === undefined || !/^(?:0|[1-9][0-9]{0,15})$/u.test(candidate)) {
    throw managerError("invalid_output", stage);
  }
  const value = Number(candidate);
  if (!Number.isSafeInteger(value)) throw managerError("invalid_output", stage);
  return value;
}

function parseFragmentPath(
  candidate: string | undefined,
  stage: HostDeckSystemdManagerStage
): string {
  if (
    candidate === undefined ||
    Buffer.byteLength(candidate, "utf8") > maximumPathBytes ||
    /[\0\r\n]/u.test(candidate) ||
    (candidate.length > 0 && (!isAbsolute(candidate) || normalize(candidate) !== candidate))
  ) {
    throw managerError("invalid_output", stage);
  }
  return candidate;
}

function managerError(
  code: HostDeckSystemdManagerErrorCode,
  stage: HostDeckSystemdManagerStage,
  cause?: unknown
): HostDeckSystemdManagerError {
  return new HostDeckSystemdManagerError(
    code,
    stage,
    cause === undefined ? undefined : { cause }
  );
}
