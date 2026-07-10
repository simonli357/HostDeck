import { isoTimestampSchema } from "@hostdeck/contracts";
import type {
  CodexItemId,
  CodexThreadId,
  CodexTurnId,
  IsoTimestamp,
  RuntimeRequestId
} from "@hostdeck/core";
import type { z } from "zod";
import { codexBindingDescriptor } from "./binding.js";
import type { CodexConnectionNotification } from "./connection.js";
import { normalizeCodexItem as normalizeItem, parseCodexItemId as parseItemId } from "./event-normalizer-items.js";
import {
  deltaParamsSchema,
  type goalSchema,
  itemCompletedParamsSchema,
  itemStartedParamsSchema,
  type planStepSchema,
  rateLimitParamsSchema,
  type rateLimitWindowSchema,
  requestResolvedParamsSchema,
  threadGoalUpdatedParamsSchema,
  threadIdentityEnvelopeSchema,
  threadIdParamsSchema,
  threadNameParamsSchema,
  threadSettingsParamsSchema,
  threadStartedIdentityEnvelopeSchema,
  threadStartedParamsSchema,
  threadStatusParamsSchema,
  type threadStatusSchema,
  threadTokenUsageParamsSchema,
  type tokenUsageSchema,
  turnParamsSchema,
  turnPlanParamsSchema,
  type turnSchema
} from "./event-normalizer-schemas.js";
import {
  asError,
  boundCodexContent as boundContent,
  boundedCodexText as boundText,
  type CodexEventNormalizationErrorCode,
  canonicalRuntimeRequestId as canonicalRequestId,
  HostDeckCodexEventNormalizationError,
  maximumMethodLength,
  maximumSummaryLength,
  maximumTextLength,
  type NormalizedCodexContentState,
  codexNormalizationError as normalizationError,
  nullableUnixSecondsToIso,
  parseCodexParams as parseParams,
  stableCodexEventId,
  unixMillisecondsToIso,
  unixSecondsToIso
} from "./event-normalizer-support.js";

export type { CodexEventNormalizationErrorCode, NormalizedCodexContentState };
export { HostDeckCodexEventNormalizationError };

export type NormalizedCodexThreadStatus = "active" | "idle" | "not_loaded" | "system_error";
export type NormalizedCodexActiveFlag = "waiting_on_approval" | "waiting_on_user_input";
export type NormalizedCodexGoalStatus = "active" | "blocked" | "budget_limited" | "complete" | "paused" | "usage_limited";
export type NormalizedCodexItemCategory =
  | "agent_message"
  | "command"
  | "compaction"
  | "file_change"
  | "other"
  | "plan"
  | "reasoning"
  | "tool"
  | "user_message";
export type NormalizedCodexItemState = "completed" | "failed" | "started";

interface NormalizedCodexBase<Method extends string> {
  readonly sequence: number;
  readonly method: Method;
  readonly captured_at: IsoTimestamp;
  readonly upstream_at: IsoTimestamp | null;
  readonly codex_event_id: string | null;
}

interface NormalizedCodexThreadBase<Method extends string> extends NormalizedCodexBase<Method> {
  readonly scope: "thread";
  readonly thread_id: CodexThreadId;
}

export interface NormalizedCodexItem {
  readonly id: CodexItemId;
  readonly category: NormalizedCodexItemCategory;
  readonly state: NormalizedCodexItemState;
  readonly title: string;
  readonly text: string | null;
  readonly content_state: NormalizedCodexContentState;
  readonly content_notice: string | null;
}

export interface NormalizedCodexPlanStep {
  readonly step: string;
  readonly status: "completed" | "in_progress" | "pending";
}

export interface NormalizedCodexTokenUsage {
  readonly total_tokens: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
}

export interface NormalizedCodexRateLimitWindow {
  readonly used_percent: number;
  readonly window_duration_minutes: number | null;
  readonly resets_at: IsoTimestamp | null;
}

export type NormalizedCodexEvent =
  | (NormalizedCodexThreadBase<"thread/started"> & {
      readonly status: NormalizedCodexThreadStatus;
      readonly active_flags: readonly NormalizedCodexActiveFlag[];
      readonly name: string | null;
    })
  | (NormalizedCodexThreadBase<"thread/status/changed"> & {
      readonly status: NormalizedCodexThreadStatus;
      readonly active_flags: readonly NormalizedCodexActiveFlag[];
    })
  | (NormalizedCodexThreadBase<"thread/name/updated"> & { readonly name: string | null })
  | NormalizedCodexThreadBase<"thread/archived">
  | (NormalizedCodexThreadBase<"thread/settings/updated"> & {
      readonly model: string;
      readonly effort: string | null;
      readonly collaboration_mode: "default" | "plan";
    })
  | (NormalizedCodexThreadBase<"thread/goal/updated"> & {
      readonly turn_id: CodexTurnId | null;
      readonly objective: string;
      readonly status: NormalizedCodexGoalStatus;
      readonly token_budget: number | null;
      readonly tokens_used: number;
      readonly content_state: NormalizedCodexContentState;
      readonly content_notice: string | null;
    })
  | NormalizedCodexThreadBase<"thread/goal/cleared">
  | (NormalizedCodexThreadBase<"thread/tokenUsage/updated"> & {
      readonly turn_id: CodexTurnId;
      readonly total: NormalizedCodexTokenUsage;
      readonly last: NormalizedCodexTokenUsage;
      readonly model_context_window: number | null;
    })
  | (NormalizedCodexThreadBase<"turn/started"> & {
      readonly turn_id: CodexTurnId;
      readonly status: "in_progress";
    })
  | (NormalizedCodexThreadBase<"turn/completed"> & {
      readonly turn_id: CodexTurnId;
      readonly status: "completed" | "failed" | "interrupted";
      readonly error_message: string | null;
    })
  | (NormalizedCodexThreadBase<"turn/plan/updated"> & {
      readonly turn_id: CodexTurnId;
      readonly explanation: string | null;
      readonly plan: readonly NormalizedCodexPlanStep[];
    })
  | (NormalizedCodexThreadBase<"item/started" | "item/completed"> & {
      readonly turn_id: CodexTurnId;
      readonly item: NormalizedCodexItem;
    })
  | (NormalizedCodexThreadBase<"item/agentMessage/delta" | "item/plan/delta"> & {
      readonly turn_id: CodexTurnId;
      readonly item_id: CodexItemId;
      readonly category: "agent_message" | "plan";
      readonly delta: string;
      readonly content_state: NormalizedCodexContentState;
      readonly content_notice: string | null;
    })
  | (NormalizedCodexThreadBase<"serverRequest/resolved"> & { readonly request_id: RuntimeRequestId })
  | (NormalizedCodexBase<"account/rateLimits/updated"> & {
      readonly scope: "runtime";
      readonly primary: NormalizedCodexRateLimitWindow | null;
      readonly secondary: NormalizedCodexRateLimitWindow | null;
      readonly reached_type: string | null;
    });

export interface CodexOptionalNotificationDiagnostic {
  readonly sequence: number;
  readonly method: string;
  readonly classification: "generated_optional";
  readonly method_count: number | null;
  readonly total_count: number;
  readonly tracked_method_count: number;
  readonly method_capacity_exhausted: boolean;
}

export interface CodexUnmanagedThreadObservation {
  readonly sequence: number;
  readonly method: string;
  readonly thread_id: CodexThreadId;
  readonly classification: "unmanaged_thread";
  readonly total_count: number;
}

export type CodexNotificationNormalizationResult =
  | { readonly kind: "event"; readonly event: NormalizedCodexEvent }
  | { readonly kind: "diagnostic"; readonly diagnostic: CodexOptionalNotificationDiagnostic }
  | { readonly kind: "unmanaged"; readonly observation: CodexUnmanagedThreadObservation };

export interface CodexEventNormalizerOptions {
  readonly now?: () => string;
  readonly max_tracked_threads?: number;
  readonly max_tracked_turns_per_thread?: number;
  readonly max_tracked_items_per_thread?: number;
  readonly max_resolved_requests_per_thread?: number;
  readonly max_optional_methods?: number;
  readonly is_managed_thread?: (thread_id: CodexThreadId) => boolean;
}

export interface CodexEventNormalizer {
  readonly normalize: (notification: CodexConnectionNotification) => CodexNotificationNormalizationResult;
  readonly optional_diagnostic_count: number;
  readonly unmanaged_observation_count: number;
  readonly tracked_thread_count: number;
  readonly last_sequence: number;
  readonly failure: Error | null;
}

interface ParsedNormalizerOptions {
  readonly now: () => string;
  readonly max_tracked_threads: number;
  readonly max_tracked_turns_per_thread: number;
  readonly max_tracked_items_per_thread: number;
  readonly max_resolved_requests_per_thread: number;
  readonly max_optional_methods: number;
  readonly is_managed_thread: (thread_id: CodexThreadId) => boolean;
}

interface TrackedTurn {
  state: "active" | "terminal";
}

interface TrackedItem {
  readonly turn_id: CodexTurnId;
  readonly category: NormalizedCodexItemCategory;
  state: "active" | "terminal";
}

interface TrackedThread {
  readonly turns: Map<CodexTurnId, TrackedTurn>;
  readonly items: Map<CodexItemId, TrackedItem>;
  readonly resolved_requests: Set<RuntimeRequestId>;
  active_turn_id: CodexTurnId | null;
  started: boolean;
  archived: boolean;
  last_name: string | null | undefined;
  last_status_signature: string | null;
  last_goal_updated_at: number | null;
  last_goal_signature: string | null;
  goal_state: "cleared" | "present" | "unknown";
  last_token_signature: string | null;
  last_token_total: number | null;
}

const defaults = {
  max_tracked_threads: 128,
  max_tracked_turns_per_thread: 128,
  max_tracked_items_per_thread: 2_048,
  max_resolved_requests_per_thread: 128,
  max_optional_methods: 64
} as const;

const selectedNotificationMethods = new Set<string>(codexBindingDescriptor.surface.server_notifications);


class DefaultCodexEventNormalizer implements CodexEventNormalizer {
  private sequence = 0;
  private readonly threads = new Map<CodexThreadId, TrackedThread>();
  private readonly optionalCounts = new Map<string, number>();
  private optionalTotal = 0;
  private unmanagedTotal = 0;
  private currentFailure: Error | null = null;
  private lastCapturedAt: IsoTimestamp | null = null;

  constructor(private readonly options: ParsedNormalizerOptions) {}

  get optional_diagnostic_count(): number {
    return this.optionalTotal;
  }

  get unmanaged_observation_count(): number {
    return this.unmanagedTotal;
  }

  get tracked_thread_count(): number {
    return this.threads.size;
  }

  get last_sequence(): number {
    return this.sequence;
  }

  get failure(): Error | null {
    return this.currentFailure;
  }

  normalize(notification: CodexConnectionNotification): CodexNotificationNormalizationResult {
    if (this.currentFailure !== null) {
      throw normalizationError(
        "normalizer_stopped",
        "Codex event normalization stopped after an earlier fatal input or state failure.",
        notification.method,
        this.currentFailure
      );
    }
    try {
      return this.normalizeOne(notification);
    } catch (error) {
      this.currentFailure = asError(error);
      throw error;
    }
  }

  private normalizeOne(notification: CodexConnectionNotification): CodexNotificationNormalizationResult {
    const sequence = this.nextSequence(notification.method);
    const capturedAt = this.captureTime(notification.method);
    if (notification.classification === "unknown") {
      throw normalizationError("unknown_notification", `Codex emitted unknown notification ${notification.method}.`, notification.method);
    }
    if (notification.classification === "generated_unhandled") {
      return { kind: "diagnostic", diagnostic: this.optionalDiagnostic(notification.method, sequence) };
    }
    const threadId = selectedNotificationThreadId(notification.method, notification.params);
    if (threadId !== null && !this.isManagedThread(threadId, notification.method)) {
      this.unmanagedTotal = Math.min(Number.MAX_SAFE_INTEGER, this.unmanagedTotal + 1);
      return {
        kind: "unmanaged",
        observation: {
          sequence,
          method: notification.method,
          thread_id: threadId,
          classification: "unmanaged_thread",
          total_count: this.unmanagedTotal
        }
      };
    }
    const event = this.normalizeSelected(notification.method, notification.params, sequence, capturedAt);
    return { kind: "event", event };
  }

  private normalizeSelected(method: string, params: unknown, sequence: number, capturedAt: IsoTimestamp): NormalizedCodexEvent {
    switch (method) {
      case "thread/started": {
        const parsed = parseParams(threadStartedParamsSchema, params, method);
        const state = this.thread(parsed.thread.id, method);
        if (state.started) throw normalizationError("duplicate_event", "Codex repeated thread/started.", method);
        state.started = true;
        const status = normalizeThreadStatus(parsed.thread.status, method);
        return {
          ...threadBase(sequence, method, capturedAt, unixSecondsToIso(parsed.thread.updatedAt, method), `thread:${parsed.thread.id}:started`, parsed.thread.id),
          method,
          status: status.status,
          active_flags: status.active_flags,
          name: parsed.thread.name
        };
      }
      case "thread/status/changed": {
        const parsed = parseParams(threadStatusParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        const signature = JSON.stringify(parsed.status);
        if (signature === state.last_status_signature) {
          throw normalizationError("duplicate_event", "Codex repeated identical thread status.", method);
        }
        state.last_status_signature = signature;
        const status = normalizeThreadStatus(parsed.status, method);
        return {
          ...threadBase(sequence, method, capturedAt, null, null, parsed.threadId),
          method,
          status: status.status,
          active_flags: status.active_flags
        };
      }
      case "thread/name/updated": {
        const parsed = parseParams(threadNameParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        const name = parsed.threadName ?? null;
        if (state.last_name === name) throw normalizationError("duplicate_event", "Codex repeated thread name state.", method);
        state.last_name = name;
        return { ...threadBase(sequence, method, capturedAt, null, null, parsed.threadId), method, name };
      }
      case "thread/archived": {
        const parsed = parseParams(threadIdParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        if (state.archived) throw normalizationError("duplicate_event", "Codex repeated thread archive state.", method);
        if (state.active_turn_id !== null) {
          throw normalizationError("event_out_of_order", "Codex archived a thread with an active turn.", method);
        }
        state.archived = true;
        return {
          ...threadBase(sequence, method, capturedAt, null, `thread:${parsed.threadId}:archived`, parsed.threadId),
          method
        };
      }
      case "thread/settings/updated": {
        const parsed = parseParams(threadSettingsParamsSchema, params, method);
        this.thread(parsed.threadId, method);
        return {
          ...threadBase(sequence, method, capturedAt, null, null, parsed.threadId),
          method,
          model: parsed.threadSettings.model,
          effort: parsed.threadSettings.effort,
          collaboration_mode: parsed.threadSettings.collaborationMode.mode
        };
      }
      case "thread/goal/updated": {
        const parsed = parseParams(threadGoalUpdatedParamsSchema, params, method);
        if (parsed.goal.threadId !== parsed.threadId) {
          throw normalizationError("malformed_required_event", "Goal thread identity contradicts notification identity.", method);
        }
        const state = this.thread(parsed.threadId, method);
        const signature = stableCodexEventId("goal-state", JSON.stringify({ turnId: parsed.turnId, goal: parsed.goal }));
        if (signature === state.last_goal_signature) {
          throw normalizationError("duplicate_event", "Codex repeated an identical goal update.", method);
        }
        if (state.last_goal_updated_at !== null && parsed.goal.updatedAt < state.last_goal_updated_at) {
          throw normalizationError(
            "event_out_of_order",
            "Goal update timestamp moved backward.",
            method
          );
        }
        if (parsed.turnId !== null) this.requireKnownTurn(state, parsed.turnId, method);
        state.last_goal_updated_at = parsed.goal.updatedAt;
        state.last_goal_signature = signature;
        state.goal_state = "present";
        const objective = boundContent(parsed.goal.objective, maximumSummaryLength, "Goal objective was truncated for projection.");
        return {
          ...threadBase(
            sequence,
            method,
            capturedAt,
            unixSecondsToIso(parsed.goal.updatedAt, method),
            stableCodexEventId("goal", `${parsed.threadId}\n${signature}`),
            parsed.threadId
          ),
          method,
          turn_id: parsed.turnId,
          objective: objective.text,
          status: normalizeGoalStatus(parsed.goal.status),
          token_budget: parsed.goal.tokenBudget,
          tokens_used: parsed.goal.tokensUsed,
          content_state: objective.content_state,
          content_notice: objective.content_notice
        };
      }
      case "thread/goal/cleared": {
        const parsed = parseParams(threadIdParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        if (state.goal_state === "cleared") throw normalizationError("duplicate_event", "Codex repeated goal cleared state.", method);
        state.goal_state = "cleared";
        return { ...threadBase(sequence, method, capturedAt, null, null, parsed.threadId), method };
      }
      case "thread/tokenUsage/updated": {
        const parsed = parseParams(threadTokenUsageParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        this.requireKnownTurn(state, parsed.turnId, method);
        const signature = JSON.stringify(parsed.tokenUsage);
        if (signature === state.last_token_signature) {
          throw normalizationError("duplicate_event", "Codex repeated an identical token usage update.", method);
        }
        if (state.last_token_total !== null && parsed.tokenUsage.total.totalTokens < state.last_token_total) {
          throw normalizationError("event_out_of_order", "Cumulative token usage moved backward.", method);
        }
        state.last_token_signature = signature;
        state.last_token_total = parsed.tokenUsage.total.totalTokens;
        return {
          ...threadBase(sequence, method, capturedAt, null, null, parsed.threadId),
          method,
          turn_id: parsed.turnId,
          total: normalizeTokenUsage(parsed.tokenUsage.total),
          last: normalizeTokenUsage(parsed.tokenUsage.last),
          model_context_window: parsed.tokenUsage.modelContextWindow
        };
      }
      case "turn/started": {
        const parsed = parseParams(turnParamsSchema, params, method);
        if (parsed.turn.status !== "inProgress" || parsed.turn.error !== null) {
          throw normalizationError("malformed_required_event", "turn/started did not carry an in-progress turn.", method);
        }
        const state = this.thread(parsed.threadId, method);
        if (state.turns.has(parsed.turn.id)) {
          throw normalizationError("duplicate_event", "Codex repeated turn start.", method);
        }
        if (state.active_turn_id !== null) {
          throw normalizationError("event_out_of_order", "Codex started a different turn before the active turn completed.", method);
        }
        this.ensureTurnCapacity(state, method);
        state.turns.set(parsed.turn.id, { state: "active" });
        state.active_turn_id = parsed.turn.id;
        return {
          ...threadBase(sequence, method, capturedAt, nullableUnixSecondsToIso(parsed.turn.startedAt, method), `turn:${parsed.turn.id}:started`, parsed.threadId),
          method,
          turn_id: parsed.turn.id,
          status: "in_progress"
        };
      }
      case "turn/completed": {
        const parsed = parseParams(turnParamsSchema, params, method);
        if (parsed.turn.status === "inProgress") {
          throw normalizationError("malformed_required_event", "turn/completed carried an in-progress turn.", method);
        }
        const state = this.thread(parsed.threadId, method);
        const tracked = this.requireKnownTurn(state, parsed.turn.id, method);
        if (tracked.state === "terminal") throw normalizationError("duplicate_event", "Codex repeated turn completion.", method);
        if (state.active_turn_id !== parsed.turn.id) {
          throw normalizationError("event_out_of_order", "Codex completed a turn that is not active.", method);
        }
        const activeItems = [...state.items.values()].filter(
          (item) => item.turn_id === parsed.turn.id && item.state === "active"
        );
        if (parsed.turn.status === "completed" && activeItems.length > 0) {
          throw normalizationError("event_out_of_order", "Codex completed a turn while one or more items remained active.", method);
        }
        for (const item of activeItems) item.state = "terminal";
        tracked.state = "terminal";
        if (state.active_turn_id === parsed.turn.id) state.active_turn_id = null;
        return {
          ...threadBase(
            sequence,
            method,
            capturedAt,
            nullableUnixSecondsToIso(parsed.turn.completedAt, method),
            `turn:${parsed.turn.id}:completed`,
            parsed.threadId
          ),
          method,
          turn_id: parsed.turn.id,
          status: normalizeTurnStatus(parsed.turn.status),
          error_message: parsed.turn.error === null ? null : boundText(parsed.turn.error.message, 240)
        };
      }
      case "turn/plan/updated": {
        const parsed = parseParams(turnPlanParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        this.requireActiveTurn(state, parsed.turnId, method);
        return {
          ...threadBase(sequence, method, capturedAt, null, null, parsed.threadId),
          method,
          turn_id: parsed.turnId,
          explanation: parsed.explanation,
          plan: parsed.plan.map((step) => ({ step: step.step, status: normalizePlanStatus(step.status) }))
        };
      }
      case "item/started": {
        const parsed = parseParams(itemStartedParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        this.requireActiveTurn(state, parsed.turnId, method);
        const item = normalizeItem(parsed.item, "started", method);
        if (state.items.has(item.id)) throw normalizationError("duplicate_event", "Codex repeated item start.", method);
        this.ensureItemCapacity(state, method);
        state.items.set(item.id, { turn_id: parsed.turnId, category: item.category, state: "active" });
        return {
          ...threadBase(sequence, method, capturedAt, unixMillisecondsToIso(parsed.startedAtMs, method), `item:${item.id}:started`, parsed.threadId),
          method,
          turn_id: parsed.turnId,
          item
        };
      }
      case "item/completed": {
        const parsed = parseParams(itemCompletedParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        this.requireActiveTurn(state, parsed.turnId, method);
        const tracked = state.items.get(parseItemId(parsed.item, method));
        if (tracked === undefined) throw normalizationError("event_out_of_order", "Codex completed an item before its start.", method);
        if (tracked.turn_id !== parsed.turnId) throw normalizationError("event_out_of_order", "Completed item changed turn identity.", method);
        if (tracked.state === "terminal") throw normalizationError("duplicate_event", "Codex repeated item completion.", method);
        const item = normalizeItem(parsed.item, "completed", method);
        if (tracked.category !== item.category) throw normalizationError("event_out_of_order", "Completed item changed category.", method);
        tracked.state = "terminal";
        return {
          ...threadBase(sequence, method, capturedAt, unixMillisecondsToIso(parsed.completedAtMs, method), `item:${item.id}:completed`, parsed.threadId),
          method,
          turn_id: parsed.turnId,
          item
        };
      }
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        const parsed = parseParams(deltaParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        this.requireActiveTurn(state, parsed.turnId, method);
        const tracked = state.items.get(parsed.itemId);
        const category = method === "item/agentMessage/delta" ? "agent_message" : "plan";
        if (tracked === undefined || tracked.turn_id !== parsed.turnId || tracked.category !== category || tracked.state !== "active") {
          throw normalizationError("event_out_of_order", "Codex emitted a delta outside its active item lifecycle.", method);
        }
        const delta = boundContent(parsed.delta, maximumTextLength, "Streaming delta was truncated for projection.");
        return {
          ...threadBase(sequence, method, capturedAt, null, null, parsed.threadId),
          method,
          turn_id: parsed.turnId,
          item_id: parsed.itemId,
          category,
          delta: delta.text,
          content_state: delta.content_state,
          content_notice: delta.content_notice
        };
      }
      case "serverRequest/resolved": {
        const parsed = parseParams(requestResolvedParamsSchema, params, method);
        const state = this.thread(parsed.threadId, method);
        const requestId = canonicalRequestId(parsed.requestId, method);
        if (state.resolved_requests.has(requestId)) {
          throw normalizationError("duplicate_event", "Codex repeated server-request resolution.", method);
        }
        this.ensureResolvedRequestCapacity(state, method);
        state.resolved_requests.add(requestId);
        return {
          ...threadBase(sequence, method, capturedAt, null, `request:${requestId}:resolved`, parsed.threadId),
          method,
          request_id: requestId
        };
      }
      case "account/rateLimits/updated": {
        const parsed = parseParams(rateLimitParamsSchema, params, method);
        return {
          sequence,
          method,
          captured_at: capturedAt,
          upstream_at: null,
          codex_event_id: null,
          scope: "runtime",
          primary: normalizeRateWindow(parsed.rateLimits.primary, method),
          secondary: normalizeRateWindow(parsed.rateLimits.secondary, method),
          reached_type: parsed.rateLimits.rateLimitReachedType
        };
      }
      default:
        throw normalizationError("unsupported_selected_event", `Selected notification ${method} has no normalizer.`, method);
    }
  }

  private thread(threadId: CodexThreadId, method: string): TrackedThread {
    const existing = this.threads.get(threadId);
    if (existing !== undefined) {
      if (existing.archived && method !== "thread/archived") {
        throw normalizationError("event_out_of_order", "Codex emitted a selected event after thread archive.", method);
      }
      return existing;
    }
    if (this.threads.size >= this.options.max_tracked_threads) {
      throw normalizationError("normalizer_capacity_exceeded", "Codex event normalizer thread capacity is exhausted.", method);
    }
    const created: TrackedThread = {
      turns: new Map(),
      items: new Map(),
      resolved_requests: new Set(),
      active_turn_id: null,
      started: false,
      archived: false,
      last_name: undefined,
      last_status_signature: null,
      last_goal_updated_at: null,
      last_goal_signature: null,
      goal_state: "unknown",
      last_token_signature: null,
      last_token_total: null
    };
    this.threads.set(threadId, created);
    return created;
  }

  private requireKnownTurn(state: TrackedThread, turnId: CodexTurnId, method: string): TrackedTurn {
    const turn = state.turns.get(turnId);
    if (turn === undefined) throw normalizationError("event_out_of_order", "Codex event names an unknown turn.", method);
    return turn;
  }

  private requireActiveTurn(state: TrackedThread, turnId: CodexTurnId, method: string): TrackedTurn {
    const turn = this.requireKnownTurn(state, turnId, method);
    if (turn.state !== "active" || state.active_turn_id !== turnId) {
      throw normalizationError("event_out_of_order", "Codex event names a non-active turn.", method);
    }
    return turn;
  }

  private ensureTurnCapacity(state: TrackedThread, method: string): void {
    if (state.turns.size < this.options.max_tracked_turns_per_thread) return;
    throw normalizationError("normalizer_capacity_exceeded", "Codex event normalizer turn capacity is exhausted.", method);
  }

  private ensureItemCapacity(state: TrackedThread, method: string): void {
    if (state.items.size < this.options.max_tracked_items_per_thread) return;
    throw normalizationError("normalizer_capacity_exceeded", "Codex event normalizer item capacity is exhausted.", method);
  }

  private ensureResolvedRequestCapacity(state: TrackedThread, method: string): void {
    if (state.resolved_requests.size >= this.options.max_resolved_requests_per_thread) {
      throw normalizationError("normalizer_capacity_exceeded", "Codex event normalizer request identity capacity is exhausted.", method);
    }
  }

  private isManagedThread(threadId: CodexThreadId, method: string): boolean {
    try {
      const result = this.options.is_managed_thread(threadId);
      if (typeof result !== "boolean") throw new TypeError("Managed-thread classifier must return a boolean.");
      return result;
    } catch (error) {
      throw normalizationError(
        "thread_scope_resolution_failed",
        "Codex managed-thread classification failed.",
        method,
        error
      );
    }
  }

  private optionalDiagnostic(method: string, sequence: number): CodexOptionalNotificationDiagnostic {
    this.optionalTotal = Math.min(Number.MAX_SAFE_INTEGER, this.optionalTotal + 1);
    const current = this.optionalCounts.get(method);
    if (current !== undefined) {
      const next = Math.min(Number.MAX_SAFE_INTEGER, current + 1);
      this.optionalCounts.set(method, next);
      return {
        sequence,
        method,
        classification: "generated_optional",
        method_count: next,
        total_count: this.optionalTotal,
        tracked_method_count: this.optionalCounts.size,
        method_capacity_exhausted: false
      };
    }
    if (this.optionalCounts.size >= this.options.max_optional_methods) {
      return {
        sequence,
        method: boundText(method, maximumMethodLength),
        classification: "generated_optional",
        method_count: null,
        total_count: this.optionalTotal,
        tracked_method_count: this.optionalCounts.size,
        method_capacity_exhausted: true
      };
    }
    this.optionalCounts.set(method, 1);
    return {
      sequence,
      method,
      classification: "generated_optional",
      method_count: 1,
      total_count: this.optionalTotal,
      tracked_method_count: this.optionalCounts.size,
      method_capacity_exhausted: false
    };
  }

  private nextSequence(method: string): number {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      throw normalizationError("normalizer_capacity_exceeded", "Codex event normalizer sequence is exhausted.", method);
    }
    this.sequence += 1;
    return this.sequence;
  }

  private captureTime(method: string): IsoTimestamp {
    let candidate: string;
    try {
      candidate = this.options.now();
    } catch (error) {
      throw normalizationError("invalid_clock", "Codex event clock threw while capturing a timestamp.", method, error);
    }
    const parsed = isoTimestampSchema.safeParse(candidate);
    if (!parsed.success) throw normalizationError("invalid_clock", "Codex event clock returned an invalid timestamp.", method, parsed.error);
    if (this.lastCapturedAt !== null && parsed.data < this.lastCapturedAt) {
      throw normalizationError("invalid_clock", "Codex event clock moved backward.", method);
    }
    this.lastCapturedAt = parsed.data;
    return parsed.data;
  }
}

export function createCodexEventNormalizer(options: CodexEventNormalizerOptions = {}): CodexEventNormalizer {
  return new DefaultCodexEventNormalizer(parseOptions(options));
}

function parseOptions(options: CodexEventNormalizerOptions): ParsedNormalizerOptions {
  if (options === null || typeof options !== "object") throw new TypeError("Codex event normalizer options must be an object.");
  if (options.now !== undefined && typeof options.now !== "function") throw new TypeError("Codex event normalizer clock must be a function.");
  if (options.is_managed_thread !== undefined && typeof options.is_managed_thread !== "function") {
    throw new TypeError("Codex managed-thread classifier must be a function.");
  }
  return {
    now: options.now ?? (() => new Date().toISOString()),
    max_tracked_threads: parseCapacity(options.max_tracked_threads, defaults.max_tracked_threads, "thread"),
    max_tracked_turns_per_thread: parseCapacity(
      options.max_tracked_turns_per_thread,
      defaults.max_tracked_turns_per_thread,
      "turn"
    ),
    max_tracked_items_per_thread: parseCapacity(
      options.max_tracked_items_per_thread,
      defaults.max_tracked_items_per_thread,
      "item"
    ),
    max_resolved_requests_per_thread: parseCapacity(
      options.max_resolved_requests_per_thread,
      defaults.max_resolved_requests_per_thread,
      "resolved request"
    ),
    max_optional_methods: parseCapacity(options.max_optional_methods, defaults.max_optional_methods, "optional method"),
    is_managed_thread: options.is_managed_thread ?? (() => true)
  };
}

function selectedNotificationThreadId(method: string, params: unknown): CodexThreadId | null {
  if (!selectedNotificationMethods.has(method)) {
    throw normalizationError("unsupported_selected_event", `Selected notification ${method} is outside the reviewed binding.`, method);
  }
  if (method === "account/rateLimits/updated") return null;
  if (method === "thread/started") return parseParams(threadStartedIdentityEnvelopeSchema, params, method).thread.id;
  return parseParams(threadIdentityEnvelopeSchema, params, method).threadId;
}

function parseCapacity(candidate: number | undefined, fallback: number, label: string): number {
  const value = candidate ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new TypeError(`Codex event normalizer ${label} capacity must be a positive safe integer no greater than 100000.`);
  }
  return value;
}

function threadBase<Method extends string>(
  sequence: number,
  method: Method,
  capturedAt: IsoTimestamp,
  upstreamAt: IsoTimestamp | null,
  eventId: string | null,
  threadId: CodexThreadId
): NormalizedCodexThreadBase<Method> {
  return {
    sequence,
    method,
    captured_at: capturedAt,
    upstream_at: upstreamAt,
    codex_event_id: eventId,
    scope: "thread",
    thread_id: threadId
  };
}

function normalizeThreadStatus(
  status: z.output<typeof threadStatusSchema>,
  method: string
): { readonly status: NormalizedCodexThreadStatus; readonly active_flags: readonly NormalizedCodexActiveFlag[] } {
  if (status.type === "notLoaded") return { status: "not_loaded", active_flags: [] };
  if (status.type === "idle") return { status: "idle", active_flags: [] };
  if (status.type === "systemError") return { status: "system_error", active_flags: [] };
  const flags = status.activeFlags.map((flag) =>
    flag === "waitingOnApproval" ? ("waiting_on_approval" as const) : ("waiting_on_user_input" as const)
  );
  if (new Set(flags).size !== flags.length) {
    throw normalizationError("malformed_required_event", "Codex active-thread flags contain duplicates.", method);
  }
  return { status: "active", active_flags: flags };
}

function normalizeGoalStatus(status: z.output<typeof goalSchema>["status"]): NormalizedCodexGoalStatus {
  if (status === "usageLimited") return "usage_limited";
  if (status === "budgetLimited") return "budget_limited";
  return status;
}

function normalizeTurnStatus(status: z.output<typeof turnSchema>["status"]): "completed" | "failed" | "interrupted" {
  if (status === "inProgress") throw new TypeError("In-progress turn cannot be normalized as terminal.");
  return status;
}

function normalizePlanStatus(status: z.output<typeof planStepSchema>["status"]): NormalizedCodexPlanStep["status"] {
  return status === "inProgress" ? "in_progress" : status;
}

function normalizeTokenUsage(usage: z.output<typeof tokenUsageSchema>): NormalizedCodexTokenUsage {
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens
  };
}

function normalizeRateWindow(
  window: z.output<typeof rateLimitWindowSchema> | null,
  method: string
): NormalizedCodexRateLimitWindow | null {
  if (window === null) return null;
  return {
    used_percent: window.usedPercent,
    window_duration_minutes: window.windowDurationMins,
    resets_at: nullableUnixSecondsToIso(window.resetsAt, method)
  };
}
