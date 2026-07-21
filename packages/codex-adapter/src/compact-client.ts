import {
  clientOperationIdSchema,
  codexThreadIdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey
} from "@hostdeck/contracts";
import type {
  ClientOperationId,
  CodexThreadId,
  IsoTimestamp,
  OperationDeadline
} from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { ThreadCompactStartParams } from "./generated/v2/ThreadCompactStartParams.js";
import { codexRequestOptionsFromDeadline } from "./request-deadline.js";

export interface CodexCompactInput {
  readonly operation_id: ClientOperationId | string;
  readonly thread_id: CodexThreadId | string;
  readonly deadline?: OperationDeadline;
}

export interface CodexCompactAccepted {
  readonly runtime_version: string;
  readonly connection_generation: number;
  readonly thread_id: CodexThreadId;
  readonly state: "accepted";
  readonly accepted_at: IsoTimestamp;
}

export interface CodexCompactRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly generation: number;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexCompactClientOptions {
  readonly mutation_timeout_ms?: number;
  readonly now?: () => string;
}

export interface CodexCompactClient {
  readonly runtime_version: string;
  readonly connection_generation: number;
  readonly compactThread: (input: CodexCompactInput) => Promise<CodexCompactAccepted>;
}

interface ParsedOptions {
  readonly mutation_timeout_ms: number;
  readonly now: () => string;
}

export function createCodexCompactClient(
  port: CodexCompactRequestPort,
  options: CodexCompactClientOptions = {}
): CodexCompactClient {
  const implementation = new DefaultCodexCompactClient(parsePort(port), parseOptions(options));
  return Object.freeze({
    compactThread: (input: CodexCompactInput) => implementation.compactThread(input),
    get runtime_version() {
      return implementation.runtime_version;
    },
    get connection_generation() {
      return implementation.connection_generation;
    }
  });
}

class DefaultCodexCompactClient implements CodexCompactClient {
  constructor(
    private readonly port: CodexCompactRequestPort,
    private readonly options: ParsedOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    const capability = compatibility.capabilities.find((candidate) => candidate.name === "compact");
    if (capability?.state === "unavailable") {
      throw adapterError(
        "unsupported_method",
        "The connected Codex runtime does not support structured compaction.",
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
        "Codex compaction requires a connected compatible runtime.",
        "not_sent",
        true
      );
    }
    return compatibility.observed_version;
  }

  get connection_generation(): number {
    return parseGeneration(this.port.generation, "not_sent");
  }

  async compactThread(input: CodexCompactInput): Promise<CodexCompactAccepted> {
    const runtimeVersion = this.runtime_version;
    const generation = this.connection_generation;
    const candidate = parseInput(input);
    parseOperationId(candidate.operation_id);
    const threadId = parseThreadId(candidate.thread_id);
    const params = { threadId } satisfies ThreadCompactStartParams;
    const result = await this.port.request({
      method: "thread/compact/start",
      params,
      kind: "mutation",
      ...codexRequestOptionsFromDeadline(
        candidate.deadline,
        this.options.mutation_timeout_ms
      )
    });
    const currentGeneration = this.port.generation;
    if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1 || currentGeneration !== generation) {
      throw adapterError(
        "transport_closed",
        "Codex connection changed while compaction acceptance was in flight.",
        "unknown",
        false
      );
    }
    const response = requirePlainRecord(
      result,
      "Codex thread/compact/start result must be the exact empty object.",
      "unknown"
    );
    assertExactKeys(response, [], "Codex thread/compact/start response fields are invalid.");
    return Object.freeze({
      runtime_version: runtimeVersion,
      connection_generation: generation,
      thread_id: threadId,
      state: "accepted",
      accepted_at: parsePostSendClock(this.options.now())
    });
  }
}

function parsePort(candidate: unknown): CodexCompactRequestPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    typeof (candidate as { readonly request?: unknown }).request !== "function" ||
    !("compatibility" in candidate) ||
    !("generation" in candidate)
  ) {
    throw new TypeError("Codex compact client requires an exact connection request port.");
  }
  return candidate as CodexCompactRequestPort;
}

function parseOptions(candidate: unknown): ParsedOptions {
  const value = requirePlainRecord(candidate, "Codex compact options must be a plain object.", "not_sent");
  const allowed = new Set(["mutation_timeout_ms", "now"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidInput("Codex compact option fields are invalid.");
  }
  if (value.now !== undefined && typeof value.now !== "function") {
    throw invalidInput("Codex compact clock must be a function.");
  }
  const definition = resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms;
  const timeout = value.mutation_timeout_ms ?? defaultResourceBudget.protocol_mutation_timeout_ms;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < definition.minimum || (timeout as number) > definition.maximum) {
    throw invalidInput(
      `Codex compact mutation timeout must be a safe integer between ${definition.minimum} and ${definition.maximum}.`
    );
  }
  return Object.freeze({
    mutation_timeout_ms: timeout as number,
    now: (value.now as (() => string) | undefined) ?? (() => new Date().toISOString())
  });
}

function parseInput(candidate: unknown): Readonly<Record<string, unknown>> {
  const value = requirePlainRecord(candidate, "Codex compact input must be a plain object.", "not_sent");
  const keys = Object.keys(value).sort();
  if (
    keys.some((key) => !["deadline", "operation_id", "thread_id"].includes(key)) ||
    !Object.hasOwn(value, "operation_id") ||
    !Object.hasOwn(value, "thread_id")
  ) {
    throw invalidInput("Codex compact input fields are invalid.");
  }
  return value;
}

function parseOperationId(candidate: unknown): ClientOperationId {
  const parsed = clientOperationIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex compact operation id is invalid.", parsed.error);
  return parsed.data;
}

function parseThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex compact thread id is invalid.", parsed.error);
  return parsed.data;
}

function parseGeneration(candidate: unknown, outcome: "not_sent" | "unknown"): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw adapterError(
      "protocol_violation",
      "Codex compact connection generation is invalid.",
      outcome,
      outcome === "not_sent"
    );
  }
  return candidate as number;
}

function parsePostSendClock(candidate: unknown): IsoTimestamp {
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) {
    throw adapterError(
      "invalid_protocol_message",
      "Codex compact clock returned an invalid timestamp after dispatch.",
      "unknown",
      false,
      parsed.error
    );
  }
  return parsed.data;
}

function requirePlainRecord(
  candidate: unknown,
  message: string,
  outcome: "not_sent" | "unknown"
): Readonly<Record<string, unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw adapterError("invalid_protocol_message", message, outcome, outcome === "not_sent");
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw adapterError("invalid_protocol_message", message, outcome, outcome === "not_sent");
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[], message: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw adapterError("invalid_protocol_message", message, "unknown", false);
  }
}

function invalidInput(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return adapterError("invalid_protocol_message", message, "not_sent", true, cause);
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
