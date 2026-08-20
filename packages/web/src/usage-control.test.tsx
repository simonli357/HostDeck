// @vitest-environment jsdom

import {
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema,
  skillsSnapshotSchema,
  type UsageSnapshot,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompactControlController } from "./compact-control.js";
import {
  type CompactControlPort,
  createCompactControlController
} from "./compact-control-state.js";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";
import { SessionUtilities } from "./session-utilities.js";
import { useSkillsControlController } from "./skills-control.js";
import {
  createSkillsControlController,
  type SkillsControlPort
} from "./skills-control-state.js";
import { useUsageControlController } from "./usage-control.js";
import {
  createUsageControlController,
  type UsageControlPort
} from "./usage-control-state.js";

const sessionId = "sess_usage_ui_001" as SessionId;
const timestamp = "2026-07-27T16:00:00.000Z";
const threadId = "thread-usage-ui-private";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UsageControl", () => {
  it("opens More without prefetch, then loads one labelled usage view in the same dialog", async () => {
    const user = userEvent.setup();
    const response = deferred<UsageSnapshot>();
    const port = usagePort({ read: async () => response.promise });
    const controller = readyController(port);
    renderUtilities(controller);
    const trigger = screen.getByRole("button", {
      name: "More session utilities for android-usage-release"
    });

    await user.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Session utilities" });
    expect(dialog.textContent).toContain("Target: android-usage-release");
    expect(port.read).not.toHaveBeenCalled();
    const usage = screen.getByRole("button", { name: "Open /usage" });
    expect(screen.getByRole("button", { name: "Open /compact" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open /skills" })).toBeTruthy();
    expect(usage.getAttribute("aria-describedby")).toBe(
      screen.getByText("Account, thread, context, and rate-limit observations").id
    );
    expect(
      Array.from(dialog.querySelectorAll(".hostdeck-utility-menu__item strong"), (item) =>
        item.textContent
      )
    ).toEqual(["/usage", "/compact", "/skills"]);

    await user.click(usage);
    dialog = screen.getByRole("dialog", { name: "/usage" });
    expect(screen.getByText("Loading usage", { exact: true })).toBeTruthy();
    expect(port.read).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    response.resolve(usageSnapshot());
    expect(await screen.findByText("Usage capture current", { exact: true })).toBeTruthy();
    expect(screen.getAllByText("1,000", { exact: true })).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "This thread" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Rate limits" })).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain(threadId);
    expect(document.body.textContent).not.toContain("turn-usage-ui-private");
    expect(document.body.textContent).not.toMatch(/monetary|billing|remaining quota/iu);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("returns to the utility list, discards capture, and performs a fresh read on re-entry", async () => {
    const user = userEvent.setup();
    const port = usagePort();
    const controller = readyController(port);
    renderUtilities(controller);

    await openUsage(user);
    await screen.findByText("Usage capture current", { exact: true });
    await user.click(screen.getByRole("button", { name: "Back to session utilities" }));
    expect(screen.getByRole("dialog", { name: "Session utilities" })).toBeTruthy();
    const item = screen.getByRole("button", { name: /usage/iu });
    await waitFor(() => expect(document.activeElement).toBe(item));
    expect(controller.snapshot()).toMatchObject({ sheetOpen: false, capture: null });

    await user.click(item);
    expect(await screen.findByText("Usage capture current", { exact: true })).toBeTruthy();
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("shows an authority-correct disabled utility row without dispatch", async () => {
    const user = userEvent.setup();
    const port = usagePort();
    const controller = readyController(port, controlContext({ freshness: "stale" }));
    renderUtilities(controller);

    await user.click(screen.getByRole("button", { name: /More session utilities/ }));
    const usage = screen.getByRole("button", { name: /usage/iu });
    expect((usage as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Session state is stale. Refresh Session Detail before loading usage.")).toBeTruthy();
    await user.click(usage);
    expect(port.read).not.toHaveBeenCalled();
  });

  it("renders explicit empty, unobserved, and null-history states", async () => {
    const user = userEvent.setup();
    const controller = readyController(
      usagePort({ read: async () => usageSnapshot({ empty: true }) })
    );
    renderUtilities(controller);
    await openUsage(user);

    expect(await screen.findByText("No usage observations reported", { exact: true })).toBeTruthy();
    expect(screen.getByText("Daily history not reported.")).toBeTruthy();
    expect(screen.getByText("Thread usage not observed.")).toBeTruthy();
    expect(screen.getByText("Rate limits not observed.")).toBeTruthy();
    expect(screen.getAllByText("Not reported").length).toBeGreaterThanOrEqual(3);
  });

  it("renders null rate windows as not reported and a bounded reached state", async () => {
    const user = userEvent.setup();
    const controller = readyController(
      usagePort({
        read: async () =>
          usageSnapshot({
            nullRateWindows: true,
            reachedType: "workspace_member_usage_limit_reached"
          })
      })
    );
    renderUtilities(controller);
    await openUsage(user);

    expect(await screen.findByText("Workspace member usage limit reached", { exact: true })).toBeTruthy();
    expect(screen.getAllByText("Not reported").length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain("workspace_member_usage_limit_reached");
    expect(document.body.textContent).not.toContain("Unlimited");
  });

  it("preserves calendar dates and exposes exact compact values across both rate windows", async () => {
    const user = userEvent.setup();
    const controller = readyController(
      usagePort({
        read: async () =>
          usageSnapshot({
            detailedRateWindows: true,
            lifetimeTokens: 9_000_000_000_000_000,
            totalTokens: 8_000_000_000_000_000
          })
      })
    );
    renderUtilities(controller);
    await openUsage(user);
    await screen.findByText("Usage capture current", { exact: true });

    const exactAccount = "9,000,000,000,000,000";
    const compactAccount = screen
      .getAllByTitle(exactAccount)
      .find((element) => element.querySelector('[aria-hidden="true"]')?.textContent === "9000T");
    expect(compactAccount?.querySelector(".hostdeck-visually-hidden")?.textContent).toBe(
      exactAccount
    );
    const exactThread = "8,000,000,000,000,000";
    const compactThread = screen
      .getAllByTitle(exactThread)
      .find((element) => element.querySelector('[aria-hidden="true"]')?.textContent === "8000T");
    expect(compactThread?.querySelector(".hostdeck-visually-hidden")?.textContent).toBe(
      exactThread
    );

    const calendarDate = document.querySelector('time[datetime="2026-07-25"]');
    const expectedCalendarDate = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC"
    }).format(new Date("2026-07-25T00:00:00.000Z"));
    expect(calendarDate?.textContent).toBe(expectedCalendarDate);

    const primary = screen.getByRole("heading", { name: "Primary" }).closest("section");
    expect(primary?.textContent).toContain("12.5%");
    expect(primary?.textContent).toContain("Not reported");
    const secondary = screen.getByRole("heading", { name: "Secondary" }).closest("section");
    expect(secondary?.textContent).toContain("87.25%");
    expect(secondary?.textContent).toContain("0 min");
    expect(secondary?.querySelector('time[datetime="2026-07-27T17:00:00.000Z"]')).not.toBeNull();
  });

  it("keeps the prior capture visible and stale during one explicit refresh", async () => {
    const user = userEvent.setup();
    const refresh = deferred<UsageSnapshot>();
    let reads = 0;
    const port = usagePort({
      read: async () => {
        reads += 1;
        return reads === 1 ? usageSnapshot() : refresh.promise;
      }
    });
    const controller = readyController(port);
    renderUtilities(controller);
    await openUsage(user);
    await screen.findByText("Usage capture current", { exact: true });
    controller.updateContext(controlContext({ epoch: 2 }));
    expect(await screen.findByText("Usage capture is stale", { exact: true })).toBeTruthy();

    const refreshButton = screen.getByRole("button", { name: "Refresh usage" });
    await user.click(refreshButton);
    expect(screen.getByText("Refreshing usage", { exact: true })).toBeTruthy();
    expect(screen.getAllByText("1,000", { exact: true })).toHaveLength(3);
    expect((refreshButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(refreshButton);
    expect(port.read).toHaveBeenCalledTimes(2);

    refresh.resolve(usageSnapshot({ lifetimeTokens: 2_000 }));
    expect(await screen.findAllByText("2,000", { exact: true })).toHaveLength(3);
    expect(screen.getByText("Usage capture current", { exact: true })).toBeTruthy();
  });

  it.each([
    ["unsupported", "Usage unavailable"],
    ["failure", "Usage could not be loaded"]
  ] as const)("renders sanitized %s state", async (kind, expected) => {
    const user = userEvent.setup();
    const controller = readyController(
      usagePort({
        read: async () => {
          if (kind === "unsupported") throw unsupportedError();
          throw new Error("private usage failure with account identity");
        }
      })
    );
    renderUtilities(controller);
    await openUsage(user);

    expect(await screen.findByText(expected, { exact: true })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private usage failure");
    expect((screen.getByRole("button", { name: "Refresh usage" }) as HTMLButtonElement).disabled)
      .toBe(kind === "unsupported");
  });

  it("closes the modal and removes usage disclosure when authority is replaced", async () => {
    const user = userEvent.setup();
    const controller = readyController(usagePort());
    renderUtilities(controller);
    await openUsage(user);
    await screen.findByText("Usage capture current", { exact: true });

    controller.updateContext(
      controlContext({ epoch: 2, deviceId: "device-usage-ui-replacement-private" })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("Lifetime tokens");
    expect(controller.snapshot()).toMatchObject({ sheetOpen: false, capture: null });
  });

  it("composes exactly one selected usage route under StrictMode", async () => {
    const user = userEvent.setup();
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200,
      data: usageSnapshot()
    }));
    const coordinator = coordinatorWith(requestSelectedSessionRead);
    const current = controlContext();

    function Harness() {
      const usage = useUsageControlController(coordinator, sessionId, current.snapshot);
      const compact = useCompactControlController(coordinator, sessionId, current.snapshot);
      const skills = useSkillsControlController(coordinator, sessionId, current.snapshot);
      return <SessionUtilities compact={compact} skills={skills} usage={usage} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await openUsage(user);
    expect(await screen.findByText("Usage capture current", { exact: true })).toBeTruthy();

    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(requestSelectedSessionRead).toHaveBeenCalledWith(
      "usage_read",
      { params: { session_id: sessionId } },
      { signal: expect.any(AbortSignal) }
    );
    expect(JSON.stringify(requestSelectedSessionRead.mock.calls)).not.toContain("/usage");
    rendered.unmount();
    await Promise.resolve();
  });

  it("aborts a hook-owned in-flight read on unmount and suppresses its late rejection", async () => {
    const user = userEvent.setup();
    const response = deferred<Readonly<{ status: 200; data: UsageSnapshot }>>();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const requestSelectedSessionRead = vi.fn(
      async (_routeId: string, _input: unknown, options: { readonly signal: AbortSignal }) => {
        captured.signal = options.signal;
        return response.promise;
      }
    );
    const coordinator = coordinatorWith(requestSelectedSessionRead);
    const current = controlContext();

    function Harness() {
      const usage = useUsageControlController(coordinator, sessionId, current.snapshot);
      const compact = useCompactControlController(coordinator, sessionId, current.snapshot);
      const skills = useSkillsControlController(coordinator, sessionId, current.snapshot);
      return <SessionUtilities compact={compact} skills={skills} usage={usage} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await openUsage(user);
    await waitFor(() => expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1));

    rendered.unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect((captured.signal as AbortSignal | null)?.aborted).toBe(true);
    response.reject(new Error("private late unmount rejection"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("publishes the More control when coordinator state advances from idle to ready", async () => {
    const coordinator = coordinatorWith(vi.fn());
    const ready = controlContext().snapshot;

    function Harness({ snapshot }: Readonly<{ snapshot: BrowserConnectionSnapshot }>) {
      const usage = useUsageControlController(coordinator, sessionId, snapshot);
      const compact = useCompactControlController(coordinator, sessionId, snapshot);
      const skills = useSkillsControlController(coordinator, sessionId, snapshot);
      return <SessionUtilities compact={compact} skills={skills} usage={usage} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness snapshot={idleSnapshot()} />
      </StrictMode>
    );
    expect(screen.queryByRole("button", { name: /More session utilities/ })).toBeNull();

    rendered.rerender(
      <StrictMode>
        <Harness snapshot={ready} />
      </StrictMode>
    );
    expect(
      await screen.findByRole("button", {
        name: "More session utilities for android-usage-release"
      })
    ).toBeTruthy();

    rendered.unmount();
    await Promise.resolve();
  });
});

async function openUsage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /More session utilities/ }));
  await user.click(screen.getByRole("button", { name: /usage/iu }));
}

function readyController(port: ReturnType<typeof usagePort>, context = controlContext()) {
  return createUsageControlController({ sessionId, context, port });
}

function renderUtilities(usage: ReturnType<typeof readyController>) {
  const compact = createCompactControlController({
    sessionId,
    context: controlContext(),
    port: compactPort(),
    createOperationId: () => "op_browser_compact_usage_ui_001"
  });
  const skills = createSkillsControlController({
    sessionId,
    context: controlContext(),
    port: skillsPort()
  });
  return render(<SessionUtilities compact={compact} skills={skills} usage={usage} />);
}

function compactPort(): CompactControlPort {
  return Object.freeze({
    read: vi.fn(async () => ({ progress: null })),
    start: vi.fn(async () => ({ progress: null }))
  });
}

function usagePort(overrides: Partial<UsageControlPort> = {}) {
  return { read: vi.fn(overrides.read ?? (async () => usageSnapshot())) };
}

function skillsPort(): SkillsControlPort {
  return Object.freeze({ read: vi.fn(async () => skillsSnapshot()) });
}

function skillsSnapshot() {
  return skillsSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.148.0",
    connection_generation: 4,
    observed_at: timestamp,
    state: "empty",
    skills: [],
    error_count: 0
  });
}

function usageSnapshot(
  input: Readonly<{
    empty?: boolean;
    lifetimeTokens?: number;
    nullRateWindows?: boolean;
    reachedType?: "workspace_member_usage_limit_reached";
    detailedRateWindows?: boolean;
    totalTokens?: number;
  }> = {}
): UsageSnapshot {
  const empty = input.empty ?? false;
  return usageSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.148.0",
    connection_generation: 4,
    measured_at: timestamp,
    account: {
      scope: "account",
      summary: {
        lifetime_tokens: empty ? null : input.lifetimeTokens ?? 1_000,
        peak_daily_tokens: empty ? null : 100,
        longest_running_turn_seconds: empty ? null : 30,
        current_streak_days: empty ? null : 2,
        longest_streak_days: empty ? null : 4
      },
      daily_buckets: empty
        ? null
        : [
            { start_date: "2026-07-25", tokens: 50 },
            { start_date: "2026-07-26", tokens: 100 }
          ]
    },
    thread: empty
      ? { state: "not_observed", scope: "thread" }
      : {
          state: "observed",
          scope: "thread",
          observed_at: "2026-07-27T15:59:58.000Z",
          turn_id: "turn-usage-ui-private",
          total: tokenBreakdown(input.totalTokens ?? 20),
          last: tokenBreakdown(10),
          model_context_window: 128_000
        },
    rate_limits: empty
      ? { state: "not_observed", scope: "runtime" }
      : {
          state: "observed",
          scope: "runtime",
          observed_at: "2026-07-27T15:59:59.000Z",
          primary: input.nullRateWindows
            ? null
            : input.detailedRateWindows
              ? {
                  used_percent: 12.5,
                  window_duration_minutes: null,
                  resets_at: null
                }
            : {
                used_percent: 25,
                window_duration_minutes: 300,
                resets_at: "2026-07-27T18:00:00.000Z"
              },
          secondary: input.detailedRateWindows
            ? {
                used_percent: 87.25,
                window_duration_minutes: 0,
                resets_at: "2026-07-27T17:00:00.000Z"
              }
            : null,
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

function controlContext(
  input: Readonly<{
    epoch?: number;
    deviceId?: string;
    freshness?: "current" | "stale";
  }> = {}
) {
  const freshness = input.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-usage-release",
    codex_thread_id: threadId,
    cwd: "/private/usage-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.148.0",
    created_at: timestamp,
    archived_at: null,
    session_state: freshness === "current" ? "active" : "stale",
    turn_state: "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Fixture projection is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/usage-ui",
    model: "runtime-usage",
    settings: null,
    goal: null,
    recent_summary: "Validate Usage utility.",
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
  const access = selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: input.deviceId ?? "device-usage-ui-private",
    permission: "read",
    device_expires_at: "2026-10-27T16:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready",
    access: resource("current", access),
    host: resource("current", null),
    targetState: resource(
      "current",
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

function coordinatorWith(
  requestSelectedSessionRead: ReturnType<typeof vi.fn>
): BrowserConnectionStateCoordinator {
  return {
    snapshot: () => controlContext().snapshot,
    subscribe: () => () => undefined,
    setTarget: vi.fn(),
    refresh: vi.fn(),
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap: vi.fn(),
    requestProtected: vi.fn(),
    requestDeviceList: vi.fn(),
    requestRemoteStatus: vi.fn(),
    requestDeviceRevoke: vi.fn(),
    requestHostLock: vi.fn(),
    requestSelectedSessionRead,
    close: vi.fn()
  } as unknown as BrowserConnectionStateCoordinator;
}

function idleSnapshot(): BrowserConnectionSnapshot {
  return Object.freeze({
    epoch: 0,
    target: null,
    phase: "idle" as const,
    access: resource("idle", null),
    host: resource("idle", null),
    targetState: resource("idle", null),
    stream: Object.freeze({
      state: "not_applicable" as const,
      snapshot: null,
      continuity: "not_applicable" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "idle" as const,
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: "not_bootstrapped" as const
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: false,
      causes: Object.freeze(["connection_not_current" as const])
    }),
    lastFailure: null
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

function unsupportedError() {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "usage_read",
    transport: "https",
    status: 409,
    apiError: {
      code: "capability_unavailable",
      message: "Private capability fixture detail.",
      retryable: false
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
