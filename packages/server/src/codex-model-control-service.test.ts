import {
  type CodexModelCatalog,
  type CodexModelClient,
  type CodexModelTurnAccepted,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import type { ModelCatalogEntry } from "@hostdeck/contracts";
import type { AbsoluteCwd, CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexModelControlStatePort,
  createCodexModelControlService,
  HostDeckCodexModelControlError
} from "./codex-model-control-service.js";
import { withTestOperationDeadlines } from "./test-operation-deadline.js";

const observedAt = "2026-07-10T17:00:00.000Z";
const targetA = {
  type: "managed_session",
  session_id: "sess_model_a",
  codex_thread_id: "thread-model-a"
} as const;
const targetB = {
  type: "managed_session",
  session_id: "sess_model_b",
  codex_thread_id: "thread-model-b"
} as const;

describe("Codex pending model control", () => {
  it("separates confirmed current state from a validated pending catalog selection", async () => {
    const harness = createHarness();
    const before = await harness.service.snapshot(targetA);
    expect(before).toMatchObject({
      current: { model_id: "model-a", runtime_model: "runtime-a", reasoning_effort: "high", catalog_state: "available" },
      pending: null
    });

    const selected = await harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: null }));
    expect(selected.pending).toMatchObject({
      revision: 1,
      model_id: "model-b",
      runtime_model: "runtime-b",
      reasoning_effort: "high",
      catalog_state: "available",
      phase: "pending",
      turn_id: null,
      error: null
    });
    expect(selected.current).toEqual(before.current);
    expect(harness.service.pending_count).toBe(1);
    expect(harness.service.readPendingSettings(targetA as never)).toEqual([
      { control: "model", revision: 1, phase: "pending" }
    ]);
  });

  it("treats selecting the confirmed model and effort as a truthful no-op", async () => {
    const harness = createHarness();
    const selected = await harness.service.select(modelIntent({ model_id: "model-a", reasoning_effort: "high" }));
    expect(selected.pending).toBeNull();
    expect(harness.service.pending_count).toBe(0);
    expect(harness.models.startCalls).toHaveLength(0);
  });

  it("reports runtime state absent from the live catalog without inventing a model id", async () => {
    const harness = createHarness();
    harness.models.current = { runtime_model: "retired-runtime", reasoning_effort: "legacy" };
    expect((await harness.service.snapshot(targetA)).current).toEqual({
      model_id: null,
      runtime_model: "retired-runtime",
      reasoning_effort: "legacy",
      catalog_state: "unknown",
      observed_at: observedAt
    });
  });

  it("keeps unknown model, unsupported effort, stale revision, and unsupported capability distinct", async () => {
    const harness = createHarness();
    await expectControlError(
      harness.service.select(modelIntent({ model_id: "missing", reasoning_effort: null })),
      "model_unknown"
    );
    await expectControlError(
      harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "ultra" })),
      "effort_unsupported"
    );

    const selected = await harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    await expectControlError(
      harness.service.select(
        modelIntent({ model_id: "model-a", reasoning_effort: "low", expected_pending_revision: (selected.pending?.revision ?? 0) + 1 })
      ),
      "operation_conflict"
    );

    const unsupported = createHarness();
    unsupported.models.listError = new HostDeckCodexAdapterError("unsupported_method", "Model control unavailable.", {
      outcome: "not_sent"
    });
    await expectControlError(unsupported.service.snapshot(targetA), "capability_unsupported");
  });

  it("rejects a mismatched managed target and an active-turn dispatch before wire mutation", async () => {
    const harness = createHarness();
    await expectControlError(
      harness.service.snapshot({ ...targetA, codex_thread_id: "thread-other" }),
      "target_mismatch"
    );

    const selected = await harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    await expectControlError(
      harness.service.dispatchPendingTurn(pendingTurn(selected.pending?.revision ?? 0)),
      "operation_conflict"
    );
    expect(harness.models.startCalls).toHaveLength(0);
  });

  it("rejects contradictory selected identity and recovery disposition before runtime access", async () => {
    const contradictory = createHarness();
    const state = selectedState(targetA.session_id, targetA.codex_thread_id);
    contradictory.states.set(targetA.session_id, {
      ...state,
      projection: {
        ...state.projection,
        session: {
          ...state.projection.session,
          name: "contradictory" as SelectedSessionState["mapping"]["name"]
        }
      }
    });
    await expectControlError(contradictory.service.snapshot(targetA), "target_mismatch");

    const misplaced = createHarness();
    misplaced.states.set(
      targetA.session_id,
      selectedState(targetB.session_id, targetA.codex_thread_id)
    );
    await expectControlError(misplaced.service.snapshot(targetA), "target_mismatch");

    const recovery = createHarness();
    const recoveryState = selectedState(targetA.session_id, targetA.codex_thread_id);
    recovery.states.set(targetA.session_id, {
      ...recoveryState,
      mapping: { ...recoveryState.mapping, disposition: "recovery_required" }
    });
    const error = await readControlError(recovery.service.snapshot(targetA), "target_not_writable");
    expect(error.api_code).toBe("stale_session");
    expect(recovery.service.pending_count).toBe(0);
  });

  it("dispatches one exact turn and clears pending only after matching settings confirmation", async () => {
    const harness = createHarness();
    const selected = await harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    const revision = selected.pending?.revision ?? 0;
    const accepted = await harness.service.dispatchPendingTurn(pendingTurn(revision));

    expect(accepted).toEqual({
      thread_id: targetA.codex_thread_id,
      turn_id: "turn-model-a",
      state: "accepted",
      pending_revision: revision
    });
    expect(harness.models.startCalls).toEqual([
      expect.objectContaining({
        operation_id: "op_model_prompt_0001",
        thread_id: targetA.codex_thread_id,
        text: "Continue the next ready task.",
        runtime_model: "runtime-b",
        reasoning_effort: "low"
      })
    ]);
    expect((await harness.service.snapshot(targetA)).pending).toMatchObject({
      revision,
      phase: "awaiting_confirmation",
      turn_id: "turn-model-a"
    });

    harness.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    await harness.service.observeSettings(settingsEvent("runtime-b", "low"));
    expect((await harness.service.snapshot(targetA)).pending).toBeNull();
    expect(harness.service.pending_count).toBe(0);
  });

  it("reverts a known remote rejection but latches an unknown dispatch outcome", async () => {
    const rejected = createHarness();
    const selectedRejected = await rejected.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    rejected.models.startError = new HostDeckCodexAdapterError("remote_error", "Turn already active.", {
      outcome: "remote_rejected",
      retry_safe: true
    });
    await expectControlError(
      rejected.service.dispatchPendingTurn(pendingTurn(selectedRejected.pending?.revision ?? 0)),
      "operation_conflict"
    );
    expect((await rejected.service.snapshot(targetA)).pending).toMatchObject({ phase: "pending", error: null });

    const uncertain = createHarness();
    const selectedUnknown = await uncertain.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    const revision = selectedUnknown.pending?.revision ?? 0;
    uncertain.models.startError = new HostDeckCodexAdapterError("request_timeout", "Turn response timed out.", {
      outcome: "unknown",
      retry_safe: false
    });
    await expectControlError(uncertain.service.dispatchPendingTurn(pendingTurn(revision)), "operation_timeout");
    expect((await uncertain.service.snapshot(targetA)).pending).toMatchObject({
      revision,
      phase: "unknown",
      error: { code: "operation_timeout" }
    });
    await expectControlError(uncertain.service.dispatchPendingTurn(pendingTurn(revision)), "operation_conflict");

    uncertain.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    expect((await uncertain.service.reconcile(targetA, revision)).pending).toBeNull();

    const indistinguishable = createHarness();
    const selectedBeforeExternalChange = await indistinguishable.service.select(
      modelIntent({ model_id: "model-b", reasoning_effort: "low" })
    );
    const indistinguishableRevision = selectedBeforeExternalChange.pending?.revision ?? 0;
    indistinguishable.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    indistinguishable.models.startError = new HostDeckCodexAdapterError("request_timeout", "Turn response timed out.", {
      outcome: "unknown",
      retry_safe: false
    });
    await expectControlError(
      indistinguishable.service.dispatchPendingTurn(pendingTurn(indistinguishableRevision)),
      "operation_timeout"
    );
    expect((await indistinguishable.service.reconcile(targetA, indistinguishableRevision)).pending).toMatchObject({
      phase: "unknown"
    });

    const malformedMutation = createHarness();
    const malformedSelected = await malformedMutation.service.select(
      modelIntent({ model_id: "model-b", reasoning_effort: "low" })
    );
    malformedMutation.models.startError = new HostDeckCodexAdapterError(
      "invalid_protocol_message",
      "The turn response was malformed.",
      { outcome: "not_applicable", retry_safe: false }
    );
    await expectControlError(
      malformedMutation.service.dispatchPendingTurn(pendingTurn(malformedSelected.pending?.revision ?? 0)),
      "unknown_outcome"
    );
    expect((await malformedMutation.service.snapshot(targetA)).pending).toMatchObject({ phase: "unknown" });
  });

  it("treats malformed read payloads as protocol failures without claiming a mutation outcome", async () => {
    const harness = createHarness();
    harness.models.listError = new HostDeckCodexAdapterError(
      "invalid_protocol_message",
      "The model catalog was malformed.",
      { outcome: "not_applicable", retry_safe: false }
    );
    await expectControlError(harness.service.snapshot(targetA), "runtime_protocol_error");
    expect(harness.service.pending_count).toBe(0);
  });

  it("surfaces settings mismatch and catalog drift as replaceable conflicts", async () => {
    const harness = createHarness();
    const selected = await harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    const revision = selected.pending?.revision ?? 0;
    await harness.service.dispatchPendingTurn(pendingTurn(revision));
    await harness.service.observeSettings(settingsEvent("runtime-a", "high"));
    expect((await harness.service.snapshot(targetA)).pending).toMatchObject({
      revision,
      phase: "conflict",
      catalog_state: "available",
      error: { code: "operation_conflict" }
    });

    const replaced = await harness.service.select(
      modelIntent({ model_id: "model-a", reasoning_effort: "high", expected_pending_revision: revision })
    );
    expect(replaced.pending).toBeNull();

    const drift = createHarness();
    const driftSelected = await drift.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    drift.models.catalog = catalog([modelA]);
    expect((await drift.service.snapshot(targetA)).pending).toMatchObject({
      revision: driftSelected.pending?.revision,
      phase: "conflict",
      catalog_state: "unknown",
      error: { code: "operation_conflict" }
    });
  });

  it("bounds pending sessions and serializes replacement behind dispatch", async () => {
    const capacity = createHarness({ maxPendingSelections: 1, includeSecondState: true });
    await capacity.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    await expectControlError(
      capacity.service.select(modelIntent({ target: targetB, model_id: "model-b", reasoning_effort: "low" })),
      "service_overloaded"
    );

    const serialized = createHarness();
    const selected = await serialized.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    const deferred = deferredResult<CodexModelTurnAccepted>();
    serialized.models.startResult = deferred.promise;
    const dispatch = serialized.service.dispatchPendingTurn(pendingTurn(selected.pending?.revision ?? 0));
    const replacement = serialized.service.select(
      modelIntent({ model_id: "model-a", reasoning_effort: "high", expected_pending_revision: selected.pending?.revision ?? null })
    );
    deferred.resolve({ thread_id: targetA.codex_thread_id as CodexThreadId, turn_id: "turn-model-a" as never, state: "accepted" });
    await dispatch;
    await expectControlError(replacement, "operation_conflict");
  });

  it("does not resurrect a selection confirmed while turn/start is still resolving", async () => {
    const matched = createHarness();
    const selected = await matched.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    const deferred = deferredResult<CodexModelTurnAccepted>();
    matched.models.startResult = deferred.promise;
    const dispatch = matched.service.dispatchPendingTurn(pendingTurn(selected.pending?.revision ?? 0));
    await Promise.resolve();
    await Promise.resolve();
    await matched.service.observeSettings(settingsEvent("runtime-b", "low"));
    deferred.resolve({ thread_id: targetA.codex_thread_id as CodexThreadId, turn_id: "turn-model-a" as never, state: "accepted" });
    await dispatch;
    matched.models.current = { runtime_model: "runtime-b", reasoning_effort: "low" };
    expect((await matched.service.snapshot(targetA)).pending).toBeNull();

    const contradicted = createHarness();
    const contradictedSelection = await contradicted.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    const contradictedDeferred = deferredResult<CodexModelTurnAccepted>();
    contradicted.models.startResult = contradictedDeferred.promise;
    const contradictedDispatch = contradicted.service.dispatchPendingTurn(
      pendingTurn(contradictedSelection.pending?.revision ?? 0)
    );
    await Promise.resolve();
    await Promise.resolve();
    await contradicted.service.observeSettings(settingsEvent("runtime-a", "high"));
    contradictedDeferred.resolve({
      thread_id: targetA.codex_thread_id as CodexThreadId,
      turn_id: "turn-model-a" as never,
      state: "accepted"
    });
    await contradictedDispatch;
    expect((await contradicted.service.snapshot(targetA)).pending).toMatchObject({
      phase: "conflict",
      error: { code: "operation_conflict" }
    });
  });

  it("reserves global pending capacity across concurrent session reads", async () => {
    const harness = createHarness({ maxPendingSelections: 1, includeSecondState: true });
    const deferred = deferredResult<CodexModelCatalog>();
    harness.models.listResult = deferred.promise;
    const first = harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    await Promise.resolve();
    await Promise.resolve();
    await expectControlError(
      harness.service.select(modelIntent({ target: targetB, model_id: "model-b", reasoning_effort: "low" })),
      "service_overloaded"
    );
    deferred.resolve(harness.models.catalog);
    await first;
    expect(harness.service.pending_count).toBe(1);
  });

  it("releases pending capacity when the owning session is archived", async () => {
    const harness = createHarness();
    await harness.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    await expectControlError(harness.service.snapshot(targetA), "target_not_writable");
    expect(harness.service.pending_count).toBe(0);
  });

  it("revalidates archive state after remote reads and before turn mutation", async () => {
    const selectionRace = createHarness();
    selectionRace.models.readHook = () => {
      selectionRace.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    };
    await expectControlError(
      selectionRace.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" })),
      "target_not_writable"
    );
    expect(selectionRace.service.pending_count).toBe(0);

    const dispatchRace = createHarness();
    const selected = await dispatchRace.service.select(modelIntent({ model_id: "model-b", reasoning_effort: "low" }));
    dispatchRace.models.readHook = () => {
      dispatchRace.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    };
    await expectControlError(
      dispatchRace.service.dispatchPendingTurn(pendingTurn(selected.pending?.revision ?? 0)),
      "target_not_writable"
    );
    expect(dispatchRace.models.startCalls).toHaveLength(0);
    expect(dispatchRace.service.pending_count).toBe(0);
  });
});

interface FakeModels extends CodexModelClient {
  catalog: CodexModelCatalog;
  current: { runtime_model: string; reasoning_effort: string | null };
  listError: Error | null;
  startError: Error | null;
  startResult: Promise<CodexModelTurnAccepted> | null;
  listResult: Promise<CodexModelCatalog> | null;
  readHook: (() => void) | null;
  readonly startCalls: Array<Record<string, unknown>>;
}

function createHarness(options: { maxPendingSelections?: number; includeSecondState?: boolean } = {}) {
  const states = new Map<string, SelectedSessionState>();
  states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id));
  if (options.includeSecondState) states.set(targetB.session_id, selectedState(targetB.session_id, targetB.codex_thread_id));
  const statePort: CodexModelControlStatePort = {
    get: (sessionId) => states.get(sessionId) ?? null,
    getByThreadId: (threadId) => [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null
  };
  const models = fakeModels();
  const service = withTestOperationDeadlines(createCodexModelControlService({
    models,
    states: statePort,
    ...(options.maxPendingSelections === undefined ? {} : { max_pending_selections: options.maxPendingSelections }),
    now: () => observedAt
  }), ["dispatchPendingTurn", "prepareTurnSettings", "select", "snapshot"]);
  return { service, models, states };
}

function fakeModels(): FakeModels {
  const startCalls: Array<Record<string, unknown>> = [];
  return {
    runtime_version: "0.144.0",
    catalog: catalog([modelA, modelB]),
    current: { runtime_model: "runtime-a", reasoning_effort: "high" },
    listError: null,
    startError: null,
    startResult: null,
    listResult: null,
    readHook: null,
    startCalls,
    async listCatalog() {
      if (this.listError !== null) throw this.listError;
      if (this.listResult !== null) return this.listResult;
      return this.catalog;
    },
    async readCurrent(threadId) {
      this.readHook?.();
      return {
        thread_id: threadId as CodexThreadId,
        cwd: `/tmp/${threadId === targetB.codex_thread_id ? targetB.session_id : targetA.session_id}` as AbsoluteCwd,
        runtime_model: this.current.runtime_model,
        reasoning_effort: this.current.reasoning_effort
      };
    },
    async startTurn(input) {
      startCalls.push({ ...input });
      if (this.startError !== null) throw this.startError;
      if (this.startResult !== null) return this.startResult;
      return { thread_id: input.thread_id as CodexThreadId, turn_id: "turn-model-a" as never, state: "accepted" };
    }
  };
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
    input_modalities: ["text", "image"],
    reasoning_efforts: [
      { id: "low", description: "Fast", is_default: false },
      { id: "high", description: "Thorough", is_default: true }
    ],
    ...overrides
  };
}

function catalog(models: readonly ModelCatalogEntry[]): CodexModelCatalog {
  return {
    revision: models.length === 1 ? "b".repeat(64) : "a".repeat(64),
    observed_at: observedAt as never,
    models
  };
}

function modelIntent(
  overrides: Partial<{
    target: typeof targetA | typeof targetB;
    model_id: string;
    reasoning_effort: string | null;
    expected_pending_revision: number | null;
  }> = {}
) {
  return {
    operation_id: "op_model_select_0001",
    target: targetA,
    kind: "model",
    model_id: "model-b",
    reasoning_effort: "low",
    expected_pending_revision: null,
    ...overrides
  } as const;
}

function pendingTurn(revision: number) {
  return {
    operation_id: "op_model_prompt_0001",
    target: targetA,
    kind: "prompt",
    text: "Continue the next ready task.",
    expected_pending_revision: revision
  } as const;
}

function selectedState(sessionId: string, threadId: string, turnState = "idle", archived = false): SelectedSessionState {
  const selectedTimestamp = observedAt as SelectedSessionState["mapping"]["created_at"];
  const archivedAt = archived ? selectedTimestamp : null;
  const identity = {
    id: sessionId as SelectedSessionState["mapping"]["id"],
    name: sessionId.replace(/^sess_/u, "") as SelectedSessionState["mapping"]["name"],
    codex_thread_id: threadId as SelectedSessionState["mapping"]["codex_thread_id"],
    cwd: `/tmp/${sessionId}` as SelectedSessionState["mapping"]["cwd"],
    runtime_source: "codex_app_server" as const,
    runtime_version: "0.144.0" as SelectedSessionState["mapping"]["runtime_version"],
    created_at: selectedTimestamp,
    archived_at: archivedAt
  };
  return {
    mapping: {
      ...identity,
      disposition: "selected",
      updated_at: selectedTimestamp
    },
    projection: {
      session: {
        ...identity,
        session_state: archived ? "archived" : "active",
        freshness: "current",
        freshness_reason: null,
        turn_state: turnState as SelectedSessionState["projection"]["session"]["turn_state"],
        attention: "none",
        updated_at: selectedTimestamp,
        last_activity_at: null,
        branch: null,
        model: null,
        settings: null,
        goal: null,
        recent_summary: "",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function settingsEvent(modelName: string, effort: string | null): NormalizedCodexEvent {
  return {
    method: "thread/settings/updated",
    thread_id: targetA.codex_thread_id,
    model: modelName,
    effort
  } as NormalizedCodexEvent;
}

function deferredResult<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function expectControlError(promise: Promise<unknown>, code: HostDeckCodexModelControlError["code"]): Promise<void> {
  await readControlError(promise, code);
}

async function readControlError(
  promise: Promise<unknown>,
  code: HostDeckCodexModelControlError["code"]
): Promise<HostDeckCodexModelControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexModelControlError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexModelControlError;
  }
  throw new Error(`Expected HostDeckCodexModelControlError ${code}.`);
}
