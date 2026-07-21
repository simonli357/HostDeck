import {
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  type RemoteIngressPublicState,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  remoteIngressPublicStateSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationCurrent,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  assertRemoteIngressControlService,
  HostDeckRemoteIngressControlServiceError,
  type RemoteIngressControlService
} from "./remote-ingress-control-service.js";
import {
  assertHostDeckRemoteIngressLifecycleControl,
  type HostDeckRemoteIngressLifecycleControl,
  HostDeckRemoteIngressLifecycleError
} from "./remote-ingress-lifecycle.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckRemoteIngressRouteRegistrationId =
  "selected-remote-ingress-control";

export interface CreateHostDeckRemoteIngressRouteRegistrationInput {
  readonly service:
    | HostDeckRemoteIngressLifecycleControl
    | RemoteIngressControlService;
}

type RemoteOperation = "disable" | "enable" | "status";
type RemoteServiceMethod =
  | HostDeckRemoteIngressLifecycleControl["disable"]
  | HostDeckRemoteIngressLifecycleControl["enable"]
  | HostDeckRemoteIngressLifecycleControl["readStatus"];

const registrationInputKeys = ["service"] as const;
const noQuerySchema = z.object({}).strict();
const registeredServices = new WeakSet<object>();

export function createHostDeckRemoteIngressRouteRegistration(
  input: CreateHostDeckRemoteIngressRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    registrationInputKeys,
    "HostDeck remote-ingress route input is invalid."
  );
  assertRouteService(values.service);
  const service = values.service;
  if (registeredServices.has(service)) {
    throw new TypeError(
      "Remote ingress control service already owns a route registration."
    );
  }

  const statusManifest = requireManifestEntry("remote_status");
  const enableManifest = requireManifestEntry("remote_enable");
  const disableManifest = requireManifestEntry("remote_disable");
  let registered = false;

  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckRemoteIngressRouteRegistrationId,
    surface: "api" as const,
    register(app) {
      if (registered) {
        throw new TypeError("HostDeck remote-ingress routes are already registered.");
      }
      registered = true;

      app.get(
        statusManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async onRequest(_request, reply) {
            setNoStore(reply);
          },
          schema: {
            querystring: noQuerySchema,
            response: { 200: remoteIngressPublicStateSchema }
          }
        },
        (request) =>
          dispatchRemoteOperation(
            request,
            service.readStatus,
            "status"
          )
      );

      app.post(
        enableManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            setNoStore(reply);
          },
          schema: {
            body: remoteEnableRequestSchema,
            querystring: noQuerySchema,
            response: { 200: remoteIngressPublicStateSchema }
          }
        },
        (request) =>
          dispatchRemoteOperation(
            request,
            service.enable,
            "enable",
            request.body as RemoteEnableRequest
          )
      );

      app.post(
        disableManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            setNoStore(reply);
          },
          schema: {
            body: remoteDisableRequestSchema,
            querystring: noQuerySchema,
            response: { 200: remoteIngressPublicStateSchema }
          }
        },
        (request) =>
          dispatchRemoteOperation(
            request,
            service.disable,
            "disable",
            request.body as RemoteDisableRequest
          )
      );
    }
  };

  registeredServices.add(service);
  return Object.freeze(registration);
}

async function dispatchRemoteOperation(
  request: FastifyRequest,
  method: RemoteServiceMethod,
  operation: RemoteOperation,
  body?: RemoteDisableRequest | RemoteEnableRequest
): Promise<RemoteIngressPublicState> {
  const context = requireHostDeckRequestAuthentication(
    request,
    operation === "status"
      ? "local_admin_or_device_cookie"
      : "local_admin"
  );
  assertHostDeckRequestAuthenticationCurrent(request, context);

  let candidate: unknown;
  try {
    candidate =
      operation === "status"
        ? await Reflect.apply(method, undefined, [])
        : await Reflect.apply(method, undefined, [body]);
  } catch (error) {
    assertHostDeckRequestAuthenticationCurrent(request, context);
    throw mapServiceFailure(error);
  }

  assertHostDeckRequestAuthenticationCurrent(request, context);
  const parsed = remoteIngressPublicStateSchema.safeParse(candidate);
  if (!parsed.success) throw contractFailure();
  return Object.freeze({ ...parsed.data });
}

function mapServiceFailure(error: unknown): HostDeckHttpError {
  if (error instanceof HostDeckRemoteIngressLifecycleError) {
    return new HostDeckHttpError({
      code: "runtime_unavailable",
      message: "Remote ingress lifecycle is unavailable.",
      retryable: error.code === "lifecycle_closed",
      status: 503
    });
  }
  if (!(error instanceof HostDeckRemoteIngressControlServiceError)) {
    return contractFailure();
  }
  return new HostDeckHttpError({
    code: error.api_code,
    message: publicFailureMessage(error.api_code),
    retryable: error.retryable,
    status: publicFailureStatus(error.api_code)
  });
}

function assertRouteService(
  candidate: unknown
): asserts candidate is
  | HostDeckRemoteIngressLifecycleControl
  | RemoteIngressControlService {
  try {
    assertRemoteIngressControlService(candidate);
    return;
  } catch {
    assertHostDeckRemoteIngressLifecycleControl(candidate);
  }
}

function publicFailureStatus(code: ErrorCode): number {
  switch (code) {
    case "malformed_request":
    case "validation_error":
      return 400;
    case "request_too_large":
      return 413;
    case "unsupported_media_type":
      return 415;
    case "permission_denied":
    case "invalid_origin":
    case "read_only":
      return 403;
    case "insecure_transport":
      return 426;
    case "host_locked":
      return 423;
    case "route_not_found":
    case "session_not_found":
      return 404;
    case "method_not_allowed":
      return 405;
    case "not_acceptable":
      return 406;
    case "approval_not_pending":
    case "capability_unavailable":
    case "operation_conflict":
    case "session_not_writable":
    case "stale_session":
      return 409;
    case "rate_limited":
      return 429;
    case "audit_unavailable":
    case "daemon_unavailable":
    case "incompatible_runtime":
    case "runtime_unavailable":
    case "service_overloaded":
      return 503;
    case "protocol_error":
      return 502;
    case "operation_timeout":
      return 504;
    case "duplicate_session_name":
    case "internal_error":
    case "invalid_config":
    case "invalid_cwd":
    case "invalid_session_id":
    case "missing_binary":
    case "storage_error":
    case "unknown_error":
      return 500;
  }
}

function publicFailureMessage(code: ErrorCode): string {
  switch (code) {
    case "validation_error":
      return "Remote ingress request is invalid.";
    case "permission_denied":
      return "Remote ingress operation is not permitted.";
    case "operation_conflict":
    case "capability_unavailable":
      return "Remote ingress conflicts with current laptop state.";
    case "audit_unavailable":
      return "Remote ingress security audit is unavailable.";
    case "storage_error":
      return "Remote ingress storage is unavailable.";
    case "runtime_unavailable":
    case "daemon_unavailable":
    case "incompatible_runtime":
    case "missing_binary":
      return "Remote ingress client is unavailable.";
    case "service_overloaded":
      return "A remote ingress operation is already active.";
    case "operation_timeout":
      return "Remote ingress operation timed out.";
    case "protocol_error":
      return "Remote ingress client response is invalid.";
    default:
      return "Remote ingress operation failed.";
  }
}

function requireManifestEntry(
  id: "remote_disable" | "remote_enable" | "remote_status"
): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.family !== "remote" ||
    entry.transport !== "json" ||
    entry.request.params !== null ||
    entry.request.query !== null ||
    entry.response.success !== "remote_ingress_public_state_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "host" ||
    entry.operation_kind !== null ||
    entry.credential_effect !== "none" ||
    entry.owner_task !== "IFC-V1-076"
  ) {
    throw new TypeError("Selected remote-ingress route manifest entry is invalid.");
  }

  if (id === "remote_status") {
    if (
      entry.method !== "GET" ||
      entry.path !== "/api/v1/remote/status" ||
      entry.request.body !== null ||
      entry.auth !== "local_admin_or_device_cookie" ||
      entry.authority !== "access_read" ||
      entry.audit !== null ||
      entry.handler !== "remote.readStatus"
    ) {
      throw new TypeError("Selected remote-status route manifest entry is invalid.");
    }
    return entry;
  }

  const enabling = id === "remote_enable";
  const audit = entry.audit;
  if (
    entry.method !== "POST" ||
    entry.path !==
      (enabling ? "/api/v1/remote/enable" : "/api/v1/remote/disable") ||
    entry.request.body !==
      (enabling ? "remote_enable_request_v1" : "remote_disable_request_v1") ||
    entry.auth !== "local_admin" ||
    entry.authority !== "local_admin" ||
    audit === null ||
    !Object.isFrozen(audit) ||
    audit.executor !== "security_executor" ||
    audit.action !== (enabling ? "remote_enable" : "remote_disable") ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.handler !== (enabling ? "remote.enable" : "remote.disable")
  ) {
    throw new TypeError("Selected remote-mutation route manifest entry is invalid.");
  }
  return entry;
}

function setNoStore(reply: {
  header: (name: string, value: string) => unknown;
}): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function contractFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "internal_error",
    message: "Remote ingress route boundary failed.",
    retryable: false,
    status: 500
  });
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new TypeError(message);
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(message);
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => {
        if (typeof key !== "string" || !expectedKeys.includes(key as Key)) {
          return true;
        }
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      })
    ) {
      throw new TypeError(message);
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => {
          const stringKey = key as string;
          return [stringKey, descriptors[stringKey]?.value];
        })
      ) as Record<Key, unknown>
    );
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}
