import {
  type ApiSession,
  apiSessionSchema,
  hostStatusResponseSchema,
  networkStateResponseSchema,
  securityStateResponseSchema,
  sessionOutputResponseSchema,
  type TrustState
} from "@hostdeck/contracts";
import { allowedSlashCommands } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  createMissionControlViewModel,
  createSessionDetailViewModel,
  createSessionOutputResponse,
  createTrustStateViewModel,
  createWriteControlState
} from "./view-models.js";

const timestamp = "2026-07-09T12:00:00.000Z";

const host = hostStatusResponseSchema.parse({
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
    state: "ok",
    checked_at: timestamp
  },
  stream: {
    state: "ok",
    checked_at: timestamp
  },
  startup_checks: [{ name: "state_dir", state: "ok" }],
  stale_session_count: 0,
  last_error: null
});

const network = networkStateResponseSchema.parse({
  mode: "localhost",
  host: "127.0.0.1",
  port: 3777,
  lan_enabled: false
});

const trustedWrite = securityStateResponseSchema.parse({
  trusted: true,
  read_only: false,
  locked: false,
  lan_enabled: false,
  client_id: "phone",
  auth_transport: "http_only_cookie",
  csrf_token: "csrf_token_for_view_model_tests_123456"
});

const trustedReadOnly = securityStateResponseSchema.parse({
  ...trustedWrite,
  read_only: true,
  csrf_token: null
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

const locked = securityStateResponseSchema.parse({
  ...trustedWrite,
  locked: true,
  csrf_token: null
});

describe("dashboard view-model helpers", () => {
  it("builds attention-sorted Mission Control view models", () => {
    const viewModel = createMissionControlViewModel({
      host,
      security: trustedWrite,
      network,
      sessions: [
        sessionFixture("sess_web_idle_001", "idle", "idle", "none"),
        sessionFixture("sess_web_failed_1", "failed", "tests_failed", "failed"),
        sessionFixture("sess_web_approve1", "approve", "waiting_for_approval", "needs_approval"),
        sessionFixture("sess_web_input_01", "input", "waiting_for_user", "needs_input")
      ]
    });

    expect(viewModel.state).toBe("ready");
    expect(viewModel.attention_sorted).toBe(true);
    expect(viewModel.sessions.map((session) => session.name)).toEqual(["failed", "approve", "input", "idle"]);
    expect(viewModel.sessions[0]?.project_label).toBe("HostDeck");
  });

  it("maps trust and write-disabled states before writes", () => {
    expect(createTrustStateViewModel(trustedWrite).state).toBe("trusted_write");
    expect(createTrustStateViewModel(trustedReadOnly).write_controls_enabled).toBe(false);
    expect(createTrustStateViewModel(unpaired, { untrustedState: "permission_denied" }).state).toBe("permission_denied");
    expect(createTrustStateViewModel(locked).state).toBe("locked");

    const runningSession = sessionFixture("sess_web_write_01", "write", "waiting_for_user", "needs_input");
    const unknownSession = sessionFixture("sess_web_unknown1", "unknown", "unknown", "unknown");
    const staleSession = sessionFixture("sess_web_stale_01", "stale", "unknown", "unknown", "stale");
    const stoppedSession = sessionFixture("sess_web_stop_001", "stopped", "idle", "none", "stopped");

    expect(disabledReasonFor(runningSession, unpaired)).toBe("untrusted");
    expect(disabledReasonFor(runningSession, trustedReadOnly)).toBe("read_only");
    expect(disabledReasonFor(runningSession, locked)).toBe("locked");
    expect(disabledReasonFor(unknownSession, trustedWrite)).toBe("unknown");
    expect(disabledReasonFor(staleSession, trustedWrite)).toBe("stale");
    expect(disabledReasonFor(stoppedSession, trustedWrite)).toBe("stopped");
  });

  it("builds Session Detail controls for all V1 slash commands and stream states", () => {
    const session = sessionFixture("sess_web_detail1", "detail", "waiting_for_user", "needs_input");
    const output = createSessionOutputResponse(session);
    const viewModel = createSessionDetailViewModel({
      session,
      security: trustedWrite,
      options: {
        output: sessionOutputResponseSchema.parse({
          ...output,
          events: [
            {
              type: "replay_boundary",
              session_id: session.id,
              after: 1,
              next_cursor: 7,
              reason: "retention"
            }
          ],
          next_cursor: 7,
          truncated: true
        }),
        streamState: "reconnecting"
      }
    });

    expect(viewModel.slash_controls.map((control) => control.command)).toEqual(allowedSlashCommands);
    expect(viewModel.boundary.visible).toBe(true);
    expect(viewModel.stream_state).toBe("reconnecting");
    expect(viewModel.prompt_control.disabled_reason).toBe("stream_disconnected");
  });

  it("keeps raw input gated behind advanced confirmation", () => {
    const session = sessionFixture("sess_web_raw_001", "raw", "waiting_for_user", "needs_input");

    expect(createSessionDetailViewModel({ session, security: trustedWrite }).raw_input_control.disabled_reason).toBe("raw_input_confirmation_required");

    expect(
      createSessionDetailViewModel({
        session,
        security: trustedWrite,
        options: {
          advancedRawVisible: true,
          rawInputConfirmed: true
        }
      }).raw_input_control.enabled
    ).toBe(true);
  });
});

function disabledReasonFor(session: ApiSession, security: TrustState) {
  return createWriteControlState({
    action: "prompt",
    session,
    security
  }).disabled_reason;
}

function sessionFixture(
  id: string,
  name: string,
  status: ApiSession["status"],
  attention: ApiSession["attention"],
  lifecycleState: ApiSession["lifecycle_state"] = "running"
): ApiSession {
  return apiSessionSchema.parse({
    id,
    name,
    cwd: "/home/simonli/Videos/apps/HostDeck",
    backend: {
      type: "tmux",
      tmux: {
        session_name: `hostdeck-${name}`,
        window_name: "codex",
        pane_id: "%1"
      }
    },
    lifecycle_state: lifecycleState,
    status,
    attention,
    created_at: timestamp,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "main",
    recent_output: {
      text: `${name} output`,
      cursor: 6,
      line_count: 1,
      truncated: false
    }
  });
}
