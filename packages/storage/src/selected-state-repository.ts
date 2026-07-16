import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import {
  clientOperationIdSchema,
  codexThreadIdSchema,
  isoTimestampSchema,
  type LegacySessionDispositionRecord,
  legacySessionDispositionRecordSchema,
  outputCursorSchema,
  type RetentionPolicy,
  retentionPolicySchema,
  type SelectedProjectedEventRecord,
  type SelectedSessionEventStream,
  type SelectedSessionMappingRecord,
  type SelectedSessionProjectionRecord,
  type SelectedSessionStartRecoveryRecord,
  selectedProjectedEventRecordSchema,
  selectedProjectionEventSchema,
  selectedSessionEventStreamSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  selectedSessionStartRecoveryRecordSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type SelectedStateRepositoryErrorCode =
  | "cursor_not_monotonic"
  | "duplicate_session_name"
  | "duplicate_thread_id"
  | "event_exists"
  | "identity_mismatch"
  | "invalid_event"
  | "invalid_legacy_record"
  | "invalid_mapping"
  | "invalid_projection"
  | "invalid_recovery"
  | "invalid_retention_policy"
  | "invalid_replay"
  | "projection_conflict"
  | "projection_write_failed"
  | "recovery_conflict"
  | "session_exists"
  | "session_not_found";

export class HostDeckSelectedStateRepositoryError extends Error {
  constructor(
    readonly code: SelectedStateRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckSelectedStateRepositoryError";
  }
}

export interface SelectedSessionState {
  readonly mapping: SelectedSessionMappingRecord;
  readonly projection: SelectedSessionProjectionRecord;
}

export interface SelectedStateRevision {
  readonly mapping_updated_at: string;
  readonly projection_updated_at: string;
  readonly last_event_cursor: number | null;
}

export interface ListSelectedEventsInput {
  readonly after?: number | null;
  readonly limit?: number;
}

export interface AppendSelectedEventResult {
  readonly event: SelectedProjectedEventRecord;
  readonly projection: SelectedSessionProjectionRecord;
  readonly revision: SelectedStateRevision;
}

export interface SelectedProjectionRetentionBatchInput {
  readonly max_pruned_events: number;
  readonly retention: RetentionPolicy;
  readonly session_id: string;
}

export interface SelectedProjectionRetentionBatchResult {
  readonly boundary_replaced: boolean;
  readonly newest_event_oversize: boolean;
  readonly projection: SelectedSessionProjectionRecord;
  readonly pruned_event_count: number;
  readonly remaining: boolean;
  readonly session_id: string;
}

export interface SelectedStateRepository {
  readonly get: (sessionId: string) => SelectedSessionState | null;
  readonly require: (sessionId: string) => SelectedSessionState;
  readonly getByThreadId: (threadId: string) => SelectedSessionState | null;
  readonly list: () => readonly SelectedSessionState[];
  readonly create: (state: unknown) => SelectedSessionState;
  readonly replace: (state: unknown, expectedRevision: unknown) => SelectedSessionState;
  readonly appendEvent: (
    event: unknown,
    nextProjection: unknown,
    expectedRevision: unknown,
    retention?: RetentionPolicy | null
  ) => AppendSelectedEventResult;
  readonly replaceEventsWithBoundary: (
    event: unknown,
    nextProjection: unknown,
    expectedRevision: unknown
  ) => AppendSelectedEventResult;
  readonly listEvents: (sessionId: string, input?: ListSelectedEventsInput) => SelectedSessionEventStream;
  readonly getLegacyDisposition: (sessionId: string) => LegacySessionDispositionRecord | null;
  readonly listLegacyDispositions: () => readonly LegacySessionDispositionRecord[];
  readonly getRecovery: (operationId: string) => SelectedSessionStartRecoveryRecord | null;
  readonly listRecoveries: () => readonly SelectedSessionStartRecoveryRecord[];
  readonly putRecovery: (record: unknown) => SelectedSessionStartRecoveryRecord;
  readonly deleteRecovery: (operationId: string) => boolean;
}

interface MappingRow {
  readonly id: string;
  readonly name: string;
  readonly codex_thread_id: string;
  readonly cwd: string;
  readonly runtime_source: "codex_app_server";
  readonly runtime_version: string;
  readonly disposition: SelectedSessionMappingRecord["disposition"];
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

interface ProjectionRow {
  readonly session_id: string;
  readonly session_state: SelectedSessionProjectionRecord["session"]["session_state"];
  readonly turn_state: SelectedSessionProjectionRecord["session"]["turn_state"];
  readonly attention: SelectedSessionProjectionRecord["session"]["attention"];
  readonly freshness: SelectedSessionProjectionRecord["session"]["freshness"];
  readonly freshness_reason: string | null;
  readonly updated_at: string;
  readonly last_activity_at: string | null;
  readonly branch: string | null;
  readonly model: string | null;
  readonly settings_json: string | null;
  readonly goal_json: string | null;
  readonly recent_summary: string;
  readonly last_event_cursor: number | null;
  readonly retained_event_count: number;
  readonly retained_event_bytes: number;
  readonly earliest_retained_cursor: number | null;
  readonly retention_boundary_cursor: number | null;
}

interface EventRow {
  readonly session_id: string;
  readonly cursor: number;
  readonly normalized_type: SelectedProjectedEventRecord["event"]["type"];
  readonly codex_event_id: string | null;
  readonly codex_event_type: string | null;
  readonly captured_at: string;
  readonly content_state: SelectedProjectedEventRecord["event"]["content_state"];
  readonly byte_length: number;
  readonly event_json: string;
}

interface EventAggregateRow {
  readonly event_count: number;
  readonly event_bytes: number;
  readonly earliest_cursor: number | null;
  readonly latest_cursor: number | null;
}

interface LegacyDispositionRow {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly disposition: "legacy_unmigrated";
  readonly reason: string;
  readonly updated_at: string;
}

interface RecoveryRow {
  readonly operation_id: string;
  readonly session_id: string;
  readonly name: string;
  readonly cwd: string;
  readonly codex_thread_id: string | null;
  readonly state: SelectedSessionStartRecoveryRecord["state"];
  readonly created_at: string;
  readonly updated_at: string;
  readonly error_code: SelectedSessionStartRecoveryRecord["error_code"];
  readonly error_message: string | null;
}

const defaultEventLimit = 100;
const maxEventLimit = 500;

export function createSelectedStateRepository(db: Database.Database): SelectedStateRepository {
  const createTransaction = db.transaction((state: SelectedSessionState): SelectedSessionState => {
    assertSelectedCreateRecoveryCompatibility(db, state.mapping);
    try {
      insertMapping(db, state.mapping);
      insertProjection(db, state.projection);
    } catch (error) {
      throw mapStateConstraint(error);
    }
    return state;
  }).immediate;

  const replaceTransaction = db.transaction((state: SelectedSessionState, expectedRevision: SelectedStateRevision): SelectedSessionState => {
    const current = requireState(db, state.mapping.id);
    assertPersistedEventProjection(db, current.projection);
    assertCurrentRevision(current, expectedRevision);
    assertImmutableMappingIdentity(current.mapping, state.mapping);
    assertSafeStateReplacement(current, state);

    try {
      const mappingResult = db
        .prepare(
          `
            UPDATE selected_sessions SET
              name = @name,
              cwd = @cwd,
              runtime_source = @runtime_source,
              runtime_version = @runtime_version,
              disposition = @disposition,
              updated_at = @updated_at,
              archived_at = @archived_at
            WHERE id = @id
          `
        )
        .run(mappingToRow(state.mapping));
      const projectionResult = updateProjection(db, state.projection);
      if (mappingResult.changes !== 1 || projectionResult !== 1) {
        throw new HostDeckSelectedStateRepositoryError("session_not_found", `Selected session ${state.mapping.id} does not exist.`);
      }
    } catch (error) {
      if (error instanceof HostDeckSelectedStateRepositoryError) throw error;
      throw mapStateConstraint(error);
    }
    return state;
  }).immediate;

  const appendEventTransaction = db.transaction(
    (
      event: SelectedProjectedEventRecord,
      nextProjection: SelectedSessionProjectionRecord,
      expectedRevision: SelectedStateRevision,
      retention: RetentionPolicy | null
    ): AppendSelectedEventResult => {
      const current = requireState(db, event.event.session_id);
      assertPersistedEventProjection(db, current.projection);
      assertCurrentRevision(current, expectedRevision);
      assertProjectionIdentity(current.mapping, nextProjection);
      assertEventAdvance(current.projection, event, nextProjection);

      let committedProjection = nextProjection;
      try {
        insertEvent(db, event);
        if (retention !== null) {
          committedProjection = applySelectedProjectionRetention(db, nextProjection, retention);
        }
        if (updateProjection(db, committedProjection) !== 1) {
          throw new HostDeckSelectedStateRepositoryError(
            "session_not_found",
            `Selected session ${event.event.session_id} does not exist.`
          );
        }
      } catch (error) {
        if (error instanceof HostDeckSelectedStateRepositoryError) throw error;
        throw mapEventConstraint(error);
      }

      return {
        event,
        projection: committedProjection,
        revision: selectedStateRevision({ mapping: current.mapping, projection: committedProjection })
      };
    }
  ).immediate;

  const replaceEventsWithBoundaryTransaction = db.transaction(
    (
      event: SelectedProjectedEventRecord,
      nextProjection: SelectedSessionProjectionRecord,
      expectedRevision: SelectedStateRevision
    ): AppendSelectedEventResult => {
      const current = requireState(db, event.event.session_id);
      assertPersistedEventProjection(db, current.projection);
      assertCurrentRevision(current, expectedRevision);
      assertProjectionIdentity(current.mapping, nextProjection);
      assertContinuityBoundaryReplacement(current.projection, event, nextProjection);

      try {
        db.prepare("DELETE FROM selected_projected_events WHERE session_id = ?").run(event.event.session_id);
        insertEvent(db, event);
        if (updateProjection(db, nextProjection) !== 1) {
          throw new HostDeckSelectedStateRepositoryError(
            "session_not_found",
            `Selected session ${event.event.session_id} does not exist.`
          );
        }
      } catch (error) {
        if (error instanceof HostDeckSelectedStateRepositoryError) throw error;
        throw mapEventConstraint(error);
      }

      return {
        event,
        projection: nextProjection,
        revision: selectedStateRevision({ mapping: current.mapping, projection: nextProjection })
      };
    }
  ).immediate;

  const putRecoveryTransaction = db.transaction((record: SelectedSessionStartRecoveryRecord): SelectedSessionStartRecoveryRecord => {
    if (record.updated_at < record.created_at) {
      throw new HostDeckSelectedStateRepositoryError("invalid_recovery", "Session-start recovery update cannot precede creation.");
    }
    const current = readRecovery(db, record.operation_id);
    if (current === null) {
      if (record.state !== "reserved") {
        throw new HostDeckSelectedStateRepositoryError("recovery_conflict", "New session-start recovery records must begin reserved.");
      }
      assertRecoveryReservationAvailable(db, record);
      try {
        insertRecovery(db, record);
      } catch (error) {
        throw mapRecoveryConstraint(error);
      }
      return record;
    }

    assertRecoveryTransition(current, record);
    assertRecoveryThreadAvailable(db, record);
    if (record.state === "persisted") assertPersistedRecoveryMatchesSelectedState(db, record);
    try {
      db.prepare(
        `
          UPDATE selected_session_start_recovery SET
            codex_thread_id = @codex_thread_id,
            state = @state,
            updated_at = @updated_at,
            error_code = @error_code,
            error_message = @error_message
          WHERE operation_id = @operation_id
        `
      ).run(recoveryToRow(record));
    } catch (error) {
      throw mapRecoveryConstraint(error);
    }
    return record;
  }).immediate;

  return {
    get(sessionId) {
      return readState(db, parseSessionId(sessionId));
    },
    require(sessionId) {
      return requireState(db, parseSessionId(sessionId));
    },
    getByThreadId(threadId) {
      const parsedThreadId = parseThreadId(threadId);
      const row = db.prepare("SELECT id FROM selected_sessions WHERE codex_thread_id = ?").get(parsedThreadId) as
        | { readonly id: string }
        | undefined;
      return row === undefined ? null : requireState(db, row.id);
    },
    list() {
      const rows = db.prepare("SELECT id FROM selected_sessions ORDER BY created_at ASC, id ASC").all() as Array<{ readonly id: string }>;
      return rows.map((row) => requireState(db, row.id));
    },
    create(state) {
      const parsed = parseState(state);
      assertInitialProjection(parsed.projection);
      return createTransaction(parsed);
    },
    replace(state, expectedRevision) {
      return replaceTransaction(parseState(state), parseSelectedStateRevision(expectedRevision));
    },
    appendEvent(event, nextProjection, expectedRevision, retention = null) {
      const parsedEvent = parseProjectedEventRecord(event);
      assertEventByteLength(parsedEvent);
      return appendEventTransaction(
        parsedEvent,
        parseProjection(nextProjection),
        parseSelectedStateRevision(expectedRevision),
        retention === null ? null : parseSelectedProjectionRetentionPolicy(retention)
      );
    },
    replaceEventsWithBoundary(event, nextProjection, expectedRevision) {
      const parsedEvent = parseProjectedEventRecord(event);
      assertEventByteLength(parsedEvent);
      return replaceEventsWithBoundaryTransaction(
        parsedEvent,
        parseProjection(nextProjection),
        parseSelectedStateRevision(expectedRevision)
      );
    },
    listEvents(sessionId, input = {}) {
      const parsedSessionId = parseSessionId(sessionId);
      const state = requireState(db, parsedSessionId);
      assertPersistedEventProjection(db, state.projection);
      const after = parseEventAfter(input.after ?? null);
      const limit = parseEventLimit(input.limit ?? defaultEventLimit);
      if (after !== null && after > (state.projection.session.last_event_cursor ?? 0)) {
        throw new HostDeckSelectedStateRepositoryError("invalid_replay", "Replay cursor is ahead of the committed session cursor.");
      }

      const rows =
        after === null
          ? (db
              .prepare("SELECT * FROM selected_projected_events WHERE session_id = ? ORDER BY cursor ASC LIMIT ?")
              .all(parsedSessionId, limit) as EventRow[])
          : (db
              .prepare("SELECT * FROM selected_projected_events WHERE session_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?")
              .all(parsedSessionId, after, limit) as EventRow[]);
      const events = rows.map(parseEventRow).map((record) => record.event);
      const committedCursor = state.projection.session.last_event_cursor;
      if (committedCursor !== null && (after === null || after < committedCursor) && events.length === 0) {
        throw new HostDeckSelectedStateRepositoryError(
          "invalid_event",
          "Committed projection cursor has no retained event or replay boundary."
        );
      }
      const retentionBoundary = state.projection.retention_boundary_cursor;
      const crossedBoundary = retentionBoundary !== null && (after === null || after <= retentionBoundary);
      if (crossedBoundary && events[0]?.type !== "replay_boundary") {
        throw new HostDeckSelectedStateRepositoryError(
          "invalid_event",
          "Replay crossing a retention boundary must begin with an explicit boundary event."
        );
      }
      return selectedSessionEventStreamSchema.parse({
        session_id: parsedSessionId,
        events,
        next_cursor: events.at(-1)?.cursor ?? state.projection.session.last_event_cursor ?? 0,
        truncated: events[0]?.type === "replay_boundary"
      });
    },
    getLegacyDisposition(sessionId) {
      const parsedSessionId = parseSessionId(sessionId);
      const row = db.prepare("SELECT * FROM legacy_session_dispositions WHERE id = ?").get(parsedSessionId) as
        | LegacyDispositionRow
        | undefined;
      return row === undefined ? null : parseLegacyDisposition(row);
    },
    listLegacyDispositions() {
      return (db.prepare("SELECT * FROM legacy_session_dispositions ORDER BY updated_at ASC, id ASC").all() as LegacyDispositionRow[]).map(
        parseLegacyDisposition
      );
    },
    getRecovery(operationId) {
      return readRecovery(db, parseOperationId(operationId));
    },
    listRecoveries() {
      return (db.prepare("SELECT * FROM selected_session_start_recovery ORDER BY created_at ASC, operation_id ASC").all() as RecoveryRow[]).map(
        parseRecoveryRow
      );
    },
    putRecovery(record) {
      return putRecoveryTransaction(parseRecovery(record));
    },
    deleteRecovery(operationId) {
      return db.prepare("DELETE FROM selected_session_start_recovery WHERE operation_id = ?").run(parseOperationId(operationId)).changes === 1;
    }
  };
}

export function selectedProjectedEventByteLength(event: unknown): number {
  const parsed = selectedProjectionEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Selected projected event is invalid.", { cause: parsed.error });
  }
  return Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
}

export function maintainSelectedProjectionRetentionBatch(
  db: Database.Database,
  input: SelectedProjectionRetentionBatchInput
): SelectedProjectionRetentionBatchResult {
  const sessionId = parseSessionId(input?.session_id);
  const policy = parseSelectedProjectionRetentionPolicy(input?.retention);
  const maxPrunedEvents = parseRetentionBatchSize(input?.max_pruned_events);
  const transaction = db.transaction((): SelectedProjectionRetentionBatchResult => {
    const current = requireState(db, sessionId);
    assertPersistedEventProjection(db, current.projection);
    if (projectionMeetsRetention(current.projection, policy)) {
      return Object.freeze({
        boundary_replaced: false,
        newest_event_oversize: false,
        projection: current.projection,
        pruned_event_count: 0,
        remaining: false,
        session_id: sessionId
      });
    }

    const window = readSelectedRetentionWindow(db, sessionId, maxPrunedEvents + 2);
    const priorBoundary = window[0]?.event.type === "replay_boundary" ? window[0] : null;
    const realEvents = window.filter((record) => record.event.type !== "replay_boundary");
    const removed: SelectedProjectedEventRecord[] = [];
    let removedBytes = 0;
    let boundary: ReturnType<typeof createRetentionBoundaryRecord> | null = null;
    for (let index = 0; index < realEvents.length && removed.length < maxPrunedEvents; index += 1) {
      const candidate = realEvents[index];
      const oldestRemaining = realEvents[index + 1];
      if (
        candidate === undefined ||
        oldestRemaining === undefined ||
        candidate.event.cursor === current.projection.session.last_event_cursor
      ) {
        break;
      }
      removed.push(candidate);
      removedBytes += candidate.byte_length;
      boundary = createRetentionBoundaryRecord(sessionId, candidate.event.cursor, oldestRemaining.event.captured_at);
      const projectedCount =
        current.projection.retained_event_count - removed.length - (priorBoundary === null ? 0 : 1) + 1;
      const projectedBytes =
        current.projection.retained_event_bytes -
        removedBytes -
        (priorBoundary?.byte_length ?? 0) +
        boundary.byte_length;
      if (projectedCount <= policy.output_event_limit && projectedBytes <= policy.output_byte_limit) break;
    }

    if (boundary === null || removed.length === 0) {
      return Object.freeze({
        boundary_replaced: false,
        newest_event_oversize: true,
        projection: current.projection,
        pruned_event_count: 0,
        remaining: false,
        session_id: sessionId
      });
    }

    const deletion = db
      .prepare("DELETE FROM selected_projected_events WHERE session_id = ? AND cursor <= ?")
      .run(sessionId, boundary.event.cursor);
    const expectedDeletedRows = removed.length + (priorBoundary === null ? 0 : 1);
    if (deletion.changes !== expectedDeletedRows) {
      throw new HostDeckSelectedStateRepositoryError(
        "projection_write_failed",
        "Selected retention batch deleted an unexpected number of rows."
      );
    }
    insertEvent(db, boundary);

    const aggregate = readSelectedProjectionAggregate(db, sessionId);
    const projection = parseProjection({
      ...current.projection,
      retained_event_count: aggregate.event_count,
      retained_event_bytes: aggregate.event_bytes,
      earliest_retained_cursor: aggregate.earliest_cursor,
      retention_boundary_cursor: boundary.event.after
    });
    if (updateProjection(db, projection) !== 1) {
      throw new HostDeckSelectedStateRepositoryError("session_not_found", `Selected session ${sessionId} does not exist.`);
    }
    assertPersistedEventProjection(db, projection);
    const overPolicy = !projectionMeetsRetention(projection, policy);
    const remaining = overPolicy && projection.retained_event_count > 2;
    return Object.freeze({
      boundary_replaced: priorBoundary !== null,
      newest_event_oversize: overPolicy && !remaining,
      projection,
      pruned_event_count: removed.length,
      remaining,
      session_id: sessionId
    });
  }).immediate;

  try {
    return transaction();
  } catch (error) {
    if (error instanceof HostDeckSelectedStateRepositoryError) throw error;
    throw mapEventConstraint(error);
  }
}

function projectionMeetsRetention(projection: SelectedSessionProjectionRecord, policy: RetentionPolicy): boolean {
  return (
    projection.retained_event_count <= policy.output_event_limit &&
    projection.retained_event_bytes <= policy.output_byte_limit
  );
}

function readSelectedRetentionWindow(
  db: Database.Database,
  sessionId: string,
  limit: number
): readonly SelectedProjectedEventRecord[] {
  return (
    db.prepare("SELECT * FROM selected_projected_events WHERE session_id = ? ORDER BY cursor ASC LIMIT ?").all(sessionId, limit) as EventRow[]
  ).map(parseEventRow);
}

function parseSelectedProjectionRetentionPolicy(candidate: unknown): RetentionPolicy {
  const parsed = retentionPolicySchema.safeParse(candidate);
  if (!parsed.success || parsed.data.output_event_limit < 2) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_retention_policy",
      "Selected projection retention requires a valid policy with at least two output-event slots.",
      parsed.success ? undefined : { cause: parsed.error }
    );
  }
  return parsed.data;
}

function applySelectedProjectionRetention(
  db: Database.Database,
  nextProjection: SelectedSessionProjectionRecord,
  policy: RetentionPolicy
): SelectedSessionProjectionRecord {
  if (
    nextProjection.retained_event_count <= policy.output_event_limit &&
    nextProjection.retained_event_bytes <= policy.output_byte_limit
  ) {
    return nextProjection;
  }

  const records = readSelectedProjectionRecords(db, nextProjection.session.id);
  assertSelectedRetentionLayout(records, nextProjection);
  const plan = planSelectedProjectionRetention(records, nextProjection, policy);
  const boundary = plan.boundary;
  if (boundary === null || plan.removable.length === 0) return nextProjection;
  if (
    nextProjection.retention_boundary_cursor !== null &&
    boundary.event.after !== null &&
    boundary.event.after < nextProjection.retention_boundary_cursor
  ) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected retention boundary cannot move backward.");
  }

  const deletion = db
    .prepare("DELETE FROM selected_projected_events WHERE session_id = ? AND cursor <= ?")
    .run(nextProjection.session.id, boundary.event.cursor);
  if (deletion.changes < 1) {
    throw new HostDeckSelectedStateRepositoryError("projection_write_failed", "Selected retention removed no rows at its boundary cursor.");
  }
  insertEvent(db, boundary);

  return parseProjection({
    ...nextProjection,
    retained_event_count: plan.retained.length + 1,
    retained_event_bytes: plan.retained_bytes + boundary.byte_length,
    earliest_retained_cursor: boundary.event.cursor,
    retention_boundary_cursor: boundary.event.after
  });
}

interface SelectedProjectionRetentionPlan {
  readonly boundary: ReturnType<typeof createRetentionBoundaryRecord> | null;
  readonly newest_event_oversize: boolean;
  readonly real_ascending: readonly SelectedProjectedEventRecord[];
  readonly removable: readonly SelectedProjectedEventRecord[];
  readonly retained: readonly SelectedProjectedEventRecord[];
  readonly retained_bytes: number;
}

function planSelectedProjectionRetention(
  records: readonly SelectedProjectedEventRecord[],
  projection: SelectedSessionProjectionRecord,
  policy: RetentionPolicy
): SelectedProjectionRetentionPlan {
  const realNewestFirst = records.filter((record) => record.event.type !== "replay_boundary");
  const realAscending = [...realNewestFirst].reverse();
  if (
    projection.retained_event_count <= policy.output_event_limit &&
    projection.retained_event_bytes <= policy.output_byte_limit
  ) {
    return {
      boundary: null,
      newest_event_oversize: false,
      real_ascending: realAscending,
      removable: [],
      retained: realNewestFirst,
      retained_bytes: realNewestFirst.reduce((sum, record) => sum + record.byte_length, 0)
    };
  }
  const newest = realNewestFirst[0];
  if (newest === undefined) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected retention has no real event to preserve.");
  }
  if (realNewestFirst.length === 1) {
    return {
      boundary: null,
      newest_event_oversize: true,
      real_ascending: realAscending,
      removable: [],
      retained: [newest],
      retained_bytes: newest.byte_length
    };
  }

  const retained: SelectedProjectedEventRecord[] = [newest];
  let retainedBytes = newest.byte_length;
  const maxRetainedEvents = policy.output_event_limit - 1;
  for (const candidate of realNewestFirst.slice(1)) {
    if (retained.length >= maxRetainedEvents || candidate.event.cursor <= 1) break;
    const candidateBoundary = createRetentionBoundaryRecord(
      projection.session.id,
      candidate.event.cursor - 1,
      candidate.event.captured_at
    );
    if (candidateBoundary.byte_length + retainedBytes + candidate.byte_length > policy.output_byte_limit) break;
    retained.push(candidate);
    retainedBytes += candidate.byte_length;
  }
  const oldestRetained = retained.at(-1);
  if (oldestRetained === undefined || oldestRetained.event.cursor <= 1) {
    return {
      boundary: null,
      newest_event_oversize: true,
      real_ascending: realAscending,
      removable: [],
      retained,
      retained_bytes: retainedBytes
    };
  }
  const boundary = createRetentionBoundaryRecord(
    projection.session.id,
    oldestRetained.event.cursor - 1,
    oldestRetained.event.captured_at
  );
  const removable = realAscending.filter((record) => record.event.cursor <= boundary.event.cursor);
  return {
    boundary,
    newest_event_oversize: false,
    real_ascending: realAscending,
    removable,
    retained,
    retained_bytes: retainedBytes
  };
}

function readSelectedProjectionRecords(db: Database.Database, sessionId: string): readonly SelectedProjectedEventRecord[] {
  return (
    db.prepare("SELECT * FROM selected_projected_events WHERE session_id = ? ORDER BY cursor DESC").all(sessionId) as EventRow[]
  ).map(parseEventRow);
}

function readSelectedProjectionAggregate(db: Database.Database, sessionId: string): EventAggregateRow {
  return db
    .prepare(
      `
        SELECT
          COUNT(*) AS event_count,
          COALESCE(SUM(byte_length), 0) AS event_bytes,
          MIN(cursor) AS earliest_cursor,
          MAX(cursor) AS latest_cursor
        FROM selected_projected_events
        WHERE session_id = ?
      `
    )
    .get(sessionId) as EventAggregateRow;
}

function assertSelectedRetentionLayout(
  recordsNewestFirst: readonly SelectedProjectedEventRecord[],
  projection: SelectedSessionProjectionRecord
): void {
  if (recordsNewestFirst.length === 0) {
    if (projection.retained_event_count !== 0) {
      throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected retention projection has missing rows.");
    }
    return;
  }
  const ascending = [...recordsNewestFirst].reverse();
  const boundaries = ascending.filter((record) => record.event.type === "replay_boundary");
  if (boundaries.length > 1 || (boundaries.length === 1 && ascending[0] !== boundaries[0])) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Selected retention rows contain a misplaced boundary.");
  }
  if (!ascending.some((record) => record.event.type !== "replay_boundary")) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Selected retention cannot contain only a boundary.");
  }
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index]?.event.cursor !== (ascending[index - 1]?.event.cursor ?? 0) + 1) {
      throw new HostDeckSelectedStateRepositoryError("invalid_event", "Selected retained event cursors are not contiguous.");
    }
  }
  const first = ascending[0] as SelectedProjectedEventRecord;
  const last = ascending.at(-1) as SelectedProjectedEventRecord;
  if (
    first.event.cursor !== projection.earliest_retained_cursor ||
    last.event.cursor !== projection.session.last_event_cursor
  ) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected retention row range contradicts projection state.");
  }
  if (projection.retention_boundary_cursor === null) {
    if (first.event.type === "replay_boundary" || first.event.cursor !== 1) {
      throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected retention boundary metadata is missing.");
    }
  } else if (
    first.event.type !== "replay_boundary" ||
    first.event.after !== projection.retention_boundary_cursor ||
    first.event.cursor !== projection.retention_boundary_cursor + 1
  ) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected retention boundary metadata contradicts its row.");
  }
}

function parseRetentionBatchSize(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > 1_000) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_retention_policy",
      "Selected retention batch size must be between 1 and 1000."
    );
  }
  return candidate as number;
}

function createRetentionBoundaryRecord(
  sessionId: string,
  cursor: number,
  capturedAt: string
): SelectedProjectedEventRecord & { readonly event: Extract<SelectedProjectedEventRecord["event"], { type: "replay_boundary" }> } {
  const event = selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: capturedAt,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after: cursor - 1,
    next_cursor: cursor,
    reason: "retention"
  });
  if (event.type !== "replay_boundary") {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Selected retention did not produce a replay boundary.");
  }
  return { event, byte_length: selectedProjectedEventByteLength(event) };
}

export function selectedStateRevision(state: SelectedSessionState): SelectedStateRevision {
  return {
    mapping_updated_at: state.mapping.updated_at,
    projection_updated_at: state.projection.session.updated_at,
    last_event_cursor: state.projection.session.last_event_cursor
  };
}

function readState(db: Database.Database, sessionId: string): SelectedSessionState | null {
  const mappingRow = db.prepare("SELECT * FROM selected_sessions WHERE id = ?").get(sessionId) as MappingRow | undefined;
  if (mappingRow === undefined) return null;
  const projectionRow = db.prepare("SELECT * FROM selected_session_projections WHERE session_id = ?").get(sessionId) as ProjectionRow | undefined;
  if (projectionRow === undefined) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", `Selected session ${sessionId} is missing its projection.`);
  }
  return parseStateRows(mappingRow, projectionRow);
}

function requireState(db: Database.Database, sessionId: string): SelectedSessionState {
  const state = readState(db, sessionId);
  if (state === null) {
    throw new HostDeckSelectedStateRepositoryError("session_not_found", `Selected session ${sessionId} does not exist.`);
  }
  return state;
}

function parseState(candidate: unknown): SelectedSessionState {
  if (candidate === null || typeof candidate !== "object") {
    throw new HostDeckSelectedStateRepositoryError("invalid_mapping", "Selected session state must be an object.");
  }
  const keys = Object.keys(candidate);
  if (keys.length !== 2 || !keys.includes("mapping") || !keys.includes("projection")) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_mapping",
      "Selected session state must contain exactly mapping and projection."
    );
  }
  const mapping = parseMapping((candidate as { readonly mapping?: unknown }).mapping);
  const projection = parseProjection((candidate as { readonly projection?: unknown }).projection);
  assertProjectionIdentity(mapping, projection);
  assertStateChronology(mapping, projection);
  return { mapping, projection };
}

function parseStateRows(mappingRow: MappingRow, projectionRow: ProjectionRow): SelectedSessionState {
  const mapping = parseMapping(mappingRow);
  const goal = parseNullableJson(projectionRow.goal_json, "invalid_projection", "Stored selected goal JSON is invalid.");
  const settings = parseNullableJson(
    projectionRow.settings_json,
    "invalid_projection",
    "Stored selected settings JSON is invalid."
  );
  const projection = parseProjection({
    session: {
      id: mapping.id,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: mapping.archived_at,
      session_state: projectionRow.session_state,
      turn_state: projectionRow.turn_state,
      attention: projectionRow.attention,
      freshness: projectionRow.freshness,
      freshness_reason: projectionRow.freshness_reason,
      updated_at: projectionRow.updated_at,
      last_activity_at: projectionRow.last_activity_at,
      branch: projectionRow.branch,
      model: projectionRow.model,
      settings,
      goal,
      recent_summary: projectionRow.recent_summary,
      last_event_cursor: projectionRow.last_event_cursor
    },
    retained_event_count: projectionRow.retained_event_count,
    retained_event_bytes: projectionRow.retained_event_bytes,
    earliest_retained_cursor: projectionRow.earliest_retained_cursor,
    retention_boundary_cursor: projectionRow.retention_boundary_cursor
  });
  assertStateChronology(mapping, projection);
  return { mapping, projection };
}

function parseMapping(candidate: unknown): SelectedSessionMappingRecord {
  const result = selectedSessionMappingRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_mapping", "Selected session mapping is invalid.", { cause: result.error });
  }
  return result.data;
}

function parseProjection(candidate: unknown): SelectedSessionProjectionRecord {
  const result = selectedSessionProjectionRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected session projection is invalid.", { cause: result.error });
  }
  return result.data;
}

function parseProjectedEventRecord(candidate: unknown): SelectedProjectedEventRecord {
  const result = selectedProjectedEventRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Selected projected event record is invalid.", { cause: result.error });
  }
  return result.data;
}

export function parseSelectedStateRevision(candidate: unknown): SelectedStateRevision {
  if (candidate === null || typeof candidate !== "object") {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected state revision must be an object.");
  }
  const keys = Object.keys(candidate);
  if (
    keys.length !== 3 ||
    !keys.includes("mapping_updated_at") ||
    !keys.includes("projection_updated_at") ||
    !keys.includes("last_event_cursor")
  ) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected state revision shape is invalid.");
  }
  const value = candidate as Record<string, unknown>;
  const mappingUpdatedAt = isoTimestampSchema.safeParse(value.mapping_updated_at);
  const projectionUpdatedAt = isoTimestampSchema.safeParse(value.projection_updated_at);
  const lastEventCursor =
    value.last_event_cursor === null ? { success: true as const, data: null } : outputCursorSchema.safeParse(value.last_event_cursor);
  if (!mappingUpdatedAt.success || !projectionUpdatedAt.success || !lastEventCursor.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected state revision values are invalid.");
  }
  return {
    mapping_updated_at: mappingUpdatedAt.data,
    projection_updated_at: projectionUpdatedAt.data,
    last_event_cursor: lastEventCursor.data
  };
}

function parseEventRow(row: EventRow): SelectedProjectedEventRecord {
  const event = parseJson(row.event_json, "invalid_event", "Stored selected event JSON is invalid.");
  const record = parseProjectedEventRecord({ event, byte_length: row.byte_length });
  if (
    record.event.session_id !== row.session_id ||
    record.event.cursor !== row.cursor ||
    record.event.type !== row.normalized_type ||
    record.event.codex_event_id !== row.codex_event_id ||
    record.event.codex_event_type !== row.codex_event_type ||
    record.event.captured_at !== row.captured_at ||
    record.event.content_state !== row.content_state
  ) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Stored selected event columns contradict event JSON.");
  }
  assertEventByteLength(record);
  return record;
}

function parseLegacyDisposition(candidate: unknown): LegacySessionDispositionRecord {
  const result = legacySessionDispositionRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_legacy_record", "Legacy session disposition is invalid.", { cause: result.error });
  }
  return result.data;
}

function parseRecovery(candidate: unknown): SelectedSessionStartRecoveryRecord {
  const result = selectedSessionStartRecoveryRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_recovery", "Session-start recovery record is invalid.", { cause: result.error });
  }
  return result.data;
}

function parseRecoveryRow(row: RecoveryRow): SelectedSessionStartRecoveryRecord {
  return parseRecovery(row);
}

function readRecovery(db: Database.Database, operationId: string): SelectedSessionStartRecoveryRecord | null {
  const row = db.prepare("SELECT * FROM selected_session_start_recovery WHERE operation_id = ?").get(operationId) as RecoveryRow | undefined;
  return row === undefined ? null : parseRecoveryRow(row);
}

function assertProjectionIdentity(mapping: SelectedSessionMappingRecord, projection: SelectedSessionProjectionRecord): void {
  const session = projection.session;
  if (
    mapping.id !== session.id ||
    mapping.name !== session.name ||
    mapping.codex_thread_id !== session.codex_thread_id ||
    mapping.cwd !== session.cwd ||
    mapping.runtime_source !== session.runtime_source ||
    mapping.runtime_version !== session.runtime_version ||
    mapping.created_at !== session.created_at ||
    mapping.archived_at !== session.archived_at
  ) {
    throw new HostDeckSelectedStateRepositoryError("identity_mismatch", "Selected mapping and projection identity do not match.");
  }
}

function assertStateChronology(mapping: SelectedSessionMappingRecord, projection: SelectedSessionProjectionRecord): void {
  const session = projection.session;
  if (mapping.updated_at < mapping.created_at || session.updated_at < session.created_at) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected session update cannot precede creation.");
  }
  if (
    mapping.archived_at !== null &&
    (mapping.archived_at < mapping.created_at || mapping.archived_at > mapping.updated_at || mapping.archived_at > session.updated_at)
  ) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected session archive time is outside its durable lifetime.");
  }
  if (
    session.last_activity_at !== null &&
    (session.last_activity_at < session.created_at || session.last_activity_at > session.updated_at)
  ) {
    throw new HostDeckSelectedStateRepositoryError("invalid_projection", "Selected session activity time is outside its projection lifetime.");
  }
}

function assertImmutableMappingIdentity(current: SelectedSessionMappingRecord, next: SelectedSessionMappingRecord): void {
  if (
    current.id !== next.id ||
    current.codex_thread_id !== next.codex_thread_id ||
    current.created_at !== next.created_at ||
    (current.archived_at !== null && current.archived_at !== next.archived_at)
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "identity_mismatch",
      "Selected session id, Codex thread id, creation time, and completed archive state are immutable."
    );
  }
}

function assertCurrentRevision(current: SelectedSessionState, expected: SelectedStateRevision): void {
  const actual = selectedStateRevision(current);
  if (
    actual.mapping_updated_at !== expected.mapping_updated_at ||
    actual.projection_updated_at !== expected.projection_updated_at ||
    actual.last_event_cursor !== expected.last_event_cursor
  ) {
    throw new HostDeckSelectedStateRepositoryError("projection_conflict", "Selected session state changed after it was read.");
  }
}

function assertSafeStateReplacement(current: SelectedSessionState, next: SelectedSessionState): void {
  if (next.mapping.updated_at <= current.mapping.updated_at || next.projection.session.updated_at <= current.projection.session.updated_at) {
    throw new HostDeckSelectedStateRepositoryError(
      "projection_conflict",
      "Selected state replacement must advance both mapping and projection revision timestamps."
    );
  }
  if (
    next.projection.session.last_event_cursor !== current.projection.session.last_event_cursor ||
    next.projection.retained_event_count !== current.projection.retained_event_count ||
    next.projection.retained_event_bytes !== current.projection.retained_event_bytes ||
    next.projection.earliest_retained_cursor !== current.projection.earliest_retained_cursor ||
    next.projection.retention_boundary_cursor !== current.projection.retention_boundary_cursor
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "projection_conflict",
      "Ordinary selected state replacement cannot rewrite committed event or retention state."
    );
  }
}

function assertEventAdvance(
  current: SelectedSessionProjectionRecord,
  event: SelectedProjectedEventRecord,
  next: SelectedSessionProjectionRecord
): void {
  if (event.event.session_id !== current.session.id || next.session.id !== current.session.id) {
    throw new HostDeckSelectedStateRepositoryError("identity_mismatch", "Selected event and projection must target one session.");
  }
  if (event.event.captured_at < current.session.created_at) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", "Selected event capture cannot precede session creation.");
  }
  const floor = Math.max(current.session.last_event_cursor ?? 0, current.retention_boundary_cursor ?? 0);
  const expectedCursor = floor + 1;
  if (event.event.cursor !== expectedCursor) {
    throw new HostDeckSelectedStateRepositoryError(
      "cursor_not_monotonic",
      `Selected event cursor ${event.event.cursor} must equal next committed cursor ${expectedCursor}.`
    );
  }
  if (next.session.last_event_cursor !== event.event.cursor) {
    throw new HostDeckSelectedStateRepositoryError("projection_conflict", "Next projection must commit the appended event cursor.");
  }
  if (next.session.updated_at < current.session.updated_at || next.session.updated_at < event.event.captured_at) {
    throw new HostDeckSelectedStateRepositoryError(
      "projection_conflict",
      "Next projection timestamp cannot precede current state or the appended event capture."
    );
  }
  if (
    next.retained_event_count !== current.retained_event_count + 1 ||
    next.retained_event_bytes !== current.retained_event_bytes + event.byte_length ||
    next.earliest_retained_cursor !== (current.earliest_retained_cursor ?? event.event.cursor)
  ) {
    throw new HostDeckSelectedStateRepositoryError("projection_conflict", "Next projection retention counters do not match one appended event.");
  }
  if (event.event.type === "replay_boundary") {
    if (
      current.retained_event_count !== 0 ||
      next.retention_boundary_cursor !== event.event.after ||
      (current.retention_boundary_cursor !== null &&
        (next.retention_boundary_cursor === null || next.retention_boundary_cursor < current.retention_boundary_cursor))
    ) {
      throw new HostDeckSelectedStateRepositoryError(
        "projection_conflict",
        "Replay-boundary projection must be the first retained event and advance to its explicit boundary cursor."
      );
    }
  } else if (next.retention_boundary_cursor !== current.retention_boundary_cursor) {
    throw new HostDeckSelectedStateRepositoryError("projection_conflict", "Only replay-boundary events may change the projection boundary cursor.");
  }
}

function assertContinuityBoundaryReplacement(
  current: SelectedSessionProjectionRecord,
  event: SelectedProjectedEventRecord,
  next: SelectedSessionProjectionRecord
): void {
  if (event.event.type !== "replay_boundary" || event.event.reason === "retention") {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_event",
      "Continuity replacement requires a disconnect, restart, or schema-change boundary."
    );
  }
  if (event.event.session_id !== current.session.id || next.session.id !== current.session.id) {
    throw new HostDeckSelectedStateRepositoryError(
      "identity_mismatch",
      "Continuity boundary and projection must target one selected session."
    );
  }
  if (event.event.captured_at < current.session.created_at) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_event",
      "Continuity boundary capture cannot precede session creation."
    );
  }
  const floor = Math.max(current.session.last_event_cursor ?? 0, current.retention_boundary_cursor ?? 0);
  const expectedCursor = floor + 1;
  const expectedAfter = floor === 0 ? null : floor;
  if (
    event.event.cursor !== expectedCursor ||
    event.event.next_cursor !== expectedCursor ||
    event.event.after !== expectedAfter
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "cursor_not_monotonic",
      "Continuity boundary must advance exactly one cursor beyond durable projection history."
    );
  }
  if (
    next.session.last_event_cursor !== expectedCursor ||
    next.session.updated_at < current.session.updated_at ||
    next.session.updated_at < event.event.captured_at
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "projection_conflict",
      "Continuity boundary projection revision does not cover the committed boundary."
    );
  }
  if (
    next.retained_event_count !== 1 ||
    next.retained_event_bytes !== event.byte_length ||
    next.earliest_retained_cursor !== expectedCursor ||
    next.retention_boundary_cursor !== expectedAfter
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "projection_conflict",
      "Continuity boundary must become the only retained projected event."
    );
  }
}

function assertInitialProjection(projection: SelectedSessionProjectionRecord): void {
  if (
    projection.session.last_event_cursor !== null ||
    projection.retained_event_count !== 0 ||
    projection.retained_event_bytes !== 0 ||
    projection.earliest_retained_cursor !== null ||
    projection.retention_boundary_cursor !== null
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "A newly created selected session must begin with an empty event projection."
    );
  }
}

function assertPersistedEventProjection(db: Database.Database, projection: SelectedSessionProjectionRecord): void {
  const aggregate = db
    .prepare(
      `
        SELECT
          COUNT(*) AS event_count,
          COALESCE(SUM(byte_length), 0) AS event_bytes,
          MIN(cursor) AS earliest_cursor,
          MAX(cursor) AS latest_cursor
        FROM selected_projected_events
        WHERE session_id = ?
      `
    )
    .get(projection.session.id) as EventAggregateRow;

  if (
    aggregate.event_count !== projection.retained_event_count ||
    aggregate.event_bytes !== projection.retained_event_bytes ||
    aggregate.earliest_cursor !== projection.earliest_retained_cursor ||
    aggregate.latest_cursor !== projection.session.last_event_cursor
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "Stored selected projection counters do not match retained event rows."
    );
  }
  if (aggregate.event_count === 0) {
    if (projection.retention_boundary_cursor !== null) {
      throw new HostDeckSelectedStateRepositoryError(
        "invalid_projection",
        "An empty retained projection cannot advertise a replay boundary."
      );
    }
    return;
  }
  if (
    aggregate.earliest_cursor === null ||
    aggregate.latest_cursor === null ||
    aggregate.latest_cursor - aggregate.earliest_cursor + 1 !== aggregate.event_count
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "Retained selected event cursors must remain contiguous after the replay boundary."
    );
  }

  const firstRow = db
    .prepare("SELECT * FROM selected_projected_events WHERE session_id = ? ORDER BY cursor ASC LIMIT 1")
    .get(projection.session.id) as EventRow;
  const firstEvent = parseEventRow(firstRow).event;
  if (firstEvent.type === "replay_boundary") {
    if (projection.retention_boundary_cursor !== firstEvent.after) {
      throw new HostDeckSelectedStateRepositoryError(
        "invalid_projection",
        "Stored replay boundary does not match projection retention metadata."
      );
    }
  } else if (projection.retention_boundary_cursor !== null || firstEvent.cursor !== 1) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "Retained history with a cursor gap must begin with an explicit replay boundary."
    );
  }
}

function assertEventByteLength(record: SelectedProjectedEventRecord): void {
  const actual = selectedProjectedEventByteLength(record.event);
  if (record.byte_length !== actual) {
    throw new HostDeckSelectedStateRepositoryError("invalid_event", `Selected event byte length ${record.byte_length} does not match ${actual}.`);
  }
}

function assertRecoveryTransition(current: SelectedSessionStartRecoveryRecord, next: SelectedSessionStartRecoveryRecord): void {
  if (
    current.operation_id !== next.operation_id ||
    current.session_id !== next.session_id ||
    current.name !== next.name ||
    current.cwd !== next.cwd ||
    current.created_at !== next.created_at ||
    (current.codex_thread_id !== null && current.codex_thread_id !== next.codex_thread_id)
  ) {
    throw new HostDeckSelectedStateRepositoryError("recovery_conflict", "Session-start recovery identity is immutable.");
  }
  if (next.updated_at < current.updated_at) {
    throw new HostDeckSelectedStateRepositoryError("recovery_conflict", "Session-start recovery timestamp cannot move backward.");
  }
  const allowed: Readonly<Record<SelectedSessionStartRecoveryRecord["state"], readonly SelectedSessionStartRecoveryRecord["state"][]>> = {
    reserved: ["reserved", "thread_created", "failed"],
    thread_created: ["thread_created", "persisted", "failed"],
    persisted: ["persisted"],
    failed: ["failed"]
  };
  if (!allowed[current.state].includes(next.state)) {
    throw new HostDeckSelectedStateRepositoryError(
      "recovery_conflict",
      `Session-start recovery cannot transition from ${current.state} to ${next.state}.`
    );
  }
  if (["persisted", "failed"].includes(current.state) && !isDeepStrictEqual(current, next)) {
    throw new HostDeckSelectedStateRepositoryError(
      "recovery_conflict",
      "Terminal session-start recovery records are immutable."
    );
  }
}

function assertRecoveryReservationAvailable(db: Database.Database, record: SelectedSessionStartRecoveryRecord): void {
  const selected = db
    .prepare("SELECT id FROM selected_sessions WHERE id = ? OR name = ? LIMIT 1")
    .get(record.session_id, record.name) as { readonly id: string } | undefined;
  if (selected !== undefined) {
    throw new HostDeckSelectedStateRepositoryError(
      "recovery_conflict",
      "Session-start recovery id or alias is already owned by a selected session."
    );
  }
}

function assertRecoveryThreadAvailable(db: Database.Database, record: SelectedSessionStartRecoveryRecord): void {
  if (record.codex_thread_id === null) return;
  const selected = db
    .prepare("SELECT id FROM selected_sessions WHERE codex_thread_id = ? LIMIT 1")
    .get(record.codex_thread_id) as { readonly id: string } | undefined;
  if (selected !== undefined && selected.id !== record.session_id) {
    throw new HostDeckSelectedStateRepositoryError(
      "recovery_conflict",
      "Session-start recovery Codex thread is already owned by another selected session."
    );
  }
}

function assertPersistedRecoveryMatchesSelectedState(db: Database.Database, record: SelectedSessionStartRecoveryRecord): void {
  const selected = readState(db, record.session_id);
  if (
    selected === null ||
    selected.mapping.name !== record.name ||
    selected.mapping.cwd !== record.cwd ||
    selected.mapping.codex_thread_id !== record.codex_thread_id
  ) {
    throw new HostDeckSelectedStateRepositoryError(
      "recovery_conflict",
      "Persisted session-start recovery must match a durable selected mapping and projection."
    );
  }
}

function assertSelectedCreateRecoveryCompatibility(db: Database.Database, mapping: SelectedSessionMappingRecord): void {
  const rows = db
    .prepare(
      `
        SELECT * FROM selected_session_start_recovery
        WHERE session_id = ? OR name = ? OR codex_thread_id = ?
      `
    )
    .all(mapping.id, mapping.name, mapping.codex_thread_id) as RecoveryRow[];

  for (const row of rows) {
    const recovery = parseRecoveryRow(row);
    const matchesPendingThread =
      recovery.session_id === mapping.id &&
      recovery.name === mapping.name &&
      recovery.cwd === mapping.cwd &&
      recovery.codex_thread_id === mapping.codex_thread_id &&
      recovery.state !== "reserved";
    if (!matchesPendingThread) {
      throw new HostDeckSelectedStateRepositoryError(
        "recovery_conflict",
        "Selected session identity conflicts with an unresolved session-start recovery."
      );
    }
  }
}

function insertMapping(db: Database.Database, mapping: SelectedSessionMappingRecord): void {
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (
        @id, @name, @codex_thread_id, @cwd, @runtime_source, @runtime_version,
        @disposition, @created_at, @updated_at, @archived_at
      )
    `
  ).run(mappingToRow(mapping));
}

function insertProjection(db: Database.Database, projection: SelectedSessionProjectionRecord): void {
  db.prepare(
    `
      INSERT INTO selected_session_projections (
        session_id, session_state, turn_state, attention, freshness, freshness_reason,
        updated_at, last_activity_at, branch, model, settings_json, goal_json, recent_summary,
        last_event_cursor, retained_event_count, retained_event_bytes,
        earliest_retained_cursor, retention_boundary_cursor
      ) VALUES (
        @session_id, @session_state, @turn_state, @attention, @freshness, @freshness_reason,
        @updated_at, @last_activity_at, @branch, @model, @settings_json, @goal_json, @recent_summary,
        @last_event_cursor, @retained_event_count, @retained_event_bytes,
        @earliest_retained_cursor, @retention_boundary_cursor
      )
    `
  ).run(projectionToRow(projection));
}

function updateProjection(db: Database.Database, projection: SelectedSessionProjectionRecord): number {
  return db
    .prepare(
      `
        UPDATE selected_session_projections SET
          session_state = @session_state,
          turn_state = @turn_state,
          attention = @attention,
          freshness = @freshness,
          freshness_reason = @freshness_reason,
          updated_at = @updated_at,
          last_activity_at = @last_activity_at,
          branch = @branch,
          model = @model,
          settings_json = @settings_json,
          goal_json = @goal_json,
          recent_summary = @recent_summary,
          last_event_cursor = @last_event_cursor,
          retained_event_count = @retained_event_count,
          retained_event_bytes = @retained_event_bytes,
          earliest_retained_cursor = @earliest_retained_cursor,
          retention_boundary_cursor = @retention_boundary_cursor
        WHERE session_id = @session_id
      `
    )
    .run(projectionToRow(projection)).changes;
}

function insertEvent(db: Database.Database, record: SelectedProjectedEventRecord): void {
  db.prepare(
    `
      INSERT INTO selected_projected_events (
        session_id, cursor, normalized_type, codex_event_id, codex_event_type,
        captured_at, content_state, byte_length, event_json
      ) VALUES (
        @session_id, @cursor, @normalized_type, @codex_event_id, @codex_event_type,
        @captured_at, @content_state, @byte_length, @event_json
      )
    `
  ).run(eventToRow(record));
}

function insertRecovery(db: Database.Database, recovery: SelectedSessionStartRecoveryRecord): void {
  db.prepare(
    `
      INSERT INTO selected_session_start_recovery (
        operation_id, session_id, name, cwd, codex_thread_id, state,
        created_at, updated_at, error_code, error_message
      ) VALUES (
        @operation_id, @session_id, @name, @cwd, @codex_thread_id, @state,
        @created_at, @updated_at, @error_code, @error_message
      )
    `
  ).run(recoveryToRow(recovery));
}

function mappingToRow(mapping: SelectedSessionMappingRecord): MappingRow {
  return mapping;
}

function projectionToRow(projection: SelectedSessionProjectionRecord): ProjectionRow {
  return {
    session_id: projection.session.id,
    session_state: projection.session.session_state,
    turn_state: projection.session.turn_state,
    attention: projection.session.attention,
    freshness: projection.session.freshness,
    freshness_reason: projection.session.freshness_reason,
    updated_at: projection.session.updated_at,
    last_activity_at: projection.session.last_activity_at,
    branch: projection.session.branch,
    model: projection.session.model,
    settings_json: projection.session.settings === null ? null : JSON.stringify(projection.session.settings),
    goal_json: projection.session.goal === null ? null : JSON.stringify(projection.session.goal),
    recent_summary: projection.session.recent_summary,
    last_event_cursor: projection.session.last_event_cursor,
    retained_event_count: projection.retained_event_count,
    retained_event_bytes: projection.retained_event_bytes,
    earliest_retained_cursor: projection.earliest_retained_cursor,
    retention_boundary_cursor: projection.retention_boundary_cursor
  };
}

function eventToRow(record: SelectedProjectedEventRecord): EventRow {
  return {
    session_id: record.event.session_id,
    cursor: record.event.cursor,
    normalized_type: record.event.type,
    codex_event_id: record.event.codex_event_id,
    codex_event_type: record.event.codex_event_type,
    captured_at: record.event.captured_at,
    content_state: record.event.content_state,
    byte_length: record.byte_length,
    event_json: JSON.stringify(record.event)
  };
}

function recoveryToRow(recovery: SelectedSessionStartRecoveryRecord): RecoveryRow {
  return recovery;
}

function parseSessionId(sessionId: string): string {
  const result = sessionIdSchema.safeParse(sessionId);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("session_not_found", `Selected session id ${sessionId} is invalid.`, { cause: result.error });
  }
  return result.data;
}

function parseThreadId(threadId: string): string {
  const result = codexThreadIdSchema.safeParse(threadId);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("session_not_found", "Codex thread id is invalid.", { cause: result.error });
  }
  return result.data;
}

function parseOperationId(operationId: string): string {
  const result = clientOperationIdSchema.safeParse(operationId);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_recovery", "Client operation id is invalid.", { cause: result.error });
  }
  return result.data;
}

function parseEventAfter(after: number | null): number | null {
  if (after === null) return null;
  const result = outputCursorSchema.safeParse(after);
  if (!result.success) {
    throw new HostDeckSelectedStateRepositoryError("invalid_replay", "Selected event replay cursor is invalid.", { cause: result.error });
  }
  return result.data;
}

function parseEventLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxEventLimit) {
    throw new HostDeckSelectedStateRepositoryError("invalid_replay", `Selected event replay limit must be between 1 and ${maxEventLimit}.`);
  }
  return limit;
}

function parseJson(value: string, code: SelectedStateRepositoryErrorCode, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new HostDeckSelectedStateRepositoryError(code, message, { cause: error });
  }
}

function parseNullableJson(value: string | null, code: SelectedStateRepositoryErrorCode, message: string): unknown {
  return value === null ? null : parseJson(value, code, message);
}

function mapStateConstraint(error: unknown): HostDeckSelectedStateRepositoryError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("selected_sessions.name")) {
    return new HostDeckSelectedStateRepositoryError("duplicate_session_name", "Selected session name already exists.", { cause: error });
  }
  if (message.includes("selected_sessions.codex_thread_id")) {
    return new HostDeckSelectedStateRepositoryError("duplicate_thread_id", "Codex thread id is already managed.", { cause: error });
  }
  if (message.includes("selected_sessions.id")) {
    return new HostDeckSelectedStateRepositoryError("session_exists", "Selected session id already exists.", { cause: error });
  }
  return new HostDeckSelectedStateRepositoryError("invalid_mapping", "Selected session state violates SQLite constraints.", { cause: error });
}

function mapEventConstraint(error: unknown): HostDeckSelectedStateRepositoryError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("selected_projected_events.session_id, selected_projected_events.cursor")) {
    return new HostDeckSelectedStateRepositoryError("event_exists", "Selected projected event cursor already exists.", { cause: error });
  }
  if (message.includes("selected_projected_events.session_id, selected_projected_events.codex_event_id")) {
    return new HostDeckSelectedStateRepositoryError("event_exists", "Selected Codex event id already exists.", { cause: error });
  }
  return new HostDeckSelectedStateRepositoryError(
    "projection_write_failed",
    "Selected projected event transaction failed and was rolled back.",
    { cause: error }
  );
}

function mapRecoveryConstraint(error: unknown): HostDeckSelectedStateRepositoryError {
  return new HostDeckSelectedStateRepositoryError("recovery_conflict", "Session-start recovery record conflicts with durable state.", {
    cause: error
  });
}
