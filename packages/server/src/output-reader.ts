import {
  type OutputEventRecord,
  type RetentionPolicy,
  type SessionOutputResponse,
  sessionOutputResponseSchema
} from "@hostdeck/contracts";
import {
  type IsoTimestamp,
  type OutputCursor,
  parseIsoTimestamp,
  parseOutputCursor,
  parseSessionId,
  type SessionId
} from "@hostdeck/core";
import type { AppendOutputEventInput, OutputReplayResult, RetentionRepository } from "@hostdeck/storage";

export type OutputReaderErrorCode = "capture_failed" | "invalid_replay" | "invalid_session" | "storage_append_failed";

export class HostDeckOutputReaderError extends Error {
  constructor(
    readonly code: OutputReaderErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckOutputReaderError";
  }
}

export interface CaptureOutputInput {
  readonly sessionId: SessionId;
}

export interface OutputCaptureSource {
  readonly captureOutput: (input: CaptureOutputInput) => Promise<string>;
}

export interface CreateOutputReaderInput {
  readonly retention: RetentionRepository;
  readonly capture: OutputCaptureSource;
  readonly retentionPolicy?: RetentionPolicy;
  readonly now?: () => Date;
}

export interface DrainOutputInput {
  readonly sessionId: SessionId | string;
}

export interface ReplayOutputInput {
  readonly sessionId: SessionId | string;
  readonly after?: OutputCursor | number | null;
  readonly limit?: number;
}

export interface OutputReaderState {
  readonly status: "idle" | "ok" | "error";
  readonly last_error: { readonly code: OutputReaderErrorCode; readonly message: string } | null;
  readonly updated_at: IsoTimestamp | null;
}

export interface DrainOutputResult {
  readonly sessionId: SessionId;
  readonly appended: readonly OutputEventRecord[];
  readonly state: OutputReaderState;
}

export interface OutputReader {
  readonly drainSession: (input: DrainOutputInput) => Promise<DrainOutputResult>;
  readonly replaySession: (input: ReplayOutputInput) => SessionOutputResponse;
  readonly state: () => OutputReaderState;
}

export function createOutputReader(input: CreateOutputReaderInput): OutputReader {
  const now = input.now ?? (() => new Date());
  let state: OutputReaderState = {
    status: "idle",
    last_error: null,
    updated_at: null
  };

  function timestamp(): IsoTimestamp {
    return parseRequiredIsoTimestamp(now().toISOString());
  }

  function appendOptions(): AppendOutputEventInput {
    return input.retentionPolicy === undefined ? { now } : { now, retention: input.retentionPolicy };
  }

  function setOk(): OutputReaderState {
    state = {
      status: "ok",
      last_error: null,
      updated_at: timestamp()
    };
    return state;
  }

  function setError(error: HostDeckOutputReaderError): void {
    state = {
      status: "error",
      last_error: {
        code: error.code,
        message: error.message
      },
      updated_at: timestamp()
    };
  }

  return {
    async drainSession(drainInput) {
      const sessionId = parseRequiredSessionId(drainInput.sessionId);
      let snapshot: string;

      try {
        snapshot = await input.capture.captureOutput({ sessionId });
      } catch (error) {
        const readerError = new HostDeckOutputReaderError("capture_failed", `Output capture failed for ${sessionId}.`, { cause: error });
        setError(readerError);
        throw readerError;
      }

      try {
        const replay = input.retention.listOutputReplay(sessionId, { limit: 1_000 });
        const capturedLines = splitCapturedOutput(snapshot);
        const previousLines = replay.events
          .filter((event) => event.kind === "output" && event.payload !== null)
          .map((event) => event.payload as string);
        const continuity = newCapturedLines(previousLines, capturedLines);
        const appended: OutputEventRecord[] = [];
        let nextCursor = parseRequiredOutputCursor(Math.max(1, replay.next_cursor));
        const appendInput = appendOptions();

        if (!continuity.contiguous && previousLines.length > 0) {
          const boundary = outputEvent(sessionId, nextCursor, "replay_boundary", null, latestKnownCursor(replay), null);
          appended.push(input.retention.appendOutputEvent(boundary, appendInput).event);
          nextCursor = parseRequiredOutputCursor(nextCursor + 1);
        }

        for (const line of continuity.lines) {
          const event = outputEvent(sessionId, nextCursor, "output", line, null, timestamp());
          appended.push(input.retention.appendOutputEvent(event, appendInput).event);
          nextCursor = parseRequiredOutputCursor(nextCursor + 1);
        }

        return {
          sessionId,
          appended,
          state: setOk()
        };
      } catch (error) {
        if (error instanceof HostDeckOutputReaderError) {
          setError(error);
          throw error;
        }

        const readerError = new HostDeckOutputReaderError("storage_append_failed", `Output append failed for ${sessionId}.`, { cause: error });
        setError(readerError);
        throw readerError;
      }
    },
    replaySession(replayInput) {
      const sessionId = parseRequiredSessionId(replayInput.sessionId);
      const after = replayInput.after === undefined || replayInput.after === null ? null : parseRequiredOutputCursor(replayInput.after);

      try {
        const replay = input.retention.listOutputReplay(sessionId, {
          after,
          ...(replayInput.limit !== undefined ? { limit: replayInput.limit } : {})
        });
        return outputReplayResponse(replay);
      } catch (error) {
        throw new HostDeckOutputReaderError("invalid_replay", `Output replay failed for ${sessionId}.`, { cause: error });
      }
    },
    state() {
      return state;
    }
  };
}

function outputReplayResponse(replay: OutputReplayResult): SessionOutputResponse {
  const sessionId = parseRequiredSessionId(replay.session_id);
  const after = replay.after === null ? null : parseRequiredOutputCursor(replay.after);
  const events: SessionOutputResponse["events"] = [];

  if (replay.boundary !== null) {
    events.push({
      type: "replay_boundary",
      session_id: sessionId,
      after,
      next_cursor: parseRequiredOutputCursor(replay.events[0]?.cursor ?? replay.next_cursor),
      reason: "retention"
    });
  }

  for (const event of replay.events) {
    if (event.kind === "output") {
      events.push({
        type: "output",
        session_id: parseRequiredSessionId(event.session_id),
        cursor: event.cursor,
        captured_at: event.captured_at,
        text: event.payload ?? ""
      });
      continue;
    }

    if (event.kind === "replay_boundary") {
      events.push({
        type: "replay_boundary",
        session_id: parseRequiredSessionId(event.session_id),
        after: event.truncated_before,
        next_cursor: event.cursor,
        reason: "restart"
      });
    }
  }

  return sessionOutputResponseSchema.parse({
    session_id: sessionId,
    events,
    next_cursor: replay.next_cursor,
    truncated: replay.truncated
  });
}

function outputEvent(
  sessionId: SessionId,
  cursor: OutputCursor,
  kind: OutputEventRecord["kind"],
  payload: string | null,
  truncatedBefore: OutputCursor | null,
  capturedAt: IsoTimestamp | null
): OutputEventRecord {
  return {
    session_id: sessionId,
    cursor,
    order: cursor === 0 ? 0 : cursor - 1,
    captured_at: capturedAt,
    kind,
    payload,
    truncated_before: truncatedBefore
  };
}

function latestKnownCursor(replay: OutputReplayResult): OutputCursor | null {
  const latestEventCursor = replay.events.at(-1)?.cursor ?? null;
  const boundaryCursor = replay.boundary?.truncated_before_cursor ?? null;
  const latest = Math.max(latestEventCursor ?? -1, boundaryCursor ?? -1);
  return latest < 0 ? null : parseRequiredOutputCursor(latest);
}

function splitCapturedOutput(snapshot: string): readonly string[] {
  const lines = snapshot.split(/\r?\n/u);

  while (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function newCapturedLines(previousLines: readonly string[], capturedLines: readonly string[]): { readonly contiguous: boolean; readonly lines: readonly string[] } {
  if (previousLines.length === 0) {
    return { contiguous: true, lines: capturedLines };
  }

  const overlap = findLongestPreviousSuffixOverlap(previousLines, capturedLines);

  if (overlap === null) {
    return { contiguous: false, lines: capturedLines };
  }

  return { contiguous: true, lines: capturedLines.slice(overlap.start + overlap.length) };
}

function findLongestPreviousSuffixOverlap(
  previousLines: readonly string[],
  capturedLines: readonly string[]
): { readonly start: number; readonly length: number } | null {
  const maxOverlap = Math.min(previousLines.length, capturedLines.length);

  for (let length = maxOverlap; length > 0; length -= 1) {
    const suffix = previousLines.slice(previousLines.length - length);
    const start = findSubsequenceStart(capturedLines, suffix);

    if (start !== null) {
      return { start, length };
    }
  }

  return null;
}

function findSubsequenceStart(haystack: readonly string[], needle: readonly string[]): number | null {
  if (needle.length === 0) {
    return 0;
  }

  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((line, offset) => haystack[index + offset] === line)) {
      return index;
    }
  }

  return null;
}

function parseRequiredSessionId(value: SessionId | string): SessionId {
  const result = parseSessionId(String(value));

  if (!result.ok) {
    throw new HostDeckOutputReaderError("invalid_session", result.message);
  }

  return result.value;
}

function parseRequiredIsoTimestamp(value: string): IsoTimestamp {
  const result = parseIsoTimestamp(value);

  if (!result.ok) {
    throw new HostDeckOutputReaderError("storage_append_failed", result.message);
  }

  return result.value;
}

function parseRequiredOutputCursor(value: OutputCursor | number): OutputCursor {
  const result = parseOutputCursor(Number(value));

  if (!result.ok) {
    throw new HostDeckOutputReaderError("invalid_replay", result.message);
  }

  return result.value;
}
