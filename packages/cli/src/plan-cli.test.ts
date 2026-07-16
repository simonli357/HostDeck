import {
  clientOperationIdSchema,
  type PlanControlSnapshot,
  planControlSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import type { HostDeckPlanClient } from "./plan-client.js";
import { renderPlanSnapshot } from "./render.js";
import { type CliRunOptions, runCli } from "./shell.js";

const sessionId = "sess_plan_cli_001";
const operationId = clientOperationIdSchema.parse("op_plan_cli_001");
const timestamp = "2026-07-16T04:00:00.000Z";

describe("managed-session Plan CLI command", () => {
  it("parses only the frozen read, enter, and exit syntax", () => {
    expect(parseCliArgs(["plan", sessionId])).toEqual({
      command: {
        kind: "plan",
        session: sessionId,
        action: null,
        expectedRevision: null,
        json: false
      },
      configFlags: {}
    });
    expect(parseCliArgs(["--json", "plan", sessionId, "enter", "--expected-revision=3"])).toEqual({
      command: {
        kind: "plan",
        session: sessionId,
        action: "enter",
        expectedRevision: 3,
        json: true
      },
      configFlags: {}
    });
    expect(parseCliArgs(["plan", sessionId, "exit", "--json"])).toEqual({
      command: {
        kind: "plan",
        session: sessionId,
        action: "exit",
        expectedRevision: null,
        json: true
      },
      configFlags: {}
    });

    for (const args of [
      ["plan"],
      ["plan", sessionId, "pause"],
      ["plan", sessionId, "enter", "exit"],
      ["plan", sessionId, "enter", "--expected-revision", "0"],
      ["plan", sessionId, "enter", "--expected-revision=-1"],
      ["plan", sessionId, "enter", "--expected-revision=1.5"],
      ["plan", sessionId, "enter", "--expected-revision=01"],
      ["plan", sessionId, "enter", "--expected-revision=9007199254740992"],
      ["plan", sessionId, "exit", "--expected-revision=1", "--expected-revision", "2"],
      ["plan", sessionId, "enter", "--mode", "plan"],
      ["plan", sessionId, "enter", "--text", "/plan"],
      ["plan", sessionId, "--expected-revision=1"],
      ["plan", sessionId, "--", "enter"],
      ["/plan", sessionId]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({ code: "malformed_request", exitCode: cliExitCodes.usage })
      );
    }
  });

  it("advertises only the selected public Plan forms", async () => {
    const result = await runCli(["help"]);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("codexdeck plan SESSION_ID [--json]");
    expect(result.stdout).toContain(
      "codexdeck plan SESSION_ID enter|exit [--expected-revision REVISION] [--json]"
    );
    expect(result.stdout).not.toMatch(/operation-id|target|thread|runtime-mode|\/plan/iu);
  });

  it("reads one validated snapshot receiverlessly without constructing mutation or legacy ports", async () => {
    const reads: string[] = [];
    let readThis: unknown = "not-called";
    let unrelatedAccesses = 0;
    const planClient: HostDeckPlanClient = {
      read: async function readPlan(this: void, target) {
        readThis = this;
        reads.push(target);
        return planSnapshot();
      },
      select: async () => {
        throw new Error("unexpected Plan mutation");
      }
    };
    const options = Object.defineProperties(
      { env: {}, planClient },
      {
        client: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("legacy-plan-client-private");
          }
        },
        createPlanOperationId: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("plan-operation-private");
          }
        },
        localAdmin: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("plan-storage-private");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["plan", sessionId], options);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("Current mode: unknown.");
    expect(result.stdout).toContain("Pending selection: none.");
    expect(result.stdout).toContain("Execution: idle.");
    expect(result.stdout).toContain("Modes:");
    expect(result.stdout).not.toMatch(/applied|running|completed|private/iu);
    expect(reads).toEqual([sessionId]);
    expect(readThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("selects enter and exit once with internal operation ids and reports only staged state", async () => {
    const requests: unknown[] = [];
    let selectThis: unknown = "not-called";
    const planClient: HostDeckPlanClient = {
      read: async () => {
        throw new Error("unexpected Plan read");
      },
      select: async function selectPlan(this: void, request) {
        selectThis = this;
        requests.push(request);
        return stagedSnapshot(request.operation_id, request.action === "enter" ? "plan" : "default", 4);
      }
    };
    const enter = await runCli(["plan", sessionId, "enter", "--expected-revision", "3"], {
      env: {},
      planClient,
      createPlanOperationId: () => operationId
    });
    const exitOperationId = clientOperationIdSchema.parse("op_plan_cli_exit");
    const exit = await runCli(["plan", sessionId, "exit"], {
      env: {},
      planClient,
      createPlanOperationId: () => exitOperationId
    });

    expect(enter).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(enter.stdout).toContain("Plan selection pending: enter Plan mode, revision 4. No turn was started.");
    expect(exit).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(exit.stdout).toContain("Plan selection pending: exit Default mode, revision 4. No turn was started.");
    expect(`${enter.stdout}${exit.stdout}`).not.toMatch(/applied|running|completed/iu);
    expect(requests).toEqual([
      {
        session_id: sessionId,
        operation_id: operationId,
        kind: "plan",
        action: "enter",
        expected_pending_revision: 3
      },
      {
        session_id: sessionId,
        operation_id: exitOperationId,
        kind: "plan",
        action: "exit",
        expected_pending_revision: null
      }
    ]);
    expect(selectThis).toBeUndefined();
  });

  it("uses one exact loopback GET or POST and renders contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const fetch = async (url: string, init?: Parameters<NonNullable<CliRunOptions["fetch"]>>[1]) => {
      requests.push({ url, init });
      return jsonResponse(200, init?.method === "POST" ? stagedSnapshot(operationId, "plan", 4) : planSnapshot());
    };
    const read = await runCli(["plan", sessionId, "--json"], { env: {}, fetch });
    const select = await runCli(["plan", sessionId, "enter", "--expected-revision=3", "--json"], {
      env: {},
      fetch,
      createPlanOperationId: () => operationId
    });

    expect(read).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(select).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(read.stdout)).toEqual(planSnapshot());
    expect(JSON.parse(select.stdout)).toEqual(stagedSnapshot(operationId, "plan", 4));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/plan`,
        init: {
          method: "GET",
          headers: { accept: "application/json", "cache-control": "no-store" }
        }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/plan`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: operationId,
            kind: "plan",
            action: "enter",
            expected_pending_revision: 3
          })
        }
      }
    ]);
  });

  it("generates a private Plan operation id and rejects invalid identity before client dispatch", async () => {
    const requests: unknown[] = [];
    const generated = await runCli(["plan", sessionId, "enter"], {
      env: {},
      planClient: {
        read: async () => planSnapshot(),
        select: async (request) => {
          requests.push(request);
          return stagedSnapshot(request.operation_id, "plan", 1);
        }
      }
    });
    expect(generated).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ operation_id: expect.stringMatching(/^op_plan_[a-f0-9]{32}$/u) });

    let clientCalls = 0;
    for (const createPlanOperationId of [
      () => "invalid",
      () => {
        throw new Error("private-operation-id");
      }
    ]) {
      const result = await runCli(["plan", sessionId, "enter"], {
        env: {},
        createPlanOperationId,
        planClient: {
          read: async () => planSnapshot(),
          select: async () => {
            clientCalls += 1;
            return stagedSnapshot(operationId, "plan", 1);
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-operation-id");
    }
    expect(clientCalls).toBe(0);
  });

  it("rejects malformed and contradictory client data before output", async () => {
    const staged = stagedSnapshot(operationId, "plan", 4);
    const candidates = [
      { ...staged, extra: true },
      stagedSnapshot(clientOperationIdSchema.parse("op_plan_cli_other"), "plan", 4),
      stagedSnapshot(operationId, "default", 4),
      planSnapshot(),
      confirmedSnapshot("default"),
      { ...confirmedSnapshot("plan"), modes: [] }
    ];
    for (const candidate of candidates) {
      const result = await runCli(["plan", sessionId, "enter", "--expected-revision=3"], {
        env: {},
        createPlanOperationId: () => operationId,
        planClient: {
          read: async () => planSnapshot(),
          select: async () => candidate as PlanControlSnapshot
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toMatch(/invalid managed-session data|contradictory selection data/iu);
    }

    const rollback = await runCli(["plan", sessionId, "enter", "--expected-revision=3"], {
      env: {},
      createPlanOperationId: () => operationId,
      planClient: {
        read: async () => planSnapshot(),
        select: async () => stagedSnapshot(operationId, "plan", 2)
      }
    });
    expect(rollback).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
    expect(rollback.stderr).toContain("contradictory selection data");
  });

  it("preserves one bounded failure and rejects non-loopback APIs before fetch", async () => {
    let clientCalls = 0;
    const failed = await runCli(["plan", sessionId], {
      env: {},
      planClient: {
        read: async () => {
          clientCalls += 1;
          throw clientOperationFailure("runtime_unavailable", "The selected runtime is unavailable.", true);
        },
        select: async () => planSnapshot()
      }
    });
    expect(failed).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(failed.stderr).toContain("selected runtime is unavailable");
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(["--api-url", "https://private-plan.example.test", "plan", sessionId], {
      env: {},
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse(200, planSnapshot());
      }
    });
    expect(remote).toMatchObject({ exitCode: cliExitCodes.config, stdout: "" });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-plan.example.test");
    expect(fetchCalls).toBe(0);
  });

  it("renders all state without terminal controls, raw pending errors, or false lifecycle claims", () => {
    const snapshot = planControlSnapshotSchema.parse({
      ...planSnapshot(),
      current: {
        state: "confirmed",
        mode: "default",
        runtime_model: "private\u001b[31m-runtime",
        reasoning_effort: "high\u001b[32m",
        observed_at: timestamp
      },
      pending: {
        revision: 9,
        selection_operation_id: "op_plan_cli_conflict",
        mode: "plan",
        catalog_state: "unknown",
        phase: "conflict",
        selected_at: timestamp,
        turn_id: null,
        resolved_settings: null,
        error: {
          code: "operation_conflict",
          message: "private Plan cwd, token, thread",
          retryable: false
        }
      },
      execution: {
        turn_id: "turn-plan-cli-001",
        state: "failed",
        evidence: "plan_delta",
        summary: "failed\u001b[33m-summary",
        updated_at: timestamp
      },
      modes: [
        {
          name: "Plan\u001b[34m",
          mode: "plan",
          preset_model: "preset\u001b[35m-model",
          preset_reasoning_effort: "medium"
        },
        { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null }
      ]
    });
    const output = renderPlanSnapshot(snapshot, false);
    expect(output).toContain("private\\u001b[31m-runtime");
    expect(output).toContain("failed\\u001b[33m-summary");
    expect(output).toContain("Pending error: operation_conflict.");
    expect(output).toContain("Execution: failed.");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("cwd, token, thread");
    expect(output).not.toMatch(/applied|running|completed/iu);
  });

  it("distinguishes a staged selection, pending clear, and confirmed no-op", () => {
    const request = {
      operation_id: operationId,
      kind: "plan" as const,
      action: "enter" as const,
      expected_pending_revision: null
    };
    expect(renderPlanSnapshot(stagedSnapshot(operationId, "plan", 1), false, request)).toContain(
      "No turn was started"
    );
    expect(
      renderPlanSnapshot(confirmedSnapshot("plan"), false, { ...request, expected_pending_revision: 3 })
    ).toContain("Pending Plan selection cleared");
    expect(renderPlanSnapshot(confirmedSnapshot("plan"), false, request)).toContain(
      "Requested Plan mode is already confirmed"
    );
  });
});

function planSnapshot(): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    catalog_revision: "c".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      state: "unknown",
      mode: null,
      runtime_model: null,
      reasoning_effort: null,
      observed_at: null
    },
    pending: null,
    execution: { turn_id: null, state: "idle", evidence: "none", summary: null, updated_at: null },
    modes: [
      { name: "Plan", mode: "plan", preset_model: "runtime-plan", preset_reasoning_effort: "medium" },
      { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null }
    ]
  });
}

function stagedSnapshot(
  selectionOperationId: string,
  mode: "default" | "plan",
  revision: number
): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    pending: {
      revision,
      selection_operation_id: selectionOperationId,
      mode,
      catalog_state: "available",
      phase: "pending",
      selected_at: timestamp,
      turn_id: null,
      resolved_settings: null,
      error: null
    }
  });
}

function confirmedSnapshot(mode: "default" | "plan"): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    current: {
      state: "confirmed",
      mode,
      runtime_model: "runtime-a",
      reasoning_effort: "high",
      observed_at: timestamp
    }
  });
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
