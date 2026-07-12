import { describe, expect, it } from "vitest";
import {
  selectedDeviceIdSchema,
  selectedDeviceRevocationResultSchema
} from "./device-revocation.js";
import { authDeviceRecordSchema } from "./storage.js";

const createdAt = "2026-07-11T20:00:00.000Z";
const laterAt = "2026-07-11T20:01:00.000Z";
const expiresAt = "2026-07-11T21:00:00.000Z";

describe("selected device revocation contracts", () => {
  it("accepts bounded storage ids and one exact minimal revocation result", () => {
    for (const deviceId of ["client_phone", "client.phone:01", "a", "x".repeat(120)]) {
      expect(selectedDeviceIdSchema.parse(deviceId)).toBe(deviceId);
    }
    for (const deviceId of ["", "client phone", "client/phone", "x".repeat(121), 1, null]) {
      expect(() => selectedDeviceIdSchema.parse(deviceId)).toThrow();
    }

    expect(
      selectedDeviceRevocationResultSchema.parse({
        deviceId: "client_phone",
        revokedAt: "2026-07-11T16:01:00.000-04:00",
        previouslyRevoked: false,
        authorityInvalidated: true
      })
    ).toEqual({
      deviceId: "client_phone",
      revokedAt: laterAt,
      previouslyRevoked: false,
      authorityInvalidated: true
    });
    for (const candidate of [
      {
        deviceId: "client_phone",
        revokedAt: laterAt,
        previouslyRevoked: false,
        authorityInvalidated: false
      },
      {
        deviceId: "client_phone",
        revokedAt: laterAt,
        authorityInvalidated: true
      },
      {
        deviceId: "client_phone",
        revokedAt: laterAt,
        previouslyRevoked: false,
        authorityInvalidated: true,
        token_hash: `sha256:${"a".repeat(64)}`
      }
    ]) {
      expect(() => selectedDeviceRevocationResultSchema.parse(candidate)).toThrow();
    }
  });

  it("accepts exact chronology boundaries and administrative revoke after expiry", () => {
    expect(
      authDeviceRecordSchema.parse({
        ...deviceRecord(),
        expires_at: createdAt,
        revoked_at: createdAt
      })
    ).toMatchObject({ expires_at: createdAt, revoked_at: createdAt });
    expect(
      authDeviceRecordSchema.parse({
        ...deviceRecord(),
        expires_at: expiresAt,
        csrf_rotated_at: expiresAt,
        revoked_at: expiresAt
      })
    ).toMatchObject({ csrf_rotated_at: expiresAt, revoked_at: expiresAt });
    expect(
      authDeviceRecordSchema.parse({
        ...deviceRecord(),
        expires_at: expiresAt,
        last_used_at: laterAt,
        revoked_at: laterAt
      })
    ).toMatchObject({ last_used_at: laterAt, revoked_at: laterAt });
    expect(
      authDeviceRecordSchema.parse({
        ...deviceRecord(),
        expires_at: laterAt,
        revoked_at: expiresAt
      }).revoked_at
    ).toBe(expiresAt);
  });

  it("rejects expiry, rotation, use, and revocation chronology contradictions", () => {
    const invalid = [
      { ...deviceRecord(), expires_at: "2026-07-11T19:59:59.999Z" },
      { ...deviceRecord(), csrf_rotated_at: "2026-07-11T19:59:59.999Z" },
      {
        ...deviceRecord(),
        expires_at: laterAt,
        csrf_rotated_at: "2026-07-11T20:01:00.001Z"
      },
      { ...deviceRecord(), last_used_at: "2026-07-11T19:59:59.999Z" },
      { ...deviceRecord(), expires_at: laterAt, last_used_at: laterAt },
      { ...deviceRecord(), revoked_at: "2026-07-11T19:59:59.999Z" },
      {
        ...deviceRecord(),
        csrf_rotated_at: laterAt,
        revoked_at: "2026-07-11T20:00:59.999Z"
      },
      {
        ...deviceRecord(),
        last_used_at: laterAt,
        revoked_at: "2026-07-11T20:00:59.999Z"
      },
      { ...deviceRecord(), extra: true }
    ];
    for (const candidate of invalid) expect(() => authDeviceRecordSchema.parse(candidate)).toThrow();
    const { revoked_at: _revokedAt, ...missingRevocation } = deviceRecord();
    expect(() => authDeviceRecordSchema.parse(missingRevocation)).toThrow();
  });
});

function deviceRecord() {
  return {
    id: "client_revoke_contract",
    token_hash: `sha256:${"a".repeat(64)}`,
    csrf_token_hash: `sha256:${"b".repeat(64)}`,
    csrf_generation: 1,
    csrf_rotated_at: createdAt,
    client_label: "Android phone",
    permission: "write" as const,
    created_at: createdAt,
    last_used_at: null,
    expires_at: null,
    revoked_at: null
  };
}
