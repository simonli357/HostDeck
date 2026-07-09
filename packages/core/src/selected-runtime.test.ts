import { describe, expect, it } from "vitest";
import {
  canTransitionManagedSession,
  evaluateSelectedOperationEligibility,
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
  runtimeCapabilityRequirement,
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
    expect(runtimeCapabilityRequirement("plan")).toBe("required");
    expect(runtimeCapabilityRequirement("compact")).toBe("optional");
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

describe("selected managed-session transitions", () => {
  it("separates normal actions from reconciliation observations", () => {
    expect(canTransitionManagedSession("starting", "active", "normal")).toBe(true);
    expect(canTransitionManagedSession("active", "archived", "normal")).toBe(true);
    expect(canTransitionManagedSession("active", "stale", "normal")).toBe(false);
    expect(canTransitionManagedSession("active", "stale", "reconciliation")).toBe(true);
    expect(canTransitionManagedSession("stale", "active", "reconciliation")).toBe(true);
    expect(canTransitionManagedSession("archived", "active", "reconciliation")).toBe(false);
  });

  it("keeps repeated transitions deterministic in both modes", () => {
    expect(canTransitionManagedSession("active", "active", "normal")).toBe(true);
    expect(canTransitionManagedSession("stale", "stale", "reconciliation")).toBe(true);
  });
});

describe("selected operation eligibility", () => {
  const readyInput = {
    targetResolution: "resolved",
    sessionState: "active",
    freshness: "current",
    runtimeState: "ready",
    runtimeMutationPolicy: "allowed",
    capabilityState: "available"
  } as const;

  it("allows one resolved, current, compatible target with an available capability", () => {
    expect(evaluateSelectedOperationEligibility("prompt", readyInput)).toEqual({ ok: true, capability: "turn_input" });
  });

  it.each([
    [{ ...readyInput, targetResolution: "missing" as const }, "target_missing"],
    [{ ...readyInput, targetResolution: "mismatch" as const }, "target_mismatch"],
    [{ ...readyInput, sessionState: "starting" as const }, "session_starting"],
    [{ ...readyInput, sessionState: "archived" as const }, "session_archived"],
    [{ ...readyInput, sessionState: "stale" as const }, "session_stale"],
    [{ ...readyInput, sessionState: "incompatible" as const }, "session_incompatible"],
    [{ ...readyInput, sessionState: "unknown" as const }, "session_unknown"],
    [{ ...readyInput, freshness: "disconnected" as const }, "projection_stale"],
    [{ ...readyInput, runtimeMutationPolicy: "blocked" as const }, "runtime_mutations_blocked"],
    [{ ...readyInput, runtimeState: "incompatible" as const }, "runtime_incompatible"],
    [{ ...readyInput, runtimeState: "disconnected" as const }, "runtime_disconnected"],
    [{ ...readyInput, capabilityState: "unavailable" as const }, "capability_unavailable"],
    [{ ...readyInput, capabilityState: "unknown" as const }, "capability_unknown"]
  ])("rejects an ineligible operation with the exact reason", (input, reason) => {
    expect(evaluateSelectedOperationEligibility("goal", input)).toMatchObject({ ok: false, capability: "goal", reason });
  });

  it("allows proven operations when only optional runtime capability state is degraded", () => {
    expect(evaluateSelectedOperationEligibility("prompt", { ...readyInput, runtimeState: "degraded" })).toEqual({
      ok: true,
      capability: "turn_input"
    });
  });

  it("keeps read-only utilities available when only mutations are blocked", () => {
    expect(evaluateSelectedOperationEligibility("usage", { ...readyInput, runtimeMutationPolicy: "blocked" })).toEqual({
      ok: true,
      capability: "usage"
    });
    expect(evaluateSelectedOperationEligibility("skills", { ...readyInput, runtimeMutationPolicy: "blocked" })).toEqual({
      ok: true,
      capability: "skills"
    });
  });
});
