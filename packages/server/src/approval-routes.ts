import {
  type ApprovalResponseRequest,
  approvalOperationTargetSchema,
  approvalResponseRequestSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  type PendingApproval,
  type PendingApprovalListResponse,
  type PendingApprovalResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  pendingApprovalSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionApprovalParamsSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { SelectedStateRepository } from "@hostdeck/storage";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  type CodexApprovalControlService,
  HostDeckCodexApprovalControlError
} from "./codex-approval-control-service.js";
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

export const hostDeckApprovalRouteRegistrationId = "selected-approval-control";

export interface HostDeckApprovalRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckApprovalRouteRegistrationInput {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
  readonly approvals: Pick<CodexApprovalControlService, "list" | "respond" | "snapshot" | "waitForTerminal">;
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly runtime: HostDeckApprovalRuntimePort;
  readonly state: Pick<SelectedStateRepository, "get">;
}

type ApprovalResponseParams = z.infer<typeof sessionApprovalParamsSchema>;
type GetState = SelectedStateRepository["get"];
type ListApprovals = CodexApprovalControlService["list"];
type ReadRuntime = HostDeckApprovalRuntimePort["read"];
type RespondApproval = CodexApprovalControlService["respond"];
type SnapshotApproval = CodexApprovalControlService["snapshot"];
type WaitForTerminal = CodexApprovalControlService["waitForTerminal"];

interface ParsedApprovalPorts {
  readonly getState: GetState;
  readonly list: ListApprovals;
  readonly readRuntime: ReadRuntime;
  readonly respond: RespondApproval;
  readonly snapshot: SnapshotApproval;
  readonly waitForTerminal: WaitForTerminal;
}

interface ApprovalAdmission {
  readonly runtime_key: string;
  readonly runtime_version: string;
  readonly target: ManagedSessionTarget;
  readonly target_key: string;
}

interface ApprovalDecisionAdmission extends ApprovalAdmission {
  readonly approval: PendingApproval;
  readonly approval_key: string;
}

interface ApprovalManifestEntries {
  readonly list: SelectedApiRouteManifestEntry;
  readonly respond: SelectedApiRouteManifestEntry;
}

const registrationInputKeys = ["admission", "approvals", "audit", "csrf", "lock", "runtime", "state"] as const;
const approvalPortKeys = ["list", "respond", "snapshot", "waitForTerminal"] as const;
const runtimePortKeys = ["read"] as const;
const statePortKeys = ["get"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();

export function createHostDeckApprovalRouteRegistration(
  input: CreateHostDeckApprovalRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, registrationInputKeys, "HostDeck approval route input is invalid.");
  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseApprovalPorts(values.approvals, values.runtime, values.state);
  const manifest = requireApprovalManifestEntries();
  const audit = createHostDeckSelectedWriteAuditPort<"approval_response">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"approval_response">
  });
  const gate = createHostDeckSelectedWriteGate({
    admission: values.admission,
    manifest: manifest.respond,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;

  return Object.freeze({
    id: hostDeckApprovalRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) throw new TypeError("HostDeck approval route is already registered.");
      registered = true;

      app.get(
        manifest.list.path,
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
            response: { 200: pendingApprovalListResponseSchema }
          }
        },
        async (request) => {
          rejectReadBody(request.body, request.headers["content-length"], request.headers["transfer-encoding"]);
          const params = sessionIdParamsSchema.parse(request.params);
          const admitted = resolveApprovalAdmission(ports, params.session_id, false);
          const response = await readApprovalList(ports.list, admitted.target);
          const verified = resolveApprovalAdmission(ports, params.session_id, false);
          requireSameAdmission(admitted, verified, "read");
          return response;
        }
      );

      app.post(
        manifest.respond.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            params: sessionApprovalParamsSchema,
            querystring: noQuerySchema,
            body: approvalResponseRequestSchema,
            response: { 200: pendingApprovalResponseSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            ApprovalResponseParams,
            ApprovalResponseRequest,
            ApprovalDecisionAdmission,
            PendingApprovalResponse,
            PendingApprovalResponse
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Approval response route candidate is invalid."
              );
              const body = approvalResponseRequestSchema.safeParse(routeCandidate.body);
              const params = sessionApprovalParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw approvalHttpError(400, "validation_error", "Approval response request is invalid.", false);
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "approval_response",
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  decision: body.data.decision,
                  confirmed: true as const
                }),
                selector: params.data,
                value: body.data
              });
            },
            async resolve_target(mutation) {
              const params = sessionApprovalParamsSchema.parse(mutation.selector);
              const admitted = await resolveApprovalDecisionAdmission(ports, params, true);
              return createHostDeckSelectedWriteTargetResolution({
                target: admitted.approval.target,
                capability: "approvals",
                value: admitted
              });
            },
            async dispatch(context) {
              const body = approvalResponseRequestSchema.parse(context.mutation.value);
              const target = approvalOperationTargetSchema.parse(context.mutation.target);
              if (
                context.accepted_audit === null ||
                context.resolution.target.type !== "approval" ||
                context.resolution.target.session_id !== target.session_id ||
                context.resolution.target.codex_thread_id !== target.codex_thread_id ||
                context.resolution.target.request_id !== target.request_id
              ) {
                return incompleteTransition("internal_error");
              }

              try {
                const current = await resolveApprovalDecisionAdmission(
                  ports,
                  { session_id: target.session_id, request_id: target.request_id },
                  true
                );
                requireSameDecisionAdmission(context.resolution.value, current);
              } catch (error) {
                if (error instanceof HostDeckHttpError) return failedTransition(error.code);
                return failedTransition("internal_error");
              }

              let responseCandidate: unknown;
              let possibleSend = false;
              try {
                responseCandidate = await Reflect.apply(ports.respond, undefined, [
                  {
                    operation_id: body.operation_id,
                    target,
                    kind: "approval_response",
                    decision: body.decision,
                    confirm: true
                  }
                ]);
              } catch (error) {
                if (!(error instanceof HostDeckCodexApprovalControlError)) {
                  return incompleteTransition("internal_error");
                }
                if (error.outcome !== "unknown") return approvalFailureTransition(error);
                possibleSend = true;
              }

              if (!possibleSend) {
                try {
                  requireRespondingApproval(responseCandidate, target);
                } catch {
                  return incompleteTransition("protocol_error");
                }
              }

              let terminalCandidate: unknown;
              try {
                terminalCandidate = await Reflect.apply(ports.waitForTerminal, undefined, [target, request.signal]);
              } catch (error) {
                if (error instanceof HostDeckCodexApprovalControlError) {
                  return incompleteTransition(mapApprovalErrorCode(error));
                }
                return incompleteTransition("internal_error");
              }

              let response: PendingApprovalResponse;
              try {
                response = materializeApprovalResponse(terminalCandidate, body, target);
                const current = resolveApprovalAdmission(ports, target.session_id, true);
                requireSameAdmission(context.resolution.value, current, "write");
              } catch (error) {
                if (error instanceof HostDeckHttpError) return incompleteTransition(error.code);
                return incompleteTransition("protocol_error");
              }

              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1 as const,
                  decision_finalized: true as const
                }),
                response
              });
            },
            prepare_response(candidate) {
              return deepFreeze(pendingApprovalResponseSchema.parse(candidate));
            }
          });
          if (result.outcome !== "succeeded") throw publicApprovalFailure(result.error_code);
          return reply.code(200).send(result.response);
        }
      );
    }
  });
}

function parseApprovalPorts(
  approvalsCandidate: unknown,
  runtimeCandidate: unknown,
  stateCandidate: unknown
): ParsedApprovalPorts {
  const approvals = readExactDataObject(
    approvalsCandidate,
    approvalPortKeys,
    "HostDeck approval service port is invalid."
  );
  const runtime = readExactDataObject(runtimeCandidate, runtimePortKeys, "HostDeck approval runtime port is invalid.");
  const state = readExactDataObject(stateCandidate, statePortKeys, "HostDeck approval state port is invalid.");
  if (
    typeof approvals.list !== "function" ||
    typeof approvals.respond !== "function" ||
    typeof approvals.snapshot !== "function" ||
    typeof approvals.waitForTerminal !== "function" ||
    typeof runtime.read !== "function" ||
    typeof state.get !== "function"
  ) {
    throw new TypeError("HostDeck approval route ports are invalid.");
  }
  return Object.freeze({
    getState: state.get as GetState,
    list: approvals.list as ListApprovals,
    readRuntime: runtime.read as ReadRuntime,
    respond: approvals.respond as RespondApproval,
    snapshot: approvals.snapshot as SnapshotApproval,
    waitForTerminal: approvals.waitForTerminal as WaitForTerminal
  });
}

function requireApprovalManifestEntries(): ApprovalManifestEntries {
  const listMatches = selectedApiRouteManifest.filter((entry) => entry.id === "approval_list");
  const respondMatches = selectedApiRouteManifest.filter((entry) => entry.id === "approval_respond");
  const list = listMatches[0];
  const respond = respondMatches[0];
  const audit = respond?.audit;
  if (
    listMatches.length !== 1 ||
    respondMatches.length !== 1 ||
    list === undefined ||
    respond === undefined ||
    !Object.isFrozen(list) ||
    !Object.isFrozen(list.request) ||
    !Object.isFrozen(list.response) ||
    list.family !== "approvals" ||
    list.method !== "GET" ||
    list.path !== "/api/v1/sessions/:session_id/approvals" ||
    list.transport !== "json" ||
    list.request.params !== "session_id_params_v1" ||
    list.request.query !== null ||
    list.request.body !== null ||
    list.response.success !== "pending_approval_list_response_v1" ||
    list.response.error !== "selected_api_error_v1" ||
    list.auth !== "loopback_or_device_cookie" ||
    list.authority !== "session_read" ||
    list.csrf !== "none" ||
    list.lock !== "not_applicable" ||
    list.target !== "managed_session" ||
    list.operation_kind !== null ||
    list.audit !== null ||
    list.credential_effect !== "none" ||
    list.handler !== "approvals.list" ||
    list.owner_task !== "IFC-V1-044" ||
    !Object.isFrozen(respond) ||
    !Object.isFrozen(respond.request) ||
    !Object.isFrozen(respond.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    respond.family !== "approvals" ||
    respond.method !== "POST" ||
    respond.path !== "/api/v1/sessions/:session_id/approvals/:request_id/respond" ||
    respond.transport !== "json" ||
    respond.request.params !== "session_approval_params_v1" ||
    respond.request.query !== null ||
    respond.request.body !== "approval_response_request_v1" ||
    respond.response.success !== "pending_approval_response_v1" ||
    respond.response.error !== "selected_api_error_v1" ||
    respond.auth !== "local_admin_or_device_cookie" ||
    respond.authority !== "session_write" ||
    respond.csrf !== "required_for_device" ||
    respond.lock !== "requires_unlocked_host" ||
    respond.target !== "approval" ||
    respond.operation_kind !== "approval_response" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "approval_response" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    respond.credential_effect !== "none" ||
    respond.handler !== "approvals.respond" ||
    respond.owner_task !== "IFC-V1-044"
  ) {
    throw new TypeError("Selected approval route manifest entries are invalid.");
  }
  return Object.freeze({ list, respond });
}

function resolveApprovalAdmission(
  ports: ParsedApprovalPorts,
  sessionId: string,
  requireMutation: boolean
): ApprovalAdmission {
  const managed = resolveManagedTarget(ports.getState, sessionId);
  const runtime = resolveRuntime(ports.readRuntime, requireMutation);
  if (managed.runtime_version !== runtime.runtime_version) {
    throw approvalHttpError(
      409,
      "stale_session",
      "Managed session runtime version requires reconciliation before approval control.",
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

async function resolveApprovalDecisionAdmission(
  ports: ParsedApprovalPorts,
  params: ApprovalResponseParams,
  requireMutation: boolean
): Promise<ApprovalDecisionAdmission> {
  const admitted = resolveApprovalAdmission(ports, params.session_id, requireMutation);
  const target = approvalOperationTargetSchema.parse({
    type: "approval",
    session_id: admitted.target.session_id,
    codex_thread_id: admitted.target.codex_thread_id,
    request_id: params.request_id
  });
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(ports.snapshot, undefined, [target]);
  } catch (error) {
    if (error instanceof HostDeckCodexApprovalControlError) throw publicApprovalFailure(mapApprovalErrorCode(error));
    throw approvalHttpError(500, "internal_error", "Approval state could not be read.", false);
  }
  const approval = parseApproval(candidate, target);
  if (approval === null || approval.state !== "pending" || approval.decision !== null) {
    throw approvalHttpError(409, "approval_not_pending", "Approval request is not pending.", false);
  }
  return Object.freeze({ ...admitted, approval, approval_key: JSON.stringify(approval) });
}

function resolveManagedTarget(
  getState: GetState,
  sessionId: string
): Pick<ApprovalAdmission, "target" | "target_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw approvalHttpError(500, "storage_error", "Managed session state is unavailable.", true);
  }
  if (candidate === null) throw approvalHttpError(404, "session_not_found", "Managed session was not found.", false);
  try {
    const state = readExactDataObject(candidate, selectedStateKeys, "Selected approval state is invalid.");
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
      throw approvalHttpError(409, "stale_session", "Managed session identity requires reconciliation.", false);
    }
    if (mapping.archived_at !== null || session.session_state === "archived") {
      throw approvalHttpError(409, "session_not_writable", "Managed session is archived.", false);
    }
    if (mapping.disposition !== "selected" || session.session_state !== "active" || session.freshness !== "current") {
      throw approvalHttpError(409, "stale_session", "Managed session is not current for approval control.", false);
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
    throw approvalHttpError(500, "storage_error", "Managed session state is invalid.", false);
  }
}

function resolveRuntime(
  readRuntime: ReadRuntime,
  requireMutation: boolean
): Pick<ApprovalAdmission, "runtime_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw approvalHttpError(503, "runtime_unavailable", "Selected runtime state is unavailable.", true);
  }
  if (candidate === null) throw approvalHttpError(503, "runtime_unavailable", "Selected runtime is unavailable.", true);
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw approvalHttpError(500, "internal_error", "Selected runtime compatibility is invalid.", false);
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw approvalHttpError(503, "runtime_unavailable", "Selected runtime is disconnected.", true);
  }
  const capability = runtime.capabilities.find((entry) => entry.name === "approvals");
  if (capability?.state !== "available") {
    throw approvalHttpError(409, "capability_unavailable", "Structured approval control is unavailable.", false);
  }
  if (
    (runtime.state !== "ready" && runtime.state !== "degraded") ||
    runtime.observed_version === null ||
    runtime.binding_id === null
  ) {
    throw approvalHttpError(409, "incompatible_runtime", "Selected runtime cannot provide approval control.", false);
  }
  if (requireMutation && runtime.mutation_policy !== "allowed") {
    throw approvalHttpError(409, "incompatible_runtime", "Selected runtime blocks approval responses.", false);
  }
  return Object.freeze({
    runtime_key: runtimeAdmissionKey(runtime),
    runtime_version: runtime.observed_version
  });
}

async function readApprovalList(
  list: ListApprovals,
  target: ManagedSessionTarget
): Promise<PendingApprovalListResponse> {
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(list, undefined, [target]);
  } catch (error) {
    if (error instanceof HostDeckCodexApprovalControlError) throw publicApprovalFailure(mapApprovalErrorCode(error));
    throw approvalHttpError(500, "internal_error", "Approval list could not be read.", false);
  }
  try {
    return deepFreeze(pendingApprovalListResponseSchema.parse({ target, approvals: candidate }));
  } catch {
    throw approvalHttpError(500, "internal_error", "Approval service returned an invalid list.", false);
  }
}

function requireRespondingApproval(candidate: unknown, target: PendingApproval["target"]): PendingApproval {
  const approval = parseApproval(candidate, target);
  if (approval === null || approval.state !== "responding" || approval.decision !== null) {
    throw new TypeError("Approval response dispatch did not enter responding state.");
  }
  return approval;
}

function materializeApprovalResponse(
  candidate: unknown,
  request: ApprovalResponseRequest,
  target: PendingApproval["target"]
): PendingApprovalResponse {
  const approval = parseApproval(candidate, target);
  if (approval === null) throw new TypeError("Approval terminal response is absent.");
  const expectedState = request.decision === "approve" ? "approved" : "denied";
  if (approval.state !== expectedState || approval.decision !== request.decision) {
    throw new TypeError("Approval terminal response contradicts the requested decision.");
  }
  return deepFreeze(
    pendingApprovalResponseSchema.parse({
      operation_id: request.operation_id,
      requested_decision: request.decision,
      approval
    })
  );
}

function parseApproval(candidate: unknown, target: PendingApproval["target"]): PendingApproval | null {
  if (candidate === null) return null;
  const parsed = pendingApprovalSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.target.session_id !== target.session_id ||
    parsed.data.target.codex_thread_id !== target.codex_thread_id ||
    parsed.data.target.request_id !== target.request_id
  ) {
    throw new TypeError("Approval service result changed the exact request target.");
  }
  return deepFreeze(parsed.data);
}

function requireSameDecisionAdmission(
  expected: ApprovalDecisionAdmission,
  actual: ApprovalDecisionAdmission
): void {
  requireSameAdmission(expected, actual, "write");
  if (expected.approval_key !== actual.approval_key) {
    throw approvalHttpError(409, "approval_not_pending", "Approval request changed before dispatch.", false);
  }
}

function requireSameAdmission(
  expected: ApprovalAdmission,
  actual: ApprovalAdmission,
  mode: "read" | "write"
): void {
  if (
    expected.target.session_id !== actual.target.session_id ||
    expected.target.codex_thread_id !== actual.target.codex_thread_id ||
    expected.target_key !== actual.target_key
  ) {
    throw approvalHttpError(409, "stale_session", "Managed session identity changed during approval control.", false);
  }
  if (expected.runtime_version !== actual.runtime_version || expected.runtime_key !== actual.runtime_key) {
    throw approvalHttpError(409, "incompatible_runtime", `Selected runtime changed during approval ${mode}.`, false);
  }
}

function runtimeAdmissionKey(runtime: RuntimeCompatibility): string {
  const capability = runtime.capabilities.find((entry) => entry.name === "approvals");
  return JSON.stringify([
    runtime.state,
    runtime.mutation_policy,
    runtime.observed_version,
    runtime.binding_id,
    capability?.state ?? null
  ]);
}

function approvalFailureTransition(error: HostDeckCodexApprovalControlError) {
  const errorCode = mapApprovalErrorCode(error);
  return error.outcome === "unknown" ? incompleteTransition(errorCode) : failedTransition(errorCode);
}

function mapApprovalErrorCode(error: HostDeckCodexApprovalControlError): ErrorCode {
  switch (error.code) {
    case "approval_not_pending":
      return "approval_not_pending";
    case "target_not_found":
      return "session_not_found";
    case "target_mismatch":
    case "target_stale":
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
    case "state_unavailable":
      return "storage_error";
    case "unknown_outcome":
      return error.api_code === "operation_timeout" ? "operation_timeout" : "unknown_error";
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

function publicApprovalFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "validation_error":
      return approvalHttpError(400, code, "Approval response request is invalid.", false);
    case "session_not_found":
      return approvalHttpError(404, code, "Managed session was not found.", false);
    case "approval_not_pending":
      return approvalHttpError(409, code, "Approval request is not pending.", false);
    case "session_not_writable":
      return approvalHttpError(409, code, "Managed session cannot provide approval control.", false);
    case "stale_session":
    case "invalid_session_id":
      return approvalHttpError(409, "stale_session", "Managed session requires reconciliation before approval control.", false);
    case "incompatible_runtime":
    case "capability_unavailable":
      return approvalHttpError(409, code, "Structured approval control is unavailable for the selected runtime.", false);
    case "operation_conflict":
      return approvalHttpError(409, code, "Approval response conflicts with current request state.", false);
    case "unknown_error":
      return approvalHttpError(409, code, "Approval response outcome is unknown and requires reconciliation.", false);
    case "protocol_error":
      return approvalHttpError(502, code, "Codex approval state failed protocol validation.", false);
    case "operation_timeout":
      return approvalHttpError(504, code, "Approval response exceeded its request deadline.", false);
    case "runtime_unavailable":
      return approvalHttpError(503, code, "Codex approval control is unavailable.", true);
    case "audit_unavailable":
      return approvalHttpError(503, code, "Approval audit is unavailable.", true);
    case "service_overloaded":
      return approvalHttpError(503, code, "Approval control capacity is exhausted.", true);
    case "storage_error":
      return approvalHttpError(500, code, "Managed session storage is unavailable.", true);
    case "permission_denied":
      return approvalHttpError(401, code, "Approval control authority is no longer valid.", false);
    case "read_only":
      return approvalHttpError(403, code, "Write permission is required to respond to an approval.", false);
    default:
      return approvalHttpError(500, code, "Approval operation did not complete.", false);
  }
}

function rejectReadBody(body: unknown, contentLength: string | undefined, transferEncoding: string | undefined): void {
  if (
    body !== undefined ||
    transferEncoding !== undefined ||
    (contentLength !== undefined && !/^0+$/u.test(contentLength.trim()))
  ) {
    throw approvalHttpError(400, "validation_error", "Approval list request cannot contain a body.", false);
  }
}

function approvalHttpError(status: number, code: ErrorCode, message: string, retryable: boolean): HostDeckHttpError {
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
