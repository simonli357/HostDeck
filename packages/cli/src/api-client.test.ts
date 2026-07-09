import { describe, expect, it } from "vitest";
import { createHostDeckApiClient, type HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";

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

const sessionResponse = {
  session: {
    id: "sess_cli_client_01",
    name: "client-demo",
    cwd: "/home/simonli/HostDeck",
    backend: {
      type: "tmux",
      tmux: {
        session_name: "hostdeck_sess_cli_client_01",
        window_name: "codex",
        pane_id: "%1"
      }
    },
    lifecycle_state: "running",
    status: "unknown",
    attention: "unknown",
    created_at: "2026-07-09T08:00:00.000Z",
    updated_at: "2026-07-09T08:00:00.000Z",
    last_activity_at: null,
    branch: null,
    recent_output: {
      text: "",
      cursor: null,
      line_count: 0,
      truncated: false
    }
  }
} as const;

const acceptedWrite = {
  accepted: true,
  session_id: "sess_cli_client_01",
  action: "prompt",
  audit_required: true
} as const;

describe("HostDeck API client", () => {
  it("requests and validates daemon status", async () => {
    const requests: string[] = [];
    const client = createHostDeckApiClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async (url, init) => {
        requests.push(`${init.method} ${url}`);
        return jsonResponse(200, statusResponse);
      }
    });

    await expect(client.getStatus()).resolves.toMatchObject({ version: "0.0.0" });
    expect(requests).toEqual(["GET http://127.0.0.1:3777/api/host/status"]);
  });

  it("requests session start, list, detail, send, and stop with typed JSON bodies", async () => {
    const requests: Array<{ readonly method: string; readonly url: string; readonly body: string | undefined }> = [];
    const client = createHostDeckApiClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async (url, init) => {
        requests.push({ method: init.method, url, body: init.body });

        if (url.endsWith("/api/sessions") && init.method === "POST") {
          return jsonResponse(201, sessionResponse);
        }

        if (url.endsWith("/api/sessions") && init.method === "GET") {
          return jsonResponse(200, { sessions: [sessionResponse.session] });
        }

        if (url.endsWith("/api/sessions/sess_cli_client_01") && init.method === "GET") {
          return jsonResponse(200, sessionResponse);
        }

        if (url.endsWith("/api/sessions/sess_cli_client_01/input")) {
          return jsonResponse(202, acceptedWrite);
        }

        return jsonResponse(202, { ...acceptedWrite, action: "stop" });
      }
    });

    await expect(client.startSession({ name: "client-demo", cwd: "/home/simonli/HostDeck" })).resolves.toMatchObject(sessionResponse);
    await expect(client.listSessions()).resolves.toMatchObject({ sessions: [sessionResponse.session] });
    await expect(client.getSession("sess_cli_client_01")).resolves.toMatchObject(sessionResponse);
    await expect(client.sendPrompt("sess_cli_client_01", "Continue")).resolves.toMatchObject({ action: "prompt" });
    await expect(client.stopSession("sess_cli_client_01")).resolves.toMatchObject({ action: "stop" });

    expect(requests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:3777/api/sessions",
        body: JSON.stringify({ name: "client-demo", cwd: "/home/simonli/HostDeck" })
      },
      { method: "GET", url: "http://127.0.0.1:3777/api/sessions", body: undefined },
      { method: "GET", url: "http://127.0.0.1:3777/api/sessions/sess_cli_client_01", body: undefined },
      {
        method: "POST",
        url: "http://127.0.0.1:3777/api/sessions/sess_cli_client_01/input",
        body: JSON.stringify({ text: "Continue" })
      },
      {
        method: "POST",
        url: "http://127.0.0.1:3777/api/sessions/sess_cli_client_01/stop",
        body: JSON.stringify({ confirm: true })
      }
    ]);
  });

  it("turns fetch failures into daemon-unavailable failures", async () => {
    const client = createHostDeckApiClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED");
      }
    });

    await expect(client.getStatus()).rejects.toMatchObject({
      exitCode: cliExitCodes.daemonUnavailable,
      code: "daemon_unavailable"
    });
  });

  it("turns typed API errors into API exit failures", async () => {
    const client = createHostDeckApiClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () =>
        jsonResponse(403, {
          error: {
            code: "permission_denied",
            message: "Read access is required.",
            retryable: false,
            field: "authorization"
          }
        })
    });

    await expect(client.getStatus()).rejects.toMatchObject({
      exitCode: cliExitCodes.apiError,
      code: "permission_denied",
      field: "authorization"
    });
  });

  it("turns rejected write responses into typed API failures", async () => {
    const client = createHostDeckApiClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () =>
        jsonResponse(409, {
          accepted: false,
          error: {
            code: "stale_session",
            message: "Session is stale.",
            retryable: false,
            session_id: "sess_cli_client_01"
          }
        })
    });

    await expect(client.sendPrompt("sess_cli_client_01", "Continue")).rejects.toMatchObject({
      exitCode: cliExitCodes.apiError,
      code: "stale_session",
      status: 409
    });
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
