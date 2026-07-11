import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RetentionPolicy,
  type SelectedProjectedEventRecord,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  maintainSelectedAuditRetentionBatch
} from "./selected-audit-repository.js";
import {
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  maintainSelectedProjectionRetentionBatch,
  type SelectedSessionState,
  type SelectedStateRepository,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "./selected-state-repository.js";
import {
  HostDeckStartupRetentionMaintenanceError,
  runStartupRetentionMaintenance
} from "./startup-retention-maintenance.js";

const tempDirs: string[] = [];
const sessionCreatedAt = "2026-07-10T10:00:00.000Z";
const eventCapturedAt = "2026-07-10T10:01:00.000Z";
const maintenanceNow = "2026-07-10T12:00:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected projection retention batches", () => {
  it("prunes only one real-event batch, advances its boundary, and resumes after reopen", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(first.db);
      appendMessages(repository, repository.create(stateCandidate(1)), 5);

      const partial = maintainSelectedProjectionRetentionBatch(first.db, {
        max_pruned_events: 2,
        retention: retentionPolicy({ output_event_limit: 2 }),
        session_id: "sess_retention_001"
      });

      expect(partial).toMatchObject({
        boundary_replaced: false,
        newest_event_oversize: false,
        pruned_event_count: 2,
        remaining: true,
        projection: {
          earliest_retained_cursor: 2,
          retained_event_count: 4,
          retention_boundary_cursor: 1
        }
      });
      expect(Object.isFrozen(partial)).toBe(true);
      expect(rawOutputRows(first.db, "sess_retention_001")).toEqual([
        { cursor: 2, normalized_type: "replay_boundary" },
        { cursor: 3, normalized_type: "message" },
        { cursor: 4, normalized_type: "message" },
        { cursor: 5, normalized_type: "message" }
      ]);
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const resumed = maintainSelectedProjectionRetentionBatch(second.db, {
        max_pruned_events: 2,
        retention: retentionPolicy({ output_event_limit: 2 }),
        session_id: "sess_retention_001"
      });
      const projection = createSelectedStateRepository(second.db).require("sess_retention_001").projection;

      expect(resumed).toMatchObject({
        boundary_replaced: true,
        newest_event_oversize: false,
        pruned_event_count: 2,
        remaining: false,
        projection: {
          earliest_retained_cursor: 4,
          retained_event_count: 2,
          retention_boundary_cursor: 3
        }
      });
      expect(rawOutputRows(second.db, "sess_retention_001")).toEqual([
        { cursor: 4, normalized_type: "replay_boundary" },
        { cursor: 5, normalized_type: "message" }
      ]);
      expect(rawOutputAggregate(second.db, "sess_retention_001")).toEqual({
        bytes: projection.retained_event_bytes,
        count: projection.retained_event_count,
        earliest: projection.earliest_retained_cursor,
        latest: projection.session.last_event_cursor
      });
    } finally {
      second.db.close();
    }
  });

  it("preserves and explicitly reports one newest UTF-8 event that cannot meet the byte cap", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      appendMessages(repository, repository.create(stateCandidate(1)), 1, "界".repeat(64));
      const before = rawOutputAggregate(open.db, "sess_retention_001");

      const result = maintainSelectedProjectionRetentionBatch(open.db, {
        max_pruned_events: 10,
        retention: retentionPolicy({ output_byte_limit: 1 }),
        session_id: "sess_retention_001"
      });

      expect(result).toMatchObject({ newest_event_oversize: true, pruned_event_count: 0, remaining: false });
      expect(rawOutputAggregate(open.db, "sess_retention_001")).toEqual(before);
      expect(rawOutputRows(open.db, "sess_retention_001")).toEqual([{ cursor: 1, normalized_type: "message" }]);
    } finally {
      open.db.close();
    }
  });

  it("uses stored UTF-8 byte totals to prune ordinary byte overage while preserving the newest event", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      appendMessages(repository, repository.create(stateCandidate(1)), 4, "界".repeat(40));
      const newest = open.db
        .prepare("SELECT byte_length FROM selected_projected_events WHERE session_id = ? ORDER BY cursor DESC LIMIT 1")
        .get("sess_retention_001") as { readonly byte_length: number };
      const byteLimit = newest.byte_length + 500;

      const result = maintainSelectedProjectionRetentionBatch(open.db, {
        max_pruned_events: 10,
        retention: retentionPolicy({ output_byte_limit: byteLimit }),
        session_id: "sess_retention_001"
      });
      const rows = rawOutputRows(open.db, "sess_retention_001");
      const aggregate = rawOutputAggregate(open.db, "sess_retention_001") as { readonly bytes: number };

      expect(result.pruned_event_count).toBeGreaterThan(0);
      expect(result).toMatchObject({ newest_event_oversize: false, remaining: false });
      expect(aggregate.bytes).toBeLessThanOrEqual(byteLimit);
      expect(rows.at(-1)).toEqual({ cursor: 4, normalized_type: "message" });
      expect(rows[0]).toMatchObject({ normalized_type: "replay_boundary" });
    } finally {
      open.db.close();
    }
  });

  it("rolls back deletion and projection changes when boundary insertion fails", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      appendMessages(repository, repository.create(stateCandidate(1)), 3);
      const beforeRows = rawOutputRows(open.db, "sess_retention_001");
      const beforeProjection = repository.require("sess_retention_001").projection;
      open.db.exec(`
        CREATE TRIGGER force_retention_boundary_failure
        BEFORE INSERT ON selected_projected_events
        WHEN NEW.normalized_type = 'replay_boundary'
        BEGIN
          SELECT RAISE(ABORT, 'forced retention boundary failure');
        END;
      `);

      expectStateError(
        () =>
          maintainSelectedProjectionRetentionBatch(open.db, {
            max_pruned_events: 2,
            retention: retentionPolicy({ output_event_limit: 2 }),
            session_id: "sess_retention_001"
          }),
        "projection_write_failed"
      );
      expect(rawOutputRows(open.db, "sess_retention_001")).toEqual(beforeRows);
      expect(repository.require("sess_retention_001").projection).toEqual(beforeProjection);
    } finally {
      open.db.close();
    }
  });

  it("rejects a corrupt retained row before mutating the session", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      appendMessages(repository, repository.create(stateCandidate(1)), 3);
      open.db
        .prepare("UPDATE selected_projected_events SET normalized_type = 'turn' WHERE session_id = ? AND cursor = 2")
        .run("sess_retention_001");

      expectStateError(
        () =>
          maintainSelectedProjectionRetentionBatch(open.db, {
            max_pruned_events: 2,
            retention: retentionPolicy({ output_event_limit: 2 }),
            session_id: "sess_retention_001"
          }),
        "invalid_event"
      );
      expect(rawOutputRows(open.db, "sess_retention_001")).toHaveLength(3);
    } finally {
      open.db.close();
    }
  });
});

describe("selected audit retention batches", () => {
  it("deletes whole terminal trails in bounded batches while preserving accepted-only operations", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      recordCompletedAudit(repository, "op_retention_old_001", "2026-07-07T10:00:00.000Z", "2026-07-07T10:01:00.000Z");
      repository.recordRejected(rejectedAudit("op_retention_old_002", "2026-07-08T10:00:00.000Z"));
      repository.recordAccepted(acceptedAudit("op_retention_pending", "2026-07-07T11:00:00.000Z"));
      recordCompletedAudit(repository, "op_retention_new_001", "2026-07-10T10:00:00.000Z", "2026-07-10T10:01:00.000Z");

      const first = maintainSelectedAuditRetentionBatch(open.db, {
        max_deleted_records: 2,
        now: maintenanceNow,
        retention: retentionPolicy({ audit_event_limit: 2, audit_retention_days: 1 })
      });
      expect(first).toEqual({
        deleted_operation_count: 1,
        deleted_record_count: 2,
        newest_trail_oversize: false,
        pending_blocks_policy: true,
        protected_pending_operation_count: 1,
        remaining: true,
        retained_record_count: 4
      });
      expect(auditOperationRowCount(open.db, "op_retention_old_001")).toBe(0);
      expect(auditOperationRowCount(open.db, "op_retention_old_002")).toBe(1);

      const second = maintainSelectedAuditRetentionBatch(open.db, {
        max_deleted_records: 2,
        now: maintenanceNow,
        retention: retentionPolicy({ audit_event_limit: 2, audit_retention_days: 1 })
      });
      expect(second).toEqual({
        deleted_operation_count: 1,
        deleted_record_count: 1,
        newest_trail_oversize: false,
        pending_blocks_policy: true,
        protected_pending_operation_count: 1,
        remaining: false,
        retained_record_count: 3
      });
      expect(auditOperationRowCount(open.db, "op_retention_pending")).toBe(1);
      expect(auditOperationRowCount(open.db, "op_retention_new_001")).toBe(2);
      expect(Object.isFrozen(second)).toBe(true);
    } finally {
      open.db.close();
    }
  });

  it("applies age retention to the newest terminal trail and reports a count-only newest oversize trail", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordRejected(rejectedAudit("op_retention_age_newest", "2026-07-01T10:00:00.000Z"));
      const aged = maintainSelectedAuditRetentionBatch(open.db, {
        max_deleted_records: 2,
        now: maintenanceNow,
        retention: retentionPolicy({ audit_event_limit: 100, audit_retention_days: 1 })
      });
      expect(aged).toMatchObject({ deleted_operation_count: 1, retained_record_count: 0, remaining: false });

      recordCompletedAudit(repository, "op_retention_oversize", "2026-07-10T10:00:00.000Z", "2026-07-10T10:01:00.000Z");
      const oversize = maintainSelectedAuditRetentionBatch(open.db, {
        max_deleted_records: 2,
        now: maintenanceNow,
        retention: retentionPolicy({ audit_event_limit: 1, audit_retention_days: 30 })
      });
      expect(oversize).toEqual({
        deleted_operation_count: 0,
        deleted_record_count: 0,
        newest_trail_oversize: true,
        pending_blocks_policy: false,
        protected_pending_operation_count: 0,
        remaining: false,
        retained_record_count: 2
      });
    } finally {
      open.db.close();
    }
  });

  it("uses a strict age cutoff and count-prunes oldest terminal operations without deleting the newest", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordRejected(rejectedAudit("op_retention_before_cutoff", "2026-07-09T11:59:59.999Z"));
      repository.recordRejected(rejectedAudit("op_retention_at_cutoff", "2026-07-09T12:00:00.000Z"));
      const ageResult = maintainSelectedAuditRetentionBatch(open.db, {
        max_deleted_records: 2,
        now: maintenanceNow,
        retention: retentionPolicy({ audit_event_limit: 100, audit_retention_days: 1 })
      });
      expect(ageResult).toMatchObject({ deleted_operation_count: 1, retained_record_count: 1, remaining: false });
      expect(auditOperationRowCount(open.db, "op_retention_at_cutoff")).toBe(1);

      repository.recordRejected(rejectedAudit("op_retention_count_middle", "2026-07-10T10:00:00.000Z"));
      repository.recordRejected(rejectedAudit("op_retention_count_newest", "2026-07-10T11:00:00.000Z"));
      const countResult = maintainSelectedAuditRetentionBatch(open.db, {
        max_deleted_records: 2,
        now: maintenanceNow,
        retention: retentionPolicy({ audit_event_limit: 1, audit_retention_days: 30 })
      });
      expect(countResult).toMatchObject({
        deleted_operation_count: 2,
        deleted_record_count: 2,
        newest_trail_oversize: false,
        remaining: false,
        retained_record_count: 1
      });
      expect(auditOperationRowCount(open.db, "op_retention_count_newest")).toBe(1);
    } finally {
      open.db.close();
    }
  });

  it("rolls back a failed whole-trail delete and rejects corrupt candidate JSON", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      recordCompletedAudit(repository, "op_retention_delete_fail", "2026-07-01T10:00:00.000Z", "2026-07-01T10:01:00.000Z");
      open.db.exec(`
        CREATE TRIGGER force_audit_retention_delete_failure
        BEFORE DELETE ON selected_audit_events
        WHEN OLD.operation_id = 'op_retention_delete_fail'
        BEGIN
          SELECT RAISE(ABORT, 'forced audit retention delete failure');
        END;
      `);
      expectAuditError(
        () =>
          maintainSelectedAuditRetentionBatch(open.db, {
            max_deleted_records: 2,
            now: maintenanceNow,
            retention: retentionPolicy({ audit_retention_days: 1 })
          }),
        "audit_write_failed"
      );
      expect(auditOperationRowCount(open.db, "op_retention_delete_fail")).toBe(2);

      open.db.exec("DROP TRIGGER force_audit_retention_delete_failure; DROP TRIGGER selected_audit_events_no_update;");
      open.db
        .prepare("UPDATE selected_audit_events SET record_json = json_set(record_json, '$.action', 'model') WHERE phase = 'terminal'")
        .run();
      expectAuditError(
        () =>
          maintainSelectedAuditRetentionBatch(open.db, {
            max_deleted_records: 2,
            now: maintenanceNow,
            retention: retentionPolicy({ audit_retention_days: 1 })
          }),
        "invalid_audit_trail"
      );
      expect(auditOperationRowCount(open.db, "op_retention_delete_fail")).toBe(2);
    } finally {
      open.db.close();
    }
  });
});

describe("startup retention maintenance", () => {
  it("returns a deeply frozen complete result for empty/current storage and rejects config before mutation", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const result = runStartupRetentionMaintenance({
        db: open.db,
        monotonic_now: monotonicClock([0, 1, 2, 3]),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy(),
        timeout_ms: 100
      });

      expect(result).toEqual({
        audit: {
          actionable_remaining: false,
          batch_count: 1,
          deleted_operation_count: 0,
          deleted_record_count: 0,
          newest_trail_oversize: false,
          pending_blocks_policy: false,
          protected_pending_operation_count: 0,
          retained_record_count: 0,
          scan_complete: true
        },
        cutoff_at: maintenanceNow,
        duration_ms: 3,
        failure: null,
        output: {
          actionable_remaining: false,
          batch_count: 0,
          boundary_write_count: 0,
          newest_oversize_session_ids: [],
          policy_violation_session_count: 0,
          pruned_event_count: 0,
          scan_complete: true,
          sessions_touched_count: 0
        },
        reasons: [],
        status: "complete"
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.output)).toBe(true);
      expect(Object.isFrozen(result.audit)).toBe(true);
      expect(Object.isFrozen(result.reasons)).toBe(true);
      expect(Object.isFrozen(result.output.newest_oversize_session_ids)).toBe(true);

      const before = tableCounts(open.db);
      expect(() =>
        runStartupRetentionMaintenance({
          db: open.db,
          retention: retentionPolicy(),
          unexpected: true
        } as never)
      ).toThrow(HostDeckStartupRetentionMaintenanceError);
      expect(() =>
        runStartupRetentionMaintenance({
          db: open.db,
          retention: retentionPolicy({ output_event_limit: 1 })
        })
      ).toThrow(HostDeckStartupRetentionMaintenanceError);
      expect(() =>
        runStartupRetentionMaintenance({
          batch_record_limit: 1,
          db: open.db,
          retention: retentionPolicy()
        })
      ).toThrow(HostDeckStartupRetentionMaintenanceError);
      expect(() =>
        runStartupRetentionMaintenance({
          db: open.db,
          monotonic_now: () => -1,
          retention: retentionPolicy()
        })
      ).toThrow(HostDeckStartupRetentionMaintenanceError);
      expect(() =>
        runStartupRetentionMaintenance({
          db: open.db,
          now: () => new Date(Number.NaN),
          retention: retentionPolicy()
        })
      ).toThrow(HostDeckStartupRetentionMaintenanceError);
      expect(() =>
        runStartupRetentionMaintenance({
          db: open.db,
          now: () => new Date("0000-01-01T00:00:00.000Z"),
          retention: retentionPolicy()
        })
      ).toThrow(HostDeckStartupRetentionMaintenanceError);
      expect(tableCounts(open.db)).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("gives output and audit independent work before reporting each exhausted batch budget", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const states = createSelectedStateRepository(open.db);
      appendMessages(states, states.create(stateCandidate(1)), 40);
      appendMessages(states, states.create(stateCandidate(2)), 40);
      const audit = createSelectedAuditRepository(open.db);
      for (let index = 1; index <= 25; index += 1) {
        audit.recordRejected(rejectedAudit(`op_retention_budget_${index}`, "2026-07-01T10:00:00.000Z"));
      }

      const result = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: open.db,
        max_batches_per_scope: 1,
        monotonic_now: monotonicClock([0, 1, 2, 3, 4]),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ audit_event_limit: 1, audit_retention_days: 1, output_event_limit: 2 }),
        timeout_ms: 100
      });

      expect(result.status).toBe("degraded");
      expect(result.reasons).toEqual(["output_batch_limit", "audit_batch_limit"]);
      expect(result.output).toMatchObject({
        actionable_remaining: true,
        batch_count: 1,
        boundary_write_count: 1,
        policy_violation_session_count: 2,
        pruned_event_count: 2,
        scan_complete: false,
        sessions_touched_count: 1
      });
      expect(result.audit).toMatchObject({
        actionable_remaining: true,
        batch_count: 1,
        deleted_operation_count: 2,
        deleted_record_count: 2,
        retained_record_count: 23,
        scan_complete: false
      });
    } finally {
      open.db.close();
    }
  });

  it("reports unknown rather than false when a batch limit prevents scanning later output sessions", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const states = createSelectedStateRepository(open.db);
      appendMessages(states, states.create(stateCandidate(1)), 3);
      appendMessages(states, states.create(stateCandidate(2)), 3);
      const result = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: open.db,
        max_batches_per_scope: 1,
        monotonic_now: incrementingClock(),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ output_event_limit: 2 }),
        timeout_ms: 100
      });

      expect(result.reasons).toEqual(["output_batch_limit"]);
      expect(result.output).toMatchObject({
        actionable_remaining: null,
        batch_count: 1,
        policy_violation_session_count: 1,
        scan_complete: false,
        sessions_touched_count: 1
      });
    } finally {
      open.db.close();
    }
  });

  it("uses one fixed cutoff and reports timeout or abort without false completion", () => {
    const timeoutOpen = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const states = createSelectedStateRepository(timeoutOpen.db);
      appendMessages(states, states.create(stateCandidate(1)), 3);
      createSelectedAuditRepository(timeoutOpen.db).recordRejected(
        rejectedAudit("op_retention_timeout", "2026-07-01T10:00:00.000Z")
      );
      const timedOut = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: timeoutOpen.db,
        monotonic_now: monotonicClock([0, 0, 2, 2]),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ audit_retention_days: 1, output_event_limit: 2 }),
        timeout_ms: 1
      });

      expect(timedOut.status).toBe("degraded");
      expect(timedOut.reasons).toContain("timeout");
      expect(timedOut.audit).toMatchObject({ actionable_remaining: null, batch_count: 0, scan_complete: false });
      expect(auditOperationRowCount(timeoutOpen.db, "op_retention_timeout")).toBe(1);
    } finally {
      timeoutOpen.db.close();
    }

    const abortOpen = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const states = createSelectedStateRepository(abortOpen.db);
      appendMessages(states, states.create(stateCandidate(1)), 3);
      const controller = new AbortController();
      controller.abort();
      const aborted = runStartupRetentionMaintenance({
        db: abortOpen.db,
        monotonic_now: monotonicClock([0, 0]),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ output_event_limit: 2 }),
        signal: controller.signal
      });

      expect(aborted).toMatchObject({ status: "degraded", reasons: ["aborted"] });
      expect(aborted.output).toMatchObject({ actionable_remaining: null, batch_count: 0, scan_complete: false });
      expect(rawOutputRows(abortOpen.db, "sess_retention_001")).toHaveLength(3);
    } finally {
      abortOpen.db.close();
    }
  });

  it("reports a broken runtime monotonic clock as degraded after any already committed batch", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const states = createSelectedStateRepository(open.db);
      appendMessages(states, states.create(stateCandidate(1)), 3);
      const result = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: open.db,
        monotonic_now: monotonicClock([0, 0, Number.NaN, Number.NaN]),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ output_event_limit: 2 }),
        timeout_ms: 100
      });

      expect(result).toMatchObject({
        failure: { code: "invalid_monotonic_clock", scope: "runner" },
        reasons: ["clock_failure"],
        status: "degraded"
      });
      expect(result.output.batch_count).toBe(1);
      expect(result.audit).toMatchObject({ actionable_remaining: null, batch_count: 0, scan_complete: false });
    } finally {
      open.db.close();
    }
  });

  it("does not report a batch-limit degradation when the final allowed output batch completes all work", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const states = createSelectedStateRepository(open.db);
      appendMessages(states, states.create(stateCandidate(1)), 5);
      const result = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: open.db,
        max_batches_per_scope: 2,
        monotonic_now: incrementingClock(),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ output_event_limit: 2 }),
        timeout_ms: 100
      });

      expect(result).toMatchObject({ status: "complete", reasons: [] });
      expect(result.output).toMatchObject({
        actionable_remaining: false,
        batch_count: 2,
        policy_violation_session_count: 0,
        scan_complete: true
      });
    } finally {
      open.db.close();
    }
  });

  it("returns a visible degraded failure for unavailable storage instead of throwing or claiming completion", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    open.db.close();

    const result = runStartupRetentionMaintenance({
      db: open.db,
      monotonic_now: monotonicClock([0, 1, 2]),
      now: () => new Date(maintenanceNow),
      retention: retentionPolicy()
    });

    expect(result).toMatchObject({
      failure: { code: "storage_unavailable", scope: "output" },
      status: "degraded"
    });
    expect(result.reasons).toEqual(["storage_failure"]);
    expect(result.output).toMatchObject({ actionable_remaining: null, scan_complete: false });
    expect(result.audit).toMatchObject({ actionable_remaining: null, batch_count: 0, scan_complete: false });
  });

  it("resumes across two connections, preserves a concurrently appended newest event, and becomes idempotent", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const firstStates = createSelectedStateRepository(first.db);
      const secondStates = createSelectedStateRepository(second.db);
      appendMessages(firstStates, firstStates.create(stateCandidate(1)), 5);
      const pendingAudit = createSelectedAuditRepository(first.db);
      pendingAudit.recordAccepted(acceptedAudit("op_retention_interleave", "2026-07-01T10:00:00.000Z"));

      const partial = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: first.db,
        max_batches_per_scope: 1,
        monotonic_now: incrementingClock(),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ audit_event_limit: 1, audit_retention_days: 1, output_event_limit: 2 }),
        timeout_ms: 1_000
      });
      expect(partial.reasons).toContain("output_batch_limit");
      expect(partial.audit.pending_blocks_policy).toBe(true);

      const concurrentState = secondStates.require("sess_retention_001");
      appendMessages(secondStates, concurrentState, 1);
      createSelectedAuditRepository(second.db).recordTerminal(
        terminalAudit("op_retention_interleave", "2026-07-10T11:00:00.000Z")
      );

      const resumed = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: second.db,
        monotonic_now: incrementingClock(),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ audit_event_limit: 1, audit_retention_days: 1, output_event_limit: 2 }),
        timeout_ms: 1_000
      });
      expect(resumed.status).toBe("degraded");
      expect(resumed.reasons).toEqual(["newest_audit_trail_oversize"]);
      expect(rawOutputRows(second.db, "sess_retention_001")).toEqual([
        { cursor: 5, normalized_type: "replay_boundary" },
        { cursor: 6, normalized_type: "message" }
      ]);
      expect(auditOperationRowCount(second.db, "op_retention_interleave")).toBe(2);

      const repeated = runStartupRetentionMaintenance({
        db: first.db,
        monotonic_now: incrementingClock(),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ audit_event_limit: 1, audit_retention_days: 1, output_event_limit: 2 }),
        timeout_ms: 1_000
      });
      expect(repeated).toMatchObject({
        status: "degraded",
        reasons: ["newest_audit_trail_oversize"],
        output: { pruned_event_count: 0, scan_complete: true },
        audit: { deleted_record_count: 0, scan_complete: true }
      });
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  it("recomputes durable work under a stricter policy after reopen", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    try {
      const states = createSelectedStateRepository(first.db);
      appendMessages(states, states.create(stateCandidate(1)), 4);
      const generous = runStartupRetentionMaintenance({
        db: first.db,
        monotonic_now: incrementingClock(),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy(),
        timeout_ms: 1_000
      });
      expect(generous.status).toBe("complete");
      expect(generous.output.pruned_event_count).toBe(0);
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const strict = runStartupRetentionMaintenance({
        batch_record_limit: 2,
        db: second.db,
        monotonic_now: incrementingClock(),
        now: () => new Date(maintenanceNow),
        retention: retentionPolicy({ output_event_limit: 2 }),
        timeout_ms: 1_000
      });
      expect(strict.status).toBe("complete");
      expect(strict.output).toMatchObject({
        actionable_remaining: false,
        policy_violation_session_count: 0,
        pruned_event_count: 3,
        scan_complete: true
      });
    } finally {
      second.db.close();
    }
  });
});

function stateCandidate(index: number) {
  const suffix = String(index).padStart(3, "0");
  const id = `sess_retention_${suffix}`;
  const name = `retention-${suffix}`;
  const threadId = `thread-retention-${suffix}`;
  const mapping = {
    id,
    name,
    codex_thread_id: threadId,
    cwd: `/home/simonli/work/retention-${suffix}`,
    runtime_source: "codex_app_server" as const,
    runtime_version: "0.144.0",
    disposition: "selected" as const,
    created_at: sessionCreatedAt,
    updated_at: sessionCreatedAt,
    archived_at: null
  };
  return {
    mapping,
    projection: {
      session: {
        id,
        name,
        codex_thread_id: threadId,
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
        updated_at: sessionCreatedAt,
        last_activity_at: null,
        branch: "main",
        model: "gpt-5.5-codex",
        goal: null,
        recent_summary: "Retention test session.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function appendMessages(
  repository: SelectedStateRepository,
  initial: SelectedSessionState,
  count: number,
  text = "retained output"
): SelectedSessionState {
  let current = initial;
  const start = (current.projection.session.last_event_cursor ?? 0) + 1;
  for (let cursor = start; cursor < start + count; cursor += 1) {
    const record = messageRecord(current, cursor, text);
    repository.appendEvent(record, advancedProjection(current, record), selectedStateRevision(current));
    current = repository.require(current.mapping.id);
  }
  return current;
}

function messageRecord(state: SelectedSessionState, cursor: number, text: string): SelectedProjectedEventRecord {
  const event = selectedProjectionEventSchema.parse({
    session_id: state.mapping.id,
    cursor,
    captured_at: eventCapturedAt,
    upstream_at: eventCapturedAt,
    codex_event_id: `event:${state.mapping.id}:${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_state: "complete",
    content_notice: null,
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: `item:${state.mapping.id}:${cursor}`,
    text: `${text} ${cursor}`
  });
  return { event, byte_length: selectedProjectedEventByteLength(event) };
}

function advancedProjection(state: SelectedSessionState, record: SelectedProjectedEventRecord) {
  return {
    ...state.projection,
    session: {
      ...state.projection.session,
      updated_at: eventCapturedAt,
      last_activity_at: eventCapturedAt,
      last_event_cursor: record.event.cursor,
      recent_summary: record.event.type === "message" ? record.event.text : "Retained output boundary."
    },
    retained_event_count: state.projection.retained_event_count + 1,
    retained_event_bytes: state.projection.retained_event_bytes + record.byte_length,
    earliest_retained_cursor: state.projection.earliest_retained_cursor ?? record.event.cursor
  };
}

function acceptedAudit(operationId: string, at: string) {
  return {
    id: `audit:${operationId}:accepted`,
    operation_id: operationId,
    at,
    actor: auditActor(),
    action: "prompt",
    target: auditTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: { source: "retention_test", text_length: 8 },
    error_code: null
  };
}

function terminalAudit(operationId: string, at: string) {
  return {
    ...acceptedAudit(operationId, at),
    id: `audit:${operationId}:terminal`,
    phase: "terminal",
    outcome: "succeeded",
    payload_summary: { result: "turn_started" }
  };
}

function rejectedAudit(operationId: string, at: string) {
  return {
    ...acceptedAudit(operationId, at),
    id: `audit:${operationId}:rejected`,
    phase: "terminal",
    outcome: "rejected",
    payload_summary: { result: "rejected" },
    error_code: "validation_error"
  };
}

function recordCompletedAudit(
  repository: ReturnType<typeof createSelectedAuditRepository>,
  operationId: string,
  acceptedAt: string,
  terminalAt: string
): void {
  repository.recordAccepted(acceptedAudit(operationId, acceptedAt));
  repository.recordTerminal(terminalAudit(operationId, terminalAt));
}

function auditActor() {
  return {
    type: "dashboard",
    device_id: "device:retention:phone",
    permission: "write",
    origin: "https://hostdeck.local"
  } as const;
}

function auditTarget() {
  return {
    type: "managed_session",
    session_id: "sess_retention_audit",
    codex_thread_id: "thread-retention-audit"
  } as const;
}

function retentionPolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    output_event_limit: 100,
    output_byte_limit: 1_000_000,
    audit_event_limit: 100,
    audit_retention_days: 30,
    ...overrides
  };
}

function rawOutputRows(db: Database.Database, sessionId: string) {
  return db
    .prepare(
      "SELECT cursor, normalized_type FROM selected_projected_events WHERE session_id = ? ORDER BY cursor ASC"
    )
    .all(sessionId);
}

function rawOutputAggregate(db: Database.Database, sessionId: string) {
  return db
    .prepare(
      `
        SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes,
          MIN(cursor) AS earliest, MAX(cursor) AS latest
        FROM selected_projected_events
        WHERE session_id = ?
      `
    )
    .get(sessionId);
}

function auditOperationRowCount(db: Database.Database, operationId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events WHERE operation_id = ?").get(operationId) as {
    readonly count: number;
  };
  return row.count;
}

function tableCounts(db: Database.Database) {
  return {
    audit: (db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get() as { readonly count: number }).count,
    output: (db.prepare("SELECT COUNT(*) AS count FROM selected_projected_events").get() as { readonly count: number }).count
  };
}

function expectStateError(fn: () => unknown, code: HostDeckSelectedStateRepositoryError["code"]): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckSelectedStateRepositoryError);
  expect((caught as HostDeckSelectedStateRepositoryError).code).toBe(code);
}

function expectAuditError(fn: () => unknown, code: HostDeckSelectedAuditRepositoryError["code"]): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckSelectedAuditRepositoryError);
  expect((caught as HostDeckSelectedAuditRepositoryError).code).toBe(code);
}

function monotonicClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function incrementingClock(): () => number {
  let value = 0;
  return () => value++;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-startup-retention-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(maintenanceNow);
}
