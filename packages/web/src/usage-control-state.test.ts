import {
  type ApiErrorEnvelope,
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema,
  type UsageSnapshot,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";
import {
  createUsageControlController,
  type UsageControlContext,
  type UsageControlPort
} from "./usage-control-state.js";

const sessionId = "sess_usage_component_001" as SessionId;
const timestamp = "2026-07-27T16:00:00.000Z";
const threadId = "thread-usage-component-private";

describe("usage-control state", () => {
  it("loads one exact current snapshot and projects bounded account, thread, and rate scopes", async () => {
    const port = usagePort({ read: async () => usageSnapshot({ dailyBucketCount: 9 }) });
    const controller = createController(port);

    const opening = controller.open();
    expect(controller.snapshot()).toMatchObject({ phase: "loading", busy: true, sheetOpen: true });
    const view = await opening;

    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.read.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      signal: expect.any(AbortSignal)
    });
    expect(view).toMatchObject({
      phase: "content",
      status: "Usage capture current",
      targetLabel: "android-release",
      capture: {
        measuredAt: timestamp,
        runtimeVersion: "0.144.0",
        freshness: "current"
      },
      thread: {
        state: "observed",
        total: { total: "20", input: "10", cachedInput: "5", output: "10", reasoningOutput: "5" },
        last: { total: "10" },
        contextWindow: { label: "Context capacity", value: "128,000", reported: true }
      },
      rateLimits: {
        state: "observed",
        primary: { usedPercent: "25%", duration: "300 min" },
        secondary: null,
        reachedLabel: null
      }
    });
    expect(view.account?.metrics.map((metric) => metric.value)).toEqual([
      "1,000",
      "100",
      "30 sec",
      "2 days",
      "4 days"
    ]);
    expect(view.account?.dailyHistory).toMatchObject({ state: "content", omittedCount: 2 });
    expect(view.account?.dailyHistory.buckets).toHaveLength(7);
    expect(view.account?.dailyHistory.buckets[0]?.date).toBe("2026-07-03");
    expect(JSON.stringify(view)).not.toContain(threadId);
    expect(JSON.stringify(view)).not.toContain("turn-usage-component-private");
  });

  it("distinguishes wholly unreported, explicit empty history, and actual zero", async () => {
    const emptyController = createController(
      usagePort({ read: async () => usageSnapshot({ empty: true }) })
    );
    await emptyController.open();
    expect(emptyController.snapshot()).toMatchObject({
      phase: "empty",
      account: { dailyHistory: { state: "not_reported" } },
      thread: { state: "not_observed" },
      rateLimits: { state: "not_observed" }
    });
    expect(emptyController.snapshot().account?.metrics.every((metric) => !metric.reported)).toBe(true);

    const explicitEmpty = createController(
      usagePort({ read: async () => usageSnapshot({ empty: true, dailyBuckets: [] }) })
    );
    await explicitEmpty.open();
    expect(explicitEmpty.snapshot()).toMatchObject({
      phase: "content",
      account: { dailyHistory: { state: "empty", buckets: [], omittedCount: 0 } }
    });

    const zero = createController(
      usagePort({ read: async () => usageSnapshot({ empty: true, lifetimeTokens: 0 }) })
    );
    await zero.open();
    expect(zero.snapshot()).toMatchObject({ phase: "content" });
    expect(zero.snapshot().account?.metrics[0]).toEqual({
      label: "Lifetime tokens",
      value: "0",
      displayValue: "0",
      reported: true
    });
  });

  it("bounds large visible token values while retaining exact strings", async () => {
    const controller = createController(
      usagePort({
        read: async () =>
          usageSnapshot({
            lifetimeTokens: 9_000_000_000_000_000,
            totalTokens: 8_000_000_000_000_000,
            lastTokens: 7_000_000_000_000_000
          })
      })
    );
    await controller.open();

    expect(controller.snapshot().account?.metrics[0]).toMatchObject({
      value: "9,000,000,000,000,000",
      displayValue: "9000T"
    });
    expect(controller.snapshot().thread).toMatchObject({
      state: "observed",
      total: { total: "8000T", totalExact: "8,000,000,000,000,000" },
      last: { total: "7000T", totalExact: "7,000,000,000,000,000" }
    });
  });

  it("keeps cumulative and last token breakdowns independent after compaction", async () => {
    const controller = createController(
      usagePort({
        read: async () =>
          usageSnapshot({ totalTokens: 10, lastTokens: 20, contextWindow: null })
      })
    );
    await controller.open();

    expect(controller.snapshot().thread).toMatchObject({
      state: "observed",
      total: { total: "10" },
      last: { total: "20" },
      contextWindow: { value: "Not reported", reported: false }
    });
    const serializedThread = JSON.stringify(controller.snapshot().thread);
    expect(serializedThread).not.toMatch(/remaining|progress|compact/iu);
  });

  it.each([
    ["rate_limit_reached", "Rate limit reached"],
    ["workspace_owner_credits_depleted", "Workspace owner credits depleted"],
    ["workspace_member_credits_depleted", "Workspace member credits depleted"],
    ["workspace_owner_usage_limit_reached", "Workspace owner usage limit reached"],
    ["workspace_member_usage_limit_reached", "Workspace member usage limit reached"]
  ] as const)("maps %s to bounded reached copy", async (reachedType, expected) => {
    const controller = createController(
      usagePort({ read: async () => usageSnapshot({ reachedType }) })
    );
    await controller.open();
    expect(controller.snapshot().rateLimits).toMatchObject({ reachedLabel: expected });
    expect(JSON.stringify(controller.snapshot())).not.toContain(reachedType);
  });

  it("distinguishes absent rate observation from observed null windows", async () => {
    const absent = createController(
      usagePort({ read: async () => usageSnapshot({ rateObserved: false }) })
    );
    await absent.open();
    expect(absent.snapshot().rateLimits).toEqual({ state: "not_observed" });

    const observed = createController(
      usagePort({ read: async () => usageSnapshot({ nullRateWindows: true }) })
    );
    await observed.open();
    expect(observed.snapshot().rateLimits).toMatchObject({
      state: "observed",
      primary: null,
      secondary: null,
      reachedLabel: null
    });
    expect(JSON.stringify(observed.snapshot())).not.toMatch(/unlimited|available quota/iu);
  });

  it("projects independent primary and secondary rate-window nullability and decimals", async () => {
    const base = usageSnapshot();
    const controller = createController(
      usagePort({
        read: async () =>
          usageSnapshotSchema.parse({
            ...base,
            rate_limits: {
              state: "observed",
              scope: "runtime",
              observed_at: "2026-07-27T15:59:59.000Z",
              primary: {
                used_percent: 12.5,
                window_duration_minutes: null,
                resets_at: null
              },
              secondary: {
                used_percent: 87.25,
                window_duration_minutes: 0,
                resets_at: "2026-07-27T17:00:00.000Z"
              },
              reached_type: null
            }
          })
      })
    );

    await controller.open();

    expect(controller.snapshot().rateLimits).toEqual({
      state: "observed",
      observedAt: "2026-07-27T15:59:59.000Z",
      primary: { usedPercent: "12.5%", duration: "Not reported", resetsAt: null },
      secondary: {
        usedPercent: "87.25%",
        duration: "0 min",
        resetsAt: "2026-07-27T17:00:00.000Z"
      },
      reachedLabel: null
    });
  });

  it("coalesces duplicate open and refresh activation into one request", async () => {
    const first = deferred<UsageSnapshot>();
    const second = deferred<UsageSnapshot>();
    let reads = 0;
    const port = usagePort({
      read: async () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      }
    });
    const controller = createController(port);

    const opening = controller.open();
    const duplicateOpen = controller.open();
    expect(port.read).toHaveBeenCalledTimes(1);
    first.resolve(usageSnapshot());
    await opening;
    await duplicateOpen;

    const refreshing = controller.refresh();
    const duplicateRefresh = controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      phase: "stale",
      busy: true,
      capture: { freshness: "stale" }
    });
    expect(port.read).toHaveBeenCalledTimes(2);
    second.resolve(usageSnapshot({ lifetimeTokens: 2_000 }));
    await refreshing;
    await duplicateRefresh;
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().account?.metrics[0]?.value).toBe("2,000");
    expect(controller.snapshot().capture?.freshness).toBe("current");
  });

  it("marks retained same-authority data stale across epochs until explicit refresh", async () => {
    const port = usagePort({ read: async () => usageSnapshot() });
    const controller = createController(port);
    await controller.open();

    const stale = controller.updateContext(context({ epoch: 2 }));
    expect(stale).toMatchObject({
      phase: "stale",
      capture: { freshness: "stale" },
      account: { metrics: expect.any(Array) },
      refreshEnabled: true
    });
    expect(port.read).toHaveBeenCalledTimes(1);

    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      phase: "content",
      capture: { freshness: "current" }
    });
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("keeps a previous capture stale when an explicit refresh fails", async () => {
    let reads = 0;
    const controller = createController(
      usagePort({
        read: async () => {
          reads += 1;
          if (reads === 1) return usageSnapshot();
          throw new Error("private refresh failure with account identity");
        }
      })
    );
    await controller.open();
    await controller.refresh();

    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      status: "Usage refresh failed",
      capture: { freshness: "stale" },
      refreshEnabled: true
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private refresh failure");
  });

  it("closes and clears capture immediately on authority replacement", async () => {
    const controller = createController(usagePort());
    await controller.open();
    expect(controller.snapshot().account).not.toBeNull();

    const replaced = controller.updateContext(
      context({ epoch: 2, deviceId: "device-usage-replacement-private" })
    );
    expect(replaced).toMatchObject({
      sheetOpen: false,
      phase: "closed",
      capture: null,
      account: null,
      thread: null,
      rateLimits: null
    });
  });

  it("cancels an initial read on epoch change and suppresses its late result", async () => {
    const response = deferred<UsageSnapshot>();
    const port = usagePort({ read: async () => response.promise });
    const controller = createController(port);
    const opening = controller.open();
    const signal = port.read.mock.calls[0]?.[0].signal;

    const changed = controller.updateContext(context({ epoch: 2 }));
    expect(signal?.aborted).toBe(true);
    expect(changed).toMatchObject({ phase: "failure", capture: null, account: null });
    response.resolve(usageSnapshot());
    await opening;
    expect(controller.snapshot()).toMatchObject({ phase: "failure", capture: null });
  });

  it("hides data and suppresses a late read after disclosure loss", async () => {
    const response = deferred<UsageSnapshot>();
    const controller = createController(usagePort({ read: async () => response.promise }));
    const opening = controller.open();

    const hidden = controller.updateContext(context({ canRead: false, epoch: 2 }));
    expect(hidden).toMatchObject({ visible: false, sheetOpen: false, account: null });
    response.resolve(usageSnapshot());
    await opening;
    expect(controller.snapshot()).toMatchObject({ visible: false, account: null });
  });

  it("allows read-only and locked authority while blocking stale targets", async () => {
    const readOnly = createController(
      usagePort(),
      context({ permission: "read", locked: true })
    );
    await readOnly.open();
    expect(readOnly.snapshot()).toMatchObject({ phase: "content", actionEnabled: true });

    const port = usagePort();
    const blocked = createController(port, context({ freshness: "stale" }));
    expect(blocked.snapshot()).toMatchObject({ visible: true, actionEnabled: false });
    await blocked.open();
    expect(port.read).not.toHaveBeenCalled();
  });

  it("retains a capture when write authority is downgraded but read authority remains", async () => {
    const controller = createController(
      usagePort(),
      context({ permission: "write", locked: false })
    );
    await controller.open();

    const downgraded = controller.updateContext(
      context({ epoch: 2, permission: "read", locked: true })
    );

    expect(downgraded).toMatchObject({
      visible: true,
      sheetOpen: true,
      actionEnabled: true,
      phase: "stale",
      capture: { freshness: "stale" },
      account: { metrics: expect.any(Array) }
    });
  });

  it.each([
    { runtimeVersion: "0.145.0" },
    { projectedThreadId: "thread-usage-replaced-private" }
  ])("closes and clears a capture when its runtime target is replaced", async (replacement) => {
    const controller = createController(usagePort());
    await controller.open();

    expect(() =>
      controller.updateContext(context({ epoch: 2, ...replacement }))
    ).not.toThrow();
    expect(controller.snapshot()).toMatchObject({
      sheetOpen: false,
      phase: "closed",
      capture: null,
      account: null,
      thread: null,
      rateLimits: null
    });
  });

  it("distinguishes unsupported capability from sanitized read failure", async () => {
    for (const code of ["capability_unavailable", "incompatible_runtime"] as const) {
      const controller = createController(
        usagePort({
          read: async () => {
            throw httpApiError(code, false);
          }
        })
      );
      await controller.open();
      expect(controller.snapshot()).toMatchObject({
        phase: "unsupported",
        status: "Structured usage unsupported",
        refreshEnabled: false
      });
    }

    const failed = createController(
      usagePort({
        read: async () => {
          throw new Error("private raw runtime usage error");
        }
      })
    );
    await failed.open();
    expect(failed.snapshot()).toMatchObject({
      phase: "failure",
      status: "Usage could not be loaded",
      refreshEnabled: true
    });
    expect(JSON.stringify(failed.snapshot())).not.toContain("private raw runtime");
  });

  it.each([
    usageSnapshot({ targetSessionId: "sess_usage_foreign_001" }),
    usageSnapshot({ targetThreadId: "thread-usage-foreign-private" }),
    usageSnapshot({ runtimeVersion: "0.145.0" }),
    { ...usageSnapshot(), monetary_cost: 12 }
  ])("rejects malformed or foreign successful response", async (candidate) => {
    const controller = createController(usagePort({ read: async () => candidate }));
    await controller.open();
    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      capture: null,
      account: null,
      thread: null,
      rateLimits: null
    });
  });

  it("dismisses and closes idempotently while suppressing late settlement", async () => {
    const response = deferred<UsageSnapshot>();
    const controller = createController(usagePort({ read: async () => response.promise }));
    const opening = controller.open();
    const dismissed = controller.dismiss();
    expect(dismissed).toMatchObject({ sheetOpen: false, phase: "closed", account: null });
    response.reject(new Error("private late usage rejection"));
    await opening;
    expect(controller.snapshot()).toBe(dismissed);

    const closed = controller.close();
    expect(closed).toMatchObject({ visible: false, sheetOpen: false });
    expect(controller.close()).toBe(closed);
    expect(() => controller.dismiss()).not.toThrow();
  });

  it("bounds listener ownership and publishes immutable public views", async () => {
    const controller = createController(usagePort());
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.open();
    expect(listener).toHaveBeenCalled();
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(Object.isFrozen(controller.snapshot().account?.metrics)).toBe(true);
    unsubscribe();
    expect(() => controller.subscribe(listener)).not.toThrow();
  });

  it("rejects malformed construction and enforces subscriber and closed-owner bounds", () => {
    const validContext = context();
    const validPort = usagePort();
    expect(() =>
      createUsageControlController({
        sessionId: "" as SessionId,
        context: validContext,
        port: validPort
      })
    ).toThrow();
    expect(() =>
      createUsageControlController({
        sessionId,
        context: { ...validContext, extra: true } as unknown as UsageControlContext,
        port: validPort
      })
    ).toThrow("HostDeck usage-control context is invalid.");
    expect(() =>
      createUsageControlController({
        sessionId,
        context: validContext,
        port: { read: validPort.read, extra: true } as unknown as UsageControlPort
      })
    ).toThrow("HostDeck usage-control port is invalid.");

    const controller = createController(validPort);
    const duplicate = vi.fn();
    const unsubscribe = controller.subscribe(duplicate);
    expect(() => controller.subscribe(duplicate)).toThrow(
      "HostDeck usage-control listener is invalid."
    );
    const unsubscribers = [unsubscribe];
    for (let index = 1; index < 32; index += 1) {
      unsubscribers.push(controller.subscribe(vi.fn()));
    }
    expect(() => controller.subscribe(vi.fn())).toThrow(
      "HostDeck usage-control listener capacity is exhausted."
    );
    for (const release of unsubscribers) release();

    controller.close();
    expect(() => controller.subscribe(vi.fn())).toThrow(
      "HostDeck usage-control listener is invalid."
    );
    expect(() => controller.updateContext(validContext)).toThrow(
      "HostDeck usage control is closed."
    );
  });
});

function createController(
  port: ReturnType<typeof usagePort>,
  initialContext = context()
) {
  return createUsageControlController({ sessionId, context: initialContext, port });
}

function usagePort(overrides: Partial<UsageControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => usageSnapshot()))
  };
}

function usageSnapshot(
  input: Readonly<{
    dailyBucketCount?: number;
    dailyBuckets?: readonly [];
    empty?: boolean;
    lifetimeTokens?: number | null;
    totalTokens?: number;
    lastTokens?: number;
    contextWindow?: number | null;
    rateObserved?: boolean;
    nullRateWindows?: boolean;
    reachedType?:
      | "rate_limit_reached"
      | "workspace_owner_credits_depleted"
      | "workspace_member_credits_depleted"
      | "workspace_owner_usage_limit_reached"
      | "workspace_member_usage_limit_reached";
    targetSessionId?: string;
    targetThreadId?: string;
    runtimeVersion?: string;
  }> = {}
): UsageSnapshot {
  const empty = input.empty ?? false;
  const dailyBuckets =
    input.dailyBuckets ??
    (empty
      ? null
      : Array.from({ length: input.dailyBucketCount ?? 2 }, (_, index) => ({
          start_date: `2026-07-${String(index + 1).padStart(2, "0")}`,
          tokens: index + 1
        })));
  return usageSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: input.targetSessionId ?? sessionId,
      codex_thread_id: input.targetThreadId ?? threadId
    },
    runtime_version: input.runtimeVersion ?? "0.144.0",
    connection_generation: 4,
    measured_at: timestamp,
    account: {
      scope: "account",
      summary: {
        lifetime_tokens: input.lifetimeTokens !== undefined ? input.lifetimeTokens : empty ? null : 1_000,
        peak_daily_tokens: empty ? null : 100,
        longest_running_turn_seconds: empty ? null : 30,
        current_streak_days: empty ? null : 2,
        longest_streak_days: empty ? null : 4
      },
      daily_buckets: dailyBuckets
    },
    thread: empty
      ? { state: "not_observed", scope: "thread" }
      : {
          state: "observed",
          scope: "thread",
          observed_at: "2026-07-27T15:59:58.000Z",
          turn_id: "turn-usage-component-private",
          total: tokenBreakdown(input.totalTokens ?? 20),
          last: tokenBreakdown(input.lastTokens ?? 10),
          model_context_window: input.contextWindow === undefined ? 128_000 : input.contextWindow
        },
    rate_limits:
      empty || input.rateObserved === false
        ? { state: "not_observed", scope: "runtime" }
        : {
            state: "observed",
            scope: "runtime",
            observed_at: "2026-07-27T15:59:59.000Z",
            primary: input.nullRateWindows
              ? null
              : {
                  used_percent: 25,
                  window_duration_minutes: 300,
                  resets_at: "2026-07-27T18:00:00.000Z"
                },
            secondary: null,
            reached_type: input.reachedType ?? null
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

function context(
  input: Readonly<{
    epoch?: number;
    deviceId?: string;
    permission?: "read" | "write";
    locked?: boolean;
    canRead?: boolean;
    accessState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    freshness?: "current" | "stale";
    projectedThreadId?: string;
    runtimeVersion?: string;
  }> = {}
): UsageControlContext {
  const freshness = input.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: input.projectedThreadId ?? threadId,
    cwd: "/private/usage-component",
    runtime_source: "codex_app_server",
    runtime_version: input.runtimeVersion ?? "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: freshness === "current" ? "active" : "stale",
    turn_state: "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/usage-component",
    model: "runtime-usage",
    settings: null,
    goal: null,
    recent_summary: "Validate structured usage.",
    last_event_cursor: null
  });
  const item = selectedSessionReadItemSchema.parse({
    session,
    event_window: {
      state: "empty",
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    }
  });
  const response = selectedSessionDetailResponseSchema.parse({
    access: { mode: "paired_read", network_mode: "remote", transport: "https" },
    session: item
  });
  const canRead = input.canRead ?? true;
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: canRead ? "ready" : "access_limited",
    access: resource(input.accessState ?? "current", access(canRead, input)),
    host: resource("current", null),
    targetState: resource(
      input.targetState ?? "current",
      Object.freeze({ kind: "session_detail" as const, response })
    ),
    stream: Object.freeze({
      state: "connected" as const,
      snapshot: null,
      continuity: "contiguous" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "idle" as const,
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: false,
      causes: Object.freeze(["read_only_access" as const])
    }),
    lastFailure: null
  });
  return Object.freeze({ snapshot });
}

function access(
  canRead: boolean,
  input: Readonly<{
    deviceId?: string;
    permission?: "read" | "write";
    locked?: boolean;
  }>
) {
  if (!canRead) {
    return selectedAccessStateResponseSchema.parse({
      authentication_state: "unpaired",
      device_id: null,
      permission: null,
      device_expires_at: null,
      configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
      network_mode: "remote",
      transport: "https",
      locked: false,
      can_read_sessions: false,
      can_write_sessions: false,
      can_lock: false,
      can_unlock: false
    });
  }
  const permission = input.permission ?? "read";
  const locked = input.locked ?? false;
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: input.deviceId ?? "device-usage-component-private",
    permission,
    device_expires_at: "2026-10-27T16:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked,
    can_read_sessions: true,
    can_write_sessions: permission === "write" && !locked,
    can_lock: permission === "write",
    can_unlock: false
  });
}

function resource<Data>(state: BrowserConnectionResourceState, data: Data | null) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function httpApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "usage_read",
    transport: "https",
    status: 409,
    apiError: {
      code,
      message: "Private usage fixture detail.",
      retryable
    }
  });
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}
