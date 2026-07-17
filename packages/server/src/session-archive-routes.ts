import {
  type ArchiveSessionRequest,
  archiveSessionRequestSchema,
  managedSessionTargetSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedOperationDispatch,
  selectedOperationDispatchSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdParamsSchema
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
  createHostDeckSelectedWriteTargetResolution,
  createHostDeckSelectedWriteUnresolvedMutation,
  type HostDeckSelectedWriteAuditExecute,
  readExactDataObject
} from "./selected-write-gate-contracts.js";

export const hostDeckSessionArchiveRouteRegistrationId = "selected-session-archive";

export interface HostDeckSessionArchiveRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckSessionArchiveRouteRegistrationInput {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly runtime: HostDeckSessionArchiveRuntimePort;
  readonly sessions: Pick<ManagedCodexThreadService, "archive" | "read">;
  readonly subscribers: HostDeckSessionArchiveSubscriberPort;
}

export interface HostDeckSessionArchiveSubscriberPort {
  readonly archive_session: (sessionId: string) => unknown;
}

type ArchiveSession = ManagedCodexThreadService["archive"];
type ReadSession = ManagedCodexThreadService["read"];
type ReadRuntime = HostDeckSessionArchiveRuntimePort["read"];
type ArchiveSubscribers = HostDeckSessionArchiveSubscriberPort["archive_session"];
type SessionArchiveParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedRoutePorts {
  readonly archiveSubscribers: ArchiveSubscribers;
  readonly archiveSession: ArchiveSession;
  readonly readRuntime: ReadRuntime;
  readonly readSession: ReadSession;
}

interface SessionArchiveResolution {
  readonly runtime_version: string;
}

interface ResolvedManagedTarget {
  readonly target: z.infer<typeof managedSessionTargetSchema>;
  readonly runtime_version: string;
}

const routeInputKeys = ["admission", "audit", "csrf", "lock", "runtime", "sessions", "subscribers"] as const;
const runtimePortKeys = ["read"] as const;
const sessionPortKeys = ["archive", "read"] as const;
const subscriberPortKeys = ["archive_session"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();

export function createHostDeckSessionArchiveRouteRegistration(
  input: CreateHostDeckSessionArchiveRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    routeInputKeys,
    "HostDeck session-archive route input is invalid."
  );
  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseRoutePorts(values.runtime, values.sessions, values.subscribers);
  const manifest = requireSessionArchiveManifestEntry();
  const audit = createHostDeckSelectedWriteAuditPort<"archive">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"archive">
  });
  const gate = createHostDeckSelectedWriteGate({
    admission: values.admission,
    manifest,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;
  return Object.freeze({
    id: hostDeckSessionArchiveRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) {
        throw new TypeError("HostDeck session-archive route is already registered.");
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
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            body: archiveSessionRequestSchema,
            response: { 202: selectedOperationDispatchSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            SessionArchiveParams,
            ArchiveSessionRequest,
            SessionArchiveResolution,
            SelectedOperationDispatch,
            SelectedOperationDispatch
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Session-archive route candidate is invalid."
              );
              const body = archiveSessionRequestSchema.safeParse(routeCandidate.body);
              const params = sessionIdParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw archiveHttpError(
                  400,
                  "validation_error",
                  "Session-archive request is invalid.",
                  false
                );
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "archive",
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  confirmed: true as const
                }),
                selector: params.data,
                value: body.data
              });
            },
            resolve_target(mutation) {
              const params = sessionIdParamsSchema.parse(mutation.selector);
              const managed = resolveManagedTarget(ports.readSession, params.session_id);
              const runtime = resolveRuntime(ports.readRuntime);
              if (managed.runtime_version !== runtime.runtime_version) {
                throw archiveHttpError(
                  409,
                  "incompatible_runtime",
                  "Managed session runtime version requires reconciliation before archive.",
                  false
                );
              }
              return createHostDeckSelectedWriteTargetResolution({
                target: managed.target,
                capability: "thread_lifecycle",
                value: runtime
              });
            },
            async dispatch(context) {
              const requestBody = archiveSessionRequestSchema.parse(
                context.mutation.value
              );
              const target = managedSessionTargetSchema.parse(context.mutation.target);
              const receipt = context.accepted_audit;
              if (
                receipt === null ||
                context.resolution.target.type !== "managed_session" ||
                context.resolution.target.session_id !== target.session_id ||
                context.resolution.target.codex_thread_id !== target.codex_thread_id
              ) {
                throw new TypeError("Session-archive gate target or audit receipt is contradictory.");
              }

              let candidate: unknown;
              try {
                candidate = await Reflect.apply(ports.archiveSession, undefined, [
                  target.session_id
                ]);
              } catch (error) {
                if (!(error instanceof HostDeckManagedCodexThreadServiceError)) throw error;
                return failedTransition(error);
              }

              let response: SelectedOperationDispatch;
              try {
                assertArchivedState(
                  candidate,
                  target,
                  context.resolution.value.runtime_version
                );
                const closedSubscribers = Reflect.apply(
                  ports.archiveSubscribers,
                  undefined,
                  [target.session_id]
                );
                if (
                  !Number.isSafeInteger(closedSubscribers) ||
                  (closedSubscribers as number) < 0
                ) {
                  throw new TypeError(
                    "Session-archive subscriber cleanup returned invalid state."
                  );
                }
                response = parseResponse({
                  operation_id: requestBody.operation_id,
                  kind: "archive",
                  target,
                  state: "accepted",
                  accepted_at: receipt.accepted_at,
                  audit_record_id: receipt.audit_record_id
                });
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
                  archived: true as const
                }),
                response
              });
            },
            prepare_response(candidate) {
              return parseResponse(candidate);
            }
          });
          if (result.outcome !== "succeeded") {
            throw publicArchiveFailure(result.error_code);
          }
          return reply.code(202).send(result.response);
        }
      );
    }
  });
}

function parseRoutePorts(
  runtimeCandidate: unknown,
  sessionsCandidate: unknown,
  subscribersCandidate: unknown
): ParsedRoutePorts {
  const runtime = readExactDataObject(
    runtimeCandidate,
    runtimePortKeys,
    "HostDeck session-archive runtime port is invalid."
  );
  const sessions = readExactDataObject(
    sessionsCandidate,
    sessionPortKeys,
    "HostDeck session-archive service port is invalid."
  );
  const subscribers = readExactDataObject(
    subscribersCandidate,
    subscriberPortKeys,
    "HostDeck session-archive subscriber port is invalid."
  );
  if (
    typeof runtime.read !== "function" ||
    typeof sessions.archive !== "function" ||
    typeof sessions.read !== "function" ||
    typeof subscribers.archive_session !== "function"
  ) {
    throw new TypeError("HostDeck session-archive route ports are invalid.");
  }
  return Object.freeze({
    archiveSubscribers: subscribers.archive_session as ArchiveSubscribers,
    archiveSession: sessions.archive as ArchiveSession,
    readRuntime: runtime.read as ReadRuntime,
    readSession: sessions.read as ReadSession
  });
}

function requireSessionArchiveManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "session_archive"
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
    entry.path !== "/api/v1/sessions/:session_id/archive" ||
    entry.transport !== "json" ||
    entry.request.params !== "session_id_params_v1" ||
    entry.request.query !== null ||
    entry.request.body !== "archive_session_request_v1" ||
    entry.response.success !== "selected_operation_dispatch_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "local_admin_or_device_cookie" ||
    entry.authority !== "session_write" ||
    entry.csrf !== "required_for_device" ||
    entry.lock !== "requires_unlocked_host" ||
    entry.target !== "managed_session" ||
    entry.operation_kind !== "archive" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "archive" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "sessions.archive" ||
    entry.owner_task !== "IFC-V1-061"
  ) {
    throw new TypeError("Selected session-archive route manifest entry is invalid.");
  }
  return entry;
}

function resolveManagedTarget(
  readSession: ReadSession,
  sessionId: string
): ResolvedManagedTarget {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readSession, undefined, [sessionId]);
  } catch (error) {
    if (error instanceof HostDeckManagedCodexThreadServiceError) {
      throw publicArchiveFailure(mapServiceErrorCode(error));
    }
    throw error;
  }
  const values = readExactDataObject(
    candidate,
    selectedStateKeys,
    "Managed session archive state is invalid."
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
    mapping.id !== sessionId
  ) {
    throw archiveHttpError(
      409,
      "stale_session",
      "Managed session identity requires reconciliation before archive.",
      false
    );
  }
  if (
    mapping.archived_at !== null ||
    session.session_state === "archived"
  ) {
    throw archiveHttpError(
      409,
      "session_not_writable",
      "Managed session is already archived.",
      false
    );
  }
  if (
    mapping.disposition !== "selected" ||
    session.freshness !== "current" ||
    ["incompatible", "stale", "unknown"].includes(session.session_state)
  ) {
    throw archiveHttpError(
      409,
      "stale_session",
      "Managed session is not current and idle for archive.",
      false
    );
  }
  if (session.session_state !== "active" || session.turn_state !== "idle") {
    throw archiveHttpError(
      409,
      "session_not_writable",
      "Managed session is not current and idle for archive.",
      false
    );
  }
  return Object.freeze({
    target: deepFreeze(
      managedSessionTargetSchema.parse({
        type: "managed_session",
        session_id: mapping.id,
        codex_thread_id: mapping.codex_thread_id
      })
    ),
    runtime_version: mapping.runtime_version
  });
}

function resolveRuntime(readRuntime: ReadRuntime): SessionArchiveResolution {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw archiveHttpError(
      503,
      "runtime_unavailable",
      "Selected runtime state is unavailable.",
      true
    );
  }
  if (candidate === null) {
    throw archiveHttpError(
      503,
      "runtime_unavailable",
      "Selected runtime is unavailable.",
      true
    );
  }
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Selected runtime compatibility is invalid.");
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw archiveHttpError(
      503,
      "runtime_unavailable",
      "Selected runtime is disconnected.",
      true
    );
  }
  if (!runtimeAllowsArchive(runtime)) {
    throw archiveHttpError(
      409,
      "incompatible_runtime",
      "Selected runtime cannot archive managed sessions.",
      false
    );
  }
  return Object.freeze({ runtime_version: runtime.observed_version });
}

function runtimeAllowsArchive(
  runtime: RuntimeCompatibility
): runtime is RuntimeCompatibility & { readonly observed_version: string } {
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

function assertArchivedState(
  candidate: unknown,
  target: z.infer<typeof managedSessionTargetSchema>,
  runtimeVersion: string
): void {
  const values = readExactDataObject(
    candidate,
    selectedStateKeys,
    "Archived managed session state is invalid."
  );
  const mapping = selectedSessionMappingRecordSchema.parse(values.mapping);
  const projection = selectedSessionProjectionRecordSchema.parse(values.projection);
  const session = projection.session;
  if (
    mapping.id !== target.session_id ||
    mapping.codex_thread_id !== target.codex_thread_id ||
    mapping.id !== session.id ||
    mapping.name !== session.name ||
    mapping.codex_thread_id !== session.codex_thread_id ||
    mapping.cwd !== session.cwd ||
    mapping.runtime_source !== session.runtime_source ||
    mapping.runtime_version !== session.runtime_version ||
    mapping.runtime_version !== runtimeVersion ||
    mapping.created_at !== session.created_at ||
    mapping.archived_at === null ||
    mapping.archived_at !== session.archived_at ||
    mapping.disposition !== "selected" ||
    session.session_state !== "archived" ||
    session.turn_state !== "idle" ||
    session.attention !== "none" ||
    session.freshness !== "current"
  ) {
    throw new TypeError("Archived managed session state is contradictory.");
  }
}

function failedTransition(error: HostDeckManagedCodexThreadServiceError) {
  return Object.freeze({
    outcome:
      error.outcome === "not_sent" || error.outcome === "remote_rejected"
        ? ("failed" as const)
        : ("incomplete" as const),
    error_code: mapServiceErrorCode(error),
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function mapServiceErrorCode(error: HostDeckManagedCodexThreadServiceError): ErrorCode {
  switch (error.code) {
    case "thread_not_found":
      return "session_not_found";
    case "thread_already_archived":
    case "thread_not_writable":
      return "session_not_writable";
    case "operation_timeout":
      return "operation_timeout";
    case "runtime_incompatible":
      return "incompatible_runtime";
    case "runtime_unavailable":
    case "unknown_outcome":
      return "runtime_unavailable";
    case "storage_error":
      return "storage_error";
    case "identity_mismatch":
    case "recovery_required":
    case "thread_conflict":
      return "operation_conflict";
    case "duplicate_session_name":
    case "invalid_cwd":
    case "invalid_request":
      return "internal_error";
  }
}

function parseResponse(candidate: unknown): SelectedOperationDispatch {
  const parsed = selectedOperationDispatchSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.state !== "accepted" || parsed.data.kind !== "archive") {
    throw new TypeError("Session-archive response is invalid.");
  }
  return deepFreeze(parsed.data);
}

function publicArchiveFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "session_not_found":
      return archiveHttpError(404, code, "Managed session does not exist.", false);
    case "session_not_writable":
    case "stale_session":
      return archiveHttpError(
        409,
        code,
        "Managed session is not current and idle for archive.",
        false
      );
    case "incompatible_runtime":
      return archiveHttpError(
        409,
        code,
        "Selected runtime cannot archive this managed session.",
        false
      );
    case "operation_conflict":
      return archiveHttpError(
        409,
        code,
        "Managed session archive requires reconciliation before another attempt.",
        false
      );
    case "operation_timeout":
      return archiveHttpError(
        504,
        code,
        "Managed session archive exceeded its request deadline.",
        false
      );
    case "permission_denied":
      return archiveHttpError(
        401,
        code,
        "Managed session archive authority is no longer valid.",
        false
      );
    case "read_only":
      return archiveHttpError(
        403,
        code,
        "Write permission is required to archive a managed session.",
        false
      );
    case "runtime_unavailable":
    case "audit_unavailable":
    case "service_overloaded":
      return archiveHttpError(
        503,
        code,
        "Managed session archive is temporarily unavailable.",
        false
      );
    default:
      return archiveHttpError(
        500,
        code,
        code === "storage_error"
          ? "Managed session archive storage is unavailable."
          : "Managed session archive did not complete.",
        false
      );
  }
}

function archiveHttpError(
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
