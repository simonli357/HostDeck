import {
  authDeviceRecordSchema,
  type SelectedCsrfBootstrapResponse,
  type SelectedRequestAuthenticationContext,
  selectedCsrfBootstrapRequestSchema,
  selectedCsrfBootstrapResponseSchema,
  selectedCsrfGenerationHeaderName,
  selectedCsrfGenerationHeaderValueSchema,
  selectedCsrfTokenHeaderName,
  selectedRawCsrfTokenSchema
} from "@hostdeck/contracts";
import { type ErrorCode, isErrorCode } from "@hostdeck/core";
import {
  type AuthorizeSelectedBrowserWriteInput,
  HostDeckAuthRepositoryError,
  type RotateSelectedCsrfBootstrapInput
} from "@hostdeck/storage";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationCurrent,
  type HostDeckRequestAuthenticationMechanism,
  requireHostDeckRequestAuthentication,
  requireHostDeckRequestWritePermission
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

export const hostDeckCsrfRouteRegistrationId = "selected-csrf-bootstrap";

export interface HostDeckCsrfAuthorizationPort {
  readonly rotateBootstrap: (input: RotateSelectedCsrfBootstrapInput) => unknown;
  readonly authorizeBrowserWrite: (
    input: AuthorizeSelectedBrowserWriteInput
  ) => unknown;
}

export interface CreateHostDeckCsrfPolicyInput {
  readonly csrf: HostDeckCsrfAuthorizationPort;
  readonly now: () => Date;
}

export interface HostDeckCsrfPolicy {
  readonly rotateBootstrap: HostDeckCsrfAuthorizationPort["rotateBootstrap"];
  readonly authorizeBrowserWrite: HostDeckCsrfAuthorizationPort["authorizeBrowserWrite"];
  readonly now: () => Date;
}

export interface HostDeckCsrfAuthorizationReceipt {
  readonly authority: "local_admin" | "paired_device";
  readonly device_id: string | null;
  readonly permission: "local_admin" | "write";
  readonly csrf_generation: number | null;
  readonly verified_at: string | null;
}

export interface HostDeckCsrfPolicySnapshot {
  readonly audit_failures: number;
  readonly authority_rejections: number;
  readonly bootstrap_failures: number;
  readonly bootstrap_rotations: number;
  readonly header_rejections: number;
  readonly operation_conflicts: number;
  readonly storage_failures: number;
  readonly write_authorizations: number;
}

export interface CreateHostDeckCsrfRouteRegistrationInput {
  readonly audit: SecurityMutationAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
}

interface MutableCsrfCounters {
  auditFailures: number;
  authorityRejections: number;
  bootstrapFailures: number;
  bootstrapRotations: number;
  headerRejections: number;
  operationConflicts: number;
  storageFailures: number;
  writeAuthorizations: number;
}

interface ParsedCsrfHeaders {
  rawCsrfToken: string | null;
  readonly csrfGeneration: number;
}

interface ParsedRotation {
  readonly deviceId: string;
  readonly rawCsrfToken: string;
  readonly csrfGeneration: number;
  readonly rotatedAt: string;
}

type ExecuteAudit = SecurityMutationAuditExecutor["execute"];
type AuthorizeWrite = HostDeckCsrfAuthorizationPort["authorizeBrowserWrite"];
type RotateBootstrap = HostDeckCsrfAuthorizationPort["rotateBootstrap"];
type PairedRequestAuthenticationContext = SelectedRequestAuthenticationContext & {
  readonly state: "paired_device";
  readonly device_id: string;
  readonly permission: "read" | "write";
  readonly csrf_generation: number;
  readonly last_used_at: string;
};

const acceptedPolicies = new WeakSet<object>();
const policyCounters = new WeakMap<HostDeckCsrfPolicy, MutableCsrfCounters>();
const policyInputKeys = ["csrf", "now"] as const;
const policyPortKeys = ["authorizeBrowserWrite", "rotateBootstrap"] as const;
const routeInputKeys = ["audit", "csrf"] as const;
const auditPortKeys = ["execute", "reject", "snapshot"] as const;
const rotationKeys = [
  "deviceId",
  "rawCsrfToken",
  "csrfGeneration",
  "rotatedAt"
] as const;
const authenticationKeys = ["trusted", "readOnly", "device"] as const;
const authDeviceKeys = [
  "id",
  "token_hash",
  "csrf_token_hash",
  "csrf_generation",
  "csrf_rotated_at",
  "client_label",
  "permission",
  "created_at",
  "last_used_at",
  "expires_at",
  "revoked_at"
] as const;
const auditResultKeys = ["outcome", "response"] as const;
const auditFailureResultKeys = ["outcome", "error_code"] as const;
const noCsrfBootstrapQuerySchema = z.object({}).strict();
const maxRawHeaderEntries = 512;
const maxCounter = Number.MAX_SAFE_INTEGER;

class HostDeckCsrfContractError extends Error {
  constructor() {
    super("Selected CSRF boundary contract failed.");
    this.name = "HostDeckCsrfContractError";
  }
}

export function createHostDeckCsrfPolicy(
  input: CreateHostDeckCsrfPolicyInput
): HostDeckCsrfPolicy {
  const values = readExactDataObject(
    input,
    policyInputKeys,
    "HostDeck CSRF policy input is invalid."
  );
  const port = readExactDataObject(
    values.csrf,
    policyPortKeys,
    "HostDeck CSRF authorization port is invalid."
  );
  if (
    typeof port.rotateBootstrap !== "function" ||
    typeof port.authorizeBrowserWrite !== "function" ||
    typeof values.now !== "function"
  ) {
    throw new TypeError("HostDeck CSRF policy ports are invalid.");
  }
  const policy = Object.freeze({
    rotateBootstrap: port.rotateBootstrap as RotateBootstrap,
    authorizeBrowserWrite: port.authorizeBrowserWrite as AuthorizeWrite,
    now: values.now as () => Date
  });
  acceptedPolicies.add(policy);
  policyCounters.set(policy, {
    auditFailures: 0,
    authorityRejections: 0,
    bootstrapFailures: 0,
    bootstrapRotations: 0,
    headerRejections: 0,
    operationConflicts: 0,
    storageFailures: 0,
    writeAuthorizations: 0
  });
  return policy;
}

export function assertHostDeckCsrfPolicy(
  candidate: unknown
): asserts candidate is HostDeckCsrfPolicy {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedPolicies.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck CSRF policy must be created by createHostDeckCsrfPolicy."
    );
  }
}

export function hostDeckCsrfPolicySnapshot(
  policy: HostDeckCsrfPolicy
): HostDeckCsrfPolicySnapshot {
  assertHostDeckCsrfPolicy(policy);
  const counters = requireCounters(policy);
  return Object.freeze({
    audit_failures: counters.auditFailures,
    authority_rejections: counters.authorityRejections,
    bootstrap_failures: counters.bootstrapFailures,
    bootstrap_rotations: counters.bootstrapRotations,
    header_rejections: counters.headerRejections,
    operation_conflicts: counters.operationConflicts,
    storage_failures: counters.storageFailures,
    write_authorizations: counters.writeAuthorizations
  });
}

export function requireHostDeckRequestCsrfWriteAuthorization(
  request: FastifyRequest,
  mechanism: Extract<
    HostDeckRequestAuthenticationMechanism,
    "device_cookie" | "local_admin_or_device_cookie"
  >,
  policy: HostDeckCsrfPolicy
): HostDeckCsrfAuthorizationReceipt {
  assertHostDeckCsrfPolicy(policy);
  const counters = requireCounters(policy);
  let context: SelectedRequestAuthenticationContext;
  try {
    context = requireHostDeckRequestAuthentication(request, mechanism);
    requireHostDeckRequestWritePermission(context);
  } catch (error) {
    counters.authorityRejections = increment(counters.authorityRejections);
    throw error;
  }

  if (context.state === "local_admin") {
    return Object.freeze({
      authority: "local_admin",
      device_id: null,
      permission: "local_admin",
      csrf_generation: null,
      verified_at: null
    });
  }
  const pairedContext = pairedDeviceContext(context);
  if (pairedContext === null || pairedContext.permission !== "write") {
    counters.authorityRejections = increment(counters.authorityRejections);
    throw csrfDenial();
  }

  let headers: ParsedCsrfHeaders;
  try {
    headers = parseCsrfHeaders(request.raw.rawHeaders);
  } catch {
    counters.headerRejections = increment(counters.headerRejections);
    throw csrfDenial();
  }
  if (headers.csrfGeneration !== pairedContext.csrf_generation) {
    headers.rawCsrfToken = null;
    counters.authorityRejections = increment(counters.authorityRejections);
    throw csrfDenial();
  }

  let authorizationInput:
    | {
        readonly deviceId: string;
        readonly expectedCsrfGeneration: number;
        readonly now: Date;
        rawCsrfToken: string | null;
    }
    | undefined;
  let expectedAuthorizedAt: string | undefined;
  let rawResult: unknown;
  try {
    const now = readPolicyNow(policy);
    expectedAuthorizedAt = now.toISOString();
    authorizationInput = {
      deviceId: pairedContext.device_id,
      expectedCsrfGeneration: headers.csrfGeneration,
      now,
      rawCsrfToken: headers.rawCsrfToken
    };
    rawResult = Reflect.apply(policy.authorizeBrowserWrite, undefined, [
      authorizationInput
    ]);
  } catch (error) {
    if (authorizationInput !== undefined) authorizationInput.rawCsrfToken = null;
    headers.rawCsrfToken = null;
    throw mapWriteAuthorizationFailure(error, counters);
  }
  authorizationInput.rawCsrfToken = null;
  headers.rawCsrfToken = null;
  if (expectedAuthorizedAt === undefined) throw storageFailure();
  const device = parseAuthorizedDevice(
    rawResult,
    pairedContext,
    expectedAuthorizedAt,
    counters
  );
  counters.writeAuthorizations = increment(counters.writeAuthorizations);
  return Object.freeze({
    authority: "paired_device",
    device_id: device.id,
    permission: "write",
    csrf_generation: device.csrf_generation,
    verified_at: device.last_used_at
  });
}

export function createHostDeckCsrfRouteRegistration(
  input: CreateHostDeckCsrfRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    routeInputKeys,
    "HostDeck CSRF route input is invalid."
  );
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckSecurityMutationAuditExecutor(values.audit);
  const audit = readExactFrozenDataObject(values.audit, auditPortKeys);
  if (
    typeof audit.execute !== "function" ||
    typeof audit.reject !== "function" ||
    typeof audit.snapshot !== "function"
  ) {
    throw new TypeError("HostDeck security audit executor is invalid.");
  }
  const execute = audit.execute as ExecuteAudit;
  const policy = values.csrf;
  const manifest = requireCsrfManifestEntry();
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckCsrfRouteRegistrationId,
    surface: "api",
    register(app) {
      app.post(
        manifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(request, reply) {
            reply.header("cache-control", "no-store");
            reply.header("pragma", "no-cache");
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            body: selectedCsrfBootstrapRequestSchema,
            querystring: noCsrfBootstrapQuerySchema,
            response: { 200: selectedCsrfBootstrapResponseSchema }
          }
        },
        async (request) => {
          const context = requireHostDeckRequestAuthentication(
            request,
            "device_cookie"
          );
          const body = request.body as { readonly operation_id: string };
          return executeBootstrap(
            execute,
            policy,
            request,
            context,
            body.operation_id
          );
        }
      );
    }
  };
  return Object.freeze(registration);
}

async function executeBootstrap(
  execute: ExecuteAudit,
  policy: HostDeckCsrfPolicy,
  request: FastifyRequest,
  context: SelectedRequestAuthenticationContext,
  operationId: string
): Promise<SelectedCsrfBootstrapResponse> {
  const pairedContext = pairedDeviceContext(context);
  if (pairedContext === null) throw csrfDenial();
  const counters = requireCounters(policy);
  let rawResult: unknown;
  try {
    rawResult = await Reflect.apply(execute, undefined, [
      {
        operation_id: operationId,
        actor: {
          type: "dashboard",
          device_id: pairedContext.device_id,
          permission: pairedContext.permission,
          origin: pairedContext.configured_origin
        },
        action: "csrf_bootstrap",
        target: { type: "device", device_id: pairedContext.device_id },
        accepted_summary: {
          schema_version: 1,
          csrf_generation_before: pairedContext.csrf_generation
        },
        emergency_lock_on_audit_unavailable: false,
        transition: () => {
          try {
            assertHostDeckRequestAuthenticationCurrent(request, context);
          } catch (error) {
            if (
              error instanceof HostDeckHttpError &&
              error.code === "permission_denied"
            ) {
              counters.authorityRejections = increment(
                counters.authorityRejections
              );
              return Object.freeze({
                outcome: "failed" as const,
                error_code: "permission_denied" as const,
                payload_summary: Object.freeze({ schema_version: 1 as const })
              });
            }
            throw error;
          }
          return rotateBootstrap(policy, pairedContext);
        },
        prepare_response: (candidate) => {
          assertHostDeckRequestAuthenticationCurrent(request, context);
          return prepareBootstrapResponse(candidate);
        }
      }
    ]);
  } catch (error) {
    rethrowStaleIngressFailure(request, context);
    if (error instanceof HostDeckSecurityMutationAuditExecutorError) {
      counters.auditFailures = increment(counters.auditFailures);
      throw mapExecutorFailure(error);
    }
    counters.auditFailures = increment(counters.auditFailures);
    throw csrfContractFailure();
  }

  let result: Readonly<Record<string, unknown>>;
  try {
    result = readExactFrozenVariant(rawResult, [
      auditResultKeys,
      auditFailureResultKeys
    ]);
  } catch {
    counters.auditFailures = increment(counters.auditFailures);
    throw csrfContractFailure();
  }
  if (result.outcome === "succeeded") {
    let response: SelectedCsrfBootstrapResponse;
    try {
      response = parsePreparedResponse(result.response);
    } catch {
      counters.auditFailures = increment(counters.auditFailures);
      throw csrfContractFailure();
    }
    return response;
  }
  if (result.outcome === "failed" || result.outcome === "incomplete") {
    counters.bootstrapFailures = increment(counters.bootstrapFailures);
    if (typeof result.error_code !== "string" || !isErrorCode(result.error_code)) {
      counters.auditFailures = increment(counters.auditFailures);
      throw csrfContractFailure();
    }
    throw publicFailure(result.error_code, false);
  }
  counters.auditFailures = increment(counters.auditFailures);
  throw csrfContractFailure();
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

function rotateBootstrap(
  policy: HostDeckCsrfPolicy,
  context: PairedRequestAuthenticationContext
): Readonly<Record<string, unknown>> {
  const counters = requireCounters(policy);
  let now: Date;
  let expectedRotatedAt: string;
  let raw: unknown;
  try {
    now = readPolicyNow(policy);
    expectedRotatedAt = now.toISOString();
    const rotationInput = Object.freeze({
      deviceId: context.device_id,
      expectedCsrfGeneration: context.csrf_generation,
      now
    });
    raw = Reflect.apply(policy.rotateBootstrap, undefined, [
      rotationInput
    ]);
  } catch (error) {
    const mapped = mapRotationFailure(error, counters);
    return Object.freeze({
      outcome: mapped.outcome,
      error_code: mapped.errorCode,
      payload_summary: Object.freeze({ schema_version: 1 })
    });
  }

  let rotation: ParsedRotation;
  try {
    rotation = parseRotation(raw);
    if (
      rotation.deviceId !== context.device_id ||
      rotation.csrfGeneration !== context.csrf_generation + 1 ||
      rotation.rotatedAt !== expectedRotatedAt ||
      Date.parse(rotation.rotatedAt) < Date.parse(context.last_used_at)
    ) {
      throw new TypeError();
    }
  } catch {
    counters.storageFailures = increment(counters.storageFailures);
    return Object.freeze({
      outcome: "incomplete",
      error_code: "internal_error",
      payload_summary: Object.freeze({ schema_version: 1 })
    });
  }
  counters.bootstrapRotations = increment(counters.bootstrapRotations);
  return Object.freeze({
    outcome: "succeeded",
    response: rotation,
    payload_summary: Object.freeze({
      schema_version: 1,
      csrf_generation_after: rotation.csrfGeneration,
      rotated: true
    })
  });
}

function prepareBootstrapResponse(candidate: unknown): SelectedCsrfBootstrapResponse {
  const rotation = parseRotation(candidate);
  const parsed = selectedCsrfBootstrapResponseSchema.safeParse({
    csrf_token: rotation.rawCsrfToken,
    csrf_generation: rotation.csrfGeneration,
    rotated_at: rotation.rotatedAt
  });
  if (!parsed.success) {
    throw new TypeError("CSRF bootstrap response is invalid.");
  }
  return Object.freeze({ ...parsed.data });
}

function parsePreparedResponse(candidate: unknown): SelectedCsrfBootstrapResponse {
  const values = readExactFrozenDataObject(candidate, [
    "csrf_token",
    "csrf_generation",
    "rotated_at"
  ] as const);
  const parsed = selectedCsrfBootstrapResponseSchema.safeParse(values);
  if (!parsed.success) throw new TypeError("Prepared CSRF response is invalid.");
  return Object.freeze({ ...parsed.data });
}

function parseRotation(candidate: unknown): ParsedRotation {
  const values = readExactFrozenDataObject(candidate, rotationKeys);
  const token = selectedRawCsrfTokenSchema.safeParse(values.rawCsrfToken);
  const generation =
    typeof values.csrfGeneration === "number" &&
    Number.isSafeInteger(values.csrfGeneration) &&
    values.csrfGeneration > 0
      ? values.csrfGeneration
      : null;
  const rotatedAt =
    typeof values.rotatedAt === "string" &&
    Number.isFinite(Date.parse(values.rotatedAt)) &&
    new Date(Date.parse(values.rotatedAt)).toISOString() === values.rotatedAt
      ? values.rotatedAt
      : null;
  if (
    typeof values.deviceId !== "string" ||
    !token.success ||
    generation === null ||
    rotatedAt === null
  ) {
    throw new TypeError("CSRF rotation result is invalid.");
  }
  return Object.freeze({
    deviceId: values.deviceId,
    rawCsrfToken: token.data,
    csrfGeneration: generation,
    rotatedAt
  });
}

function parseAuthorizedDevice(
  candidate: unknown,
  context: PairedRequestAuthenticationContext,
  expectedAuthorizedAt: string,
  counters: MutableCsrfCounters
) {
  try {
    const authentication = readExactFrozenDataObject(
      candidate,
      authenticationKeys
    );
    if (authentication.trusted !== true || authentication.readOnly !== false) {
      throw new TypeError();
    }
    const rawDevice = readExactFrozenDataObject(authentication.device, authDeviceKeys);
    const device = authDeviceRecordSchema.parse(rawDevice);
    if (
      device.id !== context.device_id ||
      device.permission !== "write" ||
      device.csrf_generation !== context.csrf_generation ||
      device.revoked_at !== null ||
      device.last_used_at === null ||
      device.last_used_at !== expectedAuthorizedAt ||
      Date.parse(device.last_used_at) < Date.parse(context.last_used_at) ||
      device.expires_at !== context.expires_at
    ) {
      throw new TypeError();
    }
    return device;
  } catch {
    counters.storageFailures = increment(counters.storageFailures);
    throw storageFailure();
  }
}

function parseCsrfHeaders(rawHeaders: readonly string[]): ParsedCsrfHeaders {
  try {
    if (
      !Array.isArray(rawHeaders) ||
      rawHeaders.length % 2 !== 0 ||
      rawHeaders.length > maxRawHeaderEntries
    ) {
      throw new TypeError();
    }
    const target = new Map<string, string>();
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index];
      const value = rawHeaders[index + 1];
      if (typeof name !== "string" || typeof value !== "string") {
        throw new TypeError();
      }
      const normalized = name.toLowerCase();
      if (
        normalized !== selectedCsrfTokenHeaderName &&
        normalized !== selectedCsrfGenerationHeaderName
      ) {
        continue;
      }
      if (target.has(normalized)) throw new TypeError();
      target.set(normalized, value);
    }
    const rawCsrfToken = target.get(selectedCsrfTokenHeaderName);
    const rawGeneration = target.get(selectedCsrfGenerationHeaderName);
    const token = selectedRawCsrfTokenSchema.safeParse(rawCsrfToken);
    const generation = selectedCsrfGenerationHeaderValueSchema.safeParse(rawGeneration);
    if (!token.success || !generation.success) throw new TypeError();
    return { rawCsrfToken: token.data, csrfGeneration: generation.data };
  } catch {
    throw csrfDenial();
  }
}

function requireCsrfManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "csrf_bootstrap"
  );
  const entry = matches[0];
  const audit = entry?.audit;
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    entry.family !== "access" ||
    entry.method !== "POST" ||
    entry.path !== "/api/v1/access/csrf" ||
    entry.transport !== "json" ||
    entry.request.params !== null ||
    entry.request.query !== null ||
    entry.request.body !== "csrf_bootstrap_request_v1" ||
    entry.response.success !== "csrf_bootstrap_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "device_cookie" ||
    entry.authority !== "csrf_rotate" ||
    entry.csrf !== "rotate" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "authenticated_device" ||
    entry.operation_kind !== null ||
    audit.executor !== "security_executor" ||
    audit.action !== "csrf_bootstrap" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.credential_effect !== "rotate_csrf" ||
    entry.handler !== "access.bootstrapCsrf" ||
    entry.owner_task !== "IFC-V1-027"
  ) {
    throw new TypeError("Selected CSRF bootstrap manifest entry is invalid.");
  }
  return entry;
}

function pairedDeviceContext(
  context: SelectedRequestAuthenticationContext
): PairedRequestAuthenticationContext | null {
  if (
    context.state !== "paired_device" ||
    context.device_id === null ||
    (context.permission !== "read" && context.permission !== "write") ||
    context.csrf_generation === null ||
    context.last_used_at === null
  ) {
    return null;
  }
  return context as PairedRequestAuthenticationContext;
}

function mapRotationFailure(
  error: unknown,
  counters: MutableCsrfCounters
): { readonly outcome: "failed" | "incomplete"; readonly errorCode: ErrorCode } {
  if (error instanceof HostDeckAuthRepositoryError) {
    switch (error.code) {
      case "device_not_found":
      case "device_expired":
      case "device_revoked":
        counters.authorityRejections = increment(counters.authorityRejections);
        return { outcome: "failed", errorCode: "permission_denied" };
      case "csrf_rotation_conflict":
      case "authentication_conflict":
      case "csrf_generation_exhausted":
        counters.operationConflicts = increment(counters.operationConflicts);
        return { outcome: "failed", errorCode: "operation_conflict" };
      case "invalid_auth_device":
        counters.storageFailures = increment(counters.storageFailures);
        return { outcome: "failed", errorCode: "storage_error" };
      case "csrf_rotation_failed":
      case "duplicate_secret":
        counters.storageFailures = increment(counters.storageFailures);
        return { outcome: "incomplete", errorCode: "storage_error" };
      case "invalid_csrf_authorization":
      case "invalid_time":
        counters.storageFailures = increment(counters.storageFailures);
        return { outcome: "incomplete", errorCode: "internal_error" };
    }
  }
  counters.storageFailures = increment(counters.storageFailures);
  return { outcome: "incomplete", errorCode: "internal_error" };
}

function mapWriteAuthorizationFailure(
  error: unknown,
  counters: MutableCsrfCounters
): HostDeckHttpError {
  if (error instanceof HostDeckAuthRepositoryError) {
    switch (error.code) {
      case "csrf_mismatch":
        counters.authorityRejections = increment(counters.authorityRejections);
        return csrfDenial();
      case "read_only":
        counters.authorityRejections = increment(counters.authorityRejections);
        return new HostDeckHttpError({
          code: "read_only",
          message: "The paired device has read-only permission.",
          retryable: false,
          status: 403
        });
      case "device_not_found":
      case "device_expired":
      case "device_revoked":
        counters.authorityRejections = increment(counters.authorityRejections);
        return new HostDeckHttpError({
          code: "permission_denied",
          message: "Paired device authority is no longer valid.",
          retryable: false,
          status: 401
        });
      case "authentication_conflict":
        counters.operationConflicts = increment(counters.operationConflicts);
        return new HostDeckHttpError({
          code: "operation_conflict",
          message: "Browser-write authorization conflicts with newer device state.",
          retryable: false,
          status: 409
        });
    }
  }
  counters.storageFailures = increment(counters.storageFailures);
  return storageFailure();
}

function mapExecutorFailure(
  error: HostDeckSecurityMutationAuditExecutorError
): HostDeckHttpError {
  return publicFailure(error.api_code, error.retry_safe);
}

function publicFailure(code: ErrorCode, retryable: boolean): HostDeckHttpError {
  const status =
    code === "permission_denied"
      ? 401
      : code === "read_only"
        ? 403
        : code === "operation_conflict"
          ? 409
          : code === "audit_unavailable" || code === "runtime_unavailable"
            ? 503
            : code === "validation_error"
              ? 400
              : 500;
  const message =
    code === "permission_denied"
      ? "Paired device authority is no longer valid."
      : code === "read_only"
        ? "The paired device has read-only permission."
        : code === "operation_conflict"
          ? "CSRF bootstrap conflicts with newer device state."
          : code === "audit_unavailable"
            ? "CSRF bootstrap audit is unavailable."
            : code === "storage_error"
              ? "CSRF bootstrap storage is unavailable."
              : "CSRF bootstrap failed.";
  return new HostDeckHttpError({ code, message, retryable, status });
}

function csrfDenial(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "permission_denied",
    message: "Current CSRF authorization is required for this browser write.",
    retryable: false,
    status: 403
  });
}

function storageFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "storage_error",
    message: "Browser-write authorization storage is unavailable.",
    retryable: false,
    status: 500
  });
}

function csrfContractFailure(): HostDeckCsrfContractError {
  return new HostDeckCsrfContractError();
}

function readPolicyNow(policy: HostDeckCsrfPolicy): Date {
  let raw: unknown;
  try {
    raw = Reflect.apply(policy.now, undefined, []);
  } catch {
    throw storageFailure();
  }
  if (!(raw instanceof Date)) throw storageFailure();
  let time: number;
  try {
    time = Date.prototype.getTime.call(raw);
  } catch {
    throw storageFailure();
  }
  if (!Number.isFinite(time)) throw storageFailure();
  return new Date(time);
}

function requireCounters(policy: HostDeckCsrfPolicy): MutableCsrfCounters {
  const counters = policyCounters.get(policy);
  if (counters === undefined) throw new TypeError("HostDeck CSRF policy is unavailable.");
  return counters;
}

function increment(value: number): number {
  return value >= maxCounter ? maxCounter : value + 1;
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) => typeof key !== "string" || !expectedKeys.includes(key as Key)
      )
    ) {
      throw new TypeError();
    }
    const values: Partial<Record<Key, unknown>> = Object.create(null) as Partial<
      Record<Key, unknown>
    >;
    for (const key of expectedKeys) {
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
    return Object.freeze(values) as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}

function readExactFrozenDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !Object.isFrozen(candidate)
    ) {
      throw new TypeError();
    }
    return readExactDataObject(
      candidate,
      expectedKeys,
      "CSRF port result is invalid."
    );
  } catch {
    throw new TypeError("Frozen CSRF port result is required.");
  }
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
  throw new TypeError("CSRF audit executor result is invalid.");
}
