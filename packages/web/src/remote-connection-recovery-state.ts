import {
  remoteIngressPublicStateSchema,
  type SelectedHostRemoteStatus
} from "@hostdeck/contracts";
import type {
  BrowserConnectionRemoteStatusOptions,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import type { BrowserHttpRouteResponse } from "./http-client.js";

export const remoteConnectionRecoverySources = Object.freeze([
  "current_laptop_observation",
  "last_laptop_observation",
  "browser_connection",
  "not_observed"
] as const);

export type RemoteConnectionRecoverySource =
  (typeof remoteConnectionRecoverySources)[number];

export type RemoteConnectionRecoveryTone =
  | "connected"
  | "attention"
  | "danger"
  | "muted";

export type RemoteConnectionRecoveryPhase =
  | Exclude<SelectedHostRemoteStatus["cause"], null | "not_observed">
  | "not_observed"
  | "checking"
  | "ready"
  | "last_known"
  | "browser_reconnecting"
  | "browser_unreachable"
  | "check_failed"
  | "access_limited"
  | "closed";

export interface RemoteConnectionRecoveryView {
  readonly phase: RemoteConnectionRecoveryPhase;
  readonly reason: SelectedHostRemoteStatus["cause"];
  readonly source: RemoteConnectionRecoverySource;
  readonly ownerLabel: string;
  readonly sourceLabel: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: RemoteConnectionRecoveryTone;
  readonly urgent: boolean;
  readonly current: boolean;
  readonly laptopActionRequired: boolean;
  readonly externalOrigin: string | null;
  readonly action: "check_remote" | null;
  readonly actionLabel: "Check remote access" | "Check again" | null;
  readonly actionEnabled: boolean;
  readonly busy: boolean;
}

export interface RemoteConnectionRecoveryPort {
  readonly snapshot: () => BrowserConnectionSnapshot;
  readonly requestRemoteStatus: BrowserConnectionStateCoordinator["requestRemoteStatus"];
  readonly refresh: BrowserConnectionStateCoordinator["refresh"];
}

export interface CreateRemoteConnectionRecoveryControllerOptions {
  readonly port: RemoteConnectionRecoveryPort;
}

export interface RemoteConnectionRecoveryController {
  readonly snapshot: () => RemoteConnectionRecoveryView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly synchronize: () => RemoteConnectionRecoveryView;
  readonly check: () => Promise<RemoteConnectionRecoveryView>;
  readonly close: () => RemoteConnectionRecoveryView;
}

type RecoveryActivity =
  | Readonly<{ readonly phase: "idle" }>
  | Readonly<{
      readonly phase: "checking";
      readonly authorityKey: string;
      readonly startEpoch: number;
    }>
  | Readonly<{
      readonly phase: "failed";
      readonly authorityKey: string;
      readonly startEpoch: number;
    }>;

interface ActiveCheck {
  readonly authorityKey: string;
  readonly startEpoch: number;
  readonly controller: AbortController;
  readonly promise: Promise<RemoteConnectionRecoveryView>;
  readonly resolve: (view: RemoteConnectionRecoveryView) => void;
  settled: boolean;
}

interface ReasonPresentation {
  readonly title: string;
  readonly detail: string;
  readonly tone: RemoteConnectionRecoveryTone;
  readonly urgent: boolean;
}

const optionKeys = ["port"] as const;
const portKeys = ["snapshot", "requestRemoteStatus", "refresh"] as const;
const maximumSubscribers = 32;

export function createRemoteConnectionRecoveryController(
  input: CreateRemoteConnectionRecoveryControllerOptions
): RemoteConnectionRecoveryController {
  const port = readOptions(input);
  let connection = readPortSnapshot(port);
  let activity: RecoveryActivity = idleActivity();
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

  const publish = (): RemoteConnectionRecoveryView => {
    const next = projectView(connection, activity);
    if (sameView(currentView, next)) return currentView;
    currentView = next;
    notify();
    return currentView;
  };

  const finish = (
    owner: ActiveCheck,
    nextActivity: RecoveryActivity
  ): RemoteConnectionRecoveryView => {
    if (activeCheck !== owner || owner.settled) return currentView;
    owner.settled = true;
    activeCheck = null;
    activity = nextActivity;
    const view = publish();
    owner.resolve(view);
    return view;
  };

  const suppress = (owner: ActiveCheck): RemoteConnectionRecoveryView =>
    finish(owner, idleActivity());

  const installConnection = (owner: ActiveCheck): boolean => {
    connection = readPortSnapshot(port);
    if (!checkIdentityMatches(owner, connection)) {
      suppress(owner);
      return false;
    }
    publish();
    return true;
  };

  const fail = (owner: ActiveCheck): void => {
    if (activeCheck !== owner || owner.settled) return;
    try {
      connection = readPortSnapshot(port);
    } catch {
      finish(owner, failedActivity(owner));
      return;
    }
    if (!checkIdentityMatches(owner, connection)) {
      suppress(owner);
      return;
    }
    finish(owner, failedActivity(owner));
  };

  const execute = async (owner: ActiveCheck): Promise<void> => {
    if (closed || activeCheck !== owner || owner.settled) return;
    try {
      if (!installConnection(owner)) return;
      const access = connection.access.data;
      if (access === null) {
        suppress(owner);
        return;
      }
      if (access.network_mode === "remote") {
        const pendingStatus = callRemoteStatus(port, owner.controller.signal);
        if (!installConnection(owner)) {
          observeSuppressedPromise(pendingStatus);
          return;
        }
        const response = await pendingStatus;
        if (!isRemoteStatusResponse(response)) {
          throw new TypeError("HostDeck remote status response is invalid.");
        }
        if (activeCheck !== owner || owner.settled || !installConnection(owner)) return;
      }

      const pendingRefresh = callRefresh(port);
      if (!installConnection(owner)) {
        observeSuppressedPromise(pendingRefresh);
        return;
      }
      await pendingRefresh;
      if (activeCheck !== owner || owner.settled || !installConnection(owner)) return;
      if (!hasCurrentRemoteStatus(connection)) {
        fail(owner);
        return;
      }
      finish(owner, idleActivity());
    } catch {
      fail(owner);
    }
  };

  const controller: RemoteConnectionRecoveryController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck remote recovery listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck remote recovery listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    synchronize(): RemoteConnectionRecoveryView {
      if (closed) return currentView;
      const next = readPortSnapshot(port);
      connection = next;
      const owner = activeCheck;
      if (owner !== null && !checkIdentityMatches(owner, next)) {
        safeAbort(owner.controller);
        return suppress(owner);
      }
      if (activity.phase === "failed") {
        const nextAuthority = remoteAuthorityKey(next);
        if (
          nextAuthority !== activity.authorityKey ||
          (next.epoch > activity.startEpoch && hasCurrentRemoteStatus(next))
        ) {
          activity = idleActivity();
        }
      }
      return publish();
    },
    check(): Promise<RemoteConnectionRecoveryView> {
      if (closed) return Promise.resolve(currentView);
      if (activeCheck !== null) return activeCheck.promise;
      connection = readPortSnapshot(port);
      const authorityKey = remoteCheckAuthorityKey(connection);
      if (authorityKey === null) {
        activity = idleActivity();
        return Promise.resolve(publish());
      }

      let resolve!: (view: RemoteConnectionRecoveryView) => void;
      const promise = new Promise<RemoteConnectionRecoveryView>((innerResolve) => {
        resolve = innerResolve;
      });
      const owner: ActiveCheck = {
        authorityKey,
        startEpoch: connection.epoch,
        controller: new AbortController(),
        promise,
        resolve,
        settled: false
      };
      activeCheck = owner;
      activity = Object.freeze({
        phase: "checking",
        authorityKey,
        startEpoch: connection.epoch
      });
      publish();
      void Promise.resolve().then(() => execute(owner));
      return promise;
    },
    close(): RemoteConnectionRecoveryView {
      if (closed) return currentView;
      closed = true;
      const owner = activeCheck;
      activeCheck = null;
      if (owner !== null && !owner.settled) {
        owner.settled = true;
        safeAbort(owner.controller);
      }
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

export function projectRemoteConnectionRecovery(
  snapshot: BrowserConnectionSnapshot
): RemoteConnectionRecoveryView {
  return projectView(readSnapshot(snapshot), idleActivity());
}

function projectView(
  snapshot: BrowserConnectionSnapshot,
  activity: RecoveryActivity
): RemoteConnectionRecoveryView {
  const access = snapshot.access.data;
  const retainedRemote = access?.network_mode === "remote";
  const actionAvailable = remoteCheckAuthorityKey(snapshot) !== null;

  if (snapshot.phase === "closed") {
    return view({
      phase: "closed",
      reason: null,
      source: "browser_connection",
      ownerLabel: "BROWSER",
      sourceLabel: "Connection closed",
      title: "Remote status unavailable",
      detail: "Reopen HostDeck before checking remote access.",
      tone: "muted",
      urgent: false,
      current: false,
      laptopActionRequired: false,
      externalOrigin: null,
      actionAvailable: false,
      busy: false
    });
  }

  if (
    retainedRemote &&
    (snapshot.phase === "unreachable" ||
      snapshot.phase === "remote_unavailable" ||
      snapshot.access.state === "failed")
  ) {
    return view({
      phase: "browser_unreachable",
      reason: null,
      source: "browser_connection",
      ownerLabel: "BROWSER",
      sourceLabel: "Current browser connection",
      title: "Private address unreachable",
      detail: "Check this phone's Tailscale connection and the laptop locally, then try the private address again.",
      tone: "danger",
      urgent: true,
      current: true,
      laptopActionRequired: true,
      externalOrigin: null,
      actionAvailable: false,
      busy: false
    });
  }

  if (retainedRemote && snapshot.access.state === "stale") {
    return view({
      phase: "browser_reconnecting",
      reason: null,
      source: "browser_connection",
      ownerLabel: "BROWSER",
      sourceLabel: "Connection not current",
      title: "Private connection is reconnecting",
      detail: "Current laptop remote status will appear after this private connection is verified again.",
      tone: "attention",
      urgent: false,
      current: true,
      laptopActionRequired: false,
      externalOrigin: null,
      actionAvailable: false,
      busy: false
    });
  }

  if (activity.phase === "checking") {
    return view({
      phase: "checking",
      reason: null,
      source: "browser_connection",
      ownerLabel: "BROWSER",
      sourceLabel: "Read-only status check",
      title: "Checking remote access",
      detail: "Reading current laptop status. No Tailscale profile or private mapping is being changed.",
      tone: "muted",
      urgent: false,
      current: false,
      laptopActionRequired: false,
      externalOrigin: null,
      actionAvailable: true,
      busy: true
    });
  }

  if (activity.phase === "failed") {
    return view({
      phase: "check_failed",
      reason: null,
      source: "browser_connection",
      ownerLabel: "BROWSER",
      sourceLabel: "Last status check",
      title: "Remote check not confirmed",
      detail: "No setting was changed. Check the laptop connection, then start one new status check.",
      tone: "danger",
      urgent: false,
      current: false,
      laptopActionRequired: true,
      externalOrigin: null,
      actionAvailable,
      busy: false
    });
  }

  if (access === null || !access.can_read_sessions) {
    return view({
      phase: "access_limited",
      reason: null,
      source: "not_observed",
      ownerLabel: "HOSTDECK",
      sourceLabel: "Remote status hidden",
      title: "Remote status unavailable",
      detail: "Current session access is required before laptop remote status can be shown.",
      tone: "muted",
      urgent: false,
      current: false,
      laptopActionRequired: false,
      externalOrigin: null,
      actionAvailable: false,
      busy: false
    });
  }

  if (retainedRemote && snapshot.access.state === "loading") {
    return view({
      phase: "browser_reconnecting",
      reason: null,
      source: "browser_connection",
      ownerLabel: "BROWSER",
      sourceLabel: "Connection update",
      title: "Refreshing private connection",
      detail: "Current laptop remote status will appear after this connection is verified.",
      tone: "attention",
      urgent: false,
      current: false,
      laptopActionRequired: false,
      externalOrigin: null,
      actionAvailable: false,
      busy: false
    });
  }

  const host = snapshot.host.data;
  if (host === null) {
    return notObservedView(actionAvailable);
  }
  if (snapshot.host.state !== "current") {
    const last = lastKnownSummary(host.remote);
    return view({
      phase: "last_known",
      reason: host.remote.cause,
      source: "last_laptop_observation",
      ownerLabel: "LAST LAPTOP STATUS",
      sourceLabel: "Not current",
      title: "Remote status is stale",
      detail: `${last} Check again before relying on it.`,
      tone: "attention",
      urgent: false,
      current: false,
      laptopActionRequired: host.remote.laptop_action_required,
      externalOrigin: null,
      actionAvailable,
      busy: false
    });
  }

  const remote = host.remote;
  if (remote.availability === "unknown") {
    return notObservedView(actionAvailable);
  }
  if (remote.availability === "ready") {
    if (
      remote.state_generation === null ||
      remote.external_origin === null ||
      remote.cause !== null ||
      remote.laptop_action_required ||
      (access.network_mode === "remote" &&
        access.configured_origin !== remote.external_origin)
    ) {
      throw new TypeError("HostDeck remote ready status is contradictory.");
    }
    return view({
      phase: "ready",
      reason: null,
      source: "current_laptop_observation",
      ownerLabel: "PRIVATE CONNECTION",
      sourceLabel: "Current laptop status",
      title: "Remote access ready",
      detail: "The saved HostDeck profile and exact private HTTPS mapping are current.",
      tone: "connected",
      urgent: false,
      current: true,
      laptopActionRequired: false,
      externalOrigin: remote.external_origin,
      actionAvailable,
      busy: false
    });
  }
  if (remote.cause === null || remote.cause === "not_observed") {
    throw new TypeError("HostDeck non-ready remote status is missing its cause.");
  }
  const presentation = reasonPresentation(remote.cause);
  return view({
    phase: remote.cause,
    reason: remote.cause,
    source: "current_laptop_observation",
    ownerLabel: "LOCAL LAPTOP",
    sourceLabel: "Current laptop status",
    ...presentation,
    current: true,
    laptopActionRequired: remote.laptop_action_required,
    externalOrigin: null,
    actionAvailable,
    busy: false
  });
}

function reasonPresentation(
  reason: Exclude<SelectedHostRemoteStatus["cause"], null | "not_observed">
): ReasonPresentation {
  switch (reason) {
    case "remote_disabled":
      return attention(
        "Remote access disabled",
        "Enable remote access explicitly from this laptop when you are ready."
      );
    case "cleanup_incomplete":
      return danger(
        "Remote cleanup incomplete",
        "Remote admission is closed, but removal of the prior private mapping was not confirmed. Inspect it locally before enabling again."
      );
    case "client_not_installed":
      return danger(
        "Tailscale is not installed",
        "Install a supported Tailscale client on this laptop, then check HostDeck again."
      );
    case "client_unsupported":
      return danger(
        "Tailscale client unsupported",
        "Update or install the supported laptop Tailscale client before checking remote access."
      );
    case "client_error":
      return danger(
        "Tailscale status unavailable",
        "Inspect the Tailscale client on this laptop, then start a new HostDeck check."
      );
    case "client_stopped":
      return danger(
        "Tailscale is stopped",
        "Start Tailscale on this laptop, then check HostDeck again."
      );
    case "client_signed_out":
      return danger(
        "Tailscale is signed out",
        "Sign in locally to the saved HostDeck profile, then check HostDeck again."
      );
    case "profile_absent":
      return attention(
        "HostDeck profile unavailable",
        "Restore or select the saved HostDeck Tailscale profile on this laptop. HostDeck made no profile change."
      );
    case "profile_other":
      return attention(
        "HostDeck profile is not active",
        "Switch to the saved HostDeck profile in Tailscale on this laptop. HostDeck never switches profiles automatically."
      );
    case "profile_unknown":
      return danger(
        "Tailscale profile not verified",
        "Inspect the saved HostDeck profile locally. HostDeck made no profile change."
      );
    case "serve_absent":
      return attention(
        "Private HTTPS mapping missing",
        "After selecting the saved HostDeck profile, enable remote access explicitly from this laptop."
      );
    case "serve_foreign":
      return danger(
        "Private HTTPS path has another owner",
        "Inspect the existing laptop mapping. HostDeck did not overwrite or remove it."
      );
    case "serve_colliding":
      return danger(
        "Private HTTPS mapping conflict",
        "Resolve the conflicting laptop mapping before enabling HostDeck remote access locally. No changes were made."
      );
    case "serve_drifted":
      return danger(
        "Private HTTPS mapping changed",
        "Inspect the changed laptop mapping, then enable HostDeck remote access locally only after it is safe."
      );
    case "serve_public":
      return danger(
        "Public exposure conflicts with HostDeck",
        "Remove the public or Funnel configuration locally before enabling private HostDeck access. No changes were made."
      );
    case "external_origin_invalid":
      return danger(
        "Private HostDeck address invalid",
        "Inspect the laptop's private Tailscale HTTPS configuration before trying again."
      );
    case "observation_stale":
      return attention(
        "Remote status is stale",
        "Start one new check before relying on the previous laptop observation."
      );
    case "observation_failed":
      return danger(
        "Remote status check failed",
        "Inspect Tailscale on the laptop, then start one new HostDeck check."
      );
    case "consent_required":
      return attention(
        "Tailscale approval required",
        "Complete the required approval locally, then explicitly enable remote access again."
      );
    case "permission_denied":
      return danger(
        "Laptop permission denied",
        "Resolve local Tailscale permissions before explicitly enabling remote access again."
      );
    case "command_failed":
      return danger(
        "Remote setup command failed",
        "Inspect HostDeck remote access locally. No automatic retry or repair was attempted."
      );
    case "command_timeout":
      return danger(
        "Remote setup timed out",
        "Inspect the laptop state before starting one new local action."
      );
    case "output_oversized":
      return danger(
        "Tailscale response exceeded the safety limit",
        "Inspect and update the laptop Tailscale client before checking again."
      );
    case "schema_invalid":
      return danger(
        "Tailscale status format unsupported",
        "Update the supported laptop Tailscale client before checking again."
      );
    case "profile_changed":
      return attention(
        "Tailscale profile changed during the check",
        "Finish selecting the saved HostDeck profile locally, then start one new check."
      );
  }
}

function notObservedView(actionAvailable: boolean): RemoteConnectionRecoveryView {
  return view({
    phase: "not_observed",
    reason: "not_observed",
    source: "not_observed",
    ownerLabel: "LOCAL LAPTOP",
    sourceLabel: "Not observed",
    title: "Remote status not checked",
    detail: "Check current laptop remote status without changing Tailscale or private mappings.",
    tone: "muted",
    urgent: false,
    current: false,
    laptopActionRequired: true,
    externalOrigin: null,
    actionAvailable,
    busy: false
  });
}

function lastKnownSummary(remote: SelectedHostRemoteStatus): string {
  if (remote.availability === "ready") return "The last laptop report was remote ready.";
  if (remote.availability === "unknown" || remote.cause === "not_observed") {
    return "No current laptop remote report is available.";
  }
  if (remote.cause === null) {
    throw new TypeError("HostDeck last-known remote status is contradictory.");
  }
  return `Last laptop report: ${reasonPresentation(remote.cause).title}.`;
}

function attention(title: string, detail: string): ReasonPresentation {
  return Object.freeze({ title, detail, tone: "attention", urgent: false });
}

function danger(title: string, detail: string): ReasonPresentation {
  return Object.freeze({ title, detail, tone: "danger", urgent: false });
}

function view(input: Readonly<{
  readonly phase: RemoteConnectionRecoveryPhase;
  readonly reason: SelectedHostRemoteStatus["cause"];
  readonly source: RemoteConnectionRecoverySource;
  readonly ownerLabel: string;
  readonly sourceLabel: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: RemoteConnectionRecoveryTone;
  readonly urgent: boolean;
  readonly current: boolean;
  readonly laptopActionRequired: boolean;
  readonly externalOrigin: string | null;
  readonly actionAvailable: boolean;
  readonly busy: boolean;
}>): RemoteConnectionRecoveryView {
  const actionable = input.actionAvailable || input.busy;
  return Object.freeze({
    phase: input.phase,
    reason: input.reason,
    source: input.source,
    ownerLabel: input.ownerLabel,
    sourceLabel: input.sourceLabel,
    title: input.title,
    detail: input.detail,
    tone: input.tone,
    urgent: input.urgent,
    current: input.current,
    laptopActionRequired: input.laptopActionRequired,
    externalOrigin: input.externalOrigin,
    action: actionable ? "check_remote" : null,
    actionLabel: actionable
      ? input.phase === "ready"
        ? "Check again"
        : "Check remote access"
      : null,
    actionEnabled: input.actionAvailable && !input.busy,
    busy: input.busy
  });
}

function hasCurrentRemoteStatus(snapshot: BrowserConnectionSnapshot): boolean {
  return (
    snapshot.access.state === "current" &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.host.state === "current" &&
    snapshot.host.data !== null
  );
}

function remoteCheckAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  if (
    snapshot.target === null ||
    snapshot.access.state !== "current" ||
    snapshot.access.data === null ||
    !snapshot.access.data.can_read_sessions
  ) {
    return null;
  }
  if (
    snapshot.access.data.network_mode === "remote" &&
    snapshot.access.data.authentication_state !== "paired_device"
  ) {
    return null;
  }
  return remoteAuthorityKey(snapshot);
}

function remoteAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  const access = snapshot.access.data;
  if (access === null || !access.can_read_sessions) return null;
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

function checkIdentityMatches(
  owner: ActiveCheck,
  snapshot: BrowserConnectionSnapshot
): boolean {
  return snapshot.phase !== "closed" && remoteAuthorityKey(snapshot) === owner.authorityKey;
}

function failedActivity(owner: ActiveCheck): RecoveryActivity {
  return Object.freeze({
    phase: "failed",
    authorityKey: owner.authorityKey,
    startEpoch: owner.startEpoch
  });
}

function idleActivity(): RecoveryActivity {
  return Object.freeze({ phase: "idle" });
}

function sameView(
  left: RemoteConnectionRecoveryView,
  right: RemoteConnectionRecoveryView
): boolean {
  return (
    left.phase === right.phase &&
    left.reason === right.reason &&
    left.source === right.source &&
    left.ownerLabel === right.ownerLabel &&
    left.sourceLabel === right.sourceLabel &&
    left.title === right.title &&
    left.detail === right.detail &&
    left.tone === right.tone &&
    left.urgent === right.urgent &&
    left.current === right.current &&
    left.laptopActionRequired === right.laptopActionRequired &&
    left.externalOrigin === right.externalOrigin &&
    left.action === right.action &&
    left.actionLabel === right.actionLabel &&
    left.actionEnabled === right.actionEnabled &&
    left.busy === right.busy
  );
}

function readOptions(
  input: unknown
): RemoteConnectionRecoveryPort {
  const values = readExactRecord(input, optionKeys, optionKeys);
  const port = values?.port;
  const portValues = readExactRecord(port, portKeys, portKeys);
  if (
    portValues === null ||
    typeof portValues.snapshot !== "function" ||
    typeof portValues.requestRemoteStatus !== "function" ||
    typeof portValues.refresh !== "function"
  ) {
    throw new TypeError("HostDeck remote recovery options are invalid.");
  }
  const source = port as object;
  return Object.freeze({
    snapshot: () => Reflect.apply(portValues.snapshot as () => unknown, source, []) as BrowserConnectionSnapshot,
    requestRemoteStatus: (options?: BrowserConnectionRemoteStatusOptions) =>
      Reflect.apply(
        portValues.requestRemoteStatus as (...args: unknown[]) => unknown,
        source,
        options === undefined ? [] : [options]
      ) as Promise<BrowserHttpRouteResponse<"remote_status">>,
    refresh: () =>
      Reflect.apply(portValues.refresh as () => unknown, source, []) as Promise<BrowserConnectionSnapshot>
  });
}

function readPortSnapshot(port: RemoteConnectionRecoveryPort): BrowserConnectionSnapshot {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(port.snapshot, undefined, []);
  } catch {
    throw new TypeError("HostDeck remote recovery snapshot is invalid.");
  }
  return readSnapshot(candidate);
}

function readSnapshot(candidate: unknown): BrowserConnectionSnapshot {
  if (candidate === null || typeof candidate !== "object" || !Object.isFrozen(candidate)) {
    throw new TypeError("HostDeck remote recovery snapshot is invalid.");
  }
  return candidate as BrowserConnectionSnapshot;
}

function callRemoteStatus(
  port: RemoteConnectionRecoveryPort,
  signal: AbortSignal
): Promise<unknown> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(port.requestRemoteStatus, undefined, [{ signal }]);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!isPromiseLike(candidate)) {
    return Promise.reject(new TypeError("HostDeck remote status port did not return a promise."));
  }
  return Promise.resolve(candidate as PromiseLike<unknown>);
}

function isRemoteStatusResponse(candidate: unknown): boolean {
  const values = readExactRecord(candidate, ["status", "data"], ["status", "data"]);
  return (
    values !== null &&
    values.status === 200 &&
    remoteIngressPublicStateSchema.safeParse(values.data).success
  );
}

function callRefresh(
  port: RemoteConnectionRecoveryPort
): Promise<BrowserConnectionSnapshot> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(port.refresh, undefined, []);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!isPromiseLike(candidate)) {
    return Promise.reject(new TypeError("HostDeck remote refresh port did not return a promise."));
  }
  return Promise.resolve(candidate as PromiseLike<BrowserConnectionSnapshot>);
}

function observeSuppressedPromise(candidate: PromiseLike<unknown>): void {
  void Promise.resolve(candidate).catch(() => undefined);
}

function isPromiseLike(candidate: unknown): candidate is PromiseLike<unknown> {
  if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) {
    return false;
  }
  try {
    return typeof (candidate as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

function safeAbort(controller: AbortController): void {
  try {
    controller.abort();
  } catch {
    // A hostile realm must not block controller cleanup.
  }
}

function closedConnection(snapshot: BrowserConnectionSnapshot): BrowserConnectionSnapshot {
  if (snapshot.phase === "closed") return snapshot;
  return Object.freeze({ ...snapshot, phase: "closed" as const });
}

function readExactRecord<Allowed extends string>(
  candidate: unknown,
  requiredKeys: readonly Allowed[],
  allowedKeys: readonly Allowed[]
): Record<Allowed, unknown> | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(candidate);
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key as Allowed))) {
      return null;
    }
    if (requiredKeys.some((key) => !Object.hasOwn(candidate, key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const result = Object.create(null) as Record<Allowed, unknown>;
    for (const key of keys as Allowed[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}
