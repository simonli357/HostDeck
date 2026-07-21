import {
  clientOperationIdSchema,
  type ModelControlSnapshot,
  modelControlSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import type { HostDeckModelClient } from "./model-client.js";
import { parseCliArgs } from "./parser.js";
import { renderModelSnapshot } from "./render.js";
import { type CliRunOptions, runCli } from "./shell.js";

const sessionId = "sess_model_cli_001";
const operationId = clientOperationIdSchema.parse("op_model_cli_001");

describe("managed-session model CLI command", () => {
  it("parses only the frozen read and select syntax", () => {
    expect(parseCliArgs(["model", sessionId])).toEqual({
      command: {
        kind: "model",
        session: sessionId,
        model: null,
        effort: null,
        expectedRevision: null,
        json: false
      },
      configFlags: {}
    });
    expect(
      parseCliArgs([
        "--json",
        "model",
        sessionId,
        "model-b",
        "--expected-revision=3",
        "--effort",
        "low"
      ])
    ).toEqual({
      command: {
        kind: "model",
        session: sessionId,
        model: "model-b",
        effort: "low",
        expectedRevision: 3,
        json: true
      },
      configFlags: {}
    });

    for (const args of [
      ["model"],
      ["model", sessionId, "model-a", "model-b"],
      ["model", sessionId, "--effort", "high"],
      ["model", sessionId, "--expected-revision", "1"],
      ["model", sessionId, "model-b", "--effort", "low", "--effort=high"],
      ["model", sessionId, "model-b", "--expected-revision=1", "--expected-revision", "2"],
      ["model", sessionId, "model-b", "--expected-revision", "0"],
      ["model", sessionId, "model-b", "--expected-revision=-1"],
      ["model", sessionId, "model-b", "--expected-revision=1.5"],
      ["model", sessionId, "model-b", "--expected-revision=01"],
      ["model", sessionId, "model-b", "--expected-revision=9007199254740992"],
      ["model", sessionId, "model-b", "--runtime-model", "private-runtime"],
      ["model", sessionId, "--", "--effort"],
      ["/model", sessionId]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("advertises only the selected public model forms", async () => {
    const result = await runCli(["help"]);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("codexdeck model SESSION_ID [--json]");
    expect(result.stdout).toContain(
      "codexdeck model SESSION_ID MODEL_ID [--effort EFFORT] [--expected-revision REVISION] [--json]"
    );
    expect(result.stdout).not.toMatch(/runtime-model|operation-id|target|\/model/iu);
  });

  it("reads one validated snapshot receiverlessly without constructing mutation or legacy ports", async () => {
    const reads: string[] = [];
    let readThis: unknown = "not-called";
    let unrelatedAccesses = 0;
    const modelClient: HostDeckModelClient = {
      read: async function readModel(this: void, target) {
        readThis = this;
        reads.push(target);
        return modelSnapshot();
      },
      select: async () => {
        throw new Error("unexpected model mutation");
      }
    };
    const options = Object.defineProperties(
      { env: {}, modelClient },
      {
        client: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("legacy-model-client-private");
          }
        },
        createModelOperationId: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("model-operation-private");
          }
        },
        hostLockClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("model-storage-private");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["model", sessionId], options);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("Current: Model A [model-a], effort high.");
    expect(result.stdout).toContain("Pending: none.");
    expect(result.stdout).toContain("Models:");
    expect(result.stdout).not.toMatch(/applied|running|completed|private/iu);
    expect(reads).toEqual([sessionId]);
    expect(readThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("selects once with an internal operation id and reports only staged state", async () => {
    const requests: unknown[] = [];
    let selectThis: unknown = "not-called";
    const modelClient: HostDeckModelClient = {
      read: async () => {
        throw new Error("unexpected model read");
      },
      select: async function selectModel(this: void, request) {
        selectThis = this;
        requests.push(request);
        return stagedSnapshot(operationId, "low");
      }
    };
    const result = await runCli(
      ["model", sessionId, "model-b", "--effort=low", "--expected-revision", "3"],
      {
        env: {},
        modelClient,
        createModelOperationId: () => operationId
      }
    );

    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain("Model selection pending: Model B [model-b], effort low, revision 4.");
    expect(result.stdout).not.toMatch(/applied|running|completed/iu);
    expect(requests).toEqual([
      {
        session_id: sessionId,
        operation_id: operationId,
        kind: "model",
        model_id: "model-b",
        reasoning_effort: "low",
        expected_pending_revision: 3
      }
    ]);
    expect(selectThis).toBeUndefined();
  });

  it("uses one exact loopback GET or POST and renders contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const fetch = async (url: string, init?: Parameters<NonNullable<CliRunOptions["fetch"]>>[1]) => {
      requests.push({ url, init });
      return jsonResponse(
        200,
        init?.method === "POST" ? stagedSnapshot(operationId, "high") : modelSnapshot()
      );
    };
    const read = await runCli(["model", sessionId, "--json"], { env: {}, fetch });
    const select = await runCli(["model", sessionId, "model-b", "--expected-revision=3", "--json"], {
      env: {},
      fetch,
      createModelOperationId: () => operationId
    });

    expect(read).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(select).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(read.stdout)).toEqual(modelSnapshot());
    expect(JSON.parse(select.stdout)).toEqual(stagedSnapshot(operationId, "high"));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/model`,
        init: {
          method: "GET",
          headers: { accept: "application/json", "cache-control": "no-store" }
        }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/model`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: operationId,
            kind: "model",
            model_id: "model-b",
            reasoning_effort: null,
            expected_pending_revision: 3
          })
        }
      }
    ]);
  });

  it("rejects invalid generated identity and contradictory client data before output", async () => {
    let clientCalls = 0;
    for (const createModelOperationId of [
      () => "invalid",
      () => {
        throw new Error("private-operation-id");
      }
    ]) {
      const result = await runCli(["model", sessionId, "model-b"], {
        env: {},
        createModelOperationId,
        modelClient: {
          read: async () => modelSnapshot(),
          select: async () => {
            clientCalls += 1;
            return stagedSnapshot(operationId, "high");
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-operation-id");
    }

    for (const candidate of [
      { ...stagedSnapshot(operationId, "high"), extra: true },
      stagedSnapshot(clientOperationIdSchema.parse("op_model_cli_other"), "high"),
      modelSnapshot()
    ]) {
      const result = await runCli(["model", sessionId, "model-b"], {
        env: {},
        createModelOperationId: () => operationId,
        modelClient: {
          read: async () => modelSnapshot(),
          select: async () => candidate as ModelControlSnapshot
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toMatch(/invalid managed-session data|contradictory selection data/iu);
    }

    const staged = stagedSnapshot(operationId, "high");
    const rollback = await runCli(
      ["model", sessionId, "model-b", "--expected-revision=3"],
      {
        env: {},
        createModelOperationId: () => operationId,
        modelClient: {
          read: async () => modelSnapshot(),
          select: async () => ({
            ...staged,
            pending: { ...staged.pending, revision: 2 }
          }) as ModelControlSnapshot
        }
      }
    );
    expect(rollback).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
    expect(rollback.stderr).toContain("contradictory selection data");
    expect(clientCalls).toBe(0);
  });

  it("preserves one bounded failure and rejects non-loopback APIs before fetch", async () => {
    let clientCalls = 0;
    const failed = await runCli(["model", sessionId], {
      env: {},
      modelClient: {
        read: async () => {
          clientCalls += 1;
          throw clientOperationFailure("runtime_unavailable", "The selected runtime is unavailable.", true);
        },
        select: async () => modelSnapshot()
      }
    });
    expect(failed).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(failed.stderr).toContain("selected runtime is unavailable");
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      ["--api-url", "https://private-model.example.test", "model", sessionId],
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, modelSnapshot());
        }
      }
    );
    expect(remote).toMatchObject({ exitCode: cliExitCodes.config, stdout: "" });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-model.example.test");
    expect(fetchCalls).toBe(0);
  });

  it("renders unknown and conflicting runtime state without terminal controls or raw errors", () => {
    const snapshot = modelControlSnapshotSchema.parse({
      ...modelSnapshot(),
      current: {
        model_id: null,
        runtime_model: "private\u001b[31m-runtime",
        reasoning_effort: null,
        catalog_state: "unknown",
        observed_at: "2026-07-16T04:00:00.000Z"
      },
      pending: {
        revision: 9,
        selection_operation_id: "op_model_cli_conflict",
        model_id: "removed-model",
        runtime_model: "removed\u001b[32m-runtime",
        reasoning_effort: "high",
        catalog_state: "unknown",
        phase: "conflict",
        selected_at: "2026-07-16T04:00:00.000Z",
        turn_id: null,
        error: {
          code: "operation_conflict",
          message: "private model, cwd, token, thread",
          retryable: false
        }
      }
    });
    const output = renderModelSnapshot(snapshot, false);
    expect(output).toContain("private\\u001b[31m-runtime [not in current catalog]");
    expect(output).toContain("removed\\u001b[32m-runtime [removed-model]");
    expect(output).toContain("error operation_conflict");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("cwd, token, thread");

    const current = modelSnapshot({ currentModel: "model-b" });
    expect(
      renderModelSnapshot(current, false, {
        operation_id: operationId,
        kind: "model",
        model_id: "model-b",
        reasoning_effort: "high",
        expected_pending_revision: null
      })
    ).toContain("already confirmed current");
    expect(
      renderModelSnapshot(current, false, {
        operation_id: operationId,
        kind: "model",
        model_id: "model-b",
        reasoning_effort: "high",
        expected_pending_revision: 3
      })
    ).toContain("Pending model selection cleared");
  });
});

function modelSnapshot(options: { readonly currentModel?: "model-a" | "model-b" } = {}): ModelControlSnapshot {
  const currentModel = options.currentModel ?? "model-a";
  return modelControlSnapshotSchema.parse({
    catalog_revision: "a".repeat(64),
    catalog_observed_at: "2026-07-16T04:00:00.000Z",
    current: {
      model_id: currentModel,
      runtime_model: currentModel === "model-a" ? "runtime-a" : "runtime-b",
      reasoning_effort: "high",
      catalog_state: "available",
      observed_at: "2026-07-16T04:00:00.000Z"
    },
    pending: null,
    models: [
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
        reasoning_efforts: [
          { id: "low", description: "Fast", is_default: false },
          { id: "high", description: "Thorough", is_default: true }
        ]
      }
    ]
  });
}

function stagedSnapshot(
  selectionOperationId: string,
  effort: "high" | "low"
): ModelControlSnapshot {
  return modelControlSnapshotSchema.parse({
    ...modelSnapshot(),
    pending: {
      revision: 4,
      selection_operation_id: selectionOperationId,
      model_id: "model-b",
      runtime_model: "runtime-b",
      reasoning_effort: effort,
      catalog_state: "available",
      phase: "pending",
      selected_at: "2026-07-16T04:00:00.000Z",
      turn_id: null,
      error: null
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
