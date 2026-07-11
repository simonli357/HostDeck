import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  maintainSelectedAuditRetentionBatch,
  reconcileSelectedAuditOrphansBatch
} from "./selected-audit-repository.js";
import {
  HostDeckStartupAuditOrphanReconciliationError,
  runStartupAuditOrphanReconciliation
} from "./startup-audit-orphan-reconciliation.js";

const tempDirs: string[] = [];
const eligibleBefore = "2026-07-10T10:00:00.000Z";
const reconciledAt = "2026-07-10T10:05:00.000Z";
const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve("better-sqlite3");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected audit orphan reconciliation batches", () => {
  it("reconciles only strictly eligible pending trails in bounded deterministic batches", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordAccepted(acceptedAudit("op_orphan_old_001", "2026-07-10T08:00:00.000Z"));
      repository.recordAccepted(acceptedAudit("op_orphan_old_002", "2026-07-10T09:00:00.000Z"));
      repository.recordAccepted(acceptedAudit("op_orphan_equal", eligibleBefore));
      repository.recordAccepted(acceptedAudit("op_orphan_recent", "2026-07-10T10:00:00.001Z"));
      recordCompletedAudit(repository, "op_orphan_terminal", "2026-07-10T07:00:00.000Z", "2026-07-10T07:01:00.000Z");
      const acceptedJson = rawRecordJson(open.db, "audit:op_orphan_old_001:accepted");

      const first = reconcileSelectedAuditOrphansBatch(open.db, {
        eligible_before: eligibleBefore,
        max_reconciled_operations: 1,
        reconciled_at: reconciledAt
      });
      expect(first).toEqual({
        eligible_pending_operation_count: 1,
        protected_recent_operation_count: 2,
        reconciled_operation_count: 1,
        remaining: true,
        total_pending_operation_count: 3
      });
      expect(Object.isFrozen(first)).toBe(true);
      expect(repository.require("op_orphan_old_001")).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted" },
          {
            action: "prompt",
            actor: auditActor(),
            at: reconciledAt,
            error_code: "runtime_unavailable",
            outcome: "incomplete",
            payload_summary: { reason: "host_restart_without_terminal" },
            phase: "terminal",
            target: auditTarget()
          }
        ]
      });
      expect(rawRecordJson(open.db, "audit:op_orphan_old_001:accepted")).toBe(acceptedJson);
      expect(rawTerminalId(open.db, "op_orphan_old_001")).toMatch(/^audit:orphan:[a-f0-9]{64}$/u);

      const second = reconcileSelectedAuditOrphansBatch(open.db, {
        eligible_before: eligibleBefore,
        max_reconciled_operations: 1,
        reconciled_at: reconciledAt
      });
      expect(second).toEqual({
        eligible_pending_operation_count: 0,
        protected_recent_operation_count: 2,
        reconciled_operation_count: 1,
        remaining: false,
        total_pending_operation_count: 2
      });
      expect(repository.require("op_orphan_equal").state).toBe("pending");
      expect(repository.require("op_orphan_recent").state).toBe("pending");
      expect(repository.require("op_orphan_terminal").records.at(-1)?.outcome).toBe("succeeded");
    } finally {
      open.db.close();
    }
  });

  it("rejects invalid configuration before mutation", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordAccepted(acceptedAudit("op_orphan_config", "2026-07-10T08:00:00.000Z"));
      const before = rawRows(open.db, "op_orphan_config");

      expectAuditError(
        () =>
          reconcileSelectedAuditOrphansBatch(open.db, {
            eligible_before: eligibleBefore,
            max_reconciled_operations: 0,
            reconciled_at: reconciledAt
          }),
        "invalid_audit_record"
      );
      expectAuditError(
        () =>
          reconcileSelectedAuditOrphansBatch(open.db, {
            eligible_before: reconciledAt,
            max_reconciled_operations: 1,
            reconciled_at: eligibleBefore
          }),
        "invalid_audit_record"
      );
      expectAuditError(
        () =>
          reconcileSelectedAuditOrphansBatch(open.db, {
            eligible_before: eligibleBefore,
            max_reconciled_operations: 1,
            reconciled_at: reconciledAt,
            extra: true
          } as never),
        "invalid_audit_record"
      );
      expect(rawRows(open.db, "op_orphan_config")).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("rolls back every terminal when a later insert in the same batch fails", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordAccepted(acceptedAudit("op_orphan_rollback_1", "2026-07-10T08:00:00.000Z"));
      repository.recordAccepted(acceptedAudit("op_orphan_rollback_2", "2026-07-10T09:00:00.000Z"));
      open.db.exec(`
        CREATE TRIGGER force_orphan_reconciliation_failure
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.operation_id = 'op_orphan_rollback_2' AND NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced orphan reconciliation failure');
        END;
      `);

      expectAuditError(
        () =>
          reconcileSelectedAuditOrphansBatch(open.db, {
            eligible_before: eligibleBefore,
            max_reconciled_operations: 2,
            reconciled_at: reconciledAt
          }),
        "audit_write_failed"
      );
      expect(repository.require("op_orphan_rollback_1").state).toBe("pending");
      expect(repository.require("op_orphan_rollback_2").state).toBe("pending");

      open.db.exec("DROP TRIGGER force_orphan_reconciliation_failure");
      const retry = reconcileSelectedAuditOrphansBatch(open.db, {
        eligible_before: eligibleBefore,
        max_reconciled_operations: 2,
        reconciled_at: reconciledAt
      });
      expect(retry).toMatchObject({ reconciled_operation_count: 2, remaining: false });
      expect(new Set([rawTerminalId(open.db, "op_orphan_rollback_1"), rawTerminalId(open.db, "op_orphan_rollback_2")]).size).toBe(2);
    } finally {
      open.db.close();
    }
  });

  it("fails on corrupt eligible accepted truth without appending a terminal", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordAccepted(acceptedAudit("op_orphan_corrupt", "2026-07-10T08:00:00.000Z"));
      open.db.exec("DROP TRIGGER selected_audit_events_no_update");
      open.db
        .prepare("UPDATE selected_audit_events SET record_json = json_set(record_json, '$.action', 'model') WHERE operation_id = ?")
        .run("op_orphan_corrupt");

      expectAuditError(
        () =>
          reconcileSelectedAuditOrphansBatch(open.db, {
            eligible_before: eligibleBefore,
            max_reconciled_operations: 1,
            reconciled_at: reconciledAt
          }),
        "invalid_audit_trail"
      );
      expect(rawRows(open.db, "op_orphan_corrupt")).toHaveLength(1);
    } finally {
      open.db.close();
    }
  });

  it("keeps exactly one legal terminal across real-terminal and reconciler winner orderings", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const firstRepository = createSelectedAuditRepository(first.db);
      const secondRepository = createSelectedAuditRepository(second.db);
      firstRepository.recordAccepted(acceptedAudit("op_orphan_real_wins", "2026-07-10T08:00:00.000Z"));
      secondRepository.recordTerminal(terminalAudit("op_orphan_real_wins", "2026-07-10T09:00:00.000Z"));
      expect(
        reconcileSelectedAuditOrphansBatch(first.db, {
          eligible_before: eligibleBefore,
          max_reconciled_operations: 1,
          reconciled_at: reconciledAt
        })
      ).toMatchObject({ reconciled_operation_count: 0, remaining: false });
      expect(firstRepository.require("op_orphan_real_wins").records.at(-1)?.outcome).toBe("succeeded");

      firstRepository.recordAccepted(acceptedAudit("op_orphan_reconciler_wins", "2026-07-10T08:30:00.000Z"));
      expect(
        reconcileSelectedAuditOrphansBatch(second.db, {
          eligible_before: eligibleBefore,
          max_reconciled_operations: 1,
          reconciled_at: reconciledAt
        })
      ).toMatchObject({ reconciled_operation_count: 1, remaining: false });
      expectAuditError(
        () => firstRepository.recordTerminal(terminalAudit("op_orphan_reconciler_wins", "2026-07-10T10:06:00.000Z")),
        "audit_operation_terminal"
      );
      expect(rawRows(first.db, "op_orphan_reconciler_wins")).toHaveLength(2);
      expect(firstRepository.require("op_orphan_reconciler_wins").records.at(-1)?.outcome).toBe("incomplete");
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  it("waits for a worker-held real terminal transaction and then leaves that terminal unchanged", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const operationId = "op_orphan_worker_real";
      repository.recordAccepted(acceptedAudit(operationId, "2026-07-10T08:00:00.000Z"));
      const worker = startConcurrentTerminalInsert(path, terminalAudit(operationId, "2026-07-10T09:00:00.000Z"));
      await worker.inserted;

      const result = reconcileSelectedAuditOrphansBatch(open.db, {
        eligible_before: eligibleBefore,
        max_reconciled_operations: 1,
        reconciled_at: reconciledAt
      });
      await worker.completed;

      expect(result).toMatchObject({ reconciled_operation_count: 0, remaining: false });
      expect(repository.require(operationId).records.at(-1)?.outcome).toBe("succeeded");
      expect(rawRows(open.db, operationId)).toHaveLength(2);
    } finally {
      open.db.close();
    }
  });

  it("makes reconciled incomplete trails eligible for ordinary whole-trail retention", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordAccepted(acceptedAudit("op_orphan_retention", "2026-07-10T08:00:00.000Z"));
      reconcileSelectedAuditOrphansBatch(open.db, {
        eligible_before: eligibleBefore,
        max_reconciled_operations: 1,
        reconciled_at: reconciledAt
      });
      repository.recordRejected(rejectedAudit("op_orphan_retention_newest", "2026-07-10T10:06:00.000Z"));

      const retained = maintainSelectedAuditRetentionBatch(open.db, {
        max_deleted_records: 2,
        now: "2026-07-10T10:07:00.000Z",
        retention: {
          output_event_limit: 100,
          output_byte_limit: 1_000_000,
          audit_event_limit: 1,
          audit_retention_days: 30
        }
      });
      expect(retained).toMatchObject({
        deleted_operation_count: 1,
        deleted_record_count: 2,
        remaining: false,
        retained_record_count: 1
      });
      expect(rawRows(open.db, "op_orphan_retention")).toEqual([]);
      expect(repository.require("op_orphan_retention_newest").records[0]?.outcome).toBe("rejected");
    } finally {
      open.db.close();
    }
  });
});

describe("startup audit orphan reconciliation", () => {
  it("returns a deeply frozen complete snapshot for empty or protected-recent state", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      createSelectedAuditRepository(open.db).recordAccepted(acceptedAudit("op_orphan_protected", eligibleBefore));
      const result = runStartupAuditOrphanReconciliation({
        db: open.db,
        eligible_before: eligibleBefore,
        monotonic_now: monotonicClock([0, 1, 2]),
        reconciled_at: reconciledAt,
        timeout_ms: 100
      });

      expect(result).toEqual({
        actionable_remaining: false,
        batch_count: 1,
        duration_ms: 2,
        eligible_before: eligibleBefore,
        eligible_pending_operation_count: 0,
        failure: null,
        protected_recent_operation_count: 1,
        reasons: [],
        reconciled_at: reconciledAt,
        reconciled_operation_count: 0,
        scan_complete: true,
        status: "complete",
        total_pending_operation_count: 1
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.reasons)).toBe(true);
    } finally {
      open.db.close();
    }
  });

  it("rejects runner configuration before mutation", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordAccepted(acceptedAudit("op_orphan_runner_config", "2026-07-10T08:00:00.000Z"));
      const before = rawRows(open.db, "op_orphan_runner_config");
      const invalidInputs = [
        { batch_operation_limit: 0 },
        { max_batches: 0 },
        { timeout_ms: 0 },
        { monotonic_now: () => -1 },
        { eligible_before: reconciledAt, reconciled_at: eligibleBefore },
        { extra: true }
      ];
      for (const invalid of invalidInputs) {
        expect(() =>
          runStartupAuditOrphanReconciliation({
            db: open.db,
            eligible_before: eligibleBefore,
            reconciled_at: reconciledAt,
            ...invalid
          } as never)
        ).toThrow(HostDeckStartupAuditOrphanReconciliationError);
      }
      expect(rawRows(open.db, "op_orphan_runner_config")).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("alternates bounded batches until its exact batch ceiling and reports remaining work", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      for (let index = 0; index < 25; index += 1) {
        repository.recordAccepted(
          acceptedAudit(`op_orphan_backlog_${String(index).padStart(2, "0")}`, "2026-07-10T08:00:00.000Z")
        );
      }
      const result = runStartupAuditOrphanReconciliation({
        batch_operation_limit: 4,
        db: open.db,
        eligible_before: eligibleBefore,
        max_batches: 2,
        monotonic_now: incrementingClock(),
        reconciled_at: reconciledAt,
        timeout_ms: 100
      });

      expect(result).toMatchObject({
        actionable_remaining: true,
        batch_count: 2,
        eligible_pending_operation_count: 17,
        protected_recent_operation_count: 0,
        reasons: ["batch_limit"],
        reconciled_operation_count: 8,
        scan_complete: false,
        status: "degraded",
        total_pending_operation_count: 17
      });
      expect(countOutcomes(open.db)).toEqual({ accepted: 25, incomplete: 8 });
    } finally {
      open.db.close();
    }
  });

  it("reports timeout, pre-abort, and runtime clock failure without false completion", () => {
    const timeoutOpen = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(timeoutOpen.db);
      for (let index = 0; index < 5; index += 1) {
        repository.recordAccepted(acceptedAudit(`op_orphan_timeout_${index}`, "2026-07-10T08:00:00.000Z"));
      }
      const timedOut = runStartupAuditOrphanReconciliation({
        batch_operation_limit: 2,
        db: timeoutOpen.db,
        eligible_before: eligibleBefore,
        monotonic_now: monotonicClock([0, 0, 2, 2]),
        reconciled_at: reconciledAt,
        timeout_ms: 1
      });
      expect(timedOut).toMatchObject({
        actionable_remaining: true,
        batch_count: 1,
        reasons: ["timeout"],
        reconciled_operation_count: 2,
        scan_complete: false,
        status: "degraded"
      });
    } finally {
      timeoutOpen.db.close();
    }

    const abortOpen = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(abortOpen.db);
      repository.recordAccepted(acceptedAudit("op_orphan_abort", "2026-07-10T08:00:00.000Z"));
      const controller = new AbortController();
      controller.abort();
      const aborted = runStartupAuditOrphanReconciliation({
        db: abortOpen.db,
        eligible_before: eligibleBefore,
        monotonic_now: monotonicClock([0, 0]),
        reconciled_at: reconciledAt,
        signal: controller.signal
      });
      expect(aborted).toMatchObject({
        actionable_remaining: null,
        batch_count: 0,
        reasons: ["aborted"],
        scan_complete: false,
        status: "degraded"
      });
      expect(repository.require("op_orphan_abort").state).toBe("pending");
    } finally {
      abortOpen.db.close();
    }

    const clockOpen = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(clockOpen.db);
      repository.recordAccepted(acceptedAudit("op_orphan_clock", "2026-07-10T08:00:00.000Z"));
      const clockFailed = runStartupAuditOrphanReconciliation({
        db: clockOpen.db,
        eligible_before: eligibleBefore,
        monotonic_now: monotonicClock([0, 0, Number.NaN, Number.NaN]),
        reconciled_at: reconciledAt
      });
      expect(clockFailed).toMatchObject({
        batch_count: 1,
        failure: { code: "invalid_monotonic_clock" },
        reasons: ["clock_failure"],
        status: "degraded"
      });
      expect(repository.require("op_orphan_clock").state).toBe("terminal");
    } finally {
      clockOpen.db.close();
    }
  });

  it("returns bounded storage failure and leaves a failed runner batch rolled back", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      repository.recordAccepted(acceptedAudit("op_orphan_runner_failure", "2026-07-10T08:00:00.000Z"));
      open.db.exec(`
        CREATE TRIGGER force_orphan_runner_failure
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced orphan runner failure');
        END;
      `);
      const failed = runStartupAuditOrphanReconciliation({
        db: open.db,
        eligible_before: eligibleBefore,
        monotonic_now: incrementingClock(),
        reconciled_at: reconciledAt
      });
      expect(failed).toMatchObject({
        actionable_remaining: null,
        batch_count: 0,
        failure: { code: "audit_write_failed" },
        reasons: ["storage_failure"],
        scan_complete: false,
        status: "degraded"
      });
      expect(repository.require("op_orphan_runner_failure").state).toBe("pending");
    } finally {
      open.db.close();
    }

    const closed = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    closed.db.close();
    const unavailable = runStartupAuditOrphanReconciliation({
      db: closed.db,
      eligible_before: eligibleBefore,
      monotonic_now: incrementingClock(),
      reconciled_at: reconciledAt
    });
    expect(unavailable).toMatchObject({
      failure: { code: "audit_unavailable" },
      reasons: ["storage_failure"],
      status: "degraded"
    });
  });

  it("lets two runners resume the same durable backlog without duplicate terminals", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(first.db);
      for (let index = 0; index < 5; index += 1) {
        repository.recordAccepted(acceptedAudit(`op_orphan_runner_${index}`, "2026-07-10T08:00:00.000Z"));
      }
      const partial = runStartupAuditOrphanReconciliation({
        batch_operation_limit: 2,
        db: first.db,
        eligible_before: eligibleBefore,
        max_batches: 1,
        monotonic_now: incrementingClock(),
        reconciled_at: reconciledAt
      });
      expect(partial).toMatchObject({ reasons: ["batch_limit"], reconciled_operation_count: 2 });

      const completed = runStartupAuditOrphanReconciliation({
        batch_operation_limit: 2,
        db: second.db,
        eligible_before: eligibleBefore,
        monotonic_now: incrementingClock(),
        reconciled_at: reconciledAt
      });
      expect(completed).toMatchObject({ reconciled_operation_count: 3, status: "complete" });

      const repeated = runStartupAuditOrphanReconciliation({
        db: first.db,
        eligible_before: eligibleBefore,
        monotonic_now: incrementingClock(),
        reconciled_at: reconciledAt
      });
      expect(repeated).toMatchObject({ reconciled_operation_count: 0, status: "complete" });
      expect(countOutcomes(first.db)).toEqual({ accepted: 5, incomplete: 5 });
      for (let index = 0; index < 5; index += 1) {
        expect(rawRows(first.db, `op_orphan_runner_${index}`)).toHaveLength(2);
      }
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  it("resumes from durable state across runners, reopen, and a later eligibility cutoff", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(first.db);
      repository.recordAccepted(acceptedAudit("op_orphan_resume_old", "2026-07-10T08:00:00.000Z"));
      repository.recordAccepted(acceptedAudit("op_orphan_resume_recent", "2026-07-10T10:01:00.000Z"));
      const initial = runStartupAuditOrphanReconciliation({
        db: first.db,
        eligible_before: eligibleBefore,
        monotonic_now: incrementingClock(),
        reconciled_at: reconciledAt
      });
      expect(initial).toMatchObject({
        protected_recent_operation_count: 1,
        reconciled_operation_count: 1,
        status: "complete"
      });
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const laterCutoff = "2026-07-10T10:02:00.000Z";
      const laterReconciliation = "2026-07-10T10:06:00.000Z";
      const resumed = runStartupAuditOrphanReconciliation({
        batch_operation_limit: 1,
        db: second.db,
        eligible_before: laterCutoff,
        monotonic_now: incrementingClock(),
        reconciled_at: laterReconciliation
      });
      expect(resumed).toMatchObject({
        eligible_pending_operation_count: 0,
        protected_recent_operation_count: 0,
        reconciled_operation_count: 1,
        status: "complete"
      });

      const repeated = runStartupAuditOrphanReconciliation({
        db: second.db,
        eligible_before: laterCutoff,
        monotonic_now: incrementingClock(),
        reconciled_at: laterReconciliation
      });
      expect(repeated).toMatchObject({
        reconciled_operation_count: 0,
        scan_complete: true,
        status: "complete",
        total_pending_operation_count: 0
      });
      expect(countOutcomes(second.db)).toEqual({ accepted: 2, incomplete: 2 });
    } finally {
      second.db.close();
    }
  });
});

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
    payload_summary: { source: "orphan_test", text_length: 8 },
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
    device_id: "device:orphan:phone",
    permission: "write",
    origin: "https://hostdeck.local"
  } as const;
}

function auditTarget() {
  return {
    type: "managed_session",
    session_id: "sess_orphan_audit",
    codex_thread_id: "thread-orphan-audit"
  } as const;
}

function rawRows(db: Database.Database, operationId: string): readonly unknown[] {
  return db.prepare("SELECT * FROM selected_audit_events WHERE operation_id = ? ORDER BY phase ASC").all(operationId);
}

function rawRecordJson(db: Database.Database, recordId: string): string {
  const row = db.prepare("SELECT record_json FROM selected_audit_events WHERE id = ?").get(recordId) as
    | { readonly record_json: string }
    | undefined;
  if (row === undefined) throw new Error(`Missing audit record ${recordId}.`);
  return row.record_json;
}

function rawTerminalId(db: Database.Database, operationId: string): string {
  const row = db
    .prepare("SELECT id FROM selected_audit_events WHERE operation_id = ? AND phase = 'terminal'")
    .get(operationId) as { readonly id: string } | undefined;
  if (row === undefined) throw new Error(`Missing terminal audit record for ${operationId}.`);
  return row.id;
}

function countOutcomes(db: Database.Database): { readonly accepted: number; readonly incomplete: number } {
  const rows = db.prepare("SELECT outcome, COUNT(*) AS count FROM selected_audit_events GROUP BY outcome").all() as Array<{
    readonly count: number;
    readonly outcome: string;
  }>;
  return {
    accepted: rows.find((row) => row.outcome === "accepted")?.count ?? 0,
    incomplete: rows.find((row) => row.outcome === "incomplete")?.count ?? 0
  };
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

function startConcurrentTerminalInsert(
  path: string,
  record: ReturnType<typeof terminalAudit>
): { readonly completed: Promise<void>; readonly inserted: Promise<void> } {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO selected_audit_events " +
        "(id, operation_id, at, action, phase, outcome, error_code, record_json) " +
        "VALUES (@id, @operation_id, @at, @action, @phase, @outcome, @error_code, @record_json)"
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
      else reject(new Error(`Audit orphan worker exited with code ${code}.`));
    });
  });
  return { completed, inserted };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-audit-orphan-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(reconciledAt);
}
