import {
  defaultResourceBudget,
  type LoadedThreadCandidate,
  loadedThreadCandidateSchema,
  type NativeCodexHistoryTurn,
  nativeCodexHistoryTurnSchema,
  nativeCodexThreadIdSchema,
  nativeSessionContractLimits,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey,
  sharedCodexAbsolutePathSchema,
  sharedCodexRuntimeContractLimits,
  sharedCodexRuntimeVersion
} from "@hostdeck/contracts";
import type { CodexTurnId, IsoTimestamp, NativeCodexThreadId } from "@hostdeck/core";
import { codexBindingDescriptor } from "./binding.js";
import type { CodexRequestInput } from "./broker.js";
import type { CodexConnectionNotification } from "./connection.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { normalizeCodexHistoryItem } from "./event-normalizer-items.js";
import {
  rawThreadSchema,
  turnSchema
} from "./event-normalizer-schemas.js";
import type { ThreadLoadedListParams } from "./generated/v2/ThreadLoadedListParams.js";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams.js";

export type CodexLoadedThreadErrorCode =
  | "identity_changed"
  | "pending_materialization";

export class HostDeckCodexLoadedThreadError extends Error {
  constructor(
    readonly code: CodexLoadedThreadErrorCode,
    message: string,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckCodexLoadedThreadError";
  }
}

export interface CodexLoadedThreadRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexLoadedThreadClientOptions {
  readonly page_size?: number;
  readonly max_pages?: number;
  readonly max_loaded_reads?: number;
  readonly max_history_items_per_turn?: number;
  readonly read_timeout_ms?: number;
}

export interface CodexLoadedThreadHistory {
  readonly turns: readonly NativeCodexHistoryTurn[];
  readonly active_turn_id: CodexTurnId | null;
  readonly active_turn_started_at: IsoTimestamp | null;
  readonly truncated_before: boolean;
}

export interface CodexLoadedThreadSnapshot extends CodexLoadedThreadHistory {
  readonly candidate: LoadedThreadCandidate;
  readonly runtime_model: string;
  readonly reasoning_effort: string | null;
}

export interface CodexLoadedThreadClient {
  readonly runtime_version: string;
  readonly listLoadedThreadIds: (signal?: AbortSignal) => Promise<readonly NativeCodexThreadId[]>;
  readonly readCandidate: (
    threadId: NativeCodexThreadId | string,
    signal?: AbortSignal
  ) => Promise<LoadedThreadCandidate>;
  readonly candidateFromStartedNotification: (
    notification: CodexConnectionNotification
  ) => LoadedThreadCandidate;
  readonly subscribeAndReadSnapshot: (
    candidate: LoadedThreadCandidate,
    signal?: AbortSignal
  ) => Promise<CodexLoadedThreadSnapshot>;
}

interface ParsedOptions {
  readonly page_size: number;
  readonly max_pages: number;
  readonly max_loaded_reads: number;
  readonly max_history_items_per_turn: number;
  readonly read_timeout_ms: number;
}

type ParsedRawThread = ReturnType<typeof rawThreadSchema.parse>;

const loadedListResultKeys = ["data", "nextCursor"] as const;
const pagedResultKeys = ["backwardsCursor", "data", "nextCursor"] as const;
const resumeResultKeys = [
  "activePermissionProfile",
  "approvalPolicy",
  "approvalsReviewer",
  "cwd",
  "initialTurnsPage",
  "instructionSources",
  "itemsBackwardsCursor",
  "model",
  "modelProvider",
  "multiAgentMode",
  "reasoningEffort",
  "runtimeWorkspaceRoots",
  "sandbox",
  "serviceTier",
  "thread",
  "turnsBackwardsCursor"
] as const;
const allowedMethods = new Set([
  "thread/loaded/list",
  "thread/read",
  "thread/resume",
  "thread/turns/list"
]);
const selectedNotificationMethods = new Set(codexBindingDescriptor.surface.server_notifications);
const maximumPrivatePathLength = 12_000;
const maximumResumePaths = 256;
const invalidCwdSentinel = "/__hostdeck_invalid_loaded_cwd__";

const defaults = Object.freeze({
  page_size: defaultResourceBudget.protocol_thread_page_size,
  max_pages: defaultResourceBudget.protocol_thread_max_pages,
  max_loaded_reads: defaultResourceBudget.protocol_thread_max_loaded_reads,
  max_history_items_per_turn: nativeSessionContractLimits.historyItemsPerTurn,
  read_timeout_ms: defaultResourceBudget.protocol_read_timeout_ms
});

export function createCodexLoadedThreadClient(
  port: CodexLoadedThreadRequestPort,
  options: CodexLoadedThreadClientOptions = {}
): CodexLoadedThreadClient {
  const client = new DefaultCodexLoadedThreadClient(guardPort(port), parseOptions(options));
  return Object.freeze({
    get runtime_version() {
      return client.runtime_version;
    },
    listLoadedThreadIds: (signal?: AbortSignal) => client.listLoadedThreadIds(signal),
    readCandidate: (threadId: NativeCodexThreadId | string, signal?: AbortSignal) =>
      client.readCandidate(threadId, signal),
    candidateFromStartedNotification: (notification: CodexConnectionNotification) =>
      client.candidateFromStartedNotification(notification),
    subscribeAndReadSnapshot: (candidate: LoadedThreadCandidate, signal?: AbortSignal) =>
      client.subscribeAndReadSnapshot(candidate, signal)
  });
}

export function codexLoadedThreadNotificationTarget(
  notification: CodexConnectionNotification
): NativeCodexThreadId | null {
  if (!selectedNotificationMethods.has(notification.method)) return null;
  if (notification.method === "account/rateLimits/updated") return null;
  const params = requireRecord(notification.params, "Codex selected notification params must be an object.");
  if (notification.method === "thread/started") {
    const thread = requireRecord(params.thread, "Codex thread/started identity must be an object.");
    return parsePayloadThreadId(thread.id);
  }
  return parsePayloadThreadId(params.threadId);
}

class DefaultCodexLoadedThreadClient implements CodexLoadedThreadClient {
  constructor(
    private readonly port: CodexLoadedThreadRequestPort,
    private readonly options: ParsedOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    if (
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version !== sharedCodexRuntimeVersion ||
      compatibility.binding_id === null ||
      compatibility.mutation_policy !== "allowed"
    ) {
      throw new HostDeckCodexAdapterError(
        "handshake_failed",
        "Loaded-thread access requires the exact compatible shared Codex runtime.",
        { outcome: "not_sent", retry_safe: true }
      );
    }
    return compatibility.observed_version;
  }

  async listLoadedThreadIds(signal?: AbortSignal): Promise<readonly NativeCodexThreadId[]> {
    void this.runtime_version;
    const ids: NativeCodexThreadId[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < this.options.max_pages; pageNumber += 1) {
      const params = { cursor, limit: this.options.page_size } satisfies ThreadLoadedListParams;
      const result = requireRecord(
        await this.port.request({
          method: "thread/loaded/list",
          params,
          kind: "read",
          timeout_ms: this.options.read_timeout_ms,
          ...(signal === undefined ? {} : { signal })
        }),
        "Codex loaded-thread list result must be an object."
      );
      assertExactKeys(result, loadedListResultKeys, "Codex loaded-thread list fields are invalid.");
      const page = requireArray(
        result.data,
        this.options.page_size,
        "Codex loaded-thread list exceeded its requested page bound."
      ).map((candidate) => parsePayloadThreadId(candidate));
      for (const id of page) {
        if (seenIds.has(id)) throw invalidPayload("Codex loaded-thread list repeated a native thread id.");
        seenIds.add(id);
        ids.push(id);
        if (ids.length > this.options.max_loaded_reads) {
          throw overloaded("Codex loaded-thread reconciliation exceeded its configured thread bound.");
        }
      }

      if (result.nextCursor === null) break;
      const nextCursor = parseCursor(result.nextCursor, "Codex loaded-thread cursor");
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw invalidPayload("Codex loaded-thread pagination cursor repeated.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === this.options.max_pages - 1) {
        throw overloaded("Codex loaded-thread reconciliation exceeded its configured page bound.");
      }
    }

    ids.sort();
    return Object.freeze(ids);
  }

  async readCandidate(
    threadId: NativeCodexThreadId | string,
    signal?: AbortSignal
  ): Promise<LoadedThreadCandidate> {
    const runtimeVersion = this.runtime_version;
    const parsedThreadId = parseInputThreadId(threadId);
    const params = { threadId: parsedThreadId, includeTurns: false } satisfies ThreadReadParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/read",
        params,
        kind: "read",
        timeout_ms: this.options.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex loaded-thread read result must be an object."
    );
    assertExactKeys(result, ["thread"], "Codex loaded-thread read fields are invalid.");
    const candidate = normalizeCandidate(result.thread, runtimeVersion);
    if (candidate.native_thread_id !== parsedThreadId) {
      throw invalidPayload("Codex loaded-thread read returned a different native thread id.");
    }
    return candidate;
  }

  candidateFromStartedNotification(
    notification: CodexConnectionNotification
  ): LoadedThreadCandidate {
    const runtimeVersion = this.runtime_version;
    if (notification.method !== "thread/started") {
      throw invalidInput("Loaded-thread notification metadata requires thread/started.");
    }
    const params = requireRecord(notification.params, "Codex thread/started params must be an object.");
    assertExactKeys(params, ["thread"], "Codex thread/started params fields are invalid.");
    return normalizeCandidate(params.thread, runtimeVersion);
  }

  async subscribeAndReadSnapshot(
    expected: LoadedThreadCandidate,
    signal?: AbortSignal
  ): Promise<CodexLoadedThreadSnapshot> {
    const runtimeVersion = this.runtime_version;
    const parsedExpected = loadedThreadCandidateSchema.safeParse(expected);
    if (!parsedExpected.success || parsedExpected.data.eligibility.state !== "eligible") {
      throw invalidInput("Loaded-thread subscription requires one eligible normalized candidate.");
    }
    const threadId = parsedExpected.data.native_thread_id;
    const params = { threadId, excludeTurns: true } satisfies ThreadResumeParams;
    let rawResult: unknown;
    try {
      rawResult = await this.port.request({
        method: "thread/resume",
        params,
        kind: "read",
        timeout_ms: this.options.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      });
    } catch (error) {
      if (isPendingMaterialization(error)) {
        throw new HostDeckCodexLoadedThreadError(
          "pending_materialization",
          "Loaded Codex thread has not materialized durable history yet.",
          true,
          { cause: error }
        );
      }
      throw error;
    }

    const resumed = requireRecord(rawResult, "Codex loaded-thread resume result must be an object.");
    assertExactKeys(resumed, resumeResultKeys, "Codex loaded-thread resume fields are invalid.");
    const resumeEnvelope = validateResumeEnvelope(resumed);
    const resumeCandidate = normalizeCandidate(resumed.thread, runtimeVersion);
    const resumeRaw = parseRawThread(resumed.thread).raw;
    if (
      resumeEnvelope.cwd !== resumeCandidate.cwd ||
      resumeEnvelope.model_provider !== resumeRaw.modelProvider
    ) {
      throw invalidPayload("Codex loaded-thread resume envelope contradicts its thread identity.");
    }
    assertStableIdentity(parsedExpected.data, resumeCandidate, "resume");

    const history = await this.readHistory(threadId, signal);
    const current = await this.readCandidate(threadId, signal);
    assertStableIdentity(resumeCandidate, current, "history read");
    assertRuntimeHistoryConsistency(current, history);

    return deepFreeze({
      candidate: current,
      turns: history.turns,
      active_turn_id: history.active_turn_id,
      active_turn_started_at: history.active_turn_started_at,
      truncated_before: history.truncated_before,
      runtime_model: parsePrintableString(resumed.model, "Codex loaded-thread runtime model", 160),
      reasoning_effort:
        resumed.reasoningEffort === null
          ? null
          : parsePrintableString(resumed.reasoningEffort, "Codex loaded-thread reasoning effort", 80)
    });
  }

  private async readHistory(
    threadId: NativeCodexThreadId,
    signal?: AbortSignal
  ): Promise<CodexLoadedThreadHistory> {
    const params = {
      threadId,
      cursor: null,
      limit: sharedCodexRuntimeContractLimits.recentTurns,
      sortDirection: "desc",
      itemsView: "summary"
    } satisfies ThreadTurnsListParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/turns/list",
        params,
        kind: "read",
        timeout_ms: this.options.read_timeout_ms,
        ...(signal === undefined ? {} : { signal })
      }),
      "Codex loaded-thread history result must be an object."
    );
    assertExactKeys(result, pagedResultKeys, "Codex loaded-thread history fields are invalid.");
    const page = requireArray(
      result.data,
      sharedCodexRuntimeContractLimits.recentTurns,
      "Codex loaded-thread history exceeded its requested turn bound."
    );
    validateBackwardsCursor(result.backwardsCursor, page.length, "loaded-thread history");
    const nextCursor = result.nextCursor === null
      ? null
      : parseCursor(result.nextCursor, "Codex loaded-thread history cursor");
    const turns: NativeCodexHistoryTurn[] = [];
    let activeTurnId: CodexTurnId | null = null;
    let activeTurnStartedAt: IsoTimestamp | null = null;
    let truncatedBefore = nextCursor !== null;

    for (const [index, candidate] of page.entries()) {
      const parsed = turnSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.itemsView !== "summary") {
        throw invalidPayload("Codex loaded-thread history contains malformed turn data.");
      }
      const turn = parsed.data;
      if (turn.status === "inProgress") {
        if (
          index !== 0 ||
          activeTurnId !== null ||
          turn.startedAt === null ||
          turn.completedAt !== null ||
          turn.durationMs !== null
        ) {
          throw invalidPayload("Codex loaded-thread history contains contradictory active work.");
        }
        activeTurnId = turn.id;
        activeTurnStartedAt = unixSecondsToIso(turn.startedAt, "loaded-thread active turn start");
        continue;
      }
      const normalized = normalizeCodexTerminalHistoryTurn(turn, this.options.max_history_items_per_turn);
      turns.push(normalized.turn);
      truncatedBefore ||= normalized.truncated_before;
    }
    turns.reverse();
    assertUniqueHistory(turns);
    return deepFreeze({
      turns,
      active_turn_id: activeTurnId,
      active_turn_started_at: activeTurnStartedAt,
      truncated_before: truncatedBefore
    });
  }
}

function normalizeCandidate(
  candidate: unknown,
  runtimeVersion: string
): LoadedThreadCandidate {
  const { raw, cwd } = parseRawThread(candidate);
  const nativeThreadId = parsePayloadThreadId(raw.id);
  const parentThreadId = raw.parentThreadId === null ? null : parsePayloadThreadId(raw.parentThreadId);
  const forkedFromId = raw.forkedFromId === null ? null : parsePayloadThreadId(raw.forkedFromId);
  const source = normalizeSource(raw.source);
  const status = normalizeStatus(raw.status);
  const rootThreadId = deriveRootThreadId(nativeThreadId, parentThreadId, raw.sessionId);
  const normalized = {
    native_thread_id: nativeThreadId,
    root_thread_id: rootThreadId,
    parent_thread_id: parentThreadId,
    forked_from_id: forkedFromId,
    name: raw.name,
    project_cue: codexLoadedThreadProjectCue(cwd),
    cwd,
    source,
    ephemeral: raw.ephemeral,
    archived: false,
    // cliVersion is creation provenance retained by Codex. The admitted app-server
    // version is the runtime currently loading and serving this thread.
    runtime_version: runtimeVersion,
    created_at: unixSecondsToIso(raw.createdAt, "loaded-thread creation"),
    updated_at: unixSecondsToIso(raw.updatedAt, "loaded-thread update"),
    status: status.status,
    active_flags: status.active_flags,
    eligibility: { state: "eligible" as const, reason: null }
  };
  const reason = rejectionReason(normalized);
  const parsed = loadedThreadCandidateSchema.safeParse({
    ...normalized,
    eligibility:
      reason === null
        ? { state: "eligible", reason: null }
        : { state: "ineligible", reason }
  });
  if (!parsed.success) throw invalidPayload("Codex loaded-thread metadata cannot be normalized.");
  return deepFreeze(parsed.data);
}

function parseRawThread(candidate: unknown): { readonly raw: ParsedRawThread; readonly cwd: string } {
  const parsed = rawThreadSchema.safeParse(candidate);
  if (parsed.success) return { raw: parsed.data, cwd: parsed.data.cwd };
  if (!isRecord(candidate)) throw invalidPayload("Codex loaded-thread metadata must be an object.");
  const cwd = candidate.cwd;
  if (
    typeof cwd !== "string" ||
    cwd.length < 1 ||
    cwd.length > maximumPrivatePathLength ||
    cwd.includes("\0") ||
    sharedCodexAbsolutePathSchema.safeParse(cwd).success
  ) {
    throw invalidPayload("Codex loaded-thread metadata is malformed.");
  }
  const withValidCwd = rawThreadSchema.safeParse({ ...candidate, cwd: invalidCwdSentinel });
  if (!withValidCwd.success) throw invalidPayload("Codex loaded-thread metadata is malformed.");
  return { raw: withValidCwd.data, cwd };
}

function rejectionReason(
  value: Omit<LoadedThreadCandidate, "eligibility">
): Exclude<LoadedThreadCandidate["eligibility"], { readonly state: "eligible" }>["reason"] | null {
  if (
    value.updated_at < value.created_at ||
    value.parent_thread_id === value.native_thread_id ||
    value.forked_from_id === value.native_thread_id ||
    (value.root_thread_id === value.native_thread_id && value.parent_thread_id !== null) ||
    (value.source === "subagent" && value.root_thread_id === value.native_thread_id)
  ) return "contradictory_metadata";
  if (value.runtime_version !== sharedCodexRuntimeVersion) return "incompatible_runtime";
  if (value.archived) return "archived";
  if (value.ephemeral) return "ephemeral";
  if (
    value.root_thread_id !== value.native_thread_id ||
    value.parent_thread_id !== null ||
    value.source === "subagent"
  ) return "child_or_subagent";
  if (!["cli", "app_server", "vscode"].includes(value.source)) return "non_interactive_source";
  if (!sharedCodexAbsolutePathSchema.safeParse(value.cwd).success) return "invalid_cwd";
  if (value.status === "not_loaded") return "missing";
  if (value.status === "system_error") return "runtime_error";
  return null;
}

function normalizeSource(source: ParsedRawThread["source"]): LoadedThreadCandidate["source"] {
  if (source === "appServer") return "app_server";
  if (source === "cli" || source === "vscode" || source === "exec" || source === "unknown") return source;
  if ("subAgent" in source) return "subagent";
  return "custom";
}

function normalizeStatus(status: ParsedRawThread["status"]): {
  readonly status: LoadedThreadCandidate["status"];
  readonly active_flags: LoadedThreadCandidate["active_flags"];
} {
  if (status.type === "idle") return { status: "idle", active_flags: [] };
  if (status.type === "notLoaded") return { status: "not_loaded", active_flags: [] };
  if (status.type === "systemError") return { status: "system_error", active_flags: [] };
  const flags = status.activeFlags.map((flag) =>
    flag === "waitingOnApproval" ? "waiting_on_approval" as const : "waiting_on_user_input" as const
  );
  if (new Set(flags).size !== flags.length) {
    throw invalidPayload("Codex loaded-thread status repeats an active flag.");
  }
  return { status: "active", active_flags: flags };
}

function deriveRootThreadId(
  threadId: NativeCodexThreadId,
  parentThreadId: NativeCodexThreadId | null,
  sessionId: string
): NativeCodexThreadId {
  if (parentThreadId === null) return threadId;
  const session = nativeCodexThreadIdSchema.safeParse(sessionId);
  return session.success && session.data !== threadId ? session.data : parentThreadId;
}

export function codexLoadedThreadProjectCue(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const leaf = trimmed.slice(separator + 1);
  const basename = leaf.length > 0 && !/^[A-Za-z]:$/u.test(leaf) ? leaf : "root";
  return basename.slice(0, sharedCodexRuntimeContractLimits.projectCueLength) || "root";
}

export function normalizeCodexTerminalHistoryTurn(
  turn: ReturnType<typeof turnSchema.parse>,
  maxItems: number
): { readonly turn: NativeCodexHistoryTurn; readonly truncated_before: boolean } {
  if (turn.status === "inProgress" || turn.startedAt === null) {
    throw invalidPayload("Codex loaded-thread terminal history is missing required lifecycle data.");
  }
  if (turn.status !== "interrupted" && turn.completedAt === null) {
    throw invalidPayload("Codex loaded-thread terminal history is missing its completion time.");
  }
  if (turn.items.length > maxItems) {
    throw overloaded("Codex loaded-thread history exceeded its configured item bound.");
  }
  const messages: Array<NativeCodexHistoryTurn["messages"][number] & { readonly source_index: number }> = [];
  const seenItems = new Set<string>();
  let latestTruncatedMessageIndex = -1;
  for (const [index, item] of turn.items.entries()) {
    let normalized: ReturnType<typeof normalizeCodexHistoryItem>;
    try {
      normalized = normalizeCodexHistoryItem(item, "thread/turns/list");
    } catch (error) {
      throw invalidPayload("Codex loaded-thread history contains an unsupported item.", error);
    }
    if (seenItems.has(normalized.id)) {
      throw invalidPayload("Codex loaded-thread history repeats an item id.");
    }
    seenItems.add(normalized.id);
    const message = normalized.message;
    if (message === null || message.text === null || message.text.length === 0) continue;
    if (message.category !== "agent_message" && message.category !== "user_message") continue;
    if (message.content_state === "truncated" || message.content_state === "redacted_and_truncated") {
      latestTruncatedMessageIndex = index;
      continue;
    }
    messages.push({
      source_index: index,
      item_id: message.id,
      role: message.category === "agent_message" ? "agent" : "user",
      text: message.text
    });
  }
  const suffix = messages.filter((message) => message.source_index > latestTruncatedMessageIndex);
  const retained = suffix.slice(-nativeSessionContractLimits.messagesPerTurn).map(({ source_index: _index, ...message }) =>
    nativeCodexHistoryTurnSchema.shape.messages.element.parse(message)
  );
  const parsed = nativeCodexHistoryTurnSchema.safeParse({
    turn_id: turn.id,
    status: turn.status,
    started_at: unixSecondsToIso(turn.startedAt, "loaded-thread turn start"),
    completed_at: turn.completedAt === null
      ? null
      : unixSecondsToIso(turn.completedAt, "loaded-thread turn completion"),
    messages: retained
  });
  if (!parsed.success) throw invalidPayload("Codex loaded-thread history cannot be normalized.", parsed.error);
  return {
    turn: deepFreeze(parsed.data),
    truncated_before: latestTruncatedMessageIndex >= 0 || suffix.length > retained.length
  };
}

function assertUniqueHistory(turns: readonly NativeCodexHistoryTurn[]): void {
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  let priorStartedAt: string | null = null;
  for (const turn of turns) {
    if (turnIds.has(turn.turn_id)) throw invalidPayload("Codex loaded-thread history repeats a turn id.");
    turnIds.add(turn.turn_id);
    if (priorStartedAt !== null && turn.started_at < priorStartedAt) {
      throw invalidPayload("Codex loaded-thread history is not chronological.");
    }
    priorStartedAt = turn.started_at;
    for (const message of turn.messages) {
      if (itemIds.has(message.item_id)) throw invalidPayload("Codex loaded-thread history repeats a message item id.");
      itemIds.add(message.item_id);
    }
  }
}

function assertStableIdentity(
  expected: LoadedThreadCandidate,
  observed: LoadedThreadCandidate,
  phase: string
): void {
  if (
    expected.native_thread_id !== observed.native_thread_id ||
    expected.root_thread_id !== observed.root_thread_id ||
    expected.parent_thread_id !== observed.parent_thread_id ||
    expected.forked_from_id !== observed.forked_from_id ||
    expected.project_cue !== observed.project_cue ||
    expected.cwd !== observed.cwd ||
    expected.source !== observed.source ||
    expected.ephemeral !== observed.ephemeral ||
    expected.archived !== observed.archived ||
    expected.runtime_version !== observed.runtime_version ||
    expected.created_at !== observed.created_at
  ) {
    throw new HostDeckCodexLoadedThreadError(
      "identity_changed",
      `Loaded Codex thread identity changed during ${phase}.`,
      true
    );
  }
  if (observed.eligibility.state !== "eligible") {
    throw new HostDeckCodexLoadedThreadError(
      "identity_changed",
      `Loaded Codex thread became ineligible during ${phase}.`,
      true
    );
  }
}

function assertRuntimeHistoryConsistency(
  candidate: LoadedThreadCandidate,
  history: CodexLoadedThreadHistory
): void {
  const active = history.active_turn_id !== null;
  if ((candidate.status === "active") !== active) {
    throw new HostDeckCodexLoadedThreadError(
      "identity_changed",
      "Loaded Codex thread status changed while bounded history was read.",
      true
    );
  }
}

function validateResumeEnvelope(result: Record<string, unknown>): {
  readonly cwd: string;
  readonly model_provider: string;
} {
  if (result.initialTurnsPage !== null) {
    throw invalidPayload("Codex loaded-thread resume returned unrequested turn history.");
  }
  if (result.turnsBackwardsCursor !== null) parseCursor(result.turnsBackwardsCursor, "Codex loaded-thread turns cursor");
  if (result.itemsBackwardsCursor !== null) parseCursor(result.itemsBackwardsCursor, "Codex loaded-thread items cursor");
  const modelProvider = parsePrintableString(result.modelProvider, "Codex loaded-thread model provider", 120);
  const cwd = sharedCodexAbsolutePathSchema.safeParse(result.cwd);
  if (!cwd.success) throw invalidPayload("Codex loaded-thread resume cwd is invalid.");
  if (result.serviceTier !== null) parsePrintableString(result.serviceTier, "Codex loaded-thread service tier", 120);
  parsePathArray(result.runtimeWorkspaceRoots, true, "Codex loaded-thread runtime workspace roots");
  parsePathArray(result.instructionSources, false, "Codex loaded-thread instruction sources");
  validateApprovalPolicy(result.approvalPolicy);
  if (!["user", "auto_review", "guardian_subagent"].includes(result.approvalsReviewer as string)) {
    throw invalidPayload("Codex loaded-thread approvals reviewer is invalid.");
  }
  validateSandbox(result.sandbox);
  validatePermissionProfile(result.activePermissionProfile);
  validateMultiAgentMode(result.multiAgentMode);
  return { cwd: cwd.data, model_provider: modelProvider };
}

function validateApprovalPolicy(candidate: unknown): void {
  if (["never", "on-request", "untrusted"].includes(candidate as string)) return;
  const value = requireRecord(candidate, "Codex loaded-thread approval policy is invalid.");
  assertExactKeys(value, ["granular"], "Codex loaded-thread approval policy fields are invalid.");
  const granular = requireRecord(value.granular, "Codex loaded-thread granular approval policy is invalid.");
  const keys = ["mcp_elicitations", "request_permissions", "rules", "sandbox_approval", "skill_approval"] as const;
  assertExactKeys(granular, keys, "Codex loaded-thread granular approval fields are invalid.");
  for (const key of keys) {
    if (typeof granular[key] !== "boolean") throw invalidPayload("Codex loaded-thread granular approval value is invalid.");
  }
}

function validateSandbox(candidate: unknown): void {
  const value = requireRecord(candidate, "Codex loaded-thread sandbox policy is invalid.");
  if (value.type === "dangerFullAccess") {
    assertExactKeys(value, ["type"], "Codex loaded-thread sandbox fields are invalid.");
    return;
  }
  if (value.type === "readOnly") {
    assertExactKeys(value, ["networkAccess", "type"], "Codex loaded-thread sandbox fields are invalid.");
    if (typeof value.networkAccess !== "boolean") throw invalidPayload("Codex loaded-thread sandbox network access is invalid.");
    return;
  }
  if (value.type === "externalSandbox") {
    assertExactKeys(value, ["networkAccess", "type"], "Codex loaded-thread sandbox fields are invalid.");
    if (!["enabled", "restricted"].includes(value.networkAccess as string)) {
      throw invalidPayload("Codex loaded-thread external sandbox network access is invalid.");
    }
    return;
  }
  if (value.type !== "workspaceWrite") throw invalidPayload("Codex loaded-thread sandbox type is invalid.");
  assertExactKeys(
    value,
    ["excludeSlashTmp", "excludeTmpdirEnvVar", "networkAccess", "type", "writableRoots"],
    "Codex loaded-thread sandbox fields are invalid."
  );
  if (
    typeof value.networkAccess !== "boolean" ||
    typeof value.excludeTmpdirEnvVar !== "boolean" ||
    typeof value.excludeSlashTmp !== "boolean"
  ) throw invalidPayload("Codex loaded-thread workspace sandbox flags are invalid.");
  parsePathArray(value.writableRoots, true, "Codex loaded-thread sandbox writable roots");
}

function validatePermissionProfile(candidate: unknown): void {
  if (candidate === null) return;
  const value = requireRecord(candidate, "Codex loaded-thread permission profile is invalid.");
  assertExactKeys(value, ["extends", "id"], "Codex loaded-thread permission profile fields are invalid.");
  parsePrintableString(value.id, "Codex loaded-thread permission profile id", 240);
  if (value.extends !== null) parsePrintableString(value.extends, "Codex loaded-thread permission profile parent", 240);
}

function validateMultiAgentMode(candidate: unknown): void {
  if (typeof candidate === "string") {
    if (!["explicitRequestOnly", "proactive"].includes(candidate)) {
      throw invalidPayload("Codex loaded-thread multi-agent mode is invalid.");
    }
    return;
  }
  const value = requireRecord(candidate, "Codex loaded-thread multi-agent mode is invalid.");
  assertExactKeys(value, ["custom"], "Codex loaded-thread custom multi-agent fields are invalid.");
  parsePrintableString(value.custom, "Codex loaded-thread custom multi-agent mode", 12_000);
}

function parsePathArray(candidate: unknown, absolute: boolean, label: string): void {
  const paths = requireArray(candidate, maximumResumePaths, `${label} exceed their configured bound.`);
  for (const path of paths) {
    if (absolute) {
      if (!sharedCodexAbsolutePathSchema.safeParse(path).success) {
        throw invalidPayload(`${label} contain an invalid absolute path.`);
      }
    } else parsePrintableString(path, label, maximumPrivatePathLength);
  }
}

function guardPort(port: CodexLoadedThreadRequestPort): CodexLoadedThreadRequestPort {
  if (port === null || typeof port !== "object" || typeof port.request !== "function") {
    throw new TypeError("Codex loaded-thread client requires a runtime request port.");
  }
  return Object.freeze({
    get compatibility() {
      return port.compatibility;
    },
    request(input: CodexRequestInput): Promise<unknown> {
      if (input === null || typeof input !== "object" || input.kind !== "read" || !allowedMethods.has(input.method)) {
        return Promise.reject(invalidInput("Codex loaded-thread client attempted an unreviewed runtime method."));
      }
      return port.request(input);
    }
  });
}

function parseOptions(options: CodexLoadedThreadClientOptions): ParsedOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Codex loaded-thread client options must be an object.");
  }
  const expected = ["max_history_items_per_turn", "max_loaded_reads", "max_pages", "page_size", "read_timeout_ms"];
  if (Object.keys(options).some((key) => !expected.includes(key))) {
    throw new TypeError("Codex loaded-thread client options contain an unsupported field.");
  }
  return Object.freeze({
    page_size: boundedOption(
      options.page_size,
      defaults.page_size,
      resourceBudgetDefinitionByKey.protocol_thread_page_size.minimum,
      resourceBudgetDefinitionByKey.protocol_thread_page_size.maximum,
      "page_size"
    ),
    max_pages: boundedOption(
      options.max_pages,
      defaults.max_pages,
      resourceBudgetDefinitionByKey.protocol_thread_max_pages.minimum,
      resourceBudgetDefinitionByKey.protocol_thread_max_pages.maximum,
      "max_pages"
    ),
    max_loaded_reads: boundedOption(
      options.max_loaded_reads,
      defaults.max_loaded_reads,
      resourceBudgetDefinitionByKey.protocol_thread_max_loaded_reads.minimum,
      resourceBudgetDefinitionByKey.protocol_thread_max_loaded_reads.maximum,
      "max_loaded_reads"
    ),
    max_history_items_per_turn: boundedOption(
      options.max_history_items_per_turn,
      defaults.max_history_items_per_turn,
      1,
      4_096,
      "max_history_items_per_turn"
    ),
    read_timeout_ms: boundedOption(
      options.read_timeout_ms,
      defaults.read_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.minimum,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms.maximum,
      "read_timeout_ms"
    )
  });
}

function boundedOption(
  candidate: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const value = candidate ?? fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Codex loaded-thread ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function parseInputThreadId(candidate: unknown): NativeCodexThreadId {
  const parsed = nativeCodexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Loaded Codex thread id is invalid.");
  return parsed.data;
}

function parsePayloadThreadId(candidate: unknown): NativeCodexThreadId {
  const parsed = nativeCodexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex loaded-thread payload id is invalid.");
  return parsed.data;
}

function unixSecondsToIso(candidate: number, label: string): IsoTimestamp {
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 253_402_300_799) {
    throw invalidPayload(`Codex ${label} timestamp is invalid.`);
  }
  return new Date(candidate * 1_000).toISOString() as IsoTimestamp;
}

function validateBackwardsCursor(candidate: unknown, count: number, label: string): void {
  if (count === 0 && candidate !== null) throw invalidPayload(`Codex ${label} returned a cursor for an empty page.`);
  if (count > 0 && candidate === null) throw invalidPayload(`Codex ${label} omitted its backwards cursor.`);
  if (candidate !== null) parseCursor(candidate, `Codex ${label} backwards cursor`);
}

function parseCursor(candidate: unknown, label: string): string {
  return parsePrintableString(candidate, label, 2_048);
}

function parsePrintableString(candidate: unknown, label: string, maximum: number): string {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > maximum) {
    throw invalidPayload(`${label} must be a nonempty bounded string.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw invalidPayload(`${label} contains an unsupported control character.`);
  }
  return candidate;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw invalidPayload(message);
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (!isRecord(candidate)) throw invalidPayload(message);
  return candidate;
}

function requireArray(candidate: unknown, maximum: number, message: string): unknown[] {
  if (!Array.isArray(candidate) || candidate.length > maximum) throw invalidPayload(message);
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function isPendingMaterialization(error: unknown): boolean {
  return error instanceof HostDeckCodexAdapterError &&
    error.code === "remote_error" &&
    error.outcome === "remote_rejected" &&
    error.retry_safe &&
    error.rpc_code === -32_600 &&
    error.message.toLowerCase().includes("no rollout found");
}

function invalidInput(message: string): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_protocol_message", message, {
    outcome: "not_sent",
    retry_safe: true
  });
}

function invalidPayload(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_protocol_message", message, {
    cause,
    outcome: "not_applicable",
    retry_safe: false
  });
}

function overloaded(message: string): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("broker_overloaded", message, {
    outcome: "not_applicable",
    retry_safe: false
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
