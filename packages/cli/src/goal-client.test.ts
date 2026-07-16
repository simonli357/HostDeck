import { clientOperationIdSchema, goalControlSnapshotSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";
import {
  createHostDeckGoalClient,
  type HostDeckGoalClientMutationRequest
} from "./goal-client.js";

const sessionId = "sess_goal_client_001";
const threadId = "thread-goal-client-001";
const baseUrl = new URL("http://127.0.0.1:3777");
const operationId = clientOperationIdSchema.parse("op_goal_client_001");
const objective = "Deliver HostDeck V1.";
const originalRevision = "a".repeat(64);
const changedRevision = "b".repeat(64);
const mutationRequest: HostDeckGoalClientMutationRequest = {
  session_id: sessionId,
  operation_id: operationId,
  kind: "goal",
  action: "set",
  objective,
  expected_goal_revision: null
};

describe("managed-session goal CLI client", () => {
  it("snapshots one exact accessor-free configuration and receiverless fetch", async () => {
    const mutableUrl = new URL(baseUrl);
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    let fetch: HttpFetch = function fetchGoal(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, goalSnapshot()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckGoalClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-goal-fetch-private");
    };
    mutableOptions.fetch = fetch;

    const snapshot = await client.read(sessionId);
    expect(requests).toEqual([`http://127.0.0.1:3777/api/v1/sessions/${sessionId}/goal`]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.goal)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private-goal-base-accessor");
      }
    });
    const hostileProxy = new Proxy(
      { baseUrl: new URL(baseUrl) },
      {
        ownKeys: () => {
          throw new Error("private-goal-options-proxy");
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
      expect(() => createHostDeckGoalClient(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("rejects every non-exact loopback base before fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, goalSnapshot());
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
      expect(() => createHostDeckGoalClient({ baseUrl: new URL(url), fetch })).toThrowError(
        expect.objectContaining({ code: "invalid_config" })
      );
    }
    expect(calls).toBe(0);
  });

  it("issues one exact GET and one canonical target-free POST without retry", async () => {
    const requests: Array<{ readonly init: Record<string, unknown>; readonly url: string }> = [];
    const responses = [goalSnapshot(), goalSnapshot({ revision: changedRevision })];
    const client = createHostDeckGoalClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ init: init as unknown as Record<string, unknown>, url });
        return jsonResponse(200, responses.shift());
      }
    });
    await expect(client.read(sessionId)).resolves.toEqual(goalSnapshot());
    await expect(client.mutate(mutationRequest)).resolves.toEqual(goalSnapshot({ revision: changedRevision }));
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

  it("rejects malformed sessions and mutation bodies before fetch", async () => {
    let calls = 0;
    const client = createHostDeckGoalClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, goalSnapshot());
      }
    });
    for (const candidate of ["", "goal-client", threadId, "sess with spaces", `${sessionId}/other`]) {
      await expect(client.read(candidate)).rejects.toMatchObject({ code: "malformed_request", field: "session" });
    }
    for (const candidate of [
      { ...mutationRequest, session_id: threadId },
      { ...mutationRequest, operation_id: "bad" },
      { ...mutationRequest, objective: null },
      { ...mutationRequest, expected_goal_revision: "A".repeat(64) },
      { ...mutationRequest, action: "pause", objective, expected_goal_revision: originalRevision },
      { ...mutationRequest, action: "pause", objective: null, expected_goal_revision: null },
      { ...mutationRequest, target: { session_id: sessionId } },
      { ...mutationRequest, token_budget: 1_000 }
    ]) {
      await expect(client.mutate(candidate as never)).rejects.toMatchObject({
        code: "malformed_request",
        field: "goal"
      });
    }
    expect(calls).toBe(0);
  });

  it("accepts exact read uncertainty, lifecycle changes, and legal no-op snapshots", async () => {
    const requests: HostDeckGoalClientMutationRequest[] = [
      { ...mutationRequest, expected_goal_revision: originalRevision },
      lifecycleRequest("pause"),
      lifecycleRequest("resume"),
      lifecycleRequest("complete"),
      lifecycleRequest("clear")
    ];
    const responses = [
      goalSnapshot({ revision: originalRevision, status: "paused" }),
      goalSnapshot({ revision: originalRevision, status: "paused" }),
      goalSnapshot({ revision: changedRevision, status: "active" }),
      goalSnapshot({ revision: originalRevision, status: "complete" }),
      goalControlSnapshotSchema.parse({ goal: null, uncertain_mutation: null })
    ];
    const client = createHostDeckGoalClient({
      baseUrl,
      fetch: async () => jsonResponse(200, responses.shift())
    });
    for (const request of requests) await expect(client.mutate(request)).resolves.toBeDefined();

    const uncertain = uncertainSnapshot();
    const readClient = createHostDeckGoalClient({ baseUrl, fetch: async () => jsonResponse(200, uncertain) });
    await expect(readClient.read(sessionId)).resolves.toEqual(uncertain);
  });

  it("rejects malformed and action-contradictory success data", async () => {
    const candidates: readonly [HostDeckGoalClientMutationRequest, unknown][] = [
      [mutationRequest, { ...goalSnapshot({ revision: changedRevision }), extra: true }],
      [mutationRequest, uncertainSnapshot()],
      [mutationRequest, goalControlSnapshotSchema.parse({ goal: null, uncertain_mutation: null })],
      [mutationRequest, goalSnapshot({ revision: changedRevision, status: "active" })],
      [mutationRequest, goalSnapshot({ revision: changedRevision, objective: "Wrong objective." })],
      [lifecycleRequest("pause"), goalSnapshot({ revision: changedRevision, status: "active" })],
      [lifecycleRequest("resume"), goalSnapshot({ revision: originalRevision, status: "active" })],
      [lifecycleRequest("complete"), goalSnapshot({ revision: changedRevision, status: "paused" })],
      [lifecycleRequest("clear"), goalSnapshot({ revision: changedRevision })],
      [mutationRequest, null]
    ];
    let calls = 0;
    const client = createHostDeckGoalClient({
      baseUrl,
      fetch: async () => jsonResponse(200, candidates[calls++]?.[1])
    });
    for (const [request] of candidates) {
      await expect(client.mutate(request)).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck daemon returned invalid managed-session goal data."
      });
    }
    expect(calls).toBe(candidates.length);
  });

  it("sanitizes typed API failures and maps transport and JSON failures once", async () => {
    const cases = [
      [400, "validation_error", "current goal state"],
      [404, "session_not_found", "was not found"],
      [409, "stale_session", "requires reconciliation"],
      [409, "capability_unavailable", "selected runtime"],
      [409, "operation_conflict", "cannot perform"],
      [409, "unknown_error", "outcome is unknown"],
      [503, "runtime_unavailable", "is unavailable"],
      [503, "audit_unavailable", "audit is unavailable"],
      [502, "protocol_error", "protocol validation"],
      [403, "read_only", "Write permission"]
    ] as const;
    let calls = 0;
    const client = createHostDeckGoalClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls++];
        if (current === undefined) throw new Error("unexpected goal fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private goal runtime, cwd, thread, cookie, token",
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
        throw new Error("private-goal-fetch");
      },
      async () => ({ status: 200, ok: false }) as never,
      async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("private-goal-json");
        },
        text: async () => "private"
      }),
      async () => jsonResponse(500, { error: { message: "private-goal-untyped" } }),
      async () => {
        throw preserved;
      }
    ];
    for (const fetch of failures) {
      try {
        await createHostDeckGoalClient({ baseUrl, fetch }).read(sessionId);
        throw new Error("Expected goal-client failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailure);
        expect((error as Error).message).not.toMatch(/private-goal/iu);
      }
    }
  });
});

function lifecycleRequest(action: "clear" | "complete" | "pause" | "resume"): HostDeckGoalClientMutationRequest {
  return {
    ...mutationRequest,
    operation_id: clientOperationIdSchema.parse(`op_goal_client_${action}`),
    action,
    objective: null,
    expected_goal_revision: originalRevision
  };
}

function goalSnapshot(
  overrides: Partial<{ objective: string; revision: string; status: "active" | "complete" | "paused" }> = {}
) {
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

function uncertainSnapshot() {
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
        message: "Canonical uncertain goal state.",
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
