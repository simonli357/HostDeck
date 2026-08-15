import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assertResolvedResourceBudget,
  isoTimestampSchema,
  outputCursorSchema,
  type ResourceBudget,
  type SessionCatalogEvent,
  type SharedSessionCatalogEntry,
  selectedDeviceIdSchema,
  sessionCatalogEventSchema,
  sessionIdSchema,
  sharedSessionCatalogEntrySchema
} from "@hostdeck/contracts";
import type { OutputCursor } from "@hostdeck/core";
import {
  registerHostDeckSseSourceLifecycle,
  sessionCatalogSseWireByteLength
} from "./fastify-sse-source.js";
import type { SessionCatalogStateReader } from "./session-catalog-state-reader.js";
import {
  assertSseSubscriberAdmissionService,
  HostDeckSseSubscriberAdmissionError,
  type SseSubscriberAdmissionLease,
  type SseSubscriberAdmissionService
} from "./sse-subscriber-admission.js";

export type SessionCatalogHubErrorCode =
  | "aborted"
  | "authorization_failed"
  | "catalog_closed"
  | "catalog_failed"
  | "event_too_large"
  | "future_cursor"
  | "invalid_config"
  | "invalid_input"
  | "publication_failed"
  | "replay_limit"
  | "storage_unavailable"
  | "subscriber_device_limit"
  | "subscriber_exists"
  | "subscriber_global_limit";

export class HostDeckSessionCatalogHubError extends Error {
  constructor(
    readonly code: SessionCatalogHubErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckSessionCatalogHubError";
  }
}

export interface SessionCatalogAuthorizationInput {
  readonly authorization: unknown;
}

export type SessionCatalogAuthorizer = (
  input: SessionCatalogAuthorizationInput
) => { readonly ok: true } | { readonly ok: false };

export interface SessionCatalogStream extends AsyncIterable<SessionCatalogEvent> {
  readonly after: OutputCursor | null;
  readonly close: () => boolean;
  readonly replay_event_count: number;
  readonly state: "closed" | "open";
  readonly subscriber_id: string;
}

export interface SessionCatalogHubSnapshot {
  readonly active_subscribers: number;
  readonly catalog_sessions: number;
  readonly closed_subscribers: number;
  readonly endpoint_generation: number;
  readonly failure_code: "publication_failed" | "storage_unavailable" | null;
  readonly history_events: number;
  readonly history_wire_bytes: number;
  readonly overflow_boundaries: number;
  readonly rejected_subscribers: number;
  readonly state: "closed" | "failed" | "ready" | "uninitialized";
  readonly stream_id: string | null;
}

export interface SessionCatalogHub {
  readonly close: () => number;
  readonly initialize: (endpointGeneration: number) => void;
  readonly open: (input: unknown) => SessionCatalogStream;
  readonly reconcile: (endpointGeneration: number) => void;
  readonly snapshot: () => SessionCatalogHubSnapshot;
  readonly synchronize: (
    sessionId: string,
    absentReason: "archived" | "ineligible" | "missing" | "reconciled"
  ) => void;
}

export interface CreateSessionCatalogHubInput {
  readonly admission: SseSubscriberAdmissionService;
  readonly authorize: SessionCatalogAuthorizer;
  readonly create_stream_id?: () => string;
  readonly initial_cursor?: number;
  readonly now?: () => Date;
  readonly reader: SessionCatalogStateReader;
  readonly resource_budget: ResourceBudget;
}

interface ParsedInput {
  readonly admission: SseSubscriberAdmissionService;
  readonly authorize: SessionCatalogAuthorizer;
  readonly createStreamId: () => string;
  readonly initialCursor: OutputCursor;
  readonly now: () => Date;
  readonly reader: SessionCatalogStateReader;
  readonly resourceBudget: ResourceBudget;
}

interface OpenInput {
  readonly after: OutputCursor | null;
  readonly authorization: unknown;
  readonly deviceId: string | null;
  readonly signal: AbortSignal;
  readonly subscriberId: string;
}

interface BufferedEvent {
  readonly event: SessionCatalogEvent;
  readonly wireBytes: number;
}

type CatalogEventPayload<T = SessionCatalogEvent> = T extends SessionCatalogEvent
  ? Omit<T, "cursor" | "emitted_at" | "stream_id">
  : never;

interface PendingRead {
  readonly reject: (error: HostDeckSessionCatalogHubError) => void;
  readonly resolve: (result: IteratorResult<SessionCatalogEvent>) => void;
}

interface SubscriberRecord {
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly lease: SseSubscriberAdmissionLease;
  readonly onAbort: () => void;
  readonly subscriberId: string;
  abortListenerAttached: boolean;
  boundaryDelivered: boolean;
  closeAfterBoundary: boolean;
  iteratorClaimed: boolean;
  pending: PendingRead | null;
  queue: BufferedEvent[];
  queuedWireBytes: number;
  replay: readonly BufferedEvent[];
  replayIndex: number;
  state: "closed" | "open";
}

interface MutableCounters {
  closedSubscribers: number;
  overflowBoundaries: number;
  rejectedSubscribers: number;
}

const acceptedHubs = new WeakSet<object>();
const subscriberIdPattern = /^[a-zA-Z0-9_.:-]{1,120}$/u;

export function createSessionCatalogHub(
  input: CreateSessionCatalogHubInput
): SessionCatalogHub {
  const parsed = parseInput(input);
  let state: SessionCatalogHubSnapshot["state"] = "uninitialized";
  let failureCode: SessionCatalogHubSnapshot["failure_code"] = null;
  let endpointGeneration = 0;
  let streamId: string | null = null;
  let cursor = parsed.initialCursor;
  let lastTimestamp: string | null = null;
  let history: readonly BufferedEvent[] = Object.freeze([]);
  let historyWireBytes = 0;
  const entries = new Map<string, SharedSessionCatalogEntry>();
  const nativeIds = new Map<string, string>();
  const subscribers = new Map<string, SubscriberRecord>();
  const counters: MutableCounters = {
    closedSubscribers: 0,
    overflowBoundaries: 0,
    rejectedSubscribers: 0
  };

  const terminate = (
    record: SubscriberRecord,
    error: HostDeckSessionCatalogHubError | null = null
  ): boolean => {
    if (record.state === "closed") return false;
    record.state = "closed";
    record.queue = [];
    record.queuedWireBytes = 0;
    record.replay = Object.freeze([]);
    record.replayIndex = 0;
    const pending = record.pending;
    record.pending = null;
    if (pending !== null) {
      if (error === null) pending.resolve(doneResult());
      else pending.reject(error);
    }
    if (record.abortListenerAttached) {
      record.abortListenerAttached = false;
      record.externalSignal.removeEventListener("abort", record.onAbort);
    }
    subscribers.delete(record.subscriberId);
    if (!record.lease.release()) {
      throw new Error("Catalog subscriber admission accounting is inconsistent.");
    }
    counters.closedSubscribers = increment(counters.closedSubscribers);
    record.controller.abort(
      error ?? new HostDeckSessionCatalogHubError("catalog_closed", "Catalog subscriber closed.")
    );
    return true;
  };

  const timestamp = (): string => {
    let timestamp: string;
    try {
      const now = parsed.now();
      if (!(now instanceof Date)) throw new TypeError("Catalog clock must return a Date.");
      timestamp = now.toISOString();
    } catch (cause) {
      throw new HostDeckSessionCatalogHubError(
        "publication_failed",
        "Catalog clock is unavailable.",
        { cause }
      );
    }
    const candidate = isoTimestampSchema.safeParse(timestamp);
    if (!candidate.success) {
      throw new HostDeckSessionCatalogHubError(
        "publication_failed",
        "Catalog clock returned an invalid timestamp."
      );
    }
    if (lastTimestamp === null || candidate.data >= lastTimestamp) {
      lastTimestamp = candidate.data;
    }
    return lastTimestamp;
  };

  const nextCursor = (): OutputCursor => {
    if (cursor >= Number.MAX_SAFE_INTEGER) {
      throw new HostDeckSessionCatalogHubError(
        "publication_failed",
        "Catalog cursor capacity is exhausted."
      );
    }
    cursor = outputCursorSchema.parse(cursor + 1);
    return cursor;
  };

  const buildEvent = (
    value: CatalogEventPayload,
    selectedStreamId = requireStreamId(streamId)
  ): BufferedEvent => {
    const parsedEvent = sessionCatalogEventSchema.safeParse({
      ...value,
      cursor: nextCursor(),
      emitted_at: timestamp(),
      stream_id: selectedStreamId
    });
    if (!parsedEvent.success) {
      throw new HostDeckSessionCatalogHubError(
        "publication_failed",
        "Catalog publication does not satisfy the selected event contract.",
        { cause: parsedEvent.error }
      );
    }
    const event = deepFreeze(parsedEvent.data);
    const wireBytes = sessionCatalogSseWireByteLength(event);
    if (wireBytes > parsed.resourceBudget.sse_event_max_bytes) {
      throw new HostDeckSessionCatalogHubError(
        "event_too_large",
        "Catalog event exceeds its configured wire bound."
      );
    }
    return Object.freeze({ event, wireBytes });
  };

  const clearRecordBuffers = (record: SubscriberRecord): void => {
    record.queue = [];
    record.queuedWireBytes = 0;
    record.replay = Object.freeze([]);
    record.replayIndex = 0;
  };

  const deliverBoundary = (record: SubscriberRecord, boundary: BufferedEvent): void => {
    if (record.state === "closed") return;
    clearRecordBuffers(record);
    record.closeAfterBoundary = true;
    const pending = record.pending;
    if (pending === null) {
      record.queue.push(boundary);
      record.queuedWireBytes = boundary.wireBytes;
      return;
    }
    record.pending = null;
    record.boundaryDelivered = true;
    pending.resolve({ done: false, value: boundary.event });
  };

  const closeWithBoundary = (
    reason: "lag" | "overflow" | "reconciliation" | "runtime" | "storage" | "unknown_required_event",
    detail: string
  ): void => {
    if (streamId === null) return;
    const boundary = buildEvent({
      type: "catalog_boundary",
      reason,
      reset_required: true,
      detail
    });
    if (reason === "overflow") {
      counters.overflowBoundaries = increment(counters.overflowBoundaries);
    }
    for (const record of [...subscribers.values()]) {
      deliverBoundary(record, boundary);
    }
  };

  const replaceEntries = (catalog: readonly SharedSessionCatalogEntry[]): void => {
    entries.clear();
    nativeIds.clear();
    for (const candidate of catalog) {
      const parsedEntry = sharedSessionCatalogEntrySchema.safeParse(candidate);
      if (!parsedEntry.success) {
        throw new HostDeckSessionCatalogHubError(
          "publication_failed",
          "Catalog snapshot contains an invalid session entry.",
          { cause: parsedEntry.error }
        );
      }
      const entry = deepFreeze(parsedEntry.data);
      const internalId = entry.tracked.internal_session_id;
      const nativeId = String(entry.tracked.native_thread_id);
      if (entries.has(internalId) || nativeIds.has(nativeId)) {
        throw new HostDeckSessionCatalogHubError(
          "publication_failed",
          "Catalog snapshot repeats a tracked-session identity."
        );
      }
      entries.set(internalId, entry);
      nativeIds.set(nativeId, internalId);
    }
    if (entries.size > parsed.resourceBudget.protocol_thread_max_loaded_reads) {
      throw new HostDeckSessionCatalogHubError(
        "replay_limit",
        "Catalog snapshot exceeds its configured session bound."
      );
    }
  };

  const buildBootstrap = (
    reason: "initial" | "reconnect" | "reconciliation"
  ): void => {
    streamId = parseStreamId(parsed.createStreamId());
    const nextHistory: BufferedEvent[] = [
      buildEvent({
        type: "catalog_reset",
        reason,
        expected_session_count: entries.size
      })
    ];
    for (const entry of entries.values()) {
      nextHistory.push(buildEvent({ type: "session_upsert", session: entry }));
    }
    nextHistory.push(
      buildEvent({
        type: "catalog_ready",
        session_count: entries.size,
        endpoint_generation: endpointGeneration
      })
    );
    const bytes = nextHistory.reduce((total, event) => checkedTotal(total, event.wireBytes), 0);
    if (
      nextHistory.length > parsed.resourceBudget.sse_replay_max_events ||
      bytes > parsed.resourceBudget.sse_replay_max_bytes
    ) {
      throw new HostDeckSessionCatalogHubError(
        "replay_limit",
        "Catalog bootstrap exceeds its configured replay bound."
      );
    }
    history = Object.freeze(nextHistory);
    historyWireBytes = bytes;
    failureCode = null;
    state = "ready";
  };

  const fail = (
    reason: "storage" | "unknown_required_event",
    detail: string,
    cause: unknown
  ): never => {
    try {
      closeWithBoundary(reason, detail);
    } catch {
      for (const record of [...subscribers.values()]) {
        terminate(
          record,
          new HostDeckSessionCatalogHubError("catalog_failed", "Catalog publication failed.")
        );
      }
    }
    history = Object.freeze([]);
    historyWireBytes = 0;
    streamId = null;
    failureCode =
      reason === "storage" ? "storage_unavailable" : "publication_failed";
    state = "failed";
    throw new HostDeckSessionCatalogHubError(
      reason === "storage" ? "storage_unavailable" : "publication_failed",
      detail,
      { cause }
    );
  };

  const readCatalog = (): readonly SharedSessionCatalogEntry[] => {
    try {
      return parsed.reader.read();
    } catch (error) {
      return fail("storage", "Catalog storage is unavailable; reset is required.", error);
    }
  };

  const rotate = (
    boundaryReason: "lag" | "overflow" | "reconciliation" | "runtime",
    resetReason: "reconnect" | "reconciliation"
  ): void => {
    closeWithBoundary(
      boundaryReason,
      boundaryReason === "overflow"
        ? "Catalog subscriber capacity was exceeded; reconnect for a reset."
        : "Catalog continuity changed; reconnect for a reset."
    );
    try {
      buildBootstrap(resetReason);
    } catch (error) {
      fail(
        "unknown_required_event",
        "Catalog reset publication failed; a fresh rebuild is required.",
        error
      );
    }
  };

  const appendLive = (buffered: BufferedEvent): void => {
    const historyWouldOverflow =
      history.length >= parsed.resourceBudget.sse_replay_max_events ||
      buffered.wireBytes >
        parsed.resourceBudget.sse_replay_max_bytes - historyWireBytes;
    const subscriberWouldOverflow = [...subscribers.values()].some(
      (record) =>
        record.pending === null &&
        !record.closeAfterBoundary &&
        (record.queue.length >= parsed.resourceBudget.sse_queue_max_events ||
          buffered.wireBytes >
            parsed.resourceBudget.sse_queue_max_bytes - record.queuedWireBytes)
    );
    if (historyWouldOverflow || subscriberWouldOverflow) {
      rotate("overflow", "reconnect");
      return;
    }

    history = Object.freeze([...history, buffered]);
    historyWireBytes = checkedTotal(historyWireBytes, buffered.wireBytes);
    for (const record of subscribers.values()) {
      if (record.state === "closed" || record.closeAfterBoundary) continue;
      const pending = record.pending;
      if (pending !== null) {
        record.pending = null;
        pending.resolve({ done: false, value: buffered.event });
      } else {
        record.queue.push(buffered);
        record.queuedWireBytes += buffered.wireBytes;
      }
    }
  };

  const synchronize = (
    sessionId: string,
    absentReason: "archived" | "ineligible" | "missing" | "reconciled"
  ): void => {
    assertReady(state, failureCode);
    const parsedSessionId = sessionIdSchema.safeParse(sessionId);
    const targetSessionId = parsedSessionId.success
      ? parsedSessionId.data
      : fail(
          "unknown_required_event",
          "Catalog synchronization target is invalid; a reset is required.",
          parsedSessionId.error
        );
    const rawCandidate = (() => {
      try {
        return parsed.reader.readOne(targetSessionId);
      } catch (error) {
        return fail(
          "storage",
          "Catalog storage is unavailable; reset is required.",
          error
        );
      }
    })();
    const parsedCandidate =
      rawCandidate === null
        ? null
        : sharedSessionCatalogEntrySchema.safeParse(rawCandidate);
    const candidate =
      parsedCandidate === null
        ? null
        : parsedCandidate.success
          ? deepFreeze(parsedCandidate.data)
          : fail(
              "unknown_required_event",
              "Catalog session update is invalid; a reset is required.",
              parsedCandidate.error
            );
    const current = entries.get(targetSessionId);
    if (candidate === null) {
      if (current === undefined) return;
      entries.delete(targetSessionId);
      nativeIds.delete(String(current.tracked.native_thread_id));
      try {
        appendLive(
          buildEvent({
            type: "session_remove",
            native_thread_id: current.tracked.native_thread_id,
            internal_session_id: current.tracked.internal_session_id,
            reason: absentReason
          })
        );
      } catch (error) {
        fail(
          "unknown_required_event",
          "Catalog removal publication failed; a reset is required.",
          error
        );
      }
      return;
    }
    if (current !== undefined && isDeepStrictEqual(current, candidate)) return;
    const nativeId = String(candidate.tracked.native_thread_id);
    const conflictingInternalId = nativeIds.get(nativeId);
    if (
      (current !== undefined &&
        String(current.tracked.native_thread_id) !== nativeId) ||
      (conflictingInternalId !== undefined &&
        conflictingInternalId !== targetSessionId)
    ) {
      fail(
        "unknown_required_event",
        "Catalog session identity changed unexpectedly; a reset is required.",
        new Error("Catalog identity conflict.")
      );
    }
    entries.set(targetSessionId, candidate);
    nativeIds.set(nativeId, targetSessionId);
    try {
      appendLive(buildEvent({ type: "session_upsert", session: candidate }));
    } catch (error) {
      fail(
        "unknown_required_event",
        "Catalog upsert publication failed; a reset is required.",
        error
      );
    }
  };

  const open = (candidate: unknown): SessionCatalogStream => {
    const input = parseOpenInput(candidate);
    if (input.signal.aborted) {
      throw new HostDeckSessionCatalogHubError("aborted", "Catalog subscriber request was aborted.");
    }
    let authorization: { readonly ok: true } | { readonly ok: false };
    try {
      authorization = parsed.authorize({ authorization: input.authorization });
    } catch (error) {
      throw new HostDeckSessionCatalogHubError(
        "authorization_failed",
        "Catalog read authorization failed.",
        { cause: error }
      );
    }
    if (authorization.ok !== true) {
      throw new HostDeckSessionCatalogHubError(
        "authorization_failed",
        "Catalog read is not authorized."
      );
    }
    assertReady(state, failureCode);
    const latest = history.at(-1);
    const earliest = history[0];
    if (latest === undefined || earliest === undefined) {
      throw new HostDeckSessionCatalogHubError(
        "catalog_failed",
        "Catalog replay is not initialized."
      );
    }
    if (input.after !== null && input.after > latest.event.cursor) {
      throw new HostDeckSessionCatalogHubError(
        "future_cursor",
        "Catalog reconnect cursor is ahead of current state."
      );
    }
    if (
      input.after !== null &&
      input.after < earliest.event.cursor - 1
    ) {
      rotate("lag", "reconnect");
    }
    const replay = history.filter(
      ({ event }) => input.after === null || event.cursor > input.after
    );
    const replayBytes = replay.reduce(
      (total, event) => checkedTotal(total, event.wireBytes),
      0
    );
    if (
      replay.length > parsed.resourceBudget.sse_replay_max_events ||
      replayBytes > parsed.resourceBudget.sse_replay_max_bytes
    ) {
      throw new HostDeckSessionCatalogHubError(
        "replay_limit",
        "Catalog replay exceeds configured capacity."
      );
    }

    let lease: SseSubscriberAdmissionLease;
    try {
      lease = parsed.admission.reserve({
        device_id: input.deviceId,
        subscriber_id: input.subscriberId
      });
    } catch (error) {
      counters.rejectedSubscribers = increment(counters.rejectedSubscribers);
      throw mapAdmissionError(error);
    }
    const controller = new AbortController();
    let record: SubscriberRecord;
    const onAbort = () => terminate(record);
    record = {
      abortListenerAttached: true,
      boundaryDelivered: false,
      closeAfterBoundary: false,
      controller,
      externalSignal: input.signal,
      iteratorClaimed: false,
      lease,
      onAbort,
      pending: null,
      queue: [],
      queuedWireBytes: 0,
      replay: Object.freeze([...replay]),
      replayIndex: 0,
      state: "open",
      subscriberId: input.subscriberId
    };
    subscribers.set(record.subscriberId, record);
    input.signal.addEventListener("abort", record.onAbort, { once: true });
    if (input.signal.aborted) terminate(record);

    const iterator: AsyncIterator<SessionCatalogEvent> = Object.freeze({
      next(): Promise<IteratorResult<SessionCatalogEvent>> {
        if (record.state === "closed") return Promise.resolve(doneResult());
        if (record.boundaryDelivered) {
          terminate(record);
          return Promise.resolve(doneResult());
        }
        const replayed = record.replay[record.replayIndex];
        if (replayed !== undefined) {
          record.replayIndex += 1;
          return Promise.resolve({ done: false, value: replayed.event });
        }
        const queued = record.queue.shift();
        if (queued !== undefined) {
          record.queuedWireBytes -= queued.wireBytes;
          if (record.closeAfterBoundary) record.boundaryDelivered = true;
          return Promise.resolve({ done: false, value: queued.event });
        }
        if (record.pending !== null) {
          terminate(
            record,
            new HostDeckSessionCatalogHubError(
              "invalid_input",
              "Catalog subscriber already has an active iterator read."
            )
          );
          return Promise.reject(
            new HostDeckSessionCatalogHubError(
              "invalid_input",
              "Catalog subscriber already has an active iterator read."
            )
          );
        }
        return new Promise<IteratorResult<SessionCatalogEvent>>(
          (resolve, reject) => {
            record.pending = { reject, resolve };
          }
        );
      },
      return(): Promise<IteratorResult<SessionCatalogEvent>> {
        terminate(record);
        return Promise.resolve(doneResult());
      },
      throw(): Promise<IteratorResult<SessionCatalogEvent>> {
        const error = new HostDeckSessionCatalogHubError(
          "catalog_failed",
          "Catalog subscriber source failed."
        );
        terminate(record, error);
        return Promise.reject(error);
      }
    });
    const stream: SessionCatalogStream = {
      [Symbol.asyncIterator]() {
        if (record.iteratorClaimed) {
          throw new HostDeckSessionCatalogHubError(
            "invalid_input",
            "Catalog subscriber stream can be iterated only once."
          );
        }
        record.iteratorClaimed = true;
        return iterator;
      },
      after: input.after,
      close: () => terminate(record),
      replay_event_count: replay.length,
      get state() {
        return record.state;
      },
      subscriber_id: record.subscriberId
    };
    const publicStream = registerHostDeckSseSourceLifecycle({
      iterable: stream,
      signal: controller.signal
    });
    return Object.freeze(publicStream);
  };

  const hub: SessionCatalogHub = Object.freeze({
    close(): number {
      if (state === "closed") return 0;
      state = "closed";
      const records = [...subscribers.values()];
      for (const record of records) terminate(record);
      return records.length;
    },
    initialize(generation: number): void {
      if (state !== "uninitialized") {
        throw new HostDeckSessionCatalogHubError(
          "invalid_input",
          "Catalog can be initialized only once."
        );
      }
      endpointGeneration = parseEndpointGeneration(generation);
      const initialCatalog = readCatalog();
      try {
        replaceEntries(initialCatalog);
        buildBootstrap("initial");
      } catch (error) {
        fail(
          "unknown_required_event",
          "Catalog initialization failed; a rebuild is required.",
          error
        );
      }
    },
    open,
    reconcile(generation: number): void {
      if (state === "closed" || state === "uninitialized") {
        throw new HostDeckSessionCatalogHubError(
          state === "closed" ? "catalog_closed" : "invalid_input",
          "Catalog cannot reconcile in its current state."
        );
      }
      const nextGeneration = parseEndpointGeneration(generation);
      const catalog = readCatalog();
      if (state === "ready") {
        closeWithBoundary(
          "reconciliation",
          "Catalog reconciliation requires a fresh reset."
        );
      }
      endpointGeneration = nextGeneration;
      try {
        replaceEntries(catalog);
        buildBootstrap("reconciliation");
      } catch (error) {
        fail(
          "unknown_required_event",
          "Catalog reconciliation failed; a rebuild is required.",
          error
        );
      }
    },
    snapshot(): SessionCatalogHubSnapshot {
      return Object.freeze({
        active_subscribers: subscribers.size,
        catalog_sessions: entries.size,
        closed_subscribers: counters.closedSubscribers,
        endpoint_generation: endpointGeneration,
        failure_code: failureCode,
        history_events: history.length,
        history_wire_bytes: historyWireBytes,
        overflow_boundaries: counters.overflowBoundaries,
        rejected_subscribers: counters.rejectedSubscribers,
        state,
        stream_id: streamId
      });
    },
    synchronize
  });
  acceptedHubs.add(hub);
  return hub;
}

export function assertSessionCatalogHub(
  candidate: unknown
): asserts candidate is SessionCatalogHub {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedHubs.has(candidate)
  ) {
    throw new TypeError("Session catalog hub must come from the selected factory.");
  }
}

function parseInput(input: CreateSessionCatalogHubInput): ParsedInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.authorize !== "function" ||
    input.reader === null ||
    typeof input.reader !== "object" ||
    typeof input.reader.read !== "function" ||
    typeof input.reader.readOne !== "function"
  ) {
    throw new HostDeckSessionCatalogHubError(
      "invalid_config",
      "Session catalog hub configuration is invalid."
    );
  }
  try {
    assertResolvedResourceBudget(input.resource_budget);
    assertSseSubscriberAdmissionService(input.admission);
  } catch (error) {
    throw new HostDeckSessionCatalogHubError(
      "invalid_config",
      "Session catalog hub resource configuration is invalid.",
      { cause: error }
    );
  }
  const now = input.now ?? (() => new Date());
  const createStreamId =
    input.create_stream_id ??
    (() => `catalog_${randomBytes(12).toString("hex")}`);
  if (typeof now !== "function" || typeof createStreamId !== "function") {
    throw new HostDeckSessionCatalogHubError(
      "invalid_config",
      "Session catalog hub callbacks are invalid."
    );
  }
  let initialCursor: number;
  try {
    initialCursor =
      input.initial_cursor ?? Math.floor(now().getTime() * 1_000);
  } catch (error) {
    throw new HostDeckSessionCatalogHubError(
      "invalid_config",
      "Session catalog hub clock is unavailable.",
      { cause: error }
    );
  }
  const parsedCursor = outputCursorSchema.safeParse(initialCursor);
  if (!parsedCursor.success || initialCursor >= Number.MAX_SAFE_INTEGER) {
    throw new HostDeckSessionCatalogHubError(
      "invalid_config",
      "Session catalog initial cursor is invalid."
    );
  }
  return Object.freeze({
    admission: input.admission,
    authorize: input.authorize,
    createStreamId,
    initialCursor: parsedCursor.data,
    now,
    reader: input.reader,
    resourceBudget: input.resource_budget
  });
}

function parseOpenInput(candidate: unknown): OpenInput {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new HostDeckSessionCatalogHubError("invalid_input", "Catalog subscriber input is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const expected = [
    "after",
    "authorization",
    "device_id",
    "signal",
    "subscriber_id"
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key)) ||
    expected.some((key) => descriptors[key] === undefined || !("value" in (descriptors[key] as PropertyDescriptor)))
  ) {
    throw new HostDeckSessionCatalogHubError("invalid_input", "Catalog subscriber fields are invalid.");
  }
  const value = (key: string): unknown =>
    (descriptors[key] as PropertyDescriptor & { readonly value: unknown }).value;
  const afterValue = value("after");
  const after = afterValue === null ? null : outputCursorSchema.safeParse(afterValue);
  const deviceValue = value("device_id");
  const device = deviceValue === null ? null : selectedDeviceIdSchema.safeParse(deviceValue);
  const signal = value("signal");
  const subscriberId = value("subscriber_id");
  if (
    (after !== null && !after.success) ||
    (device !== null && !device.success) ||
    !(signal instanceof AbortSignal) ||
    typeof subscriberId !== "string" ||
    !subscriberIdPattern.test(subscriberId)
  ) {
    throw new HostDeckSessionCatalogHubError("invalid_input", "Catalog subscriber fields are invalid.");
  }
  return Object.freeze({
    after: after === null ? null : after.data,
    authorization: value("authorization"),
    deviceId: device === null ? null : device.data,
    signal,
    subscriberId
  });
}

function mapAdmissionError(error: unknown): HostDeckSessionCatalogHubError {
  if (error instanceof HostDeckSseSubscriberAdmissionError) {
    if (error.code === "device_limit") {
      return new HostDeckSessionCatalogHubError(
        "subscriber_device_limit",
        "Catalog device subscriber capacity is exhausted."
      );
    }
    if (error.code === "duplicate_subscriber") {
      return new HostDeckSessionCatalogHubError(
        "subscriber_exists",
        "Catalog subscriber id already exists."
      );
    }
    if (error.code === "global_limit") {
      return new HostDeckSessionCatalogHubError(
        "subscriber_global_limit",
        "Catalog global subscriber capacity is exhausted."
      );
    }
  }
  return new HostDeckSessionCatalogHubError(
    "invalid_config",
    "Catalog subscriber admission failed.",
    { cause: error }
  );
}

function assertReady(
  state: SessionCatalogHubSnapshot["state"],
  failureCode: SessionCatalogHubSnapshot["failure_code"]
): void {
  if (state === "ready") return;
  if (state === "closed") {
    throw new HostDeckSessionCatalogHubError("catalog_closed", "Session catalog is closed.");
  }
  if (state === "failed") {
    throw new HostDeckSessionCatalogHubError(
      failureCode ?? "catalog_failed",
      "Session catalog requires a rebuild."
    );
  }
  throw new HostDeckSessionCatalogHubError("invalid_input", "Session catalog is not initialized.");
}

function parseEndpointGeneration(candidate: number): number {
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new HostDeckSessionCatalogHubError(
      "invalid_input",
      "Catalog endpoint generation is invalid."
    );
  }
  return candidate;
}

function parseStreamId(candidate: unknown): string {
  const probe = sessionCatalogEventSchema.safeParse({
    stream_id: candidate,
    cursor: 0,
    emitted_at: "2026-01-01T00:00:00.000Z",
    type: "catalog_ready",
    session_count: 0,
    endpoint_generation: 0
  });
  if (!probe.success) {
    throw new HostDeckSessionCatalogHubError(
      "publication_failed",
      "Catalog stream id is invalid.",
      { cause: probe.error }
    );
  }
  return probe.data.stream_id;
}

function requireStreamId(streamId: string | null): string {
  if (streamId === null) {
    throw new HostDeckSessionCatalogHubError(
      "publication_failed",
      "Catalog stream is not initialized."
    );
  }
  return streamId;
}

function doneResult(): IteratorReturnResult<undefined> {
  return { done: true, value: undefined };
}

function checkedTotal(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new HostDeckSessionCatalogHubError(
      "publication_failed",
      "Catalog resource accounting is exhausted."
    );
  }
  return total;
}

function increment(value: number): number {
  return checkedTotal(value, 1);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
