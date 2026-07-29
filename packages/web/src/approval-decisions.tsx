import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CircleCheck,
  Clock3,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  X
} from "lucide-react";
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";
import {
  type ApprovalDecisionClockPort,
  type ApprovalDecisionController,
  type ApprovalDecisionItemView,
  type ApprovalDecisionRespondInput,
  type ApprovalDecisionView,
  createApprovalDecisionController
} from "./approval-decision-state.js";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import {
  type BrowserConnectionSnapshot,
  type BrowserConnectionStateCoordinator,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { EventDiagnosticsAction } from "./event-diagnostics.js";
import type { EventDiagnosticsController } from "./event-diagnostics-state.js";
import type {
  SessionDetailFeedState,
  SessionDetailTimelineItem
} from "./session-detail-feed.js";

export interface UseApprovalDecisionControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
  readonly clock?: ApprovalDecisionClockPort | undefined;
}

export interface ApprovalTimelineItemProps {
  readonly item: ApprovalDecisionItemView;
  readonly timeline: SessionDetailTimelineItem | null;
  readonly controller: ApprovalDecisionController;
  readonly confirmationOrigin?: RefObject<HTMLButtonElement | null> | undefined;
  readonly eventDiagnostics?: EventDiagnosticsController | undefined;
  readonly eventDiagnosticsOrigin?: RefObject<HTMLButtonElement | null> | undefined;
}

export interface ApprovalConfirmationDialogProps {
  readonly view: ApprovalDecisionView;
  readonly controller: ApprovalDecisionController;
  readonly confirmationOrigin?: RefObject<HTMLButtonElement | null> | undefined;
}

export interface ApprovalStatusTimelineItemProps {
  readonly view: ApprovalDecisionView;
  readonly controller: ApprovalDecisionController;
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});
const createApprovalOperationId = () => createSecureBrowserOperationId("approval");

export function useApprovalDecisionController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  feed: SessionDetailFeedState,
  options: UseApprovalDecisionControllerOptions = {}
): ApprovalDecisionController {
  const createOperationId = options.createOperationId ?? createApprovalOperationId;
  const approvalEvents = useMemo(
    () => Object.freeze(feed.events.filter((event) => event.type === "approval")),
    [feed.events]
  );
  const contextRef = useRef(Object.freeze({ snapshot, events: approvalEvents }));
  contextRef.current = Object.freeze({ snapshot, events: approvalEvents });
  const owner = useMemo(
    () =>
      createApprovalDecisionController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        clock: options.clock,
        port: Object.freeze({
          async read(input: { readonly sessionId: SessionId; readonly signal: AbortSignal }) {
            const response = await coordinator.requestSelectedSessionRead(
              "approval_list",
              { params: { session_id: input.sessionId } },
              { signal: input.signal }
            );
            return response.data;
          },
          async respond(input: ApprovalDecisionRespondInput) {
            const requestEpoch = currentApprovalWriteEpoch(coordinator.snapshot(), input.sessionId);
            const response = await coordinator.requestProtected(
              "approval_respond",
              {
                params: {
                  session_id: input.sessionId,
                  request_id: input.requestId
                },
                body: input.request
              },
              { signal: input.signal }
            );
            let responseEpoch: number;
            try {
              responseEpoch = currentApprovalWriteEpoch(coordinator.snapshot(), input.sessionId);
            } catch {
              throw new Error("HostDeck approval access changed after dispatch.");
            }
            if (responseEpoch !== requestEpoch) {
              throw new Error("HostDeck approval access changed after dispatch.");
            }
            return response.data;
          }
        })
      }),
    [coordinator, createOperationId, options.clock, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: ApprovalDecisionController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    owner.updateContext(Object.freeze({ snapshot, events: approvalEvents }));
  }, [approvalEvents, owner, snapshot]);

  useEffect(() => {
    const current = contextRef.current;
    if (current.snapshot !== snapshot || current.events !== approvalEvents) return;
    void owner.synchronize();
  }, [approvalEvents, owner, snapshot]);

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

export function useApprovalDecisionView(
  controller: ApprovalDecisionController
): ApprovalDecisionView {
  return useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
}

export function ApprovalTimelineItem({
  item,
  timeline,
  controller,
  confirmationOrigin,
  eventDiagnostics,
  eventDiagnosticsOrigin
}: ApprovalTimelineItemProps) {
  const capturedAt = timeline?.capturedAt ?? item.createdAt;
  const timeLabel = timeline?.timeLabel ?? formatTimestamp(item.createdAt);
  const title = approvalTitle(item.state);
  return (
    <li className={`hostdeck-timeline-item hostdeck-timeline-item--${item.tone} hostdeck-approval-item`}>
      <span className="hostdeck-timeline-item__node" aria-hidden="true">
        <ShieldAlert
          size={18}
          strokeWidth={2}
          className={item.submitting ? "hostdeck-spin" : undefined}
        />
      </span>
      <article>
        <div className="hostdeck-timeline-item__header">
          <span className="hostdeck-timeline-item__label">Approval</span>
          <span className="hostdeck-timeline-item__state">{item.stateLabel}</span>
          {capturedAt === null || timeLabel === null ? null : (
            <time dateTime={capturedAt}>{timeLabel}</time>
          )}
          {eventDiagnostics === undefined ||
          eventDiagnosticsOrigin === undefined ||
          timeline?.diagnosticCursor === null ||
          timeline?.diagnosticCursor === undefined ? null : (
            <EventDiagnosticsAction
              controller={eventDiagnostics}
              cursor={timeline.diagnosticCursor}
              disabled={item.submitting}
              originRef={eventDiagnosticsOrigin}
            />
          )}
        </div>
        <h2>{title}</h2>
        <p className="hostdeck-approval-item__detail">{item.statusDetail}</p>
        <dl className="hostdeck-timeline-item__facts hostdeck-approval-item__facts">
          <div>
            <dt>Action</dt>
            <dd>{item.action}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{item.scope}</dd>
          </div>
          {item.reason === null ? null : (
            <div>
              <dt>Reason</dt>
              <dd>{item.reason}</dd>
            </div>
          )}
          <div>
            <dt>Risk</dt>
            <dd>{item.riskLabel}</dd>
          </div>
          <div>
            <dt>Grant</dt>
            <dd>{item.grantLabel}</dd>
          </div>
          {item.expiresAt === null ? null : (
            <div>
              <dt>Expires</dt>
              <dd><ApprovalTime value={item.expiresAt} /></dd>
            </div>
          )}
        </dl>
        {timeline?.contentNotice === null || timeline?.contentNotice === undefined ? null : (
          <p className="hostdeck-timeline-item__content-notice">
            <ShieldAlert size={15} strokeWidth={2} aria-hidden="true" />
            <span>{timeline.contentNotice}</span>
          </p>
        )}
        {!item.actionable ? (
          <div
            className={`hostdeck-approval-item__status hostdeck-tone--${item.tone}`}
            role={item.state === "conflict" ? "alert" : "status"}
          >
            {approvalStatusIcon(item)}
            <span>{item.disabledReason ?? item.statusDetail}</span>
          </div>
        ) : (
          <fieldset className="hostdeck-approval-item__actions">
            <legend className="hostdeck-visually-hidden">Approval decision</legend>
            <button
              type="button"
              className="hostdeck-danger-button"
              disabled={!item.denyEnabled}
              onClick={() => void controller.deny(item.handle)}
            >
              <ShieldX size={17} strokeWidth={2} aria-hidden="true" />
              Deny
            </button>
            <button
              type="button"
              className="hostdeck-primary-button"
              disabled={!item.approveEnabled}
              onClick={(event) => {
                if (item.approveRequiresConfirmation) {
                  if (confirmationOrigin !== undefined) {
                    confirmationOrigin.current = event.currentTarget;
                  }
                  controller.beginApprove(item.handle);
                }
                else void controller.approve(item.handle);
              }}
            >
              <ShieldCheck size={17} strokeWidth={2} aria-hidden="true" />
              {item.approveLabel}
            </button>
          </fieldset>
        )}
      </article>
    </li>
  );
}

export function ApprovalConfirmationDialog({
  view,
  controller,
  confirmationOrigin
}: ApprovalConfirmationDialogProps) {
  const confirmation = view.confirmation;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitting = view.phase === "submitting";
  const targetDescriptionId = useId();
  const statusDescriptionId = useId();

  return (
    <Dialog.Root
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open && !submitting) controller.cancelApprove();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        {confirmation === null ? null : (
          <Dialog.Content
            className={`hostdeck-sheet hostdeck-approval-sheet hostdeck-approval-sheet--${confirmation.tone}`}
            aria-describedby={`${targetDescriptionId} ${statusDescriptionId}`}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cancelRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              if (submitting) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (submitting) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              const origin = confirmationOrigin?.current;
              if (confirmationOrigin !== undefined) confirmationOrigin.current = null;
              if (origin?.isConnected === true) {
                event.preventDefault();
                origin.focus();
              }
            }}
          >
            <span className="hostdeck-sheet__handle" aria-hidden="true" />
            <div className="hostdeck-sheet__header hostdeck-approval-sheet__header">
              <span>
                <Dialog.Title className="hostdeck-sheet__title">{confirmation.title}</Dialog.Title>
                <Dialog.Description
                  className="hostdeck-approval-sheet__target"
                  id={targetDescriptionId}
                >
                  Target: <strong>{confirmation.sessionLabel}</strong>
                </Dialog.Description>
              </span>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="hostdeck-icon-button"
                  aria-label="Close approval confirmation"
                  title="Close approval confirmation"
                  disabled={submitting}
                >
                  <X size={22} strokeWidth={2} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>

            <form
              className="hostdeck-approval-sheet__form"
              aria-label="Approval confirmation"
              onSubmit={(event) => {
                event.preventDefault();
                void controller.confirmApprove();
              }}
            >
              <div className="hostdeck-approval-sheet__body">
                <div className={`hostdeck-approval-sheet__risk hostdeck-tone--${confirmation.tone}`}>
                  <AlertTriangle size={20} strokeWidth={2} aria-hidden="true" />
                  <span>
                    <strong>{confirmation.riskLabel} risk</strong>
                    <small>Review the exact action and scope before approving once.</small>
                  </span>
                </div>
                <dl className="hostdeck-approval-sheet__facts">
                  <div>
                    <dt>Action</dt>
                    <dd>{confirmation.action}</dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>{confirmation.scope}</dd>
                  </div>
                  {confirmation.reason === null ? null : (
                    <div>
                      <dt>Reason</dt>
                      <dd>{confirmation.reason}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Grant</dt>
                    <dd>{confirmation.grantLabel}</dd>
                  </div>
                  {confirmation.expiresAt === null ? null : (
                    <div>
                      <dt>Expires</dt>
                      <dd><ApprovalTime value={confirmation.expiresAt} /></dd>
                    </div>
                  )}
                </dl>
                <div
                  className={`hostdeck-approval-sheet__status hostdeck-tone--${view.tone}`}
                  id={statusDescriptionId}
                  role={view.tone === "danger" ? "alert" : "status"}
                  aria-atomic="true"
                >
                  {submitting ? (
                    <LoaderCircle className="hostdeck-spin" size={18} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <ShieldAlert size={18} strokeWidth={2} aria-hidden="true" />
                  )}
                  <span>
                    <strong>{view.status}</strong>
                    {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
                  </span>
                </div>
              </div>
              <div className="hostdeck-approval-sheet__footer">
                <Dialog.Close asChild>
                  <button
                    ref={cancelRef}
                    type="button"
                    className="hostdeck-secondary-button"
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  className={confirmation.tone === "danger"
                    ? "hostdeck-danger-button"
                    : "hostdeck-primary-button"}
                  disabled={!confirmation.confirmEnabled}
                >
                  {submitting ? (
                    <LoaderCircle className="hostdeck-spin" size={18} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <ShieldCheck size={18} strokeWidth={2} aria-hidden="true" />
                  )}
                  Approve once
                </button>
              </div>
            </form>
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ApprovalStatusTimelineItem({
  view,
  controller
}: ApprovalStatusTimelineItemProps) {
  if (!shouldShowApprovalGlobalStatus(view)) return null;
  const danger = view.tone === "danger";
  return (
    <li className={`hostdeck-timeline-item hostdeck-timeline-item--${view.tone} hostdeck-approval-status-item`}>
      <span className="hostdeck-timeline-item__node" aria-hidden="true">
        {view.busy ? (
          <LoaderCircle className="hostdeck-spin" size={18} strokeWidth={2} />
        ) : danger ? (
          <AlertTriangle size={18} strokeWidth={2} />
        ) : (
          <ShieldAlert size={18} strokeWidth={2} />
        )}
      </span>
      <article
        role={danger ? "alert" : "status"}
        aria-atomic="true"
      >
        <div className="hostdeck-timeline-item__header">
          <span className="hostdeck-timeline-item__label">Approvals</span>
        </div>
        <h2>{view.status}</h2>
        {view.statusDetail === null ? null : <p>{view.statusDetail}</p>}
        <button
          type="button"
          className="hostdeck-icon-text-button"
          disabled={!view.refreshEnabled}
          onClick={() => void controller.refresh()}
        >
          <RefreshCw size={17} strokeWidth={2} aria-hidden="true" />
          Check status
        </button>
      </article>
    </li>
  );
}

function currentApprovalWriteEpoch(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): number {
  const targetData = snapshot.targetState.data;
  const session = targetData?.kind === "session_detail"
    ? targetData.response.session.session
    : null;
  if (
    snapshot.target?.kind !== "session_detail" ||
    snapshot.target.sessionId !== sessionId ||
    snapshot.access.state !== "current" ||
    snapshot.access.data?.can_read_sessions !== true ||
    snapshot.targetState.state !== "current" ||
    session?.id !== sessionId ||
    session.session_state !== "active" ||
    session.archived_at !== null ||
    session.freshness !== "current" ||
    !snapshot.writeEligibility.eligible ||
    snapshot.stream.state !== "connected" ||
    (snapshot.stream.continuity !== "contiguous" && snapshot.stream.continuity !== "boundary")
  ) {
    throw new HostDeckBrowserConnectionError("not_ready");
  }
  return snapshot.epoch;
}

export function shouldShowApprovalGlobalStatus(view: ApprovalDecisionView): boolean {
  return view.phase === "loading" ||
    view.phase === "read_failed" ||
    view.phase === "decision_failed" ||
    view.phase === "outcome_unknown" ||
    view.phase === "unsupported";
}

function approvalTitle(state: ApprovalDecisionItemView["state"]): string {
  switch (state) {
    case "pending": return "Approval required";
    case "event_only": return "Approval status checking";
    case "due": return "Approval expiry reached";
    case "responding": return "Approval response pending";
    case "approved": return "Approved once";
    case "denied": return "Request denied";
    case "expired": return "Approval expired";
    case "superseded": return "Approval superseded";
    case "conflict": return "Approval details conflict";
  }
}

function approvalStatusIcon(item: ApprovalDecisionItemView) {
  if (item.state === "approved") {
    return <CircleCheck size={17} strokeWidth={2} aria-hidden="true" />;
  }
  if (item.state === "denied" || item.state === "conflict") {
    return <AlertTriangle size={17} strokeWidth={2} aria-hidden="true" />;
  }
  return <Clock3 size={17} strokeWidth={2} aria-hidden="true" />;
}

function ApprovalTime({ value }: Readonly<{ value: string }>) {
  return (
    <time dateTime={value} title={value}>
      {formatTimestamp(value) ?? "Unknown"}
    </time>
  );
}

function formatTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : timestampFormatter.format(date);
}
