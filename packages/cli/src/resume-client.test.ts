import {
  defaultResourceBudget,
  selectedResumeMetadataResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";
import { createHostDeckResumeClient } from "./resume-client.js";

const sessionId = "sess_resume_client_001";
const threadId = "thread-resume-client-001";
const socketPath = "/run/user/1000/hostdeck/app-server.sock";
const baseUrl = new URL("http://127.0.0.1:3777");

describe("managed-thread resume CLI client", () => {
  it("snapshots one exact accessor-free loopback client configuration", async () => {
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = function fetchResume(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, availableResponse()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckResumeClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-fetch-private-sentinel");
    };
    mutableOptions.fetch = fetch;

    const response = await client.read(sessionId);
    expect(requests).toEqual([
      `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/resume`
    ]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.launch)).toBe(true);
    expect(Object.isFrozen(response.launch?.args)).toBe(true);

    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      baseUrl: new URL(baseUrl),
      fetch: async () => jsonResponse(200, availableResponse())
    });
    await expect(
      createHostDeckResumeClient(nullInput as never).read(sessionId)
    ).resolves.toMatchObject({ available: true });

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
        createHostDeckResumeClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("accepts only direct loopback HTTP base URLs before any fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, availableResponse());
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
        createHostDeckResumeClient({ baseUrl: new URL(url), fetch })
      ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
    }
    expect(calls).toBe(0);
  });

  it("issues one exact no-store GET and accepts available or unavailable metadata", async () => {
    const requests: Array<{
      readonly init: unknown;
      readonly url: string;
    }> = [];
    const responses = [availableResponse(), unavailableResponse()];
    const client = createHostDeckResumeClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ init, url });
        return jsonResponse(200, responses.shift());
      }
    });

    await expect(client.read(sessionId)).resolves.toEqual(availableResponse());
    await expect(client.read(sessionId)).resolves.toEqual(unavailableResponse());
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/resume`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          }
        }
      },
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/resume`,
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

  it("rejects malformed targets before fetch and never accepts a thread id as a session", async () => {
    let calls = 0;
    const client = createHostDeckResumeClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, availableResponse());
      }
    });
    for (const candidate of [
      "",
      "resume-client",
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

  it("rejects cross-target, oversized, extra, incomplete, and invalid success payloads", async () => {
    const longCommand = "x".repeat(
      defaultResourceBudget.cli_response_max_bytes + 1
    );
    const candidates = [
      { ...availableResponse(), session_id: "sess_resume_client_other" },
      { ...availableResponse(), command: `${availableResponse().command} --shell` },
      { ...availableResponse(), command: longCommand },
      { ...availableResponse(), launch: null },
      { ...availableResponse(), local_only: false },
      { ...availableResponse(), codex_thread_id: threadId },
      { ...unavailableResponse(), unavailable_reason: null },
      null,
      []
    ];
    let calls = 0;
    const client = createHostDeckResumeClient({
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
        message:
          "HostDeck daemon returned invalid managed-thread resume metadata."
      });
    }
    expect(calls).toBe(count);
  });

  it("sanitizes typed API failures and never retries", async () => {
    const cases = [
      [404, "session_not_found", "Managed session was not found."],
      [409, "stale_session", "Managed session is not eligible"],
      [503, "runtime_unavailable", "selected runtime"],
      [500, "storage_error", "Managed session state"]
    ] as const;
    let calls = 0;
    const client = createHostDeckResumeClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message:
              "private cwd, thread id, runtime binding, cookie, and shell output",
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

  it("maps fetch, malformed HTTP, JSON, and untyped error failures without retrying or leaking", async () => {
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
      const client = createHostDeckResumeClient({ baseUrl, fetch });
      try {
        await client.read(sessionId);
        throw new Error("Expected resume-client failure.");
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

function availableResponse() {
  return selectedResumeMetadataResponseSchema.parse({
    session_id: sessionId,
    local_only: true,
    available: true,
    command: `codex resume --remote unix://${socketPath} ${threadId}`,
    launch: {
      executable: "codex",
      args: ["resume", "--remote", `unix://${socketPath}`, threadId]
    },
    unavailable_reason: null
  });
}

function unavailableResponse() {
  return selectedResumeMetadataResponseSchema.parse({
    session_id: sessionId,
    local_only: true,
    available: false,
    command: null,
    launch: null,
    unavailable_reason: "The selected Codex runtime is not available."
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
