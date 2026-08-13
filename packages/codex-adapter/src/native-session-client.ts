import {
  absoluteCwdSchema,
  codexThreadIdSchema,
  defaultResourceBudget,
  type NativeCodexAdoptionSnapshot,
  type NativeCodexHistoryMessage,
  type NativeCodexHistoryTurn,
  type NativeCodexThreadIdentity,
  type NativeSessionDiscoveryRequest,
  type NativeSessionDiscoveryResponse,
  nativeCodexAdoptionSnapshotSchema,
  nativeCodexThreadIdentitySchema,
  nativeSessionContractLimits,
  nativeSessionDiscoveryRequestSchema,
  nativeSessionDiscoveryResponseSchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey
} from "@hostdeck/contracts";
import type { CodexThreadId, IsoTimestamp, OperationDeadline } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { normalizeCodexItem } from "./event-normalizer-items.js";
import { rawThreadSchema, turnSchema } from "./event-normalizer-schemas.js";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.js";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams.js";
import { codexRequestOptionsFromDeadline } from "./request-deadline.js";

export type CodexNativeSessionErrorCode = "identity_changed" | "thread_ineligible";

export class HostDeckCodexNativeSessionError extends Error {
  constructor(
    readonly code: CodexNativeSessionErrorCode,
    message: string,
    readonly retry_safe: boolean
  ) {
    super(message);
    this.name = "HostDeckCodexNativeSessionError";
  }
}

export interface CodexNativeSessionResumeResult {
  readonly thread: NativeCodexThreadIdentity;
  readonly runtime_model: string;
  readonly reasoning_effort: string | null;
}

export interface CodexNativeSessionRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexNativeSessionClientOptions {
  readonly page_size?: number;
  readonly max_pages?: number;
  readonly max_entries?: number;
  readonly max_history_items_per_turn?: number;
  readonly read_timeout_ms?: number;
}

export interface CodexNativeSessionClient {
  readonly runtime_version: string;
  readonly discover: (
    input?: NativeSessionDiscoveryRequest,
    deadline?: OperationDeadline
  ) => Promise<NativeSessionDiscoveryResponse>;
  readonly readIdentity: (
    threadId: CodexThreadId | string,
    deadline?: OperationDeadline
  ) => Promise<NativeCodexThreadIdentity | null>;
  readonly readAdoptionSnapshot: (
    threadId: CodexThreadId | string,
    deadline?: OperationDeadline
  ) => Promise<NativeCodexAdoptionSnapshot>;
  readonly resume: (
    threadId: CodexThreadId | string,
    deadline?: OperationDeadline
  ) => Promise<CodexNativeSessionResumeResult>;
}

interface ParsedOptions {
  readonly page_size: number;
  readonly max_pages: number;
  readonly max_entries: number;
  readonly max_history_items_per_turn: number;
  readonly read_timeout_ms: number;
}

type ParsedRawThread = ReturnType<typeof rawThreadSchema.parse>;

const threadListResultKeys = ["backwardsCursor", "data", "nextCursor"] as const;
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
const allowedMethods = new Set(["thread/list", "thread/read", "thread/resume", "thread/turns/list"]);
const maximumResumePaths = 256;
const maximumPrivatePathLength = 12_000;

const defaults = Object.freeze({
  page_size: defaultResourceBudget.protocol_thread_page_size,
  max_pages: defaultResourceBudget.protocol_thread_max_pages,
  max_entries: 4_096,
  max_history_items_per_turn: nativeSessionContractLimits.historyItemsPerTurn,
  read_timeout_ms: defaultResourceBudget.protocol_read_timeout_ms
});

export function createCodexNativeSessionClient(
  port: CodexNativeSessionRequestPort,
  options: CodexNativeSessionClientOptions = {}
): CodexNativeSessionClient {
  return new DefaultCodexNativeSessionClient(guardPort(port), parseOptions(options));
}

class DefaultCodexNativeSessionClient implements CodexNativeSessionClient {
  constructor(
    private readonly port: CodexNativeSessionRequestPort,
    private readonly options: ParsedOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    if (
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version === null ||
      compatibility.binding_id === null
    ) {
      throw new HostDeckCodexAdapterError(
        "handshake_failed",
        "Native Codex session access requires a connected compatible runtime.",
        { outcome: "not_sent", retry_safe: true }
      );
    }
    return compatibility.observed_version;
  }

  async discover(
    input: NativeSessionDiscoveryRequest = {},
    deadline?: OperationDeadline
  ): Promise<NativeSessionDiscoveryResponse> {
    const request = parseDiscoveryInput(input);
    void this.runtime_version;
    const identities: NativeCodexThreadIdentity[] = [];
    const seenThreadIds = new Set<string>();
    const seenCursors = new Set<string>();
    let candidateCount = 0;
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < this.options.max_pages; pageNumber += 1) {
      const params = {
        archived: false,
        cursor,
        limit: this.options.page_size,
        sortDirection: "desc",
        sortKey: "updated_at",
        sourceKinds: ["cli"],
        useStateDbOnly: false
      } satisfies ThreadListParams;
      const result = requireRecord(
        await this.port.request({
          method: "thread/list",
          params,
          kind: "read",
          ...codexRequestOptionsFromDeadline(deadline, this.options.read_timeout_ms)
        }),
        "Codex native thread/list result must be an object."
      );
      assertExactKeys(result, threadListResultKeys, "Codex native thread/list fields are invalid.");
      const page = requireArray(
        result.data,
        this.options.page_size,
        "Codex native thread/list data exceeds its requested page bound."
      );
      validateBackwardsCursor(result.backwardsCursor, page.length, "thread-list");

      for (const candidate of page) {
        candidateCount += 1;
        if (candidateCount > this.options.max_entries) {
          throw overloaded("Codex native discovery exceeded its configured entry bound.");
        }
        const parsed = parseThreadCandidate(candidate);
        const candidateId = parsed?.id ?? parsePayloadThreadId(requireRecord(candidate, "Codex native thread metadata must be an object.").id);
        if (seenThreadIds.has(candidateId)) {
          throw invalidPayload("Codex native discovery repeated a thread id across pages.");
        }
        seenThreadIds.add(candidateId);
        if (parsed !== null) {
          const listedIdentity = eligibleIdentity(parsed);
          if (listedIdentity !== null) {
            const exactIdentity = await this.readIdentity(candidateId, deadline);
            if (exactIdentity !== null) {
              identities.push(mergeDiscoveryIdentity(listedIdentity, exactIdentity));
            }
          }
        }
      }

      // Finish validating the current newest-first page, then stop once the
      // requested result and one proven overflow entry have been found.
      if (identities.length > request.limit) break;

      if (result.nextCursor === null) break;
      const nextCursor = parseCursor(result.nextCursor, "Codex native thread-list cursor");
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw invalidPayload("Codex native thread/list pagination cursor repeated.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === this.options.max_pages - 1) {
        throw overloaded("Codex native discovery exceeded its configured page bound.");
      }
    }

    identities.sort((left, right) =>
      left.updated_at === right.updated_at
        ? left.thread_id < right.thread_id ? -1 : left.thread_id > right.thread_id ? 1 : 0
        : right.updated_at.localeCompare(left.updated_at)
    );
    return parseDiscoveryResponse({
      limit: request.limit,
      threads: identities.slice(0, request.limit),
      truncated: identities.length > request.limit
    });
  }

  async readIdentity(
    threadId: CodexThreadId | string,
    deadline?: OperationDeadline
  ): Promise<NativeCodexThreadIdentity | null> {
    const parsedThreadId = parseInputThreadId(threadId);
    void this.runtime_version;
    const params = { threadId: parsedThreadId, includeTurns: false } satisfies ThreadReadParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/read",
        params,
        kind: "read",
        ...codexRequestOptionsFromDeadline(deadline, this.options.read_timeout_ms)
      }),
      "Codex native thread/read result must be an object."
    );
    assertExactKeys(result, ["thread"], "Codex native thread/read fields are invalid.");
    const payloadThreadId = parsePayloadThreadId(
      requireRecord(result.thread, "Codex native thread/read thread must be an object.").id
    );
    if (payloadThreadId !== parsedThreadId) {
      throw invalidPayload("Codex native thread/read returned a different thread id.");
    }
    const parsed = parseThreadCandidate(result.thread);
    if (parsed === null) return null;
    return eligibleIdentity(parsed);
  }

  async readAdoptionSnapshot(
    threadId: CodexThreadId | string,
    deadline?: OperationDeadline
  ): Promise<NativeCodexAdoptionSnapshot> {
    const parsedThreadId = parseInputThreadId(threadId);
    const before = await this.readIdentity(parsedThreadId, deadline);
    if (before === null) throw ineligible();

    const params = {
      threadId: parsedThreadId,
      cursor: null,
      limit: nativeSessionContractLimits.historyTurns,
      sortDirection: "desc",
      itemsView: "full"
    } satisfies ThreadTurnsListParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/turns/list",
        params,
        kind: "read",
        ...codexRequestOptionsFromDeadline(deadline, this.options.read_timeout_ms)
      }),
      "Codex native thread/turns/list result must be an object."
    );
    assertExactKeys(result, threadListResultKeys, "Codex native thread/turns/list fields are invalid.");
    const page = requireArray(
      result.data,
      nativeSessionContractLimits.historyTurns,
      "Codex native turn history exceeds its requested page bound."
    );
    validateBackwardsCursor(result.backwardsCursor, page.length, "turn-list");
    const nextCursor = result.nextCursor === null
      ? null
      : parseCursor(result.nextCursor, "Codex native turn-list cursor");
    const retainedNewestFirst: NativeCodexHistoryTurn[] = [];
    let projectionTruncated = nextCursor !== null;
    for (const candidate of page) {
      const parsedTurn = this.parseHistoryTurn(candidate);
      retainedNewestFirst.push(parsedTurn.turn);
      if (parsedTurn.truncated_before) {
        projectionTruncated = true;
        break;
      }
    }
    const turns = retainedNewestFirst.reverse();

    const after = await this.readIdentity(parsedThreadId, deadline);
    if (after === null) throw ineligible();
    if (!sameIdentity(before, after)) {
      throw new HostDeckCodexNativeSessionError(
        "identity_changed",
        "Native Codex thread identity changed while adoption history was being read.",
        true
      );
    }
    return parseSnapshot({ thread: after, turns, truncated_before: projectionTruncated });
  }

  async resume(
    threadId: CodexThreadId | string,
    deadline?: OperationDeadline
  ): Promise<CodexNativeSessionResumeResult> {
    const parsedThreadId = parseInputThreadId(threadId);
    void this.runtime_version;
    const params = { threadId: parsedThreadId, excludeTurns: true } satisfies ThreadResumeParams;
    const result = requireRecord(
      await this.port.request({
        method: "thread/resume",
        params,
        kind: "read",
        ...codexRequestOptionsFromDeadline(deadline, this.options.read_timeout_ms)
      }),
      "Codex native thread/resume result must be an object."
    );
    assertExactKeys(result, resumeResultKeys, "Codex native thread/resume fields are invalid.");
    validateResumeEnvelope(result);
    const payloadThreadId = parsePayloadThreadId(
      requireRecord(result.thread, "Codex native thread/resume thread must be an object.").id
    );
    if (payloadThreadId !== parsedThreadId) {
      throw invalidPayload("Codex native thread/resume returned a different thread id.");
    }
    const parsed = parseThreadCandidate(result.thread);
    if (parsed === null) throw ineligible();
    const thread = eligibleIdentity(parsed);
    if (thread === null) throw ineligible();
    const cwd = parseAbsoluteCwd(result.cwd, "Codex native thread/resume cwd");
    if (cwd !== thread.cwd) throw invalidPayload("Codex native thread/resume returned contradictory working directories.");
    const modelProvider = parsePrintableString(result.modelProvider, "Codex native model provider", 120);
    if (modelProvider !== parsed.modelProvider) {
      throw invalidPayload("Codex native thread/resume returned contradictory model providers.");
    }
    return Object.freeze({
      thread,
      runtime_model: parsePrintableString(result.model, "Codex native runtime model", 160),
      reasoning_effort:
        result.reasoningEffort === null
          ? null
          : parsePrintableString(result.reasoningEffort, "Codex native reasoning effort", 80)
    });
  }

  private parseHistoryTurn(candidate: unknown): {
    readonly turn: NativeCodexHistoryTurn;
    readonly truncated_before: boolean;
  } {
    const parsed = turnSchema.safeParse(candidate);
    if (!parsed.success) throw invalidPayload("Codex native turn history is malformed.");
    if (parsed.data.itemsView !== "full") {
      throw invalidPayload("Codex native turn history did not include full item data.");
    }
    if (!(["completed", "failed", "interrupted"] as readonly string[]).includes(parsed.data.status)) {
      throw invalidPayload("Codex native turn history contains non-terminal work.");
    }
    const status = parsed.data.status as "completed" | "failed" | "interrupted";
    if (parsed.data.startedAt === null || (status !== "interrupted" && parsed.data.completedAt === null)) {
      throw invalidPayload("Codex native terminal turn is missing required timestamps.");
    }
    if (status === "failed") validateTurnError(parsed.data.error);
    if (parsed.data.items.length > this.options.max_history_items_per_turn) {
      throw overloaded("Codex native turn history exceeded its configured item bound.");
    }
    const messages: Array<NativeCodexHistoryMessage & { readonly source_index: number }> = [];
    const seenItems = new Set<string>();
    let latestTruncatedMessageIndex = -1;
    for (const [index, item] of parsed.data.items.entries()) {
      let normalized: ReturnType<typeof normalizeCodexItem>;
      try {
        normalized = normalizeCodexItem(item, "completed", "thread/turns/list");
      } catch {
        throw invalidPayload("Codex native turn item is malformed or unsupported.");
      }
      if (seenItems.has(normalized.id)) throw invalidPayload("Codex native turn history repeats an item id.");
      seenItems.add(normalized.id);
      if (!["agent_message", "user_message"].includes(normalized.category) || normalized.text === null || normalized.text.length === 0) {
        continue;
      }
      if (normalized.content_state === "truncated" || normalized.content_state === "redacted_and_truncated") {
        latestTruncatedMessageIndex = index;
        continue;
      }
      messages.push(Object.freeze({
        source_index: index,
        item_id: normalized.id,
        role: normalized.category === "agent_message" ? "agent" : "user",
        text: normalized.text
      }));
    }
    const completeSuffix = messages.filter((message) => message.source_index > latestTruncatedMessageIndex);
    const retainedMessages = completeSuffix
      .slice(-nativeSessionContractLimits.messagesPerTurn)
      .map(({ source_index: _sourceIndex, ...message }) => Object.freeze(message));
    const truncatedBefore =
      latestTruncatedMessageIndex >= 0 || completeSuffix.length > retainedMessages.length;
    return Object.freeze({
      turn: Object.freeze({
        turn_id: parsed.data.id,
        status,
        started_at: unixSecondsToIso(parsed.data.startedAt, "native turn start"),
        completed_at:
          parsed.data.completedAt === null
            ? null
            : unixSecondsToIso(parsed.data.completedAt, "native turn completion"),
        messages: retainedMessages
      }),
      truncated_before: truncatedBefore
    });
  }
}

function validateTurnError(candidate: unknown): void {
  const value = requireRecord(candidate, "Codex native failed-turn error is invalid.");
  assertExactKeys(value, ["additionalDetails", "codexErrorInfo", "message"], "Codex native failed-turn error fields are invalid.");
  parseBoundedText(value.message, "Codex native failed-turn message", 2_000, false);
  if (value.additionalDetails !== null) {
    parseBoundedText(value.additionalDetails, "Codex native failed-turn details", 2_000, true);
  }
  const info = value.codexErrorInfo;
  if (info === null) return;
  if (
    [
      "badRequest",
      "contextWindowExceeded",
      "cyberPolicy",
      "internalServerError",
      "other",
      "sandboxError",
      "serverOverloaded",
      "sessionBudgetExceeded",
      "threadRollbackFailed",
      "unauthorized",
      "usageLimitExceeded"
    ].includes(info as string)
  ) {
    return;
  }
  const classification = requireRecord(info, "Codex native failed-turn classification is invalid.");
  const keys = Object.keys(classification);
  if (keys.length !== 1) throw invalidPayload("Codex native failed-turn classification fields are invalid.");
  const key = keys[0] as string;
  const detail = requireRecord(classification[key], "Codex native failed-turn classification detail is invalid.");
  if (key === "activeTurnNotSteerable") {
    assertExactKeys(detail, ["turnKind"], "Codex native failed-turn classification fields are invalid.");
    if (!["compact", "review"].includes(detail.turnKind as string)) {
      throw invalidPayload("Codex native failed-turn kind is invalid.");
    }
    return;
  }
  if (
    ![
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts"
    ].includes(key)
  ) {
    throw invalidPayload("Codex native failed-turn classification is unsupported.");
  }
  assertExactKeys(detail, ["httpStatusCode"], "Codex native failed-turn HTTP detail fields are invalid.");
  if (
    detail.httpStatusCode !== null &&
    (!Number.isSafeInteger(detail.httpStatusCode) || (detail.httpStatusCode as number) < 100 || (detail.httpStatusCode as number) > 599)
  ) {
    throw invalidPayload("Codex native failed-turn HTTP status is invalid.");
  }
}

function guardPort(port: CodexNativeSessionRequestPort): CodexNativeSessionRequestPort {
  if (port === null || typeof port !== "object" || typeof port.request !== "function") {
    throw new TypeError("Codex native session client requires a runtime request port.");
  }
  return Object.freeze({
    get compatibility() {
      return port.compatibility;
    },
    request(input: CodexRequestInput): Promise<unknown> {
      if (input === null || typeof input !== "object" || input.kind !== "read" || !allowedMethods.has(input.method)) {
        return Promise.reject(invalidInput("Codex native session client attempted an unreviewed runtime method."));
      }
      return port.request(input);
    }
  });
}

function parseThreadCandidate(candidate: unknown): ParsedRawThread | null {
  const parsed = rawThreadSchema.safeParse(candidate);
  if (parsed.success) {
    assertExactThreadKeys(candidate);
    return parsed.data;
  }
  if (
    isRecord(candidate) &&
    typeof candidate.cwd === "string" &&
    candidate.cwd.length > 0 &&
    candidate.cwd.length <= maximumPrivatePathLength &&
    !candidate.cwd.includes("\0") &&
    !absoluteCwdSchema.safeParse(candidate.cwd).success
  ) {
    const withValidCwd = { ...candidate, cwd: "/__hostdeck_invalid_native_cwd__" };
    if (rawThreadSchema.safeParse(withValidCwd).success) {
      assertExactThreadKeys(candidate);
      return null;
    }
  }
  throw invalidPayload("Codex native thread metadata is malformed.");
}

function eligibleIdentity(raw: ParsedRawThread): NativeCodexThreadIdentity | null {
  const status = raw.status.type === "idle" ? "idle" : raw.status.type === "notLoaded" ? "not_loaded" : null;
  if (
    raw.source !== "cli" ||
    raw.ephemeral ||
    raw.parentThreadId !== null ||
    raw.agentNickname !== null ||
    raw.agentRole !== null ||
    status === null
  ) {
    return null;
  }
  try {
    return Object.freeze(nativeCodexThreadIdentitySchema.parse({
      thread_id: raw.id,
      cwd: raw.cwd,
      source: "cli",
      runtime_version: raw.cliVersion,
      created_at: unixSecondsToIso(raw.createdAt, "native thread creation"),
      updated_at: unixSecondsToIso(raw.updatedAt, "native thread update"),
      status,
      archived: false,
      ephemeral: false,
      parent_thread_id: null,
      forked_from_id: raw.forkedFromId,
      history_mode: raw.historyMode
    }));
  } catch {
    throw invalidPayload("Codex native thread identity cannot be normalized.");
  }
}

function validateResumeEnvelope(result: Record<string, unknown>): void {
  if (result.initialTurnsPage !== null) {
    throw invalidPayload("Codex native thread/resume returned unrequested turn history.");
  }
  parsePrintableString(result.modelProvider, "Codex native model provider", 120);
  if (result.serviceTier !== null) parsePrintableString(result.serviceTier, "Codex native service tier", 120);
  parsePathArray(result.runtimeWorkspaceRoots, true, "Codex native runtime workspace roots");
  parsePathArray(result.instructionSources, false, "Codex native instruction sources");
  validateApprovalPolicy(result.approvalPolicy);
  if (!["user", "auto_review", "guardian_subagent"].includes(result.approvalsReviewer as string)) {
    throw invalidPayload("Codex native approvals reviewer is invalid.");
  }
  validateSandbox(result.sandbox);
  if (result.activePermissionProfile !== null) {
    const profile = requireRecord(result.activePermissionProfile, "Codex native permission profile is invalid.");
    assertExactKeys(profile, ["extends", "id"], "Codex native permission profile fields are invalid.");
    parsePrintableString(profile.id, "Codex native permission profile id", 240);
    if (profile.extends !== null) parsePrintableString(profile.extends, "Codex native permission profile parent", 240);
  }
  if (typeof result.multiAgentMode === "string") {
    if (!["explicitRequestOnly", "proactive"].includes(result.multiAgentMode)) {
      throw invalidPayload("Codex native multi-agent mode is invalid.");
    }
  } else {
    const mode = requireRecord(result.multiAgentMode, "Codex native multi-agent mode is invalid.");
    assertExactKeys(mode, ["custom"], "Codex native custom multi-agent mode fields are invalid.");
    parseBoundedText(mode.custom, "Codex native custom multi-agent mode", 12_000, false);
  }
}

function validateApprovalPolicy(candidate: unknown): void {
  if (["never", "on-request", "untrusted"].includes(candidate as string)) return;
  const value = requireRecord(candidate, "Codex native approval policy is invalid.");
  assertExactKeys(value, ["granular"], "Codex native approval policy fields are invalid.");
  const granular = requireRecord(value.granular, "Codex native granular approval policy is invalid.");
  const keys = ["mcp_elicitations", "request_permissions", "rules", "sandbox_approval", "skill_approval"] as const;
  assertExactKeys(granular, keys, "Codex native granular approval fields are invalid.");
  for (const key of keys) {
    if (typeof granular[key] !== "boolean") throw invalidPayload("Codex native granular approval value is invalid.");
  }
}

function validateSandbox(candidate: unknown): void {
  const value = requireRecord(candidate, "Codex native sandbox policy is invalid.");
  if (value.type === "dangerFullAccess") {
    assertExactKeys(value, ["type"], "Codex native sandbox fields are invalid.");
    return;
  }
  if (value.type === "readOnly") {
    assertExactKeys(value, ["networkAccess", "type"], "Codex native sandbox fields are invalid.");
    if (typeof value.networkAccess !== "boolean") throw invalidPayload("Codex native sandbox network access is invalid.");
    return;
  }
  if (value.type === "externalSandbox") {
    assertExactKeys(value, ["networkAccess", "type"], "Codex native sandbox fields are invalid.");
    if (!["enabled", "restricted"].includes(value.networkAccess as string)) {
      throw invalidPayload("Codex native external sandbox network access is invalid.");
    }
    return;
  }
  if (value.type !== "workspaceWrite") throw invalidPayload("Codex native sandbox type is invalid.");
  assertExactKeys(
    value,
    ["excludeSlashTmp", "excludeTmpdirEnvVar", "networkAccess", "type", "writableRoots"],
    "Codex native sandbox fields are invalid."
  );
  if (
    typeof value.networkAccess !== "boolean" ||
    typeof value.excludeTmpdirEnvVar !== "boolean" ||
    typeof value.excludeSlashTmp !== "boolean"
  ) {
    throw invalidPayload("Codex native workspace sandbox flags are invalid.");
  }
  parsePathArray(value.writableRoots, true, "Codex native sandbox writable roots");
}

function parsePathArray(candidate: unknown, absolute: boolean, label: string): void {
  const paths = requireArray(candidate, maximumResumePaths, `${label} exceed their configured bound.`);
  for (const path of paths) {
    if (absolute) parseAbsoluteCwd(path, label);
    else parsePrintableString(path, label, maximumPrivatePathLength);
  }
}

function parseDiscoveryInput(candidate: unknown): { readonly limit: number } {
  const parsed = nativeSessionDiscoveryRequestSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Native Codex discovery input is invalid.");
  return Object.freeze({ limit: parsed.data.limit ?? nativeSessionContractLimits.discoveryDefaultLimit });
}

function parseDiscoveryResponse(candidate: unknown): NativeSessionDiscoveryResponse {
  const parsed = nativeSessionDiscoveryResponseSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Native Codex discovery output cannot be normalized.");
  for (const thread of parsed.data.threads) Object.freeze(thread);
  Object.freeze(parsed.data.threads);
  return Object.freeze(parsed.data);
}

function parseSnapshot(candidate: unknown): NativeCodexAdoptionSnapshot {
  const parsed = nativeCodexAdoptionSnapshotSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Native Codex adoption snapshot cannot be normalized.");
  Object.freeze(parsed.data.thread);
  for (const turn of parsed.data.turns) {
    for (const message of turn.messages) Object.freeze(message);
    Object.freeze(turn.messages);
    Object.freeze(turn);
  }
  Object.freeze(parsed.data.turns);
  return Object.freeze(parsed.data);
}

function parseInputThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidInput("Native Codex thread id is invalid.");
  return parsed.data;
}

function parsePayloadThreadId(candidate: unknown): CodexThreadId {
  const parsed = codexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Native Codex payload thread id is invalid.");
  return parsed.data;
}

function parseAbsoluteCwd(candidate: unknown, label: string): string {
  const parsed = absoluteCwdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload(`${label} is invalid.`);
  return parsed.data;
}

function unixSecondsToIso(candidate: number, label: string): IsoTimestamp {
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 253_402_300_799) {
    throw invalidPayload(`Codex ${label} timestamp is invalid.`);
  }
  return new Date(candidate * 1_000).toISOString() as IsoTimestamp;
}

function parseCursor(candidate: unknown, label: string): string {
  return parsePrintableString(candidate, label, 2_048);
}

function parsePrintableString(candidate: unknown, label: string, maximum: number): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maximum) {
    throw invalidPayload(`${label} must be a nonempty bounded string.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) throw invalidPayload(`${label} contains an unsupported control character.`);
  }
  return candidate;
}

function parseBoundedText(candidate: unknown, label: string, maximum: number, allowEmpty: boolean): string {
  if (typeof candidate !== "string" || (!allowEmpty && candidate.length === 0) || candidate.length > maximum) {
    throw invalidPayload(`${label} must be bounded text.`);
  }
  return candidate;
}

function validateBackwardsCursor(candidate: unknown, count: number, label: string): void {
  if (count === 0 && candidate !== null) throw invalidPayload(`Codex native ${label} returned a cursor for an empty page.`);
  if (count > 0 && candidate === null) throw invalidPayload(`Codex native ${label} omitted its backwards cursor.`);
  if (candidate !== null) parseCursor(candidate, `Codex native ${label} backwards cursor`);
}

function sameIdentity(left: NativeCodexThreadIdentity, right: NativeCodexThreadIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeDiscoveryIdentity(
  listed: NativeCodexThreadIdentity,
  exact: NativeCodexThreadIdentity
): NativeCodexThreadIdentity {
  if (
    listed.thread_id !== exact.thread_id ||
    listed.cwd !== exact.cwd ||
    listed.source !== exact.source ||
    listed.runtime_version !== exact.runtime_version ||
    listed.created_at !== exact.created_at ||
    listed.archived !== exact.archived ||
    listed.ephemeral !== exact.ephemeral ||
    listed.parent_thread_id !== exact.parent_thread_id ||
    listed.history_mode !== exact.history_mode
  ) {
    throw invalidPayload("Codex native discovery identity disagrees with exact thread metadata.");
  }
  return Object.freeze(
    nativeCodexThreadIdentitySchema.parse({
      ...listed,
      status: exact.status,
      forked_from_id: exact.forked_from_id
    })
  );
}

function assertExactThreadKeys(candidate: unknown): void {
  const value = requireRecord(candidate, "Codex native thread metadata must be an object.");
  assertExactKeys(value, threadKeys, "Codex native thread fields are invalid.");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw invalidPayload(message);
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (!isRecord(candidate)) throw invalidPayload(message);
  return candidate;
}

function requireArray(candidate: unknown, maximum: number, message: string): unknown[] {
  if (!Array.isArray(candidate) || candidate.length > maximum) throw invalidPayload(message);
  return candidate;
}

function parseOptions(options: CodexNativeSessionClientOptions): ParsedOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Codex native session client options must be an object.");
  }
  const keys = Object.keys(options).sort();
  const expected = ["max_entries", "max_history_items_per_turn", "max_pages", "page_size", "read_timeout_ms"];
  if (keys.some((key) => !expected.includes(key))) {
    throw new TypeError("Codex native session client options contain an unsupported field.");
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
    max_entries: boundedOption(options.max_entries, defaults.max_entries, 1, 10_000, "max_entries"),
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

function boundedOption(candidate: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const value = candidate ?? fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Codex native session ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function ineligible(): HostDeckCodexNativeSessionError {
  return new HostDeckCodexNativeSessionError(
    "thread_ineligible",
    "Native Codex thread is not eligible for HostDeck adoption.",
    false
  );
}

function invalidInput(message: string): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_protocol_message", message, {
    outcome: "not_sent",
    retry_safe: true
  });
}

function invalidPayload(message: string): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_protocol_message", message, {
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
