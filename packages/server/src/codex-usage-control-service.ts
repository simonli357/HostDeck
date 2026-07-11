import {
  type CodexAccountUsageRead,
  type CodexUsageClient,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  type ManagedSessionTarget,
  positiveSafeIntegerSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent,
  type UsageRateLimitObservation,
  type UsageSnapshot,
  type UsageThreadObservation,
  usageOperationIntentSchema,
  usageRateLimitObservationSchema,
  usageSnapshotSchema,
  usageThreadObservationSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";

type UsageOperationIntent = Extract<SelectedOperationIntent, { readonly kind: "usage" }>;
type ThreadUsageEvent = Extract<NormalizedCodexEvent, { readonly method: "thread/tokenUsage/updated" }>;
type RateLimitEvent = Extract<NormalizedCodexEvent, { readonly method: "account/rateLimits/updated" }>;

export type CodexUsageControlErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "observation_conflict"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "state_unavailable"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_readable"
  | "target_stale";

export class HostDeckCodexUsageControlError extends Error {
  constructor(
    readonly code: CodexUsageControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexUsageControlError";
  }
}

export interface CodexUsageControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexUsageControlServiceOptions {
  readonly usage: CodexUsageClient;
  readonly states: CodexUsageControlStatePort;
  readonly max_tracked_threads?: number;
}

export interface CodexUsageControlService {
  readonly read: (intent: unknown, signal?: AbortSignal) => Promise<UsageSnapshot>;
  readonly observe: (event: NormalizedCodexEvent, generation: unknown) => boolean;
  readonly connection_generation: number | null;
  readonly tracked_thread_count: number;
}

interface ThreadObservationRecord {
  readonly observation: Extract<UsageThreadObservation, { readonly state: "observed" }>;
  readonly sequence: number;
}

interface RateObservationRecord {
  readonly observation: Extract<UsageRateLimitObservation, { readonly state: "observed" }>;
  readonly sequence: number;
}

const usageEventMethods = new Set(["thread/tokenUsage/updated", "account/rateLimits/updated", "thread/archived"]);
const tokenFields = [
  "total_tokens",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens"
] as const;

export function createCodexUsageControlService(options: CodexUsageControlServiceOptions): CodexUsageControlService {
  const implementation = new DefaultCodexUsageControlService(parseOptions(options));
  return Object.freeze({
    read: (intent: unknown, signal?: AbortSignal) => implementation.read(intent, signal),
    observe: (event: NormalizedCodexEvent, generation: unknown) => implementation.observe(event, generation),
    get connection_generation() {
      return implementation.connection_generation;
    },
    get tracked_thread_count() {
      return implementation.tracked_thread_count;
    }
  });
}

class DefaultCodexUsageControlService implements CodexUsageControlService {
  private readonly threadById = new Map<string, ThreadObservationRecord>();
  private rateLimit: RateObservationRecord | null = null;
  private currentGeneration: number | null = null;

  constructor(private readonly options: Required<CodexUsageControlServiceOptions>) {}

  get connection_generation(): number | null {
    return this.currentGeneration;
  }

  get tracked_thread_count(): number {
    return this.threadById.size;
  }

  async read(candidate: unknown, signal?: AbortSignal): Promise<UsageSnapshot> {
    const intent = parseIntent(candidate);
    this.requireReadableTarget(intent.target);
    const account = await this.readAccount(signal);
    const generation = parseGeneration(account.connection_generation);
    this.synchronizeGeneration(generation);
    const currentTarget = this.requireReadableTarget(intent.target);
    if (
      currentTarget.mapping.runtime_version !== account.runtime_version ||
      currentTarget.projection.session.runtime_version !== account.runtime_version
    ) {
      throw controlError(
        "target_stale",
        "stale_session",
        "The selected session belongs to a different Codex runtime version.",
        true
      );
    }

    const thread = this.threadById.get(intent.target.codex_thread_id)?.observation ?? notObservedThread();
    const rateLimits = this.rateLimit?.observation ?? notObservedRateLimit();
    const measuredAt = latestTimestamp(
      account.observed_at,
      thread.state === "observed" ? thread.observed_at : null,
      rateLimits.state === "observed" ? rateLimits.observed_at : null
    );
    const snapshot = usageSnapshotSchema.safeParse({
      target: intent.target,
      runtime_version: account.runtime_version,
      connection_generation: account.connection_generation,
      measured_at: measuredAt,
      account: account.account,
      thread,
      rate_limits: rateLimits
    });
    if (!snapshot.success) {
      throw controlError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex usage sources could not form one consistent snapshot.",
        false,
        snapshot.error
      );
    }
    return deepFreeze(snapshot.data);
  }

  observe(event: NormalizedCodexEvent, generationInput: unknown): boolean {
    if (!usageEventMethods.has(event.method)) return false;
    const generation = parseGeneration(generationInput);
    const activeGeneration = this.readActiveGeneration();
    this.synchronizeGeneration(activeGeneration);
    if (generation !== activeGeneration) {
      throw controlError(
        "runtime_unavailable",
        "runtime_unavailable",
        "Codex usage observation belongs to a stale connection generation.",
        true
      );
    }

    if (event.method === "thread/archived") {
      return this.threadById.delete(event.thread_id);
    }
    if (event.method === "account/rateLimits/updated") {
      this.observeRateLimit(event);
      return true;
    }
    if (event.method === "thread/tokenUsage/updated") {
      return this.observeThread(event);
    }
    return false;
  }

  private observeThread(event: ThreadUsageEvent): boolean {
    const state = this.readStateByThreadId(event.thread_id);
    if (state === null) return false;
    if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
      this.threadById.delete(event.thread_id);
      return false;
    }
    const existing = this.threadById.get(event.thread_id);
    if (existing === undefined && this.threadById.size >= this.options.max_tracked_threads) {
      throw controlError(
        "service_overloaded",
        "service_overloaded",
        "Codex usage observation capacity is exhausted.",
        true
      );
    }
    if (existing !== undefined) assertNewerThreadObservation(existing, event);
    const parsed = usageThreadObservationSchema.safeParse({
      state: "observed",
      scope: "thread",
      observed_at: event.captured_at,
      turn_id: event.turn_id,
      total: event.total,
      last: event.last,
      model_context_window: event.model_context_window
    });
    if (!parsed.success || parsed.data.state !== "observed") {
      throw controlError(
        "runtime_protocol_error",
        "protocol_error",
        "Normalized Codex thread usage is invalid.",
        false,
        parsed.success ? undefined : parsed.error
      );
    }
    this.threadById.set(
      event.thread_id,
      Object.freeze({ observation: deepFreeze(parsed.data), sequence: event.sequence })
    );
    return true;
  }

  private observeRateLimit(event: RateLimitEvent): void {
    if (
      this.rateLimit !== null &&
      (event.sequence <= this.rateLimit.sequence ||
        Date.parse(event.captured_at) < Date.parse(this.rateLimit.observation.observed_at))
    ) {
      throw controlError(
        "observation_conflict",
        "protocol_error",
        "Codex rate-limit observation moved backward or repeated.",
        false
      );
    }
    const parsed = usageRateLimitObservationSchema.safeParse({
      state: "observed",
      scope: "runtime",
      observed_at: event.captured_at,
      primary: event.primary,
      secondary: event.secondary,
      reached_type: event.reached_type
    });
    if (!parsed.success || parsed.data.state !== "observed") {
      throw controlError(
        "runtime_protocol_error",
        "protocol_error",
        "Normalized Codex rate-limit usage is invalid.",
        false,
        parsed.success ? undefined : parsed.error
      );
    }
    this.rateLimit = Object.freeze({ observation: deepFreeze(parsed.data), sequence: event.sequence });
  }

  private async readAccount(signal?: AbortSignal): Promise<CodexAccountUsageRead> {
    try {
      return await this.options.usage.readAccount(signal);
    } catch (error) {
      throw mapAdapterError(error);
    }
  }

  private readActiveGeneration(): number {
    try {
      const generation = this.options.usage.connection_generation;
      return parseGeneration(generation);
    } catch (error) {
      if (error instanceof HostDeckCodexUsageControlError) throw error;
      throw mapAdapterError(error);
    }
  }

  private synchronizeGeneration(generation: number): void {
    if (this.currentGeneration === generation) return;
    this.currentGeneration = generation;
    this.threadById.clear();
    this.rateLimit = null;
  }

  private readStateByThreadId(threadId: string): SelectedSessionState | null {
    try {
      return this.options.states.getByThreadId(threadId);
    } catch (error) {
      throw controlError(
        "state_unavailable",
        "storage_error",
        "Selected state could not resolve the Codex usage thread.",
        true,
        error
      );
    }
  }

  private requireReadableTarget(target: ManagedSessionTarget): SelectedSessionState {
    let state: SelectedSessionState | null;
    try {
      state = this.options.states.get(target.session_id);
    } catch (error) {
      throw controlError(
        "state_unavailable",
        "storage_error",
        "Selected state could not read the Codex usage target.",
        true,
        error
      );
    }
    if (state === null) {
      throw controlError("target_not_found", "session_not_found", "The selected managed session does not exist.", false);
    }
    if (state.mapping.codex_thread_id !== target.codex_thread_id) {
      throw controlError(
        "target_mismatch",
        "invalid_session_id",
        "The selected session and Codex thread identity do not match.",
        false
      );
    }
    if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
      this.threadById.delete(target.codex_thread_id);
      throw controlError("target_not_readable", "session_not_writable", "The selected managed session is archived.", false);
    }
    if (state.mapping.disposition !== "selected" || state.projection.session.freshness !== "current") {
      throw controlError("target_stale", "stale_session", "The selected managed session projection is stale.", true);
    }
    return state;
  }
}

function parseOptions(candidate: unknown): Required<CodexUsageControlServiceOptions> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("Codex usage control options must be a plain object.");
  }
  const value = candidate as Readonly<Record<string, unknown>>;
  const keys = Object.keys(value);
  if (keys.some((key) => !["max_tracked_threads", "states", "usage"].includes(key))) {
    throw new TypeError("Codex usage control option fields are invalid.");
  }
  if (
    value.usage === null ||
    typeof value.usage !== "object" ||
    typeof (value.usage as { readonly readAccount?: unknown }).readAccount !== "function" ||
    !("connection_generation" in value.usage) ||
    value.states === null ||
    typeof value.states !== "object" ||
    typeof (value.states as { readonly get?: unknown }).get !== "function" ||
    typeof (value.states as { readonly getByThreadId?: unknown }).getByThreadId !== "function"
  ) {
    throw new TypeError("Codex usage control requires exact usage and selected-state ports.");
  }
  return Object.freeze({
    usage: value.usage as CodexUsageClient,
    states: value.states as CodexUsageControlStatePort,
    max_tracked_threads: parseCapacity(value.max_tracked_threads)
  });
}

function parseIntent(candidate: unknown): UsageOperationIntent {
  const parsed = usageOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw controlError("invalid_request", "validation_error", "The usage read request is invalid.", true, parsed.error);
  }
  return parsed.data;
}

function parseGeneration(candidate: unknown): number {
  const parsed = positiveSafeIntegerSchema.safeParse(candidate);
  if (!parsed.success) {
    throw controlError(
      "runtime_protocol_error",
      "protocol_error",
      "Codex usage connection generation is invalid.",
      false,
      parsed.error
    );
  }
  return parsed.data;
}

function parseCapacity(candidate: unknown): number {
  const definition = resourceBudgetDefinitionByKey.control_usage_max_tracked_threads;
  const value = candidate ?? defaultResourceBudget.control_usage_max_tracked_threads;
  if (!Number.isSafeInteger(value) || (value as number) < definition.minimum || (value as number) > definition.maximum) {
    throw new TypeError(
      `Codex usage tracked-thread capacity must be between ${definition.minimum} and ${definition.maximum}.`
    );
  }
  return value as number;
}

function assertNewerThreadObservation(existing: ThreadObservationRecord, event: ThreadUsageEvent): void {
  if (
    event.sequence <= existing.sequence ||
    Date.parse(event.captured_at) < Date.parse(existing.observation.observed_at)
  ) {
    throw controlError(
      "observation_conflict",
      "protocol_error",
      "Codex thread usage observation moved backward or repeated.",
      false
    );
  }
  for (const field of tokenFields) {
    if (event.total[field] < existing.observation.total[field]) {
      throw controlError(
        "observation_conflict",
        "protocol_error",
        "Codex cumulative thread usage moved backward.",
        false
      );
    }
  }
}

function notObservedThread(): UsageThreadObservation {
  return Object.freeze({ state: "not_observed", scope: "thread" });
}

function notObservedRateLimit(): UsageRateLimitObservation {
  return Object.freeze({ state: "not_observed", scope: "runtime" });
}

function latestTimestamp(first: string, ...candidates: readonly (string | null)[]): string {
  let latest = first;
  let latestMilliseconds = Date.parse(first);
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const milliseconds = Date.parse(candidate);
    if (milliseconds > latestMilliseconds) {
      latest = candidate;
      latestMilliseconds = milliseconds;
    }
  }
  return latest;
}

function mapAdapterError(error: unknown): HostDeckCodexUsageControlError {
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return controlError("runtime_unavailable", "runtime_unavailable", "Codex usage could not be read.", false, error);
  }
  if (error.code === "unsupported_method") {
    return controlError("capability_unsupported", "capability_unavailable", error.message, false, error);
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    return controlError("runtime_protocol_error", "protocol_error", error.message, false, error);
  }
  if (error.code === "broker_overloaded") {
    return controlError("service_overloaded", "service_overloaded", error.message, error.retry_safe, error);
  }
  return controlError("runtime_unavailable", "runtime_unavailable", error.message, error.retry_safe, error);
}

function controlError(
  code: CodexUsageControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexUsageControlError {
  return new HostDeckCodexUsageControlError(code, apiCode, message, retrySafe, { cause });
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex usage control failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
