import { defaultResourceBudget, resolveResourceBudget } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexReconnectClock,
  type CodexReconnectLifecyclePort,
  type CodexReconnectReadPort,
  createCodexRuntimeReconnectController,
  HostDeckCodexReconnectError
} from "./reconnect-controller.js";
import { ScriptedCodexTransport } from "./testing.js";

describe("Codex runtime reconnect controller", () => {
  it("gates admission through compatibility, reconciliation, held callbacks, resubscription, and ready", async () => {
    const reconcileGate = deferred<void>();
    const events: string[] = [];
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle({
        async reconcile() {
          events.push("reconcile");
          await reconcileGate.promise;
          return { continuity: "continuous" };
        },
        resubscribe() {
          events.push("resubscribe");
        },
        ready() {
          events.push("ready");
        }
      }),
      on_notification: (message) => events.push(`notification:${message.method}`),
      on_server_request: (message) => events.push(`request:${message.method}`)
    });

    const starting = controller.start();
    await waitFor(() => controller.snapshot().phase === "reconciling");
    expect(controller.compatibility).toMatchObject({ state: "degraded", mutation_policy: "blocked" });
    await expectAdapterError(
      controller.request({ method: "turn/start", params: {}, kind: "mutation" }),
      "transport_not_open",
      "not_sent",
      true
    );

    transport.receive('{"method":"turn/started","params":{}}');
    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-held","params":{}}');
    expect(controller.snapshot()).toMatchObject({ held_notifications: 1, held_server_requests: 1 });
    expect(events).toEqual(["reconcile"]);

    reconcileGate.resolve();
    await expect(starting).resolves.toMatchObject({
      generation: 1,
      continuity: "continuous",
      reconnected: false,
      compatibility: { state: "ready", mutation_policy: "allowed" }
    });
    expect(events).toEqual([
      "reconcile",
      "resubscribe",
      "notification:turn/started",
      "request:item/fileChange/requestApproval",
      "ready"
    ]);
    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      admitted_generation: 1,
      held_notifications: 0,
      held_server_requests: 0
    });
    await controller.close();
  });

  it("drains callbacks that arrive while the final ready publication is pending", async () => {
    const readyGate = deferred<void>();
    const delivered: string[] = [];
    let readyEntered = false;
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle({
        async ready() {
          readyEntered = true;
          await readyGate.promise;
        }
      }),
      on_notification: (message) => delivered.push(message.method)
    });
    const starting = controller.start();
    await waitFor(() => readyEntered);
    expect(controller.snapshot()).toMatchObject({ phase: "resubscribing", admitted_generation: null });

    transport.receive('{"method":"turn/started","params":{}}');
    expect(controller.snapshot().held_notifications).toBe(1);
    readyGate.resolve();
    await starting;

    expect(delivered).toEqual(["turn/started"]);
    expect(controller.snapshot()).toMatchObject({ phase: "ready", held_notifications: 0 });
    await controller.close();
  });

  it("closes writes synchronously, preserves in-flight outcome truth, and reconnects without replay", async () => {
    const manual = manualClock();
    const lifecycleEvents: string[] = [];
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      clock: manual.clock,
      random: () => 0,
      lifecycle: lifecycle({
        disconnected(input) {
          lifecycleEvents.push(`disconnected:${input.generation}`);
        },
        reconcile(input) {
          lifecycleEvents.push(`reconcile:${input.generation}`);
          return { continuity: input.generation === 1 ? "continuous" : "boundary_required" };
        },
        resubscribe(input) {
          lifecycleEvents.push(`resubscribe:${input.generation}`);
        },
        ready(input) {
          lifecycleEvents.push(`ready:${input.generation}`);
        }
      })
    });
    await controller.start();
    const read = controller.request({ method: "thread/list", params: { hold: true }, kind: "read" });
    const mutation = controller.request({ method: "turn/start", params: { hold: true }, kind: "mutation" });

    transport.disconnect("private runtime restarted");
    expect(controller.snapshot()).toMatchObject({ phase: "disconnected", admitted_generation: null });
    await expectAdapterError(
      controller.request({ method: "turn/start", params: {}, kind: "mutation" }),
      "transport_not_open",
      "not_sent",
      true
    );
    await expectAdapterError(read, "transport_closed", "unknown", true);
    await expectAdapterError(mutation, "unknown_outcome", "unknown", false);

    await waitFor(() => controller.snapshot().phase === "backing_off");
    expect(manual.sleepDelays).toEqual([125]);
    expect(lifecycleEvents).toContain("disconnected:1");
    manual.releaseSleep();
    await waitFor(() => controller.snapshot().phase === "ready" && controller.generation === 2);

    expect(controller.snapshot()).toMatchObject({
      completed_reconnects: 1,
      disconnect_cleanups: 1,
      connect_attempts: 2,
      consecutive_retryable_failures: 0
    });
    expect(lifecycleEvents.slice(-3)).toEqual(["reconcile:2", "resubscribe:2", "ready:2"]);
    expect(sentMethods(transport).filter((method) => method === "turn/start")).toHaveLength(1);
    await controller.close();
  });

  it("stops reconnect when disconnected cleanup cannot publish safe state", async () => {
    const failures: HostDeckCodexReconnectError[] = [];
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle({
        disconnected() {
          throw new Error("private cleanup detail");
        }
      }),
      on_background_error: (error) => failures.push(error)
    });
    await controller.start();

    transport.disconnect("cleanup failure");
    await waitFor(() => controller.snapshot().phase === "failed");

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "lifecycle_failed", stage: "disconnect" });
    expect(controller.snapshot()).toMatchObject({ connect_attempts: 1, disconnect_cleanups: 0 });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private cleanup detail");
    await controller.close();
  });

  it("uses capped equal-jitter exponential delays and resets only after full readiness", async () => {
    const manual = manualClock();
    const transport = respondingTransport({ failInitializeAttempts: 2 });
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport, {
        protocol_reconnect_initial_delay_ms: 100,
        protocol_reconnect_max_delay_ms: 150
      }),
      clock: manual.clock,
      random: () => 0,
      lifecycle: lifecycle()
    });
    const starting = controller.start();

    await waitFor(() => manual.sleepDelays.length === 1);
    expect(manual.sleepDelays).toEqual([50]);
    manual.releaseSleep();
    await waitFor(() => manual.sleepDelays.length === 2);
    expect(manual.sleepDelays).toEqual([50, 75]);
    manual.releaseSleep();
    await expect(starting).resolves.toMatchObject({ generation: 3 });
    expect(controller.snapshot()).toMatchObject({ connect_attempts: 3, consecutive_retryable_failures: 0 });

    transport.disconnect("again");
    await waitFor(() => manual.sleepDelays.length === 3);
    expect(manual.sleepDelays.at(-1)).toBe(50);
    manual.releaseSleep();
    await waitFor(() => controller.snapshot().phase === "ready" && controller.generation === 4);
    await controller.close();
  });

  it("cancels backoff and initial readiness without starting another generation", async () => {
    const manual = manualClock();
    const transport = respondingTransport({ failInitializeAttempts: 10 });
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      clock: manual.clock,
      lifecycle: lifecycle()
    });
    const starting = controller.start();
    await waitFor(() => controller.snapshot().phase === "backing_off");

    await controller.close();

    await expect(starting).rejects.toMatchObject({ code: "closed", stage: "shutdown" });
    expect(controller.snapshot()).toMatchObject({ phase: "closed", connect_attempts: 1 });
    expect(manual.pendingSleeps).toBe(0);
  });

  it("closes without waiting for a noncooperative transport connect", async () => {
    const transport = respondingTransport();
    Object.defineProperty(transport, "connect", {
      configurable: true,
      value: () => new Promise<void>(() => undefined)
    });
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle()
    });
    const starting = controller.start();
    await waitFor(() => controller.snapshot().phase === "connecting");

    await controller.close();

    await expect(starting).rejects.toMatchObject({ code: "closed", stage: "shutdown" });
    expect(controller.snapshot()).toMatchObject({ phase: "closed", connect_attempts: 1 });
  });

  it("honors initial cancellation of a noncooperative transport connect", async () => {
    const transport = respondingTransport();
    Object.defineProperty(transport, "connect", {
      configurable: true,
      value: () => new Promise<void>(() => undefined)
    });
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle()
    });
    const abort = new AbortController();
    const starting = controller.start(abort.signal);
    await waitFor(() => controller.snapshot().phase === "connecting");

    abort.abort();

    await expect(starting).rejects.toMatchObject({ code: "aborted", stage: "connect" });
    expect(controller.snapshot()).toMatchObject({ phase: "failed", connect_attempts: 1 });
    await controller.close();
  });

  it.each([
    ["reconcile", "reconcile"],
    ["resubscribe", "resubscribe"],
    ["ready", "ready"]
  ] as const)("fails closed when the %s lifecycle step fails", async (method, stage) => {
    const transport = respondingTransport();
    const port = lifecycle({
      [method]() {
        throw new Error("private lifecycle detail");
      }
    });
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: port
    });

    await expect(controller.start()).rejects.toMatchObject({ code: "lifecycle_failed", stage });
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      admitted_generation: null,
      connect_attempts: 1,
      last_failure: { code: "lifecycle_failed", stage }
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private lifecycle detail");
    await controller.close();
  });

  it("does not let lifecycle code forge a retryable controller error", async () => {
    const manual = manualClock();
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      clock: manual.clock,
      lifecycle: lifecycle({
        reconcile() {
          throw new HostDeckCodexReconnectError("transport_failed", "connect", "forged retry");
        }
      })
    });

    await expect(controller.start()).rejects.toMatchObject({ code: "lifecycle_failed", stage: "reconcile" });
    expect(controller.snapshot()).toMatchObject({ phase: "failed", connect_attempts: 1 });
    expect(manual.sleepDelays).toEqual([]);
    await controller.close();
  });

  it("bounds a noncooperative reconciliation callback with the cycle deadline", async () => {
    const manual = manualClock();
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport, { lifecycle_startup_timeout_ms: 15_000 }),
      clock: manual.clock,
      lifecycle: lifecycle({ reconcile: () => new Promise(() => undefined) })
    });
    const starting = controller.start();
    await waitFor(() => controller.snapshot().phase === "reconciling");

    manual.advance(15_000);

    await expect(starting).rejects.toMatchObject({ code: "operation_timeout", stage: "reconcile" });
    expect(controller.snapshot()).toMatchObject({ phase: "failed", admitted_generation: null });
    await controller.close();
  });

  it("honors initial cancellation during reconciliation and does not retry lifecycle work", async () => {
    const gate = deferred<void>();
    let reconciles = 0;
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle({
        async reconcile() {
          reconciles += 1;
          await gate.promise;
          return { continuity: "continuous" };
        }
      })
    });
    const abort = new AbortController();
    const starting = controller.start(abort.signal);
    await waitFor(() => reconciles === 1);

    abort.abort();

    await expect(starting).rejects.toMatchObject({ code: "aborted", stage: "reconcile" });
    expect(controller.snapshot()).toMatchObject({ phase: "failed", connect_attempts: 1 });
    gate.resolve();
    await controller.close();
  });

  it("restarts the cycle when the generation changes during reconciliation", async () => {
    const manual = manualClock();
    const firstReconcile = deferred<void>();
    const delivered: string[] = [];
    let reconciles = 0;
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      clock: manual.clock,
      random: () => 0,
      on_notification: (message) => delivered.push(message.method),
      lifecycle: lifecycle({
        async reconcile() {
          reconciles += 1;
          if (reconciles === 1) await firstReconcile.promise;
          return { continuity: "boundary_required" };
        }
      })
    });
    const starting = controller.start();
    await waitFor(() => reconciles === 1);

    transport.receive('{"method":"turn/started","params":{}}');
    expect(controller.snapshot().held_notifications).toBe(1);
    transport.disconnect("during reconciliation");
    await waitFor(() => controller.snapshot().phase === "backing_off");
    expect(controller.snapshot()).toMatchObject({ admitted_generation: null, disconnect_cleanups: 1 });
    manual.releaseSleep();
    await expect(starting).resolves.toMatchObject({ generation: 2, continuity: "boundary_required" });
    expect(reconciles).toBe(2);
    expect(delivered).toEqual([]);
    transport.receive('{"method":"turn/started","params":{}}');
    expect(delivered).toEqual(["turn/started"]);
    firstReconcile.resolve();
    await controller.close();
  });

  it.each(["resubscribe", "ready"] as const)(
    "restarts the cycle when the generation changes during %s",
    async (method) => {
      const manual = manualClock();
      const firstEntry = deferred<void>();
      let entries = 0;
      const transport = respondingTransport();
      const controller = createCodexRuntimeReconnectController({
        ...baseOptions(transport),
        clock: manual.clock,
        random: () => 0,
        lifecycle: lifecycle({
          async [method]() {
            entries += 1;
            if (entries === 1) await firstEntry.promise;
          }
        })
      });
      const starting = controller.start();
      await waitFor(() => entries === 1);

      transport.disconnect(`during ${method}`);
      await waitFor(() => controller.snapshot().phase === "backing_off");
      expect(controller.snapshot()).toMatchObject({ admitted_generation: null, disconnect_cleanups: 1 });
      manual.releaseSleep();

      await expect(starting).resolves.toMatchObject({ generation: 2 });
      expect(entries).toBe(2);
      firstEntry.resolve();
      await controller.close();
    }
  );

  it.each(["reconcile", "resubscribe", "ready"] as const)(
    "closes without waiting for a noncooperative %s callback",
    async (method) => {
      const callbackGate = deferred<void>();
      let entered = false;
      const transport = respondingTransport();
      const controller = createCodexRuntimeReconnectController({
        ...baseOptions(transport),
        lifecycle: lifecycle({
          async [method]() {
            entered = true;
            await callbackGate.promise;
            if (method === "reconcile") return { continuity: "continuous" };
          }
        } as Partial<CodexReconnectLifecyclePort>)
      });
      const starting = controller.start();
      await waitFor(() => entered);

      await controller.close();

      await expect(starting).rejects.toMatchObject({ code: "closed", stage: "shutdown" });
      expect(controller.snapshot().phase).toBe("closed");
      callbackGate.resolve();
    }
  );

  it("enforces stage methods, generation, and revocation on the lifecycle runtime port", async () => {
    const transport = respondingTransport();
    const retained: { value?: CodexReconnectReadPort } = {};
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle({
        async reconcile(input) {
          retained.value = input.runtime;
          await expect(
            input.runtime.request({ method: "turn/start", params: {}, kind: "mutation" } as never)
          ).rejects.toMatchObject({ code: "invalid_contract", stage: "reconcile" });
          await expect(
            input.runtime.request({ method: "turn/start", params: {}, kind: "read" } as never)
          ).rejects.toMatchObject({ code: "invalid_contract", stage: "reconcile" });
          await expect(
            input.runtime.request({ method: "thread/resume", params: {}, kind: "read" } as never)
          ).rejects.toMatchObject({ code: "invalid_contract", stage: "reconcile" });
          await expect(
            input.runtime.request({
              method: "thread/list",
              params: {},
              kind: "read",
              signal: { aborted: false }
            } as never)
          ).rejects.toMatchObject({ code: "invalid_contract", stage: "reconcile" });
          await expect(
            input.runtime.request({ method: "thread/list", params: {}, kind: "read" })
          ).resolves.toEqual({ data: [] });
          expect(input.runtime.generation).toBe(input.generation);
          return { continuity: "continuous" };
        },
        async resubscribe(input) {
          await expect(
            input.runtime.request({ method: "thread/resume", params: { threadId: "thread-a" }, kind: "read" })
          ).resolves.toEqual({ thread: { id: "thread-a" } });
        },
        async ready(input) {
          await expect(
            (input.runtime as CodexReconnectReadPort).request({
              method: "thread/list",
              params: {},
              kind: "read"
            })
          ).rejects.toMatchObject({ code: "lifecycle_conflict", stage: "ready" });
        }
      })
    });

    await expect(controller.start()).resolves.toMatchObject({ generation: 1 });
    expect(sentMethods(transport)).not.toContain("turn/start");
    await expect(
      (retained.value as CodexReconnectReadPort).request({ method: "thread/list", params: {}, kind: "read" })
    ).rejects.toMatchObject({ code: "lifecycle_conflict", stage: "ready" });
    await controller.close();
  });

  it("stops on incompatible compatibility without retry or fallback", async () => {
    const manual = manualClock();
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      observed_version: "0.145.0",
      clock: manual.clock,
      lifecycle: lifecycle()
    });

    await expect(controller.start()).rejects.toMatchObject({ code: "incompatible", stage: "connect" });
    expect(controller.snapshot()).toMatchObject({ phase: "incompatible", connect_attempts: 1 });
    expect(manual.sleepDelays).toEqual([]);
    expect(transport.generation).toBe(0);
    await controller.close();
  });

  it("classifies a malformed handshake as incompatible without retry", async () => {
    const manual = manualClock();
    const transport = new ScriptedCodexTransport({
      on_send(text, scripted) {
        const message = JSON.parse(text) as { readonly id?: number; readonly method?: string };
        if (message.method === "initialize") {
          scripted.receive(JSON.stringify({ id: message.id, result: { userAgent: "malformed" } }));
        }
      }
    });
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      clock: manual.clock,
      lifecycle: lifecycle()
    });

    await expect(controller.start()).rejects.toMatchObject({ code: "incompatible", stage: "connect" });
    expect(controller.snapshot()).toMatchObject({
      phase: "incompatible",
      connect_attempts: 1,
      disconnect_cleanups: 1
    });
    expect(manual.sleepDelays).toEqual([]);
    await controller.close();
  });

  it("fails a generation when the bounded pre-admission notification queue overflows", async () => {
    const gate = deferred<void>();
    const transport = respondingTransport();
    const budget = resolveResourceBudget({ protocol_max_pending_notifications: 8 });
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      resource_budget: budget,
      lifecycle: lifecycle({
        async reconcile() {
          await gate.promise;
          return { continuity: "continuous" };
        }
      })
    });
    const starting = controller.start();
    await waitFor(() => controller.snapshot().phase === "reconciling");

    for (let index = 0; index < 9 && transport.state === "open"; index += 1) {
      transport.receive('{"method":"turn/started","params":{}}');
    }

    await expect(starting).rejects.toMatchObject({ code: "protocol_failed", stage: "inbound" });
    expect(controller.snapshot()).toMatchObject({ phase: "failed", admitted_generation: null });
    gate.resolve();
    await controller.close();
  });

  it("reports a post-ready application callback failure and does not reconnect it", async () => {
    const failures: HostDeckCodexReconnectError[] = [];
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle(),
      on_notification() {
        throw new Error("private callback detail");
      },
      on_background_error: (error) => failures.push(error)
    });
    await controller.start();

    transport.receive('{"method":"turn/started","params":{}}');
    await waitFor(() => controller.snapshot().phase === "failed");

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "protocol_failed", stage: "inbound" });
    expect(controller.snapshot()).toMatchObject({ connect_attempts: 1, admitted_generation: null });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private callback detail");
    await controller.close();
  });

  it("rejects an asynchronous inbound observer contract", async () => {
    const failures: HostDeckCodexReconnectError[] = [];
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle(),
      on_notification: (() => Promise.resolve()) as never,
      on_background_error: (error) => failures.push(error)
    });
    await controller.start();

    transport.receive('{"method":"turn/started","params":{}}');
    await waitFor(() => controller.snapshot().phase === "failed");

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "protocol_failed", stage: "inbound" });
    expect(controller.snapshot()).toMatchObject({ connect_attempts: 1, disconnect_cleanups: 1 });
    await controller.close();
  });

  it("treats a stale-generation frame as terminal and cleans up before reporting it", async () => {
    const order: string[] = [];
    const failures: HostDeckCodexReconnectError[] = [];
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle({
        disconnected(input) {
          order.push(`disconnected:${input.generation}`);
        }
      }),
      on_background_error(error) {
        order.push("reported");
        failures.push(error);
      }
    });
    await controller.start();

    transport.receiveFromGeneration('{"method":"turn/started","params":{}}', 0);
    await waitFor(() => controller.snapshot().phase === "failed");

    expect(order).toEqual(["disconnected:1", "reported"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "protocol_failed", stage: "inbound" });
    expect(controller.snapshot()).toMatchObject({ connect_attempts: 1, disconnect_cleanups: 1 });
    await controller.close();
  });

  it("returns only frozen privacy-safe public surfaces and does not retain raw causes", async () => {
    let captured: unknown;
    const transport = respondingTransport();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(transport),
      lifecycle: lifecycle({
        reconcile() {
          throw new Error("private /tmp/reconnect-secret thread-private");
        }
      })
    });
    try {
      await controller.start();
    } catch (error) {
      captured = error;
    }

    expect(Object.isFrozen(controller)).toBe(true);
    expect(captured).toBeInstanceOf(HostDeckCodexReconnectError);
    expect(captured).toMatchObject({ code: "lifecycle_failed", stage: "reconcile" });
    expect("cause" in (captured as object)).toBe(false);
    expect(String((captured as Error).message)).not.toContain("reconnect-secret");
    const snapshot = controller.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.last_failure as object)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/\/tmp|thread-private|secret/u);
    expect(Reflect.ownKeys(controller).sort()).toEqual([
      "close",
      "compatibility",
      "generation",
      "rejectServerRequest",
      "request",
      "respondToServerRequest",
      "snapshot",
      "start"
    ]);
    await controller.close();
  });

  it("cancels backoff even when an injected clock ignores the abort signal", async () => {
    const manual = manualClock();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(respondingTransport({ failInitializeAttempts: 1 })),
      clock: {
        ...manual.clock,
        sleep: () => new Promise<void>(() => undefined)
      },
      lifecycle: lifecycle()
    });
    const starting = controller.start();
    await waitFor(() => controller.snapshot().phase === "backing_off");

    await controller.close();

    await expect(starting).rejects.toMatchObject({ code: "closed", stage: "shutdown" });
    expect(controller.snapshot()).toMatchObject({ phase: "closed", connect_attempts: 1 });
  });

  it("rejects an injected clock that does not return a sleep promise", async () => {
    const manual = manualClock();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(respondingTransport({ failInitializeAttempts: 1 })),
      clock: {
        ...manual.clock,
        sleep: (() => undefined) as never
      },
      lifecycle: lifecycle()
    });

    await expect(controller.start()).rejects.toMatchObject({ code: "invalid_contract", stage: "backoff" });
    expect(controller.snapshot()).toMatchObject({ phase: "failed", connect_attempts: 1 });
    await controller.close();
  });

  it("rejects an invalid deadline clock before connecting and still closes cleanly", async () => {
    const manual = manualClock();
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(respondingTransport()),
      clock: {
        ...manual.clock,
        now: () => Number.NaN
      },
      lifecycle: lifecycle()
    });

    await expect(controller.start()).rejects.toMatchObject({ code: "invalid_contract", stage: "configuration" });
    expect(controller.snapshot()).toMatchObject({ phase: "failed", connect_attempts: 0 });
    await expect(controller.close()).resolves.toBeUndefined();
    expect(controller.snapshot().phase).toBe("closed");
  });

  it("rejects malformed configuration, repeated start, and invalid random output", async () => {
    const transport = respondingTransport();
    expect(() =>
      createCodexRuntimeReconnectController({
        ...baseOptions(transport),
        extra: true
      } as never)
    ).toThrow(HostDeckCodexReconnectError);
    expect(() =>
      createCodexRuntimeReconnectController({
        ...baseOptions(respondingTransport()),
        resource_budget: { ...defaultResourceBudget }
      })
    ).toThrow("complete resolved resource budget");
    const accessor = baseOptions(respondingTransport()) as Record<string, unknown>;
    Object.defineProperty(accessor, "random", { get: () => () => 0 });
    expect(() => createCodexRuntimeReconnectController(accessor as never)).toThrow("data property");
    const unreadableTransport = respondingTransport();
    Object.defineProperty(unreadableTransport, "state", {
      configurable: true,
      get() {
        throw new Error("private transport property");
      }
    });
    expect(() =>
      createCodexRuntimeReconnectController({
        ...baseOptions(unreadableTransport),
        transport: unreadableTransport
      })
    ).toThrow("properties are not readable");
    const mismatchedTransport = new ScriptedCodexTransport({ max_frame_bytes: 1_024 });
    expect(() => createCodexRuntimeReconnectController(baseOptions(mismatchedTransport))).toThrow(
      "frame bound must match"
    );
    expect(() =>
      createCodexRuntimeReconnectController({
        ...baseOptions(respondingTransport()),
        client_version: ""
      })
    ).toThrow("non-empty string");

    const signalController = createCodexRuntimeReconnectController({
      ...baseOptions(respondingTransport()),
      lifecycle: lifecycle()
    });
    await expect(
      signalController.start({
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      } as never)
    ).rejects.toMatchObject({ code: "invalid_contract", stage: "configuration" });
    await expect(signalController.start()).resolves.toMatchObject({ generation: 1 });
    await signalController.close();

    const manual = manualClock();
    const retrying = createCodexRuntimeReconnectController({
      ...baseOptions(respondingTransport({ failInitializeAttempts: 1 })),
      clock: manual.clock,
      random: () => 1,
      lifecycle: lifecycle()
    });
    const starting = retrying.start();
    await expect(retrying.start()).rejects.toMatchObject({ code: "lifecycle_conflict" });
    await expect(starting).rejects.toMatchObject({ code: "invalid_contract", stage: "backoff" });
    await retrying.close();
  });

  it("supports idempotent close before start and rejects later startup", async () => {
    const controller = createCodexRuntimeReconnectController({
      ...baseOptions(respondingTransport()),
      lifecycle: lifecycle()
    });
    const first = controller.close();
    const second = controller.close();
    expect(first).toBe(second);
    await first;
    await expect(controller.start()).rejects.toMatchObject({ code: "lifecycle_conflict" });
    expect(controller.snapshot().phase).toBe("closed");
  });
});

function baseOptions(
  transport: ScriptedCodexTransport,
  overrides: Parameters<typeof resolveResourceBudget>[0] = {}
) {
  return {
    transport,
    observed_version: "0.144.0",
    resource_budget: resolveResourceBudget(overrides),
    lifecycle: lifecycle(),
    on_background_error: () => undefined
  };
}

function lifecycle(
  overrides: Partial<CodexReconnectLifecyclePort> = {}
): CodexReconnectLifecyclePort {
  return {
    disconnected: overrides.disconnected ?? (() => undefined),
    reconcile: overrides.reconcile ?? (() => ({ continuity: "continuous" })),
    resubscribe: overrides.resubscribe ?? (() => undefined),
    ready: overrides.ready ?? (() => undefined)
  };
}

function respondingTransport(options: { readonly failInitializeAttempts?: number } = {}): ScriptedCodexTransport {
  let remainingInitializeFailures = options.failInitializeAttempts ?? 0;
  return new ScriptedCodexTransport({
    on_send(text, transport) {
      const message = JSON.parse(text) as {
        readonly id?: number;
        readonly method?: string;
        readonly params?: Record<string, unknown>;
      };
      if (message.method === "initialize") {
        if (remainingInitializeFailures > 0) {
          remainingInitializeFailures -= 1;
          transport.disconnect("scripted handshake loss");
          return;
        }
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
        return;
      }
      if (message.method === "collaborationMode/list") {
        transport.receive(
          JSON.stringify({
            id: message.id,
            result: { data: [{ name: "Default" }, { name: "Plan" }] }
          })
        );
        return;
      }
      if (message.method === "thread/list" && message.params?.hold !== true) {
        transport.receive(JSON.stringify({ id: message.id, result: { data: [] } }));
        return;
      }
      if (message.method === "thread/resume") {
        transport.receive(JSON.stringify({ id: message.id, result: { thread: { id: "thread-a" } } }));
      }
    }
  });
}

function manualClock(): {
  readonly clock: CodexReconnectClock;
  readonly sleepDelays: number[];
  readonly pendingSleeps: number;
  readonly advance: (milliseconds: number) => void;
  readonly releaseSleep: () => void;
} {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  const sleeps: Array<{
    readonly delay: number;
    readonly signal: AbortSignal;
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
    readonly abort: () => void;
  }> = [];
  const sleepDelays: number[] = [];
  const advance = (milliseconds: number) => {
    now += milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      const next = due[0];
      if (next === undefined) break;
      timers.delete(next[0]);
      next[1].callback();
    }
  };
  const clock: CodexReconnectClock = {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    sleep(delay, signal) {
      sleepDelays.push(delay);
      return new Promise<void>((resolve, reject) => {
        const entry = {
          delay,
          signal,
          resolve: () => {
            signal.removeEventListener("abort", entry.abort);
            const index = sleeps.indexOf(entry);
            if (index >= 0) sleeps.splice(index, 1);
            resolve();
          },
          reject: (reason: unknown) => {
            signal.removeEventListener("abort", entry.abort);
            const index = sleeps.indexOf(entry);
            if (index >= 0) sleeps.splice(index, 1);
            reject(reason);
          },
          abort: () => entry.reject(signal.reason)
        };
        sleeps.push(entry);
        signal.addEventListener("abort", entry.abort, { once: true });
        if (signal.aborted) entry.abort();
      });
    }
  };
  return {
    clock,
    sleepDelays,
    get pendingSleeps() {
      return sleeps.length;
    },
    advance,
    releaseSleep() {
      const sleep = sleeps[0];
      if (sleep === undefined) throw new Error("No reconnect sleep is pending.");
      advance(sleep.delay);
      sleep.resolve();
    }
  };
}

function sentMethods(transport: ScriptedCodexTransport): string[] {
  return transport.sent_frames.flatMap((frame) => {
    const method = (JSON.parse(frame) as { readonly method?: unknown }).method;
    return typeof method === "string" ? [method] : [];
  });
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: string,
  outcome: string,
  retrySafe: boolean
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code, outcome, retry_safe: retrySafe });
    return;
  }
  throw new Error(`Expected adapter error ${code}.`);
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
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for reconnect test condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
