import { classifyCodexOutput } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import { codexOutputFixtureByCategory, codexOutputFixtures } from "./index.js";

describe("Codex output classifier over deterministic fixtures", () => {
  it("classifies every required fixture category as expected", () => {
    for (const fixture of codexOutputFixtures) {
      expect(classifyCodexOutput(fixture.output)).toMatchObject(fixture.expected);
    }
  });

  it("keeps unrecognized output unknown instead of idle or successful", () => {
    expect(classifyCodexOutput(codexOutputFixtureByCategory("unknown_output").output)).toMatchObject({
      status: "unknown",
      attention: "unknown",
      reason: "unknown_output"
    });
  });

  it("does not turn ambiguous completion-like text into success", () => {
    expect(classifyCodexOutput("maybe done\nnext marker: ???")).toMatchObject({
      status: "unknown",
      attention: "unknown"
    });
  });

  it("does not mistake explicit zero-failure wording for failed tests", () => {
    expect(classifyCodexOutput("Test Files 4 passed (4)\nTests 31 passed (31) | 0 failed\nDuration 821ms")).toMatchObject({
      status: "tests_passed",
      attention: "none",
      reason: "tests_passed"
    });

    expect(classifyCodexOutput("All tests passed. No failed tests were found.")).toMatchObject({
      status: "tests_passed",
      attention: "none",
      reason: "tests_passed"
    });
  });

  it("keeps explicit test failure counts as failed", () => {
    expect(classifyCodexOutput("Test Files 1 failed | 3 passed\nTests 2 failed | 29 passed")).toMatchObject({
      status: "tests_failed",
      attention: "failed",
      reason: "tests_failed"
    });
  });
});
