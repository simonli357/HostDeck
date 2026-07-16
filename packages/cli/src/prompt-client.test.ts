import {
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import {
  createHostDeckPromptClient,
  type HostDeckPromptClientRequest
} from "./prompt-client.js";

const baseUrl = new URL("http://127.0.0.1:3777");
const privatePrompt = "PROMPT_PRIVATE_SENTINEL continue the selected task";
const request: HostDeckPromptClientRequest = Object.freeze({
  ...promptSessionRequestSchema.parse({
    operation_id: "op_prompt_client_001",
    kind: "prompt",
    text: privatePrompt
  }),
  session_id: sessionIdSchema.parse("sess_prompt_client_001")
});

describe("managed-session prompt CLI client", () => {
  it("snapshots exact accessor-free loopback configuration", async () => {
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = async (url) => {
      requests.push(url);
      return jsonResponse(202, response());
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckPromptClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-fetch-private-sentinel");
    };
    mutableOptions.fetch = fetch;

    const result = await client.send(request);
    expect(requests).toEqual([
      "http://127.0.0.1:3777/api/v1/sessions/sess_prompt_client_001/prompts"
    ]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.target)).toBe(true);

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("base-url-accessor-private-sentinel");
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: new URL(baseUrl), extra: true },
      Object.assign(Object.create({ inherited: true }), {
        baseUrl: new URL(baseUrl)
      }),
      { baseUrl: "http://127.0.0.1:3777" },
      { baseUrl: new URL(baseUrl), fetch: null },
      accessor
    ]) {
      expect(() => createHostDeckPromptClient(candidate as never)).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("accepts only direct loopback HTTP base URLs before fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(202, response());
    };
    for (const url of [
      "https://127.0.0.1:3777",
      "http://0.0.0.0:3777",
      "http://192.0.2.10:3777",
      "http://user:password@127.0.0.1:3777",
      "http://127.0.0.1:3777/api",
      "http://127.0.0.1:3777?prompt=private",
      "http://127.0.0.1:3777#private"
    ]) {
      expect(() =>
        createHostDeckPromptClient({ baseUrl: new URL(url), fetch })
      ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
    }
    expect(calls).toBe(0);
  });

  it("issues one exact no-store POST with a target-free body", async () => {
    const requests: unknown[] = [];
    const client = createHostDeckPromptClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(202, response());
      }
    });

    await expect(client.send(request)).resolves.toEqual(response());
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3777/api/v1/sessions/sess_prompt_client_001/prompts",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: request.operation_id,
            kind: "prompt",
            text: privatePrompt
          })
        }
      }
    ]);
  });

  it("rejects malformed input before fetch and requires exact 202 success", async () => {
    let calls = 0;
    const client = createHostDeckPromptClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, response());
      }
    });
    for (const candidate of [
      null,
      {},
      { ...request, operation_id: "invalid" },
      { ...request, session_id: "invalid" },
      { ...request, text: "   " },
      { ...request, text: "x".repeat(20_001) },
      { ...request, target: response().target },
      { ...request, codex_thread_id: "thread-injected" }
    ]) {
      await expect(client.send(candidate as never)).rejects.toMatchObject({
        code: "malformed_request",
        exitCode: 64,
        field: "send"
      });
    }
    expect(calls).toBe(0);
    await expect(client.send(request)).rejects.toMatchObject({
      code: "internal_error",
      message: "HostDeck daemon returned invalid managed-session prompt data."
    });
    expect(calls).toBe(1);
  });

  it("rejects cross-operation, cross-session, wrong-action, extra-field, and hostile receipts", async () => {
    const hostile = Object.defineProperty({}, "operation_id", {
      enumerable: true,
      get() {
        throw new Error("hostile-output-private-sentinel");
      }
    });
    const candidates: unknown[] = [
      response({ operation_id: "op_prompt_client_other" }),
      response({
        target: {
          type: "managed_session",
          session_id: "sess_prompt_client_other",
          codex_thread_id: "thread-prompt-client-001"
        }
      }),
      { ...response(), action: "resume" },
      { ...response(), kind: "model" },
      { ...response(), extra: true },
      hostile,
      null,
      []
    ];
    let calls = 0;
    const client = createHostDeckPromptClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(202, candidates.shift());
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.send(request)).rejects.toMatchObject({
        code: "internal_error",
        exitCode: 1,
        message: "HostDeck daemon returned invalid managed-session prompt data."
      });
    }
    expect(calls).toBe(count);
  });

  it("sanitizes typed API failures and never retries", async () => {
    const cases = [
      [404, "session_not_found", "does not exist"],
      [409, "session_not_writable", "cannot accept"],
      [409, "stale_session", "requires reconciliation"],
      [423, "host_locked", "host is locked"],
      [409, "incompatible_runtime", "cannot safely dispatch"],
      [503, "runtime_unavailable", "runtime is unavailable"],
      [409, "operation_conflict", "operation is active"],
      [409, "unknown_error", "outcome is unknown"],
      [503, "audit_unavailable", "audit is unavailable"],
      [500, "storage_error", "storage is unavailable"],
      [504, "operation_timeout", "timed out"],
      [503, "service_overloaded", "capacity is exhausted"],
      [403, "read_only", "Write permission"],
      [401, "permission_denied", "not permitted"]
    ] as const;
    let calls = 0;
    const client = createHostDeckPromptClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls++];
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: `${privatePrompt} private cwd, thread id, cookie, and raw error`,
            retryable: false,
            details: { private_key: "private" }
          }
        });
      }
    });
    for (const [status, code, message] of cases) {
      try {
        await client.send(request);
        throw new Error("Expected prompt API failure.");
      } catch (error) {
        expect(error).toMatchObject({
          kind: "api_error",
          status,
          code,
          message: expect.stringContaining(message)
        });
        expect(String((error as Error).message)).not.toContain(privatePrompt);
      }
    }
    expect(calls).toBe(cases.length);
  });

  it("bounds transport, malformed JSON, and untyped failures without leakage or retry", async () => {
    const fetches: HttpFetch[] = [
      async () => {
        throw new Error(`${privatePrompt} fetch failure`);
      },
      async () => ({ status: 202, ok: false } as never),
      async () => ({
        status: 202,
        ok: true,
        json: async () => {
          throw new Error(`${privatePrompt} JSON failure`);
        },
        text: async () => privatePrompt
      }),
      async () => jsonResponse(500, { private: privatePrompt })
    ];
    for (const fetch of fetches) {
      const client = createHostDeckPromptClient({ baseUrl, fetch });
      try {
        await client.send(request);
        throw new Error("Expected prompt client failure.");
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(privatePrompt);
      }
    }
  });
});

function response(
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return promptDispatchResponseSchema.parse({
    operation_id: request.operation_id,
    kind: "prompt",
    target: {
      type: "managed_session",
      session_id: request.session_id,
      codex_thread_id: "thread-prompt-client-001"
    },
    state: "accepted",
    accepted_at: "2026-07-15T20:00:00.000Z",
    audit_record_id: "audit_prompt_client_001",
    turn_id: "turn-prompt-client-001",
    action: "start",
    ...overrides
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
