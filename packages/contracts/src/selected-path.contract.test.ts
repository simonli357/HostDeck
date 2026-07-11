import { requiredRuntimeCapabilities, runtimeCapabilities, selectedOperationKinds } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  goalControlSnapshotSchema,
  legacySessionDispositionRecordSchema,
  managedSessionProjectionSchema,
  modelControlSnapshotSchema,
  pendingApprovalSchema,
  planControlSnapshotSchema,
  promptTurnControlSnapshotSchema,
  runtimeCompatibilitySchema,
  selectedAuditActorSchema,
  selectedAuditEventRecordSchema,
  selectedAuditTrailSchema,
  selectedControlStateSchema,
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
const approvalTarget = {
  type: "approval",
  session_id: target.session_id,
  codex_thread_id: target.codex_thread_id,
  request_id: "approval:contract:1"
} as const;
const turnTarget = {
  type: "turn",
  session_id: target.session_id,
  codex_thread_id: target.codex_thread_id,
  turn_id: "turn-contract-1"
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
      mutation_policy: "allowed",
      observed_version: "0.144.0",
      binding_id: "codex-app-server-0.144.0:sha256:contract",
      capabilities: capabilities({ compact: "unavailable" }),
      checked_at: timestamp,
      reason: null
    });

    expect(result.capabilities.find((capability) => capability.name === "compact")?.state).toBe("unavailable");
  });

  it("allows required mutations when only an optional capability is unknown", () => {
    const result = runtimeCompatibilitySchema.parse({
      source: "codex_app_server",
      state: "degraded",
      mutation_policy: "allowed",
      observed_version: "0.144.0",
      binding_id: "codex-app-server-0.144.0:sha256:contract",
      capabilities: capabilities({ usage: "unknown" }),
      checked_at: timestamp,
      reason: "Optional usage capability could not be confirmed."
    });

    expect(result.mutation_policy).toBe("allowed");
    expect(result.capabilities.find((capability) => capability.name === "usage")?.state).toBe("unknown");
  });

  it("rejects contradictory runtime mutation policy", () => {
    expect(() =>
      runtimeCompatibilitySchema.parse({
        source: "codex_app_server",
        state: "ready",
        mutation_policy: "blocked",
        observed_version: "0.144.0",
        binding_id: "codex-app-server-0.144.0:sha256:contract",
        capabilities: capabilities(),
        checked_at: timestamp,
        reason: null
      })
    ).toThrow();
  });

  it("rejects ready or degraded states missing a required operation", () => {
    for (const state of ["ready", "degraded"] as const) {
      expect(() =>
        runtimeCompatibilitySchema.parse({
          source: "codex_app_server",
          state,
          mutation_policy: "allowed",
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
        mutation_policy: "blocked",
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
      { kind: "model", model_id: "gpt-5.5-codex", reasoning_effort: "high", expected_pending_revision: null },
      { kind: "goal", action: "set", objective: "Complete the V1 foundation.", expected_goal_revision: null },
      { kind: "plan", action: "enter", expected_pending_revision: null },
      { kind: "usage" },
      { kind: "compact", confirm: true },
      { kind: "skills" },
      { kind: "approval_response", target: approvalTarget, decision: "approve", confirm: true },
      { kind: "interrupt", target: turnTarget, confirm: true },
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
        operation_id: "op_contract_wrong1",
        target,
        kind: "approval_response",
        decision: "approve",
        confirm: true
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
        objective: null,
        expected_goal_revision: null
      })
    ).toThrow();

    expect(() =>
      selectedOperationIntentSchema.parse({
        operation_id: "op_contract_goal2",
        target,
        kind: "goal",
        action: "resume",
        objective: null,
        expected_goal_revision: null
      })
    ).toThrow();

    expect(() =>
      pendingApprovalSchema.parse({
        target: approvalTarget,
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

  it("keeps control availability consistent with negotiated capability state", () => {
    expect(
      selectedControlStateSchema.parse({
        control: "compact",
        capability: "compact",
        capability_state: "unavailable",
        availability: "unsupported",
        phase: "idle",
        current_value: null,
        disabled_reason: "Compact is unavailable in this runtime.",
        error: null
      }).availability
    ).toBe("unsupported");

    expect(() =>
      selectedControlStateSchema.parse({
        control: "compact",
        capability: "compact",
        capability_state: "available",
        availability: "unsupported",
        phase: "idle",
        current_value: null,
        disabled_reason: "Contradictory capability state.",
        error: null
      })
    ).toThrow();
  });

  it("keeps confirmed and pending model state distinct and catalog-bound", () => {
    const models = [
      {
        id: "model-a",
        runtime_model: "runtime-a",
        label: "Model A",
        description: null,
        is_default: true,
        input_modalities: ["text", "image"],
        reasoning_efforts: [
          { id: "low", description: "Fast", is_default: false },
          { id: "high", description: "Thorough", is_default: true }
        ]
      },
      {
        id: "model-b",
        runtime_model: "runtime-b",
        label: "Model B",
        description: null,
        is_default: false,
        input_modalities: ["text"],
        reasoning_efforts: [{ id: "medium", description: null, is_default: true }]
      }
    ];
    const snapshot = {
      catalog_revision: "a".repeat(64),
      catalog_observed_at: timestamp,
      current: {
        model_id: "model-a",
        runtime_model: "runtime-a",
        reasoning_effort: "high",
        catalog_state: "available",
        observed_at: timestamp
      },
      pending: {
        revision: 1,
        selection_operation_id: "op_contract_model1",
        model_id: "model-b",
        runtime_model: "runtime-b",
        reasoning_effort: "medium",
        catalog_state: "available",
        phase: "pending",
        selected_at: timestamp,
        turn_id: null,
        error: null
      },
      models
    };

    expect(modelControlSnapshotSchema.parse(snapshot)).toMatchObject({
      current: { model_id: "model-a" },
      pending: { model_id: "model-b", phase: "pending" }
    });
    expect(() =>
      modelControlSnapshotSchema.parse({
        ...snapshot,
        current: { ...snapshot.current, runtime_model: "runtime-b" }
      })
    ).toThrow();
    expect(() =>
      modelControlSnapshotSchema.parse({
        ...snapshot,
        pending: { ...snapshot.pending, reasoning_effort: "high" }
      })
    ).toThrow();
    expect(() =>
      modelControlSnapshotSchema.parse({
        ...snapshot,
        pending: { ...snapshot.pending, catalog_state: "unknown" }
      })
    ).toThrow();
    expect(
      modelControlSnapshotSchema.parse({
        ...snapshot,
        pending: {
          ...snapshot.pending,
          model_id: "retired-model",
          runtime_model: "retired-runtime",
          catalog_state: "unknown",
          phase: "conflict",
          error: { code: "operation_conflict", message: "Catalog changed.", retryable: true }
        }
      }).pending
    ).toMatchObject({ catalog_state: "unknown", phase: "conflict" });
  });

  it("validates full goal state and preserves uncertain mutation intent", () => {
    const revision = "b".repeat(64);
    const snapshot = {
      goal: {
        revision,
        objective: "Complete the selected V1 work.",
        status: "paused",
        token_budget: 10_000,
        tokens_used: 500,
        time_used_seconds: 12.5,
        created_at: timestamp,
        updated_at: laterTimestamp
      },
      uncertain_mutation: null
    };
    expect(goalControlSnapshotSchema.parse(snapshot).goal).toMatchObject({ revision, status: "paused" });
    expect(
      goalControlSnapshotSchema.parse({
        ...snapshot,
        uncertain_mutation: {
          action: "resume",
          phase: "unknown",
          requested_at: laterTimestamp,
          baseline_revision: revision,
          requested_objective: null,
          requested_status: "active",
          error: { code: "unknown_error", message: "Outcome is unknown.", retryable: false }
        }
      }).uncertain_mutation
    ).toMatchObject({ action: "resume", requested_status: "active" });
    expect(() =>
      goalControlSnapshotSchema.parse({
        ...snapshot,
        goal: { ...snapshot.goal, updated_at: "2026-07-09T15:59:00.000Z" }
      })
    ).toThrow();
    expect(() =>
      goalControlSnapshotSchema.parse({
        ...snapshot,
        uncertain_mutation: {
          action: "clear",
          phase: "unknown",
          requested_at: laterTimestamp,
          baseline_revision: revision,
          requested_objective: null,
          requested_status: "active",
          error: { code: "unknown_error", message: "Contradictory intent.", retryable: false }
        }
      })
    ).toThrow();
  });

  it("validates confirmed, pending, and event-backed Plan state without partial claims", () => {
    const snapshot = {
      catalog_revision: "c".repeat(64),
      catalog_observed_at: timestamp,
      current: {
        state: "confirmed",
        mode: "default",
        runtime_model: "runtime-a",
        reasoning_effort: null,
        observed_at: timestamp
      },
      pending: {
        revision: 1,
        selection_operation_id: "op_contract_plan1",
        mode: "plan",
        catalog_state: "available",
        phase: "awaiting_confirmation",
        selected_at: timestamp,
        turn_id: "turn-contract-plan",
        resolved_settings: { runtime_model: "runtime-b", reasoning_effort: "low" },
        error: null
      },
      execution: {
        turn_id: "turn-contract-plan",
        state: "active",
        evidence: "plan_delta",
        summary: "Inspect the contracts.",
        updated_at: laterTimestamp
      },
      modes: [
        { name: "Plan", mode: "plan", preset_model: null, preset_reasoning_effort: "medium" },
        { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null }
      ]
    };
    expect(planControlSnapshotSchema.parse(snapshot)).toMatchObject({
      current: { state: "confirmed", mode: "default" },
      pending: { mode: "plan", phase: "awaiting_confirmation" },
      execution: { state: "active", evidence: "plan_delta" }
    });
    expect(() =>
      planControlSnapshotSchema.parse({
        ...snapshot,
        current: { ...snapshot.current, state: "unknown", mode: null }
      })
    ).toThrow();
    expect(() =>
      planControlSnapshotSchema.parse({
        ...snapshot,
        pending: { ...snapshot.pending, turn_id: null }
      })
    ).toThrow();
    expect(() =>
      planControlSnapshotSchema.parse({
        ...snapshot,
        execution: { ...snapshot.execution, evidence: "none" }
      })
    ).toThrow();
    expect(() =>
      planControlSnapshotSchema.parse({
        ...snapshot,
        modes: [snapshot.modes[0], { ...snapshot.modes[1], mode: "plan" }]
      })
    ).toThrow();
  });

  it("keeps accepted prompt turns distinct from event-proven steerability and ambiguity", () => {
    const accepted = {
      phase: "accepted",
      last_action: "start",
      operation_id: "op_contract_prompt1",
      turn_id: "turn-contract-prompt",
      model_revision: 2,
      plan_revision: null,
      requested_at: timestamp,
      accepted_at: laterTimestamp,
      started_at: null,
      error: null
    };
    expect(promptTurnControlSnapshotSchema.parse(accepted).phase).toBe("accepted");
    expect(
      promptTurnControlSnapshotSchema.parse({
        ...accepted,
        phase: "steerable",
        started_at: laterTimestamp
      }).phase
    ).toBe("steerable");
    expect(
      promptTurnControlSnapshotSchema.parse({
        ...accepted,
        phase: "steerable",
        last_action: "steer",
        requested_at: laterTimestamp,
        accepted_at: timestamp,
        started_at: timestamp
      }).last_action
    ).toBe("steer");
    expect(
      promptTurnControlSnapshotSchema.parse({
        ...accepted,
        phase: "unknown",
        turn_id: null,
        accepted_at: null,
        error: { code: "unknown_error", message: "Start outcome is unknown.", retryable: false }
      }).phase
    ).toBe("unknown");
    expect(() => promptTurnControlSnapshotSchema.parse({ ...accepted, phase: "steerable" })).toThrow();
    expect(() =>
      promptTurnControlSnapshotSchema.parse({
        ...accepted,
        phase: "starting",
        turn_id: "turn-impossible"
      })
    ).toThrow();
    expect(() => promptTurnControlSnapshotSchema.parse({ ...accepted, accepted_at: null })).toThrow();
    expect(() => promptTurnControlSnapshotSchema.parse({ ...accepted, last_action: "steer" })).toThrow();
    expect(() =>
      promptTurnControlSnapshotSchema.parse({
        ...accepted,
        phase: "conflict",
        error: { code: "operation_conflict", message: "Stale turn.", retryable: false }
      })
    ).toThrow();
    expect(() =>
      promptTurnControlSnapshotSchema.parse({ ...accepted, requested_at: laterTimestamp, accepted_at: timestamp })
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

    expect(() =>
      selectedOperationDispatchSchema.parse({
        operation_id: "op_contract_interrupt",
        kind: "interrupt",
        target,
        state: "accepted",
        accepted_at: timestamp,
        audit_record_id: "audit:contract:interrupt"
      })
    ).toThrow();

    expect(() =>
      selectedOperationTerminalOutcomeSchema.parse({
        operation_id: "op_contract_interrupt",
        kind: "interrupt",
        target: turnTarget,
        state: "succeeded",
        finished_at: laterTimestamp,
        turn_id: "turn-contract-other",
        result_summary: "Interrupted.",
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

    expect(() =>
      selectedSessionEventStreamSchema.parse({
        session_id: session.id,
        events: [{ ...event, cursor: Number.MAX_SAFE_INTEGER + 1 }],
        next_cursor: Number.MAX_SAFE_INTEGER + 1,
        truncated: false
      })
    ).toThrow();
  });

  it("rejects calendar-normalized timestamps at the selected contract boundary", () => {
    expect(
      managedSessionProjectionSchema.parse({
        ...session,
        updated_at: "2026-07-09T18:01:00.000+02:00"
      }).updated_at
    ).toBe(laterTimestamp);

    expect(() =>
      managedSessionProjectionSchema.parse({
        ...session,
        updated_at: "2026-02-29T16:00:00.000Z"
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

    expect(
      selectedAuditEventRecordSchema.parse({
        ...baseAudit,
        action: "interrupt",
        target: turnTarget,
        payload_summary: {},
        error_code: null
      }).target.type
    ).toBe("turn");
    expect(() =>
      selectedAuditEventRecordSchema.parse({
        ...baseAudit,
        action: "interrupt",
        target,
        payload_summary: {},
        error_code: null
      })
    ).toThrow();
  });

  it("keeps local CLI and remote dashboard audit authority distinct", () => {
    expect(
      selectedAuditActorSchema.parse({
        type: "cli",
        device_id: null,
        permission: "local_admin",
        origin: null
      }).type
    ).toBe("cli");
    expect(() =>
      selectedAuditActorSchema.parse({
        type: "cli",
        device_id: "device:unexpected",
        permission: "local_admin",
        origin: "https://hostdeck.local"
      })
    ).toThrow();
    expect(() =>
      selectedAuditActorSchema.parse({
        type: "dashboard",
        device_id: "device:contract:1",
        permission: "local_admin",
        origin: "https://hostdeck.local"
      })
    ).toThrow();
  });

  it("requires exact device and host targets for non-session audit actions", () => {
    const base = {
      id: "audit:contract:host",
      operation_id: "op_contract_host01",
      at: timestamp,
      actor: {
        type: "cli",
        device_id: null,
        permission: "local_admin",
        origin: null
      },
      phase: "accepted",
      outcome: "accepted",
      payload_summary: {},
      error_code: null
    } as const;

    expect(
      selectedAuditEventRecordSchema.parse({
        ...base,
        action: "device_revoke",
        target: { type: "device", device_id: "device:contract:1" }
      }).target.type
    ).toBe("device");
    expect(
      selectedAuditEventRecordSchema.parse({
        ...base,
        action: "lock",
        target: { type: "host", host_id: "local_host" }
      }).target.type
    ).toBe("host");
    expect(() =>
      selectedAuditEventRecordSchema.parse({
        ...base,
        action: "device_revoke",
        target: { type: "host", host_id: "local_host" }
      })
    ).toThrow();
  });

  it("accepts only coherent accepted-to-terminal audit trails", () => {
    const accepted = {
      id: "audit:contract:accepted",
      operation_id: "op_contract_trail1",
      at: timestamp,
      actor: {
        type: "dashboard",
        device_id: "device:contract:1",
        permission: "write",
        origin: "https://hostdeck.local"
      },
      action: "prompt",
      target,
      phase: "accepted",
      outcome: "accepted",
      payload_summary: { text_length: 8 },
      error_code: null
    } as const;
    const terminal = {
      ...accepted,
      id: "audit:contract:terminal",
      at: laterTimestamp,
      phase: "terminal",
      outcome: "succeeded"
    } as const;

    expect(
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, terminal]
      }).state
    ).toBe("terminal");
    expect(
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [
          accepted,
          {
            ...terminal,
            outcome: "incomplete",
            error_code: "runtime_unavailable"
          }
        ]
      }).records[1]
    ).toMatchObject({ outcome: "incomplete", error_code: "runtime_unavailable" });
    expect(
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, { ...terminal, at: timestamp }]
      }).state
    ).toBe("terminal");
    expect(
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, { ...terminal, at: "2026-07-09T12:01:00.000-04:00" }]
      }).state
    ).toBe("terminal");
    expect(
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "pending",
        records: [accepted]
      }).state
    ).toBe("pending");

    const rejected = {
      ...accepted,
      id: "audit:contract:rejected",
      phase: "terminal",
      outcome: "rejected",
      error_code: "validation_error"
    } as const;
    expect(
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [rejected]
      }).records
    ).toHaveLength(1);

    expect(() =>
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted]
      })
    ).toThrow();

    expect(() =>
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, { ...terminal, operation_id: "op_contract_other1" }]
      })
    ).toThrow();

    expect(() =>
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [terminal, accepted]
      })
    ).toThrow();

    expect(() =>
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, rejected]
      })
    ).toThrow();

    expect(() =>
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, { ...terminal, id: accepted.id }]
      })
    ).toThrow();

    expect(() =>
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, { ...terminal, at: "2026-07-09T15:59:59.999Z" }]
      })
    ).toThrow();
    expect(() =>
      selectedAuditTrailSchema.parse({
        operation_id: accepted.operation_id,
        state: "terminal",
        records: [accepted, { ...terminal, at: "2026-07-09T17:59:59.999+02:00" }]
      })
    ).toThrow();
  });
});
