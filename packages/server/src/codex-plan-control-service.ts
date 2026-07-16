import {
  type CodexPlanCatalog,
  type CodexPlanClient,
  type CodexPlanTurnAccepted,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  isoTimestampSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  type PendingPlanSelection,
  type PlanControlSnapshot,
  type PlanExecutionSnapshot,
  type PlanMode,
  planControlSnapshotSchema,
  planOperationIntentSchema,
  positiveSafeIntegerSchema,
  promptOperationIntentSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";
import {
  type CodexModelTurnSettingsParticipant,
  type CodexPreparedModelTurnSettings,
  HostDeckCodexModelControlError
} from "./codex-model-control-service.js";
import type {
  PendingTurnDispatchSettlement,
  PendingTurnSetting,
  PendingTurnSettingsReader
} from "./pending-turn-settings.js";

type PlanOperationIntent = Extract<SelectedOperationIntent, { readonly kind: "plan" }>;

export type CodexPlanControlErrorCode =
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

export type CodexPlanControlOutcome = "not_sent" | "remote_rejected" | "unknown";

export class HostDeckCodexPlanControlError extends Error {
  constructor(
    readonly code: CodexPlanControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly outcome: CodexPlanControlOutcome,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexPlanControlError";
  }
}

export interface CodexPendingPlanTurnAccepted extends CodexPlanTurnAccepted {
  readonly plan_revision: number;
  readonly model_revision: number | null;
}

export interface CodexPlanControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexPlanControlServiceOptions {
  readonly plans: CodexPlanClient;
  readonly models: CodexModelTurnSettingsParticipant;
  readonly states: CodexPlanControlStatePort;
  readonly max_pending_selections?: number;
  readonly now?: () => string;
}

export interface CodexPlanControlService extends PendingTurnSettingsReader {
  readonly snapshot: (target: unknown, signal?: AbortSignal) => Promise<PlanControlSnapshot>;
  readonly select: (intent: unknown, signal?: AbortSignal) => Promise<PlanControlSnapshot>;
  readonly dispatchPendingTurn: (input: unknown, signal?: AbortSignal) => Promise<CodexPendingPlanTurnAccepted>;
  readonly observeEvent: (event: NormalizedCodexEvent) => Promise<void>;
  readonly reconcile: (
    target: unknown,
    expectedPendingRevision: unknown,
    signal?: AbortSignal
  ) => Promise<PlanControlSnapshot>;
  readonly pending_count: number;
}

interface InternalPendingPlan extends PendingPlanSelection {
  readonly catalog_revision: string;
  readonly baseline_mode: PlanMode | null;
}

interface PendingPlanTurnRequest {
  readonly operation_id: string;
  readonly target: ManagedSessionTarget;
  readonly text: string;
  readonly expected_plan_revision: number;
  readonly expected_model_revision: number | null;
}

const pendingTurnSchema = promptOperationIntentSchema.extend({
  expected_plan_revision: positiveSafeIntegerSchema,
  expected_model_revision: positiveSafeIntegerSchema.nullable()
});

const activeTurnStates = new Set(["in_progress", "waiting_for_approval", "waiting_for_input", "unknown"]);
const idleExecution: PlanExecutionSnapshot = Object.freeze({
  turn_id: null,
  state: "idle",
  evidence: "none",
  summary: null,
  updated_at: null
});

export function createCodexPlanControlService(options: CodexPlanControlServiceOptions): CodexPlanControlService {
  const implementation = new DefaultCodexPlanControlService(options);
  return Object.freeze({
    snapshot: (target: unknown, signal?: AbortSignal) => implementation.snapshot(target, signal),
    select: (intent: unknown, signal?: AbortSignal) => implementation.select(intent, signal),
    dispatchPendingTurn: (input: unknown, signal?: AbortSignal) => implementation.dispatchPendingTurn(input, signal),
    observeEvent: (event: NormalizedCodexEvent) => implementation.observeEvent(event),
    reconcile: (target: unknown, expectedPendingRevision: unknown, signal?: AbortSignal) =>
      implementation.reconcile(target, expectedPendingRevision, signal),
    readPendingSettings: (target: ManagedSessionTarget) => implementation.readPendingSettings(target),
    get pending_count() {
      return implementation.pending_count;
    }
  });
}

class DefaultCodexPlanControlService implements CodexPlanControlService {
  private readonly pendingBySession = new Map<string, InternalPendingPlan>();
  private readonly dispatchConfirmationsBySession = new Map<string, "matched" | "conflict">();
  private readonly currentBySession = new Map<string, PlanControlSnapshot["current"]>();
  private readonly executionBySession = new Map<string, PlanExecutionSnapshot>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly maxPendingSelections: number;
  private readonly now: () => string;
  private nextRevision = 1;
  private pendingReservations = 0;

  constructor(private readonly options: CodexPlanControlServiceOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.plans?.listCatalog !== "function" ||
      typeof options.plans?.startTurn !== "function" ||
      typeof options.models?.prepareTurnSettings !== "function" ||
      typeof options.models?.settlePreparedTurn !== "function" ||
      typeof options.models?.observeSettings !== "function" ||
      typeof options.states?.get !== "function" ||
      typeof options.states?.getByThreadId !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Codex Plan control requires exact Plan, model-settings, and selected-state ports.");
    }
    this.maxPendingSelections = parseCapacity(options.max_pending_selections);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get pending_count(): number {
    return this.pendingBySession.size;
  }

  readPendingSettings(target: ManagedSessionTarget): readonly PendingTurnSetting[] {
    const candidate = this.options.states.get(target.session_id);
    const state = candidate === null ? null : parseSelectedPlanState(candidate);
    if (
      state === null ||
      state.mapping.id !== target.session_id ||
      state.mapping.codex_thread_id !== target.codex_thread_id ||
      !selectedIdentityMatches(state) ||
      state.mapping.disposition !== "selected" ||
      state.mapping.archived_at !== null ||
      state.projection.session.session_state !== "active" ||
      state.projection.session.freshness !== "current"
    ) {
      return [];
    }
    const pending = this.pendingBySession.get(target.session_id);
    if (pending === undefined) return [];
    return Object.freeze([Object.freeze({ control: "plan" as const, revision: pending.revision, phase: pending.phase })]);
  }

  async snapshot(targetInput: unknown, signal?: AbortSignal): Promise<PlanControlSnapshot> {
    const target = parseTarget(targetInput);
    return this.serialized(target.session_id, async () => {
      this.requireTarget(target, false);
      const catalog = await this.listCatalog(signal);
      this.requireTarget(target, false);
      this.reconcileCatalogDrift(target.session_id, catalog);
      this.reconcileFromCurrent(target.session_id);
      return this.buildSnapshot(target.session_id, catalog);
    });
  }

  async select(input: unknown, signal?: AbortSignal): Promise<PlanControlSnapshot> {
    const intent = parsePlanIntent(input);
    return this.serialized(intent.target.session_id, async () => {
      this.requireTarget(intent.target, true);
      const existing = this.pendingBySession.get(intent.target.session_id) ?? null;
      assertExpectedRevision(intent.expected_pending_revision, existing);
      if (existing !== null && !["pending", "conflict"].includes(existing.phase)) {
        throw planError(
          "operation_conflict",
          "operation_conflict",
          "The current Plan selection is already dispatching or awaiting reconciliation.",
          "not_sent",
          false
        );
      }
      const reserved = existing === null;
      if (reserved && this.pendingBySession.size + this.pendingReservations >= this.maxPendingSelections) {
        throw planError(
          "service_overloaded",
          "service_overloaded",
          "The pending Plan-selection capacity is exhausted.",
          "not_sent",
          true
        );
      }
      if (reserved) this.pendingReservations += 1;

      try {
        const catalog = await this.listCatalog(signal);
        this.requireTarget(intent.target, true);
        const mode = modeForAction(intent.action);
        if (!catalog.modes.some((entry) => entry.mode === mode)) {
          throw planError(
            "capability_unsupported",
            "capability_unavailable",
            `Codex did not expose the required ${mode} collaboration mode.`,
            "not_sent",
            false
          );
        }
        const current = this.currentBySession.get(intent.target.session_id);
        if (current?.state === "confirmed" && current.mode === mode) {
          if (existing !== null) this.pendingBySession.delete(intent.target.session_id);
          return this.buildSnapshot(intent.target.session_id, catalog);
        }

        this.pendingBySession.set(intent.target.session_id, {
          revision: this.allocateRevision(),
          selection_operation_id: intent.operation_id,
          mode,
          catalog_state: "available",
          phase: "pending",
          selected_at: this.timestamp(),
          turn_id: null,
          resolved_settings: null,
          error: null,
          catalog_revision: catalog.revision,
          baseline_mode: current?.mode ?? null
        });
        return this.buildSnapshot(intent.target.session_id, catalog);
      } finally {
        if (reserved) this.pendingReservations -= 1;
      }
    });
  }

  async dispatchPendingTurn(input: unknown, signal?: AbortSignal): Promise<CodexPendingPlanTurnAccepted> {
    const request = parsePendingTurn(input);
    return this.serialized(request.target.session_id, async () => {
      const state = this.requireTarget(request.target, true);
      assertIdleTurn(state);
      const pending = this.requirePending(request.target.session_id, request.expected_plan_revision);
      if (pending.phase !== "pending") {
        throw planError(
          "operation_conflict",
          "operation_conflict",
          "The selected Plan mode is already dispatching or awaiting reconciliation.",
          "not_sent",
          false
        );
      }

      const catalog = await this.listCatalog(signal);
      const mode = catalog.modes.find((entry) => entry.mode === pending.mode);
      if (mode === undefined) {
        this.setConflict(request.target.session_id, pending, "The pending Plan mode is absent from the live Codex catalog.", false);
        throw planError(
          "capability_unsupported",
          "capability_unavailable",
          "The pending Plan mode is absent from the live Codex catalog.",
          "not_sent",
          false
        );
      }

      let modelPreparation: CodexPreparedModelTurnSettings;
      try {
        modelPreparation = await this.options.models.prepareTurnSettings(
          request.target,
          request.expected_model_revision,
          signal
        );
      } catch (error) {
        this.requireTarget(request.target, false);
        throw mapModelError(error);
      }
      const resolvedSettings = {
        runtime_model:
          modelPreparation.pending_revision === null
            ? (mode.preset_model ?? modelPreparation.runtime_model)
            : modelPreparation.runtime_model,
        reasoning_effort:
          modelPreparation.pending_revision === null
            ? mode.preset_reasoning_effort
            : modelPreparation.reasoning_effort
      };

      try {
        const currentTarget = this.requireTarget(request.target, true);
        assertIdleTurn(currentTarget);
      } catch (error) {
        await this.releaseModelPreparation(modelPreparation);
        throw error;
      }

      const dispatchPending: InternalPendingPlan = {
        ...pending,
        catalog_revision: catalog.revision,
        baseline_mode: this.currentBySession.get(request.target.session_id)?.mode ?? pending.baseline_mode,
        catalog_state: "available",
        phase: "dispatching",
        turn_id: null,
        resolved_settings: resolvedSettings,
        error: null
      };
      this.pendingBySession.set(request.target.session_id, dispatchPending);

      let accepted: CodexPlanTurnAccepted;
      try {
        accepted = await this.options.plans.startTurn({
          operation_id: request.operation_id,
          thread_id: request.target.codex_thread_id,
          text: request.text,
          mode,
          runtime_model: resolvedSettings.runtime_model,
          reasoning_effort: resolvedSettings.reasoning_effort,
          ...(signal === undefined ? {} : { signal })
        });
      } catch (error) {
        const mapped = mapAdapterError(error, "Codex Plan turn dispatch failed.", true);
        const settlement = settlementForError(mapped);
        await this.settleModelOrLatchUnknown(request.target.session_id, dispatchPending, modelPreparation, settlement);
        this.settlePlanDispatch(request.target.session_id, dispatchPending, settlement);
        throw mapped;
      }

      if (accepted.thread_id !== request.target.codex_thread_id) {
        const error = planError(
          "runtime_protocol_error",
          "protocol_error",
          "Codex accepted the Plan turn for a different thread.",
          "unknown",
          false
        );
        const settlement: PendingTurnDispatchSettlement = {
          state: "unknown",
          turn_id: accepted.turn_id,
          error: errorEnvelope(error)
        };
        await this.settleModelOrLatchUnknown(request.target.session_id, dispatchPending, modelPreparation, settlement);
        this.settlePlanDispatch(request.target.session_id, dispatchPending, settlement);
        throw error;
      }

      await this.settleModelOrLatchUnknown(
        request.target.session_id,
        dispatchPending,
        modelPreparation,
        { state: "accepted", turn_id: accepted.turn_id }
      );
      this.settlePlanDispatch(request.target.session_id, dispatchPending, {
        state: "accepted",
        turn_id: accepted.turn_id
      });
      if (pending.mode === "plan") {
        this.executionBySession.set(request.target.session_id, {
          turn_id: accepted.turn_id,
          state: "awaiting_evidence",
          evidence: "none",
          summary: null,
          updated_at: this.timestamp()
        });
      }
      return Object.freeze({
        ...accepted,
        plan_revision: pending.revision,
        model_revision: modelPreparation.pending_revision
      });
    });
  }

  async observeEvent(event: NormalizedCodexEvent): Promise<void> {
    if (!("thread_id" in event)) return;
    const state = this.options.states.getByThreadId(event.thread_id);
    if (state === null) return;
    if (event.method === "thread/settings/updated") {
      const dispatching = this.pendingBySession.get(state.mapping.id);
      if (dispatching?.phase === "dispatching" && dispatching.resolved_settings !== null) {
        this.dispatchConfirmationsBySession.set(
          state.mapping.id,
          event.collaboration_mode === dispatching.mode &&
            event.model === dispatching.resolved_settings.runtime_model &&
            event.effort === dispatching.resolved_settings.reasoning_effort
            ? "matched"
            : "conflict"
        );
      }
      await this.options.models.observeSettings(event);
    }
    await this.serialized(state.mapping.id, async () => {
      if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
        this.clearSession(state.mapping.id);
        return;
      }

      if (event.method === "thread/settings/updated") {
        this.currentBySession.set(state.mapping.id, {
          state: "confirmed",
          mode: event.collaboration_mode,
          runtime_model: event.model,
          reasoning_effort: event.effort,
          observed_at: event.captured_at
        });
        const pending = this.pendingBySession.get(state.mapping.id);
        if (pending === undefined || pending.phase === "pending" || pending.resolved_settings === null) return;
        if (
          event.collaboration_mode === pending.mode &&
          event.model === pending.resolved_settings.runtime_model &&
          event.effort === pending.resolved_settings.reasoning_effort
        ) {
          const changedFromBaseline = pending.baseline_mode !== pending.mode;
          if (pending.phase !== "unknown" || pending.turn_id !== null || changedFromBaseline) {
            this.pendingBySession.delete(state.mapping.id);
          }
          return;
        }
        this.setConflict(state.mapping.id, pending, "Codex settings did not confirm the dispatched Plan mode and settings.", true);
        return;
      }

      this.observePlanExecution(state.mapping.id, event);
    });
  }

  async reconcile(targetInput: unknown, expectedPendingRevision: unknown, signal?: AbortSignal): Promise<PlanControlSnapshot> {
    const target = parseTarget(targetInput);
    const revision = parseRevision(expectedPendingRevision);
    return this.serialized(target.session_id, async () => {
      this.requireTarget(target, false);
      const pending = this.requirePending(target.session_id, revision);
      const catalog = await this.listCatalog(signal);
      this.requireTarget(target, false);
      const current = this.currentBySession.get(target.session_id);
      if (current?.state === "confirmed" && current.mode === pending.mode && pending.resolved_settings !== null) {
        const settingsMatch =
          current.runtime_model === pending.resolved_settings.runtime_model &&
          current.reasoning_effort === pending.resolved_settings.reasoning_effort;
        if (settingsMatch && (pending.phase !== "unknown" || pending.turn_id !== null || pending.baseline_mode !== pending.mode)) {
          this.pendingBySession.delete(target.session_id);
        } else if (!settingsMatch && ["awaiting_confirmation", "conflict"].includes(pending.phase)) {
          this.setConflict(target.session_id, pending, "Codex settings read-back contradicted the dispatched Plan settings.", true);
        }
      } else if (current?.state === "confirmed" && ["awaiting_confirmation", "conflict"].includes(pending.phase)) {
        this.setConflict(target.session_id, pending, "Codex settings read-back did not confirm the dispatched Plan mode.", true);
      }
      this.reconcileCatalogDrift(target.session_id, catalog);
      return this.buildSnapshot(target.session_id, catalog);
    });
  }

  private observePlanExecution(sessionId: string, event: NormalizedCodexEvent): void {
    if (event.method === "turn/plan/updated") {
      const summary = summarizePlanUpdate(event.explanation, event.plan);
      this.executionBySession.set(sessionId, {
        turn_id: event.turn_id,
        state: "active",
        evidence: "plan_update",
        summary,
        updated_at: event.captured_at
      });
      return;
    }
    if (event.method === "item/plan/delta") {
      this.executionBySession.set(sessionId, {
        turn_id: event.turn_id,
        state: "active",
        evidence: "plan_delta",
        summary: boundedSummary(event.delta),
        updated_at: event.captured_at
      });
      return;
    }
    if ((event.method === "item/started" || event.method === "item/completed") && event.item.category === "plan") {
      this.executionBySession.set(sessionId, {
        turn_id: event.turn_id,
        state: "active",
        evidence: "plan_item",
        summary: boundedSummary(event.item.text ?? event.item.title),
        updated_at: event.captured_at
      });
      return;
    }
    if (event.method !== "turn/completed") return;
    const execution = this.executionBySession.get(sessionId);
    if (execution?.turn_id !== event.turn_id) return;
    if (event.status === "interrupted") {
      this.executionBySession.set(sessionId, { ...execution, state: "interrupted", updated_at: event.captured_at });
      return;
    }
    if (event.status === "failed") {
      this.executionBySession.set(sessionId, {
        ...execution,
        state: "failed",
        summary: boundedSummary(event.error_message ?? execution.summary ?? "Plan turn failed."),
        updated_at: event.captured_at
      });
      return;
    }
    this.executionBySession.set(sessionId, {
      ...execution,
      state: execution.evidence === "none" ? "unknown" : "complete",
      summary:
        execution.evidence === "none"
          ? "Plan turn completed without plan-specific event evidence."
          : execution.summary,
      updated_at: event.captured_at
    });
  }

  private reconcileFromCurrent(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId);
    const current = this.currentBySession.get(sessionId);
    if (
      pending === undefined ||
      current?.state !== "confirmed" ||
      pending.resolved_settings === null ||
      !["awaiting_confirmation", "unknown"].includes(pending.phase)
    ) {
      return;
    }
    const matches =
      current.mode === pending.mode &&
      current.runtime_model === pending.resolved_settings.runtime_model &&
      current.reasoning_effort === pending.resolved_settings.reasoning_effort;
    if (matches && (pending.phase !== "unknown" || pending.turn_id !== null || pending.baseline_mode !== pending.mode)) {
      this.pendingBySession.delete(sessionId);
    }
  }

  private reconcileCatalogDrift(sessionId: string, catalog: CodexPlanCatalog): void {
    const pending = this.pendingBySession.get(sessionId);
    if (pending === undefined || pending.phase === "dispatching") return;
    if (catalog.modes.some((entry) => entry.mode === pending.mode)) {
      if (pending.catalog_revision !== catalog.revision || pending.catalog_state !== "available") {
        this.pendingBySession.set(sessionId, {
          ...pending,
          catalog_revision: catalog.revision,
          catalog_state: "available"
        });
      }
      return;
    }
    this.setConflict(sessionId, pending, "The pending Plan mode is absent from the current Codex catalog.", false);
  }

  private async settleModelOrLatchUnknown(
    sessionId: string,
    pending: InternalPendingPlan,
    preparation: CodexPreparedModelTurnSettings,
    settlement: PendingTurnDispatchSettlement
  ): Promise<void> {
    try {
      await this.options.models.settlePreparedTurn(preparation, settlement);
    } catch (error) {
      this.dispatchConfirmationsBySession.delete(sessionId);
      const mapped = planError(
        "unknown_outcome",
        "unknown_error",
        "The combined Plan/model dispatch could not settle its model revision.",
        "unknown",
        false,
        error
      );
      this.pendingBySession.set(sessionId, {
        ...pending,
        phase: "unknown",
        turn_id: settlement.turn_id,
        error: errorEnvelope(mapped)
      });
      throw mapped;
    }
  }

  private settlePlanDispatch(
    sessionId: string,
    pending: InternalPendingPlan,
    settlement: PendingTurnDispatchSettlement
  ): void {
    const earlyConfirmation = this.dispatchConfirmationsBySession.get(sessionId) ?? null;
    this.dispatchConfirmationsBySession.delete(sessionId);
    if (earlyConfirmation === "matched") {
      const changedFromBaseline = pending.baseline_mode !== pending.mode;
      if (settlement.state !== "unknown" || settlement.turn_id !== null || changedFromBaseline) {
        this.pendingBySession.delete(sessionId);
        return;
      }
    }
    if (earlyConfirmation === "conflict") {
      this.setConflict(sessionId, pending, "Codex settings contradicted the prepared Plan mode and settings.", true);
      return;
    }
    if (settlement.state === "remote_rejected") {
      this.pendingBySession.set(sessionId, {
        ...pending,
        phase: "pending",
        turn_id: null,
        resolved_settings: null,
        error: null
      });
      return;
    }
    if (settlement.state === "unknown") {
      this.pendingBySession.set(sessionId, {
        ...pending,
        phase: "unknown",
        turn_id: settlement.turn_id,
        error: settlement.error
      });
      return;
    }
    this.pendingBySession.set(sessionId, {
      ...pending,
      phase: "awaiting_confirmation",
      turn_id: settlement.turn_id,
      error: null
    });
  }

  private async releaseModelPreparation(preparation: CodexPreparedModelTurnSettings): Promise<void> {
    try {
      await this.options.models.settlePreparedTurn(preparation, { state: "remote_rejected", turn_id: null });
    } catch (error) {
      throw planError(
        "unknown_outcome",
        "unknown_error",
        "The unsent Plan turn could not release its prepared model revision.",
        "unknown",
        false,
        error
      );
    }
  }

  private async listCatalog(signal?: AbortSignal): Promise<CodexPlanCatalog> {
    try {
      return await this.options.plans.listCatalog(signal);
    } catch (error) {
      throw mapAdapterError(error, "Codex collaboration catalog could not be read.");
    }
  }

  private requireTarget(target: ManagedSessionTarget, writable: boolean): SelectedSessionState {
    const candidate = this.options.states.get(target.session_id);
    if (candidate === null) {
      this.clearSession(target.session_id);
      throw planError("target_not_found", "session_not_found", "The selected managed session does not exist.", "not_sent", false);
    }
    const state = parseSelectedPlanState(candidate);
    if (state === null) {
      throw planError(
        "target_mismatch",
        "stale_session",
        "The selected managed session identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    if (state.mapping.id !== target.session_id || state.mapping.codex_thread_id !== target.codex_thread_id) {
      throw planError("target_mismatch", "invalid_session_id", "The selected session and Codex thread identity do not match.", "not_sent", false);
    }
    if (!selectedIdentityMatches(state)) {
      throw planError(
        "target_mismatch",
        "stale_session",
        "The selected managed session identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    if (state.mapping.disposition !== "selected") {
      throw planError(
        "target_not_writable",
        "stale_session",
        "The selected managed session requires recovery before Plan control.",
        "not_sent",
        false
      );
    }
    const session = state.projection.session;
    if (state.mapping.archived_at !== null || session.session_state === "archived") {
      this.clearSession(target.session_id);
      throw planError("target_not_writable", "session_not_writable", "The selected managed session is archived.", "not_sent", false);
    }
    if (
      writable &&
      (session.session_state !== "active" || session.freshness !== "current")
    ) {
      throw planError(
        "target_not_writable",
        session.freshness === "current" ? "session_not_writable" : "stale_session",
        "The selected managed session is not currently writable.",
        "not_sent",
        true
      );
    }
    return state;
  }

  private requirePending(sessionId: string, revision: number): InternalPendingPlan {
    const pending = this.pendingBySession.get(sessionId);
    if (pending === undefined || pending.revision !== revision) {
      throw planError(
        "operation_conflict",
        "operation_conflict",
        "The pending Plan selection changed before this operation.",
        "not_sent",
        true
      );
    }
    return pending;
  }

  private setConflict(sessionId: string, pending: InternalPendingPlan, message: string, catalogAvailable: boolean): void {
    const error = planError("operation_conflict", "operation_conflict", message, "not_sent", true);
    this.pendingBySession.set(sessionId, {
      ...pending,
      catalog_state: catalogAvailable ? "available" : "unknown",
      phase: "conflict",
      error: errorEnvelope(error)
    });
  }

  private buildSnapshot(sessionId: string, catalog: CodexPlanCatalog): PlanControlSnapshot {
    return planControlSnapshotSchema.parse({
      catalog_revision: catalog.revision,
      catalog_observed_at: catalog.observed_at,
      current:
        this.currentBySession.get(sessionId) ?? {
          state: "unknown",
          mode: null,
          runtime_model: null,
          reasoning_effort: null,
          observed_at: null
        },
      pending: publicPending(this.pendingBySession.get(sessionId)),
      execution: this.executionBySession.get(sessionId) ?? idleExecution,
      modes: catalog.modes
    });
  }

  private clearSession(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
    this.dispatchConfirmationsBySession.delete(sessionId);
    this.currentBySession.delete(sessionId);
    this.executionBySession.delete(sessionId);
  }

  private allocateRevision(): number {
    if (!Number.isSafeInteger(this.nextRevision) || this.nextRevision < 1) {
      throw planError(
        "service_overloaded",
        "service_overloaded",
        "The Plan-selection revision space is exhausted.",
        "not_sent",
        false
      );
    }
    const revision = this.nextRevision;
    this.nextRevision += 1;
    return revision;
  }

  private timestamp(): IsoTimestamp {
    const parsed = isoTimestampSchema.safeParse(this.now());
    if (!parsed.success) {
      throw planError("invalid_request", "internal_error", "The Plan-control clock returned an invalid timestamp.", "not_sent", false, parsed.error);
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

function parseSelectedPlanState(candidate: SelectedSessionState): SelectedSessionState | null {
  try {
    const mapping = selectedSessionMappingRecordSchema.safeParse(candidate.mapping);
    const projection = selectedSessionProjectionRecordSchema.safeParse(candidate.projection);
    if (!mapping.success || !projection.success) return null;
    return { mapping: mapping.data, projection: projection.data };
  } catch {
    return null;
  }
}

function selectedIdentityMatches(state: SelectedSessionState): boolean {
  const session = state.projection.session;
  return (
    state.mapping.id === session.id &&
    state.mapping.name === session.name &&
    state.mapping.codex_thread_id === session.codex_thread_id &&
    state.mapping.cwd === session.cwd &&
    state.mapping.runtime_source === session.runtime_source &&
    state.mapping.runtime_version === session.runtime_version &&
    state.mapping.created_at === session.created_at &&
    state.mapping.archived_at === session.archived_at
  );
}

function publicPending(pending: InternalPendingPlan | undefined): PendingPlanSelection | null {
  if (pending === undefined) return null;
  return {
    revision: pending.revision,
    selection_operation_id: pending.selection_operation_id,
    mode: pending.mode,
    catalog_state: pending.catalog_state,
    phase: pending.phase,
    selected_at: pending.selected_at,
    turn_id: pending.turn_id,
    resolved_settings: pending.resolved_settings,
    error: pending.error
  };
}

function parseTarget(candidate: unknown): ManagedSessionTarget {
  const parsed = managedSessionTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw planError("invalid_request", "validation_error", "The Plan-control target is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parsePlanIntent(candidate: unknown): PlanOperationIntent {
  const parsed = planOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw planError("invalid_request", "validation_error", "The Plan selection request is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parsePendingTurn(candidate: unknown): PendingPlanTurnRequest {
  const parsed = pendingTurnSchema.safeParse(candidate);
  if (!parsed.success) {
    throw planError("invalid_request", "validation_error", "The pending Plan turn request is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseRevision(candidate: unknown): number {
  const parsed = positiveSafeIntegerSchema.safeParse(candidate);
  if (!parsed.success) {
    throw planError("invalid_request", "validation_error", "The pending Plan revision is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseCapacity(candidate: number | undefined): number {
  const definition = resourceBudgetDefinitionByKey.control_plan_max_pending_selections;
  const value = candidate ?? defaultResourceBudget.control_plan_max_pending_selections;
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
    throw new TypeError(`Plan pending-selection capacity must be between ${definition.minimum} and ${definition.maximum}.`);
  }
  return value;
}

function assertExpectedRevision(expected: number | null, pending: InternalPendingPlan | null): void {
  if ((pending === null && expected !== null) || (pending !== null && expected !== pending.revision)) {
    throw planError(
      "operation_conflict",
      "operation_conflict",
      "The pending Plan selection changed before this selection was applied.",
      "not_sent",
      true
    );
  }
}

function modeForAction(action: PlanOperationIntent["action"]): PlanMode {
  return action === "enter" ? "plan" : "default";
}

function assertIdleTurn(state: SelectedSessionState): void {
  if (!activeTurnStates.has(state.projection.session.turn_state)) return;
  throw planError(
    "operation_conflict",
    "operation_conflict",
    "The selected thread does not have a proven idle turn state.",
    "not_sent",
    true
  );
}

function summarizePlanUpdate(
  explanation: string | null,
  steps: readonly { readonly step: string; readonly status: string }[]
): string | null {
  if (explanation !== null && explanation.length > 0) return boundedSummary(explanation);
  if (steps.length === 0) return null;
  return boundedSummary(steps.map((step) => `${step.status}: ${step.step}`).join("\n"));
}

function boundedSummary(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
}

function mapModelError(error: unknown): HostDeckCodexPlanControlError {
  if (!(error instanceof HostDeckCodexModelControlError)) {
    return planError("runtime_unavailable", "runtime_unavailable", "Model settings could not be prepared for the Plan turn.", "unknown", false, error);
  }
  if (error.code === "capability_unsupported") {
    return planError("capability_unsupported", error.api_code, error.message, "not_sent", error.retry_safe, error);
  }
  if (error.code === "service_overloaded") {
    return planError("service_overloaded", error.api_code, error.message, "not_sent", error.retry_safe, error);
  }
  if (["operation_conflict", "model_unknown", "effort_unsupported"].includes(error.code)) {
    return planError("operation_conflict", error.api_code, error.message, "not_sent", error.retry_safe, error);
  }
  return planError("runtime_unavailable", error.api_code, error.message, error.outcome === "unknown" ? "unknown" : "not_sent", error.retry_safe, error);
}

function mapAdapterError(error: unknown, fallback: string, mutation = false): HostDeckCodexPlanControlError {
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return planError("runtime_unavailable", "runtime_unavailable", fallback, "unknown", false, error);
  }
  if (error.code === "unsupported_method") {
    return planError("capability_unsupported", "capability_unavailable", error.message, "not_sent", false, error);
  }
  if (error.outcome === "unknown") {
    return planError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (error.outcome === "remote_rejected") {
    return planError("operation_conflict", "operation_conflict", error.message, "remote_rejected", error.retry_safe, error);
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    if (mutation && error.outcome !== "not_sent") {
      return planError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
    }
    return planError("runtime_protocol_error", "protocol_error", error.message, "not_sent", false, error);
  }
  if (error.code === "broker_overloaded") {
    return planError("service_overloaded", "service_overloaded", error.message, "not_sent", error.retry_safe, error);
  }
  return planError("runtime_unavailable", "runtime_unavailable", error.message || fallback, "not_sent", error.retry_safe, error);
}

function settlementForError(error: HostDeckCodexPlanControlError): PendingTurnDispatchSettlement {
  return error.outcome === "unknown"
    ? { state: "unknown", turn_id: null, error: errorEnvelope(error) }
    : { state: "remote_rejected", turn_id: null };
}

function errorEnvelope(error: HostDeckCodexPlanControlError): NonNullable<PendingPlanSelection["error"]> {
  return { code: error.api_code, message: error.message, retryable: error.retry_safe };
}

function planError(
  code: CodexPlanControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  outcome: CodexPlanControlOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexPlanControlError {
  return new HostDeckCodexPlanControlError(code, apiCode, message, outcome, retrySafe, { cause });
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex Plan control failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
