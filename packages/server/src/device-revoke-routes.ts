import {
  type SelectedDeviceRevocationResult,
  type SelectedDeviceRevokeParams,
  type SelectedDeviceRevokeRequest,
  type SelectedDeviceRevokeResponse,
  selectedDeviceRevocationResultSchema,
  selectedDeviceRevokeParamsSchema,
  selectedDeviceRevokeRequestSchema,
  selectedDeviceRevokeResponseSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import {
  HostDeckAuthRepositoryError,
  type RevokeSelectedDeviceInput
} from "@hostdeck/storage";
import { serialize as serializeCookie } from "cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  assertHostDeckCsrfPolicy,
  type HostDeckCsrfPolicy
} from "./csrf-routes.js";
import {
  assertHostDeckActiveDeviceAuthorityPolicy,
  type HostDeckActiveDeviceAuthorityPolicy
} from "./device-authority-lifecycle.js";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  allowHostDeckSelfRevocationResponse,
  assertHostDeckRequestAuthenticationIngressCurrent,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  assertHostDeckHostLockPolicy,
  type HostDeckHostLockPolicy
} from "./host-lock-routes.js";
import {
  assertHostDeckSecurityMutationAuditExecutor,
  type SecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
import { createHostDeckSelectedWriteGate } from "./selected-write-gate.js";
import {
  createHostDeckSelectedWriteAuditPort,
  createHostDeckSelectedWriteMutation,
  createHostDeckSelectedWriteTargetResolution,
  type HostDeckSelectedWriteAuditExecute
} from "./selected-write-gate-contracts.js";

export const hostDeckDeviceRevokeRouteRegistrationId = "selected-device-revoke";

export interface HostDeckDeviceRevokePort {
  readonly revoke: (input: RevokeSelectedDeviceInput) => unknown;
}

export interface CreateHostDeckDeviceRevokeRouteRegistrationInput {
  readonly activeDeviceAuthority: HostDeckActiveDeviceAuthorityPolicy;
  readonly audit: SecurityMutationAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly devices: HostDeckDeviceRevokePort;
  readonly lock: HostDeckHostLockPolicy;
  readonly now: () => Date;
}

export interface HostDeckDeviceRevokeRouteSnapshot {
  readonly attempts: number;
  readonly conflicts: number;
  readonly cookie_deletions: number;
  readonly other_revocations: number;
  readonly self_revocations: number;
  readonly storage_failures: number;
  readonly successful_revocations: number;
}

interface MutableCounters {
  attempts: number;
  conflicts: number;
  cookieDeletions: number;
  otherRevocations: number;
  selfRevocations: number;
  storageFailures: number;
  successfulRevocations: number;
}

interface PreparedDeviceRevokeResponse {
  readonly body: SelectedDeviceRevokeResponse;
  readonly deletionCookie: string | null;
}

type RevokeDevice = HostDeckDeviceRevokePort["revoke"];

const routeInputKeys = [
  "activeDeviceAuthority",
  "audit",
  "csrf",
  "devices",
  "lock",
  "now"
] as const;
const devicePortKeys = ["revoke"] as const;
const revocationResultKeys = [
  "authorityInvalidated",
  "deviceId",
  "previouslyRevoked",
  "revokedAt"
] as const;
const responseKeys = [
  "authority_invalidated",
  "device_id",
  "operation_id",
  "revoked_at",
  "self_revoked"
] as const;
const preparedResponseKeys = ["body", "deletionCookie"] as const;
const noQuerySchema = z.object({}).strict();
const pendingCookieDeletions = new WeakMap<FastifyRequest, string>();
const registrationCounters = new WeakMap<
  HostDeckRoutePluginRegistration,
  MutableCounters
>();

export function createHostDeckDeviceRevokeRouteRegistration(
  input: CreateHostDeckDeviceRevokeRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    routeInputKeys,
    "HostDeck device-revoke route input is invalid."
  );
  assertHostDeckActiveDeviceAuthorityPolicy(values.activeDeviceAuthority);
  assertHostDeckSecurityMutationAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const devices = readExactDataObject(
    values.devices,
    devicePortKeys,
    "HostDeck device-revoke port is invalid."
  );
  if (typeof devices.revoke !== "function" || typeof values.now !== "function") {
    throw new TypeError("HostDeck device-revoke route ports are invalid.");
  }
  const activeDeviceAuthority = values.activeDeviceAuthority;
  const now = values.now as () => Date;
  const revoke = devices.revoke as RevokeDevice;
  const manifest = requireDeviceRevokeManifestEntry();
  const audit = createHostDeckSelectedWriteAuditPort<"device_revoke">({
    executor: "security_executor",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"device_revoke">
  });
  const gate = createHostDeckSelectedWriteGate({
    manifest,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  const counters: MutableCounters = {
    attempts: 0,
    conflicts: 0,
    cookieDeletions: 0,
    otherRevocations: 0,
    selfRevocations: 0,
    storageFailures: 0,
    successfulRevocations: 0
  };
  let registered = false;
  const registration: HostDeckRoutePluginRegistration = Object.freeze({
    id: hostDeckDeviceRevokeRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) {
        throw new TypeError("HostDeck device-revoke route is already registered.");
      }
      registered = true;
      app.post(
        manifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          async onRequestAbort(request) {
            pendingCookieDeletions.delete(request);
          },
          async onError(request, reply) {
            pendingCookieDeletions.delete(request);
            reply.removeHeader("set-cookie");
          },
          async onSend(request, reply, payload) {
            const deleteCookie = pendingCookieDeletions.get(request);
            pendingCookieDeletions.delete(request);
            if (
              deleteCookie !== undefined &&
              reply.statusCode >= 200 &&
              reply.statusCode < 300
            ) {
              assertHostDeckRequestAuthenticationIngressCurrent(request);
              reply.header("set-cookie", deleteCookie);
              counters.cookieDeletions = increment(counters.cookieDeletions);
            } else {
              reply.removeHeader("set-cookie");
            }
            return payload;
          },
          async onResponse(request) {
            pendingCookieDeletions.delete(request);
          },
          schema: {
            body: selectedDeviceRevokeRequestSchema,
            params: selectedDeviceRevokeParamsSchema,
            querystring: noQuerySchema,
            response: { 200: selectedDeviceRevokeResponseSchema }
          }
        },
        async (request) => {
          counters.attempts = increment(counters.attempts);
          const params = request.params as SelectedDeviceRevokeParams;
          const candidate = request.body as SelectedDeviceRevokeRequest;
          const target = Object.freeze({
            type: "device" as const,
            device_id: params.device_id
          });
          const result = await gate.execute({
            request,
            candidate,
            parse(raw) {
              const parsed = selectedDeviceRevokeRequestSchema.safeParse(raw);
              if (!parsed.success) {
                throw validationFailure("Device revocation request is invalid.");
              }
              return createHostDeckSelectedWriteMutation({
                operation_id: parsed.data.operation_id,
                action: "device_revoke",
                target,
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  previously_revoked: false
                }),
                value: Object.freeze({ confirmed: true as const })
              });
            },
            resolve_target(mutation) {
              return createHostDeckSelectedWriteTargetResolution({
                target: mutation.target,
                capability: null,
                value: Object.freeze({ deviceId: params.device_id })
              });
            },
            dispatch(context) {
              if (
                context.mutation.target.type !== "device" ||
                context.mutation.target.device_id !== params.device_id ||
                context.resolution.target.type !== "device" ||
                context.resolution.target.device_id !== params.device_id
              ) {
                throw new TypeError("Device-revoke gate target is contradictory.");
              }
              let revocation: SelectedDeviceRevocationResult;
              try {
                revocation = parseRevocationResult(
                  Reflect.apply(revoke, undefined, [
                    Object.freeze({
                      deviceId: params.device_id,
                      now: readNow(now)
                    })
                  ])
                );
              } catch (error) {
                const mapped = mapRevocationFailure(error, counters);
                return Object.freeze({
                  outcome: "failed" as const,
                  error_code: mapped,
                  payload_summary: Object.freeze({ schema_version: 1 as const })
                });
              }
              try {
                activeDeviceAuthority.invalidate(revocation.deviceId);
              } catch {
                return Object.freeze({
                  outcome: "incomplete" as const,
                  error_code: "internal_error" as const,
                  payload_summary: Object.freeze({ schema_version: 1 as const })
                });
              }
              if (revocation.previouslyRevoked) {
                counters.conflicts = increment(counters.conflicts);
                return Object.freeze({
                  outcome: "failed" as const,
                  error_code: "operation_conflict" as const,
                  payload_summary: Object.freeze({ schema_version: 1 as const })
                });
              }
              const selfRevoked =
                context.authority.authentication.state === "paired_device" &&
                context.authority.authentication.device_id === revocation.deviceId;
              counters.successfulRevocations = increment(
                counters.successfulRevocations
              );
              if (selfRevoked) {
                counters.selfRevocations = increment(counters.selfRevocations);
              } else {
                counters.otherRevocations = increment(counters.otherRevocations);
              }
              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1 as const,
                  authority_invalidated: true as const
                }),
                response: Object.freeze({
                  operation_id: context.mutation.operation_id,
                  device_id: revocation.deviceId,
                  revoked_at: revocation.revokedAt,
                  authority_invalidated: true as const,
                  self_revoked: selfRevoked
                })
              });
            },
            prepare_response(raw): PreparedDeviceRevokeResponse {
              const body = parseResponse(raw);
              return Object.freeze({
                body,
                deletionCookie: body.self_revoked ? createDeletionCookie() : null
              });
            }
          });
          if (result.outcome !== "succeeded") {
            throw publicFailure(result.error_code);
          }
          const prepared = parsePreparedResponse(result.response);
          if (prepared.deletionCookie !== null) {
            allowHostDeckSelfRevocationResponse(request, prepared.body.device_id);
            pendingCookieDeletions.set(request, prepared.deletionCookie);
          }
          return prepared.body;
        }
      );
    }
  });
  registrationCounters.set(registration, counters);
  return registration;
}

export function hostDeckDeviceRevokeRouteSnapshot(
  registration: HostDeckRoutePluginRegistration
): HostDeckDeviceRevokeRouteSnapshot {
  const counters = registrationCounters.get(registration);
  if (counters === undefined) {
    throw new TypeError("HostDeck device-revoke registration is invalid.");
  }
  return Object.freeze({
    attempts: counters.attempts,
    conflicts: counters.conflicts,
    cookie_deletions: counters.cookieDeletions,
    other_revocations: counters.otherRevocations,
    self_revocations: counters.selfRevocations,
    storage_failures: counters.storageFailures,
    successful_revocations: counters.successfulRevocations
  });
}

function requireDeviceRevokeManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "device_revoke"
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
    entry.path !== "/api/v1/access/devices/:device_id/revoke" ||
    entry.transport !== "json" ||
    entry.request.params !== "device_id_params_v1" ||
    entry.request.query !== null ||
    entry.request.body !== "device_revoke_request_v1" ||
    entry.response.success !== "device_revoke_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "local_admin_or_device_cookie" ||
    entry.authority !== "device_admin" ||
    entry.csrf !== "required_for_device" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "device" ||
    entry.operation_kind !== null ||
    audit.executor !== "security_executor" ||
    audit.action !== "device_revoke" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.credential_effect !== "invalidate_device" ||
    entry.handler !== "access.revokeDevice" ||
    entry.owner_task !== "IFC-V1-059"
  ) {
    throw new TypeError("Selected device-revoke route manifest entry is invalid.");
  }
  return entry;
}

function parseRevocationResult(candidate: unknown): SelectedDeviceRevocationResult {
  const values = readExactFrozenDataObject(candidate, revocationResultKeys);
  const parsed = selectedDeviceRevocationResultSchema.safeParse(values);
  if (!parsed.success) {
    throw new HostDeckAuthRepositoryError(
      "device_revoke_failed",
      "Device revocation returned invalid state."
    );
  }
  return Object.freeze({ ...parsed.data });
}

function parseResponse(candidate: unknown): SelectedDeviceRevokeResponse {
  const values = readExactFrozenDataObject(candidate, responseKeys);
  const parsed = selectedDeviceRevokeResponseSchema.safeParse(values);
  if (!parsed.success) throw new TypeError("Device-revoke response is invalid.");
  return Object.freeze({ ...parsed.data });
}

function parsePreparedResponse(candidate: unknown): PreparedDeviceRevokeResponse {
  const values = readExactFrozenDataObject(candidate, preparedResponseKeys);
  if (values.deletionCookie !== null && typeof values.deletionCookie !== "string") {
    throw new TypeError("Prepared device-revoke response is invalid.");
  }
  const body = parseResponse(values.body);
  const expectedCookie = body.self_revoked ? createDeletionCookie() : null;
  if (values.deletionCookie !== expectedCookie) {
    throw new TypeError("Prepared device-revoke cookie state is contradictory.");
  }
  return Object.freeze({ body, deletionCookie: expectedCookie });
}

function mapRevocationFailure(
  error: unknown,
  counters: MutableCounters
): ErrorCode {
  if (error instanceof HostDeckAuthRepositoryError) {
    if (
      error.code === "device_not_found" ||
      error.code === "device_revoke_time_conflict"
    ) {
      counters.conflicts = increment(counters.conflicts);
      return "operation_conflict";
    }
  }
  counters.storageFailures = increment(counters.storageFailures);
  return "storage_error";
}

function publicFailure(code: ErrorCode): HostDeckHttpError {
  const status =
    code === "validation_error"
      ? 400
      : code === "permission_denied"
        ? 401
        : code === "read_only"
          ? 403
          : code === "operation_conflict"
            ? 409
            : code === "operation_timeout"
              ? 504
              : code === "audit_unavailable" ||
                  code === "runtime_unavailable" ||
                  code === "service_overloaded"
                ? 503
                : 500;
  const message =
    code === "operation_conflict"
      ? "Device revocation conflicts with current authority state."
      : code === "permission_denied"
        ? "Device revocation authority is no longer valid."
        : code === "read_only"
          ? "Write permission is required to revoke a device."
          : code === "operation_timeout"
            ? "Device revocation exceeded its request deadline."
            : code === "storage_error"
              ? "Device revocation storage is unavailable."
              : "Device revocation did not complete.";
  return new HostDeckHttpError({
    code,
    message,
    retryable: false,
    status
  });
}

function validationFailure(message: string): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "validation_error",
    message,
    retryable: false,
    status: 400
  });
}

function readNow(now: () => Date): Date {
  const candidate = Reflect.apply(now, undefined, []);
  if (!(candidate instanceof Date)) {
    throw new HostDeckAuthRepositoryError("invalid_time", "Device revocation clock is invalid.");
  }
  const time = Date.prototype.getTime.call(candidate);
  if (!Number.isFinite(time)) {
    throw new HostDeckAuthRepositoryError("invalid_time", "Device revocation clock is invalid.");
  }
  return new Date(time);
}

function createDeletionCookie(): string {
  const value = serializeCookie(hostDeckDeviceCookieName, "", {
    path: "/",
    expires: new Date(0),
    maxAge: 0,
    httpOnly: true,
    secure: true,
    sameSite: "strict"
  });
  const expected = `${hostDeckDeviceCookieName}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
  if (value !== expected || /[\r\n]/u.test(value)) {
    throw new TypeError("Device-revoke deletion cookie is invalid.");
  }
  return value;
}

function applyNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
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
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(expectedKeys as readonly string[]).includes(key)
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
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
  if (!Object.isFrozen(candidate)) {
    throw new TypeError("Device-revoke result is not frozen.");
  }
  return readExactDataObject(
    candidate,
    expectedKeys,
    "Device-revoke result is invalid."
  );
}

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}
