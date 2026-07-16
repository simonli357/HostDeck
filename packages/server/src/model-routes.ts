import {
  type ManagedSessionTarget,
  type ModelControlSnapshot,
  type ModelSelectionRequest,
  managedSessionTargetSchema,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { SelectedStateRepository } from "@hostdeck/storage";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  type CodexModelControlService,
  HostDeckCodexModelControlError
} from "./codex-model-control-service.js";
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

export const hostDeckModelRouteRegistrationId = "selected-model-control";

export interface HostDeckModelRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckModelRouteRegistrationInput {
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly models: Pick<CodexModelControlService, "select" | "snapshot">;
  readonly runtime: HostDeckModelRuntimePort;
  readonly state: Pick<SelectedStateRepository, "get">;
}

type GetState = SelectedStateRepository["get"];
type ReadModelSnapshot = CodexModelControlService["snapshot"];
type SelectModel = CodexModelControlService["select"];
type ReadRuntime = HostDeckModelRuntimePort["read"];
type ModelParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedModelPorts {
  readonly getState: GetState;
  readonly readModelSnapshot: ReadModelSnapshot;
  readonly readRuntime: ReadRuntime;
  readonly selectModel: SelectModel;
}

interface ModelAdmission {
  readonly target: ManagedSessionTarget;
  readonly target_key: string;
  readonly runtime_key: string;
  readonly runtime_version: string;
}

interface ModelManifestEntries {
  readonly read: SelectedApiRouteManifestEntry;
  readonly select: SelectedApiRouteManifestEntry;
}

const registrationInputKeys = ["audit", "csrf", "lock", "models", "runtime", "state"] as const;
const modelPortKeys = ["select", "snapshot"] as const;
const runtimePortKeys = ["read"] as const;
const statePortKeys = ["get"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();

export function createHostDeckModelRouteRegistration(
  input: CreateHostDeckModelRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, registrationInputKeys, "HostDeck model route input is invalid.");
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseModelPorts(values.models, values.runtime, values.state);
  const manifest = requireModelManifestEntries();
  const audit = createHostDeckSelectedWriteAuditPort<"model">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"model">
  });
  const gate = createHostDeckSelectedWriteGate({
    manifest: manifest.select,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;

  return Object.freeze({
    id: hostDeckModelRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) throw new TypeError("HostDeck model route is already registered.");
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
            response: { 200: modelControlSnapshotSchema }
          }
        },
        async (request) => {
          const contentLength = request.headers["content-length"];
          if (
            request.body !== undefined ||
            request.headers["transfer-encoding"] !== undefined ||
            (contentLength !== undefined && !/^0+$/u.test(contentLength.trim()))
          ) {
            throw modelHttpError(400, "validation_error", "Model read request cannot contain a body.", false);
          }
          const params = sessionIdParamsSchema.parse(request.params);
          const admitted = resolveModelAdmission(ports, params.session_id, false);
          const snapshot = await readModelSnapshot(ports.readModelSnapshot, admitted.target, request.signal);
          const verified = resolveModelAdmission(ports, params.session_id, false);
          requireSameAdmission(admitted, verified, "read");
          return snapshot;
        }
      );

      app.post(
        manifest.select.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            body: modelSelectionRequestSchema,
            response: { 200: modelControlSnapshotSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            ModelParams,
            ModelSelectionRequest,
            ModelAdmission,
            ModelControlSnapshot,
            ModelControlSnapshot
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Model route candidate is invalid."
              );
              const body = modelSelectionRequestSchema.safeParse(routeCandidate.body);
              const params = sessionIdParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw modelHttpError(400, "validation_error", "Model selection request is invalid.", false);
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "model",
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  model_id: body.data.model_id,
                  reasoning_effort: body.data.reasoning_effort,
                  expected_revision_present: body.data.expected_pending_revision !== null
                }),
                selector: params.data,
                value: body.data
              });
            },
            resolve_target(mutation) {
              const params = sessionIdParamsSchema.parse(mutation.selector);
              const admitted = resolveModelAdmission(ports, params.session_id, true);
              return createHostDeckSelectedWriteTargetResolution({
                target: admitted.target,
                capability: "model",
                value: admitted
              });
            },
            async dispatch(context) {
              const body = modelSelectionRequestSchema.parse(context.mutation.value);
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
                const current = resolveModelAdmission(ports, target.session_id, true);
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return failedTransition(error.code);
                return incompleteTransition("internal_error");
              }

              let candidate: unknown;
              try {
                candidate = await Reflect.apply(ports.selectModel, undefined, [
                  {
                    operation_id: body.operation_id,
                    target,
                    kind: "model",
                    model_id: body.model_id,
                    reasoning_effort: body.reasoning_effort,
                    expected_pending_revision: body.expected_pending_revision
                  },
                  request.signal
                ]);
              } catch (error) {
                if (error instanceof HostDeckCodexModelControlError) {
                  return failedTransition(mapModelErrorCode(error));
                }
                return incompleteTransition("internal_error");
              }

              let snapshot: ModelControlSnapshot;
              let changed: boolean;
              try {
                snapshot = parseModelSnapshot(candidate);
                changed = selectionChanged(snapshot, body);
                const current = resolveModelAdmission(ports, target.session_id, true);
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return incompleteTransition(error.code);
                return incompleteTransition("internal_error");
              }

              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1 as const,
                  changed
                }),
                response: snapshot
              });
            },
            prepare_response(candidate) {
              return parseModelSnapshot(candidate);
            }
          });
          if (result.outcome !== "succeeded") throw publicModelFailure(result.error_code);
          return reply.code(200).send(result.response);
        }
      );
    }
  });
}

function parseModelPorts(modelsCandidate: unknown, runtimeCandidate: unknown, stateCandidate: unknown): ParsedModelPorts {
  const models = readExactDataObject(modelsCandidate, modelPortKeys, "HostDeck model service port is invalid.");
  const runtime = readExactDataObject(runtimeCandidate, runtimePortKeys, "HostDeck model runtime port is invalid.");
  const state = readExactDataObject(stateCandidate, statePortKeys, "HostDeck model state port is invalid.");
  if (
    typeof models.select !== "function" ||
    typeof models.snapshot !== "function" ||
    typeof runtime.read !== "function" ||
    typeof state.get !== "function"
  ) {
    throw new TypeError("HostDeck model route ports are invalid.");
  }
  return Object.freeze({
    getState: state.get as GetState,
    readModelSnapshot: models.snapshot as ReadModelSnapshot,
    readRuntime: runtime.read as ReadRuntime,
    selectModel: models.select as SelectModel
  });
}

function requireModelManifestEntries(): ModelManifestEntries {
  const readMatches = selectedApiRouteManifest.filter((entry) => entry.id === "model_read");
  const selectMatches = selectedApiRouteManifest.filter((entry) => entry.id === "model_select");
  const read = readMatches[0];
  const select = selectMatches[0];
  const audit = select?.audit;
  if (
    readMatches.length !== 1 ||
    selectMatches.length !== 1 ||
    read === undefined ||
    select === undefined ||
    !Object.isFrozen(read) ||
    !Object.isFrozen(read.request) ||
    !Object.isFrozen(read.response) ||
    read.family !== "controls" ||
    read.method !== "GET" ||
    read.path !== "/api/v1/sessions/:session_id/model" ||
    read.transport !== "json" ||
    read.request.params !== "session_id_params_v1" ||
    read.request.query !== null ||
    read.request.body !== null ||
    read.response.success !== "model_control_snapshot_v1" ||
    read.response.error !== "selected_api_error_v1" ||
    read.auth !== "loopback_or_device_cookie" ||
    read.authority !== "session_read" ||
    read.csrf !== "none" ||
    read.lock !== "not_applicable" ||
    read.target !== "managed_session" ||
    read.operation_kind !== "model" ||
    read.audit !== null ||
    read.credential_effect !== "none" ||
    read.handler !== "controls.readModel" ||
    read.owner_task !== "IFC-V1-042" ||
    !Object.isFrozen(select) ||
    !Object.isFrozen(select.request) ||
    !Object.isFrozen(select.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    select.family !== "controls" ||
    select.method !== "POST" ||
    select.path !== "/api/v1/sessions/:session_id/model" ||
    select.transport !== "json" ||
    select.request.params !== "session_id_params_v1" ||
    select.request.query !== null ||
    select.request.body !== "model_selection_request_v1" ||
    select.response.success !== "model_control_snapshot_v1" ||
    select.response.error !== "selected_api_error_v1" ||
    select.auth !== "local_admin_or_device_cookie" ||
    select.authority !== "session_write" ||
    select.csrf !== "required_for_device" ||
    select.lock !== "requires_unlocked_host" ||
    select.target !== "managed_session" ||
    select.operation_kind !== "model" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "model" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    select.credential_effect !== "none" ||
    select.handler !== "controls.selectModel" ||
    select.owner_task !== "IFC-V1-042"
  ) {
    throw new TypeError("Selected model route manifest entries are invalid.");
  }
  return Object.freeze({ read, select });
}

function resolveModelAdmission(ports: ParsedModelPorts, sessionId: string, writable: boolean): ModelAdmission {
  const managed = resolveManagedTarget(ports.getState, sessionId);
  const runtime = resolveRuntime(ports.readRuntime, writable);
  if (managed.runtime_version !== runtime.runtime_version) {
    throw modelHttpError(
      409,
      "stale_session",
      "Managed session runtime version requires reconciliation before model control.",
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
  sessionId: string
): Pick<ModelAdmission, "target" | "target_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw modelHttpError(500, "storage_error", "Managed session state is unavailable.", true);
  }
  if (candidate === null) {
    throw modelHttpError(404, "session_not_found", "Managed session was not found.", false);
  }
  try {
    const state = readExactDataObject(candidate, selectedStateKeys, "Selected model state is invalid.");
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
      throw modelHttpError(409, "stale_session", "Managed session identity requires reconciliation.", false);
    }
    if (mapping.archived_at !== null || session.session_state === "archived") {
      throw modelHttpError(409, "session_not_writable", "Managed session is archived.", false);
    }
    if (mapping.disposition !== "selected" || session.session_state !== "active" || session.freshness !== "current") {
      throw modelHttpError(409, "stale_session", "Managed session is not current for model control.", false);
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
    throw modelHttpError(500, "storage_error", "Managed session state is invalid.", false);
  }
}

function resolveRuntime(
  readRuntime: ReadRuntime,
  writable: boolean
): Pick<ModelAdmission, "runtime_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw modelHttpError(503, "runtime_unavailable", "Selected runtime state is unavailable.", true);
  }
  if (candidate === null) {
    throw modelHttpError(503, "runtime_unavailable", "Selected runtime is unavailable.", true);
  }
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw modelHttpError(500, "internal_error", "Selected runtime compatibility is invalid.", false);
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw modelHttpError(503, "runtime_unavailable", "Selected runtime is disconnected.", true);
  }
  const capability = runtime.capabilities.find((entry) => entry.name === "model");
  if (capability?.state !== "available") {
    throw modelHttpError(409, "capability_unavailable", "Structured model control is unavailable.", false);
  }
  if (
    (runtime.state !== "ready" && runtime.state !== "degraded") ||
    runtime.observed_version === null ||
    runtime.binding_id === null
  ) {
    throw modelHttpError(409, "incompatible_runtime", "Selected runtime cannot provide model control.", false);
  }
  if (writable && runtime.mutation_policy !== "allowed") {
    throw modelHttpError(409, "incompatible_runtime", "Selected runtime blocks model selection.", false);
  }
  return Object.freeze({
    runtime_key: runtimeAdmissionKey(runtime),
    runtime_version: runtime.observed_version
  });
}

async function readModelSnapshot(
  readSnapshot: ReadModelSnapshot,
  target: ManagedSessionTarget,
  signal: AbortSignal
): Promise<ModelControlSnapshot> {
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(readSnapshot, undefined, [target, signal]);
  } catch (error) {
    if (error instanceof HostDeckCodexModelControlError) throw publicModelFailure(mapModelErrorCode(error));
    throw modelHttpError(500, "internal_error", "Model state could not be read.", false);
  }
  try {
    return parseModelSnapshot(candidate);
  } catch {
    throw modelHttpError(500, "internal_error", "Model service returned invalid state.", false);
  }
}

function selectionChanged(snapshot: ModelControlSnapshot, request: ModelSelectionRequest): boolean {
  const model = snapshot.models.find((candidate) => candidate.id === request.model_id);
  const defaultEffort = model?.reasoning_efforts.find((candidate) => candidate.is_default);
  const resolvedEffort = request.reasoning_effort ?? defaultEffort?.id;
  if (model === undefined || resolvedEffort === undefined) throw new TypeError("Selected model response lost its catalog choice.");

  if (snapshot.pending !== null) {
    if (
      snapshot.pending.selection_operation_id !== request.operation_id ||
      snapshot.pending.model_id !== request.model_id ||
      snapshot.pending.runtime_model !== model.runtime_model ||
      snapshot.pending.reasoning_effort !== resolvedEffort ||
      snapshot.pending.catalog_state !== "available" ||
      snapshot.pending.phase !== "pending" ||
      snapshot.pending.turn_id !== null ||
      snapshot.pending.error !== null ||
      (request.expected_pending_revision !== null &&
        snapshot.pending.revision <= request.expected_pending_revision)
    ) {
      throw new TypeError("Selected model response contradicts the requested pending state.");
    }
    return true;
  }

  if (
    snapshot.current.catalog_state !== "available" ||
    snapshot.current.model_id !== request.model_id ||
    snapshot.current.runtime_model !== model.runtime_model ||
    snapshot.current.reasoning_effort !== resolvedEffort
  ) {
    throw new TypeError("Selected model response contradicts the requested current state.");
  }
  return request.expected_pending_revision !== null;
}

function requireSameAdmission(expected: ModelAdmission, actual: ModelAdmission, mode: "read" | "write"): void {
  if (
    expected.target.session_id !== actual.target.session_id ||
    expected.target.codex_thread_id !== actual.target.codex_thread_id ||
    expected.target_key !== actual.target_key
  ) {
    throw modelHttpError(409, "stale_session", "Managed session identity changed during model control.", false);
  }
  if (expected.runtime_version !== actual.runtime_version || expected.runtime_key !== actual.runtime_key) {
    throw modelHttpError(
      409,
      "incompatible_runtime",
      `Selected runtime changed during model ${mode}.`,
      false
    );
  }
}

function runtimeAdmissionKey(runtime: RuntimeCompatibility): string {
  const capability = runtime.capabilities.find((entry) => entry.name === "model");
  return JSON.stringify([
    runtime.state,
    runtime.mutation_policy,
    runtime.observed_version,
    runtime.binding_id,
    capability?.state ?? null
  ]);
}

function parseModelSnapshot(candidate: unknown): ModelControlSnapshot {
  const parsed = modelControlSnapshotSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Model snapshot is invalid.");
  return deepFreeze(parsed.data);
}

function mapModelErrorCode(error: HostDeckCodexModelControlError): ErrorCode {
  switch (error.code) {
    case "target_not_found":
      return "session_not_found";
    case "target_mismatch":
      return "stale_session";
    case "target_not_writable":
      return error.api_code === "stale_session" ? "stale_session" : "session_not_writable";
    case "capability_unsupported":
      return "capability_unavailable";
    case "model_unknown":
      return "validation_error";
    case "effort_unsupported":
      return "capability_unavailable";
    case "operation_conflict":
      return "operation_conflict";
    case "runtime_protocol_error":
      return "protocol_error";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "service_overloaded":
      return "service_overloaded";
    case "unknown_outcome":
      return "unknown_error";
    case "invalid_request":
      return "internal_error";
  }
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

function publicModelFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "validation_error":
      return modelHttpError(400, code, "Requested model is absent from the live catalog.", true);
    case "session_not_found":
      return modelHttpError(404, code, "Managed session was not found.", false);
    case "session_not_writable":
      return modelHttpError(409, code, "Managed session cannot provide model control.", false);
    case "stale_session":
    case "invalid_session_id":
      return modelHttpError(409, "stale_session", "Managed session requires reconciliation before model control.", false);
    case "incompatible_runtime":
    case "capability_unavailable":
      return modelHttpError(409, code, "Structured model control is unavailable for the selected runtime.", false);
    case "operation_conflict":
      return modelHttpError(409, code, "Pending model state changed or cannot be replaced.", true);
    case "unknown_error":
      return modelHttpError(409, code, "Model selection state is unknown and requires reconciliation.", false);
    case "protocol_error":
      return modelHttpError(502, code, "Codex model state failed protocol validation.", false);
    case "operation_timeout":
      return modelHttpError(504, code, "Model operation exceeded its request deadline.", false);
    case "runtime_unavailable":
      return modelHttpError(503, code, "Codex model control is unavailable.", true);
    case "audit_unavailable":
      return modelHttpError(503, code, "Model selection audit is unavailable.", true);
    case "service_overloaded":
      return modelHttpError(503, code, "Model control capacity is exhausted.", true);
    case "storage_error":
      return modelHttpError(500, code, "Managed session storage is unavailable.", true);
    case "permission_denied":
      return modelHttpError(401, code, "Model control authority is no longer valid.", false);
    case "read_only":
      return modelHttpError(403, code, "Write permission is required to select a model.", false);
    default:
      return modelHttpError(500, code, "Model operation did not complete.", false);
  }
}

function modelHttpError(status: number, code: ErrorCode, message: string, retryable: boolean): HostDeckHttpError {
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
