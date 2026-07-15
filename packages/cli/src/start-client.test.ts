import {
  type SelectedSessionStartResponse,
  selectedSessionStartResponseSchema,
  selectedStartSessionRequestSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";
import { createHostDeckStartClient } from "./start-client.js";

const baseUrl = new URL("http://127.0.0.1:3777");
const operationId = "op_session_start_client_001";
const request = selectedStartSessionRequestSchema.parse({
  operation_id: operationId,
  name: "client-session",
  cwd: "/tmp/hostdeck-client-session"
});

describe("managed-session start CLI client", () => {
  it("snapshots one exact accessor-free loopback client configuration", async () => {
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = function fetchStart(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(201, response()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckStartClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-fetch-private-sentinel");
    };
    mutableOptions.fetch = fetch;

    const result = await client.start(request);
    expect(requests).toEqual(["http://127.0.0.1:3777/api/v1/sessions"]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.session)).toBe(true);

    let accessorCalls = 0;
    const baseUrlAccessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("base-url-accessor-private-sentinel");
      }
    });
    const fetchAccessor = Object.defineProperties(
      {},
      {
        baseUrl: { enumerable: true, value: new URL(baseUrl) },
        fetch: {
          enumerable: true,
          get() {
            accessorCalls += 1;
            throw new Error("fetch-accessor-private-sentinel");
          }
        }
      }
    );
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
      baseUrlAccessor,
      fetchAccessor
    ]) {
      expect(() => createHostDeckStartClient(candidate as never)).toThrow(
        TypeError
      );
    }
    expect(accessorCalls).toBe(0);
  });

  it("accepts only direct loopback HTTP base URLs before any fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(201, response());
    };
    for (const url of [
      "https://127.0.0.1:3777",
      "http://0.0.0.0:3777",
      "http://192.0.2.10:3777",
      "http://user:password@127.0.0.1:3777",
      "http://127.0.0.1:3777/api",
      "http://127.0.0.1:3777?cwd=private",
      "http://127.0.0.1:3777#private"
    ]) {
      expect(() =>
        createHostDeckStartClient({ baseUrl: new URL(url), fetch })
      ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
    }
    expect(calls).toBe(0);
  });

  it("issues one exact no-store JSON POST and returns a frozen correlated response", async () => {
    const requests: unknown[] = [];
    const client = createHostDeckStartClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(201, response());
      }
    });

    await expect(client.start(request)).resolves.toEqual(response());
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3777/api/v1/sessions",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        }
      }
    ]);
  });

  it("requires the exact 201 success status", async () => {
    const client = createHostDeckStartClient({
      baseUrl,
      fetch: async () => jsonResponse(200, response())
    });

    await expect(client.start(request)).rejects.toMatchObject({
      code: "internal_error",
      message: "HostDeck daemon returned invalid managed-session start data."
    });
  });

  it("rejects malformed requests before fetch and never accepts caller-supplied thread identity", async () => {
    let calls = 0;
    const client = createHostDeckStartClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(201, response());
      }
    });
    for (const candidate of [
      null,
      {},
      { ...request, operation_id: "invalid" },
      { ...request, name: "invalid name" },
      { ...request, cwd: "relative" },
      { ...request, codex_thread_id: "thread-injected" }
    ]) {
      await expect(client.start(candidate as never)).rejects.toMatchObject({
        code: "malformed_request",
        exitCode: 64,
        field: "start"
      });
    }
    expect(calls).toBe(0);
  });

  it("rejects cross-operation, cross-input, extra-field, and hostile success payloads", async () => {
    const hostile = Object.defineProperty({}, "operation_id", {
      enumerable: true,
      get() {
        throw new Error("hostile-output-private-sentinel");
      }
    });
    const candidates = [
      response({ operation_id: "op_session_start_client_other" }),
      response({ session: { ...response().session, name: "other-session" } }),
      response({ session: { ...response().session, cwd: "/tmp/other" } }),
      { ...response(), codex_thread_id: "thread-injected" },
      { ...response(), session: { ...response().session, backend: { type: "tmux" } } },
      hostile,
      null,
      []
    ];
    let calls = 0;
    const client = createHostDeckStartClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(201, candidates.shift());
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.start(request)).rejects.toMatchObject({
        code: "internal_error",
        exitCode: 1,
        message: "HostDeck daemon returned invalid managed-session start data."
      });
    }
    expect(calls).toBe(count);
  });

  it("sanitizes typed API failures and never retries", async () => {
    const cases = [
      [409, "duplicate_session_name", "name already exists"],
      [400, "invalid_cwd", "working directory is unavailable"],
      [423, "host_locked", "host is locked"],
      [409, "incompatible_runtime", "cannot start managed sessions"],
      [503, "runtime_unavailable", "runtime is unavailable"],
      [409, "operation_conflict", "requires recovery"],
      [503, "audit_unavailable", "audit is unavailable"],
      [500, "storage_error", "storage is unavailable"],
      [504, "operation_timeout", "timed out"],
      [503, "service_overloaded", "capacity is exhausted"],
      [403, "read_only", "Write permission"],
      [401, "permission_denied", "not permitted"]
    ] as const;
    let calls = 0;
    const client = createHostDeckStartClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls++];
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private cwd, thread id, cookie, and raw error",
            retryable: current[0] === 503,
            details: { private_key: "private" }
          }
        });
      }
    });
    for (const [status, code, message] of cases) {
      await expect(client.start(request)).rejects.toMatchObject({
        kind: "api_error",
        status,
        code,
        message: expect.stringContaining(message)
      });
    }
    expect(calls).toBe(cases.length);
  });

  it("maps transport, malformed HTTP, JSON, and untyped failures without leakage or retry", async () => {
    const preserved = clientOperationFailure(
      "operation_timeout",
      "selected bounded timeout"
    );
    let calls = 0;
    const failures: HttpFetch[] = [
      async () => {
        calls += 1;
        throw new Error("fetch-private-sentinel");
      },
      async () => {
        calls += 1;
        return { status: 201, ok: false } as never;
      },
      async () => {
        calls += 1;
        return {
          status: 201,
          ok: true,
          json: async () => {
            throw new Error("json-private-sentinel");
          },
          text: async () => "private"
        };
      },
      async () => {
        calls += 1;
        return jsonResponse(500, {
          error: { message: "untyped-private-sentinel" }
        });
      },
      async () => {
        calls += 1;
        throw preserved;
      }
    ];
    for (const fetch of failures) {
      try {
        await createHostDeckStartClient({ baseUrl, fetch }).start(request);
        throw new Error("Expected start-client failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailure);
        expect((error as Error).message).not.toMatch(
          /fetch-private|json-private|untyped-private/iu
        );
      }
    }
    expect(calls).toBe(failures.length);
  });
});

function response(
  overrides: Readonly<Record<string, unknown>> = {}
): SelectedSessionStartResponse {
  const base = {
    operation_id: operationId,
    session: {
      id: "sess_start_client_001",
      name: request.name,
      codex_thread_id: "thread-start-client-001",
      cwd: request.cwd,
      runtime_source: "codex_app_server" as const,
      runtime_version: "0.144.0",
      created_at: "2026-07-15T18:00:00.000Z",
      archived_at: null,
      session_state: "active" as const,
      turn_state: "idle" as const,
      attention: "none" as const,
      freshness: "current" as const,
      freshness_reason: null,
      updated_at: "2026-07-15T18:00:00.000Z",
      last_activity_at: "2026-07-15T18:00:00.000Z",
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Managed Codex session ready.",
      last_event_cursor: null
    }
  };
  return selectedSessionStartResponseSchema.parse({ ...base, ...overrides });
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
