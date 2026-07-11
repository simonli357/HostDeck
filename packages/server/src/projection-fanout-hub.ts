import {
  isoTimestampSchema,
  outputCursorSchema,
  resourceBudgetDefinitionByKey,
  selectedProjectedEventRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { OutputCursor } from "@hostdeck/core";
import {
  type CommittedProjectionAppend,
  type SelectedStateRevision,
  selectedProjectedEventByteLength
} from "@hostdeck/storage";

export type ProjectionFanoutErrorCode =
  | "fanout_closed"
  | "fanout_stopped"
  | "invalid_publication"
  | "invalid_subscription"
  | "publication_backward"
  | "publication_duplicate"
  | "publication_gap"
  | "publication_reentrant"
  | "subscriber_delivery_failed"
  | "subscriber_exists"
  | "subscriber_limit"
  | "subscriber_session_limit";

export class HostDeckProjectionFanoutError extends Error {
  constructor(
    readonly code: ProjectionFanoutErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HostDeckProjectionFanoutError";
  }
}

export interface ProjectionFanoutFailure {
  readonly code: Extract<
    ProjectionFanoutErrorCode,
    | "invalid_publication"
    | "publication_backward"
    | "publication_duplicate"
    | "publication_gap"
    | "publication_reentrant"
    | "subscriber_delivery_failed"
  >;
  readonly cursor: OutputCursor | null;
  readonly failed_subscriber_count: number;
  readonly session_id: string | null;
}

export type ProjectionFanoutSubscriber = (committed: CommittedProjectionAppend) => void;

export interface ProjectionFanoutSubscribeInput {
  readonly id: string;
  readonly on_event: ProjectionFanoutSubscriber;
  readonly session_id: string;
}

export interface ProjectionFanoutSubscription {
  readonly active: boolean;
  readonly id: string;
  readonly observed_high_water_cursor: OutputCursor | null;
  readonly session_id: string;
  readonly unsubscribe: () => boolean;
}

export interface ProjectionFanoutHubOptions {
  readonly max_subscribers?: number;
  readonly max_subscribers_per_session?: number;
}

export interface ProjectionFanoutHub {
  readonly close: () => number;
  readonly closed: boolean;
  readonly failure: ProjectionFanoutFailure | null;
  readonly publish: (committed: unknown) => void;
  readonly subscribe: (input: unknown) => ProjectionFanoutSubscription;
  readonly subscriber_count: number;
  readonly tracked_session_count: number;
}

interface SubscriberRecord {
  readonly id: string;
  readonly on_event: ProjectionFanoutSubscriber;
  readonly session_id: string;
  readonly token: symbol;
}

interface SessionFanoutState {
  last_cursor: OutputCursor | null;
  readonly subscribers: Map<string, SubscriberRecord>;
}

const subscriberIdPattern = /^[a-zA-Z0-9_.:-]{1,120}$/u;
const globalSubscriberDefinition = resourceBudgetDefinitionByKey.sse_max_subscribers;
const sessionSubscriberDefinition = resourceBudgetDefinitionByKey.sse_max_subscribers_per_session;

export function createProjectionFanoutHub(options: ProjectionFanoutHubOptions = {}): ProjectionFanoutHub {
  const parsedOptions = parseOptions(options);
  const implementation = new DefaultProjectionFanoutHub(
    parsedOptions.max_subscribers,
    parsedOptions.max_subscribers_per_session
  );
  return Object.freeze({
    close: () => implementation.close(),
    publish: (committed: unknown) => implementation.publish(committed),
    subscribe: (input: unknown) => implementation.subscribe(input),
    get closed() {
      return implementation.closed;
    },
    get failure() {
      return implementation.failure;
    },
    get subscriber_count() {
      return implementation.subscriber_count;
    },
    get tracked_session_count() {
      return implementation.tracked_session_count;
    }
  });
}

class DefaultProjectionFanoutHub implements ProjectionFanoutHub {
  private readonly sessions = new Map<string, SessionFanoutState>();
  private readonly subscribers = new Map<string, SubscriberRecord>();
  private currentFailure: ProjectionFanoutFailure | null = null;
  private isClosed = false;
  private publishing = false;

  constructor(
    private readonly maxSubscribers: number,
    private readonly maxSubscribersPerSession: number
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }

  get failure(): ProjectionFanoutFailure | null {
    return this.currentFailure;
  }

  get subscriber_count(): number {
    return this.subscribers.size;
  }

  get tracked_session_count(): number {
    return this.sessions.size;
  }

  subscribe(input: unknown): ProjectionFanoutSubscription {
    this.assertAvailable();
    const parsed = parseSubscription(input);
    if (this.subscribers.has(parsed.id)) {
      throw new HostDeckProjectionFanoutError("subscriber_exists", "Projection fanout subscriber id already exists.");
    }
    if (this.subscribers.size >= this.maxSubscribers) {
      throw new HostDeckProjectionFanoutError("subscriber_limit", "Projection fanout subscriber capacity is exhausted.");
    }

    const currentSession = this.sessions.get(parsed.session_id);
    if ((currentSession?.subscribers.size ?? 0) >= this.maxSubscribersPerSession) {
      throw new HostDeckProjectionFanoutError(
        "subscriber_session_limit",
        "Projection fanout session subscriber capacity is exhausted."
      );
    }
    const session = currentSession ?? { last_cursor: null, subscribers: new Map<string, SubscriberRecord>() };
    const token = Symbol(parsed.id);
    const record: SubscriberRecord = { ...parsed, token };
    session.subscribers.set(record.id, record);
    this.sessions.set(record.session_id, session);
    this.subscribers.set(record.id, record);

    const observedHighWaterCursor = session.last_cursor;
    const implementation = this;
    return Object.freeze({
      id: record.id,
      observed_high_water_cursor: observedHighWaterCursor,
      session_id: record.session_id,
      unsubscribe: () => this.unsubscribe(record.id, token),
      get active() {
        return implementation.hasSubscription(record.id, token);
      }
    });
  }

  publish(candidate: unknown): void {
    this.assertAvailable();
    if (this.publishing) {
      this.fail(
        new HostDeckProjectionFanoutError("publication_reentrant", "Projection fanout publication cannot be reentrant."),
        null,
        null,
        0
      );
    }

    let committed: CommittedProjectionAppend;
    try {
      committed = parseCommittedPublication(candidate);
    } catch (error) {
      const normalized =
        error instanceof HostDeckProjectionFanoutError
          ? error
          : new HostDeckProjectionFanoutError("invalid_publication", "Committed projection publication is invalid.");
      this.fail(normalized, null, null, 0);
    }

    const event = committed.event.event;
    const session = this.sessions.get(event.session_id);
    if (session === undefined) return;
    if (session.last_cursor !== null) {
      if (event.cursor === session.last_cursor) {
        this.fail(
          new HostDeckProjectionFanoutError("publication_duplicate", "Projection fanout cursor was published twice."),
          event.session_id,
          event.cursor,
          0
        );
      }
      if (event.cursor < session.last_cursor) {
        this.fail(
          new HostDeckProjectionFanoutError("publication_backward", "Projection fanout cursor moved backward."),
          event.session_id,
          event.cursor,
          0
        );
      }
      if (event.cursor !== session.last_cursor + 1) {
        this.fail(
          new HostDeckProjectionFanoutError("publication_gap", "Projection fanout cursor skipped a live publication."),
          event.session_id,
          event.cursor,
          0
        );
      }
    }

    this.publishing = true;
    let failed = 0;
    try {
      const snapshot = [...session.subscribers.values()];
      for (const subscriber of snapshot) {
        if (this.subscribers.get(subscriber.id) !== subscriber) continue;
        try {
          const result: unknown = subscriber.on_event(committed);
          if (result !== undefined) {
            if (isPromiseLike(result)) observeInvalidThenable(result);
            failed += 1;
          }
        } catch {
          failed += 1;
        }
        if (this.currentFailure !== null) throw this.stoppedError();
        if (this.isClosed) throw new HostDeckProjectionFanoutError("fanout_closed", "Projection fanout hub is closed.");
      }
      if (failed > 0) {
        this.fail(
          new HostDeckProjectionFanoutError(
            "subscriber_delivery_failed",
            "Projection fanout subscriber did not accept synchronous delivery."
          ),
          event.session_id,
          event.cursor,
          failed
        );
      }
      if (this.sessions.get(event.session_id) === session) session.last_cursor = event.cursor;
      return;
    } finally {
      this.publishing = false;
    }
  }

  close(): number {
    if (this.isClosed) return 0;
    this.isClosed = true;
    const removed = this.subscribers.size;
    this.clearSubscribers();
    return removed;
  }

  hasSubscription(id: string, token: symbol): boolean {
    return this.subscribers.get(id)?.token === token;
  }

  private unsubscribe(id: string, token: symbol): boolean {
    const record = this.subscribers.get(id);
    if (record === undefined || record.token !== token) return false;
    this.subscribers.delete(id);
    const session = this.sessions.get(record.session_id);
    if (session !== undefined) {
      session.subscribers.delete(id);
      if (session.subscribers.size === 0) this.sessions.delete(record.session_id);
    }
    return true;
  }

  private assertAvailable(): void {
    if (this.isClosed) {
      throw new HostDeckProjectionFanoutError("fanout_closed", "Projection fanout hub is closed.");
    }
    if (this.currentFailure !== null) throw this.stoppedError();
  }

  private stoppedError(): HostDeckProjectionFanoutError {
    return new HostDeckProjectionFanoutError(
      "fanout_stopped",
      `Projection fanout stopped after ${this.currentFailure?.code ?? "an unknown failure"}.`
    );
  }

  private fail(
    error: HostDeckProjectionFanoutError,
    sessionId: string | null,
    cursor: OutputCursor | null,
    failedSubscriberCount: number
  ): never {
    if (this.currentFailure === null) {
      this.currentFailure = Object.freeze({
        code: fatalFailureCode(error.code),
        cursor,
        failed_subscriber_count: failedSubscriberCount,
        session_id: sessionId
      });
    }
    this.clearSubscribers();
    throw error;
  }

  private clearSubscribers(): void {
    this.subscribers.clear();
    this.sessions.clear();
  }
}

function fatalFailureCode(code: ProjectionFanoutErrorCode): ProjectionFanoutFailure["code"] {
  switch (code) {
    case "invalid_publication":
    case "publication_backward":
    case "publication_duplicate":
    case "publication_gap":
    case "publication_reentrant":
    case "subscriber_delivery_failed":
      return code;
    case "fanout_closed":
    case "fanout_stopped":
    case "invalid_subscription":
    case "subscriber_exists":
    case "subscriber_limit":
    case "subscriber_session_limit":
      throw new TypeError("A nonfatal projection fanout error cannot stop the hub.");
  }
}

function parseOptions(options: unknown): Required<ProjectionFanoutHubOptions> {
  const value = requirePlainRecord(options, "Projection fanout options must be a plain object.");
  assertExactKeys(value, ["max_subscribers", "max_subscribers_per_session"], true);
  const maxSubscribers = parseLimit(value.max_subscribers, globalSubscriberDefinition);
  const maxSubscribersPerSession = parseLimit(value.max_subscribers_per_session, sessionSubscriberDefinition);
  if (maxSubscribersPerSession > maxSubscribers) {
    throw new TypeError("Projection fanout per-session subscriber limit cannot exceed the global limit.");
  }
  return { max_subscribers: maxSubscribers, max_subscribers_per_session: maxSubscribersPerSession };
}

function parseLimit(
  candidate: unknown,
  definition: { readonly default_value: number; readonly maximum: number; readonly minimum: number }
): number {
  const value = candidate === undefined ? definition.default_value : candidate;
  if (!Number.isSafeInteger(value) || (value as number) < definition.minimum || (value as number) > definition.maximum) {
    throw new TypeError("Projection fanout subscriber limit is outside the selected resource policy.");
  }
  return value as number;
}

function parseSubscription(candidate: unknown): Omit<SubscriberRecord, "token"> {
  const value = requirePlainRecord(candidate, "Projection fanout subscription must be a plain object.", "invalid_subscription");
  assertExactKeys(value, ["id", "on_event", "session_id"], false, "invalid_subscription");
  const sessionId = sessionIdSchema.safeParse(value.session_id);
  if (
    typeof value.id !== "string" ||
    !subscriberIdPattern.test(value.id) ||
    typeof value.on_event !== "function" ||
    !sessionId.success
  ) {
    throw new HostDeckProjectionFanoutError("invalid_subscription", "Projection fanout subscription is invalid.");
  }
  return { id: value.id, on_event: value.on_event as ProjectionFanoutSubscriber, session_id: sessionId.data };
}

function parseCommittedPublication(candidate: unknown): CommittedProjectionAppend {
  if (!isDeepFrozen(candidate)) {
    throw new HostDeckProjectionFanoutError(
      "invalid_publication",
      "Projection fanout accepts only deeply frozen committed append results."
    );
  }
  const value = requirePlainRecord(candidate, "Committed projection publication must be a plain object.", "invalid_publication");
  assertExactKeys(value, ["event", "projection", "revision"], false, "invalid_publication");
  const event = selectedProjectedEventRecordSchema.safeParse(value.event);
  const projection = selectedSessionProjectionRecordSchema.safeParse(value.projection);
  const revision = parseRevision(value.revision);
  if (!event.success || !projection.success) {
    throw new HostDeckProjectionFanoutError("invalid_publication", "Committed projection publication shape is invalid.");
  }
  const cursor = event.data.event.cursor;
  if (
    cursor < 1 ||
    event.data.byte_length !== selectedProjectedEventByteLength(event.data.event) ||
    event.data.event.session_id !== projection.data.session.id ||
    projection.data.session.last_event_cursor !== cursor ||
    projection.data.retained_event_count < 1 ||
    projection.data.earliest_retained_cursor === null ||
    projection.data.earliest_retained_cursor > cursor ||
    revision.last_event_cursor !== cursor ||
    revision.projection_updated_at !== projection.data.session.updated_at
  ) {
    throw new HostDeckProjectionFanoutError(
      "invalid_publication",
      "Committed projection event, projection, and revision contradict each other."
    );
  }
  return deepFreeze({ event: event.data, projection: projection.data, revision });
}

function parseRevision(candidate: unknown): SelectedStateRevision {
  const value = requirePlainRecord(candidate, "Committed projection revision must be a plain object.", "invalid_publication");
  assertExactKeys(value, ["last_event_cursor", "mapping_updated_at", "projection_updated_at"], false, "invalid_publication");
  const mappingUpdatedAt = isoTimestampSchema.safeParse(value.mapping_updated_at);
  const projectionUpdatedAt = isoTimestampSchema.safeParse(value.projection_updated_at);
  const lastEventCursor = value.last_event_cursor === null ? null : outputCursorSchema.safeParse(value.last_event_cursor);
  if (!mappingUpdatedAt.success || !projectionUpdatedAt.success || lastEventCursor === null || !lastEventCursor.success) {
    throw new HostDeckProjectionFanoutError("invalid_publication", "Committed projection revision is invalid.");
  }
  return {
    last_event_cursor: lastEventCursor.data,
    mapping_updated_at: mappingUpdatedAt.data,
    projection_updated_at: projectionUpdatedAt.data
  };
}

function requirePlainRecord(
  candidate: unknown,
  message: string,
  code?: "invalid_publication" | "invalid_subscription"
): Readonly<Record<string, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
  ) {
    if (code !== undefined) throw new HostDeckProjectionFanoutError(code, message);
    throw new TypeError(message);
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  candidate: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  optional: boolean,
  code?: "invalid_publication" | "invalid_subscription"
): void {
  const allowed = new Set(expected);
  const actual = Object.keys(candidate);
  const invalid = actual.some((key) => !allowed.has(key)) || (!optional && actual.length !== expected.length);
  if (!invalid) return;
  if (code !== undefined) throw new HostDeckProjectionFanoutError(code, "Projection fanout fields are invalid.");
  throw new TypeError("Projection fanout option fields are invalid.");
}

function isDeepFrozen(candidate: unknown, seen = new WeakSet<object>()): boolean {
  if (candidate === null || typeof candidate !== "object") return true;
  if (seen.has(candidate)) return true;
  seen.add(candidate);
  if (!Object.isFrozen(candidate)) return false;
  return Object.values(candidate).every((child) => isDeepFrozen(child, seen));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}

function observeInvalidThenable(value: PromiseLike<unknown>): void {
  // Delivery is already classified as fatal; observing settlement prevents an unhandled rejection.
  void Promise.resolve(value).then(
    () => undefined,
    () => undefined
  );
}
