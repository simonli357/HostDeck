import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexReconnectLifecyclePort,
  createCodexRuntimeReconnectController
} from "@hostdeck/codex-adapter";
import { ScriptedCodexTransport } from "@hostdeck/codex-adapter/testing";
import {
  codexItemIdSchema,
  isoTimestampSchema,
  type ResourceBudget,
  remoteIngressPublicStateSchema,
  resolveResourceBudget,
  type SelectedProjectionEvent
} from "@hostdeck/contracts";
import {
  type CommittedProjectionAppend,
  createProductionProjectionAppendPort,
  createProductionProjectionContinuityPort,
  createSelectedStateRepository,
  openMigratedDatabase,
  type ProductionProjectionAppendInput,
  type SelectedSessionState,
  type SelectedStateRepository,
  type StartupAuditOrphanReconciliationResult,
  selectedStateRevision
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexRuntimeReconciliationLifecycle,
  createCodexRuntimeReconciliationLifecycle
} from "./codex-runtime-reconciliation-lifecycle.js";
import {
  createHostDeckHostHealthService,
  type HostDeckHostHealthService,
  hostDeckLocalHealthComponents
} from "./host-health.js";
import { createProjectionFanoutHub } from "./projection-fanout-hub.js";
import { createProjectionReplayLiveHandoffService } from "./projection-replay-live-handoff.js";
import { createProjectionSubscriberStreamService } from "./projection-subscriber-stream.js";

const sessionA = "sess_projection_acceptance_a";
const sessionB = "sess_projection_acceptance_b";
const threadA = "thread-projection-acceptance-a";
const threadB = "thread-projection-acceptance-b";
const createdAt = "2026-07-16T12:00:00.000Z";
const remoteOrigin = "https://hostdeck-acceptance.fixture-tailnet.ts.net";

describe("aggregate projection lifecycle acceptance", () => {
  it("composes durable projection, health, reconnect, subscribers, and terminal cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostdeck-projection-acceptance-"));
    const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
      now: () => new Date(createdAt)
    });
    const repository = createSelectedStateRepository(opened.db);
    repository.create(stateCandidate(sessionA, threadA));
    const budget = acceptanceBudget();
    const hub = createProjectionFanoutHub({
      max_subscribers: budget.sse_max_subscribers,
      max_subscribers_per_session:
        budget.sse_max_subscribers_per_session
    });
    const published: Array<
      Readonly<{ cursor: number; type: SelectedProjectionEvent["type"] }>
    > = [];
    const publish = (committed: CommittedProjectionAppend) => {
      const event = committed.event.event;
      const durable = repository.require(event.session_id);
      expect(durable.projection).toEqual(committed.projection);
      expect(selectedStateRevision(durable)).toEqual(committed.revision);
      const stored = repository
        .listEvents(event.session_id, { after: event.cursor - 1, limit: 2 })
        .events.find((candidate) => candidate.cursor === event.cursor);
      expect(stored).toEqual(event);
      published.push(Object.freeze({ cursor: event.cursor, type: event.type }));
      hub.publish(committed);
    };
    const projection = createProductionProjectionAppendPort({
      repository,
      publish
    });
    const continuity = createProductionProjectionContinuityPort({
      repository,
      publish
    });
    const handoff = createProjectionReplayLiveHandoffService({
      authorize: () => ({ ok: true }),
      fanout: hub,
      resource_budget: budget,
      state: repository
    });
    const subscriberFailures: string[] = [];
    const subscribers = createProjectionSubscriberStreamService({
      handoff,
      observe_failure(failure) {
        subscriberFailures.push(failure.code);
      },
      resource_budget: budget
    });
    const health = healthService();
    makeLocalReadyExceptRuntime(health);
    health.updateRemote({ source_generation: 1, state: readyRemote(1) });
    const durableLifecycle = reconciliationLifecycle({
      budget,
      continuity,
      projection,
      repository
    });
    const reconnectEntered = deferred<void>();
    const releaseReconnect = deferred<void>();
    const disconnected = deferred<void>();
    let runtimeHealthGeneration = 0;
    const lifecycle: CodexReconnectLifecyclePort = {
      async disconnected(input) {
        await durableLifecycle.disconnected(input);
        runtimeHealthGeneration += 1;
        health.updateLocal({
          component: "runtime",
          reasons: ["runtime_disconnected"],
          source_generation: runtimeHealthGeneration,
          state: "degraded"
        });
        disconnected.resolve();
      },
      async reconcile(input) {
        if (input.previous_admitted_generation !== null) {
          reconnectEntered.resolve();
          await releaseReconnect.promise;
        }
        return durableLifecycle.reconcile(input);
      },
      resubscribe: (input) => durableLifecycle.resubscribe(input),
      async ready(input) {
        await durableLifecycle.ready(input);
        runtimeHealthGeneration += 1;
        health.updateLocal({
          component: "runtime",
          reasons: [],
          source_generation: runtimeHealthGeneration,
          state: "ready"
        });
      }
    };
    const transport = runtimeTransport();
    const backgroundFailures: string[] = [];
    const reconnect = createCodexRuntimeReconnectController({
      transport,
      observed_version: "0.144.0",
      resource_budget: budget,
      lifecycle,
      random: () => 0,
      on_background_error: (failure) =>
        backgroundFailures.push(`${failure.stage}:${failure.code}`)
    });
    const healthy = subscribers.open(
      streamInput(sessionA, "subscriber-healthy")
    );
    const slow = subscribers.open(streamInput(sessionA, "subscriber-slow"));
    const healthyIterator = healthy[Symbol.asyncIterator]();

    try {
      await expect(
        settleWithin(reconnect.start(), 2_000, () =>
          JSON.stringify({
            methods: sentMethods(transport),
            reconnect: reconnect.snapshot(),
            reconciliation: durableLifecycle.snapshot()
          })
        )
      ).resolves.toMatchObject({
        generation: 1,
        continuity: "boundary_required",
        reconnected: false
      });
      expect(await readEvents(healthyIterator, 3)).toMatchObject([
        { cursor: 1, type: "runtime", state: "disconnected" },
        { cursor: 2, type: "replay_boundary", reason: "restart" },
        { cursor: 3, type: "runtime", state: "ready" }
      ]);
      expect(slow.queued_event_count).toBe(3);
      expect(health.localSnapshot()).toMatchObject({
        readiness: "ready",
        mutation_admission: "open"
      });
      const initialProof = health.admitMutation();

      const replay = subscribers.open(
        streamInput(sessionA, "subscriber-initial-replay", 1)
      );
      const replayIterator = replay[Symbol.asyncIterator]();
      expect(await readEvents(replayIterator, 2)).toMatchObject([
        { cursor: 2, type: "replay_boundary" },
        { cursor: 3, type: "runtime", state: "ready" }
      ]);
      await replayIterator.return?.();
      expect(replay.remaining_replay_event_count).toBe(0);

      const localBeforeRemoteFailure = health.localSnapshot();
      health.updateRemote({
        source_generation: 2,
        state: unavailableRemote(2)
      });
      expect(health.localSnapshot()).toBe(localBeforeRemoteFailure);
      expect(health.assertMutation(initialProof)).toBe(localBeforeRemoteFailure);
      await expect(
        reconnect.request({
          method: "thread/list",
          params: { archived: false, limit: 1 },
          kind: "read"
        })
      ).resolves.toMatchObject({ data: [{ id: threadA }] });
      health.updateRemote({ source_generation: 3, state: readyRemote(3) });
      expect(health.assertMutation(initialProof)).toBe(localBeforeRemoteFailure);

      const pendingMutation = reconnect.request({
        method: "turn/start",
        params: { hold: true },
        kind: "mutation"
      });
      await waitFor(() => sentMethods(transport).filter((method) => method === "turn/start").length === 1);
      transport.disconnect("scripted aggregate runtime crash");
      expect(reconnect.snapshot()).toMatchObject({
        phase: "disconnected",
        admitted_generation: null
      });
      await expect(
        reconnect.request({ method: "turn/start", params: {}, kind: "mutation" })
      ).rejects.toMatchObject({ outcome: "not_sent", retry_safe: true });
      await expect(pendingMutation).rejects.toMatchObject({
        outcome: "unknown",
        retry_safe: false
      });
      await disconnected.promise;
      expect(health.localSnapshot()).toMatchObject({
        readiness: "not_ready",
        mutation_admission: "closed"
      });
      expect(() => health.assertMutation(initialProof)).toThrow();
      await reconnectEntered.promise;
      expect(reconnect.snapshot().phase).toBe("reconciling");
      releaseReconnect.resolve();
      await waitFor(
        () => reconnect.snapshot().phase === "ready" && reconnect.generation === 2
      );

      expect(await readEvents(healthyIterator, 3)).toMatchObject([
        { cursor: 4, type: "runtime", state: "disconnected" },
        { cursor: 5, type: "replay_boundary", reason: "disconnect" },
        { cursor: 6, type: "runtime", state: "ready" }
      ]);
      expect(health.localSnapshot()).toMatchObject({
        readiness: "ready",
        mutation_admission: "open"
      });
      expect(() => health.assertMutation(initialProof)).toThrow();
      const recoveredProof = health.admitMutation();
      expect(health.assertMutation(recoveredProof)).toBe(health.localSnapshot());
      expect(sentMethods(transport).filter((method) => method === "turn/start")).toHaveLength(1);

      for (let index = 1; index <= 3; index += 1) {
        await projection.append(
          appendCandidate(
            repository.require(sessionA),
            `aggregate-event-${index}`,
            `2026-07-16T14:0${index}:00.000Z`
          )
        );
      }
      expect(await readEvents(healthyIterator, 3)).toMatchObject([
        { cursor: 7, type: "message" },
        { cursor: 8, type: "message" },
        { cursor: 9, type: "message" }
      ]);
      expect(slow).toMatchObject({
        state: "failed",
        failure: { code: "queue_overflow", cursor: 9 },
        queued_event_count: 0,
        remaining_replay_event_count: 0
      });
      expect(hub.failure).toBeNull();
      expect(subscribers.snapshot()).toMatchObject({
        active_subscribers: 1,
        overflowed_subscribers: 1,
        replay_events: 0,
        retained_events: 0
      });

      const recoveredReplay = subscribers.open(
        streamInput(sessionA, "subscriber-recovered-replay", 4)
      );
      const recoveredReplayIterator = recoveredReplay[Symbol.asyncIterator]();
      expect(await readEvents(recoveredReplayIterator, 5)).toMatchObject([
        { cursor: 5, type: "replay_boundary" },
        { cursor: 6, type: "runtime", state: "ready" },
        { cursor: 7 },
        { cursor: 8 },
        { cursor: 9 }
      ]);
      await recoveredReplayIterator.return?.();

      const authority = new AbortController();
      const pairedA = subscribers.open(
        streamInput(sessionA, "subscriber-paired-a", 9, authority.signal, "device-aggregate")
      );
      const pairedB = subscribers.open(
        streamInput(sessionA, "subscriber-paired-b", 9, authority.signal, "device-aggregate")
      );
      authority.abort(new Error("paired authority revoked"));
      expect(pairedA.state).toBe("closed");
      expect(pairedB.state).toBe("closed");

      const request = new AbortController();
      const disconnectedStream = subscribers.open(
        streamInput(sessionA, "subscriber-request-abort", 9, request.signal)
      );
      request.abort(new Error("request disconnected"));
      expect(disconnectedStream.state).toBe("closed");

      repository.create(stateCandidate(sessionB, threadB));
      const archivedStream = subscribers.open(
        streamInput(sessionA, "subscriber-archive", 9)
      );
      const unrelated = subscribers.open(
        streamInput(sessionB, "subscriber-unrelated")
      );
      expect(subscribers.archive_session(sessionA)).toBe(2);
      expect(healthy.state).toBe("failed");
      expect(archivedStream.state).toBe("failed");
      expect(unrelated.state).toBe("open");
      expect(subscribers.close()).toBe(1);
      expect(unrelated.state).toBe("closed");

      await reconnect.close();
      expect(hub.subscriber_count).toBe(0);
      expect(hub.close()).toBe(0);
      expect(subscribers.snapshot()).toMatchObject({
        active_device_buckets: 0,
        active_session_buckets: 0,
        active_subscribers: 0,
        archived_subscribers: 2,
        observer_failures: 0,
        queued_events: 0,
        replay_events: 0,
        retained_events: 0
      });
      expect(reconnect.snapshot()).toMatchObject({
        phase: "closed",
        admitted_generation: null,
        connect_attempts: 2,
        completed_reconnects: 1,
        disconnect_cleanups: 1,
        held_notifications: 0,
        held_server_requests: 0
      });
      expect(durableLifecycle.snapshot()).toMatchObject({
        phase: "ready",
        generation: 2,
        continuity: "boundary_required",
        gap_reason: "disconnect",
        cycle_count: 2,
        boundary_count: 1,
        resumed_count: 1,
        ready_count: 1
      });
      expect(transport.state).toBe("closed");
      expect(backgroundFailures).toEqual([]);
      expect(subscriberFailures).toEqual([
        "queue_overflow",
        "session_archived",
        "session_archived"
      ]);
      expect(published).toEqual([
        { cursor: 1, type: "runtime" },
        { cursor: 2, type: "replay_boundary" },
        { cursor: 3, type: "runtime" },
        { cursor: 4, type: "runtime" },
        { cursor: 5, type: "replay_boundary" },
        { cursor: 6, type: "runtime" },
        { cursor: 7, type: "message" },
        { cursor: 8, type: "message" },
        { cursor: 9, type: "message" }
      ]);

      opened.db.close();
      expect(opened.db.open).toBe(false);
      rmSync(root, { force: true, recursive: true });
      expect(existsSync(root)).toBe(false);

      const publicInspection = JSON.stringify({
        health: {
          local: health.localSnapshot(),
          remote: health.remoteSnapshot()
        },
        reconnect: reconnect.snapshot(),
        reconciliation: durableLifecycle.snapshot(),
        subscribers: subscribers.snapshot()
      });
      for (const privateValue of [
        sessionA,
        sessionB,
        threadA,
        threadB,
        root,
        "aggregate-event"
      ]) {
        expect(publicInspection).not.toContain(privateValue);
      }
    } finally {
      releaseReconnect.resolve();
      subscribers.close();
      hub.close();
      await reconnect.close().catch(() => undefined);
      if (opened.db.open) opened.db.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("does not publish a projection transaction that rolls back", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostdeck-projection-rollback-"));
    const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
      now: () => new Date(createdAt)
    });
    const repository = createSelectedStateRepository(opened.db);
    const current = repository.create(stateCandidate(sessionA, threadA));
    const hub = createProjectionFanoutHub();
    let deliveries = 0;
    const subscription = hub.subscribe({
      id: "aggregate-rollback-observer",
      session_id: sessionA,
      on_event: () => {
        deliveries += 1;
      }
    });
    const append = createProductionProjectionAppendPort({
      repository,
      publish: hub.publish
    });

    try {
      opened.db.exec(`
        CREATE TRIGGER force_aggregate_projection_rollback
        BEFORE INSERT ON selected_projected_events
        BEGIN
          SELECT RAISE(ABORT, 'forced aggregate rollback');
        END;
      `);
      await expect(
        append.append(
          appendCandidate(
            current,
            "aggregate-rollback-event",
            "2026-07-16T14:00:00.000Z"
          )
        )
      ).rejects.toBeDefined();
      expect(repository.listEvents(sessionA).events).toEqual([]);
      expect(deliveries).toBe(0);
      expect(hub.failure).toBeNull();
    } finally {
      subscription.unsubscribe();
      hub.close();
      if (opened.db.open) opened.db.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

interface ReconciliationLifecycleInput {
  readonly budget: ResourceBudget;
  readonly continuity: ReturnType<
    typeof createProductionProjectionContinuityPort
  >;
  readonly projection: ReturnType<typeof createProductionProjectionAppendPort>;
  readonly repository: SelectedStateRepository;
}

function reconciliationLifecycle(
  input: ReconciliationLifecycleInput
): CodexRuntimeReconciliationLifecycle {
  let now = Date.parse("2026-07-16T13:00:00.000Z");
  return createCodexRuntimeReconciliationLifecycle({
    approvals: {
      disconnect: async () => 0
    },
    audit: {
      reconcile: ({ eligible_before }) => completeAudit(eligible_before)
    },
    continuity: input.continuity,
    events: {
      barrier: async () => undefined,
      reconcile: async () => undefined
    },
    now: () => new Date(now++).toISOString(),
    plans: {
      rehydrate: async () => undefined
    },
    projection: input.projection,
    repository: input.repository,
    resource_budget: input.budget
  });
}

function runtimeTransport(): ScriptedCodexTransport {
  return new ScriptedCodexTransport({
    on_send(text, transport) {
      const message = JSON.parse(text) as {
        readonly id?: number;
        readonly method?: string;
        readonly params?: Record<string, unknown>;
      };
      const respond = (result: unknown) =>
        transport.receive(JSON.stringify({ id: message.id, result }));
      switch (message.method) {
        case "initialize":
          respond({
            userAgent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
            codexHome: "/tmp/aggregate-codex-home",
            platformFamily: "unix",
            platformOs: "linux"
          });
          return;
        case "initialized":
          return;
        case "collaborationMode/list":
          respond({ data: [{ name: "Default" }, { name: "Plan" }] });
          return;
        case "thread/list": {
          const archived = message.params?.archived === true;
          const data = archived ? [] : [rawThread()];
          respond({
            data,
            nextCursor: null,
            backwardsCursor: data.length === 0 ? null : "aggregate-active-back"
          });
          return;
        }
        case "thread/read":
          respond({ thread: rawThread() });
          return;
        case "thread/goal/get":
          respond({ goal: null });
          return;
        case "thread/turns/list":
          respond({ data: [], nextCursor: null, backwardsCursor: null });
          return;
        case "thread/resume":
          respond(rawResume());
          return;
        case "turn/start":
          return;
        default:
          throw new Error(`Unexpected aggregate runtime method ${String(message.method)}.`);
      }
    }
  });
}

function rawThread() {
  return {
    id: threadA,
    extra: null,
    sessionId: `runtime-${threadA}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: unixSeconds(createdAt),
    updatedAt: unixSeconds("2026-07-16T12:45:00.000Z"),
    recencyAt: unixSeconds("2026-07-16T12:45:00.000Z"),
    status: { type: "idle" },
    path: `/tmp/${threadA}.jsonl`,
    cwd: `/tmp/${sessionA}`,
    cliVersion: "0.144.0",
    source: "appServer",
    threadSource: "hostdeck:managed",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: threadA,
    turns: []
  };
}

function rawResume() {
  return {
    thread: { id: threadA, cwd: `/tmp/${sessionA}`, turns: [] },
    model: "runtime-default",
    modelProvider: "openai",
    serviceTier: null,
    cwd: `/tmp/${sessionA}`,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: null
  };
}

function stateCandidate(sessionId: string, threadId: string) {
  const mapping = {
    id: sessionId,
    name: sessionId.replace("sess_", "session-"),
    codex_thread_id: threadId,
    cwd: `/tmp/${sessionId}`,
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
        updated_at: mapping.updated_at,
        last_activity_at: null,
        branch: "main",
        model: null,
        settings: null,
        goal: null,
        recent_summary: "Aggregate acceptance session.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function appendCandidate(
  state: SelectedSessionState,
  eventId: string,
  capturedAt: string
): ProductionProjectionAppendInput {
  const session = state.projection.session;
  const timestamp = isoTimestampSchema.parse(capturedAt);
  return {
    session_id: state.mapping.id,
    expected_revision: selectedStateRevision(state),
    event: {
      captured_at: timestamp,
      upstream_at: null,
      codex_event_id: eventId,
      codex_event_type: "item/agentMessage/delta",
      content_state: "complete",
      content_notice: null,
      type: "message",
      role: "agent",
      phase: "completed",
      item_id: codexItemIdSchema.parse(`item-${eventId}`),
      text: `Private payload for ${eventId}.`
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
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: session.branch,
      model: session.model,
      settings: session.settings,
      goal: session.goal,
      recent_summary: "Aggregate acceptance event committed."
    }
  };
}

function acceptanceBudget(): ResourceBudget {
  return resolveResourceBudget({
    protocol_reconnect_initial_delay_ms: 10,
    protocol_reconnect_max_delay_ms: 100,
    sse_queue_max_events: 8,
    sse_replay_max_events: 16
  });
}

function healthService(): HostDeckHostHealthService {
  let now = Date.parse("2026-07-16T15:00:00.000Z");
  return createHostDeckHostHealthService({ now: () => new Date(now++) });
}

function makeLocalReadyExceptRuntime(health: HostDeckHostHealthService): void {
  for (const component of hostDeckLocalHealthComponents) {
    if (component === "runtime") continue;
    health.updateLocal({
      component,
      reasons: [],
      source_generation: 1,
      state: "ready"
    });
  }
}

function readyRemote(generation: number) {
  return remoteIngressPublicStateSchema.parse({
    generation,
    availability: "ready",
    reason: null,
    external_origin: remoteOrigin,
    laptop_action_required: false,
    observed_at: "2026-07-16T15:00:00.000Z"
  });
}

function unavailableRemote(generation: number) {
  return remoteIngressPublicStateSchema.parse({
    generation,
    availability: "unavailable",
    reason: "client_stopped",
    external_origin: null,
    laptop_action_required: true,
    observed_at: null
  });
}

function streamInput(
  sessionId: string,
  subscriberId: string,
  after: number | null = null,
  signal: AbortSignal = new AbortController().signal,
  deviceId: string | null = null
) {
  return {
    after,
    authorization: Object.freeze({ allowed: true }),
    device_id: deviceId,
    session_id: sessionId,
    signal,
    subscriber_id: subscriberId
  };
}

async function readEvents(
  iterator: AsyncIterator<SelectedProjectionEvent>,
  count: number
): Promise<SelectedProjectionEvent[]> {
  const events: SelectedProjectionEvent[] = [];
  while (events.length < count) {
    const next = await iterator.next();
    if (next.done) throw new Error("Projection stream ended before the expected event count.");
    events.push(next.value);
  }
  return events;
}

function completeAudit(timestamp: string): StartupAuditOrphanReconciliationResult {
  return Object.freeze({
    actionable_remaining: false,
    batch_count: 1,
    duration_ms: 1,
    eligible_before: timestamp,
    eligible_pending_operation_count: 0,
    failure: null,
    protected_recent_operation_count: 0,
    reasons: Object.freeze([]),
    reconciled_at: timestamp,
    reconciled_operation_count: 0,
    scan_complete: true,
    status: "complete",
    total_pending_operation_count: 0
  });
}

function sentMethods(transport: ScriptedCodexTransport): string[] {
  return transport.sent_frames.flatMap((frame) => {
    const parsed = JSON.parse(frame) as { readonly method?: unknown };
    return typeof parsed.method === "string" ? [parsed.method] : [];
  });
}

function unixSeconds(timestamp: string): number {
  return Math.floor(Date.parse(timestamp) / 1_000);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for aggregate lifecycle state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  diagnostic: () => string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for aggregate operation: ${diagnostic()}`
        )
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as Deferred<T>["resolve"];
  });
  return { promise, resolve };
}
