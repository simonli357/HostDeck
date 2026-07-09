import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStatusResponseSchema, type StorageSessionRecord } from "@hostdeck/contracts";
import {
  createRetentionRepository,
  createSessionMetadataRepository,
  createSessionRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createOutputReader, type OutputCaptureSource } from "./output-reader.js";
import { type CreateReadRouteHandlersInput, createReadRouteHandlers } from "./read-routes.js";

const tempDirs: string[] = [];
const timestamp = "2026-07-08T22:00:00.000Z";
const laterTimestamp = "2026-07-08T22:05:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("session read route handlers", () => {
  it("returns validated host status and attention-sorted session list with stale state visible", () => {
    const harness = createHarness();

    try {
      const idle = harness.createSession("sess_read_idle_01", "z-idle");
      const input = harness.createSession("sess_read_input_01", "b-input");
      const failed = harness.createSession("sess_read_failed_01", "c-failed");
      const stale = harness.createSession("sess_read_stale_01", "a-stale", {
        lifecycle_state: "stale",
        stale_reason: "tmux target missing"
      });

      harness.upsertMetadata(idle.id, {
        status: "idle",
        attention: "none",
        summary: "idle summary",
        last_activity_at: timestamp,
        last_output_cursor: 2
      });
      harness.upsertMetadata(input.id, {
        status: "waiting_for_user",
        attention: "needs_input",
        summary: "question?",
        last_activity_at: laterTimestamp,
        last_output_cursor: 4
      });
      harness.upsertMetadata(failed.id, {
        status: "tests_failed",
        attention: "failed",
        summary: "tests failed",
        last_activity_at: timestamp,
        last_output_cursor: 7
      });
      harness.upsertMetadata(stale.id, {
        status: "idle",
        attention: "none",
        summary: "old output",
        last_activity_at: timestamp,
        last_output_cursor: 1
      });

      expect(harness.handlers.hostStatus().body).toMatchObject({
        storage: { state: "ok" },
        stale_session_count: 1
      });

      const result = harness.handlers.listSessions();

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        sessions: [
          { id: failed.id, attention: "failed", status: "tests_failed" },
          { id: input.id, attention: "needs_input", status: "waiting_for_user" },
          { id: stale.id, lifecycle_state: "stale", attention: "unknown", status: "disconnected" },
          { id: idle.id, attention: "none", status: "idle" }
        ]
      });
      expect("error" in result.body).toBe(false);
      const staleSession = "sessions" in result.body ? result.body.sessions[2] : null;
      expect(staleSession).toMatchObject({
        id: stale.id,
        recent_output: {
          text: "old output",
          cursor: 1,
          line_count: 1,
          truncated: false
        }
      });
    } finally {
      harness.close();
    }
  });

  it("returns session detail and bounded output responses through shared contracts", async () => {
    const harness = createHarness();

    try {
      const session = harness.createSession("sess_read_output_01", "output-demo");
      harness.upsertMetadata(session.id, {
        status: "running",
        attention: "watch",
        summary: "latest line",
        last_activity_at: laterTimestamp,
        last_output_cursor: 2
      });
      harness.capture.text = "one\ntwo\n";
      await harness.outputReader.drainSession({ sessionId: session.id });

      expect(
        harness.handlers.sessionDetail({
          params: { session_id: session.id }
        })
      ).toMatchObject({
        status: 200,
        body: {
          session: {
            id: session.id,
            backend: {
              tmux: {
                session_name: session.backend.tmux_session,
                window_name: "codex",
                pane_id: "%1"
              }
            },
            recent_output: {
              text: "latest line",
              cursor: 2,
              line_count: 1,
              truncated: false
            }
          }
        }
      });

      expect(
        harness.handlers.sessionOutput({
          params: { session_id: session.id },
          query: { after: 1 }
        })
      ).toMatchObject({
        status: 200,
        body: {
          session_id: session.id,
          events: [{ type: "output", cursor: 2, text: "two" }],
          next_cursor: 3,
          truncated: false
        }
      });
    } finally {
      harness.close();
    }
  });

  it("returns typed route failures for permissions, malformed input, missing sessions, invalid cursors, and stale output", () => {
    const deniedHarness = createHarness({
      authorizeRead() {
        return { ok: false, status: 403, message: "Read token is required." };
      }
    });

    try {
      expect(deniedHarness.handlers.listSessions()).toMatchObject({
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
      const stale = harness.createSession("sess_read_stale_02", "stale-output", {
        lifecycle_state: "stale",
        stale_reason: "tmux target missing"
      });

      expect(harness.handlers.sessionDetail({ params: { session_id: "bad" } })).toMatchObject({
        status: 400,
        body: { error: { code: "validation_error", field: "session_id" } }
      });
      expect(harness.handlers.sessionDetail({ params: { session_id: "sess_read_missing_01" } })).toMatchObject({
        status: 404,
        body: { error: { code: "session_not_found" } }
      });
      expect(
        harness.handlers.sessionOutput({
          params: { session_id: stale.id },
          query: { after: -1 }
        })
      ).toMatchObject({
        status: 400,
        body: { error: { code: "validation_error", field: "after" } }
      });
      expect(
        harness.handlers.sessionOutput({
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
});

class MutableCapture implements OutputCaptureSource {
  constructor(public text = "") {}

  async captureOutput(): Promise<string> {
    return this.text;
  }
}

function createHarness(input: { readonly authorizeRead?: CreateReadRouteHandlersInput["authorizeRead"] } = {}) {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  const settings = createSettingsRepository(open.db);
  settings.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
  const sessions = createSessionRepository(open.db);
  const metadata = createSessionMetadataRepository(open.db);
  const capture = new MutableCapture();
  const outputReader = createOutputReader({
    retention: createRetentionRepository(open.db),
    capture,
    now: fixedNow
  });
  const handlers = createReadRouteHandlers({
    status: () => hostStatus(sessions.list().filter((session) => session.lifecycle_state === "stale").length),
    sessions,
    metadata,
    outputReader,
    ...(input.authorizeRead !== undefined ? { authorizeRead: input.authorizeRead } : {})
  });

  return {
    capture,
    handlers,
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
    upsertMetadata(
      sessionId: string,
      overrides: {
        readonly status: "idle" | "running" | "waiting_for_user" | "tests_failed";
        readonly attention: "none" | "watch" | "needs_input" | "failed";
        readonly summary: string;
        readonly last_activity_at: string;
        readonly last_output_cursor: number;
      }
    ) {
      return metadata.upsert({
        session_id: sessionId,
        branch: "main",
        updated_at: timestamp,
        ...overrides
      });
    },
    close: () => open.db.close()
  };
}

function hostStatus(staleSessionCount: number) {
  return hostStatusResponseSchema.parse({
    version: "0.0.0-test",
    bind: {
      mode: "localhost",
      host: "127.0.0.1",
      port: 3777
    },
    locked: false,
    lan_enabled: false,
    storage: {
      state: "ok",
      checked_at: timestamp
    },
    tmux: {
      state: "ok",
      checked_at: timestamp
    },
    stream: {
      state: "ok",
      checked_at: timestamp
    },
    startup_checks: [{ name: "registry_reconciliation", state: "ok" }],
    stale_session_count: staleSessionCount,
    last_error: null
  });
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-read-routes-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-read-routes-state-"));
  tempDirs.push(dir);
  return dir;
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-read-routes-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date(timestamp);
}
