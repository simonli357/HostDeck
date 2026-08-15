import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  type SharedCodexEndpoint,
  type SharedCodexEndpointLocation,
  sharedCodexEndpointLocationSchema,
  sharedCodexEndpointSchema,
  sharedCodexRuntimeVersion
} from "@hostdeck/contracts";
import {
  NodeSharedCodexBrokerError,
  nodeSharedCodexBrokerCompatibilityProbe,
  nodeSharedCodexBrokerHostPort
} from "./shared-codex-broker-node.js";

export const sharedCodexBrokerModes = [
  "attach_or_start",
  "attach_only"
] as const;

export type SharedCodexBrokerMode =
  (typeof sharedCodexBrokerModes)[number];

export type SharedCodexBrokerErrorCode =
  | "aborted"
  | "broker_absent"
  | "broker_exited"
  | "broker_incompatible"
  | "broker_not_owned"
  | "coordination_timeout"
  | "insecure_path"
  | "invalid_input"
  | "io_failed"
  | "ownership_ambiguous"
  | "socket_changed"
  | "socket_stale"
  | "spawn_failed"
  | "startup_timeout"
  | "stop_failed"
  | "unsupported_platform";

export type SharedCodexBrokerErrorStage =
  | "compatibility"
  | "coordination"
  | "readiness"
  | "resolution"
  | "security"
  | "spawn"
  | "stop";

export class HostDeckSharedCodexBrokerError extends Error {
  constructor(
    readonly code: SharedCodexBrokerErrorCode,
    readonly stage: SharedCodexBrokerErrorStage,
    message: string,
    readonly endpoint: SharedCodexEndpoint,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckSharedCodexBrokerError";
  }
}

export interface ResolveSharedCodexEndpointInput {
  readonly codex_home?: string;
  readonly home_directory: string;
}

export interface StartSharedCodexBrokerInput {
  readonly codex_bin: string;
  readonly location: SharedCodexEndpointLocation;
  readonly mode: SharedCodexBrokerMode;
  readonly observed_version: string;
  readonly signal?: AbortSignal;
  readonly startup_timeout_ms: number;
}

export interface StopSharedCodexBrokerInput {
  readonly location: SharedCodexEndpointLocation;
  readonly signal?: AbortSignal;
  readonly stop_timeout_ms: number;
}

export type SharedCodexBrokerHostObservation =
  | Readonly<{
      state: "absent";
    }>
  | Readonly<{
      state: "active";
      generation: number;
      ownership: "attached" | "owned";
      socket_identity: string;
    }>;

export interface SharedCodexBrokerHostSession {
  readonly access: "exclusive" | "observe_only";
  readonly close: () => void;
  readonly inspect: (
    signal: AbortSignal
  ) => Promise<SharedCodexBrokerHostObservation>;
  readonly start: (
    input: Readonly<{
      codex_bin: string;
      location: SharedCodexEndpointLocation;
      signal: AbortSignal;
      timeout_ms: number;
    }>
  ) => Promise<SharedCodexBrokerHostObservation>;
  readonly stopOwned: (
    input: Readonly<{
      signal: AbortSignal;
      timeout_ms: number;
    }>
  ) => Promise<"stale_cleared" | "stopped">;
}

export interface SharedCodexBrokerHostPort {
  readonly open: (
    input: Readonly<{
      access: "exclusive" | "observe_only";
      create_control_directory: boolean;
      location: SharedCodexEndpointLocation;
      signal: AbortSignal;
      timeout_ms: number;
    }>
  ) => Promise<SharedCodexBrokerHostSession>;
}

export type SharedCodexBrokerCompatibilityProbe = (
  input: Readonly<{
    location: SharedCodexEndpointLocation;
    observed_version: string;
    signal: AbortSignal;
    timeout_ms: number;
  }>
) => Promise<void>;

export interface SharedCodexBrokerDependencies {
  readonly compatibilityProbe?: SharedCodexBrokerCompatibilityProbe;
  readonly host?: SharedCodexBrokerHostPort;
}

export interface SharedCodexBrokerAttachment {
  readonly closed: boolean;
  readonly endpoint: SharedCodexEndpoint;
  readonly location: SharedCodexEndpointLocation;
  readonly close: () => Promise<void>;
}

const minimumLifecycleTimeoutMs = 100;
const maximumLifecycleTimeoutMs = 300_000;
const maximumExecutablePathBytes = 4_096;
const failedStartCleanupTimeoutMs = 5_000;

export function resolveSharedCodexEndpointLocation(
  input: ResolveSharedCodexEndpointInput
): SharedCodexEndpointLocation {
  if (!isPlainObject(input)) {
    throw invalidInput("Shared Codex endpoint input is invalid.");
  }
  assertExactKeys(input, ["codex_home", "home_directory"]);
  const homeDirectory = parseNormalizedAbsolutePath(
    input.home_directory,
    "Shared Codex home directory is invalid."
  );
  const codexHome =
    input.codex_home === undefined
      ? join(homeDirectory, ".codex")
      : parseNormalizedAbsolutePath(
          input.codex_home,
          "Shared Codex configuration directory is invalid."
        );
  return sharedCodexEndpointLocationSchema.parse({
    kind: "standard_unix",
    codex_home: codexHome,
    socket_path: join(
      codexHome,
      "app-server-control",
      "app-server-control.sock"
    )
  });
}

export function resolveNodeSharedCodexEndpointLocation(
  environment: NodeJS.ProcessEnv = process.env
): SharedCodexEndpointLocation {
  const configured = environment.CODEX_HOME;
  return resolveSharedCodexEndpointLocation({
    home_directory: homedir(),
    ...(configured === undefined ? {} : { codex_home: configured })
  });
}

export async function startSharedCodexBroker(
  input: StartSharedCodexBrokerInput,
  dependencies: SharedCodexBrokerDependencies = {}
): Promise<SharedCodexBrokerAttachment> {
  const parsed = parseStartInput(input);
  const host = dependencies.host ?? nodeSharedCodexBrokerHostPort;
  const compatibilityProbe =
    dependencies.compatibilityProbe ??
    nodeSharedCodexBrokerCompatibilityProbe;
  const deadline = createDeadline(
    parsed.startup_timeout_ms,
    parsed.signal
  );
  let session: SharedCodexBrokerHostSession | null = null;
  let result: SharedCodexBrokerAttachment | null = null;
  let failure: HostDeckSharedCodexBrokerError | null = null;
  let startedOwnedBroker = false;

  try {
    session = await host.open({
      access:
        parsed.mode === "attach_or_start" ? "exclusive" : "observe_only",
      create_control_directory: parsed.mode === "attach_or_start",
      location: parsed.location,
      signal: deadline.signal,
      timeout_ms: deadline.remaining()
    });
    let observation = await session.inspect(deadline.signal);
    if (observation.state === "absent") {
      if (parsed.mode === "attach_only") {
        throw brokerError(
          "broker_absent",
          "readiness",
          "The shared Codex broker is not running.",
          absentEndpoint()
        );
      }
      observation = await session.start({
        codex_bin: parsed.codex_bin,
        location: parsed.location,
        signal: deadline.signal,
        timeout_ms: deadline.remaining()
      });
      startedOwnedBroker =
        observation.state === "active" && observation.ownership === "owned";
    }
    if (observation.state !== "active") {
      throw brokerError(
        "io_failed",
        "readiness",
        "The shared Codex broker returned an invalid readiness state.",
        failedEndpoint("Shared broker readiness is invalid.")
      );
    }

    try {
      await compatibilityProbe({
        location: parsed.location,
        observed_version: parsed.observed_version,
        signal: deadline.signal,
        timeout_ms: deadline.remaining()
      });
    } catch (cause) {
      if (deadline.signal.aborted) throw cause;
      throw brokerError(
        "broker_incompatible",
        "compatibility",
        "The shared Codex broker failed compatibility admission.",
        endpointFromObservation(
          observation,
          "incompatible",
          "Shared broker compatibility failed."
        ),
        cause
      );
    }

    const verified = await session.inspect(deadline.signal);
    if (
      verified.state !== "active" ||
      verified.socket_identity !== observation.socket_identity
    ) {
      throw brokerError(
        "socket_changed",
        "compatibility",
        "The shared Codex endpoint changed during compatibility admission.",
        failedEndpoint("Shared broker identity changed."),
        undefined
      );
    }
    result = createAttachment(
      parsed.location,
      endpointFromObservation(verified, "ready", null)
    );
  } catch (cause) {
    failure = normalizeFailure(cause, deadline);
  }
  deadline.close();
  failure = await cleanupFailedOwnedStart(
    session,
    startedOwnedBroker,
    failure,
    parsed.startup_timeout_ms
  );
  failure = closeSession(session, failure);
  if (failure !== null) throw failure;
  if (result === null) {
    throw brokerError(
      "io_failed",
      "readiness",
      "Shared Codex broker startup produced no result.",
      failedEndpoint("Shared broker startup produced no result.")
    );
  }
  return result;
}

async function cleanupFailedOwnedStart(
  session: SharedCodexBrokerHostSession | null,
  startedOwnedBroker: boolean,
  primary: HostDeckSharedCodexBrokerError | null,
  startupTimeoutMs: number
): Promise<HostDeckSharedCodexBrokerError | null> {
  if (!startedOwnedBroker || primary === null || session === null) {
    return primary;
  }
  try {
    await session.stopOwned({
      signal: new AbortController().signal,
      timeout_ms: Math.min(startupTimeoutMs, failedStartCleanupTimeoutMs)
    });
    return primary;
  } catch (cause) {
    const cleanup = brokerError(
      "stop_failed",
      "stop",
      "The shared Codex broker started by a failed operation could not be stopped.",
      failedEndpoint("Failed shared broker startup cleanup failed."),
      cause
    );
    return brokerError(
      primary.code,
      primary.stage,
      primary.message,
      primary.endpoint,
      new AggregateError(
        [primary, cleanup],
        "Shared Codex broker startup and owned cleanup failed."
      )
    );
  }
}

export async function stopOwnedSharedCodexBroker(
  input: StopSharedCodexBrokerInput,
  dependencies: Pick<SharedCodexBrokerDependencies, "host"> = {}
): Promise<SharedCodexEndpoint> {
  const parsed = parseStopInput(input);
  const deadline = createDeadline(parsed.stop_timeout_ms, parsed.signal);
  let session: SharedCodexBrokerHostSession | null = null;
  let result: SharedCodexEndpoint | null = null;
  let failure: HostDeckSharedCodexBrokerError | null = null;
  try {
    session = await (dependencies.host ?? nodeSharedCodexBrokerHostPort).open({
      access: "exclusive",
      create_control_directory: false,
      location: parsed.location,
      signal: deadline.signal,
      timeout_ms: deadline.remaining()
    });
    await session.stopOwned({
      signal: deadline.signal,
      timeout_ms: deadline.remaining()
    });
    result = absentEndpoint();
  } catch (cause) {
    failure = normalizeFailure(cause, deadline);
  }
  deadline.close();
  failure = closeSession(session, failure);
  if (failure !== null) throw failure;
  if (result === null) {
    throw brokerError(
      "stop_failed",
      "stop",
      "Shared Codex broker stop produced no result.",
      failedEndpoint("Shared broker stop produced no result.")
    );
  }
  return result;
}

function createAttachment(
  location: SharedCodexEndpointLocation,
  endpoint: SharedCodexEndpoint
): SharedCodexBrokerAttachment {
  let closed = false;
  return Object.freeze({
    location,
    endpoint,
    get closed() {
      return closed;
    },
    async close() {
      closed = true;
    }
  });
}

function endpointFromObservation(
  observation: Extract<SharedCodexBrokerHostObservation, { state: "active" }>,
  state: "incompatible" | "ready",
  reason: string | null
): SharedCodexEndpoint {
  return sharedCodexEndpointSchema.parse({
    kind: "standard_unix",
    state,
    ownership: observation.ownership,
    generation: observation.generation,
    observed_version: sharedCodexRuntimeVersion,
    reason
  });
}

function absentEndpoint(): SharedCodexEndpoint {
  return sharedCodexEndpointSchema.parse({
    kind: "standard_unix",
    state: "absent",
    ownership: "none",
    generation: 0,
    observed_version: null,
    reason: null
  });
}

function failedEndpoint(reason: string): SharedCodexEndpoint {
  return sharedCodexEndpointSchema.parse({
    kind: "standard_unix",
    state: "failed",
    ownership: "none",
    generation: 0,
    observed_version: null,
    reason
  });
}

function parseStartInput(
  input: StartSharedCodexBrokerInput
): StartSharedCodexBrokerInput {
  if (!isPlainObject(input)) {
    throw invalidInput("Shared Codex broker start input is invalid.");
  }
  assertExactKeys(input, [
    "codex_bin",
    "location",
    "mode",
    "observed_version",
    "signal",
    "startup_timeout_ms"
  ]);
  const location = parseLocation(input.location);
  const codexBin = parseNormalizedAbsolutePath(
    input.codex_bin,
    "Shared Codex executable path is invalid."
  );
  if (
    Buffer.byteLength(codexBin, "utf8") > maximumExecutablePathBytes ||
    !sharedCodexBrokerModes.includes(input.mode)
  ) {
    throw invalidInput("Shared Codex broker start policy is invalid.");
  }
  if (input.observed_version !== sharedCodexRuntimeVersion) {
    throw invalidInput("Shared Codex broker requires the reviewed runtime version.");
  }
  const signal = parseSignal(input.signal);
  return Object.freeze({
    codex_bin: codexBin,
    location,
    mode: input.mode,
    observed_version: input.observed_version,
    ...(signal === undefined ? {} : { signal }),
    startup_timeout_ms: parseTimeout(input.startup_timeout_ms)
  });
}

function parseStopInput(
  input: StopSharedCodexBrokerInput
): StopSharedCodexBrokerInput {
  if (!isPlainObject(input)) {
    throw invalidInput("Shared Codex broker stop input is invalid.");
  }
  assertExactKeys(input, ["location", "signal", "stop_timeout_ms"]);
  const signal = parseSignal(input.signal);
  return Object.freeze({
    location: parseLocation(input.location),
    ...(signal === undefined ? {} : { signal }),
    stop_timeout_ms: parseTimeout(input.stop_timeout_ms)
  });
}

function parseLocation(candidate: unknown): SharedCodexEndpointLocation {
  const parsed = sharedCodexEndpointLocationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw invalidInput("Shared Codex endpoint location is invalid.", parsed.error);
  }
  return parsed.data;
}

function parseNormalizedAbsolutePath(candidate: unknown, message: string): string {
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.includes("\0") ||
    !isAbsolute(candidate) ||
    normalize(candidate) !== candidate ||
    (candidate !== "/" && candidate.endsWith("/"))
  ) {
    throw invalidInput(message);
  }
  return candidate;
}

function parseTimeout(candidate: unknown): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimumLifecycleTimeoutMs ||
    candidate > maximumLifecycleTimeoutMs
  ) {
    throw invalidInput("Shared Codex broker timeout is invalid.");
  }
  return candidate;
}

function parseSignal(candidate: unknown): AbortSignal | undefined {
  if (candidate === undefined) return undefined;
  if (!(candidate instanceof AbortSignal)) {
    throw invalidInput("Shared Codex broker cancellation signal is invalid.");
  }
  return candidate;
}

function createDeadline(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Readonly<{
  signal: AbortSignal;
  remaining: () => number;
  close: () => void;
}> {
  const started = Date.now();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new Error("Shared Codex broker deadline expired."));
  }, timeoutMs);
  timer.unref();
  const signal =
    externalSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([externalSignal, timeoutController.signal]);
  return Object.freeze({
    signal,
    remaining: () => Math.max(1, timeoutMs - (Date.now() - started)),
    close: () => clearTimeout(timer)
  });
}

function normalizeFailure(
  cause: unknown,
  deadline: Readonly<{ signal: AbortSignal }>
): HostDeckSharedCodexBrokerError {
  if (cause instanceof HostDeckSharedCodexBrokerError) return cause;
  if (deadline.signal.aborted) {
    return brokerError(
      "aborted",
      "readiness",
      "Shared Codex broker work was cancelled or timed out.",
      failedEndpoint("Shared broker operation was cancelled."),
      cause
    );
  }
  if (cause instanceof NodeSharedCodexBrokerError) {
    return brokerError(
      cause.code,
      cause.stage,
      cause.message,
      failedEndpoint(cause.diagnostic),
      cause
    );
  }
  return brokerError(
    "io_failed",
    "readiness",
    "Shared Codex broker work failed.",
    failedEndpoint("Shared broker operation failed."),
    cause
  );
}

function closeSession(
  session: SharedCodexBrokerHostSession | null,
  primary: HostDeckSharedCodexBrokerError | null
): HostDeckSharedCodexBrokerError | null {
  if (session === null) return primary;
  try {
    session.close();
    return primary;
  } catch (cause) {
    const cleanup = brokerError(
      "io_failed",
      "coordination",
      "Shared Codex broker coordination could not be released.",
      failedEndpoint("Shared broker coordination release failed."),
      cause
    );
    if (primary === null) return cleanup;
    return brokerError(
      primary.code,
      primary.stage,
      primary.message,
      primary.endpoint,
      new AggregateError(
        [primary, cleanup],
        "Shared Codex broker operation and coordination cleanup failed."
      )
    );
  }
}

function brokerError(
  code: SharedCodexBrokerErrorCode,
  stage: SharedCodexBrokerErrorStage,
  message: string,
  endpoint: SharedCodexEndpoint,
  cause?: unknown
): HostDeckSharedCodexBrokerError {
  return new HostDeckSharedCodexBrokerError(
    code,
    stage,
    message,
    endpoint,
    cause === undefined ? undefined : { cause }
  );
}

function invalidInput(
  message: string,
  cause?: unknown
): HostDeckSharedCodexBrokerError {
  return brokerError(
    "invalid_input",
    "resolution",
    message,
    failedEndpoint("Shared broker input is invalid."),
    cause
  );
}

function assertExactKeys(
  value: object,
  allowed: readonly string[]
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
  ) {
    throw invalidInput("Shared Codex broker input contains unknown fields.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
