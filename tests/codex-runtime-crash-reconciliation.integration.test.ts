import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexModelClient,
  type CodexPlanClient,
  type CodexRuntimeReconnectController,
  createCodexApprovalClient,
  createCodexRuntimeReconnectController
} from "../packages/codex-adapter/src/index.js";
import { ScriptedCodexTransport } from "../packages/codex-adapter/src/testing.js";
import {
  resolveResourceBudget,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  type CodexApprovalControlService,
  createCodexApprovalControlService
} from "../packages/server/src/codex-approval-control-service.js";
import { createCodexEventPipeline } from "../packages/server/src/codex-event-pipeline.js";
import { createCodexModelControlService } from "../packages/server/src/codex-model-control-service.js";
import { createCodexPlanControlService } from "../packages/server/src/codex-plan-control-service.js";
import { createCodexRuntimeReconciliationLifecycle } from "../packages/server/src/codex-runtime-reconciliation-lifecycle.js";
import {
  createProductionProjectionAppendPort,
  createProductionProjectionContinuityPort,
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase,
  runStartupAuditOrphanReconciliation
} from "../packages/storage/src/index.js";

const directories: string[] = [];
const controllers: CodexRuntimeReconnectController[] = [];
const approvalsToClose: CodexApprovalControlService[] = [];
const createdAt = "2026-07-16T14:00:00.000Z";
const threadA = "thread-crash-reconcile-a";
const threadB = "thread-crash-reconcile-b";
const sessionA = "sess_crash_reconcile_a";
const sessionB = "sess_crash_reconcile_b";

afterEach(async () => {
  for (const approval of approvalsToClose.splice(0)) approval.close();
  await Promise.all(controllers.splice(0).map((controller) => controller.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("selected runtime crash reconciliation integration", () => {
  it("reconciles audit, turn, approval, boundary, held-event, model, mode, and write-admission truth", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-runtime-crash-reconcile-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(createdAt)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(selectedState(sessionA, threadA, "idle", "none", "plan", "runtime-a", "high"));
    states.create(selectedState(sessionB, threadB, "waiting_for_approval", "needs_approval", "default", "runtime-b", "medium"));
    const auditRepository = createSelectedAuditRepository(open.db);
    const wall = advancingWallClock("2026-07-16T15:00:00.000Z");
    const resourceBudget = resolveResourceBudget({
      protocol_reconnect_initial_delay_ms: 10,
      protocol_reconnect_max_delay_ms: 100
    });
    const publications: string[] = [];
    const readyNotificationGate = deferred<void>();
    let blockReadyNotification = false;
    let readyNotificationCommitted = false;
    const append = createProductionProjectionAppendPort({
      repository: states,
      async publish(committed) {
        publications.push(`${committed.event.event.session_id}:${committed.event.event.type}:${committed.event.event.cursor}`);
        if (
          blockReadyNotification &&
          committed.event.event.codex_event_type === "thread/name/updated"
        ) {
          readyNotificationCommitted = true;
          await readyNotificationGate.promise;
        }
      }
    });
    const continuity = createProductionProjectionContinuityPort({
      repository: states,
      publish(committed) {
        publications.push(`${committed.event.event.session_id}:boundary:${committed.event.event.cursor}`);
      }
    });

    const modelClient = fakeModelClient();
    const modelControl = createCodexModelControlService({
      models: modelClient,
      states,
      now: wall.now
    });
    const planControl = createCodexPlanControlService({
      plans: fakePlanClient(),
      models: modelControl,
      states,
      now: wall.now
    });
    let approvalService: CodexApprovalControlService | null = null;
    const observedApprovals: Array<{ readonly generation: number; readonly request_id: string }> = [];
    const backgroundErrors: Error[] = [];
    const pipeline = createCodexEventPipeline({
      repository: states,
      append_port: append,
      normalizer: { now: wall.now },
      max_pending_notifications: resourceBudget.protocol_max_pending_notifications,
      async observe_event(event) {
        await planControl.observeEvent(event);
        await approvalService?.observeEvent(event);
      }
    });

    const runtimeState = { crashed: false, emittedHeldGeneration: 0 };
    const transport = runtimeTransport(runtimeState, wall);
    let injectedReadyNotification = false;
    const lifecycle = createCodexRuntimeReconciliationLifecycle({
      approvals: {
        async disconnect(generation) {
          if (approvalService === null) throw new Error("Approval service was not composed.");
          return approvalService.disconnect(generation);
        }
      },
      audit: {
        reconcile(input) {
          return runStartupAuditOrphanReconciliation({
            db: open.db,
            eligible_before: input.eligible_before,
            reconciled_at: input.reconciled_at,
            signal: input.deadline.signal,
            timeout_ms: input.deadline.timeoutMs(2_000)
          });
        }
      },
      continuity,
      events: {
        reconcile: (input) => pipeline.reconcile(input.threads, input.signal),
        async barrier(input) {
          if (input.generation < 1) throw new Error("Invalid integration generation.");
          if (input.generation === 2 && !injectedReadyNotification) {
            injectedReadyNotification = true;
            blockReadyNotification = true;
            transport.receive(JSON.stringify({
              method: "thread/name/updated",
              params: { threadId: threadA, threadName: "Recovered during ready" }
            }));
          }
          await pipeline.barrier(input.signal);
        }
      },
      now: wall.now,
      plans: { rehydrate: (target) => planControl.rehydrate(target) },
      projection: append,
      repository: states,
      resource_budget: resourceBudget
    });

    let controller!: CodexRuntimeReconnectController;
    const pendingPipeline = new Set<Promise<unknown>>();
    controller = createCodexRuntimeReconnectController({
      transport,
      observed_version: "0.144.0",
      resource_budget: resourceBudget,
      lifecycle: {
        disconnected: lifecycle.disconnected,
        reconcile: lifecycle.reconcile,
        resubscribe: lifecycle.resubscribe,
        ready: lifecycle.ready
      },
      random: () => 0,
      on_notification(message) {
        const operation = pipeline.consume(message, controller.generation);
        pendingPipeline.add(operation);
        void operation.then(
          () => pendingPipeline.delete(operation),
          (error: unknown) => {
            pendingPipeline.delete(operation);
            backgroundErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        );
      },
      on_server_request(message) {
        if (approvalService === null) throw new Error("Approval service was not composed.");
        const registered = approvalService.register(message);
        observedApprovals.push({
          generation: controller.generation,
          request_id: registered.target.request_id
        });
      },
      on_background_error(error) {
        backgroundErrors.push(error);
      }
    });
    controllers.push(controller);
    approvalService = createCodexApprovalControlService({
      approvals: createCodexApprovalClient(controller),
      states,
      now: wall.now,
      expiry_ms: 120_000,
      on_background_error(error) {
        backgroundErrors.push(error);
      }
    });
    approvalsToClose.push(approvalService);

    try {
      await controller.start();
      expect(controller.snapshot()).toMatchObject({ phase: "ready", admitted_generation: 1 });
      expect(lifecycle.snapshot()).toMatchObject({
        phase: "ready",
        generation: 1,
        boundary_count: 2,
        resumed_count: 2,
        ready_count: 2
      });
      expect((await planControl.snapshot(target(sessionA, threadA))).current).toMatchObject({
        state: "confirmed",
        mode: "plan",
        runtime_model: "runtime-a",
        reasoning_effort: "high"
      });

      transport.receive(JSON.stringify({
        method: "turn/started",
        params: { threadId: threadA, turn: rawTurn("turn-crash-reconcile-a", "inProgress", "full") }
      }));
      await pipeline.barrier();
      expect(states.require(sessionA).projection.session.turn_state).toBe("in_progress");

      transport.receive(approvalFrame("approval-generation-one", threadB, "turn-crash-reconcile-b", wall.current_ms));
      await waitFor(() => observedApprovals.some((approval) => approval.generation === 1));
      const firstApproval = observedApprovals.find((approval) => approval.generation === 1);
      expect(firstApproval).toBeDefined();
      expect(await approvalService.snapshot({
        type: "approval",
        session_id: sessionB,
        codex_thread_id: threadB,
        request_id: firstApproval?.request_id
      })).toMatchObject({ state: "pending" });

      const operationId = "op_runtime_crash_reconcile_0001";
      auditRepository.recordAccepted({
        id: "audit:runtime:crash:accepted",
        operation_id: operationId,
        at: wall.now(),
        actor: { type: "system", device_id: null, permission: null, origin: null },
        action: "prompt",
        target: target(sessionA, threadA),
        phase: "accepted",
        outcome: "accepted",
        payload_summary: { source: "runtime_crash_integration", text_length: 8 },
        error_code: null
      });

      const ambiguousMutation = controller.request({
        method: "turn/start",
        params: { threadId: threadA, hold: true },
        kind: "mutation"
      });
      runtimeState.crashed = true;
      transport.disconnect("private runtime crash detail");
      await expect(ambiguousMutation).rejects.toMatchObject({
        code: "unknown_outcome",
        outcome: "unknown",
        retry_safe: false
      });
      await expect(
        controller.request({ method: "turn/start", params: { threadId: threadA }, kind: "mutation" })
      ).rejects.toMatchObject({ code: "transport_not_open", outcome: "not_sent" });

      await waitFor(() => readyNotificationCommitted, 5_000);
      expect(controller.snapshot()).toMatchObject({ phase: "resubscribing", admitted_generation: null });
      expect(pendingPipeline.size).toBe(1);
      readyNotificationGate.resolve();
      await waitFor(() => controller.snapshot().phase === "ready" && controller.generation === 2, 5_000);
      await pipeline.barrier();
      expect(backgroundErrors).toEqual([]);
      expect(pendingPipeline.size).toBe(0);

      const auditTrail = auditRepository.require(operationId);
      expect(auditTrail.records.map((record) => record.outcome)).toEqual(["accepted", "incomplete"]);
      expect(auditTrail.records[1]).toMatchObject({
        error_code: "runtime_unavailable",
        payload_summary: { reason: "host_restart_without_terminal" }
      });
      expect(await approvalService.snapshot({
        type: "approval",
        session_id: sessionB,
        codex_thread_id: threadB,
        request_id: firstApproval?.request_id
      })).toMatchObject({ state: "superseded", decision: null });
      const secondApproval = observedApprovals.find((approval) => approval.generation === 2);
      expect(secondApproval).toBeDefined();
      expect(await approvalService.snapshot({
        type: "approval",
        session_id: sessionB,
        codex_thread_id: threadB,
        request_id: secondApproval?.request_id
      })).toMatchObject({ state: "pending", decision: null });

      expect(states.require(sessionA).projection.session).toMatchObject({
        turn_state: "interrupted",
        attention: "stuck",
        freshness: "current",
        model: "runtime-a",
        settings: {
          collaboration_mode: "plan",
          runtime_model: "runtime-a",
          reasoning_effort: "high"
        }
      });
      expect(states.require(sessionB).projection.session).toMatchObject({
        turn_state: "waiting_for_approval",
        attention: "needs_approval",
        freshness: "current",
        model: "runtime-b",
        settings: {
          collaboration_mode: "default",
          runtime_model: "runtime-b",
          reasoning_effort: "medium"
        }
      });
      const eventsA = states.listEvents(sessionA).events;
      expect(eventsA[0]).toMatchObject({ type: "replay_boundary", reason: "disconnect" });
      expect(eventsA.map((event) => event.type)).toEqual(["replay_boundary", "activity", "runtime"]);
      expect(eventsA.at(-1)).toMatchObject({ type: "runtime", state: "ready" });
      expect((await planControl.snapshot(target(sessionA, threadA))).current).toMatchObject({
        state: "confirmed",
        mode: "plan"
      });

      await expect(controller.request({
        method: "turn/start",
        params: { threadId: threadA, hold: false },
        kind: "mutation"
      })).resolves.toEqual({ accepted: true });
      const methods = sentMethods(transport);
      expect(methods.filter((method) => method === "thread/resume")).toHaveLength(4);
      expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
      expect(controller.snapshot()).toMatchObject({
        phase: "ready",
        admitted_generation: 2,
        completed_reconnects: 1,
        disconnect_cleanups: 1,
        last_failure: null
      });
      expect(lifecycle.snapshot()).toMatchObject({
        phase: "ready",
        generation: 2,
        gap_reason: "disconnect",
        continuity: "boundary_required",
        boundary_count: 2,
        resumed_count: 2,
        ready_count: 2,
        approvals_superseded: 1,
        audits_reconciled: 1,
        last_failure: null
      });
      const publicJson = JSON.stringify({ controller: controller.snapshot(), lifecycle: lifecycle.snapshot() });
      for (const privateValue of ["private runtime", threadA, sessionA, "/tmp/", "runtime-a", "approval-generation"]) {
        expect(publicJson).not.toContain(privateValue);
      }
      expect(publications.length).toBeGreaterThan(8);
    } finally {
      open.db.close();
    }
  });
});

function runtimeTransport(
  state: { crashed: boolean; emittedHeldGeneration: number },
  wall: ReturnType<typeof advancingWallClock>
): ScriptedCodexTransport {
  return new ScriptedCodexTransport({
    on_send(text, transport) {
      const message = JSON.parse(text) as {
        readonly id?: number;
        readonly method?: string;
        readonly params?: Record<string, unknown>;
      };
      if (message.method === "initialize") {
        transport.receive(JSON.stringify({
          id: message.id,
          result: {
            userAgent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
            codexHome: "/tmp/codex-home",
            platformFamily: "unix",
            platformOs: "linux"
          }
        }));
        return;
      }
      if (message.method === "collaborationMode/list") {
        transport.receive(JSON.stringify({
          id: message.id,
          result: { data: [{ name: "Default" }, { name: "Plan" }] }
        }));
        return;
      }
      if (message.method === "thread/list") {
        const archived = message.params?.archived === true;
        const data = archived ? [] : [runtimeThread(threadA, state.crashed), runtimeThread(threadB, state.crashed)];
        transport.receive(JSON.stringify({
          id: message.id,
          result: {
            data,
            nextCursor: null,
            backwardsCursor: data.length === 0 ? null : `threads-${transport.generation}`
          }
        }));
        return;
      }
      const threadId = typeof message.params?.threadId === "string" ? message.params.threadId : null;
      if (message.method === "thread/read" && threadId !== null) {
        transport.receive(JSON.stringify({ id: message.id, result: { thread: runtimeThread(threadId, state.crashed) } }));
        return;
      }
      if (message.method === "thread/goal/get") {
        transport.receive(JSON.stringify({ id: message.id, result: { goal: null } }));
        return;
      }
      if (message.method === "thread/turns/list" && threadId !== null) {
        const latest = threadId === threadB
          ? rawTurn("turn-crash-reconcile-b", "inProgress", "notLoaded")
          : null;
        transport.receive(JSON.stringify({
          id: message.id,
          result: {
            data: latest === null ? [] : [latest],
            nextCursor: null,
            backwardsCursor: latest === null ? null : `turn-${transport.generation}-${threadId}`
          }
        }));
        return;
      }
      if (message.method === "thread/resume" && threadId !== null) {
        if (state.crashed && threadId === threadB && state.emittedHeldGeneration !== transport.generation) {
          state.emittedHeldGeneration = transport.generation;
          transport.receive(approvalFrame(
            "approval-generation-two",
            threadB,
            "turn-crash-reconcile-b",
            wall.current_ms
          ));
        }
        transport.receive(JSON.stringify({ id: message.id, result: rawResume(threadId) }));
        return;
      }
      if (message.method === "turn/start") {
        if (message.params?.hold === true) return;
        transport.receive(JSON.stringify({ id: message.id, result: { accepted: true } }));
      }
    }
  });
}

function runtimeThread(threadId: string, crashed: boolean): Record<string, unknown> {
  const isA = threadId === threadA;
  const status = isA
    ? { type: "idle" }
    : { type: "active", activeFlags: ["waitingOnApproval"] };
  return {
    id: threadId,
    extra: null,
    sessionId: `runtime-${threadId}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: Date.parse(createdAt) / 1_000,
    updatedAt: Date.parse(createdAt) / 1_000 + (crashed ? 20 : 10),
    recencyAt: Date.parse(createdAt) / 1_000 + (crashed ? 20 : 10),
    status,
    path: `/tmp/${threadId}.jsonl`,
    cwd: isA ? `/tmp/${sessionA}` : `/tmp/${sessionB}`,
    cliVersion: "0.144.0",
    source: "appServer",
    threadSource: "hostdeck:managed",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: threadId,
    turns: []
  };
}

function rawTurn(
  turnId: string,
  status: "completed" | "inProgress",
  itemsView: "full" | "notLoaded"
): Record<string, unknown> {
  return {
    id: turnId,
    items: [],
    itemsView,
    status,
    error: null,
    startedAt: Date.parse("2026-07-16T14:30:00.000Z") / 1_000,
    completedAt: status === "inProgress" ? null : Date.parse("2026-07-16T14:31:00.000Z") / 1_000,
    durationMs: status === "inProgress" ? null : 60_000
  };
}

function rawResume(threadId: string): Record<string, unknown> {
  const isA = threadId === threadA;
  return {
    thread: {
      id: threadId,
      cwd: isA ? `/tmp/${sessionA}` : `/tmp/${sessionB}`,
      turns: []
    },
    model: isA ? "runtime-a" : "runtime-b",
    modelProvider: "openai",
    serviceTier: null,
    cwd: isA ? `/tmp/${sessionA}` : `/tmp/${sessionB}`,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    activePermissionProfile: null,
    reasoningEffort: isA ? "high" : "medium",
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: null
  };
}

function approvalFrame(
  id: string,
  threadId: string,
  turnId: string,
  startedAtMs: number
): string {
  return JSON.stringify({
    method: "item/commandExecution/requestApproval",
    id,
    params: {
      threadId,
      turnId,
      itemId: `item-${id}`,
      startedAtMs,
      approvalId: null,
      environmentId: null,
      reason: "The sandbox requires confirmation.",
      networkApprovalContext: null,
      command: "printf integration",
      cwd: threadId === threadA ? `/tmp/${sessionA}` : `/tmp/${sessionB}`,
      commandActions: [],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ["accept", "decline"]
    }
  });
}

function selectedState(
  sessionId: string,
  threadId: string,
  turnState: "idle" | "waiting_for_approval",
  attention: "needs_approval" | "none",
  mode: "default" | "plan",
  model: string,
  effort: string
) {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: sessionId.replace("sess_", "session-"),
    codex_thread_id: threadId,
    cwd: `/tmp/${sessionId}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
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
      turn_state: turnState,
      attention,
      freshness: "current",
      freshness_reason: null,
      updated_at: createdAt,
      last_activity_at: createdAt,
      branch: "main",
      model,
      settings: {
        collaboration_mode: mode,
        runtime_model: model,
        reasoning_effort: effort,
        observed_at: createdAt
      },
      goal: null,
      recent_summary: "Managed runtime integration state.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function fakeModelClient(): CodexModelClient {
  return {
    runtime_version: "0.144.0",
    async listCatalog() {
      return {
        revision: "a".repeat(64),
        observed_at: createdAt as never,
        models: [{
          id: "model-a",
          runtime_model: "runtime-a",
          label: "Model A",
          description: null,
          is_default: true,
          input_modalities: ["text"],
          reasoning_efforts: [{ id: "high", description: null, is_default: true }]
        }]
      };
    },
    async readCurrent(threadId) {
      const isA = threadId === threadA;
      return {
        thread_id: threadId as never,
        cwd: (isA ? `/tmp/${sessionA}` : `/tmp/${sessionB}`) as never,
        runtime_model: isA ? "runtime-a" : "runtime-b",
        reasoning_effort: isA ? "high" : "medium"
      };
    },
    async startTurn() {
      throw new Error("Runtime reconciliation must not start a model turn.");
    }
  };
}

function fakePlanClient(): CodexPlanClient {
  return {
    runtime_version: "0.144.0",
    async listCatalog() {
      return {
        revision: "b".repeat(64),
        observed_at: createdAt as never,
        modes: [
          { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null },
          { name: "Plan", mode: "plan", preset_model: null, preset_reasoning_effort: "medium" }
        ]
      };
    },
    async startTurn() {
      throw new Error("Runtime reconciliation must not start a Plan turn.");
    }
  };
}

function target(sessionId: string, threadId: string) {
  return {
    type: "managed_session" as const,
    session_id: sessionId,
    codex_thread_id: threadId
  };
}

function advancingWallClock(initial: string) {
  let currentMs = Date.parse(initial);
  return {
    get current_ms() {
      return currentMs;
    },
    now() {
      const value = new Date(currentMs).toISOString();
      currentMs += 1_000;
      return value;
    }
  };
}

function sentMethods(transport: ScriptedCodexTransport): string[] {
  return transport.sent_frames.flatMap((frame) => {
    const method = (JSON.parse(frame) as { readonly method?: unknown }).method;
    return typeof method === "string" ? [method] : [];
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for runtime crash reconciliation.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
