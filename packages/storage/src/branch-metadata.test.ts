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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("git branch metadata capture", () => {
  it("captures a bounded branch from a git worktree", () => {
    const cwd = tempGitWorktree("feature/selected-runtime");
    expect(captureGitBranchMetadata(cwd)).toBe("feature/selected-runtime");
  });

  it("returns null for non-git, missing-git, detached, and malformed output", () => {
    const cwd = tempCwd();
    expect(captureGitBranchMetadata(cwd)).toBeNull();
    expect(captureGitBranchMetadata(cwd, { gitBinary: "hostdeck-missing-git-binary" })).toBeNull();
    for (const output of ["HEAD\n", "\n", "main\nother\n", "x".repeat(241)]) {
      expect(captureGitBranchMetadata(cwd, { execFile: () => output })).toBeNull();
    }
  });

  it("rejects invalid working directories before invoking git", () => {
    expectBranchError(() => captureGitBranchMetadata("relative/path"), "invalid_cwd");
  });
});

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

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-branch-cwd-"));
  tempDirs.push(dir);
  return dir;
}
