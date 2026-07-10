import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexThreadRequestPort,
  codexThreadOperationMarker,
  createCodexThreadClient,
  hasHostDeckOperationMarker,
  isSupportedCodexThreadSource
} from "./thread-client.js";

const checkedAt = "2026-07-09T22:00:00.000Z";

describe("normalized Codex thread client", () => {
  it("starts a loaded legacy-history thread with a recoverable operation marker", async () => {
    const port = fakePort((request) => {
      expect(request).toMatchObject({ method: "thread/start", kind: "mutation", timeout_ms: 30_000 });
      expect(request.params).toEqual({
        cwd: "/tmp/project-a",
        ephemeral: false,
        historyMode: "legacy",
        threadSource: "hostdeck:op_thread_start_0001"
      });
      return {
        thread: rawThread({
          id: "thread-a",
          cwd: "/tmp/project-a",
          source: "vscode",
          threadSource: "hostdeck:op_thread_start_0001"
        }),
        cwd: "/tmp/project-a",
        model: "gpt-5.5-codex"
      };
    });
    const client = createCodexThreadClient(port);

    await expect(client.start({ operation_id: "op_thread_start_0001", cwd: "/tmp/project-a" })).resolves.toMatchObject({
      model: "gpt-5.5-codex",
      thread: {
        id: "thread-a",
        cwd: "/tmp/project-a",
        source: "vscode",
        thread_source: "hostdeck:op_thread_start_0001",
        status: "idle",
        active_flags: [],
        archived: null
      }
    });
    expect(client.runtime_version).toBe("0.144.0");
  });

  it.each([
    ["different cwd", { cwd: "/tmp/project-b" }],
    ["missing marker", { threadSource: null }],
    ["wrong source", { source: "cli" }],
    ["reversed timestamp", { updatedAt: unixSeconds("2026-07-09T19:00:00.000Z") }],
    ["malformed status", { status: { type: "future" } }]
  ])("rejects a start response with %s", async (_label, override) => {
    const port = fakePort(() => ({
      thread: rawThread({ cwd: "/tmp/project-a", threadSource: "hostdeck:op_thread_start_0001", ...override }),
      cwd: "/tmp/project-a",
      model: "gpt-5.5-codex"
    }));
    await expectAdapterError(
      createCodexThreadClient(port).start({ operation_id: "op_thread_start_0001", cwd: "/tmp/project-a" }),
      "invalid_protocol_message"
    );
  });

  it("normalizes active flags and bounds paginated active plus archived listing", async () => {
    const port = fakePort((request) => {
      expect(request.method).toBe("thread/list");
      const params = request.params as { readonly archived: boolean; readonly cursor: string | null };
      if (!params.archived && params.cursor === null) {
        return {
          data: [rawThread({ id: "thread-a", status: { type: "active", activeFlags: ["waitingOnUserInput"] } })],
          nextCursor: "active-next"
        };
      }
      if (!params.archived) return { data: [rawThread({ id: "thread-b" })], nextCursor: null };
      return { data: [rawThread({ id: "thread-c" })], nextCursor: null };
    });
    const threads = await createCodexThreadClient(port, { page_size: 2, max_pages: 3 }).listAll();

    expect(threads).toMatchObject([
      { id: "thread-a", archived: false, status: "active", active_flags: ["waiting_on_user_input"] },
      { id: "thread-b", archived: false },
      { id: "thread-c", archived: true }
    ]);
    expect(port.requests.map((request) => request.params)).toEqual([
      expect.objectContaining({ archived: false, cursor: null, limit: 2, useStateDbOnly: false }),
      expect.objectContaining({ archived: false, cursor: "active-next", limit: 2 }),
      expect.objectContaining({ archived: true, cursor: null, limit: 2 })
    ]);
  });

  it("rejects cursor cycles, duplicate ids, and page-count overflow", async () => {
    const cycle = fakePort(() => ({ data: [], nextCursor: "same" }));
    await expectAdapterError(createCodexThreadClient(cycle).listAll(), "invalid_protocol_message");

    let duplicatePage = 0;
    const duplicate = fakePort((request) => {
      const archived = (request.params as { readonly archived: boolean }).archived;
      if (archived) return { data: [], nextCursor: null };
      duplicatePage += 1;
      return { data: [rawThread({ id: "thread-duplicate" })], nextCursor: duplicatePage === 1 ? "next" : null };
    });
    await expectAdapterError(createCodexThreadClient(duplicate).listAll(), "invalid_protocol_message");

    const overflow = fakePort(() => ({ data: [], nextCursor: "more" }));
    await expectAdapterError(createCodexThreadClient(overflow, { max_pages: 1 }).listAll(), "broker_overloaded");
  });

  it("finds the exact operation marker across stored and loaded-only threads", async () => {
    const port = fakePort((request) => {
      if (request.method === "thread/loaded/list") {
        return { data: ["thread-match", "thread-loaded-match", "thread-loaded-other"], nextCursor: null };
      }
      if (request.method === "thread/read") {
        const threadId = (request.params as { readonly threadId: string }).threadId;
        return {
          thread: rawThread({
            id: threadId,
            threadSource:
              threadId === "thread-loaded-match"
                ? "hostdeck:op_thread_start_0001"
                : "hostdeck:op_thread_start_0002"
          })
        };
      }
      const archived = (request.params as { readonly archived: boolean }).archived;
      return {
        data: archived
          ? [rawThread({ id: "thread-archived", threadSource: "hostdeck:op_thread_start_0001" })]
          : [
              rawThread({ id: "thread-match", threadSource: "hostdeck:op_thread_start_0001" }),
              rawThread({ id: "thread-other", threadSource: "hostdeck:op_thread_start_0002" })
            ],
        nextCursor: null
      };
    });

    await expect(createCodexThreadClient(port).findByOperationId("op_thread_start_0001")).resolves.toMatchObject([
      { id: "thread-match", archived: false },
      { id: "thread-archived", archived: true },
      { id: "thread-loaded-match", archived: null }
    ]);
  });

  it("materializes a loaded thread with a temporary goal and leaves the stored thread named and goal-clean", async () => {
    let name: string | null = null;
    let goal: string | null = null;
    let stored = false;
    const marker = "hostdeck:op_thread_start_0001";
    const port = fakePort((request) => {
      if (request.method === "thread/read") {
        return {
          thread: rawThread({
            cwd: "/tmp/project-a",
            name,
            source: "vscode",
            threadSource: stored ? null : marker
          })
        };
      }
      if (request.method === "thread/list") {
        const archived = (request.params as { readonly archived: boolean }).archived;
        return {
          data: !archived && stored ? [rawThread({ name, source: "vscode", threadSource: null })] : [],
          nextCursor: null
        };
      }
      if (request.method === "thread/name/set") {
        name = (request.params as { readonly name: string }).name;
        return {};
      }
      if (request.method === "thread/goal/get") return { goal: goal === null ? null : rawGoal(goal) };
      if (request.method === "thread/goal/set") {
        goal = (request.params as { readonly objective: string }).objective;
        stored = true;
        return { goal: rawGoal(goal) };
      }
      if (request.method === "thread/goal/clear") {
        goal = null;
        return { cleared: true };
      }
      throw new Error(`Unexpected request ${request.method}.`);
    });

    await expect(
      createCodexThreadClient(port).ensureMaterialized({
        thread_id: "thread-a",
        operation_id: "op_thread_start_0001",
        cwd: "/tmp/project-a",
        name: "managed-one"
      })
    ).resolves.toMatchObject({
      id: "thread-a",
      name: "managed-one",
      thread_source: null,
      archived: false
    });
    expect(port.requests.map((request) => request.method)).toEqual(
      expect.arrayContaining(["thread/name/set", "thread/goal/set", "thread/goal/clear"])
    );
    expect(goal).toBeNull();
  });

  it("finishes a partial materialization without setting the internal goal twice", async () => {
    let goal: string | null = "hostdeck:op_thread_start_0001";
    const port = fakePort((request) => {
      if (request.method === "thread/read") {
        return { thread: rawThread({ name: "managed-one", source: "vscode", threadSource: null }) };
      }
      if (request.method === "thread/list") {
        const archived = (request.params as { readonly archived: boolean }).archived;
        return {
          data: archived ? [] : [rawThread({ name: "managed-one", source: "vscode", threadSource: null })],
          nextCursor: null
        };
      }
      if (request.method === "thread/goal/get") return { goal: goal === null ? null : rawGoal(goal) };
      if (request.method === "thread/goal/clear") {
        goal = null;
        return { cleared: true };
      }
      throw new Error(`Unexpected request ${request.method}.`);
    });

    await expect(
      createCodexThreadClient(port).ensureMaterialized({
        thread_id: "thread-a",
        operation_id: "op_thread_start_0001",
        cwd: "/tmp/project-a",
        name: "managed-one"
      })
    ).resolves.toMatchObject({ id: "thread-a", name: "managed-one", archived: false });
    expect(port.requests.some((request) => request.method === "thread/goal/set")).toBe(false);
  });

  it("rejects unstored threads without the exact marker and conflicting partial goals", async () => {
    const unowned = fakePort((request) => {
      if (request.method === "thread/read") return { thread: rawThread({ source: "vscode", threadSource: null }) };
      return { data: [], nextCursor: null };
    });
    await expectAdapterError(
      createCodexThreadClient(unowned).ensureMaterialized({
        thread_id: "thread-a",
        operation_id: "op_thread_start_0001",
        cwd: "/tmp/project-a",
        name: "managed-one"
      }),
      "invalid_protocol_message"
    );

    const conflicting = fakePort((request) => {
      if (request.method === "thread/read") {
        return { thread: rawThread({ name: "wrong-name", source: "vscode", threadSource: null }) };
      }
      if (request.method === "thread/list") {
        return {
          data: (request.params as { readonly archived: boolean }).archived
            ? []
            : [rawThread({ name: "managed-one", source: "vscode", threadSource: null })],
          nextCursor: null
        };
      }
      if (request.method === "thread/goal/get") return { goal: rawGoal("not-hostdeck") };
      if (request.method === "thread/name/set") return {};
      throw new Error(`Unexpected request ${request.method}.`);
    });
    await expectAdapterError(
      createCodexThreadClient(conflicting).ensureMaterialized({
        thread_id: "thread-a",
        operation_id: "op_thread_start_0001",
        cwd: "/tmp/project-a",
        name: "managed-one"
      }),
      "invalid_protocol_message"
    );
    expect(conflicting.requests.some((request) => request.method === "thread/name/set")).toBe(false);
  });

  it("bounds exact reads while recovering loaded-only operation markers", async () => {
    const port = fakePort((request) => {
      if (request.method === "thread/list") return { data: [], nextCursor: null };
      if (request.method === "thread/loaded/list") return { data: ["thread-a", "thread-b"], nextCursor: null };
      throw new Error(`Unexpected request ${request.method}.`);
    });
    await expectAdapterError(
      createCodexThreadClient(port, { max_loaded_reads: 1 }).findByOperationId("op_thread_start_0001"),
      "broker_overloaded"
    );
    expect(port.requests.some((request) => request.method === "thread/read")).toBe(false);
  });

  it("reads an exact thread without turns and validates archive acknowledgement", async () => {
    const port = fakePort((request) => {
      if (request.method === "thread/read") {
        expect(request.params).toEqual({ threadId: "thread-a", includeTurns: false });
        return { thread: rawThread({ id: "thread-a" }) };
      }
      expect(request).toMatchObject({ method: "thread/archive", kind: "mutation" });
      expect(request.params).toEqual({ threadId: "thread-a" });
      return {};
    });
    const client = createCodexThreadClient(port);

    await expect(client.read("thread-a")).resolves.toMatchObject({ id: "thread-a", archived: null });
    await expect(client.archive("thread-a")).resolves.toBeUndefined();
  });

  it("rejects mismatched reads and non-empty archive acknowledgements", async () => {
    const readPort = fakePort(() => ({ thread: rawThread({ id: "thread-other" }) }));
    await expectAdapterError(createCodexThreadClient(readPort).read("thread-a"), "invalid_protocol_message");

    const archivePort = fakePort(() => ({ warning: "unexpected" }));
    await expectAdapterError(createCodexThreadClient(archivePort).archive("thread-a"), "invalid_protocol_message");
  });

  it("rejects invalid markers/options and disconnected compatibility before dispatch", async () => {
    expect(() => codexThreadOperationMarker("bad")).toThrow(HostDeckCodexAdapterError);
    expect(() => createCodexThreadClient(fakePort(() => null), { page_size: 0 })).toThrow(HostDeckCodexAdapterError);
    expect(() => createCodexThreadClient(fakePort(() => null), { read_timeout_ms: 0 })).toThrow(
      HostDeckCodexAdapterError
    );
    const port = fakePort(() => null, disconnectedCompatibility());
    await expectAdapterError(
      createCodexThreadClient(port).start({ operation_id: "op_thread_start_0001", cwd: "/tmp/project-a" }),
      "handshake_failed"
    );
    expect(port.requests).toHaveLength(0);
  });

  it("passes configured read, mutation, and start deadlines without extension", async () => {
    const port = fakePort((request) => {
      if (request.method === "thread/start") {
        return {
          thread: rawThread({
            id: "thread-timeout",
            cwd: "/tmp/project-a",
            source: "vscode",
            threadSource: "hostdeck:op_thread_start_0001"
          }),
          cwd: "/tmp/project-a",
          model: "gpt-5.5-codex"
        };
      }
      if (request.method === "thread/read") return { thread: rawThread({ id: "thread-timeout" }) };
      if (request.method === "thread/archive") return {};
      throw new Error(`Unexpected method ${request.method}`);
    });
    const client = createCodexThreadClient(port, {
      read_timeout_ms: 4_000,
      mutation_timeout_ms: 8_000,
      start_timeout_ms: 20_000
    });

    await client.start({ operation_id: "op_thread_start_0001", cwd: "/tmp/project-a" });
    await client.read("thread-timeout");
    await client.archive("thread-timeout");

    expect(port.requests.map((request) => [request.method, request.timeout_ms])).toEqual([
      ["thread/start", 20_000],
      ["thread/read", 4_000],
      ["thread/archive", 8_000]
    ]);
  });

  it("recognizes only valid HostDeck markers on supported app-server session sources", () => {
    expect(hasHostDeckOperationMarker({ source: "vscode", thread_source: "hostdeck:op_thread_start_0001" })).toBe(true);
    expect(hasHostDeckOperationMarker({ source: "app_server", thread_source: "hostdeck:op_thread_start_0001" })).toBe(true);
    expect(hasHostDeckOperationMarker({ source: "other", thread_source: "hostdeck:op_thread_start_0001" })).toBe(false);
    expect(hasHostDeckOperationMarker({ source: "vscode", thread_source: "hostdeck:not-valid" })).toBe(false);
    expect(hasHostDeckOperationMarker({ source: "vscode", thread_source: null })).toBe(false);
    expect(isSupportedCodexThreadSource("vscode")).toBe(true);
    expect(isSupportedCodexThreadSource("other")).toBe(false);
  });
});

interface FakePort extends CodexThreadRequestPort {
  readonly requests: CodexRequestInput[];
}

function fakePort(handler: (request: CodexRequestInput) => unknown | Promise<unknown>, compatibility = readyCompatibility()): FakePort {
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
  return assessCodexCompatibility({ observed_version: "0.144.0", checked_at: checkedAt, handshake: { state: "not_attempted" } });
}

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-a",
    cwd: "/tmp/project-a",
    createdAt: unixSeconds("2026-07-09T20:00:00.000Z"),
    updatedAt: unixSeconds("2026-07-09T20:01:00.000Z"),
    status: { type: "idle" },
    source: "appServer",
    threadSource: null,
    modelProvider: "openai",
    name: null,
    preview: "",
    ...overrides
  };
}

function rawGoal(objective: string): Record<string, unknown> {
  return {
    threadId: "thread-a",
    objective,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: unixSeconds("2026-07-09T20:00:00.000Z"),
    updatedAt: unixSeconds("2026-07-09T20:01:00.000Z")
  };
}

function unixSeconds(value: string): number {
  return Date.parse(value) / 1_000;
}

async function expectAdapterError(promise: Promise<unknown>, code: HostDeckCodexAdapterError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
