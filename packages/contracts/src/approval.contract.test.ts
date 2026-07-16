import { describe, expect, it } from "vitest";
import {
  approvalResponseOperationIntentSchema,
  approvalResponseRequestSchema,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  sessionApprovalParamsSchema
} from "./index.js";

const target = {
  type: "managed_session",
  session_id: "sess_contract_approval",
  codex_thread_id: "thread-contract-approval"
} as const;
const approvalTarget = {
  type: "approval",
  session_id: target.session_id,
  codex_thread_id: target.codex_thread_id,
  request_id: "string:contract-approval-1"
} as const;
const operationId = "op_contract_approval_0001";

describe("approval API contracts", () => {
  it("keeps the public response request target-free and literally confirmed", () => {
    const request = { operation_id: operationId, kind: "approval_response", decision: "approve", confirm: true } as const;
    expect(approvalResponseRequestSchema.parse(request)).toEqual(request);

    for (const candidate of [
      { ...request, confirm: false },
      { ...request, target: approvalTarget },
      { ...request, force: true },
      { ...request, raw_response: "yes" }
    ]) {
      expect(() => approvalResponseRequestSchema.parse(candidate)).toThrow();
    }
  });

  it("retains the target-bearing intent only for the internal service boundary", () => {
    expect(
      approvalResponseOperationIntentSchema.parse({
        operation_id: operationId,
        target: approvalTarget,
        kind: "approval_response",
        decision: "deny",
        confirm: true
      })
    ).toMatchObject({ target: approvalTarget, decision: "deny" });
    expect(() =>
      approvalResponseOperationIntentSchema.parse({
        operation_id: operationId,
        kind: "approval_response",
        decision: "deny",
        confirm: true
      })
    ).toThrow();
  });

  it("accepts only the exact session and normalized request path identities", () => {
    expect(
      sessionApprovalParamsSchema.parse({ session_id: target.session_id, request_id: approvalTarget.request_id })
    ).toEqual({ session_id: target.session_id, request_id: approvalTarget.request_id });
    for (const candidate of [
      { session_id: target.session_id },
      { session_id: target.session_id, request_id: approvalTarget.request_id, codex_thread_id: target.codex_thread_id },
      { session_id: target.session_id, request_id: "" }
    ]) {
      expect(() => sessionApprovalParamsSchema.parse(candidate)).toThrow();
    }
  });

  it("requires every bounded list entry to match its selected managed-session target", () => {
    const pending = approval("pending", null);
    expect(pendingApprovalListResponseSchema.parse({ target, approvals: [] })).toEqual({ target, approvals: [] });
    expect(pendingApprovalListResponseSchema.parse({ target, approvals: [pending] }).approvals).toEqual([pending]);

    expect(() => pendingApprovalListResponseSchema.parse({ target, approvals: [pending, pending] })).toThrow();
    expect(() =>
      pendingApprovalListResponseSchema.parse({
        target,
        approvals: [{ ...pending, target: { ...pending.target, codex_thread_id: "thread-contract-foreign" } }]
      })
    ).toThrow();
    expect(() => pendingApprovalListResponseSchema.parse({ target, approvals: [], extra: true })).toThrow();
  });

  it("encodes only an authoritative terminal decision matching the request", () => {
    const approved = approval("approved", "approve");
    expect(
      pendingApprovalResponseSchema.parse({
        operation_id: operationId,
        requested_decision: "approve",
        approval: approved
      })
    ).toMatchObject({ requested_decision: "approve", approval: { state: "approved", decision: "approve" } });

    for (const candidate of [
      { operation_id: operationId, requested_decision: "approve", approval: approval("responding", null) },
      { operation_id: operationId, requested_decision: "deny", approval: approved },
      { operation_id: operationId, requested_decision: "approve", approval: approved, extra: true }
    ]) {
      expect(() => pendingApprovalResponseSchema.parse(candidate)).toThrow();
    }
  });
});

function approval(state: "pending" | "responding" | "approved", decision: "approve" | null) {
  return {
    target: approvalTarget,
    action: "Run reviewed command",
    scope: "/tmp/hostdeck-contract",
    reason: "The runtime requires confirmation.",
    risk: "elevated" as const,
    grant_scope: "one_time" as const,
    state,
    created_at: "2026-07-16T12:00:00.000Z",
    expires_at: "2026-07-16T12:05:00.000Z",
    decision
  };
}
