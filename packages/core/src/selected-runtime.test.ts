import { describe, expect, it } from "vitest";
import {
  isSelectedMutationOperation,
  isSelectedOperationKind,
  mobileAttentionPriority,
  operationCapability,
  parseClientOperationId,
  parseCodexItemId,
  parseCodexThreadId,
  parseCodexTurnId,
  parseRuntimeRequestId,
  requiredRuntimeCapabilities,
  runtimeCapabilities,
  selectedAuditOutcomes,
  selectedOperationKinds
} from "./selected-runtime.js";

describe("selected runtime identifiers", () => {
  it("accepts opaque Codex identifiers without assuming one upstream format", () => {
    expect(parseCodexThreadId("019f489a-1f9d-7402-ae00-eac6ea322f64").ok).toBe(true);
    expect(parseCodexThreadId("thr_123").ok).toBe(true);
    expect(parseCodexTurnId("turn_456").ok).toBe(true);
    expect(parseCodexItemId("item:command/7").ok).toBe(true);
    expect(parseRuntimeRequestId("connection-3:42").ok).toBe(true);
  });

  it("rejects whitespace, control characters, and unbounded identifiers", () => {
    expect(parseCodexThreadId(" thread_1")).toMatchObject({ ok: false, code: "invalid_format" });
    expect(parseCodexTurnId("turn\n1")).toMatchObject({ ok: false, code: "invalid_format" });
    expect(parseCodexItemId("x".repeat(129))).toMatchObject({ ok: false, code: "too_long" });
  });

  it("requires HostDeck-owned operation ids to use a stable namespace", () => {
    expect(parseClientOperationId("op_12345678").ok).toBe(true);
    expect(parseClientOperationId("request-1")).toMatchObject({ ok: false, code: "invalid_format" });
  });
});

describe("selected structured operations", () => {
  it("contains structured controls and excludes legacy terminal write actions", () => {
    expect(selectedOperationKinds).toEqual([
      "prompt",
      "model",
      "goal",
      "plan",
      "usage",
      "compact",
      "skills",
      "approval_response",
      "interrupt",
      "archive"
    ]);
    expect(isSelectedOperationKind("raw_input")).toBe(false);
    expect(isSelectedOperationKind("slash")).toBe(false);
  });

  it("maps every operation to an explicit runtime capability", () => {
    const mappedCapabilities = selectedOperationKinds.map(operationCapability);

    expect(mappedCapabilities).toHaveLength(selectedOperationKinds.length);
    expect(mappedCapabilities.every((capability) => runtimeCapabilities.includes(capability))).toBe(true);
    expect(operationCapability("plan")).toBe("plan");
    expect(operationCapability("approval_response")).toBe("approvals");
  });

  it("distinguishes required capabilities from capability-gated utilities", () => {
    expect(requiredRuntimeCapabilities).toEqual(
      expect.arrayContaining(["thread_lifecycle", "turn_input", "model", "goal", "plan", "approvals"])
    );
    expect(requiredRuntimeCapabilities).not.toContain("usage");
    expect(requiredRuntimeCapabilities).not.toContain("compact");
    expect(requiredRuntimeCapabilities).not.toContain("skills");
    expect(runtimeCapabilities).toEqual(expect.arrayContaining([...requiredRuntimeCapabilities, "usage", "compact", "skills"]));
  });

  it("orders phone attention according to the Mission Control contract", () => {
    expect(mobileAttentionPriority("needs_approval")).toBeGreaterThan(mobileAttentionPriority("needs_input"));
    expect(mobileAttentionPriority("needs_input")).toBeGreaterThan(mobileAttentionPriority("failed"));
    expect(mobileAttentionPriority("failed")).toBeGreaterThan(mobileAttentionPriority("stuck"));
    expect(mobileAttentionPriority("stuck")).toBeGreaterThan(mobileAttentionPriority("watch"));
    expect(mobileAttentionPriority("watch")).toBeGreaterThan(mobileAttentionPriority("none"));
  });

  it("distinguishes read utilities from mutations", () => {
    expect(isSelectedMutationOperation("prompt")).toBe(true);
    expect(isSelectedMutationOperation("compact")).toBe(true);
    expect(isSelectedMutationOperation("usage")).toBe(false);
    expect(isSelectedMutationOperation("skills")).toBe(false);
  });

  it("keeps accepted and terminal audit outcomes distinct", () => {
    expect(selectedAuditOutcomes).toEqual(["accepted", "succeeded", "failed", "rejected", "incomplete"]);
  });
});
