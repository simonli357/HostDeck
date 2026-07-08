import { describe, expect, it } from "vitest";
import {
  attentionForStatus,
  attentionPriority,
  canTransitionLifecycle,
  hasSessionNameCollision,
  isSessionId,
  isSessionName,
  isWritableLifecycleState,
  parseAbsoluteCwd,
  parseIsoTimestamp,
  parseOutputCursor,
  parseSessionId,
  parseSessionName,
  type SessionName
} from "./session.js";

function expectValid<T>(result: { ok: true; value: T } | { ok: false; code: string; message: string }): T {
  expect(result).toMatchObject({ ok: true });

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

describe("session identity", () => {
  it("keeps stable ids separate from display names", () => {
    const id = expectValid(parseSessionId("sess_alpha_01"));
    const name = expectValid(parseSessionName("alpha"));

    expect(id).not.toBe(name);
    expect(isSessionId(id)).toBe(true);
    expect(isSessionName(name)).toBe(true);
  });

  it("rejects invalid session ids", () => {
    expect(parseSessionId("")).toMatchObject({ ok: false, code: "empty" });
    expect(parseSessionId("short")).toMatchObject({ ok: false, code: "too_short" });
    expect(parseSessionId("sess_Invalid")).toMatchObject({ ok: false, code: "invalid_format" });
    expect(parseSessionId("sess_bad/path")).toMatchObject({ ok: false, code: "invalid_format" });
  });

  it("normalizes and validates session names", () => {
    const name = expectValid(parseSessionName("  project.main  "));

    expect(name).toBe("project.main");
    expect(parseSessionName("bad/name")).toMatchObject({ ok: false, code: "invalid_format" });
    expect(parseSessionName("")).toMatchObject({ ok: false, code: "empty" });
  });

  it("detects duplicate V1 session names without using ids as names", () => {
    const existingName = expectValid(parseSessionName("project")) as SessionName;
    const candidate = expectValid(parseSessionName("project")) as SessionName;

    expect(hasSessionNameCollision([existingName], candidate)).toBe(true);
  });
});

describe("session metadata validation", () => {
  it("validates absolute working directories without touching the filesystem", () => {
    expect(parseAbsoluteCwd("/home/simonli/project")).toMatchObject({ ok: true });
    expect(parseAbsoluteCwd("relative/path")).toMatchObject({ ok: false, code: "not_absolute" });
    expect(parseAbsoluteCwd("/tmp/\0bad")).toMatchObject({ ok: false, code: "invalid_format" });
  });

  it("validates timestamps and output cursors", () => {
    expect(parseIsoTimestamp("2026-07-08T18:00:00.000Z")).toMatchObject({ ok: true });
    expect(parseIsoTimestamp("2026-07-08")).toMatchObject({ ok: false, code: "invalid_format" });
    expect(parseOutputCursor(0)).toMatchObject({ ok: true });
    expect(parseOutputCursor(1.5)).toMatchObject({ ok: false, code: "not_integer" });
    expect(parseOutputCursor(-1)).toMatchObject({ ok: false, code: "negative" });
  });
});

describe("lifecycle and advisory status", () => {
  it("allows only explicit lifecycle transitions", () => {
    expect(canTransitionLifecycle("starting", "running")).toBe(true);
    expect(canTransitionLifecycle("running", "stale")).toBe(true);
    expect(canTransitionLifecycle("stopped", "running")).toBe(false);
    expect(canTransitionLifecycle("stale", "running")).toBe(false);
  });

  it("treats only running sessions as writable at the lifecycle level", () => {
    expect(isWritableLifecycleState("running")).toBe(true);
    expect(isWritableLifecycleState("starting")).toBe(false);
    expect(isWritableLifecycleState("stale")).toBe(false);
    expect(isWritableLifecycleState("unknown")).toBe(false);
  });

  it("keeps unknown advisory instead of healthy", () => {
    expect(attentionForStatus("unknown")).toBe("unknown");
    expect(attentionPriority("unknown")).toBeGreaterThan(attentionPriority("none"));
    expect(attentionForStatus("idle")).toBe("none");
    expect(attentionForStatus("waiting_for_approval")).toBe("needs_approval");
    expect(attentionForStatus("tests_failed")).toBe("failed");
  });
});
