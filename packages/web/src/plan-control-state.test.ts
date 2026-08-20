import {
  type ApiErrorEnvelope,
  managedSessionProjectionSchema,
  type PlanControlSnapshot,
  planControlSnapshotSchema,
  type SelectedSessionDetailResponse,
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
import { HostDeckBrowserHttpError } from "./http-client.js";
import {
  createPlanControlController,
  type PlanControlContext,
  type PlanControlPort
} from "./plan-control-state.js";

const sessionId = "sess_plan_component_001" as SessionId;
const timestamp = "2026-07-26T01:00:00.000Z";
const catalogRevision = "c".repeat(64);

describe("plan-control state", () => {
  it("loads exact catalog, current, pending, and execution truth without exposing internal ids", async () => {
    const controller = createController(planPort({ read: async () => snapshot() }));

    const loading = controller.open();
    expect(controller.snapshot()).toMatchObject({ phase: "loading", sheetOpen: true });
    const view = await loading;

    expect(view).toMatchObject({
      phase: "ready",
      targetLabel: "android-plan-release",
      catalogObservedAt: timestamp,
      current: {
        state: "confirmed",
        mode: "default",
        label: "Default",
        runtimeModel: "runtime-current",
        effort: "high"
      },
      pending: null,
      execution: {
        state: "idle",
        evidence: "none",
        summary: null
      },
      selectedMode: "default",
      submitEnabled: false
    });
    expect(view.modes).toHaveLength(2);
    expect(view.modes.find((mode) => mode.mode === "plan")).toMatchObject({
      presetModel: "runtime-plan",
      presetEffort: "medium"
    });
    expect(JSON.stringify(view)).not.toMatch(/catalog_revision|revision|operation_id|turn_id/u);
  });

  it("keeps unknown current mode wholly unknown and requires an explicit local choice", async () => {
    const controller = createController(planPort({ read: async () => snapshot({ currentUnknown: true }) }));
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      status: "Current Plan mode unknown",
      current: {
        state: "unknown",
        mode: null,
        runtimeModel: null,
        effort: null,
        observedAt: null
      },
      selectedMode: null,
      submitEnabled: false
    });
    expect(controller.snapshot().modes.every((mode) => !mode.isCurrent)).toBe(true);
    expect(controller.selectMode("plan")).toMatchObject({ selectedMode: "plan", submitEnabled: true });
  });

  it("discards an unsubmitted local choice when the sheet is dismissed", async () => {
    const port = planPort({ read: async () => snapshot() });
    const controller = createController(port);
    await controller.open();
    expect(controller.selectMode("plan")).toMatchObject({ selectedMode: "plan", submitEnabled: true });

    expect(controller.dismiss()).toMatchObject({ sheetOpen: false, selectedMode: null });
    await controller.open();
    expect(controller.snapshot()).toMatchObject({
      sheetOpen: true,
      selectedMode: "default",
      submitEnabled: false
    });
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("stages Plan once for the next turn while active execution remains independent", async () => {
    const response = createDeferred<PlanControlSnapshot>();
    const port = planPort({
      read: async () => snapshot({ execution: execution("active", "plan_item") }),
      select: async () => response.promise
    });
    const controller = createController(port, () => "op_browser_plan_submit_once_001");
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      execution: { state: "active", evidence: "plan_item" },
      selectionEnabled: true
    });
    controller.selectMode("plan");
    const first = controller.submit();
    const second = controller.submit();

    expect(controller.snapshot()).toMatchObject({ phase: "submitting", closeDisabled: true });
    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.select.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      request: {
        operation_id: "op_browser_plan_submit_once_001",
        kind: "plan",
        action: "enter",
        expected_pending_revision: null
      },
      signal: expect.any(AbortSignal)
    });
    response.resolve(
      snapshot({
        execution: execution("active", "plan_item"),
        pending: pending({ operationId: "op_browser_plan_submit_once_001", mode: "plan" })
      })
    );
    await first;
    await second;

    expect(controller.snapshot()).toMatchObject({
      phase: "staged",
      status: "Plan staged for next turn",
      statusDetail: expect.stringContaining("current turn is unchanged"),
      current: { mode: "default" },
      pending: { mode: "plan", phase: "pending" },
      execution: { state: "active" },
      submitEnabled: false
    });
  });

  it("clears one exact pending revision by selecting confirmed current mode", async () => {
    const initial = snapshot({
      pending: pending({ operationId: "op_plan_pending_clear_001", mode: "plan", revision: 7 })
    });
    const port = planPort({ read: async () => initial, select: async () => snapshot() });
    const controller = createController(port, () => "op_browser_plan_clear_001");
    await controller.open();

    expect(controller.snapshot()).toMatchObject({ selectedMode: "plan", submitEnabled: false });
    expect(controller.selectMode("default")).toMatchObject({
      submitEnabled: true,
      submitLabel: "Clear pending change"
    });
    await controller.submit();

    expect(port.select.mock.calls[0]?.[0].request).toEqual({
      operation_id: "op_browser_plan_clear_001",
      kind: "plan",
      action: "exit",
      expected_pending_revision: 7
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "cleared",
      status: "Pending Plan change cleared",
      pending: null,
      current: { mode: "default" },
      submitEnabled: false
    });
  });

  it("distinguishes already staged from a replaceable conflict", async () => {
    const alreadyStaged = createController(
      planPort({
        read: async () => snapshot({ pending: pending({ operationId: "op_plan_staged_001", mode: "plan" }) })
      })
    );
    await alreadyStaged.open();
    expect(alreadyStaged.snapshot()).toMatchObject({
      selectedMode: "plan",
      submitEnabled: false,
      selectionDisabledReason: "This mode is already staged for the next turn."
    });

    const port = planPort({
      read: async () =>
        snapshot({
          pending: pending({
            operationId: "op_plan_conflict_001",
            mode: "plan",
            revision: 11,
            phase: "conflict"
          })
        }),
      select: async ({ request }) =>
        snapshot({
          pending: pending({ operationId: request.operation_id, mode: "plan", revision: 12 })
        })
    });
    const conflict = createController(port, () => "op_browser_plan_restage_001");
    await conflict.open();
    expect(conflict.snapshot()).toMatchObject({
      phase: "conflict",
      selectionEnabled: true,
      submitEnabled: true,
      submitLabel: "Restage for next turn"
    });
    await conflict.submit();
    expect(port.select.mock.calls[0]?.[0].request.expected_pending_revision).toBe(11);
    expect(conflict.snapshot().phase).toBe("staged");
  });

  it.each(["dispatching", "awaiting_confirmation", "unknown"] as const)(
    "keeps %s pending state visible and nonreplaceable",
    async (phase) => {
      const controller = createController(
        planPort({
          read: async () =>
            snapshot({
              pending: pending({ operationId: `op_plan_${phase}_001`, mode: "plan", phase })
            })
        })
      );
      await controller.open();

      expect(controller.snapshot().pending).toMatchObject({
        phase,
        catalogAvailable: phase !== "unknown",
        resolvedRuntimeModel: "runtime-plan",
        resolvedEffort: "medium"
      });
      expect(controller.snapshot().selectionEnabled).toBe(false);
      expect(controller.snapshot().submitEnabled).toBe(false);
      expect(controller.snapshot().selectionDisabledReason).toContain("being applied or checked");
    }
  );

  it.each([
    ["idle", "none"],
    ["awaiting_evidence", "none"],
    ["active", "plan_update"],
    ["complete", "plan_delta"],
    ["failed", "none"],
    ["interrupted", "plan_item"],
    ["unknown", "none"]
  ] as const)("projects %s execution with %s evidence without changing current mode", async (state, evidence) => {
    const controller = createController(
      planPort({ read: async () => snapshot({ execution: execution(state, evidence) }) })
    );
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      current: { mode: "default" },
      execution: { state, evidence },
      selectedMode: "default"
    });
  });

  it.each([
    ["read_only_access", "Read-only access cannot change Plan mode."],
    ["host_lock_pending", "A remote-write lock request is being confirmed."],
    ["host_lock_unconfirmed", "The last remote-write lock outcome is unconfirmed. Refresh HostDeck."],
    ["host_locked", "Remote writes are locked on the laptop."],
    ["csrf_not_ready", "Secure write setup is not ready."],
    ["host_not_ready", "Laptop write services are not ready."]
  ] as const)("preserves read truth but blocks %s write authority", async (writeCause, reason) => {
    const port = planPort({ read: async () => snapshot() });
    const controller = createController(port, undefined, context({ writeCause }));
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      current: { mode: "default" },
      selectionEnabled: false,
      submitEnabled: false,
      selectionDisabledReason: reason
    });
    controller.selectMode("plan");
    await controller.submit();
    expect(port.select).not.toHaveBeenCalled();
  });

  it.each([
    ["connection_not_current", "Connection state is not current. Refresh before changing Plan mode."],
    ["unpaired", "Pair this phone again to change Plan mode."],
    ["invalid_device", "Pair this phone again to change Plan mode."],
    ["expired_device", "Pair this phone again to change Plan mode."],
    ["revoked_device", "Pair this phone again to change Plan mode."],
    ["permission_denied", "Pair this phone again to change Plan mode."],
    ["host_status_unavailable", "Laptop write services are not ready."]
  ] as const)("blocks the %s authority family before Plan dispatch", async (writeCause, reason) => {
    const port = planPort({ read: async () => snapshot() });
    const controller = createController(port, undefined, context({ writeCause }));
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      visible: true,
      current: { mode: "default" },
      selectionEnabled: false,
      selectionDisabledReason: reason
    });
    await controller.submit();
    expect(port.select).not.toHaveBeenCalled();
  });

  it.each([
    [context({ freshness: "stale" }), "Session state is stale. Refresh before changing Plan mode."],
    [context({ sessionState: "incompatible" }), "Session state is stale. Refresh before changing Plan mode."],
    [context({ sessionState: "archived" }), "Archived sessions cannot stage Plan changes."]
  ] as const)("keeps non-writable session truth readable", async (initialContext, reason) => {
    const port = planPort({ read: async () => snapshot() });
    const controller = createController(port, undefined, initialContext);
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      visible: true,
      current: { mode: "default" },
      selectionEnabled: false,
      submitEnabled: false,
      selectionDisabledReason: reason
    });
    expect(port.select).not.toHaveBeenCalled();
  });

  it("never opens or reads for a mismatched Session Detail target", async () => {
    const port = planPort({ read: async () => snapshot() });
    const controller = createController(port, undefined, context({ targetKind: "mission_control" }));

    expect(controller.snapshot()).toMatchObject({ visible: false, targetLabel: null });
    await controller.open();
    expect(port.read).not.toHaveBeenCalled();
  });

  it("removes private state and suppresses a late read after disclosure loss", async () => {
    const response = createDeferred<PlanControlSnapshot>();
    const controller = createController(planPort({ read: async () => response.promise }));
    const opening = controller.open();

    const hidden = controller.updateContext(context({ canRead: false }));
    expect(hidden).toMatchObject({
      visible: false,
      sheetOpen: false,
      targetLabel: null,
      current: null,
      pending: null,
      execution: null,
      modes: []
    });
    response.resolve(snapshot());
    await opening;
    expect(controller.snapshot()).toBe(hidden);
  });

  it("aborts a dismissed read and suppresses it after a clean reopen owner wins", async () => {
    const first = createDeferred<PlanControlSnapshot>();
    const second = createDeferred<PlanControlSnapshot>();
    let reads = 0;
    const port = planPort({
      read: async () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      }
    });
    const controller = createController(port);

    const firstOpen = controller.open();
    const firstSignal = port.read.mock.calls[0]?.[0].signal;
    expect(controller.dismiss().sheetOpen).toBe(false);
    expect(firstSignal?.aborted).toBe(true);
    const secondOpen = controller.open();
    second.resolve(snapshot({ currentMode: "plan" }));
    await secondOpen;
    expect(controller.snapshot()).toMatchObject({
      sheetOpen: true,
      current: { mode: "plan" },
      selectedMode: "plan"
    });

    first.resolve(snapshot({ pending: pending({ operationId: "op_stale_plan_read_001", mode: "default" }) }));
    await firstOpen;
    expect(controller.snapshot()).toMatchObject({
      current: { mode: "plan" },
      pending: null,
      selectedMode: "plan"
    });
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("invalidates same-target reads and writes when the authority epoch changes", async () => {
    const readResponse = createDeferred<PlanControlSnapshot>();
    const readPort = planPort({ read: async () => readResponse.promise });
    const reading = createController(readPort);
    const opening = reading.open();

    const readSignal = readPort.read.mock.calls[0]?.[0].signal;
    const readInvalidated = reading.updateContext(context({ epoch: 2 }));
    expect(readSignal?.aborted).toBe(true);
    expect(readInvalidated).toMatchObject({
      phase: "read_failed",
      current: null,
      pending: null,
      execution: null,
      selectionEnabled: false,
      refreshEnabled: true,
      statusDetail: "Session access changed. Check current Plan state."
    });
    readResponse.resolve(snapshot({ currentMode: "plan" }));
    await opening;
    expect(reading.snapshot()).toBe(readInvalidated);

    const writeResponse = createDeferred<PlanControlSnapshot>();
    const writePort = planPort({
      read: async () => snapshot(),
      select: async () => writeResponse.promise
    });
    const writing = createController(writePort);
    await writing.open();
    writing.selectMode("plan");
    const selecting = writing.submit();

    const writeSignal = writePort.select.mock.calls[0]?.[0].signal;
    const writeInvalidated = writing.updateContext(context({ epoch: 2 }));
    expect(writeSignal?.aborted).toBe(true);
    expect(writeInvalidated).toMatchObject({
      phase: "outcome_unknown",
      current: null,
      pending: null,
      execution: null,
      selectionEnabled: false,
      refreshEnabled: true
    });
    writeResponse.resolve(
      snapshot({ pending: pending({ operationId: "op_browser_plan_default_001", mode: "plan" }) })
    );
    await selecting;
    expect(writing.snapshot()).toBe(writeInvalidated);
  });

  it("cancels an in-flight selection on write-authority loss and latches unknown outcome", async () => {
    const response = createDeferred<PlanControlSnapshot>();
    const port = planPort({ read: async () => snapshot(), select: async () => response.promise });
    const controller = createController(port);
    await controller.open();
    controller.selectMode("plan");
    const selecting = controller.submit();

    const downgraded = controller.updateContext(context({ writeCause: "host_locked" }));
    expect(port.select.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(downgraded).toMatchObject({
      phase: "outcome_unknown",
      selectionEnabled: false,
      submitEnabled: false,
      selectionDisabledReason: "Remote writes are locked on the laptop."
    });
    response.resolve(
      snapshot({ pending: pending({ operationId: "op_browser_plan_default_001", mode: "plan" }) })
    );
    await selecting;
    expect(controller.snapshot()).toBe(downgraded);
  });

  it("latches an ambiguous selection and reconciles only with one fresh GET", async () => {
    let reads = 0;
    const port = planPort({
      read: async () => {
        reads += 1;
        return reads === 1
          ? snapshot()
          : snapshot({ pending: pending({ operationId: "op_server_plan_after_loss_001", mode: "plan" }) });
      },
      select: async () => {
        throw new Error("private Plan transport failure");
      }
    });
    const controller = createController(port);
    await controller.open();
    controller.selectMode("plan");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      submitEnabled: false,
      refreshEnabled: true
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private Plan transport failure");
    await controller.refresh();
    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      phase: "staged",
      pending: { mode: "plan", phase: "pending" }
    });
  });

  it.each([
    ["wrong operation", pending({ operationId: "op_other_plan_001", mode: "plan" })],
    ["wrong mode", pending({ operationId: "op_browser_plan_expected_001", mode: "default" })],
    ["dispatching", pending({ operationId: "op_browser_plan_expected_001", mode: "plan", phase: "dispatching" })],
    ["stale revision", pending({ operationId: "op_browser_plan_expected_001", mode: "plan", revision: 5 })]
  ] as const)("fails closed on an uncorrelated 200 response: %s", async (_label, responsePending) => {
    const initial = snapshot({
      pending: pending({ operationId: "op_plan_baseline_001", mode: "default", revision: 5, phase: "conflict" })
    });
    const port = planPort({
      read: async () => initial,
      select: async () => snapshot({ pending: responsePending })
    });
    const controller = createController(port, () => "op_browser_plan_expected_001");
    await controller.open();
    controller.selectMode("plan");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      pending: { mode: "default", phase: "conflict" },
      submitEnabled: false
    });
  });

  it("distinguishes an already-confirmed race from a staged selection", async () => {
    const port = planPort({
      read: async () => snapshot({ currentUnknown: true }),
      select: async () => snapshot({ currentMode: "plan" })
    });
    const controller = createController(port, () => "op_browser_plan_current_race_001");
    await controller.open();
    controller.selectMode("plan");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "already_current",
      status: "Plan already confirmed",
      pending: null,
      current: { mode: "plan" }
    });
  });

  it("distinguishes unsupported and malformed reads without retaining candidate data", async () => {
    for (const code of ["capability_unavailable", "incompatible_runtime"] as const) {
      const unsupported = createController(
        planPort({ read: async () => { throw httpApiError(code, false); } })
      );
      await unsupported.open();
      expect(unsupported.snapshot()).toMatchObject({
        phase: "unsupported",
        status: "Plan control unsupported",
        current: null,
        submitEnabled: false,
        refreshEnabled: true
      });
    }

    const malformed = createController(
      planPort({ read: async () => ({ ...snapshot(), modes: [] }) })
    );
    await malformed.open();
    expect(malformed.snapshot()).toMatchObject({
      phase: "read_failed",
      current: null,
      pending: null,
      execution: null,
      modes: [],
      submitEnabled: false
    });
  });

  it("fails closed before dispatch when secure operation-id generation is invalid", async () => {
    const port = planPort({ read: async () => snapshot() });
    const controller = createController(port, () => "invalid-operation-id");
    await controller.open();
    controller.selectMode("plan");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "select_failed",
      submitEnabled: false,
      refreshEnabled: true,
      statusDetail: "Secure Plan selection is unavailable. Reload HostDeck."
    });
    expect(port.select).not.toHaveBeenCalled();
  });

  it("requires refresh after safe conflict, permits overload retry, and treats unsafe conflict as unknown", async () => {
    const conflict = createController(
      planPort({
        read: async () => snapshot(),
        select: async () => { throw csrfApiError("operation_conflict", true); }
      })
    );
    await conflict.open();
    conflict.selectMode("plan");
    await conflict.submit();
    expect(conflict.snapshot()).toMatchObject({
      phase: "select_failed",
      submitEnabled: false,
      refreshEnabled: true
    });

    let attempts = 0;
    const overload = createController(
      planPort({
        read: async () => snapshot(),
        select: async ({ request }) => {
          attempts += 1;
          if (attempts === 1) throw csrfApiError("service_overloaded", true);
          return snapshot({
            pending: pending({ operationId: request.operation_id, mode: "plan" })
          });
        }
      }),
      () => `op_browser_plan_overload_${attempts + 1}`
    );
    await overload.open();
    overload.selectMode("plan");
    await overload.submit();
    expect(overload.snapshot()).toMatchObject({ phase: "select_failed", submitEnabled: true });
    await overload.submit();
    expect(overload.snapshot().phase).toBe("staged");

    const unsafe = createController(
      planPort({
        read: async () => snapshot(),
        select: async () => { throw csrfApiError("operation_conflict", false); }
      })
    );
    await unsafe.open();
    unsafe.selectMode("plan");
    await unsafe.submit();
    expect(unsafe.snapshot().phase).toBe("outcome_unknown");
  });

  it.each(["audit_unavailable", "internal_error", "operation_timeout", "protocol_error", "unknown_error"] as const)(
    "treats typed %s mutation failure as an ambiguous outcome",
    async (code) => {
      const controller = createController(
        planPort({
          read: async () => snapshot(),
          select: async () => { throw csrfApiError(code, false); }
        })
      );
      await controller.open();
      controller.selectMode("plan");
      await controller.submit();

      expect(controller.snapshot()).toMatchObject({
        phase: "outcome_unknown",
        submitEnabled: false,
        refreshEnabled: true,
        statusDetail: expect.stringContaining("will not retry automatically")
      });
      expect(JSON.stringify(controller.snapshot())).not.toContain("Private Plan fixture error");
    }
  );

  it.each([
    "host_locked",
    "insecure_transport",
    "invalid_origin",
    "permission_denied",
    "read_only",
    "session_not_found",
    "session_not_writable",
    "stale_session",
    "validation_error"
  ] as const)("requires a fresh read after typed %s selection rejection", async (code) => {
    const controller = createController(
      planPort({
        read: async () => snapshot(),
        select: async () => { throw csrfApiError(code, true); }
      })
    );
    await controller.open();
    controller.selectMode("plan");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "select_failed",
      selectionEnabled: false,
      submitEnabled: false,
      refreshEnabled: true
    });
    expect(controller.selectMode("default")).toBe(controller.snapshot());
    expect(controller.snapshot().submitEnabled).toBe(false);
  });

  it("prevents ordinary dismissal while submitting and closes the owner idempotently", async () => {
    const response = createDeferred<PlanControlSnapshot>();
    const controller = createController(
      planPort({ read: async () => snapshot(), select: async () => response.promise })
    );
    await controller.open();
    controller.selectMode("plan");
    const submitting = controller.submit();

    expect(controller.dismiss().sheetOpen).toBe(true);
    const closed = controller.close();
    expect(closed).toMatchObject({ visible: false, sheetOpen: false });
    expect(controller.close()).toBe(closed);
    response.resolve(snapshot());
    await submitting;
    expect(() => controller.selectMode("default")).not.toThrow();
    expect(controller.snapshot()).toBe(closed);
  });
});

function createController(
  port: ReturnType<typeof planPort>,
  createOperationId: (() => string) | undefined = () => "op_browser_plan_default_001",
  initialContext = context()
) {
  return createPlanControlController({
    sessionId,
    context: initialContext,
    port,
    createOperationId
  });
}

function planPort(overrides: Partial<PlanControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => snapshot())),
    select: vi.fn(
      overrides.select ??
        (async ({ request }) =>
          snapshot({
            pending: pending({
              operationId: request.operation_id,
              mode: request.action === "enter" ? "plan" : "default"
            })
          }))
    )
  };
}

function snapshot(
  input: Readonly<{
    currentUnknown?: boolean;
    currentMode?: "default" | "plan";
    pending?: unknown;
    execution?: unknown;
  }> = {}
): PlanControlSnapshot {
  const currentMode = input.currentMode ?? "default";
  return planControlSnapshotSchema.parse({
    catalog_revision: catalogRevision,
    catalog_observed_at: timestamp,
    current: input.currentUnknown
      ? {
          state: "unknown",
          mode: null,
          runtime_model: null,
          reasoning_effort: null,
          observed_at: null
        }
      : {
          state: "confirmed",
          mode: currentMode,
          runtime_model: currentMode === "plan" ? "runtime-plan" : "runtime-current",
          reasoning_effort: currentMode === "plan" ? "medium" : "high",
          observed_at: timestamp
        },
    pending: input.pending ?? null,
    execution: input.execution ?? execution("idle", "none"),
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

function pending(input: Readonly<{
  operationId: string;
  mode: "default" | "plan";
  revision?: number;
  phase?: "pending" | "dispatching" | "awaiting_confirmation" | "unknown" | "conflict";
}>): unknown {
  const phase = input.phase ?? "pending";
  const dispatched = ["dispatching", "awaiting_confirmation", "unknown"].includes(phase);
  return {
    revision: input.revision ?? 1,
    selection_operation_id: input.operationId,
    mode: input.mode,
    catalog_state: phase === "unknown" ? "unknown" : "available",
    phase,
    selected_at: timestamp,
    turn_id: phase === "awaiting_confirmation" ? "turn-plan-component-001" : null,
    resolved_settings: dispatched
      ? {
          runtime_model: input.mode === "plan" ? "runtime-plan" : "runtime-current",
          reasoning_effort: input.mode === "plan" ? "medium" : "high"
        }
      : null,
    error:
      phase === "unknown" || phase === "conflict"
        ? apiError("operation_conflict", true)
        : null
  };
}

function execution(
  state: "idle" | "awaiting_evidence" | "active" | "complete" | "failed" | "interrupted" | "unknown",
  evidence: "none" | "plan_update" | "plan_item" | "plan_delta"
): unknown {
  if (state === "idle") {
    return { turn_id: null, state, evidence: "none", summary: null, updated_at: null };
  }
  return {
    turn_id: "turn-plan-execution-001",
    state,
    evidence,
    summary: evidence === "none" ? null : "Validate Plan execution without inferring collaboration mode.",
    updated_at: timestamp
  };
}

function context(
  input: Readonly<{
    writeCause?: BrowserConnectionWriteBlockCause;
    canRead?: boolean;
    accessState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    sessionState?: "active" | "archived" | "incompatible";
    freshness?: "current" | "stale";
    targetKind?: "mission_control" | "session_detail";
    epoch?: number;
  }> = {}
): PlanControlContext {
  const sessionState = input.sessionState ?? "active";
  const freshness = input.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-plan-release",
    codex_thread_id: "thread-private-plan-component",
    cwd: "/private/plan-component",
    runtime_source: "codex_app_server",
    runtime_version: "0.148.0",
    created_at: timestamp,
    archived_at: sessionState === "archived" ? timestamp : null,
    session_state: sessionState,
    turn_state: sessionState === "archived" ? "idle" : "in_progress",
    attention: "watch",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/plan-component",
    model: "runtime-current",
    settings: null,
    goal: null,
    recent_summary: "Validate structured Plan control.",
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
  const response: SelectedSessionDetailResponse = sessionState === "archived"
    ? Object.freeze({
        access: Object.freeze({ mode: "paired_write", network_mode: "remote", transport: "https" }),
        session: item
      })
    : selectedSessionDetailResponseSchema.parse({
        access: { mode: "paired_write", network_mode: "remote", transport: "https" },
        session: item
      });
  const writeCause = input.writeCause;
  const snapshotValue: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: input.targetKind === "mission_control"
      ? Object.freeze({ kind: "mission_control" as const })
      : Object.freeze({ kind: "session_detail" as const, sessionId }),
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
    device_id: "device-plan-component-private",
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

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return { code, message: "Private Plan fixture error.", retryable };
}

function httpApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "plan_read",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
}

function csrfApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserCsrfError({
    reason: "api_error",
    operation: "mutation",
    routeId: "plan_select",
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
