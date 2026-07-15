import {
  hostStatusResponseSchema,
  selectedSessionStartResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import type { LocalAdmin } from "./local-admin.js";
import type { HostDeckPairingLinkClient } from "./pairing-link-client.js";
import { parseCliArgs } from "./parser.js";
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

const selectedStartResponse = selectedSessionStartResponseSchema.parse({
  operation_id: "op_session_start_contract_0001",
  session: {
    id: "sess_cli_contract_01",
    name: "contract-demo",
    codex_thread_id: "thread-cli-contract-01",
    cwd: "/home/simonli/HostDeck",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: "2026-07-09T08:00:00.000Z",
    archived_at: null,
    session_state: "active",
    turn_state: "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: "2026-07-09T08:00:00.000Z",
    last_activity_at: "2026-07-09T08:00:00.000Z",
    branch: "main",
    model: "gpt-5.5-codex",
    goal: null,
    recent_summary: "Managed Codex session ready.",
    last_event_cursor: null
  }
});

describe("CLI shell contract", () => {
  it("parses every V1 CLI command and config flag family", () => {
    const cases = [
      {
        label: "help",
        args: ["help"],
        expected: { command: { kind: "help" }, configFlags: {} }
      },
      {
        label: "version",
        args: ["version"],
        expected: { command: { kind: "version" }, configFlags: {} }
      },
      {
        label: "serve",
        args: ["--state-dir", "state", "--database-path=db.sqlite", "--port=4888", "serve"],
        expected: {
          command: { kind: "serve" },
          configFlags: { stateDir: "state", databasePath: "db.sqlite", port: "4888" }
        }
      },
      {
        label: "status",
        args: ["--api-url=http://127.0.0.1:4888", "status", "--json"],
        expected: {
          command: { kind: "status", json: true },
          configFlags: { apiUrl: "http://127.0.0.1:4888" }
        }
      },
      {
        label: "start",
        args: ["start", "--name=contract-demo", "--cwd", "/tmp/hostdeck-demo", "--json"],
        expected: {
          command: { kind: "start", name: "contract-demo", cwd: "/tmp/hostdeck-demo", json: true },
          configFlags: {}
        }
      },
      {
        label: "list",
        args: ["--json", "list"],
        expected: { command: { kind: "list", json: true }, configFlags: {} }
      },
      {
        label: "send",
        args: ["send", "contract-demo", "Continue", "carefully"],
        expected: {
          command: { kind: "send", session: "contract-demo", text: "Continue carefully" },
          configFlags: {}
        }
      },
      {
        label: "attach",
        args: ["attach", "contract-demo"],
        expected: { command: { kind: "attach", session: "contract-demo" }, configFlags: {} }
      },
      {
        label: "resume",
        args: ["resume", "sess_cli_contract_01"],
        expected: {
          command: { kind: "resume", session: "sess_cli_contract_01" },
          configFlags: {}
        }
      },
      {
        label: "usage",
        args: ["usage", "sess_cli_contract_01", "--json"],
        expected: {
          command: {
            kind: "usage",
            session: "sess_cli_contract_01",
            json: true
          },
          configFlags: {}
        }
      },
      {
        label: "skills",
        args: ["skills", "sess_cli_contract_01", "--json"],
        expected: {
          command: {
            kind: "skills",
            session: "sess_cli_contract_01",
            json: true
          },
          configFlags: {}
        }
      },
      {
        label: "stop",
        args: ["stop", "contract-demo"],
        expected: { command: { kind: "stop", session: "contract-demo" }, configFlags: {} }
      },
      {
        label: "pair",
        args: ["pair", "--label=phone", "--read-only"],
        expected: {
          command: { kind: "pair", label: "phone", permission: "read" },
          configFlags: {}
        }
      },
      {
        label: "lock",
        args: ["lock", "--reason=maintenance", "--json"],
        expected: {
          command: { kind: "lock", reason: "maintenance", json: true },
          configFlags: {}
        }
      },
      {
        label: "unlock",
        args: ["unlock", "--json"],
        expected: { command: { kind: "unlock", json: true }, configFlags: {} }
      }
    ] as const;

    for (const scenario of cases) {
      expect(parseCliArgs(scenario.args), scenario.label).toEqual(scenario.expected);
    }
  });

  it("renders help and version success output without loading daemon config", async () => {
    const help = await runCli(["help"], { env: {} });
    const version = await runCli(["version"], { env: {}, version: "1.2.3-contract" });

    expect(help).toMatchObject({
      exitCode: cliExitCodes.ok,
      stderr: ""
    });
    expect(help.stdout).toContain("codexdeck [--state-dir PATH] [--database PATH] [--port PORT] serve");
    expect(help.stdout).toContain("codexdeck [--api-url URL | --host HOST --port PORT] status [--json]");
    expect(help.stdout).toContain("codexdeck resume SESSION_ID");
    expect(help.stdout).toContain("codexdeck usage SESSION_ID [--json]");
    expect(help.stdout).toContain("codexdeck skills SESSION_ID [--json]");
    expect(help.stdout).not.toMatch(/codexdeck lan(?:\s|$)/iu);
    expect(help.stdout).toContain("Global connection and state options must appear before the command.");
    expect(version).toMatchObject({
      exitCode: cliExitCodes.ok,
      stdout: "codexdeck 1.2.3-contract\n",
      stderr: ""
    });
  });

  it("starts and stops the foreground service through the serve command", async () => {
    const calls: unknown[] = [];
    const result = await runCli(["--port", "4888", "--state-dir", "/tmp/hostdeck-state", "--database", "/tmp/hostdeck-state/hostdeck.sqlite", "serve"], {
      env: { HOME: "/tmp/hostdeck-home", XDG_RUNTIME_DIR: "/tmp/hostdeck-runtime" },
      startService: async (input) => {
        calls.push(input);
        return {
          baseUrl: new URL("http://127.0.0.1:4888"),
          startup: {} as never,
          server: {} as never,
          status: () => hostStatusResponseSchema.parse(statusResponse),
          close: async () => {
            calls.push({ method: "close" });
          }
        };
      },
      waitForShutdown: async () => {
        calls.push({ method: "shutdown" });
      }
    });

    expect(result).toMatchObject({
      exitCode: cliExitCodes.ok,
      stderr: ""
    });
    expect(result.stdout).toContain("HostDeck daemon ready at http://127.0.0.1:4888");
    expect(result.stdout).toContain("HostDeck daemon stopped.");
    expect(calls).toEqual([
      {
        version: "0.0.0",
        configDir: "/tmp/hostdeck-home/.config/hostdeck",
        stateDir: "/tmp/hostdeck-state",
        runtimeDir: "/tmp/hostdeck-runtime/hostdeck",
        databasePath: "/tmp/hostdeck-state/hostdeck.sqlite",
        bindPort: 4888
      },
      { method: "shutdown" },
      { method: "close" }
    ]);
  });

  it("rejects service startup without a secure XDG runtime before invoking the service", async () => {
    let starts = 0;
    const result = await runCli(["serve"], {
      env: { HOME: "/tmp/hostdeck-home" },
      startService: async () => {
        starts += 1;
        throw new Error("Service startup must not run without XDG_RUNTIME_DIR.");
      }
    });

    expect(result).toMatchObject({
      exitCode: cliExitCodes.config,
      stdout: ""
    });
    expect(result.stderr).toContain("XDG_RUNTIME_DIR is required");
    expect(starts).toBe(0);
  });

  it("streams foreground service readiness before shutdown completes", async () => {
    const output: string[] = [];
    let resolveShutdown: (() => void) | undefined;
    const resultPromise = runCli(["--port", "4888", "serve"], {
      env: { HOME: "/tmp/hostdeck-home", XDG_RUNTIME_DIR: "/tmp/hostdeck-runtime" },
      startService: async () => ({
        baseUrl: new URL("http://127.0.0.1:4888"),
        startup: {} as never,
        server: {} as never,
        status: () => hostStatusResponseSchema.parse(statusResponse),
        close: async () => {
          output.push("closed");
        }
      }),
      waitForShutdown: async () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
      writeStdout: (chunk) => {
        output.push(chunk);
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(output).toEqual(["HostDeck daemon ready at http://127.0.0.1:4888\n"]);
    expect(resolveShutdown).toBeDefined();

    resolveShutdown?.();
    const result = await resultPromise;

    expect(result).toMatchObject({
      exitCode: cliExitCodes.ok,
      stdout: "",
      stderr: ""
    });
    expect(output).toEqual([
      "HostDeck daemon ready at http://127.0.0.1:4888\n",
      "closed",
      "HostDeck daemon stopped.\n"
    ]);
  });

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

  it("starts a selected managed session without exposing a legacy backend", async () => {
    const result = await runCli(["start", "--name", "contract-demo", "--cwd", "/home/simonli/HostDeck"], {
      env: {},
      createStartOperationId: () => "op_session_start_contract_0001",
      fetch: async (_url, init) => {
        expect(init.body).toBe(JSON.stringify({
          operation_id: "op_session_start_contract_0001",
          name: "contract-demo",
          cwd: "/home/simonli/HostDeck"
        }));
        return jsonResponse(201, selectedStartResponse);
      }
    });

    expect(result).toMatchObject({
      exitCode: cliExitCodes.ok,
      stderr: ""
    });
    expect(result.stdout).toContain("Started session: contract-demo");
    expect(result.stdout).toContain("ID: sess_cli_contract_01");
    expect(result.stdout).toContain("Runtime: codex_app_server 0.144.0");
    expect(result.stdout).not.toMatch(/tmux|backend/iu);
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

  it("creates one fragment link through the selected client and QR renderer", async () => {
    const calls: unknown[] = [];
    let qrInput = "";
    const result = await runCli(["pair", "--label", "phone", "--read-only"], {
      env: {},
      pairingClient: fakePairingClient(calls),
      createPairOperationId: () => "op_pair_request_contract_0001",
      renderPairingQr: async (link) => {
        qrInput = link;
        return "terminal-qr";
      }
    });

    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Pairing link created.");
    expect(result.stdout).toContain("terminal-qr");
    expect(result.stdout).toContain(
      "https://private-laptop.fixture-tailnet.ts.net/#pair=AbCdEfGhIjKlMnOpQrSt_1"
    );
    expect(result.stdout).toContain("Permission: read");
    expect(result.stdout).toContain("Expires: 2026-07-13T22:05:00.000Z");
    expect(result.stdout).not.toContain("Code:");
    expect(qrInput).toBe(
      "https://private-laptop.fixture-tailnet.ts.net/#pair=AbCdEfGhIjKlMnOpQrSt_1"
    );
    expect(calls).toEqual([
      {
        method: "pair_link",
        operation_id: "op_pair_request_contract_0001",
        permission: "read",
        client_label: "phone"
      }
    ]);
  });

  it("locks and unlocks through local admin commands", async () => {
    const calls: unknown[] = [];

    const lock = await runCli(["lock", "--reason", "maintenance"], {
      env: {},
      localAdmin: fakeLocalAdmin(calls)
    });
    const unlock = await runCli(["unlock", "--json"], {
      env: {},
      localAdmin: fakeLocalAdmin(calls)
    });
    expect(lock.exitCode).toBe(cliExitCodes.ok);
    expect(lock.stdout).toContain("HostDeck is now locked.");
    expect(JSON.parse(unlock.stdout)).toMatchObject({ locked: false, audit_event_id: "audit_unlock" });
    expect(calls).toEqual([
      { method: "lock", locked: true, reason: "maintenance" },
      { method: "lock", locked: false }
    ]);
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

  it("returns usage exits for malformed arguments across every command family", async () => {
    const cases = [
      { label: "help", args: ["help", "extra"], message: "help command does not accept extra arguments" },
      { label: "version", args: ["version", "extra"], message: "version command does not accept extra arguments" },
      { label: "serve", args: ["serve", "extra"], message: "serve command does not accept positional arguments" },
      { label: "status", args: ["status", "extra"], message: "status command does not accept positional arguments" },
      { label: "start", args: ["start", "--name", "contract-demo"], message: "start command requires --cwd" },
      { label: "list", args: ["list", "extra"], message: "list command does not accept positional arguments" },
      { label: "send", args: ["send", "contract-demo"], message: "send command requires a session target and text" },
      { label: "attach", args: ["attach"], message: "attach command requires exactly one session target" },
      { label: "stop", args: ["stop", "one", "two"], message: "stop command requires exactly one session target" },
      { label: "pair ttl", args: ["pair", "--ttl-minutes", "5"], message: "Unknown pair option: --ttl-minutes" },
      { label: "pair json", args: ["--json", "pair"], message: "pair command does not support --json" },
      { label: "pair permission", args: ["pair", "--read-only", "--write"], message: "accepts one permission option" },
      { label: "pair label", args: ["pair", "--label", "one", "--label=two"], message: "accepts --label only once" },
      { label: "lock", args: ["lock", "extra"], message: "Unexpected lock argument" },
      { label: "unlock", args: ["unlock", "extra"], message: "unlock command does not accept positional arguments" },
      { label: "removed lan command", args: ["lan", "enable"], message: "Unknown command: lan" }
    ] as const;

    for (const scenario of cases) {
      const result = await runCli(scenario.args, { env: {} });

      expect(result.exitCode, scenario.label).toBe(cliExitCodes.usage);
      expect(result.stdout, scenario.label).toBe("");
      expect(result.stderr, scenario.label).toContain("HostDeck CLI error (malformed_request)");
      expect(result.stderr, scenario.label).toContain(scenario.message);
      expect(result.stderr, scenario.label).toContain("Run `codexdeck help` for usage.");
    }
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

  it("returns config exits for invalid serve config before starting the foreground service", async () => {
    let started = false;
    const result = await runCli(["--port", "0", "serve"], {
      env: {},
      startService: async () => {
        started = true;
        throw new Error("serve should not start with invalid config");
      }
    });

    expect(result.exitCode).toBe(cliExitCodes.config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HostDeck CLI error (invalid_config)");
    expect(result.stderr).toContain("--port");
    expect(started).toBe(false);
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

  it("returns daemon-unavailable exits for every daemon-backed command", async () => {
    const cases = [
      { label: "status", args: ["status"] },
      { label: "start", args: ["start", "--name", "contract-demo", "--cwd", "/tmp/hostdeck-demo"] },
      { label: "list", args: ["list"] },
      { label: "send", args: ["send", "contract-demo", "hello"] },
      { label: "attach", args: ["attach", "contract-demo"] },
      { label: "stop", args: ["stop", "contract-demo"] }
    ] as const;

    for (const scenario of cases) {
      const result = await runCli(scenario.args, {
        env: {},
        fetch: async () => {
          throw new TypeError("connect ECONNREFUSED");
        }
      });

      expect(result.exitCode, scenario.label).toBe(cliExitCodes.daemonUnavailable);
      expect(result.stdout, scenario.label).toBe("");
      expect(result.stderr, scenario.label).toContain("HostDeck CLI error (daemon_unavailable)");
      expect(result.stderr, scenario.label).toContain("Start the daemon with `codexdeck serve`, then retry.");
    }
  });

  it("returns stable typed API error exits and preserves field context", async () => {
    const result = await runCli(["--api-url", "http://127.0.0.1:3777", "status"], {
      env: {},
      fetch: async () =>
        jsonResponse(403, {
          error: permissionDeniedError()
        })
    });

    expect(result.exitCode).toBe(cliExitCodes.apiError);
    expect(result.stderr).toContain("HostDeck CLI error (permission_denied): Read token is required.");
    expect(result.stderr).toContain("HTTP status: 403");
    expect(result.stderr).toContain("Field: authorization");
  });

  it("returns typed API error exits for every daemon-backed command", async () => {
    const cases = [
      { label: "status", args: ["status"] },
      { label: "start", args: ["start", "--name", "contract-demo", "--cwd", "/tmp/hostdeck-demo"] },
      { label: "list", args: ["list"] },
      { label: "send", args: ["send", "contract-demo", "hello"] },
      { label: "attach", args: ["attach", "contract-demo"] },
      { label: "stop", args: ["stop", "contract-demo"] }
    ] as const;

    for (const scenario of cases) {
      const result = await runCli(scenario.args, {
        env: {},
        fetch: async () =>
          jsonResponse(403, {
            error: permissionDeniedError()
          })
      });

      expect(result.exitCode, scenario.label).toBe(cliExitCodes.apiError);
      expect(result.stdout, scenario.label).toBe("");
      expect(result.stderr, scenario.label).toContain(
        scenario.label === "start"
          ? "HostDeck CLI error (permission_denied): Managed session start is not permitted."
          : "HostDeck CLI error (permission_denied): Read token is required."
      );
      expect(result.stderr, scenario.label).toContain("HTTP status: 403");
      if (scenario.label === "start") {
        expect(result.stderr).not.toContain("Field: authorization");
      } else {
        expect(result.stderr).toContain("Field: authorization");
      }
    }
  });
});

function permissionDeniedError() {
  return {
    code: "permission_denied",
    message: "Read token is required.",
    retryable: false,
    field: "authorization"
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

function fakeLocalAdmin(calls: unknown[]): LocalAdmin {
  return {
    createPairingCode(input) {
      calls.push({ method: "pair", ...input });
      return {
        pairing_id: "pair_contract",
        code: "135790",
        permission: input.permission,
        client_label: input.label ?? null,
        created_at: "2026-07-09T08:00:00.000Z",
        expires_at: "2026-07-09T08:05:00.000Z",
        audit_event_id: "audit_pair"
      };
    },
    setLock(input) {
      calls.push({ method: "lock", ...input });
      return {
        locked: input.locked,
        updated_at: "2026-07-09T08:00:00.000Z",
        audit_event_id: input.locked ? "audit_lock" : "audit_unlock"
      };
    }
  };
}

function fakePairingClient(calls: unknown[]): HostDeckPairingLinkClient {
  return {
    async issue(input) {
      calls.push({ method: "pair_link", ...input });
      return {
        link: "https://private-laptop.fixture-tailnet.ts.net/#pair=AbCdEfGhIjKlMnOpQrSt_1",
        permission: input.permission,
        client_label: input.client_label ?? null,
        expires_at: "2026-07-13T22:05:00.000Z"
      };
    }
  };
}
