import { describe, expect, it } from "vitest";
import {
  automaticSessionMembershipRecordSchema,
  loadedThreadCandidateSchema,
  nativeCodexThreadIdSchema,
  pendingEnrollmentRegistrySchema,
  pendingEnrollmentSnapshotSchema,
  privacySafeRuntimeDiagnosticSchema,
  sessionCatalogBootstrapSchema,
  sessionCatalogEventSchema,
  sharedCodexEndpointLocationSchema,
  sharedCodexEndpointSchema,
  sharedCodexRuntimeContractLimits,
  sharedCodexRuntimeVersion,
  sharedEnrollmentHistorySchema,
  sharedSessionCatalogEntrySchema,
  sharedSessionEnrollmentSchema,
  sharedSessionMembershipRecordSchema,
  sharedSessionTargetIdSchema,
  sharedSessionTargetSchema,
  trackedSessionSchema
} from "./shared-codex-runtime.js";

const nativeThreadId = "019f489a-1f9d-7402-ae00-eac6ea322f64";
const secondNativeThreadId = "019f489a-1f9d-7402-be00-eac6ea322f65";
const createdAt = "2026-08-14T14:00:00.000Z";
const updatedAt = "2026-08-14T14:01:00.000Z";

describe("shared Codex identity contracts", () => {
  it("requires canonical native UUIDv7 ids while retaining explicit internal ids", () => {
    expect(nativeCodexThreadIdSchema.parse(nativeThreadId)).toBe(nativeThreadId);
    expect(nativeCodexThreadIdSchema.safeParse("thread_legacy_001").success).toBe(false);
    expect(nativeCodexThreadIdSchema.safeParse("019f489a-1f9d-6402-ae00-eac6ea322f64").success).toBe(false);
    expect(sharedSessionTargetIdSchema.parse(nativeThreadId)).toBe(nativeThreadId);
    expect(sharedSessionTargetIdSchema.parse("sess_shared_001")).toBe("sess_shared_001");
  });

  it("accepts exactly one typed target and rejects ambiguous target objects", () => {
    expect(
      sharedSessionTargetSchema.parse({ type: "native_codex_thread", native_thread_id: nativeThreadId })
    ).toMatchObject({ type: "native_codex_thread" });
    expect(
      sharedSessionTargetSchema.safeParse({
        type: "native_codex_thread",
        native_thread_id: nativeThreadId,
        internal_session_id: "sess_shared_001"
      }).success
    ).toBe(false);
  });

  it("keeps tracked identity immutable, chronological, and archive-consistent", () => {
    expect(trackedSessionSchema.parse(trackedSession())).toMatchObject({
      native_thread_id: nativeThreadId,
      internal_session_id: "sess_shared_001",
      archived: false
    });
    expect(trackedSessionSchema.safeParse({ ...trackedSession(), updated_at: "2026-08-14T13:59:59.000Z" }).success).toBe(
      false
    );
    expect(trackedSessionSchema.safeParse({ ...trackedSession(), archived: true, archived_at: null }).success).toBe(false);
  });
});

describe("shared Codex endpoint contracts", () => {
  it("accepts only the standard normalized socket below CODEX_HOME", () => {
    const location = {
      kind: "standard_unix",
      codex_home: "/home/simonli/.codex",
      socket_path: "/home/simonli/.codex/app-server-control/app-server-control.sock"
    };
    expect(sharedCodexEndpointLocationSchema.parse(location)).toEqual(location);
    expect(
      sharedCodexEndpointLocationSchema.safeParse({ ...location, socket_path: "/tmp/codex.sock" }).success
    ).toBe(false);
    expect(
      sharedCodexEndpointLocationSchema.safeParse({ ...location, codex_home: "/home/simonli/../private" }).success
    ).toBe(false);
  });

  it("projects ownership and compatibility without exposing a path", () => {
    const ready = {
      kind: "standard_unix",
      state: "ready",
      ownership: "attached",
      generation: 7,
      observed_version: sharedCodexRuntimeVersion,
      reason: null
    };
    expect(sharedCodexEndpointSchema.parse(ready)).toEqual(ready);
    expect(sharedCodexEndpointSchema.safeParse({ ...ready, socket_path: "/home/simonli/.codex/private.sock" }).success).toBe(
      false
    );
    expect(sharedCodexEndpointSchema.safeParse({ ...ready, observed_version: "0.146.0" }).success).toBe(false);
    expect(sharedCodexEndpointSchema.safeParse({ ...ready, ownership: "none" }).success).toBe(false);
    expect(
      sharedCodexEndpointSchema.safeParse({
        ...ready,
        state: "starting",
        ownership: "owned",
        observed_version: sharedCodexRuntimeVersion
      }).success
    ).toBe(false);
  });

  it("rejects path-bearing and credential-bearing public diagnostics", () => {
    for (const unsafe of [
      "Socket failed at /home/simonli/.codex/runtime.sock.",
      "Socket failed at C:\\Users\\Simon\\runtime.sock.",
      "OPENAI_API_KEY=secret",
      "Bearer abcdef",
      "token=abcdef",
      "line one\nline two"
    ]) {
      expect(privacySafeRuntimeDiagnosticSchema.safeParse(unsafe).success, unsafe).toBe(false);
    }
    expect(privacySafeRuntimeDiagnosticSchema.parse("Compatible shared Codex runtime is unavailable.")).toBe(
      "Compatible shared Codex runtime is unavailable."
    );
  });
});

describe("loaded-thread enrollment contracts", () => {
  it("accepts an exact eligible root and omits transcript and rollout paths", () => {
    expect(loadedThreadCandidateSchema.parse(eligibleCandidate())).toMatchObject({
      native_thread_id: nativeThreadId,
      source: "cli",
      eligibility: { state: "eligible", reason: null }
    });
    expect(loadedThreadCandidateSchema.safeParse({ ...eligibleCandidate(), turns: [] }).success).toBe(false);
    expect(loadedThreadCandidateSchema.safeParse({ ...eligibleCandidate(), path: "/private/rollout.jsonl" }).success).toBe(false);
  });

  it("requires the one deterministic rejection reason for ineligible metadata", () => {
    expect(
      loadedThreadCandidateSchema.parse({
        ...eligibleCandidate(),
        source: "exec",
        eligibility: { state: "ineligible", reason: "non_interactive_source" }
      })
    ).toMatchObject({ eligibility: { reason: "non_interactive_source" } });
    expect(
      loadedThreadCandidateSchema.safeParse({
        ...eligibleCandidate(),
        source: "exec",
        eligibility: { state: "ineligible", reason: "ephemeral" }
      }).success
    ).toBe(false);
    expect(
      loadedThreadCandidateSchema.safeParse({
        ...eligibleCandidate(),
        cwd: "relative/project",
        eligibility: { state: "eligible", reason: null }
      }).success
    ).toBe(false);
  });

  it("rejects contradictory ancestry, status flags, and timestamps", () => {
    expect(
      loadedThreadCandidateSchema.safeParse({
        ...eligibleCandidate(),
        parent_thread_id: secondNativeThreadId,
        eligibility: { state: "ineligible", reason: "child_or_subagent" }
      }).success
    ).toBe(false);
    expect(
      loadedThreadCandidateSchema.safeParse({ ...eligibleCandidate(), status: "idle", active_flags: ["waiting_on_approval"] })
        .success
    ).toBe(false);
    expect(
      loadedThreadCandidateSchema.safeParse({
        ...eligibleCandidate(),
        updated_at: "2026-08-14T13:59:59.000Z",
        eligibility: { state: "ineligible", reason: "contradictory_metadata" }
      }).success
    ).toBe(true);
  });

  it("represents no-rollout startup as bounded pending materialization", () => {
    expect(pendingEnrollmentSnapshotSchema.parse(pendingEnrollment())).toMatchObject({
      phase: "pending_materialization",
      buffered_bytes: 384,
      boundary_required: false
    });
    expect(
      pendingEnrollmentSnapshotSchema.safeParse({ ...pendingEnrollment(), phase: "pending_materialization", candidate: null })
        .success
    ).toBe(false);
    expect(pendingEnrollmentSnapshotSchema.safeParse({ ...pendingEnrollment(), buffered_bytes: 383 }).success).toBe(false);
    expect(
      pendingEnrollmentSnapshotSchema.safeParse({
        ...pendingEnrollment(),
        deadline_at: "2026-08-14T14:02:00.001Z"
      }).success
    ).toBe(false);
  });

  it("rejects cross-thread, reordered, and oversized pending buffers", () => {
    const pending = pendingEnrollment();
    expect(
      pendingEnrollmentSnapshotSchema.safeParse({
        ...pending,
        buffered_notifications: [
          pending.buffered_notifications[0],
          { ...pending.buffered_notifications[1], native_thread_id: secondNativeThreadId }
        ]
      }).success
    ).toBe(false);
    expect(
      pendingEnrollmentSnapshotSchema.safeParse({
        ...pending,
        buffered_notifications: [pending.buffered_notifications[0], { ...pending.buffered_notifications[1], ordinal: 1 }]
      }).success
    ).toBe(false);

    const oversized = Array.from({ length: sharedCodexRuntimeContractLimits.pendingEventsPerThread + 1 }, (_, index) => ({
      ...pending.buffered_notifications[0],
      ordinal: index + 1,
      wire_bytes: 1
    }));
    expect(
      pendingEnrollmentSnapshotSchema.safeParse({ ...pending, buffered_notifications: oversized, buffered_bytes: oversized.length })
        .success
    ).toBe(false);
    expect(pendingEnrollmentRegistrySchema.safeParse([pending, pending]).success).toBe(false);
  });

  it("requires explicit boundary truth for terminal enrollment uncertainty", () => {
    const failed = {
      state: "failed",
      native_thread_id: nativeThreadId,
      phase: "pending_materialization",
      failure: "pending_timeout",
      failed_at: "2026-08-14T14:00:30.000Z",
      detail: "Thread did not materialize before the enrollment deadline.",
      boundary_required: true
    };
    expect(sharedSessionEnrollmentSchema.parse(failed)).toEqual(failed);
    expect(sharedSessionEnrollmentSchema.safeParse({ ...failed, boundary_required: false }).success).toBe(false);
    expect(
      sharedEnrollmentHistorySchema.safeParse({
        turns_loaded: 20,
        events_loaded: 40,
        truncated_before: true,
        boundary_cursor: null
      }).success
    ).toBe(false);
  });
});

describe("shared membership and catalog contracts", () => {
  it("accepts automatic membership while preserving historical adopted records", () => {
    expect(
      automaticSessionMembershipRecordSchema.parse({
        session_id: "sess_shared_001",
        native_thread_id: nativeThreadId,
        origin: "automatic",
        enrollment_origin: "loaded_before",
        enrolled_at: updatedAt
      })
    ).toMatchObject({ origin: "automatic" });
    expect(
      sharedSessionMembershipRecordSchema.parse({
        session_id: "sess_legacy_001",
        codex_thread_id: "thread_legacy_001",
        origin: "adopted",
        handoff_confirmed_at: createdAt,
        adopted_at: updatedAt
      })
    ).toMatchObject({ origin: "adopted", codex_thread_id: "thread_legacy_001" });
  });

  it("binds one strict native identity to one exact public projection", () => {
    expect(sharedSessionCatalogEntrySchema.parse(catalogEntry())).toMatchObject({
      tracked: { native_thread_id: nativeThreadId, internal_session_id: "sess_shared_001" }
    });
    expect(
      sharedSessionCatalogEntrySchema.safeParse({
        ...catalogEntry(),
        projection: { ...catalogEntry().projection, codex_thread_id: secondNativeThreadId }
      }).success
    ).toBe(false);
  });

  it("requires reset, unique contiguous upserts, and ready count agreement", () => {
    const bootstrap = catalogBootstrap();
    expect(sessionCatalogBootstrapSchema.parse(bootstrap)).toHaveLength(3);
    expect(
      sessionCatalogBootstrapSchema.safeParse([
        bootstrap[0],
        { ...bootstrap[1], cursor: 43 },
        { ...bootstrap[2], cursor: 44 }
      ]).success
    ).toBe(false);
    expect(
      sessionCatalogBootstrapSchema.safeParse([
        { ...bootstrap[0], expected_session_count: 2 },
        bootstrap[1],
        bootstrap[2]
      ]).success
    ).toBe(false);
  });

  it("makes catalog loss an explicit reset boundary with privacy-safe detail", () => {
    const boundary = {
      stream_id: "catalog_fixture_001",
      cursor: 43,
      emitted_at: updatedAt,
      type: "catalog_boundary",
      reason: "lag",
      reset_required: true,
      detail: "Catalog receiver lagged; a fresh reset is required."
    };
    expect(sessionCatalogEventSchema.parse(boundary)).toEqual(boundary);
    expect(
      sessionCatalogEventSchema.safeParse({ ...boundary, detail: "Receiver failed at /home/simonli/.codex/socket." }).success
    ).toBe(false);
    expect(sessionCatalogEventSchema.safeParse({ ...boundary, reset_required: false }).success).toBe(false);
  });
});

function eligibleCandidate() {
  return {
    native_thread_id: nativeThreadId,
    root_thread_id: nativeThreadId,
    parent_thread_id: null,
    forked_from_id: null,
    name: "sidecue_deck",
    project_cue: "side_cue_app",
    cwd: "/home/simonli/Videos/apps/side_cue_app",
    source: "cli",
    ephemeral: false,
    archived: false,
    runtime_version: sharedCodexRuntimeVersion,
    created_at: createdAt,
    updated_at: updatedAt,
    status: "idle",
    active_flags: [],
    eligibility: { state: "eligible", reason: null }
  } as const;
}

function pendingEnrollment() {
  return {
    native_thread_id: nativeThreadId,
    origin: "loaded_before",
    phase: "pending_materialization",
    candidate: eligibleCandidate(),
    first_seen_at: createdAt,
    last_attempt_at: createdAt,
    next_retry_at: "2026-08-14T14:00:00.250Z",
    deadline_at: "2026-08-14T14:00:30.000Z",
    attempt_count: 1,
    buffered_notifications: [
      {
        native_thread_id: nativeThreadId,
        ordinal: 1,
        method: "thread/status/changed",
        received_at: "2026-08-14T14:00:00.100Z",
        wire_bytes: 160
      },
      {
        native_thread_id: nativeThreadId,
        ordinal: 2,
        method: "thread/name/updated",
        received_at: "2026-08-14T14:00:00.150Z",
        wire_bytes: 224
      }
    ],
    buffered_bytes: 384,
    boundary_required: false
  } as const;
}

function trackedSession() {
  return {
    native_thread_id: nativeThreadId,
    internal_session_id: "sess_shared_001",
    alias: "sidecue_deck",
    cwd: "/home/simonli/Videos/apps/side_cue_app",
    project_cue: "side_cue_app",
    branch: "main",
    runtime_version: sharedCodexRuntimeVersion,
    runtime_source: "codex_app_server",
    enrollment_origin: "loaded_before",
    archived: false,
    created_at: createdAt,
    updated_at: updatedAt,
    archived_at: null
  } as const;
}

function catalogEntry() {
  return {
    tracked: trackedSession(),
    projection: {
      id: "sess_shared_001",
      name: "sidecue_deck",
      codex_thread_id: nativeThreadId,
      cwd: "/home/simonli/Videos/apps/side_cue_app",
      runtime_source: "codex_app_server",
      runtime_version: sharedCodexRuntimeVersion,
      created_at: createdAt,
      archived_at: null,
      session_state: "active",
      turn_state: "in_progress",
      attention: "watch",
      freshness: "current",
      freshness_reason: null,
      updated_at: updatedAt,
      last_activity_at: updatedAt,
      branch: "main",
      model: "gpt-5.5-codex",
      settings: null,
      goal: null,
      recent_summary: "Reviewing the SideCue implementation.",
      last_event_cursor: 12
    }
  } as const;
}

function catalogBootstrap() {
  return [
    {
      stream_id: "catalog_fixture_001",
      cursor: 40,
      emitted_at: updatedAt,
      type: "catalog_reset",
      reason: "initial",
      expected_session_count: 1
    },
    {
      stream_id: "catalog_fixture_001",
      cursor: 41,
      emitted_at: updatedAt,
      type: "session_upsert",
      session: catalogEntry()
    },
    {
      stream_id: "catalog_fixture_001",
      cursor: 42,
      emitted_at: updatedAt,
      type: "catalog_ready",
      session_count: 1,
      endpoint_generation: 7
    }
  ] as const;
}
