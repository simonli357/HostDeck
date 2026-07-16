import {
  type GoalControlSnapshot,
  type GoalMutationRequest,
  goalControlSnapshotSchema,
  goalControlValueSchema,
  goalMutationRequestSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
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
  type CodexGoalControlService,
  type CodexGoalMutationResult,
  HostDeckCodexGoalControlError
} from "./codex-goal-control-service.js";
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

export const hostDeckGoalRouteRegistrationId = "selected-goal-control";

export interface HostDeckGoalRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckGoalRouteRegistrationInput {
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly goals: Pick<CodexGoalControlService, "mutate" | "snapshot">;
  readonly lock: HostDeckHostLockPolicy;
  readonly runtime: HostDeckGoalRuntimePort;
  readonly state: Pick<SelectedStateRepository, "get">;
}

type GetState = SelectedStateRepository["get"];
type MutateGoal = CodexGoalControlService["mutate"];
type ReadGoalSnapshot = CodexGoalControlService["snapshot"];
type ReadRuntime = HostDeckGoalRuntimePort["read"];
type GoalParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedGoalPorts {
  readonly getState: GetState;
  readonly mutateGoal: MutateGoal;
  readonly readGoalSnapshot: ReadGoalSnapshot;
  readonly readRuntime: ReadRuntime;
}

interface GoalAdmission {
  readonly target: ManagedSessionTarget;
  readonly target_key: string;
  readonly runtime_key: string;
  readonly runtime_version: string;
}

interface GoalManifestEntries {
  readonly read: SelectedApiRouteManifestEntry;
  readonly mutate: SelectedApiRouteManifestEntry;
}

interface MaterializedGoalMutation {
  readonly changed: boolean;
  readonly snapshot: GoalControlSnapshot;
}

const registrationInputKeys = ["audit", "csrf", "goals", "lock", "runtime", "state"] as const;
const goalPortKeys = ["mutate", "snapshot"] as const;
const runtimePortKeys = ["read"] as const;
const statePortKeys = ["get"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();
const goalMutationResultSchema = z
  .object({
    action: z.enum(["set", "pause", "resume", "complete", "clear"]),
    state: z.enum(["accepted", "succeeded"]),
    dispatched: z.boolean(),
    goal: goalControlValueSchema.nullable()
  })
  .strict();

export function createHostDeckGoalRouteRegistration(
  input: CreateHostDeckGoalRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, registrationInputKeys, "HostDeck goal route input is invalid.");
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseGoalPorts(values.goals, values.runtime, values.state);
  const manifest = requireGoalManifestEntries();
  const audit = createHostDeckSelectedWriteAuditPort<"goal">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"goal">
  });
  const gate = createHostDeckSelectedWriteGate({
    manifest: manifest.mutate,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;

  return Object.freeze({
    id: hostDeckGoalRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) throw new TypeError("HostDeck goal route is already registered.");
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
            response: { 200: goalControlSnapshotSchema }
          }
        },
        async (request) => {
          rejectReadBody(request.body, request.headers["content-length"], request.headers["transfer-encoding"]);
          const params = sessionIdParamsSchema.parse(request.params);
          const admitted = resolveGoalAdmission(ports, params.session_id, false);
          const snapshot = await readGoalSnapshot(ports.readGoalSnapshot, admitted.target, request.signal);
          const verified = resolveGoalAdmission(ports, params.session_id, false);
          requireSameAdmission(admitted, verified, "read");
          return snapshot;
        }
      );

      app.post(
        manifest.mutate.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            body: goalMutationRequestSchema,
            response: { 200: goalControlSnapshotSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            GoalParams,
            GoalMutationRequest,
            GoalAdmission,
            CodexGoalMutationResult,
            GoalControlSnapshot
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Goal route candidate is invalid."
              );
              const body = goalMutationRequestSchema.safeParse(routeCandidate.body);
              const params = sessionIdParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw goalHttpError(400, "validation_error", "Goal mutation request is invalid.", false);
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "goal",
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  goal_action: body.data.action,
                  objective_length: body.data.objective?.length ?? 0,
                  expected_revision_present: body.data.expected_goal_revision !== null
                }),
                selector: params.data,
                value: body.data
              });
            },
            resolve_target(mutation) {
              const params = sessionIdParamsSchema.parse(mutation.selector);
              const admitted = resolveGoalAdmission(ports, params.session_id, true);
              return createHostDeckSelectedWriteTargetResolution({
                target: admitted.target,
                capability: "goal",
                value: admitted
              });
            },
            async dispatch(context) {
              const body = goalMutationRequestSchema.parse(context.mutation.value);
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
                const current = resolveGoalAdmission(ports, target.session_id, true);
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return failedTransition(error.code);
                return failedTransition("internal_error");
              }

              let candidate: unknown;
              try {
                candidate = await Reflect.apply(ports.mutateGoal, undefined, [
                  {
                    operation_id: body.operation_id,
                    target,
                    kind: "goal",
                    action: body.action,
                    objective: body.objective,
                    expected_goal_revision: body.expected_goal_revision
                  },
                  request.signal
                ]);
              } catch (error) {
                if (error instanceof HostDeckCodexGoalControlError) {
                  const code = mapGoalErrorCode(error);
                  return error.outcome === "unknown" ? incompleteTransition(code) : failedTransition(code);
                }
                return incompleteTransition("internal_error");
              }

              let materialized: MaterializedGoalMutation;
              try {
                materialized = materializeGoalMutation(candidate, body);
                const current = resolveGoalAdmission(ports, target.session_id, true);
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
              return parseGoalSnapshot(candidate);
            }
          });
          if (result.outcome !== "succeeded") throw publicGoalFailure(result.error_code);
          return reply.code(200).send(result.response);
        }
      );
    }
  });
}

function parseGoalPorts(goalsCandidate: unknown, runtimeCandidate: unknown, stateCandidate: unknown): ParsedGoalPorts {
  const goals = readExactDataObject(goalsCandidate, goalPortKeys, "HostDeck goal service port is invalid.");
  const runtime = readExactDataObject(runtimeCandidate, runtimePortKeys, "HostDeck goal runtime port is invalid.");
  const state = readExactDataObject(stateCandidate, statePortKeys, "HostDeck goal state port is invalid.");
  if (
    typeof goals.mutate !== "function" ||
    typeof goals.snapshot !== "function" ||
    typeof runtime.read !== "function" ||
    typeof state.get !== "function"
  ) {
    throw new TypeError("HostDeck goal route ports are invalid.");
  }
  return Object.freeze({
    getState: state.get as GetState,
    mutateGoal: goals.mutate as MutateGoal,
    readGoalSnapshot: goals.snapshot as ReadGoalSnapshot,
    readRuntime: runtime.read as ReadRuntime
  });
}

function requireGoalManifestEntries(): GoalManifestEntries {
  const readMatches = selectedApiRouteManifest.filter((entry) => entry.id === "goal_read");
  const mutateMatches = selectedApiRouteManifest.filter((entry) => entry.id === "goal_mutate");
  const read = readMatches[0];
  const mutate = mutateMatches[0];
  const audit = mutate?.audit;
  if (
    readMatches.length !== 1 ||
    mutateMatches.length !== 1 ||
    read === undefined ||
    mutate === undefined ||
    !Object.isFrozen(read) ||
    !Object.isFrozen(read.request) ||
    !Object.isFrozen(read.response) ||
    read.family !== "controls" ||
    read.method !== "GET" ||
    read.path !== "/api/v1/sessions/:session_id/goal" ||
    read.transport !== "json" ||
    read.request.params !== "session_id_params_v1" ||
    read.request.query !== null ||
    read.request.body !== null ||
    read.response.success !== "goal_control_snapshot_v1" ||
    read.response.error !== "selected_api_error_v1" ||
    read.auth !== "loopback_or_device_cookie" ||
    read.authority !== "session_read" ||
    read.csrf !== "none" ||
    read.lock !== "not_applicable" ||
    read.target !== "managed_session" ||
    read.operation_kind !== "goal" ||
    read.audit !== null ||
    read.credential_effect !== "none" ||
    read.handler !== "controls.readGoal" ||
    read.owner_task !== "IFC-V1-062" ||
    !Object.isFrozen(mutate) ||
    !Object.isFrozen(mutate.request) ||
    !Object.isFrozen(mutate.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    mutate.family !== "controls" ||
    mutate.method !== "POST" ||
    mutate.path !== "/api/v1/sessions/:session_id/goal" ||
    mutate.transport !== "json" ||
    mutate.request.params !== "session_id_params_v1" ||
    mutate.request.query !== null ||
    mutate.request.body !== "goal_mutation_request_v1" ||
    mutate.response.success !== "goal_control_snapshot_v1" ||
    mutate.response.error !== "selected_api_error_v1" ||
    mutate.auth !== "local_admin_or_device_cookie" ||
    mutate.authority !== "session_write" ||
    mutate.csrf !== "required_for_device" ||
    mutate.lock !== "requires_unlocked_host" ||
    mutate.target !== "managed_session" ||
    mutate.operation_kind !== "goal" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "goal" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    mutate.credential_effect !== "none" ||
    mutate.handler !== "controls.mutateGoal" ||
    mutate.owner_task !== "IFC-V1-062"
  ) {
    throw new TypeError("Selected goal route manifest entries are invalid.");
  }
  return Object.freeze({ read, mutate });
}

function resolveGoalAdmission(ports: ParsedGoalPorts, sessionId: string, writable: boolean): GoalAdmission {
  const managed = resolveManagedTarget(ports.getState, sessionId);
  const runtime = resolveRuntime(ports.readRuntime, writable);
  if (managed.runtime_version !== runtime.runtime_version) {
    throw goalHttpError(
      409,
      "stale_session",
      "Managed session runtime version requires reconciliation before goal control.",
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
): Pick<GoalAdmission, "target" | "target_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw goalHttpError(500, "storage_error", "Managed session state is unavailable.", true);
  }
  if (candidate === null) throw goalHttpError(404, "session_not_found", "Managed session was not found.", false);
  try {
    const state = readExactDataObject(candidate, selectedStateKeys, "Selected goal state is invalid.");
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
      throw goalHttpError(409, "stale_session", "Managed session identity requires reconciliation.", false);
    }
    if (mapping.archived_at !== null || session.session_state === "archived") {
      throw goalHttpError(409, "session_not_writable", "Managed session is archived.", false);
    }
    if (mapping.disposition !== "selected" || session.session_state !== "active" || session.freshness !== "current") {
      throw goalHttpError(409, "stale_session", "Managed session is not current for goal control.", false);
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
    throw goalHttpError(500, "storage_error", "Managed session state is invalid.", false);
  }
}

function resolveRuntime(
  readRuntime: ReadRuntime,
  writable: boolean
): Pick<GoalAdmission, "runtime_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw goalHttpError(503, "runtime_unavailable", "Selected runtime state is unavailable.", true);
  }
  if (candidate === null) throw goalHttpError(503, "runtime_unavailable", "Selected runtime is unavailable.", true);
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw goalHttpError(500, "internal_error", "Selected runtime compatibility is invalid.", false);
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw goalHttpError(503, "runtime_unavailable", "Selected runtime is disconnected.", true);
  }
  const capability = runtime.capabilities.find((entry) => entry.name === "goal");
  if (capability?.state !== "available") {
    throw goalHttpError(409, "capability_unavailable", "Structured goal control is unavailable.", false);
  }
  if (
    (runtime.state !== "ready" && runtime.state !== "degraded") ||
    runtime.observed_version === null ||
    runtime.binding_id === null
  ) {
    throw goalHttpError(409, "incompatible_runtime", "Selected runtime cannot provide goal control.", false);
  }
  if (writable && runtime.mutation_policy !== "allowed") {
    throw goalHttpError(409, "incompatible_runtime", "Selected runtime blocks goal mutation.", false);
  }
  return Object.freeze({
    runtime_key: runtimeAdmissionKey(runtime),
    runtime_version: runtime.observed_version
  });
}

async function readGoalSnapshot(
  readSnapshot: ReadGoalSnapshot,
  target: ManagedSessionTarget,
  signal: AbortSignal
): Promise<GoalControlSnapshot> {
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(readSnapshot, undefined, [target, signal]);
  } catch (error) {
    if (error instanceof HostDeckCodexGoalControlError) throw publicGoalFailure(mapGoalErrorCode(error));
    throw goalHttpError(500, "internal_error", "Goal state could not be read.", false);
  }
  try {
    return parseGoalSnapshot(candidate);
  } catch {
    throw goalHttpError(500, "internal_error", "Goal service returned invalid state.", false);
  }
}

function materializeGoalMutation(candidate: unknown, request: GoalMutationRequest): MaterializedGoalMutation {
  let parsed: ReturnType<typeof goalMutationResultSchema.safeParse>;
  try {
    parsed = goalMutationResultSchema.safeParse(candidate);
  } catch {
    throw new TypeError("Goal mutation result is invalid.");
  }
  if (!parsed.success) throw new TypeError("Goal mutation result is invalid.");
  const result = parsed.data;
  const expectedState = request.action === "resume" ? "accepted" : "succeeded";
  if (result.action !== request.action || result.state !== expectedState) {
    throw new TypeError("Goal mutation result changed its action or materialization state.");
  }
  if (!result.dispatched && !["set", "pause", "complete"].includes(request.action)) {
    throw new TypeError("Goal mutation result claimed an impossible no-op.");
  }
  if (request.action === "clear") {
    if (!result.dispatched || result.goal !== null) throw new TypeError("Goal clear result is contradictory.");
  } else {
    const goal = result.goal;
    if (goal === null) throw new TypeError("Goal mutation result lost its goal.");
    const desiredStatus = request.action === "resume" ? "active" : request.action === "complete" ? "complete" : "paused";
    if (goal.status !== desiredStatus || (request.action === "set" && goal.objective !== request.objective)) {
      throw new TypeError("Goal mutation result contradicts the requested state.");
    }
    if (request.expected_goal_revision === null) {
      if (!result.dispatched) throw new TypeError("Goal creation cannot be a proven no-op.");
    } else if (result.dispatched === (goal.revision === request.expected_goal_revision)) {
      throw new TypeError("Goal mutation result contradicts revision continuity.");
    }
  }
  return Object.freeze({
    changed: result.dispatched,
    snapshot: parseGoalSnapshot({ goal: result.goal, uncertain_mutation: null })
  });
}

function requireSameAdmission(expected: GoalAdmission, actual: GoalAdmission, mode: "read" | "write"): void {
  if (
    expected.target.session_id !== actual.target.session_id ||
    expected.target.codex_thread_id !== actual.target.codex_thread_id ||
    expected.target_key !== actual.target_key
  ) {
    throw goalHttpError(409, "stale_session", "Managed session identity changed during goal control.", false);
  }
  if (expected.runtime_version !== actual.runtime_version || expected.runtime_key !== actual.runtime_key) {
    throw goalHttpError(409, "incompatible_runtime", `Selected runtime changed during goal ${mode}.`, false);
  }
}

function runtimeAdmissionKey(runtime: RuntimeCompatibility): string {
  const capability = runtime.capabilities.find((entry) => entry.name === "goal");
  return JSON.stringify([
    runtime.state,
    runtime.mutation_policy,
    runtime.observed_version,
    runtime.binding_id,
    capability?.state ?? null
  ]);
}

function parseGoalSnapshot(candidate: unknown): GoalControlSnapshot {
  const parsed = goalControlSnapshotSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Goal snapshot is invalid.");
  const uncertain = parsed.data.uncertain_mutation;
  return deepFreeze(
    goalControlSnapshotSchema.parse({
      goal: parsed.data.goal,
      uncertain_mutation:
        uncertain === null
          ? null
          : {
              ...uncertain,
              error: {
                code: uncertain.error.code,
                message: goalErrorMessage(uncertain.error.code),
                retryable: uncertain.error.retryable
              }
            }
    })
  );
}

function mapGoalErrorCode(error: HostDeckCodexGoalControlError): ErrorCode {
  switch (error.code) {
    case "target_not_found":
      return "session_not_found";
    case "target_mismatch":
      return "stale_session";
    case "target_not_writable":
      return error.api_code === "stale_session" ? "stale_session" : "session_not_writable";
    case "capability_unsupported":
      return "capability_unavailable";
    case "goal_missing":
      return "validation_error";
    case "operation_conflict":
    case "pending_settings_conflict":
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

function publicGoalFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "validation_error":
      return goalHttpError(400, code, "Goal action is invalid for the current goal state.", true);
    case "session_not_found":
      return goalHttpError(404, code, "Managed session was not found.", false);
    case "session_not_writable":
      return goalHttpError(409, code, "Managed session cannot provide goal control.", false);
    case "stale_session":
    case "invalid_session_id":
      return goalHttpError(409, "stale_session", "Managed session requires reconciliation before goal control.", false);
    case "incompatible_runtime":
    case "capability_unavailable":
      return goalHttpError(409, code, "Structured goal control is unavailable for the selected runtime.", false);
    case "operation_conflict":
      return goalHttpError(409, code, "Goal state changed or cannot perform this action.", true);
    case "unknown_error":
      return goalHttpError(409, code, "Goal mutation outcome is unknown and requires reconciliation.", false);
    case "protocol_error":
      return goalHttpError(502, code, "Codex goal state failed protocol validation.", false);
    case "operation_timeout":
      return goalHttpError(504, code, "Goal operation exceeded its request deadline.", false);
    case "runtime_unavailable":
      return goalHttpError(503, code, "Codex goal control is unavailable.", true);
    case "audit_unavailable":
      return goalHttpError(503, code, "Goal mutation audit is unavailable.", true);
    case "service_overloaded":
      return goalHttpError(503, code, "Goal control capacity is exhausted.", true);
    case "storage_error":
      return goalHttpError(500, code, "Managed session storage is unavailable.", true);
    case "permission_denied":
      return goalHttpError(401, code, "Goal control authority is no longer valid.", false);
    case "read_only":
      return goalHttpError(403, code, "Write permission is required to mutate a goal.", false);
    default:
      return goalHttpError(500, code, "Goal operation did not complete.", false);
  }
}

function goalErrorMessage(code: ErrorCode): string {
  switch (code) {
    case "unknown_error":
      return "Goal mutation outcome is unknown and requires reconciliation.";
    case "operation_conflict":
      return "Goal mutation conflicts with observed goal state.";
    case "protocol_error":
      return "Codex goal state failed protocol validation.";
    case "runtime_unavailable":
      return "Codex goal control is unavailable.";
    default:
      return "Goal mutation could not be verified.";
  }
}

function rejectReadBody(body: unknown, contentLength: string | undefined, transferEncoding: string | undefined): void {
  if (
    body !== undefined ||
    transferEncoding !== undefined ||
    (contentLength !== undefined && !/^0+$/u.test(contentLength.trim()))
  ) {
    throw goalHttpError(400, "validation_error", "Goal read request cannot contain a body.", false);
  }
}

function goalHttpError(status: number, code: ErrorCode, message: string, retryable: boolean): HostDeckHttpError {
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
