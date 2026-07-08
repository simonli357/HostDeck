import { describe, expect, it } from "vitest";
import {
  auditEventRecordSchema,
  authDeviceRecordSchema,
  defaultRetentionPolicy,
  outputEventRecordSchema,
  pairingCodeRecordSchema,
  retentionBoundaryRecordSchema,
  schemaMigrationRecordSchema,
  sessionMetadataRecordSchema,
  settingsRecordSchema,
  storageSessionRecordSchema
} from "./storage.js";

const sessionId = "sess_storage_01";
const timestamp = "2026-07-08T19:00:00.000Z";
const hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef";

const sessionRecord = {
  id: sessionId,
  name: "storage-demo",
  cwd: "/home/simonli/HostDeck",
  backend: {
    type: "tmux",
    tmux_session: "hostdeck-storage-demo",
    tmux_window: null,
    tmux_pane: "%1"
  },
  lifecycle_state: "running",
  created_at: timestamp,
  updated_at: timestamp,
  stale_reason: null
};

describe("storage session and migration schemas", () => {
  it("validates migration, session, and metadata records", () => {
    expect(
      schemaMigrationRecordSchema.parse({
        version: "20260708190000_initial",
        applied_at: timestamp,
        checksum: "0123456789abcdef0123456789abcdef"
      }).version
    ).toBe("20260708190000_initial");

    expect(storageSessionRecordSchema.parse(sessionRecord).id).toBe(sessionId);

    expect(
      sessionMetadataRecordSchema.parse({
        session_id: sessionId,
        branch: "main",
        last_activity_at: timestamp,
        status: "waiting_for_user",
        attention: "needs_input",
        summary: "Waiting for confirmation.",
        last_output_cursor: 42,
        updated_at: timestamp
      }).last_output_cursor
    ).toBe(42);
  });

  it("rejects malformed session records and stale-state drift", () => {
    expect(() =>
      storageSessionRecordSchema.parse({
        ...sessionRecord,
        id: "bad"
      })
    ).toThrow();

    expect(() =>
      storageSessionRecordSchema.parse({
        ...sessionRecord,
        lifecycle_state: "stale",
        stale_reason: null
      })
    ).toThrow();

    expect(() =>
      storageSessionRecordSchema.parse({
        ...sessionRecord,
        stale_reason: "target missing"
      })
    ).toThrow();
  });
});

describe("output cursor and retention schemas", () => {
  it("validates output events, replay boundaries, and retention records", () => {
    expect(
      outputEventRecordSchema.parse({
        session_id: sessionId,
        cursor: 1,
        order: 0,
        captured_at: timestamp,
        kind: "output",
        payload: "hello",
        truncated_before: null
      }).cursor
    ).toBe(1);

    expect(
      outputEventRecordSchema.parse({
        session_id: sessionId,
        cursor: 50,
        order: 49,
        captured_at: timestamp,
        kind: "replay_boundary",
        payload: null,
        truncated_before: 20
      }).kind
    ).toBe("replay_boundary");

    expect(
      retentionBoundaryRecordSchema.parse({
        id: "retention_01",
        scope: "output",
        session_id: sessionId,
        reason: "event_limit",
        truncated_before_cursor: 20,
        truncated_before_at: timestamp,
        retained_record_count: 10_000,
        applied_at: timestamp
      }).scope
    ).toBe("output");
  });

  it("rejects unbounded or incoherent output retention records", () => {
    expect(() =>
      outputEventRecordSchema.parse({
        session_id: sessionId,
        cursor: -1,
        order: 0,
        captured_at: timestamp,
        kind: "output",
        payload: "bad cursor",
        truncated_before: null
      })
    ).toThrow();

    expect(() =>
      outputEventRecordSchema.parse({
        session_id: sessionId,
        cursor: 1,
        order: 0,
        captured_at: timestamp,
        kind: "output",
        payload: null,
        truncated_before: null
      })
    ).toThrow();

    expect(() =>
      retentionBoundaryRecordSchema.parse({
        id: "retention_bad",
        scope: "output",
        session_id: null,
        reason: "event_limit",
        truncated_before_cursor: null,
        truncated_before_at: timestamp,
        retained_record_count: 10,
        applied_at: timestamp
      })
    ).toThrow();
  });
});

describe("auth, pairing, and settings schemas", () => {
  it("validates hashed auth records, one-time pairing records, and local settings", () => {
    expect(
      authDeviceRecordSchema.parse({
        id: "client_phone",
        token_hash: hash,
        client_label: "phone",
        permission: "write",
        created_at: timestamp,
        last_used_at: null,
        expires_at: null,
        revoked_at: null
      }).permission
    ).toBe("write");

    expect(
      pairingCodeRecordSchema.parse({
        id: "pair_01",
        code_hash: hash,
        permission: "write",
        client_label: null,
        created_at: timestamp,
        expires_at: "2026-07-08T19:05:00.000Z",
        used_at: null
      }).id
    ).toBe("pair_01");

    expect(
      settingsRecordSchema.parse({
        id: "hostdeck_settings",
        schema_version: 1,
        state_dir: "/home/simonli/.local/state/hostdeck",
        bind_mode: "localhost",
        bind_host: "127.0.0.1",
        bind_port: 3777,
        lan_enabled: false,
        locked: false,
        retention: defaultRetentionPolicy,
        updated_at: timestamp
      }).bind_port
    ).toBe(3777);
  });

  it("rejects raw secrets and invalid config values", () => {
    expect(() =>
      authDeviceRecordSchema.parse({
        id: "client_phone",
        token_hash: hash,
        raw_token: "secret",
        client_label: "phone",
        permission: "write",
        created_at: timestamp,
        last_used_at: null,
        expires_at: null,
        revoked_at: null
      })
    ).toThrow();

    expect(() =>
      pairingCodeRecordSchema.parse({
        id: "pair_01",
        code_hash: hash,
        code: "123456",
        permission: "write",
        client_label: null,
        created_at: timestamp,
        expires_at: "2026-07-08T19:05:00.000Z",
        used_at: null
      })
    ).toThrow();

    expect(() =>
      settingsRecordSchema.parse({
        id: "hostdeck_settings",
        schema_version: 1,
        state_dir: "/home/simonli/.local/state/hostdeck",
        bind_mode: "localhost",
        bind_host: "127.0.0.1",
        bind_port: 0,
        lan_enabled: false,
        locked: false,
        retention: defaultRetentionPolicy,
        updated_at: timestamp
      })
    ).toThrow();

    expect(() =>
      settingsRecordSchema.parse({
        id: "hostdeck_settings",
        schema_version: 1,
        state_dir: "/home/simonli/.local/state/hostdeck",
        bind_mode: "lan",
        bind_host: "0.0.0.0",
        bind_port: 3777,
        lan_enabled: false,
        locked: false,
        retention: defaultRetentionPolicy,
        updated_at: timestamp
      })
    ).toThrow();
  });
});

describe("audit event schema", () => {
  it("validates bounded audit events for writes and risky actions", () => {
    expect(
      auditEventRecordSchema.parse({
        id: "audit_01",
        at: timestamp,
        actor: {
          type: "dashboard",
          client_id: "client_phone",
          permission: "write"
        },
        action: "prompt",
        session_id: sessionId,
        payload_summary: {
          text_preview: "Continue",
          text_length: 8
        },
        result: "accepted",
        error_code: null
      }).action
    ).toBe("prompt");

    expect(
      auditEventRecordSchema.parse({
        id: "audit_02",
        at: timestamp,
        actor: {
          type: "cli",
          client_id: null,
          permission: "write"
        },
        action: "raw_input",
        session_id: sessionId,
        payload_summary: {
          confirmed: true
        },
        result: "failed",
        error_code: "audit_unavailable"
      }).result
    ).toBe("failed");
  });

  it("rejects sensitive, nested, unbounded, or incoherent audit payloads", () => {
    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_secret",
        at: timestamp,
        actor: {
          type: "dashboard",
          client_id: "client_phone",
          permission: "write"
        },
        action: "prompt",
        session_id: sessionId,
        payload_summary: {
          auth_token: "secret"
        },
        result: "accepted",
        error_code: null
      })
    ).toThrow();

    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_nested",
        at: timestamp,
        actor: {
          type: "dashboard",
          client_id: "client_phone",
          permission: "write"
        },
        action: "prompt",
        session_id: sessionId,
        payload_summary: {
          nested: {
            value: true
          }
        },
        result: "accepted",
        error_code: null
      })
    ).toThrow();

    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_error_relation",
        at: timestamp,
        actor: {
          type: "dashboard",
          client_id: "client_phone",
          permission: "write"
        },
        action: "prompt",
        session_id: sessionId,
        payload_summary: {},
        result: "accepted",
        error_code: "validation_error"
      })
    ).toThrow();

    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_dashboard_identity",
        at: timestamp,
        actor: {
          type: "dashboard",
          client_id: null,
          permission: "write"
        },
        action: "prompt",
        session_id: sessionId,
        payload_summary: {},
        result: "accepted",
        error_code: null
      })
    ).toThrow();

    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_missing_session",
        at: timestamp,
        actor: {
          type: "dashboard",
          client_id: "client_phone",
          permission: "write"
        },
        action: "slash",
        session_id: null,
        payload_summary: {
          command: "/plan"
        },
        result: "accepted",
        error_code: null
      })
    ).toThrow();

    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_system_identity",
        at: timestamp,
        actor: {
          type: "system",
          client_id: "client_phone",
          permission: null
        },
        action: "lock",
        session_id: null,
        payload_summary: {},
        result: "accepted",
        error_code: null
      })
    ).toThrow();
  });
});
