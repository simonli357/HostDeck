import type { ApiSession, UiMissionControlViewModel, UiSessionDetailViewModel } from "@hostdeck/contracts";
import { apiSessionSchema, hostStatusResponseSchema, networkStateResponseSchema, securityStateResponseSchema, sessionOutputResponseSchema } from "@hostdeck/contracts";
import {
  createMissionControlViewModel,
  createSessionDetailViewModel,
  createSessionOutputResponse,
  type MissionControlOptions,
  type SessionDetailOptions
} from "@hostdeck/web";
import { fakeApiSessions, fakeHostStates, fixtureTimestamp } from "./session-states.js";

export const requiredDashboardStateFixtureIds = [
  "mission_control_empty",
  "mission_control_loading",
  "mission_control_all_idle",
  "mission_control_mixed_attention",
  "mission_control_disconnected",
  "mission_control_permission_denied",
  "mission_control_agent_error",
  "mission_control_lan_disabled",
  "mission_control_locked",
  "session_detail_running",
  "session_detail_waiting_for_user",
  "session_detail_waiting_for_approval",
  "session_detail_failed",
  "session_detail_unknown",
  "session_detail_stale",
  "session_detail_stopped",
  "session_detail_output_boundary",
  "session_detail_stream_reconnecting"
] as const;

export type DashboardStateFixtureId = (typeof requiredDashboardStateFixtureIds)[number];

export type DashboardStateFixture =
  | {
      readonly id: DashboardStateFixtureId;
      readonly surface: "mission_control";
      readonly viewModel: UiMissionControlViewModel;
    }
  | {
      readonly id: DashboardStateFixtureId;
      readonly surface: "session_detail";
      readonly viewModel: UiSessionDetailViewModel;
    };

const trustedWrite = securityStateResponseSchema.parse({
  trusted: true,
  read_only: false,
  locked: false,
  lan_enabled: false,
  client_id: "fixture-phone",
  auth_transport: "http_only_cookie",
  csrf_token: "csrf_token_for_dashboard_fixtures_123456"
});

const unpaired = securityStateResponseSchema.parse({
  trusted: false,
  read_only: false,
  locked: false,
  lan_enabled: false,
  client_id: null,
  auth_transport: "none",
  csrf_token: null
});

const lockedSecurity = securityStateResponseSchema.parse({
  ...trustedWrite,
  locked: true,
  csrf_token: null
});

const localhostNetwork = networkStateResponseSchema.parse({
  mode: "localhost",
  host: "127.0.0.1",
  port: 3777,
  lan_enabled: false
});

const lanNetwork = networkStateResponseSchema.parse({
  mode: "lan",
  host: "0.0.0.0",
  port: 3777,
  lan_enabled: true
});

const healthyHost = hostStatusResponseSchema.parse(fakeHostStates.healthy);
const lockedHost = hostStatusResponseSchema.parse(fakeHostStates.locked);
const storageDegradedHost = hostStatusResponseSchema.parse(fakeHostStates.storageDegraded);
const streamDisconnectedHost = hostStatusResponseSchema.parse(fakeHostStates.streamDisconnected);

const idleSession = sessionVariant(fakeApiSessions.idleNoOutput, {
  id: "sess_dash_idle_001",
  name: "idle",
  status: "idle",
  attention: "none",
  recent_output: {
    text: "",
    cursor: null,
    line_count: 0,
    truncated: false
  },
  last_activity_at: null
});

const runningSession = sessionVariant(fakeApiSessions.commandRunning, {
  id: "sess_dash_run_0001",
  name: "running",
  status: "running",
  attention: "watch"
});

const stoppedSession = sessionVariant(fakeApiSessions.questionWaiting, {
  id: "sess_dash_stop_001",
  name: "stopped",
  lifecycle_state: "stopped",
  status: "idle",
  attention: "none"
});

const outputBoundarySession = sessionVariant(fakeApiSessions.testsPassed, {
  id: "sess_dash_boundary",
  name: "output-boundary",
  recent_output: {
    text: fakeApiSessions.testsPassed.recent_output.text,
    cursor: 7,
    line_count: fakeApiSessions.testsPassed.recent_output.line_count,
    truncated: true
  }
});

export const fakeDashboardStateFixtures: readonly DashboardStateFixture[] = [
  missionFixture("mission_control_empty", [], {
    state: "empty"
  }),
  missionFixture("mission_control_loading", [], {
    state: "loading"
  }),
  missionFixture("mission_control_all_idle", [idleSession, fakeApiSessions.testsPassed]),
  missionFixture("mission_control_mixed_attention", [
    fakeApiSessions.testsFailed,
    fakeApiSessions.approvalWaiting,
    fakeApiSessions.questionWaiting,
    fakeApiSessions.unknownOutput,
    fakeApiSessions.testsPassed
  ]),
  missionFixture("mission_control_disconnected", [fakeApiSessions.unknownOutput], {
    host: streamDisconnectedHost,
    state: "disconnected",
    errorMessage: "Output stream reader is unavailable."
  }),
  missionFixture("mission_control_permission_denied", [fakeApiSessions.questionWaiting], {
    security: unpaired,
    state: "permission_denied",
    errorMessage: "This browser can read allowed state but cannot write.",
    trust: {
      untrustedState: "permission_denied",
      message: "This browser can read allowed state but cannot write."
    }
  }),
  missionFixture("mission_control_agent_error", [fakeApiSessions.unknownOutput], {
    host: storageDegradedHost,
    state: "agent_error",
    errorMessage: "Storage is degraded."
  }),
  missionFixture("mission_control_lan_disabled", [fakeApiSessions.questionWaiting], {
    network: localhostNetwork
  }),
  missionFixture("mission_control_locked", [fakeApiSessions.questionWaiting], {
    host: lockedHost,
    security: lockedSecurity
  }),
  detailFixture("session_detail_running", runningSession),
  detailFixture("session_detail_waiting_for_user", fakeApiSessions.questionWaiting),
  detailFixture("session_detail_waiting_for_approval", fakeApiSessions.approvalWaiting),
  detailFixture("session_detail_failed", fakeApiSessions.testsFailed),
  detailFixture("session_detail_unknown", fakeApiSessions.unknownOutput),
  detailFixture("session_detail_stale", fakeApiSessions.staleSession),
  detailFixture("session_detail_stopped", stoppedSession),
  detailFixture("session_detail_output_boundary", outputBoundarySession, {
    output: sessionOutputResponseSchema.parse({
      ...createSessionOutputResponse(outputBoundarySession),
      events: [
        {
          type: "replay_boundary",
          session_id: outputBoundarySession.id,
          after: 1,
          next_cursor: 7,
          reason: "retention"
        }
      ],
      next_cursor: 7,
      truncated: true
    })
  }),
  detailFixture("session_detail_stream_reconnecting", fakeApiSessions.commandRunning, {
    streamState: "reconnecting",
    errorMessage: "Reconnecting to session output."
  })
];

export function dashboardFixtureById(id: DashboardStateFixtureId): DashboardStateFixture {
  const fixture = fakeDashboardStateFixtures.find((candidate) => candidate.id === id);

  if (fixture === undefined) {
    throw new TypeError(`Missing dashboard state fixture: ${id}`);
  }

  return fixture;
}

function missionFixture(
  id: DashboardStateFixtureId,
  sessions: readonly unknown[],
  options: {
    readonly host?: Parameters<typeof createMissionControlViewModel>[0]["host"];
    readonly security?: Parameters<typeof createMissionControlViewModel>[0]["security"];
    readonly network?: Parameters<typeof createMissionControlViewModel>[0]["network"];
    readonly state?: MissionControlOptions["state"];
    readonly errorMessage?: string;
    readonly trust?: MissionControlOptions["trust"];
  } = {}
): DashboardStateFixture {
  return {
    id,
    surface: "mission_control",
    viewModel: createMissionControlViewModel({
      host: options.host ?? healthyHost,
      security: options.security ?? trustedWrite,
      network: options.network ?? (trustedWrite.lan_enabled ? lanNetwork : localhostNetwork),
      sessions: sessions.map(parseSession),
      options: {
        ...(options.state !== undefined ? { state: options.state } : {}),
        ...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
        ...(options.trust !== undefined ? { trust: options.trust } : {})
      }
    })
  };
}

function detailFixture(
  id: DashboardStateFixtureId,
  session: unknown,
  options: SessionDetailOptions = {}
): DashboardStateFixture {
  const parsedSession = parseSession(session);

  return {
    id,
    surface: "session_detail",
    viewModel: createSessionDetailViewModel({
      session: parsedSession,
      security: trustedWrite,
      options
    })
  };
}

function sessionVariant(session: unknown, overrides: Partial<Record<keyof ApiSession, unknown>>): ApiSession {
  const parsedSession = parseSession(session);

  return apiSessionSchema.parse({
    ...parsedSession,
    ...overrides,
    updated_at: fixtureTimestamp
  });
}

function parseSession(session: unknown): ApiSession {
  return apiSessionSchema.parse(session);
}
