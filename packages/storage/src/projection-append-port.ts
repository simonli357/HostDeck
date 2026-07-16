import {
  defaultRetentionPolicy,
  isoTimestampSchema,
  type ManagedSessionProjection,
  managedSessionProjectionSchema,
  outputCursorSchema,
  type RetentionPolicy,
  retentionPolicySchema,
  type SelectedProjectionEvent,
  selectedProjectionEventSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import {
  type AppendSelectedEventResult,
  HostDeckSelectedStateRepositoryError,
  parseSelectedStateRevision,
  type SelectedStateRepository,
  type SelectedStateRevision,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "./selected-state-repository.js";

type WithoutEventAddress<Event> = Event extends { type: "replay_boundary" }
  ? Omit<Event, "cursor" | "next_cursor" | "session_id">
  : Omit<Event, "cursor" | "session_id">;

export type UncommittedSelectedProjectionEvent = WithoutEventAddress<SelectedProjectionEvent>;
export type UncommittedManagedSessionProjection = Omit<ManagedSessionProjection, "last_event_cursor">;

export interface ProductionProjectionAppendInput {
  readonly session_id: string;
  readonly expected_revision: SelectedStateRevision;
  readonly event: UncommittedSelectedProjectionEvent;
  readonly next_session: UncommittedManagedSessionProjection;
}

export type CommittedProjectionAppend = AppendSelectedEventResult;

export type ProjectionAppendPublisher = (committed: CommittedProjectionAppend) => void | Promise<void>;

export interface ProductionProjectionAppendPort {
  readonly append: (input: ProductionProjectionAppendInput) => Promise<CommittedProjectionAppend>;
}

export type ProjectionContinuityBoundaryReason = "disconnect" | "restart" | "schema_change";

export interface ProductionProjectionContinuityInput {
  readonly session_id: string;
  readonly expected_revision: SelectedStateRevision;
  readonly captured_at: string;
  readonly reason: ProjectionContinuityBoundaryReason;
  readonly next_session: UncommittedManagedSessionProjection;
}

export interface ProductionProjectionContinuityPort {
  readonly replaceWithBoundary: (
    input: ProductionProjectionContinuityInput
  ) => Promise<CommittedProjectionAppend>;
}

export interface ProductionProjectionAppendPortOptions {
  readonly repository: SelectedStateRepository;
  readonly publish: ProjectionAppendPublisher;
  readonly retention?: RetentionPolicy;
}

export interface ProductionProjectionContinuityPortOptions {
  readonly repository: SelectedStateRepository;
  readonly publish: ProjectionAppendPublisher;
}

export class HostDeckProjectionPublicationError extends Error {
  readonly code = "publication_failed";
  readonly durability = "committed";
  readonly publication_outcome = "unknown";

  constructor(
    readonly committed: CommittedProjectionAppend,
    options: ErrorOptions
  ) {
    super("Projected event committed, but publication outcome is unknown.", options);
    this.name = "HostDeckProjectionPublicationError";
  }
}

interface ParsedProductionProjectionAppendInput {
  readonly session_id: string;
  readonly expected_revision: SelectedStateRevision;
  readonly event: Readonly<Record<string, unknown>>;
  readonly next_session: Readonly<Record<string, unknown>>;
}

interface ParsedProductionProjectionContinuityInput {
  readonly session_id: string;
  readonly expected_revision: SelectedStateRevision;
  readonly captured_at: string;
  readonly reason: ProjectionContinuityBoundaryReason;
  readonly next_session: Readonly<Record<string, unknown>>;
}

export function createProductionProjectionAppendPort(
  options: ProductionProjectionAppendPortOptions
): ProductionProjectionAppendPort {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.repository?.require !== "function" ||
    typeof options.repository.appendEvent !== "function"
  ) {
    throw new TypeError("Production projection append requires a selected-state repository.");
  }
  if (typeof options.publish !== "function") {
    throw new TypeError("Production projection append requires a post-commit publisher.");
  }
  const repository = options.repository;
  const publish = options.publish;
  const retention = parseRetention(options.retention ?? defaultRetentionPolicy);

  return Object.freeze({
    async append(input: ProductionProjectionAppendInput) {
      const parsed = parseAppendInput(input);
      const current = repository.require(parsed.session_id);
      assertExpectedRevision(current, parsed.expected_revision);
      const cursor = assignNextCursor(current.projection.session.last_event_cursor, current.projection.retention_boundary_cursor);
      const event = parseAddressedEvent(parsed, cursor);
      const nextSession = parseAddressedSession(parsed.next_session, cursor);
      const record = { event, byte_length: selectedProjectedEventByteLength(event) };
      const nextProjection = {
        session: nextSession,
        retained_event_count: current.projection.retained_event_count + 1,
        retained_event_bytes: current.projection.retained_event_bytes + record.byte_length,
        earliest_retained_cursor: current.projection.earliest_retained_cursor ?? cursor,
        retention_boundary_cursor:
          event.type === "replay_boundary" ? event.after : current.projection.retention_boundary_cursor
      };
      const committed = deepFreeze(repository.appendEvent(record, nextProjection, parsed.expected_revision, retention));

      try {
        await publish(committed);
      } catch (error) {
        throw new HostDeckProjectionPublicationError(committed, { cause: error });
      }
      return committed;
    }
  });
}

export function createProductionProjectionContinuityPort(
  options: ProductionProjectionContinuityPortOptions
): ProductionProjectionContinuityPort {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.repository?.require !== "function" ||
    typeof options.repository.replaceEventsWithBoundary !== "function"
  ) {
    throw new TypeError("Production projection continuity requires a selected-state repository.");
  }
  if (typeof options.publish !== "function") {
    throw new TypeError("Production projection continuity requires a post-commit publisher.");
  }
  const repository = options.repository;
  const publish = options.publish;

  return Object.freeze({
    async replaceWithBoundary(input: ProductionProjectionContinuityInput) {
      const parsed = parseContinuityInput(input);
      const current = repository.require(parsed.session_id);
      assertExpectedRevision(current, parsed.expected_revision);
      const floor = Math.max(
        current.projection.session.last_event_cursor ?? 0,
        current.projection.retention_boundary_cursor ?? 0
      );
      const cursor = parseNextCursor(floor);
      const event = selectedProjectionEventSchema.parse({
        session_id: parsed.session_id,
        cursor,
        captured_at: parsed.captured_at,
        upstream_at: null,
        codex_event_id: null,
        codex_event_type: null,
        content_state: "complete",
        content_notice: null,
        type: "replay_boundary",
        after: floor === 0 ? null : floor,
        next_cursor: cursor,
        reason: parsed.reason
      });
      const nextSession = parseAddressedSession(parsed.next_session, cursor);
      const record = { event, byte_length: selectedProjectedEventByteLength(event) };
      const nextProjection = {
        session: nextSession,
        retained_event_count: 1,
        retained_event_bytes: record.byte_length,
        earliest_retained_cursor: cursor,
        retention_boundary_cursor: floor === 0 ? null : floor
      };
      const committed = deepFreeze(
        repository.replaceEventsWithBoundary(record, nextProjection, parsed.expected_revision)
      );

      try {
        await publish(committed);
      } catch (error) {
        throw new HostDeckProjectionPublicationError(committed, { cause: error });
      }
      return committed;
    }
  });
}

function parseRetention(candidate: unknown): RetentionPolicy {
  const parsed = retentionPolicySchema.safeParse(candidate);
  if (!parsed.success || parsed.data.output_event_limit < 2) {
    throw new TypeError("Production projection retention requires a valid policy with at least two output-event slots.", {
      cause: parsed.success ? undefined : parsed.error
    });
  }
  return Object.freeze({ ...parsed.data });
}

function assertExpectedRevision(
  current: ReturnType<SelectedStateRepository["require"]>,
  expected: SelectedStateRevision
): void {
  const actual = selectedStateRevision(current);
  if (
    actual.mapping_updated_at !== expected.mapping_updated_at ||
    actual.projection_updated_at !== expected.projection_updated_at ||
    actual.last_event_cursor !== expected.last_event_cursor
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "projection_conflict",
      "Production projection append revision does not match the state used for cursor assignment."
    );
  }
}

function parseAppendInput(candidate: unknown): ParsedProductionProjectionAppendInput {
  const value = requireRecord(candidate, "Production projection append input must be an object.", "invalid_event");
  assertExactKeys(value, ["event", "expected_revision", "next_session", "session_id"]);

  const sessionId = sessionIdSchema.safeParse(value.session_id);
  if (!sessionId.success) {
    throw new HostDeckSelectedStateRepositoryError("session_not_found", "Production projection target session id is invalid.", {
      cause: sessionId.error
    });
  }
  const event = requireRecord(value.event, "Uncommitted projected event must be an object.", "invalid_event");
  if (Object.hasOwn(event, "session_id") || Object.hasOwn(event, "cursor") || Object.hasOwn(event, "next_cursor")) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_event",
      "Production projected events cannot supply storage-owned session or cursor fields."
    );
  }
  const nextSession = requireRecord(
    value.next_session,
    "Uncommitted session projection must be an object.",
    "invalid_projection"
  );
  if (Object.hasOwn(nextSession, "last_event_cursor")) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "Production session projections cannot supply the storage-owned event cursor."
    );
  }
  return {
    session_id: sessionId.data,
    expected_revision: parseSelectedStateRevision(value.expected_revision),
    event,
    next_session: nextSession
  };
}

function parseContinuityInput(candidate: unknown): ParsedProductionProjectionContinuityInput {
  const value = requireRecord(candidate, "Production projection continuity input must be an object.", "invalid_event");
  assertExactKeys(value, ["captured_at", "expected_revision", "next_session", "reason", "session_id"]);
  const sessionId = sessionIdSchema.safeParse(value.session_id);
  if (!sessionId.success) {
    throw new HostDeckSelectedStateRepositoryError(
      "session_not_found",
      "Production continuity target session id is invalid.",
      { cause: sessionId.error }
    );
  }
  const capturedAt = isoTimestampSchema.safeParse(value.captured_at);
  if (!capturedAt.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Production continuity capture time is invalid.", {
      cause: capturedAt.error
    });
  }
  if (!["disconnect", "restart", "schema_change"].includes(value.reason as string)) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Production continuity reason is invalid.");
  }
  const nextSession = requireRecord(
    value.next_session,
    "Uncommitted continuity session projection must be an object.",
    "invalid_projection"
  );
  if (Object.hasOwn(nextSession, "last_event_cursor")) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "Continuity session projections cannot supply the storage-owned event cursor."
    );
  }
  return {
    session_id: sessionId.data,
    expected_revision: parseSelectedStateRevision(value.expected_revision),
    captured_at: capturedAt.data,
    reason: value.reason as ProjectionContinuityBoundaryReason,
    next_session: nextSession
  };
}

function assignNextCursor(lastEventCursor: number | null, retentionBoundaryCursor: number | null): number {
  return parseNextCursor(Math.max(lastEventCursor ?? 0, retentionBoundaryCursor ?? 0));
}

function parseNextCursor(floor: number): number {
  const candidate = floor + 1;
  const parsed = outputCursorSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckSelectedStateRepositoryError("cursor_not_monotonic", "Selected projection cursor space is exhausted.", {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function parseAddressedEvent(input: ParsedProductionProjectionAppendInput, cursor: number): SelectedProjectionEvent {
  const parsed = selectedProjectionEventSchema.safeParse({
    ...input.event,
    session_id: input.session_id,
    cursor,
    ...(input.event.type === "replay_boundary" ? { next_cursor: cursor } : {})
  });
  if (!parsed.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Uncommitted selected projected event is invalid.", {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function parseAddressedSession(candidate: Readonly<Record<string, unknown>>, cursor: number): ManagedSessionProjection {
  const parsed = managedSessionProjectionSchema.safeParse({ ...candidate, last_event_cursor: cursor });
  if (!parsed.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Uncommitted selected session projection is invalid.", {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function requireRecord(
  candidate: unknown,
  message: string,
  code: "invalid_event" | "invalid_projection"
): Readonly<Record<string, unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new HostDeckSelectedStateRepositoryError(code, message);
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function assertExactKeys(candidate: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(candidate).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Production projection append input fields are invalid.");
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  Object.freeze(value);
  return value;
}
