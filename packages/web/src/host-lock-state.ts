import {
  clientOperationIdSchema,
  type SelectedAccessStateResponse,
  selectedAccessStateResponseSchema,
  selectedHostLockStateResponseSchema
} from "@hostdeck/contracts";
import {
  type BrowserConnectionSnapshot,
  type BrowserConnectionStateCoordinator,
  browserConnectionResourceStates,
  browserConnectionWriteBlockCauses,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { hostLockWriteReason } from "./host-lock-copy.js";
import type { BrowserHttpRouteResponse } from "./http-client.js";
import type { BrowserHttpRouteRequest } from "./http-route-contracts.js";

export const hostLockProjectionPhases = Object.freeze([
  "none",
  "pending",
  "locked",
  "unconfirmed"
] as const);

export const hostLockControllerPhases = Object.freeze([
  "unavailable",
  "unlocked",
  "confirming",
  "dispatching",
  "locked",
  "failure",
  "unconfirmed",
  "closed"
] as const);

export type HostLockProjectionPhase = (typeof hostLockProjectionPhases)[number];
export type HostLockControllerPhase = (typeof hostLockControllerPhases)[number];
export type HostLockTone = "connected" | "attention" | "danger" | "muted";

export interface HostLockProjection {
  readonly phase: HostLockProjectionPhase;
  readonly visible: boolean;
  readonly current: boolean;
  readonly tone: HostLockTone;
  readonly title: string | null;
  readonly reason: string | null;
  readonly source: string | null;
  readonly recoveryCommand: "codexdeck unlock" | null;
}

export interface HostLockConfirmationView {
  readonly title: "Lock remote writes?";
  readonly target: "This laptop";
  readonly consequence: string;
  readonly continuity: string;
  readonly nonCancellation: string;
  readonly recovery: string;
  readonly confirmLabel: "Lock writes";
  readonly busy: boolean;
  readonly cancelEnabled: boolean;
  readonly confirmEnabled: boolean;
}

export interface HostLockControllerView {
  readonly phase: HostLockControllerPhase;
  readonly tone: HostLockTone;
  readonly title: string;
  readonly detail: string;
  readonly source: string | null;
  readonly urgent: boolean;
  readonly lockVisible: boolean;
  readonly lockEnabled: boolean;
  readonly lockLabel: "Lock writes";
  readonly busy: boolean;
  readonly recoveryCommand: "codexdeck unlock" | null;
  readonly confirmation: HostLockConfirmationView | null;
}

export interface HostLockPort {
  readonly snapshot: () => BrowserConnectionSnapshot;
  readonly request: (
    input: BrowserHttpRouteRequest<"host_lock">
  ) => Promise<BrowserHttpRouteResponse<"host_lock">>;
}

export interface CreateHostLockControllerOptions {
  readonly port: HostLockPort;
  readonly createOperationId: () => string;
}

export interface HostLockController {
  readonly snapshot: () => HostLockControllerView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly synchronize: () => HostLockControllerView;
  readonly begin: () => HostLockControllerView;
  readonly cancel: () => HostLockControllerView;
  readonly confirm: () => Promise<HostLockControllerView>;
  readonly close: () => HostLockControllerView;
}

export type HostLockControllerErrorReason = "client_contract" | "not_ready" | "closed";

export class HostDeckHostLockControllerError extends Error {
  readonly reason: HostLockControllerErrorReason;

  constructor(reason: HostLockControllerErrorReason) {
    super(`HostDeck host-lock controller is ${reason.replaceAll("_", " ")}.`);
    this.name = "HostDeckHostLockControllerError";
    this.reason = reason;
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

interface LockConnectionState {
  readonly epoch: number;
  readonly accessState: (typeof browserConnectionResourceStates)[number];
  readonly access: SelectedAccessStateResponse | null;
  readonly csrfPhase: "idle" | "bootstrapping" | "ready" | "failed" | "closed";
  readonly writeCauses: readonly (typeof browserConnectionWriteBlockCauses)[number][];
}

interface LockAuthority {
  readonly key: string;
  readonly origin: string;
}

interface LockSelection extends LockAuthority {
  readonly epoch: number;
}

interface PendingLock {
  active: boolean;
  settled: boolean;
  readonly selection: LockSelection;
  readonly promise: Promise<HostLockControllerView>;
  readonly settle: (view: HostLockControllerView) => void;
}

type LockOperation =
  | Readonly<{ readonly phase: "idle" }>
  | Readonly<{ readonly phase: "confirming"; readonly selection: LockSelection }>
  | Readonly<{ readonly phase: "dispatching"; readonly owner: PendingLock }>
  | Readonly<{ readonly phase: "failure"; readonly authorityKey: string }>
  | Readonly<{
      readonly phase: "unconfirmed";
      readonly authorityKey: string;
      readonly proofEpoch: number;
    }>;

const createOptionKeys = ["port", "createOperationId"] as const;
const portKeys = ["snapshot", "request"] as const;
const snapshotKeys = [
  "epoch",
  "target",
  "phase",
  "access",
  "host",
  "targetState",
  "stream",
  "csrf",
  "writeEligibility",
  "lastFailure"
] as const;
const accessResourceKeys = ["state", "data", "failure", "observedAt"] as const;
const csrfKeys = ["phase", "generation", "rotatedAt", "failure", "invalidationReason"] as const;
const writeEligibilityKeys = ["scope", "eligible", "causes"] as const;
const csrfPhases = Object.freeze(["idle", "bootstrapping", "ready", "failed", "closed"] as const);
const maximumSubscribers = 32;
const idleOperation = Object.freeze({ phase: "idle" as const });

export function createHostLockController(
  input: CreateHostLockControllerOptions
): HostLockController {
  const options = readControllerOptions(input);
  const subscribers = new Set<() => void>();
  let connection = readPortConnection(options.port);
  let operation: LockOperation = idleOperation;
  let pending: PendingLock | null = null;
  let closed = false;
  let currentView = buildControllerView(connection, operation, false);

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

  const publish = (): HostLockControllerView => {
    const next = buildControllerView(connection, operation, closed);
    if (sameControllerView(currentView, next)) return currentView;
    currentView = next;
    notify();
    return currentView;
  };

  const settle = (owner: PendingLock): void => {
    if (owner.settled) return;
    owner.settled = true;
    owner.settle(currentView);
  };

  const suppress = (owner: PendingLock): HostLockControllerView => {
    if (pending !== owner || owner.settled) return currentView;
    owner.active = false;
    pending = null;
    operation = idleOperation;
    const view = publish();
    settle(owner);
    return view;
  };

  const finish = (owner: PendingLock, nextOperation: LockOperation): HostLockControllerView => {
    if (pending !== owner || !owner.active || owner.settled) return currentView;
    pending = null;
    owner.active = false;
    operation = nextOperation;
    const view = publish();
    settle(owner);
    return view;
  };

  const installConnection = (): LockConnectionState => {
    connection = readPortConnection(options.port);
    return connection;
  };

  const markPostDispatchFailure = (owner: PendingLock): void => {
    if (pending !== owner || !owner.active || owner.settled || closed) return;
    let next: LockConnectionState;
    try {
      next = installConnection();
    } catch {
      finish(
        owner,
        Object.freeze({
          phase: "unconfirmed",
          authorityKey: owner.selection.key,
          proofEpoch: owner.selection.epoch
        })
      );
      return;
    }
    const authority = authorityFromConnection(next);
    if (authority?.key !== owner.selection.key) {
      suppress(owner);
      return;
    }
    const projection = projectLockConnection(next);
    if (projection.phase === "locked" || projection.phase === "unconfirmed") {
      finish(owner, idleOperation);
      return;
    }
    finish(
      owner,
      Object.freeze({
        phase: "unconfirmed",
        authorityKey: owner.selection.key,
        proofEpoch: next.epoch
      })
    );
  };

  const execute = async (owner: PendingLock, operationId: string): Promise<void> => {
    let invoked = false;
    try {
      if (closed || pending !== owner || !owner.active || owner.settled) return;
      const candidate = Reflect.apply(options.port.request, undefined, [
        Object.freeze({
          body: Object.freeze({ operation_id: operationId, confirmed: true as const })
        })
      ]) as Promise<BrowserHttpRouteResponse<"host_lock">>;
      invoked = true;
      const response = await Promise.resolve(candidate);
      if (closed || pending !== owner || !owner.active || owner.settled) return;
      const parsed = selectedHostLockStateResponseSchema.safeParse(response?.data);
      const next = installConnection();
      const authority = authorityFromConnection(next);
      if (authority?.key !== owner.selection.key) {
        suppress(owner);
        return;
      }
      if (
        response.status !== 200 ||
        !parsed.success ||
        authorityKey(parsed.data) !== owner.selection.key ||
        !parsed.data.locked ||
        projectLockConnection(next).phase !== "locked"
      ) {
        markPostDispatchFailure(owner);
        return;
      }
      finish(owner, idleOperation);
    } catch (error) {
      if (closed || pending !== owner || !owner.active || owner.settled) return;
      if (!invoked || isPreDispatchConnectionFailure(error)) {
        try {
          const next = installConnection();
          const authority = authorityFromConnection(next);
          if (authority?.key !== owner.selection.key) {
            suppress(owner);
            return;
          }
          finish(
            owner,
            Object.freeze({ phase: "failure", authorityKey: owner.selection.key })
          );
        } catch {
          markPostDispatchFailure(owner);
        }
        return;
      }
      markPostDispatchFailure(owner);
    }
  };

  const synchronize = (): HostLockControllerView => {
    if (closed) return currentView;
    const next = installConnection();
    const authority = authorityFromConnection(next);
    if (operation.phase === "confirming") {
      if (!selectionMatches(operation.selection, next)) operation = idleOperation;
    } else if (operation.phase === "dispatching") {
      if (authority?.key !== operation.owner.selection.key) {
        return suppress(operation.owner);
      }
    } else if (operation.phase === "failure") {
      if (authority?.key !== operation.authorityKey) operation = idleOperation;
    } else if (operation.phase === "unconfirmed") {
      const projection = projectLockConnection(next);
      if (authority?.key !== operation.authorityKey) {
        operation = idleOperation;
      } else if (
        projection.phase !== "unconfirmed" &&
        next.epoch > operation.proofEpoch &&
        next.accessState === "current"
      ) {
        operation = idleOperation;
      }
    }
    return publish();
  };

  return Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed) throw controllerError("closed");
      if (
        typeof listener !== "function" ||
        subscribers.has(listener) ||
        subscribers.size >= maximumSubscribers
      ) {
        throw controllerError("client_contract");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    synchronize,
    begin(): HostLockControllerView {
      if (closed) throw controllerError("closed");
      synchronize();
      if (
        (operation.phase !== "idle" && operation.phase !== "failure") ||
        !canOfferLock(connection)
      ) {
        throw controllerError("not_ready");
      }
      const authority = authorityFromConnection(connection);
      if (authority === null) throw controllerError("not_ready");
      operation = Object.freeze({
        phase: "confirming",
        selection: Object.freeze({ ...authority, epoch: connection.epoch })
      });
      return publish();
    },
    cancel(): HostLockControllerView {
      if (closed) throw controllerError("closed");
      if (operation.phase !== "confirming") throw controllerError("not_ready");
      operation = idleOperation;
      return publish();
    },
    confirm(): Promise<HostLockControllerView> {
      if (closed) return Promise.reject(controllerError("closed"));
      if (pending !== null) return pending.promise;
      if (operation.phase !== "confirming") {
        return Promise.reject(controllerError("not_ready"));
      }
      const selection = operation.selection;
      connection = readPortConnection(options.port);
      if (!selectionMatches(selection, connection)) {
        operation = idleOperation;
        publish();
        return Promise.reject(controllerError("not_ready"));
      }

      let operationId: string;
      try {
        operationId = clientOperationIdSchema.parse(
          Reflect.apply(options.createOperationId, undefined, [])
        );
      } catch {
        operation = Object.freeze({ phase: "failure", authorityKey: selection.key });
        return Promise.resolve(publish());
      }

      connection = readPortConnection(options.port);
      if (!selectionMatches(selection, connection)) {
        operation = idleOperation;
        publish();
        return Promise.reject(controllerError("not_ready"));
      }
      const deferred = createDeferredView();
      const owner: PendingLock = {
        active: true,
        settled: false,
        selection,
        promise: deferred.promise,
        settle: deferred.resolve
      };
      pending = owner;
      operation = Object.freeze({ phase: "dispatching", owner });
      publish();
      void execute(owner, operationId);
      return owner.promise;
    },
    close(): HostLockControllerView {
      if (closed) return currentView;
      closed = true;
      const owner = pending;
      pending = null;
      if (owner !== null) owner.active = false;
      operation = idleOperation;
      const view = publish();
      subscribers.clear();
      if (owner !== null) settle(owner);
      return view;
    }
  });
}

export function projectHostLockState(
  snapshot: BrowserConnectionSnapshot
): HostLockProjection {
  return projectLockConnection(readConnection(snapshot));
}

export function hostLockPortFromCoordinator(
  coordinator: BrowserConnectionStateCoordinator
): HostLockPort {
  return Object.freeze({
    snapshot: coordinator.snapshot,
    request: coordinator.requestHostLock
  });
}

function projectLockConnection(connection: LockConnectionState): HostLockProjection {
  const pending = connection.writeCauses.includes("host_lock_pending");
  const unconfirmed = connection.writeCauses.includes("host_lock_unconfirmed");
  if (pending && unconfirmed) throw controllerError("client_contract");
  if (pending) {
    if (connection.accessState === "current" && connection.access?.locked === true) {
      throw controllerError("client_contract");
    }
    return projection(
      "pending",
      true,
      false,
      "attention",
      "Locking remote writes",
      hostLockWriteReason("host_lock_pending"),
      "This phone's explicit lock request",
      null
    );
  }
  if (unconfirmed) {
    return projection(
      "unconfirmed",
      true,
      false,
      "danger",
      "Lock outcome unconfirmed",
      hostLockWriteReason("host_lock_unconfirmed"),
      "The last lock attempt from this phone",
      "codexdeck unlock"
    );
  }
  if (connection.access?.locked === true) {
    const current = connection.accessState === "current";
    return projection(
      "locked",
      true,
      current,
      current ? "danger" : "attention",
      current ? "Remote writes locked" : "Remote writes last known locked",
      current
        ? "The laptop safety lock blocks new remote session writes."
        : "The last readable laptop state had remote writes locked.",
      current
        ? "Current HostDeck access state from the laptop"
        : "Last known HostDeck access state from the laptop",
      "codexdeck unlock"
    );
  }
  return projection("none", false, false, "muted", null, null, null, null);
}

function buildControllerView(
  connection: LockConnectionState,
  operation: LockOperation,
  closed: boolean
): HostLockControllerView {
  if (closed) {
    return controllerView(
      "closed",
      "muted",
      "Remote write lock",
      "Host-lock controls are closed.",
      null,
      false,
      false,
      false,
      null,
      null
    );
  }
  const projected = projectLockConnection(connection);
  if (projected.phase === "pending") return viewFromProjection(projected, "dispatching");
  if (projected.phase === "unconfirmed") return viewFromProjection(projected, "unconfirmed");
  if (projected.phase === "locked") return viewFromProjection(projected, "locked");
  if (operation.phase === "dispatching") {
    return controllerView(
      "dispatching",
      "attention",
      "Locking remote writes",
      hostLockWriteReason("host_lock_pending"),
      "This phone's explicit lock request",
      false,
      true,
      true,
      null,
      confirmationView(true)
    );
  }
  if (operation.phase === "confirming") {
    return controllerView(
      "confirming",
      "attention",
      "Confirm remote write lock",
      "Review the host-wide effect before locking writes.",
      null,
      false,
      true,
      false,
      null,
      confirmationView(false)
    );
  }
  if (operation.phase === "unconfirmed") {
    return controllerView(
      "unconfirmed",
      "danger",
      "Lock outcome unconfirmed",
      hostLockWriteReason("host_lock_unconfirmed"),
      "The last lock attempt from this phone",
      true,
      false,
      false,
      "codexdeck unlock",
      null
    );
  }
  if (operation.phase === "failure") {
    return controllerView(
      "failure",
      "attention",
      "Lock request not sent",
      "HostDeck could not prepare the lock request. Try again.",
      null,
      false,
      true,
      false,
      null,
      null
    );
  }
  if (canOfferLock(connection)) {
    return controllerView(
      "unlocked",
      "connected",
      "Remote writes unlocked",
      "This paired writer can lock new remote session writes.",
      "Current HostDeck access state from the laptop",
      false,
      true,
      false,
      null,
      null
    );
  }
  return controllerView(
    "unavailable",
    "muted",
    "Remote write lock",
    unavailableDetail(connection),
    null,
    false,
    false,
    false,
    null,
    null
  );
}

function viewFromProjection(
  projected: HostLockProjection,
  phase: "dispatching" | "locked" | "unconfirmed"
): HostLockControllerView {
  return controllerView(
    phase,
    projected.tone,
    projected.title ?? "Remote write lock",
    projected.reason ?? "Remote write state is unavailable.",
    projected.source,
    phase === "unconfirmed",
    false,
    phase === "dispatching",
    projected.recoveryCommand,
    phase === "dispatching" ? confirmationView(true) : null
  );
}

function unavailableDetail(connection: LockConnectionState): string {
  const access = connection.access;
  if (
    connection.accessState === "current" &&
    access?.authentication_state === "paired_device" &&
    access.permission === "read"
  ) {
    return "This phone has read-only access and cannot lock remote writes.";
  }
  if (
    connection.accessState === "current" &&
    access?.authentication_state === "paired_device" &&
    access.permission === "write" &&
    connection.csrfPhase !== "ready"
  ) {
    return "Secure page authority is required before this phone can lock writes.";
  }
  return "A current paired-writer connection is required to lock remote writes.";
}

function canOfferLock(connection: LockConnectionState): boolean {
  const access = connection.access;
  return (
    connection.accessState === "current" &&
    access?.authentication_state === "paired_device" &&
    access.device_id !== null &&
    access.permission === "write" &&
    access.can_lock &&
    !access.locked &&
    connection.csrfPhase === "ready" &&
    !connection.writeCauses.includes("host_lock_pending") &&
    !connection.writeCauses.includes("host_lock_unconfirmed")
  );
}

function authorityFromConnection(connection: LockConnectionState): LockAuthority | null {
  const access = connection.access;
  if (
    connection.accessState !== "current" ||
    access?.authentication_state !== "paired_device" ||
    access.device_id === null ||
    access.permission !== "write"
  ) {
    return null;
  }
  return Object.freeze({ key: authorityKey(access), origin: access.configured_origin });
}

function authorityKey(access: SelectedAccessStateResponse): string {
  return JSON.stringify([
    access.configured_origin,
    access.network_mode,
    access.transport,
    access.device_id,
    access.permission,
    access.device_expires_at
  ]);
}

function selectionMatches(selection: LockSelection, connection: LockConnectionState): boolean {
  const authority = authorityFromConnection(connection);
  return (
    authority?.key === selection.key &&
    authority.origin === selection.origin &&
    connection.epoch === selection.epoch &&
    canOfferLock(connection)
  );
}

function isPreDispatchConnectionFailure(error: unknown): boolean {
  return (
    error instanceof HostDeckBrowserConnectionError &&
    (error.reason === "client_contract" ||
      error.reason === "not_ready" ||
      error.reason === "closed")
  );
}

function confirmationView(busy: boolean): HostLockConfirmationView {
  return Object.freeze({
    title: "Lock remote writes?",
    target: "This laptop",
    consequence: "New remote session writes will be blocked.",
    continuity: "Session reads and live updates remain available.",
    nonCancellation: "Requests already sent and Codex work already running will not be stopped.",
    recovery: "Unlock requires running codexdeck unlock locally on the laptop.",
    confirmLabel: "Lock writes",
    busy,
    cancelEnabled: !busy,
    confirmEnabled: !busy
  });
}

function controllerView(
  phase: HostLockControllerPhase,
  tone: HostLockTone,
  title: string,
  detail: string,
  source: string | null,
  urgent: boolean,
  lockVisible: boolean,
  busy: boolean,
  recoveryCommand: "codexdeck unlock" | null,
  confirmation: HostLockConfirmationView | null
): HostLockControllerView {
  return Object.freeze({
    phase,
    tone,
    title,
    detail,
    source,
    urgent,
    lockVisible,
    lockEnabled: lockVisible && !busy && phase !== "confirming",
    lockLabel: "Lock writes",
    busy,
    recoveryCommand,
    confirmation
  });
}

function projection(
  phase: HostLockProjectionPhase,
  visible: boolean,
  current: boolean,
  tone: HostLockTone,
  title: string | null,
  reason: string | null,
  source: string | null,
  recoveryCommand: "codexdeck unlock" | null
): HostLockProjection {
  return Object.freeze({
    phase,
    visible,
    current,
    tone,
    title,
    reason,
    source,
    recoveryCommand
  });
}

function readPortConnection(port: HostLockPort): LockConnectionState {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(port.snapshot, undefined, []);
  } catch {
    throw controllerError("client_contract");
  }
  return readConnection(candidate);
}

function readConnection(candidate: unknown): LockConnectionState {
  const snapshot = readExactRecord(candidate, snapshotKeys, snapshotKeys);
  if (snapshot === null || !Object.isFrozen(candidate)) {
    throw controllerError("client_contract");
  }
  if (
    typeof snapshot.epoch !== "number" ||
    !Number.isSafeInteger(snapshot.epoch) ||
    snapshot.epoch < 0
  ) {
    throw controllerError("client_contract");
  }
  const accessResource = readExactRecord(
    snapshot.access,
    accessResourceKeys,
    accessResourceKeys
  );
  const csrf = readExactRecord(snapshot.csrf, csrfKeys, csrfKeys);
  const write = readExactRecord(
    snapshot.writeEligibility,
    writeEligibilityKeys,
    writeEligibilityKeys
  );
  if (
    accessResource === null ||
    csrf === null ||
    write === null ||
    !Object.isFrozen(snapshot.access) ||
    !Object.isFrozen(snapshot.csrf) ||
    !Object.isFrozen(snapshot.writeEligibility) ||
    !browserConnectionResourceStates.includes(accessResource.state as never) ||
    !csrfPhases.includes(csrf.phase as never) ||
    write.scope !== "browser_shell" ||
    typeof write.eligible !== "boolean" ||
    !Array.isArray(write.causes) ||
    !Object.isFrozen(write.causes)
  ) {
    throw controllerError("client_contract");
  }
  const causes = write.causes as unknown[];
  if (
    causes.some(
      (cause) =>
        typeof cause !== "string" ||
        !browserConnectionWriteBlockCauses.includes(cause as never)
    ) ||
    new Set(causes).size !== causes.length ||
    write.eligible !== (causes.length === 0)
  ) {
    throw controllerError("client_contract");
  }
  const parsedAccess = accessResource.data === null
    ? null
    : selectedAccessStateResponseSchema.safeParse(accessResource.data);
  if (
    parsedAccess !== null &&
    !parsedAccess.success ||
    accessResource.state === "current" &&
      parsedAccess === null
  ) {
    throw controllerError("client_contract");
  }
  const csrfPhase = csrf.phase as LockConnectionState["csrfPhase"];
  if (
    csrfPhase === "ready" &&
    (typeof csrf.generation !== "number" ||
      !Number.isSafeInteger(csrf.generation) ||
      csrf.generation < 1 ||
      typeof csrf.rotatedAt !== "string")
  ) {
    throw controllerError("client_contract");
  }
  return Object.freeze({
    epoch: snapshot.epoch,
    accessState: accessResource.state as LockConnectionState["accessState"],
    access: parsedAccess === null ? null : Object.freeze(parsedAccess.data),
    csrfPhase,
    writeCauses: Object.freeze(
      [...causes] as LockConnectionState["writeCauses"][number][]
    )
  });
}

function readControllerOptions(input: CreateHostLockControllerOptions): {
  readonly port: HostLockPort;
  readonly createOperationId: () => string;
} {
  const values = readExactRecord(input, createOptionKeys, createOptionKeys);
  if (values === null || typeof values.createOperationId !== "function") {
    throw new TypeError("HostDeck host-lock controller options are invalid.");
  }
  const port = readExactRecord(values.port, portKeys, portKeys);
  if (
    port === null ||
    typeof port.snapshot !== "function" ||
    typeof port.request !== "function"
  ) {
    throw new TypeError("HostDeck host-lock controller port is invalid.");
  }
  return Object.freeze({
    port: Object.freeze({
      snapshot: port.snapshot as HostLockPort["snapshot"],
      request: port.request as HostLockPort["request"]
    }),
    createOperationId: values.createOperationId as () => string
  });
}

function sameControllerView(
  left: HostLockControllerView,
  right: HostLockControllerView
): boolean {
  return (
    left.phase === right.phase &&
    left.tone === right.tone &&
    left.title === right.title &&
    left.detail === right.detail &&
    left.source === right.source &&
    left.urgent === right.urgent &&
    left.lockVisible === right.lockVisible &&
    left.lockEnabled === right.lockEnabled &&
    left.busy === right.busy &&
    left.recoveryCommand === right.recoveryCommand &&
    sameConfirmation(left.confirmation, right.confirmation)
  );
}

function sameConfirmation(
  left: HostLockConfirmationView | null,
  right: HostLockConfirmationView | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.busy === right.busy;
}

function createDeferredView(): {
  readonly promise: Promise<HostLockControllerView>;
  readonly resolve: (view: HostLockControllerView) => void;
} {
  let resolve!: (view: HostLockControllerView) => void;
  const promise = new Promise<HostLockControllerView>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

function readExactRecord<
  const Required extends string,
  const Allowed extends string
>(
  candidate: unknown,
  requiredKeys: readonly Required[],
  allowedKeys: readonly Allowed[]
): Readonly<Record<Allowed, unknown>> | null {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) => typeof key !== "string" || !(allowedKeys as readonly string[]).includes(key)
      ) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
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

function controllerError(
  reason: HostLockControllerErrorReason
): HostDeckHostLockControllerError {
  return new HostDeckHostLockControllerError(reason);
}
