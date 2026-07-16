import {
  type CompactProgressResponse,
  compactProgressResponseSchema,
  selectedOperationProgressSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import type {
  HostDeckCompactClient,
  HostDeckCompactClientStartRequest
} from "./compact-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { renderCompactProgress, renderHelp } from "./render.js";
import { type CliRunOptions, runCli } from "./shell.js";

const operationId = "op_compact_cli_001";
const sessionId = "sess_compact_cli_001";
const threadId = "thread-compact-cli-001";
const turnId = "turn-compact-cli-001";

describe("managed-session compact CLI command", () => {
  it("parses exact read and explicitly confirmed start forms", () => {
    expect(parseCliArgs(["compact", sessionId])).toEqual({
      command: { kind: "compact", session: sessionId, confirm: false, json: false },
      configFlags: {}
    });
    expect(parseCliArgs(["compact", sessionId, "--json"])).toEqual({
      command: { kind: "compact", session: sessionId, confirm: false, json: true },
      configFlags: {}
    });
    expect(parseCliArgs(["compact", sessionId, "--confirm"])).toEqual({
      command: { kind: "compact", session: sessionId, confirm: true, json: false },
      configFlags: {}
    });
    expect(parseCliArgs(["compact", sessionId, "--confirm", "--json"])).toEqual({
      command: { kind: "compact", session: sessionId, confirm: true, json: true },
      configFlags: {}
    });
    for (const args of [
      ["compact"],
      ["compact", "--confirm", sessionId],
      ["compact", sessionId, "other"],
      ["compact", sessionId, "--confirm", "--confirm"],
      ["compact", sessionId, "--confirm=true"],
      ["compact", sessionId, "--operation-id", operationId],
      ["compact", sessionId, "--thread-id", threadId],
      ["compact", sessionId, "--force"],
      ["compact", sessionId, "--retry"],
      ["compact", sessionId, "--", "--confirm"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({ code: "malformed_request", exitCode: cliExitCodes.usage })
      );
    }
  });

  it("reads once through the selected client receiverlessly without unrelated ports", async () => {
    let readThis: unknown = "not-called";
    const reads: string[] = [];
    let unrelatedAccesses = 0;
    const compactClient: HostDeckCompactClient = {
      read: async function readCompact(this: void, session) {
        readThis = this;
        reads.push(session);
        return response(null);
      },
      async start() {
        throw new Error("compact start must not run during read");
      }
    };
    const options = Object.defineProperties(
      { env: {}, compactClient },
      {
        client: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        localAdmin: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        usageClient: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        }),
        planClient: unrelatedAccessor(() => {
          unrelatedAccesses += 1;
        })
      }
    ) as CliRunOptions;

    const result = await runCli(["compact", sessionId], options);
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: `Compact: no tracked operation for ${sessionId}.\n`,
      stderr: ""
    });
    expect(reads).toEqual([sessionId]);
    expect(readThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("starts once with an internal operation id and accepted-only text", async () => {
    let startThis: unknown = "not-called";
    const starts: HostDeckCompactClientStartRequest[] = [];
    let reads = 0;
    const compactClient: HostDeckCompactClient = {
      async read() {
        reads += 1;
        return response(null);
      },
      start: async function startCompact(this: void, request) {
        startThis = this;
        starts.push(request);
        return response(progress("accepted", request.operation_id));
      }
    };
    const result = await runCli(["compact", sessionId, "--confirm"], {
      env: {},
      compactClient,
      createCompactOperationId: () => operationId
    });
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: `Compact accepted for ${sessionId}. Completion is not yet proven.\n`,
      stderr: ""
    });
    expect(starts).toEqual([
      { session_id: sessionId, operation_id: operationId, kind: "compact", confirm: true }
    ]);
    expect(startThis).toBeUndefined();
    expect(reads).toBe(0);
    expect(result.stdout).not.toMatch(/completed|compacted|saving|token/iu);
  });

  it("performs exact loopback GET and POST and renders contract-exact JSON", async () => {
    const requests: unknown[] = [];
    const responses = [response(null), response(progress("accepted", operationId))];
    const fetch: HttpFetch = async (url, init) => {
      requests.push({ url, init });
      const candidate = responses.shift();
      return jsonResponse(candidate?.progress === null ? 200 : 202, candidate);
    };
    const read = await runCli(["compact", sessionId, "--json"], { env: {}, fetch });
    expect(read).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(read.stdout)).toEqual({ progress: null });

    const start = await runCli(["compact", sessionId, "--confirm", "--json"], {
      env: {},
      fetch,
      createCompactOperationId: () => operationId
    });
    expect(start).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(start.stdout)).toEqual(response(progress("accepted", operationId)));
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

  it("renders all progress states without exposing error messages or false completion", async () => {
    const cases = [
      ["accepted", `Compact accepted for ${sessionId}. Completion is not yet proven.\n`],
      ["running", `Compact running for ${sessionId} (turn ${turnId}). Completion is not yet proven.\n`],
      ["completed", `Compact completed for ${sessionId} (turn ${turnId}).\n`],
      ["interrupted", `Compact interrupted for ${sessionId} (turn ${turnId}).\n`],
      ["failed", `Compact failed for ${sessionId} (error: unknown_error).\n`],
      ["incomplete", `Compact outcome incomplete for ${sessionId} (error: unknown_error).\n`]
    ] as const;
    for (const [state, expected] of cases) {
      const result = await runCli(["compact", sessionId], {
        env: {},
        compactClient: {
          async read() {
            return response(progress(state, operationId, "private-compact-error\u001b[31m"));
          },
          async start() {
            throw new Error("not used");
          }
        }
      });
      expect(result).toEqual({ exitCode: cliExitCodes.ok, stdout: expected, stderr: "" });
      expect(result.stdout).not.toContain("private-compact");
      expect(result.stdout).not.toContain("\u001b");
      if (state === "accepted" || state === "running") expect(result.stdout).toContain("not yet proven");
    }
  });

  it("rejects invalid generated ids and contradictory client responses before output", async () => {
    let starts = 0;
    for (const createCompactOperationId of [
      () => "invalid",
      () => {
        throw new Error("operation-id-private-sentinel");
      }
    ]) {
      const result = await runCli(["compact", sessionId, "--confirm"], {
        env: {},
        createCompactOperationId,
        compactClient: {
          async read() {
            return response(null);
          },
          async start(request) {
            starts += 1;
            return response(progress("accepted", request.operation_id));
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toContain("operation id generation failed");
      expect(result.stderr).not.toContain("private-sentinel");
    }
    expect(starts).toBe(0);

    const candidates: CompactProgressResponse[] = [
      response(null),
      response(progress("accepted", "op_compact_cli_other")),
      response(progress("running", operationId)),
      response(progress("completed", operationId)),
      response({
        ...progress("accepted", operationId),
        target: { ...target(), session_id: "sess_compact_other_001" } as never
      })
    ];
    for (const candidate of candidates) {
      const result = await runCli(["compact", sessionId, "--confirm"], {
        env: {},
        createCompactOperationId: () => operationId,
        compactClient: {
          async read() {
            return response(null);
          },
          async start() {
            return candidate;
          }
        }
      });
      expect(result).toMatchObject({ exitCode: cliExitCodes.internal, stdout: "" });
      expect(result.stderr).toMatch(/invalid managed-session|contradictory start/iu);
    }
  });

  it("preserves one bounded client failure and rejects non-loopback APIs before fetch", async () => {
    let clientCalls = 0;
    const failed = await runCli(["compact", sessionId], {
      env: {},
      compactClient: {
        async read() {
          clientCalls += 1;
          throw clientOperationFailure("runtime_unavailable", "The selected runtime is unavailable.", true);
        },
        async start() {
          throw new Error("not used");
        }
      }
    });
    expect(failed).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
    expect(failed.stderr).toContain("selected runtime is unavailable");
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      ["--api-url", "https://private-compact.example.test", "compact", sessionId],
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, response(null));
        }
      }
    );
    expect(remote).toMatchObject({ exitCode: cliExitCodes.config, stdout: "" });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-compact.example.test");
    expect(fetchCalls).toBe(0);
  });

  it("documents only the exact read and explicit confirmation forms", () => {
    const help = renderHelp();
    expect(help).toContain("codexdeck compact SESSION_ID [--json]");
    expect(help).toContain("codexdeck compact SESSION_ID --confirm [--json]");
    expect(help).not.toMatch(/compact.*--force|compact.*--retry|compact.*--thread|compact.*--operation/iu);
  });

  it("rejects malformed renderer input and cross-target progress", () => {
    expect(() => renderCompactProgress(response(null), "bad session", false)).toThrow();
    expect(() =>
      renderCompactProgress(
        response({
          ...progress("accepted"),
          target: { ...target(), session_id: "sess_compact_other_001" } as never
        }),
        sessionId,
        false
      )
    ).toThrow();
    expect(() => renderCompactProgress({ progress: null, extra: true } as never, sessionId, false)).toThrow();
  });
});

function unrelatedAccessor(onAccess: () => void): PropertyDescriptor {
  return {
    enumerable: true,
    get() {
      onAccess();
      throw new Error("unrelated compact CLI port was accessed");
    }
  };
}

function target() {
  return { type: "managed_session" as const, session_id: sessionId, codex_thread_id: threadId };
}

function progress(
  state: "accepted" | "running" | "completed" | "interrupted" | "failed" | "incomplete",
  operationIdCandidate = operationId,
  message = "Compact outcome is unresolved."
) {
  return selectedOperationProgressSchema.parse({
    operation_id: operationIdCandidate,
    kind: "compact",
    target: target(),
    state,
    updated_at: "2026-07-16T14:00:00.000Z",
    turn_id: state === "accepted" || state === "incomplete" ? null : turnId,
    error: ["failed", "incomplete"].includes(state)
      ? { code: "unknown_error", message, retryable: false }
      : null
  });
}

function response(progressCandidate: ReturnType<typeof progress> | null): CompactProgressResponse {
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
