import {
  type CodexTurnInterruptAccepted,
  type CodexTurnInterruptInput,
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
  type CodexInterruptControlService,
  createCodexInterruptControlService,
  HostDeckCodexInterruptControlError
} from "./codex-interrupt-control-service.js";
import {
  type WithTestOperationDeadlines,
  withTestOperationDeadlines
} from "./test-operation-deadline.js";

type TestInterruptControlService = WithTestOperationDeadlines<
  CodexInterruptControlService,
  "interrupt" | "waitForTerminal"
>;

const observedAt = "2026-07-10T22:30:00.000Z";
interface TestTarget {
  readonly type: "turn";
  readonly session_id: string;
  readonly codex_thread_id: string;
  readonly turn_id: string;
}

const targetA = {
  type: "turn",
  session_id: "sess_interrupt_a",
  codex_thread_id: "thread-interrupt-a",
  turn_id: "turn-interrupt-a"
} as const;
const targetB = {
  type: "turn",
  session_id: "sess_interrupt_b",
  codex_thread_id: "thread-interrupt-b",
  turn_id: "turn-interrupt-b"
} as const;

describe("Codex interrupt control", () => {
  it("requires event-proven active identity, dispatches once, and settles only interrupted terminal truth", async () => {
    const harness = createHarness();
    harness.states.set(targetA.session_id, selectedState(targetA, "in_progress"));
    await harness.service.observeEvent(turnStartedEvent(targetA));
    const controller = new AbortController();

    const accepted = await harness.service.interrupt(
      interruptIntent(targetA, "op_interrupt_accept_0001"),
      controller.signal
    );
    expect(accepted).toMatchObject({
      operation_id: "op_interrupt_accept_0001",
      kind: "interrupt",
      target: targetA,
      state: "accepted",
      turn_id: targetA.turn_id,
      error: null
    });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(harness.turns.calls).toHaveLength(1);
    expect(harness.turns.calls[0]).toMatchObject({
      operation_id: "op_interrupt_accept_0001",
      thread_id: targetA.codex_thread_id,
      turn_id: targetA.turn_id
    });
    expect(harness.turns.calls[0]?.deadline?.signal).toBe(controller.signal);
    expect(harness.service.active_count).toBe(1);
    expect(harness.service.pending_count).toBe(1);

    await harness.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "interrupted", error: null });
    expect(harness.service.active_count).toBe(0);
    expect(harness.service.pending_count).toBe(0);
    expect(harness.states.get(targetA.session_id)?.mapping.archived_at).toBeNull();
  });

  it("proves exact interruptibility without dispatching and rejects it after one terminal attempt", async () => {
    const harness = await activeHarness();
    await expect(harness.service.requireInterruptible(targetA)).resolves.toBeUndefined();
    expect(harness.turns.calls).toHaveLength(0);

    await harness.service.interrupt(interruptIntent(targetA, "op_interrupt_admission_0001"));
    await harness.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    await expectInterruptError(harness.service.requireInterruptible(targetA), "operation_conflict");
    expect(harness.turns.calls).toHaveLength(1);
  });

  it("waits event-driven for exact terminal truth and removes an aborted waiter", async () => {
    const completed = await activeHarness();
    await completed.service.interrupt(interruptIntent(targetA, "op_interrupt_wait_0001"));
    const completionSignal = new AbortController();
    let settled = false;
    const waiting = completed.service.waitForTerminal(targetA, completionSignal.signal).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await completed.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    await expect(waiting).resolves.toMatchObject({ state: "interrupted", error: null });

    const aborted = await activeHarness();
    await aborted.service.interrupt(interruptIntent(targetA, "op_interrupt_wait_abort_0001"));
    const abortController = new AbortController();
    const abortedWait = aborted.service.waitForTerminal(targetA, abortController.signal);
    abortController.abort();
    const waitError = await expectInterruptError(abortedWait, "operation_timeout");
    expect(waitError).toMatchObject({ api_code: "operation_timeout", outcome: "unknown", retry_safe: false });
    await aborted.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    await expect(aborted.service.waitForTerminal(targetA, new AbortController().signal)).resolves.toMatchObject({
      state: "interrupted"
    });
  });

  it("accepts a goal or TUI-originated active event without prompt-control ownership", async () => {
    const harness = createHarness();
    harness.states.set(targetA.session_id, selectedState(targetA, "waiting_for_input"));
    await harness.service.observeEvent(turnStartedEvent(targetA));

    await expect(harness.service.interrupt(interruptIntent(targetA, "op_interrupt_external_0001"))).resolves.toMatchObject({
      state: "accepted"
    });
    expect(harness.turns.calls).toHaveLength(1);
  });

  it("serializes concurrent attempts and preserves an early interrupted event", async () => {
    const harness = await activeHarness();
    const gate = deferred<void>();
    harness.turns.gate = gate.promise;
    const first = harness.service.interrupt(interruptIntent(targetA, "op_interrupt_race_first_0001"));
    await waitFor(() => harness.turns.calls.length === 1);
    const duplicate = harness.service.interrupt(interruptIntent(targetA, "op_interrupt_race_duplicate_0001"));
    const terminal = harness.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    gate.resolve();

    expect(await first).toMatchObject({ state: "interrupted", error: null });
    await expectInterruptError(duplicate, "operation_conflict");
    await terminal;
    expect(harness.turns.calls).toHaveLength(1);
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "interrupted" });
  });

  it("latches possible-send ambiguity without retry and reconciles a later interrupted event", async () => {
    const harness = await activeHarness();
    harness.turns.error = new HostDeckCodexAdapterError("request_timeout", "interrupt timed out", {
      outcome: "unknown",
      retry_safe: false
    });

    await expectInterruptError(
      harness.service.interrupt(interruptIntent(targetA, "op_interrupt_unknown_0001")),
      "operation_timeout"
    );
    expect(await harness.service.snapshot(targetA)).toMatchObject({
      state: "incomplete",
      error: { code: "operation_timeout", retryable: false }
    });
    harness.turns.error = null;
    await expectInterruptError(
      harness.service.interrupt(interruptIntent(targetA, "op_interrupt_unknown_retry_0001")),
      "operation_conflict"
    );
    expect(harness.turns.calls).toHaveLength(1);

    await harness.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "interrupted", error: null });
  });

  it("recovers unknown response from an early event but never treats normal or failed terminal as interrupted", async () => {
    const recovered = await activeHarness();
    const gate = deferred<void>();
    recovered.turns.gate = gate.promise;
    recovered.turns.error = new HostDeckCodexAdapterError("request_timeout", "possible send", {
      outcome: "unknown",
      retry_safe: false
    });
    const response = recovered.service.interrupt(interruptIntent(targetA, "op_interrupt_unknown_event_0001"));
    await waitFor(() => recovered.turns.calls.length === 1);
    const terminal = recovered.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    gate.resolve();
    expect(await response).toMatchObject({ state: "interrupted", error: null });
    await terminal;

    for (const status of ["completed", "failed"] as const) {
      const harness = await activeHarness();
      await harness.service.interrupt(interruptIntent(targetA, `op_interrupt_${status}_0001`));
      await harness.service.observeEvent(turnCompletedEvent(targetA, status));
      expect(await harness.service.snapshot(targetA)).toMatchObject({
        state: "failed",
        error: { code: "operation_conflict", retryable: false }
      });
      expect((await harness.service.snapshot(targetA))?.error?.message).toContain(status);
    }
  });

  it("permits explicit retry only after a proven not-sent or known remote rejection", async () => {
    for (const failure of [
      new HostDeckCodexAdapterError("transport_send_failed", "not sent", { outcome: "not_sent", retry_safe: true }),
      new HostDeckCodexAdapterError("remote_error", "turn still active", {
        outcome: "remote_rejected",
        retry_safe: false,
        rpc_code: -32_600
      })
    ]) {
      const harness = await activeHarness();
      harness.turns.error = failure;
      await expect(harness.service.interrupt(interruptIntent(targetA, "op_interrupt_known_failure_0001"))).rejects.toBeInstanceOf(
        HostDeckCodexInterruptControlError
      );
      expect(await harness.service.snapshot(targetA)).toBeNull();
      harness.turns.error = null;
      await expect(
        harness.service.interrupt(interruptIntent(targetA, "op_interrupt_known_retry_0001"))
      ).resolves.toMatchObject({ state: "accepted" });
      expect(harness.turns.calls).toHaveLength(2);
    }
  });

  it("rejects projection-only, inactive, wrong-turn, stale, archived, and mismatched targets before wire", async () => {
    const projectionOnly = createHarness();
    projectionOnly.states.set(targetA.session_id, selectedState(targetA, "in_progress"));
    await expectInterruptError(
      projectionOnly.service.interrupt(interruptIntent(targetA, "op_interrupt_projection_only_0001")),
      "operation_conflict"
    );

    const inactive = createHarness();
    await inactive.service.observeEvent(turnStartedEvent(targetA));
    await expectInterruptError(
      inactive.service.interrupt(interruptIntent(targetA, "op_interrupt_inactive_0001")),
      "operation_conflict"
    );

    const wrongTurn = await activeHarness();
    await expectInterruptError(
      wrongTurn.service.interrupt(
        interruptIntent({ ...targetA, turn_id: "turn-interrupt-other" }, "op_interrupt_wrong_turn_0001")
      ),
      "operation_conflict"
    );

    const stale = await activeHarness();
    stale.states.set(targetA.session_id, selectedState(targetA, "in_progress", "stale"));
    await expectInterruptError(stale.service.interrupt(interruptIntent(targetA, "op_interrupt_stale_0001")), "target_not_writable");

    const archived = await activeHarness();
    archived.states.set(targetA.session_id, selectedState(targetA, "in_progress", "current", true));
    await expectInterruptError(
      archived.service.interrupt(interruptIntent(targetA, "op_interrupt_archived_0001")),
      "target_not_writable"
    );

    const mismatch = await activeHarness();
    await expectInterruptError(
      mismatch.service.interrupt(
        interruptIntent({ ...targetA, codex_thread_id: targetB.codex_thread_id }, "op_interrupt_mismatch_0001")
      ),
      "target_mismatch"
    );
    expect([
      projectionOnly.turns.calls.length,
      inactive.turns.calls.length,
      wrongTurn.turns.calls.length,
      stale.turns.calls.length,
      archived.turns.calls.length,
      mismatch.turns.calls.length
    ]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects malformed confirmation, missing session, and invalid signal before wire", async () => {
    const harness = await activeHarness();
    await expectInterruptError(
      harness.service.interrupt({ ...interruptIntent(targetA, "op_interrupt_confirm_0001"), confirm: false }),
      "invalid_request"
    );
    await expectInterruptError(
      harness.service.interrupt(interruptIntent({ ...targetA, session_id: "sess_interrupt_missing" }, "op_interrupt_missing_0001")),
      "target_not_found"
    );
    await expectInterruptError(
      harness.service.interrupt(interruptIntent(targetA, "op_interrupt_signal_0001"), {} as never),
      "invalid_request"
    );
    await expectInterruptError(harness.service.waitForTerminal(targetA, {} as never), "invalid_request");
    expect(harness.turns.calls).toHaveLength(0);
  });

  it("fails closed for complete selected identity, runtime version, and state-port errors", async () => {
    const runtimeDrift = await activeHarness();
    runtimeDrift.states.set(targetA.session_id, selectedStateWithRuntime(targetA, "0.145.0", "in_progress"));
    await expectInterruptError(
      runtimeDrift.service.interrupt(interruptIntent(targetA, "op_interrupt_runtime_drift_0001")),
      "target_stale"
    );

    const recovery = await activeHarness();
    recovery.states.set(targetA.session_id, selectedStateWithDisposition(targetA, "recovery_required", "in_progress"));
    await expectInterruptError(
      recovery.service.interrupt(interruptIntent(targetA, "op_interrupt_recovery_0001")),
      "target_stale"
    );

    const malformed = await activeHarness();
    malformed.states.set(targetA.session_id, {
      mapping: { ...selectedState(targetA).mapping, cwd: "/tmp/identity-a" },
      projection: {
        ...selectedState(targetA, "in_progress").projection,
        session: { ...selectedState(targetA, "in_progress").projection.session, cwd: "/tmp/identity-b" }
      }
    } as SelectedSessionState);
    await expectInterruptError(
      malformed.service.interrupt(interruptIntent(targetA, "op_interrupt_identity_0001")),
      "target_mismatch"
    );

    const stateFailure = createHarness({ throwOnGet: true });
    stateFailure.states.set(targetA.session_id, selectedState(targetA, "in_progress"));
    await stateFailure.service.observeEvent(turnStartedEvent(targetA));
    await expectInterruptError(
      stateFailure.service.interrupt(interruptIntent(targetA, "op_interrupt_state_failure_0001")),
      "state_unavailable"
    );

    expect([
      runtimeDrift.turns.calls.length,
      recovery.turns.calls.length,
      malformed.turns.calls.length,
      stateFailure.turns.calls.length
    ]).toEqual([0, 0, 0, 0]);
  });

  it("requires exact accessor-free options and a compatibility-aware turn port", () => {
    const harness = createHarness();
    const base = {
      turns: harness.turns,
      states: {
        get: (session: string) => harness.states.get(session) ?? null,
        getByThreadId: (thread: string) =>
          [...harness.states.values()].find((state) => state.mapping.codex_thread_id === thread) ?? null
      }
    };
    for (const candidate of [
      null,
      {},
      { ...base, extra: true },
      { ...base, turns: { interruptTurn: harness.turns.interruptTurn } },
      { ...base, states: { get: base.states.get } },
      { ...base, now: "invalid" },
      { ...base, max_tracked_turns: 0 }
    ]) {
      expect(() => createCodexInterruptControlService(candidate as never)).toThrow();
    }
    let accessorCalls = 0;
    const accessor = Object.defineProperty({ states: base.states }, "turns", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private turn accessor");
      }
    });
    expect(() => createCodexInterruptControlService(accessor as never)).toThrow();
    expect(accessorCalls).toBe(0);

    let portAccessorCalls = 0;
    const hostileTurns = Object.defineProperty({ runtime_version: "0.144.0" }, "interruptTurn", {
      enumerable: true,
      get() {
        portAccessorCalls += 1;
        throw new Error("private interrupt method accessor");
      }
    });
    expect(() => createCodexInterruptControlService({ ...base, turns: hostileTurns } as never)).toThrow();
    expect(portAccessorCalls).toBe(0);
  });

  it("marks archive during accepted interrupt incomplete without treating it as interruption", async () => {
    const harness = await activeHarness();
    const gate = deferred<void>();
    harness.turns.gate = gate.promise;
    const response = harness.service.interrupt(interruptIntent(targetA, "op_interrupt_archive_0001"));
    await waitFor(() => harness.turns.calls.length === 1);
    const archive = harness.service.observeEvent(threadArchivedEvent(targetA));
    gate.resolve();

    expect(await response).toMatchObject({
      state: "incomplete",
      error: { code: "session_not_writable", retryable: false }
    });
    await archive;
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "incomplete" });
    expect(harness.service.active_count).toBe(0);
    expect(harness.turns.calls).toHaveLength(1);
  });

  it("isolates foreign terminal events and fails loudly for a second concurrent active turn", async () => {
    const harness = createHarness({ includeSecondState: true });
    harness.states.set(targetA.session_id, selectedState(targetA, "in_progress"));
    harness.states.set(targetB.session_id, selectedState(targetB, "in_progress"));
    await harness.service.observeEvent(turnStartedEvent(targetA));
    await harness.service.observeEvent(turnStartedEvent(targetB));
    await harness.service.interrupt(interruptIntent(targetA, "op_interrupt_isolation_0001"));

    await harness.service.observeEvent(turnCompletedEvent(targetB, "interrupted"));
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "accepted" });
    await expectInterruptError(
      harness.service.observeEvent(turnStartedEvent({ ...targetA, turn_id: "turn-interrupt-second" })),
      "runtime_protocol_error"
    );
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "accepted" });
  });

  it("bounds active sessions and evicts terminal history before admitting a later turn", async () => {
    const harness = createHarness({ includeSecondState: true, maxTrackedTurns: 1 });
    harness.states.set(targetA.session_id, selectedState(targetA, "in_progress"));
    harness.states.set(targetB.session_id, selectedState(targetB, "in_progress"));
    await harness.service.observeEvent(turnStartedEvent(targetA));
    await expectInterruptError(harness.service.observeEvent(turnStartedEvent(targetB)), "service_overloaded");

    await harness.service.interrupt(interruptIntent(targetA, "op_interrupt_capacity_0001"));
    await harness.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    await harness.service.observeEvent(turnStartedEvent(targetB));
    expect(harness.service.active_count).toBe(1);
    expect(harness.service.tracked_count).toBe(0);
    expect(await harness.service.snapshot(targetA)).toBeNull();
  });

  it("latches a contradictory accepted target as unknown and does not send again", async () => {
    const harness = await activeHarness();
    harness.turns.result = {
      thread_id: targetA.codex_thread_id as never,
      turn_id: "turn-interrupt-foreign" as never,
      state: "accepted"
    };
    await expectInterruptError(
      harness.service.interrupt(interruptIntent(targetA, "op_interrupt_contradiction_0001")),
      "runtime_protocol_error"
    );
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "incomplete", error: { code: "protocol_error" } });
    await expectInterruptError(
      harness.service.interrupt(interruptIntent(targetA, "op_interrupt_contradiction_retry_0001")),
      "operation_conflict"
    );
    expect(harness.turns.calls).toHaveLength(1);
  });

  it("does not read the clock again after the interrupt reaches the wire", async () => {
    const harness = await activeHarness();
    const gate = deferred<void>();
    harness.turns.gate = gate.promise;
    const response = harness.service.interrupt(interruptIntent(targetA, "op_interrupt_clock_race_0001"));
    await waitFor(() => harness.turns.calls.length === 1);
    harness.now.value = "invalid-after-send";
    gate.resolve();

    await expect(response).resolves.toMatchObject({ state: "accepted", updated_at: observedAt });
    expect(harness.turns.calls).toHaveLength(1);
  });

  it("rejects contradictory terminal statuses without rewriting proven interrupt truth", async () => {
    const harness = await activeHarness();
    await harness.service.interrupt(interruptIntent(targetA, "op_interrupt_terminal_contradiction_0001"));
    await harness.service.observeEvent(turnCompletedEvent(targetA, "interrupted"));
    await expectInterruptError(
      harness.service.observeEvent(turnCompletedEvent(targetA, "completed")),
      "runtime_protocol_error"
    );
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "interrupted", error: null });
  });
});

interface FakeTurns {
  readonly calls: CodexTurnInterruptInput[];
  runtime_version: string;
  error: Error | null;
  gate: Promise<void> | null;
  result: CodexTurnInterruptAccepted | null;
  interruptTurn(input: CodexTurnInterruptInput): Promise<CodexTurnInterruptAccepted>;
}

interface Harness {
  readonly service: TestInterruptControlService;
  readonly turns: FakeTurns;
  readonly states: Map<string, SelectedSessionState>;
  readonly now: { value: string };
}

function createHarness(
  options: {
    readonly includeSecondState?: boolean;
    readonly maxTrackedTurns?: number;
    readonly throwOnGet?: boolean;
  } = {}
): Harness {
  const turns: FakeTurns = {
    calls: [],
    runtime_version: "0.144.0",
    error: null,
    gate: null,
    result: null,
    async interruptTurn(input) {
      this.calls.push(input);
      if (this.gate !== null) await this.gate;
      if (this.error !== null) throw this.error;
      return (
        this.result ?? {
          thread_id: input.thread_id as never,
          turn_id: input.turn_id as never,
          state: "accepted"
        }
      );
    }
  };
  const states = new Map<string, SelectedSessionState>([[targetA.session_id, selectedState(targetA)]]);
  if (options.includeSecondState) states.set(targetB.session_id, selectedState(targetB));
  const now = { value: observedAt };
  const service = withTestOperationDeadlines(createCodexInterruptControlService({
    turns,
    states: {
      get: (sessionId) => {
        if (options.throwOnGet) throw new Error("private selected-state failure");
        return states.get(sessionId) ?? null;
      },
      getByThreadId: (threadId) => [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null
    },
    ...(options.maxTrackedTurns === undefined ? {} : { max_tracked_turns: options.maxTrackedTurns }),
    now: () => now.value
  }), ["interrupt", "waitForTerminal"]);
  return { service, turns, states, now };
}

function selectedStateWithRuntime(target: TestTarget, runtimeVersion: string, turnState = "idle"): SelectedSessionState {
  const state = selectedState(target, turnState);
  return {
    mapping: selectedSessionMappingRecordSchema.parse({ ...state.mapping, runtime_version: runtimeVersion }),
    projection: selectedSessionProjectionRecordSchema.parse({
      ...state.projection,
      session: { ...state.projection.session, runtime_version: runtimeVersion }
    })
  };
}

function selectedStateWithDisposition(
  target: TestTarget,
  disposition: "recovery_required" | "selected",
  turnState = "idle"
): SelectedSessionState {
  const state = selectedState(target, turnState);
  return {
    mapping: selectedSessionMappingRecordSchema.parse({ ...state.mapping, disposition }),
    projection: state.projection
  };
}

async function activeHarness(): Promise<Harness> {
  const harness = createHarness();
  harness.states.set(targetA.session_id, selectedState(targetA, "in_progress"));
  await harness.service.observeEvent(turnStartedEvent(targetA));
  return harness;
}

function selectedState(
  target: TestTarget,
  turnState = "idle",
  freshness = "current",
  archived = false
): SelectedSessionState {
  const archivedAt = archived ? observedAt : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: target.session_id,
    name: target.session_id,
    codex_thread_id: target.codex_thread_id,
    cwd: "/tmp/interrupt-project",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: observedAt,
    updated_at: observedAt,
    archived_at: archivedAt
  });
  return {
    mapping,
    projection: selectedSessionProjectionRecordSchema.parse({
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
        turn_state: archived ? "idle" : turnState,
        attention:
          turnState === "waiting_for_approval"
            ? "needs_approval"
            : turnState === "waiting_for_input"
              ? "needs_input"
              : "none",
        freshness,
        freshness_reason: freshness === "current" ? null : "Runtime reconciliation is required.",
        updated_at: observedAt,
        last_activity_at: observedAt,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "Managed interrupt test session.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

function interruptIntent(target: TestTarget, operationId: string) {
  return {
    operation_id: operationId,
    target,
    kind: "interrupt",
    confirm: true
  } as const;
}

function turnStartedEvent(target: TestTarget): NormalizedCodexEvent {
  return {
    sequence: 1,
    method: "turn/started",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: `${target.turn_id}:started`,
    scope: "thread",
    thread_id: target.codex_thread_id,
    turn_id: target.turn_id,
    status: "in_progress"
  } as NormalizedCodexEvent;
}

function turnCompletedEvent(
  target: TestTarget,
  status: "completed" | "failed" | "interrupted"
): NormalizedCodexEvent {
  return {
    sequence: 2,
    method: "turn/completed",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: `${target.turn_id}:${status}`,
    scope: "thread",
    thread_id: target.codex_thread_id,
    turn_id: target.turn_id,
    status,
    error_message: status === "failed" ? "The active turn failed." : null
  } as NormalizedCodexEvent;
}

function threadArchivedEvent(target: TestTarget): NormalizedCodexEvent {
  return {
    sequence: 3,
    method: "thread/archived",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: `${target.codex_thread_id}:archived`,
    scope: "thread",
    thread_id: target.codex_thread_id
  } as NormalizedCodexEvent;
}

async function expectInterruptError(
  promise: Promise<unknown>,
  code: HostDeckCodexInterruptControlError["code"]
): Promise<HostDeckCodexInterruptControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexInterruptControlError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexInterruptControlError;
  }
  throw new Error(`Expected interrupt error ${code}.`);
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
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
  throw new Error("Timed out waiting for interrupt test state.");
}
