import {
  managedSessionProjectionSchema,
  type PromptDispatchResponse,
  promptDispatchResponseSchema,
  type SelectedProjectionEvent,
  selectedAccessStateResponseSchema,
  selectedProjectionEventSchema,
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
  createPromptComposerController,
  type PromptComposerContext,
  type PromptComposerDispatchInput,
  type PromptComposerOperationState,
  projectPromptComposer,
  promptComposerMaximumDraftLength
} from "./prompt-composer-state.js";
import {
  appendSessionDetailEvent,
  createSessionDetailFeed
} from "./session-detail-feed.js";

const sessionId = "sess_prompt_composer_001" as SessionId;
const otherSessionId = "sess_prompt_composer_other" as SessionId;
const timestamp = "2026-07-25T18:00:00.000Z";
const turnId = "turn-prompt-composer-001";

describe("prompt composer projection", () => {
  it("projects one exact writable target and immutable composing state", () => {
    const context = promptContext();
    const view = projectPromptComposer({
      sessionId,
      ...context,
      draft: "  Review the selected prompt boundary.  ",
      operation: idleOperation()
    });

    expect(view).toMatchObject({
      visible: true,
      targetLabel: "android-release",
      phase: "composing",
      status: "Ready to send",
      disabledCause: null,
      inputDisabled: false,
      sendEnabled: true,
      sendLabel: "Send prompt"
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.sessionId)).toBe(true);
  });

  it("covers every canonical write block with bounded disabled truth", () => {
    const causes: readonly BrowserConnectionWriteBlockCause[] = [
      "connection_not_current",
      "unpaired",
      "invalid_device",
      "expired_device",
      "revoked_device",
      "permission_denied",
      "read_only_access",
      "host_lock_pending",
      "host_lock_unconfirmed",
      "host_locked",
      "host_status_unavailable",
      "host_not_ready",
      "csrf_not_ready"
    ];

    for (const cause of causes) {
      const context = promptContext({ writeCause: cause });
      const view = projectPromptComposer({
        sessionId,
        ...context,
        draft: "One prompt",
        operation: idleOperation()
      });
      expect(view).toMatchObject({
        visible: true,
        phase: "unavailable",
        disabledCause: cause,
        inputDisabled: true,
        sendEnabled: false
      });
      expect(view.disabledReason).toBeTruthy();
      expect(view.disabledReason).not.toMatch(/device_prompt_private|thread-private/u);

      const acceptedView = projectPromptComposer({
        sessionId,
        ...context,
        draft: "A blocked follow-up",
        operation: acceptedOperation("start")
      });
      expect(acceptedView).toMatchObject({
        visible: true,
        phase: "unavailable",
        status: "Prompt unavailable",
        disabledCause: cause,
        inputDisabled: true,
        sendEnabled: false
      });
      expect(acceptedView.statusDetail).toBe(acceptedView.disabledReason);
    }
  });

  it.each([
    ["host_lock_pending", "A remote-write lock request is being confirmed."],
    ["host_lock_unconfirmed", "The last remote-write lock outcome is unconfirmed. Refresh HostDeck."],
    ["host_locked", "Remote writes are locked on the laptop."]
  ] as const)("uses shared host-lock copy for %s", (writeCause, reason) => {
    expect(
      projectPromptComposer({
        sessionId,
        ...promptContext({ writeCause }),
        draft: "One prompt",
        operation: idleOperation()
      })
    ).toMatchObject({
      disabledCause: writeCause,
      inputDisabled: true,
      sendEnabled: false,
      disabledReason: reason
    });
  });

  it("distinguishes exact session and stream admission families", () => {
    const cases = [
      [promptContext({ targetState: "stale" }), "connection_not_current"],
      [promptContext({ turnState: "waiting_for_input" }), "turn_needs_input"],
      [promptContext({ turnState: "waiting_for_approval" }), "turn_needs_approval"],
      [promptContext({ turnState: "unknown" }), "turn_unknown"],
      [promptContext({ freshness: "stale" }), "session_not_current"],
      [promptContext({ streamState: "connecting" }), "stream_connecting"],
      [promptContext({ streamState: "reconnecting" }), "stream_reconnecting"],
      [promptContext({ streamState: "failed" }), "stream_unavailable"],
      [promptContext({ continuity: "unproven" }), "stream_unproven"],
      [promptContext({ feedSessionId: otherSessionId }), "activity_loading"]
    ] as const;

    for (const [context, cause] of cases) {
      expect(
        projectPromptComposer({
          sessionId,
          ...context,
          draft: "One prompt",
          operation: idleOperation()
        })
      ).toMatchObject({ visible: true, disabledCause: cause, sendEnabled: false });
      if (
        cause !== "turn_needs_input" &&
        cause !== "turn_needs_approval" &&
        cause !== "turn_unknown"
      ) {
        const acceptedView = projectPromptComposer({
          sessionId,
          ...context,
          draft: "A blocked follow-up",
          operation: acceptedOperation("start")
        });
        expect(acceptedView).toMatchObject({
          visible: true,
          phase: "unavailable",
          status: "Prompt unavailable",
          disabledCause: cause,
          inputDisabled: true,
          sendEnabled: false
        });
        expect(acceptedView.statusDetail).toBe(acceptedView.disabledReason);
      }
    }

    const hidden = projectPromptComposer({
      sessionId,
      ...promptContext({ targetSessionId: otherSessionId }),
      draft: "",
      operation: idleOperation()
    });
    expect(hidden).toMatchObject({ visible: false, phase: "hidden", targetLabel: null });
    expect(
      projectPromptComposer({
        sessionId,
        ...promptContext({ targetSessionId: otherSessionId }),
        draft: "",
        operation: acceptedOperation("start")
      })
    ).toMatchObject({ visible: false, phase: "hidden", targetLabel: null });
  });

  it("keeps input bounds and accepted-versus-event progress exact", () => {
    const accepted = acceptedOperation("start");
    const base = promptContext();
    const acceptedView = projectPromptComposer({
      sessionId,
      ...base,
      draft: "",
      operation: accepted
    });
    expect(acceptedView).toMatchObject({ phase: "accepted", status: "New turn accepted" });

    for (const [state, phase] of [
      ["in_progress", "running"],
      ["waiting_for_input", "needs_input"],
      ["waiting_for_approval", "needs_approval"],
      ["completed", "completed"],
      ["interrupted", "interrupted"],
      ["failed", "turn_failed"],
      ["unknown", "turn_unknown"]
    ] as const) {
      const feed = appendSessionDetailEvent(base.feed, turnEvent(2, state));
      const view = projectPromptComposer({
        sessionId,
        snapshot: base.snapshot,
        feed,
        draft: "A possible follow-up",
        operation: accepted
      });
      expect(view.phase).toBe(phase);
      if (state === "waiting_for_input") {
        expect(view).toMatchObject({
          disabledCause: "turn_needs_input",
          inputDisabled: true,
          sendEnabled: false
        });
      }
      if (state === "waiting_for_approval") {
        expect(view).toMatchObject({
          disabledCause: "turn_needs_approval",
          disabledReason:
            "The turn still reports waiting for approval. Refresh before sending.",
          inputDisabled: true,
          status: "Prompt paused",
          statusDetail:
            "The turn still reports waiting for approval. Refresh before sending.",
          sendEnabled: false
        });
      }
      if (state === "unknown") {
        expect(view).toMatchObject({
          disabledCause: "turn_unknown",
          inputDisabled: true,
          sendEnabled: false
        });
      }
    }

    const unrelated = appendSessionDetailEvent(
      base.feed,
      turnEvent(2, "completed", "turn-unrelated")
    );
    expect(
      projectPromptComposer({
        sessionId,
        snapshot: base.snapshot,
        feed: unrelated,
        draft: "",
        operation: accepted
      }).phase
    ).toBe("accepted");

    const retainedRunning = appendSessionDetailEvent(
      base.feed,
      turnEvent(2, "in_progress")
    );
    const steerAfterRetained: PromptComposerOperationState = Object.freeze({
      phase: "accepted",
      receipt: acceptedResponse("op_prompt_retained_steer", "steer"),
      afterCursor: 2
    });
    expect(
      projectPromptComposer({
        sessionId,
        snapshot: base.snapshot,
        feed: retainedRunning,
        draft: "",
        operation: steerAfterRetained
      }).phase
    ).toBe("accepted");
    expect(
      projectPromptComposer({
        sessionId,
        snapshot: base.snapshot,
        feed: appendSessionDetailEvent(retainedRunning, turnEvent(3, "completed")),
        draft: "",
        operation: steerAfterRetained
      }).phase
    ).toBe("completed");

    const reconnecting = promptContext({ streamState: "reconnecting" });
    expect(
      projectPromptComposer({
        sessionId,
        snapshot: reconnecting.snapshot,
        feed: appendSessionDetailEvent(
          reconnecting.feed,
          turnEvent(2, "completed")
        ),
        draft: "A blocked follow-up",
        operation: accepted
      })
    ).toMatchObject({
      phase: "unavailable",
      status: "Prompt unavailable",
      statusDetail: "Session activity is reconnecting.",
      disabledCause: "stream_reconnecting",
      disabledReason: "Session activity is reconnecting.",
      inputDisabled: true,
      sendEnabled: false
    });

    const tooLong = projectPromptComposer({
      sessionId,
      ...base,
      draft: "x".repeat(promptComposerMaximumDraftLength),
      operation: idleOperation()
    });
    expect(tooLong).toMatchObject({
      phase: "composing",
      status: "Prompt is too long",
      sendEnabled: false
    });
  });
});

describe("prompt composer controller", () => {
  it("does no setup or dispatch for empty, oversized, disabled, or invalid secure input", async () => {
    const createOperationId = vi.fn(() => "not-a-valid-operation-id");
    const dispatch = vi.fn();
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId,
      dispatch: { dispatch }
    });

    controller.setDraft("   \n  ");
    await controller.submit();
    controller.setDraft("x".repeat(promptComposerMaximumDraftLength));
    await controller.submit();
    expect(createOperationId).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(() => controller.setDraft("x".repeat(promptComposerMaximumDraftLength + 1)))
      .toThrow(TypeError);

    controller.setDraft("One valid prompt");
    expect(await controller.submit()).toMatchObject({
      phase: "failed_nonretryable",
      draft: "One valid prompt",
      sendEnabled: false
    });
    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();

    const disabledFactory = vi.fn(() => "op_prompt_disabled_0001");
    const disabledDispatch = vi.fn();
    const disabled = createPromptComposerController({
      sessionId,
      context: promptContext({ writeCause: "host_locked" }),
      createOperationId: disabledFactory,
      dispatch: { dispatch: disabledDispatch }
    });
    disabled.setDraft("Ignored while disabled");
    await disabled.submit();
    expect(disabledFactory).not.toHaveBeenCalled();
    expect(disabledDispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes once, dispatches once, correlates acceptance, and clears the draft", async () => {
    const calls: PromptComposerDispatchInput[] = [];
    const createOperationId = vi.fn(() => "op_prompt_composer_0001");
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId,
      dispatch: {
        dispatch: vi.fn(async (input: PromptComposerDispatchInput) => {
          calls.push(input);
          return acceptedResponse(input.request.operation_id, "start");
        })
      }
    });

    controller.setDraft("  Review the selected prompt boundary.  ");
    const result = await controller.submit();

    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId,
      request: {
        operation_id: "op_prompt_composer_0001",
        kind: "prompt",
        text: "Review the selected prompt boundary."
      }
    });
    expect(result).toMatchObject({
      phase: "accepted",
      status: "New turn accepted",
      draft: "",
      sendEnabled: false
    });
    expect(JSON.stringify(result)).not.toMatch(/thread-private|audit-prompt|turn-prompt/u);
  });

  it("makes reentrant and double submission inert while one request owns dispatch", async () => {
    const pending = deferred<PromptDispatchResponse>();
    const dispatch = vi.fn(() => pending.promise);
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => "op_prompt_composer_pending",
      dispatch: { dispatch }
    });
    controller.setDraft("One bounded prompt");

    const first = controller.submit();
    const second = controller.submit();
    controller.setDraft("A duplicate prompt");

    expect(controller.snapshot()).toMatchObject({
      phase: "submitting",
      draft: "One bounded prompt",
      inputDisabled: true,
      sendEnabled: false
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(controller.snapshot());

    pending.resolve(acceptedResponse("op_prompt_composer_pending", "steer"));
    await expect(first).resolves.toMatchObject({
      phase: "accepted",
      status: "Follow-up accepted"
    });
  });

  it("allows only an explicit public-safe retry and uses a fresh operation id", async () => {
    const operationIds = ["op_prompt_retry_0001", "op_prompt_retry_0002"];
    const dispatch = vi
      .fn<({ request }: PromptComposerDispatchInput) => Promise<unknown>>()
      .mockRejectedValueOnce(
        csrfApiError("operation_conflict", true)
      )
      .mockImplementationOnce(async ({ request }) => acceptedResponse(request.operation_id, "start"));
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => requiredShift(operationIds),
      dispatch: { dispatch }
    });
    controller.setDraft("Retry only after a known rejection");

    expect(await controller.submit()).toMatchObject({
      phase: "failed_retryable",
      sendEnabled: true,
      sendLabel: "Retry prompt",
      draft: "Retry only after a known rejection"
    });
    expect(await controller.submit()).toMatchObject({ phase: "accepted", draft: "" });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([input]) => input.request.operation_id)).toEqual([
      "op_prompt_retry_0001",
      "op_prompt_retry_0002"
    ]);
  });

  it("blocks a nonretryable same-text rejection until the user changes the request", async () => {
    const dispatch = vi
      .fn<({ request }: PromptComposerDispatchInput) => Promise<unknown>>()
      .mockRejectedValueOnce(csrfApiError("session_not_writable", false))
      .mockImplementationOnce(async ({ request }) => acceptedResponse(request.operation_id, "start"));
    let operation = 0;
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => `op_prompt_nonretry_${++operation}`,
      dispatch: { dispatch }
    });
    controller.setDraft("Original rejected prompt");

    expect(await controller.submit()).toMatchObject({
      phase: "failed_nonretryable",
      sendEnabled: false
    });
    await controller.submit();
    expect(dispatch).toHaveBeenCalledTimes(1);

    controller.setDraft("Changed prompt after a known rejection");
    expect(controller.snapshot()).toMatchObject({ phase: "composing", sendEnabled: true });
    await controller.submit();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("latches transport and correlation ambiguity without same-document retry", async () => {
    const dispatch = vi
      .fn<({ request }: PromptComposerDispatchInput) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("private transport cause"));
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => "op_prompt_unknown_0001",
      dispatch: { dispatch }
    });
    controller.setDraft("Do not duplicate an uncertain prompt");

    const unknown = await controller.submit();
    expect(unknown).toMatchObject({
      phase: "outcome_unknown",
      reloadRequired: true,
      inputReadOnly: true,
      sendEnabled: false,
      draft: "Do not duplicate an uncertain prompt"
    });
    expect(JSON.stringify(unknown)).not.toContain("private transport cause");
    controller.setDraft("Attempted replacement");
    await controller.submit();
    expect(dispatch).toHaveBeenCalledTimes(1);

    const mismatchDispatch = vi.fn(async () =>
      acceptedResponse("op_prompt_wrong_response", "start")
    );
    const mismatch = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => "op_prompt_expected_response",
      dispatch: { dispatch: mismatchDispatch }
    });
    mismatch.setDraft("Correlate this prompt");
    expect(await mismatch.submit()).toMatchObject({
      phase: "outcome_unknown",
      reloadRequired: true
    });
  });

  it("aborts and scrubs target-owned state on route change and close", async () => {
    const pending = deferred<PromptDispatchResponse>();
    const signal: { current: AbortSignal | null } = { current: null };
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => "op_prompt_abort_0001",
      dispatch: {
        dispatch: vi.fn(({ signal: candidate }: PromptComposerDispatchInput) => {
          signal.current = candidate;
          return pending.promise;
        })
      }
    });
    controller.setDraft("Target-owned private fixture prompt");
    const submitted = controller.submit();

    controller.updateContext(promptContext({ targetSessionId: otherSessionId }));
    expect(signal.current?.aborted).toBe(true);
    expect(controller.snapshot()).toMatchObject({ visible: false, draft: "", phase: "hidden" });
    pending.resolve(acceptedResponse("op_prompt_abort_0001", "start"));
    await submitted;
    expect(controller.snapshot()).toMatchObject({ visible: false, draft: "" });

    const closed = controller.close();
    expect(closed).toMatchObject({ visible: false, draft: "" });
    expect(controller.close()).toBe(closed);
    expect(() => controller.setDraft("late")).toThrow("closed");

    const disclosureController = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => "op_prompt_disclosure_loss",
      dispatch: { dispatch: vi.fn() }
    });
    disclosureController.setDraft("Scrub when disclosure is revoked");
    expect(
      disclosureController.updateContext(promptContext({ disclose: false }))
    ).toMatchObject({ visible: false, draft: "", phase: "hidden" });
  });

  it("bounds listeners, rejects hostile construction, and publishes immutable snapshots", () => {
    expect(() =>
      createPromptComposerController({
        sessionId,
        context: null as never,
        createOperationId: () => "op_prompt_invalid_context",
        dispatch: { dispatch: vi.fn() }
      })
    ).toThrow(TypeError);
    const valid = promptContext();
    expect(() =>
      projectPromptComposer({
        sessionId,
        ...valid,
        snapshot: {
          ...valid.snapshot,
          writeEligibility: {
            scope: "browser_shell",
            eligible: true,
            causes: ["host_locked"]
          }
        },
        draft: "Hostile authority",
        operation: idleOperation()
      })
    ).toThrow(TypeError);
    expect(() =>
      projectPromptComposer({
        sessionId,
        snapshot: valid.snapshot,
        feed: { ...valid.feed, acceptedCount: -1 },
        draft: "Hostile feed",
        operation: idleOperation()
      })
    ).toThrow(TypeError);
    expect(() =>
      projectPromptComposer({
        sessionId,
        ...valid,
        draft: "Hostile operation",
        operation: {
          phase: "submitting",
          operationId: "op_prompt_hostile",
          submittedText: "Hostile operation",
          afterCursor: null,
          extra: true
        } as never
      })
    ).toThrow(TypeError);
    expect(() =>
      projectPromptComposer({
        sessionId,
        ...valid,
        draft: "",
        operation: Object.freeze({
          phase: "accepted" as const,
          receipt: promptDispatchResponseSchema.parse({
            ...acceptedResponse("op_prompt_wrong_target", "start"),
            target: {
              type: "managed_session",
              session_id: otherSessionId,
              codex_thread_id: "thread-private-other"
            }
          }),
          afterCursor: null
        })
      })
    ).toThrow("receipt target");
    const controller = createPromptComposerController({
      sessionId,
      context: promptContext(),
      createOperationId: () => "op_prompt_listener",
      dispatch: { dispatch: vi.fn() }
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    expect(() => controller.subscribe(listener)).toThrow(TypeError);
    controller.setDraft("Notify one listener");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    unsubscribe();
    unsubscribe();
    controller.setDraft("No second notification");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

function promptContext(
  options: {
    readonly writeCause?: BrowserConnectionWriteBlockCause;
    readonly turnState?:
      | "idle"
      | "in_progress"
      | "waiting_for_input"
      | "waiting_for_approval"
      | "completed"
      | "interrupted"
      | "failed"
      | "unknown";
    readonly freshness?: "current" | "stale";
    readonly archived?: boolean;
    readonly targetState?: BrowserConnectionResourceState;
    readonly streamState?: "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "closed";
    readonly continuity?: "unproven" | "contiguous" | "boundary";
    readonly targetSessionId?: SessionId;
    readonly feedSessionId?: SessionId;
    readonly disclose?: boolean;
  } = {}
): PromptComposerContext {
  const targetSessionId = options.targetSessionId ?? sessionId;
  const item = sessionItem(options);
  const response = selectedSessionDetailResponseSchema.parse({
    access: { mode: "paired_write", network_mode: "remote", transport: "https" },
    session: item
  });
  const writeCause = options.writeCause;
  const streamState = options.streamState ?? "connected";
  const continuity = options.continuity ?? "contiguous";
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId: targetSessionId }),
    phase: "ready",
    access: resource("current", pairedAccess(), null),
    host: resource("current", null, null),
    targetState: resource(
      options.disclose === false ? "blocked" : (options.targetState ?? "current"),
      options.disclose === false
        ? null
        : Object.freeze({ kind: "session_detail" as const, response }),
      null
    ),
    stream: Object.freeze({
      state: streamState,
      snapshot: null,
      continuity,
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
  return Object.freeze({
    snapshot,
    feed: createSessionDetailFeed(options.feedSessionId ?? sessionId)
  });
}

function sessionItem(options: {
  readonly turnState?:
    | "idle"
    | "in_progress"
    | "waiting_for_input"
    | "waiting_for_approval"
    | "completed"
    | "interrupted"
    | "failed"
    | "unknown";
  readonly freshness?: "current" | "stale";
  readonly archived?: boolean;
}) {
  const archived = options.archived === true;
  const freshness = options.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: "thread-private-prompt-composer",
    cwd: "/private/prompt-composer",
    runtime_source: "codex_app_server",
    runtime_version: "0.147.0",
    created_at: timestamp,
    archived_at: archived ? "2026-07-25T18:05:00.000Z" : null,
    session_state: archived ? "archived" : "active",
    turn_state: options.turnState ?? "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/prompt-composer",
    model: "gpt-5.5-codex",
    settings: null,
    goal: null,
    recent_summary: "Implement the selected prompt composer.",
    last_event_cursor: null
  });
  return selectedSessionReadItemSchema.parse({
    session,
    event_window: {
      state: "empty",
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    }
  });
}

function pairedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_prompt_private",
    permission: "write",
    device_expires_at: "2026-10-25T18:00:00.000Z",
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

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null,
  failure: null
) {
  return Object.freeze({ state, data, failure, observedAt: data === null ? null : timestamp });
}

function acceptedOperation(action: "start" | "steer"): PromptComposerOperationState {
  return Object.freeze({
    phase: "accepted",
    receipt: acceptedResponse("op_prompt_projection", action),
    afterCursor: null
  });
}

function acceptedResponse(
  operationId: string,
  action: "start" | "steer"
): PromptDispatchResponse {
  return promptDispatchResponseSchema.parse({
    operation_id: operationId,
    kind: "prompt",
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: "thread-private-prompt-composer"
    },
    state: "accepted",
    accepted_at: timestamp,
    audit_record_id: "audit-prompt-private",
    turn_id: turnId,
    action
  });
}

function turnEvent(
  cursor: number,
  state:
    | "idle"
    | "in_progress"
    | "waiting_for_input"
    | "waiting_for_approval"
    | "completed"
    | "interrupted"
    | "failed"
    | "unknown",
  eventTurnId = turnId
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: `codex-private-turn-${cursor}`,
    codex_event_type: "thread/turn/state",
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: eventTurnId,
    state,
    error:
      state === "failed"
        ? { code: "runtime_unavailable", message: "Runtime work stopped safely." }
        : null
  });
}

function idleOperation(): PromptComposerOperationState {
  return Object.freeze({ phase: "idle" });
}

function csrfApiError(code: "operation_conflict" | "session_not_writable", retryable: boolean) {
  return new HostDeckBrowserCsrfError({
    reason: "api_error",
    operation: "mutation",
    routeId: "prompt_dispatch",
    transport: "https",
    status: 409,
    apiError: {
      code,
      message: "Selected public failure.",
      retryable
    }
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requiredShift<Value>(values: Value[]): Value {
  const value = values.shift();
  if (value === undefined) throw new TypeError("Required test value is unavailable.");
  return value;
}
