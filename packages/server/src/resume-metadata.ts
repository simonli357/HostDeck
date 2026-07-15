import { isDeepStrictEqual } from "node:util";
import { buildCodexTuiResumeCommand } from "@hostdeck/codex-adapter";
import {
  formatSelectedResumeLaunchCommand,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedResumeLaunch,
  type SelectedResumeMetadataResponse,
  type SelectedResumeParams,
  type SelectedSessionProjectionRecord,
  selectedResumeLaunchSchema,
  selectedResumeMetadataResponseSchema,
  selectedResumeParamsSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { HostDeckSelectedStateRepositoryError } from "@hostdeck/storage";

export type HostDeckResumeMetadataErrorCode =
  | "runtime_unavailable"
  | "session_not_found"
  | "stale_session"
  | "state_unavailable"
  | "unstable_state";

export class HostDeckResumeMetadataError extends Error {
  constructor(
    readonly code: HostDeckResumeMetadataErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckResumeMetadataError";
  }
}

export interface HostDeckResumeStatePort {
  readonly require: (sessionId: string) => unknown;
}

export interface HostDeckResumeRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckResumeMetadataReaderInput {
  readonly codexBin: string;
  readonly runtime: HostDeckResumeRuntimePort;
  readonly socketPath: string;
  readonly state: HostDeckResumeStatePort;
}

export interface HostDeckResumeMetadataReader {
  readonly read: (sessionId: string) => SelectedResumeMetadataResponse;
}

type RequireStateFunction = HostDeckResumeStatePort["require"];
type ReadRuntimeFunction = HostDeckResumeRuntimePort["read"];

interface ParsedReaderInput {
  readonly codexBin: string;
  readonly readRuntime: ReadRuntimeFunction;
  readonly requireState: RequireStateFunction;
  readonly socketPath: string;
}

interface ResumeStateSnapshot {
  readonly codexThreadId: string;
  readonly freshness: SelectedSessionProjectionRecord["session"]["freshness"];
  readonly mappingUpdatedAt: string;
  readonly projectionUpdatedAt: string;
  readonly runtimeVersion: string;
  readonly sessionId: SelectedResumeParams["session_id"];
  readonly sessionState: SelectedSessionProjectionRecord["session"]["session_state"];
}

const inputKeys = ["codexBin", "runtime", "socketPath", "state"] as const;
const runtimePortKeys = ["read"] as const;
const statePortKeys = ["require"] as const;
const stateKeys = ["mapping", "projection"] as const;
const maximumConsistencyAttempts = 3;
const configurationProbeSessionId = "sess_resume_config_check";
const configurationProbeThreadId = "thread-resume-config-check";

export function createHostDeckResumeMetadataReader(
  input: CreateHostDeckResumeMetadataReaderInput
): HostDeckResumeMetadataReader {
  const options = parseReaderInput(input);
  const reader: HostDeckResumeMetadataReader = {
    read(sessionIdCandidate) {
      const sessionId = parseSessionId(sessionIdCandidate);
      for (
        let attempt = 1;
        attempt <= maximumConsistencyAttempts;
        attempt += 1
      ) {
        const stateBefore = readState(options.requireState, sessionId);
        const runtimeBefore = readRuntime(options.readRuntime);
        const response = materializeResponse(options, stateBefore, runtimeBefore);
        const runtimeAfter = readRuntime(options.readRuntime);
        const stateAfter = readState(options.requireState, sessionId);
        if (
          isDeepStrictEqual(stateBefore, stateAfter) &&
          isDeepStrictEqual(runtimeBefore, runtimeAfter)
        ) {
          return response;
        }
      }
      throw new HostDeckResumeMetadataError(
        "unstable_state",
        "Managed-thread resume state changed during the bounded read.",
        true
      );
    }
  };
  return Object.freeze(reader);
}

function parseReaderInput(input: unknown): ParsedReaderInput {
  const values = readExactDataObject(
    input,
    inputKeys,
    "HostDeck resume metadata reader input is invalid."
  );
  const runtime = readExactDataObject(
    values.runtime,
    runtimePortKeys,
    "HostDeck resume runtime port is invalid."
  );
  const state = readExactDataObject(
    values.state,
    statePortKeys,
    "HostDeck resume state port is invalid."
  );
  if (
    typeof values.codexBin !== "string" ||
    typeof values.socketPath !== "string" ||
    typeof runtime.read !== "function" ||
    typeof state.require !== "function"
  ) {
    throw new TypeError("HostDeck resume metadata reader input is invalid.");
  }
  try {
    const launch = parseLaunch(buildCodexTuiResumeCommand({
      codex_bin: values.codexBin,
      socket_path: values.socketPath,
      thread_id: configurationProbeThreadId
    }));
    selectedResumeMetadataResponseSchema.parse({
      session_id: configurationProbeSessionId,
      local_only: true,
      available: true,
      command: formatSelectedResumeLaunchCommand(launch),
      launch,
      unavailable_reason: null
    });
  } catch {
    throw new TypeError("HostDeck resume command configuration is invalid.");
  }
  return Object.freeze({
    codexBin: values.codexBin,
    readRuntime: runtime.read as ReadRuntimeFunction,
    requireState: state.require as RequireStateFunction,
    socketPath: values.socketPath
  });
}

function readState(
  requireState: RequireStateFunction,
  sessionId: string
): ResumeStateSnapshot {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(requireState, undefined, [sessionId]);
  } catch (error) {
    if (
      error instanceof HostDeckSelectedStateRepositoryError &&
      error.code === "session_not_found"
    ) {
      throw new HostDeckResumeMetadataError(
        "session_not_found",
        "Managed session was not found.",
        false
      );
    }
    throw new HostDeckResumeMetadataError(
      "state_unavailable",
      "Managed session state is unavailable.",
      false,
      { cause: error }
    );
  }

  try {
    const state = readExactDataObject(
      candidate,
      stateKeys,
      "Managed resume state is invalid."
    );
    const mapping = selectedSessionMappingRecordSchema.parse(state.mapping);
    const projection = selectedSessionProjectionRecordSchema.parse(
      state.projection
    );
    const session = projection.session;
    if (
      mapping.id !== sessionId ||
      session.id !== sessionId ||
      mapping.id !== session.id ||
      mapping.name !== session.name ||
      mapping.codex_thread_id !== session.codex_thread_id ||
      mapping.cwd !== session.cwd ||
      mapping.runtime_source !== session.runtime_source ||
      mapping.runtime_version !== session.runtime_version ||
      mapping.created_at !== session.created_at ||
      mapping.archived_at !== session.archived_at
    ) {
      throw new TypeError();
    }
    if (mapping.disposition !== "selected") {
      throw new HostDeckResumeMetadataError(
        "stale_session",
        "Managed session requires recovery before laptop resume.",
        false
      );
    }
    if (mapping.archived_at !== null || session.session_state === "archived") {
      throw new HostDeckResumeMetadataError(
        "stale_session",
        "Archived sessions cannot be resumed through HostDeck.",
        false
      );
    }
    return Object.freeze({
      codexThreadId: mapping.codex_thread_id,
      freshness: session.freshness,
      mappingUpdatedAt: mapping.updated_at,
      projectionUpdatedAt: session.updated_at,
      runtimeVersion: mapping.runtime_version,
      sessionId: mapping.id,
      sessionState: session.session_state
    });
  } catch (error) {
    if (error instanceof HostDeckResumeMetadataError) throw error;
    throw new HostDeckResumeMetadataError(
      "state_unavailable",
      "Managed session state is inconsistent.",
      false,
      { cause: error }
    );
  }
}

function readRuntime(
  read: ReadRuntimeFunction
): RuntimeCompatibility | null {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(read, undefined, []);
  } catch (error) {
    throw new HostDeckResumeMetadataError(
      "runtime_unavailable",
      "Codex runtime compatibility is unavailable.",
      true,
      { cause: error }
    );
  }
  if (candidate === null) return null;
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckResumeMetadataError(
      "runtime_unavailable",
      "Codex runtime compatibility is invalid.",
      false,
      { cause: parsed.error }
    );
  }
  return deepFreeze(parsed.data);
}

function materializeResponse(
  options: Pick<ParsedReaderInput, "codexBin" | "socketPath">,
  state: ResumeStateSnapshot,
  runtime: RuntimeCompatibility | null
): SelectedResumeMetadataResponse {
  if (!isSessionReady(state)) {
    return unavailable(
      state.sessionId,
      "The managed session is not ready for laptop resume."
    );
  }
  if (!isRuntimeReady(runtime, state.runtimeVersion)) {
    return unavailable(
      state.sessionId,
      "The selected Codex runtime is not available for laptop resume."
    );
  }

  let launch: SelectedResumeLaunch;
  try {
    launch = parseLaunch(
      buildCodexTuiResumeCommand({
        codex_bin: options.codexBin,
        socket_path: options.socketPath,
        thread_id: state.codexThreadId
      })
    );
  } catch (error) {
    throw new HostDeckResumeMetadataError(
      "runtime_unavailable",
      "Laptop resume command could not be constructed.",
      false,
      { cause: error }
    );
  }
  return parseResponse({
    session_id: state.sessionId,
    local_only: true,
    available: true,
    command: formatSelectedResumeLaunchCommand(launch),
    launch,
    unavailable_reason: null
  });
}

function unavailable(
  sessionId: string,
  reason: string
): SelectedResumeMetadataResponse {
  return parseResponse({
    session_id: sessionId,
    local_only: true,
    available: false,
    command: null,
    launch: null,
    unavailable_reason: reason
  });
}

function isSessionReady(state: ResumeStateSnapshot): boolean {
  return state.sessionState === "active" && state.freshness === "current";
}

function isRuntimeReady(
  runtime: RuntimeCompatibility | null,
  runtimeVersion: string
): runtime is RuntimeCompatibility {
  if (
    runtime === null ||
    !["degraded", "ready"].includes(runtime.state) ||
    runtime.mutation_policy !== "allowed" ||
    runtime.observed_version !== runtimeVersion ||
    runtime.binding_id === null
  ) {
    return false;
  }
  const capabilities = new Map(
    runtime.capabilities.map((capability) => [
      capability.name,
      capability.state
    ])
  );
  return (
    capabilities.get("thread_lifecycle") === "available" &&
    capabilities.get("multi_client") === "available"
  );
}

function parseLaunch(candidate: unknown): SelectedResumeLaunch {
  const values = readExactDataObject(
    candidate,
    ["args", "executable"] as const,
    "Codex resume launch descriptor is invalid."
  );
  const parsed = selectedResumeLaunchSchema.parse({
    executable: values.executable,
    args: values.args
  });
  return deepFreeze(parsed);
}

function parseSessionId(
  candidate: unknown
): SelectedResumeParams["session_id"] {
  const parsed = selectedResumeParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) {
    throw new TypeError("Managed session id is invalid.");
  }
  return parsed.data.session_id;
}

function parseResponse(candidate: unknown): SelectedResumeMetadataResponse {
  const parsed = selectedResumeMetadataResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckResumeMetadataError(
      "runtime_unavailable",
      "Laptop resume metadata exceeds its selected contract.",
      false,
      { cause: parsed.error }
    );
  }
  return deepFreeze(parsed.data);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
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
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(expectedKeys as readonly string[]).includes(key)
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
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
