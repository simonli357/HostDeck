import {
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  type PlanControlSnapshot,
  type PlanSelectionRequest,
  planControlSnapshotSchema,
  planSelectionRequestSchema,
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
  type CodexPlanControlService,
  HostDeckCodexPlanControlError
} from "./codex-plan-control-service.js";
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

export const hostDeckPlanRouteRegistrationId = "selected-plan-control";

export interface HostDeckPlanRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckPlanRouteRegistrationInput {
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly plans: Pick<CodexPlanControlService, "select" | "snapshot">;
  readonly runtime: HostDeckPlanRuntimePort;
  readonly state: Pick<SelectedStateRepository, "get">;
}

type GetState = SelectedStateRepository["get"];
type ReadPlanSnapshot = CodexPlanControlService["snapshot"];
type ReadRuntime = HostDeckPlanRuntimePort["read"];
type SelectPlan = CodexPlanControlService["select"];
type PlanParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedPlanPorts {
  readonly getState: GetState;
  readonly readPlanSnapshot: ReadPlanSnapshot;
  readonly readRuntime: ReadRuntime;
  readonly selectPlan: SelectPlan;
}

interface PlanAdmission {
  readonly target: ManagedSessionTarget;
  readonly target_key: string;
  readonly runtime_key: string;
  readonly runtime_version: string;
}

interface PlanManifestEntries {
  readonly read: SelectedApiRouteManifestEntry;
  readonly select: SelectedApiRouteManifestEntry;
}

interface MaterializedPlanSelection {
  readonly changed: boolean;
  readonly snapshot: PlanControlSnapshot;
}

const registrationInputKeys = ["audit", "csrf", "lock", "plans", "runtime", "state"] as const;
const planPortKeys = ["select", "snapshot"] as const;
const runtimePortKeys = ["read"] as const;
const statePortKeys = ["get"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();

export function createHostDeckPlanRouteRegistration(
  input: CreateHostDeckPlanRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, registrationInputKeys, "HostDeck Plan route input is invalid.");
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parsePlanPorts(values.plans, values.runtime, values.state);
  const manifest = requirePlanManifestEntries();
  const audit = createHostDeckSelectedWriteAuditPort<"plan">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"plan">
  });
  const gate = createHostDeckSelectedWriteGate({
    manifest: manifest.select,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;

  return Object.freeze({
    id: hostDeckPlanRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) throw new TypeError("HostDeck Plan route is already registered.");
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
            response: { 200: planControlSnapshotSchema }
          }
        },
        async (request) => {
          rejectReadBody(request.body, request.headers["content-length"], request.headers["transfer-encoding"]);
          const params = sessionIdParamsSchema.parse(request.params);
          const admitted = resolvePlanAdmission(ports, params.session_id, false);
          const snapshot = await readPlanSnapshot(ports.readPlanSnapshot, admitted.target, request.signal);
          const verified = resolvePlanAdmission(ports, params.session_id, false);
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
            body: planSelectionRequestSchema,
            response: { 200: planControlSnapshotSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            PlanParams,
            PlanSelectionRequest,
            PlanAdmission,
            PlanControlSnapshot,
            PlanControlSnapshot
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Plan route candidate is invalid."
              );
              const body = planSelectionRequestSchema.safeParse(routeCandidate.body);
              const params = sessionIdParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw planHttpError(400, "validation_error", "Plan selection request is invalid.", false);
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "plan",
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  plan_action: body.data.action,
                  expected_revision_present: body.data.expected_pending_revision !== null
                }),
                selector: params.data,
                value: body.data
              });
            },
            resolve_target(mutation) {
              const params = sessionIdParamsSchema.parse(mutation.selector);
              const admitted = resolvePlanAdmission(ports, params.session_id, true);
              return createHostDeckSelectedWriteTargetResolution({
                target: admitted.target,
                capability: "plan",
                value: admitted
              });
            },
            async dispatch(context) {
              const body = planSelectionRequestSchema.parse(context.mutation.value);
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
                const current = resolvePlanAdmission(ports, target.session_id, true);
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return failedTransition(error.code);
                return failedTransition("internal_error");
              }

              let candidate: unknown;
              try {
                candidate = await Reflect.apply(ports.selectPlan, undefined, [
                  {
                    operation_id: body.operation_id,
                    target,
                    kind: "plan",
                    action: body.action,
                    expected_pending_revision: body.expected_pending_revision
                  },
                  request.signal
                ]);
              } catch (error) {
                if (error instanceof HostDeckCodexPlanControlError) {
                  return failedTransition(mapPlanErrorCode(error));
                }
                return incompleteTransition("internal_error");
              }

              let materialized: MaterializedPlanSelection;
              try {
                materialized = materializePlanSelection(candidate, body);
                const current = resolvePlanAdmission(ports, target.session_id, true);
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return incompleteTransition(error.code);
                return incompleteTransition("internal_error");
              }

              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1 as const,
                  changed: materialized.changed
                }),
                response: materialized.snapshot
              });
            },
            prepare_response(candidate) {
              return parsePlanSnapshot(candidate);
            }
          });
          if (result.outcome !== "succeeded") throw publicPlanFailure(result.error_code);
          return reply.code(200).send(result.response);
        }
      );
    }
  });
}

function parsePlanPorts(plansCandidate: unknown, runtimeCandidate: unknown, stateCandidate: unknown): ParsedPlanPorts {
  const plans = readExactDataObject(plansCandidate, planPortKeys, "HostDeck Plan service port is invalid.");
  const runtime = readExactDataObject(runtimeCandidate, runtimePortKeys, "HostDeck Plan runtime port is invalid.");
  const state = readExactDataObject(stateCandidate, statePortKeys, "HostDeck Plan state port is invalid.");
  if (
    typeof plans.select !== "function" ||
    typeof plans.snapshot !== "function" ||
    typeof runtime.read !== "function" ||
    typeof state.get !== "function"
  ) {
    throw new TypeError("HostDeck Plan route ports are invalid.");
  }
  return Object.freeze({
    getState: state.get as GetState,
    readPlanSnapshot: plans.snapshot as ReadPlanSnapshot,
    readRuntime: runtime.read as ReadRuntime,
    selectPlan: plans.select as SelectPlan
  });
}

function requirePlanManifestEntries(): PlanManifestEntries {
  const readMatches = selectedApiRouteManifest.filter((entry) => entry.id === "plan_read");
  const selectMatches = selectedApiRouteManifest.filter((entry) => entry.id === "plan_select");
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
    read.path !== "/api/v1/sessions/:session_id/plan" ||
    read.transport !== "json" ||
    read.request.params !== "session_id_params_v1" ||
    read.request.query !== null ||
    read.request.body !== null ||
    read.response.success !== "plan_control_snapshot_v1" ||
    read.response.error !== "selected_api_error_v1" ||
    read.auth !== "loopback_or_device_cookie" ||
    read.authority !== "session_read" ||
    read.csrf !== "none" ||
    read.lock !== "not_applicable" ||
    read.target !== "managed_session" ||
    read.operation_kind !== "plan" ||
    read.audit !== null ||
    read.credential_effect !== "none" ||
    read.handler !== "controls.readPlan" ||
    read.owner_task !== "IFC-V1-063" ||
    !Object.isFrozen(select) ||
    !Object.isFrozen(select.request) ||
    !Object.isFrozen(select.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    select.family !== "controls" ||
    select.method !== "POST" ||
    select.path !== "/api/v1/sessions/:session_id/plan" ||
    select.transport !== "json" ||
    select.request.params !== "session_id_params_v1" ||
    select.request.query !== null ||
    select.request.body !== "plan_selection_request_v1" ||
    select.response.success !== "plan_control_snapshot_v1" ||
    select.response.error !== "selected_api_error_v1" ||
    select.auth !== "local_admin_or_device_cookie" ||
    select.authority !== "session_write" ||
    select.csrf !== "required_for_device" ||
    select.lock !== "requires_unlocked_host" ||
    select.target !== "managed_session" ||
    select.operation_kind !== "plan" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "plan" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    select.credential_effect !== "none" ||
    select.handler !== "controls.selectPlan" ||
    select.owner_task !== "IFC-V1-063"
  ) {
    throw new TypeError("Selected Plan route manifest entries are invalid.");
  }
  return Object.freeze({ read, select });
}

function resolvePlanAdmission(ports: ParsedPlanPorts, sessionId: string, writable: boolean): PlanAdmission {
  const managed = resolveManagedTarget(ports.getState, sessionId);
  const runtime = resolveRuntime(ports.readRuntime, writable);
  if (managed.runtime_version !== runtime.runtime_version) {
    throw planHttpError(
      409,
      "stale_session",
      "Managed session runtime version requires reconciliation before Plan control.",
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
): Pick<PlanAdmission, "target" | "target_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw planHttpError(500, "storage_error", "Managed session state is unavailable.", true);
  }
  if (candidate === null) throw planHttpError(404, "session_not_found", "Managed session was not found.", false);
  try {
    const state = readExactDataObject(candidate, selectedStateKeys, "Selected Plan state is invalid.");
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
      throw planHttpError(409, "stale_session", "Managed session identity requires reconciliation.", false);
    }
    if (mapping.archived_at !== null || session.session_state === "archived") {
      throw planHttpError(409, "session_not_writable", "Managed session is archived.", false);
    }
    if (mapping.disposition !== "selected" || session.session_state !== "active" || session.freshness !== "current") {
      throw planHttpError(409, "stale_session", "Managed session is not current for Plan control.", false);
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
    throw planHttpError(500, "storage_error", "Managed session state is invalid.", false);
  }
}

function resolveRuntime(
  readRuntime: ReadRuntime,
  writable: boolean
): Pick<PlanAdmission, "runtime_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw planHttpError(503, "runtime_unavailable", "Selected runtime state is unavailable.", true);
  }
  if (candidate === null) throw planHttpError(503, "runtime_unavailable", "Selected runtime is unavailable.", true);
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw planHttpError(500, "internal_error", "Selected runtime compatibility is invalid.", false);
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw planHttpError(503, "runtime_unavailable", "Selected runtime is disconnected.", true);
  }
  const capability = runtime.capabilities.find((entry) => entry.name === "plan");
  if (capability?.state !== "available") {
    throw planHttpError(409, "capability_unavailable", "Structured Plan control is unavailable.", false);
  }
  if (
    (runtime.state !== "ready" && runtime.state !== "degraded") ||
    runtime.observed_version === null ||
    runtime.binding_id === null
  ) {
    throw planHttpError(409, "incompatible_runtime", "Selected runtime cannot provide Plan control.", false);
  }
  if (writable && runtime.mutation_policy !== "allowed") {
    throw planHttpError(409, "incompatible_runtime", "Selected runtime blocks Plan selection.", false);
  }
  return Object.freeze({
    runtime_key: runtimeAdmissionKey(runtime),
    runtime_version: runtime.observed_version
  });
}

async function readPlanSnapshot(
  readSnapshot: ReadPlanSnapshot,
  target: ManagedSessionTarget,
  signal: AbortSignal
): Promise<PlanControlSnapshot> {
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(readSnapshot, undefined, [target, signal]);
  } catch (error) {
    if (error instanceof HostDeckCodexPlanControlError) throw publicPlanFailure(mapPlanErrorCode(error));
    throw planHttpError(500, "internal_error", "Plan state could not be read.", false);
  }
  try {
    return parsePlanSnapshot(candidate);
  } catch {
    throw planHttpError(500, "internal_error", "Plan service returned invalid state.", false);
  }
}

function materializePlanSelection(candidate: unknown, request: PlanSelectionRequest): MaterializedPlanSelection {
  const snapshot = parsePlanSnapshot(candidate);
  const desiredMode = request.action === "enter" ? "plan" : "default";
  if (!snapshot.modes.some((entry) => entry.mode === desiredMode)) {
    throw new TypeError("Plan selection result lost its selected mode.");
  }
  if (snapshot.pending !== null) {
    const pending = snapshot.pending;
    if (
      pending.selection_operation_id !== request.operation_id ||
      pending.mode !== desiredMode ||
      pending.catalog_state !== "available" ||
      pending.phase !== "pending" ||
      pending.turn_id !== null ||
      pending.resolved_settings !== null ||
      pending.error !== null ||
      (request.expected_pending_revision !== null && pending.revision <= request.expected_pending_revision)
    ) {
      throw new TypeError("Plan selection result is contradictory.");
    }
    return Object.freeze({ changed: true, snapshot });
  }
  if (snapshot.current.state !== "confirmed" || snapshot.current.mode !== desiredMode) {
    throw new TypeError("Plan selection result did not preserve pending or confirmed desired state.");
  }
  return Object.freeze({
    changed: request.expected_pending_revision !== null,
    snapshot
  });
}

function requireSameAdmission(expected: PlanAdmission, actual: PlanAdmission, mode: "read" | "write"): void {
  if (
    expected.target.session_id !== actual.target.session_id ||
    expected.target.codex_thread_id !== actual.target.codex_thread_id ||
    expected.target_key !== actual.target_key
  ) {
    throw planHttpError(409, "stale_session", "Managed session identity changed during Plan control.", false);
  }
  if (expected.runtime_version !== actual.runtime_version || expected.runtime_key !== actual.runtime_key) {
    throw planHttpError(409, "incompatible_runtime", `Selected runtime changed during Plan ${mode}.`, false);
  }
}

function runtimeAdmissionKey(runtime: RuntimeCompatibility): string {
  const capability = runtime.capabilities.find((entry) => entry.name === "plan");
  return JSON.stringify([
    runtime.state,
    runtime.mutation_policy,
    runtime.observed_version,
    runtime.binding_id,
    capability?.state ?? null
  ]);
}

function parsePlanSnapshot(candidate: unknown): PlanControlSnapshot {
  const parsed = planControlSnapshotSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Plan snapshot is invalid.");
  const pending = parsed.data.pending;
  return deepFreeze(
    planControlSnapshotSchema.parse({
      ...parsed.data,
      pending:
        pending === null || pending.error === null
          ? pending
          : {
              ...pending,
              error: {
                code: pending.error.code,
                message: planErrorMessage(pending.error.code),
                retryable: pending.error.retryable
              }
            }
    })
  );
}

function mapPlanErrorCode(error: HostDeckCodexPlanControlError): ErrorCode {
  switch (error.code) {
    case "target_not_found":
      return "session_not_found";
    case "target_mismatch":
      return "stale_session";
    case "target_not_writable":
      return error.api_code === "stale_session" ? "stale_session" : "session_not_writable";
    case "capability_unsupported":
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

function publicPlanFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "validation_error":
      return planHttpError(400, code, "Plan selection is invalid for the current state.", true);
    case "session_not_found":
      return planHttpError(404, code, "Managed session was not found.", false);
    case "session_not_writable":
      return planHttpError(409, code, "Managed session cannot provide Plan control.", false);
    case "stale_session":
    case "invalid_session_id":
      return planHttpError(409, "stale_session", "Managed session requires reconciliation before Plan control.", false);
    case "incompatible_runtime":
    case "capability_unavailable":
      return planHttpError(409, code, "Structured Plan control is unavailable for the selected runtime.", false);
    case "operation_conflict":
      return planHttpError(409, code, "Pending Plan state changed or cannot be replaced.", true);
    case "unknown_error":
      return planHttpError(409, code, "Plan selection state is unknown and requires reconciliation.", false);
    case "protocol_error":
      return planHttpError(502, code, "Codex Plan state failed protocol validation.", false);
    case "operation_timeout":
      return planHttpError(504, code, "Plan operation exceeded its request deadline.", false);
    case "runtime_unavailable":
      return planHttpError(503, code, "Codex Plan control is unavailable.", true);
    case "audit_unavailable":
      return planHttpError(503, code, "Plan selection audit is unavailable.", true);
    case "service_overloaded":
      return planHttpError(503, code, "Plan control capacity is exhausted.", true);
    case "storage_error":
      return planHttpError(500, code, "Managed session storage is unavailable.", true);
    case "permission_denied":
      return planHttpError(401, code, "Plan control authority is no longer valid.", false);
    case "read_only":
      return planHttpError(403, code, "Write permission is required to select Plan mode.", false);
    default:
      return planHttpError(500, code, "Plan operation did not complete.", false);
  }
}

function planErrorMessage(code: ErrorCode): string {
  switch (code) {
    case "unknown_error":
      return "Plan selection state is unknown and requires reconciliation.";
    case "operation_conflict":
      return "Plan selection conflicts with observed runtime settings.";
    case "protocol_error":
      return "Codex Plan state failed protocol validation.";
    case "runtime_unavailable":
      return "Codex Plan control is unavailable.";
    default:
      return "Plan selection could not be verified.";
  }
}

function rejectReadBody(body: unknown, contentLength: string | undefined, transferEncoding: string | undefined): void {
  if (
    body !== undefined ||
    transferEncoding !== undefined ||
    (contentLength !== undefined && !/^0+$/u.test(contentLength.trim()))
  ) {
    throw planHttpError(400, "validation_error", "Plan read request cannot contain a body.", false);
  }
}

function planHttpError(status: number, code: ErrorCode, message: string, retryable: boolean): HostDeckHttpError {
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
