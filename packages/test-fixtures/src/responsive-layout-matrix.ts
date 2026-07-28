import {
  type MobileDownstreamTaskId,
  type MobileJourneyId,
  type MobileReferenceViewport,
  type MobileStateTrace,
  type MobileStateTraceId,
  type MobileSurfaceId,
  mobileStateTraces
} from "./mobile-design-contract.js";

export const responsiveLayoutFamilyIds = [
  "shell_mission_queue",
  "detail_timeline",
  "fixed_action_region",
  "primary_control_sheets",
  "utility_sheets",
  "session_action_diagnostic_sheets",
  "host_access",
  "pairing_and_route_errors"
] as const;

export type ResponsiveLayoutFamilyId = (typeof responsiveLayoutFamilyIds)[number];

export interface ResponsiveLayoutCoverageEntry {
  readonly traceId: MobileStateTraceId;
  readonly surface: MobileSurfaceId;
  readonly family: ResponsiveLayoutFamilyId;
  readonly behaviorOwner: MobileDownstreamTaskId;
  readonly journeys: readonly MobileJourneyId[];
  readonly viewports: readonly MobileReferenceViewport[];
}

export const responsiveLayoutFamilyBySurface = Object.freeze({
  browser_preload: "pairing_and_route_errors",
  mission_control: "shell_mission_queue",
  session_detail: "detail_timeline",
  composer: "fixed_action_region",
  host_access: "host_access",
  pairing: "pairing_and_route_errors",
  model: "primary_control_sheets",
  goal: "primary_control_sheets",
  plan: "primary_control_sheets",
  usage: "utility_sheets",
  compact: "utility_sheets",
  skills: "utility_sheets",
  approval: "detail_timeline",
  event_details: "session_action_diagnostic_sheets",
  confirmation: "session_action_diagnostic_sheets"
} satisfies Readonly<Record<MobileSurfaceId, ResponsiveLayoutFamilyId>>);

export const responsiveLayoutCoverageLedger: readonly ResponsiveLayoutCoverageEntry[] =
  Object.freeze(
    mobileStateTraces.map((trace) => {
      const behaviorOwner = behaviorOwnerFor(trace);
      if (!trace.downstreamTasks.includes(behaviorOwner)) {
        throw new TypeError(
          `Responsive layout trace ${trace.id} does not declare behavior owner ${behaviorOwner}.`
        );
      }
      return Object.freeze({
        traceId: trace.id,
        surface: trace.surface,
        family: responsiveLayoutFamilyBySurface[trace.surface],
        behaviorOwner,
        journeys: Object.freeze([...trace.journeys]),
        viewports: Object.freeze([...trace.viewports])
      });
    })
  );

function behaviorOwnerFor(trace: MobileStateTrace): MobileDownstreamTaskId {
  switch (trace.surface) {
    case "browser_preload":
      return "FE-V1-034";
    case "mission_control":
      return missionBehaviorOwner(trace.id);
    case "session_detail":
      return "FE-V1-012";
    case "composer":
      return "FE-V1-020";
    case "host_access":
      return hostAccessBehaviorOwner(trace.id);
    case "pairing":
      return "FE-V1-013";
    case "model":
      return "FE-V1-021";
    case "goal":
      return "FE-V1-026";
    case "plan":
      return "FE-V1-027";
    case "usage":
      return "FE-V1-028";
    case "compact":
      return "FE-V1-029";
    case "skills":
      return "FE-V1-030";
    case "approval":
      return "FE-V1-022";
    case "event_details":
      return "FE-V1-014";
    case "confirmation":
      return confirmationBehaviorOwner(trace.id);
  }
}

function missionBehaviorOwner(traceId: MobileStateTraceId): MobileDownstreamTaskId {
  if (traceId === "mission_loading") return "FE-V1-010";
  if (["mission_unpaired", "mission_expired", "mission_revoked"].includes(traceId)) {
    return "FE-V1-013";
  }
  if (
    [
      "mission_remote_disabled",
      "mission_tailscale_unavailable",
      "mission_profile_mismatch",
      "mission_serve_conflict"
    ].includes(traceId)
  ) {
    return "FE-V1-034";
  }
  return "FE-V1-011";
}

function hostAccessBehaviorOwner(traceId: MobileStateTraceId): MobileDownstreamTaskId {
  if (traceId === "access_device_list") return "FE-V1-032";
  if (traceId === "access_locked") return "FE-V1-033";
  if (traceId === "access_runtime_incompatible") return "FE-V1-035";
  if (traceId === "access_stream_unavailable") return "FE-V1-025";
  if (["access_csrf_bootstrap", "access_csrf_failure"].includes(traceId)) {
    return "FE-V1-031";
  }
  if (
    [
      "access_remote_ready",
      "access_remote_disabled",
      "access_tailscale_absent",
      "access_tailscale_stopped",
      "access_tailscale_signed_out",
      "access_profile_mismatch",
      "access_serve_absent",
      "access_remote_checking",
      "access_serve_conflict",
      "access_profile_switch_boundary"
    ].includes(traceId)
  ) {
    return "FE-V1-034";
  }
  return "FE-V1-013";
}

function confirmationBehaviorOwner(traceId: MobileStateTraceId): MobileDownstreamTaskId {
  switch (traceId) {
    case "confirm_interrupt":
      return "FE-V1-036";
    case "confirm_archive":
      return "FE-V1-037";
    case "confirm_lock":
      return "FE-V1-033";
    case "confirm_revoke":
      return "FE-V1-032";
    default:
      throw new TypeError(`Unsupported responsive confirmation trace: ${traceId}`);
  }
}
