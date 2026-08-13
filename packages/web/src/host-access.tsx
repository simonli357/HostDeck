import type {
  SelectedAccessStateResponse
} from "@hostdeck/contracts";
import {
  Activity,
  AlertTriangle,
  CircleCheck,
  Clock3,
  Eye,
  HeartPulse,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  type LucideIcon,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UnlockKeyhole,
  Wifi,
  WifiOff
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";
import {
  createHostAccessRecoveryController,
  type HostAccessRecoveryController,
  type HostAccessRecoveryPhase,
  type HostAccessRecoveryView,
  projectHostAccessRecovery
} from "./host-access-recovery-state.js";
import { type HostLockBinding, HostLockPanel } from "./host-lock.js";
import { hostLockWriteReason } from "./host-lock-copy.js";
import {
  PairedDeviceManagementPanel,
  usePairedDeviceManagementController
} from "./paired-device-management.js";
import {
  createRemoteConnectionRecoveryController,
  projectRemoteConnectionRecovery,
  type RemoteConnectionRecoveryController,
  type RemoteConnectionRecoveryPhase,
  type RemoteConnectionRecoveryView
} from "./remote-connection-recovery-state.js";
import {
  RuntimeCompatibilityPanel,
  useRuntimeCompatibilityController
} from "./runtime-compatibility.js";
import { projectRuntimeCompatibility } from "./runtime-compatibility-state.js";

export type HostAccessTone = "connected" | "attention" | "danger" | "muted";

interface HostAccessActivation {
  readonly activated: boolean;
  readonly activate: () => void;
}

const defaultHostAccessActivation = Object.freeze({
  activated: true,
  activate: () => undefined
});

const HostAccessActivationContext = createContext<HostAccessActivation>(
  defaultHostAccessActivation
);

export function HostAccessActivationProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [activated, setActivated] = useState(false);
  const activate = useCallback(() => setActivated(true), []);
  const value = useMemo(
    () => Object.freeze({ activated, activate }),
    [activate, activated]
  );
  return (
    <HostAccessActivationContext.Provider value={value}>
      {children}
    </HostAccessActivationContext.Provider>
  );
}

export function useHostAccessActivation(): HostAccessActivation {
  return useContext(HostAccessActivationContext);
}

export interface HostAccessFact {
  readonly id:
    | "connection"
    | "origin"
    | "permission"
    | "expiry"
    | "lock"
    | "reads"
    | "writes"
    | "page_security"
    | "host"
    | "remote"
    | "stream";
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
  readonly tone: HostAccessTone;
}

export interface HostAccessProjection {
  readonly title: string;
  readonly body: string;
  readonly tone: HostAccessTone;
  readonly urgent: boolean;
  readonly facts: readonly HostAccessFact[];
  readonly remote: RemoteConnectionRecoveryView;
  readonly recovery: HostAccessRecoveryView;
}

export interface ConnectedHostAccessProps {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly hostLock: HostLockBinding;
  readonly now?: () => number;
  readonly children?: ((content: ReactNode) => ReactNode) | undefined;
}

export function ConnectedHostAccess({
  coordinator,
  hostLock,
  now = Date.now,
  children
}: ConnectedHostAccessProps) {
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.snapshot,
    coordinator.snapshot
  );
  const recoveryController = useHostAccessRecoveryController(coordinator, snapshot);
  const recovery = useSyncExternalStore(
    recoveryController.subscribe,
    recoveryController.snapshot,
    recoveryController.snapshot
  );
  const remoteController = useRemoteConnectionRecoveryController(coordinator, snapshot);
  const remote = useSyncExternalStore(
    remoteController.subscribe,
    remoteController.snapshot,
    remoteController.snapshot
  );
  const compatibilityController = useRuntimeCompatibilityController(coordinator, snapshot);
  const compatibility = useSyncExternalStore(
    compatibilityController.subscribe,
    compatibilityController.snapshot,
    compatibilityController.snapshot
  );
  const hostAccessActivation = useHostAccessActivation();
  const deviceController = usePairedDeviceManagementController(
    coordinator,
    snapshot,
    undefined,
    hostAccessActivation.activated
  );
  const devices = useSyncExternalStore(
    deviceController.subscribe,
    deviceController.snapshot,
    deviceController.snapshot
  );
  const nowMs = Reflect.apply(now, undefined, []) as number;
  const content = (
    <>
      <HostAccessPanel
        projection={projectHostAccess(snapshot, nowMs, recovery, remote)}
        onRecover={recoveryController.recover}
        onCheckRemote={remoteController.check}
      />
      <RuntimeCompatibilityPanel
        view={compatibility}
        onCheck={compatibilityController.check}
      />
      <HostLockPanel binding={hostLock} />
      <PairedDeviceManagementPanel controller={deviceController} view={devices} />
    </>
  );
  return children === undefined ? content : children(content);
}

export function useRemoteConnectionRecoveryController(
  coordinator: BrowserConnectionStateCoordinator,
  snapshot: BrowserConnectionSnapshot
): RemoteConnectionRecoveryController {
  const owner = useMemo(
    () =>
      createRemoteConnectionRecoveryController({
        port: Object.freeze({
          snapshot: coordinator.snapshot,
          requestRemoteStatus: coordinator.requestRemoteStatus,
          refresh: coordinator.refresh
        })
      }),
    [coordinator]
  );
  const activeOwner = useRef<Readonly<{
    controller: RemoteConnectionRecoveryController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    void snapshot;
    owner.synchronize();
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

export function useHostAccessRecoveryController(
  coordinator: BrowserConnectionStateCoordinator,
  snapshot: BrowserConnectionSnapshot
): HostAccessRecoveryController {
  const owner = useMemo(
    () =>
      createHostAccessRecoveryController({
        port: Object.freeze({
          snapshot: coordinator.snapshot,
          refresh: coordinator.refresh,
          bootstrapCsrf: coordinator.bootstrapCsrf
        })
      }),
    [coordinator]
  );
  const activeOwner = useRef<Readonly<{
    controller: HostAccessRecoveryController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    void snapshot;
    owner.synchronize();
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

export function HostAccessPanel({
  projection,
  onCheckRemote,
  onRecover
}: Readonly<{
  projection: HostAccessProjection;
  onCheckRemote?: (() => Promise<RemoteConnectionRecoveryView>) | undefined;
  onRecover?: (() => Promise<HostAccessRecoveryView>) | undefined;
}>) {
  if (projection.recovery.action !== null && onRecover === undefined) {
    throw new TypeError("HostDeck host-access recovery action is missing its owner.");
  }
  if (projection.remote.action !== null && onCheckRemote === undefined) {
    throw new TypeError("HostDeck remote recovery action is missing its owner.");
  }
  return (
    <section className="hostdeck-access" aria-label="Host and access details">
      <div
        className={`hostdeck-access__summary hostdeck-tone--${projection.tone}`}
        role={projection.urgent ? "alert" : "status"}
      >
        {summaryIcon(projection.tone)}
        <div>
          <h2>{projection.title}</h2>
          <p>{projection.body}</p>
        </div>
      </div>
      <dl className="hostdeck-access__facts">
        {projection.facts.map((fact) => {
          const Icon = factIcon(fact);
          return (
            <div
              key={fact.id}
              className={`hostdeck-access-fact hostdeck-tone--${fact.tone}${
                fact.id === "origin" ? " hostdeck-access-fact--origin" : ""
              }`}
            >
              <dt>
                <Icon size={19} strokeWidth={2} aria-hidden="true" />
                <span>{fact.label}</span>
              </dt>
              <dd className={fact.id === "origin" ? "hostdeck-access-fact__origin" : undefined}>
                <span>{fact.value}</span>
                {fact.detail === null ? null : <small>{fact.detail}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
      <RemoteConnectionRecoveryPanel
        view={projection.remote}
        onCheck={onCheckRemote}
      />
      <RecoveryRailPanel view={projection.recovery} onRecover={onRecover} />
    </section>
  );
}

export function RemoteConnectionRecoveryPanel({
  view,
  onCheck
}: Readonly<{
  view: RemoteConnectionRecoveryView;
  onCheck?: (() => Promise<RemoteConnectionRecoveryView>) | undefined;
}>) {
  if (view.action !== null && onCheck === undefined) {
    throw new TypeError("HostDeck remote recovery action is missing its owner.");
  }
  const Icon = remoteRecoveryIcon(view.phase);
  return (
    <section
      className={`hostdeck-remote-recovery hostdeck-tone--${view.tone}`}
      aria-labelledby="hostdeck-remote-recovery-title"
      aria-describedby="hostdeck-remote-recovery-detail"
      aria-busy={view.busy || undefined}
    >
      <div className="hostdeck-remote-recovery__owner">
        <span>{view.ownerLabel}</span>
        <small>{view.sourceLabel}</small>
      </div>
      <div
        className="hostdeck-remote-recovery__state"
        role={view.urgent || view.phase === "check_failed" ? "alert" : "status"}
        aria-atomic="true"
      >
        <Icon
          className={view.busy ? "hostdeck-spin" : undefined}
          size={24}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span>
          <h2 id="hostdeck-remote-recovery-title">{view.title}</h2>
          <p id="hostdeck-remote-recovery-detail">{view.detail}</p>
        </span>
      </div>
      {view.externalOrigin === null ? null : (
        <div className="hostdeck-remote-recovery__origin">
          <span>Private address</span>
          <strong>{view.externalOrigin}</strong>
        </div>
      )}
      {view.action === null ? null : (
        <button
          type="button"
          className="hostdeck-action-button hostdeck-remote-recovery__action"
          disabled={!view.actionEnabled}
          aria-busy={view.busy || undefined}
          onClick={() => {
            if (onCheck !== undefined) void onCheck();
          }}
        >
          {view.busy ? (
            <LoaderCircle className="hostdeck-spin" size={18} strokeWidth={2} aria-hidden="true" />
          ) : (
            <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
          )}
          <span>{view.actionLabel}</span>
        </button>
      )}
    </section>
  );
}

export function RecoveryRailPanel({
  view,
  onRecover
}: Readonly<{
  view: HostAccessRecoveryView;
  onRecover?: (() => Promise<HostAccessRecoveryView>) | undefined;
}>) {
  const Icon = recoveryIcon(view.phase);
  return (
    <div
      className={`hostdeck-access-recovery hostdeck-tone--${view.tone}`}
      role={view.urgent ? "alert" : "status"}
      aria-atomic="true"
      aria-busy={view.busy || undefined}
    >
      <Icon
        className={view.busy ? "hostdeck-spin" : undefined}
        size={21}
        strokeWidth={2}
        aria-hidden="true"
      />
      <span className="hostdeck-access-recovery__copy">
        <strong>{view.status}</strong>
        <span>{view.detail}</span>
      </span>
      {view.action === null ? null : (
        <button
          type="button"
          className="hostdeck-action-button hostdeck-access-recovery__action"
          disabled={!view.actionEnabled}
          aria-busy={view.busy || undefined}
          onClick={() => {
            if (onRecover !== undefined) void onRecover();
          }}
        >
          {view.busy ? (
            <LoaderCircle className="hostdeck-spin" size={18} strokeWidth={2} aria-hidden="true" />
          ) : (
            <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
          )}
          <span>{view.actionLabel}</span>
        </button>
      )}
    </div>
  );
}

export function projectHostAccess(
  snapshot: BrowserConnectionSnapshot,
  nowMs: number,
  recovery?: HostAccessRecoveryView,
  remote?: RemoteConnectionRecoveryView
): HostAccessProjection {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !Object.isFrozen(snapshot) ||
    !Number.isFinite(nowMs) ||
    nowMs < 0
  ) {
    throw new TypeError("HostDeck host/access projection input is invalid.");
  }
  const recoveryView = recovery ?? projectHostAccessRecovery(snapshot);
  const remoteView = remote ?? projectRemoteConnectionRecovery(snapshot);
  if (!Object.isFrozen(recoveryView)) {
    throw new TypeError("HostDeck host/access recovery projection is invalid.");
  }
  if (!Object.isFrozen(remoteView)) {
    throw new TypeError("HostDeck remote recovery projection is invalid.");
  }
  const access = snapshot.access.data;
  if (access === null) return projectAbsentAccess(snapshot, recoveryView, remoteView);

  const current = snapshot.access.state === "current";
  const mayDiscloseProtected = browserMayDiscloseProtected(access);
  const readable = current && mayDiscloseProtected;
  const facts: HostAccessFact[] = [
    connectionFact(access, current),
    fact("origin", "Address", access.configured_origin, current ? "Current origin" : "Last known origin", current ? "connected" : "attention"),
    permissionFact(access, current)
  ];
  if (access.authentication_state === "paired_device" && access.device_expires_at !== null) {
    facts.push(expiryFact(access.device_expires_at, nowMs, current));
  }
  facts.push(
    fact(
      "lock",
      "Write lock",
      access.locked ? "Locked" : "Unlocked",
      access.locked ? "Unlocking requires the laptop" : null,
      access.locked ? "danger" : current ? "connected" : "attention"
    ),
    fact(
      "reads",
      "Session reads",
      readable ? "Available" : "Blocked",
      current ? null : "Access state is not current",
      readable ? "connected" : "danger"
    ),
    writeFact(snapshot),
    pageSecurityFact(recoveryView),
    mayDiscloseProtected ? hostFact(snapshot) : suppressedHostFact()
  );
  const remoteFactValue = remoteFact(remoteView, mayDiscloseProtected);
  if (remoteFactValue !== null) facts.push(remoteFactValue);
  const stream = mayDiscloseProtected ? streamFact(snapshot) : null;
  if (stream !== null) facts.push(stream);

  const summary = accessSummary(snapshot, access, current);
  return projection(
    summary.title,
    summary.body,
    summary.tone,
    summary.urgent,
    facts,
    remoteView,
    recoveryView
  );
}

function browserMayDiscloseProtected(access: SelectedAccessStateResponse): boolean {
  return (
    access.can_read_sessions &&
    access.authentication_state !== "local_admin"
  );
}

function suppressedHostFact(): HostAccessFact {
  return fact(
    "host",
    "Laptop host",
    "Hidden until authorized",
    "No protected host status is disclosed",
    "muted"
  );
}

function projectAbsentAccess(
  snapshot: BrowserConnectionSnapshot,
  recovery: HostAccessRecoveryView,
  remote: RemoteConnectionRecoveryView
): HostAccessProjection {
  if (
    snapshot.phase === "idle" ||
    snapshot.phase === "loading" ||
    snapshot.access.state === "loading"
  ) {
    return projection(
      "Checking access",
      "HostDeck is checking this browser's current access.",
      "muted",
      false,
      [
        fact("connection", "Connection", "Checking", null, "muted"),
        pageSecurityFact(recovery)
      ],
      remote,
      recovery
    );
  }
  return projection(
    "Access unavailable",
    "HostDeck could not read a current access state. No session access is assumed.",
    "danger",
    true,
    [
      fact("connection", "Connection", connectionFailureLabel(snapshot), null, "danger"),
      fact("reads", "Session reads", "Blocked", null, "danger"),
      fact("writes", "Secure writes", "Blocked", null, "danger"),
      pageSecurityFact(recovery)
    ],
    remote,
    recovery
  );
}

function accessSummary(
  snapshot: BrowserConnectionSnapshot,
  access: SelectedAccessStateResponse,
  current: boolean
): Pick<HostAccessProjection, "title" | "body" | "tone" | "urgent"> {
  if (!current) {
    return {
      title: "Access state is stale",
      body: "Previously verified access is shown while HostDeck reconnects. Writes remain blocked.",
      tone: "attention",
      urgent: false
    };
  }
  switch (access.authentication_state) {
    case "unpaired":
      return {
        title: access.can_read_sessions ? "Laptop read access" : "Pairing required",
        body: access.can_read_sessions
          ? "This laptop browser can monitor sessions. Pair a device before remote control."
          : "Create a pairing link on the laptop before this phone can read sessions.",
        tone: "attention",
        urgent: !access.can_read_sessions
      };
    case "invalid_device":
      return deniedSummary("Device access is invalid");
    case "expired_device":
      return deniedSummary("Pairing expired");
    case "revoked_device":
      return deniedSummary("Device access was revoked");
    case "local_admin":
      return deniedSummary("Invalid browser access");
    case "paired_device":
      if (access.locked) {
        return {
          title: "Remote writes are locked",
          body: "Session monitoring remains available. Unlocking requires the laptop.",
          tone: "attention",
          urgent: false
        };
      }
      if (access.permission === "read") {
        return {
          title: "Read-only access",
          body: "This phone can monitor sessions but cannot send commands.",
          tone: "attention",
          urgent: false
        };
      }
      return snapshot.writeEligibility.eligible
        ? {
            title: "Secure control ready",
            body: "Private connection, writer permission, host health, and page protection are current.",
            tone: "connected",
            urgent: false
          }
        : {
            title: "Secure writes are not ready",
            body: writeBlockSummary(snapshot.writeEligibility.causes),
            tone: "attention",
            urgent: false
          };
  }
}

function deniedSummary(title: string) {
  return {
    title,
    body: "Create a new pairing link on the laptop before reading sessions.",
    tone: "danger" as const,
    urgent: true
  };
}

function connectionFact(
  access: SelectedAccessStateResponse,
  current: boolean
): HostAccessFact {
  return fact(
    "connection",
    "Connection",
    access.network_mode === "remote" ? "Private HTTPS" : "Laptop",
    current ? (access.transport === "https" ? "Encrypted remote origin" : "Loopback HTTP") : "Last verified connection",
    current ? "connected" : "attention"
  );
}

function permissionFact(
  access: SelectedAccessStateResponse,
  current: boolean
): HostAccessFact {
  const value = (() => {
    switch (access.authentication_state) {
      case "paired_device":
        return access.permission === "write" ? "Read & write" : "Read only";
      case "unpaired":
        return access.can_read_sessions ? "Local read" : "Pair required";
      case "invalid_device":
        return "Invalid device";
      case "expired_device":
        return "Expired";
      case "revoked_device":
        return "Revoked";
      case "local_admin":
        return "Invalid browser access";
    }
  })();
  const allowed =
    current &&
    (access.authentication_state === "paired_device" ||
      (access.authentication_state === "unpaired" && access.can_read_sessions));
  return fact(
    "permission",
    "Permission",
    value,
    current ? "Current device access" : "Last known device access",
    allowed ? "connected" : current ? "danger" : "attention"
  );
}

function expiryFact(
  expiresAt: string,
  nowMs: number,
  current: boolean
): HostAccessFact {
  const expiryMs = Date.parse(expiresAt);
  const remainingDays = Math.max(0, Math.ceil((expiryMs - nowMs) / 86_400_000));
  const detail = remainingDays === 0
    ? "Expiry requires a current access refresh"
    : remainingDays === 1
      ? "1 day remaining"
      : `${remainingDays} days remaining`;
  return fact(
    "expiry",
    "Paired until",
    formatUtcDate(expiresAt),
    detail,
    current && remainingDays > 0 ? "connected" : "attention"
  );
}

function writeFact(snapshot: BrowserConnectionSnapshot): HostAccessFact {
  if (snapshot.writeEligibility.eligible) {
    return fact("writes", "Secure writes", "Ready", "Page protection current", "connected");
  }
  const pageSecurityBlocked = primaryWriteCause(snapshot.writeEligibility.causes) === "csrf_not_ready";
  return fact(
    "writes",
    "Secure writes",
    pageSecurityBlocked
      ? pageSecurityWriteLabel(snapshot)
      : writeBlockLabel(snapshot.writeEligibility.causes),
    pageSecurityBlocked
      ? pageSecurityWriteDetail(snapshot)
      : writeBlockSummary(snapshot.writeEligibility.causes),
    "attention"
  );
}

function pageSecurityWriteLabel(snapshot: BrowserConnectionSnapshot): string {
  if (snapshot.csrf.phase === "bootstrapping") return "Securing";
  if (snapshot.csrf.phase === "failed") return "Setup failed";
  if (
    snapshot.csrf.phase === "idle" &&
    snapshot.csrf.invalidationReason === "not_bootstrapped"
  ) {
    return "Securing";
  }
  if (snapshot.csrf.phase === "closed") return "Unavailable";
  return "Check required";
}

function pageSecurityWriteDetail(snapshot: BrowserConnectionSnapshot): string {
  if (snapshot.csrf.phase === "bootstrapping") {
    return "Secure page protection is being established.";
  }
  if (snapshot.csrf.phase === "failed") {
    return "Secure page setup was not confirmed.";
  }
  if (
    snapshot.csrf.phase === "idle" &&
    snapshot.csrf.invalidationReason === "not_bootstrapped"
  ) {
    return "Secure page protection is starting.";
  }
  if (snapshot.csrf.phase === "closed") return "The browser connection is closed.";
  return "Page security must be renewed.";
}

function pageSecurityFact(recovery: HostAccessRecoveryView): HostAccessFact {
  return fact(
    "page_security",
    "Page security",
    recovery.pageSecurity,
    recovery.pageSecurityDetail,
    recovery.tone
  );
}

function hostFact(snapshot: BrowserConnectionSnapshot): HostAccessFact {
  if (snapshot.host.data === null) {
    const blocked = snapshot.host.state === "blocked";
    return fact(
      "host",
      "Laptop host",
      blocked ? "Hidden until authorized" : snapshot.host.state === "loading" ? "Checking" : "Unavailable",
      blocked ? "No protected host status is disclosed" : null,
      blocked || snapshot.host.state === "loading" ? "muted" : "danger"
    );
  }
  if (snapshot.host.state !== "current") {
    return fact("host", "Laptop host", "Stale", "Writes remain blocked", "attention");
  }
  const compatibility = projectRuntimeCompatibility(snapshot);
  if (compatibility.state === "version_drift") {
    return fact("host", "Laptop host", "Update required", "Codex controls are blocked", "danger");
  }
  if (compatibility.state === "incompatible") {
    return fact("host", "Laptop host", "Incompatible", "Codex controls are blocked", "danger");
  }
  if (compatibility.state === "unknown") {
    return fact("host", "Laptop host", "Compatibility unknown", "Writes remain blocked", "attention");
  }
  if (compatibility.state === "disconnected") {
    return fact("host", "Laptop host", "Runtime disconnected", "Last known compatibility only", "attention");
  }
  if (compatibility.state === "degraded") {
    return fact("host", "Laptop host", "Compatibility limited", "Writes remain blocked", "attention");
  }
  const host = snapshot.host.data;
  if (snapshot.phase === "incompatible") {
    return fact("host", "Laptop host", "Incompatible", "Codex controls are unavailable", "danger");
  }
  if (snapshot.phase === "offline") {
    return fact("host", "Laptop host", "Runtime offline", "Local HostDeck remains reachable", "danger");
  }
  if (snapshot.phase === "fatal") {
    return fact("host", "Laptop host", "Unavailable", "Host status is not usable", "danger");
  }
  return fact(
    "host",
    "Laptop host",
    host.local.readiness === "ready" ? "Ready" : host.local.state === "degraded" ? "Degraded" : "Not ready",
    host.local.readiness === "ready" ? "Current host health" : "Writes remain blocked",
    host.local.readiness === "ready" ? "connected" : "attention"
  );
}

function remoteFact(
  remote: RemoteConnectionRecoveryView,
  mayDiscloseProtected: boolean
): HostAccessFact | null {
  if (!mayDiscloseProtected) return null;
  return fact(
    "remote",
    "Remote access",
    remoteFactLabel(remote.phase),
    remote.sourceLabel,
    remote.tone
  );
}

function streamFact(snapshot: BrowserConnectionSnapshot): HostAccessFact | null {
  if (snapshot.target?.kind !== "session_detail") return null;
  const mapping: Readonly<Record<BrowserConnectionSnapshot["stream"]["state"], [string, HostAccessTone]>> = {
    not_applicable: ["Not active", "muted"],
    idle: ["Not started", "muted"],
    connecting: ["Connecting", "attention"],
    connected: ["Live", "connected"],
    reconnecting: ["Reconnecting", "attention"],
    failed: ["Unavailable", "danger"],
    closed: ["Closed", "muted"]
  };
  const [value, tone] = mapping[snapshot.stream.state];
  const detail = snapshot.stream.continuity === "boundary"
    ? "History boundary visible"
    : snapshot.stream.continuity === "contiguous"
      ? "Continuity verified"
      : null;
  return fact("stream", "Session updates", value, detail, tone);
}

function writeBlockLabel(causes: readonly BrowserConnectionWriteBlockCause[]): string {
  const cause = primaryWriteCause(causes);
  switch (cause) {
    case "connection_not_current":
      return "Waiting for current access";
    case "unpaired":
      return "Pair required";
    case "invalid_device":
      return "Invalid device";
    case "expired_device":
      return "Pairing expired";
    case "revoked_device":
      return "Access revoked";
    case "permission_denied":
      return "Permission denied";
    case "read_only_access":
      return "Read only";
    case "host_lock_pending":
      return "Locking";
    case "host_lock_unconfirmed":
      return "Lock unconfirmed";
    case "host_locked":
      return "Locked";
    case "host_status_unavailable":
      return "Host status unavailable";
    case "host_not_ready":
      return "Host not ready";
    case "csrf_not_ready":
      return "Securing writes";
    case null:
      return "Blocked";
  }
}

function writeBlockSummary(causes: readonly BrowserConnectionWriteBlockCause[]): string {
  const cause = primaryWriteCause(causes);
  switch (cause) {
    case "connection_not_current":
      return "Current connection truth is required before a write.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied":
      return "Pair this phone from the laptop before using controls.";
    case "read_only_access":
      return "This device does not have writer permission.";
    case "host_lock_pending":
    case "host_lock_unconfirmed":
      return hostLockWriteReason(cause);
    case "host_locked":
      return "Unlock HostDeck locally on the laptop.";
    case "host_status_unavailable":
    case "host_not_ready":
      return "Current laptop health is required before a write.";
    case "csrf_not_ready":
      return "Secure page protection is not ready.";
    case null:
      return "Secure writes are blocked.";
  }
}

function primaryWriteCause(
  causes: readonly BrowserConnectionWriteBlockCause[]
): BrowserConnectionWriteBlockCause | null {
  const priority: readonly BrowserConnectionWriteBlockCause[] = [
    "connection_not_current",
    "unpaired",
    "invalid_device",
    "expired_device",
    "revoked_device",
    "permission_denied",
    "read_only_access",
    "host_lock_pending",
    "host_lock_unconfirmed",
    "host_locked",
    "host_status_unavailable",
    "host_not_ready",
    "csrf_not_ready"
  ];
  return priority.find((cause) => causes.includes(cause)) ?? null;
}

function remoteFactLabel(phase: RemoteConnectionRecoveryPhase): string {
  switch (phase) {
    case "ready":
      return "Ready";
    case "checking":
      return "Checking";
    case "not_observed":
      return "Not checked";
    case "last_known":
      return "Stale";
    case "browser_reconnecting":
      return "Reconnecting";
    case "browser_unreachable":
      return "Unreachable";
    case "check_failed":
      return "Check failed";
    case "access_limited":
      return "Hidden";
    case "closed":
      return "Closed";
    case "remote_disabled":
      return "Disabled";
    case "client_not_installed":
    case "client_unsupported":
    case "client_error":
    case "client_stopped":
    case "client_signed_out":
    case "profile_absent":
    case "profile_other":
    case "profile_unknown":
    case "serve_absent":
    case "serve_foreign":
    case "serve_colliding":
    case "serve_drifted":
    case "serve_public":
    case "external_origin_invalid":
    case "observation_stale":
    case "observation_failed":
    case "consent_required":
    case "permission_denied":
    case "command_failed":
    case "command_timeout":
    case "output_oversized":
    case "schema_invalid":
    case "profile_changed":
    case "cleanup_incomplete":
      return "Needs attention";
  }
}

function connectionFailureLabel(snapshot: BrowserConnectionSnapshot): string {
  if (snapshot.phase === "unreachable") return "Unreachable";
  if (snapshot.phase === "remote_unavailable") return "Remote unavailable";
  if (snapshot.phase === "closed") return "Closed";
  return "Unavailable";
}

function fact(
  id: HostAccessFact["id"],
  label: string,
  value: string,
  detail: string | null,
  tone: HostAccessTone
): HostAccessFact {
  return Object.freeze({ id, label, value, detail, tone });
}

function projection(
  title: string,
  body: string,
  tone: HostAccessTone,
  urgent: boolean,
  facts: readonly HostAccessFact[],
  remote: RemoteConnectionRecoveryView,
  recovery: HostAccessRecoveryView
): HostAccessProjection {
  return Object.freeze({
    title,
    body,
    tone,
    urgent,
    facts: Object.freeze(facts),
    remote,
    recovery
  });
}

function summaryIcon(tone: HostAccessTone) {
  if (tone === "connected") return <ShieldCheck size={24} strokeWidth={2} aria-hidden="true" />;
  if (tone === "danger") return <ShieldAlert size={24} strokeWidth={2} aria-hidden="true" />;
  if (tone === "attention") return <AlertTriangle size={24} strokeWidth={2} aria-hidden="true" />;
  return <Clock3 size={24} strokeWidth={2} aria-hidden="true" />;
}

function factIcon(factValue: HostAccessFact): LucideIcon {
  switch (factValue.id) {
    case "connection":
      return Wifi;
    case "origin":
      return Laptop;
    case "permission":
      return Eye;
    case "expiry":
      return Clock3;
    case "lock":
      return factValue.value === "Locked" ? LockKeyhole : UnlockKeyhole;
    case "reads":
      return Activity;
    case "writes":
      return ShieldCheck;
    case "page_security":
      return factValue.tone === "connected" ? ShieldCheck : ShieldAlert;
    case "host":
      return HeartPulse;
    case "remote":
      return factValue.tone === "connected" ? Wifi : WifiOff;
    case "stream":
      return Radio;
  }
}

function recoveryIcon(phase: HostAccessRecoveryPhase): LucideIcon {
  switch (phase) {
    case "ready":
    case "recovered":
      return ShieldCheck;
    case "checking":
    case "automatic_bootstrap":
    case "checking_access":
    case "securing_page":
      return LoaderCircle;
    case "setup_required":
    case "stale":
      return RefreshCw;
    case "bootstrap_failed":
    case "refresh_failed":
    case "pairing_required":
    case "unavailable":
      return ShieldAlert;
    case "read_only":
    case "closed":
      return Eye;
  }
}

function remoteRecoveryIcon(phase: RemoteConnectionRecoveryPhase): LucideIcon {
  switch (phase) {
    case "ready":
      return CircleCheck;
    case "checking":
      return LoaderCircle;
    case "not_observed":
    case "last_known":
      return Clock3;
    case "browser_reconnecting":
    case "browser_unreachable":
    case "client_not_installed":
    case "client_unsupported":
    case "client_error":
    case "client_stopped":
    case "client_signed_out":
    case "remote_disabled":
      return WifiOff;
    case "profile_absent":
    case "profile_other":
    case "profile_unknown":
    case "profile_changed":
      return Laptop;
    case "serve_absent":
    case "serve_foreign":
    case "serve_colliding":
    case "serve_drifted":
    case "serve_public":
    case "external_origin_invalid":
    case "observation_stale":
    case "observation_failed":
    case "consent_required":
    case "permission_denied":
    case "command_failed":
    case "command_timeout":
    case "output_oversized":
    case "schema_invalid":
    case "cleanup_incomplete":
    case "check_failed":
      return ShieldAlert;
    case "access_limited":
    case "closed":
      return Eye;
  }
}

function formatUtcDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric"
  }).format(parsed);
}
