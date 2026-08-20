import {
  type ApiErrorEnvelope,
  compareSelectedSessionListOrder,
  decodeSelectedSessionListCursor,
  hostDeckLoopbackOriginSchema,
  remoteExternalOriginSchema,
  type SelectedAccessStateResponse,
  type SelectedDeviceRevokeResponse,
  type SelectedHostLockStateResponse,
  type SelectedHostStatusResponse,
  type SelectedProjectionEvent,
  type SelectedSessionDetailResponse,
  type SelectedSessionListResponse,
  type SelectedSessionReadAccess,
  type SessionCatalogEvent,
  selectedAccessStateResponseSchema,
  selectedDeviceRevokeParamsSchema,
  selectedDeviceRevokeRequestSchema,
  selectedDeviceRevokeResponseSchema,
  selectedEventPageMaxSize,
  selectedHostLockRequestSchema,
  selectedHostLockStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionListMaximumActiveSessions,
  sessionIdSchema
} from "@hostdeck/contracts";
import {
  browserCsrfClientHttpClient,
  browserHttpClientOrigin,
  browserSseClientOrigin
} from "./browser-client-authority.js";
import {
  type BrowserCsrfBootstrapInput,
  type BrowserCsrfClient,
  type BrowserCsrfFailureReason,
  type BrowserCsrfInvalidationReason,
  type BrowserCsrfRequestOptions,
  type BrowserCsrfSnapshot,
  HostDeckBrowserCsrfError,
  isBrowserCsrfClient
} from "./csrf-client.js";
import {
  type BrowserHttpClient,
  type BrowserHttpFailureReason,
  type BrowserHttpRouteResponse,
  type BrowserHttpTransport,
  HostDeckBrowserHttpError,
  isBrowserHttpClient
} from "./http-client.js";
import type {
  BrowserHttpDeviceCsrfRouteId,
  BrowserHttpRouteId,
  BrowserHttpRouteRequest,
  BrowserHttpSelectedSessionReadRouteId
} from "./http-route-contracts.js";
import { browserHttpSelectedSessionReadRouteIds } from "./http-route-contracts.js";
import {
  type BrowserMissionSessionItem,
  type BrowserSessionCatalogBoundary,
  type BrowserSessionCatalogData,
  type BrowserSessionCatalogReducerState,
  createBrowserSessionCatalogReducerState,
  reduceBrowserSessionCatalogEvent
} from "./session-catalog-state.js";
import {
  type BrowserSessionCatalogSseConnection,
  type BrowserSessionCatalogSseSnapshot,
  type BrowserSseBoundary,
  type BrowserSseClient,
  type BrowserSseCloseReason,
  type BrowserSseConnection,
  type BrowserSseFailureReason,
  type BrowserSseSnapshot,
  isBrowserSseClient
} from "./sse-client.js";

export type { BrowserMissionSessionItem } from "./session-catalog-state.js";

export const browserConnectionPhases = Object.freeze([
  "idle",
  "loading",
  "ready",
  "access_limited",
  "remote_unavailable",
  "offline",
  "incompatible",
  "not_found",
  "unreachable",
  "degraded",
  "fatal",
  "closed"
] as const);

export const browserConnectionResourceStates = Object.freeze([
  "idle",
  "loading",
  "current",
  "stale",
  "blocked",
  "not_found",
  "failed"
] as const);

export const browserConnectionFailureSources = Object.freeze([
  "access",
  "device_list",
  "host_status",
  "session_list",
  "session_detail",
  "session_catalog",
  "session_stream",
  "csrf"
] as const);

export const browserConnectionWriteBlockCauses = Object.freeze([
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
] as const);

export type BrowserConnectionPhase = (typeof browserConnectionPhases)[number];
export type BrowserConnectionResourceState =
  (typeof browserConnectionResourceStates)[number];
export type BrowserConnectionFailureSource =
  (typeof browserConnectionFailureSources)[number];
export type BrowserConnectionWriteBlockCause =
  (typeof browserConnectionWriteBlockCauses)[number];
export type BrowserConnectionSessionStreamStart = "live" | "recent";
export type BrowserConnectionFailureReason =
  | BrowserHttpFailureReason
  | BrowserSseFailureReason
  | BrowserCsrfFailureReason
  | "authority_mismatch"
  | "page_mismatch"
  | "session_removed";

export type BrowserConnectionTarget =
  | Readonly<{ kind: "mission_control" }>
  | Readonly<{ kind: "session_detail"; sessionId: string }>;

export interface BrowserConnectionFailure {
  readonly source: BrowserConnectionFailureSource;
  readonly reason: BrowserConnectionFailureReason;
  readonly routeId:
    | BrowserHttpRouteId
    | "session_catalog_stream"
    | "session_event_stream"
    | null;
  readonly transport: BrowserHttpTransport | null;
  readonly status: number | null;
  readonly apiError: ApiErrorEnvelope | null;
  readonly epoch: number;
  readonly observedAt: string;
}

export interface BrowserConnectionResource<Data> {
  readonly state: BrowserConnectionResourceState;
  readonly data: Data | null;
  readonly failure: BrowserConnectionFailure | null;
  readonly observedAt: string | null;
}

export interface BrowserMissionControlData {
  readonly kind: "mission_control";
  readonly access: SelectedSessionReadAccess;
  readonly sessions: readonly BrowserMissionSessionItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly pageCount: number;
}

export interface BrowserSessionDetailData {
  readonly kind: "session_detail";
  readonly response: SelectedSessionDetailResponse;
}

export type BrowserConnectionTargetData =
  | BrowserMissionControlData
  | BrowserSessionDetailData;

export interface BrowserConnectionStreamState {
  readonly state:
    | "not_applicable"
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "failed"
    | "closed";
  readonly snapshot: BrowserSseSnapshot | null;
  readonly continuity: "not_applicable" | "unproven" | "contiguous" | "boundary";
  readonly boundary: BrowserSseBoundary | null;
  readonly failure: BrowserConnectionFailure | null;
}

export interface BrowserConnectionCatalogState {
  readonly state:
    | "idle"
    | "connecting"
    | "resetting"
    | "current"
    | "reconnecting"
    | "stale"
    | "failed"
    | "blocked"
    | "closed";
  readonly data: BrowserMissionControlData | null;
  readonly snapshot: BrowserSessionCatalogSseSnapshot | null;
  readonly boundary: BrowserSessionCatalogBoundary | null;
  readonly failure: BrowserConnectionFailure | null;
  readonly observedAt: string | null;
}

export interface BrowserConnectionWriteEligibility {
  readonly scope: "browser_shell";
  readonly eligible: boolean;
  readonly causes: readonly BrowserConnectionWriteBlockCause[];
}

export interface BrowserConnectionSnapshot {
  readonly epoch: number;
  readonly target: BrowserConnectionTarget | null;
  readonly phase: BrowserConnectionPhase;
  readonly access: BrowserConnectionResource<SelectedAccessStateResponse>;
  readonly host: BrowserConnectionResource<SelectedHostStatusResponse>;
  readonly targetState: BrowserConnectionResource<BrowserConnectionTargetData>;
  readonly catalog?: BrowserConnectionCatalogState;
  readonly stream: BrowserConnectionStreamState;
  readonly csrf: BrowserCsrfSnapshot;
  readonly writeEligibility: BrowserConnectionWriteEligibility;
  readonly lastFailure: BrowserConnectionFailure | null;
}

export interface BrowserConnectionClockPort {
  readonly now: () => number;
}

export interface BrowserConnectionSessionStreamOptions {
  readonly start: BrowserConnectionSessionStreamStart;
}

export interface BrowserConnectionSelectedSessionReadOptions {
  readonly signal?: AbortSignal;
}

export interface BrowserConnectionDeviceListOptions {
  readonly signal?: AbortSignal;
}

export interface BrowserConnectionRemoteStatusOptions {
  readonly signal?: AbortSignal;
}

export type BrowserConnectionGenericProtectedRouteId = Exclude<
  BrowserHttpDeviceCsrfRouteId,
  "device_revoke" | "host_lock" | "host_unlock"
>;

type BrowserConnectionHostLockTransition = "none" | "pending" | "unconfirmed";

interface PreparedHostLockRequestOptions {
  readonly options: BrowserCsrfRequestOptions | undefined;
  readonly callerAborted: boolean;
}

interface PreparedHostLockRequest {
  readonly input: BrowserHttpRouteRequest<"host_lock">;
}

export interface CreateBrowserConnectionStateCoordinatorOptions {
  readonly httpClient: BrowserHttpClient;
  readonly sseClient: BrowserSseClient;
  readonly csrfClient: BrowserCsrfClient;
  readonly origin?: string;
  readonly clock?: BrowserConnectionClockPort;
}

export interface BrowserConnectionStateCoordinator {
  readonly snapshot: () => BrowserConnectionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setTarget: (target: BrowserConnectionTarget) => Promise<BrowserConnectionSnapshot>;
  readonly refresh: () => Promise<BrowserConnectionSnapshot>;
  readonly loadMoreSessions: () => Promise<BrowserConnectionSnapshot>;
  readonly connectSessionStream: (
    onEvent: (event: SelectedProjectionEvent) => unknown,
    options?: BrowserConnectionSessionStreamOptions
  ) => BrowserConnectionSnapshot;
  readonly disconnectSessionStream: (
    reason?: Extract<BrowserSseCloseReason, "client_closed" | "unmounted">
  ) => BrowserConnectionSnapshot;
  readonly bootstrapCsrf: () => Promise<BrowserConnectionSnapshot>;
  readonly adoptCsrfBootstrap: (
    response: BrowserCsrfBootstrapInput
  ) => BrowserConnectionSnapshot;
  readonly requestProtected: <RouteId extends BrowserConnectionGenericProtectedRouteId>(
    routeId: RouteId,
    input: BrowserHttpRouteRequest<RouteId>,
    options?: BrowserCsrfRequestOptions
  ) => Promise<BrowserHttpRouteResponse<RouteId>>;
  readonly requestDeviceList: (
    input: BrowserHttpRouteRequest<"device_list">,
    options?: BrowserConnectionDeviceListOptions
  ) => Promise<BrowserHttpRouteResponse<"device_list">>;
  readonly requestRemoteStatus: (
    options?: BrowserConnectionRemoteStatusOptions
  ) => Promise<BrowserHttpRouteResponse<"remote_status">>;
  readonly requestDeviceRevoke: (
    input: BrowserHttpRouteRequest<"device_revoke">,
    options?: BrowserCsrfRequestOptions
  ) => Promise<BrowserHttpRouteResponse<"device_revoke">>;
  readonly requestHostLock: (
    input: BrowserHttpRouteRequest<"host_lock">,
    options?: BrowserCsrfRequestOptions
  ) => Promise<BrowserHttpRouteResponse<"host_lock">>;
  readonly requestSelectedSessionRead: <RouteId extends BrowserHttpSelectedSessionReadRouteId>(
    routeId: RouteId,
    input: BrowserHttpRouteRequest<RouteId>,
    options?: BrowserConnectionSelectedSessionReadOptions
  ) => Promise<BrowserHttpRouteResponse<RouteId>>;
  readonly close: () => BrowserConnectionSnapshot;
}

export type BrowserConnectionErrorReason =
  | "client_contract"
  | "not_ready"
  | "closed";

export class HostDeckBrowserConnectionError extends Error {
  readonly reason: BrowserConnectionErrorReason;

  constructor(reason: BrowserConnectionErrorReason) {
    super(messageForConnectionError(reason));
    this.name = "HostDeckBrowserConnectionError";
    this.reason = reason;
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

interface SelectedBrowserOrigin {
  readonly origin: string;
  readonly networkMode: "loopback" | "remote";
  readonly transport: BrowserHttpTransport;
}

interface PendingLoad {
  readonly epoch: number;
  readonly targetKey: string;
  readonly controller: AbortController;
  readonly promise: Promise<BrowserConnectionSnapshot>;
}

interface PendingPage {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly promise: Promise<BrowserConnectionSnapshot>;
}

interface ActiveStream {
  readonly epoch: number;
  readonly sessionId: string;
  readonly consumer: (event: SelectedProjectionEvent) => unknown;
  readonly start: BrowserConnectionSessionStreamStart;
  readonly startedAt: string;
  connection: BrowserSseConnection | null;
  active: boolean;
  closeReason: "client_closed" | "route_changed" | "unmounted" | null;
}

interface ActiveCatalogStream {
  readonly authorityKey: string;
  readonly startedAt: string;
  connection: BrowserSessionCatalogSseConnection | null;
  pendingEvent: SessionCatalogEvent | null;
  active: boolean;
  closeReason: "client_closed" | "route_changed" | null;
}

interface PreparedDeviceRevokeInput {
  readonly deviceId: string;
  readonly operationId: string;
}

type QueryResult<Data> =
  | Readonly<{ ok: true; data: Data }>
  | Readonly<{ ok: false; failure: BrowserConnectionFailure }>;

const createOptionKeys = ["httpClient", "sseClient", "csrfClient", "origin", "clock"] as const;
const requiredCreateOptionKeys = ["httpClient", "sseClient", "csrfClient"] as const;
const clockKeys = ["now"] as const;
const streamOptionKeys = ["start"] as const;
const maximumSubscribers = 32;
const fatalFailureReasons: readonly BrowserConnectionFailureReason[] = Object.freeze([
  "request_contract",
  "request_too_large",
  "invalid_response",
  "response_too_large",
  "authority_mismatch",
  "page_mismatch",
  "client_contract"
]);
const connectivityFailureReasons: readonly BrowserConnectionFailureReason[] = Object.freeze([
  "capacity_exhausted",
  "deadline_exceeded",
  "transport_unavailable",
  "connect_timeout",
  "idle_timeout",
  "reconnect_exhausted"
]);
const defaultClock: BrowserConnectionClockPort = Object.freeze({ now: () => Date.now() });

export function createBrowserConnectionStateCoordinator(
  input: CreateBrowserConnectionStateCoordinatorOptions
): BrowserConnectionStateCoordinator {
  const options = readCreateOptions(input);
  const origin = readBrowserOrigin(options.origin);
  if (
    browserHttpClientOrigin(options.httpClient) !== origin.origin ||
    browserSseClientOrigin(options.sseClient) !== origin.origin ||
    browserCsrfClientHttpClient(options.csrfClient) !== options.httpClient
  ) {
    throw new TypeError(
      "HostDeck browser connection clients must share one exact authority."
    );
  }
  const httpClient = options.httpClient;
  const sseClient = options.sseClient;
  const csrfClient = options.csrfClient;
  const clock = options.clock;
  const subscribers = new Set<() => void>();

  let closed = false;
  let epoch = 0;
  let target: BrowserConnectionTarget | null = null;
  let access = emptyResource<SelectedAccessStateResponse>("idle");
  let host = emptyResource<SelectedHostStatusResponse>("idle");
  let targetState = emptyResource<BrowserConnectionTargetData>("idle");
  let catalogReducer = createBrowserSessionCatalogReducerState();
  let catalog = idleCatalog();
  let stream = notApplicableStream();
  let csrf = csrfClient.snapshot();
  let lastFailure: BrowserConnectionFailure | null = null;
  let pendingLoad: PendingLoad | null = null;
  let pendingPage: PendingPage | null = null;
  let activeStream: ActiveStream | null = null;
  let activeCatalogStream: ActiveCatalogStream | null = null;
  let catalogAuthority: string | null = null;
  let catalogRevision = 0;
  let lastClockMs: number | null = null;
  let attemptedBootstrapAuthority: string | null = null;
  let hostLockTransition: BrowserConnectionHostLockTransition = "none";
  let hostLockGeneration = 0;
  let hostLockProvenGeneration: number | null = null;
  let currentSnapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch,
    target,
    phase: "idle",
    access,
    host,
    targetState,
    catalog,
    stream,
    csrf,
    writeEligibility: deriveWriteEligibility(access, host, csrf, hostLockTransition),
    lastFailure
  });

  const notify = (): void => {
    for (const listener of [...subscribers]) {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  const publish = (): BrowserConnectionSnapshot => {
    const writeEligibility = deriveWriteEligibility(
      access,
      host,
      csrf,
      hostLockTransition
    );
    const nextSnapshot: BrowserConnectionSnapshot = Object.freeze({
      epoch,
      target,
      phase: derivePhase(
        closed,
        target,
        access,
        host,
        targetState,
        stream,
        csrf
      ),
      access,
      host,
      targetState,
      catalog,
      stream,
      csrf,
      writeEligibility,
      lastFailure
    });
    if (sameConnectionSnapshot(currentSnapshot, nextSnapshot)) return currentSnapshot;
    currentSnapshot = nextSnapshot;
    notify();
    return currentSnapshot;
  };

  const readOperationTime = (): string => {
    let candidate: unknown;
    try {
      candidate = Reflect.apply(clock.now, undefined, []);
    } catch {
      throw connectionError("client_contract");
    }
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      (lastClockMs !== null && candidate < lastClockMs)
    ) {
      throw connectionError("client_contract");
    }
    const date = new Date(candidate);
    if (Number.isNaN(date.getTime())) {
      throw connectionError("client_contract");
    }
    const iso = date.toISOString();
    lastClockMs = candidate;
    return iso;
  };

  const refreshCsrf = (): void => {
    csrf = csrfClient.snapshot();
  };

  const rememberFailure = (failure: BrowserConnectionFailure): void => {
    lastFailure = failure;
  };

  const closeStream = (reason: "client_closed" | "route_changed" | "unmounted"): void => {
    const active = activeStream;
    activeStream = null;
    if (active !== null) {
      active.active = false;
      active.closeReason = reason;
      active.connection?.close(reason);
    }
    stream = target?.kind === "session_detail"
      ? idleStream(boundaryFromTargetData(targetState.data))
      : notApplicableStream();
  };

  const closeCatalog = (
    reason: "client_closed" | "route_changed",
    nextState: "blocked" | "closed"
  ): void => {
    const active = activeCatalogStream;
    activeCatalogStream = null;
    if (active !== null) {
      active.active = false;
      active.closeReason = reason;
      active.connection?.close(reason);
    }
    catalogAuthority = null;
    catalogReducer = createBrowserSessionCatalogReducerState();
    catalog = nextState === "closed" ? closedCatalog() : blockedCatalog();
  };

  const abortQueries = (): void => {
    const load = pendingLoad;
    pendingLoad = null;
    if (load !== null) safeAbort(load.controller);
    const page = pendingPage;
    pendingPage = null;
    if (page !== null) safeAbort(page.controller);
  };

  const isCurrentLoad = (
    loadEpoch: number,
    loadTarget: BrowserConnectionTarget
  ): boolean =>
    !closed &&
    epoch === loadEpoch &&
    target !== null &&
    targetKey(target) === targetKey(loadTarget);

  const invalidateCsrf = (reason: BrowserCsrfInvalidationReason): void => {
    csrfClient.invalidate(reason);
    attemptedBootstrapAuthority = null;
    refreshCsrf();
  };

  const makeHttpFailure = (
    source: Extract<
      BrowserConnectionFailureSource,
      "access" | "device_list" | "host_status" | "session_list" | "session_detail"
    >,
    routeId: Extract<
      BrowserHttpRouteId,
      "access_state" | "device_list" | "host_status" | "session_list" | "session_detail"
    >,
    error: unknown,
    failureEpoch: number,
    observedAt: string
  ): BrowserConnectionFailure => {
    if (error instanceof HostDeckBrowserHttpError) {
      return freezeFailure({
        source,
        reason: error.reason,
        routeId,
        transport: error.transport,
        status: error.status,
        apiError: error.apiError,
        epoch: failureEpoch,
        observedAt
      });
    }
    return freezeFailure({
      source,
      reason: "client_contract",
      routeId,
      transport: null,
      status: null,
      apiError: null,
      epoch: failureEpoch,
      observedAt
    });
  };

  const makeContractFailure = (
    source: BrowserConnectionFailureSource,
    reason: "authority_mismatch" | "page_mismatch",
    routeId: BrowserConnectionFailure["routeId"],
    failureEpoch: number,
    observedAt: string
  ): BrowserConnectionFailure =>
    freezeFailure({
      source,
      reason,
      routeId,
      transport: origin.transport,
      status: null,
      apiError: null,
      epoch: failureEpoch,
      observedAt
    });

  const synchronizeCurrentTargetFromCatalog = (
    triggeringEvent: SessionCatalogEvent | null = null
  ): void => {
    if (
      catalog.state !== "current" ||
      catalog.data === null ||
      catalogReducer.data === null
    ) {
      return;
    }
    const observedAt = catalogReducer.data.observedAt;
    if (target?.kind === "mission_control") {
      if (
        targetState.state !== "current" ||
        targetState.data !== catalog.data
      ) {
        targetState = currentResource(catalog.data, observedAt);
      }
      return;
    }
    if (target?.kind !== "session_detail") return;
    const selectedSessionId = target.sessionId;
    const item = catalog.data.sessions.find(
      (candidate) => candidate.session.id === selectedSessionId
    );
    if (item === undefined) {
      if (
        triggeringEvent?.type !== "session_remove" ||
        triggeringEvent.internal_session_id !== selectedSessionId
      ) {
        return;
      }
      if (
        targetState.state === "not_found" &&
        targetState.failure?.reason === "session_removed"
      ) {
        return;
      }
      const failure = catalogSessionRemovedFailure(
        epoch,
        observedAt,
        origin.transport
      );
      closeStream("route_changed");
      targetState = notFoundResource(failure);
      rememberFailure(failure);
      return;
    }
    if (targetState.data?.kind !== "session_detail") return;
    const response = mergeCatalogProjectionIntoDetail(
      targetState.data.response,
      item
    );
    if (response === null) {
      const failure = catalogClientFailure(epoch, observedAt, origin.transport);
      const active = activeCatalogStream;
      activeCatalogStream = null;
      if (active !== null) {
        active.active = false;
        active.closeReason = "route_changed";
        active.connection?.close("route_changed");
      }
      catalog = failedCatalog(catalog, failure);
      targetState = failedResource(failure);
      rememberFailure(failure);
      return;
    }
    if (response === targetState.data.response) return;
    targetState = currentResource(
      Object.freeze({ kind: "session_detail" as const, response }),
      observedAt
    );
  };

  const ensureCatalogStream = (
    selectedAccess: SelectedAccessStateResponse,
    observedAt: string
  ): void => {
    const authorityKey = sessionCatalogAuthorityKey(selectedAccess);
    if (authorityKey === null) {
      closeCatalog("route_changed", "blocked");
      return;
    }
    if (
      activeCatalogStream?.active &&
      activeCatalogStream.authorityKey === authorityKey
    ) {
      return;
    }
    if (catalogAuthority !== null && catalogAuthority !== authorityKey) {
      closeCatalog("route_changed", "blocked");
    } else if (activeCatalogStream !== null) {
      const previous = activeCatalogStream;
      activeCatalogStream = null;
      previous.active = false;
      previous.closeReason = "route_changed";
      previous.connection?.close("route_changed");
    }
    catalogAuthority = authorityKey;
    const owner: ActiveCatalogStream = {
      authorityKey,
      startedAt: observedAt,
      connection: null,
      pendingEvent: null,
      active: true,
      closeReason: null
    };
    activeCatalogStream = owner;
    let connection: BrowserSessionCatalogSseConnection;
    try {
      connection = sseClient.connectCatalog({
        onEvent(event: SessionCatalogEvent) {
          if (
            !owner.active ||
            activeCatalogStream !== owner ||
            closed ||
            sessionCatalogAuthorityKey(access.data) !== authorityKey
          ) {
            return;
          }
          catalogReducer = reduceBrowserSessionCatalogEvent(
            catalogReducer,
            event
          );
          owner.pendingEvent = event;
          if (catalogRevision === Number.MAX_SAFE_INTEGER) {
            throw connectionError("client_contract");
          }
          catalogRevision += 1;
        },
        onState(snapshot) {
          if (
            !owner.active ||
            activeCatalogStream !== owner ||
            closed ||
            sessionCatalogAuthorityKey(access.data) !== authorityKey
          ) {
            return;
          }
          const failure = snapshot.failure === null
            ? null
            : catalogSseFailure(snapshot, epoch, owner.startedAt);
          const triggeringEvent = owner.pendingEvent;
          owner.pendingEvent = null;
          catalog = catalogStateFromSnapshot(
            catalog,
            catalogReducer,
            snapshot,
            selectedAccess,
            failure
          );
          if (failure !== null) rememberFailure(failure);
          synchronizeCurrentTargetFromCatalog(triggeringEvent);
          if (
            snapshot.phase === "failed" ||
            snapshot.phase === "closed"
          ) {
            activeCatalogStream = null;
            owner.active = false;
          }
          publish();
        }
      });
    } catch {
      if (activeCatalogStream === owner) activeCatalogStream = null;
      owner.active = false;
      const failure = catalogClientFailure(epoch, observedAt, origin.transport);
      catalog = failedCatalog(catalog, failure);
      rememberFailure(failure);
      publish();
      return;
    }
    owner.connection = connection;
    if (activeCatalogStream !== owner || !owner.active) {
      if (owner.closeReason !== null) connection.close(owner.closeReason);
      return;
    }
    catalog = catalogStateFromSnapshot(
      catalog,
      catalogReducer,
      connection.snapshot(),
      selectedAccess,
      null
    );
    synchronizeCurrentTargetFromCatalog();
    publish();
  };

  const markAuthorityLost = (
    failure: BrowserConnectionFailure,
    reason: BrowserCsrfInvalidationReason
  ): void => {
    hostLockTransition = "none";
    hostLockProvenGeneration = null;
    invalidateCsrf(reason);
    closeStream("route_changed");
    closeCatalog("route_changed", "blocked");
    access = retainOrFail(access, failure);
    host = emptyResource("blocked");
    targetState = emptyResource("blocked");
    stream = target?.kind === "session_detail" ? idleStream(null) : notApplicableStream();
    rememberFailure(failure);
  };

  const invalidateCurrentAuthority = (
    failure: BrowserConnectionFailure,
    reason: BrowserCsrfInvalidationReason
  ): BrowserConnectionSnapshot => {
    epoch += 1;
    abortQueries();
    markAuthorityLost(failure, reason);
    return publish();
  };

  const currentPairedDeviceAccess = (): SelectedAccessStateResponse | null =>
    access.state === "current" &&
    access.data !== null &&
    access.data.authentication_state === "paired_device"
      ? access.data
      : null;

  const currentPairedDeviceAuthorityKey = (): string | null => {
    const currentAccess = currentPairedDeviceAccess();
    return currentAccess === null ? null : pairedDeviceAuthorityKey(currentAccess);
  };

  const adoptSelfRevocation = (
    previousAccess: SelectedAccessStateResponse,
    observedAt: string
  ): BrowserConnectionSnapshot => {
    hostLockTransition = "none";
    hostLockProvenGeneration = null;
    epoch += 1;
    abortQueries();
    invalidateCsrf("device_revoked");
    closeStream("route_changed");
    closeCatalog("route_changed", "blocked");
    access = currentResource(revokedBrowserAccess(previousAccess), observedAt);
    host = emptyResource("blocked");
    targetState = emptyResource("blocked");
    stream = target?.kind === "session_detail" ? idleStream(null) : notApplicableStream();
    lastFailure = null;
    return publish();
  };

  const currentWriterAuthorityKey = (): string | null =>
    access.state === "current" &&
    access.data !== null &&
    host.state === "current" &&
    host.data !== null &&
    isPairedWriter(access.data)
      ? writerAuthorityKey(access.data, host.data)
      : null;

  const runBootstrap = async (
    authorityKey: string,
    observedAt: string,
    rejectFailure: boolean
  ): Promise<void> => {
    attemptedBootstrapAuthority = authorityKey;
    let pending: Promise<BrowserCsrfSnapshot>;
    try {
      pending = csrfClient.bootstrap();
      refreshCsrf();
      publish();
      await pending;
      refreshCsrf();
      if (!closed && currentWriterAuthorityKey() === authorityKey) publish();
    } catch (error) {
      refreshCsrf();
      if (!closed && currentWriterAuthorityKey() === authorityKey) {
        const failure = csrfFailure(error, epoch, observedAt);
        rememberFailure(failure);
        publish();
      }
      if (rejectFailure) throw error;
    }
  };

  const maybeBootstrapWriter = async (observedAt: string): Promise<void> => {
    const previousCsrf = csrf;
    refreshCsrf();
    if (csrf !== previousCsrf) publish();
    if (access.state !== "current" || access.data === null) return;
    if (host.state !== "current" || host.data === null) return;
    if (!isPairedWriter(access.data)) return;
    const authorityKey = writerAuthorityKey(access.data, host.data);
    if (csrf.phase === "ready") {
      attemptedBootstrapAuthority = authorityKey;
      return;
    }
    if (
      csrf.phase !== "idle" ||
      csrf.invalidationReason !== "not_bootstrapped" ||
      attemptedBootstrapAuthority === authorityKey
    ) {
      return;
    }
    await runBootstrap(authorityKey, observedAt, false);
  };

  const executeLoad = async (
    loadEpoch: number,
    loadTarget: BrowserConnectionTarget,
    controller: AbortController,
    observedAt: string,
    previousAccess: SelectedAccessStateResponse | null,
    previousHost: SelectedHostStatusResponse | null,
    loadHostLockGeneration: number,
    loadHostLockProvenGeneration: number | null,
    mayProveHostLock: boolean,
    loadCatalogRevision: number
  ): Promise<BrowserConnectionSnapshot> => {
    const accessResult = await query(
      () => httpClient.request("access_state", {}, { signal: controller.signal }),
      (error) => makeHttpFailure("access", "access_state", error, loadEpoch, observedAt)
    );
    if (!isCurrentLoad(loadEpoch, loadTarget)) return currentSnapshot;

    if (!accessResult.ok) {
      if (isAuthorityFailure(accessResult.failure)) {
        markAuthorityLost(
          accessResult.failure,
          accessResult.failure.apiError?.code === "invalid_origin"
            ? "remote_authority_changed"
            : "access_lost"
        );
        return publish();
      }
      access = retainOrFail(access, accessResult.failure);
      host = retainOrBlock(host, accessResult.failure);
      targetState = retainOrBlock(targetState, accessResult.failure);
      closeStream("route_changed");
      rememberFailure(accessResult.failure);
      return publish();
    }

    let nextAccess = accessResult.data.data;
    if (!accessMatchesBrowser(nextAccess, origin)) {
      const mismatchInvalidation = accessInvalidationReason(previousAccess, nextAccess);
      const failure = makeContractFailure(
        "access",
        "authority_mismatch",
        "access_state",
        loadEpoch,
        observedAt
      );
      access = failedResource(failure);
      host = emptyResource("blocked");
      targetState = emptyResource("blocked");
      closeStream("route_changed");
      closeCatalog("route_changed", "blocked");
      invalidateCsrf(
        mismatchInvalidation === "remote_authority_changed"
          ? "remote_authority_changed"
          : "access_lost"
      );
      rememberFailure(failure);
      return publish();
    }

    const accessTransition = accessInvalidationReason(previousAccess, nextAccess);
    if (accessTransition !== null) {
      hostLockTransition = "none";
      hostLockProvenGeneration = null;
      invalidateCsrf(accessTransition);
      if (lastFailure?.epoch !== loadEpoch) lastFailure = null;
    }
    const retainedAccess = access.data;
    const correlatedProofPostdatesLoad =
      hostLockProvenGeneration === hostLockGeneration &&
      loadHostLockProvenGeneration !== hostLockProvenGeneration;
    const activeTransitionNeedsLaterProof =
      hostLockTransition !== "none" && !mayProveHostLock;
    const loadPredatesCurrentLockTruth =
      loadHostLockGeneration !== hostLockGeneration ||
      correlatedProofPostdatesLoad ||
      activeTransitionNeedsLaterProof;
    if (
      accessTransition === null &&
      retainedAccess !== null &&
      retainedAccess.locked !== nextAccess.locked &&
      loadPredatesCurrentLockTruth &&
      samePairedDeviceAuthority(retainedAccess, nextAccess)
    ) {
      nextAccess = retainedAccess;
    }
    if (
      mayProveHostLock &&
      loadHostLockGeneration === hostLockGeneration &&
      hostLockTransition === "unconfirmed"
    ) {
      hostLockTransition = "none";
      hostLockProvenGeneration = nextAccess.locked ? hostLockGeneration : null;
    }
    access = currentResource(nextAccess, observedAt);
    if (!nextAccess.can_read_sessions) {
      host = emptyResource("blocked");
      targetState = emptyResource("blocked");
      closeStream("route_changed");
      closeCatalog("route_changed", "blocked");
      if (
        accessTransition === null &&
        (csrf.phase !== "idle" || previousAccess?.can_read_sessions === true)
      ) {
        invalidateCsrf(invalidationForDeniedAccess(nextAccess));
      }
      return publish();
    }

    ensureCatalogStream(nextAccess, observedAt);

    host = loadingResource(host, true);
    targetState = loadingResource(targetState, true);
    publish();

    const hostPromise = query(
      () => httpClient.request("host_status", {}, { signal: controller.signal }),
      (error) => makeHttpFailure("host_status", "host_status", error, loadEpoch, observedAt)
    );
    const targetPromise = loadTarget.kind === "mission_control"
      ? query(
          () => httpClient.request("session_list", { query: {} }, { signal: controller.signal }),
          (error) => makeHttpFailure("session_list", "session_list", error, loadEpoch, observedAt)
        )
      : query(
          () =>
            httpClient.request(
              "session_detail",
              { params: { session_id: loadTarget.sessionId } },
              { signal: controller.signal }
            ),
          (error) => makeHttpFailure("session_detail", "session_detail", error, loadEpoch, observedAt)
        );

    let authorityLost = false;
    const loseAuthority = (failure: BrowserConnectionFailure): void => {
      if (authorityLost || !isCurrentLoad(loadEpoch, loadTarget)) return;
      authorityLost = true;
      markAuthorityLost(
        failure,
        failure.apiError?.code === "invalid_origin"
          ? "remote_authority_changed"
          : "access_lost"
      );
      safeAbort(controller);
      publish();
    };

    const settleHost = async (): Promise<void> => {
      const hostResult = await hostPromise;
      if (authorityLost || !isCurrentLoad(loadEpoch, loadTarget)) return;
      if (!hostResult.ok) {
        if (isAuthorityFailure(hostResult.failure)) {
          loseAuthority(hostResult.failure);
          return;
        }
        host = retainOrFail(host, hostResult.failure);
        rememberFailure(hostResult.failure);
        publish();
        return;
      }
      const nextHost = hostResult.data.data;
      if (!hostMatchesAccess(nextHost, nextAccess, origin)) {
        const failure = makeContractFailure(
          "host_status",
          "authority_mismatch",
          "host_status",
          loadEpoch,
          observedAt
        );
        host = failedResource(failure);
        invalidateCsrf(
          nextAccess.network_mode === "remote"
            ? "remote_authority_changed"
            : "access_lost"
        );
        closeStream("route_changed");
        closeCatalog("route_changed", "blocked");
        rememberFailure(failure);
        publish();
        return;
      }
      host = currentResource(nextHost, observedAt);
      if (
        previousHost !== null &&
        nextAccess.network_mode === "remote" &&
        remoteAuthorityKey(previousHost) !== remoteAuthorityKey(nextHost)
      ) {
        invalidateCsrf("remote_authority_changed");
        if (lastFailure?.epoch !== loadEpoch) lastFailure = null;
      }
      publish();
    };

    const settleTarget = async (): Promise<void> => {
      const selectedTargetResult = await targetPromise;
      if (authorityLost || !isCurrentLoad(loadEpoch, loadTarget)) return;
      if (!selectedTargetResult.ok) {
        if (isAuthorityFailure(selectedTargetResult.failure)) {
          loseAuthority(selectedTargetResult.failure);
          return;
        }
        if (
          loadTarget.kind === "session_detail" &&
          selectedTargetResult.failure.apiError?.code === "session_not_found"
        ) {
          targetState = notFoundResource(selectedTargetResult.failure);
        } else {
          targetState = retainOrFail(targetState, selectedTargetResult.failure);
        }
        rememberFailure(selectedTargetResult.failure);
        publish();
        return;
      }
      const response = selectedTargetResult.data.data;
      const currentHost = host.state === "current" ? host.data : null;
      if (
        !sessionAccessMatches(response.access, nextAccess) ||
        (currentHost !== null && !sessionAccessMatchesHost(response.access, currentHost))
      ) {
        const source = loadTarget.kind === "mission_control" ? "session_list" : "session_detail";
        const routeId = loadTarget.kind === "mission_control" ? "session_list" : "session_detail";
        const failure = makeContractFailure(
          source,
          "authority_mismatch",
          routeId,
          loadEpoch,
          observedAt
        );
        targetState = failedResource(failure);
        rememberFailure(failure);
        publish();
        return;
      }
      if (loadTarget.kind === "mission_control") {
        targetState = currentResource(
          missionData(response as SelectedSessionListResponse),
          observedAt
        );
      } else {
        targetState = currentResource(
          Object.freeze({
            kind: "session_detail" as const,
            response: response as SelectedSessionDetailResponse
          }),
          observedAt
        );
        stream = idleStream(boundaryFromTargetData(targetState.data));
      }
      if (catalogRevision !== loadCatalogRevision) {
        synchronizeCurrentTargetFromCatalog();
      }
      publish();
    };

    await Promise.all([settleHost(), settleTarget()]);
    if (authorityLost || !isCurrentLoad(loadEpoch, loadTarget)) return currentSnapshot;
    await maybeBootstrapWriter(observedAt);
    return currentSnapshot;
  };

  const beginLoad = (
    nextTarget: BrowserConnectionTarget,
    force: boolean
  ): Promise<BrowserConnectionSnapshot> => {
    if (closed) return Promise.reject(connectionError("closed"));
    const parsedTarget = readTarget(nextTarget);
    if (parsedTarget === null) return Promise.reject(connectionError("client_contract"));
    const nextTargetKey = targetKey(parsedTarget);
    if (!force && target !== null && targetKey(target) === nextTargetKey) {
      if (pendingLoad !== null) return pendingLoad.promise;
      return Promise.resolve(currentSnapshot);
    }
    let observedAt: string;
    try {
      observedAt = readOperationTime();
    } catch (error) {
      return Promise.reject(error);
    }

    const previousTarget = target;
    const sameTarget = previousTarget !== null && targetKey(previousTarget) === nextTargetKey;
    const previousAccess = access.data;
    const previousHost = host.data;
    const loadHostLockGeneration = hostLockGeneration;
    const loadHostLockProvenGeneration = hostLockProvenGeneration;
    const mayProveHostLock = hostLockTransition === "unconfirmed";
    const loadCatalogRevision = catalogRevision;
    abortQueries();
    epoch += 1;
    closeStream("route_changed");
    target = parsedTarget;
    if (!sameTarget) lastFailure = null;
    access = loadingResource(access, true);
    host = loadingResource(host, true);
    targetState = sameTarget
      ? loadingResource(targetState, true)
      : loadingResource(emptyResource<BrowserConnectionTargetData>("idle"), false);
    stream = parsedTarget.kind === "session_detail" ? idleStream(null) : notApplicableStream();
    const loadEpoch = epoch;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() =>
        executeLoad(
          loadEpoch,
          parsedTarget,
          controller,
          observedAt,
          previousAccess,
          previousHost,
          loadHostLockGeneration,
          loadHostLockProvenGeneration,
          mayProveHostLock,
          loadCatalogRevision
        )
      )
      .finally(() => {
        if (pendingLoad?.epoch === loadEpoch) pendingLoad = null;
      });
    pendingLoad = Object.freeze({
      epoch: loadEpoch,
      targetKey: nextTargetKey,
      controller,
      promise
    });
    publish();
    return promise;
  };

  const coordinator: BrowserConnectionStateCoordinator = Object.freeze({
    snapshot: () => currentSnapshot,
    subscribe(listener: () => void): () => void {
      if (closed) throw connectionError("closed");
      if (typeof listener !== "function") throw connectionError("client_contract");
      if (subscribers.has(listener)) throw connectionError("client_contract");
      if (subscribers.size >= maximumSubscribers) throw connectionError("not_ready");
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    setTarget(nextTarget: BrowserConnectionTarget): Promise<BrowserConnectionSnapshot> {
      return beginLoad(nextTarget, false);
    },
    refresh(): Promise<BrowserConnectionSnapshot> {
      if (closed) return Promise.reject(connectionError("closed"));
      if (target === null) return Promise.reject(connectionError("not_ready"));
      return beginLoad(target, true);
    },
    loadMoreSessions(): Promise<BrowserConnectionSnapshot> {
      if (closed) return Promise.reject(connectionError("closed"));
      if (
        target?.kind !== "mission_control" ||
        targetState.state !== "current" ||
        targetState.data?.kind !== "mission_control" ||
        !targetState.data.hasMore ||
        targetState.data.nextCursor === null ||
        access.state !== "current" ||
        access.data === null
      ) {
        return Promise.reject(connectionError("not_ready"));
      }
      if (pendingPage !== null) return pendingPage.promise;
      let observedAt: string;
      try {
        observedAt = readOperationTime();
      } catch (error) {
        return Promise.reject(error);
      }
      const pageEpoch = epoch;
      const controller = new AbortController();
      const currentData = targetState.data;
      const currentAccess = access.data;
      targetState = loadingResource(targetState, true);
      const promise = Promise.resolve()
        .then(() => query(
          () =>
            httpClient.request(
              "session_list",
              { query: { cursor: currentData.nextCursor as string } },
              { signal: controller.signal }
            ),
          (error) => makeHttpFailure("session_list", "session_list", error, pageEpoch, observedAt)
        ))
        .then((result) => {
          if (closed || epoch !== pageEpoch || target?.kind !== "mission_control") {
            return currentSnapshot;
          }
          if (!result.ok) {
            if (isAuthorityFailure(result.failure)) {
              markAuthorityLost(
                result.failure,
                result.failure.apiError?.code === "invalid_origin"
                  ? "remote_authority_changed"
                  : "access_lost"
              );
            } else {
              targetState = staleResource(currentData, result.failure, targetState.observedAt);
              rememberFailure(result.failure);
            }
            return publish();
          }
          if (!sessionAccessMatches(result.data.data.access, currentAccess)) {
            const failure = makeContractFailure(
              "session_list",
              "authority_mismatch",
              "session_list",
              pageEpoch,
              observedAt
            );
            targetState = staleResource(currentData, failure, targetState.observedAt);
            rememberFailure(failure);
            return publish();
          }
          const merged = mergeMissionData(currentData, result.data.data);
          if (merged === null) {
            const failure = makeContractFailure(
              "session_list",
              "page_mismatch",
              "session_list",
              pageEpoch,
              observedAt
            );
            targetState = staleResource(currentData, failure, targetState.observedAt);
            rememberFailure(failure);
            return publish();
          }
          targetState = currentResource(merged, observedAt);
          return publish();
        })
        .finally(() => {
          if (pendingPage?.epoch === pageEpoch) pendingPage = null;
        });
      pendingPage = Object.freeze({ epoch: pageEpoch, controller, promise });
      publish();
      return promise;
    },
    connectSessionStream(
      onEvent: (event: SelectedProjectionEvent) => unknown,
      streamOptions?: BrowserConnectionSessionStreamOptions
    ): BrowserConnectionSnapshot {
      if (closed) throw connectionError("closed");
      if (typeof onEvent !== "function") throw connectionError("client_contract");
      const start = readSessionStreamStart(streamOptions);
      if (
        target?.kind !== "session_detail" ||
        targetState.state !== "current" ||
        targetState.data?.kind !== "session_detail" ||
        access.state !== "current" ||
        access.data?.can_read_sessions !== true
      ) {
        throw connectionError("not_ready");
      }
      if (activeStream !== null) {
        if (
          activeStream.epoch === epoch &&
          activeStream.consumer === onEvent &&
          activeStream.start === start
        ) {
          return currentSnapshot;
        }
        throw connectionError("not_ready");
      }
      const startedAt = readOperationTime();
      const streamEpoch = epoch;
      const sessionId = target.sessionId;
      const after = sessionStreamAfter(targetState.data.response, start);
      const initialBoundary = boundaryFromTargetData(targetState.data);
      const owner: ActiveStream = {
        epoch: streamEpoch,
        sessionId,
        consumer: onEvent,
        start,
        startedAt,
        connection: null,
        active: true,
        closeReason: null
      };
      activeStream = owner;
      let connection: BrowserSseConnection;
      try {
        connection = sseClient.connect({
          sessionId,
          after,
          onEvent(event) {
            if (
              !owner.active ||
              activeStream !== owner ||
              closed ||
              epoch !== streamEpoch ||
              target?.kind !== "session_detail" ||
              target.sessionId !== sessionId
            ) {
              return;
            }
            return onEvent(event);
          },
          onState(snapshot) {
            if (
              !owner.active ||
              activeStream !== owner ||
              closed ||
              epoch !== streamEpoch ||
              target?.kind !== "session_detail" ||
              target.sessionId !== sessionId
            ) {
              return;
            }
            const failure = snapshot.failure === null
              ? null
              : sseFailure(snapshot, streamEpoch, startedAt);
            if (failure !== null) rememberFailure(failure);
            stream = streamFromSnapshot(snapshot, initialBoundary, failure);
            if (
              (snapshot.phase === "failed" || snapshot.phase === "closed") &&
              activeStream === owner
            ) {
              activeStream = null;
              owner.active = false;
            }
            publish();
          }
        });
      } catch {
        if (activeStream === owner) activeStream = null;
        owner.active = false;
        throw connectionError("client_contract");
      }
      owner.connection = connection;
      if (activeStream !== owner || !owner.active) {
        if (owner.closeReason !== null) connection.close(owner.closeReason);
        return currentSnapshot;
      }
      stream = streamFromSnapshot(connection.snapshot(), initialBoundary, null);
      return publish();
    },
    disconnectSessionStream(
      reason: Extract<BrowserSseCloseReason, "client_closed" | "unmounted"> = "unmounted"
    ): BrowserConnectionSnapshot {
      if (closed) return currentSnapshot;
      if (reason !== "client_closed" && reason !== "unmounted") {
        throw connectionError("client_contract");
      }
      closeStream(reason);
      return publish();
    },
    async bootstrapCsrf(): Promise<BrowserConnectionSnapshot> {
      if (closed) throw connectionError("closed");
      if (
        access.state !== "current" ||
        access.data === null ||
        host.state !== "current" ||
        host.data === null ||
        !isPairedWriter(access.data)
      ) {
        throw connectionError("not_ready");
      }
      const observedAt = readOperationTime();
      const authorityKey = writerAuthorityKey(access.data, host.data);
      await runBootstrap(authorityKey, observedAt, true);
      return currentSnapshot;
    },
    adoptCsrfBootstrap(response: BrowserCsrfBootstrapInput): BrowserConnectionSnapshot {
      if (closed) throw connectionError("closed");
      const observedAt = readOperationTime();
      try {
        csrfClient.adoptBootstrap(response);
        refreshCsrf();
        if (access.data !== null && host.data !== null && isPairedWriter(access.data)) {
          attemptedBootstrapAuthority = writerAuthorityKey(access.data, host.data);
        }
        return publish();
      } catch (error) {
        refreshCsrf();
        rememberFailure(csrfFailure(error, epoch, observedAt));
        publish();
        throw error;
      }
    },
    async requestDeviceList(
      requestInput: BrowserHttpRouteRequest<"device_list">,
      requestOptions?: BrowserConnectionDeviceListOptions
    ): Promise<BrowserHttpRouteResponse<"device_list">> {
      if (closed) throw connectionError("closed");
      const authorityKey = currentPairedDeviceAuthorityKey();
      if (authorityKey === null) throw connectionError("not_ready");
      const observedAt = readOperationTime();
      try {
        const response = requestOptions?.signal === undefined
          ? await httpClient.request("device_list", requestInput)
          : await httpClient.request("device_list", requestInput, {
              signal: requestOptions.signal
            });
        if (closed) throw connectionError("closed");
        if (currentPairedDeviceAuthorityKey() !== authorityKey) {
          throw connectionError("not_ready");
        }
        return response;
      } catch (error) {
        if (closed) throw connectionError("closed");
        if (currentPairedDeviceAuthorityKey() !== authorityKey) {
          throw connectionError("not_ready");
        }
        const failure = makeHttpFailure(
          "device_list",
          "device_list",
          error,
          epoch,
          observedAt
        );
        if (isAuthorityFailure(failure)) {
          invalidateCurrentAuthority(
            failure,
            failure.apiError?.code === "invalid_origin"
              ? "remote_authority_changed"
              : "access_lost"
          );
        } else if (failure.reason !== "caller_aborted") {
          rememberFailure(failure);
          publish();
        }
        throw error;
      }
    },
    async requestRemoteStatus(
      requestOptions?: BrowserConnectionRemoteStatusOptions
    ): Promise<BrowserHttpRouteResponse<"remote_status">> {
      if (closed) throw connectionError("closed");
      const currentAccess = currentPairedDeviceAccess();
      if (
        access.state !== "current" ||
        currentAccess === null ||
        !currentAccess.can_read_sessions ||
        currentAccess.network_mode !== "remote" ||
        currentAccess.transport !== "https"
      ) {
        throw connectionError("not_ready");
      }
      const authorityKey = pairedDeviceAuthorityKey(currentAccess);
      try {
        const response = requestOptions?.signal === undefined
          ? await httpClient.request("remote_status", {})
          : await httpClient.request("remote_status", {}, {
              signal: requestOptions.signal
            });
        if (closed) throw connectionError("closed");
        if (
          access.state !== "current" ||
          currentPairedDeviceAuthorityKey() !== authorityKey
        ) {
          throw connectionError("not_ready");
        }
        return response;
      } catch (error) {
        if (closed) throw connectionError("closed");
        if (
          access.state !== "current" ||
          currentPairedDeviceAuthorityKey() !== authorityKey
        ) {
          throw connectionError("not_ready");
        }
        throw error;
      }
    },
    async requestDeviceRevoke(
      requestInput: BrowserHttpRouteRequest<"device_revoke">,
      requestOptions?: BrowserCsrfRequestOptions
    ): Promise<BrowserHttpRouteResponse<"device_revoke">> {
      if (closed) throw connectionError("closed");
      const prepared = readDeviceRevokeInput(requestInput);
      if (prepared === null) throw connectionError("client_contract");
      const currentAccess = currentPairedDeviceAccess();
      if (
        currentAccess === null ||
        currentAccess.permission !== "write" ||
        csrf.phase !== "ready"
      ) {
        throw connectionError("not_ready");
      }
      const authorityKey = pairedDeviceAuthorityKey(currentAccess);
      const selfTarget = prepared.deviceId === currentAccess.device_id;
      const observedAt = readOperationTime();
      let submitted = false;
      let selfRevocationAdopted = false;
      try {
        submitted = true;
        const response = await csrfClient.request(
          "device_revoke",
          requestInput,
          requestOptions
        );
        refreshCsrf();
        if (closed) throw connectionError("closed");
        if (currentPairedDeviceAuthorityKey() !== authorityKey) {
          throw connectionError("not_ready");
        }
        const parsedResponse = selectedDeviceRevokeResponseSchema.safeParse(response.data);
        if (
          !parsedResponse.success ||
          !deviceRevokeResponseMatches(
            parsedResponse.data,
            prepared,
            selfTarget
          )
        ) {
          throw connectionError("client_contract");
        }
        if (selfTarget) {
          adoptSelfRevocation(currentAccess, observedAt);
          selfRevocationAdopted = true;
        } else {
          publish();
        }
        return response;
      } catch (error) {
        if (closed) throw connectionError("closed");
        refreshCsrf();
        const authorityStillCurrent = currentPairedDeviceAuthorityKey() === authorityKey;
        const failure = csrfFailure(error, epoch, observedAt);
        if (selfTarget && submitted && !selfRevocationAdopted && authorityStillCurrent) {
          invalidateCurrentAuthority(failure, "device_revoked");
        } else if (
          authorityStillCurrent &&
          error instanceof HostDeckBrowserCsrfError &&
          error.reason === "authority_rejected"
        ) {
          invalidateCurrentAuthority(
            failure,
            error.apiError?.code === "invalid_origin"
              ? "remote_authority_changed"
              : "access_lost"
          );
        } else if (
          authorityStillCurrent &&
          error instanceof HostDeckBrowserCsrfError &&
          error.reason === "stale_generation"
        ) {
          closeStream("route_changed");
          access = retainOrFail(access, failure);
          host = retainOrFail(host, failure);
          targetState = retainOrFail(targetState, failure);
          rememberFailure(failure);
          publish();
        } else if (authorityStillCurrent) {
          rememberFailure(failure);
          publish();
        }
        throw error;
      }
    },
    async requestHostLock(
      requestInput: BrowserHttpRouteRequest<"host_lock">,
      requestOptions?: BrowserCsrfRequestOptions
    ): Promise<BrowserHttpRouteResponse<"host_lock">> {
      if (closed) throw connectionError("closed");
      const preparedInput = readHostLockRequest(requestInput);
      if (preparedInput === null) throw connectionError("client_contract");
      const preparedOptions = readHostLockRequestOptions(requestOptions);
      if (preparedOptions === null) throw connectionError("client_contract");
      if (preparedOptions.callerAborted) {
        throw new HostDeckBrowserCsrfError({
          reason: "caller_aborted",
          operation: "mutation",
          routeId: "host_lock"
        });
      }
      const currentAccess = currentPairedDeviceAccess();
      if (
        currentAccess === null ||
        currentAccess.permission !== "write" ||
        !currentAccess.can_lock ||
        currentAccess.locked ||
        csrf.phase !== "ready" ||
        hostLockTransition !== "none"
      ) {
        throw connectionError("not_ready");
      }
      const authorityKey = pairedDeviceAuthorityKey(currentAccess);
      const observedAt = readOperationTime();
      hostLockGeneration += 1;
      const attemptGeneration = hostLockGeneration;
      hostLockTransition = "pending";
      hostLockProvenGeneration = null;
      publish();

      try {
        const response = await csrfClient.request(
          "host_lock",
          preparedInput.input,
          preparedOptions.options
        );
        refreshCsrf();
        if (closed) throw connectionError("closed");
        const retainedAccess = pairedDeviceAccess(access.data);
        const parsed = selectedHostLockStateResponseSchema.safeParse(response.data);
        if (
          retainedAccess === null ||
          pairedDeviceAuthorityKey(retainedAccess) !== authorityKey ||
          !parsed.success ||
          !hostLockResponseMatches(parsed.data, currentAccess)
        ) {
          throw connectionError("client_contract");
        }
        access = currentResource(Object.freeze(parsed.data), observedAt);
        hostLockTransition = "none";
        hostLockProvenGeneration = attemptGeneration;
        publish();
        return response;
      } catch (error) {
        if (closed) throw connectionError("closed");
        refreshCsrf();
        const retainedAccess = pairedDeviceAccess(access.data);
        const authorityStillCurrent =
          retainedAccess !== null &&
          pairedDeviceAuthorityKey(retainedAccess) === authorityKey;
        const failure = hostLockFailure(error, epoch, observedAt);
        if (!authorityStillCurrent) {
          hostLockTransition = "none";
          hostLockProvenGeneration = null;
          publish();
        } else if (
          error instanceof HostDeckBrowserCsrfError &&
          (error.reason === "authority_rejected" || error.reason === "stale_generation")
        ) {
          hostLockTransition = "none";
          hostLockProvenGeneration = null;
          closeStream("route_changed");
          access = retainOrFail(access, failure);
          host = retainOrFail(host, failure);
          targetState = retainOrFail(targetState, failure);
          rememberFailure(failure);
          publish();
        } else {
          hostLockTransition = "unconfirmed";
          hostLockProvenGeneration = null;
          rememberFailure(failure);
          publish();
        }
        throw error;
      }
    },
    async requestProtected<RouteId extends BrowserConnectionGenericProtectedRouteId>(
      routeId: RouteId,
      requestInput: BrowserHttpRouteRequest<RouteId>,
      requestOptions?: BrowserCsrfRequestOptions
    ): Promise<BrowserHttpRouteResponse<RouteId>> {
      if (closed) throw connectionError("closed");
      if (
        (routeId as BrowserHttpDeviceCsrfRouteId) === "device_revoke" ||
        (routeId as BrowserHttpDeviceCsrfRouteId) === "host_lock" ||
        (routeId as BrowserHttpRouteId) === "host_unlock" ||
        (routeId as BrowserHttpRouteId) === "remote_status" ||
        (routeId as BrowserHttpRouteId) === "remote_enable" ||
        (routeId as BrowserHttpRouteId) === "remote_disable"
      ) {
        throw connectionError("client_contract");
      }
      if (!currentSnapshot.writeEligibility.eligible) {
        throw connectionError("not_ready");
      }
      const observedAt = readOperationTime();
      try {
        const response = await csrfClient.request(routeId, requestInput, requestOptions);
        refreshCsrf();
        publish();
        return response;
      } catch (error) {
        if (closed) throw error;
        refreshCsrf();
        const failure = csrfFailure(error, epoch, observedAt);
        rememberFailure(failure);
        if (
          error instanceof HostDeckBrowserCsrfError &&
          (error.reason === "authority_rejected" || error.reason === "stale_generation")
        ) {
          closeStream("route_changed");
          access = retainOrFail(access, failure);
          host = retainOrFail(host, failure);
          targetState = retainOrFail(targetState, failure);
        }
        publish();
        throw error;
      }
    },
    async requestSelectedSessionRead<RouteId extends BrowserHttpSelectedSessionReadRouteId>(
      routeId: RouteId,
      requestInput: BrowserHttpRouteRequest<RouteId>,
      requestOptions?: BrowserConnectionSelectedSessionReadOptions
    ): Promise<BrowserHttpRouteResponse<RouteId>> {
      if (closed) throw connectionError("closed");
      if (!(browserHttpSelectedSessionReadRouteIds as readonly unknown[]).includes(routeId)) {
        throw connectionError("client_contract");
      }
      const sessionId = readSelectedSessionRequestId(routeId, requestInput);
      if (sessionId === null || !hasCurrentSelectedSessionAuthority(currentSnapshot, sessionId)) {
        throw connectionError(sessionId === null ? "client_contract" : "not_ready");
      }
      const requestEpoch = epoch;
      try {
        const requestArguments =
          requestOptions?.signal === undefined
            ? [routeId, requestInput]
            : [routeId, requestInput, { signal: requestOptions.signal }];
        const response = (await Reflect.apply(
          httpClient.request,
          httpClient,
          requestArguments
        )) as BrowserHttpRouteResponse<RouteId>;
        if (
          closed ||
          epoch !== requestEpoch ||
          !hasCurrentSelectedSessionAuthority(currentSnapshot, sessionId)
        ) {
          throw connectionError(closed ? "closed" : "not_ready");
        }
        return response;
      } catch (error) {
        if (closed) throw connectionError("closed");
        if (
          epoch !== requestEpoch ||
          !hasCurrentSelectedSessionAuthority(currentSnapshot, sessionId)
        ) {
          throw connectionError("not_ready");
        }
        throw error;
      }
    },
    close(): BrowserConnectionSnapshot {
      if (closed) return currentSnapshot;
      closed = true;
      epoch += 1;
      abortQueries();
      closeStream("client_closed");
      closeCatalog("client_closed", "closed");
      sseClient.close();
      csrfClient.close();
      refreshCsrf();
      target = null;
      access = emptyResource("blocked");
      host = emptyResource("blocked");
      targetState = emptyResource("blocked");
      stream = Object.freeze({
        state: "closed",
        snapshot: null,
        continuity: "not_applicable",
        boundary: null,
        failure: null
      });
      attemptedBootstrapAuthority = null;
      hostLockTransition = "none";
      hostLockProvenGeneration = null;
      lastFailure = null;
      const snapshot = publish();
      subscribers.clear();
      return snapshot;
    }
  });

  return coordinator;
}

function readCreateOptions(input: unknown): {
  readonly httpClient: BrowserHttpClient;
  readonly sseClient: BrowserSseClient;
  readonly csrfClient: BrowserCsrfClient;
  readonly origin: string | undefined;
  readonly clock: BrowserConnectionClockPort;
} {
  const values = readExactRecord(input, requiredCreateOptionKeys, createOptionKeys);
  if (
    values === null ||
    !isBrowserHttpClient(values.httpClient) ||
    !isBrowserSseClient(values.sseClient) ||
    !isBrowserCsrfClient(values.csrfClient) ||
    (values.origin !== undefined && typeof values.origin !== "string")
  ) {
    throw new TypeError("HostDeck browser connection coordinator options are invalid.");
  }
  const clock = values.clock === undefined ? defaultClock : readClock(values.clock);
  if (clock === null) {
    throw new TypeError("HostDeck browser connection coordinator clock is invalid.");
  }
  return Object.freeze({
    httpClient: values.httpClient as BrowserHttpClient,
    sseClient: values.sseClient as BrowserSseClient,
    csrfClient: values.csrfClient as BrowserCsrfClient,
    origin: values.origin as string | undefined,
    clock
  });
}

function readClock(candidate: unknown): BrowserConnectionClockPort | null {
  const values = readExactRecord(candidate, clockKeys, clockKeys);
  if (values === null || typeof values.now !== "function") return null;
  const source = candidate as object;
  const now = values.now as () => unknown;
  return Object.freeze({
    now: () => Reflect.apply(now, source, []) as number
  });
}

function readBrowserOrigin(candidate: string | undefined): SelectedBrowserOrigin {
  const value = candidate ?? globalThis.location?.origin;
  if (typeof value !== "string") {
    throw new TypeError("HostDeck browser connection origin is unavailable.");
  }
  if (hostDeckLoopbackOriginSchema.safeParse(value).success) {
    return Object.freeze({ origin: value, networkMode: "loopback", transport: "http" });
  }
  if (remoteExternalOriginSchema.safeParse(value).success) {
    return Object.freeze({ origin: value, networkMode: "remote", transport: "https" });
  }
  throw new TypeError("HostDeck browser connection origin is not selected.");
}

function readTarget(candidate: unknown): BrowserConnectionTarget | null {
  const values = readExactRecord(candidate, ["kind"], ["kind", "sessionId"]);
  if (values === null) return null;
  if (values.kind === "mission_control") {
    if (Object.hasOwn(values, "sessionId")) return null;
    return Object.freeze({ kind: "mission_control" });
  }
  if (values.kind !== "session_detail" || !Object.hasOwn(values, "sessionId")) {
    return null;
  }
  const parsed = sessionIdSchema.safeParse(values.sessionId);
  return parsed.success
    ? Object.freeze({ kind: "session_detail", sessionId: parsed.data })
    : null;
}

function targetKey(target: BrowserConnectionTarget): string {
  return target.kind === "mission_control" ? "mission_control" : `session_detail:${target.sessionId}`;
}

function readSelectedSessionRequestId(
  routeId: BrowserHttpSelectedSessionReadRouteId,
  candidate: unknown
): string | null {
  if (routeId === "session_events") {
    const input = readExactRecord(
      candidate,
      ["params", "query"],
      ["params", "query"]
    );
    if (input === null) return null;
    const params = readExactRecord(input.params, ["session_id"], ["session_id"]);
    const query = readExactRecord(input.query, ["limit"], ["after", "limit"]);
    if (
      params === null ||
      query === null ||
      typeof query.limit !== "string" ||
      (query.after !== undefined && typeof query.after !== "string")
    ) {
      return null;
    }
    const parsed = sessionIdSchema.safeParse(params.session_id);
    return parsed.success ? parsed.data : null;
  }
  const input = readExactRecord(candidate, ["params"], ["params"]);
  if (input === null) return null;
  const params = readExactRecord(input.params, ["session_id"], ["session_id"]);
  if (params === null) return null;
  const parsed = sessionIdSchema.safeParse(params.session_id);
  return parsed.success ? parsed.data : null;
}

function readDeviceRevokeInput(candidate: unknown): PreparedDeviceRevokeInput | null {
  const input = readExactRecord(candidate, ["params", "body"], ["params", "body"]);
  if (input === null) return null;
  const params = selectedDeviceRevokeParamsSchema.safeParse(input.params);
  const body = selectedDeviceRevokeRequestSchema.safeParse(input.body);
  if (!params.success || !body.success) return null;
  return Object.freeze({
    deviceId: params.data.device_id,
    operationId: body.data.operation_id
  });
}

function readHostLockRequest(candidate: unknown): PreparedHostLockRequest | null {
  const input = readExactRecord(candidate, ["body"], ["body"]);
  if (input === null) return null;
  const body = readExactRecord(
    input.body,
    ["operation_id", "confirmed"],
    ["operation_id", "confirmed"]
  );
  if (body === null) return null;
  const parsed = selectedHostLockRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  return Object.freeze({
    input: Object.freeze({ body: Object.freeze(parsed.data) })
  });
}

function readHostLockRequestOptions(
  candidate: unknown
): PreparedHostLockRequestOptions | null {
  if (candidate === undefined) {
    return Object.freeze({ options: undefined, callerAborted: false });
  }
  const values = readExactRecord(candidate, [], ["signal"]);
  if (values === null) return null;
  if (values.signal === undefined) {
    return Object.freeze({ options: Object.freeze({}), callerAborted: false });
  }
  const callerAborted = readNativeAbortSignalState(values.signal);
  if (callerAborted === null) return null;
  return Object.freeze({
    options: Object.freeze({ signal: values.signal as AbortSignal }),
    callerAborted
  });
}

function readNativeAbortSignalState(candidate: unknown): boolean | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (typeof getter !== "function") return null;
    const aborted = Reflect.apply(getter, candidate, []) as unknown;
    return typeof aborted === "boolean" ? aborted : null;
  } catch {
    return null;
  }
}

function deviceRevokeResponseMatches(
  response: SelectedDeviceRevokeResponse,
  request: PreparedDeviceRevokeInput,
  selfTarget: boolean
): boolean {
  return (
    response.operation_id === request.operationId &&
    response.device_id === request.deviceId &&
    response.authority_invalidated &&
    response.self_revoked === selfTarget
  );
}

function pairedDeviceAuthorityKey(access: SelectedAccessStateResponse): string {
  if (
    access.authentication_state !== "paired_device" ||
    access.device_id === null ||
    (access.permission !== "read" && access.permission !== "write")
  ) {
    throw connectionError("client_contract");
  }
  return JSON.stringify([
    access.configured_origin,
    access.network_mode,
    access.transport,
    access.device_id,
    access.permission,
    access.device_expires_at
  ]);
}

function pairedDeviceAccess(
  candidate: SelectedAccessStateResponse | null
): SelectedAccessStateResponse | null {
  return candidate?.authentication_state === "paired_device" ? candidate : null;
}

function samePairedDeviceAuthority(
  left: SelectedAccessStateResponse,
  right: SelectedAccessStateResponse
): boolean {
  const leftPaired = pairedDeviceAccess(left);
  const rightPaired = pairedDeviceAccess(right);
  return (
    leftPaired !== null &&
    rightPaired !== null &&
    pairedDeviceAuthorityKey(leftPaired) === pairedDeviceAuthorityKey(rightPaired)
  );
}

function hostLockResponseMatches(
  response: SelectedHostLockStateResponse,
  requestAccess: SelectedAccessStateResponse
): boolean {
  return response.locked && samePairedDeviceAuthority(response, requestAccess);
}

function revokedBrowserAccess(
  previous: SelectedAccessStateResponse
): SelectedAccessStateResponse {
  const parsed = selectedAccessStateResponseSchema.safeParse({
    authentication_state: "revoked_device",
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: previous.configured_origin,
    network_mode: previous.network_mode,
    transport: previous.transport,
    locked: previous.locked,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
  if (!parsed.success) throw connectionError("client_contract");
  return Object.freeze(parsed.data);
}

function hasCurrentSelectedSessionAuthority(
  snapshot: BrowserConnectionSnapshot,
  sessionId: string
): boolean {
  return (
    snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    snapshot.access.state === "current" &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.targetState.state === "current" &&
    snapshot.targetState.data?.kind === "session_detail" &&
    snapshot.targetState.data.response.session.session.id === sessionId &&
    !catalogProvesSessionRemoved(snapshot.catalog, sessionId)
  );
}

function catalogProvesSessionRemoved(
  catalog: BrowserConnectionCatalogState | undefined,
  sessionId: string
): boolean {
  return (
    catalog?.state === "current" &&
    catalog.data !== null &&
    !catalog.data.sessions.some((item) => item.session.id === sessionId)
  );
}

async function query<RouteId extends BrowserHttpRouteId>(
  operation: () => Promise<BrowserHttpRouteResponse<RouteId>>,
  onFailure: (error: unknown) => BrowserConnectionFailure
): Promise<QueryResult<BrowserHttpRouteResponse<RouteId>>> {
  try {
    return Object.freeze({ ok: true, data: await operation() });
  } catch (error) {
    return Object.freeze({ ok: false, failure: onFailure(error) });
  }
}

function accessMatchesBrowser(
  access: SelectedAccessStateResponse,
  origin: SelectedBrowserOrigin
): boolean {
  return (
    access.configured_origin === origin.origin &&
    access.network_mode === origin.networkMode &&
    access.transport === origin.transport &&
    access.authentication_state !== "local_admin"
  );
}

function expectedAccessMode(
  access: SelectedAccessStateResponse
): "loopback_read" | "paired_read" | "paired_write" | null {
  if (
    access.authentication_state === "unpaired" &&
    access.network_mode === "loopback" &&
    access.can_read_sessions
  ) {
    return "loopback_read";
  }
  if (access.authentication_state !== "paired_device") return null;
  if (access.permission === "read" && access.can_read_sessions) return "paired_read";
  if (access.permission === "write" && access.can_read_sessions) return "paired_write";
  return null;
}

function hostMatchesAccess(
  host: SelectedHostStatusResponse,
  access: SelectedAccessStateResponse,
  origin: SelectedBrowserOrigin
): boolean {
  const mode = expectedAccessMode(access);
  if (
    mode === null ||
    host.access.mode !== mode ||
    host.access.network_mode !== access.network_mode ||
    host.access.transport !== access.transport
  ) {
    return false;
  }
  if (access.network_mode !== "remote") return true;
  return (
    host.remote.availability === "ready" &&
    host.remote.state_generation !== null &&
    host.remote.external_origin === origin.origin
  );
}

function sessionAccessMatches(
  sessionAccess: SelectedSessionReadAccess,
  access: SelectedAccessStateResponse
): boolean {
  const mode = expectedAccessMode(access);
  return (
    mode !== null &&
    sessionAccess.mode === mode &&
    sessionAccess.network_mode === access.network_mode &&
    sessionAccess.transport === access.transport
  );
}

function sessionAccessMatchesHost(
  sessionAccess: SelectedSessionReadAccess,
  host: SelectedHostStatusResponse
): boolean {
  return (
    sessionAccess.mode === host.access.mode &&
    sessionAccess.network_mode === host.access.network_mode &&
    sessionAccess.transport === host.access.transport
  );
}

function accessInvalidationReason(
  previous: SelectedAccessStateResponse | null,
  next: SelectedAccessStateResponse
): BrowserCsrfInvalidationReason | null {
  if (previous === null) return null;
  if (
    previous.configured_origin !== next.configured_origin ||
    previous.network_mode !== next.network_mode ||
    previous.transport !== next.transport
  ) {
    return "remote_authority_changed";
  }
  if (
    previous.authentication_state === "paired_device" &&
    next.authentication_state === "revoked_device"
  ) {
    return "device_revoked";
  }
  if (
    previous.authentication_state === "paired_device" &&
    next.authentication_state === "paired_device" &&
    previous.device_id !== next.device_id
  ) {
    return "pairing_replaced";
  }
  if (
    previous.authentication_state !== next.authentication_state ||
    previous.permission !== next.permission ||
    previous.device_id !== next.device_id
  ) {
    return "access_lost";
  }
  return null;
}

function invalidationForDeniedAccess(
  access: SelectedAccessStateResponse
): BrowserCsrfInvalidationReason {
  return access.authentication_state === "revoked_device" ? "device_revoked" : "access_lost";
}

function remoteAuthorityKey(host: SelectedHostStatusResponse): string {
  return `${host.remote.availability}:${host.remote.state_generation ?? "none"}:${host.remote.external_origin ?? "none"}`;
}

function writerAuthorityKey(
  access: SelectedAccessStateResponse,
  host: SelectedHostStatusResponse
): string {
  return [
    access.configured_origin,
    access.device_id ?? "none",
    access.permission ?? "none",
    access.network_mode === "remote" ? remoteAuthorityKey(host) : "loopback"
  ].join("|");
}

function isPairedWriter(access: SelectedAccessStateResponse): boolean {
  return (
    access.authentication_state === "paired_device" &&
    access.permission === "write" &&
    access.device_id !== null
  );
}

function missionData(response: SelectedSessionListResponse): BrowserMissionControlData {
  return Object.freeze({
    kind: "mission_control",
    access: response.access,
    sessions: Object.freeze(
      response.sessions.map((item) => Object.freeze({ session: item.session }))
    ),
    nextCursor: response.next_cursor,
    hasMore: response.has_more,
    pageCount: 1
  });
}

function mergeMissionData(
  current: BrowserMissionControlData,
  next: SelectedSessionListResponse
): BrowserMissionControlData | null {
  if (
    !sameSessionAccess(current.access, next.access) ||
    !continuationMatches(current, next)
  ) {
    return null;
  }
  const combined = [
    ...current.sessions,
    ...next.sessions.map((item) => Object.freeze({ session: item.session }))
  ];
  if (combined.length > selectedSessionListMaximumActiveSessions) return null;
  if (combined.length === selectedSessionListMaximumActiveSessions && next.has_more) return null;
  const ids = new Set(combined.map((item) => item.session.id));
  if (ids.size !== combined.length) return null;
  for (let index = 1; index < combined.length; index += 1) {
    const previous = combined[index - 1];
    const item = combined[index];
    if (
      previous === undefined ||
      item === undefined ||
      compareSelectedSessionListOrder(previous.session, item.session) >= 0
    ) {
      return null;
    }
  }
  return Object.freeze({
    kind: "mission_control",
    access: current.access,
    sessions: Object.freeze(combined),
    nextCursor: next.next_cursor,
    hasMore: next.has_more,
    pageCount: current.pageCount + 1
  });
}

function sameSessionAccess(
  left: SelectedSessionReadAccess,
  right: SelectedSessionReadAccess
): boolean {
  return (
    left.mode === right.mode &&
    left.network_mode === right.network_mode &&
    left.transport === right.transport
  );
}

function continuationMatches(
  current: BrowserMissionControlData,
  next: SelectedSessionListResponse
): boolean {
  if (!current.hasMore || current.nextCursor === null || next.sessions.length === 0) {
    return false;
  }
  if (next.next_cursor === null) return true;
  try {
    return (
      decodeSelectedSessionListCursor(current.nextCursor).order_snapshot ===
      decodeSelectedSessionListCursor(next.next_cursor).order_snapshot
    );
  } catch {
    return false;
  }
}

function sessionCatalogAuthorityKey(
  access: SelectedAccessStateResponse | null
): string | null {
  if (
    access === null ||
    !access.can_read_sessions ||
    expectedAccessMode(access) === null
  ) {
    return null;
  }
  return JSON.stringify([
    access.configured_origin,
    access.network_mode,
    access.transport,
    access.authentication_state,
    access.device_id,
    access.permission,
    access.device_expires_at
  ]);
}

function sessionReadAccessFromAccess(
  access: SelectedAccessStateResponse
): SelectedSessionReadAccess {
  const mode = expectedAccessMode(access);
  if (mode === null) throw connectionError("client_contract");
  return Object.freeze({
    mode,
    network_mode: access.network_mode,
    transport: access.transport
  });
}

function catalogMissionData(
  source: BrowserSessionCatalogData,
  access: SelectedAccessStateResponse,
  previous: BrowserMissionControlData | null
): BrowserMissionControlData {
  const selectedAccess = sessionReadAccessFromAccess(access);
  if (
    previous !== null &&
    previous.sessions === source.sessions &&
    sameSessionAccess(previous.access, selectedAccess) &&
    !previous.hasMore &&
    previous.nextCursor === null &&
    previous.pageCount === 1
  ) {
    return previous;
  }
  return Object.freeze({
    kind: "mission_control",
    access: selectedAccess,
    sessions: source.sessions,
    nextCursor: null,
    hasMore: false,
    pageCount: 1
  });
}

function catalogStateFromSnapshot(
  previous: BrowserConnectionCatalogState,
  reducer: BrowserSessionCatalogReducerState,
  snapshot: BrowserSessionCatalogSseSnapshot,
  access: SelectedAccessStateResponse,
  failure: BrowserConnectionFailure | null
): BrowserConnectionCatalogState {
  const data = reducer.data === null
    ? null
    : catalogMissionData(reducer.data, access, previous.data);
  let state: BrowserConnectionCatalogState["state"];
  if (failure !== null || snapshot.phase === "failed") {
    state = data === null ? "failed" : "stale";
  } else if (
    reducer.phase === "boundary" ||
    snapshot.continuity === "boundary" ||
    snapshot.resetRequired
  ) {
    state = data === null ? "failed" : "stale";
  } else if (
    reducer.phase === "current" &&
    snapshot.phase === "connected"
  ) {
    state = "current";
  } else if (reducer.phase === "resetting") {
    state = "resetting";
  } else if (snapshot.phase === "reconnecting") {
    state = "reconnecting";
  } else if (snapshot.phase === "closed") {
    state = data === null ? "failed" : "stale";
  } else {
    state = "connecting";
  }
  return Object.freeze({
    state,
    data,
    snapshot,
    boundary: reducer.boundary,
    failure,
    observedAt: reducer.data?.observedAt ?? null
  });
}

function idleCatalog(): BrowserConnectionCatalogState {
  return Object.freeze({
    state: "idle",
    data: null,
    snapshot: null,
    boundary: null,
    failure: null,
    observedAt: null
  });
}

function blockedCatalog(): BrowserConnectionCatalogState {
  return Object.freeze({
    state: "blocked",
    data: null,
    snapshot: null,
    boundary: null,
    failure: null,
    observedAt: null
  });
}

function closedCatalog(): BrowserConnectionCatalogState {
  return Object.freeze({
    state: "closed",
    data: null,
    snapshot: null,
    boundary: null,
    failure: null,
    observedAt: null
  });
}

function failedCatalog(
  previous: BrowserConnectionCatalogState,
  failure: BrowserConnectionFailure
): BrowserConnectionCatalogState {
  return Object.freeze({
    state: previous.data === null ? "failed" : "stale",
    data: previous.data,
    snapshot: previous.snapshot,
    boundary: previous.boundary,
    failure,
    observedAt: previous.observedAt
  });
}

function mergeCatalogProjectionIntoDetail(
  current: SelectedSessionDetailResponse,
  item: BrowserMissionSessionItem
): SelectedSessionDetailResponse | null {
  if (
    current.session.session.id !== item.session.id ||
    current.session.session.codex_thread_id !== item.session.codex_thread_id
  ) {
    return null;
  }
  const nextProjection = Object.freeze({
    ...item.session,
    last_event_cursor: current.session.session.last_event_cursor
  });
  if (sameDetailProjection(current.session.session, nextProjection)) return current;
  const parsed = selectedSessionDetailResponseSchema.safeParse({
    access: current.access,
    session: {
      session: nextProjection,
      event_window: current.session.event_window
    }
  });
  return parsed.success ? parsed.data : null;
}

function sameDetailProjection(
  left: BrowserMissionSessionItem["session"],
  right: BrowserMissionSessionItem["session"]
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.codex_thread_id === right.codex_thread_id &&
    left.cwd === right.cwd &&
    left.runtime_source === right.runtime_source &&
    left.runtime_version === right.runtime_version &&
    left.created_at === right.created_at &&
    left.archived_at === right.archived_at &&
    left.session_state === right.session_state &&
    left.turn_state === right.turn_state &&
    left.attention === right.attention &&
    left.freshness === right.freshness &&
    left.freshness_reason === right.freshness_reason &&
    left.updated_at === right.updated_at &&
    left.last_activity_at === right.last_activity_at &&
    left.branch === right.branch &&
    left.model === right.model &&
    sameSessionSettings(left.settings, right.settings) &&
    sameGoalCue(left.goal, right.goal) &&
    left.recent_summary === right.recent_summary &&
    left.last_event_cursor === right.last_event_cursor
  );
}

function sameSessionSettings(
  left: BrowserMissionSessionItem["session"]["settings"],
  right: BrowserMissionSessionItem["session"]["settings"]
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.collaboration_mode === right.collaboration_mode &&
      left.runtime_model === right.runtime_model &&
      left.reasoning_effort === right.reasoning_effort &&
      left.observed_at === right.observed_at)
  );
}

function sameGoalCue(
  left: BrowserMissionSessionItem["session"]["goal"],
  right: BrowserMissionSessionItem["session"]["goal"]
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.objective === right.objective &&
      left.state === right.state)
  );
}

function boundaryFromTargetData(
  data: BrowserConnectionTargetData | null
): BrowserSseBoundary | null {
  if (data?.kind !== "session_detail") return null;
  const window = data.response.session.event_window;
  if (
    window.state !== "bounded" ||
    window.boundary_cursor === null ||
    window.earliest_retained_cursor === null
  ) {
    return null;
  }
  return Object.freeze({
    after: window.boundary_cursor,
    cursor: window.earliest_retained_cursor,
    reason: "retention"
  });
}

function readSessionStreamStart(
  options: BrowserConnectionSessionStreamOptions | undefined
): BrowserConnectionSessionStreamStart {
  if (options === undefined) return "live";
  const values = readExactRecord(options, streamOptionKeys, streamOptionKeys);
  if (values === null) throw connectionError("client_contract");
  const start = values.start;
  if (start !== "live" && start !== "recent") {
    throw connectionError("client_contract");
  }
  return start;
}

function sessionStreamAfter(
  response: SelectedSessionDetailResponse,
  start: BrowserConnectionSessionStreamStart
): number | null {
  const lastCursor = response.session.session.last_event_cursor;
  if (start === "live" || lastCursor === null) return lastCursor;
  return Math.max(0, lastCursor - selectedEventPageMaxSize);
}

function emptyResource<Data>(
  state: Extract<BrowserConnectionResourceState, "idle" | "blocked">
): BrowserConnectionResource<Data> {
  return Object.freeze({ state, data: null, failure: null, observedAt: null });
}

function loadingResource<Data>(
  previous: BrowserConnectionResource<Data>,
  retain: boolean
): BrowserConnectionResource<Data> {
  return Object.freeze({
    state: "loading",
    data: retain ? previous.data : null,
    failure: null,
    observedAt: retain ? previous.observedAt : null
  });
}

function currentResource<Data>(
  data: Data,
  observedAt: string
): BrowserConnectionResource<Data> {
  return Object.freeze({ state: "current", data, failure: null, observedAt });
}

function failedResource<Data>(
  failure: BrowserConnectionFailure
): BrowserConnectionResource<Data> {
  return Object.freeze({
    state: "failed",
    data: null,
    failure,
    observedAt: failure.observedAt
  });
}

function staleResource<Data>(
  data: Data,
  failure: BrowserConnectionFailure,
  observedAt: string | null
): BrowserConnectionResource<Data> {
  return Object.freeze({ state: "stale", data, failure, observedAt });
}

function retainOrFail<Data>(
  resource: BrowserConnectionResource<Data>,
  failure: BrowserConnectionFailure
): BrowserConnectionResource<Data> {
  return resource.data === null
    ? failedResource(failure)
    : staleResource(resource.data, failure, resource.observedAt);
}

function retainOrBlock<Data>(
  resource: BrowserConnectionResource<Data>,
  failure: BrowserConnectionFailure
): BrowserConnectionResource<Data> {
  return resource.data === null
    ? emptyResource("blocked")
    : staleResource(resource.data, failure, resource.observedAt);
}

function notFoundResource<Data>(
  failure: BrowserConnectionFailure
): BrowserConnectionResource<Data> {
  return Object.freeze({
    state: "not_found",
    data: null,
    failure,
    observedAt: failure.observedAt
  });
}

function notApplicableStream(): BrowserConnectionStreamState {
  return Object.freeze({
    state: "not_applicable",
    snapshot: null,
    continuity: "not_applicable",
    boundary: null,
    failure: null
  });
}

function idleStream(boundary: BrowserSseBoundary | null): BrowserConnectionStreamState {
  return Object.freeze({
    state: "idle",
    snapshot: null,
    continuity: boundary === null ? "unproven" : "boundary",
    boundary,
    failure: null
  });
}

function streamFromSnapshot(
  snapshot: BrowserSseSnapshot,
  initialBoundary: BrowserSseBoundary | null,
  failure: BrowserConnectionFailure | null
): BrowserConnectionStreamState {
  const boundary = snapshot.boundary ?? initialBoundary;
  const continuity = boundary === null ? snapshot.continuity : "boundary";
  const state = snapshot.phase === "failed" ? "failed" : snapshot.phase;
  return Object.freeze({ state, snapshot, continuity, boundary, failure });
}

function deriveWriteEligibility(
  access: BrowserConnectionResource<SelectedAccessStateResponse>,
  host: BrowserConnectionResource<SelectedHostStatusResponse>,
  csrf: BrowserCsrfSnapshot,
  hostLockTransition: BrowserConnectionHostLockTransition
): BrowserConnectionWriteEligibility {
  const causes: BrowserConnectionWriteBlockCause[] = [];
  const transitionCause = hostLockTransition === "pending"
    ? "host_lock_pending" as const
    : hostLockTransition === "unconfirmed"
      ? "host_lock_unconfirmed" as const
      : null;
  if (access.state !== "current" || access.data === null) {
    causes.push(
      access.failure?.apiError?.code === "permission_denied"
        ? "permission_denied"
        : "connection_not_current"
    );
  } else {
    const accessData = access.data;
    const expectedMode = expectedAccessMode(accessData);
    if (!accessData.can_read_sessions) {
      causes.push(accessCause(accessData));
    } else if (expectedMode !== "paired_write") {
      causes.push("read_only_access");
    } else {
      if (transitionCause !== null) causes.push(transitionCause);
      if (accessData.locked || !accessData.can_write_sessions) causes.push("host_locked");
      if (host.state !== "current" || host.data === null) {
        causes.push("host_status_unavailable");
      } else if (
        host.data.access.mode !== "paired_write" ||
        !host.data.access.write_eligibility.eligible ||
        host.data.local.mutation_admission !== "open"
      ) {
        causes.push("host_not_ready");
      }
      if (csrf.phase !== "ready") causes.push("csrf_not_ready");
    }
  }
  if (transitionCause !== null && !causes.includes(transitionCause)) {
    causes.push(transitionCause);
  }
  return Object.freeze({
    scope: "browser_shell",
    eligible: causes.length === 0,
    causes: Object.freeze(causes)
  });
}

function hostLockFailure(
  error: unknown,
  failureEpoch: number,
  observedAt: string
): BrowserConnectionFailure {
  if (error instanceof HostDeckBrowserCsrfError) {
    return csrfFailure(error, failureEpoch, observedAt);
  }
  return freezeFailure({
    source: "csrf",
    reason: "client_contract",
    routeId: "host_lock",
    transport: null,
    status: null,
    apiError: null,
    epoch: failureEpoch,
    observedAt
  });
}

function sameConnectionSnapshot(
  left: BrowserConnectionSnapshot,
  right: BrowserConnectionSnapshot
): boolean {
  return (
    left.epoch === right.epoch &&
    left.target === right.target &&
    left.phase === right.phase &&
    left.access === right.access &&
    left.host === right.host &&
    left.targetState === right.targetState &&
    left.catalog === right.catalog &&
    sameStreamState(left.stream, right.stream) &&
    left.csrf === right.csrf &&
    sameWriteEligibility(left.writeEligibility, right.writeEligibility) &&
    left.lastFailure === right.lastFailure
  );
}

function sameStreamState(
  left: BrowserConnectionStreamState,
  right: BrowserConnectionStreamState
): boolean {
  return (
    left.state === right.state &&
    left.snapshot === right.snapshot &&
    left.continuity === right.continuity &&
    sameBoundary(left.boundary, right.boundary) &&
    left.failure === right.failure
  );
}

function sameBoundary(
  left: BrowserSseBoundary | null,
  right: BrowserSseBoundary | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.after === right.after &&
      left.cursor === right.cursor &&
      left.reason === right.reason)
  );
}

function sameWriteEligibility(
  left: BrowserConnectionWriteEligibility,
  right: BrowserConnectionWriteEligibility
): boolean {
  return (
    left.eligible === right.eligible &&
    left.causes.length === right.causes.length &&
    left.causes.every((cause, index) => cause === right.causes[index])
  );
}

function accessCause(
  access: SelectedAccessStateResponse
): Extract<
  BrowserConnectionWriteBlockCause,
  "unpaired" | "invalid_device" | "expired_device" | "revoked_device" | "permission_denied"
> {
  switch (access.authentication_state) {
    case "unpaired":
      return "unpaired";
    case "invalid_device":
      return "invalid_device";
    case "expired_device":
      return "expired_device";
    case "revoked_device":
      return "revoked_device";
    default:
      return "permission_denied";
  }
}

function derivePhase(
  closed: boolean,
  target: BrowserConnectionTarget | null,
  access: BrowserConnectionResource<SelectedAccessStateResponse>,
  host: BrowserConnectionResource<SelectedHostStatusResponse>,
  targetState: BrowserConnectionResource<BrowserConnectionTargetData>,
  stream: BrowserConnectionStreamState,
  csrf: BrowserCsrfSnapshot
): BrowserConnectionPhase {
  if (closed) return "closed";
  if (target === null) return "idle";
  if (access.state === "loading" && access.data === null) return "loading";
  if (access.failure !== null) {
    if (fatalFailureReasons.includes(access.failure.reason)) return "fatal";
    if (connectivityFailureReasons.includes(access.failure.reason)) return "unreachable";
    if (access.failure.apiError?.code === "permission_denied") return "access_limited";
  }
  if (access.state === "current" && access.data !== null && !access.data.can_read_sessions) {
    return "access_limited";
  }
  if (targetState.state === "not_found") return "not_found";
  for (const failure of [
    host.failure,
    targetState.failure,
    stream.failure
  ]) {
    if (failure !== null && fatalFailureReasons.includes(failure.reason)) return "fatal";
  }
  if (csrf.phase === "failed") {
    return csrf.failure !== null && fatalFailureReasons.includes(csrf.failure.reason)
      ? "fatal"
      : "degraded";
  }
  const local = host.data?.local;
  if (local !== undefined) {
    const compatibility = local.components.find((entry) => entry.component === "compatibility");
    const runtime = local.components.find((entry) => entry.component === "runtime");
    if (compatibility?.causes.includes("runtime_incompatible") === true) return "incompatible";
    if (
      runtime?.causes.some((cause) =>
        ["runtime_starting", "runtime_disconnected", "runtime_reconciling", "runtime_failed"].includes(cause)
      ) === true
    ) {
      return "offline";
    }
    if (local.state === "failed") return "fatal";
    if (local.state !== "ready") return "degraded";
  }
  if (
    access.state === "stale" ||
    host.state === "stale" ||
    host.state === "failed" ||
    targetState.state === "stale" ||
    targetState.state === "failed" ||
    stream.state === "reconnecting" ||
    stream.state === "failed" ||
    stream.continuity === "boundary"
  ) {
    return "degraded";
  }
  if (targetState.state === "loading" && targetState.data === null) return "loading";
  if (targetState.state === "current") return "ready";
  return "degraded";
}

function isAuthorityFailure(failure: BrowserConnectionFailure): boolean {
  return (
    failure.reason === "api_error" &&
    (failure.apiError?.code === "permission_denied" ||
      failure.apiError?.code === "invalid_origin")
  );
}

function csrfFailure(
  error: unknown,
  failureEpoch: number,
  observedAt: string
): BrowserConnectionFailure {
  if (error instanceof HostDeckBrowserCsrfError) {
    return freezeFailure({
      source: "csrf",
      reason: error.reason,
      routeId: error.routeId,
      transport: error.transport,
      status: error.status,
      apiError: error.apiError,
      epoch: failureEpoch,
      observedAt
    });
  }
  return freezeFailure({
    source: "csrf",
    reason: "client_contract",
    routeId: null,
    transport: null,
    status: null,
    apiError: null,
    epoch: failureEpoch,
    observedAt
  });
}

function sseFailure(
  snapshot: BrowserSseSnapshot,
  failureEpoch: number,
  observedAt: string
): BrowserConnectionFailure {
  const failure = snapshot.failure;
  if (failure === null) {
    throw connectionError("client_contract");
  }
  return freezeFailure({
    source: "session_stream",
    reason: failure.reason,
    routeId: "session_event_stream",
    transport: failure.transport,
    status: failure.status,
    apiError: failure.apiError,
    epoch: failureEpoch,
    observedAt
  });
}

function catalogSseFailure(
  snapshot: BrowserSessionCatalogSseSnapshot,
  failureEpoch: number,
  observedAt: string
): BrowserConnectionFailure {
  const failure = snapshot.failure;
  if (failure === null) throw connectionError("client_contract");
  return freezeFailure({
    source: "session_catalog",
    reason: failure.reason,
    routeId: "session_catalog_stream",
    transport: failure.transport,
    status: failure.status,
    apiError: failure.apiError,
    epoch: failureEpoch,
    observedAt
  });
}

function catalogClientFailure(
  failureEpoch: number,
  observedAt: string,
  transport: BrowserHttpTransport
): BrowserConnectionFailure {
  return freezeFailure({
    source: "session_catalog",
    reason: "client_contract",
    routeId: "session_catalog_stream",
    transport,
    status: null,
    apiError: null,
    epoch: failureEpoch,
    observedAt
  });
}

function catalogSessionRemovedFailure(
  failureEpoch: number,
  observedAt: string,
  transport: BrowserHttpTransport
): BrowserConnectionFailure {
  return freezeFailure({
    source: "session_catalog",
    reason: "session_removed",
    routeId: "session_catalog_stream",
    transport,
    status: null,
    apiError: null,
    epoch: failureEpoch,
    observedAt
  });
}

function freezeFailure(
  input: BrowserConnectionFailure
): BrowserConnectionFailure {
  return Object.freeze({
    source: input.source,
    reason: input.reason,
    routeId: input.routeId,
    transport: input.transport,
    status: input.status,
    apiError: input.apiError,
    epoch: input.epoch,
    observedAt: input.observedAt
  });
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

function safeAbort(controller: AbortController): void {
  try {
    controller.abort();
  } catch {
    // AbortController.abort is specified as non-throwing; a hostile realm must not block cleanup.
  }
}

function connectionError(reason: BrowserConnectionErrorReason): HostDeckBrowserConnectionError {
  return new HostDeckBrowserConnectionError(reason);
}

function messageForConnectionError(reason: BrowserConnectionErrorReason): string {
  switch (reason) {
    case "client_contract":
      return "HostDeck browser connection contract failed.";
    case "not_ready":
      return "HostDeck browser connection is not ready.";
    case "closed":
      return "HostDeck browser connection coordinator is closed.";
  }
}
