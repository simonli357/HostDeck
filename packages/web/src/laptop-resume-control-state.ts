import {
  type ApiErrorEnvelope,
  deepFreezeExactData, 
  selectedLaptopResumeSchema,
  selectedResumeMetadataResponseSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  type BrowserConnectionSnapshot,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import {
  type BrowserHttpFailureReason,
  HostDeckBrowserHttpError
} from "./http-client.js";

export const laptopResumeControlPhases = Object.freeze([
  "hidden",
  "closed",
  "loading",
  "available",
  "unavailable",
  "stale",
  "not_found",
  "stale_session",
  "runtime_unavailable",
  "access_denied",
  "failure"
] as const);

export const laptopResumeCopyPhases = Object.freeze([
  "idle",
  "copying",
  "copied",
  "failed"
] as const);

export type LaptopResumeControlPhase = (typeof laptopResumeControlPhases)[number];
export type LaptopResumeCopyPhase = (typeof laptopResumeCopyPhases)[number];
export type LaptopResumeControlTone =
  | "connected"
  | "attention"
  | "danger"
  | "focus"
  | "muted";

export interface LaptopResumeControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface LaptopResumeReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface LaptopResumeClipboardInput {
  readonly text: string;
}

export interface LaptopResumeControlPort {
  readonly read: (input: LaptopResumeReadInput) => Promise<unknown>;
  readonly writeClipboard: (input: LaptopResumeClipboardInput) => Promise<void>;
}

export interface CreateLaptopResumeControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: LaptopResumeControlContext;
  readonly port: LaptopResumeControlPort;
}

export interface LaptopResumeControlView {
  readonly visible: boolean;
  readonly sheetOpen: boolean;
  readonly phase: LaptopResumeControlPhase;
  readonly tone: LaptopResumeControlTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly busy: boolean;
  readonly refreshEnabled: boolean;
  readonly available: boolean | null;
  readonly unavailableReason: string | null;
  readonly command: string | null;
  readonly commandFreshness: "current" | "stale" | null;
  readonly copyEnabled: boolean;
  readonly copyPhase: LaptopResumeCopyPhase;
  readonly copyStatus: string | null;
  readonly copyStatusDetail: string | null;
}

export interface LaptopResumeControlController {
  readonly snapshot: () => LaptopResumeControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: LaptopResumeControlContext) => LaptopResumeControlView;
  readonly open: () => Promise<LaptopResumeControlView>;
  readonly refresh: () => Promise<LaptopResumeControlView>;
  readonly copy: () => Promise<LaptopResumeControlView>;
  readonly dismiss: () => LaptopResumeControlView;
  readonly close: () => LaptopResumeControlView;
}

interface LaptopResumeTarget {
  readonly sessionId: SessionId;
  readonly sessionLabel: string;
  readonly threadId: string;
  readonly targetKey: string;
}

interface LaptopResumeAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly target: LaptopResumeTarget | null;
  readonly targetKey: string | null;
  readonly authorityKey: string | null;
  readonly readEnabled: boolean;
  readonly reason: string | null;
}

interface LaptopResumeCapture {
  readonly epoch: number;
  readonly targetKey: string;
  readonly authorityKey: string;
  readonly available: boolean;
  readonly command: string | null;
  readonly unavailableReason: string | null;
}

type LaptopResumeReadFailureKind =
  | "not_found"
  | "stale_session"
  | "runtime_unavailable"
  | "access_denied"
  | "failure";

interface LaptopResumeReadFailure {
  readonly kind: LaptopResumeReadFailureKind;
  readonly message: string;
}

type LaptopResumeReadOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "failure"; failure: LaptopResumeReadFailure }>;

interface ActiveResumeRead {
  readonly sequence: number;
  readonly targetKey: string;
  readonly authorityKey: string;
  readonly controller: AbortController;
}

interface ActiveResumeCopy {
  readonly sequence: number;
  readonly targetKey: string;
  readonly authorityKey: string;
  readonly epoch: number;
  readonly command: string;
}

interface LaptopResumeCopyState {
  readonly phase: LaptopResumeCopyPhase;
}

const maximumSubscribers = 32;

export function createLaptopResumeControlController(
  candidateOptions: CreateLaptopResumeControlControllerOptions
): LaptopResumeControlController {
  const options = parseCreateOptions(candidateOptions);
  const sessionId = sessionIdSchema.parse(options.sessionId) as SessionId;
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  let sheetOpen = false;
  let capture: LaptopResumeCapture | null = null;
  let readOperation: LaptopResumeReadOperation = idleReadOperation();
  let copyState: LaptopResumeCopyState = idleCopyState();
  let activeRead: ActiveResumeRead | null = null;
  let activeCopy: ActiveResumeCopy | null = null;
  let readPromise: Promise<LaptopResumeControlView> | null = null;
  let copyPromise: Promise<LaptopResumeControlView> | null = null;
  let readSequence = 0;
  let copySequence = 0;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): LaptopResumeControlView {
    if (closed) return hiddenView(sessionId);
    const availability = deriveAvailability(context.snapshot, sessionId);
    const authorizedCapture =
      capture !== null &&
      availability.targetKey === capture.targetKey &&
      availability.authorityKey === capture.authorityKey;
    const projectedCapture = authorizedCapture ? capture : null;
    const captureStale =
      projectedCapture !== null &&
      (projectedCapture.epoch !== context.snapshot.epoch ||
        !availability.readEnabled ||
        readOperation.phase !== "idle");
    const statusValue = deriveStatus({
      availability,
      capture: projectedCapture,
      captureStale,
      operation: readOperation,
      sheetOpen: sheetOpen && availability.visible
    });
    const commandCurrent =
      projectedCapture?.available === true &&
      projectedCapture.command !== null &&
      !captureStale;
    const copyEnabled =
      sheetOpen &&
      availability.readEnabled &&
      commandCurrent &&
      copyState.phase !== "copying";
    const copyStatus = projectCopyStatus(copyState.phase);

    return deepFreezeExactData({
      visible: availability.visible,
      sheetOpen: sheetOpen && availability.visible,
      phase: statusValue.phase,
      tone: statusValue.tone,
      status: statusValue.status,
      statusDetail: statusValue.detail,
      sessionId,
      targetLabel: availability.targetLabel,
      actionEnabled: availability.readEnabled,
      actionDisabledReason: availability.reason,
      busy: readOperation.phase === "loading" || copyState.phase === "copying",
      refreshEnabled:
        sheetOpen &&
        availability.readEnabled &&
        readOperation.phase !== "loading" &&
        copyState.phase !== "copying",
      available: projectedCapture?.available ?? null,
      unavailableReason: projectedCapture?.unavailableReason ?? null,
      command: projectedCapture?.command ?? null,
      commandFreshness:
        projectedCapture?.command === null || projectedCapture?.command === undefined
          ? null
          : captureStale
            ? "stale"
            : "current",
      copyEnabled,
      copyPhase: copyState.phase,
      copyStatus: copyStatus.status,
      copyStatusDetail: copyStatus.detail
    });
  }

  const publish = (): LaptopResumeControlView => {
    currentView = project();
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  const nextReadSequence = (): number => {
    readSequence += 1;
    if (!Number.isSafeInteger(readSequence)) {
      throw new TypeError("HostDeck laptop-resume read sequence is exhausted.");
    }
    return readSequence;
  };

  const nextCopySequence = (): number => {
    copySequence += 1;
    if (!Number.isSafeInteger(copySequence)) {
      throw new TypeError("HostDeck laptop-resume copy sequence is exhausted.");
    }
    return copySequence;
  };

  const cancelRead = (): void => {
    nextReadSequence();
    activeRead?.controller.abort();
    activeRead = null;
    readPromise = null;
  };

  const invalidateCopy = (): void => {
    nextCopySequence();
    activeCopy = null;
    copyPromise = null;
  };

  const clearState = (): void => {
    capture = null;
    readOperation = idleReadOperation();
    copyState = idleCopyState();
  };

  const startRead = (): Promise<LaptopResumeControlView> => {
    if (readPromise !== null) return readPromise;
    if (closed || !sheetOpen || !currentView.actionEnabled) {
      return Promise.resolve(currentView);
    }
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (
      !availability.readEnabled ||
      availability.target === null ||
      availability.targetKey === null ||
      availability.authorityKey === null
    ) {
      return Promise.resolve(publish());
    }

    cancelRead();
    invalidateCopy();
    copyState = idleCopyState();
    const controller = new AbortController();
    const active: ActiveResumeRead = Object.freeze({
      sequence: readSequence,
      targetKey: availability.targetKey,
      authorityKey: availability.authorityKey,
      controller
    });
    activeRead = active;
    readOperation = loadingReadOperation();
    publish();

    const pending = runRead(active, availability.target);
    readPromise = pending;
    return pending;
  };

  const runRead = async (
    active: ActiveResumeRead,
    target: LaptopResumeTarget
  ): Promise<LaptopResumeControlView> => {
    try {
      const candidate = await Promise.resolve().then(() =>
        Reflect.apply(port.read, undefined, [
          Object.freeze({ sessionId, signal: active.controller.signal })
        ])
      );
      if (!readSettlementCurrent(active)) return currentView;
      const availability = deriveAvailability(context.snapshot, sessionId);
      if (
        availability.targetKey !== active.targetKey ||
        availability.authorityKey !== active.authorityKey ||
        !availability.readEnabled
      ) {
        throw new HostDeckBrowserConnectionError("not_ready");
      }
      capture = parseCapture(candidate, target, context.snapshot.epoch, active.authorityKey);
      readOperation = idleReadOperation();
      copyState = idleCopyState();
    } catch (error) {
      if (!readSettlementCurrent(active)) return currentView;
      readOperation = failureReadOperation(classifyReadFailure(error));
      copyState = idleCopyState();
    } finally {
      if (activeRead === active) {
        activeRead = null;
        readPromise = null;
      }
    }
    return closed ? currentView : publish();
  };

  const readSettlementCurrent = (active: ActiveResumeRead): boolean =>
    !closed &&
    sheetOpen &&
    activeRead === active &&
    active.sequence === readSequence;

  const runCopy = async (active: ActiveResumeCopy): Promise<LaptopResumeControlView> => {
    try {
      await Promise.resolve().then(() =>
        Reflect.apply(port.writeClipboard, undefined, [
          Object.freeze({ text: active.command })
        ])
      );
      if (!copySettlementCurrent(active)) return currentView;
      copyState = Object.freeze({ phase: "copied" as const });
    } catch {
      if (!copySettlementCurrent(active)) return currentView;
      copyState = Object.freeze({ phase: "failed" as const });
    } finally {
      if (activeCopy === active) {
        activeCopy = null;
        copyPromise = null;
      }
    }
    return closed ? currentView : publish();
  };

  const copySettlementCurrent = (active: ActiveResumeCopy): boolean => {
    if (
      closed ||
      !sheetOpen ||
      activeCopy !== active ||
      active.sequence !== copySequence ||
      capture === null
    ) {
      return false;
    }
    const availability = deriveAvailability(context.snapshot, sessionId);
    return (
      availability.readEnabled &&
      availability.targetKey === active.targetKey &&
      availability.authorityKey === active.authorityKey &&
      context.snapshot.epoch === active.epoch &&
      capture.targetKey === active.targetKey &&
      capture.authorityKey === active.authorityKey &&
      capture.epoch === active.epoch &&
      capture.available &&
      capture.command === active.command
    );
  };

  const controller: LaptopResumeControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck laptop-resume listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck laptop-resume listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: LaptopResumeControlContext): LaptopResumeControlView {
      if (closed) throw new TypeError("HostDeck laptop-resume control is closed.");
      const previousEpoch = context.snapshot.epoch;
      context = parseContext(nextContext);
      const availability = deriveAvailability(context.snapshot, sessionId);
      const authorityReplaced =
        (capture !== null && availability.authorityKey !== capture.authorityKey) ||
        (activeRead !== null && availability.authorityKey !== activeRead.authorityKey) ||
        (activeCopy !== null && availability.authorityKey !== activeCopy.authorityKey);
      const targetReplaced =
        (capture !== null && availability.targetKey !== capture.targetKey) ||
        (activeRead !== null && availability.targetKey !== activeRead.targetKey) ||
        (activeCopy !== null && availability.targetKey !== activeCopy.targetKey);
      if (!availability.visible || authorityReplaced || targetReplaced) {
        cancelRead();
        invalidateCopy();
        sheetOpen = false;
        clearState();
        return publish();
      }
      if (
        activeRead !== null &&
        (context.snapshot.epoch !== previousEpoch || !availability.readEnabled)
      ) {
        cancelRead();
        readOperation = capture === null
          ? failureReadOperation({
              kind: "failure",
              message: "Session state changed before the laptop command was loaded. Refresh Session Detail."
            })
          : idleReadOperation();
      }
      if (
        activeCopy !== null &&
        (context.snapshot.epoch !== previousEpoch || !availability.readEnabled)
      ) {
        invalidateCopy();
        copyState = idleCopyState();
      }
      return publish();
    },
    open(): Promise<LaptopResumeControlView> {
      if (closed || sheetOpen || !currentView.actionEnabled) {
        return readPromise ?? Promise.resolve(currentView);
      }
      sheetOpen = true;
      capture = null;
      readOperation = idleReadOperation();
      copyState = idleCopyState();
      publish();
      return startRead();
    },
    refresh(): Promise<LaptopResumeControlView> {
      if (closed || !sheetOpen || !currentView.refreshEnabled) {
        return readPromise ?? Promise.resolve(currentView);
      }
      return startRead();
    },
    copy(): Promise<LaptopResumeControlView> {
      if (copyPromise !== null) return copyPromise;
      if (closed || !sheetOpen || !currentView.copyEnabled || capture?.command === null) {
        return Promise.resolve(currentView);
      }
      const availability = deriveAvailability(context.snapshot, sessionId);
      if (
        !availability.readEnabled ||
        availability.targetKey === null ||
        availability.authorityKey === null ||
        capture === null ||
        capture.available !== true ||
        capture.command === null ||
        capture.epoch !== context.snapshot.epoch ||
        capture.targetKey !== availability.targetKey ||
        capture.authorityKey !== availability.authorityKey
      ) {
        return Promise.resolve(publish());
      }
      invalidateCopy();
      const active: ActiveResumeCopy = Object.freeze({
        sequence: copySequence,
        targetKey: capture.targetKey,
        authorityKey: capture.authorityKey,
        epoch: capture.epoch,
        command: capture.command
      });
      activeCopy = active;
      copyState = Object.freeze({ phase: "copying" as const });
      publish();
      const pending = runCopy(active);
      copyPromise = pending;
      return pending;
    },
    dismiss(): LaptopResumeControlView {
      if (closed || !sheetOpen) return currentView;
      cancelRead();
      invalidateCopy();
      sheetOpen = false;
      clearState();
      return publish();
    },
    close(): LaptopResumeControlView {
      if (closed) return currentView;
      closed = true;
      cancelRead();
      invalidateCopy();
      sheetOpen = false;
      clearState();
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
): LaptopResumeAvailability {
  const detail = matchingSession(snapshot, sessionId);
  const visible =
    detail !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null) {
    return availability(false, null, null, null, null, false, "Session details are not available.");
  }

  const target = exactTarget(detail, sessionId);
  const authorityKey = readAuthorityKey(snapshot);
  let reason: string | null = null;
  if (detail.archived_at !== null || detail.session_state === "archived") {
    reason = "Archived sessions cannot resume through HostDeck.";
  } else if (detail.session_state === "incompatible") {
    reason = "This session is incompatible with laptop resume.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    reason = "Session state is stale. Refresh Session Detail before loading a laptop command.";
  } else if (
    snapshot.access.state !== "current" ||
    snapshot.targetState.state !== "current" ||
    authorityKey === null
  ) {
    reason = "Connection state is not current. Refresh Session Detail before loading a laptop command.";
  }
  return availability(
    true,
    detail.name,
    target,
    target.targetKey,
    authorityKey,
    reason === null,
    reason
  );
}

function exactTarget(
  detail: NonNullable<ReturnType<typeof matchingSession>>,
  sessionId: SessionId
): LaptopResumeTarget {
  return Object.freeze({
    sessionId,
    sessionLabel: detail.name,
    threadId: detail.codex_thread_id,
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

function parseCapture(
  candidate: unknown,
  target: LaptopResumeTarget,
  epoch: number,
  authorityKey: string
): LaptopResumeCapture {
  const parsedResponse = selectedResumeMetadataResponseSchema.safeParse(candidate);
  if (!parsedResponse.success) {
    throw new TypeError("HostDeck laptop-resume response is invalid.");
  }
  const response = parsedResponse.data;
  if (
    response.session_id !== target.sessionId ||
    (response.available && response.launch?.args[3] !== target.threadId)
  ) {
    throw new TypeError("HostDeck laptop-resume response target is invalid.");
  }
  const parsedMobile = selectedLaptopResumeSchema.safeParse({
    available: response.available,
    command: response.command,
    unavailable_reason: response.unavailable_reason
  });
  if (!parsedMobile.success) {
    throw new TypeError("HostDeck laptop-resume projection is invalid.");
  }
  const mobile = parsedMobile.data;
  return deepFreezeExactData({
    epoch,
    targetKey: target.targetKey,
    authorityKey,
    available: mobile.available,
    command: mobile.command,
    unavailableReason: mobile.unavailable_reason
  });
}

function deriveStatus(input: Readonly<{
  availability: LaptopResumeAvailability;
  capture: LaptopResumeCapture | null;
  captureStale: boolean;
  operation: LaptopResumeReadOperation;
  sheetOpen: boolean;
}>): Readonly<{
  phase: LaptopResumeControlPhase;
  tone: LaptopResumeControlTone;
  status: string;
  detail: string | null;
}> {
  if (!input.availability.visible) {
    return status("hidden", "muted", "Laptop resume unavailable", null);
  }
  if (!input.sheetOpen) {
    return status(
      "closed",
      input.availability.readEnabled ? "focus" : "attention",
      "Resume on laptop",
      input.availability.reason
    );
  }
  if (input.operation.phase === "loading") {
    return input.capture === null
      ? status(
          "loading",
          "attention",
          "Reading laptop command",
          "HostDeck is checking one exact managed session."
        )
      : status(
          "stale",
          "attention",
          "Checking laptop command",
          "The previous command is stale and cannot be copied during this read."
        );
  }
  if (input.operation.phase === "failure") {
    return status(
      input.operation.failure.kind,
      input.operation.failure.kind === "access_denied" || input.operation.failure.kind === "failure"
        ? "danger"
        : "attention",
      failureLabel(input.operation.failure.kind),
      input.operation.failure.message
    );
  }
  if (input.capture === null) {
    return status(
      "loading",
      "muted",
      "Laptop command unavailable",
      "Open Resume on laptop again to load current metadata."
    );
  }
  if (input.captureStale) {
    return status(
      "stale",
      "attention",
      "Laptop command stale",
      "Check again before copying this command."
    );
  }
  if (!input.capture.available) {
    return status(
      "unavailable",
      "attention",
      "Laptop resume unavailable",
      input.capture.unavailableReason
    );
  }
  return status(
    "available",
    "connected",
    "Exact laptop command ready",
    "Nothing has run from this phone."
  );
}

function classifyReadFailure(error: unknown): LaptopResumeReadFailure {
  const httpError = error instanceof HostDeckBrowserHttpError ? error : null;
  const apiError = httpError?.apiError ?? null;
  if (apiError !== null) return apiReadFailure(apiError);
  if (httpError !== null) return browserHttpReadFailure(httpError.reason);
  if (error instanceof HostDeckBrowserConnectionError) {
    return deepFreezeExactData({
      kind: "access_denied" as const,
      message: error.reason === "closed"
        ? "HostDeck closed before the laptop command was loaded. Reload to continue."
        : "Selected-session access is not current. Refresh Session Detail."
    });
  }
  if (error instanceof TypeError) {
    return deepFreezeExactData({
      kind: "failure" as const,
      message: "Laptop resume metadata failed strict validation."
    });
  }
  return deepFreezeExactData({
    kind: "failure" as const,
    message: "Laptop resume metadata could not be loaded. Check the connection and try again."
  });
}

function browserHttpReadFailure(reason: BrowserHttpFailureReason): LaptopResumeReadFailure {
  switch (reason) {
    case "invalid_response":
    case "response_too_large":
    case "request_contract":
    case "request_too_large":
      return readFailure("failure", "Laptop resume metadata failed strict validation.");
    case "deadline_exceeded":
      return readFailure("failure", "The laptop resume metadata read timed out.");
    case "capacity_exhausted":
      return readFailure(
        "failure",
        "HostDeck is temporarily unable to read laptop resume metadata."
      );
    case "caller_aborted":
      return readFailure("failure", "The laptop resume metadata read was cancelled.");
    case "transport_unavailable":
      return readFailure(
        "failure",
        "Laptop resume metadata could not be loaded. Check the connection and try again."
      );
    case "api_error":
      return readFailure("failure", "HostDeck could not verify laptop resume metadata.");
  }
}

function apiReadFailure(error: ApiErrorEnvelope): LaptopResumeReadFailure {
  switch (error.code) {
    case "session_not_found":
      return readFailure("not_found", "This managed session no longer exists.");
    case "session_not_writable":
    case "stale_session":
    case "invalid_session_id":
      return readFailure(
        "stale_session",
        "This managed session is not current and eligible for laptop resume."
      );
    case "permission_denied":
    case "read_only":
    case "invalid_origin":
    case "insecure_transport":
      return readFailure(
        "access_denied",
        "Secure read access to laptop resume metadata was rejected."
      );
    case "runtime_unavailable":
    case "incompatible_runtime":
    case "capability_unavailable":
      return readFailure(
        "runtime_unavailable",
        "The selected Codex runtime is not available for laptop resume."
      );
    case "storage_error":
      return readFailure("failure", "Managed session state is unavailable on the laptop.");
    case "operation_timeout":
      return readFailure("failure", "The laptop resume metadata read timed out.");
    case "rate_limited":
    case "service_overloaded":
      return readFailure("failure", "HostDeck is temporarily unable to read laptop resume metadata.");
    case "protocol_error":
      return readFailure("failure", "Laptop resume metadata failed strict validation.");
    default:
      return readFailure("failure", "HostDeck could not verify laptop resume metadata.");
  }
}

function readFailure(
  kind: LaptopResumeReadFailureKind,
  message: string
): LaptopResumeReadFailure {
  return deepFreezeExactData({ kind, message });
}

function failureLabel(kind: LaptopResumeReadFailureKind): string {
  switch (kind) {
    case "not_found": return "Managed session not found";
    case "stale_session": return "Session not eligible";
    case "runtime_unavailable": return "Laptop runtime unavailable";
    case "access_denied": return "Laptop command access blocked";
    case "failure": return "Laptop command could not be loaded";
  }
}

function projectCopyStatus(phase: LaptopResumeCopyPhase): Readonly<{
  status: string | null;
  detail: string | null;
}> {
  switch (phase) {
    case "idle": return Object.freeze({ status: null, detail: null });
    case "copying":
      return Object.freeze({
        status: "Copying command",
        detail: "Nothing is being executed on this phone."
      });
    case "copied":
      return Object.freeze({
        status: "Command copied",
        detail: "Nothing ran here. Use it only in a terminal on the HostDeck laptop."
      });
    case "failed":
      return Object.freeze({
        status: "Copy failed",
        detail: "The command remains selectable, or you can try copying it again."
      });
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

function availability(
  visible: boolean,
  targetLabel: string | null,
  target: LaptopResumeTarget | null,
  targetKey: string | null,
  authorityKey: string | null,
  readEnabled: boolean,
  reason: string | null
): LaptopResumeAvailability {
  return Object.freeze({
    visible,
    targetLabel,
    target,
    targetKey,
    authorityKey,
    readEnabled,
    reason
  });
}

function status(
  phase: LaptopResumeControlPhase,
  tone: LaptopResumeControlTone,
  statusText: string,
  detail: string | null
) {
  return Object.freeze({ phase, tone, status: statusText, detail });
}

function idleReadOperation(): LaptopResumeReadOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingReadOperation(): LaptopResumeReadOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureReadOperation(
  failure: LaptopResumeReadFailure
): LaptopResumeReadOperation {
  return deepFreezeExactData({ phase: "failure" as const, failure });
}

function idleCopyState(): LaptopResumeCopyState {
  return Object.freeze({ phase: "idle" as const });
}

function parseCreateOptions(
  candidate: unknown
): CreateLaptopResumeControlControllerOptions {
  const value = readExactObject(
    candidate,
    ["sessionId", "context", "port"] as const,
    "HostDeck laptop-resume options are invalid."
  );
  return Object.freeze({
    sessionId: value.sessionId as SessionId,
    context: value.context as LaptopResumeControlContext,
    port: value.port as LaptopResumeControlPort
  });
}

function parseContext(candidate: unknown): LaptopResumeControlContext {
  const value = readExactObject(
    candidate,
    ["snapshot"] as const,
    "HostDeck laptop-resume context is invalid."
  );
  if (
    value.snapshot === null ||
    typeof value.snapshot !== "object" ||
    Array.isArray(value.snapshot) ||
    !Number.isSafeInteger((value.snapshot as BrowserConnectionSnapshot).epoch) ||
    (value.snapshot as BrowserConnectionSnapshot).epoch < 0
  ) {
    throw new TypeError("HostDeck laptop-resume context is invalid.");
  }
  return Object.freeze({ snapshot: value.snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): LaptopResumeControlPort {
  const value = readExactObject(
    candidate,
    ["read", "writeClipboard"] as const,
    "HostDeck laptop-resume port is invalid."
  );
  if (typeof value.read !== "function" || typeof value.writeClipboard !== "function") {
    throw new TypeError("HostDeck laptop-resume port is invalid.");
  }
  return Object.freeze({
    read: value.read as LaptopResumeControlPort["read"],
    writeClipboard: value.writeClipboard as LaptopResumeControlPort["writeClipboard"]
  });
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

function hiddenView(sessionId: SessionId): LaptopResumeControlView {
  return deepFreezeExactData({
    visible: false,
    sheetOpen: false,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Laptop resume unavailable",
    statusDetail: null,
    sessionId,
    targetLabel: null,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    busy: false,
    refreshEnabled: false,
    available: null,
    unavailableReason: null,
    command: null,
    commandFreshness: null,
    copyEnabled: false,
    copyPhase: "idle" as const,
    copyStatus: null,
    copyStatusDetail: null
  });
}

