import {
  historicalSelectedNetworkAuditActions,
  persistedSelectedAuditActions,
  selectedAuditActions,
  selectedSecurityAuditActions,
  selectedSecurityAuditV1Actions
} from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  selectedAuditActorSchema,
  selectedAuditEventRecordSchema,
  selectedAuditOriginSchema,
  selectedSecurityAuditEventRecordSchema,
  selectedSecurityAuditV1EventRecordSchema
} from "./selected-storage.js";

const acceptedAt = "2026-07-11T20:00:00.000Z";
const terminalAt = "2026-07-11T20:01:00.000Z";

describe("selected security audit contracts", () => {
  it("freezes an 18-action selected catalog and a separate preserved version-1 catalog", () => {
    expect(selectedAuditActions).toHaveLength(18);
    expect(new Set(selectedAuditActions).size).toBe(18);
    expect(selectedSecurityAuditActions).toEqual([
      "pair_request",
      "pair_claim",
      "csrf_bootstrap",
      "device_revoke",
      "lock",
      "unlock",
      "remote_enable",
      "remote_disable"
    ]);
    expect(selectedSecurityAuditV1Actions).toEqual([
      "pair_request",
      "pair_claim",
      "csrf_bootstrap",
      "device_revoke",
      "lock",
      "unlock",
      "lan_configure",
      "lan_enable",
      "lan_disable",
      "certificate_rotate"
    ]);
    expect(historicalSelectedNetworkAuditActions).toEqual([
      "lan_configure",
      "lan_enable",
      "lan_disable",
      "certificate_rotate"
    ]);
    expect(new Set(selectedSecurityAuditActions).size).toBe(8);
    expect(new Set(persistedSelectedAuditActions).size).toBe(22);
    for (const action of selectedSecurityAuditActions) expect(selectedAuditActions).toContain(action);
    for (const action of historicalSelectedNetworkAuditActions) expect(selectedAuditActions).not.toContain(action);
  });

  it("accepts exact versioned intent and success summaries for every security action", () => {
    for (const candidate of acceptedRecords()) {
      expect(selectedSecurityAuditEventRecordSchema.parse(candidate)).toEqual(candidate);
    }
    for (const candidate of succeededRecords()) {
      expect(selectedSecurityAuditEventRecordSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("records claim permission only after the pairing code proves it", () => {
    const accepted = acceptedRecord("pair_claim", pairingActor(), hostTarget(), {
      schema_version: 1,
      client_label_present: true
    });
    expect(selectedSecurityAuditEventRecordSchema.parse(accepted)).toEqual(accepted);
    expect(() =>
      selectedSecurityAuditEventRecordSchema.parse(
        terminalRecord("pair_claim", pairingActor(), hostTarget(), "succeeded", null, {
          schema_version: 1,
          device_created: true,
          device_id: "client_security_created"
        })
      )
    ).toThrow();
  });

  it("admits read-only CSRF bootstrap for the same device but no other read-only security mutation", () => {
    expect(
      selectedSecurityAuditEventRecordSchema.parse(
        acceptedRecord("csrf_bootstrap", dashboardActor("read"), deviceTarget("client_security_phone"), {
          schema_version: 1,
          csrf_generation_before: 1
        })
      ).actor.permission
    ).toBe("read");

    for (const [action, target, summary] of [
      ["device_revoke", deviceTarget("client_security_other"), { schema_version: 1, previously_revoked: false }],
      ["lock", hostTarget(), { schema_version: 1, requested_locked: true }]
    ] as const) {
      expect(() =>
        selectedSecurityAuditEventRecordSchema.parse(acceptedRecord(action, dashboardActor("read"), target, summary))
      ).toThrow();
    }
  });

  it("requires truthful action-specific actors, canonical origins, and exact targets", () => {
    const maximumHost = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    const maximumTrustOrigin = `https://${maximumHost}`;
    expect(maximumTrustOrigin.length).toBeGreaterThan(253);
    expect(selectedAuditOriginSchema.parse(maximumTrustOrigin)).toBe(maximumTrustOrigin);
    expect(
      selectedAuditActorSchema.parse({
        type: "pairing_client",
        device_id: null,
        permission: null,
        origin: "https://hostdeck.local"
      }).type
    ).toBe("pairing_client");
    expect(() =>
      selectedAuditEventRecordSchema.parse(
        acceptedRecord("prompt", pairingActor(), {
          type: "managed_session",
          session_id: "sess_security_actor",
          codex_thread_id: "thread-security-actor"
        }, {})
      )
    ).toThrow();
    for (const origin of [
      "https://hostdeck.local/",
      "https://user@hostdeck.local",
      "https://hostdeck.local/path",
      "ftp://hostdeck.local",
      "not-an-origin"
    ]) {
      expect(() => selectedAuditOriginSchema.parse(origin)).toThrow();
    }

    const invalid = [
      acceptedRecord("pair_request", dashboardActor("write"), hostTarget(), pairRequestIntent()),
      acceptedRecord("pair_claim", systemActor(), hostTarget(), pairClaimIntent()),
      acceptedRecord("csrf_bootstrap", dashboardActor("write"), deviceTarget("client_security_other"), {
        schema_version: 1,
        csrf_generation_before: 1
      }),
      acceptedRecord("device_revoke", cliActor(), hostTarget(), { schema_version: 1, previously_revoked: false }),
      acceptedRecord("lock", systemActor(), hostTarget(), { schema_version: 1, requested_locked: true }),
      acceptedRecord("unlock", dashboardActor("write"), hostTarget(), { schema_version: 1, requested_locked: false }),
      acceptedRecord("remote_enable", dashboardActor("write"), hostTarget(), remoteAccepted("remote_enable")),
      acceptedRecord("remote_disable", cliActor(), deviceTarget("client_security_phone"), remoteAccepted("remote_disable"))
    ];
    for (const candidate of invalid) expect(() => selectedSecurityAuditEventRecordSchema.parse(candidate)).toThrow();
  });

  it("rejects missing intent/result fields, result claims on failure, and incoherent reconciliation", () => {
    for (const candidate of acceptedRecords()) {
      expect(() =>
        selectedSecurityAuditEventRecordSchema.parse({ ...candidate, payload_summary: { schema_version: 1 } })
      ).toThrow();
    }
    for (const candidate of succeededRecords()) {
      expect(() =>
        selectedSecurityAuditEventRecordSchema.parse({ ...candidate, payload_summary: { schema_version: 1 } })
      ).toThrow();
      expect(() =>
        selectedSecurityAuditEventRecordSchema.parse({
          ...candidate,
          outcome: "failed",
          error_code: "runtime_unavailable"
        })
      ).toThrow();
    }

    expect(() =>
      selectedSecurityAuditEventRecordSchema.parse(
        terminalRecord("lock", cliActor(), hostTarget(), "succeeded", null, {
          schema_version: 1,
          locked: true,
          reconciliation_reason: "host_restart_without_terminal"
        })
      )
    ).toThrow();
    expect(
      selectedSecurityAuditEventRecordSchema.parse(
        terminalRecord("lock", cliActor(), hostTarget(), "incomplete", "runtime_unavailable", {
          schema_version: 1,
          reconciliation_reason: "host_restart_without_terminal"
        })
      ).outcome
    ).toBe("incomplete");
  });

  it("rejects raw secrets, nested values, arbitrary text, and malformed bounded fields", () => {
    const rawSecrets = [
      { value: "pairing-code-secret-654321" },
      { detail: "device_bearer_secret_123456789" },
      { result: "csrf_raw_secret_123456789" },
      { material: "-----BEGIN PRIVATE KEY-----" },
      { payload: "-----BEGIN CERTIFICATE-----" },
      { nested: { cookie: "hostdeck_device=secret" } }
    ];
    for (const secret of rawSecrets) {
      expect(() =>
        selectedSecurityAuditEventRecordSchema.parse(
          acceptedRecord("pair_request", cliActor(), hostTarget(), { ...pairRequestIntent(), ...secret })
        )
      ).toThrow();
    }

    const malformed = [
      acceptedRecord("pair_request", cliActor(), hostTarget(), { ...pairRequestIntent(), schema_version: 2 }),
      acceptedRecord("pair_request", cliActor(), hostTarget(), { ...pairRequestIntent(), expires_at: "not-a-time" }),
      acceptedRecord("csrf_bootstrap", dashboardActor("write"), deviceTarget("client_security_phone"), {
        schema_version: 1,
        csrf_generation_before: Number.MAX_SAFE_INTEGER + 1
      }),
      acceptedRecord("lock", cliActor(), hostTarget(), { schema_version: 1, requested_locked: false }),
      acceptedRecord("remote_enable", cliActor(), hostTarget(), {
        ...remoteAccepted("remote_enable"),
        serve_state: "foreign"
      }),
      terminalRecord("pair_request", cliActor(), hostTarget(), "succeeded", null, {
        schema_version: 1,
        pairing_id: "pair id with spaces"
      }),
      terminalRecord("remote_disable", cliActor(), hostTarget(), "succeeded", null, {
        ...remoteSucceeded("remote_disable"),
        admission: "open"
      })
    ];
    for (const candidate of malformed) {
      expect(() => selectedSecurityAuditEventRecordSchema.parse(candidate)).toThrow();
    }
  });

  it("keeps legacy generic security rows readable while rejecting that shape for current writes", () => {
    const legacy = acceptedRecord("pair_request", cliActor(), hostTarget(), { legacy_note: "preserved" });
    expect(selectedAuditEventRecordSchema.parse(legacy).payload_summary).toEqual({ legacy_note: "preserved" });
    expect(() => selectedSecurityAuditEventRecordSchema.parse(legacy)).toThrow();

    for (const action of selectedSecurityAuditActions) {
      const rejected = terminalRecord(
        action,
        actorFor(action),
        targetFor(action),
        "rejected",
        "validation_error",
        rejectedSummary(action)
      );
      expect(selectedSecurityAuditEventRecordSchema.parse(rejected).outcome).toBe("rejected");
    }
  });

  it("keeps frozen version-1 LAN and certificate records readable but outside the selected write schema", () => {
    for (const candidate of historicalAcceptedRecords()) {
      expect(selectedSecurityAuditV1EventRecordSchema.parse(candidate)).toEqual(candidate);
      expect(selectedSecurityAuditEventRecordSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

function acceptedRecords(): readonly Readonly<Record<string, unknown>>[] {
  return [
    acceptedRecord("pair_request", cliActor(), hostTarget(), pairRequestIntent()),
    acceptedRecord("pair_claim", pairingActor(), hostTarget(), pairClaimIntent()),
    acceptedRecord("csrf_bootstrap", dashboardActor("write"), deviceTarget("client_security_phone"), {
      schema_version: 1,
      csrf_generation_before: 1
    }),
    acceptedRecord("device_revoke", dashboardActor("write"), deviceTarget("client_security_other"), {
      schema_version: 1,
      previously_revoked: false
    }),
    acceptedRecord("lock", dashboardActor("write"), hostTarget(), { schema_version: 1, requested_locked: true }),
    acceptedRecord("unlock", cliActor(), hostTarget(), { schema_version: 1, requested_locked: false }),
    acceptedRecord("remote_enable", cliActor(), hostTarget(), remoteAccepted("remote_enable")),
    acceptedRecord("remote_disable", cliActor(), hostTarget(), remoteAccepted("remote_disable"))
  ];
}

function succeededRecords(): readonly Readonly<Record<string, unknown>>[] {
  return [
    terminalRecord("pair_request", cliActor(), hostTarget(), "succeeded", null, {
      schema_version: 1,
      pairing_id: "pair_security_audit"
    }),
    terminalRecord("pair_claim", pairingActor(), hostTarget(), "succeeded", null, {
      schema_version: 1,
      permission: "write",
      device_created: true,
      device_id: "client_security_created"
    }),
    terminalRecord("csrf_bootstrap", dashboardActor("write"), deviceTarget("client_security_phone"), "succeeded", null, {
      schema_version: 1,
      csrf_generation_after: 2,
      rotated: true
    }),
    terminalRecord("device_revoke", dashboardActor("write"), deviceTarget("client_security_other"), "succeeded", null, {
      schema_version: 1,
      authority_invalidated: true
    }),
    terminalRecord("lock", dashboardActor("write"), hostTarget(), "succeeded", null, {
      schema_version: 1,
      locked: true
    }),
    terminalRecord("unlock", cliActor(), hostTarget(), "succeeded", null, { schema_version: 1, locked: false }),
    terminalRecord("remote_enable", cliActor(), hostTarget(), "succeeded", null, remoteSucceeded("remote_enable")),
    terminalRecord("remote_disable", cliActor(), hostTarget(), "succeeded", null, remoteSucceeded("remote_disable"))
  ];
}

function historicalAcceptedRecords(): readonly Readonly<Record<string, unknown>>[] {
  return [
    acceptedRecord("lan_configure", cliActor(), hostTarget(), {
      schema_version: 1,
      bind_address_family: "ipv4",
      bind_port: 3777,
      certificate_change_requested: true
    }),
    acceptedRecord("lan_enable", cliActor(), hostTarget(), { schema_version: 1, requested_lan_enabled: true }),
    acceptedRecord("lan_disable", cliActor(), hostTarget(), { schema_version: 1, requested_lan_enabled: false }),
    acceptedRecord("certificate_rotate", cliActor(), hostTarget(), { schema_version: 1, rotation_requested: true })
  ];
}

function remoteAccepted(action: "remote_disable" | "remote_enable") {
  return {
    schema_version: 1,
    action,
    requested_intent: action === "remote_enable" ? "enabled" : "disabled",
    profile_state: "dedicated",
    serve_state: action === "remote_enable" ? "absent" : "exact",
    phase: "accepted",
    outcome: "accepted"
  } as const;
}

function remoteSucceeded(action: "remote_disable" | "remote_enable") {
  return {
    schema_version: 1,
    action,
    requested_intent: action === "remote_enable" ? "enabled" : "disabled",
    profile_state: "dedicated",
    serve_state: action === "remote_enable" ? "exact" : "absent",
    phase: "terminal",
    outcome: "succeeded",
    admission: action === "remote_enable" ? "open" : "closed",
    intent_persisted: true,
    serve_result: action === "remote_enable" ? "applied" : "removed",
    reason: null
  } as const;
}

function rejectedSummary(action: (typeof selectedSecurityAuditActions)[number]) {
  if (action !== "remote_enable" && action !== "remote_disable") return { schema_version: 1 } as const;
  return {
    schema_version: 1,
    action,
    requested_intent: action === "remote_enable" ? "enabled" : "disabled",
    profile_state: "other",
    serve_state: null,
    phase: "terminal",
    outcome: "rejected",
    admission: "closed",
    intent_persisted: false,
    serve_result: "not_attempted",
    reason: "profile_other"
  } as const;
}

function acceptedRecord(action: string, actor: unknown, target: unknown, payload_summary: unknown) {
  return {
    id: `audit:security:${action}:accepted`,
    operation_id: `op_security_${action}`,
    at: acceptedAt,
    actor,
    action,
    target,
    phase: "accepted",
    outcome: "accepted",
    payload_summary,
    error_code: null
  };
}

function terminalRecord(
  action: string,
  actor: unknown,
  target: unknown,
  outcome: "failed" | "incomplete" | "rejected" | "succeeded",
  error_code: string | null,
  payload_summary: unknown
) {
  return {
    ...acceptedRecord(action, actor, target, payload_summary),
    id: `audit:security:${action}:${outcome}`,
    at: terminalAt,
    phase: "terminal",
    outcome,
    error_code
  };
}

function pairRequestIntent() {
  return {
    schema_version: 1,
    permission: "write",
    client_label_present: true,
    expires_at: "2026-07-11T20:10:00.000Z"
  } as const;
}

function pairClaimIntent() {
  return { schema_version: 1, client_label_present: true } as const;
}

function cliActor() {
  return { type: "cli", device_id: null, permission: "local_admin", origin: null } as const;
}

function dashboardActor(permission: "read" | "write") {
  return {
    type: "dashboard",
    device_id: "client_security_phone",
    permission,
    origin: "https://hostdeck.local"
  } as const;
}

function pairingActor() {
  return {
    type: "pairing_client",
    device_id: null,
    permission: null,
    origin: "https://hostdeck.local"
  } as const;
}

function systemActor() {
  return { type: "system", device_id: null, permission: null, origin: null } as const;
}

function hostTarget() {
  return { type: "host", host_id: "local_host" } as const;
}

function deviceTarget(device_id: string) {
  return { type: "device", device_id } as const;
}

function actorFor(action: (typeof selectedSecurityAuditActions)[number]) {
  if (action === "pair_claim") return pairingActor();
  if (action === "csrf_bootstrap") return dashboardActor("read");
  if (action === "device_revoke" || action === "lock") return dashboardActor("write");
  return cliActor();
}

function targetFor(action: (typeof selectedSecurityAuditActions)[number]) {
  if (action === "csrf_bootstrap") return deviceTarget("client_security_phone");
  if (action === "device_revoke") return deviceTarget("client_security_other");
  return hostTarget();
}
