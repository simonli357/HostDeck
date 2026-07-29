import {
  type ApiErrorEnvelope,
  type ModelCatalogEntry,
  type ModelControlSnapshot,
  type ModelSelectionRequest,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  type BrowserConnectionSnapshot,
  type BrowserConnectionWriteBlockCause,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import { hostLockWriteReason } from "./host-lock-copy.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

export const modelControlPhases = Object.freeze([
  "hidden",
  "closed",
  "loading",
  "ready",
  "submitting",
  "staged",
  "cleared",
  "already_current",
  "dispatching",
  "awaiting_confirmation",
  "conflict",
  "pending_unknown",
  "unsupported",
  "read_failed",
  "select_failed",
  "outcome_unknown"
] as const);

export type ModelControlPhase = (typeof modelControlPhases)[number];
export type ModelControlTone = "connected" | "attention" | "danger" | "focus" | "muted";

export interface ModelControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface ModelControlReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface ModelControlSelectInput {
  readonly sessionId: SessionId;
  readonly request: ModelSelectionRequest;
  readonly signal: AbortSignal;
}

export interface ModelControlPort {
  readonly read: (input: ModelControlReadInput) => Promise<unknown>;
  readonly select: (input: ModelControlSelectInput) => Promise<unknown>;
}

export interface CreateModelControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: ModelControlContext;
  readonly port: ModelControlPort;
  readonly createOperationId: () => string;
}

export interface ModelControlCurrentView {
  readonly label: string;
  readonly modelId: string | null;
  readonly runtimeModel: string;
  readonly effort: string | null;
  readonly catalogKnown: boolean;
}

export interface ModelControlPendingView {
  readonly label: string;
  readonly modelId: string;
  readonly effort: string;
  readonly phase: ModelControlSnapshot["pending"] extends infer Pending
    ? NonNullable<Pending> extends { readonly phase: infer Phase }
      ? Phase
      : never
    : never;
  readonly phaseLabel: string;
  readonly detail: string;
  readonly tone: ModelControlTone;
}

export interface ModelControlModelOptionView {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly isCurrent: boolean;
  readonly isPending: boolean;
  readonly supportsImages: boolean;
}

export interface ModelControlEffortOptionView {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly isDefault: boolean;
}

export interface ModelControlView {
  readonly visible: boolean;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly sheetOpen: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly phase: ModelControlPhase;
  readonly tone: ModelControlTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly current: ModelControlCurrentView | null;
  readonly pending: ModelControlPendingView | null;
  readonly models: readonly ModelControlModelOptionView[];
  readonly efforts: readonly ModelControlEffortOptionView[];
  readonly selectedModelId: string | null;
  readonly selectedEffort: string | null;
  readonly selectionEnabled: boolean;
  readonly selectionDisabledReason: string | null;
  readonly submitEnabled: boolean;
  readonly submitLabel: "Set for next turn" | "Clear pending change";
  readonly refreshEnabled: boolean;
  readonly closeDisabled: boolean;
}

export interface ModelControlController {
  readonly snapshot: () => ModelControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: ModelControlContext) => ModelControlView;
  readonly open: () => Promise<ModelControlView>;
  readonly dismiss: () => ModelControlView;
  readonly refresh: () => Promise<ModelControlView>;
  readonly selectModel: (modelId: string) => ModelControlView;
  readonly selectEffort: (effort: string) => ModelControlView;
  readonly submit: () => Promise<ModelControlView>;
  readonly close: () => ModelControlView;
}

type ModelControlOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{
      phase: "submitting";
      operationId: string;
      modelId: string;
      effort: string;
      expectedRevision: number | null;
    }>
  | Readonly<{ phase: "result"; result: "staged" | "cleared" | "already_current" }>
  | Readonly<{ phase: "failure"; failure: ModelControlFailure }>;

interface ModelControlFailure {
  readonly source: "read" | "select";
  readonly kind: "known" | "unsupported" | "unknown";
  readonly message: string;
  readonly retryable: boolean;
  readonly requiresRefresh: boolean;
  readonly modelId: string | null;
  readonly effort: string | null;
}

interface ModelControlAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly readEnabled: boolean;
  readonly writeEnabled: boolean;
  readonly readReason: string | null;
  readonly writeReason: string | null;
}

interface ModelControlStatus {
  readonly phase: ModelControlPhase;
  readonly tone: ModelControlTone;
  readonly label: string;
  readonly detail: string | null;
}

const maximumSubscribers = 32;
const ambiguousApiCodes = new Set([
  "audit_unavailable",
  "internal_error",
  "operation_timeout",
  "unknown_error"
]);
const refreshApiCodes = new Set([
  "capability_unavailable",
  "effort_unsupported",
  "incompatible_runtime",
  "model_unknown",
  "operation_conflict",
  "runtime_unavailable",
  "stale_session"
]);

export function projectModelControl(input: Readonly<{
  sessionId: SessionId;
  context: ModelControlContext;
  open: boolean;
  data: ModelControlSnapshot | null;
  selectedModelId: string | null;
  selectedEffort: string | null;
  operation: ModelControlOperation;
}>): ModelControlView {
  const sessionId = parseSessionId(input.sessionId);
  const context = parseContext(input.context);
  const data = input.data === null ? null : freezeSnapshot(input.data);
  const availability = deriveAvailability(context.snapshot, sessionId);
  const sheetOpen = input.open && availability.visible;
  const selectedModel = data?.models.find((model) => model.id === input.selectedModelId) ?? null;
  const selectedEffort =
    selectedModel?.reasoning_efforts.some((effort) => effort.id === input.selectedEffort) === true
      ? input.selectedEffort
      : null;
  const status = deriveStatus(input.operation, data, availability, sheetOpen);
  const current = data === null ? null : projectCurrent(data);
  const pending = data?.pending === null || data === null ? null : projectPending(data);
  const models = data === null ? Object.freeze([]) : projectModels(data);
  const efforts = selectedModel === null ? Object.freeze([]) : projectEfforts(selectedModel);
  const nonReplaceablePending =
    data?.pending !== null &&
    data?.pending !== undefined &&
    ["dispatching", "awaiting_confirmation", "unknown"].includes(data.pending.phase);
  const operationBlocksSelection =
    input.operation.phase === "loading" ||
    input.operation.phase === "submitting" ||
    (input.operation.phase === "failure" &&
      (input.operation.failure.kind === "unknown" ||
        input.operation.failure.kind === "unsupported" ||
        input.operation.failure.requiresRefresh));
  const selectionEnabled =
    sheetOpen &&
    data !== null &&
    data.models.length > 0 &&
    availability.writeEnabled &&
    !nonReplaceablePending &&
    !operationBlocksSelection;
  const samePending =
    data?.pending !== null &&
    data?.pending !== undefined &&
    data.pending.phase === "pending" &&
    data.pending.model_id === selectedModel?.id &&
    data.pending.reasoning_effort === selectedEffort;
  const sameCurrent =
    data?.pending === null &&
    data.current.catalog_state === "available" &&
    data.current.model_id === selectedModel?.id &&
    data.current.reasoning_effort === selectedEffort;
  const failureBlocksSameSelection =
    input.operation.phase === "failure" &&
    input.operation.failure.source === "select" &&
    !input.operation.failure.retryable &&
    input.operation.failure.modelId === selectedModel?.id &&
    input.operation.failure.effort === selectedEffort;
  const submitEnabled =
    selectionEnabled &&
    selectedModel !== null &&
    selectedEffort !== null &&
    !samePending &&
    !sameCurrent &&
    !failureBlocksSameSelection;
  const clearingPending =
    data?.pending !== null &&
    data?.pending !== undefined &&
    data.current.catalog_state === "available" &&
    data.current.model_id === selectedModel?.id &&
    data.current.reasoning_effort === selectedEffort;
  const selectionDisabledReason = selectionEnabled
    ? samePending
      ? "This model and effort are already staged for the next turn."
      : sameCurrent
        ? "This model and effort are already confirmed."
        : failureBlocksSameSelection
          ? input.operation.phase === "failure"
            ? input.operation.failure.message
            : null
          : null
    : selectionReason(input.operation, data, availability, nonReplaceablePending);

  return deepFreeze({
    visible: availability.visible,
    actionEnabled: availability.readEnabled,
    actionDisabledReason: availability.readReason,
    sheetOpen,
    sessionId,
    targetLabel: availability.targetLabel,
    phase: status.phase,
    tone: status.tone,
    status: status.label,
    statusDetail: status.detail,
    current,
    pending,
    models,
    efforts,
    selectedModelId: selectedModel?.id ?? null,
    selectedEffort,
    selectionEnabled,
    selectionDisabledReason,
    submitEnabled,
    submitLabel: clearingPending ? "Clear pending change" : "Set for next turn",
    refreshEnabled:
      sheetOpen &&
      availability.readEnabled &&
      input.operation.phase !== "loading" &&
      input.operation.phase !== "submitting",
    closeDisabled: input.operation.phase === "submitting"
  });
}

export function createModelControlController(
  options: CreateModelControlControllerOptions
): ModelControlController {
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  let sheetOpen = false;
  let data: ModelControlSnapshot | null = null;
  let selectedModelId: string | null = null;
  let selectedEffort: string | null = null;
  let operation: ModelControlOperation = idleOperation();
  let sequence = 0;
  let activeRequest: Readonly<{ sequence: number; controller: AbortController }> | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): ModelControlView {
    return projectModelControl({
      sessionId,
      context,
      open: sheetOpen,
      data,
      selectedModelId,
      selectedEffort,
      operation
    });
  }

  const publish = (): ModelControlView => {
    currentView = project();
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  const cancelActive = (): void => {
    sequence += 1;
    activeRequest?.controller.abort();
    activeRequest = null;
  };

  const installSnapshot = (candidate: unknown): void => {
    data = freezeSnapshot(candidate);
    const draft = initialSelection(data);
    selectedModelId = draft.modelId;
    selectedEffort = draft.effort;
  };

  const runRead = async (): Promise<ModelControlView> => {
    if (closed || !sheetOpen || !currentView.actionEnabled) return currentView;
    cancelActive();
    const requestController = new AbortController();
    const requestSequence = sequence;
    activeRequest = Object.freeze({ sequence: requestSequence, controller: requestController });
    operation = loadingOperation();
    publish();
    try {
      const candidate = await Reflect.apply(port.read, undefined, [
        Object.freeze({ sessionId, signal: requestController.signal })
      ]);
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      installSnapshot(candidate);
      operation = idleOperation();
      return publish();
    } catch (error) {
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      data = null;
      selectedModelId = null;
      selectedEffort = null;
      operation = failureOperation(classifyReadFailure(error));
      return publish();
    } finally {
      if (activeRequest?.sequence === requestSequence) activeRequest = null;
    }
  };

  const controller: ModelControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck model-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck model-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: ModelControlContext): ModelControlView {
      if (closed) throw new TypeError("HostDeck model control is closed.");
      const previousVisible = currentView.visible;
      context = parseContext(nextContext);
      const next = project();
      if (previousVisible && !next.visible) {
        cancelActive();
        sheetOpen = false;
        data = null;
        selectedModelId = null;
        selectedEffort = null;
        operation = idleOperation();
      }
      return publish();
    },
    async open(): Promise<ModelControlView> {
      if (closed || sheetOpen || !currentView.actionEnabled) return currentView;
      sheetOpen = true;
      data = null;
      selectedModelId = null;
      selectedEffort = null;
      operation = idleOperation();
      publish();
      return runRead();
    },
    dismiss(): ModelControlView {
      if (closed || !sheetOpen || currentView.closeDisabled) return currentView;
      cancelActive();
      sheetOpen = false;
      data = null;
      selectedModelId = null;
      selectedEffort = null;
      operation = idleOperation();
      return publish();
    },
    refresh(): Promise<ModelControlView> {
      if (closed || !sheetOpen || !currentView.refreshEnabled) {
        return Promise.resolve(currentView);
      }
      return runRead();
    },
    selectModel(modelId: string): ModelControlView {
      if (closed || !currentView.selectionEnabled || data === null) return currentView;
      const model = data.models.find((candidate) => candidate.id === modelId);
      if (model === undefined) return currentView;
      const nextEffort = preferredEffort(model, data, selectedModelId, selectedEffort);
      if (selectedModelId === model.id && selectedEffort === nextEffort) return currentView;
      selectedModelId = model.id;
      selectedEffort = nextEffort;
      operation = clearSelectableFailure(operation);
      return publish();
    },
    selectEffort(effort: string): ModelControlView {
      if (closed || !currentView.selectionEnabled || data === null || selectedModelId === null) {
        return currentView;
      }
      const model = data.models.find((candidate) => candidate.id === selectedModelId);
      if (model === undefined || !model.reasoning_efforts.some((candidate) => candidate.id === effort)) {
        return currentView;
      }
      if (selectedEffort === effort) return currentView;
      selectedEffort = effort;
      operation = clearSelectableFailure(operation);
      return publish();
    },
    async submit(): Promise<ModelControlView> {
      if (
        closed ||
        !currentView.submitEnabled ||
        data === null ||
        selectedModelId === null ||
        selectedEffort === null
      ) {
        return currentView;
      }
      const modelId = selectedModelId;
      const effort = selectedEffort;
      const expectedRevision = data.pending?.revision ?? null;
      let operationId: string;
      let request: ModelSelectionRequest;
      try {
        operationId = createOperationId();
        request = modelSelectionRequestSchema.parse({
          operation_id: operationId,
          kind: "model",
          model_id: modelId,
          reasoning_effort: effort,
          expected_pending_revision: expectedRevision
        });
      } catch {
        operation = failureOperation({
          source: "select",
          kind: "known",
          message: "Secure model selection is unavailable. Reload HostDeck.",
          retryable: false,
          requiresRefresh: true,
          modelId,
          effort
        });
        return publish();
      }

      cancelActive();
      const requestController = new AbortController();
      const requestSequence = sequence;
      activeRequest = Object.freeze({ sequence: requestSequence, controller: requestController });
      operation = deepFreeze({
        phase: "submitting" as const,
        operationId,
        modelId,
        effort,
        expectedRevision
      });
      publish();

      try {
        const candidate = await Reflect.apply(port.select, undefined, [
          Object.freeze({ sessionId, request, signal: requestController.signal })
        ]);
        if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
        const parsed = modelControlSnapshotSchema.safeParse(candidate);
        const result = parsed.success
          ? correlateSelection(parsed.data, operationId, modelId, effort, expectedRevision)
          : null;
        if (result === null) {
          operation = failureOperation(unknownSelectionFailure(modelId, effort));
          return publish();
        }
        installSnapshot(parsed.data);
        operation = deepFreeze({ phase: "result" as const, result });
        return publish();
      } catch (error) {
        if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
        operation = failureOperation(classifySelectFailure(error, modelId, effort));
        return publish();
      } finally {
        if (activeRequest?.sequence === requestSequence) activeRequest = null;
      }
    },
    close(): ModelControlView {
      if (closed) return currentView;
      closed = true;
      cancelActive();
      sheetOpen = false;
      data = null;
      selectedModelId = null;
      selectedEffort = null;
      operation = idleOperation();
      subscribers.clear();
      currentView = hiddenView(sessionId);
      return currentView;
    }
  });

  return controller;
}

function deriveAvailability(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): ModelControlAvailability {
  const data = snapshot.targetState.data;
  const detail =
    snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    data?.kind === "session_detail" &&
    data.response.session.session.id === sessionId
      ? data.response.session.session
      : null;
  const visible =
    detail !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null) {
    return availability(false, null, false, false, "Session details are not available.", null);
  }
  const readEnabled =
    snapshot.access.state === "current" && snapshot.targetState.state === "current";
  const readReason = readEnabled
    ? null
    : "Connection state is not current. Refresh Session Detail before loading models.";
  const writeCause = snapshot.writeEligibility.causes[0];
  let writeReason =
    snapshot.writeEligibility.eligible && writeCause === undefined
      ? null
      : writeDisabledReason(writeCause ?? "connection_not_current");
  if (detail.session_state === "archived" || detail.archived_at !== null) {
    writeReason = "Archived sessions cannot stage model changes.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    writeReason = "Session state is stale. Refresh before changing models.";
  }
  return availability(
    true,
    detail.name,
    readEnabled,
    readEnabled && writeReason === null,
    readReason,
    writeReason
  );
}

function deriveStatus(
  operation: ModelControlOperation,
  data: ModelControlSnapshot | null,
  availability: ModelControlAvailability,
  sheetOpen: boolean
): ModelControlStatus {
  if (!availability.visible) return status("hidden", "muted", "Model control unavailable", null);
  if (!sheetOpen) {
    return status(
      "closed",
      availability.readEnabled ? "focus" : "attention",
      "Model control closed",
      availability.readReason
    );
  }
  if (operation.phase === "loading") {
    return status("loading", "attention", "Loading models", "Reading current runtime settings and catalog.");
  }
  if (operation.phase === "submitting") {
    return status("submitting", "attention", "Saving next-turn model", "Waiting for HostDeck to stage the selection.");
  }
  if (operation.phase === "result") {
    if (operation.result === "staged") {
      return status("staged", "attention", "Model staged for next turn", "Runtime confirmation follows a later turn start.");
    }
    if (operation.result === "cleared") {
      return status("cleared", "connected", "Pending model change cleared", "The confirmed runtime model remains selected.");
    }
    return status("already_current", "connected", "Current model retained", "No next-turn model change is pending.");
  }
  if (operation.phase === "failure") {
    if (operation.failure.kind === "unknown") {
      return status("outcome_unknown", "danger", "Selection outcome unknown", operation.failure.message);
    }
    if (operation.failure.kind === "unsupported") {
      return status("unsupported", "attention", "Model control unsupported", operation.failure.message);
    }
    return status(
      operation.failure.source === "read" ? "read_failed" : "select_failed",
      operation.failure.retryable ? "attention" : "danger",
      operation.failure.source === "read" ? "Models could not be loaded" : "Model selection was not saved",
      operation.failure.message
    );
  }
  if (data === null) {
    return status("ready", "muted", "Model data unavailable", "Load the runtime model catalog to continue.");
  }
  if (data.models.length === 0) {
    return status("unsupported", "attention", "No selectable models", "The installed runtime returned no visible model choices.");
  }
  const pending = data.pending;
  if (pending === null) {
    return status("ready", "connected", "Model control ready", availability.writeReason);
  }
  switch (pending.phase) {
    case "pending":
      return status("staged", "attention", "Model staged for next turn", "The confirmed runtime setting has not changed yet.");
    case "dispatching":
      return status("dispatching", "attention", "Preparing next-turn settings", "Selection is locked while HostDeck prepares the next turn.");
    case "awaiting_confirmation":
      return status("awaiting_confirmation", "attention", "Turn accepted; awaiting model confirmation", "The runtime has not confirmed the selected settings yet.");
    case "unknown":
      return status("pending_unknown", "danger", "Model confirmation unknown", "Refresh current runtime state before another selection.");
    case "conflict":
      return status("conflict", "danger", "Pending model conflict", "Refresh or replace the pending selection using the current catalog.");
  }
}

function projectCurrent(data: ModelControlSnapshot): ModelControlCurrentView {
  const model = data.models.find((candidate) => candidate.id === data.current.model_id);
  return deepFreeze({
    label: model?.label ?? data.current.runtime_model,
    modelId: data.current.model_id,
    runtimeModel: data.current.runtime_model,
    effort: data.current.reasoning_effort,
    catalogKnown: data.current.catalog_state === "available"
  });
}

function projectPending(data: ModelControlSnapshot): ModelControlPendingView {
  const pending = data.pending;
  if (pending === null) throw new TypeError("HostDeck pending model projection is absent.");
  const model = data.models.find((candidate) => candidate.id === pending.model_id);
  const phase = pendingStatus(pending.phase);
  return deepFreeze({
    label: model?.label ?? pending.runtime_model,
    modelId: pending.model_id,
    effort: pending.reasoning_effort,
    phase: pending.phase,
    phaseLabel: phase.label,
    detail: phase.detail,
    tone: phase.tone
  });
}

function projectModels(data: ModelControlSnapshot): readonly ModelControlModelOptionView[] {
  return deepFreeze(
    data.models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
      isDefault: model.is_default,
      isCurrent: data.current.model_id === model.id,
      isPending: data.pending?.model_id === model.id,
      supportsImages: model.input_modalities.includes("image")
    }))
  );
}

function projectEfforts(model: ModelCatalogEntry): readonly ModelControlEffortOptionView[] {
  return deepFreeze(
    model.reasoning_efforts.map((effort) => ({
      id: effort.id,
      label: humanizeIdentity(effort.id),
      description: effort.description,
      isDefault: effort.is_default
    }))
  );
}

function initialSelection(data: ModelControlSnapshot): Readonly<{
  modelId: string | null;
  effort: string | null;
}> {
  const pending = data.pending;
  if (pending !== null && pending.catalog_state === "available") {
    const model = data.models.find((candidate) => candidate.id === pending.model_id);
    if (model?.reasoning_efforts.some((effort) => effort.id === pending.reasoning_effort)) {
      return Object.freeze({ modelId: model.id, effort: pending.reasoning_effort });
    }
  }
  if (data.current.catalog_state === "available" && data.current.model_id !== null) {
    const model = data.models.find((candidate) => candidate.id === data.current.model_id);
    if (model !== undefined) {
      const effort = model.reasoning_efforts.find(
        (candidate) => candidate.id === data.current.reasoning_effort
      ) ?? model.reasoning_efforts.find((candidate) => candidate.is_default);
      if (effort !== undefined) return Object.freeze({ modelId: model.id, effort: effort.id });
    }
  }
  const model = data.models.find((candidate) => candidate.is_default) ?? data.models[0];
  const effort = model?.reasoning_efforts.find((candidate) => candidate.is_default);
  return Object.freeze({ modelId: model?.id ?? null, effort: effort?.id ?? null });
}

function preferredEffort(
  model: ModelCatalogEntry,
  data: ModelControlSnapshot,
  previousModelId: string | null,
  previousEffort: string | null
): string {
  if (
    previousModelId === model.id &&
    previousEffort !== null &&
    model.reasoning_efforts.some((effort) => effort.id === previousEffort)
  ) {
    return previousEffort;
  }
  if (data.pending?.model_id === model.id) {
    const pending = model.reasoning_efforts.find(
      (effort) => effort.id === data.pending?.reasoning_effort
    );
    if (pending !== undefined) return pending.id;
  }
  if (data.current.model_id === model.id) {
    const current = model.reasoning_efforts.find(
      (effort) => effort.id === data.current.reasoning_effort
    );
    if (current !== undefined) return current.id;
  }
  const fallback = model.reasoning_efforts.find((effort) => effort.is_default);
  if (fallback === undefined) throw new TypeError("HostDeck model has no default effort.");
  return fallback.id;
}

function correlateSelection(
  response: ModelControlSnapshot,
  operationId: string,
  modelId: string,
  effort: string,
  expectedRevision: number | null
): "staged" | "cleared" | "already_current" | null {
  if (response.pending !== null) {
    return response.pending.phase === "pending" &&
      response.pending.selection_operation_id === operationId &&
      response.pending.model_id === modelId &&
      response.pending.reasoning_effort === effort &&
      response.pending.catalog_state === "available" &&
      response.pending.turn_id === null
      ? "staged"
      : null;
  }
  if (
    response.current.catalog_state !== "available" ||
    response.current.model_id !== modelId ||
    response.current.reasoning_effort !== effort
  ) {
    return null;
  }
  return expectedRevision === null ? "already_current" : "cleared";
}

function classifyReadFailure(error: unknown): ModelControlFailure {
  if (error instanceof HostDeckBrowserHttpError && error.apiError !== null) {
    const unsupported = ["capability_unavailable", "incompatible_runtime"].includes(
      error.apiError.code
    );
    return failure({
      source: "read",
      kind: unsupported ? "unsupported" : "known",
      message: apiFailureMessage(error.apiError, "read"),
      retryable: !unsupported && error.apiError.retryable,
      requiresRefresh: false
    });
  }
  if (error instanceof HostDeckBrowserConnectionError) {
    return failure({
      source: "read",
      kind: "known",
      message:
        error.reason === "closed"
          ? "HostDeck closed before models could be loaded. Reload to continue."
          : "Session access is not current. Refresh Session Detail.",
      retryable: false,
      requiresRefresh: true
    });
  }
  return failure({
    source: "read",
    kind: "known",
    message: "The runtime model catalog could not be loaded. Check the connection and try again.",
    retryable: true,
    requiresRefresh: false
  });
}

function classifySelectFailure(
  error: unknown,
  modelId: string,
  effort: string
): ModelControlFailure {
  if (error instanceof HostDeckBrowserConnectionError) {
    return failure({
      source: "select",
      kind: "known",
      message: "Model access is not current. Refresh Session Detail.",
      retryable: false,
      requiresRefresh: true,
      modelId,
      effort
    });
  }
  if (error instanceof HostDeckBrowserCsrfError) {
    if (error.apiError !== null) {
      if (ambiguousApiCodes.has(error.apiError.code)) {
        return unknownSelectionFailure(modelId, effort);
      }
      const unsupported = ["capability_unavailable", "incompatible_runtime"].includes(
        error.apiError.code
      );
      const requiresRefresh = refreshApiCodes.has(error.apiError.code);
      return failure({
        source: "select",
        kind: unsupported ? "unsupported" : "known",
        message: apiFailureMessage(error.apiError, "select"),
        retryable: !unsupported && !requiresRefresh && error.apiError.retryable,
        requiresRefresh,
        modelId,
        effort
      });
    }
    if (
      [
        "client_contract",
        "not_ready",
        "bootstrap_unavailable",
        "stale_generation",
        "authority_rejected"
      ].includes(error.reason)
    ) {
      return failure({
        source: "select",
        kind: "known",
        message: "Secure model access is not ready. Refresh Session Detail.",
        retryable: false,
        requiresRefresh: true,
        modelId,
        effort
      });
    }
  }
  return unknownSelectionFailure(modelId, effort);
}

function unknownSelectionFailure(modelId: string, effort: string): ModelControlFailure {
  return failure({
    source: "select",
    kind: "unknown",
    message: "Check current model state before making another selection. HostDeck will not retry automatically.",
    retryable: false,
    requiresRefresh: true,
    modelId,
    effort
  });
}

function apiFailureMessage(error: ApiErrorEnvelope, operation: "read" | "select"): string {
  switch (error.code) {
    case "session_not_found":
      return "This session no longer exists.";
    case "session_not_writable":
      return "This session cannot stage a model change now.";
    case "stale_session":
      return "Session state changed. Refresh before selecting a model.";
    case "host_locked":
      return hostLockWriteReason("host_locked");
    case "permission_denied":
    case "read_only":
      return operation === "read"
        ? "This phone cannot read model settings."
        : "This phone has read-only access to model settings.";
    case "runtime_unavailable":
      return "The Codex runtime is unavailable. Check the laptop and refresh.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The installed Codex runtime does not support model control.";
    case "operation_conflict":
      return "Model state changed during this selection. Refresh before continuing.";
    case "operation_timeout":
      return "HostDeck could not prove the model-selection outcome.";
    case "rate_limited":
      return "Model requests are temporarily rate limited.";
    case "service_overloaded":
      return "HostDeck is temporarily too busy to save this selection.";
    case "audit_unavailable":
      return "HostDeck could not prove the audited selection outcome.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure model access was rejected.";
    case "validation_error":
      return "The runtime catalog changed. Refresh model choices.";
    default:
      return operation === "read"
        ? "HostDeck could not read model settings."
        : "HostDeck could not save the model selection.";
  }
}

function selectionReason(
  operation: ModelControlOperation,
  data: ModelControlSnapshot | null,
  availability: ModelControlAvailability,
  nonReplaceablePending: boolean
): string | null {
  if (!availability.writeEnabled) return availability.writeReason;
  if (operation.phase === "loading") return "Wait for the current model catalog.";
  if (operation.phase === "submitting") return "A model selection is already being saved.";
  if (operation.phase === "failure") {
    if (operation.failure.kind === "unknown") return operation.failure.message;
    if (operation.failure.requiresRefresh || operation.failure.kind === "unsupported") {
      return operation.failure.message;
    }
  }
  if (data === null) return "Load model settings before selecting.";
  if (data.models.length === 0) return "The runtime exposed no selectable models.";
  if (nonReplaceablePending) {
    return "The pending model is already being applied or checked.";
  }
  return null;
}

function writeDisabledReason(cause: BrowserConnectionWriteBlockCause): string {
  switch (cause) {
    case "connection_not_current":
      return "Connection state is not current. Refresh before changing models.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied":
      return "Pair this phone again to change models.";
    case "read_only_access":
      return "Read-only access cannot change models.";
    case "host_lock_pending":
    case "host_lock_unconfirmed":
    case "host_locked":
      return hostLockWriteReason(cause);
    case "host_status_unavailable":
    case "host_not_ready":
      return "Laptop write services are not ready.";
    case "csrf_not_ready":
      return "Secure write setup is not ready.";
  }
}

function pendingStatus(phase: NonNullable<ModelControlSnapshot["pending"]>["phase"]): Readonly<{
  label: string;
  detail: string;
  tone: ModelControlTone;
}> {
  switch (phase) {
    case "pending":
      return Object.freeze({ label: "Pending next turn", detail: "Staged in HostDeck", tone: "attention" });
    case "dispatching":
      return Object.freeze({ label: "Preparing", detail: "Turn settings are being composed", tone: "attention" });
    case "awaiting_confirmation":
      return Object.freeze({ label: "Accepted", detail: "Waiting for runtime confirmation", tone: "attention" });
    case "unknown":
      return Object.freeze({ label: "Unknown", detail: "Refresh before another change", tone: "danger" });
    case "conflict":
      return Object.freeze({ label: "Conflict", detail: "Refresh or replace this selection", tone: "danger" });
  }
}

function availability(
  visible: boolean,
  targetLabel: string | null,
  readEnabled: boolean,
  writeEnabled: boolean,
  readReason: string | null,
  writeReason: string | null
): ModelControlAvailability {
  return Object.freeze({ visible, targetLabel, readEnabled, writeEnabled, readReason, writeReason });
}

function status(
  phase: ModelControlPhase,
  tone: ModelControlTone,
  label: string,
  detail: string | null
): ModelControlStatus {
  return Object.freeze({ phase, tone, label, detail });
}

function failure(input: Omit<ModelControlFailure, "modelId" | "effort"> & Readonly<{
  modelId?: string | null;
  effort?: string | null;
}>): ModelControlFailure {
  return deepFreeze({
    ...input,
    modelId: input.modelId ?? null,
    effort: input.effort ?? null
  });
}

function idleOperation(): ModelControlOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingOperation(): ModelControlOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureOperation(failureValue: ModelControlFailure): ModelControlOperation {
  return deepFreeze({ phase: "failure" as const, failure: failureValue });
}

function clearSelectableFailure(operation: ModelControlOperation): ModelControlOperation {
  return operation.phase === "failure" && operation.failure.kind === "known"
    ? idleOperation()
    : operation;
}

function freezeSnapshot(candidate: unknown): ModelControlSnapshot {
  return deepFreeze(modelControlSnapshotSchema.parse(candidate));
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseContext(candidate: unknown): ModelControlContext {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 1 ||
    !("snapshot" in candidate)
  ) {
    throw new TypeError("HostDeck model-control context is invalid.");
  }
  const snapshot = candidate.snapshot;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("HostDeck model-control snapshot is invalid.");
  }
  return Object.freeze({ snapshot: snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): ModelControlPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 2 ||
    !("read" in candidate) ||
    typeof candidate.read !== "function" ||
    !("select" in candidate) ||
    typeof candidate.select !== "function"
  ) {
    throw new TypeError("HostDeck model-control port is invalid.");
  }
  return Object.freeze({
    read: candidate.read as ModelControlPort["read"],
    select: candidate.select as ModelControlPort["select"]
  });
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck model operation-id factory is invalid.");
  }
  return candidate as () => string;
}

function humanizeIdentity(value: string): string {
  return value
    .split(/[_-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function hiddenView(sessionId: SessionId): ModelControlView {
  return deepFreeze({
    visible: false,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    sheetOpen: false,
    sessionId,
    targetLabel: null,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Model control unavailable",
    statusDetail: null,
    current: null,
    pending: null,
    models: [],
    efforts: [],
    selectedModelId: null,
    selectedEffort: null,
    selectionEnabled: false,
    selectionDisabledReason: "Session details are not available.",
    submitEnabled: false,
    submitLabel: "Set for next turn" as const,
    refreshEnabled: false,
    closeDisabled: false
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
