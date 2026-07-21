import {
  type CodexCompactAccepted,
  type CodexCompactClient,
  type CodexCompactInput,
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
  type CodexCompactControlErrorCode,
  type CodexCompactControlStatePort,
  createCodexCompactControlService,
  HostDeckCodexCompactControlError
} from "./codex-compact-control-service.js";
import {
  testOperationDeadline,
  withTestOperationDeadlines
} from "./test-operation-deadline.js";

const requestedAt = "2026-07-11T18:00:00.000Z";
const acceptedAt = "2026-07-11T18:00:01.000Z";

interface TestTarget {
  readonly type: "managed_session";
  readonly session_id: string;
  readonly codex_thread_id: string;
}

const targetA = {
  type: "managed_session",
  session_id: "sess_compact_control_a",
  codex_thread_id: "thread-compact-control-a"
} as const;
const targetB = {
  type: "managed_session",
  session_id: "sess_compact_control_b",
  codex_thread_id: "thread-compact-control-b"
} as const;
const turnA = "turn-compact-control-a";
const itemA = "item-compact-control-a";

describe("Codex compact control service", () => {
  it("returns accepted-only, then requires the exact item/turn conjunction for completion", async () => {
    const harness = createHarness();
    harness.states.put(selectedState(targetA));
    const controller = new AbortController();

    const accepted = await harness.service.compact(
      compactIntent(targetA, "op_compact_control_accept_0001"),
      controller.signal
    );
    expect(accepted).toEqual({
      operation_id: "op_compact_control_accept_0001",
      kind: "compact",
      target: targetA,
      state: "accepted",
      updated_at: acceptedAt,
      turn_id: null,
      error: null
    });
    expect(Object.isFrozen(harness.service)).toBe(true);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(harness.compact.calls).toHaveLength(1);
    expect(harness.compact.calls[0]).toMatchObject({
      operation_id: "op_compact_control_accept_0001",
      thread_id: targetA.codex_thread_id
    });
    expect(harness.compact.calls[0]?.deadline?.signal).toBe(controller.signal);

    await harness.service.observe(turnStarted(targetA, turnA, 1), 3);
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "accepted", turn_id: null });
    await harness.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3);
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "running", turn_id: turnA });
    await harness.service.observe(compactionItem(targetA, turnA, itemA, "completed", 3), 3);
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "running", turn_id: turnA });
    await harness.service.observe(turnCompleted(targetA, turnA, "completed", 4), 3);
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "completed", turn_id: turnA, error: null });
    expect(harness.service.active_count).toBe(0);
    expect(harness.service.tracked_count).toBe(1);
  });

  it("preserves notifications that race the response while returning accepted-only", async () => {
    const harness = createHarness();
    harness.states.put(selectedState(targetA));
    const gate = deferred<void>();
    harness.compact.gate = gate.promise;

    const response = harness.service.compact(compactIntent(targetA, "op_compact_control_race_0001"));
    await waitFor(() => harness.compact.calls.length === 1);
    const observations = [
      harness.service.observe(turnStarted(targetA, turnA, 1), 3),
      harness.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3),
      harness.service.observe(compactionItem(targetA, turnA, itemA, "completed", 3), 3),
      harness.service.observe(turnCompleted(targetA, turnA, "completed", 4), 3)
    ];
    gate.resolve();

    expect(await response).toMatchObject({ state: "accepted", turn_id: null });
    await Promise.all(observations);
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "completed", turn_id: turnA });
    expect(harness.compact.calls).toHaveLength(1);
  });

  it("does not claim completion when the compact item never completes", async () => {
    const harness = await acceptedHarness(targetA);
    await harness.service.observe(turnStarted(targetA, turnA, 1), 3);
    await harness.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3);
    await harness.service.observe(turnCompleted(targetA, turnA, "completed", 3), 3);

    expect(await harness.service.snapshot(targetA)).toMatchObject({
      state: "incomplete",
      turn_id: turnA,
      error: { code: "protocol_error", retryable: false }
    });
  });

  it("preserves authoritative interrupted and failed compact turns", async () => {
    const interrupted = await acceptedHarness(targetA);
    await interrupted.service.observe(turnStarted(targetA, turnA, 1), 3);
    await interrupted.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3);
    await interrupted.service.observe(turnCompleted(targetA, turnA, "interrupted", 3), 3);
    expect(await interrupted.service.snapshot(targetA)).toMatchObject({
      state: "interrupted",
      turn_id: turnA,
      error: null
    });

    const failed = await acceptedHarness(targetA);
    await failed.service.observe(turnStarted(targetA, turnA, 1), 3);
    await failed.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3);
    await failed.service.observe(turnCompleted(targetA, turnA, "failed", 3), 3);
    expect(await failed.service.snapshot(targetA)).toMatchObject({
      state: "failed",
      turn_id: turnA,
      error: { code: "unknown_error", retryable: false }
    });
  });

  it("latches a possible send without retry and reconciles later exact lifecycle evidence", async () => {
    const harness = createHarness();
    harness.states.put(selectedState(targetA));
    harness.compact.error = new HostDeckCodexAdapterError("request_timeout", "compact timeout", {
      outcome: "unknown",
      retry_safe: false
    });

    await expectCompactError(
      harness.service.compact(compactIntent(targetA, "op_compact_control_unknown_0001")),
      "operation_timeout"
    );
    expect(await harness.service.snapshot(targetA)).toMatchObject({
      state: "incomplete",
      turn_id: null,
      error: { code: "operation_timeout", retryable: false }
    });
    harness.compact.error = null;
    await expectCompactError(
      harness.service.compact(compactIntent(targetA, "op_compact_control_unknown_retry_0001")),
      "operation_conflict"
    );
    expect(harness.compact.calls).toHaveLength(1);

    await harness.service.observe(turnStarted(targetA, turnA, 1), 3);
    await harness.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3);
    await harness.service.observe(compactionItem(targetA, turnA, itemA, "completed", 3), 3);
    await harness.service.observe(turnCompleted(targetA, turnA, "completed", 4), 3);
    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "completed", turn_id: turnA });
  });

  it("allows explicit retry after known not-sent or remote-rejected failure only", async () => {
    for (const failure of [
      new HostDeckCodexAdapterError("transport_send_failed", "not sent", {
        outcome: "not_sent",
        retry_safe: true
      }),
      new HostDeckCodexAdapterError("remote_error", "compact rejected", {
        outcome: "remote_rejected",
        retry_safe: true,
        rpc_code: -32_600
      })
    ]) {
      const harness = createHarness();
      harness.states.put(selectedState(targetA));
      harness.compact.error = failure;
      await expect(harness.service.compact(compactIntent(targetA, "op_compact_control_known_0001"))).rejects.toBeInstanceOf(
        HostDeckCodexCompactControlError
      );
      expect(await harness.service.snapshot(targetA)).toBeNull();
      harness.compact.error = null;
      await expect(
        harness.service.compact(compactIntent(targetA, "op_compact_control_known_retry_0001"))
      ).resolves.toMatchObject({ state: "accepted" });
      expect(harness.compact.calls).toHaveLength(2);
    }
  });

  it("turns post-send target or generation drift into an incomplete unknown outcome", async () => {
    const archived = createHarness();
    archived.states.put(selectedState(targetA));
    archived.compact.onCall = () => archived.states.put(selectedState(targetA, { archived: true }));
    await expectCompactError(
      archived.service.compact(compactIntent(targetA, "op_compact_control_archive_race_0001")),
      "unknown_outcome"
    );
    expect(await archived.service.snapshot(targetA)).toMatchObject({
      state: "incomplete",
      error: { code: "unknown_error", retryable: false }
    });
    expect(archived.compact.calls).toHaveLength(1);

    const generation = createHarness();
    generation.states.put(selectedState(targetA));
    generation.compact.onCall = () => {
      generation.compact.currentGeneration = 4;
    };
    await expectCompactError(
      generation.service.compact(compactIntent(targetA, "op_compact_control_generation_race_0001")),
      "unknown_outcome"
    );
    expect(await generation.service.snapshot(targetA)).toMatchObject({ state: "incomplete", turn_id: null });
    expect(generation.compact.calls).toHaveLength(1);
  });

  it("rejects invalid confirmation, target state, runtime, and signal before wire", async () => {
    const cases: Array<{
      readonly state: SelectedSessionState | null;
      readonly target: TestTarget;
      readonly expected: CodexCompactControlErrorCode;
    }> = [
      { state: null, target: targetA, expected: "target_not_found" },
      { state: selectedState(targetA), target: { ...targetA, codex_thread_id: targetB.codex_thread_id }, expected: "target_mismatch" },
      { state: selectedState(targetA, { archived: true }), target: targetA, expected: "target_not_writable" },
      { state: selectedState(targetA, { stale: true }), target: targetA, expected: "target_not_writable" },
      { state: selectedState(targetA, { recovery: true }), target: targetA, expected: "target_stale" },
      { state: selectedState(targetA, { turnState: "in_progress" }), target: targetA, expected: "operation_conflict" },
      { state: selectedState(targetA, { runtimeVersion: "0.143.0" }), target: targetA, expected: "target_stale" }
    ];

    for (const testCase of cases) {
      const harness = createHarness();
      if (testCase.state !== null) harness.states.put(testCase.state);
      await expectCompactError(
        harness.service.compact(compactIntent(testCase.target, `op_compact_control_${testCase.expected}_0001`)),
        testCase.expected
      );
      expect(harness.compact.calls).toHaveLength(0);
    }

    const malformed = createHarness();
    malformed.states.put(selectedState(targetA));
    await expectCompactError(
      malformed.service.compact({ ...compactIntent(targetA, "op_compact_control_confirm_0001"), confirm: false }),
      "invalid_request"
    );
    await expectCompactError(
      malformed.service.compact(compactIntent(targetA, "op_compact_control_signal_0001"), "bad" as never),
      "invalid_request"
    );
    expect(malformed.compact.calls).toHaveLength(0);
  });

  it("marks generation loss and archive as incomplete without accepting stale callbacks", async () => {
    const generation = await acceptedHarness(targetA);
    generation.compact.currentGeneration = 4;
    await expectCompactError(generation.service.observe(turnStarted(targetA, turnA, 1), 3), "runtime_unavailable");
    expect(generation.service.connection_generation).toBe(4);
    expect(await generation.service.snapshot(targetA)).toMatchObject({
      state: "incomplete",
      error: { code: "runtime_unavailable", retryable: false }
    });

    await expect(
      generation.service.compact(compactIntent(targetA, "op_compact_control_new_generation_0001"))
    ).resolves.toMatchObject({ state: "accepted" });
    expect(generation.compact.calls).toHaveLength(2);

    const archived = await acceptedHarness(targetA);
    await archived.service.observe(threadArchived(targetA, 1), 3);
    expect(await archived.service.snapshot(targetA)).toMatchObject({
      state: "incomplete",
      error: { code: "session_not_writable", retryable: false }
    });
  });

  it("fails closed on missing, duplicate, backward, or contradictory lifecycle identity", async () => {
    const missingTurn = await acceptedHarness(targetA);
    await expectCompactError(
      missingTurn.service.observe(compactionItem(targetA, turnA, itemA, "started", 1), 3),
      "observation_conflict"
    );
    expect(await missingTurn.service.snapshot(targetA)).toMatchObject({ state: "incomplete", turn_id: null });

    const duplicate = await acceptedHarness(targetA);
    const started = turnStarted(targetA, turnA, 2);
    await duplicate.service.observe(started, 3);
    await expectCompactError(duplicate.service.observe(started, 3), "observation_conflict");

    const wrongItem = await acceptedHarness(targetA);
    await wrongItem.service.observe(turnStarted(targetA, turnA, 1), 3);
    const ignored = await wrongItem.service.observe(otherItem(targetA, turnA, 2), 3);
    expect(ignored).toBe(false);
    expect(await wrongItem.service.snapshot(targetA)).toMatchObject({ state: "accepted", turn_id: null });

    const deprecated = await acceptedHarness(targetA);
    expect(await deprecated.service.observe({ method: "thread/compacted" } as never, 3)).toBe(false);
    expect(await deprecated.service.snapshot(targetA)).toMatchObject({ state: "accepted" });
  });

  it("isolates two threads and enforces bounded active capacity without eviction", async () => {
    const harness = createHarness({ max_tracked_operations: 2 });
    harness.states.put(selectedState(targetA));
    harness.states.put(selectedState(targetB));
    await harness.service.compact(compactIntent(targetA, "op_compact_control_isolate_a_0001"));
    await harness.service.compact(compactIntent(targetB, "op_compact_control_isolate_b_0001"));
    await harness.service.observe(turnStarted(targetA, turnA, 1), 3);
    await harness.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3);

    expect(await harness.service.snapshot(targetA)).toMatchObject({ state: "running", turn_id: turnA });
    expect(await harness.service.snapshot(targetB)).toMatchObject({ state: "accepted", turn_id: null });
    expect(harness.service.tracked_count).toBe(2);

    const bounded = createHarness({ max_tracked_operations: 1 });
    bounded.states.put(selectedState(targetA));
    bounded.states.put(selectedState(targetB));
    await bounded.service.compact(compactIntent(targetA, "op_compact_control_capacity_a_0001"));
    await expectCompactError(
      bounded.service.compact(compactIntent(targetB, "op_compact_control_capacity_b_0001")),
      "service_overloaded"
    );
    expect(bounded.compact.calls).toHaveLength(1);

    await bounded.service.observe(turnStarted(targetA, turnA, 1), 3);
    await bounded.service.observe(compactionItem(targetA, turnA, itemA, "started", 2), 3);
    await bounded.service.observe(compactionItem(targetA, turnA, itemA, "completed", 3), 3);
    await bounded.service.observe(turnCompleted(targetA, turnA, "completed", 4), 3);
    await expect(
      bounded.service.compact(compactIntent(targetB, "op_compact_control_capacity_b_retry_0001"))
    ).resolves.toMatchObject({ state: "accepted" });
    expect(bounded.compact.calls).toHaveLength(2);
  });

  it("validates exact options, selected-state failures, and unsupported capability", async () => {
    const harness = createHarness();
    expect(() => createHarness({ max_tracked_operations: 0 })).toThrow(TypeError);
    expect(() => createCodexCompactControlService(null as never)).toThrow(TypeError);
    expect(() =>
      createCodexCompactControlService({ compact: harness.compact, states: harness.states, extra: true } as never)
    ).toThrow(TypeError);

    const brokenStates: CodexCompactControlStatePort = {
      get() {
        throw new Error("database unavailable");
      },
      getByThreadId() {
        throw new Error("database unavailable");
      }
    };
    await expectCompactError(
      createCodexCompactControlService({ compact: harness.compact, states: brokenStates }).compact(
        compactIntent(targetA, "op_compact_control_storage_0001"),
        testOperationDeadline()
      ),
      "state_unavailable"
    );

    const unsupported = createHarness();
    unsupported.states.put(selectedState(targetA));
    unsupported.compact.getterError = new HostDeckCodexAdapterError("unsupported_method", "compact unavailable", {
      outcome: "not_sent",
      retry_safe: false
    });
    await expectCompactError(
      unsupported.service.compact(compactIntent(targetA, "op_compact_control_unsupported_0001")),
      "capability_unsupported"
    );
    expect(unsupported.compact.calls).toHaveLength(0);
  });

  it("rejects malformed, accessor-backed, contradictory, and misplaced selected state without wire access", async () => {
    const malformed = createHarness();
    malformed.states.bySession.set(targetA.session_id, {
      ...selectedState(targetA),
      extra: true
    } as never);
    await expectCompactError(
      malformed.service.compact(compactIntent(targetA, "op_compact_control_malformed_state_0001")),
      "target_mismatch"
    );
    expect(malformed.compact.calls).toEqual([]);

    const contradictory = createHarness();
    const state = selectedState(targetA);
    contradictory.states.bySession.set(targetA.session_id, {
      mapping: state.mapping,
      projection: {
        ...state.projection,
        session: { ...state.projection.session, cwd: "/tmp/contradictory-compact-cwd" }
      }
    } as SelectedSessionState);
    await expectCompactError(
      contradictory.service.compact(compactIntent(targetA, "op_compact_control_contradictory_state_0001")),
      "target_mismatch"
    );
    expect(contradictory.compact.calls).toEqual([]);

    let accessorCalls = 0;
    const accessorState = Object.defineProperty({}, "mapping", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private-compact-state-accessor");
      }
    });
    Object.defineProperty(accessorState, "projection", {
      enumerable: true,
      value: state.projection
    });
    const accessor = createHarness();
    accessor.states.bySession.set(targetA.session_id, accessorState as SelectedSessionState);
    await expectCompactError(
      accessor.service.compact(compactIntent(targetA, "op_compact_control_accessor_state_0001")),
      "target_mismatch"
    );
    expect(accessorCalls).toBe(0);
    expect(accessor.compact.calls).toEqual([]);

    const misplaced = await acceptedHarness(targetA);
    misplaced.states.byThread.set(targetA.codex_thread_id, selectedState(targetB));
    await expectCompactError(misplaced.service.observe(turnStarted(targetA, turnA, 1), 3), "target_mismatch");
    expect(await misplaced.service.snapshot(targetA)).toMatchObject({ state: "accepted" });
  });
});

class FakeCompactClient implements CodexCompactClient {
  currentGeneration = 3;
  currentVersion = "0.144.0";
  readonly calls: CodexCompactInput[] = [];
  error: Error | null = null;
  getterError: Error | null = null;
  gate: Promise<void> | null = null;
  onCall: (() => void) | null = null;

  get runtime_version(): string {
    if (this.getterError !== null) throw this.getterError;
    return this.currentVersion;
  }

  get connection_generation(): number {
    if (this.getterError !== null) throw this.getterError;
    return this.currentGeneration;
  }

  async compactThread(input: CodexCompactInput): Promise<CodexCompactAccepted> {
    this.calls.push({ ...input });
    if (this.gate !== null) await this.gate;
    this.onCall?.();
    if (this.error !== null) throw this.error;
    return {
      runtime_version: this.currentVersion,
      connection_generation: this.currentGeneration,
      thread_id: input.thread_id as CodexCompactAccepted["thread_id"],
      state: "accepted",
      accepted_at: acceptedAt as CodexCompactAccepted["accepted_at"]
    };
  }
}

class MemoryCompactStates implements CodexCompactControlStatePort {
  readonly bySession = new Map<string, SelectedSessionState>();
  readonly byThread = new Map<string, SelectedSessionState>();

  put(state: SelectedSessionState): void {
    this.bySession.set(state.mapping.id, state);
    this.byThread.set(state.mapping.codex_thread_id, state);
  }

  get = (sessionId: string) => this.bySession.get(sessionId) ?? null;
  getByThreadId = (threadId: string) => this.byThread.get(threadId) ?? null;
}

function createHarness(options: { readonly max_tracked_operations?: number } = {}) {
  const compact = new FakeCompactClient();
  const states = new MemoryCompactStates();
  const service = withTestOperationDeadlines(createCodexCompactControlService({
    compact,
    states,
    now: () => requestedAt,
    ...options
  }), ["compact"]);
  return { compact, states, service };
}

async function acceptedHarness(target: TestTarget) {
  const harness = createHarness();
  harness.states.put(selectedState(target));
  await harness.service.compact(compactIntent(target, "op_compact_control_harness_0001"));
  return harness;
}

function compactIntent(target: TestTarget, operationId: string) {
  return { operation_id: operationId, target, kind: "compact", confirm: true } as const;
}

function selectedState(
  target: TestTarget,
  options: {
    readonly archived?: boolean;
    readonly recovery?: boolean;
    readonly runtimeVersion?: string;
    readonly stale?: boolean;
    readonly turnState?: "idle" | "in_progress" | "completed" | "interrupted" | "failed";
  } = {}
): SelectedSessionState {
  const runtimeVersion = options.runtimeVersion ?? "0.144.0";
  const archivedAt = options.archived ? requestedAt : null;
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: target.session_id,
      name: target.session_id.replace(/^sess_/u, ""),
      codex_thread_id: target.codex_thread_id,
      cwd: `/tmp/${target.session_id}`,
      runtime_source: "codex_app_server",
      runtime_version: runtimeVersion,
      disposition: options.recovery ? "recovery_required" : "selected",
      created_at: requestedAt,
      updated_at: requestedAt,
      archived_at: archivedAt
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: target.session_id,
        name: target.session_id.replace(/^sess_/u, ""),
        codex_thread_id: target.codex_thread_id,
        cwd: `/tmp/${target.session_id}`,
        runtime_source: "codex_app_server",
        runtime_version: runtimeVersion,
        created_at: requestedAt,
        archived_at: archivedAt,
        session_state: options.archived ? "archived" : "active",
        turn_state: options.turnState ?? "idle",
        attention: "none",
        freshness: options.stale ? "stale" : "current",
        freshness_reason: options.stale ? "Runtime reconnect is required." : null,
        updated_at: requestedAt,
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
    })
  };
}

function turnStarted(target: TestTarget, turnId: string, sequence: number): NormalizedCodexEvent {
  return {
    sequence,
    method: "turn/started",
    captured_at: eventTime(sequence),
    upstream_at: null,
    codex_event_id: `${turnId}:started`,
    scope: "thread",
    thread_id: target.codex_thread_id,
    turn_id: turnId,
    status: "in_progress"
  } as NormalizedCodexEvent;
}

function turnCompleted(
  target: TestTarget,
  turnId: string,
  status: "completed" | "failed" | "interrupted",
  sequence: number
): NormalizedCodexEvent {
  return {
    sequence,
    method: "turn/completed",
    captured_at: eventTime(sequence),
    upstream_at: null,
    codex_event_id: `${turnId}:${status}`,
    scope: "thread",
    thread_id: target.codex_thread_id,
    turn_id: turnId,
    status,
    error_message: status === "failed" ? "The compact turn failed." : null
  } as NormalizedCodexEvent;
}

function compactionItem(
  target: TestTarget,
  turnId: string,
  itemId: string,
  lifecycle: "started" | "completed",
  sequence: number
): NormalizedCodexEvent {
  return {
    sequence,
    method: lifecycle === "started" ? "item/started" : "item/completed",
    captured_at: eventTime(sequence),
    upstream_at: null,
    codex_event_id: `${itemId}:${lifecycle}`,
    scope: "thread",
    thread_id: target.codex_thread_id,
    turn_id: turnId,
    item: {
      id: itemId,
      category: "compaction",
      state: lifecycle,
      title: "Context compaction",
      text: null,
      content_state: "complete",
      content_notice: null
    }
  } as NormalizedCodexEvent;
}

function otherItem(target: TestTarget, turnId: string, sequence: number): NormalizedCodexEvent {
  return {
    ...compactionItem(target, turnId, "item-other", "started", sequence),
    item: {
      id: "item-other",
      category: "reasoning",
      state: "started",
      title: "Reasoning",
      text: null,
      content_state: "redacted",
      content_notice: "Content omitted."
    }
  } as NormalizedCodexEvent;
}

function threadArchived(target: TestTarget, sequence: number): NormalizedCodexEvent {
  return {
    sequence,
    method: "thread/archived",
    captured_at: eventTime(sequence),
    upstream_at: null,
    codex_event_id: `${target.codex_thread_id}:archived`,
    scope: "thread",
    thread_id: target.codex_thread_id
  } as NormalizedCodexEvent;
}

function eventTime(sequence: number): string {
  return new Date(Date.parse(acceptedAt) + sequence * 1_000).toISOString();
}

async function expectCompactError(
  promise: Promise<unknown>,
  code: CodexCompactControlErrorCode
): Promise<HostDeckCodexCompactControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexCompactControlError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexCompactControlError;
  }
  throw new Error(`Expected compact control error ${code}.`);
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
  throw new Error("Timed out waiting for compact test state.");
}
