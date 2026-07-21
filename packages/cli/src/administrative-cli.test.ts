import {
  clientOperationIdSchema,
  type SelectedDeviceRevokeResponse,
  type SelectedHostStatusResponse,
  type SelectedSessionListResponse,
  selectedDeviceRevokeResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedSessionListResponseSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import {
  renderDeviceRevoke,
  renderHostStatus,
  renderSessionList
} from "./render.js";
import { runCli } from "./shell.js";

const origin = "http://127.0.0.1:3777";
const timestamp = "2026-07-20T20:00:00.000Z";
const laterTimestamp = "2026-07-20T20:01:00.000Z";
const externalOrigin = "https://private-admin-cli.fixture-tailnet.ts.net";
const deviceId = "client_admin_cli_001";
const operationId = clientOperationIdSchema.parse(
  "op_device_revoke_admin_cli_001"
);
const privateCwd = "/private/workspaces/admin-cli";
const privateThread = "thread-private-admin-cli";
const privateObjective = "Private objective must stay out of human output.";
const privateSummary = "Private summary must stay out of human output.";

describe("required administrative CLI operations", () => {
  it("dispatches status, list, and confirmed revoke exactly once through selected routes", async () => {
    const requests: Array<{
      readonly body: string | undefined;
      readonly headers: Readonly<Record<string, string>>;
      readonly method: string;
      readonly url: string;
    }> = [];
    let operationIds = 0;
    const fetch = async (
      url: string,
      init: {
        readonly body?: string;
        readonly headers: Readonly<Record<string, string>>;
        readonly method: "GET" | "POST";
      }
    ) => {
      requests.push({
        body: init.body,
        headers: init.headers,
        method: init.method,
        url
      });
      if (url.endsWith("/api/v1/host/status")) {
        return jsonResponse(200, hostStatus());
      }
      if (url.includes("/api/v1/sessions")) {
        return jsonResponse(200, sessionList());
      }
      return jsonResponse(200, deviceRevoke());
    };

    const status = await runCli(["status"], { env: {}, fetch });
    const list = await runCli(["list", "--limit=1"], { env: {}, fetch });
    const revoke = await runCli(
      ["revoke", deviceId, "--confirm", "--json"],
      {
        env: {},
        fetch,
        createDeviceRevokeOperationId: () => {
          operationIds += 1;
          return operationId;
        }
      }
    );

    expect(status).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(status.stdout).toContain("Local host: ready");
    expect(status.stdout).not.toContain(externalOrigin);
    expect(list).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(list.stdout).toContain("Managed sessions: 1");
    expect(list.stdout).not.toContain(privateCwd);
    expect(revoke).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(revoke.stdout)).toEqual(deviceRevoke());
    expect(operationIds).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({
      body: undefined,
      headers: {
        accept: "application/json",
        "cache-control": "no-store"
      },
      method: "GET",
      url: `${origin}/api/v1/host/status`
    });
    expect(requests[1]).toEqual({
      body: undefined,
      headers: {
        accept: "application/json",
        "cache-control": "no-store"
      },
      method: "GET",
      url: `${origin}/api/v1/sessions?limit=1`
    });
    expect(requests[2]).toEqual({
      body: JSON.stringify({ operation_id: operationId, confirmed: true }),
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json",
        [hostDeckLocalAdminRequestHeaderName]:
          hostDeckLocalAdminRequestHeaderValue
      },
      method: "POST",
      url: `${origin}/api/v1/access/devices/${deviceId}/revoke`
    });
  });

  it("renders bounded human projections and intentional machine contracts", () => {
    const statusHuman = renderHostStatus(hostStatus(), false);
    const statusJson = JSON.parse(
      renderHostStatus(hostStatus(), true)
    ) as Record<string, unknown>;
    expect(statusHuman).toContain("Remote access: ready");
    expect(statusHuman).toContain(
      "Status request write causes: read_only_access"
    );
    expect(statusHuman).not.toContain(externalOrigin);
    expect(JSON.stringify(statusJson)).not.toContain(externalOrigin);
    expect(statusJson).not.toHaveProperty("remote.external_origin");

    const listHuman = renderSessionList(sessionList(), false);
    expect(listHuman).toContain("admin-cli");
    expect(listHuman).toContain("[needs_input]");
    for (const privateValue of [
      privateCwd,
      privateThread,
      privateObjective,
      privateSummary
    ]) {
      expect(listHuman).not.toContain(privateValue);
    }
    const listJson = JSON.parse(renderSessionList(sessionList(), true));
    expect(listJson.sessions[0].session.cwd).toBe(privateCwd);
    expect(listJson.sessions[0].session.codex_thread_id).toBe(privateThread);

    const revokeHuman = renderDeviceRevoke(deviceRevoke(), false);
    expect(revokeHuman).toContain(`Revoked device: ${deviceId}`);
    expect(revokeHuman).toContain("Authority invalidated: yes");
    expect(JSON.parse(renderDeviceRevoke(deviceRevoke(), true))).toEqual(
      deviceRevoke()
    );

    expect(() =>
      renderHostStatus({ ...hostStatus(), private_profile: "private" } as never, false)
    ).toThrow("rendering input is invalid");
    expect(() =>
      renderSessionList({ ...sessionList(), bearer: "private" } as never, false)
    ).toThrow("rendering input is invalid");
    expect(() =>
      renderDeviceRevoke({ ...deviceRevoke(), token_hash: "private" } as never, false)
    ).toThrow("rendering input is invalid");
  });

  it("revalidates injected client results and sanitizes thrown implementation detail", async () => {
    const calls = { status: 0, list: 0, revoke: 0 };
    const status = await runCli(["status"], {
      env: {},
      hostStatusClient: {
        read: async () => {
          calls.status += 1;
          return hostStatus("local_admin");
        }
      }
    });
    const list = await runCli(["list", "--limit=1"], {
      env: {},
      sessionListClient: {
        list: async () => {
          calls.list += 1;
          return sessionList("local_admin");
        }
      }
    });
    const revoke = await runCli(
      ["revoke", deviceId, "--confirm"],
      {
        env: {},
        createDeviceRevokeOperationId: () => operationId,
        deviceRevokeClient: {
          revoke: async () => {
            calls.revoke += 1;
            return deviceRevoke({
              operation_id: clientOperationIdSchema.parse(
                "op_device_revoke_wrong_admin_cli_001"
              )
            });
          }
        }
      }
    );
    for (const result of [status, list, revoke]) {
      expect(result).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(result.stderr).toContain("returned invalid data");
    }
    expect(calls).toEqual({ status: 1, list: 1, revoke: 1 });

    const thrown = await runCli(["status"], {
      env: {},
      hostStatusClient: {
        read: async () => {
          throw new Error(
            "private profile, account, credential, cwd, prompt, and thread"
          );
        }
      }
    });
    expect(thrown).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(thrown.stderr).toContain("failed unexpectedly");
    expect(thrown.stderr).not.toContain("private profile");
  });

  it("fails before destructive dispatch for invalid operation ids", async () => {
    let calls = 0;
    const result = await runCli(
      ["revoke", deviceId, "--confirm"],
      {
        env: {},
        createDeviceRevokeOperationId: () => "private invalid operation id",
        deviceRevokeClient: {
          revoke: async () => {
            calls += 1;
            return deviceRevoke();
          }
        }
      }
    );
    expect(result).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(result.stderr).toContain("operation id generation failed");
    expect(result.stderr).not.toContain("private invalid operation id");
    expect(calls).toBe(0);
  });
});

function hostStatus(
  mode: "local_admin" | "loopback_read" = "loopback_read"
): SelectedHostStatusResponse {
  const readOnly = mode === "loopback_read";
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 9,
      state: "ready",
      readiness: "ready",
      mutation_admission: "open",
      updated_at: timestamp,
      components: selectedHostLocalHealthComponents.map((component) => ({
        component,
        state: "ready",
        checked_at: timestamp,
        causes: []
      }))
    },
    remote: {
      generation: 4,
      state_generation: 4,
      availability: "ready",
      cause: null,
      external_origin: externalOrigin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode,
      network_mode: "loopback",
      transport: "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: !readOnly,
        causes: readOnly ? ["read_only_access"] : []
      }
    }
  });
}

function sessionList(
  mode: "local_admin" | "loopback_read" = "loopback_read"
): SelectedSessionListResponse {
  return selectedSessionListResponseSchema.parse({
    access: {
      mode,
      network_mode: "loopback",
      transport: "http"
    },
    sessions: [
      {
        event_window: {
          state: "empty",
          retained_event_count: 0,
          earliest_retained_cursor: null,
          boundary_cursor: null
        },
        session: {
          archived_at: null,
          attention: "needs_input",
          branch: "main",
          codex_thread_id: privateThread,
          created_at: timestamp,
          cwd: privateCwd,
          freshness: "current",
          freshness_reason: null,
          goal: { objective: privateObjective, state: "active" },
          id: "sess_admin_cli_001",
          last_activity_at: laterTimestamp,
          last_event_cursor: null,
          model: "gpt-5.5-codex",
          name: "admin-cli",
          recent_summary: privateSummary,
          runtime_source: "codex_app_server",
          runtime_version: "0.144.0",
          session_state: "active",
          settings: {
            collaboration_mode: "default",
            observed_at: timestamp,
            reasoning_effort: "high",
            runtime_model: "gpt-5.5-codex"
          },
          turn_state: "waiting_for_input",
          updated_at: laterTimestamp
        }
      }
    ],
    next_cursor: null,
    has_more: false
  });
}

function deviceRevoke(
  overrides: Partial<SelectedDeviceRevokeResponse> = {}
): SelectedDeviceRevokeResponse {
  return selectedDeviceRevokeResponseSchema.parse({
    operation_id: operationId,
    device_id: deviceId,
    revoked_at: laterTimestamp,
    authority_invalidated: true,
    self_revoked: false,
    ...overrides
  });
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
