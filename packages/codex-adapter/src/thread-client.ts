import {
  absoluteCwdSchema,
  clientOperationIdSchema,
  codexThreadIdSchema,
  defaultResourceBudget,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey,
  sessionNameSchema
} from "@hostdeck/contracts";
import type { AbsoluteCwd, ClientOperationId, CodexThreadId, IsoTimestamp } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { ThreadArchiveParams } from "./generated/v2/ThreadArchiveParams.js";
import type { ThreadGoalClearParams } from "./generated/v2/ThreadGoalClearParams.js";
import type { ThreadGoalGetParams } from "./generated/v2/ThreadGoalGetParams.js";
import type { ThreadGoalSetParams } from "./generated/v2/ThreadGoalSetParams.js";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.js";
import type { ThreadLoadedListParams } from "./generated/v2/ThreadLoadedListParams.js";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadSetNameParams } from "./generated/v2/ThreadSetNameParams.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";

export type CodexThreadRuntimeStatus = "active" | "idle" | "not_loaded" | "system_error";
export type CodexThreadActiveFlag = "waiting_on_approval" | "waiting_on_user_input";
export type CodexThreadSessionSource = "app_server" | "other" | "vscode";

export interface CodexThreadRecord {
  readonly id: CodexThreadId;
  readonly cwd: AbsoluteCwd;
  readonly created_at: IsoTimestamp;
  readonly updated_at: IsoTimestamp;
  readonly status: CodexThreadRuntimeStatus;
  readonly active_flags: readonly CodexThreadActiveFlag[];
  readonly source: CodexThreadSessionSource;
  readonly thread_source: string | null;
  readonly model_provider: string;
  readonly name: string | null;
  readonly preview: string;
  readonly archived: boolean | null;
}

export interface CodexThreadStartInput {
  readonly operation_id: ClientOperationId | string;
  readonly cwd: AbsoluteCwd | string;
}

export interface CodexThreadStartResult {
  readonly thread: CodexThreadRecord;
  readonly model: string;
}

export interface CodexThreadMaterializeInput {
  readonly thread_id: CodexThreadId | string;
  readonly operation_id: ClientOperationId | string;
  readonly cwd: AbsoluteCwd | string;
  readonly name: string;
}

export interface CodexThreadListInput {
  readonly archived: boolean;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface CodexThreadPage {
  readonly data: readonly CodexThreadRecord[];
  readonly next_cursor: string | null;
}

export interface CodexThreadRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexThreadClientOptions {
  readonly page_size?: number;
  readonly max_pages?: number;
  readonly max_loaded_reads?: number;
  readonly read_timeout_ms?: number;
  readonly mutation_timeout_ms?: number;
  readonly start_timeout_ms?: number;
}

export interface CodexThreadClient {
  readonly runtime_version: string;
  readonly start: (input: CodexThreadStartInput) => Promise<CodexThreadStartResult>;
  readonly ensureMaterialized: (input: CodexThreadMaterializeInput) => Promise<CodexThreadRecord>;
  readonly list: (input: CodexThreadListInput) => Promise<CodexThreadPage>;
  readonly listAll: () => Promise<readonly CodexThreadRecord[]>;
  readonly findByOperationId: (operationId: ClientOperationId | string) => Promise<readonly CodexThreadRecord[]>;
  readonly read: (threadId: CodexThreadId | string) => Promise<CodexThreadRecord>;
  readonly archive: (threadId: CodexThreadId | string) => Promise<void>;
}

interface ParsedThreadClientOptions {
  readonly page_size: number;
  readonly max_pages: number;
  readonly max_loaded_reads: number;
  readonly read_timeout_ms: number;
  readonly mutation_timeout_ms: number;
  readonly start_timeout_ms: number;
}

interface ParsedThreadGoal {
  readonly objective: string;
}

const threadClientDefaults = {
  page_size: defaultResourceBudget.protocol_thread_page_size,
  max_pages: defaultResourceBudget.protocol_thread_max_pages,
  max_loaded_reads: defaultResourceBudget.protocol_thread_max_loaded_reads,
  read_timeout_ms: defaultResourceBudget.protocol_read_timeout_ms,
  mutation_timeout_ms: defaultResourceBudget.protocol_mutation_timeout_ms,
  start_timeout_ms: defaultResourceBudget.protocol_start_timeout_ms
} as const;

export function createCodexThreadClient(port: CodexThreadRequestPort, options: CodexThreadClientOptions = {}): CodexThreadClient {
  return new DefaultCodexThreadClient(port, parseOptions(options));
}

export function codexThreadOperationMarker(operationId: ClientOperationId | string): string {
  const parsed = clientOperationIdSchema.safeParse(operationId);
  if (!parsed.success) throw invalidThreadInput("Codex thread operation id is invalid.", parsed.error);
  return `hostdeck:${parsed.data}`;
}

export function isSupportedCodexThreadSource(source: CodexThreadSessionSource): boolean {
  return ["app_server", "vscode"].includes(source);
}

export function hasHostDeckOperationMarker(
  thread: Pick<CodexThreadRecord, "source" | "thread_source">,
  operationId?: ClientOperationId | string
): boolean {
  if (!isSupportedCodexThreadSource(thread.source) || thread.thread_source === null) return false;
  const prefix = "hostdeck:";
  if (!thread.thread_source.startsWith(prefix)) return false;
  const parsed = clientOperationIdSchema.safeParse(thread.thread_source.slice(prefix.length));
  if (!parsed.success) return false;
  return operationId === undefined || codexThreadOperationMarker(operationId) === thread.thread_source;
}

class DefaultCodexThreadClient implements CodexThreadClient {
  constructor(
    private readonly port: CodexThreadRequestPort,
    private readonly options: ParsedThreadClientOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    if (
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version === null ||
      compatibility.binding_id === null
    ) {
      throw new HostDeckCodexAdapterError("handshake_failed", "Codex thread client requires a connected compatible runtime.", {
        outcome: "not_sent",
        retry_safe: true
      });
    }
    return compatibility.observed_version;
  }

  async start(input: CodexThreadStartInput): Promise<CodexThreadStartResult> {
    void this.runtime_version;
    const cwd = parseInputCwd(input.cwd);
    const marker = codexThreadOperationMarker(input.operation_id);
    const params = {
      cwd,
      ephemeral: false,
      historyMode: "legacy",
      threadSource: marker
    } satisfies ThreadStartParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/start", params, kind: "mutation", timeout_ms: this.options.start_timeout_ms }),
      "Codex thread/start result must be an object."
    );
    const rawThread = requireRecord(result.thread, "Codex thread/start thread must be an object.");
    const thread = parseThread(rawThread, null);
    const responseCwd = parsePayloadCwd(result.cwd);
    if (responseCwd !== cwd || thread.cwd !== cwd) {
      throw invalidThreadPayload("Codex thread/start returned a different working directory.");
    }
    if (thread.thread_source !== marker) {
      throw invalidThreadPayload(
        `Codex thread/start did not preserve the HostDeck operation marker (received ${thread.thread_source ?? "null"}).`
      );
    }
    if (!hasHostDeckOperationMarker(thread, input.operation_id)) {
      throw invalidThreadPayload(
        `Codex thread/start returned an unsupported managed-thread source (${JSON.stringify(rawThread.source) ?? "undefined"}).`
      );
    }
    return {
      thread,
      model: parsePrintableString(result.model, "Codex thread/start model", 120)
    };
  }

  async ensureMaterialized(input: CodexThreadMaterializeInput): Promise<CodexThreadRecord> {
    void this.runtime_version;
    const threadId = parseThreadId(input.thread_id);
    const cwd = parseInputCwd(input.cwd);
    const name = parseSessionName(input.name);
    const marker = codexThreadOperationMarker(input.operation_id);
    let thread = await this.read(threadId);
    assertMaterializationIdentity(thread, threadId, cwd);

    const storedBefore = (await this.listAll()).find((candidate) => candidate.id === threadId);
    if (storedBefore?.archived === true) throw invalidThreadPayload("Codex materialization target is already archived.");
    if (storedBefore !== undefined) assertMaterializationIdentity(storedBefore, threadId, cwd);
    if (storedBefore === undefined && !hasHostDeckOperationMarker(thread, input.operation_id)) {
      throw invalidThreadPayload("Unstored Codex materialization target lacks the exact HostDeck operation marker.");
    }

    const goalBefore = await this.readThreadGoal(threadId);
    if (goalBefore !== null && goalBefore.objective !== marker) {
      throw invalidThreadPayload("Codex materialization target has a conflicting goal.");
    }
    if (thread.name !== name) await this.setThreadName(threadId, name);
    if (storedBefore === undefined && goalBefore === null) await this.setThreadGoal(threadId, marker);
    if (storedBefore === undefined || goalBefore !== null) await this.clearThreadGoal(threadId);
    if ((await this.readThreadGoal(threadId)) !== null) {
      throw invalidThreadPayload("Codex materialization target retained its internal goal.");
    }

    const storedAfter = (await this.listAll()).filter((candidate) => candidate.id === threadId);
    if (storedAfter.length !== 1 || storedAfter[0]?.archived !== false) {
      throw invalidThreadPayload("Codex did not materialize the exact thread into active stored history.");
    }
    assertMaterializationIdentity(storedAfter[0], threadId, cwd);
    thread = await this.read(threadId);
    assertMaterializationIdentity(thread, threadId, cwd);
    if (thread.name !== name) throw invalidThreadPayload("Codex did not preserve the managed thread name during materialization.");
    return { ...thread, archived: false };
  }

  async list(input: CodexThreadListInput): Promise<CodexThreadPage> {
    void this.runtime_version;
    const cursor = input.cursor === undefined || input.cursor === null ? null : parseCursor(input.cursor);
    const limit = parseBoundedInteger(input.limit, this.options.page_size, 1, 500, "thread list limit");
    const params = {
      archived: input.archived,
      cursor,
      limit,
      useStateDbOnly: false
    } satisfies ThreadListParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/list", params, kind: "read", timeout_ms: this.options.read_timeout_ms }),
      "Codex thread/list result must be an object."
    );
    if (!Array.isArray(result.data) || result.data.length > limit) {
      throw invalidThreadPayload("Codex thread/list data exceeds the requested page bound.");
    }
    const data = result.data.map((thread) => parseThread(thread, input.archived));
    assertUniqueThreadIds(data, "Codex thread/list page contains duplicate thread ids.");
    return {
      data,
      next_cursor: result.nextCursor === null ? null : parseCursor(result.nextCursor)
    };
  }

  async listAll(): Promise<readonly CodexThreadRecord[]> {
    const threads: CodexThreadRecord[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < this.options.max_pages; pageNumber += 1) {
        const page = await this.list({ archived, cursor, limit: this.options.page_size });
        threads.push(...page.data);
        if (page.next_cursor === null) break;
        if (seenCursors.has(page.next_cursor) || page.next_cursor === cursor) {
          throw invalidThreadPayload("Codex thread/list pagination cursor repeated.");
        }
        seenCursors.add(page.next_cursor);
        cursor = page.next_cursor;
        if (pageNumber === this.options.max_pages - 1) {
          throw new HostDeckCodexAdapterError("broker_overloaded", "Codex thread/list exceeded the configured page bound.", {
            outcome: "not_applicable",
            retry_safe: false
          });
        }
      }
    }
    assertUniqueThreadIds(threads, "Codex active and archived thread lists overlap or contain duplicates.");
    return threads;
  }

  async findByOperationId(operationId: ClientOperationId | string): Promise<readonly CodexThreadRecord[]> {
    const marker = codexThreadOperationMarker(operationId);
    const stored = await this.listAll();
    const matches = stored.filter((thread) => thread.thread_source === marker);
    const storedIds = new Set(stored.map((thread) => thread.id));
    const loadedOnly = (await this.listLoadedThreadIds()).filter((threadId) => !storedIds.has(threadId));
    if (loadedOnly.length > this.options.max_loaded_reads) {
      throw new HostDeckCodexAdapterError(
        "broker_overloaded",
        "Codex loaded-thread recovery exceeded the configured exact-read bound.",
        { outcome: "not_applicable", retry_safe: false }
      );
    }
    for (const threadId of loadedOnly) {
      const thread = await this.read(threadId);
      if (thread.thread_source === marker) matches.push(thread);
    }
    assertUniqueThreadIds(matches, "Codex operation-marker recovery returned duplicate thread ids.");
    return matches;
  }

  private async listLoadedThreadIds(): Promise<readonly CodexThreadId[]> {
    void this.runtime_version;
    const threadIds: CodexThreadId[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < this.options.max_pages; pageNumber += 1) {
      const params = { cursor, limit: this.options.page_size } satisfies ThreadLoadedListParams;
      const result = requireRecord(
        await this.port.request({
          method: "thread/loaded/list",
          params,
          kind: "read",
          timeout_ms: this.options.read_timeout_ms
        }),
        "Codex thread/loaded/list result must be an object."
      );
      if (!Array.isArray(result.data) || result.data.length > this.options.page_size) {
        throw invalidThreadPayload("Codex thread/loaded/list data exceeds the requested page bound.");
      }
      const pageIds = result.data.map(parseThreadId);
      assertUniqueIds(pageIds, "Codex thread/loaded/list page contains duplicate thread ids.");
      threadIds.push(...pageIds);
      if (result.nextCursor === null) break;
      const nextCursor = parseCursor(result.nextCursor);
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw invalidThreadPayload("Codex thread/loaded/list pagination cursor repeated.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === this.options.max_pages - 1) {
        throw new HostDeckCodexAdapterError(
          "broker_overloaded",
          "Codex thread/loaded/list exceeded the configured page bound.",
          { outcome: "not_applicable", retry_safe: false }
        );
      }
    }
    assertUniqueIds(threadIds, "Codex thread/loaded/list returned duplicate thread ids across pages.");
    return threadIds;
  }

  private async setThreadName(threadId: CodexThreadId, name: string): Promise<void> {
    const params = { threadId, name } satisfies ThreadSetNameParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/name/set", params, kind: "mutation", timeout_ms: this.options.mutation_timeout_ms }),
      "Codex thread/name/set result must be an object."
    );
    if (Object.keys(result).length !== 0) throw invalidThreadPayload("Codex thread/name/set returned unexpected fields.");
  }

  private async readThreadGoal(threadId: CodexThreadId): Promise<ParsedThreadGoal | null> {
    const params = { threadId } satisfies ThreadGoalGetParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/goal/get", params, kind: "read", timeout_ms: this.options.read_timeout_ms }),
      "Codex thread/goal/get result must be an object."
    );
    assertExactKeys(result, ["goal"], "Codex thread/goal/get fields are invalid.");
    return result.goal === null ? null : parseThreadGoal(result.goal, threadId);
  }

  private async setThreadGoal(threadId: CodexThreadId, objective: string): Promise<void> {
    const params = { threadId, objective } satisfies ThreadGoalSetParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/goal/set", params, kind: "mutation", timeout_ms: this.options.mutation_timeout_ms }),
      "Codex thread/goal/set result must be an object."
    );
    assertExactKeys(result, ["goal"], "Codex thread/goal/set fields are invalid.");
    const goal = parseThreadGoal(result.goal, threadId);
    if (goal.objective !== objective) throw invalidThreadPayload("Codex thread/goal/set returned a different objective.");
  }

  private async clearThreadGoal(threadId: CodexThreadId): Promise<void> {
    const params = { threadId } satisfies ThreadGoalClearParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/goal/clear", params, kind: "mutation", timeout_ms: this.options.mutation_timeout_ms }),
      "Codex thread/goal/clear result must be an object."
    );
    assertExactKeys(result, ["cleared"], "Codex thread/goal/clear fields are invalid.");
    if (typeof result.cleared !== "boolean") throw invalidThreadPayload("Codex thread/goal/clear result is invalid.");
  }

  async read(threadId: CodexThreadId | string): Promise<CodexThreadRecord> {
    void this.runtime_version;
    const parsedThreadId = parseThreadId(threadId);
    const params = { threadId: parsedThreadId, includeTurns: false } satisfies ThreadReadParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/read", params, kind: "read", timeout_ms: this.options.read_timeout_ms }),
      "Codex thread/read result must be an object."
    );
    const thread = parseThread(result.thread, null);
    if (thread.id !== parsedThreadId) throw invalidThreadPayload("Codex thread/read returned a different thread id.");
    return thread;
  }

  async archive(threadId: CodexThreadId | string): Promise<void> {
    void this.runtime_version;
    const params = { threadId: parseThreadId(threadId) } satisfies ThreadArchiveParams;
    const result = requireRecord(
      await this.port.request({ method: "thread/archive", params, kind: "mutation", timeout_ms: this.options.mutation_timeout_ms }),
      "Codex thread/archive result must be an object."
    );
    if (Object.keys(result).length !== 0) throw invalidThreadPayload("Codex thread/archive returned unexpected fields.");
  }
}

function parseThread(candidate: unknown, archived: boolean | null): CodexThreadRecord {
  const value = requireRecord(candidate, "Codex thread payload must be an object.");
  const createdAt = unixSecondsToIso(value.createdAt, "createdAt");
  const updatedAt = unixSecondsToIso(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw invalidThreadPayload("Codex thread updatedAt precedes createdAt.");
  const { status, activeFlags } = parseStatus(value.status);
  return {
    id: parseThreadId(value.id),
    cwd: parsePayloadCwd(value.cwd),
    created_at: createdAt,
    updated_at: updatedAt,
    status,
    active_flags: activeFlags,
    source: parseSource(value.source),
    thread_source: value.threadSource === null ? null : parsePrintableString(value.threadSource, "Codex thread source marker", 160),
    model_provider: parsePrintableString(value.modelProvider, "Codex thread model provider", 120),
    name: value.name === null ? null : parsePrintableString(value.name, "Codex thread name", 240),
    preview: parseBoundedText(value.preview, "Codex thread preview", 12_000),
    archived
  };
}

function parseStatus(candidate: unknown): {
  readonly status: CodexThreadRuntimeStatus;
  readonly activeFlags: readonly CodexThreadActiveFlag[];
} {
  const value = requireRecord(candidate, "Codex thread status must be an object.");
  const type = value.type;
  if (["notLoaded", "idle", "systemError"].includes(type as string)) {
    assertExactKeys(value, ["type"], "Codex thread status fields are invalid.");
    if (type === "notLoaded") return { status: "not_loaded", activeFlags: [] };
    if (type === "idle") return { status: "idle", activeFlags: [] };
    return { status: "system_error", activeFlags: [] };
  }
  if (type !== "active" || !Array.isArray(value.activeFlags) || value.activeFlags.length > 2) {
    throw invalidThreadPayload("Codex thread status is unsupported or malformed.");
  }
  assertExactKeys(value, ["activeFlags", "type"], "Codex active-thread status fields are invalid.");
  const activeFlags = value.activeFlags.map((flag) => {
    if (flag === "waitingOnApproval") return "waiting_on_approval" as const;
    if (flag === "waitingOnUserInput") return "waiting_on_user_input" as const;
    throw invalidThreadPayload("Codex thread active flag is unsupported.");
  });
  if (new Set(activeFlags).size !== activeFlags.length) throw invalidThreadPayload("Codex thread active flags contain duplicates.");
  return { status: "active", activeFlags };
}

function parseSource(candidate: unknown): CodexThreadSessionSource {
  if (candidate === "appServer") return "app_server";
  if (candidate === "vscode") return "vscode";
  if (
    [
      "cli",
      "exec",
      "subAgent",
      "subAgentCompact",
      "subAgentOther",
      "subAgentReview",
      "subAgentThreadSpawn",
      "unknown"
    ].includes(candidate as string)
  ) {
    return "other";
  }
  if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
    const keys = Object.keys(candidate);
    if (keys.length === 1 && ["custom", "subAgent"].includes(keys[0] ?? "")) return "other";
  }
  throw invalidThreadPayload("Codex thread source is malformed.");
}

function parseThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidThreadPayload("Codex thread id is invalid.", parsed.error);
  return parsed.data;
}

function parseSessionName(candidate: unknown): string {
  const parsed = sessionNameSchema.safeParse(candidate);
  if (!parsed.success) throw invalidThreadInput("Codex managed thread name is invalid.", parsed.error);
  return parsed.data;
}

function parseInputCwd(candidate: unknown): AbsoluteCwd {
  const parsed = absoluteCwdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidThreadInput("Codex thread cwd is invalid.", parsed.error);
  return parsed.data;
}

function parsePayloadCwd(candidate: unknown): AbsoluteCwd {
  const parsed = absoluteCwdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidThreadPayload("Codex thread cwd is invalid.", parsed.error);
  return parsed.data;
}

function unixSecondsToIso(candidate: unknown, field: string): IsoTimestamp {
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > 253_402_300_799) {
    throw invalidThreadPayload(`Codex thread ${field} must be a supported Unix-second timestamp.`);
  }
  return new Date(candidate * 1_000).toISOString() as IsoTimestamp;
}

function parseCursor(candidate: unknown): string {
  return parsePrintableString(candidate, "Codex thread-list cursor", 2_048);
}

function parsePrintableString(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength) {
    throw invalidThreadPayload(`${label} must be a bounded string.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw invalidThreadPayload(`${label} contains a control character.`);
  }
  return candidate;
}

function parseBoundedText(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length > maxLength) throw invalidThreadPayload(`${label} must be bounded text.`);
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if ((code <= 31 && ![9, 10, 13].includes(code)) || code === 127) {
      throw invalidThreadPayload(`${label} contains an unsupported control character.`);
    }
  }
  return candidate;
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidThreadPayload(message);
  return candidate as Record<string, unknown>;
}

function assertUniqueThreadIds(threads: readonly CodexThreadRecord[], message: string): void {
  if (new Set(threads.map((thread) => thread.id)).size !== threads.length) throw invalidThreadPayload(message);
}

function assertUniqueIds(ids: readonly string[], message: string): void {
  if (new Set(ids).size !== ids.length) throw invalidThreadPayload(message);
}

function assertMaterializationIdentity(
  thread: CodexThreadRecord,
  expectedThreadId: CodexThreadId,
  expectedCwd: AbsoluteCwd
): void {
  if (thread.id !== expectedThreadId || thread.cwd !== expectedCwd || !isSupportedCodexThreadSource(thread.source)) {
    throw invalidThreadPayload("Codex materialization target does not match its durable recovery identity.");
  }
}

function parseThreadGoal(candidate: unknown, expectedThreadId: CodexThreadId): ParsedThreadGoal {
  const value = requireRecord(candidate, "Codex thread goal must be an object.");
  assertExactKeys(
    value,
    ["createdAt", "objective", "status", "threadId", "timeUsedSeconds", "tokenBudget", "tokensUsed", "updatedAt"],
    "Codex thread goal fields are invalid."
  );
  if (parseThreadId(value.threadId) !== expectedThreadId) throw invalidThreadPayload("Codex thread goal targets a different thread.");
  const objective = parseBoundedText(value.objective, "Codex thread goal objective", 4_000);
  if (objective.length === 0) throw invalidThreadPayload("Codex thread goal objective cannot be empty.");
  if (!["active", "blocked", "budgetLimited", "complete", "paused", "usageLimited"].includes(value.status as string)) {
    throw invalidThreadPayload("Codex thread goal status is invalid.");
  }
  parseNonnegativeNumber(value.createdAt, "createdAt");
  parseNonnegativeNumber(value.updatedAt, "updatedAt");
  parseNonnegativeNumber(value.timeUsedSeconds, "timeUsedSeconds");
  parseNonnegativeInteger(value.tokensUsed, "tokensUsed");
  if (value.tokenBudget !== null) parseNonnegativeInteger(value.tokenBudget, "tokenBudget");
  if ((value.updatedAt as number) < (value.createdAt as number)) {
    throw invalidThreadPayload("Codex thread goal updatedAt precedes createdAt.");
  }
  return { objective };
}

function parseNonnegativeNumber(candidate: unknown, field: string): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw invalidThreadPayload(`Codex thread goal ${field} must be a nonnegative finite number.`);
  }
  return candidate;
}

function parseNonnegativeInteger(candidate: unknown, field: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw invalidThreadPayload(`Codex thread goal ${field} must be a nonnegative safe integer.`);
  }
  return candidate as number;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw invalidThreadPayload(message);
}

function parseOptions(options: CodexThreadClientOptions): ParsedThreadClientOptions {
  return {
    page_size: parseBoundedInteger(
      options.page_size,
      threadClientDefaults.page_size,
      resourceBudgetDefinitionByKey.protocol_thread_page_size.minimum,
      resourceBudgetDefinitionByKey.protocol_thread_page_size.maximum,
      "thread page size"
    ),
    max_pages: parseBoundedInteger(
      options.max_pages,
      threadClientDefaults.max_pages,
      resourceBudgetDefinitionByKey.protocol_thread_max_pages.minimum,
      resourceBudgetDefinitionByKey.protocol_thread_max_pages.maximum,
      "thread max pages"
    ),
    max_loaded_reads: parseBoundedInteger(
      options.max_loaded_reads,
      threadClientDefaults.max_loaded_reads,
      resourceBudgetDefinitionByKey.protocol_thread_max_loaded_reads.minimum,
      resourceBudgetDefinitionByKey.protocol_thread_max_loaded_reads.maximum,
      "loaded-thread exact-read bound"
    ),
    read_timeout_ms: parseBoundedInteger(
      options.read_timeout_ms,
      threadClientDefaults.read_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.maximum,
      "thread read timeout"
    ),
    mutation_timeout_ms: parseBoundedInteger(
      options.mutation_timeout_ms,
      threadClientDefaults.mutation_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms.maximum,
      "thread mutation timeout"
    ),
    start_timeout_ms: parseBoundedInteger(
      options.start_timeout_ms,
      threadClientDefaults.start_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_start_timeout_ms.maximum,
      "thread start timeout"
    )
  };
}

function parseBoundedInteger(candidate: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (candidate === undefined) return fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw invalidThreadInput(`Codex ${label} must be a safe integer between ${min} and ${max}.`);
  }
  return candidate;
}

function invalidThreadInput(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_protocol_message", message, {
    cause,
    outcome: "not_sent",
    retry_safe: true
  });
}

function invalidThreadPayload(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_protocol_message", message, {
    cause,
    outcome: "not_applicable",
    retry_safe: false
  });
}
