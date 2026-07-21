import { describe, expect, it } from "vitest";
import {
  hasSessionNameCollision,
  isSessionId,
  isSessionName,
  parseAbsoluteCwd,
  parseIsoTimestamp,
  parseOutputCursor,
  parseSessionId,
  parseSessionName,
  type SessionName
} from "./identifiers.js";

function expectValid<T>(result: { ok: true; value: T } | { ok: false; code: string; message: string }): T {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe("selected identifiers", () => {
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

  it("normalizes, validates, and compares session names", () => {
    const name = expectValid(parseSessionName("  project.main  "));
    expect(name).toBe("project.main");
    expect(parseSessionName("bad/name")).toMatchObject({ ok: false, code: "invalid_format" });
    expect(parseSessionName("")).toMatchObject({ ok: false, code: "empty" });
    expect(hasSessionNameCollision([name as SessionName], name as SessionName)).toBe(true);
  });

  it("validates absolute working directories without filesystem access", () => {
    expect(parseAbsoluteCwd("/home/simonli/project")).toMatchObject({ ok: true });
    expect(parseAbsoluteCwd("relative/path")).toMatchObject({ ok: false, code: "not_absolute" });
    expect(parseAbsoluteCwd("/tmp/\0bad")).toMatchObject({ ok: false, code: "invalid_format" });
  });

  it("validates timestamps and output cursors", () => {
    expect(parseIsoTimestamp("2026-07-08T20:00:00.000+02:00")).toMatchObject({
      ok: true,
      value: "2026-07-08T18:00:00.000Z"
    });
    for (const timestamp of [
      "2026-07-08",
      "2026-02-29T18:00:00.000Z",
      "2026-04-31T18:00:00.000Z",
      "2026-07-08T18:00:00.000+24:00"
    ]) {
      expect(parseIsoTimestamp(timestamp)).toMatchObject({ ok: false, code: "invalid_format" });
    }
    expect(parseIsoTimestamp("2024-02-29T18:00:00.000Z")).toMatchObject({ ok: true });
    expect(parseOutputCursor(0)).toMatchObject({ ok: true });
    expect(parseOutputCursor(Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: true });
    expect(parseOutputCursor(Number.MAX_SAFE_INTEGER + 1)).toMatchObject({ ok: false, code: "unsafe_integer" });
    expect(parseOutputCursor(1.5)).toMatchObject({ ok: false, code: "not_integer" });
    expect(parseOutputCursor(-1)).toMatchObject({ ok: false, code: "negative" });
  });
});
