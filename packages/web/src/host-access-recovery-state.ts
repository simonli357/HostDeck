import type { SelectedAccessStateResponse } from "@hostdeck/contracts";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionTarget
} from "./connection-state.js";

export const hostAccessRecoveryPhases = Object.freeze([
  "checking",
  "automatic_bootstrap",
  "ready",
  "setup_required",
  "bootstrap_failed",
  "stale",
  "checking_access",
  "securing_page",
  "recovered",
  "refresh_failed",
  "read_only",
  "pairing_required",
  "unavailable",
  "closed"
] as const);

export type HostAccessRecoveryPhase = (typeof hostAccessRecoveryPhases)[number];
export type HostAccessRecoveryTone = "connected" | "attention" | "danger" | "muted";
export type HostAccessRecoveryAction =
  | "secure_page"
  | "retry_setup"
  | "check_access";

export interface HostAccessRecoveryView {
  readonly phase: HostAccessRecoveryPhase;
  readonly tone: HostAccessRecoveryTone;
  readonly pageSecurity: "Checking" | "Securing" | "Ready" | "Check required" | "Unavailable";
  readonly pageSecurityDetail: string;
  readonly status: string;
  readonly detail: string;
  readonly action: HostAccessRecoveryAction | null;
  readonly actionLabel: string | null;
  readonly actionEnabled: boolean;
  readonly busy: boolean;
  readonly urgent: boolean;
}

export interface HostAccessRecoveryPort {
  readonly snapshot: () => BrowserConnectionSnapshot;
  readonly refresh: () => Promise<BrowserConnectionSnapshot>;
  readonly bootstrapCsrf: () => Promise<BrowserConnectionSnapshot>;
}

export interface CreateHostAccessRecoveryControllerOptions {
  readonly port: HostAccessRecoveryPort;
}

export interface HostAccessRecoveryController {
  readonly snapshot: () => HostAccessRecoveryView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly synchronize: () => HostAccessRecoveryView;
  readonly recover: () => Promise<HostAccessRecoveryView>;
  readonly close: () => HostAccessRecoveryView;
}

type RecoveryOperation =
  | Readonly<{ readonly phase: "idle" }>
  | Readonly<{
      readonly phase: "busy";
      readonly stage: "refresh" | "bootstrap";
      readonly action: HostAccessRecoveryAction;
    }>
  | Readonly<{
      readonly phase: "recovered";
      readonly targetKey: string;
      readonly writerKey: string;
      readonly epoch: number;
    }>
  | Readonly<{
      readonly phase: "failed";
      readonly source: "refresh" | "bootstrap";
    }>;

interface RecoveryAttempt {
  readonly action: HostAccessRecoveryAction;
  readonly targetKey: string;
  readonly writerKey: string;
  readonly startEpoch: number;
  stage: "refresh" | "bootstrap";
  ownedEpoch: number | null;
  readonly promise: Promise<HostAccessRecoveryView>;
  readonly resolve: (view: HostAccessRecoveryView) => void;
  settled: boolean;
}

const createOptionKeys = ["port"] as const;
const portKeys = ["snapshot", "refresh", "bootstrapCsrf"] as const;
const maximumSubscribers = 32;

export function createHostAccessRecoveryController(
  input: CreateHostAccessRecoveryControllerOptions
): HostAccessRecoveryController {
  const port = readOptions(input);
  let connection = readPortSnapshot(port);
  let operation: RecoveryOperation = idleOperation();
  let closed = false;
  let activeAttempt: RecoveryAttempt | null = null;
  const subscribers = new Set<() => void>();
  let currentView = projectRecovery(connection, operation);

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

  const publish = (): HostAccessRecoveryView => {
    const next = projectRecovery(connection, operation);
    if (sameRecoveryView(currentView, next)) return currentView;
    currentView = next;
    notify();
    return currentView;
  };

  const finishAttempt = (
    owner: RecoveryAttempt,
    nextOperation: RecoveryOperation
  ): HostAccessRecoveryView => {
    if (activeAttempt !== owner || owner.settled) return currentView;
    activeAttempt = null;
    owner.settled = true;
    operation = nextOperation;
    const view = publish();
    owner.resolve(view);
    return view;
  };

  const suppressAttempt = (owner: RecoveryAttempt): HostAccessRecoveryView => {
    if (activeAttempt !== owner || owner.settled) return currentView;
    activeAttempt = null;
    owner.settled = true;
    operation = idleOperation();
    const view = publish();
    owner.resolve(view);
    return view;
  };

  const installCurrentConnection = (owner: RecoveryAttempt): boolean => {
    const next = readPortSnapshot(port);
    connection = next;
    if (!attemptMatches(owner, next)) {
      suppressAttempt(owner);
      return false;
    }
    publish();
    return true;
  };

  const failAttempt = (
    owner: RecoveryAttempt,
    source: "refresh" | "bootstrap"
  ): void => {
    if (activeAttempt !== owner || owner.settled) return;
    try {
      connection = readPortSnapshot(port);
    } catch {
      finishAttempt(owner, Object.freeze({ phase: "failed", source }));
      return;
    }
    if (!attemptMatches(owner, connection)) {
      suppressAttempt(owner);
      return;
    }
    finishAttempt(owner, Object.freeze({ phase: "failed", source }));
  };

  const completeBootstrap = (owner: RecoveryAttempt): void => {
    if (!installCurrentConnection(owner)) return;
    if (hasCurrentWriterTruth(connection) && connection.csrf.phase === "ready") {
      finishAttempt(
        owner,
        Object.freeze({
          phase: "recovered",
          targetKey: owner.targetKey,
          writerKey: owner.writerKey,
          epoch: connection.epoch
        })
      );
      return;
    }
    finishAttempt(owner, Object.freeze({ phase: "failed", source: "bootstrap" }));
  };

  const executeBootstrap = async (owner: RecoveryAttempt): Promise<void> => {
    if (closed || activeAttempt !== owner || owner.settled) return;
    owner.stage = "bootstrap";
    operation = Object.freeze({
      phase: "busy",
      stage: "bootstrap",
      action: owner.action
    });
    publish();
    try {
      if (!installCurrentConnection(owner)) return;
      const pending = callPromisePort(port.bootstrapCsrf);
      if (!installCurrentConnection(owner)) {
        observeSuppressedPromise(pending);
        return;
      }
      await pending;
      if (activeAttempt !== owner || owner.settled) return;
      completeBootstrap(owner);
    } catch {
      failAttempt(owner, "bootstrap");
    }
  };

  const executeRefresh = async (owner: RecoveryAttempt): Promise<void> => {
    if (closed || activeAttempt !== owner || owner.settled) return;
    try {
      const before = readPortSnapshot(port);
      connection = before;
      if (
        before.epoch !== owner.startEpoch ||
        !attemptIdentityMatches(owner, before)
      ) {
        suppressAttempt(owner);
        return;
      }
      publish();
      const pending = callPromisePort(port.refresh);
      const started = readPortSnapshot(port);
      connection = started;
      if (
        started.epoch !== owner.startEpoch + 1 ||
        !attemptIdentityMatches(owner, started)
      ) {
        observeSuppressedPromise(pending);
        suppressAttempt(owner);
        return;
      }
      owner.ownedEpoch = started.epoch;
      publish();
      await pending;
      if (activeAttempt !== owner || owner.settled) return;
      if (!installCurrentConnection(owner)) return;
      if (!hasCurrentWriterTruth(connection)) {
        finishAttempt(
          owner,
          hasStaleAuthority(connection) && canCheckAccess(connection)
            ? Object.freeze({ phase: "failed", source: "refresh" })
            : idleOperation()
        );
        return;
      }
      if (connection.csrf.phase === "ready") {
        finishAttempt(
          owner,
          Object.freeze({
            phase: "recovered",
            targetKey: owner.targetKey,
            writerKey: owner.writerKey,
            epoch: connection.epoch
          })
        );
        return;
      }
      if (connection.csrf.phase === "bootstrapping") {
        finishAttempt(owner, idleOperation());
        return;
      }
      await executeBootstrap(owner);
    } catch {
      failAttempt(owner, "refresh");
    }
  };

  const controller: HostAccessRecoveryController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck host-access recovery listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck host-access recovery listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    synchronize(): HostAccessRecoveryView {
      if (closed) return currentView;
      const next = readPortSnapshot(port);
      connection = next;
      const owner = activeAttempt;
      if (owner !== null && !attemptMatches(owner, next)) {
        return suppressAttempt(owner);
      }
      if (operation.phase === "recovered" && !resultMatches(operation, next)) {
        operation = idleOperation();
      } else if (operation.phase === "failed" && !failureStillApplies(operation, next)) {
        operation = idleOperation();
      }
      return publish();
    },
    recover(): Promise<HostAccessRecoveryView> {
      if (closed) return Promise.resolve(currentView);
      if (activeAttempt !== null) return activeAttempt.promise;
      connection = readPortSnapshot(port);
      const action = recoveryAction(connection, operation);
      const selectedTargetKey = targetKey(connection.target);
      const selectedWriterKey = writerKey(connection.access.data);
      if (action === null || selectedTargetKey === null || selectedWriterKey === null) {
        operation = idleOperation();
        return Promise.resolve(publish());
      }

      let resolve!: (view: HostAccessRecoveryView) => void;
      const promise = new Promise<HostAccessRecoveryView>((innerResolve) => {
        resolve = innerResolve;
      });
      const owner: RecoveryAttempt = {
        action,
        targetKey: selectedTargetKey,
        writerKey: selectedWriterKey,
        startEpoch: connection.epoch,
        stage: action === "check_access" ? "refresh" : "bootstrap",
        ownedEpoch: action === "check_access" ? null : connection.epoch,
        promise,
        resolve,
        settled: false
      };
      activeAttempt = owner;
      operation = Object.freeze({
        phase: "busy",
        stage: owner.stage,
        action
      });
      publish();
      void Promise.resolve().then(() =>
        owner.stage === "refresh" ? executeRefresh(owner) : executeBootstrap(owner)
      );
      return promise;
    },
    close(): HostAccessRecoveryView {
      if (closed) return currentView;
      closed = true;
      const owner = activeAttempt;
      activeAttempt = null;
      operation = idleOperation();
      connection = closedConnection(connection);
      currentView = projectRecovery(connection, operation);
      subscribers.clear();
      if (owner !== null && !owner.settled) {
        owner.settled = true;
        owner.resolve(currentView);
      }
      return currentView;
    }
  });

  return controller;
}

export function projectHostAccessRecovery(
  snapshot: BrowserConnectionSnapshot
): HostAccessRecoveryView {
  return projectRecovery(snapshot, idleOperation());
}

function projectRecovery(
  snapshot: BrowserConnectionSnapshot,
  operation: RecoveryOperation
): HostAccessRecoveryView {
  assertConnectionSnapshot(snapshot);

  if (snapshot.phase === "closed" || snapshot.csrf.phase === "closed") {
    return view(
      "closed",
      "muted",
      "Unavailable",
      "The browser connection is closed.",
      "Page security unavailable",
      "Reload HostDeck to start a new browser connection.",
      null,
      false
    );
  }

  if (operation.phase === "busy") {
    const checking = operation.stage === "refresh";
    return view(
      checking ? "checking_access" : "securing_page",
      "attention",
      checking ? "Checking" : "Securing",
      checking ? "Refreshing current authority." : "Establishing page protection.",
      checking ? "Checking current access" : "Securing this page",
      checking
        ? "Confirming this device, laptop, and selected session state."
        : "Current access is confirmed while page protection is established.",
      operation.action,
      false,
      true
    );
  }

  const access = snapshot.access.data;
  if (access === null) {
    const checking =
      snapshot.target === null ||
      snapshot.phase === "idle" ||
      snapshot.phase === "loading" ||
      snapshot.access.state === "idle" ||
      snapshot.access.state === "loading";
    return checking
      ? view(
          "checking",
          "muted",
          "Checking",
          "Waiting for current access.",
          "Checking page security",
          "HostDeck is confirming this browser's current authority.",
          null,
          false
        )
      : view(
          "unavailable",
          "danger",
          "Unavailable",
          "Current access is not confirmed.",
          "Page security unavailable",
          "No page authority is assumed until current access can be loaded.",
          null,
          false
        );
  }

  if (snapshot.access.state === "current") {
    if (access.authentication_state !== "paired_device") {
      return pairingRequiredView(access.authentication_state);
    }
    if (access.permission !== "write" || access.device_id === null) {
      return view(
        "read_only",
        "muted",
        "Unavailable",
        "This device has read-only access.",
        "Page security unavailable",
        "Secure write authority is not available to this device.",
        null,
        false
      );
    }
  }

  if (
    snapshot.access.state === "current" &&
    snapshot.host.state === "current" &&
    writerKey(access) !== null &&
    snapshot.csrf.phase === "ready"
  ) {
    const recovered = operation.phase === "recovered" && resultMatches(operation, snapshot);
    return view(
      recovered ? "recovered" : "ready",
      "connected",
      "Ready",
      "Protection is held for this page.",
      recovered ? "Page security recovered" : "Page security ready",
      "Secure write protection is ready for this page.",
      null,
      false
    );
  }

  if (hasLoadingAuthority(snapshot)) {
    return view(
      "checking",
      "muted",
      "Checking",
      "Waiting for current laptop and session state.",
      "Checking page security",
      "Current authority is still loading.",
      null,
      false
    );
  }

  if (hasStaleAuthority(snapshot)) {
    const failedRefresh = operation.phase === "failed" && operation.source === "refresh";
    return view(
      failedRefresh ? "refresh_failed" : "stale",
      failedRefresh ? "danger" : "attention",
      "Check required",
      "Previously verified authority is stale.",
      failedRefresh ? "Access check not confirmed" : "Current access must be checked",
      failedRefresh
        ? "Previously verified access remains stale. Check the connection and try again."
        : "Refresh current access before secure controls can continue.",
      canCheckAccess(snapshot) ? "check_access" : null,
      failedRefresh
    );
  }

  if (!hasCurrentWriterTruth(snapshot)) {
    return view(
      "unavailable",
      "attention",
      "Unavailable",
      "Current write authority is not available.",
      "Page security unavailable",
      "Current device, laptop, and selected-session truth is required.",
      null,
      false
    );
  }

  if (snapshot.csrf.phase === "bootstrapping") {
    return view(
      "automatic_bootstrap",
      "attention",
      "Securing",
      "Establishing page protection.",
      "Securing this page",
      "HostDeck is establishing secure write protection in page memory.",
      null,
      false,
      true
    );
  }

  if (
    snapshot.csrf.phase === "idle" &&
    snapshot.csrf.invalidationReason === "not_bootstrapped"
  ) {
    return view(
      "automatic_bootstrap",
      "attention",
      "Securing",
      "Waiting for initial page protection.",
      "Securing this page",
      "Current writer authority is confirmed and initial setup is starting.",
      null,
      false,
      true
    );
  }

  const failedBootstrap =
    snapshot.csrf.phase === "failed" ||
    (operation.phase === "failed" && operation.source === "bootstrap");
  return view(
    failedBootstrap ? "bootstrap_failed" : "setup_required",
    failedBootstrap ? "danger" : "attention",
    "Check required",
    failedBootstrap
      ? "Secure setup could not be confirmed."
      : "Page protection must be renewed.",
    failedBootstrap ? "Secure setup not confirmed" : "Page security needs attention",
    failedBootstrap
      ? "No page authority is retained. Try secure setup again."
      : "Renew secure write protection for this page before using controls.",
    failedBootstrap ? "retry_setup" : "secure_page",
    failedBootstrap
  );
}

function recoveryAction(
  snapshot: BrowserConnectionSnapshot,
  operation: RecoveryOperation
): HostAccessRecoveryAction | null {
  return projectRecovery(snapshot, operation).action;
}

function attemptMatches(
  owner: RecoveryAttempt,
  snapshot: BrowserConnectionSnapshot
): boolean {
  if (!attemptIdentityMatches(owner, snapshot)) return false;
  if (owner.stage === "refresh") {
    return owner.ownedEpoch === null
      ? snapshot.epoch === owner.startEpoch || snapshot.epoch === owner.startEpoch + 1
      : snapshot.epoch === owner.ownedEpoch;
  }
  return owner.ownedEpoch !== null && snapshot.epoch === owner.ownedEpoch;
}

function attemptIdentityMatches(
  owner: RecoveryAttempt,
  snapshot: BrowserConnectionSnapshot
): boolean {
  return (
    snapshot.phase !== "closed" &&
    targetKey(snapshot.target) === owner.targetKey &&
    writerKey(snapshot.access.data) === owner.writerKey
  );
}

function resultMatches(
  operation: Extract<RecoveryOperation, { readonly phase: "recovered" }>,
  snapshot: BrowserConnectionSnapshot
): boolean {
  return (
    snapshot.epoch === operation.epoch &&
    targetKey(snapshot.target) === operation.targetKey &&
    writerKey(snapshot.access.data) === operation.writerKey &&
    hasCurrentWriterTruth(snapshot) &&
    snapshot.csrf.phase === "ready"
  );
}

function failureStillApplies(
  operation: Extract<RecoveryOperation, { readonly phase: "failed" }>,
  snapshot: BrowserConnectionSnapshot
): boolean {
  return operation.source === "refresh"
    ? hasStaleAuthority(snapshot) && canCheckAccess(snapshot)
    : hasCurrentWriterTruth(snapshot) && snapshot.csrf.phase !== "ready";
}

function hasCurrentWriterTruth(snapshot: BrowserConnectionSnapshot): boolean {
  return (
    snapshot.target !== null &&
    snapshot.access.state === "current" &&
    snapshot.host.state === "current" &&
    snapshot.targetState.state === "current" &&
    writerKey(snapshot.access.data) !== null &&
    targetDataMatches(snapshot)
  );
}

function hasLoadingAuthority(snapshot: BrowserConnectionSnapshot): boolean {
  return (
    snapshot.access.state === "idle" ||
    snapshot.access.state === "loading" ||
    snapshot.host.state === "idle" ||
    snapshot.host.state === "loading" ||
    snapshot.targetState.state === "idle" ||
    snapshot.targetState.state === "loading"
  );
}

function hasStaleAuthority(snapshot: BrowserConnectionSnapshot): boolean {
  return [snapshot.access.state, snapshot.host.state, snapshot.targetState.state].some(
    (state) => state === "stale" || state === "failed" || state === "blocked"
  );
}

function canCheckAccess(snapshot: BrowserConnectionSnapshot): boolean {
  return (
    snapshot.target !== null &&
    writerKey(snapshot.access.data) !== null &&
    hasStaleAuthority(snapshot)
  );
}

function targetDataMatches(snapshot: BrowserConnectionSnapshot): boolean {
  const target = snapshot.target;
  const data = snapshot.targetState.data;
  if (target === null || data === null) return false;
  if (target.kind === "mission_control") return data.kind === "mission_control";
  return (
    data.kind === "session_detail" &&
    data.response.session.session.id === target.sessionId
  );
}

function writerKey(access: SelectedAccessStateResponse | null): string | null {
  if (
    access === null ||
    access.authentication_state !== "paired_device" ||
    access.permission !== "write" ||
    access.device_id === null
  ) {
    return null;
  }
  return [
    access.configured_origin,
    access.device_id,
    access.permission,
    access.network_mode,
    access.transport
  ].join("|");
}

function targetKey(target: BrowserConnectionTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "mission_control"
    ? "mission_control"
    : `session_detail:${target.sessionId}`;
}

function pairingRequiredView(
  state: SelectedAccessStateResponse["authentication_state"]
): HostAccessRecoveryView {
  const detail = state === "unpaired"
    ? "Pair this phone from the laptop to enable secure controls."
    : "Create a new pairing link on the laptop to restore device access.";
  return view(
    "pairing_required",
    "danger",
    "Unavailable",
    "Current paired authority is unavailable.",
    "Page security unavailable",
    detail,
    null,
    false
  );
}

function actionLabel(action: HostAccessRecoveryAction | null): string | null {
  switch (action) {
    case "secure_page":
      return "Secure this page";
    case "retry_setup":
      return "Retry secure setup";
    case "check_access":
      return "Check access";
    case null:
      return null;
  }
}

function view(
  phase: HostAccessRecoveryPhase,
  tone: HostAccessRecoveryTone,
  pageSecurity: HostAccessRecoveryView["pageSecurity"],
  pageSecurityDetail: string,
  status: string,
  detail: string,
  action: HostAccessRecoveryAction | null,
  urgent: boolean,
  busy = false
): HostAccessRecoveryView {
  return Object.freeze({
    phase,
    tone,
    pageSecurity,
    pageSecurityDetail,
    status,
    detail,
    action,
    actionLabel: actionLabel(action),
    actionEnabled: action !== null && !busy,
    busy,
    urgent
  });
}

function idleOperation(): RecoveryOperation {
  return Object.freeze({ phase: "idle" });
}

function callPromisePort(
  method: () => Promise<BrowserConnectionSnapshot>
): Promise<BrowserConnectionSnapshot> {
  const candidate = Reflect.apply(method, undefined, []) as unknown;
  if (
    candidate === null ||
    (typeof candidate !== "object" && typeof candidate !== "function") ||
    typeof Reflect.get(candidate, "then") !== "function"
  ) {
    throw new TypeError("HostDeck host-access recovery port did not return a promise.");
  }
  return Promise.resolve(candidate as PromiseLike<BrowserConnectionSnapshot>);
}

function observeSuppressedPromise(pending: Promise<BrowserConnectionSnapshot>): void {
  void pending.catch(() => undefined);
}

function readOptions(input: unknown): HostAccessRecoveryPort {
  const options = readExactRecord(input, createOptionKeys, createOptionKeys);
  const port = options === null
    ? null
    : readExactRecord(options.port, portKeys, portKeys);
  if (
    port === null ||
    typeof port.snapshot !== "function" ||
    typeof port.refresh !== "function" ||
    typeof port.bootstrapCsrf !== "function"
  ) {
    throw new TypeError("HostDeck host-access recovery options are invalid.");
  }
  return Object.freeze({
    snapshot: port.snapshot as () => BrowserConnectionSnapshot,
    refresh: port.refresh as () => Promise<BrowserConnectionSnapshot>,
    bootstrapCsrf: port.bootstrapCsrf as () => Promise<BrowserConnectionSnapshot>
  });
}

function readPortSnapshot(port: HostAccessRecoveryPort): BrowserConnectionSnapshot {
  const candidate = Reflect.apply(port.snapshot, undefined, []) as unknown;
  assertConnectionSnapshot(candidate);
  return candidate;
}

function assertConnectionSnapshot(
  candidate: unknown
): asserts candidate is BrowserConnectionSnapshot {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !Number.isSafeInteger(Reflect.get(candidate, "epoch")) ||
    (Reflect.get(candidate, "epoch") as number) < 0
  ) {
    throw new TypeError("HostDeck host-access recovery snapshot is invalid.");
  }
  const snapshot = candidate as Partial<BrowserConnectionSnapshot>;
  if (
    snapshot.access === undefined ||
    snapshot.host === undefined ||
    snapshot.targetState === undefined ||
    snapshot.csrf === undefined ||
    snapshot.writeEligibility === undefined ||
    !Object.isFrozen(snapshot.access) ||
    !Object.isFrozen(snapshot.host) ||
    !Object.isFrozen(snapshot.targetState) ||
    !Object.isFrozen(snapshot.csrf) ||
    !Object.isFrozen(snapshot.writeEligibility)
  ) {
    throw new TypeError("HostDeck host-access recovery snapshot is invalid.");
  }
}

function readExactRecord(
  candidate: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return null;
    }
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
      return null;
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) return null;
    const values: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return null;
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    return null;
  }
}

function sameRecoveryView(
  left: HostAccessRecoveryView,
  right: HostAccessRecoveryView
): boolean {
  return (
    left.phase === right.phase &&
    left.tone === right.tone &&
    left.pageSecurity === right.pageSecurity &&
    left.pageSecurityDetail === right.pageSecurityDetail &&
    left.status === right.status &&
    left.detail === right.detail &&
    left.action === right.action &&
    left.actionLabel === right.actionLabel &&
    left.actionEnabled === right.actionEnabled &&
    left.busy === right.busy &&
    left.urgent === right.urgent
  );
}

function closedConnection(snapshot: BrowserConnectionSnapshot): BrowserConnectionSnapshot {
  const blockedResource = Object.freeze({
    state: "blocked" as const,
    data: null,
    failure: null,
    observedAt: null
  });
  return Object.freeze({
    epoch: snapshot.epoch,
    target: null,
    phase: "closed",
    access: blockedResource,
    host: blockedResource,
    targetState: blockedResource,
    stream: Object.freeze({
      state: "closed",
      snapshot: null,
      continuity: "not_applicable",
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "closed",
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell",
      eligible: false,
      causes: Object.freeze(["connection_not_current" as const])
    }),
    lastFailure: null
  });
}
