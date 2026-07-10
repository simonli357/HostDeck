import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexItemIdSchema, isoTimestampSchema } from "@hostdeck/contracts";
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
