import { describe, expect, it } from "vitest";
import {
  auditPayloadSummarySchema,
  authDeviceRecordSchema,
  defaultRetentionPolicy,
  pairingCodeRecordSchema,
  schemaMigrationRecordSchema,
  settingsRecordSchema
} from "./storage.js";

const timestamp = "2026-07-08T22:00:00.000Z";

describe("selected storage contracts", () => {
  it("validates migration and loopback-only settings records", () => {
    expect(
      schemaMigrationRecordSchema.parse({ version: "202607200001_selected", applied_at: timestamp }).version
    ).toBe("202607200001_selected");
    expect(
      settingsRecordSchema.parse({
        id: "hostdeck_settings",
        schema_version: 18,
        state_dir: "/tmp/hostdeck",
        bind_port: 3777,
        locked: false,
        retention: defaultRetentionPolicy,
        updated_at: timestamp
      })
    ).toMatchObject({ bind_port: 3777, locked: false });
  });

  it("rejects retired network settings and malformed selected settings", () => {
    expect(() =>
      settingsRecordSchema.parse({
        id: "hostdeck_settings",
        schema_version: 18,
        state_dir: "/tmp/hostdeck",
        bind_port: 3777,
        bind_mode: "lan",
        lan_enabled: true,
        locked: false,
        retention: defaultRetentionPolicy,
        updated_at: timestamp
      })
    ).toThrow();
    expect(() =>
      settingsRecordSchema.parse({
        id: "hostdeck_settings",
        schema_version: 18,
        state_dir: "relative",
        bind_port: 80,
        locked: false,
        retention: defaultRetentionPolicy,
        updated_at: timestamp
      })
    ).toThrow();
  });

  it("validates selected hashed device and pairing records", () => {
    expect(
      authDeviceRecordSchema.parse({
        id: "client_selected",
        token_hash: `sha256:${"1".repeat(64)}`,
        csrf_token_hash: `sha256:${"2".repeat(64)}`,
        csrf_generation: 1,
        csrf_rotated_at: timestamp,
        client_label: "Phone",
        permission: "write",
        created_at: timestamp,
        last_used_at: null,
        expires_at: null,
        revoked_at: null
      }).id
    ).toBe("client_selected");
    expect(
      pairingCodeRecordSchema.parse({
        id: "pair_selected",
        code_hash: `sha256:${"3".repeat(64)}`,
        permission: "write",
        client_label: "Phone",
        created_at: timestamp,
        expires_at: "2026-07-08T22:05:00.000Z",
        used_at: null,
        revoked_at: null,
        claim_contract_version: 1,
        claimed_device_id: null
      }).claim_contract_version
    ).toBe(1);
  });

  it("bounds and sanitizes shared audit summaries", () => {
    expect(auditPayloadSummarySchema.parse({ text_length: 8, action: "prompt" })).toEqual({
      text_length: 8,
      action: "prompt"
    });
    expect(() => auditPayloadSummarySchema.parse({ token: "secret" })).toThrow();
    expect(() => auditPayloadSummarySchema.parse({ nested: { value: true } })).toThrow();
    expect(() =>
      auditPayloadSummarySchema.parse(
        Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`field_${index}`, index]))
      )
    ).toThrow();
  });
});
