import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SelectedSessionListInput,
  type SelectedSessionListPage,
  selectedSessionListInputSchema,
  selectedSessionListMaximumActiveSessions
} from "@hostdeck/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createSelectedSessionReadRepository,
  HostDeckSelectedSessionReadRepositoryError,
  type SelectedSessionReadRepositoryErrorCode
} from "./selected-session-read-repository.js";

const tempDirs: string[] = [];
const createdAt = "2026-07-16T12:00:00.000Z";
const activeUpdatedAt = "2026-07-16T12:10:00.000Z";
const archivedAt = "2026-07-16T12:20:00.000Z";

interface SeedSessionOptions {
  readonly archived?: boolean;
  readonly attention?: "none" | "watch" | "needs_input" | "needs_approval" | "failed" | "stuck" | "unknown";
  readonly cwd?: string;
  readonly disposition?: "selected" | "recovery_required";
  readonly freshness?: "current" | "stale" | "disconnected" | "incompatible";
  readonly goal?: unknown;
  readonly id: string;
  readonly lastActivityAt?: string | null;
  readonly recentSummary?: string;
  readonly sessionState?: "starting" | "active" | "archived" | "stale" | "incompatible" | "unknown";
  readonly settings?: unknown;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected session-read repository", () => {
  it("handles empty, one, exact-limit, lookahead, maximum-page, and subsequent pages", () => {
    const open = openDatabase();
    try {
      const repository = createSelectedSessionReadRepository(open.db);
      expect(repository.list(firstPageInput(2))).toMatchObject({
        has_more: false,
        next_after: null,
        sessions: []
      });

      seedSession(open.db, { id: "sess_page_01" });
      expect(repository.list(firstPageInput(2))).toMatchObject({
        has_more: false,
        next_after: null,
        sessions: [{ session: { id: "sess_page_01" } }]
      });

      seedSession(open.db, { id: "sess_page_02" });
      expect(repository.list(firstPageInput(2))).toMatchObject({
        has_more: false,
        next_after: null,
        sessions: [
          { session: { id: "sess_page_01" } },
          { session: { id: "sess_page_02" } }
        ]
      });

      seedSession(open.db, { id: "sess_page_03" });
      const first = repository.list(firstPageInput(2));
      expect(first).toMatchObject({
        has_more: true,
        sessions: [
          { session: { id: "sess_page_01" } },
          { session: { id: "sess_page_02" } }
        ]
      });
      expect(first.next_after?.session_id).toBe("sess_page_02");
      expect(repository.list(nextPageInput(first, 2))).toMatchObject({
        has_more: false,
        next_after: null,
        sessions: [{ session: { id: "sess_page_03" } }]
      });

      for (let index = 4; index <= 105; index += 1) {
        seedSession(open.db, { id: `sess_page_${String(index).padStart(2, "0")}` });
      }
      const maximum = repository.list(firstPageInput(100));
      expect(maximum.sessions).toHaveLength(100);
      expect(maximum.has_more).toBe(true);
      const expectedMaximumIds = Array.from(
        { length: 105 },
        (_, index) => `sess_page_${String(index + 1).padStart(2, "0")}`
      ).sort();
      expect(maximum.next_after?.session_id).toBe(expectedMaximumIds[99]);
    } finally {
      open.db.close();
    }
  });

  it("uses the exact shared attention, activity, null, and id order independent of insertion", () => {
    const open = openDatabase();
    try {
      const options: SeedSessionOptions[] = [
        { attention: "none", id: "sess_order_09" },
        { attention: "watch", id: "sess_order_08" },
        { attention: "unknown", id: "sess_order_06", lastActivityAt: null },
        { attention: "unknown", id: "sess_order_05", lastActivityAt: activeUpdatedAt },
        { attention: "stuck", id: "sess_order_04", lastActivityAt: activeUpdatedAt },
        { attention: "failed", id: "sess_order_03" },
        { attention: "needs_input", id: "sess_order_02" },
        { attention: "needs_approval", id: "sess_order_01" }
      ];
      for (const option of options) seedSession(open.db, option);

      const page = createSelectedSessionReadRepository(open.db).list(firstPageInput(100));
      expect(page.sessions.map(({ session }) => session.id)).toEqual([
        "sess_order_01",
        "sess_order_02",
        "sess_order_03",
        "sess_order_04",
        "sess_order_05",
        "sess_order_06",
        "sess_order_08",
        "sess_order_09"
      ]);
    } finally {
      open.db.close();
    }
  });

  it("returns honest empty, contiguous, bounded, and degraded detail while omitting event payloads", () => {
    const open = openDatabase();
    const privateSentinel = "private-event-payload-must-not-escape";
    try {
      seedSession(open.db, { id: "sess_detail_empty" });
      seedSession(open.db, {
        attention: "unknown",
        freshness: "disconnected",
        id: "sess_detail_stale",
        sessionState: "unknown"
      });
      seedSession(open.db, { id: "sess_detail_contiguous" });
      seedEvents(open.db, "sess_detail_contiguous", 1, 3, null, privateSentinel);
      seedSession(open.db, { id: "sess_detail_bounded" });
      seedEvents(open.db, "sess_detail_bounded", 5, 7, 4, privateSentinel);

      const repository = createSelectedSessionReadRepository(open.db);
      expect(repository.get("sess_detail_empty")?.event_window).toEqual({
        boundary_cursor: null,
        earliest_retained_cursor: null,
        retained_event_count: 0,
        state: "empty"
      });
      expect(repository.get("sess_detail_contiguous")?.event_window).toEqual({
        boundary_cursor: null,
        earliest_retained_cursor: 1,
        retained_event_count: 3,
        state: "contiguous"
      });
      expect(repository.get("sess_detail_bounded")?.event_window).toEqual({
        boundary_cursor: 4,
        earliest_retained_cursor: 5,
        retained_event_count: 3,
        state: "bounded"
      });
      expect(repository.get("sess_detail_stale")?.session).toMatchObject({
        attention: "unknown",
        freshness: "disconnected",
        freshness_reason: "Projection is disconnected.",
        session_state: "unknown"
      });
      expect(JSON.stringify(repository.get("sess_detail_bounded"))).not.toContain(privateSentinel);
    } finally {
      open.db.close();
    }
  });

  it("omits archived rows and distinguishes unknown, archived, and recovery-required detail", () => {
    const open = openDatabase();
    try {
      seedSession(open.db, { archived: true, id: "sess_policy_archived" });
      seedSession(open.db, { disposition: "recovery_required", id: "sess_policy_recovery" });
      const repository = createSelectedSessionReadRepository(open.db);

      expect(repository.get("sess_policy_missing")).toBeNull();
      expectRepositoryError(() => repository.get("sess_policy_archived"), "session_archived");
      expectRepositoryError(
        () => repository.get("sess_policy_recovery"),
        "session_recovery_required"
      );
      expectRepositoryError(
        () => repository.list(firstPageInput(100)),
        "session_recovery_required"
      );

      open.db.prepare("DELETE FROM selected_session_projections WHERE session_id = ?").run("sess_policy_recovery");
      open.db.prepare("DELETE FROM selected_sessions WHERE id = ?").run("sess_policy_recovery");
      expect(repository.list(firstPageInput(100)).sessions).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("keeps continuation valid for non-ordering changes and rejects every ordering or membership change", () => {
    const stable = openDatabase();
    try {
      seedSession(stable.db, { id: "sess_stable_01" });
      seedSession(stable.db, { id: "sess_stable_02" });
      const repository = createSelectedSessionReadRepository(stable.db);
      const first = repository.list(firstPageInput(1));
      stable.db
        .prepare("UPDATE selected_session_projections SET recent_summary = ? WHERE session_id = ?")
        .run("Updated without changing order.", "sess_stable_02");
      expect(repository.list(nextPageInput(first, 1))).toMatchObject({
        sessions: [{ session: { id: "sess_stable_02", recent_summary: "Updated without changing order." } }]
      });
    } finally {
      stable.db.close();
    }

    for (const mutation of ["attention", "activity", "insert", "archive"] as const) {
      const open = openDatabase();
      try {
        seedSession(open.db, { id: "sess_change_01" });
        seedSession(open.db, { id: "sess_change_02" });
        const repository = createSelectedSessionReadRepository(open.db);
        const first = repository.list(firstPageInput(1));
        if (mutation === "attention") {
          open.db
            .prepare("UPDATE selected_session_projections SET attention = 'needs_approval' WHERE session_id = ?")
            .run("sess_change_02");
        } else if (mutation === "activity") {
          open.db
            .prepare("UPDATE selected_session_projections SET last_activity_at = ? WHERE session_id = ?")
            .run("2026-07-16T12:09:00.000Z", "sess_change_02");
        } else if (mutation === "insert") {
          seedSession(open.db, { id: "sess_change_03" });
        } else {
          archiveSession(open.db, "sess_change_02");
        }
        expectRepositoryError(
          () => repository.list(nextPageInput(first, 1)),
          "session_list_changed"
        );
      } finally {
        open.db.close();
      }
    }
  });

  it("traverses exactly 4,096 sessions without duplicates and rejects the 4,097th", () => {
    const open = openDatabase();
    try {
      seedBulkSessions(open.db, selectedSessionListMaximumActiveSessions);
      const repository = createSelectedSessionReadRepository(open.db);
      const observed: string[] = [];
      let input = firstPageInput(100);
      let pageCount = 0;
      do {
        const page = repository.list(input);
        pageCount += 1;
        observed.push(...page.sessions.map(({ session }) => session.id));
        if (!page.has_more) break;
        input = nextPageInput(page, 100);
      } while (pageCount <= 42);

      expect(pageCount).toBe(41);
      expect(observed).toHaveLength(selectedSessionListMaximumActiveSessions);
      expect(new Set(observed).size).toBe(selectedSessionListMaximumActiveSessions);
      expect(observed.at(0)).toBe("sess_bulk_0000");
      expect(observed.at(-1)).toBe("sess_bulk_4095");

      seedSession(open.db, { id: "sess_bulk_4096" });
      expectRepositoryError(
        () => repository.list(firstPageInput(1)),
        "session_list_overflow"
      );
    } finally {
      open.db.close();
    }
  }, 30_000);

  it("validates every lookahead row and fails atomically for malformed durable state", () => {
    const corruptions = [
      {
        name: "missing projection",
        apply(db: Database.Database) {
          db.prepare("DELETE FROM selected_session_projections WHERE session_id = ?").run("sess_corrupt_03");
        }
      },
      {
        name: "invalid settings JSON",
        apply(db: Database.Database) {
          db.pragma("ignore_check_constraints = ON");
          db.prepare("UPDATE selected_session_projections SET settings_json = ? WHERE session_id = ?").run(
            "{invalid",
            "sess_corrupt_03"
          );
        }
      },
      {
        name: "invalid goal JSON shape",
        apply(db: Database.Database) {
          db.prepare("UPDATE selected_session_projections SET goal_json = ? WHERE session_id = ?").run(
            JSON.stringify({ objective: "Valid", state: "active", private: true }),
            "sess_corrupt_03"
          );
        }
      },
      {
        name: "oversized cwd",
        apply(db: Database.Database) {
          db.prepare("UPDATE selected_sessions SET cwd = ? WHERE id = ?").run(
            `/${"a".repeat(4_096)}`,
            "sess_corrupt_03"
          );
        }
      },
      {
        name: "noncanonical activity timestamp",
        apply(db: Database.Database) {
          db.prepare("UPDATE selected_session_projections SET last_activity_at = ? WHERE session_id = ?").run(
            "2026-07-16T08:00:00.000-04:00",
            "sess_corrupt_03"
          );
        }
      },
      {
        name: "counter drift",
        apply(db: Database.Database) {
          db.pragma("ignore_check_constraints = ON");
          db.prepare(
            "UPDATE selected_session_projections SET retained_event_count = 1, retained_event_bytes = 10, earliest_retained_cursor = 1, last_event_cursor = 1 WHERE session_id = ?"
          ).run("sess_corrupt_03");
        }
      }
    ];

    for (const corruption of corruptions) {
      const open = openDatabase();
      try {
        seedSession(open.db, { id: "sess_corrupt_01" });
        seedSession(open.db, { id: "sess_corrupt_02" });
        seedSession(open.db, { id: "sess_corrupt_03" });
        corruption.apply(open.db);
        const error = expectRepositoryError(
          () => createSelectedSessionReadRepository(open.db).list(firstPageInput(2)),
          "invalid_state"
        );
        expect(error.message, corruption.name).toBe("Managed-session storage is inconsistent.");
        expect(error.cause, corruption.name).toBeUndefined();
      } finally {
        open.db.close();
      }
    }
  });

  it("detects retained-event holes and invalid boundary metadata without reading event bodies", () => {
    for (const corruption of [
      "hole",
      "boundary",
      "type",
      "unexpected_boundary",
      "duplicate_boundary",
      "boundary_only"
    ] as const) {
      const open = openDatabase();
      try {
        seedSession(open.db, { id: "sess_events_corrupt" });
        if (corruption === "duplicate_boundary") {
          seedEvents(open.db, "sess_events_corrupt", 5, 7, 4, "event-private-sentinel");
        } else if (corruption === "boundary_only") {
          seedEvents(open.db, "sess_events_corrupt", 5, 5, 4, "event-private-sentinel");
        } else {
          seedEvents(open.db, "sess_events_corrupt", 1, 3, null, "event-private-sentinel");
        }
        if (corruption === "hole") {
          open.db
            .prepare("DELETE FROM selected_projected_events WHERE session_id = ? AND cursor = 2")
            .run("sess_events_corrupt");
        } else if (corruption === "boundary") {
          open.db.pragma("ignore_check_constraints = ON");
          open.db
            .prepare("UPDATE selected_session_projections SET retention_boundary_cursor = 0 WHERE session_id = ?")
            .run("sess_events_corrupt");
        } else if (corruption === "type") {
          open.db.pragma("ignore_check_constraints = ON");
          open.db
            .prepare("UPDATE selected_projected_events SET normalized_type = 'private_invalid' WHERE session_id = ? AND cursor = 1")
            .run("sess_events_corrupt");
        } else if (corruption === "unexpected_boundary") {
          open.db
            .prepare("UPDATE selected_projected_events SET normalized_type = 'replay_boundary' WHERE session_id = ? AND cursor = 1")
            .run("sess_events_corrupt");
        } else if (corruption === "duplicate_boundary") {
          open.db
            .prepare("UPDATE selected_projected_events SET normalized_type = 'replay_boundary' WHERE session_id = ? AND cursor = 6")
            .run("sess_events_corrupt");
        }
        expectRepositoryError(
          () => createSelectedSessionReadRepository(open.db).get("sess_events_corrupt"),
          "invalid_state"
        );
      } finally {
        open.db.close();
      }
    }
  });

  it("rejects hostile exact input cause-free and exposes an immutable receiver-independent port", () => {
    const open = openDatabase();
    const sentinel = "hostile-session-read-input";
    try {
      seedSession(open.db, { id: "sess_input_01" });
      const repository = createSelectedSessionReadRepository(open.db);
      expect(Object.isFrozen(repository)).toBe(true);
      expect(Object.keys(repository).sort()).toEqual(["get", "list"]);

      const detachedList = repository.list;
      const detachedGet = repository.get;
      expect(Reflect.apply(detachedList, { private: sentinel }, [firstPageInput(1)]).sessions).toHaveLength(1);
      expect(Reflect.apply(detachedGet, { private: sentinel }, ["sess_input_01"])?.session.id).toBe(
        "sess_input_01"
      );

      let reads = 0;
      const accessor = Object.defineProperty(
        { expected_order_snapshot: null, after: null },
        "limit",
        {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error(sentinel);
          }
        }
      );
      for (const candidate of [
        null,
        [],
        {},
        { limit: 1, expected_order_snapshot: null, after: null, extra: sentinel },
        { limit: 0, expected_order_snapshot: null, after: null },
        accessor,
        new Proxy(firstPageInput(1), {
          ownKeys() {
            throw new Error(sentinel);
          }
        })
      ]) {
        const error = expectRepositoryError(
          () => repository.list(candidate as never),
          "invalid_input"
        );
        expect(error.cause).toBeUndefined();
        expect(error.message).not.toContain(sentinel);
      }
      expect(reads).toBe(0);
      expectRepositoryError(() => repository.get("invalid"), "invalid_input");
      expectFrozenTree(repository.list(firstPageInput(1)));
      expectFrozenTree(repository.get("sess_input_01"));
    } finally {
      open.db.close();
    }
  });

  it("uses one read transaction, preserves its WAL snapshot, and never selects event JSON", () => {
    const path = databasePath();
    const migrated = openMigratedDatabase(path, { now: () => new Date(createdAt) });
    migrated.db.pragma("journal_mode = WAL");
    seedSession(migrated.db, { attention: "none", id: "sess_wal_01" });
    seedSession(migrated.db, { attention: "watch", id: "sess_wal_02" });
    migrated.db.close();

    const writer = new Database(path);
    const statements: string[] = [];
    let armed = false;
    let committed = false;
    const reader = new Database(path, {
      verbose(sql) {
        if (typeof sql !== "string") return;
        statements.push(sql);
        if (armed && !committed && sql.includes("WITH ordered_active AS")) {
          writer
            .prepare("UPDATE selected_session_projections SET attention = 'needs_approval' WHERE session_id = ?")
            .run("sess_wal_01");
          committed = true;
        }
      }
    });
    reader.pragma("journal_mode = WAL");
    try {
      const repository = createSelectedSessionReadRepository(reader);
      armed = true;
      const first = repository.list(firstPageInput(1));
      expect(committed).toBe(true);
      expect(first.sessions[0]?.session.id).toBe("sess_wal_02");
      expect(statements.filter((sql) => /^BEGIN\b/u.test(sql))).toHaveLength(1);
      expect(statements.filter((sql) => /^COMMIT\b/u.test(sql))).toHaveLength(1);
      expect(statements.join("\n")).not.toMatch(/\bevent_json\b/iu);
      expectRepositoryError(
        () => repository.list(nextPageInput(first, 1)),
        "session_list_changed"
      );
      expect(repository.list(firstPageInput(1)).sessions[0]?.session.id).toBe("sess_wal_01");
    } finally {
      reader.close();
      writer.close();
    }
  });

  it("survives restart and read-only access and sanitizes a closed-handle failure", () => {
    const path = databasePath();
    const writable = openMigratedDatabase(path, { now: () => new Date(createdAt) });
    seedSession(writable.db, { id: "sess_restart_01" });
    const closedRepository = createSelectedSessionReadRepository(writable.db);
    writable.db.close();
    const closedError = expectRepositoryError(
      () => closedRepository.list(firstPageInput(1)),
      "read_failed"
    );
    expect(closedError.cause).toBeUndefined();

    const readOnly = new Database(path, { fileMustExist: true, readonly: true });
    try {
      const repository = createSelectedSessionReadRepository(readOnly);
      expect(repository.get("sess_restart_01")?.session.id).toBe("sess_restart_01");
      expect(repository.list(firstPageInput(1)).sessions).toHaveLength(1);
    } finally {
      readOnly.close();
    }
  });
});

function openDatabase() {
  return openMigratedDatabase(databasePath(), { now: () => new Date(createdAt) });
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-session-read-"));
  tempDirs.push(directory);
  return join(directory, "hostdeck.db");
}

function firstPageInput(limit: number): SelectedSessionListInput {
  return selectedSessionListInputSchema.parse({
    after: null,
    expected_order_snapshot: null,
    limit
  });
}

function nextPageInput(page: SelectedSessionListPage, limit: number): SelectedSessionListInput {
  return selectedSessionListInputSchema.parse({
    after: page.next_after,
    expected_order_snapshot: page.order_snapshot,
    limit
  });
}

function seedSession(db: Database.Database, options: SeedSessionOptions): void {
  const archived = options.archived ?? false;
  const freshness = options.freshness ?? "current";
  const mappingUpdatedAt = archived ? archivedAt : activeUpdatedAt;
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'codex_app_server', '0.144.0', ?, ?, ?, ?)
    `
  ).run(
    options.id,
    options.id.slice(5),
    `thread-${options.id}`,
    options.cwd ?? "/workspace/hostdeck",
    options.disposition ?? "selected",
    createdAt,
    mappingUpdatedAt,
    archived ? archivedAt : null
  );
  db.prepare(
    `
      INSERT INTO selected_session_projections (
        session_id, session_state, turn_state, attention, freshness, freshness_reason,
        updated_at, last_activity_at, branch, model, settings_json, goal_json,
        recent_summary, last_event_cursor, retained_event_count, retained_event_bytes,
        earliest_retained_cursor, retention_boundary_cursor
      ) VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, 'main', 'gpt-5.5-codex', ?, ?, ?, NULL, 0, 0, NULL, NULL)
    `
  ).run(
    options.id,
    options.sessionState ?? (archived ? "archived" : "active"),
    options.attention ?? "none",
    freshness,
    freshness === "current" ? null : `Projection is ${freshness}.`,
    mappingUpdatedAt,
    options.lastActivityAt === undefined ? createdAt : options.lastActivityAt,
    JSON.stringify(
      options.settings ?? {
        collaboration_mode: "default",
        observed_at: createdAt,
        reasoning_effort: "high",
        runtime_model: "gpt-5.5-codex"
      }
    ),
    JSON.stringify(
      options.goal ?? {
        objective: "Complete the current HostDeck task.",
        state: "active"
      }
    ),
    options.recentSummary ?? "Bounded public summary."
  );
}

function seedBulkSessions(db: Database.Database, count: number): void {
  const insert = db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      seedSession(db, { id: `sess_bulk_${String(index).padStart(4, "0")}` });
    }
  });
  insert();
}

function seedEvents(
  db: Database.Database,
  sessionId: string,
  earliest: number,
  latest: number,
  boundary: number | null,
  privateSentinel: string
): void {
  const byteLength = 100;
  const insert = db.prepare(
    `
      INSERT INTO selected_projected_events (
        session_id, cursor, normalized_type, codex_event_id, codex_event_type,
        captured_at, content_state, byte_length, event_json
      ) VALUES (?, ?, ?, NULL, NULL, ?, 'complete', ?, ?)
    `
  );
  const transaction = db.transaction(() => {
    for (let cursor = earliest; cursor <= latest; cursor += 1) {
      insert.run(
        sessionId,
        cursor,
        cursor === earliest && boundary !== null ? "replay_boundary" : "message",
        activeUpdatedAt,
        byteLength,
        JSON.stringify({ private: privateSentinel, cursor })
      );
    }
    db.prepare(
      `
        UPDATE selected_session_projections SET
          last_event_cursor = ?,
          retained_event_count = ?,
          retained_event_bytes = ?,
          earliest_retained_cursor = ?,
          retention_boundary_cursor = ?
        WHERE session_id = ?
      `
    ).run(
      latest,
      latest - earliest + 1,
      (latest - earliest + 1) * byteLength,
      earliest,
      boundary,
      sessionId
    );
  });
  transaction();
}

function archiveSession(db: Database.Database, sessionId: string): void {
  const transaction = db.transaction(() => {
    db.prepare("UPDATE selected_sessions SET archived_at = ?, updated_at = ? WHERE id = ?").run(
      archivedAt,
      archivedAt,
      sessionId
    );
    db.prepare("UPDATE selected_session_projections SET session_state = 'archived', updated_at = ? WHERE session_id = ?").run(
      archivedAt,
      sessionId
    );
  });
  transaction();
}

function expectRepositoryError(
  operation: () => unknown,
  code: SelectedSessionReadRepositoryErrorCode
): HostDeckSelectedSessionReadRepositoryError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSelectedSessionReadRepositoryError);
    expect((error as HostDeckSelectedSessionReadRepositoryError).code).toBe(code);
    return error as HostDeckSelectedSessionReadRepositoryError;
  }
  throw new Error(`Expected selected session-read repository error ${code}.`);
}

function expectFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectFrozenTree(child);
}
