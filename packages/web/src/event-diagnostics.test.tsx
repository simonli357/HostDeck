// @vitest-environment jsdom

import {
  managedSessionProjectionSchema,
  type SelectedProjectionEvent,
  selectedAccessStateResponseSchema,
  selectedEventPageResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  EventDiagnosticsAction,
  EventDiagnosticsSheet,
  useEventDiagnosticsController
} from "./event-diagnostics.js";
import { createEventDiagnosticsController } from "./event-diagnostics-state.js";
import {
  projectSessionDetail,
  SessionDetailScreen
} from "./session-detail.js";
import {
  appendSessionDetailEvent,
  createSessionDetailFeed,
  type SessionDetailContinuityBoundary,
  type SessionDetailFeedState
} from "./session-detail-feed.js";

const sessionId = "sess_event_diagnostics_ui_001" as SessionId;
const timestamp = "2026-07-27T20:00:00.000Z";
const threadId = "thread-event-diagnostics-ui-private";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("event diagnostics UI", () => {
  it("opens one exact event page, renders bounded detail, and restores focus", async () => {
    const user = userEvent.setup();
    const event = messageEvent(2);
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200 as const,
      data: eventPage(event)
    }));
    render(
      <StrictMode>
        <EventDiagnosticsSurface
          coordinator={coordinatorWith(requestSelectedSessionRead)}
          cursor={2}
          feed={feedWith(event)}
          snapshot={snapshot([event])}
        />
      </StrictMode>
    );
    const trigger = screen.getByRole("button", { name: "View event details" });

    await user.click(trigger);

    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(requestSelectedSessionRead.mock.calls[0]).toEqual([
      "session_events",
      {
        params: { session_id: sessionId },
        query: { after: "1", limit: "1" }
      },
      { signal: expect.any(AbortSignal) }
    ]);
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(within(dialog).getByText("Target:").parentElement?.textContent).toContain(
      "android-event-release"
    );
    expect(within(dialog).getByRole("heading", { name: "Message event" })).toBeTruthy();
    expect(within(dialog).getByText("Bounded event summary")).toBeTruthy();
    expect(within(dialog).getByText("HostDeck summary")).toBeTruthy();
    expect(within(dialog).getByText("Bounded UI event detail.")).toBeTruthy();
    expect(await within(dialog).findByText("Event details current")).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Close event details" })
      );
    });

    await user.click(within(dialog).getByRole("button", { name: "Close event details" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Event details" })).toBeTruthy());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toContain(threadId);
    expect(document.body.innerHTML).not.toContain("/private/event-diagnostics-ui");
    expect(document.body.innerHTML).not.toContain("device-event-diagnostics-ui-private");
    expect(document.body.innerHTML).not.toContain("fixture-tailnet.ts.net");
  });

  it("omits after only for a persisted boundary with nullable prior cursor", async () => {
    const user = userEvent.setup();
    const event = boundaryEvent(1, null);
    const boundary = { after: null, cursor: 1, reason: "retention" as const };
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200 as const,
      data: eventPage(event)
    }));
    render(
      <EventDiagnosticsSurface
        boundary={boundary}
        coordinator={coordinatorWith(requestSelectedSessionRead)}
        cursor={1}
        feed={feedWith(event)}
        snapshot={snapshot([event], boundary)}
      />
    );

    await user.click(screen.getByRole("button", { name: "View event details" }));

    expect(requestSelectedSessionRead).toHaveBeenCalledWith(
      "session_events",
      {
        params: { session_id: sessionId },
        query: { limit: "1" }
      },
      { signal: expect.any(AbortSignal) }
    );
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(within(dialog).getByText("Retention boundary")).toBeTruthy();
    expect(within(dialog).getByText("Persisted normalized event")).toBeTruthy();
    expect(within(dialog).getAllByText("Not reported").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Replay boundary visible")).toBeTruthy();
  });

  it("retains stale detail after failure and retries only on the explicit action", async () => {
    const user = userEvent.setup();
    const event = messageEvent(2);
    let reads = 0;
    const requestSelectedSessionRead = vi.fn(async () => {
      reads += 1;
      if (reads === 1) throw new Error("private browser failure /tmp/secret");
      return { status: 200 as const, data: eventPage(event) };
    });
    render(
      <EventDiagnosticsSurface
        coordinator={coordinatorWith(requestSelectedSessionRead)}
        cursor={2}
        feed={feedWith(event)}
        snapshot={snapshot([event])}
      />
    );

    await user.click(screen.getByRole("button", { name: "View event details" }));
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(await within(dialog).findByText("Event verification failed")).toBeTruthy();
    expect(within(dialog).getByText("HostDeck could not verify this retained event.")).toBeTruthy();
    expect(within(dialog).getByText("Bounded UI event detail.")).toBeTruthy();
    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain("/tmp/secret");

    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(2);
    expect(await within(dialog).findByText("Event details current")).toBeTruthy();
  });

  it("discloses long hostile-looking text without link, script, copy, or download semantics", async () => {
    const user = userEvent.setup();
    const longText = `${"x".repeat(11_900)}\n<script>window.privateValue = true</script>\nhttps://example.invalid/private`;
    const event = messageEvent(2, longText);
    render(
      <EventDiagnosticsSurface
        coordinator={coordinatorWith(vi.fn(async () => ({
          status: 200 as const,
          data: eventPage(event)
        })))}
        cursor={2}
        feed={feedWith(event)}
        snapshot={snapshot([event])}
      />
    );

    await user.click(screen.getByRole("button", { name: "View event details" }));
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    const textLabel = within(dialog).getByText("Text");
    const value = textLabel.nextElementSibling;
    expect(value?.classList.contains("hostdeck-event-field__value--collapsed")).toBe(true);
    expect(value?.textContent).toBe(longText);

    await user.click(within(dialog).getByRole("button", { name: "Expand field" }));
    expect(value?.classList.contains("hostdeck-event-field__value--collapsed")).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Collapse field" })).toBeTruthy();
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelector("a")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /copy|download/u })).toBeNull();
  });

  it("opens continuity-only evidence without calling the event route", async () => {
    const user = userEvent.setup();
    const boundary = { after: 8, cursor: 9, reason: "restart" as const };
    const requestSelectedSessionRead = vi.fn();
    render(
      <EventDiagnosticsSurface
        boundary={boundary}
        coordinator={coordinatorWith(requestSelectedSessionRead)}
        cursor={9}
        feed={createSessionDetailFeed(sessionId)}
        snapshot={snapshot([], boundary)}
      />
    );

    await user.click(screen.getByRole("button", { name: "View event details" }));

    expect(requestSelectedSessionRead).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(within(dialog).getByText("Local evidence only")).toBeTruthy();
    expect(within(dialog).getByText("Stream continuity evidence")).toBeTruthy();
    expect(within(dialog).getByText("Stream continuity evidence; not a persisted event")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("keeps one in-flight read under StrictMode and cancels it on unmount", async () => {
    const user = userEvent.setup();
    const event = messageEvent(2);
    const pending = deferred<ReturnType<typeof eventPage>>();
    const requestSelectedSessionRead = vi.fn(
      async (
        _routeId: unknown,
        _input: unknown,
        _options?: Readonly<{ signal: AbortSignal }>
      ) => ({
        status: 200 as const,
        data: await pending.promise
      })
    );
    const rendered = render(
      <StrictMode>
        <EventDiagnosticsSurface
          coordinator={coordinatorWith(requestSelectedSessionRead)}
          cursor={2}
          feed={feedWith(event)}
          snapshot={snapshot([event])}
        />
      </StrictMode>
    );

    await user.click(screen.getByRole("button", { name: "View event details" }));
    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    const signal = requestSelectedSessionRead.mock.calls[0]?.[2]?.signal;
    rendered.unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
    pending.resolve(eventPage(event));
  });

  it("gives one consolidated timeline row one action for its latest event", async () => {
    const user = userEvent.setup();
    const first = selectedProjectionEventSchema.parse({
      ...eventBase(1),
      type: "message",
      role: "agent",
      phase: "delta",
      item_id: "item-event-ui-consolidated",
      text: "Draft "
    });
    const latest = selectedProjectionEventSchema.parse({
      ...eventBase(2),
      type: "message",
      role: "agent",
      phase: "completed",
      item_id: "item-event-ui-consolidated",
      text: "Authoritative result"
    });
    const retainedFeed = feedWith(first, latest);
    const currentSnapshot = snapshot([first, latest]);
    const read = vi.fn(async () => eventPage(latest));
    const controller = createEventDiagnosticsController({
      sessionId,
      context: Object.freeze({
        snapshot: currentSnapshot,
        events: retainedFeed.events,
        boundary: null
      }),
      port: Object.freeze({ read })
    });
    const projected = projectSessionDetail(
      currentSnapshot,
      sessionId,
      retainedFeed,
      Date.parse(timestamp),
      () => "8:00 PM"
    );

    render(
      <SessionDetailScreen
        sessionId={sessionId}
        snapshot={currentSnapshot}
        feed={retainedFeed}
        nowMs={Date.parse(timestamp)}
        eventDiagnostics={controller}
        projection={Object.freeze({ ...projected, replayPending: false })}
      />
    );

    const actions = screen.getAllByRole("button", { name: "View event details" });
    expect(actions).toHaveLength(1);
    await user.click(actions[0] as HTMLButtonElement);
    expect(read).toHaveBeenCalledWith({
      sessionId,
      after: 1,
      limit: 1,
      signal: expect.any(AbortSignal)
    });
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(within(dialog).getByText("Authoritative result")).toBeTruthy();
    expect(within(dialog).getByText("2")).toBeTruthy();
  });
});

function EventDiagnosticsSurface({
  boundary = null,
  coordinator,
  cursor,
  feed,
  snapshot: currentSnapshot
}: Readonly<{
  boundary?: SessionDetailContinuityBoundary | null;
  coordinator: BrowserConnectionStateCoordinator;
  cursor: number;
  feed: SessionDetailFeedState;
  snapshot: BrowserConnectionSnapshot;
}>) {
  const controller = useEventDiagnosticsController(
    coordinator,
    sessionId,
    currentSnapshot,
    feed,
    boundary
  );
  const originRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <EventDiagnosticsAction
        controller={controller}
        cursor={cursor}
        originRef={originRef}
      />
      <EventDiagnosticsSheet controller={controller} originRef={originRef} />
    </>
  );
}

function coordinatorWith(
  requestSelectedSessionRead: unknown
): BrowserConnectionStateCoordinator {
  return {
    requestSelectedSessionRead:
      requestSelectedSessionRead as BrowserConnectionStateCoordinator["requestSelectedSessionRead"]
  } as BrowserConnectionStateCoordinator;
}

function feedWith(...events: readonly SelectedProjectionEvent[]): SessionDetailFeedState {
  return events.reduce(appendSessionDetailEvent, createSessionDetailFeed(sessionId));
}

function messageEvent(cursor: number, text = "Bounded UI event detail.") {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: `item-event-ui-${cursor}`,
    text
  });
}

function boundaryEvent(cursor: number, after: number | null) {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason: "retention"
  });
}

function eventBase(cursor: number) {
  return {
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: `codex-event-ui-${cursor}`,
    codex_event_type: "item/message",
    content_state: "complete" as const,
    content_notice: null
  };
}

function eventPage(event: SelectedProjectionEvent) {
  return selectedEventPageResponseSchema.parse({
    session_id: sessionId,
    events: [event],
    next_cursor: event.cursor,
    truncated: event.type === "replay_boundary"
  });
}

function snapshot(
  events: readonly SelectedProjectionEvent[],
  boundary: SessionDetailContinuityBoundary | null = null
): BrowserConnectionSnapshot {
  const firstCursor = events[0]?.cursor ?? null;
  const lastCursor = events.at(-1)?.cursor ?? null;
  const count = firstCursor === null || lastCursor === null
    ? 0
    : lastCursor - firstCursor + 1;
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-event-release",
    codex_thread_id: threadId,
    cwd: "/private/event-diagnostics-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/event-diagnostics-ui",
    model: "runtime-event-ui-model",
    settings: null,
    goal: null,
    recent_summary: "Validate bounded event diagnostics UI.",
    last_event_cursor: lastCursor
  });
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
  const access = selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-event-diagnostics-ui-private",
    permission: "read",
    device_expires_at: "2026-10-27T20:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
  return Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready" as const,
    access: resource(access),
    host: resource(null),
    targetState: resource(Object.freeze({ kind: "session_detail" as const, response })),
    stream: Object.freeze({
      state: "connected" as const,
      snapshot: null,
      continuity: boundary === null ? "contiguous" as const : "boundary" as const,
      boundary,
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
}

function resource<Data>(data: Data | null) {
  return Object.freeze({
    state: "current" as const,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
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
