import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRetentionPolicy } from "@hostdeck/contracts";
import {
  openMigratedDatabase,
  runStartupAuditOrphanReconciliation,
  runStartupRetentionMaintenance,
  type StartupAuditOrphanReconciliationResult,
  type StartupRetentionMaintenanceResult
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  assertHostDeckStartupMaintenancePorts,
  createHostDeckStartupMaintenancePorts,
  isHostDeckStartupMaintenanceError,
  runHostDeckStartupMaintenance
} from "./host-startup-maintenance.js";

const cutoff = "2026-07-16T19:00:00.000Z";

describe("host startup maintenance health composition", () => {
  it("captures one cutoff, runs orphan reconciliation before retention, and returns ready storage truth", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    let clockCalls = 0;
    const ports = createHostDeckStartupMaintenancePorts({
      reconcileAuditOrphans(input) {
        calls.push("orphan");
        expect(Object.isFrozen(input)).toBe(true);
        expect(input).toEqual({
          eligible_before: cutoff,
          reconciled_at: cutoff,
          signal: controller.signal
        });
        return completeOrphan();
      },
      runRetention(input) {
        calls.push("retention");
        expect(Object.isFrozen(input)).toBe(true);
        expect(input).toEqual({ cutoff_at: cutoff, signal: controller.signal });
        return completeRetention();
      }
    });
    const summary = await runHostDeckStartupMaintenance({
      now: () => {
        clockCalls += 1;
        return new Date(cutoff);
      },
      ports,
      signal: controller.signal
    });

    expect(calls).toEqual(["orphan", "retention"]);
    expect(clockCalls).toBe(1);
    expect(summary).toEqual({
      cutoff_at: cutoff,
      status: "ready",
      orphan: {
        status: "complete",
        scan_complete: true,
        actionable_remaining: false,
        failure: false,
        reconciled_operation_count: 0,
        protected_recent_operation_count: 0
      },
      retention: {
        status: "complete",
        output_scan_complete: true,
        audit_scan_complete: true,
        output_actionable_remaining: false,
        audit_actionable_remaining: false,
        failure: false,
        pruned_event_count: 0,
        deleted_audit_operation_count: 0
      },
      storage_observation: {
        component: "storage",
        state: "ready",
        reasons: []
      }
    });
    expectDeepFrozen(summary);
    expect(Object.isFrozen(ports)).toBe(true);
    expect(() => assertHostDeckStartupMaintenancePorts(ports)).not.toThrow();
    expect(() =>
      assertHostDeckStartupMaintenancePorts(Object.freeze({ ...ports }))
    ).toThrow(TypeError);
  });

  it("reduces partial orphan and retention scans to bounded degraded storage reasons", async () => {
    const orphanDegraded = await runWithResults(
      degradedOrphan("batch_limit"),
      completeRetention()
    );
    expect(orphanDegraded).toMatchObject({
      status: "degraded",
      storage_observation: {
        state: "degraded",
        reasons: ["audit_reconciliation_degraded"]
      }
    });

    const retentionDegraded = await runWithResults(
      completeOrphan(),
      degradedRetention("output_batch_limit")
    );
    expect(retentionDegraded).toMatchObject({
      status: "degraded",
      storage_observation: {
        state: "degraded",
        reasons: ["retention_degraded"]
      }
    });

    const both = await runWithResults(
      degradedOrphan("timeout"),
      degradedRetention("audit_batch_limit")
    );
    expect(both.storage_observation).toEqual({
      component: "storage",
      state: "degraded",
      reasons: ["audit_reconciliation_degraded", "retention_degraded"]
    });
  });

  it("maps returned maintenance failures to failed storage without exposing failure codes", async () => {
    const calls: string[] = [];
    const summary = await runHostDeckStartupMaintenance({
      now: () => new Date(cutoff),
      ports: createHostDeckStartupMaintenancePorts({
        reconcileAuditOrphans() {
          calls.push("orphan");
          return degradedOrphan("storage_failure", "storage_unavailable");
        },
        runRetention() {
          calls.push("retention");
          return degradedRetention(
            "storage_failure",
            Object.freeze({ code: "sqlite_busy", scope: "output" as const })
          );
        }
      }),
      signal: new AbortController().signal
    });
    expect(calls).toEqual(["orphan", "retention"]);
    expect(summary).toMatchObject({
      status: "failed",
      orphan: { failure: true },
      retention: { failure: true },
      storage_observation: {
        component: "storage",
        state: "failed",
        reasons: ["startup_maintenance_failed"]
      }
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("storage_unavailable");
    expect(serialized).not.toContain("sqlite_busy");
  });

  it("rejects malformed orphan truth before retention and never retries", async () => {
    let orphanCalls = 0;
    let retentionCalls = 0;
    const malformed = Object.freeze({ ...completeOrphan(), extra: true });
    await expect(
      runHostDeckStartupMaintenance({
        now: () => new Date(cutoff),
        ports: createHostDeckStartupMaintenancePorts({
          reconcileAuditOrphans() {
            orphanCalls += 1;
            return malformed as never;
          },
          runRetention() {
            retentionCalls += 1;
            return completeRetention();
          }
        }),
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "orphan_contract_invalid" });
    expect(orphanCalls).toBe(1);
    expect(retentionCalls).toBe(0);

    await expect(
      runHostDeckStartupMaintenance({
        now: () => new Date(cutoff),
        ports: createHostDeckStartupMaintenancePorts({
          reconcileAuditOrphans: () => completeOrphan(),
          runRetention: () => ({ ...completeRetention() }) as never
        }),
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "retention_contract_invalid" });
  });

  it("wraps thrown ports with bounded cause-free stage errors and makes no retry", async () => {
    let orphanCalls = 0;
    const orphanError = await rejectedError(
      runHostDeckStartupMaintenance({
        now: () => new Date(cutoff),
        ports: createHostDeckStartupMaintenancePorts({
          reconcileAuditOrphans() {
            orphanCalls += 1;
            throw new Error("private database path and payload");
          },
          runRetention: () => completeRetention()
        }),
        signal: new AbortController().signal
      })
    );
    expect(orphanCalls).toBe(1);
    expect(orphanError).toMatchObject({ code: "orphan_failed" });
    expect(Object.hasOwn(orphanError as object, "cause")).toBe(false);

    let retentionCalls = 0;
    const retentionError = await rejectedError(
      runHostDeckStartupMaintenance({
        now: () => new Date(cutoff),
        ports: createHostDeckStartupMaintenancePorts({
          reconcileAuditOrphans: () => completeOrphan(),
          runRetention() {
            retentionCalls += 1;
            throw "private retention failure";
          }
        }),
        signal: new AbortController().signal
      })
    );
    expect(retentionCalls).toBe(1);
    expect(retentionError).toMatchObject({ code: "retention_failed" });
    expect(Object.hasOwn(retentionError as object, "cause")).toBe(false);
  });

  it("rejects invalid ports, clocks, signals, extra fields, and accessors before side effects", async () => {
    let portCalls = 0;
    const ports = createHostDeckStartupMaintenancePorts({
      reconcileAuditOrphans() {
        portCalls += 1;
        return completeOrphan();
      },
      runRetention() {
        portCalls += 1;
        return completeRetention();
      }
    });
    const invalid = [
      null,
      {},
      { now: () => new Date(cutoff), ports, signal: new AbortController().signal, extra: true },
      { now: 1, ports, signal: new AbortController().signal },
      { now: () => new Date(cutoff), ports: Object.freeze({ ...ports }), signal: new AbortController().signal },
      { now: () => new Date(cutoff), ports, signal: {} }
    ];
    for (const candidate of invalid) {
      await expect(runHostDeckStartupMaintenance(candidate as never)).rejects.toMatchObject({
        code: "configuration_invalid"
      });
    }
    await expect(
      runHostDeckStartupMaintenance({
        now: () => new Date(Number.NaN),
        ports,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "clock_invalid" });
    expect(portCalls).toBe(0);

    let accessorCalls = 0;
    const accessor = Object.defineProperty(
      { ports, signal: new AbortController().signal },
      "now",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return () => new Date(cutoff);
        }
      }
    );
    await expect(runHostDeckStartupMaintenance(accessor as never)).rejects.toMatchObject({
      code: "configuration_invalid"
    });
    expect(accessorCalls).toBe(0);

    let factoryAccessorCalls = 0;
    const factoryAccessor = Object.defineProperty(
      { runRetention: () => completeRetention() },
      "reconcileAuditOrphans",
      {
        enumerable: true,
        get() {
          factoryAccessorCalls += 1;
          return () => completeOrphan();
        }
      }
    );
    expect(() => createHostDeckStartupMaintenancePorts(factoryAccessor as never)).toThrow(
      expect.objectContaining({ code: "configuration_invalid" })
    );
    expect(factoryAccessorCalls).toBe(0);
  });

  it("passes an already-aborted signal unchanged and relies on bounded runner truth", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    let observedSignal: AbortSignal | null = null;
    const summary = await runHostDeckStartupMaintenance({
      now: () => new Date(cutoff),
      ports: createHostDeckStartupMaintenancePorts({
        reconcileAuditOrphans(input) {
          observedSignal = input.signal;
          return degradedOrphan("aborted");
        },
        runRetention(input) {
          expect(input.signal).toBe(controller.signal);
          return degradedRetention("aborted");
        }
      }),
      signal: controller.signal
    });
    expect(observedSignal).toBe(controller.signal);
    expect(summary.status).toBe("degraded");
    expect(JSON.stringify(summary)).not.toContain("private abort reason");
  });

  it("discards session identifiers and detailed maintenance reasons from the health summary", async () => {
    const privateSession = "sess_private_health_001";
    const retention = degradedRetention("newest_output_event_oversize", null, [
      privateSession
    ]);
    const summary = await runWithResults(completeOrphan(), retention);
    expect(summary).toMatchObject({
      status: "degraded",
      retention: { status: "degraded" },
      storage_observation: { reasons: ["retention_degraded"] }
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(privateSession);
    expect(serialized).not.toContain("newest_output_event_oversize");
  });

  it("composes the real migrated SQLite orphan and retention runners", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostdeck-health-maintenance-"));
    const opened = openMigratedDatabase(join(root, "state.sqlite"), {
      now: () => new Date(cutoff)
    });
    try {
      const summary = await runHostDeckStartupMaintenance({
        now: () => new Date(cutoff),
        ports: createHostDeckStartupMaintenancePorts({
          reconcileAuditOrphans(input) {
            return runStartupAuditOrphanReconciliation({
              db: opened.db,
              eligible_before: input.eligible_before,
              reconciled_at: input.reconciled_at,
              signal: input.signal,
              monotonic_now: () => 0
            });
          },
          runRetention(input) {
            return runStartupRetentionMaintenance({
              db: opened.db,
              retention: defaultRetentionPolicy,
              now: () => new Date(input.cutoff_at),
              signal: input.signal,
              monotonic_now: () => 0
            });
          }
        }),
        signal: new AbortController().signal
      });
      expect(summary).toMatchObject({
        cutoff_at: cutoff,
        status: "ready",
        orphan: { status: "complete", scan_complete: true },
        retention: {
          status: "complete",
          output_scan_complete: true,
          audit_scan_complete: true
        },
        storage_observation: { state: "ready", reasons: [] }
      });
    } finally {
      opened.db.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("brands and freezes startup errors without retaining thrown causes", async () => {
    const error = await rejectedError(
      runHostDeckStartupMaintenance({
        now: () => {
          throw new Error("private clock path");
        },
        ports: createHostDeckStartupMaintenancePorts({
          reconcileAuditOrphans: () => completeOrphan(),
          runRetention: () => completeRetention()
        }),
        signal: new AbortController().signal
      })
    );
    expect(isHostDeckStartupMaintenanceError(error)).toBe(true);
    expect(error).toMatchObject({ code: "clock_invalid" });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("private clock path");
  });
});

async function runWithResults(
  orphan: StartupAuditOrphanReconciliationResult,
  retention: StartupRetentionMaintenanceResult
) {
  return runHostDeckStartupMaintenance({
    now: () => new Date(cutoff),
    ports: createHostDeckStartupMaintenancePorts({
      reconcileAuditOrphans: () => orphan,
      runRetention: () => retention
    }),
    signal: new AbortController().signal
  });
}

function completeOrphan(): StartupAuditOrphanReconciliationResult {
  return Object.freeze({
    actionable_remaining: false,
    batch_count: 1,
    duration_ms: 0,
    eligible_before: cutoff,
    eligible_pending_operation_count: 0,
    failure: null,
    protected_recent_operation_count: 0,
    reasons: Object.freeze([]),
    reconciled_at: cutoff,
    reconciled_operation_count: 0,
    scan_complete: true,
    status: "complete",
    total_pending_operation_count: 0
  });
}

function degradedOrphan(
  reason: "aborted" | "batch_limit" | "clock_failure" | "storage_failure" | "timeout",
  failureCode: string | null = null
): StartupAuditOrphanReconciliationResult {
  return Object.freeze({
    actionable_remaining: reason === "batch_limit" ? true : null,
    batch_count: 1,
    duration_ms: 1,
    eligible_before: cutoff,
    eligible_pending_operation_count: null,
    failure: failureCode === null ? null : Object.freeze({ code: failureCode }),
    protected_recent_operation_count: null,
    reasons: Object.freeze([reason]),
    reconciled_at: cutoff,
    reconciled_operation_count: 0,
    scan_complete: false,
    status: "degraded",
    total_pending_operation_count: null
  });
}

function completeRetention(): StartupRetentionMaintenanceResult {
  return Object.freeze({
    audit: Object.freeze({
      actionable_remaining: false,
      batch_count: 1,
      deleted_operation_count: 0,
      deleted_record_count: 0,
      newest_trail_oversize: false,
      pending_blocks_policy: false,
      protected_pending_operation_count: 0,
      retained_record_count: 0,
      scan_complete: true
    }),
    cutoff_at: cutoff,
    duration_ms: 0,
    failure: null,
    output: Object.freeze({
      actionable_remaining: false,
      batch_count: 1,
      boundary_write_count: 0,
      newest_oversize_session_ids: Object.freeze([]),
      policy_violation_session_count: 0,
      pruned_event_count: 0,
      scan_complete: true,
      sessions_touched_count: 0
    }),
    reasons: Object.freeze([]),
    status: "complete"
  });
}

function degradedRetention(
  reason:
    | "aborted"
    | "audit_batch_limit"
    | "clock_failure"
    | "concurrent_output_change"
    | "newest_audit_trail_oversize"
    | "newest_output_event_oversize"
    | "output_batch_limit"
    | "protected_audit_operations"
    | "storage_failure"
    | "timeout",
  failure: StartupRetentionMaintenanceResult["failure"] = null,
  newestOversizeSessionIds: readonly string[] = []
): StartupRetentionMaintenanceResult {
  const auditDegraded = reason === "audit_batch_limit";
  const outputDegraded =
    reason === "output_batch_limit" || reason === "concurrent_output_change";
  return Object.freeze({
    audit: Object.freeze({
      actionable_remaining: auditDegraded,
      batch_count: 1,
      deleted_operation_count: 0,
      deleted_record_count: 0,
      newest_trail_oversize: reason === "newest_audit_trail_oversize",
      pending_blocks_policy: reason === "protected_audit_operations",
      protected_pending_operation_count:
        reason === "protected_audit_operations" ? 1 : 0,
      retained_record_count: 0,
      scan_complete: !auditDegraded && failure?.scope !== "audit"
    }),
    cutoff_at: cutoff,
    duration_ms: 1,
    failure,
    output: Object.freeze({
      actionable_remaining: outputDegraded,
      batch_count: 1,
      boundary_write_count: 0,
      newest_oversize_session_ids: Object.freeze([...newestOversizeSessionIds]),
      policy_violation_session_count: newestOversizeSessionIds.length,
      pruned_event_count: 0,
      scan_complete: !outputDegraded && failure?.scope !== "output",
      sessions_touched_count: 0
    }),
    reasons: Object.freeze([reason]),
    status: "degraded"
  });
}

function expectDeepFrozen(candidate: unknown): void {
  if (candidate === null || typeof candidate !== "object") return;
  expect(Object.isFrozen(candidate)).toBe(true);
  for (const value of Object.values(candidate)) expectDeepFrozen(value);
}

async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}
