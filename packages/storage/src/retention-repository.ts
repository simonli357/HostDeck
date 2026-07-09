import { Buffer } from "node:buffer";
import {
  isoTimestampSchema,
  type OutputEventRecord,
  outputCursorSchema,
  outputEventRecordSchema,
  type RetentionBoundaryRecord,
  type RetentionPolicy,
  retentionBoundaryRecordSchema,
  retentionPolicySchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type RetentionRepositoryErrorCode =
  | "invalid_audit_event"
  | "invalid_output_event"
  | "invalid_replay_request"
  | "invalid_retention_boundary"
  | "invalid_retention_policy"
  | "output_cursor_not_monotonic"
  | "output_event_exists"
  | "session_not_found";

export class HostDeckRetentionRepositoryError extends Error {
  constructor(
    readonly code: RetentionRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckRetentionRepositoryError";
  }
}

export interface AppendOutputEventInput {
  readonly now?: () => Date;
  readonly retention?: RetentionPolicy;
}

export interface AppendOutputEventResult {
  readonly event: OutputEventRecord;
  readonly boundary: RetentionBoundaryRecord | null;
}

export interface CleanupRetentionInput {
  readonly now?: () => Date;
  readonly retention: RetentionPolicy;
}

export interface ListOutputReplayInput {
  readonly after?: number | null;
  readonly limit?: number;
}

export interface OutputReplayResult {
  readonly session_id: string;
  readonly after: number | null;
  readonly events: readonly OutputEventRecord[];
  readonly boundary: RetentionBoundaryRecord | null;
  readonly next_cursor: number;
  readonly truncated: boolean;
}

export interface GetLatestBoundaryInput {
  readonly scope: "audit" | "output";
  readonly sessionId?: string | null;
}

export interface RetentionRepository {
  readonly appendOutputEvent: (event: unknown, input?: AppendOutputEventInput) => AppendOutputEventResult;
  readonly cleanupAuditEvents: (input: CleanupRetentionInput) => RetentionBoundaryRecord | null;
  readonly cleanupOutputSession: (sessionId: string, input: CleanupRetentionInput) => RetentionBoundaryRecord | null;
  readonly getLatestBoundary: (input: GetLatestBoundaryInput) => RetentionBoundaryRecord | null;
  readonly listOutputReplay: (sessionId: string, input?: ListOutputReplayInput) => OutputReplayResult;
}

interface OutputEventRow {
  readonly session_id: string;
  readonly cursor: number;
  readonly event_order: number;
  readonly captured_at: string | null;
  readonly kind: OutputEventRecord["kind"];
  readonly payload: string | null;
  readonly truncated_before: number | null;
}

interface RetentionBoundaryRow {
  readonly id: string;
  readonly scope: RetentionBoundaryRecord["scope"];
  readonly session_id: string | null;
  readonly reason: RetentionBoundaryRecord["reason"];
  readonly truncated_before_cursor: number | null;
  readonly truncated_before_at: string | null;
  readonly retained_record_count: number;
  readonly applied_at: string;
}

interface AuditRetentionRow {
  readonly id: string;
  readonly at: string;
}

const defaultReplayLimit = 100;
const maxReplayLimit = 1_000;
const millisPerDay = 24 * 60 * 60 * 1_000;

export function createRetentionRepository(db: Database.Database): RetentionRepository {
  const appendOutputTransaction = db.transaction(
    (event: OutputEventRecord, policy: RetentionPolicy | null, appliedAt: string): AppendOutputEventResult => {
      assertOutputCursorCanAppend(db, event);

      try {
        db.prepare(`
          INSERT INTO output_events (
            session_id,
            cursor,
            event_order,
            captured_at,
            kind,
            payload,
            truncated_before
          ) VALUES (
            @session_id,
            @cursor,
            @event_order,
            @captured_at,
            @kind,
            @payload,
            @truncated_before
          )
        `).run(outputEventToRow(event));
      } catch (error) {
        throw mapOutputConstraint(error);
      }

      return {
        event,
        boundary: policy === null ? null : cleanupOutputSessionInTransaction(db, event.session_id, policy, appliedAt)
      };
    }
  );

  const cleanupOutputTransaction = db.transaction((sessionId: string, policy: RetentionPolicy, appliedAt: string): RetentionBoundaryRecord | null => {
    requireSession(db, sessionId);
    return cleanupOutputSessionInTransaction(db, sessionId, policy, appliedAt);
  });

  const cleanupAuditTransaction = db.transaction((policy: RetentionPolicy, appliedAt: string): RetentionBoundaryRecord | null =>
    cleanupAuditEventsInTransaction(db, policy, appliedAt)
  );

  return {
    appendOutputEvent(event, input = {}) {
      const parsed = parseOutputEvent(event);
      const policy = input.retention === undefined ? null : parseRetentionPolicy(input.retention);
      return appendOutputTransaction(parsed, policy, nowIso(input.now));
    },
    cleanupAuditEvents(input) {
      return cleanupAuditTransaction(parseRetentionPolicy(input.retention), nowIso(input.now));
    },
    cleanupOutputSession(sessionId, input) {
      return cleanupOutputTransaction(parseSessionId(sessionId), parseRetentionPolicy(input.retention), nowIso(input.now));
    },
    getLatestBoundary(input) {
      return getLatestBoundary(db, input);
    },
    listOutputReplay(sessionId, input = {}) {
      const parsedSessionId = parseSessionId(sessionId);
      const after = parseReplayAfter(input.after ?? null);
      const limit = parseReplayLimit(input.limit ?? defaultReplayLimit);
      requireSession(db, parsedSessionId);

      const boundary = getLatestBoundary(db, {
        scope: "output",
        sessionId: parsedSessionId
      });
      const crossedBoundary =
        boundary !== null &&
        boundary.truncated_before_cursor !== null &&
        (after === null || after <= boundary.truncated_before_cursor);
      const rows =
        after === null
          ? (db.prepare("SELECT * FROM output_events WHERE session_id = ? ORDER BY cursor ASC LIMIT ?").all(parsedSessionId, limit) as OutputEventRow[])
          : (db
              .prepare("SELECT * FROM output_events WHERE session_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?")
              .all(parsedSessionId, after, limit) as OutputEventRow[]);
      const events = rows.map(parseOutputEventRow);

      return {
        session_id: parsedSessionId,
        after,
        events,
        boundary: crossedBoundary ? boundary : null,
        next_cursor: nextReplayCursor(after, events, crossedBoundary ? boundary : null),
        truncated: crossedBoundary
      };
    }
  };
}

function cleanupOutputSessionInTransaction(
  db: Database.Database,
  sessionId: string,
  policy: RetentionPolicy,
  appliedAt: string
): RetentionBoundaryRecord | null {
  const rows = db.prepare("SELECT * FROM output_events WHERE session_id = ? ORDER BY cursor DESC").all(sessionId) as OutputEventRow[];
  const totalBytes = rows.reduce((sum, row) => sum + outputRowByteLength(row), 0);

  if (rows.length <= policy.output_event_limit && totalBytes <= policy.output_byte_limit) {
    return null;
  }

  const retainedRows: OutputEventRow[] = [];
  let retainedBytes = 0;

  for (const row of rows) {
    const rowBytes = outputRowByteLength(row);

    if (retainedRows.length + 1 > policy.output_event_limit || retainedBytes + rowBytes > policy.output_byte_limit) {
      break;
    }

    retainedRows.push(row);
    retainedBytes += rowBytes;
  }

  const removedRows = rows.slice(retainedRows.length);
  const highestRemoved = removedRows[0];

  if (highestRemoved === undefined) {
    return null;
  }

  db.prepare("DELETE FROM output_events WHERE session_id = ? AND cursor <= ?").run(sessionId, highestRemoved.cursor);

  return insertRetentionBoundary(
    db,
    {
      id: outputBoundaryId(sessionId, highestRemoved.cursor),
      scope: "output",
      session_id: sessionId,
      reason: outputCleanupReason(rows, policy),
      truncated_before_cursor: highestRemoved.cursor,
      truncated_before_at: highestRemoved.captured_at,
      retained_record_count: retainedRows.length,
      applied_at: appliedAt
    },
    "invalid_retention_boundary"
  );
}

function cleanupAuditEventsInTransaction(db: Database.Database, policy: RetentionPolicy, appliedAt: string): RetentionBoundaryRecord | null {
  const rows = db.prepare("SELECT id, at FROM audit_events ORDER BY at DESC, id DESC").all() as AuditRetentionRow[];

  for (const row of rows) {
    parseIsoTimestamp(row.at, "invalid_audit_event");
  }

  const eventRemovedIds = new Set(rows.slice(policy.audit_event_limit).map((row) => row.id));
  const cutoff = new Date(Date.parse(appliedAt) - policy.audit_retention_days * millisPerDay).toISOString();
  const ageRemovedIds = new Set(rows.filter((row) => row.at < cutoff).map((row) => row.id));
  const removedIds = new Set([...eventRemovedIds, ...ageRemovedIds]);

  if (removedIds.size === 0) {
    return null;
  }

  const removedRows = rows.filter((row) => removedIds.has(row.id));
  const highestRemoved = removedRows[0];

  if (highestRemoved === undefined) {
    return null;
  }

  deleteAuditRows(db, removedIds);

  const reason = auditCleanupReason(rows, policy, cutoff);

  return insertRetentionBoundary(
    db,
    {
      id: auditBoundaryId(reason, highestRemoved.at, removedIds.size),
      scope: "audit",
      session_id: null,
      reason,
      truncated_before_cursor: null,
      truncated_before_at: reason === "age_limit" ? cutoff : null,
      retained_record_count: rows.length - removedIds.size,
      applied_at: appliedAt
    },
    "invalid_retention_boundary"
  );
}

function deleteAuditRows(db: Database.Database, removedIds: ReadonlySet<string>): void {
  const ids = [...removedIds];

  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    db.prepare(`DELETE FROM audit_events WHERE id IN (${placeholders})`).run(...chunk);
  }
}

function getLatestBoundary(db: Database.Database, input: GetLatestBoundaryInput): RetentionBoundaryRecord | null {
  const sessionId = input.sessionId ?? null;

  if (input.scope === "output" && sessionId === null) {
    throw new HostDeckRetentionRepositoryError("invalid_retention_boundary", "Output boundary lookup requires a session id.");
  }

  if (input.scope === "audit" && sessionId !== null) {
    throw new HostDeckRetentionRepositoryError("invalid_retention_boundary", "Audit boundary lookup must be global.");
  }

  const parsedSessionId = sessionId === null ? null : parseSessionId(sessionId);
  const row =
    input.scope === "output"
      ? (db
          .prepare(
            "SELECT * FROM retention_boundaries WHERE scope = ? AND session_id IS ? ORDER BY truncated_before_cursor DESC, applied_at DESC, id DESC LIMIT 1"
          )
          .get(input.scope, parsedSessionId) as RetentionBoundaryRow | undefined)
      : (db
          .prepare("SELECT * FROM retention_boundaries WHERE scope = ? AND session_id IS ? ORDER BY applied_at DESC, id DESC LIMIT 1")
          .get(input.scope, parsedSessionId) as RetentionBoundaryRow | undefined);

  return row === undefined ? null : parseRetentionBoundaryRow(row);
}

function assertOutputCursorCanAppend(db: Database.Database, event: OutputEventRecord): void {
  const latestRow = db.prepare("SELECT MAX(cursor) AS cursor FROM output_events WHERE session_id = ?").get(event.session_id) as
    | { readonly cursor: number | null }
    | undefined;
  const latestBoundary = getLatestBoundary(db, {
    scope: "output",
    sessionId: event.session_id
  });
  const latestCursor = latestRow?.cursor ?? null;
  const latestPrunedCursor = latestBoundary?.truncated_before_cursor ?? null;
  const cursorFloor = Math.max(latestCursor ?? -1, latestPrunedCursor ?? -1);

  if (event.cursor <= cursorFloor) {
    throw new HostDeckRetentionRepositoryError(
      "output_cursor_not_monotonic",
      `Output cursor ${event.cursor} must be greater than latest cursor ${cursorFloor}.`
    );
  }
}

function requireSession(db: Database.Database, sessionId: string): void {
  const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as { readonly id: string } | undefined;

  if (row === undefined) {
    throw new HostDeckRetentionRepositoryError("session_not_found", `Session ${sessionId} does not exist.`);
  }
}

function parseOutputEventRow(row: OutputEventRow): OutputEventRecord {
  return parseOutputEvent({
    session_id: row.session_id,
    cursor: row.cursor,
    order: row.event_order,
    captured_at: row.captured_at,
    kind: row.kind,
    payload: row.payload,
    truncated_before: row.truncated_before
  });
}

function parseRetentionBoundaryRow(row: RetentionBoundaryRow): RetentionBoundaryRecord {
  return parseRetentionBoundary(row);
}

function parseOutputEvent(candidate: unknown): OutputEventRecord {
  const result = outputEventRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckRetentionRepositoryError("invalid_output_event", "Output event record is invalid.", { cause: result.error });
  }

  return result.data;
}

function parseRetentionBoundary(candidate: unknown): RetentionBoundaryRecord {
  const result = retentionBoundaryRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckRetentionRepositoryError("invalid_retention_boundary", "Retention boundary record is invalid.", { cause: result.error });
  }

  return result.data;
}

function parseRetentionPolicy(candidate: unknown): RetentionPolicy {
  const result = retentionPolicySchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckRetentionRepositoryError("invalid_retention_policy", "Retention policy is invalid.", { cause: result.error });
  }

  return result.data;
}

function parseSessionId(sessionId: string): string {
  const result = sessionIdSchema.safeParse(sessionId);

  if (!result.success) {
    throw new HostDeckRetentionRepositoryError("session_not_found", `Session id ${sessionId} is invalid.`, { cause: result.error });
  }

  return result.data;
}

function parseReplayAfter(after: number | null): number | null {
  if (after === null) {
    return null;
  }

  const result = outputCursorSchema.safeParse(after);

  if (!result.success) {
    throw new HostDeckRetentionRepositoryError("invalid_replay_request", "Replay cursor is invalid.", { cause: result.error });
  }

  return result.data;
}

function parseReplayLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxReplayLimit) {
    throw new HostDeckRetentionRepositoryError("invalid_replay_request", `Replay limit must be between 1 and ${maxReplayLimit}.`);
  }

  return limit;
}

function parseIsoTimestamp(value: string, code: RetentionRepositoryErrorCode): string {
  const result = isoTimestampSchema.safeParse(value);

  if (!result.success) {
    throw new HostDeckRetentionRepositoryError(code, "Stored timestamp is invalid.", { cause: result.error });
  }

  return result.data;
}

function outputEventToRow(event: OutputEventRecord): OutputEventRow {
  return {
    session_id: event.session_id,
    cursor: event.cursor,
    event_order: event.order,
    captured_at: event.captured_at,
    kind: event.kind,
    payload: event.payload,
    truncated_before: event.truncated_before
  };
}

function retentionBoundaryToRow(boundary: RetentionBoundaryRecord): RetentionBoundaryRow {
  return {
    id: boundary.id,
    scope: boundary.scope,
    session_id: boundary.session_id,
    reason: boundary.reason,
    truncated_before_cursor: boundary.truncated_before_cursor,
    truncated_before_at: boundary.truncated_before_at,
    retained_record_count: boundary.retained_record_count,
    applied_at: boundary.applied_at
  };
}

function insertRetentionBoundary(
  db: Database.Database,
  boundary: unknown,
  fallbackCode: RetentionRepositoryErrorCode
): RetentionBoundaryRecord {
  const parsed = parseRetentionBoundary(boundary);

  try {
    db.prepare(`
      INSERT INTO retention_boundaries (
        id,
        scope,
        session_id,
        reason,
        truncated_before_cursor,
        truncated_before_at,
        retained_record_count,
        applied_at
      ) VALUES (
        @id,
        @scope,
        @session_id,
        @reason,
        @truncated_before_cursor,
        @truncated_before_at,
        @retained_record_count,
        @applied_at
      )
    `).run(retentionBoundaryToRow(parsed));
  } catch (error) {
    throw new HostDeckRetentionRepositoryError(fallbackCode, "Retention boundary violates SQLite constraints.", { cause: error });
  }

  return parsed;
}

function outputRowByteLength(row: OutputEventRow): number {
  return Buffer.byteLength(row.payload ?? "", "utf8");
}

function outputCleanupReason(rows: readonly OutputEventRow[], policy: RetentionPolicy): RetentionBoundaryRecord["reason"] {
  const eventCutoff = rows.length > policy.output_event_limit ? rows[policy.output_event_limit]?.cursor ?? null : null;
  const byteCutoff = outputByteCutoff(rows, policy.output_byte_limit);

  if (byteCutoff !== null && (eventCutoff === null || byteCutoff > eventCutoff)) {
    return "byte_limit";
  }

  return "event_limit";
}

function outputByteCutoff(rows: readonly OutputEventRow[], byteLimit: number): number | null {
  let bytes = 0;

  for (const row of rows) {
    const nextBytes = bytes + outputRowByteLength(row);

    if (nextBytes > byteLimit) {
      return row.cursor;
    }

    bytes = nextBytes;
  }

  return null;
}

function auditCleanupReason(rows: readonly AuditRetentionRow[], policy: RetentionPolicy, cutoff: string): RetentionBoundaryRecord["reason"] {
  const eventCutoff = rows.length > policy.audit_event_limit ? rows[policy.audit_event_limit] ?? null : null;
  const ageCutoff = rows.find((row) => row.at < cutoff) ?? null;

  if (ageCutoff !== null && (eventCutoff === null || ageCutoff.at > eventCutoff.at)) {
    return "age_limit";
  }

  return "event_limit";
}

function outputBoundaryId(sessionId: string, highestRemovedCursor: number): string {
  return `retention_output_${sessionId}_${highestRemovedCursor}`;
}

function auditBoundaryId(reason: RetentionBoundaryRecord["reason"], highestRemovedAt: string, removedCount: number): string {
  return `retention_audit_${reason}_${compactIdentifierPart(highestRemovedAt)}_${removedCount}`;
}

function compactIdentifierPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "");
}

function nextReplayCursor(after: number | null, events: readonly OutputEventRecord[], boundary: RetentionBoundaryRecord | null): number {
  const lastEvent = events.at(-1);

  if (lastEvent !== undefined) {
    return lastEvent.cursor + 1;
  }

  if (boundary?.truncated_before_cursor !== null && boundary?.truncated_before_cursor !== undefined) {
    return boundary.truncated_before_cursor + 1;
  }

  return after === null ? 0 : after + 1;
}

function mapOutputConstraint(error: unknown): HostDeckRetentionRepositoryError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("FOREIGN KEY")) {
    return new HostDeckRetentionRepositoryError("session_not_found", "Output event references a missing session.", { cause: error });
  }

  if (message.includes("output_events.session_id") && message.includes("output_events.cursor")) {
    return new HostDeckRetentionRepositoryError("output_event_exists", "Output event cursor already exists for this session.", { cause: error });
  }

  return new HostDeckRetentionRepositoryError("invalid_output_event", "Output event violates SQLite constraints.", { cause: error });
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}
