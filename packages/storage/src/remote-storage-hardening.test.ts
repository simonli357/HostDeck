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
  defaultRetentionPolicy,
  type RemoteIngressState,
  remoteIngressStateSchema
} from "@hostdeck/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHostDeckDaemonLease,
  HostDeckDaemonLeaseError
} from "./daemon-lease.js";
import {
  HostDeckMigrationError,
  openMigratedDatabase,
  runMigrations
} from "./migration-runner.js";
import {
  defaultMigrations,
  type StorageMigration
} from "./migrations.js";
import {
  createRemoteIngressStateRepository,
  HostDeckRemoteIngressStateRepositoryError
} from "./remote-ingress-state-repository.js";
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
import { runStartupAuditOrphanReconciliation } from "./startup-audit-orphan-reconciliation.js";
import { runStartupRetentionMaintenance } from "./startup-retention-maintenance.js";

const cleanup: string[] = [];
const primaryOrigin = "https://hostdeck-hardening.fixture-tailnet.ts.net";
const secondaryOrigin = "https://hostdeck-hardening.other-tailnet.ts.net";
const primaryProfileKey = `sha256:${"1".repeat(64)}`;
const secondaryProfileKey = `sha256:${"2".repeat(64)}`;
const activeOtherProfileKey = `sha256:${"3".repeat(64)}`;
const forbiddenSentinels = [
  "remote-hardening-pairing-fragment-357357",
  "remote-hardening-pairing-code-654321",
  "tskey-auth-remote-hardening-private",
  "remote-hardening-account@example.test",
  "remote-hardening-full-profile-node-identity",
  "remote-hardening-raw-tailscale-cli-output",
  "https://foreign-node.remote-hardening.ts.net"
] as const;

afterEach(() => {
  for (const root of cleanup.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("remote state and audit aggregate hardening", () => {
  it("preserves combined remote truth through secure upgrade, restart, maintenance, and corruption probes", () => {
    const layout = createLayout();
    const paths = resolveHostDeckLocalPaths(layout);
    const observedErrors: Error[] = [];

    expect(prepareHostDeckDaemonLeasePath(paths)).toEqual([]);
    const firstLease = acquireHostDeckDaemonLease({
      lease_path: paths.lease_path,
      now: () => at("2026-07-13T08:55:00.000Z"),
      pid: 35_792
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

      const prior = openMigratedDatabase(paths.database_path, {
        migrations: migrationsBeforeRemoteStorage(),
        now: fixedNow
      });
      let historicalBefore: readonly unknown[];
      try {
        insertHistoricalTrail(prior.db);
        historicalBefore = rawAuditRows(prior.db);
        expect(prior.result.currentVersion).toBe(
          migrationsBeforeRemoteStorage().at(-1)?.version
        );
      } finally {
        prior.db.close();
      }

      const current = openMigratedDatabase(paths.database_path, { now: fixedNow });
      try {
        expect(current.result).toEqual({
          applied: [
            "202607130013_remote_ingress_state",
            "202607130014_remote_audit_catalog",
            "202607130015_remote_admission_proof",
            "202607150016_session_start_audit_catalog",
            "202607160017_selected_session_settings_projection",
            "202607200018_selected_network_retirement"
          ],
          currentVersion: "202607200018_selected_network_retirement"
        });
        expect(rawAuditRows(current.db)).toEqual(historicalBefore);
        expect(
          current.db
            .prepare("SELECT COUNT(*) AS count FROM selected_remote_ingress_state")
            .get()
        ).toEqual({ count: 0 });
        inspectSchemaAndHealth(current.db);

        const state = createRemoteIngressStateRepository(current.db);
        const audit = createSelectedAuditRepository(current.db);

        audit.recordAccepted(
          remoteAccepted(
            "remote_enable",
            "op_remote_hardening_enable_initial",
            "2026-07-13T10:00:00.000Z"
          )
        );
        state.compareAndSet({
          expected_generation: null,
          state: readyState(1, primarySelection, "2026-07-13T10:00:01.000Z")
        });
        audit.recordTerminal(
          remoteSucceeded(
            "remote_enable",
            "op_remote_hardening_enable_initial",
            "2026-07-13T10:00:02.000Z"
          )
        );

        state.compareAndSet({
          expected_generation: 1,
          state: profileAwayState(2, "2026-07-13T10:01:00.000Z")
        });
        state.compareAndSet({
          expected_generation: 2,
          state: readyState(3, primarySelection, "2026-07-13T10:02:00.000Z")
        });
        state.compareAndSet({
          expected_generation: 3,
          state: foreignServeState(4, "2026-07-13T10:03:00.000Z")
        });
        audit.recordRejected(
          remoteRejected(
            "remote_enable",
            "op_remote_hardening_foreign_serve",
            "serve_foreign",
            "foreign",
            "2026-07-13T10:03:01.000Z"
          )
        );
        state.compareAndSet({
          expected_generation: 4,
          state: readyState(5, primarySelection, "2026-07-13T10:04:00.000Z")
        });

        audit.recordAccepted(
          remoteAccepted(
            "remote_disable",
            "op_remote_hardening_disable_cleanup",
            "2026-07-13T10:05:00.000Z"
          )
        );
        state.compareAndSet({
          expected_generation: 5,
          state: cleanupIncompleteState(6, "2026-07-13T10:05:01.000Z")
        });
        audit.recordTerminal(
          remoteCleanupIncomplete(
            "op_remote_hardening_disable_cleanup",
            "2026-07-13T10:05:02.000Z"
          )
        );

        const prematureSelectionError = captureError(() =>
          state.compareAndSet({
            expected_generation: 6,
            state: disabledAbsentState(
              7,
              secondarySelection,
              "2026-07-13T10:06:00.000Z"
            )
          })
        );
        observedErrors.push(prematureSelectionError);
        expect(prematureSelectionError).toBeInstanceOf(
          HostDeckRemoteIngressStateRepositoryError
        );
        expect(prematureSelectionError).toMatchObject({
          code: "remote_ingress_selection_conflict"
        });
        state.compareAndSet({
          expected_generation: 6,
          state: disabledAbsentState(
            7,
            primarySelection,
            "2026-07-13T10:06:00.000Z"
          )
        });
        state.compareAndSet({
          expected_generation: 7,
          state: disabledAbsentState(
            8,
            secondarySelection,
            "2026-07-13T10:07:00.000Z"
          )
        });

        audit.recordAccepted(
          remoteAccepted(
            "remote_enable",
            "op_remote_hardening_enable_race",
            "2026-07-13T10:07:01.000Z"
          )
        );
        const contender = openMigratedDatabase(paths.database_path, {
          now: fixedNow
        });
        try {
          const contenderState = createRemoteIngressStateRepository(contender.db);
          const contenderAudit = createSelectedAuditRepository(contender.db);
          state.compareAndSet({
            expected_generation: 8,
            state: readyState(
              9,
              secondarySelection,
              "2026-07-13T10:07:02.000Z"
            )
          });
          const staleStateError = captureError(() =>
            contenderState.compareAndSet({
              expected_generation: 8,
              state: disabledAbsentState(
                9,
                secondarySelection,
                "2026-07-13T10:07:02.000Z"
              )
            })
          );
          observedErrors.push(staleStateError);
          expect(staleStateError).toMatchObject({
            code: "remote_ingress_conflict"
          });

          audit.recordTerminal(
            remoteSucceeded(
              "remote_enable",
              "op_remote_hardening_enable_race",
              "2026-07-13T10:07:03.000Z"
            )
          );
          const losingTerminalError = captureError(() =>
            contenderAudit.recordTerminal(
              remoteFailed(
                "remote_enable",
                "op_remote_hardening_enable_race",
                "2026-07-13T10:07:03.000Z"
              )
            )
          );
          observedErrors.push(losingTerminalError);
          expect(losingTerminalError).toMatchObject({
            code: "audit_operation_terminal"
          });
        } finally {
          contender.db.close();
        }

        audit.recordAccepted(
          remoteAccepted(
            "remote_disable",
            "op_remote_hardening_orphan_disable",
            "2026-07-13T10:09:00.000Z"
          )
        );

        const hostileState = {
          ...readyState(10, secondarySelection, "2026-07-13T10:10:00.000Z"),
          raw_observation: Object.fromEntries(
            forbiddenSentinels.map((sentinel, index) => [`private_${index}`, sentinel])
          )
        };
        const hostileStateError = captureError(() =>
          state.compareAndSet({
            expected_generation: 9,
            state: hostileState as RemoteIngressState
          })
        );
        observedErrors.push(hostileStateError);
        expect(hostileStateError).toMatchObject({
          code: "invalid_remote_ingress_state"
        });

        const hostileAuditError = captureError(() =>
          audit.recordRejected(
            hostileRemoteRejected("op_remote_hardening_hostile_audit")
          )
        );
        observedErrors.push(hostileAuditError);
        expect(hostileAuditError).toBeInstanceOf(
          HostDeckSelectedAuditRepositoryError
        );
        expect(hostileAuditError).toMatchObject({ code: "invalid_audit_record" });
        expect(hostileAuditError.cause).toBeUndefined();

        expect(state.read()).toEqual(
          readyState(9, secondarySelection, "2026-07-13T10:07:02.000Z")
        );
        expect(audit.require("op_remote_hardening_orphan_disable").state).toBe(
          "pending"
        );
        expect(audit.get("op_remote_hardening_hostile_audit")).toBeNull();
        expect(
          current.db
            .prepare("SELECT COUNT(*) AS count FROM selected_audit_events")
            .get()
        ).toEqual({ count: 10 });
        inspectRemoteQueryPlans(current.db);
      } finally {
        current.db.close();
      }
    } finally {
      firstLease.release();
    }
    expect(firstLease.released).toBe(true);

    const restartLease = acquireHostDeckDaemonLease({
      lease_path: paths.lease_path,
      now: () => at("2026-07-13T10:15:00.000Z"),
      pid: 35_793
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
        now: () => at("2026-07-13T10:20:00.000Z")
      });
      try {
        expect(restarted.result).toEqual({
          applied: [],
          currentVersion: "202607200018_selected_network_retirement"
        });
        const state = createRemoteIngressStateRepository(restarted.db);
        const audit = createSelectedAuditRepository(restarted.db);
        expect(state.read()).toEqual(
          readyState(9, secondarySelection, "2026-07-13T10:07:02.000Z")
        );
        expect(audit.require("op_remote_hardening_orphan_disable").state).toBe(
          "pending"
        );

        const reconciliation = runStartupAuditOrphanReconciliation({
          db: restarted.db,
          eligible_before: "2026-07-13T10:10:00.000Z",
          reconciled_at: "2026-07-13T10:20:00.000Z",
          batch_operation_limit: 2,
          monotonic_now: incrementingClock(),
          timeout_ms: 1_000
        });
        expect(reconciliation).toMatchObject({
          status: "complete",
          scan_complete: true,
          reconciled_operation_count: 1,
          protected_recent_operation_count: 0,
          total_pending_operation_count: 0,
          failure: null,
          reasons: []
        });
        expect(
          audit.require("op_remote_hardening_orphan_disable").records[1]
        ).toMatchObject({
          action: "remote_disable",
          outcome: "incomplete",
          error_code: "runtime_unavailable",
          payload_summary: {
            action: "remote_disable",
            phase: "terminal",
            outcome: "incomplete",
            admission: "closed",
            intent_persisted: "unknown",
            serve_result: "unknown",
            reason: "observation_failed",
            reconciliation_reason: "host_restart_without_terminal"
          }
        });

        const retention = runStartupRetentionMaintenance({
          db: restarted.db,
          batch_record_limit: 100,
          max_batches_per_scope: 10,
          monotonic_now: incrementingClock(),
          now: () => at("2026-07-13T10:30:00.000Z"),
          retention: remoteRetentionPolicy(),
          timeout_ms: 1_000
        });
        expect(retention).toMatchObject({
          status: "complete",
          reasons: [],
          failure: null,
          audit: {
            actionable_remaining: false,
            deleted_operation_count: 4,
            deleted_record_count: 7,
            pending_blocks_policy: false,
            protected_pending_operation_count: 0,
            retained_record_count: 4,
            scan_complete: true
          }
        });
        expect(audit.get("op_remote_hardening_historical")).toBeNull();
        expect(audit.get("op_remote_hardening_enable_initial")).toBeNull();
        expect(audit.get("op_remote_hardening_foreign_serve")).toBeNull();
        expect(audit.get("op_remote_hardening_disable_cleanup")).toBeNull();
        expect(audit.require("op_remote_hardening_enable_race").state).toBe(
          "terminal"
        );
        expect(audit.require("op_remote_hardening_orphan_disable").state).toBe(
          "terminal"
        );

        inspectSchemaAndHealth(restarted.db);
        inspectRemoteQueryPlans(restarted.db);
        expect(
          restarted.db
            .prepare("SELECT COUNT(*) AS count FROM selected_remote_ingress_state")
            .get()
        ).toEqual({ count: 1 });
        expect(
          restarted.db
            .prepare("SELECT COUNT(*) AS count FROM selected_audit_events")
            .get()
        ).toEqual({ count: 4 });

        const auditBeforeStateCorruption = rawAuditRows(restarted.db);
        restarted.db.exec("BEGIN IMMEDIATE");
        try {
          restarted.db
            .prepare(
              "UPDATE selected_remote_ingress_state SET generation = 10, availability = 'disabled'"
            )
            .run();
          const corruptStateError = captureError(() => state.read());
          observedErrors.push(corruptStateError);
          expect(corruptStateError).toMatchObject({
            code: "invalid_persisted_remote_ingress_state"
          });
          expect(rawAuditRows(restarted.db)).toEqual(auditBeforeStateCorruption);
        } finally {
          restarted.db.exec("ROLLBACK");
        }
        expect(state.read()).toEqual(
          readyState(9, secondarySelection, "2026-07-13T10:07:02.000Z")
        );

        const stateBeforeAuditCorruption = rawRemoteState(restarted.db);
        restarted.db.exec("BEGIN IMMEDIATE");
        try {
          restarted.db.exec("DROP TRIGGER selected_audit_events_no_update");
          restarted.db
            .prepare(
              "UPDATE selected_audit_events SET record_json = '{\"schema_version\":1}' WHERE operation_id = ? AND phase = 'terminal'"
            )
            .run("op_remote_hardening_enable_race");
          const corruptAuditError = captureError(() =>
            audit.require("op_remote_hardening_enable_race")
          );
          observedErrors.push(corruptAuditError);
          expect(corruptAuditError).toMatchObject({
            code: "invalid_audit_trail"
          });
          expect(rawRemoteState(restarted.db)).toEqual(stateBeforeAuditCorruption);
        } finally {
          restarted.db.exec("ROLLBACK");
        }
        expect(audit.require("op_remote_hardening_enable_race").state).toBe(
          "terminal"
        );
        inspectSchemaAndHealth(restarted.db);
      } finally {
        restarted.db.close();
      }

      const readOnly = openMigratedDatabase(paths.database_path, {
        readonly: true,
        now: () => at("2026-07-13T10:31:00.000Z")
      });
      try {
        expect(
          createRemoteIngressStateRepository(readOnly.db).read()
        ).toEqual(
          readyState(9, secondarySelection, "2026-07-13T10:07:02.000Z")
        );
        expect(
          createSelectedAuditRepository(readOnly.db).require(
            "op_remote_hardening_orphan_disable"
          ).state
        ).toBe("terminal");
        inspectSchemaAndHealth(readOnly.db);
      } finally {
        readOnly.db.close();
      }
    } finally {
      restartLease.release();
    }
    expect(restartLease.released).toBe(true);
    expectModes(paths);

    for (const file of sqliteFiles(paths.database_path)) {
      const bytes = readFileSync(file);
      for (const sentinel of forbiddenSentinels) {
        expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
      }
    }
    const durableBytes = readFileSync(paths.database_path).toString("utf8");
    expect(durableBytes).toContain(secondaryOrigin);
    expect(durableBytes).toContain(secondaryProfileKey);
    for (const error of observedErrors) {
      const serialized = serializeError(error);
      for (const sentinel of forbiddenSentinels) {
        expect(serialized).not.toContain(sentinel);
      }
    }
    for (const path of Object.values(paths)) {
      for (const sentinel of forbiddenSentinels) {
        expect(path).not.toContain(sentinel);
      }
    }
  });

  it("keeps each remote migration atomic and opens a fresh current database", () => {
    const fresh = openMigratedDatabase(tempDbPath("fresh"), { now: fixedNow });
    try {
      expect(fresh.result.applied).toHaveLength(defaultMigrations.length);
      expect(fresh.result.currentVersion).toBe(
        "202607200018_selected_network_retirement"
      );
      inspectSchemaAndHealth(fresh.db);
    } finally {
      fresh.db.close();
    }

    const stateFailurePath = tempDbPath("state-failure");
    const statePrior = openMigratedDatabase(stateFailurePath, {
      migrations: migrationsBeforeRemoteStorage(),
      now: fixedNow
    });
    statePrior.db.close();
    const stateFailureDb = new Database(stateFailurePath);
    try {
      const stateMigration = defaultMigrations.find(
        (migration) => migration.version === "202607130013_remote_ingress_state"
      );
      if (stateMigration === undefined) throw new Error("Missing remote state migration.");
      const interruptedState = {
        ...stateMigration,
        sql: `${stateMigration.sql}\nSELECT * FROM forced_remote_state_hardening_failure;`
      } satisfies StorageMigration;
      expect(() =>
        runMigrations(stateFailureDb, {
          migrations: [...migrationsBeforeRemoteStorage(), interruptedState],
          now: fixedNow
        })
      ).toThrow(HostDeckMigrationError);
      expect(
        stateFailureDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'selected_remote_ingress_state'"
          )
          .get()
      ).toBeUndefined();
      expect(migrationCount(stateFailureDb)).toBe(
        migrationsBeforeRemoteStorage().length
      );
    } finally {
      stateFailureDb.close();
    }

    const auditFailurePath = tempDbPath("audit-failure");
    const auditPriorMigrations = migrationsBefore("202607130014_remote_audit_catalog");
    const auditPrior = openMigratedDatabase(auditFailurePath, {
      migrations: auditPriorMigrations,
      now: fixedNow
    });
    let auditTableBefore: string;
    let auditRowsBefore: readonly unknown[];
    try {
      insertHistoricalTrail(auditPrior.db);
      auditTableBefore = selectedAuditTableSql(auditPrior.db);
      auditRowsBefore = rawAuditRows(auditPrior.db);
    } finally {
      auditPrior.db.close();
    }
    const auditFailureDb = new Database(auditFailurePath);
    try {
      const auditMigration = defaultMigrations.find(
        (migration) => migration.version === "202607130014_remote_audit_catalog"
      );
      if (auditMigration === undefined) throw new Error("Missing remote audit migration.");
      const interruptedAudit = {
        ...auditMigration,
        sql: `${auditMigration.sql}\nSELECT * FROM forced_remote_audit_hardening_failure;`
      } satisfies StorageMigration;
      expect(() =>
        runMigrations(auditFailureDb, {
          migrations: [...auditPriorMigrations, interruptedAudit],
          now: fixedNow
        })
      ).toThrow(HostDeckMigrationError);
      expect(selectedAuditTableSql(auditFailureDb)).toBe(auditTableBefore);
      expect(rawAuditRows(auditFailureDb)).toEqual(auditRowsBefore);
      expect(migrationCount(auditFailureDb)).toBe(auditPriorMigrations.length);
    } finally {
      auditFailureDb.close();
    }
  });
});

interface Selection {
  readonly origin: string;
  readonly profileKey: string;
}

const primarySelection: Selection = {
  origin: primaryOrigin,
  profileKey: primaryProfileKey
};
const secondarySelection: Selection = {
  origin: secondaryOrigin,
  profileKey: secondaryProfileKey
};

function readyState(
  generation: number,
  selection: Selection,
  timestamp: string
): RemoteIngressState {
  return parseState({
    schema_version: 1,
    generation,
    intent: "enabled",
    availability: "ready",
    admission: "open",
    observation: "current",
    client: "available",
    profile: dedicatedProfile(selection.profileKey),
    serve: "exact",
    expected_serve: serveDescriptor(selection.origin),
    external_origin: selection.origin,
    operation_failure: null,
    reason: null,
    observed_at: timestamp,
    updated_at: timestamp
  });
}

function profileAwayState(
  generation: number,
  timestamp: string
): RemoteIngressState {
  return parseState({
    ...readyState(generation, primarySelection, timestamp),
    availability: "unavailable",
    admission: "closed",
    profile: {
      state: "other",
      comparison: {
        relation: "different",
        expected_profile_key: primaryProfileKey,
        active_profile_key: activeOtherProfileKey
      }
    },
    serve: null,
    operation_failure: "profile_changed",
    reason: "profile_changed"
  });
}

function foreignServeState(
  generation: number,
  timestamp: string
): RemoteIngressState {
  return parseState({
    ...readyState(generation, primarySelection, timestamp),
    availability: "unavailable",
    admission: "closed",
    serve: "foreign",
    reason: "serve_foreign"
  });
}

function cleanupIncompleteState(
  generation: number,
  timestamp: string
): RemoteIngressState {
  return parseState({
    ...readyState(generation, primarySelection, timestamp),
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    operation_failure: "cleanup_incomplete",
    reason: "cleanup_incomplete"
  });
}

function disabledAbsentState(
  generation: number,
  selection: Selection,
  timestamp: string
): RemoteIngressState {
  return parseState({
    ...readyState(generation, selection, timestamp),
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    serve: "absent"
  });
}

function dedicatedProfile(profileKey: string) {
  return {
    state: "dedicated",
    comparison: {
      relation: "match",
      expected_profile_key: profileKey,
      active_profile_key: profileKey
    }
  } as const;
}

function serveDescriptor(origin: string) {
  return {
    external_origin: origin,
    https_port: 443,
    path: "/",
    proxy_origin: "http://127.0.0.1:3777",
    visibility: "private"
  } as const;
}

function parseState(input: unknown): RemoteIngressState {
  return remoteIngressStateSchema.parse(input);
}

function remoteAccepted(
  action: "remote_disable" | "remote_enable",
  operationId: string,
  timestamp: string
) {
  return {
    id: auditId(operationId, "accepted"),
    operation_id: operationId,
    at: timestamp,
    actor: cliActor(),
    action,
    target: hostTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: {
      schema_version: 1,
      action,
      requested_intent: action === "remote_enable" ? "enabled" : "disabled",
      profile_state: "dedicated",
      serve_state: action === "remote_enable" ? "absent" : "exact",
      phase: "accepted",
      outcome: "accepted"
    },
    error_code: null
  } as const;
}

function remoteSucceeded(
  action: "remote_disable" | "remote_enable",
  operationId: string,
  timestamp: string
) {
  return {
    ...remoteAccepted(action, operationId, timestamp),
    id: auditId(operationId, "terminal"),
    phase: "terminal",
    outcome: "succeeded",
    payload_summary: {
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
    },
    error_code: null
  } as const;
}

function remoteFailed(
  action: "remote_disable" | "remote_enable",
  operationId: string,
  timestamp: string
) {
  return {
    ...remoteAccepted(action, operationId, timestamp),
    id: auditId(operationId, "terminal"),
    phase: "terminal",
    outcome: "failed",
    payload_summary: {
      schema_version: 1,
      action,
      requested_intent: action === "remote_enable" ? "enabled" : "disabled",
      profile_state: "dedicated",
      serve_state: action === "remote_enable" ? "absent" : "exact",
      phase: "terminal",
      outcome: "failed",
      admission: "closed",
      intent_persisted: false,
      serve_result: "not_attempted",
      reason: "command_failed"
    },
    error_code: "runtime_unavailable"
  } as const;
}

function remoteCleanupIncomplete(operationId: string, timestamp: string) {
  return {
    ...remoteAccepted("remote_disable", operationId, timestamp),
    id: auditId(operationId, "terminal"),
    phase: "terminal",
    outcome: "incomplete",
    payload_summary: {
      schema_version: 1,
      action: "remote_disable",
      requested_intent: "disabled",
      profile_state: "dedicated",
      serve_state: "exact",
      phase: "terminal",
      outcome: "incomplete",
      admission: "closed",
      intent_persisted: true,
      serve_result: "unknown",
      reason: "cleanup_incomplete"
    },
    error_code: "runtime_unavailable"
  } as const;
}

function remoteRejected(
  action: "remote_disable" | "remote_enable",
  operationId: string,
  reason: "profile_other" | "serve_foreign",
  serveState: "foreign" | null,
  timestamp: string
) {
  return {
    ...remoteAccepted(action, operationId, timestamp),
    id: auditId(operationId, "terminal"),
    phase: "terminal",
    outcome: "rejected",
    payload_summary: {
      schema_version: 1,
      action,
      requested_intent: action === "remote_enable" ? "enabled" : "disabled",
      profile_state: reason === "profile_other" ? "other" : "dedicated",
      serve_state: serveState,
      phase: "terminal",
      outcome: "rejected",
      admission: "closed",
      intent_persisted: false,
      serve_result: "not_attempted",
      reason
    },
    error_code: "validation_error"
  } as const;
}

function hostileRemoteRejected(operationId: string) {
  const record = remoteRejected(
    "remote_enable",
    operationId,
    "profile_other",
    null,
    "2026-07-13T10:10:00.000Z"
  );
  return {
    ...record,
    payload_summary: {
      ...record.payload_summary,
      private_remote_material: [...forbiddenSentinels]
    }
  };
}

function insertHistoricalTrail(db: Database.Database): void {
  const accepted = {
    id: "audit:remote-hardening:historical:accepted",
    operation_id: "op_remote_hardening_historical",
    at: "2026-07-13T09:00:00.000Z",
    actor: cliActor(),
    action: "lan_disable",
    target: hostTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: {
      schema_version: 1,
      requested_lan_enabled: false
    },
    error_code: null
  } as const;
  const terminal = {
    ...accepted,
    id: "audit:remote-hardening:historical:terminal",
    at: "2026-07-13T09:01:00.000Z",
    phase: "terminal",
    outcome: "succeeded",
    payload_summary: { schema_version: 1, lan_enabled: false }
  } as const;
  for (const record of [accepted, terminal]) {
    db.prepare(
      `
        INSERT INTO selected_audit_events (
          id, operation_id, at, action, security_schema_version,
          phase, outcome, error_code, record_json
        ) VALUES (
          @id, @operation_id, @at, @action, 1,
          @phase, @outcome, @error_code, @record_json
        )
      `
    ).run({ ...record, record_json: JSON.stringify(record) });
  }
}

function auditId(
  operationId: string,
  phase: "accepted" | "terminal"
): string {
  return `audit:${operationId.replace(/^op_/u, "")}:${phase}`;
}

function cliActor() {
  return {
    type: "cli",
    device_id: null,
    permission: "local_admin",
    origin: null
  } as const;
}

function hostTarget() {
  return { type: "host", host_id: "local_host" } as const;
}

function migrationsBeforeRemoteStorage(): readonly StorageMigration[] {
  const migrations = migrationsBefore("202607130013_remote_ingress_state");
  if (migrations.at(-1)?.version !== "202607120012_selected_lan_configuration") {
    throw new Error("Remote storage migrations do not follow selected LAN storage.");
  }
  return migrations;
}

function migrationsBefore(version: string): readonly StorageMigration[] {
  const index = defaultMigrations.findIndex((migration) => migration.version === version);
  if (index < 0) throw new Error(`Unknown migration boundary ${version}.`);
  return defaultMigrations.slice(0, index);
}

function inspectSchemaAndHealth(db: Database.Database): void {
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
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
      .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all()
  ).toEqual(
    defaultMigrations.map(({ version, sql }) => ({
      version,
      checksum: createHash("sha256").update(sql).digest("hex")
    }))
  );
}

function inspectRemoteQueryPlans(db: Database.Database): void {
  expectPlanUses(
    db,
    "SELECT * FROM selected_remote_ingress_state WHERE id = ?",
    ["hostdeck_remote_ingress"],
    /sqlite_autoindex_selected_remote_ingress_state_1/u
  );
  expectPlanUses(
    db,
    "SELECT operation_id FROM selected_audit_events WHERE phase = ? AND at < ? ORDER BY at, operation_id LIMIT ?",
    ["accepted", "2026-07-13T10:20:00.000Z", 100],
    /selected_audit_events_phase_at_operation_idx/u
  );
  expectPlanUses(
    db,
    "SELECT operation_id FROM selected_audit_events WHERE phase = ? AND at < ? ORDER BY at, operation_id LIMIT ?",
    ["terminal", "2026-07-13T10:30:00.000Z", 100],
    /selected_audit_events_phase_at_operation_idx/u
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

function rawAuditRows(db: Database.Database): readonly unknown[] {
  return db
    .prepare(
      `
        SELECT id, operation_id, at, action, security_schema_version,
               phase, outcome, error_code, record_json,
               hex(CAST(record_json AS BLOB)) AS record_hex
        FROM selected_audit_events
        ORDER BY operation_id, phase, id
      `
    )
    .all();
}

function rawRemoteState(db: Database.Database): unknown {
  return db
    .prepare("SELECT * FROM selected_remote_ingress_state ORDER BY id")
    .all();
}

function selectedAuditTableSql(db: Database.Database): string {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'selected_audit_events'"
    )
    .get() as { readonly sql: string } | undefined;
  if (row === undefined) throw new Error("Selected audit table is missing.");
  return row.sql;
}

function migrationCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
    .get() as { readonly count: number };
  return row.count;
}

function remoteRetentionPolicy() {
  return {
    ...defaultRetentionPolicy,
    audit_event_limit: 5,
    audit_retention_days: 365
  };
}

function createLayout() {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-remote-storage-hardening-"));
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

function tempDbPath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-remote-${label}-`));
  cleanup.push(root);
  return join(root, "hostdeck.sqlite");
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
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`
  ].filter(existsSync);
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
    };
    return [
      candidate.name,
      String(fields.code ?? ""),
      candidate.message,
      JSON.stringify(candidate),
      fields.cause === undefined ? "" : serialize(fields.cause),
      ...(fields.errors ?? []).map(serialize)
    ].join(":");
  };
  return serialize(error);
}

function incrementingClock(): () => number {
  let now = 0;
  return () => {
    now += 1;
    return now;
  };
}

function at(timestamp: string): Date {
  return new Date(timestamp);
}

function fixedNow(): Date {
  return at("2026-07-13T08:50:00.000Z");
}
