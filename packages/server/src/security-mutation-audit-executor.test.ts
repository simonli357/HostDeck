import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelectedAuditActor, SelectedAuditTarget } from "@hostdeck/contracts";
import {
  type ErrorCode,
  type SelectedSecurityAuditAction,
  selectedSecurityAuditActions
} from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  reconcileSelectedAuditOrphansBatch,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHostDeckSecurityMutationAuditExecutor,
  createSecurityMutationAuditExecutor,
  type ExecuteSecurityMutationInput,
  HostDeckSecurityMutationAuditExecutorError,
  type SecurityMutationAuditContext,
  type SecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";

const tempDirs: string[] = [];
const baseTime = Date.parse("2026-07-11T21:00:00.000Z");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected security mutation audit executor", () => {
  it("requires an exact repository/clock/id port and returns one frozen narrow executor", () => {
    const harness = openHarness();
    try {
      expect(Object.keys(harness.executor).sort()).toEqual(["execute", "reject", "snapshot"]);
      expect(Object.isFrozen(harness.executor)).toBe(true);
      expect(Object.isFrozen(harness.executor.snapshot())).toBe(true);
      expect(() =>
        assertHostDeckSecurityMutationAuditExecutor(harness.executor)
      ).not.toThrow();
      for (const forged of [
        null,
        {},
        Object.freeze({ ...harness.executor }),
        new Proxy(harness.executor, {})
      ]) {
        expect(() => assertHostDeckSecurityMutationAuditExecutor(forged)).toThrow(
          TypeError
        );
      }

      const valid = {
        repository: harness.repository,
        now: () => isoAt(0),
        create_record_id: () => "audit:executor:constructor"
      };
      const accessorRepository = Object.defineProperty(
        {
          get: harness.repository.get,
          require: harness.repository.require,
          recordRejected: harness.repository.recordRejected,
          recordTerminal: harness.repository.recordTerminal
        },
        "recordAccepted",
        {
          enumerable: true,
          get() {
            throw new Error("constructor-accessor-sentinel");
          }
        }
      );
      class RepositoryPrototype {
        get = harness.repository.get;
        require = harness.repository.require;
        recordAccepted = harness.repository.recordAccepted;
        recordRejected = harness.repository.recordRejected;
        recordTerminal = harness.repository.recordTerminal;
      }

      for (const candidate of [
        null,
        {},
        { ...valid, extra: true },
        { ...valid, now: null },
        { ...valid, create_record_id: null },
        { ...valid, repository: {} },
        { ...valid, repository: accessorRepository },
        { ...valid, repository: new RepositoryPrototype() }
      ]) {
        expect(() => createSecurityMutationAuditExecutor(candidate as never)).toThrow(TypeError);
      }
    } finally {
      harness.close();
    }
  });

  it("executes all ten selected security actions only after accepted commit and terminal proof", async () => {
    const events: string[] = [];
    const harness = openHarness((repository) => observingRepository(repository, events));
    try {
      const cases = securityCases();
      expect(cases.map((definition) => definition.action)).toEqual(selectedSecurityAuditActions);

      for (const [index, definition] of cases.entries()) {
        events.length = 0;
        const operationId = operationIdFor(index);
        const response = Object.freeze({ action: definition.action, value: `response_${index}` });
        const result = await harness.executor.execute(
          executionInput(definition, index, {
            transition(context) {
              events.push(`transition:${context.audit_state}`);
              expect(Object.isFrozen(context)).toBe(true);
              expect(harness.repository.require(operationId)).toMatchObject({ state: "pending" });
              return { outcome: "succeeded", payload_summary: definition.success, response };
            },
            prepare_response(value) {
              events.push("prepare");
              expect(value).toBe(response);
              return JSON.stringify(value);
            }
          })
        );

        expect(result).toEqual({ outcome: "succeeded", response: JSON.stringify(response) });
        expect(Object.isFrozen(result)).toBe(true);
        expect(events).toEqual(["accepted", "transition:accepted", "prepare", "terminal"]);
        expect(harness.repository.require(operationId).records).toMatchObject([
          { action: definition.action, outcome: "accepted", payload_summary: definition.intent },
          { action: definition.action, outcome: "succeeded", payload_summary: definition.success }
        ]);
      }

      expect(harness.executor.snapshot()).toEqual({
        accepted_operations: 10,
        emergency_lock_audit_deferrals: 0,
        failed_operations: 0,
        incomplete_operations: 0,
        rejected_operations: 0,
        response_preparation_failures: 0,
        succeeded_operations: 10,
        terminal_audit_failures: 0,
        transition_contract_failures: 0
      });
    } finally {
      harness.close();
    }
  });

  it("records standalone rejection plus explicit failed and incomplete terminal outcomes", async () => {
    const harness = openHarness();
    try {
      const claim = securityCases()[1] as SecurityCase;
      const rejected = harness.executor.reject({
        operation_id: "op_security_executor_rejected",
        actor: claim.actor,
        action: claim.action,
        target: claim.target,
        payload_summary: { schema_version: 1 },
        error_code: "rate_limited"
      });
      expect(rejected).toEqual({ outcome: "rejected", error_code: "rate_limited" });
      expect(Object.isFrozen(rejected)).toBe(true);
      expect(harness.repository.require("op_security_executor_rejected")).toMatchObject({
        state: "terminal",
        records: [{ outcome: "rejected", error_code: "rate_limited" }]
      });

      let prepareCalls = 0;
      const lock = securityCases()[4] as SecurityCase;
      const failed = await harness.executor.execute(
        executionInput(lock, 20, {
          transition: () => ({
            outcome: "failed",
            error_code: "storage_error",
            payload_summary: { schema_version: 1 }
          }),
          prepare_response: () => {
            prepareCalls += 1;
            return "not-used";
          }
        })
      );
      expect(failed).toEqual({ outcome: "failed", error_code: "storage_error" });
      expect(Object.isFrozen(failed)).toBe(true);

      const rotate = securityCases()[9] as SecurityCase;
      const incomplete = await harness.executor.execute(
        executionInput(rotate, 21, {
          transition: () => ({
            outcome: "incomplete",
            error_code: "runtime_unavailable",
            payload_summary: { schema_version: 1 }
          }),
          prepare_response: () => {
            prepareCalls += 1;
            return "not-used";
          }
        })
      );
      expect(incomplete).toEqual({ outcome: "incomplete", error_code: "runtime_unavailable" });
      expect(prepareCalls).toBe(0);
      expect(harness.executor.snapshot()).toMatchObject({
        accepted_operations: 2,
        failed_operations: 1,
        incomplete_operations: 1,
        rejected_operations: 1
      });
    } finally {
      harness.close();
    }
  });

  it("never claims rejection persistence after repository unavailability or a forged returned trail", () => {
    const definition = securityCases()[1] as SecurityCase;
    const input = {
      operation_id: "op_security_executor_rejection_failure",
      actor: definition.actor,
      action: definition.action,
      target: definition.target,
      payload_summary: { schema_version: 1 },
      error_code: "rate_limited" as ErrorCode
    };

    const unavailable = openHarness((repository) =>
      repositoryWith(repository, {
        recordRejected() {
          throw new HostDeckSelectedAuditRepositoryError("audit_unavailable", "PRIVATE_REJECTION_SENTINEL");
        }
      })
    );
    try {
      const error = captureSyncExecutorError(() => unavailable.executor.reject(input));
      expect(error).toMatchObject({
        code: "rejection_audit_failed",
        api_code: "audit_unavailable",
        audit_state: "none",
        mutation_outcome: "not_started",
        retry_safe: true
      });
      expect(String(error)).not.toContain("PRIVATE_REJECTION_SENTINEL");
      expect(rawRowCount(unavailable.open.db)).toBe(0);
    } finally {
      unavailable.close();
    }

    const forged = openHarness((repository) =>
      repositoryWith(repository, {
        recordRejected(record) {
          const trail = repository.recordRejected(record);
          return { ...trail, state: "pending" } as never;
        }
      })
    );
    try {
      const error = captureSyncExecutorError(() =>
        forged.executor.reject({ ...input, operation_id: "op_security_executor_rejection_forged" })
      );
      expect(error).toMatchObject({ code: "rejection_audit_failed", audit_state: "unproven" });
      expect(forged.repository.require("op_security_executor_rejection_forged").state).toBe("terminal");
    } finally {
      forged.close();
    }
  });

  it("rejects malformed/accessor/secret input before clock, id, repository, or transition work", async () => {
    let repositoryCalls = 0;
    let clockCalls = 0;
    let idCalls = 0;
    let transitionCalls = 0;
    const harness = openHarness(
      (repository) =>
        repositoryWith(repository, {
          recordAccepted(record) {
            repositoryCalls += 1;
            return repository.recordAccepted(record);
          }
        }),
      {
        now() {
          clockCalls += 1;
          return isoAt(clockCalls);
        },
        createRecordId() {
          idCalls += 1;
          return `audit:executor:strict:${idCalls}`;
        }
      }
    );
    try {
      const definition = securityCases()[4] as SecurityCase;
      const valid = executionInput(definition, 30, {
        transition: () => {
          transitionCalls += 1;
          return { outcome: "succeeded", payload_summary: definition.success, response: "ok" };
        },
        prepare_response: (value) => value
      });
      let outerGetterCalls = 0;
      const accessor = Object.defineProperty({ ...valid }, "actor", {
        enumerable: true,
        get() {
          outerGetterCalls += 1;
          return definition.actor;
        }
      });
      let summaryGetterCalls = 0;
      const accessorSummary = Object.defineProperty({}, "schema_version", {
        enumerable: true,
        get() {
          summaryGetterCalls += 1;
          return 1;
        }
      });
      const candidates = [
        { ...valid, extra: true },
        accessor,
        { ...valid, accepted_summary: accessorSummary },
        { ...valid, operation_id: "bad" },
        { ...valid, action: "prompt" },
        { ...valid, accepted_summary: { ...definition.intent, raw_token: "S".repeat(43) } },
        {
          ...valid,
          action: "unlock",
          actor: cliActor(),
          accepted_summary: { schema_version: 1, requested_locked: false },
          emergency_lock_on_audit_unavailable: true
        }
      ];
      for (const candidate of candidates) {
        const error = await captureExecutorError(harness.executor.execute(candidate as never));
        expect(error).toMatchObject({
          code: "invalid_input",
          stage: "input",
          mutation_outcome: "not_started",
          audit_state: "none"
        });
        expect(Object.isFrozen(error)).toBe(true);
        expect(error.cause).toBeUndefined();
      }
      expect(outerGetterCalls).toBe(0);
      expect(summaryGetterCalls).toBe(0);
      expect(repositoryCalls).toBe(0);
      expect(clockCalls).toBe(0);
      expect(idCalls).toBe(0);
      expect(transitionCalls).toBe(0);
      expect(rawRowCount(harness.open.db)).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("does not dispatch after accepted proof failure, duplicate operation, or normal audit unavailability", async () => {
    const definition = securityCases()[4] as SecurityCase;
    let transitionCalls = 0;
    let forgedGetterCalls = 0;

    const forged = openHarness((repository) =>
      repositoryWith(repository, {
        recordAccepted(record) {
          const trail = repository.recordAccepted(record);
          const records = Object.defineProperty([], "0", {
            enumerable: true,
            get() {
              forgedGetterCalls += 1;
              return trail.records[0];
            }
          });
          return { ...trail, records } as never;
        }
      })
    );
    try {
      const error = await captureExecutorError(
        forged.executor.execute(
          executionInput(definition, 40, {
            transition: () => {
              transitionCalls += 1;
              return { outcome: "succeeded", payload_summary: definition.success, response: "ok" };
            },
            prepare_response: (value) => value,
            emergency_lock_on_audit_unavailable: true
          })
        )
      );
      expect(error).toMatchObject({ code: "audit_preflight_failed", audit_state: "unproven" });
      expect(forged.repository.require(operationIdFor(40)).state).toBe("pending");
      expect(forgedGetterCalls).toBe(0);
      expect(transitionCalls).toBe(0);
    } finally {
      forged.close();
    }

    const duplicate = openHarness();
    try {
      await duplicate.executor.execute(
        executionInput(definition, 41, {
          transition: () => {
            transitionCalls += 1;
            return { outcome: "succeeded", payload_summary: definition.success, response: "ok" };
          },
          prepare_response: (value) => value
        })
      );
      const error = await captureExecutorError(
        duplicate.executor.execute(
          executionInput(definition, 41, {
            transition: () => {
              transitionCalls += 1;
              return { outcome: "succeeded", payload_summary: definition.success, response: "duplicate" };
            },
            prepare_response: (value) => value
          })
        )
      );
      expect(error).toMatchObject({
        code: "audit_preflight_failed",
        api_code: "operation_conflict",
        audit_state: "unproven",
        mutation_outcome: "not_started"
      });
      expect(transitionCalls).toBe(1);
    } finally {
      duplicate.close();
    }

    const unavailable = openHarness((repository) =>
      repositoryWith(repository, {
        recordAccepted() {
          throw new HostDeckSelectedAuditRepositoryError("audit_unavailable", "PRIVATE_REPOSITORY_SENTINEL");
        }
      })
    );
    try {
      const error = await captureExecutorError(
        unavailable.executor.execute(
          executionInput(definition, 42, {
            transition: () => {
              transitionCalls += 1;
              return { outcome: "succeeded", payload_summary: definition.success, response: "not-run" };
            },
            prepare_response: (value) => value
          })
        )
      );
      expect(error).toMatchObject({
        code: "audit_preflight_failed",
        api_code: "audit_unavailable",
        audit_state: "none",
        retry_safe: true
      });
      expect(String(error)).not.toContain("PRIVATE_REPOSITORY_SENTINEL");
      expect(transitionCalls).toBe(1);
    } finally {
      unavailable.close();
    }
  });

  it("turns thrown or malformed transition output into one fixed secret-free incomplete terminal", async () => {
    const secret = `PRIVATE_TRANSITION_${"T".repeat(43)}`;
    let transitionGetterCalls = 0;
    const harness = openHarness();
    try {
      const definition = securityCases()[4] as SecurityCase;
      const transitions = [
        () => {
          throw new Error(secret);
        },
        () => ({
          outcome: "succeeded" as const,
          payload_summary: { ...definition.success, raw_token: secret },
          response: secret
        }),
        () => ({
          outcome: "failed" as const,
          error_code: "not_an_error_code",
          payload_summary: { schema_version: 1 }
        }),
        () =>
          Object.defineProperty(
            { payload_summary: definition.success, response: secret },
            "outcome",
            {
              enumerable: true,
              get() {
                transitionGetterCalls += 1;
                return "succeeded";
              }
            }
          )
      ];
      for (const [index, transition] of transitions.entries()) {
        const error = await captureExecutorError(
          harness.executor.execute(
            executionInput(definition, 50 + index, {
              transition: transition as never,
              prepare_response: () => {
                throw new Error("prepare-must-not-run");
              }
            })
          )
        );
        expect(error).toMatchObject({
          code: index === 0 ? "transition_failed" : "transition_result_invalid",
          api_code: "internal_error",
          mutation_outcome: "incomplete",
          audit_state: "terminal",
          retry_safe: false
        });
        expect(String(error)).not.toContain(secret);
        expect(harness.repository.require(operationIdFor(50 + index)).records[1]).toMatchObject({
          outcome: "incomplete",
          error_code: "internal_error",
          payload_summary: { schema_version: 1 }
        });
      }
      expect(transitionGetterCalls).toBe(0);
      expect(JSON.stringify(harness.executor.snapshot())).not.toContain(secret);
      expect(allRecordJson(harness.open.db)).not.toContain(secret);
      expect(harness.executor.snapshot()).toMatchObject({
        accepted_operations: 4,
        incomplete_operations: 4,
        transition_contract_failures: 4
      });
    } finally {
      harness.close();
    }
  });

  it("preserves state success across response failure and suppresses output when terminal proof fails", async () => {
    const definition = securityCases()[4] as SecurityCase;
    const secret = `PRIVATE_RESPONSE_${"R".repeat(43)}`;

    const responseFailure = openHarness();
    try {
      const error = await captureExecutorError(
        responseFailure.executor.execute(
          executionInput(definition, 60, {
            transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: secret }),
            prepare_response: () => {
              throw new Error(secret);
            }
          })
        )
      );
      expect(error).toMatchObject({
        code: "response_preparation_failed",
        mutation_outcome: "succeeded",
        audit_state: "terminal",
        retry_safe: false
      });
      expect(String(error)).not.toContain(secret);
      expect(responseFailure.repository.require(operationIdFor(60)).records[1]?.outcome).toBe("succeeded");
      expect(responseFailure.executor.snapshot()).toMatchObject({
        response_preparation_failures: 1,
        succeeded_operations: 1
      });
    } finally {
      responseFailure.close();
    }

    const terminalFailure = openHarness((repository) =>
      repositoryWith(repository, {
        recordTerminal() {
          throw new HostDeckSelectedAuditRepositoryError("audit_unavailable", secret);
        }
      })
    );
    try {
      let preparationCalls = 0;
      const error = await captureExecutorError(
        terminalFailure.executor.execute(
          executionInput(definition, 61, {
            transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: secret }),
            prepare_response: () => {
              preparationCalls += 1;
              throw new Error(secret);
            }
          })
        )
      );
      expect(error).toMatchObject({
        code: "terminal_audit_failed",
        api_code: "audit_unavailable",
        mutation_outcome: "succeeded",
        audit_state: "pending",
        retry_safe: false
      });
      expect(preparationCalls).toBe(1);
      expect(terminalFailure.repository.require(operationIdFor(61)).state).toBe("pending");
      expect(String(error)).not.toContain(secret);
      expect(terminalFailure.executor.snapshot()).toMatchObject({
        response_preparation_failures: 1,
        terminal_audit_failures: 1,
        succeeded_operations: 0
      });
    } finally {
      terminalFailure.close();
    }

    const forgedTerminal = openHarness((repository) =>
      repositoryWith(repository, {
        recordTerminal(record) {
          repository.recordTerminal(record);
          const trail = repository.get((record as { operation_id: string }).operation_id);
          if (trail === null) throw new Error("Forged terminal fixture lost its committed trail.");
          return trail.records[0] as never;
        }
      })
    );
    try {
      const error = await captureExecutorError(
        forgedTerminal.executor.execute(
          executionInput(definition, 62, {
            transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: "ok" }),
            prepare_response: (value) => value
          })
        )
      );
      expect(error).toMatchObject({ code: "terminal_audit_failed", audit_state: "unproven" });
      expect(forgedTerminal.repository.require(operationIdFor(62)).state).toBe("terminal");
    } finally {
      forgedTerminal.close();
    }
  });

  it("leaves accepted pending on regressing terminal time or terminal record-id collision", async () => {
    const definition = securityCases()[4] as SecurityCase;
    const regressing = openHarness(undefined, {
      now: sequence([isoAt(20), isoAt(10)]),
      createRecordId: sequence(["audit:executor:clock:accepted", "audit:executor:clock:terminal"])
    });
    try {
      const error = await captureExecutorError(
        regressing.executor.execute(
          executionInput(definition, 70, {
            transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: "ok" }),
            prepare_response: (value) => value
          })
        )
      );
      expect(error).toMatchObject({
        code: "terminal_audit_failed",
        api_code: "internal_error",
        audit_state: "pending"
      });
      expect(regressing.repository.require(operationIdFor(70)).state).toBe("pending");
    } finally {
      regressing.close();
    }

    const collision = openHarness(undefined, {
      createRecordId: () => "audit:executor:collision"
    });
    try {
      const error = await captureExecutorError(
        collision.executor.execute(
          executionInput(definition, 71, {
            transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: "ok" }),
            prepare_response: (value) => value
          })
        )
      );
      expect(error).toMatchObject({
        code: "terminal_audit_failed",
        api_code: "operation_conflict",
        audit_state: "pending"
      });
      expect(collision.repository.require(operationIdFor(71)).state).toBe("pending");
    } finally {
      collision.close();
    }
  });

  it("permits only explicit emergency lock after typed audit availability failure and never prepares a response", async () => {
    const definition = securityCases()[4] as SecurityCase;
    let acceptedFailure:
      | "audit_operation_exists"
      | "audit_unavailable"
      | "audit_write_failed"
      | "generic" = "audit_unavailable";
    const harness = openHarness((repository) =>
      repositoryWith(repository, {
        recordAccepted() {
          if (acceptedFailure === "generic") throw new Error("PRIVATE_GENERIC_EMERGENCY_REPOSITORY");
          throw new HostDeckSelectedAuditRepositoryError(acceptedFailure, "PRIVATE_EMERGENCY_REPOSITORY");
        }
      })
    );
    try {
      let prepareCalls = 0;
      const outcomes = [
        {
          expected: "succeeded",
          transition: (context: SecurityMutationAuditContext) => {
            expect(context).toEqual({ audit_state: "deferred" });
            expect(Object.isFrozen(context)).toBe(true);
            return { outcome: "succeeded" as const, payload_summary: definition.success, response: "locked" };
          }
        },
        {
          expected: "failed",
          transition: () => ({
            outcome: "failed" as const,
            error_code: "storage_error" as const,
            payload_summary: { schema_version: 1 }
          })
        },
        {
          expected: "incomplete",
          transition: () => {
            throw new Error("PRIVATE_EMERGENCY_TRANSITION");
          }
        },
        {
          expected: "incomplete",
          transition: () => ({
            outcome: "succeeded" as const,
            payload_summary: { ...definition.success, raw_token: "PRIVATE_EMERGENCY_TOKEN" },
            response: "locked"
          })
        }
      ] as const;
      for (const [index, item] of outcomes.entries()) {
        acceptedFailure = index % 2 === 0 ? "audit_unavailable" : "audit_write_failed";
        const error = await captureExecutorError(
          harness.executor.execute(
            executionInput(definition, 80 + index, {
              transition: item.transition as never,
              prepare_response: () => {
                prepareCalls += 1;
                return "must-not-run";
              },
              emergency_lock_on_audit_unavailable: true
            })
          )
        );
        expect(error).toMatchObject({
          code: "emergency_lock_audit_deferred",
          api_code: "audit_unavailable",
          stage: "emergency_lock",
          mutation_outcome: item.expected,
          audit_state: "deferred",
          retry_safe: false
        });
      }
      expect(prepareCalls).toBe(0);
      expect(rawRowCount(harness.open.db)).toBe(0);
      expect(harness.executor.snapshot()).toMatchObject({
        emergency_lock_audit_deferrals: 4,
        transition_contract_failures: 2
      });

      acceptedFailure = "audit_operation_exists";
      let conflictTransitionCalls = 0;
      const conflict = await captureExecutorError(
        harness.executor.execute(
          executionInput(definition, 84, {
            transition: () => {
              conflictTransitionCalls += 1;
              return { outcome: "succeeded", payload_summary: definition.success, response: "locked" };
            },
            prepare_response: (value) => value,
            emergency_lock_on_audit_unavailable: true
          })
        )
      );
      expect(conflict).toMatchObject({ code: "audit_preflight_failed", api_code: "operation_conflict" });
      expect(conflictTransitionCalls).toBe(0);

      acceptedFailure = "generic";
      const generic = await captureExecutorError(
        harness.executor.execute(
          executionInput(definition, 85, {
            transition: () => {
              conflictTransitionCalls += 1;
              return { outcome: "succeeded", payload_summary: definition.success, response: "locked" };
            },
            prepare_response: (value) => value,
            emergency_lock_on_audit_unavailable: true
          })
        )
      );
      expect(generic).toMatchObject({
        code: "audit_preflight_failed",
        api_code: "internal_error",
        audit_state: "unproven"
      });
      expect(String(generic)).not.toContain("PRIVATE_GENERIC_EMERGENCY_REPOSITORY");
      expect(conflictTransitionCalls).toBe(0);

      const unlock = securityCases()[5] as SecurityCase;
      const invalid = await captureExecutorError(
        harness.executor.execute(
          executionInput(unlock, 86, {
            transition: () => ({ outcome: "succeeded", payload_summary: unlock.success, response: "unlocked" }),
            prepare_response: (value) => value,
            emergency_lock_on_audit_unavailable: true
          })
        )
      );
      expect(invalid.code).toBe("invalid_input");
    } finally {
      harness.close();
    }
  });

  it("serializes one operation id through the repository so only one concurrent transition runs", async () => {
    const harness = openHarness();
    try {
      const definition = securityCases()[4] as SecurityCase;
      let releaseTransition: (() => void) | undefined;
      const transitionGate = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let transitionCalls = 0;
      let prepareCalls = 0;
      const first = harness.executor.execute(
        executionInput(definition, 90, {
          async transition() {
            transitionCalls += 1;
            markStarted?.();
            await transitionGate;
            return { outcome: "succeeded", payload_summary: definition.success, response: "winner" };
          },
          prepare_response(value) {
            prepareCalls += 1;
            return value;
          }
        })
      );
      await started;

      const loser = await captureExecutorError(
        harness.executor.execute(
          executionInput(definition, 90, {
            transition: () => {
              transitionCalls += 1;
              return { outcome: "succeeded", payload_summary: definition.success, response: "loser" };
            },
            prepare_response(value) {
              prepareCalls += 1;
              return value;
            }
          })
        )
      );
      expect(loser).toMatchObject({
        code: "audit_preflight_failed",
        api_code: "operation_conflict",
        mutation_outcome: "not_started"
      });
      releaseTransition?.();
      await expect(first).resolves.toEqual({ outcome: "succeeded", response: "winner" });
      expect(transitionCalls).toBe(1);
      expect(prepareCalls).toBe(1);
      expect(harness.repository.require(operationIdFor(90)).records).toHaveLength(2);
    } finally {
      harness.close();
    }
  });

  it("leaves accepted durable across a transition barrier and composes with restart orphan reconciliation", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedMigrationNow });
    const repository = createSelectedAuditRepository(open.db);
    const executor = createSecurityMutationAuditExecutor({
      repository,
      now: sequence(["2026-07-11T21:10:00.000Z"]),
      create_record_id: sequence(["audit:executor:crash:accepted"])
    });
    const definition = securityCases()[4] as SecurityCase;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const never = new Promise<never>(() => undefined);
    void executor.execute(
      executionInput(definition, 100, {
        transition() {
          markStarted?.();
          return never;
        },
        prepare_response: (value) => value
      })
    );
    await started;
    const operationId = operationIdFor(100);
    const acceptedJson = rawRecordJson(open.db, operationId, "accepted");
    expect(repository.require(operationId).state).toBe("pending");
    open.db.close();

    const reopened = openMigratedDatabase(path, { now: fixedMigrationNow });
    try {
      const result = reconcileSelectedAuditOrphansBatch(reopened.db, {
        eligible_before: "2026-07-11T21:10:01.000Z",
        max_reconciled_operations: 10,
        reconciled_at: "2026-07-11T21:10:02.000Z"
      });
      expect(result.reconciled_operation_count).toBe(1);
      const trail = createSelectedAuditRepository(reopened.db).require(operationId);
      expect(trail.records.map((record) => record.outcome)).toEqual(["accepted", "incomplete"]);
      expect(trail.records[1]).toMatchObject({
        error_code: "runtime_unavailable",
        payload_summary: { schema_version: 1, reconciliation_reason: "host_restart_without_terminal" }
      });
      expect(rawRecordJson(reopened.db, operationId, "accepted")).toBe(acceptedJson);
    } finally {
      reopened.db.close();
    }
  });

  it("keeps secrets out of audit/error/snapshot/raw SQLite while returning only the prepared success response", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedMigrationNow });
    const repository = createSelectedAuditRepository(open.db);
    const secret = `PRIVATE_EXECUTOR_RESPONSE_${"Z".repeat(43)}`;
    let index = 0;
    const executor = createSecurityMutationAuditExecutor({
      repository,
      now: () => isoAt(index++),
      create_record_id: () => `audit:executor:privacy:${index}`
    });
    const definition = securityCases()[0] as SecurityCase;
    try {
      const invalid = await captureExecutorError(
        executor.execute({
          ...executionInput(definition, 110, {
            transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: secret }),
            prepare_response: (value) => value
          }),
          accepted_summary: { ...definition.intent, pairing_code: secret }
        } as never)
      );
      expect(invalid.code).toBe("invalid_input");

      const success = await executor.execute(
        executionInput(definition, 111, {
          transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: secret }),
          prepare_response: (value) => Object.freeze({ pairing_code: value })
        })
      );
      expect(success).toEqual({ outcome: "succeeded", response: { pairing_code: secret } });
      expect(allRecordJson(open.db)).not.toContain(secret);

      const preparation = await captureExecutorError(
        executor.execute(
          executionInput(definition, 112, {
            transition: () => ({ outcome: "succeeded", payload_summary: definition.success, response: secret }),
            prepare_response: () => {
              throw new Error(secret);
            }
          })
        )
      );
      expect(String(preparation)).not.toContain(secret);
      expect(JSON.stringify(preparation)).not.toContain(secret);
      expect(JSON.stringify(executor.snapshot())).not.toContain(secret);
      expect(allRecordJson(open.db)).not.toContain(secret);
    } finally {
      open.db.close();
    }

    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) expect(readFileSync(candidate).includes(Buffer.from(secret, "utf8"))).toBe(false);
    }
  });
});

interface SecurityCase {
  readonly action: SelectedSecurityAuditAction;
  readonly actor: SelectedAuditActor;
  readonly target: SelectedAuditTarget;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly success: Readonly<Record<string, unknown>>;
}

interface Harness {
  readonly open: ReturnType<typeof openMigratedDatabase>;
  readonly repository: SelectedAuditRepository;
  readonly executor: SecurityMutationAuditExecutor;
  readonly close: () => void;
}

interface HarnessOptions {
  readonly now?: () => string;
  readonly createRecordId?: () => string;
}

function openHarness(
  wrap?: (repository: SelectedAuditRepository) => SelectedAuditRepository,
  options: HarnessOptions = {}
): Harness {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedMigrationNow });
  const repository = createSelectedAuditRepository(open.db);
  const port = wrap?.(repository) ?? repository;
  let clockIndex = 0;
  let recordIndex = 0;
  const executor = createSecurityMutationAuditExecutor({
    repository: port,
    now: options.now ?? (() => isoAt(clockIndex++)),
    create_record_id: options.createRecordId ?? (() => `audit:executor:${recordIndex++}`)
  });
  return {
    open,
    repository,
    executor,
    close: () => {
      if (open.db.open) open.db.close();
    }
  };
}

function observingRepository(repository: SelectedAuditRepository, events: string[]): SelectedAuditRepository {
  return repositoryWith(repository, {
    recordAccepted(record) {
      const trail = repository.recordAccepted(record);
      events.push("accepted");
      return trail;
    },
    recordTerminal(record) {
      const trail = repository.recordTerminal(record);
      events.push("terminal");
      return trail;
    }
  });
}

function repositoryWith(
  repository: SelectedAuditRepository,
  overrides: Partial<SelectedAuditRepository>
): SelectedAuditRepository {
  return {
    get: overrides.get ?? repository.get,
    require: overrides.require ?? repository.require,
    recordAccepted: overrides.recordAccepted ?? repository.recordAccepted,
    recordRejected: overrides.recordRejected ?? repository.recordRejected,
    recordTerminal: overrides.recordTerminal ?? repository.recordTerminal
  };
}

function executionInput<TResponse, TPreparedResponse>(
  definition: SecurityCase,
  index: number,
  callbacks: {
    readonly transition: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>["transition"];
    readonly prepare_response: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>["prepare_response"];
    readonly emergency_lock_on_audit_unavailable?: boolean;
  }
): ExecuteSecurityMutationInput<TResponse, TPreparedResponse> {
  return {
    operation_id: operationIdFor(index),
    actor: definition.actor,
    action: definition.action,
    target: definition.target,
    accepted_summary: definition.intent,
    emergency_lock_on_audit_unavailable: callbacks.emergency_lock_on_audit_unavailable ?? false,
    transition: callbacks.transition,
    prepare_response: callbacks.prepare_response
  };
}

function securityCases(): readonly SecurityCase[] {
  return [
    {
      action: "pair_request",
      actor: cliActor(),
      target: hostTarget(),
      intent: {
        schema_version: 1,
        permission: "write",
        client_label_present: true,
        expires_at: "2026-07-11T22:00:00.000Z"
      },
      success: { schema_version: 1, pairing_id: "pair_security_executor" }
    },
    {
      action: "pair_claim",
      actor: pairingActor(),
      target: hostTarget(),
      intent: { schema_version: 1, permission: "write", client_label_present: true },
      success: {
        schema_version: 1,
        permission: "write",
        device_created: true,
        device_id: "client_security_executor"
      }
    },
    {
      action: "csrf_bootstrap",
      actor: dashboardActor("read"),
      target: deviceTarget("client_security_phone"),
      intent: { schema_version: 1, csrf_generation_before: 1 },
      success: { schema_version: 1, csrf_generation_after: 2, rotated: true }
    },
    {
      action: "device_revoke",
      actor: dashboardActor("write"),
      target: deviceTarget("client_security_other"),
      intent: { schema_version: 1, previously_revoked: false },
      success: { schema_version: 1, authority_invalidated: true }
    },
    {
      action: "lock",
      actor: dashboardActor("write"),
      target: hostTarget(),
      intent: { schema_version: 1, requested_locked: true },
      success: { schema_version: 1, locked: true }
    },
    {
      action: "unlock",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, requested_locked: false },
      success: { schema_version: 1, locked: false }
    },
    {
      action: "lan_configure",
      actor: cliActor(),
      target: hostTarget(),
      intent: {
        schema_version: 1,
        bind_address_family: "ipv4",
        bind_port: 3777,
        certificate_change_requested: true
      },
      success: { schema_version: 1, configuration_changed: true }
    },
    {
      action: "lan_enable",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, requested_lan_enabled: true },
      success: { schema_version: 1, lan_enabled: true }
    },
    {
      action: "lan_disable",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, requested_lan_enabled: false },
      success: { schema_version: 1, lan_enabled: false }
    },
    {
      action: "certificate_rotate",
      actor: cliActor(),
      target: hostTarget(),
      intent: { schema_version: 1, rotation_requested: true },
      success: {
        schema_version: 1,
        certificate_changed: true,
        certificate_fingerprint_sha256: "a".repeat(64),
        certificate_expires_at: "2027-07-11T21:00:00.000Z"
      }
    }
  ];
}

function cliActor(): SelectedAuditActor {
  return { type: "cli", device_id: null, permission: "local_admin", origin: null };
}

function dashboardActor(permission: "read" | "write"): SelectedAuditActor {
  return {
    type: "dashboard",
    device_id: "client_security_phone",
    permission,
    origin: "https://hostdeck.local"
  };
}

function pairingActor(): SelectedAuditActor {
  return {
    type: "pairing_client",
    device_id: null,
    permission: null,
    origin: "https://hostdeck.local"
  };
}

function hostTarget(): SelectedAuditTarget {
  return { type: "host", host_id: "local_host" };
}

function deviceTarget(device_id: string): SelectedAuditTarget {
  return { type: "device", device_id };
}

function operationIdFor(index: number): string {
  return `op_security_executor_${String(index).padStart(3, "0")}`;
}

function isoAt(offsetMilliseconds: number): string {
  return new Date(baseTime + offsetMilliseconds).toISOString();
}

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index++];
    if (value === undefined) throw new Error("Test sequence exhausted.");
    return value;
  };
}

function fixedMigrationNow(): Date {
  return new Date("2026-07-11T20:00:00.000Z");
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-security-executor-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function rawRowCount(db: ReturnType<typeof openMigratedDatabase>["db"]): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get() as { count: number }).count;
}

function allRecordJson(db: ReturnType<typeof openMigratedDatabase>["db"]): string {
  return (
    db.prepare("SELECT record_json FROM selected_audit_events ORDER BY rowid").all() as Array<{
      record_json: string;
    }>
  )
    .map((row) => row.record_json)
    .join("\n");
}

function rawRecordJson(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  operationId: string,
  phase: "accepted" | "terminal"
): string {
  const row = db
    .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? AND phase = ?")
    .get(operationId, phase) as { record_json: string } | undefined;
  if (row === undefined) throw new Error("Expected raw audit row.");
  return row.record_json;
}

async function captureExecutorError(
  operation: Promise<unknown>
): Promise<HostDeckSecurityMutationAuditExecutorError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckSecurityMutationAuditExecutorError);
  return caught as HostDeckSecurityMutationAuditExecutorError;
}

function captureSyncExecutorError(operation: () => unknown): HostDeckSecurityMutationAuditExecutorError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckSecurityMutationAuditExecutorError);
  return caught as HostDeckSecurityMutationAuditExecutorError;
}
