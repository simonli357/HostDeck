import { createHash } from "node:crypto";
import {
  clientOperationIdSchema,
  codexThreadIdSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type ModelCatalogEntry,
  modelCatalogEntrySchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey
} from "@hostdeck/contracts";
import type { ClientOperationId, CodexThreadId, CodexTurnId, IsoTimestamp } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";

export interface CodexModelCatalog {
  readonly revision: string;
  readonly observed_at: IsoTimestamp;
  readonly models: readonly ModelCatalogEntry[];
}

export interface CodexThreadModelState {
  readonly thread_id: CodexThreadId;
  readonly runtime_model: string;
  readonly reasoning_effort: string | null;
}

export interface CodexModelTurnStartInput {
  readonly operation_id: ClientOperationId | string;
  readonly thread_id: CodexThreadId | string;
  readonly text: string;
  readonly runtime_model: string;
  readonly reasoning_effort: string;
  readonly signal?: AbortSignal;
}

export interface CodexModelTurnAccepted {
  readonly thread_id: CodexThreadId;
  readonly turn_id: CodexTurnId;
  readonly state: "accepted";
}

export interface CodexModelRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexModelClientOptions {
  readonly page_size?: number;
  readonly max_pages?: number;
  readonly max_entries?: number;
  readonly read_timeout_ms?: number;
  readonly start_timeout_ms?: number;
  readonly now?: () => string;
}

export interface CodexModelClient {
  readonly runtime_version: string;
  readonly listCatalog: (signal?: AbortSignal) => Promise<CodexModelCatalog>;
  readonly readCurrent: (threadId: CodexThreadId | string, signal?: AbortSignal) => Promise<CodexThreadModelState>;
  readonly startTurn: (input: CodexModelTurnStartInput) => Promise<CodexModelTurnAccepted>;
}

interface ParsedCodexModelClientOptions {
  readonly page_size: number;
  readonly max_pages: number;
  readonly max_entries: number;
  readonly read_timeout_ms: number;
  readonly start_timeout_ms: number;
  readonly now: () => string;
}

interface ParsedRawModel {
  readonly hidden: boolean;
  readonly entry: ModelCatalogEntry;
}

const defaults = {
  page_size: defaultResourceBudget.protocol_model_page_size,
  max_pages: defaultResourceBudget.protocol_model_max_pages,
  max_entries: defaultResourceBudget.protocol_model_max_entries,
  read_timeout_ms: defaultResourceBudget.protocol_read_timeout_ms,
  start_timeout_ms: defaultResourceBudget.protocol_start_timeout_ms
} as const;

const rawModelKeys = [
  "additionalSpeedTiers",
  "availabilityNux",
  "defaultReasoningEffort",
  "defaultServiceTier",
  "description",
  "displayName",
  "hidden",
  "id",
  "inputModalities",
  "isDefault",
  "model",
  "serviceTiers",
  "supportedReasoningEfforts",
  "supportsPersonality",
  "upgrade",
  "upgradeInfo"
] as const;

const resumeResultKeys = [
  "activePermissionProfile",
  "approvalPolicy",
  "approvalsReviewer",
  "cwd",
  "initialTurnsPage",
  "instructionSources",
  "model",
  "modelProvider",
  "multiAgentMode",
  "reasoningEffort",
  "runtimeWorkspaceRoots",
  "sandbox",
  "serviceTier",
  "thread"
] as const;

export function createCodexModelClient(port: CodexModelRequestPort, options: CodexModelClientOptions = {}): CodexModelClient {
  return new DefaultCodexModelClient(port, parseOptions(options));
}

class DefaultCodexModelClient implements CodexModelClient {
  constructor(
    private readonly port: CodexModelRequestPort,
    private readonly options: ParsedCodexModelClientOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    const capability = compatibility.capabilities.find((candidate) => candidate.name === "model");
    if (capability?.state === "unavailable") {
      throw adapterError("unsupported_method", "The connected Codex runtime does not support structured model control.", "not_sent", false);
    }
    if (
      capability?.state !== "available" ||
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version === null ||
      compatibility.binding_id === null
    ) {
      throw adapterError("handshake_failed", "Codex model control requires a connected compatible runtime.", "not_sent", true);
    }
    return compatibility.observed_version;
  }

  async listCatalog(signal?: AbortSignal): Promise<CodexModelCatalog> {
    void this.runtime_version;
    const models: ModelCatalogEntry[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    for (let pageNumber = 0; pageNumber < this.options.max_pages; pageNumber += 1) {
      const params = { cursor, limit: this.options.page_size, includeHidden: false } satisfies ModelListParams;
      const result = requireRecord(
        await this.port.request({
          method: "model/list",
          params,
          kind: "read",
          timeout_ms: this.options.read_timeout_ms,
          ...(signal === undefined ? {} : { signal })
        }),
        "Codex model/list result must be an object."
      );
      assertExactKeys(result, ["data", "nextCursor"], "Codex model/list fields are invalid.");
      if (!Array.isArray(result.data) || result.data.length > this.options.page_size) {
        throw invalidPayload("Codex model/list data exceeds the requested page bound.");
      }
      for (const candidate of result.data) {
        const parsed = parseRawModel(candidate);
        if (parsed.hidden) throw invalidPayload("Codex model/list returned a hidden model when hidden entries were excluded.");
        if (models.length >= this.options.max_entries) {
          throw adapterError("broker_overloaded", "Codex model catalog exceeded the configured entry bound.", "not_applicable", false);
        }
        models.push(parsed.entry);
      }

      if (result.nextCursor === null) break;
      const nextCursor = parsePrintableString(result.nextCursor, "Codex model-list cursor", 2_048);
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw invalidPayload("Codex model/list pagination cursor repeated.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === this.options.max_pages - 1) {
        throw adapterError("broker_overloaded", "Codex model/list exceeded the configured page bound.", "not_applicable", false);
      }
    }

    validateCatalog(models);
    const observedAt = parseTimestamp(this.options.now());
    return Object.freeze({
      revision: catalogRevision(models),
      observed_at: observedAt,
      models: Object.freeze(models.map(freezeModelEntry))
    });
  }

  async readCurrent(threadId: CodexThreadId | string, signal?: AbortSignal): Promise<CodexThreadModelState> {
    void this.runtime_version;
    const parsedThreadId = parseInputThreadId(threadId);
    const params = { threadId: parsedThreadId, excludeTurns: true } satisfies ThreadResumeParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/resume",
        params,
        kind: "read",
        timeout_ms: this.options.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex thread/resume result must be an object."
    );
    assertExactKeys(result, resumeResultKeys, "Codex thread/resume fields are invalid.");
    const thread = requireRecord(result.thread, "Codex thread/resume thread must be an object.");
    if (parsePayloadThreadId(thread.id) !== parsedThreadId) throw invalidPayload("Codex thread/resume returned a different thread id.");
    if (!Array.isArray(thread.turns) || thread.turns.length !== 0) {
      throw invalidPayload("Codex thread/resume excludeTurns response unexpectedly included turns.");
    }
    parsePrintableString(result.modelProvider, "Codex model provider", 120);
    return Object.freeze({
      thread_id: parsedThreadId,
      runtime_model: parsePrintableString(result.model, "Codex current model", 160),
      reasoning_effort:
        result.reasoningEffort === null
          ? null
          : parsePrintableString(result.reasoningEffort, "Codex current reasoning effort", 80)
    });
  }

  async startTurn(input: CodexModelTurnStartInput): Promise<CodexModelTurnAccepted> {
    void this.runtime_version;
    const operationId = parseOperationId(input.operation_id);
    const threadId = parseInputThreadId(input.thread_id);
    const text = parsePromptText(input.text);
    const runtimeModel = parsePrintableString(input.runtime_model, "Codex selected model", 160);
    const effort = parsePrintableString(input.reasoning_effort, "Codex selected reasoning effort", 80);
    const params = {
      threadId,
      clientUserMessageId: operationId,
      input: [{ type: "text", text, text_elements: [] }],
      model: runtimeModel,
      effort
    } satisfies TurnStartParams;
    const result = requireRecord(
      await this.port.request({
        method: "turn/start",
        params,
        kind: "mutation",
        timeout_ms: this.options.start_timeout_ms,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }),
      "Codex turn/start result must be an object."
    );
    assertExactKeys(result, ["turn"], "Codex turn/start fields are invalid.");
    const turn = requireRecord(result.turn, "Codex turn/start turn must be an object.");
    assertExactKeys(
      turn,
      ["completedAt", "durationMs", "error", "id", "items", "itemsView", "startedAt", "status"],
      "Codex turn/start turn fields are invalid."
    );
    const parsedTurnId = parseTurnId(turn.id);
    if (turn.status !== "inProgress" || turn.error !== null || turn.completedAt !== null || turn.durationMs !== null) {
      throw invalidPayload("Codex turn/start did not return the accepted in-progress turn shape.");
    }
    if (!Array.isArray(turn.items) || turn.items.length > 256 || !["notLoaded", "summary", "full"].includes(turn.itemsView as string)) {
      throw invalidPayload("Codex turn/start returned an invalid bounded item view.");
    }
    if (turn.startedAt !== null && (!Number.isFinite(turn.startedAt) || (turn.startedAt as number) < 0)) {
      throw invalidPayload("Codex turn/start returned an invalid start timestamp.");
    }
    return Object.freeze({ thread_id: threadId, turn_id: parsedTurnId, state: "accepted" });
  }
}

function parseRawModel(candidate: unknown): ParsedRawModel {
  const value = requireRecord(candidate, "Codex model catalog entry must be an object.");
  assertExactKeys(value, rawModelKeys, "Codex model catalog entry fields are invalid.");
  if (typeof value.hidden !== "boolean" || typeof value.isDefault !== "boolean" || typeof value.supportsPersonality !== "boolean") {
    throw invalidPayload("Codex model catalog flags are invalid.");
  }
  parseNullablePrintableString(value.upgrade, "Codex model upgrade", 160);
  validateUpgradeInfo(value.upgradeInfo);
  validateAvailabilityNux(value.availabilityNux);
  validateStringArray(value.additionalSpeedTiers, "Codex model additional speed tiers", 16, 120);
  const serviceTierIds = validateServiceTiers(value.serviceTiers);
  const defaultServiceTier = parseNullablePrintableString(value.defaultServiceTier, "Codex model default service tier", 120);
  if (defaultServiceTier !== null && !serviceTierIds.has(defaultServiceTier)) {
    throw invalidPayload("Codex model default service tier is absent from its service-tier catalog.");
  }
  const inputModalities = validateInputModalities(value.inputModalities);
  const defaultEffort = parsePrintableString(value.defaultReasoningEffort, "Codex default reasoning effort", 80);
  const effortValues = requireArray(value.supportedReasoningEfforts, "Codex supported reasoning efforts", 1, 16).map((candidate) => {
    const effort = requireRecord(candidate, "Codex reasoning effort must be an object.");
    assertExactKeys(effort, ["description", "reasoningEffort"], "Codex reasoning effort fields are invalid.");
    const id = parsePrintableString(effort.reasoningEffort, "Codex reasoning effort", 80);
    const description = parseOptionalDescription(effort.description, "Codex reasoning effort description");
    return { id, description, is_default: id === defaultEffort };
  });
  if (new Set(effortValues.map((effort) => effort.id)).size !== effortValues.length) {
    throw invalidPayload("Codex model reasoning efforts contain duplicates.");
  }
  if (!effortValues.some((effort) => effort.is_default)) {
    throw invalidPayload("Codex default reasoning effort is absent from the supported effort catalog.");
  }
  const entry = modelCatalogEntrySchema.safeParse({
    id: parsePrintableString(value.id, "Codex model id", 160),
    runtime_model: parsePrintableString(value.model, "Codex runtime model", 160),
    label: parsePrintableString(value.displayName, "Codex model display name", 160),
    description: parseOptionalDescription(value.description, "Codex model description"),
    is_default: value.isDefault,
    input_modalities: inputModalities,
    reasoning_efforts: effortValues
  });
  if (!entry.success) throw invalidPayload("Codex model catalog entry does not satisfy the normalized model contract.", entry.error);
  return { hidden: value.hidden, entry: entry.data };
}

function validateCatalog(models: readonly ModelCatalogEntry[]): void {
  if (models.length === 0) throw invalidPayload("Codex model catalog is empty.");
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw invalidPayload("Codex model catalog contains duplicate model ids.");
  }
  if (new Set(models.map((model) => model.runtime_model)).size !== models.length) {
    throw invalidPayload("Codex model catalog contains duplicate runtime model names.");
  }
  if (models.filter((model) => model.is_default).length !== 1) {
    throw invalidPayload("Codex model catalog must expose exactly one default model.");
  }
}

function catalogRevision(models: readonly ModelCatalogEntry[]): string {
  return createHash("sha256").update(JSON.stringify(models)).digest("hex");
}

function freezeModelEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
  return Object.freeze({
    ...entry,
    input_modalities: [...entry.input_modalities],
    reasoning_efforts: entry.reasoning_efforts.map((effort) => Object.freeze({ ...effort }))
  });
}

function validateUpgradeInfo(candidate: unknown): void {
  if (candidate === null) return;
  const value = requireRecord(candidate, "Codex model upgrade info must be an object.");
  assertExactKeys(value, ["migrationMarkdown", "model", "modelLink", "upgradeCopy"], "Codex model upgrade info fields are invalid.");
  parsePrintableString(value.model, "Codex upgrade model", 160);
  parseNullableBoundedText(value.upgradeCopy, "Codex model upgrade copy", 4_000);
  parseNullablePrintableString(value.modelLink, "Codex model upgrade link", 2_048);
  parseNullableBoundedText(value.migrationMarkdown, "Codex model migration markdown", 16_000);
}

function validateAvailabilityNux(candidate: unknown): void {
  if (candidate === null) return;
  const value = requireRecord(candidate, "Codex model availability notice must be an object.");
  assertExactKeys(value, ["message"], "Codex model availability notice fields are invalid.");
  parseBoundedText(value.message, "Codex model availability notice", 4_000);
}

function validateServiceTiers(candidate: unknown): Set<string> {
  const tiers = requireArray(candidate, "Codex model service tiers", 0, 16).map((candidate) => {
    const value = requireRecord(candidate, "Codex model service tier must be an object.");
    assertExactKeys(value, ["description", "id", "name"], "Codex model service-tier fields are invalid.");
    parsePrintableString(value.name, "Codex model service-tier name", 120);
    parseBoundedText(value.description, "Codex model service-tier description", 1_000);
    return parsePrintableString(value.id, "Codex model service-tier id", 120);
  });
  if (new Set(tiers).size !== tiers.length) throw invalidPayload("Codex model service tiers contain duplicate ids.");
  return new Set(tiers);
}

function validateInputModalities(candidate: unknown): Array<"image" | "text"> {
  const modalities = requireArray(candidate, "Codex model input modalities", 1, 2).map((value) => {
    if (value !== "text" && value !== "image") throw invalidPayload("Codex model input modality is unsupported.");
    return value;
  });
  if (new Set(modalities).size !== modalities.length) throw invalidPayload("Codex model input modalities contain duplicates.");
  return modalities;
}

function validateStringArray(candidate: unknown, label: string, maxItems: number, maxLength: number): void {
  const values = requireArray(candidate, label, 0, maxItems).map((value) => parsePrintableString(value, label, maxLength));
  if (new Set(values).size !== values.length) throw invalidPayload(`${label} contain duplicates.`);
}

function parseOptions(options: CodexModelClientOptions): ParsedCodexModelClientOptions {
  if (options.now !== undefined && typeof options.now !== "function") throw invalidInput("Codex model clock must be a function.");
  const pageSize = parseBoundedInteger(
    options.page_size,
    defaults.page_size,
    resourceBudgetDefinitionByKey.protocol_model_page_size.minimum,
    resourceBudgetDefinitionByKey.protocol_model_page_size.maximum,
    "model page size"
  );
  const maxEntries = parseBoundedInteger(
    options.max_entries,
    defaults.max_entries,
    resourceBudgetDefinitionByKey.protocol_model_max_entries.minimum,
    resourceBudgetDefinitionByKey.protocol_model_max_entries.maximum,
    "model entry bound"
  );
  if (pageSize > maxEntries) throw invalidInput("Codex model page size cannot exceed the catalog entry bound.");
  return {
    page_size: pageSize,
    max_pages: parseBoundedInteger(
      options.max_pages,
      defaults.max_pages,
      resourceBudgetDefinitionByKey.protocol_model_max_pages.minimum,
      resourceBudgetDefinitionByKey.protocol_model_max_pages.maximum,
      "model page bound"
    ),
    max_entries: maxEntries,
    read_timeout_ms: parseBoundedInteger(
      options.read_timeout_ms,
      defaults.read_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.maximum,
      "model read timeout"
    ),
    start_timeout_ms: parseBoundedInteger(
      options.start_timeout_ms,
      defaults.start_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.maximum,
      "model turn-start timeout"
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

function parseInputThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex model target thread id is invalid.", parsed.error);
  return parsed.data;
}

function parsePayloadThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex model response thread id is invalid.", parsed.error);
  return parsed.data;
}

function parseTurnId(candidate: unknown): CodexTurnId {
  const parsed = codexTurnIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex model turn id is invalid.", parsed.error);
  return parsed.data;
}

function parseOperationId(candidate: unknown): ClientOperationId {
  const parsed = clientOperationIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex model turn operation id is invalid.", parsed.error);
  return parsed.data;
}

function parseTimestamp(candidate: unknown): IsoTimestamp {
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex model clock returned an invalid timestamp.", parsed.error);
  return parsed.data;
}

function parsePromptText(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > 20_000) {
    throw invalidInput("Codex model turn text must contain 1 to 20,000 characters.");
  }
  return parseBoundedText(candidate, "Codex model turn text", 20_000);
}

function parseOptionalDescription(candidate: unknown, label: string): string | null {
  const value = parseBoundedText(candidate, label, 512);
  return value.length === 0 ? null : value;
}

function parseNullablePrintableString(candidate: unknown, label: string, maxLength: number): string | null {
  return candidate === null ? null : parsePrintableString(candidate, label, maxLength);
}

function parseNullableBoundedText(candidate: unknown, label: string, maxLength: number): string | null {
  return candidate === null ? null : parseBoundedText(candidate, label, maxLength);
}

function parsePrintableString(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength) {
    throw invalidPayload(`${label} must be a bounded string.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw invalidPayload(`${label} contains a control character.`);
  }
  return candidate;
}

function parseBoundedText(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length > maxLength) throw invalidPayload(`${label} must be bounded text.`);
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if ((code <= 31 && ![9, 10, 13].includes(code)) || code === 127) {
      throw invalidPayload(`${label} contains an unsupported control character.`);
    }
  }
  return candidate;
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidPayload(message);
  return candidate as Record<string, unknown>;
}

function requireArray(candidate: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(candidate) || candidate.length < min || candidate.length > max) {
    throw invalidPayload(`${label} must contain between ${min} and ${max} entries.`);
  }
  return candidate;
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
