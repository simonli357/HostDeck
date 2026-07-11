import { describe, expect, it } from "vitest";
import {
  compactOperationIntentSchema,
  defaultResourceBudget,
  resourceBudgetDefinitionByKey,
  selectedOperationProgressSchema,
  selectedOperationTerminalOutcomeSchema
} from "./index.js";

const target = {
  type: "managed_session",
  session_id: "sess_contract_compact",
  codex_thread_id: "thread-contract-compact"
} as const;
const operationId = "op_contract_compact_0001";
const timestamp = "2026-07-11T18:00:00.000Z";

describe("structured compact contracts", () => {
  it("requires literal confirmation and exact managed-session identity", () => {
    expect(
      compactOperationIntentSchema.parse({ operation_id: operationId, target, kind: "compact", confirm: true })
    ).toEqual({ operation_id: operationId, target, kind: "compact", confirm: true });
    expect(() =>
      compactOperationIntentSchema.parse({ operation_id: operationId, target, kind: "compact", confirm: false })
    ).toThrow();
    expect(() =>
      compactOperationIntentSchema.parse({ operation_id: operationId, target, kind: "compact", confirm: true, extra: true })
    ).toThrow();
  });

  it("keeps accepted-only progress unbound and requires a turn for event-proven states", () => {
    expect(progress("accepted", null, null).state).toBe("accepted");
    expect(progress("running", "turn-contract-compact", null).state).toBe("running");
    expect(progress("completed", "turn-contract-compact", null).state).toBe("completed");
    expect(progress("incomplete", null, errorEnvelope()).state).toBe("incomplete");

    expect(() => progress("accepted", "turn-contract-compact", null)).toThrow();
    for (const state of ["running", "completed", "interrupted", "failed"] as const) {
      expect(() => progress(state, null, state === "failed" ? errorEnvelope() : null)).toThrow();
    }
  });

  it("requires exact turn evidence for succeeded or failed compact terminal outcomes", () => {
    expect(terminal("succeeded", "turn-contract-compact", null).state).toBe("succeeded");
    expect(terminal("failed", "turn-contract-compact", errorEnvelope()).state).toBe("failed");
    expect(terminal("incomplete", null, errorEnvelope()).state).toBe("incomplete");
    expect(() => terminal("succeeded", null, null)).toThrow();
    expect(() => terminal("failed", null, errorEnvelope())).toThrow();
  });

  it("freezes the reviewed compact operation capacity", () => {
    expect(defaultResourceBudget.control_compact_max_tracked_operations).toBe(128);
    expect(resourceBudgetDefinitionByKey.control_compact_max_tracked_operations).toMatchObject({
      minimum: 1,
      default_value: 128,
      maximum: 4_096,
      owner: "turn_control",
      breach_code: "service_overloaded",
      breach_action: "reject_operation"
    });
  });
});

function progress(
  state: "accepted" | "running" | "completed" | "interrupted" | "failed" | "incomplete",
  turnId: string | null,
  error: ReturnType<typeof errorEnvelope> | null
) {
  return selectedOperationProgressSchema.parse({
    operation_id: operationId,
    kind: "compact",
    target,
    state,
    updated_at: timestamp,
    turn_id: turnId,
    error
  });
}

function terminal(
  state: "succeeded" | "failed" | "incomplete",
  turnId: string | null,
  error: ReturnType<typeof errorEnvelope> | null
) {
  return selectedOperationTerminalOutcomeSchema.parse({
    operation_id: operationId,
    kind: "compact",
    target,
    state,
    finished_at: timestamp,
    turn_id: turnId,
    result_summary: state === "succeeded" ? "Context compacted." : null,
    error
  });
}

function errorEnvelope() {
  return { code: "unknown_error" as const, message: "Compact outcome is unresolved.", retryable: false };
}
