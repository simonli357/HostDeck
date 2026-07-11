import { Buffer } from "node:buffer";
import {
  clientOperationIdSchema,
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
