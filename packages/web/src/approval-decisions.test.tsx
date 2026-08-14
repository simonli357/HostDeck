// @vitest-environment jsdom

import {
  approvalProjectionEventSchema,
  managedSessionProjectionSchema,
  type PendingApproval,
  type PendingApprovalListResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  selectedAccessStateResponseSchema,
  selectedEventPageResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalDecisionContext,
  type ApprovalDecisionController,
  type ApprovalDecisionPort,
  createApprovalDecisionController
} from "./approval-decision-state.js";
import {
  ApprovalConfirmationDialog,
  ApprovalStatusTimelineItem,
  ApprovalTimelineItem,
  useApprovalDecisionController,
  useApprovalDecisionView
} from "./approval-decisions.js";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";
import { createEventDiagnosticsController } from "./event-diagnostics-state.js";
import { SessionDetailScreen } from "./session-detail.js";
import {
  appendSessionDetailEvent,
  createSessionDetailFeed,
  type SessionDetailFeedState
} from "./session-detail-feed.js";

const sessionId = "sess_approval_ui_001" as SessionId;
const threadId = "thread-private-approval-ui";
const requestId = "string:approval-ui-001";
const secondRequestId = "string:approval-ui-002";
const timestamp = "2026-07-26T03:00:00.000Z";
const expiry = "2026-07-26T04:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("inline approval decisions", () => {
  it("keeps event-backed and list-only requests on one timeline without rendering private ids", async () => {
    const eventEntry = approval();
    const listOnly = approval({
      requestId: secondRequestId,
      action: "Publish the signed Android build",
      scope: "Release channel"
    });
    const event = approvalEvent();
    const controller = createController(
      approvalPort({ read: async () => approvalList([eventEntry, listOnly]) }),
      context({ events: [event] })
    );
    await controller.synchronize();
    const feed = appendSessionDetailEvent(createSessionDetailFeed(sessionId), event);
    const currentContext = context({ events: [event] });
    const eventDiagnostics = createEventDiagnosticsController({
      sessionId,
      context: Object.freeze({
        snapshot: currentContext.snapshot,
        events: [event],
        boundary: null
      }),
      port: Object.freeze({
        read: async () => selectedEventPageResponseSchema.parse({
          session_id: sessionId,
          events: [event],
          next_cursor: event.cursor,
          truncated: false
        })
      })
    });

    render(
      <SessionDetailScreen
        sessionId={sessionId}
        snapshot={currentContext.snapshot}
        feed={feed}
        nowMs={Date.parse(timestamp)}
        formatTimestamp={() => "3:00 AM"}
        approvals={controller}
        eventDiagnostics={eventDiagnostics}
      />
    );

    const activity = screen.getByRole("list", { name: "Session activity" });
    expect(within(activity).getAllByText("Approval required")).toHaveLength(2);
    const actions = within(activity).getAllByRole("button", { name: "Review & approve" });
    expect(actions).toHaveLength(2);
    expect(within(activity).getAllByRole("button", { name: "View event details" }))
      .toHaveLength(1);
    expect(activity.textContent?.indexOf("Write release marker")).toBeLessThan(
      activity.textContent?.indexOf("Publish the signed Android build") ?? -1
    );
    expect(activity.textContent).toContain("One time");
    expect(activity.textContent).not.toContain(requestId);
    expect(activity.textContent).not.toContain(secondRequestId);
    expect(document.body.innerHTML).not.toContain(sessionId);
    expect(document.body.innerHTML).not.toContain(threadId);
  });

  it("binds normal approval and elevated denial directly to one exact decision", async () => {
    const user = userEvent.setup();
    const normal = approval({ risk: "normal" });
    const normalPort = approvalPort({
      read: async () => approvalList([normal]),
      respond: async ({ request }) =>
        terminalResponse(normal, request.operation_id, request.decision)
    });
    const normalController = createController(normalPort, context({ events: [] }));
    await normalController.synchronize();
    const normalView = render(<ApprovalSurface controller={normalController} />);

    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(normalPort.respond).toHaveBeenCalledTimes(1);
    expect(normalPort.respond.mock.calls[0]?.[0].request.decision).toBe("approve");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("The selected request was approved once.")).toBeTruthy();

    normalView.unmount();
    const elevated = approval({ risk: "elevated" });
    const elevatedPort = approvalPort({
      read: async () => approvalList([elevated]),
      respond: async ({ request }) =>
        terminalResponse(elevated, request.operation_id, request.decision)
    });
    const elevatedController = createController(elevatedPort, context({ events: [] }));
    await elevatedController.synchronize();
    render(<ApprovalSurface controller={elevatedController} />);

    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(elevatedPort.respond).toHaveBeenCalledTimes(1);
    expect(elevatedPort.respond.mock.calls[0]?.[0].request.decision).toBe("deny");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("The selected request was denied.")).toBeTruthy();
  });

  it("shows exact elevated facts, sends nothing on cancel, and restores originating focus", async () => {
    const user = userEvent.setup();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const entry = approval({ risk: "elevated" });
    const port = approvalPort({ read: async () => approvalList([entry]) });
    const controller = createController(port, context({ events: [approvalEvent()] }));
    await controller.synchronize();
    render(<ApprovalSurface controller={controller} />);
    const trigger = screen.getByRole("button", { name: "Review & approve" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Approve elevated request?" });
    expect(dialog.textContent).toContain("Target: android-approval-release");
    expect(dialog.textContent).toContain("Write release marker");
    expect(dialog.textContent).toContain("Workspace files");
    expect(dialog.textContent).toContain("The selected task requires a bounded file change.");
    expect(dialog.textContent).toContain("Elevated risk");
    expect(dialog.textContent).toContain("One time");
    expect(
      within(dialog)
        .getByRole("button", { name: "Approve once" })
        .getAttribute("aria-label")
    ).toBe("Approve once");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(port.respond).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(requestId);
    expect(document.body.innerHTML).not.toContain(threadId);
  });

  it("keeps broad confirmation modal and single-flight until the confirmed result arrives", async () => {
    const user = userEvent.setup();
    const response = deferred<ReturnType<typeof terminalResponse>>();
    const entry = approval({ risk: "broad" });
    const port = approvalPort({
      read: async () => approvalList([entry]),
      respond: async () => response.promise
    });
    const controller = createController(port, context({ events: [] }));
    await controller.synchronize();
    render(<ApprovalSurface controller={controller} />);

    await user.click(screen.getByRole("button", { name: "Review & approve" }));
    const dialog = screen.getByRole("dialog", { name: "Approve broad request?" });
    expect(within(dialog).getByText("Broad risk")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Approve once" }));

    await waitFor(() => expect(port.respond).toHaveBeenCalledTimes(1));
    const submit = within(dialog).getByRole("button", { name: "Approve once" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Close approval confirmation" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}{Enter}");
    expect(screen.getByRole("dialog", { name: "Approve broad request?" })).toBeTruthy();
    expect(port.respond).toHaveBeenCalledTimes(1);

    const request = port.respond.mock.calls[0]?.[0].request;
    if (request === undefined) throw new TypeError("Approval request was not captured.");
    response.resolve(terminalResponse(entry, request.operation_id, "approve"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("The selected request was approved once.")).toBeTruthy();
    expect(port.respond).toHaveBeenCalledTimes(1);
  });

  it("renders ongoing policy requests as explicit read-only state", async () => {
    const entry = approval({ grantScope: "session" });
    const port = approvalPort({ read: async () => approvalList([entry]) });
    const controller = createController(port, context({ events: [] }));
    await controller.synchronize();
    render(<ApprovalSurface controller={controller} />);

    expect(screen.getByText("Ongoing policy")).toBeTruthy();
    expect(screen.getByText("Ongoing policy grants are not supported in HostDeck V1.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve|Deny/u })).toBeNull();
    expect(port.respond).not.toHaveBeenCalled();
  });
});

describe("approval production hook", () => {
  it("claims a retained approval event that arrives after the initial empty read", async () => {
    const initialContext = context({ events: [] });
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200 as const,
      data: approvalList([])
    }));
    const coordinator = coordinatorWith(
      requestSelectedSessionRead,
      vi.fn(),
      () => initialContext.snapshot
    );
    const rendered = render(
      <StrictMode>
        <ApprovalHookSurface
          coordinator={coordinator}
          snapshot={initialContext.snapshot}
          feed={createSessionDetailFeed(sessionId)}
        />
      </StrictMode>
    );
    await waitFor(() => expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1));

    const event = approvalEvent();
    rendered.rerender(
      <StrictMode>
        <ApprovalHookSurface
          coordinator={coordinator}
          snapshot={initialContext.snapshot}
          feed={appendSessionDetailEvent(createSessionDetailFeed(sessionId), event)}
        />
      </StrictMode>
    );

    expect(await screen.findByText("Approval status checking")).toBeTruthy();
    expect(screen.getByText("The timeline request is retained, but current approval state is not verified."))
      .toBeTruthy();
    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(2);
  });

  it("uses only the selected read and exact protected write under StrictMode", async () => {
    const user = userEvent.setup();
    const event = approvalEvent();
    const entry = approval();
    let currentEntry = entry;
    const owner: { current: ApprovalDecisionController | null } = { current: null };
    const initialContext = context({ events: [event] });
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200 as const,
      data: approvalList([currentEntry])
    }));
    const requestProtected = vi.fn(async (_routeId, input) => {
      currentEntry = terminalApproval(entry, input.body.decision);
      return {
        status: 200 as const,
        data: terminalResponse(entry, input.body.operation_id, input.body.decision)
      };
    });
    const coordinator = coordinatorWith(
      requestSelectedSessionRead,
      requestProtected,
      () => initialContext.snapshot
    );
    const feed = appendSessionDetailEvent(createSessionDetailFeed(sessionId), event);

    function Harness() {
      const controller = useApprovalDecisionController(
        coordinator,
        sessionId,
        initialContext.snapshot,
        feed,
        {
          createOperationId: () => "op_browser_approval_ui_production_001",
          clock: fixedClock()
        }
      );
      owner.current = controller;
      return <ApprovalSurface controller={controller} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await user.click(await screen.findByRole("button", { name: "Review & approve" }));
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(await screen.findByText("The selected request was approved once.")).toBeTruthy();

    await waitFor(() => expect(requestSelectedSessionRead).toHaveBeenCalledTimes(2));
    for (const call of requestSelectedSessionRead.mock.calls) {
      expect(call).toEqual([
        "approval_list",
        { params: { session_id: sessionId } },
        { signal: expect.any(AbortSignal) }
      ]);
    }
    expect(requestProtected).toHaveBeenCalledTimes(1);
    expect(requestProtected).toHaveBeenCalledWith(
      "approval_respond",
      {
        params: { session_id: sessionId, request_id: requestId },
        body: {
          operation_id: "op_browser_approval_ui_production_001",
          kind: "approval_response",
          decision: "approve",
          confirm: true
        }
      },
      { signal: expect.any(AbortSignal) }
    );

    rendered.unmount();
    await act(async () => Promise.resolve());
    if (owner.current === null) throw new TypeError("Approval owner was not captured.");
    expect(owner.current.snapshot().visible).toBe(false);
  });

  it("blocks dispatch when the coordinator target moves before a direct decision", async () => {
    const user = userEvent.setup();
    const entry = approval({ risk: "normal" });
    const initialContext = context({ events: [] });
    let liveSnapshot = initialContext.snapshot;
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200 as const,
      data: approvalList([entry])
    }));
    const requestProtected = vi.fn();
    const coordinator = coordinatorWith(requestSelectedSessionRead, requestProtected, () => liveSnapshot);

    render(
      <ApprovalHookSurface
        coordinator={coordinator}
        snapshot={initialContext.snapshot}
        feed={createSessionDetailFeed(sessionId)}
      />
    );
    const approve = await screen.findByRole("button", { name: "Approve once" });
    liveSnapshot = movedSnapshot(liveSnapshot);
    await user.click(approve);

    expect(requestProtected).not.toHaveBeenCalled();
    expect(await screen.findByText("Decision not sent")).toBeTruthy();
    expect(screen.getByText("Approval access is not current. Check current status.")).toBeTruthy();
  });

  it("treats a successful response as unknown when the coordinator target moves in flight", async () => {
    const user = userEvent.setup();
    const entry = approval({ risk: "normal" });
    const initialContext = context({ events: [] });
    let liveSnapshot = initialContext.snapshot;
    const release = deferred<void>();
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200 as const,
      data: approvalList([entry])
    }));
    const requestProtected = vi.fn(async (_routeId, input) => {
      await release.promise;
      return {
        status: 200 as const,
        data: terminalResponse(entry, input.body.operation_id, input.body.decision)
      };
    });
    const coordinator = coordinatorWith(requestSelectedSessionRead, requestProtected, () => liveSnapshot);

    render(
      <ApprovalHookSurface
        coordinator={coordinator}
        snapshot={initialContext.snapshot}
        feed={createSessionDetailFeed(sessionId)}
      />
    );
    await user.click(await screen.findByRole("button", { name: "Approve once" }));
    await waitFor(() => expect(requestProtected).toHaveBeenCalledTimes(1));
    liveSnapshot = movedSnapshot(liveSnapshot);
    release.resolve(undefined);

    expect(await screen.findByText("Decision outcome unknown")).toBeTruthy();
    expect(screen.queryByText("The selected request was approved once.")).toBeNull();
    expect(requestProtected).toHaveBeenCalledTimes(1);
  });
});

function ApprovalHookSurface({
  coordinator,
  snapshot,
  feed
}: Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  snapshot: BrowserConnectionSnapshot;
  feed: SessionDetailFeedState;
}>) {
  const controller = useApprovalDecisionController(coordinator, sessionId, snapshot, feed, {
    createOperationId: () => "op_browser_approval_ui_hook_001",
    clock: fixedClock()
  });
  return <ApprovalSurface controller={controller} />;
}

function ApprovalSurface({ controller }: Readonly<{ controller: ApprovalDecisionController }>) {
  const view = useApprovalDecisionView(controller);
  const confirmationOrigin = useRef<HTMLButtonElement>(null);
  return (
    <>
      <ol aria-label="Session activity">
        {view.items.map((item) => (
          <ApprovalTimelineItem
            key={item.handle}
            item={item}
            timeline={null}
            controller={controller}
            confirmationOrigin={confirmationOrigin}
          />
        ))}
        <ApprovalStatusTimelineItem view={view} controller={controller} />
      </ol>
      <ApprovalConfirmationDialog
        view={view}
        controller={controller}
        confirmationOrigin={confirmationOrigin}
      />
    </>
  );
}

function createController(port: ReturnType<typeof approvalPort>, initialContext: ApprovalDecisionContext) {
  return createApprovalDecisionController({
    sessionId,
    context: initialContext,
    port,
    createOperationId: () => "op_browser_approval_ui_default_001",
    clock: fixedClock()
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
      expires_at: expiry,
      decision
    }]
  }).approvals[0];
  if (parsed === undefined) throw new TypeError("Approval fixture did not parse.");
  return parsed;
}

function terminalApproval(
  baseline: PendingApproval,
  decision: "approve" | "deny"
): PendingApproval {
  return {
    ...baseline,
    state: decision === "approve" ? "approved" : "denied",
    decision
  } as PendingApproval;
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
    approval: terminalApproval(baseline, decision)
  });
}

function approvalEvent(input: Readonly<{
  requestId?: string;
  action?: string;
  scope?: string;
  reason?: string | null;
  risk?: "normal" | "elevated" | "broad";
}> = {}) {
  return approvalProjectionEventSchema.parse({
    session_id: sessionId,
    cursor: 1,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: "codex-private-approval-ui-event",
    codex_event_type: "private/approval/event",
    content_state: "complete",
    content_notice: null,
    type: "approval",
    request_id: input.requestId ?? requestId,
    state: "pending",
    action: input.action ?? "Write release marker",
    scope: input.scope ?? "Workspace files",
    reason: input.reason === undefined
      ? "The selected task requires a bounded file change."
      : input.reason,
    risk: input.risk ?? "elevated",
    expires_at: expiry,
    decision: null
  });
}

function context(input: Readonly<{
  events: readonly ReturnType<typeof approvalEvent>[];
  epoch?: number;
  writeCause?: BrowserConnectionWriteBlockCause;
  accessState?: BrowserConnectionResourceState;
  targetState?: BrowserConnectionResourceState;
}>): ApprovalDecisionContext {
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-approval-release",
    codex_thread_id: threadId,
    cwd: "/private/approval-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.147.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "waiting_for_approval",
    attention: "needs_approval",
    freshness: "current",
    freshness_reason: null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/approval-ui",
    model: "runtime-current",
    settings: null,
    goal: null,
    recent_summary: "Validate inline approval decisions.",
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
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready" as const,
    access: resource(input.accessState ?? "current", pairedAccess()),
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
  return Object.freeze({ snapshot, events: Object.freeze([...input.events]) });
}

function pairedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-approval-ui-private",
    permission: "write",
    device_expires_at: "2026-10-26T03:00:00.000Z",
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
  snapshot: () => BrowserConnectionSnapshot
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

function movedSnapshot(snapshot: BrowserConnectionSnapshot): BrowserConnectionSnapshot {
  return Object.freeze({
    ...snapshot,
    epoch: snapshot.epoch + 1,
    target: Object.freeze({ kind: "mission_control" as const })
  });
}

function fixedClock() {
  return Object.freeze({
    now: () => Date.parse(timestamp),
    setTimeout: () => 1,
    clearTimeout: () => undefined
  });
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
