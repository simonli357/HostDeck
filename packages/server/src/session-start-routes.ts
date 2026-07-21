import {
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedSessionStartResponse,
  type SelectedStartSessionRequest,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  selectedSessionStartResponseSchema,
  selectedStartSessionRequestSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  assertHostDeckCsrfPolicy,
  type HostDeckCsrfPolicy
} from "./csrf-routes.js";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  assertHostDeckHostLockPolicy,
  type HostDeckHostLockPolicy
} from "./host-lock-routes.js";
import {
  HostDeckManagedCodexThreadServiceError,
  type ManagedCodexThreadService
} from "./managed-thread-service.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
import {
  assertHostDeckSelectedWriteAdmissionPolicy,
  type HostDeckSelectedWriteAdmissionPolicy
} from "./selected-write-admission-policy.js";
import {
  assertHostDeckSelectedWriteAuditExecutor,
  type HostDeckSelectedWriteAuditExecutor
} from "./selected-write-audit-executor.js";
import { createHostDeckSelectedWriteGate } from "./selected-write-gate.js";
import {
  createHostDeckSelectedWriteAuditPort,
  createHostDeckSelectedWriteMutation,
  createHostDeckSelectedWriteTargetResolution,
  type HostDeckSelectedWriteAuditExecute,
  readExactDataObject
} from "./selected-write-gate-contracts.js";

export const hostDeckSessionStartRouteRegistrationId = "selected-session-start";

export interface HostDeckSessionStartRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckSessionStartRouteRegistrationInput {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly runtime: HostDeckSessionStartRuntimePort;
  readonly sessions: Pick<ManagedCodexThreadService, "start">;
}

type ReadRuntime = HostDeckSessionStartRuntimePort["read"];
type StartSession = ManagedCodexThreadService["start"];

interface ParsedRoutePorts {
  readonly readRuntime: ReadRuntime;
  readonly startSession: StartSession;
}

interface SessionStartRuntimeResolution {
  readonly binding_id: string;
  readonly runtime_version: string;
}

const routeInputKeys = ["admission", "audit", "csrf", "lock", "runtime", "sessions"] as const;
const runtimePortKeys = ["read"] as const;
const sessionPortKeys = ["start"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();
const sessionStartTarget = Object.freeze({
  type: "host" as const,
  host_id: "local_host" as const
});

export function createHostDeckSessionStartRouteRegistration(
  input: CreateHostDeckSessionStartRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    routeInputKeys,
    "HostDeck session-start route input is invalid."
  );
  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseRoutePorts(values.runtime, values.sessions);
  const manifest = requireSessionStartManifestEntry();
  const audit = createHostDeckSelectedWriteAuditPort<"session_start">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"session_start">
  });
  const gate = createHostDeckSelectedWriteGate({
    admission: values.admission,
    manifest,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;
  const registration: HostDeckRoutePluginRegistration = Object.freeze({
    id: hostDeckSessionStartRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) {
        throw new TypeError("HostDeck session-start route is already registered.");
      }
      registered = true;
      app.post(
        manifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            body: selectedStartSessionRequestSchema,
            querystring: noQuerySchema,
            response: { 201: selectedSessionStartResponseSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.execute<
            SelectedStartSessionRequest,
            SessionStartRuntimeResolution,
            SelectedSessionStartResponse,
            SelectedSessionStartResponse
          >({
            request,
            candidate: request.body,
            parse(candidate) {
              const parsed = selectedStartSessionRequestSchema.safeParse(candidate);
              if (!parsed.success) {
                throw sessionStartHttpError(
                  400,
                  "validation_error",
                  "Session-start request is invalid.",
                  false
                );
              }
              return createHostDeckSelectedWriteMutation({
                operation_id: parsed.data.operation_id,
                action: "session_start",
                target: sessionStartTarget,
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  name_length: parsed.data.name.length,
                  cwd_present: true as const
                }),
                value: parsed.data
              });
            },
            resolve_target(mutation) {
              return createHostDeckSelectedWriteTargetResolution({
                target: mutation.target,
                capability: "thread_lifecycle",
                value: resolveRuntime(ports.readRuntime)
              });
            },
            async dispatch(context) {
              const startRequest = selectedStartSessionRequestSchema.parse(
                context.mutation.value
              );
              if (
                context.mutation.target.type !== "host" ||
                context.mutation.target.host_id !== "local_host" ||
                context.resolution.target.type !== "host" ||
                context.resolution.target.host_id !== "local_host"
              ) {
                throw new TypeError("Session-start gate target is contradictory.");
              }

              let candidate: unknown;
              try {
                candidate = await Reflect.apply(ports.startSession, undefined, [
                  startRequest,
                  context.deadline
                ]);
              } catch (error) {
                if (!(error instanceof HostDeckManagedCodexThreadServiceError)) {
                  throw error;
                }
                return failedTransition(error);
              }

              let response: SelectedSessionStartResponse;
              try {
                response = responseFromState(
                  candidate,
                  startRequest,
                  context.resolution.value.runtime_version
                );
              } catch {
                return Object.freeze({
                  outcome: "incomplete" as const,
                  error_code: "internal_error" as const,
                  payload_summary: Object.freeze({ schema_version: 1 as const })
                });
              }
              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1 as const,
                  created: true as const
                }),
                response
              });
            },
            prepare_response(candidate) {
              return parseResponse(candidate);
            }
          });
          if (result.outcome !== "succeeded") {
            throw publicSessionStartFailure(result.error_code);
          }
          return reply.code(201).send(result.response);
        }
      );
    }
  });
  return registration;
}

function parseRoutePorts(runtimeCandidate: unknown, sessionsCandidate: unknown): ParsedRoutePorts {
  const runtime = readExactDataObject(
    runtimeCandidate,
    runtimePortKeys,
    "HostDeck session-start runtime port is invalid."
  );
  const sessions = readExactDataObject(
    sessionsCandidate,
    sessionPortKeys,
    "HostDeck session-start service port is invalid."
  );
  if (typeof runtime.read !== "function" || typeof sessions.start !== "function") {
    throw new TypeError("HostDeck session-start route ports are invalid.");
  }
  return Object.freeze({
    readRuntime: runtime.read as ReadRuntime,
    startSession: sessions.start as StartSession
  });
}

function requireSessionStartManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "session_start"
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
    entry.family !== "sessions" ||
    entry.method !== "POST" ||
    entry.path !== "/api/v1/sessions" ||
    entry.transport !== "json" ||
    entry.request.params !== null ||
    entry.request.query !== null ||
    entry.request.body !== "selected_start_session_request_v1" ||
    entry.response.success !== "selected_session_start_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "local_admin_or_device_cookie" ||
    entry.authority !== "session_write" ||
    entry.csrf !== "required_for_device" ||
    entry.lock !== "requires_unlocked_host" ||
    entry.target !== "new_managed_session" ||
    entry.operation_kind !== null ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "session_start" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "sessions.start" ||
    entry.owner_task !== "IFC-V1-040"
  ) {
    throw new TypeError("Selected session-start route manifest entry is invalid.");
  }
  return entry;
}

function resolveRuntime(readRuntime: ReadRuntime): SessionStartRuntimeResolution {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw sessionStartHttpError(
      503,
      "runtime_unavailable",
      "Selected runtime state is unavailable.",
      true
    );
  }
  if (candidate === null) {
    throw sessionStartHttpError(
      503,
      "runtime_unavailable",
      "Selected runtime is unavailable.",
      true
    );
  }
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError("Selected runtime compatibility is invalid.");
  }
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw sessionStartHttpError(
      503,
      "runtime_unavailable",
      "Selected runtime is disconnected.",
      true
    );
  }
  if (!runtimeAllowsSessionStart(runtime)) {
    throw sessionStartHttpError(
      409,
      "incompatible_runtime",
      "Selected runtime cannot start managed sessions.",
      false
    );
  }
  return Object.freeze({
    binding_id: runtime.binding_id,
    runtime_version: runtime.observed_version
  });
}

function runtimeAllowsSessionStart(
  runtime: RuntimeCompatibility
): runtime is RuntimeCompatibility & {
  readonly binding_id: string;
  readonly observed_version: string;
} {
  return (
    (runtime.state === "ready" || runtime.state === "degraded") &&
    runtime.mutation_policy === "allowed" &&
    runtime.binding_id !== null &&
    runtime.observed_version !== null &&
    runtime.capabilities.some(
      (capability) =>
        capability.name === "thread_lifecycle" && capability.state === "available"
    )
  );
}

function failedTransition(error: HostDeckManagedCodexThreadServiceError) {
  const errorCode = mapServiceErrorCode(error);
  return Object.freeze({
    outcome:
      error.outcome === "not_sent" || error.outcome === "remote_rejected"
        ? ("failed" as const)
        : ("incomplete" as const),
    error_code: errorCode,
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function mapServiceErrorCode(error: HostDeckManagedCodexThreadServiceError): ErrorCode {
  switch (error.code) {
    case "duplicate_session_name":
      return "duplicate_session_name";
    case "invalid_cwd":
      return "invalid_cwd";
    case "runtime_unavailable":
    case "unknown_outcome":
      return "runtime_unavailable";
    case "runtime_incompatible":
      return "incompatible_runtime";
    case "operation_timeout":
      return "operation_timeout";
    case "storage_error":
      return "storage_error";
    case "identity_mismatch":
    case "recovery_required":
    case "thread_already_archived":
    case "thread_conflict":
    case "thread_not_found":
    case "thread_not_writable":
      return "operation_conflict";
    case "invalid_request":
      return "internal_error";
  }
}

function responseFromState(
  candidate: unknown,
  request: SelectedStartSessionRequest,
  runtimeVersion: string
): SelectedSessionStartResponse {
  const values = readExactDataObject(
    candidate,
    selectedStateKeys,
    "Managed session start state is invalid."
  );
  const mapping = selectedSessionMappingRecordSchema.parse(values.mapping);
  const projection = selectedSessionProjectionRecordSchema.parse(values.projection);
  const session = projection.session;
  if (
    mapping.id !== session.id ||
    mapping.name !== session.name ||
    mapping.codex_thread_id !== session.codex_thread_id ||
    mapping.cwd !== session.cwd ||
    mapping.runtime_source !== session.runtime_source ||
    mapping.runtime_version !== session.runtime_version ||
    mapping.created_at !== session.created_at ||
    mapping.archived_at !== session.archived_at ||
    mapping.name !== request.name ||
    mapping.cwd !== request.cwd ||
    mapping.runtime_version !== runtimeVersion ||
    mapping.disposition !== "selected" ||
    mapping.archived_at !== null ||
    session.session_state === "archived"
  ) {
    throw new TypeError("Managed session start identity is contradictory.");
  }
  return parseResponse({ operation_id: request.operation_id, session });
}

function parseResponse(candidate: unknown): SelectedSessionStartResponse {
  const parsed = selectedSessionStartResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError("Session-start response is invalid.");
  }
  return deepFreeze(parsed.data);
}

function publicSessionStartFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "duplicate_session_name":
      return sessionStartHttpError(
        409,
        code,
        "A managed session with this name already exists.",
        false
      );
    case "invalid_cwd":
      return sessionStartHttpError(
        400,
        code,
        "The managed session working directory is unavailable.",
        false
      );
    case "runtime_unavailable":
      return sessionStartHttpError(
        503,
        code,
        "The selected runtime could not complete session start.",
        false
      );
    case "operation_conflict":
      return sessionStartHttpError(
        409,
        code,
        "Managed session start requires recovery before another attempt.",
        false
      );
    case "operation_timeout":
      return sessionStartHttpError(
        504,
        code,
        "Managed session start exceeded its request deadline.",
        false
      );
    case "permission_denied":
      return sessionStartHttpError(
        401,
        code,
        "Managed session start authority is no longer valid.",
        false
      );
    case "read_only":
      return sessionStartHttpError(
        403,
        code,
        "Write permission is required to start a managed session.",
        false
      );
    case "audit_unavailable":
    case "service_overloaded":
      return sessionStartHttpError(
        503,
        code,
        "Managed session start is temporarily unavailable.",
        false
      );
    default:
      return sessionStartHttpError(
        500,
        code,
        code === "storage_error"
          ? "Managed session start storage is unavailable."
          : "Managed session start did not complete.",
        false
      );
  }
}

function sessionStartHttpError(
  status: number,
  code: ErrorCode,
  message: string,
  retryable: boolean
): HostDeckHttpError {
  return new HostDeckHttpError({ status, code, message, retryable });
}

function applyNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function deepFreeze<T>(candidate: T): T {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
