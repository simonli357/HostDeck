import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexItemIdSchema,
  defaultRetentionPolicy,
  isoTimestampSchema,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createProductionProjectionAppendPort,
  HostDeckProjectionPublicationError,
  type ProductionProjectionAppendInput
} from "./projection-append-port.js";
import {
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  type SelectedSessionState,
  type SelectedStateRepositoryErrorCode,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "./selected-state-repository.js";

const tempDirs: string[] = [];
const createdAt = "2026-07-10T16:00:00.000Z";
const metadataAt = "2026-07-10T16:00:30.000Z";
const firstEventAt = "2026-07-10T16:01:00.000Z";
const secondEventAt = "2026-07-10T16:02:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("production projection append port", () => {
  it("requires an explicit post-commit publisher at composition", () => {
    expect(() => createProductionProjectionAppendPort({ repository: {} as never, publish: null as never })).toThrow(
      "selected-state repository"
    );
    expect(() =>
      createProductionProjectionAppendPort({
        repository: { appendEvent() {}, require() {} } as never,
        publish: null as never
      })
    ).toThrow("post-commit publisher");
    expect(() =>
      createProductionProjectionAppendPort({
        repository: { appendEvent() {}, require() {} } as never,
        publish() {},
        retention: { ...defaultRetentionPolicy, output_event_limit: 1 }
      })
    ).toThrow("at least two output-event slots");
  });

  it("prunes repeated count overflow inside append and publishes only post-retention state", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      let current = repository.create(stateCandidate());
      const publications: number[] = [];
      const port = createProductionProjectionAppendPort({
        repository,
        retention: retentionPolicy(3, 1_000_000),
        publish(committed) {
          const durable = repository.require(committed.event.event.session_id);
          const replay = repository.listEvents(committed.event.event.session_id);
          expect(durable.projection).toEqual(committed.projection);
          expect(replay.next_cursor).toBe(committed.event.event.cursor);
          expect(replay.events.at(-1)).toEqual(committed.event.event);
          publications.push(committed.event.event.cursor);
        }
      });

      for (let index = 1; index <= 5; index += 1) {
        await port.append(appendCandidate(current, `upstream-retention-count-${index}`, eventAt(index)));
        current = repository.require(current.mapping.id);
        if (index === 3) {
          expect(repository.listEvents(current.mapping.id)).toMatchObject({
            truncated: false,
            events: [{ cursor: 1 }, { cursor: 2 }, { cursor: 3 }]
          });
          expect(current.projection).toMatchObject({
            retained_event_count: 3,
            earliest_retained_cursor: 1,
            retention_boundary_cursor: null
          });
        }
      }

      expect(publications).toEqual([1, 2, 3, 4, 5]);
      expect(repository.listEvents(current.mapping.id)).toMatchObject({
        truncated: true,
        next_cursor: 5,
        events: [
          { type: "replay_boundary", cursor: 3, after: 2, next_cursor: 3, reason: "retention" },
          { type: "message", cursor: 4 },
          { type: "message", cursor: 5 }
        ]
      });
      expect(current.projection).toMatchObject({
        retained_event_count: 3,
        earliest_retained_cursor: 3,
        retention_boundary_cursor: 2,
        session: { last_event_cursor: 5 }
      });
      expect(
        open.db
          .prepare(
            "SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes, MIN(cursor) AS earliest, MAX(cursor) AS latest FROM selected_projected_events WHERE session_id = ?"
          )
          .get(current.mapping.id)
      ).toEqual({
        count: current.projection.retained_event_count,
        bytes: current.projection.retained_event_bytes,
        earliest: current.projection.earliest_retained_cursor,
        latest: current.projection.session.last_event_cursor
      });
    } finally {
      open.db.close();
    }
  });

  it("prunes by exact UTF-8 record bytes without discarding additional recent events", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      let current = repository.create(stateCandidate());
      const seedPort = createProductionProjectionAppendPort({
        repository,
        retention: retentionPolicy(10, 1_000_000),
        publish() {}
      });
      const first = appendCandidate(current, "upstream-retention-byte-fit-1", eventAt(1));
      await seedPort.append({
        ...first,
        event: { ...first.event, text: `Large older projection ${"界".repeat(1_000)}.` }
      } as ProductionProjectionAppendInput);
      current = repository.require(current.mapping.id);
      await seedPort.append(appendCandidate(current, "upstream-retention-byte-fit-2", eventAt(2)));
      current = repository.require(current.mapping.id);

      const priorEvents = repository.listEvents(current.mapping.id).events;
      const second = priorEvents[1];
      if (second === undefined) throw new Error("Expected the second seeded projection event.");
      const thirdInput = appendCandidate(current, "upstream-retention-byte-fit-3", eventAt(3));
      const third = selectedProjectionEventSchema.parse({
        ...thirdInput.event,
        session_id: current.mapping.id,
        cursor: 3
      });
      const boundary = selectedProjectionEventSchema.parse({
        session_id: current.mapping.id,
        cursor: 1,
        captured_at: second.captured_at,
        upstream_at: null,
        codex_event_id: null,
        codex_event_type: null,
        content_state: "complete",
        content_notice: null,
        type: "replay_boundary",
        after: 0,
        next_cursor: 1,
        reason: "retention"
      });
      const byteLimit =
        selectedProjectedEventByteLength(boundary) +
        selectedProjectedEventByteLength(second) +
        selectedProjectedEventByteLength(third);
      expect(current.projection.retained_event_bytes + selectedProjectedEventByteLength(third)).toBeGreaterThan(byteLimit);

      const port = createProductionProjectionAppendPort({
        repository,
        retention: retentionPolicy(10, byteLimit),
        publish() {}
      });
      await port.append(thirdInput);

      const committed = repository.require(current.mapping.id);
      expect(committed.projection.retained_event_bytes).toBe(byteLimit);
      expect(repository.listEvents(current.mapping.id).events).toMatchObject([
        { type: "replay_boundary", cursor: 1, after: 0, next_cursor: 1 },
        { type: "message", cursor: 2, codex_event_id: "upstream-retention-byte-fit-2" },
        { type: "message", cursor: 3, codex_event_id: "upstream-retention-byte-fit-3" }
      ]);
    } finally {
      open.db.close();
    }
  });

  it("measures UTF-8 bytes and retains the newest oversize event behind a monotonic boundary", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      let current = repository.create(stateCandidate());
      const port = createProductionProjectionAppendPort({
        repository,
        retention: retentionPolicy(10, 1),
        publish() {}
      });

      for (let index = 1; index <= 3; index += 1) {
        const candidate = appendCandidate(current, `upstream-retention-byte-${index}`, eventAt(index));
        const committed = await port.append({
          ...candidate,
          event: { ...candidate.event, text: `Projection ${"界".repeat(80)} ${index}.` }
        } as ProductionProjectionAppendInput);
        expect(committed.event.byte_length).toBeGreaterThan(JSON.stringify(committed.event.event).length);
        current = repository.require(current.mapping.id);
      }

      const replay = repository.listEvents(current.mapping.id);
      expect(replay.events).toMatchObject([
        { type: "replay_boundary", cursor: 2, after: 1, next_cursor: 2 },
        { type: "message", cursor: 3, codex_event_id: "upstream-retention-byte-3" }
      ]);
      expect(current.projection).toMatchObject({
        retained_event_count: 2,
        earliest_retained_cursor: 2,
        retention_boundary_cursor: 1,
        session: { last_event_cursor: 3 }
      });
      expect(current.projection.retained_event_bytes).toBeGreaterThan(1);
    } finally {
      open.db.close();
    }
  });

  it("restores deleted rows when boundary insertion fails and publishes nothing", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      let current = repository.create(stateCandidate());
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository,
        retention: retentionPolicy(3, 1_000_000),
        publish() {
          publications += 1;
        }
      });
      for (let index = 1; index <= 3; index += 1) {
        await port.append(appendCandidate(current, `upstream-retention-rollback-${index}`, eventAt(index)));
        current = repository.require(current.mapping.id);
      }
      open.db.exec(`
        CREATE TRIGGER force_selected_retention_boundary_failure
        BEFORE INSERT ON selected_projected_events
        WHEN NEW.normalized_type = 'replay_boundary'
        BEGIN
          SELECT RAISE(ABORT, 'forced selected retention boundary failure');
        END;
      `);

      await expectRepositoryRejection(
        port.append(appendCandidate(current, "upstream-retention-rollback-4", eventAt(4))),
        "projection_write_failed"
      );

      expect(publications).toBe(3);
      expect(repository.listEvents(current.mapping.id).events.map((event) => event.cursor)).toEqual([1, 2, 3]);
      expect(repository.require(current.mapping.id).projection).toEqual(current.projection);
      expect(
        open.db.prepare("SELECT COUNT(*) AS count FROM selected_projected_events WHERE codex_event_id = ?").get("upstream-retention-rollback-4")
      ).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });

  it("serializes concurrent retention-edge writers to one post-pruning publication", async () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const firstRepository = createSelectedStateRepository(first.db);
      const secondRepository = createSelectedStateRepository(second.db);
      let current = firstRepository.create(stateCandidate());
      const seedPort = createProductionProjectionAppendPort({
        repository: firstRepository,
        retention: retentionPolicy(3, 1_000_000),
        publish() {}
      });
      for (let index = 1; index <= 3; index += 1) {
        await seedPort.append(appendCandidate(current, `upstream-retention-race-seed-${index}`, eventAt(index)));
        current = firstRepository.require(current.mapping.id);
      }
      const concurrent = secondRepository.require(current.mapping.id);
      let publications = 0;
      const firstPort = createProductionProjectionAppendPort({
        repository: firstRepository,
        retention: retentionPolicy(3, 1_000_000),
        publish() {
          publications += 1;
        }
      });
      const secondPort = createProductionProjectionAppendPort({
        repository: secondRepository,
        retention: retentionPolicy(3, 1_000_000),
        publish() {
          publications += 1;
        }
      });

      const outcomes = await Promise.allSettled([
        firstPort.append(appendCandidate(current, "upstream-retention-race-a", eventAt(4))),
        secondPort.append(appendCandidate(concurrent, "upstream-retention-race-b", eventAt(4)))
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toMatchObject({ code: "projection_conflict" });
      }
      expect(publications).toBe(1);
      expect(firstRepository.listEvents(current.mapping.id).events).toMatchObject([
        { type: "replay_boundary", cursor: 2, after: 1 },
        { type: "message", cursor: 3 },
        { type: "message", cursor: 4 }
      ]);
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  it("preserves and advances retained boundaries across database reopen", async () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(first.db);
      let current = repository.create(stateCandidate());
      const port = createProductionProjectionAppendPort({
        repository,
        retention: retentionPolicy(3, 1_000_000),
        publish() {}
      });
      for (let index = 1; index <= 5; index += 1) {
        await port.append(appendCandidate(current, `upstream-retention-restart-${index}`, eventAt(index)));
        current = repository.require(current.mapping.id);
      }
      expect(current.projection).toMatchObject({ retention_boundary_cursor: 2, earliest_retained_cursor: 3 });
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(second.db);
      const current = repository.require("sess_projection_001");
      expect(repository.listEvents(current.mapping.id).events).toMatchObject([
        { type: "replay_boundary", cursor: 3, after: 2 },
        { type: "message", cursor: 4 },
        { type: "message", cursor: 5 }
      ]);
      const port = createProductionProjectionAppendPort({
        repository,
        retention: retentionPolicy(3, 1_000_000),
        publish() {}
      });
      await port.append(appendCandidate(current, "upstream-retention-restart-6", eventAt(6)));

      const advanced = repository.require(current.mapping.id);
      expect(advanced.projection).toMatchObject({
        retained_event_count: 3,
        retention_boundary_cursor: 3,
        earliest_retained_cursor: 4,
        session: { last_event_cursor: 6 }
      });
      expect(repository.listEvents(current.mapping.id).events).toMatchObject([
        { type: "replay_boundary", cursor: 4, after: 3 },
        { type: "message", cursor: 5 },
        { type: "message", cursor: 6 }
      ]);
    } finally {
      second.db.close();
    }
  });

  it("assigns storage fields and invokes the publisher only after durable commit", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      let observed: {
        readonly committed: boolean;
        readonly cursor: number;
        readonly revision_cursor: number | null;
      } | null = null;
      const port = createProductionProjectionAppendPort({
        repository,
        publish(committed) {
          const replay = repository.listEvents(current.mapping.id);
          const durable = repository.require(current.mapping.id);
          observed = {
            committed: replay.events.length === 1 && durable.projection.session.last_event_cursor === committed.event.event.cursor,
            cursor: committed.event.event.cursor,
            revision_cursor: committed.revision.last_event_cursor
          };
        }
      });

      expect(Object.isFrozen(port)).toBe(true);
      const committed = await port.append(appendCandidate(current, "upstream-event-001", firstEventAt));

      expect(observed).toEqual({ committed: true, cursor: 1, revision_cursor: 1 });
      expect(committed).toMatchObject({
        event: { event: { session_id: current.mapping.id, cursor: 1 }, byte_length: expect.any(Number) },
        projection: {
          retained_event_count: 1,
          retained_event_bytes: committed.event.byte_length,
          earliest_retained_cursor: 1,
          session: { last_event_cursor: 1 }
        },
        revision: {
          mapping_updated_at: createdAt,
          projection_updated_at: firstEventAt,
          last_event_cursor: 1
        }
      });
      expect(Object.isFrozen(committed)).toBe(true);
      expect(Object.isFrozen(committed.event.event)).toBe(true);
      expect(
        open.db
          .prepare("SELECT cursor, byte_length FROM selected_projected_events WHERE session_id = ?")
          .get(current.mapping.id)
      ).toEqual({ cursor: 1, byte_length: committed.event.byte_length });
    } finally {
      open.db.close();
    }
  });

  it("rejects caller-owned event addresses and projection cursors before persistence", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository,
        publish() {
          publications += 1;
        }
      });
      const candidate = appendCandidate(current, "upstream-event-addressed", firstEventAt);

      await expectRepositoryRejection(
        port.append({ ...candidate, event: { ...candidate.event, session_id: current.mapping.id, cursor: 91 } } as never),
        "invalid_event"
      );
      await expectRepositoryRejection(
        port.append({ ...candidate, event: { ...candidate.event, next_cursor: 91 } } as never),
        "invalid_event"
      );
      await expectRepositoryRejection(
        port.append({ ...candidate, event: { ...candidate.event, content_state: undefined } } as never),
        "invalid_event"
      );
      await expectRepositoryRejection(
        port.append({ ...candidate, next_session: { ...candidate.next_session, last_event_cursor: 91 } } as never),
        "invalid_projection"
      );
      expect(publications).toBe(0);
      expect(repository.listEvents(current.mapping.id).events).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("derives both cursor fields for a replay-boundary event", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository,
        publish() {
          publications += 1;
        }
      });

      const committed = await port.append(replayBoundaryCandidate(current));

      expect(committed.event.event).toMatchObject({ type: "replay_boundary", cursor: 1, next_cursor: 1, after: null });
      expect(publications).toBe(1);
      expect(repository.listEvents(current.mapping.id)).toMatchObject({
        truncated: true,
        next_cursor: 1,
        events: [{ type: "replay_boundary", cursor: 1, next_cursor: 1 }]
      });
    } finally {
      open.db.close();
    }
  });

  it("does not overwrite a concurrent metadata-only projection update", async () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(first.db);
      const concurrentRepository = createSelectedStateRepository(second.db);
      const stale = repository.create(stateCandidate());
      const concurrent = concurrentRepository.require(stale.mapping.id);
      concurrentRepository.replace(
        {
          mapping: { ...concurrent.mapping, name: "metadata-winner", updated_at: metadataAt },
          projection: {
            ...concurrent.projection,
            session: {
              ...concurrent.projection.session,
              name: "metadata-winner",
              model: "gpt-5.5-codex-updated",
              recent_summary: "Concurrent metadata committed.",
              updated_at: metadataAt
            }
          }
        },
        selectedStateRevision(concurrent)
      );
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository,
        publish() {
          publications += 1;
        }
      });

      await expectRepositoryRejection(port.append(appendCandidate(stale, "upstream-event-stale", firstEventAt)), "projection_conflict");

      expect(publications).toBe(0);
      expect(repository.require(stale.mapping.id)).toMatchObject({
        mapping: { name: "metadata-winner", updated_at: metadataAt },
        projection: { session: { name: "metadata-winner", model: "gpt-5.5-codex-updated", last_event_cursor: null } }
      });
      expect(repository.listEvents(stale.mapping.id).events).toEqual([]);
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  it("rechecks revision inside the transaction when metadata changes after preparation", async () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(first.db);
      const concurrentRepository = createSelectedStateRepository(second.db);
      const current = repository.create(stateCandidate());
      const concurrent = concurrentRepository.require(current.mapping.id);
      let raced = false;
      const racingRepository = {
        ...repository,
        appendEvent: (...args: Parameters<typeof repository.appendEvent>) => {
          if (!raced) {
            raced = true;
            concurrentRepository.replace(
              {
                mapping: { ...concurrent.mapping, name: "transaction-race-winner", updated_at: metadataAt },
                projection: {
                  ...concurrent.projection,
                  session: {
                    ...concurrent.projection.session,
                    name: "transaction-race-winner",
                    recent_summary: "Won immediately before append transaction.",
                    updated_at: metadataAt
                  }
                }
              },
              selectedStateRevision(concurrent)
            );
          }
          return repository.appendEvent(...args);
        }
      };
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository: racingRepository,
        publish() {
          publications += 1;
        }
      });

      await expectRepositoryRejection(
        port.append(appendCandidate(current, "upstream-event-transaction-race", firstEventAt)),
        "projection_conflict"
      );

      expect(raced).toBe(true);
      expect(publications).toBe(0);
      expect(repository.require(current.mapping.id)).toMatchObject({
        mapping: { name: "transaction-race-winner" },
        projection: { session: { name: "transaction-race-winner", last_event_cursor: null } }
      });
      expect(repository.listEvents(current.mapping.id).events).toEqual([]);
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  it("rolls back an inserted event when the projection update fails and publishes nothing", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      open.db.exec(`
        CREATE TRIGGER force_selected_projection_update_failure
        BEFORE UPDATE ON selected_session_projections
        BEGIN
          SELECT RAISE(ABORT, 'forced selected projection update failure');
        END;
      `);
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository,
        publish() {
          publications += 1;
        }
      });

      await expectRepositoryRejection(
        port.append(appendCandidate(current, "upstream-event-rollback", firstEventAt)),
        "projection_write_failed"
      );

      expect(publications).toBe(0);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM selected_projected_events").get()).toEqual({ count: 0 });
      expect(repository.require(current.mapping.id).projection).toMatchObject({
        retained_event_count: 0,
        retained_event_bytes: 0,
        session: { last_event_cursor: null }
      });
    } finally {
      open.db.close();
    }
  });

  it("rejects duplicate upstream identity without a second commit or publication", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository,
        publish() {
          publications += 1;
        }
      });
      await port.append(appendCandidate(current, "upstream-event-duplicate", firstEventAt));
      const committed = repository.require(current.mapping.id);

      await expectRepositoryRejection(
        port.append(appendCandidate(committed, "upstream-event-duplicate", secondEventAt)),
        "event_exists"
      );

      expect(publications).toBe(1);
      expect(repository.listEvents(current.mapping.id).events.map((event) => event.cursor)).toEqual([1]);
      expect(repository.require(current.mapping.id).projection).toMatchObject({
        retained_event_count: 1,
        session: { last_event_cursor: 1 }
      });
    } finally {
      open.db.close();
    }
  });

  it("rejects corrupt prior counters before commit or publication", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const current = repository.create(stateCandidate());
      open.db
        .prepare(
          `
            UPDATE selected_session_projections SET
              last_event_cursor = 1,
              retained_event_count = 1,
              retained_event_bytes = 42,
              earliest_retained_cursor = 1
            WHERE session_id = ?
          `
        )
        .run(current.mapping.id);
      const corrupt = repository.require(current.mapping.id);
      let publications = 0;
      const port = createProductionProjectionAppendPort({
        repository,
        publish() {
          publications += 1;
        }
      });

      await expectRepositoryRejection(port.append(appendCandidate(corrupt, "upstream-event-corrupt", secondEventAt)), "invalid_projection");

      expect(publications).toBe(0);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM selected_projected_events").get()).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });

  it.each(["throw", "reject"] as const)(
    "preserves committed truth and reports unknown publication when the publisher %s fails",
    async (failureMode) => {
      const path = tempDbPath();
      const first = openMigratedDatabase(path, { now: fixedNow });
      const marker = new Error(`publisher ${failureMode} marker`);
      let publications = 0;
      let committedError: HostDeckProjectionPublicationError | null = null;
      try {
        const repository = createSelectedStateRepository(first.db);
        const current = repository.create(stateCandidate());
        const port = createProductionProjectionAppendPort({
          repository,
          publish() {
            publications += 1;
            if (failureMode === "throw") throw marker;
            return Promise.reject(marker);
          }
        });

        committedError = await capturePublicationFailure(
          port.append(appendCandidate(current, `upstream-event-publisher-${failureMode}`, firstEventAt))
        );
        expect(committedError).toMatchObject({
          code: "publication_failed",
          durability: "committed",
          publication_outcome: "unknown",
          committed: { event: { event: { cursor: 1 } }, revision: { last_event_cursor: 1 } }
        });
        expect(committedError.cause).toBe(marker);
        expect(publications).toBe(1);
        expect(repository.listEvents(current.mapping.id).events).toHaveLength(1);

        const durable = repository.require(current.mapping.id);
        const retryPort = createProductionProjectionAppendPort({
          repository,
          publish() {
            publications += 1;
          }
        });
        await expectRepositoryRejection(
          retryPort.append(appendCandidate(durable, `upstream-event-publisher-${failureMode}`, secondEventAt)),
          "event_exists"
        );
        expect(publications).toBe(1);
      } finally {
        first.db.close();
      }

      const second = openMigratedDatabase(path, { now: fixedNow });
      try {
        const repository = createSelectedStateRepository(second.db);
        expect(repository.require("sess_projection_001").projection.session.last_event_cursor).toBe(1);
        expect(repository.listEvents("sess_projection_001").events).toHaveLength(1);
        expect(committedError?.committed.revision.last_event_cursor).toBe(1);
      } finally {
        second.db.close();
      }
    }
  );

  it("serializes concurrent writers to one durable and published winner", async () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const firstRepository = createSelectedStateRepository(first.db);
      const secondRepository = createSelectedStateRepository(second.db);
      const firstView = firstRepository.create(stateCandidate());
      const secondView = secondRepository.require(firstView.mapping.id);
      let firstPublications = 0;
      let secondPublications = 0;
      const firstPort = createProductionProjectionAppendPort({
        repository: firstRepository,
        publish() {
          firstPublications += 1;
        }
      });
      const secondPort = createProductionProjectionAppendPort({
        repository: secondRepository,
        publish() {
          secondPublications += 1;
        }
      });

      const outcomes = await Promise.allSettled([
        firstPort.append(appendCandidate(firstView, "upstream-event-writer-a", firstEventAt)),
        secondPort.append(appendCandidate(secondView, "upstream-event-writer-b", firstEventAt))
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(HostDeckSelectedStateRepositoryError);
        expect((rejected.reason as HostDeckSelectedStateRepositoryError).code).toBe("projection_conflict");
      }
      expect(firstPublications + secondPublications).toBe(1);
      expect(firstRepository.listEvents(firstView.mapping.id).events).toHaveLength(1);
      expect(firstRepository.require(firstView.mapping.id).projection).toMatchObject({
        retained_event_count: 1,
        session: { last_event_cursor: 1 }
      });
    } finally {
      second.db.close();
      first.db.close();
    }
  });
});

function appendCandidate(state: SelectedSessionState, eventId: string, capturedAt: string): ProductionProjectionAppendInput {
  const session = state.projection.session;
  const parsedCapturedAt = isoTimestampSchema.parse(capturedAt);
  return {
    session_id: state.mapping.id,
    expected_revision: selectedStateRevision(state),
    event: {
      captured_at: parsedCapturedAt,
      upstream_at: isoTimestampSchema.parse(createdAt),
      codex_event_id: eventId,
      codex_event_type: "item/agentMessage/delta",
      content_state: "complete",
      content_notice: null,
      type: "message",
      role: "agent",
      phase: "completed",
      item_id: codexItemIdSchema.parse(`item-${eventId}`),
      text: `Projection for ${eventId}.`
    },
    next_session: {
      id: session.id,
      name: session.name,
      codex_thread_id: session.codex_thread_id,
      cwd: session.cwd,
      runtime_source: session.runtime_source,
      runtime_version: session.runtime_version,
      created_at: session.created_at,
      archived_at: session.archived_at,
      session_state: session.session_state,
      turn_state: "in_progress",
      attention: "watch",
      freshness: session.freshness,
      freshness_reason: session.freshness_reason,
      updated_at: parsedCapturedAt,
      last_activity_at: parsedCapturedAt,
      branch: session.branch,
      model: session.model,
      goal: session.goal,
      recent_summary: `Projection for ${eventId}.`
    }
  };
}

function replayBoundaryCandidate(state: SelectedSessionState): ProductionProjectionAppendInput {
  const candidate = appendCandidate(state, "upstream-replay-boundary", firstEventAt);
  return {
    ...candidate,
    event: {
      captured_at: isoTimestampSchema.parse(firstEventAt),
      upstream_at: null,
      codex_event_id: "upstream-replay-boundary",
      codex_event_type: null,
      content_state: "complete",
      content_notice: null,
      type: "replay_boundary",
      after: null,
      reason: "disconnect"
    }
  };
}

function retentionPolicy(outputEventLimit: number, outputByteLimit: number) {
  return {
    ...defaultRetentionPolicy,
    output_event_limit: outputEventLimit,
    output_byte_limit: outputByteLimit
  };
}

function eventAt(index: number): string {
  return new Date(Date.parse(firstEventAt) + (index - 1) * 60_000).toISOString();
}

function stateCandidate() {
  const mapping = {
    id: "sess_projection_001",
    name: "projection-session",
    codex_thread_id: "thread-projection-001",
    cwd: "/home/simonli/work/projection-session",
    runtime_source: "codex_app_server" as const,
    runtime_version: "0.144.0",
    disposition: "selected" as const,
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null
  };
  return {
    mapping,
    projection: {
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
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
        goal: null,
        recent_summary: "Projection session created.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

async function expectRepositoryRejection(
  promise: Promise<unknown>,
  code: SelectedStateRepositoryErrorCode
): Promise<HostDeckSelectedStateRepositoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSelectedStateRepositoryError);
    expect((error as HostDeckSelectedStateRepositoryError).code).toBe(code);
    return error as HostDeckSelectedStateRepositoryError;
  }
  throw new Error(`Expected HostDeckSelectedStateRepositoryError ${code}.`);
}

async function capturePublicationFailure(promise: Promise<unknown>): Promise<HostDeckProjectionPublicationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckProjectionPublicationError);
    return error as HostDeckProjectionPublicationError;
  }
  throw new Error("Expected HostDeckProjectionPublicationError.");
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-projection-append-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(createdAt);
}
