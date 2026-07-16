import {
  clientOperationIdSchema,
  modelControlSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";
import {
  createHostDeckModelClient,
  type HostDeckModelClientSelectionRequest
} from "./model-client.js";

const sessionId = "sess_model_client_001";
const threadId = "thread-model-client-001";
const baseUrl = new URL("http://127.0.0.1:3777");
const operationId = clientOperationIdSchema.parse("op_model_client_001");
const selectionRequest: HostDeckModelClientSelectionRequest = {
  session_id: sessionId,
  operation_id: operationId,
  kind: "model",
  model_id: "model-b",
  reasoning_effort: null,
  expected_pending_revision: null
};

describe("managed-session model CLI client", () => {
  it("snapshots one exact accessor-free configuration and receiverless fetch", async () => {
    const mutableUrl = new URL(baseUrl);
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    let fetch: HttpFetch = function fetchModel(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, modelSnapshot()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckModelClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-model-fetch-private");
    };
    mutableOptions.fetch = fetch;

    const snapshot = await client.read(sessionId);
    expect(requests).toEqual([`http://127.0.0.1:3777/api/v1/sessions/${sessionId}/model`]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.models)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private-model-base-accessor");
      }
    });
    const hostileProxy = new Proxy(
      { baseUrl: new URL(baseUrl) },
      { ownKeys: () => { throw new Error("private-model-options-proxy"); } }
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
      expect(() => createHostDeckModelClient(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("rejects every non-exact loopback base before fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, modelSnapshot());
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
      expect(() => createHostDeckModelClient({ baseUrl: new URL(url), fetch })).toThrowError(
        expect.objectContaining({ code: "invalid_config" })
      );
    }
    expect(calls).toBe(0);
  });

  it("issues one exact GET and one canonical POST without retry", async () => {
    const requests: Array<{ readonly init: Record<string, unknown>; readonly url: string }> = [];
    const responses = [modelSnapshot(), stagedSnapshot(selectionRequest.operation_id)];
    const client = createHostDeckModelClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ init: init as unknown as Record<string, unknown>, url });
        return jsonResponse(200, responses.shift());
      }
    });
    await expect(client.read(sessionId)).resolves.toEqual(modelSnapshot());
    await expect(client.select(selectionRequest)).resolves.toEqual(stagedSnapshot(selectionRequest.operation_id));
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
            operation_id: selectionRequest.operation_id,
            kind: "model",
            model_id: "model-b",
            reasoning_effort: null,
            expected_pending_revision: null
          })
        }
      }
    ]);
  });

  it("rejects malformed sessions and selection bodies before fetch", async () => {
    let calls = 0;
    const client = createHostDeckModelClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, modelSnapshot());
      }
    });
    for (const candidate of ["", "model-client", threadId, "sess with spaces", `${sessionId}/other`]) {
      await expect(client.read(candidate)).rejects.toMatchObject({ code: "malformed_request", field: "session" });
    }
    for (const candidate of [
      { ...selectionRequest, session_id: threadId },
      { ...selectionRequest, operation_id: "bad" },
      { ...selectionRequest, model_id: "" },
      { ...selectionRequest, reasoning_effort: "" },
      { ...selectionRequest, expected_pending_revision: 0 },
      { ...selectionRequest, target: { session_id: sessionId } }
    ]) {
      await expect(client.select(candidate as never)).rejects.toMatchObject({ code: "malformed_request", field: "model" });
    }
    expect(calls).toBe(0);
  });

  it("accepts exact staged, already-current, and pending-clear results", async () => {
    const noOpRequest = {
      ...selectionRequest,
      operation_id: clientOperationIdSchema.parse("op_model_client_noop"),
      model_id: "model-a",
      reasoning_effort: "high"
    };
    const clearRequest = {
      ...noOpRequest,
      operation_id: clientOperationIdSchema.parse("op_model_client_clear"),
      expected_pending_revision: 3
    };
    const responses = [stagedSnapshot(selectionRequest.operation_id), modelSnapshot(), modelSnapshot()];
    const client = createHostDeckModelClient({
      baseUrl,
      fetch: async () => jsonResponse(200, responses.shift())
    });
    await expect(client.select(selectionRequest)).resolves.toMatchObject({ pending: { revision: 4 } });
    await expect(client.select(noOpRequest)).resolves.toMatchObject({ pending: null });
    await expect(client.select(clearRequest)).resolves.toMatchObject({ pending: null });
  });

  it("rejects malformed, cross-operation, stale-revision, and contradictory success data", async () => {
    const candidates = [
      { ...stagedSnapshot(selectionRequest.operation_id), extra: true },
      stagedSnapshot("op_model_client_other"),
      {
        ...stagedSnapshot(selectionRequest.operation_id),
        pending: { ...stagedSnapshot(selectionRequest.operation_id).pending, revision: 3 }
      },
      {
        ...stagedSnapshot(selectionRequest.operation_id),
        pending: { ...stagedSnapshot(selectionRequest.operation_id).pending, revision: 2 }
      },
      modelSnapshot(),
      { ...modelSnapshot(), models: [] },
      null
    ];
    let calls = 0;
    const request = { ...selectionRequest, expected_pending_revision: 3 };
    const client = createHostDeckModelClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, candidates.shift());
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.select(request)).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck daemon returned invalid managed-session model data."
      });
    }
    expect(calls).toBe(count);
  });

  it("sanitizes typed API failures and maps transport/JSON failures once", async () => {
    const cases = [
      [400, "validation_error", "absent from the live catalog"],
      [404, "session_not_found", "was not found"],
      [409, "stale_session", "requires reconciliation"],
      [409, "capability_unavailable", "selected runtime"],
      [409, "operation_conflict", "cannot be replaced"],
      [503, "runtime_unavailable", "is unavailable"],
      [503, "audit_unavailable", "audit is unavailable"],
      [502, "protocol_error", "protocol validation"],
      [403, "read_only", "Write permission"]
    ] as const;
    let calls = 0;
    const client = createHostDeckModelClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls++];
        if (current === undefined) throw new Error("unexpected model fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private model runtime, cwd, thread, cookie, token",
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
      async () => { throw new Error("private-model-fetch"); },
      async () => ({ status: 200, ok: false }) as never,
      async () => ({
        status: 200,
        ok: true,
        json: async () => { throw new Error("private-model-json"); },
        text: async () => "private"
      }),
      async () => jsonResponse(500, { error: { message: "private-model-untyped" } }),
      async () => { throw preserved; }
    ];
    for (const fetch of failures) {
      try {
        await createHostDeckModelClient({ baseUrl, fetch }).read(sessionId);
        throw new Error("Expected model-client failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailure);
        expect((error as Error).message).not.toMatch(/private-model/iu);
      }
    }
  });
});

function modelSnapshot() {
  return modelControlSnapshotSchema.parse({
    catalog_revision: "a".repeat(64),
    catalog_observed_at: "2026-07-16T04:00:00.000Z",
    current: {
      model_id: "model-a",
      runtime_model: "runtime-a",
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

function stagedSnapshot(operationId: string) {
  return modelControlSnapshotSchema.parse({
    ...modelSnapshot(),
    pending: {
      revision: 4,
      selection_operation_id: operationId,
      model_id: "model-b",
      runtime_model: "runtime-b",
      reasoning_effort: "high",
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
