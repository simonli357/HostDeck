import {
  type ApiErrorEnvelope,
  type GoalControlSnapshot,
  type GoalMutationRequest,
  goalControlSnapshotSchema,
  goalObjectiveMaxLength,
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import {
  createGoalControlController,
  type GoalControlContext,
  type GoalControlPort
} from "./goal-control-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

const sessionId = "sess_goal_component_001" as SessionId;
const timestamp = "2026-07-26T00:30:00.000Z";
const laterTimestamp = "2026-07-26T00:31:00.000Z";
const initialRevision = "a".repeat(64);
const changedRevision = "b".repeat(64);
const objective = "Complete the selected HostDeck V1 foundation.";

describe("goal-control state", () => {
  it("loads one exact no-goal snapshot and exposes only paused creation", async () => {
    const port = goalPort({ read: async () => goalSnapshot({ noGoal: true }) });
    const controller = createController(port);

    const loading = controller.open();
    expect(controller.snapshot()).toMatchObject({ phase: "loading", sheetOpen: true });
    const view = await loading;

    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.read.mock.calls[0]?.[0]).toMatchObject({ sessionId, signal: expect.any(AbortSignal) });
    expect(view).toMatchObject({
      phase: "no_goal",
      targetLabel: "android-release",
      goal: null,
      draft: "",
      draftLimit: goalObjectiveMaxLength,
      draftEnabled: true,
      saveEnabled: false,
      saveLabel: "Create paused goal",
      pause: { enabled: false },
      resume: { enabled: false },
      complete: { enabled: false },
      clear: { enabled: false }
    });
    expect(view.actionGuidance).toContain("saved paused");
  });

  it.each([
    ["active", "Active", "connected"],
    ["paused", "Paused", "focus"],
    ["blocked", "Blocked", "attention"],
    ["usage_limited", "Usage limited", "danger"],
    ["budget_limited", "Budget limited", "danger"],
    ["complete", "Complete", "connected"]
  ] as const)("projects runtime status %s without inventing control state", async (status, label, tone) => {
    const controller = createController(goalPort({ read: async () => goalSnapshot({ status }) }));
    await controller.open();

    expect(controller.snapshot().goal).toMatchObject({
      objective,
      status,
      statusLabel: label,
      tone,
      tokenBudget: 20_000,
      tokensUsed: 1_200,
      timeUsedSeconds: 75.5,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain(initialRevision);
  });

  it("renders an over-limit observed objective intact and starts an empty replacement draft", async () => {
    const observed = "x".repeat(4_000);
    const controller = createController(
      goalPort({ read: async () => goalSnapshot({ objective: observed, status: "paused" }) })
    );
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      goal: { objective: observed },
      observedObjectiveExceedsEditLimit: true,
      draft: "",
      draftLength: 0,
      saveEnabled: false
    });
    const unchanged = controller.setDraft("y".repeat(goalObjectiveMaxLength + 1));
    expect(unchanged.draft).toBe("");
    expect(controller.setDraft("y".repeat(goalObjectiveMaxLength))).toMatchObject({
      draftLength: goalObjectiveMaxLength,
      saveEnabled: true
    });
  });

  it("trims a create objective and sends one exact goal mutation", async () => {
    const response = createDeferred<GoalControlSnapshot>();
    const port = goalPort({
      read: async () => goalSnapshot({ noGoal: true }),
      mutate: async () => response.promise
    });
    const controller = createController(port, () => "op_browser_goal_create_once_001");
    await controller.open();
    controller.setDraft("  Ship the mobile goal control.  ");

    const first = controller.save();
    const second = controller.save();
    expect(controller.snapshot()).toMatchObject({ phase: "submitting", closeDisabled: true });
    expect(port.mutate).toHaveBeenCalledTimes(1);
    expect(port.mutate.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      request: {
        operation_id: "op_browser_goal_create_once_001",
        kind: "goal",
        action: "set",
        objective: "Ship the mobile goal control.",
        expected_goal_revision: null
      },
      signal: expect.any(AbortSignal)
    });
    response.resolve(
      goalSnapshot({
        objective: "Ship the mobile goal control.",
        status: "paused",
        revision: changedRevision
      })
    );
    await first;
    await second;

    expect(controller.snapshot()).toMatchObject({
      phase: "created",
      status: "Paused goal created",
      goal: { objective: "Ship the mobile goal control.", status: "paused" },
      saveEnabled: false
    });
  });

  it("updates a paused objective with the exact observed revision", async () => {
    const port = goalPort({
      read: async () => goalSnapshot({ status: "paused" }),
      mutate: async ({ request }) => responseFor(request)
    });
    const controller = createController(port, () => "op_browser_goal_update_001");
    await controller.open();

    expect(controller.snapshot().saveDisabledReason).toContain("already saved");
    controller.setDraft("Finish Android release validation.");
    await controller.save();

    expect(port.mutate.mock.calls[0]?.[0].request).toEqual({
      operation_id: "op_browser_goal_update_001",
      kind: "goal",
      action: "set",
      objective: "Finish Android release validation.",
      expected_goal_revision: initialRevision
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "updated",
      goal: { objective: "Finish Android release validation.", status: "paused" }
    });
  });

  it("allows pause during an active turn and does not expose it as interrupt", async () => {
    const port = goalPort({
      read: async () => goalSnapshot({ status: "active" }),
      mutate: async ({ request }) => responseFor(request)
    });
    const controller = createController(
      port,
      () => "op_browser_goal_pause_001",
      context({ turnState: "in_progress" })
    );
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      draftEnabled: false,
      saveEnabled: false,
      pause: { enabled: true },
      resume: { enabled: false },
      complete: { enabled: false },
      clear: { enabled: false }
    });
    expect(controller.snapshot().actionGuidance).toContain("does not interrupt");
    await controller.pause();

    expect(port.mutate.mock.calls[0]?.[0].request).toMatchObject({
      action: "pause",
      objective: null,
      expected_goal_revision: initialRevision
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      statusDetail: "The current turn was not interrupted.",
      goal: { status: "paused" }
    });
  });

  it.each(["in_progress", "waiting_for_input", "waiting_for_approval", "unknown"] as const)(
    "blocks every idle-only action while turn state is %s",
    async (turnState) => {
      const port = goalPort({ read: async () => goalSnapshot({ status: "paused" }) });
      const controller = createController(port, undefined, context({ turnState }));
      await controller.open();

      expect(controller.snapshot().pause.enabled).toBe(false);
      expect(controller.snapshot().resume.enabled).toBe(false);
      expect(controller.snapshot().complete.enabled).toBe(false);
      expect(controller.snapshot().clear.enabled).toBe(false);
      expect(controller.snapshot().saveEnabled).toBe(false);
      controller.beginConfirmation("resume");
      await controller.confirmAction();
      expect(port.mutate).not.toHaveBeenCalled();
    }
  );

  it.each(["paused", "blocked"] as const)(
    "requires confirmation and reports accepted-only resume from %s",
    async (status) => {
      const response = createDeferred<GoalControlSnapshot>();
      const port = goalPort({
        read: async () => goalSnapshot({ status }),
        mutate: async () => response.promise
      });
      const controller = createController(port, () => `op_browser_goal_resume_${status}_001`);
      await controller.open();

      expect(controller.snapshot().resume.enabled).toBe(true);
      const confirming = controller.beginConfirmation("resume");
      expect(confirming).toMatchObject({
        phase: "confirming",
        confirmation: {
          action: "resume",
          title: "Resume agentic goal?",
          confirmEnabled: true
        }
      });
      expect(port.mutate).not.toHaveBeenCalled();
      const first = controller.confirmAction();
      const second = controller.confirmAction();
      expect(port.mutate).toHaveBeenCalledTimes(1);
      response.resolve(goalSnapshot({ status: "active", revision: changedRevision }));
      await first;
      await second;

      expect(controller.snapshot()).toMatchObject({
        phase: "resume_accepted",
        status: "Goal resume accepted",
        goal: { status: "active" },
        confirmation: null
      });
      expect(controller.snapshot().statusDetail).toContain("timeline");
    }
  );

  it.each(["active", "usage_limited", "budget_limited", "complete"] as const)(
    "does not permit resume from runtime status %s",
    async (status) => {
      const port = goalPort({ read: async () => goalSnapshot({ status }) });
      const controller = createController(port);
      await controller.open();

      expect(controller.snapshot().resume.enabled).toBe(false);
      controller.beginConfirmation("resume");
      await controller.confirmAction();
      expect(port.mutate).not.toHaveBeenCalled();
    }
  );

  it("requires and can cancel a complete confirmation before one exact POST", async () => {
    const port = goalPort({
      read: async () => goalSnapshot({ status: "paused" }),
      mutate: async ({ request }) => responseFor(request)
    });
    const controller = createController(port, () => "op_browser_goal_complete_001");
    await controller.open();

    controller.beginConfirmation("complete");
    expect(controller.snapshot().confirmation).toMatchObject({
      action: "complete",
      title: "Mark goal complete?"
    });
    expect(controller.cancelConfirmation()).toMatchObject({ confirmation: null, phase: "ready" });
    expect(port.mutate).not.toHaveBeenCalled();

    controller.beginConfirmation("complete");
    await controller.confirmAction();
    expect(port.mutate.mock.calls[0]?.[0].request.action).toBe("complete");
    expect(controller.snapshot()).toMatchObject({ phase: "completed", goal: { status: "complete" } });
  });

  it("requires clear confirmation and correlates an exact null goal response", async () => {
    const port = goalPort({
      read: async () => goalSnapshot({ status: "complete" }),
      mutate: async ({ request }) => responseFor(request)
    });
    const controller = createController(port, () => "op_browser_goal_clear_001");
    await controller.open();

    controller.beginConfirmation("clear");
    expect(controller.snapshot().confirmation).toMatchObject({
      action: "clear",
      title: "Clear this goal?",
      tone: "danger"
    });
    await controller.confirmAction();

    expect(port.mutate.mock.calls[0]?.[0].request).toMatchObject({
      action: "clear",
      objective: null,
      expected_goal_revision: initialRevision
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "cleared",
      goal: null,
      draft: "",
      saveLabel: "Create paused goal"
    });
  });

  it("cancels confirmation when current authority no longer permits it", async () => {
    const controller = createController(goalPort({ read: async () => goalSnapshot({ status: "paused" }) }));
    await controller.open();
    controller.beginConfirmation("resume");

    const view = controller.updateContext(context({ writeCause: "read_only_access" }));
    expect(view).toMatchObject({
      confirmation: null,
      resume: { enabled: false, disabledReason: "Read-only access cannot change the goal." }
    });
  });

  it.each(["unknown", "conflict"] as const)(
    "keeps a server %s uncertainty visible and locks every mutation",
    async (phase) => {
      const port = goalPort({
        read: async () => goalSnapshot({ status: "paused", uncertain: uncertainMutation(phase) })
      });
      const controller = createController(port);
      await controller.open();

      expect(controller.snapshot()).toMatchObject({
        phase: phase === "unknown" ? "uncertain_unknown" : "uncertain_conflict",
        goal: { objective },
        uncertainty: {
          action: "resume",
          phase,
          requestedStatus: "active"
        },
        draftEnabled: false,
        saveEnabled: false,
        pause: { enabled: false },
        resume: { enabled: false },
        complete: { enabled: false },
        clear: { enabled: false },
        refreshEnabled: true
      });
      expect(JSON.stringify(controller.snapshot())).not.toContain(initialRevision);
    }
  );

  it("locks an ambiguous submit outcome and reconciles only through a fresh GET", async () => {
    let reads = 0;
    const port = goalPort({
      read: async () => {
        reads += 1;
        return reads === 1
          ? goalSnapshot({ status: "paused" })
          : goalSnapshot({ status: "active", revision: changedRevision });
      },
      mutate: async () => {
        throw csrfApiError("operation_timeout", false);
      }
    });
    const controller = createController(port);
    await controller.open();
    controller.beginConfirmation("resume");
    await controller.confirmAction();

    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      saveEnabled: false,
      refreshEnabled: true
    });
    await controller.confirmAction();
    expect(port.mutate).toHaveBeenCalledTimes(1);
    await controller.refresh();
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({ phase: "ready", goal: { status: "active" } });
  });

  it("requires refresh for a safe known conflict and permits an explicit retry after it", async () => {
    let reads = 0;
    let attempts = 0;
    const port = goalPort({
      read: async () => {
        reads += 1;
        return goalSnapshot({ status: "paused", revision: reads === 1 ? initialRevision : changedRevision });
      },
      mutate: async ({ request }) => {
        attempts += 1;
        if (attempts === 1) throw csrfApiError("operation_conflict", true);
        return responseFor(request, "c".repeat(64));
      }
    });
    const controller = createController(port, () => `op_browser_goal_conflict_${attempts + 1}`);
    await controller.open();
    controller.setDraft("Updated after conflict.");
    await controller.save();

    expect(controller.snapshot()).toMatchObject({
      phase: "mutate_failed",
      saveEnabled: false,
      refreshEnabled: true
    });
    await controller.refresh();
    controller.setDraft("Updated after conflict.");
    await controller.save();
    expect(port.mutate).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().phase).toBe("updated");
  });

  it("permits a manual retry only for a typed retryable pre-mutation failure", async () => {
    let attempts = 0;
    const port = goalPort({
      read: async () => goalSnapshot({ status: "paused" }),
      mutate: async ({ request }) => {
        attempts += 1;
        if (attempts === 1) throw csrfApiError("service_overloaded", true);
        return responseFor(request);
      }
    });
    const controller = createController(port, () => `op_browser_goal_overload_${attempts + 1}`);
    await controller.open();
    controller.setDraft("Retry this paused goal once.");
    await controller.save();

    expect(controller.snapshot()).toMatchObject({ phase: "mutate_failed", saveEnabled: true });
    await controller.save();
    expect(port.mutate).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().phase).toBe("updated");
  });

  it.each([
    goalSnapshot({ status: "paused", uncertain: uncertainMutation("unknown") }),
    goalSnapshot({ status: "active", revision: initialRevision }),
    { goal: null, uncertain_mutation: null, private: "not allowed" }
  ])("fails closed when a successful create response does not correlate", async (candidate) => {
    const port = goalPort({
      read: async () => goalSnapshot({ noGoal: true }),
      mutate: async () => candidate
    });
    const controller = createController(port);
    await controller.open();
    controller.setDraft("Create a paused goal.");
    await controller.save();

    expect(controller.snapshot()).toMatchObject({ phase: "outcome_unknown", saveEnabled: false });
  });

  it.each([
    {
      action: "set" as const,
      initialStatus: "paused" as const,
      response: goalSnapshot({
        objective: "Correlate every goal action.",
        status: "paused",
        revision: initialRevision
      })
    },
    {
      action: "pause" as const,
      initialStatus: "active" as const,
      response: goalSnapshot({
        objective: "A different observed objective.",
        status: "paused",
        revision: changedRevision
      })
    },
    {
      action: "resume" as const,
      initialStatus: "paused" as const,
      response: goalSnapshot({ status: "active", revision: initialRevision })
    },
    {
      action: "complete" as const,
      initialStatus: "paused" as const,
      response: goalSnapshot({ status: "paused", revision: changedRevision })
    },
    {
      action: "clear" as const,
      initialStatus: "paused" as const,
      response: goalSnapshot({ status: "paused", revision: changedRevision })
    }
  ])("fails closed when a successful $action response violates action correlation", async ({
    action,
    initialStatus,
    response
  }) => {
    const port = goalPort({
      read: async () => goalSnapshot({ status: initialStatus }),
      mutate: async () => response
    });
    const controller = createController(port);
    await controller.open();

    if (action === "set") {
      controller.setDraft("Correlate every goal action.");
      await controller.save();
    } else if (action === "pause") {
      await controller.pause();
    } else {
      controller.beginConfirmation(action);
      await controller.confirmAction();
    }

    expect(port.mutate).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      saveEnabled: false,
      refreshEnabled: true
    });
  });

  it("preserves readable goal truth while write authority is read-only", async () => {
    const port = goalPort({ read: async () => goalSnapshot({ status: "paused" }) });
    const controller = createController(port, undefined, context({ writeCause: "read_only_access" }));
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      goal: { objective },
      draftEnabled: false,
      saveEnabled: false,
      saveDisabledReason: "Read-only access cannot change the goal.",
      pause: { enabled: false },
      resume: { enabled: false }
    });
    await controller.pause();
    expect(port.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ["host_lock_pending", "A remote-write lock request is being confirmed."],
    ["host_lock_unconfirmed", "The last remote-write lock outcome is unconfirmed. Refresh HostDeck."],
    ["host_locked", "Remote writes are locked on the laptop."],
    ["csrf_not_ready", "Secure write setup is not ready."],
    ["host_not_ready", "Laptop write services are not ready."]
  ] as const)("blocks every action when write authority reports %s", async (writeCause, reason) => {
    const port = goalPort({ read: async () => goalSnapshot({ status: "paused" }) });
    const controller = createController(port, undefined, context({ writeCause }));
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      saveDisabledReason: reason,
      resume: { enabled: false, disabledReason: reason },
      complete: { enabled: false, disabledReason: reason },
      clear: { enabled: false, disabledReason: reason }
    });
  });

  it("removes private goal and target truth immediately on disclosure loss", async () => {
    const port = goalPort({ read: async () => goalSnapshot({ status: "paused" }) });
    const controller = createController(port);
    await controller.open();

    const hidden = controller.updateContext(context({ canRead: false }));
    expect(hidden).toMatchObject({
      visible: false,
      sheetOpen: false,
      targetLabel: null,
      goal: null,
      draft: ""
    });
  });

  it("suppresses late read and mutation results after target authority changes", async () => {
    const read = createDeferred<GoalControlSnapshot>();
    const readPort = goalPort({ read: async () => read.promise });
    const readController = createController(readPort);
    const opening = readController.open();
    readController.updateContext(context({ targetState: "stale" }));
    read.resolve(goalSnapshot({ status: "paused" }));
    await opening;
    expect(readController.snapshot().goal).toBeNull();

    const mutation = createDeferred<GoalControlSnapshot>();
    const mutationPort = goalPort({
      read: async () => goalSnapshot({ status: "paused" }),
      mutate: async () => mutation.promise
    });
    const mutationController = createController(mutationPort);
    await mutationController.open();
    mutationController.setDraft("Late mutation must not install.");
    const saving = mutationController.save();
    mutationController.updateContext(context({ canRead: false }));
    mutation.resolve(goalSnapshot({ objective: "Late mutation must not install.", status: "paused", revision: changedRevision }));
    await saving;
    expect(mutationController.snapshot()).toMatchObject({ visible: false, goal: null });
  });

  it("distinguishes unsupported and retryable goal read failures", async () => {
    const unsupported = createController(
      goalPort({ read: async () => { throw httpApiError("capability_unavailable", false); } })
    );
    await unsupported.open();
    expect(unsupported.snapshot()).toMatchObject({
      phase: "unsupported",
      actionEnabled: true,
      refreshEnabled: true
    });

    let reads = 0;
    const retryable = createController(
      goalPort({
        read: async () => {
          reads += 1;
          if (reads === 1) throw httpApiError("service_overloaded", true);
          return goalSnapshot({ status: "paused" });
        }
      })
    );
    await retryable.open();
    expect(retryable.snapshot().phase).toBe("read_failed");
    await retryable.refresh();
    expect(retryable.snapshot()).toMatchObject({ phase: "ready", goal: { status: "paused" } });
  });

  it("fails closed when the secure operation-id factory does not produce a valid id", async () => {
    const port = goalPort({ read: async () => goalSnapshot({ noGoal: true }) });
    const controller = createController(port, () => "invalid id");
    await controller.open();
    controller.setDraft("Create safely.");
    await controller.save();

    expect(controller.snapshot()).toMatchObject({
      phase: "mutate_failed",
      saveEnabled: false,
      refreshEnabled: true
    });
    expect(port.mutate).not.toHaveBeenCalled();
  });

  it("prevents dismissal while submitting and closes the owner idempotently", async () => {
    const response = createDeferred<GoalControlSnapshot>();
    const controller = createController(
      goalPort({
        read: async () => goalSnapshot({ status: "paused" }),
        mutate: async () => response.promise
      })
    );
    await controller.open();
    controller.setDraft("Close while pending.");
    const saving = controller.save();

    expect(controller.dismiss().sheetOpen).toBe(true);
    const closed = controller.close();
    expect(closed).toMatchObject({ visible: false, sheetOpen: false });
    expect(controller.close()).toBe(closed);
    response.resolve(goalSnapshot({ objective: "Close while pending.", status: "paused", revision: changedRevision }));
    await saving;
    expect(controller.snapshot()).toBe(closed);
  });
});

function createController(
  port: ReturnType<typeof goalPort>,
  createOperationId: (() => string) | undefined = () => "op_browser_goal_default_001",
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
        (async ({ request }) => responseFor(request))
    )
  };
}

function goalSnapshot(
  input: Readonly<{
    noGoal?: boolean;
    objective?: string | undefined;
    status?: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete" | undefined;
    revision?: string | undefined;
    uncertain?: unknown;
  }> = {}
): GoalControlSnapshot {
  return goalControlSnapshotSchema.parse({
    goal: input.noGoal === true
      ? null
      : goalValue({
          objective: input.objective,
          status: input.status,
          revision: input.revision
        }),
    uncertain_mutation: input.uncertain ?? null
  });
}

function goalValue(
  input: Readonly<{
    objective?: string | undefined;
    status?: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete" | undefined;
    revision?: string | undefined;
  }> = {}
) {
  return {
    revision: input.revision ?? initialRevision,
    objective: input.objective ?? objective,
    status: input.status ?? "paused",
    token_budget: 20_000,
    tokens_used: 1_200,
    time_used_seconds: 75.5,
    created_at: timestamp,
    updated_at: input.revision === undefined || input.revision === initialRevision ? timestamp : laterTimestamp
  };
}

function uncertainMutation(phase: "unknown" | "conflict") {
  return {
    action: "resume",
    phase,
    requested_at: laterTimestamp,
    baseline_revision: initialRevision,
    requested_objective: null,
    requested_status: "active",
    error: apiError(phase === "unknown" ? "unknown_error" : "operation_conflict", false)
  };
}

function responseFor(request: GoalMutationRequest, revision = changedRevision): GoalControlSnapshot {
  if (request.action === "clear") return goalSnapshot({ noGoal: true });
  return goalSnapshot({
    objective: request.action === "set" ? (request.objective as string) : objective,
    status:
      request.action === "resume"
        ? "active"
        : request.action === "complete"
          ? "complete"
          : "paused",
    revision
  });
}

function context(
  input: Readonly<{
    writeCause?: BrowserConnectionWriteBlockCause;
    canRead?: boolean;
    accessState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    sessionState?: "active" | "incompatible";
    freshness?: "current" | "stale";
    turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
  }> = {}
): GoalControlContext {
  const sessionState = input.sessionState ?? "active";
  const freshness = input.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: "thread-private-goal-component",
    cwd: "/private/goal-component",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: sessionState,
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/goal-component",
    model: "runtime-a",
    settings: null,
    goal: { objective, state: "paused" },
    recent_summary: "Validate structured goal control.",
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
  const snapshotValue: BrowserConnectionSnapshot = Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: input.canRead === false ? "access_limited" : "ready",
    access: resource(input.accessState ?? "current", pairedAccess(input.canRead ?? true)),
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
  });
  return Object.freeze({ snapshot: snapshotValue });
}

function pairedAccess(canRead: boolean) {
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
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-goal-component-private",
    permission: "write",
    device_expires_at: "2026-10-26T00:30:00.000Z",
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

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return { code, message: "Bounded goal fixture error.", retryable };
}

function httpApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "goal_read",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
}

function csrfApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserCsrfError({
    reason: "api_error",
    operation: "mutation",
    routeId: "goal_mutate",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
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
