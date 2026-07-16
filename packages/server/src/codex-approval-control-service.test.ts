import {
  type CodexApprovalClient,
  type CodexApprovalRequest,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  isoTimestampSchema,
  runtimeRequestIdSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { SelectedSessionState } from "@hostdeck/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexApprovalControlService,
  createCodexApprovalControlService,
  HostDeckCodexApprovalControlError
} from "./codex-approval-control-service.js";

const observedAt = "2026-07-10T21:45:00.000Z";
const expiresAt = "2026-07-10T21:45:01.000Z";
const target = {
  type: "managed_session",
  session_id: "sess_approval_a",
  codex_thread_id: "thread-approval-a"
} as const;
const services: CodexApprovalControlService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

describe("Codex approval control", () => {
  it("registers bounded command and file requests against one managed session", async () => {
    const harness = createHarness({ max_tracked_approvals: 3 });
    const command = harness.service.register(approvalRequest(1));
    const file = harness.service.register(
      approvalRequest("file-1", {
        method: "item/fileChange/requestApproval",
        item_id: "item-file-a" as never,
        action: "Apply proposed file changes",
        scope: null,
        risk: "elevated"
      })
    );

    expect(command).toMatchObject({
      target: { ...target, type: "approval", request_id: "number:1" },
      action: "touch /tmp/hostdeck-approved",
      scope: "/tmp/approval-project",
      state: "pending",
      created_at: observedAt,
      expires_at: expiresAt,
      decision: null
    });
    expect(file).toMatchObject({
      target: { request_id: "string:file-1" },
      scope: "/tmp/approval-project",
      state: "pending"
    });
    const listed = await harness.service.list(target);
    expect(listed.map((approval) => approval.target.request_id)).toEqual(["number:1", "string:file-1"]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(harness.service.tracked_count).toBe(2);
    expect(harness.service.pending_count).toBe(2);
  });

  it("serializes concurrent responses, sends once, and requires both terminal event facts", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest(2));
    const gate = deferred<void>();
    harness.approvals.respondGate = gate.promise;
    const first = harness.service.respond(responseIntent(registered, "approve", "op_approval_first_0001"));
    await waitFor(() => harness.approvals.respondCalls.length === 1);
    const duplicate = harness.service.respond(responseIntent(registered, "deny", "op_approval_duplicate_0001"));
    gate.resolve();

    expect(await first).toMatchObject({ state: "responding", decision: null });
    await expectApprovalError(duplicate, "approval_not_pending");
    expect(harness.approvals.respondCalls).toEqual([
      expect.objectContaining({ request: expect.objectContaining({ request_id: "number:2" }), decision: "approve" })
    ]);

    await harness.service.observeEvent(itemCompletedEvent(registered, "command"));
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "responding", decision: null });
    await harness.service.observeEvent(resolvedEvent(registered));
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "approved", decision: "approve" });
    expect(harness.service.pending_count).toBe(0);
  });

  it("settles deny when resolution arrives before the matching item terminal", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest("deny-1"));
    await harness.service.respond(responseIntent(registered, "deny", "op_approval_deny_0001"));

    await harness.service.observeEvent(resolvedEvent(registered));
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "responding", decision: null });
    await harness.service.observeEvent(itemCompletedEvent(registered, "command"));
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "denied", decision: "deny" });
  });

  it("queues terminal events behind an in-flight response and settles from both facts", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest("queued-terminal"));
    const gate = deferred<void>();
    harness.approvals.respondGate = gate.promise;

    const response = harness.service.respond(responseIntent(registered, "approve", "op_approval_queued_response_0001"));
    await waitFor(() => harness.approvals.respondCalls.length === 1);
    const resolved = harness.service.observeEvent(resolvedEvent(registered));
    const completed = harness.service.observeEvent(itemCompletedEvent(registered, "command"));
    gate.resolve();

    expect(await response).toMatchObject({ state: "responding", decision: null });
    await Promise.all([resolved, completed]);
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "approved", decision: "approve" });
  });

  it("supersedes a request resolved elsewhere and rejects a later local response", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest(3));
    await harness.service.observeEvent(resolvedEvent(registered));

    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "superseded", decision: null });
    await expectApprovalError(
      harness.service.respond(responseIntent(registered, "approve", "op_approval_superseded_0001")),
      "approval_not_pending"
    );
    expect(harness.approvals.respondCalls).toHaveLength(0);
  });

  it("supersedes a request whose item terminates before any local response", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest("external-terminal"));
    await harness.service.observeEvent(itemCompletedEvent(registered, "command"));

    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "superseded", decision: null });
    await expectApprovalError(
      harness.service.respond(responseIntent(registered, "approve", "op_approval_external_terminal_0001")),
      "approval_not_pending"
    );
    expect(harness.approvals.respondCalls).toHaveLength(0);
  });

  it("restores proven not-sent responses for explicit retry but latches possible sends", async () => {
    const notSent = createHarness();
    const retryable = notSent.service.register(approvalRequest(4));
    notSent.approvals.respondError = new HostDeckCodexAdapterError("transport_send_failed", "not sent", {
      outcome: "not_sent",
      retry_safe: true
    });
    await expectApprovalError(
      notSent.service.respond(responseIntent(retryable, "approve", "op_approval_not_sent_0001")),
      "runtime_unavailable"
    );
    expect(await notSent.service.snapshot(retryable.target)).toMatchObject({ state: "pending", decision: null });
    notSent.approvals.respondError = null;
    expect(
      await notSent.service.respond(responseIntent(retryable, "approve", "op_approval_retry_0001"))
    ).toMatchObject({ state: "responding" });
    expect(notSent.approvals.respondCalls).toHaveLength(2);

    const unknown = createHarness();
    const uncertain = unknown.service.register(approvalRequest(5));
    unknown.approvals.respondError = new HostDeckCodexAdapterError("unknown_outcome", "possible send", {
      outcome: "unknown",
      retry_safe: false
    });
    await expectApprovalError(
      unknown.service.respond(responseIntent(uncertain, "approve", "op_approval_unknown_0001")),
      "unknown_outcome"
    );
    expect(await unknown.service.snapshot(uncertain.target)).toMatchObject({ state: "responding", decision: null });
    unknown.approvals.respondError = null;
    unknown.now.value = expiresAt;
    const duplicateError = await expectApprovalError(
      unknown.service.respond(responseIntent(uncertain, "deny", "op_approval_unknown_retry_0001")),
      "approval_not_pending"
    );
    expect(duplicateError.message).toContain("responding");
    expect(unknown.approvals.respondCalls).toHaveLength(1);
    await unknown.service.observeEvent(resolvedEvent(uncertain));
    await unknown.service.observeEvent(itemCompletedEvent(uncertain, "command"));
    expect(await unknown.service.snapshot(uncertain.target)).toMatchObject({ state: "approved", decision: "approve" });
  });

  it("expires with a system decline and never invents a user decision", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest(6));
    harness.now.value = expiresAt;

    await expect(harness.service.expireDue()).resolves.toBe(1);
    expect(harness.approvals.respondCalls).toEqual([
      expect.objectContaining({ request: expect.objectContaining({ request_id: "number:6" }), decision: "deny" })
    ]);
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "expired", decision: null });
    await expectApprovalError(
      harness.service.respond(responseIntent(registered, "approve", "op_approval_expired_0001")),
      "approval_not_pending"
    );
    expect(harness.approvals.respondCalls).toHaveLength(1);
    await harness.service.observeEvent(resolvedEvent(registered));
    await harness.service.observeEvent(itemCompletedEvent(registered, "command"));
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "expired", decision: null });
    expect(harness.service.pending_count).toBe(0);
  });

  it("registers an already-due request as expired and compares offset timestamps by instant", async () => {
    const harness = createHarness();
    harness.now.value = "2026-07-10T17:45:01.000-04:00";
    const registered = harness.service.register(approvalRequest("already-due"));

    expect(registered).toMatchObject({ state: "expired", decision: null, expires_at: expiresAt });
    await expectApprovalError(
      harness.service.respond(responseIntent(registered, "approve", "op_approval_already_due_0001")),
      "approval_not_pending"
    );
    expect(harness.approvals.respondCalls).toEqual([
      expect.objectContaining({ request: expect.objectContaining({ request_id: "string:already-due" }), decision: "deny" })
    ]);
  });

  it("runs timer-driven expiry through the observed background path", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const registered = harness.service.register(approvalRequest(18));
      harness.now.value = expiresAt;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(harness.approvals.respondCalls).toEqual([
        expect.objectContaining({ request: expect.objectContaining({ request_id: "number:18" }), decision: "deny" })
      ]);
      expect(harness.backgroundErrors).toHaveLength(0);
      expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "expired", decision: null });
    } finally {
      harness.service.close();
      vi.useRealTimers();
    }
  });

  it("observes timer-driven expiry failure and retries only the proven-not-sent system decline", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const registered = harness.service.register(approvalRequest(19));
      harness.approvals.respondError = new HostDeckCodexAdapterError("transport_send_failed", "expiry not sent", {
        outcome: "not_sent",
        retry_safe: true
      });
      harness.now.value = expiresAt;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(harness.backgroundErrors).toHaveLength(1);
      expect(harness.approvals.respondCalls).toHaveLength(1);
      harness.approvals.respondError = null;
      expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "expired", decision: null });
      expect(harness.approvals.respondCalls).toHaveLength(2);
    } finally {
      harness.service.close();
      vi.useRealTimers();
    }
  });

  it("reports expiry send failure and keeps the expired request non-actionable", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest(7));
    harness.now.value = expiresAt;
    harness.approvals.respondError = new HostDeckCodexAdapterError("transport_send_failed", "expiry not sent", {
      outcome: "not_sent",
      retry_safe: true
    });

    await expect(harness.service.expireDue()).rejects.toBeInstanceOf(AggregateError);
    expect(await snapshotWithoutSweep(harness, registered)).toMatchObject({ state: "expired", decision: null });
    await expectApprovalError(
      harness.service.respond(responseIntent(registered, "deny", "op_approval_expiry_failure_0001")),
      "approval_not_pending"
    );
  });

  it("supersedes disconnected and wrong-generation requests without sending", async () => {
    const disconnected = createHarness();
    const first = disconnected.service.register(approvalRequest(8));
    await expect(disconnected.service.disconnect(1)).resolves.toBe(1);
    expect(await disconnected.service.snapshot(first.target)).toMatchObject({ state: "superseded", decision: null });

    const changed = createHarness();
    const second = changed.service.register(approvalRequest(9));
    changed.approvals.generation = 2;
    await expectApprovalError(
      changed.service.respond(responseIntent(second, "approve", "op_approval_generation_0001")),
      "approval_not_pending"
    );
    expect(await changed.service.snapshot(second.target)).toMatchObject({ state: "superseded", decision: null });
    expect(changed.approvals.respondCalls).toHaveLength(0);
  });

  it("rejects a mismatched registration generation and reports a generation change during send as unknown", async () => {
    const mismatch = createHarness();
    expect(() => mismatch.service.register(approvalRequest(16, { generation: 2 }))).toThrow(
      "does not match the active connection"
    );

    const racing = createHarness();
    const registered = racing.service.register(approvalRequest(17));
    const gate = deferred<void>();
    racing.approvals.respondGate = gate.promise;
    const response = racing.service.respond(responseIntent(registered, "approve", "op_approval_generation_race_0001"));
    await waitFor(() => racing.approvals.respondCalls.length === 1);
    racing.approvals.generation = 2;
    expect(await racing.service.snapshot(registered.target)).toMatchObject({ state: "superseded" });
    gate.resolve();
    await expectApprovalError(response, "unknown_outcome");
    expect(racing.approvals.respondCalls).toHaveLength(1);
  });

  it("rejects foreign event identity and wrong item category without changing pending state", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest(10));

    await expectApprovalError(
      harness.service.observeEvent(resolvedEvent(registered, "thread-approval-foreign")),
      "runtime_protocol_error"
    );
    await expectApprovalError(
      harness.service.observeEvent(itemCompletedEvent(registered, "file_change", "item-command-a")),
      "runtime_protocol_error"
    );
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "pending", decision: null });
  });

  it("bounds unresolved capacity, evicts closed history, and rejects stale or archived targets", async () => {
    const harness = createHarness({ max_tracked_approvals: 1 });
    const first = harness.service.register(approvalRequest(11));
    expect(() => harness.service.register(approvalRequest(12))).toThrow("capacity is exhausted");
    await harness.service.disconnect(1);
    harness.approvals.generation = 2;
    expect(harness.service.register(approvalRequest(12, { generation: 2 }))).toMatchObject({ state: "pending" });
    expect(harness.service.tracked_count).toBe(1);
    expect(await harness.service.snapshot(first.target)).toBeNull();

    const stale = createHarness();
    stale.states.set(target.session_id, selectedState("stale"));
    expect(() => stale.service.register(approvalRequest(13))).toThrow("not currently writable");

    const archived = createHarness();
    archived.states.set(target.session_id, selectedState("current", true));
    expect(() => archived.service.register(approvalRequest(14))).toThrow("archived");

    const archivedAfterRegistration = createHarness();
    const pending = archivedAfterRegistration.service.register(approvalRequest("archived-late"));
    archivedAfterRegistration.states.set(target.session_id, selectedState("current", true));
    archivedAfterRegistration.now.value = expiresAt;
    await expectApprovalError(
      archivedAfterRegistration.service.respond(responseIntent(pending, "approve", "op_approval_archived_late_0001")),
      "target_not_writable"
    );
    expect(archivedAfterRegistration.approvals.respondCalls).toHaveLength(0);
    expect(archivedAfterRegistration.service.pending_count).toBe(0);
  });

  it("registers a same-generation request only in the exact post-resume pre-ready state", async () => {
    const harness = createHarness();
    const current = selectedState();
    harness.states.set(target.session_id, {
      ...current,
      projection: selectedSessionProjectionRecordSchema.parse({
        ...current.projection,
        session: {
          ...current.projection.session,
          freshness: "stale",
          freshness_reason: "Runtime resubscription is required."
        }
      })
    });

    expect(harness.service.register(approvalRequest("resubscribe"))).toMatchObject({
      state: "pending",
      decision: null
    });
    expect(harness.approvals.respondCalls).toEqual([]);
  });

  it("does not evict closed history when a replacement registration is invalid", async () => {
    const harness = createHarness({ max_tracked_approvals: 1 });
    const registered = harness.service.register(approvalRequest("retained-history"));
    await harness.service.disconnect(1);

    expect(() =>
      harness.service.register(
        approvalRequest("retained-history", {
          thread_id: "thread-approval-missing" as never
        })
      )
    ).toThrow("targets no managed session");
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "superseded", decision: null });
    expect(harness.service.tracked_count).toBe(1);
  });

  it("supersedes unresolved approval when its turn completes without an item terminal", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest(15));
    await harness.service.observeEvent(turnCompletedEvent(registered));
    expect(await harness.service.snapshot(registered.target)).toMatchObject({ state: "superseded", decision: null });
  });

  it("waits event-driven for both terminal facts and returns the exact final decision", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest("terminal-wait"));
    await harness.service.respond(responseIntent(registered, "approve", "op_approval_terminal_wait_0001"));
    const controller = new AbortController();
    let settled = false;
    const terminal = harness.service.waitForTerminal(registered.target, controller.signal).finally(() => {
      settled = true;
    });

    await harness.service.observeEvent(resolvedEvent(registered));
    await Promise.resolve();
    expect(settled).toBe(false);
    await harness.service.observeEvent(itemCompletedEvent(registered, "command"));
    await expect(terminal).resolves.toMatchObject({ state: "approved", decision: "approve" });
    expect(harness.approvals.respondCalls).toHaveLength(1);
  });

  it("cleans an aborted terminal waiter without permitting another response", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest("terminal-abort"));
    await harness.service.respond(responseIntent(registered, "deny", "op_approval_terminal_abort_0001"));
    const controller = new AbortController();
    const terminal = harness.service.waitForTerminal(registered.target, controller.signal);
    controller.abort();

    const error = await expectApprovalError(terminal, "unknown_outcome");
    expect(error).toMatchObject({ api_code: "operation_timeout", outcome: "unknown", retry_safe: false });
    await expectApprovalError(
      harness.service.respond(responseIntent(registered, "approve", "op_approval_terminal_abort_retry_0001")),
      "approval_not_pending"
    );
    await harness.service.observeEvent(itemCompletedEvent(registered, "command"));
    await harness.service.observeEvent(resolvedEvent(registered));
    await expect(harness.service.waitForTerminal(registered.target, new AbortController().signal)).resolves.toMatchObject({
      state: "denied",
      decision: "deny"
    });
    expect(harness.approvals.respondCalls).toHaveLength(1);
  });

  it("settles terminal waiters on disconnect and service close without inventing decisions", async () => {
    const disconnected = createHarness();
    const first = disconnected.service.register(approvalRequest("wait-disconnect"));
    await disconnected.service.respond(responseIntent(first, "approve", "op_approval_wait_disconnect_0001"));
    const firstWait = disconnected.service.waitForTerminal(first.target, new AbortController().signal);
    await disconnected.service.disconnect(1);
    await expect(firstWait).resolves.toMatchObject({ state: "superseded", decision: null });

    const closed = createHarness();
    const second = closed.service.register(approvalRequest("wait-close"));
    await closed.service.respond(responseIntent(second, "approve", "op_approval_wait_close_0001"));
    const secondWait = closed.service.waitForTerminal(second.target, new AbortController().signal);
    closed.service.close();
    await expect(secondWait).resolves.toMatchObject({ state: "superseded", decision: null });
  });

  it("rejects malformed, contradictory, recovery, stale-runtime, and unavailable selected state", async () => {
    const malformed = createHarness();
    malformed.states.set(target.session_id, { ...selectedState(), extra: true } as unknown as SelectedSessionState);
    expect(() => malformed.service.register(approvalRequest("malformed-state"))).toThrow(
      "identity requires reconciliation"
    );

    const contradictory = createHarness();
    const base = selectedState();
    contradictory.states.set(target.session_id, {
      mapping: base.mapping,
      projection: selectedSessionProjectionRecordSchema.parse({
        ...base.projection,
        session: { ...base.projection.session, name: "different-session" }
      })
    });
    expect(() => contradictory.service.register(approvalRequest("contradictory-state"))).toThrow(
      "identity requires reconciliation"
    );

    const recovery = createHarness();
    recovery.states.set(target.session_id, {
      ...base,
      mapping: selectedSessionMappingRecordSchema.parse({ ...base.mapping, disposition: "recovery_required" })
    });
    expect(() => recovery.service.register(approvalRequest("recovery-state"))).toThrow("requires recovery");

    const staleRuntime = createHarness();
    staleRuntime.states.set(target.session_id, selectedStateWithRuntime("0.145.0"));
    expect(() => staleRuntime.service.register(approvalRequest("runtime-state"))).toThrow("another Codex runtime version");

    const unavailable = createHarness();
    unavailable.stateErrors.getByThreadId = new Error("secret storage detail");
    const unavailableError = expectSyncApprovalError(() =>
      unavailable.service.register(approvalRequest("state-unavailable"))
    );
    expect(unavailableError).toMatchObject({
      code: "state_unavailable",
      api_code: "storage_error"
    });

    const unavailableAfterRegistration = createHarness();
    const pending = unavailableAfterRegistration.service.register(approvalRequest("state-unavailable-late"));
    unavailableAfterRegistration.stateErrors.get = new Error("secret storage detail");
    await expectApprovalError(
      unavailableAfterRegistration.service.respond(
        responseIntent(pending, "approve", "op_approval_state_unavailable_0001")
      ),
      "state_unavailable"
    );
    expect(unavailableAfterRegistration.approvals.respondCalls).toHaveLength(0);
  });

  it("rejects top-level option and selected-state accessors without invoking them", async () => {
    let optionAccessed = false;
    const options = {
      states: { get: () => null, getByThreadId: () => null },
      on_background_error: () => undefined
    } as Record<string, unknown>;
    Object.defineProperty(options, "approvals", {
      enumerable: true,
      get() {
        optionAccessed = true;
        throw new Error("must not run");
      }
    });
    expect(() => createCodexApprovalControlService(options as never)).toThrow("option fields are invalid");
    expect(optionAccessed).toBe(false);

    const harness = createHarness();
    const registered = harness.service.register(approvalRequest("accessor-state"));
    let stateAccessed = false;
    const accessorState = {};
    for (const key of ["mapping", "projection"] as const) {
      Object.defineProperty(accessorState, key, {
        enumerable: true,
        get() {
          stateAccessed = true;
          throw new Error("must not run");
        }
      });
    }
    harness.states.set(target.session_id, accessorState as SelectedSessionState);
    await expectApprovalError(
      harness.service.respond(responseIntent(registered, "approve", "op_approval_accessor_state_0001")),
      "target_mismatch"
    );
    expect(stateAccessed).toBe(false);
    expect(harness.approvals.respondCalls).toHaveLength(0);
  });

  it("rejects malformed confirmation, wrong target identity, and duplicate registration before send", async () => {
    const harness = createHarness();
    const registered = harness.service.register(approvalRequest(20));
    expect(() => harness.service.register(approvalRequest(20))).toThrow("repeated an approval request");

    await expectApprovalError(
      harness.service.respond({ ...responseIntent(registered, "approve", "op_approval_malformed_0001"), confirm: false }),
      "invalid_request"
    );
    await expectApprovalError(
      harness.service.respond({
        ...responseIntent(registered, "approve", "op_approval_wrong_target_0001"),
        target: { ...registered.target, session_id: "sess_wrong_target" }
      }),
      "target_mismatch"
    );
    expect(harness.approvals.respondCalls).toHaveLength(0);
  });
});

interface FakeApprovalClient extends CodexApprovalClient {
  generation: number;
  runtime_version: string;
  readonly respondCalls: Array<{ readonly request: CodexApprovalRequest; readonly decision: "approve" | "deny" }>;
  respondError: Error | null;
  respondGate: Promise<void> | null;
}

interface Harness {
  readonly service: CodexApprovalControlService;
  readonly approvals: FakeApprovalClient;
  readonly states: Map<string, SelectedSessionState>;
  readonly now: { value: string };
  readonly backgroundErrors: Error[];
  readonly stateErrors: { get: Error | null; getByThreadId: Error | null };
}

function createHarness(options: { readonly max_tracked_approvals?: number } = {}): Harness {
  const approvals: FakeApprovalClient = {
    runtime_version: "0.144.0",
    generation: 1,
    respondCalls: [],
    respondError: null,
    respondGate: null,
    parseRequest(message) {
      return message as CodexApprovalRequest;
    },
    async respond(input) {
      this.respondCalls.push(input);
      if (this.respondGate !== null) await this.respondGate;
      if (this.respondError !== null) throw this.respondError;
    }
  };
  const states = new Map<string, SelectedSessionState>([[target.session_id, selectedState()]]);
  const now = { value: observedAt };
  const backgroundErrors: Error[] = [];
  const stateErrors = { get: null as Error | null, getByThreadId: null as Error | null };
  const service = createCodexApprovalControlService({
    approvals,
    states: {
      get: (sessionId) => {
        if (stateErrors.get !== null) throw stateErrors.get;
        return states.get(sessionId) ?? null;
      },
      getByThreadId: (threadId) => {
        if (stateErrors.getByThreadId !== null) throw stateErrors.getByThreadId;
        return [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null;
      }
    },
    expiry_ms: 1_000,
    ...(options.max_tracked_approvals === undefined ? {} : { max_tracked_approvals: options.max_tracked_approvals }),
    now: () => now.value,
    on_background_error: (error) => backgroundErrors.push(error)
  });
  services.push(service);
  return { service, approvals, states, now, backgroundErrors, stateErrors };
}

function approvalRequest(
  rawId: string | number,
  overrides: Partial<CodexApprovalRequest> = {}
): CodexApprovalRequest {
  const generation = overrides.generation ?? 1;
  return {
    method: "item/commandExecution/requestApproval",
    protocol_request_id: rawId,
    request_id: runtimeRequestIdSchema.parse(`${typeof rawId === "number" ? "number" : "string"}:${rawId}`),
    thread_id: "thread-approval-a" as never,
    turn_id: "turn-approval-a" as never,
    item_id: "item-command-a" as never,
    generation,
    started_at: isoTimestampSchema.parse(observedAt),
    action: "touch /tmp/hostdeck-approved",
    scope: "/tmp/approval-project",
    reason: "The read-only sandbox blocks this command.",
    risk: "elevated",
    grant_scope: "one_time",
    ...overrides
  };
}

function responseIntent(
  approval: { readonly target: PendingTarget },
  decision: "approve" | "deny",
  operationId: string
) {
  return {
    operation_id: operationId,
    target: approval.target,
    kind: "approval_response",
    decision,
    confirm: true
  } as const;
}

interface PendingTarget {
  readonly type: "approval";
  readonly session_id: string;
  readonly codex_thread_id: string;
  readonly request_id: string;
}

function resolvedEvent(approval: { readonly target: PendingTarget }, threadId: string = target.codex_thread_id): NormalizedCodexEvent {
  return {
    sequence: 1,
    method: "serverRequest/resolved",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: `request:${approval.target.request_id}:resolved`,
    scope: "thread",
    thread_id: threadId,
    request_id: approval.target.request_id
  } as NormalizedCodexEvent;
}

function itemCompletedEvent(
  approval: { readonly target: PendingTarget },
  category: "command" | "file_change",
  itemId = category === "file_change" ? "item-file-a" : "item-command-a"
): NormalizedCodexEvent {
  const rawId = approval.target.request_id.replace(/^(number|string):/u, "");
  return {
    sequence: 2,
    method: "item/completed",
    captured_at: observedAt,
    upstream_at: observedAt,
    codex_event_id: `item:${rawId}:completed`,
    scope: "thread",
    thread_id: approval.target.codex_thread_id,
    turn_id: "turn-approval-a",
    item: {
      id: itemId,
      category,
      state: "completed",
      title: category === "command" ? "Command execution" : "File change",
      text: null,
      content_state: "redacted",
      content_notice: "Sensitive content omitted."
    }
  } as NormalizedCodexEvent;
}

function turnCompletedEvent(approval: { readonly target: PendingTarget }): NormalizedCodexEvent {
  return {
    sequence: 3,
    method: "turn/completed",
    captured_at: observedAt,
    upstream_at: null,
    codex_event_id: "turn:turn-approval-a:completed",
    scope: "thread",
    thread_id: approval.target.codex_thread_id,
    turn_id: "turn-approval-a",
    status: "completed",
    error_message: null
  } as NormalizedCodexEvent;
}

function selectedState(freshness = "current", archived = false): SelectedSessionState {
  const archivedAt = archived ? observedAt : null;
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: target.session_id,
      name: "approval-session",
      codex_thread_id: target.codex_thread_id,
      cwd: "/tmp/approval-project",
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      disposition: "selected",
      created_at: observedAt,
      updated_at: observedAt,
      archived_at: archivedAt
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: target.session_id,
        name: "approval-session",
        codex_thread_id: target.codex_thread_id,
        cwd: "/tmp/approval-project",
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        created_at: observedAt,
        archived_at: archivedAt,
        session_state: archived ? "archived" : "active",
        turn_state: archived ? "idle" : "waiting_for_approval",
        attention: archived ? "none" : "needs_approval",
        freshness,
        freshness_reason: freshness === "current" ? null : "Runtime reconnect is required.",
        updated_at: observedAt,
        last_activity_at: observedAt,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "Codex is waiting for approval.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

function selectedStateWithRuntime(runtimeVersion: string): SelectedSessionState {
  const state = selectedState();
  return {
    mapping: selectedSessionMappingRecordSchema.parse({ ...state.mapping, runtime_version: runtimeVersion }),
    projection: selectedSessionProjectionRecordSchema.parse({
      ...state.projection,
      session: { ...state.projection.session, runtime_version: runtimeVersion }
    })
  };
}

async function expectApprovalError(
  promise: Promise<unknown>,
  code: HostDeckCodexApprovalControlError["code"]
): Promise<HostDeckCodexApprovalControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexApprovalControlError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexApprovalControlError;
  }
  throw new Error(`Expected approval error ${code}.`);
}

function expectSyncApprovalError(operation: () => unknown): HostDeckCodexApprovalControlError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexApprovalControlError);
    return error as HostDeckCodexApprovalControlError;
  }
  throw new Error("Expected a synchronous approval-control error.");
}

async function snapshotWithoutSweep(harness: Harness, approval: { readonly target: PendingTarget }) {
  harness.approvals.respondError = null;
  return harness.service.snapshot(approval.target);
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for approval test state.");
}
