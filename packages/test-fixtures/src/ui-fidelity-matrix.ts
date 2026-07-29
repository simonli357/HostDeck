import {
  type MobileDownstreamTaskId,
  type MobileInteractionId,
  type MobileJourneyId,
  type MobileReferenceViewport,
  type MobileStateTrace,
  type MobileStateTraceId,
  type MobileSurfaceId,
  mobileInteractionTraces,
  mobileStateTraces
} from "./mobile-design-contract.js";
import { responsiveLayoutCoverageLedger } from "./responsive-layout-matrix.js";

export const uiFidelityTargetIds = [
  "mission_control",
  "session_detail",
  "approval_boundary",
  "pairing_journey",
  "access_recovery",
  "primary_controls",
  "responsive_continuum"
] as const;
export type UiFidelityTargetId = (typeof uiFidelityTargetIds)[number];

export interface UiFidelityTarget {
  readonly id: UiFidelityTargetId;
  readonly path: `assets/ui-concepts/option-b/${string}.png`;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly landmarks: readonly UiFidelityLandmarkId[];
}

export const uiFidelityLandmarkIds = [
  "compact_app_bar",
  "host_status_rail",
  "grouped_attention_queue",
  "semantic_state_rail",
  "whole_session_target",
  "event_timeline",
  "sticky_primary_dock",
  "sticky_prompt_composer",
  "broken_timeline_boundary",
  "inline_approval",
  "risk_confirmation_sheet",
  "pairing_progress_rail",
  "pairing_dominant_state",
  "recovery_owner_label",
  "recovery_state_rail",
  "current_next_turn_rail",
  "objective_execution_rail",
  "phone_single_column",
  "tablet_bounded_context",
  "desktop_list_detail_split"
] as const;
export type UiFidelityLandmarkId = (typeof uiFidelityLandmarkIds)[number];

export const uiFidelityDivergenceIds = [
  "none",
  "runtime_backed_copy",
  "typed_fixture_content",
  "lucide_icon_substitution",
  "accessible_semantics",
  "fragment_scrubbed_automatic_claim",
  "local_cli_qr_creation",
  "browser_owned_preload_error",
  "capability_aware_control_state"
] as const;
export type UiFidelityDivergenceId = (typeof uiFidelityDivergenceIds)[number];

export const uiFidelityEvidenceTierIds = [
  "fresh_capture",
  "existing_behavior_evidence",
  "browser_boundary",
  "local_only_boundary"
] as const;
export type UiFidelityEvidenceTierId = (typeof uiFidelityEvidenceTierIds)[number];

export interface UiFidelityStateCoverageEntry {
  readonly kind: "state";
  readonly id: MobileStateTraceId;
  readonly surface: MobileSurfaceId;
  readonly target: UiFidelityTargetId;
  readonly behaviorOwner: MobileDownstreamTaskId;
  readonly evidenceTier: UiFidelityEvidenceTierId;
  readonly landmarks: readonly UiFidelityLandmarkId[];
  readonly allowedDivergences: readonly UiFidelityDivergenceId[];
  readonly journeys: readonly MobileJourneyId[];
  readonly viewports: readonly MobileReferenceViewport[];
}

export interface UiFidelityInteractionCoverageEntry {
  readonly kind: "interaction";
  readonly id: MobileInteractionId;
  readonly surface: MobileSurfaceId | "local_only";
  readonly target: UiFidelityTargetId;
  readonly behaviorOwner: MobileDownstreamTaskId;
  readonly evidenceTier: UiFidelityEvidenceTierId;
  readonly landmarks: readonly UiFidelityLandmarkId[];
  readonly allowedDivergences: readonly UiFidelityDivergenceId[];
}

export const uiFidelityTargets: readonly UiFidelityTarget[] = Object.freeze([
  target(
    "mission_control",
    "assets/ui-concepts/option-b/mobile-mission-control-mixed.png",
    853,
    1844,
    "b8b81bf3090af4829c1ed934c47f7adba6b70aeda6befdd56934dfb1f9de18e3",
    [
      "compact_app_bar",
      "host_status_rail",
      "grouped_attention_queue",
      "semantic_state_rail",
      "whole_session_target"
    ]
  ),
  target(
    "session_detail",
    "assets/ui-concepts/option-b/mobile-session-detail-active.png",
    852,
    1846,
    "19811f479b1e00df02da61f44ed50b72fd3363a349ad8aa87b7a5d63eee9f2ce",
    [
      "compact_app_bar",
      "event_timeline",
      "semantic_state_rail",
      "sticky_primary_dock",
      "sticky_prompt_composer"
    ]
  ),
  target(
    "approval_boundary",
    "assets/ui-concepts/option-b/mobile-approval-boundary-states.png",
    1672,
    941,
    "13d74ceb058bbf87e1a2cd266e0ba1ddfe37c3b3e56a27375d1cb62dee114b39",
    [
      "event_timeline",
      "broken_timeline_boundary",
      "inline_approval",
      "risk_confirmation_sheet"
    ]
  ),
  target(
    "pairing_journey",
    "assets/ui-concepts/option-b/pairing-journey.png",
    1672,
    941,
    "01987fafdd9beed382cf9377199fb45489cdec75710c721bfc4474aabd81c637",
    ["compact_app_bar", "pairing_progress_rail", "pairing_dominant_state"]
  ),
  target(
    "access_recovery",
    "assets/ui-concepts/option-b/access-recovery-states.png",
    1672,
    941,
    "62d3a688dbc22bc207033ee770f86bd367b76bcb9d4c802c21b13aab3c784bf7",
    ["recovery_owner_label", "recovery_state_rail", "host_status_rail"]
  ),
  target(
    "primary_controls",
    "assets/ui-concepts/option-b/primary-controls.png",
    1672,
    941,
    "b9407bc4f5d11d2ef07aac2db15545ff47d9f920fdf015afac445e8bd879aef2",
    [
      "compact_app_bar",
      "current_next_turn_rail",
      "objective_execution_rail",
      "risk_confirmation_sheet"
    ]
  ),
  target(
    "responsive_continuum",
    "assets/ui-concepts/option-b/responsive-continuum.png",
    1672,
    941,
    "ea950d9fe7e3a8ecd91324bf56697e123c5654f9ed46a0b9fcdb46699eb49626",
    [
      "phone_single_column",
      "tablet_bounded_context",
      "desktop_list_detail_split",
      "grouped_attention_queue",
      "event_timeline"
    ]
  )
]);

const layoutEntryByTraceId = new Map(
  responsiveLayoutCoverageLedger.map((entry) => [entry.traceId, entry] as const)
);

const freshCaptureStateIds = new Set<MobileStateTraceId>([
  "mission_mixed_attention",
  "mission_desktop_expansion",
  "detail_active_writable",
  "detail_replay_boundary",
  "detail_desktop_expansion",
  "pair_claiming",
  "pair_paired",
  "access_locked",
  "access_remote_disabled",
  "access_tailscale_stopped",
  "access_profile_mismatch",
  "access_serve_conflict",
  "model_current",
  "goal_current",
  "plan_current",
  "approval_pending",
  "approval_elevated_confirmation"
]);

export const uiFidelityStateCoverageLedger: readonly UiFidelityStateCoverageEntry[] =
  Object.freeze(mobileStateTraces.map(stateCoverageEntry));

export const uiFidelityInteractionCoverageLedger:
  readonly UiFidelityInteractionCoverageEntry[] = Object.freeze(
    mobileInteractionTraces.map((trace) => {
      const targetId = targetForSurface(trace.uiOwner, trace.id);
      return Object.freeze({
        kind: "interaction",
        id: trace.id,
        surface: trace.uiOwner,
        target: targetId,
        behaviorOwner: trace.downstreamTask,
        evidenceTier:
          trace.uiOwner === "local_only"
            ? "local_only_boundary"
            : "existing_behavior_evidence",
        landmarks: landmarksForTarget(targetId),
        allowedDivergences: divergencesFor(trace.uiOwner, trace.id)
      });
    })
  );

function stateCoverageEntry(trace: MobileStateTrace): UiFidelityStateCoverageEntry {
  const layout = layoutEntryByTraceId.get(trace.id);
  if (layout === undefined || layout.surface !== trace.surface) {
    throw new TypeError(`UI fidelity state ${trace.id} has no exact layout owner.`);
  }
  const targetId = targetForState(trace);
  return Object.freeze({
    kind: "state",
    id: trace.id,
    surface: trace.surface,
    target: targetId,
    behaviorOwner: layout.behaviorOwner,
    evidenceTier:
      trace.renderBoundary === "browser_preload"
        ? "browser_boundary"
        : freshCaptureStateIds.has(trace.id)
          ? "fresh_capture"
          : "existing_behavior_evidence",
    landmarks: landmarksForTarget(targetId),
    allowedDivergences: divergencesFor(trace.surface, trace.id),
    journeys: Object.freeze([...trace.journeys]),
    viewports: Object.freeze([...trace.viewports])
  });
}

function targetForState(trace: MobileStateTrace): UiFidelityTargetId {
  if (trace.id === "mission_desktop_expansion" || trace.id === "detail_desktop_expansion") {
    return "responsive_continuum";
  }
  return targetForSurface(trace.surface, trace.id);
}

function targetForSurface(
  surface: MobileSurfaceId | "local_only",
  traceId: MobileStateTraceId | MobileInteractionId
): UiFidelityTargetId {
  switch (surface) {
    case "mission_control":
      return "mission_control";
    case "session_detail":
    case "composer":
      return "session_detail";
    case "approval":
    case "event_details":
    case "confirmation":
      return "approval_boundary";
    case "pairing":
      return "pairing_journey";
    case "browser_preload":
    case "host_access":
      return "access_recovery";
    case "model":
    case "goal":
    case "plan":
    case "usage":
    case "compact":
    case "skills":
      return "primary_controls";
    case "local_only":
      return traceId === "create_pairing_link" ? "pairing_journey" : "access_recovery";
  }
}

function divergencesFor(
  surface: MobileSurfaceId | "local_only",
  traceId: MobileStateTraceId | MobileInteractionId
): readonly UiFidelityDivergenceId[] {
  const divergences = new Set<UiFidelityDivergenceId>([
    "runtime_backed_copy",
    "typed_fixture_content",
    "lucide_icon_substitution",
    "accessible_semantics"
  ]);
  if (surface === "browser_preload") divergences.add("browser_owned_preload_error");
  if (surface === "pairing" || traceId === "claim_pairing") {
    divergences.add("fragment_scrubbed_automatic_claim");
  }
  if (traceId === "create_pairing_link") divergences.add("local_cli_qr_creation");
  if (
    surface === "model" ||
    surface === "goal" ||
    surface === "plan" ||
    surface === "usage" ||
    surface === "compact" ||
    surface === "skills"
  ) {
    divergences.add("capability_aware_control_state");
  }
  return Object.freeze([...divergences]);
}

function landmarksForTarget(targetId: UiFidelityTargetId): readonly UiFidelityLandmarkId[] {
  const selected = uiFidelityTargets.find(({ id }) => id === targetId);
  if (selected === undefined) throw new TypeError(`Unknown UI fidelity target: ${targetId}`);
  return selected.landmarks;
}

function target(
  id: UiFidelityTargetId,
  path: UiFidelityTarget["path"],
  width: number,
  height: number,
  sha256: string,
  landmarks: readonly UiFidelityLandmarkId[]
): UiFidelityTarget {
  return Object.freeze({
    id,
    path,
    width,
    height,
    sha256,
    landmarks: Object.freeze([...landmarks])
  });
}
