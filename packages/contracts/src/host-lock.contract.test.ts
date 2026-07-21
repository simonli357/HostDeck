import { describe, expect, it } from "vitest";
import {
  selectedAccessStateResponseSchema,
  selectedHostLockRequestSchema,
  selectedHostLockStateResponseSchema,
  selectedHostUnlockRequestSchema
} from "./host-lock.js";

const localAdminState = {
  authentication_state: "local_admin",
  device_id: null,
  permission: "local_admin",
  device_expires_at: null,
  configured_origin: "http://127.0.0.1:3777",
  network_mode: "loopback",
  transport: "http",
  locked: false,
  can_read_sessions: true,
  can_write_sessions: true,
  can_lock: true,
  can_unlock: true
} as const;

describe("selected host lock contracts", () => {
  it("keeps lock and unlock confirmation contracts strict and distinct", () => {
    const request = {
      operation_id: "op_host_lock_contract_01",
      confirmed: true
    } as const;
    expect(selectedHostLockRequestSchema.parse(request)).toEqual(request);
    expect(selectedHostUnlockRequestSchema.parse(request)).toEqual(request);
    expect(selectedHostLockRequestSchema).not.toBe(
      selectedHostUnlockRequestSchema
    );

    for (const candidate of [
      {},
      { operation_id: request.operation_id },
      { ...request, confirmed: false },
      { ...request, extra: true },
      { ...request, operation_id: "bad" }
    ]) {
      expect(selectedHostLockRequestSchema.safeParse(candidate).success).toBe(
        false
      );
      expect(selectedHostUnlockRequestSchema.safeParse(candidate).success).toBe(
        false
      );
    }
  });

  it("derives local-admin, paired, unpaired, and locked capabilities exactly", () => {
    const pairedWriter = {
      ...localAdminState,
      authentication_state: "paired_device",
      device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      device_expires_at: "2026-10-10T20:00:00.000Z",
      configured_origin: "http://127.0.0.1:3777",
      network_mode: "loopback",
      transport: "http",
      can_unlock: false
    } as const;
    const lockedWriter = {
      ...pairedWriter,
      locked: true,
      can_write_sessions: false
    } as const;
    const readOnly = {
      ...pairedWriter,
      permission: "read",
      can_write_sessions: false,
      can_lock: false
    } as const;
    const remoteWriter = {
      ...pairedWriter,
      configured_origin: "https://hostdeck-fixture.fixture-tailnet.ts.net",
      network_mode: "remote",
      transport: "https"
    } as const;
    const unpairedLoopback = {
      ...localAdminState,
      authentication_state: "unpaired",
      permission: null,
      can_write_sessions: false,
      can_lock: false,
      can_unlock: false
    } as const;
    const invalidLoopback = {
      ...unpairedLoopback,
      authentication_state: "invalid_device",
      can_read_sessions: false
    } as const;
    const unpairedRemote = {
      ...remoteWriter,
      authentication_state: "unpaired",
      device_id: null,
      permission: null,
      device_expires_at: null,
      can_read_sessions: false,
      can_write_sessions: false,
      can_lock: false
    } as const;

    for (const state of [
      localAdminState,
      pairedWriter,
      lockedWriter,
      readOnly,
      remoteWriter,
      unpairedLoopback,
      invalidLoopback,
      unpairedRemote
    ]) {
      expect(selectedAccessStateResponseSchema.parse(state)).toEqual(state);
      expect(selectedHostLockStateResponseSchema.parse(state)).toEqual(state);
    }
    expect(selectedAccessStateResponseSchema).not.toBe(
      selectedHostLockStateResponseSchema
    );
  });

  it("rejects contradictory authority, capability, transport, and secret fields", () => {
    const candidates = [
      { ...localAdminState, device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX" },
      { ...localAdminState, can_unlock: false },
      { ...localAdminState, locked: true, can_write_sessions: true },
      {
        ...localAdminState,
        authentication_state: "paired_device",
        permission: "write",
        device_id: null,
        can_unlock: false
      },
      {
        ...localAdminState,
        configured_origin: "https://example.test",
        network_mode: "lan",
        transport: "https"
      },
      { ...localAdminState, transport: "https" },
      { ...localAdminState, configured_origin: "http://localhost:3777" },
      {
        ...localAdminState,
        configured_origin: "https://hostdeck-fixture.fixture-tailnet.ts.net",
        network_mode: "remote",
        transport: "https"
      },
      {
        ...localAdminState,
        authentication_state: "unpaired",
        permission: null,
        configured_origin: "http://127.0.0.1:3777",
        network_mode: "remote"
      },
      {
        ...localAdminState,
        authentication_state: "unpaired",
        permission: null,
        configured_origin: "https://example.test",
        network_mode: "remote",
        transport: "https"
      },
      { ...localAdminState, configured_origin: "http://127.0.0.1:3777/" },
      { ...localAdminState, csrf_generation: 2 },
      { ...localAdminState, raw_csrf_token: "private" }
    ];
    for (const candidate of candidates) {
      expect(selectedAccessStateResponseSchema.safeParse(candidate).success).toBe(
        false
      );
      expect(
        selectedHostLockStateResponseSchema.safeParse(candidate).success
      ).toBe(false);
    }
  });
});
