import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { type CodexGoalRequestPort, createCodexGoalClient } from "./goal-client.js";

const checkedAt = "2026-07-10T18:00:00.000Z";

describe("normalized Codex goal client", () => {
  it("reads absent and full goal state without starting work", async () => {
    const absent = fakePort((request) => {
      expect(request).toMatchObject({
        method: "thread/goal/get",
        kind: "read",
        timeout_ms: 10_000,
        params: { threadId: "thread-a" }
      });
      return { goal: null };
    });
    await expect(createCodexGoalClient(absent).read("thread-a")).resolves.toBeNull();

    const present = fakePort(() => ({ goal: rawGoal() }));
    const first = await createCodexGoalClient(present).read("thread-a");
    const second = await createCodexGoalClient(present).read("thread-a");
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      thread_id: "thread-a",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      objective: "Complete the selected task.",
      status: "paused",
      token_budget: 10_000,
      tokens_used: 500,
      time_used_seconds: 12.5,
      created_at: "2026-07-10T17:00:00.000Z",
      updated_at: "2026-07-10T17:01:00.000Z"
    });

    const usageOnly = await createCodexGoalClient(
      fakePort(() => ({
        goal: rawGoal({
          tokensUsed: 900,
          timeUsedSeconds: 30,
          updatedAt: unixSeconds("2026-07-10T17:02:00.000Z")
        })
      }))
    ).read("thread-a");
    const statusChanged = await createCodexGoalClient(fakePort(() => ({ goal: rawGoal({ status: "active" }) }))).read(
      "thread-a"
    );
    expect(usageOnly?.revision).toBe(first?.revision);
    expect(statusChanged?.revision).not.toBe(first?.revision);
  });

  it("sets a new goal as passive paused state and verifies the returned objective", async () => {
    const port = fakePort((request) => {
      expect(request).toMatchObject({
        method: "thread/goal/set",
        kind: "mutation",
        timeout_ms: 15_000,
        params: {
          threadId: "thread-a",
          objective: "Complete V1.",
          status: "paused"
        }
      });
      return { goal: rawGoal({ objective: "Complete V1.", status: "paused" }) };
    });

    await expect(createCodexGoalClient(port).setPaused("thread-a", "  Complete V1.  ")).resolves.toMatchObject({
      objective: "Complete V1.",
      status: "paused"
    });
  });

  it.each(["active", "paused", "complete"] as const)("sets exact %s status without an objective override", async (status) => {
    const port = fakePort((request) => {
      expect(request.params).toEqual({ threadId: "thread-a", status });
      return { goal: rawGoal({ status }) };
    });
    await expect(createCodexGoalClient(port).setStatus("thread-a", status)).resolves.toMatchObject({ status });
  });

  it("returns the exact clear acknowledgement", async () => {
    const port = fakePort((request) => {
      expect(request).toMatchObject({ method: "thread/goal/clear", kind: "mutation", params: { threadId: "thread-a" } });
      return { cleared: true };
    });
    await expect(createCodexGoalClient(port).clear("thread-a")).resolves.toBe(true);
  });

  it.each([
    ["different thread", { threadId: "thread-b" }],
    ["unknown status", { status: "future" }],
    ["reversed timestamps", { updatedAt: unixSeconds("2026-07-10T16:59:00.000Z") }],
    ["fractional token count", { tokensUsed: 1.5 }],
    ["negative time", { timeUsedSeconds: -1 }],
    ["unexpected field", { future: true }]
  ])("rejects %s in a goal payload", async (_label, override) => {
    await expectAdapterError(
      createCodexGoalClient(fakePort(() => ({ goal: rawGoal(override) }))).read("thread-a"),
      "invalid_protocol_message"
    );
  });

  it("rejects contradictory mutation responses and malformed clear acknowledgements", async () => {
    await expectAdapterError(
      createCodexGoalClient(fakePort(() => ({ goal: rawGoal({ status: "active" }) }))).setPaused("thread-a", "Pause this."),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexGoalClient(fakePort(() => ({ cleared: "yes" }))).clear("thread-a"),
      "invalid_protocol_message"
    );
  });

  it("keeps unsupported capability, disconnected runtime, and invalid bounds distinct", async () => {
    await expectAdapterError(
      createCodexGoalClient(fakePort(() => undefined, compatibilityWithGoalState("unavailable"))).read("thread-a"),
      "unsupported_method"
    );
    await expectAdapterError(
      createCodexGoalClient(fakePort(() => undefined, disconnectedCompatibility())).read("thread-a"),
      "handshake_failed"
    );
    expect(() => createCodexGoalClient(fakePort(() => undefined), { mutation_timeout_ms: 0 })).toThrow(
      HostDeckCodexAdapterError
    );
  });
});

interface FakePort extends CodexGoalRequestPort {
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

function compatibilityWithGoalState(state: "unavailable" | "unknown"): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === "goal" ? { ...capability, state, reason: "test capability state" } : capability
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

function rawGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: "thread-a",
    objective: "Complete the selected task.",
    status: "paused",
    tokenBudget: 10_000,
    tokensUsed: 500,
    timeUsedSeconds: 12.5,
    createdAt: unixSeconds("2026-07-10T17:00:00.000Z"),
    updatedAt: unixSeconds("2026-07-10T17:01:00.000Z"),
    ...overrides
  };
}

function unixSeconds(value: string): number {
  return Date.parse(value) / 1_000;
}

async function expectAdapterError(promise: Promise<unknown>, code: HostDeckCodexAdapterError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
