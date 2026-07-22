import {
  managedSessionProjectionSchema,
  runtimeCompatibilitySchema,
  selectedHostAccessSchema,
  selectedMissionControlViewModelSchema,
  selectedSessionDetailViewModelSchema,
  selectedSessionEventStreamSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { remoteFixtureOrigin } from "./remote-ingress.js";
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

  it("keeps required controls writable while an optional degraded capability stays unknown", () => {
    const fixture = requireSurface(selectedMobileFixtureById("session_detail_degraded"), "session_detail");

    expect(fixture.viewModel.host_access.writes_enabled).toBe(true);
    expect(fixture.viewModel.prompt.enabled).toBe(true);
    expect(fixture.viewModel.primary_controls.every((control) => control.availability === "available")).toBe(true);
    expect(fixture.viewModel.utility_controls.find((control) => control.control === "usage")).toMatchObject({
      capability_state: "unknown",
      availability: "unknown"
    });
  });

  it("keeps read utilities available without exposing mutations to a read-only phone", () => {
    const fixture = requireSurface(selectedMobileFixtureById("session_detail_read_only"), "session_detail");

    expect(fixture.viewModel.host_access).toMatchObject({ access: "paired_read_only", reads_enabled: true, writes_enabled: false });
    expect(fixture.viewModel.prompt.enabled).toBe(false);
    expect(fixture.viewModel.primary_controls.every((control) => control.availability !== "available")).toBe(true);
    expect(fixture.viewModel.utility_controls.find((control) => control.control === "usage")?.availability).toBe("available");
    expect(fixture.viewModel.utility_controls.find((control) => control.control === "skills")?.availability).toBe("available");
    expect(fixture.viewModel.risky_controls.every((control) => !control.enabled)).toBe(true);
  });

  it("uses route-backed private HTTPS state without exposing proxy or Tailnet identity", () => {
    const fixture = requireSurface(selectedMobileFixtureById("mission_control_ready"), "mission_control");
    expect(fixture.viewModel.host_access).toMatchObject({
      origin: remoteFixtureOrigin,
      client_connection: "online",
      remote_ingress: { availability: "ready", external_origin: remoteFixtureOrigin }
    });
    expect(fixture.viewModel.host_access).not.toHaveProperty("ingress_provenance");
    expect(fixture.viewModel.host_access).not.toHaveProperty("device_label");
    expect(fixture.viewModel.host_access).not.toHaveProperty("runtime");
    expect(fixture.viewModel.host_access).not.toHaveProperty("stream_state");

    const hostAccess = fixture.viewModel.host_access;
    expect(
      selectedHostAccessSchema.parse({
        ...hostAccess,
        remote_ingress: null,
        access: "unpaired",
        device_id: null,
        reads_enabled: false,
        writes_enabled: false
      })
    ).toMatchObject({ access: "unpaired", reads_enabled: false, writes_enabled: false });
  });

  it("separates generic phone reachability from laptop-observed remote unavailability", () => {
    const unreachable = requireSurface(
      selectedMobileFixtureById("mission_control_remote_unreachable"),
      "mission_control"
    );
    expect(unreachable.viewModel.host_access).toMatchObject({
      client_connection: "unreachable",
      remote_ingress: null,
      access: "unknown",
      reads_enabled: false,
      writes_enabled: false
    });

    const unavailable = requireSurface(
      selectedMobileFixtureById("mission_control_remote_unavailable"),
      "mission_control"
    );
    expect(unavailable.viewModel.host_access).toMatchObject({
      client_connection: "reconnecting",
      remote_ingress: { availability: "unavailable", reason: "profile_other", laptop_action_required: true },
      access: "unknown",
      reads_enabled: false,
      writes_enabled: false
    });
  });

  it("rejects current remote authority with unavailable ingress or disconnected provenance", () => {
    const ready = requireSurface(selectedMobileFixtureById("mission_control_ready"), "mission_control").viewModel.host_access;
    const unavailable = requireSurface(
      selectedMobileFixtureById("mission_control_remote_unavailable"),
      "mission_control"
    ).viewModel.host_access.remote_ingress;

    expect(selectedHostAccessSchema.safeParse({ ...ready, remote_ingress: unavailable }).success).toBe(false);
    expect(selectedHostAccessSchema.safeParse({ ...ready, client_connection: "unreachable" }).success).toBe(false);
    expect(selectedHostAccessSchema.safeParse({ ...ready, app_authorization: "paired" }).success).toBe(false);
  });

  it("does not expose session data or enabled controls in inaccessible states", () => {
    for (const id of [
      "session_detail_loading",
      "session_detail_remote_unreachable",
      "session_detail_remote_unavailable",
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
    expect(keys).not.toContain("connection_mode");
    expect(keys).not.toContain("certificate_state");
    expect(keys).not.toContain("root_fingerprint_sha256");

    const values = collectStrings(selectedMobileStateFixtures);
    expect(values).not.toContain("certificate_error");
    expect(values).not.toContain("lan");
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

function collectStrings(value: unknown, strings: string[] = []): readonly string[] {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings);
    return strings;
  }
  if (value === null || typeof value !== "object") return strings;
  for (const child of Object.values(value)) collectStrings(child, strings);
  return strings;
}
