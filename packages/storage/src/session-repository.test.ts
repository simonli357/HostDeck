import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createSessionMetadataRepository,
  createSessionRepository,
  HostDeckSessionRepositoryError,
  type SessionRepositoryErrorCode
} from "./session-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("session registry and metadata repositories", () => {
  it("creates, updates, lists, and reloads session and metadata records", () => {
    const path = tempDbPath();
    const cwd = tempCwd();
    const firstOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      const sessions = createSessionRepository(firstOpen.db);
      const metadata = createSessionMetadataRepository(firstOpen.db);

      expect(sessions.create(sessionRecord({ cwd })).name).toBe("repo-demo");
      expect(sessions.list().map((session) => session.id)).toEqual(["sess_repo_01"]);

      expect(metadata.upsert(metadataRecord({ summary: "Waiting for confirmation." })).status).toBe("waiting_for_user");
      expect(
        metadata.upsert(
          metadataRecord({
            last_output_cursor: 43,
            status: "running",
            attention: "watch",
            summary: "Running command."
          })
        ).last_output_cursor
      ).toBe(43);
    } finally {
      firstOpen.db.close();
    }

    const secondOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      const sessions = createSessionRepository(secondOpen.db);
      const metadata = createSessionMetadataRepository(secondOpen.db);

      expect(sessions.require("sess_repo_01").cwd).toBe(cwd);
      expect(metadata.require("sess_repo_01")).toMatchObject({
        status: "running",
        attention: "watch",
        summary: "Running command.",
        last_output_cursor: 43
      });
    } finally {
      secondOpen.db.close();
    }
  });

  it("rejects duplicate session names and ids", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const sessions = createSessionRepository(open.db);
      sessions.create(sessionRecord({ cwd: tempCwd() }));

      expectSessionError(
        () =>
          sessions.create(
            sessionRecord({
              id: "sess_repo_02",
              cwd: tempCwd()
            })
          ),
        "duplicate_session_name"
      );

      expectSessionError(
        () =>
          sessions.create(
            sessionRecord({
              id: "sess_repo_01",
              name: "repo-demo-2",
              cwd: tempCwd()
            })
          ),
        "session_exists"
      );
    } finally {
      open.db.close();
    }
  });

  it("rejects invalid cwd before write", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const sessions = createSessionRepository(open.db);

      expectSessionError(() => sessions.create(sessionRecord({ cwd: "relative/path" })), "invalid_session");
      expect(sessions.list()).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("marks sessions stale with a required reason", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const sessions = createSessionRepository(open.db);
      sessions.create(sessionRecord({ cwd: tempCwd() }));

      const stale = sessions.markStale("sess_repo_01", "tmux target missing", { now: laterNow });
      expect(stale.lifecycle_state).toBe("stale");
      expect(stale.stale_reason).toBe("tmux target missing");
      expect(stale.updated_at).toBe("2026-07-08T22:05:00.000Z");

      expectSessionError(() => sessions.markStale("sess_repo_01", "", { now: laterNow }), "invalid_session");
    } finally {
      open.db.close();
    }
  });

  it("persists failed metadata status after migration", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord({ cwd: tempCwd() }));
      const metadata = createSessionMetadataRepository(open.db);

      expect(
        metadata.upsert(
          metadataRecord({
            status: "failed",
            attention: "failed",
            summary: "Agent error."
          })
        ).status
      ).toBe("failed");
    } finally {
      open.db.close();
    }
  });

  it("rejects metadata for missing sessions", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const metadata = createSessionMetadataRepository(open.db);

      expectSessionError(() => metadata.upsert(metadataRecord()), "session_not_found");
    } finally {
      open.db.close();
    }
  });

  it("blocks reload on invalid persisted session records", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      open.db
        .prepare(
          `
            INSERT INTO sessions (
              id,
              name,
              cwd,
              backend_type,
              tmux_session,
              tmux_window,
              tmux_pane,
              lifecycle_state,
              created_at,
              updated_at,
              stale_reason
            ) VALUES (
              'sess_repo_01',
              'repo-demo',
              '/home/simonli/work/corrupt',
              'tmux',
              'hostdeck-repo-demo',
              NULL,
              '%1',
              'running',
              '2026-02-30T22:00:00.000Z',
              '2026-07-08T22:00:00.000Z',
              NULL
            )
          `
        )
        .run();

      expectSessionError(() => createSessionRepository(open.db).require("sess_repo_01"), "invalid_session");
    } finally {
      open.db.close();
    }
  });
});

function sessionRecord(input: {
  readonly id?: string;
  readonly name?: string;
  readonly cwd: string;
}) {
  return {
    id: input.id ?? "sess_repo_01",
    name: input.name ?? "repo-demo",
    cwd: input.cwd,
    backend: {
      type: "tmux",
      tmux_session: "hostdeck-repo-demo",
      tmux_window: null,
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: "2026-07-08T22:00:00.000Z",
    updated_at: "2026-07-08T22:00:00.000Z",
    stale_reason: null
  };
}

function metadataRecord(input: {
  readonly attention?: string;
  readonly last_output_cursor?: number;
  readonly status?: string;
  readonly summary?: string;
} = {}) {
  return {
    session_id: "sess_repo_01",
    branch: "main",
    last_activity_at: "2026-07-08T22:00:00.000Z",
    status: input.status ?? "waiting_for_user",
    attention: input.attention ?? "needs_input",
    summary: input.summary ?? "Waiting for confirmation.",
    last_output_cursor: input.last_output_cursor ?? 42,
    updated_at: "2026-07-08T22:00:00.000Z"
  };
}

function expectSessionError(fn: () => unknown, code: SessionRepositoryErrorCode): void {
  expect(fn).toThrow(HostDeckSessionRepositoryError);

  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSessionRepositoryError);
    expect((error as HostDeckSessionRepositoryError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckSessionRepositoryError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-session-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
