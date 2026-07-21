import {
  encodeSelectedSessionListCursor,
  type SelectedSessionListResponse,
  selectedSessionListCursorValueSchema,
  selectedSessionListResponseSchema,
  selectedSessionListSortKey,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { createHostDeckSessionListClient } from "./session-list-client.js";

const origin = "http://127.0.0.1:3777";
const timestamp = "2026-07-20T20:00:00.000Z";
const laterTimestamp = "2026-07-20T20:01:00.000Z";
const snapshot = "a".repeat(64);

describe("selected session-list CLI client", () => {
  it("sends exact canonical GET queries without local-admin authority", async () => {
    const cursor = inputCursor();
    const page = sessionResponse({
      sessions: [sessionItem("sess_list_client_002", "watch")],
      nextSnapshot: snapshot
    });
    const requests: Array<{ readonly init: unknown; readonly url: string }> = [];
    const responses = [sessionResponse(), page];
    const mutableUrl = new URL(origin);
    const client = createHostDeckSessionListClient({
      baseUrl: mutableUrl,
      fetch: async (url, init) => {
        requests.push({ init, url });
        return jsonResponse(200, responses.shift());
      }
    });
    mutableUrl.hostname = "203.0.113.21";

    const first = await client.list({ limit: null, cursor: null });
    const second = await client.list({ limit: 1, cursor });
    expect(first.sessions).toHaveLength(1);
    expect(second.has_more).toBe(true);
    expect(requests).toEqual([
      {
        url: `${origin}/api/v1/sessions`,
        init: readInit()
      },
      {
        url: `${origin}/api/v1/sessions?limit=1&cursor=${cursor}`,
        init: readInit()
      }
    ]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.sessions)).toBe(true);
    expect(Object.isFrozen(second.sessions[0]?.session)).toBe(true);
  });

  it("rejects malformed options and exact-input violations before fetch", async () => {
    let accessorCalls = 0;
    const optionAccessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return new URL(origin);
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: origin },
      { baseUrl: new URL(origin), fetch: null },
      { baseUrl: new URL(origin), extra: true },
      optionAccessor
    ]) {
      expect(() =>
        createHostDeckSessionListClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);

    let calls = 0;
    const client = createHostDeckSessionListClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, sessionResponse());
      }
    });
    const inputAccessor = Object.defineProperty(
      { cursor: null },
      "limit",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return 1;
        }
      }
    );
    for (const candidate of [
      null,
      {},
      { limit: null },
      { limit: 0, cursor: null },
      { limit: 101, cursor: null },
      { limit: 1.5, cursor: null },
      { limit: null, cursor: "invalid" },
      { limit: null, cursor: null, private: true },
      inputAccessor
    ]) {
      await expect(client.list(candidate as never)).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck session-list input is invalid."
      });
    }
    expect(accessorCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects uncorrelated authority, bounds, continuation order, and snapshot state", async () => {
    const cursor = inputCursor();
    const candidates = [
      sessionResponse({ access: "local_admin" }),
      sessionResponse({
        sessions: [
          sessionItem("sess_list_client_010", "watch"),
          sessionItem("sess_list_client_011", "none")
        ]
      }),
      sessionResponse({
        sessions: [sessionItem("sess_list_client_012", "needs_approval")]
      }),
      sessionResponse({
        sessions: [sessionItem("sess_list_client_013", "watch")],
        nextSnapshot: "b".repeat(64)
      })
    ];
    let calls = 0;
    const client = createHostDeckSessionListClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        const candidate = candidates[calls];
        calls += 1;
        return jsonResponse(200, candidate);
      }
    });

    await expect(client.list({ limit: null, cursor: null })).rejects.toMatchObject({
      code: "internal_error"
    });
    await expect(client.list({ limit: 1, cursor: null })).rejects.toMatchObject({
      code: "internal_error"
    });
    await expect(client.list({ limit: 1, cursor })).rejects.toMatchObject({
      code: "internal_error"
    });
    await expect(client.list({ limit: 1, cursor })).rejects.toMatchObject({
      code: "internal_error"
    });
    expect(calls).toBe(candidates.length);
  });

  it("rejects malformed and wrong-status success, then sanitizes typed failures without retry", async () => {
    const cases: Array<readonly [number, unknown, string, string]> = [
      [
        200,
        { ...sessionResponse(), private_cwd: "/private" },
        "internal_error",
        "invalid or uncorrelated"
      ],
      [201, sessionResponse(), "internal_error", "invalid or uncorrelated"],
      [
        409,
        apiError("stale_session"),
        "stale_session",
        "request the first page again"
      ],
      [
        500,
        apiError("storage_error"),
        "storage_error",
        "storage is unavailable"
      ],
      [
        504,
        apiError("operation_timeout"),
        "operation_timeout",
        "timed out"
      ],
      [
        503,
        apiError("service_overloaded"),
        "service_overloaded",
        "selected capacity"
      ]
    ];
    let calls = 0;
    const client = createHostDeckSessionListClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected fetch");
        return jsonResponse(current[0], current[1]);
      }
    });

    for (const [, , code, message] of cases) {
      await expect(
        client.list({ limit: null, cursor: null })
      ).rejects.toMatchObject({
        code,
        message: expect.stringContaining(message)
      });
    }
    expect(calls).toBe(cases.length);
  });

  it("rejects alternate origins before transport", () => {
    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls += 1;
      return jsonResponse(200, sessionResponse());
    };
    for (const value of [
      "https://127.0.0.1:3777",
      "http://localhost:3777",
      "http://127.0.0.2:3777",
      "http://192.0.2.21:3777",
      "http://127.0.0.1:3777/base",
      "http://127.0.0.1:3777#private"
    ]) {
      expect(() =>
        createHostDeckSessionListClient({ baseUrl: new URL(value), fetch })
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_config",
          exitCode: cliExitCodes.config
        })
      );
    }
    expect(calls).toBe(0);
  });
});

function sessionResponse(
  options: {
    readonly access?: "local_admin" | "loopback_read";
    readonly nextSnapshot?: string;
    readonly sessions?: ReturnType<typeof sessionItem>[];
  } = {}
): SelectedSessionListResponse {
  const sessions = options.sessions ?? [sessionItem("sess_list_client_001", "none")];
  const final = sessions.at(-1);
  const nextCursor =
    options.nextSnapshot === undefined || final === undefined
      ? null
      : encodeSelectedSessionListCursor(
          selectedSessionListCursorValueSchema.parse({
            order_snapshot: options.nextSnapshot,
            after: selectedSessionListSortKey(final.session)
          })
        );
  return selectedSessionListResponseSchema.parse({
    access: {
      mode: options.access ?? "loopback_read",
      network_mode: "loopback",
      transport: "http"
    },
    sessions,
    next_cursor: nextCursor,
    has_more: nextCursor !== null
  });
}

function sessionItem(
  id: string,
  attention: "needs_approval" | "none" | "watch"
) {
  return selectedSessionReadItemSchema.parse({
    event_window: {
      state: "empty" as const,
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    },
    session: {
      archived_at: null,
      attention,
      branch: "main",
      codex_thread_id: `thread-${id}`,
      created_at: timestamp,
      cwd: `/private/workspaces/${id}`,
      freshness: "current" as const,
      freshness_reason: null,
      goal: {
        objective: "Private objective must not appear in human output.",
        state: "active" as const
      },
      id,
      last_activity_at: timestamp,
      last_event_cursor: null,
      model: "gpt-5.5-codex",
      name: id.slice(5),
      recent_summary: "Private summary must not appear in human output.",
      runtime_source: "codex_app_server" as const,
      runtime_version: "0.144.0",
      session_state: "active" as const,
      settings: {
        collaboration_mode: "default" as const,
        observed_at: timestamp,
        reasoning_effort: "high",
        runtime_model: "gpt-5.5-codex"
      },
      turn_state: "idle" as const,
      updated_at: laterTimestamp
    }
  });
}

function inputCursor(): string {
  return encodeSelectedSessionListCursor(
    selectedSessionListCursorValueSchema.parse({
      order_snapshot: snapshot,
      after: {
        attention_rank: 50,
        last_activity_at: timestamp,
        session_id: "sess_list_client_input"
      }
    })
  );
}

function readInit() {
  return {
    method: "GET" as const,
    headers: {
      accept: "application/json",
      "cache-control": "no-store"
    }
  };
}

function apiError(code: string) {
  return {
    error: {
      code,
      message:
        "private cwd, thread identity, prompt, account, cookie, and credential",
      retryable: false,
      details: { private: "private" }
    }
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
