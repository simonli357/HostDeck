import {
  type ApiErrorEnvelope,
  type GoalControlSnapshot,
  type GoalControlValue,
  type GoalMutationRequest,
  goalControlSnapshotSchema,
  goalMutationRequestSchema,
  goalObjectiveMaxLength,
  type ManagedSessionProjection,
  sessionIdSchema,
  type UncertainGoalMutation
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

export const goalControlPhases = Object.freeze([
  "hidden",
  "closed",
  "loading",
  "ready",
  "no_goal",
  "confirming",
  "submitting",
  "created",
  "updated",
  "paused",
  "resume_accepted",
  "completed",
  "cleared",
  "uncertain_unknown",
  "uncertain_conflict",
  "unsupported",
  "read_failed",
  "mutate_failed",
  "outcome_unknown"
] as const);

export type GoalControlPhase = (typeof goalControlPhases)[number];
export type GoalControlTone = "connected" | "attention" | "danger" | "focus" | "muted";
export type GoalControlAction = GoalMutationRequest["action"];
export type GoalControlConfirmedAction = Extract<GoalControlAction, "resume" | "complete" | "clear">;

export interface GoalControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface GoalControlReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface GoalControlMutateInput {
  readonly sessionId: SessionId;
  readonly request: GoalMutationRequest;
  readonly signal: AbortSignal;
}

export interface GoalControlPort {
  readonly read: (input: GoalControlReadInput) => Promise<unknown>;
  readonly mutate: (input: GoalControlMutateInput) => Promise<unknown>;
}

export interface CreateGoalControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: GoalControlContext;
  readonly port: GoalControlPort;
  readonly createOperationId: () => string;
}

export interface GoalControlCurrentView {
  readonly objective: string;
  readonly status: GoalControlValue["status"];
  readonly statusLabel: string;
  readonly tone: GoalControlTone;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalControlUncertaintyView {
  readonly action: GoalControlAction;
  readonly actionLabel: string;
  readonly phase: UncertainGoalMutation["phase"];
  readonly phaseLabel: string;
  readonly detail: string;
  readonly requestedObjective: string | null;
  readonly requestedStatus: UncertainGoalMutation["requested_status"];
  readonly requestedAt: string;
  readonly tone: GoalControlTone;
}

export interface GoalControlActionView {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
}

export interface GoalControlConfirmationView {
  readonly action: GoalControlConfirmedAction;
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly confirmEnabled: boolean;
  readonly disabledReason: string | null;
  readonly tone: GoalControlTone;
}

export interface GoalControlView {
  readonly visible: boolean;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly sheetOpen: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly phase: GoalControlPhase;
  readonly tone: GoalControlTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly submittingAction: GoalControlAction | null;
  readonly goal: GoalControlCurrentView | null;
  readonly uncertainty: GoalControlUncertaintyView | null;
  readonly observedObjectiveExceedsEditLimit: boolean;
  readonly draft: string;
  readonly draftLength: number;
  readonly draftLimit: number;
  readonly draftEnabled: boolean;
  readonly draftDisabledReason: string | null;
  readonly saveEnabled: boolean;
  readonly saveLabel: "Create paused goal" | "Save paused goal";
  readonly saveDisabledReason: string | null;
  readonly pause: GoalControlActionView;
  readonly resume: GoalControlActionView;
  readonly complete: GoalControlActionView;
  readonly clear: GoalControlActionView;
  readonly actionGuidance: string;
  readonly confirmation: GoalControlConfirmationView | null;
  readonly refreshEnabled: boolean;
  readonly closeDisabled: boolean;
}

export interface GoalControlController {
  readonly snapshot: () => GoalControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: GoalControlContext) => GoalControlView;
  readonly open: () => Promise<GoalControlView>;
  readonly dismiss: () => GoalControlView;
  readonly refresh: () => Promise<GoalControlView>;
  readonly setDraft: (value: string) => GoalControlView;
  readonly save: () => Promise<GoalControlView>;
  readonly pause: () => Promise<GoalControlView>;
  readonly beginConfirmation: (action: GoalControlConfirmedAction) => GoalControlView;
  readonly cancelConfirmation: () => GoalControlView;
  readonly confirmAction: () => Promise<GoalControlView>;
  readonly close: () => GoalControlView;
}

type GoalControlResult = "created" | "updated" | "paused" | "resume_accepted" | "completed" | "cleared";

type GoalControlOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{
      phase: "submitting";
      operationId: string;
      action: GoalControlAction;
      objective: string | null;
      expectedRevision: string | null;
      baselineObjective: string | null;
    }>
  | Readonly<{ phase: "result"; result: GoalControlResult }>
  | Readonly<{ phase: "failure"; failure: GoalControlFailure }>;

interface GoalControlFailure {
  readonly source: "read" | "mutate";
  readonly kind: "known" | "unsupported" | "unknown";
  readonly message: string;
  readonly retryable: boolean;
  readonly requiresRefresh: boolean;
  readonly action: GoalControlAction | null;
}

interface GoalControlAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly readEnabled: boolean;
  readonly writeEnabled: boolean;
  readonly readReason: string | null;
  readonly writeReason: string | null;
  readonly turnState: ManagedSessionProjection["turn_state"] | null;
}

interface GoalControlStatus {
  readonly phase: GoalControlPhase;
  readonly tone: GoalControlTone;
  readonly label: string;
  readonly detail: string | null;
}

const maximumSubscribers = 32;
const activeTurnStates = new Set<ManagedSessionProjection["turn_state"]>([
  "in_progress",
  "waiting_for_approval",
  "waiting_for_input",
  "unknown"
]);
const ambiguousMutationApiCodes = new Set<ApiErrorEnvelope["code"]>([
  "audit_unavailable",
  "incompatible_runtime",
  "internal_error",
  "operation_timeout",
  "protocol_error",
  "runtime_unavailable",
  "stale_session",
  "unknown_error"
]);
const refreshMutationApiCodes = new Set<ApiErrorEnvelope["code"]>([
  "operation_conflict",
  "validation_error"
]);

export function projectGoalControl(input: Readonly<{
  sessionId: SessionId;
  context: GoalControlContext;
  open: boolean;
  data: GoalControlSnapshot | null;
  draft: string;
  confirmation: GoalControlConfirmedAction | null;
  operation: GoalControlOperation;
}>): GoalControlView {
  const sessionId = parseSessionId(input.sessionId);
  const context = parseContext(input.context);
  const data = input.data === null ? null : freezeSnapshot(input.data);
  const draft = parseDraft(input.draft);
  const confirmation = parseConfirmation(input.confirmation);
  const availability = deriveAvailability(context.snapshot, sessionId);
  const sheetOpen = input.open && availability.visible;
  const statusValue = deriveStatus(input.operation, data, availability, sheetOpen, confirmation);
  const goal = data?.goal === null || data === null ? null : projectCurrent(data.goal);
  const uncertainty = data?.uncertain_mutation === null || data === null
    ? null
    : projectUncertainty(data.uncertain_mutation);
  const observedObjectiveExceedsEditLimit =
    data?.goal !== null && data?.goal !== undefined && data.goal.objective.length > goalObjectiveMaxLength;
  const commonReason = commonMutationReason(
    sheetOpen,
    data,
    availability,
    input.operation,
    confirmation
  );
  const draftDisabledReason = draftReason(commonReason, data);
  const saveDisabledReason = saveReason(commonReason, data, draft, availability.turnState);
  const pause = actionView(actionReason("pause", commonReason, data, availability.turnState));
  const resume = actionView(actionReason("resume", commonReason, data, availability.turnState));
  const complete = actionView(actionReason("complete", commonReason, data, availability.turnState));
  const clear = actionView(actionReason("clear", commonReason, data, availability.turnState));
  const confirmationView = confirmation === null
    ? null
    : projectConfirmation(
        confirmation,
        actionReason(confirmation, commonMutationReason(
          sheetOpen,
          data,
          availability,
          input.operation,
          null
        ), data, availability.turnState)
      );

  return deepFreeze({
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
    submittingAction: input.operation.phase === "submitting" ? input.operation.action : null,
    goal,
    uncertainty,
    observedObjectiveExceedsEditLimit,
    draft,
    draftLength: draft.length,
    draftLimit: goalObjectiveMaxLength,
    draftEnabled: draftDisabledReason === null,
    draftDisabledReason,
    saveEnabled: saveDisabledReason === null,
    saveLabel: data?.goal === null ? "Create paused goal" : "Save paused goal",
    saveDisabledReason,
    pause,
    resume,
    complete,
    clear,
    actionGuidance: actionGuidance(data, availability, commonReason),
    confirmation: confirmationView,
    refreshEnabled:
      sheetOpen &&
      availability.readEnabled &&
      input.operation.phase !== "loading" &&
      input.operation.phase !== "submitting",
    closeDisabled: input.operation.phase === "submitting"
  });
}

export function createGoalControlController(
  options: CreateGoalControlControllerOptions
): GoalControlController {
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  let sheetOpen = false;
  let data: GoalControlSnapshot | null = null;
  let draft = "";
  let confirmation: GoalControlConfirmedAction | null = null;
  let operation: GoalControlOperation = idleOperation();
  let sequence = 0;
  let activeRequest: Readonly<{ sequence: number; controller: AbortController }> | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): GoalControlView {
    return projectGoalControl({
      sessionId,
      context,
      open: sheetOpen,
      data,
      draft,
      confirmation,
      operation
    });
  }

  const publish = (): GoalControlView => {
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
    draft = initialDraft(data);
    confirmation = null;
  };

  const runRead = async (): Promise<GoalControlView> => {
    if (closed || !sheetOpen || !currentView.actionEnabled) return currentView;
    cancelActive();
    const requestController = new AbortController();
    const requestSequence = sequence;
    activeRequest = Object.freeze({ sequence: requestSequence, controller: requestController });
    confirmation = null;
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
      draft = "";
      confirmation = null;
      operation = failureOperation(classifyReadFailure(error));
      return publish();
    } finally {
      if (activeRequest?.sequence === requestSequence) activeRequest = null;
    }
  };

  const runMutation = async (
    action: GoalControlAction,
    objective: string | null
  ): Promise<GoalControlView> => {
    if (closed || data === null) return currentView;
    const baselineGoal = data.goal;
    const expectedRevision = baselineGoal?.revision ?? null;
    const baselineObjective = baselineGoal?.objective ?? null;
    let operationId: string;
    let request: GoalMutationRequest;
    try {
      operationId = createOperationId();
      request = goalMutationRequestSchema.parse({
        operation_id: operationId,
        kind: "goal",
        action,
        objective,
        expected_goal_revision: expectedRevision
      });
    } catch {
      operation = failureOperation({
        source: "mutate",
        kind: "known",
        message: "Secure goal control is unavailable. Reload HostDeck.",
        retryable: false,
        requiresRefresh: true,
        action
      });
      return publish();
    }

    cancelActive();
    const requestController = new AbortController();
    const requestSequence = sequence;
    activeRequest = Object.freeze({ sequence: requestSequence, controller: requestController });
    confirmation = null;
    operation = deepFreeze({
      phase: "submitting" as const,
      operationId,
      action,
      objective,
      expectedRevision,
      baselineObjective
    });
    publish();

    try {
      const candidate = await Reflect.apply(port.mutate, undefined, [
        Object.freeze({ sessionId, request, signal: requestController.signal })
      ]);
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      const parsed = goalControlSnapshotSchema.safeParse(candidate);
      const result = parsed.success
        ? correlateMutation(parsed.data, action, objective, expectedRevision, baselineObjective)
        : null;
      if (result === null) {
        operation = failureOperation(unknownMutationFailure(action));
        return publish();
      }
      installSnapshot(parsed.data);
      operation = deepFreeze({ phase: "result" as const, result });
      return publish();
    } catch (error) {
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      operation = failureOperation(classifyMutationFailure(error, action));
      return publish();
    } finally {
      if (activeRequest?.sequence === requestSequence) activeRequest = null;
    }
  };

  const controller: GoalControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck goal-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck goal-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: GoalControlContext): GoalControlView {
      if (closed) throw new TypeError("HostDeck goal control is closed.");
      const previousVisible = currentView.visible;
      const previousOperation = operation;
      context = parseContext(nextContext);
      const nextAvailability = deriveAvailability(context.snapshot, sessionId);
      if (previousVisible && !nextAvailability.visible) {
        cancelActive();
        sheetOpen = false;
        data = null;
        draft = "";
        confirmation = null;
        operation = idleOperation();
      } else if (previousOperation.phase === "loading" && !nextAvailability.readEnabled) {
        cancelActive();
        data = null;
        draft = "";
        confirmation = null;
        operation = failureOperation({
          source: "read",
          kind: "known",
          message: "Session authority is not current. Refresh Session Detail.",
          retryable: false,
          requiresRefresh: true,
          action: null
        });
      } else if (previousOperation.phase === "submitting" && !nextAvailability.writeEnabled) {
        cancelActive();
        confirmation = null;
        operation = failureOperation(unknownMutationFailure(previousOperation.action));
      } else if (
        confirmation !== null &&
        actionReason(
          confirmation,
          commonMutationReason(sheetOpen, data, nextAvailability, operation, null),
          data,
          nextAvailability.turnState
        ) !== null
      ) {
        confirmation = null;
      }
      return publish();
    },
    async open(): Promise<GoalControlView> {
      if (closed || sheetOpen || !currentView.actionEnabled) return currentView;
      sheetOpen = true;
      data = null;
      draft = "";
      confirmation = null;
      operation = idleOperation();
      publish();
      return runRead();
    },
    dismiss(): GoalControlView {
      if (closed || !sheetOpen || currentView.closeDisabled) return currentView;
      cancelActive();
      sheetOpen = false;
      data = null;
      draft = "";
      confirmation = null;
      operation = idleOperation();
      return publish();
    },
    refresh(): Promise<GoalControlView> {
      if (closed || !sheetOpen || !currentView.refreshEnabled) {
        return Promise.resolve(currentView);
      }
      return runRead();
    },
    setDraft(value: string): GoalControlView {
      if (closed || !currentView.draftEnabled || typeof value !== "string") return currentView;
      if (value.length > goalObjectiveMaxLength || draft === value) return currentView;
      draft = value;
      operation = clearRetryableFailure(operation);
      return publish();
    },
    save(): Promise<GoalControlView> {
      if (closed || !currentView.saveEnabled) return Promise.resolve(currentView);
      return runMutation("set", draft.trim());
    },
    pause(): Promise<GoalControlView> {
      if (closed || !currentView.pause.enabled) return Promise.resolve(currentView);
      return runMutation("pause", null);
    },
    beginConfirmation(action: GoalControlConfirmedAction): GoalControlView {
      if (closed || confirmation !== null || !isConfirmedAction(action)) return currentView;
      const actionState = action === "resume"
        ? currentView.resume
        : action === "complete"
          ? currentView.complete
          : currentView.clear;
      if (!actionState.enabled) return currentView;
      confirmation = action;
      operation = clearRetryableFailure(operation);
      return publish();
    },
    cancelConfirmation(): GoalControlView {
      if (closed || confirmation === null || currentView.closeDisabled) return currentView;
      confirmation = null;
      return publish();
    },
    confirmAction(): Promise<GoalControlView> {
      if (closed || confirmation === null || currentView.confirmation?.confirmEnabled !== true) {
        return Promise.resolve(currentView);
      }
      const action = confirmation;
      confirmation = null;
      return runMutation(action, null);
    },
    close(): GoalControlView {
      if (closed) return currentView;
      closed = true;
      cancelActive();
      sheetOpen = false;
      data = null;
      draft = "";
      confirmation = null;
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
): GoalControlAvailability {
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
    return availability(false, null, false, false, "Session details are not available.", null, null);
  }
  const readEnabled = snapshot.access.state === "current" && snapshot.targetState.state === "current";
  const readReason = readEnabled
    ? null
    : "Connection state is not current. Refresh Session Detail before loading the goal.";
  const writeCause = snapshot.writeEligibility.causes[0];
  let writeReason =
    snapshot.writeEligibility.eligible && writeCause === undefined
      ? null
      : writeDisabledReason(writeCause ?? "connection_not_current");
  if (detail.session_state === "archived" || detail.archived_at !== null) {
    writeReason = "Archived sessions cannot change goals.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    writeReason = "Session state is stale. Refresh before changing the goal.";
  }
  return availability(
    true,
    detail.name,
    readEnabled,
    readEnabled && writeReason === null,
    readReason,
    writeReason,
    detail.turn_state
  );
}

function deriveStatus(
  operation: GoalControlOperation,
  data: GoalControlSnapshot | null,
  availability: GoalControlAvailability,
  sheetOpen: boolean,
  confirmation: GoalControlConfirmedAction | null
): GoalControlStatus {
  if (!availability.visible) return status("hidden", "muted", "Goal control unavailable", null);
  if (!sheetOpen) {
    return status(
      "closed",
      availability.readEnabled ? "focus" : "attention",
      "Goal control closed",
      availability.readReason
    );
  }
  if (operation.phase === "loading") {
    return status("loading", "attention", "Loading goal", "Reading the current structured goal state.");
  }
  if (operation.phase === "submitting") {
    return status(
      "submitting",
      "attention",
      submittingLabel(operation.action),
      "Waiting for HostDeck to verify the goal action."
    );
  }
  if (operation.phase === "result") return resultStatus(operation.result);
  if (operation.phase === "failure") {
    if (operation.failure.kind === "unknown") {
      return status("outcome_unknown", "danger", "Goal outcome unknown", operation.failure.message);
    }
    if (operation.failure.kind === "unsupported") {
      return status("unsupported", "attention", "Goal control unsupported", operation.failure.message);
    }
    return status(
      operation.failure.source === "read" ? "read_failed" : "mutate_failed",
      operation.failure.retryable ? "attention" : "danger",
      operation.failure.source === "read" ? "Goal could not be loaded" : "Goal action was not verified",
      operation.failure.message
    );
  }
  if (data === null) {
    return status("ready", "muted", "Goal data unavailable", "Load the current goal state to continue.");
  }
  if (data.uncertain_mutation !== null) {
    return data.uncertain_mutation.phase === "unknown"
      ? status(
          "uncertain_unknown",
          "danger",
          "Prior goal outcome unknown",
          "Refresh after HostDeck reconciles the attempted action. No goal action will be retried."
        )
      : status(
          "uncertain_conflict",
          "danger",
          "Goal reconciliation conflict",
          "Observed goal state conflicts with the attempted action. Goal changes remain locked."
        );
  }
  if (confirmation !== null) {
    const projected = confirmationContent(confirmation);
    return status(
      "confirming",
      projected.tone,
      "Confirmation required",
      "Review this goal action, then confirm or cancel."
    );
  }
  if (data.goal === null) {
    return status("no_goal", "muted", "No goal set", availability.writeReason);
  }
  const current = goalStatus(data.goal.status);
  return status("ready", current.tone, current.label, goalStatusDetail(data.goal.status, availability));
}

function projectCurrent(goal: GoalControlValue): GoalControlCurrentView {
  const current = goalStatus(goal.status);
  return deepFreeze({
    objective: goal.objective,
    status: goal.status,
    statusLabel: current.label,
    tone: current.tone,
    tokenBudget: goal.token_budget,
    tokensUsed: goal.tokens_used,
    timeUsedSeconds: goal.time_used_seconds,
    createdAt: goal.created_at,
    updatedAt: goal.updated_at
  });
}

function projectUncertainty(uncertain: UncertainGoalMutation): GoalControlUncertaintyView {
  const conflict = uncertain.phase === "conflict";
  return deepFreeze({
    action: uncertain.action,
    actionLabel: actionLabel(uncertain.action),
    phase: uncertain.phase,
    phaseLabel: conflict ? "Conflict" : "Outcome unknown",
    detail: conflict
      ? "Observed state contradicts this attempted action."
      : "HostDeck has not reconciled this attempted action.",
    requestedObjective: uncertain.requested_objective,
    requestedStatus: uncertain.requested_status,
    requestedAt: uncertain.requested_at,
    tone: "danger" as const
  });
}

function projectConfirmation(
  action: GoalControlConfirmedAction,
  disabledReason: string | null
): GoalControlConfirmationView {
  const content = confirmationContent(action);
  return deepFreeze({
    action,
    title: content.title,
    detail: content.detail,
    confirmLabel: content.confirmLabel,
    confirmEnabled: disabledReason === null,
    disabledReason,
    tone: content.tone
  });
}

function commonMutationReason(
  sheetOpen: boolean,
  data: GoalControlSnapshot | null,
  availability: GoalControlAvailability,
  operation: GoalControlOperation,
  confirmation: GoalControlConfirmedAction | null
): string | null {
  if (!sheetOpen) return "Open goal control before changing the goal.";
  if (!availability.writeEnabled) return availability.writeReason;
  if (operation.phase === "loading") return "Wait for the current goal state.";
  if (operation.phase === "submitting") return "A goal action is already being verified.";
  if (operation.phase === "failure") {
    if (
      operation.failure.kind === "unknown" ||
      operation.failure.kind === "unsupported" ||
      operation.failure.requiresRefresh ||
      !operation.failure.retryable
    ) {
      return operation.failure.message;
    }
  }
  if (data === null) return "Load the current goal state before changing it.";
  if (data.uncertain_mutation !== null) {
    return data.uncertain_mutation.phase === "unknown"
      ? "A prior goal outcome is unknown. Refresh after HostDeck reconciles it."
      : "A prior goal action conflicts with observed state. Goal changes remain locked.";
  }
  if (confirmation !== null) return "Finish or cancel the current confirmation.";
  return null;
}

function draftReason(
  commonReason: string | null,
  data: GoalControlSnapshot | null
): string | null {
  if (commonReason !== null) return commonReason;
  if (data?.goal?.status === "active") return "Pause the active goal before replacing its objective.";
  return null;
}

function saveReason(
  commonReason: string | null,
  data: GoalControlSnapshot | null,
  draft: string,
  turnState: ManagedSessionProjection["turn_state"] | null
): string | null {
  if (commonReason !== null) return commonReason;
  const goal = data?.goal ?? null;
  if (goal?.status === "active") return "Pause the active goal before replacing its objective.";
  const turnReason = passiveTurnReason(turnState);
  if (turnReason !== null) return turnReason;
  const objective = draft.trim();
  if (objective.length === 0) return "Enter a goal objective before saving.";
  if (objective.length > goalObjectiveMaxLength) {
    return `Goal objectives are limited to ${goalObjectiveMaxLength} characters.`;
  }
  if (goal?.status === "paused" && goal.objective === objective) {
    return "This paused goal objective is already saved.";
  }
  return null;
}

function actionReason(
  action: Exclude<GoalControlAction, "set">,
  commonReason: string | null,
  data: GoalControlSnapshot | null,
  turnState: ManagedSessionProjection["turn_state"] | null
): string | null {
  if (commonReason !== null) return commonReason;
  const goal = data?.goal ?? null;
  if (goal === null) return "Set a goal before using execution actions.";
  switch (action) {
    case "pause":
      if (goal.status === "paused") return "This goal is already paused.";
      if (goal.status === "complete") return "A completed goal cannot be paused.";
      return null;
    case "resume": {
      if (goal.status !== "paused" && goal.status !== "blocked") {
        return "Only a paused or blocked goal can resume agentic work.";
      }
      return passiveTurnReason(turnState);
    }
    case "complete": {
      if (goal.status === "active") return "Pause the active goal before marking it complete.";
      if (goal.status === "complete") return "This goal is already complete.";
      return passiveTurnReason(turnState);
    }
    case "clear":
      if (goal.status === "active") return "Pause the active goal before clearing it.";
      return passiveTurnReason(turnState);
  }
}

function passiveTurnReason(
  turnState: ManagedSessionProjection["turn_state"] | null
): string | null {
  if (turnState === null) return "Session turn state is unavailable. Refresh Session Detail.";
  if (turnState === "unknown") {
    return "Turn state is unknown. Refresh Session Detail before this action.";
  }
  return activeTurnStates.has(turnState)
    ? "Wait for the current turn to settle before this action."
    : null;
}

function actionGuidance(
  data: GoalControlSnapshot | null,
  availability: GoalControlAvailability,
  commonReason: string | null
): string {
  if (commonReason !== null) return commonReason;
  const goal = data?.goal ?? null;
  if (goal === null) return "New and replacement goals are saved paused and start no turn.";
  if (goal.status === "active") {
    return "Pause before replacing, completing, or clearing this goal. Pause does not interrupt the current turn.";
  }
  const turnReason = passiveTurnReason(availability.turnState);
  if (turnReason !== null) return turnReason;
  if (goal.status === "paused" || goal.status === "blocked") {
    return "Resuming can continue agentic work and may start a turn without another prompt.";
  }
  if (goal.status === "usage_limited" || goal.status === "budget_limited") {
    return "This runtime-limited goal cannot resume directly. Pause, replace, complete, or clear it.";
  }
  return "This completed goal can be replaced with a new paused objective or cleared.";
}

function actionView(disabledReason: string | null): GoalControlActionView {
  return Object.freeze({ enabled: disabledReason === null, disabledReason });
}

function goalStatus(statusValue: GoalControlValue["status"]): Readonly<{
  label: string;
  tone: GoalControlTone;
}> {
  switch (statusValue) {
    case "active":
      return Object.freeze({ label: "Active", tone: "connected" as const });
    case "paused":
      return Object.freeze({ label: "Paused", tone: "focus" as const });
    case "blocked":
      return Object.freeze({ label: "Blocked", tone: "attention" as const });
    case "usage_limited":
      return Object.freeze({ label: "Usage limited", tone: "danger" as const });
    case "budget_limited":
      return Object.freeze({ label: "Budget limited", tone: "danger" as const });
    case "complete":
      return Object.freeze({ label: "Complete", tone: "connected" as const });
  }
}

function goalStatusDetail(
  statusValue: GoalControlValue["status"],
  availability: GoalControlAvailability
): string | null {
  if (availability.writeReason !== null) return availability.writeReason;
  switch (statusValue) {
    case "active":
      return "Active goals can continue agentic work. Pause does not interrupt the current turn.";
    case "paused":
      return "The goal is paused and will not start new agentic work until confirmed resume.";
    case "blocked":
      return "The runtime blocked this goal. A confirmed resume may retry agentic work when the turn is idle.";
    case "usage_limited":
      return "The runtime reports that goal execution reached a usage limit.";
    case "budget_limited":
      return "The runtime reports that goal execution reached its budget limit.";
    case "complete":
      return "The runtime reports this goal complete.";
  }
}

function confirmationContent(action: GoalControlConfirmedAction): Readonly<{
  title: string;
  detail: string;
  confirmLabel: string;
  tone: GoalControlTone;
}> {
  switch (action) {
    case "resume":
      return Object.freeze({
        title: "Resume agentic goal?",
        detail: "Codex may continue work and start a turn without another prompt. Acceptance is not proof that a turn started.",
        confirmLabel: "Resume goal",
        tone: "attention" as const
      });
    case "complete":
      return Object.freeze({
        title: "Mark goal complete?",
        detail: "This marks the goal complete. It does not interrupt, archive, or delete the thread.",
        confirmLabel: "Mark complete",
        tone: "attention" as const
      });
    case "clear":
      return Object.freeze({
        title: "Clear this goal?",
        detail: "This removes the goal objective and goal state. Thread history remains unchanged.",
        confirmLabel: "Clear goal",
        tone: "danger" as const
      });
  }
}

function correlateMutation(
  response: GoalControlSnapshot,
  action: GoalControlAction,
  objective: string | null,
  expectedRevision: string | null,
  baselineObjective: string | null
): GoalControlResult | null {
  if (response.uncertain_mutation !== null) return null;
  if (action === "clear") return response.goal === null ? "cleared" : null;
  const goal = response.goal;
  if (goal === null) return null;
  if (action === "set") {
    if (objective === null || goal.objective !== objective || goal.status !== "paused") return null;
    if (expectedRevision !== null && goal.revision === expectedRevision) return null;
    return expectedRevision === null ? "created" : "updated";
  }
  if (
    expectedRevision === null ||
    baselineObjective === null ||
    goal.objective !== baselineObjective ||
    goal.revision === expectedRevision
  ) {
    return null;
  }
  if (action === "pause") return goal.status === "paused" ? "paused" : null;
  if (action === "resume") return goal.status === "active" ? "resume_accepted" : null;
  return goal.status === "complete" ? "completed" : null;
}

function classifyReadFailure(error: unknown): GoalControlFailure {
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
          ? "HostDeck closed before the goal could be loaded. Reload to continue."
          : "Session authority is not current. Refresh Session Detail.",
      retryable: false,
      requiresRefresh: true
    });
  }
  return failure({
    source: "read",
    kind: "known",
    message: "The structured goal could not be loaded. Check the connection and try again.",
    retryable: true,
    requiresRefresh: false
  });
}

function classifyMutationFailure(
  error: unknown,
  action: GoalControlAction
): GoalControlFailure {
  if (error instanceof HostDeckBrowserConnectionError) {
    return failure({
      source: "mutate",
      kind: "known",
      message: "Goal authority is not current. Refresh Session Detail.",
      retryable: false,
      requiresRefresh: true,
      action
    });
  }
  if (error instanceof HostDeckBrowserCsrfError) {
    if (error.apiError !== null) {
      const code = error.apiError.code;
      if (
        ambiguousMutationApiCodes.has(code) ||
        (code === "operation_conflict" && !error.apiError.retryable)
      ) {
        return unknownMutationFailure(action);
      }
      const unsupported = code === "capability_unavailable";
      const requiresRefresh = refreshMutationApiCodes.has(code);
      return failure({
        source: "mutate",
        kind: unsupported ? "unsupported" : "known",
        message: apiFailureMessage(error.apiError, "mutate"),
        retryable: !unsupported && !requiresRefresh && error.apiError.retryable,
        requiresRefresh,
        action
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
        source: "mutate",
        kind: "known",
        message: "Secure goal authority is not ready. Refresh Session Detail.",
        retryable: false,
        requiresRefresh: true,
        action
      });
    }
  }
  return unknownMutationFailure(action);
}

function unknownMutationFailure(action: GoalControlAction): GoalControlFailure {
  return failure({
    source: "mutate",
    kind: "unknown",
    message: "Check current goal state before another action. HostDeck will not retry automatically.",
    retryable: false,
    requiresRefresh: true,
    action
  });
}

function apiFailureMessage(error: ApiErrorEnvelope, operation: "read" | "mutate"): string {
  switch (error.code) {
    case "session_not_found":
      return "This session no longer exists.";
    case "session_not_writable":
      return "This session cannot change its goal now.";
    case "stale_session":
      return "Session state changed during goal control. Check current state before continuing.";
    case "host_locked":
      return hostLockWriteReason("host_locked");
    case "permission_denied":
    case "read_only":
      return operation === "read"
        ? "This phone cannot read goal state."
        : "This phone has read-only access to goal state.";
    case "runtime_unavailable":
      return "The Codex runtime is unavailable. Check the laptop and refresh.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The installed Codex runtime does not support structured goal control.";
    case "operation_conflict":
      return "Goal state changed or this action conflicts with current execution. Refresh before continuing.";
    case "operation_timeout":
      return "HostDeck could not prove the goal-action outcome.";
    case "rate_limited":
      return "Goal requests are temporarily rate limited.";
    case "service_overloaded":
      return "HostDeck is temporarily too busy for this goal action.";
    case "audit_unavailable":
      return "HostDeck could not prove the audited goal outcome.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure goal access was rejected.";
    case "validation_error":
      return "Goal state changed. Refresh before continuing.";
    default:
      return operation === "read"
        ? "HostDeck could not read goal state."
        : "HostDeck could not verify the goal action.";
  }
}

function resultStatus(result: GoalControlResult): GoalControlStatus {
  switch (result) {
    case "created":
      return status("created", "connected", "Paused goal created", "No turn was started.");
    case "updated":
      return status("updated", "connected", "Paused goal saved", "The objective was verified without starting a turn.");
    case "paused":
      return status("paused", "connected", "Goal paused", "The current turn was not interrupted.");
    case "resume_accepted":
      return status(
        "resume_accepted",
        "attention",
        "Goal resume accepted",
        "Turn start and progress remain authoritative in the timeline."
      );
    case "completed":
      return status("completed", "connected", "Goal marked complete", "Thread history remains unchanged.");
    case "cleared":
      return status("cleared", "connected", "Goal cleared", "Thread history remains unchanged.");
  }
}

function submittingLabel(action: GoalControlAction): string {
  switch (action) {
    case "set":
      return "Saving paused goal";
    case "pause":
      return "Pausing goal";
    case "resume":
      return "Submitting goal resume";
    case "complete":
      return "Marking goal complete";
    case "clear":
      return "Clearing goal";
  }
}

function actionLabel(action: GoalControlAction): string {
  switch (action) {
    case "set":
      return "Save paused goal";
    case "pause":
      return "Pause goal";
    case "resume":
      return "Resume goal";
    case "complete":
      return "Mark goal complete";
    case "clear":
      return "Clear goal";
  }
}

function initialDraft(data: GoalControlSnapshot): string {
  const objective = data.goal?.objective ?? "";
  return objective.length <= goalObjectiveMaxLength ? objective : "";
}

function writeDisabledReason(cause: BrowserConnectionWriteBlockCause): string {
  switch (cause) {
    case "connection_not_current":
      return "Connection state is not current. Refresh before changing the goal.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied":
      return "Pair this phone again to change the goal.";
    case "read_only_access":
      return "Read-only access cannot change the goal.";
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

function availability(
  visible: boolean,
  targetLabel: string | null,
  readEnabled: boolean,
  writeEnabled: boolean,
  readReason: string | null,
  writeReason: string | null,
  turnState: ManagedSessionProjection["turn_state"] | null
): GoalControlAvailability {
  return Object.freeze({
    visible,
    targetLabel,
    readEnabled,
    writeEnabled,
    readReason,
    writeReason,
    turnState
  });
}

function status(
  phase: GoalControlPhase,
  tone: GoalControlTone,
  label: string,
  detail: string | null
): GoalControlStatus {
  return Object.freeze({ phase, tone, label, detail });
}

function failure(input: Omit<GoalControlFailure, "action"> & Readonly<{
  action?: GoalControlAction | null;
}>): GoalControlFailure {
  return deepFreeze({ ...input, action: input.action ?? null });
}

function idleOperation(): GoalControlOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingOperation(): GoalControlOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureOperation(failureValue: GoalControlFailure): GoalControlOperation {
  return deepFreeze({ phase: "failure" as const, failure: failureValue });
}

function clearRetryableFailure(operation: GoalControlOperation): GoalControlOperation {
  return operation.phase === "failure" && operation.failure.kind === "known" && operation.failure.retryable
    ? idleOperation()
    : operation;
}

function freezeSnapshot(candidate: unknown): GoalControlSnapshot {
  return deepFreeze(goalControlSnapshotSchema.parse(candidate));
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseContext(candidate: unknown): GoalControlContext {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 1 ||
    !("snapshot" in candidate)
  ) {
    throw new TypeError("HostDeck goal-control context is invalid.");
  }
  const snapshot = candidate.snapshot;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("HostDeck goal-control snapshot is invalid.");
  }
  return Object.freeze({ snapshot: snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): GoalControlPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 2 ||
    !("read" in candidate) ||
    typeof candidate.read !== "function" ||
    !("mutate" in candidate) ||
    typeof candidate.mutate !== "function"
  ) {
    throw new TypeError("HostDeck goal-control port is invalid.");
  }
  return Object.freeze({
    read: candidate.read as GoalControlPort["read"],
    mutate: candidate.mutate as GoalControlPort["mutate"]
  });
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck goal operation-id factory is invalid.");
  }
  return candidate as () => string;
}

function parseDraft(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length > goalObjectiveMaxLength) {
    throw new TypeError("HostDeck goal draft is invalid.");
  }
  return candidate;
}

function parseConfirmation(candidate: unknown): GoalControlConfirmedAction | null {
  if (candidate === null) return null;
  if (!isConfirmedAction(candidate)) {
    throw new TypeError("HostDeck goal confirmation is invalid.");
  }
  return candidate;
}

function isConfirmedAction(candidate: unknown): candidate is GoalControlConfirmedAction {
  return candidate === "resume" || candidate === "complete" || candidate === "clear";
}

function hiddenView(sessionId: SessionId): GoalControlView {
  const unavailable = actionView("Session details are not available.");
  return deepFreeze({
    visible: false,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    sheetOpen: false,
    sessionId,
    targetLabel: null,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Goal control unavailable",
    statusDetail: null,
    submittingAction: null,
    goal: null,
    uncertainty: null,
    observedObjectiveExceedsEditLimit: false,
    draft: "",
    draftLength: 0,
    draftLimit: goalObjectiveMaxLength,
    draftEnabled: false,
    draftDisabledReason: "Session details are not available.",
    saveEnabled: false,
    saveLabel: "Create paused goal" as const,
    saveDisabledReason: "Session details are not available.",
    pause: unavailable,
    resume: unavailable,
    complete: unavailable,
    clear: unavailable,
    actionGuidance: "Session details are not available.",
    confirmation: null,
    refreshEnabled: false,
    closeDisabled: false
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
