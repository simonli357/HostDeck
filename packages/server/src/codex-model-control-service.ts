import {
  type CodexModelCatalog,
  type CodexModelClient,
  type CodexModelTurnAccepted,
  type CodexThreadModelState,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  apiErrorEnvelopeSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type ManagedSessionTarget,
  type ModelCatalogEntry,
  type ModelControlSnapshot,
  managedSessionTargetSchema,
  modelControlSnapshotSchema,
  modelOperationIntentSchema,
  type PendingModelSelection,
  positiveSafeIntegerSchema,
  promptOperationIntentSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp, OperationDeadline } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";
import {
  requireOpenOperationDeadline,
  runSerializedWithDeadline
} from "./operation-deadline-serialization.js";
import type {
  PendingTurnDispatchSettlement,
  PendingTurnSetting,
  PendingTurnSettingsReader
} from "./pending-turn-settings.js";

type ModelOperationIntent = Extract<SelectedOperationIntent, { readonly kind: "model" }>;

export type CodexModelControlErrorCode =
  | "capability_unsupported"
  | "effort_unsupported"
  | "invalid_request"
  | "model_unknown"
  | "operation_timeout"
  | "operation_conflict"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_writable"
  | "unknown_outcome";

export type CodexModelControlOutcome = "not_sent" | "remote_rejected" | "unknown";

export class HostDeckCodexModelControlError extends Error {
  constructor(
    readonly code: CodexModelControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly outcome: CodexModelControlOutcome,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexModelControlError";
  }
}

export interface CodexPendingModelTurnAccepted extends CodexModelTurnAccepted {
  readonly pending_revision: number;
}

export interface CodexPreparedModelTurnSettings {
  readonly session_id: ManagedSessionTarget["session_id"];
  readonly codex_thread_id: ManagedSessionTarget["codex_thread_id"];
  readonly pending_revision: number | null;
  readonly runtime_model: string;
  readonly reasoning_effort: string | null;
}

export interface CodexModelTurnSettingsParticipant {
  readonly prepareTurnSettings: (
    target: unknown,
    expectedPendingRevision: unknown,
    deadline: OperationDeadline
  ) => Promise<CodexPreparedModelTurnSettings>;
  readonly settlePreparedTurn: (
    preparation: CodexPreparedModelTurnSettings,
    settlement: PendingTurnDispatchSettlement
  ) => Promise<void>;
  readonly observeSettings: (event: NormalizedCodexEvent) => Promise<void>;
}

export interface CodexModelControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexModelControlServiceOptions {
  readonly models: CodexModelClient;
  readonly states: CodexModelControlStatePort;
  readonly max_pending_selections?: number;
  readonly now?: () => string;
}

export interface CodexModelControlService extends PendingTurnSettingsReader, CodexModelTurnSettingsParticipant {
  readonly snapshot: (target: unknown, deadline: OperationDeadline) => Promise<ModelControlSnapshot>;
  readonly select: (intent: unknown, deadline: OperationDeadline) => Promise<ModelControlSnapshot>;
  readonly dispatchPendingTurn: (input: unknown, deadline: OperationDeadline) => Promise<CodexPendingModelTurnAccepted>;
  readonly observeSettings: (event: NormalizedCodexEvent) => Promise<void>;
  readonly reconcile: (
    target: unknown,
    expectedPendingRevision: unknown,
    deadline?: OperationDeadline
  ) => Promise<ModelControlSnapshot>;
  readonly pending_count: number;
}

interface InternalPendingSelection extends PendingModelSelection {
  readonly catalog_revision: string;
  readonly baseline_runtime_model: string;
  readonly baseline_reasoning_effort: string | null;
  readonly dispatch_confirmation: "matched" | "conflict" | null;
}

interface ObservedModelState {
  readonly catalog: CodexModelCatalog;
  readonly current: ModelControlSnapshot["current"];
}

const pendingTurnSchema = promptOperationIntentSchema.extend({
  expected_pending_revision: positiveSafeIntegerSchema
});

const activeTurnStates = new Set(["in_progress", "waiting_for_approval", "waiting_for_input", "unknown"]);

export function createCodexModelControlService(options: CodexModelControlServiceOptions): CodexModelControlService {
  const implementation = new DefaultCodexModelControlService(options);
  return Object.freeze({
    snapshot: (target: unknown, deadline: OperationDeadline) => implementation.snapshot(target, deadline),
    select: (intent: unknown, deadline: OperationDeadline) => implementation.select(intent, deadline),
    prepareTurnSettings: (target: unknown, expectedPendingRevision: unknown, deadline: OperationDeadline) =>
      implementation.prepareTurnSettings(target, expectedPendingRevision, deadline),
    settlePreparedTurn: (preparation: CodexPreparedModelTurnSettings, settlement: PendingTurnDispatchSettlement) =>
      implementation.settlePreparedTurn(preparation, settlement),
    dispatchPendingTurn: (input: unknown, deadline: OperationDeadline) => implementation.dispatchPendingTurn(input, deadline),
    observeSettings: (event: NormalizedCodexEvent) => implementation.observeSettings(event),
    reconcile: (target: unknown, expectedPendingRevision: unknown, deadline?: OperationDeadline) =>
      implementation.reconcile(target, expectedPendingRevision, deadline),
    readPendingSettings: (target: ManagedSessionTarget) => implementation.readPendingSettings(target),
    get pending_count() {
      return implementation.pending_count;
    }
  });
}

class DefaultCodexModelControlService implements CodexModelControlService {
  private readonly pendingBySession = new Map<string, InternalPendingSelection>();
  private readonly activePreparationsBySession = new Map<string, CodexPreparedModelTurnSettings>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly maxPendingSelections: number;
  private readonly now: () => string;
  private nextRevision = 1;
  private pendingReservations = 0;

  constructor(private readonly options: CodexModelControlServiceOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.models?.listCatalog !== "function" ||
      typeof options.models?.readCurrent !== "function" ||
      typeof options.models?.startTurn !== "function" ||
      typeof options.states?.get !== "function" ||
      typeof options.states?.getByThreadId !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Codex model control requires exact model and selected-state ports.");
    }
    this.maxPendingSelections = parseCapacity(options.max_pending_selections);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get pending_count(): number {
    return this.pendingBySession.size;
  }

  readPendingSettings(target: ManagedSessionTarget): readonly PendingTurnSetting[] {
    const state = this.options.states.get(target.session_id);
    if (
      state === null ||
      state.mapping.codex_thread_id !== target.codex_thread_id ||
      state.mapping.archived_at !== null ||
      state.projection.session.session_state === "archived"
    ) {
      return [];
    }
    const pending = this.pendingBySession.get(target.session_id);
    if (pending === undefined) return [];
    return Object.freeze([
      Object.freeze({ control: "model" as const, revision: pending.revision, phase: pending.phase })
    ]);
  }

  async snapshot(target: unknown, deadline: OperationDeadline): Promise<ModelControlSnapshot> {
    const parsedTarget = parseTarget(target);
    return this.serialized(parsedTarget.session_id, async () => {
      const state = this.requireTarget(parsedTarget, false);
      const observed = await this.observeRuntime(state, deadline);
      this.requireTarget(parsedTarget, false);
      this.reconcileFromReadBack(parsedTarget.session_id, observed.current);
      this.reconcileCatalogDrift(parsedTarget.session_id, observed.catalog);
      return this.buildSnapshot(parsedTarget.session_id, observed);
    }, deadline);
  }

  async select(input: unknown, deadline: OperationDeadline): Promise<ModelControlSnapshot> {
    const intent = parseModelIntent(input);
    return this.serialized(intent.target.session_id, async () => {
      const state = this.requireTarget(intent.target, true);
      const existing = this.pendingBySession.get(intent.target.session_id) ?? null;
      assertExpectedRevision(intent.expected_pending_revision, existing);
      if (existing !== null && !["pending", "conflict"].includes(existing.phase)) {
        throw controlError(
          "operation_conflict",
          "operation_conflict",
          "The current model selection is already dispatching or awaiting reconciliation.",
          "not_sent",
          false
        );
      }
      const reserved = existing === null;
      if (reserved && this.pendingBySession.size + this.pendingReservations >= this.maxPendingSelections) {
        throw controlError(
          "service_overloaded",
          "service_overloaded",
          "The pending model-selection capacity is exhausted.",
          "not_sent",
          true
        );
      }
      if (reserved) this.pendingReservations += 1;

      try {
        const observed = await this.observeRuntime(state, deadline);
        requireModelDeadline(deadline);
        this.requireTarget(intent.target, true);
        const selectedModel = observed.catalog.models.find((model) => model.id === intent.model_id);
        if (selectedModel === undefined) {
          throw controlError("model_unknown", "validation_error", "The requested model is absent from the live Codex catalog.", "not_sent", true);
        }
        const selectedEffort = resolveEffort(selectedModel, intent.reasoning_effort);

        if (observed.current.runtime_model === selectedModel.runtime_model && observed.current.reasoning_effort === selectedEffort) {
          if (existing !== null) this.pendingBySession.delete(intent.target.session_id);
          return this.buildSnapshot(intent.target.session_id, observed);
        }

        const pending: InternalPendingSelection = {
          revision: this.allocateRevision(),
          selection_operation_id: intent.operation_id,
          model_id: selectedModel.id,
          runtime_model: selectedModel.runtime_model,
          reasoning_effort: selectedEffort,
          catalog_state: "available",
          phase: "pending",
          selected_at: this.timestamp(),
          turn_id: null,
          error: null,
          catalog_revision: observed.catalog.revision,
          baseline_runtime_model: observed.current.runtime_model,
          baseline_reasoning_effort: observed.current.reasoning_effort,
          dispatch_confirmation: null
        };
        this.pendingBySession.set(intent.target.session_id, pending);
        return this.buildSnapshot(intent.target.session_id, observed);
      } finally {
        if (reserved) this.pendingReservations -= 1;
      }
    }, deadline);
  }

  async prepareTurnSettings(
    targetInput: unknown,
    expectedPendingRevision: unknown,
    deadline: OperationDeadline
  ): Promise<CodexPreparedModelTurnSettings> {
    const target = parseTarget(targetInput);
    const expectedRevision = expectedPendingRevision === null ? null : parseRevision(expectedPendingRevision);
    return this.serialized(target.session_id, async () => {
      const state = this.requireTarget(target, true);
      assertIdleTurn(state);
      const pending = this.pendingBySession.get(target.session_id) ?? null;
      assertExpectedRevision(expectedRevision, pending);
      if (pending !== null && pending.phase !== "pending") {
        throw controlError(
          "operation_conflict",
          "operation_conflict",
          "The selected model is already dispatching or awaiting reconciliation.",
          "not_sent",
          false
        );
      }

      const observed = await this.observeRuntime(state, deadline);
      requireModelDeadline(deadline);
      const currentTarget = this.requireTarget(target, true);
      assertIdleTurn(currentTarget);
      if (pending === null) {
        return Object.freeze({
          session_id: target.session_id,
          codex_thread_id: target.codex_thread_id,
          pending_revision: null,
          runtime_model: observed.current.runtime_model,
          reasoning_effort: observed.current.reasoning_effort
        });
      }

      const currentEntry = observed.catalog.models.find((model) => model.id === pending.model_id);
      if (currentEntry === undefined || currentEntry.runtime_model !== pending.runtime_model) {
        this.setConflict(target.session_id, pending, "The pending model is no longer present in the live Codex catalog.", false);
        throw controlError("model_unknown", "validation_error", "The pending model is no longer present in the live Codex catalog.", "not_sent", true);
      }
      if (!currentEntry.reasoning_efforts.some((effort) => effort.id === pending.reasoning_effort)) {
        this.setConflict(target.session_id, pending, "The pending reasoning effort is no longer supported.", false);
        throw controlError(
          "effort_unsupported",
          "capability_unavailable",
          "The pending reasoning effort is no longer supported by the selected model.",
          "not_sent",
          true
        );
      }

      const dispatchPending: InternalPendingSelection = {
        ...pending,
        catalog_revision: observed.catalog.revision,
        baseline_runtime_model: observed.current.runtime_model,
        baseline_reasoning_effort: observed.current.reasoning_effort,
        catalog_state: "available",
        phase: "dispatching",
        turn_id: null,
        error: null,
        dispatch_confirmation: null
      };
      const preparation = Object.freeze({
        session_id: target.session_id,
        codex_thread_id: target.codex_thread_id,
        pending_revision: pending.revision,
        runtime_model: pending.runtime_model,
        reasoning_effort: pending.reasoning_effort
      });
      this.pendingBySession.set(target.session_id, dispatchPending);
      this.activePreparationsBySession.set(target.session_id, preparation);
      return preparation;
    }, deadline);
  }

  async settlePreparedTurn(
    preparation: CodexPreparedModelTurnSettings,
    settlementInput: PendingTurnDispatchSettlement
  ): Promise<void> {
    const settlement = parseSettlement(settlementInput);
    if (preparation.pending_revision === null) return;
    await this.serialized(preparation.session_id, async () => {
      const activePreparation = this.activePreparationsBySession.get(preparation.session_id);
      const pending = this.pendingBySession.get(preparation.session_id);
      if (
        activePreparation !== preparation ||
        pending === undefined ||
        pending.revision !== preparation.pending_revision ||
        pending.phase !== "dispatching"
      ) {
        throw controlError(
          "operation_conflict",
          "operation_conflict",
          "The prepared model settings are stale or already settled.",
          "not_sent",
          false
        );
      }
      this.activePreparationsBySession.delete(preparation.session_id);

      if (pending.dispatch_confirmation === "matched") {
        const baselineAlreadyMatched =
          pending.baseline_runtime_model === pending.runtime_model &&
          pending.baseline_reasoning_effort === pending.reasoning_effort;
        if (settlement.state !== "unknown" || !baselineAlreadyMatched) {
          this.pendingBySession.delete(preparation.session_id);
          return;
        }
      }
      if (pending.dispatch_confirmation === "conflict") {
        this.setConflict(preparation.session_id, pending, "Codex settings contradicted the prepared model and effort.", true);
        return;
      }
      if (settlement.state === "remote_rejected") {
        this.pendingBySession.set(preparation.session_id, {
          ...pending,
          phase: "pending",
          turn_id: null,
          error: null,
          dispatch_confirmation: null
        });
        return;
      }
      if (settlement.state === "unknown") {
        this.pendingBySession.set(preparation.session_id, {
          ...pending,
          phase: "unknown",
          turn_id: settlement.turn_id,
          error: settlement.error,
          dispatch_confirmation: null
        });
        return;
      }
      this.pendingBySession.set(preparation.session_id, {
        ...pending,
        phase: "awaiting_confirmation",
        turn_id: settlement.turn_id,
        error: null,
        dispatch_confirmation: null
      });
    });
  }

  async dispatchPendingTurn(input: unknown, deadline: OperationDeadline): Promise<CodexPendingModelTurnAccepted> {
    const request = parsePendingTurn(input);
    const preparation = await this.prepareTurnSettings(
      request.target,
      request.expected_pending_revision,
      deadline
    );
    if (preparation.pending_revision === null || preparation.reasoning_effort === null) {
      throw controlError(
        "operation_conflict",
        "operation_conflict",
        "The pending model selection disappeared before dispatch.",
        "not_sent",
        false
      );
    }

    try {
      const currentTarget = this.requireTarget(request.target, true);
      assertIdleTurn(currentTarget);
    } catch (error) {
      await this.settlePreparedTurn(preparation, { state: "remote_rejected", turn_id: null });
      throw error;
    }

    let accepted: CodexModelTurnAccepted;
    try {
      requireModelDeadline(deadline);
      accepted = await this.options.models.startTurn({
        operation_id: request.operation_id,
        thread_id: request.target.codex_thread_id,
        text: request.text,
        runtime_model: preparation.runtime_model,
        reasoning_effort: preparation.reasoning_effort,
        deadline
      });
    } catch (error) {
      const mapped = mapAdapterError(error, "Codex model turn dispatch failed.", true);
      await this.settlePreparedTurn(
        preparation,
        mapped.outcome === "unknown"
          ? { state: "unknown", turn_id: null, error: errorEnvelope(mapped) }
          : { state: "remote_rejected", turn_id: null }
      );
      throw mapped;
    }

    if (accepted.thread_id !== request.target.codex_thread_id) {
      const error = controlError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex accepted the model turn for a different thread.",
        "unknown",
        false
      );
      await this.settlePreparedTurn(preparation, {
        state: "unknown",
        turn_id: accepted.turn_id,
        error: errorEnvelope(error)
      });
      throw error;
    }

    await this.settlePreparedTurn(preparation, { state: "accepted", turn_id: accepted.turn_id });
    return Object.freeze({ ...accepted, pending_revision: preparation.pending_revision });
  }

  async observeSettings(event: NormalizedCodexEvent): Promise<void> {
    if (event.method !== "thread/settings/updated") return;
    const state = this.options.states.getByThreadId(event.thread_id);
    if (state === null) return;
    await this.serialized(state.mapping.id, async () => {
      const pending = this.pendingBySession.get(state.mapping.id);
      if (pending === undefined) return;
      if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
        this.pendingBySession.delete(state.mapping.id);
        this.activePreparationsBySession.delete(state.mapping.id);
        return;
      }
      if (pending.phase === "pending") return;
      if (pending.phase === "dispatching") {
        this.pendingBySession.set(state.mapping.id, {
          ...pending,
          dispatch_confirmation:
            event.model === pending.runtime_model && event.effort === pending.reasoning_effort ? "matched" : "conflict"
        });
        return;
      }
      if (event.model === pending.runtime_model && event.effort === pending.reasoning_effort) {
        this.pendingBySession.delete(state.mapping.id);
        this.activePreparationsBySession.delete(state.mapping.id);
        return;
      }
      this.setConflict(state.mapping.id, pending, "Codex settings did not confirm the dispatched model and effort.", true);
    });
  }

  async reconcile(
    target: unknown,
    expectedPendingRevision: unknown,
    deadline?: OperationDeadline
  ): Promise<ModelControlSnapshot> {
    const parsedTarget = parseTarget(target);
    const parsedRevision = parseRevision(expectedPendingRevision);
    return this.serialized(parsedTarget.session_id, async () => {
      const state = this.requireTarget(parsedTarget, false);
      const pending = this.requirePending(parsedTarget.session_id, parsedRevision);
      const observed = await this.observeRuntime(state, deadline);
      this.requireTarget(parsedTarget, false);
      if (matchesCurrent(pending, observed.current)) {
        if (
          pending.phase !== "unknown" ||
          pending.baseline_runtime_model !== pending.runtime_model ||
          pending.baseline_reasoning_effort !== pending.reasoning_effort
        ) {
          this.pendingBySession.delete(parsedTarget.session_id);
        }
      } else if (["awaiting_confirmation", "conflict"].includes(pending.phase)) {
        this.setConflict(parsedTarget.session_id, pending, "Codex read-back did not confirm the dispatched model and effort.", true);
      }
      this.reconcileCatalogDrift(parsedTarget.session_id, observed.catalog);
      return this.buildSnapshot(parsedTarget.session_id, observed);
    }, deadline);
  }

  private async observeRuntime(
    state: SelectedSessionState,
    deadline?: OperationDeadline
  ): Promise<ObservedModelState> {
    const catalog = await this.listCatalog(deadline);
    let current: CodexThreadModelState;
    try {
      current = await this.options.models.readCurrent(state.mapping.codex_thread_id, deadline);
    } catch (error) {
      throw mapAdapterError(error, "Codex current model could not be read.");
    }
    if (current.thread_id !== state.mapping.codex_thread_id) {
      throw controlError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex current-model read-back changed the selected thread identity.",
        "not_sent",
        false
      );
    }
    const model = catalog.models.find((candidate) => candidate.runtime_model === current.runtime_model);
    const effortKnown =
      current.reasoning_effort === null || model?.reasoning_efforts.some((effort) => effort.id === current.reasoning_effort) === true;
    return {
      catalog,
      current: {
        model_id: model !== undefined && effortKnown ? model.id : null,
        runtime_model: current.runtime_model,
        reasoning_effort: current.reasoning_effort,
        catalog_state: model !== undefined && effortKnown ? "available" : "unknown",
        observed_at: this.timestamp()
      }
    };
  }

  private async listCatalog(deadline?: OperationDeadline): Promise<CodexModelCatalog> {
    try {
      return await this.options.models.listCatalog(deadline);
    } catch (error) {
      throw mapAdapterError(error, "Codex model catalog could not be read.");
    }
  }

  private requireTarget(target: ManagedSessionTarget, writable: boolean): SelectedSessionState {
    const candidate = this.options.states.get(target.session_id);
    if (candidate === null) {
      this.pendingBySession.delete(target.session_id);
      this.activePreparationsBySession.delete(target.session_id);
      throw controlError("target_not_found", "session_not_found", "The selected managed session does not exist.", "not_sent", false);
    }
    const state = parseSelectedModelState(candidate);
    if (state === null) {
      throw controlError(
        "target_mismatch",
        "stale_session",
        "The selected managed session identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    if (state.mapping.id !== target.session_id || state.mapping.codex_thread_id !== target.codex_thread_id) {
      throw controlError("target_mismatch", "invalid_session_id", "The selected session and Codex thread identity do not match.", "not_sent", false);
    }
    const session = state.projection.session;
    if (
      state.mapping.id !== session.id ||
      state.mapping.name !== session.name ||
      state.mapping.codex_thread_id !== session.codex_thread_id ||
      state.mapping.cwd !== session.cwd ||
      state.mapping.runtime_source !== session.runtime_source ||
      state.mapping.runtime_version !== session.runtime_version ||
      state.mapping.created_at !== session.created_at ||
      state.mapping.archived_at !== session.archived_at
    ) {
      throw controlError(
        "target_mismatch",
        "stale_session",
        "The selected managed session identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    if (state.mapping.disposition !== "selected") {
      throw controlError(
        "target_not_writable",
        "stale_session",
        "The selected managed session requires recovery before model control.",
        "not_sent",
        false
      );
    }
    if (state.mapping.archived_at !== null || session.session_state === "archived") {
      this.pendingBySession.delete(target.session_id);
      this.activePreparationsBySession.delete(target.session_id);
      throw controlError("target_not_writable", "session_not_writable", "The selected managed session is archived.", "not_sent", false);
    }
    if (
      writable &&
      (session.session_state !== "active" || session.freshness !== "current")
    ) {
      throw controlError(
        "target_not_writable",
        session.freshness === "current" ? "session_not_writable" : "stale_session",
        "The selected managed session is not currently writable.",
        "not_sent",
        true
      );
    }
    return state;
  }

  private requirePending(sessionId: string, expectedRevision: number): InternalPendingSelection {
    const pending = this.pendingBySession.get(sessionId);
    if (pending === undefined || pending.revision !== expectedRevision) {
      throw controlError(
        "operation_conflict",
        "operation_conflict",
        "The pending model selection changed before this operation.",
        "not_sent",
        true
      );
    }
    return pending;
  }

  private reconcileFromReadBack(sessionId: string, current: ModelControlSnapshot["current"]): void {
    const pending = this.pendingBySession.get(sessionId);
    if (pending === undefined || !["awaiting_confirmation", "unknown"].includes(pending.phase) || !matchesCurrent(pending, current)) {
      return;
    }
    if (
      pending.phase === "unknown" &&
      pending.baseline_runtime_model === pending.runtime_model &&
      pending.baseline_reasoning_effort === pending.reasoning_effort
    ) {
      return;
    }
    this.pendingBySession.delete(sessionId);
  }

  private reconcileCatalogDrift(sessionId: string, catalog: CodexModelCatalog): void {
    const pending = this.pendingBySession.get(sessionId);
    if (pending === undefined) return;
    if (pending.phase === "dispatching") return;
    const model = catalog.models.find((candidate) => candidate.id === pending.model_id);
    const stillAvailable =
      model?.runtime_model === pending.runtime_model &&
      model.reasoning_efforts.some((effort) => effort.id === pending.reasoning_effort);
    if (stillAvailable) {
      if (pending.catalog_revision !== catalog.revision || pending.catalog_state !== "available") {
        this.pendingBySession.set(sessionId, { ...pending, catalog_revision: catalog.revision, catalog_state: "available" });
      }
      return;
    }
    this.setConflict(sessionId, pending, "The pending model or effort is absent from the current Codex catalog.", false);
  }

  private setConflict(sessionId: string, pending: InternalPendingSelection, message: string, catalogAvailable: boolean): void {
    const error = controlError("operation_conflict", "operation_conflict", message, "not_sent", true);
    this.pendingBySession.set(sessionId, {
      ...pending,
      catalog_state: catalogAvailable ? "available" : "unknown",
      phase: "conflict",
      error: errorEnvelope(error)
    });
  }

  private buildSnapshot(sessionId: string, observed: ObservedModelState): ModelControlSnapshot {
    const pending = this.pendingBySession.get(sessionId) ?? null;
    return modelControlSnapshotSchema.parse({
      catalog_revision: observed.catalog.revision,
      catalog_observed_at: observed.catalog.observed_at,
      current: observed.current,
      pending: pending === null ? null : publicPending(pending),
      models: observed.catalog.models
    });
  }

  private allocateRevision(): number {
    if (!Number.isSafeInteger(this.nextRevision) || this.nextRevision < 1) {
      throw controlError(
        "service_overloaded",
        "service_overloaded",
        "The model-selection revision space is exhausted.",
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
      throw controlError("invalid_request", "internal_error", "The model-control clock returned an invalid timestamp.", "not_sent", false, parsed.error);
    }
    return parsed.data;
  }

  private serialized<T>(
    sessionId: string,
    operation: () => Promise<T>,
    deadline?: OperationDeadline
  ): Promise<T> {
    if (deadline !== undefined) {
      return runSerializedWithDeadline(
        this.tails,
        sessionId,
        deadline,
        modelDeadlineError,
        operation,
        modelInvalidDeadlineError
      );
    }
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

function parseSelectedModelState(candidate: SelectedSessionState): SelectedSessionState | null {
  try {
    const mapping = selectedSessionMappingRecordSchema.safeParse(candidate.mapping);
    const projection = selectedSessionProjectionRecordSchema.safeParse(candidate.projection);
    if (!mapping.success || !projection.success) return null;
    return { mapping: mapping.data, projection: projection.data };
  } catch {
    return null;
  }
}

function publicPending(pending: InternalPendingSelection): PendingModelSelection {
  return {
    revision: pending.revision,
    selection_operation_id: pending.selection_operation_id,
    model_id: pending.model_id,
    runtime_model: pending.runtime_model,
    reasoning_effort: pending.reasoning_effort,
    catalog_state: pending.catalog_state,
    phase: pending.phase,
    selected_at: pending.selected_at,
    turn_id: pending.turn_id,
    error: pending.error
  };
}

function parseTarget(candidate: unknown): ManagedSessionTarget {
  const parsed = managedSessionTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw controlError("invalid_request", "validation_error", "The model-control target is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseModelIntent(candidate: unknown): ModelOperationIntent {
  const parsed = modelOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw controlError("invalid_request", "validation_error", "The model selection request is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parsePendingTurn(candidate: unknown) {
  const parsed = pendingTurnSchema.safeParse(candidate);
  if (!parsed.success) {
    throw controlError("invalid_request", "validation_error", "The pending-model turn request is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseRevision(candidate: unknown): number {
  const parsed = positiveSafeIntegerSchema.safeParse(candidate);
  if (!parsed.success) {
    throw controlError("invalid_request", "validation_error", "The pending model revision is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseSettlement(candidate: unknown): PendingTurnDispatchSettlement {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw controlError("invalid_request", "validation_error", "The model dispatch settlement is invalid.", "not_sent", false);
  }
  const value = candidate as Record<string, unknown>;
  if (value.state === "remote_rejected" && value.turn_id === null && Object.keys(value).length === 2) {
    return { state: "remote_rejected", turn_id: null };
  }
  const turnId = codexTurnIdSchema.safeParse(value.turn_id);
  if (value.state === "accepted" && turnId.success && Object.keys(value).length === 2) {
    return { state: "accepted", turn_id: turnId.data };
  }
  const error = apiErrorEnvelopeSchema.safeParse(value.error);
  if (
    value.state === "unknown" &&
    (value.turn_id === null || turnId.success) &&
    error.success &&
    Object.keys(value).length === 3
  ) {
    return {
      state: "unknown",
      turn_id: value.turn_id === null ? null : turnId.data ?? null,
      error: error.data
    };
  }
  throw controlError("invalid_request", "validation_error", "The model dispatch settlement is invalid.", "not_sent", false);
}

function parseCapacity(candidate: number | undefined): number {
  const definition = resourceBudgetDefinitionByKey.control_model_max_pending_selections;
  const value = candidate ?? defaultResourceBudget.control_model_max_pending_selections;
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
    throw new TypeError(`Model pending-selection capacity must be between ${definition.minimum} and ${definition.maximum}.`);
  }
  return value;
}

function assertExpectedRevision(expected: number | null, pending: InternalPendingSelection | null): void {
  if ((pending === null && expected !== null) || (pending !== null && expected !== pending.revision)) {
    throw controlError(
      "operation_conflict",
      "operation_conflict",
      "The pending model selection changed before this selection was applied.",
      "not_sent",
      true
    );
  }
}

function resolveEffort(model: ModelCatalogEntry, requested: string | null): string {
  if (requested === null) {
    const defaultEffort = model.reasoning_efforts.find((effort) => effort.is_default);
    if (defaultEffort !== undefined) return defaultEffort.id;
    throw controlError(
      "runtime_protocol_error",
      "protocol_error",
      "The selected model has no unambiguous default reasoning effort.",
      "not_sent",
      false
    );
  }
  if (model.reasoning_efforts.some((effort) => effort.id === requested)) return requested;
  throw controlError(
    "effort_unsupported",
    "capability_unavailable",
    "The requested reasoning effort is not supported by the selected model.",
    "not_sent",
    true
  );
}

function matchesCurrent(pending: InternalPendingSelection, current: ModelControlSnapshot["current"]): boolean {
  return current.runtime_model === pending.runtime_model && current.reasoning_effort === pending.reasoning_effort;
}

function assertIdleTurn(state: SelectedSessionState): void {
  if (!activeTurnStates.has(state.projection.session.turn_state)) return;
  throw controlError(
    "operation_conflict",
    "operation_conflict",
    "The selected thread does not have a proven idle turn state.",
    "not_sent",
    true
  );
}

function mapAdapterError(error: unknown, fallback: string, mutation = false): HostDeckCodexModelControlError {
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return controlError("runtime_unavailable", "runtime_unavailable", fallback, "unknown", false, error);
  }
  if (error.code === "unsupported_method") {
    return controlError("capability_unsupported", "capability_unavailable", error.message, "not_sent", false, error);
  }
  if (["request_aborted", "request_timeout"].includes(error.code)) {
    return controlError(
      "operation_timeout",
      "operation_timeout",
      error.message,
      error.outcome === "unknown" ? "unknown" : "not_sent",
      error.outcome === "unknown" ? false : error.retry_safe,
      error
    );
  }
  if (error.outcome === "unknown") {
    return controlError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (error.outcome === "remote_rejected") {
    return controlError("operation_conflict", "operation_conflict", error.message, "remote_rejected", error.retry_safe, error);
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    if (mutation && error.outcome !== "not_sent") {
      return controlError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
    }
    return controlError("runtime_protocol_error", "protocol_error", error.message, "not_sent", false, error);
  }
  if (error.code === "broker_overloaded") {
    return controlError("service_overloaded", "service_overloaded", error.message, "not_sent", error.retry_safe, error);
  }
  return controlError("runtime_unavailable", "runtime_unavailable", error.message || fallback, "not_sent", error.retry_safe, error);
}

function requireModelDeadline(candidate: unknown): OperationDeadline {
  return requireOpenOperationDeadline(
    candidate,
    modelDeadlineError,
    modelInvalidDeadlineError
  );
}

function modelInvalidDeadlineError(cause: unknown): HostDeckCodexModelControlError {
  return controlError(
    "invalid_request",
    "validation_error",
    "The model request deadline is invalid.",
    "not_sent",
    false,
    cause
  );
}

function modelDeadlineError(cause: unknown): HostDeckCodexModelControlError {
  return controlError(
    "operation_timeout",
    "operation_timeout",
    "Codex model operation exceeded its request deadline.",
    "not_sent",
    true,
    cause
  );
}

function errorEnvelope(error: HostDeckCodexModelControlError): NonNullable<PendingModelSelection["error"]> {
  return {
    code: error.api_code,
    message: error.message,
    retryable: error.retry_safe
  };
}

function controlError(
  code: CodexModelControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  outcome: CodexModelControlOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexModelControlError {
  return new HostDeckCodexModelControlError(code, apiCode, message, outcome, retrySafe, { cause });
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex model control failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
