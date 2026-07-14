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
  dashboardFixtureById,
  fakeApiSessions,
  fakeDashboardStateFixtures,
  fakeHostStates,
  fakeMissionControlViewModels,
  fakeSessionDetailViewModels,
  mobileInteractionIds,
  mobileInteractionTraces,
  mobileStateTraceIds,
  mobileStateTraces,
  requiredDashboardStateFixtureIds
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
  it("covers every required FE-V1-001 dashboard state fixture", () => {
    expect(fakeDashboardStateFixtures.map((fixture) => fixture.id)).toEqual(requiredDashboardStateFixtureIds);
  });

  it("parses every FE-V1-001 dashboard state fixture through the shared UI contracts", () => {
    for (const fixture of fakeDashboardStateFixtures) {
      if (fixture.surface === "mission_control") {
        expect(uiMissionControlViewModelSchema.parse(fixture.viewModel).screen, fixture.id).toBe("mission_control");
      } else {
        expect(uiSessionDetailViewModelSchema.parse(fixture.viewModel).screen, fixture.id).toBe("session_detail");
      }
    }
  });

  it("keeps unknown, stale, stopped, locked, and reconnecting states visibly non-writable", () => {
    expect(sessionDetailFixture("session_detail_unknown").viewModel.prompt_control.disabled_reason).toBe("unknown");
    expect(sessionDetailFixture("session_detail_stale").viewModel.prompt_control.disabled_reason).toBe("stale");
    expect(sessionDetailFixture("session_detail_stopped").viewModel.prompt_control.disabled_reason).toBe("stopped");
    expect(sessionDetailFixture("session_detail_stream_reconnecting").viewModel.prompt_control.disabled_reason).toBe("stream_disconnected");
    expect(missionControlFixture("mission_control_locked").viewModel.trust.write_controls_enabled).toBe(false);
    expect(missionControlFixture("mission_control_lan_disabled").viewModel.host_safety.network.lan_enabled).toBe(false);
  });

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

describe("FE-V1-004 mobile design fixtures", () => {
  it("exports the complete state and interaction inventories to web consumers", () => {
    expect(mobileStateTraces.map((trace) => trace.id)).toEqual(mobileStateTraceIds);
    expect(mobileInteractionTraces.map((trace) => trace.id)).toEqual(mobileInteractionIds);
  });

  it("keeps the first phone viewport useful and pre-load failures outside the HostDeck render tree", () => {
    const mission = mobileStateTraces.find((trace) => trace.id === "mission_mixed_attention");
    const detail = mobileStateTraces.find((trace) => trace.id === "detail_active_writable");
    const preload = mobileStateTraces.find((trace) => trace.id === "preload_remote_origin_unreachable");

    expect(mission?.firstViewport).toEqual(["host_access_strip", "page_title", "session_rows_two"]);
    expect(detail?.firstViewport).toContain("sticky_composer");
    expect(detail?.firstViewport).toContain("primary_controls");
    expect(preload).toMatchObject({
      renderBoundary: "browser_preload",
      diagnosisSource: "browser_network_only",
      dataDisclosure: "none"
    });
  });
});

function sessionDetailFixture(id: Parameters<typeof dashboardFixtureById>[0]) {
  const fixture = dashboardFixtureById(id);

  if (fixture.surface !== "session_detail") {
    throw new TypeError(`${id} is not a Session Detail fixture.`);
  }

  return fixture;
}

function missionControlFixture(id: Parameters<typeof dashboardFixtureById>[0]) {
  const fixture = dashboardFixtureById(id);

  if (fixture.surface !== "mission_control") {
    throw new TypeError(`${id} is not a Mission Control fixture.`);
  }

  return fixture;
}
