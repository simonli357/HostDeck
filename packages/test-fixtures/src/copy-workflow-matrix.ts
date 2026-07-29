import {
  type MobileDownstreamTaskId,
  type MobileInteractionId,
  type MobileInteractionTrace,
  type MobileJourneyId,
  type MobileStateTrace,
  type MobileStateTraceId,
  type MobileSurfaceId,
  mobileInteractionTraces,
  mobileStateTraceIds,
  mobileStateTraces
} from "./mobile-design-contract.js";
import { responsiveLayoutCoverageLedger } from "./responsive-layout-matrix.js";

export const canonicalSessionStatusLabels = Object.freeze([
  "Needs approval",
  "Needs input",
  "Running",
  "Quiet",
  "Interrupted",
  "Failed",
  "Unknown",
  "Stale"
] as const);

export const forbiddenProductSurfaceIds = Object.freeze([
  "desktop_console",
  "terminal_emulator",
  "arbitrary_shell",
  "editor",
  "file_tree",
  "git_review",
  "storage_console",
  "raw_protocol_viewer",
  "tailscale_profile_switcher",
  "direct_app_server_client"
] as const);
export type ForbiddenProductSurfaceId = (typeof forbiddenProductSurfaceIds)[number];

export const copyOutcomeSemanticsIds = Object.freeze([
  "external_unreachable",
  "loading",
  "empty",
  "ready",
  "attention_required",
  "read_only",
  "locked",
  "unavailable",
  "accepted",
  "running",
  "terminal_success",
  "terminal_interrupted",
  "terminal_failure",
  "unknown",
  "stale",
  "reconnecting",
  "boundary",
  "disabled",
  "unsupported",
  "conflict",
  "confirmation",
  "partial",
  "rate_limited",
  "diagnostic_limit",
  "resolved_unavailable"
] as const);
export type CopyOutcomeSemanticsId = (typeof copyOutcomeSemanticsIds)[number];

export const recoveryOwnerIds = Object.freeze([
  "none",
  "phone_user",
  "browser_or_tailscale",
  "local_laptop",
  "hostdeck_observation"
] as const);
export type RecoveryOwnerId = (typeof recoveryOwnerIds)[number];

export const attemptPolicyIds = Object.freeze([
  "none",
  "read_refresh_safe",
  "explicit_retry_after_observation",
  "mutation_no_resend_until_observed",
  "wait_for_observation",
  "local_action_only"
] as const);
export type AttemptPolicyId = (typeof attemptPolicyIds)[number];

export const technicalLanguagePolicyIds = Object.freeze([
  "product_vocabulary",
  "runtime_backed_control",
  "bounded_diagnostic",
  "external_browser",
  "local_handoff"
] as const);
export type TechnicalLanguagePolicyId = (typeof technicalLanguagePolicyIds)[number];

export const workflowStageIds = Object.freeze([
  "entry",
  "read",
  "navigate",
  "act",
  "observe",
  "recover",
  "handoff"
] as const);
export type WorkflowStageId = (typeof workflowStageIds)[number];

export const interactionResultSemanticsIds = Object.freeze([
  "browser_state",
  "read_observation",
  "mutation_acceptance",
  "terminal_decision",
  "local_result",
  "clipboard_handoff"
] as const);
export type InteractionResultSemanticsId =
  (typeof interactionResultSemanticsIds)[number];

export interface CopyWorkflowStateCoverageEntry {
  readonly kind: "state";
  readonly id: MobileStateTraceId;
  readonly surface: MobileSurfaceId;
  readonly copyOwner: MobileDownstreamTaskId;
  readonly outcomeSemantics: CopyOutcomeSemanticsId;
  readonly recoveryOwner: RecoveryOwnerId;
  readonly attemptPolicy: AttemptPolicyId;
  readonly technicalLanguagePolicy: TechnicalLanguagePolicyId;
  readonly journeys: readonly MobileJourneyId[];
  readonly evidenceBoundary: "browser_preload" | "hostdeck_app";
}

export interface InteractionCopyPolicy {
  readonly workflowStage: WorkflowStageId;
  readonly resultSemantics: InteractionResultSemanticsId;
  readonly recoveryOwner: RecoveryOwnerId;
  readonly attemptPolicy: AttemptPolicyId;
  readonly technicalLanguagePolicy: TechnicalLanguagePolicyId;
}

export interface CopyWorkflowInteractionCoverageEntry extends InteractionCopyPolicy {
  readonly kind: "interaction";
  readonly id: MobileInteractionId;
  readonly surface: MobileSurfaceId | "local_only";
  readonly copyOwner: MobileDownstreamTaskId;
  readonly mutation: boolean;
  readonly automaticRetry: false;
  readonly exactTarget: MobileInteractionTrace["exactTarget"];
  readonly confirmation: MobileInteractionTrace["confirmation"];
  readonly journeys: readonly MobileJourneyId[];
}

const copyOutcomeStateGroups = Object.freeze({
  external_unreachable: [
    "preload_phone_network_unavailable",
    "preload_remote_origin_unreachable"
  ],
  loading: [
    "mission_loading",
    "detail_loading",
    "composer_submitting",
    "access_remote_checking",
    "access_csrf_bootstrap",
    "pair_claiming",
    "model_loading",
    "goal_loading",
    "plan_loading",
    "usage_loading",
    "skills_loading",
    "approval_responding"
  ],
  empty: ["mission_empty", "usage_empty", "skills_empty"],
  ready: [
    "mission_mixed_attention",
    "mission_all_quiet",
    "mission_long_content",
    "mission_desktop_expansion",
    "detail_active_writable",
    "detail_long_content",
    "detail_desktop_expansion",
    "composer_empty",
    "composer_composing",
    "composer_keyboard_open",
    "access_remote_ready",
    "access_loopback_ready",
    "access_device_list",
    "pair_fragment_ready",
    "pair_paired",
    "model_current",
    "goal_current",
    "plan_current",
    "usage_content",
    "skills_content",
    "event_complete"
  ],
  attention_required: ["detail_needs_input", "detail_approval", "approval_pending"],
  read_only: ["mission_read_only", "detail_read_only", "access_read_only"],
  locked: ["mission_locked", "detail_locked", "access_locked"],
  unavailable: [
    "mission_runtime_offline",
    "mission_runtime_incompatible",
    "mission_runtime_degraded",
    "mission_unpaired",
    "mission_expired",
    "mission_revoked",
    "mission_remote_disabled",
    "mission_tailscale_unavailable",
    "mission_profile_mismatch",
    "mission_serve_conflict",
    "detail_not_found",
    "detail_runtime_incompatible",
    "access_unpaired",
    "access_expired",
    "access_revoked",
    "access_remote_disabled",
    "access_tailscale_absent",
    "access_tailscale_stopped",
    "access_tailscale_signed_out",
    "access_profile_mismatch",
    "access_serve_absent",
    "access_serve_conflict",
    "access_csrf_failure",
    "access_stream_unavailable",
    "access_runtime_incompatible",
    "pair_invalid",
    "pair_expired",
    "pair_remote_unreachable"
  ],
  accepted: [
    "composer_accepted",
    "model_accepted",
    "goal_accepted",
    "plan_accepted",
    "compact_accepted"
  ],
  running: ["detail_compacting", "composer_running", "compact_running"],
  terminal_success: [
    "detail_completed",
    "composer_completed",
    "model_success",
    "goal_success",
    "plan_success",
    "compact_completed",
    "approval_approved",
    "approval_denied"
  ],
  terminal_interrupted: ["detail_interrupted"],
  terminal_failure: [
    "mission_fatal",
    "detail_failed",
    "composer_failed_retryable",
    "composer_failed_nonretryable",
    "model_failure",
    "goal_failure",
    "plan_failure",
    "usage_failure",
    "compact_failure",
    "skills_failure"
  ],
  unknown: ["detail_unknown", "event_unknown"],
  stale: ["detail_stale", "usage_stale"],
  reconnecting: ["detail_stream_reconnecting", "approval_reconnecting"],
  boundary: ["detail_replay_boundary", "access_profile_switch_boundary", "event_boundary"],
  disabled: [
    "composer_disabled_unpaired",
    "composer_disabled_read_only",
    "composer_disabled_locked",
    "composer_disabled_runtime",
    "composer_disabled_session",
    "composer_disabled_stream"
  ],
  unsupported: [
    "model_unsupported",
    "goal_unsupported",
    "plan_unsupported",
    "usage_unsupported",
    "compact_unsupported",
    "skills_unsupported"
  ],
  conflict: ["model_conflict", "goal_conflict", "plan_conflict", "compact_conflict"],
  confirmation: [
    "compact_confirmation",
    "approval_elevated_confirmation",
    "confirm_interrupt",
    "confirm_archive",
    "confirm_lock",
    "confirm_revoke"
  ],
  partial: ["skills_partial"],
  rate_limited: ["detail_rate_limit", "pair_rate_limited"],
  diagnostic_limit: ["event_truncated", "event_redacted"],
  resolved_unavailable: ["pair_used", "approval_expired", "approval_superseded"]
} satisfies Readonly<Record<CopyOutcomeSemanticsId, readonly MobileStateTraceId[]>>);

export const stateOutcomeSemanticsById = buildStateOutcomeMap(copyOutcomeStateGroups);

const layoutEntryByTraceId = new Map(
  responsiveLayoutCoverageLedger.map((entry) => [entry.traceId, entry] as const)
);

export const copyWorkflowStateCoverageLedger:
  readonly CopyWorkflowStateCoverageEntry[] = Object.freeze(
    mobileStateTraces.map(stateCoverageEntry)
  );

export const interactionCopyPolicies = Object.freeze({
  bootstrap_shell: policy("entry", "browser_state", "browser_or_tailscale", "read_refresh_safe", "product_vocabulary"),
  create_pairing_link: policy("entry", "local_result", "local_laptop", "local_action_only", "local_handoff"),
  consume_pairing_fragment: policy("entry", "browser_state", "phone_user", "none", "product_vocabulary"),
  claim_pairing: policy("act", "mutation_acceptance", "local_laptop", "mutation_no_resend_until_observed", "product_vocabulary"),
  bootstrap_csrf: policy("recover", "mutation_acceptance", "phone_user", "mutation_no_resend_until_observed", "product_vocabulary"),
  read_remote_status: policy("read", "read_observation", "local_laptop", "read_refresh_safe", "runtime_backed_control"),
  enable_remote_local: policy("recover", "local_result", "local_laptop", "local_action_only", "local_handoff"),
  disable_remote_local: policy("recover", "local_result", "local_laptop", "local_action_only", "local_handoff"),
  switch_tailscale_profile_local: policy("recover", "local_result", "local_laptop", "local_action_only", "local_handoff"),
  read_host_access: policy("read", "read_observation", "phone_user", "read_refresh_safe", "product_vocabulary"),
  read_host_status: policy("read", "read_observation", "local_laptop", "read_refresh_safe", "runtime_backed_control"),
  read_sessions: policy("read", "read_observation", "phone_user", "read_refresh_safe", "product_vocabulary"),
  open_session: policy("navigate", "browser_state", "phone_user", "none", "product_vocabulary"),
  read_session_detail: policy("read", "read_observation", "phone_user", "read_refresh_safe", "product_vocabulary"),
  navigate_back: policy("navigate", "browser_state", "phone_user", "none", "product_vocabulary"),
  stream_events: policy("observe", "read_observation", "hostdeck_observation", "wait_for_observation", "product_vocabulary"),
  reconnect_stream: policy("recover", "browser_state", "hostdeck_observation", "wait_for_observation", "product_vocabulary"),
  send_prompt: policy("act", "mutation_acceptance", "hostdeck_observation", "mutation_no_resend_until_observed", "product_vocabulary"),
  read_model: policy("read", "read_observation", "phone_user", "read_refresh_safe", "runtime_backed_control"),
  select_model: policy("act", "mutation_acceptance", "hostdeck_observation", "mutation_no_resend_until_observed", "runtime_backed_control"),
  read_goal: policy("read", "read_observation", "phone_user", "read_refresh_safe", "runtime_backed_control"),
  mutate_goal: policy("act", "mutation_acceptance", "hostdeck_observation", "mutation_no_resend_until_observed", "runtime_backed_control"),
  read_plan: policy("read", "read_observation", "phone_user", "read_refresh_safe", "runtime_backed_control"),
  select_plan: policy("act", "mutation_acceptance", "hostdeck_observation", "mutation_no_resend_until_observed", "runtime_backed_control"),
  read_usage: policy("read", "read_observation", "phone_user", "read_refresh_safe", "runtime_backed_control"),
  read_compact: policy("read", "read_observation", "phone_user", "read_refresh_safe", "runtime_backed_control"),
  start_compact: policy("act", "mutation_acceptance", "hostdeck_observation", "mutation_no_resend_until_observed", "runtime_backed_control"),
  read_skills: policy("read", "read_observation", "phone_user", "read_refresh_safe", "runtime_backed_control"),
  read_approvals: policy("read", "read_observation", "phone_user", "read_refresh_safe", "product_vocabulary"),
  respond_approval: policy("act", "terminal_decision", "hostdeck_observation", "mutation_no_resend_until_observed", "product_vocabulary"),
  read_event_details: policy("read", "read_observation", "phone_user", "read_refresh_safe", "bounded_diagnostic"),
  interrupt_turn: policy("act", "terminal_decision", "hostdeck_observation", "mutation_no_resend_until_observed", "product_vocabulary"),
  archive_session: policy("act", "terminal_decision", "hostdeck_observation", "mutation_no_resend_until_observed", "product_vocabulary"),
  read_resume_metadata: policy("read", "read_observation", "local_laptop", "read_refresh_safe", "local_handoff"),
  copy_resume_command: policy("handoff", "clipboard_handoff", "local_laptop", "none", "local_handoff"),
  read_devices: policy("read", "read_observation", "phone_user", "read_refresh_safe", "product_vocabulary"),
  revoke_device: policy("act", "terminal_decision", "hostdeck_observation", "mutation_no_resend_until_observed", "product_vocabulary"),
  lock_host: policy("act", "terminal_decision", "hostdeck_observation", "mutation_no_resend_until_observed", "product_vocabulary"),
  unlock_host_local: policy("recover", "local_result", "local_laptop", "local_action_only", "local_handoff")
} satisfies Readonly<Record<MobileInteractionId, InteractionCopyPolicy>>);

export const copyWorkflowInteractionCoverageLedger:
  readonly CopyWorkflowInteractionCoverageEntry[] = Object.freeze(
    mobileInteractionTraces.map(interactionCoverageEntry)
  );

export const mobileWorkflowPathIds = Object.freeze([
  "pair_phone",
  "scan_sessions",
  "read_and_prompt",
  "change_model",
  "manage_goal",
  "manage_plan",
  "read_usage",
  "compact_context",
  "read_skills",
  "handle_approval",
  "interrupt_turn",
  "archive_session",
  "recover_stream",
  "resume_on_laptop",
  "revoke_device",
  "lock_host",
  "recover_remote_access"
] as const);
export type MobileWorkflowPathId = (typeof mobileWorkflowPathIds)[number];

export interface MobileWorkflowPath {
  readonly id: MobileWorkflowPathId;
  readonly journey: MobileJourneyId;
  readonly entryBoundary: "browser" | "hostdeck_app" | "local_laptop";
  readonly interactionIds: readonly MobileInteractionId[];
  readonly successStateIds: readonly MobileStateTraceId[];
  readonly recoveryStateIds: readonly MobileStateTraceId[];
}

export const mobileWorkflowPaths: readonly MobileWorkflowPath[] = Object.freeze([
  path("pair_phone", "UX-001", "local_laptop", [
    "create_pairing_link",
    "bootstrap_shell",
    "consume_pairing_fragment",
    "claim_pairing",
    "bootstrap_csrf",
    "read_host_access"
  ], ["pair_paired"], ["pair_invalid", "pair_expired", "pair_used", "pair_rate_limited", "pair_remote_unreachable"]),
  path("scan_sessions", "UX-002", "hostdeck_app", [
    "bootstrap_shell",
    "read_host_access",
    "read_host_status",
    "read_sessions"
  ], ["mission_mixed_attention", "mission_all_quiet", "mission_empty"], ["mission_read_only", "mission_locked", "mission_runtime_offline", "mission_fatal"]),
  path("read_and_prompt", "UX-003", "hostdeck_app", [
    "read_sessions",
    "open_session",
    "read_session_detail",
    "stream_events",
    "send_prompt",
    "reconnect_stream",
    "navigate_back"
  ], ["composer_accepted", "composer_running", "composer_completed"], ["composer_failed_retryable", "composer_failed_nonretryable", "detail_stale", "detail_replay_boundary"]),
  path("change_model", "UX-004", "hostdeck_app", [
    "read_session_detail",
    "read_model",
    "select_model",
    "send_prompt",
    "stream_events"
  ], ["model_accepted", "model_success"], ["model_unsupported", "model_conflict", "model_failure"]),
  path("manage_goal", "UX-005", "hostdeck_app", [
    "read_session_detail",
    "read_goal",
    "mutate_goal",
    "stream_events"
  ], ["goal_accepted", "goal_success"], ["goal_unsupported", "goal_conflict", "goal_failure"]),
  path("manage_plan", "UX-005", "hostdeck_app", [
    "read_session_detail",
    "read_plan",
    "select_plan",
    "send_prompt",
    "stream_events"
  ], ["plan_accepted", "plan_success"], ["plan_unsupported", "plan_conflict", "plan_failure"]),
  path("read_usage", "UX-006", "hostdeck_app", ["read_session_detail", "read_usage"], ["usage_content", "usage_empty"], ["usage_stale", "usage_unsupported", "usage_failure"]),
  path("compact_context", "UX-006", "hostdeck_app", [
    "read_session_detail",
    "read_compact",
    "start_compact",
    "stream_events"
  ], ["compact_accepted", "compact_running", "compact_completed"], ["compact_conflict", "compact_unsupported", "compact_failure"]),
  path("read_skills", "UX-006", "hostdeck_app", ["read_session_detail", "read_skills"], ["skills_content", "skills_empty", "skills_partial"], ["skills_unsupported", "skills_failure"]),
  path("handle_approval", "UX-007", "hostdeck_app", [
    "read_session_detail",
    "stream_events",
    "read_approvals",
    "respond_approval"
  ], ["approval_approved", "approval_denied"], ["approval_expired", "approval_superseded", "approval_reconnecting"]),
  path("interrupt_turn", "UX-008", "hostdeck_app", ["read_session_detail", "stream_events", "read_event_details", "interrupt_turn"], ["detail_interrupted"], ["detail_stale", "detail_unknown", "detail_stream_reconnecting"]),
  path("archive_session", "UX-008", "hostdeck_app", ["read_session_detail", "archive_session"], ["detail_not_found"], ["detail_stale", "detail_unknown"]),
  path("recover_stream", "UX-009", "hostdeck_app", ["read_session_detail", "stream_events", "reconnect_stream"], ["detail_active_writable"], ["detail_stream_reconnecting", "detail_replay_boundary", "access_profile_switch_boundary"]),
  path("resume_on_laptop", "UX-010", "hostdeck_app", ["read_session_detail", "read_resume_metadata", "copy_resume_command"], ["detail_active_writable"], ["detail_not_found", "detail_stale", "detail_runtime_incompatible"]),
  path("revoke_device", "UX-011", "hostdeck_app", ["read_host_access", "read_devices", "revoke_device"], ["access_device_list"], ["access_revoked", "access_unpaired"]),
  path("lock_host", "UX-011", "hostdeck_app", ["read_host_access", "lock_host", "unlock_host_local", "read_host_status"], ["access_locked", "access_remote_ready"], ["access_read_only", "access_csrf_failure"]),
  path("recover_remote_access", "UX-012", "local_laptop", [
    "read_remote_status",
    "enable_remote_local",
    "disable_remote_local",
    "switch_tailscale_profile_local",
    "bootstrap_shell"
  ], ["access_remote_ready"], ["access_remote_disabled", "access_tailscale_absent", "access_tailscale_stopped", "access_tailscale_signed_out", "access_profile_mismatch", "access_serve_absent", "access_serve_conflict"])
]);

function stateCoverageEntry(trace: MobileStateTrace): CopyWorkflowStateCoverageEntry {
  const layout = layoutEntryByTraceId.get(trace.id);
  if (layout === undefined || layout.surface !== trace.surface) {
    throw new TypeError(`Copy/workflow state ${trace.id} has no exact layout owner.`);
  }
  const outcomeSemantics = stateOutcomeSemanticsById[trace.id];
  return Object.freeze({
    kind: "state",
    id: trace.id,
    surface: trace.surface,
    copyOwner: layout.behaviorOwner,
    outcomeSemantics,
    recoveryOwner: recoveryOwnerForState(trace, outcomeSemantics),
    attemptPolicy: attemptPolicyForState(trace, outcomeSemantics),
    technicalLanguagePolicy: technicalLanguagePolicyForState(trace),
    journeys: Object.freeze([...trace.journeys]),
    evidenceBoundary: trace.renderBoundary
  });
}

function interactionCoverageEntry(
  trace: MobileInteractionTrace
): CopyWorkflowInteractionCoverageEntry {
  const copyPolicy = interactionCopyPolicies[trace.id];
  const journeys = unique(
    mobileStateTraces
      .filter(({ interactions }) => interactions.includes(trace.id))
      .flatMap(({ journeys: stateJourneys }) => stateJourneys)
  ) as readonly MobileJourneyId[];
  return Object.freeze({
    kind: "interaction",
    id: trace.id,
    surface: trace.uiOwner,
    copyOwner: trace.downstreamTask,
    mutation: trace.mutation,
    automaticRetry: trace.automaticRetry,
    exactTarget: trace.exactTarget,
    confirmation: trace.confirmation,
    journeys: Object.freeze(journeys),
    ...copyPolicy
  });
}

function buildStateOutcomeMap(
  groups: Readonly<Record<CopyOutcomeSemanticsId, readonly MobileStateTraceId[]>>
): Readonly<Record<MobileStateTraceId, CopyOutcomeSemanticsId>> {
  const entries: Array<readonly [MobileStateTraceId, CopyOutcomeSemanticsId]> = [];
  const seen = new Set<MobileStateTraceId>();
  for (const semantics of copyOutcomeSemanticsIds) {
    for (const id of groups[semantics]) {
      if (seen.has(id)) throw new TypeError(`Copy outcome state ${id} is classified twice.`);
      seen.add(id);
      entries.push([id, semantics]);
    }
  }
  const missing = mobileStateTraceIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new TypeError(`Copy outcome states are unclassified: ${missing.join(", ")}.`);
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<MobileStateTraceId, CopyOutcomeSemanticsId>
  >;
}

function recoveryOwnerForState(
  trace: MobileStateTrace,
  semantics: CopyOutcomeSemanticsId
): RecoveryOwnerId {
  if (trace.renderBoundary === "browser_preload" || trace.id === "pair_remote_unreachable") {
    return "browser_or_tailscale";
  }
  if (requiresLocalLaptop(trace.id)) return "local_laptop";
  if (["accepted", "running", "unknown", "reconnecting", "boundary"].includes(semantics)) {
    return "hostdeck_observation";
  }
  if (["loading", "stale", "terminal_failure", "conflict", "rate_limited"].includes(semantics)) {
    return "phone_user";
  }
  return "none";
}

function attemptPolicyForState(
  trace: MobileStateTrace,
  semantics: CopyOutcomeSemanticsId
): AttemptPolicyId {
  if (trace.renderBoundary === "browser_preload") return "read_refresh_safe";
  if (requiresLocalLaptop(trace.id)) return "local_action_only";
  if (["accepted", "running", "unknown", "reconnecting", "boundary"].includes(semantics)) {
    return "wait_for_observation";
  }
  if (semantics === "terminal_failure" && trace.id.includes("retryable")) {
    return "explicit_retry_after_observation";
  }
  if (["loading", "stale", "terminal_failure", "conflict", "rate_limited"].includes(semantics)) {
    return "read_refresh_safe";
  }
  return "none";
}

function requiresLocalLaptop(id: MobileStateTraceId): boolean {
  return /(?:runtime_offline|runtime_incompatible|runtime_degraded|mission_fatal|unpaired|expired|revoked|remote_disabled|tailscale_|profile_mismatch|serve_|pair_invalid|pair_used|access_locked|detail_locked)$/u.test(id);
}

function technicalLanguagePolicyForState(
  trace: MobileStateTrace
): TechnicalLanguagePolicyId {
  if (trace.renderBoundary === "browser_preload") return "external_browser";
  if (trace.surface === "event_details") return "bounded_diagnostic";
  if (["model", "goal", "plan", "usage", "compact", "skills"].includes(trace.surface)) {
    return "runtime_backed_control";
  }
  return "product_vocabulary";
}

function policy(
  workflowStage: WorkflowStageId,
  resultSemantics: InteractionResultSemanticsId,
  recoveryOwner: RecoveryOwnerId,
  attemptPolicy: AttemptPolicyId,
  technicalLanguagePolicy: TechnicalLanguagePolicyId
): InteractionCopyPolicy {
  return Object.freeze({
    workflowStage,
    resultSemantics,
    recoveryOwner,
    attemptPolicy,
    technicalLanguagePolicy
  });
}

function path(
  id: MobileWorkflowPathId,
  journey: MobileJourneyId,
  entryBoundary: MobileWorkflowPath["entryBoundary"],
  interactionIds: readonly MobileInteractionId[],
  successStateIds: readonly MobileStateTraceId[],
  recoveryStateIds: readonly MobileStateTraceId[]
): MobileWorkflowPath {
  return Object.freeze({
    id,
    journey,
    entryBoundary,
    interactionIds: Object.freeze([...interactionIds]),
    successStateIds: Object.freeze([...successStateIds]),
    recoveryStateIds: Object.freeze([...recoveryStateIds])
  });
}

function unique<Value extends string>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)].sort();
}
