import {
  defaultResourceBudget,
  resolveResourceBudget,
  selectedAuditActorSchema,
  selectedAuditTargetSchema
} from "@hostdeck/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createHostDeckHostHealthService,
  type HostDeckHostHealthService,
  hostDeckLocalHealthComponents
} from "./host-health.js";
import {
  assertHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  type HostDeckSelectedWriteAdmissionDecision,
  type HostDeckSelectedWriteAdmissionOwner,
  type HostDeckSelectedWriteAdmissionPolicy,
  type HostDeckSelectedWriteAdmissionReplay
} from "./selected-write-admission-policy.js";

interface Clock {
  value: number;
}

interface TestResult {
  readonly outcome: "succeeded";
  readonly response: Readonly<{
    readonly operation_id: string;
    readonly accepted: true;
  }>;
}

const cliActor = selectedAuditActorSchema.parse({
  type: "cli",
  device_id: null,
  permission: "local_admin",
  origin: null
});
const writerActor = dashboardActor("dev_admission_writer");
const secondWriterActor = dashboardActor("dev_admission_second");
const thirdWriterActor = dashboardActor("dev_admission_third");

describe("selected write admission policy", () => {
  it("requires exact branded construction, a resolved budget, and a valid monotonic clock", () => {
    const clock = { value: 10 };
    const policy = createPolicy(clock);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => assertHostDeckSelectedWriteAdmissionPolicy(policy)).not.toThrow();
    expect(() =>
      assertHostDeckSelectedWriteAdmissionPolicy(Object.freeze({ ...policy }))
    ).toThrow(TypeError);
    expect(Object.isFrozen(policy.snapshot())).toBe(true);

    const invalid: unknown[] = [
      null,
      {},
      { resourceBudget: defaultResourceBudget, now: () => 0, extra: true },
      { resourceBudget: {}, now: () => 0 },
      { resourceBudget: defaultResourceBudget, now: 0 },
      { resourceBudget: defaultResourceBudget, now: () => -1 },
      { resourceBudget: defaultResourceBudget, now: () => Number.NaN }
    ];
    const health = createHealth();
    invalid.push({
      resourceBudget: defaultResourceBudget,
      now: () => 0,
      health: Object.freeze({ ...health })
    });
    for (const candidate of invalid) {
      expect(() => createHostDeckSelectedWriteAdmissionPolicy(candidate as never)).toThrow(
        expect.objectContaining({ reason: "configuration_invalid" })
      );
    }

    let accessorCalls = 0;
    const accessor = Object.defineProperties(
      { resourceBudget: defaultResourceBudget },
      {
        now: {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return () => 0;
          }
        }
      }
    );
    expect(() => createHostDeckSelectedWriteAdmissionPolicy(accessor as never)).toThrow(
      expect.objectContaining({ reason: "configuration_invalid" })
    );
    expect(accessorCalls).toBe(0);
  });

  it("admits only healthy new owners and revalidates the same health generation before dispatch", async () => {
    const clock = { value: 0 };
    const health = createHealth();
    const policy = createHostDeckSelectedWriteAdmissionPolicy({
      resourceBudget: defaultResourceBudget,
      now: () => clock.value,
      health
    });
    const input = {
      operationId: "op_admission_health_001",
      actor: writerActor,
      intent: { value: 1 }
    };

    expect(() => begin(policy, input)).toThrow(
      expect.objectContaining({
        reason: "host_not_ready",
        api_code: "storage_error",
        retry_safe: true
      })
    );
    makeHealthReady(health);

    const claim = owner<unknown>(begin<unknown>(policy, input));
    claim.bindTarget(target("health_race"));
    health.updateLocal({
      component: "runtime",
      state: "degraded",
      reasons: ["runtime_disconnected"],
      source_generation: 2
    });
    expect(() => claim.assertReady()).toThrow(
      expect.objectContaining({
        reason: "host_state_changed",
        api_code: "runtime_unavailable",
        retry_safe: true
      })
    );
    const failed = Object.freeze({
      outcome: "failed" as const,
      error_code: "runtime_unavailable" as const
    });
    expect(claim.complete(failed)).toEqual(failed);

    const replay = replayDecision<unknown>(begin<unknown>(policy, input));
    await expect(replay.replay()).resolves.toEqual(failed);
    health.updateLocal({
      component: "runtime",
      state: "ready",
      reasons: [],
      source_generation: 3
    });
    const recovered = owner<unknown>(
      begin<unknown>(policy, {
        ...input,
        operationId: "op_admission_health_002"
      })
    );
    recovered.bindTarget(target("health_recovered"));
    expect(() => recovered.assertReady()).not.toThrow();
    recovered.complete(
      Object.freeze({ outcome: "succeeded", response: { accepted: true } })
    );

    expect(policy.snapshot()).toMatchObject({
      owner_claims: 2,
      readiness_rejections: 2,
      active_owners: 0
    });
  });

  it("closes empty admission idempotently and rejects post-drain work before reading it", async () => {
    const clock = { value: 0 };
    const invalidSignalPolicy = createPolicy(clock);
    await expect(
      invalidSignalPolicy.drain({} as AbortSignal)
    ).rejects.toMatchObject({ reason: "input_invalid", api_code: "validation_error" });
    expect(invalidSignalPolicy.snapshot().phase).toBe("open");

    const policy = createPolicy(clock);
    const first = policy.beginDrain();
    const repeated = policy.beginDrain();
    expect(first).toMatchObject({
      phase: "closed",
      active_owners: 0,
      active_drain_waiters: 0
    });
    expect(repeated).toEqual(first);
    await expect(policy.drain(new AbortController().signal)).resolves.toMatchObject({
      phase: "closed",
      active_owners: 0
    });

    let propertyReads = 0;
    const hostile = Object.defineProperty({}, "operation_id", {
      enumerable: true,
      get() {
        propertyReads += 1;
        return "op_admission_drained_hostile";
      }
    });
    expect(() => policy.begin(hostile as never)).toThrow(
      expect.objectContaining({
        reason: "service_draining",
        api_code: "runtime_unavailable",
        retry_safe: false
      })
    );
    expect(propertyReads).toBe(0);
    expect(policy.snapshot()).toMatchObject({
      phase: "closed",
      attempts: 1,
      drain_rejections: 1,
      owner_claims: 0
    });
  });

  it("waits for all existing owners and settles concurrent drain observers once", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock);
    const first = owner(
      begin(policy, {
        operationId: "op_admission_drain_first_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    const second = owner(
      begin(policy, {
        operationId: "op_admission_drain_second_001",
        actor: secondWriterActor,
        intent: { value: 2 }
      })
    );
    first.bindTarget(target("drain_first"));
    second.bindTarget(target("drain_second"));

    expect(policy.beginDrain()).toMatchObject({
      phase: "draining",
      active_owners: 2
    });
    expect(() =>
      begin(policy, {
        operationId: "op_admission_drain_first_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    ).toThrow(expect.objectContaining({ reason: "service_draining" }));

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstAdd = vi.spyOn(firstController.signal, "addEventListener");
    const firstRemove = vi.spyOn(firstController.signal, "removeEventListener");
    const secondAdd = vi.spyOn(secondController.signal, "addEventListener");
    const secondRemove = vi.spyOn(secondController.signal, "removeEventListener");
    const firstDrain = policy.drain(firstController.signal);
    const secondDrain = policy.drain(secondController.signal);
    expect(policy.snapshot()).toMatchObject({
      phase: "draining",
      active_owners: 2,
      active_drain_waiters: 2,
      peak_active_drain_waiters: 2
    });

    first.complete(result("op_admission_drain_first_001"));
    expect(policy.snapshot()).toMatchObject({
      phase: "draining",
      active_owners: 1,
      active_drain_waiters: 2
    });
    const retainedError = Object.freeze(new Error("bounded drain failure"));
    expect(() => second.fail(retainedError)).toThrow(retainedError);

    const [firstResult, secondResult] = await Promise.all([firstDrain, secondDrain]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({
      phase: "closed",
      active_owners: 0,
      active_targets: 0,
      active_drain_waiters: 0
    });
    expect(firstAdd).toHaveBeenCalledTimes(1);
    expect(firstRemove).toHaveBeenCalledTimes(1);
    expect(secondAdd).toHaveBeenCalledTimes(1);
    expect(secondRemove).toHaveBeenCalledTimes(1);
  });

  it("detaches an aborted drain observer without abandoning the active owner", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock);
    const claim = owner(
      begin(policy, {
        operationId: "op_admission_drain_abort_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    claim.bindTarget(target("drain_abort"));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const draining = policy.drain(controller.signal);
    controller.abort(new Error("private shutdown timeout"));
    await expect(draining).rejects.toMatchObject({
      reason: "request_aborted",
      api_code: "operation_timeout"
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(policy.snapshot()).toMatchObject({
      phase: "draining",
      active_owners: 1,
      active_drain_waiters: 0,
      drain_aborts: 1
    });

    abandon(claim, "owner cleanup after drain observer abort");
    expect(policy.snapshot()).toMatchObject({
      phase: "closed",
      active_owners: 0,
      abandoned_owners: 1
    });
    await expect(policy.drain(new AbortController().signal)).resolves.toMatchObject({
      phase: "closed",
      active_owners: 0
    });
  });

  it("canonicalizes key order and replays one immutable terminal result", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock);
    const controller = new AbortController();
    const first = owner(
      begin(policy, {
        operationId: "op_admission_terminal_001",
        actor: writerActor,
        intent: {
          action: "prompt",
          value: { text: "private prompt", options: { first: true, second: 2 } }
        },
        signal: controller.signal
      })
    );
    first.bindTarget(target("alpha"));
    const retained = first.complete(
      result("op_admission_terminal_001")
    );
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.response)).toBe(true);

    const replay = replayDecision(
      begin(policy, {
        operationId: "op_admission_terminal_001",
        actor: writerActor,
        intent: {
          value: { options: { second: 2, first: true }, text: "private prompt" },
          action: "prompt"
        },
        signal: controller.signal
      })
    );
    await expect(replay.replay()).resolves.toBe(retained);
    expect(policy.snapshot()).toMatchObject({
      owner_claims: 1,
      terminal_replays: 1,
      value_settlements: 1,
      active_owners: 0,
      active_targets: 0,
      tracked_operations: 1
    });
    expect(JSON.stringify(policy.snapshot())).not.toContain("private prompt");
    expect(JSON.stringify(policy.snapshot())).not.toContain("dev_admission_writer");
    expect(JSON.stringify(policy.snapshot())).not.toContain("sess_admission_alpha");
  });

  it("rejects actor, route, and complete-intent reuse without evaluating accessors", () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock);
    const first = owner(
      begin(policy, {
        operationId: "op_admission_conflict_001",
        actor: writerActor,
        intent: { action: "prompt", value: { text: "one" } }
      })
    );
    first.bindTarget(target("alpha"));
    first.complete(result("op_admission_conflict_001"));

    const conflicts = [
      { actor: secondWriterActor, routeId: "prompt_dispatch", intent: { action: "prompt", value: { text: "one" } } },
      { actor: writerActor, routeId: "goal_mutation", intent: { action: "prompt", value: { text: "one" } } },
      { actor: writerActor, routeId: "prompt_dispatch", intent: { action: "prompt", value: { text: "two" } } }
    ];
    for (const conflict of conflicts) {
      expect(() =>
        begin(policy, {
          operationId: "op_admission_conflict_001",
          actor: conflict.actor,
          routeId: conflict.routeId,
          intent: conflict.intent
        })
      ).toThrow(expect.objectContaining({ reason: "operation_conflict" }));
    }

    let accessorCalls = 0;
    const hostileIntent = Object.defineProperty({}, "text", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "private";
      }
    });
    expect(() =>
      begin(policy, {
        operationId: "op_admission_accessor_001",
        actor: writerActor,
        intent: hostileIntent
      })
    ).toThrow(expect.objectContaining({ reason: "input_invalid" }));
    expect(accessorCalls).toBe(0);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() =>
      begin(policy, {
        operationId: "op_admission_cycle_001",
        actor: writerActor,
        intent: cycle
      })
    ).toThrow(expect.objectContaining({ reason: "input_invalid" }));

    let propertyReads = 0;
    const proxiedArray = new Proxy([1, 2], {
      get(targetValue, key, receiver) {
        propertyReads += 1;
        return Reflect.get(targetValue, key, receiver);
      }
    });
    const descriptorOnly = owner(
      begin(policy, {
        operationId: "op_admission_array_proxy_001",
        actor: writerActor,
        intent: { values: proxiedArray }
      })
    );
    expect(propertyReads).toBe(0);
    abandon(descriptorOnly, "array proxy cleanup");
    expect(policy.snapshot().operation_conflicts).toBe(3);
  });

  it("joins one in-flight owner, cleans an aborted waiter, and never consumes a second slot", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock, {
      mutation_max_in_flight_per_device: 1,
      mutation_max_in_flight_global: 1
    });
    const ownerController = new AbortController();
    const first = owner(
      begin(policy, {
        operationId: "op_admission_inflight_001",
        actor: writerActor,
        intent: { action: "interrupt", value: { confirm: true } },
        signal: ownerController.signal
      })
    );
    first.bindTarget(target("alpha"));

    const replayController = new AbortController();
    const replay = replayDecision(
      begin(policy, {
        operationId: "op_admission_inflight_001",
        actor: writerActor,
        intent: { value: { confirm: true }, action: "interrupt" },
        signal: replayController.signal
      })
    );
    const add = vi.spyOn(replayController.signal, "addEventListener");
    const remove = vi.spyOn(replayController.signal, "removeEventListener");
    const waiting = replay.replay();
    expect(policy.snapshot()).toMatchObject({
      active_owners: 1,
      active_targets: 1,
      active_waiters: 1,
      in_flight_replays: 1
    });
    replayController.abort();
    await expect(waiting).rejects.toMatchObject({ reason: "request_aborted" });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(policy.snapshot()).toMatchObject({
      active_owners: 1,
      active_waiters: 0,
      replay_aborts: 1
    });

    const retained = first.complete(result("op_admission_inflight_001"));
    const terminal = replayDecision(
      begin(policy, {
        operationId: "op_admission_inflight_001",
        actor: writerActor,
        intent: { action: "interrupt", value: { confirm: true } }
      })
    );
    await expect(terminal.replay()).resolves.toBe(retained);
    expect(policy.snapshot().owner_claims).toBe(1);
  });

  it("enforces the exact fixed actor rate window, including replay and conflict attempts", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock, {
      mutation_window_ms: 1_000,
      mutation_max_requests_per_device: 3
    });
    const first = owner(
      begin(policy, {
        operationId: "op_admission_rate_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    first.bindTarget(target("alpha"));
    first.complete(result("op_admission_rate_001"));
    await replayDecision(
      begin(policy, {
        operationId: "op_admission_rate_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    ).replay();
    expect(() =>
      begin(policy, {
        operationId: "op_admission_rate_001",
        actor: writerActor,
        intent: { value: 2 }
      })
    ).toThrow(expect.objectContaining({ reason: "operation_conflict" }));
    expect(() =>
      begin(policy, {
        operationId: "op_admission_rate_002",
        actor: writerActor,
        intent: { value: 2 }
      })
    ).toThrow(expect.objectContaining({ reason: "rate_limit", api_code: "rate_limited" }));

    clock.value = 999;
    expect(() =>
      begin(policy, {
        operationId: "op_admission_rate_003",
        actor: writerActor,
        intent: { value: 3 }
      })
    ).toThrow(expect.objectContaining({ reason: "rate_limit" }));
    clock.value = 1_000;
    const reset = owner(
      begin(policy, {
        operationId: "op_admission_rate_004",
        actor: writerActor,
        intent: { value: 4 }
      })
    );
    abandon(reset, "not started");
    expect(policy.snapshot().rate_rejections).toBe(2);
  });

  it("shares one local-admin rate bucket while isolating distinct dashboard actors", () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock, {
      mutation_max_requests_per_device: 1
    });
    const local = owner(
      begin(policy, {
        operationId: "op_admission_local_rate_001",
        actor: cliActor,
        intent: { value: 1 }
      })
    );
    abandon(local, "local cleanup");
    expect(() =>
      begin(policy, {
        operationId: "op_admission_local_rate_002",
        actor: cliActor,
        intent: { value: 2 }
      })
    ).toThrow(expect.objectContaining({ reason: "rate_limit" }));

    const firstWriter = owner(
      begin(policy, {
        operationId: "op_admission_writer_rate_001",
        actor: writerActor,
        intent: { value: 3 }
      })
    );
    const secondWriter = owner(
      begin(policy, {
        operationId: "op_admission_writer_rate_002",
        actor: secondWriterActor,
        intent: { value: 4 }
      })
    );
    expect(policy.snapshot()).toMatchObject({
      rate_rejections: 1,
      tracked_rate_buckets: 3,
      active_owners: 2
    });
    abandon(firstWriter, "first writer cleanup");
    abandon(secondWriter, "second writer cleanup");
  });

  it("chooses deterministic per-actor and global concurrency winners", () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock, {
      mutation_max_in_flight_per_device: 1,
      mutation_max_in_flight_global: 2
    });
    const first = owner(
      begin(policy, {
        operationId: "op_admission_device_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    expect(() =>
      begin(policy, {
        operationId: "op_admission_device_002",
        actor: writerActor,
        intent: { value: 2 }
      })
    ).toThrow(expect.objectContaining({ reason: "device_limit" }));
    const second = owner(
      begin(policy, {
        operationId: "op_admission_device_003",
        actor: secondWriterActor,
        intent: { value: 3 }
      })
    );
    expect(() =>
      begin(policy, {
        operationId: "op_admission_device_004",
        actor: thirdWriterActor,
        intent: { value: 4 }
      })
    ).toThrow(expect.objectContaining({ reason: "global_limit" }));
    expect(policy.snapshot()).toMatchObject({
      active_owners: 2,
      device_rejections: 1,
      global_rejections: 1,
      peak_active_owners: 2
    });
    abandon(first, "first cleanup");
    abandon(second, "second cleanup");
    expect(policy.snapshot().active_owners).toBe(0);
  });

  it("binds exact targets across actors while leaving different targets isolated", () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock, {
      mutation_max_in_flight_per_device: 2,
      mutation_max_in_flight_per_target: 1,
      mutation_max_in_flight_global: 4
    });
    const first = owner(
      begin(policy, {
        operationId: "op_admission_target_001",
        actor: writerActor,
        intent: { action: "prompt", value: 1 }
      })
    );
    first.bindTarget(target("alpha"));
    const contender = owner(
      begin(policy, {
        operationId: "op_admission_target_002",
        actor: secondWriterActor,
        intent: { action: "archive", value: 2 }
      })
    );
    expect(() => contender.bindTarget(target("alpha"))).toThrow(
      expect.objectContaining({ reason: "target_limit" })
    );
    const isolated = owner(
      begin(policy, {
        operationId: "op_admission_target_003",
        actor: secondWriterActor,
        intent: { action: "archive", value: 3 }
      })
    );
    isolated.bindTarget(target("bravo"));
    expect(policy.snapshot()).toMatchObject({
      active_owners: 2,
      active_targets: 2,
      target_rejections: 1,
      abandoned_owners: 1
    });
    abandon(first, "first cleanup");
    abandon(isolated, "isolated cleanup");
  });

  it("counts every target claim and releases a duplicate-bind contract failure", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock, {
      mutation_max_in_flight_per_device: 2,
      mutation_max_in_flight_per_target: 2,
      mutation_max_in_flight_global: 3
    });
    const first = owner(
      begin(policy, {
        operationId: "op_admission_target_count_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    const second = owner(
      begin(policy, {
        operationId: "op_admission_target_count_002",
        actor: secondWriterActor,
        intent: { value: 2 }
      })
    );
    first.bindTarget(target("shared"));
    second.bindTarget(target("shared"));
    expect(policy.snapshot()).toMatchObject({
      active_owners: 2,
      active_targets: 2,
      peak_active_targets: 2
    });

    expect(() => first.bindTarget(target("drift"))).toThrow(
      expect.objectContaining({ reason: "contract_invalid" })
    );
    const replay = replayDecision(
      begin(policy, {
        operationId: "op_admission_target_count_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    await expect(replay.replay()).rejects.toMatchObject({
      reason: "contract_invalid"
    });
    expect(policy.snapshot()).toMatchObject({
      active_owners: 1,
      active_targets: 1,
      error_settlements: 1,
      contract_failures: 1
    });
    abandon(second, "second cleanup");
  });

  it("retains bounded post-target errors but removes proven not-started abandons", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock);
    const retainedError = Object.freeze(new Error("bounded retained failure"));
    const failed = owner(
      begin(policy, {
        operationId: "op_admission_failure_001",
        actor: cliActor,
        intent: { value: 1 }
      })
    );
    failed.bindTarget(target("alpha"));
    expect(() => failed.fail(retainedError)).toThrow(retainedError);
    const retainedReplay = replayDecision(
      begin(policy, {
        operationId: "op_admission_failure_001",
        actor: cliActor,
        intent: { value: 1 }
      })
    );
    await expect(retainedReplay.replay()).rejects.toBe(retainedError);

    const abandonedError = Object.freeze(new Error("proven not started"));
    const abandoned = owner(
      begin(policy, {
        operationId: "op_admission_failure_002",
        actor: cliActor,
        intent: { value: 2 }
      })
    );
    expect(() => abandoned.abandon(abandonedError)).toThrow(abandonedError);
    expect(
      begin(policy, {
        operationId: "op_admission_failure_002",
        actor: cliActor,
        intent: { value: 2 }
      }).state
    ).toBe("owner");
    expect(policy.snapshot()).toMatchObject({
      error_settlements: 1,
      abandoned_owners: 1
    });
  });

  it("never evicts live truth, rejects tracked-key pressure, and prunes terminal state at TTL", () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock, {
      mutation_max_requests_per_device: 600,
      admission_max_tracked_keys: 64,
      admission_state_ttl_ms: 60_000,
      pairing_code_lifetime_ms: 60_000
    });
    for (let index = 0; index < 63; index += 1) {
      const operationId = `op_admission_capacity_${String(index).padStart(3, "0")}`;
      const claim = owner(
        begin(policy, {
          operationId,
          actor: cliActor,
          intent: { index }
        })
      );
      claim.bindTarget(target(`capacity_${index}`));
      claim.complete(result(operationId));
    }
    expect(policy.snapshot()).toMatchObject({
      tracked_operations: 63,
      tracked_rate_buckets: 1,
      peak_tracked_keys: 64
    });
    expect(() =>
      begin(policy, {
        operationId: "op_admission_capacity_overflow",
        actor: cliActor,
        intent: { index: 64 }
      })
    ).toThrow(expect.objectContaining({ reason: "capacity_reached" }));

    clock.value = 60_000;
    const afterTtl = owner(
      begin(policy, {
        operationId: "op_admission_capacity_after_ttl",
        actor: cliActor,
        intent: { index: 65 }
      })
    );
    expect(policy.snapshot()).toMatchObject({
      tracked_operations: 1,
      tracked_rate_buckets: 1,
      capacity_rejections: 1
    });
    abandon(afterTtl, "cleanup");
  });

  it("fails closed on clock rollback during admission or settlement and isolates policy instances", async () => {
    const firstClock = { value: 100 };
    const secondClock = { value: 100 };
    const firstPolicy = createPolicy(firstClock);
    const secondPolicy = createPolicy(secondClock);
    const first = owner(
      begin(firstPolicy, {
        operationId: "op_admission_clock_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    first.bindTarget(target("alpha"));
    expect(
      begin(secondPolicy, {
        operationId: "op_admission_clock_001",
        actor: writerActor,
        intent: { value: 1 }
      }).state
    ).toBe("owner");

    firstClock.value = 99;
    expect(() => first.complete(result("op_admission_clock_001"))).toThrow(
      expect.objectContaining({ reason: "clock_invalid" })
    );
    firstClock.value = 101;
    const replay = replayDecision(
      begin(firstPolicy, {
        operationId: "op_admission_clock_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    await expect(replay.replay()).rejects.toMatchObject({ reason: "clock_invalid" });
    expect(firstPolicy.snapshot()).toMatchObject({
      clock_failures: 1,
      active_owners: 0,
      error_settlements: 1
    });

    firstClock.value = 100;
    expect(() =>
      begin(firstPolicy, {
        operationId: "op_admission_clock_002",
        actor: writerActor,
        intent: { value: 2 }
      })
    ).toThrow(expect.objectContaining({ reason: "clock_invalid" }));
  });

  it("turns malformed replay results and owner misuse into retained contract failures", async () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock);
    const claim = owner<unknown>(
      begin(policy, {
        operationId: "op_admission_result_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    claim.bindTarget(target("alpha"));
    let accessorCalls = 0;
    const hostileResult = Object.defineProperty({}, "response", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "private";
      }
    });
    expect(() => claim.complete(hostileResult)).toThrow(
      expect.objectContaining({ reason: "contract_invalid" })
    );
    expect(accessorCalls).toBe(0);
    const replay = replayDecision(
      begin<unknown>(policy, {
        operationId: "op_admission_result_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    await expect(replay.replay()).rejects.toMatchObject({ reason: "contract_invalid" });
    await expect(replay.replay()).rejects.toMatchObject({ reason: "contract_invalid" });
    expect(policy.snapshot().contract_failures).toBeGreaterThanOrEqual(2);
  });

  it("clones an own __proto__ result field without changing the clone prototype", () => {
    const clock = { value: 0 };
    const policy = createPolicy(clock);
    const claim = owner<unknown>(
      begin(policy, {
        operationId: "op_admission_proto_result_001",
        actor: writerActor,
        intent: { value: 1 }
      })
    );
    claim.bindTarget(target("alpha"));
    const candidate = Object.defineProperty(
      { outcome: "succeeded", response: { accepted: true } },
      "__proto__",
      {
        enumerable: true,
        value: { polluted: true }
      }
    );
    const retained = claim.complete(candidate) as Record<string, unknown>;
    expect(Object.getPrototypeOf(retained)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(retained, "__proto__")?.value).toEqual({
      polluted: true
    });
    expect(({} as { readonly polluted?: boolean }).polluted).toBeUndefined();
  });
});

function createPolicy(
  clock: Clock,
  overrides: Partial<typeof defaultResourceBudget> = {}
): HostDeckSelectedWriteAdmissionPolicy {
  return createHostDeckSelectedWriteAdmissionPolicy({
    resourceBudget: resolveResourceBudget(overrides),
    now: () => clock.value
  });
}

function createHealth(): HostDeckHostHealthService {
  return createHostDeckHostHealthService({
    now: () => new Date("2026-07-20T18:00:00.000Z")
  });
}

function makeHealthReady(health: HostDeckHostHealthService): void {
  for (const component of hostDeckLocalHealthComponents) {
    health.updateLocal({
      component,
      state: "ready",
      reasons: [],
      source_generation: 1
    });
  }
}

function begin<T = TestResult>(
  policy: HostDeckSelectedWriteAdmissionPolicy,
  input: {
    readonly operationId: string;
    readonly actor: typeof cliActor;
    readonly routeId?: string;
    readonly intent: unknown;
    readonly signal?: AbortSignal;
  }
): HostDeckSelectedWriteAdmissionDecision<T> {
  return policy.begin<T>({
    operation_id: input.operationId,
    actor: input.actor,
    route_id: input.routeId ?? "prompt_dispatch",
    intent: input.intent,
    signal: input.signal ?? new AbortController().signal
  });
}

function owner<T>(
  decision: HostDeckSelectedWriteAdmissionDecision<T>
): HostDeckSelectedWriteAdmissionOwner<T> {
  if (decision.state !== "owner") throw new TypeError("Expected an admission owner.");
  return decision;
}

function replayDecision<T>(
  decision: HostDeckSelectedWriteAdmissionDecision<T>
): HostDeckSelectedWriteAdmissionReplay<T> {
  if (decision.state !== "replay") throw new TypeError("Expected an admission replay.");
  return decision;
}

function abandon<T>(ownerClaim: HostDeckSelectedWriteAdmissionOwner<T>, message: string): void {
  const error = Object.freeze(new Error(message));
  try {
    ownerClaim.abandon(error);
  } catch (caught) {
    expect(caught).toBe(error);
  }
}

function result(operationId: string): TestResult {
  return {
    outcome: "succeeded",
    response: {
      operation_id: operationId,
      accepted: true
    }
  };
}

function dashboardActor(deviceId: string) {
  return selectedAuditActorSchema.parse({
    type: "dashboard",
    device_id: deviceId,
    permission: "write",
    origin: "https://hostdeck.example.test"
  });
}

function target(suffix: string) {
  return selectedAuditTargetSchema.parse({
    type: "managed_session",
    session_id: `sess_admission_${suffix}`,
    codex_thread_id: `thread-admission-${suffix}`
  });
}
