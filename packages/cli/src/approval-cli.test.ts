import {
  approvalOperationTargetSchema,
  managedSessionTargetSchema,
  type PendingApproval,
  type PendingApprovalListResponse,
  type PendingApprovalResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  pendingApprovalSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import type {
  HostDeckApprovalClient,
  HostDeckApprovalClientResponseRequest
} from "./approval-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { renderApprovalList, renderApprovalResponse, renderHelp } from "./render.js";
import { type CliRunOptions, runCli } from "./shell.js";

const sessionId = "sess_approval_cli_001";
const threadId = "thread-approval-cli-001";
const requestId = "string:approval-cli-1";
const operationId = "op_approval_cli_0001";

describe("approval CLI command", () => {
  it("parses only exact list and explicitly confirmed decision forms", () => {
    expect(parseCliArgs(["approvals", sessionId])).toEqual({
      command: {
        kind: "approvals",
        session: sessionId,
        request: null,
        decision: null,
        confirm: false,
        json: false
      },
      configFlags: {}
    });
    expect(parseCliArgs(["approvals", sessionId, "--json"]).command).toMatchObject({
      kind: "approvals",
      request: null,
      json: true
    });
    for (const decision of ["approve", "deny"] as const) {
      expect(parseCliArgs(["approvals", sessionId, requestId, decision, "--confirm", "--json"]).command).toEqual({
        kind: "approvals",
        session: sessionId,
        request: requestId,
        decision,
        confirm: true,
        json: true
      });
    }
    for (const args of [
      ["approvals"],
      ["approvals", "--confirm", sessionId],
      ["approvals", sessionId, requestId],
      ["approvals", sessionId, requestId, "accept", "--confirm"],
      ["approvals", sessionId, requestId, "approve"],
      ["approvals", sessionId, requestId, "approve", "--confirm", "--confirm"],
      ["approvals", sessionId, requestId, "approve", "--confirm=true"],
      ["approvals", sessionId, requestId, "approve", "--force"],
      ["approvals", sessionId, requestId, "approve", "--retry"],
      ["approvals", sessionId, requestId, "approve", "--operation-id", operationId],
      ["approvals", sessionId, requestId, "approve", "--thread-id", threadId],
      ["approvals", sessionId, "--", requestId, "approve", "--confirm"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({ code: "malformed_request", exitCode: cliExitCodes.usage })
      );
    }
  });

  it("lists once through the injected client receiverlessly without unrelated ports", async () => {
    let listThis: unknown = "not-called";
    const calls: string[] = [];
    let unrelatedAccesses = 0;
    const approvalClient: HostDeckApprovalClient = {
      list: async function listApprovals(this: void, session) {
        listThis = this;
        calls.push(session);
        return listResponse([]);
      },
      async respond() {
        throw new Error("approval respond must not run during list");
      }
    };
    const options = Object.defineProperties(
      { env: {}, approvalClient },
      {
        client: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        localAdmin: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        compactClient: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        skillsClient: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        })
      }
    ) as CliRunOptions;

    const result = await runCli(["approvals", sessionId], options);
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: `Approvals: ${sessionId}\nThread: ${threadId}\nCount: 0\n\nNo approval requests.\n`,
      stderr: ""
    });
    expect(calls).toEqual([sessionId]);
    expect(listThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("responds once with an internal operation id and renders only terminal finalization", async () => {
    let respondThis: unknown = "not-called";
    const calls: HostDeckApprovalClientResponseRequest[] = [];
    const approvalClient: HostDeckApprovalClient = {
      async list() {
        throw new Error("approval list must not run during response");
      },
      respond: async function respondApproval(this: void, request) {
        respondThis = this;
        calls.push(request);
        return response(request.decision, request.operation_id);
      }
    };
    const result = await runCli(["approvals", sessionId, requestId, "deny", "--confirm"], {
      env: {},
      approvalClient,
      createApprovalOperationId: () => operationId
    });
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: `Approval deny finalized for ${sessionId} (request ${requestId}).\n`,
      stderr: ""
    });
    expect(calls).toEqual([
      {
        session_id: sessionId,
        request_id: requestId,
        operation_id: operationId,
        kind: "approval_response",
        decision: "deny",
        confirm: true
      }
    ]);
    expect(respondThis).toBeUndefined();
    expect(result.stdout).not.toMatch(/accepted|responding|pending/iu);
  });

  it("performs exact loopback GET and POST and emits contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const responses = [listResponse([approval("pending", null)]), response("approve", operationId)];
    const fetch: HttpFetch = async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, responses.shift());
    };
    const listed = await runCli(["approvals", sessionId, "--json"], { env: {}, fetch });
    expect(JSON.parse(listed.stdout)).toEqual(listResponse([approval("pending", null)]));

    const responded = await runCli(["approvals", sessionId, requestId, "approve", "--confirm", "--json"], {
      env: {},
      fetch,
      createApprovalOperationId: () => operationId
    });
    expect(JSON.parse(responded.stdout)).toEqual(response("approve", operationId));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/approvals`,
        init: { method: "GET", headers: { accept: "application/json", "cache-control": "no-store" } }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/approvals/string%3Aapproval-cli-1/respond`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: operationId,
            kind: "approval_response",
            decision: "approve",
            confirm: true
          })
        }
      }
    ]);
  });

  it("renders every approval state and escapes terminal controls in all public details", () => {
    const approvals = [
      approval("pending", null),
      approval("responding", null, "string:responding"),
      approval("approved", "approve", "string:approved"),
      approval("denied", "deny", "string:denied"),
      approval("expired", null, "string:expired"),
      approval("superseded", null, "string:superseded")
    ];
    const first = approvals[0];
    if (first === undefined) throw new Error("Approval rendering fixture is empty.");
    approvals[0] = pendingApprovalSchema.parse({
      ...first,
      action: "run\u001b[31m",
      reason: "reason\u202eprivate"
    });
    const output = renderApprovalList(listResponse(approvals), false);
    for (const state of ["pending", "responding", "approved", "denied", "expired", "superseded"]) {
      expect(output).toContain(`[${state}]`);
    }
    expect(output).toContain("Action: run\\u001b[31m");
    expect(output).toContain("Reason: reason\\u202eprivate");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u202e");
    expect(output).toContain("Risk: elevated");
    expect(output).toContain("Grant: one_time");
    expect(output).toContain("Expires:");
  });

  it("rejects invalid generated ids and contradictory injected-client responses before output", async () => {
    let calls = 0;
    for (const createApprovalOperationId of [
      () => "invalid",
      () => {
        throw new Error("operation id private sentinel");
      }
    ]) {
      const result = await runCli(["approvals", sessionId, requestId, "approve", "--confirm"], {
        env: {},
        createApprovalOperationId,
        approvalClient: {
          async list() {
            return listResponse([]);
          },
          async respond() {
            calls += 1;
            return response("approve", operationId);
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private sentinel");
    }
    expect(calls).toBe(0);

    const candidates = [
      { ...response("approve", operationId), operation_id: "op_approval_cli_other" },
      { ...response("approve", operationId), requested_decision: "deny" },
      { ...response("approve", operationId), approval: approval("responding", null) },
      { ...response("approve", operationId), approval: { ...approval("approved", "approve"), target: approvalTarget("string:other") } }
    ];
    for (const candidate of candidates) {
      const result = await runCli(["approvals", sessionId, requestId, "approve", "--confirm"], {
        env: {},
        createApprovalOperationId: () => operationId,
        approvalClient: {
          async list() {
            return listResponse([]);
          },
          async respond() {
            return candidate as PendingApprovalResponse;
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
    }
  });

  it("preserves one bounded client failure and documents no hidden response controls", async () => {
    let calls = 0;
    const failed = await runCli(["approvals", sessionId], {
      env: {},
      approvalClient: {
        async list() {
          calls += 1;
          throw clientOperationFailure("runtime_unavailable", "Approval runtime is unavailable.", true);
        },
        async respond() {
          throw new Error("not used");
        }
      }
    });
    expect(failed).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(failed.stderr).toContain("Approval runtime is unavailable");
    expect(calls).toBe(1);

    const help = renderHelp();
    expect(help).toContain("codexdeck approvals SESSION_ID [--json]");
    expect(help).toContain("codexdeck approvals SESSION_ID REQUEST_ID approve|deny --confirm [--json]");
    expect(help).not.toMatch(/approvals.*--force|approvals.*--retry|approvals.*--thread|approvals.*--operation/iu);
  });

  it("rejects malformed renderer input and nonterminal response rendering", () => {
    expect(() => renderApprovalList({ ...listResponse([]), extra: true } as never, false)).toThrow();
    expect(() =>
      renderApprovalResponse(
        { ...response("approve", operationId), approval: approval("responding", null) } as never,
        false
      )
    ).toThrow();
  });
});

function unrelatedAccessor(onAccess: () => void): PropertyDescriptor {
  return {
    enumerable: true,
    get() {
      onAccess();
      throw new Error("unrelated approval CLI port was accessed");
    }
  };
}

function managedTarget() {
  return managedSessionTargetSchema.parse({
    type: "managed_session",
    session_id: sessionId,
    codex_thread_id: threadId
  });
}

function approvalTarget(id = requestId) {
  return approvalOperationTargetSchema.parse({
    type: "approval",
    session_id: sessionId,
    codex_thread_id: threadId,
    request_id: id
  });
}

function approval(
  state: PendingApproval["state"],
  decision: PendingApproval["decision"],
  id = requestId
): PendingApproval {
  return pendingApprovalSchema.parse({
    target: approvalTarget(id),
    action: "Run reviewed command",
    scope: "/tmp/approval-cli",
    reason: "Confirmation is required.",
    risk: "elevated",
    grant_scope: "one_time",
    state,
    created_at: "2026-07-16T14:00:00.000Z",
    expires_at: "2026-07-16T14:05:00.000Z",
    decision
  });
}

function listResponse(approvals: PendingApproval[]): PendingApprovalListResponse {
  return pendingApprovalListResponseSchema.parse({ target: managedTarget(), approvals });
}

function response(decision: "approve" | "deny", operation: string): PendingApprovalResponse {
  return pendingApprovalResponseSchema.parse({
    operation_id: operation,
    requested_decision: decision,
    approval: approval(decision === "approve" ? "approved" : "denied", decision)
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
