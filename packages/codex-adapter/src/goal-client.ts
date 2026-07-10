import { createHash } from "node:crypto";
import {
  codexThreadIdSchema,
  defaultResourceBudget,
  type GoalControlValue,
  goalControlValueSchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey
} from "@hostdeck/contracts";
import type { CodexThreadId, IsoTimestamp } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { ThreadGoalClearParams } from "./generated/v2/ThreadGoalClearParams.js";
import type { ThreadGoalGetParams } from "./generated/v2/ThreadGoalGetParams.js";
import type { ThreadGoalSetParams } from "./generated/v2/ThreadGoalSetParams.js";

export type CodexGoalMutationStatus = "active" | "complete" | "paused";

export interface CodexThreadGoal extends GoalControlValue {
  readonly thread_id: CodexThreadId;
}

export interface CodexGoalRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexGoalClientOptions {
  readonly read_timeout_ms?: number;
  readonly mutation_timeout_ms?: number;
}

export interface CodexGoalClient {
  readonly runtime_version: string;
  readonly read: (threadId: CodexThreadId | string, signal?: AbortSignal) => Promise<CodexThreadGoal | null>;
  readonly setPaused: (
    threadId: CodexThreadId | string,
    objective: string,
    signal?: AbortSignal
  ) => Promise<CodexThreadGoal>;
  readonly setStatus: (
    threadId: CodexThreadId | string,
    status: CodexGoalMutationStatus,
    signal?: AbortSignal
  ) => Promise<CodexThreadGoal>;
  readonly clear: (threadId: CodexThreadId | string, signal?: AbortSignal) => Promise<boolean>;
}

interface ParsedGoalClientOptions {
  readonly read_timeout_ms: number;
  readonly mutation_timeout_ms: number;
}

const defaults = {
  read_timeout_ms: defaultResourceBudget.protocol_read_timeout_ms,
  mutation_timeout_ms: defaultResourceBudget.protocol_mutation_timeout_ms
} as const;

export function createCodexGoalClient(port: CodexGoalRequestPort, options: CodexGoalClientOptions = {}): CodexGoalClient {
  return new DefaultCodexGoalClient(port, parseOptions(options));
}

class DefaultCodexGoalClient implements CodexGoalClient {
  constructor(
    private readonly port: CodexGoalRequestPort,
    private readonly options: ParsedGoalClientOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    const capability = compatibility.capabilities.find((candidate) => candidate.name === "goal");
    if (capability?.state === "unavailable") {
      throw adapterError("unsupported_method", "The connected Codex runtime does not support structured goal control.", "not_sent", false);
    }
    if (
      capability?.state !== "available" ||
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version === null ||
      compatibility.binding_id === null
    ) {
      throw adapterError("handshake_failed", "Codex goal control requires a connected compatible runtime.", "not_sent", true);
    }
    return compatibility.observed_version;
  }

  async read(threadId: CodexThreadId | string, signal?: AbortSignal): Promise<CodexThreadGoal | null> {
    void this.runtime_version;
    const parsedThreadId = parseInputThreadId(threadId);
    const params = { threadId: parsedThreadId } satisfies ThreadGoalGetParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/goal/get",
        params,
        kind: "read",
        timeout_ms: this.options.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex thread/goal/get result must be an object."
    );
    assertExactKeys(result, ["goal"], "Codex thread/goal/get fields are invalid.");
    return result.goal === null ? null : parseGoal(result.goal, parsedThreadId);
  }

  async setPaused(
    threadId: CodexThreadId | string,
    objective: string,
    signal?: AbortSignal
  ): Promise<CodexThreadGoal> {
    const parsedThreadId = parseInputThreadId(threadId);
    const parsedObjective = parseObjectiveInput(objective);
    const params = { threadId: parsedThreadId, objective: parsedObjective, status: "paused" } satisfies ThreadGoalSetParams;
    const goal = await this.set(params, signal);
    if (goal.status !== "paused" || goal.objective !== parsedObjective) {
      throw invalidPayload("Codex thread/goal/set did not preserve the paused objective.");
    }
    return goal;
  }

  async setStatus(
    threadId: CodexThreadId | string,
    status: CodexGoalMutationStatus,
    signal?: AbortSignal
  ): Promise<CodexThreadGoal> {
    const parsedThreadId = parseInputThreadId(threadId);
    if (!["active", "complete", "paused"].includes(status)) throw invalidInput("Codex goal mutation status is unsupported.");
    const params = { threadId: parsedThreadId, status } satisfies ThreadGoalSetParams;
    const goal = await this.set(params, signal);
    if (goal.status !== status) throw invalidPayload("Codex thread/goal/set returned a different goal status.");
    return goal;
  }

  async clear(threadId: CodexThreadId | string, signal?: AbortSignal): Promise<boolean> {
    void this.runtime_version;
    const params = { threadId: parseInputThreadId(threadId) } satisfies ThreadGoalClearParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/goal/clear",
        params,
        kind: "mutation",
        timeout_ms: this.options.mutation_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex thread/goal/clear result must be an object."
    );
    assertExactKeys(result, ["cleared"], "Codex thread/goal/clear fields are invalid.");
    if (typeof result.cleared !== "boolean") throw invalidPayload("Codex thread/goal/clear result is invalid.");
    return result.cleared;
  }

  private async set(params: ThreadGoalSetParams, signal?: AbortSignal): Promise<CodexThreadGoal> {
    void this.runtime_version;
    const result = requireRecord(
      await this.port.request({
        method: "thread/goal/set",
        params,
        kind: "mutation",
        timeout_ms: this.options.mutation_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex thread/goal/set result must be an object."
    );
    assertExactKeys(result, ["goal"], "Codex thread/goal/set fields are invalid.");
    return parseGoal(result.goal, parsePayloadThreadId(params.threadId));
  }
}

function parseGoal(candidate: unknown, expectedThreadId: CodexThreadId): CodexThreadGoal {
  const value = requireRecord(candidate, "Codex thread goal must be an object.");
  assertExactKeys(
    value,
    ["createdAt", "objective", "status", "threadId", "timeUsedSeconds", "tokenBudget", "tokensUsed", "updatedAt"],
    "Codex thread goal fields are invalid."
  );
  const threadId = parsePayloadThreadId(value.threadId);
  if (threadId !== expectedThreadId) throw invalidPayload("Codex thread goal targets a different thread.");
  const createdAt = unixSecondsToIso(value.createdAt, "createdAt");
  const updatedAt = unixSecondsToIso(value.updatedAt, "updatedAt");
  const normalized = {
    objective: parseBoundedText(value.objective, "Codex goal objective", 4_000, false),
    status: parseStatus(value.status),
    token_budget: value.tokenBudget === null ? null : parseNonnegativeInteger(value.tokenBudget, "tokenBudget"),
    tokens_used: parseNonnegativeInteger(value.tokensUsed, "tokensUsed"),
    time_used_seconds: parseNonnegativeNumber(value.timeUsedSeconds, "timeUsedSeconds"),
    created_at: createdAt,
    updated_at: updatedAt
  };
  const parsed = goalControlValueSchema.safeParse({
    revision: goalRevision(normalized),
    ...normalized
  });
  if (!parsed.success) throw invalidPayload("Codex thread goal violates the normalized goal contract.", parsed.error);
  return Object.freeze({ thread_id: threadId, ...parsed.data });
}

function goalRevision(goal: Omit<GoalControlValue, "revision">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        objective: goal.objective,
        status: goal.status,
        token_budget: goal.token_budget,
        created_at: goal.created_at
      })
    )
    .digest("hex");
}

function parseStatus(candidate: unknown): GoalControlValue["status"] {
  if (candidate === "active" || candidate === "paused" || candidate === "blocked" || candidate === "complete") return candidate;
  if (candidate === "usageLimited") return "usage_limited";
  if (candidate === "budgetLimited") return "budget_limited";
  throw invalidPayload("Codex thread goal status is unsupported.");
}

function parseObjectiveInput(candidate: unknown): string {
  const objective = parseBoundedText(candidate, "Codex goal objective", 512, true);
  if (objective.trim().length === 0) throw invalidInput("Codex goal objective cannot be empty.");
  return objective.trim();
}

function unixSecondsToIso(candidate: unknown, field: string): IsoTimestamp {
  const seconds = parseNonnegativeNumber(candidate, field);
  const milliseconds = seconds * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds > 8_640_000_000_000_000) {
    throw invalidPayload(`Codex thread goal ${field} is outside the supported timestamp range.`);
  }
  return new Date(milliseconds).toISOString() as IsoTimestamp;
}

function parseNonnegativeNumber(candidate: unknown, field: string): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw invalidPayload(`Codex thread goal ${field} must be a nonnegative finite number.`);
  }
  return candidate;
}

function parseNonnegativeInteger(candidate: unknown, field: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw invalidPayload(`Codex thread goal ${field} must be a nonnegative safe integer.`);
  }
  return candidate as number;
}

function parseBoundedText(candidate: unknown, label: string, maxLength: number, input: boolean): string {
  const fail = (message: string) => {
    throw input ? invalidInput(message) : invalidPayload(message);
  };
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength) {
    return fail(`${label} must be nonempty bounded text.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if ((code <= 31 && ![9, 10, 13].includes(code)) || code === 127) return fail(`${label} contains an unsupported control character.`);
  }
  return candidate;
}

function parseInputThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex goal target thread id is invalid.", parsed.error);
  return parsed.data;
}

function parsePayloadThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex goal response thread id is invalid.", parsed.error);
  return parsed.data;
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidPayload(message);
  return candidate as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw invalidPayload(message);
}

function parseOptions(options: CodexGoalClientOptions): ParsedGoalClientOptions {
  return {
    read_timeout_ms: parseBoundedInteger(
      options.read_timeout_ms,
      defaults.read_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.maximum,
      "goal read timeout"
    ),
    mutation_timeout_ms: parseBoundedInteger(
      options.mutation_timeout_ms,
      defaults.mutation_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.maximum,
      "goal mutation timeout"
    )
  };
}

function parseBoundedInteger(candidate: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw invalidInput(`Codex ${label} must be a safe integer between ${min} and ${max}.`);
  }
  return candidate;
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
