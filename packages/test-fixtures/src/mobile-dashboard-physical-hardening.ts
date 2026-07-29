import { mobileWorkflowPaths } from "./copy-workflow-matrix.js";
import {
  type MobileInteractionId,
  type MobileStateTraceId,
  mobileInteractionIds,
  mobileJourneyIds,
  mobileStateTraceIds,
  mobileSurfaceIds
} from "./mobile-design-contract.js";
import { uiFidelityTargets } from "./ui-fidelity-matrix.js";

export const mobileDashboardPhysicalHardeningCriterionIds = Object.freeze([
  "MDH-01",
  "MDH-02",
  "MDH-03",
  "MDH-04",
  "MDH-05",
  "MDH-06",
  "MDH-07",
  "MDH-08",
  "MDH-09",
  "MDH-10",
  "MDH-11",
  "MDH-12",
  "MDH-13",
  "MDH-14",
  "MDH-15",
  "MDH-16",
  "MDH-17",
  "MDH-18",
  "MDH-19",
  "MDH-20",
  "MDH-21",
  "MDH-22",
  "MDH-23",
  "MDH-24"
] as const);

export const mobileDashboardLocalLaptopInteractionIds = Object.freeze([
  "create_pairing_link",
  "enable_remote_local",
  "disable_remote_local",
  "switch_tailscale_profile_local",
  "unlock_host_local"
] as const satisfies readonly MobileInteractionId[]);

const localLaptopInteractions = new Set<MobileInteractionId>(
  mobileDashboardLocalLaptopInteractionIds
);

export const mobileDashboardPackageBrowserInteractionIds = Object.freeze(
  mobileInteractionIds.filter((id) => !localLaptopInteractions.has(id))
);

export const mobileDashboardPhysicalInteractionIds = Object.freeze([
  ...mobileInteractionIds
]);

export const mobileDashboardPackageOnlyTransportStateIds = Object.freeze([
  "mission_remote_disabled",
  "mission_profile_mismatch",
  "access_remote_disabled",
  "access_tailscale_stopped",
  "access_profile_mismatch"
] as const satisfies readonly MobileStateTraceId[]);

export const mobileDashboardPhysicalStateIds = Object.freeze([
  "preload_remote_origin_unreachable",
  "mission_loading",
  "mission_mixed_attention",
  "mission_locked",
  "mission_runtime_incompatible",
  "detail_active_writable",
  "detail_approval",
  "detail_interrupted",
  "detail_stale",
  "detail_stream_reconnecting",
  "detail_replay_boundary",
  "detail_not_found",
  "composer_keyboard_open",
  "composer_submitting",
  "composer_accepted",
  "composer_running",
  "composer_completed",
  "access_remote_ready",
  "access_unpaired",
  "access_revoked",
  "access_locked",
  "access_remote_checking",
  "access_profile_switch_boundary",
  "access_csrf_bootstrap",
  "access_device_list",
  "pair_fragment_ready",
  "pair_claiming",
  "pair_paired",
  "pair_remote_unreachable",
  "model_current",
  "model_accepted",
  "model_success",
  "goal_current",
  "goal_accepted",
  "goal_success",
  "plan_current",
  "plan_accepted",
  "plan_success",
  "usage_content",
  "compact_confirmation",
  "compact_accepted",
  "compact_completed",
  "skills_content",
  "approval_pending",
  "approval_elevated_confirmation",
  "approval_responding",
  "approval_approved",
  "event_complete",
  "event_boundary",
  "event_redacted",
  "confirm_interrupt",
  "confirm_archive",
  "confirm_lock",
  "confirm_revoke"
] as const satisfies readonly MobileStateTraceId[]);

export const mobileDashboardPhysicalHardeningRequirementIds = Object.freeze([
  "FR-002",
  "FR-005",
  "FR-006",
  "FR-007",
  "FR-008",
  "FR-009",
  "FR-010",
  "FR-016",
  "IR-001",
  "IR-002",
  "IR-003",
  "IR-004",
  "IR-005",
  "IR-006",
  "IR-007",
  "IR-008",
  "IR-009",
  "IR-010",
  "IR-011",
  "IR-012",
  "NFR-001",
  "NFR-002",
  "NFR-004",
  "NFR-005",
  "NFR-011",
  "PR-005",
  "SFR-001",
  "SFR-002",
  "SFR-003",
  "SFR-004",
  "SFR-009",
  "SFR-018"
] as const);

export const mobileDashboardPhysicalHardeningEvidence = Object.freeze([
  evidence("state-contract", "L1", "complete", "artifacts/fe-v1-004-mobile-state-interaction-contract.md"),
  evidence("selected-fidelity", "L3", "complete", "artifacts/fe-v1-017-selected-target-fidelity.md"),
  evidence("copy-workflow", "L3", "complete", "artifacts/fe-v1-018-copy-workflow-review.md"),
  evidence("supported-browser", "L3", "complete", "artifacts/fe-v1-040-supported-browser-interaction-matrix/manifest.json"),
  evidence("interface-hardening", "L3", "complete", "artifacts/ifc-v1-091-selected-production-interface-hardening/evidence.json"),
  evidence("pairing-phone", "L4", "complete", "artifacts/fe-v1-013-pairing-host-access.md"),
  evidence("prompt-phone", "L4", "complete", "artifacts/fe-v1-020-selected-session-prompt-composer/physical-android.json"),
  evidence("recovery-phone", "L4", "complete", "artifacts/fe-v1-034-remote-connection-recovery/physical-android/evidence.json"),
  evidence("remote-security-phone", "L4", "complete", "artifacts/ifc-v1-079-device/evidence.json"),
  evidence("aggregate-phone", "L4", "pending", "artifacts/fe-v1-090-mobile-dashboard-physical-hardening/evidence.json"),
  evidence("final-deployment", "L4", "pending", "artifacts/fe-v1-090-mobile-dashboard-physical-hardening/deployment.json")
]);

export function createMobileDashboardPhysicalHardeningLedger(): Readonly<Record<string, unknown>> {
  const physicalStates = new Set<MobileStateTraceId>(mobileDashboardPhysicalStateIds);
  const packageOnlyTransportStates = new Set<MobileStateTraceId>(
    mobileDashboardPackageOnlyTransportStateIds
  );
  return deepFreeze({
    schema_version: 2,
    task: "FE-V1-090",
    decision: "DEC-028",
    criteria: mobileDashboardPhysicalHardeningCriterionIds.map((id) => ({ id })),
    requirements: [...mobileDashboardPhysicalHardeningRequirementIds],
    counts: {
      criteria: mobileDashboardPhysicalHardeningCriterionIds.length,
      requirements: mobileDashboardPhysicalHardeningRequirementIds.length,
      journeys: mobileJourneyIds.length,
      workflow_paths: mobileWorkflowPaths.length,
      surfaces: mobileSurfaceIds.length,
      states: mobileStateTraceIds.length,
      physical_states: mobileDashboardPhysicalStateIds.length,
      package_only_transport_states: mobileDashboardPackageOnlyTransportStateIds.length,
      interactions: mobileInteractionIds.length,
      package_browser_interactions: mobileDashboardPackageBrowserInteractionIds.length,
      physical_interactions: mobileDashboardPhysicalInteractionIds.length,
      selected_targets: uiFidelityTargets.length
    },
    targets: uiFidelityTargets.map((target) => ({
      id: target.id,
      path: target.path,
      sha256: target.sha256,
      landmarks: [...target.landmarks]
    })),
    journeys: mobileJourneyIds.map((id) => ({
      id,
      workflow_paths: mobileWorkflowPaths
        .filter((path) => path.journey === id)
        .map((path) => path.id)
    })),
    surfaces: [...mobileSurfaceIds],
    states: mobileStateTraceIds.map((id) => ({
      id,
      package_browser_required: true,
      physical_checkpoint_required: physicalStates.has(id),
      ...(packageOnlyTransportStates.has(id)
        ? { physical_exclusion: "transport_self_invalidating" }
        : {})
    })),
    interactions: mobileInteractionIds.map((id) => ({
      id,
      package_browser_required: !localLaptopInteractions.has(id),
      physical_android_required: true
    })),
    evidence: mobileDashboardPhysicalHardeningEvidence.map((owner) => ({ ...owner }))
  });
}

function evidence(
  id: string,
  level: "L1" | "L3" | "L4",
  status: "complete" | "pending",
  path: string
) {
  return Object.freeze({ id, level, status, path });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
