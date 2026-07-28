import {
  type MobileDownstreamTaskId,
  type MobileInteractionId,
  type MobileInteractionTrace,
  type MobileJourneyId,
  type MobileReferenceViewport,
  type MobileStateTrace,
  type MobileStateTraceId,
  type MobileSurfaceId,
  mobileInteractionTraces,
  mobileStateTraces
} from "./mobile-design-contract.js";
import {
  type ResponsiveLayoutFamilyId,
  responsiveLayoutCoverageLedger,
  responsiveLayoutFamilyBySurface,
  responsiveLayoutFamilyIds
} from "./responsive-layout-matrix.js";

export const accessibilityFamilyIds = responsiveLayoutFamilyIds;
export type AccessibilityFamilyId = ResponsiveLayoutFamilyId;

export const accessibilitySemanticPolicyIds = [
  "page_landmark_and_queue",
  "detail_heading_and_timeline",
  "labelled_action_group",
  "labelled_modal_form",
  "labelled_modal_collection",
  "labelled_modal_diagnostic",
  "host_facts_and_actions",
  "pairing_progress_and_route_error"
] as const;
export type AccessibilitySemanticPolicyId =
  (typeof accessibilitySemanticPolicyIds)[number];

export const accessibilityKeyboardPolicyIds = [
  "route_and_session_list",
  "timeline_and_inline_actions",
  "tab_ordered_action_group",
  "modal_form_cycle",
  "modal_collection_cycle",
  "modal_confirmation_cycle",
  "host_action_cycle",
  "pairing_and_recovery_route"
] as const;
export type AccessibilityKeyboardPolicyId =
  (typeof accessibilityKeyboardPolicyIds)[number];

export const accessibilityAnnouncementPolicyIds = [
  "none_static",
  "bounded_polite_status",
  "bounded_assertive_alert",
  "approval_arrival_once",
  "detail_activity_increment_once",
  "pairing_phase_delta",
  "operation_lifecycle_delta",
  "external_browser_boundary",
  "local_only_no_app_announcement"
] as const;
export type AccessibilityAnnouncementPolicyId =
  (typeof accessibilityAnnouncementPolicyIds)[number];

export const accessibilityAuditTierIds = [
  "automated_and_manual_app",
  "manual_browser_boundary",
  "contract_only_local_boundary"
] as const;
export type AccessibilityAuditTierId = (typeof accessibilityAuditTierIds)[number];

export interface AccessibilityStateCoverageEntry {
  readonly kind: "state";
  readonly id: MobileStateTraceId;
  readonly surface: MobileSurfaceId;
  readonly family: AccessibilityFamilyId;
  readonly behaviorOwner: MobileDownstreamTaskId;
  readonly semanticPolicy: AccessibilitySemanticPolicyId;
  readonly keyboardPolicy: AccessibilityKeyboardPolicyId;
  readonly announcementPolicy: AccessibilityAnnouncementPolicyId;
  readonly auditTier: AccessibilityAuditTierId;
  readonly journeys: readonly MobileJourneyId[];
  readonly viewports: readonly MobileReferenceViewport[];
}

export interface AccessibilityInteractionCoverageEntry {
  readonly kind: "interaction";
  readonly id: MobileInteractionId;
  readonly surface: MobileSurfaceId | "local_only";
  readonly family: AccessibilityFamilyId;
  readonly behaviorOwner: MobileDownstreamTaskId;
  readonly semanticPolicy: AccessibilitySemanticPolicyId;
  readonly keyboardPolicy: AccessibilityKeyboardPolicyId;
  readonly announcementPolicy: AccessibilityAnnouncementPolicyId;
  readonly auditTier: AccessibilityAuditTierId;
}

export const accessibilitySemanticPolicyByFamily = Object.freeze({
  shell_mission_queue: "page_landmark_and_queue",
  detail_timeline: "detail_heading_and_timeline",
  fixed_action_region: "labelled_action_group",
  primary_control_sheets: "labelled_modal_form",
  utility_sheets: "labelled_modal_collection",
  session_action_diagnostic_sheets: "labelled_modal_diagnostic",
  host_access: "host_facts_and_actions",
  pairing_and_route_errors: "pairing_progress_and_route_error"
} satisfies Readonly<Record<AccessibilityFamilyId, AccessibilitySemanticPolicyId>>);

export const accessibilityKeyboardPolicyByFamily = Object.freeze({
  shell_mission_queue: "route_and_session_list",
  detail_timeline: "timeline_and_inline_actions",
  fixed_action_region: "tab_ordered_action_group",
  primary_control_sheets: "modal_form_cycle",
  utility_sheets: "modal_collection_cycle",
  session_action_diagnostic_sheets: "modal_confirmation_cycle",
  host_access: "host_action_cycle",
  pairing_and_route_errors: "pairing_and_recovery_route"
} satisfies Readonly<Record<AccessibilityFamilyId, AccessibilityKeyboardPolicyId>>);

const layoutEntryByTraceId = new Map(
  responsiveLayoutCoverageLedger.map((entry) => [entry.traceId, entry] as const)
);

export const accessibilityStateCoverageLedger: readonly AccessibilityStateCoverageEntry[] =
  Object.freeze(mobileStateTraces.map(accessibilityStateEntry));

export const accessibilityInteractionCoverageLedger:
  readonly AccessibilityInteractionCoverageEntry[] = Object.freeze(
    mobileInteractionTraces.map(accessibilityInteractionEntry)
  );

function accessibilityStateEntry(
  trace: MobileStateTrace
): AccessibilityStateCoverageEntry {
  const layout = layoutEntryByTraceId.get(trace.id);
  if (layout === undefined || layout.surface !== trace.surface) {
    throw new TypeError(`Accessibility state ${trace.id} has no exact layout owner.`);
  }
  return Object.freeze({
    kind: "state",
    id: trace.id,
    surface: trace.surface,
    family: layout.family,
    behaviorOwner: layout.behaviorOwner,
    semanticPolicy: accessibilitySemanticPolicyByFamily[layout.family],
    keyboardPolicy: accessibilityKeyboardPolicyByFamily[layout.family],
    announcementPolicy: stateAnnouncementPolicy(trace),
    auditTier:
      trace.renderBoundary === "browser_preload"
        ? "manual_browser_boundary"
        : "automated_and_manual_app",
    journeys: Object.freeze([...trace.journeys]),
    viewports: Object.freeze([...trace.viewports])
  });
}

function accessibilityInteractionEntry(
  trace: MobileInteractionTrace
): AccessibilityInteractionCoverageEntry {
  const family = interactionFamily(trace);
  return Object.freeze({
    kind: "interaction",
    id: trace.id,
    surface: trace.uiOwner,
    family,
    behaviorOwner: trace.downstreamTask,
    semanticPolicy: accessibilitySemanticPolicyByFamily[family],
    keyboardPolicy: accessibilityKeyboardPolicyByFamily[family],
    announcementPolicy: interactionAnnouncementPolicy(trace),
    auditTier:
      trace.uiOwner === "local_only"
        ? "contract_only_local_boundary"
        : "automated_and_manual_app"
  });
}

function interactionFamily(trace: MobileInteractionTrace): AccessibilityFamilyId {
  if (trace.uiOwner !== "local_only") {
    return responsiveLayoutFamilyBySurface[trace.uiOwner];
  }
  if (trace.id === "create_pairing_link") return "pairing_and_route_errors";
  if (
    trace.id === "enable_remote_local" ||
    trace.id === "disable_remote_local" ||
    trace.id === "switch_tailscale_profile_local" ||
    trace.id === "unlock_host_local"
  ) {
    return "host_access";
  }
  throw new TypeError(`Local-only interaction ${trace.id} has no accessibility family.`);
}

function stateAnnouncementPolicy(
  trace: MobileStateTrace
): AccessibilityAnnouncementPolicyId {
  if (trace.renderBoundary === "browser_preload") return "external_browser_boundary";
  if (trace.surface === "pairing") return "pairing_phase_delta";
  if (trace.id === "approval_pending") return "approval_arrival_once";
  if (trace.surface === "session_detail" || trace.surface === "approval") {
    return isAssertiveState(trace.id)
      ? "bounded_assertive_alert"
      : "detail_activity_increment_once";
  }
  if (isAssertiveState(trace.id)) return "bounded_assertive_alert";
  if (isLifecycleState(trace.id)) return "bounded_polite_status";
  return "none_static";
}

function interactionAnnouncementPolicy(
  trace: MobileInteractionTrace
): AccessibilityAnnouncementPolicyId {
  if (trace.uiOwner === "local_only") return "local_only_no_app_announcement";
  if (trace.id === "claim_pairing" || trace.id === "consume_pairing_fragment") {
    return "pairing_phase_delta";
  }
  if (trace.id === "read_approvals") return "approval_arrival_once";
  if (trace.id === "stream_events" || trace.id === "reconnect_stream") {
    return "detail_activity_increment_once";
  }
  if (trace.mutation) return "operation_lifecycle_delta";
  return "none_static";
}

function isAssertiveState(id: MobileStateTraceId): boolean {
  return /(?:fatal|failure|failed|invalid|expired|revoked|locked|incompatible|unavailable|conflict|denied|not_found|unreachable)$/u.test(
    id
  );
}

function isLifecycleState(id: MobileStateTraceId): boolean {
  return /(?:loading|checking|claiming|reconnecting|submitting|accepted|running|responding|compacting|stale|partial|rate_limit)$/u.test(
    id
  );
}
