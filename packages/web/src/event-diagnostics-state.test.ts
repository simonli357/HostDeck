import {
  type ApiErrorEnvelope,
  managedSessionProjectionSchema,
  type SelectedProjectionEvent,
  selectedAccessStateResponseSchema,
  selectedEventPageResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot
} from "./connection-state.js";
import {
  createEventDiagnosticsController,
  type EventDiagnosticsContext,
  type EventDiagnosticsPort
} from "./event-diagnostics-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

const sessionId = "sess_event_diagnostics_001" as SessionId;
const otherSessionId = "sess_event_diagnostics_002" as SessionId;
const timestamp = "2026-07-27T18:00:00.000Z";
const upstreamTimestamp = "2026-07-27T17:59:59.000Z";
const threadId = "thread-event-diagnostics-private";

describe("event-diagnostics state", () => {
  it("verifies one exact retained event with a derived exclusive cursor", async () => {
    const event = eventOf("message", 2);
    const port = eventPort({ read: async () => eventPage(event) });
    const controller = createController(port, context({ events: [event] }));

    const opening = controller.open(2);
    expect(controller.snapshot()).toMatchObject({
      sheetOpen: true,
      phase: "loading",
      freshness: "stale",
      title: "Message event",
      identity: {
        cursor: 2,
        normalizedType: "message",
        capturedAt: timestamp,
        upstreamAt: upstreamTimestamp,
        codexEventId: "codex-event-2",
        codexEventType: "item/message",
        source: "HostDeck summary"
      }
    });

    const view = await opening;
    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.read.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      after: 1,
      limit: 1,
      signal: expect.any(AbortSignal)
    });
    expect(view).toMatchObject({
      phase: "current",
      status: "Event details current",
      freshness: "current",
      selectionRevision: 1,
      captureRevision: 1,
      retryEnabled: true,
      diagnostics: {
        read_only: true,
        projection_complete: true,
        boundary_visible: false,
        redaction_visible: false,
        incomplete_reason: null
      }
    });
    expect(view.fields?.map((field) => field.label)).toEqual([
      "Role",
      "Phase",
      "Item ID",
      "Text"
    ]);
  });

  it("uses a persisted replay boundary's exact nullable after cursor", async () => {
    const event = eventOf("replay_boundary", 1, { boundaryAfter: null });
    const port = eventPort({ read: async () => eventPage(event) });
    const controller = createController(
      port,
      context({
        events: [event],
        boundary: { after: null, cursor: 1, reason: "retention" }
      })
    );

    const view = await controller.open(1);

    expect(port.read).toHaveBeenCalledWith({
      sessionId,
      after: null,
      limit: 1,
      signal: expect.any(AbortSignal)
    });
    expect(view).toMatchObject({
      phase: "current",
      title: "Replay boundary",
      boundary: {
        provenance: "persisted_event",
        after: null,
        cursor: 1,
        nextCursor: 1,
        reason: "retention"
      },
      diagnostics: {
        projection_complete: false,
        boundary_visible: true,
        incomplete_reason: "Earlier events are outside retained history."
      }
    });
    expect(view.fields?.map((field) => [field.label, field.value, field.state])).toEqual([
      ["Prior event position", null, "not_reported"],
      ["Boundary position", "1", "reported"],
      ["Next event position", "1", "reported"],
      ["Reason", "retention", "reported"]
    ]);
  });

  it("keeps cursor zero and continuity-only boundaries local without fabricating reads", async () => {
    const cursorZero = eventOf("message", 0);
    const zeroPort = eventPort();
    const zero = createController(zeroPort, context({ events: [cursorZero] }));
    await zero.open(0);

    expect(zeroPort.read).not.toHaveBeenCalled();
    expect(zero.snapshot()).toMatchObject({
      phase: "local_only",
      freshness: "retained",
      status: "Local evidence only",
      retryEnabled: false
    });

    const continuityPort = eventPort();
    const continuity = createController(
      continuityPort,
      context({
        events: [],
        boundary: { after: 8, cursor: 9, reason: "disconnect" }
      })
    );
    await continuity.open(9);

    expect(continuityPort.read).not.toHaveBeenCalled();
    expect(continuity.snapshot()).toMatchObject({
      phase: "local_only",
      title: "Replay boundary",
      identity: {
        cursor: 9,
        normalizedType: null,
        capturedAt: null
      },
      limitation: {
        contentState: "continuity_evidence",
        label: "Stream continuity evidence"
      },
      boundary: {
        provenance: "stream_continuity",
        after: 8,
        cursor: 9,
        nextCursor: 9,
        reason: "disconnect"
      }
    });
  });

  it("coalesces duplicate activation and replaces selection with one cancelled read", async () => {
    const first = eventOf("message", 2);
    const second = eventOf("activity", 3);
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    let reads = 0;
    const port = eventPort({
      read: async () => {
        reads += 1;
        return reads === 1 ? firstRead.promise : secondRead.promise;
      }
    });
    const controller = createController(port, context({ events: [first, second] }));

    const opening = controller.open(2);
    const duplicate = controller.open(2);
    expect(port.read).toHaveBeenCalledTimes(1);
    const firstSignal = port.read.mock.calls[0]?.[0].signal;

    const replacement = controller.open(3);
    expect(firstSignal?.aborted).toBe(true);
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      title: "Activity event",
      identity: { cursor: 3 },
      selectionRevision: 2,
      phase: "loading"
    });

    firstRead.resolve(eventPage(first));
    await opening;
    await duplicate;
    expect(controller.snapshot()).toMatchObject({ identity: { cursor: 3 }, phase: "loading" });

    secondRead.resolve(eventPage(second));
    await replacement;
    expect(controller.snapshot()).toMatchObject({ identity: { cursor: 3 }, phase: "current" });
  });

  it("retains exact local evidence after failure and retries only when explicitly asked", async () => {
    const event = eventOf("control", 4);
    let reads = 0;
    const port = eventPort({
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("private failure /home/user/secret");
        return eventPage(event);
      }
    });
    const controller = createController(port, context({ events: [event] }));

    await controller.open(4);
    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      freshness: "stale",
      status: "Event verification failed",
      retryEnabled: true,
      identity: { cursor: 4 }
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("/home/user/secret");
    expect(port.read).toHaveBeenCalledTimes(1);

    controller.updateContext(context({ events: [event], epoch: 2 }));
    expect(port.read).toHaveBeenCalledTimes(1);

    await controller.retry();
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      phase: "current",
      freshness: "current",
      captureRevision: 1
    });
  });

  it("marks verification stale across a same-reader epoch while preserving read-only and lock changes", async () => {
    const event = eventOf("turn", 5);
    const port = eventPort({ read: async () => eventPage(event) });
    const controller = createController(port, context({ events: [event], permission: "write" }));
    await controller.open(5);

    const stale = controller.updateContext(context({
      events: [event],
      epoch: 2,
      permission: "read",
      locked: true,
      turnState: "waiting_for_input",
      csrfGeneration: 8
    }));

    expect(stale).toMatchObject({
      sheetOpen: true,
      phase: "stale",
      freshness: "stale",
      retryEnabled: true,
      identity: { cursor: 5 }
    });
    expect(port.read).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale selected-session projection local until Session Detail is current", async () => {
    const event = eventOf("message", 2);
    const port = eventPort({ read: async () => eventPage(event) });
    const controller = createController(
      port,
      context({ events: [event], freshness: "stale" })
    );

    await controller.open(2);

    expect(port.read).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      sheetOpen: true,
      phase: "stale",
      freshness: "stale",
      status: "Retained event detail",
      retryEnabled: false,
      identity: { cursor: 2 }
    });
  });

  it("aborts an active read on epoch loss and suppresses late settlement", async () => {
    const event = eventOf("runtime", 6);
    const pending = deferred<unknown>();
    const port = eventPort({ read: async () => pending.promise });
    const controller = createController(port, context({ events: [event] }));

    const opening = controller.open(6);
    const signal = port.read.mock.calls[0]?.[0].signal;
    controller.updateContext(context({
      events: [event],
      epoch: 2,
      accessState: "stale",
      targetState: "stale"
    }));
    expect(signal?.aborted).toBe(true);
    expect(controller.snapshot()).toMatchObject({ phase: "stale", busy: false });

    pending.resolve(eventPage(event));
    await opening;
    expect(controller.snapshot()).toMatchObject({
      phase: "stale",
      captureRevision: null,
      freshness: "stale"
    });
  });

  it.each([
    ["reader", { deviceId: "device-event-replacement-private" }],
    ["thread", { projectedThreadId: "thread-event-replaced-private" }],
    ["runtime", { runtimeVersion: "0.145.0" }],
    ["route", { route: "mission_control" as const }],
    ["disclosure", { canRead: false }],
    ["selected event", { events: [] as readonly SelectedProjectionEvent[] }]
  ] as const)("closes and clears on %s replacement", async (_label, replacement) => {
    const event = eventOf("activity", 2);
    const controller = createController(
      eventPort({ read: async () => eventPage(event) }),
      context({ events: [event] })
    );
    await controller.open(2);

    const next = controller.updateContext(context({
      events: [event],
      epoch: 2,
      ...replacement
    }));

    expect(next.sheetOpen).toBe(false);
    expect(next.identity).toBeNull();
    expect(next.fields).toBeNull();
    expect(next.captureRevision).toBeNull();
  });

  it("retains selection when unrelated live events append", async () => {
    const selected = eventOf("message", 2);
    const appended = eventOf("activity", 3);
    const controller = createController(
      eventPort({ read: async () => eventPage(selected) }),
      context({ events: [selected] })
    );
    await controller.open(2);

    const view = controller.updateContext(context({ events: [selected, appended] }));
    expect(view).toMatchObject({
      sheetOpen: true,
      phase: "current",
      identity: { cursor: 2 }
    });
  });

  it.each([
    ["empty", () => ({ session_id: sessionId, events: [], next_cursor: 0, truncated: false })],
    ["multiple", () => eventPage(eventOf("message", 2), eventOf("activity", 3))],
    ["foreign", () => eventPage(eventOf("message", 2, { session: otherSessionId }))],
    ["advanced", () => eventPage(eventOf("activity", 3))],
    ["pruned replacement", () => eventPage(eventOf("replay_boundary", 2, { boundaryAfter: 1 }))],
    ["similar", () => eventPage(eventOf("message", 2, { text: "Similar but changed" }))]
  ] as const)("rejects a valid but %s event page", async (_label, response) => {
    const event = eventOf("message", 2);
    const controller = createController(
      eventPort({ read: async () => response() }),
      context({ events: [event] })
    );

    await controller.open(2);

    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      freshness: "stale",
      captureRevision: null,
      identity: { cursor: 2 }
    });
    expect(controller.snapshot().statusDetail).toMatch(/no longer matches|invalid event page/u);
  });

  it("rejects malformed response trees without exposing them", async () => {
    const event = eventOf("message", 2);
    const controller = createController(
      eventPort({
        read: async () => ({
          session_id: sessionId,
          events: [{ ...event, private_path: "/private/runtime/frame" }],
          next_cursor: 2,
          truncated: false
        })
      }),
      context({ events: [event] })
    );

    await controller.open(2);

    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      statusDetail: "HostDeck returned invalid event details. The retained event remains stale."
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("/private/runtime/frame");
  });

  it.each([
    "message",
    "turn",
    "activity",
    "approval",
    "control",
    "runtime",
    "replay_boundary",
    "unknown_optional"
  ] as const)("projects the explicit %s payload allowlist", async (type) => {
    const event = eventOf(
      type,
      2,
      type === "replay_boundary" ? { boundaryAfter: 1 } : {}
    );
    const boundary = type === "replay_boundary"
      ? { after: 1, cursor: 2, reason: "retention" as const }
      : null;
    const controller = createController(
      eventPort({ read: async () => eventPage(event) }),
      context({ events: [event], boundary })
    );

    await controller.open(2);
    const view = controller.snapshot();

    expect(view.phase).toBe("current");
    expect(view.identity?.normalizedType).toBe(type);
    expect(view.fields?.length).toBeGreaterThan(0);
    expect(view.fields?.every((field) => Object.isFrozen(field))).toBe(true);
    expect(JSON.stringify(view)).not.toContain(threadId);
    expect(JSON.stringify(view)).not.toContain("/private/event-diagnostics");
    expect(JSON.stringify(view)).not.toContain("device-event-diagnostics-private");
    expect(JSON.stringify(view)).not.toContain("fixture-tailnet.ts.net");
  });

  it.each([
    ["complete", null, true, false, "Bounded event summary"],
    ["redacted", "Redacted by projection policy.", false, true, "Content redacted"],
    ["truncated", "Truncated at the event limit.", false, false, "Content truncated"],
    [
      "redacted_and_truncated",
      "Redacted and truncated by projection policy.",
      false,
      true,
      "Content redacted and truncated"
    ]
  ] as const)(
    "keeps %s content truth exact",
    async (contentState, notice, complete, redaction, label) => {
      const event = eventOf("message", 2, { contentState, notice });
      const controller = createController(
        eventPort({ read: async () => eventPage(event) }),
        context({ events: [event] })
      );

      await controller.open(2);

      expect(controller.snapshot()).toMatchObject({
        limitation: { contentState, label, notice },
        diagnostics: {
          projection_complete: complete,
          boundary_visible: false,
          redaction_visible: redaction,
          incomplete_reason: notice
        }
      });
    }
  );

  it("preserves null, empty, multiline, unicode, control-like, and maximum text distinctly", async () => {
    const text = `${"x".repeat(11_950)}\n<script>alert('no')</script>\n测试`;
    const event = eventOf("message", 2, { text, itemId: null });
    const controller = createController(
      eventPort({ read: async () => eventPage(event) }),
      context({ events: [event] })
    );

    await controller.open(2);
    const fields = controller.snapshot().fields ?? [];
    const item = fields.find((field) => field.id === "item-id");
    const message = fields.find((field) => field.id === "text");

    expect(item).toMatchObject({ value: null, state: "not_reported", expandable: false });
    expect(message).toMatchObject({ value: text, state: "reported", expandable: true });
    expect(message?.value).toHaveLength(text.length);

    const empty = eventOf("message", 3, { text: "" });
    const emptyController = createController(
      eventPort({ read: async () => eventPage(empty) }),
      context({ events: [empty] })
    );
    await emptyController.open(3);
    expect(emptyController.snapshot().fields?.find((field) => field.id === "text")).toMatchObject({
      value: "",
      state: "empty"
    });
  });

  it.each([
    ["session_not_found", "This session no longer exists."],
    ["stale_session", "The retained event is no longer current in event storage."],
    ["permission_denied", "This phone cannot read current event details."],
    ["operation_timeout", "The event verification timed out."],
    ["rate_limited", "Event reads are temporarily rate limited."],
    ["service_overloaded", "HostDeck is temporarily too busy to verify this event."],
    ["protocol_error", "HostDeck could not validate the current event page."]
  ] as const)("sanitizes %s API failures", async (code, expected) => {
    const event = eventOf("message", 2);
    const controller = createController(
      eventPort({ read: async () => { throw httpApiError(code); } }),
      context({ events: [event] })
    );

    await controller.open(2);

    expect(controller.snapshot().statusDetail).toBe(expected);
    expect(JSON.stringify(controller.snapshot())).not.toContain("Private API message");
    expect(JSON.stringify(controller.snapshot())).not.toContain("private_detail");
  });

  it.each([
    ["invalid_response", "HostDeck could not validate the current event page."],
    ["response_too_large", "HostDeck could not validate the current event page."],
    ["capacity_exhausted", "HostDeck is temporarily too busy to verify this event."],
    ["caller_aborted", "The event verification was interrupted."],
    ["transport_unavailable", "HostDeck could not reach the event service."]
  ] as const)("classifies %s browser-client failures", async (reason, expected) => {
    const event = eventOf("message", 2);
    const controller = createController(
      eventPort({
        read: async () => {
          throw new HostDeckBrowserHttpError({
            reason,
            routeId: "session_events",
            transport: "https"
          });
        }
      }),
      context({ events: [event] })
    );

    await controller.open(2);

    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      statusDetail: expected,
      freshness: "stale"
    });
  });

  it("fails loudly for malformed construction, context, cursors, and ambiguous ownership", () => {
    const event = eventOf("message", 2);
    const port = eventPort();
    const valid = context({ events: [event] });

    expect(() => createEventDiagnosticsController({
      sessionId,
      context: valid,
      port,
      extra: true
    } as never)).toThrow("options are invalid");
    expect(() => createEventDiagnosticsController({ sessionId, context: valid, port: {} } as never))
      .toThrow("port is invalid");
    expect(() => createController(port, { ...valid, events: [event, event] }))
      .toThrow("invalid event ownership");
    expect(() => createController(port, context({
      events: [eventOf("message", 2, { session: otherSessionId })]
    }))).toThrow("invalid event ownership");
    expect(() => createController(port, {
      ...valid,
      boundary: { after: 1, cursor: 2, reason: "disconnect" }
    })).toThrow("contradictory boundary evidence");

    const controller = createController(port, valid);
    expect(() => controller.open(-1)).toThrow("cursor is invalid");
    expect(() => controller.open(Number.MAX_SAFE_INTEGER + 1)).toThrow("cursor is invalid");
    expect(() => controller.open(99)).toThrow("cursor is not retained");
  });

  it("owns subscriptions, dismissal cancellation, deep immutability, and terminal close", async () => {
    const event = eventOf("message", 2);
    const pending = deferred<unknown>();
    const port = eventPort({ read: async () => pending.promise });
    const controller = createController(port, context({ events: [event] }));
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const opening = controller.open(2);
    const signal = port.read.mock.calls[0]?.[0].signal;

    const dismissed = controller.dismiss();
    expect(signal?.aborted).toBe(true);
    expect(dismissed).toMatchObject({ sheetOpen: false, phase: "closed" });
    expect(Object.isFrozen(dismissed)).toBe(true);
    pending.resolve(eventPage(event));
    await opening;
    expect(controller.snapshot().sheetOpen).toBe(false);

    unsubscribe();
    const calls = listener.mock.calls.length;
    controller.close();
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(controller.snapshot()).toMatchObject({ visible: false, phase: "hidden" });
    expect(() => controller.subscribe(() => undefined)).toThrow("listener is invalid");
    expect(() => controller.updateContext(context({ events: [event] }))).toThrow("is closed");
  });
});

function createController(
  port: EventDiagnosticsPort,
  initialContext: EventDiagnosticsContext
) {
  return createEventDiagnosticsController({ sessionId, context: initialContext, port });
}

function eventPort(
  input: Readonly<{ read?: EventDiagnosticsPort["read"] }> = {}
) {
  return {
    read: vi.fn(input.read ?? (async ({ sessionId: target, after }) => {
      throw new Error(`No event fixture for ${target}:${after}`);
    }))
  };
}

function eventOf(
  type: SelectedProjectionEvent["type"],
  cursor: number,
  options: Readonly<{
    session?: SessionId;
    contentState?: SelectedProjectionEvent["content_state"];
    notice?: string | null;
    text?: string;
    itemId?: string | null;
    boundaryAfter?: number | null;
  }> = {}
): SelectedProjectionEvent {
  const contentState = options.contentState ?? "complete";
  const base = {
    session_id: options.session ?? sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: upstreamTimestamp,
    codex_event_id: `codex-event-${cursor}`,
    codex_event_type: "item/message",
    content_state: contentState,
    content_notice: contentState === "complete"
      ? null
      : options.notice ?? "Projected content is limited."
  };
  switch (type) {
    case "message":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        role: "agent",
        phase: "completed",
        item_id: options.itemId === undefined ? `item-event-${cursor}` : options.itemId,
        text: options.text ?? "Bounded event detail."
      });
    case "turn":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        turn_id: `turn-event-${cursor}`,
        state: "completed",
        error: null
      });
    case "activity":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        activity: "tool",
        state: "completed",
        item_id: null,
        title: "Inspect bounded event",
        detail: "Only normalized detail is retained."
      });
    case "approval":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        request_id: `request-event-${cursor}`,
        state: "pending",
        action: "Run selected validation",
        scope: "Current workspace",
        reason: "Verify one bounded event.",
        risk: "elevated",
        expires_at: "2026-07-27T19:00:00.000Z",
        decision: null
      });
    case "control":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        control: "model",
        state: "active",
        value_summary: "gpt-5.5-codex"
      });
    case "runtime":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        state: "ready",
        message: null
      });
    case "replay_boundary":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        after: options.boundaryAfter === undefined ? cursor - 1 : options.boundaryAfter,
        next_cursor: cursor,
        reason: "retention"
      });
    case "unknown_optional":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        upstream_type: "future/event",
        summary: "A bounded optional event summary."
      });
  }
}

function eventPage(
  ...events: readonly SelectedProjectionEvent[]
) {
  const finalCursor = events.at(-1)?.cursor ?? 0;
  return selectedEventPageResponseSchema.parse({
    session_id: events[0]?.session_id ?? sessionId,
    events,
    next_cursor: finalCursor,
    truncated: events[0]?.type === "replay_boundary"
  });
}

function context(
  input: Readonly<{
    events?: readonly SelectedProjectionEvent[];
    boundary?: EventDiagnosticsContext["boundary"];
    epoch?: number;
    deviceId?: string;
    permission?: "read" | "write";
    locked?: boolean;
    canRead?: boolean;
    accessState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    projectedThreadId?: string;
    runtimeVersion?: string;
    freshness?: "current" | "stale";
    turnState?: "idle" | "in_progress" | "waiting_for_input" | "unknown";
    csrfGeneration?: number;
    route?: "session_detail" | "mission_control";
  }> = {}
): EventDiagnosticsContext {
  const events = input.events ?? [eventOf("message", 2)];
  const firstCursor = events[0]?.cursor ?? null;
  const lastCursor = events.at(-1)?.cursor ?? null;
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: input.projectedThreadId ?? threadId,
    cwd: "/private/event-diagnostics",
    runtime_source: "codex_app_server",
    runtime_version: input.runtimeVersion ?? "0.148.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness: input.freshness ?? "current",
    freshness_reason: input.freshness === "stale" ? "Projection requires refresh." : null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/event-diagnostics",
    model: "runtime-event-model",
    settings: null,
    goal: null,
    recent_summary: "Validate bounded event diagnostics.",
    last_event_cursor: lastCursor
  });
  const count = firstCursor === null || lastCursor === null
    ? 0
    : lastCursor - firstCursor + 1;
  const item = selectedSessionReadItemSchema.parse({
    session,
    event_window: count === 0
      ? {
          state: "empty",
          retained_event_count: 0,
          earliest_retained_cursor: null,
          boundary_cursor: null
        }
      : {
          state: "contiguous",
          retained_event_count: count,
          earliest_retained_cursor: firstCursor,
          boundary_cursor: null
        }
  });
  const response = selectedSessionDetailResponseSchema.parse({
    access: { mode: "paired_read", network_mode: "remote", transport: "https" },
    session: item
  });
  const canRead = input.canRead ?? true;
  const route = input.route ?? "session_detail";
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: route === "session_detail"
      ? Object.freeze({ kind: "session_detail" as const, sessionId })
      : Object.freeze({ kind: "mission_control" as const }),
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
      continuity: input.boundary === undefined || input.boundary === null
        ? "contiguous" as const
        : "boundary" as const,
      boundary: input.boundary ?? null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: input.csrfGeneration === undefined ? "idle" as const : "ready" as const,
      generation: input.csrfGeneration ?? null,
      rotatedAt: input.csrfGeneration === undefined ? null : timestamp,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: (input.permission ?? "read") === "write" && !(input.locked ?? false),
      causes: Object.freeze([])
    }),
    lastFailure: null
  });
  return Object.freeze({
    snapshot,
    events,
    boundary: input.boundary ?? null
  });
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
    device_id: input.deviceId ?? "device-event-diagnostics-private",
    permission,
    device_expires_at: "2026-10-27T18:00:00.000Z",
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

function httpApiError(code: ApiErrorEnvelope["code"]) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "session_events",
    transport: "https",
    status: 409,
    apiError: {
      code,
      message: "Private API message with private_detail.",
      retryable: true
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
