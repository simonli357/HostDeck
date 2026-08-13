import {
  type ApiErrorEnvelope,
  type InterruptRequest,
  interruptRequestSchema,
  interruptResponseSchema,
  replayBoundaryReasonSchema,
  type SelectedProjectionEvent,
  selectedEventPageMaxSize,
  selectedProjectionEventSchema,
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
import type { SessionDetailContinuityBoundary } from "./session-detail-feed.js";

export const interruptControlPhases = Object.freeze([
  "hidden",
  "closed",
  "unavailable",
  "ready",
  "confirming",
  "submitting",
  "confirmed_interrupted",
  "feed_interrupted",
  "not_interrupted",
  "blocked",
  "outcome_unknown",
  "inconsistent"
] as const);

export type InterruptControlPhase = (typeof interruptControlPhases)[number];
export type InterruptControlTone = "connected" | "attention" | "danger" | "focus" | "muted";
export type InterruptActiveState = "in_progress" | "waiting_for_input" | "waiting_for_approval";
export type InterruptResultKind =
  | "confirmed_interrupted"
  | "feed_interrupted"
  | "not_interrupted"
  | "blocked"
  | "outcome_unknown"
  | "inconsistent";

export interface InterruptControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
  readonly events: readonly SelectedProjectionEvent[];
  readonly boundary: SessionDetailContinuityBoundary | null;
}

export interface InterruptSubmitInput {
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly request: InterruptRequest;
  readonly signal: AbortSignal;
}

export interface InterruptControlPort {
  readonly interrupt: (input: InterruptSubmitInput) => Promise<unknown>;
}

export interface CreateInterruptControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: InterruptControlContext;
  readonly port: InterruptControlPort;
  readonly createOperationId: () => string;
}

export interface InterruptTargetView {
  readonly sessionLabel: string;
  readonly turnId: string;
  readonly state: InterruptActiveState;
  readonly stateLabel: string;
}

export interface InterruptResultView {
  readonly kind: InterruptResultKind;
  readonly source: "api" | "feed" | "browser";
  readonly label: string;
  readonly detail: string;
  readonly terminalState: "interrupted" | "completed" | "failed" | null;
  readonly updatedAt: string | null;
}

export interface InterruptControlView {
  readonly visible: boolean;
  readonly sheetOpen: boolean;
  readonly phase: InterruptControlPhase;
  readonly tone: InterruptControlTone;
  readonly title: string;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly targetLabel: string | null;
  readonly target: InterruptTargetView | null;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly confirmationOpen: boolean;
  readonly confirmEnabled: boolean;
  readonly busy: boolean;
  readonly closeDisabled: boolean;
  readonly resultOpen: boolean;
  readonly result: InterruptResultView | null;
}

export interface InterruptControlController {
  readonly snapshot: () => InterruptControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: InterruptControlContext) => InterruptControlView;
  readonly open: () => InterruptControlView;
  readonly beginConfirmation: () => InterruptControlView;
  readonly cancelConfirmation: () => InterruptControlView;
  readonly confirm: () => Promise<InterruptControlView>;
  readonly acknowledgeResult: () => InterruptControlView;
  readonly dismiss: () => InterruptControlView;
  readonly close: () => InterruptControlView;
}

interface InterruptExactTarget {
  readonly sessionId: SessionId;
  readonly sessionLabel: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runtimeSource: string;
  readonly runtimeVersion: string;
  readonly createdAt: string;
  readonly state: InterruptActiveState;
  readonly evidenceCursor: number;
  readonly targetKey: string;
}

interface InterruptAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly authorityKey: string | null;
  readonly target: InterruptExactTarget | null;
  readonly actionEnabled: boolean;
  readonly reason: string | null;
}

interface InterruptAttempt {
  readonly sequence: number;
  readonly operationId: string;
  readonly target: InterruptExactTarget;
  readonly authorityKey: string;
  readonly baselineCursor: number;
  readonly controller: AbortController;
  readonly reconcilable: boolean;
  phase: "submitting" | "settled";
  acknowledged: boolean;
  evidenceInvalidated: boolean;
  result: InterruptResultView | null;
}

type InterruptObservation =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "boundary" }>
  | Readonly<{ kind: "invalidated" }>
  | Readonly<{ kind: "inconsistent" }>
  | Readonly<{
      kind: "terminal";
      state: "interrupted" | "completed" | "failed";
      capturedAt: string;
    }>;

const maximumSubscribers = 32;
const activeTurnStates = new Set<InterruptActiveState>([
  "in_progress",
  "waiting_for_input",
  "waiting_for_approval"
]);
const terminalTurnStates = new Set(["interrupted", "completed", "failed"] as const);

export function createInterruptControlController(
  candidateOptions: CreateInterruptControlControllerOptions
): InterruptControlController {
  const options = parseCreateOptions(candidateOptions);
  const sessionId = sessionIdSchema.parse(options.sessionId) as SessionId;
  let context = parseContext(options.context, sessionId);
  const port = parsePort(options.port);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  let sheetOpen = false;
  let confirmationTarget: InterruptExactTarget | null = null;
  let confirmationAuthorityKey: string | null = null;
  let attempt: InterruptAttempt | null = null;
  let activePromise: Promise<InterruptControlView> | null = null;
  let sequence = 0;
  let closed = false;
  const subscribers = new Set<() => void>();
  const attemptedTurnIds = new Set<string>();
  let currentView = project();

  function project(): InterruptControlView {
    if (closed) return hiddenView();
    const availability = deriveAvailability(context, sessionId);
    const attemptedCurrentTarget =
      availability.target !== null && attemptedTurnIds.has(availability.target.turnId);
    const waitingForPriorResult =
      attempt !== null &&
      attempt.phase === "settled" &&
      !attempt.acknowledged &&
      !attemptedCurrentTarget;
    const actionEnabled =
      availability.actionEnabled &&
      !attemptedCurrentTarget &&
      !waitingForPriorResult &&
      attempt?.phase !== "submitting";
    const actionDisabledReason = actionEnabled
      ? null
      : attempt?.phase === "submitting"
        ? "One interrupt request is already waiting for a confirmed result."
        : attemptedCurrentTarget
          ? "An interrupt was already submitted for this exact turn."
          : waitingForPriorResult
            ? "Review the prior interrupt result before acting on another turn."
            : availability.reason;
    const resultOpen =
      sheetOpen && attempt?.phase === "settled" && !attempt.acknowledged;
    const target = !availability.visible
      ? null
      : attempt !== null && (attempt.phase === "submitting" || resultOpen)
        ? attempt.target
        : confirmationTarget ?? availability.target;
    const statusValue = deriveStatus({
      availability,
      actionEnabled,
      actionDisabledReason,
      attempt,
      confirmationOpen: confirmationTarget !== null,
      resultOpen,
      sheetOpen
    });

    return deepFreeze({
      visible: availability.visible,
      sheetOpen: sheetOpen && availability.visible,
      phase: statusValue.phase,
      tone: statusValue.tone,
      title: statusValue.title,
      status: statusValue.status,
      statusDetail: statusValue.detail,
      targetLabel: availability.targetLabel,
      target: target === null ? null : targetView(target),
      actionEnabled,
      actionDisabledReason,
      confirmationOpen: sheetOpen && confirmationTarget !== null,
      confirmEnabled:
        sheetOpen &&
        confirmationTarget !== null &&
        confirmationStillCurrent(availability) &&
        attempt?.phase !== "submitting",
      busy: attempt?.phase === "submitting",
      closeDisabled: attempt?.phase === "submitting",
      resultOpen,
      result: availability.visible ? attempt?.result ?? null : null
    });
  }

  const publish = (): InterruptControlView => {
    currentView = project();
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  function confirmationStillCurrent(availability: InterruptAvailability): boolean {
    return confirmationTarget !== null &&
      confirmationAuthorityKey !== null &&
      availability.actionEnabled &&
      availability.target?.targetKey === confirmationTarget.targetKey &&
      availability.authorityKey === confirmationAuthorityKey;
  }

  function reconcileSettledAttempt(): void {
    if (attempt === null || attempt.phase !== "settled" || !attempt.reconcilable) return;
    if (attempt.result?.kind === "inconsistent") return;
    const observation = observeAttempt(context, attempt);
    if (observation.kind === "none" || observation.kind === "boundary") return;
    if (observation.kind === "invalidated") {
      attempt.result = attempt.result?.kind === "confirmed_interrupted"
        ? inconsistentResult()
        : outcomeUnknownResult();
      return;
    }
    if (observation.kind === "inconsistent") {
      attempt.result = inconsistentResult();
      return;
    }
    if (attempt.result?.kind === "confirmed_interrupted") {
      if (observation.state !== "interrupted") attempt.result = inconsistentResult();
      return;
    }
    attempt.result = resultFromObservation(observation);
  }

  const controller: InterruptControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck interrupt-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck interrupt-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: InterruptControlContext): InterruptControlView {
      if (closed) throw new TypeError("HostDeck interrupt control is closed.");
      const parsedContext = parseContext(nextContext, sessionId);
      if (
        attempt?.reconcilable &&
        !attemptHasTerminalProof(attempt) &&
        (latestContextCursor(parsedContext) < latestContextCursor(context) ||
          attemptTargetIdentityChanged(parsedContext, attempt.target) ||
          attemptTargetReplacedWithoutTerminalProof(parsedContext, attempt))
      ) {
        attempt.evidenceInvalidated = true;
      }
      context = parsedContext;
      const availability = deriveAvailability(context, sessionId);
      if (confirmationTarget !== null && !confirmationStillCurrent(availability)) {
        confirmationTarget = null;
        confirmationAuthorityKey = null;
      }
      reconcileSettledAttempt();
      return publish();
    },
    open(): InterruptControlView {
      if (closed || sheetOpen || !currentView.visible) return currentView;
      sheetOpen = true;
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      return publish();
    },
    beginConfirmation(): InterruptControlView {
      if (closed || !sheetOpen || !currentView.actionEnabled) return currentView;
      const availability = deriveAvailability(context, sessionId);
      if (
        !availability.actionEnabled ||
        availability.target === null ||
        availability.authorityKey === null
      ) {
        return publish();
      }
      confirmationTarget = availability.target;
      confirmationAuthorityKey = availability.authorityKey;
      return publish();
    },
    cancelConfirmation(): InterruptControlView {
      if (closed || confirmationTarget === null || attempt?.phase === "submitting") {
        return currentView;
      }
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      return publish();
    },
    confirm(): Promise<InterruptControlView> {
      if (activePromise !== null) return activePromise;
      if (closed || !sheetOpen || confirmationTarget === null) {
        return Promise.resolve(currentView);
      }
      const availability = deriveAvailability(context, sessionId);
      if (!confirmationStillCurrent(availability) || availability.target === null) {
        confirmationTarget = null;
        confirmationAuthorityKey = null;
        return Promise.resolve(publish());
      }

      let operationId: string;
      let request: InterruptRequest;
      try {
        operationId = createOperationId();
        request = interruptRequestSchema.parse({
          operation_id: operationId,
          kind: "interrupt",
          confirm: true
        });
      } catch {
        sequence += 1;
        attempt = {
          sequence,
          operationId: "",
          target: availability.target,
          authorityKey: availability.authorityKey as string,
          baselineCursor: latestContextCursor(context),
          controller: new AbortController(),
          reconcilable: false,
          phase: "settled",
          acknowledged: false,
          evidenceInvalidated: false,
          result: setupFailureResult()
        };
        attemptedTurnIds.add(availability.target.turnId);
        confirmationTarget = null;
        confirmationAuthorityKey = null;
        return Promise.resolve(publish());
      }

      const requestController = new AbortController();
      sequence += 1;
      const currentSequence = sequence;
      attempt = {
        sequence: currentSequence,
        operationId,
        target: availability.target,
        authorityKey: availability.authorityKey as string,
        baselineCursor: latestContextCursor(context),
        controller: requestController,
        reconcilable: true,
        phase: "submitting",
        acknowledged: false,
        evidenceInvalidated: false,
        result: null
      };
      attemptedTurnIds.add(availability.target.turnId);
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      publish();

      const pending = runInterruptAttempt(attempt, request);
      activePromise = pending;
      return pending;
    },
    acknowledgeResult(): InterruptControlView {
      if (closed || attempt === null || attempt.phase !== "settled") return currentView;
      attempt.acknowledged = true;
      return publish();
    },
    dismiss(): InterruptControlView {
      if (closed || !sheetOpen || attempt?.phase === "submitting") return currentView;
      if (attempt?.phase === "settled") attempt.acknowledged = true;
      sheetOpen = false;
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      return publish();
    },
    close(): InterruptControlView {
      if (closed) return currentView;
      closed = true;
      sequence += 1;
      attempt?.controller.abort();
      activePromise = null;
      sheetOpen = false;
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      subscribers.clear();
      currentView = hiddenView();
      return currentView;
    }
  });

  async function runInterruptAttempt(
    activeAttempt: InterruptAttempt,
    request: InterruptRequest
  ): Promise<InterruptControlView> {
    try {
      const response = await Promise.resolve().then(() =>
        Reflect.apply(port.interrupt, undefined, [
          Object.freeze({
            sessionId,
            turnId: activeAttempt.target.turnId,
            request,
            signal: activeAttempt.controller.signal
          })
        ])
      );
      if (closed || attempt !== activeAttempt || activeAttempt.sequence !== sequence) {
        return currentView;
      }
      activeAttempt.result = validateSuccess(response, activeAttempt);
      const observation = observeAttempt(context, activeAttempt);
      if (
        observation.kind === "invalidated" ||
        observation.kind === "inconsistent" ||
        (observation.kind === "terminal" && observation.state !== "interrupted")
      ) {
        activeAttempt.result = inconsistentResult();
      }
    } catch (error) {
      if (closed || attempt !== activeAttempt || activeAttempt.sequence !== sequence) {
        return currentView;
      }
      const observation = observeAttempt(context, activeAttempt);
      activeAttempt.result = observation.kind === "terminal"
        ? resultFromObservation(observation)
        : observation.kind === "inconsistent"
          ? inconsistentResult()
          : observation.kind === "invalidated"
            ? outcomeUnknownResult()
            : classifyAttemptFailure(error);
    } finally {
      if (!closed && attempt === activeAttempt && activeAttempt.sequence === sequence) {
        activeAttempt.phase = "settled";
        activePromise = null;
      }
    }
    return closed ? currentView : publish();
  }

  return controller;
}

function deriveAvailability(
  context: InterruptControlContext,
  sessionId: SessionId
): InterruptAvailability {
  const snapshot = context.snapshot;
  const detail = matchingSession(snapshot, sessionId);
  const visible =
    detail !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null) {
    return availability(false, null, null, null, false, "Session details are not available.");
  }

  let reason: string | null = null;
  if (detail.archived_at !== null || detail.session_state === "archived") {
    reason = "Archived sessions cannot interrupt a turn.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    reason = "Session state is stale. Refresh Session Detail before interrupting.";
  } else if (snapshot.access.state !== "current" || snapshot.targetState.state !== "current") {
    reason = "Connection state is not current. Refresh Session Detail before interrupting.";
  } else if (snapshot.stream.state !== "connected") {
    reason = snapshot.stream.state === "failed"
      ? "Live session activity is unavailable. Refresh before interrupting."
      : "Live session activity is reconnecting. Wait for current activity before interrupting.";
  } else if (snapshot.stream.continuity !== "contiguous" && snapshot.stream.continuity !== "boundary") {
    reason = "Session activity continuity is not proven yet.";
  } else if (!activeTurnStates.has(detail.turn_state as InterruptActiveState)) {
    reason = inactiveTurnReason(detail.turn_state);
  }

  const evidence = reason === null
    ? deriveExactTarget(context, sessionId, detail)
    : Object.freeze({ target: null, reason: null });
  if (reason === null && evidence.target === null) reason = evidence.reason;

  const authorityKey = writeAuthorityKey(snapshot);
  if (reason === null) {
    reason = writeEligibilityReason(snapshot.writeEligibility.causes[0]);
  }
  if (reason === null && !snapshot.writeEligibility.eligible) {
    reason = "Secure write access is not ready.";
  }
  if (reason === null && authorityKey === null) {
    reason = "Current interrupt access is not available.";
  }

  return availability(
    true,
    detail.name,
    authorityKey,
    evidence.target,
    reason === null && evidence.target !== null && authorityKey !== null,
    reason
  );
}

function deriveExactTarget(
  context: InterruptControlContext,
  sessionId: SessionId,
  detail: NonNullable<ReturnType<typeof matchingSession>>
): Readonly<{ target: InterruptExactTarget | null; reason: string | null }> {
  const boundaryCursor = latestBoundaryCursor(context);
  const latestByTurn = new Map<string, Extract<SelectedProjectionEvent, { readonly type: "turn" }>>();
  for (const event of context.events) {
    if (event.type !== "turn" || event.cursor <= boundaryCursor) continue;
    latestByTurn.set(event.turn_id, event);
  }
  const active = [...latestByTurn.values()].filter((event) =>
    activeTurnStates.has(event.state as InterruptActiveState)
  );
  if (active.length === 0) {
    return Object.freeze({
      target: null,
      reason: latestByTurn.size === 0
        ? "Exact active-turn evidence is not retained. Refresh and wait for current activity."
        : "Retained turn activity does not prove the projected active turn. Refresh before interrupting."
    });
  }
  if (active.length !== 1) {
    return Object.freeze({
      target: null,
      reason: "Retained activity contains more than one active turn. Refresh before interrupting."
    });
  }
  const event = active[0];
  if (event === undefined || event.state !== detail.turn_state) {
    return Object.freeze({
      target: null,
      reason: "Projected and retained active-turn states do not match. Refresh before interrupting."
    });
  }
  const targetKey = JSON.stringify([
    sessionId,
    detail.codex_thread_id,
    detail.runtime_source,
    detail.runtime_version,
    detail.created_at,
    event.turn_id
  ]);
  return Object.freeze({
    target: Object.freeze({
      sessionId,
      sessionLabel: detail.name,
      threadId: detail.codex_thread_id,
      turnId: event.turn_id,
      runtimeSource: detail.runtime_source,
      runtimeVersion: detail.runtime_version,
      createdAt: detail.created_at,
      state: event.state as InterruptActiveState,
      evidenceCursor: event.cursor,
      targetKey
    }),
    reason: null
  });
}

function attemptHasTerminalProof(attempt: InterruptAttempt): boolean {
  return attempt.result?.terminalState !== null && attempt.result?.terminalState !== undefined;
}

function attemptTargetIdentityChanged(
  context: InterruptControlContext,
  target: InterruptExactTarget
): boolean {
  const detail = matchingSession(context.snapshot, target.sessionId);
  return detail !== null && (
    detail.codex_thread_id !== target.threadId ||
    detail.runtime_source !== target.runtimeSource ||
    detail.runtime_version !== target.runtimeVersion ||
    detail.created_at !== target.createdAt
  );
}

function attemptTargetReplacedWithoutTerminalProof(
  context: InterruptControlContext,
  attempt: InterruptAttempt
): boolean {
  if (latestBoundaryCursor(context) > attempt.baselineCursor) return false;
  const hasExactTerminal = context.events.some((event) =>
    event.type === "turn" &&
    event.turn_id === attempt.target.turnId &&
    event.cursor > attempt.baselineCursor &&
    terminalTurnStates.has(event.state as "interrupted" | "completed" | "failed")
  );
  if (hasExactTerminal) return false;
  const detail = matchingSession(context.snapshot, attempt.target.sessionId);
  if (detail === null || !activeTurnStates.has(detail.turn_state as InterruptActiveState)) {
    return false;
  }
  const replacement = deriveExactTarget(context, attempt.target.sessionId, detail).target;
  return replacement !== null && replacement.turnId !== attempt.target.turnId;
}

function observeAttempt(
  context: InterruptControlContext,
  attempt: InterruptAttempt
): InterruptObservation {
  if (!attempt.reconcilable) return Object.freeze({ kind: "none" as const });
  if (attempt.evidenceInvalidated) {
    return Object.freeze({ kind: "invalidated" as const });
  }
  if (latestBoundaryCursor(context) > attempt.baselineCursor) {
    return Object.freeze({ kind: "boundary" as const });
  }
  const events = context.events.filter(
    (event): event is Extract<SelectedProjectionEvent, { readonly type: "turn" }> =>
      event.type === "turn" &&
      event.turn_id === attempt.target.turnId &&
      event.cursor > attempt.baselineCursor
  );
  if (events.length === 0) return Object.freeze({ kind: "none" as const });
  const terminals = events.filter((event) => terminalTurnStates.has(
    event.state as "interrupted" | "completed" | "failed"
  ));
  const terminalStates = new Set(terminals.map((event) => event.state));
  const latest = events.at(-1);
  if (
    terminals.length > 1 ||
    terminalStates.size > 1 ||
    (terminals.length > 0 && latest !== undefined && !terminalTurnStates.has(
      latest.state as "interrupted" | "completed" | "failed"
    ))
  ) {
    return Object.freeze({ kind: "inconsistent" as const });
  }
  const terminal = terminals.at(-1);
  if (terminal === undefined) return Object.freeze({ kind: "none" as const });
  return Object.freeze({
    kind: "terminal" as const,
    state: terminal.state as "interrupted" | "completed" | "failed",
    capturedAt: terminal.captured_at
  });
}

function validateSuccess(candidate: unknown, attempt: InterruptAttempt): InterruptResultView {
  const response = interruptResponseSchema.parse(candidate);
  if (
    response.operation_id !== attempt.operationId ||
    response.target.session_id !== attempt.target.sessionId ||
    response.target.codex_thread_id !== attempt.target.threadId ||
    response.target.turn_id !== attempt.target.turnId ||
    response.turn_id !== attempt.target.turnId
  ) {
    throw new TypeError("HostDeck interrupt response target is invalid.");
  }
  return deepFreeze({
    kind: "confirmed_interrupted" as const,
    source: "api" as const,
    label: "Turn interrupted",
    detail: "HostDeck confirmed this exact turn ended as interrupted.",
    terminalState: "interrupted" as const,
    updatedAt: response.updated_at
  });
}

function resultFromObservation(
  observation: Extract<InterruptObservation, { readonly kind: "terminal" }>
): InterruptResultView {
  if (observation.state === "interrupted") {
    return deepFreeze({
      kind: "feed_interrupted" as const,
      source: "feed" as const,
      label: "Turn ended as interrupted",
      detail: "Session activity confirms interruption. The request receipt was not returned, and HostDeck did not resend it.",
      terminalState: "interrupted" as const,
      updatedAt: observation.capturedAt
    });
  }
  const failed = observation.state === "failed";
  return deepFreeze({
    kind: "not_interrupted" as const,
    source: "feed" as const,
    label: failed ? "Turn failed" : "Turn completed",
    detail: failed
      ? "Session activity confirms this turn failed without a confirmed interrupt result."
      : "Session activity confirms this turn completed without a confirmed interrupt result.",
    terminalState: observation.state,
    updatedAt: observation.capturedAt
  });
}

function classifyAttemptFailure(error: unknown): InterruptResultView {
  const apiError = browserApiError(error);
  if (
    apiError !== null &&
    ["permission_denied", "read_only", "host_locked", "invalid_origin", "insecure_transport"].includes(apiError.code)
  ) {
    return deepFreeze({
      kind: "blocked" as const,
      source: "browser" as const,
      label: "Interrupt blocked",
      detail: apiError.code === "read_only"
        ? "Read-only access cannot interrupt a turn. No retry was sent."
        : apiError.code === "host_locked"
          ? `${hostLockWriteReason("host_locked")} No retry was sent.`
          : "Current secure interrupt access was rejected. No retry was sent.",
      terminalState: null,
      updatedAt: null
    });
  }
  const authorityFailure =
    error instanceof HostDeckBrowserConnectionError ||
    (error instanceof HostDeckBrowserCsrfError && ["authority_rejected", "not_ready"].includes(error.reason));
  if (authorityFailure) {
    return deepFreeze({
      kind: "blocked" as const,
      source: "browser" as const,
      label: "Interrupt blocked",
      detail: "Current interrupt access was not available. HostDeck sent no retry.",
      terminalState: null,
      updatedAt: null
    });
  }
  return outcomeUnknownResult();
}

function outcomeUnknownResult(): InterruptResultView {
  return deepFreeze({
    kind: "outcome_unknown" as const,
    source: "browser" as const,
    label: "Outcome not confirmed",
    detail: "HostDeck could not confirm this exact turn outcome and will not resend the interrupt request.",
    terminalState: null,
    updatedAt: null
  });
}

function inconsistentResult(): InterruptResultView {
  return deepFreeze({
    kind: "inconsistent" as const,
    source: "browser" as const,
    label: "Interrupt state inconsistent",
    detail: "The response and retained turn activity do not agree. Refresh Session Detail; HostDeck will not resend this request.",
    terminalState: null,
    updatedAt: null
  });
}

function setupFailureResult(): InterruptResultView {
  return deepFreeze({
    kind: "blocked" as const,
    source: "browser" as const,
    label: "Secure interrupt setup unavailable",
    detail: "HostDeck could not create a secure interrupt request. No request was sent; reload HostDeck before trying again.",
    terminalState: null,
    updatedAt: null
  });
}

function browserApiError(error: unknown): ApiErrorEnvelope | null {
  if (error instanceof HostDeckBrowserHttpError || error instanceof HostDeckBrowserCsrfError) {
    return error.apiError;
  }
  return null;
}

function deriveStatus(input: Readonly<{
  availability: InterruptAvailability;
  actionEnabled: boolean;
  actionDisabledReason: string | null;
  attempt: InterruptAttempt | null;
  confirmationOpen: boolean;
  resultOpen: boolean;
  sheetOpen: boolean;
}>): Readonly<{
  phase: InterruptControlPhase;
  tone: InterruptControlTone;
  title: string;
  status: string;
  detail: string | null;
}> {
  if (!input.availability.visible) {
    return status("hidden", "muted", "Interrupt turn", "Interrupt unavailable", null);
  }
  if (!input.sheetOpen) {
    return status("closed", input.actionEnabled ? "focus" : "attention", "Interrupt turn", "Session actions closed", input.actionDisabledReason);
  }
  if (input.attempt?.phase === "submitting") {
    return status(
      "submitting",
      "attention",
      "Interrupt active turn?",
      "Waiting for confirmed result",
      "HostDeck sent one interrupt request and is waiting for the exact turn result."
    );
  }
  if (input.resultOpen && input.attempt?.result !== null && input.attempt?.result !== undefined) {
    const result = input.attempt.result;
    return status(result.kind, resultTone(result.kind), result.label, result.label, result.detail);
  }
  if (input.confirmationOpen) {
    return status(
      "confirming",
      "danger",
      "Interrupt active turn?",
      "Confirmation required",
      "No request is sent until you confirm this exact turn."
    );
  }
  if (input.actionEnabled) {
    return status("ready", "focus", "Session actions", "Active turn ready", "Interrupt requires confirmation.");
  }
  return status("unavailable", "attention", "Session actions", "Interrupt unavailable", input.actionDisabledReason);
}

function status(
  phase: InterruptControlPhase,
  tone: InterruptControlTone,
  title: string,
  label: string,
  detail: string | null
) {
  return Object.freeze({ phase, tone, title, status: label, detail });
}

function resultTone(kind: InterruptResultKind): InterruptControlTone {
  switch (kind) {
    case "confirmed_interrupted": return "connected";
    case "feed_interrupted": return "attention";
    case "not_interrupted": return "attention";
    case "blocked": return "danger";
    case "outcome_unknown": return "danger";
    case "inconsistent": return "danger";
  }
}

function targetView(target: InterruptExactTarget): InterruptTargetView {
  return Object.freeze({
    sessionLabel: target.sessionLabel,
    turnId: target.turnId,
    state: target.state,
    stateLabel: activeStateLabel(target.state)
  });
}

function activeStateLabel(state: InterruptActiveState): string {
  switch (state) {
    case "in_progress": return "In progress";
    case "waiting_for_input": return "Waiting for input";
    case "waiting_for_approval": return "Waiting for approval";
  }
}

function inactiveTurnReason(state: string): string {
  switch (state) {
    case "idle": return "There is no active turn to interrupt.";
    case "completed": return "The current turn is already completed.";
    case "interrupted": return "The current turn is already interrupted.";
    case "failed": return "The current turn has already failed.";
    case "unknown": return "The current turn state is unknown. Refresh before interrupting.";
    default: return "The current turn is not interruptible.";
  }
}

function writeEligibilityReason(cause: BrowserConnectionWriteBlockCause | undefined): string | null {
  if (cause === undefined) return null;
  switch (cause) {
    case "connection_not_current": return "Connection state is not current. Refresh before interrupting.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied": return "Pair this phone again before interrupting a turn.";
    case "read_only_access": return "Read-only access cannot interrupt a turn.";
    case "host_lock_pending":
    case "host_lock_unconfirmed":
    case "host_locked": return hostLockWriteReason(cause);
    case "host_status_unavailable":
    case "host_not_ready": return "Laptop write services are not ready.";
    case "csrf_not_ready": return "Secure write setup is not ready.";
  }
}

function matchingSession(snapshot: BrowserConnectionSnapshot, sessionId: SessionId) {
  const targetData = snapshot.targetState.data;
  return snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    targetData?.kind === "session_detail" &&
    targetData.response.session.session.id === sessionId
    ? targetData.response.session.session
    : null;
}

function writeAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  const access = snapshot.access.data;
  const host = snapshot.host.data;
  if (
    snapshot.access.state !== "current" ||
    snapshot.host.state !== "current" ||
    access === null ||
    host === null ||
    access.can_read_sessions !== true ||
    snapshot.csrf.phase !== "ready" ||
    snapshot.csrf.generation === null
  ) {
    return null;
  }
  if (
    host.compatibility.evidence !== "current" ||
    !["supported", "degraded"].includes(host.compatibility.state) ||
    !["verified", "limited"].includes(host.compatibility.capability_state)
  ) {
    return null;
  }
  const identity = access.authentication_state === "paired_device"
    ? access.device_id === null || access.permission !== "write"
      ? null
      : ["paired_device", access.configured_origin, access.device_id, access.permission]
    : access.authentication_state === "local_admin"
      ? ["local_admin", access.configured_origin, access.permission]
      : null;
  if (identity === null) return null;
  return JSON.stringify([
    snapshot.epoch,
    ...identity,
    host.local.generation,
    host.compatibility.state,
    host.compatibility.observed_version,
    host.compatibility.supported_version,
    host.compatibility.capability_state,
    snapshot.csrf.generation
  ]);
}

function latestBoundaryCursor(context: InterruptControlContext): number {
  let cursor = context.boundary?.cursor ?? -1;
  for (const event of context.events) {
    if (event.type === "replay_boundary" && event.cursor > cursor) cursor = event.cursor;
  }
  return cursor;
}

function latestContextCursor(context: InterruptControlContext): number {
  return Math.max(context.events.at(-1)?.cursor ?? -1, context.boundary?.cursor ?? -1);
}

function availability(
  visible: boolean,
  targetLabel: string | null,
  authorityKey: string | null,
  target: InterruptExactTarget | null,
  actionEnabled: boolean,
  reason: string | null
): InterruptAvailability {
  return Object.freeze({ visible, targetLabel, authorityKey, target, actionEnabled, reason });
}

function parseCreateOptions(
  candidate: unknown
): CreateInterruptControlControllerOptions {
  const value = readExactObject(
    candidate,
    ["sessionId", "context", "port", "createOperationId"] as const,
    "HostDeck interrupt-control options are invalid."
  );
  return Object.freeze({
    sessionId: value.sessionId as SessionId,
    context: value.context as InterruptControlContext,
    port: value.port as InterruptControlPort,
    createOperationId: value.createOperationId as () => string
  });
}

function parseContext(candidate: unknown, sessionId: SessionId): InterruptControlContext {
  const value = readExactObject(
    candidate,
    ["snapshot", "events", "boundary"] as const,
    "HostDeck interrupt-control context is invalid."
  );
  if (
    value.snapshot === null ||
    typeof value.snapshot !== "object" ||
    Array.isArray(value.snapshot) ||
    !Number.isSafeInteger((value.snapshot as BrowserConnectionSnapshot).epoch) ||
    (value.snapshot as BrowserConnectionSnapshot).epoch < 0 ||
    !Array.isArray(value.events) ||
    value.events.length > selectedEventPageMaxSize
  ) {
    throw new TypeError("HostDeck interrupt-control context is invalid.");
  }
  const events = value.events.map((event) =>
    deepFreeze(selectedProjectionEventSchema.parse(event))
  );
  let previous = -1;
  let boundarySeen = false;
  for (const [index, event] of events.entries()) {
    if (event.session_id !== sessionId || event.cursor <= previous) {
      throw new TypeError("HostDeck interrupt-control context contains invalid event ownership.");
    }
    if (previous >= 0 && event.cursor !== previous + 1) {
      throw new TypeError("HostDeck interrupt-control context contains an event cursor gap.");
    }
    if (event.type === "replay_boundary") {
      if (boundarySeen || index !== 0) {
        throw new TypeError("HostDeck interrupt-control context contains invalid boundary order.");
      }
      boundarySeen = true;
    }
    previous = event.cursor;
  }
  const boundary = value.boundary === null ? null : parseBoundary(value.boundary);
  if (boundary !== null) {
    const sameCursor = events.find((event) => event.cursor === boundary.cursor);
    if (
      sameCursor !== undefined &&
      (sameCursor.type !== "replay_boundary" ||
        sameCursor.after !== boundary.after ||
        sameCursor.reason !== boundary.reason)
    ) {
      throw new TypeError("HostDeck interrupt-control context contains contradictory boundary evidence.");
    }
  }
  return Object.freeze({
    snapshot: value.snapshot as BrowserConnectionSnapshot,
    events: Object.freeze(events),
    boundary
  });
}

function parseBoundary(candidate: unknown): SessionDetailContinuityBoundary {
  const value = readExactObject(
    candidate,
    ["after", "cursor", "reason"] as const,
    "HostDeck interrupt-control boundary is invalid."
  );
  if (
    (value.after !== null && (!Number.isSafeInteger(value.after) || (value.after as number) < 0)) ||
    !Number.isSafeInteger(value.cursor) ||
    (value.cursor as number) < 0 ||
    (value.after !== null && (value.cursor as number) <= (value.after as number)) ||
    !replayBoundaryReasonSchema.safeParse(value.reason).success
  ) {
    throw new TypeError("HostDeck interrupt-control boundary is invalid.");
  }
  return Object.freeze({
    after: value.after as number | null,
    cursor: value.cursor as number,
    reason: value.reason as SessionDetailContinuityBoundary["reason"]
  });
}

function parsePort(candidate: unknown): InterruptControlPort {
  const value = readExactObject(
    candidate,
    ["interrupt"] as const,
    "HostDeck interrupt-control port is invalid."
  );
  if (typeof value.interrupt !== "function") {
    throw new TypeError("HostDeck interrupt-control port is invalid.");
  }
  return Object.freeze({ interrupt: value.interrupt as InterruptControlPort["interrupt"] });
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck interrupt operation-id factory is invalid.");
  }
  return candidate as () => string;
}

function readExactObject<const Keys extends readonly string[]>(
  candidate: unknown,
  keys: Keys,
  message: string
): Readonly<Record<Keys[number], unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(message);
  }
  const prototype: unknown = Object.getPrototypeOf(candidate);
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new TypeError(message);
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]))
  ) as Readonly<Record<Keys[number], unknown>>;
}

function hiddenView(): InterruptControlView {
  return deepFreeze({
    visible: false,
    sheetOpen: false,
    phase: "hidden" as const,
    tone: "muted" as const,
    title: "Interrupt turn",
    status: "Interrupt unavailable",
    statusDetail: null,
    targetLabel: null,
    target: null,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    confirmationOpen: false,
    confirmEnabled: false,
    busy: false,
    closeDisabled: false,
    resultOpen: false,
    result: null
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
