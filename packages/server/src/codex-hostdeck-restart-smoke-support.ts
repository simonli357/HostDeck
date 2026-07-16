import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const hostDeckRestartWorkerModes = [
  "service_initial",
  "service_restart",
  "foreground_first",
  "foreground_second"
] as const;

export type HostDeckRestartWorkerMode =
  (typeof hostDeckRestartWorkerModes)[number];

export interface HostDeckRestartWorkerEnvironment {
  readonly mode: HostDeckRestartWorkerMode;
  readonly root: string;
  readonly state_dir: string;
  readonly config_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
  readonly codex_home: string;
  readonly codex_bin: string;
  readonly project_dir: string;
  readonly marker_path: string;
  readonly shared_path: string;
  readonly ready_path: string;
  readonly result_path: string;
  readonly release_path: string | null;
  readonly service_pid: number | null;
}

export interface HostDeckRestartSupervisorReport {
  readonly mode: "foreground_child" | "service_owned";
  readonly phase: "ready";
  readonly spawn_attempts: number;
  readonly term_signals: number;
  readonly kill_signals: number;
  readonly cleanup_failures: number;
}

export interface HostDeckRestartWorkerReadyReport {
  readonly schema_version: 1;
  readonly phase: "ready";
  readonly mode: HostDeckRestartWorkerMode;
  readonly hostdeck_pid: number;
  readonly runtime_pid: number;
  readonly lease_pid: number;
  readonly lease_replaced_stale_metadata: boolean;
  readonly socket_identity: string;
  readonly thread_id: string | null;
  readonly turn_id: string | null;
  readonly turn_state: "in_progress" | null;
  readonly compatibility_state: "ready";
  readonly generation: number | null;
  readonly boundary_count: number;
  readonly resumed_count: number;
  readonly ready_count: number;
  readonly turn_start_request_count: number;
  readonly accepted_model_turn_count: number;
  readonly supervisor: HostDeckRestartSupervisorReport;
}

export interface HostDeckRestartWorkerResultReport {
  readonly schema_version: 1;
  readonly phase: "completed";
  readonly mode: HostDeckRestartWorkerMode;
  readonly hostdeck_pid: number;
  readonly runtime_pid: number;
  readonly runtime_alive_after_close: boolean;
  readonly socket_present_after_close: boolean;
  readonly lease_released: boolean;
  readonly database_closed: boolean;
  readonly controller_closed: boolean;
  readonly supervisor_phase: "closed";
  readonly cleanup_failures: number;
}

export type HostDeckRestartWorkerReport =
  | HostDeckRestartWorkerReadyReport
  | HostDeckRestartWorkerResultReport;

const environmentNames = Object.freeze({
  mode: "HOSTDECK_RESTART_WORKER_MODE",
  root: "HOSTDECK_RESTART_ROOT",
  state_dir: "HOSTDECK_RESTART_STATE_DIR",
  config_dir: "HOSTDECK_RESTART_CONFIG_DIR",
  runtime_dir: "HOSTDECK_RESTART_RUNTIME_DIR",
  database_path: "HOSTDECK_RESTART_DATABASE_PATH",
  codex_home: "HOSTDECK_RESTART_CODEX_HOME",
  codex_bin: "HOSTDECK_RESTART_CODEX_BIN",
  project_dir: "HOSTDECK_RESTART_PROJECT_DIR",
  marker_path: "HOSTDECK_RESTART_MARKER_PATH",
  shared_path: "HOSTDECK_RESTART_SHARED_PATH",
  ready_path: "HOSTDECK_RESTART_READY_PATH",
  result_path: "HOSTDECK_RESTART_RESULT_PATH",
  release_path: "HOSTDECK_RESTART_RELEASE_PATH",
  service_pid: "HOSTDECK_RESTART_SERVICE_PID"
} as const);

const maxJsonBytes = 16 * 1024;
const maxPathBytes = 4_096;
const reportReadyKeys = [
  "accepted_model_turn_count",
  "boundary_count",
  "compatibility_state",
  "generation",
  "hostdeck_pid",
  "lease_pid",
  "lease_replaced_stale_metadata",
  "mode",
  "phase",
  "ready_count",
  "resumed_count",
  "runtime_pid",
  "schema_version",
  "socket_identity",
  "supervisor",
  "thread_id",
  "turn_id",
  "turn_start_request_count",
  "turn_state"
] as const;
const reportResultKeys = [
  "cleanup_failures",
  "controller_closed",
  "database_closed",
  "hostdeck_pid",
  "lease_released",
  "mode",
  "phase",
  "runtime_alive_after_close",
  "runtime_pid",
  "schema_version",
  "socket_present_after_close",
  "supervisor_phase"
] as const;
const supervisorKeys = [
  "cleanup_failures",
  "kill_signals",
  "mode",
  "phase",
  "spawn_attempts",
  "term_signals"
] as const;

export function parseHostDeckRestartWorkerEnvironment(
  env: NodeJS.ProcessEnv
): HostDeckRestartWorkerEnvironment {
  const mode = requireMode(env[environmentNames.mode]);
  const root = requireAbsolutePath(env[environmentNames.root], "root");
  const stateDir = requireDescendantPath(
    env[environmentNames.state_dir],
    root,
    "state directory"
  );
  const configDir = requireDescendantPath(
    env[environmentNames.config_dir],
    root,
    "config directory"
  );
  const runtimeDir = requireDescendantPath(
    env[environmentNames.runtime_dir],
    root,
    "runtime directory"
  );
  const databasePath = requireDescendantPath(
    env[environmentNames.database_path],
    stateDir,
    "database path"
  );
  const codexHome = requireDescendantPath(
    env[environmentNames.codex_home],
    root,
    "Codex home"
  );
  const projectDir = requireDescendantPath(
    env[environmentNames.project_dir],
    root,
    "project directory"
  );
  const markerPath = requireDescendantPath(
    env[environmentNames.marker_path],
    projectDir,
    "marker path"
  );
  const sharedPath = requireDescendantPath(
    env[environmentNames.shared_path],
    root,
    "shared state path"
  );
  const readyPath = requireDescendantPath(
    env[environmentNames.ready_path],
    root,
    "ready report path"
  );
  const resultPath = requireDescendantPath(
    env[environmentNames.result_path],
    root,
    "result report path"
  );
  const releasePath =
    mode === "service_restart"
      ? null
      : requireDescendantPath(
          env[environmentNames.release_path],
          root,
          "release path"
        );
  const servicePid = mode.startsWith("service_")
    ? requirePositiveInteger(
        env[environmentNames.service_pid],
        "service pid"
      )
    : null;
  const codexBin = requireAbsolutePath(
    env[environmentNames.codex_bin],
    "Codex binary"
  );

  const distinctOwnedPaths = [
    stateDir,
    configDir,
    runtimeDir,
    databasePath,
    codexHome,
    projectDir,
    markerPath,
    sharedPath,
    readyPath,
    resultPath,
    ...(releasePath === null ? [] : [releasePath])
  ];
  if (new Set(distinctOwnedPaths).size !== distinctOwnedPaths.length) {
    throw new TypeError("HostDeck restart worker paths must be distinct.");
  }

  return Object.freeze({
    mode,
    root,
    state_dir: stateDir,
    config_dir: configDir,
    runtime_dir: runtimeDir,
    database_path: databasePath,
    codex_home: codexHome,
    codex_bin: codexBin,
    project_dir: projectDir,
    marker_path: markerPath,
    shared_path: sharedPath,
    ready_path: readyPath,
    result_path: resultPath,
    release_path: releasePath,
    service_pid: servicePid
  });
}

export function writeHostDeckRestartWorkerReport(
  path: string,
  report: HostDeckRestartWorkerReport
): void {
  const parsed = parseHostDeckRestartWorkerReport(report);
  writeHostDeckRestartPrivateJson(path, parsed);
}

export function writeHostDeckRestartPrivateJson(
  path: string,
  value: unknown
): void {
  writeCodexSmokePrivateJson(path, value);
}

export function writeCodexSmokePrivateJson(
  path: string,
  value: unknown
): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Codex smoke private value is not JSON serializable.");
  }
  const data = Buffer.from(`${encoded}\n`, "utf8");
  if (data.byteLength > maxJsonBytes) {
    throw new TypeError("Codex smoke private JSON exceeds its byte bound.");
  }
  const temporaryPath = `${path}.${process.pid}.tmp`;
  let descriptor: number | null = null;
  let linked = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600
    );
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporaryPath, path);
    linked = true;
    unlinkSync(temporaryPath);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (linked) {
      try {
        unlinkSync(path);
      } catch {
        // Preserve the publication failure; the private parent is removed by outer cleanup.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already be removed.
    }
    throw error;
  }
}

export function readHostDeckRestartWorkerReport(
  path: string,
  expectedPhase: HostDeckRestartWorkerReport["phase"]
): HostDeckRestartWorkerReport {
  const parsed = parseHostDeckRestartWorkerReport(
    readHostDeckRestartPrivateJson(path)
  );
  if (parsed.phase !== expectedPhase) {
    throw new TypeError("HostDeck restart worker report phase is unexpected.");
  }
  return parsed;
}

export function readHostDeckRestartPrivateJson(path: string): unknown {
  return readCodexSmokePrivateJson(path);
}

export function readCodexSmokePrivateJson(path: string): unknown {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 2 ||
    metadata.size > maxJsonBytes
  ) {
    throw new TypeError("Codex smoke private JSON file is insecure or invalid.");
  }
  if (
    process.getuid !== undefined &&
    metadata.uid !== process.getuid()
  ) {
    throw new TypeError("Codex smoke private JSON has a foreign owner.");
  }
  const raw = readFileSync(path, "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new TypeError("Codex smoke private file is not valid JSON.", {
      cause: error
    });
  }
  return decoded;
}

export function parseHostDeckRestartWorkerReport(
  candidate: unknown
): HostDeckRestartWorkerReport {
  const record = requireRecord(candidate, "worker report");
  if (record.phase === "ready") return parseReadyReport(record);
  if (record.phase === "completed") return parseResultReport(record);
  throw new TypeError("HostDeck restart worker report phase is invalid.");
}

export function socketIdentity(path: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isSocket() || metadata.nlink !== 1) {
    throw new TypeError("HostDeck restart socket identity requires one Unix socket.");
  }
  return `${metadata.dev}:${metadata.ino}`;
}

export function isProcessAlive(pid: number): boolean {
  requireSafePositive(pid, "process pid");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

export function readDirectChildProcessIds(pid = process.pid): readonly number[] {
  requireSafePositive(pid, "parent pid");
  const taskRoot = `/proc/${pid}/task`;
  const taskIds = readdirSync(taskRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => requirePositiveInteger(entry.name, "task id"))
    .sort((left, right) => left - right);
  if (taskIds.length < 1 || taskIds.length > 256) {
    throw new TypeError("HostDeck restart worker task inventory is invalid.");
  }
  const values: number[] = [];
  for (const taskId of taskIds) {
    let raw: string;
    try {
      raw = readFileSync(
        `${taskRoot}/${taskId}/children`,
        "utf8"
      ).trim();
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (raw === "") continue;
    values.push(
      ...raw.split(/\s+/u).map((value) =>
        requirePositiveInteger(value, "child pid")
      )
    );
  }
  if (values.length > 32 || new Set(values).size !== values.length) {
    throw new TypeError("HostDeck restart worker child-process inventory is invalid.");
  }
  return Object.freeze(values.sort((left, right) => left - right));
}

export function readBoundedProcessCommandLine(pid: number): string {
  requireSafePositive(pid, "process pid");
  const data = readFileSync(`/proc/${pid}/cmdline`);
  if (data.byteLength < 1 || data.byteLength > maxJsonBytes) {
    throw new TypeError("HostDeck restart worker process command line is invalid.");
  }
  return data.toString("utf8").replaceAll("\0", " ").trim();
}

function parseReadyReport(
  record: Readonly<Record<string, unknown>>
): HostDeckRestartWorkerReadyReport {
  assertExactKeys(record, reportReadyKeys, "ready report");
  const mode = requireMode(record.mode);
  const threadId = requireNullableBoundedString(record.thread_id, "thread id");
  const turnId = requireNullableBoundedString(record.turn_id, "turn id");
  const turnState = record.turn_state === null ? null : record.turn_state;
  if (
    (mode.startsWith("service_") &&
      (threadId === null || turnId === null || turnState !== "in_progress")) ||
    (mode.startsWith("foreground_") &&
      (threadId !== null || turnId !== null || turnState !== null))
  ) {
    throw new TypeError("HostDeck restart worker ready identity is inconsistent with its mode.");
  }
  if (
    record.schema_version !== 1 ||
    record.phase !== "ready" ||
    record.compatibility_state !== "ready"
  ) {
    throw new TypeError("HostDeck restart worker ready report constants are invalid.");
  }
  const supervisorRecord = requireRecord(record.supervisor, "supervisor report");
  assertExactKeys(supervisorRecord, supervisorKeys, "supervisor report");
  const supervisorMode = mode.startsWith("service_")
    ? "service_owned"
    : "foreground_child";
  if (
    supervisorRecord.mode !== supervisorMode ||
    supervisorRecord.phase !== "ready"
  ) {
    throw new TypeError("HostDeck restart worker supervisor mode is invalid.");
  }
  const generation =
    record.generation === null
      ? null
      : requireSafePositive(record.generation, "connection generation");
  if (
    (mode === "service_restart" && generation !== 1) ||
    (mode !== "service_restart" && generation !== null)
  ) {
    throw new TypeError("HostDeck restart worker generation is inconsistent.");
  }
  const turnStartRequestCount = requireNonNegativeInteger(
    record.turn_start_request_count,
    "turn start request count"
  );
  const acceptedModelTurnCount = requireNonNegativeInteger(
    record.accepted_model_turn_count,
    "accepted model turn count"
  );
  if (
    (mode === "service_initial" &&
      (turnStartRequestCount !== 1 || acceptedModelTurnCount !== 1)) ||
    (mode !== "service_initial" &&
      (turnStartRequestCount !== 0 || acceptedModelTurnCount !== 0))
  ) {
    throw new TypeError("HostDeck restart worker turn budget is inconsistent.");
  }
  return deepFreeze({
    schema_version: 1,
    phase: "ready",
    mode,
    hostdeck_pid: requireSafePositive(record.hostdeck_pid, "HostDeck pid"),
    runtime_pid: requireSafePositive(record.runtime_pid, "runtime pid"),
    lease_pid: requireSafePositive(record.lease_pid, "lease pid"),
    lease_replaced_stale_metadata: requireBoolean(
      record.lease_replaced_stale_metadata,
      "lease replacement"
    ),
    socket_identity: requireBoundedString(
      record.socket_identity,
      "socket identity",
      128
    ),
    thread_id: threadId,
    turn_id: turnId,
    turn_state: turnState as "in_progress" | null,
    compatibility_state: "ready",
    generation,
    boundary_count: requireNonNegativeInteger(
      record.boundary_count,
      "boundary count"
    ),
    resumed_count: requireNonNegativeInteger(
      record.resumed_count,
      "resumed count"
    ),
    ready_count: requireNonNegativeInteger(record.ready_count, "ready count"),
    turn_start_request_count: turnStartRequestCount,
    accepted_model_turn_count: acceptedModelTurnCount,
    supervisor: {
      mode: supervisorMode,
      phase: "ready",
      spawn_attempts: requireNonNegativeInteger(
        supervisorRecord.spawn_attempts,
        "spawn attempts"
      ),
      term_signals: requireNonNegativeInteger(
        supervisorRecord.term_signals,
        "TERM signals"
      ),
      kill_signals: requireNonNegativeInteger(
        supervisorRecord.kill_signals,
        "KILL signals"
      ),
      cleanup_failures: requireNonNegativeInteger(
        supervisorRecord.cleanup_failures,
        "supervisor cleanup failures"
      )
    }
  });
}

function parseResultReport(
  record: Readonly<Record<string, unknown>>
): HostDeckRestartWorkerResultReport {
  assertExactKeys(record, reportResultKeys, "result report");
  if (
    record.schema_version !== 1 ||
    record.phase !== "completed" ||
    record.supervisor_phase !== "closed"
  ) {
    throw new TypeError("HostDeck restart worker result constants are invalid.");
  }
  return deepFreeze({
    schema_version: 1,
    phase: "completed",
    mode: requireMode(record.mode),
    hostdeck_pid: requireSafePositive(record.hostdeck_pid, "HostDeck pid"),
    runtime_pid: requireSafePositive(record.runtime_pid, "runtime pid"),
    runtime_alive_after_close: requireBoolean(
      record.runtime_alive_after_close,
      "runtime liveness"
    ),
    socket_present_after_close: requireBoolean(
      record.socket_present_after_close,
      "socket presence"
    ),
    lease_released: requireBoolean(record.lease_released, "lease release"),
    database_closed: requireBoolean(record.database_closed, "database close"),
    controller_closed: requireBoolean(
      record.controller_closed,
      "controller close"
    ),
    supervisor_phase: "closed",
    cleanup_failures: requireNonNegativeInteger(
      record.cleanup_failures,
      "cleanup failures"
    )
  });
}

function requireMode(candidate: unknown): HostDeckRestartWorkerMode {
  if (
    typeof candidate !== "string" ||
    !hostDeckRestartWorkerModes.includes(
      candidate as HostDeckRestartWorkerMode
    )
  ) {
    throw new TypeError("HostDeck restart worker mode is invalid.");
  }
  return candidate as HostDeckRestartWorkerMode;
}

function requireAbsolutePath(candidate: unknown, label: string): string {
  if (
    typeof candidate !== "string" ||
    !isAbsolute(candidate) ||
    Buffer.byteLength(candidate, "utf8") > maxPathBytes ||
    /[\0\r\n]/u.test(candidate) ||
    resolve(candidate) !== candidate
  ) {
    throw new TypeError(`HostDeck restart worker ${label} is invalid.`);
  }
  return candidate;
}

function requireDescendantPath(
  candidate: unknown,
  parent: string,
  label: string
): string {
  const parsed = requireAbsolutePath(candidate, label);
  const relationship = relative(parent, parsed);
  if (
    relationship === "" ||
    relationship === ".." ||
    relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relationship)
  ) {
    throw new TypeError(
      `HostDeck restart worker ${label} must be a strict descendant.`
    );
  }
  return parsed;
}

function requirePositiveInteger(candidate: unknown, label: string): number {
  if (
    typeof candidate !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(candidate)
  ) {
    throw new TypeError(`HostDeck restart worker ${label} is invalid.`);
  }
  return requireSafePositive(Number(candidate), label);
}

function requireSafePositive(candidate: unknown, label: string): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1
  ) {
    throw new TypeError(`HostDeck restart worker ${label} is invalid.`);
  }
  return candidate;
}

function requireNonNegativeInteger(candidate: unknown, label: string): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 0
  ) {
    throw new TypeError(`HostDeck restart worker ${label} is invalid.`);
  }
  return candidate;
}

function requireBoolean(candidate: unknown, label: string): boolean {
  if (typeof candidate !== "boolean") {
    throw new TypeError(`HostDeck restart worker ${label} is invalid.`);
  }
  return candidate;
}

function requireNullableBoundedString(
  candidate: unknown,
  label: string
): string | null {
  return candidate === null
    ? null
    : requireBoundedString(candidate, label, 256);
}

function requireBoundedString(
  candidate: unknown,
  label: string,
  maxLength: number
): string {
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > maxLength ||
    /[\0\r\n]/u.test(candidate)
  ) {
    throw new TypeError(`HostDeck restart worker ${label} is invalid.`);
  }
  return candidate;
}

function requireRecord(
  candidate: unknown,
  label: string
): Readonly<Record<string, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new TypeError(`HostDeck restart ${label} must be a plain object.`);
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`HostDeck restart ${label} fields are invalid.`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String(error.code) === code
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
