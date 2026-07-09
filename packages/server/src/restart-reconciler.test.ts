import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageSessionRecord } from "@hostdeck/contracts";
import { parseAbsoluteCwd, parseIsoTimestamp, parseSessionId, parseSessionName } from "@hostdeck/core";
import { createSessionRepository, openMigratedDatabase } from "@hostdeck/storage";
import {
  type ExpectedTmuxTarget,
  parseSessionIdFromTmuxSessionName,
  type RealTmuxDiscoveredTarget,
  type RealTmuxTargetDiscovery,
  type TmuxTarget,
  tmuxSessionNameForSession
} from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createRestartReconciler } from "./restart-reconciler.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("restart reconciler", () => {
  it("updates live sessions, marks missing sessions stale, ignores stopped records, and reports unmanaged targets", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const sessions = createSessionRepository(open.db);
      const live = sessions.create(sessionRecord("sess_restart_live_01", "restart-live"));
      const missing = sessions.create(sessionRecord("sess_restart_missing_01", "restart-missing"));
      const stopped = sessions.create({
        ...sessionRecord("sess_restart_stop_01", "restart-stopped"),
        lifecycle_state: "stopped"
      });
      const unmanaged = discoveredTarget("sess_restart_unmanaged_01", "%9");
      const readerStarts: string[] = [];
      const discovery = fakeDiscovery({
        liveTargets: [targetForSession(live, "%7")],
        staleTargets: [
          {
            sessionId: missing.id,
            sessionName: missing.name,
            cwd: missing.cwd,
            tmuxSession: missing.backend.tmux_session,
            staleReason: "tmux target missing"
          }
        ],
        unmanagedTargets: [unmanaged]
      });

      const result = await createRestartReconciler({
        sessions,
        discovery,
        now: laterNow,
        startOutputReader(target) {
          readerStarts.push(target.sessionId);
        }
      }).reconcile();

      expect(result.liveTargets.map((target) => target.sessionId)).toEqual([live.id]);
      expect(result.staleSessionIds).toEqual([missing.id]);
      expect(result.unmanagedTargets.map((target) => target.sessionId)).toEqual([unmanaged.sessionId]);
      expect(readerStarts).toEqual([live.id]);
      expect(sessions.require(live.id)).toMatchObject({
        lifecycle_state: "running",
        backend: {
          tmux_session: live.backend.tmux_session,
          tmux_window: "codex",
          tmux_pane: "%7"
        },
        stale_reason: null,
        updated_at: "2026-07-08T22:05:00.000Z"
      });
      expect(sessions.require(missing.id)).toMatchObject({
        lifecycle_state: "stale",
        stale_reason: "tmux target missing",
        updated_at: "2026-07-08T22:05:00.000Z"
      });
      expect(sessions.require(stopped.id)).toMatchObject({
        lifecycle_state: "stopped"
      });
      expect(sessions.get(unmanaged.sessionId)).toBeNull();
    } finally {
      open.db.close();
    }
  });
});

function fakeDiscovery(result: {
  readonly liveTargets: readonly TmuxTarget[];
  readonly staleTargets: readonly {
    readonly sessionId: ExpectedTmuxTarget["sessionId"];
    readonly sessionName: ExpectedTmuxTarget["sessionName"];
    readonly cwd: ExpectedTmuxTarget["cwd"];
    readonly tmuxSession: string;
    readonly staleReason: string;
  }[];
  readonly unmanagedTargets: readonly RealTmuxDiscoveredTarget[];
}): RealTmuxTargetDiscovery {
  return {
    tmuxSessionNameForSession,
    parseSessionIdFromTmuxSessionName,
    async listTargets() {
      return result.unmanagedTargets;
    },
    async getTargetBySessionId() {
      return null;
    },
    async reconcileTargets(expectedTargets) {
      const expectedIds = new Set(expectedTargets.map((target) => target.sessionId));
      return {
        liveTargets: result.liveTargets.filter((target) => expectedIds.has(target.sessionId)),
        staleTargets: result.staleTargets.filter((target) => expectedIds.has(target.sessionId)),
        unmanagedTargets: result.unmanagedTargets
      };
    }
  };
}

function sessionRecord(id: string, name: string): StorageSessionRecord {
  const sessionId = parseRequiredSessionId(id);

  return {
    id: sessionId,
    name: parseRequiredSessionName(name),
    cwd: parseRequiredCwd(tempCwd()),
    backend: {
      type: "tmux",
      tmux_session: tmuxSessionNameForSession(sessionId),
      tmux_window: "codex",
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: parseRequiredIso("2026-07-08T22:00:00.000Z"),
    updated_at: parseRequiredIso("2026-07-08T22:00:00.000Z"),
    stale_reason: null
  };
}

function targetForSession(session: StorageSessionRecord, pane: string): TmuxTarget {
  return {
    sessionId: session.id,
    sessionName: session.name,
    cwd: session.cwd,
    tmuxSession: session.backend.tmux_session,
    tmuxWindow: "codex",
    tmuxPane: pane,
    lifecycleState: "running",
    staleReason: null,
    createdAt: session.created_at,
    updatedAt: parseRequiredIso("2026-07-08T22:04:00.000Z")
  };
}

function discoveredTarget(id: string, pane: string): RealTmuxDiscoveredTarget {
  const sessionId = parseRequiredSessionId(id);

  return {
    sessionId,
    tmuxSession: tmuxSessionNameForSession(sessionId),
    tmuxWindow: "codex",
    tmuxPane: pane,
    currentPath: parseRequiredCwd(tempCwd()),
    createdAt: parseRequiredIso("2026-07-08T22:03:00.000Z"),
    updatedAt: parseRequiredIso("2026-07-08T22:04:00.000Z")
  };
}

function parseRequiredSessionId(value: string) {
  const result = parseSessionId(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredSessionName(value: string) {
  const result = parseSessionName(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredCwd(value: string) {
  const result = parseAbsoluteCwd(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredIso(value: string) {
  const result = parseIsoTimestamp(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-restart-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-restart-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
