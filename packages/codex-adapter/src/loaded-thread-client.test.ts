import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import type { CodexConnectionNotification } from "./connection.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexLoadedThreadRequestPort,
  createCodexLoadedThreadClient,
  HostDeckCodexLoadedThreadError
} from "./loaded-thread-client.js";

const threadA = "019f489a-1f9d-7402-ae00-eac6ea322f64";
const threadB = "019f489a-1f9d-7402-ae00-eac6ea322f65";
const parent = "019f489a-1f9d-7402-ae00-eac6ea322f66";

describe("shared Codex loaded-thread adapter", () => {
  it("pages every loaded UUID once and normalizes exact root eligibility without private fields", async () => {
    let pageNumber = 0;
    const port = fakePort((request) => {
      expect(request.method).toBe("thread/loaded/list");
      pageNumber += 1;
      return pageNumber === 1
        ? { data: [threadB], nextCursor: "next" }
        : { data: [threadA], nextCursor: null };
    });
    const client = createCodexLoadedThreadClient(port, { page_size: 1, max_pages: 2 });

    await expect(client.listLoadedThreadIds()).resolves.toEqual([threadA, threadB]);
    expect(port.requests.map((request) => request.params)).toEqual([
      { cursor: null, limit: 1 },
      { cursor: "next", limit: 1 }
    ]);

    const privateMetadata = rawThread({
      preview: "private transcript",
      path: "/private/rollout.jsonl",
      gitInfo: { sha: "a".repeat(40), branch: "secret", originUrl: "ssh://private" },
      threadSource: "private-source"
    });
    const candidate = client.candidateFromStartedNotification(started(privateMetadata));
    expect(candidate).toMatchObject({
      native_thread_id: threadA,
      root_thread_id: threadA,
      project_cue: "side_cue_app",
      source: "cli",
      eligibility: { state: "eligible", reason: null }
    });
    for (const secret of ["private transcript", "rollout.jsonl", "ssh://private", "private-source"]) {
      expect(JSON.stringify(candidate)).not.toContain(secret);
    }
    expect(Object.isFrozen(candidate)).toBe(true);
  });

  it("classifies roots by the active runtime while preserving historical-thread compatibility", () => {
    const client = createCodexLoadedThreadClient(fakePort(() => null));
    expect(client.candidateFromStartedNotification(started(rawThread({
      id: threadB,
      sessionId: threadA,
      parentThreadId: parent,
      source: { subAgent: "review" }
    })))).toMatchObject({
      root_thread_id: threadA,
      eligibility: { state: "ineligible", reason: "child_or_subagent" }
    });
    expect(client.candidateFromStartedNotification(started(rawThread({ source: "vscode" })))).toMatchObject({
      eligibility: { state: "eligible", reason: null }
    });
    expect(client.candidateFromStartedNotification(started(rawThread({ source: "exec" })))).toMatchObject({
      eligibility: { state: "ineligible", reason: "non_interactive_source" }
    });
    expect(client.candidateFromStartedNotification(started(rawThread({
      cliVersion: "0.144.0",
      source: "vscode"
    })))).toMatchObject({
      runtime_version: "0.148.0",
      source: "vscode",
      eligibility: { state: "eligible", reason: null }
    });
    expect(client.candidateFromStartedNotification(started(rawThread({ cwd: "relative/project" })))).toMatchObject({
      cwd: "relative/project",
      eligibility: { state: "ineligible", reason: "invalid_cwd" }
    });
    expect(client.candidateFromStartedNotification(started(rawThread({ cwd: "C:\\work\\MarketPilot\\" })))).toMatchObject({
      project_cue: "MarketPilot",
      eligibility: { state: "ineligible", reason: "invalid_cwd" }
    });
  });

  it("subscribes without a turn and returns a bounded chronological history plus active turn", async () => {
    const before = rawThread({ status: { type: "active", activeFlags: ["waitingOnUserInput"] } });
    const port = fakePort((request) => {
      if (request.method === "thread/resume") return resume(before);
      if (request.method === "thread/turns/list") {
        expect(request.params).toEqual({
          threadId: threadA,
          cursor: null,
          limit: 20,
          sortDirection: "desc",
          itemsView: "summary"
        });
        return {
          data: [
            turn({
              id: "turn-active",
              status: "inProgress",
              completedAt: null,
              durationMs: null,
              items: []
            }),
            turn({ id: "turn-new", items: [agentMessage("item-new", "new answer")] }),
            turn({
              id: "turn-old",
              startedAt: seconds("2026-08-14T14:10:00.000Z"),
              completedAt: seconds("2026-08-14T14:11:00.000Z"),
              items: [userMessage("item-old", "old request")]
            })
          ],
          nextCursor: "older",
          backwardsCursor: "newer"
        };
      }
      if (request.method === "thread/read") return { thread: before };
      throw new Error(`Unexpected method ${request.method}.`);
    });
    const client = createCodexLoadedThreadClient(port);
    const candidate = client.candidateFromStartedNotification(started(before));
    const snapshot = await client.subscribeAndReadSnapshot(candidate);

    expect(port.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/turns/list",
      "thread/read"
    ]);
    expect(port.requests[0]?.params).toEqual({ threadId: threadA, excludeTurns: true });
    expect(snapshot).toMatchObject({
      active_turn_id: "turn-active",
      truncated_before: true,
      runtime_model: "gpt-5.5-codex",
      reasoning_effort: "high",
      candidate: {
        status: "active",
        active_flags: ["waiting_on_user_input"]
      },
      turns: [
        { turn_id: "turn-old", messages: [{ role: "user", text: "old request" }] },
        { turn_id: "turn-new", messages: [{ role: "agent", text: "new answer" }] }
      ]
    });
    expect(Object.isFrozen(snapshot.turns)).toBe(true);
  });

  it("makes unmaterialized history and metadata races explicit and retry-safe", async () => {
    const candidate = createCodexLoadedThreadClient(fakePort(() => null))
      .candidateFromStartedNotification(started(rawThread()));
    const pending = createCodexLoadedThreadClient(fakePort(() => {
      throw new HostDeckCodexAdapterError(
        "remote_error",
        "Codex thread/resume rejected: no rollout found for thread",
        { outcome: "remote_rejected", retry_safe: true, rpc_code: -32_600 }
      );
    }));
    await expect(pending.subscribeAndReadSnapshot(candidate)).rejects.toMatchObject({
      code: "pending_materialization",
      retry_safe: true
    });

    const changed = rawThread({ cwd: "/tmp/different" });
    const racing = createCodexLoadedThreadClient(fakePort((request) => {
      if (request.method === "thread/resume") return resume(rawThread());
      if (request.method === "thread/turns/list") return { data: [], nextCursor: null, backwardsCursor: null };
      return { thread: changed };
    }));
    await expect(racing.subscribeAndReadSnapshot(candidate)).rejects.toMatchObject({
      code: "identity_changed",
      retry_safe: true
    });
  });

  it("rejects page, resume, history, and runtime drift before claiming enrollment", async () => {
    const duplicate = createCodexLoadedThreadClient(fakePort(() => ({ data: [threadA, threadA], nextCursor: null })));
    await expectAdapterError(duplicate.listLoadedThreadIds(), "invalid_protocol_message");

    const candidate = createCodexLoadedThreadClient(fakePort(() => null))
      .candidateFromStartedNotification(started(rawThread()));
    const additive = createCodexLoadedThreadClient(fakePort((request) => {
      if (request.method === "thread/resume") return { ...resume(rawThread()), additive: true };
      throw new Error("Unexpected request.");
    }));
    await expectAdapterError(additive.subscribeAndReadSnapshot(candidate), "invalid_protocol_message");

    const contradictoryCwd = createCodexLoadedThreadClient(fakePort((request) => {
      if (request.method === "thread/resume") return { ...resume(rawThread()), cwd: "/tmp/other-project" };
      throw new Error("Unexpected request.");
    }));
    await expectAdapterError(contradictoryCwd.subscribeAndReadSnapshot(candidate), "invalid_protocol_message");

    const contradictoryProvider = createCodexLoadedThreadClient(fakePort((request) => {
      if (request.method === "thread/resume") return { ...resume(rawThread()), modelProvider: "other-provider" };
      throw new Error("Unexpected request.");
    }));
    await expectAdapterError(contradictoryProvider.subscribeAndReadSnapshot(candidate), "invalid_protocol_message");

    const malformedHistory = createCodexLoadedThreadClient(fakePort((request) => {
      if (request.method === "thread/resume") return resume(rawThread());
      if (request.method === "thread/turns/list") {
        return { data: [turn({ status: "inProgress" }), turn({ status: "inProgress" })], nextCursor: null, backwardsCursor: "back" };
      }
      return { thread: rawThread({ status: { type: "active", activeFlags: [] } }) };
    }));
    await expectAdapterError(malformedHistory.subscribeAndReadSnapshot(candidate), "invalid_protocol_message");

    const disconnected = createCodexLoadedThreadClient(fakePort(() => null, disconnectedCompatibility()));
    expect(() => disconnected.runtime_version).toThrow(HostDeckCodexAdapterError);
    await expectAdapterError(disconnected.listLoadedThreadIds(), "handshake_failed");
  });

  it("exposes no create, turn, archive, rename, or fork operation", () => {
    const client = createCodexLoadedThreadClient(fakePort(() => null));
    expect(Object.keys(client).sort()).toEqual([
      "candidateFromStartedNotification",
      "listLoadedThreadIds",
      "readCandidate",
      "runtime_version",
      "subscribeAndReadSnapshot"
    ]);
    for (const method of ["archive", "create", "fork", "name", "prompt", "startTurn"]) {
      expect(client).not.toHaveProperty(method);
    }
    void HostDeckCodexLoadedThreadError;
  });
});

interface FakePort extends CodexLoadedThreadRequestPort {
  readonly requests: CodexRequestInput[];
}

function fakePort(
  handler: (request: CodexRequestInput) => unknown | Promise<unknown>,
  compatibility = readyCompatibility()
): FakePort {
  const requests: CodexRequestInput[] = [];
  return {
    compatibility,
    requests,
    async request(input) {
      requests.push(input);
      return handler(input);
    }
  };
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.148.0",
    checked_at: "2026-08-14T15:00:00.000Z",
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.148.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function disconnectedCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.148.0",
    checked_at: "2026-08-14T15:00:00.000Z",
    handshake: { state: "not_attempted" }
  });
}

function started(thread: Record<string, unknown>): CodexConnectionNotification {
  return {
    kind: "notification",
    classification: "selected",
    method: "thread/started",
    params: { thread }
  } as CodexConnectionNotification;
}

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: threadA,
    extra: null,
    sessionId: threadA,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: seconds("2026-08-14T14:00:00.000Z"),
    updatedAt: seconds("2026-08-14T15:00:00.000Z"),
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/work/side_cue_app",
    cliVersion: "0.148.0",
    source: "cli",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "sidecue",
    turns: [],
    ...overrides
  };
}

function resume(thread: Record<string, unknown>): Record<string, unknown> {
  return {
    thread,
    model: "gpt-5.5-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/work/side_cue_app",
    runtimeWorkspaceRoots: ["/work/side_cue_app"],
    instructionSources: ["/work/side_cue_app/AGENTS.md"],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null
  };
}

function turn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "turn-default",
    items: [],
    itemsView: "summary",
    status: "completed",
    error: null,
    startedAt: seconds("2026-08-14T14:20:00.000Z"),
    completedAt: seconds("2026-08-14T14:21:00.000Z"),
    durationMs: 60_000,
    ...overrides
  };
}

function agentMessage(id: string, text: string): Record<string, unknown> {
  return { type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null };
}

function userMessage(id: string, text: string): Record<string, unknown> {
  return { type: "userMessage", id, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
}

function seconds(value: string): number {
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
