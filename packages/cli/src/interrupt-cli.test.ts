import { type InterruptResponse, interruptResponseSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import type { HostDeckInterruptClient, HostDeckInterruptClientRequest } from "./interrupt-client.js";
import { parseCliArgs } from "./parser.js";
import { renderHelp, renderInterruptResponse } from "./render.js";
import { type CliRunOptions, runCli } from "./shell.js";

const sessionId = "sess_interrupt_cli_001";
const threadId = "thread-interrupt-cli-001";
const turnId = "turn-interrupt-cli-001";
const operationId = "op_interrupt_cli_0001";

describe("interrupt CLI command", () => {
  it("parses only the exact explicitly confirmed turn form", () => {
    expect(parseCliArgs(["interrupt", sessionId, turnId, "--confirm"])).toEqual({
      command: {
        kind: "interrupt",
        session: sessionId,
        turn: turnId,
        confirm: true,
        json: false
      },
      configFlags: {}
    });
    expect(parseCliArgs(["interrupt", sessionId, turnId, "--confirm", "--json"]).command).toEqual({
      kind: "interrupt",
      session: sessionId,
      turn: turnId,
      confirm: true,
      json: true
    });
    for (const args of [
      ["interrupt"],
      ["interrupt", sessionId],
      ["interrupt", sessionId, turnId],
      ["interrupt", "--confirm", sessionId, turnId],
      ["interrupt", sessionId, turnId, "--confirm", "--confirm"],
      ["interrupt", sessionId, turnId, "--confirm=true"],
      ["interrupt", sessionId, turnId, "--force"],
      ["interrupt", sessionId, turnId, "--retry"],
      ["interrupt", sessionId, turnId, "--timeout", "1000", "--confirm"],
      ["interrupt", sessionId, turnId, "--operation-id", operationId, "--confirm"],
      ["interrupt", sessionId, turnId, "--thread-id", threadId, "--confirm"],
      ["interrupt", sessionId, turnId, "--", "--confirm"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({ code: "malformed_request", exitCode: cliExitCodes.usage })
      );
    }
  });

  it("interrupts once through the injected client receiverlessly with an internal operation id", async () => {
    let interruptThis: unknown = "not-called";
    const calls: HostDeckInterruptClientRequest[] = [];
    let unrelatedAccesses = 0;
    const interruptClient: HostDeckInterruptClient = {
      interrupt: async function interruptExactTurn(this: void, request) {
        interruptThis = this;
        calls.push(request);
        return response(request.operation_id);
      }
    };
    const options = Object.defineProperties(
      { env: {}, interruptClient, createInterruptOperationId: () => operationId },
      {
        client: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        localAdmin: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        approvalClient: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        compactClient: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        })
      }
    ) as CliRunOptions;

    const result = await runCli(["interrupt", sessionId, turnId, "--confirm"], options);
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: `Interrupted turn ${turnId} for ${sessionId}.\n`,
      stderr: ""
    });
    expect(calls).toEqual([
      {
        session_id: sessionId,
        turn_id: turnId,
        operation_id: operationId,
        kind: "interrupt",
        confirm: true
      }
    ]);
    expect(interruptThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
    expect(result.stdout).not.toMatch(/accepted|pending|running/iu);
  });

  it("performs one exact loopback POST and emits contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const fetch: HttpFetch = async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, response(operationId));
    };
    const result = await runCli(["interrupt", sessionId, turnId, "--confirm", "--json"], {
      env: {},
      fetch,
      createInterruptOperationId: () => operationId
    });
    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(JSON.parse(result.stdout)).toEqual(response(operationId));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/turns/${turnId}/interrupt`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({ operation_id: operationId, kind: "interrupt", confirm: true })
        }
      }
    ]);
  });

  it("rejects invalid generated ids and contradictory injected-client responses before output", async () => {
    let calls = 0;
    for (const createInterruptOperationId of [
      () => "invalid",
      () => {
        throw new Error("operation id private sentinel");
      }
    ]) {
      const result = await runCli(["interrupt", sessionId, turnId, "--confirm"], {
        env: {},
        createInterruptOperationId,
        interruptClient: {
          async interrupt() {
            calls += 1;
            return response(operationId);
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private sentinel");
    }
    expect(calls).toBe(0);

    const candidates = [
      { ...response(operationId), operation_id: "op_interrupt_cli_other" },
      { ...response(operationId), target: { ...response(operationId).target, session_id: "sess_interrupt_cli_other" } },
      { ...response(operationId), target: { ...response(operationId).target, turn_id: "turn-interrupt-cli-other" } },
      { ...response(operationId), turn_id: "turn-interrupt-cli-other" },
      { ...response(operationId), state: "accepted" }
    ];
    for (const candidate of candidates) {
      const result = await runCli(["interrupt", sessionId, turnId, "--confirm"], {
        env: {},
        createInterruptOperationId: () => operationId,
        interruptClient: { interrupt: async () => candidate as InterruptResponse }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
    }
  });

  it("renders only strict terminal proof and documents no hidden controls", () => {
    const terminal = response(operationId);
    expect(renderInterruptResponse(terminal, false)).toBe(`Interrupted turn ${turnId} for ${sessionId}.\n`);
    expect(JSON.parse(renderInterruptResponse(terminal, true))).toEqual(terminal);
    for (const candidate of [
      { ...terminal, state: "accepted" },
      { ...terminal, state: "failed", error: { code: "operation_conflict", message: "failed", retryable: false } },
      { ...terminal, turn_id: "turn-interrupt-cli-other" }
    ]) {
      expect(() => renderInterruptResponse(candidate as InterruptResponse, false)).toThrowError(
        expect.objectContaining({ code: "internal_error" })
      );
    }
    const help = renderHelp();
    expect(help).toContain("codexdeck interrupt SESSION_ID TURN_ID --confirm [--json]");
    expect(help).not.toMatch(/interrupt.*(?:force|retry|timeout|operation-id|thread-id)/iu);
  });

  it("preserves one bounded client failure without retry", async () => {
    let calls = 0;
    const result = await runCli(["interrupt", sessionId, turnId, "--confirm"], {
      env: {},
      createInterruptOperationId: () => operationId,
      interruptClient: {
        async interrupt() {
          calls += 1;
          throw clientOperationFailure("runtime_unavailable", "Interrupt runtime is unavailable.", true);
        }
      }
    });
    expect(result).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(result.stderr).toContain("Interrupt runtime is unavailable");
    expect(calls).toBe(1);
  });
});

function response(operation = operationId): InterruptResponse {
  return interruptResponseSchema.parse({
    operation_id: operation,
    kind: "interrupt",
    target: {
      type: "turn",
      session_id: sessionId,
      codex_thread_id: threadId,
      turn_id: turnId
    },
    state: "interrupted",
    updated_at: "2026-07-16T20:00:00.000Z",
    turn_id: turnId,
    error: null
  });
}

function unrelatedAccessor(onAccess: () => void): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: false,
    get() {
      onAccess();
      throw new Error("unrelated private accessor");
    }
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
