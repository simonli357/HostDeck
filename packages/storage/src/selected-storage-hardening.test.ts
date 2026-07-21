import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexItemIdSchema,
  defaultResourceBudget,
  defaultRetentionPolicy,
  isoTimestampSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthDeviceRepository,
  createSelectedCsrfAuthorizationRepository,
  HostDeckAuthRepositoryError,
  hashSecret
} from "./auth-repository.js";
import {
  acquireHostDeckDaemonLease,
  HostDeckDaemonLeaseError
} from "./daemon-lease.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { defaultMigrations } from "./migrations.js";
import {
  createProductionProjectionAppendPort,
  type ProductionProjectionAppendInput
} from "./projection-append-port.js";
import {
  createRuntimeCompatibilityRepository,
  HostDeckRuntimeCompatibilityRepositoryError
} from "./runtime-compatibility-repository.js";
import {
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPathsAfterLease,
  prepareHostDeckStatePaths,
  resolveHostDeckLocalPaths
} from "./secure-local-paths.js";
import {
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError
} from "./selected-audit-repository.js";
import { createDeviceListingRepository } from "./selected-device-listing-repository.js";
import { createDeviceRevocationRepository } from "./selected-device-revocation-repository.js";
import { createPairingCodeRepository } from "./selected-pairing-repository.js";
import {
  createSelectedStateRepository,
  type SelectedSessionState,
  selectedStateRevision
} from "./selected-state-repository.js";
import { runStartupAuditOrphanReconciliation } from "./startup-audit-orphan-reconciliation.js";
import { runStartupRetentionMaintenance } from "./startup-retention-maintenance.js";

const cleanup: string[] = [];
const createdAt = "2026-07-12T10:00:00.000Z";
const orphanCutoff = "2026-07-12T12:00:00.000Z";
const reconciledAt = "2026-07-12T12:00:30.000Z";
const maintenanceAt = "2026-07-12T13:00:00.000Z";
const rawPairingCode = "P".repeat(22);
const rawDeviceToken = "D".repeat(43);
const initialCsrfToken = "C".repeat(43);
const rotatedCsrfToken = "R".repeat(43);
const privateMaterial = "-----BEGIN PRIVATE KEY-----aggregate-private-material";
const fullTranscript = "aggregate-full-transcript-must-never-become-hostdeck-durable-truth";
const selectedDeviceId = `client_${"d".repeat(24)}`;
const pairingSourceKey = `sha256:${"a".repeat(64)}`;
const currentMigrationVersion = "202607200018_selected_network_retirement";

afterEach(() => {
  for (const root of cleanup.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("selected local-state/auth/audit aggregate hardening", () => {
  it("preserves selected truth, bounds, authority, and privacy across a real secure restart", async () => {
    const layout = createLayout();
    const paths = resolveHostDeckLocalPaths(layout);
    const observedErrors: unknown[] = [];

    expect(prepareHostDeckDaemonLeasePath(paths)).toEqual([]);
    const firstLease = acquireHostDeckDaemonLease({
      lease_path: paths.lease_path,
      now: () => at("2026-07-12T09:59:00.000Z"),
      pid: 35_700
    });

    try {
      const heldLeaseError = captureError(() =>
        acquireHostDeckDaemonLease({ lease_path: paths.lease_path })
      );
      observedErrors.push(heldLeaseError);
      expect(heldLeaseError).toBeInstanceOf(HostDeckDaemonLeaseError);
      expect(heldLeaseError).toMatchObject({ code: "lease_held" });

      prepareHostDeckLocalPathsAfterLease(paths);
      prepareHostDeckStatePaths({
        state_dir: paths.state_dir,
        database_path: paths.database_path
      });
      expectModes(paths);

      const first = openMigratedDatabase(paths.database_path, {
        now: () => at(createdAt)
      });
      try {
        expect(first.result).toEqual({
          applied: defaultMigrations.map(({ version }) => version),
          currentVersion: currentMigrationVersion
        });
        inspectSchemaAndHealth(first.db);

        const stateRepository = createSelectedStateRepository(first.db);
        const reserved = stateRepository.putRecovery(recoveryRecord());
        const threadCreated = stateRepository.putRecovery({
          ...reserved,
          codex_thread_id: "thread-aggregate-selected-001",
          state: "thread_created",
          updated_at: "2026-07-12T10:00:01.000Z"
        });
        let selectedState = stateRepository.create(stateCandidate());
        stateRepository.putRecovery({
          ...threadCreated,
          state: "persisted",
          updated_at: "2026-07-12T10:00:02.000Z"
        });

        createRuntimeCompatibilityRepository(first.db).put(compatibilityRecord());

        const publications: number[] = [];
        const appendPort = createProductionProjectionAppendPort({
          repository: stateRepository,
          retention: aggregateRetentionPolicy(),
          publish(committed) {
            expect(stateRepository.require(selectedState.mapping.id).projection).toEqual(
              committed.projection
            );
            publications.push(committed.event.event.cursor);
          }
        });
        for (let index = 1; index <= 5; index += 1) {
          await appendPort.append(appendCandidate(selectedState, index));
          selectedState = stateRepository.require(selectedState.mapping.id);
        }
        expect(publications).toEqual([1, 2, 3, 4, 5]);
        expect(stateRepository.listEvents(selectedState.mapping.id)).toMatchObject({
          truncated: true,
          next_cursor: 5,
          events: [
            { type: "replay_boundary", cursor: 3, after: 2, next_cursor: 3 },
            { type: "message", cursor: 4 },
            { type: "message", cursor: 5 }
          ]
        });

        const pairing = createPairingCodeRepository(first.db, {
          policy: defaultResourceBudget,
          generatePairingCode: () => rawPairingCode,
          generateDeviceId: () => selectedDeviceId,
          generateDeviceToken: () => rawDeviceToken,
          generateCsrfToken: () => initialCsrfToken
        });
        const issued = pairing.issue({
          id: "pair_aggregate_selected_001",
          permission: "write",
          clientLabel: "Android debug phone",
          createdAt: at("2026-07-12T12:00:00.000Z")
        });
        expect(issued.rawCode).toBe(rawPairingCode);
        const claim = pairing.claim({
          rawCode: issued.rawCode,
          sourceKey: pairingSourceKey,
          now: at("2026-07-12T12:00:01.000Z"),
          clientLabel: "Android debug phone",
          deviceExpiresAt: at("2027-07-12T12:00:01.000Z")
        });
        expect(claim).toMatchObject({
          rawDeviceToken,
          rawCsrfToken: initialCsrfToken,
          pairingCode: {
            claimed_device_id: selectedDeviceId,
            used_at: "2026-07-12T12:00:01.000Z"
          },
          device: { id: selectedDeviceId, permission: "write", csrf_generation: 1 }
        });

        const auth = createAuthDeviceRepository(first.db);
        const csrfAuthorization = createSelectedCsrfAuthorizationRepository(first.db, {
          generateCsrfToken: () => rotatedCsrfToken
        });
        const rotation = csrfAuthorization.rotateBootstrap({
          deviceId: selectedDeviceId,
          expectedCsrfGeneration: 1,
          now: at("2026-07-12T12:00:02.000Z")
        });
        expect(rotation).toMatchObject({
          deviceId: selectedDeviceId,
          rawCsrfToken: rotatedCsrfToken,
          csrfGeneration: 2
        });
        const staleCsrfError = captureError(() =>
          csrfAuthorization.authorizeBrowserWrite({
            deviceId: selectedDeviceId,
            expectedCsrfGeneration: 2,
            rawCsrfToken: initialCsrfToken,
            now: at("2026-07-12T12:00:03.000Z")
          })
        );
        observedErrors.push(staleCsrfError);
        expect(staleCsrfError).toBeInstanceOf(HostDeckAuthRepositoryError);
        expect(staleCsrfError).toMatchObject({ code: "csrf_mismatch" });
        expect(
          auth.authenticateDeviceToken({
            rawDeviceToken,
            now: at("2026-07-12T12:00:03.000Z")
          }).device.last_used_at
        ).toBe("2026-07-12T12:00:03.000Z");
        expect(
          csrfAuthorization.authorizeBrowserWrite({
            deviceId: selectedDeviceId,
            expectedCsrfGeneration: 2,
            rawCsrfToken: rotatedCsrfToken,
            now: at("2026-07-12T12:00:04.000Z")
          }).device.last_used_at
        ).toBe("2026-07-12T12:00:04.000Z");
        expect(
          createDeviceListingRepository(first.db).list({
            limit: 1,
            afterDeviceId: null
          })
        ).toMatchObject({
          devices: [
            {
              deviceId: selectedDeviceId,
              permission: "write",
              lastUsedAt: "2026-07-12T12:00:04.000Z",
              revokedAt: null
            }
          ],
          hasMore: false,
          nextAfterDeviceId: null
        });

        const audit = createSelectedAuditRepository(first.db);
        const unsafeAuditError = captureError(() =>
          audit.recordAccepted(unsafeSecurityAuditRecord())
        );
        observedErrors.push(unsafeAuditError);
        expect(unsafeAuditError).toBeInstanceOf(HostDeckSelectedAuditRepositoryError);
        expect(unsafeAuditError).toMatchObject({ code: "invalid_audit_record" });
        expect(unsafeAuditError.cause).toBeUndefined();
        expect(audit.get("op_aggregate_unsafe_audit_001")).toBeNull();

        audit.recordAccepted(
          promptAuditRecord(
            "op_aggregate_completed_001",
            "audit:aggregate:completed:accepted",
            "2026-07-12T10:00:00.000Z"
          )
        );
        audit.recordTerminal(
          promptAuditTerminal(
            "op_aggregate_completed_001",
            "audit:aggregate:completed:terminal",
            "2026-07-12T10:01:00.000Z",
            "succeeded",
            null
          )
        );
        audit.recordRejected(
          promptAuditTerminal(
            "op_aggregate_rejected_001",
            "audit:aggregate:rejected:terminal",
            "2026-07-12T10:02:00.000Z",
            "rejected",
            "validation_error"
          )
        );
        audit.recordAccepted(
          promptAuditRecord(
            "op_aggregate_orphan_001",
            "audit:aggregate:orphan:accepted",
            "2026-07-12T11:00:00.000Z"
          )
        );
        audit.recordAccepted(
          promptAuditRecord(
            "op_aggregate_protected_001",
            "audit:aggregate:protected:accepted",
            orphanCutoff
          )
        );
        audit.recordAccepted(deviceRevokeAuditAccepted());

        const revoked = createDeviceRevocationRepository(first.db).revoke({
          deviceId: selectedDeviceId,
          now: at("2026-07-12T12:00:05.000Z")
        });
        expect(revoked).toEqual({
          deviceId: selectedDeviceId,
          revokedAt: "2026-07-12T12:00:05.000Z",
          previouslyRevoked: false,
          authorityInvalidated: true
        });
        audit.recordTerminal(deviceRevokeAuditSucceeded());

        const revokedAuthError = captureError(() =>
          auth.authenticateDeviceToken({
            rawDeviceToken,
            now: at("2026-07-12T12:00:06.000Z")
          })
        );
        observedErrors.push(revokedAuthError);
        expect(revokedAuthError).toBeInstanceOf(HostDeckAuthRepositoryError);
        expect(revokedAuthError).toMatchObject({ code: "device_revoked" });

        inspectQueryPlans(first.db);
        expect(expectCrossDomainCounts(first.db)).toMatchObject({
          selected_audit_events: 7,
          selected_projected_events: 3,
          auth_devices: 1,
          pairing_codes: 1
        });
      } finally {
        first.db.close();
      }
    } finally {
      firstLease.release();
    }
    expect(firstLease.released).toBe(true);

    const restartLease = acquireHostDeckDaemonLease({
      lease_path: paths.lease_path,
      now: () => at("2026-07-12T12:00:20.000Z"),
      pid: 35_701
    });
    expect(restartLease.replaced_stale_metadata).toBe(true);

    try {
      prepareHostDeckLocalPathsAfterLease(paths);
      prepareHostDeckStatePaths({
        state_dir: paths.state_dir,
        database_path: paths.database_path
      });
      expectModes(paths);

      const restarted = openMigratedDatabase(paths.database_path, {
        now: () => at(reconciledAt)
      });
      try {
        expect(restarted.result).toEqual({
          applied: [],
          currentVersion: currentMigrationVersion
        });
        inspectSchemaAndHealth(restarted.db);

        const stateRepository = createSelectedStateRepository(restarted.db);
        expect(stateRepository.require("sess_aggregate_selected_001")).toMatchObject({
          mapping: {
            codex_thread_id: "thread-aggregate-selected-001",
            disposition: "selected"
          },
          projection: {
            retained_event_count: 3,
            earliest_retained_cursor: 3,
            retention_boundary_cursor: 2,
            session: { last_event_cursor: 5 }
          }
        });
        expect(stateRepository.listEvents("sess_aggregate_selected_001")).toMatchObject({
          truncated: true,
          events: [
            { type: "replay_boundary", cursor: 3, after: 2 },
            { type: "message", cursor: 4 },
            { type: "message", cursor: 5 }
          ]
        });
        expect(stateRepository.getRecovery("op_aggregate_start_001")).toMatchObject({
          codex_thread_id: "thread-aggregate-selected-001",
          state: "persisted"
        });
        expect(createRuntimeCompatibilityRepository(restarted.db).get()).toEqual(
          compatibilityRecord()
        );

        const restartedAuth = createAuthDeviceRepository(restarted.db);
        const restartAuthError = captureError(() =>
          restartedAuth.authenticateDeviceToken({
            rawDeviceToken,
            now: at("2026-07-12T12:00:21.000Z")
          })
        );
        observedErrors.push(restartAuthError);
        expect(restartAuthError).toBeInstanceOf(HostDeckAuthRepositoryError);
        expect(restartAuthError).toMatchObject({ code: "device_revoked" });
        expect(restartedAuth.require(selectedDeviceId)).toMatchObject({
          csrf_generation: 2,
          last_used_at: "2026-07-12T12:00:04.000Z",
          revoked_at: "2026-07-12T12:00:05.000Z"
        });
        expect(
          createDeviceListingRepository(restarted.db).list({
            limit: 1,
            afterDeviceId: null
          }).devices[0]
        ).toMatchObject({
          deviceId: selectedDeviceId,
          revokedAt: "2026-07-12T12:00:05.000Z"
        });
        expect(
          createPairingCodeRepository(restarted.db, {
            policy: defaultResourceBudget
          }).getRateSnapshot(pairingSourceKey)
        ).toMatchObject({
          source: { attempt_count: 1 },
          global: { attempt_count: 1 }
        });

        const restartedAudit = createSelectedAuditRepository(restarted.db);
        expect(restartedAudit.require("op_aggregate_device_revoke_001")).toMatchObject({
          state: "terminal",
          records: [{ outcome: "accepted" }, { outcome: "succeeded" }]
        });
        expect(restartedAudit.require("op_aggregate_orphan_001").state).toBe(
          "pending"
        );
        const orphanResult = runStartupAuditOrphanReconciliation({
          db: restarted.db,
          eligible_before: orphanCutoff,
          reconciled_at: reconciledAt,
          batch_operation_limit: 1,
          monotonic_now: incrementingClock(),
          timeout_ms: 1_000
        });
        expect(orphanResult).toMatchObject({
          status: "complete",
          scan_complete: true,
          reconciled_operation_count: 1,
          protected_recent_operation_count: 1,
          total_pending_operation_count: 1,
          failure: null,
          reasons: []
        });
        expect(restartedAudit.require("op_aggregate_orphan_001")).toMatchObject({
          state: "terminal",
          records: [
            { outcome: "accepted" },
            { outcome: "incomplete", error_code: "runtime_unavailable" }
          ]
        });
        expect(restartedAudit.require("op_aggregate_protected_001").state).toBe(
          "pending"
        );

        restartedAudit.recordAccepted(lockAuditAccepted());
        restartedAudit.recordTerminal(lockAuditSucceeded());
        const retention = runStartupRetentionMaintenance({
          db: restarted.db,
          batch_record_limit: 2,
          max_batches_per_scope: 10,
          monotonic_now: incrementingClock(),
          now: () => at(maintenanceAt),
          retention: aggregateRetentionPolicy(),
          timeout_ms: 1_000
        });
        expect(retention).toMatchObject({
          status: "complete",
          reasons: [],
          failure: null,
          output: {
            actionable_remaining: false,
            policy_violation_session_count: 0,
            pruned_event_count: 0,
            scan_complete: true
          },
          audit: {
            actionable_remaining: false,
            deleted_operation_count: 4,
            deleted_record_count: 7,
            pending_blocks_policy: false,
            protected_pending_operation_count: 1,
            retained_record_count: 3,
            scan_complete: true
          }
        });
        for (const deletedOperation of [
          "op_aggregate_completed_001",
          "op_aggregate_rejected_001",
          "op_aggregate_device_revoke_001",
          "op_aggregate_orphan_001"
        ]) {
          expect(restartedAudit.get(deletedOperation)).toBeNull();
        }
        expect(restartedAudit.require("op_aggregate_protected_001").state).toBe(
          "pending"
        );
        expect(restartedAudit.require("op_aggregate_lock_001")).toMatchObject({
          state: "terminal",
          records: [{ outcome: "accepted" }, { outcome: "succeeded" }]
        });

        expect(expectCrossDomainCounts(restarted.db)).toEqual({
          auth_devices: 1,
          legacy_session_dispositions: 0,
          pairing_claim_rate_global: 1,
          pairing_claim_rate_sources: 1,
          pairing_codes: 1,
          selected_audit_events: 3,
          selected_projected_events: 3,
          selected_runtime_compatibility: 1,
          selected_session_projections: 1,
          selected_session_start_recovery: 1,
          selected_sessions: 1
        });
        inspectQueryPlans(restarted.db);
        inspectSchemaAndHealth(restarted.db);
      } finally {
        restarted.db.close();
      }

      const readOnly = openMigratedDatabase(paths.database_path, {
        readonly: true,
        now: () => at(maintenanceAt)
      });
      try {
        expect(readOnly.result).toEqual({
          applied: [],
          currentVersion: currentMigrationVersion
        });
        expect(
          createSelectedStateRepository(readOnly.db).require(
            "sess_aggregate_selected_001"
          ).projection.session.last_event_cursor
        ).toBe(5);
        expect(
          createDeviceListingRepository(readOnly.db).list({
            limit: 1,
            afterDeviceId: null
          }).devices[0]?.revokedAt
        ).toBe("2026-07-12T12:00:05.000Z");
        inspectSchemaAndHealth(readOnly.db);
      } finally {
        readOnly.db.close();
      }

      const corruptionOpen = openMigratedDatabase(paths.database_path, {
        now: () => at(maintenanceAt)
      });
      try {
        const before = crossDomainSnapshot(corruptionOpen.db);
        corruptionOpen.db
          .prepare(
            "UPDATE selected_runtime_compatibility SET state = 'degraded', reason = 'aggregate semantic corruption' WHERE id = 'hostdeck_runtime'"
          )
          .run();
        const compatibilityError = captureError(() =>
          createRuntimeCompatibilityRepository(corruptionOpen.db).get()
        );
        observedErrors.push(compatibilityError);
        expect(compatibilityError).toBeInstanceOf(
          HostDeckRuntimeCompatibilityRepositoryError
        );
        expect(compatibilityError).toMatchObject({
          code: "invalid_persisted_compatibility"
        });
        expect(crossDomainSnapshot(corruptionOpen.db)).toEqual(before);
        expect(
          corruptionOpen.db
            .prepare(
              "SELECT state, reason FROM selected_runtime_compatibility WHERE id = 'hostdeck_runtime'"
            )
            .get()
        ).toEqual({
          state: "degraded",
          reason: "aggregate semantic corruption"
        });
        expectSqliteHealth(corruptionOpen.db);
      } finally {
        corruptionOpen.db.close();
      }
    } finally {
      restartLease.release();
    }
    expect(restartLease.released).toBe(true);
    expectModes(paths);

    const forbidden = [
      rawPairingCode,
      rawDeviceToken,
      initialCsrfToken,
      rotatedCsrfToken,
      privateMaterial,
      fullTranscript
    ];
    for (const file of sqliteFiles(paths.database_path)) {
      const bytes = readFileSync(file);
      for (const sentinel of forbidden) {
        expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
      }
    }
    const durableRows = readFileSync(paths.database_path).toString("utf8");
    expect(durableRows).toContain("Projection for aggregate event 5.");
    expect(durableRows).not.toContain(fullTranscript);
    for (const error of observedErrors) {
      const serialized = serializeError(error);
      for (const sentinel of forbidden) expect(serialized).not.toContain(sentinel);
    }
    for (const path of Object.values(paths)) {
      if (typeof path !== "string") continue;
      for (const sentinel of forbidden) expect(path).not.toContain(sentinel);
    }
  });
});

function stateCandidate() {
  const mapping = {
    id: "sess_aggregate_selected_001",
    name: "aggregate-selected-session",
    codex_thread_id: "thread-aggregate-selected-001",
    cwd: "/home/simonli/work/aggregate-selected-session",
    runtime_source: "codex_app_server" as const,
    runtime_version: "0.144.0",
    disposition: "selected" as const,
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null
  };
  return {
    mapping,
    projection: {
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: createdAt,
        last_activity_at: null,
        branch: "main",
        model: "gpt-5.5-codex",
        goal: null,
        recent_summary: "Aggregate selected session created.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function appendCandidate(
  state: SelectedSessionState,
  index: number
): ProductionProjectionAppendInput {
  const capturedAt = isoTimestampSchema.parse(
    new Date(Date.parse(createdAt) + index * 60_000).toISOString()
  );
  const eventId = `aggregate-event-${index}`;
  const session = state.projection.session;
  return {
    session_id: state.mapping.id,
    expected_revision: selectedStateRevision(state),
    event: {
      captured_at: capturedAt,
      upstream_at: isoTimestampSchema.parse(createdAt),
      codex_event_id: eventId,
      codex_event_type: "item/agentMessage/delta",
      content_state: "complete",
      content_notice: null,
      type: "message",
      role: "agent",
      phase: "completed",
      item_id: codexItemIdSchema.parse(`item-${eventId}`),
      text: `Projection for aggregate event ${index}.`
    },
    next_session: {
      id: session.id,
      name: session.name,
      codex_thread_id: session.codex_thread_id,
      cwd: session.cwd,
      runtime_source: session.runtime_source,
      runtime_version: session.runtime_version,
      created_at: session.created_at,
      archived_at: session.archived_at,
      session_state: session.session_state,
      turn_state: "in_progress",
      attention: "watch",
      freshness: session.freshness,
      freshness_reason: session.freshness_reason,
      updated_at: capturedAt,
      last_activity_at: capturedAt,
      branch: session.branch,
      model: session.model,
      settings: session.settings,
      goal: session.goal,
      recent_summary: `Projection for aggregate event ${index}.`
    }
  };
}

function recoveryRecord() {
  return {
    operation_id: "op_aggregate_start_001",
    session_id: "sess_aggregate_selected_001",
    name: "aggregate-selected-session",
    cwd: "/home/simonli/work/aggregate-selected-session",
    codex_thread_id: null,
    state: "reserved",
    created_at: createdAt,
    updated_at: createdAt,
    error_code: null,
    error_message: null
  };
}

function compatibilityRecord() {
  const capabilities = [
    "thread_lifecycle",
    "turn_input",
    "turn_steer",
    "turn_interrupt",
    "model",
    "goal",
    "plan",
    "usage",
    "compact",
    "skills",
    "approvals",
    "multi_client"
  ] as const;
  return {
    id: "hostdeck_runtime",
    compatibility: {
      source: "codex_app_server",
      state: "ready",
      mutation_policy: "allowed",
      observed_version: "0.144.0",
      binding_id: "codex-app-server-0.144.0:sha256:aggregate-hardening",
      capabilities: capabilities.map((name) => ({
        name,
        state: name === "compact" ? "unavailable" : "available",
        reason: name === "compact" ? "compact is unavailable." : null
      })),
      checked_at: "2026-07-12T10:00:03.000Z",
      reason: null
    },
    recorded_at: "2026-07-12T10:00:03.000Z"
  };
}

function promptAuditRecord(operationId: string, id: string, recordAt: string) {
  return {
    id,
    operation_id: operationId,
    at: recordAt,
    actor: dashboardActor(),
    action: "prompt",
    target: managedSessionTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: { text_length: 17, source: "dashboard" },
    error_code: null
  };
}

function promptAuditTerminal(
  operationId: string,
  id: string,
  recordAt: string,
  outcome: "rejected" | "succeeded",
  errorCode: "validation_error" | null
) {
  return {
    ...promptAuditRecord(operationId, id, recordAt),
    phase: "terminal",
    outcome,
    payload_summary: { result: outcome === "succeeded" ? "turn_started" : "rejected" },
    error_code: errorCode
  };
}

function unsafeSecurityAuditRecord() {
  return {
    id: "audit:aggregate:unsafe:accepted",
    operation_id: "op_aggregate_unsafe_audit_001",
    at: "2026-07-12T10:03:00.000Z",
    actor: cliActor(),
    action: "pair_request",
    target: hostTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: {
      schema_version: 1,
      permission: "write",
      client_label_present: true,
      expires_at: "2026-07-12T10:13:00.000Z",
      transcript: fullTranscript,
      private_material: privateMaterial
    },
    error_code: null
  };
}

function deviceRevokeAuditAccepted() {
  return {
    id: "audit:aggregate:device-revoke:accepted",
    operation_id: "op_aggregate_device_revoke_001",
    at: "2026-07-12T12:00:04.500Z",
    actor: cliActor(),
    action: "device_revoke",
    target: { type: "device", device_id: selectedDeviceId },
    phase: "accepted",
    outcome: "accepted",
    payload_summary: { schema_version: 1, previously_revoked: false },
    error_code: null
  };
}

function deviceRevokeAuditSucceeded() {
  return {
    ...deviceRevokeAuditAccepted(),
    id: "audit:aggregate:device-revoke:terminal",
    at: "2026-07-12T12:00:05.100Z",
    phase: "terminal",
    outcome: "succeeded",
    payload_summary: { schema_version: 1, authority_invalidated: true }
  };
}

function lockAuditAccepted() {
  return {
    id: "audit:aggregate:lock:accepted",
    operation_id: "op_aggregate_lock_001",
    at: "2026-07-12T12:01:00.000Z",
    actor: cliActor(),
    action: "lock",
    target: hostTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: { schema_version: 1, requested_locked: true },
    error_code: null
  };
}

function lockAuditSucceeded() {
  return {
    ...lockAuditAccepted(),
    id: "audit:aggregate:lock:terminal",
    at: "2026-07-12T12:02:00.000Z",
    phase: "terminal",
    outcome: "succeeded",
    payload_summary: { schema_version: 1, locked: true }
  };
}

function dashboardActor() {
  return {
    type: "dashboard",
    device_id: selectedDeviceId,
    permission: "write",
    origin: "https://hostdeck.local"
  } as const;
}

function cliActor() {
  return {
    type: "cli",
    device_id: null,
    permission: "local_admin",
    origin: null
  } as const;
}

function managedSessionTarget() {
  return {
    type: "managed_session",
    session_id: "sess_aggregate_selected_001",
    codex_thread_id: "thread-aggregate-selected-001"
  } as const;
}

function hostTarget() {
  return { type: "host", host_id: "local_host" } as const;
}

function aggregateRetentionPolicy() {
  return {
    ...defaultRetentionPolicy,
    output_event_limit: 3,
    output_byte_limit: 1_000_000,
    audit_event_limit: 3,
    audit_retention_days: 365
  };
}

function inspectSchemaAndHealth(db: Database.Database): void {
  expectSqliteHealth(db);
  expect(schemaNames(db, "table")).toEqual([
    "audit_events",
    "auth_devices",
    "legacy_session_dispositions",
    "output_events",
    "pairing_claim_rate_global",
    "pairing_claim_rate_sources",
    "pairing_codes",
    "retention_boundaries",
    "schema_migrations",
    "selected_audit_events",
    "selected_projected_events",
    "selected_remote_ingress_admission_proof",
    "selected_remote_ingress_state",
    "selected_runtime_compatibility",
    "selected_session_projections",
    "selected_session_start_recovery",
    "selected_sessions",
    "session_metadata",
    "sessions",
    "settings"
  ]);
  expect(schemaNames(db, "index")).toEqual([
    "audit_events_at_idx",
    "audit_events_session_idx",
    "auth_devices_csrf_token_hash_idx",
    "output_events_session_order_idx",
    "pairing_claim_rate_sources_last_attempt_idx",
    "retention_boundaries_scope_applied_idx",
    "selected_audit_events_at_idx",
    "selected_audit_events_phase_at_operation_idx",
    "selected_projected_events_session_cursor_idx",
    "selected_sessions_created_idx"
  ]);
  expect(schemaNames(db, "trigger")).toEqual([
    "legacy_session_disposition_after_insert",
    "legacy_session_disposition_after_update",
    "selected_audit_events_no_update",
    "selected_audit_events_start_requires_empty",
    "selected_audit_events_terminal_requires_accepted",
    "selected_remote_ingress_admission_proof_invalidate",
    "selected_remote_ingress_generation_step",
    "selected_remote_ingress_initial_generation",
    "selected_remote_ingress_no_delete"
  ]);
  expect(
    db
      .prepare(
        "SELECT version, checksum FROM schema_migrations ORDER BY version ASC"
      )
      .all()
  ).toEqual(
    defaultMigrations.map(({ version, sql }) => ({
      version,
      checksum: createHash("sha256").update(sql).digest("hex")
    }))
  );
}

function expectSqliteHealth(db: Database.Database): void {
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
}

function inspectQueryPlans(db: Database.Database): void {
  expectPlanUses(
    db,
    "SELECT * FROM selected_projected_events WHERE session_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
    ["sess_aggregate_selected_001", 0, 100],
    /selected_projected_events_session_cursor_idx|sqlite_autoindex_selected_projected_events/u
  );
  expectPlanUses(
    db,
    "SELECT operation_id FROM selected_audit_events WHERE phase = ? AND at < ? ORDER BY at, operation_id LIMIT ?",
    ["terminal", maintenanceAt, 100],
    /selected_audit_events_phase_at_operation_idx/u
  );
  expectPlanUses(
    db,
    "SELECT * FROM auth_devices WHERE token_hash = ? LIMIT 1",
    [hashSecret(rawDeviceToken, { minLength: 24 })],
    /INDEX .+ \(token_hash=\?\)/u
  );
  expectPlanUses(
    db,
    "SELECT id FROM auth_devices WHERE csrf_token_hash = ? LIMIT 1",
    [hashSecret(rotatedCsrfToken, { minLength: 24 })],
    /auth_devices_csrf_token_hash_idx/u
  );
  expectPlanUses(
    db,
    "SELECT * FROM auth_devices WHERE id > ? ORDER BY id ASC LIMIT ?",
    ["client_cursor", 100],
    /INDEX .+ \(id>\?\)/u
  );
  expectPlanUses(
    db,
    "SELECT source_key FROM pairing_claim_rate_sources ORDER BY last_attempt_at, source_key LIMIT ?",
    [100],
    /pairing_claim_rate_sources_last_attempt_idx/u
  );
}

function expectPlanUses(
  db: Database.Database,
  sql: string,
  parameters: readonly (number | string)[],
  expected: RegExp
): void {
  const details = (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{
      readonly detail: string;
    }>
  ).map(({ detail }) => detail);
  expect(details.some((detail) => expected.test(detail)), details.join("\n")).toBe(
    true
  );
}

function schemaNames(
  db: Database.Database,
  type: "index" | "table" | "trigger"
): readonly string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all(type) as Array<{ readonly name: string }>
  ).map(({ name }) => name);
}

function expectCrossDomainCounts(db: Database.Database) {
  const tables = [
    "auth_devices",
    "legacy_session_dispositions",
    "pairing_claim_rate_global",
    "pairing_claim_rate_sources",
    "pairing_codes",
    "selected_audit_events",
    "selected_projected_events",
    "selected_runtime_compatibility",
    "selected_session_projections",
    "selected_session_start_recovery",
    "selected_sessions"
  ] as const;
  return Object.fromEntries(
    tables.map((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        readonly count: number;
      };
      return [table, row.count];
    })
  );
}

function crossDomainSnapshot(db: Database.Database): Readonly<Record<string, string>> {
  const queries = {
    auth_devices: "SELECT * FROM auth_devices ORDER BY id",
    pairing_claim_rate_global:
      "SELECT * FROM pairing_claim_rate_global ORDER BY id",
    pairing_claim_rate_sources:
      "SELECT * FROM pairing_claim_rate_sources ORDER BY source_key",
    pairing_codes: "SELECT * FROM pairing_codes ORDER BY id",
    selected_audit_events:
      "SELECT * FROM selected_audit_events ORDER BY operation_id, phase",
    selected_projected_events:
      "SELECT * FROM selected_projected_events ORDER BY session_id, cursor",
    selected_session_projections:
      "SELECT * FROM selected_session_projections ORDER BY session_id",
    selected_session_start_recovery:
      "SELECT * FROM selected_session_start_recovery ORDER BY operation_id",
    selected_sessions: "SELECT * FROM selected_sessions ORDER BY id"
  } as const;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(queries).map(([name, sql]) => [
        name,
        JSON.stringify(db.prepare(sql).all())
      ])
    )
  );
}

function createLayout() {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-selected-hardening-"));
  cleanup.push(root);
  const runtimeParent = join(root, "user-runtime");
  mkdirSync(runtimeParent, { mode: 0o700 });
  return {
    config_dir: join(root, "config"),
    state_dir: join(root, "state"),
    runtime_dir: join(runtimeParent, "hostdeck"),
    database_path: join(root, "state", "hostdeck.sqlite")
  };
}

function expectModes(paths: {
  readonly config_dir: string;
  readonly database_path: string;
  readonly lease_path: string;
  readonly runtime_dir: string;
  readonly state_dir: string;
}): void {
  expect(mode(paths.config_dir)).toBe(0o700);
  expect(mode(paths.state_dir)).toBe(0o700);
  expect(mode(paths.runtime_dir)).toBe(0o700);
  expect(mode(paths.database_path)).toBe(0o600);
  expect(mode(paths.lease_path)).toBe(0o600);
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function sqliteFiles(databasePath: string): readonly string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`].filter(
    existsSync
  );
}

function captureError(work: () => unknown): Error {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

function serializeError(error: unknown): string {
  const visited = new Set<unknown>();
  const serialize = (candidate: unknown): string => {
    if (visited.has(candidate)) return "<cycle>";
    if (!(candidate instanceof Error)) return JSON.stringify(candidate);
    visited.add(candidate);
    const fields = candidate as Error & {
      readonly cause?: unknown;
      readonly code?: unknown;
      readonly errors?: readonly unknown[];
      readonly retryAt?: unknown;
    };
    return [
      candidate.name,
      String(fields.code ?? ""),
      candidate.message,
      String(fields.retryAt ?? ""),
      JSON.stringify(candidate),
      fields.cause === undefined ? "" : serialize(fields.cause),
      ...(fields.errors ?? []).map(serialize)
    ].join(":");
  };
  return serialize(error);
}

function incrementingClock(): () => number {
  let value = 0;
  return () => value++;
}

function at(value: string): Date {
  return new Date(value);
}
