import {
  type ApiErrorEnvelope,
  approvalProjectionEventSchema,
  managedSessionProjectionSchema,
  type PendingApproval,
  type PendingApprovalListResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalDecisionClockPort,
  type ApprovalDecisionContext,
  type ApprovalDecisionPort,
  createApprovalDecisionController
} from "./approval-decision-state.js";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

const sessionId = "sess_approval_component_001" as SessionId;
const threadId = "thread-private-approval-component";
const requestId = "string:approval-component-001";
const secondRequestId = "string:approval-component-002";
const timestamp = "2026-07-26T01:00:00.000Z";
const expiry = "2026-07-26T02:00:00.000Z";

describe("approval-decision state", () => {
  it("loads and reconciles one exact event/list request without exposing its route identity", async () => {
    const entry = approval();
    const port = approvalPort({ read: async () => approvalList([entry]) });
    const controller = createController(port, context({ events: [approvalEvent()] }));

    const loading = controller.synchronize();
    expect(controller.snapshot()).toMatchObject({ phase: "loading", busy: true });
    const view = await loading;

    expect(view).toMatchObject({
      phase: "ready",
      status: "Approval required",
      targetLabel: "android-approval-release",
      items: [
        {
          source: "event_and_list",
          action: "Write release marker",
          scope: "Workspace files",
          reason: "The selected task requires a bounded file change.",
          risk: "elevated",
          grantScope: "one_time",
          state: "pending",
          actionable: true,
          approveLabel: "Review & approve",
          approveRequiresConfirmation: true
        }
      ]
    });
    expect(view.items[0]?.handle).toBe("approval-1");
    expect(JSON.stringify(view)).not.toContain(requestId);
    expect(port.read).toHaveBeenCalledWith({ sessionId, signal: expect.any(AbortSignal) });
  });

  it("keeps an event-only request visible but read-only and synthesizes a list-only request", async () => {
    const eventOnly = approvalEvent({ requestId, cursor: 1 });
    const listOnly = approval({ requestId: secondRequestId, risk: "normal" });
    const controller = createController(
      approvalPort({ read: async () => approvalList([listOnly]) }),
      context({ events: [eventOnly] })
    );

    await controller.synchronize();
    expect(controller.snapshot().items).toMatchObject([
      {
        source: "event_only",
        state: "event_only",
        grantScope: null,
        actionable: false,
        disabledReason: "Current approval status has not been verified."
      },
      {
        source: "list_only",
        eventOrder: null,
        state: "pending",
        risk: "normal",
        actionable: true,
        approveLabel: "Approve once"
      }
    ]);
  });

  it("coalesces repeated request events at first order and projects the latest terminal truth", async () => {
    const pending = approvalEvent({ cursor: 4 });
    const approvedEvent = approvalEvent({ cursor: 7, state: "approved", decision: "approve" });
    const controller = createController(
      approvalPort({ read: async () => approvalList([approval({ state: "approved", decision: "approve" })]) }),
      context({ events: [pending, approvedEvent] })
    );

    await controller.synchronize();
    expect(controller.snapshot().items).toHaveLength(1);
    expect(controller.snapshot().items[0]).toMatchObject({
      eventOrder: 4,
      state: "approved",
      stateLabel: "Approved",
      actionable: false,
      decision: "approve"
    });
    expect(controller.lookupEvent(requestId)).toBe(controller.snapshot().items[0]);
  });

  it("fails closed when shared details or terminal outcomes contradict", async () => {
    const detailConflict = createController(
      approvalPort({ read: async () => approvalList([approval({ scope: "Another scope" })]) }),
      context({ events: [approvalEvent()] })
    );
    await detailConflict.synchronize();
    expect(detailConflict.snapshot().items[0]).toMatchObject({
      state: "conflict",
      actionable: false,
      disabledReason: "Approval details conflict. Check current status."
    });

    const terminalConflict = createController(
      approvalPort({ read: async () => approvalList([approval({ state: "denied", decision: "deny" })]) }),
      context({ events: [approvalEvent({ state: "approved", decision: "approve" })] })
    );
    await terminalConflict.synchronize();
    expect(terminalConflict.snapshot().items[0]?.state).toBe("conflict");
  });

  it.each([
    ["responding", null, "Responding"],
    ["approved", "approve", "Approved"],
    ["denied", "deny", "Denied"],
    ["expired", null, "Expired"],
    ["superseded", null, "Superseded"]
  ] as const)("renders %s as exact read-only truth", async (state, decision, stateLabel) => {
    const controller = createController(
      approvalPort({ read: async () => approvalList([approval({ state, decision })]) }),
      context({ events: [] })
    );
    await controller.synchronize();

    expect(controller.snapshot().items[0]).toMatchObject({
      state,
      stateLabel,
      decision,
      actionable: false,
      approveEnabled: false,
      denyEnabled: false
    });
  });

  it("renders a schema-valid session grant as unsupported ongoing policy", async () => {
    const controller = createController(
      approvalPort({ read: async () => approvalList([approval({ grantScope: "session" })]) }),
      context({ events: [] })
    );
    await controller.synchronize();

    expect(controller.snapshot().items[0]).toMatchObject({
      grantScope: "session",
      grantLabel: "Ongoing policy",
      actionable: false,
      disabledReason: "Ongoing policy grants are not supported in HostDeck V1."
    });
  });

  it("sends normal approval directly with one exact target-free body and accepts terminal correlation", async () => {
    const baseline = approval({ risk: "normal" });
    const port = approvalPort({
      read: async () => approvalList([baseline]),
      respond: async ({ request, requestId: exactRequestId }) => {
        expect(exactRequestId).toBe(requestId);
        expect(request).toEqual({
          operation_id: "op_browser_approval_direct_001",
          kind: "approval_response",
          decision: "approve",
          confirm: true
        });
        return terminalResponse(baseline, request.operation_id, "approve");
      }
    });
    const controller = createController(port, context({ events: [] }), {
      createOperationId: () => "op_browser_approval_direct_001"
    });
    await controller.synchronize();
    const handle = requiredItem(controller).handle;

    const view = await controller.approve(handle);
    expect(view).toMatchObject({ phase: "approved", status: "Approved once" });
    expect(controller.snapshot().items[0]).toMatchObject({ state: "approved", decision: "approve" });
    expect(port.respond).toHaveBeenCalledTimes(1);
  });

  it("requires elevated and broad approval confirmation while deny stays direct", async () => {
    for (const risk of ["elevated", "broad"] as const) {
      const baseline = approval({ risk });
      const port = approvalPort({
        read: async () => approvalList([baseline]),
        respond: async ({ request }) => terminalResponse(baseline, request.operation_id, request.decision)
      });
      const controller = createController(port, context({ events: [] }));
      await controller.synchronize();
      const handle = requiredItem(controller).handle;

      await controller.approve(handle);
      expect(port.respond).not.toHaveBeenCalled();
      const confirmation = controller.beginApprove(handle);
      expect(confirmation.confirmation).toMatchObject({
        title: risk === "broad" ? "Approve broad request?" : "Approve elevated request?",
        action: baseline.action,
        scope: baseline.scope,
        reason: baseline.reason,
        riskLabel: risk === "broad" ? "Broad" : "Elevated",
        grantLabel: "One time",
        confirmEnabled: true
      });
      expect(controller.cancelApprove().confirmation).toBeNull();
      expect(port.respond).not.toHaveBeenCalled();

      controller.beginApprove(handle);
      await controller.confirmApprove();
      expect(port.respond).toHaveBeenCalledTimes(1);
    }

    const baseline = approval({ risk: "broad" });
    const denyPort = approvalPort({
      read: async () => approvalList([baseline]),
      respond: async ({ request }) => terminalResponse(baseline, request.operation_id, "deny")
    });
    const denyController = createController(denyPort, context({ events: [] }));
    await denyController.synchronize();
    await denyController.deny(requiredItem(denyController).handle);
    expect(denyController.snapshot()).toMatchObject({ phase: "denied", status: "Denied" });
    expect(denyPort.respond).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate submit, dismissal-through-method churn, and a second approval while one is pending", async () => {
    const response = deferred<unknown>();
    const entries = [approval({ risk: "normal" }), approval({ requestId: secondRequestId, risk: "normal" })];
    const port = approvalPort({
      read: async () => approvalList(entries),
      respond: async () => response.promise
    });
    const controller = createController(port, context({ events: [] }));
    await controller.synchronize();
    const [first, second] = controller.snapshot().items;
    if (first === undefined || second === undefined) throw new Error("Approval fixtures are missing.");

    const submitting = controller.approve(first.handle);
    await controller.approve(first.handle);
    await controller.deny(second.handle);
    expect(port.respond).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({ phase: "submitting", busy: true });
    expect(controller.snapshot().items[1]?.disabledReason).toBe("Another approval decision is being confirmed.");

    const call = port.respond.mock.calls[0]?.[0];
    if (call === undefined) throw new Error("Approval request was not captured.");
    const firstEntry = entries[0];
    if (firstEntry === undefined) throw new Error("Approval fixture is missing.");
    response.resolve(terminalResponse(firstEntry, call.request.operation_id, "approve"));
    await submitting;
    expect(port.respond).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong operation", (baseline: PendingApproval) => terminalResponse(baseline, "op_other_approval_001", "approve")],
    ["wrong request", (baseline: PendingApproval) => terminalResponse(
      approval({ requestId: secondRequestId, risk: baseline.risk }),
      "op_browser_approval_expected_001",
      "approve"
    )],
    ["changed scope", (baseline: PendingApproval) => terminalResponse(
      { ...baseline, scope: "Changed after submit" } as PendingApproval,
      "op_browser_approval_expected_001",
      "approve"
    )],
    ["wrong decision", (baseline: PendingApproval) => terminalResponse(
      baseline,
      "op_browser_approval_expected_001",
      "deny"
    )]
  ] as const)("latches unknown on an uncorrelated 200 response: %s", async (_label, responseFor) => {
    const baseline = approval({ risk: "normal" });
    const controller = createController(
      approvalPort({
        read: async () => approvalList([baseline]),
        respond: async () => responseFor(baseline)
      }),
      context({ events: [] }),
      { createOperationId: () => "op_browser_approval_expected_001" }
    );
    await controller.synchronize();
    await controller.approve(requiredItem(controller).handle);

    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      status: "Decision outcome unknown",
      refreshEnabled: true
    });
    expect(requiredItem(controller).actionable).toBe(false);
  });

  it("latches transport ambiguity until a fresh list proves retry or terminal truth", async () => {
    const baseline = approval({ risk: "normal" });
    let reads = 0;
    const port = approvalPort({
      read: async () => {
        reads += 1;
        return approvalList([reads === 3
          ? approval({ risk: "normal", state: "approved", decision: "approve" })
          : baseline]);
      },
      respond: async () => { throw new Error("private approval transport detail"); }
    });
    const controller = createController(port, context({ events: [] }));
    await controller.synchronize();
    await controller.approve(requiredItem(controller).handle);

    expect(controller.snapshot()).toMatchObject({ phase: "outcome_unknown" });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private approval transport detail");
    await controller.refresh();
    expect(controller.snapshot().phase).toBe("ready");
    expect(requiredItem(controller).actionable).toBe(true);

    await controller.approve(requiredItem(controller).handle);
    await controller.refresh();
    expect(controller.snapshot().items[0]?.state).toBe("approved");
  });

  it.each([
    "approval_not_pending",
    "host_locked",
    "operation_conflict",
    "permission_denied",
    "read_only",
    "service_overloaded",
    "stale_session",
    "validation_error"
  ] as const)("requires one fresh list after known %s rejection", async (code) => {
    const baseline = approval({ risk: "normal" });
    const controller = createController(
      approvalPort({
        read: async () => approvalList([baseline]),
        respond: async () => { throw csrfApiError(code, true); }
      }),
      context({ events: [] })
    );
    await controller.synchronize();
    await controller.approve(requiredItem(controller).handle);
    expect(controller.snapshot()).toMatchObject({ phase: "decision_failed" });
    expect(requiredItem(controller).actionable).toBe(false);

    await controller.refresh();
    expect(requiredItem(controller).actionable).toBe(true);
  });

  it.each(["capability_unavailable", "incompatible_runtime"] as const)(
    "keeps an unsupported %s decision visible and read-only until refresh",
    async (code) => {
      const baseline = approval({ risk: "normal" });
      const controller = createController(
        approvalPort({
          read: async () => approvalList([baseline]),
          respond: async () => { throw csrfApiError(code, false); }
        }),
        context({ events: [] })
      );

      await controller.synchronize();
      await controller.approve(requiredItem(controller).handle);

      expect(controller.snapshot()).toMatchObject({
        phase: "unsupported",
        status: "Approval unsupported",
        statusDetail: "The installed Codex runtime does not support structured approvals.",
        refreshEnabled: true
      });
      expect(requiredItem(controller).actionable).toBe(false);
    }
  );

  it.each(["audit_unavailable", "internal_error", "operation_timeout", "protocol_error", "unknown_error"] as const)(
    "treats typed %s as an ambiguous decision outcome",
    async (code) => {
      const controller = createController(
        approvalPort({
          read: async () => approvalList([approval({ risk: "normal" })]),
          respond: async () => { throw csrfApiError(code, false); }
        }),
        context({ events: [] })
      );
      await controller.synchronize();
      await controller.approve(requiredItem(controller).handle);
      expect(controller.snapshot().phase).toBe("outcome_unknown");
    }
  );

  it("accepts a matching terminal event that arrives while the server response is pending", async () => {
    const baseline = approval({ risk: "normal" });
    const response = deferred<unknown>();
    const port = approvalPort({
      read: async () => approvalList([baseline]),
      respond: async () => response.promise
    });
    const controller = createController(port, context({ events: [approvalEvent({ risk: "normal" })] }));
    await controller.synchronize();
    const deciding = controller.approve(requiredItem(controller).handle);

    controller.updateContext(context({
      events: [
        approvalEvent({ cursor: 1, risk: "normal" }),
        approvalEvent({ cursor: 2, risk: "normal", state: "approved", decision: "approve" })
      ]
    }));
    const call = port.respond.mock.calls[0]?.[0];
    if (call === undefined) throw new Error("Approval request was not captured.");
    response.resolve(terminalResponse(baseline, call.request.operation_id, "approve"));
    await deciding;

    expect(controller.snapshot()).toMatchObject({ phase: "approved" });
    expect(controller.snapshot().items[0]?.state).toBe("approved");
    expect(port.respond).toHaveBeenCalledTimes(1);
  });

  it("invalidates same-target reads and writes on authority epoch change", async () => {
    const readResponse = deferred<unknown>();
    const readPort = approvalPort({ read: async () => readResponse.promise });
    const reading = createController(readPort, context({ events: [] }));
    const loading = reading.synchronize();
    const readSignal = readPort.read.mock.calls[0]?.[0].signal;
    const invalidated = reading.updateContext(context({ epoch: 2, events: [] }));
    expect(readSignal?.aborted).toBe(true);
    expect(invalidated.items).toEqual([]);
    readResponse.resolve(approvalList([approval()]));
    await loading;
    expect(reading.snapshot()).toBe(invalidated);

    const writeResponse = deferred<unknown>();
    const writePort = approvalPort({
      read: async () => approvalList([approval({ risk: "normal" })]),
      respond: async () => writeResponse.promise
    });
    const writing = createController(writePort, context({ events: [] }));
    await writing.synchronize();
    const deciding = writing.approve(requiredItem(writing).handle);
    const writeSignal = writePort.respond.mock.calls[0]?.[0].signal;
    const writeInvalidated = writing.updateContext(context({ epoch: 2, events: [] }));
    expect(writeSignal?.aborted).toBe(true);
    expect(writeInvalidated).toMatchObject({ phase: "outcome_unknown", items: [] });
    const call = writePort.respond.mock.calls[0]?.[0];
    if (call === undefined) throw new Error("Approval request was not captured.");
    writeResponse.resolve(terminalResponse(approval({ risk: "normal" }), call.request.operation_id, "approve"));
    await deciding;
    expect(writing.snapshot()).toBe(writeInvalidated);
  });

  it("aborts an in-flight decision on write or stream loss and preserves authorized read truth", async () => {
    for (const changed of [
      context({ writeCause: "host_locked", events: [] }),
      context({ streamState: "reconnecting", events: [] })
    ]) {
      const response = deferred<unknown>();
      const port = approvalPort({
        read: async () => approvalList([approval({ risk: "normal" })]),
        respond: async () => response.promise
      });
      const controller = createController(port, context({ events: [] }));
      await controller.synchronize();
      const deciding = controller.approve(requiredItem(controller).handle);
      const signal = port.respond.mock.calls[0]?.[0].signal;

      const downgraded = controller.updateContext(changed);
      expect(signal?.aborted).toBe(true);
      expect(downgraded).toMatchObject({ phase: "outcome_unknown" });
      expect(downgraded.items).toHaveLength(1);
      expect(downgraded.items[0]?.actionable).toBe(false);

      response.resolve({});
      await deciding;
      expect(controller.snapshot()).toBe(downgraded);
    }
  });

  it.each([
    ["read_only_access", "Read-only access cannot answer approvals."],
    ["host_lock_pending", "A remote-write lock request is being confirmed."],
    ["host_lock_unconfirmed", "The last remote-write lock outcome is unconfirmed. Refresh HostDeck."],
    ["host_locked", "Remote writes are locked on the laptop."],
    ["csrf_not_ready", "Secure write setup is not ready."],
    ["host_not_ready", "Laptop write services are not ready."]
  ] as const)("preserves list truth but blocks %s", async (writeCause, reason) => {
    const port = approvalPort({ read: async () => approvalList([approval()]) });
    const controller = createController(port, context({ writeCause, events: [] }));
    await controller.synchronize();
    expect(requiredItem(controller)).toMatchObject({ actionable: false, disabledReason: reason });
    await controller.deny(requiredItem(controller).handle);
    expect(port.respond).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", "Wait for current session activity before answering approvals."],
    ["connecting", "Wait for current session activity before answering approvals."],
    ["reconnecting", "Session activity is reconnecting."],
    ["failed", "Live session activity is unavailable."],
    ["closed", "Live session activity is unavailable."]
  ] as const)("blocks decisions while stream is %s", async (streamState, reason) => {
    const controller = createController(
      approvalPort({ read: async () => approvalList([approval()]) }),
      context({ streamState, events: [] })
    );
    await controller.synchronize();
    expect(requiredItem(controller)).toMatchObject({ actionable: false, disabledReason: reason });
  });

  it("removes all private approval state after disclosure loss", async () => {
    const controller = createController(
      approvalPort({ read: async () => approvalList([approval()]) }),
      context({ events: [] })
    );
    await controller.synchronize();
    controller.beginApprove(requiredItem(controller).handle);

    const hidden = controller.updateContext(context({ canRead: false, events: [] }));
    expect(hidden).toMatchObject({
      visible: false,
      targetLabel: null,
      items: [],
      confirmation: null,
      refreshEnabled: false
    });
    expect(controller.lookupEvent(requestId)).toBeNull();
  });

  it("disables locally due approval without inventing expiry and performs one deadline read", async () => {
    const clock = manualClock(Date.parse(timestamp));
    let reads = 0;
    const baseline = approval({ risk: "normal", expiresAt: "2026-07-26T01:00:01.000Z" });
    const port = approvalPort({
      read: async () => {
        reads += 1;
        return approvalList([
          reads === 1 ? baseline : approval({ risk: "normal", expiresAt: baseline.expires_at, state: "expired" })
        ]);
      }
    });
    const controller = createController(port, context({ events: [] }), { clock: clock.port });
    await controller.synchronize();
    expect(requiredItem(controller).state).toBe("pending");

    clock.advance(1_000);
    expect(requiredItem(controller)).toMatchObject({ state: "due", actionable: false, decision: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(requiredItem(controller)).toMatchObject({ state: "expired", decision: null });
    expect(port.respond).not.toHaveBeenCalled();
  });

  it("aborts an event-stale read and accepts only a replacement read for the new fingerprint", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let reads = 0;
    const port = approvalPort({
      read: async () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      }
    });
    const controller = createController(port, context({ events: [approvalEvent()] }));
    const firstRead = controller.synchronize();
    const firstSignal = port.read.mock.calls[0]?.[0].signal;

    controller.updateContext(context({
      events: [approvalEvent(), approvalEvent({ cursor: 2, state: "superseded" })]
    }));
    expect(firstSignal?.aborted).toBe(true);
    const secondRead = controller.synchronize();
    second.resolve(approvalList([approval({ state: "superseded" })]));
    await secondRead;
    first.resolve(approvalList([approval()]));
    await firstRead;

    expect(controller.snapshot().items[0]?.state).toBe("superseded");
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("distinguishes unsupported and malformed reads without retaining candidate data", async () => {
    const unsupported = createController(
      approvalPort({ read: async () => { throw httpApiError("capability_unavailable", false); } }),
      context({ events: [] })
    );
    await unsupported.synchronize();
    expect(unsupported.snapshot()).toMatchObject({ phase: "unsupported", items: [] });

    const malformed = createController(
      approvalPort({ read: async () => ({ target: {}, approvals: [{ private: "payload" }] }) }),
      context({ events: [] })
    );
    await malformed.synchronize();
    expect(malformed.snapshot()).toMatchObject({ phase: "read_failed", items: [] });
    expect(JSON.stringify(malformed.snapshot())).not.toContain("payload");
  });

  it("does not automatically repeat a failed read for an unchanged context", async () => {
    const port = approvalPort({
      read: async () => { throw httpApiError("service_overloaded", true); }
    });
    const controller = createController(port, context({ events: [] }));

    await controller.synchronize();
    await controller.synchronize();
    expect(controller.snapshot().phase).toBe("read_failed");
    expect(port.read).toHaveBeenCalledTimes(1);

    await controller.refresh();
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("fails before dispatch when secure operation-id generation is invalid", async () => {
    const port = approvalPort({ read: async () => approvalList([approval({ risk: "normal" })]) });
    const controller = createController(port, context({ events: [] }), {
      createOperationId: () => "invalid-operation-id"
    });
    await controller.synchronize();
    await controller.approve(requiredItem(controller).handle);

    expect(controller.snapshot()).toMatchObject({ phase: "decision_failed" });
    expect(port.respond).not.toHaveBeenCalled();
  });

  it("owns bounded subscriptions and closes reads, mutation, timers, and state idempotently", async () => {
    const clock = manualClock(Date.parse(timestamp));
    const response = deferred<unknown>();
    const port = approvalPort({ read: async () => response.promise });
    const controller = createController(port, context({ events: [] }), { clock: clock.port });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const loading = controller.synchronize();
    const signal = port.read.mock.calls[0]?.[0].signal;

    const closed = controller.close();
    expect(signal?.aborted).toBe(true);
    expect(closed).toMatchObject({ visible: false, items: [], phase: "hidden" });
    expect(controller.close()).toBe(closed);
    unsubscribe();
    response.resolve(approvalList([]));
    await loading;
    expect(controller.snapshot()).toBe(closed);
    expect(() => controller.updateContext(context({ events: [] }))).toThrow();
  });
});

function createController(
  port: ReturnType<typeof approvalPort>,
  initialContext: ApprovalDecisionContext,
  options: Readonly<{
    createOperationId?: () => string;
    clock?: ApprovalDecisionClockPort;
  }> = {}
) {
  return createApprovalDecisionController({
    sessionId,
    context: initialContext,
    port,
    createOperationId: options.createOperationId ?? (() => "op_browser_approval_default_001"),
    clock: options.clock ?? fixedClock(Date.parse(timestamp))
  });
}

function approvalPort(overrides: Partial<ApprovalDecisionPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => approvalList([approval()]))),
    respond: vi.fn(
      overrides.respond ??
        (async ({ request, requestId: exactRequestId }) => {
          const baseline = approval({ requestId: exactRequestId });
          return terminalResponse(baseline, request.operation_id, request.decision);
        })
    )
  };
}

function approval(input: Readonly<{
  requestId?: string;
  action?: string;
  scope?: string;
  reason?: string | null;
  risk?: "normal" | "elevated" | "broad";
  grantScope?: "one_time" | "session";
  state?: PendingApproval["state"];
  decision?: "approve" | "deny" | null;
  expiresAt?: string | null;
}> = {}): PendingApproval {
  const state = input.state ?? "pending";
  const decision = input.decision ?? null;
  const parsed = pendingApprovalListResponseSchema.parse({
    target: { type: "managed_session", session_id: sessionId, codex_thread_id: threadId },
    approvals: [{
      target: {
        type: "approval",
        session_id: sessionId,
        codex_thread_id: threadId,
        request_id: input.requestId ?? requestId
      },
      action: input.action ?? "Write release marker",
      scope: input.scope ?? "Workspace files",
      reason: input.reason === undefined
        ? "The selected task requires a bounded file change."
        : input.reason,
      risk: input.risk ?? "elevated",
      grant_scope: input.grantScope ?? "one_time",
      state,
      created_at: timestamp,
      expires_at: input.expiresAt === undefined ? expiry : input.expiresAt,
      decision
    }]
  }).approvals[0];
  if (parsed === undefined) throw new Error("Approval fixture did not parse.");
  return parsed;
}

function approvalList(approvals: readonly PendingApproval[]): PendingApprovalListResponse {
  return pendingApprovalListResponseSchema.parse({
    target: { type: "managed_session", session_id: sessionId, codex_thread_id: threadId },
    approvals
  });
}

function terminalResponse(
  baseline: PendingApproval,
  operationId: string,
  decision: "approve" | "deny"
) {
  return pendingApprovalResponseSchema.parse({
    operation_id: operationId,
    requested_decision: decision,
    approval: {
      ...baseline,
      state: decision === "approve" ? "approved" : "denied",
      decision
    }
  });
}

function approvalEvent(input: Readonly<{
  requestId?: string;
  cursor?: number;
  action?: string;
  scope?: string;
  reason?: string | null;
  risk?: "normal" | "elevated" | "broad";
  expiresAt?: string | null;
  state?: "pending" | "approved" | "denied" | "expired" | "superseded";
  decision?: "approve" | "deny" | null;
}> = {}) {
  return approvalProjectionEventSchema.parse({
    session_id: sessionId,
    cursor: input.cursor ?? 1,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: `codex-private-approval-${input.cursor ?? 1}`,
    codex_event_type: "private/approval/event",
    content_state: "complete",
    content_notice: null,
    type: "approval",
    request_id: input.requestId ?? requestId,
    state: input.state ?? "pending",
    action: input.action ?? "Write release marker",
    scope: input.scope ?? "Workspace files",
    reason: input.reason === undefined
      ? "The selected task requires a bounded file change."
      : input.reason,
    risk: input.risk ?? "elevated",
    expires_at: input.expiresAt === undefined ? expiry : input.expiresAt,
    decision: input.decision ?? null
  });
}

function context(input: Readonly<{
  events: readonly ReturnType<typeof approvalEvent>[];
  epoch?: number;
  canRead?: boolean;
  writeCause?: BrowserConnectionWriteBlockCause;
  accessState?: BrowserConnectionResourceState;
  targetState?: BrowserConnectionResourceState;
  sessionState?: "active" | "archived" | "incompatible";
  freshness?: "current" | "stale";
  streamState?: BrowserConnectionSnapshot["stream"]["state"];
  streamContinuity?: BrowserConnectionSnapshot["stream"]["continuity"];
}>): ApprovalDecisionContext {
  const sessionState = input.sessionState ?? "active";
  const freshness = input.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-approval-release",
    codex_thread_id: threadId,
    cwd: "/private/approval-component",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: sessionState === "archived" ? timestamp : null,
    session_state: sessionState,
    turn_state: sessionState === "archived" ? "idle" : "waiting_for_approval",
    attention: "needs_approval",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/approval-component",
    model: "runtime-current",
    settings: null,
    goal: null,
    recent_summary: "Validate structured approval decisions.",
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
  const streamState = input.streamState ?? "connected";
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: input.canRead === false ? "access_limited" : "ready",
    access: resource(input.accessState ?? "current", pairedAccess(input.canRead ?? true)),
    host: resource("current", null),
    targetState: resource(
      input.targetState ?? "current",
      Object.freeze({ kind: "session_detail" as const, response })
    ),
    stream: Object.freeze({
      state: streamState,
      snapshot: null,
      continuity: input.streamContinuity ?? (streamState === "connected" ? "contiguous" : "unproven"),
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
  return Object.freeze({ snapshot, events: Object.freeze([...input.events]) });
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
    device_id: "device-approval-component-private",
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
  return { code, message: "Private approval fixture error.", retryable };
}

function httpApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "approval_list",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
}

function csrfApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserCsrfError({
    reason: "api_error",
    operation: "mutation",
    routeId: "approval_respond",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
}

function requiredItem(controller: ReturnType<typeof createController>) {
  const item = controller.snapshot().items[0];
  if (item === undefined) throw new Error("Approval fixture item is missing.");
  return item;
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function fixedClock(now: number): ApprovalDecisionClockPort {
  return Object.freeze({
    now: () => now,
    setTimeout: () => 1,
    clearTimeout: () => undefined
  });
}

function manualClock(initialNow: number): Readonly<{
  port: ApprovalDecisionClockPort;
  advance: (milliseconds: number) => void;
}> {
  let now = initialNow;
  let nextId = 1;
  const timers = new Map<number, Readonly<{ dueAt: number; callback: () => void }>>();
  const port: ApprovalDecisionClockPort = Object.freeze({
    now: () => now,
    setTimeout(callback: () => void, delayMs: number) {
      const id = nextId++;
      timers.set(id, Object.freeze({ dueAt: now + delayMs, callback }));
      return id;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "number") timers.delete(handle);
    }
  });
  return Object.freeze({
    port,
    advance(milliseconds: number) {
      now += milliseconds;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    }
  });
}
