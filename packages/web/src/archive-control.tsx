import type { ArchiveSessionRequest } from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  AlertTriangle,
  Archive as ArchiveIcon,
  CheckCircle2,
  ChevronRight,
  LoaderCircle
} from "lucide-react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";
import {
  type ArchiveControlController,
  type ArchiveControlView,
  type ArchiveResultKind,
  createArchiveControlController
} from "./archive-control-state.js";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";

export interface UseArchiveControlControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
}

export function useArchiveControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  options: UseArchiveControlControllerOptions = {}
): ArchiveControlController {
  const createOperationId = options.createOperationId ?? createArchiveOperationId;
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createArchiveControlController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        port: Object.freeze({
          async archive(input: Readonly<{
            sessionId: SessionId;
            request: ArchiveSessionRequest;
            signal: AbortSignal;
          }>) {
            const response = await coordinator.requestProtected(
              "session_archive",
              {
                params: { session_id: input.sessionId },
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
    controller: ArchiveControlController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    owner.updateContext(Object.freeze({ snapshot }));
  }, [owner, snapshot]);

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

export function useArchiveControlView(
  controller: ArchiveControlController
): ArchiveControlView {
  return useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
}

export function ArchiveActionItem({
  itemRef,
  onArchive,
  view
}: Readonly<{
  itemRef: RefObject<HTMLButtonElement | null>;
  onArchive: () => void;
  view: ArchiveControlView;
}>) {
  const detail = view.actionEnabled
    ? "Idle session - retained history stays available"
    : view.actionDisabledReason ?? "Session details are not available.";
  return (
    <button
      ref={itemRef}
      type="button"
      className="hostdeck-utility-menu__item hostdeck-session-actions__archive"
      disabled={!view.actionEnabled}
      onClick={onArchive}
    >
      <ArchiveIcon size={22} strokeWidth={2} aria-hidden="true" />
      <span>
        <strong>Archive session</strong>
        <small className={view.actionEnabled ? undefined : "hostdeck-utility-menu__reason"}>
          {detail}
        </small>
      </span>
      <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export function ArchiveConfirmation({
  cancelButtonRef,
  onCancel,
  onConfirm,
  view
}: Readonly<{
  cancelButtonRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  view: ArchiveControlView;
}>) {
  return (
    <div className="hostdeck-session-actions__panel">
      <div className="hostdeck-session-actions__scroller">
        <div className="hostdeck-archive-risk">
          <ArchiveIcon size={23} strokeWidth={2} aria-hidden="true" />
          <span>
            <strong>Archive this managed session</strong>
            <small>
              After laptop confirmation, it leaves active sessions without deleting files or the
              Codex thread.
            </small>
          </span>
        </div>
        <dl className="hostdeck-archive-facts">
          <div>
            <dt>Session</dt>
            <dd>{view.target?.sessionLabel ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Current turn</dt>
            <dd>Idle - no turn will be interrupted</dd>
          </div>
          <div>
            <dt>Retained history</dt>
            <dd>Preserved - not deleted or erased</dd>
          </div>
          <div>
            <dt>Undo</dt>
            <dd>Not available in HostDeck V1</dd>
          </div>
        </dl>
        <ArchiveStatus view={view} />
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
          <ArchiveIcon size={19} strokeWidth={2} aria-hidden="true" />
          Archive session
        </button>
      </div>
    </div>
  );
}

export function ArchivePending({ view }: Readonly<{ view: ArchiveControlView }>) {
  return (
    <div className="hostdeck-session-actions__panel" aria-busy="true">
      <div className="hostdeck-session-actions__scroller">
        <ArchiveStatus view={view} pending />
        {view.target === null ? null : (
          <dl className="hostdeck-archive-facts">
            <div>
              <dt>Session</dt>
              <dd>{view.target.sessionLabel}</dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>Archive only - no delete or interrupt</dd>
            </div>
          </dl>
        )}
      </div>
      <div className="hostdeck-session-actions__footer hostdeck-session-actions__footer--single">
        <button type="button" className="hostdeck-danger-button" disabled>
          <LoaderCircle className="hostdeck-spin" size={19} strokeWidth={2} aria-hidden="true" />
          Waiting for laptop confirmation
        </button>
      </div>
    </div>
  );
}

export function ArchiveResult({
  doneButtonRef,
  onDone,
  onReturnToSessions,
  view
}: Readonly<{
  doneButtonRef: RefObject<HTMLButtonElement | null>;
  onDone: () => void;
  onReturnToSessions: () => void;
  view: ArchiveControlView;
}>) {
  const result = view.result;
  return (
    <div className="hostdeck-session-actions__panel">
      <div className="hostdeck-session-actions__scroller">
        <ArchiveStatus view={view} />
        {result === null ? null : (
          <div className="hostdeck-archive-consequence">
            <strong>{result.consequence}</strong>
          </div>
        )}
        {view.target === null ? null : (
          <dl className="hostdeck-archive-facts">
            <div>
              <dt>Session</dt>
              <dd>{view.target.sessionLabel}</dd>
            </div>
            <div>
              <dt>Archive</dt>
              <dd>{archiveOutcomeLabel(result?.kind ?? null)}</dd>
            </div>
            <div>
              <dt>History</dt>
              <dd>Not deleted</dd>
            </div>
          </dl>
        )}
      </div>
      <div className="hostdeck-session-actions__footer hostdeck-session-actions__footer--single">
        <button
          ref={doneButtonRef}
          type="button"
          className="hostdeck-primary-button"
          onClick={result?.returnToSessions === true ? onReturnToSessions : onDone}
        >
          {result?.returnToSessions === true ? "Back to sessions" : "Done"}
        </button>
      </div>
    </div>
  );
}

function ArchiveStatus({
  pending = false,
  view
}: Readonly<{
  pending?: boolean;
  view: ArchiveControlView;
}>) {
  const Icon = pending
    ? LoaderCircle
    : view.tone === "connected"
      ? CheckCircle2
      : view.tone === "danger"
        ? AlertTriangle
        : ArchiveIcon;
  const role = view.tone === "danger" && !pending ? "alert" : "status";
  return (
    <div
      className={`hostdeck-archive-status hostdeck-archive-status--${view.tone}`}
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

function archiveOutcomeLabel(kind: ArchiveResultKind | null): string {
  switch (kind) {
    case "succeeded": return "Confirmed and saved";
    case "blocked": return "Blocked";
    case "not_completed": return "Not completed";
    case "outcome_unknown": return "Remote/local outcome unknown";
    case "inconsistent": return "Inconsistent";
    case null: return "Not confirmed";
  }
}

function createArchiveOperationId(): string {
  return createSecureBrowserOperationId("archive");
}
