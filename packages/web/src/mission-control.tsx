import type { SelectedHostStatusResponse, SelectedSessionReadItem } from "@hostdeck/contracts";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  CircleCheck,
  Clock3,
  Eye,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  type LucideIcon,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { SessionRouteLink } from "./app-routing.js";
import type {
  BrowserConnectionPhase,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";

export type MissionQueueId = "act_now" | "in_progress" | "quiet";
export type MissionTone = "connected" | "attention" | "danger" | "muted";
export type MissionPendingAction = "refresh" | "load_more" | null;

export interface MissionSessionRow {
  readonly item: SelectedSessionReadItem;
  readonly group: MissionQueueId;
  readonly stateLabel: string;
  readonly tone: MissionTone;
  readonly projectCue: string;
  readonly branch: string | null;
  readonly activityLabel: string;
  readonly summary: string;
}

export interface MissionQueueSection {
  readonly id: MissionQueueId;
  readonly label: "ACT NOW" | "IN PROGRESS" | "QUIET";
  readonly tone: MissionTone;
  readonly rows: readonly MissionSessionRow[];
}

interface MissionStatusCell {
  readonly label: "Connection" | "Permission" | "State";
  readonly value: string;
  readonly tone: MissionTone;
  readonly icon: LucideIcon;
}

interface MissionNotice {
  readonly title: string;
  readonly body: string;
  readonly tone: Exclude<MissionTone, "connected">;
  readonly urgent: boolean;
}

export interface MissionControlProjection {
  readonly loading: boolean;
  readonly empty: boolean;
  readonly stale: boolean;
  readonly metaLabel: string;
  readonly statusCells: readonly MissionStatusCell[];
  readonly notice: MissionNotice | null;
  readonly sections: readonly MissionQueueSection[];
  readonly hasMore: boolean;
}

export interface ConnectedMissionControlProps {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly now?: () => number;
}

export interface MissionControlScreenProps {
  readonly snapshot: BrowserConnectionSnapshot;
  readonly nowMs: number;
  readonly pendingAction?: MissionPendingAction;
  readonly actionError?: string | null;
  readonly onRefresh?: () => void;
  readonly onLoadMore?: () => void;
}

const missionTarget = Object.freeze({ kind: "mission_control" as const });
const sectionOrder: readonly MissionQueueId[] = Object.freeze([
  "act_now",
  "in_progress",
  "quiet"
]);

export function ConnectedMissionControl({
  coordinator,
  now = Date.now
}: ConnectedMissionControlProps) {
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.snapshot,
    coordinator.snapshot
  );
  const [pendingAction, setPendingAction] = useState<MissionPendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingRef = useRef<MissionPendingAction>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void coordinator.setTarget(missionTarget).catch(() => {
      if (active) setActionError("Mission Control could not start. Try again.");
    });
    return () => {
      active = false;
      mountedRef.current = false;
    };
  }, [coordinator]);

  const runCommand = useCallback(
    async (
      action: Exclude<MissionPendingAction, null>,
      operation: () => Promise<BrowserConnectionSnapshot>,
      failureMessage: string
    ): Promise<void> => {
      if (pendingRef.current !== null) return;
      pendingRef.current = action;
      setPendingAction(action);
      setActionError(null);
      try {
        await operation();
      } catch {
        if (mountedRef.current) setActionError(failureMessage);
      } finally {
        pendingRef.current = null;
        if (mountedRef.current) setPendingAction(null);
      }
    },
    []
  );

  return (
    <MissionControlScreen
      snapshot={snapshot}
      nowMs={Reflect.apply(now, undefined, []) as number}
      pendingAction={pendingAction}
      actionError={actionError}
      onRefresh={() => {
        void runCommand(
          "refresh",
          coordinator.refresh,
          "Session refresh failed. The previous state is unchanged."
        );
      }}
      onLoadMore={() => {
        void runCommand(
          "load_more",
          coordinator.loadMoreSessions,
          "More sessions could not be loaded. The current list is unchanged."
        );
      }}
    />
  );
}

export function MissionControlScreen({
  snapshot,
  nowMs,
  pendingAction = null,
  actionError = null,
  onRefresh,
  onLoadMore
}: MissionControlScreenProps) {
  const view = projectMissionControl(snapshot, nowMs);
  const anyActionPending = pendingAction !== null;
  const hasPriorityRows = view.sections.some(
    (section) => section.id !== "quiet" && section.rows.length > 0
  );

  return (
    <section
      className="hostdeck-route hostdeck-mission"
      aria-labelledby="mission-control-title"
      aria-busy={view.loading}
    >
      <HostAccessRail cells={view.statusCells} />
      <div className="hostdeck-route__heading hostdeck-mission__heading">
        <div>
          <h1 id="mission-control-title">Mission Control</h1>
          <span className="hostdeck-route__meta">{view.metaLabel}</span>
        </div>
        {view.loading || onRefresh === undefined ? null : (
          <button
            type="button"
            className="hostdeck-icon-button hostdeck-mission__refresh"
            aria-label="Refresh sessions"
            title="Refresh sessions"
            disabled={anyActionPending}
            onClick={onRefresh}
          >
            <RefreshCw
              size={20}
              strokeWidth={2}
              className={pendingAction === "refresh" ? "hostdeck-spin" : undefined}
            />
          </button>
        )}
      </div>

      {actionError === null ? null : (
        <div className="hostdeck-inline-alert hostdeck-inline-alert--danger" role="alert">
          <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}

      {view.notice === null ? null : <MissionNoticeView notice={view.notice} />}

      {view.loading ? (
        <MissionQueueLoading />
      ) : view.empty ? (
        <MissionEmpty />
      ) : (
        <div className="hostdeck-mission__queue">
          {view.sections.map((section) =>
            section.id === "quiet" ? (
              <QuietQueueSection
                key={`${section.id}:${hasPriorityRows ? "mixed" : "only"}`}
                section={section}
                defaultOpen={!hasPriorityRows}
              />
            ) : (
              <MissionQueueSectionView key={section.id} section={section} />
            )
          )}
          {view.hasMore && onLoadMore !== undefined ? (
            <button
              type="button"
              className="hostdeck-action-button hostdeck-mission__load-more"
              disabled={anyActionPending}
              onClick={onLoadMore}
            >
              {pendingAction === "load_more" ? (
                <LoaderCircle className="hostdeck-spin" size={18} aria-hidden="true" />
              ) : (
                <ChevronDown size={18} aria-hidden="true" />
              )}
              <span>{pendingAction === "load_more" ? "Loading" : "Load more"}</span>
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function projectMissionControl(
  snapshot: BrowserConnectionSnapshot,
  nowMs: number
): MissionControlProjection {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError("Mission Control time is invalid.");
  }

  const targetMatches = snapshot.target?.kind === "mission_control";
  const missionData =
    targetMatches && snapshot.targetState.data?.kind === "mission_control"
      ? snapshot.targetState.data
      : null;
  const readable =
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  const canDisclose = readable && missionData !== null;
  const loading =
    !canDisclose &&
    (!targetMatches ||
      snapshot.phase === "idle" ||
      snapshot.phase === "loading" ||
      snapshot.targetState.state === "loading");
  const rows = canDisclose
    ? missionData.sessions.map((item) => projectSessionRow(item, nowMs))
    : [];
  const sections = sectionOrder.flatMap((id) => {
    const sectionRows = rows.filter((row) => row.group === id);
    return sectionRows.length === 0
      ? []
      : [
          Object.freeze({
            id,
            label: sectionLabel(id),
            tone: sectionTone(id),
            rows: Object.freeze(sectionRows)
          })
        ];
  });
  const stale =
    canDisclose &&
    (snapshot.access.state !== "current" ||
      snapshot.targetState.state !== "current");

  return Object.freeze({
    loading,
    empty: canDisclose && missionData.sessions.length === 0,
    stale,
    metaLabel: loading
      ? "Loading sessions"
      : canDisclose
        ? formatSessionCount(missionData.sessions.length, missionData.hasMore)
        : unavailableMeta(snapshot.phase),
    statusCells: Object.freeze(projectStatusCells(snapshot)),
    notice: projectNotice(snapshot, canDisclose, stale, loading),
    sections: Object.freeze(sections),
    hasMore: canDisclose && missionData.hasMore
  });
}

export function projectSessionRow(
  item: SelectedSessionReadItem,
  nowMs: number
): MissionSessionRow {
  const session = item.session;
  const state = rowState(session);
  return Object.freeze({
    item,
    group: rowGroup(session),
    stateLabel: state.label,
    tone: state.tone,
    projectCue: projectCue(session.cwd),
    branch: session.branch,
    activityLabel: relativeActivity(session.last_activity_at ?? session.updated_at, nowMs),
    summary:
      session.recent_summary.trim() ||
      session.goal?.objective.trim() ||
      fallbackSummary(state.label)
  });
}

function HostAccessRail({ cells }: Readonly<{ cells: readonly MissionStatusCell[] }>) {
  return (
    <dl className="hostdeck-status-rail" aria-label="Host and access status">
      {cells.map((cell) => {
        const Icon = cell.icon;
        return (
          <div
            key={cell.label}
            className={`hostdeck-status-rail__cell hostdeck-tone--${cell.tone}`}
          >
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
            <span>
              <dt>{cell.label}</dt>
              <dd>{cell.value}</dd>
            </span>
          </div>
        );
      })}
    </dl>
  );
}

function MissionNoticeView({ notice }: Readonly<{ notice: MissionNotice }>) {
  return (
    <div
      className={`hostdeck-mission-notice hostdeck-mission-notice--${notice.tone}`}
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

function MissionQueueSectionView({
  section
}: Readonly<{ section: MissionQueueSection }>) {
  const headingId = `mission-group-${section.id}`;
  return (
    <section
      className={`hostdeck-queue-group hostdeck-queue-group--${section.tone}`}
      aria-labelledby={headingId}
    >
      <div className="hostdeck-queue-group__heading">
        <h2 id={headingId}>{section.label}</h2>
        <span>{section.rows.length}</span>
      </div>
      <MissionRowList rows={section.rows} />
    </section>
  );
}

function QuietQueueSection({
  section,
  defaultOpen
}: Readonly<{ section: MissionQueueSection; defaultOpen: boolean }>) {
  const headingId = "mission-group-quiet";
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className="hostdeck-queue-group hostdeck-queue-group--muted"
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="hostdeck-visually-hidden">
        {section.label}
      </h2>
      <details
        className="hostdeck-queue-disclosure"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="hostdeck-queue-group__heading">
          <span>{section.label}</span>
          <span className="hostdeck-queue-disclosure__count">{section.rows.length}</span>
          <ChevronDown
            className="hostdeck-queue-disclosure__icon"
            size={18}
            strokeWidth={2}
            aria-hidden="true"
          />
        </summary>
        <MissionRowList rows={section.rows} />
      </details>
    </section>
  );
}

function MissionRowList({ rows }: Readonly<{ rows: readonly MissionSessionRow[] }>) {
  return (
    <ul className="hostdeck-session-list">
      {rows.map((row) => (
        <li key={row.item.session.id} className={`hostdeck-session-row hostdeck-session-row--${row.tone}`}>
          <SessionRouteLink className="hostdeck-session-row__link" sessionId={row.item.session.id}>
            <span className="hostdeck-session-row__topline">
              <strong>{row.item.session.name}</strong>
              <span className={`hostdeck-session-state hostdeck-session-state--${row.tone}`}>
                <span className="hostdeck-session-state__mark" aria-hidden="true" />
                {row.stateLabel}
              </span>
            </span>
            <span className="hostdeck-session-row__meta">
              <span className="hostdeck-session-row__cue">{row.projectCue}</span>
              {row.branch === null ? null : (
                <span className="hostdeck-session-row__branch">{row.branch}</span>
              )}
              <span className="hostdeck-session-row__age">{row.activityLabel}</span>
            </span>
            <span className="hostdeck-session-row__summary">{row.summary}</span>
          </SessionRouteLink>
        </li>
      ))}
    </ul>
  );
}

function MissionQueueLoading() {
  return (
    <div className="hostdeck-queue-loading hostdeck-mission__loading" aria-hidden="true">
      <span className="hostdeck-loading-line hostdeck-loading-line--short" />
      <span className="hostdeck-loading-item" />
      <span className="hostdeck-loading-item" />
      <span className="hostdeck-loading-line hostdeck-loading-line--short" />
      <span className="hostdeck-loading-item hostdeck-loading-item--compact" />
    </div>
  );
}

function MissionEmpty() {
  return (
    <div className="hostdeck-mission-empty">
      <CircleCheck size={24} strokeWidth={2} aria-hidden="true" />
      <div>
        <h2>No active sessions</h2>
        <p>New managed Codex sessions will appear here.</p>
      </div>
    </div>
  );
}

function projectStatusCells(snapshot: BrowserConnectionSnapshot): MissionStatusCell[] {
  const access = snapshot.access.data;
  const connection = connectionStatus(snapshot.phase, snapshot.access.state, access?.network_mode);
  const permission = permissionStatus(snapshot);
  const data = dataStatus(snapshot);
  return [
    { label: "Connection", ...connection },
    { label: "Permission", ...permission },
    { label: "State", ...data }
  ];
}

function connectionStatus(
  phase: BrowserConnectionPhase,
  accessState: BrowserConnectionSnapshot["access"]["state"],
  networkMode: "loopback" | "remote" | undefined
): Pick<MissionStatusCell, "value" | "tone" | "icon"> {
  if (phase === "loading" || phase === "idle") {
    return { value: "Connecting", tone: "muted", icon: Wifi };
  }
  if (phase === "unreachable") {
    return { value: "Unreachable", tone: "danger", icon: WifiOff };
  }
  if (phase === "remote_unavailable") {
    return { value: "Remote unavailable", tone: "danger", icon: WifiOff };
  }
  if (phase === "fatal" || phase === "closed") {
    return { value: "Unavailable", tone: "danger", icon: WifiOff };
  }
  if (accessState !== "current") {
    return { value: "Reconnecting", tone: "attention", icon: WifiOff };
  }
  return networkMode === "remote"
    ? { value: "Remote ready", tone: "connected", icon: Wifi }
    : { value: "Laptop", tone: "connected", icon: Laptop };
}

function permissionStatus(
  snapshot: BrowserConnectionSnapshot
): Pick<MissionStatusCell, "value" | "tone" | "icon"> {
  const access = snapshot.access.data;
  if (access === null) {
    return snapshot.phase === "loading" || snapshot.phase === "idle"
      ? { value: "Checking access", tone: "muted", icon: ShieldAlert }
      : { value: "Access unknown", tone: "danger", icon: ShieldAlert };
  }
  if (snapshot.access.state !== "current") {
    return { value: "Access stale", tone: "attention", icon: ShieldAlert };
  }
  if (access.locked) return { value: "Locked", tone: "danger", icon: LockKeyhole };
  switch (access.authentication_state) {
    case "paired_device":
      return access.permission === "write"
        ? { value: "Write", tone: "connected", icon: ShieldCheck }
        : { value: "Read only", tone: "attention", icon: Eye };
    case "unpaired":
      return access.can_read_sessions
        ? { value: "Local read", tone: "attention", icon: Eye }
        : { value: "Pair required", tone: "danger", icon: ShieldAlert };
    case "expired_device":
      return { value: "Expired", tone: "danger", icon: ShieldAlert };
    case "revoked_device":
      return { value: "Revoked", tone: "danger", icon: ShieldAlert };
    case "invalid_device":
    case "local_admin":
      return { value: "Access invalid", tone: "danger", icon: ShieldAlert };
  }
}

function dataStatus(
  snapshot: BrowserConnectionSnapshot
): Pick<MissionStatusCell, "value" | "tone" | "icon"> {
  if (
    snapshot.targetState.data !== null &&
    snapshot.targetState.state !== "current"
  ) {
    return { value: "Stale", tone: "attention", icon: Clock3 };
  }
  if (snapshot.phase === "offline") {
    return { value: "Runtime offline", tone: "danger", icon: WifiOff };
  }
  if (snapshot.phase === "incompatible") {
    return { value: "Incompatible", tone: "danger", icon: AlertTriangle };
  }
  if (snapshot.phase === "fatal" || snapshot.phase === "closed") {
    return { value: "Unavailable", tone: "danger", icon: AlertTriangle };
  }
  if (snapshot.phase === "degraded") {
    return { value: "Degraded", tone: "attention", icon: AlertTriangle };
  }
  if (snapshot.targetState.state === "current") {
    return { value: "Current", tone: "connected", icon: Activity };
  }
  if (snapshot.targetState.state === "loading" || snapshot.phase === "loading") {
    return { value: "Loading", tone: "muted", icon: Clock3 };
  }
  return { value: "Unavailable", tone: "danger", icon: AlertTriangle };
}

function projectNotice(
  snapshot: BrowserConnectionSnapshot,
  canDisclose: boolean,
  stale: boolean,
  loading: boolean
): MissionNotice | null {
  if (loading) return null;
  const access = snapshot.access.data;
  if (access !== null && !access.can_read_sessions) return accessNotice(access.authentication_state);
  if (snapshot.phase === "unreachable") {
    return notice(
      "HostDeck is unreachable",
      "Check that this phone and laptop can reach the private HostDeck network, then refresh.",
      "danger",
      true
    );
  }
  if (snapshot.phase === "remote_unavailable") {
    return notice(
      "Remote access is unavailable",
      "Action is required on the laptop before this phone can reconnect.",
      "danger",
      false
    );
  }
  if (snapshot.phase === "fatal" || snapshot.phase === "closed") {
    return notice(
      "Mission Control is unavailable",
      "HostDeck could not read a valid session projection. Refresh after the host is healthy.",
      "danger",
      true
    );
  }
  if (snapshot.phase === "incompatible") {
    return notice(
      "Codex is incompatible",
      "Update the laptop's Codex runtime before using HostDeck controls.",
      "danger",
      false
    );
  }
  if (snapshot.phase === "offline") {
    return notice(
      "Codex runtime is offline",
      canDisclose
        ? "Showing the latest available session state while the laptop runtime reconnects."
        : "The laptop runtime must reconnect before sessions are available.",
      "danger",
      false
    );
  }
  if (stale) {
    return notice(
      "Showing stale session state",
      "The last readable session list is preserved while HostDeck reconnects. Refresh does not retry automatically.",
      "attention",
      false
    );
  }

  if (canDisclose && snapshot.host.data !== null && snapshot.host.state !== "current") {
    return notice(
      "Host status is stale",
      "The session list is current, but laptop health could not be refreshed. Writes remain unavailable.",
      "attention",
      false
    );
  }

  const preciseRemoteNotice = remoteNotice(snapshot.host.data, snapshot.host.state);
  if (preciseRemoteNotice !== null) return preciseRemoteNotice;
  if (access?.locked === true) {
    return notice(
      "Remote writes are locked",
      "Session monitoring remains available. Unlocking requires the laptop.",
      "attention",
      false
    );
  }
  if (access?.permission === "read") {
    return notice(
      "Read-only access",
      "You can monitor sessions, but this device cannot send commands.",
      "attention",
      false
    );
  }
  if (snapshot.phase === "degraded") {
    return degradedNotice(snapshot.host.data);
  }
  if (!canDisclose && snapshot.targetState.failure !== null) {
    return notice(
      "Sessions could not be loaded",
      "The session list request failed without changing any existing state.",
      "danger",
      false
    );
  }
  return null;
}

function accessNotice(
  state: NonNullable<BrowserConnectionSnapshot["access"]["data"]>["authentication_state"]
): MissionNotice {
  switch (state) {
    case "unpaired":
      return notice(
        "Pair this phone",
        "Pairing is required before HostDeck can reveal session data.",
        "danger",
        false
      );
    case "expired_device":
      return notice(
        "Pairing expired",
        "Pair this phone again from the laptop before reading sessions.",
        "danger",
        false
      );
    case "revoked_device":
      return notice(
        "Device access was revoked",
        "Pair this phone again from the laptop before reading sessions.",
        "danger",
        false
      );
    case "invalid_device":
      return notice(
        "Device access is invalid",
        "Pair this phone again before reading sessions.",
        "danger",
        false
      );
    case "local_admin":
    case "paired_device":
      return notice(
        "Session access is unavailable",
        "The current browser authority cannot read sessions.",
        "danger",
        true
      );
  }
}

function remoteNotice(
  host: SelectedHostStatusResponse | null,
  hostState: BrowserConnectionSnapshot["host"]["state"]
): MissionNotice | null {
  if (host === null || hostState !== "current") return null;
  if (host.remote.availability === "ready" || host.remote.availability === "unknown") {
    return null;
  }
  const body = remoteCauseCopy(host.remote.cause);
  return notice("Remote access needs attention", body, "attention", false);
}

function remoteCauseCopy(cause: SelectedHostStatusResponse["remote"]["cause"]): string {
  switch (cause) {
    case "remote_disabled":
      return "Remote access is disabled on the laptop.";
    case "client_not_installed":
      return "Tailscale is not installed on the laptop.";
    case "client_stopped":
      return "Tailscale is stopped on the laptop.";
    case "client_signed_out":
      return "Tailscale is signed out on the laptop.";
    case "profile_absent":
    case "profile_other":
      return "Select the saved HostDeck Tailscale profile on the laptop.";
    case "serve_absent":
    case "serve_foreign":
    case "serve_colliding":
    case "serve_drifted":
    case "serve_public":
      return "The HostDeck Tailscale Serve mapping needs repair on the laptop.";
    case "consent_required":
    case "permission_denied":
      return "Laptop approval is required to restore remote access.";
    case "not_observed":
    case "client_unsupported":
    case "client_error":
    case "profile_unknown":
    case "external_origin_invalid":
    case "observation_stale":
    case "observation_failed":
    case "command_failed":
    case "command_timeout":
    case "output_oversized":
    case "schema_invalid":
    case "profile_changed":
    case "cleanup_incomplete":
    case null:
      return "Inspect HostDeck remote access on the laptop.";
  }
}

function degradedNotice(host: SelectedHostStatusResponse | null): MissionNotice {
  const causes = host?.local.components.flatMap((component) => component.causes) ?? [];
  const body = causes.includes("runtime_starting")
    ? "The Codex runtime is starting. Current session state remains visible."
    : causes.includes("runtime_reconciling")
      ? "The Codex runtime is reconciling saved state. Writes remain unavailable."
      : causes.includes("source_stale")
        ? "One or more host health observations are stale."
        : "Some host capabilities are unavailable. Session state remains read-only where shown.";
  return notice("Host health is degraded", body, "attention", false);
}

function rowGroup(session: SelectedSessionReadItem["session"]): MissionQueueId {
  if (
    session.freshness !== "current" ||
    session.session_state !== "active" ||
    ["needs_approval", "needs_input", "failed", "stuck", "unknown"].includes(
      session.attention
    ) ||
    ["waiting_for_approval", "waiting_for_input", "failed", "interrupted", "unknown"].includes(
      session.turn_state
    )
  ) {
    return "act_now";
  }
  if (session.attention === "watch" || session.turn_state === "in_progress") {
    return "in_progress";
  }
  return "quiet";
}

function rowState(
  session: SelectedSessionReadItem["session"]
): Readonly<{ label: string; tone: MissionTone }> {
  if (session.freshness === "stale" || session.freshness === "disconnected") {
    return { label: "Stale", tone: "attention" };
  }
  if (session.freshness === "incompatible" || session.session_state === "incompatible") {
    return { label: "Incompatible", tone: "danger" };
  }
  if (session.session_state === "archived") return { label: "Archived", tone: "muted" };
  if (session.session_state === "starting") return { label: "Starting", tone: "attention" };
  if (session.session_state === "stale") return { label: "Stale", tone: "attention" };
  if (session.session_state === "unknown") return { label: "Unknown", tone: "attention" };
  switch (session.attention) {
    case "needs_approval":
      return { label: "Needs approval", tone: "attention" };
    case "needs_input":
      return { label: "Needs input", tone: "attention" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "stuck":
      return session.turn_state === "interrupted"
        ? { label: "Interrupted", tone: "danger" }
        : { label: "Needs attention", tone: "attention" };
    case "unknown":
      return { label: "Unknown", tone: "attention" };
    case "watch":
      return { label: "Running", tone: "connected" };
    case "none":
      break;
  }
  switch (session.turn_state) {
    case "waiting_for_approval":
      return { label: "Needs approval", tone: "attention" };
    case "waiting_for_input":
      return { label: "Needs input", tone: "attention" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "interrupted":
      return { label: "Interrupted", tone: "danger" };
    case "unknown":
      return { label: "Unknown", tone: "attention" };
    case "in_progress":
      return { label: "Running", tone: "connected" };
    case "idle":
    case "completed":
      return { label: "Quiet", tone: "muted" };
  }
}

function projectCue(cwd: string): string {
  if (cwd === "/") return "/";
  const trimmed = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const cue = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return cue || "/";
}

function relativeActivity(timestamp: string, nowMs: number): string {
  const activityMs = Date.parse(timestamp);
  if (!Number.isFinite(activityMs)) return "Time unavailable";
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - activityMs) / 1_000));
  if (elapsedSeconds < 60) return "Now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function fallbackSummary(stateLabel: string): string {
  switch (stateLabel) {
    case "Needs approval":
      return "Approval is required before work can continue.";
    case "Needs input":
      return "Input is required before work can continue.";
    case "Running":
      return "Work is in progress.";
    case "Quiet":
      return "No active turn.";
    default:
      return "Open the session for current details.";
  }
}

function sectionLabel(id: MissionQueueId): MissionQueueSection["label"] {
  switch (id) {
    case "act_now":
      return "ACT NOW";
    case "in_progress":
      return "IN PROGRESS";
    case "quiet":
      return "QUIET";
  }
}

function sectionTone(id: MissionQueueId): MissionTone {
  switch (id) {
    case "act_now":
      return "attention";
    case "in_progress":
      return "connected";
    case "quiet":
      return "muted";
  }
}

function formatSessionCount(count: number, hasMore: boolean): string {
  const noun = count === 1 ? "session" : "sessions";
  return `${count}${hasMore ? "+" : ""} ${noun}`;
}

function unavailableMeta(phase: BrowserConnectionPhase): string {
  switch (phase) {
    case "access_limited":
      return "Access required";
    case "unreachable":
      return "Host unreachable";
    case "remote_unavailable":
      return "Remote unavailable";
    case "offline":
      return "Runtime offline";
    case "incompatible":
      return "Runtime incompatible";
    case "fatal":
    case "closed":
      return "Unavailable";
    case "degraded":
      return "Host degraded";
    case "not_found":
    case "idle":
    case "loading":
    case "ready":
      return "No sessions";
  }
}

function notice(
  title: string,
  body: string,
  tone: MissionNotice["tone"],
  urgent: boolean
): MissionNotice {
  return Object.freeze({ title, body, tone, urgent });
}
