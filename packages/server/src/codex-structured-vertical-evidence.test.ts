import {
  type SelectedProjectionEvent,
  type SelectedSessionEventStream,
  selectedProjectionEventSchema,
  selectedSessionEventStreamSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { readStructuredVerticalTurnTerminal } from "./codex-structured-vertical-evidence.js";

const sessionId = "sess_vertical_evidence_001";
const terminalTurnId = "turn_vertical_evidence_001";

describe("structured vertical terminal evidence", () => {
  it("paginates beyond the first durable event page", () => {
    const events = [
      ...Array.from({ length: 104 }, (_, index) => optionalEvent(index + 1)),
      turnEvent(105, terminalTurnId, "interrupted")
    ];
    const calls: Array<number | null> = [];
    const repository = eventRepository(events, calls);

    expect(readStructuredVerticalTurnTerminal(repository, sessionId, terminalTurnId, 105)).toEqual({
      state: "interrupted",
      error_code: null,
      error_message: null
    });
    expect(calls).toEqual([null, 100]);
  });

  it("returns null only after reaching the committed cursor", () => {
    const events = Array.from({ length: 101 }, (_, index) => optionalEvent(index + 1));
    const calls: Array<number | null> = [];

    expect(readStructuredVerticalTurnTerminal(eventRepository(events, calls), sessionId, terminalTurnId, 101)).toBeNull();
    expect(calls).toEqual([null, 100]);
  });

  it("fails a nonadvancing replay instead of polling it indefinitely", () => {
    const repository = {
      listEvents: (): SelectedSessionEventStream =>
        selectedSessionEventStreamSchema.parse({ session_id: sessionId, events: [], next_cursor: 0, truncated: false })
    };

    expect(() => readStructuredVerticalTurnTerminal(repository, sessionId, terminalTurnId, 1)).toThrow(
      "Structured vertical event replay did not advance its cursor."
    );
  });
});

function eventRepository(events: readonly SelectedProjectionEvent[], calls: Array<number | null>) {
  return {
    listEvents(_sessionId: string, input: { readonly after?: number | null; readonly limit?: number } = {}) {
      const after = input.after ?? null;
      calls.push(after);
      const page = events.filter((event) => event.cursor > (after ?? 0)).slice(0, input.limit ?? 100);
      return selectedSessionEventStreamSchema.parse({
        session_id: sessionId,
        events: page,
        next_cursor: page.at(-1)?.cursor ?? events.at(-1)?.cursor ?? 0,
        truncated: false
      });
    }
  };
}

function optionalEvent(cursor: number): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "unknown_optional",
    upstream_type: "test/optional",
    summary: "Bounded aggregate filler."
  });
}

function turnEvent(
  cursor: number,
  turnId: string,
  state: "completed" | "failed" | "interrupted"
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "turn",
    turn_id: turnId,
    state,
    error: state === "failed" ? { code: "unknown_error", message: "Bounded failure." } : null
  });
}

function eventBase(cursor: number) {
  return {
    session_id: sessionId,
    cursor,
    captured_at: "2026-07-13T16:00:00.000Z",
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: "test/event",
    content_state: "complete" as const,
    content_notice: null
  };
}
