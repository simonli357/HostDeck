import type {
  LoadedThreadCandidate,
  PendingEnrollmentSnapshot,
  SessionCatalogEvent,
  SharedCodexEndpoint,
  SharedCodexEndpointLocation,
  SharedSessionCatalogEntry,
  SharedSessionEnrollment,
  SharedSessionMembershipRecord,
  TrackedSession
} from "@hostdeck/contracts";
import {
  loadedThreadCandidateSchema,
  pendingEnrollmentSnapshotSchema,
  sessionCatalogBootstrapSchema,
  sharedCodexEndpointLocationSchema,
  sharedCodexEndpointSchema,
  sharedCodexRuntimeVersion,
  sharedSessionCatalogEntrySchema,
  sharedSessionEnrollmentSchema,
  sharedSessionMembershipRecordSchema,
  trackedSessionSchema
} from "@hostdeck/contracts";

export const sharedRuntimeFixtureThreadId = "019f489a-1f9d-7402-ae00-eac6ea322f64";
export const sharedRuntimeFixtureInternalId = "sess_shared_001";
export const sharedRuntimeFixtureTimestamp = "2026-08-14T14:00:00.000Z";
export const sharedRuntimeFixtureUpdatedTimestamp = "2026-08-14T14:01:00.000Z";

export const eligibleLoadedThreadCandidate: LoadedThreadCandidate = loadedThreadCandidateSchema.parse({
  native_thread_id: sharedRuntimeFixtureThreadId,
  root_thread_id: sharedRuntimeFixtureThreadId,
  parent_thread_id: null,
  forked_from_id: null,
  name: "sidecue_deck",
  project_cue: "side_cue_app",
  cwd: "/home/simonli/Videos/apps/side_cue_app",
  source: "cli",
  ephemeral: false,
  archived: false,
  runtime_version: sharedCodexRuntimeVersion,
  created_at: sharedRuntimeFixtureTimestamp,
  updated_at: sharedRuntimeFixtureUpdatedTimestamp,
  status: "idle",
  active_flags: [],
  eligibility: { state: "eligible", reason: null }
});

export const pendingMaterializationEnrollment: PendingEnrollmentSnapshot = pendingEnrollmentSnapshotSchema.parse({
  native_thread_id: sharedRuntimeFixtureThreadId,
  origin: "loaded_before",
  phase: "pending_materialization",
  candidate: eligibleLoadedThreadCandidate,
  first_seen_at: sharedRuntimeFixtureTimestamp,
  last_attempt_at: sharedRuntimeFixtureTimestamp,
  next_retry_at: "2026-08-14T14:00:00.250Z",
  deadline_at: "2026-08-14T14:00:30.000Z",
  attempt_count: 1,
  buffered_notifications: [
    {
      native_thread_id: sharedRuntimeFixtureThreadId,
      ordinal: 1,
      method: "thread/status/changed",
      received_at: "2026-08-14T14:00:00.100Z",
      wire_bytes: 160
    },
    {
      native_thread_id: sharedRuntimeFixtureThreadId,
      ordinal: 2,
      method: "thread/name/updated",
      received_at: "2026-08-14T14:00:00.150Z",
      wire_bytes: 224
    }
  ],
  buffered_bytes: 384,
  boundary_required: false
});

export const sharedCodexEndpointLocationFixture: SharedCodexEndpointLocation = sharedCodexEndpointLocationSchema.parse({
  kind: "standard_unix",
  codex_home: "/home/simonli/.codex",
  socket_path: "/home/simonli/.codex/app-server-control/app-server-control.sock"
});

export const readySharedCodexEndpoint: SharedCodexEndpoint = sharedCodexEndpointSchema.parse({
  kind: "standard_unix",
  state: "ready",
  ownership: "attached",
  generation: 7,
  observed_version: sharedCodexRuntimeVersion,
  reason: null
});

export const trackedSharedSession: TrackedSession = trackedSessionSchema.parse({
  native_thread_id: sharedRuntimeFixtureThreadId,
  internal_session_id: sharedRuntimeFixtureInternalId,
  alias: "sidecue_deck",
  cwd: "/home/simonli/Videos/apps/side_cue_app",
  project_cue: "side_cue_app",
  branch: "main",
  runtime_version: sharedCodexRuntimeVersion,
  runtime_source: "codex_app_server",
  enrollment_origin: "loaded_before",
  archived: false,
  created_at: sharedRuntimeFixtureTimestamp,
  updated_at: sharedRuntimeFixtureUpdatedTimestamp,
  archived_at: null
});

export const sharedSessionCatalogEntryFixture: SharedSessionCatalogEntry = sharedSessionCatalogEntrySchema.parse({
  tracked: trackedSharedSession,
  projection: {
    id: sharedRuntimeFixtureInternalId,
    name: "sidecue_deck",
    codex_thread_id: sharedRuntimeFixtureThreadId,
    cwd: "/home/simonli/Videos/apps/side_cue_app",
    runtime_source: "codex_app_server",
    runtime_version: sharedCodexRuntimeVersion,
    created_at: sharedRuntimeFixtureTimestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "in_progress",
    attention: "watch",
    freshness: "current",
    freshness_reason: null,
    updated_at: sharedRuntimeFixtureUpdatedTimestamp,
    last_activity_at: sharedRuntimeFixtureUpdatedTimestamp,
    branch: "main",
    model: "gpt-5.5-codex",
    settings: null,
    goal: null,
    recent_summary: "Reviewing the SideCue implementation.",
    last_event_cursor: 12
  }
});

export const enrolledSharedSession: SharedSessionEnrollment = sharedSessionEnrollmentSchema.parse({
  state: "enrolled",
  session: trackedSharedSession,
  subscribed: true,
  enrolled_at: sharedRuntimeFixtureUpdatedTimestamp,
  history: {
    turns_loaded: 20,
    events_loaded: 40,
    truncated_before: true,
    boundary_cursor: 1
  },
  boundary_required: false
});

export const automaticSharedSessionMembership: SharedSessionMembershipRecord = sharedSessionMembershipRecordSchema.parse({
  session_id: sharedRuntimeFixtureInternalId,
  native_thread_id: sharedRuntimeFixtureThreadId,
  origin: "automatic",
  enrollment_origin: "loaded_before",
  enrolled_at: sharedRuntimeFixtureUpdatedTimestamp
});

export const historicalAdoptedSessionMembership: SharedSessionMembershipRecord = sharedSessionMembershipRecordSchema.parse({
  session_id: "sess_legacy_001",
  codex_thread_id: "thread_legacy_001",
  origin: "adopted",
  handoff_confirmed_at: sharedRuntimeFixtureTimestamp,
  adopted_at: sharedRuntimeFixtureUpdatedTimestamp
});

export const sharedSessionCatalogBootstrapFixture: readonly SessionCatalogEvent[] = sessionCatalogBootstrapSchema.parse([
  {
    stream_id: "catalog_fixture_001",
    cursor: 40,
    emitted_at: sharedRuntimeFixtureUpdatedTimestamp,
    type: "catalog_reset",
    reason: "initial",
    expected_session_count: 1
  },
  {
    stream_id: "catalog_fixture_001",
    cursor: 41,
    emitted_at: sharedRuntimeFixtureUpdatedTimestamp,
    type: "session_upsert",
    session: sharedSessionCatalogEntryFixture
  },
  {
    stream_id: "catalog_fixture_001",
    cursor: 42,
    emitted_at: sharedRuntimeFixtureUpdatedTimestamp,
    type: "catalog_ready",
    session_count: 1,
    endpoint_generation: readySharedCodexEndpoint.generation
  }
]);

export const sharedRuntimeBoundaryEnrollment: SharedSessionEnrollment = sharedSessionEnrollmentSchema.parse({
  state: "failed",
  native_thread_id: sharedRuntimeFixtureThreadId,
  phase: "pending_materialization",
  failure: "pending_timeout",
  failed_at: "2026-08-14T14:00:30.000Z",
  detail: "Thread did not materialize before the enrollment deadline.",
  boundary_required: true
});
