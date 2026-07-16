import {
  archiveSessionRequestSchema,
  selectedOperationDispatchSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import {
  createHostDeckArchiveClient,
  type HostDeckArchiveClientRequest
} from "./archive-client.js";
import { CliFailure, clientOperationFailure } from "./errors.js";

const baseUrl = new URL("http://127.0.0.1:3777");
const request: HostDeckArchiveClientRequest = Object.freeze({
  ...archiveSessionRequestSchema.parse({
    operation_id: "op_session_archive_client_001",
    kind: "archive",
    confirm: true
  }),
  session_id: sessionIdSchema.parse("sess_archive_client_001")
});

describe("managed-session archive CLI client", () => {
  it("snapshots exact accessor-free loopback configuration", async () => {
    const requests: string[] = [];
    const mutableUrl = new URL(baseUrl);
    let fetch: HttpFetch = async (url) => {
      requests.push(url);
      return jsonResponse(202, response());
    };
    const mutableOptions = { baseUrl: mutableUrl, fetch };
    const client = createHostDeckArchiveClient(mutableOptions);
    mutableUrl.hostname = "203.0.113.10";
    fetch = async () => {
      throw new Error("mutated-fetch-private-sentinel");
    };
    mutableOptions.fetch = fetch;

    const result = await client.archive(request);
    expect(requests).toEqual([
      "http://127.0.0.1:3777/api/v1/sessions/sess_archive_client_001/archive"
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
      expect(() => createHostDeckArchiveClient(candidate as never)).toThrow(TypeError);
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
      "http://127.0.0.1:3777?session=private",
      "http://127.0.0.1:3777#private"
    ]) {
      expect(() =>
        createHostDeckArchiveClient({ baseUrl: new URL(url), fetch })
      ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
    }
    expect(calls).toBe(0);
  });

  it("issues one exact no-store POST without caller-supplied thread identity", async () => {
    const requests: unknown[] = [];
    const client = createHostDeckArchiveClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(202, response());
      }
    });

    await expect(client.archive(request)).resolves.toEqual(response());
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3777/api/v1/sessions/sess_archive_client_001/archive",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            operation_id: request.operation_id,
            kind: "archive",
            confirm: true
          })
        }
      }
    ]);
  });

  it("rejects malformed input before fetch and requires exact 202 success", async () => {
    let calls = 0;
    const client = createHostDeckArchiveClient({
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
      { ...request, confirm: false },
      { ...request, codex_thread_id: "thread-injected" }
    ]) {
      await expect(client.archive(candidate as never)).rejects.toMatchObject({
        code: "malformed_request",
        exitCode: 64,
        field: "archive"
      });
    }
    expect(calls).toBe(0);
    await expect(client.archive(request)).rejects.toMatchObject({
      code: "internal_error",
      message: "HostDeck daemon returned invalid managed-session archive data."
    });
    expect(calls).toBe(1);
  });

  it("rejects cross-operation, cross-session, wrong-kind, extra-field, and hostile receipts", async () => {
    const hostile = Object.defineProperty({}, "operation_id", {
      enumerable: true,
      get() {
        throw new Error("hostile-output-private-sentinel");
      }
    });
    const candidates: unknown[] = [
      response({ operation_id: "op_session_archive_client_other" }),
      response({
        target: {
          type: "managed_session",
          session_id: "sess_archive_client_other",
          codex_thread_id: "thread-archive-client-001"
        }
      }),
      { ...response(), kind: "interrupt" },
      { ...response(), extra: true },
      hostile,
      null,
      []
    ];
    let calls = 0;
    const client = createHostDeckArchiveClient({
      baseUrl,
      fetch: async () => {
        calls += 1;
        return jsonResponse(202, candidates.shift());
      }
    });
    const count = candidates.length;
    for (let index = 0; index < count; index += 1) {
      await expect(client.archive(request)).rejects.toMatchObject({
        code: "internal_error",
        exitCode: 1,
        message: "HostDeck daemon returned invalid managed-session archive data."
      });
    }
    expect(calls).toBe(count);
  });

  it("sanitizes typed API failures and never retries", async () => {
    const cases = [
      [404, "session_not_found", "does not exist"],
      [409, "session_not_writable", "not current and idle"],
      [409, "stale_session", "requires reconciliation"],
      [423, "host_locked", "host is locked"],
      [409, "incompatible_runtime", "cannot archive"],
      [503, "runtime_unavailable", "runtime is unavailable"],
      [409, "operation_conflict", "requires reconciliation"],
      [503, "audit_unavailable", "audit is unavailable"],
      [500, "storage_error", "storage is unavailable"],
      [504, "operation_timeout", "timed out"],
      [503, "service_overloaded", "capacity is exhausted"],
      [403, "read_only", "Write permission"],
      [401, "permission_denied", "not permitted"]
    ] as const;
    let calls = 0;
    const client = createHostDeckArchiveClient({
      baseUrl,
      fetch: async () => {
        const current = cases[calls++];
        if (current === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message: "private cwd, thread id, cookie, and raw error",
            retryable: false,
            details: { private_key: "private" }
          }
        });
      }
    });
    for (const [status, code, message] of cases) {
      await expect(client.archive(request)).rejects.toMatchObject({
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
        return { status: 202, ok: false } as never;
      },
      async () => {
        calls += 1;
        return {
          status: 202,
          ok: true,
          json: async () => {
            throw new Error("json-private-sentinel");
          },
          text: async () => "private"
        };
      },
      async () => {
        calls += 1;
        return jsonResponse(500, { error: { message: "untyped-private-sentinel" } });
      },
      async () => {
        calls += 1;
        throw preserved;
      }
    ];
    for (const fetch of failures) {
      try {
        await createHostDeckArchiveClient({ baseUrl, fetch }).archive(request);
        throw new Error("Expected archive-client failure.");
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

function response(overrides: Readonly<Record<string, unknown>> = {}) {
  return selectedOperationDispatchSchema.parse({
    operation_id: request.operation_id,
    kind: "archive",
    target: {
      type: "managed_session",
      session_id: request.session_id,
      codex_thread_id: "thread-archive-client-001"
    },
    state: "accepted",
    accepted_at: "2026-07-15T20:00:00.000Z",
    audit_record_id: "audit_session_archive_client_001",
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
