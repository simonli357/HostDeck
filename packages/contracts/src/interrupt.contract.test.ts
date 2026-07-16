import { describe, expect, it } from "vitest";
import {
  interruptOperationIntentSchema,
  interruptRequestSchema,
  interruptResponseSchema,
  sessionTurnParamsSchema
} from "./index.js";

const target = {
  type: "turn",
  session_id: "sess_contract_interrupt",
  codex_thread_id: "thread-contract-interrupt",
  turn_id: "turn-contract-interrupt"
} as const;
const operationId = "op_contract_interrupt_0001";
const timestamp = "2026-07-16T18:00:00.000Z";

describe("interrupt API contracts", () => {
  it("keeps the public request target-free and literally confirmed", () => {
    const request = { operation_id: operationId, kind: "interrupt", confirm: true } as const;
    expect(interruptRequestSchema.parse(request)).toEqual(request);

    for (const candidate of [
      { ...request, confirm: false },
      { ...request, target },
      { ...request, codex_thread_id: target.codex_thread_id },
      { ...request, force: true }
    ]) {
      expect(() => interruptRequestSchema.parse(candidate)).toThrow();
    }
  });

  it("retains the exact target only at the internal service boundary", () => {
    expect(
      interruptOperationIntentSchema.parse({
        operation_id: operationId,
        target,
        kind: "interrupt",
        confirm: true
      })
    ).toMatchObject({ target, confirm: true });
    expect(() =>
      interruptOperationIntentSchema.parse({ operation_id: operationId, kind: "interrupt", confirm: true })
    ).toThrow();
  });

  it("accepts only exact session and normalized turn path identities", () => {
    expect(sessionTurnParamsSchema.parse({ session_id: target.session_id, turn_id: target.turn_id })).toEqual({
      session_id: target.session_id,
      turn_id: target.turn_id
    });
    for (const candidate of [
      { session_id: target.session_id },
      { session_id: target.session_id, turn_id: target.turn_id, codex_thread_id: target.codex_thread_id },
      { session_id: target.session_id, turn_id: "" }
    ]) {
      expect(() => sessionTurnParamsSchema.parse(candidate)).toThrow();
    }
  });

  it("encodes only exact event-proven interrupted terminal truth", () => {
    const response = {
      operation_id: operationId,
      kind: "interrupt",
      target,
      state: "interrupted",
      updated_at: timestamp,
      turn_id: target.turn_id,
      error: null
    } as const;
    expect(interruptResponseSchema.parse(response)).toEqual(response);

    for (const candidate of [
      { ...response, state: "accepted" },
      { ...response, state: "failed", error: { code: "operation_conflict", message: "failed", retryable: false } },
      { ...response, turn_id: "turn-contract-foreign" },
      { ...response, error: { code: "unknown_error", message: "unknown", retryable: false } },
      { ...response, extra: true }
    ]) {
      expect(() => interruptResponseSchema.parse(candidate)).toThrow();
    }
  });
});
