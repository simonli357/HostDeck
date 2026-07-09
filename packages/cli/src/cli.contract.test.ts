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
