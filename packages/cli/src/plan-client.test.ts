import { clientOperationIdSchema, planControlSnapshotSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";
import {
  createHostDeckPlanClient,
  type HostDeckPlanClientSelectionRequest
} from "./plan-client.js";

const sessionId = "sess_plan_client_001";
const threadId = "thread-plan-client-001";
const baseUrl = new URL("http://127.0.0.1:3777");
const operationId = clientOperationIdSchema.parse("op_plan_client_001");
const enterRequest: HostDeckPlanClientSelectionRequest = {
  session_id: sessionId,
  operation_id: operationId,
  kind: "plan",
  action: "enter",
  expected_pending_revision: null
};

describe("managed-session Plan CLI client", () => {
  it("snapshots one exact accessor-free configuration and receiverless fetch", async () => {
    const mutableUrl = new URL(baseUrl);
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    let fetch: HttpFetch = function fetchPlan(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, planSnapshot()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckPlanClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-plan-fetch-private");
    };
    mutableOptions.fetch = fetch;

    const snapshot = await client.read(sessionId);
    expect(requests).toEqual([`http://127.0.0.1:3777/api/v1/sessions/${sessionId}/plan`]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.modes)).toBe(true);
    expect(Object.isFrozen(snapshot.execution)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private-plan-base-accessor");
      }
    });
    const hostileProxy = new Proxy(
      { baseUrl: new URL(baseUrl) },
      {
        ownKeys: () => {
          throw new Error("private-plan-options-proxy");
        }
      }
    );
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: new URL(baseUrl), extra: true },
      Object.assign(Object.create({ inherited: true }), { baseUrl: new URL(baseUrl) }),
      { baseUrl: "http://127.0.0.1:3777" },
      { baseUrl: new URL(baseUrl), fetch: null },
      accessor,
      hostileProxy
    ]) {
      expect(() => createHostDeckPlanClient(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("rejects every non-exact loopback base before fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, planSnapshot());
    };
    for (const url of [
      "https://127.0.0.1:3777",
      "http://0.0.0.0:3777",
      "http://192.0.2.10:3777",
      "http://user:password@127.0.0.1:3777",
      "http://127.0.0.1:3777/api",
      "http://127.0.0.1:3777?target=private",
      "http://127.0.0.1:3777#private"
    ]) {
      expect(() => createHostDeckPlanClient({ baseUrl: new URL(url), fetch })).toThrowError(
        expect.objectContaining({ code: "invalid_config" })
      );
    }
    expect(calls).toBe(0);
  });

  it("issues one exact GET and one canonical target-free POST without retry", async () => {
    const requests: Array<{ readonly init: Record<string, unknown>; readonly url: string }> = [];
    const responses = [planSnapshot(), stagedSnapshot(operationId, "plan", 1)];
    const client = createHostDeckPlanClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ init: init as unknown as Record<string, unknown>, url });
        return jsonResponse(200, responses.shift());
      }
    });
    await expect(client.read(sessionId)).resolves.toEqual(planSnapshot());
    await expect(client.select(enterRequest)).resolves.toEqual(stagedSnapshot(operationId, "plan", 1));
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
            expected_pending_revision: null
          })
        }
      }
    ]);
  });

  it("rejects malformed sessions and selection bodies before fetch", async () => {
    let calls = 0;
    const client = createHostDeckPlanClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, planSnapshot());
      }
    });
    for (const candidate of ["", "plan-client", threadId, "sess with spaces", `${sessionId}/other`]) {
      await expect(client.read(candidate)).rejects.toMatchObject({ code: "malformed_request", field: "session" });
    }
    for (const candidate of [
      { ...enterRequest, session_id: threadId },
      { ...enterRequest, operation_id: "bad" },
      { ...enterRequest, action: "pause" },
      { ...enterRequest, expected_pending_revision: 0 },
      { ...enterRequest, target: { session_id: sessionId } },
      { ...enterRequest, mode: "plan" },
      { ...enterRequest, text: "/plan" }
    ]) {
      await expect(client.select(candidate as never)).rejects.toMatchObject({ code: "malformed_request", field: "plan" });
    }
    expect(calls).toBe(0);
  });

  it("accepts exact enter/exit staging, already-current no-op, and pending clear", async () => {
    const replacementRequest: HostDeckPlanClientSelectionRequest = {
      ...enterRequest,
      operation_id: clientOperationIdSchema.parse("op_plan_client_replace"),
      expected_pending_revision: 3
    };
    const noOpRequest: HostDeckPlanClientSelectionRequest = {
      ...enterRequest,
      operation_id: clientOperationIdSchema.parse("op_plan_client_noop")
    };
    const clearRequest: HostDeckPlanClientSelectionRequest = {
      ...noOpRequest,
      operation_id: clientOperationIdSchema.parse("op_plan_client_clear"),
      expected_pending_revision: 3
    };
    const exitRequest: HostDeckPlanClientSelectionRequest = {
      ...enterRequest,
      operation_id: clientOperationIdSchema.parse("op_plan_client_exit"),
      action: "exit"
    };
    const responses = [
      stagedSnapshot(replacementRequest.operation_id, "plan", 4),
      confirmedSnapshot("plan"),
      confirmedSnapshot("plan"),
      stagedSnapshot(exitRequest.operation_id, "default", 1)
    ];
    const client = createHostDeckPlanClient({ baseUrl, fetch: async () => jsonResponse(200, responses.shift()) });

    await expect(client.select(replacementRequest)).resolves.toMatchObject({ pending: { revision: 4 } });
    await expect(client.select(noOpRequest)).resolves.toMatchObject({ current: { mode: "plan" }, pending: null });
    await expect(client.select(clearRequest)).resolves.toMatchObject({ current: { mode: "plan" }, pending: null });
    await expect(client.select(exitRequest)).resolves.toMatchObject({ pending: { mode: "default" } });
  });

  it("rejects malformed, cross-operation, stale-revision, and contradictory success data", async () => {
    const replacementRequest: HostDeckPlanClientSelectionRequest = {
      ...enterRequest,
      expected_pending_revision: 3
    };
    const staged = stagedSnapshot(operationId, "plan", 4);
    const candidates = [
      { ...staged, extra: true },
      stagedSnapshot("op_plan_client_other", "plan", 4),
      stagedSnapshot(operationId, "default", 4),
      stagedSnapshot(operationId, "plan", 3),
      stagedSnapshot(operationId, "plan", 2),
      planSnapshot(),
      confirmedSnapshot("default"),
      { ...confirmedSnapshot("plan"), modes: [] },
      null
    ];
    let calls = 0;
    const client = createHostDeckPlanClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, candidates.shift());
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.select(replacementRequest)).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck daemon returned invalid managed-session Plan data."
      });
    }
    expect(calls).toBe(count);
  });

  it("accepts strict read uncertainty and pending conflict without mutation correlation", async () => {
    const snapshots = [planSnapshot(), conflictSnapshot()];
    const client = createHostDeckPlanClient({ baseUrl, fetch: async () => jsonResponse(200, snapshots.shift()) });
    await expect(client.read(sessionId)).resolves.toMatchObject({ current: { state: "unknown" }, pending: null });
    await expect(client.read(sessionId)).resolves.toMatchObject({ pending: { phase: "conflict" } });
  });

  it("sanitizes typed API failures and maps transport/JSON failures once", async () => {
    const cases = [
      [400, "validation_error", "current state"],
      [404, "session_not_found", "was not found"],
      [409, "stale_session", "requires reconciliation"],
      [409, "capability_unavailable", "selected runtime"],
      [409, "operation_conflict", "cannot be replaced"],
      [409, "unknown_error", "requires reconciliation"],
      [503, "runtime_unavailable", "is unavailable"],
      [503, "audit_unavailable", "audit is unavailable"],
      [502, "protocol_error", "protocol validation"],
      [403, "read_only", "Write permission"]
    ] as const;
    let calls = 0;
    const client = createHostDeckPlanClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls++];
        if (current === undefined) throw new Error("unexpected Plan fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private Plan runtime, cwd, thread, cookie, token",
            retryable: current[0] === 503,
            details: { private_key: "private" }
          }
        });
      }
    });
    for (const [status, code, message] of cases) {
      await expect(client.read(sessionId)).rejects.toMatchObject({
        kind: "api_error",
        status,
        code,
        message: expect.stringContaining(message)
      });
    }

    const preserved = clientOperationFailure("operation_timeout", "selected bounded timeout");
    const failures: HttpFetch[] = [
      async () => {
        throw new Error("private-plan-fetch");
      },
      async () => ({ status: 200, ok: false }) as never,
      async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("private-plan-json");
        },
        text: async () => "private"
      }),
      async () => jsonResponse(500, { error: { message: "private-plan-untyped" } }),
      async () => {
        throw preserved;
      }
    ];
    for (const fetch of failures) {
      try {
        await createHostDeckPlanClient({ baseUrl, fetch }).read(sessionId);
        throw new Error("Expected plan-client failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailure);
        expect((error as Error).message).not.toMatch(/private-plan/iu);
      }
    }
  });
});

function planSnapshot() {
  return planControlSnapshotSchema.parse({
    catalog_revision: "c".repeat(64),
    catalog_observed_at: "2026-07-16T04:00:00.000Z",
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

function stagedSnapshot(operationIdCandidate: string, mode: "default" | "plan", revision: number) {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    pending: {
      revision,
      selection_operation_id: operationIdCandidate,
      mode,
      catalog_state: "available",
      phase: "pending",
      selected_at: "2026-07-16T04:00:00.000Z",
      turn_id: null,
      resolved_settings: null,
      error: null
    }
  });
}

function confirmedSnapshot(mode: "default" | "plan") {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    current: {
      state: "confirmed",
      mode,
      runtime_model: "runtime-a",
      reasoning_effort: "high",
      observed_at: "2026-07-16T04:00:00.000Z"
    }
  });
}

function conflictSnapshot() {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    pending: {
      revision: 3,
      selection_operation_id: "op_plan_client_conflict",
      mode: "plan",
      catalog_state: "unknown",
      phase: "conflict",
      selected_at: "2026-07-16T04:00:00.000Z",
      turn_id: null,
      resolved_settings: null,
      error: { code: "operation_conflict", message: "Plan selection conflicts.", retryable: false }
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
