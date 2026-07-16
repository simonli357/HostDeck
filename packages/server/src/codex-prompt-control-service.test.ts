import {
  type CodexTurnAccepted,
  type CodexTurnClient,
  type CodexTurnStartInput,
  type CodexTurnSteered,
  type CodexTurnSteerInput,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import type { ManagedSessionTarget } from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import { HostDeckCodexModelControlError } from "./codex-model-control-service.js";
import { HostDeckCodexPlanControlError } from "./codex-plan-control-service.js";
import {
  type CodexPromptControlStatePort,
  type CodexPromptModelPort,
  type CodexPromptPlanPort,
  createCodexPromptControlService,
  HostDeckCodexPromptControlError
} from "./codex-prompt-control-service.js";
import type { PendingTurnSetting } from "./pending-turn-settings.js";

const observedAt = "2026-07-10T23:00:00.000Z";
const targetA = {
  type: "managed_session",
  session_id: "sess_prompt_a",
  codex_thread_id: "thread-prompt-a"
} as const;
const targetB = {
  type: "managed_session",
  session_id: "sess_prompt_b",
  codex_thread_id: "thread-prompt-b"
} as const;

describe("Codex prompt control", () => {
  it("starts once, waits for the matching event, then steers the same turn without a second start", async () => {
    const harness = createHarness();
    const started = await harness.service.dispatch(promptIntent());
    expect(started).toEqual({
      action: "start",
      thread_id: targetA.codex_thread_id,
      turn_id: "turn-thread-prompt-a",
      state: "accepted",
      model_revision: null,
      plan_revision: null,
      steerable: false
    });
    expect(harness.turns.startCalls).toHaveLength(1);
    const acceptedSnapshot = await harness.service.snapshot(targetA);
    expect(acceptedSnapshot.phase).toBe("accepted");
    expect(Object.isFrozen(acceptedSnapshot)).toBe(true);
    expect(Reflect.set(acceptedSnapshot, "phase", "idle")).toBe(false);
    expect((await harness.service.snapshot(targetA)).phase).toBe("accepted");

    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    await harness.service.observeEvent(turnStartedEvent(targetA, "turn-thread-prompt-a"));
    expect((await harness.service.snapshot(targetA)).phase).toBe("steerable");

    const steered = await harness.service.dispatch(promptIntent({ operation_id: "op_prompt_steer_0001", text: "Continue this turn." }));
    expect(steered).toMatchObject({ action: "steer", turn_id: "turn-thread-prompt-a", steerable: true });
    expect(harness.turns.startCalls).toHaveLength(1);
    expect(harness.turns.steerCalls).toEqual([
      expect.objectContaining({
        operation_id: "op_prompt_steer_0001",
        thread_id: targetA.codex_thread_id,
        expected_turn_id: "turn-thread-prompt-a",
        text: "Continue this turn."
      })
    ]);
  });

  it("uses matching early turn-start evidence without racing the accepted response", async () => {
    const harness = createHarness();
    const deferred = deferredResult<CodexTurnAccepted>();
    harness.turns.startResult = deferred.promise;
    const dispatch = harness.service.dispatch(promptIntent());
    await waitFor(() => harness.turns.startCalls.length === 1);
    const observation = harness.service.observeEvent(turnStartedEvent(targetA, "turn-early-a"));
    deferred.resolve({ thread_id: targetA.codex_thread_id as CodexThreadId, turn_id: "turn-early-a" as never, state: "accepted" });
    expect(await dispatch).toMatchObject({ turn_id: "turn-early-a", steerable: true });
    await observation;
    expect(await harness.service.snapshot(targetA)).toMatchObject({ phase: "steerable", turn_id: "turn-early-a" });
  });

  it("returns accepted but clears tracking when a fast turn completes before the response continuation", async () => {
    const harness = createHarness();
    const deferred = deferredResult<CodexTurnAccepted>();
    harness.turns.startResult = deferred.promise;
    const dispatch = harness.service.dispatch(promptIntent());
    await waitFor(() => harness.turns.startCalls.length === 1);
    const startedObservation = harness.service.observeEvent(turnStartedEvent(targetA, "turn-fast-a"));
    const completedObservation = harness.service.observeEvent(turnCompletedEvent(targetA, "turn-fast-a"));
    deferred.resolve({ thread_id: targetA.codex_thread_id as CodexThreadId, turn_id: "turn-fast-a" as never, state: "accepted" });
    expect(await dispatch).toMatchObject({ turn_id: "turn-fast-a", steerable: false });
    await Promise.all([startedObservation, completedObservation]);
    expect(await harness.service.snapshot(targetA)).toEqual(idlePromptState());
  });

  it("latches a mismatched early turn start as unknown instead of attributing it to the accepted prompt", async () => {
    const harness = createHarness();
    const deferred = deferredResult<CodexTurnAccepted>();
    harness.turns.startResult = deferred.promise;
    const dispatch = harness.service.dispatch(promptIntent());
    await waitFor(() => harness.turns.startCalls.length === 1);
    const observation = harness.service.observeEvent(turnStartedEvent(targetA, "turn-foreign-early-a"));
    deferred.resolve({
      thread_id: targetA.codex_thread_id as CodexThreadId,
      turn_id: "turn-accepted-a" as never,
      state: "accepted"
    });
    await expectPromptError(dispatch, "runtime_protocol_error");
    await observation;
    expect(await harness.service.snapshot(targetA)).toMatchObject({
      phase: "unknown",
      turn_id: "turn-accepted-a",
      started_at: null
    });
    expect(harness.turns.startCalls).toHaveLength(1);
  });

  it("uses an observed active-to-terminal projection transition as bounded event-loss reconciliation", async () => {
    const harness = createHarness();
    const accepted = await harness.service.dispatch(promptIntent());
    expect((await harness.service.snapshot(targetA)).phase).toBe("accepted");

    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    expect(await harness.service.snapshot(targetA)).toMatchObject({ phase: "accepted", turn_id: accepted.turn_id });
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "completed"));
    expect(await harness.service.snapshot(targetA)).toEqual(idlePromptState());
    expect(harness.service.tracked_count).toBe(0);
  });

  it("routes an exact pending model revision without calling the plain start path", async () => {
    const harness = createHarness();
    harness.models.settings.set(targetA.session_id, pending("model", 4));
    const result = await harness.service.dispatch(promptIntent());
    expect(result).toMatchObject({ action: "start", model_revision: 4, plan_revision: null });
    expect(harness.models.dispatchCalls).toEqual([
      expect.objectContaining({ operation_id: "op_prompt_start_0001", expected_pending_revision: 4 })
    ]);
    expect(harness.plans.dispatchCalls).toHaveLength(0);
    expect(harness.turns.startCalls).toHaveLength(0);
  });

  it("routes model plus Plan revisions through the single combined Plan path", async () => {
    const harness = createHarness();
    harness.models.settings.set(targetA.session_id, pending("model", 5));
    harness.plans.settings.set(targetA.session_id, pending("plan", 7));
    const result = await harness.service.dispatch(promptIntent());
    expect(result).toMatchObject({ action: "start", model_revision: 5, plan_revision: 7 });
    expect(harness.plans.dispatchCalls).toEqual([
      expect.objectContaining({
        operation_id: "op_prompt_start_0001",
        expected_model_revision: 5,
        expected_plan_revision: 7
      })
    ]);
    expect(harness.models.dispatchCalls).toHaveLength(0);
    expect(harness.turns.startCalls).toHaveLength(0);
  });

  it("latches the exact accepted turn when returned pending revisions contradict the atomic snapshot", async () => {
    const harness = createHarness();
    harness.models.settings.set(targetA.session_id, pending("model", 5));
    harness.models.returnedRevision = 6;
    await expectPromptError(harness.service.dispatch(promptIntent()), "runtime_protocol_error");
    expect(await harness.service.snapshot(targetA)).toMatchObject({
      phase: "unknown",
      turn_id: "turn-thread-prompt-a",
      model_revision: 5,
      accepted_at: observedAt,
      error: { code: "protocol_error", retryable: false }
    });
    expect(harness.models.dispatchCalls).toHaveLength(1);
  });

  it("clears exact tracking when a contradictory accepted revision reaches terminal before continuation", async () => {
    const harness = createHarness();
    const gate = deferredResult<void>();
    harness.models.settings.set(targetA.session_id, pending("model", 5));
    harness.models.returnedRevision = 6;
    harness.models.dispatchGate = gate.promise;
    const dispatch = harness.service.dispatch(promptIntent());
    await waitFor(() => harness.models.dispatchCalls.length === 1);
    const started = harness.service.observeEvent(turnStartedEvent(targetA, "turn-thread-prompt-a"));
    const completed = harness.service.observeEvent(turnCompletedEvent(targetA, "turn-thread-prompt-a"));
    gate.resolve(undefined);
    await expectPromptError(dispatch, "runtime_protocol_error");
    await Promise.all([started, completed]);
    expect(await harness.service.snapshot(targetA)).toEqual(idlePromptState());
    expect(harness.service.tracked_count).toBe(0);
  });

  it("preserves downstream runtime and protocol failure classes without inventing a conflict", async () => {
    const unavailable = createHarness();
    unavailable.models.settings.set(targetA.session_id, pending("model", 2));
    unavailable.models.dispatchError = new HostDeckCodexModelControlError(
      "runtime_unavailable",
      "runtime_unavailable",
      "Codex disconnected before dispatch.",
      "not_sent",
      true
    );
    await expectPromptError(unavailable.service.dispatch(promptIntent()), "runtime_unavailable");
    expect(await unavailable.service.snapshot(targetA)).toEqual(idlePromptState());

    const protocol = createHarness();
    protocol.plans.settings.set(targetA.session_id, pending("plan", 3));
    protocol.plans.dispatchError = new HostDeckCodexPlanControlError(
      "runtime_protocol_error",
      "protocol_error",
      "Plan settings are malformed.",
      "not_sent",
      false
    );
    await expectPromptError(protocol.service.dispatch(promptIntent()), "runtime_protocol_error");
    expect(await protocol.service.snapshot(targetA)).toEqual(idlePromptState());

    const localProtocol = createHarness();
    localProtocol.turns.startError = new HostDeckCodexAdapterError("invalid_protocol_message", "Invalid local turn shape.", {
      outcome: "not_sent",
      retry_safe: false
    });
    await expectPromptError(localProtocol.service.dispatch(promptIntent()), "runtime_protocol_error");
    expect(await localProtocol.service.snapshot(targetA)).toEqual(idlePromptState());
  });

  it("rejects pending conflict or unknown controls before any turn mutation", async () => {
    for (const phase of ["dispatching", "awaiting_confirmation", "unknown", "conflict"] as const) {
      const harness = createHarness();
      harness.models.settings.set(targetA.session_id, pending("model", 3, phase));
      await expectPromptError(harness.service.dispatch(promptIntent()), "operation_conflict");
      expect(harness.models.dispatchCalls).toHaveLength(0);
      expect(harness.plans.dispatchCalls).toHaveLength(0);
      expect(harness.turns.startCalls).toHaveLength(0);
    }
  });

  it("maps malformed pending readers and invalid signals before any mutation", async () => {
    const malformed = createHarness();
    malformed.models.readError = new TypeError("invalid pending setting");
    await expectPromptError(malformed.service.dispatch(promptIntent()), "runtime_protocol_error");
    expect(await malformed.service.snapshot(targetA)).toEqual(idlePromptState());
    expect(malformed.turns.startCalls).toHaveLength(0);

    const invalidSignal = createHarness();
    await expectPromptError(invalidSignal.service.dispatch(promptIntent(), {} as never), "invalid_request");
    expect(invalidSignal.turns.startCalls).toHaveLength(0);
  });

  it("does not steer a foreign or event-unproven active turn", async () => {
    const harness = createHarness();
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    await harness.service.observeEvent(turnStartedEvent(targetA, "turn-foreign-a"));
    await expectPromptError(harness.service.dispatch(promptIntent()), "operation_conflict");
    expect(harness.turns.startCalls).toHaveLength(0);
    expect(harness.turns.steerCalls).toHaveLength(0);

    for (const turnState of ["waiting_for_input", "waiting_for_approval", "unknown"] as const) {
      harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, turnState));
      await expectPromptError(harness.service.dispatch(promptIntent()), "operation_conflict");
    }
  });

  it("latches a possible-send start outcome and does not clear it from an unattributed foreign terminal event", async () => {
    const harness = createHarness();
    harness.turns.startError = new HostDeckCodexAdapterError("request_timeout", "Prompt response timed out.", {
      outcome: "unknown",
      retry_safe: false
    });
    await expectPromptError(harness.service.dispatch(promptIntent()), "unknown_outcome");
    const unknownSnapshot = await harness.service.snapshot(targetA);
    expect(unknownSnapshot).toMatchObject({ phase: "unknown", turn_id: null });
    expect(Object.isFrozen(unknownSnapshot.error)).toBe(true);
    await harness.service.observeEvent(turnCompletedEvent(targetA, "turn-foreign-a"));
    expect((await harness.service.snapshot(targetA)).phase).toBe("unknown");
    await expectPromptError(harness.service.dispatch(promptIntent({ operation_id: "op_prompt_retry_0001" })), "operation_conflict");
    expect(harness.turns.startCalls).toHaveLength(1);
  });

  it("rolls back a known start rejection and allows a later explicit retry", async () => {
    const harness = createHarness();
    harness.turns.startError = new HostDeckCodexAdapterError("remote_error", "Turn already active.", {
      outcome: "remote_rejected",
      retry_safe: true
    });
    await expectPromptError(harness.service.dispatch(promptIntent()), "operation_conflict");
    expect(await harness.service.snapshot(targetA)).toEqual(idlePromptState());
    harness.turns.startError = null;
    await expect(harness.service.dispatch(promptIntent({ operation_id: "op_prompt_retry_0002" }))).resolves.toMatchObject({
      action: "start"
    });
    expect(harness.turns.startCalls).toHaveLength(2);
  });

  it("latches unknown steer, conflicts on known stale steer, and clears either state at terminal turn", async () => {
    const unknown = await steerableHarness();
    unknown.turns.steerError = new HostDeckCodexAdapterError("transport_closed", "Runtime disconnected.", {
      outcome: "unknown",
      retry_safe: false
    });
    await expectPromptError(
      unknown.service.dispatch(promptIntent({ operation_id: "op_prompt_steer_unknown", text: "Steer once." })),
      "unknown_outcome"
    );
    expect((await unknown.service.snapshot(targetA)).phase).toBe("unknown");
    await unknown.service.observeEvent(turnCompletedEvent(targetA, "turn-thread-prompt-a"));
    expect(await unknown.service.snapshot(targetA)).toEqual(idlePromptState());

    const conflict = await steerableHarness();
    conflict.turns.steerError = new HostDeckCodexAdapterError("remote_error", "Expected turn is stale.", {
      outcome: "remote_rejected",
      retry_safe: false
    });
    await expectPromptError(
      conflict.service.dispatch(promptIntent({ operation_id: "op_prompt_steer_stale", text: "Steer stale." })),
      "operation_conflict"
    );
    expect((await conflict.service.snapshot(targetA)).phase).toBe("conflict");
    await conflict.service.observeEvent(turnCompletedEvent(targetA, "turn-thread-prompt-a"));
    expect(await conflict.service.snapshot(targetA)).toEqual(idlePromptState());
  });

  it("rejects mismatched, contradictory, recovery, stale, archived, and malformed targets without mutation", async () => {
    const harness = createHarness();
    await expectPromptError(
      harness.service.dispatch(promptIntent({ target: { ...targetA, codex_thread_id: "thread-other" } as never })),
      "target_mismatch"
    );
    const contradictory = selectedState(targetA.session_id, targetA.codex_thread_id);
    harness.states.set(targetA.session_id, {
      ...contradictory,
      projection: {
        ...contradictory.projection,
        session: {
          ...contradictory.projection.session,
          cwd: "/tmp/contradictory-prompt-state" as SelectedSessionState["projection"]["session"]["cwd"]
        }
      }
    });
    await expectPromptError(harness.service.dispatch(promptIntent()), "target_mismatch");
    const recovery = selectedState(targetA.session_id, targetA.codex_thread_id);
    harness.states.set(targetA.session_id, {
      ...recovery,
      mapping: { ...recovery.mapping, disposition: "recovery_required" }
    });
    await expectPromptError(harness.service.dispatch(promptIntent()), "target_not_writable");
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", false, "stale"));
    await expectPromptError(harness.service.dispatch(promptIntent()), "target_not_writable");
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    await expectPromptError(harness.service.dispatch(promptIntent()), "target_not_writable");
    harness.states.delete(targetA.session_id);
    await expectPromptError(harness.service.dispatch(promptIntent()), "target_not_found");
    await expectPromptError(harness.service.dispatch({ kind: "prompt" }), "invalid_request");
    expect(harness.turns.startCalls).toHaveLength(0);
  });

  it("bounds tracked sessions before a second concurrent start and releases capacity at completion", async () => {
    const harness = createHarness({ includeSecondState: true, maxTrackedTurns: 1 });
    const deferred = deferredResult<CodexTurnAccepted>();
    harness.turns.startResult = deferred.promise;
    const first = harness.service.dispatch(promptIntent());
    await waitFor(() => harness.turns.startCalls.length === 1);
    await expectPromptError(
      harness.service.dispatch(promptIntent({ target: targetB, operation_id: "op_prompt_start_0002" })),
      "service_overloaded"
    );
    deferred.resolve({ thread_id: targetA.codex_thread_id as CodexThreadId, turn_id: "turn-capacity-a" as never, state: "accepted" });
    await first;
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    await harness.service.observeEvent(turnStartedEvent(targetA, "turn-capacity-a"));
    await harness.service.observeEvent(turnCompletedEvent(targetA, "turn-capacity-a"));
    expect(harness.service.tracked_count).toBe(0);
    harness.turns.startResult = null;
    await expect(
      harness.service.dispatch(promptIntent({ target: targetB, operation_id: "op_prompt_start_0003" }))
    ).resolves.toMatchObject({ thread_id: targetB.codex_thread_id });
  });

  it("serializes two same-session starts so only one reaches the wire", async () => {
    const harness = createHarness();
    const deferred = deferredResult<CodexTurnAccepted>();
    harness.turns.startResult = deferred.promise;
    const first = harness.service.dispatch(promptIntent());
    const second = harness.service.dispatch(promptIntent({ operation_id: "op_prompt_start_0002" }));
    await waitFor(() => harness.turns.startCalls.length === 1);
    deferred.resolve({ thread_id: targetA.codex_thread_id as CodexThreadId, turn_id: "turn-serialized-a" as never, state: "accepted" });
    await first;
    await expectPromptError(second, "operation_conflict");
    expect(harness.turns.startCalls).toHaveLength(1);
  });

  it("keeps accepted and event state isolated across two exact threads", async () => {
    const harness = createHarness({ includeSecondState: true });
    const [first, second] = await Promise.all([
      harness.service.dispatch(promptIntent()),
      harness.service.dispatch(promptIntent({ target: targetB, operation_id: "op_prompt_start_0002" }))
    ]);
    expect(first.thread_id).toBe(targetA.codex_thread_id);
    expect(second.thread_id).toBe(targetB.codex_thread_id);
    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    await harness.service.observeEvent(turnStartedEvent(targetA, first.turn_id));
    expect((await harness.service.snapshot(targetA)).phase).toBe("steerable");
    expect((await harness.service.snapshot(targetB)).phase).toBe("accepted");
  });
});

interface FakeTurns extends CodexTurnClient {
  startError: Error | null;
  steerError: Error | null;
  startResult: Promise<CodexTurnAccepted> | null;
  steerResult: Promise<CodexTurnSteered> | null;
  readonly startCalls: CodexTurnStartInput[];
  readonly steerCalls: CodexTurnSteerInput[];
}

interface FakePendingPort {
  readonly settings: Map<string, PendingTurnSetting>;
  readonly dispatchCalls: Array<Record<string, unknown>>;
  dispatchGate: Promise<void> | null;
  dispatchError: Error | null;
  readError: Error | null;
  returnedRevision: number | null;
}

function createHarness(options: { includeSecondState?: boolean; maxTrackedTurns?: number } = {}) {
  const states = new Map<string, SelectedSessionState>();
  states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id));
  if (options.includeSecondState) states.set(targetB.session_id, selectedState(targetB.session_id, targetB.codex_thread_id));
  const statePort: CodexPromptControlStatePort = {
    get: (sessionId) => states.get(sessionId) ?? null,
    getByThreadId: (threadId) => [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null
  };
  const turns = fakeTurns();
  const models = fakeModelPort();
  const plans = fakePlanPort();
  const service = createCodexPromptControlService({
    turns,
    models,
    plans,
    states: statePort,
    ...(options.maxTrackedTurns === undefined ? {} : { max_tracked_turns: options.maxTrackedTurns }),
    now: () => observedAt
  });
  return { service, turns, models, plans, states };
}

async function steerableHarness() {
  const harness = createHarness();
  const accepted = await harness.service.dispatch(promptIntent());
  harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
  await harness.service.observeEvent(turnStartedEvent(targetA, accepted.turn_id));
  return harness;
}

function fakeTurns(): FakeTurns {
  const startCalls: CodexTurnStartInput[] = [];
  const steerCalls: CodexTurnSteerInput[] = [];
  return {
    runtime_version: "0.144.0",
    startError: null,
    steerError: null,
    startResult: null,
    steerResult: null,
    startCalls,
    steerCalls,
    async interruptTurn(input) {
      return {
        thread_id: input.thread_id as CodexThreadId,
        turn_id: input.turn_id as never,
        state: "accepted"
      };
    },
    async startTurn(input) {
      startCalls.push(input);
      if (this.startError !== null) throw this.startError;
      if (this.startResult !== null) return this.startResult;
      return {
        thread_id: input.thread_id as CodexThreadId,
        turn_id: `turn-${input.thread_id}` as never,
        state: "accepted"
      };
    },
    async steerTurn(input) {
      steerCalls.push(input);
      if (this.steerError !== null) throw this.steerError;
      if (this.steerResult !== null) return this.steerResult;
      return {
        thread_id: input.thread_id as CodexThreadId,
        turn_id: input.expected_turn_id as never,
        state: "accepted"
      };
    }
  };
}

function fakeModelPort(): CodexPromptModelPort & FakePendingPort {
  const settings = new Map<string, PendingTurnSetting>();
  const dispatchCalls: Array<Record<string, unknown>> = [];
  return {
    settings,
    dispatchCalls,
    dispatchGate: null,
    dispatchError: null,
    readError: null,
    returnedRevision: null,
    readPendingSettings(target) {
      if (this.readError !== null) throw this.readError;
      const setting = settings.get(target.session_id);
      return setting === undefined ? [] : [setting];
    },
    async dispatchPendingTurn(input) {
      dispatchCalls.push(input as Record<string, unknown>);
      if (this.dispatchGate !== null) await this.dispatchGate;
      if (this.dispatchError !== null) throw this.dispatchError;
      const value = input as Record<string, unknown>;
      const target = value.target as ManagedSessionTarget;
      return {
        thread_id: target.codex_thread_id,
        turn_id: `turn-${target.codex_thread_id}` as never,
        state: "accepted",
        pending_revision: this.returnedRevision ?? (value.expected_pending_revision as number)
      };
    }
  };
}

function fakePlanPort(): CodexPromptPlanPort & FakePendingPort {
  const settings = new Map<string, PendingTurnSetting>();
  const dispatchCalls: Array<Record<string, unknown>> = [];
  return {
    settings,
    dispatchCalls,
    dispatchGate: null,
    dispatchError: null,
    readError: null,
    returnedRevision: null,
    readPendingSettings(target) {
      if (this.readError !== null) throw this.readError;
      const setting = settings.get(target.session_id);
      return setting === undefined ? [] : [setting];
    },
    async dispatchPendingTurn(input) {
      dispatchCalls.push(input as Record<string, unknown>);
      if (this.dispatchGate !== null) await this.dispatchGate;
      if (this.dispatchError !== null) throw this.dispatchError;
      const value = input as Record<string, unknown>;
      const target = value.target as ManagedSessionTarget;
      return {
        thread_id: target.codex_thread_id,
        turn_id: `turn-${target.codex_thread_id}` as never,
        state: "accepted",
        plan_revision: this.returnedRevision ?? (value.expected_plan_revision as number),
        model_revision: value.expected_model_revision as number | null
      };
    }
  };
}

function pending(control: "model" | "plan", revision: number, phase: PendingTurnSetting["phase"] = "pending") {
  return { control, revision, phase } as const;
}

function promptIntent(
  overrides: Partial<{
    operation_id: string;
    target: typeof targetA | typeof targetB;
    text: string;
  }> = {}
) {
  return {
    operation_id: "op_prompt_start_0001",
    target: targetA,
    kind: "prompt",
    text: "Continue the next ready task.",
    ...overrides
  } as const;
}

function selectedState(
  sessionId: string,
  threadId: string,
  turnState: SelectedSessionState["projection"]["session"]["turn_state"] = "idle",
  archived = false,
  freshness: SelectedSessionState["projection"]["session"]["freshness"] = "current"
): SelectedSessionState {
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
        freshness,
        freshness_reason: freshness === "current" ? null : "Projection requires reconciliation.",
        turn_state: turnState,
        attention: "none",
        updated_at: selectedTimestamp,
        last_activity_at: null,
        branch: null,
        model: null,
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

function turnStartedEvent(target: typeof targetA | typeof targetB, turnId: string): NormalizedCodexEvent {
  return {
    sequence: 1,
    method: "turn/started",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: target.codex_thread_id,
    turn_id: turnId,
    status: "in_progress"
  } as NormalizedCodexEvent;
}

function turnCompletedEvent(target: typeof targetA | typeof targetB, turnId: string): NormalizedCodexEvent {
  return {
    sequence: 2,
    method: "turn/completed",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: target.codex_thread_id,
    turn_id: turnId,
    status: "completed",
    error_message: null
  } as NormalizedCodexEvent;
}

function idlePromptState() {
  return {
    phase: "idle",
    last_action: null,
    operation_id: null,
    turn_id: null,
    model_revision: null,
    plan_revision: null,
    requested_at: null,
    accepted_at: null,
    started_at: null,
    error: null
  };
}

function deferredResult<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the prompt test condition.");
}

async function expectPromptError(promise: Promise<unknown>, code: HostDeckCodexPromptControlError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexPromptControlError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckCodexPromptControlError ${code}.`);
}
