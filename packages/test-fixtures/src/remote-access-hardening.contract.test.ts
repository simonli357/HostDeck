import { selectedHostAccessSchema, selectedSessionDetailViewModelSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { type SelectedMobileFixture, selectedMobileFixtureById } from "./structured-runtime.js";

describe("selected remote access hardening", () => {
  it("rejects unavailable ingress, disconnected provenance, and stale admission generation", () => {
    const ready = mission("mission_control_ready").viewModel.host_access;
    const unavailable = mission("mission_control_remote_unavailable").viewModel.host_access.remote_ingress;

    expect(selectedHostAccessSchema.safeParse({ ...ready, remote_ingress: unavailable }).success).toBe(false);
    expect(selectedHostAccessSchema.safeParse({ ...ready, client_connection: "unreachable" }).success).toBe(false);
    expect(
      selectedHostAccessSchema.safeParse({
        ...ready,
        ingress_provenance: { ...ready.ingress_provenance, remote_generation: 6 }
      }).success
    ).toBe(false);
  });

  it("keeps loopback-local authority impossible to acquire through admitted remote ingress", () => {
    const remote = mission("mission_control_ready").viewModel.host_access;
    const local = {
      ...remote,
      origin: "http://127.0.0.1:3777",
      ingress_provenance: {
        kind: "local_loopback",
        transport: "loopback_http",
        origin: "http://127.0.0.1:3777",
        remote_generation: null,
        source_key: null,
        tailnet_identity_present: false,
        app_authorization: "not_evaluated"
      },
      access: "loopback_local",
      device_id: null,
      device_label: null
    };

    expect(selectedHostAccessSchema.parse(local)).toMatchObject({
      ingress_provenance: { kind: "local_loopback" },
      access: "loopback_local"
    });
    expect(
      selectedHostAccessSchema.safeParse({ ...remote, access: "loopback_local", device_id: null, device_label: null }).success
    ).toBe(false);
    expect(
      selectedHostAccessSchema.safeParse({
        ...local,
        access: "paired_write",
        device_id: "fixture-phone-001",
        device_label: "Fixture phone"
      }).success
    ).toBe(false);
  });

  it("does not derive app authority from optional tailnet identity", () => {
    const ready = mission("mission_control_ready").viewModel.host_access;
    expect(
      selectedHostAccessSchema.parse({
        ...ready,
        ingress_provenance: { ...ready.ingress_provenance, tailnet_identity_present: true },
        access: "unpaired",
        device_id: null,
        device_label: null,
        runtime: null,
        reads_enabled: false,
        writes_enabled: false
      })
    ).toMatchObject({ access: "unpaired", reads_enabled: false, writes_enabled: false });
  });

  it("rejects contradictory client, stream, retained-ingress, device, and object-shape state", () => {
    const ready = mission("mission_control_ready").viewModel.host_access;
    const unavailable = mission("mission_control_remote_unavailable").viewModel.host_access;
    const loading = mission("mission_control_loading").viewModel.host_access;

    expect(selectedHostAccessSchema.safeParse({ ...unavailable, client_connection: "unreachable" }).success).toBe(false);
    expect(selectedHostAccessSchema.safeParse({ ...unavailable, stream_state: "connected" }).success).toBe(false);
    expect(selectedHostAccessSchema.safeParse({ ...loading, last_error: unavailable.last_error }).success).toBe(false);
    expect(
      selectedHostAccessSchema.safeParse({
        ...ready,
        access: "expired",
        device_label: null,
        runtime: null,
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
