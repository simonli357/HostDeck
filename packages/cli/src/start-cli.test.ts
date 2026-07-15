import {
  type SelectedSessionStartResponse,
  selectedSessionStartResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { type CliRunOptions, runCli } from "./shell.js";
import type { HostDeckStartClient } from "./start-client.js";

const operationId = "op_session_start_cli_001";
const name = "cli-session";
const cwd = "/tmp/hostdeck-cli-session";

describe("managed-session start CLI command", () => {
  it("parses only name, absolute cwd, and optional JSON", () => {
    expect(parseCliArgs(["start", "--name", name, "--cwd", cwd])).toEqual({
      command: { kind: "start", name, cwd, json: false },
      configFlags: {}
    });
    expect(
      parseCliArgs(["start", `--name=${name}`, `--cwd=${cwd}`, "--json"])
    ).toEqual({
      command: { kind: "start", name, cwd, json: true },
      configFlags: {}
    });
    for (const args of [
      ["start"],
      ["start", "--name", name],
      ["start", "--cwd", cwd],
      ["start", "--name", name, "--cwd", cwd, "extra"],
      ["start", "--name", name, "--cwd", cwd, "--operation-id", operationId],
      ["start", "--name", name, "--cwd", cwd, "--thread-id", "thread-injected"],
      ["start", "--name", name, "--cwd", cwd, "--model", "gpt-private"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("invokes one selected client receiverlessly without touching legacy or filesystem ports", async () => {
    let clientThis: unknown = "not-called";
    const calls: unknown[] = [];
    let unrelatedAccesses = 0;
    const startClient: HostDeckStartClient = {
      start: async function startSession(this: void, request) {
        clientThis = this;
        calls.push(request);
        return response();
      }
    };
    const options = Object.defineProperties(
      {
        env: {},
        startClient,
        createStartOperationId: () => operationId
      },
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
        skillsClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("skills-client-private-sentinel");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(
      ["start", "--name", name, "--cwd", cwd],
      options
    );
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain(`Started session: ${name}`);
    expect(result.stdout).toContain("ID: sess_start_cli_001");
    expect(result.stdout).toContain("State: active");
    expect(result.stdout).toContain(`CWD: ${cwd}`);
    expect(result.stdout).toContain("Runtime: codex_app_server 0.144.0");
    expect(result.stdout).not.toMatch(/tmux|backend/iu);
    expect(calls).toEqual([{ operation_id: operationId, name, cwd }]);
    expect(clientThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("performs one exact loopback request and renders contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const expected = response();
    const result = await runCli(
      ["start", "--name", name, "--cwd", cwd, "--json"],
      {
        env: {},
        createStartOperationId: () => operationId,
        fetch: async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(201, expected);
        }
      }
    );

    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3777/api/v1/sessions",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({ operation_id: operationId, name, cwd })
        }
      }
    ]);
  });

  it("rejects generated or returned identity contradictions before output", async () => {
    let clientCalls = 0;
    for (const createStartOperationId of [
      () => "invalid",
      () => {
        throw new Error("operation-id-private-sentinel");
      }
    ]) {
      const result = await runCli(["start", "--name", name, "--cwd", cwd], {
        env: {},
        createStartOperationId,
        startClient: {
          async start() {
            clientCalls += 1;
            return response();
          }
        }
      });
      expect(result).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-sentinel");
    }
    expect(clientCalls).toBe(0);

    const candidates = [
      response({ operation_id: "op_session_start_cli_other" }),
      response({ session: { ...response().session, name: "other-session" } }),
      response({ session: { ...response().session, cwd: "/tmp/other" } })
    ];
    for (const candidate of candidates) {
      const result = await runCli(["start", "--name", name, "--cwd", cwd], {
        env: {},
        createStartOperationId: () => operationId,
        startClient: { start: async () => candidate }
      });
      expect(result).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(result.stderr).toContain("invalid managed-session data");
    }
  });

  it("escapes terminal controls in selected path output", async () => {
    const controlledCwd = "/tmp/red\u001b[31m\nline\u202eright-to-left";
    const result = await runCli(
      ["start", "--name", name, "--cwd", controlledCwd],
      {
        env: {},
        createStartOperationId: () => operationId,
        startClient: {
          start: async () => response({
            session: { ...response().session, cwd: controlledCwd }
          })
        }
      }
    );
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain(
      "CWD: /tmp/red\\u001b[31m\\nline\\u202eright-to-left"
    );
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u202e");
    expect(result.stdout.split("\n")).not.toContain("line");
  });

  it("preserves one bounded client failure without retry and rejects non-loopback APIs", async () => {
    let clientCalls = 0;
    const failed = await runCli(["start", "--name", name, "--cwd", cwd], {
      env: {},
      createStartOperationId: () => operationId,
      startClient: {
        async start() {
          clientCalls += 1;
          throw clientOperationFailure(
            "runtime_unavailable",
            "The selected runtime is unavailable.",
            true
          );
        }
      }
    });
    expect(failed).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(failed.stderr).toContain("selected runtime is unavailable");
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      [
        "--api-url",
        "https://private-start.example.test",
        "start",
        "--name",
        name,
        "--cwd",
        cwd
      ],
      {
        env: {},
        createStartOperationId: () => operationId,
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(201, response());
        }
      }
    );
    expect(remote).toMatchObject({
      exitCode: cliExitCodes.config,
      stdout: ""
    });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-start.example.test");
    expect(fetchCalls).toBe(0);
  });
});

function response(
  overrides: Readonly<Record<string, unknown>> = {}
): SelectedSessionStartResponse {
  const base = {
    operation_id: operationId,
    session: {
      id: "sess_start_cli_001",
      name,
      codex_thread_id: "thread-start-cli-001",
      cwd,
      runtime_source: "codex_app_server" as const,
      runtime_version: "0.144.0",
      created_at: "2026-07-15T18:00:00.000Z",
      archived_at: null,
      session_state: "active" as const,
      turn_state: "idle" as const,
      attention: "none" as const,
      freshness: "current" as const,
      freshness_reason: null,
      updated_at: "2026-07-15T18:00:00.000Z",
      last_activity_at: "2026-07-15T18:00:00.000Z",
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Managed Codex session ready.",
      last_event_cursor: null
    }
  };
  return selectedSessionStartResponseSchema.parse({ ...base, ...overrides });
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
