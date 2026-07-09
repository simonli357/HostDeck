import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRetentionPolicy, type RetentionPolicy } from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditEventRepository } from "./audit-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createRetentionRepository,
  HostDeckRetentionRepositoryError,
  type RetentionRepositoryErrorCode
} from "./retention-repository.js";
import { createSessionRepository } from "./session-repository.js";

const tempDirs: string[] = [];
const sessionId = "sess_ret_01";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("retention repository", () => {
  it("appends output events and returns contiguous replay windows", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const retention = createRetentionRepository(open.db);

      retention.appendOutputEvent(outputEvent(1, "one"));
      retention.appendOutputEvent(outputEvent(2, "two"));
      retention.appendOutputEvent(outputEvent(3, "three"));

      const replay = retention.listOutputReplay(sessionId, { after: 1 });

      expect(replay.truncated).toBe(false);
      expect(replay.boundary).toBeNull();
      expect(replay.events.map((event) => event.cursor)).toEqual([2, 3]);
      expect(replay.next_cursor).toBe(4);
    } finally {
      open.db.close();
    }
  });

  it("enforces output event caps with visible replay boundaries", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const retention = createRetentionRepository(open.db);
      const policy = retentionPolicy({
        output_event_limit: 3,
        output_byte_limit: 1_000_000
      });

      for (const cursor of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
        retention.appendOutputEvent(outputEvent(cursor, `line ${cursor}`), {
          now: fixedNow,
          retention: policy
        });
      }

      expect(outputCursors(open.db)).toEqual([12, 13, 14]);

      const boundary = retention.getLatestBoundary({ scope: "output", sessionId });
      expect(boundary).toMatchObject({
        reason: "event_limit",
        retained_record_count: 3,
        truncated_before_cursor: 11
      });

      const staleReplay = retention.listOutputReplay(sessionId, { after: 10, limit: 10 });
      expect(staleReplay.truncated).toBe(true);
      expect(staleReplay.boundary?.truncated_before_cursor).toBe(11);
      expect(staleReplay.events.map((event) => event.cursor)).toEqual([12, 13, 14]);
      expect(staleReplay.next_cursor).toBe(15);

      const contiguousReplay = retention.listOutputReplay(sessionId, { after: 12 });
      expect(contiguousReplay.truncated).toBe(false);
      expect(contiguousReplay.boundary).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("enforces output byte caps using UTF-8 payload bytes", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const retention = createRetentionRepository(open.db);
      const policy = retentionPolicy({
        output_event_limit: 20,
        output_byte_limit: 7
      });

      retention.appendOutputEvent(outputEvent(1, "12345"), { now: fixedNow, retention: policy });
      retention.appendOutputEvent(outputEvent(2, "éé"), { now: fixedNow, retention: policy });
      retention.appendOutputEvent(outputEvent(3, "abc"), { now: fixedNow, retention: policy });

      expect(outputCursors(open.db)).toEqual([2, 3]);
      expect(retention.getLatestBoundary({ scope: "output", sessionId })).toMatchObject({
        reason: "byte_limit",
        retained_record_count: 1,
        truncated_before_cursor: 1
      });

      const replay = retention.listOutputReplay(sessionId, { after: 0, limit: 10 });
      expect(replay.truncated).toBe(true);
      expect(replay.events.map((event) => event.cursor)).toEqual([2, 3]);
      expect(replay.next_cursor).toBe(4);
    } finally {
      open.db.close();
    }
  });

  it("rejects invalid output, cursor drift, and replay requests", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const retention = createRetentionRepository(open.db);

      expectRetentionError(() => retention.appendOutputEvent(outputEvent(1, "x".repeat(12_001))), "invalid_output_event");
      expectRetentionError(() => retention.appendOutputEvent(outputEvent(1, "missing", "sess_missing_01")), "session_not_found");

      retention.appendOutputEvent(outputEvent(1, "first"));

      expectRetentionError(() => retention.appendOutputEvent(outputEvent(1, "duplicate")), "output_cursor_not_monotonic");
      expectRetentionError(() => retention.appendOutputEvent(outputEvent(0, "old")), "output_cursor_not_monotonic");
      expectRetentionError(() => retention.listOutputReplay(sessionId, { after: -1 }), "invalid_replay_request");
      expectRetentionError(() => retention.listOutputReplay(sessionId, { limit: 0 }), "invalid_replay_request");
    } finally {
      open.db.close();
    }
  });

  it("blocks invalid persisted output rows and boundaries on read", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      open.db.pragma("ignore_check_constraints = ON");
      open.db
        .prepare(
          `
            INSERT INTO output_events (
              session_id,
              cursor,
              event_order,
              captured_at,
              kind,
              payload,
              truncated_before
            ) VALUES (
              ?,
              1,
              0,
              '2026-07-08T22:00:00.000Z',
              'output',
              NULL,
              NULL
            )
          `
        )
        .run(sessionId);
      open.db
        .prepare(
          `
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
              'retention_corrupt',
              'output',
              ?,
              'event_limit',
              NULL,
              NULL,
              0,
              '2026-07-08T22:00:00.000Z'
            )
          `
        )
        .run(sessionId);
      open.db.pragma("ignore_check_constraints = OFF");

      const retention = createRetentionRepository(open.db);
      expectRetentionError(() => retention.listOutputReplay(sessionId), "invalid_retention_boundary");

      open.db.prepare("DELETE FROM retention_boundaries WHERE id = 'retention_corrupt'").run();
      expectRetentionError(() => retention.listOutputReplay(sessionId), "invalid_output_event");
    } finally {
      open.db.close();
    }
  });

  it("cleans audit records by count and records a global boundary", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const audit = createAuditEventRepository(open.db);
      const retention = createRetentionRepository(open.db);

      for (const index of [1, 2, 3, 4, 5]) {
        audit.append(auditEvent(`audit_count_${index}`, `2026-07-08T22:00:0${index}.000Z`));
      }

      const boundary = retention.cleanupAuditEvents({
        now: fixedNow,
        retention: retentionPolicy({
          audit_event_limit: 3,
          audit_retention_days: 365
        })
      });

      expect(boundary).toMatchObject({
        reason: "event_limit",
        scope: "audit",
        session_id: null,
        retained_record_count: 3,
        truncated_before_at: null
      });
      expect(audit.list({ limit: 10 }).map((event) => event.id)).toEqual(["audit_count_5", "audit_count_4", "audit_count_3"]);
    } finally {
      open.db.close();
    }
  });

  it("cleans audit records by age and records the cutoff boundary", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const audit = createAuditEventRepository(open.db);
      const retention = createRetentionRepository(open.db);

      audit.append(auditEvent("audit_old", "2026-06-01T22:00:00.000Z"));
      audit.append(auditEvent("audit_new", "2026-07-08T21:00:00.000Z"));

      const boundary = retention.cleanupAuditEvents({
        now: fixedNow,
        retention: retentionPolicy({
          audit_event_limit: 10,
          audit_retention_days: 30
        })
      });

      expect(boundary).toMatchObject({
        reason: "age_limit",
        retained_record_count: 1,
        truncated_before_at: "2026-06-08T22:00:00.000Z"
      });
      expect(audit.list({ limit: 10 }).map((event) => event.id)).toEqual(["audit_new"]);
    } finally {
      open.db.close();
    }
  });
});

function sessionRecord() {
  return {
    id: sessionId,
    name: "retention-demo",
    cwd: tempCwd(),
    backend: {
      type: "tmux",
      tmux_session: "hostdeck-retention-demo",
      tmux_window: null,
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: "2026-07-08T22:00:00.000Z",
    updated_at: "2026-07-08T22:00:00.000Z",
    stale_reason: null
  };
}

function outputEvent(cursor: number, payload: string, targetSessionId = sessionId) {
  return {
    session_id: targetSessionId,
    cursor,
    order: cursor === 0 ? 0 : cursor - 1,
    captured_at: "2026-07-08T22:00:00.000Z",
    kind: "output",
    payload,
    truncated_before: null
  };
}

function auditEvent(id: string, at: string) {
  return {
    id,
    at,
    actor: {
      type: "system",
      client_id: null,
      permission: null
    },
    action: "lock",
    session_id: null,
    payload_summary: {
      reason: "retention-test"
    },
    result: "accepted",
    error_code: null
  };
}

function retentionPolicy(overrides: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    ...defaultRetentionPolicy,
    ...overrides
  };
}

function outputCursors(db: Database.Database): number[] {
  return (db.prepare("SELECT cursor FROM output_events WHERE session_id = ? ORDER BY cursor ASC").all(sessionId) as Array<{ readonly cursor: number }>).map(
    (row) => row.cursor
  );
}

function expectRetentionError(fn: () => unknown, code: RetentionRepositoryErrorCode): void {
  expect(fn).toThrow(HostDeckRetentionRepositoryError);

  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckRetentionRepositoryError);
    expect((error as HostDeckRetentionRepositoryError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckRetentionRepositoryError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-retention-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-retention-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}
