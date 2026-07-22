// @vitest-environment jsdom

import {
  managedSessionProjectionSchema,
  type SelectedAccessStateResponse,
  type SelectedProjectionEvent,
  selectedAccessStateResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostDeckRoutes } from "./app-shell.js";
import type {
  BrowserConnectionFailure,
  BrowserConnectionPhase,
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  ConnectedSessionDetail,
  projectSessionDetail,
  SessionDetailScreen
} from "./session-detail.js";
import {
  appendSessionDetailEvent,
  createSessionDetailFeed
} from "./session-detail-feed.js";

const sessionId = "sess_detail_screen_001" as SessionId;
const timestamp = "2026-07-22T18:00:00.000Z";
const laterTimestamp = "2026-07-22T18:01:00.000Z";
const nowMs = Date.parse("2026-07-22T18:05:00.000Z");
const remoteOrigin = "https://hostdeck-laptop.tail295ac2.ts.net";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Session Detail projection", () => {
  it("suppresses retained identity and activity when readable authority is lost", () => {
    const feed = appendSessionDetailEvent(
      createSessionDetailFeed(sessionId),
      messageEvent(1, "Confidential customer detail")
    );
    const snapshot = detailSnapshot({
      access: deniedAccess("revoked_device"),
      phase: "access_limited"
    });
    const projection = projectSessionDetail(
      snapshot,
      sessionId,
      feed,
      nowMs,
      () => "2:00 PM"
    );

    expect(projection.canDisclose).toBe(false);
    expect(projection.timeline).toEqual([]);
    expect(projection.headerTitle).toBe("Session Detail");
    expect(projection.headerSubtitle).toBe("Access required");
    expect(projection.notices[0]?.title).toBe("Device access was revoked");

    renderDetail(snapshot, feed);
    const region = screen.getByRole("region", { name: "Session Detail" });
    expect(region.textContent).not.toContain("api-refactor");
    expect(region.textContent).not.toContain("Confidential customer detail");
    expect(region.textContent).not.toContain("private-workspace");
    expect(region.textContent).not.toContain("1 event");
  });

  it("keeps stale, reconnecting, and retained-boundary truth independently visible", () => {
    const feed = appendSessionDetailEvent(
      createSessionDetailFeed(sessionId),
      messageEvent(6, "Retained agent response")
    );
    const snapshot = detailSnapshot({
      accessState: "stale",
      targetState: "stale",
      session: sessionItem({ cursor: 6, bounded: true, freshness: "stale" }),
      phase: "degraded",
      streamState: "reconnecting",
      streamCursor: 6,
      boundary: { after: 0, cursor: 1, reason: "retention" }
    });
    const projection = projectSessionDetail(
      snapshot,
      sessionId,
      feed,
      nowMs,
      () => "2:00 PM"
    );

    expect(projection.stale).toBe(true);
    expect(projection.notices.map((notice) => notice.title)).toEqual([
      "Showing stale session state",
      "Activity stream reconnecting"
    ]);
    expect(projection.timeline[0]?.title).toBe("Earlier activity unavailable");
    expect(projection.contextCells[2]).toMatchObject({
      label: "Stream",
      value: "Stale",
      detail: "Refresh required"
    });

    renderDetail(snapshot, feed);
    expect(screen.getByText("Showing stale session state")).toBeTruthy();
    expect(screen.getByText("Activity stream reconnecting")).toBeTruthy();
    expect(screen.getByText("Earlier activity unavailable")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it.each([
    ["in_progress", "watch", "Running"],
    ["waiting_for_input", "needs_input", "Needs input"],
    ["waiting_for_approval", "needs_approval", "Needs approval"],
    ["completed", "none", "Quiet"],
    ["interrupted", "stuck", "Interrupted"],
    ["failed", "failed", "Failed"],
    ["unknown", "unknown", "Unknown"]
  ] as const)("maps %s detail state to %s", (turnState, attention, expected) => {
    const snapshot = detailSnapshot({
      session: sessionItem({ cursor: 1, turnState, attention })
    });
    const projection = projectSessionDetail(
      snapshot,
      sessionId,
      appendSessionDetailEvent(createSessionDetailFeed(sessionId), messageEvent(1)),
      nowMs,
      () => "2:00 PM"
    );

    expect(projection.contextCells[0]?.value).toBe(expected);
    expect(projection.headerSubtitle).toContain(expected);
  });

  it("distinguishes loading, empty, failed, and not-found states without fake activity", () => {
    const emptyFeed = createSessionDetailFeed(sessionId);
    const loading = detailSnapshot({
      access: null,
      accessState: "loading",
      phase: "loading",
      targetData: false,
      targetState: "loading",
      streamState: "idle"
    });
    expect(projectSessionDetail(loading, sessionId, emptyFeed, nowMs).loading).toBe(true);

    const empty = detailSnapshot({ session: sessionItem({ cursor: null }) });
    expect(projectSessionDetail(empty, sessionId, emptyFeed, nowMs).empty).toBe(true);

    const failed = detailSnapshot({ streamState: "failed", streamCursor: 1 });
    const failedProjection = projectSessionDetail(failed, sessionId, emptyFeed, nowMs);
    expect(failedProjection.notices[0]?.title).toBe("Live activity stopped");
    expect(failedProjection.activityUnavailable).toBe(true);
    expect(failedProjection.empty).toBe(false);

    const notFound = detailSnapshot({
      phase: "not_found",
      targetData: false,
      targetState: "not_found",
      streamState: "idle"
    });
    expect(projectSessionDetail(notFound, sessionId, emptyFeed, nowMs).notices[0]?.title).toBe(
      "Session unavailable"
    );
  });

  it("keeps initial replay pending only until the detail baseline is observed", () => {
    const feed = appendSessionDetailEvent(
      createSessionDetailFeed(sessionId),
      messageEvent(1)
    );
    const pending = detailSnapshot({ streamState: "connected", streamCursor: 1 });
    expect(projectSessionDetail(pending, sessionId, feed, nowMs).replayPending).toBe(true);

    const complete = detailSnapshot({ streamState: "connected", streamCursor: 2 });
    expect(projectSessionDetail(complete, sessionId, feed, nowMs).replayPending).toBe(false);

    const emptyConnecting = detailSnapshot({
      session: sessionItem({ cursor: null }),
      streamState: "connecting",
      streamCursor: null
    });
    expect(
      projectSessionDetail(emptyConnecting, sessionId, createSessionDetailFeed(sessionId), nowMs)
        .replayPending
    ).toBe(true);
    const emptyConnected = detailSnapshot({
      session: sessionItem({ cursor: null }),
      streamState: "connected",
      streamCursor: null
    });
    expect(
      projectSessionDetail(emptyConnected, sessionId, createSessionDetailFeed(sessionId), nowMs)
        .replayPending
    ).toBe(false);
  });
});

describe("Session Detail screen", () => {
  it("integrates with the app frame without exposing the route identifier", async () => {
    const harness = coordinatorHarness(detailSnapshot());
    render(
      <MemoryRouter initialEntries={[`/sessions/${sessionId}`]}>
        <HostDeckRoutes
          coordinator={harness.coordinator}
          outlets={{ hostAccess: <span>Paired device</span> }}
        />
      </MemoryRouter>
    );

    const banner = screen.getByRole("banner");
    expect(banner.textContent).toContain("api-refactor");
    expect(banner.textContent).toContain("Running / api-refactor");
    expect(banner.textContent).not.toContain(sessionId);

    fireEvent.click(screen.getByRole("button", { name: "Back to Mission Control" }));
    expect(await screen.findByRole("heading", { name: "Mission Control" })).toBeTruthy();
  });

  it("renders semantic timeline content without raw route or runtime identifiers", () => {
    let feed = createSessionDetailFeed(sessionId);
    feed = appendSessionDetailEvent(feed, messageEvent(1, "Review the selected boundary."));
    feed = appendSessionDetailEvent(feed, approvalEvent(2));
    const snapshot = detailSnapshot({ streamCursor: 2 });

    renderDetail(snapshot, feed);

    expect(screen.getByRole("list", { name: "Session activity" })).toBeTruthy();
    expect(screen.getByText("Review the selected boundary.")).toBeTruthy();
    expect(screen.getByText("Approval required")).toBeTruthy();
    expect(screen.getByText("Run contract tests")).toBeTruthy();
    expect(screen.getByText("Workspace write")).toBeTruthy();
    expect(screen.getAllByText("2:00 PM")).toHaveLength(2);
    const region = screen.getByRole("region", { name: "api-refactor activity" });
    expect(region.textContent).not.toContain(sessionId);
    expect(region.textContent).not.toContain("thread-private-detail");
    expect(region.textContent).not.toContain("request-private-detail");
    expect(region.textContent).not.toContain("/private/private-workspace");
    expect(screen.queryByRole("button", { name: /approve|deny/u })).toBeNull();
  });

  it("does not force-scroll while away and exposes a bounded return-to-live control", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    const snapshot = detailSnapshot({
      session: sessionItem({ cursor: 1 }),
      streamCursor: 1
    });
    const firstFeed = appendSessionDetailEvent(
      createSessionDetailFeed(sessionId),
      messageEvent(1)
    );
    const view = renderDetail(snapshot, firstFeed);
    const end = document.querySelector(".hostdeck-detail-timeline__end") as HTMLDivElement;
    Object.defineProperty(end, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 2_000,
        top: 2_000,
        right: 1,
        bottom: 2_001,
        left: 0,
        width: 1,
        height: 1,
        toJSON: () => ({})
      })
    });
    fireEvent.scroll(window);
    scrollIntoView.mockClear();

    const secondFeed = appendSessionDetailEvent(firstFeed, activityEvent(2));
    view.rerender(
      detailScreen(detailSnapshot({ streamCursor: 2 }), secondFeed)
    );

    expect(screen.getByRole("button", { name: "1 new event" })).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "1 new event" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "1 new event" })).toBeNull();
  });
});

describe("Session Detail controller", () => {
  it("owns exact recent setup, event delivery, single-flight refresh, and cleanup", async () => {
    const refresh = deferred<BrowserConnectionSnapshot>();
    const harness = coordinatorHarness(detailSnapshot({ streamState: "idle" }), refresh.promise);
    const view = render(
      <MemoryRouter>
        <ConnectedSessionDetail
          coordinator={harness.coordinator}
          sessionId={sessionId}
          now={() => nowMs}
          formatTimestamp={() => "2:00 PM"}
        />
      </MemoryRouter>
    );

    await waitFor(() => expect(harness.setTarget).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));
    expect(harness.setTarget).toHaveBeenCalledWith({
      kind: "session_detail",
      sessionId
    });
    expect(harness.connect.mock.calls[0]?.[1]).toEqual({ start: "recent" });

    const consumer = harness.connect.mock.calls[0]?.[0];
    consumer?.(messageEvent(1, "Delivered through the coordinator."));
    expect(await screen.findByText("Delivered through the coordinator.")).toBeTruthy();

    const refreshButton = screen.getByRole("button", { name: "Refresh session" });
    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect((refreshButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Delivered through the coordinator.")).toBeNull();
    refresh.resolve(harness.snapshot());
    await waitFor(() => expect((refreshButton as HTMLButtonElement).disabled).toBe(false));

    view.unmount();
    expect(harness.disconnect).toHaveBeenCalledWith("unmounted");
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("purges local activity immediately after authority loss", async () => {
    const harness = coordinatorHarness(detailSnapshot({ streamState: "idle" }));
    render(
      <MemoryRouter>
        <ConnectedSessionDetail
          coordinator={harness.coordinator}
          sessionId={sessionId}
          now={() => nowMs}
          formatTimestamp={() => "2:00 PM"}
        />
      </MemoryRouter>
    );
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));
    harness.connect.mock.calls[0]?.[0](messageEvent(1, "Protected activity"));
    expect(await screen.findByText("Protected activity")).toBeTruthy();

    harness.publish(
      detailSnapshot({
        access: deniedAccess("revoked_device"),
        phase: "access_limited",
        streamState: "idle"
      })
    );
    expect(await screen.findByText("Device access was revoked")).toBeTruthy();
    expect(screen.queryByText("Protected activity")).toBeNull();

    harness.publish(detailSnapshot({ streamState: "idle" }));
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Protected activity")).toBeNull();
  });
});

function renderDetail(snapshot: BrowserConnectionSnapshot, feed = createSessionDetailFeed(sessionId)) {
  return render(detailScreen(snapshot, feed));
}

function detailScreen(snapshot: BrowserConnectionSnapshot, feed: ReturnType<typeof createSessionDetailFeed>) {
  return (
    <MemoryRouter>
      <SessionDetailScreen
        sessionId={sessionId}
        snapshot={snapshot}
        feed={feed}
        nowMs={nowMs}
        formatTimestamp={() => "2:00 PM"}
      />
    </MemoryRouter>
  );
}

function detailSnapshot(
  options: {
    readonly phase?: BrowserConnectionPhase;
    readonly access?: SelectedAccessStateResponse | null;
    readonly accessState?: BrowserConnectionResourceState;
    readonly targetState?: BrowserConnectionResourceState;
    readonly targetData?: boolean;
    readonly session?: ReturnType<typeof sessionItem>;
    readonly streamState?: "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "closed";
    readonly streamCursor?: number | null;
    readonly boundary?: {
      readonly after: number | null;
      readonly cursor: number;
      readonly reason: "retention" | "disconnect" | "restart" | "schema_change";
    } | null;
  } = {}
): BrowserConnectionSnapshot {
  const access = options.access === undefined ? pairedAccess() : options.access;
  const accessState = options.accessState ?? (access === null ? "loading" : "current");
  const targetState = options.targetState ?? "current";
  const item = options.session ?? sessionItem({ cursor: 2 });
  const response = selectedSessionDetailResponseSchema.parse({
    access: { mode: "paired_write", network_mode: "remote", transport: "https" },
    session: item
  });
  const streamState = options.streamState ?? "connected";
  const streamCursor = options.streamCursor === undefined
    ? item.session.last_event_cursor
    : options.streamCursor;
  const boundary = options.boundary === undefined ? null : options.boundary;
  const targetFailure = targetState === "failed" ? browserFailure("session_detail") : null;
  const streamFailure = streamState === "failed" ? browserFailure("session_stream") : null;
  return Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: options.phase ?? "ready",
    access: resource(
      accessState,
      access,
      accessState === "failed" ? browserFailure("access") : null
    ),
    host: resource("current", null, null),
    targetState: resource(
      targetState,
      options.targetData === false || targetState === "not_found"
        ? null
        : Object.freeze({ kind: "session_detail" as const, response }),
      targetFailure
    ),
    stream: Object.freeze({
      state: streamState,
      snapshot:
        streamState === "idle"
          ? null
          : Object.freeze({
              sessionId,
              transport: "https" as const,
              phase: streamState,
              cursor: streamCursor,
              continuity: boundary === null ? "contiguous" as const : "boundary" as const,
              boundary,
              retryCount: streamState === "reconnecting" ? 1 : 0,
              retryAt: null,
              lastHeartbeatAt: null,
              lastEventAt: null,
              failure: null,
              closeReason: null
            }),
      continuity: boundary === null ? "contiguous" as const : "boundary" as const,
      boundary,
      failure: streamFailure
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
      eligible: true,
      causes: Object.freeze([])
    }),
    lastFailure: targetFailure ?? streamFailure
  });
}

function sessionItem(
  options: {
    readonly cursor?: number | null;
    readonly bounded?: boolean;
    readonly turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
    readonly attention?: "none" | "watch" | "needs_input" | "needs_approval" | "failed" | "stuck" | "unknown";
    readonly freshness?: "current" | "stale" | "disconnected" | "incompatible";
  } = {}
) {
  const cursor = options.cursor === undefined ? 2 : options.cursor;
  const freshness = options.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "api-refactor",
    codex_thread_id: "thread-private-detail",
    cwd: "/private/private-workspace/api-refactor",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: options.turnState ?? "in_progress",
    attention: options.attention ?? "watch",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/session-detail",
    model: "gpt-5.5-codex",
    settings: null,
    goal: null,
    recent_summary: "Implement the bounded mobile Session Detail feed.",
    last_event_cursor: cursor
  });
  return selectedSessionReadItemSchema.parse({
    session,
    event_window:
      cursor === null
        ? {
            state: "empty",
            retained_event_count: 0,
            earliest_retained_cursor: null,
            boundary_cursor: null
          }
        : {
            state: options.bounded === true ? "bounded" : "contiguous",
            retained_event_count: cursor,
            earliest_retained_cursor: 1,
            boundary_cursor: options.bounded === true ? 0 : null
          }
  });
}

function pairedAccess(): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_detail_phone",
    permission: "write",
    device_expires_at: "2026-10-22T18:00:00.000Z",
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
    can_unlock: false
  });
}

function deniedAccess(
  authenticationState: "unpaired" | "invalid_device" | "expired_device" | "revoked_device"
): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: authenticationState,
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
}

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null,
  failure: BrowserConnectionFailure | null
) {
  return Object.freeze({
    state,
    data,
    failure,
    observedAt: data === null ? null : timestamp
  });
}

function browserFailure(
  source: BrowserConnectionFailure["source"]
): BrowserConnectionFailure {
  return Object.freeze({
    source,
    reason: "transport_unavailable",
    routeId:
      source === "access"
        ? "access_state"
        : source === "session_detail"
          ? "session_detail"
          : "session_event_stream",
    transport: "https",
    status: null,
    apiError: null,
    epoch: 1,
    observedAt: timestamp
  });
}

function eventBase(cursor: number) {
  return {
    session_id: sessionId,
    cursor,
    captured_at: cursor === 1 ? timestamp : laterTimestamp,
    upstream_at: null,
    codex_event_id: "codex-private-detail-event",
    codex_event_type: "private/detail/event",
    content_state: "complete" as const,
    content_notice: null
  };
}

function messageEvent(cursor: number, text = "Agent response"): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: "item-private-detail",
    text
  });
}

function activityEvent(cursor: number): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "activity",
    activity: "tool",
    state: "completed",
    item_id: null,
    title: "Read selected files",
    detail: "Reviewed the bounded contracts."
  });
}

function approvalEvent(cursor: number): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "approval",
    request_id: "request-private-detail",
    state: "pending",
    action: "Run contract tests",
    scope: "Workspace write",
    reason: "Validate the selected implementation.",
    risk: "elevated",
    expires_at: "2026-07-22T18:10:00.000Z",
    decision: null
  });
}

function coordinatorHarness(
  initial: BrowserConnectionSnapshot,
  refreshPromise?: Promise<BrowserConnectionSnapshot>
) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const setTarget = vi.fn(async () => snapshot);
  const connect = vi.fn<BrowserConnectionStateCoordinator["connectSessionStream"]>(
    () => snapshot
  );
  const disconnect = vi.fn(() => snapshot);
  const refresh = vi.fn(() => refreshPromise ?? Promise.resolve(snapshot));
  const coordinator = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
    setTarget,
    refresh,
    loadMoreSessions: vi.fn(async () => snapshot),
    connectSessionStream: connect,
    disconnectSessionStream: disconnect,
    bootstrapCsrf: vi.fn(async () => snapshot),
    adoptCsrfBootstrap: vi.fn(() => snapshot),
    requestProtected: vi.fn(),
    close: vi.fn(() => snapshot)
  } as unknown as BrowserConnectionStateCoordinator;
  return {
    coordinator,
    setTarget,
    connect,
    disconnect,
    refresh,
    unsubscribe,
    snapshot: () => snapshot,
    publish(next: BrowserConnectionSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };
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
