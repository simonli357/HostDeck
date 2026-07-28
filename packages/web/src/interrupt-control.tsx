import type { InterruptRequest } from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  EllipsisVertical,
  LoaderCircle,
  ShieldCheck,
  X
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  ArchiveActionItem,
  ArchiveConfirmation,
  ArchivePending,
  ArchiveResult,
  useArchiveControlView
} from "./archive-control.js";
import type {
  ArchiveControlController,
  ArchiveControlTone,
  ArchiveControlView
} from "./archive-control-state.js";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createInterruptControlController, 
  type InterruptControlController,
  type InterruptControlTone,
  type InterruptControlView,
  type InterruptResultView
} from "./interrupt-control-state.js";
import type {
  SessionDetailContinuityBoundary,
  SessionDetailFeedState
} from "./session-detail-feed.js";

export interface UseInterruptControlControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
}

export interface SessionActionsSheetProps {
  readonly archive: ArchiveControlController;
  readonly controller: InterruptControlController;
  readonly hostAccess: ReactNode;
  readonly onArchiveSucceeded: () => void;
}

type SessionActionsPage = "menu" | "host" | "interrupt" | "archive";
type SessionActionsMode =
  | "menu"
  | "host"
  | "interrupt_confirmation"
  | "interrupt_pending"
  | "interrupt_result"
  | "archive_confirmation"
  | "archive_pending"
  | "archive_result";
type SessionActionFocusOwner = "interrupt" | "archive";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

export function useInterruptControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  feed: SessionDetailFeedState,
  boundary: SessionDetailContinuityBoundary | null,
  options: UseInterruptControlControllerOptions = {}
): InterruptControlController {
  const createOperationId = options.createOperationId ?? createInterruptOperationId;
  const contextRef = useRef(Object.freeze({
    snapshot,
    events: feed.events,
    boundary
  }));
  contextRef.current = Object.freeze({ snapshot, events: feed.events, boundary });
  const owner = useMemo(
    () =>
      createInterruptControlController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        port: Object.freeze({
          async interrupt(input: Readonly<{
            sessionId: SessionId;
            turnId: string;
            request: InterruptRequest;
            signal: AbortSignal;
          }>) {
            const response = await coordinator.requestProtected(
              "turn_interrupt",
              {
                params: {
                  session_id: input.sessionId,
                  turn_id: input.turnId
                },
                body: input.request
              },
              { signal: input.signal }
            );
            return response.data;
          }
        })
      }),
    [coordinator, createOperationId, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: InterruptControlController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    owner.updateContext(Object.freeze({ snapshot, events: feed.events, boundary }));
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

export function useInterruptControlView(
  controller: InterruptControlController
): InterruptControlView {
  return useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
}

export function SessionActionsSheet({
  archive,
  controller,
  hostAccess,
  onArchiveSucceeded
}: SessionActionsSheetProps) {
  const view = useInterruptControlView(controller);
  const archiveView = useArchiveControlView(archive);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [page, setPage] = useState<SessionActionsPage>("menu");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const interruptItemRef = useRef<HTMLButtonElement | null>(null);
  const archiveItemRef = useRef<HTMLButtonElement | null>(null);
  const hostItemRef = useRef<HTMLButtonElement | null>(null);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const doneButtonRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const returnFocusOwner = useRef<SessionActionFocusOwner | null>(null);
  const descriptionId = useId();
  const mode = sessionActionsMode(page, view, archiveView);
  const closeDisabled = view.closeDisabled || archiveView.closeDisabled;
  const busy = view.busy || archiveView.busy;

  useLayoutEffect(() => {
    if (!dialogOpen) return;
    queueMicrotask(() => {
      const focusTarget = mode === "menu"
        ? returnFocusOwner.current === "interrupt"
          ? interruptItemRef.current
          : returnFocusOwner.current === "archive"
            ? archiveItemRef.current
            : view.actionEnabled
              ? interruptItemRef.current
              : archiveView.actionEnabled
                ? archiveItemRef.current
                : hostItemRef.current
        : mode === "host"
          ? backButtonRef.current
          : isConfirmationMode(mode)
            ? cancelButtonRef.current
            : isResultMode(mode)
              ? doneButtonRef.current
              : contentRef.current;
      returnFocusOwner.current = null;
      focusTarget?.focus();
    });
  }, [archiveView.actionEnabled, dialogOpen, mode, view.actionEnabled]);

  const setOpen = (open: boolean) => {
    if (open) {
      setDialogOpen(true);
      const interruptNext = controller.open();
      const archiveNext = archive.open();
      setPage(
        archiveNext.resultOpen
          ? "archive"
          : interruptNext.resultOpen
            ? "interrupt"
            : "menu"
      );
      return;
    }
    if (closeDisabled) return;
    controller.dismiss();
    archive.dismiss();
    setPage("menu");
    setDialogOpen(false);
  };

  const returnToMenu = () => {
    if (busy) return;
    if (page === "interrupt") {
      controller.cancelConfirmation();
      returnFocusOwner.current = "interrupt";
    } else if (page === "archive") {
      archive.cancelConfirmation();
      returnFocusOwner.current = "archive";
    }
    setPage("menu");
  };

  const finishInterrupt = () => {
    if (busy) return;
    controller.dismiss();
    archive.dismiss();
    setPage("menu");
    setDialogOpen(false);
  };

  const finishArchive = () => {
    if (busy) return;
    archive.dismiss();
    controller.dismiss();
    setPage("menu");
    setDialogOpen(false);
  };

  const finishArchiveSuccess = () => {
    if (busy || archiveView.result?.returnToSessions !== true) return;
    archive.acknowledgeResult();
    archive.dismiss();
    controller.dismiss();
    setPage("menu");
    setDialogOpen(false);
    onArchiveSucceeded();
  };

  const beginInterrupt = () => {
    const next = controller.beginConfirmation();
    if (!next.confirmationOpen) return;
    returnFocusOwner.current = "interrupt";
    setPage("interrupt");
  };

  const beginArchive = () => {
    const next = archive.beginConfirmation();
    if (!next.confirmationOpen) return;
    returnFocusOwner.current = "archive";
    setPage("archive");
  };

  const title = sessionActionsTitle(mode, view, archiveView);
  const interruptTargetLabel = view.targetLabel ?? view.target?.sessionLabel;
  const archiveTargetLabel = archiveView.targetLabel ?? archiveView.target?.sessionLabel;
  const targetLabel = mode.startsWith("archive_")
    ? archiveTargetLabel ?? "current session"
    : mode.startsWith("interrupt_")
      ? interruptTargetLabel ?? "current session"
      : interruptTargetLabel ?? archiveTargetLabel ?? "current session";
  const tone = sessionActionsTone(mode, view, archiveView);

  return (
    <Dialog.Root open={dialogOpen} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="hostdeck-icon-button"
          aria-label="Open session actions"
          title="Session actions"
        >
          <EllipsisVertical size={24} strokeWidth={2} aria-hidden="true" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        <Dialog.Content
          ref={contentRef}
          className={`hostdeck-sheet hostdeck-session-actions-sheet hostdeck-session-actions-sheet--${tone}`}
          aria-describedby={descriptionId}
          tabIndex={-1}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (closeDisabled) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (closeDisabled) event.preventDefault();
          }}
        >
          <Dialog.Description id={descriptionId} className="hostdeck-visually-hidden">
            Session actions for {targetLabel}.
          </Dialog.Description>
          <span className="hostdeck-sheet__handle" aria-hidden="true" />
          <div className="hostdeck-sheet__header hostdeck-session-actions__header">
            <span className="hostdeck-session-actions__heading">
              {mode === "host" || isConfirmationMode(mode) ? (
                <button
                  ref={backButtonRef}
                  type="button"
                  className="hostdeck-icon-button"
                  aria-label="Back to session actions"
                  title="Back to session actions"
                  disabled={busy}
                  onClick={returnToMenu}
                >
                  <ArrowLeft size={22} strokeWidth={2} aria-hidden="true" />
                </button>
              ) : null}
              <span>
                <Dialog.Title className="hostdeck-sheet__title">{title}</Dialog.Title>
                {mode === "menu" || mode === "host" ? (
                  <span className="hostdeck-session-actions__target">
                    Target: <strong>{targetLabel}</strong>
                  </span>
                ) : null}
              </span>
            </span>
            <button
              type="button"
              className="hostdeck-icon-button"
              aria-label="Close session actions"
              title="Close session actions"
              disabled={closeDisabled}
              onClick={() => setOpen(false)}
            >
              <X size={22} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          <div className="hostdeck-session-actions__body">
            {mode === "menu" ? (
              <SessionActionsMenu
                archiveItemRef={archiveItemRef}
                archiveView={archiveView}
                hostItemRef={hostItemRef}
                interruptItemRef={interruptItemRef}
                onArchive={beginArchive}
                onHostAccess={() => setPage("host")}
                onInterrupt={beginInterrupt}
                view={view}
              />
            ) : mode === "host" ? (
              <div className="hostdeck-session-actions__scroller hostdeck-session-actions__host">
                {hostAccess}
              </div>
            ) : mode === "interrupt_confirmation" ? (
              <InterruptConfirmation
                cancelButtonRef={cancelButtonRef}
                onCancel={returnToMenu}
                onConfirm={() => void controller.confirm()}
                view={view}
              />
            ) : mode === "interrupt_pending" ? (
              <InterruptPending view={view} />
            ) : mode === "interrupt_result" ? (
              <InterruptResult
                doneButtonRef={doneButtonRef}
                onDone={finishInterrupt}
                view={view}
              />
            ) : mode === "archive_confirmation" ? (
              <ArchiveConfirmation
                cancelButtonRef={cancelButtonRef}
                onCancel={returnToMenu}
                onConfirm={() => void archive.confirm()}
                view={archiveView}
              />
            ) : mode === "archive_pending" ? (
              <ArchivePending view={archiveView} />
            ) : (
              <ArchiveResult
                doneButtonRef={doneButtonRef}
                onDone={finishArchive}
                onReturnToSessions={finishArchiveSuccess}
                view={archiveView}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SessionActionsMenu({
  archiveItemRef,
  archiveView,
  hostItemRef,
  interruptItemRef,
  onArchive,
  onHostAccess,
  onInterrupt,
  view
}: Readonly<{
  archiveItemRef: RefObject<HTMLButtonElement | null>;
  archiveView: ArchiveControlView;
  hostItemRef: RefObject<HTMLButtonElement | null>;
  interruptItemRef: RefObject<HTMLButtonElement | null>;
  onArchive: () => void;
  onHostAccess: () => void;
  onInterrupt: () => void;
  view: InterruptControlView;
}>) {
  const detail = view.actionEnabled && view.target !== null
    ? `${view.target.stateLabel} - ${view.target.turnId}`
    : view.actionDisabledReason ?? "Session details are not available.";
  return (
    <nav className="hostdeck-utility-menu hostdeck-session-actions__menu" aria-label="Session actions">
      <ul className="hostdeck-utility-menu__list">
        <li>
          <button
            ref={interruptItemRef}
            type="button"
            className="hostdeck-utility-menu__item hostdeck-session-actions__interrupt"
            disabled={!view.actionEnabled}
            onClick={onInterrupt}
          >
            <CircleStop size={22} strokeWidth={2} aria-hidden="true" />
            <span>
              <strong>Interrupt active turn</strong>
              <small className={view.actionEnabled ? undefined : "hostdeck-utility-menu__reason"}>
                {detail}
              </small>
            </span>
            <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </li>
        <li>
          <ArchiveActionItem
            itemRef={archiveItemRef}
            onArchive={onArchive}
            view={archiveView}
          />
        </li>
        <li>
          <button
            ref={hostItemRef}
            type="button"
            className="hostdeck-utility-menu__item"
            onClick={onHostAccess}
          >
            <ShieldCheck size={22} strokeWidth={2} aria-hidden="true" />
            <span>
              <strong>Host &amp; access</strong>
              <small>Connection, pairing, and write-lock status</small>
            </span>
            <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </li>
      </ul>
    </nav>
  );
}

function InterruptConfirmation({
  cancelButtonRef,
  onCancel,
  onConfirm,
  view
}: Readonly<{
  cancelButtonRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  view: InterruptControlView;
}>) {
  const target = view.target;
  return (
    <div className="hostdeck-session-actions__panel">
      <div className="hostdeck-session-actions__scroller">
        <div className="hostdeck-interrupt-risk">
          <CircleStop size={23} strokeWidth={2} aria-hidden="true" />
          <span>
            <strong>Stop only this active turn</strong>
            <small>The session and its retained history remain available.</small>
          </span>
        </div>
        <dl className="hostdeck-interrupt-facts">
          <div>
            <dt>Session</dt>
            <dd>{target?.sessionLabel ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Turn</dt>
            <dd>{target?.turnId ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{target?.stateLabel ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Session data</dt>
            <dd>Not archived, deleted, or erased</dd>
          </div>
        </dl>
        <InterruptStatus view={view} />
      </div>
      <div className="hostdeck-session-actions__footer">
        <button
          ref={cancelButtonRef}
          type="button"
          className="hostdeck-secondary-button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="hostdeck-danger-button"
          disabled={!view.confirmEnabled}
          onClick={onConfirm}
        >
          <CircleStop size={19} strokeWidth={2} aria-hidden="true" />
          Interrupt turn
        </button>
      </div>
    </div>
  );
}

function InterruptPending({ view }: Readonly<{ view: InterruptControlView }>) {
  return (
    <div className="hostdeck-session-actions__panel" aria-busy="true">
      <div className="hostdeck-session-actions__scroller">
        <InterruptStatus view={view} pending />
        {view.target === null ? null : (
          <dl className="hostdeck-interrupt-facts">
            <div>
              <dt>Session</dt>
              <dd>{view.target.sessionLabel}</dd>
            </div>
            <div>
              <dt>Turn</dt>
              <dd>{view.target.turnId}</dd>
            </div>
            <div>
              <dt>State sent</dt>
              <dd>{view.target.stateLabel}</dd>
            </div>
          </dl>
        )}
      </div>
      <div className="hostdeck-session-actions__footer hostdeck-session-actions__footer--single">
        <button type="button" className="hostdeck-danger-button" disabled>
          <LoaderCircle className="hostdeck-spin" size={19} strokeWidth={2} aria-hidden="true" />
          Waiting for terminal proof
        </button>
      </div>
    </div>
  );
}

function InterruptResult({
  doneButtonRef,
  onDone,
  view
}: Readonly<{
  doneButtonRef: RefObject<HTMLButtonElement | null>;
  onDone: () => void;
  view: InterruptControlView;
}>) {
  const result = view.result;
  return (
    <div className="hostdeck-session-actions__panel">
      <div className="hostdeck-session-actions__scroller">
        <InterruptStatus view={view} />
        {view.target === null ? null : (
          <dl className="hostdeck-interrupt-facts">
            <div>
              <dt>Session</dt>
              <dd>{view.target.sessionLabel}</dd>
            </div>
            <div>
              <dt>Turn</dt>
              <dd>{view.target.turnId}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd>{interruptOutcomeLabel(result?.terminalState ?? null)}</dd>
            </div>
            {result?.updatedAt === null || result?.updatedAt === undefined ? null : (
              <div>
                <dt>Observed</dt>
                <dd>
                  <InterruptTime value={result.updatedAt} />
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
      <div className="hostdeck-session-actions__footer hostdeck-session-actions__footer--single">
        <button
          ref={doneButtonRef}
          type="button"
          className="hostdeck-primary-button"
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function InterruptStatus({
  pending = false,
  view
}: Readonly<{
  pending?: boolean;
  view: InterruptControlView;
}>) {
  const Icon = pending
    ? LoaderCircle
    : view.tone === "connected"
      ? CheckCircle2
      : view.tone === "danger"
        ? AlertTriangle
        : CircleStop;
  const role = view.tone === "danger" && !pending ? "alert" : "status";
  return (
    <div
      className={`hostdeck-interrupt-status hostdeck-interrupt-status--${view.tone}`}
      role={role}
      aria-live={pending ? "polite" : undefined}
    >
      <Icon
        className={pending ? "hostdeck-spin" : undefined}
        size={23}
        strokeWidth={2}
        aria-hidden="true"
      />
      <span>
        <strong>{view.status}</strong>
        {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
      </span>
    </div>
  );
}

function InterruptTime({ value }: Readonly<{ value: string }>) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("HostDeck interrupt result time is invalid.");
  }
  return (
    <time dateTime={value} title={value}>
      {timestampFormatter.format(date)}
    </time>
  );
}

function sessionActionsMode(
  page: SessionActionsPage,
  view: InterruptControlView,
  archiveView: ArchiveControlView
): SessionActionsMode {
  if (page === "host") return "host";
  if (page === "interrupt") {
    if (view.busy) return "interrupt_pending";
    if (view.resultOpen && view.result !== null) return "interrupt_result";
    if (view.confirmationOpen) return "interrupt_confirmation";
  }
  if (page === "archive") {
    if (archiveView.busy) return "archive_pending";
    if (archiveView.resultOpen && archiveView.result !== null) return "archive_result";
    if (archiveView.confirmationOpen) return "archive_confirmation";
  }
  return "menu";
}

function sessionActionsTitle(
  mode: SessionActionsMode,
  view: InterruptControlView,
  archiveView: ArchiveControlView
): string {
  if (mode === "host") return "Host & access";
  if (mode === "menu") return "Session actions";
  if (mode === "interrupt_result") return view.result?.label ?? "Interrupt result";
  if (mode === "interrupt_pending") return "Interrupt active turn";
  if (mode === "interrupt_confirmation") return "Interrupt active turn?";
  if (mode === "archive_result") return archiveView.result?.label ?? "Archive result";
  if (mode === "archive_pending") return "Archive session";
  return "Archive session?";
}

function sessionActionsTone(
  mode: SessionActionsMode,
  view: InterruptControlView,
  archiveView: ArchiveControlView
): InterruptControlTone | ArchiveControlTone {
  if (mode.startsWith("archive_")) return archiveView.tone;
  if (mode.startsWith("interrupt_")) return view.tone;
  if (mode === "host") return "focus";
  if (view.actionEnabled) return view.tone;
  return archiveView.actionEnabled ? archiveView.tone : "attention";
}

function isConfirmationMode(mode: SessionActionsMode): boolean {
  return mode === "interrupt_confirmation" || mode === "archive_confirmation";
}

function isResultMode(mode: SessionActionsMode): boolean {
  return mode === "interrupt_result" || mode === "archive_result";
}

function interruptOutcomeLabel(
  state: InterruptResultView["terminalState"]
): string {
  switch (state) {
    case "interrupted": return "Interrupted";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case null: return "Not confirmed";
  }
}

function createInterruptOperationId(): string {
  return createSecureBrowserOperationId("interrupt");
}
