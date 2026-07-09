import { type AuditEventRecord, auditEventRecordSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type AuditRepositoryErrorCode = "audit_event_exists" | "audit_event_not_found" | "audit_unavailable" | "invalid_audit_event";

export class HostDeckAuditRepositoryError extends Error {
  constructor(
    readonly code: AuditRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckAuditRepositoryError";
  }
}

export interface ListAuditEventsInput {
  readonly limit?: number;
  readonly sessionId?: string | null;
}

export interface AuditEventRepository {
  readonly append: (event: unknown) => AuditEventRecord;
  readonly get: (eventId: string) => AuditEventRecord | null;
  readonly require: (eventId: string) => AuditEventRecord;
  readonly list: (input?: ListAuditEventsInput) => readonly AuditEventRecord[];
}

interface AuditEventRow {
  readonly id: string;
  readonly at: string;
  readonly actor_type: AuditEventRecord["actor"]["type"];
  readonly actor_client_id: string | null;
  readonly actor_permission: AuditEventRecord["actor"]["permission"];
  readonly action: AuditEventRecord["action"];
  readonly session_id: string | null;
  readonly payload_summary_json: string;
  readonly result: AuditEventRecord["result"];
  readonly error_code: AuditEventRecord["error_code"];
}

export function createAuditEventRepository(db: Database.Database): AuditEventRepository {
  return {
    append(event) {
      const parsed = parseAuditEvent(event);

      try {
        db.prepare(`
          INSERT INTO audit_events (
            id,
            at,
            actor_type,
            actor_client_id,
            actor_permission,
            action,
            session_id,
            payload_summary_json,
            result,
            error_code
          ) VALUES (
            @id,
            @at,
            @actor_type,
            @actor_client_id,
            @actor_permission,
            @action,
            @session_id,
            @payload_summary_json,
            @result,
            @error_code
          )
        `).run(auditEventToRow(parsed));
      } catch (error) {
        throw mapAuditConstraint(error);
      }

      return parsed;
    },
    get(eventId) {
      const row = db.prepare("SELECT * FROM audit_events WHERE id = ?").get(eventId) as AuditEventRow | undefined;
      return row === undefined ? null : parseAuditEventRow(row);
    },
    require(eventId) {
      const event = this.get(eventId);

      if (event === null) {
        throw new HostDeckAuditRepositoryError("audit_event_not_found", `Audit event ${eventId} does not exist.`);
      }

      return event;
    },
    list(input = {}) {
      const limit = input.limit ?? 100;

      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new HostDeckAuditRepositoryError("invalid_audit_event", "Audit event list limit must be between 1 and 1000.");
      }

      const rows =
        input.sessionId === undefined
          ? (db.prepare("SELECT * FROM audit_events ORDER BY at DESC, id DESC LIMIT ?").all(limit) as AuditEventRow[])
          : (db.prepare("SELECT * FROM audit_events WHERE session_id IS ? ORDER BY at DESC, id DESC LIMIT ?").all(input.sessionId, limit) as AuditEventRow[]);

      return rows.map(parseAuditEventRow);
    }
  };
}

function parseAuditEventRow(row: AuditEventRow): AuditEventRecord {
  let payloadSummary: unknown;

  try {
    payloadSummary = JSON.parse(row.payload_summary_json);
  } catch (error) {
    throw new HostDeckAuditRepositoryError("invalid_audit_event", "Audit event payload summary is not valid JSON.", { cause: error });
  }

  return parseAuditEvent({
    id: row.id,
    at: row.at,
    actor: {
      type: row.actor_type,
      client_id: row.actor_client_id,
      permission: row.actor_permission
    },
    action: row.action,
    session_id: row.session_id,
    payload_summary: payloadSummary,
    result: row.result,
    error_code: row.error_code
  });
}

function parseAuditEvent(candidate: unknown): AuditEventRecord {
  const result = auditEventRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckAuditRepositoryError("invalid_audit_event", "Audit event record is invalid.", { cause: result.error });
  }

  return result.data;
}

function auditEventToRow(event: AuditEventRecord): AuditEventRow {
  return {
    id: event.id,
    at: event.at,
    actor_type: event.actor.type,
    actor_client_id: event.actor.client_id,
    actor_permission: event.actor.permission,
    action: event.action,
    session_id: event.session_id,
    payload_summary_json: JSON.stringify(event.payload_summary),
    result: event.result,
    error_code: event.error_code
  };
}

function mapAuditConstraint(error: unknown): HostDeckAuditRepositoryError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("audit_events.id")) {
    return new HostDeckAuditRepositoryError("audit_event_exists", "Audit event id already exists.", { cause: error });
  }

  if (
    message.includes("database connection is not open") ||
    message.includes("no such table: audit_events") ||
    message.includes("readonly database") ||
    message.includes("SQLITE_READONLY")
  ) {
    return new HostDeckAuditRepositoryError("audit_unavailable", "Audit storage is unavailable.", { cause: error });
  }

  return new HostDeckAuditRepositoryError("invalid_audit_event", "Audit event violates SQLite constraints.", { cause: error });
}
