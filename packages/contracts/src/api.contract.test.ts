import { describe, expect, it } from "vitest";
import {
  apiErrorEnvelopeSchema,
  hostStatusResponseSchema,
  lockRequestSchema,
  networkStateResponseSchema,
  outputQuerySchema,
  pairClaimRequestSchema,
  promptInputRequestSchema,
  rawInputRequestSchema,
  securityStateResponseSchema,
  sessionDetailResponseSchema,
  sessionIdParamsSchema,
  sessionListResponseSchema,
  sessionOutputResponseSchema,
  sessionStreamEventSchema,
  slashCommandRequestSchema,
  stopSessionRequestSchema,
  writeResponseSchema
} from "./api.js";

const sessionId = "sess_contract_01";
const timestamp = "2026-07-08T18:00:00.000Z";

const sessionFixture = {
  id: sessionId,
  name: "contract-demo",
  cwd: "/home/simonli/HostDeck",
  backend: {
    type: "tmux",
    tmux: {
      session_name: "hostdeck-contract-demo",
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
    text: "Need approval?",
    cursor: 4,
    line_count: 1,
    truncated: false
  }
};

describe("API error envelope schema", () => {
  it("accepts bounded API errors and defaults retryability", () => {
    expect(
      apiErrorEnvelopeSchema.parse({
        code: "validation_error",
        message: "Invalid cursor.",
        field: "after",
        session_id: sessionId,
        details: {
          reason: "not_integer"
        }
      })
    ).toMatchObject({
      code: "validation_error",
      retryable: false
    });
  });

  it("rejects sensitive or unbounded error details", () => {
    expect(() =>
      apiErrorEnvelopeSchema.parse({
        code: "internal_error",
        message: "No secrets.",
        details: {
          auth_token: "secret"
        }
      })
    ).toThrow();

    expect(() =>
      apiErrorEnvelopeSchema.parse({
        code: "internal_error",
        message: "No nested payloads.",
        details: {
          nested: {
            value: true
          }
        }
      })
    ).toThrow();
  });
});

describe("session read and output schemas", () => {
  it("validates session list/detail shapes and output cursor queries", () => {
    expect(sessionIdParamsSchema.parse({ session_id: sessionId }).session_id).toBe(sessionId);
    expect(outputQuerySchema.parse({ after: 4 }).after).toBe(4);
    expect(sessionListResponseSchema.parse({ sessions: [sessionFixture] }).sessions).toHaveLength(1);
    expect(sessionDetailResponseSchema.parse({ session: sessionFixture }).session.id).toBe(sessionId);
  });

  it("rejects malformed session and cursor payloads", () => {
    expect(() => sessionIdParamsSchema.parse({ session_id: "bad" })).toThrow();
    expect(() => outputQuerySchema.parse({ after: -1 })).toThrow();
    expect(() =>
      sessionListResponseSchema.parse({
        sessions: [
          {
            ...sessionFixture,
            lifecycle_state: "healthy"
          }
        ]
      })
    ).toThrow();
  });

  it("validates bounded output responses", () => {
    expect(
      sessionOutputResponseSchema.parse({
        session_id: sessionId,
        events: [
          {
            type: "output",
            session_id: sessionId,
            cursor: 5,
            captured_at: timestamp,
            text: "line"
          },
          {
            type: "replay_boundary",
            session_id: sessionId,
            after: 1,
            next_cursor: 5,
            reason: "retention"
          }
        ],
        next_cursor: 6,
        truncated: true
      }).events
    ).toHaveLength(2);
  });
});

describe("stream event schemas", () => {
  it("accepts ordered output, replay boundary, status, and error events", () => {
    expect(
      sessionStreamEventSchema.parse({
        type: "output",
        session_id: sessionId,
        cursor: 1,
        captured_at: timestamp,
        text: "hello"
      }).type
    ).toBe("output");

    expect(
      sessionStreamEventSchema.parse({
        type: "replay_boundary",
        session_id: sessionId,
        after: null,
        next_cursor: 10,
        reason: "restart"
      }).type
    ).toBe("replay_boundary");

    expect(
      sessionStreamEventSchema.parse({
        type: "stream_status",
        session_id: sessionId,
        status: "connected"
      }).type
    ).toBe("stream_status");

    expect(
      sessionStreamEventSchema.parse({
        type: "error",
        session_id: sessionId,
        error: {
          code: "stale_session",
          message: "Session is stale.",
          retryable: false
        }
      }).type
    ).toBe("error");
  });

  it("rejects stream events without one session or cursor truth", () => {
    expect(() =>
      sessionStreamEventSchema.parse({
        type: "output",
        cursor: 1,
        captured_at: timestamp,
        text: "missing session"
      })
    ).toThrow();

    expect(() =>
      sessionStreamEventSchema.parse({
        type: "output",
        session_id: sessionId,
        cursor: -1,
        captured_at: timestamp,
        text: "bad cursor"
      })
    ).toThrow();
  });
});

describe("write, pairing, security, and network schemas", () => {
  it("validates write request and response families", () => {
    expect(promptInputRequestSchema.parse({ text: "Continue" }).text).toBe("Continue");
    expect(slashCommandRequestSchema.parse({ command: "/plan" }).command).toBe("/plan");
    expect(stopSessionRequestSchema.parse({ confirm: true }).confirm).toBe(true);
    expect(rawInputRequestSchema.parse({ text: "\u0003", confirmed: true }).confirmed).toBe(true);

    expect(
      writeResponseSchema.parse({
        accepted: true,
        session_id: sessionId,
        action: "slash",
        audit_required: true
      }).accepted
    ).toBe(true);

    expect(
      writeResponseSchema.parse({
        accepted: false,
        error: {
          code: "unsupported_slash",
          message: "Slash command is not supported.",
          retryable: false
        }
      }).accepted
    ).toBe(false);
  });

  it("rejects malformed write and slash requests", () => {
    expect(() => promptInputRequestSchema.parse({ text: "" })).toThrow();
    expect(() => slashCommandRequestSchema.parse({ command: "/resume" })).toThrow();
    expect(() => stopSessionRequestSchema.parse({ confirm: false })).toThrow();
    expect(() => rawInputRequestSchema.parse({ text: "x", confirmed: false })).toThrow();
  });

  it("validates pair and security state payloads", () => {
    expect(pairClaimRequestSchema.parse({ code: "123456", client_label: "phone" }).code).toBe("123456");
    expect(lockRequestSchema.parse({ lock: true, reason: "operator request" }).lock).toBe(true);
    expect(
      networkStateResponseSchema.parse({
        mode: "localhost",
        host: "127.0.0.1",
        port: 3777,
        lan_enabled: false
      }).port
    ).toBe(3777);
    expect(
      securityStateResponseSchema.parse({
        trusted: true,
        read_only: false,
        locked: false,
        lan_enabled: false,
        client_id: "phone"
      }).trusted
    ).toBe(true);
  });
});

describe("host status schema", () => {
  it("validates host readiness without hiding degraded dependencies", () => {
    expect(
      hostStatusResponseSchema.parse({
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
          state: "degraded",
          message: "tmux check pending"
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
      }).tmux.state
    ).toBe("degraded");
  });
});
