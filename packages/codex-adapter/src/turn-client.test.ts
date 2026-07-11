import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { type CodexTurnRequestPort, createCodexTurnClient } from "./turn-client.js";

const checkedAt = "2026-07-10T22:00:00.000Z";

describe("Codex turn client", () => {
  it("starts inherited, model, and collaboration turns through exact non-contradictory params", async () => {
    const port = fakePort(() => acceptedTurn("turn-accepted"));
    const client = createCodexTurnClient(port);

    await client.startTurn({
      operation_id: "op_turn_inherit_0001",
      thread_id: "thread-turn-a",
      text: "Continue the current task.",
      settings: { kind: "inherit" }
    });
    await client.startTurn({
      operation_id: "op_turn_model_0001",
      thread_id: "thread-turn-a",
      text: "Use the selected model.",
      settings: { kind: "model", runtime_model: "runtime-a", reasoning_effort: "high" }
    });
    await client.startTurn({
      operation_id: "op_turn_plan_0001",
      thread_id: "thread-turn-a",
      text: "Create a plan.",
      settings: { kind: "collaboration", mode: "plan", runtime_model: "runtime-b", reasoning_effort: "low" }
    });

    const [inherited, model, plan] = port.requests.map((request) => request.params as Record<string, unknown>);
    expect(inherited).not.toHaveProperty("model");
    expect(inherited).not.toHaveProperty("effort");
    expect(inherited).not.toHaveProperty("collaborationMode");
    expect(model).toMatchObject({ model: "runtime-a", effort: "high" });
    expect(model).not.toHaveProperty("collaborationMode");
    expect(plan).toMatchObject({
      collaborationMode: {
        mode: "plan",
        settings: { model: "runtime-b", reasoning_effort: "low", developer_instructions: null }
      }
    });
    expect(plan).not.toHaveProperty("model");
    expect(plan).not.toHaveProperty("effort");
  });

  it("steers only the exact expected active turn and validates the response id", async () => {
    const port = fakePort((request) => {
      if (request.method !== "turn/steer") throw new Error("unexpected request");
      return { turnId: (request.params as Record<string, unknown>).expectedTurnId };
    });
    const steered = await createCodexTurnClient(port).steerTurn({
      operation_id: "op_turn_steer_0001",
      thread_id: "thread-turn-a",
      expected_turn_id: "turn-active-a",
      text: "Keep working on this same turn."
    });
    expect(steered).toEqual({ thread_id: "thread-turn-a", turn_id: "turn-active-a", state: "accepted" });
    expect(port.requests[0]).toMatchObject({
      method: "turn/steer",
      kind: "mutation",
      params: {
        threadId: "thread-turn-a",
        expectedTurnId: "turn-active-a",
        clientUserMessageId: "op_turn_steer_0001"
      }
    });

    const mismatch = createCodexTurnClient(fakePort(() => ({ turnId: "turn-other" })));
    await expect(
      mismatch.steerTurn({
        operation_id: "op_turn_steer_0002",
        thread_id: "thread-turn-a",
        expected_turn_id: "turn-active-a",
        text: "This response must match."
      })
    ).rejects.toMatchObject({ code: "invalid_protocol_message", outcome: "not_applicable" });
  });

  it("interrupts only the exact turn and accepts only the empty response", async () => {
    const port = fakePort((request) => {
      if (request.method !== "turn/interrupt") throw new Error("unexpected request");
      return {};
    });
    const interrupted = await createCodexTurnClient(port).interruptTurn({
      operation_id: "op_turn_interrupt_0001",
      thread_id: "thread-turn-a",
      turn_id: "turn-active-a"
    });

    expect(interrupted).toEqual({ thread_id: "thread-turn-a", turn_id: "turn-active-a", state: "accepted" });
    expect(port.requests).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "thread-turn-a", turnId: "turn-active-a" },
        kind: "mutation",
        timeout_ms: 15_000
      }
    ]);

    const malformed = createCodexTurnClient(fakePort(() => ({ accepted: true })));
    await expect(
      malformed.interruptTurn({
        operation_id: "op_turn_interrupt_0002",
        thread_id: "thread-turn-a",
        turn_id: "turn-active-a"
      })
    ).rejects.toMatchObject({ code: "invalid_protocol_message", outcome: "not_applicable" });
    await expect(
      createCodexTurnClient(fakePort(() => new Date(0))).interruptTurn({
        operation_id: "op_turn_interrupt_0003",
        thread_id: "thread-turn-a",
        turn_id: "turn-active-a"
      })
    ).rejects.toMatchObject({ code: "invalid_protocol_message", outcome: "not_applicable" });
  });

  it("rejects malformed inputs, settings, and accepted responses", async () => {
    const client = createCodexTurnClient(fakePort(() => acceptedTurn("turn-a")));
    await expect(
      client.startTurn({
        operation_id: "bad",
        thread_id: "thread-turn-a",
        text: "Prompt",
        settings: { kind: "inherit" }
      })
    ).rejects.toMatchObject({ outcome: "not_sent" });
    await expect(
      client.startTurn({
        operation_id: "op_turn_invalid_0001",
        thread_id: "thread-turn-a",
        text: "Prompt",
        settings: { kind: "model", runtime_model: " runtime-a", reasoning_effort: "high" }
      })
    ).rejects.toMatchObject({ outcome: "not_sent" });
    await expect(
      createCodexTurnClient(fakePort(() => ({ turn: { ...acceptedTurn("turn-a").turn, status: "completed" } }))).startTurn({
        operation_id: "op_turn_invalid_0002",
        thread_id: "thread-turn-a",
        text: "Prompt",
        settings: { kind: "inherit" }
      })
    ).rejects.toMatchObject({ outcome: "not_applicable" });
  });

  it("rejects non-object, extra-field, and invalid-signal inputs before the wire", async () => {
    const port = fakePort(() => acceptedTurn("turn-a"));
    const client = createCodexTurnClient(port);
    await expect(client.startTurn(null as never)).rejects.toMatchObject({ outcome: "not_sent" });
    await expect(
      client.startTurn({
        operation_id: "op_turn_invalid_shape_0001",
        thread_id: "thread-turn-a",
        text: "Prompt",
        settings: { kind: "inherit" },
        extra: true
      } as never)
    ).rejects.toMatchObject({ outcome: "not_sent" });
    await expect(
      client.steerTurn({
        operation_id: "op_turn_invalid_shape_0002",
        thread_id: "thread-turn-a",
        expected_turn_id: "turn-active-a",
        text: "Steer",
        signal: {}
      } as never)
    ).rejects.toMatchObject({ outcome: "not_sent" });
    await expect(
      client.interruptTurn({
        operation_id: "op_turn_invalid_shape_0003",
        thread_id: "thread-turn-a",
        turn_id: "turn-active-a",
        confirm: true
      } as never)
    ).rejects.toMatchObject({ outcome: "not_sent" });
    expect(port.requests).toHaveLength(0);
  });

  it("fails closed for unavailable or disconnected turn capabilities", async () => {
    for (const capabilityState of ["unavailable", "unknown"] as const) {
      for (const capability of ["turn_input", "turn_interrupt", "turn_steer"] as const) {
        const port = fakePort(() => acceptedTurn("turn-a"), compatibilityWithState(capability, capabilityState));
        const client = createCodexTurnClient(port);
        const operation =
          capability === "turn_input"
            ? client.startTurn({
                operation_id: "op_turn_capability_0001",
                thread_id: "thread-turn-a",
                text: "Prompt",
                settings: { kind: "inherit" }
              })
            : capability === "turn_steer"
              ? client.steerTurn({
                operation_id: "op_turn_capability_0002",
                thread_id: "thread-turn-a",
                expected_turn_id: "turn-active-a",
                text: "Steer"
                })
              : client.interruptTurn({
                  operation_id: "op_turn_capability_0003",
                  thread_id: "thread-turn-a",
                  turn_id: "turn-active-a"
                });
        await expect(operation).rejects.toBeInstanceOf(HostDeckCodexAdapterError);
        expect(port.requests).toHaveLength(0);
      }
    }

    const disconnected = fakePort(() => acceptedTurn("turn-a"), disconnectedCompatibility());
    await expect(
      createCodexTurnClient(disconnected).startTurn({
        operation_id: "op_turn_disconnected_0001",
        thread_id: "thread-turn-a",
        text: "Prompt",
        settings: { kind: "inherit" }
      })
    ).rejects.toMatchObject({ code: "handshake_failed", outcome: "not_sent" });
    expect(disconnected.requests).toHaveLength(0);

    const mutationBlocked = { ...readyCompatibility(), state: "degraded", mutation_policy: "blocked" } as RuntimeCompatibility;
    const blocked = fakePort(() => ({}), mutationBlocked);
    await expect(
      createCodexTurnClient(blocked).interruptTurn({
        operation_id: "op_turn_mutation_blocked_0001",
        thread_id: "thread-turn-a",
        turn_id: "turn-active-a"
      })
    ).rejects.toMatchObject({ code: "handshake_failed", outcome: "not_sent" });
    expect(blocked.requests).toHaveLength(0);
  });

  it("validates start and steer timeout options", () => {
    expect(() => createCodexTurnClient(fakePort(() => ({})), { start_timeout_ms: 1 })).toThrow();
    expect(() => createCodexTurnClient(fakePort(() => ({})), { steer_timeout_ms: 1 })).toThrow();
    expect(() => createCodexTurnClient(fakePort(() => ({})), { interrupt_timeout_ms: 1 })).toThrow();
    expect(() => createCodexTurnClient(fakePort(() => ({})), { extra: true } as never)).toThrow();
    expect(() => createCodexTurnClient(fakePort(() => ({})), null as never)).toThrow();
    expect(() => createCodexTurnClient(null as never)).toThrow();
  });
});

interface FakePort extends CodexTurnRequestPort {
  readonly requests: CodexRequestInput[];
}

function fakePort(handler: (request: CodexRequestInput) => unknown | Promise<unknown>, compatibility = readyCompatibility()): FakePort {
  const requests: CodexRequestInput[] = [];
  return {
    compatibility,
    requests,
    async request(input) {
      requests.push(input);
      return handler(input);
    }
  };
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: checkedAt,
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function compatibilityWithState(
  name: "turn_input" | "turn_interrupt" | "turn_steer",
  state: "unavailable" | "unknown"
): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === name ? { ...capability, state, reason: "test capability state" } : capability
    )
  };
}

function disconnectedCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: checkedAt,
    handshake: { state: "not_attempted" }
  });
}

function acceptedTurn(id: string) {
  return {
    turn: {
      id,
      status: "inProgress",
      error: null,
      completedAt: null,
      durationMs: null,
      items: [],
      itemsView: "full",
      startedAt: null
    }
  };
}
