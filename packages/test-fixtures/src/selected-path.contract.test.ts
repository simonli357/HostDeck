import {
  managedSessionProjectionSchema,
  runtimeCompatibilitySchema,
  selectedMissionControlViewModelSchema,
  selectedSessionDetailViewModelSchema,
  selectedSessionEventStreamSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  readyRuntimeCompatibility,
  requiredSelectedMobileFixtureIds,
  requiredStructuredRuntimeFixtureIds,
  type SelectedMobileFixture, 
  selectedMobileFixtureById,
  selectedMobileStateFixtures,
  selectedStructuredRuntimeFixtures,
  structuredRuntimeFixtureById
} from "./structured-runtime.js";

describe("selected structured runtime fixture inventory", () => {
  it("contains every required SFR-011 category exactly once", () => {
    const ids = selectedStructuredRuntimeFixtures.map((fixture) => fixture.id);

    expect(ids).toEqual(requiredStructuredRuntimeFixtureIds);
    expect(new Set(ids).size).toBe(requiredStructuredRuntimeFixtureIds.length);
  });

  it("round-trips every compatibility, session, and event stream through public contracts", () => {
    for (const fixture of selectedStructuredRuntimeFixtures) {
      expect(runtimeCompatibilitySchema.parse(fixture.compatibility)).toEqual(fixture.compatibility);
      expect(managedSessionProjectionSchema.parse(fixture.session)).toEqual(fixture.session);
      expect(selectedSessionEventStreamSchema.parse(fixture.stream)).toEqual(fixture.stream);
    }
  });

  it("keeps optional utilities unavailable without falsely marking the runtime incompatible", () => {
    expect(readyRuntimeCompatibility.state).toBe("ready");
    expect(readyRuntimeCompatibility.capabilities.find((capability) => capability.name === "compact")).toMatchObject({
      state: "unavailable"
    });
  });

  it("represents unknown, disconnected, incompatible, and replay-boundary states explicitly", () => {
    expect(structuredRuntimeFixtureById("unknown_optional").stream.events[0]).toMatchObject({ type: "unknown_optional" });
    expect(structuredRuntimeFixtureById("disconnect")).toMatchObject({
      compatibility: { state: "disconnected" },
      session: { freshness: "disconnected", attention: "unknown" }
    });
    expect(structuredRuntimeFixtureById("incompatible")).toMatchObject({
      compatibility: { state: "incompatible" },
      session: { session_state: "incompatible", freshness: "incompatible" }
    });
    expect(structuredRuntimeFixtureById("replay_boundary")).toMatchObject({
      stream: { truncated: true, events: [{ type: "replay_boundary" }] }
    });
  });
});

describe("selected mobile fixture inventory", () => {
  it("contains every phone state exactly once", () => {
    const ids = selectedMobileStateFixtures.map((fixture) => fixture.id);

    expect(ids).toEqual(requiredSelectedMobileFixtureIds);
    expect(new Set(ids).size).toBe(requiredSelectedMobileFixtureIds.length);
  });

  it("round-trips every phone fixture through the selected public view-model contracts", () => {
    for (const fixture of selectedMobileStateFixtures) {
      if (fixture.surface === "mission_control") {
        expect(selectedMissionControlViewModelSchema.parse(fixture.viewModel)).toEqual(fixture.viewModel);
      } else {
        expect(selectedSessionDetailViewModelSchema.parse(fixture.viewModel)).toEqual(fixture.viewModel);
      }
    }
  });

  it("keeps Mission Control phone ordering approval-first and quiet-last", () => {
    const fixture = requireSurface(selectedMobileFixtureById("mission_control_ready"), "mission_control");
    const displayStates = fixture.viewModel.sessions.map((row) => row.display_state);

    expect(displayStates).toEqual(["needs_approval", "needs_input", "failed", "interrupted", "running", "quiet"]);
  });

  it("rejects duplicate sessions and display labels that contradict their projection", () => {
    const fixture = requireSurface(selectedMobileFixtureById("mission_control_ready"), "mission_control");
    const first = fixture.viewModel.sessions[0];
    if (first === undefined) throw new TypeError("Ready Mission Control fixture has no rows.");

    expect(() =>
      selectedMissionControlViewModelSchema.parse({
        ...fixture.viewModel,
        sessions: [first, first]
      })
    ).toThrow();
    expect(() =>
      selectedMissionControlViewModelSchema.parse({
        ...fixture.viewModel,
        sessions: [{ ...first, display_state: "quiet" }, ...fixture.viewModel.sessions.slice(1)]
      })
    ).toThrow();
  });

  it("makes model, goal, and plan the exact primary Session Detail controls", () => {
    const fixture = requireSurface(selectedMobileFixtureById("session_detail_ready"), "session_detail");

    expect(fixture.viewModel.primary_controls.map((control) => control.control)).toEqual(["model", "goal", "plan"]);
    expect(fixture.viewModel.utility_controls.map((control) => control.control)).toEqual(["usage", "compact", "skills"]);
    expect(fixture.viewModel.approvals).toHaveLength(1);
  });

  it("does not expose session data or enabled controls in inaccessible states", () => {
    for (const id of [
      "session_detail_loading",
      "session_detail_certificate_error",
      "session_detail_permission_denied",
      "session_detail_not_found",
      "session_detail_fatal"
    ] as const) {
      const fixture = requireSurface(selectedMobileFixtureById(id), "session_detail");

      expect(fixture.viewModel.session).toBeNull();
      expect(fixture.viewModel.events).toBeNull();
      expect(fixture.viewModel.prompt.enabled).toBe(false);
      expect(fixture.viewModel.primary_controls.every((control) => control.availability !== "available")).toBe(true);
      expect(fixture.viewModel.risky_controls.every((control) => !control.enabled)).toBe(true);
    }
  });

  it("rejects mutation controls when host access or projection freshness is not writable", () => {
    const fixture = requireSurface(selectedMobileFixtureById("session_detail_offline"), "session_detail");

    expect(() =>
      selectedSessionDetailViewModelSchema.parse({
        ...fixture.viewModel,
        prompt: {
          enabled: true,
          phase: "idle",
          disabled_reason: null,
          error: null
        }
      })
    ).toThrow();
  });

  it("marks projection boundaries and diagnostics as read-only and incomplete", () => {
    const fixture = requireSurface(selectedMobileFixtureById("session_detail_boundary"), "session_detail");

    expect(fixture.viewModel.diagnostics).toMatchObject({
      read_only: true,
      projection_complete: false,
      boundary_visible: true
    });
  });

  it("contains no legacy terminal or raw-input control keys", () => {
    const keys = collectKeys({
      runtime: selectedStructuredRuntimeFixtures,
      mobile: selectedMobileStateFixtures
    });

    expect(keys).not.toContain("raw_input");
    expect(keys).not.toContain("raw_input_control");
    expect(keys).not.toContain("advanced_raw_visible");
    expect(keys).not.toContain("slash_controls");
    expect(keys).not.toContain("terminal_input");
  });
});

function requireSurface<T extends SelectedMobileFixture["surface"]>(
  fixture: SelectedMobileFixture,
  surface: T
): Extract<SelectedMobileFixture, { readonly surface: T }> {
  if (fixture.surface !== surface) {
    throw new TypeError(`Expected ${surface} fixture, received ${fixture.surface}.`);
  }
  return fixture as Extract<SelectedMobileFixture, { readonly surface: T }>;
}

function collectKeys(value: unknown, keys: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value === null || typeof value !== "object") return keys;

  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
}
