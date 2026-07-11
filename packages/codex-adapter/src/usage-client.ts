import {
  defaultResourceBudget,
  isoTimestampSchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey,
  type UsageAccountSnapshot,
  usageAccountSnapshotSchema,
  usageCalendarDateSchema
} from "@hostdeck/contracts";
import type { IsoTimestamp } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";

export interface CodexAccountUsageRead {
  readonly runtime_version: string;
  readonly connection_generation: number;
  readonly observed_at: IsoTimestamp;
  readonly account: UsageAccountSnapshot;
}

export interface CodexUsageRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly generation: number;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexUsageClientOptions {
  readonly max_daily_buckets?: number;
  readonly read_timeout_ms?: number;
  readonly now?: () => string;
}

export interface CodexUsageClient {
  readonly runtime_version: string;
  readonly connection_generation: number;
  readonly readAccount: (signal?: AbortSignal) => Promise<CodexAccountUsageRead>;
}

interface ParsedOptions {
  readonly max_daily_buckets: number;
  readonly read_timeout_ms: number;
  readonly now: () => string;
}

const summaryKeys = [
  "currentStreakDays",
  "lifetimeTokens",
  "longestRunningTurnSec",
  "longestStreakDays",
  "peakDailyTokens"
] as const;

export function createCodexUsageClient(port: CodexUsageRequestPort, options: CodexUsageClientOptions = {}): CodexUsageClient {
  const implementation = new DefaultCodexUsageClient(parsePort(port), parseOptions(options));
  return Object.freeze({
    readAccount: (signal?: AbortSignal) => implementation.readAccount(signal),
    get runtime_version() {
      return implementation.runtime_version;
    },
    get connection_generation() {
      return implementation.connection_generation;
    }
  });
}

class DefaultCodexUsageClient implements CodexUsageClient {
  constructor(
    private readonly port: CodexUsageRequestPort,
    private readonly options: ParsedOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    const capability = compatibility.capabilities.find((candidate) => candidate.name === "usage");
    if (capability?.state === "unavailable") {
      throw adapterError(
        "unsupported_method",
        "The connected Codex runtime does not support structured usage reads.",
        "not_sent",
        false
      );
    }
    if (
      capability?.state !== "available" ||
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version === null ||
      compatibility.binding_id === null
    ) {
      throw adapterError(
        "handshake_failed",
        "Codex usage reads require a connected compatible runtime.",
        "not_sent",
        true
      );
    }
    return compatibility.observed_version;
  }

  get connection_generation(): number {
    const generation = this.port.generation;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw adapterError(
        "protocol_violation",
        "Codex usage connection generation is invalid.",
        "not_applicable",
        false
      );
    }
    return generation;
  }

  async readAccount(signal?: AbortSignal): Promise<CodexAccountUsageRead> {
    const runtimeVersion = this.runtime_version;
    const generation = this.connection_generation;
    const result = await this.port.request({
      method: "account/usage/read",
      params: undefined,
      kind: "read",
      timeout_ms: this.options.read_timeout_ms,
      ...(signal === undefined ? {} : { signal })
    });
    if (this.connection_generation !== generation) {
      throw adapterError(
        "transport_closed",
        "Codex usage connection changed while the account snapshot was in flight.",
        "not_applicable",
        true
      );
    }
    const observedAt = parseClock(this.options.now());
    return deepFreeze({
      runtime_version: runtimeVersion,
      connection_generation: generation,
      observed_at: observedAt,
      account: parseAccountUsage(result, this.options.max_daily_buckets)
    });
  }
}

function parseAccountUsage(candidate: unknown, maximumBuckets: number): UsageAccountSnapshot {
  const value = requireRecord(candidate, "Codex account/usage/read result must be an object.");
  assertExactKeys(value, ["dailyUsageBuckets", "summary"], "Codex account usage fields are invalid.");
  const summary = requireRecord(value.summary, "Codex account usage summary must be an object.");
  assertExactKeys(summary, summaryKeys, "Codex account usage summary fields are invalid.");

  let dailyBuckets: Array<{ readonly start_date: string; readonly tokens: number }> | null = null;
  if (value.dailyUsageBuckets !== null) {
    if (!Array.isArray(value.dailyUsageBuckets)) {
      throw invalidPayload("Codex account usage daily buckets must be an array or null.");
    }
    if (value.dailyUsageBuckets.length > maximumBuckets) {
      throw adapterError(
        "broker_overloaded",
        "Codex account usage daily buckets exceed the configured bound.",
        "not_applicable",
        false
      );
    }
    dailyBuckets = value.dailyUsageBuckets.map((candidate) => {
      const bucket = requireRecord(candidate, "Codex account usage bucket must be an object.");
      assertExactKeys(bucket, ["startDate", "tokens"], "Codex account usage bucket fields are invalid.");
      const date = usageCalendarDateSchema.safeParse(bucket.startDate);
      if (!date.success) throw invalidPayload("Codex account usage bucket date is invalid.", date.error);
      return Object.freeze({
        start_date: date.data,
        tokens: parseCounter(bucket.tokens, "Codex account usage bucket tokens")
      });
    });
  }

  const parsed = usageAccountSnapshotSchema.safeParse({
    scope: "account",
    summary: {
      lifetime_tokens: parseNullableCounter(summary.lifetimeTokens, "Codex account lifetime tokens"),
      peak_daily_tokens: parseNullableCounter(summary.peakDailyTokens, "Codex account peak daily tokens"),
      longest_running_turn_seconds: parseNullableCounter(
        summary.longestRunningTurnSec,
        "Codex account longest-running turn"
      ),
      current_streak_days: parseNullableCounter(summary.currentStreakDays, "Codex account current streak"),
      longest_streak_days: parseNullableCounter(summary.longestStreakDays, "Codex account longest streak")
    },
    daily_buckets: dailyBuckets
  });
  if (!parsed.success) throw invalidPayload("Codex account usage values are internally inconsistent.", parsed.error);
  return deepFreeze(parsed.data);
}

function parsePort(candidate: unknown): CodexUsageRequestPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    typeof (candidate as { readonly request?: unknown }).request !== "function" ||
    !("compatibility" in candidate) ||
    !("generation" in candidate)
  ) {
    throw new TypeError("Codex usage client requires an exact connection request port.");
  }
  return candidate as CodexUsageRequestPort;
}

function parseOptions(candidate: unknown): ParsedOptions {
  const value = requirePlainRecord(candidate, "Codex usage options must be a plain object.");
  assertExactOptionKeys(value, ["max_daily_buckets", "now", "read_timeout_ms"]);
  if (value.now !== undefined && typeof value.now !== "function") {
    throw invalidInput("Codex usage clock must be a function.");
  }
  return Object.freeze({
    max_daily_buckets: parseBoundedInteger(
      value.max_daily_buckets,
      defaultResourceBudget.protocol_usage_max_daily_buckets,
      resourceBudgetDefinitionByKey.protocol_usage_max_daily_buckets.minimum,
      resourceBudgetDefinitionByKey.protocol_usage_max_daily_buckets.maximum,
      "daily bucket bound"
    ),
    read_timeout_ms: parseBoundedInteger(
      value.read_timeout_ms,
      defaultResourceBudget.protocol_read_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.maximum,
      "read timeout"
    ),
    now: (value.now as (() => string) | undefined) ?? (() => new Date().toISOString())
  });
}

function parseClock(candidate: unknown): IsoTimestamp {
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex usage clock returned an invalid timestamp.", parsed.error);
  return parsed.data;
}

function parseNullableCounter(candidate: unknown, label: string): number | null {
  return candidate === null ? null : parseCounter(candidate, label);
}

function parseCounter(candidate: unknown, label: string): number {
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw invalidPayload(`${label} must be a non-negative safe integer.`);
  }
  return candidate;
}

function parseBoundedInteger(
  candidate: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const value = candidate ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidInput(`Codex usage ${label} must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function requireRecord(candidate: unknown, message: string): Readonly<Record<string, unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidPayload(message);
  return candidate as Readonly<Record<string, unknown>>;
}

function requirePlainRecord(candidate: unknown, message: string): Readonly<Record<string, unknown>> {
  const value = requireRecord(candidate, message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput(message);
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  message: string
): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw invalidPayload(message);
}

function assertExactOptionKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidInput("Codex usage option fields are invalid.");
}

function invalidInput(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return adapterError("invalid_protocol_message", message, "not_sent", true, cause);
}

function invalidPayload(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return adapterError("invalid_protocol_message", message, "not_applicable", false, cause);
}

function adapterError(
  code: HostDeckCodexAdapterError["code"],
  message: string,
  outcome: HostDeckCodexAdapterError["outcome"],
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, { outcome, retry_safe: retrySafe, cause });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
