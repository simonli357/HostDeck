import {
  apiSessionSchema,
  hostStatusResponseSchema,
  uiMissionControlViewModelSchema,
  uiSessionDetailViewModelSchema
} from "@hostdeck/contracts";
import { attentionLevels, sessionStatuses } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  codexOutputCategories,
  codexOutputFixtureByCategory,
  codexOutputFixtures,
  fakeApiSessions,
  fakeHostStates,
  fakeMissionControlViewModels,
  fakeSessionDetailViewModels
} from "./index.js";

const requiredCategories = [
  "question_waiting",
  "approval_waiting",
  "command_running",
  "tests_passed",
  "tests_failed",
  "compact_warning",
  "idle_no_output",
  "unknown_output"
] as const;

describe("Codex-like output fixtures", () => {
  it("covers every required SFR-011 category exactly once", () => {
    expect(codexOutputCategories).toEqual(requiredCategories);
    expect(codexOutputFixtures.map((fixture) => fixture.category).sort()).toEqual([...requiredCategories].sort());
  });

  it("uses only shared status and attention values", () => {
    for (const fixture of codexOutputFixtures) {
      expect(sessionStatuses).toContain(fixture.expected.status);
      expect(attentionLevels).toContain(fixture.expected.attention);
    }
  });

  it("keeps unknown output visibly unknown instead of healthy", () => {
    expect(codexOutputFixtureByCategory("unknown_output").expected).toEqual({
      status: "unknown",
      attention: "unknown"
    });
  });
});

describe("fake session and host fixtures", () => {
  it("parses every fake API session through the shared API contract", () => {
    for (const session of Object.values(fakeApiSessions)) {
      expect(apiSessionSchema.parse(session).id).toBe(session.id);
    }
  });

  it("parses every fake host state through the shared host-status contract", () => {
    for (const hostState of Object.values(fakeHostStates)) {
      expect(hostStatusResponseSchema.parse(hostState).version).toBe("0.0.0");
    }
  });
});

describe("fake UI fixtures", () => {
  it("parses Mission Control fixtures through the shared UI contract", () => {
    for (const viewModel of Object.values(fakeMissionControlViewModels)) {
      expect(uiMissionControlViewModelSchema.parse(viewModel).screen).toBe("mission_control");
    }
  });

  it("parses Session Detail fixtures through the shared UI contract", () => {
    for (const viewModel of Object.values(fakeSessionDetailViewModels)) {
      expect(uiSessionDetailViewModelSchema.parse(viewModel).screen).toBe("session_detail");
    }
  });
});
