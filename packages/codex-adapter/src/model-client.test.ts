import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { type CodexModelRequestPort, createCodexModelClient } from "./model-client.js";

const checkedAt = "2026-07-10T16:00:00.000Z";

describe("normalized Codex model client", () => {
  it("normalizes a bounded paginated visible catalog with a stable revision", async () => {
    const port = fakePort((request) => {
      expect(request).toMatchObject({ method: "model/list", kind: "read", timeout_ms: 10_000 });
      const cursor = (request.params as { readonly cursor: string | null }).cursor;
      return cursor === null
        ? { data: [rawModel({ id: "model-a", model: "runtime-a", isDefault: true })], nextCursor: "page-2" }
        : { data: [rawModel({ id: "model-b", model: "runtime-b", isDefault: false })], nextCursor: null };
    });
    const client = createCodexModelClient(port, {
      page_size: 1,
      max_pages: 2,
      max_entries: 2,
      now: () => checkedAt
    });

    const first = await client.listCatalog();
    const second = await client.listCatalog();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      observed_at: checkedAt,
      models: [
        {
          id: "model-a",
          runtime_model: "runtime-a",
          label: "Model A",
          description: "Model description",
          is_default: true,
          input_modalities: ["text", "image"],
          reasoning_efforts: [
            { id: "low", description: "Fast", is_default: false },
            { id: "high", description: "Thorough", is_default: true }
          ]
        },
        expect.objectContaining({ id: "model-b", runtime_model: "runtime-b", is_default: false })
      ]
    });
    expect(port.requests.slice(0, 2).map((request) => request.params)).toEqual([
      { cursor: null, limit: 1, includeHidden: false },
      { cursor: "page-2", limit: 1, includeHidden: false }
    ]);
  });

  it("rejects hidden entries, duplicate identities, ambiguous defaults, and pagination overflow", async () => {
    await expectAdapterError(
      createCodexModelClient(fakePort(() => ({ data: [rawModel({ hidden: true })], nextCursor: null }))).listCatalog(),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => ({
          data: [rawModel({ id: "same", model: "runtime-a", isDefault: true }), rawModel({ id: "same", model: "runtime-b" })],
          nextCursor: null
        }))
      ).listCatalog(),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => ({
          data: [rawModel({ id: "a", model: "a", isDefault: true }), rawModel({ id: "b", model: "b", isDefault: true })],
          nextCursor: null
        }))
      ).listCatalog(),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexModelClient(fakePort(() => ({ data: [rawModel()], nextCursor: "more" })), {
        page_size: 1,
        max_pages: 1,
        max_entries: 1
      }).listCatalog(),
      "broker_overloaded"
    );

    let cyclePage = 0;
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => {
          cyclePage += 1;
          return {
            data: [rawModel({ id: `model-${cyclePage}`, model: `runtime-${cyclePage}`, isDefault: cyclePage === 1 })],
            nextCursor: "same"
          };
        }),
        { page_size: 1, max_pages: 3, max_entries: 3 }
      ).listCatalog(),
      "invalid_protocol_message"
    );

    let boundedPage = 0;
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => {
          boundedPage += 1;
          return {
            data: [rawModel({ id: `bounded-${boundedPage}`, model: `bounded-runtime-${boundedPage}`, isDefault: boundedPage === 1 })],
            nextCursor: boundedPage === 1 ? "next" : null
          };
        }),
        { page_size: 1, max_pages: 2, max_entries: 1 }
      ).listCatalog(),
      "broker_overloaded"
    );
  });

  it("rejects malformed effort and service-tier relationships", async () => {
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => ({
          data: [rawModel({ defaultReasoningEffort: "missing" })],
          nextCursor: null
        }))
      ).listCatalog(),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => ({
          data: [rawModel({ defaultServiceTier: "missing" })],
          nextCursor: null
        }))
      ).listCatalog(),
      "invalid_protocol_message"
    );
  });

  it("reads current model state without sending an ineffective resume override", async () => {
    const port = fakePort((request) => {
      expect(request).toMatchObject({
        method: "thread/resume",
        kind: "read",
        params: { threadId: "thread-a", excludeTurns: true }
      });
      expect(request.params).not.toHaveProperty("model");
      return rawResumeResult();
    });

    await expect(createCodexModelClient(port).readCurrent("thread-a")).resolves.toEqual({
      thread_id: "thread-a",
      runtime_model: "runtime-a",
      reasoning_effort: "high"
    });
  });

  it("rejects contradictory or turn-populated current-state read-back", async () => {
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => rawResumeResult({ thread: rawThread({ id: "thread-b" }) }))
      ).readCurrent("thread-a"),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexModelClient(
        fakePort(() => rawResumeResult({ thread: rawThread({ turns: [rawTurn()] }) }))
      ).readCurrent("thread-a"),
      "invalid_protocol_message"
    );
  });

  it("dispatches the selected catalog model and resolved effort only through turn/start", async () => {
    const port = fakePort((request) => {
      expect(request).toMatchObject({ method: "turn/start", kind: "mutation", timeout_ms: 30_000 });
      expect(request.params).toEqual({
        threadId: "thread-a",
        clientUserMessageId: "op_model_turn_0001",
        input: [{ type: "text", text: "Continue the selected task.", text_elements: [] }],
        model: "runtime-b",
        effort: "low"
      });
      return { turn: rawTurn() };
    });

    await expect(
      createCodexModelClient(port).startTurn({
        operation_id: "op_model_turn_0001",
        thread_id: "thread-a",
        text: "Continue the selected task.",
        runtime_model: "runtime-b",
        reasoning_effort: "low"
      })
    ).resolves.toEqual({ thread_id: "thread-a", turn_id: "turn-a", state: "accepted" });
  });

  it("does not upgrade malformed or terminal turn responses into acceptance", async () => {
    await expectAdapterError(
      createCodexModelClient(fakePort(() => ({ turn: rawTurn({ status: "completed", completedAt: 100 }) }))).startTurn(
        validTurnInput()
      ),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexModelClient(fakePort(() => ({ turn: { ...rawTurn(), future: true } }))).startTurn(validTurnInput()),
      "invalid_protocol_message"
    );
  });

  it("keeps unavailable capability, disconnected runtime, and invalid bounds distinct", async () => {
    const unavailable = fakePort(() => undefined, compatibilityWithModelState("unavailable"));
    await expectAdapterError(createCodexModelClient(unavailable).listCatalog(), "unsupported_method");

    const disconnected = fakePort(() => undefined, disconnectedCompatibility());
    await expectAdapterError(createCodexModelClient(disconnected).listCatalog(), "handshake_failed");

    expect(() => createCodexModelClient(fakePort(() => undefined), { page_size: 2, max_entries: 1 })).toThrow(
      HostDeckCodexAdapterError
    );
  });
});

interface FakePort extends CodexModelRequestPort {
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

function compatibilityWithModelState(state: "unavailable" | "unknown"): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === "model" ? { ...capability, state, reason: "test capability state" } : capability
    )
  };
}

function disconnectedCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: checkedAt,
    handshake: { state: "not_attempted" }
  });
}

function rawModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "model-a",
    model: "runtime-a",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "Model A",
    description: "Model description",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Thorough" }
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
    defaultServiceTier: "fast",
    isDefault: false,
    ...overrides
  };
}

function rawResumeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    thread: rawThread(),
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

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "thread-a", turns: [], ...overrides };
}

function rawTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "turn-a",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 100,
    completedAt: null,
    durationMs: null,
    ...overrides
  };
}

function validTurnInput() {
  return {
    operation_id: "op_model_turn_0001",
    thread_id: "thread-a",
    text: "Continue.",
    runtime_model: "runtime-b",
    reasoning_effort: "low"
  } as const;
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
