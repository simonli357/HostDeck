import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  createCodexAppServerConnection,
  createCodexUnixWebSocketTransport
} from "@hostdeck/codex-adapter";
import {
  resourceBudgetDefinitionByKey,
  type SharedCodexEndpointLocation,
  sharedCodexRuntimeVersion
} from "@hostdeck/contracts";
import {
  type HostDeckFileLock,
  type HostDeckFileLockPort,
  nativeHostDeckFileLockPort,
  openSecureHostDeckRegularFile,
  secureHostDeckSocket
} from "@hostdeck/storage";
import type {
  SharedCodexBrokerCompatibilityProbe,
  SharedCodexBrokerErrorCode,
  SharedCodexBrokerErrorStage,
  SharedCodexBrokerHostObservation,
  SharedCodexBrokerHostPort,
  SharedCodexBrokerHostSession
} from "./shared-codex-broker-lifecycle.js";

export class NodeSharedCodexBrokerError extends Error {
  constructor(
    readonly code: SharedCodexBrokerErrorCode,
    readonly stage: SharedCodexBrokerErrorStage,
    message: string,
    readonly diagnostic: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "NodeSharedCodexBrokerError";
  }
}

interface SharedCodexBrokerOwnerRecord {
  readonly schema: 1;
  readonly pid: number;
  readonly process_group_id: number;
  readonly start_ticks: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly socket_identity: string | null;
  readonly started_at: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly process_group_id: number;
  readonly session_id: number;
  readonly start_ticks: string;
  readonly executable: string;
  readonly argv: readonly string[];
}

interface SocketObservation {
  readonly identity: string;
}

interface HeldCoordinationLock {
  readonly close: () => void;
  readonly verify: () => void;
}

type RawSocketProbe = "active" | "missing" | "refused";

const controlDirectoryName = "app-server-control";
const ownerRecordName = "hostdeck-broker-owner.json";
const coordinationLockName = "hostdeck-broker.lock";
const ownerRecordMaximumBytes = 32 * 1_024;
const processArgumentMaximumBytes = 16 * 1_024;
const processArgumentMaximumCount = 64;
const pollIntervalMs = 25;
const rawProbeTimeoutMs = 250;

export const nodeSharedCodexBrokerHostPort: SharedCodexBrokerHostPort =
  createNodeSharedCodexBrokerHostPort();

export const nodeSharedCodexBrokerCompatibilityProbe: SharedCodexBrokerCompatibilityProbe =
  async (input) => {
    const timeoutMs = Math.max(50, input.timeout_ms);
    const connectTimeoutMs = Math.min(
      timeoutMs,
      resourceBudgetDefinitionByKey.protocol_connect_timeout_ms.maximum
    );
    const handshakeTimeoutMs = Math.min(
      timeoutMs,
      resourceBudgetDefinitionByKey.protocol_handshake_timeout_ms.maximum
    );
    const transport = createCodexUnixWebSocketTransport({
      socket_path: input.location.socket_path,
      handshake_timeout_ms: connectTimeoutMs,
      close_timeout_ms: Math.min(
        timeoutMs,
        resourceBudgetDefinitionByKey.protocol_close_timeout_ms.maximum
      )
    });
    const connection = createCodexAppServerConnection({
      transport,
      observed_version: input.observed_version,
      expected_codex_home: input.location.codex_home,
      host_target: "linux-x64",
      client_version: sharedCodexRuntimeVersion,
      handshake_timeout_ms: handshakeTimeoutMs
    });
    let primary: unknown = null;
    try {
      const compatibility = await connection.connect(input.signal);
      if (
        compatibility.state !== "ready" ||
        compatibility.mutation_policy !== "allowed" ||
        compatibility.observed_version !== sharedCodexRuntimeVersion
      ) {
        throw nodeError(
          "broker_incompatible",
          "compatibility",
          "The shared Codex broker rejected the reviewed protocol.",
          "Shared broker compatibility failed."
        );
      }
    } catch (error) {
      primary = error;
    }
    let closeFailure: unknown = null;
    try {
      await connection.close(
        "HostDeck completed broker compatibility admission."
      );
    } catch (error) {
      closeFailure = error;
    }
    if (primary !== null && closeFailure !== null) {
      throw new AggregateError(
        [primary, closeFailure],
        "Shared Codex compatibility admission and connection cleanup failed."
      );
    }
    if (primary !== null) throw primary;
    if (closeFailure !== null) throw closeFailure;
  };

export function createNodeSharedCodexBrokerHostPort(
  lockPort: HostDeckFileLockPort = nativeHostDeckFileLockPort
): SharedCodexBrokerHostPort {
  return Object.freeze({
    async open(
      input: Parameters<SharedCodexBrokerHostPort["open"]>[0]
    ): Promise<SharedCodexBrokerHostSession> {
      assertSupportedHost();
      assertCodexHome(input.location);
      const controlDirectory = controlDirectoryPath(input.location);
      const controlState = inspectControlDirectory(controlDirectory);
      if (controlState === "missing") {
        if (!input.create_control_directory) {
          return createMissingControlDirectorySession(input.access);
        }
        createControlDirectory(controlDirectory);
      }
      assertControlDirectory(controlDirectory);

      if (input.access === "observe_only") {
        return createNodeHostSession(input.location, null);
      }
      const lock = await acquireCoordinationLock(
        join(controlDirectory, coordinationLockName),
        lockPort,
        input.timeout_ms,
        input.signal
      );
      try {
        assertControlDirectory(controlDirectory);
        lock.verify();
        return createNodeHostSession(input.location, lock);
      } catch (error) {
        lock.close();
        throw error;
      }
    }
  });
}

function createMissingControlDirectorySession(
  access: "exclusive" | "observe_only"
): SharedCodexBrokerHostSession {
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw nodeError(
        "io_failed",
        "coordination",
        "The shared Codex broker session is closed.",
        "Shared broker coordination is closed."
      );
    }
  };
  return Object.freeze({
    access,
    async inspect() {
      assertOpen();
      return Object.freeze({ state: "absent" as const });
    },
    async start() {
      assertOpen();
      throw nodeError(
        "insecure_path",
        "security",
        "The shared Codex control directory is unavailable.",
        "Shared broker control directory is unavailable."
      );
    },
    async stopOwned() {
      assertOpen();
      throw nodeError(
        "broker_not_owned",
        "stop",
        "No HostDeck-owned shared Codex broker exists.",
        "Shared broker ownership proof is absent."
      );
    },
    close() {
      closed = true;
    }
  });
}

function createNodeHostSession(
  location: SharedCodexEndpointLocation,
  coordinationLock: HeldCoordinationLock | null
): SharedCodexBrokerHostSession {
  let closed = false;
  const access = coordinationLock === null ? "observe_only" : "exclusive";
  const assertOpen = () => {
    if (closed) {
      throw nodeError(
        "io_failed",
        "coordination",
        "The shared Codex broker session is closed.",
        "Shared broker coordination is closed."
      );
    }
    assertControlDirectory(controlDirectoryPath(location));
    coordinationLock?.verify();
  };
  const assertExclusive = () => {
    assertOpen();
    if (coordinationLock === null) {
      throw nodeError(
        "ownership_ambiguous",
        "coordination",
        "Shared Codex broker mutation requires exclusive coordination.",
        "Shared broker coordination is not exclusive."
      );
    }
  };

  return Object.freeze({
    access,
    async inspect(signal: AbortSignal) {
      assertOpen();
      return inspectEndpoint(location, signal);
    },
    async start(
      input: Parameters<SharedCodexBrokerHostSession["start"]>[0]
    ) {
      assertExclusive();
      return startOwnedBroker(input);
    },
    async stopOwned(
      input: Parameters<SharedCodexBrokerHostSession["stopOwned"]>[0]
    ) {
      assertExclusive();
      return stopOwnedBroker(location, input.timeout_ms, input.signal);
    },
    close() {
      if (closed) return;
      closed = true;
      coordinationLock?.close();
    }
  });
}

async function startOwnedBroker(input: {
  readonly codex_bin: string;
  readonly location: SharedCodexEndpointLocation;
  readonly signal: AbortSignal;
  readonly timeout_ms: number;
}): Promise<SharedCodexBrokerHostObservation> {
  const before = await inspectEndpoint(input.location, input.signal);
  if (before.state === "active") return before;
  assertExecutable(input.codex_bin);
  const ownerPath = ownerRecordPath(input.location);
  if (readOwnerRecord(ownerPath) !== null) {
    throw ownershipAmbiguous("Shared broker ownership metadata already exists.");
  }

  const child = spawn(input.codex_bin, [
    "app-server",
    "--listen",
    `unix://${input.location.socket_path}`
  ], {
    cwd: input.location.codex_home,
    env: { ...process.env, CODEX_HOME: input.location.codex_home },
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  const outcome = observeChild(child);
  let record: SharedCodexBrokerOwnerRecord | null = null;
  try {
    await waitForChildSpawn(child, input.signal);
    const pid = requireChildPid(child);
    const identity = await readStableProcessIdentity(pid, input.signal);
    if (
      identity === null ||
      identity.process_group_id !== pid ||
      identity.session_id !== pid
    ) {
      throw ownershipAmbiguous(
        "The started shared broker lacks an isolated process identity."
      );
    }
    record = ownerRecordFromProcess(identity, null);
    createOwnerRecord(ownerPath, record);

    const deadline = Date.now() + input.timeout_ms;
    while (Date.now() <= deadline) {
      throwIfAborted(input.signal);
      const socket = inspectSocket(input.location.socket_path);
      if (socket !== null) {
        const ready = await rawSocketProbe(
          input.location.socket_path,
          input.signal
        );
        if (
          ready === "active" &&
          processGroupOwnsEndpoint(
            record.process_group_id,
            input.location.socket_path
          )
        ) {
          const finalized = Object.freeze({
            ...record,
            socket_identity: socket.identity
          });
          replaceOwnerRecord(ownerPath, record, finalized);
          record = finalized;
          const observation = await inspectEndpoint(
            input.location,
            input.signal
          );
          if (observation.state !== "active") {
            throw nodeError(
              "socket_changed",
              "readiness",
              "The started shared Codex endpoint did not remain active.",
              "Shared broker identity changed."
            );
          }
          child.unref();
          return observation;
        }
      }

      const childOutcome = outcome.current();
      if (childOutcome !== null) {
        removeOwnerRecord(ownerPath, record);
        record = null;
        const raced = await inspectEndpoint(input.location, input.signal);
        if (raced.state === "active") return raced;
        throw nodeError(
          childOutcome === "spawn_failed" ? "spawn_failed" : "broker_exited",
          "spawn",
          "The shared Codex broker exited before readiness.",
          "Shared broker exited before readiness."
        );
      }
      await sleep(pollIntervalMs, input.signal);
    }
    throw nodeError(
      "startup_timeout",
      "readiness",
      "The shared Codex broker did not become ready in time.",
      "Shared broker startup timed out."
    );
  } catch (error) {
    const cleanupErrors = await cleanupFailedStart(child, record, ownerPath);
    if (cleanupErrors.length > 0) {
      throw nodeError(
        "stop_failed",
        "spawn",
        "The failed shared Codex broker could not be cleaned up.",
        "Shared broker startup cleanup failed.",
        new AggregateError([error, ...cleanupErrors])
      );
    }
    throw error;
  }
}

async function inspectEndpoint(
  location: SharedCodexEndpointLocation,
  signal: AbortSignal
): Promise<SharedCodexBrokerHostObservation> {
  throwIfAborted(signal);
  assertControlDirectory(controlDirectoryPath(location));
  const record = readOwnerRecord(ownerRecordPath(location));
  const socket = inspectSocket(location.socket_path);
  if (socket === null) {
    if (record !== null) {
      throw ownershipAmbiguous("Shared broker ownership metadata is stale.");
    }
    return Object.freeze({ state: "absent" });
  }
  const rawState = await rawSocketProbe(location.socket_path, signal);
  if (rawState === "missing") {
    if (record !== null) {
      throw ownershipAmbiguous(
        "Shared broker ownership changed during inspection."
      );
    }
    return Object.freeze({ state: "absent" });
  }
  if (rawState === "refused") {
    throw nodeError(
      "socket_stale",
      "readiness",
      "The shared Codex socket exists without an active listener.",
      "Shared broker socket is stale."
    );
  }

  let ownership: "attached" | "owned" = "attached";
  if (record !== null) {
    if (
      record.socket_identity !== socket.identity ||
      !processIdentityMatchesRecord(
        readProcessIdentity(record.pid),
        record
      ) ||
      !processGroupOwnsEndpoint(
        record.process_group_id,
        location.socket_path
      )
    ) {
      throw ownershipAmbiguous(
        "Shared broker ownership proof does not match the active endpoint."
      );
    }
    ownership = "owned";
  }
  return Object.freeze({
    state: "active",
    ownership,
    socket_identity: socket.identity,
    generation: generationFromSocketIdentity(socket.identity)
  });
}

async function stopOwnedBroker(
  location: SharedCodexEndpointLocation,
  timeoutMs: number,
  signal: AbortSignal
): Promise<"stale_cleared" | "stopped"> {
  throwIfAborted(signal);
  const ownerPath = ownerRecordPath(location);
  const record = readOwnerRecord(ownerPath);
  if (record === null) {
    throw nodeError(
      "broker_not_owned",
      "stop",
      "The shared Codex broker has no HostDeck ownership proof.",
      "Shared broker ownership proof is absent."
    );
  }
  const identity = readProcessIdentity(record.pid);
  if (identity !== null && !processIdentityMatchesRecord(identity, record)) {
    throw ownershipAmbiguous(
      "Shared broker process identity no longer matches its ownership proof."
    );
  }
  const socket = inspectSocket(location.socket_path);
  if (
    socket !== null &&
    record.socket_identity !== null &&
    socket.identity !== record.socket_identity
  ) {
    throw ownershipAmbiguous(
      "Shared broker socket identity no longer matches its ownership proof."
    );
  }

  if (identity !== null) {
    if (
      socket !== null &&
      (record.socket_identity === null ||
        !processGroupOwnsEndpoint(
          record.process_group_id,
          location.socket_path
        ))
    ) {
      throw ownershipAmbiguous(
        "Shared broker process ownership does not cover the current endpoint."
      );
    }
    await terminateOwnedProcessGroup(
      record.process_group_id,
      timeoutMs,
      signal
    );
  }

  const remainingSocket = inspectSocket(location.socket_path);
  if (remainingSocket !== null) {
    if (
      record.socket_identity === null ||
      remainingSocket.identity !== record.socket_identity
    ) {
      throw ownershipAmbiguous(
        "Shared broker endpoint changed before owned cleanup."
      );
    }
    const state = await rawSocketProbe(location.socket_path, signal);
    if (state === "active") {
      throw nodeError(
        "stop_failed",
        "stop",
        "The proven shared Codex process stopped but the endpoint is active.",
        "Shared broker endpoint remains active."
      );
    }
    if (state === "refused") {
      removeExactSocket(location.socket_path, remainingSocket.identity);
    }
  }
  removeOwnerRecord(ownerPath, record);
  return identity === null ? "stale_cleared" : "stopped";
}

async function cleanupFailedStart(
  child: ChildProcess,
  record: SharedCodexBrokerOwnerRecord | null,
  ownerPath: string
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (record !== null) {
    const identity = readProcessIdentity(record.pid);
    let processGone = identity === null;
    if (processIdentityMatchesRecord(identity, record)) {
      try {
        await terminateOwnedProcessGroup(
          record.process_group_id,
          3_000,
          new AbortController().signal
        );
        processGone = readProcessIdentity(record.pid) === null;
      } catch (error) {
        errors.push(error);
      }
    } else if (identity !== null) {
      errors.push(
        ownershipAmbiguous(
          "Failed broker process identity changed before cleanup."
        )
      );
    }
    if (processGone) {
      try {
        removeOwnerRecord(ownerPath, record);
      } catch (error) {
        errors.push(error);
      }
    }
  } else if (
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!isErrno(error, "ESRCH")) errors.push(error);
    }
  }
  return errors;
}

function observeChild(child: ChildProcess): Readonly<{
  current: () => "exited" | "spawn_failed" | null;
}> {
  let state: "exited" | "spawn_failed" | null = null;
  child.once("error", () => {
    state = "spawn_failed";
  });
  child.once("close", () => {
    state ??= "exited";
  });
  return Object.freeze({ current: () => state });
}

async function waitForChildSpawn(
  child: ChildProcess,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(
        nodeError(
          "spawn_failed",
          "spawn",
          "The shared Codex broker process could not be spawned.",
          "Shared broker process could not start.",
          error
        )
      );
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function ownerRecordFromProcess(
  identity: ProcessIdentity,
  socketIdentity: string | null
): SharedCodexBrokerOwnerRecord {
  return Object.freeze({
    schema: 1,
    pid: identity.pid,
    process_group_id: identity.process_group_id,
    start_ticks: identity.start_ticks,
    executable: identity.executable,
    argv: Object.freeze([...identity.argv]),
    socket_identity: socketIdentity,
    started_at: new Date().toISOString()
  });
}

function readOwnerRecord(path: string): SharedCodexBrokerOwnerRecord | null {
  try {
    lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw ownershipAmbiguous("Shared broker ownership metadata is unreadable.", error);
  }
  let opened: ReturnType<typeof openSecureHostDeckRegularFile> | null = null;
  try {
    opened = openSecureHostDeckRegularFile(path, {
      label: "shared Codex broker ownership record",
      mode: 0o600,
      repair_mode: false,
      writable: false
    });
  } catch (error) {
    throw ownershipAmbiguous("Shared broker ownership metadata is insecure.", error);
  }
  try {
    const metadata = fstatSync(opened.descriptor);
    if (metadata.size < 2 || metadata.size > ownerRecordMaximumBytes) {
      throw new TypeError("Owner record size is invalid.");
    }
    const raw = readFileSync(opened.descriptor, "utf8");
    opened.verifyPath();
    return parseOwnerRecord(JSON.parse(raw));
  } catch (error) {
    throw ownershipAmbiguous("Shared broker ownership metadata is malformed.", error);
  } finally {
    closeSync(opened.descriptor);
  }
}

function createOwnerRecord(
  path: string,
  record: SharedCodexBrokerOwnerRecord
): void {
  if (pathExists(path)) {
    throw ownershipAmbiguous("Shared broker ownership metadata already exists.");
  }
  writeOwnerRecord(path, record, true);
}

function replaceOwnerRecord(
  path: string,
  expected: SharedCodexBrokerOwnerRecord,
  replacement: SharedCodexBrokerOwnerRecord
): void {
  const current = readOwnerRecord(path);
  if (current === null || !sameOwnerRecord(current, expected)) {
    throw ownershipAmbiguous(
      "Shared broker ownership metadata changed before update."
    );
  }
  writeOwnerRecord(path, replacement, false);
}

function writeOwnerRecord(
  path: string,
  record: SharedCodexBrokerOwnerRecord,
  create: boolean
): void {
  const data = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (data.byteLength > ownerRecordMaximumBytes) {
    throw ownershipAmbiguous("Shared broker ownership metadata is too large.");
  }
  let opened: ReturnType<typeof openSecureHostDeckRegularFile> | null = null;
  try {
    opened = openSecureHostDeckRegularFile(path, {
      label: "shared Codex broker ownership record",
      mode: 0o600,
      create,
      repair_mode: false,
      writable: true
    });
  } catch (error) {
    throw ownershipAmbiguous("Shared broker ownership metadata is insecure.", error);
  }
  try {
    ftruncateSync(opened.descriptor, 0);
    writeAll(opened.descriptor, data);
    fsyncSync(opened.descriptor);
    opened.verifyPath();
  } catch (error) {
    throw ownershipAmbiguous("Shared broker ownership metadata could not be written.", error);
  } finally {
    closeSync(opened.descriptor);
  }
}

function removeOwnerRecord(
  path: string,
  expected: SharedCodexBrokerOwnerRecord
): void {
  const current = readOwnerRecord(path);
  if (current === null) return;
  if (!sameOwnerRecord(current, expected)) {
    throw ownershipAmbiguous(
      "Shared broker ownership metadata changed before cleanup."
    );
  }
  let opened: ReturnType<typeof openSecureHostDeckRegularFile> | null = null;
  try {
    opened = openSecureHostDeckRegularFile(path, {
      label: "shared Codex broker ownership record",
      mode: 0o600,
      repair_mode: false,
      writable: false
    });
    opened.verifyPath();
    unlinkSync(path);
  } catch (error) {
    throw ownershipAmbiguous("Shared broker ownership metadata could not be removed.", error);
  } finally {
    if (opened !== null) closeSync(opened.descriptor);
  }
}

function parseOwnerRecord(candidate: unknown): SharedCodexBrokerOwnerRecord {
  const record = requirePlainObject(candidate);
  assertRecordKeys(record, [
    "argv",
    "executable",
    "pid",
    "process_group_id",
    "schema",
    "socket_identity",
    "start_ticks",
    "started_at"
  ]);
  if (
    record.schema !== 1 ||
    !isPositiveSafeInteger(record.pid) ||
    record.process_group_id !== record.pid ||
    typeof record.start_ticks !== "string" ||
    !/^[1-9][0-9]{0,31}$/u.test(record.start_ticks) ||
    typeof record.executable !== "string" ||
    record.executable.length < 2 ||
    !record.executable.startsWith("/") ||
    Buffer.byteLength(record.executable, "utf8") > 4_096 ||
    !Array.isArray(record.argv) ||
    record.argv.length < 1 ||
    record.argv.length > processArgumentMaximumCount ||
    record.argv.some(
      (value) =>
        typeof value !== "string" ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > processArgumentMaximumBytes
    ) ||
    (record.socket_identity !== null &&
      (typeof record.socket_identity !== "string" ||
        !/^[0-9]+:[1-9][0-9]*$/u.test(record.socket_identity))) ||
    typeof record.started_at !== "string" ||
    new Date(record.started_at).toISOString() !== record.started_at
  ) {
    throw new TypeError("Owner record fields are invalid.");
  }
  return Object.freeze({
    schema: 1,
    pid: record.pid,
    process_group_id: record.process_group_id,
    start_ticks: record.start_ticks,
    executable: record.executable,
    argv: Object.freeze([...record.argv]),
    socket_identity: record.socket_identity,
    started_at: record.started_at
  });
}

function sameOwnerRecord(
  left: SharedCodexBrokerOwnerRecord,
  right: SharedCodexBrokerOwnerRecord
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const processMetadata = lstatSync(`/proc/${pid}`);
    if (processMetadata.uid !== requireUid()) return null;
    const rawStat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = rawStat.lastIndexOf(")");
    const fields =
      commandEnd < 0
        ? []
        : rawStat.slice(commandEnd + 2).trim().split(/\s+/u);
    const processGroupId = Number(fields[2]);
    const sessionId = Number(fields[3]);
    const startTicks = fields[19];
    if (
      !isPositiveSafeInteger(processGroupId) ||
      !isPositiveSafeInteger(sessionId) ||
      startTicks === undefined ||
      !/^[1-9][0-9]*$/u.test(startTicks)
    ) {
      return null;
    }
    const executable = realpathSync.native(`/proc/${pid}/exe`);
    const rawArgv = readFileSync(`/proc/${pid}/cmdline`);
    if (rawArgv.byteLength < 2 || rawArgv.byteLength > ownerRecordMaximumBytes) {
      return null;
    }
    const argv = rawArgv
      .toString("utf8")
      .split("\0")
      .filter((value, index, values) =>
        index < values.length - 1 || value.length > 0
      );
    if (
      argv.length < 1 ||
      argv.length > processArgumentMaximumCount ||
      argv.some(
        (value) =>
          value.includes("\0") ||
          Buffer.byteLength(value, "utf8") > processArgumentMaximumBytes
      )
    ) {
      return null;
    }
    return Object.freeze({
      pid,
      process_group_id: processGroupId,
      session_id: sessionId,
      start_ticks: startTicks,
      executable,
      argv: Object.freeze(argv)
    });
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return null;
    throw ownershipAmbiguous("Shared broker process identity is unreadable.", error);
  }
}

async function readStableProcessIdentity(
  pid: number,
  signal: AbortSignal
): Promise<ProcessIdentity | null> {
  const deadline = Date.now() + 1_000;
  let previous: ProcessIdentity | null = null;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const current = readProcessIdentity(pid);
    if (
      current !== null &&
      previous !== null &&
      sameProcessIdentity(current, previous)
    ) {
      return current;
    }
    previous = current;
    await sleep(pollIntervalMs, signal);
  }
  return null;
}

function sameProcessIdentity(
  left: ProcessIdentity,
  right: ProcessIdentity
): boolean {
  return (
    left.pid === right.pid &&
    left.process_group_id === right.process_group_id &&
    left.session_id === right.session_id &&
    left.start_ticks === right.start_ticks &&
    left.executable === right.executable &&
    JSON.stringify(left.argv) === JSON.stringify(right.argv)
  );
}

function processIdentityMatchesRecord(
  identity: ProcessIdentity | null,
  record: SharedCodexBrokerOwnerRecord
): boolean {
  return (
    identity !== null &&
    identity.pid === record.pid &&
    identity.process_group_id === record.process_group_id &&
    identity.session_id === record.process_group_id &&
    identity.start_ticks === record.start_ticks &&
    identity.executable === record.executable &&
    JSON.stringify(identity.argv) === JSON.stringify(record.argv)
  );
}

function processGroupOwnsEndpoint(
  processGroupId: number,
  socketPath: string
): boolean {
  const kernelInode = kernelSocketInodeForPath(socketPath);
  if (kernelInode === null) return false;
  const expected = `socket:[${kernelInode}]`;
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!isPositiveSafeInteger(pid)) continue;
    let identity: ProcessIdentity | null;
    try {
      identity = readProcessIdentity(pid);
    } catch {
      continue;
    }
    if (identity?.process_group_id !== processGroupId) continue;
    let descriptors: string[];
    try {
      descriptors = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${descriptor}`) === expected) {
          return true;
        }
      } catch {
        // Descriptors may close while /proc is being inspected.
      }
    }
  }
  return false;
}

function kernelSocketInodeForPath(socketPath: string): string | null {
  let matches: string[] = [];
  try {
    for (const line of readFileSync("/proc/net/unix", "utf8").split("\n")) {
      const parsed =
        /^[0-9A-Fa-f]+:\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+([0-9]+)(?:\s+(.*))?$/u.exec(
          line
        );
      if (
        parsed?.[1] === "00010000" &&
        parsed[3] === socketPath &&
        parsed[2] !== undefined
      ) {
        matches.push(parsed[2]);
      }
    }
  } catch (error) {
    throw ownershipAmbiguous(
      "Shared broker kernel socket identity is unreadable.",
      error
    );
  }
  matches = [...new Set(matches)];
  if (matches.length > 1) {
    throw ownershipAmbiguous(
      "Shared broker endpoint has multiple kernel socket identities."
    );
  }
  return matches[0] ?? null;
}

function inspectSocket(path: string): SocketObservation | null {
  try {
    lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw insecurePath("Shared broker socket could not be inspected.", error);
  }
  try {
    secureHostDeckSocket(path, {
      label: "shared Codex broker socket",
      mode: 0o600,
      repair_mode: false
    });
    const metadata = lstatSync(path, { bigint: true });
    return Object.freeze({
      identity: `${metadata.dev.toString()}:${metadata.ino.toString()}`
    });
  } catch (error) {
    throw insecurePath("Shared broker socket is insecure.", error);
  }
}

async function rawSocketProbe(
  path: string,
  signal: AbortSignal
): Promise<RawSocketProbe> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let settled = false;
    const timer = setTimeout(() => {
      finishError(
        nodeError(
          "startup_timeout",
          "readiness",
          "The shared Codex socket did not answer promptly.",
          "Shared broker socket probe timed out."
        )
      );
    }, rawProbeTimeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (result: RawSocketProbe) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      resolve(result);
    };
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onConnect = () => finish("active");
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("missing");
      else if (error.code === "ECONNREFUSED") finish("refused");
      else finishError(error);
    };
    const onAbort = () => finishError(signal.reason);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function terminateOwnedProcessGroup(
  processGroupId: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  if (!isProcessGroupAlive(processGroupId)) return;
  sendProcessGroupSignal(processGroupId, "SIGTERM");
  const gracefulMs = Math.max(50, Math.floor(timeoutMs * 0.7));
  if (await waitForProcessGroupExit(processGroupId, gracefulMs, signal)) return;
  sendProcessGroupSignal(processGroupId, "SIGKILL");
  if (
    !(await waitForProcessGroupExit(
      processGroupId,
      Math.max(50, timeoutMs - gracefulMs),
      signal
    ))
  ) {
    throw nodeError(
      "stop_failed",
      "stop",
      "The proven shared Codex process group did not stop.",
      "Shared broker process did not stop."
    );
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    if (!isProcessGroupAlive(processGroupId)) return true;
    await sleep(pollIntervalMs, signal);
  }
  return !isProcessGroupAlive(processGroupId);
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function sendProcessGroupSignal(
  processGroupId: number,
  signal: "SIGKILL" | "SIGTERM"
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH")) {
      throw nodeError(
        "stop_failed",
        "stop",
        "The proven shared Codex process could not be signaled.",
        "Shared broker process could not be stopped.",
        error
      );
    }
  }
}

async function acquireCoordinationLock(
  path: string,
  lockPort: HostDeckFileLockPort,
  timeoutMs: number,
  signal: AbortSignal
): Promise<HeldCoordinationLock> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    let opened: ReturnType<typeof openSecureHostDeckRegularFile>;
    try {
      opened = openSecureHostDeckRegularFile(path, {
        label: "shared Codex broker coordination lock",
        mode: 0o600,
        create: true,
        repair_mode: false,
        writable: true
      });
    } catch (error) {
      throw insecurePath("Shared broker coordination lock is insecure.", error);
    }
    let lock: HostDeckFileLock | null = null;
    try {
      lock = lockPort.tryAcquireExclusive(opened.descriptor);
      if (lock !== null) {
        opened.verifyPath();
        let closed = false;
        return Object.freeze({
          verify() {
            if (closed) {
              throw nodeError(
                "io_failed",
                "coordination",
                "The shared broker coordination lock is closed.",
                "Shared broker coordination is closed."
              );
            }
            opened.verifyPath();
          },
          close() {
            if (closed) return;
            closed = true;
            const errors: unknown[] = [];
            try {
              lock?.release();
            } catch (error) {
              errors.push(error);
            }
            try {
              closeSync(opened.descriptor);
            } catch (error) {
              errors.push(error);
            }
            if (errors.length > 0) {
              throw nodeError(
                "io_failed",
                "coordination",
                "The shared broker coordination lock could not be released.",
                "Shared broker coordination release failed.",
                new AggregateError(errors)
              );
            }
          }
        });
      }
    } finally {
      if (lock === null) closeSync(opened.descriptor);
    }
    await sleep(pollIntervalMs, signal);
  }
  throw nodeError(
    "coordination_timeout",
    "coordination",
    "Another shared Codex broker operation did not release coordination.",
    "Shared broker coordination timed out."
  );
}

function assertCodexHome(location: SharedCodexEndpointLocation): void {
  try {
    const metadata = lstatSync(location.codex_home);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== requireUid() ||
      realpathSync.native(location.codex_home) !== location.codex_home
    ) {
      throw new TypeError("Codex home security is invalid.");
    }
  } catch (error) {
    throw insecurePath("Shared Codex configuration directory is insecure.", error);
  }
}

function createControlDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw insecurePath(
        "Shared Codex control directory could not be created.",
        error
      );
    }
  }
  assertControlDirectory(path);
}

function inspectControlDirectory(path: string): "missing" | "present" {
  try {
    lstatSync(path);
    return "present";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw insecurePath("Shared Codex control directory is unreadable.", error);
  }
}

function assertControlDirectory(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== requireUid() ||
      (metadata.mode & 0o7777) !== 0o700 ||
      realpathSync.native(path) !== path
    ) {
      throw new TypeError("Control directory security is invalid.");
    }
  } catch (error) {
    throw insecurePath("Shared Codex control directory is insecure.", error);
  }
}

function assertExecutable(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      realpathSync.native(path) !== path
    ) {
      throw new TypeError("Executable security is invalid.");
    }
    accessSync(path, fsConstants.X_OK);
  } catch (error) {
    throw nodeError(
      "spawn_failed",
      "spawn",
      "The configured Codex executable is unavailable or insecure.",
      "Shared broker executable is invalid.",
      error
    );
  }
}

function removeExactSocket(path: string, expectedIdentity: string): void {
  const current = inspectSocket(path);
  if (current === null) return;
  if (current.identity !== expectedIdentity) {
    throw ownershipAmbiguous(
      "Shared broker socket changed before proven cleanup."
    );
  }
  try {
    unlinkSync(path);
  } catch (error) {
    throw nodeError(
      "stop_failed",
      "stop",
      "The proven stale shared Codex socket could not be removed.",
      "Shared broker stale socket cleanup failed.",
      error
    );
  }
}

function generationFromSocketIdentity(identity: string): number {
  const digest = createHash("sha256").update(identity).digest();
  const generation = digest.readUIntBE(0, 6);
  return generation === 0 ? 1 : generation;
}

function controlDirectoryPath(location: SharedCodexEndpointLocation): string {
  return join(location.codex_home, controlDirectoryName);
}

function ownerRecordPath(location: SharedCodexEndpointLocation): string {
  return join(controlDirectoryPath(location), ownerRecordName);
}

function requireChildPid(child: ChildProcess): number {
  if (!isPositiveSafeInteger(child.pid)) {
    throw nodeError(
      "spawn_failed",
      "spawn",
      "The shared Codex broker did not expose a process identifier.",
      "Shared broker process identity is unavailable."
    );
  }
  return child.pid;
}

function requireUid(): number {
  const uid = process.getuid?.();
  if (!isPositiveSafeInteger(uid) && uid !== 0) {
    throw nodeError(
      "unsupported_platform",
      "security",
      "Shared Codex broker ownership requires Linux user identifiers.",
      "Shared broker host is unsupported."
    );
  }
  return uid;
}

function assertSupportedHost(): void {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw nodeError(
      "unsupported_platform",
      "security",
      "Shared Codex broker lifecycle requires Linux x64.",
      "Shared broker host is unsupported."
    );
  }
  requireUid();
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
    if (written < 1) throw new Error("Owner record write made no progress.");
    offset += written;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requirePlainObject(candidate: unknown): Record<string, unknown> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new TypeError("Expected a plain object.");
  }
  return candidate as Record<string, unknown>;
}

function assertRecordKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== [...expected].sort()[index])
  ) {
    throw new TypeError("Object keys are invalid.");
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function ownershipAmbiguous(
  message: string,
  cause?: unknown
): NodeSharedCodexBrokerError {
  return nodeError(
    "ownership_ambiguous",
    "security",
    message,
    "Shared broker ownership is ambiguous.",
    cause
  );
}

function insecurePath(
  message: string,
  cause?: unknown
): NodeSharedCodexBrokerError {
  return nodeError(
    "insecure_path",
    "security",
    message,
    "Shared broker path security failed.",
    cause
  );
}

function nodeError(
  code: SharedCodexBrokerErrorCode,
  stage: SharedCodexBrokerErrorStage,
  message: string,
  diagnostic: string,
  cause?: unknown
): NodeSharedCodexBrokerError {
  return new NodeSharedCodexBrokerError(
    code,
    stage,
    message,
    diagnostic,
    cause === undefined ? undefined : { cause }
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
