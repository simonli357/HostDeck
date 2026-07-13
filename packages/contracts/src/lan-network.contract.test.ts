import { describe, expect, it } from "vitest";
import {
  canonicalIpHost,
  lanOrigin,
  selectedLanConfigureRequestSchema,
  selectedLanDisableRequestSchema,
  selectedLanEnableRequestSchema,
  selectedLanMutationResponseSchema,
  selectedNetworkStateResponseSchema
} from "./lan-network.js";

const configuredLoopbackState = {
  active_network_mode: "loopback" as const,
  active_transport: "http" as const,
  active_origin: "http://127.0.0.1:3777",
  desired_mode: "loopback" as const,
  lan_enabled: false,
  configured: true,
  bind_host: "192.168.0.29",
  bind_port: 3777,
  configured_origin: "https://192.168.0.29:3777",
  address_family: "ipv4" as const,
  certificate_state: "valid" as const,
  root_fingerprint_sha256: "a".repeat(64),
  leaf_fingerprint_sha256: "b".repeat(64),
  leaf_valid_from: "2026-07-12T00:00:00.000Z",
  leaf_expires_at: "2027-08-13T00:00:00.000Z",
  enrollment_available: true,
  can_manage_lan: true,
  restart_required: false
};

describe("selected LAN network contracts", () => {
  it("accepts exact mutation requests and canonical IPv4/IPv6 identities", () => {
    expect(
      selectedLanConfigureRequestSchema.parse({
        operation_id: "op_12345678",
        confirmed: true,
        bind_host: "192.168.0.29",
        bind_port: 3777,
        certificate_action: "issue_leaf"
      })
    ).toMatchObject({ bind_host: "192.168.0.29", certificate_action: "issue_leaf" });
    expect(
      selectedLanConfigureRequestSchema.parse({
        operation_id: "op_12345679",
        confirmed: true,
        bind_host: "fd00::29",
        bind_port: 8443,
        certificate_action: "reuse"
      })
    ).toMatchObject({ bind_host: "fd00::29" });
    expect(selectedLanEnableRequestSchema.parse({ operation_id: "op_12345680", confirmed: true })).toBeTruthy();
    expect(selectedLanDisableRequestSchema.parse({ operation_id: "op_12345681", confirmed: true })).toBeTruthy();
    expect(canonicalIpHost("192.168.0.29")).toBe("192.168.0.29");
    expect(canonicalIpHost("fd00::29")).toBe("fd00::29");
    expect(lanOrigin("fd00::29", 8443)).toBe("https://[fd00::29]:8443");
  });

  it("rejects malformed, noncanonical, inherited, accessor, and extra request state", () => {
    const valid = {
      operation_id: "op_12345678",
      confirmed: true,
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "reuse"
    };
    for (const candidate of [
      { ...valid, confirmed: false },
      { ...valid, operation_id: "request-1" },
      { ...valid, bind_host: "192.168.000.029" },
      { ...valid, bind_host: "FD00:0:0:0:0:0:0:29" },
      { ...valid, bind_host: "host.local" },
      { ...valid, bind_host: "[fd00::29]" },
      { ...valid, bind_port: 0 },
      { ...valid, certificate_action: "rotate_root" },
      { ...valid, origin: "https://192.168.0.29:3777" }
    ]) {
      expect(selectedLanConfigureRequestSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      selectedLanConfigureRequestSchema.safeParse(Object.create(valid)).success
    ).toBe(false);
    const accessor = Object.defineProperty({}, "operation_id", {
      enumerable: true,
      get: () => "op_12345678"
    });
    Object.assign(accessor, {
      confirmed: true,
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "reuse"
    });
    expect(selectedLanConfigureRequestSchema.safeParse(accessor).success).toBe(false);
  });

  it("accepts unconfigured, configured loopback, pending restart, and active LAN state", () => {
    expect(
      selectedNetworkStateResponseSchema.parse({
        ...configuredLoopbackState,
        configured: false,
        bind_host: null,
        bind_port: null,
        configured_origin: null,
        address_family: null,
        certificate_state: "not_configured",
        root_fingerprint_sha256: null,
        leaf_fingerprint_sha256: null,
        leaf_valid_from: null,
        leaf_expires_at: null,
        enrollment_available: false
      })
    ).toMatchObject({ configured: false, desired_mode: "loopback" });
    expect(selectedNetworkStateResponseSchema.parse(configuredLoopbackState)).toMatchObject({ restart_required: false });
    const pending = {
      ...configuredLoopbackState,
      desired_mode: "lan" as const,
      lan_enabled: true,
      restart_required: true
    };
    expect(selectedNetworkStateResponseSchema.parse(pending)).toMatchObject({ restart_required: true });
    expect(
      selectedNetworkStateResponseSchema.parse({
        ...pending,
        active_network_mode: "lan",
        active_transport: "https",
        active_origin: pending.configured_origin,
        can_manage_lan: false,
        restart_required: false
      })
    ).toMatchObject({ active_network_mode: "lan", restart_required: false });
  });

  it("rejects contradictory state, origin, certificate, chronology, and restart claims", () => {
    for (const candidate of [
      { ...configuredLoopbackState, lan_enabled: true },
      { ...configuredLoopbackState, desired_mode: "lan", lan_enabled: true, restart_required: false },
      { ...configuredLoopbackState, configured_origin: "https://192.168.0.30:3777" },
      { ...configuredLoopbackState, address_family: "ipv6" },
      { ...configuredLoopbackState, certificate_state: "not_configured" },
      { ...configuredLoopbackState, leaf_expires_at: configuredLoopbackState.leaf_valid_from },
      { ...configuredLoopbackState, active_origin: "http://127.0.0.1:3777/" },
      { ...configuredLoopbackState, active_network_mode: "lan", active_transport: "http" },
      { ...configuredLoopbackState, configured: false },
      { ...configuredLoopbackState, desired_mode: "lan", lan_enabled: true, configured: false, restart_required: true }
    ]) {
      expect(selectedNetworkStateResponseSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("requires mutation response state plus exact change flags", () => {
    expect(
      selectedLanMutationResponseSchema.parse({
        ...configuredLoopbackState,
        configuration_changed: true,
        desired_mode_changed: false
      })
    ).toMatchObject({ configuration_changed: true });
    expect(
      selectedLanMutationResponseSchema.safeParse({
        ...configuredLoopbackState,
        configuration_changed: true
      }).success
    ).toBe(false);
    expect(
      selectedLanMutationResponseSchema.safeParse({
        ...configuredLoopbackState,
        configuration_changed: true,
        desired_mode_changed: false,
        key: "secret"
      }).success
    ).toBe(false);
  });
});
