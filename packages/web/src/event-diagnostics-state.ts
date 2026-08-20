import {
  type ApiErrorEnvelope,
  replayBoundaryReasonSchema,
  type SelectedProjectionEvent,
  selectedEventDiagnosticsSchema,
  selectedEventPageMaxSize,
  selectedEventPageResponseSchema,
  selectedProjectionEventSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import type { BrowserConnectionSnapshot } from "./connection-state.js";
import {
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";
import type { SessionDetailContinuityBoundary } from "./session-detail-feed.js";

export const eventDiagnosticsPhases = Object.freeze([
  "hidden",
  "closed",
  "loading",
  "current",
  "stale",
  "local_only",
  "failure"
] as const);

export type EventDiagnosticsPhase = (typeof eventDiagnosticsPhases)[number];
export type EventDiagnosticsTone = "connected" | "attention" | "danger" | "focus" | "muted";
export type EventDiagnosticsFieldState = "reported" | "empty" | "not_reported";

export interface EventDiagnosticsContext {
  readonly snapshot: BrowserConnectionSnapshot;
  readonly events: readonly SelectedProjectionEvent[];
  readonly boundary: SessionDetailContinuityBoundary | null;
}

export interface EventDiagnosticsReadInput {
  readonly sessionId: SessionId;
  readonly after: number | null;
  readonly limit: 1;
  readonly signal: AbortSignal;
}

export interface EventDiagnosticsPort {
  readonly read: (input: EventDiagnosticsReadInput) => Promise<unknown>;
}

export interface CreateEventDiagnosticsControllerOptions {
  readonly sessionId: SessionId;
  readonly context: EventDiagnosticsContext;
  readonly port: EventDiagnosticsPort;
}

export interface EventDiagnosticsIdentityView {
  readonly cursor: number;
  readonly normalizedType: string | null;
  readonly capturedAt: string | null;
  readonly upstreamAt: string | null;
  readonly codexEventId: string | null;
  readonly codexEventType: string | null;
  readonly source: "HostDeck summary";
}

export interface EventDiagnosticsFieldView {
  readonly id: string;
  readonly label: string;
  readonly value: string | null;
  readonly state: EventDiagnosticsFieldState;
  readonly expandable: boolean;
}

export interface EventDiagnosticsBoundaryView {
  readonly provenance: "persisted_event" | "stream_continuity";
  readonly after: number | null;
  readonly cursor: number;
  readonly nextCursor: number;
  readonly reason: SessionDetailContinuityBoundary["reason"];
  readonly reasonLabel: string;
}

export interface EventDiagnosticsLimitationView {
  readonly contentState:
    | SelectedProjectionEvent["content_state"]
    | "continuity_evidence";
  readonly label: string;
  readonly notice: string | null;
  readonly scopeNotice: string;
}

export interface EventDiagnosticsContractView {
  readonly read_only: true;
  readonly projection_complete: boolean;
  readonly boundary_visible: boolean;
  readonly redaction_visible: boolean;
  readonly incomplete_reason: string | null;
}

export interface EventDiagnosticsView {
  readonly visible: boolean;
  readonly sheetOpen: boolean;
  readonly phase: EventDiagnosticsPhase;
  readonly tone: EventDiagnosticsTone;
  readonly targetLabel: string | null;
  readonly title: string;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly busy: boolean;
  readonly retryEnabled: boolean;
  readonly selectionRevision: number | null;
  readonly captureRevision: number | null;
  readonly freshness: "current" | "stale" | "retained" | null;
  readonly identity: EventDiagnosticsIdentityView | null;
  readonly fields: readonly EventDiagnosticsFieldView[] | null;
  readonly limitation: EventDiagnosticsLimitationView | null;
  readonly diagnostics: EventDiagnosticsContractView | null;
  readonly boundary: EventDiagnosticsBoundaryView | null;
}

export interface EventDiagnosticsController {
  readonly snapshot: () => EventDiagnosticsView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: EventDiagnosticsContext) => EventDiagnosticsView;
  readonly open: (cursor: number) => Promise<EventDiagnosticsView>;
  readonly retry: () => Promise<EventDiagnosticsView>;
  readonly dismiss: () => EventDiagnosticsView;
  readonly close: () => EventDiagnosticsView;
}

type EventDiagnosticsSelection =
  | Readonly<{
      kind: "retained_event";
      cursor: number;
      event: SelectedProjectionEvent;
    }>
  | Readonly<{
      kind: "continuity_boundary";
      cursor: number;
      boundary: SessionDetailContinuityBoundary;
    }>;

type EventDiagnosticsOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "failure"; failure: EventDiagnosticsFailure }>;

interface EventDiagnosticsFailure {
  readonly kind:
    | "selection_changed"
    | "permission"
    | "malformed"
    | "timeout"
    | "overloaded"
    | "transport"
    | "aborted"
    | "failure";
  readonly message: string;
}

interface EventDiagnosticsAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly targetKey: string | null;
  readonly authorityKey: string | null;
  readonly readEnabled: boolean;
}

interface ActiveRead {
  readonly sequence: number;
  readonly cursor: number;
  readonly targetKey: string;
  readonly authorityKey: string;
  readonly controller: AbortController;
}

class EventDiagnosticsVerificationError extends Error {
  readonly kind: "selection_changed" | "malformed";

  constructor(kind: "selection_changed" | "malformed") {
    super(kind === "malformed"
      ? "HostDeck event-page validation failed."
      : "HostDeck event-page selection changed.");
    this.name = "EventDiagnosticsVerificationError";
    this.kind = kind;
  }
}

const maximumSubscribers = 32;
const fieldDisclosureThreshold = 240;
const boundedProjectionNotice =
  "This is one bounded HostDeck event summary, not complete Codex history or full runtime output.";

export function createEventDiagnosticsController(
  candidateOptions: CreateEventDiagnosticsControllerOptions
): EventDiagnosticsController {
  const options = parseCreateOptions(candidateOptions);
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context, sessionId);
  const port = parsePort(options.port);
  let selection: EventDiagnosticsSelection | null = null;
  let sheetOpen = false;
  let selectionRevision = 0;
  let installedSelectionRevision: number | null = null;
  let captureRevision = 0;
  let installedCaptureRevision: number | null = null;
  let captureEpoch: number | null = null;
  let captureAuthorityKey: string | null = null;
  let captureTargetKey: string | null = null;
  let selectionAuthorityKey: string | null = null;
  let selectionTargetKey: string | null = null;
  let verified = false;
  let operation: EventDiagnosticsOperation = idleOperation();
  let sequence = 0;
  let activeRead: ActiveRead | null = null;
  let activePromise: Promise<EventDiagnosticsView> | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): EventDiagnosticsView {
    const availability = deriveAvailability(context.snapshot, sessionId);
    const open = sheetOpen && availability.visible && selection !== null;
    if (!open || selection === null) {
      return availability.visible
        ? closedView(availability.targetLabel)
        : hiddenView();
    }
    const projected = projectSelection(selection);
    const currentCapture =
      verified &&
      operation.phase === "idle" &&
      captureEpoch === context.snapshot.epoch &&
      captureAuthorityKey === availability.authorityKey &&
      captureTargetKey === availability.targetKey &&
      availability.readEnabled;
    const localOnly = selection.kind === "continuity_boundary" || selection.cursor === 0;
    const phase: EventDiagnosticsPhase = operation.phase === "loading"
      ? "loading"
      : operation.phase === "failure"
        ? "failure"
        : localOnly
          ? "local_only"
          : currentCapture
            ? "current"
            : "stale";
    const freshness = phase === "current"
      ? "current" as const
      : phase === "local_only"
        ? "retained" as const
        : "stale" as const;
    const status = deriveStatus(phase, operation, availability.readEnabled, localOnly);
    return deepFreeze({
      visible: true,
      sheetOpen: true,
      phase,
      tone: status.tone,
      targetLabel: availability.targetLabel,
      title: projected.title,
      status: status.label,
      statusDetail: status.detail,
      busy: operation.phase === "loading",
      retryEnabled:
        !localOnly &&
        availability.readEnabled &&
        operation.phase !== "loading",
      selectionRevision: installedSelectionRevision,
      captureRevision: verified ? installedCaptureRevision : null,
      freshness,
      identity: projected.identity,
      fields: projected.fields,
      limitation: projected.limitation,
      diagnostics: projected.diagnostics,
      boundary: projected.boundary
    });
  }

  const publish = (): EventDiagnosticsView => {
    currentView = project();
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  const cancelActive = (): void => {
    sequence += 1;
    activeRead?.controller.abort();
    activeRead = null;
    activePromise = null;
  };

  const clearSelection = (): void => {
    selection = null;
    installedSelectionRevision = null;
    installedCaptureRevision = null;
    captureEpoch = null;
    captureAuthorityKey = null;
    captureTargetKey = null;
    selectionAuthorityKey = null;
    selectionTargetKey = null;
    verified = false;
  };

  const installSelection = (
    nextSelection: EventDiagnosticsSelection,
    availability: EventDiagnosticsAvailability
  ): void => {
    const nextRevision = selectionRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new TypeError("HostDeck event-diagnostics selection revision is exhausted.");
    }
    selectionRevision = nextRevision;
    installedSelectionRevision = nextRevision;
    selection = nextSelection;
    selectionAuthorityKey = availability.authorityKey;
    selectionTargetKey = availability.targetKey;
    verified = false;
    installedCaptureRevision = null;
    captureEpoch = null;
    captureAuthorityKey = null;
    captureTargetKey = null;
  };

  const installCapture = (
    candidate: unknown,
    expected: Extract<EventDiagnosticsSelection, { kind: "retained_event" }>
  ): void => {
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (
      !availability.readEnabled ||
      availability.authorityKey === null ||
      availability.targetKey === null ||
      selection?.kind !== "retained_event" ||
      selection.cursor !== expected.cursor ||
      !equalExactData(selection.event, expected.event)
    ) {
      throw new HostDeckBrowserConnectionError("not_ready");
    }
    verifyPage(candidate, sessionId, expected.event);
    const nextRevision = captureRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new TypeError("HostDeck event-diagnostics capture revision is exhausted.");
    }
    captureRevision = nextRevision;
    installedCaptureRevision = nextRevision;
    captureEpoch = context.snapshot.epoch;
    captureAuthorityKey = availability.authorityKey;
    captureTargetKey = availability.targetKey;
    verified = true;
  };

  const runRead = (): Promise<EventDiagnosticsView> => {
    if (
      closed ||
      !sheetOpen ||
      selection?.kind !== "retained_event" ||
      selection.cursor === 0 ||
      activeRead !== null
    ) {
      return activePromise ?? Promise.resolve(currentView);
    }
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (
      !availability.readEnabled ||
      availability.targetKey === null ||
      availability.authorityKey === null
    ) {
      return Promise.resolve(currentView);
    }
    const selected = selection;
    cancelActive();
    const requestController = new AbortController();
    const requestSequence = sequence;
    activeRead = Object.freeze({
      sequence: requestSequence,
      cursor: selected.cursor,
      targetKey: availability.targetKey,
      authorityKey: availability.authorityKey,
      controller: requestController
    });
    operation = loadingOperation();
    publish();
    const promise = (async (): Promise<EventDiagnosticsView> => {
      try {
        const response = await Reflect.apply(port.read, undefined, [
          Object.freeze({
            sessionId,
            after: selected.event.type === "replay_boundary"
              ? selected.event.after
              : selected.cursor - 1,
            limit: 1 as const,
            signal: requestController.signal
          })
        ]);
        if (
          closed ||
          requestSequence !== sequence ||
          !sheetOpen ||
          selection?.kind !== "retained_event" ||
          selection.cursor !== selected.cursor
        ) {
          return currentView;
        }
        installCapture(response, selected);
        operation = idleOperation();
        return publish();
      } catch (error) {
        if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
        operation = failureOperation(classifyReadFailure(error));
        return publish();
      } finally {
        if (activeRead?.sequence === requestSequence) {
          activeRead = null;
          activePromise = null;
        }
      }
    })();
    activePromise = promise;
    return promise;
  };

  const controller: EventDiagnosticsController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck event-diagnostics listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck event-diagnostics listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: EventDiagnosticsContext): EventDiagnosticsView {
      if (closed) throw new TypeError("HostDeck event diagnostics is closed.");
      const previousEpoch = context.snapshot.epoch;
      context = parseContext(nextContext, sessionId);
      const availability = deriveAvailability(context.snapshot, sessionId);
      const authorityReplaced =
        selectionAuthorityKey !== null &&
        availability.authorityKey !== selectionAuthorityKey;
      const targetReplaced =
        selectionTargetKey !== null &&
        availability.targetKey !== selectionTargetKey;
      const selectedEvidenceRetained = selection === null
        ? true
        : resolveSelection(context, selection.cursor) !== null &&
          equalSelection(resolveSelection(context, selection.cursor), selection);
      if (
        selection !== null &&
        (!availability.visible || authorityReplaced || targetReplaced || !selectedEvidenceRetained)
      ) {
        cancelActive();
        sheetOpen = false;
        clearSelection();
        operation = idleOperation();
        return publish();
      }
      if (
        activeRead !== null &&
        (context.snapshot.epoch !== previousEpoch || !availability.readEnabled)
      ) {
        cancelActive();
        operation = idleOperation();
      }
      return publish();
    },
    open(cursor: number): Promise<EventDiagnosticsView> {
      if (closed) return Promise.resolve(currentView);
      const parsedCursor = parseCursor(cursor);
      const nextSelection = resolveSelection(context, parsedCursor);
      if (nextSelection === null) {
        throw new TypeError("HostDeck event-diagnostics cursor is not retained by this session.");
      }
      if (
        sheetOpen &&
        selection !== null &&
        equalSelection(selection, nextSelection)
      ) {
        return activePromise ?? Promise.resolve(currentView);
      }
      const availability = deriveAvailability(context.snapshot, sessionId);
      if (!availability.visible || availability.targetKey === null || availability.authorityKey === null) {
        throw new HostDeckBrowserConnectionError("not_ready");
      }
      cancelActive();
      clearSelection();
      installSelection(nextSelection, availability);
      sheetOpen = true;
      operation = idleOperation();
      publish();
      return runRead();
    },
    retry(): Promise<EventDiagnosticsView> {
      if (closed || !sheetOpen || !currentView.retryEnabled) {
        return Promise.resolve(currentView);
      }
      return runRead();
    },
    dismiss(): EventDiagnosticsView {
      if (closed || !sheetOpen) return currentView;
      cancelActive();
      sheetOpen = false;
      clearSelection();
      operation = idleOperation();
      return publish();
    },
    close(): EventDiagnosticsView {
      if (closed) return currentView;
      closed = true;
      cancelActive();
      sheetOpen = false;
      clearSelection();
      operation = idleOperation();
      subscribers.clear();
      currentView = hiddenView();
      return currentView;
    }
  });

  return controller;
}

function projectSelection(selection: EventDiagnosticsSelection): Readonly<{
  title: string;
  identity: EventDiagnosticsIdentityView;
  fields: readonly EventDiagnosticsFieldView[];
  limitation: EventDiagnosticsLimitationView;
  diagnostics: EventDiagnosticsContractView;
  boundary: EventDiagnosticsBoundaryView | null;
}> {
  if (selection.kind === "continuity_boundary") {
    const boundary = projectBoundary(selection.boundary, "stream_continuity");
    const reason = "Only retained stream continuity evidence is available for this boundary.";
    return deepFreeze({
      title: "Replay boundary",
      identity: {
        cursor: selection.cursor,
        normalizedType: null,
        capturedAt: null,
        upstreamAt: null,
        codexEventId: null,
        codexEventType: null,
        source: "HostDeck summary" as const
      },
      fields: boundaryFields(selection.boundary),
      limitation: {
        contentState: "continuity_evidence" as const,
        label: "Stream continuity evidence",
        notice: reason,
        scopeNotice: boundedProjectionNotice
      },
      diagnostics: parseDiagnostics({
        read_only: true,
        projection_complete: false,
        boundary_visible: true,
        redaction_visible: false,
        incomplete_reason: reason
      }),
      boundary
    });
  }

  const event = selection.event;
  const boundary = event.type === "replay_boundary"
    ? projectBoundary({
        after: event.after,
        cursor: event.cursor,
        reason: event.reason
      }, "persisted_event")
    : null;
  const diagnostics = diagnosticsForEvent(event);
  return deepFreeze({
    title: eventTypeLabel(event.type),
    identity: {
      cursor: event.cursor,
      normalizedType: event.type,
      capturedAt: event.captured_at,
      upstreamAt: event.upstream_at,
      codexEventId: event.codex_event_id,
      codexEventType: event.codex_event_type,
      source: "HostDeck summary" as const
    },
    fields: projectPayloadFields(event),
    limitation: limitationForEvent(event),
    diagnostics,
    boundary
  });
}

function projectPayloadFields(event: SelectedProjectionEvent): readonly EventDiagnosticsFieldView[] {
  switch (event.type) {
    case "message":
      return fields([
        field("role", "Role", event.role),
        field("phase", "Phase", event.phase),
        field("item-id", "Item ID", event.item_id),
        field("text", "Text", event.text)
      ]);
    case "turn":
      return fields([
        field("turn-id", "Turn ID", event.turn_id),
        field("state", "State", event.state),
        field("error-code", "Error code", event.error?.code ?? null),
        field("error-message", "Error message", event.error?.message ?? null)
      ]);
    case "activity":
      return fields([
        field("activity", "Activity kind", event.activity),
        field("state", "State", event.state),
        field("item-id", "Item ID", event.item_id),
        field("title", "Title", event.title),
        field("detail", "Detail", event.detail)
      ]);
    case "approval":
      return fields([
        field("request-id", "Request ID", event.request_id),
        field("state", "State", event.state),
        field("action", "Action", event.action),
        field("scope", "Scope", event.scope),
        field("reason", "Reason", event.reason),
        field("risk", "Risk", event.risk),
        field("expires-at", "Expires at", event.expires_at),
        field("decision", "Decision", event.decision)
      ]);
    case "control":
      return fields([
        field("control", "Control", event.control),
        field("state", "State", event.state),
        field("value-summary", "Value summary", event.value_summary)
      ]);
    case "runtime":
      return fields([
        field("state", "State", event.state),
        field("message", "Message", event.message)
      ]);
    case "replay_boundary":
      return boundaryFields({
        after: event.after,
        cursor: event.cursor,
        reason: event.reason
      });
    case "unknown_optional":
      return fields([
        field("upstream-type", "Upstream type", event.upstream_type),
        field("summary", "Summary", event.summary)
      ]);
  }
}

function boundaryFields(
  boundary: SessionDetailContinuityBoundary
): readonly EventDiagnosticsFieldView[] {
  return fields([
    field("after", "Prior event position", boundary.after),
    field("boundary-cursor", "Boundary position", boundary.cursor),
    field("next-cursor", "Next event position", boundary.cursor),
    field("reason", "Reason", boundary.reason)
  ]);
}

function diagnosticsForEvent(event: SelectedProjectionEvent): EventDiagnosticsContractView {
  const boundary = event.type === "replay_boundary";
  const unknown = event.type === "unknown_optional";
  const contentLimited = event.content_state !== "complete";
  const incompleteReason = contentLimited
    ? event.content_notice
    : boundary
      ? boundaryReason(event.reason)
      : unknown
        ? "This optional event type is represented by a bounded summary."
        : null;
  return parseDiagnostics({
    read_only: true,
    projection_complete: incompleteReason === null,
    boundary_visible: boundary,
    redaction_visible:
      event.content_state === "redacted" ||
      event.content_state === "redacted_and_truncated",
    incomplete_reason: incompleteReason
  });
}

function limitationForEvent(event: SelectedProjectionEvent): EventDiagnosticsLimitationView {
  const label = event.content_state === "complete"
    ? event.type === "replay_boundary"
      ? "Replay boundary visible"
      : event.type === "unknown_optional"
        ? "Unrecognized optional event"
        : "Bounded event summary"
    : event.content_state === "redacted"
      ? "Content redacted"
      : event.content_state === "truncated"
        ? "Content truncated"
        : "Content redacted and truncated";
  const notice = event.content_state !== "complete"
    ? event.content_notice
    : event.type === "replay_boundary"
      ? boundaryReason(event.reason)
      : event.type === "unknown_optional"
        ? "This optional event type is represented by a bounded summary."
        : null;
  return Object.freeze({
    contentState: event.content_state,
    label,
    notice,
    scopeNotice: boundedProjectionNotice
  });
}

function parseDiagnostics(candidate: EventDiagnosticsContractView): EventDiagnosticsContractView {
  return Object.freeze(selectedEventDiagnosticsSchema.parse(candidate));
}

function projectBoundary(
  boundary: SessionDetailContinuityBoundary,
  provenance: EventDiagnosticsBoundaryView["provenance"]
): EventDiagnosticsBoundaryView {
  return Object.freeze({
    provenance,
    after: boundary.after,
    cursor: boundary.cursor,
    nextCursor: boundary.cursor,
    reason: boundary.reason,
    reasonLabel: boundaryReasonLabel(boundary.reason)
  });
}

function field(
  id: string,
  label: string,
  candidate: string | number | null
): EventDiagnosticsFieldView {
  const value = typeof candidate === "number" ? String(candidate) : candidate;
  return Object.freeze({
    id,
    label,
    value,
    state: value === null ? "not_reported" : value.length === 0 ? "empty" : "reported",
    expandable: value !== null && value.length > fieldDisclosureThreshold
  });
}

function fields(value: readonly EventDiagnosticsFieldView[]): readonly EventDiagnosticsFieldView[] {
  return Object.freeze(value);
}

function verifyPage(
  candidate: unknown,
  sessionId: SessionId,
  expected: SelectedProjectionEvent
): void {
  const parsed = selectedEventPageResponseSchema.safeParse(candidate);
  if (!parsed.success) throw new EventDiagnosticsVerificationError("malformed");
  const page = parsed.data;
  const event = page.events[0];
  if (
    page.session_id !== sessionId ||
    page.events.length !== 1 ||
    event === undefined ||
    event.session_id !== sessionId ||
    event.cursor !== expected.cursor ||
    page.next_cursor !== expected.cursor ||
    !equalExactData(event, expected)
  ) {
    throw new EventDiagnosticsVerificationError("selection_changed");
  }
}

function deriveAvailability(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): EventDiagnosticsAvailability {
  const detail = matchingSession(snapshot, sessionId);
  const authorityKey = readAuthorityKey(snapshot);
  const visible =
    detail !== null &&
    authorityKey !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null || authorityKey === null) {
    return Object.freeze({
      visible: false,
      targetLabel: null,
      targetKey: null,
      authorityKey: null,
      readEnabled: false
    });
  }
  return Object.freeze({
    visible: true,
    targetLabel: detail.name,
    targetKey: eventTargetKey(detail),
    authorityKey,
    readEnabled:
      snapshot.access.state === "current" &&
      snapshot.targetState.state === "current" &&
      detail.freshness === "current"
  });
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

function eventTargetKey(detail: NonNullable<ReturnType<typeof matchingSession>>): string {
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

function resolveSelection(
  context: EventDiagnosticsContext,
  cursor: number
): EventDiagnosticsSelection | null {
  const event = context.events.find((candidate) => candidate.cursor === cursor);
  if (event !== undefined) {
    return deepFreeze({ kind: "retained_event" as const, cursor, event });
  }
  if (context.boundary?.cursor === cursor) {
    return deepFreeze({
      kind: "continuity_boundary" as const,
      cursor,
      boundary: context.boundary
    });
  }
  return null;
}

function equalSelection(
  left: EventDiagnosticsSelection | null,
  right: EventDiagnosticsSelection | null
): boolean {
  if (left === null || right === null || left.kind !== right.kind || left.cursor !== right.cursor) {
    return false;
  }
  return left.kind === "retained_event" && right.kind === "retained_event"
    ? equalExactData(left.event, right.event)
    : left.kind === "continuity_boundary" && right.kind === "continuity_boundary" &&
      equalExactData(left.boundary, right.boundary);
}

function deriveStatus(
  phase: EventDiagnosticsPhase,
  operation: EventDiagnosticsOperation,
  readEnabled: boolean,
  localOnly: boolean
): Readonly<{ tone: EventDiagnosticsTone; label: string; detail: string | null }> {
  if (phase === "loading") {
    return status(
      "attention",
      "Verifying event",
      "The retained event remains stale until this read succeeds."
    );
  }
  if (phase === "failure" && operation.phase === "failure") {
    return status("danger", "Event verification failed", operation.failure.message);
  }
  if (phase === "current") {
    return status("connected", "Event details current", "The selected retained event was verified.");
  }
  if (localOnly) {
    return status(
      "attention",
      "Local evidence only",
      "This event cannot be verified with one bounded detail read."
    );
  }
  return status(
    "attention",
    "Retained event detail",
    readEnabled
      ? "Retry to verify this retained event against current event storage."
      : "Current session access is unavailable; retained event details remain stale."
  );
}

function classifyReadFailure(error: unknown): EventDiagnosticsFailure {
  if (error instanceof EventDiagnosticsVerificationError) {
    return failure(
      error.kind,
      error.kind === "malformed"
        ? "HostDeck returned invalid event details. The retained event remains stale."
        : "The current event page no longer matches this retained event."
    );
  }
  if (error instanceof HostDeckBrowserHttpError) {
    if (error.apiError !== null) return classifyApiFailure(error.apiError);
    switch (error.reason) {
      case "deadline_exceeded":
        return failure("timeout", "The event verification timed out.");
      case "caller_aborted":
        return failure("aborted", "The event verification was interrupted.");
      case "capacity_exhausted":
        return failure("overloaded", "HostDeck is temporarily too busy to verify this event.");
      case "invalid_response":
      case "response_too_large":
        return failure("malformed", "HostDeck could not validate the current event page.");
      case "transport_unavailable":
        return failure("transport", "HostDeck could not reach the event service.");
      case "request_contract":
      case "request_too_large":
      case "api_error":
        return failure("failure", "HostDeck could not verify this retained event.");
    }
  }
  if (error instanceof HostDeckBrowserConnectionError) {
    return failure(
      "permission",
      error.reason === "closed"
        ? "HostDeck closed before the event could be verified."
        : "Current session access changed before verification completed."
    );
  }
  if (isAbortError(error)) {
    return failure("aborted", "The event verification was interrupted.");
  }
  return failure("failure", "HostDeck could not verify this retained event.");
}

function classifyApiFailure(error: ApiErrorEnvelope): EventDiagnosticsFailure {
  switch (error.code) {
    case "session_not_found":
      return failure("selection_changed", "This session no longer exists.");
    case "stale_session":
    case "invalid_session_id":
      return failure("selection_changed", "The retained event is no longer current in event storage.");
    case "permission_denied":
    case "read_only":
      return failure("permission", "This phone cannot read current event details.");
    case "operation_timeout":
      return failure("timeout", "The event verification timed out.");
    case "rate_limited":
      return failure("overloaded", "Event reads are temporarily rate limited.");
    case "service_overloaded":
      return failure("overloaded", "HostDeck is temporarily too busy to verify this event.");
    case "protocol_error":
    case "storage_error":
      return failure("malformed", "HostDeck could not validate the current event page.");
    case "invalid_origin":
    case "insecure_transport":
      return failure("permission", "Secure event access was rejected.");
    default:
      return failure("failure", "HostDeck could not verify this retained event.");
  }
}

function parseCreateOptions(candidate: unknown): CreateEventDiagnosticsControllerOptions {
  const value = readExactObject(
    candidate,
    ["sessionId", "context", "port"] as const,
    "HostDeck event-diagnostics options are invalid."
  );
  return Object.freeze({
    sessionId: value.sessionId as SessionId,
    context: value.context as EventDiagnosticsContext,
    port: value.port as EventDiagnosticsPort
  });
}

function parseContext(
  candidate: unknown,
  sessionId: SessionId
): EventDiagnosticsContext {
  const value = readExactObject(
    candidate,
    ["snapshot", "events", "boundary"] as const,
    "HostDeck event-diagnostics context is invalid."
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
    throw new TypeError("HostDeck event-diagnostics context is invalid.");
  }
  const events = value.events.map((candidateEvent) =>
    deepFreeze(selectedProjectionEventSchema.parse(candidateEvent))
  );
  let previousCursor = -1;
  for (const event of events) {
    if (event.session_id !== sessionId || event.cursor <= previousCursor) {
      throw new TypeError("HostDeck event-diagnostics context contains invalid event ownership.");
    }
    if (event.type === "replay_boundary") {
      if (
        previousCursor >= 0 &&
        (event.after === null || event.after < previousCursor)
      ) {
        throw new TypeError("HostDeck event-diagnostics context contains invalid boundary order.");
      }
    } else if (previousCursor >= 0 && event.cursor !== previousCursor + 1) {
      throw new TypeError("HostDeck event-diagnostics context contains an event cursor gap.");
    }
    previousCursor = event.cursor;
  }
  const boundary = value.boundary === null
    ? null
    : parseBoundary(value.boundary);
  if (boundary !== null) {
    const sameCursor = events.find((event) => event.cursor === boundary.cursor);
    if (
      sameCursor !== undefined &&
      (sameCursor.type !== "replay_boundary" ||
        sameCursor.after !== boundary.after ||
        sameCursor.reason !== boundary.reason)
    ) {
      throw new TypeError("HostDeck event-diagnostics context contains contradictory boundary evidence.");
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
    "HostDeck event-diagnostics boundary is invalid."
  );
  const after = value.after;
  const cursor = value.cursor;
  const reason = value.reason;
  if (
    (after !== null && (!Number.isSafeInteger(after) || (after as number) < 0)) ||
    !Number.isSafeInteger(cursor) ||
    (cursor as number) < 0 ||
    (after !== null && (cursor as number) <= (after as number)) ||
    !replayBoundaryReasonSchema.safeParse(reason).success
  ) {
    throw new TypeError("HostDeck event-diagnostics boundary is invalid.");
  }
  return Object.freeze({
    after: after as number | null,
    cursor: cursor as number,
    reason: reason as SessionDetailContinuityBoundary["reason"]
  });
}

function parsePort(candidate: unknown): EventDiagnosticsPort {
  const value = readExactObject(
    candidate,
    ["read"] as const,
    "HostDeck event-diagnostics port is invalid."
  );
  if (typeof value.read !== "function") {
    throw new TypeError("HostDeck event-diagnostics port is invalid.");
  }
  return Object.freeze({ read: value.read as EventDiagnosticsPort["read"] });
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseCursor(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new TypeError("HostDeck event-diagnostics cursor is invalid.");
  }
  return candidate as number;
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
      return descriptor === undefined || !(
        "value" in descriptor
      ) || !descriptor.enumerable;
    })
  ) {
    throw new TypeError(message);
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]))
  ) as Readonly<Record<Keys[number], unknown>>;
}

function hiddenView(): EventDiagnosticsView {
  return deepFreeze({
    visible: false,
    sheetOpen: false,
    phase: "hidden" as const,
    tone: "muted" as const,
    targetLabel: null,
    title: "Event details",
    status: "Event details unavailable",
    statusDetail: null,
    busy: false,
    retryEnabled: false,
    selectionRevision: null,
    captureRevision: null,
    freshness: null,
    identity: null,
    fields: null,
    limitation: null,
    diagnostics: null,
    boundary: null
  });
}

function closedView(targetLabel: string | null): EventDiagnosticsView {
  return deepFreeze({
    visible: true,
    sheetOpen: false,
    phase: "closed" as const,
    tone: "focus" as const,
    targetLabel,
    title: "Event details",
    status: "Event details closed",
    statusDetail: null,
    busy: false,
    retryEnabled: false,
    selectionRevision: null,
    captureRevision: null,
    freshness: null,
    identity: null,
    fields: null,
    limitation: null,
    diagnostics: null,
    boundary: null
  });
}

function eventTypeLabel(type: SelectedProjectionEvent["type"]): string {
  switch (type) {
    case "message": return "Message event";
    case "turn": return "Turn event";
    case "activity": return "Activity event";
    case "approval": return "Approval event";
    case "control": return "Control event";
    case "runtime": return "Runtime event";
    case "replay_boundary": return "Replay boundary";
    case "unknown_optional": return "Unrecognized optional event";
  }
}

function boundaryReasonLabel(reason: SessionDetailContinuityBoundary["reason"]): string {
  switch (reason) {
    case "adoption": return "HostDeck adoption";
    case "enrollment": return "Automatic enrollment";
    case "retention": return "Retention";
    case "disconnect": return "Disconnect";
    case "restart": return "Runtime restart";
    case "schema_change": return "Data format change";
  }
}

function boundaryReason(reason: SessionDetailContinuityBoundary["reason"]): string {
  switch (reason) {
    case "adoption": return "Earlier activity remains in Codex before this HostDeck adoption boundary.";
    case "enrollment": return "Earlier activity remains in Codex before this HostDeck enrollment boundary.";
    case "retention": return "Earlier events are outside retained history.";
    case "disconnect": return "Event continuity was interrupted by a runtime disconnect.";
    case "restart": return "Event continuity was interrupted by a runtime restart.";
    case "schema_change": return "Event continuity was interrupted by a data format change.";
  }
}

function status(
  tone: EventDiagnosticsTone,
  label: string,
  detail: string | null
) {
  return Object.freeze({ tone, label, detail });
}

function idleOperation(): EventDiagnosticsOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingOperation(): EventDiagnosticsOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureOperation(failureValue: EventDiagnosticsFailure): EventDiagnosticsOperation {
  return deepFreeze({ phase: "failure" as const, failure: failureValue });
}

function failure(
  kind: EventDiagnosticsFailure["kind"],
  message: string
): EventDiagnosticsFailure {
  return Object.freeze({ kind, message });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function equalExactData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => equalExactData(value, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && equalExactData(leftRecord[key], rightRecord[key])
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
