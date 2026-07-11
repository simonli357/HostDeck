import { Buffer } from "node:buffer";
import {
  clientOperationIdSchema,
  isoTimestampSchema,
  type RetentionPolicy,
  retentionPolicySchema,
  type SelectedAuditEventRecord,
  type SelectedAuditTrail,
  selectedAuditEventRecordSchema,
  selectedAuditTrailSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type SelectedAuditRepositoryErrorCode =
  | "audit_operation_conflict"
  | "audit_operation_exists"
  | "audit_operation_not_found"
  | "audit_operation_terminal"
  | "audit_record_exists"
  | "audit_unavailable"
  | "audit_write_failed"
  | "invalid_audit_operation_id"
  | "invalid_audit_record"
  | "invalid_audit_trail";

export class HostDeckSelectedAuditRepositoryError extends Error {
  constructor(
    readonly code: SelectedAuditRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckSelectedAuditRepositoryError";
  }
}

export interface SelectedAuditRepository {
  readonly get: (operationId: string) => SelectedAuditTrail | null;
  readonly require: (operationId: string) => SelectedAuditTrail;
  readonly recordAccepted: (record: unknown) => SelectedAuditTrail;
  readonly recordRejected: (record: unknown) => SelectedAuditTrail;
  readonly recordTerminal: (record: unknown) => SelectedAuditTrail;
}

export interface SelectedAuditRetentionBatchInput {
  readonly max_deleted_records: number;
  readonly now: string;
  readonly retention: RetentionPolicy;
}

export interface SelectedAuditRetentionBatchResult {
  readonly deleted_operation_count: number;
  readonly deleted_record_count: number;
  readonly newest_trail_oversize: boolean;
  readonly pending_blocks_policy: boolean;
  readonly protected_pending_operation_count: number;
  readonly remaining: boolean;
  readonly retained_record_count: number;
}

interface SelectedAuditRow {
  readonly id: string;
  readonly operation_id: string;
  readonly at: string;
  readonly action: SelectedAuditEventRecord["action"];
  readonly phase: SelectedAuditEventRecord["phase"];
  readonly outcome: SelectedAuditEventRecord["outcome"];
  readonly error_code: SelectedAuditEventRecord["error_code"];
  readonly record_json: string;
}

const maxRecordBytes = 65_536;

export function createSelectedAuditRepository(db: Database.Database): SelectedAuditRepository {
  const recordStartTransaction = db.transaction((record: SelectedAuditEventRecord): SelectedAuditTrail => {
    if (readTrail(db, record.operation_id) !== null) {
      throw new HostDeckSelectedAuditRepositoryError(
        "audit_operation_exists",
        `Audit operation ${record.operation_id} already has a durable trail.`
      );
    }

    insertRecord(db, record);
    return parseTrail(record.operation_id, [record], "invalid_audit_record");
  }).immediate;

  const recordTerminalTransaction = db.transaction((record: SelectedAuditEventRecord): SelectedAuditTrail => {
    const current = readTrail(db, record.operation_id);
    if (current === null) {
      throw new HostDeckSelectedAuditRepositoryError(
        "audit_operation_not_found",
        `Audit operation ${record.operation_id} has no accepted record.`
      );
    }
    if (current.state === "terminal") {
      throw new HostDeckSelectedAuditRepositoryError(
        "audit_operation_terminal",
        `Audit operation ${record.operation_id} is already terminal.`
      );
    }

    const next = parseTrail(record.operation_id, [...current.records, record], "audit_operation_conflict");
    insertRecord(db, record);
    return next;
  }).immediate;

  return {
    get(operationId) {
      return readTrail(db, parseOperationId(operationId));
    },
    require(operationId) {
      const parsedOperationId = parseOperationId(operationId);
      const trail = readTrail(db, parsedOperationId);
      if (trail === null) {
        throw new HostDeckSelectedAuditRepositoryError(
          "audit_operation_not_found",
          `Audit operation ${parsedOperationId} does not exist.`
        );
      }
      return trail;
    },
    recordAccepted(record) {
      const parsed = parseRecord(record);
      if (parsed.phase !== "accepted" || parsed.outcome !== "accepted") {
        throw invalidRecord("recordAccepted requires one accepted-phase record.");
      }
      return runWrite(() => recordStartTransaction(parsed));
    },
    recordRejected(record) {
      const parsed = parseRecord(record);
      if (parsed.phase !== "terminal" || parsed.outcome !== "rejected") {
        throw invalidRecord("recordRejected requires one pre-dispatch rejected record.");
      }
      return runWrite(() => recordStartTransaction(parsed));
    },
    recordTerminal(record) {
      const parsed = parseRecord(record);
      if (parsed.phase !== "terminal" || !["succeeded", "failed", "incomplete"].includes(parsed.outcome)) {
        throw invalidRecord("recordTerminal requires a succeeded, failed, or incomplete terminal record.");
      }
      return runWrite(() => recordTerminalTransaction(parsed));
    }
  };
}

export function maintainSelectedAuditRetentionBatch(
  db: Database.Database,
  input: SelectedAuditRetentionBatchInput
): SelectedAuditRetentionBatchResult {
  const policy = parseAuditRetentionPolicy(input?.retention);
  const now = parseAuditRetentionNow(input?.now);
  const cutoff = parseAuditRetentionCutoff(now, policy.audit_retention_days);
  const maxDeletedRecords = parseAuditRetentionBatchSize(input?.max_deleted_records);
  const transaction = db.transaction((): SelectedAuditRetentionBatchResult => {
    const current = readAuditRetentionState(db, policy, cutoff, maxDeletedRecords + 1);
    const selected: SelectedAuditTrail[] = [];
    let selectedRecords = 0;
    let projectedRecords = current.retained_record_count;
    for (const summary of current.candidates) {
      const trail = requireRetentionTrail(db, summary);
      const ageDue = Date.parse(summary.latest_at) < current.cutoff_time;
      if (!ageDue && projectedRecords <= policy.audit_event_limit) break;
      if (selectedRecords + trail.records.length > maxDeletedRecords) break;
      selected.push(trail);
      selectedRecords += trail.records.length;
      projectedRecords -= trail.records.length;
    }

    let deletedRecords = 0;
    for (const trail of selected) {
      const deletion = db.prepare("DELETE FROM selected_audit_events WHERE operation_id = ?").run(trail.operation_id);
      if (deletion.changes !== trail.records.length) {
        throw new HostDeckSelectedAuditRepositoryError(
          "audit_write_failed",
          "Selected audit retention deleted an incomplete operation trail."
        );
      }
      deletedRecords += deletion.changes;
    }
    const final = readAuditRetentionState(db, policy, cutoff, 1);
    return Object.freeze({
      deleted_operation_count: selected.length,
      deleted_record_count: deletedRecords,
      newest_trail_oversize: final.newest_trail_oversize,
      pending_blocks_policy: final.pending_blocks_policy,
      protected_pending_operation_count: final.protected_pending_operation_count,
      remaining: final.candidates.length > 0,
      retained_record_count: final.retained_record_count
    });
  }).immediate;

  try {
    return transaction();
  } catch (error) {
    if (error instanceof HostDeckSelectedAuditRepositoryError) throw error;
    throw mapWriteFailure(error);
  }
}

interface AuditOperationSummary {
  readonly latest_at: string;
  readonly operation_id: string;
  readonly record_count: number;
}

interface AuditRetentionState {
  readonly candidates: readonly AuditOperationSummary[];
  readonly cutoff_time: number;
  readonly newest_trail_oversize: boolean;
  readonly pending_blocks_policy: boolean;
  readonly protected_pending_operation_count: number;
  readonly retained_record_count: number;
}

interface AuditRetentionCutoff {
  readonly at: string;
  readonly time: number;
}

interface AuditRetentionMetricsRow {
  readonly pending_age_due_count: number;
  readonly protected_pending_operation_count: number;
  readonly retained_record_count: number;
}

interface AuditRetentionNewestRow {
  readonly has_terminal: number;
  readonly latest_at: string;
  readonly operation_id: string;
  readonly record_count: number;
}

interface AuditRetentionSummaryRow {
  readonly latest_at: string;
  readonly operation_id: string;
  readonly record_count: number;
}

function readAuditRetentionState(
  db: Database.Database,
  policy: RetentionPolicy,
  cutoff: AuditRetentionCutoff,
  candidateLimit: number
): AuditRetentionState {
  let metricsRow: AuditRetentionMetricsRow | undefined;
  let newestRow: AuditRetentionNewestRow | undefined;
  try {
    metricsRow = db
      .prepare(
        `
          SELECT
            COUNT(*) AS retained_record_count,
            COALESCE(SUM(
              CASE WHEN event.phase = 'accepted' AND NOT EXISTS (
                SELECT 1
                FROM selected_audit_events AS terminal
                WHERE terminal.operation_id = event.operation_id AND terminal.phase = 'terminal'
              ) THEN 1 ELSE 0 END
            ), 0) AS protected_pending_operation_count,
            COALESCE(SUM(
              CASE WHEN event.phase = 'accepted' AND event.at < @cutoff AND NOT EXISTS (
                SELECT 1
                FROM selected_audit_events AS terminal
                WHERE terminal.operation_id = event.operation_id AND terminal.phase = 'terminal'
              ) THEN 1 ELSE 0 END
            ), 0) AS pending_age_due_count
          FROM selected_audit_events AS event
        `
      )
      .get({ cutoff: cutoff.at }) as AuditRetentionMetricsRow | undefined;
    newestRow = db
      .prepare(
        `
          SELECT
            event.operation_id,
            event.at AS latest_at,
            (SELECT COUNT(*) FROM selected_audit_events AS member WHERE member.operation_id = event.operation_id)
              AS record_count,
            EXISTS (
              SELECT 1
              FROM selected_audit_events AS terminal
              WHERE terminal.operation_id = event.operation_id AND terminal.phase = 'terminal'
            ) AS has_terminal
          FROM selected_audit_events AS event
          ORDER BY event.at DESC, event.operation_id DESC, event.id DESC
          LIMIT 1
        `
      )
      .get() as AuditRetentionNewestRow | undefined;
  } catch (error) {
    throw mapUnavailableRead(error);
  }

  const metrics = parseRetentionMetrics(metricsRow);
  const newest = newestRow === undefined ? null : parseRetentionNewest(newestRow);
  if ((metrics.retained_record_count === 0) !== (newest === null)) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Selected audit retention totals contradict the newest stored operation."
    );
  }
  if (newest !== null) assertNewestRetentionTrail(db, newest);
  const candidates = readAuditRetentionCandidates(db, {
    candidate_limit: candidateLimit,
    cutoff: cutoff.at,
    include_count_candidates: metrics.retained_record_count > policy.audit_event_limit,
    newest_operation_id: newest?.operation_id ?? null
  });
  const newestProtectedTerminalRecords =
    newest?.has_terminal === 1 && Date.parse(newest.latest_at) >= cutoff.time ? newest.record_count : 0;
  const pendingBlocksPolicy =
    metrics.pending_age_due_count > 0 ||
    (metrics.protected_pending_operation_count > 0 &&
      metrics.protected_pending_operation_count + newestProtectedTerminalRecords > policy.audit_event_limit);
  const newestTrailOversize =
    candidates.length === 0 &&
    metrics.protected_pending_operation_count === 0 &&
    metrics.retained_record_count > policy.audit_event_limit &&
    newest?.has_terminal === 1 &&
    Date.parse(newest.latest_at) >= cutoff.time &&
    newest.record_count > policy.audit_event_limit;
  return {
    candidates,
    cutoff_time: cutoff.time,
    newest_trail_oversize: newestTrailOversize,
    pending_blocks_policy: pendingBlocksPolicy,
    protected_pending_operation_count: metrics.protected_pending_operation_count,
    retained_record_count: metrics.retained_record_count
  };
}

function readAuditRetentionCandidates(
  db: Database.Database,
  input: {
    readonly candidate_limit: number;
    readonly cutoff: string;
    readonly include_count_candidates: boolean;
    readonly newest_operation_id: string | null;
  }
): readonly AuditOperationSummary[] {
  let rows: AuditRetentionSummaryRow[];
  try {
    rows = db
      .prepare(
        `
          SELECT
            terminal.operation_id,
            terminal.at AS latest_at,
            (SELECT COUNT(*) FROM selected_audit_events AS member WHERE member.operation_id = terminal.operation_id)
              AS record_count
          FROM selected_audit_events AS terminal
          WHERE terminal.phase = 'terminal' AND terminal.at < @cutoff
          ORDER BY terminal.at ASC, terminal.operation_id ASC
          LIMIT @candidate_limit
        `
      )
      .all({ candidate_limit: input.candidate_limit, cutoff: input.cutoff }) as AuditRetentionSummaryRow[];

    const remainingLimit = input.candidate_limit - rows.length;
    if (input.include_count_candidates && remainingLimit > 0) {
      const countRows = db
        .prepare(
          `
            SELECT
              terminal.operation_id,
              terminal.at AS latest_at,
              (SELECT COUNT(*) FROM selected_audit_events AS member WHERE member.operation_id = terminal.operation_id)
                AS record_count
            FROM selected_audit_events AS terminal
            WHERE terminal.phase = 'terminal'
              AND terminal.at >= @cutoff
              AND (@newest_operation_id IS NULL OR terminal.operation_id <> @newest_operation_id)
            ORDER BY terminal.at ASC, terminal.operation_id ASC
            LIMIT @candidate_limit
          `
        )
        .all({
          candidate_limit: remainingLimit,
          cutoff: input.cutoff,
          newest_operation_id: input.newest_operation_id
        }) as AuditRetentionSummaryRow[];
      rows.push(...countRows);
    }
  } catch (error) {
    throw mapUnavailableRead(error);
  }
  return rows.map(parseRetentionSummary);
}

function assertNewestRetentionTrail(db: Database.Database, summary: AuditRetentionNewestRow): void {
  const trail = readTrail(db, summary.operation_id);
  const latest = trail?.records.at(-1);
  if (
    trail === null ||
    trail.records.length !== summary.record_count ||
    (trail.state === "terminal" ? 1 : 0) !== summary.has_terminal ||
    latest === undefined ||
    latest.at !== summary.latest_at
  ) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Selected audit newest-operation summary contradicts its stored trail."
    );
  }
}

function requireRetentionTrail(db: Database.Database, summary: AuditOperationSummary): SelectedAuditTrail {
  const trail = readTrail(db, summary.operation_id);
  const latest = trail?.records.at(-1);
  if (
    trail === null ||
    trail.state !== "terminal" ||
    trail.records.length !== summary.record_count ||
    latest === undefined ||
    latest.at !== summary.latest_at
  ) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Selected audit retention candidate contradicts its stored operation trail."
    );
  }
  return trail;
}

function parseRetentionMetrics(row: AuditRetentionMetricsRow | undefined): AuditRetentionMetricsRow {
  if (
    row === undefined ||
    !isNonNegativeSafeInteger(row.retained_record_count) ||
    !isNonNegativeSafeInteger(row.protected_pending_operation_count) ||
    !isNonNegativeSafeInteger(row.pending_age_due_count) ||
    row.protected_pending_operation_count > row.retained_record_count ||
    row.pending_age_due_count > row.protected_pending_operation_count
  ) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Selected audit retention metrics are invalid."
    );
  }
  return row;
}

function parseRetentionNewest(row: AuditRetentionNewestRow): AuditRetentionNewestRow {
  const operationId = parseStoredOperationId(row.operation_id);
  const latestAt = parseStoredAuditTimestamp(row.latest_at);
  if (!isPositiveTrailSize(row.record_count) || (row.has_terminal !== 0 && row.has_terminal !== 1)) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Selected audit newest-operation summary is invalid."
    );
  }
  return { ...row, latest_at: latestAt, operation_id: operationId };
}

function parseRetentionSummary(row: AuditRetentionSummaryRow): AuditOperationSummary {
  const operationId = parseStoredOperationId(row.operation_id);
  const latestAt = parseStoredAuditTimestamp(row.latest_at);
  if (!isPositiveTrailSize(row.record_count)) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Selected audit retention candidate size is invalid."
    );
  }
  return { latest_at: latestAt, operation_id: operationId, record_count: row.record_count };
}

function parseStoredOperationId(candidate: unknown): string {
  const result = clientOperationIdSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Stored selected audit operation id is invalid.",
      { cause: result.error }
    );
  }
  return result.data;
}

function parseStoredAuditTimestamp(candidate: unknown): string {
  const result = isoTimestampSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Stored selected audit timestamp is invalid.",
      { cause: result.error }
    );
  }
  if (result.data !== candidate) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Stored selected audit timestamp is not canonical."
    );
  }
  return result.data;
}

function isNonNegativeSafeInteger(candidate: unknown): candidate is number {
  return Number.isSafeInteger(candidate) && (candidate as number) >= 0;
}

function isPositiveTrailSize(candidate: unknown): candidate is 1 | 2 {
  return candidate === 1 || candidate === 2;
}

function parseAuditRetentionPolicy(candidate: unknown): RetentionPolicy {
  const parsed = retentionPolicySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckSelectedAuditRepositoryError("invalid_audit_record", "Selected audit retention policy is invalid.", {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function parseAuditRetentionNow(candidate: unknown): string {
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckSelectedAuditRepositoryError("invalid_audit_record", "Selected audit retention time is invalid.", {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function parseAuditRetentionCutoff(now: string, retentionDays: number): AuditRetentionCutoff {
  const time = Date.parse(now) - retentionDays * 24 * 60 * 60 * 1_000;
  let at: string;
  try {
    at = new Date(time).toISOString();
  } catch (error) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_record",
      "Selected audit retention cutoff is outside the supported timestamp range.",
      { cause: error }
    );
  }
  const parsed = isoTimestampSchema.safeParse(at);
  if (!parsed.success || parsed.data !== at) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_record",
      "Selected audit retention cutoff is outside the supported timestamp range.",
      parsed.success ? undefined : { cause: parsed.error }
    );
  }
  return { at, time };
}

function parseAuditRetentionBatchSize(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 2 || (candidate as number) > 2_000) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_record",
      "Selected audit retention batch size must be between 2 and 2000 records."
    );
  }
  return candidate as number;
}

function readTrail(db: Database.Database, operationId: string): SelectedAuditTrail | null {
  let rows: SelectedAuditRow[];
  try {
    rows = db
      .prepare(
        `
          SELECT id, operation_id, at, action, phase, outcome, error_code, record_json
          FROM selected_audit_events
          WHERE operation_id = ?
          ORDER BY CASE phase WHEN 'accepted' THEN 0 ELSE 1 END, at ASC, id ASC
        `
      )
      .all(operationId) as SelectedAuditRow[];
  } catch (error) {
    throw mapUnavailableRead(error);
  }

  if (rows.length === 0) return null;
  const records = rows.map(parseStoredRecord);
  return parseTrail(operationId, records, "invalid_audit_trail");
}

function parseTrail(
  operationId: string,
  records: readonly SelectedAuditEventRecord[],
  errorCode: "audit_operation_conflict" | "invalid_audit_record" | "invalid_audit_trail"
): SelectedAuditTrail {
  const state = records.length === 1 && records[0]?.phase === "accepted" ? "pending" : "terminal";
  const result = selectedAuditTrailSchema.safeParse({ operation_id: operationId, state, records });
  if (!result.success) {
    const message = errorCode === "invalid_audit_trail" ? "Stored selected audit trail is invalid." : "Audit operation transition is invalid.";
    throw new HostDeckSelectedAuditRepositoryError(errorCode, message, { cause: result.error });
  }
  return result.data;
}

function parseRecord(candidate: unknown): SelectedAuditEventRecord {
  const result = selectedAuditEventRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedAuditRepositoryError("invalid_audit_record", "Selected audit record is invalid.", {
      cause: result.error
    });
  }
  assertRecordSize(JSON.stringify(result.data), "invalid_audit_record");
  return result.data;
}

function parseStoredRecord(row: SelectedAuditRow): SelectedAuditEventRecord {
  assertRecordSize(row.record_json, "invalid_audit_trail");
  let candidate: unknown;
  try {
    candidate = JSON.parse(row.record_json);
  } catch (error) {
    throw new HostDeckSelectedAuditRepositoryError("invalid_audit_trail", "Stored selected audit JSON is invalid.", {
      cause: error
    });
  }

  const result = selectedAuditEventRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedAuditRepositoryError("invalid_audit_trail", "Stored selected audit record is invalid.", {
      cause: result.error
    });
  }
  const record = result.data;
  if (
    record.id !== row.id ||
    record.operation_id !== row.operation_id ||
    record.at !== row.at ||
    record.action !== row.action ||
    record.phase !== row.phase ||
    record.outcome !== row.outcome ||
    record.error_code !== row.error_code
  ) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_trail",
      "Stored selected audit columns contradict record JSON."
    );
  }
  return record;
}

function insertRecord(db: Database.Database, record: SelectedAuditEventRecord): void {
  const row = recordToRow(record);
  try {
    db.prepare(
      `
        INSERT INTO selected_audit_events (
          id,
          operation_id,
          at,
          action,
          phase,
          outcome,
          error_code,
          record_json
        ) VALUES (
          @id,
          @operation_id,
          @at,
          @action,
          @phase,
          @outcome,
          @error_code,
          @record_json
        )
      `
    ).run(row);
  } catch (error) {
    throw mapWriteFailure(error, record);
  }
}

function recordToRow(record: SelectedAuditEventRecord): SelectedAuditRow {
  const recordJson = JSON.stringify(record);
  assertRecordSize(recordJson, "invalid_audit_record");
  return {
    id: record.id,
    operation_id: record.operation_id,
    at: record.at,
    action: record.action,
    phase: record.phase,
    outcome: record.outcome,
    error_code: record.error_code,
    record_json: recordJson
  };
}

function parseOperationId(candidate: string): string {
  const result = clientOperationIdSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckSelectedAuditRepositoryError(
      "invalid_audit_operation_id",
      "Selected audit operation id is invalid.",
      { cause: result.error }
    );
  }
  return result.data;
}

function assertRecordSize(recordJson: string, code: "invalid_audit_record" | "invalid_audit_trail"): void {
  const bytes = Buffer.byteLength(recordJson, "utf8");
  if (bytes < 2 || bytes > maxRecordBytes) {
    throw new HostDeckSelectedAuditRepositoryError(code, `Selected audit record must be between 2 and ${maxRecordBytes} bytes.`);
  }
}

function runWrite<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof HostDeckSelectedAuditRepositoryError) throw error;
    throw mapWriteFailure(error);
  }
}

function invalidRecord(message: string): HostDeckSelectedAuditRepositoryError {
  return new HostDeckSelectedAuditRepositoryError("invalid_audit_record", message);
}

function mapUnavailableRead(error: unknown): HostDeckSelectedAuditRepositoryError {
  if (isUnavailableDatabaseError(error)) {
    return new HostDeckSelectedAuditRepositoryError("audit_unavailable", "Selected audit storage is unavailable.", { cause: error });
  }
  return new HostDeckSelectedAuditRepositoryError("invalid_audit_trail", "Unable to read selected audit storage.", { cause: error });
}

function mapWriteFailure(error: unknown, record?: SelectedAuditEventRecord): HostDeckSelectedAuditRepositoryError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("selected_audit_events.id")) {
    return new HostDeckSelectedAuditRepositoryError("audit_record_exists", "Selected audit record id already exists.", { cause: error });
  }
  if (message.includes("selected audit operation already has a trail")) {
    return new HostDeckSelectedAuditRepositoryError("audit_operation_exists", "Selected audit operation already has a trail.", {
      cause: error
    });
  }
  if (message.includes("selected audit terminal requires accepted")) {
    return new HostDeckSelectedAuditRepositoryError(
      "audit_operation_not_found",
      "Selected audit terminal requires an accepted record.",
      { cause: error }
    );
  }
  if (message.includes("selected_audit_events.operation_id") && message.includes("selected_audit_events.phase")) {
    const code = record?.phase === "terminal" ? "audit_operation_terminal" : "audit_operation_exists";
    return new HostDeckSelectedAuditRepositoryError(code, "Selected audit operation phase already exists.", { cause: error });
  }
  if (isUnavailableDatabaseError(error)) {
    return new HostDeckSelectedAuditRepositoryError("audit_unavailable", "Selected audit storage is unavailable.", { cause: error });
  }
  if (message.includes("constraint") || message.includes("SQLITE_CONSTRAINT")) {
    return new HostDeckSelectedAuditRepositoryError("invalid_audit_record", "Selected audit record violates storage constraints.", {
      cause: error
    });
  }
  return new HostDeckSelectedAuditRepositoryError("audit_write_failed", "Selected audit write failed.", { cause: error });
}

function isUnavailableDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "database connection is not open",
    "database is locked",
    "database disk image is malformed",
    "disk I/O error",
    "no such table: selected_audit_events",
    "readonly database",
    "SQLITE_BUSY",
    "SQLITE_CANTOPEN",
    "SQLITE_CORRUPT",
    "SQLITE_FULL",
    "SQLITE_IOERR",
    "SQLITE_LOCKED",
    "SQLITE_NOTADB",
    "SQLITE_READONLY"
  ].some((fragment) => message.includes(fragment));
}
