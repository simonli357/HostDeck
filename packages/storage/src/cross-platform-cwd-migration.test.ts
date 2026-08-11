import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDeckMigrationError,
  openMigratedDatabase,
  runMigrations
} from "./migration-runner.js";
import {
  defaultMigrations,
  hostDeckCrossPlatformCwdMigration,
  type StorageMigration
} from "./migrations.js";

const cleanup: string[] = [];
const priorMigrations = defaultMigrations.slice(0, -1);
const at = "2026-08-11T12:00:00.000Z";

afterEach(() => {
  for (const root of cleanup.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("cross-platform durable cwd migration", () => {
  it("preserves prior rows and admits only local absolute POSIX or Windows drive paths", () => {
    const path = databasePath();
    const prior = openMigratedDatabase(path, {
      migrations: priorMigrations,
      now: fixedNow
    });
    seedPriorRows(prior.db);
    const before = durableSnapshot(prior.db);

    expect(runMigrations(prior.db, { now: fixedNow }).applied).toEqual([
      hostDeckCrossPlatformCwdMigration.version
    ]);
    expect(durableSnapshot(prior.db)).toEqual(before);
    expect(prior.db.pragma("foreign_key_check")).toEqual([]);
    expect(schemaNames(prior.db, "index")).toEqual(
      expect.arrayContaining([
        "selected_projected_events_session_cursor_idx",
        "selected_sessions_created_idx"
      ])
    );
    expect(schemaNames(prior.db, "trigger")).toEqual(
      expect.arrayContaining([
        "legacy_session_disposition_after_insert",
        "legacy_session_disposition_after_update"
      ])
    );

    insertSelectedSession(
      prior.db,
      "sess_windows_01",
      "windows-session",
      "thread-windows-01",
      "C:\\Users\\selected\\project"
    );
    prior.db
      .prepare(
        `
          INSERT INTO selected_session_start_recovery (
            operation_id, session_id, name, cwd, codex_thread_id, state,
            created_at, updated_at, error_code, error_message
          ) VALUES (?, ?, ?, ?, NULL, 'reserved', ?, ?, NULL, NULL)
        `
      )
      .run(
        "op_windows_01",
        "sess_windows_recovery_01",
        "windows-recovery",
        "D:/work/recovery",
        at,
        at
      );
    insertLegacySession(
      prior.db,
      "sess_windows_legacy_01",
      "windows-legacy",
      "E:\\legacy\\project"
    );
    expect(
      prior.db
        .prepare("SELECT cwd FROM legacy_session_dispositions WHERE id = ?")
        .get("sess_windows_legacy_01")
    ).toEqual({ cwd: "E:\\legacy\\project" });

    for (const [index, cwd] of [
      "relative/project",
      "C:drive-relative",
      "\\root-relative",
      "\\\\server\\share\\project",
      "C:\\project\0bad"
    ].entries()) {
      expect(() =>
        insertSelectedSession(
          prior.db,
          `sess_invalid_${String(index).padStart(2, "0")}`,
          `invalid-${index}`,
          `thread-invalid-${index}`,
          cwd
        )
      ).toThrow();
    }

    prior.db.prepare("DELETE FROM selected_sessions WHERE id = ?").run("sess_posix_01");
    expect(
      prior.db
        .prepare(
          "SELECT COUNT(*) AS count FROM selected_session_projections WHERE session_id = ?"
        )
        .get("sess_posix_01")
    ).toEqual({ count: 0 });
    expect(
      prior.db
        .prepare(
          "SELECT COUNT(*) AS count FROM selected_projected_events WHERE session_id = ?"
        )
        .get("sess_posix_01")
    ).toEqual({ count: 0 });
    prior.db.close();
  });

  it("rolls every rebuilt table back when the migration transaction fails", () => {
    const path = databasePath();
    const prior = openMigratedDatabase(path, {
      migrations: priorMigrations,
      now: fixedNow
    });
    seedPriorRows(prior.db);
    const before = durableSnapshot(prior.db);
    const failingMigration: StorageMigration = {
      ...hostDeckCrossPlatformCwdMigration,
      sql: `${hostDeckCrossPlatformCwdMigration.sql}\nSELECT * FROM missing_cross_platform_cwd_dependency;`
    };

    expect(() =>
      runMigrations(prior.db, {
        migrations: [...priorMigrations, failingMigration],
        now: fixedNow
      })
    ).toThrow(HostDeckMigrationError);
    expect(durableSnapshot(prior.db)).toEqual(before);
    expect(
      prior.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
    ).toHaveLength(priorMigrations.length);
    expect(
      schemaNames(prior.db, "table").filter((name) => name.endsWith("_next"))
    ).toEqual([]);
    expect(prior.db.pragma("foreign_key_check")).toEqual([]);

    expect(runMigrations(prior.db, { now: fixedNow }).applied).toEqual([
      hostDeckCrossPlatformCwdMigration.version
    ]);
    expect(durableSnapshot(prior.db)).toEqual(before);
    prior.db.close();
  });
});

function seedPriorRows(db: import("better-sqlite3").Database): void {
  insertSelectedSession(
    db,
    "sess_posix_01",
    "posix-session",
    "thread-posix-01",
    "/home/selected/project"
  );
  db.prepare(
    `
      INSERT INTO selected_session_projections (
        session_id, session_state, turn_state, attention, freshness,
        freshness_reason, updated_at, last_activity_at, branch, model,
        goal_json, recent_summary, last_event_cursor, retained_event_count,
        retained_event_bytes, earliest_retained_cursor,
        retention_boundary_cursor, settings_json
      ) VALUES (?, 'active', 'idle', 'none', 'current', NULL, ?, NULL,
        'main', 'gpt-5.5-codex', NULL, 'preserved summary', 1, 1, 128, 1,
        NULL, NULL)
    `
  ).run("sess_posix_01", at);
  db.prepare(
    `
      INSERT INTO selected_projected_events (
        session_id, cursor, normalized_type, codex_event_id,
        codex_event_type, captured_at, content_state, byte_length, event_json
      ) VALUES (?, 1, 'message', 'event-posix-01',
        'item/agentMessage/delta', ?, 'complete', 128, ?)
    `
  ).run(
    "sess_posix_01",
    at,
    JSON.stringify({ schema_version: 1, type: "message", text: "preserved" })
  );
  db.prepare(
    `
      INSERT INTO selected_session_start_recovery (
        operation_id, session_id, name, cwd, codex_thread_id, state,
        created_at, updated_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, 'persisted', ?, ?, NULL, NULL)
    `
  ).run(
    "op_posix_01",
    "sess_posix_01",
    "posix-session",
    "/home/selected/project",
    "thread-posix-01",
    at,
    at
  );
  insertLegacySession(
    db,
    "sess_legacy_posix_01",
    "legacy-posix",
    "/home/selected/legacy"
  );
}

function insertSelectedSession(
  db: import("better-sqlite3").Database,
  id: string,
  name: string,
  threadId: string,
  cwd: string
): void {
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'codex_app_server', '0.144.0', 'selected', ?, ?, NULL)
    `
  ).run(id, name, threadId, cwd, at, at);
}

function insertLegacySession(
  db: import("better-sqlite3").Database,
  id: string,
  name: string,
  cwd: string
): void {
  db.prepare(
    `
      INSERT INTO sessions (
        id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
        lifecycle_state, created_at, updated_at, stale_reason
      ) VALUES (?, ?, ?, 'tmux', ?, NULL, NULL, 'running', ?, ?, NULL)
    `
  ).run(id, name, cwd, `tmux-${id}`, at, at);
}

function durableSnapshot(db: import("better-sqlite3").Database): unknown {
  return Object.fromEntries(
    [
      "legacy_session_dispositions",
      "selected_projected_events",
      "selected_session_projections",
      "selected_session_start_recovery",
      "selected_sessions"
    ].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
    ])
  );
}

function schemaNames(
  db: import("better-sqlite3").Database,
  type: "index" | "table" | "trigger"
): readonly string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all(type) as Array<{ readonly name: string }>
  ).map(({ name }) => name);
}

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-cwd-migration-"));
  cleanup.push(root);
  return join(root, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(at);
}
