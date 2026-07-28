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
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createInterruptControlController, 
  type InterruptControlController,
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
  readonly controller: InterruptControlController;
  readonly hostAccess: ReactNode;
}

type SessionActionsPage = "menu" | "host";
type SessionActionsMode = "menu" | "host" | "confirmation" | "pending" | "result";

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
  controller,
  hostAccess
}: SessionActionsSheetProps) {
  const view = useInterruptControlView(controller);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [page, setPage] = useState<SessionActionsPage>("menu");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const interruptItemRef = useRef<HTMLButtonElement | null>(null);
  const hostItemRef = useRef<HTMLButtonElement | null>(null);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const doneButtonRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const descriptionId = useId();
  const mode = sessionActionsMode(page, view);

  useLayoutEffect(() => {
    if (!dialogOpen) return;
    queueMicrotask(() => {
      const focusTarget = mode === "menu"
        ? view.actionEnabled
          ? interruptItemRef.current
          : hostItemRef.current
        : mode === "host"
          ? backButtonRef.current
          : mode === "confirmation"
            ? cancelButtonRef.current
            : mode === "result"
              ? doneButtonRef.current
              : contentRef.current;
      focusTarget?.focus();
    });
  }, [dialogOpen, mode, view.actionEnabled]);

  const setOpen = (open: boolean) => {
    if (open) {
      setPage("menu");
      setDialogOpen(true);
      controller.open();
      return;
    }
    if (view.closeDisabled) return;
    controller.dismiss();
    setPage("menu");
    setDialogOpen(false);
  };

  const returnToMenu = () => {
    if (view.busy) return;
    controller.cancelConfirmation();
    setPage("menu");
  };

  const finish = () => {
    if (view.busy) return;
    controller.dismiss();
    setPage("menu");
    setDialogOpen(false);
  };

  const title = sessionActionsTitle(mode, view);
  const targetLabel = view.targetLabel ?? view.target?.sessionLabel ?? "current session";

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
          className={`hostdeck-sheet hostdeck-session-actions-sheet hostdeck-session-actions-sheet--${view.tone}`}
          aria-describedby={descriptionId}
          tabIndex={-1}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (view.busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (view.busy) event.preventDefault();
          }}
        >
          <Dialog.Description id={descriptionId} className="hostdeck-visually-hidden">
            Session actions for {targetLabel}.
          </Dialog.Description>
          <span className="hostdeck-sheet__handle" aria-hidden="true" />
          <div className="hostdeck-sheet__header hostdeck-session-actions__header">
            <span className="hostdeck-session-actions__heading">
              {mode === "host" || mode === "confirmation" ? (
                <button
                  ref={backButtonRef}
                  type="button"
                  className="hostdeck-icon-button"
                  aria-label="Back to session actions"
                  title="Back to session actions"
                  disabled={view.busy}
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
              disabled={view.closeDisabled}
              onClick={() => setOpen(false)}
            >
              <X size={22} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          <div className="hostdeck-session-actions__body">
            {mode === "menu" ? (
              <SessionActionsMenu
                hostItemRef={hostItemRef}
                interruptItemRef={interruptItemRef}
                onHostAccess={() => setPage("host")}
                onInterrupt={() => controller.beginConfirmation()}
                view={view}
              />
            ) : mode === "host" ? (
              <div className="hostdeck-session-actions__scroller hostdeck-session-actions__host">
                {hostAccess}
              </div>
            ) : mode === "confirmation" ? (
              <InterruptConfirmation
                cancelButtonRef={cancelButtonRef}
                onCancel={returnToMenu}
                onConfirm={() => void controller.confirm()}
                view={view}
              />
            ) : mode === "pending" ? (
              <InterruptPending view={view} />
            ) : (
              <InterruptResult doneButtonRef={doneButtonRef} onDone={finish} view={view} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SessionActionsMenu({
  hostItemRef,
  interruptItemRef,
  onHostAccess,
  onInterrupt,
  view
}: Readonly<{
  hostItemRef: RefObject<HTMLButtonElement | null>;
  interruptItemRef: RefObject<HTMLButtonElement | null>;
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
  view: InterruptControlView
): SessionActionsMode {
  if (page === "host") return "host";
  if (view.busy) return "pending";
  if (view.resultOpen && view.result !== null) return "result";
  if (view.confirmationOpen) return "confirmation";
  return "menu";
}

function sessionActionsTitle(mode: SessionActionsMode, view: InterruptControlView): string {
  if (mode === "host") return "Host & access";
  if (mode === "menu") return "Session actions";
  if (mode === "result") return view.result?.label ?? "Interrupt result";
  if (mode === "pending") return "Interrupt active turn";
  return "Interrupt active turn?";
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
