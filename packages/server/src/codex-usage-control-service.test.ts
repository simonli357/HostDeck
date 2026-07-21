import {
  type CodexAccountUsageRead,
  type CodexConnectionNotification,
  type CodexUsageClient,
  createCodexEventNormalizer,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  usageAccountSnapshotSchema
} from "@hostdeck/contracts";
import type { OperationDeadline } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexUsageControlErrorCode,
  type CodexUsageControlServiceOptions,
  type CodexUsageControlStatePort,
  createCodexUsageControlService as createRawCodexUsageControlService,
  HostDeckCodexUsageControlError
} from "./codex-usage-control-service.js";
import { withTestOperationDeadlines } from "./test-operation-deadline.js";

const createCodexUsageControlService = (options: CodexUsageControlServiceOptions) =>
  withTestOperationDeadlines(createRawCodexUsageControlService(options), ["read"]);

const sessionA = "sess_usage_control_a";
const sessionB = "sess_usage_control_b";
const threadA = "thread-usage-control-a";
const threadB = "thread-usage-control-b";
const turnA = "turn-usage-control-a";
const turnB = "turn-usage-control-b";
const createdAt = "2026-07-11T17:00:00.000Z";
const measuredAt = "2026-07-11T17:05:00.000Z";

describe("Codex usage control service", () => {
  it("reads one exact current target with explicit empty observations and no state mutation", async () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage });

    const snapshot = await service.read(usageIntent(sessionA, threadA));
    expect(snapshot).toEqual({
      target: { type: "managed_session", session_id: sessionA, codex_thread_id: threadA },
      runtime_version: "0.144.0",
      connection_generation: 3,
      measured_at: measuredAt,
      account: accountSnapshot(),
      thread: { state: "not_observed", scope: "thread" },
      rate_limits: { state: "not_observed", scope: "runtime" }
    });
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.account)).toBe(true);
    expect(await service.read(usageIntent(sessionA, threadA))).toEqual(snapshot);
    expect(usage.reads).toBe(2);
    expect(states.getCalls).toBe(4);
    expect(service.tracked_thread_count).toBe(0);
  });

  it("combines same-generation thread token/context and runtime rate observations", async () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage });
    const observations = normalizedUsageSequence();

    expect(service.observe(observations.tokenA, 3)).toBe(true);
    expect(service.observe(observations.rate, 3)).toBe(true);
    const snapshot = await service.read(usageIntent(sessionA, threadA));

    expect(snapshot.thread).toMatchObject({
      state: "observed",
      scope: "thread",
      turn_id: turnA,
      total: { total_tokens: 120 },
      last: { total_tokens: 20 },
      model_context_window: 200_000
    });
    expect(snapshot.rate_limits).toMatchObject({
      state: "observed",
      scope: "runtime",
      primary: { used_percent: 25, window_duration_minutes: 300 },
      secondary: null,
      reached_type: null
    });
    expect(service.connection_generation).toBe(3);
    expect(service.tracked_thread_count).toBe(1);
  });

  it("isolates two threads and evicts only the archived thread", async () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    states.put(stateCandidate(sessionB, threadB));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage });
    const observations = normalizedUsageSequence();
    service.observe(observations.tokenA, 3);
    service.observe(observations.tokenB, 3);

    const first = await service.read(usageIntent(sessionA, threadA));
    const second = await service.read(usageIntent(sessionB, threadB));
    expect(first.thread).toMatchObject({ state: "observed", turn_id: turnA, total: { total_tokens: 120 } });
    expect(second.thread).toMatchObject({ state: "observed", turn_id: turnB, total: { total_tokens: 80 } });
    expect(service.tracked_thread_count).toBe(2);

    expect(service.observe(observations.archivedA, 3)).toBe(true);
    expect(service.tracked_thread_count).toBe(1);
    const afterArchive = await service.read(usageIntent(sessionB, threadB));
    expect(afterArchive.thread).toMatchObject({ state: "observed", turn_id: turnB });
  });

  it("clears all ephemeral observations on generation change and rejects stale callbacks", async () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage });
    const observations = normalizedUsageSequence();
    service.observe(observations.tokenA, 3);
    service.observe(observations.rate, 3);

    usage.currentGeneration = 4;
    expectUsageError(() => service.observe(observations.tokenA, 3), "runtime_unavailable");
    expect(service.connection_generation).toBe(4);
    expect(service.tracked_thread_count).toBe(0);
    expect((await service.read(usageIntent(sessionA, threadA))).thread).toEqual({
      state: "not_observed",
      scope: "thread"
    });
  });

  it("rejects duplicate/backward observations and enforces capacity without eviction", () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    states.put(stateCandidate(sessionB, threadB));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage, max_tracked_threads: 1 });
    const observations = normalizedUsageSequence();
    service.observe(observations.tokenA, 3);

    expectUsageError(() => service.observe(observations.tokenA, 3), "observation_conflict");
    expectUsageError(
      () =>
        service.observe(
          {
            ...observations.tokenA,
            sequence: observations.tokenA.sequence + 1,
            total: tokenUsage(119)
          },
          3
        ),
      "observation_conflict"
    );
    expectUsageError(() => service.observe(observations.tokenB, 3), "service_overloaded");
    expect(service.tracked_thread_count).toBe(1);
  });

  it("accepts strictly newer cumulative usage and rejects repeated runtime rate observations", async () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage });
    const observations = normalizedUsageSequence();

    service.observe(observations.tokenA, 3);
    service.observe(observations.tokenA2, 3);
    service.observe(observations.rate, 3);
    expectUsageError(() => service.observe(observations.rate, 3), "observation_conflict");
    expect((await service.read(usageIntent(sessionA, threadA))).thread).toMatchObject({
      state: "observed",
      total: { total_tokens: 140 }
    });
  });

  it("accepts one exact compaction-scoped usage reset and restores monotonic enforcement", async () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage });
    const events = normalizedCompactionUsageSequence();

    expect(service.observe(events.baseline, 3)).toBe(true);
    expect(service.observe(events.itemStarted, 3)).toBe(true);
    expect(service.observe(events.reset, 3)).toBe(true);
    expect((await service.read(usageIntent(sessionA, threadA))).thread).toMatchObject({
      state: "observed",
      turn_id: events.reset.turn_id,
      total: { total_tokens: 40 },
      last: { total_tokens: 80 }
    });

    expectUsageError(
      () =>
        service.observe(
          {
            ...events.reset,
            sequence: events.reset.sequence + 1,
            captured_at: new Date(Date.parse(events.reset.captured_at) + 1).toISOString() as typeof events.reset.captured_at,
            total: tokenUsage(39),
            last: tokenUsage(79)
          },
          3
        ),
      "observation_conflict"
    );

    expect(service.observe(events.itemCompleted, 3)).toBe(true);
    expect(service.observe(events.turnCompleted, 3)).toBe(true);
    expectUsageError(
      () =>
        service.observe(
          {
            ...events.reset,
            sequence: events.turnCompleted.sequence + 1,
            captured_at: new Date(Date.parse(events.turnCompleted.captured_at) + 1).toISOString() as typeof events.reset.captured_at,
            total: tokenUsage(38),
            last: tokenUsage(10)
          },
          3
        ),
      "observation_conflict"
    );
  });

  it("bounds compaction reset markers and clears them on generation change", () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    states.put(stateCandidate(sessionB, threadB));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage, max_tracked_threads: 1 });
    const events = normalizedCompactionUsageSequence();

    expect(service.observe(events.itemStarted, 3)).toBe(true);
    expect(service.tracked_thread_count).toBe(1);
    expectUsageError(
      () =>
        service.observe(
          {
            ...events.itemStarted,
            sequence: events.itemStarted.sequence + 1,
            thread_id: threadB as typeof events.itemStarted.thread_id,
            turn_id: turnB as typeof events.itemStarted.turn_id,
            item: {
              ...events.itemStarted.item,
              id: "item-compaction-usage-b" as typeof events.itemStarted.item.id
            }
          },
          3
        ),
      "service_overloaded"
    );

    usage.currentGeneration = 4;
    expectUsageError(() => service.observe(events.itemCompleted, 3), "runtime_unavailable");
    expect(service.tracked_thread_count).toBe(0);
  });

  it("rejects invalid or unreadable targets before the runtime call", async () => {
    const cases: Array<{ readonly state: SelectedSessionState | null; readonly targetThread: string; readonly code: CodexUsageControlErrorCode }> = [
      { state: null, targetThread: threadA, code: "target_not_found" },
      { state: stateCandidate(sessionA, threadA), targetThread: threadB, code: "target_mismatch" },
      { state: stateCandidate(sessionA, threadA, { recovery: true }), targetThread: threadA, code: "target_stale" },
      { state: stateCandidate(sessionA, threadA, { archived: true }), targetThread: threadA, code: "target_not_readable" },
      { state: stateCandidate(sessionA, threadA, { stale: true }), targetThread: threadA, code: "target_stale" }
    ];

    for (const testCase of cases) {
      const states = new MemoryUsageStates();
      if (testCase.state !== null) states.put(testCase.state);
      const usage = new FakeUsageClient();
      const service = createCodexUsageControlService({ states, usage });
      await expectUsageRejection(service.read(usageIntent(sessionA, testCase.targetThread)), testCase.code);
      expect(usage.reads).toBe(0);
    }

    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const usage = new FakeUsageClient();
    usage.onRead = () => states.put(stateCandidate(sessionA, threadA, { archived: true }));
    const service = createCodexUsageControlService({ states, usage });
    await expectUsageRejection(service.read(usageIntent(sessionA, threadA)), "target_not_readable");
    expect(usage.reads).toBe(1);

    const versionStates = new MemoryUsageStates();
    versionStates.put(stateCandidate(sessionA, threadA, { runtimeVersion: "0.143.0" }));
    const versionUsage = new FakeUsageClient();
    await expectUsageRejection(
      createCodexUsageControlService({ states: versionStates, usage: versionUsage }).read(
        usageIntent(sessionA, threadA)
      ),
      "target_stale"
    );
    expect(versionUsage.reads).toBe(1);
  });

  it("maps unsupported, malformed, overload, and unavailable adapter failures", async () => {
    const mappings = [
      ["unsupported_method", "capability_unsupported"],
      ["invalid_protocol_message", "runtime_protocol_error"],
      ["broker_overloaded", "service_overloaded"],
      ["request_timeout", "operation_timeout"]
    ] as const;
    for (const [adapterCode, serviceCode] of mappings) {
      const states = new MemoryUsageStates();
      states.put(stateCandidate(sessionA, threadA));
      const usage = new FakeUsageClient();
      usage.error = new HostDeckCodexAdapterError(adapterCode, "usage read failed", {
        outcome: "not_applicable",
        retry_safe: adapterCode === "request_timeout"
      });
      await expectUsageRejection(
        createCodexUsageControlService({ states, usage }).read(usageIntent(sessionA, threadA)),
        serviceCode
      );
    }
  });

  it("maps selected-state failure and invalid account generation without returning partial data", async () => {
    const usage = new FakeUsageClient();
    const brokenStates: CodexUsageControlStatePort = {
      get() {
        throw new Error("database unavailable");
      },
      getByThreadId() {
        throw new Error("database unavailable");
      }
    };
    await expectUsageRejection(
      createCodexUsageControlService({ states: brokenStates, usage }).read(usageIntent(sessionA, threadA)),
      "state_unavailable"
    );
    expect(usage.reads).toBe(0);

    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const invalidGeneration = new FakeUsageClient();
    invalidGeneration.currentGeneration = 0;
    await expectUsageRejection(
      createCodexUsageControlService({ states, usage: invalidGeneration }).read(usageIntent(sessionA, threadA)),
      "runtime_protocol_error"
    );
  });

  it("rejects malformed intent/options and ignores unrelated normalized events", async () => {
    const states = new MemoryUsageStates();
    states.put(stateCandidate(sessionA, threadA));
    const usage = new FakeUsageClient();
    const service = createCodexUsageControlService({ states, usage });

    await expectUsageRejection(service.read({ ...usageIntent(sessionA, threadA), extra: true }), "invalid_request");
    expect(usage.reads).toBe(0);
    expect(service.observe(normalizedUsageSequence().turnStartedA, 3)).toBe(false);
    expect(() => createCodexUsageControlService(null as never)).toThrow(TypeError);
    expect(() => createCodexUsageControlService({ states, usage, max_tracked_threads: 0 })).toThrow(TypeError);
    expect(() => createCodexUsageControlService({ states, usage, extra: true } as never)).toThrow(TypeError);
  });
});

class FakeUsageClient implements CodexUsageClient {
  currentGeneration = 3;
  reads = 0;
  error: Error | null = null;
  onRead: (() => void) | null = null;

  get runtime_version(): string {
    return "0.144.0";
  }

  get connection_generation(): number {
    return this.currentGeneration;
  }

  async readAccount(_deadline?: OperationDeadline): Promise<CodexAccountUsageRead> {
    this.reads += 1;
    this.onRead?.();
    if (this.error !== null) throw this.error;
    return {
      runtime_version: "0.144.0",
      connection_generation: this.currentGeneration,
      observed_at: measuredAt as CodexAccountUsageRead["observed_at"],
      account: accountSnapshot()
    };
  }
}

class MemoryUsageStates implements CodexUsageControlStatePort {
  readonly bySession = new Map<string, SelectedSessionState>();
  readonly byThread = new Map<string, SelectedSessionState>();
  getCalls = 0;

  put(state: SelectedSessionState): void {
    this.bySession.set(state.mapping.id, state);
    this.byThread.set(state.mapping.codex_thread_id, state);
  }

  get = (sessionId: string) => {
    this.getCalls += 1;
    return this.bySession.get(sessionId) ?? null;
  };

  getByThreadId = (threadId: string) => this.byThread.get(threadId) ?? null;
}

function accountSnapshot() {
  return usageAccountSnapshotSchema.parse({
    scope: "account",
    summary: {
      lifetime_tokens: 1_000,
      peak_daily_tokens: 100,
      longest_running_turn_seconds: 30,
      current_streak_days: 2,
      longest_streak_days: 4
    },
    daily_buckets: [
      { start_date: "2026-07-09", tokens: 50 },
      { start_date: "2026-07-10", tokens: 100 }
    ]
  });
}

function usageIntent(sessionId: string, threadId: string) {
  return {
    kind: "usage",
    operation_id: `op_usage_${sessionId}`,
    target: { type: "managed_session", session_id: sessionId, codex_thread_id: threadId }
  };
}

function normalizedUsageSequence() {
  let milliseconds = Date.parse("2026-07-11T17:00:00.000Z");
  const normalizer = createCodexEventNormalizer({
    now: () => {
      milliseconds += 1_000;
      return new Date(milliseconds).toISOString();
    }
  });
  const turnStartedA = normalize(
    normalizer.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn(turnA) }))
  );
  const tokenA = normalize(
    normalizer.normalize(
      selected("thread/tokenUsage/updated", {
        threadId: threadA,
        turnId: turnA,
        tokenUsage: rawTokenUsage(120, 20)
      })
    )
  );
  const tokenA2 = normalize(
    normalizer.normalize(
      selected("thread/tokenUsage/updated", {
        threadId: threadA,
        turnId: turnA,
        tokenUsage: rawTokenUsage(140, 20)
      })
    )
  );
  normalize(normalizer.normalize(selected("turn/started", { threadId: threadB, turn: rawTurn(turnB) })));
  const tokenB = normalize(
    normalizer.normalize(
      selected("thread/tokenUsage/updated", {
        threadId: threadB,
        turnId: turnB,
        tokenUsage: rawTokenUsage(80, 10)
      })
    )
  );
  const rate = normalize(
    normalizer.normalize(selected("account/rateLimits/updated", { rateLimits: rawRateLimits() }))
  );
  normalize(
    normalizer.normalize(selected("turn/completed", { threadId: threadA, turn: rawTurn(turnA, "completed") }))
  );
  const archivedA = normalize(normalizer.normalize(selected("thread/archived", { threadId: threadA })));
  return {
    turnStartedA,
    tokenA: requireMethod(tokenA, "thread/tokenUsage/updated"),
    tokenA2: requireMethod(tokenA2, "thread/tokenUsage/updated"),
    tokenB: requireMethod(tokenB, "thread/tokenUsage/updated"),
    rate: requireMethod(rate, "account/rateLimits/updated"),
    archivedA: requireMethod(archivedA, "thread/archived")
  };
}

function normalizedCompactionUsageSequence() {
  let milliseconds = Date.parse("2026-07-11T17:10:00.000Z");
  const normalizer = createCodexEventNormalizer({
    now: () => {
      milliseconds += 1_000;
      return new Date(milliseconds).toISOString();
    }
  });
  const baselineTurn = "turn-usage-before-compact-a";
  const compactTurn = "turn-usage-compact-a";
  const compactItem = { type: "contextCompaction", id: "item-compaction-usage-a" };
  normalize(normalizer.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn(baselineTurn) })));
  const baseline = requireMethod(
    normalize(
      normalizer.normalize(
        selected("thread/tokenUsage/updated", {
          threadId: threadA,
          turnId: baselineTurn,
          tokenUsage: rawTokenUsage(120, 20)
        })
      )
    ),
    "thread/tokenUsage/updated"
  );
  normalize(
    normalizer.normalize(
      selected("turn/completed", { threadId: threadA, turn: rawTurn(baselineTurn, "completed") })
    )
  );
  normalize(normalizer.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn(compactTurn) })));
  const itemStarted = requireItemMethod(
    normalize(
      normalizer.normalize(
        selected("item/started", {
          threadId: threadA,
          turnId: compactTurn,
          item: compactItem,
          startedAtMs: 1_752_170_402_000
        })
      )
    ),
    "item/started"
  );
  const reset = requireMethod(
    normalize(
      normalizer.normalize(
        selected("thread/tokenUsage/updated", {
          threadId: threadA,
          turnId: compactTurn,
          tokenUsage: rawTokenUsage(40, 80)
        })
      )
    ),
    "thread/tokenUsage/updated"
  );
  const itemCompleted = requireItemMethod(
    normalize(
      normalizer.normalize(
        selected("item/completed", {
          threadId: threadA,
          turnId: compactTurn,
          item: compactItem,
          completedAtMs: 1_752_170_403_000
        })
      )
    ),
    "item/completed"
  );
  const turnCompleted = requireMethod(
    normalize(
      normalizer.normalize(
        selected("turn/completed", { threadId: threadA, turn: rawTurn(compactTurn, "completed") })
      )
    ),
    "turn/completed"
  );
  return { baseline, itemStarted, reset, itemCompleted, turnCompleted };
}

function selected(method: string, params: unknown): CodexConnectionNotification {
  return { kind: "notification", method, params, classification: "selected" };
}

function normalize(result: ReturnType<ReturnType<typeof createCodexEventNormalizer>["normalize"]>): NormalizedCodexEvent {
  if (result.kind !== "event") throw new TypeError(`Expected normalized event, received ${result.kind}.`);
  return result.event;
}

function requireMethod<Method extends NormalizedCodexEvent["method"]>(event: NormalizedCodexEvent, method: Method) {
  if (event.method !== method) throw new TypeError(`Expected ${method}, received ${event.method}.`);
  return event as Extract<NormalizedCodexEvent, { readonly method: Method }>;
}

function requireItemMethod(
  event: NormalizedCodexEvent,
  method: "item/started" | "item/completed"
): Extract<NormalizedCodexEvent, { readonly method: "item/started" | "item/completed" }> {
  if (event.method !== method) throw new TypeError(`Expected ${method}, received ${event.method}.`);
  return event as Extract<NormalizedCodexEvent, { readonly method: "item/started" | "item/completed" }>;
}

function rawTurn(turnId: string, status: "completed" | "inProgress" = "inProgress") {
  return {
    id: turnId,
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 1_752_170_402,
    completedAt: status === "completed" ? 1_752_170_403 : null,
    durationMs: status === "completed" ? 1_000 : null
  };
}

function rawTokenUsage(total: number, last: number) {
  return {
    total: rawTokenBreakdown(total),
    last: rawTokenBreakdown(last),
    modelContextWindow: 200_000
  };
}

function rawTokenBreakdown(total: number) {
  return {
    totalTokens: total,
    inputTokens: Math.floor(total / 2),
    cachedInputTokens: 0,
    outputTokens: total - Math.floor(total / 2),
    reasoningOutputTokens: 0
  };
}

function tokenUsage(total: number) {
  return {
    total_tokens: total,
    input_tokens: Math.floor(total / 2),
    cached_input_tokens: 0,
    output_tokens: total - Math.floor(total / 2),
    reasoning_output_tokens: 0
  };
}

function rawRateLimits() {
  return {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_752_170_800 },
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null
  };
}

function stateCandidate(
  sessionId: string,
  threadId: string,
  options: {
    readonly archived?: boolean;
    readonly recovery?: boolean;
    readonly runtimeVersion?: string;
    readonly stale?: boolean;
  } = {}
): SelectedSessionState {
  const archivedAt = options.archived ? createdAt : null;
  const runtimeVersion = options.runtimeVersion ?? "0.144.0";
  const name = sessionId.replace(/^sess_/u, "");
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: sessionId,
      name,
      codex_thread_id: threadId,
      cwd: `/tmp/${sessionId}`,
      runtime_source: "codex_app_server",
      runtime_version: runtimeVersion,
      disposition: options.recovery ? "recovery_required" : "selected",
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: archivedAt
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: sessionId,
        name,
        codex_thread_id: threadId,
        cwd: `/tmp/${sessionId}`,
        runtime_source: "codex_app_server",
        runtime_version: runtimeVersion,
        created_at: createdAt,
        archived_at: archivedAt,
        session_state: options.archived ? "archived" : "active",
        turn_state: "idle",
        attention: "none",
        freshness: options.stale ? "stale" : "current",
        freshness_reason: options.stale ? "Runtime reconnect is required." : null,
        updated_at: createdAt,
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

async function expectUsageRejection(
  promise: Promise<unknown>,
  code: CodexUsageControlErrorCode
): Promise<HostDeckCodexUsageControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexUsageControlError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexUsageControlError;
  }
  throw new Error(`Expected HostDeckCodexUsageControlError ${code}.`);
}

function expectUsageError(fn: () => unknown, code: CodexUsageControlErrorCode): HostDeckCodexUsageControlError {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckCodexUsageControlError);
  expect(caught).toMatchObject({ code });
  return caught as HostDeckCodexUsageControlError;
}
