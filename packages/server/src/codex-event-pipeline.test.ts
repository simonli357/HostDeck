import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexConnectionNotification } from "@hostdeck/codex-adapter";
import {
  createProductionProjectionAppendPort,
  createSelectedStateRepository,
  HostDeckProjectionPublicationError,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexEventPipeline, HostDeckCodexEventPipelineError } from "./codex-event-pipeline.js";

const tempDirs: string[] = [];
const createdAt = "2026-07-10T18:00:00.000Z";
const threadA = "thread-pipeline-a";
const threadB = "thread-pipeline-b";
const archivedThread = "thread-pipeline-archived";
const turnA = "turn-pipeline-a";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("ordered Codex event pipeline", () => {
  it("drains work enqueued while the barrier is pending and aborts a waiter without stopping the pipeline", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const publicationGate = deferred<void>();
      const publisherEntered = deferred<void>();
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({
          repository,
          async publish(committed) {
            if (committed.event.event.cursor === 1) {
              publisherEntered.resolve();
              await publicationGate.promise;
            }
          }
        }),
        normalizer: { now: advancingClock() }
      });

      const first = pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }));
      await publisherEntered.promise;
      const barrier = pipeline.barrier();
      const second = pipeline.consume(selected("turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") }));
      const abort = new AbortController();
      const abortedBarrier = pipeline.barrier(abort.signal);
      abort.abort(new Error("caller stopped waiting"));
      await expectPipelineError(abortedBarrier, "pipeline_barrier_aborted");

      publicationGate.resolve();
      await expect(first).resolves.toMatchObject({ kind: "committed", sequence: 1 });
      await expect(second).resolves.toMatchObject({ kind: "committed", sequence: 2 });
      await expect(barrier).resolves.toEqual({ last_sequence: 2 });
      expect(repository.listEvents("sess_pipeline_a").events.map((event) => event.cursor)).toEqual([1, 2]);
      expect(pipeline.pending_count).toBe(0);
      expect(pipeline.failure).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("serializes raw normalization through post-commit publication while allowing sequence gaps from diagnostics", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const publicationGate = deferred<void>();
      const firstPublisherEntered = deferred<void>();
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({
          repository,
          async publish(committed) {
            if (committed.event.event.cursor === 1) {
              firstPublisherEntered.resolve();
              await publicationGate.promise;
            }
          }
        }),
        normalizer: { now: advancingClock() }
      });

      await expect(
        pipeline.consume({
          kind: "notification",
          method: "configWarning",
          params: { summary: "not retained" },
          classification: "generated_unhandled"
        })
      ).resolves.toMatchObject({ kind: "optional_diagnostic", sequence: 1 });

      const first = pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }));
      const second = pipeline.consume(selected("turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") }));

      await firstPublisherEntered.promise;
      expect(pipeline.last_sequence).toBe(2);
      expect(repository.listEvents("sess_pipeline_a").events).toHaveLength(1);
      publicationGate.resolve();

      await expect(first).resolves.toMatchObject({ kind: "committed", sequence: 2 });
      await expect(second).resolves.toMatchObject({ kind: "committed", sequence: 3 });
      expect(repository.listEvents("sess_pipeline_a").events.map((event) => event.cursor)).toEqual([1, 2]);
      expect(pipeline.failure).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("observes managed events with the captured generation only after durable publication", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const order: string[] = [];
      const observed: Array<{ readonly method: string; readonly generation: number }> = [];
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({
          repository,
          publish(committed) {
            expect(repository.listEvents("sess_pipeline_a").events.at(-1)).toEqual(committed.event.event);
            order.push("publish");
          }
        }),
        normalizer: { now: advancingClock() },
        observe_event(event, generation) {
          expect(repository.listEvents("sess_pipeline_a").events).toHaveLength(1);
          order.push("observe");
          observed.push({ method: event.method, generation });
        }
      });

      await expect(
        pipeline.consume(
          {
            kind: "notification",
            method: "configWarning",
            params: { summary: "not retained" },
            classification: "generated_unhandled"
          },
          7
        )
      ).resolves.toMatchObject({ kind: "optional_diagnostic" });
      await expect(
        pipeline.consume(selected("turn/completed", { threadId: threadB, turn: { secret: "unmanaged" } }), 7)
      ).resolves.toMatchObject({ kind: "unmanaged_observation" });
      await expect(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }), 7)
      ).resolves.toMatchObject({ kind: "committed", sequence: 3 });

      expect(order).toEqual(["publish", "observe"]);
      expect(observed).toEqual([{ method: "thread/status/changed", generation: 7 }]);
      expect(pipeline.failure).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("coalesces repeated goal snapshots before projection and control observation", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const observed: string[] = [];
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} }),
        normalizer: { now: advancingClock() },
        observe_event(event) {
          observed.push(event.method);
        }
      });
      const cleared = selected("thread/goal/cleared", { threadId: threadA });

      await expect(pipeline.consume(cleared, 3)).resolves.toMatchObject({ kind: "committed", sequence: 1 });
      await expect(pipeline.consume(cleared, 3)).resolves.toEqual({
        kind: "redundant_observation",
        sequence: 2,
        observation: {
          sequence: 2,
          method: "thread/goal/cleared",
          thread_id: threadA,
          classification: "redundant_state",
          total_count: 1
        }
      });

      expect(repository.listEvents("sess_pipeline_a").events).toHaveLength(1);
      expect(observed).toEqual(["thread/goal/cleared"]);
      expect(pipeline.last_sequence).toBe(2);
      expect(pipeline.failure).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("stops observably when post-commit control observation fails", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} }),
        normalizer: { now: advancingClock() },
        observe_event() {
          throw new Error("control observer failed");
        }
      });

      await expect(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }), 2)
      ).rejects.toThrow("control observer failed");
      expect(repository.listEvents("sess_pipeline_a").events).toHaveLength(1);
      expect(pipeline.failure).toMatchObject({ message: "control observer failed" });
      await expectPipelineError(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: [] } }), 2),
        "pipeline_stopped"
      );
    } finally {
      open.db.close();
    }
  });

  it("fails before normalization when control observation lacks an exact generation", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} }),
        normalizer: { now: advancingClock() },
        observe_event() {}
      });

      await expectPipelineError(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } })),
        "invalid_connection_generation"
      );
      expect(pipeline.last_sequence).toBe(0);
      expect(repository.listEvents("sess_pipeline_a").events).toEqual([]);
      await expectPipelineError(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }), 1),
        "pipeline_stopped"
      );
    } finally {
      open.db.close();
    }
  });

  it("filters malformed payloads from unmanaged TUI threads before deep parsing", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      repository.create(stateCandidate("sess_pipeline_archived", archivedThread, createdAt));
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} }),
        normalizer: { now: advancingClock() }
      });

      const unmanaged = await pipeline.consume(
        selected("turn/completed", { threadId: threadB, turn: { secret: "unmanaged-content" } })
      );
      expect(unmanaged).toMatchObject({
        kind: "unmanaged_observation",
        sequence: 1,
        thread_id: threadB,
        method: "turn/completed",
        source: "identity_gate",
        total_count: 1
      });
      expect(JSON.stringify(unmanaged)).not.toContain("unmanaged-content");

      await expect(
        pipeline.consume(selected("turn/completed", { threadId: archivedThread, turn: { secret: "archived-content" } }))
      ).resolves.toMatchObject({
        kind: "unmanaged_observation",
        sequence: 2,
        thread_id: archivedThread,
        source: "identity_gate",
        total_count: 2
      });

      await expect(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }))
      ).resolves.toMatchObject({ kind: "committed", sequence: 3 });
      expect(pipeline.failure).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("does not normalize a queued frame after publication failure", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({
          repository,
          publish() {
            throw new Error("fanout failed");
          }
        }),
        normalizer: { now: advancingClock() }
      });

      const first = pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }));
      const queuedMalformed = pipeline.consume(
        selected("thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: ["invalid"] } })
      );

      await expect(first).rejects.toBeInstanceOf(HostDeckProjectionPublicationError);
      await expectPipelineError(queuedMalformed, "pipeline_stopped");
      expect(pipeline.last_sequence).toBe(1);
      expect(pipeline.failure).toBeInstanceOf(HostDeckProjectionPublicationError);
      expect(repository.listEvents("sess_pipeline_a").events).toHaveLength(1);
    } finally {
      open.db.close();
    }
  });

  it("fails for reconciliation when classification and durable mapping disagree", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} }),
        normalizer: { now: advancingClock() },
        is_managed_thread: () => true
      });

      await expectPipelineError(
        pipeline.consume(selected("thread/status/changed", { threadId: threadB, status: { type: "idle" } })),
        "thread_scope_changed"
      );
      expect(pipeline.failure).toBeInstanceOf(HostDeckCodexEventPipelineError);
      expect(repository.listEvents("sess_pipeline_a").events).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("fails stopped at the bounded pending-notification ceiling", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_pipeline_a", threadA));
      const publicationGate = deferred<void>();
      const firstPublisherEntered = deferred<void>();
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: createProductionProjectionAppendPort({
          repository,
          async publish() {
            firstPublisherEntered.resolve();
            await publicationGate.promise;
          }
        }),
        normalizer: { now: advancingClock() },
        max_pending_notifications: 1
      });

      const first = pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } }));
      await firstPublisherEntered.promise;
      expect(pipeline.pending_count).toBe(1);
      await expectPipelineError(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: [] } })),
        "pipeline_capacity_exceeded"
      );

      publicationGate.resolve();
      await expect(first).resolves.toMatchObject({ kind: "committed", sequence: 1 });
      expect(pipeline.pending_count).toBe(0);
      await expectPipelineError(
        pipeline.consume(selected("thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: [] } })),
        "pipeline_stopped"
      );
      expect(pipeline.failure).toMatchObject({ code: "pipeline_capacity_exceeded" });
    } finally {
      open.db.close();
    }
  });
});

function selected(method: string, params: unknown): CodexConnectionNotification {
  return { kind: "notification", method, params, classification: "selected" };
}

function stateCandidate(id: string, threadId: string, archivedAt: string | null = null) {
  const mapping = {
    id,
    name: id.replace("sess_", "session-"),
    codex_thread_id: threadId,
    cwd: `/tmp/${id}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: archivedAt
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
        archived_at: mapping.archived_at,
        session_state: archivedAt === null ? "active" : "archived",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: mapping.updated_at,
        last_activity_at: null,
        branch: "main",
        model: "gpt-5.5-codex",
        goal: null,
        recent_summary: "Managed projection created.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function rawTurn(turnId: string, status: "completed" | "failed" | "inProgress" | "interrupted") {
  return {
    id: turnId,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "failed", codexErrorInfo: null, additionalDetails: null } : null,
    startedAt: 1_752_170_401,
    completedAt: status === "inProgress" ? null : 1_752_170_402,
    durationMs: status === "inProgress" ? null : 1_000
  };
}

function advancingClock(): () => string {
  let milliseconds = Date.parse(createdAt);
  return () => {
    milliseconds += 1;
    return new Date(milliseconds).toISOString();
  };
}

function fixedNow(): Date {
  return new Date(createdAt);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-codex-pipeline-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function expectPipelineError(
  promise: Promise<unknown>,
  code: HostDeckCodexEventPipelineError["code"]
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected Codex event pipeline failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexEventPipelineError);
    expect((error as HostDeckCodexEventPipelineError).code).toBe(code);
  }
}
