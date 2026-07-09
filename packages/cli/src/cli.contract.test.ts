import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { runCli } from "./shell.js";

const statusResponse = {
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
    checked_at: "2026-07-09T08:00:00.000Z"
  },
  tmux: {
    state: "ok",
    checked_at: "2026-07-09T08:00:00.000Z"
  },
  stream: {
    state: "ok",
    checked_at: "2026-07-09T08:00:00.000Z"
  },
  startup_checks: [{ name: "state_dir", state: "ok" }],
  stale_session_count: 0,
  last_error: null
} as const;

const runningSession = {
  id: "sess_cli_contract_01",
  name: "contract-demo",
  cwd: "/home/simonli/HostDeck",
  backend: {
    type: "tmux",
    tmux: {
      session_name: "hostdeck_sess_cli_contract_01",
      window_name: "codex",
      pane_id: "%1"
    }
  },
  lifecycle_state: "running",
  status: "waiting_for_user",
  attention: "needs_input",
  created_at: "2026-07-09T08:00:00.000Z",
  updated_at: "2026-07-09T08:00:00.000Z",
  last_activity_at: "2026-07-09T08:00:00.000Z",
  branch: "main",
  recent_output: {
    text: "Need input",
    cursor: 2,
    line_count: 1,
    truncated: false
  }
} as const;

const staleSession = {
  ...runningSession,
  id: "sess_cli_contract_02",
  name: "stale-demo",
  lifecycle_state: "stale",
  status: "disconnected",
  attention: "unknown",
  last_activity_at: null
} as const;

describe("CLI shell contract", () => {
  it("parses status and renders daemon status output", async () => {
    const result = await runCli(["status"], {
      env: {},
      fetch: async () => jsonResponse(200, statusResponse)
    });

    expect(result).toMatchObject({
      exitCode: cliExitCodes.ok,
      stderr: ""
    });
    expect(result.stdout).toContain("HostDeck daemon: ready");
    expect(result.stdout).toContain("Bind: localhost (127.0.0.1:3777)");
  });

  it("renders JSON status without changing the exit family", async () => {
    const result = await runCli(["--json", "status"], {
      env: {},
      fetch: async () => jsonResponse(200, statusResponse)
    });

    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "0.0.0",
      stale_session_count: 0
    });
  });

  it("starts a session and renders the managed tmux target", async () => {
    const result = await runCli(["start", "--name", "contract-demo", "--cwd", "/home/simonli/HostDeck"], {
      env: {},
      fetch: async (_url, init) => {
        expect(init.body).toBe(JSON.stringify({ name: "contract-demo", cwd: "/home/simonli/HostDeck" }));
        return jsonResponse(201, { session: runningSession });
      }
    });

    expect(result).toMatchObject({
      exitCode: cliExitCodes.ok,
      stderr: ""
    });
    expect(result.stdout).toContain("Started session: contract-demo");
    expect(result.stdout).toContain("ID: sess_cli_contract_01");
    expect(result.stdout).toContain("Tmux: hostdeck_sess_cli_contract_01");
  });

  it("lists sessions with lifecycle, status, attention, and stale state visible", async () => {
    const result = await runCli(["list"], {
      env: {},
      fetch: async () => jsonResponse(200, { sessions: [runningSession, staleSession] })
    });

    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(result.stdout).toContain("sess_cli_contract_01  contract-demo  lifecycle=running");
    expect(result.stdout).toContain("status=waiting_for_user attention=needs_input");
    expect(result.stdout).toContain("sess_cli_contract_02  stale-demo  lifecycle=stale stale");
  });

  it("sends prompt text to exactly one resolved session target", async () => {
    const requests: string[] = [];
    const result = await runCli(["send", "contract-demo", "Continue", "carefully"], {
      env: {},
      fetch: async (url, init) => {
        requests.push(`${init.method} ${url} ${init.body ?? ""}`);

        if (url.endsWith("/api/sessions")) {
          return jsonResponse(200, { sessions: [runningSession] });
        }

        return jsonResponse(202, {
          accepted: true,
          session_id: runningSession.id,
          action: "prompt",
          audit_required: true
        });
      }
    });

    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(result.stdout).toContain("prompt accepted for sess_cli_contract_01");
    expect(requests).toEqual([
      "GET http://127.0.0.1:3777/api/sessions ",
      `POST http://127.0.0.1:3777/api/sessions/${runningSession.id}/input ${JSON.stringify({ text: "Continue carefully" })}`
    ]);
  });

  it("prints attach metadata instead of reporting an unproven attach", async () => {
    const result = await runCli(["attach", runningSession.id], {
      env: {},
      fetch: async () => jsonResponse(200, { sessions: [runningSession] })
    });

    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(result.stdout).toContain("Attach session: contract-demo");
    expect(result.stdout).toContain("Tmux command: tmux attach-session -t hostdeck_sess_cli_contract_01");
  });

  it("stops exactly one resolved running session", async () => {
    const result = await runCli(["stop", runningSession.id], {
      env: {},
      fetch: async (url) => {
        if (url.endsWith("/api/sessions")) {
          return jsonResponse(200, { sessions: [runningSession] });
        }

        return jsonResponse(202, {
          accepted: true,
          session_id: runningSession.id,
          action: "stop",
          audit_required: true
        });
      }
    });

    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(result.stdout).toContain("stop accepted for sess_cli_contract_01");
  });

  it("fails stale attach and send without posting unproven writes", async () => {
    const staleAttach = await runCli(["attach", staleSession.name], {
      env: {},
      fetch: async () => jsonResponse(200, { sessions: [staleSession] })
    });

    expect(staleAttach.exitCode).toBe(cliExitCodes.apiError);
    expect(staleAttach.stderr).toContain("HostDeck CLI error (stale_session)");

    const requests: string[] = [];
    const staleSend = await runCli(["send", staleSession.name, "hello"], {
      env: {},
      fetch: async (url, init) => {
        requests.push(`${init.method} ${url}`);
        return jsonResponse(200, { sessions: [staleSession] });
      }
    });

    expect(staleSend.exitCode).toBe(cliExitCodes.apiError);
    expect(staleSend.stderr).toContain("HostDeck CLI error (stale_session)");
    expect(requests).toEqual(["GET http://127.0.0.1:3777/api/sessions"]);
  });

  it("fails ambiguous session targets before sending a write", async () => {
    const result = await runCli(["send", runningSession.id, "hello"], {
      env: {},
      fetch: async () =>
        jsonResponse(200, {
          sessions: [
            runningSession,
            {
              ...runningSession,
              id: "sess_cli_contract_03",
              name: runningSession.id
            }
          ]
        })
    });

    expect(result.exitCode).toBe(cliExitCodes.usage);
    expect(result.stderr).toContain("matches more than one managed session");
  });

  it("returns stable usage exits for malformed args", async () => {
    const result = await runCli(["status", "extra"], { env: {} });

    expect(result.exitCode).toBe(cliExitCodes.usage);
    expect(result.stderr).toContain("HostDeck CLI error (malformed_request)");
    expect(result.stderr).toContain("Run `codexdeck help` for usage.");
  });

  it("returns stable config exits for invalid config", async () => {
    const result = await runCli(["status"], {
      env: {
        HOSTDECK_PORT: "0"
      }
    });

    expect(result.exitCode).toBe(cliExitCodes.config);
    expect(result.stderr).toContain("HostDeck CLI error (invalid_config)");
    expect(result.stderr).toContain("HOSTDECK_PORT");
  });

  it("returns stable daemon-unavailable exits with actionable text", async () => {
    const result = await runCli(["status"], {
      env: {},
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED");
      }
    });

    expect(result.exitCode).toBe(cliExitCodes.daemonUnavailable);
    expect(result.stderr).toContain("HostDeck CLI error (daemon_unavailable)");
    expect(result.stderr).toContain("codexdeck serve");
  });

  it("returns stable typed API error exits and preserves field context", async () => {
    const result = await runCli(["--api-url", "http://127.0.0.1:3777", "status"], {
      env: {},
      fetch: async () =>
        jsonResponse(403, {
          error: {
            code: "permission_denied",
            message: "Read token is required.",
            retryable: false,
            field: "authorization"
          }
        })
    });

    expect(result.exitCode).toBe(cliExitCodes.apiError);
    expect(result.stderr).toContain("HostDeck CLI error (permission_denied): Read token is required.");
    expect(result.stderr).toContain("HTTP status: 403");
    expect(result.stderr).toContain("Field: authorization");
  });
});

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
