import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SelectedAuditTarget,
  selectedAuditTargetSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHostDeckSelectedWriteAuditExecutor,
  createHostDeckSelectedWriteAuditExecutor,
  type HostDeckSelectedWriteAuditAction,
  hostDeckSelectedWriteAuditActions
} from "./selected-write-audit-executor.js";

const tempDirectories: string[] = [];
const closeDatabases: Array<() => void> = [];
const acceptedAt = "2026-07-15T14:00:00.000Z";
const terminalAt = "2026-07-15T14:00:01.000Z";

afterEach(() => {
  for (const close of closeDatabases.splice(0)) close();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected non-security write audit executor", () => {
  it("requires exact branded construction and exposes bounded frozen diagnostics", () => {
    const fixture = createFixture();
    expect(Object.isFrozen(fixture.executor)).toBe(true);
    expect(() => assertHostDeckSelectedWriteAuditExecutor(fixture.executor)).not.toThrow();
    expect(() => assertHostDeckSelectedWriteAuditExecutor({ ...fixture.executor })).toThrow();

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "repository", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private-accessor-sentinel");
      }
    });
    for (const candidate of [
      null,
      {},
      { repository: fixture.repository, now: fixture.now, create_record_id: fixture.createRecordId, extra: true },
      { repository: {}, now: fixture.now, create_record_id: fixture.createRecordId },
      { repository: fixture.repository, now: null, create_record_id: fixture.createRecordId },
      accessor
    ]) {
      expect(() => createHostDeckSelectedWriteAuditExecutor(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
    expect(fixture.executor.snapshot()).toEqual({
      accepted_operations: 0,
      failed_operations: 0,
      incomplete_operations: 0,
      response_preparation_failures: 0,
      succeeded_operations: 0,
      terminal_audit_failures: 0,
      transition_contract_failures: 0
    });
    expect(Object.isFrozen(fixture.executor.snapshot())).toBe(true);
  });

  it("rejects accessor-bearing or contradictory execution input before audit and transition", async () => {
    const fixture = createFixture();
    let transitionCalls = 0;
    let accessorCalls = 0;
    const valid = {
      ...startInput("op_selected_write_executor_invalid_input"),
      transition: () => {
        transitionCalls += 1;
        return Object.freeze({
          outcome: "succeeded" as const,
          payload_summary: Object.freeze({ schema_version: 1, created: true }),
          response: Object.freeze({ ok: true })
        });
      },
      prepare_response: (response: unknown) => response
    };
    const accessor = Object.defineProperty(
      { ...valid },
      "accepted_summary",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("execution-accessor-private-sentinel");
        }
      }
    );
    const candidates = [
      { ...valid, extra: true },
      {
        ...valid,
        actor: {
          type: "dashboard",
          device_id: "client_read_only",
          permission: "read",
          origin: "https://hostdeck.test"
        }
      },
      {
        ...valid,
        target: {
          type: "managed_session",
          session_id: "sess_wrong_target",
          codex_thread_id: "thread-wrong-target"
        }
      },
      {
        ...valid,
        accepted_summary: {
          schema_version: 1,
          name_length: 12,
          cwd_present: true,
          cwd: "/private"
        }
      },
      { ...valid, emergency_lock_on_audit_unavailable: true },
      { ...valid, transition: null },
      { ...valid, prepare_response: null },
      accessor
    ];
    for (const candidate of candidates) {
      await expect(
        fixture.executor.execute(candidate as never)
      ).rejects.toMatchObject({
        code: "invalid_input",
        mutation_outcome: "not_started",
        audit_state: "none",
        retry_safe: true
      });
    }
    expect(accessorCalls).toBe(0);
    expect(transitionCalls).toBe(0);
    expect(
      fixture.repository.get("op_selected_write_executor_invalid_input")
    ).toBeNull();
  });

  it("requires exact accepted and terminal repository proof and suppresses unproven responses", async () => {
    const fixture = createFixture();
    let acceptedTransitions = 0;
    const acceptedRepository: SelectedAuditRepository = {
      ...fixture.repository,
      recordAccepted(record) {
        fixture.repository.recordAccepted(record);
        return Object.freeze({}) as never;
      }
    };
    const acceptedExecutor = createHostDeckSelectedWriteAuditExecutor({
      repository: acceptedRepository,
      now: fixture.now,
      create_record_id: fixture.createRecordId
    });
    const acceptedOperation = "op_selected_write_executor_unproven_accepted";
    await expect(
      acceptedExecutor.execute({
        ...startInput(acceptedOperation),
        transition: () => {
          acceptedTransitions += 1;
          return Object.freeze({
            outcome: "succeeded" as const,
            payload_summary: Object.freeze({ schema_version: 1, created: true }),
            response: Object.freeze({ ok: true })
          });
        },
        prepare_response: (response) => response
      })
    ).rejects.toMatchObject({
      code: "audit_preflight_failed",
      mutation_outcome: "not_started",
      audit_state: "unproven"
    });
    expect(acceptedTransitions).toBe(0);
    expect(fixture.repository.require(acceptedOperation)).toMatchObject({
      state: "pending",
      records: [{ phase: "accepted" }]
    });

    const terminalRepository: SelectedAuditRepository = {
      ...fixture.repository,
      recordTerminal(record) {
        fixture.repository.recordTerminal(record);
        return Object.freeze({}) as never;
      }
    };
    let terminalClockCalls = 0;
    const terminalExecutor = createHostDeckSelectedWriteAuditExecutor({
      repository: terminalRepository,
      now: () =>
        terminalClockCalls++ === 0 ? acceptedAt : terminalAt,
      create_record_id: fixture.createRecordId
    });
    const terminalOperation = "op_selected_write_executor_unproven_terminal";
    await expect(
      terminalExecutor.execute({
        ...startInput(terminalOperation),
        transition: () => Object.freeze({
          outcome: "succeeded" as const,
          payload_summary: Object.freeze({ schema_version: 1, created: true }),
          response: Object.freeze({ private: "must-not-return" })
        }),
        prepare_response: (response) => response
      })
    ).rejects.toMatchObject({
      code: "terminal_audit_failed",
      mutation_outcome: "succeeded",
      audit_state: "unproven",
      retry_safe: false
    });
    expect(fixture.repository.require(terminalOperation)).toMatchObject({
      state: "terminal",
      records: [{ phase: "accepted" }, { phase: "terminal", outcome: "succeeded" }]
    });
  });

  it("executes every common selected write action accepted-to-succeeded exactly once", async () => {
    expect(hostDeckSelectedWriteAuditActions).toEqual([
      "session_start",
      "prompt",
      "model",
      "goal",
      "plan",
      "compact",
      "approval_response",
      "interrupt",
      "archive"
    ]);
    const fixture = createFixture();
    let transitionCalls = 0;
    let prepareCalls = 0;
    for (const [index, action] of hostDeckSelectedWriteAuditActions.entries()) {
      const result = await fixture.executor.execute({
        operation_id: `op_selected_write_executor_${action}_${index}`,
        actor: cliActor(),
        action,
        target: targetFor(action, index),
        accepted_summary: acceptedSummary(action),
        emergency_lock_on_audit_unavailable: false,
        transition(context) {
          transitionCalls += 1;
          expect(context).toEqual({
            audit_state: "accepted",
            audit_record_id: `audit:selected-write:${index * 2 + 1}`,
            accepted_at: acceptedAt
          });
          expect(Object.isFrozen(context)).toBe(true);
          return Object.freeze({
            outcome: "succeeded" as const,
            payload_summary: successSummary(action),
            response: Object.freeze({ action })
          });
        },
        prepare_response(response) {
          prepareCalls += 1;
          return Object.freeze({ ...response, prepared: true });
        }
      });
      expect(result).toEqual({ outcome: "succeeded", response: { action, prepared: true } });
      expect(fixture.repository.require(`op_selected_write_executor_${action}_${index}`)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted", action },
          { phase: "terminal", outcome: "succeeded", action }
        ]
      });
    }
    expect(transitionCalls).toBe(hostDeckSelectedWriteAuditActions.length);
    expect(prepareCalls).toBe(hostDeckSelectedWriteAuditActions.length);
    expect(fixture.executor.snapshot()).toMatchObject({
      accepted_operations: hostDeckSelectedWriteAuditActions.length,
      succeeded_operations: hostDeckSelectedWriteAuditActions.length
    });
  });

  it("records explicit failed/incomplete and converts throw or malformed output to fixed incomplete", async () => {
    const fixture = createFixture();
    for (const [index, [outcome, code]] of [
      ["failed", "duplicate_session_name"],
      ["incomplete", "runtime_unavailable"]
    ].entries() as IterableIterator<[number, ["failed" | "incomplete", ErrorCode]]>) {
      const operationId = `op_selected_write_executor_explicit_${index}`;
      await expect(
        fixture.executor.execute({
          ...startInput(operationId),
          transition: () => Object.freeze({
            outcome,
            error_code: code,
            payload_summary: Object.freeze({ schema_version: 1 })
          }),
          prepare_response: () => {
            throw new Error("must-not-prepare");
          }
        })
      ).resolves.toEqual({ outcome, error_code: code });
      expect(fixture.repository.require(operationId).records[1]).toMatchObject({ outcome, error_code: code });
    }

    for (const [index, transition] of [
      () => {
        throw new Error("transition-private-sentinel");
      },
      () => ({ outcome: "succeeded" as const, payload_summary: { schema_version: 1, created: true, cwd: "/private" }, response: {} })
    ].entries()) {
      const operationId = `op_selected_write_executor_unknown_${index}`;
      await expect(
        fixture.executor.execute({
          ...startInput(operationId),
          transition,
          prepare_response: (response) => response
        })
      ).rejects.toMatchObject({
        code: index === 0 ? "transition_failed" : "transition_result_invalid",
        mutation_outcome: "incomplete",
        audit_state: "terminal",
        retry_safe: false
      });
      expect(fixture.repository.require(operationId).records[1]).toMatchObject({
        outcome: "incomplete",
        error_code: "internal_error",
        payload_summary: { schema_version: 1 }
      });
    }
    expect(JSON.stringify(fixture.executor.snapshot())).not.toMatch(/private|cwd|sentinel/iu);
  });

  it("preserves succeeded mutation truth when response preparation fails", async () => {
    const fixture = createFixture();
    const operationId = "op_selected_write_executor_response_failure";
    await expect(
      fixture.executor.execute({
        ...startInput(operationId),
        transition: () => Object.freeze({
          outcome: "succeeded" as const,
          payload_summary: Object.freeze({ schema_version: 1, created: true }),
          response: Object.freeze({ private: "response-private-sentinel" })
        }),
        prepare_response: () => {
          throw new Error("preparation-private-sentinel");
        }
      })
    ).rejects.toMatchObject({
      code: "response_preparation_failed",
      mutation_outcome: "succeeded",
      audit_state: "terminal",
      retry_safe: false
    });
    expect(fixture.repository.require(operationId).records[1]).toMatchObject({
      outcome: "succeeded",
      payload_summary: { schema_version: 1, created: true }
    });
    expect(JSON.stringify(fixture.repository.require(operationId))).not.toContain("private-sentinel");
  });

  it("dispatches one same-operation winner and leaves terminal-audit failure explicit", async () => {
    const fixture = createFixture();
    let transitions = 0;
    const operationId = "op_selected_write_executor_contention";
    const execute = () =>
      fixture.executor.execute({
        ...startInput(operationId),
        transition: () => {
          transitions += 1;
          return Object.freeze({
            outcome: "succeeded" as const,
            payload_summary: Object.freeze({ schema_version: 1, created: true }),
            response: Object.freeze({ ok: true })
          });
        },
        prepare_response: (response) => response
      });
    const results = await Promise.allSettled([execute(), execute()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "audit_preflight_failed", api_code: "operation_conflict" }
    });
    expect(transitions).toBe(1);

    const terminalFailureRepository: SelectedAuditRepository = {
      ...fixture.repository,
      recordTerminal() {
        throw new HostDeckSelectedAuditRepositoryError(
          "audit_write_failed",
          "terminal-private-sentinel"
        );
      }
    };
    const terminalFailure = createHostDeckSelectedWriteAuditExecutor({
      repository: terminalFailureRepository,
      now: fixture.now,
      create_record_id: fixture.createRecordId
    });
    await expect(
      terminalFailure.execute({
        ...startInput("op_selected_write_executor_terminal_failure"),
        transition: () => Object.freeze({
          outcome: "succeeded" as const,
          payload_summary: Object.freeze({ schema_version: 1, created: true }),
          response: Object.freeze({ ok: true })
        }),
        prepare_response: (response) => response
      })
    ).rejects.toMatchObject({
      code: "terminal_audit_failed",
      mutation_outcome: "succeeded",
      audit_state: "pending",
      retry_safe: false
    });
    expect(
      fixture.repository.require("op_selected_write_executor_terminal_failure")
    ).toMatchObject({ state: "pending", records: [{ phase: "accepted" }] });
  });
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-selected-write-audit-"));
  tempDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(acceptedAt) });
  closeDatabases.push(() => open.db.close());
  const repository = createSelectedAuditRepository(open.db);
  let clockCalls = 0;
  let recordId = 0;
  const now = () => (clockCalls++ % 2 === 0 ? acceptedAt : terminalAt);
  const createRecordId = () => `audit:selected-write:${++recordId}`;
  const executor = createHostDeckSelectedWriteAuditExecutor({
    repository,
    now,
    create_record_id: createRecordId
  });
  return { repository, executor, now, createRecordId };
}

function startInput(operationId: string) {
  return {
    operation_id: operationId,
    actor: cliActor(),
    action: "session_start" as const,
    target: { type: "host" as const, host_id: "local_host" as const },
    accepted_summary: Object.freeze({ schema_version: 1, name_length: 12, cwd_present: true }),
    emergency_lock_on_audit_unavailable: false as const
  };
}

function cliActor() {
  return {
    type: "cli" as const,
    device_id: null,
    permission: "local_admin" as const,
    origin: null
  };
}

function targetFor(action: HostDeckSelectedWriteAuditAction, index: number): SelectedAuditTarget {
  if (action === "session_start") {
    return selectedAuditTargetSchema.parse({ type: "host", host_id: "local_host" });
  }
  if (action === "approval_response") {
    return selectedAuditTargetSchema.parse({
      type: "approval",
      session_id: `sess_selected_write_${index}`,
      codex_thread_id: `thread-selected-write-${index}`,
      request_id: `request-selected-write-${index}`
    });
  }
  if (action === "interrupt") {
    return selectedAuditTargetSchema.parse({
      type: "turn",
      session_id: `sess_selected_write_${index}`,
      codex_thread_id: `thread-selected-write-${index}`,
      turn_id: `turn-selected-write-${index}`
    });
  }
  return selectedAuditTargetSchema.parse({
    type: "managed_session",
    session_id: `sess_selected_write_${index}`,
    codex_thread_id: `thread-selected-write-${index}`
  });
}

function acceptedSummary(action: HostDeckSelectedWriteAuditAction) {
  const summaries = {
    session_start: { schema_version: 1, name_length: 12, cwd_present: true },
    prompt: { schema_version: 1, text_length: 12 },
    model: { schema_version: 1, model_id: "gpt-test", reasoning_effort: null, expected_revision_present: false },
    goal: { schema_version: 1, goal_action: "set", objective_length: 12, expected_revision_present: false },
    plan: { schema_version: 1, plan_action: "enter", expected_revision_present: false },
    compact: { schema_version: 1, confirmed: true },
    approval_response: { schema_version: 1, decision: "approve", confirmed: true },
    interrupt: { schema_version: 1, confirmed: true },
    archive: { schema_version: 1, confirmed: true }
  } as const;
  return Object.freeze(summaries[action]);
}

function successSummary(action: HostDeckSelectedWriteAuditAction) {
  const summaries = {
    session_start: { schema_version: 1, created: true },
    prompt: { schema_version: 1, accepted: true },
    model: { schema_version: 1, changed: true },
    goal: { schema_version: 1, changed: true },
    plan: { schema_version: 1, changed: true },
    compact: { schema_version: 1, accepted: true },
    approval_response: { schema_version: 1, applied: true },
    interrupt: { schema_version: 1, interrupted: true },
    archive: { schema_version: 1, archived: true }
  } as const;
  return Object.freeze(summaries[action]);
}
