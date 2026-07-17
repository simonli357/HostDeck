import {
  isoTimestampSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type {
  StartupAuditOrphanReconciliationResult,
  StartupRetentionMaintenanceResult
} from "@hostdeck/storage";
import type {
  HostDeckLocalHealthObservation,
  HostDeckReportedLocalHealthReason
} from "./host-health.js";

export const hostDeckStartupMaintenanceErrorCodes = [
  "clock_invalid",
  "configuration_invalid",
  "orphan_contract_invalid",
  "orphan_failed",
  "retention_contract_invalid",
  "retention_failed"
] as const;
export type HostDeckStartupMaintenanceErrorCode =
  (typeof hostDeckStartupMaintenanceErrorCodes)[number];

export class HostDeckStartupMaintenanceError extends Error {
  constructor(
    token: symbol,
    readonly code: HostDeckStartupMaintenanceErrorCode
  ) {
    if (token !== startupErrorToken) {
      throw new TypeError("Invalid startup-maintenance error construction.");
    }
    super(startupErrorMessages[code]);
    this.name = "HostDeckStartupMaintenanceError";
    Object.freeze(this);
  }
}

export interface HostDeckStartupAuditOrphanInput {
  readonly eligible_before: string;
  readonly reconciled_at: string;
  readonly signal: AbortSignal;
}

export interface HostDeckStartupRetentionInput {
  readonly cutoff_at: string;
  readonly signal: AbortSignal;
}

export interface HostDeckStartupMaintenancePorts {
  readonly reconcileAuditOrphans: (
    input: HostDeckStartupAuditOrphanInput
  ) =>
    | StartupAuditOrphanReconciliationResult
    | Promise<StartupAuditOrphanReconciliationResult>;
  readonly runRetention: (
    input: HostDeckStartupRetentionInput
  ) =>
    | StartupRetentionMaintenanceResult
    | Promise<StartupRetentionMaintenanceResult>;
}

export interface CreateHostDeckStartupMaintenancePortsInput {
  readonly reconcileAuditOrphans: HostDeckStartupMaintenancePorts["reconcileAuditOrphans"];
  readonly runRetention: HostDeckStartupMaintenancePorts["runRetention"];
}

export interface RunHostDeckStartupMaintenanceInput {
  readonly now: () => Date;
  readonly ports: HostDeckStartupMaintenancePorts;
  readonly signal: AbortSignal;
}

export interface HostDeckStartupOrphanSummary {
  readonly status: "complete" | "degraded";
  readonly scan_complete: boolean;
  readonly actionable_remaining: boolean | null;
  readonly failure: boolean;
  readonly reconciled_operation_count: number;
  readonly protected_recent_operation_count: number | null;
}

export interface HostDeckStartupRetentionSummary {
  readonly status: "complete" | "degraded";
  readonly output_scan_complete: boolean;
  readonly audit_scan_complete: boolean;
  readonly output_actionable_remaining: boolean | null;
  readonly audit_actionable_remaining: boolean | null;
  readonly failure: boolean;
  readonly pruned_event_count: number;
  readonly deleted_audit_operation_count: number;
}

export interface HostDeckStartupMaintenanceSummary {
  readonly cutoff_at: string;
  readonly status: "ready" | "degraded" | "failed";
  readonly orphan: HostDeckStartupOrphanSummary;
  readonly retention: HostDeckStartupRetentionSummary;
  readonly storage_observation: HostDeckLocalHealthObservation;
}

interface ParsedOrphanResult extends HostDeckStartupOrphanSummary {
  readonly has_failure: boolean;
}

interface ParsedRetentionResult extends HostDeckStartupRetentionSummary {
  readonly has_failure: boolean;
}

const acceptedPorts = new WeakSet<object>();
const acceptedErrors = new WeakSet<object>();
const startupErrorToken = Symbol("HostDeckStartupMaintenanceError");
const failureCodePattern = /^[a-z][a-z0-9_]{0,119}$/u;
const orphanReasons = new Set([
  "aborted",
  "batch_limit",
  "clock_failure",
  "storage_failure",
  "timeout"
]);
const retentionReasons = new Set([
  "aborted",
  "audit_batch_limit",
  "clock_failure",
  "concurrent_output_change",
  "newest_audit_trail_oversize",
  "newest_output_event_oversize",
  "output_batch_limit",
  "protected_audit_operations",
  "storage_failure",
  "timeout"
]);
const retentionFailureScopes = new Set(["audit", "output", "runner"]);

const startupErrorMessages: Readonly<
  Record<HostDeckStartupMaintenanceErrorCode, string>
> = Object.freeze({
  clock_invalid: "Host startup maintenance clock is invalid.",
  configuration_invalid: "Host startup maintenance configuration is invalid.",
  orphan_contract_invalid: "Audit orphan reconciliation returned invalid startup truth.",
  orphan_failed: "Audit orphan reconciliation failed before returning startup truth.",
  retention_contract_invalid: "Retention maintenance returned invalid startup truth.",
  retention_failed: "Retention maintenance failed before returning startup truth."
});

export function createHostDeckStartupMaintenancePorts(
  input: CreateHostDeckStartupMaintenancePortsInput
): HostDeckStartupMaintenancePorts {
  const values = readExactObject(input, [
    "reconcileAuditOrphans",
    "runRetention"
  ]);
  if (
    typeof values.reconcileAuditOrphans !== "function" ||
    typeof values.runRetention !== "function"
  ) {
    throw startupError("configuration_invalid");
  }
  const ports: HostDeckStartupMaintenancePorts = Object.freeze({
    reconcileAuditOrphans:
      values.reconcileAuditOrphans as HostDeckStartupMaintenancePorts["reconcileAuditOrphans"],
    runRetention:
      values.runRetention as HostDeckStartupMaintenancePorts["runRetention"]
  });
  acceptedPorts.add(ports);
  return ports;
}

export function assertHostDeckStartupMaintenancePorts(
  candidate: unknown
): asserts candidate is HostDeckStartupMaintenancePorts {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedPorts.has(candidate)
  ) {
    throw new TypeError(
      "Startup maintenance ports must be created by createHostDeckStartupMaintenancePorts."
    );
  }
}

export function isHostDeckStartupMaintenanceError(
  candidate: unknown
): candidate is HostDeckStartupMaintenanceError {
  return (
    candidate instanceof HostDeckStartupMaintenanceError &&
    acceptedErrors.has(candidate)
  );
}

export async function runHostDeckStartupMaintenance(
  input: RunHostDeckStartupMaintenanceInput
): Promise<HostDeckStartupMaintenanceSummary> {
  const values = readExactObject(input, ["now", "ports", "signal"]);
  if (typeof values.now !== "function" || !isAbortSignal(values.signal)) {
    throw startupError("configuration_invalid");
  }
  try {
    assertHostDeckStartupMaintenancePorts(values.ports);
  } catch {
    throw startupError("configuration_invalid");
  }
  const cutoff = readClock(values.now as () => Date);
  const ports = values.ports as HostDeckStartupMaintenancePorts;
  const signal = values.signal;

  let rawOrphan: StartupAuditOrphanReconciliationResult;
  try {
    rawOrphan = await ports.reconcileAuditOrphans(
      Object.freeze({
        eligible_before: cutoff,
        reconciled_at: cutoff,
        signal
      })
    );
  } catch {
    throw startupError("orphan_failed");
  }
  let orphan: ParsedOrphanResult;
  try {
    orphan = parseOrphanResult(rawOrphan, cutoff);
  } catch {
    throw startupError("orphan_contract_invalid");
  }

  let rawRetention: StartupRetentionMaintenanceResult;
  try {
    rawRetention = await ports.runRetention(
      Object.freeze({ cutoff_at: cutoff, signal })
    );
  } catch {
    throw startupError("retention_failed");
  }
  let retention: ParsedRetentionResult;
  try {
    retention = parseRetentionResult(rawRetention, cutoff);
  } catch {
    throw startupError("retention_contract_invalid");
  }

  const failed = orphan.has_failure || retention.has_failure;
  const ready = orphan.status === "complete" && retention.status === "complete";
  const status: HostDeckStartupMaintenanceSummary["status"] = failed
    ? "failed"
    : ready
      ? "ready"
      : "degraded";
  const reasons: HostDeckReportedLocalHealthReason[] = [];
  if (status === "failed") {
    reasons.push("startup_maintenance_failed");
  } else if (status === "degraded") {
    if (orphan.status !== "complete") {
      reasons.push("audit_reconciliation_degraded");
    }
    if (retention.status !== "complete") reasons.push("retention_degraded");
  }
  const storageObservation: HostDeckLocalHealthObservation = Object.freeze({
    component: "storage",
    state: status,
    reasons: Object.freeze(reasons)
  });
  return Object.freeze({
    cutoff_at: cutoff,
    status,
    orphan: freezeOrphanSummary(orphan),
    retention: freezeRetentionSummary(retention),
    storage_observation: storageObservation
  });
}

function parseOrphanResult(
  candidate: unknown,
  cutoff: string
): ParsedOrphanResult {
  const values = readExactFrozenObject(candidate, [
    "actionable_remaining",
    "batch_count",
    "duration_ms",
    "eligible_before",
    "eligible_pending_operation_count",
    "failure",
    "protected_recent_operation_count",
    "reasons",
    "reconciled_at",
    "reconciled_operation_count",
    "scan_complete",
    "status",
    "total_pending_operation_count"
  ]);
  const status = parseStatus(values.status);
  const scanComplete = requireBoolean(values.scan_complete);
  const actionableRemaining = requireNullableBoolean(
    values.actionable_remaining
  );
  const reasons = parseFrozenReasonArray(values.reasons, orphanReasons);
  const failure = parseFailure(values.failure, false);
  if (
    values.eligible_before !== cutoff ||
    values.reconciled_at !== cutoff ||
    !isoTimestampSchema.safeParse(values.eligible_before).success ||
    !isoTimestampSchema.safeParse(values.reconciled_at).success
  ) {
    throw new TypeError();
  }
  requireNonnegativeNumber(values.duration_ms);
  requireNonnegativeInteger(values.batch_count);
  requireNullableNonnegativeInteger(values.eligible_pending_operation_count);
  requireNullableNonnegativeInteger(values.protected_recent_operation_count);
  requireNullableNonnegativeInteger(values.total_pending_operation_count);
  const reconciledOperationCount = requireNonnegativeInteger(
    values.reconciled_operation_count
  );
  assertStatusCoherence(
    status,
    scanComplete,
    actionableRemaining,
    reasons,
    failure
  );
  return Object.freeze({
    status,
    scan_complete: scanComplete,
    actionable_remaining: actionableRemaining,
    failure: failure !== null,
    has_failure: failure !== null,
    reconciled_operation_count: reconciledOperationCount,
    protected_recent_operation_count:
      values.protected_recent_operation_count as number | null
  });
}

function parseRetentionResult(
  candidate: unknown,
  cutoff: string
): ParsedRetentionResult {
  const values = readExactFrozenObject(candidate, [
    "audit",
    "cutoff_at",
    "duration_ms",
    "failure",
    "output",
    "reasons",
    "status"
  ]);
  const status = parseStatus(values.status);
  if (
    values.cutoff_at !== cutoff ||
    !isoTimestampSchema.safeParse(values.cutoff_at).success
  ) {
    throw new TypeError();
  }
  requireNonnegativeNumber(values.duration_ms);
  const reasons = parseFrozenReasonArray(values.reasons, retentionReasons);
  const failure = parseFailure(values.failure, true);
  const audit = readExactFrozenObject(values.audit, [
    "actionable_remaining",
    "batch_count",
    "deleted_operation_count",
    "deleted_record_count",
    "newest_trail_oversize",
    "pending_blocks_policy",
    "protected_pending_operation_count",
    "retained_record_count",
    "scan_complete"
  ]);
  const output = readExactFrozenObject(values.output, [
    "actionable_remaining",
    "batch_count",
    "boundary_write_count",
    "newest_oversize_session_ids",
    "policy_violation_session_count",
    "pruned_event_count",
    "scan_complete",
    "sessions_touched_count"
  ]);
  const auditScanComplete = requireBoolean(audit.scan_complete);
  const outputScanComplete = requireBoolean(output.scan_complete);
  const auditActionable = requireNullableBoolean(audit.actionable_remaining);
  const outputActionable = requireNullableBoolean(output.actionable_remaining);
  requireNonnegativeInteger(audit.batch_count);
  const deletedOperationCount = requireNonnegativeInteger(
    audit.deleted_operation_count
  );
  requireNonnegativeInteger(audit.deleted_record_count);
  requireNullableBoolean(audit.newest_trail_oversize);
  requireNullableBoolean(audit.pending_blocks_policy);
  requireNullableNonnegativeInteger(audit.protected_pending_operation_count);
  requireNullableNonnegativeInteger(audit.retained_record_count);
  requireNonnegativeInteger(output.batch_count);
  requireNonnegativeInteger(output.boundary_write_count);
  requireNullableNonnegativeInteger(output.policy_violation_session_count);
  const prunedEventCount = requireNonnegativeInteger(output.pruned_event_count);
  requireNonnegativeInteger(output.sessions_touched_count);
  parseFrozenSessionIds(output.newest_oversize_session_ids);
  assertRetentionStatusCoherence(
    status,
    auditScanComplete,
    outputScanComplete,
    auditActionable,
    outputActionable,
    reasons,
    failure
  );
  return Object.freeze({
    status,
    output_scan_complete: outputScanComplete,
    audit_scan_complete: auditScanComplete,
    output_actionable_remaining: outputActionable,
    audit_actionable_remaining: auditActionable,
    failure: failure !== null,
    has_failure: failure !== null,
    pruned_event_count: prunedEventCount,
    deleted_audit_operation_count: deletedOperationCount
  });
}

function assertStatusCoherence(
  status: "complete" | "degraded",
  scanComplete: boolean,
  actionableRemaining: boolean | null,
  reasons: readonly string[],
  failure: Readonly<Record<string, unknown>> | null
): void {
  if (
    status === "complete" &&
    (!scanComplete ||
      actionableRemaining !== false ||
      reasons.length !== 0 ||
      failure !== null)
  ) {
    throw new TypeError();
  }
  if (
    status === "degraded" &&
    scanComplete &&
    actionableRemaining === false &&
    reasons.length === 0 &&
    failure === null
  ) {
    throw new TypeError();
  }
}

function assertRetentionStatusCoherence(
  status: "complete" | "degraded",
  auditScanComplete: boolean,
  outputScanComplete: boolean,
  auditActionable: boolean | null,
  outputActionable: boolean | null,
  reasons: readonly string[],
  failure: Readonly<Record<string, unknown>> | null
): void {
  const complete =
    auditScanComplete &&
    outputScanComplete &&
    auditActionable === false &&
    outputActionable === false &&
    reasons.length === 0 &&
    failure === null;
  if ((status === "complete") !== complete) throw new TypeError();
}

function parseFailure(
  candidate: unknown,
  includeScope: boolean
): Readonly<Record<string, unknown>> | null {
  if (candidate === null) return null;
  const failure = readExactFrozenObject(
    candidate,
    includeScope ? ["code", "scope"] : ["code"]
  );
  if (
    typeof failure.code !== "string" ||
    !failureCodePattern.test(failure.code) ||
    (includeScope &&
      (typeof failure.scope !== "string" ||
        !retentionFailureScopes.has(failure.scope)))
  ) {
    throw new TypeError();
  }
  return failure;
}

function parseFrozenReasonArray(
  candidate: unknown,
  allowed: ReadonlySet<string>
): readonly string[] {
  const values = readExactFrozenArray(candidate);
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      !allowed.has(value) ||
      seen.has(value)
    ) {
      throw new TypeError();
    }
    seen.add(value);
  }
  return values as readonly string[];
}

function parseFrozenSessionIds(candidate: unknown): readonly string[] {
  const values = readExactFrozenArray(candidate);
  const seen = new Set<string>();
  for (const value of values) {
    const parsed = sessionIdSchema.safeParse(value);
    if (!parsed.success || seen.has(parsed.data)) throw new TypeError();
    seen.add(parsed.data);
  }
  return values as readonly string[];
}

function freezeOrphanSummary(
  parsed: ParsedOrphanResult
): HostDeckStartupOrphanSummary {
  return Object.freeze({
    status: parsed.status,
    scan_complete: parsed.scan_complete,
    actionable_remaining: parsed.actionable_remaining,
    failure: parsed.failure,
    reconciled_operation_count: parsed.reconciled_operation_count,
    protected_recent_operation_count: parsed.protected_recent_operation_count
  });
}

function freezeRetentionSummary(
  parsed: ParsedRetentionResult
): HostDeckStartupRetentionSummary {
  return Object.freeze({
    status: parsed.status,
    output_scan_complete: parsed.output_scan_complete,
    audit_scan_complete: parsed.audit_scan_complete,
    output_actionable_remaining: parsed.output_actionable_remaining,
    audit_actionable_remaining: parsed.audit_actionable_remaining,
    failure: parsed.failure,
    pruned_event_count: parsed.pruned_event_count,
    deleted_audit_operation_count: parsed.deleted_audit_operation_count
  });
}

function parseStatus(candidate: unknown): "complete" | "degraded" {
  if (candidate !== "complete" && candidate !== "degraded") {
    throw new TypeError();
  }
  return candidate;
}

function requireBoolean(candidate: unknown): boolean {
  if (typeof candidate !== "boolean") throw new TypeError();
  return candidate;
}

function requireNullableBoolean(candidate: unknown): boolean | null {
  if (candidate !== null && typeof candidate !== "boolean") {
    throw new TypeError();
  }
  return candidate as boolean | null;
}

function requireNonnegativeInteger(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new TypeError();
  }
  return candidate as number;
}

function requireNullableNonnegativeInteger(candidate: unknown): number | null {
  if (candidate === null) return null;
  return requireNonnegativeInteger(candidate);
}

function requireNonnegativeNumber(candidate: unknown): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw new TypeError();
  }
  return candidate;
}

function readClock(now: () => Date): string {
  try {
    const candidate = Reflect.apply(now, undefined, []);
    if (!(candidate instanceof Date)) throw new TypeError();
    const milliseconds = Date.prototype.getTime.call(candidate);
    if (!Number.isFinite(milliseconds)) throw new TypeError();
    const timestamp = new Date(milliseconds).toISOString();
    if (!isoTimestampSchema.safeParse(timestamp).success) throw new TypeError();
    return timestamp;
  } catch {
    throw startupError("clock_invalid");
  }
}

function readExactObject(
  candidate: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw startupError("configuration_invalid");
  }
  try {
    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string") ||
      expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError();
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (isHostDeckStartupMaintenanceError(error)) throw error;
    throw startupError("configuration_invalid");
  }
}

function readExactFrozenObject(
  candidate: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (!Object.isFrozen(candidate)) throw new TypeError();
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string") ||
      expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError();
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new TypeError();
  }
}

function readExactFrozenArray(candidate: unknown): readonly unknown[] {
  if (!Array.isArray(candidate) || !Object.isFrozen(candidate)) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as
    Record<string, PropertyDescriptor>;
  const length = descriptors.length?.value;
  if (
    Object.getPrototypeOf(candidate) !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    Reflect.ownKeys(descriptors).length !== (length as number) + 1
  ) {
    throw new TypeError();
  }
  const values: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError();
    }
    values.push(descriptor.value);
  }
  return Object.freeze(values);
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as AbortSignal).aborted === "boolean" &&
    typeof (candidate as AbortSignal).addEventListener === "function"
  );
}

function startupError(
  code: HostDeckStartupMaintenanceErrorCode
): HostDeckStartupMaintenanceError {
  const error = new HostDeckStartupMaintenanceError(startupErrorToken, code);
  acceptedErrors.add(error);
  return error;
}
