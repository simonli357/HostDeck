import type { SelectedStateRepository } from "@hostdeck/storage";

export interface StructuredVerticalTurnTerminalEvidence {
  readonly state: "completed" | "failed" | "interrupted";
  readonly error_code: string | null;
  readonly error_message: string | null;
}

const replayPageLimit = 100;
const maximumReplayPages = 32;

export function readStructuredVerticalTurnTerminal(
  repository: Pick<SelectedStateRepository, "listEvents">,
  sessionId: string,
  turnId: string,
  committedCursor: number
): StructuredVerticalTurnTerminalEvidence | null {
  let after: number | null = null;
  for (let pageNumber = 0; pageNumber < maximumReplayPages; pageNumber += 1) {
    const page = repository.listEvents(sessionId, { after, limit: replayPageLimit });
    const event = [...page.events]
      .reverse()
      .find(
        (candidate) =>
          candidate.type === "turn" &&
          candidate.turn_id === turnId &&
          ["completed", "failed", "interrupted"].includes(candidate.state)
      );
    if (event?.type === "turn" && ["completed", "failed", "interrupted"].includes(event.state)) {
      return {
        state: event.state as StructuredVerticalTurnTerminalEvidence["state"],
        error_code: event.error?.code ?? null,
        error_message: event.error?.message ?? null
      };
    }
    if (page.next_cursor >= committedCursor) return null;
    if (page.next_cursor <= (after ?? 0)) {
      throw new Error("Structured vertical event replay did not advance its cursor.");
    }
    after = page.next_cursor;
  }
  throw new Error("Structured vertical terminal evidence exceeded its bounded replay page count.");
}
