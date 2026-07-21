import { describe, expect, it } from "vitest";
import { selectedRawDeviceSecretSchema } from "./pairing.js";
import {
  selectedRequestAuthenticationContextSchema,
  selectedRequestAuthenticationIngressContextSchema,
  selectedRequestAuthenticationStates,
  selectedRequestNetworkModes
} from "./request-authentication.js";

const origin = "http://127.0.0.1:3777";
const remoteOrigin = "https://hostdeck-fixture.fixture-tailnet.ts.net";
const sourceKey = `sha256:${"a".repeat(64)}`;

describe("selected request authentication contracts", () => {
  it("requires one exact 43-character unpadded base64url device secret", () => {
    const valid = ["A".repeat(43), `${"a0_-".repeat(10)}abc`];
    for (const candidate of valid) {
      expect(selectedRawDeviceSecretSchema.parse(candidate)).toBe(candidate);
    }
    for (const candidate of [
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}%`,
      `${"A".repeat(42)} `,
      `${"A".repeat(42)}\u00e9`,
      null,
      undefined
    ]) {
      expect(() => selectedRawDeviceSecretSchema.parse(candidate)).toThrow();
    }
  });

  it("accepts exact local-admin, unpaired, and credential-failure contexts", () => {
    expect(selectedRequestAuthenticationStates).toEqual([
      "local_admin",
      "unpaired",
      "invalid_device",
      "expired_device",
      "revoked_device",
      "paired_device"
    ]);
    expect(selectedRequestNetworkModes).toEqual(["loopback", "remote"]);
    expect(
      selectedRequestAuthenticationContextSchema.parse({
        ...emptyContext("local_admin"),
        origin_kind: "local_non_browser",
        permission: "local_admin"
      })
    ).toMatchObject({ state: "local_admin", permission: "local_admin" });
    for (const state of [
      "unpaired",
      "invalid_device",
      "expired_device",
      "revoked_device"
    ] as const) {
      expect(selectedRequestAuthenticationContextSchema.parse(emptyContext(state))).toEqual(
        emptyContext(state)
      );
    }
  });

  it("accepts complete paired read/write metadata and canonicalizes timestamps", () => {
    for (const permission of ["read", "write"] as const) {
      expect(
        selectedRequestAuthenticationContextSchema.parse({
          ...emptyContext("paired_device"),
          device_id: `client_contract_${permission}`,
          permission,
          csrf_generation: 2,
          last_used_at: "2026-07-11T16:01:00.000-04:00",
          expires_at: "2026-07-11T17:00:00.000-04:00"
        })
      ).toMatchObject({
        state: "paired_device",
        device_id: `client_contract_${permission}`,
        permission,
        csrf_generation: 2,
        last_used_at: "2026-07-11T20:01:00.000Z",
        expires_at: "2026-07-11T21:00:00.000Z"
      });
    }
  });

  it("keeps selected remote ingress strict and private from public authentication", () => {
    const localIngress = {
      configured_origin: "http://127.0.0.1:3777",
      network_mode: "loopback",
      origin_kind: "local_non_browser",
      transport: "http",
      source_key: null,
      remote_generation: null
    } as const;
    const remoteIngress = {
      configured_origin: remoteOrigin,
      network_mode: "remote",
      origin_kind: "same_origin",
      transport: "https",
      source_key: sourceKey,
      remote_generation: 7
    } as const;
    expect(selectedRequestAuthenticationIngressContextSchema.parse(localIngress)).toEqual(
      localIngress
    );
    expect(selectedRequestAuthenticationIngressContextSchema.parse(remoteIngress)).toEqual(
      remoteIngress
    );
    expect(
      selectedRequestAuthenticationIngressContextSchema.parse({
        ...remoteIngress,
        origin_kind: "safe_no_origin"
      })
    ).toMatchObject({ network_mode: "remote", remote_generation: 7 });

    for (const candidate of [
      { ...remoteIngress, transport: "http" },
      { ...remoteIngress, configured_origin: remoteOrigin.replace("https:", "http:") },
      { ...remoteIngress, configured_origin: "https://example.test" },
      { ...remoteIngress, origin_kind: "local_non_browser" },
      { ...remoteIngress, source_key: null },
      { ...remoteIngress, remote_generation: null },
      { ...remoteIngress, remote_generation: -1 },
      { ...localIngress, remote_generation: 1 },
      { ...localIngress, source_key: sourceKey },
      { ...localIngress, transport: "https" },
      { ...localIngress, configured_origin: "http://localhost:3777" },
      { ...localIngress, network_mode: "lan" },
      { ...remoteIngress, tailnet_identity_present: true }
    ]) {
      expect(
        selectedRequestAuthenticationIngressContextSchema.safeParse(candidate).success
      ).toBe(false);
    }

    const remoteAuthentication = {
      ...emptyContext("unpaired"),
      configured_origin: remoteOrigin,
      network_mode: "remote",
      origin_kind: "safe_no_origin",
      transport: "https"
    } as const;
    expect(selectedRequestAuthenticationContextSchema.parse(remoteAuthentication)).toEqual(
      remoteAuthentication
    );
    for (const candidate of [
      { ...remoteAuthentication, transport: "http" },
      { ...remoteAuthentication, origin_kind: "local_non_browser" },
      { ...remoteAuthentication, state: "local_admin", permission: "local_admin" },
      { ...remoteAuthentication, source_key: sourceKey },
      { ...remoteAuthentication, remote_generation: 7 },
      { ...remoteAuthentication, tailnet_identity_present: false }
    ]) {
      expect(selectedRequestAuthenticationContextSchema.safeParse(candidate).success).toBe(
        false
      );
    }
  });

  it("rejects contradictory authority, chronology, secret fields, and unknown keys", () => {
    const paired = {
      ...emptyContext("paired_device"),
      device_id: "client_contract_write",
      permission: "write",
      csrf_generation: 1,
      last_used_at: "2026-07-11T20:01:00.000Z",
      expires_at: "2026-07-11T21:00:00.000Z"
    } as const;
    const invalid = [
      { ...emptyContext("local_admin"), permission: "local_admin" },
      { ...emptyContext("local_admin"), origin_kind: "local_non_browser" },
      {
        ...emptyContext("local_admin"),
        origin_kind: "local_non_browser",
        permission: "local_admin",
        device_id: "client_forbidden"
      },
      { ...paired, device_id: null },
      { ...paired, device_id: "client with spaces" },
      { ...paired, permission: "local_admin" },
      { ...paired, csrf_generation: 0 },
      { ...paired, last_used_at: null },
      { ...paired, last_used_at: paired.expires_at },
      { ...emptyContext("unpaired"), permission: "read" },
      { ...emptyContext("invalid_device"), csrf_generation: 1 },
      { ...emptyContext("expired_device"), expires_at: paired.expires_at },
      { ...emptyContext("revoked_device"), device_id: "client_private" },
      { ...paired, rawDeviceToken: "private" },
      { ...paired, token_hash: "private" },
      { ...paired, csrf_token_hash: "private" },
      { ...paired, cookie: "private" },
      { ...paired, state: "unknown" },
      { ...paired, configured_origin: "not-an-origin" },
      { ...paired, configured_origin: `${origin}/path` },
      { ...paired, configured_origin: origin.replace("http:", "https:") },
      { ...paired, transport: "https" },
      { ...paired, network_mode: "lan" }
    ];
    for (const candidate of invalid) {
      expect(() => selectedRequestAuthenticationContextSchema.parse(candidate)).toThrow();
    }
  });
});

function emptyContext(
  state:
    | "local_admin"
    | "unpaired"
    | "invalid_device"
    | "expired_device"
    | "revoked_device"
    | "paired_device"
) {
  return {
    state,
    configured_origin: origin,
    network_mode: "loopback" as const,
    origin_kind: "same_origin" as const,
    transport: "http" as const,
    device_id: null,
    permission: null,
    csrf_generation: null,
    last_used_at: null,
    expires_at: null
  };
}
