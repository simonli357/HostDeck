import { usageSnapshotSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { type CliRunOptions, runCli } from "./shell.js";
import type { HostDeckUsageClient } from "./usage-client.js";

const sessionId = "sess_usage_cli_001";
const otherSessionId = "sess_usage_cli_002";
const threadId = "thread-usage-cli-001";

describe("managed-session usage CLI command", () => {
  it("parses one session id with optional JSON and no control override", () => {
    expect(parseCliArgs(["usage", sessionId])).toEqual({
      command: { kind: "usage", session: sessionId, json: false },
      configFlags: {}
    });
    expect(parseCliArgs(["usage", sessionId, "--json"])).toEqual({
      command: { kind: "usage", session: sessionId, json: true },
      configFlags: {}
    });
    expect(
      parseCliArgs([
        "--api-url=http://127.0.0.1:4888",
        "--json",
        "usage",
        sessionId
      ])
    ).toEqual({
      command: { kind: "usage", session: sessionId, json: true },
      configFlags: { apiUrl: "http://127.0.0.1:4888" }
    });

    for (const args of [
      ["usage"],
      ["usage", sessionId, "extra"],
      ["usage", sessionId, "--thread-id", threadId],
      ["usage", sessionId, "--command", "/usage"],
      ["/usage", sessionId],
      ["quota", sessionId]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("includes only the selected usage surface in help", async () => {
    const help = await runCli(["help"]);
    expect(help).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(help.stdout).toContain("codexdeck usage SESSION_ID [--json]");
    expect(help.stdout).not.toMatch(
      /codexdeck (?:quota|\/usage)|usage .*thread-id|usage .*command/iu
    );
  });

  it("passes one validated snapshot receiverlessly without constructing legacy ports", async () => {
    const clientCalls: string[] = [];
    let clientThis: unknown = "not-called";
    let unrelatedAccesses = 0;
    const usageClient: HostDeckUsageClient = {
      read: async function readUsage(this: void, target) {
        clientThis = this;
        clientCalls.push(target);
        return usageSnapshot();
      }
    };
    const options = Object.defineProperties(
      { env: {}, usageClient },
      {
        client: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("legacy-client-private-sentinel");
          }
        },
        localAdmin: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("local-admin-private-sentinel");
          }
        },
        resumeLauncher: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("launcher-private-sentinel");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["usage", sessionId], options);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain(`Usage: ${sessionId}`);
    expect(result.stdout).toContain("Account usage");
    expect(result.stdout).toContain("Observation: not observed");
    expect(result.stdout).not.toMatch(/cost|unlimited|private-sentinel/iu);
    expect(clientCalls).toEqual([sessionId]);
    expect(clientThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("performs one exact loopback request and renders JSON without mutation", async () => {
    const requests: unknown[] = [];
    const result = await runCli(["usage", sessionId, "--json"], {
      env: {},
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(200, usageSnapshot());
      }
    });

    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(usageSnapshot());
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/usage`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          }
        }
      }
    ]);
  });

  it("renders null, empty, zero, and observed values without false quota claims", async () => {
    const nullHistory = await runCli(["usage", sessionId], {
      env: {},
      usageClient: {
        read: async () => usageSnapshot({ nullHistory: true })
      }
    });
    expect(nullHistory.stdout).toContain("Lifetime tokens: not reported");
    expect(nullHistory.stdout).toContain("Daily usage: not reported");
    expect(nullHistory.stdout).toContain("Thread usage\nObservation: not observed");
    expect(nullHistory.stdout).toContain(
      "Runtime rate limits\nObservation: not observed"
    );

    const emptyObserved = await runCli(["usage", sessionId], {
      env: {},
      usageClient: {
        read: async () => usageSnapshot({ emptyHistory: true, observed: true })
      }
    });
    expect(emptyObserved.stdout).toContain("Lifetime tokens: 0");
    expect(emptyObserved.stdout).toContain("Daily usage: no buckets reported");
    expect(emptyObserved.stdout).toContain("Context window: not reported");
    expect(emptyObserved.stdout).toContain(
      "Primary window: used=0% duration_minutes=0 resets=not reported"
    );
    expect(emptyObserved.stdout).toContain("Secondary window: not reported");
    expect(emptyObserved.stdout).toContain("Reached type: not reported");
    expect(emptyObserved.stdout).not.toMatch(/unlimited|monetary|\$|cost/iu);
  });

  it("rejects invalid or hostile client data before rendering", async () => {
    let clientAccesses = 0;
    let fetchCalls = 0;
    const invalidOptions = Object.defineProperty(
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, usageSnapshot());
        }
      },
      "usageClient",
      {
        enumerable: true,
        get() {
          clientAccesses += 1;
          throw new Error("usage-client-private-sentinel");
        }
      }
    ) as CliRunOptions;
    for (const target of ["usage-cli", threadId, "sess with spaces"]) {
      const result = await runCli(["usage", target], invalidOptions);
      expect(result).toMatchObject({
        exitCode: cliExitCodes.usage,
        stdout: ""
      });
      expect(result.stderr).toContain("valid managed session id");
      expect(result.stderr).not.toContain("private-sentinel");
    }
    expect(clientAccesses).toBe(0);
    expect(fetchCalls).toBe(0);

    const hostile = Object.defineProperty({}, "target", {
      enumerable: true,
      get() {
        throw new Error("hostile-output-private-sentinel");
      }
    });
    const candidates = [
      {
        ...usageSnapshot(),
        target: { ...usageSnapshot().target, session_id: otherSessionId }
      },
      { ...usageSnapshot(), terminal_output: "private terminal" },
      hostile
    ];
    for (const candidate of candidates) {
      const result = await runCli(["usage", sessionId], {
        env: {},
        usageClient: { read: async () => candidate as never }
      });
      expect(result).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(result.stderr).toContain(
        "invalid managed-session data"
      );
      expect(result.stderr).not.toMatch(/private|terminal|hostile-output/iu);
    }
  });

  it("preserves bounded failures without retry and rejects non-loopback APIs", async () => {
    let clientCalls = 0;
    const failed = await runCli(["usage", sessionId], {
      env: {},
      usageClient: {
        async read() {
          clientCalls += 1;
          throw clientOperationFailure(
            "runtime_unavailable",
            "Codex usage is unavailable."
          );
        }
      }
    });
    expect(failed).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(failed.stderr).toContain("Codex usage is unavailable");
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      [
        "--api-url",
        "https://private-usage.example.test",
        "usage",
        sessionId
      ],
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, usageSnapshot());
        }
      }
    );
    expect(remote).toMatchObject({
      exitCode: cliExitCodes.config,
      stdout: ""
    });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-usage.example.test");
    expect(fetchCalls).toBe(0);
  });
});

function usageSnapshot(
  options: {
    readonly emptyHistory?: boolean;
    readonly nullHistory?: boolean;
    readonly observed?: boolean;
  } = {}
) {
  const zero = options.emptyHistory || options.observed;
  return usageSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.144.0",
    connection_generation: 3,
    measured_at: "2026-07-15T12:05:00.000Z",
    account: {
      scope: "account",
      summary: {
        lifetime_tokens: options.nullHistory ? null : zero ? 0 : 100,
        peak_daily_tokens: options.nullHistory ? null : zero ? 0 : 60,
        longest_running_turn_seconds: options.nullHistory ? null : zero ? 0 : 30,
        current_streak_days: options.nullHistory ? null : zero ? 0 : 2,
        longest_streak_days: options.nullHistory ? null : zero ? 0 : 4
      },
      daily_buckets: options.nullHistory
        ? null
        : options.emptyHistory
          ? []
          : [
              { start_date: "2026-07-14", tokens: 40 },
              { start_date: "2026-07-15", tokens: 60 }
            ]
    },
    thread: options.observed
      ? {
          state: "observed",
          scope: "thread",
          observed_at: "2026-07-15T12:04:00.000Z",
          turn_id: "turn-usage-cli-001",
          total: tokenBreakdown(0),
          last: tokenBreakdown(0),
          model_context_window: null
        }
      : { state: "not_observed", scope: "thread" },
    rate_limits: options.observed
      ? {
          state: "observed",
          scope: "runtime",
          observed_at: "2026-07-15T12:04:30.000Z",
          primary: {
            used_percent: 0,
            window_duration_minutes: 0,
            resets_at: null
          },
          secondary: null,
          reached_type: null
        }
      : { state: "not_observed", scope: "runtime" }
  });
}

function tokenBreakdown(total: number) {
  return {
    total_tokens: total,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0
  };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
