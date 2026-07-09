import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRetentionPolicy,
  outputCursorSchema,
  type RetentionPolicy,
  type SessionStreamEvent,
  type StorageSessionRecord
} from "@hostdeck/contracts";
import {
  createRetentionRepository,
  createSessionRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createOutputReader, type OutputCaptureSource, type OutputReader } from "./output-reader.js";
import {
  type CreateStreamRouteHandlersInput,
  createStreamRouteHandlers,
  type SessionStreamLiveSource,
  type SessionStreamRouteResult,
  type SessionStreamSubscribeInput
} from "./stream-routes.js";

const tempDirs: string[] = [];
const timestamp = "2026-07-08T22:00:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("session stream route handlers", () => {
  it("replays retained output after the cursor and then streams live events for one session", async () => {
    const harness = createHarness();

    try {
      const session = harness.createSession("sess_stream_route_01", "stream-demo");
      harness.capture.text = "one\ntwo\n";
      await harness.outputReader.drainSession({ sessionId: session.id });
      harness.liveSource.events = [outputEvent(session.id, 3, "three")];

      const events = await collectStream(
        harness.handlers.sessionStream({
          params: { session_id: session.id },
          query: { after: 1 }
        })
      );

      expect(events.map((event) => event.type)).toEqual(["stream_status", "output", "output", "stream_status"]);
      expect(events).toMatchObject([
        { type: "stream_status", session_id: session.id, status: "connected" },
        { type: "output", session_id: session.id, cursor: 2, text: "two" },
        { type: "output", session_id: session.id, cursor: 3, text: "three" },
        { type: "stream_status", session_id: session.id, status: "closed" }
      ]);
      expect(harness.liveSource.subscriptions).toHaveLength(1);
      expect(harness.liveSource.subscriptions[0]).toMatchObject({
        sessionId: session.id,
        after: 2
      });
    } finally {
      harness.close();
    }
  });

  it("supports reconnect replay without duplicating already acknowledged output", async () => {
    const harness = createHarness();

    try {
      const session = harness.createSession("sess_stream_route_02", "reconnect-demo");
      harness.capture.text = "one\ntwo\nthree\n";
      await harness.outputReader.drainSession({ sessionId: session.id });

      const events = await collectStream(
        harness.handlers.sessionStream({
          params: { session_id: session.id },
          query: { after: 2 }
        })
      );

      expect(events).toMatchObject([
        { type: "stream_status", session_id: session.id, status: "connected" },
        { type: "output", session_id: session.id, cursor: 3, text: "three" },
        { type: "stream_status", session_id: session.id, status: "closed" }
      ]);
      expect(harness.liveSource.subscriptions[0]).toMatchObject({
        sessionId: session.id,
        after: 3
      });
    } finally {
      harness.close();
    }
  });

  it("emits retention and stale-cursor replay boundaries before retained output", async () => {
    const retention = retentionPolicy({
      output_event_limit: 2,
      output_byte_limit: 1_000_000
    });
    const harness = createHarness({ retentionPolicy: retention });

    try {
      const session = harness.createSession("sess_stream_route_03", "boundary-demo");
      harness.capture.text = "one\ntwo\nthree\n";
      await harness.outputReader.drainSession({ sessionId: session.id });

      const freshReplay = await collectStream(
        harness.handlers.sessionStream({
          params: { session_id: session.id }
        })
      );
      expect(freshReplay).toMatchObject([
        { type: "stream_status", status: "connected" },
        { type: "replay_boundary", session_id: session.id, after: null, next_cursor: 2, reason: "retention" },
        { type: "output", session_id: session.id, cursor: 2, text: "two" },
        { type: "output", session_id: session.id, cursor: 3, text: "three" },
        { type: "stream_status", status: "closed" }
      ]);

      const staleCursorReplay = await collectStream(
        harness.handlers.sessionStream({
          params: { session_id: session.id },
          query: { after: 0 }
        })
      );
      expect(staleCursorReplay).toMatchObject([
        { type: "stream_status", status: "connected" },
        { type: "replay_boundary", session_id: session.id, after: 0, next_cursor: 2, reason: "stale_cursor" },
        { type: "output", session_id: session.id, cursor: 2, text: "two" },
        { type: "output", session_id: session.id, cursor: 3, text: "three" },
        { type: "stream_status", status: "closed" }
      ]);
    } finally {
      harness.close();
    }
  });

  it("returns typed route failures for authorization, malformed input, missing sessions, invalid cursors, and stale sessions", () => {
    const deniedHarness = createHarness({
      authorizeRead(input) {
        expect(input.route).toBe("session_stream");
        return { ok: false, status: 403, message: "Read token is required." };
      }
    });

    try {
      const session = deniedHarness.createSession("sess_stream_route_04", "denied-demo");
      expect(deniedHarness.handlers.sessionStream({ params: { session_id: session.id } })).toMatchObject({
        status: 403,
        body: {
          error: {
            code: "permission_denied",
            message: "Read token is required."
          }
        }
      });
    } finally {
      deniedHarness.close();
    }

    const harness = createHarness();

    try {
      const stale = harness.createSession("sess_stream_route_05", "stale-demo", {
        lifecycle_state: "stale",
        stale_reason: "tmux target missing"
      });

      expect(harness.handlers.sessionStream({ params: { session_id: "bad" } })).toMatchObject({
        status: 400,
        body: { error: { code: "validation_error", field: "session_id" } }
      });
      expect(harness.handlers.sessionStream({ params: { session_id: "sess_stream_missing_01" } })).toMatchObject({
        status: 404,
        body: { error: { code: "session_not_found" } }
      });
      expect(
        harness.handlers.sessionStream({
          params: { session_id: stale.id },
          query: { after: -1 }
        })
      ).toMatchObject({
        status: 400,
        body: { error: { code: "validation_error", field: "after" } }
      });
      expect(
        harness.handlers.sessionStream({
          params: { session_id: stale.id }
        })
      ).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "stale_session",
            details: {
              stale_reason: "tmux target missing"
            }
          }
        }
      });
    } finally {
      harness.close();
    }
  });

  it("reports replay failures as typed stream error events", async () => {
    const harness = createHarness({
      outputReader: {
        replaySession() {
          throw new Error("reader offline");
        }
      }
    });

    try {
      const session = harness.createSession("sess_stream_route_06", "reader-failure-demo");

      const events = await collectStream(
        harness.handlers.sessionStream({
          params: { session_id: session.id }
        })
      );

      expect(events).toMatchObject([
        { type: "stream_status", session_id: session.id, status: "connected" },
        {
          type: "error",
          session_id: session.id,
          error: {
            code: "storage_error",
            retryable: true,
            details: {
              error_name: "Error",
              reason: "reader offline"
            }
          }
        },
        { type: "stream_status", session_id: session.id, status: "closed" }
      ]);
    } finally {
      harness.close();
    }
  });

  it("closes with a typed error when a live event crosses session boundaries", async () => {
    const harness = createHarness();

    try {
      const session = harness.createSession("sess_stream_route_07", "one-session-demo");
      harness.liveSource.events = [outputEvent("sess_stream_other_01", 1, "wrong session")];

      const events = await collectStream(
        harness.handlers.sessionStream({
          params: { session_id: session.id }
        })
      );

      expect(events).toMatchObject([
        { type: "stream_status", session_id: session.id, status: "connected" },
        {
          type: "error",
          session_id: session.id,
          error: {
            code: "internal_error",
            details: {
              expected_session_id: session.id,
              actual_session_id: "sess_stream_other_01"
            }
          }
        },
        { type: "stream_status", session_id: session.id, status: "closed" }
      ]);
    } finally {
      harness.close();
    }
  });
});

class MutableCapture implements OutputCaptureSource {
  constructor(public text = "") {}

  async captureOutput(): Promise<string> {
    return this.text;
  }
}

class MutableLiveSource implements SessionStreamLiveSource {
  events: readonly unknown[] = [];
  readonly subscriptions: SessionStreamSubscribeInput[] = [];

  async *subscribe(input: SessionStreamSubscribeInput): AsyncGenerator<unknown> {
    this.subscriptions.push(input);

    for (const event of this.events) {
      yield event;
    }
  }
}

function createHarness(
  input: {
    readonly authorizeRead?: CreateStreamRouteHandlersInput["authorizeRead"];
    readonly outputReader?: Pick<OutputReader, "replaySession">;
    readonly retentionPolicy?: RetentionPolicy;
  } = {}
) {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  const settings = createSettingsRepository(open.db);
  settings.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
  const sessions = createSessionRepository(open.db);
  const capture = new MutableCapture();
  const outputReader = createOutputReader({
    retention: createRetentionRepository(open.db),
    capture,
    ...(input.retentionPolicy !== undefined ? { retentionPolicy: input.retentionPolicy } : {}),
    now: fixedNow
  });
  const routeOutputReader = input.outputReader ?? outputReader;
  const liveSource = new MutableLiveSource();
  const handlers = createStreamRouteHandlers({
    sessions,
    outputReader: routeOutputReader,
    liveSource,
    ...(input.authorizeRead !== undefined ? { authorizeRead: input.authorizeRead } : {})
  });

  return {
    capture,
    handlers,
    liveSource,
    outputReader,
    createSession(id: string, name: string, overrides: Partial<StorageSessionRecord> = {}) {
      return sessions.create({
        id,
        name,
        cwd: tempCwd(),
        backend: {
          type: "tmux",
          tmux_session: `hostdeck_${id}`,
          tmux_window: "codex",
          tmux_pane: "%1"
        },
        lifecycle_state: "running",
        created_at: timestamp,
        updated_at: timestamp,
        stale_reason: null,
        ...overrides
      });
    },
    close: () => open.db.close()
  };
}

async function collectStream(result: SessionStreamRouteResult): Promise<SessionStreamEvent[]> {
  expect(result.status).toBe(200);

  if (!("stream" in result)) {
    throw new Error(`Expected stream success, received ${result.body.error.code}.`);
  }

  const events: SessionStreamEvent[] = [];

  for await (const event of result.stream) {
    events.push(event);
  }

  return events;
}

function outputEvent(sessionId: string, cursor: number, text: string): unknown {
  return {
    type: "output",
    session_id: sessionId,
    cursor: outputCursorSchema.parse(cursor),
    captured_at: timestamp,
    text
  };
}

function retentionPolicy(overrides: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    ...defaultRetentionPolicy,
    ...overrides
  };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-stream-routes-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-stream-routes-state-"));
  tempDirs.push(dir);
  return dir;
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-stream-routes-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date(timestamp);
}
