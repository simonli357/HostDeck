import {
  type SelectedProjectionEvent,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import {
  projectionActivityKinds,
  projectionContentStates,
  runtimeConnectionStates,
  structuredControlKinds,
  turnStates
} from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  appendSessionDetailEvent,
  createSessionDetailFeed,
  projectSessionDetailTimeline,
  sessionDetailFeedLimit
} from "./session-detail-feed.js";

const sessionId = "sess_detail_feed_001";
const otherSessionId = "sess_detail_feed_002";
const timestamp = "2026-07-22T18:00:00.000Z";
const formatTimestamp = () => "2:00 PM";

describe("Session Detail feed reducer", () => {
  it("accepts one ordered target, deduplicates exact cursors, and rejects contradictions", () => {
    const first = activityEvent(1, { title: "Read contracts" });
    const state = appendSessionDetailEvent(createSessionDetailFeed(sessionId), first);

    expect(appendSessionDetailEvent(state, first)).toBe(state);
    expect(() =>
      appendSessionDetailEvent(state, activityEvent(1, { title: "Changed cursor content" }))
    ).toThrow(/contradictory/u);
    expect(() => appendSessionDetailEvent(state, activityEvent(3))).toThrow(/gap/u);
    expect(() =>
      appendSessionDetailEvent(
        state,
        activityEvent(2, { session_id: otherSessionId })
      )
    ).toThrow(/target/u);
    expect(() =>
      appendSessionDetailEvent(state, { ...activityEvent(2), unexpected: true } as never)
    ).toThrow(/invalid/u);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.events)).toBe(true);
    expect(Object.isFrozen(state.events[0])).toBe(true);
  });

  it("retains the latest 100 raw events without losing the accepted cursor", () => {
    let state = createSessionDetailFeed(sessionId);
    for (let cursor = 1; cursor <= sessionDetailFeedLimit + 5; cursor += 1) {
      state = appendSessionDetailEvent(state, activityEvent(cursor));
    }

    expect(state.events).toHaveLength(100);
    expect(state.events[0]?.cursor).toBe(6);
    expect(state.events.at(-1)?.cursor).toBe(105);
    expect(state.lastCursor).toBe(105);
    expect(state.acceptedCount).toBe(105);
    expect(() => appendSessionDetailEvent(state, activityEvent(5))).toThrow(
      /out-of-order/u
    );
  });

  it("allows an explicit later continuity boundary before resuming contiguous activity", () => {
    let state = appendSessionDetailEvent(
      createSessionDetailFeed(sessionId),
      activityEvent(10)
    );
    state = appendSessionDetailEvent(state, boundaryEvent(20, "restart", 10));
    state = appendSessionDetailEvent(state, activityEvent(21));

    expect(state.events.map((event) => event.cursor)).toEqual([10, 20, 21]);
    expect(() => appendSessionDetailEvent(state, activityEvent(23))).toThrow(/gap/u);
    expect(() =>
      appendSessionDetailEvent(state, boundaryEvent(30, "restart", 9))
    ).toThrow(/boundary/u);
  });
});

describe("Session Detail timeline projection", () => {
  it("consolidates agent deltas and lets completion replace partial content in place", () => {
    let state = createSessionDetailFeed(sessionId);
    state = appendSessionDetailEvent(state, messageEvent(1, "agent", "delta", "Draft "));
    state = appendSessionDetailEvent(state, messageEvent(2, "agent", "delta", "reply"));
    state = appendSessionDetailEvent(
      state,
      messageEvent(3, "agent", "completed", "Authoritative reply")
    );
    state = appendSessionDetailEvent(
      state,
      messageEvent(4, "agent", "delta", "", "item-empty")
    );

    const timeline = projectSessionDetailTimeline(state, null, formatTimestamp);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      label: "Agent",
      body: "Authoritative reply",
      order: 1,
      pending: false,
      timeLabel: "2:00 PM"
    });
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(Object.isFrozen(timeline[0])).toBe(true);
  });

  it("keeps null-item messages distinct and exposes content limitations", () => {
    let state = createSessionDetailFeed(sessionId);
    state = appendSessionDetailEvent(
      state,
      messageEvent(1, "user", "completed", "First", null)
    );
    state = appendSessionDetailEvent(
      state,
      messageEvent(2, "agent", "completed", "Second", null, {
        content_state: "redacted_and_truncated",
        content_notice: "Sensitive content was removed and the remainder was shortened."
      })
    );

    const timeline = projectSessionDetailTimeline(state, null, formatTimestamp);
    expect(timeline.map((item) => item.body)).toEqual(["First", "Second"]);
    expect(timeline[1]?.contentNotice).toBe(
      "Sensitive content was removed and the remainder was shortened."
    );
  });

  it("adds one synthetic retained-history boundary and avoids duplicating a streamed one", () => {
    const syntheticFeed = appendSessionDetailEvent(
      createSessionDetailFeed(sessionId),
      activityEvent(11)
    );
    const boundary = { after: 5, cursor: 6, reason: "retention" as const };
    const synthetic = projectSessionDetailTimeline(
      syntheticFeed,
      boundary,
      formatTimestamp
    );
    expect(synthetic.map((item) => item.title)).toEqual([
      "Earlier activity unavailable",
      "Tool activity"
    ]);
    expect(synthetic[0]?.capturedAt).toBeNull();

    let streamedFeed = appendSessionDetailEvent(
      createSessionDetailFeed(sessionId),
      boundaryEvent(6, "retention", 5)
    );
    streamedFeed = appendSessionDetailEvent(streamedFeed, activityEvent(7));
    const streamed = projectSessionDetailTimeline(streamedFeed, boundary, formatTimestamp);
    expect(streamed.filter((item) => item.label === "Boundary")).toHaveLength(1);
    expect(streamed[0]?.capturedAt).toBe(timestamp);
  });

  it("projects every selected event state to semantic non-color text", () => {
    const variants = selectedEventVariants();
    const labels = new Set<string>();
    const states = new Set<string>();

    for (const event of variants) {
      const feed = appendSessionDetailEvent(createSessionDetailFeed(sessionId), event);
      const timeline = projectSessionDetailTimeline(feed, null, formatTimestamp);
      expect(timeline).toHaveLength(1);
      const item = timeline[0];
      expect(item?.label.length).toBeGreaterThan(0);
      expect(item?.title.length).toBeGreaterThan(0);
      expect(["focus", "connected", "attention", "danger", "muted"]).toContain(
        item?.tone
      );
      if (item !== undefined) {
        labels.add(item.label);
        if (item.stateLabel !== null) states.add(item.stateLabel);
      }
    }

    expect(labels).toEqual(
      new Set([
        "You",
        "Agent",
        "Progress",
        "Command",
        "Tool",
        "File change",
        "Compaction",
        "Rate limit",
        "Session",
        "Settings",
        "Usage",
        "Approval",
        "Control",
        "Runtime",
        "Boundary",
        "Activity"
      ])
    );
    for (const expected of [
      "Needs input",
      "Needs approval",
      "Interrupted",
      "Failed",
      "Pending",
      "Unsupported",
      "Incompatible",
      "History limited",
      "Unrecognized"
    ]) {
      expect(states).toContain(expected);
    }
  });

  it("shows all selected redaction and truncation states explicitly", () => {
    for (const contentState of projectionContentStates) {
      const event = messageEvent(1, "user", "completed", "Bounded text", null, {
        content_state: contentState,
        content_notice:
          contentState === "complete" ? null : `Content state: ${contentState}`
      });
      const item = projectSessionDetailTimeline(
        appendSessionDetailEvent(createSessionDetailFeed(sessionId), event),
        null,
        formatTimestamp
      )[0];
      expect(item?.contentNotice).toBe(
        contentState === "complete" ? null : `Content state: ${contentState}`
      );
    }
  });
});

function selectedEventVariants(): SelectedProjectionEvent[] {
  const events: SelectedProjectionEvent[] = [
    messageEvent(1, "user", "completed", "User message", null),
    messageEvent(1, "agent", "completed", "Agent message", null)
  ];
  for (const state of turnStates) {
    events.push(
      parseEvent({
        ...base(1),
        type: "turn",
        turn_id: "turn-detail-feed-1",
        state,
        error:
          state === "failed"
            ? { code: "internal_error", message: "Bounded turn failure." }
            : null
      })
    );
  }
  for (const activity of projectionActivityKinds) {
    for (const state of ["started", "updated", "completed", "failed"] as const) {
      events.push(
        parseEvent({
          ...base(1),
          type: "activity",
          activity,
          state,
          item_id: null,
          title: `${activity} activity`,
          detail: "Bounded activity detail."
        })
      );
    }
  }
  for (const state of ["pending", "approved", "denied", "expired", "superseded"] as const) {
    events.push(
      parseEvent({
        ...base(1),
        type: "approval",
        request_id: "request-detail-feed-1",
        state,
        action: "Run contract tests",
        scope: "Workspace write",
        reason: "Validate the selected contracts.",
        risk: "elevated",
        expires_at: state === "pending" ? "2026-07-22T18:05:00.000Z" : null,
        decision: state === "approved" ? "approve" : state === "denied" ? "deny" : null
      })
    );
  }
  for (const control of structuredControlKinds) {
    for (const state of [
      "available",
      "updating",
      "active",
      "paused",
      "complete",
      "failed",
      "unsupported"
    ] as const) {
      events.push(
        parseEvent({
          ...base(1),
          type: "control",
          control,
          state,
          value_summary: "Bounded control value."
        })
      );
    }
  }
  for (const state of runtimeConnectionStates) {
    events.push(
      parseEvent({
        ...base(1),
        type: "runtime",
        state,
        message: state === "ready" ? null : `Runtime is ${state}.`
      })
    );
  }
  for (const reason of ["retention", "disconnect", "restart", "schema_change"] as const) {
    events.push(boundaryEvent(1, reason, null));
  }
  events.push(
    parseEvent({
      ...base(1),
      type: "unknown_optional",
      upstream_type: "future/optional",
      summary: "A future optional event was observed."
    })
  );
  return events;
}

function base(
  cursor: number,
  options: {
    readonly session_id?: string;
    readonly content_state?: "complete" | "redacted" | "truncated" | "redacted_and_truncated";
    readonly content_notice?: string | null;
  } = {}
) {
  return {
    session_id: options.session_id ?? sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: options.content_state ?? "complete",
    content_notice: options.content_notice ?? null
  };
}

function activityEvent(
  cursor: number,
  options: {
    readonly session_id?: string;
    readonly title?: string;
  } = {}
): SelectedProjectionEvent {
  const baseOptions =
    options.session_id === undefined ? {} : { session_id: options.session_id };
  return parseEvent({
    ...base(cursor, baseOptions),
    type: "activity",
    activity: "tool",
    state: "completed",
    item_id: null,
    title: options.title ?? "Tool activity",
    detail: "Read selected files."
  });
}

function messageEvent(
  cursor: number,
  role: "user" | "agent",
  phase: "delta" | "completed",
  text: string,
  itemId: string | null = "item-detail-feed-1",
  options: {
    readonly content_state?: "complete" | "redacted" | "truncated" | "redacted_and_truncated";
    readonly content_notice?: string | null;
  } = {}
): SelectedProjectionEvent {
  return parseEvent({
    ...base(cursor, options),
    type: "message",
    role,
    phase,
    item_id: itemId,
    text
  });
}

function boundaryEvent(
  cursor: number,
  reason: "retention" | "disconnect" | "restart" | "schema_change",
  after: number | null
): SelectedProjectionEvent {
  return parseEvent({
    ...base(cursor),
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason
  });
}

function parseEvent(input: unknown): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse(input);
}
