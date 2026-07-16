import {
  absoluteCwdSchema,
  codexThreadIdSchema,
  codexTurnIdSchema,
  type ResourceBudget,
  type RuntimeCompatibility
} from "@hostdeck/contracts";
import type { AbsoluteCwd, CodexThreadId, CodexTurnId, IsoTimestamp } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import {
  type CodexAdapterErrorCode,
  type CodexOperationOutcome,
  HostDeckCodexAdapterError
} from "./errors.js";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.js";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams.js";
import { type CodexThreadGoal, createCodexGoalClient } from "./goal-client.js";
import { type CodexThreadModelState, createCodexModelClient } from "./model-client.js";
import type {
  CodexReconnectReadMethod,
  CodexReconnectReadPort,
  CodexReconnectReadRequestInput,
  CodexReconnectResubscribeMethod,
  CodexReconnectResubscribePort,
  CodexReconnectResubscribeRequestInput
} from "./reconnect-controller.js";
import { codexResourceOptionsFromBudget } from "./resource-options.js";
import type {
  CodexThreadActiveFlag,
  CodexThreadRecord,
  CodexThreadRuntimeStatus,
  CodexThreadSessionSource
} from "./thread-client.js";

export type CodexReconciliationTurnFailureCode =
  | "active_turn_not_steerable"
  | "bad_request"
  | "context_window_exceeded"
  | "cyber_policy"
  | "http_connection_failed"
  | "internal_server_error"
  | "other"
  | "response_stream_connection_failed"
  | "response_stream_disconnected"
  | "response_too_many_failed_attempts"
  | "sandbox_error"
  | "server_overloaded"
  | "session_budget_exceeded"
  | "thread_rollback_failed"
  | "unauthorized"
  | "unclassified"
  | "usage_limit_exceeded";

interface CodexReconciliationTurnBase {
  readonly turn_id: CodexTurnId;
  readonly started_at: IsoTimestamp;
}

export type CodexReconciliationLatestTurn =
  | (CodexReconciliationTurnBase & {
      readonly status: "in_progress";
      readonly completed_at: null;
      readonly duration_ms: null;
      readonly failure_code: null;
    })
  | (CodexReconciliationTurnBase & {
      readonly status: "completed" | "interrupted";
      readonly completed_at: IsoTimestamp;
      readonly duration_ms: number | null;
      readonly failure_code: null;
    })
  | (CodexReconciliationTurnBase & {
      readonly status: "failed";
      readonly completed_at: IsoTimestamp;
      readonly duration_ms: number | null;
      readonly failure_code: CodexReconciliationTurnFailureCode;
    });

export interface CodexReconciliationReadClient {
  readonly runtime_version: string;
  readonly generation: number;
  readonly listAllThreads: (signal?: AbortSignal) => Promise<readonly CodexThreadRecord[]>;
  readonly readThread: (threadId: CodexThreadId | string, signal?: AbortSignal) => Promise<CodexThreadRecord>;
  readonly readGoal: (threadId: CodexThreadId | string, signal?: AbortSignal) => Promise<CodexThreadGoal | null>;
  readonly readLatestTurn: (
    threadId: CodexThreadId | string,
    signal?: AbortSignal
  ) => Promise<CodexReconciliationLatestTurn | null>;
}

export interface CodexReconciliationResubscribeClient {
  readonly runtime_version: string;
  readonly generation: number;
  readonly resumeThread: (
    threadId: CodexThreadId | string,
    signal?: AbortSignal
  ) => Promise<CodexThreadModelState>;
}

const readMethods = Object.freeze([
  "thread/goal/get",
  "thread/list",
  "thread/read",
  "thread/turns/list"
] as const satisfies readonly CodexReconnectReadMethod[]);

const resubscribeMethods = Object.freeze([
  "thread/resume"
] as const satisfies readonly CodexReconnectResubscribeMethod[]);

const threadKeys = [
  "agentNickname",
  "agentRole",
  "cliVersion",
  "createdAt",
  "cwd",
  "ephemeral",
  "extra",
  "forkedFromId",
  "gitInfo",
  "historyMode",
  "id",
  "modelProvider",
  "name",
  "parentThreadId",
  "path",
  "preview",
  "recencyAt",
  "sessionId",
  "source",
  "status",
  "threadSource",
  "turns",
  "updatedAt"
] as const;

const turnKeys = ["completedAt", "durationMs", "error", "id", "items", "itemsView", "startedAt", "status"] as const;

const scalarFailureCodes = new Map<string, CodexReconciliationTurnFailureCode>([
  ["badRequest", "bad_request"],
  ["contextWindowExceeded", "context_window_exceeded"],
  ["cyberPolicy", "cyber_policy"],
  ["internalServerError", "internal_server_error"],
  ["other", "other"],
  ["sandboxError", "sandbox_error"],
  ["serverOverloaded", "server_overloaded"],
  ["sessionBudgetExceeded", "session_budget_exceeded"],
  ["threadRollbackFailed", "thread_rollback_failed"],
  ["unauthorized", "unauthorized"],
  ["usageLimitExceeded", "usage_limit_exceeded"]
]);

const statusFailureCodes = new Map<string, CodexReconciliationTurnFailureCode>([
  ["httpConnectionFailed", "http_connection_failed"],
  ["responseStreamConnectionFailed", "response_stream_connection_failed"],
  ["responseStreamDisconnected", "response_stream_disconnected"],
  ["responseTooManyFailedAttempts", "response_too_many_failed_attempts"]
]);

export function createCodexReconciliationReadClient(
  port: CodexReconnectReadPort,
  resourceBudget: ResourceBudget
): CodexReconciliationReadClient {
  const generation = parseGeneration(port);
  const options = codexResourceOptionsFromBudget(resourceBudget);
  const guarded = createGuardedPort(port, readMethods);
  const goals = createCodexGoalClient(guarded, {
    read_timeout_ms: options.thread.read_timeout_ms,
    mutation_timeout_ms: options.thread.mutation_timeout_ms
  });

  const runtimeVersion = () => requireRuntimeVersion(guarded.compatibility);
  const listAllThreads = async (signal?: AbortSignal): Promise<readonly CodexThreadRecord[]> => {
    const expectedRuntimeVersion = runtimeVersion();
    const threads: CodexThreadRecord[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < options.thread.max_pages; pageNumber += 1) {
        const params = {
          archived,
          cursor,
          limit: options.thread.page_size,
          sortDirection: "desc",
          sortKey: "created_at",
          useStateDbOnly: false
        } satisfies ThreadListParams;
        const result = requireRecord(
          await guarded.request({
            method: "thread/list",
            params,
            kind: "read",
            timeout_ms: options.thread.read_timeout_ms,
            ...(signal === undefined ? {} : { signal })
          }),
          "Codex reconciliation thread/list result must be an object."
        );
        assertExactKeys(result, ["backwardsCursor", "data", "nextCursor"], "Codex reconciliation thread/list fields are invalid.");
        const page = requireArray(result.data, "Codex reconciliation thread/list data must be an array.", options.thread.page_size)
          .map((candidate) => parseThread(candidate, archived, expectedRuntimeVersion));
        assertUniqueThreadIds(page, "Codex reconciliation thread/list page contains duplicate thread ids.");
        validateBackwardsCursor(result.backwardsCursor, page.length, "thread-list");
        threads.push(...page);

        if (result.nextCursor === null) break;
        const nextCursor = parseCursor(result.nextCursor, "Codex reconciliation thread-list cursor");
        if (nextCursor === cursor || seenCursors.has(nextCursor)) {
          throw invalidPayload("Codex reconciliation thread/list pagination cursor repeated.");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        if (pageNumber === options.thread.max_pages - 1) {
          throw overloaded("Codex reconciliation thread/list exceeded the configured page bound.");
        }
      }
    }
    assertUniqueThreadIds(threads, "Codex reconciliation active and archived thread lists overlap.");
    return Object.freeze(threads);
  };

  const readThread = async (
    threadId: CodexThreadId | string,
    signal?: AbortSignal
  ): Promise<CodexThreadRecord> => {
    const expectedRuntimeVersion = runtimeVersion();
    const parsedThreadId = parseInputThreadId(threadId);
    const params = { threadId: parsedThreadId, includeTurns: false } satisfies ThreadReadParams;
    const result = requireRecord(
      await guarded.request({
        method: "thread/read",
        params,
        kind: "read",
        timeout_ms: options.thread.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex reconciliation thread/read result must be an object."
    );
    assertExactKeys(result, ["thread"], "Codex reconciliation thread/read fields are invalid.");
    const thread = parseThread(result.thread, null, expectedRuntimeVersion);
    if (thread.id !== parsedThreadId) throw invalidPayload("Codex reconciliation thread/read returned a different thread id.");
    return thread;
  };

  const readLatestTurn = async (
    threadId: CodexThreadId | string,
    signal?: AbortSignal
  ): Promise<CodexReconciliationLatestTurn | null> => {
    void runtimeVersion();
    const parsedThreadId = parseInputThreadId(threadId);
    const params = {
      threadId: parsedThreadId,
      cursor: null,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded"
    } satisfies ThreadTurnsListParams;
    const result = requireRecord(
      await guarded.request({
        method: "thread/turns/list",
        params,
        kind: "read",
        timeout_ms: options.thread.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex reconciliation thread/turns/list result must be an object."
    );
    assertExactKeys(
      result,
      ["backwardsCursor", "data", "nextCursor"],
      "Codex reconciliation thread/turns/list fields are invalid."
    );
    const turns = requireArray(result.data, "Codex reconciliation latest-turn data must be an array.", 1);
    validateBackwardsCursor(result.backwardsCursor, turns.length, "latest-turn");
    if (result.nextCursor !== null) parseCursor(result.nextCursor, "Codex reconciliation turn-list cursor");
    return turns.length === 0 ? null : parseLatestTurn(turns[0]);
  };

  return Object.freeze({
    get runtime_version() {
      return runtimeVersion();
    },
    generation,
    listAllThreads,
    readThread,
    readGoal: (threadId: CodexThreadId | string, signal?: AbortSignal) => goals.read(threadId, signal),
    readLatestTurn
  });
}

export function createCodexReconciliationResubscribeClient(
  port: CodexReconnectResubscribePort,
  resourceBudget: ResourceBudget
): CodexReconciliationResubscribeClient {
  const generation = parseGeneration(port);
  const options = codexResourceOptionsFromBudget(resourceBudget);
  const guarded = createGuardedPort(port, resubscribeMethods);
  const models = createCodexModelClient(guarded, {
    page_size: options.model.page_size,
    max_pages: options.model.max_pages,
    max_entries: options.model.max_entries,
    read_timeout_ms: options.model.read_timeout_ms,
    start_timeout_ms: options.model.start_timeout_ms
  });
  return Object.freeze({
    get runtime_version() {
      return models.runtime_version;
    },
    generation,
    resumeThread: (threadId: CodexThreadId | string, signal?: AbortSignal) => models.readCurrent(threadId, signal)
  });
}

function createGuardedPort<
  TPort extends CodexReconnectReadPort | CodexReconnectResubscribePort,
  TMethod extends CodexReconnectReadMethod | CodexReconnectResubscribeMethod
>(port: TPort, allowedMethods: readonly TMethod[]): { readonly compatibility: RuntimeCompatibility; readonly request: (input: CodexRequestInput) => Promise<unknown> } {
  if (port === null || typeof port !== "object" || typeof port.request !== "function") {
    throw new TypeError("Codex reconciliation client requires a restricted runtime port.");
  }
  const allowed = new Set<string>(allowedMethods);
  return Object.freeze({
    compatibility: port.compatibility,
    async request(input: CodexRequestInput): Promise<unknown> {
      if (input === null || typeof input !== "object" || input.kind !== "read" || !allowed.has(input.method)) {
        throw invalidInput("Codex reconciliation client attempted an unreviewed runtime method.");
      }
      return port.request(
        input as CodexReconnectReadRequestInput & CodexReconnectResubscribeRequestInput
      );
    }
  });
}

function parseThread(
  candidate: unknown,
  archived: boolean | null,
  expectedRuntimeVersion: string
): CodexThreadRecord {
  const value = requireRecord(candidate, "Codex reconciliation thread payload must be an object.");
  assertExactKeys(value, threadKeys, "Codex reconciliation thread fields are invalid.");
  validateThreadExtra(value.extra);
  parsePrintableString(value.sessionId, "Codex thread session id", 160);
  parseNullableThreadId(value.forkedFromId, "forkedFromId");
  parseNullableThreadId(value.parentThreadId, "parentThreadId");
  if (typeof value.ephemeral !== "boolean") throw invalidPayload("Codex thread ephemeral flag is invalid.");
  if (value.historyMode !== "legacy" && value.historyMode !== "paginated") {
    throw invalidPayload("Codex thread history mode is invalid.");
  }
  const createdAt = unixSecondsToIso(value.createdAt, "thread createdAt");
  const updatedAt = unixSecondsToIso(value.updatedAt, "thread updatedAt");
  if (updatedAt < createdAt) throw invalidPayload("Codex thread updatedAt precedes createdAt.");
  if (value.recencyAt !== null) unixSecondsToIso(value.recencyAt, "thread recencyAt");
  if (value.path !== null) parseAbsolutePath(value.path, "Codex thread path");
  const cliVersion = parsePrintableString(value.cliVersion, "Codex thread CLI version", 120);
  if (cliVersion !== expectedRuntimeVersion) {
    throw invalidPayload("Codex thread CLI version contradicts the compatible runtime version.");
  }
  parseNullablePrintableString(value.agentNickname, "Codex thread agent nickname", 240);
  parseNullablePrintableString(value.agentRole, "Codex thread agent role", 240);
  validateGitInfo(value.gitInfo);
  const turns = requireArray(value.turns, "Codex reconciliation thread turns must be an array.", 0);
  if (turns.length !== 0) throw invalidPayload("Codex reconciliation thread unexpectedly included turn history.");
  const { status, activeFlags } = parseThreadStatus(value.status);
  return Object.freeze({
    id: parsePayloadThreadId(value.id),
    cwd: parseAbsolutePath(value.cwd, "Codex thread cwd"),
    created_at: createdAt,
    updated_at: updatedAt,
    status,
    active_flags: Object.freeze(activeFlags),
    source: parseThreadSource(value.source),
    thread_source: parseNullablePrintableString(value.threadSource, "Codex thread source marker", 160),
    model_provider: parsePrintableString(value.modelProvider, "Codex thread model provider", 120),
    name: parseNullablePrintableString(value.name, "Codex thread name", 240),
    preview: parseBoundedText(value.preview, "Codex thread preview", 12_000, true),
    archived
  });
}

function parseLatestTurn(candidate: unknown): CodexReconciliationLatestTurn {
  const value = requireRecord(candidate, "Codex reconciliation latest turn must be an object.");
  assertExactKeys(value, turnKeys, "Codex reconciliation latest-turn fields are invalid.");
  if (value.itemsView !== "notLoaded") throw invalidPayload("Codex reconciliation latest turn loaded unreviewed item content.");
  const items = requireArray(value.items, "Codex reconciliation latest-turn items must be an array.", 0);
  if (items.length !== 0) throw invalidPayload("Codex reconciliation latest turn included item content.");
  const turnId = parseTurnId(value.id);
  if (value.startedAt === null) throw invalidPayload("Codex reconciliation latest turn is missing its start time.");
  const startedAt = unixSecondsToIso(value.startedAt, "turn startedAt");

  if (value.status === "inProgress") {
    if (value.completedAt !== null || value.durationMs !== null || value.error !== null) {
      throw invalidPayload("Codex in-progress turn contains terminal fields.");
    }
    return Object.freeze({
      turn_id: turnId,
      status: "in_progress",
      started_at: startedAt,
      completed_at: null,
      duration_ms: null,
      failure_code: null
    });
  }

  if (!["completed", "interrupted", "failed"].includes(value.status as string) || value.completedAt === null) {
    throw invalidPayload("Codex reconciliation latest-turn status is unsupported or incomplete.");
  }
  const terminalStatus = value.status as "completed" | "failed" | "interrupted";
  const completedAt = unixSecondsToIso(value.completedAt, "turn completedAt");
  if (completedAt < startedAt) throw invalidPayload("Codex turn completedAt precedes startedAt.");
  const durationMs = value.durationMs === null ? null : parseNonnegativeSafeInteger(value.durationMs, "turn durationMs");
  if (terminalStatus === "failed") {
    if (value.error === null) throw invalidPayload("Codex failed turn is missing its error classification.");
    return Object.freeze({
      turn_id: turnId,
      status: "failed",
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      failure_code: parseTurnError(value.error)
    });
  }
  if (value.error !== null) throw invalidPayload("Codex non-failed turn unexpectedly includes an error.");
  return Object.freeze({
    turn_id: turnId,
    status: terminalStatus,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    failure_code: null
  });
}

function parseTurnError(candidate: unknown): CodexReconciliationTurnFailureCode {
  const value = requireRecord(candidate, "Codex failed-turn error must be an object.");
  assertExactKeys(value, ["additionalDetails", "codexErrorInfo", "message"], "Codex failed-turn error fields are invalid.");
  parseBoundedText(value.message, "Codex failed-turn message", 4_000, false);
  if (value.additionalDetails !== null) {
    parseBoundedText(value.additionalDetails, "Codex failed-turn additional details", 8_000, true);
  }
  if (value.codexErrorInfo === null) return "unclassified";
  if (typeof value.codexErrorInfo === "string") {
    const code = scalarFailureCodes.get(value.codexErrorInfo);
    if (code === undefined) throw invalidPayload("Codex failed-turn error classification is unsupported.");
    return code;
  }
  const info = requireRecord(value.codexErrorInfo, "Codex failed-turn error classification must be an object.");
  const keys = Object.keys(info);
  if (keys.length !== 1) throw invalidPayload("Codex failed-turn error classification fields are invalid.");
  const key = keys[0] as string;
  if (key === "activeTurnNotSteerable") {
    const detail = requireRecord(info[key], "Codex non-steerable-turn detail must be an object.");
    assertExactKeys(detail, ["turnKind"], "Codex non-steerable-turn detail fields are invalid.");
    if (detail.turnKind !== "compact" && detail.turnKind !== "review") {
      throw invalidPayload("Codex non-steerable-turn kind is unsupported.");
    }
    return "active_turn_not_steerable";
  }
  const statusCode = statusFailureCodes.get(key);
  if (statusCode === undefined) throw invalidPayload("Codex failed-turn error classification is unsupported.");
  const detail = requireRecord(info[key], "Codex failed-turn HTTP detail must be an object.");
  assertExactKeys(detail, ["httpStatusCode"], "Codex failed-turn HTTP detail fields are invalid.");
  if (detail.httpStatusCode !== null) {
    const status = parseNonnegativeSafeInteger(detail.httpStatusCode, "failed-turn HTTP status");
    if (status < 100 || status > 599) throw invalidPayload("Codex failed-turn HTTP status is outside the supported range.");
  }
  return statusCode;
}

function parseThreadStatus(candidate: unknown): {
  readonly status: CodexThreadRuntimeStatus;
  readonly activeFlags: CodexThreadActiveFlag[];
} {
  const value = requireRecord(candidate, "Codex reconciliation thread status must be an object.");
  if (["idle", "notLoaded", "systemError"].includes(value.type as string)) {
    assertExactKeys(value, ["type"], "Codex reconciliation thread status fields are invalid.");
    if (value.type === "idle") return { status: "idle", activeFlags: [] };
    if (value.type === "notLoaded") return { status: "not_loaded", activeFlags: [] };
    return { status: "system_error", activeFlags: [] };
  }
  if (value.type !== "active") throw invalidPayload("Codex reconciliation thread status is unsupported.");
  assertExactKeys(value, ["activeFlags", "type"], "Codex reconciliation active-thread status fields are invalid.");
  const flags = requireArray(value.activeFlags, "Codex reconciliation active flags must be an array.", 2).map((flag) => {
    if (flag === "waitingOnApproval") return "waiting_on_approval" as const;
    if (flag === "waitingOnUserInput") return "waiting_on_user_input" as const;
    throw invalidPayload("Codex reconciliation active flag is unsupported.");
  });
  if (new Set(flags).size !== flags.length) throw invalidPayload("Codex reconciliation active flags contain duplicates.");
  return { status: "active", activeFlags: flags };
}

function parseThreadSource(candidate: unknown): CodexThreadSessionSource {
  if (candidate === "appServer") return "app_server";
  if (candidate === "vscode") return "vscode";
  if (["cli", "exec", "unknown"].includes(candidate as string)) return "other";
  const value = requireRecord(candidate, "Codex thread source is malformed.");
  const keys = Object.keys(value);
  if (keys.length !== 1) throw invalidPayload("Codex thread source fields are invalid.");
  if (keys[0] === "custom") {
    parsePrintableString(value.custom, "Codex custom thread source", 240);
    return "other";
  }
  if (keys[0] !== "subAgent") throw invalidPayload("Codex thread source is unsupported.");
  validateSubAgentSource(value.subAgent);
  return "other";
}

function validateSubAgentSource(candidate: unknown): void {
  if (["compact", "memory_consolidation", "review"].includes(candidate as string)) return;
  const value = requireRecord(candidate, "Codex sub-agent source is malformed.");
  const keys = Object.keys(value);
  if (keys.length !== 1) throw invalidPayload("Codex sub-agent source fields are invalid.");
  if (keys[0] === "other") {
    parsePrintableString(value.other, "Codex sub-agent source", 240);
    return;
  }
  if (keys[0] !== "thread_spawn") throw invalidPayload("Codex sub-agent source is unsupported.");
  const spawn = requireRecord(value.thread_spawn, "Codex thread-spawn source must be an object.");
  assertExactKeys(
    spawn,
    ["agent_nickname", "agent_path", "agent_role", "depth", "parent_thread_id"],
    "Codex thread-spawn source fields are invalid."
  );
  parsePayloadThreadId(spawn.parent_thread_id);
  parseNonnegativeSafeInteger(spawn.depth, "sub-agent depth");
  parseNullablePrintableString(spawn.agent_path, "Codex sub-agent path", 2_048);
  parseNullablePrintableString(spawn.agent_nickname, "Codex sub-agent nickname", 240);
  parseNullablePrintableString(spawn.agent_role, "Codex sub-agent role", 240);
}

function validateThreadExtra(candidate: unknown): void {
  if (candidate === null) return;
  const value = requireRecord(candidate, "Codex thread extra must be an object.");
  if (Object.keys(value).length !== 0) throw invalidPayload("Codex thread extra contains unsupported fields.");
}

function validateGitInfo(candidate: unknown): void {
  if (candidate === null) return;
  const value = requireRecord(candidate, "Codex thread Git info must be an object.");
  assertExactKeys(value, ["branch", "originUrl", "sha"], "Codex thread Git-info fields are invalid.");
  parseNullablePrintableString(value.sha, "Codex thread Git sha", 160);
  parseNullablePrintableString(value.branch, "Codex thread Git branch", 512);
  parseNullablePrintableString(value.originUrl, "Codex thread Git origin", 2_048);
}

function parseGeneration(port: CodexReconnectReadPort | CodexReconnectResubscribePort): number {
  if (port === null || typeof port !== "object" || !Number.isSafeInteger(port.generation) || port.generation <= 0) {
    throw new TypeError("Codex reconciliation runtime generation must be a positive safe integer.");
  }
  return port.generation;
}

function requireRuntimeVersion(compatibility: RuntimeCompatibility): string {
  if (
    !["degraded", "ready"].includes(compatibility.state) ||
    compatibility.observed_version === null ||
    compatibility.binding_id === null
  ) {
    throw adapterError(
      "handshake_failed",
      "Codex reconciliation requires a connected compatible runtime.",
      "not_sent",
      true
    );
  }
  return compatibility.observed_version;
}

function parseInputThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Codex reconciliation thread id is invalid.", parsed.error);
  return parsed.data;
}

function parsePayloadThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex reconciliation payload thread id is invalid.", parsed.error);
  return parsed.data;
}

function parseNullableThreadId(candidate: unknown, field: string): CodexThreadId | null {
  return candidate === null ? null : parsePayloadThreadIdWithLabel(candidate, field);
}

function parsePayloadThreadIdWithLabel(candidate: unknown, field: string): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload(`Codex reconciliation thread ${field} is invalid.`, parsed.error);
  return parsed.data;
}

function parseTurnId(candidate: unknown): CodexTurnId {
  const parsed = codexTurnIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex reconciliation turn id is invalid.", parsed.error);
  return parsed.data;
}

function parseAbsolutePath(candidate: unknown, label: string): AbsoluteCwd {
  const parsed = absoluteCwdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload(`${label} is invalid.`, parsed.error);
  return parsed.data;
}

function unixSecondsToIso(candidate: unknown, label: string): IsoTimestamp {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw invalidPayload(`Codex reconciliation ${label} must be a nonnegative finite Unix timestamp.`);
  }
  const milliseconds = candidate * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds > 8_640_000_000_000_000) {
    throw invalidPayload(`Codex reconciliation ${label} is outside the supported timestamp range.`);
  }
  return new Date(milliseconds).toISOString() as IsoTimestamp;
}

function validateBackwardsCursor(candidate: unknown, count: number, label: string): void {
  if (count === 0 && candidate !== null) {
    throw invalidPayload(`Codex reconciliation ${label} returned a backwards cursor for an empty page.`);
  }
  if (candidate !== null) parseCursor(candidate, `Codex reconciliation ${label} backwards cursor`);
}

function parseCursor(candidate: unknown, label: string): string {
  return parsePrintableString(candidate, label, 2_048);
}

function parseNullablePrintableString(candidate: unknown, label: string, maxLength: number): string | null {
  return candidate === null ? null : parsePrintableString(candidate, label, maxLength);
}

function parsePrintableString(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength) {
    throw invalidPayload(`${label} must be a nonempty bounded string.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw invalidPayload(`${label} contains a control character.`);
  }
  return candidate;
}

function parseBoundedText(candidate: unknown, label: string, maxLength: number, allowEmpty: boolean): string {
  if (typeof candidate !== "string" || (!allowEmpty && candidate.length === 0) || candidate.length > maxLength) {
    throw invalidPayload(`${label} must be bounded text.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if ((code <= 31 && ![9, 10, 13].includes(code)) || code === 127) {
      throw invalidPayload(`${label} contains an unsupported control character.`);
    }
  }
  return candidate;
}

function parseNonnegativeSafeInteger(candidate: unknown, label: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw invalidPayload(`Codex reconciliation ${label} must be a nonnegative safe integer.`);
  }
  return candidate as number;
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidPayload(message);
  return candidate as Record<string, unknown>;
}

function requireArray(candidate: unknown, message: string, maximum: number): unknown[] {
  if (!Array.isArray(candidate) || candidate.length > maximum) throw invalidPayload(message);
  return candidate;
}

function assertUniqueThreadIds(threads: readonly CodexThreadRecord[], message: string): void {
  if (new Set(threads.map((thread) => thread.id)).size !== threads.length) throw invalidPayload(message);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw invalidPayload(message);
}

function overloaded(message: string): HostDeckCodexAdapterError {
  return adapterError("broker_overloaded", message, "not_applicable", false);
}

function invalidInput(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return adapterError("invalid_protocol_message", message, "not_sent", true, cause);
}

function invalidPayload(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return adapterError("invalid_protocol_message", message, "not_applicable", false, cause);
}

function adapterError(
  code: CodexAdapterErrorCode,
  message: string,
  outcome: CodexOperationOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, {
    ...(cause === undefined ? {} : { cause }),
    outcome,
    retry_safe: retrySafe
  });
}
