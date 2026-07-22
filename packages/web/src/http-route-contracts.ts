import {
  approvalResponseRequestSchema,
  archiveSessionRequestSchema,
  compactProgressResponseSchema,
  compactStartRequestSchema,
  goalControlSnapshotSchema,
  goalMutationRequestSchema,
  interruptRequestSchema,
  interruptResponseSchema,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  planControlSnapshotSchema,
  planSelectionRequestSchema,
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  remoteIngressPublicStateSchema,
  selectedAccessStateResponseSchema,
  selectedCsrfBootstrapRequestSchema,
  selectedCsrfBootstrapResponseSchema,
  selectedDeviceListQuerySchema,
  selectedDeviceListResponseSchema,
  selectedDeviceRevokeParamsSchema,
  selectedDeviceRevokeRequestSchema,
  selectedDeviceRevokeResponseSchema,
  selectedEventPageQuerySchema,
  selectedEventPageResponseSchema,
  selectedHostLockRequestSchema,
  selectedHostLockStateResponseSchema,
  selectedHostStatusResponseSchema,
  selectedHostUnlockRequestSchema,
  selectedLivenessResponseSchema,
  selectedOperationDispatchSchema,
  selectedPairClaimRequestSchema,
  selectedPairClaimResponseSchema,
  selectedPairRequestResponseSchema,
  selectedPairRequestSchema,
  selectedReadinessResponseSchema,
  selectedResumeMetadataResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionListQuerySchema,
  selectedSessionListResponseSchema,
  selectedSessionStartResponseSchema,
  selectedStartSessionRequestSchema,
  sessionApprovalParamsSchema,
  sessionIdParamsSchema,
  sessionTurnParamsSchema,
  skillsSnapshotSchema,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import type { z } from "zod";

export type BrowserHttpCsrfPolicy = "none" | "required_for_device" | "rotate";

function schemaRef<const Id extends string, const Schema>(
  id: Id,
  schema: Schema
) {
  return Object.freeze({ id, schema });
}

function request<
  const Params,
  const Query,
  const Body,
  const QueryKeys extends readonly string[]
>(params: Params, query: Query, body: Body, queryKeys: QueryKeys) {
  return Object.freeze({ params, query, body, queryKeys: Object.freeze(queryKeys) });
}

function response<const Id extends string, const Schema, const Statuses extends readonly number[]>(
  id: Id,
  schema: Schema,
  statuses: Statuses
) {
  return Object.freeze({
    id,
    schema,
    statuses: Object.freeze(statuses)
  });
}

function route<const Route>(value: Route): Readonly<Route> {
  return Object.freeze(value);
}

const noQueryKeys = [] as const;
const sessionIdParams = schemaRef("session_id_params_v1", sessionIdParamsSchema);
const approvalParams = schemaRef(
  "session_approval_params_v1",
  sessionApprovalParamsSchema
);
const turnParams = schemaRef("session_turn_params_v1", sessionTurnParamsSchema);
const deviceParams = schemaRef("device_id_params_v1", selectedDeviceRevokeParamsSchema);

export const browserHttpRouteContracts = Object.freeze({
  health_liveness: route({
    id: "health_liveness",
    method: "GET",
    path: "/api/v1/health/live",
    csrf: "none",
    request: request(null, null, null, noQueryKeys),
    response: response("liveness_response_v1", selectedLivenessResponseSchema, [200] as const)
  }),
  health_readiness: route({
    id: "health_readiness",
    method: "GET",
    path: "/api/v1/health/ready",
    csrf: "none",
    request: request(null, null, null, noQueryKeys),
    response: response("readiness_response_v1", selectedReadinessResponseSchema, [200, 503] as const)
  }),
  host_status: route({
    id: "host_status",
    method: "GET",
    path: "/api/v1/host/status",
    csrf: "none",
    request: request(null, null, null, noQueryKeys),
    response: response("host_status_response_v1", selectedHostStatusResponseSchema, [200] as const)
  }),
  session_list: route({
    id: "session_list",
    method: "GET",
    path: "/api/v1/sessions",
    csrf: "none",
    request: request(
      null,
      schemaRef("session_list_query_v1", selectedSessionListQuerySchema),
      null,
      ["limit", "cursor"] as const
    ),
    response: response(
      "selected_session_list_response_v1",
      selectedSessionListResponseSchema,
      [200] as const
    )
  }),
  session_start: route({
    id: "session_start",
    method: "POST",
    path: "/api/v1/sessions",
    csrf: "required_for_device",
    request: request(
      null,
      null,
      schemaRef("selected_start_session_request_v1", selectedStartSessionRequestSchema),
      noQueryKeys
    ),
    response: response(
      "selected_session_start_response_v1",
      selectedSessionStartResponseSchema,
      [201] as const
    )
  }),
  session_detail: route({
    id: "session_detail",
    method: "GET",
    path: "/api/v1/sessions/:session_id",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response(
      "selected_session_detail_response_v1",
      selectedSessionDetailResponseSchema,
      [200] as const
    )
  }),
  session_events: route({
    id: "session_events",
    method: "GET",
    path: "/api/v1/sessions/:session_id/events",
    csrf: "none",
    request: request(
      sessionIdParams,
      schemaRef("selected_event_query_v1", selectedEventPageQuerySchema),
      null,
      ["after", "limit"] as const
    ),
    response: response(
      "selected_event_page_response_v1",
      selectedEventPageResponseSchema,
      [200] as const
    )
  }),
  session_resume_metadata: route({
    id: "session_resume_metadata",
    method: "GET",
    path: "/api/v1/sessions/:session_id/resume",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response(
      "selected_resume_metadata_response_v1",
      selectedResumeMetadataResponseSchema,
      [200] as const
    )
  }),
  session_archive: route({
    id: "session_archive",
    method: "POST",
    path: "/api/v1/sessions/:session_id/archive",
    csrf: "required_for_device",
    request: request(
      sessionIdParams,
      null,
      schemaRef("archive_session_request_v1", archiveSessionRequestSchema),
      noQueryKeys
    ),
    response: response(
      "selected_operation_dispatch_response_v1",
      selectedOperationDispatchSchema,
      [202] as const
    )
  }),
  prompt_dispatch: route({
    id: "prompt_dispatch",
    method: "POST",
    path: "/api/v1/sessions/:session_id/prompts",
    csrf: "required_for_device",
    request: request(
      sessionIdParams,
      null,
      schemaRef("prompt_dispatch_request_v1", promptSessionRequestSchema),
      noQueryKeys
    ),
    response: response(
      "prompt_dispatch_response_v1",
      promptDispatchResponseSchema,
      [202] as const
    )
  }),
  model_read: route({
    id: "model_read",
    method: "GET",
    path: "/api/v1/sessions/:session_id/model",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response("model_control_snapshot_v1", modelControlSnapshotSchema, [200] as const)
  }),
  model_select: route({
    id: "model_select",
    method: "POST",
    path: "/api/v1/sessions/:session_id/model",
    csrf: "required_for_device",
    request: request(
      sessionIdParams,
      null,
      schemaRef("model_selection_request_v1", modelSelectionRequestSchema),
      noQueryKeys
    ),
    response: response("model_control_snapshot_v1", modelControlSnapshotSchema, [200] as const)
  }),
  goal_read: route({
    id: "goal_read",
    method: "GET",
    path: "/api/v1/sessions/:session_id/goal",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response("goal_control_snapshot_v1", goalControlSnapshotSchema, [200] as const)
  }),
  goal_mutate: route({
    id: "goal_mutate",
    method: "POST",
    path: "/api/v1/sessions/:session_id/goal",
    csrf: "required_for_device",
    request: request(
      sessionIdParams,
      null,
      schemaRef("goal_mutation_request_v1", goalMutationRequestSchema),
      noQueryKeys
    ),
    response: response("goal_control_snapshot_v1", goalControlSnapshotSchema, [200] as const)
  }),
  plan_read: route({
    id: "plan_read",
    method: "GET",
    path: "/api/v1/sessions/:session_id/plan",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response("plan_control_snapshot_v1", planControlSnapshotSchema, [200] as const)
  }),
  plan_select: route({
    id: "plan_select",
    method: "POST",
    path: "/api/v1/sessions/:session_id/plan",
    csrf: "required_for_device",
    request: request(
      sessionIdParams,
      null,
      schemaRef("plan_selection_request_v1", planSelectionRequestSchema),
      noQueryKeys
    ),
    response: response("plan_control_snapshot_v1", planControlSnapshotSchema, [200] as const)
  }),
  usage_read: route({
    id: "usage_read",
    method: "GET",
    path: "/api/v1/sessions/:session_id/usage",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response("usage_snapshot_v1", usageSnapshotSchema, [200] as const)
  }),
  compact_read: route({
    id: "compact_read",
    method: "GET",
    path: "/api/v1/sessions/:session_id/compact",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response("compact_progress_response_v1", compactProgressResponseSchema, [200] as const)
  }),
  compact_start: route({
    id: "compact_start",
    method: "POST",
    path: "/api/v1/sessions/:session_id/compact",
    csrf: "required_for_device",
    request: request(
      sessionIdParams,
      null,
      schemaRef("compact_start_request_v1", compactStartRequestSchema),
      noQueryKeys
    ),
    response: response("compact_progress_response_v1", compactProgressResponseSchema, [202] as const)
  }),
  skills_read: route({
    id: "skills_read",
    method: "GET",
    path: "/api/v1/sessions/:session_id/skills",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response("skills_snapshot_v1", skillsSnapshotSchema, [200] as const)
  }),
  approval_list: route({
    id: "approval_list",
    method: "GET",
    path: "/api/v1/sessions/:session_id/approvals",
    csrf: "none",
    request: request(sessionIdParams, null, null, noQueryKeys),
    response: response(
      "pending_approval_list_response_v1",
      pendingApprovalListResponseSchema,
      [200] as const
    )
  }),
  approval_respond: route({
    id: "approval_respond",
    method: "POST",
    path: "/api/v1/sessions/:session_id/approvals/:request_id/respond",
    csrf: "required_for_device",
    request: request(
      approvalParams,
      null,
      schemaRef("approval_response_request_v1", approvalResponseRequestSchema),
      noQueryKeys
    ),
    response: response(
      "pending_approval_response_v1",
      pendingApprovalResponseSchema,
      [200] as const
    )
  }),
  turn_interrupt: route({
    id: "turn_interrupt",
    method: "POST",
    path: "/api/v1/sessions/:session_id/turns/:turn_id/interrupt",
    csrf: "required_for_device",
    request: request(
      turnParams,
      null,
      schemaRef("interrupt_request_v1", interruptRequestSchema),
      noQueryKeys
    ),
    response: response("interrupt_response_v1", interruptResponseSchema, [200] as const)
  }),
  pair_request: route({
    id: "pair_request",
    method: "POST",
    path: "/api/v1/access/pairing-codes",
    csrf: "none",
    request: request(
      null,
      null,
      schemaRef("pair_request_v1", selectedPairRequestSchema),
      noQueryKeys
    ),
    response: response("pair_request_response_v1", selectedPairRequestResponseSchema, [200] as const)
  }),
  pair_claim: route({
    id: "pair_claim",
    method: "POST",
    path: "/api/v1/access/pairing-claims",
    csrf: "none",
    request: request(
      null,
      null,
      schemaRef("pair_claim_v1", selectedPairClaimRequestSchema),
      noQueryKeys
    ),
    response: response("pair_claim_response_v1", selectedPairClaimResponseSchema, [200] as const)
  }),
  csrf_bootstrap: route({
    id: "csrf_bootstrap",
    method: "POST",
    path: "/api/v1/access/csrf",
    csrf: "rotate",
    request: request(
      null,
      null,
      schemaRef("csrf_bootstrap_request_v1", selectedCsrfBootstrapRequestSchema),
      noQueryKeys
    ),
    response: response("csrf_bootstrap_response_v1", selectedCsrfBootstrapResponseSchema, [200] as const)
  }),
  access_state: route({
    id: "access_state",
    method: "GET",
    path: "/api/v1/access",
    csrf: "none",
    request: request(null, null, null, noQueryKeys),
    response: response("access_state_response_v1", selectedAccessStateResponseSchema, [200] as const)
  }),
  device_list: route({
    id: "device_list",
    method: "GET",
    path: "/api/v1/access/devices",
    csrf: "none",
    request: request(
      null,
      schemaRef("device_list_query_v1", selectedDeviceListQuerySchema),
      null,
      ["limit", "cursor"] as const
    ),
    response: response("device_list_response_v1", selectedDeviceListResponseSchema, [200] as const)
  }),
  device_revoke: route({
    id: "device_revoke",
    method: "POST",
    path: "/api/v1/access/devices/:device_id/revoke",
    csrf: "required_for_device",
    request: request(
      deviceParams,
      null,
      schemaRef("device_revoke_request_v1", selectedDeviceRevokeRequestSchema),
      noQueryKeys
    ),
    response: response("device_revoke_response_v1", selectedDeviceRevokeResponseSchema, [200] as const)
  }),
  host_lock: route({
    id: "host_lock",
    method: "POST",
    path: "/api/v1/access/lock",
    csrf: "required_for_device",
    request: request(
      null,
      null,
      schemaRef("lock_request_v1", selectedHostLockRequestSchema),
      noQueryKeys
    ),
    response: response("host_lock_state_response_v1", selectedHostLockStateResponseSchema, [200] as const)
  }),
  host_unlock: route({
    id: "host_unlock",
    method: "POST",
    path: "/api/v1/access/unlock",
    csrf: "none",
    request: request(
      null,
      null,
      schemaRef("unlock_request_v1", selectedHostUnlockRequestSchema),
      noQueryKeys
    ),
    response: response("host_lock_state_response_v1", selectedHostLockStateResponseSchema, [200] as const)
  }),
  remote_status: route({
    id: "remote_status",
    method: "GET",
    path: "/api/v1/remote/status",
    csrf: "none",
    request: request(null, null, null, noQueryKeys),
    response: response("remote_ingress_public_state_v1", remoteIngressPublicStateSchema, [200] as const)
  }),
  remote_enable: route({
    id: "remote_enable",
    method: "POST",
    path: "/api/v1/remote/enable",
    csrf: "none",
    request: request(
      null,
      null,
      schemaRef("remote_enable_request_v1", remoteEnableRequestSchema),
      noQueryKeys
    ),
    response: response("remote_ingress_public_state_v1", remoteIngressPublicStateSchema, [200] as const)
  }),
  remote_disable: route({
    id: "remote_disable",
    method: "POST",
    path: "/api/v1/remote/disable",
    csrf: "none",
    request: request(
      null,
      null,
      schemaRef("remote_disable_request_v1", remoteDisableRequestSchema),
      noQueryKeys
    ),
    response: response("remote_ingress_public_state_v1", remoteIngressPublicStateSchema, [200] as const)
  })
} as const);

export type BrowserHttpRouteId = keyof typeof browserHttpRouteContracts;
export type BrowserHttpRouteContract<RouteId extends BrowserHttpRouteId> =
  (typeof browserHttpRouteContracts)[RouteId];

type SchemaFromRef<Ref> = Ref extends {
  readonly schema: infer Schema extends z.ZodType;
}
  ? Schema
  : never;

type RequestField<Name extends string, Ref> = Ref extends null
  ? Readonly<Partial<Record<Name, never>>>
  : Readonly<Record<Name, z.input<SchemaFromRef<Ref>>>>;

export type BrowserHttpRouteRequest<RouteId extends BrowserHttpRouteId> =
  RequestField<"params", BrowserHttpRouteContract<RouteId>["request"]["params"]> &
    RequestField<"query", BrowserHttpRouteContract<RouteId>["request"]["query"]> &
    RequestField<"body", BrowserHttpRouteContract<RouteId>["request"]["body"]>;

export type BrowserHttpRouteData<RouteId extends BrowserHttpRouteId> = z.output<
  SchemaFromRef<BrowserHttpRouteContract<RouteId>["response"]>
>;

type BrowserHttpBaseRequestOptions = Readonly<{
  readonly signal?: AbortSignal;
}>;

export type BrowserHttpRouteRequestOptions<RouteId extends BrowserHttpRouteId> =
  BrowserHttpRouteContract<RouteId>["csrf"] extends "required_for_device"
    ? BrowserHttpBaseRequestOptions &
        Readonly<{
          readonly csrfToken: string;
          readonly csrfGeneration: string;
        }>
    : BrowserHttpBaseRequestOptions;
