import { describe, expect, it } from "vitest";
import { selectedRawDeviceSecretSchema } from "./pairing.js";
import {
  selectedRequestAuthenticationContextSchema,
  selectedRequestAuthenticationStates
} from "./request-authentication.js";

const origin = "https://192.168.0.29:8443";

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
      { ...paired, configured_origin: origin.replace("https:", "http:") },
      { ...paired, transport: "http" }
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
    network_mode: "lan" as const,
    origin_kind: "same_origin" as const,
    transport: "https" as const,
    device_id: null,
    permission: null,
    csrf_generation: null,
    last_used_at: null,
    expires_at: null
  };
}
