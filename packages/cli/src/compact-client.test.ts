import {
  clientOperationIdSchema,
  compactProgressResponseSchema,
  selectedOperationProgressSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import {
  createHostDeckCompactClient,
  type HostDeckCompactClientStartRequest
} from "./compact-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";

const sessionId = "sess_compact_client_001";
const threadId = "thread-compact-client-001";
const turnId = "turn-compact-client-001";
const baseUrl = new URL("http://127.0.0.1:3777");
const operationId = clientOperationIdSchema.parse("op_compact_client_001");
const startRequest: HostDeckCompactClientStartRequest = {
  session_id: sessionId,
  operation_id: operationId,
  kind: "compact",
  confirm: true
};

describe("managed-session compact CLI client", () => {
  it("snapshots exact accessor-free options and invokes fetch receiverlessly", async () => {
    const mutableUrl = new URL(baseUrl);
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    let fetch: HttpFetch = function fetchCompact(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, response(null)));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckCompactClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-compact-fetch-private");
    };
    mutableOptions.fetch = fetch;

    const result = await client.read(sessionId);
    expect(result).toEqual({ progress: null });
    expect(requests).toEqual([`http://127.0.0.1:3777/api/v1/sessions/${sessionId}/compact`]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("private-compact-base-accessor");
      }
    });
    const hostileProxy = new Proxy(
      { baseUrl: new URL(baseUrl) },
      {
        ownKeys: () => {
          throw new Error("private-compact-options-proxy");
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
      expect(() => createHostDeckCompactClient(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("rejects non-exact loopback bases before fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, response(null));
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
      expect(() => createHostDeckCompactClient({ baseUrl: new URL(url), fetch })).toThrowError(
        expect.objectContaining({ code: "invalid_config" })
      );
    }
    expect(calls).toBe(0);
  });

  it("issues one exact GET and one target-free confirmed POST without retry", async () => {
    const requests: Array<{ readonly init: Record<string, unknown>; readonly url: string }> = [];
    const responses = [response(null), response(progress("accepted", operationId))];
    const client = createHostDeckCompactClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ init: init as unknown as Record<string, unknown>, url });
        const candidate = responses.shift();
        return jsonResponse(candidate?.progress === null ? 200 : 202, candidate);
      }
    });
    await expect(client.read(sessionId)).resolves.toEqual({ progress: null });
    await expect(client.start(startRequest)).resolves.toEqual(response(progress("accepted", operationId)));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/compact`,
        init: {
          method: "GET",
          headers: { accept: "application/json", "cache-control": "no-store" }
        }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/compact`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({ operation_id: operationId, kind: "compact", confirm: true })
        }
      }
    ]);
  });

  it("rejects malformed sessions and start bodies before fetch", async () => {
    let calls = 0;
    const client = createHostDeckCompactClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, response(null));
      }
    });
    for (const candidate of ["", "compact-client", threadId, "sess with spaces", `${sessionId}/other`]) {
      await expect(client.read(candidate)).rejects.toMatchObject({ code: "malformed_request", field: "session" });
    }
    for (const candidate of [
      { ...startRequest, session_id: threadId },
      { ...startRequest, operation_id: "bad" },
      { ...startRequest, kind: "prompt" },
      { ...startRequest, confirm: false },
      { ...startRequest, target: { session_id: sessionId } },
      { ...startRequest, force: true },
      { ...startRequest, text: "/compact" }
    ]) {
      await expect(client.start(candidate as never)).rejects.toMatchObject({ code: "malformed_request", field: "compact" });
    }
    expect(calls).toBe(0);
  });

  it("accepts strict read states, explicit absence, and canonicalizes successful failure progress", async () => {
    const candidates = [
      response(null),
      response(progress("accepted")),
      response(progress("running")),
      response(progress("completed")),
      response(progress("interrupted")),
      response(progress("failed", operationId, "private-compact-error")),
      response(progress("incomplete", operationId, "private-compact-error"))
    ];
    const client = createHostDeckCompactClient({
      baseUrl,
      fetch: async () => jsonResponse(200, candidates.shift())
    });
    await expect(client.read(sessionId)).resolves.toEqual({ progress: null });
    for (const state of ["accepted", "running", "completed", "interrupted"] as const) {
      await expect(client.read(sessionId)).resolves.toMatchObject({ progress: { state } });
    }
    for (const state of ["failed", "incomplete"] as const) {
      const result = await client.read(sessionId);
      expect(result).toMatchObject({
        progress: {
          state,
          error: {
            code: "unknown_error",
            message: "Compact outcome is unknown and requires reconciliation."
          }
        }
      });
      expect(JSON.stringify(result)).not.toContain("private-compact");
    }
  });

  it("rejects malformed, cross-target, cross-operation, non-accepted, and wrong-status success data", async () => {
    const accepted = response(progress("accepted", operationId));
    const candidates: Array<{ readonly body: unknown; readonly status: number }> = [
      { status: 202, body: { ...accepted, extra: true } },
      { status: 202, body: response(progress("accepted", "op_compact_client_other")) },
      {
        status: 202,
        body: response({
          ...progress("accepted", operationId),
          target: { ...target(), session_id: "sess_compact_other_001" } as never
        })
      },
      { status: 202, body: response(progress("running", operationId)) },
      { status: 202, body: response(progress("completed", operationId)) },
      { status: 202, body: response(null) },
      { status: 200, body: accepted },
      { status: 202, body: null }
    ];
    let calls = 0;
    const client = createHostDeckCompactClient({
      baseUrl,
      fetch: async () => {
        const candidate = candidates[calls++];
        if (candidate === undefined) throw new Error("unexpected compact fetch");
        return jsonResponse(candidate.status, candidate.body);
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.start(startRequest)).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck daemon returned invalid managed-session compact data."
      });
    }
    expect(calls).toBe(count);

    const wrongReadStatus = createHostDeckCompactClient({
      baseUrl,
      fetch: async () => jsonResponse(202, response(null))
    });
    await expect(wrongReadStatus.read(sessionId)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("sanitizes typed API failures and maps transport or JSON failures once", async () => {
    const cases = [
      [400, "validation_error", "invalid"],
      [404, "session_not_found", "was not found"],
      [409, "stale_session", "requires reconciliation"],
      [409, "capability_unavailable", "selected runtime"],
      [409, "operation_conflict", "prior compact state"],
      [409, "unknown_error", "requires reconciliation"],
      [503, "runtime_unavailable", "is unavailable"],
      [503, "audit_unavailable", "audit is unavailable"],
      [502, "protocol_error", "protocol validation"],
      [403, "read_only", "Write permission"]
    ] as const;
    let calls = 0;
    const client = createHostDeckCompactClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls++];
        if (current === undefined) throw new Error("unexpected compact fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private compact runtime, cwd, thread, cookie, token",
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
        throw new Error("private-compact-fetch");
      },
      async () => ({ status: 200, ok: false }) as never,
      async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("private-compact-json");
        },
        text: async () => "private"
      }),
      async () => jsonResponse(500, { error: { message: "private-compact-untyped" } }),
      async () => {
        throw preserved;
      }
    ];
    for (const fetch of failures) {
      try {
        await createHostDeckCompactClient({ baseUrl, fetch }).read(sessionId);
        throw new Error("Expected compact-client failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailure);
        expect((error as Error).message).not.toMatch(/private-compact/iu);
      }
    }
  });
});

function target() {
  return { type: "managed_session" as const, session_id: sessionId, codex_thread_id: threadId };
}

function progress(
  state: "accepted" | "running" | "completed" | "interrupted" | "failed" | "incomplete",
  operationIdCandidate: string = operationId,
  message = "Compact outcome is unresolved."
) {
  return selectedOperationProgressSchema.parse({
    operation_id: operationIdCandidate,
    kind: "compact",
    target: target(),
    state,
    updated_at: "2026-07-16T13:00:00.000Z",
    turn_id: state === "accepted" || state === "incomplete" ? null : turnId,
    error: ["failed", "incomplete"].includes(state)
      ? { code: "unknown_error", message, retryable: false }
      : null
  });
}

function response(progressCandidate: ReturnType<typeof progress> | null) {
  return compactProgressResponseSchema.parse({ progress: progressCandidate });
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
