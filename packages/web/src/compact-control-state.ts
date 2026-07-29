import {
  type ApiErrorEnvelope,
  type CompactProgressResponse,
  type CompactStartRequest,
  compactProgressResponseSchema,
  compactStartRequestSchema,
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

export const compactControlPhases = Object.freeze([
  "hidden",
  "closed",
  "loading",
  "ready",
  "confirming",
  "submitting",
  "accepted",
  "running",
  "completed",
  "interrupted",
  "failed",
  "incomplete",
  "stale",
  "unsupported",
  "conflict",
  "read_failure",
  "start_failure",
  "outcome_unknown"
] as const);

export type CompactControlPhase = (typeof compactControlPhases)[number];
export type CompactControlTone = "connected" | "attention" | "danger" | "focus" | "muted";

export interface CompactControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface CompactControlReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface CompactControlStartInput {
  readonly sessionId: SessionId;
  readonly request: CompactStartRequest;
  readonly signal: AbortSignal;
}

export interface CompactControlPort {
  readonly read: (input: CompactControlReadInput) => Promise<unknown>;
  readonly start: (input: CompactControlStartInput) => Promise<unknown>;
}

export interface CreateCompactControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: CompactControlContext;
  readonly port: CompactControlPort;
  readonly createOperationId: () => string;
}

export interface CompactProgressView {
  readonly state: NonNullable<CompactProgressResponse["progress"]>["state"];
  readonly label: string;
  readonly detail: string;
  readonly tone: CompactControlTone;
  readonly updatedAt: string;
  readonly freshness: "current" | "stale";
  readonly retryable: boolean;
}

export interface CompactControlView {
  readonly visible: boolean;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly sheetOpen: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly phase: CompactControlPhase;
  readonly tone: CompactControlTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly busy: boolean;
  readonly closeDisabled: boolean;
  readonly checkEnabled: boolean;
  readonly confirmationOpen: boolean;
  readonly confirmEnabled: boolean;
  readonly startActionVisible: boolean;
  readonly startEnabled: boolean;
  readonly startDisabledReason: string | null;
  readonly startLabel: "Compact context" | "Compact again";
  readonly hasCapture: boolean;
  readonly captureFreshness: "current" | "stale" | null;
  readonly hasCurrentRead: boolean;
  readonly progress: CompactProgressView | null;
}

export interface CompactControlController {
  readonly snapshot: () => CompactControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: CompactControlContext) => CompactControlView;
  readonly open: () => Promise<CompactControlView>;
  readonly check: () => Promise<CompactControlView>;
  readonly beginConfirmation: () => CompactControlView;
  readonly cancelConfirmation: () => CompactControlView;
  readonly confirm: () => Promise<CompactControlView>;
  readonly dismiss: () => CompactControlView;
  readonly close: () => CompactControlView;
}

export class HostDeckCompactOutcomeUnknownError extends Error {
  constructor() {
    super("Compact start outcome is unknown.");
    this.name = "HostDeckCompactOutcomeUnknownError";
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

type CompactControlOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "submitting"; operationId: string }>
  | Readonly<{ phase: "failure"; failure: CompactControlFailure }>;

interface CompactControlFailure {
  readonly kind: "unsupported" | "read" | "start" | "conflict" | "unknown";
  readonly message: string;
}

interface CompactControlAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly targetKey: string | null;
  readonly authorityKey: string | null;
  readonly readEnabled: boolean;
  readonly readReason: string | null;
  readonly writeEnabled: boolean;
  readonly writeReason: string | null;
}

interface ActiveRequest {
  readonly sequence: number;
  readonly kind: "read" | "start";
  readonly targetKey: string;
  readonly authorityKey: string;
  readonly controller: AbortController;
}

const maximumSubscribers = 32;
const terminalTurnStates = new Set(["idle", "completed", "interrupted", "failed"]);
const ambiguousStartCodes = new Set<ApiErrorEnvelope["code"]>([
  "audit_unavailable",
  "capability_unavailable",
  "incompatible_runtime",
  "internal_error",
  "operation_timeout",
  "protocol_error",
  "runtime_unavailable",
  "session_not_writable",
  "stale_session",
  "storage_error",
  "unknown_error"
]);

export function createCompactControlController(
  candidateOptions: CreateCompactControlControllerOptions
): CompactControlController {
  const options = parseCreateOptions(candidateOptions);
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  let sheetOpen = false;
  let confirmationOpen = false;
  let data: CompactProgressResponse | null = null;
  let captureEpoch: number | null = null;
  let captureAuthorityKey: string | null = null;
  let captureTargetKey: string | null = null;
  let operation: CompactControlOperation = idleOperation();
  let sequence = 0;
  let activeRequest: ActiveRequest | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): CompactControlView {
    const availability = deriveAvailability(context.snapshot, sessionId);
    const authorizedCapture =
      data !== null &&
      captureAuthorityKey !== null &&
      captureTargetKey !== null &&
      availability.authorityKey === captureAuthorityKey &&
      availability.targetKey === captureTargetKey;
    const stale =
      authorizedCapture &&
      (captureEpoch !== context.snapshot.epoch ||
        !availability.readEnabled ||
        operation.phase === "loading" ||
        operation.phase === "submitting" ||
        operation.phase === "failure");
    const projectedData = authorizedCapture ? data : null;
    const progress = projectedData?.progress ?? null;
    const statusValue = deriveStatus({
      availability,
      confirmationOpen,
      data: projectedData,
      operation,
      sheetOpen: sheetOpen && availability.visible,
      stale
    });
    const operationIdle = operation.phase === "idle";
    const currentRead = projectedData !== null && !stale;
    const progressStartable = isStartableProgress(progress);
    const startActionVisible = currentRead && progressStartable;
    const startEnabled =
      startActionVisible &&
      availability.writeEnabled &&
      operationIdle &&
      !confirmationOpen;
    const startDisabledReason = startActionVisible && !startEnabled
      ? availability.writeReason ?? operationDisabledReason(operation)
      : null;
    const unsupported =
      operation.phase === "failure" && operation.failure.kind === "unsupported";
    const busy = operation.phase === "loading" || operation.phase === "submitting";

    return deepFreeze({
      visible: availability.visible,
      actionEnabled: availability.readEnabled,
      actionDisabledReason: availability.readReason,
      sheetOpen: sheetOpen && availability.visible,
      sessionId,
      targetLabel: availability.targetLabel,
      phase: statusValue.phase,
      tone: statusValue.tone,
      status: statusValue.label,
      statusDetail: statusValue.detail,
      busy,
      closeDisabled: operation.phase === "submitting",
      checkEnabled:
        sheetOpen &&
        availability.readEnabled &&
        !busy &&
        !confirmationOpen &&
        !unsupported,
      confirmationOpen,
      confirmEnabled:
        confirmationOpen &&
        currentRead &&
        progressStartable &&
        availability.writeEnabled &&
        operationIdle,
      startActionVisible,
      startEnabled,
      startDisabledReason,
      startLabel: progress === null ? "Compact context" : "Compact again",
      hasCapture: projectedData !== null,
      captureFreshness: projectedData === null ? null : stale ? "stale" : "current",
      hasCurrentRead: currentRead,
      progress: progress === null ? null : projectProgress(progress, stale)
    });
  }

  const publish = (): CompactControlView => {
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

  const clearCapture = (): void => {
    data = null;
    captureEpoch = null;
    captureAuthorityKey = null;
    captureTargetKey = null;
  };

  const installCapture = (candidate: unknown, expectedOperationId: string | null): void => {
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (
      !availability.readEnabled ||
      availability.authorityKey === null ||
      availability.targetKey === null
    ) {
      throw new HostDeckBrowserConnectionError("not_ready");
    }
    const response = freezeResponse(candidate, context.snapshot, sessionId, expectedOperationId);
    data = response;
    captureEpoch = context.snapshot.epoch;
    captureAuthorityKey = availability.authorityKey;
    captureTargetKey = availability.targetKey;
  };

  const runRead = async (): Promise<CompactControlView> => {
    if (closed || !sheetOpen || !currentView.actionEnabled || activeRequest !== null) {
      return currentView;
    }
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (availability.targetKey === null || availability.authorityKey === null) return currentView;
    cancelActive();
    const requestController = new AbortController();
    const requestSequence = sequence;
    activeRequest = Object.freeze({
      sequence: requestSequence,
      kind: "read" as const,
      targetKey: availability.targetKey,
      authorityKey: availability.authorityKey,
      controller: requestController
    });
    confirmationOpen = false;
    operation = loadingOperation();
    publish();
    try {
      const response = await Reflect.apply(port.read, undefined, [
        Object.freeze({ sessionId, signal: requestController.signal })
      ]);
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      installCapture(response, null);
      operation = idleOperation();
      return publish();
    } catch (error) {
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      operation = failureOperation(classifyReadFailure(error));
      if (data === null) clearCapture();
      return publish();
    } finally {
      if (activeRequest?.sequence === requestSequence) activeRequest = null;
    }
  };

  const controller: CompactControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck compact-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck compact-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: CompactControlContext): CompactControlView {
      if (closed) throw new TypeError("HostDeck compact control is closed.");
      const previousEpoch = context.snapshot.epoch;
      context = parseContext(nextContext);
      const availability = deriveAvailability(context.snapshot, sessionId);
      const authorityReplaced =
        (captureAuthorityKey !== null && availability.authorityKey !== captureAuthorityKey) ||
        (activeRequest !== null && availability.authorityKey !== activeRequest.authorityKey);
      const targetReplaced =
        (captureTargetKey !== null && availability.targetKey !== captureTargetKey) ||
        (activeRequest !== null && availability.targetKey !== activeRequest.targetKey);
      if (!availability.visible || authorityReplaced || targetReplaced) {
        cancelActive();
        sheetOpen = false;
        confirmationOpen = false;
        clearCapture();
        operation = idleOperation();
        return publish();
      }
      const epochChanged = context.snapshot.epoch !== previousEpoch;
      if (
        activeRequest?.kind === "start" &&
        (epochChanged || !availability.writeEnabled)
      ) {
        cancelActive();
        confirmationOpen = false;
        operation = failureOperation(unknownStartFailure());
      } else if (
        activeRequest?.kind === "read" &&
        (epochChanged || !availability.readEnabled)
      ) {
        cancelActive();
        confirmationOpen = false;
        operation = data === null
          ? failureOperation({
              kind: "read",
              message: "Session state changed before compact progress could be loaded. Refresh Session Detail."
            })
          : idleOperation();
      } else if (confirmationOpen && (epochChanged || !availability.writeEnabled)) {
        confirmationOpen = false;
      }
      return publish();
    },
    async open(): Promise<CompactControlView> {
      if (closed || sheetOpen || !currentView.actionEnabled) return currentView;
      sheetOpen = true;
      confirmationOpen = false;
      clearCapture();
      operation = idleOperation();
      publish();
      return runRead();
    },
    check(): Promise<CompactControlView> {
      if (closed || !sheetOpen || !currentView.checkEnabled) {
        return Promise.resolve(currentView);
      }
      return runRead();
    },
    beginConfirmation(): CompactControlView {
      if (closed || !sheetOpen || !currentView.startEnabled) return currentView;
      confirmationOpen = true;
      return publish();
    },
    cancelConfirmation(): CompactControlView {
      if (closed || !confirmationOpen || operation.phase === "submitting") return currentView;
      confirmationOpen = false;
      return publish();
    },
    async confirm(): Promise<CompactControlView> {
      if (closed || !sheetOpen || !currentView.confirmEnabled || activeRequest !== null) {
        return currentView;
      }
      let operationId: string;
      let request: CompactStartRequest;
      try {
        operationId = createOperationId();
        request = compactStartRequestSchema.parse({
          operation_id: operationId,
          kind: "compact",
          confirm: true
        });
      } catch {
        confirmationOpen = false;
        operation = failureOperation({
          kind: "start",
          message: "Secure Compact request setup is unavailable. Reload HostDeck."
        });
        return publish();
      }
      const availability = deriveAvailability(context.snapshot, sessionId);
      if (
        !availability.writeEnabled ||
        availability.targetKey === null ||
        availability.authorityKey === null
      ) {
        confirmationOpen = false;
        return publish();
      }
      cancelActive();
      const requestController = new AbortController();
      const requestSequence = sequence;
      activeRequest = Object.freeze({
        sequence: requestSequence,
        kind: "start" as const,
        targetKey: availability.targetKey,
        authorityKey: availability.authorityKey,
        controller: requestController
      });
      confirmationOpen = false;
      operation = deepFreeze({ phase: "submitting" as const, operationId });
      publish();
      try {
        const response = await Reflect.apply(port.start, undefined, [
          Object.freeze({ sessionId, request, signal: requestController.signal })
        ]);
        if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
        const settledAvailability = deriveAvailability(context.snapshot, sessionId);
        if (
          !settledAvailability.writeEnabled ||
          settledAvailability.targetKey !== availability.targetKey ||
          settledAvailability.authorityKey !== availability.authorityKey
        ) {
          throw new HostDeckCompactOutcomeUnknownError();
        }
        installCapture(response, operationId);
        operation = idleOperation();
        return publish();
      } catch (error) {
        if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
        operation = failureOperation(classifyStartFailure(error));
        return publish();
      } finally {
        if (activeRequest?.sequence === requestSequence) activeRequest = null;
      }
    },
    dismiss(): CompactControlView {
      if (closed || !sheetOpen || currentView.closeDisabled) return currentView;
      cancelActive();
      sheetOpen = false;
      confirmationOpen = false;
      clearCapture();
      operation = idleOperation();
      return publish();
    },
    close(): CompactControlView {
      if (closed) return currentView;
      closed = true;
      cancelActive();
      sheetOpen = false;
      confirmationOpen = false;
      clearCapture();
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
): CompactControlAvailability {
  const detail = matchingSession(snapshot, sessionId);
  const visible =
    detail !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null) {
    return availability(
      false,
      null,
      null,
      null,
      false,
      "Session details are not available.",
      false,
      "Session details are not available."
    );
  }
  const authorityKey = readAuthorityKey(snapshot);
  const targetKey = compactTargetKey(detail);
  const currentConnection =
    snapshot.access.state === "current" &&
    snapshot.targetState.state === "current" &&
    authorityKey !== null;
  let readReason: string | null = null;
  if (detail.archived_at !== null || detail.session_state === "archived") {
    readReason = "Archived sessions do not have current Compact progress.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    readReason = "Session state is stale. Refresh Session Detail before loading Compact progress.";
  } else if (!currentConnection) {
    readReason = "Connection state is not current. Refresh Session Detail before loading Compact progress.";
  }
  let writeReason = writeEligibilityReason(snapshot.writeEligibility.causes[0]);
  if (readReason !== null) {
    writeReason = readReason;
  } else if (!terminalTurnStates.has(detail.turn_state)) {
    writeReason = turnWriteReason(detail.turn_state);
  }
  const readEnabled = readReason === null;
  const writeEnabled =
    readEnabled &&
    snapshot.writeEligibility.eligible &&
    writeReason === null;
  return availability(
    true,
    detail.name,
    targetKey,
    authorityKey,
    readEnabled,
    readReason,
    writeEnabled,
    writeReason
  );
}

function deriveStatus(input: Readonly<{
  availability: CompactControlAvailability;
  confirmationOpen: boolean;
  data: CompactProgressResponse | null;
  operation: CompactControlOperation;
  sheetOpen: boolean;
  stale: boolean;
}>): Readonly<{
  phase: CompactControlPhase;
  tone: CompactControlTone;
  label: string;
  detail: string | null;
}> {
  if (!input.availability.visible) {
    return status("hidden", "muted", "Compact unavailable", null);
  }
  if (!input.sheetOpen) {
    return status(
      "closed",
      input.availability.readEnabled ? "focus" : "attention",
      "Compact closed",
      input.availability.readReason
    );
  }
  if (input.operation.phase === "submitting") {
    return status(
      "submitting",
      "attention",
      "Submitting compaction",
      "Waiting only for HostDeck to confirm acceptance. Completion requires later runtime evidence."
    );
  }
  if (input.confirmationOpen) {
    return status(
      "confirming",
      "attention",
      "Confirm context compaction",
      "No request is sent until the final confirmation."
    );
  }
  if (input.operation.phase === "loading") {
    return input.data === null
      ? status("loading", "attention", "Loading Compact progress", "Reading current laptop state.")
      : status("stale", "attention", "Checking Compact progress", "The previous result remains stale until this read succeeds.");
  }
  if (input.operation.phase === "failure") {
    switch (input.operation.failure.kind) {
      case "unsupported":
        return status("unsupported", "attention", "Compact unavailable", input.operation.failure.message);
      case "conflict":
        return status("conflict", "attention", "Compaction conflicts with current state", input.operation.failure.message);
      case "unknown":
        return status("outcome_unknown", "danger", "Compaction outcome unknown", input.operation.failure.message);
      case "start":
        return status("start_failure", "danger", "Compaction was not started", input.operation.failure.message);
      case "read":
        return status("read_failure", "danger", "Compact progress could not be loaded", input.operation.failure.message);
    }
  }
  if (input.data === null) {
    return status("loading", "muted", "Compact progress unavailable", "Open this utility again to load current state.");
  }
  if (input.stale) {
    return status("stale", "attention", "Compact progress is stale", "Check progress before taking another action.");
  }
  const progress = input.data.progress;
  if (progress === null) {
    return status("ready", "focus", "No tracked compaction", input.availability.writeReason ?? "A confirmed compaction can start for this idle session.");
  }
  switch (progress.state) {
    case "accepted":
      return status("accepted", "attention", "Compaction accepted", "The laptop accepted this request; start and completion are not confirmed yet.");
    case "running":
      return status("running", "focus", "Compacting context", "Context compaction is running; completion is not confirmed yet.");
    case "completed":
      return status("completed", "connected", "Compaction completed", "Runtime item and turn completion were both confirmed.");
    case "interrupted":
      return status("interrupted", "attention", "Compaction interrupted", "Runtime turn evidence confirmed interruption.");
    case "failed":
      return status("failed", "danger", "Compaction failed", progressErrorMessage(progress.error));
    case "incomplete":
      return status("incomplete", "danger", "Compaction outcome incomplete", "HostDeck cannot confirm a final result. Check progress; do not resend.");
  }
}

function freezeResponse(
  candidate: unknown,
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId,
  expectedOperationId: string | null
): CompactProgressResponse {
  const response = compactProgressResponseSchema.parse(candidate);
  const detail = matchingSession(snapshot, sessionId);
  const progress = response.progress;
  if (
    detail === null ||
    (progress !== null &&
      (progress.target.session_id !== sessionId ||
        progress.target.codex_thread_id !== detail.codex_thread_id))
  ) {
    throw new TypeError("HostDeck Compact response target is invalid.");
  }
  if (
    expectedOperationId !== null &&
    (progress === null ||
      progress.operation_id !== expectedOperationId ||
      progress.state !== "accepted" ||
      progress.turn_id !== null ||
      progress.error !== null)
  ) {
    throw new HostDeckCompactOutcomeUnknownError();
  }
  return deepFreeze(response);
}

function projectProgress(
  progress: NonNullable<CompactProgressResponse["progress"]>,
  stale: boolean
): CompactProgressView {
  const projected = progressStatus(progress);
  return deepFreeze({
    state: progress.state,
    label: projected.label,
    detail: projected.detail,
    tone: projected.tone,
    updatedAt: progress.updated_at,
    freshness: stale ? "stale" : "current",
    retryable: progress.state === "failed" && progress.error?.retryable === true
  });
}

function progressStatus(
  progress: NonNullable<CompactProgressResponse["progress"]>
): Readonly<{ label: string; detail: string; tone: CompactControlTone }> {
  switch (progress.state) {
    case "accepted":
      return Object.freeze({ label: "Accepted", detail: "Waiting for runtime progress", tone: "attention" });
    case "running":
      return Object.freeze({ label: "Compacting", detail: "Context compaction is running", tone: "focus" });
    case "completed":
      return Object.freeze({ label: "Completed", detail: "Item and turn completion confirmed", tone: "connected" });
    case "interrupted":
      return Object.freeze({ label: "Interrupted", detail: "Runtime interruption confirmed", tone: "attention" });
    case "failed":
      return Object.freeze({ label: "Failed", detail: progressErrorMessage(progress.error), tone: "danger" });
    case "incomplete":
      return Object.freeze({ label: "Incomplete", detail: "Final result could not be confirmed", tone: "danger" });
  }
}

function isStartableProgress(
  progress: CompactProgressResponse["progress"]
): boolean {
  return progress === null ||
    progress.state === "completed" ||
    progress.state === "interrupted" ||
    (progress.state === "failed" && progress.error?.retryable === true);
}

function classifyReadFailure(error: unknown): CompactControlFailure {
  const apiError = browserApiError(error);
  if (apiError !== null) {
    const unsupported = ["capability_unavailable", "incompatible_runtime"].includes(apiError.code);
    return deepFreeze({
      kind: unsupported ? "unsupported" as const : "read" as const,
      message: compactReadFailureMessage(apiError)
    });
  }
  if (error instanceof HostDeckBrowserConnectionError) {
    return deepFreeze({
      kind: "read" as const,
      message: error.reason === "closed"
        ? "HostDeck closed before Compact progress could be loaded. Reload to continue."
        : "Session access is not current. Refresh Session Detail before trying again."
    });
  }
  return deepFreeze({
    kind: "read" as const,
    message: "Compact progress could not be loaded. Check the connection and try again."
  });
}

function classifyStartFailure(error: unknown): CompactControlFailure {
  if (error instanceof HostDeckCompactOutcomeUnknownError) return unknownStartFailure();
  const apiError = browserApiError(error);
  if (apiError !== null) {
    if (apiError.code === "operation_conflict") {
      return deepFreeze({
        kind: "conflict" as const,
        message: "Current turn or Compact progress changed. Check progress before another action."
      });
    }
    if (ambiguousStartCodes.has(apiError.code)) return unknownStartFailure();
    return deepFreeze({ kind: "start" as const, message: compactStartFailureMessage(apiError) });
  }
  if (error instanceof HostDeckBrowserConnectionError) {
    return deepFreeze({
      kind: "start" as const,
      message: "Compact write access was not ready. Check current progress before trying again."
    });
  }
  if (
    error instanceof HostDeckBrowserCsrfError &&
    ["client_contract", "not_ready", "bootstrap_unavailable"].includes(error.reason)
  ) {
    return deepFreeze({
      kind: "start" as const,
      message: "Secure Compact access was not ready. Check current progress before trying again."
    });
  }
  return unknownStartFailure();
}

function browserApiError(error: unknown): ApiErrorEnvelope | null {
  if (error instanceof HostDeckBrowserHttpError) return error.apiError;
  if (error instanceof HostDeckBrowserCsrfError) return error.apiError;
  return null;
}

function unknownStartFailure(): CompactControlFailure {
  return deepFreeze({
    kind: "unknown" as const,
    message: "HostDeck will not resend this request. Check current Compact progress before any new attempt."
  });
}

function compactReadFailureMessage(error: ApiErrorEnvelope): string {
  switch (error.code) {
    case "session_not_found":
      return "This session no longer exists.";
    case "session_not_writable":
    case "stale_session":
    case "invalid_session_id":
      return "Session state changed. Refresh Session Detail before trying again.";
    case "permission_denied":
    case "read_only":
      return "This phone cannot read Compact progress for this session.";
    case "runtime_unavailable":
      return "The Codex runtime is unavailable. Check the laptop and try again.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The installed Codex runtime does not support Compact control.";
    case "operation_timeout":
      return "The Compact progress read timed out.";
    case "rate_limited":
      return "Compact progress reads are temporarily rate limited.";
    case "service_overloaded":
      return "HostDeck is temporarily too busy to read Compact progress.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure Compact access was rejected.";
    default:
      return "HostDeck could not verify current Compact progress.";
  }
}

function compactStartFailureMessage(error: ApiErrorEnvelope): string {
  switch (error.code) {
    case "permission_denied":
      return "Compact write access is no longer valid. Check current progress.";
    case "read_only":
      return "Read-only access cannot start context compaction.";
    case "host_locked":
      return hostLockWriteReason("host_locked");
    case "session_not_found":
      return "This session no longer exists.";
    case "validation_error":
    case "invalid_session_id":
      return "The Compact request was rejected before it was sent. Reload HostDeck.";
    case "rate_limited":
      return "Compact starts are temporarily rate limited. Check progress before trying again.";
    case "service_overloaded":
      return "HostDeck was too busy to start compaction. Check progress before trying again.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure Compact access was rejected.";
    default:
      return "HostDeck could not start context compaction. Check progress before trying again.";
  }
}

function progressErrorMessage(error: ApiErrorEnvelope | null): string {
  if (error === null) return "HostDeck could not verify why compaction failed.";
  switch (error.code) {
    case "operation_conflict":
      return "Runtime progress conflicts with the observed compaction lifecycle.";
    case "protocol_error":
      return "The laptop returned invalid compaction progress.";
    case "runtime_unavailable":
      return "Runtime continuity was lost during compaction.";
    case "session_not_writable":
    case "stale_session":
      return "The selected session became unavailable during compaction.";
    default:
      return error.retryable
        ? "Compaction failed with a result that permits another attempt. Refresh current state first."
        : "Compaction failed and cannot be retried from this result.";
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

function compactTargetKey(detail: NonNullable<ReturnType<typeof matchingSession>>): string {
  return JSON.stringify([
    detail.id,
    detail.codex_thread_id,
    detail.runtime_source,
    detail.runtime_version,
    detail.created_at
  ]);
}

function readAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  const access = snapshot.access.data;
  if (access === null || access.can_read_sessions !== true) return null;
  if (access.authentication_state === "paired_device") {
    if (
      access.device_id === null ||
      (access.permission !== "read" && access.permission !== "write")
    ) {
      return null;
    }
    return JSON.stringify(["paired_device", access.configured_origin, access.device_id]);
  }
  if (access.authentication_state === "local_admin") {
    return JSON.stringify(["local_admin", access.configured_origin]);
  }
  if (access.authentication_state === "unpaired" && access.network_mode === "loopback") {
    return JSON.stringify(["unpaired_loopback", access.configured_origin]);
  }
  return null;
}

function writeEligibilityReason(
  cause: BrowserConnectionWriteBlockCause | undefined
): string | null {
  if (cause === undefined) return null;
  switch (cause) {
    case "connection_not_current":
      return "Connection state is not current. Refresh before starting compaction.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied":
      return "Pair this phone again to start context compaction.";
    case "read_only_access":
      return "Read-only access can inspect progress but cannot start compaction.";
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

function turnWriteReason(turnState: string): string {
  switch (turnState) {
    case "in_progress":
      return "Wait for the active turn to finish before compacting context.";
    case "waiting_for_input":
      return "Respond to the waiting turn before compacting context.";
    case "waiting_for_approval":
      return "Resolve the pending approval before compacting context.";
    default:
      return "The turn is not confirmed idle or finished. Refresh before compacting context.";
  }
}

function operationDisabledReason(operation: CompactControlOperation): string | null {
  if (operation.phase === "loading") return "Wait for current Compact progress.";
  if (operation.phase === "submitting") return "A Compact start is already being submitted.";
  if (operation.phase === "failure") return operation.failure.message;
  return null;
}

function availability(
  visible: boolean,
  targetLabel: string | null,
  targetKey: string | null,
  authorityKey: string | null,
  readEnabled: boolean,
  readReason: string | null,
  writeEnabled: boolean,
  writeReason: string | null
): CompactControlAvailability {
  return Object.freeze({
    visible,
    targetLabel,
    targetKey,
    authorityKey,
    readEnabled,
    readReason,
    writeEnabled,
    writeReason
  });
}

function status(
  phase: CompactControlPhase,
  tone: CompactControlTone,
  label: string,
  detail: string | null
) {
  return Object.freeze({ phase, tone, label, detail });
}

function idleOperation(): CompactControlOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingOperation(): CompactControlOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureOperation(failure: CompactControlFailure): CompactControlOperation {
  return deepFreeze({ phase: "failure" as const, failure });
}

function parseCreateOptions(
  candidate: unknown
): CreateCompactControlControllerOptions {
  const value = readExactObject(
    candidate,
    ["sessionId", "context", "port", "createOperationId"] as const,
    "HostDeck compact-control options are invalid."
  );
  return Object.freeze({
    sessionId: value.sessionId as SessionId,
    context: value.context as CompactControlContext,
    port: value.port as CompactControlPort,
    createOperationId: value.createOperationId as () => string
  });
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseContext(candidate: unknown): CompactControlContext {
  const value = readExactObject(
    candidate,
    ["snapshot"] as const,
    "HostDeck compact-control context is invalid."
  );
  if (value.snapshot === null || typeof value.snapshot !== "object" || Array.isArray(value.snapshot)) {
    throw new TypeError("HostDeck compact-control context is invalid.");
  }
  return Object.freeze({ snapshot: value.snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): CompactControlPort {
  const value = readExactObject(
    candidate,
    ["read", "start"] as const,
    "HostDeck compact-control port is invalid."
  );
  if (typeof value.read !== "function" || typeof value.start !== "function") {
    throw new TypeError("HostDeck compact-control port is invalid.");
  }
  return Object.freeze({
    read: value.read as CompactControlPort["read"],
    start: value.start as CompactControlPort["start"]
  });
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck compact operation-id factory is invalid.");
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

function hiddenView(sessionId: SessionId): CompactControlView {
  return deepFreeze({
    visible: false,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    sheetOpen: false,
    sessionId,
    targetLabel: null,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Compact unavailable",
    statusDetail: null,
    busy: false,
    closeDisabled: false,
    checkEnabled: false,
    confirmationOpen: false,
    confirmEnabled: false,
    startActionVisible: false,
    startEnabled: false,
    startDisabledReason: null,
    startLabel: "Compact context" as const,
    hasCapture: false,
    captureFreshness: null,
    hasCurrentRead: false,
    progress: null
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
