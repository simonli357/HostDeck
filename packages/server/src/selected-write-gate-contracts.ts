import {
  auditPayloadSummarySchema,
  clientOperationIdSchema,
  isoTimestampSchema,
  type SelectedAuditTarget,
  selectedAuditTargetSchema,
  selectedSecurityAuditPayloadContractSchema
} from "@hostdeck/contracts";
import {
  type ErrorCode,
  isErrorCode,
  type RuntimeCapability,
  runtimeCapabilities
} from "@hostdeck/core";
import type {
  ExecuteSecurityMutationInput,
  SecurityMutationExecutionResult
} from "./security-mutation-audit-executor.js";
import {
  type SelectedApiAuditAction,
  type SelectedApiAuditExecutor,
  type SelectedApiRouteManifestEntry,
  selectedApiAuditActions,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export type ExecuteSelectedWriteAuditInput<
  TAction extends SelectedApiAuditAction,
  TResponse,
  TPreparedResponse
> = Omit<ExecuteSecurityMutationInput<TResponse, TPreparedResponse>, "action"> & {
  readonly action: TAction;
};

export type HostDeckSelectedWriteAuditExecute<TAction extends SelectedApiAuditAction> = <
  TResponse,
  TPreparedResponse
>(
  input: ExecuteSelectedWriteAuditInput<TAction, TResponse, TPreparedResponse>
) => Promise<SecurityMutationExecutionResult<TPreparedResponse>>;

export interface HostDeckSelectedWriteAuditPort<
  TAction extends SelectedApiAuditAction = SelectedApiAuditAction
> {
  readonly executor: SelectedApiAuditExecutor;
  readonly execute: HostDeckSelectedWriteAuditExecute<TAction>;
}

export interface CreateHostDeckSelectedWriteAuditPortInput<
  TAction extends SelectedApiAuditAction
> {
  readonly executor: SelectedApiAuditExecutor;
  readonly execute: HostDeckSelectedWriteAuditExecute<TAction>;
}

export interface HostDeckSelectedWriteMutation<TAction extends SelectedApiAuditAction, TValue> {
  readonly operation_id: string;
  readonly action: TAction;
  readonly target: SelectedAuditTarget;
  readonly accepted_summary: Readonly<Record<string, string | number | boolean | null>>;
  readonly value: TValue;
}

export interface CreateHostDeckSelectedWriteMutationInput<
  TAction extends SelectedApiAuditAction,
  TValue
> {
  readonly operation_id: string;
  readonly action: TAction;
  readonly target: SelectedAuditTarget;
  readonly accepted_summary: unknown;
  readonly value: TValue;
}

export interface HostDeckSelectedWriteUnresolvedMutation<
  TAction extends SelectedApiAuditAction,
  TSelector,
  TValue
> {
  readonly operation_id: string;
  readonly action: TAction;
  readonly accepted_summary: Readonly<Record<string, string | number | boolean | null>>;
  readonly selector: TSelector;
  readonly value: TValue;
}

export interface CreateHostDeckSelectedWriteUnresolvedMutationInput<
  TAction extends SelectedApiAuditAction,
  TSelector,
  TValue
> {
  readonly operation_id: string;
  readonly action: TAction;
  readonly accepted_summary: unknown;
  readonly selector: TSelector;
  readonly value: TValue;
}

export interface HostDeckSelectedWriteAcceptedAuditReceipt {
  readonly audit_record_id: string;
  readonly accepted_at: string;
}

export interface HostDeckSelectedWriteAcceptedAuditContext
  extends HostDeckSelectedWriteAcceptedAuditReceipt {
  readonly audit_state: "accepted";
}

export interface HostDeckSelectedWriteTargetResolution<TValue> {
  readonly target: SelectedAuditTarget;
  readonly capability: RuntimeCapability | null;
  readonly value: TValue;
}

export interface CreateHostDeckSelectedWriteTargetResolutionInput<TValue> {
  readonly target: SelectedAuditTarget;
  readonly capability: RuntimeCapability | null;
  readonly value: TValue;
}

export type ParsedSelectedWriteTransition<TResponse> =
  | Readonly<{
      outcome: "succeeded";
      payload_summary: Readonly<Record<string, string | number | boolean | null>>;
      response: TResponse;
    }>
  | Readonly<{
      outcome: "failed" | "incomplete";
      error_code: ErrorCode;
      payload_summary: Readonly<Record<string, string | number | boolean | null>>;
    }>;

type SelectedWriteAuditPhase = "accepted" | "terminal";
type SelectedWriteAuditOutcome =
  | "accepted"
  | "failed"
  | "incomplete"
  | "succeeded";

interface SelectedWriteSummaryContract {
  readonly intent: readonly string[];
  readonly success: readonly string[];
}

const acceptedAuditPorts = new WeakSet<object>();
const acceptedMutations = new WeakSet<object>();
const acceptedUnresolvedMutations = new WeakSet<object>();
const acceptedTargetResolutions = new WeakSet<object>();
const canonicalDataLimits = Object.freeze({
  arrayItems: 256,
  depth: 8,
  objectKeyLength: 256,
  objectFields: 64,
  stringLength: 131_072,
  values: 512
});
const selectedWriteSummaryContracts: Partial<
  Record<SelectedApiAuditAction, SelectedWriteSummaryContract>
> = Object.freeze({
  session_start: summaryContract(["name_length", "cwd_present"], ["created"]),
  prompt: summaryContract(["text_length"], ["accepted"]),
  model: summaryContract(
    ["model_id", "reasoning_effort", "expected_revision_present"],
    ["changed"]
  ),
  goal: summaryContract(
    ["goal_action", "objective_length", "expected_revision_present"],
    ["changed"]
  ),
  plan: summaryContract(["plan_action", "expected_revision_present"], ["changed"]),
  compact: summaryContract(["confirmed"], ["accepted"]),
  approval_response: summaryContract(["decision", "confirmed"], ["applied"]),
  interrupt: summaryContract(["confirmed"], ["interrupted"]),
  archive: summaryContract(["confirmed"], ["archived"])
});

export function createHostDeckSelectedWriteAuditPort<
  TAction extends SelectedApiAuditAction
>(
  input: CreateHostDeckSelectedWriteAuditPortInput<TAction>
): HostDeckSelectedWriteAuditPort<TAction> {
  const values = readExactDataObject(
    input,
    ["executor", "execute"],
    "HostDeck selected-write audit port input is invalid."
  );
  if (
    (values.executor !== "selected_write_gate" && values.executor !== "security_executor") ||
    typeof values.execute !== "function"
  ) {
    throw new TypeError("HostDeck selected-write audit port is invalid.");
  }
  const port: HostDeckSelectedWriteAuditPort<TAction> = Object.freeze({
    executor: values.executor,
    execute: values.execute as HostDeckSelectedWriteAuditExecute<TAction>
  });
  acceptedAuditPorts.add(port);
  return port;
}

export function assertHostDeckSelectedWriteAuditPort<
  TAction extends SelectedApiAuditAction
>(candidate: unknown): asserts candidate is HostDeckSelectedWriteAuditPort<TAction> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedAuditPorts.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck selected-write audit port must be created by createHostDeckSelectedWriteAuditPort."
    );
  }
}

export function createHostDeckSelectedWriteMutation<
  TAction extends SelectedApiAuditAction,
  TValue
>(
  input: CreateHostDeckSelectedWriteMutationInput<TAction, TValue>
): HostDeckSelectedWriteMutation<TAction, TValue> {
  const values = readExactDataObject(
    input,
    ["accepted_summary", "action", "operation_id", "target", "value"],
    "HostDeck selected-write mutation input is invalid."
  );
  const operationId = clientOperationIdSchema.safeParse(values.operation_id);
  assertDataObject(values.target, "Selected-write mutation target is invalid.");
  const target = selectedAuditTargetSchema.safeParse(values.target);
  if (
    !operationId.success ||
    !target.success ||
    typeof values.action !== "string" ||
    !(selectedApiAuditActions as readonly string[]).includes(values.action)
  ) {
    throw new TypeError("HostDeck selected-write mutation does not match its bounded contract.");
  }
  const summary = parseSelectedWriteAuditSummary(
    values.action as TAction,
    "accepted",
    "accepted",
    values.accepted_summary
  );
  const value = cloneCanonicalData(values.value, "Selected-write mutation value is invalid.");
  const mutation: HostDeckSelectedWriteMutation<TAction, TValue> = Object.freeze({
    operation_id: operationId.data,
    action: values.action as TAction,
    target: deepFreeze(target.data),
    accepted_summary: summary,
    value: value as TValue
  });
  acceptedMutations.add(mutation);
  return mutation;
}

export function assertHostDeckSelectedWriteMutation<
  TAction extends SelectedApiAuditAction,
  TValue
>(candidate: unknown): asserts candidate is HostDeckSelectedWriteMutation<TAction, TValue> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedMutations.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck selected-write mutation must be created by createHostDeckSelectedWriteMutation."
    );
  }
}

export function createHostDeckSelectedWriteUnresolvedMutation<
  TAction extends SelectedApiAuditAction,
  TSelector,
  TValue
>(
  input: CreateHostDeckSelectedWriteUnresolvedMutationInput<TAction, TSelector, TValue>
): HostDeckSelectedWriteUnresolvedMutation<TAction, TSelector, TValue> {
  const values = readExactDataObject(
    input,
    ["accepted_summary", "action", "operation_id", "selector", "value"],
    "HostDeck unresolved selected-write mutation input is invalid."
  );
  const operationId = clientOperationIdSchema.safeParse(values.operation_id);
  if (
    !operationId.success ||
    typeof values.action !== "string" ||
    !(selectedApiAuditActions as readonly string[]).includes(values.action)
  ) {
    throw new TypeError(
      "HostDeck unresolved selected-write mutation does not match its bounded contract."
    );
  }
  const summary = parseSelectedWriteAuditSummary(
    values.action as TAction,
    "accepted",
    "accepted",
    values.accepted_summary
  );
  const selector = cloneCanonicalData(
    values.selector,
    "Unresolved selected-write selector is invalid."
  );
  const value = cloneCanonicalData(
    values.value,
    "Unresolved selected-write mutation value is invalid."
  );
  const mutation: HostDeckSelectedWriteUnresolvedMutation<TAction, TSelector, TValue> =
    Object.freeze({
      operation_id: operationId.data,
      action: values.action as TAction,
      accepted_summary: summary,
      selector: selector as TSelector,
      value: value as TValue
    });
  acceptedUnresolvedMutations.add(mutation);
  return mutation;
}

export function assertHostDeckSelectedWriteUnresolvedMutation<
  TAction extends SelectedApiAuditAction,
  TSelector,
  TValue
>(
  candidate: unknown
): asserts candidate is HostDeckSelectedWriteUnresolvedMutation<TAction, TSelector, TValue> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedUnresolvedMutations.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck unresolved selected-write mutation must be created by createHostDeckSelectedWriteUnresolvedMutation."
    );
  }
}

export function createHostDeckSelectedWriteTargetResolution<TValue>(
  input: CreateHostDeckSelectedWriteTargetResolutionInput<TValue>
): HostDeckSelectedWriteTargetResolution<TValue> {
  const values = readExactDataObject(
    input,
    ["capability", "target", "value"],
    "HostDeck selected-write target resolution input is invalid."
  );
  assertDataObject(values.target, "Selected-write target resolution target is invalid.");
  const target = selectedAuditTargetSchema.safeParse(values.target);
  if (
    !target.success ||
    (values.capability !== null &&
      (typeof values.capability !== "string" ||
        !(runtimeCapabilities as readonly string[]).includes(values.capability)))
  ) {
    throw new TypeError("HostDeck selected-write target resolution is invalid.");
  }
  const value = cloneCanonicalData(
    values.value,
    "Selected-write target resolution value is invalid."
  );
  const resolution: HostDeckSelectedWriteTargetResolution<TValue> = Object.freeze({
    target: deepFreeze(target.data),
    capability: values.capability as RuntimeCapability | null,
    value: value as TValue
  });
  acceptedTargetResolutions.add(resolution);
  return resolution;
}

export function assertHostDeckSelectedWriteTargetResolution<TValue>(
  candidate: unknown
): asserts candidate is HostDeckSelectedWriteTargetResolution<TValue> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedTargetResolutions.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck selected-write target resolution must be created by createHostDeckSelectedWriteTargetResolution."
    );
  }
}

export function requireSelectedWriteManifest(
  candidate: unknown,
  executor: SelectedApiAuditExecutor
): SelectedApiRouteManifestEntry {
  const entry = selectedApiRouteManifest.find((current) => current === candidate);
  if (entry === undefined || !Object.isFrozen(entry) || entry.audit === null) {
    throw new TypeError("HostDeck selected-write gate requires one selected manifest entry by identity.");
  }
  if (
    entry.method !== "POST" ||
    entry.transport !== "json" ||
    entry.auth !== "local_admin_or_device_cookie" ||
    entry.csrf !== "required_for_device" ||
    !["not_applicable", "requires_unlocked_host"].includes(entry.lock) ||
    entry.audit.executor !== executor ||
    entry.audit.catalog_state !== "selected" ||
    entry.audit.catalog_owner_task !== null ||
    (entry.operation_kind !== null && entry.operation_kind !== entry.audit.action)
  ) {
    throw new TypeError("HostDeck selected-write manifest policy is contradictory.");
  }
  if (executor === "selected_write_gate") {
    if (
      entry.lock !== "requires_unlocked_host" ||
      entry.authority !== "session_write" ||
      entry.credential_effect !== "none" ||
      !["new_managed_session", "managed_session", "approval", "turn"].includes(entry.target)
    ) {
      throw new TypeError("Selected operation manifest entry is not a common write-gate route.");
    }
  } else if (
    entry.id !== "device_revoke" ||
    entry.audit.action !== "device_revoke" ||
    entry.authority !== "device_admin" ||
    entry.target !== "device" ||
    entry.lock !== "not_applicable" ||
    entry.credential_effect !== "invalidate_device"
  ) {
    throw new TypeError("Security executor write-gate support is limited to exact device revocation.");
  }
  return entry;
}

export function parseSelectedWriteTransition<TResponse>(
  action: SelectedApiAuditAction,
  candidate: unknown
): ParsedSelectedWriteTransition<TResponse> {
  const values = readDataObject(candidate, "Selected-write dispatch result is invalid.");
  if (values.outcome === "succeeded") {
    assertExactKeys(
      values,
      ["outcome", "payload_summary", "response"],
      "Selected-write success result is invalid."
    );
    const summary = parseSelectedWriteAuditSummary(
      action,
      "terminal",
      "succeeded",
      values.payload_summary
    );
    return Object.freeze({
      outcome: "succeeded",
      payload_summary: summary,
      response: values.response as TResponse
    });
  }
  if (values.outcome !== "failed" && values.outcome !== "incomplete") {
    throw new TypeError("Selected-write dispatch outcome is invalid.");
  }
  assertExactKeys(
    values,
    ["error_code", "outcome", "payload_summary"],
    "Selected-write failure result is invalid."
  );
  if (typeof values.error_code !== "string" || !isErrorCode(values.error_code)) {
    throw new TypeError("Selected-write failure result is invalid.");
  }
  const summary = parseSelectedWriteAuditSummary(
    action,
    "terminal",
    values.outcome,
    values.payload_summary
  );
  return Object.freeze({
    outcome: values.outcome,
    error_code: values.error_code,
    payload_summary: summary
  });
}

export function parseSelectedWriteAuditSummary(
  action: SelectedApiAuditAction,
  phase: SelectedWriteAuditPhase,
  outcome: SelectedWriteAuditOutcome,
  candidate: unknown
): Readonly<Record<string, string | number | boolean | null>> {
  assertDataObject(candidate, "Selected-write audit summary is invalid.");
  const parsed = auditPayloadSummarySchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Selected-write audit summary is invalid.");
  if (action === "device_revoke") {
    const security = selectedSecurityAuditPayloadContractSchema.safeParse({
      action,
      phase,
      outcome,
      payload_summary: parsed.data
    });
    if (!security.success) throw new TypeError("Selected-write security summary is invalid.");
    return deepFreeze(parsed.data);
  }
  const contract = selectedWriteSummaryContracts[action];
  if (contract === undefined) {
    throw new TypeError("Selected-write audit action has no common-gate summary contract.");
  }
  const summary = parsed.data;
  if ((phase === "accepted") !== (outcome === "accepted")) {
    throw new TypeError("Selected-write audit phase and outcome are contradictory.");
  }
  if (summary.schema_version !== 1) {
    throw new TypeError("Selected-write audit summary schema version is invalid.");
  }
  const required =
    phase === "accepted"
      ? contract.intent
      : outcome === "succeeded"
        ? contract.success
        : [];
  const allowed = new Set(["schema_version", ...required]);
  for (const [key, value] of Object.entries(summary)) {
    if (!allowed.has(key) || !validSummaryField(key, value)) {
      throw new TypeError("Selected-write audit summary field is invalid.");
    }
  }
  if (
    Object.keys(summary).length !== required.length + 1 ||
    required.some((key) => summary[key] === undefined)
  ) {
    throw new TypeError("Selected-write audit summary is missing required fields.");
  }
  if (action === "goal" && phase === "accepted") {
    const setting = summary.goal_action === "set";
    const objectiveLength = summary.objective_length;
    if (
      typeof objectiveLength !== "number" ||
      (setting ? objectiveLength < 1 : objectiveLength !== 0) ||
      (!setting && summary.expected_revision_present !== true)
    ) {
      throw new TypeError("Selected-write goal summary is contradictory.");
    }
  }
  return deepFreeze(summary);
}

export function parseSelectedWriteAuditResult<TPreparedResponse>(
  candidate: unknown
): SecurityMutationExecutionResult<TPreparedResponse> {
  const values = readExactFrozenVariant(candidate, [
    ["outcome", "response"],
    ["error_code", "outcome"]
  ]);
  if (values.outcome === "succeeded") {
    return Object.freeze({ outcome: "succeeded", response: values.response as TPreparedResponse });
  }
  if (
    (values.outcome === "failed" || values.outcome === "incomplete") &&
    typeof values.error_code === "string" &&
    isErrorCode(values.error_code)
  ) {
    return Object.freeze({ outcome: values.outcome, error_code: values.error_code });
  }
  throw new TypeError("Selected-write audit result is invalid.");
}

export function parseAcceptedAuditContext(
  candidate: unknown,
  executor: SelectedApiAuditExecutor
): HostDeckSelectedWriteAcceptedAuditReceipt | null {
  if (executor === "security_executor") {
    const values = readExactFrozenDataObject(candidate, ["audit_state"]);
    if (values.audit_state !== "accepted") {
      throw new TypeError("Selected-write dispatch requires accepted durable audit context.");
    }
    return null;
  }
  const values = readExactFrozenDataObject(candidate, [
    "accepted_at",
    "audit_record_id",
    "audit_state"
  ]);
  if (
    values.audit_state !== "accepted" ||
    typeof values.audit_record_id !== "string" ||
    values.audit_record_id.length < 1 ||
    values.audit_record_id.length > 120 ||
    !/^[a-zA-Z0-9_.:-]+$/u.test(values.audit_record_id)
  ) {
    throw new TypeError("Selected-write dispatch requires accepted durable audit context.");
  }
  const acceptedAt = isoTimestampSchema.safeParse(values.accepted_at);
  if (!acceptedAt.success) {
    throw new TypeError("Selected-write dispatch requires accepted durable audit context.");
  }
  return Object.freeze({
    audit_record_id: values.audit_record_id,
    accepted_at: acceptedAt.data
  });
}

export function readExactDataObject<const TKey extends string>(
  candidate: unknown,
  expectedKeys: readonly TKey[],
  message: string
): Readonly<Record<TKey, unknown>> {
  try {
    return readDataObjectWithKeys(candidate, expectedKeys);
  } catch {
    throw new TypeError(message);
  }
}

function readDataObject(candidate: unknown, message: string): Readonly<Record<string, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 16 || keys.some((key) => typeof key !== "string")) throw new TypeError();
    const values: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
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
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    throw new TypeError(message);
  }
}

function readDataObjectWithKeys<const TKey extends string>(
  candidate: unknown,
  expectedKeys: readonly TKey[]
): Readonly<Record<TKey, unknown>> {
  const values = readDataObject(candidate, "Boundary object is invalid.");
  assertExactKeys(values, expectedKeys, "Boundary object fields are invalid.");
  return values as Readonly<Record<TKey, unknown>>;
}

function readExactFrozenDataObject<const TKey extends string>(
  candidate: unknown,
  expectedKeys: readonly TKey[]
): Readonly<Record<TKey, unknown>> {
  const values = readDataObjectWithKeys(candidate, expectedKeys);
  if (!Object.isFrozen(candidate)) throw new TypeError("Frozen boundary object is invalid.");
  return values;
}

function readExactFrozenVariant(
  candidate: unknown,
  variants: readonly (readonly string[])[]
): Readonly<Record<string, unknown>> {
  for (const keys of variants) {
    try {
      return readExactFrozenDataObject(candidate, keys);
    } catch {
      // Try the next exact result variant.
    }
  }
  throw new TypeError("Frozen boundary result variant is invalid.");
}

function assertExactKeys(
  values: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  message: string
): void {
  const keys = Object.keys(values).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(message);
  }
}

function assertDataObject(candidate: unknown, message: string): void {
  readDataObject(candidate, message);
}

function summaryContract(
  intent: readonly string[],
  success: readonly string[]
): SelectedWriteSummaryContract {
  return Object.freeze({
    intent: Object.freeze([...intent]),
    success: Object.freeze([...success])
  });
}

function validSummaryField(
  key: string,
  value: string | number | boolean | null
): boolean {
  switch (key) {
    case "schema_version":
      return value === 1;
    case "name_length":
      return isBoundedLength(value, 64, 1);
    case "text_length":
      return isBoundedLength(value, 20_000, 1);
    case "objective_length":
      return isBoundedLength(value, 512, 0);
    case "model_id":
      return isBoundedVisibleString(value, 160);
    case "reasoning_effort":
      return value === null || isBoundedVisibleString(value, 80);
    case "goal_action":
      return typeof value === "string" &&
        ["set", "pause", "resume", "complete", "clear"].includes(value);
    case "plan_action":
      return value === "enter" || value === "exit";
    case "decision":
      return value === "approve" || value === "deny";
    case "changed":
    case "expected_revision_present":
      return typeof value === "boolean";
    case "accepted":
    case "applied":
    case "archived":
    case "confirmed":
    case "created":
    case "cwd_present":
    case "interrupted":
    case "started":
      return value === true;
    default:
      return false;
  }
}

function isBoundedLength(value: unknown, maximum: number, minimum: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isBoundedVisibleString(value: unknown, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

function cloneCanonicalData(candidate: unknown, message: string): unknown {
  const seen = new WeakSet<object>();
  let values = 0;
  const clone = (value: unknown, depth: number): unknown => {
    values += 1;
    if (values > canonicalDataLimits.values || depth > canonicalDataLimits.depth) {
      throw new TypeError();
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > canonicalDataLimits.stringLength) throw new TypeError();
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError();
      return value;
    }
    if (typeof value !== "object" || seen.has(value)) throw new TypeError();
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > canonicalDataLimits.arrayItems) throw new TypeError();
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const keys = Reflect.ownKeys(descriptors);
        const expected = [...value.keys()].map(String);
        if (
          keys.length !== expected.length + 1 ||
          keys.some((key) => typeof key !== "string") ||
          expected.some((key) => !Object.hasOwn(descriptors, key))
        ) {
          throw new TypeError();
        }
        const result = value.map((_item, index) => {
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
          return clone(descriptor.value, depth + 1);
        });
        return Object.freeze(result);
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.length > canonicalDataLimits.objectFields ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            !isBoundedVisibleString(key, canonicalDataLimits.objectKeyLength)
        )
      ) {
        throw new TypeError();
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys as string[]) {
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
        result[key] = clone(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(value);
    }
  };
  try {
    return clone(candidate, 0);
  } catch {
    throw new TypeError(message);
  }
}

function deepFreeze<T>(candidate: T): T {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
