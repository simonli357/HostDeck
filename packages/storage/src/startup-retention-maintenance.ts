import { performance } from "node:perf_hooks";
import { isoTimestampSchema, type RetentionPolicy, retentionPolicySchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import {
  HostDeckSelectedAuditRepositoryError,
  maintainSelectedAuditRetentionBatch
} from "./selected-audit-repository.js";
import {
  HostDeckSelectedStateRepositoryError,
  maintainSelectedProjectionRetentionBatch
} from "./selected-state-repository.js";

export type StartupRetentionDegradedReason =
  | "aborted"
  | "audit_batch_limit"
  | "clock_failure"
  | "concurrent_output_change"
  | "newest_audit_trail_oversize"
  | "newest_output_event_oversize"
  | "output_batch_limit"
  | "protected_audit_operations"
  | "storage_failure"
  | "timeout";

export type StartupRetentionFailureScope = "audit" | "output" | "runner";

export interface StartupRetentionFailure {
  readonly code: string;
  readonly scope: StartupRetentionFailureScope;
}

export interface StartupRetentionOutputResult {
  readonly actionable_remaining: boolean | null;
  readonly batch_count: number;
  readonly boundary_write_count: number;
  readonly newest_oversize_session_ids: readonly string[];
  readonly policy_violation_session_count: number | null;
  readonly pruned_event_count: number;
  readonly scan_complete: boolean;
  readonly sessions_touched_count: number;
}

export interface StartupRetentionAuditResult {
  readonly actionable_remaining: boolean | null;
  readonly batch_count: number;
  readonly deleted_operation_count: number;
  readonly deleted_record_count: number;
  readonly newest_trail_oversize: boolean | null;
  readonly pending_blocks_policy: boolean | null;
  readonly protected_pending_operation_count: number | null;
  readonly retained_record_count: number | null;
  readonly scan_complete: boolean;
}

export interface StartupRetentionMaintenanceResult {
  readonly audit: StartupRetentionAuditResult;
  readonly cutoff_at: string;
  readonly duration_ms: number;
  readonly failure: StartupRetentionFailure | null;
  readonly output: StartupRetentionOutputResult;
  readonly reasons: readonly StartupRetentionDegradedReason[];
  readonly status: "complete" | "degraded";
}

export interface RunStartupRetentionMaintenanceInput {
  readonly batch_record_limit?: number;
  readonly db: Database.Database;
  readonly max_batches_per_scope?: number;
  readonly monotonic_now?: () => number;
  readonly now?: () => Date;
  readonly retention: RetentionPolicy;
  readonly signal?: AbortSignal;
  readonly timeout_ms?: number;
}

export type StartupRetentionMaintenanceErrorCode = "invalid_startup_retention_config";

export class HostDeckStartupRetentionMaintenanceError extends Error {
  constructor(
    readonly code: StartupRetentionMaintenanceErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckStartupRetentionMaintenanceError";
  }
}

interface ParsedStartupRetentionInput {
  readonly batch_record_limit: number;
  readonly db: Database.Database;
  readonly max_batches_per_scope: number;
  readonly monotonic_now: () => number;
  readonly now: string;
  readonly retention: RetentionPolicy;
  readonly signal: AbortSignal | null;
  readonly timeout_ms: number;
}

interface OutputProgress {
  actionableRemaining: boolean | null;
  afterSessionId: string;
  batchCount: number;
  boundaryWriteCount: number;
  currentSessionId: string | null;
  prunedEventCount: number;
  scanComplete: boolean;
  readonly newestOversizeSessionIds: Set<string>;
  readonly sessionsTouched: Set<string>;
}

interface AuditProgress {
  actionableRemaining: boolean | null;
  batchCount: number;
  deletedOperationCount: number;
  deletedRecordCount: number;
  newestTrailOversize: boolean | null;
  pendingBlocksPolicy: boolean | null;
  protectedPendingOperationCount: number | null;
  retainedRecordCount: number | null;
  scanComplete: boolean;
}

const defaultBatchRecordLimit = 100;
const defaultMaxBatchesPerScope = 100;
const defaultTimeoutMs = 2_000;
const orderedReasons: readonly StartupRetentionDegradedReason[] = [
  "aborted",
  "timeout",
  "clock_failure",
  "storage_failure",
  "output_batch_limit",
  "audit_batch_limit",
  "concurrent_output_change",
  "newest_output_event_oversize",
  "newest_audit_trail_oversize",
  "protected_audit_operations"
] as const;

export function runStartupRetentionMaintenance(
  input: RunStartupRetentionMaintenanceInput
): StartupRetentionMaintenanceResult {
  const parsed = parseStartupRetentionInput(input);
  const startedAt = readInitialMonotonicTime(parsed.monotonic_now);
  const deadline = startedAt + parsed.timeout_ms;
  if (!Number.isFinite(deadline)) {
    throw invalidConfig("Startup retention monotonic deadline is outside the finite clock range.");
  }
  const reasons = new Set<StartupRetentionDegradedReason>();
  const output: OutputProgress = {
    actionableRemaining: null,
    afterSessionId: "",
    batchCount: 0,
    boundaryWriteCount: 0,
    currentSessionId: null,
    newestOversizeSessionIds: new Set(),
    prunedEventCount: 0,
    scanComplete: false,
    sessionsTouched: new Set()
  };
  const audit: AuditProgress = {
    actionableRemaining: null,
    batchCount: 0,
    deletedOperationCount: 0,
    deletedRecordCount: 0,
    newestTrailOversize: null,
    pendingBlocksPolicy: null,
    protectedPendingOperationCount: null,
    retainedRecordCount: null,
    scanComplete: false
  };
  let failure: StartupRetentionFailure | null = null;
  let lastMonotonicTime = startedAt;
  let stopped = false;

  while (!stopped && (!output.scanComplete || !audit.scanComplete)) {
    let progressed = false;
    if (!output.scanComplete) {
      const guard = checkRunGuard(parsed, deadline, lastMonotonicTime);
      lastMonotonicTime = guard.time;
      if (guard.reason !== null) {
        reasons.add(guard.reason);
        failure = guard.failure;
        stopped = true;
      } else if (output.batchCount >= parsed.max_batches_per_scope) {
        reasons.add("output_batch_limit");
        output.actionableRemaining = output.currentSessionId === null ? null : true;
        output.scanComplete = false;
      } else {
        try {
          output.currentSessionId ??= findNextOutputSession(
            parsed.db,
            parsed.retention,
            output.afterSessionId
          );
          if (output.currentSessionId === null) {
            output.actionableRemaining = false;
            output.scanComplete = true;
          } else {
            const sessionId = output.currentSessionId;
            const result = maintainSelectedProjectionRetentionBatch(parsed.db, {
              max_pruned_events: parsed.batch_record_limit,
              retention: parsed.retention,
              session_id: sessionId
            });
            output.batchCount += 1;
            output.prunedEventCount += result.pruned_event_count;
            output.boundaryWriteCount += result.pruned_event_count > 0 ? 1 : 0;
            output.sessionsTouched.add(sessionId);
            output.actionableRemaining = result.remaining;
            if (result.newest_event_oversize) output.newestOversizeSessionIds.add(sessionId);
            if (!result.remaining) {
              output.afterSessionId = sessionId;
              output.currentSessionId = null;
            }
            progressed = true;
          }
        } catch (error) {
          reasons.add("storage_failure");
          failure = maintenanceFailure("output", error);
          stopped = true;
        }
      }
    }

    if (!stopped && !audit.scanComplete) {
      const guard = checkRunGuard(parsed, deadline, lastMonotonicTime);
      lastMonotonicTime = guard.time;
      if (guard.reason !== null) {
        reasons.add(guard.reason);
        failure = guard.failure;
        stopped = true;
      } else if (audit.batchCount >= parsed.max_batches_per_scope) {
        reasons.add("audit_batch_limit");
        audit.actionableRemaining = true;
        audit.scanComplete = false;
      } else {
        try {
          const result = maintainSelectedAuditRetentionBatch(parsed.db, {
            max_deleted_records: parsed.batch_record_limit,
            now: parsed.now,
            retention: parsed.retention
          });
          audit.batchCount += 1;
          audit.deletedOperationCount += result.deleted_operation_count;
          audit.deletedRecordCount += result.deleted_record_count;
          audit.actionableRemaining = result.remaining;
          audit.newestTrailOversize = result.newest_trail_oversize;
          audit.pendingBlocksPolicy = result.pending_blocks_policy;
          audit.protectedPendingOperationCount = result.protected_pending_operation_count;
          audit.retainedRecordCount = result.retained_record_count;
          audit.scanComplete = !result.remaining;
          progressed = true;
        } catch (error) {
          reasons.add("storage_failure");
          failure = maintenanceFailure("audit", error);
          stopped = true;
        }
      }
    }

    if (!stopped && !progressed) break;
  }

  let outputPolicyViolationCount: number | null = null;
  if (failure === null || failure.scope !== "output") {
    try {
      outputPolicyViolationCount = countOutputPolicyViolations(parsed.db, parsed.retention);
      if (
        outputPolicyViolationCount === output.newestOversizeSessionIds.size
      ) {
        output.actionableRemaining = false;
        output.scanComplete = true;
        reasons.delete("output_batch_limit");
      }
      if (
        output.scanComplete &&
        outputPolicyViolationCount !== output.newestOversizeSessionIds.size
      ) {
        output.scanComplete = false;
        output.actionableRemaining = null;
        reasons.add("concurrent_output_change");
      } else if (
        !output.scanComplete &&
        output.currentSessionId === null &&
        outputPolicyViolationCount !== output.newestOversizeSessionIds.size
      ) {
        output.actionableRemaining = null;
      }
    } catch (error) {
      reasons.add("storage_failure");
      failure ??= maintenanceFailure("output", error);
      output.actionableRemaining = null;
      output.scanComplete = false;
    }
  }

  if (output.newestOversizeSessionIds.size > 0) reasons.add("newest_output_event_oversize");
  if (audit.newestTrailOversize === true) reasons.add("newest_audit_trail_oversize");
  if (audit.pendingBlocksPolicy === true) reasons.add("protected_audit_operations");

  const finalClock = readFinalMonotonicTime(parsed.monotonic_now, lastMonotonicTime);
  lastMonotonicTime = finalClock.time;
  if (finalClock.failed) {
    reasons.add("clock_failure");
    failure ??= Object.freeze({ code: "invalid_monotonic_clock", scope: "runner" });
  } else if (lastMonotonicTime >= deadline) {
    reasons.add("timeout");
  }
  const ordered = Object.freeze(orderedReasons.filter((reason) => reasons.has(reason)));
  const frozenOutput = Object.freeze({
    actionable_remaining: output.actionableRemaining,
    batch_count: output.batchCount,
    boundary_write_count: output.boundaryWriteCount,
    newest_oversize_session_ids: Object.freeze([...output.newestOversizeSessionIds].sort()),
    policy_violation_session_count: outputPolicyViolationCount,
    pruned_event_count: output.prunedEventCount,
    scan_complete: output.scanComplete,
    sessions_touched_count: output.sessionsTouched.size
  });
  const frozenAudit = Object.freeze({
    actionable_remaining: audit.actionableRemaining,
    batch_count: audit.batchCount,
    deleted_operation_count: audit.deletedOperationCount,
    deleted_record_count: audit.deletedRecordCount,
    newest_trail_oversize: audit.newestTrailOversize,
    pending_blocks_policy: audit.pendingBlocksPolicy,
    protected_pending_operation_count: audit.protectedPendingOperationCount,
    retained_record_count: audit.retainedRecordCount,
    scan_complete: audit.scanComplete
  });
  return Object.freeze({
    audit: frozenAudit,
    cutoff_at: parsed.now,
    duration_ms: Math.max(0, lastMonotonicTime - startedAt),
    failure,
    output: frozenOutput,
    reasons: ordered,
    status: ordered.length === 0 && output.scanComplete && audit.scanComplete ? "complete" : "degraded"
  });
}

function parseStartupRetentionInput(input: RunStartupRetentionMaintenanceInput): ParsedStartupRetentionInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidConfig("Startup retention input must be an object.");
  }
  const allowedKeys = new Set([
    "batch_record_limit",
    "db",
    "max_batches_per_scope",
    "monotonic_now",
    "now",
    "retention",
    "signal",
    "timeout_ms"
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw invalidConfig("Startup retention input contains unsupported fields.");
  }
  if (
    input.db === null ||
    typeof input.db !== "object" ||
    typeof input.db.prepare !== "function" ||
    typeof input.db.transaction !== "function"
  ) {
    throw invalidConfig("Startup retention requires an open database handle.");
  }
  const policy = retentionPolicySchema.safeParse(input.retention);
  if (!policy.success || policy.data.output_event_limit < 2) {
    throw invalidConfig("Startup retention policy is invalid.", policy.success ? undefined : policy.error);
  }
  const batchRecordLimit = parseBoundedInteger(
    input.batch_record_limit ?? defaultBatchRecordLimit,
    2,
    1_000,
    "batch_record_limit"
  );
  const maxBatchesPerScope = parseBoundedInteger(
    input.max_batches_per_scope ?? defaultMaxBatchesPerScope,
    1,
    1_000,
    "max_batches_per_scope"
  );
  const timeoutMs = parseBoundedInteger(input.timeout_ms ?? defaultTimeoutMs, 1, 60_000, "timeout_ms");
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonic_now ?? (() => performance.now());
  if (typeof now !== "function" || typeof monotonicNow !== "function") {
    throw invalidConfig("Startup retention clocks must be functions.");
  }
  let wallTime: Date;
  try {
    wallTime = now();
  } catch (error) {
    throw invalidConfig("Startup retention wall clock failed before maintenance.", error);
  }
  if (!(wallTime instanceof Date) || !Number.isFinite(wallTime.getTime())) {
    throw invalidConfig("Startup retention wall clock must return a valid Date.");
  }
  const cutoffTime = wallTime.getTime() - policy.data.audit_retention_days * 24 * 60 * 60 * 1_000;
  let cutoff: string;
  try {
    cutoff = new Date(cutoffTime).toISOString();
  } catch (error) {
    throw invalidConfig("Startup retention cutoff is outside the supported timestamp range.", error);
  }
  if (!isoTimestampSchema.safeParse(cutoff).success) {
    throw invalidConfig("Startup retention cutoff is outside the supported timestamp range.");
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw invalidConfig("Startup retention signal is invalid.");
  }
  return {
    batch_record_limit: batchRecordLimit,
    db: input.db,
    max_batches_per_scope: maxBatchesPerScope,
    monotonic_now: monotonicNow,
    now: wallTime.toISOString(),
    retention: Object.freeze({ ...policy.data }),
    signal: input.signal ?? null,
    timeout_ms: timeoutMs
  };
}

function readInitialMonotonicTime(clock: () => number): number {
  let value: number;
  try {
    value = clock();
  } catch (error) {
    throw invalidConfig("Startup retention monotonic clock failed before maintenance.", error);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw invalidConfig("Startup retention monotonic clock must return a finite non-negative number.");
  }
  return value;
}

function checkRunGuard(
  input: ParsedStartupRetentionInput,
  deadline: number,
  priorTime: number
): { readonly failure: StartupRetentionFailure | null; readonly reason: "aborted" | "clock_failure" | "timeout" | null; readonly time: number } {
  if (input.signal?.aborted === true) return { failure: null, reason: "aborted", time: priorTime };
  let time: number;
  try {
    time = input.monotonic_now();
  } catch {
    return {
      failure: Object.freeze({ code: "invalid_monotonic_clock", scope: "runner" }),
      reason: "clock_failure",
      time: priorTime
    };
  }
  if (!Number.isFinite(time) || time < priorTime) {
    return {
      failure: Object.freeze({ code: "invalid_monotonic_clock", scope: "runner" }),
      reason: "clock_failure",
      time: priorTime
    };
  }
  if (time >= deadline) return { failure: null, reason: "timeout", time };
  return { failure: null, reason: null, time };
}

function readFinalMonotonicTime(
  clock: () => number,
  priorTime: number
): { readonly failed: boolean; readonly time: number } {
  try {
    const time = clock();
    if (!Number.isFinite(time) || time < priorTime) return { failed: true, time: priorTime };
    return { failed: false, time };
  } catch {
    return { failed: true, time: priorTime };
  }
}

function findNextOutputSession(
  db: Database.Database,
  policy: RetentionPolicy,
  afterSessionId: string
): string | null {
  const row = db
    .prepare(
      `
        SELECT session_id
        FROM selected_session_projections
        WHERE session_id > @after_session_id
          AND (retained_event_count > @event_limit OR retained_event_bytes > @byte_limit)
        ORDER BY session_id ASC
        LIMIT 1
      `
    )
    .get({
      after_session_id: afterSessionId,
      byte_limit: policy.output_byte_limit,
      event_limit: policy.output_event_limit
    }) as { readonly session_id: unknown } | undefined;
  if (row === undefined) return null;
  if (typeof row.session_id !== "string") {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "Selected retention candidate session id is invalid."
    );
  }
  return row.session_id;
}

function countOutputPolicyViolations(db: Database.Database, policy: RetentionPolicy): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM selected_session_projections
        WHERE retained_event_count > @event_limit OR retained_event_bytes > @byte_limit
      `
    )
    .get({ byte_limit: policy.output_byte_limit, event_limit: policy.output_event_limit }) as
    | { readonly count: unknown }
    | undefined;
  if (row === undefined || !Number.isSafeInteger(row.count) || (row.count as number) < 0) {
    throw new HostDeckSelectedStateRepositoryError(
      "invalid_projection",
      "Selected retention policy-violation count is invalid."
    );
  }
  return row.count as number;
}

function maintenanceFailure(scope: StartupRetentionFailureScope, error: unknown): StartupRetentionFailure {
  let code = "unexpected_maintenance_failure";
  if (error instanceof HostDeckSelectedStateRepositoryError || error instanceof HostDeckSelectedAuditRepositoryError) {
    code = error.code;
  } else {
    const sqliteCode =
      error !== null && typeof error === "object" && "code" in error ? (error as { readonly code?: unknown }).code : null;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof sqliteCode === "string" && /^SQLITE_[A-Z_]+$/u.test(sqliteCode)) {
      code = sqliteCode.toLowerCase();
    } else if (message.includes("database connection is not open")) {
      code = "storage_unavailable";
    }
  }
  return Object.freeze({ code, scope });
}

function parseBoundedInteger(candidate: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    throw invalidConfig(`Startup retention ${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return candidate as number;
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as AbortSignal).aborted === "boolean" &&
    typeof (candidate as AbortSignal).addEventListener === "function"
  );
}

function invalidConfig(message: string, cause?: unknown): HostDeckStartupRetentionMaintenanceError {
  return new HostDeckStartupRetentionMaintenanceError(
    "invalid_startup_retention_config",
    message,
    cause === undefined ? undefined : { cause }
  );
}
