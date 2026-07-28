import { describe, expect, it } from "vitest";
import {
  type MissionApiVariant,
  missionSessionListFixture
} from "./mission-control-fixture.js";

const readableVariants = Object.freeze([
  "mixed",
  "failure_matrix",
  "long",
  "read_only",
  "locked",
  "host_unavailable",
  "session_unavailable"
] as const satisfies readonly MissionApiVariant[]);

describe("Mission Control browser fixture", () => {
  it.each(readableVariants)("builds a selected-contract-valid %s session list", (variant) => {
    const fixture = missionSessionListFixture(variant);

    expect(fixture.sessions.length).toBeGreaterThan(0);
    expect(fixture.has_more).toBe(false);
    expect(fixture.next_cursor).toBeNull();
  });
});
