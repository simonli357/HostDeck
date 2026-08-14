import type { Page, Request, Route } from "@playwright/test";
import {
  type ApiErrorEnvelope,
  type UsageSnapshot,
  usageSnapshotSchema
} from "../../packages/contracts/src/index.js";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  type SessionDetailApiVariant,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type UsageSnapshotVariant =
  | "content"
  | "empty"
  | "explicit_empty_zero"
  | "null_observations"
  | "reached"
  | "compaction"
  | "long";

export type UsageReadOutcome =
  | "success"
  | "pending"
  | "unsupported"
  | "known_failure"
  | "malformed";

export interface UsageControlApiController {
  readonly session: SessionDetailApiController;
  readonly hasPendingRead: () => boolean;
  readonly requests: () => readonly Request[];
  readonly releaseRead: (outcome?: Exclude<UsageReadOutcome, "pending">) => void;
  readonly setReadOutcome: (outcome: UsageReadOutcome) => void;
  readonly setSessionVariant: (variant: SessionDetailApiVariant) => void;
  readonly setSnapshotVariant: (variant: UsageSnapshotVariant) => void;
}

const timestamp = "2026-07-27T16:00:00.000Z";
const usagePath = `/api/v1/sessions/${sessionDetailBrowserSessionId}/usage`;

export async function installUsageControlApi(
  page: Page,
  input: Readonly<{
    sessionVariant?: SessionDetailApiVariant;
    snapshotVariant?: UsageSnapshotVariant;
  }> = {}
): Promise<UsageControlApiController> {
  const session = await installSessionDetailApi(page, input.sessionVariant ?? "writable");
  let snapshot = usageSnapshot(input.snapshotVariant ?? "content");
  let readOutcome: UsageReadOutcome = "success";
  let pendingResolution: ((outcome: Exclude<UsageReadOutcome, "pending">) => void) | null = null;
  const reads: Request[] = [];

  await page.route(`**${usagePath}`, async (route) => {
    const request = route.request();
    reads.push(request);
    if (request.method() !== "GET") {
      await route.fulfill({ status: 405, body: "unexpected Usage method" });
      return;
    }
    let selectedOutcome = readOutcome;
    if (selectedOutcome === "pending") {
      if (pendingResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending Usage read" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<UsageReadOutcome, "pending">>((resolve) => {
        pendingResolution = resolve;
      });
      pendingResolution = null;
    }
    if (selectedOutcome === "unsupported") {
      await fulfillApiError(route, 409, "capability_unavailable", false);
      return;
    }
    if (selectedOutcome === "known_failure") {
      await fulfillApiError(route, 503, "service_overloaded", true);
      return;
    }
    if (selectedOutcome === "malformed") {
      await fulfillJson(route, { ...snapshot, monetary_cost: 12 });
      return;
    }
    await fulfillJson(route, snapshot);
  });

  return Object.freeze({
    session,
    hasPendingRead: () => pendingResolution !== null,
    requests: () => reads,
    releaseRead(outcome: Exclude<UsageReadOutcome, "pending"> = "success") {
      if (pendingResolution === null) throw new TypeError("No pending Usage read exists.");
      readOutcome = outcome;
      pendingResolution(outcome);
    },
    setReadOutcome(outcome: UsageReadOutcome) {
      if (pendingResolution !== null) throw new TypeError("Cannot replace a pending Usage outcome.");
      readOutcome = outcome;
    },
    setSessionVariant(variant: SessionDetailApiVariant) {
      session.setVariant(variant);
    },
    setSnapshotVariant(variant: UsageSnapshotVariant) {
      snapshot = usageSnapshot(variant);
    }
  });
}

export function usageSnapshot(variant: UsageSnapshotVariant): UsageSnapshot {
  const empty = variant === "empty";
  const explicitEmptyZero = variant === "explicit_empty_zero";
  const nullObservations = variant === "null_observations";
  const reached = variant === "reached";
  const compaction = variant === "compaction";
  const long = variant === "long";
  const dailyBuckets = long
    ? Array.from({ length: 9 }, (_, index) => ({
        start_date: `2026-07-${String(index + 1).padStart(2, "0")}`,
        tokens: 900_000_000_000_000 + index
      }))
    : empty || nullObservations
      ? null
      : explicitEmptyZero
        ? []
        : [
            { start_date: "2026-07-25", tokens: 50 },
            { start_date: "2026-07-26", tokens: 100 }
          ];
  const total = long ? 8_000_000_000_000_000 : compaction ? 10 : 20;
  const last = long ? 7_000_000_000_000_000 : compaction ? 20 : 10;
  return usageSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionDetailBrowserSessionId,
      codex_thread_id: "thread-private-browser-detail"
    },
    runtime_version: "0.147.0",
    connection_generation: 4,
    measured_at: timestamp,
    account: {
      scope: "account",
      summary: {
        lifetime_tokens: empty ? null : explicitEmptyZero ? 0 : long ? 9_000_000_000_000_000 : 1_000,
        peak_daily_tokens: empty || explicitEmptyZero ? null : long ? 1_000_000_000_000_000 : 100,
        longest_running_turn_seconds: empty || explicitEmptyZero ? null : long ? 9_000_000_000 : 30,
        current_streak_days: empty || explicitEmptyZero ? null : long ? 9_000_000 : 2,
        longest_streak_days: empty || explicitEmptyZero ? null : long ? 10_000_000 : 4
      },
      daily_buckets: dailyBuckets
    },
    thread:
      empty || explicitEmptyZero || nullObservations
        ? { state: "not_observed", scope: "thread" }
        : {
            state: "observed",
            scope: "thread",
            observed_at: "2026-07-27T15:59:58.000Z",
            turn_id: "turn-private-browser-usage",
            total: tokenBreakdown(total),
            last: tokenBreakdown(last),
            model_context_window: long ? 9_000_000_000_000_000 : 128_000
          },
    rate_limits:
      empty || explicitEmptyZero
        ? { state: "not_observed", scope: "runtime" }
        : {
            state: "observed",
            scope: "runtime",
            observed_at: "2026-07-27T15:59:59.000Z",
            primary: nullObservations
              ? null
              : {
                  used_percent: long ? 99.75 : reached ? 100 : 25,
                  window_duration_minutes: long ? 9_000_000_000 : 300,
                  resets_at: long ? null : "2026-07-27T18:00:00.000Z"
                },
            secondary: null,
            reached_type: reached ? "workspace_member_usage_limit_reached" : null
          }
  });
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

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

async function fulfillApiError(
  route: Route,
  status: number,
  code: ApiErrorEnvelope["code"],
  retryable: boolean
): Promise<void> {
  await fulfillJson(
    route,
    {
      error: {
        code,
        message: "Private Usage fixture detail.",
        retryable
      }
    },
    status
  );
}
