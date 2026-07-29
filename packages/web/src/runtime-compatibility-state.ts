import {
  type SelectedHostCompatibilityCapabilityState,
  type SelectedHostCompatibilityEvidenceState,
  type SelectedHostCompatibilityState,
  selectedHostCompatibilityStatusSchema
} from "@hostdeck/contracts";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator,
  BrowserConnectionTarget
} from "./connection-state.js";

export const runtimeCompatibilityPhases = Object.freeze([
  "hidden",
  "loading",
  "unavailable",
  "checking",
  "check_failed",
  "recovery_unconfirmed",
  "supported",
  "degraded",
  "incompatible",
  "unknown",
  "disconnected",
  "version_drift",
  "closed"
] as const);

export type RuntimeCompatibilityPhase =
  (typeof runtimeCompatibilityPhases)[number];
export type RuntimeCompatibilityTone =
  | "connected"
  | "attention"
  | "danger"
  | "muted";

export interface RuntimeCompatibilityView {
  readonly phase: RuntimeCompatibilityPhase;
  readonly state: SelectedHostCompatibilityState | null;
  readonly evidence: SelectedHostCompatibilityEvidenceState | null;
  readonly capabilityState: SelectedHostCompatibilityCapabilityState | null;
  readonly title: string;
  readonly detail: string;
  readonly tone: RuntimeCompatibilityTone;
  readonly urgent: boolean;
  readonly ownerLabel: "CODEX RUNTIME" | "HOSTDECK" | "BROWSER";
  readonly sourceLabel: string;
  readonly observedVersion: string | null;
  readonly supportedVersion: string | null;
  readonly observedVersionLabel: string;
  readonly supportedVersionLabel: string;
  readonly capabilityLabel: string;
  readonly evidenceLabel: string;
  readonly checkedAt: string | null;
  readonly recordedAt: string | null;
  readonly checkedLabel: string;
  readonly current: boolean;
  readonly routeVisible: boolean;
  readonly action: "check_compatibility" | null;
  readonly actionLabel: "Check compatibility" | "Recheck compatibility" | null;
  readonly actionEnabled: boolean;
  readonly busy: boolean;
}

export interface RuntimeCompatibilityPort {
  readonly snapshot: () => BrowserConnectionSnapshot;
  readonly refresh: BrowserConnectionStateCoordinator["refresh"];
}

export interface CreateRuntimeCompatibilityControllerOptions {
  readonly port: RuntimeCompatibilityPort;
}

export interface RuntimeCompatibilityController {
  readonly snapshot: () => RuntimeCompatibilityView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly synchronize: () => RuntimeCompatibilityView;
  readonly check: () => Promise<RuntimeCompatibilityView>;
  readonly close: () => RuntimeCompatibilityView;
}

type CompatibilityActivity =
  | Readonly<{ readonly phase: "idle" }>
  | Readonly<{
      readonly phase: "checking";
      readonly startingView: RuntimeCompatibilityView;
    }>
  | Readonly<{
      readonly phase: "failed" | "recovery_unconfirmed" | "recovered";
      readonly authorityKey: string;
      readonly targetKey: string;
      readonly settledEpoch: number;
      readonly startingView: RuntimeCompatibilityView;
    }>;

interface ActiveCheck {
  readonly authorityKey: string;
  readonly targetKey: string;
  readonly startEpoch: number;
  readonly startingView: RuntimeCompatibilityView;
  readonly promise: Promise<RuntimeCompatibilityView>;
  readonly resolve: (view: RuntimeCompatibilityView) => void;
  dispatchEpoch: number | null;
  settled: boolean;
}

interface CompatibilityPresentation {
  readonly title: string;
  readonly detail: string;
  readonly tone: RuntimeCompatibilityTone;
  readonly urgent: boolean;
  readonly routeVisible: boolean;
}

const maximumSubscribers = 32;
const optionKeys = ["port"] as const;
const portKeys = ["snapshot", "refresh"] as const;
const capabilityLabels: Readonly<
  Record<SelectedHostCompatibilityCapabilityState, string>
> = Object.freeze({
  verified: "Verified",
  limited: "Limited",
  blocked: "Blocked",
  unverified: "Unverified"
});
const evidenceLabels: Readonly<
  Record<SelectedHostCompatibilityEvidenceState, string>
> = Object.freeze({
  current: "Current",
  last_known: "Last known",
  unobserved: "Not observed"
});

export function createRuntimeCompatibilityController(
  input: CreateRuntimeCompatibilityControllerOptions
): RuntimeCompatibilityController {
  const port = readOptions(input);
  let connection = readPortSnapshot(port);
  let activity: CompatibilityActivity = idleActivity();
  let activeCheck: ActiveCheck | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = projectView(connection, activity);

  const notify = (): void => {
    for (const listener of [...subscribers]) {
      if (!subscribers.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  const publish = (): RuntimeCompatibilityView => {
    const next = projectView(connection, activity);
    if (sameView(currentView, next)) return currentView;
    currentView = next;
    notify();
    return currentView;
  };

  const finish = (
    owner: ActiveCheck,
    nextActivity: CompatibilityActivity
  ): RuntimeCompatibilityView => {
    if (activeCheck !== owner || owner.settled) return currentView;
    owner.settled = true;
    activeCheck = null;
    activity = nextActivity;
    const view = publish();
    owner.resolve(view);
    return view;
  };

  const suppress = (owner: ActiveCheck): RuntimeCompatibilityView =>
    finish(owner, idleActivity());

  const fail = (owner: ActiveCheck): RuntimeCompatibilityView => {
    try {
      connection = readPortSnapshot(port);
    } catch {
      connection = owner.startingView.phase === "closed"
        ? closedConnection(connection)
        : connection;
    }
    if (!pendingIdentityMatches(owner, connection)) return suppress(owner);
    return finish(owner, settledActivity("failed", owner));
  };

  const execute = async (owner: ActiveCheck): Promise<void> => {
    if (closed || activeCheck !== owner || owner.settled) return;
    let pending: Promise<unknown>;
    try {
      pending = callRefresh(port);
      connection = readPortSnapshot(port);
      if (!retainedIdentityMatches(owner, connection)) {
        observeSuppressedPromise(pending);
        suppress(owner);
        return;
      }
      if (connection.epoch <= owner.startEpoch) {
        observeSuppressedPromise(pending);
        fail(owner);
        return;
      }
      owner.dispatchEpoch = connection.epoch;
      publish();

      const result = await pending;
      if (activeCheck !== owner || owner.settled || closed) return;
      const parsedResult = readSnapshot(result);
      connection = readPortSnapshot(port);
      if (
        parsedResult !== connection ||
        !checkIdentityMatches(owner, connection) ||
        owner.dispatchEpoch !== connection.epoch
      ) {
        suppress(owner);
        return;
      }

      const resultView = projectRuntimeCompatibility(connection);
      if (
        connection.access.state !== "current" ||
        connection.host.state !== "current" ||
        connection.host.data === null ||
        resultView.state === null
      ) {
        fail(owner);
        return;
      }
      if (resultView.state !== "supported") {
        finish(owner, idleActivity());
        return;
      }

      if (!recoveryRequiresNewRevision(owner.startingView)) {
        finish(owner, idleActivity());
        return;
      }
      if (!isNewerSupportedRevision(owner.startingView, resultView)) {
        finish(owner, settledActivity("recovery_unconfirmed", owner));
        return;
      }
      finish(owner, settledActivity("recovered", owner));
    } catch {
      if (activeCheck === owner && !owner.settled) fail(owner);
    }
  };

  const controller: RuntimeCompatibilityController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck compatibility listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck compatibility listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    synchronize(): RuntimeCompatibilityView {
      if (closed) return currentView;
      const next = readPortSnapshot(port);
      connection = next;
      const owner = activeCheck;
      if (owner !== null && !pendingIdentityMatches(owner, next)) {
        return suppress(owner);
      }
      if (
        owner === null &&
        activity.phase !== "idle" &&
        activity.phase !== "checking"
      ) {
        if (
          retainedAuthorityKey(next) !== activity.authorityKey ||
          targetKey(next.target) !== activity.targetKey ||
          next.epoch > activity.settledEpoch
        ) {
          activity = idleActivity();
        }
      }
      return publish();
    },
    check(): Promise<RuntimeCompatibilityView> {
      if (closed) return Promise.resolve(currentView);
      if (activeCheck !== null) return activeCheck.promise;
      connection = readPortSnapshot(port);
      const authorityKey = checkAuthorityKey(connection);
      const currentTargetKey = targetKey(connection.target);
      if (authorityKey === null || currentTargetKey === null) {
        activity = idleActivity();
        return Promise.resolve(publish());
      }

      const startingView = projectRuntimeCompatibility(connection);
      let resolve!: (view: RuntimeCompatibilityView) => void;
      const promise = new Promise<RuntimeCompatibilityView>((innerResolve) => {
        resolve = innerResolve;
      });
      const owner: ActiveCheck = {
        authorityKey,
        targetKey: currentTargetKey,
        startEpoch: connection.epoch,
        startingView,
        promise,
        resolve,
        dispatchEpoch: null,
        settled: false
      };
      activeCheck = owner;
      activity = Object.freeze({ phase: "checking", startingView });
      publish();
      void Promise.resolve().then(() => execute(owner));
      return promise;
    },
    close(): RuntimeCompatibilityView {
      if (closed) return currentView;
      closed = true;
      const owner = activeCheck;
      activeCheck = null;
      if (owner !== null && !owner.settled) owner.settled = true;
      activity = idleActivity();
      connection = closedConnection(connection);
      currentView = projectView(connection, activity);
      if (owner !== null) owner.resolve(currentView);
      subscribers.clear();
      return currentView;
    }
  });

  return controller;
}

export function projectRuntimeCompatibility(
  snapshot: BrowserConnectionSnapshot
): RuntimeCompatibilityView {
  return projectView(readSnapshot(snapshot), idleActivity());
}

function projectView(
  snapshot: BrowserConnectionSnapshot,
  activity: CompatibilityActivity
): RuntimeCompatibilityView {
  if (snapshot.phase === "closed") return closedView();
  if (!mayRetainProtectedCompatibility(snapshot)) return hiddenView(snapshot);

  if (activity.phase === "checking") {
    return activityView(
      activity.startingView,
      "checking",
      "Checking Codex compatibility",
      "Reading current laptop status. No Codex process, package, HostDeck service, or network setting is being changed.",
      "muted",
      false,
      true
    );
  }
  if (activity.phase === "failed") {
    return activityView(
      activity.startingView,
      "check_failed",
      "Compatibility check not confirmed",
      "The previous status is unchanged. Inspect the laptop, then start one new compatibility check.",
      "danger",
      false,
      false
    );
  }
  if (activity.phase === "recovery_unconfirmed") {
    return activityView(
      activity.startingView,
      "recovery_unconfirmed",
      "Compatibility recovery not confirmed",
      "HostDeck did not receive a newer supported laptop record, so this check cannot confirm recovery.",
      "danger",
      true,
      false
    );
  }

  const hostCandidate = snapshot.host.data;
  if (hostCandidate === null) {
    const loading = snapshot.host.state === "idle" || snapshot.host.state === "loading";
    return unavailableView(snapshot, loading);
  }
  let compatibilityCandidate: unknown;
  try {
    compatibilityCandidate = Reflect.get(hostCandidate, "compatibility");
  } catch {
    throw new TypeError("HostDeck compatibility host status is invalid.");
  }
  const parsedCompatibility = selectedHostCompatibilityStatusSchema.safeParse(
    compatibilityCandidate
  );
  if (!parsedCompatibility.success) {
    throw new TypeError("HostDeck compatibility host status is invalid.");
  }
  const compatibility = parsedCompatibility.data;
  const browserCurrent =
    snapshot.access.state === "current" && snapshot.host.state === "current";
  const effectiveEvidence = effectiveEvidenceState(
    compatibility.evidence,
    browserCurrent
  );
  const effectiveCapability = browserCurrent
    ? compatibility.capability_state
    : "unverified";
  const current =
    browserCurrent &&
    compatibility.evidence === "current" &&
    (compatibility.state !== "supported" ||
      compatibility.capability_state === "verified");
  const presentation = compatibilityPresentation(
    compatibility.state,
    effectiveEvidence,
    browserCurrent,
    compatibility.observed_version,
    compatibility.supported_version
  );
  const actionAvailable = checkAuthorityKey(snapshot) !== null;
  const recovered = activity.phase === "recovered" && compatibility.state === "supported";

  return makeView({
    phase: compatibility.state,
    state: compatibility.state,
    evidence: effectiveEvidence,
    capabilityState: effectiveCapability,
    title: recovered ? "Codex compatibility restored" : presentation.title,
    detail: recovered
      ? "A newer current laptop check confirms the installed Codex runtime and required HostDeck controls."
      : presentation.detail,
    tone: presentation.tone,
    urgent: presentation.urgent,
    ownerLabel: "CODEX RUNTIME",
    sourceLabel: sourceLabel(effectiveEvidence, browserCurrent),
    observedVersion: compatibility.observed_version,
    supportedVersion: compatibility.supported_version,
    capabilityLabel: capabilityLabels[effectiveCapability],
    evidenceLabel: evidenceLabels[effectiveEvidence],
    checkedAt: compatibility.checked_at,
    recordedAt: compatibility.recorded_at,
    current,
    routeVisible: presentation.routeVisible,
    actionAvailable,
    busy: false
  });
}

function compatibilityPresentation(
  state: SelectedHostCompatibilityState,
  evidence: SelectedHostCompatibilityEvidenceState,
  browserCurrent: boolean,
  observedVersion: string | null,
  supportedVersion: string
): CompatibilityPresentation {
  if (!browserCurrent) {
    return stalePresentation(state, observedVersion, supportedVersion);
  }
  switch (state) {
    case "supported":
      return presentation(
        "Codex compatible",
        "Installed Codex matches HostDeck's supported runtime and required controls are verified.",
        "connected",
        false,
        false
      );
    case "version_drift":
      return presentation(
        "Codex update required",
        `This laptop has Codex ${requiredVersion(observedVersion)}. HostDeck supports ${supportedVersion}. Update Codex on the laptop, restart HostDeck, then check again.`,
        "danger",
        true,
        true
      );
    case "incompatible":
      return presentation(
        "Codex interface incompatible",
        "The installed Codex runtime does not provide all required HostDeck controls. Inspect or update Codex on the laptop, restart HostDeck, then check again.",
        "danger",
        true,
        true
      );
    case "degraded":
      return evidence === "current"
        ? presentation(
            "Codex compatibility limited",
            "The laptop check is current, but HostDeck controls remain limited while the runtime starts or restores saved state.",
            "attention",
            false,
            true
          )
        : presentation(
            "Codex compatibility is stale",
            "A previous compatibility check is retained, but current capability has not been verified.",
            "attention",
            false,
            true
          );
    case "unknown":
      return evidence === "unobserved"
        ? presentation(
            "Codex compatibility not checked",
            "HostDeck has no recorded Codex compatibility check. Check the laptop status before using controls.",
            "attention",
            false,
            true
          )
        : presentation(
            "Codex compatibility unknown",
            "A previous check is available, but current Codex compatibility has not been established.",
            "attention",
            false,
            true
          );
    case "disconnected":
      return presentation(
        "Codex runtime disconnected",
        "The last compatibility check is retained, but capabilities are unverified until the laptop runtime reconnects.",
        "attention",
        false,
        true
      );
  }
}

function stalePresentation(
  state: SelectedHostCompatibilityState,
  observedVersion: string | null,
  supportedVersion: string
): CompatibilityPresentation {
  switch (state) {
    case "version_drift":
      return presentation(
        "Codex update status is stale",
        `The last laptop check found Codex ${requiredVersion(observedVersion)} while HostDeck supports ${supportedVersion}, but that report is not current.`,
        "attention",
        false,
        true
      );
    case "incompatible":
      return presentation(
        "Codex incompatibility status is stale",
        "The last laptop check found incompatible controls, but that report is not current.",
        "attention",
        false,
        true
      );
    case "supported":
      return presentation(
        "Codex compatibility is stale",
        "The last laptop check was compatible, but current version and capability have not been verified.",
        "attention",
        false,
        true
      );
    case "degraded":
    case "unknown":
    case "disconnected":
      return presentation(
        "Codex compatibility is stale",
        "The last laptop compatibility report is retained, but it is not current. Check again before relying on it.",
        "attention",
        false,
        true
      );
  }
}

function activityView(
  base: RuntimeCompatibilityView,
  phase: Extract<
    RuntimeCompatibilityPhase,
    "checking" | "check_failed" | "recovery_unconfirmed"
  >,
  title: string,
  detail: string,
  tone: RuntimeCompatibilityTone,
  urgent: boolean,
  busy: boolean
): RuntimeCompatibilityView {
  const actionable = base.action !== null || busy;
  return Object.freeze({
    ...base,
    phase,
    title,
    detail,
    tone,
    urgent,
    ownerLabel: "BROWSER" as const,
    sourceLabel: busy ? "Read-only status check" : "Last status check",
    routeVisible: true,
    action: actionable ? "check_compatibility" as const : null,
    actionLabel: actionable ? "Check compatibility" as const : null,
    actionEnabled: base.action !== null && !busy,
    busy
  });
}

function hiddenView(snapshot: BrowserConnectionSnapshot): RuntimeCompatibilityView {
  const loading =
    snapshot.phase === "idle" ||
    snapshot.phase === "loading" ||
    snapshot.access.state === "idle" ||
    snapshot.access.state === "loading";
  return makeView({
    phase: loading ? "loading" : "hidden",
    state: null,
    evidence: null,
    capabilityState: null,
    title: loading ? "Checking Codex access" : "Codex compatibility unavailable",
    detail: loading
      ? "HostDeck is resolving whether this browser may read laptop compatibility status."
      : "Current session access is required before laptop compatibility status can be shown.",
    tone: "muted",
    urgent: false,
    ownerLabel: "HOSTDECK",
    sourceLabel: loading ? "Access check" : "Protected status hidden",
    observedVersion: null,
    supportedVersion: null,
    capabilityLabel: "Hidden",
    evidenceLabel: "Hidden",
    checkedAt: null,
    recordedAt: null,
    current: false,
    routeVisible: false,
    actionAvailable: false,
    busy: false
  });
}

function unavailableView(
  snapshot: BrowserConnectionSnapshot,
  loading: boolean
): RuntimeCompatibilityView {
  const actionAvailable = checkAuthorityKey(snapshot) !== null;
  return makeView({
    phase: loading ? "loading" : "unavailable",
    state: null,
    evidence: null,
    capabilityState: null,
    title: loading ? "Checking Codex compatibility" : "Codex compatibility unavailable",
    detail: loading
      ? "HostDeck is reading current laptop compatibility status."
      : "HostDeck could not read a current compatibility status. No runtime capability is assumed.",
    tone: loading ? "muted" : "danger",
    urgent: !loading,
    ownerLabel: "HOSTDECK",
    sourceLabel: loading ? "Laptop status check" : "Status unavailable",
    observedVersion: null,
    supportedVersion: null,
    capabilityLabel: "Unverified",
    evidenceLabel: "Unavailable",
    checkedAt: null,
    recordedAt: null,
    current: false,
    routeVisible: !loading,
    actionAvailable,
    busy: false
  });
}

function closedView(): RuntimeCompatibilityView {
  return makeView({
    phase: "closed",
    state: null,
    evidence: null,
    capabilityState: null,
    title: "Codex compatibility unavailable",
    detail: "Reopen HostDeck before checking laptop compatibility.",
    tone: "muted",
    urgent: false,
    ownerLabel: "BROWSER",
    sourceLabel: "Connection closed",
    observedVersion: null,
    supportedVersion: null,
    capabilityLabel: "Unavailable",
    evidenceLabel: "Unavailable",
    checkedAt: null,
    recordedAt: null,
    current: false,
    routeVisible: false,
    actionAvailable: false,
    busy: false
  });
}

function makeView(input: Readonly<{
  readonly phase: RuntimeCompatibilityPhase;
  readonly state: SelectedHostCompatibilityState | null;
  readonly evidence: SelectedHostCompatibilityEvidenceState | null;
  readonly capabilityState: SelectedHostCompatibilityCapabilityState | null;
  readonly title: string;
  readonly detail: string;
  readonly tone: RuntimeCompatibilityTone;
  readonly urgent: boolean;
  readonly ownerLabel: RuntimeCompatibilityView["ownerLabel"];
  readonly sourceLabel: string;
  readonly observedVersion: string | null;
  readonly supportedVersion: string | null;
  readonly capabilityLabel: string;
  readonly evidenceLabel: string;
  readonly checkedAt: string | null;
  readonly recordedAt: string | null;
  readonly current: boolean;
  readonly routeVisible: boolean;
  readonly actionAvailable: boolean;
  readonly busy: boolean;
}>): RuntimeCompatibilityView {
  const actionable = input.actionAvailable || input.busy;
  return Object.freeze({
    phase: input.phase,
    state: input.state,
    evidence: input.evidence,
    capabilityState: input.capabilityState,
    title: input.title,
    detail: input.detail,
    tone: input.tone,
    urgent: input.urgent,
    ownerLabel: input.ownerLabel,
    sourceLabel: input.sourceLabel,
    observedVersion: input.observedVersion,
    supportedVersion: input.supportedVersion,
    observedVersionLabel: input.observedVersion ?? "Not observed",
    supportedVersionLabel: input.supportedVersion ?? "Hidden",
    capabilityLabel: input.capabilityLabel,
    evidenceLabel: input.evidenceLabel,
    checkedAt: input.checkedAt,
    recordedAt: input.recordedAt,
    checkedLabel: formatCheckedLabel(input.checkedAt),
    current: input.current,
    routeVisible: input.routeVisible,
    action: actionable ? "check_compatibility" : null,
    actionLabel: actionable
      ? input.state === "supported" && input.current
        ? "Recheck compatibility"
        : "Check compatibility"
      : null,
    actionEnabled: input.actionAvailable && !input.busy,
    busy: input.busy
  });
}

function presentation(
  title: string,
  detail: string,
  tone: RuntimeCompatibilityTone,
  urgent: boolean,
  routeVisible: boolean
): CompatibilityPresentation {
  return Object.freeze({ title, detail, tone, urgent, routeVisible });
}

function effectiveEvidenceState(
  evidence: SelectedHostCompatibilityEvidenceState,
  browserCurrent: boolean
): SelectedHostCompatibilityEvidenceState {
  if (browserCurrent || evidence === "unobserved") return evidence;
  return "last_known";
}

function sourceLabel(
  evidence: SelectedHostCompatibilityEvidenceState,
  browserCurrent: boolean
): string {
  if (!browserCurrent) return "Last known browser data";
  if (evidence === "current") return "Current laptop check";
  if (evidence === "last_known") return "Last known laptop check";
  return "Not observed";
}

function requiredVersion(version: string | null): string {
  if (version === null) {
    throw new TypeError("HostDeck version drift is missing its observed version.");
  }
  return version;
}

function formatCheckedLabel(checkedAt: string | null): string {
  if (checkedAt === null) return "Not checked";
  const value = new Date(checkedAt);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("HostDeck compatibility check time is invalid.");
  }
  return `Checked ${value.toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  })}`;
}

function mayRetainProtectedCompatibility(snapshot: BrowserConnectionSnapshot): boolean {
  const access = snapshot.access.data;
  return (
    access?.can_read_sessions === true &&
    access.authentication_state !== "local_admin"
  );
}

function checkAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  if (
    snapshot.phase === "closed" ||
    snapshot.target === null ||
    snapshot.access.state !== "current"
  ) {
    return null;
  }
  return retainedAuthorityKey(snapshot);
}

function retainedAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  const access = snapshot.access.data;
  if (
    access === null ||
    !access.can_read_sessions ||
    access.authentication_state === "local_admin"
  ) {
    return null;
  }
  return JSON.stringify([
    access.authentication_state,
    access.device_id,
    access.permission,
    access.device_expires_at,
    access.configured_origin,
    access.network_mode,
    access.transport
  ]);
}

function targetKey(target: BrowserConnectionTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "mission_control"
    ? "mission_control"
    : `session_detail:${target.sessionId}`;
}

function retainedIdentityMatches(
  owner: ActiveCheck,
  snapshot: BrowserConnectionSnapshot
): boolean {
  return (
    snapshot.phase !== "closed" &&
    retainedAuthorityKey(snapshot) === owner.authorityKey &&
    targetKey(snapshot.target) === owner.targetKey
  );
}

function pendingIdentityMatches(
  owner: ActiveCheck,
  snapshot: BrowserConnectionSnapshot
): boolean {
  if (!retainedIdentityMatches(owner, snapshot)) return false;
  if (owner.dispatchEpoch === null) return snapshot.epoch === owner.startEpoch;
  return snapshot.epoch === owner.dispatchEpoch;
}

function checkIdentityMatches(
  owner: ActiveCheck,
  snapshot: BrowserConnectionSnapshot
): boolean {
  return (
    pendingIdentityMatches(owner, snapshot) &&
    snapshot.access.state === "current"
  );
}

function recoveryRequiresNewRevision(view: RuntimeCompatibilityView): boolean {
  return view.state !== null && view.state !== "supported";
}

function isNewerSupportedRevision(
  starting: RuntimeCompatibilityView,
  result: RuntimeCompatibilityView
): boolean {
  if (
    result.state !== "supported" ||
    !result.current ||
    result.evidence !== "current" ||
    result.capabilityState !== "verified" ||
    result.recordedAt === null
  ) {
    return false;
  }
  if (starting.recordedAt === null) return true;
  return Date.parse(result.recordedAt) > Date.parse(starting.recordedAt);
}

function settledActivity(
  phase: "failed" | "recovery_unconfirmed" | "recovered",
  owner: ActiveCheck
): CompatibilityActivity {
  return Object.freeze({
    phase,
    authorityKey: owner.authorityKey,
    targetKey: owner.targetKey,
    settledEpoch: owner.dispatchEpoch ?? owner.startEpoch,
    startingView: owner.startingView
  });
}

function idleActivity(): CompatibilityActivity {
  return Object.freeze({ phase: "idle" });
}

function closedConnection(
  snapshot: BrowserConnectionSnapshot
): BrowserConnectionSnapshot {
  return Object.freeze({ ...snapshot, phase: "closed" as const });
}

function sameView(
  left: RuntimeCompatibilityView,
  right: RuntimeCompatibilityView
): boolean {
  return (
    left.phase === right.phase &&
    left.state === right.state &&
    left.evidence === right.evidence &&
    left.capabilityState === right.capabilityState &&
    left.title === right.title &&
    left.detail === right.detail &&
    left.tone === right.tone &&
    left.urgent === right.urgent &&
    left.ownerLabel === right.ownerLabel &&
    left.sourceLabel === right.sourceLabel &&
    left.observedVersion === right.observedVersion &&
    left.supportedVersion === right.supportedVersion &&
    left.observedVersionLabel === right.observedVersionLabel &&
    left.supportedVersionLabel === right.supportedVersionLabel &&
    left.capabilityLabel === right.capabilityLabel &&
    left.evidenceLabel === right.evidenceLabel &&
    left.checkedAt === right.checkedAt &&
    left.recordedAt === right.recordedAt &&
    left.checkedLabel === right.checkedLabel &&
    left.current === right.current &&
    left.routeVisible === right.routeVisible &&
    left.action === right.action &&
    left.actionLabel === right.actionLabel &&
    left.actionEnabled === right.actionEnabled &&
    left.busy === right.busy
  );
}

function readOptions(input: unknown): RuntimeCompatibilityPort {
  const options = readExactRecord(input, optionKeys, optionKeys);
  const portCandidate = options?.port;
  const port = readExactRecord(portCandidate, portKeys, portKeys);
  if (
    port === null ||
    typeof port.snapshot !== "function" ||
    typeof port.refresh !== "function"
  ) {
    throw new TypeError("HostDeck compatibility options are invalid.");
  }
  const source = portCandidate as object;
  return Object.freeze({
    snapshot: () =>
      Reflect.apply(port.snapshot as () => unknown, source, []) as BrowserConnectionSnapshot,
    refresh: () =>
      Reflect.apply(port.refresh as () => unknown, source, []) as Promise<BrowserConnectionSnapshot>
  });
}

function readPortSnapshot(port: RuntimeCompatibilityPort): BrowserConnectionSnapshot {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(port.snapshot, undefined, []);
  } catch {
    throw new TypeError("HostDeck compatibility snapshot is invalid.");
  }
  return readSnapshot(candidate);
}

function readSnapshot(candidate: unknown): BrowserConnectionSnapshot {
  if (candidate === null || typeof candidate !== "object" || !Object.isFrozen(candidate)) {
    throw new TypeError("HostDeck compatibility snapshot is invalid.");
  }
  return candidate as BrowserConnectionSnapshot;
}

function callRefresh(port: RuntimeCompatibilityPort): Promise<unknown> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(port.refresh, undefined, []);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!isPromiseLike(candidate)) {
    return Promise.reject(
      new TypeError("HostDeck compatibility refresh did not return a promise.")
    );
  }
  return Promise.resolve(candidate as PromiseLike<unknown>);
}

function observeSuppressedPromise(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

function isPromiseLike(candidate: unknown): candidate is PromiseLike<unknown> {
  if (
    (typeof candidate !== "object" || candidate === null) &&
    typeof candidate !== "function"
  ) {
    return false;
  }
  try {
    return typeof Reflect.get(candidate as object, "then") === "function";
  } catch {
    return false;
  }
}

function readExactRecord(
  candidate: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): Record<string, unknown> | null {
  if (candidate === null || typeof candidate !== "object") return null;
  let keys: string[];
  try {
    keys = Object.keys(candidate);
  } catch {
    return null;
  }
  if (
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowedKeys.includes(key))
  ) {
    return null;
  }
  const values: Record<string, unknown> = {};
  try {
    for (const key of keys) values[key] = Reflect.get(candidate, key);
  } catch {
    return null;
  }
  return values;
}
