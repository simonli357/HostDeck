import {
  accessSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  realpathSync
} from "node:fs";
import { isAbsolute, normalize } from "node:path";
import {
  assertResolvedResourceBudget,
  type ResourceBudget
} from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import {
  acquireHostDeckDaemonLease,
  type HostDeckDaemonLease,
  HostDeckDaemonLeaseError,
  type HostDeckPathModeRepair,
  openMigratedDatabase,
  openSecureHostDeckRegularFile,
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPathsAfterLease,
  type ResolvedHostDeckLocalPaths,
  resolveHostDeckLocalPaths
} from "@hostdeck/storage";
import {
  type CodexRuntimeSupervisorSnapshot,
  createCodexRuntimeSupervisor,
  type HostDeckCodexRuntimeSupervisor,
  HostDeckCodexRuntimeSupervisorError,
  type StartedCodexRuntime
} from "./codex-runtime-supervisor.js";

export const hostDeckForegroundResourceErrorCodes = [
  "invalid_config",
  "startup_aborted",
  "lease_held",
  "lease_failed",
  "path_failed",
  "database_failed",
  "runtime_failed",
  "cleanup_failed"
] as const;

export type HostDeckForegroundResourceErrorCode =
  (typeof hostDeckForegroundResourceErrorCodes)[number];

export const hostDeckForegroundResourceStages = [
  "configuration",
  "lease",
  "paths",
  "database",
  "runtime",
  "cleanup"
] as const;

export type HostDeckForegroundResourceStage =
  (typeof hostDeckForegroundResourceStages)[number];

export type HostDeckForegroundResourcePhase =
  | "ready"
  | "closing"
  | "closed"
  | "failed";

export interface StartHostDeckForegroundResourcesInput {
  readonly config_dir: string;
  readonly state_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
  readonly codex_bin: string;
  readonly loopback_port: number;
  readonly resource_budget: ResourceBudget;
  readonly signal?: AbortSignal;
}

export interface HostDeckForegroundResourceDependencies {
  readonly now?: () => Date;
  readonly pid?: number;
  readonly runtimeSupervisorFactory?: typeof createCodexRuntimeSupervisor;
}

export interface HostDeckForegroundBind {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly transport: "http";
}

export interface HostDeckForegroundResourceSnapshot {
  readonly phase: HostDeckForegroundResourcePhase;
  readonly database_open: boolean;
  readonly lease_held: boolean;
  readonly runtime: CodexRuntimeSupervisorSnapshot;
}

export interface HostDeckForegroundResources {
  readonly bind: HostDeckForegroundBind;
  readonly paths: ResolvedHostDeckLocalPaths;
  readonly resource_budget: ResourceBudget;
  readonly database: ReturnType<typeof openMigratedDatabase>["db"];
  readonly migration: ReturnType<typeof openMigratedDatabase>["result"];
  readonly runtime: StartedCodexRuntime;
  readonly path_repairs: readonly HostDeckPathModeRepair[];
  readonly snapshot: () => HostDeckForegroundResourceSnapshot;
  readonly close: () => Promise<void>;
}

export class HostDeckForegroundResourceError extends Error {
  constructor(
    readonly code: HostDeckForegroundResourceErrorCode,
    readonly stage: HostDeckForegroundResourceStage,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckForegroundResourceError";
  }
}

interface ParsedStartInput {
  readonly paths: ResolvedHostDeckLocalPaths;
  readonly codexBin: string;
  readonly loopbackPort: number;
  readonly resourceBudget: ResourceBudget;
  readonly signal: AbortSignal | undefined;
}

interface ParsedDependencies {
  readonly now: () => Date;
  readonly pid: number | undefined;
  readonly runtimeSupervisorFactory: typeof createCodexRuntimeSupervisor;
}

interface OpenedGuardedDatabase {
  readonly database: ReturnType<typeof openMigratedDatabase>;
  readonly repair: HostDeckPathModeRepair | null;
}

const startInputKeys = [
  "codex_bin",
  "config_dir",
  "database_path",
  "loopback_port",
  "resource_budget",
  "runtime_dir",
  "signal",
  "state_dir"
] as const;
const requiredStartInputKeys = startInputKeys.filter(
  (key) => key !== "signal"
);
const dependencyKeys = ["now", "pid", "runtimeSupervisorFactory"] as const;
const maxExecutablePathBytes = 4_096;
const defaultNow = () => new Date();

export async function startHostDeckForegroundResources(
  input: StartHostDeckForegroundResourcesInput,
  dependencies: HostDeckForegroundResourceDependencies = {}
): Promise<HostDeckForegroundResources> {
  let parsed: ParsedStartInput;
  let ports: ParsedDependencies;
  let supervisor: HostDeckCodexRuntimeSupervisor;
  try {
    parsed = parseStartInput(input);
    ports = parseDependencies(dependencies);
    inspectExecutable(parsed.codexBin);
    supervisor = ports.runtimeSupervisorFactory({
      mode: "foreground_child",
      codex_bin: parsed.codexBin,
      socket_path: parsed.paths.app_server_socket_path
    });
    assertRuntimeSupervisor(supervisor);
    assertNotAborted(parsed.signal, "configuration");
  } catch (cause) {
    if (isForegroundResourceError(cause)) throw cause;
    throw foregroundError(
      "invalid_config",
      "configuration",
      "HostDeck foreground resource configuration is invalid.",
      cause
    );
  }

  let stage: HostDeckForegroundResourceStage = "lease";
  let lease: HostDeckDaemonLease | null = null;
  let opened: OpenedGuardedDatabase | null = null;
  let runtimeStartAttempted = false;
  const repairs: HostDeckPathModeRepair[] = [];

  try {
    repairs.push(...prepareHostDeckDaemonLeasePath(parsed.paths));
    assertNotAborted(parsed.signal, stage);
    lease = acquireHostDeckDaemonLease({
      lease_path: parsed.paths.lease_path,
      now: ports.now,
      ...(ports.pid === undefined ? {} : { pid: ports.pid })
    });
    if (lease.mode_repair !== null) repairs.push(lease.mode_repair);
    assertNotAborted(parsed.signal, stage);

    stage = "paths";
    const prepared = prepareHostDeckLocalPathsAfterLease(parsed.paths);
    repairs.push(...prepared.repairs);
    assertNotAborted(parsed.signal, stage);

    stage = "database";
    opened = openGuardedMigratedDatabase(
      parsed.paths.database_path,
      ports.now
    );
    if (opened.repair !== null) repairs.push(opened.repair);
    assertNotAborted(parsed.signal, stage);

    stage = "runtime";
    runtimeStartAttempted = true;
    const runtime = parseStartedRuntime(
      await startRuntimeSupervisor(
        supervisor,
        parsed.resourceBudget,
        parsed.signal
      ),
      parsed.paths.app_server_socket_path
    );
    assertNotAborted(parsed.signal, stage);

    return createResourceHandle({
      lease,
      opened,
      parsed,
      repairs,
      runtime,
      supervisor
    });
  } catch (cause) {
    const primary = mapStartupFailure(cause, stage, parsed.signal);
    const cleanupErrors = await rollbackStartup({
      lease,
      opened,
      resourceBudget: parsed.resourceBudget,
      runtimeStartAttempted,
      supervisor
    });
    if (cleanupErrors.length === 0) throw primary;
    throw foregroundError(
      primary.code,
      primary.stage,
      primary.message,
      new AggregateError(
        [primary, ...cleanupErrors],
        "HostDeck foreground resource startup and cleanup failed."
      )
    );
  }
}

function createResourceHandle(input: {
  readonly lease: HostDeckDaemonLease;
  readonly opened: OpenedGuardedDatabase;
  readonly parsed: ParsedStartInput;
  readonly repairs: readonly HostDeckPathModeRepair[];
  readonly runtime: StartedCodexRuntime;
  readonly supervisor: HostDeckCodexRuntimeSupervisor;
}): HostDeckForegroundResources {
  let phase: HostDeckForegroundResourcePhase = "ready";
  let closePromise: Promise<void> | null = null;
  const bind = Object.freeze({
    host: "127.0.0.1" as const,
    port: input.parsed.loopbackPort,
    transport: "http" as const
  });
  const migration = Object.freeze({
    applied: Object.freeze([...input.opened.database.result.applied]),
    currentVersion: input.opened.database.result.currentVersion
  });
  const pathRepairs = Object.freeze(
    input.repairs.map((repair) => Object.freeze({ ...repair }))
  );

  const snapshot = (): HostDeckForegroundResourceSnapshot =>
    Object.freeze({
      phase,
      database_open: input.opened.database.db.open,
      lease_held: !input.lease.released,
      runtime: input.supervisor.snapshot()
    });

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    phase = "closing";
    closePromise = closeResourceHandle(input).then(
      () => {
        phase = "closed";
      },
      (cause: unknown) => {
        phase = "failed";
        throw cause;
      }
    );
    return closePromise;
  };

  return Object.freeze({
    bind,
    paths: input.parsed.paths,
    resource_budget: input.parsed.resourceBudget,
    database: input.opened.database.db,
    migration,
    runtime: input.runtime,
    path_repairs: pathRepairs,
    snapshot,
    close
  });
}

async function closeResourceHandle(input: {
  readonly lease: HostDeckDaemonLease;
  readonly opened: OpenedGuardedDatabase;
  readonly parsed: ParsedStartInput;
  readonly supervisor: HostDeckCodexRuntimeSupervisor;
}): Promise<void> {
  const errors: unknown[] = [];
  errors.push(
    ...(await closeRuntimeSupervisor(
      input.supervisor,
      input.parsed.resourceBudget
    ))
  );
  closeDatabase(input.opened.database, errors);
  releaseLease(input.lease, errors);
  if (errors.length === 0) return;
  throw foregroundError(
    "cleanup_failed",
    "cleanup",
    "HostDeck foreground resources did not close cleanly.",
    new AggregateError(errors, "HostDeck foreground resource cleanup failed.")
  );
}

async function rollbackStartup(input: {
  readonly lease: HostDeckDaemonLease | null;
  readonly opened: OpenedGuardedDatabase | null;
  readonly resourceBudget: ResourceBudget;
  readonly runtimeStartAttempted: boolean;
  readonly supervisor: HostDeckCodexRuntimeSupervisor;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.runtimeStartAttempted) {
    errors.push(
      ...(await closeRuntimeSupervisor(input.supervisor, input.resourceBudget))
    );
  }
  if (input.opened !== null) closeDatabase(input.opened.database, errors);
  if (input.lease !== null) releaseLease(input.lease, errors);
  return errors;
}

function openGuardedMigratedDatabase(
  databasePath: string,
  now: () => Date
): OpenedGuardedDatabase {
  let guard: ReturnType<typeof openSecureHostDeckRegularFile> | null = null;
  let database: ReturnType<typeof openMigratedDatabase> | null = null;
  let descriptorOpen = false;
  try {
    guard = openSecureHostDeckRegularFile(databasePath, {
      label: "database",
      mode: 0o600,
      create: true,
      repair_mode: true
    });
    descriptorOpen = true;
    database = openMigratedDatabase(databasePath, { now });
    guard.verifyPath();
    closeSync(guard.descriptor);
    descriptorOpen = false;
    if (
      !database.db.open ||
      database.db.readonly ||
      database.db.pragma("foreign_keys", { simple: true }) !== 1
    ) {
      throw new TypeError(
        "Migrated SQLite database did not retain its required writable state."
      );
    }
    return Object.freeze({ database, repair: guard.repair });
  } catch (cause) {
    const cleanupErrors: unknown[] = [];
    if (database !== null) closeDatabase(database, cleanupErrors);
    if (descriptorOpen && guard !== null) {
      try {
        closeSync(guard.descriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 0) throw cause;
    throw new AggregateError(
      [cause, ...cleanupErrors],
      "Guarded SQLite open and cleanup failed."
    );
  }
}

async function startRuntimeSupervisor(
  supervisor: HostDeckCodexRuntimeSupervisor,
  resourceBudget: ResourceBudget,
  signal: AbortSignal | undefined
): Promise<StartedCodexRuntime> {
  const deadline = createOperationDeadline({
    timeoutMs: resourceBudget.lifecycle_startup_timeout_ms,
    ...(signal === undefined ? {} : { parentSignal: signal })
  });
  try {
    return await supervisor.start({ deadline, resourceBudget });
  } finally {
    deadline.dispose();
  }
}

async function closeRuntimeSupervisor(
  supervisor: HostDeckCodexRuntimeSupervisor,
  resourceBudget: ResourceBudget
): Promise<unknown[]> {
  const errors: unknown[] = [];
  let deadline: ReturnType<typeof createOperationDeadline> | null = null;
  try {
    deadline = createOperationDeadline({
      timeoutMs: resourceBudget.lifecycle_cleanup_step_timeout_ms
    });
    await supervisor.close({ deadline });
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      deadline?.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function closeDatabase(
  database: ReturnType<typeof openMigratedDatabase>,
  errors: unknown[]
): void {
  try {
    if (database.db.open) database.db.close();
  } catch (error) {
    errors.push(error);
  }
}

function releaseLease(lease: HostDeckDaemonLease, errors: unknown[]): void {
  try {
    lease.release();
  } catch (error) {
    errors.push(error);
  }
}

function parseStartInput(candidate: unknown): ParsedStartInput {
  const values = readExactDataObject(
    candidate,
    startInputKeys,
    requiredStartInputKeys,
    "HostDeck foreground resource input is invalid."
  );
  const resourceBudget = values.resource_budget;
  assertResolvedResourceBudget(resourceBudget);
  const loopbackPort = values.loopback_port;
  if (
    typeof loopbackPort !== "number" ||
    !Number.isSafeInteger(loopbackPort) ||
    loopbackPort < 1_024 ||
    loopbackPort > 65_535
  ) {
    throw new TypeError("HostDeck loopback port is invalid.");
  }
  const signal = values.signal;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError("HostDeck foreground startup signal is invalid.");
  }
  const paths = resolveHostDeckLocalPaths({
    config_dir: requireString(values.config_dir),
    state_dir: requireString(values.state_dir),
    runtime_dir: requireString(values.runtime_dir),
    database_path: requireString(values.database_path)
  });
  return Object.freeze({
    paths,
    codexBin: parseExecutablePath(values.codex_bin),
    loopbackPort,
    resourceBudget,
    signal
  });
}

function parseDependencies(candidate: unknown): ParsedDependencies {
  const values = readExactDataObject(
    candidate,
    dependencyKeys,
    [],
    "HostDeck foreground resource dependencies are invalid."
  );
  const now = values.now;
  const pid = values.pid;
  const runtimeSupervisorFactory = values.runtimeSupervisorFactory;
  if (
    (now !== undefined && typeof now !== "function") ||
    (pid !== undefined &&
      (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)) ||
    (runtimeSupervisorFactory !== undefined &&
      typeof runtimeSupervisorFactory !== "function")
  ) {
    throw new TypeError(
      "HostDeck foreground resource dependencies are invalid."
    );
  }
  return Object.freeze({
    now: now === undefined ? defaultNow : (now as () => Date),
    pid,
    runtimeSupervisorFactory:
      runtimeSupervisorFactory === undefined
        ? createCodexRuntimeSupervisor
        : (runtimeSupervisorFactory as typeof createCodexRuntimeSupervisor)
  });
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  allowedKeys: readonly Key[],
  requiredKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" || !allowedKeys.includes(key as Key)
      ) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values) as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}

function inspectExecutable(path: string): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      realpathSync.native(path) !== path
    ) {
      throw new TypeError();
    }
    accessSync(path, fsConstants.X_OK);
  } catch (cause) {
    throw new TypeError(
      "Configured Codex executable is unavailable or not executable.",
      { cause }
    );
  }
}

function parseExecutablePath(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    !isAbsolute(candidate) ||
    candidate === "/" ||
    normalize(candidate) !== candidate ||
    Buffer.byteLength(candidate, "utf8") > maxExecutablePathBytes ||
    containsControl(candidate)
  ) {
    throw new TypeError(
      "Configured Codex executable must be a canonical absolute path."
    );
  }
  return candidate;
}

function assertRuntimeSupervisor(
  candidate: unknown
): asserts candidate is HostDeckCodexRuntimeSupervisor {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !hasCallableDataProperty(candidate, "start") ||
      !hasCallableDataProperty(candidate, "close") ||
      !hasCallableDataProperty(candidate, "snapshot")
    ) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError(
      "Codex runtime supervisor factory returned an invalid owner."
    );
  }
}

function parseStartedRuntime(
  candidate: unknown,
  expectedSocketPath: string
): StartedCodexRuntime {
  const values = readExactDataObject(
    candidate,
    [
      "mode",
      "ownership",
      "process_exit",
      "socket_mode_repaired",
      "socket_path",
      "stale_socket_removed"
    ],
    [
      "mode",
      "ownership",
      "process_exit",
      "socket_mode_repaired",
      "socket_path",
      "stale_socket_removed"
    ],
    "Codex runtime supervisor returned invalid startup state."
  );
  if (
    values.mode !== "foreground_child" ||
    values.ownership !== "foreground_child" ||
    values.socket_path !== expectedSocketPath ||
    typeof values.socket_mode_repaired !== "boolean" ||
    typeof values.stale_socket_removed !== "boolean" ||
    !(values.process_exit instanceof Promise)
  ) {
    throw new TypeError(
      "Codex runtime supervisor returned invalid startup state."
    );
  }
  return Object.freeze({
    mode: "foreground_child",
    ownership: "foreground_child",
    socket_path: expectedSocketPath,
    socket_mode_repaired: values.socket_mode_repaired,
    stale_socket_removed: values.stale_socket_removed,
    process_exit: values.process_exit as StartedCodexRuntime["process_exit"]
  });
}

function hasCallableDataProperty(candidate: object, key: string): boolean {
  let owner: object | null = candidate;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) {
      return "value" in descriptor && typeof descriptor.value === "function";
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return false;
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  stage: HostDeckForegroundResourceStage
): void {
  if (signal?.aborted !== true) return;
  throw foregroundError(
    "startup_aborted",
    stage,
    "HostDeck foreground resource startup was aborted.",
    signal.reason
  );
}

function mapStartupFailure(
  cause: unknown,
  stage: HostDeckForegroundResourceStage,
  signal: AbortSignal | undefined
): HostDeckForegroundResourceError {
  if (isForegroundResourceError(cause)) return cause;
  if (signal?.aborted === true) {
    return foregroundError(
      "startup_aborted",
      stage,
      "HostDeck foreground resource startup was aborted.",
      cause
    );
  }
  if (stage === "lease" && isErrorInstance(cause, HostDeckDaemonLeaseError)) {
    return foregroundError(
      cause.code === "lease_held" ? "lease_held" : "lease_failed",
      "lease",
      cause.code === "lease_held"
        ? "Another HostDeck foreground owner already holds this state directory."
        : "HostDeck foreground lease setup failed.",
      cause
    );
  }
  if (
    stage === "runtime" &&
    isErrorInstance(cause, HostDeckCodexRuntimeSupervisorError)
  ) {
    return foregroundError(
      cause.code === "startup_aborted"
        ? "startup_aborted"
        : "runtime_failed",
      "runtime",
      cause.code === "startup_aborted"
        ? "HostDeck foreground resource startup was aborted."
        : "Codex foreground runtime startup failed.",
      cause
    );
  }
  const codeByStage: Partial<
    Record<HostDeckForegroundResourceStage, HostDeckForegroundResourceErrorCode>
  > = {
    lease: "lease_failed",
    paths: "path_failed",
    database: "database_failed",
    runtime: "runtime_failed"
  };
  return foregroundError(
    codeByStage[stage] ?? "invalid_config",
    stage,
    stage === "paths"
      ? "HostDeck foreground path preparation failed."
      : stage === "database"
        ? "HostDeck foreground database startup failed."
        : stage === "runtime"
          ? "Codex foreground runtime startup failed."
          : "HostDeck foreground lease setup failed.",
    cause
  );
}

function foregroundError(
  code: HostDeckForegroundResourceErrorCode,
  stage: HostDeckForegroundResourceStage,
  message: string,
  cause?: unknown
): HostDeckForegroundResourceError {
  return new HostDeckForegroundResourceError(
    code,
    stage,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function isForegroundResourceError(
  candidate: unknown
): candidate is HostDeckForegroundResourceError {
  return isErrorInstance(candidate, HostDeckForegroundResourceError);
}

function isErrorInstance<ErrorType extends Error>(
  candidate: unknown,
  errorType: abstract new (...args: never[]) => ErrorType
): candidate is ErrorType {
  try {
    return candidate instanceof errorType;
  } catch {
    return false;
  }
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  try {
    return candidate instanceof AbortSignal;
  } catch {
    return false;
  }
}

function requireString(candidate: unknown): string {
  if (typeof candidate !== "string") throw new TypeError();
  return candidate;
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
