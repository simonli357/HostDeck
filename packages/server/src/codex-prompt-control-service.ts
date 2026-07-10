import {
  type CodexTurnAccepted,
  type CodexTurnClient,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  isoTimestampSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  type PromptTurnControlSnapshot,
  promptOperationIntentSchema,
  promptTurnControlSnapshotSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";
import {
  type CodexModelControlService,
  HostDeckCodexModelControlError
} from "./codex-model-control-service.js";
import {
  type CodexPlanControlService,
  HostDeckCodexPlanControlError
} from "./codex-plan-control-service.js";
import {
  combinePendingTurnSettingsReaders,
  type PendingTurnSetting,
  type PendingTurnSettingsReader
} from "./pending-turn-settings.js";

type PromptOperationIntent = Extract<SelectedOperationIntent, { readonly kind: "prompt" }>;

export type CodexPromptControlErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "operation_conflict"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_writable"
  | "unknown_outcome";

export type CodexPromptControlOutcome = "not_sent" | "remote_rejected" | "unknown";

export class HostDeckCodexPromptControlError extends Error {
  constructor(
    readonly code: CodexPromptControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly outcome: CodexPromptControlOutcome,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexPromptControlError";
  }
}

export interface CodexPromptDispatchResult extends CodexTurnAccepted {
  readonly action: "start" | "steer";
  readonly model_revision: number | null;
  readonly plan_revision: number | null;
  readonly steerable: boolean;
}

export interface CodexPromptModelPort extends PendingTurnSettingsReader {
  readonly dispatchPendingTurn: CodexModelControlService["dispatchPendingTurn"];
}

export interface CodexPromptPlanPort extends PendingTurnSettingsReader {
  readonly dispatchPendingTurn: CodexPlanControlService["dispatchPendingTurn"];
}

export interface CodexPromptControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexPromptControlServiceOptions {
  readonly turns: CodexTurnClient;
  readonly models: CodexPromptModelPort;
  readonly plans: CodexPromptPlanPort;
  readonly states: CodexPromptControlStatePort;
  readonly max_tracked_turns?: number;
  readonly now?: () => string;
}

export interface CodexPromptControlService {
  readonly snapshot: (target: unknown) => Promise<PromptTurnControlSnapshot>;
  readonly dispatch: (intent: unknown, signal?: AbortSignal) => Promise<CodexPromptDispatchResult>;
  readonly observeEvent: (event: NormalizedCodexEvent) => Promise<void>;
  readonly tracked_count: number;
}

interface TurnObservation {
  readonly turn_id: string;
  readonly captured_at: IsoTimestamp;
}

const activeTurnStates = new Set(["in_progress", "waiting_for_approval", "waiting_for_input", "unknown"]);
const terminalTurnStates = new Set(["idle", "completed", "interrupted", "failed"]);
const idleSnapshot: PromptTurnControlSnapshot = Object.freeze({
  phase: "idle",
  last_action: null,
  operation_id: null,
  turn_id: null,
  model_revision: null,
  plan_revision: null,
  requested_at: null,
  accepted_at: null,
  started_at: null,
  error: null
});

export function createCodexPromptControlService(options: CodexPromptControlServiceOptions): CodexPromptControlService {
  const implementation = new DefaultCodexPromptControlService(options);
  return Object.freeze({
    snapshot: (target: unknown) => implementation.snapshot(target),
    dispatch: (intent: unknown, signal?: AbortSignal) => implementation.dispatch(intent, signal),
    observeEvent: (event: NormalizedCodexEvent) => implementation.observeEvent(event),
    get tracked_count() {
      return implementation.tracked_count;
    }
  });
}

class DefaultCodexPromptControlService implements CodexPromptControlService {
  private readonly stateBySession = new Map<string, PromptTurnControlSnapshot>();
  private readonly earlyStartedBySession = new Map<string, TurnObservation>();
  private readonly terminalBySession = new Map<string, TurnObservation>();
  private readonly activeProjectionSeenBySession = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingSettings: PendingTurnSettingsReader;
  private readonly maxTrackedTurns: number;
  private readonly now: () => string;

  constructor(private readonly options: CodexPromptControlServiceOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.turns?.startTurn !== "function" ||
      typeof options.turns?.steerTurn !== "function" ||
      typeof options.models?.dispatchPendingTurn !== "function" ||
      typeof options.models?.readPendingSettings !== "function" ||
      typeof options.plans?.dispatchPendingTurn !== "function" ||
      typeof options.plans?.readPendingSettings !== "function" ||
      typeof options.states?.get !== "function" ||
      typeof options.states?.getByThreadId !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Codex prompt control requires exact turn, pending-control, and selected-state ports.");
    }
    this.pendingSettings = combinePendingTurnSettingsReaders([options.models, options.plans]);
    this.maxTrackedTurns = parseCapacity(options.max_tracked_turns);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get tracked_count(): number {
    return this.stateBySession.size;
  }

  async snapshot(targetInput: unknown): Promise<PromptTurnControlSnapshot> {
    const target = parseTarget(targetInput);
    return this.serialized(target.session_id, async () => {
      const state = this.requireTarget(target, false);
      this.reconcileTerminalProjection(target.session_id, state);
      return this.stateBySession.get(target.session_id) ?? idleSnapshot;
    });
  }

  async dispatch(input: unknown, signal?: AbortSignal): Promise<CodexPromptDispatchResult> {
    const intent = parsePromptIntent(input);
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw promptError("invalid_request", "validation_error", "The prompt request signal is invalid.", "not_sent", true);
    }
    return this.serialized(intent.target.session_id, async () => {
      const state = this.requireTarget(intent.target, true);
      this.reconcileTerminalProjection(intent.target.session_id, state);
      if (state.projection.session.turn_state === "in_progress") {
        return this.steer(intent, state, signal);
      }
      if (activeTurnStates.has(state.projection.session.turn_state)) {
        throw promptError(
          "operation_conflict",
          "operation_conflict",
          `The selected turn is ${state.projection.session.turn_state} and cannot accept a prompt start or steer.`,
          "not_sent",
          true
        );
      }
      return this.start(intent, state, signal);
    });
  }

  async observeEvent(event: NormalizedCodexEvent): Promise<void> {
    if (!("thread_id" in event)) return;
    const state = this.options.states.getByThreadId(event.thread_id);
    if (state === null) return;
    if (event.method === "turn/started") {
      const current = this.stateBySession.get(state.mapping.id);
      if (current?.phase === "starting") {
        this.earlyStartedBySession.set(state.mapping.id, {
          turn_id: event.turn_id,
          captured_at: event.captured_at
        });
      }
    }
    if (event.method === "turn/completed") {
      const current = this.stateBySession.get(state.mapping.id);
      if (current?.phase === "starting" || current?.turn_id === event.turn_id) {
        this.terminalBySession.set(state.mapping.id, {
          turn_id: event.turn_id,
          captured_at: event.captured_at
        });
      }
    }

    await this.serialized(state.mapping.id, async () => {
      if (event.method === "thread/archived" || state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
        this.clearSession(state.mapping.id);
        return;
      }
      const current = this.stateBySession.get(state.mapping.id);
      if (current === undefined) return;
      if (event.method === "turn/started" && current.turn_id === event.turn_id) {
        if (["accepted", "steerable"].includes(current.phase)) {
          this.stateBySession.set(
            state.mapping.id,
            parseSnapshot({ ...current, phase: "steerable", started_at: event.captured_at })
          );
        }
        return;
      }
      if (event.method === "turn/completed" && current.turn_id === event.turn_id) {
        this.clearSession(state.mapping.id);
      }
    });
  }

  private async start(
    intent: PromptOperationIntent,
    state: SelectedSessionState,
    signal?: AbortSignal
  ): Promise<CodexPromptDispatchResult> {
    const existing = this.stateBySession.get(intent.target.session_id);
    if (existing !== undefined) {
      throw promptError(
        "operation_conflict",
        existing.phase === "unknown" ? "unknown_error" : "operation_conflict",
        "A prior prompt operation is still awaiting authoritative reconciliation.",
        "not_sent",
        false
      );
    }
    if (this.stateBySession.size >= this.maxTrackedTurns) {
      throw promptError(
        "service_overloaded",
        "service_overloaded",
        "The tracked prompt-turn capacity is exhausted.",
        "not_sent",
        true
      );
    }
    if (!terminalTurnStates.has(state.projection.session.turn_state)) {
      throw promptError(
        "operation_conflict",
        "operation_conflict",
        "The selected thread does not have a proven startable turn state.",
        "not_sent",
        true
      );
    }

    let pending: readonly PendingTurnSetting[];
    try {
      pending = this.pendingSettings.readPendingSettings(intent.target);
    } catch (error) {
      throw promptError(
        "runtime_protocol_error",
        "internal_error",
        "Pending turn settings violated the prompt composition contract.",
        "not_sent",
        false,
        error
      );
    }
    assertDispatchableSettings(pending);
    const modelRevision = pending.find((setting) => setting.control === "model")?.revision ?? null;
    const planRevision = pending.find((setting) => setting.control === "plan")?.revision ?? null;
    const requestedAt = this.timestamp();
    this.stateBySession.set(
      intent.target.session_id,
      parseSnapshot({
        phase: "starting",
        last_action: "start",
        operation_id: intent.operation_id,
        turn_id: null,
        model_revision: modelRevision,
        plan_revision: planRevision,
        requested_at: requestedAt,
        accepted_at: null,
        started_at: null,
        error: null
      })
    );
    this.activeProjectionSeenBySession.delete(intent.target.session_id);

    let accepted: CodexTurnAccepted;
    let acceptedBeforeFailure: CodexTurnAccepted | null = null;
    try {
      if (planRevision !== null) {
        const result = await this.options.plans.dispatchPendingTurn(
          {
            ...intent,
            expected_plan_revision: planRevision,
            expected_model_revision: modelRevision
          },
          signal
        );
        acceptedBeforeFailure = result;
        if (result.plan_revision !== planRevision || result.model_revision !== modelRevision) {
          throw promptError(
            "runtime_protocol_error",
            "protocol_error",
            "Plan dispatch settled different pending revisions than the prompt snapshot.",
            "unknown",
            false
          );
        }
        accepted = result;
      } else if (modelRevision !== null) {
        const result = await this.options.models.dispatchPendingTurn(
          { ...intent, expected_pending_revision: modelRevision },
          signal
        );
        acceptedBeforeFailure = result;
        if (result.pending_revision !== modelRevision) {
          throw promptError(
            "runtime_protocol_error",
            "protocol_error",
            "Model dispatch settled a different pending revision than the prompt snapshot.",
            "unknown",
            false
          );
        }
        accepted = result;
      } else {
        accepted = await this.options.turns.startTurn({
          operation_id: intent.operation_id,
          thread_id: intent.target.codex_thread_id,
          text: intent.text,
          settings: { kind: "inherit" },
          ...(signal === undefined ? {} : { signal })
        });
        acceptedBeforeFailure = accepted;
      }
    } catch (error) {
      const mapped = mapDispatchError(error, "Codex prompt start failed.");
      const terminal = this.terminalBySession.get(intent.target.session_id) ?? null;
      this.earlyStartedBySession.delete(intent.target.session_id);
      this.terminalBySession.delete(intent.target.session_id);
      if (acceptedBeforeFailure !== null && terminal?.turn_id === acceptedBeforeFailure.turn_id) {
        this.clearSession(intent.target.session_id);
      } else if (mapped.outcome === "unknown") {
        this.stateBySession.set(
          intent.target.session_id,
          parseSnapshot({
            phase: "unknown",
            last_action: "start",
            operation_id: intent.operation_id,
            turn_id: acceptedBeforeFailure?.turn_id ?? null,
            model_revision: modelRevision,
            plan_revision: planRevision,
            requested_at: requestedAt,
            accepted_at: acceptedBeforeFailure === null ? null : requestedAt,
            started_at: null,
            error: errorEnvelope(mapped)
          })
        );
      } else {
        this.clearSession(intent.target.session_id);
      }
      throw mapped;
    }

    if (accepted.thread_id !== intent.target.codex_thread_id) {
      const error = promptError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex accepted the prompt for a different thread.",
        "unknown",
        false
      );
      this.stateBySession.set(
        intent.target.session_id,
        parseSnapshot({
          phase: "unknown",
          last_action: "start",
          operation_id: intent.operation_id,
          turn_id: accepted.turn_id,
          model_revision: modelRevision,
          plan_revision: planRevision,
          requested_at: requestedAt,
          accepted_at: requestedAt,
          started_at: null,
          error: errorEnvelope(error)
        })
      );
      throw error;
    }

    const acceptedAt = requestedAt;
    const earlyStarted = this.earlyStartedBySession.get(intent.target.session_id) ?? null;
    const terminal = this.terminalBySession.get(intent.target.session_id) ?? null;
    this.earlyStartedBySession.delete(intent.target.session_id);
    this.terminalBySession.delete(intent.target.session_id);
    if (earlyStarted !== null && earlyStarted.turn_id !== accepted.turn_id) {
      const error = promptError(
        "runtime_protocol_error",
        "protocol_error",
        "A different turn started while the prompt response was pending.",
        "unknown",
        false
      );
      this.stateBySession.set(
        intent.target.session_id,
        parseSnapshot({
          phase: "unknown",
          last_action: "start",
          operation_id: intent.operation_id,
          turn_id: accepted.turn_id,
          model_revision: modelRevision,
          plan_revision: planRevision,
          requested_at: requestedAt,
          accepted_at: acceptedAt,
          started_at: null,
          error: errorEnvelope(error)
        })
      );
      throw error;
    }

    const startedAt = earlyStarted?.captured_at ?? null;
    if (terminal?.turn_id === accepted.turn_id) {
      this.clearSession(intent.target.session_id);
    } else {
      this.stateBySession.set(
        intent.target.session_id,
        parseSnapshot({
          phase: startedAt === null ? "accepted" : "steerable",
          last_action: "start",
          operation_id: intent.operation_id,
          turn_id: accepted.turn_id,
          model_revision: modelRevision,
          plan_revision: planRevision,
          requested_at: requestedAt,
          accepted_at: acceptedAt,
          started_at: startedAt,
          error: null
        })
      );
    }
    return Object.freeze({
      ...accepted,
      action: "start",
      model_revision: modelRevision,
      plan_revision: planRevision,
      steerable: startedAt !== null && terminal?.turn_id !== accepted.turn_id
    });
  }

  private async steer(
    intent: PromptOperationIntent,
    state: SelectedSessionState,
    signal?: AbortSignal
  ): Promise<CodexPromptDispatchResult> {
    const current = this.stateBySession.get(intent.target.session_id);
    if (current?.phase !== "steerable" || current.turn_id === null || current.started_at === null || current.accepted_at === null) {
      throw promptError(
        "operation_conflict",
        "operation_conflict",
        "The active turn is not steerable without a matching accepted response and turn-start event.",
        "not_sent",
        true
      );
    }
    if (state.projection.session.turn_state !== "in_progress") {
      throw promptError(
        "operation_conflict",
        "operation_conflict",
        "Only an in-progress turn may be steered.",
        "not_sent",
        true
      );
    }

    const requestedAt = this.timestamp();
    this.stateBySession.set(
      intent.target.session_id,
      parseSnapshot({
        ...current,
        phase: "steering",
        last_action: "steer",
        operation_id: intent.operation_id,
        requested_at: requestedAt,
        error: null
      })
    );

    try {
      const steered = await this.options.turns.steerTurn({
        operation_id: intent.operation_id,
        thread_id: intent.target.codex_thread_id,
        expected_turn_id: current.turn_id,
        text: intent.text,
        ...(signal === undefined ? {} : { signal })
      });
      if (steered.thread_id !== intent.target.codex_thread_id || steered.turn_id !== current.turn_id) {
        throw promptError(
          "runtime_protocol_error",
          "protocol_error",
          "Codex steer acceptance changed the exact thread or turn target.",
          "unknown",
          false
        );
      }
      const terminal = this.terminalBySession.get(intent.target.session_id);
      this.terminalBySession.delete(intent.target.session_id);
      if (terminal?.turn_id === current.turn_id) {
        this.clearSession(intent.target.session_id);
      } else {
        this.stateBySession.set(
          intent.target.session_id,
          parseSnapshot({
            ...current,
            phase: "steerable",
            last_action: "steer",
            operation_id: intent.operation_id,
            requested_at: requestedAt,
            error: null
          })
        );
      }
      return Object.freeze({
        ...steered,
        action: "steer",
        model_revision: current.model_revision,
        plan_revision: current.plan_revision,
        steerable: terminal?.turn_id !== current.turn_id
      });
    } catch (error) {
      const mapped = mapDispatchError(error, "Codex turn steer failed.");
      const terminal = this.terminalBySession.get(intent.target.session_id);
      this.terminalBySession.delete(intent.target.session_id);
      if (terminal?.turn_id === current.turn_id) {
        this.clearSession(intent.target.session_id);
      } else {
        this.stateBySession.set(
          intent.target.session_id,
          parseSnapshot({
            ...current,
            phase: mapped.outcome === "unknown" ? "unknown" : "conflict",
            last_action: "steer",
            operation_id: intent.operation_id,
            requested_at: requestedAt,
            error: errorEnvelope(mapped)
          })
        );
      }
      throw mapped;
    }
  }

  private reconcileTerminalProjection(sessionId: string, state: SelectedSessionState): void {
    const current = this.stateBySession.get(sessionId);
    if (current === undefined || current.turn_id === null) return;
    if (activeTurnStates.has(state.projection.session.turn_state)) {
      this.activeProjectionSeenBySession.add(sessionId);
      return;
    }
    if (
      terminalTurnStates.has(state.projection.session.turn_state) &&
      this.activeProjectionSeenBySession.has(sessionId) &&
      ["accepted", "steerable", "steering", "conflict"].includes(current.phase)
    ) {
      this.clearSession(sessionId);
    }
  }

  private requireTarget(target: ManagedSessionTarget, writable: boolean): SelectedSessionState {
    const state = this.options.states.get(target.session_id);
    if (state === null) {
      this.clearSession(target.session_id);
      throw promptError("target_not_found", "session_not_found", "The selected managed session does not exist.", "not_sent", false);
    }
    if (state.mapping.codex_thread_id !== target.codex_thread_id) {
      throw promptError("target_mismatch", "invalid_session_id", "The selected session and Codex thread identity do not match.", "not_sent", false);
    }
    if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
      this.clearSession(target.session_id);
      throw promptError("target_not_writable", "session_not_writable", "The selected managed session is archived.", "not_sent", false);
    }
    if (
      writable &&
      (state.projection.session.session_state !== "active" || state.projection.session.freshness !== "current")
    ) {
      throw promptError(
        "target_not_writable",
        state.projection.session.freshness === "current" ? "session_not_writable" : "stale_session",
        "The selected managed session is not currently writable.",
        "not_sent",
        true
      );
    }
    return state;
  }

  private clearSession(sessionId: string): void {
    this.stateBySession.delete(sessionId);
    this.earlyStartedBySession.delete(sessionId);
    this.terminalBySession.delete(sessionId);
    this.activeProjectionSeenBySession.delete(sessionId);
  }

  private timestamp(): IsoTimestamp {
    const parsed = isoTimestampSchema.safeParse(this.now());
    if (!parsed.success) {
      throw promptError("invalid_request", "internal_error", "The prompt-control clock returned an invalid timestamp.", "not_sent", false, parsed.error);
    }
    return parsed.data;
  }

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate, () => gate);
    this.tails.set(sessionId, tail);
    return prior
      .then(operation, operation)
      .finally(() => {
        release();
        if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
      });
  }
}

function parseTarget(candidate: unknown): ManagedSessionTarget {
  const parsed = managedSessionTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw promptError("invalid_request", "validation_error", "The prompt-control target is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parsePromptIntent(candidate: unknown): PromptOperationIntent {
  const parsed = promptOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw promptError("invalid_request", "validation_error", "The prompt request is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseSnapshot(candidate: unknown): PromptTurnControlSnapshot {
  const parsed = promptTurnControlSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    throw promptError("runtime_protocol_error", "internal_error", "Prompt control produced invalid internal state.", "unknown", false, parsed.error);
  }
  return Object.freeze({
    ...parsed.data,
    error: parsed.data.error === null ? null : Object.freeze({ ...parsed.data.error })
  });
}

function parseCapacity(candidate: number | undefined): number {
  const definition = resourceBudgetDefinitionByKey.control_prompt_max_tracked_turns;
  const value = candidate ?? defaultResourceBudget.control_prompt_max_tracked_turns;
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
    throw new TypeError(`Prompt tracked-turn capacity must be between ${definition.minimum} and ${definition.maximum}.`);
  }
  return value;
}

function assertDispatchableSettings(settings: readonly PendingTurnSetting[]): void {
  const blocked = settings.find((setting) => setting.phase !== "pending");
  if (blocked !== undefined) {
    throw promptError(
      "operation_conflict",
      blocked.phase === "unknown" ? "unknown_error" : "operation_conflict",
      `Pending ${blocked.control} revision ${blocked.revision} is ${blocked.phase} and cannot be consumed.`,
      "not_sent",
      false
    );
  }
}

function mapDispatchError(error: unknown, fallback: string): HostDeckCodexPromptControlError {
  if (error instanceof HostDeckCodexPromptControlError) return error;
  if (error instanceof HostDeckCodexModelControlError || error instanceof HostDeckCodexPlanControlError) {
    if (error.code === "capability_unsupported") {
      return promptError("capability_unsupported", error.api_code, error.message, "not_sent", error.retry_safe, error);
    }
    if (error.code === "service_overloaded") {
      return promptError("service_overloaded", error.api_code, error.message, "not_sent", error.retry_safe, error);
    }
    if (error.outcome === "unknown") {
      return promptError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
    }
    if (error.outcome === "remote_rejected") {
      return promptError("operation_conflict", error.api_code, error.message, "remote_rejected", error.retry_safe, error);
    }
    if (error.code === "runtime_protocol_error") {
      return promptError("runtime_protocol_error", error.api_code, error.message, "not_sent", error.retry_safe, error);
    }
    if (error.code === "runtime_unavailable") {
      return promptError("runtime_unavailable", error.api_code, error.message, "not_sent", error.retry_safe, error);
    }
    if (error.code === "invalid_request") {
      return promptError("invalid_request", error.api_code, error.message, "not_sent", error.retry_safe, error);
    }
    if (["target_mismatch", "target_not_found", "target_not_writable"].includes(error.code)) {
      return promptError(error.code as "target_mismatch" | "target_not_found" | "target_not_writable", error.api_code, error.message, "not_sent", error.retry_safe, error);
    }
    return promptError("operation_conflict", error.api_code, error.message, "not_sent", error.retry_safe, error);
  }
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return promptError("runtime_unavailable", "runtime_unavailable", fallback, "unknown", false, error);
  }
  if (error.code === "unsupported_method") {
    return promptError("capability_unsupported", "capability_unavailable", error.message, "not_sent", false, error);
  }
  if (error.outcome === "unknown") {
    return promptError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (error.outcome === "remote_rejected") {
    return promptError("operation_conflict", "operation_conflict", error.message, "remote_rejected", error.retry_safe, error);
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    if (error.outcome !== "not_sent") {
      return promptError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
    }
    return promptError("runtime_protocol_error", "protocol_error", error.message, "not_sent", false, error);
  }
  if (error.outcome === "not_applicable") {
    return promptError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (error.code === "broker_overloaded") {
    return promptError("service_overloaded", "service_overloaded", error.message, "not_sent", error.retry_safe, error);
  }
  return promptError("runtime_unavailable", "runtime_unavailable", error.message || fallback, "not_sent", error.retry_safe, error);
}

function errorEnvelope(error: HostDeckCodexPromptControlError): NonNullable<PromptTurnControlSnapshot["error"]> {
  return { code: error.api_code, message: error.message, retryable: error.retry_safe };
}

function promptError(
  code: CodexPromptControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  outcome: CodexPromptControlOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexPromptControlError {
  return new HostDeckCodexPromptControlError(code, apiCode, message, outcome, retrySafe, { cause });
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex prompt control failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
