import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRetentionPolicy, type RetentionPolicy } from "@hostdeck/contracts";
import { createRetentionRepository, createSessionRepository, openMigratedDatabase } from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createOutputReader, type OutputCaptureSource } from "./output-reader.js";

const tempDirs: string[] = [];
const sessionId = "sess_output_reader_01";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("output reader", () => {
  it("assigns monotonic cursors and appends only newly captured output", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const capture = new MutableCapture();
      const reader = createOutputReader({
        retention: createRetentionRepository(open.db),
        capture,
        now: fixedNow
      });

      capture.text = "one\ntwo\n";
      await expect(reader.drainSession({ sessionId })).resolves.toMatchObject({
        appended: [
          { cursor: 1, payload: "one" },
          { cursor: 2, payload: "two" }
        ],
        state: { status: "ok" }
      });

      capture.text = "one\ntwo\nthree\n";
      await expect(reader.drainSession({ sessionId })).resolves.toMatchObject({
        appended: [{ cursor: 3, payload: "three" }]
      });

      const replay = reader.replaySession({ sessionId, after: 1 });
      expect(replay).toMatchObject({
        session_id: sessionId,
        next_cursor: 4,
        truncated: false
      });
      expect(replay.events).toEqual([
        {
          type: "output",
          session_id: sessionId,
          cursor: 2,
          captured_at: "2026-07-08T22:00:00.000Z",
          text: "two"
        },
        {
          type: "output",
          session_id: sessionId,
          cursor: 3,
          captured_at: "2026-07-08T22:00:00.000Z",
          text: "three"
        }
      ]);
    } finally {
      open.db.close();
    }
  });

  it("maps retention cleanup into replay-boundary responses", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const capture = new MutableCapture("one\ntwo\nthree\n");
      const reader = createOutputReader({
        retention: createRetentionRepository(open.db),
        capture,
        retentionPolicy: retentionPolicy({
          output_event_limit: 2,
          output_byte_limit: 1_000_000
        }),
        now: fixedNow
      });

      await reader.drainSession({ sessionId });

      const replay = reader.replaySession({ sessionId, after: 0, limit: 10 });
      expect(replay.truncated).toBe(true);
      expect(replay.events[0]).toMatchObject({
        type: "replay_boundary",
        session_id: sessionId,
        after: 0,
        next_cursor: 2,
        reason: "retention"
      });
      expect(replay.events.filter((event) => event.type === "output").map((event) => event.cursor)).toEqual([2, 3]);
    } finally {
      open.db.close();
    }
  });

  it("records restart replay boundaries when captured output continuity cannot be proven", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const capture = new MutableCapture("old\n");
      const reader = createOutputReader({
        retention: createRetentionRepository(open.db),
        capture,
        now: fixedNow
      });

      await reader.drainSession({ sessionId });
      capture.text = "new\n";
      await expect(reader.drainSession({ sessionId })).resolves.toMatchObject({
        appended: [
          {
            cursor: 2,
            kind: "replay_boundary",
            truncated_before: 1
          },
          {
            cursor: 3,
            kind: "output",
            payload: "new"
          }
        ]
      });

      expect(reader.replaySession({ sessionId }).events).toMatchObject([
        { type: "output", cursor: 1, text: "old" },
        { type: "replay_boundary", next_cursor: 2, reason: "restart" },
        { type: "output", cursor: 3, text: "new" }
      ]);
    } finally {
      open.db.close();
    }
  });

  it("makes reader capture failures observable", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const capture = new MutableCapture();
      const reader = createOutputReader({
        retention: createRetentionRepository(open.db),
        capture,
        now: fixedNow
      });
      capture.error = new Error("capture crashed");

      await expect(reader.drainSession({ sessionId })).rejects.toMatchObject({
        code: "capture_failed"
      });
      expect(reader.state()).toMatchObject({
        status: "error",
        last_error: {
          code: "capture_failed"
        }
      });
    } finally {
      open.db.close();
    }
  });
});

class MutableCapture implements OutputCaptureSource {
  error: Error | null = null;

  constructor(public text = "") {}

  async captureOutput(): Promise<string> {
    if (this.error !== null) {
      throw this.error;
    }

    return this.text;
  }
}

function sessionRecord() {
  return {
    id: sessionId,
    name: "output-reader-demo",
    cwd: tempCwd(),
    backend: {
      type: "tmux",
      tmux_session: "hostdeck_sess_output_reader_01",
      tmux_window: "codex",
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: "2026-07-08T22:00:00.000Z",
    updated_at: "2026-07-08T22:00:00.000Z",
    stale_reason: null
  };
}

function retentionPolicy(overrides: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    ...defaultRetentionPolicy,
    ...overrides
  };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-output-reader-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-output-reader-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}
