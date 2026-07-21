import {
  type CodexSkillsClient,
  type CodexSkillsListing,
  HostDeckCodexAdapterError
} from "@hostdeck/codex-adapter";
import {
  type ManagedSessionTarget,
  type SelectedOperationIntent,
  type SkillsSnapshot,
  skillsOperationIntentSchema,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import type { ErrorCode, OperationDeadline } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";
import { requireOpenOperationDeadline } from "./operation-deadline-serialization.js";

type SkillsIntent = Extract<SelectedOperationIntent, { readonly kind: "skills" }>;

export type CodexSkillsControlErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "operation_timeout"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "state_unavailable"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_readable"
  | "target_stale";

export class HostDeckCodexSkillsControlError extends Error {
  constructor(
    readonly code: CodexSkillsControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexSkillsControlError";
  }
}

export interface CodexSkillsControlStatePort {
  readonly get: SelectedStateRepository["get"];
}

export interface CodexSkillsControlServiceOptions {
  readonly skills: CodexSkillsClient;
  readonly states: CodexSkillsControlStatePort;
}

export interface CodexSkillsControlService {
  readonly list: (intent: unknown, deadline: OperationDeadline) => Promise<SkillsSnapshot>;
}

export function createCodexSkillsControlService(
  options: CodexSkillsControlServiceOptions
): CodexSkillsControlService {
  const parsed = parseOptions(options);
  return Object.freeze({
    list: (intent: unknown, deadline: OperationDeadline) => listSkills(parsed, intent, deadline)
  });
}

async function listSkills(
  options: CodexSkillsControlServiceOptions,
  candidate: unknown,
  deadline: OperationDeadline
): Promise<SkillsSnapshot> {
  requireSkillsDeadline(deadline);
  const intent = parseIntent(candidate);
  const initial = requireReadableTarget(options.states, intent.target);
  const runtimeBefore = readCurrentRuntime(options.skills);
  requireRuntimeMatch(initial, runtimeBefore.version);
  const initialCwd = initial.mapping.cwd;
  let listing: CodexSkillsListing;
  try {
    listing = await options.skills.listForCwd({
      cwd: initialCwd,
      deadline
    });
  } catch (error) {
    throw mapAdapterError(error);
  }
  requireSkillsDeadline(deadline);
  assertExactListing(listing);
  const parsed = skillsSnapshotSchema.safeParse({
    target: intent.target,
    runtime_version: listing.runtime_version,
    connection_generation: listing.connection_generation,
    observed_at: listing.observed_at,
    state: listing.state,
    skills: listing.skills,
    error_count: listing.error_count
  });
  if (!parsed.success) {
    throw controlError(
      "runtime_protocol_error",
      "protocol_error",
      "Codex skills sources could not form one valid path-redacted snapshot.",
      false,
      parsed.error
    );
  }
  const runtimeAfter = readCurrentRuntime(options.skills);
  if (
    runtimeAfter.version !== runtimeBefore.version ||
    runtimeAfter.generation !== runtimeBefore.generation ||
    listing.runtime_version !== runtimeBefore.version ||
    listing.connection_generation !== runtimeBefore.generation
  ) {
    throw controlError(
      "runtime_unavailable",
      "runtime_unavailable",
      "Codex skills listing crossed a runtime version or connection generation.",
      true
    );
  }
  const current = requireReadableTarget(options.states, intent.target);
  if (current.mapping.cwd !== initialCwd || current.projection.session.cwd !== initialCwd) {
    throw controlError(
      "target_stale",
      "stale_session",
      "The selected session cwd changed while skills were loading.",
      true
    );
  }
  requireRuntimeMatch(current, runtimeBefore.version);
  return deepFreeze(parsed.data);
}

function readCurrentRuntime(skills: CodexSkillsClient): { readonly version: string; readonly generation: number } {
  try {
    const version = skills.runtime_version;
    const generation = skills.connection_generation;
    if (typeof version !== "string" || version.length === 0 || !Number.isSafeInteger(generation) || generation < 1) {
      throw controlError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex skills runtime identity is invalid.",
        false
      );
    }
    return Object.freeze({ version, generation });
  } catch (error) {
    if (error instanceof HostDeckCodexSkillsControlError) throw error;
    throw mapAdapterError(error);
  }
}

function requireRuntimeMatch(state: SelectedSessionState, runtimeVersion: string): void {
  if (
    state.mapping.runtime_version !== runtimeVersion ||
    state.projection.session.runtime_version !== runtimeVersion
  ) {
    throw controlError(
      "target_stale",
      "stale_session",
      "The selected session belongs to a different Codex runtime version.",
      true
    );
  }
}

function parseOptions(candidate: unknown): CodexSkillsControlServiceOptions {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("Codex skills control options must be a plain object.");
  }
  const value = candidate as Readonly<Record<string, unknown>>;
  if (Object.keys(value).some((key) => !["skills", "states"].includes(key))) {
    throw new TypeError("Codex skills control option fields are invalid.");
  }
  if (
    value.skills === null ||
    typeof value.skills !== "object" ||
    typeof (value.skills as { readonly listForCwd?: unknown }).listForCwd !== "function" ||
    value.states === null ||
    typeof value.states !== "object" ||
    typeof (value.states as { readonly get?: unknown }).get !== "function"
  ) {
    throw new TypeError("Codex skills control requires exact skills and selected-state ports.");
  }
  return Object.freeze({
    skills: value.skills as CodexSkillsClient,
    states: value.states as CodexSkillsControlStatePort
  });
}

function parseIntent(candidate: unknown): SkillsIntent {
  const parsed = skillsOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw controlError(
      "invalid_request",
      "validation_error",
      "The skills request is invalid.",
      true,
      parsed.error
    );
  }
  return parsed.data;
}

function requireReadableTarget(
  states: CodexSkillsControlStatePort,
  target: ManagedSessionTarget
): SelectedSessionState {
  let state: SelectedSessionState | null;
  try {
    state = states.get(target.session_id);
  } catch (error) {
    throw controlError(
      "state_unavailable",
      "storage_error",
      "Selected state could not read the skills target.",
      true,
      error
    );
  }
  if (state === null) {
    throw controlError(
      "target_not_found",
      "session_not_found",
      "The selected managed session does not exist.",
      false
    );
  }
  if (state.mapping.codex_thread_id !== target.codex_thread_id) {
    throw controlError(
      "target_mismatch",
      "invalid_session_id",
      "The selected session and skills thread identity do not match.",
      false
    );
  }
  if (
    state.mapping.archived_at !== null ||
    state.projection.session.archived_at !== null ||
    state.projection.session.session_state === "archived"
  ) {
    throw controlError(
      "target_not_readable",
      "session_not_writable",
      "The selected managed session is archived.",
      false
    );
  }
  if (
    state.mapping.disposition !== "selected" ||
    state.projection.session.session_state !== "active" ||
    state.projection.session.freshness !== "current"
  ) {
    throw controlError(
      "target_stale",
      "stale_session",
      "The selected managed session is not current for skills listing.",
      true
    );
  }
  if (state.mapping.cwd !== state.projection.session.cwd) {
    throw controlError(
      "target_stale",
      "stale_session",
      "The selected mapping and projection disagree on cwd.",
      true
    );
  }
  return state;
}

function assertExactListing(candidate: CodexSkillsListing): void {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
  ) {
    throw controlError(
      "runtime_protocol_error",
      "protocol_error",
      "Codex skills adapter returned a non-object listing.",
      false
    );
  }
  const expected = [
    "connection_generation",
    "error_count",
    "observed_at",
    "runtime_version",
    "skills",
    "state"
  ];
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(expected)) {
    throw controlError(
      "runtime_protocol_error",
      "protocol_error",
      "Codex skills adapter listing fields are invalid.",
      false
    );
  }
}

function mapAdapterError(error: unknown): HostDeckCodexSkillsControlError {
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return controlError(
      "runtime_unavailable",
      "runtime_unavailable",
      "Codex skills could not be listed.",
      false,
      error
    );
  }
  if (error.code === "unsupported_method") {
    return controlError(
      "capability_unsupported",
      "capability_unavailable",
      error.message,
      false,
      error
    );
  }
  if (["request_aborted", "request_timeout"].includes(error.code)) {
    return controlError(
      "operation_timeout",
      "operation_timeout",
      error.message,
      true,
      error
    );
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    return controlError(
      "runtime_protocol_error",
      "protocol_error",
      error.message,
      false,
      error
    );
  }
  if (error.code === "broker_overloaded") {
    return controlError(
      "service_overloaded",
      "service_overloaded",
      error.message,
      error.retry_safe,
      error
    );
  }
  return controlError(
    "runtime_unavailable",
    "runtime_unavailable",
    error.message,
    error.retry_safe,
    error
  );
}

function requireSkillsDeadline(candidate: unknown): OperationDeadline {
  return requireOpenOperationDeadline(
    candidate,
    (cause) =>
      controlError(
        "operation_timeout",
        "operation_timeout",
        "Codex skills read exceeded its request deadline.",
        true,
        cause
      ),
    (cause) =>
      controlError(
        "invalid_request",
        "validation_error",
        "The skills request deadline is invalid.",
        false,
        cause
      )
  );
}

function controlError(
  code: CodexSkillsControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexSkillsControlError {
  return new HostDeckCodexSkillsControlError(code, apiCode, message, retrySafe, { cause });
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex skills control failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
