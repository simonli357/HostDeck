import {
  deepFreezeExactData, 
  type NativeSessionAdoptRequest,
  type NativeSessionAdoptResponse,
  type NativeSessionDiscoveryRequest,
  type NativeSessionUnmanageRequest,
  type NativeSessionUnmanageResponse,
  nativeCodexThreadTargetSchema,
  nativeSessionAdoptRequestSchema,
  nativeSessionAdoptResponseSchema,
  nativeSessionContractLimits,
  nativeSessionDiscoveryQuerySchema,
  nativeSessionDiscoveryResponseSchema,
  nativeSessionUnmanageRequestSchema,
  nativeSessionUnmanageResponseSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import { HostDeckSelectedStateRepositoryError } from "@hostdeck/storage";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  assertHostDeckCsrfPolicy,
  type HostDeckCsrfPolicy
} from "./csrf-routes.js";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig,
  hostDeckRequestDeadline
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationCurrent,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  assertHostDeckHostHealthService,
  type HostDeckHostHealthService
} from "./host-health.js";
import {
  assertHostDeckHostLockPolicy,
  type HostDeckHostLockPolicy,
  requireHostDeckHostUnlocked
} from "./host-lock-routes.js";
import {
  HostDeckNativeSessionAdministrationError,
  type NativeSessionAdministrationService
} from "./native-session-adoption-service.js";
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
  createHostDeckSelectedWriteUnresolvedMutation,
  type HostDeckSelectedWriteAuditExecute,
  readExactDataObject
} from "./selected-write-gate-contracts.js";

export const hostDeckNativeSessionRouteRegistrationId =
  "selected-native-session-administration";

export interface CreateHostDeckNativeSessionRouteRegistrationInput {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly health: HostDeckHostHealthService;
  readonly lock: HostDeckHostLockPolicy;
  readonly native: Pick<
    NativeSessionAdministrationService,
    "adopt" | "discover" | "unmanage"
  >;
  readonly state: HostDeckNativeSessionStatePort;
}

export interface HostDeckNativeSessionStatePort {
  readonly require: (sessionId: string) => unknown;
}

type AdoptNative = NativeSessionAdministrationService["adopt"];
type DiscoverNative = NativeSessionAdministrationService["discover"];
type UnmanageNative = NativeSessionAdministrationService["unmanage"];
type RequireState = HostDeckNativeSessionStatePort["require"];
type SessionParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedPorts {
  readonly adopt: AdoptNative;
  readonly discover: DiscoverNative;
  readonly requireState: RequireState;
  readonly unmanage: UnmanageNative;
}

const inputKeys = ["admission", "audit", "csrf", "health", "lock", "native", "state"] as const;
const nativePortKeys = ["adopt", "discover", "unmanage"] as const;
const statePortKeys = ["require"] as const;
const unmanageCandidateKeys = ["body", "params"] as const;
const noQuerySchema = z.object({}).strict();

export function createHostDeckNativeSessionRouteRegistration(
  input: CreateHostDeckNativeSessionRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    inputKeys,
    "HostDeck native-session route input is invalid."
  );
  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostHealthService(values.health);
  assertHostDeckHostLockPolicy(values.lock);
  const health = values.health;
  const lock = values.lock;
  const ports = parsePorts(values.native, values.state);
  const manifests = requireNativeSessionManifestEntries();
  const adoptAudit = createHostDeckSelectedWriteAuditPort<"session_adopt">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"session_adopt">
  });
  const unmanageAudit = createHostDeckSelectedWriteAuditPort<"session_unmanage">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"session_unmanage">
  });
  const adoptGate = createHostDeckSelectedWriteGate({
    admission: values.admission,
    audit: adoptAudit,
    csrf: values.csrf,
    lock,
    manifest: manifests.adopt
  });
  const unmanageGate = createHostDeckSelectedWriteGate({
    admission: values.admission,
    audit: unmanageAudit,
    csrf: values.csrf,
    lock,
    manifest: manifests.unmanage
  });
  let registered = false;

  return Object.freeze({
    id: hostDeckNativeSessionRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) {
        throw new TypeError("HostDeck native-session routes are already registered.");
      }
      registered = true;

      app.get(
        manifests.discovery.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            querystring: nativeSessionDiscoveryQuerySchema,
            response: { 200: nativeSessionDiscoveryResponseSchema }
          }
        },
        async (request) => {
          const authentication = requireHostDeckRequestAuthentication(
            request,
            "local_admin"
          );
          requireHostDeckHostUnlocked(lock);
          requireReadyHost(health);
          let response: unknown;
          try {
            response = await Reflect.apply(ports.discover, undefined, [
              request.query as NativeSessionDiscoveryRequest,
              hostDeckRequestDeadline(request)
            ]);
          } catch (error) {
            if (error instanceof HostDeckNativeSessionAdministrationError) {
              throw publicNativeFailure(mapNativeErrorCode(error), "discover");
            }
            throw error;
          }
          assertHostDeckRequestAuthenticationCurrent(request, authentication);
          requireReadyHost(health);
          return deepFreezeExactData(nativeSessionDiscoveryResponseSchema.parse(response));
        }
      );

      app.post(
        manifests.adopt.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            body: nativeSessionAdoptRequestSchema,
            querystring: noQuerySchema,
            response: { 201: nativeSessionAdoptResponseSchema }
          }
        },
        async (request, reply) => {
          const result = await adoptGate.execute<
            NativeSessionAdoptRequest,
            null,
            NativeSessionAdoptResponse,
            NativeSessionAdoptResponse
          >({
            request,
            candidate: request.body,
            parse(candidate) {
              const parsed = nativeSessionAdoptRequestSchema.safeParse(candidate);
              if (!parsed.success) throw invalidRequest("Native session adoption request is invalid.");
              return createHostDeckSelectedWriteMutation({
                operation_id: parsed.data.operation_id,
                action: "session_adopt",
                target: nativeCodexThreadTargetSchema.parse({
                  type: "native_codex_thread",
                  codex_thread_id: parsed.data.thread_id
                }),
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  handoff_confirmed: true as const,
                  name_length: parsed.data.name.length
                }),
                value: parsed.data
              });
            },
            resolve_target(mutation) {
              return createHostDeckSelectedWriteTargetResolution({
                target: mutation.target,
                capability: "thread_lifecycle",
                value: null
              });
            },
            async dispatch(context) {
              const body = nativeSessionAdoptRequestSchema.parse(context.mutation.value);
              let adopted: unknown;
              try {
                adopted = await Reflect.apply(ports.adopt, undefined, [
                  body,
                  context.deadline
                ]);
              } catch (error) {
                if (!(error instanceof HostDeckNativeSessionAdministrationError)) throw error;
                return nativeFailureTransition(error, "session_adopt");
              }
              try {
                const prepared = adoptionResponse(adopted, body);
                return Object.freeze({
                  outcome: "succeeded" as const,
                  payload_summary: Object.freeze({
                    schema_version: 1 as const,
                    history_turn_count: prepared.historyTurnCount,
                    adopted: true as const
                  }),
                  response: prepared.response
                });
              } catch {
                return Object.freeze({
                  outcome: "incomplete" as const,
                  error_code: "internal_error" as const,
                  payload_summary: Object.freeze({
                    schema_version: 1 as const,
                    activation_pending: true as const
                  })
                });
              }
            },
            prepare_response(candidate) {
              return deepFreezeExactData(nativeSessionAdoptResponseSchema.parse(candidate));
            }
          });
          if (result.outcome !== "succeeded") throw publicNativeFailure(result.error_code, "adopt");
          return reply.code(201).send(result.response);
        }
      );

      app.post(
        manifests.unmanage.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            body: nativeSessionUnmanageRequestSchema,
            response: { 200: nativeSessionUnmanageResponseSchema }
          }
        },
        async (request) => {
          const result = await unmanageGate.executeUnresolved<
            SessionParams,
            NativeSessionUnmanageRequest,
            null,
            NativeSessionUnmanageResponse,
            NativeSessionUnmanageResponse
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const route = readExactDataObject(
                candidate,
                unmanageCandidateKeys,
                "Native session unmanage request is invalid."
              );
              const body = nativeSessionUnmanageRequestSchema.safeParse(route.body);
              const params = sessionIdParamsSchema.safeParse(route.params);
              if (!body.success || !params.success) {
                throw invalidRequest("Native session unmanage request is invalid.");
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "session_unmanage",
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  confirm: true as const
                }),
                selector: params.data,
                value: body.data
              });
            },
            resolve_target(mutation) {
              const params = sessionIdParamsSchema.parse(mutation.selector);
              return createHostDeckSelectedWriteTargetResolution({
                target: resolveManagedTarget(ports.requireState, params.session_id),
                capability: null,
                value: null
              });
            },
            async dispatch(context) {
              const body = nativeSessionUnmanageRequestSchema.parse(context.mutation.value);
              if (context.mutation.target.type !== "managed_session") {
                throw new TypeError("Native session unmanage target is contradictory.");
              }
              let response: unknown;
              try {
                response = await Reflect.apply(ports.unmanage, undefined, [
                  context.mutation.target.session_id,
                  body,
                  context.deadline
                ]);
              } catch (error) {
                if (!(error instanceof HostDeckNativeSessionAdministrationError)) throw error;
                return nativeFailureTransition(error, "session_unmanage");
              }
              const parsed = nativeSessionUnmanageResponseSchema.safeParse(response);
              if (
                !parsed.success ||
                parsed.data.operation_id !== body.operation_id ||
                parsed.data.session_id !== context.mutation.target.session_id ||
                parsed.data.codex_thread_id !== context.mutation.target.codex_thread_id
              ) {
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
                  unmanaged: true as const
                }),
                response: deepFreezeExactData(parsed.data)
              });
            },
            prepare_response(candidate) {
              return deepFreezeExactData(nativeSessionUnmanageResponseSchema.parse(candidate));
            }
          });
          if (result.outcome !== "succeeded") {
            throw publicNativeFailure(result.error_code, "unmanage");
          }
          return result.response;
        }
      );
    }
  });
}

function parsePorts(nativeCandidate: unknown, stateCandidate: unknown): ParsedPorts {
  const native = readExactDataObject(
    nativeCandidate,
    nativePortKeys,
    "HostDeck native-session administration port is invalid."
  );
  const state = readExactDataObject(
    stateCandidate,
    statePortKeys,
    "HostDeck native-session state port is invalid."
  );
  if (
    typeof native.adopt !== "function" ||
    typeof native.discover !== "function" ||
    typeof native.unmanage !== "function" ||
    typeof state.require !== "function"
  ) {
    throw new TypeError("HostDeck native-session route ports are invalid.");
  }
  return Object.freeze({
    adopt: native.adopt as AdoptNative,
    discover: native.discover as DiscoverNative,
    requireState: state.require as RequireState,
    unmanage: native.unmanage as UnmanageNative
  });
}

function requireNativeSessionManifestEntries(): Readonly<{
  discovery: SelectedApiRouteManifestEntry;
  adopt: SelectedApiRouteManifestEntry;
  unmanage: SelectedApiRouteManifestEntry;
}> {
  const discovery = requireManifest("native_session_discovery");
  const adopt = requireManifest("native_session_adopt");
  const unmanage = requireManifest("native_session_unmanage");
  if (
    discovery.method !== "GET" ||
    discovery.path !== "/api/v1/native-sessions" ||
    discovery.request.query !== "native_session_discovery_query_v1" ||
    discovery.request.params !== null ||
    discovery.request.body !== null ||
    discovery.response.success !== "native_session_discovery_response_v1" ||
    discovery.target !== "none" ||
    discovery.audit !== null ||
    adopt.method !== "POST" ||
    adopt.path !== "/api/v1/native-sessions" ||
    adopt.request.params !== null ||
    adopt.request.query !== null ||
    adopt.request.body !== "native_session_adopt_request_v1" ||
    adopt.response.success !== "native_session_adopt_response_v1" ||
    adopt.target !== "native_codex_thread" ||
    adopt.audit?.action !== "session_adopt" ||
    unmanage.method !== "POST" ||
    unmanage.path !== "/api/v1/sessions/:session_id/unmanage" ||
    unmanage.request.params !== "session_id_params_v1" ||
    unmanage.request.query !== null ||
    unmanage.request.body !== "native_session_unmanage_request_v1" ||
    unmanage.response.success !== "native_session_unmanage_response_v1" ||
    unmanage.target !== "managed_session" ||
    unmanage.audit?.action !== "session_unmanage"
  ) {
    throw new TypeError("Selected native-session route manifest entries are invalid.");
  }
  for (const entry of [discovery, adopt, unmanage]) {
    if (
      entry.family !== "sessions" ||
      entry.transport !== "json" ||
      entry.response.error !== "selected_api_error_v1" ||
      entry.auth !== "local_admin" ||
      entry.authority !== "local_admin" ||
      entry.csrf !== "none" ||
      entry.lock !== "requires_unlocked_host" ||
      entry.operation_kind !== null ||
      entry.credential_effect !== "none" ||
      entry.owner_task !== "IFC-V1-110"
    ) {
      throw new TypeError("Selected native-session route manifest policy is invalid.");
    }
  }
  return Object.freeze({ discovery, adopt, unmanage });
}

function requireManifest(id: string): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response)
  ) {
    throw new TypeError(`Selected native-session manifest entry ${id} is invalid.`);
  }
  return entry;
}

function requireReadyHost(health: HostDeckHostHealthService): void {
  const snapshot = health.localSnapshot();
  if (snapshot.readiness !== "ready" || snapshot.mutation_admission !== "open") {
    throw new HostDeckHttpError({
      status: 503,
      code: "runtime_unavailable",
      message: "Native session administration requires a ready HostDeck host.",
      retryable: true
    });
  }
}

function resolveManagedTarget(requireState: RequireState, sessionId: string) {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(requireState, undefined, [sessionId]);
  } catch (error) {
    if (error instanceof HostDeckHttpError) throw error;
    if (error instanceof HostDeckSelectedStateRepositoryError) {
      throw publicNativeFailure(
        error.code === "session_not_found" ? "session_not_found" : "storage_error",
        "unmanage"
      );
    }
    throw error;
  }
  const values = readExactDataObject(
    candidate,
    ["mapping", "projection"],
    "Native session unmanage state is invalid."
  );
  const mapping = selectedSessionMappingRecordSchema.parse(values.mapping);
  const projection = selectedSessionProjectionRecordSchema.parse(values.projection);
  if (
    mapping.id !== sessionId ||
    projection.session.id !== sessionId ||
    mapping.codex_thread_id !== projection.session.codex_thread_id ||
    mapping.disposition !== "selected" ||
    mapping.archived_at !== null
  ) {
    throw new TypeError("Native session unmanage target state is contradictory.");
  }
  return Object.freeze({
    type: "managed_session" as const,
    session_id: mapping.id,
    codex_thread_id: mapping.codex_thread_id
  });
}

function adoptionResponse(
  candidate: unknown,
  request: NativeSessionAdoptRequest
): Readonly<{ historyTurnCount: number; response: NativeSessionAdoptResponse }> {
  const result = readExactDataObject(
    candidate,
    ["history_turn_count", "state"],
    "Native session adoption result is invalid."
  );
  const count = result.history_turn_count;
  if (
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    (count as number) > nativeSessionContractLimits.historyTurns
  ) {
    throw new TypeError("Native session adoption history count is invalid.");
  }
  const state = readExactDataObject(
    result.state,
    ["mapping", "projection"],
    "Native session adoption state is invalid."
  );
  const mapping = selectedSessionMappingRecordSchema.parse(state.mapping);
  const projection = selectedSessionProjectionRecordSchema.parse(state.projection);
  if (
    mapping.id !== projection.session.id ||
    mapping.name !== request.name ||
    mapping.codex_thread_id !== request.thread_id ||
    mapping.codex_thread_id !== projection.session.codex_thread_id ||
    mapping.disposition !== "selected" ||
    mapping.archived_at !== null ||
    projection.session.session_state === "archived"
  ) {
    throw new TypeError("Native session adoption identity is contradictory.");
  }
  return Object.freeze({
    historyTurnCount: count as number,
    response: deepFreezeExactData(
      nativeSessionAdoptResponseSchema.parse({
        operation_id: request.operation_id,
        session: projection.session
      })
    )
  });
}

function nativeFailureTransition(
  error: HostDeckNativeSessionAdministrationError,
  action: "session_adopt" | "session_unmanage"
) {
  const incomplete = error.outcome !== "not_sent";
  return Object.freeze({
    outcome: incomplete ? ("incomplete" as const) : ("failed" as const),
    error_code: mapNativeErrorCode(error),
    payload_summary:
      action === "session_adopt" && incomplete
        ? Object.freeze({ schema_version: 1 as const, activation_pending: true as const })
        : Object.freeze({ schema_version: 1 as const })
  });
}

function mapNativeErrorCode(error: HostDeckNativeSessionAdministrationError): ErrorCode {
  switch (error.code) {
    case "duplicate_session_name":
      return "duplicate_session_name";
    case "operation_timeout":
      return "operation_timeout";
    case "protocol_error":
      return "protocol_error";
    case "recovery_required":
      return "stale_session";
    case "runtime_incompatible":
      return "incompatible_runtime";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "session_not_found":
      return "session_not_found";
    case "session_not_quiet":
      return "session_not_writable";
    case "storage_error":
      return "storage_error";
    case "identity_mismatch":
    case "invalid_request":
    case "session_not_adopted":
    case "thread_already_managed":
    case "thread_conflict":
    case "thread_ineligible":
      return "operation_conflict";
  }
}

function publicNativeFailure(
  code: ErrorCode,
  action: "adopt" | "discover" | "unmanage"
): HostDeckHttpError {
  const noun =
    action === "adopt"
      ? "adoption"
      : action === "discover"
        ? "discovery"
        : "unmanage";
  switch (code) {
    case "duplicate_session_name":
      return failure(409, code, "A managed session with this name already exists.");
    case "session_not_found":
      return failure(404, code, "Managed session does not exist.");
    case "session_not_writable":
      return failure(409, code, "Managed session must be quiet before it can be unmanaged.");
    case "stale_session":
      return failure(
        409,
        code,
        "The native session was adopted but activation requires reconciliation. Do not retry adoption."
      );
    case "incompatible_runtime":
      return failure(409, code, `Native session ${noun} requires a compatible Codex runtime.`);
    case "operation_conflict":
      return failure(409, code, `Native session ${noun} conflicts with current session state.`);
    case "operation_timeout":
      return failure(504, code, `Native session ${noun} exceeded its request deadline.`);
    case "runtime_unavailable":
    case "service_overloaded":
    case "audit_unavailable":
      return failure(503, code, `Native session ${noun} is temporarily unavailable.`);
    case "permission_denied":
    case "read_only":
    case "invalid_origin":
    case "insecure_transport":
      return failure(403, code, `Native session ${noun} requires local CLI authority.`);
    case "protocol_error":
      return failure(502, code, `Codex rejected the native session ${noun} protocol.`);
    default:
      return failure(
        500,
        code,
        code === "storage_error"
          ? `Native session ${noun} storage is unavailable.`
          : `Native session ${noun} did not complete.`
      );
  }
}

function invalidRequest(message: string): HostDeckHttpError {
  return new HostDeckHttpError({
    status: 400,
    code: "validation_error",
    message,
    retryable: false
  });
}

function failure(status: number, code: ErrorCode, message: string): HostDeckHttpError {
  return new HostDeckHttpError({ status, code, message, retryable: false });
}

function applyNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

