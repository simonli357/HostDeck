import type Database from "better-sqlite3";

export type LegacySessionRepositoryErrorCode =
  | "confirmation_required"
  | "invalid_legacy_state"
  | "reset_failed";

export class HostDeckLegacySessionRepositoryError extends Error {
  constructor(
    readonly code: LegacySessionRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckLegacySessionRepositoryError";
  }
}

export interface LegacySessionSummary {
  readonly disposition: "legacy_unmigrated";
  readonly legacy_session_count: number;
}

export interface LegacySessionResetResult {
  readonly disposition: "legacy_unmigrated";
  readonly removed_session_count: number;
  readonly remaining_session_count: 0;
}

export interface LegacySessionRepository {
  readonly summarize: () => LegacySessionSummary;
  readonly reset: (input: unknown) => LegacySessionResetResult;
}

interface CountRow {
  readonly count: number;
}

export function createLegacySessionRepository(db: Database.Database): LegacySessionRepository {
  const resetTransaction = db.transaction((): LegacySessionResetResult => {
    const before = readConsistentCount(db);

    try {
      const deleted = db.prepare("DELETE FROM sessions").run();
      if (deleted.changes !== before) {
        throw new HostDeckLegacySessionRepositoryError(
          "reset_failed",
          "Legacy session reset did not delete the exact observed row count."
        );
      }
      if (readConsistentCount(db) !== 0) {
        throw new HostDeckLegacySessionRepositoryError(
          "reset_failed",
          "Legacy session reset left classified rows behind."
        );
      }
      return Object.freeze({
        disposition: "legacy_unmigrated",
        removed_session_count: before,
        remaining_session_count: 0
      });
    } catch (error) {
      if (error instanceof HostDeckLegacySessionRepositoryError) throw error;
      throw new HostDeckLegacySessionRepositoryError(
        "reset_failed",
        "Legacy session reset failed and was rolled back.",
        { cause: error }
      );
    }
  }).immediate;

  return {
    summarize() {
      return Object.freeze({
        disposition: "legacy_unmigrated",
        legacy_session_count: readConsistentCount(db)
      });
    },
    reset(input) {
      assertResetConfirmation(input);
      return resetTransaction();
    }
  };
}

function assertResetConfirmation(input: unknown): void {
  if (!isRecord(input) || Object.keys(input).length !== 1 || input.confirmed !== true) {
    throw new HostDeckLegacySessionRepositoryError(
      "confirmation_required",
      "Legacy session reset requires explicit confirmation."
    );
  }
}

function readConsistentCount(db: Database.Database): number {
  const sessions = readCount(db, "sessions");
  const dispositions = readCount(db, "legacy_session_dispositions");
  if (sessions !== dispositions) {
    throw new HostDeckLegacySessionRepositoryError(
      "invalid_legacy_state",
      "Legacy session rows and disposition rows do not agree."
    );
  }
  return sessions;
}

function readCount(db: Database.Database, table: "legacy_session_dispositions" | "sessions"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
  if (!Number.isSafeInteger(row.count) || row.count < 0) {
    throw new HostDeckLegacySessionRepositoryError(
      "invalid_legacy_state",
      "Legacy session count is outside the supported range."
    );
  }
  return row.count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
