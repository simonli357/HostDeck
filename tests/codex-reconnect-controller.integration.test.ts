import { afterEach, describe, expect, it } from "vitest";
import {
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
import type { SelectedSessionState } from "../packages/storage/src/index.js";

const observedAt = "2026-07-16T12:00:00.000Z";
const target = {
  session_id: "sess_reconnect_approval_001",
  codex_thread_id: "thread-reconnect-approval-001"
} as const;

const controllers: CodexRuntimeReconnectController[] = [];
const approvalServices: CodexApprovalControlService[] = [];

afterEach(async () => {
  for (const service of approvalServices.splice(0)) service.close();
  await Promise.all(controllers.splice(0).map((controller) => controller.close()));
});

describe("Codex reconnect controller integration", () => {
  it("orders real approval supersession, read-only reconciliation, resubscription, and write readmission", async () => {
    const transport = respondingTransport();
    const order: string[] = [];
    const initialReconcileGate = deferred<void>();
    const runtimeState = { value: "disconnected" as "disconnected" | "reconciling" | "ready" };
    let initialReconcileBlocked = false;
    let approvalService: CodexApprovalControlService | null = null;
    const registered: Array<ReturnType<CodexApprovalControlService["register"]>> = [];
    const callbackWrites: Promise<unknown>[] = [];
    const controller = createCodexRuntimeReconnectController({
      transport,
      observed_version: "0.144.0",
      resource_budget: resolveResourceBudget({
        protocol_reconnect_initial_delay_ms: 10,
        protocol_reconnect_max_delay_ms: 100
      }),
      random: () => 0,
      lifecycle: {
        async disconnected(input) {
          runtimeState.value = "disconnected";
          order.push(`disconnected:${input.generation}`);
          const superseded = (await approvalService?.disconnect(input.generation)) ?? 0;
          order.push(`superseded:${input.generation}:${superseded}`);
        },
        async reconcile(input) {
          runtimeState.value = "reconciling";
          order.push(`reconcile:${input.generation}`);
          await expect(
            input.runtime.request({ method: "turn/start", params: {}, kind: "mutation" } as never)
          ).rejects.toMatchObject({ code: "invalid_contract" });
          await expect(
            input.runtime.request({ method: "thread/list", params: {}, kind: "read" })
          ).resolves.toEqual({ data: [] });
          if (input.generation === 1) {
            initialReconcileBlocked = true;
            await initialReconcileGate.promise;
          }
          return { continuity: input.generation === 1 ? "continuous" : "boundary_required" };
        },
        resubscribe(input) {
          order.push(`resubscribe:${input.generation}`);
        },
        ready(input) {
          runtimeState.value = "ready";
          order.push(`ready:${input.generation}`);
        }
      },
      on_server_request(message) {
        if (approvalService === null) throw new Error("Approval service is not composed.");
        registered.push(approvalService.register(message));
        const blockedWrite = controller.request({ method: "turn/start", params: {}, kind: "mutation" });
        void blockedWrite.catch(() => undefined);
        callbackWrites.push(blockedWrite);
      },
      on_background_error(error) {
        throw error;
      }
    });
    controllers.push(controller);

    const state = selectedState();
    approvalService = createCodexApprovalControlService({
      approvals: createCodexApprovalClient(controller),
      states: {
        get: (sessionId) => (sessionId === target.session_id ? state : null),
        getByThreadId: (threadId) => (threadId === target.codex_thread_id ? state : null)
      },
      now: () => observedAt,
      on_background_error(error) {
        throw error;
      }
    });
    approvalServices.push(approvalService);

    const starting = controller.start();
    await waitFor(() => initialReconcileBlocked);
    expect(controller.compatibility).toMatchObject({ state: "degraded", mutation_policy: "blocked" });
    transport.receive(approvalFrame("approval-before-disconnect"));
    expect(controller.snapshot().held_server_requests).toBe(1);
    expect(registered).toHaveLength(0);
    initialReconcileGate.resolve();
    await starting;

    expect(runtimeState.value).toBe("ready");
    await waitFor(() => registered.length === 1);
    expect(callbackWrites).toHaveLength(1);
    await expect(callbackWrites[0]).rejects.toMatchObject({ code: "transport_not_open", outcome: "not_sent" });
    expect(await approvalService.snapshot(registered[0]?.target as never)).toMatchObject({ state: "pending" });

    const mutation = controller.request({
      method: "turn/start",
      params: { threadId: target.codex_thread_id, input: [] },
      kind: "mutation"
    });
    transport.disconnect("runtime restart with private detail");
    await expect(mutation).rejects.toMatchObject({
      code: "unknown_outcome",
      outcome: "unknown",
      retry_safe: false
    });
    await expect(
      controller.request({ method: "turn/start", params: {}, kind: "mutation" })
    ).rejects.toMatchObject({ code: "transport_not_open", outcome: "not_sent" });

    await waitFor(() => order.includes("superseded:1:1"));
    await waitFor(() => controller.snapshot().phase === "ready" && controller.generation === 2);

    expect(runtimeState.value).toBe("ready");
    expect(await approvalService.snapshot(registered[0]?.target as never)).toMatchObject({
      state: "superseded",
      decision: null
    });
    expect(order).toEqual([
      "reconcile:1",
      "resubscribe:1",
      "ready:1",
      "disconnected:1",
      "superseded:1:1",
      "reconcile:2",
      "resubscribe:2",
      "ready:2"
    ]);
    const methods = sentMethods(transport);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(methods.filter((method) => method === "collaborationMode/list")).toHaveLength(2);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({
      admitted_generation: 2,
      completed_reconnects: 1,
      disconnect_cleanups: 1,
      last_failure: null
    });
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/private detail|approval-before-disconnect/u);
  });
});

function respondingTransport(): ScriptedCodexTransport {
  return new ScriptedCodexTransport({
    on_send(text, transport) {
      const message = JSON.parse(text) as {
        readonly id?: number;
        readonly method?: string;
      };
      if (message.method === "initialize") {
        transport.receive(
          JSON.stringify({
            id: message.id,
            result: {
              userAgent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "linux"
            }
          })
        );
      } else if (message.method === "collaborationMode/list") {
        transport.receive(
          JSON.stringify({
            id: message.id,
            result: { data: [{ name: "Default" }, { name: "Plan" }] }
          })
        );
      } else if (message.method === "thread/list") {
        transport.receive(JSON.stringify({ id: message.id, result: { data: [] } }));
      }
    }
  });
}

function approvalFrame(id: string): string {
  return JSON.stringify({
    method: "item/commandExecution/requestApproval",
    id,
    params: {
      threadId: target.codex_thread_id,
      turnId: "turn-reconnect-approval-001",
      itemId: "item-reconnect-approval-001",
      startedAtMs: Date.parse(observedAt),
      approvalId: null,
      environmentId: null,
      reason: "The sandbox blocks this command.",
      networkApprovalContext: null,
      command: "touch /tmp/hostdeck-reconnect-approved",
      cwd: "/tmp/approval-project",
      commandActions: [],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ["accept", "decline"]
    }
  });
}

function selectedState(): SelectedSessionState {
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: target.session_id,
      name: "reconnect-approval",
      codex_thread_id: target.codex_thread_id,
      cwd: "/tmp/approval-project",
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      disposition: "selected",
      created_at: observedAt,
      updated_at: observedAt,
      archived_at: null
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: target.session_id,
        name: "reconnect-approval",
        codex_thread_id: target.codex_thread_id,
        cwd: "/tmp/approval-project",
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        created_at: observedAt,
        archived_at: null,
        session_state: "active",
        turn_state: "waiting_for_approval",
        attention: "needs_approval",
        freshness: "current",
        freshness_reason: null,
        updated_at: observedAt,
        last_activity_at: observedAt,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "Codex is waiting for approval.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

function sentMethods(transport: ScriptedCodexTransport): string[] {
  return transport.sent_frames.flatMap((frame) => {
    const method = (JSON.parse(frame) as { readonly method?: unknown }).method;
    return typeof method === "string" ? [method] : [];
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for reconnect integration state.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
