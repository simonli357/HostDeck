import type { SelectedProjectionEvent } from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  Activity,
  AlertTriangle,
  Bot,
  CircleHelp,
  Clock3,
  FileText,
  GitBranch,
  History,
  LoaderCircle,
  type LucideIcon,
  Radio,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldAlert,
  UserRound,
  Wrench,
  XCircle
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  advanceApprovalAnnouncement,
  initialApprovalAnnouncementState,
  newActivityAnnouncement
} from "./accessibility-state.js";
import type {
  ApprovalDecisionController,
  ApprovalDecisionView
} from "./approval-decision-state.js";
import {
  ApprovalConfirmationDialog,
  ApprovalStatusTimelineItem,
  ApprovalTimelineItem,
  shouldShowApprovalGlobalStatus,
  useApprovalDecisionController,
  useApprovalDecisionView
} from "./approval-decisions.js";
import { useArchiveControlController } from "./archive-control.js";
import type { ArchiveControlController } from "./archive-control-state.js";
import { useCompactControlController } from "./compact-control.js";
import type { CompactControlController } from "./compact-control-state.js";
import type {
  BrowserConnectionPhase,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  formatCrossScreenObservationFacts,
  projectCrossScreenRecoveredFailure,
  projectCrossScreenStaleObservations
} from "./cross-screen-failure-state.js";
import {
  EventDiagnosticsAction,
  EventDiagnosticsSheet,
  useEventDiagnosticsController
} from "./event-diagnostics.js";
import type { EventDiagnosticsController } from "./event-diagnostics-state.js";
import { GoalControl, useGoalControlController } from "./goal-control.js";
import type { GoalControlController } from "./goal-control-state.js";
import { HostLockRouteRail } from "./host-lock.js";
import {
  type HostLockProjection,
  projectHostLockState
} from "./host-lock-state.js";
import { useInterruptControlController } from "./interrupt-control.js";
import type { InterruptControlController } from "./interrupt-control-state.js";
import { useLaptopResumeControlController } from "./laptop-resume-control.js";
import type { LaptopResumeControlController } from "./laptop-resume-control-state.js";
import { type MissionTone, projectSessionRow } from "./mission-control.js";
import {
  ModelControl,
  useModelControlController
} from "./model-control.js";
import type { ModelControlController } from "./model-control-state.js";
import { PlanControl, usePlanControlController } from "./plan-control.js";
import type { PlanControlController } from "./plan-control-state.js";
import {
  PromptComposer,
  usePromptComposerController
} from "./prompt-composer.js";
import type { PromptComposerController } from "./prompt-composer-state.js";
import { projectRemoteConnectionRecovery } from "./remote-connection-recovery-state.js";
import { projectRuntimeCompatibility } from "./runtime-compatibility-state.js";
import {
  appendSessionDetailEvent,
  createSessionDetailFeed,
  projectSessionDetailTimeline,
  type SessionDetailFeedState,
  type SessionDetailTimelineIcon,
  type SessionDetailTimelineItem,
  type SessionDetailTimestampFormatter,
  type SessionDetailTone,
  sessionDetailFeedLimit
} from "./session-detail-feed.js";
import { SessionUtilities } from "./session-utilities.js";
import { useSkillsControlController } from "./skills-control.js";
import type { SkillsControlController } from "./skills-control-state.js";
import {
  useUsageControlController
} from "./usage-control.js";
import type { UsageControlController } from "./usage-control-state.js";

export type SessionDetailPendingAction = "refresh" | null;

interface SessionDetailContextCell {
  readonly label: "Status" | "Project" | "Stream";
  readonly value: string;
  readonly detail: string | null;
  readonly tone: SessionDetailTone;
  readonly icon: LucideIcon;
}

interface SessionDetailNotice {
  readonly title: string;
  readonly body: string;
  readonly tone: Exclude<SessionDetailTone, "focus" | "connected">;
  readonly urgent: boolean;
}

export interface SessionDetailProjection {
  readonly canDisclose: boolean;
  readonly loading: boolean;
  readonly replayPending: boolean;
  readonly stale: boolean;
  readonly empty: boolean;
  readonly activityUnavailable: boolean;
  readonly noVisibleActivity: boolean;
  readonly headerTitle: string;
  readonly headerSubtitle: string;
  readonly contextCells: readonly SessionDetailContextCell[];
  readonly lock: HostLockProjection;
  readonly notices: readonly SessionDetailNotice[];
  readonly timeline: readonly SessionDetailTimelineItem[];
}

export interface SessionDetailControllerState {
  readonly snapshot: BrowserConnectionSnapshot;
  readonly feed: SessionDetailFeedState;
  readonly nowMs: number;
  readonly pendingAction: SessionDetailPendingAction;
  readonly actionError: string | null;
  readonly feedError: string | null;
  readonly onRefresh: () => void;
  readonly prompt: PromptComposerController;
  readonly model: ModelControlController;
  readonly goal: GoalControlController;
  readonly plan: PlanControlController;
  readonly usage: UsageControlController;
  readonly compact: CompactControlController;
  readonly skills: SkillsControlController;
  readonly approvals: ApprovalDecisionController;
  readonly eventDiagnostics: EventDiagnosticsController;
  readonly interrupt: InterruptControlController;
  readonly archive: ArchiveControlController;
  readonly laptopResume: LaptopResumeControlController;
}

export interface UseSessionDetailControllerOptions {
  readonly now?: (() => number) | undefined;
}

export interface ConnectedSessionDetailProps extends UseSessionDetailControllerOptions {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly sessionId: SessionId;
  readonly formatTimestamp?: SessionDetailTimestampFormatter | undefined;
}

export interface SessionDetailScreenProps {
  readonly sessionId: SessionId;
  readonly snapshot: BrowserConnectionSnapshot;
  readonly feed: SessionDetailFeedState;
  readonly nowMs: number;
  readonly formatTimestamp?: SessionDetailTimestampFormatter | undefined;
  readonly pendingAction?: SessionDetailPendingAction;
  readonly actionError?: string | null;
  readonly feedError?: string | null;
  readonly onRefresh?: () => void;
  readonly prompt?: PromptComposerController | undefined;
  readonly model?: ModelControlController | undefined;
  readonly goal?: GoalControlController | undefined;
  readonly plan?: PlanControlController | undefined;
  readonly usage?: UsageControlController | undefined;
  readonly compact?: CompactControlController | undefined;
  readonly skills?: SkillsControlController | undefined;
  readonly approvals?: ApprovalDecisionController | undefined;
  readonly eventDiagnostics?: EventDiagnosticsController | undefined;
  readonly projection?: SessionDetailProjection | undefined;
}

const detailScrollThreshold = 80;
const browserTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit"
});

export function useSessionDetailController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  options: UseSessionDetailControllerOptions = {}
): SessionDetailControllerState {
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.snapshot,
    coordinator.snapshot
  );
  const [feed, setFeed] = useState<SessionDetailFeedState>(() =>
    createSessionDetailFeed(sessionId)
  );
  const [pendingAction, setPendingAction] = useState<SessionDetailPendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const feedRef = useRef(feed);
  const pendingRef = useRef<SessionDetailPendingAction>(null);
  const mountedRef = useRef(true);
  const now = options.now ?? Date.now;
  const prompt = usePromptComposerController(
    coordinator,
    sessionId,
    snapshot,
    feed
  );
  const model = useModelControlController(coordinator, sessionId, snapshot);
  const goal = useGoalControlController(coordinator, sessionId, snapshot);
  const plan = usePlanControlController(coordinator, sessionId, snapshot);
  const usage = useUsageControlController(coordinator, sessionId, snapshot);
  const compact = useCompactControlController(coordinator, sessionId, snapshot);
  const skills = useSkillsControlController(coordinator, sessionId, snapshot);
  const approvals = useApprovalDecisionController(
    coordinator,
    sessionId,
    snapshot,
    feed
  );
  const eventDiagnostics = useEventDiagnosticsController(
    coordinator,
    sessionId,
    snapshot,
    feed,
    snapshot.stream.boundary
  );
  const interrupt = useInterruptControlController(
    coordinator,
    sessionId,
    snapshot,
    feed,
    snapshot.stream.boundary
  );
  const archive = useArchiveControlController(
    coordinator,
    sessionId,
    snapshot
  );
  const laptopResume = useLaptopResumeControlController(
    coordinator,
    sessionId,
    snapshot
  );

  const resetFeed = useCallback(() => {
    const empty = createSessionDetailFeed(sessionId);
    feedRef.current = empty;
    setFeed(empty);
    setFeedError(null);
  }, [sessionId]);

  const consumeEvent = useCallback(
    (event: SelectedProjectionEvent) => {
      if (!mountedRef.current) return;
      try {
        const next = appendSessionDetailEvent(feedRef.current, event);
        if (next === feedRef.current) return;
        feedRef.current = next;
        setFeed(next);
      } catch {
        setFeedError("Session activity became inconsistent. Refresh before continuing.");
        throw new TypeError("HostDeck Session Detail rejected an inconsistent event.");
      }
    },
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    resetFeed();
    setActionError(null);
    void coordinator
      .setTarget(Object.freeze({ kind: "session_detail" as const, sessionId }))
      .catch(() => {
        if (active && mountedRef.current) {
          setActionError("Session Detail could not start. Return to Mission Control and try again.");
        }
      });
    return () => {
      active = false;
      mountedRef.current = false;
      coordinator.disconnectSessionStream("unmounted");
    };
  }, [coordinator, resetFeed, sessionId]);

  useEffect(() => {
    if (canRetainSessionFeed(snapshot, sessionId)) return;
    if (feedRef.current.events.length === 0 && feedRef.current.sessionId === sessionId) {
      return;
    }
    resetFeed();
  }, [resetFeed, sessionId, snapshot]);

  useEffect(() => {
    if (!canConnectSessionStream(snapshot, sessionId)) return;
    if (snapshot.stream.state !== "idle") return;
    try {
      coordinator.connectSessionStream(consumeEvent, { start: "recent" });
    } catch {
      if (mountedRef.current) {
        setActionError("Live activity could not start. Refresh the session to retry.");
      }
    }
  }, [consumeEvent, coordinator, sessionId, snapshot]);

  const onRefresh = useCallback(() => {
    if (pendingRef.current !== null) return;
    pendingRef.current = "refresh";
    setPendingAction("refresh");
    setActionError(null);
    resetFeed();
    void coordinator
      .refresh()
      .catch(() => {
        if (mountedRef.current) {
          setActionError("Session refresh failed. The last confirmed session state may be stale.");
        }
      })
      .finally(() => {
        pendingRef.current = null;
        if (mountedRef.current) setPendingAction(null);
      });
  }, [coordinator, resetFeed]);

  return Object.freeze({
    snapshot,
    feed,
    nowMs: Reflect.apply(now, undefined, []) as number,
    pendingAction,
    actionError,
    feedError,
    onRefresh,
    prompt,
    model,
    goal,
    plan,
    usage,
    compact,
    skills,
    approvals,
    eventDiagnostics,
    interrupt,
    archive,
    laptopResume
  });
}

export function ConnectedSessionDetail({
  coordinator,
  sessionId,
  now,
  formatTimestamp
}: ConnectedSessionDetailProps) {
  const controller = useSessionDetailController(coordinator, sessionId, { now });
  return (
    <SessionDetailScreen
      sessionId={sessionId}
      snapshot={controller.snapshot}
      feed={controller.feed}
      nowMs={controller.nowMs}
      formatTimestamp={formatTimestamp}
      pendingAction={controller.pendingAction}
      actionError={controller.actionError}
      feedError={controller.feedError}
      onRefresh={controller.onRefresh}
      prompt={controller.prompt}
      model={controller.model}
      goal={controller.goal}
      plan={controller.plan}
      usage={controller.usage}
      compact={controller.compact}
      skills={controller.skills}
      approvals={controller.approvals}
      eventDiagnostics={controller.eventDiagnostics}
    />
  );
}

export function SessionDetailScreen({
  sessionId,
  snapshot,
  feed,
  nowMs,
  formatTimestamp = defaultTimestampFormatter,
  pendingAction = null,
  actionError = null,
  feedError = null,
  onRefresh,
  prompt,
  model,
  goal,
  plan,
  usage,
  compact,
  skills,
  approvals,
  eventDiagnostics,
  projection
}: SessionDetailScreenProps) {
  const view =
    projection ?? projectSessionDetail(snapshot, sessionId, feed, nowMs, formatTimestamp);
  const showInitialSkeleton =
    (view.loading || view.replayPending) && view.timeline.length === 0;
  const hasControls =
    prompt !== undefined ||
    model !== undefined ||
    goal !== undefined ||
    plan !== undefined ||
    (usage !== undefined && compact !== undefined && skills !== undefined);
  const showControls = view.canDisclose && hasControls;

  return (
    <section
      className={`hostdeck-route hostdeck-detail${showControls ? " hostdeck-detail--with-controls" : ""}`}
      aria-labelledby="session-detail-title"
      aria-busy={view.loading || view.replayPending}
    >
      <div className="hostdeck-detail__scroll-owner">
        <h1 id="session-detail-title" className="hostdeck-visually-hidden">
          {view.canDisclose ? `${view.headerTitle} activity` : "Session Detail"}
        </h1>

        {view.canDisclose ? (
          <SessionContextRail
            cells={view.contextCells}
            pending={pendingAction === "refresh"}
            disabled={pendingAction !== null}
            onRefresh={onRefresh}
          />
        ) : null}

        <HostLockRouteRail projection={view.lock} />

        {actionError === null ? null : (
          <SessionDetailInlineError message={actionError} />
        )}
        {feedError === null ? null : <SessionDetailInlineError message={feedError} />}
        {view.notices.map((notice) => (
          <SessionDetailNoticeView key={`${notice.title}:${notice.body}`} notice={notice} />
        ))}

        {showInitialSkeleton ? (
          <SessionDetailLoadingTimeline />
        ) : !view.canDisclose ? null : approvals === undefined ? (
          view.empty ? (
            <SessionDetailEmpty />
          ) : view.activityUnavailable ? (
            <SessionDetailActivityUnavailable />
          ) : view.noVisibleActivity ? (
            <SessionDetailNoVisibleActivity />
          ) : (
            <SessionDetailTimeline
              key={feed.sessionId}
              items={view.timeline}
              acceptedCount={feed.acceptedCount}
              replayPending={view.replayPending}
              approvals={null}
              approvalView={null}
              eventDiagnostics={eventDiagnostics ?? null}
            />
          )
        ) : (
          <ConnectedSessionDetailTimelineArea
            key={feed.sessionId}
            items={view.timeline}
            acceptedCount={feed.acceptedCount}
            replayPending={view.replayPending}
            empty={view.empty}
            activityUnavailable={view.activityUnavailable}
            noVisibleActivity={view.noVisibleActivity}
            approvals={approvals}
            eventDiagnostics={eventDiagnostics ?? null}
          />
        )}
      </div>

      {showControls ? (
        <div className="hostdeck-session-controls">
          {model === undefined && goal === undefined && plan === undefined && (usage === undefined || compact === undefined || skills === undefined) ? null : (
            <fieldset className="hostdeck-primary-action-dock">
              <legend className="hostdeck-visually-hidden">Session controls</legend>
              {model === undefined ? null : <ModelControl controller={model} />}
              {goal === undefined ? null : <GoalControl controller={goal} />}
              {plan === undefined ? null : <PlanControl controller={plan} />}
              {usage === undefined || compact === undefined || skills === undefined ? null : (
                <SessionUtilities compact={compact} skills={skills} usage={usage} />
              )}
            </fieldset>
          )}
          {prompt === undefined ? null : <PromptComposer controller={prompt} />}
        </div>
      ) : null}
    </section>
  );
}

function ConnectedSessionDetailTimelineArea({
  items,
  acceptedCount,
  replayPending,
  empty,
  activityUnavailable,
  noVisibleActivity,
  approvals,
  eventDiagnostics
}: Readonly<{
  items: readonly SessionDetailTimelineItem[];
  acceptedCount: number;
  replayPending: boolean;
  empty: boolean;
  activityUnavailable: boolean;
  noVisibleActivity: boolean;
  approvals: ApprovalDecisionController;
  eventDiagnostics: EventDiagnosticsController | null;
}>) {
  const approvalView = useApprovalDecisionView(approvals);
  const hasApprovalSurface =
    approvalView.items.length > 0 || shouldShowApprovalGlobalStatus(approvalView);
  if (!hasApprovalSurface) {
    if (empty) return <SessionDetailEmpty />;
    if (activityUnavailable) return <SessionDetailActivityUnavailable />;
    if (noVisibleActivity) return <SessionDetailNoVisibleActivity />;
  }
  return (
    <SessionDetailTimeline
      items={items}
      acceptedCount={acceptedCount + approvalView.items.filter((item) => item.eventOrder === null).length}
      replayPending={replayPending}
      approvals={approvals}
      approvalView={approvalView}
      eventDiagnostics={eventDiagnostics}
    />
  );
}

export function projectSessionDetail(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId,
  feed: SessionDetailFeedState,
  nowMs: number,
  formatTimestamp: SessionDetailTimestampFormatter = defaultTimestampFormatter
): SessionDetailProjection {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError("Session Detail time is invalid.");
  }
  const detail = matchingDetail(snapshot, sessionId);
  const canDisclose =
    detail !== null &&
    canRetainSessionFeed(snapshot, sessionId) &&
    !catalogSessionRemoved(snapshot, sessionId);
  const row = canDisclose ? projectSessionRow(detail, nowMs) : null;
  const stale =
    canDisclose &&
    (snapshot.access.state !== "current" ||
      snapshot.targetState.state !== "current" ||
      detail.session.freshness !== "current");
  const replayPending = canDisclose && isInitialReplayPending(snapshot, detail);
  const timeline =
    canDisclose && feed.sessionId === sessionId
      ? projectSessionDetailTimeline(feed, snapshot.stream.boundary, formatTimestamp)
      : Object.freeze([]);
  const loading =
    !canDisclose &&
    (snapshot.target?.kind !== "session_detail" ||
      snapshot.target.sessionId !== sessionId ||
      snapshot.phase === "idle" ||
      snapshot.phase === "loading" ||
      snapshot.targetState.state === "loading");
  const stream = streamContext(snapshot, replayPending, stale);
  const baselineCursor = detail?.session.last_event_cursor ?? null;
  const activityUnavailable =
    canDisclose &&
    !replayPending &&
    baselineCursor !== null &&
    feed.events.length === 0;

  return Object.freeze({
    canDisclose,
    loading,
    replayPending,
    stale,
    empty:
      canDisclose &&
      !replayPending &&
      baselineCursor === null &&
      timeline.length === 0,
    activityUnavailable,
    noVisibleActivity:
      canDisclose &&
      !replayPending &&
      !activityUnavailable &&
      feed.events.length > 0 &&
      timeline.length === 0,
    headerTitle: row?.item.session.name ?? "Session Detail",
    headerSubtitle:
      row === null
        ? unavailableHeaderSubtitle(snapshot.phase, loading)
        : `${row.stateLabel} / ${row.projectCue}`,
    contextCells:
      row === null
        ? Object.freeze([])
        : Object.freeze([
            Object.freeze({
              label: "Status" as const,
              value: row.stateLabel,
              detail: row.activityLabel,
              tone: missionTone(row.tone),
              icon: Activity
            }),
            Object.freeze({
              label: "Project" as const,
              value: row.projectCue,
              detail: row.branch,
              tone: "focus" as const,
              icon: GitBranch
            }),
            Object.freeze({
              label: "Stream" as const,
              value: stream.value,
              detail: stream.detail,
              tone: stream.tone,
              icon: stream.icon
            })
          ]),
    lock: projectHostLockState(snapshot),
    notices: projectDetailNotices(snapshot, canDisclose, stale),
    timeline
  });
}

function SessionContextRail({
  cells,
  pending,
  disabled,
  onRefresh
}: Readonly<{
  cells: readonly SessionDetailContextCell[];
  pending: boolean;
  disabled: boolean;
  onRefresh: (() => void) | undefined;
}>) {
  return (
    <div className="hostdeck-detail-context">
      <dl className="hostdeck-detail-context__cells" aria-label="Session context">
        {cells.map((cell) => {
          const Icon = cell.icon;
          return (
            <div
              key={cell.label}
              className={`hostdeck-detail-context__cell hostdeck-tone--${cell.tone}`}
            >
              <dt>
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span>{cell.label}</span>
              </dt>
              <dd>
                <span>{cell.value}</span>
                {cell.detail === null ? null : <small>{cell.detail}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
      {onRefresh === undefined ? null : (
        <button
          type="button"
          className="hostdeck-icon-button hostdeck-detail-context__refresh"
          aria-label="Refresh session"
          title="Refresh session"
          disabled={disabled}
          onClick={onRefresh}
        >
          <RefreshCw
            size={20}
            strokeWidth={2}
            className={pending ? "hostdeck-spin" : undefined}
          />
        </button>
      )}
    </div>
  );
}

function SessionDetailNoticeView({ notice }: Readonly<{ notice: SessionDetailNotice }>) {
  return (
    <div
      className={`hostdeck-detail-notice hostdeck-detail-notice--${notice.tone}`}
      role={notice.urgent ? "alert" : "status"}
    >
      <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" />
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.body}</p>
      </div>
    </div>
  );
}

function SessionDetailInlineError({ message }: Readonly<{ message: string }>) {
  return (
    <div className="hostdeck-inline-alert hostdeck-inline-alert--danger" role="alert">
      <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function SessionDetailLoadingTimeline() {
  return (
    <div className="hostdeck-timeline-loading hostdeck-detail__loading" aria-hidden="true">
      <span className="hostdeck-timeline-loading__rail" />
      <span className="hostdeck-timeline-loading__item" />
      <span className="hostdeck-timeline-loading__item" />
      <span className="hostdeck-timeline-loading__item" />
    </div>
  );
}

function SessionDetailEmpty() {
  return (
    <div className="hostdeck-detail-empty">
      <History size={24} strokeWidth={2} aria-hidden="true" />
      <div>
        <h2>No activity recorded</h2>
        <p>This session has no retained activity.</p>
      </div>
    </div>
  );
}

function SessionDetailActivityUnavailable() {
  return (
    <div className="hostdeck-detail-empty">
      <RotateCcw size={24} strokeWidth={2} aria-hidden="true" />
      <div>
        <h2>Recent activity unavailable</h2>
        <p>The retained feed was not loaded. Refresh the session to try again.</p>
      </div>
    </div>
  );
}

function SessionDetailNoVisibleActivity() {
  return (
    <div className="hostdeck-detail-empty">
      <History size={24} strokeWidth={2} aria-hidden="true" />
      <div>
        <h2>No visible activity</h2>
        <p>The retained events contain no displayable content.</p>
      </div>
    </div>
  );
}

function SessionDetailTimeline({
  items,
  acceptedCount,
  replayPending,
  approvals,
  approvalView,
  eventDiagnostics
}: Readonly<{
  items: readonly SessionDetailTimelineItem[];
  acceptedCount: number;
  replayPending: boolean;
  approvals: ApprovalDecisionController | null;
  approvalView: ApprovalDecisionView | null;
  eventDiagnostics: EventDiagnosticsController | null;
}>) {
  const endRef = useRef<HTMLDivElement>(null);
  const approvalConfirmationOriginRef = useRef<HTMLButtonElement>(null);
  const eventDiagnosticsOriginRef = useRef<HTMLButtonElement>(null);
  const pinnedRef = useRef(true);
  const initializedRef = useRef(false);
  const previousAcceptedRef = useRef(acceptedCount);
  const approvalAnnouncementStateRef = useRef(initialApprovalAnnouncementState);
  const [newActivityCount, setNewActivityCount] = useState(0);
  const [approvalAnnouncement, setApprovalAnnouncement] = useState<
    Readonly<{ sequence: number; message: string }>
  >(
    Object.freeze({ sequence: 0, message: "" })
  );

  useEffect(() => {
    const updatePinned = () => {
      const pinned = isTimelinePinned(endRef);
      pinnedRef.current = pinned;
      if (pinned) setNewActivityCount(0);
    };
    updatePinned();
    window.addEventListener("scroll", updatePinned, { passive: true });
    window.addEventListener("resize", updatePinned);
    return () => {
      window.removeEventListener("scroll", updatePinned);
      window.removeEventListener("resize", updatePinned);
    };
  }, []);

  useLayoutEffect(() => {
    if (replayPending || initializedRef.current) return;
    scrollTimelineEnd(endRef, "auto");
    initializedRef.current = true;
    pinnedRef.current = true;
    setNewActivityCount(0);
  }, [replayPending]);

  useLayoutEffect(() => {
    const previous = previousAcceptedRef.current;
    previousAcceptedRef.current = acceptedCount;
    if (acceptedCount <= previous || !initializedRef.current) {
      if (acceptedCount < previous) setNewActivityCount(0);
      return;
    }
    const added = acceptedCount - previous;
    if (pinnedRef.current) {
      scrollTimelineEnd(endRef, "auto");
      return;
    }
    setNewActivityCount((current) =>
      Math.min(sessionDetailFeedLimit, current + added)
    );
  }, [acceptedCount]);

  useEffect(() => {
    const result = advanceApprovalAnnouncement(
      approvalAnnouncementStateRef.current,
      approvalView?.items ?? [],
      !replayPending && approvalView !== null && approvalView.phase !== "loading",
      approvalView?.targetLabel ?? null
    );
    approvalAnnouncementStateRef.current = result.state;
    if (result.message !== null) {
      setApprovalAnnouncement((current) =>
        Object.freeze({ sequence: current.sequence + 1, message: result.message ?? "" })
      );
    }
  }, [approvalView, replayPending]);

  const returnToLive = () => {
    scrollTimelineEnd(endRef, prefersReducedMotion() ? "auto" : "smooth");
    pinnedRef.current = true;
    setNewActivityCount(0);
  };

  const approvalController = approvals;
  return (
    <div className="hostdeck-detail-timeline-wrap">
      <ol className="hostdeck-detail-timeline" aria-label="Session activity">
        {items.map((item) => {
          if (approvalController !== null && item.approvalRequestId !== undefined) {
            const approval = approvalController.lookupEvent(item.approvalRequestId);
            if (approval !== null) {
              return (
                <ApprovalTimelineItem
                  key={item.key}
                  item={approval}
                  timeline={item}
                  controller={approvalController}
                  confirmationOrigin={approvalConfirmationOriginRef}
                  eventDiagnostics={eventDiagnostics ?? undefined}
                  eventDiagnosticsOrigin={eventDiagnosticsOriginRef}
                />
              );
            }
          }
          return (
            <SessionTimelineItem
              key={item.key}
              item={item}
              eventDiagnostics={eventDiagnostics}
              eventDiagnosticsOrigin={eventDiagnosticsOriginRef}
            />
          );
        })}
        {approvalController === null || approvalView === null ? null : approvalView.items
          .filter((item) => item.eventOrder === null)
          .map((item) => (
            <ApprovalTimelineItem
              key={item.handle}
              item={item}
              timeline={null}
              controller={approvalController}
              confirmationOrigin={approvalConfirmationOriginRef}
            />
          ))}
        {approvalController === null || approvalView === null ? null : (
          <ApprovalStatusTimelineItem view={approvalView} controller={approvalController} />
        )}
      </ol>
      <div ref={endRef} className="hostdeck-detail-timeline__end" aria-hidden="true" />
      <span
        id="hostdeck-approval-updates"
        className="hostdeck-visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span key={approvalAnnouncement.sequence}>{approvalAnnouncement.message}</span>
      </span>
      <span
        id="hostdeck-activity-updates"
        className="hostdeck-visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {newActivityCount === 0 ? "" : newActivityAnnouncement(newActivityCount)}
      </span>
      {newActivityCount === 0 ? null : (
        <button
          type="button"
          className="hostdeck-action-button hostdeck-detail-new-activity"
          onClick={returnToLive}
        >
          <Radio size={18} strokeWidth={2} aria-hidden="true" />
          <span>
            {newActivityCount} new {newActivityCount === 1 ? "event" : "events"}
          </span>
        </button>
      )}
      {approvalController === null || approvalView === null ? null : (
        <ApprovalConfirmationDialog
          view={approvalView}
          controller={approvalController}
          confirmationOrigin={approvalConfirmationOriginRef}
        />
      )}
      {eventDiagnostics === null ? null : (
        <EventDiagnosticsSheet
          controller={eventDiagnostics}
          originRef={eventDiagnosticsOriginRef}
        />
      )}
    </div>
  );
}

function SessionTimelineItem({
  item,
  eventDiagnostics,
  eventDiagnosticsOrigin
}: Readonly<{
  item: SessionDetailTimelineItem;
  eventDiagnostics: EventDiagnosticsController | null;
  eventDiagnosticsOrigin: RefObject<HTMLButtonElement | null>;
}>) {
  const Icon = timelineIcon(item.icon);
  return (
    <li className={`hostdeck-timeline-item hostdeck-timeline-item--${item.tone}`}>
      <span className="hostdeck-timeline-item__node" aria-hidden="true">
        <Icon
          size={18}
          strokeWidth={2}
          className={item.pending ? "hostdeck-spin" : undefined}
        />
      </span>
      <article>
        <div className="hostdeck-timeline-item__header">
          <span className="hostdeck-timeline-item__label">{item.label}</span>
          {item.stateLabel === null ? null : (
            <span className="hostdeck-timeline-item__state">{item.stateLabel}</span>
          )}
          {item.capturedAt === null || item.timeLabel === null ? null : (
            <time dateTime={item.capturedAt}>{item.timeLabel}</time>
          )}
          {eventDiagnostics === null || item.diagnosticCursor === null ? null : (
            <EventDiagnosticsAction
              controller={eventDiagnostics}
              cursor={item.diagnosticCursor}
              originRef={eventDiagnosticsOrigin}
            />
          )}
        </div>
        <h2>{item.title}</h2>
        {item.body === null ? null : <p>{item.body}</p>}
        {item.facts.length === 0 ? null : (
          <dl className="hostdeck-timeline-item__facts">
            {item.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {item.contentNotice === null ? null : (
          <p className="hostdeck-timeline-item__content-notice">
            <ShieldAlert size={15} strokeWidth={2} aria-hidden="true" />
            <span>{item.contentNotice}</span>
          </p>
        )}
      </article>
    </li>
  );
}

function canConnectSessionStream(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): boolean {
  return (
    snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    snapshot.targetState.state === "current" &&
    matchingDetail(snapshot, sessionId) !== null &&
    snapshot.access.state === "current" &&
    snapshot.access.data?.can_read_sessions === true
  );
}

function canRetainSessionFeed(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): boolean {
  return (
    snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed" &&
    matchingDetail(snapshot, sessionId) !== null
  );
}

function matchingDetail(snapshot: BrowserConnectionSnapshot, sessionId: SessionId) {
  const data = snapshot.targetState.data;
  if (
    snapshot.target?.kind !== "session_detail" ||
    snapshot.target.sessionId !== sessionId ||
    data?.kind !== "session_detail" ||
    data.response.session.session.id !== sessionId
  ) {
    return null;
  }
  return data.response.session;
}

function isInitialReplayPending(
  snapshot: BrowserConnectionSnapshot,
  detail: NonNullable<ReturnType<typeof matchingDetail>>
): boolean {
  if (snapshot.targetState.state !== "current") return false;
  if (snapshot.stream.state === "failed" || snapshot.stream.state === "closed") return false;
  const baseline = detail.session.last_event_cursor;
  if (baseline === null) {
    return snapshot.stream.state === "idle" || snapshot.stream.state === "connecting";
  }
  const observed = snapshot.stream.snapshot?.cursor;
  return observed === null || observed === undefined || observed < baseline;
}

function streamContext(
  snapshot: BrowserConnectionSnapshot,
  replayPending: boolean,
  stale: boolean
): Readonly<{
  value: string;
  detail: string | null;
  tone: SessionDetailTone;
  icon: LucideIcon;
}> {
  if (stale) {
    return { value: "Stale", detail: "Refresh required", tone: "attention", icon: Clock3 };
  }
  if (replayPending) {
    return { value: "Loading history", detail: "Connecting", tone: "attention", icon: LoaderCircle };
  }
  switch (snapshot.stream.state) {
    case "connected":
      return snapshot.stream.continuity === "boundary"
        ? { value: "Current", detail: "History limited", tone: "attention", icon: Radio }
        : { value: "Current", detail: "Connected", tone: "connected", icon: Radio };
    case "reconnecting":
      return { value: "Reconnecting", detail: "Feed retained", tone: "attention", icon: RotateCcw };
    case "failed":
      return { value: "Stopped", detail: "Refresh to retry", tone: "danger", icon: XCircle };
    case "closed":
      return { value: "Closed", detail: null, tone: "danger", icon: XCircle };
    case "idle":
    case "connecting":
      return { value: "Connecting", detail: null, tone: "attention", icon: LoaderCircle };
    case "not_applicable":
      return { value: "Unavailable", detail: null, tone: "muted", icon: CircleHelp };
  }
}

function projectDetailNotices(
  snapshot: BrowserConnectionSnapshot,
  canDisclose: boolean,
  stale: boolean
): readonly SessionDetailNotice[] {
  const notices: SessionDetailNotice[] = [];
  if (!canDisclose) {
    const unavailable = unavailableNotice(snapshot);
    return unavailable === null ? Object.freeze([]) : Object.freeze([unavailable]);
  }
  const compatibility = projectRuntimeCompatibility(snapshot);
  if (
    compatibility.routeVisible &&
    compatibility.state !== null &&
    compatibility.state !== "supported"
  ) {
    notices.push(compatibilityDetailNotice(compatibility));
  }
  if (stale) {
    const observation = formatCrossScreenObservationFacts(
      projectCrossScreenStaleObservations(snapshot, "session_detail")
    );
    notices.push({
      title: "Showing stale session state",
      body: `The last confirmed detail is retained while current state is unavailable. ${observation ?? "Last-confirmed time unavailable."}`,
      tone: "attention",
      urgent: false
    });
  }
  const remote = projectRemoteConnectionRecovery(snapshot);
  if (
    (remote.source === "current_laptop_observation" &&
      remote.phase !== "ready" &&
      remote.phase !== "not_observed") ||
    remote.phase === "browser_unreachable"
  ) {
    notices.push({
      title: remote.title,
      body: remote.detail,
      tone: remote.tone === "danger" ? "danger" : "attention",
      urgent: remote.urgent
    });
  }
  if (snapshot.stream.state === "reconnecting") {
    notices.push({
      title: "Activity stream reconnecting",
      body: "Visible activity is retained. New events may be delayed.",
      tone: "attention",
      urgent: false
    });
  } else if (snapshot.stream.state === "failed") {
    notices.push({
      title: "Live activity stopped",
      body: "The retained feed may be incomplete. Refresh the session to retry.",
      tone: "danger",
      urgent: true
    });
  }
  const recovered = projectCrossScreenRecoveredFailure(snapshot);
  if (recovered !== null) {
    notices.push({
      title: recovered.title,
      body: recovered.detail,
      tone: "attention",
      urgent: false
    });
  }
  return Object.freeze(notices.map((notice) => Object.freeze(notice)));
}

function unavailableNotice(snapshot: BrowserConnectionSnapshot): SessionDetailNotice | null {
  if (snapshot.phase === "loading" || snapshot.phase === "idle") return null;
  if (
    snapshot.target?.kind === "session_detail" &&
    catalogSessionRemoved(snapshot, snapshot.target.sessionId)
  ) {
    return notice(
      "Session no longer active",
      "This session left the live laptop catalog. Return to Mission Control to choose another session.",
      "muted",
      false
    );
  }
  if (snapshot.phase === "access_limited") {
    switch (snapshot.access.data?.authentication_state) {
      case "unpaired":
        return notice("Pair this phone", "Session details remain hidden until pairing completes.", "attention", false);
      case "invalid_device":
        return notice("Device access is invalid", "Pair this phone again before opening sessions.", "danger", true);
      case "expired_device":
        return notice("Pairing expired", "Pair this phone again before opening sessions.", "attention", false);
      case "revoked_device":
        return notice("Device access was revoked", "Pair this phone again before opening sessions.", "danger", true);
      case "paired_device":
      case "local_admin":
      case undefined:
        return notice("Session access unavailable", "Current access does not allow this session to be read.", "danger", true);
    }
  }
  switch (snapshot.phase) {
    case "not_found":
      return notice("Session unavailable", "This session was not found or is no longer active.", "muted", false);
    case "remote_unavailable":
      return notice("Remote access is unavailable", "Reconnect to the private HostDeck address and try again.", "attention", false);
    case "unreachable":
      return notice("HostDeck is unreachable", "The private HostDeck address could not be reached.", "danger", true);
    case "offline":
      return notice("Codex runtime is offline", "Session activity is unavailable until the laptop runtime recovers.", "attention", false);
    case "incompatible":
      return notice("Codex compatibility unavailable", "Check the laptop runtime before using this session.", "danger", true);
    case "fatal":
    case "degraded":
      return notice("Session Detail is unavailable", "Reload after the HostDeck service recovers.", "danger", true);
    case "ready":
    case "closed":
      return notice("Session Detail is unavailable", "Return to Mission Control and try again.", "danger", true);
  }
}

function catalogSessionRemoved(
  snapshot: BrowserConnectionSnapshot,
  sessionId: string
): boolean {
  return (
    snapshot.catalog?.state === "current" &&
    snapshot.catalog.data !== null &&
    !snapshot.catalog.data.sessions.some(
      (item) => item.session.id === sessionId
    )
  );
}

function compatibilityDetailNotice(
  view: ReturnType<typeof projectRuntimeCompatibility>
): SessionDetailNotice {
  return notice(
    view.title,
    view.detail,
    view.tone === "connected" ? "muted" : view.tone,
    view.urgent
  );
}

function notice(
  title: string,
  body: string,
  tone: SessionDetailNotice["tone"],
  urgent: boolean
): SessionDetailNotice {
  return Object.freeze({ title, body, tone, urgent });
}

function unavailableHeaderSubtitle(phase: BrowserConnectionPhase, loading: boolean): string {
  if (loading) return "Loading session";
  if (phase === "not_found") return "Session unavailable";
  if (phase === "access_limited") return "Access required";
  return "Detail unavailable";
}

function missionTone(tone: MissionTone): SessionDetailTone {
  return tone;
}

function timelineIcon(icon: SessionDetailTimelineIcon): LucideIcon {
  switch (icon) {
    case "user":
      return UserRound;
    case "agent":
      return Bot;
    case "activity":
      return Wrench;
    case "progress":
      return LoaderCircle;
    case "approval":
      return ShieldAlert;
    case "control":
      return Settings2;
    case "runtime":
      return Radio;
    case "boundary":
      return XCircle;
    case "unknown":
      return FileText;
  }
}

function defaultTimestampFormatter(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return "Time unavailable";
  return browserTimestampFormatter.format(new Date(milliseconds));
}

function isTimelinePinned(endRef: RefObject<HTMLDivElement | null>): boolean {
  const end = endRef.current;
  if (end === null) return true;
  const rect = end.getBoundingClientRect();
  if (rect.top !== 0 || rect.bottom !== 0) {
    return rect.top <= window.innerHeight + detailScrollThreshold;
  }
  const root = document.documentElement;
  return root.scrollHeight - (window.scrollY + window.innerHeight) <= detailScrollThreshold;
}

function scrollTimelineEnd(
  endRef: RefObject<HTMLDivElement | null>,
  behavior: ScrollBehavior
): void {
  const end = endRef.current;
  if (end === null || typeof end.scrollIntoView !== "function") return;
  end.scrollIntoView({ block: "end", behavior });
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return true;
  }
}
