import { type RuntimeCompatibility, resolveResourceBudget } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  createCodexReconciliationReadClient,
  createCodexReconciliationResubscribeClient
} from "./reconciliation-client.js";
import type {
  CodexReconnectReadPort,
  CodexReconnectReadRequestInput,
  CodexReconnectResubscribePort,
  CodexReconnectResubscribeRequestInput
} from "./reconnect-controller.js";

const checkedAt = "2026-07-16T14:00:00.000Z";
const threadA = "thread-reconcile-a";
const threadB = "thread-reconcile-b";
const threadArchived = "thread-reconcile-archived";

describe("Codex reconnect-only reconciliation clients", () => {
  it("lists active and archived pages, exact-reads one thread and goal, and exposes no mutation methods", async () => {
    const signal = new AbortController().signal;
    const port = fakeReadPort((request) => {
      expect(request.signal).toBe(signal);
      if (request.method === "thread/list") {
        const params = request.params as { readonly archived: boolean; readonly cursor: string | null };
        expect(params).toMatchObject({
          limit: 1,
          sortDirection: "desc",
          sortKey: "created_at",
          useStateDbOnly: false
        });
        if (!params.archived && params.cursor === null) {
          return page([rawThread({ id: threadA })], "active-page-2", "active-back-1");
        }
        if (!params.archived) return page([rawThread({ id: threadB, cwd: "/tmp/project-b" })], null, "active-back-2");
        return page([rawThread({ id: threadArchived, cwd: "/tmp/project-archived" })], null, "archive-back");
      }
      if (request.method === "thread/read") return { thread: rawThread({ id: threadA }) };
      if (request.method === "thread/goal/get") return { goal: rawGoal(threadA) };
      throw new Error(`Unexpected method ${request.method}`);
    });
    const client = createCodexReconciliationReadClient(port, budget({
      protocol_thread_page_size: 1,
      protocol_thread_max_pages: 2
    }));

    await expect(client.listAllThreads(signal)).resolves.toMatchObject([
      { id: threadA, cwd: "/tmp/project-a", archived: false, source: "app_server" },
      { id: threadB, cwd: "/tmp/project-b", archived: false, source: "app_server" },
      { id: threadArchived, cwd: "/tmp/project-archived", archived: true, source: "app_server" }
    ]);
    await expect(client.readThread(threadA, signal)).resolves.toMatchObject({ id: threadA, archived: null });
    await expect(client.readGoal(threadA, signal)).resolves.toMatchObject({
      thread_id: threadA,
      objective: "Keep the runtime honest.",
      status: "paused"
    });

    expect(client.runtime_version).toBe("0.144.0");
    expect(client.generation).toBe(7);
    expect(Object.keys(client).sort()).toEqual([
      "generation",
      "listAllThreads",
      "readGoal",
      "readLatestTurn",
      "readThread",
      "runtime_version"
    ]);
    expect(client).not.toHaveProperty("archive");
    expect(client).not.toHaveProperty("ensureMaterialized");
    expect(client).not.toHaveProperty("start");
  });

  it("normalizes every reviewed latest-turn state without returning failure text or item content", async () => {
    const cases = [
      {
        raw: rawTurn({ status: "inProgress", completedAt: null, durationMs: null, error: null }),
        expected: { status: "in_progress", completed_at: null, duration_ms: null, failure_code: null }
      },
      {
        raw: rawTurn({ status: "completed", error: null }),
        expected: { status: "completed", failure_code: null }
      },
      {
        raw: rawTurn({ status: "interrupted", durationMs: null, error: null }),
        expected: { status: "interrupted", duration_ms: null, failure_code: null }
      },
      {
        raw: rawTurn({
          status: "failed",
          error: {
            message: "private provider detail",
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
            additionalDetails: "private request context"
          }
        }),
        expected: { status: "failed", failure_code: "response_stream_disconnected" }
      },
      {
        raw: rawTurn({
          status: "failed",
          error: { message: "unknown failure", codexErrorInfo: null, additionalDetails: null }
        }),
        expected: { status: "failed", failure_code: "unclassified" }
      }
    ] as const;

    for (const testCase of cases) {
      const port = fakeReadPort((request) => {
        expect(request).toMatchObject({
          method: "thread/turns/list",
          kind: "read",
          params: {
            threadId: threadA,
            cursor: null,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded"
          }
        });
        return { data: [testCase.raw], nextCursor: "older", backwardsCursor: "newer" };
      });
      const result = await createCodexReconciliationReadClient(port, budget()).readLatestTurn(threadA);
      expect(result).toMatchObject({
        turn_id: "turn-reconcile-a",
        started_at: "2026-07-16T14:00:00.000Z",
        ...testCase.expected
      });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(Object.isFrozen(result)).toBe(true);
    }

    const empty = createCodexReconciliationReadClient(
      fakeReadPort(() => ({ data: [], nextCursor: null, backwardsCursor: null })),
      budget()
    );
    await expect(empty.readLatestTurn(threadA)).resolves.toBeNull();
  });

  it("rejects contradictory, content-loaded, malformed, oversized, and extra-field latest turns", async () => {
    const invalid = [
      rawTurn({ status: "inProgress", completedAt: unixSeconds("2026-07-16T14:00:02.000Z") }),
      rawTurn({ status: "completed", completedAt: null }),
      rawTurn({ status: "completed", error: rawError() }),
      rawTurn({ status: "failed", error: null }),
      rawTurn({ itemsView: "summary" }),
      rawTurn({ items: [{}] }),
      rawTurn({ startedAt: null }),
      rawTurn({ completedAt: unixSeconds("2026-07-16T13:59:59.000Z") }),
      rawTurn({ durationMs: -1 }),
      rawTurn({ unexpected: true }),
      rawTurn({
        status: "failed",
        error: { message: "failed", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 700 } }, additionalDetails: null }
      })
    ];
    for (const turn of invalid) {
      await expectAdapterError(
        createCodexReconciliationReadClient(
          fakeReadPort(() => ({ data: [turn], nextCursor: null, backwardsCursor: "back" })),
          budget()
        ).readLatestTurn(threadA),
        "invalid_protocol_message"
      );
    }

    await expectAdapterError(
      createCodexReconciliationReadClient(
        fakeReadPort(() => ({ data: [rawTurn(), rawTurn({ id: "turn-reconcile-b" })], nextCursor: null, backwardsCursor: "back" })),
        budget()
      ).readLatestTurn(threadA),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexReconciliationReadClient(
        fakeReadPort(() => ({ data: [], nextCursor: null, backwardsCursor: "invalid-empty-backwards" })),
        budget()
      ).readLatestTurn(threadA),
      "invalid_protocol_message"
    );
  });

  it("fails list/read on generated-shape drift, duplicate identity, cursor loops, or configured page overflow", async () => {
    const missingField = rawThread();
    delete missingField.sessionId;
    await expectAdapterError(
      createCodexReconciliationReadClient(
        fakeReadPort((request) => request.method === "thread/list"
          ? page([missingField], null, "back")
          : { thread: missingField }),
        budget()
      ).listAllThreads(),
      "invalid_protocol_message"
    );

    await expectAdapterError(
      createCodexReconciliationReadClient(
        fakeReadPort(() => page([rawThread({ cliVersion: "0.143.0" })], null, "back")),
        budget()
      ).listAllThreads(),
      "invalid_protocol_message"
    );

    const overlap = createCodexReconciliationReadClient(
      fakeReadPort(() => page([rawThread({ id: threadA })], null, "back")),
      budget()
    );
    await expectAdapterError(overlap.listAllThreads(), "invalid_protocol_message");

    const repeatedCursor = createCodexReconciliationReadClient(
      fakeReadPort(() => page([rawThread()], "same", "back")),
      budget({ protocol_thread_page_size: 1, protocol_thread_max_pages: 3 })
    );
    await expectAdapterError(repeatedCursor.listAllThreads(), "invalid_protocol_message");

    let pageNumber = 0;
    const overflow = createCodexReconciliationReadClient(
      fakeReadPort(() => {
        pageNumber += 1;
        return page([rawThread({ id: `thread-overflow-${pageNumber}` })], `next-${pageNumber}`, "back");
      }),
      budget({ protocol_thread_page_size: 1, protocol_thread_max_pages: 1 })
    );
    await expectAdapterError(overflow.listAllThreads(), "broker_overloaded");

    const extraResult = createCodexReconciliationReadClient(
      fakeReadPort(() => ({ ...page([], null, null), extra: true })),
      budget()
    );
    await expectAdapterError(extraResult.listAllThreads(), "invalid_protocol_message");
  });

  it("resumes one exact thread with no overrides and rejects cwd, turn, and response-shape contradictions", async () => {
    const signal = new AbortController().signal;
    const port = fakeResubscribePort((request) => {
      expect(request).toMatchObject({
        method: "thread/resume",
        kind: "read",
        params: { threadId: threadA, excludeTurns: true },
        signal
      });
      expect(request.params).not.toHaveProperty("model");
      expect(request.params).not.toHaveProperty("cwd");
      return rawResumeResult();
    });
    const client = createCodexReconciliationResubscribeClient(port, budget());
    await expect(client.resumeThread(threadA, signal)).resolves.toEqual({
      thread_id: threadA,
      cwd: "/tmp/project-a",
      runtime_model: "runtime-a",
      reasoning_effort: "high"
    });
    expect(Object.keys(client).sort()).toEqual(["generation", "resumeThread", "runtime_version"]);
    expect(client).not.toHaveProperty("listCatalog");
    expect(client).not.toHaveProperty("startTurn");

    for (const result of [
      rawResumeResult({ cwd: "/tmp/different" }),
      rawResumeResult({ thread: { id: threadA, cwd: "/tmp/project-a", turns: [rawTurn()] } }),
      rawResumeResult({ unexpected: true })
    ]) {
      await expectAdapterError(
        createCodexReconciliationResubscribeClient(fakeResubscribePort(() => result), budget()).resumeThread(threadA),
        "invalid_protocol_message"
      );
    }
  });

  it("rejects invalid generation and incompatible runtime construction before a request", async () => {
    expect(() => createCodexReconciliationReadClient({
      ...fakeReadPort(() => null),
      generation: 0
    }, budget())).toThrow(TypeError);

    const disconnected = fakeReadPort(() => null, disconnectedCompatibility());
    const client = createCodexReconciliationReadClient(disconnected, budget());
    expect(() => client.runtime_version).toThrow(HostDeckCodexAdapterError);
    await expectAdapterError(client.listAllThreads(), "handshake_failed");
    expect(disconnected.requests).toHaveLength(0);
  });
});

interface FakeReadPort extends CodexReconnectReadPort {
  readonly requests: CodexReconnectReadRequestInput[];
}

interface FakeResubscribePort extends CodexReconnectResubscribePort {
  readonly requests: CodexReconnectResubscribeRequestInput[];
}

function fakeReadPort(
  handler: (request: CodexReconnectReadRequestInput) => unknown | Promise<unknown>,
  compatibility = readyCompatibility()
): FakeReadPort {
  const requests: CodexReconnectReadRequestInput[] = [];
  return {
    compatibility,
    generation: 7,
    requests,
    async request(input) {
      requests.push(input);
      return handler(input);
    }
  };
}

function fakeResubscribePort(
  handler: (request: CodexReconnectResubscribeRequestInput) => unknown | Promise<unknown>
): FakeResubscribePort {
  const requests: CodexReconnectResubscribeRequestInput[] = [];
  return {
    compatibility: readyCompatibility(),
    generation: 7,
    requests,
    async request(input) {
      requests.push(input);
      return handler(input);
    }
  };
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: checkedAt,
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function disconnectedCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: checkedAt,
    handshake: { state: "not_attempted" }
  });
}

function budget(overrides: Parameters<typeof resolveResourceBudget>[0] = {}) {
  return resolveResourceBudget(overrides);
}

function page(data: unknown[], nextCursor: string | null, backwardsCursor: string | null) {
  return { data, nextCursor, backwardsCursor };
}

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: threadA,
    extra: null,
    sessionId: "runtime-session-a",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: unixSeconds("2026-07-16T13:00:00.000Z"),
    updatedAt: unixSeconds("2026-07-16T14:00:00.000Z"),
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp/project-a",
    cliVersion: "0.144.0",
    source: "appServer",
    threadSource: "hostdeck:managed",
    agentNickname: null,
    agentRole: null,
    gitInfo: { sha: "a".repeat(40), branch: "main", originUrl: "ssh://example.invalid/private" },
    name: "Reconciliation A",
    turns: [],
    ...overrides
  };
}

function rawGoal(threadId: string): Record<string, unknown> {
  return {
    threadId,
    objective: "Keep the runtime honest.",
    status: "paused",
    tokenBudget: null,
    tokensUsed: 12,
    timeUsedSeconds: 3.5,
    createdAt: unixSeconds("2026-07-16T13:00:00.000Z"),
    updatedAt: unixSeconds("2026-07-16T14:00:00.000Z")
  };
}

function rawTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "turn-reconcile-a",
    items: [],
    itemsView: "notLoaded",
    status: "completed",
    error: null,
    startedAt: unixSeconds("2026-07-16T14:00:00.000Z"),
    completedAt: unixSeconds("2026-07-16T14:00:02.000Z"),
    durationMs: 2_000,
    ...overrides
  };
}

function rawError(): Record<string, unknown> {
  return { message: "failed", codexErrorInfo: "other", additionalDetails: null };
}

function rawResumeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    thread: { id: threadA, cwd: "/tmp/project-a", turns: [] },
    model: "runtime-a",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp/project-a",
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: null,
    ...overrides
  };
}

function unixSeconds(value: string): number {
  return Date.parse(value) / 1_000;
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: HostDeckCodexAdapterError["code"]
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
