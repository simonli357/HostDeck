import type {
  SelectedAccessStateResponse,
  SelectedHostRemoteStatus
} from "@hostdeck/contracts";
import {
  Activity,
  AlertTriangle,
  Clock3,
  Eye,
  HeartPulse,
  Laptop,
  LockKeyhole,
  type LucideIcon,
  Radio,
  ShieldAlert,
  ShieldCheck,
  UnlockKeyhole,
  Wifi,
  WifiOff
} from "lucide-react";
import { useSyncExternalStore } from "react";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";

export type HostAccessTone = "connected" | "attention" | "danger" | "muted";

export interface HostAccessFact {
  readonly id:
    | "connection"
    | "origin"
    | "permission"
    | "expiry"
    | "lock"
    | "reads"
    | "writes"
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
}

export interface ConnectedHostAccessProps {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly now?: () => number;
}

export function ConnectedHostAccess({
  coordinator,
  now = Date.now
}: ConnectedHostAccessProps) {
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.snapshot,
    coordinator.snapshot
  );
  const nowMs = Reflect.apply(now, undefined, []) as number;
  return <HostAccessPanel projection={projectHostAccess(snapshot, nowMs)} />;
}

export function HostAccessPanel({
  projection
}: Readonly<{ projection: HostAccessProjection }>) {
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
              <Icon size={19} strokeWidth={2} aria-hidden="true" />
              <span>
                <dt>{fact.label}</dt>
                <dd className={fact.id === "origin" ? "hostdeck-access-fact__origin" : undefined}>
                  {fact.value}
                </dd>
                {fact.detail === null ? null : <small>{fact.detail}</small>}
              </span>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export function projectHostAccess(
  snapshot: BrowserConnectionSnapshot,
  nowMs: number
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
  const access = snapshot.access.data;
  if (access === null) return projectAbsentAccess(snapshot);

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
    mayDiscloseProtected ? hostFact(snapshot) : suppressedHostFact()
  );
  const remote = remoteFact(snapshot, access, mayDiscloseProtected);
  if (remote !== null) facts.push(remote);
  const stream = mayDiscloseProtected ? streamFact(snapshot) : null;
  if (stream !== null) facts.push(stream);

  const summary = accessSummary(snapshot, access, current);
  return projection(summary.title, summary.body, summary.tone, summary.urgent, facts);
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
  snapshot: BrowserConnectionSnapshot
): HostAccessProjection {
  if (
    snapshot.phase === "idle" ||
    snapshot.phase === "loading" ||
    snapshot.access.state === "loading"
  ) {
    return projection(
      "Checking access",
      "HostDeck is resolving this browser's current authority.",
      "muted",
      false,
      [fact("connection", "Connection", "Checking", null, "muted")]
    );
  }
  return projection(
    "Access unavailable",
    "HostDeck could not read a current access state. No session authority is assumed.",
    "danger",
    true,
    [
      fact("connection", "Connection", connectionFailureLabel(snapshot), null, "danger"),
      fact("reads", "Session reads", "Blocked", null, "danger"),
      fact("writes", "Secure writes", "Blocked", null, "danger")
    ]
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
      return deniedSummary("Invalid browser authority");
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
            body: "Private connection, writer permission, host health, and page authority are current.",
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
        return "Invalid browser authority";
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
    current ? "Current device authority" : "Last known device authority",
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
    return fact("writes", "Secure writes", "Ready", "Current page authority", "connected");
  }
  return fact(
    "writes",
    "Secure writes",
    writeBlockLabel(snapshot.writeEligibility.causes),
    writeBlockSummary(snapshot.writeEligibility.causes),
    "attention"
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
  snapshot: BrowserConnectionSnapshot,
  access: SelectedAccessStateResponse,
  mayDiscloseProtected: boolean
): HostAccessFact | null {
  if (access.network_mode === "remote") {
    return fact(
      "remote",
      "Remote access",
      snapshot.access.state === "current" ? "Reached" : "Reconnecting",
      snapshot.access.state === "current" ? "Current private origin" : "Last verified private origin",
      snapshot.access.state === "current" ? "connected" : "attention"
    );
  }
  if (!mayDiscloseProtected) return null;
  const host = snapshot.host.data;
  if (host === null) return null;
  const remote = host.remote;
  const value = remoteStatusLabel(remote);
  const current = snapshot.host.state === "current";
  return fact(
    "remote",
    "Remote access",
    current ? value : `${value} (stale)`,
    remote.laptop_action_required ? "Local laptop action required" : null,
    remote.availability === "ready" && current
      ? "connected"
      : remote.availability === "unknown"
        ? "muted"
        : "attention"
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
    case "host_locked":
      return "Unlock HostDeck locally on the laptop.";
    case "host_status_unavailable":
    case "host_not_ready":
      return "Current laptop health is required before a write.";
    case "csrf_not_ready":
      return "Secure page authority is not ready.";
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
    "host_locked",
    "host_status_unavailable",
    "host_not_ready",
    "csrf_not_ready"
  ];
  return priority.find((cause) => causes.includes(cause)) ?? null;
}

function remoteStatusLabel(remote: SelectedHostRemoteStatus): string {
  switch (remote.availability) {
    case "ready":
      return "Ready";
    case "disabled":
      return "Disabled";
    case "unavailable":
      return "Unavailable";
    case "unknown":
      return "Not checked";
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
  facts: readonly HostAccessFact[]
): HostAccessProjection {
  return Object.freeze({ title, body, tone, urgent, facts: Object.freeze(facts) });
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
    case "host":
      return HeartPulse;
    case "remote":
      return factValue.tone === "connected" ? Wifi : WifiOff;
    case "stream":
      return Radio;
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
