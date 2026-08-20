import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SelectedProjectedEventRecord,
  selectedProjectionEventSchema,
  selectedSessionListInputSchema
} from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import { createSelectedSessionReadRepository } from "./selected-session-read-repository.js";
import {
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  type SelectedSessionState,
  type SelectedStateRepositoryErrorCode,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "./selected-state-repository.js";

const tempDirs: string[] = [];
const createdAt = "2026-07-09T20:00:00.000Z";
const updatedAt = "2026-07-09T20:01:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected session state repository", () => {
  it("atomically adopts bounded native history and reloads immutable membership", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const adopted = nativeAdoptionCandidate();
    try {
      const repository = createSelectedStateRepository(first.db);
      expect(repository.adopt(adopted)).toEqual(adopted.state);
      expect(repository.getNativeMembership(adopted.state.mapping.id)).toEqual(adopted.membership);
      expect(repository.listNativeMemberships()).toEqual([adopted.membership]);
      expect(repository.listEvents(adopted.state.mapping.id)).toMatchObject({
        truncated: true,
        next_cursor: 3,
        events: [
          { type: "replay_boundary", reason: "adoption", cursor: 1 },
          { type: "message", role: "agent", cursor: 2 },
          { type: "turn", state: "completed", cursor: 3 }
        ]
      });
      const publicRead = createSelectedSessionReadRepository(first.db);
      expect(
        publicRead.list(
          selectedSessionListInputSchema.parse({
            after: null,
            expected_order_snapshot: null,
            limit: 10
          })
        )
      ).toMatchObject({
        sessions: [
          {
            event_window: {
              boundary_cursor: null,
              earliest_retained_cursor: 1,
              retained_event_count: 3,
              state: "contiguous"
            },
            session: {
              id: adopted.state.mapping.id,
              codex_thread_id: adopted.state.mapping.codex_thread_id
            }
          }
        ]
      });
      expect(publicRead.get(adopted.state.mapping.id)).toMatchObject({
        event_window: {
          boundary_cursor: null,
          earliest_retained_cursor: 1,
          retained_event_count: 3,
          state: "contiguous"
        }
      });
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(second.db);
      expect(repository.require(adopted.state.mapping.id)).toEqual(adopted.state);
      expect(repository.getNativeMembership(adopted.state.mapping.id)).toEqual(adopted.membership);
      expect(() =>
        second.db
          .prepare("UPDATE selected_native_session_memberships SET adopted_at = ? WHERE session_id = ?")
          .run(updatedAt, adopted.state.mapping.id)
      ).toThrow("native session membership is immutable");
    } finally {
      second.db.close();
    }
  });

  it("rolls back every adopted-session row when bounded history is invalid or a duplicate conflicts", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const adoption = nativeAdoptionCandidate();
      const invalidEvents = adoption.events.map((record, index) =>
        index === 2
          ? {
              ...record,
              event: { ...record.event, cursor: 4 }
            }
          : record
      );
      expectRepositoryError(() => repository.adopt({ ...adoption, events: invalidEvents }), "cursor_not_monotonic");
      expect(repository.list()).toEqual([]);
      expect(rawSelectedCounts(open.db)).toEqual({ events: 0, memberships: 0, projections: 0, sessions: 0 });

      open.db.exec(`
        CREATE TRIGGER force_native_adoption_event_failure
        BEFORE INSERT ON selected_projected_events
        WHEN NEW.cursor = 3
        BEGIN
          SELECT RAISE(ABORT, 'forced native adoption event failure');
        END;
      `);
      expectRepositoryError(() => repository.adopt(adoption), "projection_write_failed");
      expect(rawSelectedCounts(open.db)).toEqual({ events: 0, memberships: 0, projections: 0, sessions: 0 });
      open.db.exec("DROP TRIGGER force_native_adoption_event_failure");

      repository.create(stateCandidate());
      const duplicate = nativeAdoptionCandidate({ id: "sess_adopted_002", name: "selected-session" });
      expectRepositoryError(() => repository.adopt(duplicate), "duplicate_session_name");
      expect(repository.getNativeMembership(duplicate.state.mapping.id)).toBeNull();
      expect(rawSelectedCounts(open.db)).toEqual({ events: 0, memberships: 0, projections: 1, sessions: 1 });
    } finally {
      open.db.close();
    }
  });

  it("unmanages only a quiet adopted session and cascades HostDeck-owned state", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const adoption = nativeAdoptionCandidate();
      const adopted = repository.adopt(adoption);
      const activeAt = "2026-07-09T20:02:00.000Z";
      const quietAt = "2026-07-09T20:03:00.000Z";
      const active = {
        ...adopted,
        mapping: { ...adopted.mapping, updated_at: activeAt },
        projection: {
          ...adopted.projection,
          session: {
            ...adopted.projection.session,
            turn_state: "in_progress" as const,
            attention: "watch" as const,
            updated_at: activeAt
          }
        }
      };
      const activeState = repository.replace(active, selectedStateRevision(adopted));
      expectRepositoryError(
        () => repository.unmanageAdopted(activeState.mapping.id, selectedStateRevision(activeState)),
        "session_not_quiet"
      );
      expect(rawSelectedCounts(open.db)).toEqual({ events: 3, memberships: 1, projections: 1, sessions: 1 });

      const quiet = {
        ...activeState,
        mapping: { ...activeState.mapping, updated_at: quietAt },
        projection: {
          ...activeState.projection,
          session: {
            ...activeState.projection.session,
            turn_state: "completed" as const,
            attention: "none" as const,
            updated_at: quietAt
          }
        }
      };
      const quietState = repository.replace(quiet, selectedStateRevision(activeState));
      expect(repository.unmanageAdopted(quietState.mapping.id, selectedStateRevision(quietState))).toEqual({
        membership: adoption.membership,
        state: quietState
      });
      expect(rawSelectedCounts(open.db)).toEqual({ events: 0, memberships: 0, projections: 0, sessions: 0 });

      const ordinary = repository.create(stateCandidate());
      expectRepositoryError(
        () => repository.unmanageAdopted(ordinary.mapping.id, selectedStateRevision(ordinary)),
        "session_not_adopted"
      );
      expect(repository.require(ordinary.mapping.id)).toEqual(ordinary);
    } finally {
      open.db.close();
    }
  });

  it("creates, replaces, lists, and reloads a stable Codex thread mapping", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });

    try {
      const repository = createSelectedStateRepository(first.db);
      const created = repository.create(stateCandidate());
      expect(created.mapping.codex_thread_id).toBe("thread-selected-001");
      expect(repository.getByThreadId("thread-selected-001")?.mapping.id).toBe("sess_selected_001");

      const renamed = repository.replace(
        {
          mapping: {
            ...created.mapping,
            name: "selected-renamed",
            updated_at: updatedAt
          },
          projection: {
            ...created.projection,
            session: {
              ...created.projection.session,
              name: "selected-renamed",
              updated_at: updatedAt,
              recent_summary: "Renamed without changing runtime identity."
            }
          }
        },
        selectedStateRevision(created)
      );
      expect(renamed.mapping.name).toBe("selected-renamed");
      expectRepositoryError(
        () => repository.replace(created, selectedStateRevision(created)),
        "projection_conflict"
      );
      expectRepositoryError(
        () =>
          repository.replace(
            {
              ...renamed,
              projection: {
                ...renamed.projection,
                session: { ...renamed.projection.session, last_event_cursor: 1 },
                retained_event_count: 1,
                retained_event_bytes: 1,
                earliest_retained_cursor: 1
              }
            },
            selectedStateRevision(renamed)
          ),
        "projection_conflict"
      );
      expect(repository.list().map((state) => state.mapping.id)).toEqual(["sess_selected_001"]);
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(createSelectedStateRepository(second.db).require("sess_selected_001")).toMatchObject({
        mapping: {
          name: "selected-renamed",
          codex_thread_id: "thread-selected-001"
        },
        projection: {
          session: {
            recent_summary: "Renamed without changing runtime identity."
          }
        }
      });
    } finally {
      second.db.close();
    }
  });

  it("rejects duplicate names, duplicate thread ids, and thread identity replacement", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const created = repository.create(stateCandidate());
      expectRepositoryError(() => repository.create({ ...stateCandidate({ id: "sess_selected_004" }), extra: true }), "invalid_mapping");

      expectRepositoryError(
        () => repository.create(stateCandidate({ id: "sess_selected_002", threadId: "thread-selected-002" })),
        "duplicate_session_name"
      );
      expectRepositoryError(
        () => repository.create(stateCandidate({ id: "sess_selected_003", name: "selected-three" })),
        "duplicate_thread_id"
      );
      expectRepositoryError(
        () =>
          repository.replace(
            {
              mapping: { ...created.mapping, codex_thread_id: "thread-replacement" },
              projection: {
                ...created.projection,
                session: { ...created.projection.session, codex_thread_id: "thread-replacement" }
              }
            },
            selectedStateRevision(created)
          ),
        "identity_mismatch"
      );
      const archived = repository.replace(
        {
          mapping: { ...created.mapping, archived_at: updatedAt, updated_at: updatedAt },
          projection: {
            ...created.projection,
            session: {
              ...created.projection.session,
              session_state: "archived",
              turn_state: "idle",
              archived_at: updatedAt,
              updated_at: updatedAt
            }
          }
        },
        selectedStateRevision(created)
      );
      expectRepositoryError(
        () =>
          repository.replace(
            {
              mapping: { ...archived.mapping, archived_at: null },
              projection: {
                ...archived.projection,
                session: { ...archived.projection.session, session_state: "active", archived_at: null }
              }
            },
            selectedStateRevision(archived)
          ),
        "identity_mismatch"
      );
      expect(repository.require("sess_selected_001").mapping.codex_thread_id).toBe("thread-selected-001");
    } finally {
      open.db.close();
    }
  });

  it("fails loudly when persisted selected mapping data violates its contract", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate());
      open.db.prepare("UPDATE selected_sessions SET runtime_version = 'not-a-version' WHERE id = 'sess_selected_001'").run();

      expectRepositoryError(() => repository.require("sess_selected_001"), "invalid_mapping");
    } finally {
      open.db.close();
    }
  });

  it("rejects impossible selected session chronology before write", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const candidate = stateCandidate();
      expectRepositoryError(
        () =>
          repository.create({
            mapping: { ...candidate.mapping, updated_at: "2026-07-09T19:59:59.999Z" },
            projection: candidate.projection
          }),
        "invalid_projection"
      );
      const nonEmpty = stateCandidate({ id: "sess_selected_002", name: "selected-two", threadId: "thread-selected-002" });
      expectRepositoryError(
        () =>
          repository.create({
            ...nonEmpty,
            projection: {
              ...nonEmpty.projection,
              session: { ...nonEmpty.projection.session, last_event_cursor: 1 },
              retained_event_count: 1,
              retained_event_bytes: 100,
              earliest_retained_cursor: 1
            }
          }),
        "invalid_projection"
      );
      expect(repository.list()).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("exposes every post-migration tmux row only as an explicit legacy disposition", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      open.db
        .prepare(
          `
            INSERT INTO sessions (
              id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
              lifecycle_state, created_at, updated_at, stale_reason
            ) VALUES (?, ?, ?, 'tmux', ?, NULL, ?, 'running', ?, ?, NULL)
          `
        )
        .run(
          "sess_legacy_010",
          "legacy-ten",
          "/home/simonli/work/legacy-ten",
          "hostdeck-legacy-ten",
          "%10",
          createdAt,
          updatedAt
        );
      const repository = createSelectedStateRepository(open.db);

      expect(repository.list()).toEqual([]);
      expect(repository.getLegacyDisposition("sess_legacy_010")).toMatchObject({
        id: "sess_legacy_010",
        disposition: "legacy_unmigrated"
      });
      expect(repository.listLegacyDispositions()).toHaveLength(1);
    } finally {
      open.db.close();
    }
  });
});

describe("selected projected event repository", () => {
  it("commits one event and its projection advancement atomically across restart", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    let expectedBytes = 0;

    try {
      const repository = createSelectedStateRepository(first.db);
      const current = repository.create(stateCandidate());
      expectRepositoryError(() => repository.listEvents(current.mapping.id, { after: 1 }), "invalid_replay");
      const record = messageEventRecord(current, 1, "event-message-001");
      expectedBytes = record.byte_length;
      const result = repository.appendEvent(record, advancedProjection(current, record), selectedStateRevision(current));

      expect(result.projection).toMatchObject({
        retained_event_count: 1,
        retained_event_bytes: expectedBytes,
        earliest_retained_cursor: 1,
        session: { last_event_cursor: 1 }
      });
      expect(repository.listEvents(current.mapping.id)).toMatchObject({
        session_id: current.mapping.id,
        next_cursor: 1,
        truncated: false,
        events: [{ type: "message", cursor: 1 }]
      });
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(second.db);
      expect(repository.require("sess_selected_001").projection).toMatchObject({
        retained_event_count: 1,
        retained_event_bytes: expectedBytes,
        session: { last_event_cursor: 1 }
      });
      expect(repository.listEvents("sess_selected_001").events).toHaveLength(1);
    } finally {
      second.db.close();
    }
  });

  it("rejects impossible projection chronology before appending any event state", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      const record = messageEventRecord(current, 1, "event-invalid-chronology");
      const nextProjection = advancedProjection(current, record);

      expectRepositoryError(
        () =>
          repository.appendEvent(
            record,
            {
              ...nextProjection,
              session: {
                ...nextProjection.session,
                last_activity_at: "2026-07-09T19:59:59.999Z"
              }
            },
            selectedStateRevision(current)
          ),
        "invalid_projection"
      );
      expect(repository.require(current.mapping.id)).toEqual(current);
      expect(repository.listEvents(current.mapping.id).events).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("rejects impossible continuity chronology before replacing retained history", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const initial = repository.create(stateCandidate());
      const first = messageEventRecord(initial, 1, "event-before-invalid-boundary");
      repository.appendEvent(first, advancedProjection(initial, first), selectedStateRevision(initial));
      const current = repository.require(initial.mapping.id);
      const before = repository.listEvents(initial.mapping.id);
      const candidate = replayBoundaryRecord(current, 2, 1);
      const event = selectedProjectionEventSchema.parse({ ...candidate.event, reason: "restart" });
      const boundary = { event, byte_length: selectedProjectedEventByteLength(event) };

      expectRepositoryError(
        () =>
          repository.replaceEventsWithBoundary(
            boundary,
            {
              ...current.projection,
              session: {
                ...current.projection.session,
                updated_at: updatedAt,
                last_activity_at: "2026-07-09T19:59:59.999Z",
                last_event_cursor: 2
              },
              retained_event_count: 1,
              retained_event_bytes: boundary.byte_length,
              earliest_retained_cursor: 2,
              retention_boundary_cursor: 1
            },
            selectedStateRevision(current)
          ),
        "invalid_projection"
      );
      expect(repository.require(current.mapping.id)).toEqual(current);
      expect(repository.listEvents(current.mapping.id)).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("rejects stale projection writers and duplicate upstream events without partial commits", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    const concurrent = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const concurrentRepository = createSelectedStateRepository(concurrent.db);
      const initial = repository.create(stateCandidate());
      const concurrentView = concurrentRepository.require(initial.mapping.id);
      const firstRecord = messageEventRecord(initial, 1, "event-shared-001");
      const staleSecondRecord = messageEventRecord(concurrentView, 2, "event-stale-002");
      const staleProjection = advancedProjection(concurrentView, staleSecondRecord);
      repository.appendEvent(firstRecord, advancedProjection(initial, firstRecord), selectedStateRevision(initial));

      expectRepositoryError(
        () => concurrentRepository.appendEvent(staleSecondRecord, staleProjection, selectedStateRevision(concurrentView)),
        "projection_conflict"
      );
      expect(repository.listEvents(initial.mapping.id).events.map((event) => event.cursor)).toEqual([1]);

      const committed = repository.require(initial.mapping.id);
      const skippedCursor = messageEventRecord(committed, 3, "event-skipped-003");
      expectRepositoryError(
        () => repository.appendEvent(skippedCursor, advancedProjection(committed, skippedCursor), selectedStateRevision(committed)),
        "cursor_not_monotonic"
      );
      const duplicateUpstream = messageEventRecord(committed, 2, "event-shared-001");
      expectRepositoryError(
        () => repository.appendEvent(duplicateUpstream, advancedProjection(committed, duplicateUpstream), selectedStateRevision(committed)),
        "event_exists"
      );
      expect(repository.require(initial.mapping.id).projection).toMatchObject({
        retained_event_count: 1,
        session: { last_event_cursor: 1 }
      });
      expect(repository.listEvents(initial.mapping.id).events).toHaveLength(1);
    } finally {
      concurrent.db.close();
      open.db.close();
    }
  });

  it("rejects replacement changes that do not advance durable revision timestamps", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      expectRepositoryError(
        () =>
          repository.replace(
            {
              mapping: { ...current.mapping, name: "same-revision-name" },
              projection: {
                ...current.projection,
                session: { ...current.projection.session, name: "same-revision-name" }
              }
            },
            selectedStateRevision(current)
          ),
        "projection_conflict"
      );
      expect(repository.require(current.mapping.id).mapping.name).toBe(current.mapping.name);
    } finally {
      open.db.close();
    }
  });

  it("persists an explicit replay boundary and validates replay cursors", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      const record = replayBoundaryRecord(current, 1, 0);
      repository.appendEvent(
        record,
        advancedProjection(current, record, { retentionBoundaryCursor: 0 }),
        selectedStateRevision(current)
      );

      expect(repository.listEvents(current.mapping.id)).toMatchObject({
        truncated: true,
        next_cursor: 1,
        events: [{ type: "replay_boundary", cursor: 1, after: 0 }]
      });
      expect(repository.listEvents(current.mapping.id, { after: 1 })).toMatchObject({
        truncated: false,
        next_cursor: 1,
        events: []
      });
      expectRepositoryError(() => repository.listEvents(current.mapping.id, { after: 2 }), "invalid_replay");
    } finally {
      open.db.close();
    }
  });

  it("persists a replay boundary when the prior cursor is unknown", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      const record = replayBoundaryRecord(current, 1, null);
      repository.appendEvent(
        record,
        advancedProjection(current, record, { retentionBoundaryCursor: null }),
        selectedStateRevision(current)
      );

      expect(repository.listEvents(current.mapping.id)).toMatchObject({
        truncated: true,
        events: [{ type: "replay_boundary", after: null, next_cursor: 1 }]
      });
    } finally {
      open.db.close();
    }
  });

  it("rejects events captured before their selected session existed", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      const candidate = messageEventRecord(current, 1, "event-too-early");
      const event = selectedProjectionEventSchema.parse({ ...candidate.event, captured_at: "2026-07-09T19:59:59.999Z" });
      const record = { event, byte_length: selectedProjectedEventByteLength(event) };

      expectRepositoryError(
        () => repository.appendEvent(record, advancedProjection(current, record), selectedStateRevision(current)),
        "invalid_event"
      );
      expect(repository.listEvents(current.mapping.id).events).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("rejects event column/JSON drift on reload", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      const record = messageEventRecord(current, 1, "event-message-001");
      repository.appendEvent(record, advancedProjection(current, record), selectedStateRevision(current));
      open.db.prepare("UPDATE selected_projected_events SET normalized_type = 'turn' WHERE session_id = ? AND cursor = 1").run(current.mapping.id);

      expectRepositoryError(() => repository.listEvents(current.mapping.id), "invalid_event");
      open.db.prepare("DELETE FROM selected_projected_events WHERE session_id = ?").run(current.mapping.id);
      expectRepositoryError(() => repository.listEvents(current.mapping.id), "invalid_projection");
    } finally {
      open.db.close();
    }
  });

  it("rejects persisted event counters that contradict retained rows", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      const record = messageEventRecord(current, 1, "event-message-001");
      repository.appendEvent(record, advancedProjection(current, record), selectedStateRevision(current));
      open.db
        .prepare("UPDATE selected_session_projections SET retained_event_count = 2 WHERE session_id = ?")
        .run(current.mapping.id);

      expectRepositoryError(() => repository.listEvents(current.mapping.id), "invalid_projection");
    } finally {
      open.db.close();
    }
  });
});

describe("selected session-start recovery repository", () => {
  it("persists explicit reserve, thread-created, and persisted transitions", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(first.db);
      const reserved = recoveryRecord();
      repository.putRecovery(reserved);
      const threadCreated = repository.putRecovery({
        ...reserved,
        codex_thread_id: "thread-selected-001",
        state: "thread_created",
        updated_at: updatedAt
      });
      repository.create(stateCandidate());
      expect(
        repository.putRecovery({
          ...threadCreated,
          state: "persisted",
          updated_at: "2026-07-09T20:02:00.000Z"
        }).state
      ).toBe("persisted");
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(second.db);
      expect(repository.getRecovery("op_recovery_0001")).toMatchObject({
        session_id: "sess_selected_001",
        codex_thread_id: "thread-selected-001",
        state: "persisted"
      });
      expect(repository.deleteRecovery("op_recovery_0001")).toBe(true);
      expect(repository.getRecovery("op_recovery_0001")).toBeNull();
    } finally {
      second.db.close();
    }
  });

  it("rejects skipped, reversed, or conflicting recovery identity", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      expectRepositoryError(
        () => repository.putRecovery({ ...recoveryRecord(), codex_thread_id: "thread-selected-001", state: "thread_created" }),
        "recovery_conflict"
      );

      const reserved = repository.putRecovery(recoveryRecord());
      const threadCreated = repository.putRecovery({
        ...reserved,
        codex_thread_id: "thread-selected-001",
        state: "thread_created",
        updated_at: updatedAt
      });
      expectRepositoryError(
        () =>
          repository.putRecovery({
            ...threadCreated,
            state: "persisted",
            updated_at: "2026-07-09T20:02:00.000Z"
          }),
        "recovery_conflict"
      );
      expectRepositoryError(() => repository.putRecovery(reserved), "recovery_conflict");
      expectRepositoryError(
        () => repository.putRecovery({ ...recoveryRecord(), operation_id: "op_recovery_0002" }),
        "recovery_conflict"
      );
      expectRepositoryError(
        () =>
          repository.putRecovery({
            ...recoveryRecord(),
            operation_id: "op_recovery_0003",
            session_id: "sess_selected_003"
          }),
        "recovery_conflict"
      );
    } finally {
      open.db.close();
    }
  });
});

function stateCandidate(input: { readonly id?: string; readonly name?: string; readonly threadId?: string } = {}) {
  const id = input.id ?? "sess_selected_001";
  const name = input.name ?? "selected-session";
  const threadId = input.threadId ?? "thread-selected-001";
  const mapping = {
    id,
    name,
    codex_thread_id: threadId,
    cwd: "/home/simonli/work/selected-session",
    runtime_source: "codex_app_server",
    runtime_version: "0.148.0",
    disposition: "selected",
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null
  };
  return {
    mapping,
    projection: {
      session: {
        id,
        name,
        codex_thread_id: threadId,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: createdAt,
        last_activity_at: null,
        branch: "main",
        model: "gpt-5.5-codex",
        settings: null,
        goal: null,
        recent_summary: "Selected session created.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function nativeAdoptionCandidate(
  input: { readonly id?: string; readonly name?: string; readonly threadId?: string } = {}
) {
  const empty = stateCandidate({
    id: input.id ?? "sess_adopted_001",
    name: input.name ?? "adopted-session",
    threadId: input.threadId ?? "thread-native-001"
  });
  const membership = {
    session_id: empty.mapping.id,
    codex_thread_id: empty.mapping.codex_thread_id,
    origin: "adopted" as const,
    adopted_at: updatedAt,
    handoff_confirmed_at: updatedAt
  };
  const boundaryEvent = selectedProjectionEventSchema.parse({
    session_id: empty.mapping.id,
    cursor: 1,
    captured_at: updatedAt,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after: null,
    next_cursor: 1,
    reason: "adoption"
  });
  const messageEvent = selectedProjectionEventSchema.parse({
    session_id: empty.mapping.id,
    cursor: 2,
    captured_at: updatedAt,
    upstream_at: createdAt,
    codex_event_id: "native:item:agent-001",
    codex_event_type: "native_history/agent_message",
    content_state: "complete",
    content_notice: null,
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: "item-agent-001",
    text: "Bounded native history."
  });
  const turnEvent = selectedProjectionEventSchema.parse({
    session_id: empty.mapping.id,
    cursor: 3,
    captured_at: updatedAt,
    upstream_at: updatedAt,
    codex_event_id: "native:turn:turn-native-001",
    codex_event_type: "native_history/turn",
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: "turn-native-001",
    state: "completed",
    error: null
  });
  const events = [boundaryEvent, messageEvent, turnEvent].map((event) => ({
    event,
    byte_length: selectedProjectedEventByteLength(event)
  }));
  const retainedBytes = events.reduce((total, event) => total + event.byte_length, 0);
  const state = {
    mapping: { ...empty.mapping, updated_at: updatedAt },
    projection: {
      ...empty.projection,
      session: {
        ...empty.projection.session,
        updated_at: updatedAt,
        last_activity_at: updatedAt,
        recent_summary: "Bounded native history.",
        last_event_cursor: 3
      },
      retained_event_count: 3,
      retained_event_bytes: retainedBytes,
      earliest_retained_cursor: 1,
      retention_boundary_cursor: null
    }
  };
  return { events, membership, state };
}

function rawSelectedCounts(db: import("better-sqlite3").Database) {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: number }).count;
  return {
    events: count("selected_projected_events"),
    memberships: count("selected_native_session_memberships"),
    projections: count("selected_session_projections"),
    sessions: count("selected_sessions")
  };
}

function messageEventRecord(state: SelectedSessionState, cursor: number, eventId: string) {
  const event = selectedProjectionEventSchema.parse({
    session_id: state.mapping.id,
    cursor,
    captured_at: updatedAt,
    upstream_at: createdAt,
    codex_event_id: eventId,
    codex_event_type: "item/agentMessage/delta",
    content_state: "complete",
    content_notice: null,
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: `item-message-${cursor}`,
    text: `Selected event ${cursor}.`
  });
  return { event, byte_length: selectedProjectedEventByteLength(event) };
}

function replayBoundaryRecord(state: SelectedSessionState, cursor: number, after: number | null) {
  const event = selectedProjectionEventSchema.parse({
    session_id: state.mapping.id,
    cursor,
    captured_at: updatedAt,
    upstream_at: null,
    codex_event_id: `boundary-${cursor}`,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason: "retention"
  });
  return { event, byte_length: selectedProjectedEventByteLength(event) };
}

function advancedProjection(
  state: SelectedSessionState,
  record: SelectedProjectedEventRecord,
  options: { readonly retentionBoundaryCursor?: number | null } = {}
) {
  return {
    ...state.projection,
    session: {
      ...state.projection.session,
      updated_at: updatedAt,
      last_activity_at: updatedAt,
      recent_summary: record.event.type === "message" ? record.event.text : "Earlier events are outside retained projection.",
      last_event_cursor: record.event.cursor
    },
    retained_event_count: state.projection.retained_event_count + 1,
    retained_event_bytes: state.projection.retained_event_bytes + record.byte_length,
    earliest_retained_cursor: state.projection.earliest_retained_cursor ?? record.event.cursor,
    retention_boundary_cursor: options.retentionBoundaryCursor ?? state.projection.retention_boundary_cursor
  };
}

function recoveryRecord() {
  return {
    operation_id: "op_recovery_0001",
    session_id: "sess_selected_001",
    name: "selected-session",
    cwd: "/home/simonli/work/selected-session",
    codex_thread_id: null,
    state: "reserved",
    created_at: createdAt,
    updated_at: createdAt,
    error_code: null,
    error_message: null
  };
}

function expectRepositoryError(fn: () => unknown, code: SelectedStateRepositoryErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSelectedStateRepositoryError);
    expect((error as HostDeckSelectedStateRepositoryError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostDeckSelectedStateRepositoryError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-selected-state-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(createdAt);
}
