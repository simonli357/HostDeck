import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureGitBranchMetadata,
  type GitBranchMetadataErrorCode,
  HostDeckGitBranchMetadataError
} from "./branch-metadata.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { createSessionMetadataRepository, createSessionRepository } from "./session-repository.js";

const tempDirs: string[] = [];
const sessionId = "sess_git_01";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("git branch metadata capture", () => {
  it("captures and persists a branch from a git worktree", () => {
    const cwd = tempGitWorktree("feature/branch-metadata");
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord(cwd));
      const metadata = createSessionMetadataRepository(open.db);
      const branch = captureGitBranchMetadata(cwd);

      expect(branch).toBe("feature/branch-metadata");
      metadata.upsert(metadataRecord({ branch }));
      expect(metadata.require(sessionId).branch).toBe("feature/branch-metadata");
    } finally {
      open.db.close();
    }
  });

  it("returns null for non-git directories and persists nullable branch metadata", () => {
    const cwd = tempCwd();
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord(cwd));
      const metadata = createSessionMetadataRepository(open.db);

      expect(captureGitBranchMetadata(cwd)).toBeNull();
      metadata.upsert(metadataRecord({ branch: captureGitBranchMetadata(cwd) }));
      expect(metadata.require(sessionId).branch).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("does not require git to be installed for optional metadata", () => {
    expect(captureGitBranchMetadata(tempCwd(), { gitBinary: "hostdeck-missing-git-binary" })).toBeNull();
  });

  it("drops detached, empty, multiline, and oversized branch output", () => {
    const cwd = tempCwd();

    expect(captureGitBranchMetadata(cwd, { execFile: () => "HEAD\n" })).toBeNull();
    expect(captureGitBranchMetadata(cwd, { execFile: () => "\n" })).toBeNull();
    expect(captureGitBranchMetadata(cwd, { execFile: () => "main\nother\n" })).toBeNull();
    expect(captureGitBranchMetadata(cwd, { execFile: () => "x".repeat(241) })).toBeNull();
  });

  it("rejects invalid cwd values before invoking git", () => {
    expectBranchError(() => captureGitBranchMetadata("relative/path"), "invalid_cwd");
  });
});

function sessionRecord(cwd: string) {
  return {
    id: sessionId,
    name: "git-demo",
    cwd,
    backend: {
      type: "tmux",
      tmux_session: "hostdeck-git-demo",
      tmux_window: null,
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: "2026-07-08T22:00:00.000Z",
    updated_at: "2026-07-08T22:00:00.000Z",
    stale_reason: null
  };
}

function metadataRecord(input: { readonly branch: string | null }) {
  return {
    session_id: sessionId,
    branch: input.branch,
    last_activity_at: "2026-07-08T22:00:00.000Z",
    status: "idle",
    attention: "none",
    summary: "Idle.",
    last_output_cursor: null,
    updated_at: "2026-07-08T22:00:00.000Z"
  };
}

function tempGitWorktree(branch: string): string {
  const dir = tempCwd();
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "--quiet", "-b", branch], { cwd: dir, stdio: "ignore" });
  return dir;
}

function expectBranchError(fn: () => unknown, code: GitBranchMetadataErrorCode): void {
  expect(fn).toThrow(HostDeckGitBranchMetadataError);

  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckGitBranchMetadataError);
    expect((error as HostDeckGitBranchMetadataError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckGitBranchMetadataError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-branch-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-branch-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}
