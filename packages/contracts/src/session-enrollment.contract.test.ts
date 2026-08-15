import { persistedSelectedAuditActions, selectedAuditActions } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import { selectedSessionEnrollmentAuditEventRecordSchema } from "./selected-storage.js";

const nativeThreadId = "019f489a-1f9d-7402-ae00-eac6ea322f64";

describe("session enrollment audit contract", () => {
  it("publishes one current enrollment action and accepts its exact system trail", () => {
    expect(selectedAuditActions.filter((action) => action === "session_enroll")).toEqual(["session_enroll"]);
    expect(persistedSelectedAuditActions.filter((action) => action === "session_enroll")).toEqual([
      "session_enroll"
    ]);

    const accepted = enrollmentRecord("accepted", "accepted", {
      schema_version: 1,
      enrollment_origin: "loaded_before"
    });
    expect(selectedSessionEnrollmentAuditEventRecordSchema.parse(accepted)).toEqual(accepted);
    const succeeded = enrollmentRecord("terminal", "succeeded", {
      schema_version: 1,
      enrolled: true,
      created: false,
      refreshed: false
    });
    expect(selectedSessionEnrollmentAuditEventRecordSchema.parse(succeeded)).toEqual(succeeded);
    expect(
      selectedSessionEnrollmentAuditEventRecordSchema.parse({
        ...succeeded,
        payload_summary: { ...succeeded.payload_summary, refreshed: true }
      })
    ).toMatchObject({ payload_summary: { created: false, refreshed: true } });
    expect(
      selectedSessionEnrollmentAuditEventRecordSchema.safeParse({
        ...succeeded,
        payload_summary: { ...succeeded.payload_summary, created: true, refreshed: true }
      }).success
    ).toBe(false);
  });

  it("accepts the bounded restart outcome without inventing enrollment success", () => {
    const incomplete = {
      ...enrollmentRecord("terminal", "incomplete", {
        schema_version: 1,
        reconciliation_reason: "host_restart_without_terminal"
      }),
      error_code: "runtime_unavailable" as const
    };
    expect(selectedSessionEnrollmentAuditEventRecordSchema.parse(incomplete)).toEqual(incomplete);
  });

  it("rejects client authority, non-native ids, and extra payload fields", () => {
    const accepted = enrollmentRecord("accepted", "accepted", {
      schema_version: 1,
      enrollment_origin: "created_after"
    });
    expect(() =>
      selectedSessionEnrollmentAuditEventRecordSchema.parse({
        ...accepted,
        actor: { type: "cli", device_id: null, permission: "local_admin", origin: null }
      })
    ).toThrow();
    expect(() =>
      selectedSessionEnrollmentAuditEventRecordSchema.parse({
        ...accepted,
        target: { type: "native_codex_thread", codex_thread_id: "thread-opaque" }
      })
    ).toThrow();
    expect(() =>
      selectedSessionEnrollmentAuditEventRecordSchema.parse({
        ...accepted,
        payload_summary: {
          schema_version: 1,
          enrollment_origin: "created_after",
          rollout_path: "/private/codex/rollout.jsonl"
        }
      })
    ).toThrow();
  });
});

function enrollmentRecord(
  phase: "accepted" | "terminal",
  outcome: "accepted" | "succeeded" | "incomplete",
  payloadSummary: Readonly<Record<string, unknown>>
) {
  return {
    id: `audit:session-enrollment:${phase}:${outcome}`,
    operation_id: "op_session_enrollment_contract",
    at: phase === "accepted" ? "2026-08-14T16:00:00.000Z" : "2026-08-14T16:01:00.000Z",
    actor: { type: "system" as const, device_id: null, permission: null, origin: null },
    action: "session_enroll" as const,
    target: { type: "native_codex_thread" as const, codex_thread_id: nativeThreadId },
    phase,
    outcome,
    payload_summary: payloadSummary,
    error_code: null
  };
}
