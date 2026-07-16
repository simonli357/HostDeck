import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLegacySessionRepository,
  HostDeckLegacySessionRepositoryError,
  type LegacySessionRepositoryErrorCode
} from "./legacy-session-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { createSelectedStateRepository } from "./selected-state-repository.js";

const tempDirs: string[] = [];
const at = "2026-07-16T12:00:00.000Z";

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("legacy session disposition repository", () => {
  it("reports bounded inert state and requires exact reset confirmation", () => {
    const opened = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      insertLegacySession(opened.db, "sess_legacy_reset_01", "legacy-one");
      const repository = createLegacySessionRepository(opened.db);

      expect(repository.summarize()).toEqual({
        disposition: "legacy_unmigrated",
        legacy_session_count: 1
      });
      expect(Object.isFrozen(repository.summarize())).toBe(true);
      for (const input of [undefined, null, {}, { confirmed: false }, { confirmed: true, extra: true }]) {
        expectRepositoryError(() => repository.reset(input), "confirmation_required");
      }
      expect(repository.summarize().legacy_session_count).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  it("transactionally removes only legacy session state and is idempotent", () => {
    const opened = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const selected = createSelectedStateRepository(opened.db);
      selected.create(selectedState());
      insertLegacySession(opened.db, "sess_legacy_reset_01", "legacy-one");
      insertLegacySession(opened.db, "sess_legacy_reset_02", "legacy-two");
      opened.db
        .prepare(
          "INSERT INTO session_metadata (session_id, branch, last_activity_at, status, attention, summary, last_output_cursor, updated_at) VALUES (?, NULL, NULL, 'idle', 'none', NULL, NULL, ?)"
        )
        .run("sess_legacy_reset_01", at);
      opened.db
        .prepare(
          "INSERT INTO output_events (session_id, cursor, event_order, captured_at, kind, payload, truncated_before) VALUES (?, 1, 1, ?, 'output', 'historical output', NULL)"
        )
        .run("sess_legacy_reset_01", at);
      opened.db
        .prepare(
          "INSERT INTO audit_events (id, at, actor_type, actor_client_id, actor_permission, action, session_id, payload_summary_json, result, error_code) VALUES ('audit_legacy_reset_01', ?, 'cli', 'local_admin', 'write', 'stop', ?, '{}', 'succeeded', NULL)"
        )
        .run(at, "sess_legacy_reset_01");

      const repository = createLegacySessionRepository(opened.db);
      expect(repository.reset({ confirmed: true })).toEqual({
        disposition: "legacy_unmigrated",
        removed_session_count: 2,
        remaining_session_count: 0
      });
      expect(repository.summarize().legacy_session_count).toBe(0);
      expect(repository.reset({ confirmed: true }).removed_session_count).toBe(0);

      expect(tableCount(opened.db, "sessions")).toBe(0);
      expect(tableCount(opened.db, "legacy_session_dispositions")).toBe(0);
      expect(tableCount(opened.db, "session_metadata")).toBe(0);
      expect(tableCount(opened.db, "output_events")).toBe(0);
      expect(opened.db.prepare("SELECT session_id FROM audit_events WHERE id = 'audit_legacy_reset_01'").get()).toEqual({
        session_id: null
      });
      expect(selected.require("sess_selected_reset_01").mapping.codex_thread_id).toBe("thread-selected-reset-01");
      expect(selected.list()).toHaveLength(1);
    } finally {
      opened.db.close();
    }
  });

  it("fails closed when legacy rows and dispositions disagree", () => {
    const opened = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      insertLegacySession(opened.db, "sess_legacy_reset_01", "legacy-one");
      opened.db.prepare("DELETE FROM legacy_session_dispositions").run();
      const repository = createLegacySessionRepository(opened.db);

      expectRepositoryError(() => repository.summarize(), "invalid_legacy_state");
      expectRepositoryError(() => repository.reset({ confirmed: true }), "invalid_legacy_state");
      expect(tableCount(opened.db, "sessions")).toBe(1);
    } finally {
      opened.db.close();
    }
  });
});

function insertLegacySession(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  id: string,
  name: string
): void {
  db.prepare(
    `
      INSERT INTO sessions (
        id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
        lifecycle_state, created_at, updated_at, stale_reason
      ) VALUES (?, ?, ?, 'tmux', ?, NULL, NULL, 'stopped', ?, ?, NULL)
    `
  ).run(id, name, `/tmp/${name}`, `hostdeck_${id}`, at, at);
}

function selectedState() {
  const id = "sess_selected_reset_01";
  const name = "selected-reset";
  const threadId = "thread-selected-reset-01";
  return {
    mapping: {
      id,
      name,
      codex_thread_id: threadId,
      cwd: "/tmp/selected-reset",
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      disposition: "selected",
      created_at: at,
      updated_at: at,
      archived_at: null
    },
    projection: {
      session: {
        id,
        name,
        codex_thread_id: threadId,
        cwd: "/tmp/selected-reset",
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        created_at: at,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: at,
        last_activity_at: null,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function tableCount(db: ReturnType<typeof openMigratedDatabase>["db"], table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: number }).count;
}

function expectRepositoryError(work: () => unknown, code: LegacySessionRepositoryErrorCode): void {
  try {
    work();
    throw new Error("Expected legacy session repository failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckLegacySessionRepositoryError);
    expect(error).toMatchObject({ code });
  }
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-legacy-reset-"));
  tempDirs.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(at);
}
