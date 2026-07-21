import type { SelectedHostLockStateResponse } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { runCli } from "./shell.js";

const origin = "http://127.0.0.1:3777";

describe("host-lock CLI command", () => {
  it("parses only lock and unlock with optional JSON output", () => {
    expect(parseCliArgs(["lock"]).command).toEqual({
      kind: "lock",
      json: false
    });
    expect(parseCliArgs(["--json", "unlock"]).command).toEqual({
      kind: "unlock",
      json: true
    });
    expect(parseCliArgs(["lock", "--json"]).command).toEqual({
      kind: "lock",
      json: true
    });
    for (const args of [
      ["lock", "--reason", "maintenance"],
      ["lock", "extra"],
      ["unlock", "--confirm"],
      ["unlock", "extra"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("generates one confirmed operation and calls each selected route once", async () => {
    const actions: string[] = [];
    const requests: Array<{
      readonly body: string | undefined;
      readonly method: string;
      readonly url: string;
    }> = [];
    const createHostLockOperationId = (action: "lock" | "unlock") => {
      actions.push(action);
      return `op_host_${action}_cli_0001`;
    };
    const fetch = async (
      url: string,
      init: { readonly body?: string; readonly method: "GET" | "POST" }
    ) => {
      requests.push({ body: init.body, method: init.method, url });
      return jsonResponse(200, lockState(url.endsWith("/lock")));
    };

    const locked = await runCli(["lock"], {
      env: {},
      createHostLockOperationId,
      fetch
    });
    const unlocked = await runCli(["unlock", "--json"], {
      env: {},
      createHostLockOperationId,
      fetch
    });

    expect(locked).toMatchObject({
      exitCode: cliExitCodes.ok,
      stdout: "HostDeck is now locked.\n",
      stderr: ""
    });
    expect(JSON.parse(unlocked.stdout)).toEqual(lockState(false));
    expect(actions).toEqual(["lock", "unlock"]);
    expect(requests).toEqual([
      {
        method: "POST",
        url: `${origin}/api/v1/access/lock`,
        body: JSON.stringify({
          operation_id: "op_host_lock_cli_0001",
          confirmed: true
        })
      },
      {
        method: "POST",
        url: `${origin}/api/v1/access/unlock`,
        body: JSON.stringify({
          operation_id: "op_host_unlock_cli_0001",
          confirmed: true
        })
      }
    ]);
  });

  it("fails before transport for invalid ids or malformed client responses", async () => {
    let calls = 0;
    const invalidId = await runCli(["lock"], {
      env: {},
      createHostLockOperationId: () => "private invalid id",
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, lockState(true));
      }
    });
    expect(invalidId).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(invalidId.stderr).toContain("operation id generation failed");
    expect(invalidId.stderr).not.toContain("private invalid id");
    expect(calls).toBe(0);

    const malformed = await runCli(["unlock"], {
      env: {},
      createHostLockOperationId: () => "op_host_unlock_malformed_001",
      hostLockClient: {
        lock: async () => lockState(true),
        unlock: async () => ({ ...lockState(false), private: true }) as never
      }
    });
    expect(malformed).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(malformed.stderr).toContain("rendering input is invalid");
  });

  it("documents loopback-only lock controls without retired host or reason options", async () => {
    const help = await runCli(["help"]);
    expect(help.stdout).toContain("codexdeck lock [--json]");
    expect(help.stdout).toContain("codexdeck unlock [--json]");
    expect(help.stdout).not.toContain("--host");
    expect(help.stdout).not.toContain("--reason");
    expect(help.stdout).toContain("http://127.0.0.1");
  });
});

function lockState(locked: boolean): SelectedHostLockStateResponse {
  return {
    authentication_state: "local_admin",
    device_id: null,
    permission: "local_admin",
    device_expires_at: null,
    configured_origin: origin,
    network_mode: "loopback",
    transport: "http",
    locked,
    can_read_sessions: true,
    can_write_sessions: !locked,
    can_lock: true,
    can_unlock: true
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
