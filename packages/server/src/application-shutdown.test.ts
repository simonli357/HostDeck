import {
  defaultResourceBudget,
  resolveResourceBudget,
  selectedAuditActorSchema,
  selectedAuditTargetSchema
} from "@hostdeck/contracts";
import { createOperationDeadline, type OperationDeadline } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  assertHostDeckApplicationShutdown,
  assertHostDeckSelectedWriteShutdownPort,
  type CreateHostDeckApplicationShutdownInput,
  createHostDeckApplicationShutdown,
  createHostDeckSelectedWriteShutdownPort,
  type HostDeckApplicationAdmissionDrainAcknowledgement,
  type HostDeckApplicationAuditBarrierAcknowledgement,
  type HostDeckApplicationProjectionBarrierAcknowledgement,
  HostDeckApplicationShutdownError,
  type HostDeckApplicationShutdownStage,
  HostDeckApplicationShutdownStageError,
  type HostDeckApplicationWriteDrainAcknowledgement
} from "./application-shutdown.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";

type StageOperation = (deadline?: OperationDeadline) => unknown;

interface HarnessOptions {
  readonly budget?: typeof defaultResourceBudget;
  readonly operations?: Partial<
    Record<HostDeckApplicationShutdownStage, StageOperation>
  >;
}

describe("HostDeck application shutdown", () => {
  it("requires exact descriptor-safe ports and exposes only branded controllers", () => {
    const harness = createHarness();
    expect(Object.isFrozen(harness.controller)).toBe(true);
    expect(() => assertHostDeckApplicationShutdown(harness.controller)).not.toThrow();
    expect(() =>
      assertHostDeckApplicationShutdown(Object.freeze({ ...harness.controller }))
    ).toThrow(TypeError);
    expect(Object.isFrozen(harness.controller.snapshot())).toBe(true);
    expect(Object.isFrozen(harness.controller.snapshot().stages)).toBe(true);
    expect(Object.isFrozen(harness.controller.snapshot().stages[0])).toBe(true);

    const base = shutdownInput([], {});
    const invalid = [
      null,
      {},
      { ...base, extra: true },
      { ...base, resource_budget: {} },
      { ...base, subscribers: {} },
      { ...base, writes: { beginDrain: () => undefined } }
    ];
    for (const candidate of invalid) {
      expect(() => createHostDeckApplicationShutdown(candidate as never)).toThrow(
        TypeError
      );
    }

    let topAccessorReads = 0;
    const topAccessor = Object.defineProperty(
      { ...base, subscribers: undefined },
      "subscribers",
      {
        enumerable: true,
        get() {
          topAccessorReads += 1;
          return base.subscribers;
        }
      }
    );
    expect(() => createHostDeckApplicationShutdown(topAccessor as never)).toThrow(
      TypeError
    );
    expect(topAccessorReads).toBe(0);

    let portAccessorReads = 0;
    const portAccessor = Object.defineProperty({}, "close", {
      enumerable: true,
      get() {
        portAccessorReads += 1;
        return () => undefined;
      }
    });
    expect(() =>
      createHostDeckApplicationShutdown({
        ...base,
        subscribers: portAccessor as never
      })
    ).toThrow(TypeError);
    expect(portAccessorReads).toBe(0);

    let budgetAccessorReads = 0;
    const budgetDescriptors = Object.getOwnPropertyDescriptors(
      defaultResourceBudget
    );
    budgetDescriptors.lifecycle_shutdown_timeout_ms = {
      enumerable: true,
      configurable: false,
      get() {
        budgetAccessorReads += 1;
        return defaultResourceBudget.lifecycle_shutdown_timeout_ms;
      }
    };
    const hostileBudget = Object.freeze(
      Object.defineProperties({}, budgetDescriptors)
    );
    expect(() =>
      createHostDeckApplicationShutdown({
        ...base,
        resource_budget: hostileBudget as never
      })
    ).toThrow(TypeError);
    expect(budgetAccessorReads).toBe(0);
    expect(harness.events).toEqual([]);
  });

  it("runs the exact close order with component caps and immutable zero-pending truth", async () => {
    const observedTimeouts = new Map<HostDeckApplicationShutdownStage, number>();
    const harness = createHarness({
      operations: Object.fromEntries(
        [
          "subscribers",
          "approvals",
          "reconnect",
          "writes",
          "audit",
          "projection",
          "supervisor",
          "storage",
          "lease"
        ].map((stage) => [
          stage,
          (deadline: OperationDeadline) => {
            observedTimeouts.set(
              stage as HostDeckApplicationShutdownStage,
              deadline.remainingMs()
            );
            return defaultAcknowledgement(
              stage as HostDeckApplicationShutdownStage
            );
          }
        ])
      )
    });
    const deadline = createOperationDeadline({ timeoutMs: 5_000 });
    try {
      harness.controller.beginDrain();
      const sse = harness.controller.closeSse(deadline);
      expect(harness.controller.closeSse({} as OperationDeadline)).toBe(sse);
      await sse;
      const runtime = harness.controller.closeRuntime(deadline);
      expect(harness.controller.closeRuntime({} as OperationDeadline)).toBe(runtime);
      await runtime;
      const startup = harness.controller.closeStartup(deadline);
      expect(harness.controller.closeStartup({} as OperationDeadline)).toBe(
        startup
      );
      await startup;
    } finally {
      deadline.dispose();
    }

    expect(harness.events).toEqual([
      "admission",
      "subscribers",
      "approvals",
      "reconnect",
      "writes",
      "audit",
      "projection",
      "supervisor",
      "storage",
      "lease"
    ]);
    expect(observedTimeouts.get("subscribers")).toBeLessThanOrEqual(
      defaultResourceBudget.sse_shutdown_timeout_ms
    );
    expect(observedTimeouts.get("reconnect")).toBeLessThanOrEqual(
      defaultResourceBudget.protocol_close_timeout_ms
    );
    for (const stage of [
      "approvals",
      "writes",
      "audit",
      "projection",
      "supervisor",
      "storage",
      "lease"
    ] as const) {
      expect(observedTimeouts.get(stage)).toBeLessThanOrEqual(
        defaultResourceBudget.lifecycle_cleanup_step_timeout_ms
      );
    }
    expect(harness.controller.snapshot()).toEqual({
      phase: "closed",
      completed_stage_count: 10,
      failed_stage_count: 0,
      active_write_operations: 0,
      pending_audit_operations: 0,
      reconciled_audit_operations: 3,
      pending_projection_notifications: 0,
      projection_last_sequence: 17,
      stages: [
        "admission",
        "subscribers",
        "approvals",
        "reconnect",
        "writes",
        "audit",
        "projection",
        "supervisor",
        "storage",
        "lease"
      ].map((stage) => ({ stage, state: "succeeded", failure: null }))
    });
  });

  it("attempts every later stage after each individual component failure", async () => {
    for (const failedStage of [
      "admission",
      "subscribers",
      "approvals",
      "reconnect",
      "writes",
      "audit",
      "projection",
      "supervisor",
      "storage",
      "lease"
    ] as const) {
      const harness = createHarness({
        operations: {
          [failedStage]: () => {
            throw new Error(`private-${failedStage}-failure`);
          }
        }
      });
      const deadline = createOperationDeadline({ timeoutMs: 5_000 });
      let admissionError: unknown = null;
      try {
        try {
          harness.controller.beginDrain();
        } catch (error) {
          admissionError = error;
        }
        await harness.controller.closeSse(deadline).catch(() => undefined);
        await harness.controller.closeRuntime(deadline).catch(() => undefined);
        await harness.controller.closeStartup(deadline).catch(() => undefined);
      } finally {
        deadline.dispose();
      }

      if (failedStage === "admission") {
        expect(admissionError).toBeInstanceOf(
          HostDeckApplicationShutdownStageError
        );
        expect(() => harness.controller.beginDrain()).toThrow(admissionError);
      }
      expect(harness.events).toEqual([
        "admission",
        "subscribers",
        "approvals",
        "reconnect",
        "writes",
        "audit",
        "projection",
        "supervisor",
        "storage",
        "lease"
      ]);
      const snapshot = harness.controller.snapshot();
      expect(snapshot.phase).toBe("failed");
      expect(snapshot.failed_stage_count).toBe(1);
      expect(snapshot.stages.find((stage) => stage.stage === failedStage)).toEqual({
        stage: failedStage,
        state: "failed",
        failure: "failed"
      });
      expect(JSON.stringify(snapshot)).not.toContain("private-");
    }
  });

  it("rejects contradictory barrier acknowledgements and still closes later owners", async () => {
    const harness = createHarness({
      operations: {
        subscribers: () => 1,
        writes: () => Object.freeze({ active_operations: 1 }),
        audit: () =>
          Object.freeze({ pending_operations: 1, reconciled_operations: 0 }),
        projection: () =>
          Object.freeze({ last_sequence: 17, pending_notifications: 1 })
      }
    });
    const deadline = createOperationDeadline({ timeoutMs: 5_000 });
    try {
      harness.controller.beginDrain();
      await expect(harness.controller.closeSse(deadline)).rejects.toMatchObject({
        failed_stages: ["subscribers"]
      });
      await expect(harness.controller.closeRuntime(deadline)).rejects.toMatchObject({
        failed_stages: ["writes", "audit", "projection"]
      });
      await harness.controller.closeStartup(deadline);
    } finally {
      deadline.dispose();
    }
    expect(harness.events.at(-3)).toBe("supervisor");
    expect(harness.events.slice(-2)).toEqual(["storage", "lease"]);
    expect(harness.controller.snapshot()).toMatchObject({
      phase: "failed",
      failed_stage_count: 4,
      active_write_operations: 2,
      pending_audit_operations: null,
      pending_projection_notifications: null
    });
    for (const stage of ["subscribers", "writes", "audit", "projection"] as const) {
      expect(
        harness.controller.snapshot().stages.find((entry) => entry.stage === stage)
      ).toMatchObject({ state: "failed", failure: "contract_invalid" });
    }
  });

  it("rejects mutable, extra-key, and accessor acknowledgements without reading accessors", async () => {
    let accessorReads = 0;
    const accessorAcknowledgement = Object.freeze(
      Object.defineProperty({}, "active_operations", {
        enumerable: true,
        get() {
          accessorReads += 1;
          return 0;
        }
      })
    );
    const candidates: readonly unknown[] = [
      { active_operations: 0 },
      Object.freeze({ active_operations: 0, extra: true }),
      accessorAcknowledgement
    ];

    for (const candidate of candidates) {
      const harness = createHarness({
        operations: { writes: () => candidate }
      });
      const deadline = createOperationDeadline({ timeoutMs: 5_000 });
      try {
        harness.controller.beginDrain();
        await harness.controller.closeSse(deadline);
        await expect(harness.controller.closeRuntime(deadline)).rejects.toMatchObject({
          failed_stages: ["writes"]
        });
        await harness.controller.closeStartup(deadline);
      } finally {
        deadline.dispose();
      }
      expect(harness.events.slice(-5)).toEqual([
        "audit",
        "projection",
        "supervisor",
        "storage",
        "lease"
      ]);
      expect(
        harness.controller
          .snapshot()
          .stages.find((stage) => stage.stage === "writes")
      ).toEqual({
        stage: "writes",
        state: "failed",
        failure: "contract_invalid"
      });
    }
    expect(accessorReads).toBe(0);
  });

  it("bounds a noncooperative stage, observes late settlement, and continues", async () => {
    let resolveReconnect!: () => void;
    const reconnect = new Promise<void>((resolve) => {
      resolveReconnect = resolve;
    });
    const budget = resolveResourceBudget({
      lifecycle_cleanup_step_timeout_ms: 50,
      protocol_close_timeout_ms: 100,
      lifecycle_shutdown_timeout_ms: 1_000,
      sse_shutdown_timeout_ms: 50,
      sse_disconnect_cleanup_timeout_ms: 50
    });
    const harness = createHarness({
      budget,
      operations: { reconnect: () => reconnect }
    });
    const deadline = createOperationDeadline({ timeoutMs: 1_000 });
    const startedAt = performance.now();
    try {
      harness.controller.beginDrain();
      await harness.controller.closeSse(deadline);
      const close = harness.controller.closeRuntime(deadline);
      expect(harness.controller.closeRuntime(deadline)).toBe(close);
      await expect(close).rejects.toMatchObject({ failed_stages: ["reconnect"] });
      expect(performance.now() - startedAt).toBeLessThan(800);
      await harness.controller.closeStartup(deadline);
    } finally {
      deadline.dispose();
    }
    expect(harness.events).toEqual([
      "admission",
      "subscribers",
      "approvals",
      "reconnect",
      "writes",
      "audit",
      "projection",
      "supervisor",
      "storage",
      "lease"
    ]);
    expect(
      harness.controller.snapshot().stages.find((stage) => stage.stage === "reconnect")
    ).toEqual({
      stage: "reconnect",
      state: "failed",
      failure: "timed_out"
    });
    resolveReconnect();
    await Promise.resolve();
    expect(
      harness.controller.snapshot().stages.find((stage) => stage.stage === "reconnect")
    ).toMatchObject({ state: "failed", failure: "timed_out" });
  });

  it("attempts every runtime and final callback after outer abort", async () => {
    const parent = new AbortController();
    const harness = createHarness({
      operations: {
        approvals: () => {
          parent.abort(new Error("private outer abort"));
        }
      }
    });
    const deadline = createOperationDeadline({
      timeoutMs: 5_000,
      parentSignal: parent.signal
    });
    try {
      harness.controller.beginDrain();
      await harness.controller.closeSse(deadline);
      await expect(harness.controller.closeRuntime(deadline)).rejects.toBeInstanceOf(
        HostDeckApplicationShutdownError
      );
      await expect(harness.controller.closeStartup(deadline)).rejects.toBeInstanceOf(
        HostDeckApplicationShutdownError
      );
    } finally {
      deadline.dispose();
    }
    expect(harness.events).toEqual([
      "admission",
      "subscribers",
      "approvals",
      "reconnect",
      "writes",
      "audit",
      "projection",
      "supervisor",
      "storage",
      "lease"
    ]);
    expect(harness.controller.snapshot()).toMatchObject({
      phase: "failed",
      failed_stage_count: 8
    });
    expect(
      harness.controller
        .snapshot()
        .stages.filter((stage) => stage.state === "failed")
        .every((stage) => stage.failure === "aborted")
    ).toBe(true);
  });

  it("adapts the branded selected admission owner into the aggregate write barrier", async () => {
    const clock = { value: 0 };
    const admission = createHostDeckSelectedWriteAdmissionPolicy({
      resourceBudget: defaultResourceBudget,
      now: () => clock.value
    });
    const port = createHostDeckSelectedWriteShutdownPort({ admission });
    expect(Object.isFrozen(port)).toBe(true);
    expect(() => assertHostDeckSelectedWriteShutdownPort(port)).not.toThrow();
    expect(() =>
      assertHostDeckSelectedWriteShutdownPort(Object.freeze({ ...port }))
    ).toThrow(TypeError);

    const actor = selectedAuditActorSchema.parse({
      type: "cli",
      device_id: null,
      permission: "local_admin",
      origin: null
    });
    const target = selectedAuditTargetSchema.parse({
      type: "managed_session",
      session_id: "sess_shutdown_selected_01",
      codex_thread_id: "thread-shutdown-selected-01"
    });
    const owner = admission.begin<{ readonly outcome: "succeeded" }>({
      operation_id: "op_shutdown_selected_admission_001",
      actor,
      route_id: "prompt_dispatch",
      intent: Object.freeze({ action: "prompt" }),
      signal: new AbortController().signal
    });
    if (owner.state !== "owner") throw new TypeError("Expected selected owner.");
    owner.bindTarget(target);
    expect(port.beginDrain()).toEqual({
      admission: "closed",
      active_operations: 1
    });
    expect(() =>
      admission.begin({
        operation_id: "op_shutdown_selected_rejected_001",
        actor,
        route_id: "prompt_dispatch",
        intent: Object.freeze({ action: "prompt" }),
        signal: new AbortController().signal
      })
    ).toThrow(expect.objectContaining({ reason: "service_draining" }));

    const deadline = createOperationDeadline({ timeoutMs: 1_000 });
    try {
      const drained = port.drain(deadline);
      owner.complete(Object.freeze({ outcome: "succeeded" as const }));
      await expect(drained).resolves.toEqual({ active_operations: 0 });
    } finally {
      deadline.dispose();
    }
    expect(admission.snapshot()).toMatchObject({
      phase: "closed",
      active_owners: 0,
      drain_rejections: 1
    });
  });
});

function createHarness(options: HarnessOptions = {}) {
  const events: HostDeckApplicationShutdownStage[] = [];
  const controller = createHostDeckApplicationShutdown(
    shutdownInput(events, options)
  );
  return { controller, events };
}

function shutdownInput(
  events: HostDeckApplicationShutdownStage[],
  options: HarnessOptions
): CreateHostDeckApplicationShutdownInput {
  const invoke = (
    stage: HostDeckApplicationShutdownStage,
    deadline?: OperationDeadline
  ) => {
    events.push(stage);
    const operation = options.operations?.[stage];
    if (operation !== undefined) return operation(deadline);
    return defaultAcknowledgement(stage);
  };
  const result = <T>(
    stage: HostDeckApplicationShutdownStage,
    deadline?: OperationDeadline
  ): T => invoke(stage, deadline) as T;
  return {
    approvals: {
      close: (deadline) => result<void | Promise<void>>("approvals", deadline)
    },
    audit: {
      barrier: (deadline) =>
        result<
          | HostDeckApplicationAuditBarrierAcknowledgement
          | Promise<HostDeckApplicationAuditBarrierAcknowledgement>
        >("audit", deadline)
    },
    lease: {
      release: (deadline) => result<void | Promise<void>>("lease", deadline)
    },
    projection: {
      barrier: (deadline) =>
        result<
          | HostDeckApplicationProjectionBarrierAcknowledgement
          | Promise<HostDeckApplicationProjectionBarrierAcknowledgement>
        >("projection", deadline)
    },
    reconnect: {
      close: (deadline) => result<void | Promise<void>>("reconnect", deadline)
    },
    resource_budget: options.budget ?? defaultResourceBudget,
    storage: {
      close: (deadline) => result<void | Promise<void>>("storage", deadline)
    },
    subscribers: {
      close: (deadline) => result<void | Promise<void>>("subscribers", deadline)
    },
    supervisor: {
      close: (deadline) => result<void | Promise<void>>("supervisor", deadline)
    },
    writes: {
      beginDrain: () =>
        result<HostDeckApplicationAdmissionDrainAcknowledgement>("admission"),
      drain: (deadline) =>
        result<
          | HostDeckApplicationWriteDrainAcknowledgement
          | Promise<HostDeckApplicationWriteDrainAcknowledgement>
        >("writes", deadline)
    }
  };
}

function defaultAcknowledgement(stage: HostDeckApplicationShutdownStage): unknown {
  switch (stage) {
    case "admission":
      return Object.freeze({ admission: "closed" as const, active_operations: 2 });
    case "writes":
      return Object.freeze({ active_operations: 0 as const });
    case "audit":
      return Object.freeze({
        pending_operations: 0 as const,
        reconciled_operations: 3
      });
    case "projection":
      return Object.freeze({
        last_sequence: 17,
        pending_notifications: 0 as const
      });
    default:
      return undefined;
  }
}
