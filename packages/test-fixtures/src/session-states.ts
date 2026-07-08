import { codexOutputFixtureByCategory } from "./codex-output.js";

export const fixtureTimestamp = "2026-07-08T21:00:00.000Z";

const fixtureCwd = "/home/simonli/Videos/apps/HostDeck";

function sessionFixture(input: {
  readonly id: string;
  readonly name: string;
  readonly category: Parameters<typeof codexOutputFixtureByCategory>[0];
  readonly lifecycle_state?: string;
  readonly branch?: string | null;
  readonly cursor?: number | null;
}) {
  const output = codexOutputFixtureByCategory(input.category);
  const cursor = input.cursor ?? (output.output.length > 0 ? output.output.length : null);

  return {
    id: input.id,
    name: input.name,
    cwd: fixtureCwd,
    backend: {
      type: "tmux",
      tmux: {
        session_name: `hostdeck-${input.name}`,
        pane_id: "%1"
      }
    },
    lifecycle_state: input.lifecycle_state ?? "running",
    status: output.expected.status,
    attention: output.expected.attention,
    created_at: fixtureTimestamp,
    updated_at: fixtureTimestamp,
    last_activity_at: cursor === null ? null : fixtureTimestamp,
    branch: input.branch ?? "main",
    recent_output: {
      text: output.output,
      cursor,
      line_count: output.output.length === 0 ? 0 : output.output.split("\n").length,
      truncated: false
    }
  };
}

export const fakeApiSessions = {
  questionWaiting: sessionFixture({
    id: "sess_fixture_question_01",
    name: "question-waiting",
    category: "question_waiting"
  }),
  approvalWaiting: sessionFixture({
    id: "sess_fixture_approval_01",
    name: "approval-waiting",
    category: "approval_waiting"
  }),
  commandRunning: sessionFixture({
    id: "sess_fixture_running_01",
    name: "command-running",
    category: "command_running"
  }),
  testsPassed: sessionFixture({
    id: "sess_fixture_passed_01",
    name: "tests-passed",
    category: "tests_passed"
  }),
  testsFailed: sessionFixture({
    id: "sess_fixture_failed_01",
    name: "tests-failed",
    category: "tests_failed"
  }),
  compactWarning: sessionFixture({
    id: "sess_fixture_compact_01",
    name: "compact-warning",
    category: "compact_warning"
  }),
  idleNoOutput: sessionFixture({
    id: "sess_fixture_idle_01",
    name: "idle-no-output",
    category: "idle_no_output",
    cursor: null
  }),
  unknownOutput: sessionFixture({
    id: "sess_fixture_unknown_01",
    name: "unknown-output",
    category: "unknown_output"
  }),
  staleSession: sessionFixture({
    id: "sess_fixture_stale_01",
    name: "stale-session",
    category: "unknown_output",
    lifecycle_state: "stale",
    branch: null
  })
} as const;

const healthyHost = {
  version: "0.0.0",
  bind: {
    mode: "localhost",
    host: "127.0.0.1",
    port: 3777
  },
  locked: false,
  lan_enabled: false,
  storage: {
    state: "ok",
    checked_at: fixtureTimestamp
  },
  tmux: {
    state: "ok",
    checked_at: fixtureTimestamp
  },
  stream: {
    state: "ok",
    checked_at: fixtureTimestamp
  },
  startup_checks: [
    {
      name: "state_dir",
      state: "ok"
    },
    {
      name: "tmux",
      state: "ok"
    }
  ],
  stale_session_count: 0,
  last_error: null
} as const;

export const fakeHostStates = {
  healthy: healthyHost,
  locked: {
    ...healthyHost,
    locked: true,
    last_error: {
      code: "host_locked",
      message: "HostDeck is locked.",
      retryable: false
    }
  },
  storageDegraded: {
    ...healthyHost,
    storage: {
      state: "degraded",
      message: "Storage is running with delayed cleanup.",
      checked_at: fixtureTimestamp
    }
  },
  streamDisconnected: {
    ...healthyHost,
    stream: {
      state: "error",
      message: "Output stream reader disconnected.",
      checked_at: fixtureTimestamp
    },
    last_error: {
      code: "daemon_unavailable",
      message: "Stream reader is unavailable.",
      retryable: true
    }
  }
} as const;

const securityTrusted = {
  trusted: true,
  read_only: false,
  locked: false,
  lan_enabled: false,
  client_id: "fixture-phone"
} as const;

const networkLocalhost = {
  mode: "localhost",
  host: "127.0.0.1",
  port: 3777,
  lan_enabled: false
} as const;

const enabledPromptControl = {
  action: "prompt",
  enabled: true,
  disabled_reason: null,
  requires_confirmation: false,
  advanced_required: false
} as const;

const slashControl = {
  action: "slash",
  enabled: true,
  disabled_reason: null,
  requires_confirmation: false,
  advanced_required: false
} as const;

const stopControl = {
  action: "stop",
  enabled: true,
  disabled_reason: null,
  requires_confirmation: true,
  advanced_required: false
} as const;

const rawInputDisabledControl = {
  action: "raw_input",
  enabled: false,
  disabled_reason: "raw_input_confirmation_required",
  requires_confirmation: true,
  advanced_required: true
} as const;

const unknownSessionWriteDisabled = {
  action: "prompt",
  enabled: false,
  disabled_reason: "unknown",
  requires_confirmation: false,
  advanced_required: false
} as const;

export const fakeMissionControlViewModels = {
  mixedAttention: {
    screen: "mission_control",
    state: "ready",
    host_safety: {
      host: fakeHostStates.healthy,
      security: securityTrusted,
      network: networkLocalhost,
      remote_unlock_available: false,
      dashboard_lan_mutation_available: false
    },
    trust: {
      state: "trusted_write",
      trusted: true,
      read_only: false,
      locked: false,
      lan_enabled: false,
      client_id: "fixture-phone",
      write_controls_enabled: true,
      message: null
    },
    sessions: [
      sessionCardFixture(fakeApiSessions.testsFailed, enabledPromptControl),
      sessionCardFixture(fakeApiSessions.approvalWaiting, enabledPromptControl),
      sessionCardFixture(fakeApiSessions.questionWaiting, enabledPromptControl),
      sessionCardFixture(fakeApiSessions.unknownOutput, unknownSessionWriteDisabled)
    ],
    attention_sorted: true,
    error_message: null
  },
  empty: {
    screen: "mission_control",
    state: "empty",
    host_safety: {
      host: fakeHostStates.healthy,
      security: securityTrusted,
      network: networkLocalhost,
      remote_unlock_available: false,
      dashboard_lan_mutation_available: false
    },
    trust: {
      state: "trusted_write",
      trusted: true,
      read_only: false,
      locked: false,
      lan_enabled: false,
      client_id: "fixture-phone",
      write_controls_enabled: true,
      message: null
    },
    sessions: [],
    attention_sorted: true,
    error_message: null
  },
  disconnected: {
    screen: "mission_control",
    state: "disconnected",
    host_safety: {
      host: fakeHostStates.streamDisconnected,
      security: securityTrusted,
      network: networkLocalhost,
      remote_unlock_available: false,
      dashboard_lan_mutation_available: false
    },
    trust: {
      state: "trusted_write",
      trusted: true,
      read_only: false,
      locked: false,
      lan_enabled: false,
      client_id: "fixture-phone",
      write_controls_enabled: true,
      message: null
    },
    sessions: [sessionCardFixture(fakeApiSessions.unknownOutput, unknownSessionWriteDisabled)],
    attention_sorted: true,
    error_message: "Stream reader is unavailable."
  }
} as const;

export const fakeSessionDetailViewModels = {
  waitingForUser: sessionDetailFixture(fakeApiSessions.questionWaiting, enabledPromptControl),
  outputBoundary: {
    ...sessionDetailFixture(fakeApiSessions.testsPassed, enabledPromptControl),
    boundary: {
      type: "replay_boundary",
      session_id: fakeApiSessions.testsPassed.id,
      after: 1,
      next_cursor: fakeApiSessions.testsPassed.recent_output.cursor,
      visible: true,
      message: "Older retained output is no longer available."
    },
    output: {
      session_id: fakeApiSessions.testsPassed.id,
      events: [
        {
          type: "replay_boundary",
          session_id: fakeApiSessions.testsPassed.id,
          after: 1,
          next_cursor: fakeApiSessions.testsPassed.recent_output.cursor,
          reason: "retention"
        }
      ],
      next_cursor: fakeApiSessions.testsPassed.recent_output.cursor,
      truncated: true
    }
  },
  unknownDisabledWrite: sessionDetailFixture(fakeApiSessions.unknownOutput, unknownSessionWriteDisabled)
} as const;

function sessionCardFixture(session: (typeof fakeApiSessions)[keyof typeof fakeApiSessions], writeControl: typeof enabledPromptControl | typeof unknownSessionWriteDisabled) {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    project_label: "HostDeck",
    branch: session.branch,
    lifecycle_state: session.lifecycle_state,
    status: session.status,
    attention: session.attention,
    last_activity_at: session.last_activity_at,
    recent_output: {
      text: session.recent_output.text.slice(0, 280),
      cursor: session.recent_output.cursor,
      truncated: session.recent_output.truncated
    },
    write_control: writeControl
  };
}

function sessionDetailFixture(session: (typeof fakeApiSessions)[keyof typeof fakeApiSessions], promptControl: typeof enabledPromptControl | typeof unknownSessionWriteDisabled) {
  return {
    screen: "session_detail",
    session,
    output: {
      session_id: session.id,
      events:
        session.recent_output.cursor === null
          ? []
          : [
              {
                type: "output",
                session_id: session.id,
                cursor: session.recent_output.cursor,
                captured_at: fixtureTimestamp,
                text: session.recent_output.text
              }
            ],
      next_cursor: session.recent_output.cursor ?? 0,
      truncated: false
    },
    boundary: {
      type: "none",
      session_id: session.id,
      after: null,
      next_cursor: null,
      visible: false,
      message: null
    },
    stream_state: "connected",
    prompt_control: promptControl,
    slash_controls: [
      {
        command: "/model",
        control: slashControl
      },
      {
        command: "/goal",
        control: slashControl
      },
      {
        command: "/plan",
        control: slashControl
      }
    ],
    stop_control: stopControl,
    raw_input_control: rawInputDisabledControl,
    advanced_raw_visible: false,
    error_message: null
  };
}
