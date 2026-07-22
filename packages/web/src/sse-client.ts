import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  outputCursorSchema,
  type SelectedProjectionEvent,
  selectedProjectionEventSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import {
  type BrowserSseClientLimits,
  browserSseResourceRanges,
  defaultBrowserSseClientLimits
} from "@hostdeck/contracts/browser-sse-resource-policy";
import {
  createParser,
  type EventSourceMessage
} from "eventsource-parser";
import {
  type BrowserTransport,
  readSelectedBrowserOrigin
} from "./browser-origin.js";
import { browserSseRouteContract } from "./sse-route-contract.js";

export const browserSseFailureReasons = [
  "connect_timeout",
  "idle_timeout",
  "transport_unavailable",
  "invalid_response",
  "response_too_large",
  "malformed_stream",
  "invalid_event",
  "duplicate_event",
  "out_of_order_event",
  "cursor_gap",
  "consumer_error",
  "api_error",
  "reconnect_exhausted"
] as const;

export const browserSseCloseReasons = [
  "caller_aborted",
  "client_closed",
  "route_changed",
  "unmounted"
] as const;

export type BrowserSseFailureReason =
  (typeof browserSseFailureReasons)[number];
export type BrowserSseCloseReason = (typeof browserSseCloseReasons)[number];
export type BrowserSsePhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";
export type BrowserSseContinuity = "unproven" | "contiguous" | "boundary";

export interface BrowserSseHeadersPort {
  readonly get: (name: string) => string | null;
}

export interface BrowserSseBodyReaderPort {
  readonly read: () => Promise<{
    readonly done: boolean;
    readonly value?: Uint8Array;
  }>;
  readonly cancel: () => Promise<void>;
  readonly releaseLock: () => void;
}

export interface BrowserSseBodyPort {
  readonly getReader: () => BrowserSseBodyReaderPort;
}

export interface BrowserSseResponsePort {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: BrowserSseHeadersPort;
  readonly body: BrowserSseBodyPort | null;
}

export interface BrowserSseRequestInit {
  readonly method: "GET";
  readonly headers: Readonly<{
    readonly accept: "text/event-stream";
    readonly "cache-control": "no-store";
  }>;
  readonly cache: "no-store";
  readonly credentials: "same-origin";
  readonly mode: "same-origin";
  readonly redirect: "error";
  readonly referrerPolicy: "no-referrer";
  readonly signal: AbortSignal;
}

export type BrowserSseFetchPort = (
  path: string,
  init: BrowserSseRequestInit
) => Promise<BrowserSseResponsePort>;

export interface BrowserSseClockPort {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface CreateBrowserSseClientOptions {
  readonly origin?: string;
  readonly fetch?: BrowserSseFetchPort;
  readonly clock?: BrowserSseClockPort;
  readonly limits?: BrowserSseClientLimits;
}

export interface BrowserSseConnectOptions {
  readonly sessionId: string;
  readonly after?: number | null;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: SelectedProjectionEvent) => unknown;
  readonly onState?: (snapshot: BrowserSseSnapshot) => unknown;
}

export interface BrowserSseBoundary {
  readonly after: number | null;
  readonly cursor: number;
  readonly reason: "retention" | "disconnect" | "restart" | "schema_change";
}

export interface BrowserSseFailure {
  readonly reason: BrowserSseFailureReason;
  readonly sessionId: string;
  readonly transport: BrowserTransport;
  readonly status: number | null;
  readonly apiError: ApiErrorEnvelope | null;
  readonly previousReason: Exclude<
    BrowserSseFailureReason,
    "reconnect_exhausted"
  > | null;
}

export interface BrowserSseSnapshot {
  readonly sessionId: string;
  readonly transport: BrowserTransport;
  readonly phase: BrowserSsePhase;
  readonly cursor: number | null;
  readonly continuity: BrowserSseContinuity;
  readonly boundary: BrowserSseBoundary | null;
  readonly retryCount: number;
  readonly retryAt: number | null;
  readonly lastHeartbeatAt: number | null;
  readonly lastEventAt: number | null;
  readonly failure: BrowserSseFailure | null;
  readonly closeReason: BrowserSseCloseReason | null;
}

export interface BrowserSseConnection {
  readonly snapshot: () => BrowserSseSnapshot;
  readonly close: (
    reason?: Exclude<BrowserSseCloseReason, "caller_aborted">
  ) => void;
}

export interface BrowserSseClient {
  readonly connect: (input: BrowserSseConnectOptions) => BrowserSseConnection;
  readonly close: () => void;
}

interface ParsedClientOptions {
  readonly fetch: BrowserSseFetchPort;
  readonly clock: BrowserSseClockPort;
  readonly limits: BrowserSseClientLimits;
  readonly transport: BrowserTransport;
}

interface ParsedConnectOptions {
  readonly sessionId: string;
  readonly after: number | null;
  readonly signal: AbortSignal | null;
  readonly onEvent: (event: SelectedProjectionEvent) => unknown;
  readonly onState: ((snapshot: BrowserSseSnapshot) => unknown) | null;
}

interface ResponseSnapshot {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: BrowserSseHeadersPort;
  readonly body: BrowserSseBodyPort | null;
}

type BodyReadSnapshot =
  | { readonly done: true }
  | {
      readonly done: false;
      readonly value: Uint8Array;
      readonly byteLength: number;
    };

interface TimerSlot {
  handle: unknown;
  active: boolean;
}

interface Attempt {
  readonly id: number;
  readonly controller: AbortController;
  readonly cancelled: Promise<never>;
  rejectCancelled: (() => void) | null;
  reader: BrowserSseBodyReaderPort | null;
  readerCompleted: boolean;
  connectTimer: TimerSlot | null;
  idleTimer: TimerSlot | null;
  idleFailure: Promise<never> | null;
  rejectIdle: (() => void) | null;
  cleaned: boolean;
  eventCount: number;
}

interface ConnectionRuntime {
  active: boolean;
  phase: BrowserSsePhase;
  cursor: number | null;
  continuity: BrowserSseContinuity;
  boundary: BrowserSseBoundary | null;
  retryCount: number;
  retryAt: number | null;
  lastHeartbeatAt: number | null;
  lastEventAt: number | null;
  failure: BrowserSseFailure | null;
  closeReason: BrowserSseCloseReason | null;
  snapshot: BrowserSseSnapshot;
  attempt: Attempt | null;
  backoffTimer: TimerSlot | null;
  attemptSequence: number;
  released: boolean;
}

class AttemptFailure extends Error {
  readonly reason: Exclude<BrowserSseFailureReason, "reconnect_exhausted">;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly apiError: ApiErrorEnvelope | null;

  constructor(
    reason: Exclude<BrowserSseFailureReason, "reconnect_exhausted">,
    retryable: boolean,
    status: number | null = null,
    apiError: ApiErrorEnvelope | null = null
  ) {
    super("HostDeck browser SSE attempt failed.");
    this.name = "AttemptFailure";
    this.reason = reason;
    this.retryable = retryable;
    this.status = status;
    this.apiError = apiError;
  }
}

class AttemptCancelled extends Error {
  constructor() {
    super("HostDeck browser SSE attempt was cancelled.");
    this.name = "AttemptCancelled";
  }
}

const createOptionKeys = ["origin", "fetch", "clock", "limits"] as const;
const connectOptionKeys = [
  "sessionId",
  "after",
  "signal",
  "onEvent",
  "onState"
] as const;
const requiredConnectOptionKeys = ["sessionId", "onEvent"] as const;
const clockKeys = ["now", "setTimeout", "clearTimeout"] as const;
const limitKeys = [
  "connectTimeoutMs",
  "idleTimeoutMs",
  "errorResponseMaxBytes",
  "eventMaxBytes",
  "reconnectInitialDelayMs",
  "reconnectMaxDelayMs",
  "maxReconnectAttempts",
  "maxConcurrentStreams"
] as const;
const eventStreamMediaTypePattern =
  /^text\/event-stream(?:\s*;\s*charset=utf-8)?\s*$/iu;
const jsonMediaTypePattern =
  /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/iu;
const canonicalDecimalPattern = /^(?:0|[1-9]\d*)$/u;
const canonicalEventFramePattern =
  /^id: (0|[1-9][0-9]{0,15})\nevent: ([a-z_]+)\ndata: ([^\n]+)\n\n$/u;
const heartbeatFrame = ": heartbeat\n\n";
const requestHeaders = Object.freeze({
  accept: "text/event-stream",
  "cache-control": "no-store"
} as const);

export function createBrowserSseClient(
  input: CreateBrowserSseClientOptions = {}
): BrowserSseClient {
  const options = readClientOptions(input);
  const activeSessionIds = new Set<string>();
  const activeConnections = new Set<BrowserSseConnection>();
  let closed = false;

  const client: BrowserSseClient = Object.freeze({
    connect(candidate: BrowserSseConnectOptions): BrowserSseConnection {
      if (closed) {
        throw new TypeError("HostDeck browser SSE client is closed.");
      }
      const connectionOptions = readConnectOptions(candidate);
      const alreadyAborted =
        connectionOptions.signal !== null &&
        readAbortSignalState(connectionOptions.signal);
      if (!alreadyAborted) {
        if (activeSessionIds.has(connectionOptions.sessionId)) {
          throw new TypeError(
            "HostDeck browser SSE session already has an active connection."
          );
        }
        if (activeSessionIds.size >= options.limits.maxConcurrentStreams) {
          throw new TypeError(
            "HostDeck browser SSE connection capacity is exhausted."
          );
        }
        activeSessionIds.add(connectionOptions.sessionId);
      }

      let connectionReference: BrowserSseConnection | null = null;
      const connection = createConnection(
        options,
        connectionOptions,
        alreadyAborted,
        () => {
          activeSessionIds.delete(connectionOptions.sessionId);
          if (connectionReference !== null) {
            activeConnections.delete(connectionReference);
          }
        }
      );
      connectionReference = connection;
      if (
        connection.snapshot().phase !== "failed" &&
        connection.snapshot().phase !== "closed"
      ) {
        activeConnections.add(connection);
      }
      return connection;
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const connection of [...activeConnections]) {
        connection.close("client_closed");
      }
      activeConnections.clear();
      activeSessionIds.clear();
    }
  });
  return client;
}

function createConnection(
  options: ParsedClientOptions,
  connectionOptions: ParsedConnectOptions,
  alreadyAborted: boolean,
  release: () => void
): BrowserSseConnection {
  const runtime: ConnectionRuntime = {
    active: true,
    phase: "connecting",
    cursor: connectionOptions.after,
    continuity: "unproven",
    boundary: null,
    retryCount: 0,
    retryAt: null,
    lastHeartbeatAt: null,
    lastEventAt: null,
    failure: null,
    closeReason: null,
    snapshot: createSnapshot({
      sessionId: connectionOptions.sessionId,
      transport: options.transport,
      phase: "connecting",
      cursor: connectionOptions.after,
      continuity: "unproven",
      boundary: null,
      retryCount: 0,
      retryAt: null,
      lastHeartbeatAt: null,
      lastEventAt: null,
      failure: null,
      closeReason: null
    }),
    attempt: null,
    backoffTimer: null,
    attemptSequence: 0,
    released: false
  };
  let callerAbortListener: (() => void) | null = null;

  const connection: BrowserSseConnection = Object.freeze({
    snapshot(): BrowserSseSnapshot {
      return runtime.snapshot;
    },
    close(
      reason: Exclude<BrowserSseCloseReason, "caller_aborted"> =
        "client_closed"
    ): void {
      if (
        reason !== "client_closed" &&
        reason !== "route_changed" &&
        reason !== "unmounted"
      ) {
        throw new TypeError("HostDeck browser SSE close reason is invalid.");
      }
      finishClosed(reason);
    }
  });

  const refreshSnapshot = (): void => {
    runtime.snapshot = createSnapshot({
      sessionId: connectionOptions.sessionId,
      transport: options.transport,
      phase: runtime.phase,
      cursor: runtime.cursor,
      continuity: runtime.continuity,
      boundary: runtime.boundary,
      retryCount: runtime.retryCount,
      retryAt: runtime.retryAt,
      lastHeartbeatAt: runtime.lastHeartbeatAt,
      lastEventAt: runtime.lastEventAt,
      failure: runtime.failure,
      closeReason: runtime.closeReason
    });
  };

  const releaseCapacity = (): void => {
    if (runtime.released) return;
    runtime.released = true;
    release();
  };

  const removeCallerAbortListener = (): void => {
    if (
      callerAbortListener === null ||
      connectionOptions.signal === null
    ) {
      return;
    }
    removeAbortSignalListener(
      connectionOptions.signal,
      callerAbortListener
    );
    callerAbortListener = null;
  };

  const stopActiveWork = (): void => {
    if (runtime.backoffTimer !== null) {
      clearTimer(options.clock, runtime.backoffTimer);
      runtime.backoffTimer = null;
    }
    if (runtime.attempt !== null) {
      cancelAttempt(runtime.attempt, options.clock);
      runtime.attempt = null;
    }
  };

  const setConsumerFailureWithoutNotification = (): void => {
    if (!runtime.active) return;
    runtime.active = false;
    runtime.phase = "failed";
    runtime.retryAt = null;
    runtime.closeReason = null;
    runtime.failure = createFailure(
      connectionOptions.sessionId,
      options.transport,
      new AttemptFailure("consumer_error", false)
    );
    stopActiveWork();
    removeCallerAbortListener();
    releaseCapacity();
    refreshSnapshot();
  };

  const notifyState = (): boolean => {
    refreshSnapshot();
    if (connectionOptions.onState === null) return runtime.active;
    try {
      const result = connectionOptions.onState(runtime.snapshot);
      if (isThenable(result)) {
        suppressPromiseRejection(result);
        setConsumerFailureWithoutNotification();
        return false;
      }
    } catch {
      setConsumerFailureWithoutNotification();
      return false;
    }
    return runtime.active;
  };

  const finishFailure = (attemptFailure: AttemptFailure): void => {
    if (!runtime.active) return;
    runtime.active = false;
    runtime.phase = "failed";
    runtime.retryAt = null;
    runtime.closeReason = null;
    runtime.failure = createFailure(
      connectionOptions.sessionId,
      options.transport,
      attemptFailure
    );
    stopActiveWork();
    removeCallerAbortListener();
    releaseCapacity();
    notifyState();
  };

  const finishExhausted = (
    previousReason: Exclude<BrowserSseFailureReason, "reconnect_exhausted">
  ): void => {
    if (!runtime.active) return;
    runtime.active = false;
    runtime.phase = "failed";
    runtime.retryAt = null;
    runtime.closeReason = null;
    runtime.failure = createExhaustedFailure(
      connectionOptions.sessionId,
      options.transport,
      previousReason
    );
    stopActiveWork();
    removeCallerAbortListener();
    releaseCapacity();
    notifyState();
  };

  function finishClosed(reason: BrowserSseCloseReason): void {
    if (!runtime.active) return;
    runtime.active = false;
    runtime.phase = "closed";
    runtime.retryAt = null;
    runtime.failure = null;
    runtime.closeReason = reason;
    stopActiveWork();
    removeCallerAbortListener();
    releaseCapacity();
    refreshSnapshot();
    if (connectionOptions.onState !== null) {
      try {
        const result = connectionOptions.onState(runtime.snapshot);
        if (isThenable(result)) suppressPromiseRejection(result);
      } catch {
        // Explicit cancellation remains authoritative over observer failure.
      }
    }
  }

  const markActivity = (
    kind: "heartbeat" | "event",
    observedAt: number
  ): void => {
    runtime.retryCount = 0;
    runtime.retryAt = null;
    runtime.failure = null;
    if (runtime.boundary === null) runtime.continuity = "contiguous";
    if (kind === "heartbeat") {
      runtime.lastHeartbeatAt = observedAt;
    } else {
      runtime.lastEventAt = observedAt;
    }
  };

  const deliverHeartbeat = (attempt: Attempt): void => {
    if (!runtime.active || runtime.attempt !== attempt) {
      throw new AttemptCancelled();
    }
    const observedAt = readNow(options.clock);
    armIdleDeadline(attempt, options.clock, options.limits.idleTimeoutMs);
    markActivity("heartbeat", observedAt);
    notifyState();
    if (!runtime.active) throw new AttemptCancelled();
  };

  const deliverEvent = (
    attempt: Attempt,
    message: EventSourceMessage
  ): void => {
    if (!runtime.active || runtime.attempt !== attempt) {
      throw new AttemptCancelled();
    }
    const event = parseEventMessage(
      message,
      connectionOptions.sessionId,
      runtime.cursor
    );
    validateEventContinuity(event, runtime, attempt);
    const observedAt = readNow(options.clock);
    invokeEventConsumer(connectionOptions.onEvent, event);
    if (!runtime.active || runtime.attempt !== attempt) {
      throw new AttemptCancelled();
    }
    runtime.cursor = event.cursor;
    attempt.eventCount += 1;
    if (event.type === "replay_boundary") {
      runtime.boundary = Object.freeze({
        after: event.after,
        cursor: event.cursor,
        reason: event.reason
      });
      runtime.continuity = "boundary";
    }
    armIdleDeadline(attempt, options.clock, options.limits.idleTimeoutMs);
    markActivity("event", observedAt);
    notifyState();
    if (!runtime.active) throw new AttemptCancelled();
  };

  const runAttempt = async (): Promise<void> => {
    if (!runtime.active) return;
    const attempt = createAttempt(runtime.attemptSequence + 1);
    runtime.attemptSequence = attempt.id;
    runtime.attempt = attempt;
    let failure: AttemptFailure | null = null;
    try {
      const connectFailure = armConnectDeadline(
        attempt,
        options.clock,
        options.limits.connectTimeoutMs
      );
      const path = buildStreamPath(
        connectionOptions.sessionId,
        runtime.cursor
      );
      const fetchOperation = invokeFetch(
        options.fetch,
        path,
        attempt.controller.signal
      );
      void fetchOperation.then(
        (candidate) => {
          if (attempt.cleaned || runtime.attempt !== attempt) {
            cancelResponseCandidate(candidate);
          }
        },
        () => undefined
      );
      const responseCandidate = await Promise.race([
        fetchOperation,
        connectFailure,
        attempt.cancelled
      ]);
      const response = snapshotResponse(responseCandidate);
      if (response === null) {
        cancelResponseCandidate(responseCandidate);
        throw new AttemptFailure("invalid_response", false);
      }
      if (response.status === 200) {
        const reader = acceptEventStreamResponse(response);
        attempt.reader = reader;
        clearConnectDeadline(attempt, options.clock);
        armIdleDeadline(
          attempt,
          options.clock,
          options.limits.idleTimeoutMs
        );
        runtime.phase = "connected";
        runtime.retryAt = null;
        notifyState();
        if (!runtime.active) throw new AttemptCancelled();
        await consumeEventStream(
          attempt,
          reader,
          options.limits.eventMaxBytes,
          deliverHeartbeat,
          deliverEvent
        );
        throw new AttemptFailure("transport_unavailable", true);
      }
      if (response.status < 400 || response.status > 599) {
        cancelBody(response.body);
        throw new AttemptFailure(
          "invalid_response",
          false,
          response.status
        );
      }
      const apiError = await readApiErrorResponse(
        attempt,
        response,
        options.limits.errorResponseMaxBytes,
        connectFailure
      );
      throw new AttemptFailure(
        "api_error",
        apiError.retryable,
        response.status,
        apiError
      );
    } catch (error) {
      if (!(error instanceof AttemptCancelled)) {
        failure =
          error instanceof AttemptFailure
            ? error
            : new AttemptFailure("consumer_error", false);
      }
    } finally {
      cleanupAttempt(attempt, options.clock);
      if (runtime.attempt === attempt) runtime.attempt = null;
    }
    if (!runtime.active || failure === null) return;
    if (!failure.retryable) {
      finishFailure(failure);
      return;
    }
    const nextRetry = runtime.retryCount + 1;
    if (nextRetry > options.limits.maxReconnectAttempts) {
      finishExhausted(failure.reason);
      return;
    }
    runtime.retryCount = nextRetry;
    runtime.phase = "reconnecting";
    runtime.closeReason = null;
    runtime.failure = createFailure(
      connectionOptions.sessionId,
      options.transport,
      failure
    );
    let delayMs: number;
    let retryAt: number;
    try {
      delayMs = reconnectDelay(options.limits, nextRetry);
      retryAt = checkedAdd(readNow(options.clock), delayMs);
    } catch {
      finishFailure(new AttemptFailure("consumer_error", false));
      return;
    }
    runtime.retryAt = retryAt;
    if (!notifyState()) return;
    try {
      runtime.backoffTimer = scheduleTimer(options.clock, () => {
        runtime.backoffTimer = null;
        if (!runtime.active) return;
        runtime.retryAt = null;
        notifyState();
        if (runtime.active) launchAttempt();
      }, delayMs);
    } catch {
      finishFailure(new AttemptFailure("consumer_error", false));
    }
  };

  const launchAttempt = (): void => {
    if (!runtime.active) return;
    void runAttempt().catch(() => {
      finishFailure(new AttemptFailure("consumer_error", false));
    });
  };

  if (connectionOptions.signal !== null) {
    callerAbortListener = () => finishClosed("caller_aborted");
    addAbortSignalListener(
      connectionOptions.signal,
      callerAbortListener
    );
  }
  if (alreadyAborted) {
    finishClosed("caller_aborted");
    return connection;
  }
  if (!notifyState()) return connection;
  if (
    connectionOptions.signal !== null &&
    readAbortSignalState(connectionOptions.signal)
  ) {
    finishClosed("caller_aborted");
    return connection;
  }
  queueMicrotask(launchAttempt);
  return connection;
}

function readClientOptions(candidate: unknown): ParsedClientOptions {
  const values = readExactRecord(candidate, [], createOptionKeys);
  if (values === null) {
    throw new TypeError("HostDeck browser SSE client options are invalid.");
  }
  const origin = readSelectedBrowserOrigin(values.origin);
  return Object.freeze({
    fetch: readFetchPort(values.fetch),
    clock: readClockPort(values.clock),
    limits: readLimits(values.limits),
    transport: origin.transport
  });
}

function readConnectOptions(candidate: unknown): ParsedConnectOptions {
  const values = readExactRecord(
    candidate,
    requiredConnectOptionKeys,
    connectOptionKeys
  );
  if (values === null) {
    throw new TypeError("HostDeck browser SSE connection options are invalid.");
  }
  const session = safeParse(sessionIdSchema, values.sessionId);
  const afterCandidate = values.after === undefined ? null : values.after;
  const after =
    afterCandidate === null
      ? ({ ok: true, value: null } as const)
      : safeParse(outputCursorSchema, afterCandidate);
  if (
    !session.ok ||
    typeof session.value !== "string" ||
    !after.ok ||
    (after.value !== null && typeof after.value !== "number") ||
    typeof values.onEvent !== "function" ||
    (values.onState !== undefined && typeof values.onState !== "function") ||
    (values.signal !== undefined && !isAbortSignal(values.signal))
  ) {
    throw new TypeError("HostDeck browser SSE connection options are invalid.");
  }
  return Object.freeze({
    sessionId: session.value,
    after: after.value,
    signal: (values.signal as AbortSignal | undefined) ?? null,
    onEvent: values.onEvent as (event: SelectedProjectionEvent) => unknown,
    onState:
      (values.onState as
        | ((snapshot: BrowserSseSnapshot) => unknown)
        | undefined) ?? null
  });
}

function readFetchPort(candidate: unknown): BrowserSseFetchPort {
  if (candidate !== undefined) {
    if (typeof candidate !== "function") {
      throw new TypeError("HostDeck browser SSE fetch port is invalid.");
    }
    return candidate as BrowserSseFetchPort;
  }
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("HostDeck browser fetch is unavailable.");
  }
  return (path, init) =>
    globalThis.fetch(
      path,
      init as RequestInit
    ) as Promise<BrowserSseResponsePort>;
}

function readClockPort(candidate: unknown): BrowserSseClockPort {
  if (candidate === undefined) {
    return Object.freeze({
      now: () => Date.now(),
      setTimeout: (callback: () => void, delayMs: number) =>
        globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    });
  }
  const values = readExactRecord(candidate, clockKeys, clockKeys);
  if (
    values === null ||
    typeof values.now !== "function" ||
    typeof values.setTimeout !== "function" ||
    typeof values.clearTimeout !== "function"
  ) {
    throw new TypeError("HostDeck browser SSE clock port is invalid.");
  }
  const source = candidate as object;
  const now = values.now as () => unknown;
  const setTimeoutPort = values.setTimeout as (
    callback: () => void,
    delayMs: number
  ) => unknown;
  const clearTimeoutPort = values.clearTimeout as (handle: unknown) => void;
  const clock = Object.freeze({
    now: () => Reflect.apply(now, source, []) as number,
    setTimeout: (callback: () => void, delayMs: number) =>
      Reflect.apply(setTimeoutPort, source, [callback, delayMs]) as unknown,
    clearTimeout: (handle: unknown) => {
      Reflect.apply(clearTimeoutPort, source, [handle]);
    }
  });
  try {
    readNow(clock);
  } catch {
    throw new TypeError("HostDeck browser SSE clock port is invalid.");
  }
  return clock;
}

function readLimits(candidate: unknown): BrowserSseClientLimits {
  if (candidate === undefined) return defaultBrowserSseClientLimits;
  const values = readExactRecord(candidate, limitKeys, limitKeys);
  if (values === null) {
    throw new TypeError("HostDeck browser SSE limits are invalid.");
  }
  const ranges = {
    connectTimeoutMs: browserSseResourceRanges.connectTimeoutMs,
    idleTimeoutMs: browserSseResourceRanges.idleTimeoutMs,
    errorResponseMaxBytes: browserSseResourceRanges.errorResponseMaxBytes,
    eventMaxBytes: browserSseResourceRanges.eventMaxBytes,
    reconnectInitialDelayMs:
      browserSseResourceRanges.reconnectInitialDelayMs,
    reconnectMaxDelayMs: browserSseResourceRanges.reconnectMaxDelayMs,
    maxReconnectAttempts: browserSseResourceRanges.maxReconnectAttempts,
    maxConcurrentStreams: browserSseResourceRanges.maxConcurrentStreams
  } as const;
  const limits: Record<(typeof limitKeys)[number], number> = Object.create(null);
  for (const key of limitKeys) {
    const value = values[key];
    const range = ranges[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < range.minimum ||
      value > range.maximum
    ) {
      throw new TypeError("HostDeck browser SSE limits are invalid.");
    }
    limits[key] = value;
  }
  if (limits.reconnectInitialDelayMs > limits.reconnectMaxDelayMs) {
    throw new TypeError("HostDeck browser SSE limits are invalid.");
  }
  return Object.freeze({
    connectTimeoutMs: limits.connectTimeoutMs,
    idleTimeoutMs: limits.idleTimeoutMs,
    errorResponseMaxBytes: limits.errorResponseMaxBytes,
    eventMaxBytes: limits.eventMaxBytes,
    reconnectInitialDelayMs: limits.reconnectInitialDelayMs,
    reconnectMaxDelayMs: limits.reconnectMaxDelayMs,
    maxReconnectAttempts: limits.maxReconnectAttempts,
    maxConcurrentStreams: limits.maxConcurrentStreams
  });
}

function createSnapshot(input: BrowserSseSnapshot): BrowserSseSnapshot {
  return Object.freeze({
    sessionId: input.sessionId,
    transport: input.transport,
    phase: input.phase,
    cursor: input.cursor,
    continuity: input.continuity,
    boundary: input.boundary,
    retryCount: input.retryCount,
    retryAt: input.retryAt,
    lastHeartbeatAt: input.lastHeartbeatAt,
    lastEventAt: input.lastEventAt,
    failure: input.failure,
    closeReason: input.closeReason
  });
}

function createFailure(
  sessionId: string,
  transport: BrowserTransport,
  failure: AttemptFailure
): BrowserSseFailure {
  return Object.freeze({
    reason: failure.reason,
    sessionId,
    transport,
    status: failure.status,
    apiError: failure.apiError,
    previousReason: null
  });
}

function createExhaustedFailure(
  sessionId: string,
  transport: BrowserTransport,
  previousReason: Exclude<BrowserSseFailureReason, "reconnect_exhausted">
): BrowserSseFailure {
  return Object.freeze({
    reason: "reconnect_exhausted",
    sessionId,
    transport,
    status: null,
    apiError: null,
    previousReason
  });
}

function buildStreamPath(sessionId: string, after: number | null): string {
  const base = browserSseRouteContract.path.replace(
    ":session_id",
    encodeURIComponent(sessionId)
  );
  return after === null ? base : `${base}?after=${String(after)}`;
}

async function invokeFetch(
  fetchPort: BrowserSseFetchPort,
  path: string,
  signal: AbortSignal
): Promise<BrowserSseResponsePort> {
  const init: BrowserSseRequestInit = Object.freeze({
    method: "GET",
    headers: requestHeaders,
    cache: "no-store",
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal
  });
  try {
    return await Promise.resolve(fetchPort(path, init));
  } catch {
    throw new AttemptFailure("transport_unavailable", true);
  }
}

function snapshotResponse(candidate: unknown): ResponseSnapshot | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const value = candidate as Partial<BrowserSseResponsePort>;
    const status = value.status;
    const ok = value.ok;
    const headers = value.headers;
    const body = value.body;
    if (
      typeof status !== "number" ||
      !Number.isSafeInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof ok !== "boolean" ||
      ok !== (status >= 200 && status < 300) ||
      headers === null ||
      typeof headers !== "object" ||
      body === undefined ||
      (body !== null && typeof body !== "object")
    ) {
      return null;
    }
    const getHeader = headers.get;
    const getReader = body === null ? null : body.getReader;
    if (
      typeof getHeader !== "function" ||
      (body !== null && typeof getReader !== "function")
    ) {
      return null;
    }
    return Object.freeze({
      status,
      ok,
      headers: Object.freeze({
        get: (name: string) =>
          Reflect.apply(getHeader, headers, [name]) as string | null
      }),
      body:
        body === null
          ? null
          : Object.freeze({
              getReader: () =>
                Reflect.apply(
                  getReader as BrowserSseBodyPort["getReader"],
                  body,
                  []
                )
            })
    });
  } catch {
    return null;
  }
}

function acceptEventStreamResponse(
  response: ResponseSnapshot
): BrowserSseBodyReaderPort {
  let contentType: string | null;
  try {
    contentType = response.headers.get("content-type");
  } catch {
    cancelBody(response.body);
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  if (
    typeof contentType !== "string" ||
    !eventStreamMediaTypePattern.test(contentType) ||
    response.body === null
  ) {
    cancelBody(response.body);
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  let readerCandidate: unknown;
  try {
    readerCandidate = response.body.getReader();
  } catch {
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  const reader = snapshotBodyReader(readerCandidate);
  if (reader === null) {
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  return reader;
}

function createAttempt(id: number): Attempt {
  let rejectCancelled: ((error: AttemptCancelled) => void) | null = null;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  void cancelled.catch(() => undefined);
  return {
    id,
    controller: new AbortController(),
    cancelled,
    rejectCancelled: () => rejectCancelled?.(new AttemptCancelled()),
    reader: null,
    readerCompleted: false,
    connectTimer: null,
    idleTimer: null,
    idleFailure: null,
    rejectIdle: null,
    cleaned: false,
    eventCount: 0
  };
}

function cancelAttempt(attempt: Attempt, clock: BrowserSseClockPort): void {
  if (!attempt.cleaned) {
    attempt.rejectCancelled?.();
    attempt.rejectCancelled = null;
    abortController(attempt.controller);
  }
  cleanupAttempt(attempt, clock);
}

function cleanupAttempt(attempt: Attempt, clock: BrowserSseClockPort): void {
  if (attempt.cleaned) return;
  attempt.cleaned = true;
  if (attempt.connectTimer !== null) {
    clearTimer(clock, attempt.connectTimer);
    attempt.connectTimer = null;
  }
  if (attempt.idleTimer !== null) {
    clearTimer(clock, attempt.idleTimer);
    attempt.idleTimer = null;
  }
  attempt.rejectIdle = null;
  attempt.rejectCancelled?.();
  attempt.rejectCancelled = null;
  abortController(attempt.controller);
  if (attempt.reader !== null) {
    if (!attempt.readerCompleted) cancelReader(attempt.reader);
    releaseReader(attempt.reader);
    attempt.reader = null;
  }
}

function armConnectDeadline(
  attempt: Attempt,
  clock: BrowserSseClockPort,
  delayMs: number
): Promise<never> {
  let rejectFailure: ((failure: AttemptFailure) => void) | null = null;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);
  attempt.connectTimer = scheduleTimer(clock, () => {
    abortController(attempt.controller);
    rejectFailure?.(new AttemptFailure("connect_timeout", true));
    rejectFailure = null;
  }, delayMs);
  return failure;
}

function clearConnectDeadline(
  attempt: Attempt,
  clock: BrowserSseClockPort
): void {
  if (attempt.connectTimer === null) return;
  const timer = attempt.connectTimer;
  attempt.connectTimer = null;
  if (!clearTimer(clock, timer)) {
    throw new AttemptFailure("consumer_error", false);
  }
}

function armIdleDeadline(
  attempt: Attempt,
  clock: BrowserSseClockPort,
  delayMs: number
): void {
  if (attempt.idleFailure === null) {
    let rejectFailure: ((failure: AttemptFailure) => void) | null = null;
    attempt.idleFailure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    attempt.rejectIdle = () => {
      abortController(attempt.controller);
      rejectFailure?.(new AttemptFailure("idle_timeout", true));
      rejectFailure = null;
    };
    void attempt.idleFailure.catch(() => undefined);
  }
  if (attempt.idleTimer !== null) {
    const previous = attempt.idleTimer;
    attempt.idleTimer = null;
    if (!clearTimer(clock, previous)) {
      throw new AttemptFailure("consumer_error", false);
    }
  }
  attempt.idleTimer = scheduleTimer(clock, () => {
    attempt.rejectIdle?.();
    attempt.rejectIdle = null;
  }, delayMs);
}

function scheduleTimer(
  clock: BrowserSseClockPort,
  callback: () => void,
  delayMs: number
): TimerSlot {
  const slot: TimerSlot = { handle: undefined, active: true };
  let returned = false;
  let firedBeforeReturn = false;
  const wrapped = () => {
    if (!returned) firedBeforeReturn = true;
    if (!slot.active) return;
    slot.active = false;
    callback();
  };
  try {
    slot.handle = clock.setTimeout(wrapped, delayMs);
    returned = true;
  } catch {
    slot.active = false;
    throw new AttemptFailure("consumer_error", false);
  }
  if (firedBeforeReturn) {
    slot.active = false;
    throw new AttemptFailure("consumer_error", false);
  }
  return slot;
}

function clearTimer(clock: BrowserSseClockPort, slot: TimerSlot): boolean {
  if (!slot.active) return true;
  slot.active = false;
  try {
    clock.clearTimeout(slot.handle);
    return true;
  } catch {
    return false;
  }
}

function readNow(clock: BrowserSseClockPort): number {
  let value: unknown;
  try {
    value = clock.now();
  } catch {
    throw new AttemptFailure("consumer_error", false);
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new AttemptFailure("consumer_error", false);
  }
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AttemptFailure("consumer_error", false);
  }
  return value;
}

function reconnectDelay(
  limits: BrowserSseClientLimits,
  retryCount: number
): number {
  let delay = limits.reconnectInitialDelayMs;
  for (let index = 1; index < retryCount; index += 1) {
    delay = Math.min(delay * 2, limits.reconnectMaxDelayMs);
  }
  return delay;
}

function abortController(controller: AbortController): void {
  try {
    controller.abort();
  } catch {
    // Cancellation cleanup must remain idempotent.
  }
}

function snapshotBodyReader(candidate: unknown): BrowserSseBodyReaderPort | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const value = candidate as Partial<BrowserSseBodyReaderPort>;
    const read = value.read;
    const cancel = value.cancel;
    const releaseLock = value.releaseLock;
    if (
      typeof read !== "function" ||
      typeof cancel !== "function" ||
      typeof releaseLock !== "function"
    ) {
      return null;
    }
    return Object.freeze({
      read: () =>
        Reflect.apply(read, candidate, []) as ReturnType<
          BrowserSseBodyReaderPort["read"]
        >,
      cancel: () =>
        Reflect.apply(cancel, candidate, []) as Promise<void>,
      releaseLock: () => {
        Reflect.apply(releaseLock, candidate, []);
      }
    });
  } catch {
    return null;
  }
}

function snapshotBodyRead(candidate: unknown): BodyReadSnapshot | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const value = candidate as {
      readonly done?: unknown;
      readonly value?: unknown;
    };
    const done = value.done;
    if (done === true) return Object.freeze({ done: true });
    if (done !== false || !(value.value instanceof Uint8Array)) return null;
    const byteLength = readUint8ArrayByteLength(value.value);
    if (byteLength <= 0) return null;
    return Object.freeze({
      done: false,
      value: value.value,
      byteLength
    });
  } catch {
    return null;
  }
}

async function invokeReaderRead(
  reader: BrowserSseBodyReaderPort
): Promise<unknown> {
  try {
    return await Promise.resolve(reader.read());
  } catch {
    throw new AttemptFailure("transport_unavailable", true);
  }
}

function cancelResponseCandidate(candidate: unknown): void {
  const response = snapshotResponse(candidate);
  if (response !== null) cancelBody(response.body);
}

function cancelBody(body: BrowserSseBodyPort | null): void {
  if (body === null) return;
  let readerCandidate: unknown;
  try {
    readerCandidate = body.getReader();
  } catch {
    return;
  }
  const reader = snapshotBodyReader(readerCandidate);
  if (reader === null) return;
  cancelReader(reader);
  releaseReader(reader);
}

function cancelReader(reader: BrowserSseBodyReaderPort): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Cancellation details are deliberately not retained or exposed.
  }
}

function releaseReader(reader: BrowserSseBodyReaderPort): void {
  try {
    reader.releaseLock();
  } catch {
    // Cleanup failure must not replace the bounded terminal state.
  }
}

async function readApiErrorResponse(
  attempt: Attempt,
  response: ResponseSnapshot,
  maximumBytes: number,
  connectFailure: Promise<never>
): Promise<ApiErrorEnvelope> {
  let contentType: string | null;
  let declaredLength: string | null;
  try {
    contentType = response.headers.get("content-type");
    declaredLength = response.headers.get("content-length");
  } catch {
    cancelBody(response.body);
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  if (
    typeof contentType !== "string" ||
    !jsonMediaTypePattern.test(contentType) ||
    response.body === null
  ) {
    cancelBody(response.body);
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  let expectedLength: number | null = null;
  if (declaredLength !== null) {
    if (
      !canonicalDecimalPattern.test(declaredLength) ||
      !Number.isSafeInteger(Number(declaredLength))
    ) {
      cancelBody(response.body);
      throw new AttemptFailure("invalid_response", false, response.status);
    }
    expectedLength = Number(declaredLength);
    if (expectedLength > maximumBytes) {
      cancelBody(response.body);
      throw new AttemptFailure("response_too_large", false, response.status);
    }
  }
  let readerCandidate: unknown;
  try {
    readerCandidate = response.body.getReader();
  } catch {
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  const reader = snapshotBodyReader(readerCandidate);
  if (reader === null) {
    throw new AttemptFailure("invalid_response", false, response.status);
  }
  attempt.reader = reader;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const candidate = await Promise.race([
        invokeReaderRead(reader),
        connectFailure,
        attempt.cancelled
      ]);
      const read = snapshotBodyRead(candidate);
      if (read === null) {
        throw new AttemptFailure("invalid_response", false, response.status);
      }
      if (read.done) {
        attempt.readerCompleted = true;
        break;
      }
      totalBytes += read.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
        throw new AttemptFailure(
          "response_too_large",
          false,
          response.status
        );
      }
      chunks.push(read.value);
    }
    if (expectedLength !== null && expectedLength !== totalBytes) {
      throw new AttemptFailure("invalid_response", false, response.status);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += readUint8ArrayByteLength(chunk);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AttemptFailure("invalid_response", false, response.status);
    } finally {
      zeroBytes(bytes);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AttemptFailure("invalid_response", false, response.status);
    }
    const parsed = safeParse(apiRouteErrorBodySchema, json);
    if (
      !parsed.ok ||
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      !("error" in parsed.value)
    ) {
      throw new AttemptFailure("invalid_response", false, response.status);
    }
    return deepFreeze(
      (parsed.value as { readonly error: ApiErrorEnvelope }).error
    );
  } finally {
    for (const chunk of chunks) zeroBytes(chunk);
  }
}

async function consumeEventStream(
  attempt: Attempt,
  reader: BrowserSseBodyReaderPort,
  maximumBytes: number,
  onHeartbeat: (attempt: Attempt) => void,
  onEvent: (attempt: Attempt, message: EventSourceMessage) => void
): Promise<void> {
  let callbackCount = 0;
  let pending = "";
  const parser = createParser({
    maxBufferSize: maximumBytes,
    onComment(comment) {
      callbackCount += 1;
      if (comment !== "heartbeat") {
        throw new AttemptFailure("malformed_stream", false);
      }
      onHeartbeat(attempt);
    },
    onEvent(message) {
      callbackCount += 1;
      onEvent(attempt, message);
    },
    onRetry() {
      throw new AttemptFailure("malformed_stream", false);
    },
    onError() {
      throw new AttemptFailure("malformed_stream", false);
    }
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const segmentBytes = Math.min(maximumBytes, 16_384);

  const feedFrame = (frame: string): void => {
    if (encodedByteLength(frame) > maximumBytes) {
      throw new AttemptFailure("malformed_stream", false);
    }
    if (
      frame !== heartbeatFrame &&
      canonicalEventFramePattern.exec(frame) === null
    ) {
      throw new AttemptFailure("malformed_stream", false);
    }
    const before = callbackCount;
    try {
      parser.feed(frame);
    } catch (error) {
      if (error instanceof AttemptFailure || error instanceof AttemptCancelled) {
        throw error;
      }
      throw new AttemptFailure("malformed_stream", false);
    }
    if (callbackCount !== before + 1) {
      throw new AttemptFailure("malformed_stream", false);
    }
  };

  const feedDecoded = (text: string): void => {
    if (text.includes("\r") || text.includes("\0")) {
      throw new AttemptFailure("malformed_stream", false);
    }
    pending += text;
    while (true) {
      const boundary = pending.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = pending.slice(0, boundary + 2);
      pending = pending.slice(boundary + 2);
      feedFrame(frame);
    }
    if (encodedByteLength(pending) > maximumBytes) {
      throw new AttemptFailure("malformed_stream", false);
    }
  };

  while (true) {
    const candidate = await Promise.race([
      invokeReaderRead(reader),
      attempt.idleFailure as Promise<never>,
      attempt.cancelled
    ]);
    const read = snapshotBodyRead(candidate);
    if (read === null) {
      throw new AttemptFailure("malformed_stream", false);
    }
    if (read.done) {
      attempt.readerCompleted = true;
      let tail: string;
      try {
        tail = decoder.decode();
      } catch {
        throw new AttemptFailure("malformed_stream", false);
      }
      if (tail.length > 0) feedDecoded(tail);
      if (pending.length > 0) {
        throw new AttemptFailure("malformed_stream", false);
      }
      return;
    }
    try {
      for (let offset = 0; offset < read.byteLength; offset += segmentBytes) {
        const end = Math.min(offset + segmentBytes, read.byteLength);
        const segment = Reflect.apply(
          Uint8Array.prototype.subarray,
          read.value,
          [offset, end]
        ) as Uint8Array;
        let decoded: string;
        try {
          decoded = decoder.decode(segment, { stream: true });
        } catch {
          throw new AttemptFailure("malformed_stream", false);
        }
        if (decoded.length > 0) feedDecoded(decoded);
      }
    } finally {
      zeroBytes(read.value);
    }
  }
}

function parseEventMessage(
  message: EventSourceMessage,
  expectedSessionId: string,
  _currentCursor: number | null
): SelectedProjectionEvent {
  if (
    typeof message.id !== "string" ||
    typeof message.event !== "string" ||
    typeof message.data !== "string" ||
    !canonicalDecimalPattern.test(message.id)
  ) {
    throw new AttemptFailure("invalid_event", false);
  }
  const cursor = safeParse(outputCursorSchema, Number(message.id));
  if (!cursor.ok || typeof cursor.value !== "number") {
    throw new AttemptFailure("invalid_event", false);
  }
  let json: unknown;
  try {
    json = JSON.parse(message.data);
  } catch {
    throw new AttemptFailure("invalid_event", false);
  }
  const parsed = safeParse(selectedProjectionEventSchema, json);
  if (!parsed.ok) {
    throw new AttemptFailure("invalid_event", false);
  }
  const event = parsed.value as SelectedProjectionEvent;
  if (
    event.cursor !== cursor.value ||
    event.type !== message.event ||
    event.session_id !== expectedSessionId
  ) {
    throw new AttemptFailure("invalid_event", false);
  }
  return deepFreeze(event);
}

function validateEventContinuity(
  event: SelectedProjectionEvent,
  runtime: ConnectionRuntime,
  attempt: Attempt
): void {
  const current = runtime.cursor;
  if (current !== null) {
    if (event.cursor === current) {
      throw new AttemptFailure("duplicate_event", false);
    }
    if (event.cursor < current) {
      throw new AttemptFailure("out_of_order_event", false);
    }
  }
  if (event.type === "replay_boundary") {
    if (
      attempt.eventCount !== 0 ||
      runtime.boundary !== null ||
      event.after !== current ||
      (current === null && event.cursor < 1)
    ) {
      throw new AttemptFailure("invalid_event", false);
    }
    return;
  }
  const expected = (current ?? 0) + 1;
  if (!Number.isSafeInteger(expected) || event.cursor !== expected) {
    throw new AttemptFailure("cursor_gap", false);
  }
}

function invokeEventConsumer(
  consumer: (event: SelectedProjectionEvent) => unknown,
  event: SelectedProjectionEvent
): void {
  let result: unknown;
  try {
    result = consumer(event);
  } catch {
    throw new AttemptFailure("consumer_error", false);
  }
  if (isThenable(result)) {
    suppressPromiseRejection(result);
    throw new AttemptFailure("consumer_error", false);
  }
}

function isThenable(candidate: unknown): boolean {
  if (
    candidate === null ||
    (typeof candidate !== "object" && typeof candidate !== "function")
  ) {
    return false;
  }
  try {
    return typeof Reflect.get(candidate, "then") === "function";
  } catch {
    return true;
  }
}

function suppressPromiseRejection(candidate: unknown): void {
  if (!(candidate instanceof Promise)) return;
  try {
    void candidate.catch(() => undefined);
  } catch {
    // The returned value already violated the synchronous consumer port.
  }
}

function readExactRecord(
  candidate: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !allowedKeys.includes(key) ||
          descriptors[key] === undefined ||
          !descriptors[key].enumerable ||
          !("value" in descriptors[key])
      ) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => [key, descriptors[key as string]?.value])
      )
    );
  } catch {
    return null;
  }
}

function safeParse(
  schema: { readonly safeParse: (value: unknown) => unknown },
  value: unknown
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const result = schema.safeParse(value) as
      | { readonly success: true; readonly data: unknown }
      | { readonly success: false };
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  if (candidate === null || typeof candidate !== "object") return false;
  try {
    readAbortSignalState(candidate as AbortSignal);
    return true;
  } catch {
    return false;
  }
}

function readAbortSignalState(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted"
  )?.get;
  if (typeof getter !== "function") {
    throw new TypeError("AbortSignal state is unavailable.");
  }
  const aborted = Reflect.apply(getter, signal, []) as unknown;
  if (typeof aborted !== "boolean") {
    throw new TypeError("AbortSignal state is invalid.");
  }
  return aborted;
}

function addAbortSignalListener(
  signal: AbortSignal,
  listener: () => void
): void {
  Reflect.apply(EventTarget.prototype.addEventListener, signal, [
    "abort",
    listener,
    { once: true }
  ]);
}

function removeAbortSignalListener(
  signal: AbortSignal,
  listener: () => void
): void {
  try {
    Reflect.apply(EventTarget.prototype.removeEventListener, signal, [
      "abort",
      listener
    ]);
  } catch {
    // Listener cleanup cannot replace the connection's terminal state.
  }
}

function readUint8ArrayByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype
  ) as object;
  const getter = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "byteLength"
  )?.get;
  if (typeof getter !== "function") {
    throw new TypeError("Uint8Array byte length is unavailable.");
  }
  const byteLength = Reflect.apply(getter, value, []) as unknown;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength)) {
    throw new TypeError("Uint8Array byte length is invalid.");
  }
  return byteLength;
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function zeroBytes(value: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(value, 0);
  } catch {
    // Detached or immutable test buffers are no longer retained by the client.
  }
}

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
