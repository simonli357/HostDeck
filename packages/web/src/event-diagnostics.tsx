import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Fingerprint,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  X
} from "lucide-react";
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createEventDiagnosticsController,
  type EventDiagnosticsController,
  type EventDiagnosticsFieldView,
  type EventDiagnosticsTone
} from "./event-diagnostics-state.js";
import type {
  SessionDetailContinuityBoundary,
  SessionDetailFeedState
} from "./session-detail-feed.js";

export interface EventDiagnosticsActionProps {
  readonly controller: EventDiagnosticsController;
  readonly cursor: number;
  readonly disabled?: boolean | undefined;
  readonly originRef: RefObject<HTMLButtonElement | null>;
}

export interface EventDiagnosticsSheetProps {
  readonly controller: EventDiagnosticsController;
  readonly originRef: RefObject<HTMLButtonElement | null>;
}

export function useEventDiagnosticsController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  feed: SessionDetailFeedState,
  boundary: SessionDetailContinuityBoundary | null
): EventDiagnosticsController {
  const contextRef = useRef(Object.freeze({
    snapshot,
    events: feed.events,
    boundary
  }));
  contextRef.current = Object.freeze({
    snapshot,
    events: feed.events,
    boundary
  });
  const owner = useMemo(
    () =>
      createEventDiagnosticsController({
        sessionId,
        context: contextRef.current,
        port: Object.freeze({
          async read(input: Readonly<{
            sessionId: SessionId;
            after: number | null;
            limit: 1;
            signal: AbortSignal;
          }>) {
            const query = input.after === null
              ? { limit: "1" as const }
              : { after: String(input.after), limit: "1" as const };
            const response = await coordinator.requestSelectedSessionRead(
              "session_events",
              {
                params: { session_id: input.sessionId },
                query
              },
              { signal: input.signal }
            );
            return response.data;
          }
        })
      }),
    [coordinator, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: EventDiagnosticsController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    owner.updateContext(Object.freeze({
      snapshot,
      events: feed.events,
      boundary
    }));
  }, [boundary, feed.events, owner, snapshot]);

  useEffect(() => {
    const token = Object.freeze({});
    activeOwner.current = Object.freeze({ controller: owner, token });
    return () => {
      queueMicrotask(() => {
        const active = activeOwner.current;
        if (active?.controller === owner && active.token !== token) return;
        owner.close();
      });
    };
  }, [owner]);

  return owner;
}

export function EventDiagnosticsAction({
  controller,
  cursor,
  disabled = false,
  originRef
}: EventDiagnosticsActionProps) {
  return (
    <button
      type="button"
      className="hostdeck-icon-button hostdeck-timeline-item__details"
      aria-label="View event details"
      title="View event details"
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={(event) => {
        originRef.current = event.currentTarget;
        try {
          void controller.open(cursor).catch(() => {
            if (originRef.current === event.currentTarget) originRef.current = null;
          });
        } catch {
          if (originRef.current === event.currentTarget) originRef.current = null;
        }
      }}
    >
      <Info size={19} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export function EventDiagnosticsSheet({
  controller,
  originRef
}: EventDiagnosticsSheetProps) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  const closeRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const targetId = `${id}-target`;
  const limitationId = `${id}-limitation`;
  const statusId = `${id}-status`;

  return (
    <Dialog.Root
      open={view.sheetOpen}
      onOpenChange={(open) => {
        if (!open) controller.dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        {view.sheetOpen ? (
          <Dialog.Content
            className={`hostdeck-sheet hostdeck-event-sheet hostdeck-event-sheet--${view.tone}`}
            aria-describedby={`${targetId} ${limitationId} ${statusId}`}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              closeRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              const origin = originRef.current;
              originRef.current = null;
              if (origin?.isConnected === true) {
                event.preventDefault();
                origin.focus();
              }
            }}
          >
            <span className="hostdeck-sheet__handle" aria-hidden="true" />
            <div className="hostdeck-sheet__header hostdeck-event-sheet__header">
              <span>
                <Dialog.Title className="hostdeck-sheet__title">Event details</Dialog.Title>
                <Dialog.Description className="hostdeck-event-sheet__target" id={targetId}>
                  Target: <strong>{view.targetLabel ?? "Selected session"}</strong>
                </Dialog.Description>
              </span>
              <Dialog.Close asChild>
                <button
                  ref={closeRef}
                  type="button"
                  className="hostdeck-icon-button"
                  aria-label="Close event details"
                  title="Close event details"
                >
                  <X size={22} strokeWidth={2} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>

            <div
              key={view.selectionRevision ?? "closed"}
              className="hostdeck-event-sheet__scroller"
            >
              <EventIdentity view={view} />
              <EventLimitation limitationId={limitationId} view={view} />
              <EventBoundary view={view} />
              <EventPayload view={view} />
            </div>

            <EventStatus controller={controller} statusId={statusId} view={view} />
          </Dialog.Content>
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EventIdentity({
  view
}: Readonly<{ view: ReturnType<EventDiagnosticsController["snapshot"]> }>) {
  const identity = view.identity;
  if (identity === null) return null;
  return (
    <section className="hostdeck-event-section" aria-labelledby="hostdeck-event-identity-heading">
      <EventSectionHeading
        id="hostdeck-event-identity-heading"
        icon={Fingerprint}
        title={view.title}
      />
      <dl className="hostdeck-event-identity">
        <IdentityRow label="Cursor" value={String(identity.cursor)} />
        <IdentityRow label="Normalized type" value={identity.normalizedType} />
        <IdentityRow label="Captured at" value={identity.capturedAt} />
        <IdentityRow label="Upstream at" value={identity.upstreamAt} />
        <IdentityRow label="Codex event ID" value={identity.codexEventId} />
        <IdentityRow label="Codex event type" value={identity.codexEventType} />
        <IdentityRow label="Source" value={identity.source} />
      </dl>
    </section>
  );
}

function EventLimitation({
  limitationId,
  view
}: Readonly<{
  limitationId: string;
  view: ReturnType<EventDiagnosticsController["snapshot"]>;
}>) {
  const limitation = view.limitation;
  if (limitation === null) return null;
  const Icon = view.diagnostics?.projection_complete === true ? Info : ShieldAlert;
  const tone: EventDiagnosticsTone = view.diagnostics?.projection_complete === true
    ? "focus"
    : "attention";
  return (
    <section
      id={limitationId}
      className={`hostdeck-event-limitation hostdeck-tone--${tone}`}
      aria-label="Diagnostic limitation"
    >
      <Icon size={20} strokeWidth={2} aria-hidden="true" />
      <span>
        <strong>{limitation.label}</strong>
        {limitation.notice === null ? null : <small>{limitation.notice}</small>}
        <small>{limitation.scopeNotice}</small>
      </span>
    </section>
  );
}

function EventBoundary({
  view
}: Readonly<{ view: ReturnType<EventDiagnosticsController["snapshot"]> }>) {
  const boundary = view.boundary;
  if (boundary === null) return null;
  return (
    <section className="hostdeck-event-boundary" aria-label="Replay boundary evidence">
      <AlertTriangle size={20} strokeWidth={2} aria-hidden="true" />
      <span>
        <strong>{boundary.reasonLabel} boundary</strong>
        <small>
          {boundary.provenance === "persisted_event"
            ? "Persisted normalized event"
            : "Stream continuity evidence; not a persisted event"}
        </small>
      </span>
    </section>
  );
}

function EventPayload({
  view
}: Readonly<{ view: ReturnType<EventDiagnosticsController["snapshot"]> }>) {
  if (view.fields === null) return null;
  return (
    <section className="hostdeck-event-section" aria-labelledby="hostdeck-event-payload-heading">
      <EventSectionHeading
        id="hostdeck-event-payload-heading"
        icon={Info}
        title="Projected payload"
      />
      <dl className="hostdeck-event-payload">
        {view.fields.map((field) => (
          <EventField key={field.id} field={field} />
        ))}
      </dl>
    </section>
  );
}

function EventField({ field }: Readonly<{ field: EventDiagnosticsFieldView }>) {
  const [expanded, setExpanded] = useState(false);
  const valueId = useId();
  const display = field.state === "not_reported"
    ? "Not reported"
    : field.state === "empty"
      ? "Empty value"
      : field.value;
  return (
    <div className="hostdeck-event-field">
      <dt>{field.label}</dt>
      <dd
        id={valueId}
        className={field.expandable && !expanded
          ? "hostdeck-event-field__value--collapsed"
          : undefined}
        data-value-state={field.state}
      >
        {display}
      </dd>
      {!field.expandable ? null : (
        <button
          type="button"
          className="hostdeck-event-field__disclosure"
          aria-expanded={expanded}
          aria-controls={valueId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <ChevronUp size={17} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronDown size={17} strokeWidth={2} aria-hidden="true" />
          )}
          {expanded ? "Collapse field" : "Expand field"}
        </button>
      )}
    </div>
  );
}

function EventStatus({
  controller,
  statusId,
  view
}: Readonly<{
  controller: EventDiagnosticsController;
  statusId: string;
  view: ReturnType<EventDiagnosticsController["snapshot"]>;
}>) {
  const StatusIcon = view.busy
    ? LoaderCircle
    : view.tone === "danger"
      ? AlertTriangle
      : view.tone === "connected"
        ? Check
        : Clock3;
  return (
    <footer className="hostdeck-event-footer">
      <div
        id={statusId}
        className={`hostdeck-event-status hostdeck-tone--${view.tone}`}
        role={view.tone === "danger" ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
        aria-busy={view.busy}
      >
        <StatusIcon
          className={view.busy ? "hostdeck-spin" : undefined}
          size={19}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span>
          <strong>{view.status}</strong>
          {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
        </span>
        <button
          type="button"
          className="hostdeck-secondary-button hostdeck-event-status__retry"
          disabled={!view.retryEnabled}
          onClick={() => void controller.retry()}
        >
          <RefreshCw size={17} strokeWidth={2} aria-hidden="true" />
          Retry
        </button>
      </div>
    </footer>
  );
}

function EventSectionHeading({
  icon: Icon,
  id,
  title
}: Readonly<{
  icon: typeof Info;
  id: string;
  title: string;
}>) {
  return (
    <h2 className="hostdeck-event-section__heading" id={id}>
      <Icon size={19} strokeWidth={2} aria-hidden="true" />
      <span>{title}</span>
    </h2>
  );
}

function IdentityRow({
  label,
  value
}: Readonly<{ label: string; value: string | null }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-value-state={value === null ? "not_reported" : "reported"}>
        {value ?? "Not reported"}
      </dd>
    </div>
  );
}
