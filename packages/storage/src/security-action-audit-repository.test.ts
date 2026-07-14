import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { defaultRetentionPolicy, selectedSecurityAuditEventRecordSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createHistoricalSelectedNetworkAuditRepository,
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  maintainSelectedAuditRetentionBatch,
  reconcileSelectedAuditOrphansBatch,
  type SelectedAuditRepositoryErrorCode
} from "./selected-audit-repository.js";

const tempDirs: string[] = [];
const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve("better-sqlite3");
const acceptedAt = "2026-07-11T20:00:00.000Z";
const terminalAt = "2026-07-11T20:01:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected security action audit repository", () => {
  it("persists and reopens exact accepted-to-succeeded trails for all eight selected security actions", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const operationIds: string[] = [];
    try {
      const repository = createSelectedAuditRepository(first.db);
      for (const [index, definition] of securityCases().entries()) {
        const operationId = operationIdFor(index);
        operationIds.push(operationId);
        const accepted = repository.recordAccepted(acceptedRecord(definition, index));
        expect(accepted).toMatchObject({ operation_id: operationId, state: "pending" });
        const terminal = repository.recordTerminal(succeededRecord(definition, index));
        expect(terminal).toMatchObject({ operation_id: operationId, state: "terminal" });
        expect(terminal.records.map((record) => record.outcome)).toEqual(["accepted", "succeeded"]);
        expect(terminal.records[0]).toMatchObject({ actor: definition.actor, action: definition.action, target: definition.target });
        expect(terminal.records[1]).toMatchObject({ actor: definition.actor, action: definition.action, target: definition.target });
      }
      expect(first.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 16 });
      const storedJson = first.db.prepare("SELECT record_json FROM selected_audit_events").all() as Array<{
        readonly record_json: string;
      }>;
      expect(storedJson.every(({ record_json }) => record_json.includes('"schema_version":1'))).toBe(true);
      expect(
        first.db.prepare("SELECT DISTINCT security_schema_version FROM selected_audit_events").all()
      ).toEqual([{ security_schema_version: 2 }]);
    } finally {
      first.db.close();
    }

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(reopened.db);
      for (const operationId of operationIds) {
        const trail = repository.require(operationId);
        expect(trail.state).toBe("terminal");
        expect(trail.records).toHaveLength(2);
      }
    } finally {
      reopened.db.close();
    }
  });

  it("persists standalone rejection and explicit failed or incomplete terminal truth", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      for (const [index, definition] of securityCases().entries()) {
        const rejected = repository.recordRejected(rejectedRecord(definition, index));
        expect(rejected.records).toHaveLength(1);
        expect(rejected.records[0]).toMatchObject({ outcome: "rejected", payload_summary: { schema_version: 1 } });

        const failedIndex = 20 + index;
        repository.recordAccepted(acceptedRecord(definition, failedIndex));
        expect(
          repository.recordTerminal(
            terminalRecord(definition, failedIndex, "failed", "storage_error", failureSummary(definition, "failed"))
          ).records[1]
        ).toMatchObject({ outcome: "failed", error_code: "storage_error" });

        const incompleteIndex = 40 + index;
        repository.recordAccepted(acceptedRecord(definition, incompleteIndex));
        expect(
          repository.recordTerminal(
            terminalRecord(definition, incompleteIndex, "incomplete", "runtime_unavailable", {
              ...failureSummary(definition, "incomplete"),
              reconciliation_reason: "host_restart_without_terminal"
            })
          ).records[1]
        ).toMatchObject({ outcome: "incomplete", error_code: "runtime_unavailable" });
      }
    } finally {
      open.db.close();
    }
  });

  it("rejects authority, target, summary, and disguised secret failures before SQLite without secret causes", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    const rawSecrets = [
      "pairing-code-private-654321",
      "device-bearer-private-123456789",
      "csrf-private-123456789",
      "-----BEGIN PRIVATE KEY-----private-key-material",
      "-----BEGIN CERTIFICATE-----certificate-material",
      "hostdeck_device=private-cookie-material",
      "tskey-auth-private-remote-credential",
      "private-account@example.test",
      "private-profile-and-node-identity",
      "tailscale-cli-output-with-private-state",
      "https://foreign-node.private-tailnet.ts.net"
    ];
    try {
      const repository = createSelectedAuditRepository(open.db);
      const pairRequest = securityCases()[0];
      const csrf = securityCases()[2];
      const lock = securityCases()[4];
      const remoteEnable = securityCases()[6];
      if (pairRequest === undefined || csrf === undefined || lock === undefined || remoteEnable === undefined) {
        throw new Error("Missing security case fixture.");
      }

      const invalid = [
        { ...acceptedRecord(pairRequest, 30), actor: dashboardActor("write") },
        { ...acceptedRecord(csrf, 31), target: deviceTarget("client_security_wrong") },
        { ...acceptedRecord(lock, 32), actor: dashboardActor("read") },
        { ...acceptedRecord(pairRequest, 33), payload_summary: { schema_version: 1 } },
        {
          ...acceptedRecord(pairRequest, 34),
          payload_summary: { ...pairRequest.intent, nested: { value: rawSecrets[0] } }
        },
        ...rawSecrets.map((secret, index) => ({
          ...acceptedRecord(pairRequest, 40 + index),
          payload_summary: { ...pairRequest.intent, value: secret }
        })),
        ...[
          { account_login: rawSecrets[7] },
          { profile_identity: rawSecrets[8] },
          { node_identity: rawSecrets[8] },
          { cli_output: rawSecrets[9] },
          { foreign_serve_payload: rawSecrets[10] },
          { tailscale_key: rawSecrets[6] },
          { pairing_fragment: rawSecrets[0] }
        ].map((unsafe, index) => ({
          ...acceptedRecord(remoteEnable, 60 + index),
          payload_summary: { ...remoteEnable.intent, ...unsafe }
        }))
      ];

      for (const candidate of invalid) {
        const error = expectAuditError(() => repository.recordAccepted(candidate), "invalid_audit_record");
        expect(error.cause).toBeUndefined();
        for (const secret of rawSecrets) expect(JSON.stringify(error)).not.toContain(secret);
      }
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }

    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      for (const secret of rawSecrets) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it("reads legacy generic security rows but rejects that shape and corrupt versioned rows for current truth", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const pairRequest = securityCases()[0];
      const csrf = securityCases()[2];
      const lock = securityCases()[4];
      if (pairRequest === undefined || csrf === undefined || lock === undefined) {
        throw new Error("Missing security case fixture.");
      }

      const legacy = {
        ...acceptedRecord(pairRequest, 60),
        payload_summary: { schema_version: 1, legacy_note: "preserved" }
      };
      insertRawRecord(open.db, legacy, null);
      expect(repository.require(operationIdFor(60)).records[0]?.payload_summary).toEqual({
        schema_version: 1,
        legacy_note: "preserved"
      });

      const currentLegacyShape = { ...legacy, id: recordIdFor(61, "accepted"), operation_id: operationIdFor(61) };
      const currentError = expectAuditError(() => repository.recordAccepted(currentLegacyShape), "invalid_audit_record");
      expect(currentError.cause).toBeUndefined();

      insertRawRecord(open.db, {
        ...acceptedRecord(pairRequest, 62),
        payload_summary: { schema_version: 1, value: "invalid-versioned-summary" }
      });
      expectAuditError(() => repository.require(operationIdFor(62)), "invalid_audit_trail");

      insertRawRecord(open.db, {
        ...acceptedRecord(csrf, 63),
        payload_summary: { legacy_note: "csrf-never-had-a-legacy-shape" }
      });
      expectAuditError(() => repository.require(operationIdFor(63)), "invalid_audit_trail");

      const corruptSecret = "legacy-corruption-secret-sentinel";
      insertRawRecord(
        open.db,
        {
          ...acceptedRecord(lock, 64),
          actor: { type: "cli", device_id: corruptSecret, permission: "local_admin", origin: null }
        },
        null
      );
      const readCorruption = expectAuditError(() => repository.require(operationIdFor(64)), "invalid_audit_trail");
      expect(readCorruption.cause).toBeUndefined();
      expect(JSON.stringify(readCorruption)).not.toContain(corruptSecret);
      const corruption = expectAuditError(
        () => repository.recordTerminal(succeededRecord(lock, 64)),
        "invalid_audit_trail"
      );
      expect(corruption.cause).toBeUndefined();
      expect(JSON.stringify(corruption)).not.toContain(corruptSecret);
    } finally {
      open.db.close();
    }
  });

  it("reads historical LAN trails while preventing the selected repository from emitting them", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const selected = createSelectedAuditRepository(open.db);
      const historical = createHistoricalSelectedNetworkAuditRepository(open.db);
      for (const [offset, definition] of historicalCases().entries()) {
        const index = 100 + offset;
        const rejected = expectAuditError(
          () => selected.recordAccepted(acceptedRecord(definition, index)),
          "invalid_audit_record"
        );
        expect(rejected.cause).toBeUndefined();

        historical.recordAccepted(acceptedRecord(definition, index));
        historical.recordTerminal(succeededRecord(definition, index));
        expect(selected.require(operationIdFor(index)).records).toMatchObject([
          { action: definition.action, outcome: "accepted" },
          { action: definition.action, outcome: "succeeded" }
        ]);
      }
      expect(
        open.db
          .prepare(
            "SELECT action, security_schema_version FROM selected_audit_events " +
              "WHERE action LIKE 'lan_%' OR action = 'certificate_rotate' ORDER BY action, phase"
          )
          .all()
      ).toHaveLength(8);
      expect(
        open.db
          .prepare(
            "SELECT DISTINCT security_schema_version FROM selected_audit_events " +
              "WHERE action LIKE 'lan_%' OR action = 'certificate_rotate'"
          )
          .all()
      ).toEqual([{ security_schema_version: 1 }]);
    } finally {
      open.db.close();
    }
  });

  it("rolls back forced start, terminal, and deferred commit failures with bounded cause-free errors", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const lock = securityCases()[4];
      if (lock === undefined) throw new Error("Missing lock security case.");

      installInsertFailure(open.db, recordIdFor(70, "accepted"));
      const startFailure = expectAuditError(() => repository.recordAccepted(acceptedRecord(lock, 70)), "audit_write_failed");
      expect(startFailure.cause).toBeUndefined();
      expect(repository.get(operationIdFor(70))).toBeNull();

      open.db.exec("DROP TRIGGER force_security_audit_insert_failure");
      repository.recordAccepted(acceptedRecord(lock, 71));
      installInsertFailure(open.db, recordIdFor(71, "terminal"));
      const terminalFailure = expectAuditError(
        () => repository.recordTerminal(succeededRecord(lock, 71)),
        "audit_write_failed"
      );
      expect(terminalFailure.cause).toBeUndefined();
      expect(repository.require(operationIdFor(71)).state).toBe("pending");

      open.db.exec("DROP TRIGGER force_security_audit_insert_failure");
      open.db.exec(`
        CREATE TABLE security_audit_commit_probe (
          missing_device_id TEXT NOT NULL,
          FOREIGN KEY (missing_device_id) REFERENCES auth_devices(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER force_security_audit_commit_failure
        AFTER INSERT ON selected_audit_events
        WHEN NEW.id = '${recordIdFor(72, "accepted")}'
        BEGIN
          INSERT INTO security_audit_commit_probe (missing_device_id) VALUES ('missing_security_audit_device');
        END;
      `);
      const commitFailure = expectAuditError(() => repository.recordAccepted(acceptedRecord(lock, 72)), "audit_write_failed");
      expect(commitFailure.cause).toBeUndefined();
      expect(open.db.inTransaction).toBe(false);
      expect(repository.get(operationIdFor(72))).toBeNull();
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM security_audit_commit_probe").get()).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });

  it("reports closed and read-only security audit storage without native or secret causes", () => {
    const path = tempDbPath();
    const writable = openMigratedDatabase(path, { now: fixedNow });
    const lock = securityCases()[4];
    if (lock === undefined) throw new Error("Missing lock security case.");
    const closedRepository = createSelectedAuditRepository(writable.db);
    writable.db.close();

    const closed = expectAuditError(() => closedRepository.recordAccepted(acceptedRecord(lock, 75)), "audit_unavailable");
    expect(closed.cause).toBeUndefined();

    const readonly = openMigratedDatabase(path, { now: fixedNow, readonly: true });
    try {
      const failure = expectAuditError(
        () => createSelectedAuditRepository(readonly.db).recordAccepted(acceptedRecord(lock, 76)),
        "audit_unavailable"
      );
      expect(failure.cause).toBeUndefined();
      expect(createSelectedAuditRepository(readonly.db).get(operationIdFor(76))).toBeNull();
    } finally {
      readonly.db.close();
    }
  });

  it("serializes a real security accepted contender to one durable winner", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    try {
      open.db.pragma("busy_timeout = 2000");
      const remoteEnable = securityCases()[6];
      if (remoteEnable === undefined) throw new Error("Missing remote-enable security case.");
      const winner = acceptedRecord(remoteEnable, 80);
      const worker = startRawSecurityInsert(path, winner);
      await worker.inserted;

      const loser = { ...winner, id: "audit:security:race:loser" };
      const error = expectAuditError(
        () => createSelectedAuditRepository(open.db).recordAccepted(loser),
        "audit_operation_exists"
      );
      expect(error.cause).toBeUndefined();
      await worker.completed;
      expect(createSelectedAuditRepository(open.db).require(operationIdFor(80)).records).toHaveLength(1);
    } finally {
      open.db.close();
    }
  });

  it("preserves strict security truth through restart, orphan reconciliation, and whole-trail retention", () => {
    const orphanPath = tempDbPath();
    const orphanFirst = openMigratedDatabase(orphanPath, { now: fixedNow });
    const lock = securityCases()[4];
    const remoteEnable = securityCases()[6];
    const remoteDisable = securityCases()[7];
    if (lock === undefined || remoteEnable === undefined || remoteDisable === undefined) {
      throw new Error("Missing security case fixture.");
    }
    try {
      createSelectedAuditRepository(orphanFirst.db).recordAccepted(acceptedRecord(remoteEnable, 90));
    } finally {
      orphanFirst.db.close();
    }

    const orphanReopened = openMigratedDatabase(orphanPath, { now: fixedNow });
    try {
      expect(
        reconcileSelectedAuditOrphansBatch(orphanReopened.db, {
          eligible_before: terminalAt,
          max_reconciled_operations: 10,
          reconciled_at: "2026-07-11T20:02:00.000Z"
        }).reconciled_operation_count
      ).toBe(1);
      const trail = createSelectedAuditRepository(orphanReopened.db).require(operationIdFor(90));
      expect(trail.records[1]).toMatchObject({
        actor: remoteEnable.actor,
        action: "remote_enable",
        target: remoteEnable.target,
        outcome: "incomplete",
        error_code: "runtime_unavailable",
        payload_summary: {
          schema_version: 1,
          action: "remote_enable",
          phase: "terminal",
          outcome: "incomplete",
          admission: "closed",
          intent_persisted: "unknown",
          serve_result: "unknown",
          reason: "observation_failed",
          reconciliation_reason: "host_restart_without_terminal"
        }
      });
    } finally {
      orphanReopened.db.close();
    }

    const retentionPath = tempDbPath();
    const retentionOpen = openMigratedDatabase(retentionPath, { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(retentionOpen.db);
      const csrf = securityCases()[2];
      if (csrf === undefined) throw new Error("Missing retention security case.");
      repository.recordAccepted(acceptedRecord(remoteDisable, 91, "2026-05-01T20:00:00.000Z"));
      repository.recordTerminal(succeededRecord(remoteDisable, 91, "2026-05-01T20:01:00.000Z"));
      repository.recordAccepted(acceptedRecord(lock, 92, "2026-07-10T20:00:00.000Z"));
      repository.recordTerminal(succeededRecord(lock, 92, "2026-07-10T20:01:00.000Z"));
      repository.recordAccepted(acceptedRecord(csrf, 93, "2026-07-10T20:02:00.000Z"));

      const result = maintainSelectedAuditRetentionBatch(retentionOpen.db, {
        max_deleted_records: 100,
        now: "2026-07-11T20:00:00.000Z",
        retention: { ...defaultRetentionPolicy, audit_event_limit: 100, audit_retention_days: 30 }
      });
      expect(result).toMatchObject({ deleted_operation_count: 1, deleted_record_count: 2 });
      expect(repository.get(operationIdFor(91))).toBeNull();
      expect(repository.require(operationIdFor(92)).records.map((record) => record.outcome)).toEqual([
        "accepted",
        "succeeded"
      ]);
      expect(repository.require(operationIdFor(93)).state).toBe("pending");
    } finally {
      retentionOpen.db.close();
    }

    const retentionReopened = openMigratedDatabase(retentionPath, { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(retentionReopened.db);
      expect(repository.require(operationIdFor(92)).state).toBe("terminal");
      expect(repository.require(operationIdFor(93)).state).toBe("pending");
    } finally {
      retentionReopened.db.close();
    }
  });
});

interface SecurityCase {
  readonly action: string;
  readonly actor: Readonly<Record<string, unknown>>;
  readonly target: Readonly<Record<string, unknown>>;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly success: Readonly<Record<string, unknown>>;
}

function securityCases(): readonly SecurityCase[] {
  return [
    {
      action: "pair_request",
      actor: cliActor(),
      target: hostTarget(),
      intent: {
        schema_version: 1,
        permission: "write",
        client_label_present: true,
        expires_at: "2026-07-11T20:10:00.000Z"
      },
      success: { schema_version: 1, pairing_id: "pair_security_repository" }
    },
    {
      action: "pair_claim",
      actor: pairingActor(),
      target: hostTarget(),
      intent: { schema_version: 1, permission: "write", client_label_present: true },
      success: {
        schema_version: 1,
        permission: "write",
        device_created: true,
        device_id: "client_security_created"
      }
    },
    {
      action: "csrf_bootstrap",
      actor: dashboardActor("read"),
      target: deviceTarget("client_security_phone"),
      intent: { schema_version: 1, csrf_generation_before: 1 },
      success: { schema_version: 1, csrf_generation_after: 2, rotated: true }
    },
    {
      action: "device_revoke",
      actor: dashboardActor("write"),
      target: deviceTarget("client_security_other"),
      intent: { schema_version: 1, previously_revoked: false },
      success: { schema_version: 1, authority_invalidated: true }
    },
    {
      action: "lock",
      actor: dashboardActor("write"),
      target: hostTarget(),
      intent: { schema_version: 1, requested_locked: true },
      success: { schema_version: 1, locked: true }
    },
    {
      action: "unlock",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, requested_locked: false },
      success: { schema_version: 1, locked: false }
    },
    {
      action: "remote_enable",
      actor: cliActor(),
      target: hostTarget(),
      intent: remoteAcceptedSummary("remote_enable"),
      success: remoteSuccessSummary("remote_enable")
    },
    {
      action: "remote_disable",
      actor: cliActor(),
      target: hostTarget(),
      intent: remoteAcceptedSummary("remote_disable"),
      success: {
        ...remoteSuccessSummary("remote_disable")
      }
    }
  ];
}

function historicalCases(): readonly SecurityCase[] {
  return [
    {
      action: "lan_configure",
      actor: cliActor(),
      target: hostTarget(),
      intent: {
        schema_version: 1,
        bind_address_family: "ipv4",
        bind_port: 3777,
        certificate_change_requested: true
      },
      success: { schema_version: 1, configuration_changed: true }
    },
    {
      action: "lan_enable",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, requested_lan_enabled: true },
      success: { schema_version: 1, lan_enabled: true }
    },
    {
      action: "lan_disable",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, requested_lan_enabled: false },
      success: { schema_version: 1, lan_enabled: false }
    },
    {
      action: "certificate_rotate",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, rotation_requested: true },
      success: {
        schema_version: 1,
        certificate_changed: true,
        certificate_fingerprint_sha256: "a".repeat(64),
        certificate_expires_at: "2027-07-11T20:00:00.000Z"
      }
    }
  ];
}

function acceptedRecord(definition: SecurityCase, index: number, at = acceptedAt) {
  return {
    id: recordIdFor(index, "accepted"),
    operation_id: operationIdFor(index),
    at,
    actor: definition.actor,
    action: definition.action,
    target: definition.target,
    phase: "accepted",
    outcome: "accepted",
    payload_summary: definition.intent,
    error_code: null
  };
}

function succeededRecord(definition: SecurityCase, index: number, at = terminalAt) {
  return terminalRecord(definition, index, "succeeded", null, definition.success, at);
}

function rejectedRecord(definition: SecurityCase, index: number) {
  return terminalRecord(definition, 10 + index, "rejected", "validation_error", rejectionSummary(definition));
}

function failureSummary(
  definition: SecurityCase,
  outcome: "failed" | "incomplete"
): Readonly<Record<string, unknown>> {
  if (definition.action !== "remote_enable" && definition.action !== "remote_disable") {
    return { schema_version: 1 };
  }
  return {
    ...remoteAcceptedSummary(definition.action),
    phase: "terminal",
    outcome,
    admission: "closed",
    intent_persisted: outcome === "incomplete" ? "unknown" : false,
    serve_result: outcome === "incomplete" ? "unknown" : "not_attempted",
    reason: outcome === "incomplete" ? "observation_failed" : "command_failed"
  };
}

function rejectionSummary(definition: SecurityCase): Readonly<Record<string, unknown>> {
  if (definition.action !== "remote_enable" && definition.action !== "remote_disable") {
    return { schema_version: 1 };
  }
  return {
    ...remoteAcceptedSummary(definition.action),
    profile_state: "other",
    serve_state: null,
    phase: "terminal",
    outcome: "rejected",
    admission: "closed",
    intent_persisted: false,
    serve_result: "not_attempted",
    reason: "profile_other"
  };
}

function remoteAcceptedSummary(action: "remote_disable" | "remote_enable") {
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

function remoteSuccessSummary(action: "remote_disable" | "remote_enable") {
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

function terminalRecord(
  definition: SecurityCase,
  index: number,
  outcome: "failed" | "incomplete" | "rejected" | "succeeded",
  error_code: string | null,
  payload_summary: Readonly<Record<string, unknown>>,
  at = terminalAt
) {
  return {
    id: recordIdFor(index, "terminal"),
    operation_id: operationIdFor(index),
    at,
    actor: definition.actor,
    action: definition.action,
    target: definition.target,
    phase: "terminal",
    outcome,
    payload_summary,
    error_code
  };
}

function operationIdFor(index: number): string {
  return `op_security_repository_${String(index).padStart(3, "0")}`;
}

function recordIdFor(index: number, phase: "accepted" | "terminal"): string {
  return `audit:security:repository:${String(index).padStart(3, "0")}:${phase}`;
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

function hostTarget() {
  return { type: "host", host_id: "local_host" } as const;
}

function deviceTarget(device_id: string) {
  return { type: "device", device_id } as const;
}

function expectAuditError(
  fn: () => unknown,
  code: SelectedAuditRepositoryErrorCode
): HostDeckSelectedAuditRepositoryError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckSelectedAuditRepositoryError);
  expect((caught as HostDeckSelectedAuditRepositoryError).code).toBe(code);
  return caught as HostDeckSelectedAuditRepositoryError;
}

function insertRawRecord(
  db: Database.Database,
  record: Readonly<Record<string, unknown>>,
  securitySchemaVersion: 1 | 2 | null = 2
): void {
  db.prepare(
    `
      INSERT INTO selected_audit_events (
        id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json
      ) VALUES (
        @id, @operation_id, @at, @action, @security_schema_version, @phase, @outcome, @error_code, @record_json
      )
    `
  ).run({ ...record, record_json: JSON.stringify(record), security_schema_version: securitySchemaVersion });
}

function installInsertFailure(db: Database.Database, recordId: string): void {
  db.exec(`
    CREATE TRIGGER force_security_audit_insert_failure
    AFTER INSERT ON selected_audit_events
    WHEN NEW.id = '${recordId}'
    BEGIN
      SELECT RAISE(ABORT, 'forced security audit insert failure');
    END;
  `);
}

function startRawSecurityInsert(
  path: string,
  candidate: Readonly<Record<string, unknown>>
): { readonly inserted: Promise<void>; readonly completed: Promise<void> } {
  const record = selectedSecurityAuditEventRecordSchema.parse(candidate);
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO selected_audit_events " +
        "(id, operation_id, at, action, security_schema_version, phase, outcome, error_code, record_json) " +
        "VALUES (@id, @operation_id, @at, @action, 2, @phase, @outcome, @error_code, @record_json)"
      ).run(workerData.row);
      parentPort.postMessage("inserted");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: {
        databaseModule: betterSqlite3Path,
        path,
        row: {
          id: record.id,
          operation_id: record.operation_id,
          at: record.at,
          action: record.action,
          phase: record.phase,
          outcome: record.outcome,
          error_code: record.error_code,
          record_json: JSON.stringify(record)
        }
      }
    }
  );
  const inserted = new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (message === "inserted") resolve();
    });
    worker.once("error", reject);
  });
  const completed = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Security audit writer exited with code ${code}.`));
    });
  });
  return { completed, inserted };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-security-audit-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-11T19:59:00.000Z");
}
