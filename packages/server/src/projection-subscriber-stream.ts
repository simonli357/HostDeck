import {
  assertResolvedResourceBudget,
  outputCursorSchema,
  type ResourceBudget,
  type SelectedProjectionEvent,
  selectedDeviceIdSchema,
  selectedProjectionEventSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { OutputCursor } from "@hostdeck/core";
import {
  registerHostDeckSseSourceLifecycle,
  selectedProjectionSseWireByteLength
} from "./fastify-sse-source.js";
import type {
  ProjectionReplayLiveHandoff,
  ProjectionReplayLiveHandoffService
} from "./projection-replay-live-handoff.js";

export type ProjectionSubscriberErrorCode =
  | "aborted"
  | "concurrent_iteration"
  | "invalid_config"
  | "invalid_input"
  | "queue_overflow"
  | "service_closed"
  | "session_archived"
  | "source_failed"
  | "subscriber_device_limit"
  | "subscriber_exists"
  | "subscriber_global_limit"
  | "subscriber_session_limit";

export class HostDeckProjectionSubscriberError extends Error {
  constructor(readonly code: ProjectionSubscriberErrorCode) {
    super(errorMessages[code]);
    this.name = "HostDeckProjectionSubscriberError";
    Object.freeze(this);
  }
}

export type ProjectionSubscriberFailureCode = Extract<
  ProjectionSubscriberErrorCode,
  "concurrent_iteration" | "queue_overflow" | "session_archived" | "source_failed"
>;

export interface ProjectionSubscriberFailure {
  readonly code: ProjectionSubscriberFailureCode;
  readonly cursor: OutputCursor | null;
}

export type ProjectionSubscriberFailureObserver = (
  failure: ProjectionSubscriberFailure
) => void;

export type ProjectionSubscriberStreamState = "closed" | "failed" | "open";

export interface ProjectionSubscriberStream
  extends AsyncIterable<SelectedProjectionEvent> {
  readonly after: OutputCursor | null;
  readonly close: () => boolean;
  readonly failure: ProjectionSubscriberFailure | null;
  readonly queued_event_count: number;
  readonly queued_wire_bytes: number;
  readonly remaining_replay_event_count: number;
  readonly remaining_replay_wire_bytes: number;
  readonly replay_event_count: number;
  readonly session_id: string;
  readonly state: ProjectionSubscriberStreamState;
  readonly subscriber_id: string;
}

export interface OpenProjectionSubscriberStreamInput {
  readonly after: number | null;
  readonly authorization: unknown;
  readonly device_id: string | null;
  readonly session_id: string;
  readonly signal: AbortSignal;
  readonly subscriber_id: string;
}

export interface CreateProjectionSubscriberStreamServiceInput {
  readonly handoff: ProjectionReplayLiveHandoffService;
  readonly observe_failure: ProjectionSubscriberFailureObserver;
  readonly resource_budget: ResourceBudget;
}

export interface ProjectionSubscriberStreamSnapshot {
  readonly aborted_subscribers: number;
  readonly active_device_buckets: number;
  readonly active_session_buckets: number;
  readonly active_subscribers: number;
  readonly admission_rejections: number;
  readonly archived_subscribers: number;
  readonly closed: boolean;
  readonly explicit_closures: number;
  readonly observer_failures: number;
  readonly opened_subscribers: number;
  readonly overflowed_subscribers: number;
  readonly peak_queued_events: number;
  readonly peak_queued_wire_bytes: number;
  readonly peak_replay_events: number;
  readonly peak_replay_wire_bytes: number;
  readonly peak_retained_events: number;
  readonly peak_retained_wire_bytes: number;
  readonly queued_events: number;
  readonly queued_wire_bytes: number;
  readonly replay_events: number;
  readonly replay_wire_bytes: number;
  readonly retained_events: number;
  readonly retained_wire_bytes: number;
  readonly service_closed_subscribers: number;
  readonly source_failed_subscribers: number;
  readonly source_open_failures: number;
}

export interface ProjectionSubscriberStreamService {
  readonly archive_session: (sessionId: unknown) => number;
  readonly close: () => number;
  readonly open: (input: unknown) => ProjectionSubscriberStream;
  readonly snapshot: () => ProjectionSubscriberStreamSnapshot;
}

interface ParsedServiceInput {
  readonly handoff: ProjectionReplayLiveHandoffService;
  readonly observeFailure: ProjectionSubscriberFailureObserver;
  readonly resourceBudget: ResourceBudget;
}

interface ParsedOpenInput {
  readonly after: OutputCursor | null;
  readonly authorization: unknown;
  readonly deviceId: string | null;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly subscriberId: string;
}

interface QueuedEvent {
  readonly event: SelectedProjectionEvent;
  readonly wireBytes: number;
}

interface ReplayEventNode extends QueuedEvent {
  readonly next: ReplayEventNode | null;
}

interface ValidatedReplayClaim {
  readonly eventCount: number;
  readonly head: ReplayEventNode | null;
  readonly wireBytes: number;
}

interface ValidatedOpenedHandoff {
  readonly handoff: ProjectionReplayLiveHandoff;
  readonly replay: ValidatedReplayClaim;
}

interface PendingRead {
  readonly reject: (reason: HostDeckProjectionSubscriberError) => void;
  readonly resolve: (result: IteratorResult<SelectedProjectionEvent>) => void;
}

interface MutableCounters {
  abortedSubscribers: number;
  admissionRejections: number;
  archivedSubscribers: number;
  explicitClosures: number;
  observerFailures: number;
  openedSubscribers: number;
  overflowedSubscribers: number;
  peakQueuedEvents: number;
  peakQueuedWireBytes: number;
  peakReplayEvents: number;
  peakReplayWireBytes: number;
  peakRetainedEvents: number;
  peakRetainedWireBytes: number;
  queuedEvents: number;
  queuedWireBytes: number;
  replayEvents: number;
  replayWireBytes: number;
  serviceClosedSubscribers: number;
  sourceFailedSubscribers: number;
  sourceOpenFailures: number;
}

type ClosedReason = "aborted" | "explicit" | "open_failed" | "service_closed";
type TerminalState =
  | { readonly kind: "closed"; readonly reason: ClosedReason }
  | { readonly kind: "failed"; readonly failure: ProjectionSubscriberFailure };

interface SubscriberRecord {
  readonly controller: AbortController;
  deviceId: string | null;
  readonly externalSignal: AbortSignal;
  readonly onExternalAbort: () => void;
  readonly sessionId: string;
  readonly subscriberId: string;
  abortListenerAttached: boolean;
  clearBuffered: () => void;
  handoff: ProjectionReplayLiveHandoff | null;
  removeHandoffAbortListener: () => void;
  settlePending: (terminal: TerminalState) => void;
  terminal: TerminalState | null;
}

interface ServiceRuntime {
  readonly counters: MutableCounters;
  readonly deviceCounts: Map<string, number>;
  readonly parsed: ParsedServiceInput;
  readonly sessions: Map<string, Set<SubscriberRecord>>;
  readonly subscribers: Map<string, SubscriberRecord>;
  closed: boolean;
}

const acceptedServices = new WeakSet<object>();
const subscriberIdPattern = /^[a-zA-Z0-9_.:-]{1,120}$/u;
const errorMessages: Readonly<Record<ProjectionSubscriberErrorCode, string>> =
  Object.freeze({
    aborted: "Projection subscriber request was aborted.",
    concurrent_iteration: "Projection subscriber already has an active iterator.",
    invalid_config: "Projection subscriber service configuration is invalid.",
    invalid_input: "Projection subscriber open input is invalid.",
    queue_overflow: "Projection subscriber queue capacity was exceeded.",
    service_closed: "Projection subscriber service is closed.",
    session_archived: "Projection subscriber session was archived.",
    source_failed: "Projection subscriber source failed.",
    subscriber_device_limit: "Projection subscriber device capacity is exhausted.",
    subscriber_exists: "Projection subscriber id already exists.",
    subscriber_global_limit: "Projection subscriber capacity is exhausted.",
    subscriber_session_limit: "Projection subscriber session capacity is exhausted."
  });

export function createProjectionSubscriberStreamService(
  input: CreateProjectionSubscriberStreamServiceInput
): ProjectionSubscriberStreamService {
  const runtime: ServiceRuntime = {
    closed: false,
    counters: {
      abortedSubscribers: 0,
      admissionRejections: 0,
      archivedSubscribers: 0,
      explicitClosures: 0,
      observerFailures: 0,
      openedSubscribers: 0,
      overflowedSubscribers: 0,
      peakQueuedEvents: 0,
      peakQueuedWireBytes: 0,
      peakReplayEvents: 0,
      peakReplayWireBytes: 0,
      peakRetainedEvents: 0,
      peakRetainedWireBytes: 0,
      queuedEvents: 0,
      queuedWireBytes: 0,
      replayEvents: 0,
      replayWireBytes: 0,
      serviceClosedSubscribers: 0,
      sourceFailedSubscribers: 0,
      sourceOpenFailures: 0
    },
    deviceCounts: new Map(),
    parsed: parseServiceInput(input),
    sessions: new Map(),
    subscribers: new Map()
  };
  const service = Object.freeze({
    archive_session(sessionId: unknown) {
      const parsedSessionId = parseSessionId(sessionId);
      const records = [...(runtime.sessions.get(parsedSessionId) ?? [])];
      let closed = 0;
      for (const record of records) {
        if (
          terminateRecord(runtime, record, {
            kind: "failed",
            failure: failure("session_archived", null)
          })
        ) {
          closed = increment(closed);
        }
      }
      return closed;
    },
    close() {
      if (runtime.closed) return 0;
      runtime.closed = true;
      const records = [...runtime.subscribers.values()];
      let closed = 0;
      for (const record of records) {
        if (
          terminateRecord(runtime, record, {
            kind: "closed",
            reason: "service_closed"
          })
        ) {
          closed = increment(closed);
        }
      }
      return closed;
    },
    open(candidate: unknown) {
      return openStream(runtime, parseOpenInput(candidate));
    },
    snapshot() {
      return snapshot(runtime);
    }
  });
  acceptedServices.add(service);
  return service;
}

export function assertProjectionSubscriberStreamService(
  candidate: unknown
): asserts candidate is ProjectionSubscriberStreamService {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedServices.has(candidate)
  ) {
    throw new TypeError(
      "Projection subscriber stream service must be created by createProjectionSubscriberStreamService."
    );
  }
}

function openStream(
  runtime: ServiceRuntime,
  input: ParsedOpenInput
): ProjectionSubscriberStream {
  if (input.signal.aborted) {
    throw new HostDeckProjectionSubscriberError("aborted");
  }
  admit(runtime, input);
  const controller = new AbortController();
  const record: SubscriberRecord = {
    abortListenerAttached: true,
    clearBuffered: () => undefined,
    controller,
    deviceId: input.deviceId,
    externalSignal: input.signal,
    handoff: null,
    onExternalAbort: () => {
      terminateRecord(runtime, record, { kind: "closed", reason: "aborted" });
    },
    removeHandoffAbortListener: () => undefined,
    sessionId: input.sessionId,
    settlePending: () => undefined,
    subscriberId: input.subscriberId,
    terminal: null
  };
  reserve(runtime, record);
  input.signal.addEventListener("abort", record.onExternalAbort, { once: true });
  const handoffSignal = AbortSignal.any([input.signal, controller.signal]);

  let handoff: ProjectionReplayLiveHandoff;
  let replay: ValidatedReplayClaim;
  try {
    const candidate = runtime.parsed.handoff.open({
      after: input.after,
      authorization: input.authorization,
      session_id: input.sessionId,
      signal: handoffSignal,
      subscriber_id: input.subscriberId
    });
    try {
      const opened = requireOpenedHandoff(candidate, input, runtime.parsed.resourceBudget);
      handoff = opened.handoff;
      replay = opened.replay;
    } catch (error) {
      closeUnownedHandoff(candidate);
      throw error;
    }
    if (record.terminal !== null) {
      closeUnownedHandoff(handoff);
      throw terminalError(record.terminal);
    }
    record.handoff = handoff;
    const onHandoffAbort = () => {
      terminateRecord(runtime, record, {
        kind: "failed",
        failure: failure("source_failed", handoff.failure?.cursor ?? null)
      });
    };
    handoff.signal.addEventListener("abort", onHandoffAbort, { once: true });
    record.removeHandoffAbortListener = () => {
      handoff.signal.removeEventListener("abort", onHandoffAbort);
      record.removeHandoffAbortListener = () => undefined;
    };
    if (handoff.signal.aborted) onHandoffAbort();
  } catch (error) {
    runtime.counters.sourceOpenFailures = increment(
      runtime.counters.sourceOpenFailures
    );
    if (record.terminal === null) {
      terminateRecord(
        runtime,
        record,
        error instanceof HostDeckProjectionSubscriberError &&
          error.code === "source_failed"
          ? {
              kind: "failed",
              failure: failure("source_failed", null)
            }
          : { kind: "closed", reason: "open_failed" }
      );
    }
    const terminal = currentTerminal(record);
    if (terminal?.kind === "failed") {
      throw new HostDeckProjectionSubscriberError(terminal.failure.code);
    }
    throw error;
  }

  if (record.terminal !== null) {
    runtime.counters.sourceOpenFailures = increment(
      runtime.counters.sourceOpenFailures
    );
    throw terminalError(record.terminal);
  }

  let stream: ReturnType<typeof createStream>;
  try {
    stream = createStream(runtime, record, handoff, replay, input.after);
  } catch {
    runtime.counters.sourceOpenFailures = increment(
      runtime.counters.sourceOpenFailures
    );
    terminateRecord(runtime, record, {
      kind: "failed",
      failure: failure("source_failed", handoff.failure?.cursor ?? null)
    });
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  if (record.terminal !== null) throw terminalError(record.terminal);
  try {
    handoff.activate({ on_event: stream.accept });
  } catch (error) {
    runtime.counters.sourceOpenFailures = increment(
      runtime.counters.sourceOpenFailures
    );
    if (record.terminal === null) {
      terminateRecord(runtime, record, {
        kind: "failed",
        failure: failure("source_failed", handoff.failure?.cursor ?? null)
      });
    }
    const terminal = currentTerminal(record);
    if (terminal !== null) throw terminalError(terminal);
    throw error;
  }
  if (record.terminal !== null) throw terminalError(record.terminal);
  runtime.counters.openedSubscribers = increment(
    runtime.counters.openedSubscribers
  );
  return stream.publicStream;
}

function createStream(
  runtime: ServiceRuntime,
  record: SubscriberRecord,
  handoff: ProjectionReplayLiveHandoff,
  replay: ValidatedReplayClaim,
  after: OutputCursor | null
): {
  readonly accept: (event: SelectedProjectionEvent) => void;
  readonly publicStream: ProjectionSubscriberStream;
} {
  let acceptedLiveCursor = handoff.high_water_cursor;
  let iteratorClaimed = false;
  let pending: PendingRead | null = null;
  let queuedWireBytes = 0;
  let replayHead = replay.head;
  let replayWireBytes = replay.wireBytes;
  const initialReplayEventCount = replay.eventCount;
  let remainingReplayEvents = initialReplayEventCount;
  const queue: QueuedEvent[] = [];

  const settlePending = (terminal: TerminalState): void => {
    const current = pending;
    if (current === null) return;
    pending = null;
    if (terminal.kind === "failed") {
      current.reject(new HostDeckProjectionSubscriberError(terminal.failure.code));
    } else {
      current.resolve(doneResult());
    }
  };
  const clearBuffered = (): void => {
    if (queue.length > 0 || queuedWireBytes > 0) {
      removeQueuedTotals(runtime, queue.length, queuedWireBytes);
    }
    queue.length = 0;
    queuedWireBytes = 0;
    if (remainingReplayEvents > 0 || replayWireBytes > 0) {
      removeReplayTotals(runtime, remainingReplayEvents, replayWireBytes);
    }
    replayHead = null;
    remainingReplayEvents = 0;
    replayWireBytes = 0;
  };
  record.clearBuffered = clearBuffered;
  record.settlePending = settlePending;
  addReplayTotals(runtime, initialReplayEventCount, replayWireBytes);

  const failStream = (
    code: ProjectionSubscriberFailureCode,
    cursor: OutputCursor | null
  ): void => {
    terminateRecord(runtime, record, {
      kind: "failed",
      failure: failure(code, cursor)
    });
  };
  const accept = (candidate: SelectedProjectionEvent): void => {
    if (record.terminal !== null) return;
    let cursor: OutputCursor | null = null;
    try {
      const parsed = selectedProjectionEventSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.session_id !== record.sessionId) {
        failStream("source_failed", null);
        return;
      }
      const event = deepFreeze(parsed.data);
      cursor = event.cursor;
      if (event.cursor !== (acceptedLiveCursor ?? 0) + 1) {
        failStream("source_failed", event.cursor);
        return;
      }
      const wireBytes = selectedProjectionSseWireByteLength(event);
      if (wireBytes > runtime.parsed.resourceBudget.sse_event_max_bytes) {
        failStream("source_failed", event.cursor);
        return;
      }
      const currentPending = pending;
      if (currentPending !== null) {
        pending = null;
        acceptedLiveCursor = event.cursor;
        currentPending.resolve({ done: false, value: event });
        return;
      }
      if (
        queue.length >= runtime.parsed.resourceBudget.sse_queue_max_events ||
        wireBytes >
          runtime.parsed.resourceBudget.sse_queue_max_bytes - queuedWireBytes
      ) {
        failStream("queue_overflow", event.cursor);
        return;
      }
      queue.push(Object.freeze({ event, wireBytes }));
      queuedWireBytes += wireBytes;
      acceptedLiveCursor = event.cursor;
      addQueuedTotals(runtime, wireBytes);
    } catch {
      failStream("source_failed", cursor);
    }
  };

  const iterator: AsyncIterator<SelectedProjectionEvent> = Object.freeze({
    next(): Promise<IteratorResult<SelectedProjectionEvent>> {
      const terminal = record.terminal;
      if (terminal !== null) return terminalResult(terminal);
      const replayEntry = replayHead;
      if (replayEntry !== null) {
        if (replayEntry.wireBytes > replayWireBytes) {
          throw new Error("Projection subscriber replay accounting is inconsistent.");
        }
        replayHead = replayEntry.next;
        remainingReplayEvents -= 1;
        replayWireBytes -= replayEntry.wireBytes;
        removeReplayTotals(runtime, 1, replayEntry.wireBytes);
        if (remainingReplayEvents === 0) {
          if (replayWireBytes !== 0) {
            throw new Error("Projection subscriber replay accounting is inconsistent.");
          }
          replayHead = null;
        }
        return Promise.resolve({ done: false, value: replayEntry.event });
      }
      const queued = queue.shift();
      if (queued !== undefined) {
        queuedWireBytes -= queued.wireBytes;
        removeQueuedTotals(runtime, 1, queued.wireBytes);
        return Promise.resolve({ done: false, value: queued.event });
      }
      if (pending !== null) {
        failStream("concurrent_iteration", acceptedLiveCursor);
        return Promise.reject(
          new HostDeckProjectionSubscriberError("concurrent_iteration")
        );
      }
      return new Promise<IteratorResult<SelectedProjectionEvent>>(
        (resolve, reject) => {
          pending = { reject, resolve };
        }
      );
    },
    return(): Promise<IteratorResult<SelectedProjectionEvent>> {
      terminateRecord(runtime, record, { kind: "closed", reason: "explicit" });
      return Promise.resolve(doneResult());
    },
    throw(): Promise<IteratorResult<SelectedProjectionEvent>> {
      failStream("source_failed", acceptedLiveCursor);
      return Promise.reject(
        new HostDeckProjectionSubscriberError("source_failed")
      );
    }
  });

  const stream: ProjectionSubscriberStream = {
    [Symbol.asyncIterator]() {
      if (iteratorClaimed) {
        failStream("concurrent_iteration", acceptedLiveCursor);
        throw new HostDeckProjectionSubscriberError("concurrent_iteration");
      }
      iteratorClaimed = true;
      return iterator;
    },
    after,
    close() {
      return terminateRecord(runtime, record, {
        kind: "closed",
        reason: "explicit"
      });
    },
    get failure() {
      return record.terminal?.kind === "failed"
        ? record.terminal.failure
        : null;
    },
    get queued_event_count() {
      return queue.length;
    },
    get queued_wire_bytes() {
      return queuedWireBytes;
    },
    get remaining_replay_event_count() {
      return remainingReplayEvents;
    },
    get remaining_replay_wire_bytes() {
      return replayWireBytes;
    },
    replay_event_count: initialReplayEventCount,
    session_id: record.sessionId,
    get state(): ProjectionSubscriberStreamState {
      if (record.terminal === null) return "open";
      return record.terminal.kind === "failed" ? "failed" : "closed";
    },
    subscriber_id: record.subscriberId
  };
  const publicStream = registerHostDeckSseSourceLifecycle({
    iterable: stream,
    signal: record.controller.signal
  });
  Object.freeze(publicStream);
  return Object.freeze({ accept, publicStream });
}

function admit(runtime: ServiceRuntime, input: ParsedOpenInput): void {
  let code: ProjectionSubscriberErrorCode | null = null;
  if (runtime.closed) code = "service_closed";
  else if (runtime.subscribers.has(input.subscriberId)) code = "subscriber_exists";
  else if (
    runtime.subscribers.size >= runtime.parsed.resourceBudget.sse_max_subscribers
  ) {
    code = "subscriber_global_limit";
  } else if (
    input.deviceId !== null &&
    (runtime.deviceCounts.get(input.deviceId) ?? 0) >=
      runtime.parsed.resourceBudget.sse_max_subscribers_per_device
  ) {
    code = "subscriber_device_limit";
  } else if (
    (runtime.sessions.get(input.sessionId)?.size ?? 0) >=
    runtime.parsed.resourceBudget.sse_max_subscribers_per_session
  ) {
    code = "subscriber_session_limit";
  }
  if (code !== null) {
    runtime.counters.admissionRejections = increment(
      runtime.counters.admissionRejections
    );
    throw new HostDeckProjectionSubscriberError(code);
  }
}

function reserve(runtime: ServiceRuntime, record: SubscriberRecord): void {
  runtime.subscribers.set(record.subscriberId, record);
  const session = runtime.sessions.get(record.sessionId) ?? new Set();
  session.add(record);
  runtime.sessions.set(record.sessionId, session);
  if (record.deviceId !== null) {
    runtime.deviceCounts.set(
      record.deviceId,
      (runtime.deviceCounts.get(record.deviceId) ?? 0) + 1
    );
  }
}

function terminateRecord(
  runtime: ServiceRuntime,
  record: SubscriberRecord,
  terminal: TerminalState
): boolean {
  if (record.terminal !== null) return false;
  record.terminal = terminal;
  record.clearBuffered();
  record.settlePending(terminal);
  const handoff = record.handoff;
  record.handoff = null;
  record.removeHandoffAbortListener();
  let handoffCloseFailed = false;
  if (handoff !== null) {
    try {
      handoff.close();
    } catch {
      handoffCloseFailed = true;
    }
  }
  if (record.abortListenerAttached) {
    record.abortListenerAttached = false;
    record.externalSignal.removeEventListener("abort", record.onExternalAbort);
  }
  release(runtime, record);
  record.controller.abort(sourceTerminationReason(terminal));
  recordTerminal(runtime, terminal);
  if (handoffCloseFailed) {
    const closeFailure = failure("source_failed", null);
    runtime.counters.sourceFailedSubscribers = increment(
      runtime.counters.sourceFailedSubscribers
    );
    observeFailure(runtime, closeFailure);
  }
  return true;
}

function release(runtime: ServiceRuntime, record: SubscriberRecord): void {
  if (runtime.subscribers.get(record.subscriberId) !== record) return;
  runtime.subscribers.delete(record.subscriberId);
  const session = runtime.sessions.get(record.sessionId);
  session?.delete(record);
  if (session?.size === 0) runtime.sessions.delete(record.sessionId);
  const deviceId = record.deviceId;
  record.deviceId = null;
  if (deviceId !== null) {
    const count = runtime.deviceCounts.get(deviceId);
    if (count === undefined || count < 1) {
      throw new Error("Projection subscriber device accounting is inconsistent.");
    }
    if (count === 1) runtime.deviceCounts.delete(deviceId);
    else runtime.deviceCounts.set(deviceId, count - 1);
  }
}

function recordTerminal(runtime: ServiceRuntime, terminal: TerminalState): void {
  if (terminal.kind === "closed") {
    switch (terminal.reason) {
      case "aborted":
        runtime.counters.abortedSubscribers = increment(
          runtime.counters.abortedSubscribers
        );
        return;
      case "explicit":
        runtime.counters.explicitClosures = increment(
          runtime.counters.explicitClosures
        );
        return;
      case "open_failed":
        return;
      case "service_closed":
        runtime.counters.serviceClosedSubscribers = increment(
          runtime.counters.serviceClosedSubscribers
        );
        return;
    }
  }
  switch (terminal.failure.code) {
    case "queue_overflow":
      runtime.counters.overflowedSubscribers = increment(
        runtime.counters.overflowedSubscribers
      );
      break;
    case "session_archived":
      runtime.counters.archivedSubscribers = increment(
        runtime.counters.archivedSubscribers
      );
      break;
    case "concurrent_iteration":
    case "source_failed":
      runtime.counters.sourceFailedSubscribers = increment(
        runtime.counters.sourceFailedSubscribers
      );
      break;
  }
  observeFailure(runtime, terminal.failure);
}

function observeFailure(
  runtime: ServiceRuntime,
  failureObservation: ProjectionSubscriberFailure
): void {
  try {
    const result: unknown = runtime.parsed.observeFailure(failureObservation);
    if (result !== undefined) {
      runtime.counters.observerFailures = increment(
        runtime.counters.observerFailures
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
      }
    }
  } catch {
    runtime.counters.observerFailures = increment(
      runtime.counters.observerFailures
    );
  }
}

function addQueuedTotals(runtime: ServiceRuntime, wireBytes: number): void {
  const events = checkedTotal(runtime.counters.queuedEvents, 1);
  const bytes = checkedTotal(runtime.counters.queuedWireBytes, wireBytes);
  assertAggregateRetention(runtime, events, bytes, runtime.counters.replayEvents, runtime.counters.replayWireBytes);
  runtime.counters.queuedEvents = events;
  runtime.counters.queuedWireBytes = bytes;
  runtime.counters.peakQueuedEvents = Math.max(
    runtime.counters.peakQueuedEvents,
    runtime.counters.queuedEvents
  );
  runtime.counters.peakQueuedWireBytes = Math.max(
    runtime.counters.peakQueuedWireBytes,
    runtime.counters.queuedWireBytes
  );
  updateRetainedPeaks(runtime);
}

function removeQueuedTotals(
  runtime: ServiceRuntime,
  events: number,
  wireBytes: number
): void {
  if (
    events < 0 ||
    wireBytes < 0 ||
    events > runtime.counters.queuedEvents ||
    wireBytes > runtime.counters.queuedWireBytes
  ) {
    throw new Error("Projection subscriber queue accounting is inconsistent.");
  }
  runtime.counters.queuedEvents -= events;
  runtime.counters.queuedWireBytes -= wireBytes;
}

function addReplayTotals(
  runtime: ServiceRuntime,
  events: number,
  wireBytes: number
): void {
  const totalEvents = checkedTotal(runtime.counters.replayEvents, events);
  const totalBytes = checkedTotal(runtime.counters.replayWireBytes, wireBytes);
  assertAggregateRetention(
    runtime,
    runtime.counters.queuedEvents,
    runtime.counters.queuedWireBytes,
    totalEvents,
    totalBytes
  );
  runtime.counters.replayEvents = totalEvents;
  runtime.counters.replayWireBytes = totalBytes;
  runtime.counters.peakReplayEvents = Math.max(
    runtime.counters.peakReplayEvents,
    totalEvents
  );
  runtime.counters.peakReplayWireBytes = Math.max(
    runtime.counters.peakReplayWireBytes,
    totalBytes
  );
  updateRetainedPeaks(runtime);
}

function removeReplayTotals(
  runtime: ServiceRuntime,
  events: number,
  wireBytes: number
): void {
  if (
    events < 0 ||
    wireBytes < 0 ||
    events > runtime.counters.replayEvents ||
    wireBytes > runtime.counters.replayWireBytes
  ) {
    throw new Error("Projection subscriber replay accounting is inconsistent.");
  }
  runtime.counters.replayEvents -= events;
  runtime.counters.replayWireBytes -= wireBytes;
}

function updateRetainedPeaks(runtime: ServiceRuntime): void {
  const events = checkedTotal(
    runtime.counters.queuedEvents,
    runtime.counters.replayEvents
  );
  const bytes = checkedTotal(
    runtime.counters.queuedWireBytes,
    runtime.counters.replayWireBytes
  );
  runtime.counters.peakRetainedEvents = Math.max(
    runtime.counters.peakRetainedEvents,
    events
  );
  runtime.counters.peakRetainedWireBytes = Math.max(
    runtime.counters.peakRetainedWireBytes,
    bytes
  );
}

function assertAggregateRetention(
  runtime: ServiceRuntime,
  queuedEvents: number,
  queuedWireBytes: number,
  replayEvents: number,
  replayWireBytes: number
): void {
  const budget = runtime.parsed.resourceBudget;
  const maximumSubscribers = budget.sse_max_subscribers;
  const retainedEvents = checkedTotal(queuedEvents, replayEvents);
  const retainedWireBytes = checkedTotal(queuedWireBytes, replayWireBytes);
  if (
    queuedEvents > checkedProduct(maximumSubscribers, budget.sse_queue_max_events) ||
    queuedWireBytes > checkedProduct(maximumSubscribers, budget.sse_queue_max_bytes) ||
    replayEvents > checkedProduct(maximumSubscribers, budget.sse_replay_max_events) ||
    replayWireBytes > checkedProduct(maximumSubscribers, budget.sse_replay_max_bytes) ||
    retainedEvents >
      checkedProduct(
        maximumSubscribers,
        checkedTotal(budget.sse_queue_max_events, budget.sse_replay_max_events)
      ) ||
    retainedWireBytes >
      checkedProduct(
        maximumSubscribers,
        checkedTotal(budget.sse_queue_max_bytes, budget.sse_replay_max_bytes)
      )
  ) {
    throw new Error("Projection subscriber aggregate retention exceeded its policy.");
  }
}

function checkedTotal(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0 || !Number.isSafeInteger(total)) {
    throw new Error("Projection subscriber accounting exceeded safe integer bounds.");
  }
  return total;
}

function checkedProduct(left: number, right: number): number {
  const product = left * right;
  if (!Number.isSafeInteger(product) || product < 0) {
    throw new Error("Projection subscriber policy product exceeded safe integer bounds.");
  }
  return product;
}

function snapshot(runtime: ServiceRuntime): ProjectionSubscriberStreamSnapshot {
  return Object.freeze({
    aborted_subscribers: runtime.counters.abortedSubscribers,
    active_device_buckets: runtime.deviceCounts.size,
    active_session_buckets: runtime.sessions.size,
    active_subscribers: runtime.subscribers.size,
    admission_rejections: runtime.counters.admissionRejections,
    archived_subscribers: runtime.counters.archivedSubscribers,
    closed: runtime.closed,
    explicit_closures: runtime.counters.explicitClosures,
    observer_failures: runtime.counters.observerFailures,
    opened_subscribers: runtime.counters.openedSubscribers,
    overflowed_subscribers: runtime.counters.overflowedSubscribers,
    peak_queued_events: runtime.counters.peakQueuedEvents,
    peak_queued_wire_bytes: runtime.counters.peakQueuedWireBytes,
    peak_replay_events: runtime.counters.peakReplayEvents,
    peak_replay_wire_bytes: runtime.counters.peakReplayWireBytes,
    peak_retained_events: runtime.counters.peakRetainedEvents,
    peak_retained_wire_bytes: runtime.counters.peakRetainedWireBytes,
    queued_events: runtime.counters.queuedEvents,
    queued_wire_bytes: runtime.counters.queuedWireBytes,
    replay_events: runtime.counters.replayEvents,
    replay_wire_bytes: runtime.counters.replayWireBytes,
    retained_events: checkedTotal(
      runtime.counters.queuedEvents,
      runtime.counters.replayEvents
    ),
    retained_wire_bytes: checkedTotal(
      runtime.counters.queuedWireBytes,
      runtime.counters.replayWireBytes
    ),
    service_closed_subscribers: runtime.counters.serviceClosedSubscribers,
    source_failed_subscribers: runtime.counters.sourceFailedSubscribers,
    source_open_failures: runtime.counters.sourceOpenFailures
  });
}

function parseServiceInput(candidate: unknown): ParsedServiceInput {
  const value = readExactDataObject(
    candidate,
    ["handoff", "observe_failure", "resource_budget"],
    "invalid_config"
  );
  const handoff = readExactDataObject(
    value.handoff,
    ["open"],
    "invalid_config"
  );
  if (typeof handoff.open !== "function" || typeof value.observe_failure !== "function") {
    throw new HostDeckProjectionSubscriberError("invalid_config");
  }
  try {
    assertResolvedResourceBudget(value.resource_budget);
    assertSafeRetentionProducts(value.resource_budget);
  } catch {
    throw new HostDeckProjectionSubscriberError("invalid_config");
  }
  return Object.freeze({
    handoff: value.handoff as ProjectionReplayLiveHandoffService,
    observeFailure: value.observe_failure as ProjectionSubscriberFailureObserver,
    resourceBudget: value.resource_budget
  });
}

function assertSafeRetentionProducts(resourceBudget: ResourceBudget): void {
  const eventCapacity = checkedTotal(
    resourceBudget.sse_queue_max_events,
    resourceBudget.sse_replay_max_events
  );
  const byteCapacity = checkedTotal(
    resourceBudget.sse_queue_max_bytes,
    resourceBudget.sse_replay_max_bytes
  );
  for (const subscribers of [
    resourceBudget.sse_max_subscribers,
    resourceBudget.sse_max_subscribers_per_device,
    resourceBudget.sse_max_subscribers_per_session
  ]) {
    checkedProduct(subscribers, eventCapacity);
    checkedProduct(subscribers, byteCapacity);
  }
}

function parseOpenInput(candidate: unknown): ParsedOpenInput {
  const value = readExactDataObject(
    candidate,
    [
      "after",
      "authorization",
      "device_id",
      "session_id",
      "signal",
      "subscriber_id"
    ],
    "invalid_input"
  );
  const after = value.after === null ? null : outputCursorSchema.safeParse(value.after);
  const deviceId =
    value.device_id === null ? null : selectedDeviceIdSchema.safeParse(value.device_id);
  const sessionId = sessionIdSchema.safeParse(value.session_id);
  if (
    (after !== null && !after.success) ||
    (deviceId !== null && !deviceId.success) ||
    !sessionId.success ||
    !(value.signal instanceof AbortSignal) ||
    typeof value.subscriber_id !== "string" ||
    !subscriberIdPattern.test(value.subscriber_id)
  ) {
    throw new HostDeckProjectionSubscriberError("invalid_input");
  }
  return Object.freeze({
    after: after === null ? null : after.data,
    authorization: value.authorization,
    deviceId: deviceId === null ? null : deviceId.data,
    sessionId: sessionId.data,
    signal: value.signal,
    subscriberId: value.subscriber_id
  });
}

function requireOpenedHandoff(
  candidate: unknown,
  input: ParsedOpenInput,
  resourceBudget: ResourceBudget
): ValidatedOpenedHandoff {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !Object.isFrozen(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  const expectedKeys = [
    "activate",
    "after",
    "claim_replay",
    "close",
    "failure",
    "high_water_cursor",
    "observed_fanout_cursor",
    "paused_event_count",
    "paused_wire_bytes",
    "replay_event_count",
    "replay_wire_bytes",
    "session_id",
    "signal",
    "state",
    "subscriber_id",
    "truncated"
  ];
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key)
    )
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  try {
    const data = (key: string): unknown =>
      readFrozenHandoffData(descriptors[key]);
    const accessor = (key: string): unknown =>
      readFrozenHandoffAccessor(candidate, descriptors[key]);
    const activate = data("activate");
    const claimReplay = data("claim_replay");
    const close = data("close");
    const after = data("after");
    const sessionId = data("session_id");
    const subscriberId = data("subscriber_id");
    const signal = data("signal");
    const highWaterValue = data("high_water_cursor");
    const observedValue = data("observed_fanout_cursor");
    const replayEventCount = data("replay_event_count");
    const replayWireBytes = data("replay_wire_bytes");
    const truncated = data("truncated");
    const failureValue = accessor("failure");
    const pausedEventCount = accessor("paused_event_count");
    const pausedWireBytes = accessor("paused_wire_bytes");
    const state = accessor("state");
    const highWater =
      highWaterValue === null
        ? null
        : outputCursorSchema.safeParse(highWaterValue);
    const observed =
      observedValue === null
        ? null
        : outputCursorSchema.safeParse(observedValue);
    if (
      typeof activate !== "function" ||
      typeof claimReplay !== "function" ||
      typeof close !== "function" ||
      after !== input.after ||
      sessionId !== input.sessionId ||
      subscriberId !== input.subscriberId ||
      !(signal instanceof AbortSignal) ||
      signal.aborted ||
      state !== "paused" ||
      failureValue !== null ||
      (highWater !== null && !highWater.success) ||
      (observed !== null && !observed.success) ||
      !Number.isSafeInteger(replayEventCount) ||
      (replayEventCount as number) < 0 ||
      (replayEventCount as number) > resourceBudget.sse_replay_max_events ||
      !Number.isSafeInteger(replayWireBytes) ||
      (replayWireBytes as number) < 0 ||
      (replayWireBytes as number) > resourceBudget.sse_replay_max_bytes ||
      ((replayEventCount as number) === 0) !== ((replayWireBytes as number) === 0) ||
      !Number.isSafeInteger(pausedEventCount) ||
      (pausedEventCount as number) < 0 ||
      (pausedEventCount as number) > resourceBudget.sse_queue_max_events ||
      !Number.isSafeInteger(pausedWireBytes) ||
      (pausedWireBytes as number) < 0 ||
      (pausedWireBytes as number) > resourceBudget.sse_queue_max_bytes ||
      ((pausedEventCount as number) === 0) !== ((pausedWireBytes as number) === 0) ||
      typeof truncated !== "boolean" ||
      (observed?.success === true &&
        (highWater === null || !highWater.success || observed.data > highWater.data))
    ) {
      throw new HostDeckProjectionSubscriberError("source_failed");
    }
    const highWaterCursor = highWater === null ? null : highWater.data;
    if (
      input.after !== null &&
      (highWaterCursor === null
        ? input.after > 0
        : input.after > highWaterCursor)
    ) {
      throw new HostDeckProjectionSubscriberError("source_failed");
    }
    const claim = requireReplayClaim(
      Reflect.apply(claimReplay, candidate, []),
      input,
      resourceBudget,
      highWaterCursor,
      replayEventCount as number,
      replayWireBytes as number,
      truncated as boolean
    );
    if (
      signal.aborted ||
      accessor("state") !== "paused" ||
      accessor("failure") !== null
    ) {
      throw new HostDeckProjectionSubscriberError("source_failed");
    }
    return Object.freeze({
      handoff: candidate as ProjectionReplayLiveHandoff,
      replay: claim
    });
  } catch (error) {
    if (error instanceof HostDeckProjectionSubscriberError) throw error;
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
}

function requireReplayClaim(
  candidate: unknown,
  input: ParsedOpenInput,
  resourceBudget: ResourceBudget,
  highWaterCursor: OutputCursor | null,
  expectedEventCount: number,
  expectedWireBytes: number,
  truncated: boolean
): ValidatedReplayClaim {
  const value = readExactFrozenDataObject(candidate, [
    "event_count",
    "events",
    "wire_bytes"
  ]);
  if (
    value.event_count !== expectedEventCount ||
    value.wire_bytes !== expectedWireBytes ||
    !Array.isArray(value.events) ||
    !Object.isFrozen(value.events) ||
    value.events.length !== expectedEventCount
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  const entries: QueuedEvent[] = [];
  let wireBytes = 0;
  let previousCursor: OutputCursor | null = input.after;
  for (const [index, candidateEvent] of value.events.entries()) {
    const parsed = selectedProjectionEventSchema.safeParse(candidateEvent);
    if (
      !Object.isFrozen(candidateEvent) ||
      !parsed.success ||
      parsed.data.session_id !== input.sessionId
    ) {
      throw new HostDeckProjectionSubscriberError("source_failed");
    }
    const event = deepFreeze(parsed.data);
    const firstBoundary = index === 0 && event.type === "replay_boundary";
    if (
      event.cursor <= (previousCursor ?? 0) ||
      (!firstBoundary && event.cursor !== (previousCursor ?? 0) + 1) ||
      (event.type === "replay_boundary" && !firstBoundary)
    ) {
      throw new HostDeckProjectionSubscriberError("source_failed");
    }
    const eventWireBytes = selectedProjectionSseWireByteLength(event);
    if (eventWireBytes > resourceBudget.sse_event_max_bytes) {
      throw new HostDeckProjectionSubscriberError("source_failed");
    }
    wireBytes = checkedTotal(wireBytes, eventWireBytes);
    entries.push(Object.freeze({ event, wireBytes: eventWireBytes }));
    previousCursor = event.cursor;
  }
  const firstIsBoundary = entries[0]?.event.type === "replay_boundary";
  if (
    wireBytes !== expectedWireBytes ||
    wireBytes > resourceBudget.sse_replay_max_bytes ||
    entries.length > resourceBudget.sse_replay_max_events ||
    truncated !== firstIsBoundary ||
    (entries.length === 0
      ? highWaterCursor !== null && input.after !== highWaterCursor
      : entries.at(-1)?.event.cursor !== highWaterCursor)
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  let head: ReplayEventNode | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      throw new Error("Projection subscriber replay construction is inconsistent.");
    }
    head = Object.freeze({
      event: entry.event,
      next: head,
      wireBytes: entry.wireBytes
    });
  }
  return Object.freeze({ eventCount: entries.length, head, wireBytes });
}

function readFrozenHandoffData(
  descriptor: PropertyDescriptor | undefined
): unknown {
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    descriptor.configurable ||
    descriptor.writable
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  return descriptor.value;
}

function readFrozenHandoffAccessor(
  receiver: object,
  descriptor: PropertyDescriptor | undefined
): unknown {
  if (
    descriptor === undefined ||
    !("get" in descriptor) ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined ||
    !descriptor.enumerable ||
    descriptor.configurable
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  return Reflect.apply(descriptor.get, receiver, []);
}

function readExactFrozenDataObject(
  candidate: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !Object.isFrozen(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set(expectedKeys);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new HostDeckProjectionSubscriberError("source_failed");
  }
  const values: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    values[key] = readFrozenHandoffData(descriptors[key]);
  }
  return Object.freeze(values);
}

function closeUnownedHandoff(candidate: unknown): void {
  try {
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    ) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, "close");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      return;
    }
    const result: unknown = Reflect.apply(descriptor.value, candidate, []);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // The source-open failure remains authoritative; cleanup is best effort.
  }
}

function readExactDataObject(
  candidate: unknown,
  expectedKeys: readonly string[],
  code: Extract<ProjectionSubscriberErrorCode, "invalid_config" | "invalid_input">
): Readonly<Record<string, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new HostDeckProjectionSubscriberError(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set(expectedKeys);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new HostDeckProjectionSubscriberError(code);
  }
  const values: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new HostDeckProjectionSubscriberError(code);
    }
    values[key] = descriptor.value;
  }
  return Object.freeze(values);
}

function parseSessionId(candidate: unknown): string {
  const parsed = sessionIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckProjectionSubscriberError("invalid_input");
  }
  return parsed.data;
}

function failure(
  code: ProjectionSubscriberFailureCode,
  cursor: OutputCursor | null
): ProjectionSubscriberFailure {
  return Object.freeze({ code, cursor });
}

function terminalError(
  terminal: TerminalState
): HostDeckProjectionSubscriberError {
  if (terminal.kind === "failed") {
    return new HostDeckProjectionSubscriberError(terminal.failure.code);
  }
  if (terminal.reason === "aborted") {
    return new HostDeckProjectionSubscriberError("aborted");
  }
  return new HostDeckProjectionSubscriberError("service_closed");
}

function sourceTerminationReason(terminal: TerminalState): Error {
  if (terminal.kind === "failed") {
    return new HostDeckProjectionSubscriberError(terminal.failure.code);
  }
  switch (terminal.reason) {
    case "aborted":
      return new HostDeckProjectionSubscriberError("aborted");
    case "service_closed":
      return new HostDeckProjectionSubscriberError("service_closed");
    case "explicit":
    case "open_failed":
      return new Error("Projection subscriber closed.");
  }
}

function currentTerminal(record: SubscriberRecord): TerminalState | null {
  return record.terminal;
}

function terminalResult(
  terminal: TerminalState
): Promise<IteratorResult<SelectedProjectionEvent>> {
  return terminal.kind === "failed"
    ? Promise.reject(
        new HostDeckProjectionSubscriberError(terminal.failure.code)
      )
    : Promise.resolve(doneResult());
}

function doneResult(): IteratorReturnResult<undefined> {
  return Object.freeze({ done: true, value: undefined });
}

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function isPromiseLike(candidate: unknown): candidate is PromiseLike<unknown> {
  return (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "function") &&
    typeof (candidate as { readonly then?: unknown }).then === "function"
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
