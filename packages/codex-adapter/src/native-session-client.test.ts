import { nativeSessionContractLimits, type RuntimeCompatibility } from "@hostdeck/contracts";
import { createOperationDeadlineView } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexNativeSessionRequestPort,
  createCodexNativeSessionClient,
  HostDeckCodexNativeSessionError
} from "./native-session-client.js";

const checkedAt = "2026-08-12T15:00:00.000Z";
const threadA = "0198a001-native-thread-a";
const threadB = "0198a002-native-thread-b";

describe("native Codex session adapter", () => {
  it("discovers only bounded eligible metadata in deterministic order", async () => {
    const privateSentinels = ["private-preview", "private-rollout", "private-origin", "private-title"];
    let pageNumber = 0;
    const exact = new Map<string, Record<string, unknown>>();
    const port = fakePort((request) => {
      if (request.method === "thread/read") {
        const threadId = (request.params as { threadId: string }).threadId;
        return { thread: exact.get(threadId) };
      }
      expect(request.method).toBe("thread/list");
      expect(request.kind).toBe("read");
      expect(request.params).toEqual({
        archived: false,
        cursor: pageNumber === 0 ? null : "page-2",
        limit: 3,
        sortDirection: "desc",
        sortKey: "updated_at",
        sourceKinds: ["cli"],
        useStateDbOnly: false
      });
      pageNumber += 1;
      if (pageNumber === 1) {
        const candidates = [
          rawThread({
            id: threadB,
            updatedAt: unixSeconds("2026-08-12T14:30:00.000Z"),
            preview: privateSentinels[0],
            path: `/tmp/${privateSentinels[1]}`,
            gitInfo: { sha: "a".repeat(40), branch: "main", originUrl: `ssh://${privateSentinels[2]}` },
            name: privateSentinels[3]
          }),
          rawThread({ id: "0198a003-active", status: { type: "active", activeFlags: [] } }),
          rawThread({ id: "0198a004-invalid-cwd", cwd: "relative/private" })
        ];
        exact.set(threadB, candidates[0] as Record<string, unknown>);
        return page(candidates, "page-2", "back-1");
      }
      const candidates = [
        rawThread({ id: threadA, updatedAt: unixSeconds("2026-08-12T14:30:00.000Z") }),
        rawThread({ id: "0198a005-ephemeral", ephemeral: true }),
        rawThread({ id: "0198a006-version", cliVersion: "0.143.0" })
      ];
      exact.set(threadA, candidates[0] as Record<string, unknown>);
      exact.set("0198a006-version", candidates[2] as Record<string, unknown>);
      return page(candidates, null, "back-2");
    });
    const result = await createCodexNativeSessionClient(port, {
      page_size: 3,
      max_pages: 2,
      max_entries: 6
    }).discover({ limit: 1 });

    expect(result).toEqual({
      limit: 1,
      threads: [expect.objectContaining({
        thread_id: "0198a006-version",
        source: "cli",
        runtime_version: "0.143.0",
        archived: false
      })],
      truncated: true
    });
    expect(Object.keys(result.threads[0] as object).sort()).toEqual([
      "archived",
      "created_at",
      "cwd",
      "ephemeral",
      "forked_from_id",
      "history_mode",
      "parent_thread_id",
      "runtime_version",
      "source",
      "status",
      "thread_id",
      "updated_at"
    ]);
    for (const sentinel of privateSentinels) expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.threads)).toBe(true);
    expect(Object.isFrozen(result.threads[0])).toBe(true);
    expect(port.requests.map(({ method }) => method)).toEqual([
      "thread/list",
      "thread/read",
      "thread/list",
      "thread/read",
      "thread/read"
    ]);
  });

  it("accepts a strict quiet CLI history written by a different Codex version", async () => {
    const thread = rawThread({ cliVersion: "0.146.0" });
    const client = createCodexNativeSessionClient(fakePort((request) =>
      request.method === "thread/read" ? { thread } : page([thread], null, "back")
    ));

    await expect(client.discover()).resolves.toMatchObject({
      threads: [{ thread_id: threadA, runtime_version: "0.146.0" }]
    });
  });

  it("accepts a quiet top-level user fork while retaining its provenance", async () => {
    const forkedFromId = "0198a006-fork-source";
    const listed = rawThread();
    const exact = rawThread({ forkedFromId });
    const client = createCodexNativeSessionClient(fakePort((request) =>
      request.method === "thread/read" ? { thread: exact } : page([listed], null, "back")
    ));

    await expect(client.discover()).resolves.toMatchObject({
      threads: [{ thread_id: threadA, forked_from_id: forkedFromId, parent_thread_id: null }]
    });
  });

  it("excludes a parent thread revealed only by exact metadata", async () => {
    const listed = rawThread();
    const exact = rawThread({ parentThreadId: "0198a000-parent-thread" });
    const port = fakePort((request) =>
      request.method === "thread/read" ? { thread: exact } : page([listed], null, "back")
    );

    await expect(createCodexNativeSessionClient(port).discover()).resolves.toEqual({
      limit: nativeSessionContractLimits.discoveryDefaultLimit,
      threads: [],
      truncated: false
    });
    expect(port.requests.map(({ method }) => method)).toEqual(["thread/list", "thread/read"]);
  });

  it("excludes every reviewed ineligible native-thread class", async () => {
    const candidates = [
      rawThread({ id: "thread-archived-simulation", status: { type: "systemError" } }),
      rawThread({ id: "thread-ephemeral", ephemeral: true }),
      rawThread({ id: "thread-child", parentThreadId: "parent-thread" }),
      rawThread({ id: "thread-subagent", source: { subAgent: "review" } }),
      rawThread({ id: "thread-agent-role", agentRole: "reviewer" }),
      rawThread({ id: "thread-invalid-cwd", cwd: "not/absolute" })
    ];
    const client = createCodexNativeSessionClient(fakePort(() => page(candidates, null, "back")));
    await expect(client.discover()).resolves.toEqual({
      limit: nativeSessionContractLimits.discoveryDefaultLimit,
      threads: [],
      truncated: false
    });
  });

  it("rejects malformed/additive pages, duplicate ids, cursor loops, and capacity exhaustion", async () => {
    const missing = rawThread();
    delete missing.sessionId;
    const cases = [
      () => createCodexNativeSessionClient(fakePort(() => page([missing], null, "back"))).discover(),
      () => createCodexNativeSessionClient(fakePort(() => page([{ ...rawThread(), extraField: true }], null, "back"))).discover(),
      () => createCodexNativeSessionClient(fakePort(() => ({ ...page([], null, null), additive: true }))).discover(),
      () => createCodexNativeSessionClient(fakePort(() => page([], "same", null)), { max_pages: 2 }).discover()
    ];
    for (const operation of cases) await expectAdapterError(operation(), "invalid_protocol_message");

    let pageNumber = 0;
    const duplicate = createCodexNativeSessionClient(fakePort(() => {
      pageNumber += 1;
      return page([rawThread()], pageNumber === 1 ? "next" : null, "back");
    }), { page_size: 1, max_pages: 2 });
    await expectAdapterError(duplicate.discover(), "invalid_protocol_message");

    const pageOverflow = createCodexNativeSessionClient(
      fakePort(() => page([], "more", null)),
      { max_pages: 1 }
    );
    await expectAdapterError(pageOverflow.discover(), "broker_overloaded");

    const entryOverflow = createCodexNativeSessionClient(
      fakePort((request) =>
        request.method === "thread/read"
          ? { thread: rawThread() }
          : page([rawThread(), rawThread({ id: threadB })], null, "back")
      ),
      { max_entries: 1 }
    );
    await expectAdapterError(entryOverflow.discover(), "broker_overloaded");
  });

  it("reads bounded recent terminal history and drops every private non-message field", async () => {
    const privateSentinels = [
      "private-local-image",
      "private-skill-path",
      "private-citation",
      "private-reasoning",
      "private-command",
      "private-output"
    ];
    const turns = [
      rawTurn({
        id: "turn-newer",
        startedAt: unixSeconds("2026-08-12T14:20:00.000Z"),
        completedAt: unixSeconds("2026-08-12T14:21:00.000Z"),
        items: [
          agentMessage("item-agent-newer", "Second answer", privateSentinels[2] as string),
          {
            type: "commandExecution",
            id: "item-command",
            command: privateSentinels[4],
            cwd: "/private/cwd",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: privateSentinels[5],
            exitCode: 0,
            durationMs: 10
          }
        ]
      }),
      rawTurn({
        id: "turn-older",
        items: [
          {
            type: "userMessage",
            id: "item-user-older",
            clientId: null,
            content: [
              { type: "text", text: "First question", text_elements: [] },
              { type: "localImage", path: `/tmp/${privateSentinels[0]}` },
              { type: "skill", name: "private-skill", path: `/tmp/${privateSentinels[1]}` }
            ]
          },
          agentMessage("item-agent-older", "First answer", privateSentinels[2] as string),
          { type: "reasoning", id: "item-reasoning", summary: [privateSentinels[3]], content: [privateSentinels[3]] }
        ]
      })
    ];
    const port = adoptionPort(turns, { nextCursor: "older-turns" });
    const snapshot = await createCodexNativeSessionClient(port).readAdoptionSnapshot(threadA);

    expect(snapshot).toMatchObject({
      thread: { thread_id: threadA },
      truncated_before: true,
      turns: [
        {
          turn_id: "turn-older",
          messages: [
            { item_id: "item-user-older", role: "user", text: "First question" },
            { item_id: "item-agent-older", role: "agent", text: "First answer" }
          ]
        },
        {
          turn_id: "turn-newer",
          messages: [{ item_id: "item-agent-newer", role: "agent", text: "Second answer" }]
        }
      ]
    });
    for (const sentinel of privateSentinels) expect(JSON.stringify(snapshot)).not.toContain(sentinel);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.thread)).toBe(true);
    expect(Object.isFrozen(snapshot.turns)).toBe(true);
    expect(Object.isFrozen(snapshot.turns[0]?.messages)).toBe(true);
    expect(port.requests.map(({ method }) => method)).toEqual([
      "thread/read",
      "thread/turns/list",
      "thread/read"
    ]);
    expect(port.requests[1]?.params).toEqual({
      threadId: threadA,
      cursor: null,
      limit: 20,
      sortDirection: "desc",
      itemsView: "summary"
    });
  });

  it("omits oversized private payloads from recognized non-message history items", async () => {
    const privateDiff = `private-large-diff-${"x".repeat(64_000)}`;
    const snapshot = await createCodexNativeSessionClient(adoptionPort([
      rawTurn({
        items: [
          {
            type: "fileChange",
            id: "item-large-file-change",
            changes: [{
              path: "/private/large-generated-file",
              kind: { type: "add" },
              diff: privateDiff
            }],
            status: "completed"
          },
          agentMessage("item-retained-agent", "Retained answer", null)
        ]
      })
    ])).readAdoptionSnapshot(threadA);

    expect(snapshot.turns[0]?.messages).toEqual([
      { item_id: "item-retained-agent", role: "agent", text: "Retained answer" }
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private-large-diff");

    await expectAdapterError(
      createCodexNativeSessionClient(adoptionPort([
        rawTurn({
          items: [
            { type: "fileChange", id: "item-duplicate", changes: [], status: "completed" },
            agentMessage("item-duplicate", "Duplicate identity", null)
          ]
        })
      ])).readAdoptionSnapshot(threadA),
      "invalid_protocol_message"
    );
  });

  it("imports retained text without validating recognized omitted user-input bodies", async () => {
    const privateImagePath = "/private/legacy-image.png";
    const privateCitation = { futurePrivateShape: "private-citation" };
    const snapshot = await createCodexNativeSessionClient(adoptionPort([
      rawTurn({
        items: [
          {
            type: "userMessage",
            id: "item-legacy-user",
            clientId: null,
            content: [
              {
                type: "text",
                text: "Retained question",
                text_elements: [{ legacyPrivateShape: true }]
              },
              { type: "localImage", detail: null, path: privateImagePath }
            ]
          },
          {
            ...agentMessage("item-agent-private-metadata", "Retained answer", null),
            memoryCitation: privateCitation
          }
        ]
      })
    ])).readAdoptionSnapshot(threadA);

    expect(snapshot.turns[0]?.messages).toEqual([
      { item_id: "item-legacy-user", role: "user", text: "Retained question" },
      { item_id: "item-agent-private-metadata", role: "agent", text: "Retained answer" }
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(privateImagePath);
    expect(JSON.stringify(snapshot)).not.toContain("private-citation");

    for (const item of [
      {
        type: "userMessage",
        id: "item-unknown-input",
        clientId: null,
        content: [{ type: "futureInput", privatePayload: true }]
      },
      {
        type: "userMessage",
        id: "item-malformed-text",
        clientId: null,
        content: [{ type: "text", text: 42, text_elements: [] }]
      }
    ]) {
      await expectAdapterError(
        createCodexNativeSessionClient(adoptionPort([rawTurn({ items: [item] })]))
          .readAdoptionSnapshot(threadA),
        "invalid_protocol_message"
      );
    }
  });

  it("rejects identity races, newly ineligible state, active history, malformed items, and item overflow", async () => {
    const changed = adoptionPort([rawTurn()], {
      after: rawThread({ updatedAt: unixSeconds("2026-08-12T15:01:00.000Z") })
    });
    await expect(
      createCodexNativeSessionClient(changed).readAdoptionSnapshot(threadA)
    ).rejects.toMatchObject({ code: "identity_changed", retry_safe: true });

    const ineligibleAfter = adoptionPort([rawTurn()], { after: rawThread({ status: { type: "active", activeFlags: [] } }) });
    await expect(
      createCodexNativeSessionClient(ineligibleAfter).readAdoptionSnapshot(threadA)
    ).rejects.toMatchObject({ code: "thread_ineligible", retry_safe: false });

    const invalidTurns = [
      rawTurn({ status: "inProgress", completedAt: null }),
      rawTurn({ itemsView: "full" }),
      rawTurn({ items: [{ ...agentMessage("item-agent", "answer", null), additive: true }] }),
      rawTurn({ items: [{ type: "futureItem", id: "item-future" }] }),
      rawTurn({ status: "failed", error: { message: "failed", codexErrorInfo: { future: {} }, additionalDetails: null } })
    ];
    for (const turn of invalidTurns) {
      await expectAdapterError(
        createCodexNativeSessionClient(adoptionPort([turn])).readAdoptionSnapshot(threadA),
        "invalid_protocol_message"
      );
    }

    await expectAdapterError(
      createCodexNativeSessionClient(adoptionPort([rawTurn({
        items: [agentMessage("item-one", "one", null), agentMessage("item-two", "two", null)]
      })]), { max_history_items_per_turn: 1 }).readAdoptionSnapshot(threadA),
      "broker_overloaded"
    );
  });

  it("projects a bounded contiguous suffix from mature and interrupted turns", async () => {
    const manyMessages = Array.from({ length: nativeSessionContractLimits.messagesPerTurn + 3 }, (_, index) =>
      agentMessage(`item-message-${index}`, `answer-${index}`, null)
    );
    const matureItems = [
      ...Array.from({ length: 612 }, (_, index) => ({
        type: "fileChange",
        id: `item-file-${index}`,
        changes: [],
        status: "completed"
      })),
      ...manyMessages
    ];
    const port = adoptionPort([
      rawTurn({
        id: "turn-newest",
        status: "interrupted",
        completedAt: null,
        items: matureItems
      }),
      rawTurn({
        id: "turn-older-unretained",
        startedAt: unixSeconds("2026-08-12T13:00:00.000Z"),
        completedAt: unixSeconds("2026-08-12T13:01:00.000Z"),
        items: [{ type: "futureItem", id: "item-older-unsupported" }]
      })
    ]);

    const snapshot = await createCodexNativeSessionClient(port).readAdoptionSnapshot(threadA);

    expect(snapshot).toMatchObject({
      truncated_before: true,
      turns: [{ turn_id: "turn-newest", status: "interrupted", completed_at: null }]
    });
    expect(snapshot.turns[0]?.messages).toHaveLength(nativeSessionContractLimits.messagesPerTurn);
    expect(snapshot.turns[0]?.messages[0]?.item_id).toBe("item-message-3");
    expect(snapshot.turns[0]?.messages.at(-1)?.item_id).toBe(
      `item-message-${nativeSessionContractLimits.messagesPerTurn + 2}`
    );
  });

  it("uses one shrinking deadline across the identity-history-identity bracket", async () => {
    let now = 0;
    const controller = new AbortController();
    const deadline = createOperationDeadlineView({
      timeoutMs: 1_000,
      signal: controller.signal,
      clock: { now: () => now }
    });
    const base = adoptionPort([rawTurn()]);
    const observed: number[] = [];
    const port = fakePort(async (request) => {
      observed.push(request.timeout_ms as number);
      now += 100;
      return base.request(request);
    });

    await createCodexNativeSessionClient(port, { read_timeout_ms: 1_000 }).readAdoptionSnapshot(threadA, deadline);
    expect(observed).toEqual([1_000, 900, 800]);

    controller.abort();
    await expectAdapterError(
      createCodexNativeSessionClient(fakePort(() => null), { read_timeout_ms: 1_000 })
        .readIdentity(threadA, deadline),
      "request_aborted"
    );
  });

  it("resumes exactly one id without overrides or hidden mutation methods", async () => {
    const port = fakePort((request) => {
      expect(request).toMatchObject({
        method: "thread/resume",
        kind: "read",
        params: { threadId: threadA, excludeTurns: true }
      });
      expect(Object.keys(request.params as object).sort()).toEqual(["excludeTurns", "threadId"]);
      return rawResumeResult();
    });
    const client = createCodexNativeSessionClient(port);
    await expect(client.resume(threadA)).resolves.toMatchObject({
      thread: { thread_id: threadA, source: "cli" },
      runtime_model: "gpt-5.5-codex",
      reasoning_effort: "high"
    });
    expect(typeof client.discover).toBe("function");
    expect(typeof client.readAdoptionSnapshot).toBe("function");
    expect(typeof client.readIdentity).toBe("function");
    expect(typeof client.resume).toBe("function");
    for (const method of ["archive", "delete", "fork", "name", "start"]) expect(client).not.toHaveProperty(method);
  });

  it("rejects resume drift, contradictory cwd/history, and incompatible runtime before dispatch", async () => {
    const invalid = [
      rawResumeResult({ additive: true }),
      rawResumeResult({ cwd: "/tmp/different" }),
      rawResumeResult({ modelProvider: "other-provider" }),
      rawResumeResult({ thread: rawThread({ id: threadB, cwd: "relative/private" }) }),
      rawResumeResult({ thread: rawThread({ turns: [rawTurn()] }) }),
      rawResumeResult({ initialTurnsPage: page([], null, null) }),
      rawResumeResult({ sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: true } })
    ];
    for (const result of invalid) {
      await expectAdapterError(
        createCodexNativeSessionClient(fakePort(() => result)).resume(threadA),
        "invalid_protocol_message"
      );
    }

    const disconnected = fakePort(() => null, disconnectedCompatibility());
    const client = createCodexNativeSessionClient(disconnected);
    expect(() => client.runtime_version).toThrow(HostDeckCodexAdapterError);
    await expectAdapterError(client.discover(), "handshake_failed");
    expect(disconnected.requests).toHaveLength(0);
  });

  it("validates caller input and immutable option bounds without protocol dispatch", async () => {
    const port = fakePort(() => null);
    await expectAdapterError(createCodexNativeSessionClient(port).discover({ limit: 0 }), "invalid_protocol_message");
    await expectAdapterError(createCodexNativeSessionClient(port).readIdentity("bad thread id"), "invalid_protocol_message");
    expect(port.requests).toHaveLength(0);
    expect(() => createCodexNativeSessionClient(port, { page_size: 0 })).toThrow(TypeError);
    expect(() => createCodexNativeSessionClient(port, { extra: true } as never)).toThrow(TypeError);
  });

  it("rejects a mismatched read id before treating an invalid cwd as an ordinary exclusion", async () => {
    await expectAdapterError(
      createCodexNativeSessionClient(fakePort(() => ({
        thread: rawThread({ id: threadB, cwd: "relative/private" })
      }))).readIdentity(threadA),
      "invalid_protocol_message"
    );
  });
});

interface FakePort extends CodexNativeSessionRequestPort {
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

function adoptionPort(
  turns: unknown[],
  options: {
    readonly after?: Record<string, unknown>;
    readonly nextCursor?: string | null;
  } = {}
): FakePort {
  let reads = 0;
  return fakePort((request) => {
    if (request.method === "thread/read") {
      reads += 1;
      return { thread: reads === 1 ? rawThread() : options.after ?? rawThread() };
    }
    if (request.method === "thread/turns/list") {
      return page(turns, options.nextCursor ?? null, turns.length === 0 ? null : "back");
    }
    throw new Error(`Unexpected method ${request.method}.`);
  });
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

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: threadA,
    extra: null,
    sessionId: "native-session-a",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: unixSeconds("2026-08-12T14:00:00.000Z"),
    updatedAt: unixSeconds("2026-08-12T15:00:00.000Z"),
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp/native-project",
    cliVersion: "0.144.0",
    source: "cli",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides
  };
}

function rawTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "turn-older",
    items: [agentMessage("item-agent", "answer", null)],
    itemsView: "summary",
    status: "completed",
    error: null,
    startedAt: unixSeconds("2026-08-12T14:10:00.000Z"),
    completedAt: unixSeconds("2026-08-12T14:11:00.000Z"),
    durationMs: 60_000,
    ...overrides
  };
}

function agentMessage(id: string, text: string, citationPath: string | null): Record<string, unknown> {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: citationPath === null
      ? null
      : {
          entries: [{ path: citationPath, lineStart: 1, lineEnd: 2, note: "private-note" }],
          threadIds: [threadA]
        }
  };
}

function rawResumeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    thread: rawThread(),
    model: "gpt-5.5-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp/native-project",
    runtimeWorkspaceRoots: ["/tmp/native-project"],
    instructionSources: ["/tmp/private-instructions.md"],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: ["/tmp/native-project"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    activePermissionProfile: { id: ":workspace", extends: null },
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: null,
    ...overrides
  };
}

function page(data: unknown[], nextCursor: string | null, backwardsCursor: string | null) {
  return { data, nextCursor, backwardsCursor };
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

void HostDeckCodexNativeSessionError;
