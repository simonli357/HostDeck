import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codexModelContractLimits } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import type { CodexConnectionNotification } from "./connection.js";
import {
  createCodexEventNormalizer,
  HostDeckCodexEventNormalizationError,
  type NormalizedCodexEvent
} from "./event-normalizer.js";
import { decodeCodexInboundFrame } from "./protocol.js";

const capturedAt = "2026-07-10T18:00:00.000Z";
const threadA = "thread-normalizer-a";
const threadB = "thread-normalizer-b";
const turnA = "turn-normalizer-a";
const turnB = "turn-normalizer-b";

const requiredMethods = [
  "account/rateLimits/updated",
  "item/agentMessage/delta",
  "item/completed",
  "item/plan/delta",
  "item/started",
  "serverRequest/resolved",
  "thread/archived",
  "thread/goal/cleared",
  "thread/goal/updated",
  "thread/name/updated",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/plan/updated",
  "turn/started"
] as const;

const observedItemTypes = ["agentMessage", "commandExecution", "contextCompaction", "plan", "reasoning", "userMessage"] as const;

const observedParamFields = {
  "account/rateLimits/updated": ["rateLimits"],
  "item/agentMessage/delta": ["delta", "itemId", "threadId", "turnId"],
  "item/completed": ["completedAtMs", "item", "threadId", "turnId"],
  "item/plan/delta": ["delta", "itemId", "threadId", "turnId"],
  "item/started": ["item", "startedAtMs", "threadId", "turnId"],
  "serverRequest/resolved": ["requestId", "threadId"],
  "thread/archived": ["threadId"],
  "thread/goal/cleared": ["threadId"],
  "thread/goal/updated": ["goal", "threadId", "turnId"],
  "thread/name/updated": ["threadId", "threadName"],
  "thread/settings/updated": ["threadId", "threadSettings"],
  "thread/started": ["thread"],
  "thread/status/changed": ["status", "threadId"],
  "thread/tokenUsage/updated": ["threadId", "tokenUsage", "turnId"],
  "turn/completed": ["threadId", "turn"],
  "turn/started": ["threadId", "turn"]
} as const;

describe("exact Codex event normalizer", () => {
  it("uses the same model and effort bounds as catalog and control contracts", () => {
    const normalizer = createCodexEventNormalizer({ now: () => capturedAt });
    const model = "m".repeat(codexModelContractLimits.identityLength);
    const effort = "e".repeat(codexModelContractLimits.reasoningEffortLength);
    const settings = rawSettings(model, "plan");
    expect(
      normalizeEvent(
        normalizer.normalize(
          selected("thread/settings/updated", {
            threadId: threadA,
            threadSettings: {
              ...settings,
              effort,
              collaborationMode: {
                ...settings.collaborationMode,
                settings: { ...settings.collaborationMode.settings, reasoning_effort: effort }
              }
            }
          })
        )
      )
    ).toMatchObject({ model, effort, collaboration_mode: "plan" });

    const oversized = createCodexEventNormalizer({ now: () => capturedAt });
    expectNormalizationError(
      () =>
        oversized.normalize(
          selected("thread/settings/updated", {
            threadId: threadA,
            threadSettings: rawSettings(`${model}x`, "plan")
          })
        ),
      "malformed_required_event"
    );
  });

  it("normalizes every required method through one ordered thread lifecycle", () => {
    const normalizer = createCodexEventNormalizer({ now: () => capturedAt });
    const events: NormalizedCodexEvent[] = [];
    const emit = (method: string, params: unknown) => events.push(normalizeEvent(normalizer.normalize(selected(method, params))));

    emit("thread/started", { thread: rawThread(threadA, { type: "idle" }) });
    emit("thread/name/updated", { threadId: threadA, threadName: "normalizer-a" });
    emit("thread/goal/updated", {
      threadId: threadA,
      turnId: null,
      goal: rawGoal(threadA, 1_752_170_401, "paused")
    });
    emit("thread/goal/cleared", { threadId: threadA });
    emit("thread/settings/updated", { threadId: threadA, threadSettings: rawSettings("gpt-5.6-sol", "plan") });
    emit("thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: [] } });
    emit("turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") });
    emit("turn/plan/updated", {
      threadId: threadA,
      turnId: turnA,
      explanation: "Execute the exact event matrix.",
      plan: [{ step: "Normalize events", status: "inProgress" }]
    });

    emit("item/started", itemParams(threadA, turnA, rawUserMessage("item-user-a", "Inspect the selected event."), "started"));
    emit("item/completed", itemParams(threadA, turnA, rawUserMessage("item-user-a", "Inspect the selected event."), "completed"));
    emit("item/started", itemParams(threadA, turnA, { type: "plan", id: "item-plan-a", text: "" }, "started"));
    emit("item/plan/delta", { threadId: threadA, turnId: turnA, itemId: "item-plan-a", delta: "Normalize first." });
    emit("item/completed", itemParams(threadA, turnA, { type: "plan", id: "item-plan-a", text: "Normalize first." }, "completed"));
    emit(
      "item/started",
      itemParams(threadA, turnA, { type: "reasoning", id: "item-reasoning-a", summary: [], content: [] }, "started")
    );
    emit(
      "item/completed",
      itemParams(threadA, turnA, { type: "reasoning", id: "item-reasoning-a", summary: ["private"], content: ["private"] }, "completed")
    );
    emit(
      "item/started",
      itemParams(threadA, turnA, { type: "contextCompaction", id: "item-compaction-a" }, "started")
    );
    emit(
      "item/completed",
      itemParams(threadA, turnA, { type: "contextCompaction", id: "item-compaction-a" }, "completed")
    );
    emit("item/started", itemParams(threadA, turnA, rawCommand("item-command-a", "inProgress"), "started"));
    emit("serverRequest/resolved", { threadId: threadA, requestId: "approval-a" });
    emit("item/completed", itemParams(threadA, turnA, rawCommand("item-command-a", "declined"), "completed"));
    emit(
      "item/started",
      itemParams(threadA, turnA, { type: "agentMessage", id: "item-agent-a", text: "", phase: null, memoryCitation: null }, "started")
    );
    emit("item/agentMessage/delta", { threadId: threadA, turnId: turnA, itemId: "item-agent-a", delta: "Done." });
    emit(
      "item/completed",
      itemParams(
        threadA,
        turnA,
        { type: "agentMessage", id: "item-agent-a", text: "Done.", phase: "final_answer", memoryCitation: null },
        "completed"
      )
    );
    emit("thread/tokenUsage/updated", {
      threadId: threadA,
      turnId: turnA,
      tokenUsage: rawTokenUsage(120, 20)
    });
    emit("account/rateLimits/updated", { rateLimits: rawRateLimits() });
    emit("thread/status/changed", { threadId: threadA, status: { type: "idle" } });
    emit("turn/completed", { threadId: threadA, turn: rawTurn(turnA, "completed") });
    emit("thread/archived", { threadId: threadA });

    expect(new Set(events.map((event) => event.method))).toEqual(new Set(requiredMethods));
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.find((event) => event.method === "thread/settings/updated")).toMatchObject({
      model: "gpt-5.6-sol",
      collaboration_mode: "plan"
    });
    expect(events.find((event) => event.method === "item/plan/delta")).toMatchObject({
      category: "plan",
      delta: "Normalize first."
    });
    expect(events).toContainEqual(
      expect.objectContaining({ method: "item/completed", item: expect.objectContaining({ category: "compaction" }) })
    );
    expect(events.find((event) => event.method === "serverRequest/resolved")).toMatchObject({
      request_id: "string:approval-a"
    });
    expect(events.find((event) => event.method === "account/rateLimits/updated")).toMatchObject({
      scope: "runtime",
      primary: { used_percent: 25 }
    });
    expect(events.at(-1)).toMatchObject({ method: "thread/archived", codex_event_id: `thread:${threadA}:archived` });
  });

  it("keeps command and reasoning content out of normalized projection input", () => {
    const normalizer = activeTurnNormalizer(threadA, turnA);
    const command = normalizeEvent(
      normalizer.normalize(
        selected("item/started", itemParams(threadA, turnA, rawCommand("item-secret-command", "inProgress"), "started"))
      )
    );
    const reasoning = normalizeEvent(
      normalizer.normalize(
        selected(
          "item/started",
          itemParams(
            threadA,
            turnA,
            { type: "reasoning", id: "item-secret-reasoning", summary: ["secret summary"], content: ["secret content"] },
            "started"
          )
        )
      )
    );

    expect(command).toMatchObject({ item: { category: "command", content_state: "redacted", text: null } });
    expect(reasoning).toMatchObject({ item: { category: "reasoning", content_state: "redacted", text: null } });
    expect(JSON.stringify([command, reasoning])).not.toContain("secret-value");
    expect(JSON.stringify(reasoning)).not.toContain("secret summary");
    expect(JSON.stringify(reasoning)).not.toContain("secret content");
  });

  it("truncates oversized message content with an explicit limitation", () => {
    const normalizer = activeTurnNormalizer(threadA, turnA);
    normalizeEvent(
      normalizer.normalize(
        selected(
          "item/started",
          itemParams(
            threadA,
            turnA,
            { type: "agentMessage", id: "item-long-agent", text: "", phase: null, memoryCitation: null },
            "started"
          )
        )
      )
    );
    const delta = normalizeEvent(
      normalizer.normalize(
        selected("item/agentMessage/delta", {
          threadId: threadA,
          turnId: turnA,
          itemId: "item-long-agent",
          delta: "x".repeat(12_001)
        })
      )
    );

    expect(delta).toMatchObject({ content_state: "truncated", content_notice: expect.any(String) });
    if (delta.method !== "item/agentMessage/delta") throw new TypeError("Expected agent delta.");
    expect(delta.delta).toHaveLength(12_000);
  });

  it("isolates lifecycle state for two concurrent threads", () => {
    const normalizer = createCodexEventNormalizer({ now: () => capturedAt });
    normalizeEvent(normalizer.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") })));
    normalizeEvent(normalizer.normalize(selected("turn/started", { threadId: threadB, turn: rawTurn(turnB, "inProgress") })));
    normalizeEvent(
      normalizer.normalize(
        selected(
          "item/started",
          itemParams(threadA, turnA, { type: "agentMessage", id: "item-shared", text: "", phase: null, memoryCitation: null }, "started")
        )
      )
    );

    expectNormalizationError(
      () =>
        normalizer.normalize(
          selected("item/agentMessage/delta", { threadId: threadB, turnId: turnB, itemId: "item-shared", delta: "wrong" })
        ),
      "event_out_of_order"
    );
    expect(normalizer.failure).toBeInstanceOf(HostDeckCodexEventNormalizationError);
    expect(normalizer.tracked_thread_count).toBe(2);
  });

  it("rejects duplicate, late, overlapping, and malformed required events", () => {
    const duplicateTurn = createCodexEventNormalizer({ now: () => capturedAt });
    const started = selected("turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") });
    normalizeEvent(duplicateTurn.normalize(started));
    expectNormalizationError(() => duplicateTurn.normalize(started), "duplicate_event");

    const completedBeforeStart = createCodexEventNormalizer({ now: () => capturedAt });
    expectNormalizationError(
      () => completedBeforeStart.normalize(selected("turn/completed", { threadId: threadA, turn: rawTurn(turnA, "completed") })),
      "event_out_of_order"
    );

    const overlapping = activeTurnNormalizer(threadA, turnA);
    expectNormalizationError(
      () => overlapping.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn("turn-overlap", "inProgress") })),
      "event_out_of_order"
    );

    const malformedStatus = createCodexEventNormalizer({ now: () => capturedAt });
    expectNormalizationError(
      () =>
        malformedStatus.normalize(
          selected("thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: ["bad"] } })
        ),
      "malformed_required_event"
    );
    expectNormalizationError(
      () => malformedStatus.normalize(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } })),
      "normalizer_stopped"
    );

    const contradictorySettings = createCodexEventNormalizer({ now: () => capturedAt });
    const settings = rawSettings("gpt-5.6-sol", "plan");
    expectNormalizationError(
      () =>
        contradictorySettings.normalize(
          selected("thread/settings/updated", {
            threadId: threadA,
            threadSettings: {
              ...settings,
              collaborationMode: {
                ...settings.collaborationMode,
                settings: { ...settings.collaborationMode.settings, model: "different-model" }
              }
            }
          })
        ),
      "malformed_required_event"
    );

    const contradictoryEffort = createCodexEventNormalizer({ now: () => capturedAt });
    expectNormalizationError(
      () =>
        contradictoryEffort.normalize(
          selected("thread/settings/updated", {
            threadId: threadA,
            threadSettings: {
              ...settings,
              collaborationMode: {
                ...settings.collaborationMode,
                settings: { ...settings.collaborationMode.settings, reasoning_effort: "low" }
              }
            }
          })
        ),
      "malformed_required_event"
    );

    const malformedGoal = createCodexEventNormalizer({ now: () => capturedAt });
    expectNormalizationError(
      () =>
        malformedGoal.normalize(
          selected("thread/goal/updated", {
            threadId: threadA,
            turnId: null,
            goal: rawGoal(threadB, 1_752_170_401, "paused")
          })
        ),
      "malformed_required_event"
    );
  });

  it("strictly validates tool item shape before omitting sensitive content", () => {
    const valid = activeTurnNormalizer(threadA, turnA);
    const tool = normalizeEvent(
      valid.normalize(
        selected(
          "item/started",
          itemParams(
            threadA,
            turnA,
            {
              type: "mcpToolCall",
              id: "item-mcp-valid",
              server: "docs",
              tool: "search",
              status: "inProgress",
              arguments: { secret: "not-retained" },
              appContext: null,
              pluginId: null,
              result: null,
              error: null,
              durationMs: null
            },
            "started"
          )
        )
      )
    );
    expect(tool).toMatchObject({ item: { category: "tool", content_state: "redacted", text: null } });
    expect(JSON.stringify(tool)).not.toContain("not-retained");

    const malformed = activeTurnNormalizer(threadB, turnB);
    expectNormalizationError(
      () =>
        malformed.normalize(
          selected(
            "item/started",
            itemParams(
              threadB,
              turnB,
              { type: "mcpToolCall", id: "item-mcp-invalid", server: "docs", status: "inProgress" },
              "started"
            )
          )
        ),
      "malformed_required_event"
    );

    const missingOpaqueField = activeTurnNormalizer("thread-mcp-required", "turn-mcp-required");
    expectNormalizationError(
      () =>
        missingOpaqueField.normalize(
          selected(
            "item/started",
            itemParams(
              "thread-mcp-required",
              "turn-mcp-required",
              {
                type: "mcpToolCall",
                id: "item-mcp-missing-arguments",
                server: "docs",
                tool: "search",
                status: "inProgress",
                appContext: null,
                pluginId: null,
                result: null,
                error: null,
                durationMs: null
              },
              "started"
            )
          )
        ),
      "malformed_required_event"
    );
  });

  it("rejects item deltas outside lifecycle and cumulative usage regression", () => {
    const missingItem = activeTurnNormalizer(threadA, turnA);
    expectNormalizationError(
      () =>
        missingItem.normalize(
          selected("item/agentMessage/delta", { threadId: threadA, turnId: turnA, itemId: "item-missing", delta: "late" })
        ),
      "event_out_of_order"
    );

    const normalizer = activeTurnNormalizer(threadA, turnA);
    normalizeEvent(
      normalizer.normalize(
        selected("thread/tokenUsage/updated", { threadId: threadA, turnId: turnA, tokenUsage: rawTokenUsage(100, 10) })
      )
    );
    expectNormalizationError(
      () =>
        normalizer.normalize(
          selected("thread/tokenUsage/updated", { threadId: threadA, turnId: turnA, tokenUsage: rawTokenUsage(99, 11) })
        ),
      "event_out_of_order"
    );
  });

  it("fails stopped on clock regression and preserves terminal identity history at capacity", () => {
    const times = [capturedAt, "2026-07-10T17:59:59.999Z"];
    const regressingClock = createCodexEventNormalizer({ now: () => times.shift() ?? capturedAt });
    normalizeEvent(regressingClock.normalize(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } })));
    expectNormalizationError(
      () =>
        regressingClock.normalize(
          selected("thread/status/changed", { threadId: threadA, status: { type: "active", activeFlags: [] } })
        ),
      "invalid_clock"
    );

    const bounded = createCodexEventNormalizer({
      now: () => capturedAt,
      max_tracked_turns_per_thread: 1,
      max_tracked_items_per_thread: 1,
      max_resolved_requests_per_thread: 1
    });
    normalizeEvent(bounded.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") })));
    normalizeEvent(bounded.normalize(selected("turn/completed", { threadId: threadA, turn: rawTurn(turnA, "completed") })));
    expectNormalizationError(
      () => bounded.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn(turnB, "inProgress") })),
      "normalizer_capacity_exceeded"
    );

    const boundedItems = createCodexEventNormalizer({
      now: () => capturedAt,
      max_tracked_items_per_thread: 1
    });
    normalizeEvent(
      boundedItems.normalize(selected("turn/started", { threadId: threadA, turn: rawTurn(turnA, "inProgress") }))
    );
    normalizeEvent(
      boundedItems.normalize(
        selected("item/started", itemParams(threadA, turnA, { type: "plan", id: "item-capacity-a", text: "" }, "started"))
      )
    );
    normalizeEvent(
      boundedItems.normalize(
        selected(
          "item/completed",
          itemParams(threadA, turnA, { type: "plan", id: "item-capacity-a", text: "done" }, "completed")
        )
      )
    );
    expectNormalizationError(
      () =>
        boundedItems.normalize(
          selected("item/started", itemParams(threadA, turnA, { type: "plan", id: "item-capacity-b", text: "" }, "started"))
        ),
      "normalizer_capacity_exceeded"
    );

    const boundedRequests = createCodexEventNormalizer({
      now: () => capturedAt,
      max_resolved_requests_per_thread: 1
    });
    normalizeEvent(
      boundedRequests.normalize(selected("serverRequest/resolved", { threadId: threadA, requestId: "request-capacity-a" }))
    );
    expectNormalizationError(
      () => boundedRequests.normalize(selected("serverRequest/resolved", { threadId: threadA, requestId: "request-capacity-b" })),
      "normalizer_capacity_exceeded"
    );

    const boundedThreads = createCodexEventNormalizer({ now: () => capturedAt, max_tracked_threads: 1 });
    normalizeEvent(boundedThreads.normalize(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } })));
    expectNormalizationError(
      () => boundedThreads.normalize(selected("thread/status/changed", { threadId: threadB, status: { type: "idle" } })),
      "normalizer_capacity_exceeded"
    );
  });

  it("rejects successful completion with an active item, closes interrupted items, and rejects post-archive events", () => {
    const activeItem = activeTurnNormalizer(threadA, turnA);
    normalizeEvent(
      activeItem.normalize(
        selected(
          "item/started",
          itemParams(
            threadA,
            turnA,
            { type: "agentMessage", id: "item-still-active", text: "", phase: null, memoryCitation: null },
            "started"
          )
        )
      )
    );
    expectNormalizationError(
      () => activeItem.normalize(selected("turn/completed", { threadId: threadA, turn: rawTurn(turnA, "completed") })),
      "event_out_of_order"
    );

    const interruptedItem = activeTurnNormalizer(threadB, turnB);
    normalizeEvent(
      interruptedItem.normalize(
        selected("item/started", itemParams(threadB, turnB, rawCommand("item-interrupted-command", "inProgress"), "started"))
      )
    );
    expect(
      normalizeEvent(
        interruptedItem.normalize(selected("turn/completed", { threadId: threadB, turn: rawTurn(turnB, "interrupted") }))
      )
    ).toMatchObject({ method: "turn/completed", status: "interrupted" });
    expect(() => normalizeEvent(interruptedItem.normalize(selected("thread/archived", { threadId: threadB })))).not.toThrow();

    const archived = createCodexEventNormalizer({ now: () => capturedAt });
    normalizeEvent(archived.normalize(selected("thread/archived", { threadId: threadA })));
    expectNormalizationError(
      () =>
        archived.normalize(
          selected("thread/settings/updated", { threadId: threadA, threadSettings: rawSettings("gpt-5.6-sol", "default") })
        ),
      "event_out_of_order"
    );
  });

  it("accepts distinct same-second goal states but rejects an exact repeated goal", () => {
    const normalizer = createCodexEventNormalizer({ now: () => capturedAt });
    const paused = rawGoal(threadA, 1_752_170_401, "paused");
    const active = { ...paused, status: "active" as const, tokensUsed: 1 };
    const first = normalizeEvent(
      normalizer.normalize(selected("thread/goal/updated", { threadId: threadA, turnId: null, goal: paused }))
    );
    const second = normalizeEvent(
      normalizer.normalize(selected("thread/goal/updated", { threadId: threadA, turnId: null, goal: active }))
    );

    expect(first.codex_event_id).not.toBe(second.codex_event_id);
    expectNormalizationError(
      () => normalizer.normalize(selected("thread/goal/updated", { threadId: threadA, turnId: null, goal: active })),
      "duplicate_event"
    );
  });

  it("filters unmanaged TUI threads to bounded identity-only observations before payload normalization", () => {
    const normalizer = createCodexEventNormalizer({
      now: () => capturedAt,
      is_managed_thread: (threadId) => threadId === threadA
    });
    const unmanaged = normalizer.normalize(
      selected("turn/completed", {
        threadId: threadB,
        turn: { secret: "must-not-be-parsed-or-retained" }
      })
    );

    expect(unmanaged).toMatchObject({
      kind: "unmanaged",
      observation: {
        classification: "unmanaged_thread",
        thread_id: threadB,
        method: "turn/completed",
        total_count: 1
      }
    });
    expect(JSON.stringify(unmanaged)).not.toContain("must-not-be-parsed-or-retained");
    expect(normalizer.unmanaged_observation_count).toBe(1);
    expect(normalizer.failure).toBeNull();
    expect(() =>
      normalizeEvent(normalizer.normalize(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } })))
    ).not.toThrow();

    const brokenClassifier = createCodexEventNormalizer({
      now: () => capturedAt,
      is_managed_thread() {
        throw new Error("mapping read failed");
      }
    });
    expectNormalizationError(
      () => brokenClassifier.normalize(selected("thread/status/changed", { threadId: threadA, status: { type: "idle" } })),
      "thread_scope_resolution_failed"
    );

    const spoofedSelection = createCodexEventNormalizer({
      now: () => capturedAt,
      is_managed_thread: () => false
    });
    expectNormalizationError(
      () => spoofedSelection.normalize(selected("future/spoofed", { threadId: threadB, secret: "must-not-bypass" })),
      "unsupported_selected_event"
    );
  });

  it("bounds generated optional diagnostics without retaining payload content", () => {
    const normalizer = createCodexEventNormalizer({ now: () => capturedAt, max_optional_methods: 1 });
    const first = normalizer.normalize(optional("configWarning", { summary: "secret-config-content", details: null }));
    const second = normalizer.normalize(optional("configWarning", { summary: "different-secret", details: null }));
    const overflow = normalizer.normalize(optional("app/list/updated", { apps: ["secret-app"] }));

    expect(first).toMatchObject({ kind: "diagnostic", diagnostic: { method_count: 1, total_count: 1 } });
    expect(second).toMatchObject({ kind: "diagnostic", diagnostic: { method_count: 2, total_count: 2 } });
    expect(overflow).toMatchObject({
      kind: "diagnostic",
      diagnostic: { method_count: null, total_count: 3, tracked_method_count: 1, method_capacity_exhausted: true }
    });
    expect(JSON.stringify([first, second, overflow])).not.toContain("secret");
    expect(normalizer.optional_diagnostic_count).toBe(3);

    expectNormalizationError(
      () => normalizer.normalize({ ...optional("future/unknown", {}), classification: "unknown" }),
      "unknown_notification"
    );
  });

  it("treats deprecated thread/compacted as generated optional rather than compaction proof", () => {
    const decoded = decodeCodexInboundFrame(
      '{"method":"thread/compacted","params":{"threadId":"thread-normalizer-a","turnId":"turn-normalizer-a"}}'
    );
    expect(decoded).toMatchObject({ kind: "notification", method: "thread/compacted", classification: "generated_unhandled" });
    if (decoded.kind !== "notification") throw new TypeError("Expected notification.");
    const result = createCodexEventNormalizer({ now: () => capturedAt }).normalize(decoded);
    expect(result).toMatchObject({ kind: "diagnostic", diagnostic: { method: "thread/compacted" } });
    expect(codexBindingDescriptor.surface.server_notifications).not.toContain("thread/compacted");
  });

  it("matches required policy to the committed 612-frame observed method inventory", () => {
    const observed = new Set<string>();
    const observedItems = new Set<string>();
    const observedFields = new Map<string, Set<string>>();
    let frameCount = 0;
    for (const name of [
      "int-v1-006-goal-activation-observation.json",
      "int-v1-006-plan-approval-observation.json",
      "int-v1-006-control-observation.json"
    ]) {
      const report = JSON.parse(readFileSync(resolve("artifacts", name), "utf8")) as EvidenceReport;
      frameCount += report.wire.total_frames;
      for (const aggregate of report.wire.aggregates) {
        if (aggregate.kind !== "server_notification" || aggregate.method === null) continue;
        observed.add(aggregate.method);
        const params = aggregate.sample.shape.fields?.params?.fields ?? {};
        const fields = observedFields.get(aggregate.method) ?? new Set<string>();
        for (const field of Object.keys(params)) fields.add(field);
        observedFields.set(aggregate.method, fields);
        if (aggregate.method === "item/started" || aggregate.method === "item/completed") {
          for (const type of aggregate.sample.tags.type ?? []) {
            if ((observedItemTypes as readonly string[]).includes(type)) observedItems.add(type);
          }
        }
      }
    }

    expect(frameCount).toBe(612);
    expect(requiredMethods.filter((method) => !observed.has(method))).toEqual(["turn/plan/updated"]);
    for (const [method, fields] of Object.entries(observedParamFields)) {
      expect([...observedFields.get(method) ?? []].sort(), method).toEqual([...fields].sort());
    }
    expect([...observedItems].sort()).toEqual([...observedItemTypes].sort());
    expect([...codexBindingDescriptor.surface.server_notifications].sort()).toEqual([...requiredMethods].sort());
  });
});

interface EvidenceReport {
  readonly wire: {
    readonly total_frames: number;
    readonly aggregates: readonly {
      readonly kind: string;
      readonly method: string | null;
      readonly sample: {
        readonly tags: Readonly<Record<string, readonly string[]>>;
        readonly shape: EvidenceShape;
      };
    }[];
  };
}

interface EvidenceShape {
  readonly fields?: Readonly<Record<string, EvidenceShape>>;
}

function activeTurnNormalizer(threadId: string, turnId: string) {
  const normalizer = createCodexEventNormalizer({ now: () => capturedAt });
  normalizeEvent(normalizer.normalize(selected("turn/started", { threadId, turn: rawTurn(turnId, "inProgress") })));
  return normalizer;
}

function selected(method: string, params: unknown): CodexConnectionNotification {
  return { kind: "notification", method, params, classification: "selected" };
}

function optional(method: string, params: unknown): CodexConnectionNotification {
  return { kind: "notification", method, params, classification: "generated_unhandled" };
}

function normalizeEvent(result: ReturnType<ReturnType<typeof createCodexEventNormalizer>["normalize"]>): NormalizedCodexEvent {
  if (result.kind !== "event") throw new TypeError(`Expected normalized event, received ${result.kind}.`);
  return result.event;
}

function rawThread(threadId: string, status: unknown) {
  return {
    id: threadId,
    extra: null,
    sessionId: `session-${threadId}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1_752_170_400,
    updatedAt: 1_752_170_401,
    recencyAt: 1_752_170_401,
    status,
    path: "/tmp/codex-thread.jsonl",
    cwd: "/tmp/hostdeck-normalizer",
    cliVersion: "0.144.0",
    source: "vscode",
    threadSource: "hostdeck",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: []
  };
}

function rawSettings(model: string, mode: "default" | "plan") {
  return {
    cwd: "/tmp/hostdeck-normalizer",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    model,
    modelProvider: "openai",
    serviceTier: null,
    effort: "medium",
    summary: null,
    collaborationMode: {
      mode,
      settings: { model, reasoning_effort: "medium", developer_instructions: null }
    },
    multiAgentMode: "explicitRequestOnly",
    personality: null
  };
}

function rawGoal(threadId: string, updatedAt: number, status: string) {
  return {
    threadId,
    objective: "Prove exact event normalization.",
    status,
    tokenBudget: 1_000,
    tokensUsed: 10,
    timeUsedSeconds: 1,
    createdAt: 1_752_170_400,
    updatedAt
  };
}

function rawTurn(turnId: string, status: "completed" | "failed" | "inProgress" | "interrupted") {
  return {
    id: turnId,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "Turn failed.", codexErrorInfo: null, additionalDetails: null } : null,
    startedAt: 1_752_170_402,
    completedAt: status === "inProgress" ? null : 1_752_170_403,
    durationMs: status === "inProgress" ? null : 1_000
  };
}

function rawUserMessage(itemId: string, text: string) {
  return {
    type: "userMessage",
    id: itemId,
    clientId: `client-${itemId}`,
    content: [{ type: "text", text, text_elements: [] }]
  };
}

function rawCommand(itemId: string, status: "completed" | "declined" | "failed" | "inProgress") {
  return {
    type: "commandExecution",
    id: itemId,
    command: "printf secret-value",
    cwd: "/tmp/hostdeck-normalizer",
    processId: status === "inProgress" ? "process-a" : null,
    source: "agent",
    status,
    commandActions: [{ type: "unknown", command: "printf secret-value" }],
    aggregatedOutput: status === "completed" ? "secret-value" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "inProgress" ? null : 10
  };
}

function itemParams(threadId: string, turnId: string, item: unknown, lifecycle: "completed" | "started") {
  return lifecycle === "started"
    ? { item, threadId, turnId, startedAtMs: 1_752_170_402_000 }
    : { item, threadId, turnId, completedAtMs: 1_752_170_403_000 };
}

function rawTokenUsage(totalTokens: number, lastTokens: number) {
  return {
    total: tokenBreakdown(totalTokens),
    last: tokenBreakdown(lastTokens),
    modelContextWindow: 200_000
  };
}

function tokenBreakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: Math.floor(totalTokens / 2),
    cachedInputTokens: 0,
    outputTokens: totalTokens - Math.floor(totalTokens / 2),
    reasoningOutputTokens: 0
  };
}

function rawRateLimits() {
  return {
    limitId: "limit-a",
    limitName: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_752_170_800 },
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null
  };
}

function expectNormalizationError(fn: () => unknown, code: HostDeckCodexEventNormalizationError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexEventNormalizationError);
    expect((error as HostDeckCodexEventNormalizationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostDeckCodexEventNormalizationError ${code}.`);
}
