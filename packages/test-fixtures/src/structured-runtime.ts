import type {
  ManagedSessionProjection,
  PendingApproval,
  RuntimeCompatibility,
  SelectedHostAccess,
  SelectedMissionControlViewModel,
  SelectedProjectionEvent,
  SelectedSessionDetailViewModel,
  SelectedSessionEventStream
} from "@hostdeck/contracts";
import {
  managedSessionProjectionSchema,
  pendingApprovalSchema,
  runtimeCapabilitySetSchema,
  runtimeCompatibilitySchema,
  selectedControlStateSchema,
  selectedHostAccessSchema,
  selectedMissionControlViewModelSchema,
  selectedSessionDetailViewModelSchema,
  selectedSessionEventStreamSchema
} from "@hostdeck/contracts";
import {
  mobileAttentionPriority,
  operationCapability,
  type RuntimeCapability,
  type RuntimeCapabilityState,
  runtimeCapabilities,
  type StructuredControlKind
} from "@hostdeck/core";

export const selectedFixtureTimestamp = "2026-07-09T16:00:00.000Z";
const laterFixtureTimestamp = "2026-07-09T16:01:00.000Z";

export const readyRuntimeCompatibility = compatibilityFixture({
  state: "ready",
  capabilityOverrides: {
    compact: "unavailable"
  }
});

export const degradedRuntimeCompatibility = compatibilityFixture({
  state: "degraded",
  reason: "Optional usage capability could not be confirmed.",
  capabilityOverrides: {
    usage: "unknown",
    compact: "unavailable"
  }
});

export const incompatibleRuntimeCompatibility = compatibilityFixture({
  state: "incompatible",
  reason: "Installed Codex does not expose the required plan capability.",
  capabilityOverrides: {
    plan: "unavailable",
    compact: "unavailable"
  }
});

export const disconnectedRuntimeCompatibility = compatibilityFixture({
  state: "disconnected",
  reason: "The private app-server connection closed.",
  capabilityOverrides: {
    compact: "unavailable"
  }
});

export const requiredStructuredRuntimeFixtureIds = [
  "running",
  "needs_input",
  "approval",
  "completed",
  "interrupted",
  "failed",
  "compacting",
  "rate_limit",
  "incompatible",
  "unknown_optional",
  "disconnect",
  "replay_boundary"
] as const;

export type StructuredRuntimeFixtureId = (typeof requiredStructuredRuntimeFixtureIds)[number];

export interface StructuredRuntimeFixture {
  readonly id: StructuredRuntimeFixtureId;
  readonly compatibility: RuntimeCompatibility;
  readonly session: ManagedSessionProjection;
  readonly stream: SelectedSessionEventStream;
  readonly pendingApproval: PendingApproval | null;
}

const runningSession = sessionFixture("sess_select_running", "running", {
  turn_state: "in_progress",
  attention: "watch",
  recent_summary: "Reviewing the selected runtime contracts.",
  last_event_cursor: 1
});

const inputSession = sessionFixture("sess_select_input", "needs-input", {
  turn_state: "waiting_for_input",
  attention: "needs_input",
  recent_summary: "Which compatibility policy should be used?",
  last_event_cursor: 2
});

const approvalSession = sessionFixture("sess_select_approval", "approval", {
  turn_state: "waiting_for_approval",
  attention: "needs_approval",
  recent_summary: "Approval is required before running pnpm install.",
  last_event_cursor: 3
});

const completedSession = sessionFixture("sess_select_complete", "completed", {
  turn_state: "completed",
  attention: "none",
  recent_summary: "Contract tests completed.",
  last_event_cursor: 4
});

const interruptedSession = sessionFixture("sess_select_interrupt", "interrupted", {
  turn_state: "interrupted",
  attention: "stuck",
  recent_summary: "The active turn was interrupted by the user.",
  last_event_cursor: 5
});

const failedSession = sessionFixture("sess_select_failure", "failed", {
  turn_state: "failed",
  attention: "failed",
  recent_summary: "The selected runtime rejected malformed protocol data.",
  last_event_cursor: 6
});

const compactingSession = sessionFixture("sess_select_compact", "compacting", {
  turn_state: "in_progress",
  attention: "watch",
  recent_summary: "Compacting thread context.",
  last_event_cursor: 7
});

const rateLimitSession = sessionFixture("sess_select_rate", "rate-limit", {
  turn_state: "in_progress",
  attention: "watch",
  recent_summary: "Waiting for the account rate window to reset.",
  last_event_cursor: 8
});

const incompatibleSession = sessionFixture("sess_select_incompat", "incompatible", {
  session_state: "incompatible",
  turn_state: "unknown",
  attention: "unknown",
  freshness: "incompatible",
  freshness_reason: "Installed Codex does not expose the required plan capability.",
  recent_summary: "Update Codex before sending another operation.",
  last_event_cursor: 9
});

const unknownSession = sessionFixture("sess_select_unknown", "unknown-event", {
  turn_state: "unknown",
  attention: "unknown",
  recent_summary: "An additive optional event was not projected.",
  last_event_cursor: 10
});

const disconnectedSession = sessionFixture("sess_select_disconnect", "disconnected", {
  turn_state: "unknown",
  attention: "unknown",
  freshness: "disconnected",
  freshness_reason: "The private app-server connection closed.",
  recent_summary: "Showing the last committed projection.",
  last_event_cursor: 11
});

const boundarySession = sessionFixture("sess_select_boundary", "boundary", {
  turn_state: "idle",
  attention: "none",
  recent_summary: "Earlier projected events were pruned by retention.",
  last_event_cursor: 12
});

const approvalRequest = pendingApprovalSchema.parse({
  target: targetFor(approvalSession),
  request_id: "approval:fixture:1",
  action: "Run pnpm install --frozen-lockfile",
  scope: "/home/simonli/Videos/apps/HostDeck",
  reason: "Install the lockfile-defined workspace dependencies.",
  risk: "elevated",
  grant_scope: "one_time",
  state: "pending",
  created_at: selectedFixtureTimestamp,
  expires_at: "2026-07-09T16:05:00.000Z",
  decision: null
});

export const selectedStructuredRuntimeFixtures: readonly StructuredRuntimeFixture[] = [
  runtimeFixture(runningSession, "running", [
    eventFor(runningSession, 1, {
      type: "turn",
      turn_id: "turn-running-1",
      state: "in_progress",
      error: null
    })
  ]),
  runtimeFixture(inputSession, "needs_input", [
    eventFor(inputSession, 2, {
      type: "turn",
      turn_id: "turn-input-1",
      state: "waiting_for_input",
      error: null
    })
  ]),
  runtimeFixture(
    approvalSession,
    "approval",
    [
      eventFor(approvalSession, 3, {
        type: "approval",
        request_id: approvalRequest.request_id,
        state: "pending",
        action: approvalRequest.action,
        scope: approvalRequest.scope,
        reason: approvalRequest.reason,
        risk: approvalRequest.risk,
        expires_at: approvalRequest.expires_at,
        decision: null
      })
    ],
    { pendingApproval: approvalRequest }
  ),
  runtimeFixture(completedSession, "completed", [
    eventFor(completedSession, 4, {
      type: "turn",
      turn_id: "turn-completed-1",
      state: "completed",
      error: null
    })
  ]),
  runtimeFixture(interruptedSession, "interrupted", [
    eventFor(interruptedSession, 5, {
      type: "turn",
      turn_id: "turn-interrupted-1",
      state: "interrupted",
      error: null
    })
  ]),
  runtimeFixture(failedSession, "failed", [
    eventFor(failedSession, 6, {
      type: "turn",
      turn_id: "turn-failed-1",
      state: "failed",
      error: {
        code: "protocol_error",
        message: "The app-server returned a malformed turn event."
      }
    })
  ]),
  runtimeFixture(compactingSession, "compacting", [
    eventFor(compactingSession, 7, {
      type: "activity",
      activity: "compaction",
      state: "started",
      item_id: "item-compaction-1",
      title: "Compacting context",
      detail: "Codex is reducing the active context window."
    })
  ]),
  runtimeFixture(rateLimitSession, "rate_limit", [
    eventFor(rateLimitSession, 8, {
      type: "activity",
      activity: "rate_limit",
      state: "updated",
      item_id: null,
      title: "Rate limit active",
      detail: "The runtime will report when the account window resets."
    })
  ]),
  runtimeFixture(
    incompatibleSession,
    "incompatible",
    [
      eventFor(incompatibleSession, 9, {
        type: "runtime",
        state: "incompatible",
        message: "Installed Codex does not expose the required plan capability."
      })
    ],
    { compatibility: incompatibleRuntimeCompatibility }
  ),
  runtimeFixture(unknownSession, "unknown_optional", [
    eventFor(unknownSession, 10, {
      type: "unknown_optional",
      upstream_type: "thread/metadata/extended",
      summary: "Optional additive runtime metadata was omitted from the projection."
    })
  ]),
  runtimeFixture(
    disconnectedSession,
    "disconnect",
    [
      eventFor(disconnectedSession, 11, {
        type: "runtime",
        state: "disconnected",
        message: "The private app-server connection closed."
      })
    ],
    { compatibility: disconnectedRuntimeCompatibility }
  ),
  runtimeFixture(boundarySession, "replay_boundary", [
    eventFor(boundarySession, 12, {
      type: "replay_boundary",
      after: 4,
      next_cursor: 12,
      reason: "retention"
    })
  ])
];

export const requiredSelectedMobileFixtureIds = [
  "mission_control_loading",
  "mission_control_empty",
  "mission_control_ready",
  "mission_control_offline",
  "mission_control_incompatible",
  "mission_control_certificate_error",
  "mission_control_permission_denied",
  "mission_control_degraded",
  "mission_control_locked",
  "mission_control_fatal",
  "session_detail_loading",
  "session_detail_ready",
  "session_detail_offline",
  "session_detail_incompatible",
  "session_detail_certificate_error",
  "session_detail_permission_denied",
  "session_detail_not_found",
  "session_detail_stale",
  "session_detail_degraded",
  "session_detail_fatal",
  "session_detail_boundary"
] as const;

export type SelectedMobileFixtureId = (typeof requiredSelectedMobileFixtureIds)[number];

export type SelectedMobileFixture =
  | {
      readonly id: SelectedMobileFixtureId;
      readonly surface: "mission_control";
      readonly viewModel: SelectedMissionControlViewModel;
    }
  | {
      readonly id: SelectedMobileFixtureId;
      readonly surface: "session_detail";
      readonly viewModel: SelectedSessionDetailViewModel;
    };

const readyHostAccess = hostAccessFixture();
const offlineHostAccess = hostAccessFixture({
  runtime: disconnectedRuntimeCompatibility,
  stream_state: "disconnected",
  writes_enabled: false,
  last_error: errorFixture("runtime_unavailable", "The private app-server connection closed.", true)
});
const incompatibleHostAccess = hostAccessFixture({
  runtime: incompatibleRuntimeCompatibility,
  writes_enabled: false,
  last_error: errorFixture("incompatible_runtime", "Update Codex before using remote controls.", false)
});
const degradedHostAccess = hostAccessFixture({
  runtime: degradedRuntimeCompatibility,
  writes_enabled: false,
  last_error: errorFixture("capability_unavailable", "Some optional Codex capabilities are unavailable.", false)
});
const lockedHostAccess = hostAccessFixture({
  locked: true,
  writes_enabled: false,
  last_error: errorFixture("host_locked", "Remote writes are locked.", false)
});
const certificateErrorHostAccess = hostAccessFixture({
  origin: "https://hostdeck.local:3777",
  connection_mode: "lan",
  transport: "certificate_error",
  reads_enabled: false,
  writes_enabled: false,
  last_error: errorFixture("insecure_transport", "The configured HostDeck certificate is not trusted.", false)
});
const permissionDeniedHostAccess = hostAccessFixture({
  origin: "https://hostdeck.local:3777",
  connection_mode: "lan",
  transport: "https",
  access: "unpaired",
  device_id: null,
  device_label: null,
  reads_enabled: false,
  writes_enabled: false,
  last_error: errorFixture("permission_denied", "Pair this phone before reading session data.", false)
});
const fatalHostAccess = hostAccessFixture({
  runtime: disconnectedRuntimeCompatibility,
  stream_state: "error",
  writes_enabled: false,
  last_error: errorFixture("internal_error", "HostDeck cannot read its selected session projection.", false)
});

const missionRows = [
  mobileRow(approvalSession, "needs_approval"),
  mobileRow(inputSession, "needs_input"),
  mobileRow(failedSession, "failed"),
  mobileRow(interruptedSession, "interrupted"),
  mobileRow(runningSession, "running"),
  mobileRow(completedSession, "quiet")
];

export const selectedMobileStateFixtures: readonly SelectedMobileFixture[] = [
  missionFixture("mission_control_loading", "loading", readyHostAccess, [], null),
  missionFixture("mission_control_empty", "empty", readyHostAccess, [], null),
  missionFixture("mission_control_ready", "ready", readyHostAccess, missionRows, null),
  missionFixture("mission_control_offline", "offline", offlineHostAccess, missionRows, "Showing the last committed projection."),
  missionFixture(
    "mission_control_incompatible",
    "incompatible",
    incompatibleHostAccess,
    [mobileRow(incompatibleSession, "unknown")],
    "Update Codex before using remote controls."
  ),
  missionFixture(
    "mission_control_certificate_error",
    "certificate_error",
    certificateErrorHostAccess,
    [],
    "The configured HostDeck certificate is not trusted."
  ),
  missionFixture(
    "mission_control_permission_denied",
    "permission_denied",
    permissionDeniedHostAccess,
    [],
    "Pair this phone before reading session data."
  ),
  missionFixture(
    "mission_control_degraded",
    "degraded",
    degradedHostAccess,
    missionRows,
    "Some optional Codex capabilities are unavailable."
  ),
  missionFixture("mission_control_locked", "degraded", lockedHostAccess, missionRows, "Remote writes are locked."),
  missionFixture(
    "mission_control_fatal",
    "fatal",
    fatalHostAccess,
    [],
    "HostDeck cannot read its selected session projection."
  ),
  unavailableDetailFixture("session_detail_loading", "loading", readyHostAccess, null),
  detailFixture("session_detail_ready", "ready", readyHostAccess, fixtureById("approval"), null, true),
  detailFixture(
    "session_detail_offline",
    "offline",
    offlineHostAccess,
    fixtureById("disconnect"),
    "Showing the last committed projection.",
    false
  ),
  detailFixture(
    "session_detail_incompatible",
    "incompatible",
    incompatibleHostAccess,
    fixtureById("incompatible"),
    "Update Codex before using remote controls.",
    false
  ),
  unavailableDetailFixture(
    "session_detail_certificate_error",
    "certificate_error",
    certificateErrorHostAccess,
    "The configured HostDeck certificate is not trusted."
  ),
  unavailableDetailFixture(
    "session_detail_permission_denied",
    "permission_denied",
    permissionDeniedHostAccess,
    "Pair this phone before reading session data."
  ),
  unavailableDetailFixture("session_detail_not_found", "not_found", readyHostAccess, "The selected session was not found."),
  detailFixture(
    "session_detail_stale",
    "stale",
    offlineHostAccess,
    fixtureById("disconnect"),
    "This projection is stale and remote controls are disabled.",
    false
  ),
  detailFixture(
    "session_detail_degraded",
    "degraded",
    degradedHostAccess,
    fixtureById("running"),
    "Some optional Codex capabilities are unavailable.",
    false
  ),
  unavailableDetailFixture(
    "session_detail_fatal",
    "fatal",
    fatalHostAccess,
    "HostDeck cannot read its selected session projection."
  ),
  detailFixture(
    "session_detail_boundary",
    "ready",
    readyHostAccess,
    fixtureById("replay_boundary"),
    null,
    true,
    { boundary: true }
  )
];

export function structuredRuntimeFixtureById(id: StructuredRuntimeFixtureId): StructuredRuntimeFixture {
  const fixture = selectedStructuredRuntimeFixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new TypeError(`Missing structured runtime fixture: ${id}`);
  return fixture;
}

export function selectedMobileFixtureById(id: SelectedMobileFixtureId): SelectedMobileFixture {
  const fixture = selectedMobileStateFixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new TypeError(`Missing selected mobile fixture: ${id}`);
  return fixture;
}

function compatibilityFixture(options: {
  readonly state: RuntimeCompatibility["state"];
  readonly reason?: string;
  readonly capabilityOverrides?: Partial<Record<RuntimeCapability, RuntimeCapabilityState>>;
}): RuntimeCompatibility {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: options.state,
    observed_version: "0.144.0",
    binding_id: "codex-app-server-0.144.0:sha256:fixture",
    capabilities: runtimeCapabilitySetSchema.parse(
      runtimeCapabilities.map((name) => {
        const state = options.capabilityOverrides?.[name] ?? "available";
        return {
          name,
          state,
          reason: state === "available" ? null : `${name} is ${state} in this fixture.`
        };
      })
    ),
    checked_at: selectedFixtureTimestamp,
    reason: options.state === "ready" ? null : (options.reason ?? `${options.state} runtime fixture.`)
  });
}

function sessionFixture(id: string, name: string, overrides: Readonly<Record<string, unknown>>): ManagedSessionProjection {
  return managedSessionProjectionSchema.parse({
    id,
    name,
    codex_thread_id: `thread-${id}`,
    cwd: `/home/simonli/work/${name}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: selectedFixtureTimestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: laterFixtureTimestamp,
    last_activity_at: laterFixtureTimestamp,
    branch: "main",
    model: "gpt-5.5-codex",
    goal: {
      objective: "Complete the selected HostDeck V1 foundation.",
      state: "active"
    },
    recent_summary: "",
    last_event_cursor: null,
    ...overrides
  });
}

function eventFor(
  session: ManagedSessionProjection,
  cursor: number,
  event: Readonly<Record<string, unknown>>
): SelectedProjectionEvent {
  return {
    session_id: session.id,
    cursor,
    captured_at: laterFixtureTimestamp,
    upstream_at: selectedFixtureTimestamp,
    codex_event_id: `event-${cursor}`,
    codex_event_type: `fixture/${String(event.type)}`,
    content_state: "complete",
    content_notice: null,
    ...event
  } as SelectedProjectionEvent;
}

function runtimeFixture(
  session: ManagedSessionProjection,
  id: StructuredRuntimeFixtureId,
  events: readonly SelectedProjectionEvent[],
  options: {
    readonly compatibility?: RuntimeCompatibility;
    readonly pendingApproval?: PendingApproval;
  } = {}
): StructuredRuntimeFixture {
  return {
    id,
    compatibility: options.compatibility ?? readyRuntimeCompatibility,
    session,
    stream: selectedSessionEventStreamSchema.parse({
      session_id: session.id,
      events,
      next_cursor: events.at(-1)?.cursor ?? 0,
      truncated: events.some((event) => event.type === "replay_boundary")
    }),
    pendingApproval: options.pendingApproval ?? null
  };
}

function targetFor(session: ManagedSessionProjection) {
  return {
    type: "managed_session" as const,
    session_id: session.id,
    codex_thread_id: session.codex_thread_id
  };
}

function fixtureById(id: StructuredRuntimeFixtureId): StructuredRuntimeFixture {
  return structuredRuntimeFixtureById(id);
}

function hostAccessFixture(overrides: Readonly<Record<string, unknown>> = {}): SelectedHostAccess {
  return selectedHostAccessSchema.parse({
    origin: "http://127.0.0.1:3777",
    connection_mode: "loopback",
    transport: "http",
    access: "paired_write",
    device_id: "fixture-phone-001",
    device_label: "Pixel fixture",
    reads_enabled: true,
    writes_enabled: true,
    locked: false,
    runtime: readyRuntimeCompatibility,
    stream_state: "connected",
    remote_unlock_available: false,
    remote_network_mutation_available: false,
    last_error: null,
    ...overrides
  });
}

function errorFixture(code: string, message: string, retryable: boolean) {
  return {
    code,
    message,
    retryable
  };
}

function mobileRow(session: ManagedSessionProjection, displayState: string) {
  return {
    session,
    project_cue: session.cwd.split("/").at(-1) ?? session.name,
    display_state: displayState,
    attention_rank: mobileAttentionPriority(session.attention),
    controls_disabled: session.freshness !== "current" || ["archived", "stale", "incompatible", "unknown"].includes(session.session_state)
  };
}

function missionFixture(
  id: SelectedMobileFixtureId,
  state: string,
  hostAccess: SelectedHostAccess,
  sessions: readonly ReturnType<typeof mobileRow>[],
  errorMessage: string | null
): SelectedMobileFixture {
  return {
    id,
    surface: "mission_control",
    viewModel: selectedMissionControlViewModelSchema.parse({
      screen: "mission_control",
      state,
      host_access: hostAccess,
      sessions,
      error_message: errorMessage
    })
  };
}

function controlFixture(control: StructuredControlKind, enabled: boolean) {
  return selectedControlStateSchema.parse({
    control,
    capability: operationCapability(control),
    availability: enabled ? (control === "compact" ? "unsupported" : "available") : "blocked",
    phase: "idle",
    current_value: control === "model" ? "gpt-5.5-codex" : control === "goal" ? "Active goal" : null,
    disabled_reason: enabled && control !== "compact" ? null : control === "compact" ? "Compact is unavailable in this runtime." : "Remote controls are unavailable.",
    error: null
  });
}

function detailFixture(
  id: SelectedMobileFixtureId,
  state: string,
  hostAccess: SelectedHostAccess,
  runtimeFixtureValue: StructuredRuntimeFixture,
  errorMessage: string | null,
  controlsEnabled: boolean,
  options: { readonly boundary?: boolean } = {}
): SelectedMobileFixture {
  const resumeAvailable = hostAccess.runtime.state === "ready" || hostAccess.runtime.state === "degraded";
  return {
    id,
    surface: "session_detail",
    viewModel: selectedSessionDetailViewModelSchema.parse({
      screen: "session_detail",
      state,
      host_access: hostAccess,
      session: runtimeFixtureValue.session,
      stream_state: hostAccess.stream_state,
      events: runtimeFixtureValue.stream,
      approvals: runtimeFixtureValue.pendingApproval === null ? [] : [runtimeFixtureValue.pendingApproval],
      prompt: {
        enabled: controlsEnabled,
        phase: "idle",
        disabled_reason: controlsEnabled ? null : "Remote controls are unavailable.",
        error: null
      },
      primary_controls: ["model", "goal", "plan"].map((control) => controlFixture(control as StructuredControlKind, controlsEnabled)),
      utility_controls: ["usage", "compact", "skills"].map((control) => controlFixture(control as StructuredControlKind, controlsEnabled)),
      risky_controls: ["interrupt", "archive"].map((action) => ({
        action,
        enabled: controlsEnabled,
        requires_confirmation: true,
        disabled_reason: controlsEnabled ? null : "Remote controls are unavailable."
      })),
      diagnostics: {
        read_only: true,
        projection_complete: !options.boundary,
        boundary_visible: options.boundary ?? false,
        redaction_visible: false,
        incomplete_reason: options.boundary ? "Earlier events were removed by the retention policy." : null
      },
      laptop_resume: {
        available: resumeAvailable,
        command: resumeAvailable
          ? `codex resume --remote unix:///run/user/1000/hostdeck/app-server.sock ${runtimeFixtureValue.session.codex_thread_id}`
          : null,
        unavailable_reason: resumeAvailable ? null : "The selected Codex runtime is not available."
      },
      error_message: errorMessage
    })
  };
}

function unavailableDetailFixture(
  id: SelectedMobileFixtureId,
  state: string,
  hostAccess: SelectedHostAccess,
  errorMessage: string | null
): SelectedMobileFixture {
  return {
    id,
    surface: "session_detail",
    viewModel: selectedSessionDetailViewModelSchema.parse({
      screen: "session_detail",
      state,
      host_access: hostAccess,
      session: null,
      stream_state: hostAccess.stream_state,
      events: null,
      approvals: [],
      prompt: {
        enabled: false,
        phase: "idle",
        disabled_reason: "Session data is unavailable.",
        error: null
      },
      primary_controls: ["model", "goal", "plan"].map((control) => controlFixture(control as StructuredControlKind, false)),
      utility_controls: ["usage", "compact", "skills"].map((control) => controlFixture(control as StructuredControlKind, false)),
      risky_controls: ["interrupt", "archive"].map((action) => ({
        action,
        enabled: false,
        requires_confirmation: true,
        disabled_reason: "Session data is unavailable."
      })),
      diagnostics: {
        read_only: true,
        projection_complete: false,
        boundary_visible: false,
        redaction_visible: false,
        incomplete_reason: "Session data is unavailable."
      },
      laptop_resume: {
        available: false,
        command: null,
        unavailable_reason: "Session identity is unavailable."
      },
      error_message: errorMessage
    })
  };
}
