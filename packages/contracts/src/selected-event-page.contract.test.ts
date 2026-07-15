import { describe, expect, it } from "vitest";
import {
  selectedEventPageDefaultSize,
  selectedEventPageInputSchema,
  selectedEventPageMaxSize,
  selectedEventPageParamsSchema,
  selectedEventPageQuerySchema,
  selectedEventPageResponseSchema
} from "./selected-event-page.js";

const sessionId = "sess_event_page_001";
const capturedAt = "2026-07-15T12:00:00.000Z";

describe("selected projected-event page contracts", () => {
  it("requires exact selected session params and a bounded internal input", () => {
    expect(selectedEventPageParamsSchema.parse({ session_id: sessionId })).toEqual({
      session_id: sessionId
    });
    expect(
      selectedEventPageInputSchema.parse({ after: 0, limit: selectedEventPageMaxSize })
    ).toEqual({ after: 0, limit: 100 });

    for (const candidate of [
      null,
      {},
      { session_id: "" },
      { session_id: "session with spaces" },
      { session_id: sessionId, extra: true }
    ]) {
      expect(() => selectedEventPageParamsSchema.parse(candidate)).toThrow();
    }

    for (const candidate of [
      null,
      {},
      { after: null },
      { limit: 1 },
      { after: -1, limit: 1 },
      { after: Number.MAX_SAFE_INTEGER + 1, limit: 1 },
      { after: null, limit: 0 },
      { after: null, limit: 101 },
      { after: null, limit: 1.5 },
      { after: null, limit: 1, offset: 0 }
    ]) {
      expect(() => selectedEventPageInputSchema.parse(candidate)).toThrow();
    }
  });

  it("maps only canonical decimal query text to one frozen storage input", () => {
    expect(selectedEventPageDefaultSize).toBe(100);
    expect(selectedEventPageQuerySchema.parse({})).toEqual({
      after: null,
      limit: 100
    });
    expect(selectedEventPageQuerySchema.parse({ after: "0", limit: "1" })).toEqual({
      after: 0,
      limit: 1
    });
    expect(
      selectedEventPageQuerySchema.parse({
        after: String(Number.MAX_SAFE_INTEGER),
        limit: "100"
      })
    ).toEqual({ after: Number.MAX_SAFE_INTEGER, limit: 100 });
    expect(Object.isFrozen(selectedEventPageQuerySchema.parse({}))).toBe(true);

    for (const candidate of [
      { after: "" },
      { after: "00" },
      { after: "01" },
      { after: "+1" },
      { after: "-1" },
      { after: "1.0" },
      { after: "1e2" },
      { after: " 1" },
      { after: "9007199254740992" },
      { after: 1 },
      { after: ["1", "2"] },
      { limit: "" },
      { limit: "0" },
      { limit: "01" },
      { limit: "101" },
      { limit: 1 },
      { limit: ["1", "2"] },
      { cursor: "1" }
    ]) {
      expect(() => selectedEventPageQuerySchema.parse(candidate)).toThrow();
    }
  });

  it("accepts contiguous normal and retention-boundary pages", () => {
    const normal = selectedEventPageResponseSchema.parse({
      session_id: sessionId,
      events: [messageEvent(1), messageEvent(2)],
      next_cursor: 2,
      truncated: false
    });
    expect(normal.events.map((event) => event.cursor)).toEqual([1, 2]);

    const retained = selectedEventPageResponseSchema.parse({
      session_id: sessionId,
      events: [retentionBoundary(4), messageEvent(5)],
      next_cursor: 5,
      truncated: true
    });
    expect(retained.events[0]).toMatchObject({
      type: "replay_boundary",
      after: 3,
      next_cursor: 4,
      reason: "retention"
    });

    expect(
      selectedEventPageResponseSchema.parse({
        session_id: sessionId,
        events: [],
        next_cursor: 0,
        truncated: false
      })
    ).toEqual({ session_id: sessionId, events: [], next_cursor: 0, truncated: false });
  });

  it("rejects mixed, discontinuous, contradictory, oversized, and raw event pages", () => {
    const one = messageEvent(1);
    const invalid = [
      {
        session_id: sessionId,
        events: [one, messageEvent(3)],
        next_cursor: 3,
        truncated: false
      },
      {
        session_id: sessionId,
        events: [one],
        next_cursor: 2,
        truncated: false
      },
      {
        session_id: sessionId,
        events: [one, retentionBoundary(2)],
        next_cursor: 2,
        truncated: true
      },
      {
        session_id: sessionId,
        events: [retentionBoundary(1)],
        next_cursor: 1,
        truncated: false
      },
      {
        session_id: sessionId,
        events: [{ ...one, session_id: "sess_event_page_other" }],
        next_cursor: 1,
        truncated: false
      },
      {
        session_id: sessionId,
        events: [{ ...one, raw_frame: "private raw shell output" }],
        next_cursor: 1,
        truncated: false
      },
      {
        session_id: sessionId,
        events: Array.from({ length: 101 }, (_, index) => messageEvent(index + 1)),
        next_cursor: 101,
        truncated: false
      },
      {
        session_id: sessionId,
        events: [one],
        next_cursor: 1,
        truncated: false,
        transcript: "private"
      }
    ];

    for (const candidate of invalid) {
      expect(() => selectedEventPageResponseSchema.parse(candidate)).toThrow();
    }
  });
});

function messageEvent(cursor: number) {
  return {
    session_id: sessionId,
    cursor,
    captured_at: capturedAt,
    upstream_at: null,
    codex_event_id: `event-${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_state: "complete" as const,
    content_notice: null,
    type: "message" as const,
    role: "agent" as const,
    phase: "delta" as const,
    item_id: "item-event-page-001",
    text: `Bounded projected message ${cursor}.`
  };
}

function retentionBoundary(cursor: number) {
  return {
    session_id: sessionId,
    cursor,
    captured_at: capturedAt,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete" as const,
    content_notice: null,
    type: "replay_boundary" as const,
    after: cursor - 1,
    next_cursor: cursor,
    reason: "retention" as const
  };
}
