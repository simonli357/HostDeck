import {
  type NativeSessionAdoptResponse,
  type NativeSessionDiscoveryResponse,
  type NativeSessionUnmanageResponse,
  nativeSessionAdoptRequestSchema,
  nativeSessionAdoptResponseSchema,
  nativeSessionDiscoveryResponseSchema,
  nativeSessionUnmanageRequestSchema,
  nativeSessionUnmanageResponseSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import {
  createHostDeckNativeSessionClient,
  type HostDeckNativeSessionClient
} from "./native-session-client.js";
import { parseCliArgs } from "./parser.js";
import { renderHelp } from "./render.js";
import { runCli } from "./shell.js";

const threadId = "019c6ef5-3ad7-7b20-b0a7-6c138cd2a63e";
const sessionId = "sess_native_cli_001";
const name = "existing-work";
const cwd = "/tmp/native-cli-project";
const fixedTime = "2026-08-12T14:00:00.000Z";
const adoptOperationId = "op_native_adopt_cli_001";
const unmanageOperationId = "op_native_unmanage_cli_001";

describe("native Codex session CLI commands", () => {
  it("parses only the reviewed bounded command grammar", () => {
    expect(parseCliArgs(["discover"])).toEqual({
      command: { kind: "discover", limit: null, json: false },
      configFlags: {}
    });
    expect(parseCliArgs(["discover", "--limit=25", "--json"]).command).toEqual({
      kind: "discover",
      limit: 25,
      json: true
    });
    expect(
      parseCliArgs([
        "adopt",
        threadId,
        "--name",
        name,
        "--confirm-handoff",
        "--json"
      ]).command
    ).toEqual({
      kind: "adopt",
      thread: threadId,
      name,
      confirmHandoff: true,
      json: true
    });
    expect(parseCliArgs(["unmanage", sessionId, "--confirm"]).command).toEqual({
      kind: "unmanage",
      session: sessionId,
      confirm: true,
      json: false
    });

    for (const args of [
      ["discover", "--limit", "0"],
      ["discover", "--limit", "101"],
      ["discover", "extra"],
      ["adopt", threadId, "--name", name],
      ["adopt", "invalid thread", "--name", name, "--confirm-handoff"],
      ["adopt", threadId, "--name", "invalid name", "--confirm-handoff"],
      ["adopt", threadId, "--name", name, "--confirm-handoff", "--confirm-handoff"],
      ["unmanage", sessionId],
      ["unmanage", "invalid", "--confirm"],
      ["unmanage", sessionId, "--force"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("documents the exact three commands and explicit destructive confirmations", () => {
    const help = renderHelp();
    expect(help).toContain("codexdeck discover [--limit N] [--json]");
    expect(help).toContain(
      "codexdeck adopt THREAD_ID --name NAME --confirm-handoff [--json]"
    );
    expect(help).toContain(
      "codexdeck unmanage SESSION_ID --confirm [--json]"
    );
  });

  it("dispatches each command receiverlessly exactly once and renders correlated output", async () => {
    const calls: unknown[] = [];
    const receivers: unknown[] = [];
    const client: HostDeckNativeSessionClient = {
      adopt: async function adopt(this: void, request) {
        receivers.push(this);
        calls.push(["adopt", request]);
        return adoptionResponse();
      },
      discover: async function discover(this: void, request) {
        receivers.push(this);
        calls.push(["discover", request]);
        return discoveryResponse(7);
      },
      unmanage: async function unmanage(this: void, request) {
        receivers.push(this);
        calls.push(["unmanage", request]);
        return unmanageResponse();
      }
    };
    const options = {
      env: {},
      nativeSessionClient: client,
      createNativeAdoptOperationId: () => adoptOperationId,
      createNativeUnmanageOperationId: () => unmanageOperationId
    };

    const discovered = await runCli(["discover", "--limit", "7"], options);
    const adopted = await runCli(
      ["adopt", threadId, "--name", name, "--confirm-handoff"],
      options
    );
    const unmanaged = await runCli(
      ["unmanage", sessionId, "--confirm", "--json"],
      options
    );

    expect(discovered).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(discovered.stdout).toContain(`Thread: ${threadId}`);
    expect(adopted.stdout).toContain(`Adopted session: ${name}`);
    expect(adopted.stdout).toContain(`ID: ${sessionId}`);
    expect(JSON.parse(unmanaged.stdout)).toEqual(unmanageResponse());
    expect(calls).toEqual([
      ["discover", { limit: 7 }],
      [
        "adopt",
        {
          operation_id: adoptOperationId,
          thread_id: threadId,
          name,
          confirm_handoff: true
        }
      ],
      [
        "unmanage",
        {
          session_id: sessionId,
          operation_id: unmanageOperationId,
          confirm: true
        }
      ]
    ]);
    expect(receivers).toEqual([undefined, undefined, undefined]);
  });

  it("performs one exact local-admin loopback request per invocation", async () => {
    const requests: unknown[] = [];
    const responses = [discoveryResponse(3), adoptionResponse(), unmanageResponse()];
    const statuses = [200, 201, 200];
    let index = 0;
    const fetch: HttpFetch = async (url, init) => {
      requests.push({ url, init });
      const response = responses[index];
      const status = statuses[index];
      index += 1;
      if (response === undefined || status === undefined) throw new Error("unexpected request");
      return jsonResponse(status, response);
    };
    const options = {
      env: {},
      fetch,
      createNativeAdoptOperationId: () => adoptOperationId,
      createNativeUnmanageOperationId: () => unmanageOperationId
    };

    await runCli(["discover", "--limit", "3"], options);
    await runCli(
      ["adopt", threadId, "--name", name, "--confirm-handoff"],
      options
    );
    await runCli(["unmanage", sessionId, "--confirm"], options);

    const headers = {
      accept: "application/json",
      "cache-control": "no-store",
      [hostDeckLocalAdminRequestHeaderName]: hostDeckLocalAdminRequestHeaderValue
    };
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3777/api/v1/native-sessions?limit=3",
        init: { method: "GET", headers }
      },
      {
        url: "http://127.0.0.1:3777/api/v1/native-sessions",
        init: {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            operation_id: adoptOperationId,
            thread_id: threadId,
            name,
            confirm_handoff: true
          })
        }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/unmanage`,
        init: {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            operation_id: unmanageOperationId,
            confirm: true
          })
        }
      }
    ]);
  });

  it("rejects hostile client options and malformed inputs before transport", async () => {
    let accessorCalls = 0;
    const optionAccessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return new URL("http://127.0.0.1:3777");
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: "http://127.0.0.1:3777" },
      { baseUrl: new URL("http://127.0.0.1:3777"), fetch: null },
      { baseUrl: new URL("http://127.0.0.1:3777"), extra: true },
      optionAccessor
    ]) {
      expect(() =>
        createHostDeckNativeSessionClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);

    let calls = 0;
    const client = createHostDeckNativeSessionClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, discoveryResponse(50));
      }
    });
    const inputAccessor = Object.defineProperty({}, "limit", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return null;
      }
    });
    for (const candidate of [
      null,
      {},
      { limit: 0 },
      { limit: 101 },
      { limit: null, extra: true },
      inputAccessor
    ]) {
      await expect(client.discover(candidate as never)).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck native-session discovery input is invalid."
      });
    }
    await expect(
      client.adopt({
        operation_id: adoptOperationId,
        thread_id: threadId,
        name,
        confirm_handoff: false
      } as never)
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "HostDeck native-session adoption input is invalid."
    });
    await expect(
      client.unmanage({
        session_id: sessionId,
        operation_id: unmanageOperationId,
        confirm: true,
        delete_history: true
      } as never)
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "HostDeck native-session unmanage input is invalid."
    });
    expect(accessorCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects malformed, uncorrelated, and wrong-status success responses", async () => {
    const cases: ReadonlyArray<{
      readonly invoke: (client: HostDeckNativeSessionClient) => Promise<unknown>;
      readonly payload: unknown;
      readonly status: number;
    }> = [
      {
        invoke: (client) => client.discover({ limit: 3 }),
        payload: discoveryResponse(2),
        status: 200
      },
      {
        invoke: (client) =>
          client.adopt(nativeSessionAdoptRequestSchema.parse({
            operation_id: adoptOperationId,
            thread_id: threadId,
            name,
            confirm_handoff: true
          })),
        payload: adoptionResponse({ operation_id: "op_native_adopt_other_001" }),
        status: 201
      },
      {
        invoke: (client) =>
          client.unmanage({
            session_id: sessionId,
            ...nativeSessionUnmanageRequestSchema.parse({
              operation_id: unmanageOperationId,
              confirm: true
            })
          }),
        payload: { ...unmanageResponse(), private_path: "/private" },
        status: 200
      },
      {
        invoke: (client) => client.discover({ limit: null }),
        payload: discoveryResponse(50),
        status: 201
      }
    ];
    let calls = 0;
    for (const current of cases) {
      const client = createHostDeckNativeSessionClient({
        baseUrl: new URL("http://127.0.0.1:3777"),
        fetch: async () => {
          calls += 1;
          return jsonResponse(current.status, current.payload);
        }
      });
      await expect(current.invoke(client)).rejects.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining("invalid or uncorrelated")
      });
    }
    expect(calls).toBe(cases.length);
  });

  it("rejects generated and returned identity contradictions before output", async () => {
    let calls = 0;
    for (const createNativeAdoptOperationId of [
      () => "invalid",
      () => {
        throw new Error("private-operation-sentinel");
      }
    ]) {
      const result = await runCli(
        ["adopt", threadId, "--name", name, "--confirm-handoff"],
        {
          env: {},
          createNativeAdoptOperationId,
          nativeSessionClient: {
            adopt: async () => {
              calls += 1;
              return adoptionResponse();
            },
            discover: async () => discoveryResponse(50),
            unmanage: async () => unmanageResponse()
          }
        }
      );
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-operation-sentinel");
    }
    expect(calls).toBe(0);

    const contradictory = adoptionResponse({
      operation_id: "op_native_adopt_other_001"
    });
    const result = await runCli(
      ["adopt", threadId, "--name", name, "--confirm-handoff"],
      {
        env: {},
        createNativeAdoptOperationId: () => adoptOperationId,
        nativeSessionClient: {
          adopt: async () => contradictory,
          discover: async () => discoveryResponse(50),
          unmanage: async () => unmanageResponse()
        }
      }
    );
    expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
    expect(result.stderr).toContain("invalid adoption data");
  });

  it("preserves one recovery failure without retry and keeps private API detail out of output", async () => {
    let calls = 0;
    const result = await runCli(
      ["adopt", threadId, "--name", name, "--confirm-handoff"],
      {
        env: {},
        createNativeAdoptOperationId: () => adoptOperationId,
        nativeSessionClient: {
          adopt: async () => {
            calls += 1;
            throw clientOperationFailure(
              "stale_session",
              "The native session was adopted but activation requires reconciliation. Do not retry adoption."
            );
          },
          discover: async () => discoveryResponse(50),
          unmanage: async () => unmanageResponse()
        }
      }
    );
    expect(result).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(result.stderr).toContain("Do not retry adoption");
    expect(calls).toBe(1);

    const sanitized = await runCli(["unmanage", sessionId, "--confirm"], {
      env: {},
      createNativeUnmanageOperationId: () => unmanageOperationId,
      fetch: async () =>
        jsonResponse(500, {
          error: {
            code: "storage_error",
            message: "private database path and token",
            retryable: false,
            details: { private: "private" }
          }
        })
    });
    expect(sanitized.stderr).toContain("Native session storage is unavailable");
    expect(sanitized.stderr).not.toMatch(/private|token/iu);
  });

  it("escapes terminal controls from native paths and identifiers", async () => {
    const controlledCwd = "/tmp/red\u001b[31m\nline\u202eright-to-left";
    const result = await runCli(["discover"], {
      env: {},
      nativeSessionClient: {
        adopt: async () => adoptionResponse(),
        discover: async () =>
          discoveryResponse(50, {
            threads: [
              {
                ...discoveryResponse(50).threads[0],
                cwd: controlledCwd
              }
            ]
          }),
        unmanage: async () => unmanageResponse()
      }
    });
    expect(result.stdout).toContain(
      "CWD: /tmp/red\\u001b[31m\\nline\\u202eright-to-left"
    );
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u202e");
  });
});

function discoveryResponse(
  limit: number,
  overrides: Readonly<Record<string, unknown>> = {}
): NativeSessionDiscoveryResponse {
  return nativeSessionDiscoveryResponseSchema.parse({
    limit,
    threads: [
      {
        thread_id: threadId,
        cwd,
        source: "cli",
        runtime_version: "0.147.0",
        created_at: fixedTime,
        updated_at: fixedTime,
        status: "idle",
        archived: false,
        ephemeral: false,
        parent_thread_id: null,
        forked_from_id: null,
        history_mode: "paginated"
      }
    ],
    truncated: false,
    ...overrides
  });
}

function adoptionResponse(
  overrides: Readonly<Record<string, unknown>> = {}
): NativeSessionAdoptResponse {
  return nativeSessionAdoptResponseSchema.parse({
    operation_id: adoptOperationId,
    session: {
      id: sessionId,
      name,
      codex_thread_id: threadId,
      cwd,
      runtime_source: "codex_app_server",
      runtime_version: "0.147.0",
      created_at: fixedTime,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: fixedTime,
      last_activity_at: fixedTime,
      branch: "main",
      model: null,
      settings: null,
      goal: null,
      recent_summary: "Adopted native Codex session ready.",
      last_event_cursor: 1
    },
    ...overrides
  });
}

function unmanageResponse(
  overrides: Readonly<Record<string, unknown>> = {}
): NativeSessionUnmanageResponse {
  return nativeSessionUnmanageResponseSchema.parse({
    operation_id: unmanageOperationId,
    session_id: sessionId,
    codex_thread_id: threadId,
    unmanaged_at: fixedTime,
    ...overrides
  });
}

function jsonResponse(status: number, payload: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}
