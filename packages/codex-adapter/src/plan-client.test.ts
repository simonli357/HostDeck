import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexPlanRequestPort,
  createCodexPlanClient
} from "./plan-client.js";

const checkedAt = "2026-07-10T20:00:00.000Z";

describe("Codex Plan client", () => {
  it("normalizes one bounded exact Plan/Default catalog with a stable revision", async () => {
    const port = fakePort(() => ({ data: [rawMask("Plan", "plan", null, "medium"), rawMask("Default", "default")] }));
    const client = createCodexPlanClient(port, { now: () => checkedAt });

    const first = await client.listCatalog();
    const second = await client.listCatalog();

    expect(first).toEqual({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      observed_at: checkedAt,
      modes: [
        { name: "Plan", mode: "plan", preset_model: null, preset_reasoning_effort: "medium" },
        { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null }
      ]
    });
    expect(second.revision).toBe(first.revision);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.modes)).toBe(true);
    expect(port.requests).toEqual([
      expect.objectContaining({ method: "collaborationMode/list", params: {}, kind: "read" }),
      expect.objectContaining({ method: "collaborationMode/list", params: {}, kind: "read" })
    ]);
  });

  it("resolves a null protocol mode only from an exact Plan or Default name", async () => {
    const client = createCodexPlanClient(
      fakePort(() => ({ data: [rawMask("Plan", null), rawMask("Default", null)] })),
      { now: () => checkedAt }
    );
    expect((await client.listCatalog()).modes.map((entry) => entry.mode)).toEqual(["plan", "default"]);
  });

  it("rejects missing, duplicate, contradictory, padded, and oversized catalog entries", async () => {
    const invalidCatalogs = [
      [rawMask("Plan", "plan")],
      [rawMask("Plan", "plan"), rawMask("Plan copy", "plan")],
      [rawMask("Default", "plan"), rawMask("Plan", "default")],
      [rawMask(" Plan", null), rawMask("Default", "default")],
      [rawMask("Unknown", null), rawMask("Default", "default")],
      [rawMask("Plan", "plan"), rawMask("Default", "default"), rawMask("Extra", "plan")]
    ];
    for (const data of invalidCatalogs) {
      await expect(createCodexPlanClient(fakePort(() => ({ data })), { now: () => checkedAt }).listCatalog()).rejects.toMatchObject({
        code: "invalid_protocol_message",
        outcome: "not_applicable"
      });
    }

    const oversized = Array.from({ length: 9 }, (_, index) => rawMask(index === 0 ? "Plan" : `Default ${index}`, index === 0 ? "plan" : "default"));
    await expect(createCodexPlanClient(fakePort(() => ({ data: oversized })), { now: () => checkedAt }).listCatalog()).rejects.toBeInstanceOf(
      HostDeckCodexAdapterError
    );
  });

  it("sends collaboration settings without contradictory top-level model or effort fields", async () => {
    const port = fakePort((request) => {
      if (request.method !== "turn/start") throw new Error("unexpected request");
      return acceptedTurn("turn-plan-1");
    });
    const client = createCodexPlanClient(port);
    const accepted = await client.startTurn({
      operation_id: "op_plan_turn_0001",
      thread_id: "thread-plan-a",
      text: "Produce a two-step implementation plan.",
      mode: { name: "Plan", mode: "plan", preset_model: null, preset_reasoning_effort: "medium" },
      runtime_model: "runtime-selected",
      reasoning_effort: "low"
    });

    expect(accepted).toEqual({ thread_id: "thread-plan-a", turn_id: "turn-plan-1", state: "accepted" });
    expect(port.requests).toHaveLength(1);
    const params = port.requests[0]?.params as Record<string, unknown>;
    expect(params).toMatchObject({
      threadId: "thread-plan-a",
      clientUserMessageId: "op_plan_turn_0001",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "runtime-selected",
          reasoning_effort: "low",
          developer_instructions: null
        }
      }
    });
    expect(params).not.toHaveProperty("model");
    expect(params).not.toHaveProperty("effort");
  });

  it("preserves an explicit null collaboration effort", async () => {
    const port = fakePort(() => acceptedTurn("turn-default-1"));
    const client = createCodexPlanClient(port);
    await client.startTurn({
      operation_id: "op_plan_turn_0002",
      thread_id: "thread-plan-a",
      text: "Continue in Default mode.",
      mode: { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null },
      runtime_model: "runtime-a",
      reasoning_effort: null
    });
    expect(port.requests[0]?.params).toMatchObject({
      collaborationMode: { mode: "default", settings: { model: "runtime-a", reasoning_effort: null } }
    });
  });

  it("rejects invalid input and malformed accepted-turn responses", async () => {
    const invalid = createCodexPlanClient(fakePort(() => acceptedTurn("turn-plan-1")));
    await expect(
      invalid.startTurn({
        operation_id: "bad",
        thread_id: "thread-plan-a",
        text: "/plan",
        mode: { name: "Plan", mode: "plan", preset_model: null, preset_reasoning_effort: null },
        runtime_model: "runtime-a",
        reasoning_effort: null
      })
    ).rejects.toMatchObject({ outcome: "not_sent" });

    const malformed = createCodexPlanClient(fakePort(() => ({ turn: { ...acceptedTurn("turn-plan-1").turn, status: "completed" } })));
    await expect(
      malformed.startTurn({
        operation_id: "op_plan_turn_0003",
        thread_id: "thread-plan-a",
        text: "Plan the next task.",
        mode: { name: "Plan", mode: "plan", preset_model: null, preset_reasoning_effort: null },
        runtime_model: "runtime-a",
        reasoning_effort: null
      })
    ).rejects.toMatchObject({ code: "invalid_protocol_message", outcome: "not_applicable" });
  });

  it("fails closed for unavailable, unknown, and disconnected Plan capability", async () => {
    for (const compatibility of [compatibilityWithPlanState("unavailable"), compatibilityWithPlanState("unknown"), disconnectedCompatibility()]) {
      const port = fakePort(() => ({ data: [] }), compatibility);
      const client = createCodexPlanClient(port);
      expect(() => client.runtime_version).toThrow(HostDeckCodexAdapterError);
      await expect(client.listCatalog()).rejects.toBeInstanceOf(HostDeckCodexAdapterError);
      expect(port.requests).toHaveLength(0);
    }
  });

  it("validates resource options before making a request", () => {
    expect(() => createCodexPlanClient(fakePort(() => ({ data: [] })), { max_entries: 1 })).toThrow();
    expect(() => createCodexPlanClient(fakePort(() => ({ data: [] })), { read_timeout_ms: 1 })).toThrow();
    expect(() => createCodexPlanClient(fakePort(() => ({ data: [] })), { now: "bad" as never })).toThrow();
  });
});

interface FakePort extends CodexPlanRequestPort {
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

function compatibilityWithPlanState(state: "unavailable" | "unknown"): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === "plan" ? { ...capability, state, reason: "test capability state" } : capability
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

function rawMask(name: string, mode: "plan" | "default" | null, model: string | null = null, effort: string | null = null) {
  return { name, mode, model, reasoning_effort: effort };
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
