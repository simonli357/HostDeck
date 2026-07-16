import {
  type CodexGoalClient,
  type CodexGoalMutationStatus,
  type CodexThreadGoal,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexGoalControlStatePort,
  createCodexGoalControlService,
  HostDeckCodexGoalControlError
} from "./codex-goal-control-service.js";
import type { PendingTurnSetting, PendingTurnSettingsReader } from "./pending-turn-settings.js";

const now = "2026-07-10T19:00:00.000Z";
const targetA = {
  type: "managed_session",
  session_id: "sess_goal_a",
  codex_thread_id: "thread-goal-a"
} as const;
const targetB = {
  type: "managed_session",
  session_id: "sess_goal_b",
  codex_thread_id: "thread-goal-b"
} as const;

describe("Codex structured goal control", () => {
  it("returns the full current goal snapshot without mutating it", async () => {
    const harness = createHarness({ goal: goalA() });
    await expect(harness.service.snapshot(targetA)).resolves.toMatchObject({
      goal: {
        revision: "a".repeat(64),
        objective: "Complete V1.",
        status: "paused",
        token_budget: 10_000,
        tokens_used: 500,
        time_used_seconds: 12.5
      },
      uncertain_mutation: null
    });
    expect(harness.goals.mutations).toHaveLength(0);
  });

  it("sets a new objective as paused state and requires matching read-back", async () => {
    const harness = createHarness({ goal: null });
    const result = await harness.service.mutate(goalIntent("set", null, { objective: "Ship V1." }));

    expect(result).toMatchObject({
      action: "set",
      state: "succeeded",
      dispatched: true,
      goal: { objective: "Ship V1.", status: "paused" }
    });
    expect(harness.goals.mutations).toEqual([
      { action: "set", thread_id: targetA.codex_thread_id, objective: "Ship V1." }
    ]);
  });

  it("rejects missing goals, stale revisions, and mismatched exact targets before mutation", async () => {
    const missing = createHarness({ goal: null });
    await expectGoalError(missing.service.mutate(goalIntent("pause", "a".repeat(64))), "goal_missing");

    const stale = createHarness({ goal: goalA() });
    await expectGoalError(stale.service.mutate(goalIntent("pause", "b".repeat(64))), "operation_conflict");
    await expectGoalError(
      stale.service.snapshot({ ...targetA, codex_thread_id: "thread-other" }),
      "target_mismatch"
    );
    expect(stale.goals.mutations).toHaveLength(0);
  });

  it("rejects contradictory selected identity and recovery disposition before runtime access", async () => {
    const contradictory = createHarness({ goal: goalA() });
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
    await expectGoalError(contradictory.service.snapshot(targetA), "target_mismatch");

    const misplaced = createHarness({ goal: goalA() });
    misplaced.states.set(targetA.session_id, selectedState(targetB.session_id, targetA.codex_thread_id));
    await expectGoalError(misplaced.service.snapshot(targetA), "target_mismatch");

    const recovery = createHarness({ goal: goalA() });
    const recoveryState = selectedState(targetA.session_id, targetA.codex_thread_id);
    recovery.states.set(targetA.session_id, {
      ...recoveryState,
      mapping: { ...recoveryState.mapping, disposition: "recovery_required" }
    });
    await expectGoalError(recovery.service.snapshot(targetA), "target_not_writable");
    expect(recovery.goals.mutations).toHaveLength(0);
  });

  it("allows pause during an active turn without claiming interrupt", async () => {
    const harness = createHarness({ goal: goalA({ status: "active" }), turnState: "in_progress" });
    const result = await harness.service.mutate(goalIntent("pause", "a".repeat(64)));
    expect(result).toMatchObject({ state: "succeeded", goal: { status: "paused" } });
    expect(harness.goals.mutations).toEqual([
      { action: "status", thread_id: targetA.codex_thread_id, status: "paused" }
    ]);
  });

  it("treats resume as agentic acceptance and guards active turns plus pending next-turn settings", async () => {
    const activeTurn = createHarness({ goal: goalA(), turnState: "in_progress" });
    await expectGoalError(activeTurn.service.mutate(goalIntent("resume", "a".repeat(64))), "operation_conflict");

    const pending = createHarness({ goal: goalA(), pending: [{ control: "model", revision: 2, phase: "pending" }] });
    await expectGoalError(pending.service.mutate(goalIntent("resume", "a".repeat(64))), "pending_settings_conflict");
    expect(pending.goals.mutations).toHaveLength(0);

    const ready = createHarness({ goal: goalA() });
    const result = await ready.service.mutate(goalIntent("resume", "a".repeat(64)));
    expect(result).toMatchObject({
      action: "resume",
      state: "accepted",
      dispatched: true,
      goal: { objective: "Complete V1.", status: "active" }
    });
  });

  it("completes and clears only on a proven idle thread with exact read-back", async () => {
    const active = createHarness({ goal: goalA(), turnState: "waiting_for_input" });
    await expectGoalError(active.service.mutate(goalIntent("complete", "a".repeat(64))), "operation_conflict");
    await expectGoalError(active.service.mutate(goalIntent("clear", "a".repeat(64))), "operation_conflict");

    const activeGoal = createHarness({ goal: goalA({ status: "active" }) });
    await expectGoalError(activeGoal.service.mutate(goalIntent("complete", "a".repeat(64))), "operation_conflict");
    await expectGoalError(activeGoal.service.mutate(goalIntent("clear", "a".repeat(64))), "operation_conflict");
    await expectGoalError(
      activeGoal.service.mutate(goalIntent("set", "a".repeat(64), { objective: "Replacement." })),
      "operation_conflict"
    );

    const complete = createHarness({ goal: goalA() });
    await expect(complete.service.mutate(goalIntent("complete", "a".repeat(64)))).resolves.toMatchObject({
      state: "succeeded",
      goal: { status: "complete" }
    });
    const revision = complete.goals.current?.revision ?? null;
    await expect(complete.service.mutate(goalIntent("clear", revision))).resolves.toEqual({
      action: "clear",
      state: "succeeded",
      dispatched: true,
      goal: null
    });
  });

  it("returns state-proven no-ops without dispatching a fake mutation", async () => {
    const paused = createHarness({ goal: goalA() });
    await expect(paused.service.mutate(goalIntent("pause", "a".repeat(64)))).resolves.toMatchObject({
      state: "succeeded",
      dispatched: false
    });
    await expect(
      paused.service.mutate(goalIntent("set", "a".repeat(64), { objective: "Complete V1." }))
    ).resolves.toMatchObject({ state: "succeeded", dispatched: false });
    expect(paused.goals.mutations).toHaveLength(0);

    const complete = createHarness({ goal: goalA({ status: "complete" }) });
    await expect(complete.service.mutate(goalIntent("complete", "a".repeat(64)))).resolves.toMatchObject({
      state: "succeeded",
      dispatched: false
    });
  });

  it("rolls back known rejection but latches unknown outcome without retry", async () => {
    const rejected = createHarness({ goal: goalA() });
    rejected.goals.mutationError = new HostDeckCodexAdapterError("remote_error", "Goal transition rejected.", {
      outcome: "remote_rejected",
      retry_safe: true
    });
    await expectGoalError(rejected.service.mutate(goalIntent("resume", "a".repeat(64))), "operation_conflict");
    expect(rejected.service.uncertain_count).toBe(0);

    const uncertain = createHarness({ goal: goalA() });
    uncertain.goals.mutationError = new HostDeckCodexAdapterError("request_timeout", "Goal response timed out.", {
      outcome: "unknown",
      retry_safe: false
    });
    await expectGoalError(uncertain.service.mutate(goalIntent("resume", "a".repeat(64))), "unknown_outcome");
    expect((await uncertain.service.snapshot(targetA)).uncertain_mutation).toMatchObject({
      action: "resume",
      phase: "unknown",
      baseline_revision: "a".repeat(64),
      requested_status: "active",
      error: { code: "unknown_error" }
    });
    await expectGoalError(uncertain.service.mutate(goalIntent("pause", "a".repeat(64))), "operation_conflict");

    uncertain.goals.mutationError = null;
    uncertain.goals.current = goalA({ revision: "b".repeat(64), status: "active" });
    expect((await uncertain.service.reconcile(targetA)).uncertain_mutation).toBeNull();

    const malformed = createHarness({ goal: goalA() });
    malformed.goals.mutationError = new HostDeckCodexAdapterError("invalid_protocol_message", "Malformed goal response.", {
      outcome: "not_applicable",
      retry_safe: false
    });
    await expectGoalError(malformed.service.mutate(goalIntent("resume", "a".repeat(64))), "runtime_protocol_error");
    expect(malformed.service.uncertain_count).toBe(1);
  });

  it("latches accepted-but-unverified read-back and resolves from a matching event", async () => {
    const harness = createHarness({ goal: goalA({ status: "active" }) });
    harness.goals.readQueue.push(goalA({ status: "active" }), new HostDeckCodexAdapterError("transport_closed", "Read-back closed.", {
      outcome: "not_sent"
    }));
    await expectGoalError(harness.service.mutate(goalIntent("pause", "a".repeat(64))), "unknown_outcome");
    expect(harness.service.uncertain_count).toBe(1);

    await harness.service.observeGoal(goalUpdatedEvent("paused", "Complete V1."));
    expect(harness.service.uncertain_count).toBe(0);
  });

  it("turns contradictory reconciliation and events into explicit conflict", async () => {
    const harness = createHarness({ goal: goalA() });
    harness.goals.mutationError = new HostDeckCodexAdapterError("request_timeout", "Goal response timed out.", {
      outcome: "unknown"
    });
    await expectGoalError(harness.service.mutate(goalIntent("resume", "a".repeat(64))), "unknown_outcome");
    harness.goals.mutationError = null;
    harness.goals.current = goalA({ revision: "c".repeat(64), objective: "Different goal.", status: "paused" });
    expect((await harness.service.reconcile(targetA)).uncertain_mutation).toMatchObject({
      phase: "conflict",
      error: { code: "operation_conflict" }
    });

    const eventConflict = createHarness({ goal: goalA() });
    eventConflict.goals.mutationError = new HostDeckCodexAdapterError("request_timeout", "Goal response timed out.", {
      outcome: "unknown"
    });
    await expectGoalError(eventConflict.service.mutate(goalIntent("resume", "a".repeat(64))), "unknown_outcome");
    await eventConflict.service.observeGoal(goalUpdatedEvent("paused", "Different goal.", "2026-07-10T18:59:59.000Z"));
    expect((await eventConflict.service.snapshot(targetA)).uncertain_mutation).toMatchObject({ phase: "unknown" });
    await eventConflict.service.observeGoal(goalUpdatedEvent("paused", "Different goal."));
    expect((await eventConflict.service.snapshot(targetA)).uncertain_mutation).toMatchObject({ phase: "conflict" });
  });

  it("bounds uncertain sessions and releases capacity on archive", async () => {
    const harness = createHarness({ goal: goalA(), includeSecondState: true, maxUncertain: 1 });
    harness.goals.mutationError = new HostDeckCodexAdapterError("request_timeout", "Goal response timed out.", {
      outcome: "unknown"
    });
    await expectGoalError(harness.service.mutate(goalIntent("resume", "a".repeat(64))), "unknown_outcome");

    harness.goals.current = goalA({ thread_id: targetB.codex_thread_id as never, revision: "d".repeat(64) });
    await expectGoalError(
      harness.service.mutate(goalIntent("resume", "d".repeat(64), { target: targetB })),
      "service_overloaded"
    );

    harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    await expectGoalError(harness.service.snapshot(targetA), "target_not_writable");
    expect(harness.service.uncertain_count).toBe(0);
  });

  it("reserves uncertain capacity across concurrent session mutations", async () => {
    const harness = createHarness({ goal: goalA(), includeSecondState: true, maxUncertain: 1 });
    const deferred = deferredSignal();
    harness.goals.mutationGate = deferred.promise;
    harness.goals.mutationError = new HostDeckCodexAdapterError("request_timeout", "Goal response timed out.", {
      outcome: "unknown"
    });
    const first = harness.service.mutate(goalIntent("resume", "a".repeat(64)));
    await Promise.resolve();
    await Promise.resolve();
    await expectGoalError(
      harness.service.mutate(goalIntent("resume", "a".repeat(64), { target: targetB })),
      "service_overloaded"
    );
    deferred.resolve();
    await expectGoalError(first, "unknown_outcome");
    expect(harness.service.uncertain_count).toBe(1);
  });

  it("revalidates an archive that races a goal read before mutation", async () => {
    const harness = createHarness({ goal: null });
    harness.goals.readHook = () => {
      harness.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "idle", true));
    };
    await expectGoalError(
      harness.service.mutate(goalIntent("set", null, { objective: "Ship V1." })),
      "target_not_writable"
    );
    expect(harness.goals.mutations).toHaveLength(0);

    const turnRace = createHarness({ goal: null });
    turnRace.goals.readHook = () => {
      turnRace.states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, "in_progress"));
    };
    await expectGoalError(
      turnRace.service.mutate(goalIntent("set", null, { objective: "Ship V1." })),
      "operation_conflict"
    );
    expect(turnRace.goals.mutations).toHaveLength(0);
  });
});

interface FakeGoals extends CodexGoalClient {
  current: CodexThreadGoal | null;
  mutationError: Error | null;
  mutationGate: Promise<void> | null;
  readHook: (() => void) | null;
  readonly readQueue: Array<CodexThreadGoal | null | Error>;
  readonly mutations: Array<Record<string, unknown>>;
}

function createHarness(
  options: {
    goal?: CodexThreadGoal | null;
    turnState?: string;
    pending?: readonly PendingTurnSetting[];
    includeSecondState?: boolean;
    maxUncertain?: number;
  } = {}
) {
  const states = new Map<string, SelectedSessionState>();
  states.set(targetA.session_id, selectedState(targetA.session_id, targetA.codex_thread_id, options.turnState ?? "idle"));
  if (options.includeSecondState) states.set(targetB.session_id, selectedState(targetB.session_id, targetB.codex_thread_id));
  const statePort: CodexGoalControlStatePort = {
    get: (sessionId) => states.get(sessionId) ?? null,
    getByThreadId: (threadId) => [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null
  };
  const pendingSettings: PendingTurnSettingsReader = {
    readPendingSettings: () => options.pending ?? []
  };
  const goals = fakeGoals(options.goal === undefined ? goalA() : options.goal);
  const service = createCodexGoalControlService({
    goals,
    states: statePort,
    pending_settings: pendingSettings,
    ...(options.maxUncertain === undefined ? {} : { max_uncertain_mutations: options.maxUncertain }),
    now: () => now
  });
  return { service, goals, states };
}

function fakeGoals(initial: CodexThreadGoal | null): FakeGoals {
  const mutations: Array<Record<string, unknown>> = [];
  return {
    runtime_version: "0.144.0",
    current: initial,
    mutationError: null,
    mutationGate: null,
    readHook: null,
    readQueue: [],
    mutations,
    async read(threadId) {
      this.readHook?.();
      const queued = this.readQueue.shift();
      if (queued instanceof Error) throw queued;
      const value = queued === undefined ? this.current : queued;
      if (value === null) return null;
      return { ...value, thread_id: threadId as never };
    },
    async setPaused(threadId, objective) {
      mutations.push({ action: "set", thread_id: threadId, objective });
      if (this.mutationGate !== null) await this.mutationGate;
      if (this.mutationError !== null) throw this.mutationError;
      this.current = nextGoal(this.current, { thread_id: threadId as never, objective, status: "paused" });
      return this.current;
    },
    async setStatus(threadId, status: CodexGoalMutationStatus) {
      mutations.push({ action: "status", thread_id: threadId, status });
      if (this.mutationGate !== null) await this.mutationGate;
      if (this.mutationError !== null) throw this.mutationError;
      if (this.current === null) throw new Error("Fake goal is missing.");
      this.current = nextGoal(this.current, { thread_id: threadId as never, status });
      return this.current;
    },
    async clear(threadId) {
      mutations.push({ action: "clear", thread_id: threadId });
      if (this.mutationGate !== null) await this.mutationGate;
      if (this.mutationError !== null) throw this.mutationError;
      const cleared = this.current !== null;
      this.current = null;
      return cleared;
    }
  };
}

function nextGoal(current: CodexThreadGoal | null, overrides: Partial<CodexThreadGoal>): CodexThreadGoal {
  return goalA({
    ...(current ?? {}),
    revision: current?.revision === "a".repeat(64) ? "b".repeat(64) : "c".repeat(64),
    updated_at: "2026-07-10T18:01:00.000Z" as never,
    ...overrides
  });
}

function goalA(overrides: Partial<CodexThreadGoal> = {}): CodexThreadGoal {
  return {
    thread_id: targetA.codex_thread_id as never,
    revision: "a".repeat(64),
    objective: "Complete V1.",
    status: "paused",
    token_budget: 10_000,
    tokens_used: 500,
    time_used_seconds: 12.5,
    created_at: "2026-07-10T18:00:00.000Z" as never,
    updated_at: "2026-07-10T18:00:30.000Z" as never,
    ...overrides
  };
}

function goalIntent(
  action: "clear" | "complete" | "pause" | "resume" | "set",
  revision: string | null,
  overrides: Partial<{ objective: string | null; target: typeof targetA | typeof targetB }> = {}
) {
  return {
    operation_id: `op_goal_${action}_0001`,
    target: targetA,
    kind: "goal",
    action,
    objective: action === "set" ? "Complete V1." : null,
    expected_goal_revision: revision,
    ...overrides
  } as const;
}

function selectedState(sessionId: string, threadId: string, turnState = "idle", archived = false): SelectedSessionState {
  const archivedAt = archived ? now : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: sessionId.replace(/^sess_/u, ""),
    codex_thread_id: threadId,
    cwd: `/tmp/${sessionId}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: now,
    updated_at: now,
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
      updated_at: now,
      last_activity_at: now,
      branch: "main",
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed Codex goal session ready.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function goalUpdatedEvent(
  status: "active" | "blocked" | "complete" | "paused",
  objective: string,
  capturedAt = now
): NormalizedCodexEvent {
  return {
    method: "thread/goal/updated",
    thread_id: targetA.codex_thread_id,
    objective,
    status,
    captured_at: capturedAt
  } as NormalizedCodexEvent;
}

async function expectGoalError(promise: Promise<unknown>, code: HostDeckCodexGoalControlError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexGoalControlError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckCodexGoalControlError ${code}.`);
}

function deferredSignal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
