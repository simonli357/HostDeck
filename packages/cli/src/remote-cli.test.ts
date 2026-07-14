import { remoteIngressPublicStateSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { renderRemoteState } from "./render.js";
import { runCli } from "./shell.js";

const externalOrigin = "https://private-cli.fixture-tailnet.ts.net";
const observedAt = "2026-07-13T22:00:00.000Z";
const readyState = remoteIngressPublicStateSchema.parse({
  generation: 4,
  availability: "ready",
  reason: null,
  external_origin: externalOrigin,
  laptop_action_required: false,
  observed_at: observedAt
});
const unavailableState = remoteIngressPublicStateSchema.parse({
  generation: 5,
  availability: "unavailable",
  reason: "profile_other",
  external_origin: null,
  laptop_action_required: true,
  observed_at: observedAt
});

describe("remote-control CLI command", () => {
  it("parses only status, enable, and disable with optional JSON output", () => {
    expect(parseCliArgs(["remote", "status"]).command).toEqual({
      kind: "remote",
      action: "status",
      json: false
    });
    expect(parseCliArgs(["--json", "remote", "enable"]).command).toEqual({
      kind: "remote",
      action: "enable",
      json: true
    });
    expect(parseCliArgs(["remote", "disable", "--json"]).command).toEqual({
      kind: "remote",
      action: "disable",
      json: true
    });

    for (const args of [
      ["remote"],
      ["remote", "switch"],
      ["remote", "status", "extra"],
      ["remote", "enable", "--force"],
      ["remote", "disable", "again"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("renders only the bounded identity-free remote projection", () => {
    const human = renderRemoteState(readyState, false);
    expect(human).toContain("Remote access: ready");
    expect(human).toContain("Laptop action required: no");
    expect(human).toContain("Generation: 4");
    expect(human).not.toContain(externalOrigin);
    expect(human).not.toMatch(/profile_key|account|node|proof|audit|credential/iu);

    const json = JSON.parse(renderRemoteState(readyState, true)) as Record<
      string,
      unknown
    >;
    expect(json).toEqual({
      generation: 4,
      availability: "ready",
      reason: null,
      laptop_action_required: false,
      observed_at: observedAt
    });
    expect(json).not.toHaveProperty("external_origin");
    expect(() =>
      renderRemoteState({ ...readyState, private_profile: "secret" } as never, false)
    ).toThrow("rendering failed");
  });

  it("runs status against the loopback selected route without creating an operation id", async () => {
    const requests: Array<{ readonly url: string; readonly headers: unknown }> = [];
    let operationIds = 0;
    const result = await runCli(["remote", "status"], {
      env: {},
      createOperationId: () => {
        operationIds += 1;
        return "op_remote_status_must_not_exist";
      },
      fetch: async (url, init) => {
        requests.push({ url, headers: init.headers });
        return jsonResponse(200, readyState);
      }
    });

    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("Remote access: ready");
    expect(result.stdout).not.toContain(externalOrigin);
    expect(operationIds).toBe(0);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3777/api/v1/remote/status",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "x-hostdeck-local-admin": "cli-v1"
        }
      }
    ]);

    const json = await runCli(["remote", "status", "--json"], {
      env: {},
      fetch: async () => jsonResponse(200, readyState)
    });
    expect(JSON.parse(json.stdout)).not.toHaveProperty("external_origin");
  });

  it("creates one fresh validated operation id and confirms each mutation once", async () => {
    const generated: string[] = [];
    const requests: Array<{
      readonly body: string | undefined;
      readonly method: string;
      readonly url: string;
    }> = [];
    const createOperationId = (action: "disable" | "enable") => {
      generated.push(action);
      return `op_remote_cli_${action}_0001`;
    };
    const fetch = async (url: string, init: { readonly body?: string; readonly method: "GET" | "POST" }) => {
      requests.push({ body: init.body, method: init.method, url });
      return jsonResponse(200, unavailableState);
    };

    const enabled = await runCli(["remote", "enable"], {
      env: {},
      createOperationId,
      fetch
    });
    const disabled = await runCli(["remote", "disable", "--json"], {
      env: {},
      createOperationId,
      fetch
    });

    expect(enabled.exitCode).toBe(cliExitCodes.ok);
    expect(enabled.stdout).toContain("Remote access: unavailable");
    expect(disabled.exitCode).toBe(cliExitCodes.ok);
    expect(JSON.parse(disabled.stdout)).toMatchObject({
      availability: "unavailable",
      reason: "profile_other"
    });
    expect(generated).toEqual(["enable", "disable"]);
    expect(requests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:3777/api/v1/remote/enable",
        body: JSON.stringify({
          operation_id: "op_remote_cli_enable_0001",
          confirmed: true
        })
      },
      {
        method: "POST",
        url: "http://127.0.0.1:3777/api/v1/remote/disable",
        body: JSON.stringify({
          operation_id: "op_remote_cli_disable_0001",
          confirmed: true
        })
      }
    ]);
  });

  it("does not call the API when operation-id generation or loopback policy fails", async () => {
    let calls = 0;
    const invalidId = await runCli(["remote", "enable"], {
      env: {},
      createOperationId: () => "private invalid operation id",
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, readyState);
      }
    });
    expect(invalidId).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(invalidId.stderr).toContain("operation id generation failed");
    expect(invalidId.stderr).not.toContain("private invalid operation id");

    const nonLoopback = await runCli(
      [
        "--api-url",
        "https://private-cli.fixture-tailnet.ts.net",
        "remote",
        "status"
      ],
      {
        env: {},
        fetch: async () => {
          calls += 1;
          return jsonResponse(200, readyState);
        }
      }
    );
    expect(nonLoopback).toMatchObject({
      exitCode: cliExitCodes.config,
      stdout: ""
    });
    expect(nonLoopback.stderr).toContain("direct loopback");
    expect(nonLoopback.stderr).not.toContain(externalOrigin);
    expect(calls).toBe(0);
  });

  it("sanitizes one uncertain API failure and never retries it", async () => {
    let calls = 0;
    const result = await runCli(["remote", "disable"], {
      env: {},
      createOperationId: () => "op_remote_cli_uncertain_0001",
      fetch: async () => {
        calls += 1;
        return jsonResponse(503, {
          error: {
            code: "runtime_unavailable",
            message: "private profile, DNS, account, node, and command output",
            retryable: true
          }
        });
      }
    });

    expect(result).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(result.stderr).toContain("Remote control client is unavailable.");
    expect(result.stderr).not.toContain("private profile");
    expect(result.stderr).not.toContain(externalOrigin);
    expect(calls).toBe(1);
  });

  it("includes the nested commands in help and rejects malformed input before fetch", async () => {
    const help = await runCli(["help"]);
    expect(help.stdout).toContain(
      "codexdeck remote status|enable|disable [--json]"
    );

    let calls = 0;
    for (const args of [
      ["remote"],
      ["remote", "switch"],
      ["remote", "enable", "again"]
    ]) {
      const result = await runCli(args, {
        env: {},
        fetch: async () => {
          calls += 1;
          return jsonResponse(200, readyState);
        }
      });
      expect(result.exitCode, args.join(" ")).toBe(cliExitCodes.usage);
    }
    expect(calls).toBe(0);
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
