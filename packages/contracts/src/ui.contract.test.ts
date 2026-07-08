import { describe, expect, it } from "vitest";
import {
  uiHostSafetyViewModelSchema,
  uiMissionControlViewModelSchema,
  uiOutputBoundarySchema,
  uiSessionCardSchema,
  uiSessionDetailViewModelSchema,
  uiTrustStateViewModelSchema,
  uiWriteControlStateSchema
} from "./ui.js";

const sessionId = "sess_ui_contract_01";
const timestamp = "2026-07-08T20:00:00.000Z";

const sessionFixture = {
  id: sessionId,
  name: "ui-demo",
  cwd: "/home/simonli/HostDeck",
  backend: {
    type: "tmux",
    tmux: {
      session_name: "hostdeck-ui-demo",
      pane_id: "%1"
    }
  },
  lifecycle_state: "running",
  status: "waiting_for_user",
  attention: "needs_input",
  created_at: timestamp,
  updated_at: timestamp,
  last_activity_at: timestamp,
  branch: "main",
  recent_output: {
    text: "Need a decision.",
    cursor: 7,
    line_count: 1,
    truncated: false
  }
};

const hostStatusFixture = {
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
    checked_at: timestamp
  },
  tmux: {
    state: "ok"
  },
  stream: {
    state: "ok"
  },
  startup_checks: [
    {
      name: "state_dir",
      state: "ok"
    }
  ],
  stale_session_count: 0,
  last_error: null
};

const securityFixture = {
  trusted: true,
  read_only: false,
  locked: false,
  lan_enabled: false,
  client_id: "phone",
  auth_transport: "http_only_cookie",
  csrf_token: "csrf_token_for_phone_writes_123456"
};

const networkFixture = {
  mode: "localhost",
  host: "127.0.0.1",
  port: 3777,
  lan_enabled: false
};

const enabledPromptControl = {
  action: "prompt",
  enabled: true,
  disabled_reason: null,
  requires_confirmation: false,
  advanced_required: false
};

const disabledPromptControl = {
  action: "prompt",
  enabled: false,
  disabled_reason: "locked",
  requires_confirmation: false,
  advanced_required: false
};

const slashControl = {
  action: "slash",
  enabled: true,
  disabled_reason: null,
  requires_confirmation: false,
  advanced_required: false
};

const stopControl = {
  action: "stop",
  enabled: true,
  disabled_reason: null,
  requires_confirmation: true,
  advanced_required: false
};

const rawInputDisabledControl = {
  action: "raw_input",
  enabled: false,
  disabled_reason: "raw_input_confirmation_required",
  requires_confirmation: true,
  advanced_required: true
};

const visibleBoundary = {
  type: "replay_boundary",
  session_id: sessionId,
  after: 1,
  next_cursor: 7,
  visible: true,
  message: "Older output was truncated."
};

const noBoundary = {
  type: "none",
  session_id: sessionId,
  after: null,
  next_cursor: null,
  visible: false,
  message: null
};

const sessionCard = {
  id: sessionId,
  name: "ui-demo",
  cwd: "/home/simonli/HostDeck",
  project_label: "HostDeck",
  branch: "main",
  lifecycle_state: "running",
  status: "waiting_for_user",
  attention: "needs_input",
  last_activity_at: timestamp,
  recent_output: {
    text: "Need a decision.",
    cursor: 7,
    truncated: false
  },
  write_control: enabledPromptControl
};

describe("UI write control and boundary schemas", () => {
  it("validates disabled write states and visible output boundaries", () => {
    expect(uiWriteControlStateSchema.parse(disabledPromptControl).disabled_reason).toBe("locked");
    expect(uiOutputBoundarySchema.parse(visibleBoundary).visible).toBe(true);
    expect(uiOutputBoundarySchema.parse(noBoundary).type).toBe("none");
  });

  it("rejects incoherent write states and invisible boundaries", () => {
    expect(() =>
      uiWriteControlStateSchema.parse({
        ...enabledPromptControl,
        disabled_reason: "locked"
      })
    ).toThrow();

    expect(() =>
      uiWriteControlStateSchema.parse({
        ...disabledPromptControl,
        disabled_reason: null
      })
    ).toThrow();

    expect(() =>
      uiWriteControlStateSchema.parse({
        action: "raw_input",
        enabled: false,
        disabled_reason: "raw_input_confirmation_required",
        requires_confirmation: false,
        advanced_required: true
      })
    ).toThrow();

    expect(() =>
      uiOutputBoundarySchema.parse({
        ...visibleBoundary,
        visible: false
      })
    ).toThrow();
  });
});

describe("UI session card and detail schemas", () => {
  it("validates session cards and one-session detail view models", () => {
    expect(uiSessionCardSchema.parse(sessionCard).project_label).toBe("HostDeck");

    expect(
      uiSessionDetailViewModelSchema.parse({
        screen: "session_detail",
        session: sessionFixture,
        output: {
          session_id: sessionId,
          events: [
            {
              type: "output",
              session_id: sessionId,
              cursor: 7,
              captured_at: timestamp,
              text: "Need a decision."
            }
          ],
          next_cursor: 8,
          truncated: false
        },
        boundary: noBoundary,
        stream_state: "connected",
        prompt_control: enabledPromptControl,
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
      }).session.id
    ).toBe(sessionId);
  });

  it("rejects unsupported UI-only state and multi-session drift", () => {
    expect(() =>
      uiSessionCardSchema.parse({
        ...sessionCard,
        status: "healthy"
      })
    ).toThrow();

    expect(() =>
      uiSessionCardSchema.parse({
        ...sessionCard,
        lifecycle_state: "stale",
        write_control: enabledPromptControl
      })
    ).toThrow();

    expect(() =>
      uiSessionDetailViewModelSchema.parse({
        screen: "session_detail",
        session: sessionFixture,
        output: {
          session_id: "sess_other_contract_01",
          events: [],
          next_cursor: 0,
          truncated: false
        },
        boundary: noBoundary,
        stream_state: "connected",
        prompt_control: enabledPromptControl,
        slash_controls: [
          {
            command: "/model",
            control: {
              ...slashControl,
              action: "prompt"
            }
          }
        ],
        stop_control: stopControl,
        raw_input_control: {
          action: "raw_input",
          enabled: true,
          disabled_reason: null,
          requires_confirmation: true,
          advanced_required: true
        },
        advanced_raw_visible: false,
        error_message: null
      })
    ).toThrow();
  });
});

describe("UI host safety, trust, and mission control schemas", () => {
  it("validates host safety and trust state models", () => {
    expect(
      uiHostSafetyViewModelSchema.parse({
        host: hostStatusFixture,
        security: securityFixture,
        network: networkFixture,
        remote_unlock_available: false,
        dashboard_lan_mutation_available: false
      }).remote_unlock_available
    ).toBe(false);

    expect(
      uiTrustStateViewModelSchema.parse({
        state: "trusted_write",
        trusted: true,
        read_only: false,
        locked: false,
        lan_enabled: false,
        client_id: "phone",
        write_controls_enabled: true,
        message: null
      }).write_controls_enabled
    ).toBe(true);

    expect(
      uiTrustStateViewModelSchema.parse({
        state: "trusted_read_only",
        trusted: true,
        read_only: true,
        locked: false,
        lan_enabled: false,
        client_id: "phone",
        write_controls_enabled: false,
        message: "Read-only access."
      }).read_only
    ).toBe(true);

    expect(
      uiTrustStateViewModelSchema.parse({
        state: "locked",
        trusted: true,
        read_only: false,
        locked: true,
        lan_enabled: false,
        client_id: "phone",
        write_controls_enabled: false,
        message: "Remote writes are locked."
      }).locked
    ).toBe(true);
  });

  it("validates Mission Control ready and empty states", () => {
    const host_safety = {
      host: hostStatusFixture,
      security: securityFixture,
      network: networkFixture,
      remote_unlock_available: false,
      dashboard_lan_mutation_available: false
    };

    const trust = {
      state: "trusted_write",
      trusted: true,
      read_only: false,
      locked: false,
      lan_enabled: false,
      client_id: "phone",
      write_controls_enabled: true,
      message: null
    };

    expect(
      uiMissionControlViewModelSchema.parse({
        screen: "mission_control",
        state: "ready",
        host_safety,
        trust,
        sessions: [sessionCard],
        attention_sorted: true,
        error_message: null
      }).sessions
    ).toHaveLength(1);

    expect(
      uiMissionControlViewModelSchema.parse({
        screen: "mission_control",
        state: "empty",
        host_safety,
        trust,
        sessions: [],
        attention_sorted: true,
        error_message: null
      }).state
    ).toBe("empty");
  });

  it("rejects unsafe host controls and invalid trust or screen states", () => {
    expect(() =>
      uiHostSafetyViewModelSchema.parse({
        host: hostStatusFixture,
        security: securityFixture,
        network: networkFixture,
        remote_unlock_available: true,
        dashboard_lan_mutation_available: false
      })
    ).toThrow();

    expect(() =>
      uiTrustStateViewModelSchema.parse({
        state: "unpaired",
        trusted: false,
        read_only: false,
        locked: false,
        lan_enabled: false,
        client_id: null,
        write_controls_enabled: true,
        message: null
      })
    ).toThrow();

    expect(() =>
      uiTrustStateViewModelSchema.parse({
        state: "trusted_write",
        trusted: true,
        read_only: true,
        locked: false,
        lan_enabled: false,
        client_id: "phone",
        write_controls_enabled: false,
        message: null
      })
    ).toThrow();

    expect(() =>
      uiTrustStateViewModelSchema.parse({
        state: "trusted_read_only",
        trusted: true,
        read_only: false,
        locked: false,
        lan_enabled: false,
        client_id: "phone",
        write_controls_enabled: true,
        message: null
      })
    ).toThrow();

    expect(() =>
      uiMissionControlViewModelSchema.parse({
        screen: "mission_control",
        state: "empty",
        host_safety: {
          host: hostStatusFixture,
          security: securityFixture,
          network: networkFixture,
          remote_unlock_available: false,
          dashboard_lan_mutation_available: false
        },
        trust: {
          state: "trusted_write",
          trusted: true,
          read_only: false,
          locked: false,
          lan_enabled: false,
          client_id: "phone",
          write_controls_enabled: true,
          message: null
        },
        sessions: [sessionCard],
        attention_sorted: true,
        error_message: null
      })
    ).toThrow();

    expect(() =>
      uiMissionControlViewModelSchema.parse({
        screen: "mission_control",
        state: "ready",
        host_safety: {
          host: hostStatusFixture,
          security: securityFixture,
          network: networkFixture,
          remote_unlock_available: false,
          dashboard_lan_mutation_available: false
        },
        trust: {
          state: "trusted_write",
          trusted: true,
          read_only: false,
          locked: false,
          lan_enabled: false,
          client_id: "phone",
          write_controls_enabled: true,
          message: null
        },
        sessions: [
          {
            ...sessionCard,
            id: "sess_low_attention_01",
            name: "low-attention",
            attention: "none"
          },
          {
            ...sessionCard,
            id: "sess_high_attention_01",
            name: "high-attention",
            attention: "failed",
            status: "tests_failed"
          }
        ],
        attention_sorted: true,
        error_message: null
      })
    ).toThrow();
  });
});
