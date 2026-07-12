import { isDeepStrictEqual } from "node:util";
import {
  isSelectedSecurityAuditAction,
  type SelectedAuditActor,
  type SelectedAuditTarget,
  type SelectedSecurityAuditEventRecord,
  selectedAuditTrailSchema,
  selectedSecurityAuditEventRecordSchema
} from "@hostdeck/contracts";
import type { ErrorCode, SelectedSecurityAuditAction } from "@hostdeck/core";
import type { SelectedAuditRepository } from "@hostdeck/storage";
import type { ExecuteSecurityMutationInput } from "./security-mutation-audit-executor.js";

export type AuditPayloadSummary = SelectedSecurityAuditEventRecord["payload_summary"];
export type TerminalOutcome = "failed" | "incomplete" | "succeeded";

export interface ParsedExecutionInput<TResponse, TPreparedResponse> {
  readonly operation_id: SelectedSecurityAuditEventRecord["operation_id"];
  readonly actor: SelectedAuditActor;
  readonly action: SelectedSecurityAuditAction;
  readonly target: SelectedAuditTarget;
  readonly accepted_summary: AuditPayloadSummary;
  readonly emergency_lock_on_audit_unavailable: boolean;
  readonly transition: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>["transition"];
  readonly prepare_response: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>["prepare_response"];
}

export interface ParsedTransition<TResponse> {
  readonly outcome: TerminalOutcome;
  readonly payload_summary: AuditPayloadSummary;
  readonly error_code: ErrorCode | null;
  readonly response?: TResponse;
}

interface InternalRepositoryPort {
  readonly recordAccepted: SelectedAuditRepository["recordAccepted"];
  readonly recordRejected: SelectedAuditRepository["recordRejected"];
  readonly recordTerminal: SelectedAuditRepository["recordTerminal"];
}

export interface InternalExecutorOptions {
  readonly repository: InternalRepositoryPort;
  readonly now: () => string;
  readonly createRecordId: () => string;
}

const validationRecordId = "audit:security:executor:validation";
const validationTimestamp = "2000-01-01T00:00:00.000Z";

export function parseExecutorOptions(input: unknown): InternalExecutorOptions {
  const values = readExactDataObject(
    input,
    ["create_record_id", "now", "repository"],
    "Security mutation audit executor input"
  );
  if (typeof values.now !== "function" || typeof values.create_record_id !== "function") {
    throw new TypeError("Security mutation audit executor clock and record-id factory must be functions.");
  }
  const repository = readExactDataObject(
    values.repository,
    ["get", "recordAccepted", "recordRejected", "recordTerminal", "require"],
    "Selected audit repository port"
  );
  for (const key of ["get", "recordAccepted", "recordRejected", "recordTerminal", "require"] as const) {
    if (typeof repository[key] !== "function") {
      throw new TypeError("Selected audit repository port members must be functions.");
    }
  }
  return Object.freeze({
    repository: Object.freeze({
      recordAccepted: repository.recordAccepted as SelectedAuditRepository["recordAccepted"],
      recordRejected: repository.recordRejected as SelectedAuditRepository["recordRejected"],
      recordTerminal: repository.recordTerminal as SelectedAuditRepository["recordTerminal"]
    }),
    now: values.now as () => string,
    createRecordId: values.create_record_id as () => string
  });
}

export function parseExecutionInput<TResponse, TPreparedResponse>(
  input: unknown
): ParsedExecutionInput<TResponse, TPreparedResponse> {
  const values = readExactDataObject(
    input,
    [
      "accepted_summary",
      "action",
      "actor",
      "emergency_lock_on_audit_unavailable",
      "operation_id",
      "prepare_response",
      "target",
      "transition"
    ],
    "Security mutation execution input"
  );
  if (
    typeof values.transition !== "function" ||
    typeof values.prepare_response !== "function" ||
    typeof values.emergency_lock_on_audit_unavailable !== "boolean"
  ) {
    throw new TypeError("Security mutation execution callbacks and emergency policy are invalid.");
  }
  assertSafeDataTree(values.actor, "Security audit actor");
  assertSafeDataTree(values.target, "Security audit target");
  assertSafeDataTree(values.accepted_summary, "Security audit accepted summary");
  const record = parseValidationRecord({
    operation_id: values.operation_id,
    actor: values.actor,
    action: values.action,
    target: values.target,
    phase: "accepted",
    outcome: "accepted",
    payload_summary: values.accepted_summary,
    error_code: null
  });
  if (values.emergency_lock_on_audit_unavailable && record.action !== "lock") {
    throw new TypeError("Only host lock may use emergency audit degradation.");
  }
  if (!isSelectedSecurityAuditAction(record.action)) {
    throw new TypeError("Security mutation execution requires one selected security action.");
  }
  return Object.freeze({
    operation_id: record.operation_id,
    actor: record.actor,
    action: record.action,
    target: record.target,
    accepted_summary: record.payload_summary,
    emergency_lock_on_audit_unavailable: values.emergency_lock_on_audit_unavailable,
    transition: values.transition as ParsedExecutionInput<TResponse, TPreparedResponse>["transition"],
    prepare_response: values.prepare_response as ParsedExecutionInput<TResponse, TPreparedResponse>["prepare_response"]
  });
}

export function parseRejectionInput(input: unknown): SelectedSecurityAuditEventRecord {
  const values = readExactDataObject(
    input,
    ["action", "actor", "error_code", "operation_id", "payload_summary", "target"],
    "Security mutation rejection input"
  );
  assertSafeDataTree(values.actor, "Security audit actor");
  assertSafeDataTree(values.target, "Security audit target");
  assertSafeDataTree(values.payload_summary, "Security audit rejected summary");
  return parseValidationRecord({
    operation_id: values.operation_id,
    actor: values.actor,
    action: values.action,
    target: values.target,
    phase: "terminal",
    outcome: "rejected",
    payload_summary: values.payload_summary,
    error_code: values.error_code
  });
}

export function parseTransition<TResponse>(
  input: unknown,
  accepted: SelectedSecurityAuditEventRecord
): ParsedTransition<TResponse> {
  const values = readDataObject(input, "Security mutation transition result");
  if (values.outcome === "succeeded") {
    assertExactKeys(values, ["outcome", "payload_summary", "response"], "Security mutation success result");
    assertSafeDataTree(values.payload_summary, "Security mutation success summary");
    const record = parseValidationRecord({
      ...recordIdentity(accepted),
      phase: "terminal",
      outcome: "succeeded",
      payload_summary: values.payload_summary,
      error_code: null
    });
    return Object.freeze({
      outcome: "succeeded",
      payload_summary: record.payload_summary,
      error_code: null,
      response: values.response as TResponse
    });
  }
  if (values.outcome !== "failed" && values.outcome !== "incomplete") {
    throw new TypeError("Security mutation transition outcome is invalid.");
  }
  assertExactKeys(
    values,
    ["error_code", "outcome", "payload_summary"],
    "Security mutation failure result"
  );
  assertSafeDataTree(values.payload_summary, "Security mutation failure summary");
  const record = parseValidationRecord({
    ...recordIdentity(accepted),
    phase: "terminal",
    outcome: values.outcome,
    payload_summary: values.payload_summary,
    error_code: values.error_code
  });
  return Object.freeze({
    outcome: record.outcome as "failed" | "incomplete",
    payload_summary: record.payload_summary,
    error_code: record.error_code as ErrorCode
  });
}

export function validationRecordFor<TResponse, TPreparedResponse>(
  input: ParsedExecutionInput<TResponse, TPreparedResponse>
): SelectedSecurityAuditEventRecord {
  return parseValidationRecord({
    operation_id: input.operation_id,
    actor: input.actor,
    action: input.action,
    target: input.target,
    phase: "accepted",
    outcome: "accepted",
    payload_summary: input.accepted_summary,
    error_code: null
  });
}

export function recordIdentity(record: SelectedSecurityAuditEventRecord) {
  return {
    operation_id: record.operation_id,
    actor: record.actor,
    action: record.action,
    target: record.target
  } as const;
}

export function proveAcceptedTrail(input: unknown, accepted: SelectedSecurityAuditEventRecord): void {
  const trail = parseSecurityTrail(input);
  if (trail.state !== "pending" || trail.records.length !== 1 || !isDeepStrictEqual(trail.records[0], accepted)) {
    throw new TypeError("Selected audit port did not prove the accepted record.");
  }
}

export function proveRejectedTrail(input: unknown, rejected: SelectedSecurityAuditEventRecord): void {
  const trail = parseSecurityTrail(input);
  if (trail.state !== "terminal" || trail.records.length !== 1 || !isDeepStrictEqual(trail.records[0], rejected)) {
    throw new TypeError("Selected audit port did not prove the rejected record.");
  }
}

export function proveTerminalTrail(
  input: unknown,
  accepted: SelectedSecurityAuditEventRecord,
  terminal: SelectedSecurityAuditEventRecord
): void {
  const trail = parseSecurityTrail(input);
  if (
    trail.state !== "terminal" ||
    trail.records.length !== 2 ||
    !isDeepStrictEqual(trail.records[0], accepted) ||
    !isDeepStrictEqual(trail.records[1], terminal)
  ) {
    throw new TypeError("Selected audit port did not prove the terminal record.");
  }
}

export function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function parseValidationRecord(
  input: Omit<SelectedSecurityAuditEventRecord, "at" | "id"> | Readonly<Record<string, unknown>>
): SelectedSecurityAuditEventRecord {
  const result = selectedSecurityAuditEventRecordSchema.safeParse({
    ...input,
    id: validationRecordId,
    at: validationTimestamp
  });
  if (!result.success) throw new TypeError("Security audit data does not match its selected contract.");
  return deepFreeze(result.data);
}

function parseSecurityTrail(input: unknown) {
  assertSafeTrailTree(input);
  const base = selectedAuditTrailSchema.safeParse(input);
  if (!base.success) throw new TypeError("Selected audit port returned an invalid trail.");
  const records = base.data.records.map((record) => {
    const parsed = selectedSecurityAuditEventRecordSchema.safeParse(record);
    if (!parsed.success) throw new TypeError("Selected audit port returned a non-security record.");
    return parsed.data;
  });
  const coherent = selectedAuditTrailSchema.safeParse({ ...base.data, records });
  if (!coherent.success) throw new TypeError("Selected audit port returned an incoherent trail.");
  return deepFreeze(coherent.data);
}

function assertSafeTrailTree(input: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object") return;
    if (depth > 8 || nodes >= 128 || seen.has(value)) {
      throw new TypeError("Selected audit trail data is cyclic or oversized.");
    }
    seen.add(value);
    nodes += 1;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("Selected audit trail array is invalid.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 2
      ) {
        throw new TypeError("Selected audit trail array length is invalid.");
      }
      const length = lengthDescriptor.value;
      const expectedKeys = [
        "length",
        ...Array.from({ length }, (_, index) => String(index))
      ].sort();
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some((key) => typeof key !== "string") ||
        keys.length !== expectedKeys.length ||
        (keys as string[]).sort().some((key, index) => key !== expectedKeys[index])
      ) {
        throw new TypeError("Selected audit trail array fields are invalid.");
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get || descriptor.set) {
          throw new TypeError("Selected audit trail array contains an accessor.");
        }
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Selected audit trail object prototype is invalid.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 32 || keys.some((key) => typeof key !== "string")) {
      throw new TypeError("Selected audit trail object fields are invalid.");
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("Selected audit trail object contains an accessor.");
      }
      visit(descriptor.value, depth + 1);
    }
  };
  try {
    visit(input, 0);
  } catch {
    throw new TypeError("Selected audit port returned unsafe trail data.");
  }
}

function readExactDataObject(
  input: unknown,
  expectedKeys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  const values = readDataObject(input, label);
  assertExactKeys(values, expectedKeys, label);
  return values;
}

function readDataObject(input: unknown, label: string): Readonly<Record<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError(label);
    if (Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError(label);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new TypeError(label);
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError(label);
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    throw new TypeError(`${label} must be an exact plain data object.`);
  }
}

function assertExactKeys(
  values: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(values).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function assertSafeDataTree(input: unknown, label: string): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object") return;
    if (depth > 4 || nodes >= 128 || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} structure is invalid.`);
    }
    if (seen.has(value)) throw new TypeError(`${label} cannot contain repeated object references.`);
    seen.add(value);
    nodes += 1;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 32 || keys.some((key) => typeof key !== "string")) {
      throw new TypeError(`${label} structure is invalid.`);
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError(`${label} must contain data properties only.`);
      }
      visit(descriptor.value, depth + 1);
    }
  };
  try {
    visit(input, 0);
  } catch {
    throw new TypeError(`${label} must be bounded plain data.`);
  }
}
