import type { RemoteIngressFixtureId } from "./remote-ingress.js";
import type { SelectedMobileFixtureId, StructuredRuntimeFixtureId } from "./structured-runtime.js";

export const mobileReferenceViewports = [
  "phone_360x800",
  "phone_390x844",
  "phone_412x915",
  "tablet_768x1024",
  "desktop_1280x800"
] as const;
export type MobileReferenceViewport = (typeof mobileReferenceViewports)[number];

export const mobileJourneyIds = [
  "UX-001",
  "UX-002",
  "UX-003",
  "UX-004",
  "UX-005",
  "UX-006",
  "UX-007",
  "UX-008",
  "UX-009",
  "UX-010",
  "UX-011",
  "UX-012"
] as const;
export type MobileJourneyId = (typeof mobileJourneyIds)[number];

export const mobileSurfaceIds = [
  "browser_preload",
  "mission_control",
  "session_detail",
  "composer",
  "host_access",
  "pairing",
  "model",
  "goal",
  "plan",
  "usage",
  "compact",
  "skills",
  "approval",
  "event_details",
  "confirmation"
] as const;
export type MobileSurfaceId = (typeof mobileSurfaceIds)[number];

export const mobileContractIds = [
  "apiErrorEnvelopeSchema",
  "managedSessionProjectionSchema",
  "modelControlSnapshotSchema",
  "goalControlSnapshotSchema",
  "planControlSnapshotSchema",
  "pendingApprovalSchema",
  "remoteIngressPublicStateSchema",
  "remotePairingLinkIntentSchema",
  "requestIngressProvenanceSchema",
  "selectedAccessStateResponseSchema",
  "selectedControlStateSchema",
  "selectedCsrfBootstrapResponseSchema",
  "selectedDeviceListResponseSchema",
  "selectedDeviceRevokeResponseSchema",
  "selectedEventDiagnosticsSchema",
  "selectedHostAccessSchema",
  "selectedHostLockStateResponseSchema",
  "selectedLaptopResumeSchema",
  "selectedMissionControlViewModelSchema",
  "selectedOperationDispatchSchema",
  "selectedOperationProgressSchema",
  "selectedOperationTerminalOutcomeSchema",
  "selectedPairClaimResponseSchema",
  "selectedPairRequestResponseSchema",
  "selectedPromptControlSchema",
  "selectedSessionDetailViewModelSchema",
  "selectedSessionEventStreamSchema",
  "skillsSnapshotSchema",
  "usageSnapshotSchema"
] as const;
export type MobileContractId = (typeof mobileContractIds)[number];

export const mobileRouteIds = [
  "access_state",
  "approval_list",
  "approval_respond",
  "compact_read",
  "compact_start",
  "csrf_bootstrap",
  "device_list",
  "device_revoke",
  "goal_mutate",
  "goal_read",
  "host_lock",
  "host_status",
  "model_read",
  "model_select",
  "pair_claim",
  "plan_read",
  "plan_select",
  "prompt_dispatch",
  "remote_status",
  "session_archive",
  "session_detail",
  "session_event_stream",
  "session_events",
  "session_list",
  "session_resume_metadata",
  "skills_read",
  "turn_interrupt",
  "usage_read"
] as const;
export type MobileRouteId = (typeof mobileRouteIds)[number];

export const mobileFirstViewportElements = [
  "browser_error_only",
  "host_access_strip",
  "page_title",
  "session_rows_two",
  "session_identity",
  "project_and_status",
  "structured_feed",
  "inline_approval",
  "sticky_composer",
  "primary_controls",
  "current_value",
  "capability_status",
  "action_scope",
  "permission_and_lock",
  "remote_and_runtime_health",
  "pairing_status",
  "recovery_action",
  "boundary_notice",
  "confirmation_consequence",
  "diagnostic_limit_notice"
] as const;
export type MobileFirstViewportElement = (typeof mobileFirstViewportElements)[number];

export const mobileInteractionIds = [
  "bootstrap_shell",
  "create_pairing_link",
  "consume_pairing_fragment",
  "claim_pairing",
  "bootstrap_csrf",
  "read_remote_status",
  "enable_remote_local",
  "disable_remote_local",
  "switch_tailscale_profile_local",
  "read_host_access",
  "read_host_status",
  "read_sessions",
  "open_session",
  "read_session_detail",
  "navigate_back",
  "stream_events",
  "reconnect_stream",
  "send_prompt",
  "read_model",
  "select_model",
  "read_goal",
  "mutate_goal",
  "read_plan",
  "select_plan",
  "read_usage",
  "read_compact",
  "start_compact",
  "read_skills",
  "read_approvals",
  "respond_approval",
  "read_event_details",
  "interrupt_turn",
  "archive_session",
  "read_resume_metadata",
  "copy_resume_command",
  "read_devices",
  "revoke_device",
  "lock_host",
  "unlock_host_local"
] as const;
export type MobileInteractionId = (typeof mobileInteractionIds)[number];

export const mobileDownstreamTaskIds = [
  "FE-V1-002",
  "FE-V1-010",
  "FE-V1-011",
  "FE-V1-012",
  "FE-V1-013",
  "FE-V1-014",
  "FE-V1-015",
  "FE-V1-016",
  "FE-V1-019",
  "FE-V1-020",
  "FE-V1-021",
  "FE-V1-022",
  "FE-V1-023",
  "FE-V1-024",
  "FE-V1-025",
  "FE-V1-026",
  "FE-V1-027",
  "FE-V1-028",
  "FE-V1-029",
  "FE-V1-030",
  "FE-V1-031",
  "FE-V1-032",
  "FE-V1-033",
  "FE-V1-034",
  "FE-V1-035",
  "FE-V1-036",
  "FE-V1-037",
  "FE-V1-038",
  "FE-V1-039",
  "FE-V1-040"
] as const;
export type MobileDownstreamTaskId = (typeof mobileDownstreamTaskIds)[number];

export const mobileStateTraceIds = [
  "preload_phone_network_unavailable",
  "preload_remote_origin_unreachable",
  "mission_loading",
  "mission_empty",
  "mission_mixed_attention",
  "mission_all_quiet",
  "mission_read_only",
  "mission_locked",
  "mission_runtime_offline",
  "mission_runtime_incompatible",
  "mission_runtime_degraded",
  "mission_fatal",
  "mission_unpaired",
  "mission_expired",
  "mission_revoked",
  "mission_remote_disabled",
  "mission_tailscale_unavailable",
  "mission_profile_mismatch",
  "mission_serve_conflict",
  "mission_long_content",
  "mission_desktop_expansion",
  "detail_loading",
  "detail_active_writable",
  "detail_needs_input",
  "detail_approval",
  "detail_completed",
  "detail_interrupted",
  "detail_failed",
  "detail_unknown",
  "detail_stale",
  "detail_stream_reconnecting",
  "detail_replay_boundary",
  "detail_compacting",
  "detail_rate_limit",
  "detail_read_only",
  "detail_locked",
  "detail_not_found",
  "detail_runtime_incompatible",
  "detail_long_content",
  "detail_desktop_expansion",
  "composer_empty",
  "composer_composing",
  "composer_keyboard_open",
  "composer_submitting",
  "composer_accepted",
  "composer_running",
  "composer_completed",
  "composer_failed_retryable",
  "composer_failed_nonretryable",
  "composer_disabled_unpaired",
  "composer_disabled_read_only",
  "composer_disabled_locked",
  "composer_disabled_runtime",
  "composer_disabled_session",
  "composer_disabled_stream",
  "access_remote_ready",
  "access_loopback_ready",
  "access_unpaired",
  "access_expired",
  "access_revoked",
  "access_read_only",
  "access_locked",
  "access_remote_disabled",
  "access_tailscale_absent",
  "access_tailscale_stopped",
  "access_tailscale_signed_out",
  "access_profile_mismatch",
  "access_serve_absent",
  "access_serve_configuring",
  "access_serve_conflict",
  "access_profile_switch_boundary",
  "access_csrf_bootstrap",
  "access_csrf_failure",
  "access_stream_unavailable",
  "access_runtime_incompatible",
  "access_device_list",
  "pair_fragment_ready",
  "pair_claiming",
  "pair_paired",
  "pair_invalid",
  "pair_expired",
  "pair_used",
  "pair_rate_limited",
  "pair_remote_unreachable",
  "model_current",
  "model_loading",
  "model_unsupported",
  "model_conflict",
  "model_accepted",
  "model_success",
  "model_failure",
  "goal_current",
  "goal_loading",
  "goal_unsupported",
  "goal_conflict",
  "goal_accepted",
  "goal_success",
  "goal_failure",
  "plan_current",
  "plan_loading",
  "plan_unsupported",
  "plan_conflict",
  "plan_accepted",
  "plan_success",
  "plan_failure",
  "usage_loading",
  "usage_content",
  "usage_empty",
  "usage_stale",
  "usage_unsupported",
  "usage_failure",
  "compact_confirmation",
  "compact_accepted",
  "compact_running",
  "compact_completed",
  "compact_conflict",
  "compact_unsupported",
  "compact_failure",
  "skills_loading",
  "skills_content",
  "skills_empty",
  "skills_partial",
  "skills_unsupported",
  "skills_failure",
  "approval_pending",
  "approval_elevated_confirmation",
  "approval_responding",
  "approval_approved",
  "approval_denied",
  "approval_expired",
  "approval_superseded",
  "approval_reconnecting",
  "event_complete",
  "event_truncated",
  "event_boundary",
  "event_redacted",
  "event_unknown",
  "confirm_interrupt",
  "confirm_archive",
  "confirm_lock",
  "confirm_revoke"
] as const;
export type MobileStateTraceId = (typeof mobileStateTraceIds)[number];

export type MobileFixtureReference =
  | { readonly family: "selected_mobile"; readonly id: SelectedMobileFixtureId }
  | { readonly family: "structured_runtime"; readonly id: StructuredRuntimeFixtureId }
  | { readonly family: "remote_ingress"; readonly id: RemoteIngressFixtureId }
  | { readonly family: "remote_pairing_link"; readonly id: "fragment_link" };

export interface MobileStateTrace {
  readonly id: MobileStateTraceId;
  readonly surface: MobileSurfaceId;
  readonly state: string;
  readonly renderBoundary: "browser_preload" | "hostdeck_app";
  readonly diagnosisSource:
    | "browser_network_only"
    | "application_authority"
    | "hostdeck_local_observation"
    | "hostdeck_remote_observation"
    | "runtime_projection"
    | "user_interaction";
  readonly dataDisclosure: "none" | "access_only" | "session_list" | "session_detail";
  readonly firstViewport: readonly MobileFirstViewportElement[];
  readonly contracts: readonly MobileContractId[];
  readonly fixtureRefs: readonly MobileFixtureReference[];
  readonly journeys: readonly MobileJourneyId[];
  readonly interactions: readonly MobileInteractionId[];
  readonly viewports: readonly MobileReferenceViewport[];
  readonly downstreamTasks: readonly MobileDownstreamTaskId[];
  readonly mockupRequired: boolean;
}

export interface MobileInteractionTrace {
  readonly id: MobileInteractionId;
  readonly uiOwner: MobileSurfaceId | "local_only";
  readonly executionOwner: "browser" | "hostdeck_api" | "hostdeck_cli" | "laptop_user";
  readonly routeId: MobileRouteId | null;
  readonly authority:
    | "none"
    | "optional_device"
    | "paired_read"
    | "paired_write_or_local_admin"
    | "pairing_code"
    | "local_admin"
    | "external_user";
  readonly mutation: boolean;
  readonly operationIdRequired: boolean;
  readonly automaticRetry: false;
  readonly confirmation: "none" | "always" | "risk_dependent";
  readonly exactTarget: "none" | "host" | "session" | "turn" | "approval" | "device";
  readonly resultContracts: readonly MobileContractId[];
  readonly downstreamTask: MobileDownstreamTaskId;
}

const noRetry = false as const;

export const mobileInteractionTraces: readonly MobileInteractionTrace[] = Object.freeze([
  interaction("bootstrap_shell", "mission_control", "browser", null, "none", false, false, "none", "host", [
    "selectedHostAccessSchema"
  ], "FE-V1-025"),
  interaction("create_pairing_link", "local_only", "hostdeck_cli", null, "local_admin", true, true, "always", "host", [
    "selectedPairRequestResponseSchema",
    "remotePairingLinkIntentSchema"
  ], "FE-V1-013"),
  interaction("consume_pairing_fragment", "pairing", "browser", null, "none", false, false, "none", "none", [
    "remotePairingLinkIntentSchema"
  ], "FE-V1-013"),
  interaction("claim_pairing", "pairing", "hostdeck_api", "pair_claim", "pairing_code", true, true, "none", "host", [
    "selectedPairClaimResponseSchema",
    "apiErrorEnvelopeSchema"
  ], "FE-V1-013"),
  interaction("bootstrap_csrf", "host_access", "hostdeck_api", "csrf_bootstrap", "paired_read", true, true, "none", "device", [
    "selectedCsrfBootstrapResponseSchema",
    "apiErrorEnvelopeSchema"
  ], "FE-V1-024"),
  interaction("read_remote_status", "host_access", "hostdeck_api", "remote_status", "paired_read", false, false, "none", "host", [
    "remoteIngressPublicStateSchema"
  ], "FE-V1-034"),
  interaction("enable_remote_local", "local_only", "hostdeck_cli", null, "local_admin", true, true, "always", "host", [
    "remoteIngressPublicStateSchema"
  ], "FE-V1-034"),
  interaction("disable_remote_local", "local_only", "hostdeck_cli", null, "local_admin", true, true, "always", "host", [
    "remoteIngressPublicStateSchema"
  ], "FE-V1-034"),
  interaction("switch_tailscale_profile_local", "local_only", "laptop_user", null, "external_user", true, false, "always", "host", [], "FE-V1-034"),
  interaction("read_host_access", "host_access", "hostdeck_api", "access_state", "optional_device", false, false, "none", "host", [
    "selectedAccessStateResponseSchema"
  ], "FE-V1-013"),
  interaction("read_host_status", "host_access", "hostdeck_api", "host_status", "paired_read", false, false, "none", "host", [
    "selectedHostAccessSchema"
  ], "FE-V1-025"),
  interaction("read_sessions", "mission_control", "hostdeck_api", "session_list", "paired_read", false, false, "none", "host", [
    "selectedMissionControlViewModelSchema"
  ], "FE-V1-011"),
  interaction("open_session", "mission_control", "browser", null, "none", false, false, "none", "session", [
    "managedSessionProjectionSchema"
  ], "FE-V1-010"),
  interaction("read_session_detail", "session_detail", "hostdeck_api", "session_detail", "paired_read", false, false, "none", "session", [
    "selectedSessionDetailViewModelSchema"
  ], "FE-V1-012"),
  interaction("navigate_back", "session_detail", "browser", null, "none", false, false, "none", "none", [], "FE-V1-010"),
  interaction("stream_events", "session_detail", "hostdeck_api", "session_event_stream", "paired_read", false, false, "none", "session", [
    "selectedSessionEventStreamSchema"
  ], "FE-V1-023"),
  interaction("reconnect_stream", "session_detail", "browser", null, "none", false, false, "none", "session", [
    "selectedSessionEventStreamSchema"
  ], "FE-V1-023"),
  interaction("send_prompt", "session_detail", "hostdeck_api", "prompt_dispatch", "paired_write_or_local_admin", true, true, "none", "session", [
    "selectedPromptControlSchema",
    "selectedOperationDispatchSchema",
    "selectedOperationProgressSchema"
  ], "FE-V1-020"),
  interaction("read_model", "model", "hostdeck_api", "model_read", "paired_read", false, false, "none", "session", [
    "modelControlSnapshotSchema"
  ], "FE-V1-021"),
  interaction("select_model", "model", "hostdeck_api", "model_select", "paired_write_or_local_admin", true, true, "none", "session", [
    "modelControlSnapshotSchema",
    "selectedOperationDispatchSchema"
  ], "FE-V1-021"),
  interaction("read_goal", "goal", "hostdeck_api", "goal_read", "paired_read", false, false, "none", "session", [
    "goalControlSnapshotSchema"
  ], "FE-V1-026"),
  interaction("mutate_goal", "goal", "hostdeck_api", "goal_mutate", "paired_write_or_local_admin", true, true, "risk_dependent", "session", [
    "goalControlSnapshotSchema",
    "selectedOperationDispatchSchema"
  ], "FE-V1-026"),
  interaction("read_plan", "plan", "hostdeck_api", "plan_read", "paired_read", false, false, "none", "session", [
    "planControlSnapshotSchema"
  ], "FE-V1-027"),
  interaction("select_plan", "plan", "hostdeck_api", "plan_select", "paired_write_or_local_admin", true, true, "none", "session", [
    "planControlSnapshotSchema",
    "selectedOperationDispatchSchema"
  ], "FE-V1-027"),
  interaction("read_usage", "usage", "hostdeck_api", "usage_read", "paired_read", false, false, "none", "session", [
    "usageSnapshotSchema"
  ], "FE-V1-028"),
  interaction("read_compact", "compact", "hostdeck_api", "compact_read", "paired_read", false, false, "none", "session", [
    "selectedControlStateSchema"
  ], "FE-V1-029"),
  interaction("start_compact", "compact", "hostdeck_api", "compact_start", "paired_write_or_local_admin", true, true, "always", "session", [
    "selectedOperationDispatchSchema",
    "selectedOperationProgressSchema"
  ], "FE-V1-029"),
  interaction("read_skills", "skills", "hostdeck_api", "skills_read", "paired_read", false, false, "none", "session", [
    "skillsSnapshotSchema"
  ], "FE-V1-030"),
  interaction("read_approvals", "approval", "hostdeck_api", "approval_list", "paired_read", false, false, "none", "session", [
    "pendingApprovalSchema"
  ], "FE-V1-022"),
  interaction("respond_approval", "approval", "hostdeck_api", "approval_respond", "paired_write_or_local_admin", true, true, "risk_dependent", "approval", [
    "pendingApprovalSchema",
    "selectedOperationDispatchSchema",
    "selectedOperationTerminalOutcomeSchema"
  ], "FE-V1-022"),
  interaction("read_event_details", "event_details", "hostdeck_api", "session_events", "paired_read", false, false, "none", "session", [
    "selectedEventDiagnosticsSchema"
  ], "FE-V1-014"),
  interaction("interrupt_turn", "confirmation", "hostdeck_api", "turn_interrupt", "paired_write_or_local_admin", true, true, "always", "turn", [
    "selectedOperationDispatchSchema",
    "selectedOperationTerminalOutcomeSchema"
  ], "FE-V1-036"),
  interaction("archive_session", "confirmation", "hostdeck_api", "session_archive", "paired_write_or_local_admin", true, true, "always", "session", [
    "selectedOperationDispatchSchema",
    "selectedOperationTerminalOutcomeSchema"
  ], "FE-V1-037"),
  interaction("read_resume_metadata", "session_detail", "hostdeck_api", "session_resume_metadata", "paired_read", false, false, "none", "session", [
    "selectedLaptopResumeSchema"
  ], "FE-V1-038"),
  interaction("copy_resume_command", "session_detail", "browser", null, "none", false, false, "none", "session", [
    "selectedLaptopResumeSchema"
  ], "FE-V1-038"),
  interaction("read_devices", "host_access", "hostdeck_api", "device_list", "paired_read", false, false, "none", "host", [
    "selectedDeviceListResponseSchema"
  ], "FE-V1-032"),
  interaction("revoke_device", "confirmation", "hostdeck_api", "device_revoke", "paired_write_or_local_admin", true, true, "always", "device", [
    "selectedDeviceRevokeResponseSchema",
    "apiErrorEnvelopeSchema"
  ], "FE-V1-032"),
  interaction("lock_host", "confirmation", "hostdeck_api", "host_lock", "paired_write_or_local_admin", true, true, "always", "host", [
    "selectedHostLockStateResponseSchema"
  ], "FE-V1-033"),
  interaction("unlock_host_local", "local_only", "hostdeck_cli", null, "local_admin", true, true, "always", "host", [
    "selectedHostLockStateResponseSchema"
  ], "FE-V1-033")
]);

function interaction(
  id: MobileInteractionId,
  uiOwner: MobileInteractionTrace["uiOwner"],
  executionOwner: MobileInteractionTrace["executionOwner"],
  routeId: MobileRouteId | null,
  authority: MobileInteractionTrace["authority"],
  mutation: boolean,
  operationIdRequired: boolean,
  confirmation: MobileInteractionTrace["confirmation"],
  exactTarget: MobileInteractionTrace["exactTarget"],
  resultContracts: readonly MobileContractId[],
  downstreamTask: MobileDownstreamTaskId
): MobileInteractionTrace {
  return Object.freeze({
    id,
    uiOwner,
    executionOwner,
    routeId,
    authority,
    mutation,
    operationIdRequired,
    automaticRetry: noRetry,
    confirmation,
    exactTarget,
    resultContracts: Object.freeze([...resultContracts]),
    downstreamTask
  });
}

const allReferenceViewports: readonly MobileReferenceViewport[] = mobileReferenceViewports;
const phoneReferenceViewports: readonly MobileReferenceViewport[] = [
  "phone_360x800",
  "phone_390x844",
  "phone_412x915"
];
const missionFirstViewport: readonly MobileFirstViewportElement[] = [
  "host_access_strip",
  "page_title",
  "session_rows_two"
];
const detailFirstViewport: readonly MobileFirstViewportElement[] = [
  "session_identity",
  "project_and_status",
  "structured_feed",
  "sticky_composer",
  "primary_controls"
];
const accessFirstViewport: readonly MobileFirstViewportElement[] = [
  "permission_and_lock",
  "remote_and_runtime_health",
  "recovery_action"
];
const controlFirstViewport: readonly MobileFirstViewportElement[] = [
  "page_title",
  "session_identity",
  "current_value",
  "capability_status",
  "action_scope"
];

export const mobileStateTraces: readonly MobileStateTrace[] = Object.freeze([
  stateTrace({
    id: "preload_phone_network_unavailable",
    surface: "browser_preload",
    state: "phone network or Tailscale path unavailable before document load",
    renderBoundary: "browser_preload",
    diagnosisSource: "browser_network_only",
    dataDisclosure: "none",
    firstViewport: ["browser_error_only"],
    contracts: [],
    fixtureRefs: [],
    journeys: ["UX-001", "UX-009", "UX-012"],
    interactions: ["bootstrap_shell"],
    viewports: phoneReferenceViewports,
    downstreamTasks: ["FE-V1-013", "FE-V1-019", "FE-V1-025", "FE-V1-034", "FE-V1-040"],
    mockupRequired: false
  }),
  stateTrace({
    id: "preload_remote_origin_unreachable",
    surface: "browser_preload",
    state: "private HTTPS origin cannot be reached before document load",
    renderBoundary: "browser_preload",
    diagnosisSource: "browser_network_only",
    dataDisclosure: "none",
    firstViewport: ["browser_error_only"],
    contracts: [],
    fixtureRefs: [],
    journeys: ["UX-001", "UX-009", "UX-012"],
    interactions: ["bootstrap_shell"],
    viewports: phoneReferenceViewports,
    downstreamTasks: ["FE-V1-013", "FE-V1-019", "FE-V1-025", "FE-V1-034", "FE-V1-040"],
    mockupRequired: false
  }),
  missionTrace("mission_loading", "loading", [selectedMobile("mission_control_loading")], ["bootstrap_shell"], ["FE-V1-010", "FE-V1-025"]),
  missionTrace("mission_empty", "empty", [selectedMobile("mission_control_empty")], ["read_sessions"], ["FE-V1-011"]),
  missionTrace(
    "mission_mixed_attention",
    "mixed attention ordered approval, input, failure, stale, running, quiet",
    [selectedMobile("mission_control_ready"), structuredRuntime("approval"), structuredRuntime("needs_input"), structuredRuntime("failed")],
    ["read_sessions", "open_session"],
    ["FE-V1-011"],
    { journeys: ["UX-002"], mockupRequired: true }
  ),
  missionTrace(
    "mission_all_quiet",
    "all sessions quiet or completed",
    [selectedMobile("mission_control_all_quiet"), structuredRuntime("completed")],
    ["read_sessions", "open_session"],
    ["FE-V1-011"],
    { journeys: ["UX-002"] }
  ),
  missionTrace(
    "mission_read_only",
    "paired read-only",
    [selectedMobile("mission_control_read_only")],
    ["read_sessions", "open_session"],
    ["FE-V1-011", "FE-V1-013"],
    { diagnosisSource: "application_authority", journeys: ["UX-002", "UX-011"], mockupRequired: true }
  ),
  missionTrace(
    "mission_locked",
    "paired writer with host writes locked",
    [selectedMobile("mission_control_locked")],
    ["read_sessions", "open_session"],
    ["FE-V1-011", "FE-V1-033"],
    { diagnosisSource: "application_authority", journeys: ["UX-002", "UX-011"], mockupRequired: true }
  ),
  missionTrace(
    "mission_runtime_offline",
    "last bounded projection with runtime disconnected",
    [selectedMobile("mission_control_offline"), structuredRuntime("disconnect")],
    ["read_sessions", "open_session", "reconnect_stream"],
    ["FE-V1-011", "FE-V1-015", "FE-V1-025", "FE-V1-035"],
    { journeys: ["UX-002", "UX-009"] }
  ),
  missionTrace(
    "mission_runtime_incompatible",
    "installed Codex incompatible",
    [selectedMobile("mission_control_incompatible"), structuredRuntime("incompatible")],
    ["read_sessions", "open_session"],
    ["FE-V1-011", "FE-V1-035"],
    { journeys: ["UX-002", "UX-004", "UX-005", "UX-006"] }
  ),
  missionTrace(
    "mission_runtime_degraded",
    "required runtime available with optional capability degraded",
    [selectedMobile("mission_control_degraded"), structuredRuntime("unknown_optional")],
    ["read_sessions", "open_session"],
    ["FE-V1-011", "FE-V1-035"],
    { journeys: ["UX-002"] }
  ),
  missionTrace(
    "mission_fatal",
    "host cannot provide a trustworthy projection",
    [selectedMobile("mission_control_fatal")],
    ["bootstrap_shell"],
    ["FE-V1-011", "FE-V1-015", "FE-V1-025"],
    { dataDisclosure: "access_only" }
  ),
  missionTrace(
    "mission_unpaired",
    "reachable but unpaired",
    [selectedMobile("mission_control_unpaired")],
    ["consume_pairing_fragment", "claim_pairing"],
    ["FE-V1-013"],
    { diagnosisSource: "application_authority", dataDisclosure: "access_only", journeys: ["UX-001"], mockupRequired: true }
  ),
  missionTrace(
    "mission_expired",
    "paired-device authority expired",
    [selectedMobile("mission_control_expired")],
    ["claim_pairing"],
    ["FE-V1-013", "FE-V1-031"],
    { diagnosisSource: "application_authority", dataDisclosure: "access_only", journeys: ["UX-001", "UX-011"] }
  ),
  missionTrace(
    "mission_revoked",
    "paired-device authority revoked",
    [selectedMobile("mission_control_revoked")],
    ["claim_pairing"],
    ["FE-V1-013", "FE-V1-031", "FE-V1-032"],
    { diagnosisSource: "application_authority", dataDisclosure: "access_only", journeys: ["UX-001", "UX-011"] }
  ),
  remoteMissionTrace("mission_remote_disabled", "remote access disabled locally", "disabled", ["FE-V1-034"], true),
  remoteMissionTrace("mission_tailscale_unavailable", "laptop Tailscale unavailable", "profile_stopped", ["FE-V1-034"], true),
  remoteMissionTrace("mission_profile_mismatch", "different laptop Tailscale profile active", "profile_other", ["FE-V1-034"], true),
  remoteMissionTrace("mission_serve_conflict", "private Serve ownership conflict", "serve_colliding", ["FE-V1-034"], true),
  missionTrace(
    "mission_long_content",
    "maximum bounded names, project cues, summaries, and errors",
    [selectedMobile("mission_control_long_content"), structuredRuntime("long_content")],
    ["read_sessions", "open_session"],
    ["FE-V1-011", "FE-V1-016", "FE-V1-039"],
    { journeys: ["UX-002"], viewports: allReferenceViewports }
  ),
  missionTrace(
    "mission_desktop_expansion",
    "same mission hierarchy expanded to list-detail split",
    [selectedMobile("mission_control_ready")],
    ["read_sessions", "open_session"],
    ["FE-V1-010", "FE-V1-011", "FE-V1-016"],
    { journeys: ["UX-002"], viewports: ["desktop_1280x800"], mockupRequired: true }
  ),
  detailTrace("detail_loading", "loading", "session_detail_loading", null, ["bootstrap_shell"], ["FE-V1-012", "FE-V1-025"]),
  detailTrace(
    "detail_active_writable",
    "active writable turn",
    "session_detail_running",
    "running",
    [
      "stream_events",
      "send_prompt",
      "read_model",
      "read_goal",
      "read_plan",
      "read_resume_metadata",
      "copy_resume_command"
    ],
    ["FE-V1-012", "FE-V1-020", "FE-V1-021", "FE-V1-026", "FE-V1-027"],
    { journeys: ["UX-003", "UX-004", "UX-005", "UX-010"], mockupRequired: true }
  ),
  detailTrace("detail_needs_input", "waiting for user input", "session_detail_needs_input", "needs_input", ["stream_events", "send_prompt"], ["FE-V1-012", "FE-V1-020"], {
    journeys: ["UX-003"]
  }),
  detailTrace("detail_approval", "inline approval pending", "session_detail_approval", "approval", ["stream_events", "read_approvals", "respond_approval"], ["FE-V1-012", "FE-V1-022"], {
    journeys: ["UX-007"],
    firstViewport: [...detailFirstViewport, "inline_approval"],
    mockupRequired: true
  }),
  detailTrace("detail_completed", "turn completed", "session_detail_completed", "completed", ["stream_events", "send_prompt"], ["FE-V1-012", "FE-V1-020"]),
  detailTrace("detail_interrupted", "turn interrupted", "session_detail_interrupted", "interrupted", ["stream_events", "send_prompt"], ["FE-V1-012", "FE-V1-015", "FE-V1-036"]),
  detailTrace("detail_failed", "turn failed", "session_detail_failed", "failed", ["stream_events", "send_prompt"], ["FE-V1-012", "FE-V1-015", "FE-V1-020"]),
  detailTrace("detail_unknown", "unknown structured event or state", "session_detail_unknown", "unknown_optional", ["stream_events", "read_event_details"], ["FE-V1-012", "FE-V1-014", "FE-V1-015"]),
  detailTrace("detail_stale", "stale retained projection", "session_detail_stale", "disconnect", ["reconnect_stream", "read_event_details"], ["FE-V1-012", "FE-V1-015", "FE-V1-023", "FE-V1-025"], {
    journeys: ["UX-009"]
  }),
  detailTrace("detail_stream_reconnecting", "stream reconnecting with retained projection", "session_detail_stream_reconnecting", "disconnect", ["reconnect_stream"], ["FE-V1-012", "FE-V1-015", "FE-V1-023", "FE-V1-025"], {
    journeys: ["UX-009"]
  }),
  detailTrace("detail_replay_boundary", "replay continuity boundary", "session_detail_boundary", "replay_boundary", ["stream_events", "read_event_details"], ["FE-V1-012", "FE-V1-014", "FE-V1-015", "FE-V1-023"], {
    journeys: ["UX-009"],
    firstViewport: [...detailFirstViewport, "boundary_notice"],
    mockupRequired: true
  }),
  detailTrace("detail_compacting", "context compaction accepted but not yet proven complete", "session_detail_compacting", "compacting", ["stream_events", "read_compact"], ["FE-V1-012", "FE-V1-029"]),
  detailTrace("detail_rate_limit", "rate limit observed while turn remains active", "session_detail_rate_limit", "rate_limit", ["stream_events", "read_usage"], ["FE-V1-012", "FE-V1-028", "FE-V1-035"]),
  detailTrace("detail_read_only", "paired read-only session", "session_detail_read_only", "completed", ["stream_events", "read_usage", "read_skills"], ["FE-V1-012", "FE-V1-013"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-003", "UX-011"],
    mockupRequired: true
  }),
  detailTrace("detail_locked", "session reads available while host writes are locked", "session_detail_locked", "completed", ["stream_events", "read_usage", "read_skills"], ["FE-V1-012", "FE-V1-033"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-011"],
    mockupRequired: true
  }),
  detailTrace("detail_not_found", "authorized session not found or archived", "session_detail_not_found", null, ["navigate_back"], ["FE-V1-012", "FE-V1-025"], {
    dataDisclosure: "access_only"
  }),
  detailTrace("detail_runtime_incompatible", "session retained but runtime incompatible", "session_detail_incompatible", "incompatible", ["read_event_details", "read_resume_metadata"], ["FE-V1-012", "FE-V1-035"]),
  detailTrace("detail_long_content", "maximum bounded feed, labels, paths, model, goal, and error copy", "session_detail_long_content", "long_content", ["stream_events", "read_event_details"], ["FE-V1-012", "FE-V1-014", "FE-V1-016", "FE-V1-039"], {
    viewports: allReferenceViewports
  }),
  detailTrace("detail_desktop_expansion", "same detail hierarchy beside Mission Control", "session_detail_ready", "running", ["stream_events", "send_prompt"], ["FE-V1-010", "FE-V1-012", "FE-V1-016"], {
    viewports: ["desktop_1280x800"],
    mockupRequired: true
  }),
  ...composerStateTraces(),
  accessTrace("access_remote_ready", "remote origin ready and paired writer", [selectedMobile("mission_control_ready"), remoteIngress("ready")], ["read_host_status", "read_remote_status", "read_devices", "lock_host"], ["FE-V1-013", "FE-V1-032", "FE-V1-033", "FE-V1-034"], {
    diagnosisSource: "hostdeck_remote_observation",
    journeys: ["UX-001", "UX-011", "UX-012"],
    mockupRequired: true
  }),
  accessTrace("access_loopback_ready", "loopback local admin with remote status visible", [remoteIngress("ready")], ["read_host_status", "read_remote_status", "create_pairing_link", "enable_remote_local", "disable_remote_local", "unlock_host_local"], ["FE-V1-013", "FE-V1-033", "FE-V1-034"], {
    diagnosisSource: "hostdeck_local_observation",
    journeys: ["UX-001", "UX-011", "UX-012"]
  }),
  accessTrace("access_unpaired", "reachable remote origin without app pairing", [selectedMobile("mission_control_unpaired")], ["consume_pairing_fragment", "claim_pairing"], ["FE-V1-013"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-001"],
    mockupRequired: true
  }),
  accessTrace("access_expired", "paired-device authority expired", [selectedMobile("mission_control_expired")], ["claim_pairing"], ["FE-V1-013", "FE-V1-031"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-001", "UX-011"]
  }),
  accessTrace("access_revoked", "paired-device authority revoked", [selectedMobile("mission_control_revoked")], ["claim_pairing"], ["FE-V1-013", "FE-V1-031", "FE-V1-032"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-001", "UX-011"]
  }),
  accessTrace("access_read_only", "paired read-only device", [selectedMobile("mission_control_read_only")], ["read_devices", "read_remote_status"], ["FE-V1-013", "FE-V1-032"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-011"]
  }),
  accessTrace("access_locked", "paired writer with remote writes locked", [selectedMobile("mission_control_locked")], ["read_devices", "lock_host"], ["FE-V1-013", "FE-V1-033"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-011"],
    mockupRequired: true
  }),
  remoteAccessTrace("access_remote_disabled", "remote access disabled", "disabled", true),
  remoteAccessTrace("access_tailscale_absent", "Tailscale client absent on laptop", "client_not_installed"),
  remoteAccessTrace("access_tailscale_stopped", "Tailscale client stopped on laptop", "profile_stopped"),
  remoteAccessTrace("access_tailscale_signed_out", "Tailscale signed out on laptop", "profile_signed_out"),
  remoteAccessTrace("access_profile_mismatch", "different saved laptop profile active", "profile_other", true),
  remoteAccessTrace("access_serve_absent", "owned private Serve mapping absent", "serve_absent"),
  remoteAccessTrace("access_serve_configuring", "local Serve enable accepted but exact read-back is pending", "serve_absent"),
  remoteAccessTrace("access_serve_conflict", "Serve mapping foreign, colliding, drifted, or public", "serve_colliding", true),
  accessTrace("access_profile_switch_boundary", "loaded connection closes while the laptop changes active profile", [selectedMobile("mission_control_profile_mismatch"), remoteIngress("profile_other")], ["read_remote_status", "reconnect_stream", "switch_tailscale_profile_local"], ["FE-V1-025", "FE-V1-034"], {
    diagnosisSource: "hostdeck_local_observation",
    journeys: ["UX-009", "UX-012"]
  }),
  accessTrace("access_csrf_bootstrap", "paired cookie accepted while in-memory CSRF authority is loading", [selectedMobile("mission_control_ready")], ["bootstrap_csrf"], ["FE-V1-024", "FE-V1-031"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-001", "UX-011"],
    contracts: ["selectedHostAccessSchema", "selectedCsrfBootstrapResponseSchema"]
  }),
  accessTrace("access_csrf_failure", "CSRF bootstrap failed or became stale; writes remain disabled", [selectedMobile("mission_control_read_only")], ["bootstrap_csrf"], ["FE-V1-024", "FE-V1-031"], {
    diagnosisSource: "application_authority",
    journeys: ["UX-001", "UX-009", "UX-011"],
    contracts: ["selectedHostAccessSchema", "selectedCsrfBootstrapResponseSchema", "apiErrorEnvelopeSchema"]
  }),
  accessTrace("access_stream_unavailable", "app is loaded but event stream is unavailable", [selectedMobile("mission_control_offline"), structuredRuntime("disconnect")], ["reconnect_stream"], ["FE-V1-013", "FE-V1-023", "FE-V1-025"], {
    journeys: ["UX-009"]
  }),
  accessTrace("access_runtime_incompatible", "Codex compatibility blocks controls", [selectedMobile("mission_control_incompatible"), structuredRuntime("incompatible")], ["read_remote_status"], ["FE-V1-013", "FE-V1-035"]),
  accessTrace("access_device_list", "bounded device list and revocation entry", [selectedMobile("mission_control_ready")], ["read_devices", "revoke_device"], ["FE-V1-032"], {
    journeys: ["UX-011"]
  }),
  pairingTrace("pair_fragment_ready", "fragment consumed and removed before request", [remotePairingLink()], ["consume_pairing_fragment", "claim_pairing"], false),
  pairingTrace("pair_claiming", "one exact claim in flight", [remotePairingLink()], ["claim_pairing"], true),
  pairingTrace("pair_paired", "paired permission returned; CSRF bootstrap required", [remotePairingLink()], ["claim_pairing", "bootstrap_csrf"], true),
  pairingTrace("pair_invalid", "invalid claim material", [remotePairingLink()], ["claim_pairing"], false),
  pairingTrace("pair_expired", "claim material expired", [remotePairingLink()], ["claim_pairing"], false),
  pairingTrace("pair_used", "claim material already consumed", [remotePairingLink()], ["claim_pairing"], false),
  pairingTrace("pair_rate_limited", "claim rate limit reached", [remotePairingLink()], ["claim_pairing"], false),
  pairingTrace("pair_remote_unreachable", "claim origin becomes unreachable", [remotePairingLink()], ["claim_pairing"], false),
  ...controlStateTraces("model", ["current", "loading", "unsupported", "conflict", "accepted", "success", "failure"], "UX-004", "FE-V1-021", ["read_model", "select_model"], "modelControlSnapshotSchema"),
  ...controlStateTraces("goal", ["current", "loading", "unsupported", "conflict", "accepted", "success", "failure"], "UX-005", "FE-V1-026", ["read_goal", "mutate_goal"], "goalControlSnapshotSchema"),
  ...controlStateTraces("plan", ["current", "loading", "unsupported", "conflict", "accepted", "success", "failure"], "UX-005", "FE-V1-027", ["read_plan", "select_plan"], "planControlSnapshotSchema"),
  ...controlStateTraces("usage", ["loading", "content", "empty", "stale", "unsupported", "failure"], "UX-006", "FE-V1-028", ["read_usage"], "usageSnapshotSchema"),
  ...controlStateTraces("compact", ["confirmation", "accepted", "running", "completed", "conflict", "unsupported", "failure"], "UX-006", "FE-V1-029", ["read_compact", "start_compact"], "selectedOperationProgressSchema"),
  ...controlStateTraces("skills", ["loading", "content", "empty", "partial", "unsupported", "failure"], "UX-006", "FE-V1-030", ["read_skills"], "skillsSnapshotSchema"),
  approvalTrace("approval_pending", "pending one-time request", "approval", ["read_approvals", "respond_approval"], false),
  approvalTrace("approval_elevated_confirmation", "elevated or broad request awaiting confirmation", "approval", ["respond_approval"], true),
  approvalTrace("approval_responding", "exact request decision in flight; duplicate disabled", "approval", ["respond_approval"], false),
  approvalTrace("approval_approved", "approved with exact audit result", "approval", ["read_approvals"], false),
  approvalTrace("approval_denied", "denied with exact audit result", "approval", ["read_approvals"], false),
  approvalTrace("approval_expired", "expired and read-only", "approval", ["read_approvals"], false),
  approvalTrace("approval_superseded", "superseded and read-only", "approval", ["read_approvals"], false),
  approvalTrace("approval_reconnecting", "decision outcome unresolved while stream reconnects", "disconnect", ["read_approvals", "reconnect_stream"], false),
  eventTrace("event_complete", "complete bounded structured event", "running"),
  eventTrace("event_truncated", "projection content truncated with notice", "running"),
  eventTrace("event_boundary", "replay boundary with continuity reset", "replay_boundary"),
  eventTrace("event_redacted", "sensitive fields redacted with notice", "approval"),
  eventTrace("event_unknown", "unsupported optional event preserved as diagnostic", "unknown_optional"),
  confirmationTrace("confirm_interrupt", "interrupt exact active turn", "interrupt_turn", "FE-V1-036", "UX-008"),
  confirmationTrace("confirm_archive", "archive exact managed session without claiming deletion", "archive_session", "FE-V1-037", "UX-008"),
  confirmationTrace("confirm_lock", "lock all remote writes", "lock_host", "FE-V1-033", "UX-011"),
  confirmationTrace("confirm_revoke", "revoke exact paired device", "revoke_device", "FE-V1-032", "UX-011")
]);

function stateTrace(trace: MobileStateTrace): MobileStateTrace {
  return Object.freeze({
    ...trace,
    firstViewport: Object.freeze([...trace.firstViewport]),
    contracts: Object.freeze([...trace.contracts]),
    fixtureRefs: Object.freeze([...trace.fixtureRefs]),
    journeys: Object.freeze([...trace.journeys]),
    interactions: Object.freeze([...trace.interactions]),
    viewports: Object.freeze([...trace.viewports]),
    downstreamTasks: Object.freeze([...trace.downstreamTasks])
  });
}

function selectedMobile(id: SelectedMobileFixtureId): MobileFixtureReference {
  return Object.freeze({ family: "selected_mobile", id });
}

function structuredRuntime(id: StructuredRuntimeFixtureId): MobileFixtureReference {
  return Object.freeze({ family: "structured_runtime", id });
}

function remoteIngress(id: RemoteIngressFixtureId): MobileFixtureReference {
  return Object.freeze({ family: "remote_ingress", id });
}

function remotePairingLink(): MobileFixtureReference {
  return Object.freeze({ family: "remote_pairing_link", id: "fragment_link" });
}

function uniqueInteractions(interactions: readonly MobileInteractionId[]): readonly MobileInteractionId[] {
  return [...new Set(interactions)];
}

interface StateTraceOverrides {
  readonly diagnosisSource?: MobileStateTrace["diagnosisSource"];
  readonly dataDisclosure?: MobileStateTrace["dataDisclosure"];
  readonly firstViewport?: readonly MobileFirstViewportElement[];
  readonly contracts?: readonly MobileContractId[];
  readonly journeys?: readonly MobileJourneyId[];
  readonly viewports?: readonly MobileReferenceViewport[];
  readonly mockupRequired?: boolean;
}

function missionTrace(
  id: MobileStateTraceId,
  state: string,
  fixtureRefs: readonly MobileFixtureReference[],
  interactions: readonly MobileInteractionId[],
  downstreamTasks: readonly MobileDownstreamTaskId[],
  overrides: StateTraceOverrides = {}
): MobileStateTrace {
  const noSessionRows = [
    "mission_loading",
    "mission_fatal",
    "mission_unpaired",
    "mission_expired",
    "mission_revoked",
    "mission_remote_disabled",
    "mission_tailscale_unavailable",
    "mission_profile_mismatch",
    "mission_serve_conflict"
  ].includes(id);
  const defaultDisclosure: MobileStateTrace["dataDisclosure"] = noSessionRows ? "access_only" : "session_list";
  const mockupRequired = overrides.mockupRequired ?? false;

  return stateTrace({
    id,
    surface: "mission_control",
    state,
    renderBoundary: "hostdeck_app",
    diagnosisSource: overrides.diagnosisSource ?? "runtime_projection",
    dataDisclosure: overrides.dataDisclosure ?? defaultDisclosure,
    firstViewport:
      overrides.firstViewport ??
      (noSessionRows ? ["host_access_strip", "page_title", "recovery_action"] : missionFirstViewport),
    contracts: overrides.contracts ?? ["selectedMissionControlViewModelSchema", "selectedHostAccessSchema"],
    fixtureRefs,
    journeys: overrides.journeys ?? ["UX-002"],
    interactions: uniqueInteractions(["read_host_access", ...interactions]),
    viewports: overrides.viewports ?? (mockupRequired ? allReferenceViewports : phoneReferenceViewports),
    downstreamTasks: mockupRequired ? ["FE-V1-002", ...downstreamTasks] : downstreamTasks,
    mockupRequired
  });
}

function remoteMissionTrace(
  id: MobileStateTraceId,
  state: string,
  ingressFixtureId: RemoteIngressFixtureId,
  downstreamTasks: readonly MobileDownstreamTaskId[],
  mockupRequired: boolean
): MobileStateTrace {
  return missionTrace(
    id,
    state,
    [selectedMobile(selectedRemoteFixtureForTrace(id)), remoteIngress(ingressFixtureId)],
    ["read_remote_status", "enable_remote_local", "switch_tailscale_profile_local"],
    ["FE-V1-013", "FE-V1-025", ...downstreamTasks],
    {
      diagnosisSource: "hostdeck_local_observation",
      dataDisclosure: "access_only",
      journeys: ["UX-009", "UX-012"],
      mockupRequired
    }
  );
}

function detailTrace(
  id: MobileStateTraceId,
  state: string,
  selectedFixtureId: SelectedMobileFixtureId,
  runtimeFixtureId: StructuredRuntimeFixtureId | null,
  interactions: readonly MobileInteractionId[],
  downstreamTasks: readonly MobileDownstreamTaskId[],
  overrides: StateTraceOverrides = {}
): MobileStateTrace {
  const inaccessible = ["detail_loading", "detail_not_found"].includes(id);
  const fixtureRefs: MobileFixtureReference[] = [selectedMobile(selectedFixtureId)];
  if (runtimeFixtureId !== null) fixtureRefs.push(structuredRuntime(runtimeFixtureId));
  const mockupRequired = overrides.mockupRequired ?? false;

  return stateTrace({
    id,
    surface: "session_detail",
    state,
    renderBoundary: "hostdeck_app",
    diagnosisSource: overrides.diagnosisSource ?? "runtime_projection",
    dataDisclosure: overrides.dataDisclosure ?? (inaccessible ? "access_only" : "session_detail"),
    firstViewport:
      overrides.firstViewport ??
      (inaccessible ? ["host_access_strip", "session_identity", "recovery_action"] : detailFirstViewport),
    contracts:
      overrides.contracts ??
      [
        "selectedSessionDetailViewModelSchema",
        "selectedHostAccessSchema",
        "managedSessionProjectionSchema",
        "selectedSessionEventStreamSchema",
        "selectedPromptControlSchema",
        "selectedControlStateSchema"
      ],
    fixtureRefs,
    journeys: overrides.journeys ?? ["UX-003"],
    interactions: uniqueInteractions(["read_session_detail", ...interactions]),
    viewports: overrides.viewports ?? (mockupRequired ? allReferenceViewports : phoneReferenceViewports),
    downstreamTasks: mockupRequired ? ["FE-V1-002", ...downstreamTasks] : downstreamTasks,
    mockupRequired
  });
}

function composerStateTraces(): readonly MobileStateTrace[] {
  const states = [
    "empty",
    "composing",
    "keyboard_open",
    "submitting",
    "accepted",
    "running",
    "completed",
    "failed_retryable",
    "failed_nonretryable",
    "disabled_unpaired",
    "disabled_read_only",
    "disabled_locked",
    "disabled_runtime",
    "disabled_session",
    "disabled_stream"
  ] as const;

  return states.map((state) => {
    const id = `composer_${state}` as MobileStateTraceId;
    const fixtureRefs = composerFixtureRefs(state);
    const authorityBlocked = state === "disabled_unpaired" || state === "disabled_read_only" || state === "disabled_locked";
    return stateTrace({
      id,
      surface: "composer",
      state,
      renderBoundary: "hostdeck_app",
      diagnosisSource: authorityBlocked
        ? "application_authority"
        : state.startsWith("disabled_")
          ? "runtime_projection"
          : "user_interaction",
      dataDisclosure: state === "disabled_unpaired" ? "access_only" : "session_detail",
      firstViewport:
        state === "disabled_unpaired"
          ? ["host_access_strip", "permission_and_lock", "recovery_action"]
          : ["session_identity", "sticky_composer", "primary_controls"],
      contracts: [
        "selectedPromptControlSchema",
        "selectedOperationDispatchSchema",
        "selectedOperationProgressSchema",
        "apiErrorEnvelopeSchema"
      ],
      fixtureRefs,
      journeys: ["UX-003", "UX-009", "UX-011"],
      interactions: ["send_prompt"],
      viewports: allReferenceViewports,
      downstreamTasks: ["FE-V1-020", "FE-V1-016", "FE-V1-039"],
      mockupRequired: false
    });
  });
}

function composerFixtureRefs(state: string): readonly MobileFixtureReference[] {
  switch (state) {
    case "completed":
      return [selectedMobile("session_detail_completed"), structuredRuntime("completed")];
    case "failed_retryable":
    case "failed_nonretryable":
      return [selectedMobile("session_detail_failed"), structuredRuntime("failed")];
    case "disabled_unpaired":
      return [selectedMobile("mission_control_unpaired")];
    case "disabled_read_only":
      return [selectedMobile("session_detail_read_only")];
    case "disabled_locked":
      return [selectedMobile("session_detail_locked")];
    case "disabled_runtime":
      return [selectedMobile("session_detail_incompatible"), structuredRuntime("incompatible")];
    case "disabled_session":
      return [selectedMobile("session_detail_unknown"), structuredRuntime("unknown_optional")];
    case "disabled_stream":
      return [selectedMobile("session_detail_stream_reconnecting"), structuredRuntime("disconnect")];
    default:
      return [selectedMobile("session_detail_running"), structuredRuntime("running")];
  }
}

function accessTrace(
  id: MobileStateTraceId,
  state: string,
  fixtureRefs: readonly MobileFixtureReference[],
  interactions: readonly MobileInteractionId[],
  downstreamTasks: readonly MobileDownstreamTaskId[],
  overrides: StateTraceOverrides = {}
): MobileStateTrace {
  const mockupRequired = overrides.mockupRequired ?? false;
  return stateTrace({
    id,
    surface: "host_access",
    state,
    renderBoundary: "hostdeck_app",
    diagnosisSource: overrides.diagnosisSource ?? "hostdeck_remote_observation",
    dataDisclosure: "access_only",
    firstViewport: overrides.firstViewport ?? accessFirstViewport,
    contracts:
      overrides.contracts ??
      [
        "selectedHostAccessSchema",
        "selectedAccessStateResponseSchema",
        "remoteIngressPublicStateSchema",
        "requestIngressProvenanceSchema"
      ],
    fixtureRefs,
    journeys: overrides.journeys ?? ["UX-011", "UX-012"],
    interactions: uniqueInteractions(["read_host_access", ...interactions]),
    viewports: overrides.viewports ?? allReferenceViewports,
    downstreamTasks: mockupRequired ? ["FE-V1-002", ...downstreamTasks] : downstreamTasks,
    mockupRequired
  });
}

function remoteAccessTrace(
  id: MobileStateTraceId,
  state: string,
  ingressFixtureId: RemoteIngressFixtureId,
  mockupRequired = false
): MobileStateTrace {
  return accessTrace(
    id,
    state,
    [selectedMobile(selectedRemoteFixtureForTrace(id)), remoteIngress(ingressFixtureId)],
    ["read_remote_status", "enable_remote_local", "disable_remote_local", "switch_tailscale_profile_local"],
    ["FE-V1-013", "FE-V1-025", "FE-V1-034"],
    {
      diagnosisSource: "hostdeck_local_observation",
      journeys: ["UX-009", "UX-012"],
      mockupRequired
    }
  );
}

function selectedRemoteFixtureForTrace(id: MobileStateTraceId): SelectedMobileFixtureId {
  switch (id) {
    case "mission_remote_disabled":
    case "access_remote_disabled":
      return "mission_control_remote_disabled";
    case "mission_tailscale_unavailable":
    case "access_tailscale_stopped":
      return "mission_control_tailscale_unavailable";
    case "mission_profile_mismatch":
    case "access_profile_mismatch":
      return "mission_control_profile_mismatch";
    case "mission_serve_conflict":
    case "access_serve_conflict":
      return "mission_control_serve_conflict";
    default:
      return "mission_control_remote_unavailable";
  }
}

function pairingTrace(
  id: MobileStateTraceId,
  state: string,
  fixtureRefs: readonly MobileFixtureReference[],
  interactions: readonly MobileInteractionId[],
  exposePermission: boolean
): MobileStateTrace {
  const mockupRequired = id === "pair_fragment_ready" || id === "pair_claiming" || id === "pair_paired";
  return stateTrace({
    id,
    surface: "pairing",
    state,
    renderBoundary: "hostdeck_app",
    diagnosisSource: "user_interaction",
    dataDisclosure: "access_only",
    firstViewport: exposePermission
      ? ["page_title", "pairing_status", "permission_and_lock", "recovery_action"]
      : ["page_title", "pairing_status", "recovery_action"],
    contracts: ["remotePairingLinkIntentSchema", "selectedPairClaimResponseSchema", "apiErrorEnvelopeSchema"],
    fixtureRefs,
    journeys: ["UX-001"],
    interactions,
    viewports: mockupRequired ? allReferenceViewports : phoneReferenceViewports,
    downstreamTasks: mockupRequired ? ["FE-V1-002", "FE-V1-013", "FE-V1-031"] : ["FE-V1-013", "FE-V1-031"],
    mockupRequired
  });
}

function controlStateTraces(
  surface: Extract<MobileSurfaceId, "model" | "goal" | "plan" | "usage" | "compact" | "skills">,
  states: readonly string[],
  journey: MobileJourneyId,
  downstreamTask: MobileDownstreamTaskId,
  interactions: readonly MobileInteractionId[],
  exactContract: MobileContractId
): readonly MobileStateTrace[] {
  return states.map((state) => {
    const id = `${surface}_${state}` as MobileStateTraceId;
    const runtimeFixture = runtimeFixtureForControlState(surface, state);
    const contracts = new Set<MobileContractId>(["selectedControlStateSchema", exactContract]);
    if (["accepted", "running", "completed", "failure", "conflict"].includes(state)) {
      contracts.add("selectedOperationDispatchSchema");
      contracts.add("selectedOperationProgressSchema");
    }

    return stateTrace({
      id,
      surface,
      state,
      renderBoundary: "hostdeck_app",
      diagnosisSource: "user_interaction",
      dataDisclosure: "session_detail",
      firstViewport: controlFirstViewport,
      contracts: [...contracts],
      fixtureRefs: [structuredRuntime(runtimeFixture)],
      journeys: [journey],
      interactions,
      viewports: allReferenceViewports,
      downstreamTasks: [downstreamTask, "FE-V1-016", "FE-V1-039"],
      mockupRequired: false
    });
  });
}

function runtimeFixtureForControlState(
  surface: Extract<MobileSurfaceId, "model" | "goal" | "plan" | "usage" | "compact" | "skills">,
  state: string
): StructuredRuntimeFixtureId {
  if (state === "unsupported") return "incompatible";
  if (state === "stale") return "disconnect";
  if (surface === "compact" && state === "running") return "compacting";
  if (surface === "usage" && state === "content") return "rate_limit";
  if (surface === "skills" && state === "partial") return "unknown_optional";
  if (state === "failure") return "failed";
  return "running";
}

function approvalTrace(
  id: MobileStateTraceId,
  state: string,
  runtimeFixtureId: StructuredRuntimeFixtureId,
  interactions: readonly MobileInteractionId[],
  confirmationRequired: boolean
): MobileStateTrace {
  const mockupRequired = id === "approval_pending" || id === "approval_elevated_confirmation";
  return stateTrace({
    id,
    surface: "approval",
    state,
    renderBoundary: "hostdeck_app",
    diagnosisSource: "user_interaction",
    dataDisclosure: "session_detail",
    firstViewport: [
      "session_identity",
      "inline_approval",
      "action_scope",
      ...(confirmationRequired ? (["confirmation_consequence"] as const) : [])
    ],
    contracts: ["pendingApprovalSchema", "selectedOperationDispatchSchema", "selectedOperationTerminalOutcomeSchema"],
    fixtureRefs: [structuredRuntime(runtimeFixtureId)],
    journeys: ["UX-007"],
    interactions,
    viewports: allReferenceViewports,
    downstreamTasks: mockupRequired
      ? ["FE-V1-002", "FE-V1-022", "FE-V1-016", "FE-V1-039"]
      : ["FE-V1-022", "FE-V1-016", "FE-V1-039"],
    mockupRequired
  });
}

function eventTrace(
  id: MobileStateTraceId,
  state: string,
  runtimeFixtureId: StructuredRuntimeFixtureId
): MobileStateTrace {
  return stateTrace({
    id,
    surface: "event_details",
    state,
    renderBoundary: "hostdeck_app",
    diagnosisSource: "runtime_projection",
    dataDisclosure: "session_detail",
    firstViewport: ["page_title", "session_identity", "diagnostic_limit_notice"],
    contracts: ["selectedEventDiagnosticsSchema", "selectedSessionEventStreamSchema"],
    fixtureRefs: [structuredRuntime(runtimeFixtureId)],
    journeys: ["UX-008", "UX-009"],
    interactions: ["read_event_details"],
    viewports: allReferenceViewports,
    downstreamTasks: ["FE-V1-014", "FE-V1-016", "FE-V1-039"],
    mockupRequired: false
  });
}

function confirmationTrace(
  id: MobileStateTraceId,
  state: string,
  interactionId: MobileInteractionId,
  downstreamTask: MobileDownstreamTaskId,
  journey: MobileJourneyId
): MobileStateTrace {
  return stateTrace({
    id,
    surface: "confirmation",
    state,
    renderBoundary: "hostdeck_app",
    diagnosisSource: "user_interaction",
    dataDisclosure: id === "confirm_lock" || id === "confirm_revoke" ? "access_only" : "session_detail",
    firstViewport: ["page_title", "action_scope", "confirmation_consequence"],
    contracts: ["selectedOperationDispatchSchema", "selectedOperationTerminalOutcomeSchema", "apiErrorEnvelopeSchema"],
    fixtureRefs: [selectedMobile("session_detail_ready")],
    journeys: [journey],
    interactions: [interactionId],
    viewports: allReferenceViewports,
    downstreamTasks: [downstreamTask, "FE-V1-016", "FE-V1-039"],
    mockupRequired: false
  });
}
