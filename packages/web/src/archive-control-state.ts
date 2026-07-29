import {
  type ApiErrorEnvelope,
  type ArchiveSessionRequest,
  archiveSessionRequestSchema,
  selectedOperationDispatchSchema,
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

export const archiveControlPhases = Object.freeze([
  "hidden",
  "closed",
  "unavailable",
  "ready",
  "confirming",
  "submitting",
  "succeeded",
  "blocked",
  "not_completed",
  "outcome_unknown",
  "inconsistent"
] as const);

export type ArchiveControlPhase = (typeof archiveControlPhases)[number];
export type ArchiveControlTone = "connected" | "attention" | "danger" | "focus" | "muted";
export type ArchiveResultKind =
  | "succeeded"
  | "blocked"
  | "not_completed"
  | "outcome_unknown"
  | "inconsistent";

export interface ArchiveControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface ArchiveSubmitInput {
  readonly sessionId: SessionId;
  readonly request: ArchiveSessionRequest;
  readonly signal: AbortSignal;
}

export interface ArchiveControlPort {
  readonly archive: (input: ArchiveSubmitInput) => Promise<unknown>;
}

export interface CreateArchiveControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: ArchiveControlContext;
  readonly port: ArchiveControlPort;
  readonly createOperationId: () => string;
}

export interface ArchiveTargetView {
  readonly sessionLabel: string;
}

export interface ArchiveResultView {
  readonly kind: ArchiveResultKind;
  readonly source: "api" | "browser";
  readonly label: string;
  readonly detail: string;
  readonly consequence: string;
  readonly returnToSessions: boolean;
}

export interface ArchiveControlView {
  readonly visible: boolean;
  readonly sheetOpen: boolean;
  readonly phase: ArchiveControlPhase;
  readonly tone: ArchiveControlTone;
  readonly title: string;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly targetLabel: string | null;
  readonly target: ArchiveTargetView | null;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly confirmationOpen: boolean;
  readonly confirmEnabled: boolean;
  readonly busy: boolean;
  readonly closeDisabled: boolean;
  readonly resultOpen: boolean;
  readonly result: ArchiveResultView | null;
}

export interface ArchiveControlController {
  readonly snapshot: () => ArchiveControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: ArchiveControlContext) => ArchiveControlView;
  readonly open: () => ArchiveControlView;
  readonly beginConfirmation: () => ArchiveControlView;
  readonly cancelConfirmation: () => ArchiveControlView;
  readonly confirm: () => Promise<ArchiveControlView>;
  readonly acknowledgeResult: () => ArchiveControlView;
  readonly dismiss: () => ArchiveControlView;
  readonly close: () => ArchiveControlView;
}

interface ArchiveExactTarget {
  readonly sessionId: SessionId;
  readonly sessionLabel: string;
  readonly threadId: string;
  readonly runtimeSource: string;
  readonly runtimeVersion: string;
  readonly createdAt: string;
  readonly targetKey: string;
}

interface ArchiveAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly authorityKey: string | null;
  readonly target: ArchiveExactTarget | null;
  readonly actionEnabled: boolean;
  readonly reason: string | null;
}

interface ArchiveAttempt {
  readonly sequence: number;
  readonly operationId: string;
  readonly target: ArchiveExactTarget;
  readonly controller: AbortController;
  phase: "submitting" | "settled";
  acknowledged: boolean;
  identityInvalidated: boolean;
  result: ArchiveResultView | null;
}

const maximumSubscribers = 32;

export function createArchiveControlController(
  candidateOptions: CreateArchiveControlControllerOptions
): ArchiveControlController {
  const options = parseCreateOptions(candidateOptions);
  const sessionId = sessionIdSchema.parse(options.sessionId) as SessionId;
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  let sheetOpen = false;
  let confirmationTarget: ArchiveExactTarget | null = null;
  let confirmationAuthorityKey: string | null = null;
  let attempt: ArchiveAttempt | null = null;
  let activePromise: Promise<ArchiveControlView> | null = null;
  let attempted = false;
  let sequence = 0;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): ArchiveControlView {
    if (closed) return hiddenView();
    const availability = deriveAvailability(context, sessionId);
    const resultOpen = sheetOpen && attempt?.phase === "settled" && !attempt.acknowledged;
    const actionEnabled =
      availability.actionEnabled &&
      !attempted &&
      attempt?.phase !== "submitting";
    const actionDisabledReason = actionEnabled
      ? null
      : attempt?.phase === "submitting"
        ? "One archive request is already waiting for laptop confirmation."
        : attempted
          ? "An archive was already submitted for this session."
          : availability.reason;
    const confirmationOpen = sheetOpen && confirmationTarget !== null;
    const successResultOpen = resultOpen && attempt?.result?.kind === "succeeded";
    const discloseTarget = availability.visible;
    const target = discloseTarget
      ? attempt !== null && (attempt.phase === "submitting" || resultOpen)
        ? attempt.target
        : confirmationTarget ?? availability.target
      : null;
    const statusValue = deriveStatus({
      availability,
      actionEnabled,
      actionDisabledReason,
      attempt,
      confirmationOpen,
      resultOpen,
      sheetOpen
    });

    return deepFreeze({
      visible: availability.visible,
      sheetOpen,
      phase: statusValue.phase,
      tone: statusValue.tone,
      title: statusValue.title,
      status: statusValue.status,
      statusDetail: statusValue.detail,
      targetLabel: target?.sessionLabel ?? availability.targetLabel,
      target: target === null ? null : targetView(target),
      actionEnabled,
      actionDisabledReason,
      confirmationOpen,
      confirmEnabled:
        confirmationOpen &&
        confirmationStillCurrent(availability) &&
        attempt?.phase !== "submitting",
      busy: attempt?.phase === "submitting",
      closeDisabled: attempt?.phase === "submitting" || successResultOpen,
      resultOpen,
      result: resultOpen ? attempt?.result ?? null : null
    });
  }

  const publish = (): ArchiveControlView => {
    currentView = project();
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  function confirmationStillCurrent(availability: ArchiveAvailability): boolean {
    return confirmationTarget !== null &&
      confirmationAuthorityKey !== null &&
      availability.actionEnabled &&
      availability.target?.targetKey === confirmationTarget.targetKey &&
      availability.authorityKey === confirmationAuthorityKey;
  }

  const controller: ArchiveControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck archive-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck archive-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: ArchiveControlContext): ArchiveControlView {
      if (closed) throw new TypeError("HostDeck archive control is closed.");
      const parsedContext = parseContext(nextContext);
      if (attempt !== null && targetIdentityChanged(parsedContext.snapshot, attempt.target)) {
        attempt.identityInvalidated = true;
        if (attempt.phase === "settled" && attempt.result?.kind === "succeeded") {
          attempt.result = inconsistentResult();
        }
      }
      context = parsedContext;
      const availability = deriveAvailability(context, sessionId);
      if (confirmationTarget !== null && !confirmationStillCurrent(availability)) {
        confirmationTarget = null;
        confirmationAuthorityKey = null;
      }
      return publish();
    },
    open(): ArchiveControlView {
      if (closed || sheetOpen) return currentView;
      sheetOpen = true;
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      return publish();
    },
    beginConfirmation(): ArchiveControlView {
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
    cancelConfirmation(): ArchiveControlView {
      if (closed || confirmationTarget === null || attempt?.phase === "submitting") {
        return currentView;
      }
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      return publish();
    },
    confirm(): Promise<ArchiveControlView> {
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
      let request: ArchiveSessionRequest;
      try {
        operationId = createOperationId();
        request = archiveSessionRequestSchema.parse({
          operation_id: operationId,
          kind: "archive",
          confirm: true
        });
      } catch {
        sequence += 1;
        attempted = true;
        attempt = {
          sequence,
          operationId: "",
          target: availability.target,
          controller: new AbortController(),
          phase: "settled",
          acknowledged: false,
          identityInvalidated: false,
          result: setupFailureResult()
        };
        confirmationTarget = null;
        confirmationAuthorityKey = null;
        return Promise.resolve(publish());
      }

      const requestController = new AbortController();
      sequence += 1;
      attempted = true;
      attempt = {
        sequence,
        operationId,
        target: availability.target,
        controller: requestController,
        phase: "submitting",
        acknowledged: false,
        identityInvalidated: false,
        result: null
      };
      const activeAttempt = attempt;
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      publish();

      const pending = runArchiveAttempt(activeAttempt, request);
      activePromise = pending;
      return pending;
    },
    acknowledgeResult(): ArchiveControlView {
      if (closed || attempt === null || attempt.phase !== "settled") return currentView;
      attempt.acknowledged = true;
      return publish();
    },
    dismiss(): ArchiveControlView {
      if (closed || !sheetOpen || currentView.closeDisabled) return currentView;
      if (attempt?.phase === "settled") attempt.acknowledged = true;
      sheetOpen = false;
      confirmationTarget = null;
      confirmationAuthorityKey = null;
      return publish();
    },
    close(): ArchiveControlView {
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

  async function runArchiveAttempt(
    activeAttempt: ArchiveAttempt,
    request: ArchiveSessionRequest
  ): Promise<ArchiveControlView> {
    try {
      const response = await Promise.resolve().then(() =>
        Reflect.apply(port.archive, undefined, [
          Object.freeze({
            sessionId,
            request,
            signal: activeAttempt.controller.signal
          })
        ])
      );
      if (closed || attempt !== activeAttempt || activeAttempt.sequence !== sequence) {
        return currentView;
      }
      activeAttempt.result = activeAttempt.identityInvalidated
        ? inconsistentResult()
        : validateSuccess(response, activeAttempt);
    } catch (error) {
      if (closed || attempt !== activeAttempt || activeAttempt.sequence !== sequence) {
        return currentView;
      }
      activeAttempt.result = activeAttempt.identityInvalidated
        ? inconsistentResult()
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
  context: ArchiveControlContext,
  sessionId: SessionId
): ArchiveAvailability {
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
    reason = "This session is already archived.";
  } else if (detail.session_state === "incompatible") {
    reason = "The selected runtime is incompatible. Archive is unavailable.";
  } else if (
    detail.session_state !== "active" ||
    detail.freshness !== "current"
  ) {
    reason = "Session state is stale. Refresh Session Detail before archiving.";
  } else if (detail.turn_state !== "idle") {
    reason = nonIdleReason(detail.turn_state);
  } else if (snapshot.access.state !== "current" || snapshot.targetState.state !== "current") {
    reason = "Connection state is not current. Refresh Session Detail before archiving.";
  } else if (snapshot.stream.state !== "connected") {
    reason = snapshot.stream.state === "failed"
      ? "Live session state is unavailable. Refresh before archiving."
      : "Live session state is reconnecting. Wait before archiving.";
  } else if (
    snapshot.stream.continuity !== "contiguous" &&
    snapshot.stream.continuity !== "boundary"
  ) {
    reason = "Session activity continuity is not proven yet.";
  }

  const authorityKey = writeAuthorityKey(snapshot);
  if (reason === null) reason = writeEligibilityReason(snapshot.writeEligibility.causes[0]);
  if (reason === null && !snapshot.writeEligibility.eligible) {
    reason = "Secure write access is not ready.";
  }
  if (reason === null && authorityKey === null) {
    reason = "Current archive access is not available.";
  }
  const target = reason === null ? exactTarget(detail, sessionId) : null;

  return availability(
    true,
    detail.name,
    authorityKey,
    target,
    reason === null && target !== null && authorityKey !== null,
    reason
  );
}

function exactTarget(
  detail: NonNullable<ReturnType<typeof matchingSession>>,
  sessionId: SessionId
): ArchiveExactTarget {
  return Object.freeze({
    sessionId,
    sessionLabel: detail.name,
    threadId: detail.codex_thread_id,
    runtimeSource: detail.runtime_source,
    runtimeVersion: detail.runtime_version,
    createdAt: detail.created_at,
    targetKey: JSON.stringify([
      sessionId,
      detail.name,
      detail.codex_thread_id,
      detail.runtime_source,
      detail.runtime_version,
      detail.created_at
    ])
  });
}

function targetIdentityChanged(
  snapshot: BrowserConnectionSnapshot,
  target: ArchiveExactTarget
): boolean {
  const detail = matchingSession(snapshot, target.sessionId);
  return detail !== null && (
    detail.name !== target.sessionLabel ||
    detail.codex_thread_id !== target.threadId ||
    detail.runtime_source !== target.runtimeSource ||
    detail.runtime_version !== target.runtimeVersion ||
    detail.created_at !== target.createdAt
  );
}

function validateSuccess(
  candidate: unknown,
  attempt: ArchiveAttempt
): ArchiveResultView {
  const response = selectedOperationDispatchSchema.parse(candidate);
  if (
    response.state !== "accepted" ||
    response.kind !== "archive" ||
    response.operation_id !== attempt.operationId ||
    response.target.type !== "managed_session" ||
    response.target.session_id !== attempt.target.sessionId ||
    response.target.codex_thread_id !== attempt.target.threadId
  ) {
    throw new TypeError("HostDeck archive response target is invalid.");
  }
  return deepFreeze({
    kind: "succeeded" as const,
    source: "api" as const,
    label: "Session archived",
    detail: "The laptop confirmed the Codex thread is archived and HostDeck saved the local archive state.",
    consequence: "Retained conversation history was not deleted.",
    returnToSessions: true
  });
}

function classifyAttemptFailure(error: unknown): ArchiveResultView {
  const apiError = browserApiError(error);
  if (
    apiError !== null &&
    ["permission_denied", "read_only", "host_locked", "invalid_origin", "insecure_transport"]
      .includes(apiError.code)
  ) {
    return blockedResult(apiError.code);
  }
  if (
    apiError !== null &&
    ["session_not_found", "session_not_writable", "stale_session", "incompatible_runtime"]
      .includes(apiError.code)
  ) {
    return notCompletedResult(apiError.code);
  }
  const authorityFailure =
    error instanceof HostDeckBrowserConnectionError ||
    (error instanceof HostDeckBrowserCsrfError &&
      ["authority_rejected", "not_ready"].includes(error.reason));
  if (authorityFailure) return blockedResult(null);
  return outcomeUnknownResult();
}

function blockedResult(code: string | null): ArchiveResultView {
  const detail = code === "read_only"
    ? "Read-only access cannot archive a session. HostDeck sent no retry."
    : code === "host_locked"
      ? `${hostLockWriteReason("host_locked")} HostDeck sent no retry.`
      : "Current secure archive access was rejected. HostDeck sent no retry.";
  return deepFreeze({
    kind: "blocked" as const,
    source: "browser" as const,
    label: "Archive blocked",
    detail,
    consequence: "The current session remains available.",
    returnToSessions: false
  });
}

function notCompletedResult(code: string): ArchiveResultView {
  const detail = code === "session_not_found"
    ? "The managed session was no longer available for this archive request."
    : code === "incompatible_runtime"
      ? "The selected runtime could not archive this managed session."
      : "The managed session was no longer current and idle for archive.";
  return deepFreeze({
    kind: "not_completed" as const,
    source: "api" as const,
    label: "Archive not completed",
    detail,
    consequence: "HostDeck did not remove the current session and sent no retry.",
    returnToSessions: false
  });
}

function outcomeUnknownResult(): ArchiveResultView {
  return deepFreeze({
    kind: "outcome_unknown" as const,
    source: "browser" as const,
    label: "Archive outcome not confirmed",
    detail: "The laptop may have archived the thread, or HostDeck may still need to check local archive state.",
    consequence: "This session remains on screen. HostDeck sent no retry.",
    returnToSessions: false
  });
}

function inconsistentResult(): ArchiveResultView {
  return deepFreeze({
    kind: "inconsistent" as const,
    source: "browser" as const,
    label: "Archive state inconsistent",
    detail: "The selected session identity changed while the archive result was settling.",
    consequence: "This session remains on screen. Refresh before taking another action.",
    returnToSessions: false
  });
}

function setupFailureResult(): ArchiveResultView {
  return deepFreeze({
    kind: "blocked" as const,
    source: "browser" as const,
    label: "Secure archive setup unavailable",
    detail: "HostDeck could not create a secure archive request. No request was sent.",
    consequence: "Reload HostDeck before attempting archive again.",
    returnToSessions: false
  });
}

function browserApiError(error: unknown): ApiErrorEnvelope | null {
  if (error instanceof HostDeckBrowserHttpError || error instanceof HostDeckBrowserCsrfError) {
    return error.apiError;
  }
  return null;
}

function deriveStatus(input: Readonly<{
  availability: ArchiveAvailability;
  actionEnabled: boolean;
  actionDisabledReason: string | null;
  attempt: ArchiveAttempt | null;
  confirmationOpen: boolean;
  resultOpen: boolean;
  sheetOpen: boolean;
}>): Readonly<{
  phase: ArchiveControlPhase;
  tone: ArchiveControlTone;
  title: string;
  status: string;
  detail: string | null;
}> {
  if (!input.sheetOpen) {
    return input.availability.visible
      ? status(
          "closed",
          input.actionEnabled ? "focus" : "attention",
          "Archive session",
          "Session actions closed",
          input.actionDisabledReason
        )
      : status("hidden", "muted", "Archive session", "Archive unavailable", null);
  }
  if (input.attempt?.phase === "submitting") {
    return status(
      "submitting",
      "attention",
      "Archive session?",
      "Waiting for laptop confirmation",
      "HostDeck sent one archive request and is waiting for the laptop result."
    );
  }
  if (input.resultOpen && input.attempt?.result !== null) {
    const result = input.attempt?.result;
    if (result !== undefined) {
      return status(
        result.kind,
        result.kind === "succeeded"
          ? "connected"
          : result.kind === "not_completed"
            ? "attention"
            : "danger",
        result.label,
        result.label,
        result.detail
      );
    }
  }
  if (input.confirmationOpen) {
    return status(
      "confirming",
      "danger",
      "Archive session?",
      "Confirmation required",
      "No request is sent until you confirm this exact session."
    );
  }
  if (!input.actionEnabled) {
    return status(
      "unavailable",
      "attention",
      "Archive session",
      "Archive unavailable",
      input.actionDisabledReason
    );
  }
  return status(
    "ready",
    "focus",
    "Archive session",
    "Idle session ready",
    "Archive requires explicit confirmation."
  );
}

function status(
  phase: ArchiveControlPhase,
  tone: ArchiveControlTone,
  title: string,
  statusText: string,
  detail: string | null
) {
  return Object.freeze({ phase, tone, title, status: statusText, detail });
}

function nonIdleReason(state: string): string {
  switch (state) {
    case "in_progress":
    case "waiting_for_input":
    case "waiting_for_approval":
      return "Finish or interrupt the active turn before archiving.";
    case "completed": return "Refresh Session Detail before archiving this completed turn state.";
    case "interrupted": return "Refresh Session Detail before archiving this interrupted turn state.";
    case "failed": return "Refresh Session Detail before archiving this failed turn state.";
    case "unknown": return "The current turn state is unknown. Refresh before archiving.";
    default: return "The current session is not idle for archive.";
  }
}

function writeEligibilityReason(
  cause: BrowserConnectionWriteBlockCause | undefined
): string | null {
  if (cause === undefined) return null;
  switch (cause) {
    case "connection_not_current": return "Connection state is not current. Refresh before archiving.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied": return "Pair this phone again before archiving a session.";
    case "read_only_access": return "Read-only access cannot archive a session.";
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

function availability(
  visible: boolean,
  targetLabel: string | null,
  authorityKey: string | null,
  target: ArchiveExactTarget | null,
  actionEnabled: boolean,
  reason: string | null
): ArchiveAvailability {
  return Object.freeze({ visible, targetLabel, authorityKey, target, actionEnabled, reason });
}

function targetView(target: ArchiveExactTarget): ArchiveTargetView {
  return Object.freeze({ sessionLabel: target.sessionLabel });
}

function parseCreateOptions(
  candidate: unknown
): CreateArchiveControlControllerOptions {
  const value = readExactObject(
    candidate,
    ["sessionId", "context", "port", "createOperationId"] as const,
    "HostDeck archive-control options are invalid."
  );
  return Object.freeze({
    sessionId: value.sessionId as SessionId,
    context: value.context as ArchiveControlContext,
    port: value.port as ArchiveControlPort,
    createOperationId: value.createOperationId as () => string
  });
}

function parseContext(candidate: unknown): ArchiveControlContext {
  const value = readExactObject(
    candidate,
    ["snapshot"] as const,
    "HostDeck archive-control context is invalid."
  );
  if (
    value.snapshot === null ||
    typeof value.snapshot !== "object" ||
    Array.isArray(value.snapshot) ||
    !Number.isSafeInteger((value.snapshot as BrowserConnectionSnapshot).epoch) ||
    (value.snapshot as BrowserConnectionSnapshot).epoch < 0
  ) {
    throw new TypeError("HostDeck archive-control context is invalid.");
  }
  return Object.freeze({ snapshot: value.snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): ArchiveControlPort {
  const value = readExactObject(
    candidate,
    ["archive"] as const,
    "HostDeck archive-control port is invalid."
  );
  if (typeof value.archive !== "function") {
    throw new TypeError("HostDeck archive-control port is invalid.");
  }
  return Object.freeze({ archive: value.archive as ArchiveControlPort["archive"] });
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck archive operation-id factory is invalid.");
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

function hiddenView(): ArchiveControlView {
  return deepFreeze({
    visible: false,
    sheetOpen: false,
    phase: "hidden" as const,
    tone: "muted" as const,
    title: "Archive session",
    status: "Archive unavailable",
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
