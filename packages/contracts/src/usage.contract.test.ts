import { describe, expect, it } from "vitest";
import {
  usageAccountSnapshotSchema,
  usageCalendarDateSchema,
  usageSnapshotSchema,
  usageThreadObservationSchema,
  usageTokenBreakdownSchema
} from "./selected-operations.js";

const measuredAt = "2026-07-11T16:00:00.000Z";

describe("selected usage contracts", () => {
  it("accepts one exact account/thread/runtime snapshot without monetary inference", () => {
    const parsed = usageSnapshotSchema.parse(snapshotCandidate());

    expect(parsed).toMatchObject({
      target: { session_id: "sess_usage_a", codex_thread_id: "thread-usage-a" },
      runtime_version: "0.144.0",
      connection_generation: 4,
      account: { scope: "account" },
      thread: { state: "observed", scope: "thread", turn_id: "turn-usage-a" },
      rate_limits: { state: "observed", scope: "runtime" }
    });
    expect(parsed).not.toHaveProperty("cost");
    expect(parsed).not.toHaveProperty("monetary_cost");
  });

  it("distinguishes null daily history, empty daily history, and absent observations", () => {
    expect(usageAccountSnapshotSchema.parse({ ...snapshotCandidate().account, daily_buckets: null }).daily_buckets).toBeNull();
    expect(usageAccountSnapshotSchema.parse({ ...snapshotCandidate().account, daily_buckets: [] }).daily_buckets).toEqual([]);
    expect(
      usageSnapshotSchema.parse({
        ...snapshotCandidate(),
        thread: { state: "not_observed", scope: "thread" },
        rate_limits: { state: "not_observed", scope: "runtime" }
      })
    ).toMatchObject({
      thread: { state: "not_observed" },
      rate_limits: { state: "not_observed" }
    });
  });

  it("rejects normalized or impossible calendar dates and non-ascending buckets", () => {
    for (const candidate of ["2026-02-30", "2026-2-03", "2026-13-01", "not-a-date"]) {
      expect(usageCalendarDateSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      usageAccountSnapshotSchema.safeParse({
        ...snapshotCandidate().account,
        daily_buckets: [
          { start_date: "2026-07-10", tokens: 10 },
          { start_date: "2026-07-10", tokens: 5 }
        ]
      }).success
    ).toBe(false);
    expect(
      usageAccountSnapshotSchema.safeParse({
        ...snapshotCandidate().account,
        daily_buckets: [
          { start_date: "2026-07-11", tokens: 10 },
          { start_date: "2026-07-10", tokens: 5 }
        ]
      }).success
    ).toBe(false);
  });

  it("rejects unsafe or internally contradictory account counters", () => {
    expect(
      usageAccountSnapshotSchema.safeParse({
        ...snapshotCandidate().account,
        summary: { ...snapshotCandidate().account.summary, lifetime_tokens: Number.MAX_SAFE_INTEGER + 1 }
      }).success
    ).toBe(false);
    expect(
      usageAccountSnapshotSchema.safeParse({
        ...snapshotCandidate().account,
        summary: { ...snapshotCandidate().account.summary, current_streak_days: 8, longest_streak_days: 7 }
      }).success
    ).toBe(false);
    expect(
      usageAccountSnapshotSchema.safeParse({
        ...snapshotCandidate().account,
        daily_buckets: [{ start_date: "2026-07-10", tokens: 101 }]
      }).success
    ).toBe(false);
  });

  it("rejects contradictory token breakdowns and last-turn values", () => {
    expect(usageTokenBreakdownSchema.safeParse({ ...tokenBreakdown(10), input_tokens: 11 }).success).toBe(false);
    expect(usageTokenBreakdownSchema.safeParse({ ...tokenBreakdown(10), cached_input_tokens: 6, input_tokens: 5 }).success).toBe(
      false
    );
    expect(
      usageThreadObservationSchema.safeParse({
        ...(snapshotCandidate().thread as Record<string, unknown>),
        last: tokenBreakdown(21)
      }).success
    ).toBe(false);
  });

  it("rejects observations after measurement and every extra field", () => {
    expect(
      usageSnapshotSchema.safeParse({
        ...snapshotCandidate(),
        thread: {
          ...(snapshotCandidate().thread as Record<string, unknown>),
          observed_at: "2026-07-11T16:00:01.000Z"
        }
      }).success
    ).toBe(false);
    expect(usageSnapshotSchema.safeParse({ ...snapshotCandidate(), monetary_cost: 1 }).success).toBe(false);
  });
});

function snapshotCandidate() {
  return {
    target: {
      type: "managed_session",
      session_id: "sess_usage_a",
      codex_thread_id: "thread-usage-a"
    },
    runtime_version: "0.144.0",
    connection_generation: 4,
    measured_at: measuredAt,
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
    },
    thread: {
      state: "observed",
      scope: "thread",
      observed_at: "2026-07-11T15:59:58.000Z",
      turn_id: "turn-usage-a",
      total: tokenBreakdown(20),
      last: tokenBreakdown(10),
      model_context_window: 128_000
    },
    rate_limits: {
      state: "observed",
      scope: "runtime",
      observed_at: "2026-07-11T15:59:59.000Z",
      primary: {
        used_percent: 25,
        window_duration_minutes: 300,
        resets_at: "2026-07-11T18:00:00.000Z"
      },
      secondary: null,
      reached_type: null
    }
  } as const;
}

function tokenBreakdown(total: number) {
  return {
    total_tokens: total,
    input_tokens: Math.floor(total / 2),
    cached_input_tokens: Math.floor(total / 4),
    output_tokens: Math.floor(total / 2),
    reasoning_output_tokens: Math.floor(total / 4)
  };
}
