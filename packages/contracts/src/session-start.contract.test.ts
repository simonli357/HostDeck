import {
  persistedSelectedAuditActions,
  selectedAuditActions
} from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  selectedSessionStartResponseSchema,
  selectedStartSessionRequestSchema
} from "./selected-operations.js";
import { managedSessionProjectionSchema } from "./selected-runtime.js";
import { selectedSessionStartAuditEventRecordSchema } from "./selected-storage.js";

const operationId = "op_session_start_contract_001";
const at = "2026-07-15T12:00:00.000Z";

describe("selected managed-session start contracts", () => {
  it("admits one exact operation, alias, cwd, and managed projection", () => {
    expect(
      selectedStartSessionRequestSchema.parse({
        operation_id: operationId,
        name: "contract-session",
        cwd: "/tmp/hostdeck-contract"
      })
    ).toEqual({
      operation_id: operationId,
      name: "contract-session",
      cwd: "/tmp/hostdeck-contract"
    });

    const session = projection();
    expect(
      selectedSessionStartResponseSchema.parse({ operation_id: operationId, session })
    ).toEqual({ operation_id: operationId, session });

    for (const request of [
      { operation_id: operationId, name: "contract-session", cwd: "/tmp/hostdeck-contract", thread_id: "thread-invented" },
      { operation_id: operationId, name: "contract-session", cwd: "/tmp/hostdeck-contract", session_id: "sess_invented" },
      { operation_id: operationId, name: "contract-session", cwd: "/tmp/hostdeck-contract", import: true },
      { operation_id: operationId, name: "contract-session", cwd: "relative/path" }
    ]) {
      expect(() => selectedStartSessionRequestSchema.parse(request)).toThrow();
    }
    expect(() =>
      selectedSessionStartResponseSchema.parse({
        operation_id: operationId,
        session,
        recovery: { state: "reserved" }
      })
    ).toThrow();
  });

  it("makes session_start one active and persisted action", () => {
    expect(selectedAuditActions.filter((action) => action === "session_start")).toEqual(["session_start"]);
    expect(persistedSelectedAuditActions.filter((action) => action === "session_start")).toEqual(["session_start"]);
  });

  it("enforces exact actor, host target, phase, and secret-free summaries", () => {
    const accepted = record("accepted", "accepted", null, {
      schema_version: 1,
      name_length: 16,
      cwd_present: true
    });
    const succeeded = record("terminal", "succeeded", null, {
      schema_version: 1,
      created: true
    });
    const failed = record("terminal", "failed", "invalid_cwd", {
      schema_version: 1
    });
    const reconciled = record("terminal", "incomplete", "runtime_unavailable", {
      schema_version: 1,
      reconciliation_reason: "host_restart_without_terminal"
    });
    for (const candidate of [accepted, succeeded, failed, reconciled]) {
      expect(selectedSessionStartAuditEventRecordSchema.parse(candidate)).toEqual(candidate);
    }

    for (const candidate of [
      { ...accepted, actor: { type: "dashboard", device_id: "client_read", permission: "read", origin: "https://hostdeck.test" } },
      { ...accepted, target: { type: "managed_session", session_id: "sess_wrong", codex_thread_id: "thread-wrong" } },
      { ...accepted, payload_summary: { schema_version: 1, name_length: 16, cwd_present: true, cwd: "/private" } },
      { ...accepted, payload_summary: { schema_version: 1, name_length: 16 } },
      { ...succeeded, payload_summary: { schema_version: 1, created: true, thread_id: "thread-private" } },
      { ...failed, payload_summary: { schema_version: 1, name_length: 16 } },
      { ...failed, payload_summary: { schema_version: 1, reconciliation_reason: "host_restart_without_terminal" } },
      { ...failed, outcome: "rejected", error_code: "validation_error" }
    ]) {
      expect(() => selectedSessionStartAuditEventRecordSchema.parse(candidate)).toThrow();
    }
  });
});

function record(
  phase: "accepted" | "terminal",
  outcome: "accepted" | "failed" | "incomplete" | "succeeded",
  errorCode: "invalid_cwd" | "runtime_unavailable" | null,
  payloadSummary: Readonly<Record<string, unknown>>
) {
  return {
    id: `audit:session-start:${phase}:${outcome}`,
    operation_id: operationId,
    at,
    actor: {
      type: "cli" as const,
      device_id: null,
      permission: "local_admin" as const,
      origin: null
    },
    action: "session_start" as const,
    target: { type: "host" as const, host_id: "local_host" as const },
    phase,
    outcome,
    payload_summary: payloadSummary,
    error_code: errorCode
  };
}

function projection() {
  return managedSessionProjectionSchema.parse({
    id: "sess_start_contract_001",
    name: "contract-session",
    codex_thread_id: "thread-start-contract-001",
    cwd: "/tmp/hostdeck-contract",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: at,
    archived_at: null,
    session_state: "active",
    turn_state: "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: at,
    last_activity_at: null,
    branch: null,
    model: null,
    goal: null,
    recent_summary: "Managed Codex session ready.",
    last_event_cursor: null
  });
}
