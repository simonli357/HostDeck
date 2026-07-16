import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexConnectionNotification,
  createCodexEventNormalizer,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  createProductionProjectionAppendPort,
  createSelectedStateRepository,
  HostDeckProjectionPublicationError,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexProjectionService,
  HostDeckCodexProjectionError
} from "./codex-projection-service.js";

const tempDirs: string[] = [];
const createdAt = "2026-07-10T18:00:00.000Z";
const threadA = "thread-projector-a";
const threadB = "thread-projector-b";
const archivedThread = "thread-projector-archived";
const turnA = "turn-projector-a";
const turnB = "turn-projector-b";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Codex ordered projection service", () => {
  it("serializes normalized turn and message events through durable commit-before-publish", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_projector_a", threadA));
      const published: number[] = [];
      const appendPort = createProductionProjectionAppendPort({
        repository,
        publish(committed) {
          published.push(committed.event.event.cursor);
          expect(repository.listEvents(committed.event.event.session_id).events.at(-1)?.cursor).toBe(committed.event.event.cursor);
        }
      });
      const service = createCodexProjectionService({ repository, append_port: appendPort });
      const normalizer = createCodexEventNormalizer({ now: advancingClock() });
      const events = [
        event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: [] } }),
        event(normalizer, "turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") }),
        event(
          normalizer,
          "item/started",
          itemParams(threadA, turnA, { type: "agentMessage", id: "item-projector-agent", text: "", phase: null, memoryCitation: null }, "started")
        ),
        event(normalizer, "item/agentMessage/delta", {
          threadId: threadA,
          turnId: turnA,
          itemId: "item-projector-agent",
          delta: "Projection is ordered."
        }),
        event(
          normalizer,
          "item/completed",
          itemParams(
            threadA,
            turnA,
            {
              type: "agentMessage",
              id: "item-projector-agent",
              text: "Projection is ordered.",
              phase: "final_answer",
              memoryCitation: null
            },
            "completed"
          )
        ),
        event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "idle" } }),
        event(normalizer, "turn/completed", { threadId: threadA, turn: rawTurn(turnA, "completed") })
      ];

      const results = await Promise.all(events.map((normalized) => service.project(normalized)));

      expect(results.every((result) => result.kind === "committed")).toBe(true);
      expect(published).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(repository.listEvents("sess_projector_a").events.map((projected) => projected.type)).toEqual([
        "activity",
        "turn",
        "activity",
        "message",
        "message",
        "activity",
        "turn"
      ]);
      expect(repository.require("sess_projector_a").projection.session).toMatchObject({
        turn_state: "completed",
        attention: "none",
        recent_summary: "Codex turn completed.",
        last_event_cursor: 7
      });
      expect(service.last_sequence).toBe(7);
      expect(service.failure).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("preserves exact two-thread routing without cross-session writes", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_projector_a", threadA));
      repository.create(stateCandidate("sess_projector_b", threadB));
      const publications: string[] = [];
      const service = createCodexProjectionService({
        repository,
        append_port: createProductionProjectionAppendPort({
          repository,
          publish(committed) {
            publications.push(`${committed.event.event.session_id}:${committed.event.event.cursor}`);
          }
        })
      });
      const normalizer = createCodexEventNormalizer({ now: advancingClock() });
      const eventA = event(normalizer, "turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") });
      const eventB = event(normalizer, "turn/started", { threadId: threadB, turn: rawTurn(turnB, "inProgress") });

      await Promise.all([service.project(eventA), service.project(eventB)]);

      expect(publications).toEqual(["sess_projector_a:1", "sess_projector_b:1"]);
      expect(repository.listEvents("sess_projector_a").events).toMatchObject([{ session_id: "sess_projector_a", cursor: 1 }]);
      expect(repository.listEvents("sess_projector_b").events).toMatchObject([{ session_id: "sess_projector_b", cursor: 1 }]);
    } finally {
      open.db.close();
    }
  });

  it("projects authoritative waiting flags and clears them without claiming turn completion", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_projector_a", threadA));
      const service = createCodexProjectionService({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} })
      });
      const normalizer = createCodexEventNormalizer({ now: advancingClock() });
      const waiting = event(normalizer, "thread/status/changed", {
        threadId: threadA,
        status: { type: "active", activeFlags: ["waitingOnApproval"] }
      });
      const resumed = event(normalizer, "thread/status/changed", {
        threadId: threadA,
        status: { type: "active", activeFlags: [] }
      });

      await service.project(waiting);
      expect(repository.require("sess_projector_a").projection.session).toMatchObject({
        turn_state: "waiting_for_approval",
        attention: "needs_approval"
      });
      await service.project(resumed);
      expect(repository.require("sess_projector_a").projection.session).toMatchObject({
        turn_state: "in_progress",
        attention: "watch"
      });
      expect(repository.require("sess_projector_a").projection.session.turn_state).not.toBe("completed");
    } finally {
      open.db.close();
    }
  });

  it("projects settings, goal, usage, approval resolution, and archive without invented outcomes", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_projector_a", threadA));
      const service = createCodexProjectionService({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} })
      });
      const normalizer = createCodexEventNormalizer({ now: advancingClock() });
      const normalized = [
        event(normalizer, "thread/started", { thread: rawThread(threadA, { type: "idle" }) }),
        event(normalizer, "thread/settings/updated", { threadId: threadA, threadSettings: rawSettings() }),
        event(normalizer, "thread/goal/updated", {
          threadId: threadA,
          turnId: null,
          goal: rawGoal(threadA)
        }),
        event(normalizer, "turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") }),
        event(normalizer, "thread/tokenUsage/updated", {
          threadId: threadA,
          turnId: turnA,
          tokenUsage: rawTokenUsage()
        }),
        event(normalizer, "serverRequest/resolved", { threadId: threadA, requestId: 17 }),
        event(normalizer, "turn/completed", { threadId: threadA, turn: rawTurn(turnA, "interrupted") }),
        event(normalizer, "thread/archived", { threadId: threadA })
      ];

      for (const normalizedEvent of normalized) await service.project(normalizedEvent);

      const projected = repository.listEvents("sess_projector_a").events;
      expect(projected).toHaveLength(8);
      expect(projected[1]).toMatchObject({ type: "activity", activity: "settings" });
      expect(repository.require("sess_projector_a").projection.session).toMatchObject({
        model: "gpt-5.6-sol",
        settings: {
          collaboration_mode: "plan",
          runtime_model: "gpt-5.6-sol",
          reasoning_effort: "medium"
        }
      });
      expect(projected[2]).toMatchObject({ type: "control", control: "goal", state: "paused" });
      expect(projected[4]).toMatchObject({ type: "activity", activity: "usage" });
      expect(projected[5]).toMatchObject({
        type: "activity",
        activity: "approval",
        detail: "Resolution notification carries no decision or command outcome."
      });
      expect(projected[5]).not.toHaveProperty("decision");
      expect(repository.require("sess_projector_a").projection.session).toMatchObject({
        model: "gpt-5.6-sol",
        goal: { objective: "Prove projection behavior.", state: "paused" },
        session_state: "unknown",
        turn_state: "unknown",
        attention: "unknown",
        freshness: "stale",
        freshness_reason: "Codex archived the thread before HostDeck lifecycle reconciliation.",
        recent_summary: "Codex archived the thread; HostDeck lifecycle reconciliation is required."
      });
    } finally {
      open.db.close();
    }
  });

  it("keeps runtime-scoped rate limits out of every session projection", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_projector_a", threadA));
      repository.create(stateCandidate("sess_projector_b", threadB));
      let publications = 0;
      const service = createCodexProjectionService({
        repository,
        append_port: createProductionProjectionAppendPort({
          repository,
          publish() {
            publications += 1;
          }
        })
      });
      const normalizer = createCodexEventNormalizer({ now: advancingClock() });
      const rateLimit = event(normalizer, "account/rateLimits/updated", { rateLimits: rawRateLimits() });

      await expect(service.project(rateLimit)).resolves.toMatchObject({
        kind: "runtime_observation",
        event: { scope: "runtime", method: "account/rateLimits/updated" }
      });
      expect(publications).toBe(0);
      expect(repository.listEvents("sess_projector_a").events).toEqual([]);
      expect(repository.listEvents("sess_projector_b").events).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("queues a later event until earlier post-commit publication settles", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_projector_a", threadA));
      const publicationGate = deferred<void>();
      const firstPublisherEntered = deferred<void>();
      const appendPort = createProductionProjectionAppendPort({
        repository,
        async publish(committed) {
          if (committed.event.event.cursor === 1) {
            firstPublisherEntered.resolve();
            await publicationGate.promise;
          }
        }
      });
      const service = createCodexProjectionService({ repository, append_port: appendPort });
      const normalizer = createCodexEventNormalizer({ now: advancingClock() });
      const first = service.project(
        event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: [] } })
      );
      const second = service.project(event(normalizer, "turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") }));

      await firstPublisherEntered.promise;
      expect(repository.listEvents("sess_projector_a").events).toHaveLength(1);
      publicationGate.resolve();
      await Promise.all([first, second]);
      expect(repository.listEvents("sess_projector_a").events.map((projected) => projected.cursor)).toEqual([1, 2]);
    } finally {
      open.db.close();
    }
  });

  it("downgrades authoritative runtime uncertainty to stale projection state", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      repository.create(stateCandidate("sess_projector_a", threadA));
      const service = createCodexProjectionService({
        repository,
        append_port: createProductionProjectionAppendPort({ repository, publish() {} })
      });
      const normalizer = createCodexEventNormalizer({ now: advancingClock() });

      await service.project(
        event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "systemError" } })
      );

      expect(repository.require("sess_projector_a").projection.session).toMatchObject({
        session_state: "unknown",
        turn_state: "unknown",
        attention: "failed",
        freshness: "stale",
        freshness_reason: "Codex reported a thread system error."
      });
    } finally {
      open.db.close();
    }
  });

  it("ignores unmanaged threads and fails stopped after duplicate-sequence, late, storage, or publication failure", async () => {
    await expectUnmanagedWithoutStopping();
    await expectStoppedAfterDuplicateSequence();
    await expectStoppedAfterLateEvent();
    await expectStoppedAfterStorageFailure();
    await expectStoppedAfterPublicationFailure();
  });
});

async function expectUnmanagedWithoutStopping(): Promise<void> {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  try {
    const repository = createSelectedStateRepository(open.db);
    repository.create(stateCandidate("sess_projector_a", threadA));
    repository.create(stateCandidate("sess_projector_archived", archivedThread, createdAt));
    const service = createCodexProjectionService({
      repository,
      append_port: createProductionProjectionAppendPort({ repository, publish() {} })
    });
    const normalizer = createCodexEventNormalizer({ now: advancingClock() });
    const unmanaged = event(normalizer, "turn/started", { threadId: threadB, turn: rawTurn(turnB, "inProgress") });
    const archived = event(normalizer, "thread/status/changed", { threadId: archivedThread, status: { type: "idle" } });
    const laterRuntime = event(normalizer, "account/rateLimits/updated", { rateLimits: rawRateLimits() });

    await expect(service.project(unmanaged)).resolves.toMatchObject({
      kind: "unmanaged_observation",
      thread_id: threadB,
      method: "turn/started"
    });
    await expect(service.project(archived)).resolves.toMatchObject({
      kind: "unmanaged_observation",
      thread_id: archivedThread,
      method: "thread/status/changed"
    });
    await expect(service.project(laterRuntime)).resolves.toMatchObject({ kind: "runtime_observation" });
    expect(service.failure).toBeNull();
    expect(repository.listEvents("sess_projector_a").events).toEqual([]);
  } finally {
    open.db.close();
  }
}

async function expectStoppedAfterDuplicateSequence(): Promise<void> {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  try {
    const repository = createSelectedStateRepository(open.db);
    repository.create(stateCandidate("sess_projector_a", threadA));
    let publications = 0;
    const service = createCodexProjectionService({
      repository,
      append_port: createProductionProjectionAppendPort({
        repository,
        publish() {
          publications += 1;
        }
      })
    });
    const normalizer = createCodexEventNormalizer({ now: advancingClock() });
    const normalized = event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "idle" } });

    await service.project(normalized);
    await expectProjectionError(service.project(normalized), "event_out_of_order");
    expect(publications).toBe(1);
    expect(repository.listEvents("sess_projector_a").events).toHaveLength(1);
  } finally {
    open.db.close();
  }
}

async function expectStoppedAfterLateEvent(): Promise<void> {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  try {
    const repository = createSelectedStateRepository(open.db);
    repository.create(stateCandidate("sess_projector_a", threadA));
    const service = createCodexProjectionService({
      repository,
      append_port: createProductionProjectionAppendPort({ repository, publish() {} })
    });
    const normalizer = createCodexEventNormalizer({ now: () => "2026-07-10T17:59:59.000Z" });
    const late = event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "idle" } });

    await expectProjectionError(service.project(late), "event_too_late");
    expect(repository.listEvents("sess_projector_a").events).toEqual([]);
  } finally {
    open.db.close();
  }
}

async function expectStoppedAfterPublicationFailure(): Promise<void> {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  try {
    const repository = createSelectedStateRepository(open.db);
    repository.create(stateCandidate("sess_projector_a", threadA));
    const service = createCodexProjectionService({
      repository,
      append_port: createProductionProjectionAppendPort({
        repository,
        publish() {
          throw new Error("fanout failed");
        }
      })
    });
    const normalizer = createCodexEventNormalizer({ now: advancingClock() });
    const first = event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "idle" } });
    const second = event(normalizer, "turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") });

    await expect(service.project(first)).rejects.toBeInstanceOf(HostDeckProjectionPublicationError);
    await expectProjectionError(service.project(second), "projection_stopped");
    expect(repository.listEvents("sess_projector_a").events).toHaveLength(1);
    expect(service.failure).toBeInstanceOf(HostDeckProjectionPublicationError);
  } finally {
    open.db.close();
  }
}

async function expectStoppedAfterStorageFailure(): Promise<void> {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  try {
    const repository = createSelectedStateRepository(open.db);
    repository.create(stateCandidate("sess_projector_a", threadA));
    const service = createCodexProjectionService({
      repository,
      append_port: {
        async append() {
          throw new Error("storage append failed");
        }
      }
    });
    const normalizer = createCodexEventNormalizer({ now: advancingClock() });
    const first = event(normalizer, "thread/status/changed", { threadId: threadA, status: { type: "idle" } });
    const second = event(normalizer, "turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") });

    await expect(service.project(first)).rejects.toThrow("storage append failed");
    await expectProjectionError(service.project(second), "projection_stopped");
    expect(repository.listEvents("sess_projector_a").events).toEqual([]);
    expect(service.failure?.message).toBe("storage append failed");
  } finally {
    open.db.close();
  }
}

function event(normalizer: ReturnType<typeof createCodexEventNormalizer>, method: string, params: unknown): NormalizedCodexEvent {
  const result = normalizer.normalize(selected(method, params));
  if (result.kind !== "event") throw new TypeError("Expected normalized event.");
  return result.event;
}

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

function rawThread(threadId: string, status: unknown) {
  return {
    id: threadId,
    extra: null,
    sessionId: `session-${threadId}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1_752_170_400,
    updatedAt: 1_752_170_401,
    recencyAt: 1_752_170_401,
    status,
    path: "/tmp/codex-thread.jsonl",
    cwd: "/tmp/hostdeck-projector",
    cliVersion: "0.144.0",
    source: "vscode",
    threadSource: "hostdeck",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: []
  };
}

function rawSettings() {
  return {
    cwd: "/tmp/hostdeck-projector",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    serviceTier: null,
    effort: "medium",
    summary: null,
    collaborationMode: {
      mode: "plan",
      settings: { model: "gpt-5.6-sol", reasoning_effort: "medium", developer_instructions: null }
    },
    multiAgentMode: "explicitRequestOnly",
    personality: null
  };
}

function rawGoal(threadId: string) {
  return {
    threadId,
    objective: "Prove projection behavior.",
    status: "paused",
    tokenBudget: 1_000,
    tokensUsed: 10,
    timeUsedSeconds: 1,
    createdAt: 1_752_170_400,
    updatedAt: 1_752_170_401
  };
}

function rawTurn(turnId: string, status: "completed" | "failed" | "inProgress" | "interrupted") {
  return {
    id: turnId,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "Turn failed.", codexErrorInfo: null, additionalDetails: null } : null,
    startedAt: 1_752_170_402,
    completedAt: status === "inProgress" ? null : 1_752_170_403,
    durationMs: status === "inProgress" ? null : 1_000
  };
}

function itemParams(threadId: string, turnId: string, item: unknown, lifecycle: "completed" | "started") {
  return lifecycle === "started"
    ? { item, threadId, turnId, startedAtMs: 1_752_170_402_000 }
    : { item, threadId, turnId, completedAtMs: 1_752_170_403_000 };
}

function rawTokenUsage() {
  return {
    total: tokenBreakdown(120),
    last: tokenBreakdown(20),
    modelContextWindow: 200_000
  };
}

function tokenBreakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: Math.floor(totalTokens / 2),
    cachedInputTokens: 0,
    outputTokens: totalTokens - Math.floor(totalTokens / 2),
    reasoningOutputTokens: 0
  };
}

function rawRateLimits() {
  return {
    limitId: "limit-projector",
    limitName: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_752_170_800 },
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null
  };
}

async function expectProjectionError(promise: Promise<unknown>, code: HostDeckCodexProjectionError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexProjectionError);
    expect((error as HostDeckCodexProjectionError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostDeckCodexProjectionError ${code}.`);
}

function advancingClock(): () => string {
  let milliseconds = Date.parse(createdAt);
  return () => {
    milliseconds += 1_000;
    return new Date(milliseconds).toISOString();
  };
}

function deferred<Value>() {
  let resolvePromise!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-codex-projector-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(createdAt);
}
