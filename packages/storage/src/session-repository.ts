import {
  type SessionMetadataRecord,
  type StorageSessionRecord,
  sessionIdSchema,
  sessionMetadataRecordSchema,
  storageSessionRecordSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type SessionRepositoryErrorCode =
  | "duplicate_session_name"
  | "invalid_metadata"
  | "invalid_session"
  | "metadata_missing"
  | "session_exists"
  | "session_not_found";

export class HostDeckSessionRepositoryError extends Error {
  constructor(
    readonly code: SessionRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckSessionRepositoryError";
  }
}

export interface SessionRepository {
  readonly get: (sessionId: string) => StorageSessionRecord | null;
  readonly require: (sessionId: string) => StorageSessionRecord;
  readonly list: () => readonly StorageSessionRecord[];
  readonly create: (session: unknown) => StorageSessionRecord;
  readonly update: (session: unknown) => StorageSessionRecord;
  readonly markStale: (sessionId: string, reason: string, input?: { readonly now?: () => Date }) => StorageSessionRecord;
}

export interface SessionMetadataRepository {
  readonly get: (sessionId: string) => SessionMetadataRecord | null;
  readonly require: (sessionId: string) => SessionMetadataRecord;
  readonly upsert: (metadata: unknown) => SessionMetadataRecord;
}

interface SessionRow {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly backend_type: "tmux";
  readonly tmux_session: string;
  readonly tmux_window: string | null;
  readonly tmux_pane: string | null;
  readonly lifecycle_state: StorageSessionRecord["lifecycle_state"];
  readonly created_at: string;
  readonly updated_at: string;
  readonly stale_reason: string | null;
}

interface MetadataRow {
  readonly session_id: string;
  readonly branch: string | null;
  readonly last_activity_at: string | null;
  readonly status: SessionMetadataRecord["status"];
  readonly attention: SessionMetadataRecord["attention"];
  readonly summary: string | null;
  readonly last_output_cursor: number | null;
  readonly updated_at: string;
}

export function createSessionRepository(db: Database.Database): SessionRepository {
  return {
    get(sessionId) {
      const parsedSessionId = parseSessionId(sessionId);
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(parsedSessionId) as SessionRow | undefined;
      return row === undefined ? null : parseSessionRow(row);
    },
    require(sessionId) {
      const session = this.get(sessionId);

      if (session === null) {
        throw new HostDeckSessionRepositoryError("session_not_found", `Session ${sessionId} does not exist.`);
      }

      return session;
    },
    list() {
      return (db.prepare("SELECT * FROM sessions ORDER BY created_at ASC, name ASC").all() as SessionRow[]).map(parseSessionRow);
    },
    create(session) {
      const parsed = parseSession(session);

      try {
        db.prepare(`
          INSERT INTO sessions (
            id,
            name,
            cwd,
            backend_type,
            tmux_session,
            tmux_window,
            tmux_pane,
            lifecycle_state,
            created_at,
            updated_at,
            stale_reason
          ) VALUES (
            @id,
            @name,
            @cwd,
            @backend_type,
            @tmux_session,
            @tmux_window,
            @tmux_pane,
            @lifecycle_state,
            @created_at,
            @updated_at,
            @stale_reason
          )
        `).run(sessionToRow(parsed));
      } catch (error) {
        throw mapSessionConstraint(error);
      }

      return parsed;
    },
    update(session) {
      const parsed = parseSession(session);

      try {
        const result = db
          .prepare(
            `
              UPDATE sessions SET
                name = @name,
                cwd = @cwd,
                backend_type = @backend_type,
                tmux_session = @tmux_session,
                tmux_window = @tmux_window,
                tmux_pane = @tmux_pane,
                lifecycle_state = @lifecycle_state,
                created_at = @created_at,
                updated_at = @updated_at,
                stale_reason = @stale_reason
              WHERE id = @id
            `
          )
          .run(sessionToRow(parsed));

        if (result.changes === 0) {
          throw new HostDeckSessionRepositoryError("session_not_found", `Session ${parsed.id} does not exist.`);
        }
      } catch (error) {
        if (error instanceof HostDeckSessionRepositoryError) {
          throw error;
        }

        throw mapSessionConstraint(error);
      }

      return parsed;
    },
    markStale(sessionId, reason, input = {}) {
      const current = this.require(sessionId);
      return this.update({
        ...current,
        lifecycle_state: "stale",
        stale_reason: reason,
        updated_at: nowIso(input.now)
      });
    }
  };
}

export function createSessionMetadataRepository(db: Database.Database): SessionMetadataRepository {
  return {
    get(sessionId) {
      const parsedSessionId = parseSessionId(sessionId);
      const row = db.prepare("SELECT * FROM session_metadata WHERE session_id = ?").get(parsedSessionId) as MetadataRow | undefined;
      return row === undefined ? null : parseMetadataRow(row);
    },
    require(sessionId) {
      const metadata = this.get(sessionId);

      if (metadata === null) {
        throw new HostDeckSessionRepositoryError("metadata_missing", `Session metadata for ${sessionId} does not exist.`);
      }

      return metadata;
    },
    upsert(metadata) {
      const parsed = parseMetadata(metadata);

      try {
        db.prepare(`
          INSERT INTO session_metadata (
            session_id,
            branch,
            last_activity_at,
            status,
            attention,
            summary,
            last_output_cursor,
            updated_at
          ) VALUES (
            @session_id,
            @branch,
            @last_activity_at,
            @status,
            @attention,
            @summary,
            @last_output_cursor,
            @updated_at
          )
          ON CONFLICT(session_id) DO UPDATE SET
            branch = excluded.branch,
            last_activity_at = excluded.last_activity_at,
            status = excluded.status,
            attention = excluded.attention,
            summary = excluded.summary,
            last_output_cursor = excluded.last_output_cursor,
            updated_at = excluded.updated_at
        `).run(metadataToRow(parsed));
      } catch (error) {
        throw mapMetadataConstraint(error);
      }

      return parsed;
    }
  };
}

function parseSessionRow(row: SessionRow): StorageSessionRecord {
  return parseSession({
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    backend: {
      type: row.backend_type,
      tmux_session: row.tmux_session,
      tmux_window: row.tmux_window,
      tmux_pane: row.tmux_pane
    },
    lifecycle_state: row.lifecycle_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stale_reason: row.stale_reason
  });
}

function parseMetadataRow(row: MetadataRow): SessionMetadataRecord {
  return parseMetadata({
    session_id: row.session_id,
    branch: row.branch,
    last_activity_at: row.last_activity_at,
    status: row.status,
    attention: row.attention,
    summary: row.summary,
    last_output_cursor: row.last_output_cursor,
    updated_at: row.updated_at
  });
}

function parseSession(candidate: unknown): StorageSessionRecord {
  const result = storageSessionRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckSessionRepositoryError("invalid_session", "Session record is invalid.", { cause: result.error });
  }

  return result.data;
}

function parseMetadata(candidate: unknown): SessionMetadataRecord {
  const result = sessionMetadataRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckSessionRepositoryError("invalid_metadata", "Session metadata record is invalid.", { cause: result.error });
  }

  return result.data;
}

function parseSessionId(sessionId: string): string {
  const result = sessionIdSchema.safeParse(sessionId);

  if (!result.success) {
    throw new HostDeckSessionRepositoryError("invalid_session", `Session id ${sessionId} is invalid.`, { cause: result.error });
  }

  return result.data;
}

function sessionToRow(session: StorageSessionRecord): SessionRow {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    backend_type: session.backend.type,
    tmux_session: session.backend.tmux_session,
    tmux_window: session.backend.tmux_window,
    tmux_pane: session.backend.tmux_pane,
    lifecycle_state: session.lifecycle_state,
    created_at: session.created_at,
    updated_at: session.updated_at,
    stale_reason: session.stale_reason
  };
}

function metadataToRow(metadata: SessionMetadataRecord): MetadataRow {
  return {
    session_id: metadata.session_id,
    branch: metadata.branch,
    last_activity_at: metadata.last_activity_at,
    status: metadata.status,
    attention: metadata.attention,
    summary: metadata.summary,
    last_output_cursor: metadata.last_output_cursor,
    updated_at: metadata.updated_at
  };
}

function mapSessionConstraint(error: unknown): HostDeckSessionRepositoryError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("sessions.name")) {
    return new HostDeckSessionRepositoryError("duplicate_session_name", "Session name already exists.", { cause: error });
  }

  if (message.includes("sessions.id")) {
    return new HostDeckSessionRepositoryError("session_exists", "Session id already exists.", { cause: error });
  }

  return new HostDeckSessionRepositoryError("invalid_session", "Session record violates SQLite constraints.", { cause: error });
}

function mapMetadataConstraint(error: unknown): HostDeckSessionRepositoryError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("FOREIGN KEY")) {
    return new HostDeckSessionRepositoryError("session_not_found", "Session metadata references a missing session.", { cause: error });
  }

  return new HostDeckSessionRepositoryError("invalid_metadata", "Session metadata violates SQLite constraints.", { cause: error });
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}
