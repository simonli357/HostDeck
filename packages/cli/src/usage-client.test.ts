import { usageSnapshotSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";
import { createHostDeckUsageClient } from "./usage-client.js";

const sessionId = "sess_usage_client_001";
const otherSessionId = "sess_usage_client_002";
const threadId = "thread-usage-client-001";
const baseUrl = new URL("http://127.0.0.1:3777");

describe("managed-session usage CLI client", () => {
  it("snapshots one exact accessor-free loopback client configuration", async () => {
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = function fetchUsage(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, usageSnapshot()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckUsageClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-fetch-private-sentinel");
    };
    mutableOptions.fetch = fetch;

    const response = await client.read(sessionId);
    expect(requests).toEqual([
      `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/usage`
    ]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.account)).toBe(true);
    expect(Object.isFrozen(response.account.daily_buckets)).toBe(true);

    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      baseUrl: new URL(baseUrl),
      fetch: async () => jsonResponse(200, usageSnapshot())
    });
    await expect(
      createHostDeckUsageClient(nullInput as never).read(sessionId)
    ).resolves.toEqual(usageSnapshot());

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
    const hostileProxy = new Proxy(
      { baseUrl: new URL(baseUrl) },
      {
        ownKeys() {
          throw new Error("options-proxy-private-sentinel");
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
      fetchAccessor,
      hostileProxy
    ]) {
      expect(() =>
        createHostDeckUsageClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("accepts only direct loopback HTTP base URLs before any fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, usageSnapshot());
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
      expect(() =>
        createHostDeckUsageClient({ baseUrl: new URL(url), fetch })
      ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
    }
    expect(calls).toBe(0);
  });

  it("issues one exact no-store GET and accepts a complete snapshot", async () => {
    const requests: Array<{ readonly init: unknown; readonly url: string }> = [];
    const client = createHostDeckUsageClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ init, url });
        return jsonResponse(200, usageSnapshot());
      }
    });

    await expect(client.read(sessionId)).resolves.toEqual(usageSnapshot());
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/usage`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          }
        }
      }
    ]);
  });

  it("rejects malformed targets before fetch and never accepts a thread id", async () => {
    let calls = 0;
    const client = createHostDeckUsageClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, usageSnapshot());
      }
    });
    for (const candidate of [
      "",
      "usage-client",
      threadId,
      "sess with spaces",
      `${sessionId}/other`,
      `sess_${"x".repeat(200)}`
    ]) {
      await expect(client.read(candidate)).rejects.toMatchObject({
        code: "malformed_request",
        exitCode: 64,
        field: "session"
      });
    }
    expect(calls).toBe(0);
  });

  it("rejects cross-target, extra, inconsistent, oversized, and invalid success payloads", async () => {
    const candidates = [
      {
        ...usageSnapshot(),
        target: { ...usageSnapshot().target, session_id: otherSessionId }
      },
      { ...usageSnapshot(), monetary_cost: 1 },
      {
        ...usageSnapshot(),
        account: {
          ...usageSnapshot().account,
          summary: {
            ...usageSnapshot().account.summary,
            lifetime_tokens: Number.MAX_SAFE_INTEGER + 1
          }
        }
      },
      {
        ...usageSnapshot(),
        account: {
          ...usageSnapshot().account,
          daily_buckets: Array.from({ length: 2_001 }, (_, index) => ({
            start_date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
            tokens: 1
          }))
        }
      },
      {
        ...usageSnapshot(),
        thread: {
          ...observedThread(),
          observed_at: "2026-07-15T12:06:00.000Z"
        }
      },
      null,
      []
    ];
    let calls = 0;
    const client = createHostDeckUsageClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, candidates.shift());
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.read(sessionId)).rejects.toMatchObject({
        code: "internal_error",
        exitCode: 1,
        message: "HostDeck daemon returned invalid managed-session usage data."
      });
    }
    expect(calls).toBe(count);
  });

  it("sanitizes every public typed failure and never retries", async () => {
    const cases = [
      [404, "session_not_found", "Managed session was not found."],
      [409, "stale_session", "usage state is stale"],
      [409, "session_not_writable", "not readable"],
      [409, "capability_unavailable", "selected runtime"],
      [503, "runtime_unavailable", "Codex usage is unavailable"],
      [503, "service_overloaded", "capacity is exhausted"],
      [502, "protocol_error", "protocol validation"],
      [500, "storage_error", "state is unavailable"],
      [401, "permission_denied", "not permitted"]
    ] as const;
    let calls = 0;
    const client = createHostDeckUsageClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message:
              "private cwd, thread id, account identity, cookie, token, and terminal output",
            retryable: current[0] === 503,
            session_id: sessionId,
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
    expect(calls).toBe(cases.length);
  });

  it("maps fetch, malformed HTTP, JSON, and untyped failures without retry or leakage", async () => {
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
        return { status: 200, ok: false } as never;
      },
      async () => {
        calls += 1;
        return {
          status: 200,
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
      const client = createHostDeckUsageClient({ baseUrl, fetch });
      try {
        await client.read(sessionId);
        throw new Error("Expected usage-client failure.");
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

function usageSnapshot() {
  return usageSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.144.0",
    connection_generation: 3,
    measured_at: "2026-07-15T12:05:00.000Z",
    account: {
      scope: "account",
      summary: {
        lifetime_tokens: 100,
        peak_daily_tokens: 60,
        longest_running_turn_seconds: 30,
        current_streak_days: 2,
        longest_streak_days: 4
      },
      daily_buckets: [
        { start_date: "2026-07-14", tokens: 40 },
        { start_date: "2026-07-15", tokens: 60 }
      ]
    },
    thread: { state: "not_observed", scope: "thread" },
    rate_limits: { state: "not_observed", scope: "runtime" }
  });
}

function observedThread() {
  return {
    state: "observed" as const,
    scope: "thread" as const,
    observed_at: "2026-07-15T12:04:00.000Z",
    turn_id: "turn-usage-client-001",
    total: tokenBreakdown(20),
    last: tokenBreakdown(10),
    model_context_window: 128_000
  };
}

function tokenBreakdown(total: number) {
  return {
    total_tokens: total,
    input_tokens: Math.floor(total / 2),
    cached_input_tokens: Math.floor(total / 4),
    output_tokens: Math.floor(total / 2),
    reasoning_output_tokens: Math.floor(total / 4)
  };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
