import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionId, type SessionId } from "@hostdeck/core";
import {
  createSessionMetadataRepository,
  createSessionRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { createFakeTmuxAdapter, HostDeckTmuxAdapterError, type TmuxAdapter, type TmuxTarget } from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionControlRouteHandlers } from "./session-control-routes.js";

const tempDirs: string[] = [];
const timestamp = "2026-07-09T08:00:00.000Z";
const laterTimestamp = "2026-07-09T08:05:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("session control route handlers", () => {
  it("starts a managed session, stores registry and metadata, and starts output capture", async () => {
    const startedReaders: TmuxTarget[] = [];
    const harness = createHarness({
      startOutputReader(target) {
        startedReaders.push(target);
      }
    });

    try {
      const cwd = tempCwd();
      const result = await harness.handlers.startSession({
        body: { name: "route-start-demo", cwd }
      });

      expect(result).toMatchObject({
        status: 201,
        body: {
          session: {
            id: "sess_control_01",
            name: "route-start-demo",
            cwd,
            lifecycle_state: "running",
            status: "unknown",
            attention: "unknown",
            branch: "feature/control-route"
          }
        }
      });
      expect(harness.sessions.require("sess_control_01")).toMatchObject({
        name: "route-start-demo",
        cwd,
        backend: {
          tmux_session: "hostdeck_sess_control_01",
          tmux_window: "codex",
          tmux_pane: "%1"
        },
        lifecycle_state: "running"
      });
      expect(harness.metadata.require("sess_control_01")).toMatchObject({
        branch: "feature/control-route",
        status: "unknown",
        attention: "unknown",
        updated_at: timestamp
      });
      expect(startedReaders.map((target) => target.sessionId)).toEqual(["sess_control_01"]);
    } finally {
      harness.close();
    }
  });

  it("rejects duplicate names before creating another tmux target", async () => {
    const harness = createHarness();

    try {
      const cwd = tempCwd();
      await expect(harness.handlers.startSession({ body: { name: "duplicate-demo", cwd } })).resolves.toMatchObject({
        status: 201
      });
      await expect(harness.handlers.startSession({ body: { name: "duplicate-demo", cwd } })).resolves.toMatchObject({
        status: 409,
        body: { error: { code: "duplicate_session_name", field: "name" } }
      });
      await expect(harness.tmux.listTargets()).resolves.toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("rejects malformed working directories before tmux start", async () => {
    const harness = createHarness();

    try {
      await expect(harness.handlers.startSession({ body: { name: "bad-cwd-demo", cwd: "relative" } })).resolves.toMatchObject({
        status: 400,
        body: { error: { code: "invalid_cwd", field: "cwd" } }
      });
      await expect(harness.tmux.listTargets()).resolves.toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("maps missing Codex binary failures without creating registry success", async () => {
    const harness = createHarness({
      tmux: {
        async startSession() {
          throw new HostDeckTmuxAdapterError("command_unavailable", "Executable codex was not found.");
        },
        async stopSession() {
          throw new HostDeckTmuxAdapterError("missing_target", "No target exists.");
        }
      }
    });

    try {
      await expect(harness.handlers.startSession({ body: { name: "missing-binary-demo", cwd: tempCwd() } })).resolves.toMatchObject({
        status: 500,
        body: {
          error: {
            code: "missing_binary",
            field: "command",
            details: { tmux_code: "command_unavailable" }
          }
        }
      });
      expect(harness.sessions.list()).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("fails loudly and cleans up the target when output reader startup fails", async () => {
    const harness = createHarness({
      now: laterNow,
      async startOutputReader() {
        throw new Error("pipe setup failed");
      }
    });

    try {
      const result = await harness.handlers.startSession({ body: { name: "reader-failure-demo", cwd: tempCwd() } });

      expect(result).toMatchObject({
        status: 500,
        body: { error: { code: "internal_error" } }
      });
      await expect(harness.tmux.getTarget(sessionId("sess_control_01"))).resolves.toBeNull();
      expect(harness.sessions.require("sess_control_01")).toMatchObject({
        lifecycle_state: "stopped",
        updated_at: laterTimestamp
      });
    } finally {
      harness.close();
    }
  });
});

function createHarness(
  input: {
    readonly tmux?: Pick<TmuxAdapter, "startSession" | "stopSession">;
    readonly now?: () => Date;
    readonly startOutputReader?: (target: TmuxTarget) => Promise<void> | void;
  } = {}
) {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  createSettingsRepository(open.db).getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
  const sessions = createSessionRepository(open.db);
  const metadata = createSessionMetadataRepository(open.db);
  const tmux = input.tmux ?? createFakeTmuxAdapter({ now: input.now ?? fixedNow });
  const handlers = createSessionControlRouteHandlers({
    sessions,
    metadata,
    tmux,
    now: input.now ?? fixedNow,
    createSessionId: () => sessionId("sess_control_01"),
    captureBranch: () => "feature/control-route",
    ...(input.startOutputReader !== undefined ? { startOutputReader: input.startOutputReader } : {})
  });

  return {
    handlers,
    metadata,
    sessions,
    tmux: tmux as TmuxAdapter,
    close: () => open.db.close()
  };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-session-control-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-session-control-state-"));
  tempDirs.push(dir);
  return dir;
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-session-control-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date(timestamp);
}

function laterNow(): Date {
  return new Date(laterTimestamp);
}

function sessionId(value: string): SessionId {
  const result = parseSessionId(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}
