import { performance } from "node:perf_hooks";
import { isoTimestampSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import {
  HostDeckSelectedAuditRepositoryError,
  reconcileSelectedAuditOrphansBatch
} from "./selected-audit-repository.js";
import { createStartupMaintenanceClock } from "./startup-maintenance-clock.js";

export type StartupAuditOrphanReconciliationReason =
  | "aborted"
  | "batch_limit"
  | "clock_failure"
  | "storage_failure"
  | "timeout";

export interface StartupAuditOrphanReconciliationFailure {
  readonly code: string;
}

export interface StartupAuditOrphanReconciliationResult {
  readonly actionable_remaining: boolean | null;
  readonly batch_count: number;
  readonly duration_ms: number;
  readonly eligible_before: string;
  readonly eligible_pending_operation_count: number | null;
  readonly failure: StartupAuditOrphanReconciliationFailure | null;
  readonly protected_recent_operation_count: number | null;
  readonly reasons: readonly StartupAuditOrphanReconciliationReason[];
  readonly reconciled_at: string;
  readonly reconciled_operation_count: number;
  readonly scan_complete: boolean;
  readonly status: "complete" | "degraded";
  readonly total_pending_operation_count: number | null;
}

export interface RunStartupAuditOrphanReconciliationInput {
  readonly batch_operation_limit?: number;
  readonly db: Database.Database;
  readonly eligible_before: string;
  readonly max_batches?: number;
  readonly monotonic_now?: () => number;
  readonly reconciled_at: string;
  readonly signal?: AbortSignal;
  readonly timeout_ms?: number;
}

export type StartupAuditOrphanReconciliationErrorCode = "invalid_startup_audit_orphan_config";

export class HostDeckStartupAuditOrphanReconciliationError extends Error {
  constructor(
    readonly code: StartupAuditOrphanReconciliationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckStartupAuditOrphanReconciliationError";
  }
}

interface ParsedStartupAuditOrphanInput {
  readonly batch_operation_limit: number;
  readonly db: Database.Database;
  readonly eligible_before: string;
  readonly max_batches: number;
  readonly monotonic_now: () => number;
  readonly reconciled_at: string;
  readonly signal: AbortSignal | null;
  readonly timeout_ms: number;
}

const defaultBatchOperationLimit = 100;
const defaultMaxBatches = 100;
const defaultTimeoutMs = 2_000;
const orderedReasons: readonly StartupAuditOrphanReconciliationReason[] = [
  "aborted",
  "timeout",
  "clock_failure",
  "storage_failure",
  "batch_limit"
] as const;

export function runStartupAuditOrphanReconciliation(
  input: RunStartupAuditOrphanReconciliationInput
): StartupAuditOrphanReconciliationResult {
  const parsed = parseInput(input);
  const clock = createStartupMaintenanceClock({
    clock: parsed.monotonic_now,
    invalid_config: invalidConfig,
    label: "Audit orphan reconciliation",
    signal: parsed.signal,
    timeout_ms: parsed.timeout_ms
  });

  const reasons = new Set<StartupAuditOrphanReconciliationReason>();
  let actionableRemaining: boolean | null = null;
  let batchCount = 0;
  let eligiblePendingOperationCount: number | null = null;
  let failure: StartupAuditOrphanReconciliationFailure | null = null;
  let protectedRecentOperationCount: number | null = null;
  let reconciledOperationCount = 0;
  let scanComplete = false;
  let totalPendingOperationCount: number | null = null;

  while (!scanComplete) {
    const guard = clock.check();
    if (guard.reason !== null) {
      reasons.add(guard.reason);
      failure = guard.failure_code === null ? null : Object.freeze({ code: guard.failure_code });
      break;
    }
    if (batchCount >= parsed.max_batches) {
      reasons.add("batch_limit");
      actionableRemaining = true;
      break;
    }

    try {
      const result = reconcileSelectedAuditOrphansBatch(parsed.db, {
        eligible_before: parsed.eligible_before,
        max_reconciled_operations: parsed.batch_operation_limit,
        reconciled_at: parsed.reconciled_at
      });
      batchCount += 1;
      reconciledOperationCount += result.reconciled_operation_count;
      eligiblePendingOperationCount = result.eligible_pending_operation_count;
      protectedRecentOperationCount = result.protected_recent_operation_count;
      totalPendingOperationCount = result.total_pending_operation_count;
      actionableRemaining = result.remaining;
      scanComplete = !result.remaining;
    } catch (error) {
      reasons.add("storage_failure");
      failure = mapFailure(error);
      actionableRemaining = null;
      scanComplete = false;
      break;
    }
  }

  const finished = clock.finish();
  if (finished.reason !== null) {
    reasons.add(finished.reason);
    if (finished.failure_code !== null) failure ??= Object.freeze({ code: finished.failure_code });
  }
  const ordered = Object.freeze(orderedReasons.filter((reason) => reasons.has(reason)));
  return Object.freeze({
    actionable_remaining: actionableRemaining,
    batch_count: batchCount,
    duration_ms: finished.duration_ms,
    eligible_before: parsed.eligible_before,
    eligible_pending_operation_count: eligiblePendingOperationCount,
    failure,
    protected_recent_operation_count: protectedRecentOperationCount,
    reasons: ordered,
    reconciled_at: parsed.reconciled_at,
    reconciled_operation_count: reconciledOperationCount,
    scan_complete: scanComplete,
    status: ordered.length === 0 && scanComplete ? "complete" : "degraded",
    total_pending_operation_count: totalPendingOperationCount
  });
}

function parseInput(input: RunStartupAuditOrphanReconciliationInput): ParsedStartupAuditOrphanInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidConfig("Audit orphan reconciliation input must be an object.");
  }
  const allowedKeys = new Set([
    "batch_operation_limit",
    "db",
    "eligible_before",
    "max_batches",
    "monotonic_now",
    "reconciled_at",
    "signal",
    "timeout_ms"
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw invalidConfig("Audit orphan reconciliation input contains unsupported fields.");
  }
  if (
    input.db === null ||
    typeof input.db !== "object" ||
    typeof input.db.prepare !== "function" ||
    typeof input.db.transaction !== "function"
  ) {
    throw invalidConfig("Audit orphan reconciliation requires a database handle.");
  }
  const eligibleBefore = parseTimestamp(input.eligible_before, "eligible_before");
  const reconciledAt = parseTimestamp(input.reconciled_at, "reconciled_at");
  if (Date.parse(reconciledAt) < Date.parse(eligibleBefore)) {
    throw invalidConfig("Audit orphan reconciled_at cannot precede eligible_before.");
  }
  const monotonicNow = input.monotonic_now ?? (() => performance.now());
  if (typeof monotonicNow !== "function") throw invalidConfig("Audit orphan monotonic_now must be a function.");
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw invalidConfig("Audit orphan reconciliation signal is invalid.");
  }
  return {
    batch_operation_limit: parseBoundedInteger(
      input.batch_operation_limit ?? defaultBatchOperationLimit,
      1,
      1_000,
      "batch_operation_limit"
    ),
    db: input.db,
    eligible_before: eligibleBefore,
    max_batches: parseBoundedInteger(input.max_batches ?? defaultMaxBatches, 1, 1_000, "max_batches"),
    monotonic_now: monotonicNow,
    reconciled_at: reconciledAt,
    signal: input.signal ?? null,
    timeout_ms: parseBoundedInteger(input.timeout_ms ?? defaultTimeoutMs, 1, 60_000, "timeout_ms")
  };
}

function parseTimestamp(candidate: unknown, field: string): string {
  const result = isoTimestampSchema.safeParse(candidate);
  if (!result.success) throw invalidConfig(`Audit orphan reconciliation ${field} is invalid.`, result.error);
  return result.data;
}

function mapFailure(error: unknown): StartupAuditOrphanReconciliationFailure {
  let code = "unexpected_reconciliation_failure";
  if (error instanceof HostDeckSelectedAuditRepositoryError) {
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
  return Object.freeze({ code });
}

function parseBoundedInteger(candidate: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    throw invalidConfig(`Audit orphan ${field} must be an integer from ${minimum} through ${maximum}.`);
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

function invalidConfig(message: string, cause?: unknown): HostDeckStartupAuditOrphanReconciliationError {
  return new HostDeckStartupAuditOrphanReconciliationError(
    "invalid_startup_audit_orphan_config",
    message,
    cause === undefined ? undefined : { cause }
  );
}
