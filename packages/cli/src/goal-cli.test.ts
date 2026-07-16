import {
  clientOperationIdSchema,
  type GoalControlSnapshot,
  goalControlSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import type { HostDeckGoalClient } from "./goal-client.js";
import { parseCliArgs } from "./parser.js";
import { renderGoalSnapshot } from "./render.js";
import { type CliRunOptions, runCli } from "./shell.js";

const sessionId = "sess_goal_cli_001";
const operationId = clientOperationIdSchema.parse("op_goal_cli_001");
const objective = "Deliver HostDeck V1.";
const originalRevision = "a".repeat(64);
const changedRevision = "b".repeat(64);

describe("managed-session goal CLI command", () => {
  it("parses only the frozen read and lifecycle syntax", () => {
    expect(parseCliArgs(["goal", sessionId])).toEqual({
      command: {
        kind: "goal",
        session: sessionId,
        action: null,
        objective: null,
        expectedRevision: null,
        json: false
      },
      configFlags: {}
    });
    expect(
      parseCliArgs([
        "--json",
        "goal",
        sessionId,
        "set",
        "--objective",
        objective,
        `--expected-revision=${originalRevision}`
      ])
    ).toEqual({
      command: {
        kind: "goal",
        session: sessionId,
        action: "set",
        objective,
        expectedRevision: originalRevision,
        json: true
      },
      configFlags: {}
    });
    for (const action of ["pause", "resume", "complete", "clear"] as const) {
      expect(parseCliArgs(["goal", sessionId, action, "--expected-revision", originalRevision])).toEqual({
        command: {
          kind: "goal",
          session: sessionId,
          action,
          objective: null,
          expectedRevision: originalRevision,
          json: false
        },
        configFlags: {}
      });
    }

    for (const args of [
      ["goal"],
      ["goal", sessionId, "unknown"],
      ["goal", sessionId, "set"],
      ["goal", sessionId, "set", "--objective", objective, "--objective=again"],
      ["goal", sessionId, "set", "--objective", objective, "extra"],
      ["goal", sessionId, "pause"],
      ["goal", sessionId, "pause", "--expected-revision", originalRevision, "--objective", objective],
      ["goal", sessionId, "resume", "--expected-revision", "A".repeat(64)],
      ["goal", sessionId, "clear", "--expected-revision", "abc"],
      [
        "goal",
        sessionId,
        "complete",
        "--expected-revision",
        originalRevision,
        `--expected-revision=${changedRevision}`
      ],
      ["goal", sessionId, "set", "--objective", objective, "--token-budget", "1000"],
      ["goal", sessionId, "set", "--objective", objective, "--status", "active"],
      ["goal", sessionId, "set", "--objective", objective, "--operation-id", operationId],
      ["goal", sessionId, "set", "--objective", objective, "--target", "private"],
      ["goal", sessionId, "--expected-revision", originalRevision],
      ["goal", sessionId, "--", "set"],
      ["/goal", sessionId]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("advertises only the selected public goal forms", async () => {
    const result = await runCli(["help"]);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("codexdeck goal SESSION_ID [--json]");
    expect(result.stdout).toContain(
      "codexdeck goal SESSION_ID set --objective OBJECTIVE [--expected-revision REVISION] [--json]"
    );
    expect(result.stdout).toContain(
      "codexdeck goal SESSION_ID pause|resume|complete|clear --expected-revision REVISION [--json]"
    );
    expect(result.stdout).not.toMatch(/token-budget|operation-id|target|\/goal/iu);
  });

  it("reads one validated snapshot receiverlessly without constructing mutation or legacy ports", async () => {
    const reads: string[] = [];
    let readThis: unknown = "not-called";
    let unrelatedAccesses = 0;
    const goalClient: HostDeckGoalClient = {
      read: async function readGoal(this: void, target) {
        readThis = this;
        reads.push(target);
        return goalSnapshot();
      },
      mutate: async () => {
        throw new Error("unexpected goal mutation");
      }
    };
    const options = Object.defineProperties(
      { env: {}, goalClient },
      {
        client: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("legacy-goal-client-private");
          }
        },
        createGoalOperationId: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("goal-operation-private");
          }
        },
        localAdmin: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("goal-storage-private");
          }
        },
        modelClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("goal-model-private");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["goal", sessionId], options);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("Goal: paused.");
    expect(result.stdout).toContain(`Objective: ${objective}`);
    expect(result.stdout).toContain("Uncertain mutation: none.");
    expect(reads).toEqual([sessionId]);
    expect(readThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("mutates each lifecycle action once with internal identity and exact status claims", async () => {
    const requests: unknown[] = [];
    let mutateThis: unknown = "not-called";
    const goalClient: HostDeckGoalClient = {
      read: async () => {
        throw new Error("unexpected goal read");
      },
      mutate: async function mutateGoal(this: void, request) {
        mutateThis = this;
        requests.push(request);
        if (request.action === "clear") return emptyGoalSnapshot();
        return goalSnapshot({
          revision: changedRevision,
          objective: request.action === "set" ? (request.objective ?? objective) : objective,
          status: request.action === "resume" ? "active" : request.action === "complete" ? "complete" : "paused"
        });
      }
    };

    const set = await runCli(["goal", sessionId, "set", "--objective", objective], {
      env: {},
      goalClient,
      createGoalOperationId: () => operationId
    });
    expect(set).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(set.stdout).toContain("Goal set in paused state.");
    expect(requests[0]).toEqual({
      session_id: sessionId,
      operation_id: operationId,
      kind: "goal",
      action: "set",
      objective,
      expected_goal_revision: null
    });

    const outputs = new Map<string, string>();
    for (const action of ["pause", "resume", "complete", "clear"] as const) {
      const result = await runCli(["goal", sessionId, action, "--expected-revision", originalRevision], {
        env: {},
        goalClient,
        createGoalOperationId: () => operationId
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      outputs.set(action, result.stdout);
    }
    expect(outputs.get("pause")).toContain("Goal pause verified.");
    expect(outputs.get("resume")).toContain("Goal resume accepted.");
    expect(outputs.get("resume")).not.toMatch(/running|completed/iu);
    expect(outputs.get("complete")).toContain("Goal completion verified.");
    expect(outputs.get("clear")).toContain("Goal clear verified.");
    expect(requests).toHaveLength(5);
    expect(requests.slice(1)).toEqual(
      ["pause", "resume", "complete", "clear"].map((action) => ({
        session_id: sessionId,
        operation_id: operationId,
        kind: "goal",
        action,
        objective: null,
        expected_goal_revision: originalRevision
      }))
    );
    expect(mutateThis).toBeUndefined();
  });

  it("uses one exact loopback GET or POST and renders contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const fetch = async (url: string, init?: Parameters<NonNullable<CliRunOptions["fetch"]>>[1]) => {
      requests.push({ url, init });
      return jsonResponse(200, init?.method === "POST" ? goalSnapshot({ revision: changedRevision }) : goalSnapshot());
    };
    const read = await runCli(["goal", sessionId, "--json"], { env: {}, fetch });
    const set = await runCli(["goal", sessionId, "set", "--objective", objective, "--json"], {
      env: {},
      fetch,
      createGoalOperationId: () => operationId
    });

    expect(read).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(set).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(read.stdout)).toEqual(goalSnapshot());
    expect(JSON.parse(set.stdout)).toEqual(goalSnapshot({ revision: changedRevision }));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/goal`,
        init: {
          method: "GET",
          headers: { accept: "application/json", "cache-control": "no-store" }
        }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/goal`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: operationId,
            kind: "goal",
            action: "set",
            objective,
            expected_goal_revision: null
          })
        }
      }
    ]);
  });

  it("rejects invalid generated identity and contradictory client data before output", async () => {
    let clientCalls = 0;
    for (const createGoalOperationId of [
      () => "invalid",
      () => {
        throw new Error("private-operation-id");
      }
    ]) {
      const result = await runCli(["goal", sessionId, "set", "--objective", objective], {
        env: {},
        createGoalOperationId,
        goalClient: {
          read: async () => goalSnapshot(),
          mutate: async () => {
            clientCalls += 1;
            return goalSnapshot({ revision: changedRevision });
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-operation-id");
    }

    const candidates = [
      { ...goalSnapshot({ revision: changedRevision }), extra: true },
      emptyGoalSnapshot(),
      goalSnapshot({ revision: changedRevision, status: "active" }),
      goalSnapshot({ revision: changedRevision, objective: "Wrong objective." }),
      uncertainSnapshot()
    ];
    for (const candidate of candidates) {
      const result = await runCli(["goal", sessionId, "set", "--objective", objective], {
        env: {},
        createGoalOperationId: () => operationId,
        goalClient: {
          read: async () => goalSnapshot(),
          mutate: async () => candidate as GoalControlSnapshot
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toMatch(/invalid managed-session data|contradictory mutation data/iu);
    }

    const resume = await runCli(
      ["goal", sessionId, "resume", "--expected-revision", originalRevision],
      {
        env: {},
        createGoalOperationId: () => operationId,
        goalClient: {
          read: async () => goalSnapshot(),
          mutate: async () => goalSnapshot({ revision: originalRevision, status: "active" })
        }
      }
    );
    expect(resume).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
    expect(resume.stderr).toContain("contradictory mutation data");
    expect(clientCalls).toBe(0);
  });

  it("preserves one bounded failure and rejects non-loopback APIs before fetch", async () => {
    let clientCalls = 0;
    const failed = await runCli(["goal", sessionId], {
      env: {},
      goalClient: {
        read: async () => {
          clientCalls += 1;
          throw clientOperationFailure("runtime_unavailable", "The selected runtime is unavailable.", true);
        },
        mutate: async () => goalSnapshot()
      }
    });
    expect(failed).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(failed.stderr).toContain("selected runtime is unavailable");
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      ["--api-url", "https://private-goal.example.test", "goal", sessionId],
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, goalSnapshot());
        }
      }
    );
    expect(remote).toMatchObject({ exitCode: cliExitCodes.config, stdout: "" });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-goal.example.test");
    expect(fetchCalls).toBe(0);
  });

  it("renders legal no-ops and uncertain state without terminal controls or raw errors", () => {
    const noOp = renderGoalSnapshot(goalSnapshot(), false, {
      operation_id: operationId,
      kind: "goal",
      action: "set",
      objective,
      expected_goal_revision: originalRevision
    });
    expect(noOp).toContain("already matches the requested paused objective");

    const uncertain = goalControlSnapshotSchema.parse({
      goal: goalSnapshot({ objective: "private\u001b[31m-objective" }).goal,
      uncertain_mutation: {
        action: "set",
        phase: "conflict",
        requested_at: "2026-07-16T04:00:00.000Z",
        baseline_revision: originalRevision,
        requested_objective: "requested\u001b[32m-objective",
        requested_status: "paused",
        error: {
          code: "operation_conflict",
          message: "private cwd, token, thread, cookie",
          retryable: false
        }
      }
    });
    const output = renderGoalSnapshot(uncertain, false);
    expect(output).toContain("private\\u001b[31m-objective");
    expect(output).toContain("requested\\u001b[32m-objective");
    expect(output).toContain("Error: operation_conflict.");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("cwd, token, thread");
  });
});

function goalSnapshot(
  overrides: Partial<{
    objective: string;
    revision: string;
    status: "active" | "complete" | "paused";
  }> = {}
): GoalControlSnapshot {
  return goalControlSnapshotSchema.parse({
    goal: {
      revision: originalRevision,
      objective,
      status: "paused",
      token_budget: 10_000,
      tokens_used: 500,
      time_used_seconds: 12.5,
      created_at: "2026-07-16T04:00:00.000Z",
      updated_at: "2026-07-16T04:00:00.000Z",
      ...overrides
    },
    uncertain_mutation: null
  });
}

function emptyGoalSnapshot(): GoalControlSnapshot {
  return goalControlSnapshotSchema.parse({ goal: null, uncertain_mutation: null });
}

function uncertainSnapshot(): GoalControlSnapshot {
  return goalControlSnapshotSchema.parse({
    goal: goalSnapshot().goal,
    uncertain_mutation: {
      action: "resume",
      phase: "unknown",
      requested_at: "2026-07-16T04:00:00.000Z",
      baseline_revision: originalRevision,
      requested_objective: null,
      requested_status: "active",
      error: {
        code: "unknown_error",
        message: "Canonical uncertain state.",
        retryable: false
      }
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
