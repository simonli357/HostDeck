import {
  clientOperationIdSchema,
  type PromptDispatchResponse,
  type PromptSessionRequest,
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
  promptTextMaxLength,
  type SelectedProjectionEvent,
  selectedAccessStateResponseSchema,
  selectedHostStatusResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  type BrowserConnectionResource,
  type BrowserConnectionSnapshot,
  type BrowserConnectionWriteBlockCause,
  browserConnectionPhases,
  browserConnectionResourceStates,
  browserConnectionWriteBlockCauses,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import { hostLockWriteReason } from "./host-lock-copy.js";
import {
  type SessionDetailFeedState,
  sessionDetailFeedLimit
} from "./session-detail-feed.js";

export const promptComposerPhases = Object.freeze([
  "hidden",
  "unavailable",
  "empty",
  "composing",
  "submitting",
  "accepted",
  "running",
  "needs_input",
  "needs_approval",
  "completed",
  "interrupted",
  "turn_failed",
  "turn_unknown",
  "failed_retryable",
  "failed_nonretryable",
  "outcome_unknown"
] as const);

export const promptComposerMaximumDraftLength = promptTextMaxLength + 1;

export type PromptComposerPhase = (typeof promptComposerPhases)[number];
export type PromptComposerTone = "connected" | "attention" | "danger" | "muted";

export type PromptComposerDisabledCause =
  | "target_unavailable"
  | "connection_not_current"
  | BrowserConnectionWriteBlockCause
  | "session_archived"
  | "session_not_current"
  | "session_not_writable"
  | "turn_needs_input"
  | "turn_needs_approval"
  | "turn_unknown"
  | "activity_loading"
  | "stream_connecting"
  | "stream_reconnecting"
  | "stream_unavailable"
  | "stream_unproven";

export interface PromptComposerContext {
  readonly snapshot: BrowserConnectionSnapshot;
  readonly feed: SessionDetailFeedState;
}

export interface PromptComposerDispatchInput {
  readonly sessionId: SessionId;
  readonly request: PromptSessionRequest;
  readonly signal: AbortSignal;
}

export interface PromptComposerDispatchPort {
  readonly dispatch: (input: PromptComposerDispatchInput) => Promise<unknown>;
}

export interface CreatePromptComposerControllerOptions {
  readonly sessionId: SessionId;
  readonly context: PromptComposerContext;
  readonly dispatch: PromptComposerDispatchPort;
  readonly createOperationId: () => string;
}

interface PromptComposerKnownFailure {
  readonly kind: "known";
  readonly message: string;
  readonly retryable: boolean;
  readonly submittedText: string;
}

interface PromptComposerUnknownFailure {
  readonly kind: "unknown";
  readonly message: string;
  readonly submittedText: string;
}

type PromptComposerFailure = PromptComposerKnownFailure | PromptComposerUnknownFailure;

export type PromptComposerOperationState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "submitting";
      operationId: string;
      submittedText: string;
      afterCursor: number | null;
    }>
  | Readonly<{
      phase: "accepted";
      receipt: PromptDispatchResponse;
      afterCursor: number | null;
    }>
  | Readonly<{
      phase: "failure";
      failure: PromptComposerFailure;
    }>;

export interface PromptComposerView {
  readonly visible: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly draft: string;
  readonly characterCount: number;
  readonly phase: PromptComposerPhase;
  readonly tone: PromptComposerTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly disabledCause: PromptComposerDisabledCause | null;
  readonly disabledReason: string | null;
  readonly inputDisabled: boolean;
  readonly inputReadOnly: boolean;
  readonly sendEnabled: boolean;
  readonly sendLabel: "Send prompt" | "Retry prompt";
  readonly reloadRequired: boolean;
}

export interface PromptComposerProjectionInput extends PromptComposerContext {
  readonly sessionId: SessionId;
  readonly draft: string;
  readonly operation: PromptComposerOperationState;
}

export interface PromptComposerController {
  readonly snapshot: () => PromptComposerView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: PromptComposerContext) => PromptComposerView;
  readonly setDraft: (draft: string) => PromptComposerView;
  readonly submit: () => Promise<PromptComposerView>;
  readonly close: () => PromptComposerView;
}

interface PromptAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly enabled: boolean;
  readonly cause: PromptComposerDisabledCause | null;
  readonly reason: string | null;
}

interface DraftState {
  readonly canonical: string;
  readonly valid: boolean;
  readonly reason: string | null;
}

interface PromptStatus {
  readonly phase: PromptComposerPhase;
  readonly tone: PromptComposerTone;
  readonly status: string;
  readonly detail: string | null;
}

const maximumSubscribers = 32;
const maximumFailureMessageLength = 512;
const startableTurnStates = new Set(["idle", "completed", "interrupted", "failed"]);
const streamStates = new Set([
  "not_applicable",
  "idle",
  "connecting",
  "connected",
  "reconnecting",
  "failed",
  "closed"
]);
const streamContinuities = new Set([
  "not_applicable",
  "unproven",
  "contiguous",
  "boundary"
]);

export function projectPromptComposer(input: PromptComposerProjectionInput): PromptComposerView {
  const sessionId = parseSessionId(input.sessionId);
  const draft = parseDraft(input.draft);
  const context = parseContext({ snapshot: input.snapshot, feed: input.feed });
  const operation = parseOperation(input.operation);
  if (
    operation.phase === "accepted" &&
    operation.receipt.target.session_id !== sessionId
  ) {
    throw new TypeError("HostDeck prompt composer receipt target is invalid.");
  }
  const availability = deriveAvailability(context.snapshot, context.feed, sessionId);
  const draftState = deriveDraftState(draft);
  const status = deriveStatus(operation, context.feed, availability, draftState);
  const failure = operation.phase === "failure" ? operation.failure : null;
  const sameFailedText = failure?.submittedText === draftState.canonical;
  const retryableFailure = failure?.kind === "known" && failure.retryable && sameFailedText;
  const blocksSameText = failure?.kind === "known" && !failure.retryable && sameFailedText;
  const outcomeUnknown = failure?.kind === "unknown";
  const submitting = operation.phase === "submitting";
  const progressBlock = disabledCauseForProgress(status.phase);
  const inputDisabled =
    !availability.visible ||
    !availability.enabled ||
    submitting ||
    progressBlock !== null;
  const inputReadOnly =
    availability.visible &&
    availability.enabled &&
    progressBlock === null &&
    outcomeUnknown;
  const sendEnabled =
    availability.visible &&
    availability.enabled &&
    draftState.valid &&
    !submitting &&
    progressBlock === null &&
    !outcomeUnknown &&
    !blocksSameText;

  return deepFreeze({
    visible: availability.visible,
    sessionId,
    targetLabel: availability.targetLabel,
    draft,
    characterCount: draft.length,
    phase: status.phase,
    tone: status.tone,
    status: status.status,
    statusDetail: status.detail,
    disabledCause: progressBlock ?? availability.cause,
    disabledReason:
      progressBlock === null ? availability.reason : disabledReason(progressBlock),
    inputDisabled,
    inputReadOnly,
    sendEnabled,
    sendLabel: retryableFailure ? "Retry prompt" : "Send prompt",
    reloadRequired: outcomeUnknown
  });
}

export function createPromptComposerController(
  options: CreatePromptComposerControllerOptions
): PromptComposerController {
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context);
  const dispatch = parseDispatchPort(options.dispatch);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  let draft = "";
  let operation: PromptComposerOperationState = idleOperation();
  let currentView = projectPromptComposer({ sessionId, ...context, draft, operation });
  let activeRequest: Readonly<{ sequence: number; controller: AbortController }> | null = null;
  let sequence = 0;
  let closed = false;
  const subscribers = new Set<() => void>();

  const publish = (): PromptComposerView => {
    currentView = projectPromptComposer({ sessionId, ...context, draft, operation });
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  const failBeforeDispatch = (message: string, submittedText: string): PromptComposerView => {
    operation = failureOperation({
      kind: "known",
      message,
      retryable: false,
      submittedText
    });
    return publish();
  };

  const controller: PromptComposerController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck prompt composer listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck prompt composer listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: PromptComposerContext): PromptComposerView {
      if (closed) throw new TypeError("HostDeck prompt composer is closed.");
      const parsed = parseContext(nextContext);
      const previousTarget = exactTargetSession(context.snapshot);
      const nextTarget = exactTargetSession(parsed.snapshot);
      const retainedDisclosure = projectPromptComposer({
        sessionId,
        ...parsed,
        draft,
        operation
      }).visible;
      context = parsed;
      if (
        (previousTarget === sessionId && nextTarget !== sessionId) ||
        (currentView.visible && !retainedDisclosure)
      ) {
        sequence += 1;
        activeRequest?.controller.abort();
        activeRequest = null;
        draft = "";
        operation = idleOperation();
      }
      return publish();
    },
    setDraft(nextDraft: string): PromptComposerView {
      if (closed) throw new TypeError("HostDeck prompt composer is closed.");
      if (currentView.inputDisabled || currentView.inputReadOnly) return currentView;
      const parsed = parseDraft(nextDraft);
      draft = parsed;
      if (operation.phase === "failure" && operation.failure.kind === "known") {
        const canonical = parsed.trim();
        if (canonical !== operation.failure.submittedText) operation = idleOperation();
      }
      return publish();
    },
    async submit(): Promise<PromptComposerView> {
      if (closed || !currentView.sendEnabled) return currentView;
      const draftState = deriveDraftState(draft);
      if (!draftState.valid) return currentView;
      const submittedText = draftState.canonical;

      let request: PromptSessionRequest;
      let operationId: string;
      try {
        operationId = createOperationId();
        request = promptSessionRequestSchema.parse({
          operation_id: operationId,
          kind: "prompt",
          text: submittedText
        });
      } catch {
        return failBeforeDispatch("Secure prompt setup is unavailable. Reload HostDeck.", submittedText);
      }

      const requestController = new AbortController();
      sequence += 1;
      const requestSequence = sequence;
      activeRequest = Object.freeze({ sequence: requestSequence, controller: requestController });
      operation = deepFreeze({
        phase: "submitting" as const,
        operationId,
        submittedText,
        afterCursor: context.feed.lastCursor
      });
      publish();

      try {
        const candidate = await Reflect.apply(dispatch.dispatch, undefined, [
          Object.freeze({ sessionId, request, signal: requestController.signal })
        ]);
        if (closed || requestSequence !== sequence) return currentView;
        const parsed = promptDispatchResponseSchema.safeParse(candidate);
        if (
          !parsed.success ||
          parsed.data.operation_id !== operationId ||
          parsed.data.kind !== "prompt" ||
          parsed.data.target.session_id !== sessionId
        ) {
          operation = failureOperation({
            kind: "unknown",
            message: "Prompt outcome is unknown. Reload and check session activity before sending again.",
            submittedText
          });
          return publish();
        }
        const afterCursor =
          operation.phase === "submitting"
            ? operation.afterCursor
            : context.feed.lastCursor;
        operation = deepFreeze({
          phase: "accepted" as const,
          receipt: deepFreeze(parsed.data),
          afterCursor
        });
        draft = "";
        return publish();
      } catch (error) {
        if (closed || requestSequence !== sequence) return currentView;
        operation = failureOperation(classifyDispatchFailure(error, submittedText));
        return publish();
      } finally {
        if (activeRequest?.sequence === requestSequence) activeRequest = null;
      }
    },
    close(): PromptComposerView {
      if (closed) return currentView;
      closed = true;
      sequence += 1;
      activeRequest?.controller.abort();
      activeRequest = null;
      subscribers.clear();
      draft = "";
      operation = idleOperation();
      currentView = hiddenView(sessionId);
      return currentView;
    }
  });

  return controller;
}

function deriveAvailability(
  snapshot: BrowserConnectionSnapshot,
  feed: SessionDetailFeedState,
  sessionId: SessionId
): PromptAvailability {
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
    return unavailable(false, null, "target_unavailable");
  }
  if (snapshot.targetState.state !== "current" || snapshot.access.state !== "current") {
    return unavailable(true, detail.name, "connection_not_current");
  }
  const writeCause = snapshot.writeEligibility.causes[0];
  if (!snapshot.writeEligibility.eligible || writeCause !== undefined) {
    return unavailable(
      true,
      detail.name,
      writeCause ?? "connection_not_current"
    );
  }
  if (detail.session_state === "archived" || detail.archived_at !== null) {
    return unavailable(true, detail.name, "session_archived");
  }
  if (detail.session_state !== "active" || detail.freshness !== "current") {
    return unavailable(true, detail.name, "session_not_current");
  }
  if (detail.turn_state === "waiting_for_input") {
    return unavailable(true, detail.name, "turn_needs_input");
  }
  if (detail.turn_state === "waiting_for_approval") {
    return unavailable(true, detail.name, "turn_needs_approval");
  }
  if (detail.turn_state === "unknown") {
    return unavailable(true, detail.name, "turn_unknown");
  }
  if (detail.turn_state !== "in_progress" && !startableTurnStates.has(detail.turn_state)) {
    return unavailable(true, detail.name, "session_not_writable");
  }
  if (feed.sessionId !== sessionId) {
    return unavailable(true, detail.name, "activity_loading");
  }
  if (snapshot.stream.state === "idle" || snapshot.stream.state === "connecting") {
    return unavailable(true, detail.name, "stream_connecting");
  }
  if (snapshot.stream.state === "reconnecting") {
    return unavailable(true, detail.name, "stream_reconnecting");
  }
  if (snapshot.stream.state !== "connected") {
    return unavailable(true, detail.name, "stream_unavailable");
  }
  if (
    snapshot.stream.continuity !== "contiguous" &&
    snapshot.stream.continuity !== "boundary"
  ) {
    return unavailable(true, detail.name, "stream_unproven");
  }
  return deepFreeze({
    visible: true,
    targetLabel: detail.name,
    enabled: true,
    cause: null,
    reason: null
  });
}

function deriveDraftState(draft: string): DraftState {
  const canonical = draft.trim();
  if (canonical.length === 0) {
    return Object.freeze({ canonical, valid: false, reason: null });
  }
  if (canonical.length > promptTextMaxLength) {
    return Object.freeze({
      canonical,
      valid: false,
      reason: `Prompt exceeds ${promptTextMaxLength.toLocaleString("en-US")} characters.`
    });
  }
  return Object.freeze({ canonical, valid: true, reason: null });
}

function deriveStatus(
  operation: PromptComposerOperationState,
  feed: SessionDetailFeedState,
  availability: PromptAvailability,
  draft: DraftState
): PromptStatus {
  if (operation.phase === "submitting") {
    return status("submitting", "attention", "Sending prompt", "Waiting for HostDeck acceptance.");
  }
  if (operation.phase === "failure") {
    if (operation.failure.kind === "unknown") {
      return status("outcome_unknown", "danger", "Prompt outcome unknown", operation.failure.message);
    }
    return status(
      operation.failure.retryable ? "failed_retryable" : "failed_nonretryable",
      operation.failure.retryable ? "attention" : "danger",
      operation.failure.retryable ? "Prompt was not accepted" : "Prompt could not be sent",
      operation.failure.message
    );
  }
  if (!availability.visible) return status("hidden", "muted", "Prompt unavailable", null);
  if (
    !availability.enabled &&
    !retainsAcceptedTurnProgress(operation, availability.cause)
  ) {
    return status(
      "unavailable",
      disabledTone(availability.cause),
      "Prompt unavailable",
      availability.reason
    );
  }
  if (operation.phase === "accepted") {
    const turnEvent = latestTurnEvent(
      feed.events,
      operation.receipt.turn_id,
      operation.afterCursor
    );
    if (turnEvent !== null) return turnEventStatus(turnEvent);
    return status(
      "accepted",
      "attention",
      operation.receipt.action === "start" ? "New turn accepted" : "Follow-up accepted",
      "Runtime progress has not been observed yet."
    );
  }
  if (!availability.enabled) {
    return status(
      "unavailable",
      disabledTone(availability.cause),
      "Prompt unavailable",
      availability.reason
    );
  }
  if (draft.reason !== null) {
    return status("composing", "danger", "Prompt is too long", draft.reason);
  }
  if (draft.canonical.length > 0) {
    return status("composing", "connected", "Ready to send", "One prompt targets this session.");
  }
  return status("empty", "connected", "Ready to send", "One prompt targets this session.");
}

function retainsAcceptedTurnProgress(
  operation: PromptComposerOperationState,
  cause: PromptComposerDisabledCause | null
): boolean {
  return (
    operation.phase === "accepted" &&
    (cause === "turn_needs_input" ||
      cause === "turn_needs_approval" ||
      cause === "turn_unknown")
  );
}

function latestTurnEvent(
  events: readonly SelectedProjectionEvent[],
  turnId: string,
  afterCursor: number | null
): Extract<SelectedProjectionEvent, { readonly type: "turn" }> | null {
  let selected: Extract<SelectedProjectionEvent, { readonly type: "turn" }> | null = null;
  for (const event of events) {
    if (
      event.type !== "turn" ||
      event.turn_id !== turnId ||
      (afterCursor !== null && event.cursor <= afterCursor)
    ) {
      continue;
    }
    if (selected === null || event.cursor > selected.cursor) selected = event;
  }
  return selected;
}

function turnEventStatus(
  event: Extract<SelectedProjectionEvent, { readonly type: "turn" }>
): PromptStatus {
  switch (event.state) {
    case "idle":
      return status("accepted", "muted", "Turn is idle", "No active runtime work is reported.");
    case "in_progress":
      return status("running", "connected", "Turn running", "Runtime progress is current.");
    case "waiting_for_input":
      return status("needs_input", "attention", "Turn needs input", "Respond to the pending input request.");
    case "waiting_for_approval":
      return status(
        "needs_approval",
        "attention",
        "Prompt paused",
        "The turn still reports waiting for approval. Refresh before sending."
      );
    case "completed":
      return status("completed", "connected", "Turn completed", "Completion was confirmed by session activity.");
    case "interrupted":
      return status("interrupted", "danger", "Turn interrupted", "Session activity confirmed interruption.");
    case "failed":
      return status("turn_failed", "danger", "Turn failed", event.error?.message ?? "Runtime work failed.");
    case "unknown":
      return status("turn_unknown", "attention", "Turn state unknown", "Refresh before sending another prompt.");
  }
}

function classifyDispatchFailure(error: unknown, submittedText: string): PromptComposerFailure {
  if (error instanceof HostDeckBrowserConnectionError) {
    return knownFailure(
      error.reason === "closed"
        ? "HostDeck closed before the prompt could be sent. Reload to continue."
        : "Prompt sending is no longer available. Refresh the session.",
      false,
      submittedText
    );
  }
  if (error instanceof HostDeckBrowserCsrfError) {
    if (error.apiError !== null) {
      return knownFailure(
        apiFailureMessage(error.apiError.code),
        error.apiError.retryable,
        submittedText
      );
    }
    if (error.reason === "client_contract" || error.reason === "not_ready") {
      return knownFailure("Secure prompt access is not ready. Refresh the session.", false, submittedText);
    }
    if (error.reason === "bootstrap_unavailable") {
      return knownFailure("Secure write setup is unavailable. Reload HostDeck.", false, submittedText);
    }
    if (error.reason === "stale_generation" || error.reason === "authority_rejected") {
      return knownFailure("Prompt access changed. Refresh access before trying again.", false, submittedText);
    }
  }
  return deepFreeze({
    kind: "unknown" as const,
    message: "Prompt outcome is unknown. Reload and check session activity before sending again.",
    submittedText
  });
}

function apiFailureMessage(code: string): string {
  switch (code) {
    case "session_not_found":
      return "This session no longer exists.";
    case "session_not_writable":
      return "This session cannot accept a prompt now.";
    case "stale_session":
      return "Session state changed. Refresh before sending.";
    case "host_locked":
      return hostLockWriteReason("host_locked");
    case "permission_denied":
    case "read_only":
      return "This phone does not have prompt permission.";
    case "audit_unavailable":
      return "Prompt audit is unavailable. No prompt was accepted.";
    case "runtime_unavailable":
      return "The Codex runtime is unavailable.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The current Codex runtime cannot accept this prompt.";
    case "operation_conflict":
      return "Another prompt is still being checked.";
    case "operation_timeout":
      return "HostDeck timed out before accepting the prompt.";
    case "rate_limited":
      return "Prompt requests are temporarily rate limited.";
    case "service_overloaded":
      return "HostDeck is temporarily too busy to accept the prompt.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure prompt access was rejected.";
    case "malformed_request":
    case "validation_error":
    case "invalid_session_id":
      return "HostDeck rejected this prompt request.";
    default:
      return "HostDeck could not accept the prompt.";
  }
}

function unavailable(
  visible: boolean,
  targetLabel: string | null,
  cause: PromptComposerDisabledCause
): PromptAvailability {
  return deepFreeze({
    visible,
    targetLabel,
    enabled: false,
    cause,
    reason: disabledReason(cause)
  });
}

function disabledCauseForProgress(
  phase: PromptComposerPhase
): PromptComposerDisabledCause | null {
  switch (phase) {
    case "needs_input":
      return "turn_needs_input";
    case "needs_approval":
      return "turn_needs_approval";
    case "turn_unknown":
      return "turn_unknown";
    default:
      return null;
  }
}

function disabledReason(cause: PromptComposerDisabledCause): string {
  switch (cause) {
    case "target_unavailable":
      return "Session details are not available.";
    case "connection_not_current":
      return "Connection state is not current. Refresh before sending.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied":
      return "Pair this phone again to send prompts.";
    case "read_only_access":
      return "Read-only access cannot send prompts.";
    case "host_lock_pending":
    case "host_lock_unconfirmed":
    case "host_locked":
      return hostLockWriteReason(cause);
    case "host_status_unavailable":
    case "host_not_ready":
      return "Laptop write services are not ready.";
    case "csrf_not_ready":
      return "Secure write setup is not ready.";
    case "session_archived":
      return "Archived sessions cannot receive prompts.";
    case "session_not_current":
      return "Session state is stale. Refresh before sending.";
    case "session_not_writable":
      return "This session cannot accept a prompt now.";
    case "turn_needs_input":
      return "Respond to the pending input request first.";
    case "turn_needs_approval":
      return "The turn still reports waiting for approval. Refresh before sending.";
    case "turn_unknown":
      return "Turn state is unknown. Refresh before sending.";
    case "activity_loading":
    case "stream_connecting":
      return "Wait for current session activity before sending.";
    case "stream_reconnecting":
      return "Session activity is reconnecting.";
    case "stream_unavailable":
      return "Live session activity is unavailable.";
    case "stream_unproven":
      return "Session activity continuity is not proven yet.";
  }
}

function disabledTone(cause: PromptComposerDisabledCause | null): PromptComposerTone {
  if (
    cause === "host_locked" ||
    cause === "revoked_device" ||
    cause === "expired_device" ||
    cause === "stream_unavailable"
  ) {
    return "danger";
  }
  return cause === "target_unavailable" ? "muted" : "attention";
}

function status(
  phase: PromptComposerPhase,
  tone: PromptComposerTone,
  value: string,
  detail: string | null
): PromptStatus {
  return Object.freeze({ phase, tone, status: value, detail });
}

function knownFailure(
  message: string,
  retryable: boolean,
  submittedText: string
): PromptComposerKnownFailure {
  return deepFreeze({ kind: "known" as const, message, retryable, submittedText });
}

function failureOperation(failure: PromptComposerFailure): PromptComposerOperationState {
  return deepFreeze({ phase: "failure" as const, failure });
}

function idleOperation(): PromptComposerOperationState {
  return Object.freeze({ phase: "idle" as const });
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseDraft(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length > promptComposerMaximumDraftLength) {
    throw new TypeError("HostDeck prompt composer draft is invalid.");
  }
  return candidate;
}

function parseContext(candidate: unknown): PromptComposerContext {
  const values = readExactRecord(candidate, ["snapshot", "feed"], contextError);
  return Object.freeze({
    snapshot: parseSnapshot(values.snapshot),
    feed: parseFeed(values.feed)
  });
}

function parseOperation(candidate: unknown): PromptComposerOperationState {
  const phaseRecord = readRecord(candidate, operationError);
  switch (phaseRecord.phase) {
    case "idle":
      readExactRecord(candidate, ["phase"], operationError);
      return idleOperation();
    case "submitting": {
      const values = readExactRecord(
        candidate,
        ["phase", "operationId", "submittedText", "afterCursor"],
        operationError
      );
      return deepFreeze({
        phase: "submitting" as const,
        operationId: parseOperationId(values.operationId),
        submittedText: parseSubmittedText(values.submittedText),
        afterCursor: parseCursor(values.afterCursor)
      });
    }
    case "accepted": {
      const values = readExactRecord(
        candidate,
        ["phase", "receipt", "afterCursor"],
        operationError
      );
      const receipt = promptDispatchResponseSchema.safeParse(values.receipt);
      if (!receipt.success) throw new TypeError(operationError);
      return deepFreeze({
        phase: "accepted" as const,
        receipt: receipt.data,
        afterCursor: parseCursor(values.afterCursor)
      });
    }
    case "failure": {
      const values = readExactRecord(candidate, ["phase", "failure"], operationError);
      return failureOperation(parseFailure(values.failure));
    }
    default:
      throw new TypeError(operationError);
  }
}

const contextError = "HostDeck prompt composer context is invalid.";
const operationError = "HostDeck prompt composer operation state is invalid.";

function parseSnapshot(candidate: unknown): BrowserConnectionSnapshot {
  const record = readRecord(candidate, contextError);
  const snapshotKeys = [
    "epoch",
    "target",
    "phase",
    "access",
    "host",
    "targetState",
    "stream",
    "csrf",
    "writeEligibility",
    "lastFailure"
  ] as const;
  const values = readExactRecord(
    candidate,
    Object.hasOwn(record, "catalog")
      ? [...snapshotKeys, "catalog"]
      : snapshotKeys,
    contextError
  );
  if (
    !Number.isSafeInteger(values.epoch) ||
    (values.epoch as number) < 0 ||
    !browserConnectionPhases.includes(values.phase as never)
  ) {
    throw new TypeError(contextError);
  }

  const target = parseTarget(values.target);
  const access: BrowserConnectionSnapshot["access"] = parseResource(values.access, (data) => {
    const parsed = selectedAccessStateResponseSchema.safeParse(data);
    if (!parsed.success) throw new TypeError(contextError);
    return parsed.data;
  });
  const targetState: BrowserConnectionSnapshot["targetState"] = parseResource(
    values.targetState,
    parseTargetData
  );
  const host: BrowserConnectionSnapshot["host"] = parseResource(values.host, (data) => {
    const parsed = selectedHostStatusResponseSchema.safeParse(data);
    if (!parsed.success) throw new TypeError(contextError);
    return parsed.data;
  });
  const stream = parseStream(values.stream);
  if (values.catalog !== undefined) parseCatalog(values.catalog);
  const writeEligibility = parseWriteEligibility(values.writeEligibility);
  if (
    (values.csrf === null || typeof values.csrf !== "object") ||
    (values.lastFailure !== null && typeof values.lastFailure !== "object")
  ) {
    throw new TypeError(contextError);
  }

  return Object.freeze({
    ...(candidate as BrowserConnectionSnapshot),
    epoch: values.epoch as number,
    target,
    phase: values.phase as BrowserConnectionSnapshot["phase"],
    access,
    host,
    targetState,
    stream,
    writeEligibility
  });
}

function parseCatalog(candidate: unknown): void {
  const values = readExactRecord(
    candidate,
    ["state", "data", "snapshot", "boundary", "failure", "observedAt"],
    contextError
  );
  if (
    ![
      "idle",
      "connecting",
      "resetting",
      "current",
      "reconnecting",
      "stale",
      "failed",
      "blocked",
      "closed"
    ].includes(values.state as string) ||
    (values.data !== null && typeof values.data !== "object") ||
    (values.snapshot !== null && typeof values.snapshot !== "object") ||
    (values.boundary !== null && typeof values.boundary !== "object") ||
    (values.failure !== null && typeof values.failure !== "object") ||
    (values.observedAt !== null && typeof values.observedAt !== "string")
  ) {
    throw new TypeError(contextError);
  }
}

function parseTarget(candidate: unknown): BrowserConnectionSnapshot["target"] {
  if (candidate === null) return null;
  const values = readRecord(candidate, contextError);
  if (values.kind === "mission_control") {
    readExactRecord(candidate, ["kind"], contextError);
    return Object.freeze({ kind: "mission_control" as const });
  }
  if (values.kind === "session_detail") {
    const detail = readExactRecord(candidate, ["kind", "sessionId"], contextError);
    return Object.freeze({
      kind: "session_detail" as const,
      sessionId: parseSessionId(detail.sessionId)
    });
  }
  throw new TypeError(contextError);
}

function parseResource<Data>(
  candidate: unknown,
  parseData: (candidate: unknown) => Data
): BrowserConnectionResource<Data> {
  const values = readExactRecord(
    candidate,
    ["state", "data", "failure", "observedAt"],
    contextError
  );
  if (
    !browserConnectionResourceStates.includes(values.state as never) ||
    (values.failure !== null && typeof values.failure !== "object") ||
    (values.observedAt !== null && typeof values.observedAt !== "string")
  ) {
    throw new TypeError(contextError);
  }
  return Object.freeze({
    state: values.state as BrowserConnectionResource<Data>["state"],
    data: values.data === null ? null : parseData(values.data),
    failure: values.failure as BrowserConnectionResource<Data>["failure"],
    observedAt: values.observedAt as string | null
  });
}

function parseTargetData(
  candidate: unknown
): NonNullable<BrowserConnectionSnapshot["targetState"]["data"]> {
  const values = readRecord(candidate, contextError);
  if (values.kind === "session_detail") {
    const exact = readExactRecord(candidate, ["kind", "response"], contextError);
    const response = selectedSessionDetailResponseSchema.safeParse(exact.response);
    if (!response.success) throw new TypeError(contextError);
    return Object.freeze({ kind: "session_detail" as const, response: response.data });
  }
  if (values.kind === "mission_control") {
    return candidate as NonNullable<BrowserConnectionSnapshot["targetState"]["data"]>;
  }
  throw new TypeError(contextError);
}

function parseStream(candidate: unknown): BrowserConnectionSnapshot["stream"] {
  const values = readExactRecord(
    candidate,
    ["state", "snapshot", "continuity", "boundary", "failure"],
    contextError
  );
  if (
    typeof values.state !== "string" ||
    !streamStates.has(values.state) ||
    typeof values.continuity !== "string" ||
    !streamContinuities.has(values.continuity) ||
    (values.snapshot !== null && typeof values.snapshot !== "object") ||
    (values.boundary !== null && typeof values.boundary !== "object") ||
    (values.failure !== null && typeof values.failure !== "object")
  ) {
    throw new TypeError(contextError);
  }
  return Object.freeze({
    state: values.state as BrowserConnectionSnapshot["stream"]["state"],
    snapshot: values.snapshot as BrowserConnectionSnapshot["stream"]["snapshot"],
    continuity: values.continuity as BrowserConnectionSnapshot["stream"]["continuity"],
    boundary: values.boundary as BrowserConnectionSnapshot["stream"]["boundary"],
    failure: values.failure as BrowserConnectionSnapshot["stream"]["failure"]
  });
}

function parseWriteEligibility(
  candidate: unknown
): BrowserConnectionSnapshot["writeEligibility"] {
  const values = readExactRecord(
    candidate,
    ["scope", "eligible", "causes"],
    contextError
  );
  if (
    values.scope !== "browser_shell" ||
    typeof values.eligible !== "boolean" ||
    !Array.isArray(values.causes) ||
    values.causes.some(
      (cause) => !browserConnectionWriteBlockCauses.includes(cause as never)
    ) ||
    new Set(values.causes).size !== values.causes.length ||
    values.eligible !== (values.causes.length === 0)
  ) {
    throw new TypeError(contextError);
  }
  return Object.freeze({
    scope: "browser_shell" as const,
    eligible: values.eligible,
    causes: Object.freeze([...values.causes]) as readonly BrowserConnectionWriteBlockCause[]
  });
}

function parseFeed(candidate: unknown): SessionDetailFeedState {
  const values = readExactRecord(
    candidate,
    ["sessionId", "events", "acceptedCount", "lastCursor"],
    contextError
  );
  const sessionId = parseSessionId(values.sessionId);
  if (
    !Array.isArray(values.events) ||
    values.events.length > sessionDetailFeedLimit ||
    !Number.isSafeInteger(values.acceptedCount) ||
    (values.acceptedCount as number) < values.events.length
  ) {
    throw new TypeError(contextError);
  }
  const events = values.events.map((event) => {
    const parsed = selectedProjectionEventSchema.safeParse(event);
    if (!parsed.success || parsed.data.session_id !== sessionId) {
      throw new TypeError(contextError);
    }
    return parsed.data;
  });
  for (let index = 1; index < events.length; index += 1) {
    if ((events[index - 1]?.cursor ?? 0) >= (events[index]?.cursor ?? 0)) {
      throw new TypeError(contextError);
    }
  }
  const expectedCursor = events.at(-1)?.cursor ?? null;
  if (parseCursor(values.lastCursor) !== expectedCursor) {
    throw new TypeError(contextError);
  }
  return deepFreeze({
    sessionId,
    events,
    acceptedCount: values.acceptedCount as number,
    lastCursor: expectedCursor
  });
}

function parseFailure(candidate: unknown): PromptComposerFailure {
  const values = readRecord(candidate, operationError);
  if (values.kind === "known") {
    const exact = readExactRecord(
      candidate,
      ["kind", "message", "retryable", "submittedText"],
      operationError
    );
    if (typeof exact.retryable !== "boolean") throw new TypeError(operationError);
    return knownFailure(
      parseFailureMessage(exact.message),
      exact.retryable,
      parseSubmittedText(exact.submittedText)
    );
  }
  if (values.kind === "unknown") {
    const exact = readExactRecord(
      candidate,
      ["kind", "message", "submittedText"],
      operationError
    );
    return deepFreeze({
      kind: "unknown" as const,
      message: parseFailureMessage(exact.message),
      submittedText: parseSubmittedText(exact.submittedText)
    });
  }
  throw new TypeError(operationError);
}

function parseOperationId(candidate: unknown): string {
  const parsed = clientOperationIdSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError(operationError);
  return parsed.data;
}

function parseSubmittedText(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > promptTextMaxLength ||
    candidate.trim() !== candidate
  ) {
    throw new TypeError(operationError);
  }
  return candidate;
}

function parseFailureMessage(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > maximumFailureMessageLength
  ) {
    throw new TypeError(operationError);
  }
  return candidate;
}

function parseCursor(candidate: unknown): number | null {
  if (candidate === null) return null;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new TypeError(operationError);
  }
  return candidate as number;
}

function readRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(message);
  }
  return candidate as Record<string, unknown>;
}

function readExactRecord(
  candidate: unknown,
  keys: readonly string[],
  message: string
): Record<string, unknown> {
  const record = readRecord(candidate, message);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(message);
  }
  return record;
}

function parseDispatchPort(candidate: unknown): PromptComposerDispatchPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as Partial<PromptComposerDispatchPort>).dispatch !== "function"
  ) {
    throw new TypeError("HostDeck prompt dispatch port is invalid.");
  }
  return candidate as PromptComposerDispatchPort;
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck prompt operation-id factory is invalid.");
  }
  return candidate as () => string;
}

function exactTargetSession(snapshot: BrowserConnectionSnapshot): string | null {
  return snapshot.target?.kind === "session_detail" ? snapshot.target.sessionId : null;
}

function hiddenView(sessionId: SessionId): PromptComposerView {
  return deepFreeze({
    visible: false,
    sessionId,
    targetLabel: null,
    draft: "",
    characterCount: 0,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Prompt unavailable",
    statusDetail: null,
    disabledCause: "target_unavailable" as const,
    disabledReason: "Session details are not available.",
    inputDisabled: true,
    inputReadOnly: false,
    sendEnabled: false,
    sendLabel: "Send prompt" as const,
    reloadRequired: false
  });
}

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
