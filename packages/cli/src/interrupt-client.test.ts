import {
  type InterruptResponse,
  interruptRequestSchema,
  interruptResponseSchema,
  sessionTurnParamsSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { createHostDeckInterruptClient, type HostDeckInterruptClientRequest } from "./interrupt-client.js";

const baseUrl = new URL("http://127.0.0.1:3777");
const sessionId = "sess_interrupt_client_001";
const otherSessionId = "sess_interrupt_client_002";
const threadId = "thread-interrupt-client-001";
const turnId = "turn-interrupt-client-001";
const operationId = "op_interrupt_client_0001";
const request: HostDeckInterruptClientRequest = {
  ...sessionTurnParamsSchema.parse({ session_id: sessionId, turn_id: turnId }),
  ...interruptRequestSchema.parse({ operation_id: operationId, kind: "interrupt", confirm: true })
};

describe("interrupt CLI client", () => {
  it("snapshots exact accessor-free loopback options and invokes fetch receiverlessly", async () => {
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = function fetchInterrupt(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, response()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckInterruptClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated fetch private sentinel");
    };
    mutableOptions.fetch = fetch;

    const result = await client.interrupt(request);
    expect(requests).toEqual([
      `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/turns/${turnId}/interrupt`
    ]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.target)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("must not run");
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: new URL(baseUrl), extra: true },
      { baseUrl: "http://127.0.0.1:3777" },
      { baseUrl: new URL(baseUrl), fetch: null },
      Object.assign(Object.create({ inherited: true }), { baseUrl: new URL(baseUrl) }),
      accessor
    ]) {
      expect(() => createHostDeckInterruptClient(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("accepts only direct loopback HTTP before any fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, response());
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
      expect(() => createHostDeckInterruptClient({ baseUrl: new URL(url), fetch })).toThrowError(
        expect.objectContaining({ code: "invalid_config" })
      );
    }
    expect(calls).toBe(0);
  });

  it("issues one exact target-free confirmed POST and returns terminal proof", async () => {
    const requests: Array<{ readonly init: unknown; readonly url: string }> = [];
    const client = createHostDeckInterruptClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(200, response());
      }
    });

    await expect(client.interrupt(request)).resolves.toEqual(response());
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/turns/${turnId}/interrupt`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({ operation_id: operationId, kind: "interrupt", confirm: true })
        }
      }
    ]);
    expect(requests[0]).not.toMatchObject({ target: expect.anything(), thread_id: expect.anything() });
  });

  it("rejects malformed targets and request input before fetch", async () => {
    let calls = 0;
    const client = createHostDeckInterruptClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, response());
      }
    });
    for (const candidate of [
      { ...request, session_id: "" },
      { ...request, turn_id: "" },
      { ...request, confirm: false },
      { ...request, operation_id: "invalid" },
      { ...request, target: { session_id: sessionId } },
      { ...request, thread_id: threadId },
      { ...request, force: true }
    ]) {
      await expect(client.interrupt(candidate as never)).rejects.toMatchObject({
        code: "malformed_request",
        field: "interrupt"
      });
    }
    expect(calls).toBe(0);
  });

  it("rejects cross-target, cross-operation, nonterminal, hostile, and wrong-status success", async () => {
    const hostile = Object.defineProperty({}, "target", {
      enumerable: true,
      get() {
        throw new Error("hostile success private sentinel");
      }
    });
    const candidates = [
      { ...response(), operation_id: "op_interrupt_client_other" },
      { ...response(), target: { ...response().target, session_id: otherSessionId } },
      { ...response(), target: { ...response().target, turn_id: "turn-interrupt-client-other" } },
      { ...response(), state: "accepted" },
      { ...response(), state: "failed", error: { code: "operation_conflict", message: "failed", retryable: false } },
      hostile,
      null
    ];
    let calls = 0;
    const client = createHostDeckInterruptClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, candidates.shift());
      }
    });
    for (let index = 0; index < 7; index += 1) {
      await expect(client.interrupt(request)).rejects.toMatchObject({ code: "internal_error" });
    }
    expect(calls).toBe(7);

    const wrongStatus = createHostDeckInterruptClient({
      baseUrl,
      fetch: async () => jsonResponse(202, response())
    });
    await expect(wrongStatus.interrupt(request)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("sanitizes typed failures and never retries", async () => {
    const cases = [
      [404, "session_not_found", "not found"],
      [409, "session_not_writable", "cannot provide"],
      [409, "stale_session", "reconciliation"],
      [409, "capability_unavailable", "selected runtime"],
      [409, "operation_conflict", "current turn"],
      [409, "unknown_error", "unknown"],
      [502, "protocol_error", "protocol validation"],
      [503, "runtime_unavailable", "unavailable"],
      [504, "operation_timeout", "terminal proof"],
      [500, "storage_error", "storage"],
      [403, "read_only", "Write permission"]
    ] as const;
    let calls = 0;
    const client = createHostDeckInterruptClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private daemon thread cookie token",
            retryable: current[1] === "runtime_unavailable"
          }
        });
      }
    });
    for (const [, code, message] of cases) {
      await expect(client.interrupt(request)).rejects.toMatchObject({
        code,
        message: expect.stringContaining(message)
      });
    }
    expect(calls).toBe(cases.length);
  });
});

function response(): InterruptResponse {
  return interruptResponseSchema.parse({
    operation_id: operationId,
    kind: "interrupt",
    target: {
      type: "turn",
      session_id: sessionId,
      codex_thread_id: threadId,
      turn_id: turnId
    },
    state: "interrupted",
    updated_at: "2026-07-16T19:00:00.000Z",
    turn_id: turnId,
    error: null
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
