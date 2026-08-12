import { persistedSelectedAuditActions, selectedAuditActions } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  nativeCodexAdoptionSnapshotSchema,
  nativeCodexThreadIdentitySchema,
  nativeSessionAdoptRequestSchema,
  nativeSessionDiscoveryRequestSchema,
  nativeSessionDiscoveryResponseSchema,
  nativeSessionUnmanageRequestSchema,
  nativeSessionUnmanageResponseSchema
} from "./native-session.js";
import {
  selectedNativeSessionAdoptionAuditEventRecordSchema,
  selectedNativeSessionUnmanageAuditEventRecordSchema
} from "./selected-storage.js";

const createdAt = "2026-08-12T12:00:00.000Z";
const updatedAt = "2026-08-12T12:10:00.000Z";
const threadId = "019ff711-d30a-7c92-98dc-6d770ccb6218";
const operationId = "op_native_session_contract_0001";

describe("native Codex session contracts", () => {
  it("accepts only a quiet persisted root CLI identity without path or preview disclosure", () => {
    const identity = nativeIdentity();
    expect(nativeCodexThreadIdentitySchema.parse(identity)).toEqual(identity);

    for (const candidate of [
      { ...identity, source: "appServer" },
      { ...identity, status: "active" },
      { ...identity, archived: true },
      { ...identity, ephemeral: true },
      { ...identity, parent_thread_id: "parent-thread" },
      { ...identity, forked_from_id: "fork-thread" },
      { ...identity, runtime_version: "not-a-version" },
      { ...identity, cwd: "relative/path" },
      { ...identity, updated_at: "2026-08-12T11:59:59.000Z" },
      { ...identity, preview: "private prompt" },
      { ...identity, path: "/private/rollout.jsonl" }
    ]) {
      expect(() => nativeCodexThreadIdentitySchema.parse(candidate)).toThrow();
    }
  });

  it("bounds discovery and enforces unique deterministic newest-first candidates", () => {
    expect(nativeSessionDiscoveryRequestSchema.parse({})).toEqual({});
    expect(nativeSessionDiscoveryRequestSchema.parse({ limit: 20 })).toEqual({ limit: 20 });
    for (const candidate of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 1, cursor: "raw" }]) {
      expect(() => nativeSessionDiscoveryRequestSchema.parse(candidate)).toThrow();
    }

    const older = {
      ...nativeIdentity(),
      thread_id: "019ff710-d30a-7c92-98dc-6d770ccb6218",
      updated_at: "2026-08-12T12:05:00.000Z"
    };
    const response = { limit: 2, threads: [nativeIdentity(), older], truncated: false };
    expect(nativeSessionDiscoveryResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      nativeSessionDiscoveryResponseSchema.parse({ ...response, threads: [older, nativeIdentity()] })
    ).toThrow();
    expect(() =>
      nativeSessionDiscoveryResponseSchema.parse({ ...response, threads: [nativeIdentity(), nativeIdentity()] })
    ).toThrow();
    expect(() => nativeSessionDiscoveryResponseSchema.parse({ ...response, limit: 1 })).toThrow();
  });

  it("requires an explicit handoff and a unique alias for exact-id adoption", () => {
    const request = {
      operation_id: operationId,
      thread_id: threadId,
      name: "existing-session",
      confirm_handoff: true
    };
    expect(nativeSessionAdoptRequestSchema.parse(request)).toEqual(request);
    for (const candidate of [
      { ...request, confirm_handoff: false },
      { ...request, confirm_handoff: undefined },
      { ...request, thread_id: "" },
      { ...request, name: "bad name" },
      { ...request, cwd: "/private" },
      { ...request, copy_history: true }
    ]) {
      expect(() => nativeSessionAdoptRequestSchema.parse(candidate)).toThrow();
    }
  });

  it("admits only bounded chronological terminal user and agent history", () => {
    const snapshot = {
      thread: nativeIdentity(),
      turns: [
        {
          turn_id: "turn-native-0001",
          status: "completed",
          started_at: "2026-08-12T12:01:00.000Z",
          completed_at: "2026-08-12T12:02:00.000Z",
          messages: [
            { item_id: "item-native-user-0001", role: "user", text: "First question" },
            { item_id: "item-native-agent-0001", role: "agent", text: "First answer" }
          ]
        },
        {
          turn_id: "turn-native-0002",
          status: "interrupted",
          started_at: "2026-08-12T12:03:00.000Z",
          completed_at: "2026-08-12T12:04:00.000Z",
          messages: [{ item_id: "item-native-user-0002", role: "user", text: "Continue" }]
        }
      ],
      truncated_before: true
    };
    expect(nativeCodexAdoptionSnapshotSchema.parse(snapshot)).toEqual(snapshot);

    const first = snapshot.turns[0];
    const second = snapshot.turns[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    for (const candidate of [
      { ...snapshot, turns: [{ ...first, status: "in_progress" }] },
      { ...snapshot, turns: [{ ...first, completed_at: "2026-08-12T12:00:59.000Z" }] },
      { ...snapshot, turns: [second, first] },
      { ...snapshot, turns: [first, { ...second, turn_id: first.turn_id }] },
      {
        ...snapshot,
        turns: [first, { ...second, messages: [{ ...second.messages[0], item_id: first.messages[0]?.item_id }] }]
      },
      {
        ...snapshot,
        turns: [{ ...first, messages: [{ item_id: "item-native-tool-0001", role: "tool", text: "private" }] }]
      },
      {
        ...snapshot,
        turns: [{ ...first, messages: [{ item_id: "item-native-empty-0001", role: "agent", text: "" }] }]
      }
    ]) {
      expect(() => nativeCodexAdoptionSnapshotSchema.parse(candidate)).toThrow();
    }
  });

  it("requires confirmed non-destructive unmanage and returns only stable identity", () => {
    const request = { operation_id: operationId, confirm: true };
    expect(nativeSessionUnmanageRequestSchema.parse(request)).toEqual(request);
    expect(() => nativeSessionUnmanageRequestSchema.parse({ ...request, confirm: false })).toThrow();
    expect(() => nativeSessionUnmanageRequestSchema.parse({ ...request, archive: true })).toThrow();

    const response = {
      operation_id: operationId,
      session_id: "sess_native_contract_0001",
      codex_thread_id: threadId,
      unmanaged_at: updatedAt
    };
    expect(nativeSessionUnmanageResponseSchema.parse(response)).toEqual(response);
    expect(() => nativeSessionUnmanageResponseSchema.parse({ ...response, deleted: true })).toThrow();
  });

  it("freezes local lifecycle audit actions and secret-free phase summaries", () => {
    expect(selectedAuditActions.filter((action) => action === "session_adopt")).toEqual(["session_adopt"]);
    expect(selectedAuditActions.filter((action) => action === "session_unmanage")).toEqual(["session_unmanage"]);
    expect(persistedSelectedAuditActions.filter((action) => action === "session_adopt")).toEqual(["session_adopt"]);
    expect(persistedSelectedAuditActions.filter((action) => action === "session_unmanage")).toEqual(["session_unmanage"]);

    const adoptAccepted = auditRecord("session_adopt", "accepted", "accepted", {
      schema_version: 1,
      handoff_confirmed: true,
      name_length: 16
    });
    const adoptSucceeded = auditRecord("session_adopt", "terminal", "succeeded", {
      schema_version: 1,
      history_turn_count: 2,
      adopted: true
    });
    const unmanageAccepted = auditRecord("session_unmanage", "accepted", "accepted", {
      schema_version: 1,
      confirm: true
    });
    const unmanageSucceeded = auditRecord("session_unmanage", "terminal", "succeeded", {
      schema_version: 1,
      unmanaged: true
    });
    expect(selectedNativeSessionAdoptionAuditEventRecordSchema.parse(adoptAccepted)).toEqual(adoptAccepted);
    expect(selectedNativeSessionAdoptionAuditEventRecordSchema.parse(adoptSucceeded)).toEqual(adoptSucceeded);
    expect(selectedNativeSessionUnmanageAuditEventRecordSchema.parse(unmanageAccepted)).toEqual(unmanageAccepted);
    expect(selectedNativeSessionUnmanageAuditEventRecordSchema.parse(unmanageSucceeded)).toEqual(unmanageSucceeded);

    for (const candidate of [
      { ...adoptAccepted, actor: { type: "dashboard", device_id: "device-a", permission: "write", origin: "https://host.test" } },
      { ...adoptAccepted, target: managedTarget() },
      { ...adoptAccepted, payload_summary: { ...adoptAccepted.payload_summary, cwd: "/private" } },
      { ...adoptSucceeded, payload_summary: { schema_version: 1, adopted: true, history_turn_count: 2, preview: "secret" } }
    ]) {
      expect(() => selectedNativeSessionAdoptionAuditEventRecordSchema.parse(candidate)).toThrow();
    }
    expect(() =>
      selectedNativeSessionUnmanageAuditEventRecordSchema.parse({ ...unmanageAccepted, target: nativeTarget() })
    ).toThrow();
  });
});

function nativeIdentity() {
  return {
    thread_id: threadId,
    cwd: "/tmp/native-session-contract",
    source: "cli" as const,
    runtime_version: "0.144.0",
    created_at: createdAt,
    updated_at: updatedAt,
    status: "idle" as const,
    archived: false as const,
    ephemeral: false as const,
    parent_thread_id: null,
    forked_from_id: null,
    history_mode: "legacy" as const
  };
}

function nativeTarget() {
  return { type: "native_codex_thread" as const, codex_thread_id: threadId };
}

function managedTarget() {
  return {
    type: "managed_session" as const,
    session_id: "sess_native_contract_0001",
    codex_thread_id: threadId
  };
}

function auditRecord(
  action: "session_adopt" | "session_unmanage",
  phase: "accepted" | "terminal",
  outcome: "accepted" | "succeeded",
  payloadSummary: Readonly<Record<string, unknown>>
) {
  return {
    id: `audit:${action}:${phase}:${outcome}`,
    operation_id: operationId,
    at: updatedAt,
    actor: { type: "cli" as const, device_id: null, permission: "local_admin" as const, origin: null },
    action,
    target: action === "session_adopt" ? nativeTarget() : managedTarget(),
    phase,
    outcome,
    payload_summary: payloadSummary,
    error_code: null
  };
}
