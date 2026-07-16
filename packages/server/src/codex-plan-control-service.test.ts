import {
  type CodexModelCatalog,
  type CodexModelClient,
  type CodexPlanCatalog,
  type CodexPlanClient,
  type CodexPlanTurnAccepted,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  type ModelCatalogEntry,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexModelControlStatePort,
  createCodexModelControlService
} from "./codex-model-control-service.js";
import {
  type CodexPlanControlStatePort,
  createCodexPlanControlService,
  HostDeckCodexPlanControlError
} from "./codex-plan-control-service.js";

const observedAt = "2026-07-10T21:00:00.000Z";
const targetA = {
  type: "managed_session",
  session_id: "sess_plan_a",
  codex_thread_id: "thread-plan-a"
} as const;
const targetB = {
  type: "managed_session",
  session_id: "sess_plan_b",
  codex_thread_id: "thread-plan-b"
} as const;

describe("Codex pending Plan control", () => {
  it("stores a revisioned next-turn mode without starting a zero-turn toggle", async () => {
    const harness = createHarness();
    expect((await harness.planService.snapshot(targetA)).current).toEqual({
      state: "unknown",
      mode: null,
      runtime_model: null,
      reasoning_effort: null,
      observed_at: null
    });

    const selected = await harness.planService.select(planIntent("enter"));
    expect(selected.pending).toMatchObject({
      revision: 1,
      mode: "plan",
      phase: "pending",
      turn_id: null,
      resolved_settings: null,
      error: null
    });
    expect(harness.plans.startCalls).toHaveLength(0);
    expect(harness.planService.readPendingSettings(targetA as never)).toEqual([
      { control: "plan", revision: 1, phase: "pending" }
    ]);
  });

  it("uses a confirmed settings event for a truthful same-mode no-op", async () => {
    const harness = createHarness();
    await harness.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const same = await harness.planService.select(planIntent("exit"));
    expect(same.current).toMatchObject({ state: "confirmed", mode: "default", runtime_model: "runtime-a" });
    expect(same.pending).toBeNull();
    expect(harness.plans.startCalls).toHaveLength(0);
  });

  it("composes pending model and Plan revisions into one collaboration-only turn", async () => {
    const harness = createHarness();
    await harness.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const selectedModel = await harness.modelService.select(modelIntent());
    const modelRevision = selectedModel.pending?.revision ?? 0;
    const selectedPlan = await harness.planService.select(planIntent("enter"));
    const planRevision = selectedPlan.pending?.revision ?? 0;

    const accepted = await harness.planService.dispatchPendingTurn(planTurn(planRevision, modelRevision));
    expect(accepted).toEqual({
      thread_id: targetA.codex_thread_id,
      turn_id: "turn-plan-a",
      state: "accepted",
      plan_revision: planRevision,
      model_revision: modelRevision
    });
    expect(harness.plans.startCalls).toEqual([
      expect.objectContaining({
        operation_id: "op_plan_prompt_0001",
        thread_id: targetA.codex_thread_id,
        text: "Produce a concise implementation plan.",
        mode: expect.objectContaining({ mode: "plan" }),
        runtime_model: "runtime-b",
        reasoning_effort: "low"
      })
    ]);
    expect((await harness.planService.snapshot(targetA)).pending).toMatchObject({
      revision: planRevision,
      phase: "awaiting_confirmation",
      turn_id: "turn-plan-a",
      resolved_settings: { runtime_model: "runtime-b", reasoning_effort: "low" }
    });
    expect((await harness.modelService.snapshot(targetA)).pending).toMatchObject({
      revision: modelRevision,
      phase: "awaiting_confirmation",
      turn_id: "turn-plan-a"
    });

    harness.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    await harness.planService.observeEvent(settingsEvent("plan", "runtime-b", "low"));
    expect((await harness.planService.snapshot(targetA)).pending).toBeNull();
    expect((await harness.modelService.snapshot(targetA)).pending).toBeNull();

    await harness.planService.observeEvent(planDeltaEvent("turn-plan-a", "Inspect contracts, then implement."));
    await harness.planService.observeEvent(turnCompletedEvent("turn-plan-a", "completed"));
    expect((await harness.planService.snapshot(targetA)).execution).toMatchObject({
      turn_id: "turn-plan-a",
      state: "complete",
      evidence: "plan_delta",
      summary: "Inspect contracts, then implement."
    });
  });

  it("exits Plan only through a later explicit Default turn", async () => {
    const harness = createHarness();
    harness.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    await harness.planService.observeEvent(settingsEvent("plan", "runtime-b", "low"));
    const selected = await harness.planService.select(planIntent("exit"));
    expect(harness.plans.startCalls).toHaveLength(0);

    const accepted = await harness.planService.dispatchPendingTurn(planTurn(selected.pending?.revision ?? 0, null));
    expect(accepted.model_revision).toBeNull();
    expect(harness.plans.startCalls[0]).toMatchObject({
      mode: { mode: "default" },
      runtime_model: "runtime-b",
      reasoning_effort: null
    });
    await harness.planService.observeEvent(settingsEvent("default", "runtime-b", null));
    expect(await harness.planService.snapshot(targetA)).toMatchObject({
      current: { state: "confirmed", mode: "default" },
      pending: null
    });
  });

  it("rolls both controls back on known rejection and latches both on possible send", async () => {
    const rejected = createHarness();
    await rejected.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const rejectedModel = await rejected.modelService.select(modelIntent());
    const rejectedPlan = await rejected.planService.select(planIntent("enter"));
    rejected.plans.startError = new HostDeckCodexAdapterError("remote_error", "Turn already active.", {
      outcome: "remote_rejected",
      retry_safe: true
    });
    await expectPlanError(
      rejected.planService.dispatchPendingTurn(
        planTurn(rejectedPlan.pending?.revision ?? 0, rejectedModel.pending?.revision ?? 0)
      ),
      "operation_conflict"
    );
    expect((await rejected.planService.snapshot(targetA)).pending).toMatchObject({ phase: "pending", resolved_settings: null });
    expect((await rejected.modelService.snapshot(targetA)).pending).toMatchObject({ phase: "pending" });

    const uncertain = createHarness();
    await uncertain.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const uncertainModel = await uncertain.modelService.select(modelIntent());
    const uncertainPlan = await uncertain.planService.select(planIntent("enter"));
    uncertain.plans.startError = new HostDeckCodexAdapterError("request_timeout", "Turn response timed out.", {
      outcome: "unknown",
      retry_safe: false
    });
    const modelRevision = uncertainModel.pending?.revision ?? 0;
    const planRevision = uncertainPlan.pending?.revision ?? 0;
    await expectPlanError(uncertain.planService.dispatchPendingTurn(planTurn(planRevision, modelRevision)), "unknown_outcome");
    expect((await uncertain.planService.snapshot(targetA)).pending).toMatchObject({ phase: "unknown" });
    expect((await uncertain.modelService.snapshot(targetA)).pending).toMatchObject({ phase: "unknown" });
    await expectPlanError(uncertain.planService.dispatchPendingTurn(planTurn(planRevision, modelRevision)), "operation_conflict");

    uncertain.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    await uncertain.planService.observeEvent(settingsEvent("plan", "runtime-b", "low"));
    expect((await uncertain.planService.snapshot(targetA)).pending).toBeNull();
    expect((await uncertain.modelService.snapshot(targetA)).pending).toBeNull();

    const malformed = createHarness();
    await malformed.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const malformedPlan = await malformed.planService.select(planIntent("enter"));
    malformed.plans.startError = new HostDeckCodexAdapterError(
      "invalid_protocol_message",
      "The Plan turn response was malformed.",
      { outcome: "not_applicable", retry_safe: false }
    );
    await expectPlanError(
      malformed.planService.dispatchPendingTurn(planTurn(malformedPlan.pending?.revision ?? 0, null)),
      "unknown_outcome"
    );
    expect((await malformed.planService.snapshot(targetA)).pending).toMatchObject({ phase: "unknown" });

    const disconnected = createHarness();
    await disconnected.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const disconnectedPlan = await disconnected.planService.select(planIntent("enter"));
    disconnected.plans.startError = new HostDeckCodexAdapterError("transport_closed", "The runtime disconnected.", {
      outcome: "unknown",
      retry_safe: false
    });
    await expectPlanError(
      disconnected.planService.dispatchPendingTurn(planTurn(disconnectedPlan.pending?.revision ?? 0, null)),
      "unknown_outcome"
    );
    expect((await disconnected.planService.snapshot(targetA)).pending).toMatchObject({ phase: "unknown" });
  });

  it("treats malformed collaboration reads as protocol failures without a mutation claim", async () => {
    const harness = createHarness();
    harness.plans.listError = new HostDeckCodexAdapterError(
      "invalid_protocol_message",
      "The collaboration catalog was malformed.",
      { outcome: "not_applicable", retry_safe: false }
    );
    await expectPlanError(harness.planService.snapshot(targetA), "runtime_protocol_error");
    expect(harness.planService.pending_count).toBe(0);
  });

  it("does not resurrect either revision when settings arrive before turn/start resolves", async () => {
    const harness = createHarness();
    await harness.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const selectedModel = await harness.modelService.select(modelIntent());
    const selectedPlan = await harness.planService.select(planIntent("enter"));
    const deferred = deferredResult<CodexPlanTurnAccepted>();
    harness.plans.startResult = deferred.promise;
    const dispatch = harness.planService.dispatchPendingTurn(
      planTurn(selectedPlan.pending?.revision ?? 0, selectedModel.pending?.revision ?? 0)
    );
    await waitFor(() => harness.plans.startCalls.length === 1);
    harness.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    const observation = harness.planService.observeEvent(settingsEvent("plan", "runtime-b", "low"));
    await Promise.resolve();
    deferred.resolve({ thread_id: targetA.codex_thread_id as CodexThreadId, turn_id: "turn-plan-a" as never, state: "accepted" });
    await dispatch;
    await observation;
    expect((await harness.planService.snapshot(targetA)).pending).toBeNull();
    expect((await harness.modelService.snapshot(targetA)).pending).toBeNull();
  });

  it("settles both revisions from early matching settings even when the response is a known rejection", async () => {
    const harness = createHarness();
    await harness.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const selectedModel = await harness.modelService.select(modelIntent());
    const selectedPlan = await harness.planService.select(planIntent("enter"));
    const deferred = deferredResult<CodexPlanTurnAccepted>();
    harness.plans.startResult = deferred.promise;
    const dispatch = harness.planService.dispatchPendingTurn(
      planTurn(selectedPlan.pending?.revision ?? 0, selectedModel.pending?.revision ?? 0)
    );
    await waitFor(() => harness.plans.startCalls.length === 1);
    harness.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    const observation = harness.planService.observeEvent(settingsEvent("plan", "runtime-b", "low"));
    deferred.reject(
      new HostDeckCodexAdapterError("remote_error", "The turn was rejected after settings changed.", {
        outcome: "remote_rejected",
        retry_safe: true
      })
    );
    await expectPlanError(dispatch, "operation_conflict");
    await observation;
    expect((await harness.planService.snapshot(targetA)).pending).toBeNull();
    expect((await harness.modelService.snapshot(targetA)).pending).toBeNull();
  });

  it("surfaces settings contradiction and a completed Plan turn without plan evidence", async () => {
    const harness = createHarness();
    await harness.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    const selected = await harness.planService.select(planIntent("enter"));
    await harness.planService.dispatchPendingTurn(planTurn(selected.pending?.revision ?? 0, null));
    await harness.planService.observeEvent(settingsEvent("default", "runtime-a", "high"));
    expect((await harness.planService.snapshot(targetA)).pending).toMatchObject({
      phase: "conflict",
      error: { code: "operation_conflict" }
    });

    await harness.planService.observeEvent(turnCompletedEvent("turn-plan-a", "completed"));
    expect((await harness.planService.snapshot(targetA)).execution).toMatchObject({
      state: "unknown",
      evidence: "none",
      summary: "Plan turn completed without plan-specific event evidence."
    });
  });

  it("rejects stale revisions, active turns, mismatched targets, and pending-model snapshot drift", async () => {
    const harness = createHarness();
    const selected = await harness.planService.select(planIntent("enter"));
    await expectPlanError(
      harness.planService.select(planIntent("exit", { expected_pending_revision: (selected.pending?.revision ?? 0) + 1 })),
      "operation_conflict"
    );
    await expectPlanError(
      harness.planService.snapshot({ ...targetA, codex_thread_id: "thread-other" }),
      "target_mismatch"
    );

    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    await expectPlanError(harness.planService.dispatchPendingTurn(planTurn(selected.pending?.revision ?? 0, null)), "operation_conflict");
    expect(harness.plans.startCalls).toHaveLength(0);

    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id));
    await harness.modelService.select(modelIntent());
    await expectPlanError(harness.planService.dispatchPendingTurn(planTurn(selected.pending?.revision ?? 0, null)), "operation_conflict");
    expect(harness.plans.startCalls).toHaveLength(0);
  });

  it("reserves global capacity across concurrent catalog reads and isolates sessions", async () => {
    const harness = createHarness({ includeSecondState: true, maxPendingSelections: 1 });
    const deferred = deferredResult<CodexPlanCatalog>();
    harness.plans.listResult = deferred.promise;
    const first = harness.planService.select(planIntent("enter"));
    await Promise.resolve();
    await Promise.resolve();
    await expectPlanError(
      harness.planService.select(planIntent("enter", { target: targetB, operation_id: "op_plan_select_0002" })),
      "service_overloaded"
    );
    deferred.resolve(harness.plans.catalog);
    await first;
    expect(harness.planService.pending_count).toBe(1);
    expect(harness.planService.readPendingSettings(targetB as never)).toEqual([]);
  });

  it("dispatches one session without consuming another session's pending Plan revision", async () => {
    const harness = createHarness({ includeSecondState: true });
    const selectedA = await harness.planService.select(planIntent("enter"));
    const selectedB = await harness.planService.select(
      planIntent("enter", { target: targetB, operation_id: "op_plan_select_0002" })
    );
    await harness.planService.dispatchPendingTurn(planTurn(selectedA.pending?.revision ?? 0, null));
    expect(harness.plans.startCalls).toHaveLength(1);
    expect(harness.plans.startCalls[0]).toMatchObject({ thread_id: targetA.codex_thread_id });
    expect(harness.planService.readPendingSettings(targetB as never)).toEqual([
      { control: "plan", revision: selectedB.pending?.revision, phase: "pending" }
    ]);
  });

  it("revalidates archive state after catalog and model reads before wire mutation", async () => {
    const catalogRace = createHarness();
    const deferred = deferredResult<CodexPlanCatalog>();
    catalogRace.plans.listResult = deferred.promise;
    const selection = catalogRace.planService.select(planIntent("enter"));
    await Promise.resolve();
    catalogRace.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    deferred.resolve(catalogRace.plans.catalog);
    await expectPlanError(selection, "target_not_writable");
    expect(catalogRace.planService.pending_count).toBe(0);

    const dispatchRace = createHarness();
    const selected = await dispatchRace.planService.select(planIntent("enter"));
    dispatchRace.models.readHook = () => {
      dispatchRace.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    };
    await expectPlanError(
      dispatchRace.planService.dispatchPendingTurn(planTurn(selected.pending?.revision ?? 0, null)),
      "target_not_writable"
    );
    expect(dispatchRace.plans.startCalls).toHaveLength(0);
    expect(dispatchRace.planService.pending_count).toBe(0);
  });

  it("releases capacity and state when the owning session is archived", async () => {
    const harness = createHarness();
    await harness.planService.select(planIntent("enter"));
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    await expectPlanError(harness.planService.snapshot(targetA), "target_not_writable");
    expect(harness.planService.pending_count).toBe(0);
  });
});

interface FakePlans extends CodexPlanClient {
  catalog: CodexPlanCatalog;
  listError: Error | null;
  startError: Error | null;
  listResult: Promise<CodexPlanCatalog> | null;
  startResult: Promise<CodexPlanTurnAccepted> | null;
  readonly startCalls: Array<Record<string, unknown>>;
}

interface FakeModels extends CodexModelClient {
  catalog: CodexModelCatalog;
  current: { runtime_model: string; reasoning_effort: string | null };
  readHook: (() => void) | null;
  readonly startCalls: Array<Record<string, unknown>>;
}

function createHarness(options: { includeSecondState?: boolean; maxPendingSelections?: number } = {}) {
  const states = new Map<string, SelectedSessionState>();
  states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id));
  if (options.includeSecondState) states.set(targetB.session_id, selectedState(targetB.session_id, targetB.codex_thread_id));
  const statePort: CodexPlanControlStatePort & CodexModelControlStatePort = {
    get: (sessionId) => states.get(sessionId) ?? null,
    getByThreadId: (threadId) => [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null
  };
  const models = fakeModels();
  const modelService = createCodexModelControlService({ models, states: statePort, now: () => observedAt });
  const plans = fakePlans();
  const planService = createCodexPlanControlService({
    plans,
    models: modelService,
    states: statePort,
    ...(options.maxPendingSelections === undefined ? {} : { max_pending_selections: options.maxPendingSelections }),
    now: () => observedAt
  });
  return { states, models, modelService, plans, planService };
}

function fakePlans(): FakePlans {
  const startCalls: Array<Record<string, unknown>> = [];
  return {
    runtime_version: "0.144.0",
    catalog: planCatalog(),
    listError: null,
    startError: null,
    listResult: null,
    startResult: null,
    startCalls,
    async listCatalog() {
      if (this.listError !== null) throw this.listError;
      if (this.listResult !== null) return this.listResult;
      return this.catalog;
    },
    async startTurn(input) {
      startCalls.push({ ...input });
      if (this.startError !== null) throw this.startError;
      if (this.startResult !== null) return this.startResult;
      return { thread_id: input.thread_id as CodexThreadId, turn_id: "turn-plan-a" as never, state: "accepted" };
    }
  };
}

function fakeModels(): FakeModels {
  const startCalls: Array<Record<string, unknown>> = [];
  return {
    runtime_version: "0.144.0",
    catalog: modelCatalog(),
    current: { runtime_model: "runtime-a", reasoning_effort: "high" },
    readHook: null,
    startCalls,
    async listCatalog() {
      return this.catalog;
    },
    async readCurrent(threadId) {
      this.readHook?.();
      return {
        thread_id: threadId as CodexThreadId,
        runtime_model: this.current.runtime_model,
        reasoning_effort: this.current.reasoning_effort
      };
    },
    async startTurn(input) {
      startCalls.push({ ...input });
      return { thread_id: input.thread_id as CodexThreadId, turn_id: "turn-model-a" as never, state: "accepted" };
    }
  };
}

function planCatalog(): CodexPlanCatalog {
  return {
    revision: "c".repeat(64),
    observed_at: observedAt as never,
    modes: [
      { name: "Plan", mode: "plan", preset_model: null, preset_reasoning_effort: "medium" },
      { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null }
    ]
  };
}

function modelCatalog(): CodexModelCatalog {
  return { revision: "a".repeat(64), observed_at: observedAt as never, models: [modelA, modelB] };
}

const modelA = model({ id: "model-a", runtime_model: "runtime-a", label: "Model A", is_default: true });
const modelB = model({ id: "model-b", runtime_model: "runtime-b", label: "Model B", is_default: false });

function model(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: "model",
    runtime_model: "runtime",
    label: "Model",
    description: null,
    is_default: false,
    input_modalities: ["text"],
    reasoning_efforts: [
      { id: "low", description: "Fast", is_default: false },
      { id: "high", description: "Thorough", is_default: true }
    ],
    ...overrides
  };
}

function planIntent(
  action: "enter" | "exit",
  overrides: Partial<{
    target: typeof targetA | typeof targetB;
    operation_id: string;
    expected_pending_revision: number | null;
  }> = {}
) {
  return {
    operation_id: "op_plan_select_0001",
    target: targetA,
    kind: "plan",
    action,
    expected_pending_revision: null,
    ...overrides
  } as const;
}

function modelIntent() {
  return {
    operation_id: "op_model_select_plan_0001",
    target: targetA,
    kind: "model",
    model_id: "model-b",
    reasoning_effort: "low",
    expected_pending_revision: null
  } as const;
}

function planTurn(planRevision: number, modelRevision: number | null) {
  return {
    operation_id: "op_plan_prompt_0001",
    target: targetA,
    kind: "prompt",
    text: "Produce a concise implementation plan.",
    expected_plan_revision: planRevision,
    expected_model_revision: modelRevision
  } as const;
}

function selectedState(sessionId: string, threadId: string, turnState = "idle", archived = false): SelectedSessionState {
  const archivedAt = archived ? observedAt : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: sessionId.replace(/^sess_/u, ""),
    codex_thread_id: threadId,
    cwd: `/tmp/${sessionId}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: observedAt,
    updated_at: observedAt,
    archived_at: archivedAt
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
      archived_at: archivedAt,
      session_state: archived ? "archived" : "active",
      turn_state: turnState,
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: observedAt,
      last_activity_at: observedAt,
      branch: "main",
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed Codex Plan session ready.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function settingsEvent(mode: "default" | "plan", runtimeModel: string, effort: string | null): NormalizedCodexEvent {
  return {
    sequence: 1,
    method: "thread/settings/updated",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: targetA.codex_thread_id,
    model: runtimeModel,
    effort,
    collaboration_mode: mode
  } as NormalizedCodexEvent;
}

function planDeltaEvent(turnId: string, delta: string): NormalizedCodexEvent {
  return {
    sequence: 2,
    method: "item/plan/delta",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: targetA.codex_thread_id,
    turn_id: turnId,
    item_id: "item-plan-a",
    category: "plan",
    delta,
    content_state: "complete",
    content_notice: null
  } as NormalizedCodexEvent;
}

function turnCompletedEvent(turnId: string, status: "completed" | "failed" | "interrupted"): NormalizedCodexEvent {
  return {
    sequence: 3,
    method: "turn/completed",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: targetA.codex_thread_id,
    turn_id: turnId,
    status,
    error_message: status === "failed" ? "Plan failed." : null
  } as NormalizedCodexEvent;
}

function deferredResult<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the Plan test condition.");
}

async function expectPlanError(promise: Promise<unknown>, code: HostDeckCodexPlanControlError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexPlanControlError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckCodexPlanControlError ${code}.`);
}
