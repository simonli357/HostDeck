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
});
