import {
  approvalOperationTargetSchema,
  approvalResponseRequestSchema,
  managedSessionTargetSchema,
  type PendingApproval,
  type PendingApprovalListResponse,
  type PendingApprovalResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  pendingApprovalSchema,
  runtimeRequestIdSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import {
  createHostDeckApprovalClient,
  type HostDeckApprovalClientResponseRequest
} from "./approval-client.js";

const baseUrl = new URL("http://127.0.0.1:3777");
const sessionId = "sess_approval_client_001";
const otherSessionId = "sess_approval_client_002";
const threadId = "thread-approval-client-001";
const requestId = "string:approval-client-1";
const operationId = "op_approval_client_0001";
const request: HostDeckApprovalClientResponseRequest = {
  session_id: sessionIdSchema.parse(sessionId),
  request_id: runtimeRequestIdSchema.parse(requestId),
  ...approvalResponseRequestSchema.parse({
    operation_id: operationId,
    kind: "approval_response",
    decision: "approve",
    confirm: true
  })
};

describe("approval CLI client", () => {
  it("snapshots exact accessor-free loopback options and receiverless fetch", async () => {
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = function fetchApprovals(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, listResponse([])));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckApprovalClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated fetch private sentinel");
    };
    mutableOptions.fetch = fetch;

    const response = await client.list(sessionId);
    expect(requests).toEqual([`http://127.0.0.1:3777/api/v1/sessions/${sessionId}/approvals`]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.target)).toBe(true);
    expect(Object.isFrozen(response.approvals)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("must not run");
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: new URL(baseUrl), extra: true },
      { baseUrl: "http://127.0.0.1:3777" },
      { baseUrl: new URL(baseUrl), fetch: null },
      Object.assign(Object.create({ inherited: true }), { baseUrl: new URL(baseUrl) }),
      accessor
    ]) {
      expect(() => createHostDeckApprovalClient(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("accepts only direct loopback HTTP before any fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, listResponse([]));
    };
    for (const url of [
      "https://127.0.0.1:3777",
      "http://0.0.0.0:3777",
      "http://192.0.2.10:3777",
      "http://user:password@127.0.0.1:3777",
      "http://127.0.0.1:3777/api",
      "http://127.0.0.1:3777?target=private",
      "http://127.0.0.1:3777#private"
    ]) {
      expect(() => createHostDeckApprovalClient({ baseUrl: new URL(url), fetch })).toThrowError(
        expect.objectContaining({ code: "invalid_config" })
      );
    }
    expect(calls).toBe(0);
  });

  it("issues one exact GET and one target-free confirmed POST", async () => {
    const requests: Array<{ readonly init: unknown; readonly url: string }> = [];
    const responses = [listResponse([approval("pending", null)]), response("approve")];
    const client = createHostDeckApprovalClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(200, responses.shift());
      }
    });

    await expect(client.list(sessionId)).resolves.toEqual(listResponse([approval("pending", null)]));
    await expect(client.respond(request)).resolves.toEqual(response("approve"));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/approvals`,
        init: { method: "GET", headers: { accept: "application/json", "cache-control": "no-store" } }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/approvals/string%3Aapproval-client-1/respond`,
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
    expect(requests[1]).not.toMatchObject({ target: expect.anything(), thread_id: expect.anything() });
  });

  it("rejects malformed targets and response input before fetch", async () => {
    let calls = 0;
    const client = createHostDeckApprovalClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, listResponse([]));
      }
    });
    for (const candidate of ["", "approval-client", threadId, "/tmp/private", `${sessionId}/other`]) {
      await expect(client.list(candidate)).rejects.toMatchObject({ code: "malformed_request", field: "session" });
    }
    for (const candidate of [
      { ...request, confirm: false },
      { ...request, request_id: "" },
      { ...request, decision: "accept" },
      { ...request, target: { session_id: sessionId } },
      { ...request, force: true }
    ]) {
      await expect(client.respond(candidate as never)).rejects.toMatchObject({
        code: "malformed_request",
        field: "approvals"
      });
    }
    expect(calls).toBe(0);
  });

  it("rejects cross-target, cross-operation, cross-decision, nonterminal, hostile, and wrong-status success", async () => {
    const hostile = Object.defineProperty({}, "target", {
      enumerable: true,
      get() {
        throw new Error("hostile success private sentinel");
      }
    });
    const listCandidates = [
      { ...listResponse([]), target: { ...managedTarget(), session_id: otherSessionId } },
      { target: managedTarget(), approvals: [hostile] },
      null
    ];
    const responseCandidates = [
      { ...response("approve"), operation_id: "op_approval_client_other" },
      { ...response("approve"), requested_decision: "deny" },
      { ...response("approve"), approval: { ...approval("approved", "approve"), target: approvalTarget("string:other") } },
      { ...response("approve"), approval: approval("responding", null) },
      hostile,
      null
    ];
    let calls = 0;
    const client = createHostDeckApprovalClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        const candidate = listCandidates.length > 0 ? listCandidates.shift() : responseCandidates.shift();
        return jsonResponse(200, candidate);
      }
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(client.list(sessionId)).rejects.toMatchObject({ code: "internal_error" });
    }
    for (let index = 0; index < 6; index += 1) {
      await expect(client.respond(request)).rejects.toMatchObject({ code: "internal_error" });
    }
    expect(calls).toBe(9);

    const wrongStatus = createHostDeckApprovalClient({
      baseUrl,
      fetch: async () => jsonResponse(202, response("approve"))
    });
    await expect(wrongStatus.respond(request)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("sanitizes typed failures and never retries", async () => {
    const cases = [
      [404, "session_not_found", "Managed session was not found."],
      [409, "approval_not_pending", "not pending"],
      [409, "stale_session", "reconciliation"],
      [409, "capability_unavailable", "selected runtime"],
      [409, "unknown_error", "unknown"],
      [502, "protocol_error", "protocol validation"],
      [503, "runtime_unavailable", "unavailable"],
      [504, "operation_timeout", "terminal proof"],
      [500, "storage_error", "storage"],
      [403, "read_only", "Write permission"]
    ] as const;
    let calls = 0;
    const client = createHostDeckApprovalClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private daemon action scope cookie token",
            retryable: current[1] === "runtime_unavailable"
          }
        });
      }
    });
    for (const [, code, message] of cases) {
      await expect(client.respond(request)).rejects.toMatchObject({
        code,
        message: expect.stringContaining(message)
      });
    }
    expect(calls).toBe(cases.length);
  });
});

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

function approval(state: PendingApproval["state"], decision: PendingApproval["decision"]): PendingApproval {
  return pendingApprovalSchema.parse({
    target: approvalTarget(),
    action: "Run reviewed command",
    scope: "/tmp/approval-client",
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

function response(decision: "approve" | "deny"): PendingApprovalResponse {
  return pendingApprovalResponseSchema.parse({
    operation_id: operationId,
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
