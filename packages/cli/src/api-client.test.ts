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
});

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
