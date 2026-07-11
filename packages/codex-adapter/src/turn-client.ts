import {
  clientOperationIdSchema,
  codexModelContractLimits,
  codexThreadIdSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey
} from "@hostdeck/contracts";
import type { ClientOperationId, CodexThreadId, CodexTurnId } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.js";

export type CodexTurnStartSettings =
  | { readonly kind: "inherit" }
  | { readonly kind: "model"; readonly runtime_model: string; readonly reasoning_effort: string }
  | {
      readonly kind: "collaboration";
      readonly mode: "default" | "plan";
      readonly runtime_model: string;
      readonly reasoning_effort: string | null;
    };

export interface CodexTurnStartInput {
  readonly operation_id: ClientOperationId | string;
  readonly thread_id: CodexThreadId | string;
  readonly text: string;
  readonly settings: CodexTurnStartSettings;
  readonly signal?: AbortSignal;
}

export interface CodexTurnSteerInput {
  readonly operation_id: ClientOperationId | string;
  readonly thread_id: CodexThreadId | string;
  readonly expected_turn_id: CodexTurnId | string;
  readonly text: string;
  readonly signal?: AbortSignal;
}

export interface CodexTurnInterruptInput {
  readonly operation_id: ClientOperationId | string;
  readonly thread_id: CodexThreadId | string;
  readonly turn_id: CodexTurnId | string;
  readonly signal?: AbortSignal;
}

export interface CodexTurnAccepted {
  readonly thread_id: CodexThreadId;
  readonly turn_id: CodexTurnId;
  readonly state: "accepted";
}

export interface CodexTurnSteered {
  readonly thread_id: CodexThreadId;
  readonly turn_id: CodexTurnId;
  readonly state: "accepted";
}

export interface CodexTurnInterruptAccepted {
  readonly thread_id: CodexThreadId;
  readonly turn_id: CodexTurnId;
  readonly state: "accepted";
}

export interface CodexTurnRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexTurnClientOptions {
  readonly interrupt_timeout_ms?: number;
  readonly start_timeout_ms?: number;
  readonly steer_timeout_ms?: number;
}

export interface CodexTurnClient {
  readonly runtime_version: string;
  readonly interruptTurn: (input: CodexTurnInterruptInput) => Promise<CodexTurnInterruptAccepted>;
  readonly startTurn: (input: CodexTurnStartInput) => Promise<CodexTurnAccepted>;
  readonly steerTurn: (input: CodexTurnSteerInput) => Promise<CodexTurnSteered>;
}

interface ParsedOptions {
  readonly interrupt_timeout_ms: number;
  readonly start_timeout_ms: number;
  readonly steer_timeout_ms: number;
}

export function createCodexTurnClient(port: CodexTurnRequestPort, options: CodexTurnClientOptions = {}): CodexTurnClient {
  if (port === null || typeof port !== "object" || typeof port.request !== "function") {
    throw new TypeError("Codex turn client requires a compatibility-aware request port.");
  }
  return new DefaultCodexTurnClient(port, parseOptions(options));
}

class DefaultCodexTurnClient implements CodexTurnClient {
  constructor(
    private readonly port: CodexTurnRequestPort,
    private readonly options: ParsedOptions
  ) {}

  get runtime_version(): string {
    return requireRuntime(this.port.compatibility, "turn_input", "turn input");
  }

  async interruptTurn(input: CodexTurnInterruptInput): Promise<CodexTurnInterruptAccepted> {
    requireRuntime(this.port.compatibility, "turn_interrupt", "turn interrupt");
    const candidate = parseInputRecord(input, ["operation_id", "thread_id", "turn_id"], ["signal"], "turn-interrupt");
    parseOperationId(candidate.operation_id);
    const threadId = parseThreadId(candidate.thread_id, "turn-interrupt target");
    const turnId = parseInputTurnId(candidate.turn_id, "interrupt target");
    const signal = parseSignal(candidate.signal);
    const params = { threadId, turnId } satisfies TurnInterruptParams;
    const result = requireRecord(
      await this.port.request({
        method: "turn/interrupt",
        params,
        kind: "mutation",
        timeout_ms: this.options.interrupt_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex turn/interrupt result must be an object."
    );
    assertExactKeys(result, [], "Codex turn/interrupt response must be the exact empty object.");
    return Object.freeze({ thread_id: threadId, turn_id: turnId, state: "accepted" });
  }

  async startTurn(input: CodexTurnStartInput): Promise<CodexTurnAccepted> {
    void this.runtime_version;
    const candidate = parseInputRecord(input, ["operation_id", "settings", "text", "thread_id"], ["signal"], "turn-start");
    const operationId = parseOperationId(candidate.operation_id);
    const threadId = parseThreadId(candidate.thread_id, "turn-start target");
    const text = parsePromptText(candidate.text);
    const signal = parseSignal(candidate.signal);
    const params = {
      threadId,
      clientUserMessageId: operationId,
      input: [{ type: "text", text, text_elements: [] }],
      ...settingsParams(candidate.settings as CodexTurnStartSettings)
    } satisfies TurnStartParams;
    const result = requireRecord(
      await this.port.request({
        method: "turn/start",
        params,
        kind: "mutation",
        timeout_ms: this.options.start_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex turn/start result must be an object."
    );
    return parseAcceptedTurn(result, threadId);
  }

  async steerTurn(input: CodexTurnSteerInput): Promise<CodexTurnSteered> {
    requireRuntime(this.port.compatibility, "turn_steer", "turn steer");
    const candidate = parseInputRecord(
      input,
      ["expected_turn_id", "operation_id", "text", "thread_id"],
      ["signal"],
      "turn-steer"
    );
    const operationId = parseOperationId(candidate.operation_id);
    const threadId = parseThreadId(candidate.thread_id, "turn-steer target");
    const expectedTurnId = parseInputTurnId(candidate.expected_turn_id, "expected");
    const text = parsePromptText(candidate.text);
    const signal = parseSignal(candidate.signal);
    const params = {
      threadId,
      expectedTurnId,
      clientUserMessageId: operationId,
      input: [{ type: "text", text, text_elements: [] }]
    } satisfies TurnSteerParams;
    const result = requireRecord(
      await this.port.request({
        method: "turn/steer",
        params,
        kind: "mutation",
        timeout_ms: this.options.steer_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex turn/steer result must be an object."
    );
    assertExactKeys(result, ["turnId"], "Codex turn/steer fields are invalid.");
    const turnId = parsePayloadTurnId(result.turnId);
    if (turnId !== expectedTurnId) throw invalidPayload("Codex turn/steer returned a different turn id.");
    return Object.freeze({ thread_id: threadId, turn_id: turnId, state: "accepted" });
  }
}

function settingsParams(settings: CodexTurnStartSettings): Partial<TurnStartParams> {
  if (settings === null || typeof settings !== "object") throw invalidInput("Codex turn settings are invalid.");
  if (settings.kind === "inherit") {
    if (Object.keys(settings).length !== 1) throw invalidInput("Inherited Codex turn settings contain unsupported fields.");
    return {};
  }
  if (settings.kind === "model") {
    if (Object.keys(settings).sort().join(",") !== "kind,reasoning_effort,runtime_model") {
      throw invalidInput("Model Codex turn settings contain unsupported fields.");
    }
    return {
      model: parsePrintableString(settings.runtime_model, "Codex selected model", codexModelContractLimits.identityLength),
      effort: parsePrintableString(
        settings.reasoning_effort,
        "Codex selected reasoning effort",
        codexModelContractLimits.reasoningEffortLength
      )
    };
  }
  if (settings.kind === "collaboration") {
    if (Object.keys(settings).sort().join(",") !== "kind,mode,reasoning_effort,runtime_model") {
      throw invalidInput("Collaboration Codex turn settings contain unsupported fields.");
    }
    if (settings.mode !== "default" && settings.mode !== "plan") {
      throw invalidInput("Codex collaboration mode is invalid.");
    }
    return {
      collaborationMode: {
        mode: settings.mode,
        settings: {
          model: parsePrintableString(
            settings.runtime_model,
            "Codex collaboration model",
            codexModelContractLimits.identityLength
          ),
          reasoning_effort:
            settings.reasoning_effort === null
              ? null
              : parsePrintableString(
                  settings.reasoning_effort,
                  "Codex collaboration reasoning effort",
                  codexModelContractLimits.reasoningEffortLength
                ),
          developer_instructions: null
        }
      }
    };
  }
  throw invalidInput("Codex turn settings kind is invalid.");
}

function parseAcceptedTurn(result: Record<string, unknown>, threadId: CodexThreadId): CodexTurnAccepted {
  assertExactKeys(result, ["turn"], "Codex turn/start fields are invalid.");
  const turn = requireRecord(result.turn, "Codex turn/start turn must be an object.");
  assertExactKeys(
    turn,
    ["completedAt", "durationMs", "error", "id", "items", "itemsView", "startedAt", "status"],
    "Codex turn/start turn fields are invalid."
  );
  const turnId = parsePayloadTurnId(turn.id);
  if (turn.status !== "inProgress" || turn.error !== null || turn.completedAt !== null || turn.durationMs !== null) {
    throw invalidPayload("Codex turn/start did not return the accepted in-progress turn shape.");
  }
  if (!Array.isArray(turn.items) || turn.items.length > 256 || !["notLoaded", "summary", "full"].includes(turn.itemsView as string)) {
    throw invalidPayload("Codex turn/start returned an invalid bounded item view.");
  }
  if (turn.startedAt !== null && (!Number.isFinite(turn.startedAt) || (turn.startedAt as number) < 0)) {
    throw invalidPayload("Codex turn/start returned an invalid start timestamp.");
  }
  return Object.freeze({ thread_id: threadId, turn_id: turnId, state: "accepted" });
}

function requireRuntime(
  compatibility: RuntimeCompatibility,
  capabilityName: "turn_input" | "turn_interrupt" | "turn_steer",
  label: string
): string {
  const capability = compatibility.capabilities.find((candidate) => candidate.name === capabilityName);
  if (capability?.state === "unavailable") {
    throw adapterError("unsupported_method", `The connected Codex runtime does not support structured ${label}.`, "not_sent", false);
  }
  if (
    capability?.state !== "available" ||
    !["degraded", "ready"].includes(compatibility.state) ||
    compatibility.mutation_policy !== "allowed" ||
    compatibility.observed_version === null ||
    compatibility.binding_id === null
  ) {
    throw adapterError("handshake_failed", `Codex ${label} requires a connected compatible runtime.`, "not_sent", true);
  }
  return compatibility.observed_version;
}

function parseOptions(options: CodexTurnClientOptions): ParsedOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Codex turn client options must be an object.");
  }
  const unsupported = Object.keys(options).filter(
    (key) => !["interrupt_timeout_ms", "start_timeout_ms", "steer_timeout_ms"].includes(key)
  );
  if (unsupported.length > 0) throw invalidInput("Codex turn client options contain unsupported fields.");
  return {
    interrupt_timeout_ms: parseBoundedInteger(
      options.interrupt_timeout_ms,
      defaultResourceBudget.protocol_mutation_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.maximum,
      "turn-interrupt timeout"
    ),
    start_timeout_ms: parseBoundedInteger(
      options.start_timeout_ms,
      defaultResourceBudget.protocol_start_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.maximum,
      "turn-start timeout"
    ),
    steer_timeout_ms: parseBoundedInteger(
      options.steer_timeout_ms,
      defaultResourceBudget.protocol_mutation_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.maximum,
      "turn-steer timeout"
    )
  };
}

function parseInputRecord(
  candidate: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw invalidInput(`Codex ${label} input must be an object.`);
  }
  const value = candidate as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const allowed = [...requiredKeys, ...optionalKeys].sort();
  if (actual.some((key) => !allowed.includes(key)) || requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw invalidInput(`Codex ${label} input fields are invalid.`);
  }
  return value;
}

function parseSignal(candidate: unknown): AbortSignal | undefined {
  if (candidate === undefined) return undefined;
  if (!(candidate instanceof AbortSignal)) throw invalidInput("Codex turn signal must be an AbortSignal.");
  return candidate;
}

function parseBoundedInteger(candidate: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw invalidInput(`Codex ${label} must be a safe integer between ${min} and ${max}.`);
  }
  return candidate;
}

function parseOperationId(candidate: unknown): ClientOperationId {
  const parsed = clientOperationIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex turn operation id is invalid.", parsed.error);
  return parsed.data;
}

function parseThreadId(candidate: unknown, label: string): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput(`Codex ${label} thread id is invalid.`, parsed.error);
  return parsed.data;
}

function parseInputTurnId(candidate: unknown, label: string): CodexTurnId {
  const parsed = codexTurnIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput(`Codex ${label} turn id is invalid.`, parsed.error);
  return parsed.data;
}

function parsePayloadTurnId(candidate: unknown): CodexTurnId {
  const parsed = codexTurnIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex response turn id is invalid.", parsed.error);
  return parsed.data;
}

function parsePromptText(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > 20_000) {
    throw invalidInput("Codex turn text must contain 1 to 20,000 characters.");
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if ((code <= 31 && ![9, 10, 13].includes(code)) || code === 127) {
      throw invalidInput("Codex turn text contains an unsupported control character.");
    }
  }
  return candidate;
}

function parsePrintableString(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength || candidate !== candidate.trim()) {
    throw invalidInput(`${label} must be a bounded non-whitespace-padded string.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw invalidInput(`${label} contains a control character.`);
  }
  return candidate;
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidPayload(message);
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) throw invalidPayload(message);
  return candidate as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw invalidPayload(message);
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
