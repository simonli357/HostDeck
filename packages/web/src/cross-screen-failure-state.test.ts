import {
  managedSessionProjectionSchema,
  type SelectedAccessStateResponse,
  type SelectedHostStatusResponse,
  type SelectedSessionDetailResponse,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import type {
  BrowserConnectionFailure,
  BrowserConnectionFailureSource,
  BrowserConnectionResource,
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionTargetData
} from "./connection-state.js";
import {
  formatCrossScreenObservationFacts,
  projectCrossScreenRecoveredFailure,
  projectCrossScreenStaleHostObservation,
  projectCrossScreenStaleObservations
} from "./cross-screen-failure-state.js";

const sessionId = "sess_cross_screen_failure_001" as SessionId;
const observedAt = "2026-07-22T18:00:00.000Z";
const laterObservedAt = "2026-07-22T18:01:00.000Z";
const remoteOrigin = "https://hostdeck-laptop.fixture-tailnet.ts.net";

describe("cross-screen failure-state projection", () => {
  it("reports every stale Mission Control observation with bounded UTC truth", () => {
    const snapshot = missionSnapshot({
      accessState: "stale",
      targetState: "stale"
    });

    const facts = projectCrossScreenStaleObservations(snapshot, "mission_control");

    expect(facts).toEqual([
      {
        label: "Session list",
        observedAt,
        display: "Jul 22, 2026, 18:00 UTC"
      },
      {
        label: "Access",
        observedAt,
        display: "Jul 22, 2026, 18:00 UTC"
      }
    ]);
    expect(formatCrossScreenObservationFacts(facts)).toBe(
      "Session list last confirmed Jul 22, 2026, 18:00 UTC. Access last confirmed Jul 22, 2026, 18:00 UTC."
    );
    expect(Object.isFrozen(facts)).toBe(true);
    expect(facts.every(Object.isFrozen)).toBe(true);
  });

  it("keeps detail, access, and session-projection observation times independent", () => {
    const snapshot = detailSnapshot({
      accessState: "stale",
      targetState: "stale",
      targetObservedAt: laterObservedAt,
      sessionUpdatedAt: "2026-07-22T17:59:00.000-00:00"
    });

    expect(
      formatCrossScreenObservationFacts(
        projectCrossScreenStaleObservations(snapshot, "session_detail")
      )
    ).toBe(
      "Session detail last confirmed Jul 22, 2026, 18:01 UTC. Access last confirmed Jul 22, 2026, 18:00 UTC. Session state last confirmed Jul 22, 2026, 17:59 UTC."
    );
  });

  it("does not invent a time for malformed or missing observations", () => {
    const snapshot = detailSnapshot({
      accessState: "stale",
      accessObservedAt: null,
      targetState: "stale",
      targetObservedAt: "not-a-time",
      sessionUpdatedAt: "also-not-a-time"
    });
    const facts = projectCrossScreenStaleObservations(snapshot, "session_detail");

    expect(facts.map((fact) => fact.observedAt)).toEqual([null, null, null]);
    expect(formatCrossScreenObservationFacts(facts)).toBe(
      "Session detail confirmation time unavailable. Access confirmation time unavailable. Session state confirmation time unavailable."
    );
  });

  it("rejects calendar-invalid RFC 3339 observations instead of normalizing them", () => {
    const snapshot = missionSnapshot({
      targetState: "stale",
      targetObservedAt: "2026-02-30T18:00:00.000Z"
    });

    expect(projectCrossScreenStaleObservations(snapshot, "mission_control")[0]).toEqual({
      label: "Session list",
      observedAt: null,
      display: null
    });
  });

  it("projects stale host time only when retained host data exists", () => {
    const staleHost = projectCrossScreenStaleHostObservation(
      missionSnapshot({ hostState: "stale", host: hostStatusFixture() })
    );

    expect(staleHost).toEqual({
      label: "Host status",
      observedAt,
      display: "Jul 22, 2026, 18:00 UTC"
    });
    expect(projectCrossScreenStaleHostObservation(missionSnapshot())).toBeNull();
    expect(
      projectCrossScreenStaleHostObservation(
        missionSnapshot({ hostState: "failed", host: null })
      )
    ).toBeNull();
  });

  it.each([
    ["access", "Previous access issue recovered", "Access"],
    ["host_status", "Previous host-status issue recovered", "Host status"],
    ["session_list", "Previous session-list issue recovered", "Session list"],
    ["session_detail", "Previous session-detail issue recovered", "Session detail"],
    ["session_stream", "Previous activity-stream issue recovered", "Activity stream"]
  ] as const)(
    "retains a recovered %s failure with source and bounded time",
    (source, title, currentLabel) => {
      const snapshot = recoveredSnapshot(source);

      expect(projectCrossScreenRecoveredFailure(snapshot)).toEqual({
        source,
        title,
        detail: `Issue observed Jul 22, 2026, 18:00 UTC. ${currentLabel} is current again. This prior issue remains visible until the target or access changes.`,
        observedAt
      });
    }
  );

  it.each([
    "access",
    "host_status",
    "session_list",
    "session_detail",
    "session_stream"
  ] as const)("does not relabel a still-failed %s source as recovered", (source) => {
    expect(
      projectCrossScreenRecoveredFailure(stillFailedSnapshot(source))
    ).toBeNull();
  });

  it("requires complete current evidence for a recovered source", () => {
    const access = recoveredSnapshot("access");
    const host = recoveredSnapshot("host_status");
    const stream = recoveredSnapshot("session_stream");

    expect(
      projectCrossScreenRecoveredFailure({
        ...access,
        access: resource<SelectedAccessStateResponse>("current", null, null)
      })
    ).toBeNull();
    expect(
      projectCrossScreenRecoveredFailure({
        ...host,
        host: resource<SelectedHostStatusResponse>("current", null, null)
      })
    ).toBeNull();
    expect(
      projectCrossScreenRecoveredFailure({
        ...stream,
        stream: Object.freeze({ ...stream.stream, snapshot: null })
      })
    ).toBeNull();
  });

  it("rejects future, unrelated, wrong-target, and purged failure history", () => {
    const current = missionSnapshot({
      epoch: 2,
      lastFailure: failure("session_list", 3)
    });
    const unrelatedCsrf = missionSnapshot({
      epoch: 2,
      lastFailure: failure("csrf", 1)
    });
    const unrelatedDeviceList = missionSnapshot({
      epoch: 2,
      lastFailure: failure("device_list", 1)
    });
    const wrongTarget = detailSnapshot({
      epoch: 2,
      lastFailure: failure("session_list", 1)
    });

    expect(projectCrossScreenRecoveredFailure(current)).toBeNull();
    expect(projectCrossScreenRecoveredFailure(unrelatedCsrf)).toBeNull();
    expect(projectCrossScreenRecoveredFailure(unrelatedDeviceList)).toBeNull();
    expect(projectCrossScreenRecoveredFailure(wrongTarget)).toBeNull();
    expect(
      projectCrossScreenRecoveredFailure(
        missionSnapshot({ epoch: 3, lastFailure: null })
      )
    ).toBeNull();
  });

  it("requires a later load epoch while accepting ordered stream recovery in one epoch", () => {
    expect(
      projectCrossScreenRecoveredFailure(
        missionSnapshot({ epoch: 1, lastFailure: failure("session_list", 1) })
      )
    ).toBeNull();
    expect(
      projectCrossScreenRecoveredFailure(
        detailSnapshot({ epoch: 1, lastFailure: failure("session_stream", 1) })
      )
    ).toMatchObject({ source: "session_stream" });
  });

  it("uses unavailable-time truth for retained failures with invalid time", () => {
    const previous = failure("session_list", 1, "private-invalid-time");
    const snapshot = missionSnapshot({ epoch: 2, lastFailure: previous });
    const recovered = projectCrossScreenRecoveredFailure(snapshot);

    expect(recovered?.observedAt).toBeNull();
    expect(recovered?.detail).toBe(
      "Issue time unavailable. Session list is current again. This prior issue remains visible until the target or access changes."
    );
    expect(JSON.stringify(recovered)).not.toContain("private-invalid-time");
    expect(Object.isFrozen(recovered)).toBe(true);
  });
});

function recoveredSnapshot(
  source: Extract<
    BrowserConnectionFailureSource,
    "access" | "host_status" | "session_list" | "session_detail" | "session_stream"
  >
): BrowserConnectionSnapshot {
  const previous = failure(source, 1);
  if (source === "session_detail" || source === "session_stream") {
    return detailSnapshot({ epoch: 2, lastFailure: previous });
  }
  return missionSnapshot({
    epoch: 2,
    host: source === "host_status" ? hostStatusFixture() : null,
    lastFailure: previous
  });
}

function stillFailedSnapshot(
  source: Extract<
    BrowserConnectionFailureSource,
    "access" | "host_status" | "session_list" | "session_detail" | "session_stream"
  >
): BrowserConnectionSnapshot {
  const previous = failure(source, 1);
  if (source === "session_detail") {
    return detailSnapshot({
      epoch: 2,
      lastFailure: previous,
      targetFailure: previous,
      targetState: "failed"
    });
  }
  if (source === "session_stream") {
    const current = detailSnapshot({ epoch: 2, lastFailure: previous });
    return Object.freeze({
      ...current,
      stream: Object.freeze({
        ...current.stream,
        state: "failed" as const,
        failure: previous
      })
    });
  }
  if (source === "session_list") {
    return missionSnapshot({
      epoch: 2,
      lastFailure: previous,
      targetFailure: previous,
      targetState: "failed"
    });
  }
  if (source === "access") {
    return missionSnapshot({
      accessFailure: previous,
      accessState: "failed",
      epoch: 2,
      lastFailure: previous
    });
  }
  return missionSnapshot({
    epoch: 2,
    host: hostStatusFixture(),
    hostFailure: previous,
    hostState: "failed",
    lastFailure: previous
  });
}

function missionSnapshot(
  options: Readonly<{
    accessFailure?: BrowserConnectionFailure | null;
    accessObservedAt?: string | null;
    accessState?: BrowserConnectionResourceState;
    epoch?: number;
    host?: SelectedHostStatusResponse | null;
    hostFailure?: BrowserConnectionFailure | null;
    hostState?: BrowserConnectionResourceState;
    lastFailure?: BrowserConnectionFailure | null;
    targetFailure?: BrowserConnectionFailure | null;
    targetObservedAt?: string | null;
    targetState?: BrowserConnectionResourceState;
  }> = {}
): BrowserConnectionSnapshot {
  const access = pairedAccess();
  const targetData: BrowserConnectionTargetData = Object.freeze({
    kind: "mission_control" as const,
    access: Object.freeze({
      mode: "paired_write" as const,
      network_mode: "remote" as const,
      transport: "https" as const
    }),
    sessions: Object.freeze([]),
    nextCursor: null,
    hasMore: false,
    pageCount: 1
  });
  return Object.freeze({
    epoch: options.epoch ?? 1,
    target: Object.freeze({ kind: "mission_control" as const }),
    phase: "ready" as const,
    access: resource(
      options.accessState ?? "current",
      access,
      options.accessFailure ?? null,
      options.accessObservedAt === undefined ? observedAt : options.accessObservedAt
    ),
    host: resource(
      options.hostState ?? "current",
      options.host ?? null,
      options.hostFailure ?? null
    ),
    targetState: resource(
      options.targetState ?? "current",
      targetData,
      options.targetFailure ?? null,
      options.targetObservedAt === undefined ? observedAt : options.targetObservedAt
    ),
    stream: notApplicableStream(),
    csrf: readyCsrf(),
    writeEligibility: eligibleWrite(),
    lastFailure: options.lastFailure ?? null
  });
}

function detailSnapshot(
  options: Readonly<{
    accessObservedAt?: string | null;
    accessState?: BrowserConnectionResourceState;
    epoch?: number;
    lastFailure?: BrowserConnectionFailure | null;
    sessionUpdatedAt?: string;
    targetFailure?: BrowserConnectionFailure | null;
    targetObservedAt?: string | null;
    targetState?: BrowserConnectionResourceState;
  }> = {}
): BrowserConnectionSnapshot {
  const parsedResponse = selectedSessionDetailResponseSchema.parse({
    access: {
      mode: "paired_write",
      network_mode: "remote",
      transport: "https"
    },
    session: sessionItem()
  });
  const response: SelectedSessionDetailResponse = options.sessionUpdatedAt === undefined
    ? parsedResponse
    : Object.freeze({
        ...parsedResponse,
        session: Object.freeze({
          ...parsedResponse.session,
          session: Object.freeze({
            ...parsedResponse.session.session,
            updated_at: options.sessionUpdatedAt
          })
        })
      }) as SelectedSessionDetailResponse;
  const targetData: BrowserConnectionTargetData = Object.freeze({
    kind: "session_detail" as const,
    response
  });
  return Object.freeze({
    epoch: options.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready" as const,
    access: resource(
      options.accessState ?? "current",
      pairedAccess(),
      null,
      options.accessObservedAt === undefined ? observedAt : options.accessObservedAt
    ),
    host: resource<SelectedHostStatusResponse>("current", null, null),
    targetState: resource(
      options.targetState ?? "current",
      targetData,
      options.targetFailure ?? null,
      options.targetObservedAt === undefined ? observedAt : options.targetObservedAt
    ),
    stream: connectedStream(),
    csrf: readyCsrf(),
    writeEligibility: eligibleWrite(),
    lastFailure: options.lastFailure ?? null
  });
}

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null,
  failureValue: BrowserConnectionFailure | null,
  resourceObservedAt: string | null = observedAt
): BrowserConnectionResource<Data> {
  return Object.freeze({
    state,
    data,
    failure: failureValue,
    observedAt: resourceObservedAt
  });
}

function failure(
  source: BrowserConnectionFailureSource,
  epoch: number,
  failureObservedAt = observedAt
): BrowserConnectionFailure {
  return Object.freeze({
    source,
    reason: "transport_unavailable" as const,
    routeId:
      source === "access"
        ? "access_state"
        : source === "host_status"
          ? "host_status"
          : source === "session_list"
            ? "session_list"
            : source === "session_detail"
              ? "session_detail"
              : source === "session_stream"
                ? "session_event_stream"
                : source === "device_list"
                  ? "device_list"
                  : null,
    transport: "https" as const,
    status: null,
    apiError: null,
    epoch,
    observedAt: failureObservedAt
  });
}

function pairedAccess(): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_cross_screen_phone",
    permission: "write",
    device_expires_at: "2026-10-22T18:00:00.000Z",
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
    can_unlock: false
  });
}

function sessionItem() {
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "cross-screen-session",
    codex_thread_id: "thread-cross-screen-private",
    cwd: "/private/cross-screen-session",
    runtime_source: "codex_app_server",
    runtime_version: "0.147.0",
    created_at: observedAt,
    archived_at: null,
    session_state: "active",
    turn_state: "in_progress",
    attention: "watch",
    freshness: "stale",
    freshness_reason: "Projection is stale.",
    updated_at: observedAt,
    last_activity_at: observedAt,
    branch: "feat/cross-screen",
    model: "gpt-5.5-codex",
    settings: null,
    goal: null,
    recent_summary: "Cross-screen failure-state fixture.",
    last_event_cursor: 1
  });
  return selectedSessionReadItemSchema.parse({
    session,
    event_window: {
      state: "contiguous",
      retained_event_count: 1,
      earliest_retained_cursor: 1,
      boundary_cursor: null
    }
  });
}

function hostStatusFixture(): SelectedHostStatusResponse {
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: "ready",
      readiness: "ready",
      updated_at: observedAt,
      components: selectedHostLocalHealthComponents.map((component) => ({
        component,
        state: "ready",
        checked_at: observedAt,
        causes: []
      })),
      mutation_admission: "open"
    },
    compatibility: {
      state: "supported",
      evidence: "current",
      observed_version: "0.147.0",
      supported_version: "0.147.0",
      capability_state: "verified",
      checked_at: observedAt,
      recorded_at: observedAt
    },
    remote: {
      generation: 1,
      state_generation: 1,
      availability: "ready",
      cause: null,
      external_origin: remoteOrigin,
      laptop_action_required: false,
      observed_at: observedAt,
      checked_at: observedAt,
      updated_at: observedAt
    },
    access: {
      mode: "paired_write",
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: true,
        causes: []
      }
    }
  });
}

function readyCsrf(): BrowserConnectionSnapshot["csrf"] {
  return Object.freeze({
    phase: "ready" as const,
    generation: 1,
    rotatedAt: observedAt,
    failure: null,
    invalidationReason: null
  });
}

function eligibleWrite(): BrowserConnectionSnapshot["writeEligibility"] {
  return Object.freeze({
    scope: "browser_shell" as const,
    eligible: true,
    causes: Object.freeze([])
  });
}

function notApplicableStream(): BrowserConnectionSnapshot["stream"] {
  return Object.freeze({
    state: "not_applicable" as const,
    snapshot: null,
    continuity: "not_applicable" as const,
    boundary: null,
    failure: null
  });
}

function connectedStream(): BrowserConnectionSnapshot["stream"] {
  return Object.freeze({
    state: "connected" as const,
    snapshot: Object.freeze({
      sessionId,
      transport: "https" as const,
      phase: "connected" as const,
      cursor: 1,
      continuity: "contiguous" as const,
      boundary: null,
      retryCount: 0,
      retryAt: null,
      lastHeartbeatAt: null,
      lastEventAt: null,
      failure: null,
      closeReason: null
    }),
    continuity: "contiguous" as const,
    boundary: null,
    failure: null
  });
}
