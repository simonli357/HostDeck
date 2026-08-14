// @vitest-environment jsdom

import {
  type GoalControlSnapshot,
  goalControlSnapshotSchema,
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import { GoalControl, useGoalControlController } from "./goal-control.js";
import {
  createGoalControlController,
  type GoalControlController,
  type GoalControlPort
} from "./goal-control-state.js";

const sessionId = "sess_goal_ui_001" as SessionId;
const timestamp = "2026-07-26T01:00:00.000Z";
const initialRevision = "a".repeat(64);
const changedRevision = "b".repeat(64);
const objective = "Complete the selected HostDeck V1 foundation.";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GoalControl", () => {
  it("opens a labelled Focus Rail sheet, loads no-goal truth, and restores trigger focus", async () => {
    const user = userEvent.setup();
    const response = createDeferred<GoalControlSnapshot>();
    const controller = readyController(goalPort({ read: async () => response.promise }));
    render(<GoalControl controller={controller} />);
    const trigger = screen.getByRole("button", { name: "/goal for android-release" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "/goal" });
    expect(dialog.textContent).toContain("Target: android-release");
    expect(screen.getByText("Loading goal")).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    response.resolve(goalSnapshot({ noGoal: true }));
    expect(await screen.findAllByText("No goal set", { exact: true })).toHaveLength(2);
    const objectiveField = screen.getByRole("textbox", { name: "Goal objective" });
    expect((objectiveField as HTMLTextAreaElement).maxLength).toBe(512);
    expect((screen.getByRole("button", { name: "Create paused goal" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("creates one paused goal and protects the in-flight sheet", async () => {
    const user = userEvent.setup();
    const response = createDeferred<GoalControlSnapshot>();
    const port = goalPort({
      read: async () => goalSnapshot({ noGoal: true }),
      mutate: async () => response.promise
    });
    const controller = readyController(port, () => "op_browser_goal_ui_create_001");
    render(<GoalControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/goal for android-release" }));
    const textarea = await screen.findByRole("textbox", { name: "Goal objective" });
    await user.type(textarea, "Ship the Android goal control.");
    await user.click(screen.getByRole("button", { name: "Create paused goal" }));

    expect(port.mutate).toHaveBeenCalledTimes(1);
    expect(port.mutate.mock.calls[0]?.[0].request).toEqual({
      operation_id: "op_browser_goal_ui_create_001",
      kind: "goal",
      action: "set",
      objective: "Ship the Android goal control.",
      expected_goal_revision: null
    });
    expect(JSON.stringify(port.mutate.mock.calls[0]?.[0].request)).not.toContain("/goal");
    expect((screen.getByRole("button", { name: "Close goal control" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "/goal" })).toBeTruthy();

    response.resolve(
      goalSnapshot({
        objective: "Ship the Android goal control.",
        status: "paused",
        revision: changedRevision
      })
    );
    expect(await screen.findByText("Paused goal created")).toBeTruthy();
    expect(screen.getByText("Ship the Android goal control.", { selector: "strong" })).toBeTruthy();
  });

  it("shows active-goal risk, allows pause during a turn, and never offers interrupt", async () => {
    const user = userEvent.setup();
    const port = goalPort({
      read: async () => goalSnapshot({ status: "active" }),
      mutate: async () => goalSnapshot({ status: "paused", revision: changedRevision })
    });
    const controller = readyController(
      port,
      () => "op_browser_goal_ui_pause_001",
      context({ turnState: "in_progress" })
    );
    render(<GoalControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/goal for android-release" }));
    expect(await screen.findAllByText("Active", { exact: true })).toHaveLength(2);

    expect(screen.getAllByText(/Pause does not interrupt the current turn/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /interrupt/i })).toBeNull();
    expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Complete" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Clear goal" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(port.mutate.mock.calls[0]?.[0].request.action).toBe("pause");
    expect(await screen.findByText("Goal paused")).toBeTruthy();
  });

  it("requires explicit resume confirmation and labels only accepted truth", async () => {
    const user = userEvent.setup();
    const response = createDeferred<GoalControlSnapshot>();
    const port = goalPort({
      read: async () => goalSnapshot({ status: "paused" }),
      mutate: async () => response.promise
    });
    const controller = readyController(port, () => "op_browser_goal_ui_resume_001");
    render(<GoalControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/goal for android-release" }));
    expect(await screen.findAllByText("Paused", { exact: true })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect(port.mutate).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alert", { name: "Resume agentic goal?" });
    expect(confirmation.textContent).toContain("may continue work and start a turn");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Resume goal" }));
    expect(port.mutate).toHaveBeenCalledTimes(1);

    response.resolve(goalSnapshot({ status: "active", revision: changedRevision }));
    expect(await screen.findByText("Goal resume accepted")).toBeTruthy();
    expect(screen.getByText(/Turn start and progress remain authoritative/)).toBeTruthy();
    expect(screen.queryByText("Goal running")).toBeNull();
  });

  it("keeps a long observed objective intact and all actions disabled for read-only access", async () => {
    const user = userEvent.setup();
    const longObjective = "Long goal objective ".repeat(190).slice(0, 3_500);
    const port = goalPort({
      read: async () => goalSnapshot({ objective: longObjective, status: "paused" })
    });
    const controller = readyController(
      port,
      undefined,
      context({ writeCause: "read_only_access" })
    );
    render(<GoalControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/goal for android-release" }));
    await waitFor(() => {
      expect(document.querySelector(".hostdeck-goal-state__objective")?.textContent).toBe(longObjective);
    });

    const timestamps = [...document.querySelectorAll("time")];
    expect(timestamps).toHaveLength(2);
    for (const time of timestamps) {
      expect(time.getAttribute("datetime")).toBe(timestamp);
      expect(time.getAttribute("title")).toBe(timestamp);
    }

    expect(screen.getByText(/exceeds the phone edit limit/)).toBeTruthy();
    const readOnlyObjective = screen.getByRole("textbox", { name: "Goal objective" });
    expect((readOnlyObjective.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save paused goal" }) as HTMLButtonElement).disabled).toBe(true);
    expect(port.mutate).not.toHaveBeenCalled();
  });

  it("renders uncertain conflict without exposing revision or private error material", async () => {
    const user = userEvent.setup();
    const controller = readyController(
      goalPort({
        read: async () => goalSnapshot({
          status: "paused",
          uncertain: {
            action: "resume",
            phase: "conflict",
            requested_at: timestamp,
            baseline_revision: initialRevision,
            requested_objective: null,
            requested_status: "active",
            error: {
              code: "operation_conflict",
              message: "private runtime conflict detail",
              retryable: false
            }
          }
        })
      })
    );
    render(<GoalControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/goal for android-release" }));

    expect(await screen.findByText("Goal result conflict")).toBeTruthy();
    expect(screen.getByText(/Conflict: Resume goal/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("private runtime conflict detail");
    expect(document.body.textContent).not.toContain(initialRevision);
    expect((screen.getByRole("button", { name: "Save paused goal" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("composes the selected production read/write routes once under StrictMode", async () => {
    const user = userEvent.setup();
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200,
      data: goalSnapshot({ noGoal: true })
    }));
    const requestProtected = vi.fn(async (_routeId, input) => ({
      status: 200,
      data: goalSnapshot({
        objective: input.body.objective,
        status: "paused",
        revision: changedRevision
      })
    }));
    const coordinator = coordinatorWith(requestSelectedSessionRead, requestProtected);
    const currentContext = context();
    const currentOwner: { current: GoalControlController | null } = { current: null };

    function Harness() {
      const owner = useGoalControlController(
        coordinator,
        sessionId,
        currentContext.snapshot,
        { createOperationId: () => "op_browser_goal_ui_production_001" }
      );
      currentOwner.current = owner;
      return <GoalControl controller={owner} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await user.click(screen.getByRole("button", { name: "/goal for android-release" }));
    const textarea = await screen.findByRole("textbox", { name: "Goal objective" });
    await user.type(textarea, "Wire the exact goal route.");
    await user.click(screen.getByRole("button", { name: "Create paused goal" }));
    await screen.findByText("Paused goal created");

    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(requestSelectedSessionRead).toHaveBeenCalledWith(
      "goal_read",
      { params: { session_id: sessionId } },
      { signal: expect.any(AbortSignal) }
    );
    expect(requestProtected).toHaveBeenCalledTimes(1);
    expect(requestProtected).toHaveBeenCalledWith(
      "goal_mutate",
      {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_browser_goal_ui_production_001",
          kind: "goal",
          action: "set",
          objective: "Wire the exact goal route.",
          expected_goal_revision: null
        }
      },
      { signal: expect.any(AbortSignal) }
    );

    rendered.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    const closedOwner = currentOwner.current;
    expect(closedOwner).not.toBeNull();
    if (closedOwner === null) throw new TypeError("Goal owner was not captured.");
    expect(closedOwner.snapshot().visible).toBe(false);
  });
});

function readyController(
  port: ReturnType<typeof goalPort>,
  createOperationId: (() => string) | undefined = () => "op_browser_goal_ui_default_001",
  initialContext = context()
) {
  return createGoalControlController({
    sessionId,
    context: initialContext,
    port,
    createOperationId
  });
}

function goalPort(overrides: Partial<GoalControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => goalSnapshot({ status: "paused" }))),
    mutate: vi.fn(
      overrides.mutate ??
        (async ({ request }) =>
          request.action === "clear"
            ? goalSnapshot({ noGoal: true })
            : goalSnapshot({
                objective: request.action === "set" ? request.objective ?? objective : objective,
                status: request.action === "resume" ? "active" : request.action === "complete" ? "complete" : "paused",
                revision: changedRevision
              }))
    )
  };
}

function goalSnapshot(
  input: Readonly<{
    noGoal?: boolean;
    objective?: string;
    status?: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
    revision?: string;
    uncertain?: unknown;
  }> = {}
): GoalControlSnapshot {
  return goalControlSnapshotSchema.parse({
    goal: input.noGoal === true
      ? null
      : {
          revision: input.revision ?? initialRevision,
          objective: input.objective ?? objective,
          status: input.status ?? "paused",
          token_budget: 20_000,
          tokens_used: 1_200,
          time_used_seconds: 75.5,
          created_at: timestamp,
          updated_at: timestamp
        },
    uncertain_mutation: input.uncertain ?? null
  });
}

function context(
  input: Readonly<{
    writeCause?: "read_only_access";
    turnState?: "idle" | "in_progress";
  }> = {}
): Readonly<{ snapshot: BrowserConnectionSnapshot }> {
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: "thread-private-goal-ui",
    cwd: "/private/goal-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.147.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/goal-ui",
    model: "runtime-a",
    settings: null,
    goal: { objective, state: "paused" },
    recent_summary: "Validate structured goal UI.",
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
    access: { mode: "paired_write", network_mode: "remote", transport: "https" },
    session: item
  });
  const writeCause = input.writeCause;
  return Object.freeze({
    snapshot: Object.freeze({
      epoch: 1,
      target: Object.freeze({ kind: "session_detail" as const, sessionId }),
      phase: "ready" as const,
      access: resource("current", pairedAccess()),
      host: resource("current", null),
      targetState: resource("current", Object.freeze({ kind: "session_detail" as const, response })),
      stream: Object.freeze({
        state: "connected" as const,
        snapshot: null,
        continuity: "contiguous" as const,
        boundary: null,
        failure: null
      }),
      csrf: Object.freeze({
        phase: "ready" as const,
        generation: 1,
        rotatedAt: timestamp,
        failure: null,
        invalidationReason: null
      }),
      writeEligibility: Object.freeze({
        scope: "browser_shell" as const,
        eligible: writeCause === undefined,
        causes: Object.freeze(writeCause === undefined ? [] : [writeCause])
      }),
      lastFailure: null
    })
  });
}

function pairedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-goal-ui-private",
    permission: "write",
    device_expires_at: "2026-10-26T01:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
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

function coordinatorWith(
  requestSelectedSessionRead: ReturnType<typeof vi.fn>,
  requestProtected: ReturnType<typeof vi.fn>
): BrowserConnectionStateCoordinator {
  const current = context().snapshot;
  return {
    snapshot: () => current,
    subscribe: () => () => undefined,
    setTarget: vi.fn(async () => current),
    refresh: vi.fn(async () => current),
    loadMoreSessions: vi.fn(async () => current),
    connectSessionStream: vi.fn(() => current),
    disconnectSessionStream: vi.fn(() => current),
    bootstrapCsrf: vi.fn(async () => current),
    adoptCsrfBootstrap: vi.fn(() => current),
    requestProtected,
    requestSelectedSessionRead,
    close: vi.fn(() => current)
  } as unknown as BrowserConnectionStateCoordinator;
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
