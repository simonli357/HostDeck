import {
  authDeviceRecordSchema,
  type SelectedRequestAuthenticationContext,
  type SelectedRequestAuthenticationState,
  selectedRawDeviceSecretSchema,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import { HostDeckAuthRepositoryError } from "@hostdeck/storage";
import { parseCookie } from "cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createHostDeckActiveDeviceAuthorityPolicy,
  type HostDeckActiveDeviceAuthorityLease,
  type HostDeckActiveDeviceAuthorityPolicy,
  HostDeckDeviceAuthorityError
} from "./device-authority-lifecycle.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  type HostDeckRequestTrustContext,
  hostDeckRequestTrustContext
} from "./fastify-request-trust.js";
import type { SelectedApiAuthMechanism } from "./selected-api-route-manifest.js";

export const hostDeckDeviceCookieName = "hostdeck_device";

export type HostDeckRequestAuthenticationMechanism = Exclude<
  SelectedApiAuthMechanism,
  "none" | "pairing_code"
>;

export interface HostDeckDeviceAuthenticationInput {
  readonly rawDeviceToken: string;
  readonly now: Date;
}

export type HostDeckDeviceAuthenticationPort = (
  input: HostDeckDeviceAuthenticationInput
) => unknown;

export interface CreateHostDeckRequestAuthenticationPolicyInput {
  readonly authenticateDeviceToken: HostDeckDeviceAuthenticationPort;
  readonly now: () => Date;
}

export interface HostDeckRequestAuthenticationPolicy {
  readonly activeDeviceAuthority: HostDeckActiveDeviceAuthorityPolicy;
  readonly authenticateDeviceToken: HostDeckDeviceAuthenticationPort;
  readonly now: () => Date;
}

export interface HostDeckRequestAuthenticationSnapshot {
  readonly authentication_conflicts: number;
  readonly authentication_storage_failures: number;
  readonly expired_device_contexts: number;
  readonly invalid_device_contexts: number;
  readonly local_admin_contexts: number;
  readonly read_device_contexts: number;
  readonly revoked_device_contexts: number;
  readonly unpaired_contexts: number;
  readonly write_device_contexts: number;
}

interface AuthenticationRuntime {
  authenticationConflicts: number;
  authenticationStorageFailures: number;
  expiredDeviceContexts: number;
  invalidDeviceContexts: number;
  localAdminContexts: number;
  readDeviceContexts: number;
  revokedDeviceContexts: number;
  unpairedContexts: number;
  writeDeviceContexts: number;
}

type DeviceCookieObservation =
  | { readonly kind: "absent"; readonly cookieHeaderPresent: boolean }
  | { readonly kind: "invalid" }
  | { readonly kind: "token"; rawDeviceToken: string | null };

type AuthenticationResolution =
  | { readonly kind: "context"; readonly context: SelectedRequestAuthenticationContext }
  | { readonly kind: "error"; readonly error: HostDeckHttpError };

interface PendingAuthenticationState {
  readonly activeDeviceAuthority: HostDeckActiveDeviceAuthorityPolicy;
  readonly authorityController: AbortController;
  readonly observation: DeviceCookieObservation;
  readonly policy: HostDeckRequestAuthenticationPolicy;
  readonly runtime: AuthenticationRuntime;
  readonly trust: HostDeckRequestTrustContext;
  activeLease: HostDeckActiveDeviceAuthorityLease | null;
  activeLeaseAbortForwarder: (() => void) | null;
  allowInvalidatedSuccess: boolean;
  resolution: AuthenticationResolution | null;
}

interface ParsedDeviceAuthentication {
  readonly readOnly: boolean;
  readonly device: ReturnType<typeof authDeviceRecordSchema.parse>;
}

const policyKeys = ["authenticateDeviceToken", "now"] as const;
const acceptedPolicies = new WeakSet<object>();
const authenticationRuntimes = new WeakMap<FastifyInstance, AuthenticationRuntime>();
const pendingAuthenticationStates = new WeakMap<FastifyRequest, PendingAuthenticationState>();

export function createHostDeckRequestAuthenticationPolicy(
  input: CreateHostDeckRequestAuthenticationPolicyInput
): HostDeckRequestAuthenticationPolicy {
  const values = readExactPolicyInput(input);
  if (typeof values.authenticateDeviceToken !== "function") {
    throw new TypeError("HostDeck request authentication port must be a function.");
  }
  if (typeof values.now !== "function") {
    throw new TypeError("HostDeck request authentication clock must be a function.");
  }
  const policy = Object.freeze({
    activeDeviceAuthority: createHostDeckActiveDeviceAuthorityPolicy(),
    authenticateDeviceToken: values.authenticateDeviceToken as HostDeckDeviceAuthenticationPort,
    now: values.now as () => Date
  });
  acceptedPolicies.add(policy);
  return policy;
}

export function assertHostDeckRequestAuthenticationPolicy(
  policy: unknown
): asserts policy is HostDeckRequestAuthenticationPolicy {
  if (
    policy === null ||
    typeof policy !== "object" ||
    !acceptedPolicies.has(policy) ||
    !Object.isFrozen(policy)
  ) {
    throw new TypeError(
      "HostDeck request authentication policy must be created by createHostDeckRequestAuthenticationPolicy."
    );
  }
}

export function installHostDeckRequestAuthentication(
  app: FastifyInstance,
  policy: HostDeckRequestAuthenticationPolicy
): void {
  assertHostDeckRequestAuthenticationPolicy(policy);
  if (authenticationRuntimes.has(app)) {
    throw new TypeError("HostDeck request authentication is already installed.");
  }
  const runtime: AuthenticationRuntime = {
    authenticationConflicts: 0,
    authenticationStorageFailures: 0,
    expiredDeviceContexts: 0,
    invalidDeviceContexts: 0,
    localAdminContexts: 0,
    readDeviceContexts: 0,
    revokedDeviceContexts: 0,
    unpairedContexts: 0,
    writeDeviceContexts: 0
  };
  authenticationRuntimes.set(app, runtime);

  app.addHook("onRequest", async (request) => {
    const trust = hostDeckRequestTrustContext(request);
    const observation = parseDeviceCookie(request.raw.rawHeaders);
    pendingAuthenticationStates.set(request, {
      activeDeviceAuthority: policy.activeDeviceAuthority,
      activeLease: null,
      activeLeaseAbortForwarder: null,
      allowInvalidatedSuccess: false,
      authorityController: new AbortController(),
      observation,
      policy,
      resolution: null,
      runtime,
      trust
    });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const pending = pendingAuthenticationStates.get(request);
    if (
      reply.statusCode < 400 &&
      pending?.resolution?.kind === "context" &&
      pending.resolution.context.state === "paired_device" &&
      !pending.allowInvalidatedSuccess
    ) {
      requireCurrentAuthority(pending);
    }
    return payload;
  });
  app.addHook("onResponse", async (request) => {
    clearPendingAuthentication(request);
  });
  app.addHook("onRequestAbort", async (request) => {
    clearPendingAuthentication(request);
  });
}

export function resolveHostDeckRequestAuthentication(
  request: FastifyRequest
): SelectedRequestAuthenticationContext {
  const pending = pendingAuthenticationStates.get(request);
  if (pending === undefined) {
    throw new Error(
      "HostDeck request authentication is unavailable before trust and cookie admission."
    );
  }
  if (pending.resolution !== null) {
    if (pending.resolution.kind === "error") throw pending.resolution.error;
    if (pending.resolution.context.state === "paired_device") {
      requireCurrentAuthority(pending);
    }
    return pending.resolution.context;
  }

  try {
    const context = resolvePendingAuthentication(pending);
    pending.resolution = { context, kind: "context" };
    recordContext(pending.runtime, context);
    return context;
  } catch (error) {
    const sanitized = sanitizeAuthenticationFailure(error, pending.runtime);
    pending.resolution = { error: sanitized, kind: "error" };
    throw sanitized;
  } finally {
    if (pending.observation.kind === "token") pending.observation.rawDeviceToken = null;
  }
}

export function requireHostDeckRequestAuthentication(
  request: FastifyRequest,
  mechanism: HostDeckRequestAuthenticationMechanism
): SelectedRequestAuthenticationContext {
  const context = resolveHostDeckRequestAuthentication(request);
  return requireHostDeckAuthenticationContext(context, mechanism);
}

export function requireHostDeckAuthenticationContext(
  context: SelectedRequestAuthenticationContext,
  mechanism: HostDeckRequestAuthenticationMechanism
): SelectedRequestAuthenticationContext {
  switch (mechanism) {
    case "optional_device_cookie":
      return context;
    case "loopback_or_device_cookie":
      if (
        context.state === "paired_device" ||
        context.state === "local_admin" ||
        (context.state === "unpaired" && context.network_mode === "loopback")
      ) {
        return context;
      }
      throw credentialRejection(context.state);
    case "device_cookie":
      if (context.state === "paired_device") return context;
      throw credentialRejection(context.state);
    case "local_admin":
      if (context.state === "local_admin") return context;
      throw new HostDeckHttpError({
        code: "permission_denied",
        message: "Explicit local-admin authority is required.",
        retryable: false,
        status: 403
      });
    case "local_admin_or_device_cookie":
      if (context.state === "local_admin" || context.state === "paired_device") {
        return context;
      }
      throw credentialRejection(context.state);
    default:
      throw new TypeError("HostDeck request authentication mechanism is unsupported.");
  }
}

export function requireHostDeckRequestWritePermission(
  context: SelectedRequestAuthenticationContext
): SelectedRequestAuthenticationContext {
  if (context.state === "local_admin" || context.permission === "write") return context;
  if (context.state === "paired_device" && context.permission === "read") {
    throw new HostDeckHttpError({
      code: "read_only",
      message: "The paired device has read-only permission.",
      retryable: false,
      status: 403
    });
  }
  throw credentialRejection(context.state);
}

export function requireHostDeckRequestActiveDeviceAuthority(
  request: FastifyRequest
): HostDeckActiveDeviceAuthorityLease {
  const pending = requirePendingAuthentication(request);
  if (
    pending.resolution?.kind !== "context" ||
    pending.resolution.context.state !== "paired_device"
  ) {
    throw credentialRejection(
      pending.resolution?.kind === "context"
        ? pending.resolution.context.state
        : "unpaired"
    );
  }
  return requireCurrentAuthority(pending);
}

export function hostDeckRequestActiveDeviceAuthority(
  request: FastifyRequest
): HostDeckActiveDeviceAuthorityLease | null {
  const pending = pendingAuthenticationStates.get(request);
  if (
    pending?.resolution?.kind !== "context" ||
    pending.resolution.context.state !== "paired_device"
  ) {
    return null;
  }
  return requireCurrentAuthority(pending);
}

export function hostDeckRequestDeviceAuthoritySignal(
  request: FastifyRequest
): AbortSignal {
  return requirePendingAuthentication(request).authorityController.signal;
}

export function assertHostDeckRequestAuthenticationCurrent(
  request: FastifyRequest,
  expected: SelectedRequestAuthenticationContext
): void {
  const pending = requirePendingAuthentication(request);
  if (
    pending.resolution?.kind !== "context" ||
    pending.resolution.context !== expected
  ) {
    throw storageFailure("Request authentication context ownership is invalid.");
  }
  if (expected.state === "paired_device") requireCurrentAuthority(pending);
}

export function allowHostDeckSelfRevocationResponse(
  request: FastifyRequest,
  deviceId: string
): void {
  const pending = requirePendingAuthentication(request);
  const context =
    pending.resolution?.kind === "context" ? pending.resolution.context : null;
  const lease = pending.activeLease;
  if (
    context?.state !== "paired_device" ||
    context.device_id !== deviceId ||
    lease === null ||
    lease.deviceId !== deviceId ||
    !lease.signal.aborted ||
    !(lease.signal.reason instanceof HostDeckDeviceAuthorityError) ||
    lease.signal.reason.code !== "device_revoked"
  ) {
    throw new TypeError("HostDeck self-revocation response authority is invalid.");
  }
  pending.allowInvalidatedSuccess = true;
}

export function hostDeckRequestAuthenticationSnapshot(
  app: FastifyInstance
): HostDeckRequestAuthenticationSnapshot {
  const runtime = authenticationRuntimes.get(app);
  if (runtime === undefined) {
    throw new TypeError("Fastify instance has no HostDeck request authentication policy.");
  }
  return Object.freeze({
    authentication_conflicts: runtime.authenticationConflicts,
    authentication_storage_failures: runtime.authenticationStorageFailures,
    expired_device_contexts: runtime.expiredDeviceContexts,
    invalid_device_contexts: runtime.invalidDeviceContexts,
    local_admin_contexts: runtime.localAdminContexts,
    read_device_contexts: runtime.readDeviceContexts,
    revoked_device_contexts: runtime.revokedDeviceContexts,
    unpaired_contexts: runtime.unpairedContexts,
    write_device_contexts: runtime.writeDeviceContexts
  });
}

function resolvePendingAuthentication(
  pending: PendingAuthenticationState
): SelectedRequestAuthenticationContext {
  if (pending.observation.kind === "invalid") {
    return createContext(pending.trust, "invalid_device");
  }
  if (pending.observation.kind === "absent") {
    return createContext(
      pending.trust,
      !pending.observation.cookieHeaderPresent &&
        pending.trust.origin_kind === "local_non_browser"
        ? "local_admin"
        : "unpaired"
    );
  }

  const rawDeviceToken = pending.observation.rawDeviceToken;
  if (rawDeviceToken === null) {
    throw storageFailure("Device authentication resolved after pending authority was cleared.");
  }
  let rawResult: unknown;
  try {
    rawResult = pending.policy.authenticateDeviceToken({
      now: pending.policy.now(),
      rawDeviceToken
    });
  } catch (error) {
    if (error instanceof HostDeckAuthRepositoryError) {
      switch (error.code) {
        case "invalid_secret":
        case "device_not_found":
          return createContext(pending.trust, "invalid_device");
        case "device_expired":
          return createContext(pending.trust, "expired_device");
        case "device_revoked":
          return createContext(pending.trust, "revoked_device");
        case "authentication_conflict":
          throw conflictFailure();
      }
    }
    throw storageFailure("Device authentication storage failed.");
  }

  const authenticated = parseDeviceAuthentication(rawResult);
  const context = createContext(pending.trust, "paired_device", authenticated);
  try {
    attachActiveLease(
      pending,
      pending.activeDeviceAuthority.acquire(authenticated.device.id)
    );
  } catch (error) {
    if (
      error instanceof HostDeckDeviceAuthorityError &&
      error.code === "device_revoked"
    ) {
      return createContext(pending.trust, "revoked_device");
    }
    throw storageFailure("Device authority lease acquisition failed.");
  }
  return context;
}

function parseDeviceAuthentication(candidate: unknown): ParsedDeviceAuthentication {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const keys = Object.keys(candidate).sort();
    if (keys.length !== 3 || keys[0] !== "device" || keys[1] !== "readOnly" || keys[2] !== "trusted") {
      throw new TypeError();
    }
    const value = candidate as Record<string, unknown>;
    if (value.trusted !== true || typeof value.readOnly !== "boolean") throw new TypeError();
    const device = authDeviceRecordSchema.parse(value.device);
    if (value.readOnly !== (device.permission === "read")) throw new TypeError();
    return { device, readOnly: value.readOnly };
  } catch {
    throw storageFailure("Device authentication returned invalid state.");
  }
}

function createContext(
  trust: HostDeckRequestTrustContext,
  state: Exclude<SelectedRequestAuthenticationState, "paired_device">,
  authenticated?: undefined
): SelectedRequestAuthenticationContext;
function createContext(
  trust: HostDeckRequestTrustContext,
  state: "paired_device",
  authenticated: ParsedDeviceAuthentication
): SelectedRequestAuthenticationContext;
function createContext(
  trust: HostDeckRequestTrustContext,
  state: SelectedRequestAuthenticationState,
  authenticated?: ParsedDeviceAuthentication
): SelectedRequestAuthenticationContext {
  const parsed = selectedRequestAuthenticationContextSchema.safeParse({
    state,
    configured_origin: trust.configured_origin,
    network_mode: trust.network_mode,
    origin_kind: trust.origin_kind,
    transport: trust.transport,
    device_id: authenticated?.device.id ?? null,
    permission:
      state === "local_admin"
        ? "local_admin"
        : authenticated?.device.permission ?? null,
    csrf_generation: authenticated?.device.csrf_generation ?? null,
    last_used_at: authenticated?.device.last_used_at ?? null,
    expires_at: authenticated?.device.expires_at ?? null
  });
  if (!parsed.success) throw storageFailure("Device authentication context is invalid.");
  return Object.freeze({ ...parsed.data });
}

function parseDeviceCookie(rawHeaders: readonly string[]): DeviceCookieObservation {
  try {
    if (rawHeaders.length % 2 !== 0) return { kind: "invalid" };
    const cookieHeaders: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === "cookie") {
        cookieHeaders.push(rawHeaders[index + 1] ?? "");
      }
    }
    if (cookieHeaders.length === 0) {
      return { cookieHeaderPresent: false, kind: "absent" };
    }
    if (cookieHeaders.length !== 1) return { kind: "invalid" };

    const header = cookieHeaders[0] ?? "";
    const parsed = parseCookie(header, { decode: identityDecode });
    let targetCount = 0;
    for (const segment of header.split(";")) {
      const segmentValues = parseCookie(segment, { decode: identityDecode });
      if (Object.hasOwn(segmentValues, hostDeckDeviceCookieName)) targetCount += 1;
    }
    if (targetCount === 0) {
      return { cookieHeaderPresent: true, kind: "absent" };
    }
    if (targetCount !== 1) return { kind: "invalid" };
    const rawDeviceToken = parsed[hostDeckDeviceCookieName];
    if (
      typeof rawDeviceToken !== "string" ||
      !selectedRawDeviceSecretSchema.safeParse(rawDeviceToken).success
    ) {
      return { kind: "invalid" };
    }
    return { kind: "token", rawDeviceToken };
  } catch {
    return { kind: "invalid" };
  }
}

function identityDecode(value: string): string {
  return value;
}

function clearPendingAuthentication(request: FastifyRequest): void {
  const pending = pendingAuthenticationStates.get(request);
  if (pending?.observation.kind === "token") {
    pending.observation.rawDeviceToken = null;
  }
  if (pending?.activeLease !== null && pending?.activeLease !== undefined) {
    if (pending.activeLeaseAbortForwarder !== null) {
      pending.activeLease.signal.removeEventListener(
        "abort",
        pending.activeLeaseAbortForwarder
      );
      pending.activeLeaseAbortForwarder = null;
    }
    pending.activeDeviceAuthority.release(pending.activeLease);
    pending.activeLease = null;
  }
  pendingAuthenticationStates.delete(request);
}

function attachActiveLease(
  pending: PendingAuthenticationState,
  lease: HostDeckActiveDeviceAuthorityLease
): void {
  if (pending.activeLease !== null || pending.activeLeaseAbortForwarder !== null) {
    throw storageFailure("Request already owns a device-authority lease.");
  }
  const forwardInvalidation = () => {
    if (!pending.authorityController.signal.aborted) {
      pending.authorityController.abort(lease.signal.reason);
    }
  };
  pending.activeLease = lease;
  pending.activeLeaseAbortForwarder = forwardInvalidation;
  lease.signal.addEventListener("abort", forwardInvalidation, { once: true });
  if (lease.signal.aborted) forwardInvalidation();
}

function requirePendingAuthentication(
  request: FastifyRequest
): PendingAuthenticationState {
  const pending = pendingAuthenticationStates.get(request);
  if (pending === undefined) {
    throw new Error(
      "HostDeck request authentication is unavailable before trust and cookie admission."
    );
  }
  return pending;
}

function requireCurrentAuthority(
  pending: PendingAuthenticationState
): HostDeckActiveDeviceAuthorityLease {
  const lease = pending.activeLease;
  if (lease === null) {
    throw storageFailure("Paired request has no active device-authority lease.");
  }
  try {
    pending.activeDeviceAuthority.assertActive(lease);
    return lease;
  } catch (error) {
    if (
      error instanceof HostDeckDeviceAuthorityError &&
      error.code === "device_revoked"
    ) {
      throw credentialRejection("revoked_device");
    }
    throw storageFailure("Paired request device-authority lease is invalid.");
  }
}

function recordContext(
  runtime: AuthenticationRuntime,
  context: SelectedRequestAuthenticationContext
): void {
  switch (context.state) {
    case "local_admin":
      runtime.localAdminContexts = incrementCounter(runtime.localAdminContexts);
      return;
    case "unpaired":
      runtime.unpairedContexts = incrementCounter(runtime.unpairedContexts);
      return;
    case "invalid_device":
      runtime.invalidDeviceContexts = incrementCounter(runtime.invalidDeviceContexts);
      return;
    case "expired_device":
      runtime.expiredDeviceContexts = incrementCounter(runtime.expiredDeviceContexts);
      return;
    case "revoked_device":
      runtime.revokedDeviceContexts = incrementCounter(runtime.revokedDeviceContexts);
      return;
    case "paired_device":
      if (context.permission === "read") {
        runtime.readDeviceContexts = incrementCounter(runtime.readDeviceContexts);
      } else {
        runtime.writeDeviceContexts = incrementCounter(runtime.writeDeviceContexts);
      }
  }
}

function sanitizeAuthenticationFailure(
  error: unknown,
  runtime: AuthenticationRuntime
): HostDeckHttpError {
  if (error instanceof HostDeckHttpError && error.code === "operation_conflict") {
    runtime.authenticationConflicts = incrementCounter(runtime.authenticationConflicts);
    return error;
  }
  runtime.authenticationStorageFailures = incrementCounter(
    runtime.authenticationStorageFailures
  );
  if (error instanceof HostDeckHttpError && error.code === "storage_error") return error;
  return storageFailure("Device authentication storage failed.");
}

function credentialRejection(
  state: SelectedRequestAuthenticationState
): HostDeckHttpError {
  const message =
    state === "expired_device"
      ? "The paired device credential has expired."
      : state === "revoked_device"
        ? "The paired device credential has been revoked."
        : state === "invalid_device"
          ? "The paired device credential is invalid."
          : "Paired device authentication is required.";
  return new HostDeckHttpError({
    code: "permission_denied",
    message,
    retryable: false,
    status: 401
  });
}

function conflictFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "operation_conflict",
    message: "Device authentication observation conflicts with newer state.",
    retryable: false,
    status: 409
  });
}

function storageFailure(message: string): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "storage_error",
    message,
    retryable: false,
    status: 500
  });
}

function readExactPolicyInput(
  input: unknown
): Readonly<Record<(typeof policyKeys)[number], unknown>> {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== policyKeys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(policyKeys as readonly string[]).includes(key)
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of policyKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return values as Readonly<Record<(typeof policyKeys)[number], unknown>>;
  } catch {
    throw new TypeError("HostDeck request authentication policy input is invalid.");
  }
}

function incrementCounter(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}
