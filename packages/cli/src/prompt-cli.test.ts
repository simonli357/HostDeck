import {
  type PromptDispatchResponse,
  promptDispatchResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import type { HostDeckPromptClient } from "./prompt-client.js";
import { type CliRunOptions, runCli } from "./shell.js";

const operationId = "op_prompt_cli_001";
const sessionId = "sess_prompt_cli_001";
const privatePrompt = "PROMPT_CLI_PRIVATE_SENTINEL continue carefully";

describe("managed-session prompt CLI command", () => {
  it("parses one exact session id, joined text, and optional JSON", () => {
    expect(parseCliArgs(["send", sessionId, "continue", "carefully"])).toEqual({
      command: {
        kind: "send",
        session: sessionId,
        text: "continue carefully",
        json: false
      },
      configFlags: {}
    });
    expect(parseCliArgs(["send", sessionId, "continue", "--json"])).toEqual({
      command: {
        kind: "send",
        session: sessionId,
        text: "continue",
        json: true
      },
      configFlags: {}
    });
    expect(parseCliArgs(["send", sessionId, "--", "--json"])).toEqual({
      command: {
        kind: "send",
        session: sessionId,
        text: "--json",
        json: false
      },
      configFlags: {}
    });
    for (const args of [["send"], ["send", sessionId]]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("invokes one selected client receiverlessly without touching legacy or storage ports", async () => {
    let clientThis: unknown = "not-called";
    const calls: unknown[] = [];
    let unrelatedAccesses = 0;
    const promptClient: HostDeckPromptClient = {
      send: async function sendPrompt(this: void, request) {
        clientThis = this;
        calls.push(request);
        return response();
      }
    };
    const options = Object.defineProperties(
      {
        env: {},
        promptClient,
        createPromptOperationId: () => operationId
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
        archiveClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("archive-client-private-sentinel");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["send", sessionId, privatePrompt], options);
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: `Prompt start accepted for ${sessionId} (turn turn-prompt-cli-001).\n`,
      stderr: ""
    });
    expect(result.stdout).not.toContain(privatePrompt);
    expect(calls).toEqual([
      {
        operation_id: operationId,
        kind: "prompt",
        text: privatePrompt,
        session_id: sessionId
      }
    ]);
    expect(clientThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("performs one exact loopback request and renders contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const expected = response({ action: "steer" });
    const result = await runCli(
      ["send", sessionId, privatePrompt, "--json"],
      {
        env: {},
        createPromptOperationId: () => operationId,
        fetch: async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(202, expected);
        }
      }
    );

    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/prompts`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: operationId,
            kind: "prompt",
            text: privatePrompt
          })
        }
      }
    ]);
  });

  it("rejects invalid generated identity and invalid text before client access", async () => {
    let clientCalls = 0;
    for (const createPromptOperationId of [
      () => "invalid",
      () => {
        throw new Error("operation-id-private-sentinel");
      }
    ]) {
      const result = await runCli(["send", sessionId, privatePrompt], {
        env: {},
        createPromptOperationId,
        promptClient: {
          async send() {
            clientCalls += 1;
            return response();
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-sentinel");
    }
    const blank = await runCli(["send", sessionId, "   "], {
      env: {},
      createPromptOperationId: () => operationId,
      promptClient: {
        async send() {
          clientCalls += 1;
          return response();
        }
      }
    });
    expect(blank).toMatchObject({ exitCode: cliExitCodes.usage, stdout: "" });
    expect(blank.stderr).toContain("non-empty prompt text");
    expect(clientCalls).toBe(0);
  });

  it("rejects cross-operation and cross-session client results before output", async () => {
    for (const candidate of [
      response({ operation_id: "op_prompt_cli_other" }),
      response({
        target: {
          type: "managed_session",
          session_id: "sess_prompt_cli_other",
          codex_thread_id: "thread-prompt-cli-001"
        }
      }),
      { ...response(), kind: "model" }
    ]) {
      const result = await runCli(["send", sessionId, privatePrompt], {
        env: {},
        createPromptOperationId: () => operationId,
        promptClient: { send: async () => candidate as PromptDispatchResponse }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("invalid managed-session data");
      expect(result.stderr).not.toContain(privatePrompt);
    }
  });

  it("preserves one bounded failure and rejects non-loopback APIs before fetch", async () => {
    let clientCalls = 0;
    const failed = await runCli(["send", sessionId, privatePrompt], {
      env: {},
      createPromptOperationId: () => operationId,
      promptClient: {
        async send() {
          clientCalls += 1;
          throw clientOperationFailure(
            "runtime_unavailable",
            "The selected runtime is unavailable.",
            true
          );
        }
      }
    });
    expect(failed).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(failed.stderr).toContain("selected runtime is unavailable");
    expect(failed.stderr).not.toContain(privatePrompt);
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      ["--api-url", "https://private-prompt.example.test", "send", sessionId, privatePrompt],
      {
        env: {},
        createPromptOperationId: () => operationId,
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(202, response());
        }
      }
    );
    expect(remote).toMatchObject({ exitCode: cliExitCodes.config, stdout: "" });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-prompt.example.test");
    expect(remote.stderr).not.toContain(privatePrompt);
    expect(fetchCalls).toBe(0);
  });

  it("advertises only the selected prompt syntax", async () => {
    const result = await runCli(["help"]);
    expect(result.stdout).toContain(
      "codexdeck send SESSION_ID TEXT... [--json]"
    );
    expect(result.stdout).not.toContain("codexdeck send SESSION TEXT...");
  });
});

function response(
  overrides: Readonly<Record<string, unknown>> = {}
): PromptDispatchResponse {
  return promptDispatchResponseSchema.parse({
    operation_id: operationId,
    kind: "prompt",
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: "thread-prompt-cli-001"
    },
    state: "accepted",
    accepted_at: "2026-07-15T20:00:00.000Z",
    audit_record_id: "audit_prompt_cli_001",
    turn_id: "turn-prompt-cli-001",
    action: "start",
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
