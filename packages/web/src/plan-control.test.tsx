// @vitest-environment jsdom

import {
  managedSessionProjectionSchema,
  type PlanControlSnapshot,
  planControlSnapshotSchema,
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
import { PlanControl, usePlanControlController } from "./plan-control.js";
import {
  createPlanControlController,
  type PlanControlController,
  type PlanControlPort
} from "./plan-control-state.js";

const sessionId = "sess_plan_ui_001" as SessionId;
const timestamp = "2026-07-26T02:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlanControl", () => {
  it("opens a labelled three-rail sheet, loads exact truth, and restores trigger focus", async () => {
    const user = userEvent.setup();
    const response = createDeferred<PlanControlSnapshot>();
    const controller = readyController(planPort({ read: async () => response.promise }));
    render(<PlanControl controller={controller} />);
    const trigger = screen.getByRole("button", { name: "/plan for android-plan-release" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "/plan" });
    expect(dialog.textContent).toContain("Target: android-plan-release");
    expect(screen.getByText("Loading Plan state")).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    response.resolve(planSnapshot());
    const planMode = await screen.findByRole("radio", { name: "Plan" });
    expect(planMode).toBeTruthy();
    const descriptionId = planMode.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId as string)?.textContent).not.toBe(
      ""
    );
    expect(screen.getByRole("form", { name: "Plan selection" })).toBeTruthy();
    expect(screen.getByText("Current mode")).toBeTruthy();
    expect(screen.getByText("Next turn")).toBeTruthy();
    expect(screen.getByText("Current turn")).toBeTruthy();
    expect(screen.getByText("No pending change")).toBeTruthy();
    expect(screen.getByText("No observed Plan execution")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Default" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("button", { name: "Set for next turn" }) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.textContent).not.toMatch(/catalog_revision|selection_operation_id|turn-plan|op_private/u);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("stages one next-turn mode and protects the in-flight sheet", async () => {
    const user = userEvent.setup();
    const response = createDeferred<PlanControlSnapshot>();
    const port = planPort({ read: async () => planSnapshot(), select: async () => response.promise });
    const controller = readyController(port, () => "op_browser_plan_ui_submit_001");
    render(<PlanControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByRole("radio", { name: /Plan/ });

    await user.click(screen.getByRole("radio", { name: /Plan/ }));
    screen.getByRole("button", { name: "Set for next turn" }).focus();
    await user.keyboard("{Enter}");

    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.select.mock.calls[0]?.[0].request).toEqual({
      operation_id: "op_browser_plan_ui_submit_001",
      kind: "plan",
      action: "enter",
      expected_pending_revision: null
    });
    expect(JSON.stringify(port.select.mock.calls[0]?.[0].request)).not.toContain("/plan");
    expect((screen.getByRole("button", { name: "Close Plan control" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "/plan" })).toBeTruthy();

    response.resolve(
      planSnapshot({ pending: pending("op_browser_plan_ui_submit_001", "plan") })
    );
    expect(await screen.findByText("Plan staged for next turn", { exact: true })).toBeTruthy();
    expect(screen.getByText(/Pending next turn:/)).toBeTruthy();
    expect(screen.getAllByText(/current turn is unchanged/i)).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Set for next turn" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps active execution separate and still permits next-turn staging", async () => {
    const user = userEvent.setup();
    const port = planPort({
      read: async () =>
        planSnapshot({
          execution: {
            turn_id: "turn-plan-active-ui-001",
            state: "active",
            evidence: "plan_item",
            summary: "Review the deployment sequence without changing this turn.",
            updated_at: timestamp
          }
        })
    });
    const controller = readyController(port);
    render(<PlanControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByRole("radio", { name: /Plan/ });

    expect(screen.getByText("Plan execution active")).toBeTruthy();
    expect(screen.getByText("Plan item observed")).toBeTruthy();
    expect(screen.getByText("Review the deployment sequence without changing this turn.")).toBeTruthy();
    expect(screen.getByText(/current turn is unchanged/i)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Plan/ }));
    expect((screen.getByRole("button", { name: "Set for next turn" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps current truth visible and disables the radio group for read-only access", async () => {
    const user = userEvent.setup();
    const port = planPort({ read: async () => planSnapshot() });
    const controller = readyController(port, undefined, context({ writeCause: "read_only_access" }));
    render(<PlanControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByRole("radio", { name: /Plan/ });

    expect(screen.getAllByText("Read-only access cannot change Plan mode.")).toHaveLength(1);
    expect((screen.getByRole("radio", { name: /Plan/ }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /Default/ }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(port.select).not.toHaveBeenCalled();
  });

  it("locks an ambiguous selection behind an explicit Plan-state check", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const port = planPort({
      read: async () => {
        reads += 1;
        return reads === 1
          ? planSnapshot()
          : planSnapshot({ pending: pending("op_server_plan_after_ui_loss_001", "plan") });
      },
      select: async () => {
        throw new Error("private UI Plan transport detail");
      }
    });
    const controller = readyController(port);
    render(<PlanControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByRole("radio", { name: /Plan/ });
    await user.click(screen.getByRole("radio", { name: /Plan/ }));
    await user.click(screen.getByRole("button", { name: "Set for next turn" }));

    expect(await screen.findByText("Selection outcome unknown")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private UI Plan transport detail");
    expect((screen.getByRole("button", { name: "Set for next turn" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Check Plan state" }));
    expect(await screen.findByText(/Pending next turn:/)).toBeTruthy();
    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("renders a replaceable conflict without private error or revision material", async () => {
    const user = userEvent.setup();
    const controller = readyController(
      planPort({
        read: async () =>
          planSnapshot({
            pending: {
              ...pending("op_private_plan_conflict_001", "plan"),
              revision: 17,
              phase: "conflict",
              error: {
                code: "operation_conflict",
                message: "/private/runtime/path must never render",
                retryable: true
              }
            }
          })
      })
    );
    render(<PlanControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByText("Pending Plan conflict");

    expect(screen.getByText(/Conflict: Replace or clear this selection/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restage for next turn" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("17");
    expect(document.body.textContent).not.toContain("op_private_plan_conflict_001");
    expect(document.body.textContent).not.toContain("/private/runtime/path");
  });

  it("composes selected production read and protected write routes once under StrictMode", async () => {
    const user = userEvent.setup();
    const requestSelectedSessionRead = vi.fn(async () => ({ status: 200, data: planSnapshot() }));
    const requestProtected = vi.fn(async (_routeId, input) => ({
      status: 200,
      data: planSnapshot({
        pending: pending(input.body.operation_id, input.body.action === "enter" ? "plan" : "default")
      })
    }));
    const coordinator = coordinatorWith(requestSelectedSessionRead, requestProtected);
    const currentContext = context();
    const currentOwner: { current: PlanControlController | null } = { current: null };

    function Harness() {
      const owner = usePlanControlController(
        coordinator,
        sessionId,
        currentContext.snapshot,
        { createOperationId: () => "op_browser_plan_ui_production_001" }
      );
      currentOwner.current = owner;
      return <PlanControl controller={owner} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByRole("radio", { name: /Plan/ });
    await user.click(screen.getByRole("radio", { name: /Plan/ }));
    await user.click(screen.getByRole("button", { name: "Set for next turn" }));
    await screen.findByText("Plan staged for next turn", { exact: true });

    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(requestSelectedSessionRead).toHaveBeenCalledWith(
      "plan_read",
      { params: { session_id: sessionId } },
      { signal: expect.any(AbortSignal) }
    );
    expect(requestProtected).toHaveBeenCalledTimes(1);
    expect(requestProtected).toHaveBeenCalledWith(
      "plan_select",
      {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_browser_plan_ui_production_001",
          kind: "plan",
          action: "enter",
          expected_pending_revision: null
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
    if (closedOwner === null) throw new TypeError("Plan owner was not captured.");
    expect(closedOwner.snapshot().visible).toBe(false);
  });

  it("blocks a stale React owner before plan_select when the coordinator target has moved", async () => {
    const user = userEvent.setup();
    const initial = context().snapshot;
    let liveSnapshot = initial;
    const requestSelectedSessionRead = vi.fn(async () => ({ status: 200, data: planSnapshot() }));
    const requestProtected = vi.fn(async () => ({ status: 200, data: planSnapshot() }));
    const coordinator = coordinatorWith(
      requestSelectedSessionRead,
      requestProtected,
      () => liveSnapshot
    );

    function Harness() {
      const owner = usePlanControlController(coordinator, sessionId, initial);
      return <PlanControl controller={owner} />;
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByRole("radio", { name: /Plan/ });
    await user.click(screen.getByRole("radio", { name: /Plan/ }));
    liveSnapshot = Object.freeze({
      ...initial,
      epoch: initial.epoch + 1,
      target: Object.freeze({ kind: "mission_control" as const })
    });
    await user.click(screen.getByRole("button", { name: "Set for next turn" }));

    expect(requestProtected).not.toHaveBeenCalled();
    expect(await screen.findByText("Plan selection was not saved")).toBeTruthy();
    expect(screen.getByText("Plan access is not current. Refresh Session Detail.")).toBeTruthy();
  });

  it("suppresses a successful Plan response when the coordinator target moves in flight", async () => {
    const user = userEvent.setup();
    const initial = context().snapshot;
    let liveSnapshot = initial;
    const release = createDeferred<void>();
    const requestSelectedSessionRead = vi.fn(async () => ({ status: 200, data: planSnapshot() }));
    const requestProtected = vi.fn(async (_routeId, input) => {
      await release.promise;
      return {
        status: 200,
        data: planSnapshot({
          pending: pending(
            input.body.operation_id,
            input.body.action === "enter" ? "plan" : "default"
          )
        })
      };
    });
    const coordinator = coordinatorWith(
      requestSelectedSessionRead,
      requestProtected,
      () => liveSnapshot
    );

    function Harness() {
      const owner = usePlanControlController(
        coordinator,
        sessionId,
        initial,
        { createOperationId: () => "op_browser_plan_ui_late_target_001" }
      );
      return <PlanControl controller={owner} />;
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "/plan for android-plan-release" }));
    await screen.findByRole("radio", { name: /Plan/ });
    await user.click(screen.getByRole("radio", { name: /Plan/ }));
    await user.click(screen.getByRole("button", { name: "Set for next turn" }));
    await waitFor(() => expect(requestProtected).toHaveBeenCalledTimes(1));

    liveSnapshot = Object.freeze({
      ...initial,
      epoch: initial.epoch + 1,
      target: Object.freeze({ kind: "mission_control" as const })
    });
    release.resolve(undefined);

    expect(await screen.findByText("Plan selection was not saved")).toBeTruthy();
    expect(screen.queryByText(/Pending next turn:/)).toBeNull();
  });
});

function readyController(
  port: ReturnType<typeof planPort>,
  createOperationId: (() => string) | undefined = () => "op_browser_plan_ui_default_001",
  initialContext = context()
) {
  return createPlanControlController({ sessionId, context: initialContext, port, createOperationId });
}

function planPort(overrides: Partial<PlanControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => planSnapshot())),
    select: vi.fn(
      overrides.select ??
        (async ({ request }) =>
          planSnapshot({
            pending: pending(request.operation_id, request.action === "enter" ? "plan" : "default")
          }))
    )
  };
}

function planSnapshot(input: Readonly<{ pending?: unknown; execution?: unknown }> = {}): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    catalog_revision: "d".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      state: "confirmed",
      mode: "default",
      runtime_model: "runtime-current",
      reasoning_effort: "high",
      observed_at: timestamp
    },
    pending: input.pending ?? null,
    execution: input.execution ?? {
      turn_id: null,
      state: "idle",
      evidence: "none",
      summary: null,
      updated_at: null
    },
    modes: [
      {
        name: "Plan",
        mode: "plan",
        preset_model: "runtime-plan",
        preset_reasoning_effort: "medium"
      },
      {
        name: "Default",
        mode: "default",
        preset_model: null,
        preset_reasoning_effort: null
      }
    ]
  });
}

function pending(operationId: string, mode: "default" | "plan") {
  return {
    revision: 1,
    selection_operation_id: operationId,
    mode,
    catalog_state: "available",
    phase: "pending",
    selected_at: timestamp,
    turn_id: null,
    resolved_settings: null,
    error: null
  };
}

function context(
  input: Readonly<{ writeCause?: "read_only_access" }> = {}
): Readonly<{ snapshot: BrowserConnectionSnapshot }> {
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-plan-release",
    codex_thread_id: "thread-private-plan-ui",
    cwd: "/private/plan-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "in_progress",
    attention: "watch",
    freshness: "current",
    freshness_reason: null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/plan-ui",
    model: "runtime-current",
    settings: null,
    goal: null,
    recent_summary: "Validate structured Plan UI.",
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
    device_id: "device-plan-ui-private",
    permission: "write",
    device_expires_at: "2026-10-26T02:00:00.000Z",
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
  requestProtected: ReturnType<typeof vi.fn>,
  snapshot: () => BrowserConnectionSnapshot = () => context().snapshot
): BrowserConnectionStateCoordinator {
  const current = snapshot();
  return {
    snapshot,
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
