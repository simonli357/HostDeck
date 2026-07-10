import { createHash } from "node:crypto";
import {
  codexModelContractLimits,
  defaultResourceBudget,
  isoTimestampSchema,
  type PlanMode,
  type PlanModeCatalogEntry,
  planModeCatalogEntrySchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey
} from "@hostdeck/contracts";
import type { ClientOperationId, CodexThreadId, IsoTimestamp } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { CollaborationModeListParams } from "./generated/v2/CollaborationModeListParams.js";
import { type CodexTurnAccepted, type CodexTurnClient, createCodexTurnClient } from "./turn-client.js";

export interface CodexPlanCatalog {
  readonly revision: string;
  readonly observed_at: IsoTimestamp;
  readonly modes: readonly PlanModeCatalogEntry[];
}

export interface CodexPlanTurnStartInput {
  readonly operation_id: ClientOperationId | string;
  readonly thread_id: CodexThreadId | string;
  readonly text: string;
  readonly mode: PlanModeCatalogEntry;
  readonly runtime_model: string;
  readonly reasoning_effort: string | null;
  readonly signal?: AbortSignal;
}

export interface CodexPlanTurnAccepted extends CodexTurnAccepted {}

export interface CodexPlanRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexPlanClientOptions {
  readonly max_entries?: number;
  readonly read_timeout_ms?: number;
  readonly start_timeout_ms?: number;
  readonly now?: () => string;
}

export interface CodexPlanClient {
  readonly runtime_version: string;
  readonly listCatalog: (signal?: AbortSignal) => Promise<CodexPlanCatalog>;
  readonly startTurn: (input: CodexPlanTurnStartInput) => Promise<CodexPlanTurnAccepted>;
}

interface ParsedOptions {
  readonly max_entries: number;
  readonly read_timeout_ms: number;
  readonly start_timeout_ms: number;
  readonly now: () => string;
}

const rawMaskKeys = ["mode", "model", "name", "reasoning_effort"] as const;

export function createCodexPlanClient(port: CodexPlanRequestPort, options: CodexPlanClientOptions = {}): CodexPlanClient {
  return new DefaultCodexPlanClient(port, parseOptions(options));
}

class DefaultCodexPlanClient implements CodexPlanClient {
  private readonly turns: CodexTurnClient;

  constructor(
    private readonly port: CodexPlanRequestPort,
    private readonly options: ParsedOptions
  ) {
    this.turns = createCodexTurnClient(port, { start_timeout_ms: options.start_timeout_ms });
  }

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    const capability = compatibility.capabilities.find((candidate) => candidate.name === "plan");
    if (capability?.state === "unavailable") {
      throw adapterError("unsupported_method", "The connected Codex runtime does not support structured Plan control.", "not_sent", false);
    }
    if (
      capability?.state !== "available" ||
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version === null ||
      compatibility.binding_id === null
    ) {
      throw adapterError("handshake_failed", "Codex Plan control requires a connected compatible runtime.", "not_sent", true);
    }
    return compatibility.observed_version;
  }

  async listCatalog(signal?: AbortSignal): Promise<CodexPlanCatalog> {
    void this.runtime_version;
    const params = {} satisfies CollaborationModeListParams;
    const result = requireRecord(
      await this.port.request({
        method: "collaborationMode/list",
        params,
        kind: "read",
        timeout_ms: this.options.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex collaborationMode/list result must be an object."
    );
    assertExactKeys(result, ["data"], "Codex collaborationMode/list fields are invalid.");
    if (!Array.isArray(result.data) || result.data.length < 2 || result.data.length > this.options.max_entries) {
      throw invalidPayload("Codex collaboration catalog violates the configured entry bound.");
    }
    const modes = result.data.map(parseMask);
    validateCatalog(modes);
    const observedAt = parseTimestamp(this.options.now());
    return Object.freeze({
      revision: createHash("sha256").update(JSON.stringify(modes)).digest("hex"),
      observed_at: observedAt,
      modes: Object.freeze(modes.map((mode) => Object.freeze({ ...mode })))
    });
  }

  async startTurn(input: CodexPlanTurnStartInput): Promise<CodexPlanTurnAccepted> {
    void this.runtime_version;
    const mode = parseInputMode(input.mode);
    return this.turns.startTurn({
      operation_id: input.operation_id,
      thread_id: input.thread_id,
      text: input.text,
      settings: {
        kind: "collaboration",
        mode: mode.mode,
        runtime_model: input.runtime_model,
        reasoning_effort: input.reasoning_effort
      },
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  }
}

function parseMask(candidate: unknown): PlanModeCatalogEntry {
  const value = requireRecord(candidate, "Codex collaboration catalog entry must be an object.");
  assertExactKeys(value, rawMaskKeys, "Codex collaboration catalog entry fields are invalid.");
  const name = parsePayloadPrintableString(value.name, "Codex collaboration mode name", 80);
  const namedMode = normalizedModeName(name);
  const explicitMode = value.mode === null ? null : parseMode(value.mode);
  if (explicitMode !== null && namedMode !== null && explicitMode !== namedMode) {
    throw invalidPayload("Codex collaboration mode name contradicts its explicit mode.");
  }
  const mode = explicitMode ?? namedMode;
  if (mode === null) throw invalidPayload("Codex collaboration catalog entry has no recognized mode.");
  const parsed = planModeCatalogEntrySchema.safeParse({
    name,
    mode,
    preset_model:
      value.model === null
        ? null
        : parsePayloadPrintableString(
            value.model,
            "Codex collaboration preset model",
            codexModelContractLimits.identityLength
          ),
    preset_reasoning_effort:
      value.reasoning_effort === null
        ? null
        : parsePayloadPrintableString(
            value.reasoning_effort,
            "Codex collaboration preset reasoning effort",
            codexModelContractLimits.reasoningEffortLength
          )
  });
  if (!parsed.success) throw invalidPayload("Codex collaboration mode does not satisfy the normalized Plan contract.", parsed.error);
  return parsed.data;
}

function validateCatalog(modes: readonly PlanModeCatalogEntry[]): void {
  if (new Set(modes.map((entry) => entry.name.toLowerCase())).size !== modes.length) {
    throw invalidPayload("Codex collaboration catalog contains duplicate names.");
  }
  if (new Set(modes.map((entry) => entry.mode)).size !== modes.length) {
    throw invalidPayload("Codex collaboration catalog contains duplicate modes.");
  }
  if (!modes.some((entry) => entry.mode === "plan") || !modes.some((entry) => entry.mode === "default")) {
    throw invalidPayload("Codex collaboration catalog must expose both Plan and Default modes.");
  }
}

function parseInputMode(candidate: unknown): PlanModeCatalogEntry {
  const parsed = planModeCatalogEntrySchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex Plan turn mode is invalid.", parsed.error);
  return parsed.data;
}

function normalizedModeName(name: string): PlanMode | null {
  const normalized = name.trim().toLowerCase();
  return normalized === "plan" || normalized === "default" ? normalized : null;
}

function parseMode(candidate: unknown): PlanMode {
  if (candidate !== "plan" && candidate !== "default") throw invalidPayload("Codex collaboration mode is invalid.");
  return candidate;
}

function parseOptions(options: CodexPlanClientOptions): ParsedOptions {
  if (options.now !== undefined && typeof options.now !== "function") throw invalidInput("Codex Plan clock must be a function.");
  return {
    max_entries: parseBoundedInteger(
      options.max_entries,
      defaultResourceBudget.protocol_collaboration_max_entries,
      resourceBudgetDefinitionByKey.protocol_collaboration_max_entries.minimum,
      resourceBudgetDefinitionByKey.protocol_collaboration_max_entries.maximum,
      "collaboration entry bound"
    ),
    read_timeout_ms: parseBoundedInteger(
      options.read_timeout_ms,
      defaultResourceBudget.protocol_read_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.maximum,
      "Plan read timeout"
    ),
    start_timeout_ms: parseBoundedInteger(
      options.start_timeout_ms,
      defaultResourceBudget.protocol_start_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.maximum,
      "Plan turn-start timeout"
    ),
    now: options.now ?? (() => new Date().toISOString())
  };
}

function parseBoundedInteger(candidate: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw invalidInput(`Codex ${label} must be a safe integer between ${min} and ${max}.`);
  }
  return candidate;
}

function parseTimestamp(candidate: unknown): IsoTimestamp {
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex Plan clock returned an invalid timestamp.", parsed.error);
  return parsed.data;
}

function parsePayloadPrintableString(candidate: unknown, label: string, maxLength: number): string {
  return parsePrintableString(candidate, label, maxLength, invalidPayload);
}

function parsePrintableString(
  candidate: unknown,
  label: string,
  maxLength: number,
  errorFactory: (message: string, cause?: unknown) => HostDeckCodexAdapterError
): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength || candidate !== candidate.trim()) {
    throw errorFactory(`${label} must be a bounded non-whitespace-padded string.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw errorFactory(`${label} contains a control character.`);
  }
  return candidate;
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidPayload(message);
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
