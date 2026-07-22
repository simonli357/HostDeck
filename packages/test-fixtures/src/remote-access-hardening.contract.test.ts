import { selectedHostAccessSchema, selectedSessionDetailViewModelSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { type SelectedMobileFixture, selectedMobileFixtureById } from "./structured-runtime.js";

describe("selected remote access hardening", () => {
  it("rejects non-ready current ingress, disconnected authority, and removed private fields", () => {
    const ready = mission("mission_control_ready").viewModel.host_access;
    const unavailable = mission("mission_control_remote_unavailable").viewModel.host_access.remote_ingress;

    expect(selectedHostAccessSchema.safeParse({ ...ready, remote_ingress: unavailable }).success).toBe(false);
    expect(selectedHostAccessSchema.safeParse({ ...ready, client_connection: "unreachable" }).success).toBe(false);
    for (const extra of [
      { ingress_provenance: { source_key: "private" } },
      { device_label: "Fixture phone" },
      { runtime: { state: "ready" } },
      { stream_state: "connected" },
      { remote_unlock_available: false },
      { remote_network_mutation_available: false }
    ]) {
      expect(selectedHostAccessSchema.safeParse({ ...ready, ...extra }).success).toBe(false);
    }
  });

  it("keeps loopback browser access read-only unless a paired cookie grants authority", () => {
    const remote = mission("mission_control_ready").viewModel.host_access;
    const local = {
      ...remote,
      origin: "http://127.0.0.1:3777",
      remote_ingress: null,
      access: "loopback_read",
      device_id: null,
      reads_enabled: true,
      writes_enabled: false
    };

    expect(selectedHostAccessSchema.parse(local)).toMatchObject({
      access: "loopback_read",
      writes_enabled: false
    });
    expect(
      selectedHostAccessSchema.safeParse({
        ...remote,
        access: "loopback_read",
        device_id: null,
        reads_enabled: true,
        writes_enabled: false
      }).success
    ).toBe(false);
    expect(
      selectedHostAccessSchema.safeParse({
        ...local,
        writes_enabled: true
      }).success
    ).toBe(false);
    expect(
      selectedHostAccessSchema.parse({
        ...local,
        access: "paired_write",
        device_id: "fixture-phone-001",
        writes_enabled: true
      })
    ).toMatchObject({ access: "paired_write", writes_enabled: true });
  });

  it("rejects contradictory client, retained-ingress, device, and object-shape state", () => {
    const ready = mission("mission_control_ready").viewModel.host_access;
    const unavailable = mission("mission_control_remote_unavailable").viewModel.host_access;
    const loading = mission("mission_control_loading").viewModel.host_access;

    expect(selectedHostAccessSchema.safeParse({ ...unavailable, client_connection: "unreachable" }).success).toBe(false);
    expect(selectedHostAccessSchema.safeParse({ ...loading, last_error: unavailable.last_error }).success).toBe(false);
    expect(
      selectedHostAccessSchema.parse({
        ...ready,
        access: "expired",
        device_id: null,
        reads_enabled: false,
        writes_enabled: false
      })
    ).toMatchObject({ access: "expired", device_id: null });
    expect(
      selectedHostAccessSchema.safeParse({
        ...ready,
        access: "expired",
        reads_enabled: false,
        writes_enabled: false
      }).success
    ).toBe(false);

    let getterCalls = 0;
    const accessor = { ...ready };
    Object.defineProperty(accessor, "access", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "paired_write";
      }
    });
    expect(selectedHostAccessSchema.safeParse(accessor).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("binds Session Detail data disclosure and stream state to current host access", () => {
    const ready = detail("session_detail_ready").viewModel;
    const deniedHost = mission("mission_control_permission_denied").viewModel.host_access;

    expect(selectedSessionDetailViewModelSchema.safeParse({ ...ready, stream_state: "disconnected" }).success).toBe(false);
    const deniedLoaded = selectedSessionDetailViewModelSchema.safeParse({ ...ready, host_access: deniedHost });
    expect(deniedLoaded.success).toBe(false);
    if (!deniedLoaded.success) {
      expect(deniedLoaded.error.issues.some((issue) => issue.message.includes("read authority"))).toBe(true);
    }

    const notFound = detail("session_detail_not_found").viewModel;
    const deniedNotFound = selectedSessionDetailViewModelSchema.safeParse({ ...notFound, host_access: deniedHost });
    expect(deniedNotFound.success).toBe(false);
    if (!deniedNotFound.success) {
      expect(deniedNotFound.error.issues.some((issue) => issue.message.includes("disclosing absence"))).toBe(true);
    }
  });
});

function mission(id: SelectedMobileFixture["id"]) {
  return requireSurface(selectedMobileFixtureById(id), "mission_control");
}

function detail(id: SelectedMobileFixture["id"]) {
  return requireSurface(selectedMobileFixtureById(id), "session_detail");
}

function requireSurface<T extends SelectedMobileFixture["surface"]>(
  fixture: SelectedMobileFixture,
  surface: T
): Extract<SelectedMobileFixture, { readonly surface: T }> {
  if (fixture.surface !== surface) throw new TypeError(`Expected ${surface} fixture, received ${fixture.surface}.`);
  return fixture as Extract<SelectedMobileFixture, { readonly surface: T }>;
}
