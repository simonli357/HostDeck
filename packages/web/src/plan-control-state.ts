import {
  type ApiErrorEnvelope,
  deepFreezeExactData, 
  type PlanControlSnapshot,
  type PlanMode,
  type PlanSelectionRequest,
  planControlSnapshotSchema,
  planSelectionRequestSchema,
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

export const planControlPhases = Object.freeze([
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

export type PlanControlPhase = (typeof planControlPhases)[number];
export type PlanControlTone = "connected" | "attention" | "danger" | "focus" | "muted";

export interface PlanControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface PlanControlReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface PlanControlSelectInput {
  readonly sessionId: SessionId;
  readonly request: PlanSelectionRequest;
  readonly signal: AbortSignal;
}

export interface PlanControlPort {
  readonly read: (input: PlanControlReadInput) => Promise<unknown>;
  readonly select: (input: PlanControlSelectInput) => Promise<unknown>;
}

export interface CreatePlanControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: PlanControlContext;
  readonly port: PlanControlPort;
  readonly createOperationId: () => string;
}

export interface PlanControlCurrentView {
  readonly state: PlanControlSnapshot["current"]["state"];
  readonly mode: PlanMode | null;
  readonly label: string;
  readonly runtimeModel: string | null;
  readonly effort: string | null;
  readonly observedAt: string | null;
  readonly tone: PlanControlTone;
}

export interface PlanControlPendingView {
  readonly mode: PlanMode;
  readonly label: string;
  readonly phase: NonNullable<PlanControlSnapshot["pending"]>["phase"];
  readonly phaseLabel: string;
  readonly detail: string;
  readonly tone: PlanControlTone;
  readonly catalogAvailable: boolean;
  readonly selectedAt: string;
  readonly resolvedRuntimeModel: string | null;
  readonly resolvedEffort: string | null;
}

export interface PlanControlExecutionView {
  readonly state: PlanControlSnapshot["execution"]["state"];
  readonly stateLabel: string;
  readonly evidence: PlanControlSnapshot["execution"]["evidence"];
  readonly evidenceLabel: string;
  readonly summary: string | null;
  readonly updatedAt: string | null;
  readonly tone: PlanControlTone;
}

export interface PlanControlModeOptionView {
  readonly mode: PlanMode;
  readonly name: string;
  readonly description: string;
  readonly presetModel: string | null;
  readonly presetEffort: string | null;
  readonly isCurrent: boolean;
  readonly isPending: boolean;
}

export interface PlanControlView {
  readonly visible: boolean;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly sheetOpen: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly phase: PlanControlPhase;
  readonly tone: PlanControlTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly catalogObservedAt: string | null;
  readonly current: PlanControlCurrentView | null;
  readonly pending: PlanControlPendingView | null;
  readonly execution: PlanControlExecutionView | null;
  readonly modes: readonly PlanControlModeOptionView[];
  readonly selectedMode: PlanMode | null;
  readonly selectionEnabled: boolean;
  readonly selectionDisabledReason: string | null;
  readonly submitEnabled: boolean;
  readonly submitLabel: "Set for next turn" | "Restage for next turn" | "Clear pending change";
  readonly refreshEnabled: boolean;
  readonly closeDisabled: boolean;
}

export interface PlanControlController {
  readonly snapshot: () => PlanControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: PlanControlContext) => PlanControlView;
  readonly open: () => Promise<PlanControlView>;
  readonly dismiss: () => PlanControlView;
  readonly refresh: () => Promise<PlanControlView>;
  readonly selectMode: (mode: PlanMode) => PlanControlView;
  readonly submit: () => Promise<PlanControlView>;
  readonly close: () => PlanControlView;
}

type PlanControlOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{
      phase: "submitting";
      operationId: string;
      mode: PlanMode;
      expectedRevision: number | null;
    }>
  | Readonly<{ phase: "result"; result: "staged" | "cleared" | "already_current"; mode: PlanMode }>
  | Readonly<{ phase: "failure"; failure: PlanControlFailure }>;

interface PlanControlFailure {
  readonly source: "read" | "select";
  readonly kind: "known" | "unsupported" | "unknown";
  readonly message: string;
  readonly retryable: boolean;
  readonly requiresRefresh: boolean;
  readonly mode: PlanMode | null;
}

interface PlanControlAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly readEnabled: boolean;
  readonly writeEnabled: boolean;
  readonly readReason: string | null;
  readonly writeReason: string | null;
}

interface PlanControlStatus {
  readonly phase: PlanControlPhase;
  readonly tone: PlanControlTone;
  readonly label: string;
  readonly detail: string | null;
}

const maximumSubscribers = 32;
const ambiguousApiCodes = new Set([
  "audit_unavailable",
  "internal_error",
  "operation_timeout",
  "protocol_error",
  "unknown_error"
]);
const refreshApiCodes = new Set([
  "capability_unavailable",
  "host_locked",
  "insecure_transport",
  "incompatible_runtime",
  "invalid_origin",
  "operation_conflict",
  "permission_denied",
  "read_only",
  "runtime_unavailable",
  "session_not_found",
  "session_not_writable",
  "stale_session",
  "validation_error"
]);

export function projectPlanControl(input: Readonly<{
  sessionId: SessionId;
  context: PlanControlContext;
  open: boolean;
  data: PlanControlSnapshot | null;
  selectedMode: PlanMode | null;
  operation: PlanControlOperation;
}>): PlanControlView {
  const sessionId = parseSessionId(input.sessionId);
  const context = parseContext(input.context);
  const data = input.data === null ? null : freezeSnapshot(input.data);
  const availability = deriveAvailability(context.snapshot, sessionId);
  const sheetOpen = input.open && availability.visible;
  const selectedMode = data?.modes.some((entry) => entry.mode === input.selectedMode) === true
    ? input.selectedMode
    : null;
  const statusValue = deriveStatus(input.operation, data, availability, sheetOpen);
  const current = data === null ? null : projectCurrent(data);
  const pending = data?.pending === null || data === null ? null : projectPending(data);
  const execution = data === null ? null : projectExecution(data);
  const modes = data === null ? Object.freeze([]) : projectModes(data);
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
    data.modes.length > 0 &&
    availability.writeEnabled &&
    !nonReplaceablePending &&
    !operationBlocksSelection;
  const samePending =
    data?.pending !== null &&
    data?.pending !== undefined &&
    data.pending.phase === "pending" &&
    data.pending.mode === selectedMode;
  const sameCurrent =
    data?.pending === null &&
    data.current.state === "confirmed" &&
    data.current.mode === selectedMode;
  const failureBlocksSameSelection =
    input.operation.phase === "failure" &&
    input.operation.failure.source === "select" &&
    !input.operation.failure.retryable &&
    input.operation.failure.mode === selectedMode;
  const submitEnabled =
    selectionEnabled &&
    selectedMode !== null &&
    !samePending &&
    !sameCurrent &&
    !failureBlocksSameSelection;
  const clearingPending =
    data?.pending !== null &&
    data?.pending !== undefined &&
    data.current.state === "confirmed" &&
    data.current.mode === selectedMode;
  const restagingConflict =
    data?.pending !== null &&
    data?.pending !== undefined &&
    data.pending.phase === "conflict" &&
    data.pending.mode === selectedMode &&
    !clearingPending;
  const selectionDisabledReason = selectionEnabled
    ? samePending
      ? "This mode is already staged for the next turn."
      : sameCurrent
        ? "This mode is already confirmed and no change is pending."
        : failureBlocksSameSelection && input.operation.phase === "failure"
          ? input.operation.failure.message
          : null
    : selectionReason(input.operation, data, availability, nonReplaceablePending);

  return deepFreezeExactData({
    visible: availability.visible,
    actionEnabled: availability.readEnabled,
    actionDisabledReason: availability.readReason,
    sheetOpen,
    sessionId,
    targetLabel: availability.targetLabel,
    phase: statusValue.phase,
    tone: statusValue.tone,
    status: statusValue.label,
    statusDetail: statusValue.detail,
    catalogObservedAt: data?.catalog_observed_at ?? null,
    current,
    pending,
    execution,
    modes,
    selectedMode,
    selectionEnabled,
    selectionDisabledReason,
    submitEnabled,
    submitLabel: clearingPending
      ? "Clear pending change"
      : restagingConflict
        ? "Restage for next turn"
        : "Set for next turn",
    refreshEnabled:
      sheetOpen &&
      availability.readEnabled &&
      input.operation.phase !== "loading" &&
      input.operation.phase !== "submitting",
    closeDisabled: input.operation.phase === "submitting"
  });
}

export function createPlanControlController(
  options: CreatePlanControlControllerOptions
): PlanControlController {
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  let sheetOpen = false;
  let data: PlanControlSnapshot | null = null;
  let selectedMode: PlanMode | null = null;
  let operation: PlanControlOperation = idleOperation();
  let sequence = 0;
  let activeRequest: Readonly<{ sequence: number; controller: AbortController }> | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): PlanControlView {
    return projectPlanControl({
      sessionId,
      context,
      open: sheetOpen,
      data,
      selectedMode,
      operation
    });
  }

  const publish = (): PlanControlView => {
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
    selectedMode = initialSelection(data);
  };

  const runRead = async (): Promise<PlanControlView> => {
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
      selectedMode = null;
      operation = failureOperation(classifyReadFailure(error));
      return publish();
    } finally {
      if (activeRequest?.sequence === requestSequence) activeRequest = null;
    }
  };

  const controller: PlanControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck plan-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck plan-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: PlanControlContext): PlanControlView {
      if (closed) throw new TypeError("HostDeck plan control is closed.");
      const previousVisible = currentView.visible;
      const previousOperation = operation;
      const previousEpoch = context.snapshot.epoch;
      context = parseContext(nextContext);
      const nextAvailability = deriveAvailability(context.snapshot, sessionId);
      const authorityEpochChanged = context.snapshot.epoch !== previousEpoch;
      if (previousVisible && !nextAvailability.visible) {
        cancelActive();
        sheetOpen = false;
        data = null;
        selectedMode = null;
        operation = idleOperation();
      } else if (authorityEpochChanged) {
        cancelActive();
        data = null;
        selectedMode = null;
        operation = previousOperation.phase === "submitting"
          ? failureOperation(unknownSelectionFailure(previousOperation.mode))
          : failureOperation({
              source: "read",
              kind: "known",
              message: "Session access changed. Check current Plan state.",
              retryable: false,
              requiresRefresh: true,
              mode: null
            });
      } else if (previousOperation.phase === "loading" && !nextAvailability.readEnabled) {
        cancelActive();
        data = null;
        selectedMode = null;
        operation = failureOperation({
          source: "read",
          kind: "known",
          message: "Session access is not current. Refresh Session Detail.",
          retryable: false,
          requiresRefresh: true,
          mode: null
        });
      } else if (previousOperation.phase === "submitting" && !nextAvailability.writeEnabled) {
        cancelActive();
        operation = failureOperation(unknownSelectionFailure(previousOperation.mode));
      }
      return publish();
    },
    async open(): Promise<PlanControlView> {
      if (closed || sheetOpen || !currentView.actionEnabled) return currentView;
      sheetOpen = true;
      data = null;
      selectedMode = null;
      operation = idleOperation();
      publish();
      return runRead();
    },
    dismiss(): PlanControlView {
      if (closed || !sheetOpen || currentView.closeDisabled) return currentView;
      cancelActive();
      sheetOpen = false;
      data = null;
      selectedMode = null;
      operation = idleOperation();
      return publish();
    },
    refresh(): Promise<PlanControlView> {
      if (closed || !sheetOpen || !currentView.refreshEnabled) {
        return Promise.resolve(currentView);
      }
      return runRead();
    },
    selectMode(mode: PlanMode): PlanControlView {
      if (closed || !currentView.selectionEnabled || data === null) return currentView;
      if (!data.modes.some((candidate) => candidate.mode === mode) || selectedMode === mode) {
        return currentView;
      }
      selectedMode = mode;
      operation = clearSelectableFailure(operation);
      return publish();
    },
    async submit(): Promise<PlanControlView> {
      if (closed || !currentView.submitEnabled || data === null || selectedMode === null) {
        return currentView;
      }
      const mode = selectedMode;
      const expectedRevision = data.pending?.revision ?? null;
      let operationId: string;
      let request: PlanSelectionRequest;
      try {
        operationId = createOperationId();
        request = planSelectionRequestSchema.parse({
          operation_id: operationId,
          kind: "plan",
          action: mode === "plan" ? "enter" : "exit",
          expected_pending_revision: expectedRevision
        });
      } catch {
        operation = failureOperation({
          source: "select",
          kind: "known",
          message: "Secure Plan selection is unavailable. Reload HostDeck.",
          retryable: false,
          requiresRefresh: true,
          mode
        });
        return publish();
      }

      cancelActive();
      const requestController = new AbortController();
      const requestSequence = sequence;
      activeRequest = Object.freeze({ sequence: requestSequence, controller: requestController });
      operation = deepFreezeExactData({
        phase: "submitting" as const,
        operationId,
        mode,
        expectedRevision
      });
      publish();

      try {
        const candidate = await Reflect.apply(port.select, undefined, [
          Object.freeze({ sessionId, request, signal: requestController.signal })
        ]);
        if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
        const parsed = planControlSnapshotSchema.safeParse(candidate);
        const result = parsed.success
          ? correlateSelection(parsed.data, operationId, mode, expectedRevision)
          : null;
        if (result === null) {
          operation = failureOperation(unknownSelectionFailure(mode));
          return publish();
        }
        installSnapshot(parsed.data);
        operation = deepFreezeExactData({ phase: "result" as const, result, mode });
        return publish();
      } catch (error) {
        if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
        operation = failureOperation(classifySelectFailure(error, mode));
        return publish();
      } finally {
        if (activeRequest?.sequence === requestSequence) activeRequest = null;
      }
    },
    close(): PlanControlView {
      if (closed) return currentView;
      closed = true;
      cancelActive();
      sheetOpen = false;
      data = null;
      selectedMode = null;
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
): PlanControlAvailability {
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
  const readEnabled = snapshot.access.state === "current" && snapshot.targetState.state === "current";
  const readReason = readEnabled
    ? null
    : "Connection state is not current. Refresh Session Detail before loading Plan state.";
  const writeCause = snapshot.writeEligibility.causes[0];
  let writeReason =
    snapshot.writeEligibility.eligible && writeCause === undefined
      ? null
      : writeDisabledReason(writeCause ?? "connection_not_current");
  if (detail.session_state === "archived" || detail.archived_at !== null) {
    writeReason = "Archived sessions cannot stage Plan changes.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    writeReason = "Session state is stale. Refresh before changing Plan mode.";
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
  operation: PlanControlOperation,
  data: PlanControlSnapshot | null,
  availability: PlanControlAvailability,
  sheetOpen: boolean
): PlanControlStatus {
  if (!availability.visible) return status("hidden", "muted", "Plan control unavailable", null);
  if (!sheetOpen) {
    return status(
      "closed",
      availability.readEnabled ? "focus" : "attention",
      "Plan control closed",
      availability.readReason
    );
  }
  if (operation.phase === "loading") {
    return status("loading", "attention", "Loading Plan state", "Reading current, next-turn, and execution truth.");
  }
  if (operation.phase === "submitting") {
    return status("submitting", "attention", "Saving next-turn mode", "Waiting for HostDeck to stage or clear the selection.");
  }
  if (operation.phase === "result") {
    const label = modeLabel(operation.mode, data);
    if (operation.result === "staged") {
      return status("staged", "attention", `${label} staged for next turn`, "The current turn is unchanged. Runtime confirmation follows a later turn start.");
    }
    if (operation.result === "cleared") {
      return status("cleared", "connected", "Pending Plan change cleared", `${label} remains the confirmed current mode.`);
    }
    return status("already_current", "connected", `${label} already confirmed`, "No next-turn Plan change is pending.");
  }
  if (operation.phase === "failure") {
    if (operation.failure.kind === "unknown") {
      return status("outcome_unknown", "danger", "Selection outcome unknown", operation.failure.message);
    }
    if (operation.failure.kind === "unsupported") {
      return status("unsupported", "attention", "Plan control unsupported", operation.failure.message);
    }
    return status(
      operation.failure.source === "read" ? "read_failed" : "select_failed",
      operation.failure.retryable ? "attention" : "danger",
      operation.failure.source === "read" ? "Plan state could not be loaded" : "Plan selection was not saved",
      operation.failure.message
    );
  }
  if (data === null) {
    return status("ready", "muted", "Plan data unavailable", "Load current Plan state to continue.");
  }
  const pending = data.pending;
  if (pending === null) {
    return data.current.state === "unknown"
      ? status("ready", "attention", "Current Plan mode unknown", availability.writeReason ?? "Choose a mode for the next turn without inferring current runtime state.")
      : status("ready", "connected", "Plan control ready", availability.writeReason);
  }
  switch (pending.phase) {
    case "pending":
      return status("staged", "attention", `${modeLabel(pending.mode, data)} staged for next turn`, "The confirmed current mode and current turn have not changed.");
    case "dispatching":
      return status("dispatching", "attention", "Preparing next-turn Plan settings", "Selection is locked while HostDeck prepares the next turn.");
    case "awaiting_confirmation":
      return status("awaiting_confirmation", "attention", "Turn accepted; awaiting Plan confirmation", "The runtime has not confirmed the selected collaboration mode yet.");
    case "unknown":
      return status("pending_unknown", "danger", "Plan confirmation unknown", "Check current state before another selection.");
    case "conflict":
      return status("conflict", "danger", "Pending Plan conflict", "Replace or clear the pending selection from this observed revision.");
  }
}

function projectCurrent(data: PlanControlSnapshot): PlanControlCurrentView {
  if (data.current.state === "unknown") {
    return deepFreezeExactData({
      state: "unknown" as const,
      mode: null,
      label: "Unknown",
      runtimeModel: null,
      effort: null,
      observedAt: null,
      tone: "attention" as const
    });
  }
  return deepFreezeExactData({
    state: "confirmed" as const,
    mode: data.current.mode,
    label: modeLabel(data.current.mode, data),
    runtimeModel: data.current.runtime_model,
    effort: data.current.reasoning_effort,
    observedAt: data.current.observed_at,
    tone: "connected" as const
  });
}

function projectPending(data: PlanControlSnapshot): PlanControlPendingView {
  const pending = data.pending;
  if (pending === null) throw new TypeError("HostDeck pending Plan projection is absent.");
  const phase = pendingStatus(pending.phase, pending.catalog_state === "available");
  return deepFreezeExactData({
    mode: pending.mode,
    label: modeLabel(pending.mode, data),
    phase: pending.phase,
    phaseLabel: phase.label,
    detail: phase.detail,
    tone: phase.tone,
    catalogAvailable: pending.catalog_state === "available",
    selectedAt: pending.selected_at,
    resolvedRuntimeModel: pending.resolved_settings?.runtime_model ?? null,
    resolvedEffort: pending.resolved_settings?.reasoning_effort ?? null
  });
}

function projectExecution(data: PlanControlSnapshot): PlanControlExecutionView {
  const execution = data.execution;
  const projection = executionStatus(execution.state);
  return deepFreezeExactData({
    state: execution.state,
    stateLabel: projection.label,
    evidence: execution.evidence,
    evidenceLabel: executionEvidenceLabel(execution.evidence),
    summary: execution.summary,
    updatedAt: execution.updated_at,
    tone: projection.tone
  });
}

function projectModes(data: PlanControlSnapshot): readonly PlanControlModeOptionView[] {
  return deepFreezeExactData(
    data.modes.map((entry) => ({
      mode: entry.mode,
      name: entry.name,
      description: modeDescription(entry.preset_model, entry.preset_reasoning_effort),
      presetModel: entry.preset_model,
      presetEffort: entry.preset_reasoning_effort,
      isCurrent: data.current.state === "confirmed" && data.current.mode === entry.mode,
      isPending: data.pending?.mode === entry.mode
    }))
  );
}

function initialSelection(data: PlanControlSnapshot): PlanMode | null {
  if (data.pending !== null && data.modes.some((entry) => entry.mode === data.pending?.mode)) {
    return data.pending.mode;
  }
  if (
    data.current.state === "confirmed" &&
    data.current.mode !== null &&
    data.modes.some((entry) => entry.mode === data.current.mode)
  ) {
    return data.current.mode;
  }
  return null;
}

function correlateSelection(
  response: PlanControlSnapshot,
  operationId: string,
  mode: PlanMode,
  expectedRevision: number | null
): "staged" | "cleared" | "already_current" | null {
  if (!response.modes.some((entry) => entry.mode === mode)) return null;
  if (response.pending !== null) {
    if (
      response.pending.phase !== "pending" ||
      response.pending.selection_operation_id !== operationId ||
      response.pending.mode !== mode ||
      response.pending.catalog_state !== "available" ||
      response.pending.turn_id !== null ||
      response.pending.resolved_settings !== null ||
      response.pending.error !== null ||
      (expectedRevision !== null && response.pending.revision <= expectedRevision)
    ) {
      return null;
    }
    return "staged";
  }
  if (response.current.state !== "confirmed" || response.current.mode !== mode) return null;
  return expectedRevision === null ? "already_current" : "cleared";
}

function classifyReadFailure(error: unknown): PlanControlFailure {
  if (error instanceof HostDeckBrowserHttpError && error.apiError !== null) {
    const unsupported = ["capability_unavailable", "incompatible_runtime"].includes(error.apiError.code);
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
          ? "HostDeck closed before Plan state could be loaded. Reload to continue."
          : "Session access is not current. Refresh Session Detail.",
      retryable: false,
      requiresRefresh: true
    });
  }
  return failure({
    source: "read",
    kind: "known",
    message: "Plan state could not be loaded. Check the connection and try again.",
    retryable: true,
    requiresRefresh: false
  });
}

function classifySelectFailure(error: unknown, mode: PlanMode): PlanControlFailure {
  if (error instanceof HostDeckBrowserConnectionError) {
    return failure({
      source: "select",
      kind: "known",
      message: "Plan access is not current. Refresh Session Detail.",
      retryable: false,
      requiresRefresh: true,
      mode
    });
  }
  if (error instanceof HostDeckBrowserCsrfError) {
    if (error.apiError !== null) {
      const code = error.apiError.code;
      if (ambiguousApiCodes.has(code) || (code === "operation_conflict" && !error.apiError.retryable)) {
        return unknownSelectionFailure(mode);
      }
      const unsupported = ["capability_unavailable", "incompatible_runtime"].includes(code);
      const requiresRefresh = refreshApiCodes.has(code);
      return failure({
        source: "select",
        kind: unsupported ? "unsupported" : "known",
        message: apiFailureMessage(error.apiError, "select"),
        retryable: !unsupported && !requiresRefresh && error.apiError.retryable,
        requiresRefresh,
        mode
      });
    }
    if (["client_contract", "not_ready", "bootstrap_unavailable"].includes(error.reason)) {
      return failure({
        source: "select",
        kind: "known",
        message: "Secure Plan access is not ready. Refresh Session Detail.",
        retryable: false,
        requiresRefresh: true,
        mode
      });
    }
  }
  return unknownSelectionFailure(mode);
}

function unknownSelectionFailure(mode: PlanMode): PlanControlFailure {
  return failure({
    source: "select",
    kind: "unknown",
    message: "Check current Plan state before another selection. HostDeck will not retry automatically.",
    retryable: false,
    requiresRefresh: true,
    mode
  });
}

function apiFailureMessage(error: ApiErrorEnvelope, operation: "read" | "select"): string {
  switch (error.code) {
    case "session_not_found":
      return "This session no longer exists.";
    case "session_not_writable":
      return "This session cannot stage a Plan change now.";
    case "stale_session":
      return "Session state changed during Plan control. Check current state before continuing.";
    case "host_locked":
      return hostLockWriteReason("host_locked");
    case "permission_denied":
    case "read_only":
      return operation === "read"
        ? "This phone cannot read Plan state."
        : "This phone has read-only access to Plan state.";
    case "runtime_unavailable":
      return "The Codex runtime is unavailable. Check the laptop and refresh.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The installed Codex runtime does not support Plan control.";
    case "operation_conflict":
      return "Pending Plan state changed. Refresh before continuing.";
    case "operation_timeout":
      return "HostDeck could not prove the Plan-selection outcome.";
    case "rate_limited":
      return "Plan requests are temporarily rate limited.";
    case "service_overloaded":
      return "HostDeck is temporarily too busy to save this Plan selection.";
    case "audit_unavailable":
      return "HostDeck could not prove the audited Plan outcome.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure Plan access was rejected.";
    case "validation_error":
      return "The Plan catalog changed. Refresh before continuing.";
    case "protocol_error":
      return "The laptop returned invalid Codex Plan state.";
    default:
      return operation === "read"
        ? "HostDeck could not read Plan state."
        : "HostDeck could not verify the Plan selection.";
  }
}

function selectionReason(
  operation: PlanControlOperation,
  data: PlanControlSnapshot | null,
  availability: PlanControlAvailability,
  nonReplaceablePending: boolean
): string | null {
  if (!availability.writeEnabled) return availability.writeReason;
  if (operation.phase === "loading") return "Wait for current Plan state.";
  if (operation.phase === "submitting") return "A Plan selection is already being saved.";
  if (operation.phase === "failure") {
    if (operation.failure.kind === "unknown") return operation.failure.message;
    if (operation.failure.requiresRefresh || operation.failure.kind === "unsupported") {
      return operation.failure.message;
    }
  }
  if (data === null) return "Load Plan state before selecting.";
  if (data.modes.length === 0) return "The runtime exposed no Plan modes.";
  if (nonReplaceablePending) {
    return "The pending Plan mode is already being applied or checked.";
  }
  return null;
}

function writeDisabledReason(cause: BrowserConnectionWriteBlockCause): string {
  switch (cause) {
    case "connection_not_current":
      return "Connection state is not current. Refresh before changing Plan mode.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied":
      return "Pair this phone again to change Plan mode.";
    case "read_only_access":
      return "Read-only access cannot change Plan mode.";
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

function pendingStatus(
  phase: NonNullable<PlanControlSnapshot["pending"]>["phase"],
  catalogAvailable: boolean
): Readonly<{ label: string; detail: string; tone: PlanControlTone }> {
  const catalogDetail = catalogAvailable ? "" : "; catalog availability is unknown";
  switch (phase) {
    case "pending":
      return Object.freeze({ label: "Pending next turn", detail: "Staged in HostDeck", tone: "attention" });
    case "dispatching":
      return Object.freeze({ label: "Preparing", detail: "Next-turn settings are being composed", tone: "attention" });
    case "awaiting_confirmation":
      return Object.freeze({ label: "Accepted", detail: "Waiting for runtime confirmation", tone: "attention" });
    case "unknown":
      return Object.freeze({ label: "Unknown", detail: `Check state before another change${catalogDetail}`, tone: "danger" });
    case "conflict":
      return Object.freeze({ label: "Conflict", detail: `Replace or clear this selection${catalogDetail}`, tone: "danger" });
  }
}

function executionStatus(
  state: PlanControlSnapshot["execution"]["state"]
): Readonly<{ label: string; tone: PlanControlTone }> {
  switch (state) {
    case "idle":
      return Object.freeze({ label: "No observed Plan execution", tone: "muted" });
    case "awaiting_evidence":
      return Object.freeze({ label: "Awaiting Plan evidence", tone: "attention" });
    case "active":
      return Object.freeze({ label: "Plan execution active", tone: "focus" });
    case "complete":
      return Object.freeze({ label: "Plan execution complete", tone: "connected" });
    case "failed":
      return Object.freeze({ label: "Plan execution failed", tone: "danger" });
    case "interrupted":
      return Object.freeze({ label: "Plan execution interrupted", tone: "attention" });
    case "unknown":
      return Object.freeze({ label: "Plan execution unknown", tone: "danger" });
  }
}

function executionEvidenceLabel(evidence: PlanControlSnapshot["execution"]["evidence"]): string {
  switch (evidence) {
    case "none":
      return "No Plan-specific evidence";
    case "plan_update":
      return "Plan update observed";
    case "plan_item":
      return "Plan item observed";
    case "plan_delta":
      return "Plan delta observed";
  }
}

function modeDescription(model: string | null, effort: string | null): string {
  if (model === null && effort === null) return "Keep the current model and reasoning effort.";
  if (model !== null && effort !== null) return `Preset model ${model} with ${effort} reasoning effort.`;
  if (model !== null) return `Preset model ${model}; keep the current reasoning effort.`;
  return `Keep the current model with ${effort ?? "current"} reasoning effort.`;
}

function modeLabel(mode: PlanMode | null, data: PlanControlSnapshot | null): string {
  if (mode === null) return "Unknown";
  return data?.modes.find((entry) => entry.mode === mode)?.name ?? (mode === "plan" ? "Plan" : "Default");
}

function availability(
  visible: boolean,
  targetLabel: string | null,
  readEnabled: boolean,
  writeEnabled: boolean,
  readReason: string | null,
  writeReason: string | null
): PlanControlAvailability {
  return Object.freeze({ visible, targetLabel, readEnabled, writeEnabled, readReason, writeReason });
}

function status(
  phase: PlanControlPhase,
  tone: PlanControlTone,
  label: string,
  detail: string | null
): PlanControlStatus {
  return Object.freeze({ phase, tone, label, detail });
}

function failure(input: Omit<PlanControlFailure, "mode"> & Readonly<{ mode?: PlanMode | null }>): PlanControlFailure {
  return deepFreezeExactData({ ...input, mode: input.mode ?? null });
}

function idleOperation(): PlanControlOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingOperation(): PlanControlOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureOperation(failureValue: PlanControlFailure): PlanControlOperation {
  return deepFreezeExactData({ phase: "failure" as const, failure: failureValue });
}

function clearSelectableFailure(operation: PlanControlOperation): PlanControlOperation {
  return operation.phase === "failure" && operation.failure.kind === "known"
    ? idleOperation()
    : operation;
}

function freezeSnapshot(candidate: unknown): PlanControlSnapshot {
  return deepFreezeExactData(planControlSnapshotSchema.parse(candidate));
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseContext(candidate: unknown): PlanControlContext {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 1 ||
    !("snapshot" in candidate)
  ) {
    throw new TypeError("HostDeck plan-control context is invalid.");
  }
  const snapshot = candidate.snapshot;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("HostDeck plan-control snapshot is invalid.");
  }
  return Object.freeze({ snapshot: snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): PlanControlPort {
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
    throw new TypeError("HostDeck plan-control port is invalid.");
  }
  return Object.freeze({
    read: candidate.read as PlanControlPort["read"],
    select: candidate.select as PlanControlPort["select"]
  });
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck Plan operation-id factory is invalid.");
  }
  return candidate as () => string;
}

function hiddenView(sessionId: SessionId): PlanControlView {
  return deepFreezeExactData({
    visible: false,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    sheetOpen: false,
    sessionId,
    targetLabel: null,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Plan control unavailable",
    statusDetail: null,
    catalogObservedAt: null,
    current: null,
    pending: null,
    execution: null,
    modes: [],
    selectedMode: null,
    selectionEnabled: false,
    selectionDisabledReason: "Session details are not available.",
    submitEnabled: false,
    submitLabel: "Set for next turn" as const,
    refreshEnabled: false,
    closeDisabled: false
  });
}

