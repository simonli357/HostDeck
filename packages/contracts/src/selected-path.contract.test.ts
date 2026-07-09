import { requiredRuntimeCapabilities, runtimeCapabilities, selectedOperationKinds } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  legacySessionDispositionRecordSchema,
  managedSessionProjectionSchema,
  pendingApprovalSchema,
  runtimeCompatibilitySchema,
  selectedAuditEventRecordSchema,
  selectedOperationDispatchSchema,
  selectedOperationIntentSchema,
  selectedOperationProgressSchema,
  selectedOperationTerminalOutcomeSchema,
  selectedProjectedEventRecordSchema,
  selectedSessionEventStreamSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionStartRecoveryRecordSchema
} from "./index.js";

const timestamp = "2026-07-09T16:00:00.000Z";
const laterTimestamp = "2026-07-09T16:01:00.000Z";
const target = {
  type: "managed_session",
  session_id: "sess_contract_selected",
  codex_thread_id: "thread-contract-selected"
} as const;

function capabilities(overrides: Readonly<Record<string, "available" | "unavailable" | "unknown">> = {}) {
  return runtimeCapabilities.map((name) => {
    const state = overrides[name] ?? "available";
    return {
      name,
      state,
      reason: state === "available" ? null : `${name} is ${state}.`
    };
  });
}

describe("selected runtime compatibility", () => {
  it("accepts a ready runtime when optional utilities are explicitly unavailable", () => {
    const result = runtimeCompatibilitySchema.parse({
      source: "codex_app_server",
      state: "ready",
      observed_version: "0.144.0",
      binding_id: "codex-app-server-0.144.0:sha256:contract",
      capabilities: capabilities({ compact: "unavailable" }),
      checked_at: timestamp,
      reason: null
    });

    expect(result.capabilities.find((capability) => capability.name === "compact")?.state).toBe("unavailable");
  });

  it("rejects ready or degraded states missing a required operation", () => {
    for (const state of ["ready", "degraded"] as const) {
      expect(() =>
        runtimeCompatibilitySchema.parse({
          source: "codex_app_server",
          state,
          observed_version: "0.144.0",
          binding_id: "codex-app-server-0.144.0:sha256:contract",
          capabilities: capabilities({ plan: "unavailable" }),
          checked_at: timestamp,
          reason: state === "ready" ? null : "Plan is unavailable."
        })
      ).toThrow();
    }
  });

  it("requires incompatible state to identify at least one missing required capability", () => {
    expect(requiredRuntimeCapabilities).toContain("plan");
    expect(() =>
      runtimeCompatibilitySchema.parse({
        source: "codex_app_server",
        state: "incompatible",
        observed_version: "0.144.0",
        binding_id: "codex-app-server-0.144.0:sha256:contract",
        capabilities: capabilities({ compact: "unavailable" }),
        checked_at: timestamp,
        reason: "Only an optional utility is unavailable."
      })
    ).toThrow();
  });
});

describe("selected structured operation contracts", () => {
  it("parses every selected operation as a typed exact-target intent", () => {
    const inputs = [
      { kind: "prompt", text: "Continue with the next ready task." },
      { kind: "model", model_id: "gpt-5.5-codex", reasoning_effort: "high" },
      { kind: "goal", action: "set", objective: "Complete the V1 foundation." },
      { kind: "plan", action: "enter" },
      { kind: "usage" },
      { kind: "compact", confirm: true },
      { kind: "skills" },
      { kind: "approval_response", request_id: "approval:contract:1", decision: "approve", confirm: true },
      { kind: "interrupt", turn_id: "turn-contract-1", confirm: true },
      { kind: "archive", confirm: true }
    ];

    const parsedKinds = inputs.map((input, index) =>
      selectedOperationIntentSchema.parse({
        operation_id: `op_contract_${String(index).padStart(4, "0")}`,
        target,
        ...input
      }).kind
    );

    expect(parsedKinds).toEqual(selectedOperationKinds);
  });

  it("rejects legacy raw/slash input, missing targets, and ambiguous target fields", () => {
    expect(() =>
      selectedOperationIntentSchema.parse({
        operation_id: "op_contract_raw1",
        target,
        kind: "raw_input",
        text: "rm -rf /"
      })
    ).toThrow();
    expect(() =>
      selectedOperationIntentSchema.parse({
        operation_id: "op_contract_slash",
        target,
        kind: "slash",
        command: "/model"
      })
    ).toThrow();
    expect(() =>
      selectedOperationIntentSchema.parse({
        operation_id: "op_contract_none1",
        kind: "prompt",
        text: "No target"
      })
    ).toThrow();
    expect(() =>
      selectedOperationIntentSchema.parse({
        operation_id: "op_contract_many1",
        target: {
          ...target,
          session_ids: [target.session_id]
        },
        kind: "prompt",
        text: "Ambiguous target"
      })
    ).toThrow();
  });

  it("preserves goal lifecycle and approval decision invariants", () => {
    expect(() =>
      selectedOperationIntentSchema.parse({
        operation_id: "op_contract_goal1",
        target,
        kind: "goal",
        action: "set",
        objective: null
      })
    ).toThrow();

    expect(() =>
      pendingApprovalSchema.parse({
        target,
        request_id: "approval:contract:1",
        action: "Run package install",
        scope: "/workspace",
        reason: null,
        risk: "elevated",
        grant_scope: "one_time",
        state: "approved",
        created_at: timestamp,
        expires_at: null,
        decision: "deny"
      })
    ).toThrow();
  });

  it("keeps accepted dispatch separate from terminal success or uncertainty", () => {
    expect(
      selectedOperationDispatchSchema.parse({
        operation_id: "op_contract_receipt",
        kind: "prompt",
        target,
        state: "accepted",
        accepted_at: timestamp,
        audit_record_id: "audit:contract:accepted"
      }).state
    ).toBe("accepted");

    expect(
      selectedOperationTerminalOutcomeSchema.parse({
        operation_id: "op_contract_receipt",
        kind: "prompt",
        target,
        state: "succeeded",
        finished_at: laterTimestamp,
        turn_id: "turn-contract-1",
        result_summary: "Turn completed.",
        error: null
      }).state
    ).toBe("succeeded");

    expect(() =>
      selectedOperationTerminalOutcomeSchema.parse({
        operation_id: "op_contract_receipt",
        kind: "prompt",
        target,
        state: "incomplete",
        finished_at: laterTimestamp,
        turn_id: null,
        result_summary: null,
        error: null
      })
    ).toThrow();

    expect(() =>
      selectedOperationProgressSchema.parse({
        operation_id: "op_contract_receipt",
        kind: "prompt",
        target,
        state: "incomplete",
        updated_at: laterTimestamp,
        turn_id: null,
        error: null
      })
    ).toThrow();
  });
});

describe("selected projection and storage contracts", () => {
  const session = managedSessionProjectionSchema.parse({
    id: target.session_id,
    name: "contract-selected",
    codex_thread_id: target.codex_thread_id,
    cwd: "/home/simonli/work/contract-selected",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "in_progress",
    attention: "watch",
    freshness: "current",
    freshness_reason: null,
    updated_at: laterTimestamp,
    last_activity_at: laterTimestamp,
    branch: "main",
    model: "gpt-5.5-codex",
    goal: null,
    recent_summary: "Running contract tests.",
    last_event_cursor: 2
  });

  const event = {
    session_id: session.id,
    cursor: 2,
    captured_at: laterTimestamp,
    upstream_at: timestamp,
    codex_event_id: "event-contract-2",
    codex_event_type: "turn/started",
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: "turn-contract-1",
    state: "in_progress",
    error: null
  };

  it("requires ordered, same-session events with explicit projection content state", () => {
    expect(
      selectedSessionEventStreamSchema.parse({
        session_id: session.id,
        events: [event],
        next_cursor: 2,
        truncated: false
      }).events
    ).toHaveLength(1);

    expect(() =>
      selectedSessionEventStreamSchema.parse({
        session_id: session.id,
        events: [{ ...event, content_state: undefined }],
        next_cursor: 2,
        truncated: false
      })
    ).toThrow();

    expect(() =>
      selectedSessionEventStreamSchema.parse({
        session_id: session.id,
        events: [event, { ...event, cursor: 1 }],
        next_cursor: 2,
        truncated: false
      })
    ).toThrow();

    expect(() =>
      selectedSessionEventStreamSchema.parse({
        session_id: session.id,
        events: [{ ...event, content_state: "redacted", content_notice: null }],
        next_cursor: 2,
        truncated: false
      })
    ).toThrow();

    expect(
      selectedSessionEventStreamSchema.parse({
        session_id: session.id,
        events: [{ ...event, content_state: "redacted", content_notice: "Secrets were removed from this projection." }],
        next_cursor: 2,
        truncated: false
      }).events[0]
    ).toMatchObject({ content_state: "redacted" });

    expect(() =>
      selectedSessionEventStreamSchema.parse({
        session_id: session.id,
        events: [event],
        next_cursor: 2,
        truncated: true
      })
    ).toThrow();
  });

  it("stores selected mappings separately from explicitly marked legacy records", () => {
    expect(
      selectedSessionMappingRecordSchema.parse({
        id: session.id,
        name: session.name,
        codex_thread_id: session.codex_thread_id,
        cwd: session.cwd,
        runtime_source: session.runtime_source,
        runtime_version: session.runtime_version,
        disposition: "selected",
        created_at: session.created_at,
        updated_at: session.updated_at,
        archived_at: null
      }).disposition
    ).toBe("selected");

    expect(
      legacySessionDispositionRecordSchema.parse({
        id: "sess_contract_legacy",
        name: "legacy",
        cwd: "/home/simonli/work/legacy",
        disposition: "legacy_unmigrated",
        reason: "No stable Codex thread id was proven.",
        updated_at: laterTimestamp
      }).disposition
    ).toBe("legacy_unmigrated");

    expect(() =>
      selectedSessionMappingRecordSchema.parse({
        id: session.id,
        name: session.name,
        codex_thread_id: session.codex_thread_id,
        cwd: session.cwd,
        runtime_source: session.runtime_source,
        runtime_version: session.runtime_version,
        disposition: "legacy_unmigrated",
        created_at: session.created_at,
        updated_at: session.updated_at,
        archived_at: null
      })
    ).toThrow();
  });

  it("bounds projected records and preserves failed session-start recovery", () => {
    expect(selectedProjectedEventRecordSchema.parse({ event, byte_length: 512 }).byte_length).toBe(512);
    expect(
      selectedSessionStartRecoveryRecordSchema.parse({
        operation_id: "op_contract_start1",
        session_id: "sess_contract_recover",
        name: "recover",
        cwd: "/home/simonli/work/recover",
        codex_thread_id: "thread-recovered",
        state: "failed",
        created_at: timestamp,
        updated_at: laterTimestamp,
        error_code: "storage_error",
        error_message: "Thread creation succeeded but mapping persistence failed."
      }).codex_thread_id
    ).toBe("thread-recovered");
  });

  it("rejects audit records whose action and exact target disagree", () => {
    const baseAudit = {
      id: "audit:contract:1",
      operation_id: "op_contract_audit1",
      at: timestamp,
      actor: {
        type: "dashboard",
        device_id: "device:contract:1",
        permission: "write",
        origin: "https://hostdeck.local"
      },
      action: "approval_response",
      phase: "accepted",
      outcome: "accepted",
      payload_summary: { decision: "approve" },
      error_code: null
    };

    expect(() => selectedAuditEventRecordSchema.parse({ ...baseAudit, target })).toThrow();
    expect(
      selectedAuditEventRecordSchema.parse({
        ...baseAudit,
        target: {
          type: "approval",
          session_id: target.session_id,
          codex_thread_id: target.codex_thread_id,
          request_id: "approval:contract:1"
        }
      }).target.type
    ).toBe("approval");
  });
});
