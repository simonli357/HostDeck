import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexUsageRequestPort,
  createCodexUsageClient
} from "./usage-client.js";

const observedAt = "2026-07-11T17:00:00.000Z";

describe("normalized Codex usage client", () => {
  it("sends one exact no-param read and freezes bounded account usage", async () => {
    const controller = new AbortController();
    const port = fakePort((request) => {
      expect(request).toEqual({
        method: "account/usage/read",
        params: undefined,
        kind: "read",
        timeout_ms: 4_000,
        signal: controller.signal
      });
      return rawUsage();
    });
    const client = createCodexUsageClient(port, {
      max_daily_buckets: 2,
      read_timeout_ms: 4_000,
      now: () => observedAt
    });

    const result = await client.readAccount(controller.signal);
    expect(result).toEqual({
      runtime_version: "0.144.0",
      connection_generation: 3,
      observed_at: observedAt,
      account: {
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
      }
    });
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.account)).toBe(true);
    expect(Object.isFrozen(result.account.daily_buckets)).toBe(true);
    expect(port.requests).toHaveLength(1);
  });

  it("preserves null versus empty daily history", async () => {
    const nullResult = await createCodexUsageClient(
      fakePort(() => rawUsage({ dailyUsageBuckets: null })),
      { now: () => observedAt }
    ).readAccount();
    const emptyResult = await createCodexUsageClient(
      fakePort(() => rawUsage({ dailyUsageBuckets: [] })),
      { now: () => observedAt }
    ).readAccount();

    expect(nullResult.account.daily_buckets).toBeNull();
    expect(emptyResult.account.daily_buckets).toEqual([]);
  });

  it("rejects extra/missing fields, unsafe counters, dates, ordering, and contradictions", async () => {
    const malformed = [
      { ...rawUsage(), extra: true },
      { summary: rawSummary() },
      rawUsage({ summary: { ...rawSummary(), extra: true } }),
      rawUsage({ summary: { ...rawSummary(), lifetimeTokens: Number.MAX_SAFE_INTEGER + 1 } }),
      rawUsage({ summary: { ...rawSummary(), currentStreakDays: 5, longestStreakDays: 4 } }),
      rawUsage({ dailyUsageBuckets: [{ startDate: "2026-02-30", tokens: 1 }] }),
      rawUsage({
        dailyUsageBuckets: [
          { startDate: "2026-07-10", tokens: 1 },
          { startDate: "2026-07-10", tokens: 1 }
        ]
      }),
      rawUsage({ dailyUsageBuckets: [{ startDate: "2026-07-10", tokens: 101 }] })
    ];

    for (const candidate of malformed) {
      await expectAdapterError(
        createCodexUsageClient(fakePort(() => candidate), { now: () => observedAt }).readAccount(),
        "invalid_protocol_message"
      );
    }
  });

  it("rejects an oversized bucket collection before normalizing it", async () => {
    const port = fakePort(() =>
      rawUsage({
        dailyUsageBuckets: [
          { startDate: "2026-07-08", tokens: 25 },
          { startDate: "2026-07-09", tokens: 50 },
          { startDate: "2026-07-10", tokens: 100 }
        ]
      })
    );
    await expectAdapterError(
      createCodexUsageClient(port, { max_daily_buckets: 2, now: () => observedAt }).readAccount(),
      "broker_overloaded"
    );
    expect(port.requests).toHaveLength(1);
  });

  it("fails a read when the connection generation changes and never retries", async () => {
    const port = fakePort(() => {
      port.currentGeneration += 1;
      return rawUsage();
    });
    await expectAdapterError(
      createCodexUsageClient(port, { now: () => observedAt }).readAccount(),
      "transport_closed"
    );
    expect(port.requests).toHaveLength(1);
  });

  it("keeps unavailable capability, disconnected runtime, and invalid generation distinct", async () => {
    const unavailable = fakePort(() => rawUsage(), compatibilityWithUsageState("unavailable"));
    await expectAdapterError(createCodexUsageClient(unavailable).readAccount(), "unsupported_method");
    expect(unavailable.requests).toHaveLength(0);

    const disconnected = fakePort(() => rawUsage(), disconnectedCompatibility());
    await expectAdapterError(createCodexUsageClient(disconnected).readAccount(), "handshake_failed");
    expect(disconnected.requests).toHaveLength(0);

    const invalidGeneration = fakePort(() => rawUsage());
    invalidGeneration.currentGeneration = 0;
    await expectAdapterError(createCodexUsageClient(invalidGeneration).readAccount(), "protocol_violation");
    expect(invalidGeneration.requests).toHaveLength(0);
  });

  it("validates exact options and propagates abort/timeout without a fallback read", async () => {
    const port = fakePort(() => {
      throw new HostDeckCodexAdapterError("request_timeout", "read timed out", {
        outcome: "not_applicable",
        retry_safe: true
      });
    });
    await expectAdapterError(createCodexUsageClient(port).readAccount(), "request_timeout");
    expect(port.requests).toHaveLength(1);

    expect(() => createCodexUsageClient(fakePort(() => rawUsage()), { max_daily_buckets: 0 })).toThrow(
      HostDeckCodexAdapterError
    );
    expect(() => createCodexUsageClient(fakePort(() => rawUsage()), { unknown: true } as never)).toThrow(
      HostDeckCodexAdapterError
    );
    expect(() => createCodexUsageClient(null as never)).toThrow(TypeError);
  });
});

interface FakePort extends CodexUsageRequestPort {
  readonly requests: CodexRequestInput[];
  currentGeneration: number;
}

function fakePort(
  handler: (request: CodexRequestInput) => unknown | Promise<unknown>,
  compatibility = readyCompatibility()
): FakePort {
  const requests: CodexRequestInput[] = [];
  const port: FakePort = {
    compatibility,
    currentGeneration: 3,
    get generation() {
      return port.currentGeneration;
    },
    requests,
    async request(input) {
      requests.push(input);
      return handler(input);
    }
  };
  return port;
}

function rawUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: rawSummary(),
    dailyUsageBuckets: [
      { startDate: "2026-07-09", tokens: 50 },
      { startDate: "2026-07-10", tokens: 100 }
    ],
    ...overrides
  };
}

function rawSummary(): Record<string, unknown> {
  return {
    lifetimeTokens: 1_000,
    peakDailyTokens: 100,
    longestRunningTurnSec: 30,
    currentStreakDays: 2,
    longestStreakDays: 4
  };
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: observedAt,
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function compatibilityWithUsageState(state: "unavailable" | "unknown"): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === "usage" ? { ...capability, state, reason: "test usage capability" } : capability
    )
  };
}

function disconnectedCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: observedAt,
    handshake: { state: "not_attempted" }
  });
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: HostDeckCodexAdapterError["code"]
): Promise<HostDeckCodexAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexAdapterError;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
