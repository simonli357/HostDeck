import {
  type MobileDownstreamTaskId,
  type MobileInteractionId,
  type MobileInteractionTrace,
  type MobileJourneyId,
  mobileInteractionTraces,
  mobileStateTraces
} from "./mobile-design-contract.js";

export const supportedBrowserProjectIds = Object.freeze([
  "chromium-phone",
  "chromium-desktop",
  "firefox-phone",
  "firefox-desktop"
] as const);
export type SupportedBrowserProjectId = (typeof supportedBrowserProjectIds)[number];

export const browserPortabilityFamilyIds = Object.freeze([
  "package_navigation",
  "pairing_reload",
  "stream_continuity",
  "prompt",
  "primary_controls",
  "utilities",
  "approval",
  "session_actions",
  "host_security",
  "remote_recovery"
] as const);
export type BrowserPortabilityFamilyId = (typeof browserPortabilityFamilyIds)[number];

export const browserPortabilityDispositionIds = Object.freeze([
  "automated_all_projects",
  "contract_only_local_boundary"
] as const);
export type BrowserPortabilityDispositionId =
  (typeof browserPortabilityDispositionIds)[number];

export interface BrowserInteractionCoverageEntry {
  readonly interactionId: MobileInteractionId;
  readonly family: BrowserPortabilityFamilyId;
  readonly behaviorOwner: MobileDownstreamTaskId;
  readonly disposition: BrowserPortabilityDispositionId;
  readonly projectIds: readonly SupportedBrowserProjectId[];
  readonly journeys: readonly MobileJourneyId[];
  readonly mutation: boolean;
}

const localBoundaryInteractions = new Set<MobileInteractionId>([
  "create_pairing_link",
  "enable_remote_local",
  "disable_remote_local",
  "switch_tailscale_profile_local",
  "unlock_host_local"
]);

export const browserInteractionCoverageLedger: readonly BrowserInteractionCoverageEntry[] =
  Object.freeze(mobileInteractionTraces.map(coverageEntry));

function coverageEntry(trace: MobileInteractionTrace): BrowserInteractionCoverageEntry {
  const disposition = localBoundaryInteractions.has(trace.id)
    ? "contract_only_local_boundary"
    : "automated_all_projects";
  const journeys = unique(
    mobileStateTraces
      .filter(({ interactions }) => interactions.includes(trace.id))
      .flatMap(({ journeys: stateJourneys }) => stateJourneys)
  ) as readonly MobileJourneyId[];
  return Object.freeze({
    interactionId: trace.id,
    family: portabilityFamily(trace.id),
    behaviorOwner: trace.downstreamTask,
    disposition,
    projectIds:
      disposition === "automated_all_projects"
        ? supportedBrowserProjectIds
        : Object.freeze([]),
    journeys: Object.freeze(journeys),
    mutation: trace.mutation
  });
}

function portabilityFamily(id: MobileInteractionId): BrowserPortabilityFamilyId {
  if (includes(id, [
    "bootstrap_shell",
    "read_host_access",
    "read_host_status",
    "read_sessions",
    "open_session",
    "read_session_detail",
    "navigate_back"
  ])) return "package_navigation";
  if (includes(id, [
    "create_pairing_link",
    "consume_pairing_fragment",
    "claim_pairing",
    "bootstrap_csrf"
  ])) return "pairing_reload";
  if (includes(id, ["stream_events", "reconnect_stream"])) return "stream_continuity";
  if (id === "send_prompt") return "prompt";
  if (includes(id, [
    "read_model",
    "select_model",
    "read_goal",
    "mutate_goal",
    "read_plan",
    "select_plan"
  ])) return "primary_controls";
  if (includes(id, [
    "read_usage",
    "read_compact",
    "start_compact",
    "read_skills"
  ])) return "utilities";
  if (includes(id, ["read_approvals", "respond_approval"])) return "approval";
  if (includes(id, [
    "read_event_details",
    "interrupt_turn",
    "archive_session",
    "read_resume_metadata",
    "copy_resume_command"
  ])) return "session_actions";
  if (includes(id, [
    "read_devices",
    "revoke_device",
    "lock_host",
    "unlock_host_local"
  ])) return "host_security";
  if (includes(id, [
    "read_remote_status",
    "enable_remote_local",
    "disable_remote_local",
    "switch_tailscale_profile_local"
  ])) return "remote_recovery";
  throw new TypeError(`Browser interaction ${id} has no portability family.`);
}

function includes(
  candidate: MobileInteractionId,
  values: readonly MobileInteractionId[]
): boolean {
  return values.includes(candidate);
}

function unique<Value extends string>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)].sort();
}
