import {
  type HistoricalSelectedNetworkAuditAction,
  historicalSelectedNetworkAuditActions,
  type SelectedAuditAction,
  type SelectedOperationKind,
  selectedAuditActions
} from "@hostdeck/core";

export const selectedApiRouteMethods = ["GET", "POST"] as const;
export const selectedApiRouteFamilies = [
  "health",
  "sessions",
  "events",
  "controls",
  "approvals",
  "access",
  "network"
] as const;
export const selectedApiTransports = ["json", "sse"] as const;
export const selectedApiAuthMechanisms = [
  "none",
  "pairing_code",
  "optional_device_cookie",
  "loopback_or_device_cookie",
  "device_cookie",
  "local_admin",
  "local_admin_or_device_cookie"
] as const;
export const selectedApiAuthorities = [
  "public",
  "pair_claim",
  "access_read",
  "host_read",
  "session_read",
  "session_write",
  "csrf_rotate",
  "device_admin",
  "host_lock",
  "local_admin"
] as const;
export const selectedApiCsrfPolicies = ["none", "rotate", "required_for_device"] as const;
export const selectedApiLockPolicies = ["not_applicable", "requires_unlocked_host", "lock_transition"] as const;
export const selectedApiTargetKinds = [
  "none",
  "host",
  "new_managed_session",
  "managed_session",
  "approval",
  "turn",
  "authenticated_device",
  "device"
] as const;
export const selectedApiAuditExecutors = ["selected_write_gate", "security_executor"] as const;
export const selectedApiAuditCatalogStates = ["selected", "owned_extension", "historical"] as const;
export const selectedApiCredentialEffects = [
  "none",
  "set_device_cookie",
  "rotate_csrf",
  "invalidate_device"
] as const;
export const selectedApiRouteOwnerTasks = [
  "IFC-V1-027",
  "IFC-V1-028",
  "IFC-V1-029",
  "IFC-V1-030",
  "IFC-V1-031",
  "IFC-V1-035",
  "IFC-V1-039",
  "IFC-V1-040",
  "IFC-V1-041",
  "IFC-V1-042",
  "IFC-V1-043",
  "IFC-V1-044",
  "IFC-V1-045",
  "IFC-V1-059",
  "IFC-V1-060",
  "IFC-V1-061",
  "IFC-V1-062",
  "IFC-V1-063",
  "IFC-V1-064",
  "IFC-V1-065",
  "IFC-V1-068",
  "IFC-V1-069"
] as const;

export const selectedApiSchemaIds = [
  "session_id_params_v1",
  "session_approval_params_v1",
  "session_turn_params_v1",
  "device_id_params_v1",
  "session_list_query_v1",
  "selected_event_query_v1",
  "selected_stream_cursor_query_v1",
  "device_list_query_v1",
  "selected_start_session_request_v1",
  "prompt_operation_intent_v1",
  "model_operation_intent_v1",
  "goal_operation_intent_v1",
  "plan_operation_intent_v1",
  "compact_operation_intent_v1",
  "approval_response_operation_intent_v1",
  "interrupt_operation_intent_v1",
  "archive_operation_intent_v1",
  "pair_request_v1",
  "pair_claim_v1",
  "csrf_bootstrap_request_v1",
  "device_revoke_request_v1",
  "lock_request_v1",
  "unlock_request_v1",
  "lan_configure_request_v1",
  "lan_enable_request_v1",
  "lan_disable_request_v1",
  "liveness_response_v1",
  "readiness_response_v1",
  "host_status_response_v1",
  "selected_session_list_response_v1",
  "selected_session_start_response_v1",
  "selected_session_detail_response_v1",
  "selected_event_page_response_v1",
  "selected_projection_event_v1",
  "selected_resume_metadata_response_v1",
  "prompt_dispatch_response_v1",
  "model_control_snapshot_v1",
  "goal_control_snapshot_v1",
  "plan_control_snapshot_v1",
  "usage_snapshot_v1",
  "compact_progress_response_v1",
  "skills_snapshot_v1",
  "pending_approval_list_response_v1",
  "pending_approval_response_v1",
  "selected_operation_progress_v1",
  "selected_operation_dispatch_response_v1",
  "pair_request_response_v1",
  "pair_claim_response_v1",
  "csrf_bootstrap_response_v1",
  "access_state_response_v1",
  "device_list_response_v1",
  "device_revoke_response_v1",
  "host_lock_state_response_v1",
  "network_state_response_v1",
  "lan_mutation_response_v1",
  "selected_api_error_v1"
] as const;

const selectedApiAuditExtensions = ["session_start"] as const;
export const selectedApiAuditActions = Object.freeze([
  ...selectedAuditActions,
  ...historicalSelectedNetworkAuditActions,
  ...selectedApiAuditExtensions
]);

export type SelectedApiRouteMethod = (typeof selectedApiRouteMethods)[number];
export type SelectedApiRouteFamily = (typeof selectedApiRouteFamilies)[number];
export type SelectedApiTransport = (typeof selectedApiTransports)[number];
export type SelectedApiAuthMechanism = (typeof selectedApiAuthMechanisms)[number];
export type SelectedApiAuthority = (typeof selectedApiAuthorities)[number];
export type SelectedApiCsrfPolicy = (typeof selectedApiCsrfPolicies)[number];
export type SelectedApiLockPolicy = (typeof selectedApiLockPolicies)[number];
export type SelectedApiTargetKind = (typeof selectedApiTargetKinds)[number];
export type SelectedApiAuditExecutor = (typeof selectedApiAuditExecutors)[number];
export type SelectedApiAuditCatalogState = (typeof selectedApiAuditCatalogStates)[number];
export type SelectedApiCredentialEffect = (typeof selectedApiCredentialEffects)[number];
export type SelectedApiRouteOwnerTask = (typeof selectedApiRouteOwnerTasks)[number];
export type SelectedApiSchemaId = (typeof selectedApiSchemaIds)[number];
export type SelectedApiAuditAction = (typeof selectedApiAuditActions)[number];
export type SelectedApiAuditCatalogOwnerTask = "IFC-V1-040" | "IFC-V1-075";

export interface SelectedApiRequestContracts {
  readonly params: SelectedApiSchemaId | null;
  readonly query: SelectedApiSchemaId | null;
  readonly body: SelectedApiSchemaId | null;
}

export interface SelectedApiResponseContracts {
  readonly success: SelectedApiSchemaId;
  readonly error: "selected_api_error_v1";
}

export interface SelectedApiAuditContract {
  readonly executor: SelectedApiAuditExecutor;
  readonly action: SelectedApiAuditAction;
  readonly catalog_state: SelectedApiAuditCatalogState;
  readonly catalog_owner_task: SelectedApiAuditCatalogOwnerTask | null;
}

export interface SelectedApiRouteManifestEntry {
  readonly id: string;
  readonly family: SelectedApiRouteFamily;
  readonly method: SelectedApiRouteMethod;
  readonly path: `/api/v1/${string}`;
  readonly transport: SelectedApiTransport;
  readonly request: SelectedApiRequestContracts;
  readonly response: SelectedApiResponseContracts;
  readonly auth: SelectedApiAuthMechanism;
  readonly authority: SelectedApiAuthority;
  readonly csrf: SelectedApiCsrfPolicy;
  readonly lock: SelectedApiLockPolicy;
  readonly target: SelectedApiTargetKind;
  readonly operation_kind: SelectedOperationKind | null;
  readonly audit: SelectedApiAuditContract | null;
  readonly credential_effect: SelectedApiCredentialEffect;
  readonly handler: string;
  readonly owner_task: SelectedApiRouteOwnerTask;
}

const publicPolicy = policy("none", "public", "none", "not_applicable");
const accessReadPolicy = policy("optional_device_cookie", "access_read", "none", "not_applicable");
const hostReadPolicy = policy("loopback_or_device_cookie", "host_read", "none", "not_applicable");
const sessionReadPolicy = policy("loopback_or_device_cookie", "session_read", "none", "not_applicable");
const sessionWritePolicy = policy(
  "local_admin_or_device_cookie",
  "session_write",
  "required_for_device",
  "requires_unlocked_host"
);
const deviceAdminReadPolicy = policy(
  "device_cookie",
  "device_admin",
  "none",
  "not_applicable"
);
const deviceAdminWritePolicy = policy(
  "local_admin_or_device_cookie",
  "device_admin",
  "required_for_device",
  "not_applicable"
);
const hostLockPolicy = policy(
  "local_admin_or_device_cookie",
  "host_lock",
  "required_for_device",
  "lock_transition"
);
const localAdminPolicy = policy("local_admin", "local_admin", "none", "not_applicable");

export const selectedApiRouteManifest: readonly SelectedApiRouteManifestEntry[] = deepFreeze([
  route({
    id: "health_liveness",
    family: "health",
    method: "GET",
    path: "/api/v1/health/live",
    transport: "json",
    request: request(null, null, null),
    response: response("liveness_response_v1"),
    ...publicPolicy,
    target: "none",
    operation_kind: null,
    audit: null,
    handler: "health.liveness",
    owner_task: "IFC-V1-039"
  }),
  route({
    id: "health_readiness",
    family: "health",
    method: "GET",
    path: "/api/v1/health/ready",
    transport: "json",
    request: request(null, null, null),
    response: response("readiness_response_v1"),
    ...hostReadPolicy,
    target: "host",
    operation_kind: null,
    audit: null,
    handler: "health.readiness",
    owner_task: "IFC-V1-039"
  }),
  route({
    id: "host_status",
    family: "health",
    method: "GET",
    path: "/api/v1/host/status",
    transport: "json",
    request: request(null, null, null),
    response: response("host_status_response_v1"),
    ...hostReadPolicy,
    target: "host",
    operation_kind: null,
    audit: null,
    handler: "health.hostStatus",
    owner_task: "IFC-V1-039"
  }),
  route({
    id: "session_list",
    family: "sessions",
    method: "GET",
    path: "/api/v1/sessions",
    transport: "json",
    request: request(null, "session_list_query_v1", null),
    response: response("selected_session_list_response_v1"),
    ...sessionReadPolicy,
    target: "none",
    operation_kind: null,
    audit: null,
    handler: "sessions.list",
    owner_task: "IFC-V1-068"
  }),
  route({
    id: "session_start",
    family: "sessions",
    method: "POST",
    path: "/api/v1/sessions",
    transport: "json",
    request: request(null, null, "selected_start_session_request_v1"),
    response: response("selected_session_start_response_v1"),
    ...sessionWritePolicy,
    target: "new_managed_session",
    operation_kind: null,
    audit: extensionAudit("selected_write_gate", "session_start", "IFC-V1-040"),
    handler: "sessions.start",
    owner_task: "IFC-V1-040"
  }),
  route({
    id: "session_detail",
    family: "sessions",
    method: "GET",
    path: "/api/v1/sessions/:session_id",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("selected_session_detail_response_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: null,
    audit: null,
    handler: "sessions.detail",
    owner_task: "IFC-V1-068"
  }),
  route({
    id: "session_events",
    family: "events",
    method: "GET",
    path: "/api/v1/sessions/:session_id/events",
    transport: "json",
    request: request("session_id_params_v1", "selected_event_query_v1", null),
    response: response("selected_event_page_response_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: null,
    audit: null,
    handler: "events.page",
    owner_task: "IFC-V1-069"
  }),
  route({
    id: "session_event_stream",
    family: "events",
    method: "GET",
    path: "/api/v1/sessions/:session_id/events/stream",
    transport: "sse",
    request: request("session_id_params_v1", "selected_stream_cursor_query_v1", null),
    response: response("selected_projection_event_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: null,
    audit: null,
    handler: "events.stream",
    owner_task: "IFC-V1-035"
  }),
  route({
    id: "session_resume_metadata",
    family: "sessions",
    method: "GET",
    path: "/api/v1/sessions/:session_id/resume",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("selected_resume_metadata_response_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: null,
    audit: null,
    handler: "sessions.resumeMetadata",
    owner_task: "IFC-V1-060"
  }),
  route({
    id: "session_archive",
    family: "sessions",
    method: "POST",
    path: "/api/v1/sessions/:session_id/archive",
    transport: "json",
    request: request("session_id_params_v1", null, "archive_operation_intent_v1"),
    response: response("selected_operation_dispatch_response_v1"),
    ...sessionWritePolicy,
    target: "managed_session",
    operation_kind: "archive",
    audit: selectedWriteAudit("archive"),
    handler: "sessions.archive",
    owner_task: "IFC-V1-061"
  }),
  route({
    id: "prompt_dispatch",
    family: "controls",
    method: "POST",
    path: "/api/v1/sessions/:session_id/prompts",
    transport: "json",
    request: request("session_id_params_v1", null, "prompt_operation_intent_v1"),
    response: response("prompt_dispatch_response_v1"),
    ...sessionWritePolicy,
    target: "managed_session",
    operation_kind: "prompt",
    audit: selectedWriteAudit("prompt"),
    handler: "controls.prompt",
    owner_task: "IFC-V1-041"
  }),
  route({
    id: "model_read",
    family: "controls",
    method: "GET",
    path: "/api/v1/sessions/:session_id/model",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("model_control_snapshot_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: "model",
    audit: null,
    handler: "controls.readModel",
    owner_task: "IFC-V1-042"
  }),
  route({
    id: "model_select",
    family: "controls",
    method: "POST",
    path: "/api/v1/sessions/:session_id/model",
    transport: "json",
    request: request("session_id_params_v1", null, "model_operation_intent_v1"),
    response: response("model_control_snapshot_v1"),
    ...sessionWritePolicy,
    target: "managed_session",
    operation_kind: "model",
    audit: selectedWriteAudit("model"),
    handler: "controls.selectModel",
    owner_task: "IFC-V1-042"
  }),
  route({
    id: "goal_read",
    family: "controls",
    method: "GET",
    path: "/api/v1/sessions/:session_id/goal",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("goal_control_snapshot_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: "goal",
    audit: null,
    handler: "controls.readGoal",
    owner_task: "IFC-V1-062"
  }),
  route({
    id: "goal_mutate",
    family: "controls",
    method: "POST",
    path: "/api/v1/sessions/:session_id/goal",
    transport: "json",
    request: request("session_id_params_v1", null, "goal_operation_intent_v1"),
    response: response("goal_control_snapshot_v1"),
    ...sessionWritePolicy,
    target: "managed_session",
    operation_kind: "goal",
    audit: selectedWriteAudit("goal"),
    handler: "controls.mutateGoal",
    owner_task: "IFC-V1-062"
  }),
  route({
    id: "plan_read",
    family: "controls",
    method: "GET",
    path: "/api/v1/sessions/:session_id/plan",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("plan_control_snapshot_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: "plan",
    audit: null,
    handler: "controls.readPlan",
    owner_task: "IFC-V1-063"
  }),
  route({
    id: "plan_select",
    family: "controls",
    method: "POST",
    path: "/api/v1/sessions/:session_id/plan",
    transport: "json",
    request: request("session_id_params_v1", null, "plan_operation_intent_v1"),
    response: response("plan_control_snapshot_v1"),
    ...sessionWritePolicy,
    target: "managed_session",
    operation_kind: "plan",
    audit: selectedWriteAudit("plan"),
    handler: "controls.selectPlan",
    owner_task: "IFC-V1-063"
  }),
  route({
    id: "usage_read",
    family: "controls",
    method: "GET",
    path: "/api/v1/sessions/:session_id/usage",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("usage_snapshot_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: "usage",
    audit: null,
    handler: "controls.readUsage",
    owner_task: "IFC-V1-043"
  }),
  route({
    id: "compact_read",
    family: "controls",
    method: "GET",
    path: "/api/v1/sessions/:session_id/compact",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("compact_progress_response_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: "compact",
    audit: null,
    handler: "controls.readCompact",
    owner_task: "IFC-V1-064"
  }),
  route({
    id: "compact_start",
    family: "controls",
    method: "POST",
    path: "/api/v1/sessions/:session_id/compact",
    transport: "json",
    request: request("session_id_params_v1", null, "compact_operation_intent_v1"),
    response: response("compact_progress_response_v1"),
    ...sessionWritePolicy,
    target: "managed_session",
    operation_kind: "compact",
    audit: selectedWriteAudit("compact"),
    handler: "controls.startCompact",
    owner_task: "IFC-V1-064"
  }),
  route({
    id: "skills_read",
    family: "controls",
    method: "GET",
    path: "/api/v1/sessions/:session_id/skills",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("skills_snapshot_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: "skills",
    audit: null,
    handler: "controls.readSkills",
    owner_task: "IFC-V1-065"
  }),
  route({
    id: "approval_list",
    family: "approvals",
    method: "GET",
    path: "/api/v1/sessions/:session_id/approvals",
    transport: "json",
    request: request("session_id_params_v1", null, null),
    response: response("pending_approval_list_response_v1"),
    ...sessionReadPolicy,
    target: "managed_session",
    operation_kind: null,
    audit: null,
    handler: "approvals.list",
    owner_task: "IFC-V1-044"
  }),
  route({
    id: "approval_respond",
    family: "approvals",
    method: "POST",
    path: "/api/v1/sessions/:session_id/approvals/:request_id/respond",
    transport: "json",
    request: request("session_approval_params_v1", null, "approval_response_operation_intent_v1"),
    response: response("pending_approval_response_v1"),
    ...sessionWritePolicy,
    target: "approval",
    operation_kind: "approval_response",
    audit: selectedWriteAudit("approval_response"),
    handler: "approvals.respond",
    owner_task: "IFC-V1-044"
  }),
  route({
    id: "turn_interrupt",
    family: "controls",
    method: "POST",
    path: "/api/v1/sessions/:session_id/turns/:turn_id/interrupt",
    transport: "json",
    request: request("session_turn_params_v1", null, "interrupt_operation_intent_v1"),
    response: response("selected_operation_progress_v1"),
    ...sessionWritePolicy,
    target: "turn",
    operation_kind: "interrupt",
    audit: selectedWriteAudit("interrupt"),
    handler: "controls.interruptTurn",
    owner_task: "IFC-V1-045"
  }),
  route({
    id: "pair_request",
    family: "access",
    method: "POST",
    path: "/api/v1/access/pairing-codes",
    transport: "json",
    request: request(null, null, "pair_request_v1"),
    response: response("pair_request_response_v1"),
    ...localAdminPolicy,
    target: "host",
    operation_kind: null,
    audit: securityAudit("pair_request"),
    handler: "access.createPairingCode",
    owner_task: "IFC-V1-028"
  }),
  route({
    id: "pair_claim",
    family: "access",
    method: "POST",
    path: "/api/v1/access/pairing-claims",
    transport: "json",
    request: request(null, null, "pair_claim_v1"),
    response: response("pair_claim_response_v1"),
    auth: "pairing_code",
    authority: "pair_claim",
    csrf: "none",
    lock: "not_applicable",
    target: "host",
    operation_kind: null,
    audit: securityAudit("pair_claim"),
    credential_effect: "set_device_cookie",
    handler: "access.claimPairingCode",
    owner_task: "IFC-V1-028"
  }),
  route({
    id: "csrf_bootstrap",
    family: "access",
    method: "POST",
    path: "/api/v1/access/csrf",
    transport: "json",
    request: request(null, null, "csrf_bootstrap_request_v1"),
    response: response("csrf_bootstrap_response_v1"),
    auth: "device_cookie",
    authority: "csrf_rotate",
    csrf: "rotate",
    lock: "not_applicable",
    target: "authenticated_device",
    operation_kind: null,
    audit: securityAudit("csrf_bootstrap"),
    credential_effect: "rotate_csrf",
    handler: "access.bootstrapCsrf",
    owner_task: "IFC-V1-027"
  }),
  route({
    id: "access_state",
    family: "access",
    method: "GET",
    path: "/api/v1/access",
    transport: "json",
    request: request(null, null, null),
    response: response("access_state_response_v1"),
    ...accessReadPolicy,
    target: "none",
    operation_kind: null,
    audit: null,
    handler: "access.readState",
    owner_task: "IFC-V1-030"
  }),
  route({
    id: "device_list",
    family: "access",
    method: "GET",
    path: "/api/v1/access/devices",
    transport: "json",
    request: request(null, "device_list_query_v1", null),
    response: response("device_list_response_v1"),
    ...deviceAdminReadPolicy,
    target: "none",
    operation_kind: null,
    audit: null,
    handler: "access.listDevices",
    owner_task: "IFC-V1-029"
  }),
  route({
    id: "device_revoke",
    family: "access",
    method: "POST",
    path: "/api/v1/access/devices/:device_id/revoke",
    transport: "json",
    request: request("device_id_params_v1", null, "device_revoke_request_v1"),
    response: response("device_revoke_response_v1"),
    ...deviceAdminWritePolicy,
    target: "device",
    operation_kind: null,
    audit: securityAudit("device_revoke"),
    credential_effect: "invalidate_device",
    handler: "access.revokeDevice",
    owner_task: "IFC-V1-059"
  }),
  route({
    id: "host_lock",
    family: "access",
    method: "POST",
    path: "/api/v1/access/lock",
    transport: "json",
    request: request(null, null, "lock_request_v1"),
    response: response("host_lock_state_response_v1"),
    ...hostLockPolicy,
    target: "host",
    operation_kind: null,
    audit: securityAudit("lock"),
    handler: "access.lockHost",
    owner_task: "IFC-V1-030"
  }),
  route({
    id: "host_unlock",
    family: "access",
    method: "POST",
    path: "/api/v1/access/unlock",
    transport: "json",
    request: request(null, null, "unlock_request_v1"),
    response: response("host_lock_state_response_v1"),
    auth: "local_admin",
    authority: "local_admin",
    csrf: "none",
    lock: "lock_transition",
    target: "host",
    operation_kind: null,
    audit: securityAudit("unlock"),
    handler: "access.unlockHost",
    owner_task: "IFC-V1-030"
  }),
  route({
    id: "network_state",
    family: "network",
    method: "GET",
    path: "/api/v1/network",
    transport: "json",
    request: request(null, null, null),
    response: response("network_state_response_v1"),
    ...accessReadPolicy,
    target: "host",
    operation_kind: null,
    audit: null,
    handler: "network.readState",
    owner_task: "IFC-V1-031"
  }),
  route({
    id: "network_configure",
    family: "network",
    method: "POST",
    path: "/api/v1/network/configure",
    transport: "json",
    request: request(null, null, "lan_configure_request_v1"),
    response: response("lan_mutation_response_v1"),
    ...localAdminPolicy,
    target: "host",
    operation_kind: null,
    audit: historicalSecurityAudit("lan_configure"),
    handler: "network.configure",
    owner_task: "IFC-V1-031"
  }),
  route({
    id: "network_enable",
    family: "network",
    method: "POST",
    path: "/api/v1/network/enable",
    transport: "json",
    request: request(null, null, "lan_enable_request_v1"),
    response: response("lan_mutation_response_v1"),
    ...localAdminPolicy,
    target: "host",
    operation_kind: null,
    audit: historicalSecurityAudit("lan_enable"),
    handler: "network.enable",
    owner_task: "IFC-V1-031"
  }),
  route({
    id: "network_disable",
    family: "network",
    method: "POST",
    path: "/api/v1/network/disable",
    transport: "json",
    request: request(null, null, "lan_disable_request_v1"),
    response: response("lan_mutation_response_v1"),
    ...localAdminPolicy,
    target: "host",
    operation_kind: null,
    audit: historicalSecurityAudit("lan_disable"),
    handler: "network.disable",
    owner_task: "IFC-V1-031"
  })
]);

type SelectedApiRouteInput = Omit<SelectedApiRouteManifestEntry, "credential_effect"> &
  Partial<Pick<SelectedApiRouteManifestEntry, "credential_effect">>;

function route(entry: SelectedApiRouteInput): SelectedApiRouteManifestEntry {
  return { ...entry, credential_effect: entry.credential_effect ?? "none" };
}

function request(
  params: SelectedApiSchemaId | null,
  query: SelectedApiSchemaId | null,
  body: SelectedApiSchemaId | null
): SelectedApiRequestContracts {
  return { params, query, body };
}

function response(success: SelectedApiSchemaId): SelectedApiResponseContracts {
  return { success, error: "selected_api_error_v1" };
}

function policy(
  auth: SelectedApiAuthMechanism,
  authority: SelectedApiAuthority,
  csrf: SelectedApiCsrfPolicy,
  lock: SelectedApiLockPolicy
): Pick<SelectedApiRouteManifestEntry, "auth" | "authority" | "csrf" | "lock"> {
  return Object.freeze({ auth, authority, csrf, lock });
}

function selectedWriteAudit(action: SelectedAuditAction): SelectedApiAuditContract {
  return { executor: "selected_write_gate", action, catalog_state: "selected", catalog_owner_task: null };
}

function securityAudit(action: SelectedAuditAction): SelectedApiAuditContract {
  return { executor: "security_executor", action, catalog_state: "selected", catalog_owner_task: null };
}

function historicalSecurityAudit(action: HistoricalSelectedNetworkAuditAction): SelectedApiAuditContract {
  return {
    executor: "security_executor",
    action,
    catalog_state: "historical",
    catalog_owner_task: "IFC-V1-075"
  };
}

function extensionAudit(
  executor: SelectedApiAuditExecutor,
  action: (typeof selectedApiAuditExtensions)[number],
  catalogOwnerTask: SelectedApiAuditCatalogOwnerTask
): SelectedApiAuditContract {
  return {
    executor,
    action,
    catalog_state: "owned_extension",
    catalog_owner_task: catalogOwnerTask
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
