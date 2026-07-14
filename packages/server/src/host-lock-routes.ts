import {
  type SelectedAccessStateResponse,
  type SelectedHostLockStateResponse,
  type SelectedRequestAuthenticationContext,
  selectedAccessStateResponseSchema,
  selectedHostLockRequestSchema,
  selectedHostLockStateResponseSchema,
  selectedHostUnlockRequestSchema,
  settingsRecordSchema
} from "@hostdeck/contracts";
import { type ErrorCode, isErrorCode } from "@hostdeck/core";
import {
  type HostDeckLockTransitionReceipt,
  HostDeckSettingsError,
  type TransitionHostDeckLockInput
} from "@hostdeck/storage";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  assertHostDeckCsrfPolicy,
  type HostDeckCsrfPolicy,
  requireHostDeckRequestCsrfWriteAuthorization
} from "./csrf-routes.js";
import { type HostDeckRoutePluginRegistration, hostDeckNoStoreRouteConfig } from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationCurrent,
  hostDeckRequestAuthenticationIngressContext,
  requireHostDeckRequestAuthentication,
  resolveHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  assertHostDeckSecurityMutationAuditExecutor, 
  HostDeckSecurityMutationAuditExecutorError,
  type SecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckHostLockRouteRegistrationId = "selected-host-lock";

export interface HostDeckHostLockPort {
  readonly read: () => unknown;
  readonly transition: (input: TransitionHostDeckLockInput) => unknown;
}
export interface CreateHostDeckHostLockPolicyInput {
  readonly settings: HostDeckHostLockPort;
  readonly now: () => Date;
}
export interface HostDeckHostLockPolicy extends HostDeckHostLockPort {
  readonly now: () => Date;
}
export interface HostDeckHostLockPolicySnapshot {
  readonly access_reads: number;
  readonly audit_failures: number;
  readonly gate_checks: number;
  readonly gate_rejections: number;
  readonly lock_changes: number;
  readonly lock_noops: number;
  readonly storage_failures: number;
  readonly transitions: number;
}
export interface HostDeckDurableLockState {
  readonly locked: boolean;
  readonly settings_updated_at: string;
}
export interface CreateHostDeckHostLockRouteRegistrationInput {
  readonly audit: SecurityMutationAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
}

interface MutableCounters {
  accessReads: number;
  auditFailures: number;
  gateChecks: number;
  gateRejections: number;
  lockChanges: number;
  lockNoops: number;
  storageFailures: number;
  transitions: number;
}

type ExecuteAudit = SecurityMutationAuditExecutor["execute"];
type ReadSettings = HostDeckHostLockPort["read"];
type TransitionLock = HostDeckHostLockPort["transition"];
const acceptedPolicies = new WeakSet<object>();
const policyCounters = new WeakMap<HostDeckHostLockPolicy, MutableCounters>();
const registeredPolicies = new WeakSet<object>();
const policyInputKeys = ["settings", "now"] as const;
const policyPortKeys = ["read", "transition"] as const;
const routeInputKeys = ["audit", "csrf", "lock"] as const;
const auditPortKeys = ["execute", "reject", "snapshot"] as const;
const settingsKeys = [
  "id", "schema_version", "state_dir", "bind_mode", "bind_host", "bind_port",
  "lan_enabled", "locked", "retention", "updated_at"
] as const;
const retentionKeys = ["output_event_limit", "output_byte_limit", "audit_event_limit", "audit_retention_days"] as const;
const lockStateKeys = ["locked", "settings_updated_at"] as const;
const transitionReceiptKeys = ["before", "after", "changed"] as const;
const responseKeys = [
  "authentication_state", "device_id", "permission", "device_expires_at", "configured_origin",
  "network_mode", "transport", "locked", "can_read_sessions", "can_write_sessions", "can_lock", "can_unlock"
] as const;
const auditSuccessKeys = ["outcome", "response"] as const;
const auditFailureKeys = ["outcome", "error_code"] as const;
const noQuerySchema = z.object({}).strict();
const maxCounter = Number.MAX_SAFE_INTEGER;

export function createHostDeckHostLockPolicy(input: CreateHostDeckHostLockPolicyInput): HostDeckHostLockPolicy {
  const values = readExactDataObject(input, policyInputKeys, "HostDeck host-lock policy input is invalid.");
  const port = readExactDataObject(values.settings, policyPortKeys, "HostDeck host-lock settings port is invalid.");
  if (typeof port.read !== "function" || typeof port.transition !== "function" || typeof values.now !== "function") {
    throw new TypeError("HostDeck host-lock policy ports are invalid.");
  }
  const policy = Object.freeze({
    read: port.read as ReadSettings,
    transition: port.transition as TransitionLock,
    now: values.now as () => Date
  });
  acceptedPolicies.add(policy);
  policyCounters.set(policy, {
    accessReads: 0, auditFailures: 0, gateChecks: 0, gateRejections: 0,
    lockChanges: 0, lockNoops: 0, storageFailures: 0, transitions: 0
  });
  return policy;
}

export function assertHostDeckHostLockPolicy(candidate: unknown): asserts candidate is HostDeckHostLockPolicy {
  if (candidate === null || typeof candidate !== "object" || !acceptedPolicies.has(candidate) || !Object.isFrozen(candidate)) {
    throw new TypeError("HostDeck host-lock policy must be created by createHostDeckHostLockPolicy.");
  }
}

export function hostDeckHostLockPolicySnapshot(policy: HostDeckHostLockPolicy): HostDeckHostLockPolicySnapshot {
  assertHostDeckHostLockPolicy(policy);
  const counters = requireCounters(policy);
  return Object.freeze({
    access_reads: counters.accessReads,
    audit_failures: counters.auditFailures,
    gate_checks: counters.gateChecks,
    gate_rejections: counters.gateRejections,
    lock_changes: counters.lockChanges,
    lock_noops: counters.lockNoops,
    storage_failures: counters.storageFailures,
    transitions: counters.transitions
  });
}

export function requireHostDeckHostUnlocked(policy: HostDeckHostLockPolicy): HostDeckDurableLockState {
  assertHostDeckHostLockPolicy(policy);
  const counters = requireCounters(policy);
  counters.gateChecks = increment(counters.gateChecks);
  const state = readDurableLockState(policy);
  if (state.locked) {
    counters.gateRejections = increment(counters.gateRejections);
    throw new HostDeckHttpError({
      code: "host_locked",
      message: "The HostDeck host is locked.",
      retryable: false,
      status: 423
    });
  }
  return state;
}

export function createHostDeckHostLockRouteRegistration(input: CreateHostDeckHostLockRouteRegistrationInput): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, routeInputKeys, "HostDeck host-lock route input is invalid.");
  assertHostDeckSecurityMutationAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const audit = readExactFrozenDataObject(values.audit, auditPortKeys);
  if (typeof audit.execute !== "function" || typeof audit.reject !== "function" || typeof audit.snapshot !== "function") {
    throw new TypeError("HostDeck security audit executor is invalid.");
  }
  const execute = audit.execute as ExecuteAudit;
  const csrf = values.csrf;
  const policy = values.lock;
  if (registeredPolicies.has(policy)) {
    throw new TypeError("HostDeck host-lock policy already owns a route registration.");
  }
  const accessManifest = requireManifestEntry("access_state");
  const lockManifest = requireManifestEntry("host_lock");
  const unlockManifest = requireManifestEntry("host_unlock");
  let registered = false;
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckHostLockRouteRegistrationId,
    surface: "api" as const,
    register(app) {
      if (registered) {
        throw new TypeError("HostDeck host-lock routes are already registered.");
      }
      registered = true;
      app.get(accessManifest.path, {
        config: hostDeckNoStoreRouteConfig,
        exposeHeadRoute: false,
        async onRequest(_request, reply) {
          setNoStore(reply);
        },
        schema: { querystring: noQuerySchema, response: { 200: selectedAccessStateResponseSchema } }
      }, async (request) => {
        const context = resolveHostDeckRequestAuthentication(request);
        return accessResponse(context, readDurableLockState(policy), selectedAccessStateResponseSchema);
      });

      app.post(lockManifest.path, {
        config: hostDeckNoStoreRouteConfig,
        async onRequest(_request, reply) {
          setNoStore(reply);
        },
        schema: { body: selectedHostLockRequestSchema, querystring: noQuerySchema, response: { 200: selectedHostLockStateResponseSchema } }
      }, async (request) => {
        requireHostLockCredentialTransport(request);
        const context = requireHostDeckRequestAuthentication(request, "local_admin_or_device_cookie");
        requireHostDeckRequestCsrfWriteAuthorization(request, "local_admin_or_device_cookie", csrf);
        const body = request.body as { readonly operation_id: string; readonly confirmed: true };
        return executeTransition(
          execute,
          policy,
          request,
          context,
          body.operation_id,
          true
        );
      });

      app.post(unlockManifest.path, {
        config: hostDeckNoStoreRouteConfig,
        async onRequest(_request, reply) {
          setNoStore(reply);
        },
        schema: { body: selectedHostUnlockRequestSchema, querystring: noQuerySchema, response: { 200: selectedHostLockStateResponseSchema } }
      }, async (request) => {
        const context = requireHostDeckRequestAuthentication(request, "local_admin");
        const body = request.body as { readonly operation_id: string; readonly confirmed: true };
        return executeTransition(
          execute,
          policy,
          request,
          context,
          body.operation_id,
          false
        );
      });
    }
  };
  registeredPolicies.add(policy);
  return Object.freeze(registration);
}

async function executeTransition(
  execute: ExecuteAudit,
  policy: HostDeckHostLockPolicy,
  request: FastifyRequest,
  context: SelectedRequestAuthenticationContext,
  operationId: string,
  locked: boolean
): Promise<SelectedHostLockStateResponse> {
  const counters = requireCounters(policy);
  let raw: unknown;
  try {
    raw = await Reflect.apply(execute, undefined, [{
      operation_id: operationId,
      actor: auditActor(context),
      action: locked ? "lock" : "unlock",
      target: { type: "host", host_id: "local_host" },
      accepted_summary: { schema_version: 1, requested_locked: locked },
      emergency_lock_on_audit_unavailable: locked,
      transition: () => {
        try {
          assertHostDeckRequestAuthenticationCurrent(request, context);
        } catch (error) {
          if (
            error instanceof HostDeckHttpError &&
            error.code === "permission_denied"
          ) {
            return Object.freeze({
              outcome: "failed" as const,
              error_code: "permission_denied" as const,
              payload_summary: Object.freeze({ schema_version: 1 as const })
            });
          }
          throw error;
        }
        return transition(policy, locked);
      },
      prepare_response: (state: unknown) => {
        assertHostDeckRequestAuthenticationCurrent(request, context);
        return accessResponse(
          context,
          parseLockState(state),
          selectedHostLockStateResponseSchema
        );
      }
    }]);
  } catch (error) {
    rethrowStaleIngressFailure(request, context);
    counters.auditFailures = increment(counters.auditFailures);
    if (error instanceof HostDeckSecurityMutationAuditExecutorError) {
      throw publicFailure(error.api_code, error.retry_safe, locked);
    }
    throw contractFailure();
  }
  let result: Readonly<Record<string, unknown>>;
  try {
    result = readExactFrozenVariant(raw, [auditSuccessKeys, auditFailureKeys]);
  } catch {
    counters.auditFailures = increment(counters.auditFailures);
    throw contractFailure();
  }
  if (result.outcome === "succeeded") return parsePreparedResponse(result.response);
  if ((result.outcome === "failed" || result.outcome === "incomplete") && typeof result.error_code === "string" && isErrorCode(result.error_code)) {
    throw publicFailure(result.error_code, false, locked);
  }
  counters.auditFailures = increment(counters.auditFailures);
  throw contractFailure();
}

function rethrowStaleIngressFailure(
  request: FastifyRequest,
  context: SelectedRequestAuthenticationContext
): void {
  try {
    assertHostDeckRequestAuthenticationCurrent(request, context);
  } catch (error) {
    if (
      error instanceof HostDeckHttpError &&
      (error.code === "invalid_origin" || error.code === "permission_denied")
    ) {
      throw error;
    }
  }
}

function transition(policy: HostDeckHostLockPolicy, locked: boolean) {
  const counters = requireCounters(policy);
  let expectedAt: string;
  let raw: unknown;
  try {
    const now = readNow(policy);
    expectedAt = now.toISOString();
    raw = Reflect.apply(policy.transition, undefined, [Object.freeze({ locked, now })]);
  } catch (error) {
    const mapped = mapTransitionFailure(error, counters);
    return Object.freeze({
      outcome: mapped.outcome,
      error_code: mapped.errorCode,
      payload_summary: Object.freeze({ schema_version: 1 })
    });
  }
  let receipt: HostDeckLockTransitionReceipt;
  try {
    receipt = parseTransitionReceipt(raw, locked, expectedAt);
  } catch {
    counters.storageFailures = increment(counters.storageFailures);
    return Object.freeze({
      outcome: "incomplete" as const,
      error_code: "internal_error" as const,
      payload_summary: Object.freeze({ schema_version: 1 })
    });
  }
  counters.transitions = increment(counters.transitions);
  if (receipt.changed) counters.lockChanges = increment(counters.lockChanges);
  else counters.lockNoops = increment(counters.lockNoops);
  return Object.freeze({
    outcome: "succeeded" as const,
    response: receipt.after,
    payload_summary: Object.freeze({ schema_version: 1, locked })
  });
}

function readDurableLockState(policy: HostDeckHostLockPolicy): HostDeckDurableLockState {
  const counters = requireCounters(policy);
  try {
    const raw = Reflect.apply(policy.read, undefined, []);
    const values = readExactDataObject(raw, settingsKeys, "HostDeck durable settings snapshot is invalid.");
    const retention = readExactDataObject(values.retention, retentionKeys, "HostDeck durable retention snapshot is invalid.");
    const parsed = settingsRecordSchema.safeParse({ ...values, retention });
    if (!parsed.success) throw new TypeError();
    counters.accessReads = increment(counters.accessReads);
    return Object.freeze({ locked: parsed.data.locked, settings_updated_at: parsed.data.updated_at });
  } catch {
    counters.storageFailures = increment(counters.storageFailures);
    throw new HostDeckHttpError({
      code: "storage_error",
      message: "Host lock storage is unavailable.",
      retryable: false,
      status: 500
    });
  }
}

function accessResponse<T extends SelectedAccessStateResponse | SelectedHostLockStateResponse>(
  context: SelectedRequestAuthenticationContext,
  state: HostDeckDurableLockState,
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }
): T {
  const local = context.state === "local_admin";
  const paired = context.state === "paired_device";
  const writer = paired && context.permission === "write";
  const parsed = schema.safeParse({
    authentication_state: context.state,
    device_id: context.device_id,
    permission: context.permission,
    device_expires_at: context.expires_at,
    configured_origin: context.configured_origin,
    network_mode: context.network_mode,
    transport: context.transport,
    locked: state.locked,
    can_read_sessions: local || paired || (context.state === "unpaired" && context.network_mode === "loopback"),
    can_write_sessions: (local || writer) && !state.locked,
    can_lock: local || writer,
    can_unlock: local
  });
  if (!parsed.success || parsed.data === undefined) throw contractFailure();
  return Object.freeze({ ...parsed.data }) as T;
}

function parsePreparedResponse(candidate: unknown): SelectedHostLockStateResponse {
  const values = readExactFrozenDataObject(candidate, responseKeys);
  const parsed = selectedHostLockStateResponseSchema.safeParse(values);
  if (!parsed.success) throw contractFailure();
  return Object.freeze({ ...parsed.data });
}

function auditActor(context: SelectedRequestAuthenticationContext) {
  if (context.state === "local_admin") {
    return { type: "cli" as const, device_id: null, permission: "local_admin" as const, origin: null };
  }
  if (context.state === "paired_device" && context.device_id !== null && context.permission === "write") {
    return {
      type: "dashboard" as const,
      device_id: context.device_id,
      permission: "write" as const,
      origin: context.configured_origin
    };
  }
  throw contractFailure();
}

function parseTransitionReceipt(candidate: unknown, requestedLocked: boolean, expectedAt: string): HostDeckLockTransitionReceipt {
  const receipt = readExactFrozenDataObject(candidate, transitionReceiptKeys);
  const before = parseLockState(receipt.before);
  const after = parseLockState(receipt.after);
  if (typeof receipt.changed !== "boolean" || after.locked !== requestedLocked) throw new TypeError();
  if (receipt.changed) {
    if (before.locked === after.locked || after.settings_updated_at !== expectedAt) throw new TypeError();
  } else if (before.locked !== after.locked || before.settings_updated_at !== after.settings_updated_at) {
    throw new TypeError();
  }
  return Object.freeze({ before, after, changed: receipt.changed });
}

function parseLockState(candidate: unknown): HostDeckDurableLockState {
  const state = readExactFrozenDataObject(candidate, lockStateKeys);
  if (typeof state.locked !== "boolean" || !canonicalIso(state.settings_updated_at)) throw new TypeError();
  return Object.freeze({ locked: state.locked, settings_updated_at: state.settings_updated_at as string });
}

function mapTransitionFailure(error: unknown, counters: MutableCounters): { outcome: "failed" | "incomplete"; errorCode: ErrorCode } {
  if (error instanceof HostDeckSettingsError) {
    if (error.code === "settings_lock_conflict" || error.code === "settings_lock_time_conflict") {
      return { outcome: "failed", errorCode: "operation_conflict" };
    }
    counters.storageFailures = increment(counters.storageFailures);
    return {
      outcome: "incomplete",
      errorCode: error.code === "invalid_lock_transition" ? "internal_error" : "storage_error"
    };
  }
  counters.storageFailures = increment(counters.storageFailures);
  return { outcome: "incomplete", errorCode: "internal_error" };
}

function publicFailure(code: ErrorCode, retryable: boolean, locking: boolean): HostDeckHttpError {
  const status = code === "operation_conflict"
    ? 409
    : code === "audit_unavailable" || code === "runtime_unavailable"
      ? 503
      : code === "validation_error" ? 400 : 500;
  const message = code === "operation_conflict"
    ? "Host lock state conflicts with newer durable settings."
    : code === "audit_unavailable"
      ? locking
        ? "Host lock audit is unavailable. Refresh access state before another action."
        : "Host unlock audit is unavailable."
      : code === "storage_error"
        ? "Host lock storage is unavailable."
        : "Host lock transition failed.";
  return new HostDeckHttpError({ code, message, retryable, status });
}

function requireHostLockCredentialTransport(request: FastifyRequest): void {
  if (hostDeckRequestAuthenticationIngressContext(request).transport === "https") return;
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() !== "cookie") continue;
    throw new HostDeckHttpError({
      code: "insecure_transport",
      message: "Secure request transport is required for paired host lock.",
      retryable: false,
      status: 426
    });
  }
}

function requireManifestEntry(id: "access_state" | "host_lock" | "host_unlock"): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (matches.length !== 1 || entry === undefined || !Object.isFrozen(entry) || !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) || entry.owner_task !== "IFC-V1-030" || entry.transport !== "json" ||
    entry.response.error !== "selected_api_error_v1" || entry.operation_kind !== null || entry.credential_effect !== "none") {
    throw new TypeError("Selected host-lock manifest entry is invalid.");
  }
  if (id === "access_state") {
    if (entry.family !== "access" || entry.method !== "GET" || entry.path !== "/api/v1/access" ||
      entry.request.params !== null || entry.request.query !== null || entry.request.body !== null ||
      entry.response.success !== "access_state_response_v1" || entry.auth !== "optional_device_cookie" ||
      entry.authority !== "access_read" || entry.csrf !== "none" || entry.lock !== "not_applicable" ||
      entry.target !== "none" || entry.audit !== null || entry.handler !== "access.readState") {
      throw new TypeError("Selected access-state manifest entry is invalid.");
    }
  } else {
    const audit = entry.audit;
    const locking = id === "host_lock";
    if (audit === null || !Object.isFrozen(audit) || audit.catalog_state !== "selected" ||
      audit.catalog_owner_task !== null || entry.family !== "access" || entry.method !== "POST" ||
      entry.path !== (locking ? "/api/v1/access/lock" : "/api/v1/access/unlock") ||
      entry.request.params !== null || entry.request.query !== null ||
      entry.request.body !== (locking ? "lock_request_v1" : "unlock_request_v1") ||
      entry.response.success !== "host_lock_state_response_v1" ||
      entry.auth !== (locking ? "local_admin_or_device_cookie" : "local_admin") ||
      entry.authority !== (locking ? "host_lock" : "local_admin") ||
      entry.csrf !== (locking ? "required_for_device" : "none") || entry.lock !== "lock_transition" ||
      entry.target !== "host" || audit.executor !== "security_executor" ||
      audit.action !== (locking ? "lock" : "unlock") ||
      entry.handler !== (locking ? "access.lockHost" : "access.unlockHost")) {
      throw new TypeError("Selected host-lock mutation manifest entry is invalid.");
    }
  }
  return entry;
}

function readNow(policy: HostDeckHostLockPolicy): Date {
  const raw = Reflect.apply(policy.now, undefined, []);
  if (!(raw instanceof Date)) throw new TypeError();
  const time = Date.prototype.getTime.call(raw);
  if (!Number.isFinite(time)) throw new TypeError();
  return new Date(time);
}

function canonicalIso(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  const time = Date.parse(candidate);
  return Number.isFinite(time) && new Date(time).toISOString() === candidate;
}

function setNoStore(reply: { header: (name: string, value: string) => unknown }): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function requireCounters(policy: HostDeckHostLockPolicy): MutableCounters {
  const counters = policyCounters.get(policy);
  if (counters === undefined) throw new TypeError("HostDeck host-lock policy is unavailable.");
  return counters;
}
function increment(value: number): number {
  return value >= maxCounter ? maxCounter : value + 1;
}
function contractFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "internal_error",
    message: "Host lock boundary failed.",
    retryable: false,
    status: 500
  });
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError();
    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as Key))) {
      throw new TypeError();
    }
    const values = Object.create(null) as Record<Key, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
        descriptor.set !== undefined || descriptor.enumerable !== true) throw new TypeError();
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    throw new TypeError(message);
  }
}

function readExactFrozenDataObject<const Key extends string>(candidate: unknown, expectedKeys: readonly Key[]): Readonly<Record<Key, unknown>> {
  const values = readExactDataObject(candidate, expectedKeys, "Frozen boundary result is invalid.");
  if (!Object.isFrozen(candidate)) throw new TypeError("Frozen boundary result is invalid.");
  return values;
}

function readExactFrozenVariant(candidate: unknown, variants: readonly (readonly string[])[]): Readonly<Record<string, unknown>> {
  for (const keys of variants) {
    try {
      return readExactFrozenDataObject(candidate, keys);
    } catch {
      // Try the next exact result variant.
    }
  }
  throw new TypeError("Frozen boundary result variant is invalid.");
}
