import { isDeepStrictEqual } from "node:util";
import {
  assertResolvedResourceBudget,
  outputCursorSchema,
  type ResourceBudget,
  type SelectedProjectionEvent,
  selectedProjectionEventSchema,
  selectedSessionEventStreamSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { OutputCursor } from "@hostdeck/core";
import {
  HostDeckSelectedStateRepositoryError,
  type SelectedStateRepository
} from "@hostdeck/storage";
import { selectedProjectionSseWireByteLength } from "./fastify-sse-source.js";
import {
  HostDeckProjectionFanoutError,
  type ProjectionFanoutHub,
  type ProjectionFanoutSubscriber,
  type ProjectionFanoutSubscription
} from "./projection-fanout-hub.js";

export type ProjectionHandoffErrorCode =
  | "aborted"
  | "activation_reentrant"
  | "already_activated"
  | "authorization_failed"
  | "event_too_large"
  | "fanout_unavailable"
  | "future_cursor"
  | "handoff_closed"
  | "handoff_failed"
  | "invalid_config"
  | "invalid_input"
  | "invalid_live_sink"
  | "live_delivery_failed"
  | "paused_queue_overflow"
  | "replay_already_claimed"
  | "replay_inconsistent"
  | "replay_limit"
  | "replay_not_claimed"
  | "session_archived"
  | "session_not_found"
  | "storage_unavailable";

export class HostDeckProjectionHandoffError extends Error {
  constructor(
    readonly code: ProjectionHandoffErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckProjectionHandoffError";
  }
}

export interface ProjectionHandoffAuthorizationInput {
  readonly authorization: unknown;
  readonly session_id: string;
}

export type ProjectionHandoffAuthorizationResult = { readonly ok: true } | { readonly ok: false };
export type ProjectionHandoffAuthorizer = (
  input: ProjectionHandoffAuthorizationInput
) => ProjectionHandoffAuthorizationResult;
export type ProjectionHandoffLiveSink = (event: SelectedProjectionEvent) => void;

export interface ProjectionHandoffActivationResult {
  readonly drained_event_count: number;
  readonly live_after_cursor: OutputCursor | null;
}

export interface ProjectionHandoffFailure {
  readonly code: Extract<
    ProjectionHandoffErrorCode,
    | "event_too_large"
    | "fanout_unavailable"
    | "live_delivery_failed"
    | "paused_queue_overflow"
    | "replay_inconsistent"
  >;
  readonly cursor: OutputCursor | null;
}

export type ProjectionHandoffState = "closed" | "failed" | "live" | "paused";

export interface ProjectionReplayLiveHandoff {
  readonly activate: (input: unknown) => ProjectionHandoffActivationResult;
  readonly after: OutputCursor | null;
  readonly claim_replay: () => ProjectionReplayClaim;
  readonly close: () => boolean;
  readonly failure: ProjectionHandoffFailure | null;
  readonly high_water_cursor: OutputCursor | null;
  readonly observed_fanout_cursor: OutputCursor | null;
  readonly paused_event_count: number;
  readonly paused_wire_bytes: number;
  readonly replay_event_count: number;
  readonly replay_wire_bytes: number;
  readonly session_id: string;
  readonly signal: AbortSignal;
  readonly state: ProjectionHandoffState;
  readonly subscriber_id: string;
  readonly truncated: boolean;
}

export interface ProjectionReplayClaim {
  readonly event_count: number;
  readonly events: readonly SelectedProjectionEvent[];
  readonly wire_bytes: number;
}

export interface OpenProjectionReplayLiveHandoffInput {
  readonly after: number | null;
  readonly authorization: unknown;
  readonly session_id: string;
  readonly signal: AbortSignal;
  readonly subscriber_id: string;
}

export interface CreateProjectionReplayLiveHandoffServiceInput {
  readonly authorize: ProjectionHandoffAuthorizer;
  readonly fanout: Pick<ProjectionFanoutHub, "failure" | "subscribe">;
  readonly resource_budget: ResourceBudget;
  readonly state: Pick<SelectedStateRepository, "listEvents" | "require">;
}

export interface ProjectionReplayLiveHandoffService {
  readonly open: (input: unknown) => ProjectionReplayLiveHandoff;
}

interface ParsedServiceInput {
  readonly authorize: ProjectionHandoffAuthorizer;
  readonly fanout: Pick<ProjectionFanoutHub, "failure" | "subscribe">;
  readonly resourceBudget: ResourceBudget;
  readonly state: Pick<SelectedStateRepository, "listEvents" | "require">;
}

interface ParsedOpenInput {
  readonly after: OutputCursor | null;
  readonly authorization: unknown;
  readonly session_id: string;
  readonly signal: AbortSignal;
  readonly subscriber_id: string;
}

interface BufferedLiveEvent {
  readonly event: SelectedProjectionEvent;
  readonly wire_bytes: number;
}

interface DurableProjectionPosition {
  readonly archived: boolean;
  readonly high_water_cursor: OutputCursor | null;
  readonly retention_boundary_cursor: OutputCursor | null;
}

interface ReplaySnapshot {
  readonly events: readonly SelectedProjectionEvent[];
  readonly truncated: boolean;
  readonly wire_bytes: number;
}

interface ReplayValidation {
  readonly boundary_cursor: OutputCursor | null;
  readonly events_by_cursor: ReadonlyMap<OutputCursor, SelectedProjectionEvent>;
}

type HandoffFailureCode = ProjectionHandoffFailure["code"];
type InternalHandoffState = "activating" | "closed" | "failed" | "live" | "opening" | "paused";

const maximumRetentionReplayAttempts = 32;
const noReplayValidation: ReplayValidation = Object.freeze({
  boundary_cursor: null,
  events_by_cursor: new Map<OutputCursor, SelectedProjectionEvent>()
});
const replayPageLimit = 500;
const subscriberIdPattern = /^[a-zA-Z0-9_.:-]{1,120}$/u;

export function createProjectionReplayLiveHandoffService(
  input: CreateProjectionReplayLiveHandoffServiceInput
): ProjectionReplayLiveHandoffService {
  const parsed = parseServiceInput(input);
  return Object.freeze({
    open(candidate: unknown) {
      return openHandoff(parsed, parseOpenInput(candidate));
    }
  });
}

function openHandoff(service: ParsedServiceInput, input: ParsedOpenInput): ProjectionReplayLiveHandoff {
  assertNotAborted(input.signal);
  authorize(service.authorize, input);
  assertNotAborted(input.signal);

  let internalState: InternalHandoffState = "opening";
  let failure: ProjectionHandoffFailure | null = null;
  let subscription: ProjectionFanoutSubscription | null = null;
  let subscriptionDetached = false;
  let subscriptionAbortListenerAttached = false;
  let abortListenerAttached = false;
  let highWaterCaptured = false;
  let highWaterCursor: OutputCursor | null = null;
  let liveCursor: OutputCursor | null = null;
  let acceptedLiveCursor: OutputCursor | null = null;
  let unclassifiedCursor: OutputCursor | null = null;
  let liveSink: ProjectionHandoffLiveSink | null = null;
  let deliveringLive = false;
  let pausedWireBytes = 0;
  let replay: ReplaySnapshot | null = null;
  let replayClaimed = false;
  let replayValidation: ReplayValidation | null = null;
  const lifecycleController = new AbortController();
  const paused: BufferedLiveEvent[] = [];

  const removeAbortListener = (): void => {
    if (!abortListenerAttached) return;
    abortListenerAttached = false;
    input.signal.removeEventListener("abort", onAbort);
  };
  const clearPaused = (): void => {
    paused.length = 0;
    pausedWireBytes = 0;
  };
  const clearReplay = (): void => {
    replay = null;
    replayValidation = null;
  };
  const removeSubscriptionAbortListener = (): void => {
    if (!subscriptionAbortListenerAttached || subscription === null) return;
    subscriptionAbortListenerAttached = false;
    subscription.signal.removeEventListener("abort", onSubscriptionAbort);
  };
  const detachSubscription = (): boolean => {
    if (subscription === null || subscriptionDetached) return false;
    subscriptionDetached = true;
    removeSubscriptionAbortListener();
    try {
      return subscription.unsubscribe();
    } catch {
      return false;
    }
  };
  const fail = (code: HandoffFailureCode, cursor: OutputCursor | null): void => {
    if (internalState === "closed" || internalState === "failed") return;
    failure = Object.freeze({ code, cursor });
    internalState = "failed";
    liveSink = null;
    deliveringLive = false;
    clearPaused();
    clearReplay();
    detachSubscription();
    removeAbortListener();
    lifecycleController.abort(
      new HostDeckProjectionHandoffError(
        code,
        `Projection handoff failed with ${code}.`
      )
    );
  };
  const close = (): boolean => {
    const changed = internalState !== "closed" && internalState !== "failed";
    if (changed) internalState = "closed";
    liveSink = null;
    deliveringLive = false;
    clearPaused();
    clearReplay();
    detachSubscription();
    removeAbortListener();
    lifecycleController.abort(
      new HostDeckProjectionHandoffError(
        "handoff_closed",
        "Projection handoff is closed."
      )
    );
    return changed;
  };
  function onAbort(): void {
    close();
  }
  function onSubscriptionAbort(): void {
    fail("fanout_unavailable", liveCursor);
  }
  const attachSubscriptionAbortListener = (): void => {
    if (subscription === null || subscriptionAbortListenerAttached) return;
    subscription.signal.addEventListener("abort", onSubscriptionAbort, {
      once: true
    });
    subscriptionAbortListenerAttached = true;
    if (subscription.signal.aborted) onSubscriptionAbort();
  };
  const enqueue = (event: SelectedProjectionEvent, wireBytes: number): boolean => {
    if (
      paused.length >= service.resourceBudget.sse_queue_max_events ||
      pausedWireBytes + wireBytes > service.resourceBudget.sse_queue_max_bytes
    ) {
      fail("paused_queue_overflow", event.cursor);
      return false;
    }
    paused.push(Object.freeze({ event, wire_bytes: wireBytes }));
    pausedWireBytes += wireBytes;
    return true;
  };
  const onCommitted: ProjectionFanoutSubscriber = (committed): void => {
    if (internalState === "closed" || internalState === "failed") return;
    let eventCursor: OutputCursor | null = null;
    try {
      const event = parseCommittedEvent(committed);
      eventCursor = event.cursor;
      if (event.session_id !== input.session_id) {
        fail("replay_inconsistent", event.cursor);
        return;
      }
      const wireBytes = selectedProjectionSseWireByteLength(event);
      if (wireBytes > service.resourceBudget.sse_event_max_bytes) {
        fail("event_too_large", event.cursor);
        return;
      }

      if (replayValidation === null) {
        if (unclassifiedCursor !== null && !isNextCursor(unclassifiedCursor, event.cursor)) {
          fail("replay_inconsistent", event.cursor);
          return;
        }
        if (enqueue(event, wireBytes)) unclassifiedCursor = event.cursor;
        return;
      }

      if (highWaterCaptured && event.cursor <= (highWaterCursor ?? 0)) {
        if (!isValidatedDuplicate(event, replayValidation)) {
          fail("replay_inconsistent", event.cursor);
        }
        return;
      }
      if (!isNextCursor(acceptedLiveCursor, event.cursor)) {
        fail("replay_inconsistent", event.cursor);
        return;
      }

      if (internalState !== "live") {
        if (enqueue(event, wireBytes)) acceptedLiveCursor = event.cursor;
        return;
      }
      if (deliveringLive) {
        fail("replay_inconsistent", event.cursor);
        return;
      }
      deliveringLive = true;
      const delivered = deliverLive(liveSink, event);
      deliveringLive = false;
      if (!delivered) {
        fail("live_delivery_failed", event.cursor);
        return;
      }
      if (internalState === "live") {
        acceptedLiveCursor = event.cursor;
        liveCursor = event.cursor;
      }
    } catch {
      deliveringLive = false;
      fail("replay_inconsistent", eventCursor);
    }
  };

  input.signal.addEventListener("abort", onAbort, { once: true });
  abortListenerAttached = true;
  let observedFanoutCursor: OutputCursor | null = null;
  try {
    subscription = subscribePaused(service.fanout, input, onCommitted);
    attachSubscriptionAbortListener();
    observedFanoutCursor = subscription.observed_high_water_cursor;
    assertOpeningAvailable(internalState, failure, input.signal, service.fanout, subscription);

    const selected = readDurableProjectionPosition(service.state, input.session_id);
    if (selected.archived) {
      throw new HostDeckProjectionHandoffError("session_archived", "Archived sessions cannot open a live event handoff.");
    }
    highWaterCursor = selected.high_water_cursor;
    highWaterCaptured = true;
    liveCursor = highWaterCursor;
    if (observedFanoutCursor !== null && (highWaterCursor === null || observedFanoutCursor > highWaterCursor)) {
      throw new HostDeckProjectionHandoffError(
        "replay_inconsistent",
        "Observed fanout state is ahead of durable projection state."
      );
    }
    if (input.after !== null && (highWaterCursor === null ? input.after > 0 : input.after > highWaterCursor)) {
      throw new HostDeckProjectionHandoffError("future_cursor", "Requested event cursor is ahead of durable high-water.");
    }

    replay = readReplaySnapshot(service, input, highWaterCursor, () =>
      assertOpeningAvailable(internalState, failure, input.signal, service.fanout, subscription)
    );
    replayValidation = createReplayValidation(replay.events);
    acceptedLiveCursor = normalizePausedQueue(
      paused,
      observedFanoutCursor,
      highWaterCursor,
      replayValidation
    );
    pausedWireBytes = paused.reduce((sum, buffered) => sum + buffered.wire_bytes, 0);
    assertOpeningAvailable(internalState, failure, input.signal, service.fanout, subscription);
    internalState = "paused";
  } catch (error) {
    close();
    throw normalizeOpenFailure(error);
  }

  const refreshFanoutAvailability = (): void => {
    if (internalState === "closed" || internalState === "failed") return;
    try {
      if (service.fanout.failure !== null || subscription === null || !subscription.active) {
        fail("fanout_unavailable", liveCursor);
      }
    } catch {
      fail("fanout_unavailable", liveCursor);
    }
  };
  const readInternalState = (): InternalHandoffState => internalState;
  if (replay === null) {
    close();
    throw new HostDeckProjectionHandoffError(
      "handoff_failed",
      "Projection handoff replay was not initialized."
    );
  }
  const replayEventCount = replay.events.length;
  const replayWireBytes = replay.wire_bytes;
  const replayTruncated = replay.truncated;
  const handoff = Object.freeze({
    activate(candidate: unknown): ProjectionHandoffActivationResult {
      if (internalState === "activating") {
        throw new HostDeckProjectionHandoffError("activation_reentrant", "Projection handoff activation cannot be reentrant.");
      }
      if (internalState === "live") {
        throw new HostDeckProjectionHandoffError("already_activated", "Projection handoff is already live.");
      }
      if (internalState === "closed") {
        throw new HostDeckProjectionHandoffError("handoff_closed", "Projection handoff is closed.");
      }
      if (internalState === "failed") throw handoffFailureError(failure);
      if (!replayClaimed) {
        throw new HostDeckProjectionHandoffError(
          "replay_not_claimed",
          "Projection replay must be claimed before activation."
        );
      }
      refreshFanoutAvailability();
      if (readInternalState() === "failed") throw handoffFailureError(failure);
      const sink = parseLiveSink(candidate);
      internalState = "activating";
      liveSink = sink;
      let drained = 0;
      while (paused.length > 0) {
        const buffered = paused.shift();
        if (buffered === undefined) break;
        pausedWireBytes -= buffered.wire_bytes;
        if (!isNextCursor(liveCursor, buffered.event.cursor)) {
          fail("replay_inconsistent", buffered.event.cursor);
          throw new HostDeckProjectionHandoffError("replay_inconsistent", "Paused live cursor sequence is invalid.");
        }
        if (!deliverLive(liveSink, buffered.event)) {
          fail("live_delivery_failed", buffered.event.cursor);
          throw new HostDeckProjectionHandoffError("live_delivery_failed", "Live sink rejected a paused event.");
        }
        liveCursor = buffered.event.cursor;
        drained += 1;
        if (readInternalState() === "closed") {
          throw new HostDeckProjectionHandoffError("handoff_closed", "Projection handoff closed during activation.");
        }
        if (readInternalState() === "failed") throw handoffFailureError(failure);
      }
      pausedWireBytes = 0;
      if (acceptedLiveCursor !== liveCursor) {
        fail("replay_inconsistent", acceptedLiveCursor);
        throw new HostDeckProjectionHandoffError("replay_inconsistent", "Projection handoff did not drain its accepted live cursor.");
      }
      replayValidation = emptyReplayValidation();
      internalState = "live";
      return Object.freeze({ drained_event_count: drained, live_after_cursor: liveCursor });
    },
    after: input.after,
    claim_replay(): ProjectionReplayClaim {
      if (replayClaimed) {
        throw new HostDeckProjectionHandoffError(
          "replay_already_claimed",
          "Projection replay was already claimed."
        );
      }
      if (internalState === "closed") {
        throw new HostDeckProjectionHandoffError(
          "handoff_closed",
          "Projection handoff is closed."
        );
      }
      if (internalState === "failed") throw handoffFailureError(failure);
      if (internalState !== "paused" || replay === null) {
        throw new HostDeckProjectionHandoffError(
          "handoff_failed",
          "Projection replay is unavailable in the current handoff state."
        );
      }
      const claimed = replay;
      replayClaimed = true;
      replay = null;
      return Object.freeze({
        event_count: claimed.events.length,
        events: claimed.events,
        wire_bytes: claimed.wire_bytes
      });
    },
    close,
    high_water_cursor: highWaterCursor,
    observed_fanout_cursor: observedFanoutCursor,
    replay_event_count: replayEventCount,
    replay_wire_bytes: replayWireBytes,
    session_id: input.session_id,
    signal: lifecycleController.signal,
    subscriber_id: input.subscriber_id,
    truncated: replayTruncated,
    get failure() {
      refreshFanoutAvailability();
      return failure;
    },
    get paused_event_count() {
      refreshFanoutAvailability();
      return paused.length;
    },
    get paused_wire_bytes() {
      refreshFanoutAvailability();
      return pausedWireBytes;
    },
    get state(): ProjectionHandoffState {
      refreshFanoutAvailability();
      return publicState(internalState);
    }
  });
  return handoff;
}

function readReplaySnapshot(
  service: ParsedServiceInput,
  input: ParsedOpenInput,
  highWaterCursor: OutputCursor | null,
  assertAvailable: () => void
): ReplaySnapshot {
  if (highWaterCursor === null || input.after === highWaterCursor) {
    return Object.freeze({ events: Object.freeze([]), truncated: false, wire_bytes: 0 });
  }

  let observedRetentionBoundary: OutputCursor | null = null;
  for (let attempt = 1; attempt <= maximumRetentionReplayAttempts; attempt += 1) {
    const snapshot = readReplayAttempt(service, input, highWaterCursor, assertAvailable);
    assertAvailable();
    const current = readDurableProjectionPosition(service.state, input.session_id);
    if (current.high_water_cursor === null || current.high_water_cursor < highWaterCursor) {
      throw new HostDeckProjectionHandoffError("replay_inconsistent", "Durable projection high-water moved backward during replay.");
    }
    const currentBoundary = current.retention_boundary_cursor;
    if (
      observedRetentionBoundary !== null &&
      (currentBoundary === null || currentBoundary < observedRetentionBoundary)
    ) {
      throw new HostDeckProjectionHandoffError("replay_inconsistent", "Durable retention boundary moved backward during replay.");
    }
    observedRetentionBoundary = currentBoundary;

    if (currentBoundary !== null && currentBoundary >= highWaterCursor) {
      throw new HostDeckProjectionHandoffError(
        "replay_inconsistent",
        "Retention advanced beyond the captured replay high-water."
      );
    }
    const requestCrossesBoundary =
      currentBoundary !== null && (input.after === null || input.after <= currentBoundary);
    const replayBoundary = snapshot.events[0]?.type === "replay_boundary" ? snapshot.events[0] : null;
    if (requestCrossesBoundary && replayBoundary?.after !== currentBoundary) continue;
    if (!requestCrossesBoundary && currentBoundary !== null && replayBoundary !== null) {
      throw new HostDeckProjectionHandoffError("replay_inconsistent", "Durable replay exposed an unexpected retention boundary.");
    }
    return snapshot;
  }
  throw new HostDeckProjectionHandoffError(
    "replay_limit",
    "Retention changed too many times to capture one bounded replay snapshot."
  );
}

function readReplayAttempt(
  service: ParsedServiceInput,
  input: ParsedOpenInput,
  highWaterCursor: OutputCursor,
  assertAvailable: () => void
): ReplaySnapshot {
  const events: SelectedProjectionEvent[] = [];
  let cursor = input.after;
  let truncated = false;
  let wireBytes = 0;
  while (cursor === null || cursor < highWaterCursor) {
    assertAvailable();
    const stream = parseReplayStream(
      service.state.listEvents(input.session_id, { after: cursor, limit: replayPageLimit }),
      input.session_id
    );
    const page = stream.events.filter((event) => event.cursor <= highWaterCursor);
    if (page.length === 0) {
      throw new HostDeckProjectionHandoffError("replay_inconsistent", "Durable replay did not reach its captured high-water.");
    }
    for (const parsedEvent of page) {
      const event = deepFreeze(parsedEvent);
      if (event.type === "replay_boundary") {
        events.length = 0;
        wireBytes = 0;
        truncated = true;
      } else if (!isNextCursor(events.at(-1)?.cursor ?? cursor, event.cursor)) {
        throw new HostDeckProjectionHandoffError("replay_inconsistent", "Durable replay cursor sequence is invalid.");
      }
      const eventWireBytes = selectedProjectionSseWireByteLength(event);
      if (eventWireBytes > service.resourceBudget.sse_event_max_bytes) {
        throw new HostDeckProjectionHandoffError("event_too_large", "Durable replay event exceeds the selected SSE event limit.");
      }
      if (
        events.length >= service.resourceBudget.sse_replay_max_events ||
        wireBytes + eventWireBytes > service.resourceBudget.sse_replay_max_bytes
      ) {
        throw new HostDeckProjectionHandoffError("replay_limit", "Durable replay exceeds selected SSE limits.");
      }
      events.push(event);
      wireBytes += eventWireBytes;
      cursor = event.cursor;
    }
  }
  if (cursor !== highWaterCursor) {
    throw new HostDeckProjectionHandoffError("replay_inconsistent", "Durable replay crossed its captured high-water.");
  }
  return Object.freeze({
    events: Object.freeze([...events]),
    truncated,
    wire_bytes: wireBytes
  });
}

function normalizePausedQueue(
  paused: BufferedLiveEvent[],
  observedFanoutCursor: OutputCursor | null,
  highWaterCursor: OutputCursor | null,
  replay: ReplayValidation
): OutputCursor | null {
  let observedCursor = observedFanoutCursor;
  for (const buffered of paused) {
    if (observedCursor !== null && !isNextCursor(observedCursor, buffered.event.cursor)) {
      throw new HostDeckProjectionHandoffError("replay_inconsistent", "Paused fanout cursor sequence is invalid.");
    }
    observedCursor = buffered.event.cursor;
  }

  const live: BufferedLiveEvent[] = [];
  let liveCursor = highWaterCursor;
  for (const buffered of paused) {
    if (buffered.event.cursor <= (highWaterCursor ?? 0)) {
      if (!isValidatedDuplicate(buffered.event, replay)) {
        throw new HostDeckProjectionHandoffError("replay_inconsistent", "Paused fanout duplicate contradicts durable replay.");
      }
      continue;
    }
    if (!isNextCursor(liveCursor, buffered.event.cursor)) {
      throw new HostDeckProjectionHandoffError("replay_inconsistent", "Paused live events do not continue captured high-water.");
    }
    live.push(buffered);
    liveCursor = buffered.event.cursor;
  }
  paused.splice(0, paused.length, ...live);
  return liveCursor;
}

function createReplayValidation(events: readonly SelectedProjectionEvent[]): ReplayValidation {
  const eventsByCursor = new Map<OutputCursor, SelectedProjectionEvent>();
  for (const event of events) eventsByCursor.set(event.cursor, event);
  const boundary = events[0]?.type === "replay_boundary" ? events[0].cursor : null;
  return Object.freeze({ boundary_cursor: boundary, events_by_cursor: eventsByCursor });
}

function emptyReplayValidation(): ReplayValidation {
  return noReplayValidation;
}

function isValidatedDuplicate(
  event: SelectedProjectionEvent,
  replay: ReplayValidation
): boolean {
  if (replay.boundary_cursor !== null && event.cursor <= replay.boundary_cursor) return true;
  const durable = replay.events_by_cursor.get(event.cursor);
  return durable !== undefined && isDeepStrictEqual(durable, event);
}

function parseServiceInput(candidate: unknown): ParsedServiceInput {
  const value = requirePlainRecord(candidate, "Projection handoff service input must be a plain object.", "invalid_config");
  assertExactKeys(value, ["authorize", "fanout", "resource_budget", "state"], "invalid_config");
  if (typeof value.authorize !== "function") {
    throw new HostDeckProjectionHandoffError("invalid_config", "Projection handoff authorizer is invalid.");
  }
  try {
    assertResolvedResourceBudget(value.resource_budget);
  } catch (error) {
    throw new HostDeckProjectionHandoffError("invalid_config", "Projection handoff resource budget is invalid.", {
      cause: error
    });
  }
  if (
    value.fanout === null ||
    typeof value.fanout !== "object" ||
    typeof (value.fanout as { readonly subscribe?: unknown }).subscribe !== "function"
  ) {
    throw new HostDeckProjectionHandoffError("invalid_config", "Projection handoff fanout is invalid.");
  }
  if (
    value.state === null ||
    typeof value.state !== "object" ||
    typeof (value.state as { readonly listEvents?: unknown }).listEvents !== "function" ||
    typeof (value.state as { readonly require?: unknown }).require !== "function"
  ) {
    throw new HostDeckProjectionHandoffError("invalid_config", "Projection handoff state repository is invalid.");
  }
  return Object.freeze({
    authorize: value.authorize as ProjectionHandoffAuthorizer,
    fanout: value.fanout as ParsedServiceInput["fanout"],
    resourceBudget: value.resource_budget,
    state: value.state as ParsedServiceInput["state"]
  });
}

function parseOpenInput(candidate: unknown): ParsedOpenInput {
  const value = requirePlainRecord(candidate, "Projection handoff open input must be a plain object.", "invalid_input");
  assertExactKeys(value, ["after", "authorization", "session_id", "signal", "subscriber_id"], "invalid_input");
  const sessionId = sessionIdSchema.safeParse(value.session_id);
  const after = value.after === null ? null : outputCursorSchema.safeParse(value.after);
  if (
    !sessionId.success ||
    (after !== null && !after.success) ||
    !(value.signal instanceof AbortSignal) ||
    typeof value.subscriber_id !== "string" ||
    !subscriberIdPattern.test(value.subscriber_id)
  ) {
    throw new HostDeckProjectionHandoffError("invalid_input", "Projection handoff open input is invalid.");
  }
  return Object.freeze({
    after: after === null ? null : after.data,
    authorization: value.authorization,
    session_id: sessionId.data,
    signal: value.signal,
    subscriber_id: value.subscriber_id
  });
}

function authorize(authorizer: ProjectionHandoffAuthorizer, input: ParsedOpenInput): void {
  let result: ProjectionHandoffAuthorizationResult;
  try {
    result = authorizer(Object.freeze({ authorization: input.authorization, session_id: input.session_id }));
    const value = requireAuthorizationResult(result);
    if (!value.ok) {
      throw new HostDeckProjectionHandoffError("authorization_failed", "Projection handoff read is not authorized.");
    }
  } catch (error) {
    if (error instanceof HostDeckProjectionHandoffError) throw error;
    throw new HostDeckProjectionHandoffError("authorization_failed", "Projection handoff authorization failed.", {
      cause: error
    });
  }
}

function requireAuthorizationResult(candidate: unknown): ProjectionHandoffAuthorizationResult {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null) ||
    Object.keys(candidate).length !== 1 ||
    !Object.hasOwn(candidate, "ok") ||
    typeof (candidate as { readonly ok?: unknown }).ok !== "boolean"
  ) {
    throw new HostDeckProjectionHandoffError("authorization_failed", "Projection handoff authorization result is invalid.");
  }
  return candidate as ProjectionHandoffAuthorizationResult;
}

function subscribePaused(
  fanout: Pick<ProjectionFanoutHub, "failure" | "subscribe">,
  input: ParsedOpenInput,
  onEvent: ProjectionFanoutSubscriber
): ProjectionFanoutSubscription {
  let candidate: unknown;
  try {
    candidate = fanout.subscribe({ id: input.subscriber_id, on_event: onEvent, session_id: input.session_id });
  } catch (error) {
    throw new HostDeckProjectionHandoffError("fanout_unavailable", "Projection fanout rejected handoff registration.", {
      cause: error
    });
  }
  try {
    return parseFanoutSubscription(candidate, input);
  } catch (error) {
    bestEffortUnsubscribe(candidate);
    if (error instanceof HostDeckProjectionHandoffError) throw error;
    throw new HostDeckProjectionHandoffError("fanout_unavailable", "Projection fanout returned an invalid subscription.", {
      cause: error
    });
  }
}

function parseFanoutSubscription(candidate: unknown, input: ParsedOpenInput): ProjectionFanoutSubscription {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new HostDeckProjectionHandoffError("fanout_unavailable", "Projection fanout returned an invalid subscription.");
  }
  const value = candidate as Partial<ProjectionFanoutSubscription>;
  const observed = value.observed_high_water_cursor;
  const parsedObserved = observed === null ? null : outputCursorSchema.safeParse(observed);
  if (
    value.id !== input.subscriber_id ||
    value.session_id !== input.session_id ||
    typeof value.active !== "boolean" ||
    !value.active ||
    typeof value.unsubscribe !== "function" ||
    !(value.signal instanceof AbortSignal) ||
    (parsedObserved !== null && !parsedObserved.success)
  ) {
    throw new HostDeckProjectionHandoffError("fanout_unavailable", "Projection fanout returned an invalid subscription.");
  }
  return candidate as ProjectionFanoutSubscription;
}

function bestEffortUnsubscribe(candidate: unknown): void {
  try {
    if (candidate !== null && typeof candidate === "object") {
      const unsubscribe = (candidate as { readonly unsubscribe?: unknown }).unsubscribe;
      if (typeof unsubscribe === "function") unsubscribe.call(candidate);
    }
  } catch {
    // A malformed fanout token is already reported as unavailable.
  }
}

function readDurableProjectionPosition(
  state: Pick<SelectedStateRepository, "require">,
  sessionId: string
): DurableProjectionPosition {
  const selected = state.require(sessionId);
  const mapping = selectedSessionMappingRecordSchema.safeParse(selected?.mapping);
  const projection = selectedSessionProjectionRecordSchema.safeParse(selected?.projection);
  if (
    !mapping.success ||
    !projection.success ||
    mapping.data.id !== sessionId ||
    projection.data.session.id !== sessionId ||
    mapping.data.id !== projection.data.session.id
  ) {
    throw new HostDeckProjectionHandoffError("replay_inconsistent", "Selected durable projection state is invalid.");
  }
  return Object.freeze({
    archived: projection.data.session.session_state === "archived",
    high_water_cursor: projection.data.session.last_event_cursor,
    retention_boundary_cursor: projection.data.retention_boundary_cursor
  });
}

function parseReplayStream(candidate: unknown, sessionId: string) {
  const parsed = selectedSessionEventStreamSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.session_id !== sessionId) {
    throw new HostDeckProjectionHandoffError("replay_inconsistent", "Selected durable replay stream is invalid.");
  }
  return parsed.data;
}

function parseCommittedEvent(committed: unknown): SelectedProjectionEvent {
  const candidate = (committed as { readonly event?: { readonly event?: unknown } } | null)?.event?.event;
  const parsed = selectedProjectionEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckProjectionHandoffError("replay_inconsistent", "Projection fanout emitted an invalid committed event.");
  }
  return deepFreeze(parsed.data);
}

function parseLiveSink(candidate: unknown): ProjectionHandoffLiveSink {
  const value = requirePlainRecord(candidate, "Projection handoff activation input must be a plain object.", "invalid_live_sink");
  assertExactKeys(value, ["on_event"], "invalid_live_sink");
  if (typeof value.on_event !== "function") {
    throw new HostDeckProjectionHandoffError("invalid_live_sink", "Projection handoff live sink is invalid.");
  }
  return value.on_event as ProjectionHandoffLiveSink;
}

function deliverLive(sink: ProjectionHandoffLiveSink | null, event: SelectedProjectionEvent): boolean {
  if (sink === null) return false;
  try {
    const result: unknown = sink(event);
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
    return result === undefined;
  } catch {
    return false;
  }
}

function assertOpeningAvailable(
  state: InternalHandoffState,
  failure: ProjectionHandoffFailure | null,
  signal: AbortSignal,
  fanout: Pick<ProjectionFanoutHub, "failure">,
  subscription: ProjectionFanoutSubscription | null
): void {
  assertNotAborted(signal);
  if (failure !== null) throw handoffFailureError(failure);
  if (state === "closed") {
    throw new HostDeckProjectionHandoffError("handoff_closed", "Projection handoff closed while opening.");
  }
  try {
    if (fanout.failure !== null || (subscription !== null && !subscription.active)) {
      throw new HostDeckProjectionHandoffError("fanout_unavailable", "Projection fanout failed while opening handoff.");
    }
  } catch (error) {
    if (error instanceof HostDeckProjectionHandoffError) throw error;
    throw new HostDeckProjectionHandoffError("fanout_unavailable", "Projection fanout failed while opening handoff.", {
      cause: error
    });
  }
}

function handoffFailureError(failure: ProjectionHandoffFailure | null): HostDeckProjectionHandoffError {
  if (failure === null) {
    return new HostDeckProjectionHandoffError("handoff_failed", "Projection handoff failed without diagnostics.");
  }
  return new HostDeckProjectionHandoffError(failure.code, `Projection handoff failed with ${failure.code}.`);
}

function normalizeOpenFailure(error: unknown): HostDeckProjectionHandoffError {
  if (error instanceof HostDeckProjectionHandoffError) return error;
  if (error instanceof HostDeckProjectionFanoutError) {
    return new HostDeckProjectionHandoffError("fanout_unavailable", "Projection fanout rejected handoff registration.", {
      cause: error
    });
  }
  if (error instanceof HostDeckSelectedStateRepositoryError) {
    if (error.code === "session_not_found") {
      return new HostDeckProjectionHandoffError("session_not_found", "Projection session was not found.", { cause: error });
    }
    if (
      error.code === "cursor_not_monotonic" ||
      error.code === "identity_mismatch" ||
      error.code === "invalid_event" ||
      error.code === "invalid_mapping" ||
      error.code === "invalid_projection" ||
      error.code === "invalid_replay"
    ) {
      return new HostDeckProjectionHandoffError("replay_inconsistent", "Projection durable replay is inconsistent.", {
        cause: error
      });
    }
    return new HostDeckProjectionHandoffError("storage_unavailable", "Projection state could not open replay handoff.", {
      cause: error
    });
  }
  return new HostDeckProjectionHandoffError("storage_unavailable", "Projection replay handoff failed to read durable state.", {
    cause: error
  });
}

function publicState(state: InternalHandoffState): ProjectionHandoffState {
  if (state === "activating" || state === "opening") return "paused";
  return state;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new HostDeckProjectionHandoffError("aborted", "Projection handoff request was aborted.");
}

function isNextCursor(previous: number | null, candidate: number): boolean {
  return candidate === (previous ?? 0) + 1;
}

function requirePlainRecord(
  candidate: unknown,
  message: string,
  code: Extract<ProjectionHandoffErrorCode, "invalid_config" | "invalid_input" | "invalid_live_sink">
): Readonly<Record<string, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new HostDeckProjectionHandoffError(code, message);
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  candidate: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  code: Extract<ProjectionHandoffErrorCode, "invalid_config" | "invalid_input" | "invalid_live_sink">
): void {
  const actual = Object.keys(candidate);
  const allowed = new Set(expected);
  if (actual.length !== expected.length || actual.some((key) => !allowed.has(key))) {
    throw new HostDeckProjectionHandoffError(code, "Projection handoff fields are invalid.");
  }
}

function isPromiseLike(candidate: unknown): candidate is PromiseLike<unknown> {
  return (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "function") &&
    typeof (candidate as { readonly then?: unknown }).then === "function"
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
