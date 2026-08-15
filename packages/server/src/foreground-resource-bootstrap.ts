import {
  accessSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  realpathSync
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { codexBindingDescriptor } from "@hostdeck/codex-adapter";
import {
  assertResolvedResourceBudget,
  codexVersionSchema,
  type ResourceBudget,
  type SharedCodexEndpoint,
  type SharedCodexEndpointLocation,
  sharedCodexEndpointLocationSchema,
  sharedCodexEndpointSchema
} from "@hostdeck/contracts";
import {
  createOperationDeadline,
  type OperationDeadline
} from "@hostdeck/core";
import {
  acquireHostDeckDaemonLease,
  type HostDeckDaemonLease,
  HostDeckDaemonLeaseError,
  type HostDeckPathSecurityRepair,
  openMigratedDatabase,
  openSecureHostDeckRegularFile,
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPathsAfterLease,
  prepareHostDeckServiceLocalPathsAfterLease,
  type ResolvedHostDeckLocalPaths,
  resolveHostDeckLocalPaths
} from "@hostdeck/storage";
import {
  type CodexVersionProbe,
  codexVersionProbeLimits,
  probeCodexVersion
} from "./codex-version-probe.js";
import {
  HostDeckSharedCodexBrokerError,
  resolveSharedCodexEndpointLocation,
  type SharedCodexBrokerAttachment,
  startSharedCodexBroker
} from "./shared-codex-broker-lifecycle.js";

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

export const hostDeckRuntimePreparationStates = Object.freeze([
  "ready",
  "version_incompatible"
] as const);

export type HostDeckRuntimePreparationState =
  (typeof hostDeckRuntimePreparationStates)[number];

export interface HostDeckPreparedCodexRuntime {
  readonly preparation: HostDeckRuntimePreparationState;
  readonly endpoint: SharedCodexEndpoint;
  readonly location: SharedCodexEndpointLocation;
  readonly socket_path: string;
}

export interface StartHostDeckForegroundResourcesInput {
  readonly config_dir: string;
  readonly state_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
  readonly codex_bin: string;
  readonly codex_home?: string;
  readonly loopback_port: number;
  readonly resource_budget: ResourceBudget;
  readonly signal?: AbortSignal;
}

export interface HostDeckForegroundResourceDependencies {
  readonly codexVersionProbe?: CodexVersionProbe;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly startSharedBroker?: typeof startSharedCodexBroker;
}

export interface HostDeckForegroundBind {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly transport: "http";
}

export interface HostDeckForegroundResourceSnapshot {
  readonly phase: HostDeckForegroundResourcePhase;
  readonly codex_version: string;
  readonly database_open: boolean;
  readonly lease_held: boolean;
  readonly runtime_preparation: HostDeckRuntimePreparationState;
  readonly runtime: SharedCodexEndpoint;
}

export interface HostDeckForegroundResourceShutdownPorts {
  readonly supervisor: Readonly<{
    readonly close: (deadline: OperationDeadline) => Promise<void>;
  }>;
  readonly storage: Readonly<{
    readonly close: (deadline: OperationDeadline) => Promise<void>;
  }>;
  readonly lease: Readonly<{
    readonly release: (deadline: OperationDeadline) => Promise<void>;
  }>;
}

export interface HostDeckForegroundResources {
  readonly bind: HostDeckForegroundBind;
  readonly paths: ResolvedHostDeckLocalPaths;
  readonly codex_bin: string;
  readonly codex_version: string;
  readonly resource_budget: ResourceBudget;
  readonly database: ReturnType<typeof openMigratedDatabase>["db"];
  readonly migration: ReturnType<typeof openMigratedDatabase>["result"];
  readonly runtime: HostDeckPreparedCodexRuntime;
  readonly path_repairs: readonly HostDeckPathSecurityRepair[];
  readonly shutdown: HostDeckForegroundResourceShutdownPorts;
  readonly snapshot: () => HostDeckForegroundResourceSnapshot;
  readonly close: () => Promise<void>;
}

export type StartHostDeckServiceResourcesInput =
  StartHostDeckForegroundResourcesInput;
export type HostDeckServiceResourceDependencies =
  HostDeckForegroundResourceDependencies;
export type HostDeckProductionResources = HostDeckForegroundResources;
export type HostDeckServiceResources = HostDeckProductionResources;

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
  readonly codexLocation: SharedCodexEndpointLocation;
  readonly loopbackPort: number;
  readonly resourceBudget: ResourceBudget;
  readonly signal: AbortSignal | undefined;
}

interface ParsedDependencies {
  readonly codexVersionProbe: CodexVersionProbe;
  readonly now: () => Date;
  readonly pid: number | undefined;
  readonly startSharedBroker: typeof startSharedCodexBroker;
}

interface OpenedGuardedDatabase {
  readonly database: ReturnType<typeof openMigratedDatabase>;
  readonly repair: HostDeckPathSecurityRepair | null;
}

const startInputKeys = [
  "codex_bin",
  "codex_home",
  "config_dir",
  "database_path",
  "loopback_port",
  "resource_budget",
  "runtime_dir",
  "signal",
  "state_dir"
] as const;
const requiredStartInputKeys = startInputKeys.filter(
  (key) => key !== "signal" && key !== "codex_home"
);
const dependencyKeys = [
  "codexVersionProbe",
  "now",
  "pid",
  "startSharedBroker"
] as const;
const maxExecutablePathBytes = 4_096;
const defaultNow = () => new Date();
const acceptedProductionResources = new WeakSet<object>();
const acceptedForegroundResources = new WeakSet<object>();
const acceptedServiceResources = new WeakSet<object>();

type HostDeckRuntimeOwnership = "foreground_child" | "service_owned";

export async function startHostDeckForegroundResources(
  input: StartHostDeckForegroundResourcesInput,
  dependencies: HostDeckForegroundResourceDependencies = {}
): Promise<HostDeckForegroundResources> {
  return startHostDeckProductionResources(
    input,
    dependencies,
    "foreground_child"
  );
}

export async function startHostDeckServiceResources(
  input: StartHostDeckServiceResourcesInput,
  dependencies: HostDeckServiceResourceDependencies = {}
): Promise<HostDeckServiceResources> {
  return startHostDeckProductionResources(input, dependencies, "service_owned");
}

async function startHostDeckProductionResources(
  input: StartHostDeckForegroundResourcesInput,
  dependencies: HostDeckForegroundResourceDependencies,
  ownership: HostDeckRuntimeOwnership
): Promise<HostDeckProductionResources> {
  let parsed: ParsedStartInput;
  let ports: ParsedDependencies;
  try {
    parsed = parseStartInput(input);
    ports = parseDependencies(dependencies);
    inspectExecutable(parsed.codexBin);
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
  let brokerAttachment: SharedCodexBrokerAttachment | null = null;
  const repairs: HostDeckPathSecurityRepair[] = [];

  try {
    repairs.push(...prepareHostDeckDaemonLeasePath(parsed.paths));
    assertNotAborted(parsed.signal, stage);
    lease = acquireHostDeckDaemonLease({
      lease_path: parsed.paths.lease_path,
      now: ports.now,
      ...(ports.pid === undefined ? {} : { pid: ports.pid })
    });
    if (lease.security_repair !== null) repairs.push(lease.security_repair);
    assertNotAborted(parsed.signal, stage);

    stage = "paths";
    const prepared =
      ownership === "foreground_child"
        ? prepareHostDeckLocalPathsAfterLease(parsed.paths)
        : prepareHostDeckServiceLocalPathsAfterLease(parsed.paths);
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
    const codexVersion = parseObservedCodexVersion(
      await ports.codexVersionProbe(
        Object.freeze({
          executable: parsed.codexBin,
          signal: parsed.signal ?? new AbortController().signal,
          timeout_ms: Math.min(
            codexVersionProbeLimits.maximum_timeout_ms,
            parsed.resourceBudget.lifecycle_startup_timeout_ms
          )
        })
      )
    );
    let runtime: HostDeckPreparedCodexRuntime;
    if (codexVersion === codexBindingDescriptor.codex_version) {
      brokerAttachment = await ports.startSharedBroker({
        codex_bin: parsed.codexBin,
        location: parsed.codexLocation,
        mode:
          ownership === "foreground_child"
            ? "attach_or_start"
            : "attach_only",
        observed_version: codexVersion,
        ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
        startup_timeout_ms:
          parsed.resourceBudget.lifecycle_startup_timeout_ms
      });
      runtime = parsePreparedRuntime(brokerAttachment, parsed.codexLocation);
    } else {
      runtime = createVersionIncompatibleRuntime(
        parsed.codexLocation,
        codexVersion
      );
    }
    assertNotAborted(parsed.signal, stage);

    return createResourceHandle({
      codexVersion,
      lease,
      opened,
      parsed,
      repairs,
      runtime,
      brokerAttachment,
      ownership
    });
  } catch (cause) {
    const primary = mapStartupFailure(cause, stage, parsed.signal);
    const cleanupErrors = await rollbackStartup({
      lease,
      opened,
      brokerAttachment
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

export function assertHostDeckForegroundResources(
  candidate: unknown
): asserts candidate is HostDeckForegroundResources {
  assertHostDeckProductionResources(candidate);
  if (!acceptedForegroundResources.has(candidate)) {
    throw new TypeError(
      "HostDeck foreground resources must be created by the foreground bootstrap."
    );
  }
}

export function assertHostDeckServiceResources(
  candidate: unknown
): asserts candidate is HostDeckServiceResources {
  assertHostDeckProductionResources(candidate);
  if (!acceptedServiceResources.has(candidate)) {
    throw new TypeError(
      "HostDeck service resources must be created by the service bootstrap."
    );
  }
}

export function assertHostDeckProductionResources(
  candidate: unknown
): asserts candidate is HostDeckProductionResources {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedProductionResources.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck production resources must be created by their bootstrap factory."
    );
  }
}

function createResourceHandle(input: {
  readonly brokerAttachment: SharedCodexBrokerAttachment | null;
  readonly codexVersion: string;
  readonly lease: HostDeckDaemonLease;
  readonly opened: OpenedGuardedDatabase;
  readonly parsed: ParsedStartInput;
  readonly repairs: readonly HostDeckPathSecurityRepair[];
  readonly runtime: HostDeckPreparedCodexRuntime;
  readonly ownership: HostDeckRuntimeOwnership;
}): HostDeckForegroundResources {
  let phase: HostDeckForegroundResourcePhase = "ready";
  let closePromise: Promise<void> | null = null;
  let supervisorPromise: Promise<void> | null = null;
  let storagePromise: Promise<void> | null = null;
  let leasePromise: Promise<void> | null = null;
  let supervisorSettled = false;
  let storageSettled = false;
  let supervisorFailed = false;
  let storageFailed = false;
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
      codex_version: input.codexVersion,
      database_open: input.opened.database.db.open,
      lease_held: !input.lease.released,
      runtime_preparation: input.runtime.preparation,
      runtime: input.runtime.endpoint
    });

  const closeSupervisor = (deadline: OperationDeadline): Promise<void> => {
    if (supervisorPromise !== null) return supervisorPromise;
    assertOperationDeadline(deadline);
    phase = "closing";
    supervisorPromise = Promise.resolve()
      .then(() => input.brokerAttachment?.close())
      .catch((cause: unknown) => {
        supervisorFailed = true;
        throw cause;
      })
      .finally(() => {
        supervisorSettled = true;
      });
    return supervisorPromise;
  };

  const closeStorage = (deadline: OperationDeadline): Promise<void> => {
    if (storagePromise !== null) return storagePromise;
    assertOperationDeadline(deadline);
    if (!supervisorSettled) {
      return Promise.reject(
        new TypeError(
          "HostDeck foreground storage cannot close before the runtime supervisor settles."
        )
      );
    }
    phase = "closing";
    storagePromise = Promise.resolve()
      .then(() => {
        if (input.opened.database.db.open) input.opened.database.db.close();
      })
      .catch((cause: unknown) => {
        storageFailed = true;
        throw cause;
      })
      .finally(() => {
        storageSettled = true;
      });
    return storagePromise;
  };

  const releaseOwnedLease = (deadline: OperationDeadline): Promise<void> => {
    if (leasePromise !== null) return leasePromise;
    assertOperationDeadline(deadline);
    if (!storageSettled) {
      return Promise.reject(
        new TypeError(
          "HostDeck foreground lease cannot release before storage settles."
        )
      );
    }
    phase = "closing";
    leasePromise = Promise.resolve().then(() => input.lease.release()).then(
      () => {
        phase = supervisorFailed || storageFailed ? "failed" : "closed";
      },
      (cause: unknown) => {
        phase = "failed";
        throw cause;
      }
    );
    return leasePromise;
  };

  const shutdown: HostDeckForegroundResourceShutdownPorts = Object.freeze({
    supervisor: Object.freeze({ close: closeSupervisor }),
    storage: Object.freeze({ close: closeStorage }),
    lease: Object.freeze({ release: releaseOwnedLease })
  });

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    phase = "closing";
    closePromise = closeResourceHandle({
      closeSupervisor,
      closeStorage,
      releaseLease: releaseOwnedLease,
      resourceBudget: input.parsed.resourceBudget
    }).then(
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

  const resources: HostDeckForegroundResources = Object.freeze({
    bind,
    paths: input.parsed.paths,
    codex_bin: input.parsed.codexBin,
    codex_version: input.codexVersion,
    resource_budget: input.parsed.resourceBudget,
    database: input.opened.database.db,
    migration,
    runtime: input.runtime,
    path_repairs: pathRepairs,
    shutdown,
    snapshot,
    close
  });
  acceptedProductionResources.add(resources);
  if (input.ownership === "foreground_child") {
    acceptedForegroundResources.add(resources);
  } else {
    acceptedServiceResources.add(resources);
  }
  return resources;
}

async function closeResourceHandle(input: {
  readonly closeSupervisor: (deadline: OperationDeadline) => Promise<void>;
  readonly closeStorage: (deadline: OperationDeadline) => Promise<void>;
  readonly releaseLease: (deadline: OperationDeadline) => Promise<void>;
  readonly resourceBudget: ResourceBudget;
}): Promise<void> {
  const errors: unknown[] = [];
  await runOwnedCleanupStage(
    input.closeSupervisor,
    input.resourceBudget,
    errors
  );
  await runOwnedCleanupStage(input.closeStorage, input.resourceBudget, errors);
  await runOwnedCleanupStage(input.releaseLease, input.resourceBudget, errors);
  if (errors.length === 0) return;
  throw foregroundError(
    "cleanup_failed",
    "cleanup",
    "HostDeck foreground resources did not close cleanly.",
    new AggregateError(errors, "HostDeck foreground resource cleanup failed.")
  );
}

async function runOwnedCleanupStage(
  stage: (deadline: OperationDeadline) => Promise<void>,
  resourceBudget: ResourceBudget,
  errors: unknown[]
): Promise<void> {
  let deadline: OperationDeadline | null = null;
  try {
    deadline = createOperationDeadline({
      timeoutMs: resourceBudget.lifecycle_cleanup_step_timeout_ms
    });
    await stage(deadline);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      deadline?.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
}

async function rollbackStartup(input: {
  readonly brokerAttachment: SharedCodexBrokerAttachment | null;
  readonly lease: HostDeckDaemonLease | null;
  readonly opened: OpenedGuardedDatabase | null;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.brokerAttachment !== null) {
    try {
      await input.brokerAttachment.close();
    } catch (error) {
      errors.push(error);
    }
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
  const codexLocation = resolveSharedCodexEndpointLocation({
    home_directory: homedir(),
    ...(values.codex_home === undefined
      ? {}
      : { codex_home: requireString(values.codex_home) })
  });
  return Object.freeze({
    paths,
    codexBin: parseExecutablePath(values.codex_bin),
    codexLocation,
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
  const codexVersionProbe = values.codexVersionProbe;
  const sharedBrokerStarter = values.startSharedBroker;
  if (
    (codexVersionProbe !== undefined &&
      typeof codexVersionProbe !== "function") ||
    (now !== undefined && typeof now !== "function") ||
    (pid !== undefined &&
      (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)) ||
    (sharedBrokerStarter !== undefined &&
      typeof sharedBrokerStarter !== "function")
  ) {
    throw new TypeError(
      "HostDeck foreground resource dependencies are invalid."
    );
  }
  return Object.freeze({
    codexVersionProbe:
      codexVersionProbe === undefined
        ? probeCodexVersion
        : (codexVersionProbe as CodexVersionProbe),
    now: now === undefined ? defaultNow : (now as () => Date),
    pid,
    startSharedBroker:
      sharedBrokerStarter === undefined
        ? startSharedCodexBroker
        : (sharedBrokerStarter as typeof startSharedCodexBroker)
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

function parsePreparedRuntime(
  candidate: unknown,
  expectedLocation: SharedCodexEndpointLocation
): HostDeckPreparedCodexRuntime {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !hasCallableDataProperty(candidate, "close")
  ) {
    throw new TypeError("Shared Codex broker returned invalid attachment state.");
  }
  const attachment = candidate as Partial<SharedCodexBrokerAttachment>;
  const location = sharedCodexEndpointLocationSchema.safeParse(
    attachment.location
  );
  const endpoint = sharedCodexEndpointSchema.safeParse(attachment.endpoint);
  if (
    !location.success ||
    !endpoint.success ||
    location.data.codex_home !== expectedLocation.codex_home ||
    location.data.socket_path !== expectedLocation.socket_path ||
    endpoint.data.state !== "ready" ||
    endpoint.data.observed_version !== codexBindingDescriptor.codex_version
  ) {
    throw new TypeError("Shared Codex broker returned invalid attachment state.");
  }
  return Object.freeze({
    preparation: "ready" as const,
    endpoint: endpoint.data,
    location: location.data,
    socket_path: location.data.socket_path
  });
}

function createVersionIncompatibleRuntime(
  location: SharedCodexEndpointLocation,
  observedVersion: string
): HostDeckPreparedCodexRuntime {
  return Object.freeze({
    preparation: "version_incompatible" as const,
    endpoint: sharedCodexEndpointSchema.parse({
      kind: "standard_unix",
      state: "failed",
      ownership: "none",
      generation: 0,
      observed_version: observedVersion,
      reason: "Installed Codex version is incompatible."
    }),
    location,
    socket_path: location.socket_path
  });
}

function parseObservedCodexVersion(candidate: unknown): string {
  const parsed = codexVersionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError(
      "Codex version probe returned invalid observed-version state."
    );
  }
  return parsed.data;
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
    isErrorInstance(cause, HostDeckSharedCodexBrokerError)
  ) {
    return foregroundError(
      cause.code === "aborted"
        ? "startup_aborted"
        : "runtime_failed",
      "runtime",
      cause.code === "aborted"
        ? "HostDeck foreground resource startup was aborted."
        : "Shared Codex broker startup failed.",
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
          ? "Shared Codex broker startup failed."
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

function assertOperationDeadline(
  candidate: unknown
): asserts candidate is OperationDeadline {
  try {
    const values = readExactDataObject(
      candidate,
      [
        "dispose",
        "expiresAtMs",
        "remainingMs",
        "signal",
        "startedAtMs",
        "throwIfAborted",
        "timeoutMs"
      ],
      [
        "dispose",
        "expiresAtMs",
        "remainingMs",
        "signal",
        "startedAtMs",
        "throwIfAborted",
        "timeoutMs"
      ],
      "HostDeck foreground shutdown deadline is invalid."
    );
    if (
      !Object.isFrozen(candidate) ||
      typeof values.startedAtMs !== "number" ||
      !Number.isFinite(values.startedAtMs) ||
      values.startedAtMs < 0 ||
      typeof values.expiresAtMs !== "number" ||
      !Number.isFinite(values.expiresAtMs) ||
      values.expiresAtMs < values.startedAtMs ||
      !isAbortSignal(values.signal) ||
      typeof values.remainingMs !== "function" ||
      typeof values.timeoutMs !== "function" ||
      typeof values.throwIfAborted !== "function" ||
      typeof values.dispose !== "function"
    ) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError("HostDeck foreground shutdown deadline is invalid.");
  }
}
