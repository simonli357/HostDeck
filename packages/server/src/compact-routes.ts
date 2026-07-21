import {
  type CompactProgressResponse,
  type CompactStartRequest,
  compactProgressResponseSchema,
  compactStartRequestSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedOperationProgress,
  selectedOperationProgressSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { SelectedStateRepository } from "@hostdeck/storage";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  type CodexCompactControlService,
  HostDeckCodexCompactControlError
} from "./codex-compact-control-service.js";
import { assertHostDeckCsrfPolicy, type HostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { requireHostDeckRequestAuthentication } from "./fastify-request-authentication.js";
import { assertHostDeckHostLockPolicy, type HostDeckHostLockPolicy } from "./host-lock-routes.js";
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

export const hostDeckCompactRouteRegistrationId = "selected-compact-control";

export interface HostDeckCompactRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckCompactRouteRegistrationInput {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly compact: Pick<CodexCompactControlService, "compact" | "snapshot">;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly runtime: HostDeckCompactRuntimePort;
  readonly state: Pick<SelectedStateRepository, "get">;
}

type CompactAdmissionMode = "continuity" | "read" | "start";
type CompactParams = z.infer<typeof sessionIdParamsSchema>;
type CompactSnapshot = CodexCompactControlService["snapshot"];
type CompactStart = CodexCompactControlService["compact"];
type GetState = SelectedStateRepository["get"];
type ReadRuntime = HostDeckCompactRuntimePort["read"];

interface ParsedCompactPorts {
  readonly getState: GetState;
  readonly readRuntime: ReadRuntime;
  readonly snapshot: CompactSnapshot;
  readonly start: CompactStart;
}

interface CompactAdmission {
  readonly runtime_key: string;
  readonly runtime_version: string;
  readonly target: ManagedSessionTarget;
  readonly target_key: string;
}

interface CompactManifestEntries {
  readonly read: SelectedApiRouteManifestEntry;
  readonly start: SelectedApiRouteManifestEntry;
}

const registrationInputKeys = ["admission", "audit", "compact", "csrf", "lock", "runtime", "state"] as const;
const compactPortKeys = ["compact", "snapshot"] as const;
const runtimePortKeys = ["read"] as const;
const statePortKeys = ["get"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const terminalTurnStates = new Set(["idle", "completed", "interrupted", "failed"]);
const noQuerySchema = z.object({}).strict();

export function createHostDeckCompactRouteRegistration(
  input: CreateHostDeckCompactRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, registrationInputKeys, "HostDeck compact route input is invalid.");
  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseCompactPorts(values.compact, values.runtime, values.state);
  const manifest = requireCompactManifestEntries();
  const audit = createHostDeckSelectedWriteAuditPort<"compact">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"compact">
  });
  const gate = createHostDeckSelectedWriteGate({
    admission: values.admission,
    manifest: manifest.start,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;

  return Object.freeze({
    id: hostDeckCompactRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) throw new TypeError("HostDeck compact route is already registered.");
      registered = true;

      app.get(
        manifest.read.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async onRequest(request, reply) {
            applyNoStore(reply);
            requireHostDeckRequestAuthentication(request, "loopback_or_device_cookie");
          },
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            response: { 200: compactProgressResponseSchema }
          }
        },
        async (request) => {
          rejectReadBody(request.body, request.headers["content-length"], request.headers["transfer-encoding"]);
          const params = sessionIdParamsSchema.parse(request.params);
          const admitted = resolveCompactAdmission(ports, params.session_id, "read");
          const response = await readCompactSnapshot(ports.snapshot, admitted.target);
          const verified = resolveCompactAdmission(ports, params.session_id, "read");
          requireSameAdmission(admitted, verified, "read");
          return response;
        }
      );

      app.post(
        manifest.start.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            body: compactStartRequestSchema,
            response: { 202: compactProgressResponseSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            CompactParams,
            CompactStartRequest,
            CompactAdmission,
            CompactProgressResponse,
            CompactProgressResponse
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Compact route candidate is invalid."
              );
              const body = compactStartRequestSchema.safeParse(routeCandidate.body);
              const params = sessionIdParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw compactHttpError(400, "validation_error", "Compact start request is invalid.", false);
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "compact",
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
              const admitted = resolveCompactAdmission(ports, params.session_id, "start");
              return createHostDeckSelectedWriteTargetResolution({
                target: admitted.target,
                capability: "compact",
                value: admitted
              });
            },
            async dispatch(context) {
              const body = compactStartRequestSchema.parse(context.mutation.value);
              const target = managedSessionTargetSchema.parse(context.mutation.target);
              if (
                context.accepted_audit === null ||
                context.resolution.target.type !== "managed_session" ||
                context.resolution.target.session_id !== target.session_id ||
                context.resolution.target.codex_thread_id !== target.codex_thread_id
              ) {
                return incompleteTransition("internal_error");
              }

              try {
                const current = resolveCompactAdmission(ports, target.session_id, "start");
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return failedTransition(error.code);
                return failedTransition("internal_error");
              }

              let candidate: unknown;
              try {
                candidate = await Reflect.apply(ports.start, undefined, [
                  {
                    operation_id: body.operation_id,
                    target,
                    kind: "compact",
                    confirm: true
                  },
                  context.deadline
                ]);
              } catch (error) {
                if (error instanceof HostDeckCodexCompactControlError) return compactFailureTransition(error);
                return incompleteTransition("internal_error");
              }

              let response: CompactProgressResponse;
              try {
                response = materializeCompactStart(candidate, body, target);
                const current = resolveCompactAdmission(ports, target.session_id, "continuity");
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return incompleteTransition(error.code);
                return incompleteTransition("internal_error");
              }

              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1 as const,
                  accepted: true as const
                }),
                response
              });
            },
            prepare_response(candidate) {
              return parseCompactResponse(candidate, null);
            }
          });
          if (result.outcome !== "succeeded") throw publicCompactFailure(result.error_code);
          return reply.code(202).send(result.response);
        }
      );
    }
  });
}

function parseCompactPorts(compactCandidate: unknown, runtimeCandidate: unknown, stateCandidate: unknown): ParsedCompactPorts {
  const compact = readExactDataObject(compactCandidate, compactPortKeys, "HostDeck compact service port is invalid.");
  const runtime = readExactDataObject(runtimeCandidate, runtimePortKeys, "HostDeck compact runtime port is invalid.");
  const state = readExactDataObject(stateCandidate, statePortKeys, "HostDeck compact state port is invalid.");
  if (
    typeof compact.compact !== "function" ||
    typeof compact.snapshot !== "function" ||
    typeof runtime.read !== "function" ||
    typeof state.get !== "function"
  ) {
    throw new TypeError("HostDeck compact route ports are invalid.");
  }
  return Object.freeze({
    getState: state.get as GetState,
    readRuntime: runtime.read as ReadRuntime,
    snapshot: compact.snapshot as CompactSnapshot,
    start: compact.compact as CompactStart
  });
}

function requireCompactManifestEntries(): CompactManifestEntries {
  const readMatches = selectedApiRouteManifest.filter((entry) => entry.id === "compact_read");
  const startMatches = selectedApiRouteManifest.filter((entry) => entry.id === "compact_start");
  const read = readMatches[0];
  const start = startMatches[0];
  const audit = start?.audit;
  if (
    readMatches.length !== 1 ||
    startMatches.length !== 1 ||
    read === undefined ||
    start === undefined ||
    !Object.isFrozen(read) ||
    !Object.isFrozen(read.request) ||
    !Object.isFrozen(read.response) ||
    read.family !== "controls" ||
    read.method !== "GET" ||
    read.path !== "/api/v1/sessions/:session_id/compact" ||
    read.transport !== "json" ||
    read.request.params !== "session_id_params_v1" ||
    read.request.query !== null ||
    read.request.body !== null ||
    read.response.success !== "compact_progress_response_v1" ||
    read.response.error !== "selected_api_error_v1" ||
    read.auth !== "loopback_or_device_cookie" ||
    read.authority !== "session_read" ||
    read.csrf !== "none" ||
    read.lock !== "not_applicable" ||
    read.target !== "managed_session" ||
    read.operation_kind !== "compact" ||
    read.audit !== null ||
    read.credential_effect !== "none" ||
    read.handler !== "controls.readCompact" ||
    read.owner_task !== "IFC-V1-064" ||
    !Object.isFrozen(start) ||
    !Object.isFrozen(start.request) ||
    !Object.isFrozen(start.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    start.family !== "controls" ||
    start.method !== "POST" ||
    start.path !== "/api/v1/sessions/:session_id/compact" ||
    start.transport !== "json" ||
    start.request.params !== "session_id_params_v1" ||
    start.request.query !== null ||
    start.request.body !== "compact_start_request_v1" ||
    start.response.success !== "compact_progress_response_v1" ||
    start.response.error !== "selected_api_error_v1" ||
    start.auth !== "local_admin_or_device_cookie" ||
    start.authority !== "session_write" ||
    start.csrf !== "required_for_device" ||
    start.lock !== "requires_unlocked_host" ||
    start.target !== "managed_session" ||
    start.operation_kind !== "compact" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "compact" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    start.credential_effect !== "none" ||
    start.handler !== "controls.startCompact" ||
    start.owner_task !== "IFC-V1-064"
  ) {
    throw new TypeError("Selected compact route manifest entries are invalid.");
  }
  return Object.freeze({ read, start });
}

function resolveCompactAdmission(
  ports: ParsedCompactPorts,
  sessionId: string,
  mode: CompactAdmissionMode
): CompactAdmission {
  const managed = resolveManagedTarget(ports.getState, sessionId, mode === "start");
  const runtime = resolveRuntime(ports.readRuntime, mode !== "read");
  if (managed.runtime_version !== runtime.runtime_version) {
    throw compactHttpError(
      409,
      "stale_session",
      "Managed session runtime version requires reconciliation before compact control.",
      false
    );
  }
  return Object.freeze({
    target: managed.target,
    target_key: managed.target_key,
    runtime_key: runtime.runtime_key,
    runtime_version: runtime.runtime_version
  });
}

function resolveManagedTarget(
  getState: GetState,
  sessionId: string,
  requireStartable: boolean
): Pick<CompactAdmission, "target" | "target_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw compactHttpError(500, "storage_error", "Managed session state is unavailable.", true);
  }
  if (candidate === null) throw compactHttpError(404, "session_not_found", "Managed session was not found.", false);
  try {
    const state = readExactDataObject(candidate, selectedStateKeys, "Selected compact state is invalid.");
    const mapping = selectedSessionMappingRecordSchema.parse(state.mapping);
    const projection = selectedSessionProjectionRecordSchema.parse(state.projection);
    const session = projection.session;
    if (
      mapping.id !== sessionId ||
      session.id !== sessionId ||
      mapping.id !== session.id ||
      mapping.name !== session.name ||
      mapping.codex_thread_id !== session.codex_thread_id ||
      mapping.cwd !== session.cwd ||
      mapping.runtime_source !== session.runtime_source ||
      mapping.runtime_version !== session.runtime_version ||
      mapping.created_at !== session.created_at ||
      mapping.archived_at !== session.archived_at
    ) {
      throw compactHttpError(409, "stale_session", "Managed session identity requires reconciliation.", false);
    }
    if (mapping.archived_at !== null || session.session_state === "archived") {
      throw compactHttpError(409, "session_not_writable", "Managed session is archived.", false);
    }
    if (mapping.disposition !== "selected" || session.session_state !== "active" || session.freshness !== "current") {
      throw compactHttpError(409, "stale_session", "Managed session is not current for compact control.", false);
    }
    if (requireStartable && !terminalTurnStates.has(session.turn_state)) {
      throw compactHttpError(409, "operation_conflict", "Compaction requires a terminal or idle turn state.", true);
    }
    return Object.freeze({
      target: deepFreeze(
        managedSessionTargetSchema.parse({
          type: "managed_session",
          session_id: mapping.id,
          codex_thread_id: mapping.codex_thread_id
        })
      ),
      target_key: JSON.stringify([
        mapping.id,
        mapping.name,
        mapping.codex_thread_id,
        mapping.cwd,
        mapping.runtime_source,
        mapping.runtime_version,
        mapping.created_at,
        mapping.archived_at,
        mapping.disposition,
        session.session_state,
        session.freshness
      ]),
      runtime_version: mapping.runtime_version
    });
  } catch (error) {
    if (error instanceof HostDeckHttpError) throw error;
    throw compactHttpError(500, "storage_error", "Managed session state is invalid.", false);
  }
}

function resolveRuntime(
  readRuntime: ReadRuntime,
  requireMutation: boolean
): Pick<CompactAdmission, "runtime_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw compactHttpError(503, "runtime_unavailable", "Selected runtime state is unavailable.", true);
  }
  if (candidate === null) throw compactHttpError(503, "runtime_unavailable", "Selected runtime is unavailable.", true);
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw compactHttpError(500, "internal_error", "Selected runtime compatibility is invalid.", false);
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw compactHttpError(503, "runtime_unavailable", "Selected runtime is disconnected.", true);
  }
  const capability = runtime.capabilities.find((entry) => entry.name === "compact");
  if (capability?.state !== "available") {
    throw compactHttpError(409, "capability_unavailable", "Structured compact control is unavailable.", false);
  }
  if (
    (runtime.state !== "ready" && runtime.state !== "degraded") ||
    runtime.observed_version === null ||
    runtime.binding_id === null
  ) {
    throw compactHttpError(409, "incompatible_runtime", "Selected runtime cannot provide compact control.", false);
  }
  if (requireMutation && runtime.mutation_policy !== "allowed") {
    throw compactHttpError(409, "incompatible_runtime", "Selected runtime blocks compact start.", false);
  }
  return Object.freeze({
    runtime_key: runtimeAdmissionKey(runtime, requireMutation),
    runtime_version: runtime.observed_version
  });
}

async function readCompactSnapshot(
  snapshot: CompactSnapshot,
  target: ManagedSessionTarget
): Promise<CompactProgressResponse> {
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(snapshot, undefined, [target]);
  } catch (error) {
    if (error instanceof HostDeckCodexCompactControlError) throw publicCompactFailure(mapCompactErrorCode(error));
    throw compactHttpError(500, "internal_error", "Compact progress could not be read.", false);
  }
  try {
    return parseCompactResponse({ progress: candidate }, target);
  } catch {
    throw compactHttpError(500, "internal_error", "Compact service returned invalid progress.", false);
  }
}

function materializeCompactStart(
  candidate: unknown,
  request: CompactStartRequest,
  target: ManagedSessionTarget
): CompactProgressResponse {
  const progress = parseCompactProgress(candidate, target);
  if (
    progress.operation_id !== request.operation_id ||
    progress.state !== "accepted" ||
    progress.turn_id !== null ||
    progress.error !== null
  ) {
    throw new TypeError("Compact start result is contradictory.");
  }
  return deepFreeze(compactProgressResponseSchema.parse({ progress }));
}

function parseCompactResponse(candidate: unknown, target: ManagedSessionTarget | null): CompactProgressResponse {
  const parsed = compactProgressResponseSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Compact progress response is invalid.");
  const progress = parsed.data.progress;
  if (
    progress !== null &&
    target !== null &&
    (progress.target.session_id !== target.session_id || progress.target.codex_thread_id !== target.codex_thread_id)
  ) {
    throw new TypeError("Compact progress response changed the selected target.");
  }
  if (progress === null || progress.error === null) return deepFreeze(parsed.data);
  return deepFreeze(
    compactProgressResponseSchema.parse({
      progress: {
        ...progress,
        error: {
          code: progress.error.code,
          message: compactProgressErrorMessage(progress.error.code),
          retryable: progress.error.retryable
        }
      }
    })
  );
}

function parseCompactProgress(candidate: unknown, target: ManagedSessionTarget): SelectedOperationProgress {
  const parsed = selectedOperationProgressSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.kind !== "compact" ||
    parsed.data.target.type !== "managed_session" ||
    parsed.data.target.session_id !== target.session_id ||
    parsed.data.target.codex_thread_id !== target.codex_thread_id
  ) {
    throw new TypeError("Compact progress is invalid.");
  }
  return deepFreeze(parsed.data);
}

function requireSameAdmission(
  expected: CompactAdmission,
  actual: CompactAdmission,
  mode: "read" | "write"
): void {
  if (
    expected.target.session_id !== actual.target.session_id ||
    expected.target.codex_thread_id !== actual.target.codex_thread_id ||
    expected.target_key !== actual.target_key
  ) {
    throw compactHttpError(409, "stale_session", "Managed session identity changed during compact control.", false);
  }
  if (expected.runtime_version !== actual.runtime_version || expected.runtime_key !== actual.runtime_key) {
    throw compactHttpError(409, "incompatible_runtime", `Selected runtime changed during compact ${mode}.`, false);
  }
}

function runtimeAdmissionKey(runtime: RuntimeCompatibility, includeMutationPolicy: boolean): string {
  const capability = runtime.capabilities.find((entry) => entry.name === "compact");
  return JSON.stringify([
    runtime.state,
    includeMutationPolicy ? runtime.mutation_policy : null,
    runtime.observed_version,
    runtime.binding_id,
    capability?.state ?? null
  ]);
}

function compactFailureTransition(error: HostDeckCodexCompactControlError) {
  const errorCode = mapCompactErrorCode(error);
  return error.outcome === "unknown" ? incompleteTransition(errorCode) : failedTransition(errorCode);
}

function mapCompactErrorCode(error: HostDeckCodexCompactControlError): ErrorCode {
  switch (error.code) {
    case "target_not_found":
      return "session_not_found";
    case "target_mismatch":
    case "target_stale":
      return "stale_session";
    case "target_not_writable":
      return error.api_code === "stale_session" ? "stale_session" : "session_not_writable";
    case "capability_unsupported":
      return "capability_unavailable";
    case "observation_conflict":
    case "runtime_protocol_error":
      return "protocol_error";
    case "operation_conflict":
      return "operation_conflict";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "service_overloaded":
      return "service_overloaded";
    case "state_unavailable":
      return "storage_error";
    case "unknown_outcome":
      return "unknown_error";
    case "operation_timeout":
      return "operation_timeout";
    case "invalid_request":
      return "internal_error";
  }
  return "internal_error";
}

function failedTransition(errorCode: ErrorCode) {
  return Object.freeze({
    outcome: "failed" as const,
    error_code: errorCode,
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function incompleteTransition(errorCode: ErrorCode) {
  return Object.freeze({
    outcome: "incomplete" as const,
    error_code: errorCode,
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function publicCompactFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "validation_error":
      return compactHttpError(400, code, "Compact start request is invalid.", false);
    case "session_not_found":
      return compactHttpError(404, code, "Managed session was not found.", false);
    case "session_not_writable":
      return compactHttpError(409, code, "Managed session cannot provide compact control.", false);
    case "stale_session":
    case "invalid_session_id":
      return compactHttpError(409, "stale_session", "Managed session requires reconciliation before compact control.", false);
    case "incompatible_runtime":
    case "capability_unavailable":
      return compactHttpError(409, code, "Structured compact control is unavailable for the selected runtime.", false);
    case "operation_conflict":
      return compactHttpError(409, code, "Compaction conflicts with the current turn or prior compact state.", true);
    case "unknown_error":
      return compactHttpError(409, code, "Compact start outcome is unknown and requires reconciliation.", false);
    case "protocol_error":
      return compactHttpError(502, code, "Codex compact state failed protocol validation.", false);
    case "operation_timeout":
      return compactHttpError(504, code, "Compact operation exceeded its request deadline.", false);
    case "runtime_unavailable":
      return compactHttpError(503, code, "Codex compact control is unavailable.", true);
    case "audit_unavailable":
      return compactHttpError(503, code, "Compact audit is unavailable.", true);
    case "service_overloaded":
      return compactHttpError(503, code, "Compact control capacity is exhausted.", true);
    case "storage_error":
      return compactHttpError(500, code, "Managed session storage is unavailable.", true);
    case "permission_denied":
      return compactHttpError(401, code, "Compact control authority is no longer valid.", false);
    case "read_only":
      return compactHttpError(403, code, "Write permission is required to start compaction.", false);
    default:
      return compactHttpError(500, code, "Compact operation did not complete.", false);
  }
}

function compactProgressErrorMessage(code: ErrorCode): string {
  switch (code) {
    case "unknown_error":
      return "Compact outcome is unknown and requires reconciliation.";
    case "operation_conflict":
      return "Compact progress conflicts with observed runtime state.";
    case "protocol_error":
      return "Codex compact lifecycle failed protocol validation.";
    case "runtime_unavailable":
      return "Codex compact lifecycle lost runtime continuity.";
    case "session_not_writable":
      return "Managed session became unavailable during compaction.";
    default:
      return "Compact progress could not be verified.";
  }
}

function rejectReadBody(body: unknown, contentLength: string | undefined, transferEncoding: string | undefined): void {
  if (
    body !== undefined ||
    transferEncoding !== undefined ||
    (contentLength !== undefined && !/^0+$/u.test(contentLength.trim()))
  ) {
    throw compactHttpError(400, "validation_error", "Compact read request cannot contain a body.", false);
  }
}

function compactHttpError(status: number, code: ErrorCode, message: string, retryable: boolean): HostDeckHttpError {
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
