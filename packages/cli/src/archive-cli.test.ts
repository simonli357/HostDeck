import {
  type SelectedOperationDispatch,
  selectedOperationDispatchSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import type { HostDeckArchiveClient } from "./archive-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { type CliRunOptions, runCli } from "./shell.js";

const operationId = "op_session_archive_cli_001";
const sessionId = "sess_archive_cli_001";

describe("managed-session archive CLI command", () => {
  it("parses one session id and optional JSON while rejecting removed historical stop", () => {
    expect(parseCliArgs(["archive", sessionId])).toEqual({
      command: { kind: "archive", session: sessionId, json: false },
      configFlags: {}
    });
    expect(parseCliArgs(["archive", sessionId, "--json"])).toEqual({
      command: { kind: "archive", session: sessionId, json: true },
      configFlags: {}
    });
    expect(() => parseCliArgs(["stop", sessionId])).toThrow("Unknown command: stop");
    for (const args of [
      ["archive"],
      ["archive", sessionId, "other"],
      ["archive", sessionId, "--operation-id", operationId],
      ["archive", sessionId, "--thread-id", "thread-injected"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("invokes one selected client receiverlessly without touching legacy ports", async () => {
    let clientThis: unknown = "not-called";
    const calls: unknown[] = [];
    let unrelatedAccesses = 0;
    const archiveClient: HostDeckArchiveClient = {
      archive: async function archiveSession(this: void, request) {
        clientThis = this;
        calls.push(request);
        return response();
      }
    };
    const options = Object.defineProperties(
      {
        env: {},
        archiveClient,
        createArchiveOperationId: () => operationId
      },
      {
        client: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("legacy-client-private-sentinel");
          }
        },
        hostLockClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("local-admin-private-sentinel");
          }
        },
        startClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("start-client-private-sentinel");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["archive", sessionId], options);
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: `Archive accepted for ${sessionId}.\n`,
      stderr: ""
    });
    expect(calls).toEqual([
      {
        operation_id: operationId,
        kind: "archive",
        confirm: true,
        session_id: sessionId
      }
    ]);
    expect(clientThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("performs one exact loopback request and renders contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const expected = response();
    const result = await runCli(["archive", sessionId, "--json"], {
      env: {},
      createArchiveOperationId: () => operationId,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(202, expected);
      }
    });

    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/archive`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: operationId,
            kind: "archive",
            confirm: true
          })
        }
      }
    ]);
  });

  it("rejects invalid generated or returned identity before output", async () => {
    let clientCalls = 0;
    for (const createArchiveOperationId of [
      () => "invalid",
      () => {
        throw new Error("operation-id-private-sentinel");
      }
    ]) {
      const result = await runCli(["archive", sessionId], {
        env: {},
        createArchiveOperationId,
        archiveClient: {
          async archive() {
            clientCalls += 1;
            return response();
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-sentinel");
    }
    expect(clientCalls).toBe(0);

    for (const candidate of [
      response({ operation_id: "op_session_archive_cli_other" }),
      response({
        target: {
          type: "managed_session",
          session_id: "sess_archive_cli_other",
          codex_thread_id: "thread-archive-cli-001"
        }
      }),
      { ...response(), kind: "interrupt" }
    ]) {
      const result = await runCli(["archive", sessionId], {
        env: {},
        createArchiveOperationId: () => operationId,
        archiveClient: { archive: async () => candidate as SelectedOperationDispatch }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("invalid managed-session data");
    }
  });

  it("preserves one bounded client failure and rejects non-loopback APIs without fetch", async () => {
    let clientCalls = 0;
    const failed = await runCli(["archive", sessionId], {
      env: {},
      createArchiveOperationId: () => operationId,
      archiveClient: {
        async archive() {
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
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      ["--api-url", "https://private-archive.example.test", "archive", sessionId],
      {
        env: {},
        createArchiveOperationId: () => operationId,
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(202, response());
        }
      }
    );
    expect(remote).toMatchObject({ exitCode: cliExitCodes.config, stdout: "" });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-archive.example.test");
    expect(fetchCalls).toBe(0);
  });

  it("advertises archive as the selected command and hides historical stop from help", async () => {
    const result = await runCli(["help"]);
    expect(result.stdout).toContain("codexdeck archive SESSION_ID [--json]");
    expect(result.stdout).not.toContain("codexdeck stop");
  });
});

function response(
  overrides: Readonly<Record<string, unknown>> = {}
): SelectedOperationDispatch {
  return selectedOperationDispatchSchema.parse({
    operation_id: operationId,
    kind: "archive",
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: "thread-archive-cli-001"
    },
    state: "accepted",
    accepted_at: "2026-07-15T20:00:00.000Z",
    audit_record_id: "audit_session_archive_cli_001",
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
