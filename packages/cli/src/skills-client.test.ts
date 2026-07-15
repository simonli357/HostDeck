import {
  type SkillsSnapshot,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";
import { createHostDeckSkillsClient } from "./skills-client.js";

const sessionId = "sess_skills_client_001";
const otherSessionId = "sess_skills_client_002";
const threadId = "thread-skills-client-001";
const baseUrl = new URL("http://127.0.0.1:3777");

describe("managed-session skills CLI client", () => {
  it("snapshots one exact accessor-free loopback client configuration", async () => {
    let fetchThis: unknown = "not-called";
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = function fetchSkills(this: void, url) {
      fetchThis = this;
      requests.push(url);
      return Promise.resolve(jsonResponse(200, skillsSnapshot()));
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckSkillsClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-fetch-private-sentinel");
    };
    mutableOptions.fetch = fetch;

    const response = await client.list(sessionId);
    expect(requests).toEqual([
      `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/skills`
    ]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.target)).toBe(true);
    expect(Object.isFrozen(response.skills)).toBe(true);
    expect(Object.isFrozen(response.skills[0])).toBe(true);

    const nullInput = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        baseUrl: new URL(baseUrl),
        fetch: async () => jsonResponse(200, skillsSnapshot())
      }
    );
    await expect(
      createHostDeckSkillsClient(nullInput as never).list(sessionId)
    ).resolves.toEqual(skillsSnapshot());

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
        createHostDeckSkillsClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("accepts only direct loopback HTTP base URLs before any fetch", () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, skillsSnapshot());
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
        createHostDeckSkillsClient({ baseUrl: new URL(url), fetch })
      ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
    }
    expect(calls).toBe(0);
  });

  it("issues one exact no-store GET and accepts every valid public state", async () => {
    const requests: Array<{ readonly init: unknown; readonly url: string }> = [];
    const states = [
      skillsSnapshot(),
      skillsSnapshot({ state: "empty", skills: [], error_count: 0 }),
      skillsSnapshot({ state: "partial", error_count: 2 }),
      skillsSnapshot({ state: "error", skills: [], error_count: 2 })
    ];
    const client = createHostDeckSkillsClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ init, url });
        return jsonResponse(200, states.shift());
      }
    });

    for (const state of ["content", "empty", "partial", "error"] as const) {
      await expect(client.list(sessionId)).resolves.toMatchObject({ state });
    }
    expect(requests).toHaveLength(4);
    expect(requests).toEqual(
      Array.from({ length: 4 }, () => ({
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/skills`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          }
        }
      }))
    );
  });

  it("rejects malformed targets before fetch and never accepts cwd or thread identity", async () => {
    let calls = 0;
    const client = createHostDeckSkillsClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, skillsSnapshot());
      }
    });
    for (const candidate of [
      "",
      "skills-client",
      threadId,
      "/tmp/private-cwd",
      "sess with spaces",
      `${sessionId}/other`,
      `sess_${"x".repeat(200)}`
    ]) {
      await expect(client.list(candidate)).rejects.toMatchObject({
        code: "malformed_request",
        exitCode: 64,
        field: "session"
      });
    }
    expect(calls).toBe(0);
  });

  it("rejects cross-target, path-bearing, inconsistent, oversized, and hostile success payloads", async () => {
    const hostile = Object.defineProperty({}, "target", {
      enumerable: true,
      get() {
        throw new Error("hostile-output-private-sentinel");
      }
    });
    const candidates = [
      {
        ...skillsSnapshot(),
        target: { ...skillsSnapshot().target, session_id: otherSessionId }
      },
      { ...skillsSnapshot(), cwd: "/private/cwd" },
      {
        ...skillsSnapshot(),
        skills: [
          {
            ...skillsSnapshot().skills[0],
            path: "/private/skill-path"
          }
        ]
      },
      {
        ...skillsSnapshot(),
        skills: [skillsSnapshot().skills[0], skillsSnapshot().skills[0]]
      },
      {
        ...skillsSnapshot(),
        skills: [...skillsSnapshot().skills].reverse()
      },
      { ...skillsSnapshot(), state: "error" },
      {
        ...skillsSnapshot(),
        skills: Array.from({ length: 1_025 }, (_, index) => ({
          name: `skill-${String(index).padStart(4, "0")}`,
          description: null,
          scope: "repo",
          enabled: true
        }))
      },
      hostile,
      null,
      []
    ];
    let calls = 0;
    const client = createHostDeckSkillsClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, candidates.shift());
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.list(sessionId)).rejects.toMatchObject({
        code: "internal_error",
        exitCode: 1,
        message: "HostDeck daemon returned invalid managed-session skills data."
      });
    }
    expect(calls).toBe(count);
  });

  it("sanitizes every public typed failure and never retries", async () => {
    const cases = [
      [404, "session_not_found", "Managed session was not found."],
      [409, "stale_session", "skills state is stale"],
      [409, "session_not_writable", "not readable"],
      [409, "invalid_session_id", "identity changed"],
      [409, "capability_unavailable", "selected runtime"],
      [503, "runtime_unavailable", "Codex skills are unavailable"],
      [503, "service_overloaded", "capacity is exhausted"],
      [502, "protocol_error", "protocol validation"],
      [500, "storage_error", "state is unavailable"],
      [401, "permission_denied", "not permitted"]
    ] as const;
    let calls = 0;
    const client = createHostDeckSkillsClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message:
              "private cwd, skill path, dependency, prompt, cookie, and raw error",
            retryable: current[0] === 503,
            session_id: sessionId,
            details: { private_key: "private" }
          }
        });
      }
    });
    for (const [status, code, message] of cases) {
      await expect(client.list(sessionId)).rejects.toMatchObject({
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
      const client = createHostDeckSkillsClient({ baseUrl, fetch });
      try {
        await client.list(sessionId);
        throw new Error("Expected skills-client failure.");
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

function skillsSnapshot(
  overrides: Partial<SkillsSnapshot> = {}
) {
  return skillsSnapshotSchema.parse({
    ...createSkillsSnapshotInput(),
    ...overrides
  });
}

function createSkillsSnapshotInput() {
  return {
    target: {
      type: "managed_session" as const,
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.144.0",
    connection_generation: 3,
    observed_at: "2026-07-15T14:05:00.000Z",
    state: "content" as const,
    skills: [
      {
        name: "alpha",
        description: "Alpha skill.",
        scope: "repo" as const,
        enabled: true
      },
      {
        name: "beta",
        description: null,
        scope: "system" as const,
        enabled: false
      }
    ],
    error_count: 0
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
