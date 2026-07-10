import { describe, expect, it } from "vitest";
import { createCodexSemanticRecordingTransport } from "./codex-operation-semantics.smoke-support.js";
import { ScriptedCodexTransport } from "./testing.js";

describe("Codex operation semantic wire recorder", () => {
  it("correlates bidirectional requests while retaining only redacted shapes and safe tags", async () => {
    const inner = new ScriptedCodexTransport();
    const recording = createCodexSemanticRecordingTransport(inner);
    let deliveries = 0;
    recording.transport.subscribe((event) => {
      if (event.type === "message") deliveries += 1;
    });
    recording.transport.subscribe(() => undefined);
    await recording.transport.connect();

    await recording.transport.sendText(
      JSON.stringify({
        method: "turn/start",
        id: 41,
        params: {
          threadId: "private-thread-id",
          input: [{ type: "text", text: "private prompt body" }],
          cwd: "/private/project/path",
          model: "gpt-probe-model",
          approvalPolicy: "on-request"
        }
      })
    );
    inner.receive(
      JSON.stringify({
        id: 41,
        result: {
          turn: { id: "private-turn-id", status: "inProgress", items: [], error: null }
        }
      })
    );
    inner.receive(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "private-thread-id", turnId: "private-turn-id", delta: "private model output" }
      })
    );
    inner.receive(
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        id: "private-approval-id",
        params: {
          threadId: "private-thread-id",
          turnId: "private-turn-id",
          itemId: "private-item-id",
          command: "touch /private/project/path/marker",
          cwd: "/private/project/path",
          reason: "private reason"
        }
      })
    );
    await recording.transport.sendText(
      JSON.stringify({ id: "private-approval-id", result: { decision: "decline" } })
    );

    const snapshot = recording.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(deliveries).toBe(3);
    expect(snapshot.total_frames).toBe(5);
    expect(snapshot.malformed_frames).toBe(0);
    expect(serialized).not.toContain("private prompt body");
    expect(serialized).not.toContain("private model output");
    expect(serialized).not.toContain("private-thread-id");
    expect(serialized).not.toContain("private-turn-id");
    expect(serialized).not.toContain("private-approval-id");
    expect(serialized).not.toContain("/private/project/path");
    expect(serialized).not.toContain("private reason");
    expect(serialized).toContain("redacted_string");
    expect(snapshot.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "client_to_server",
          kind: "client_request",
          method: "turn/start",
          correlation: "client_request_1",
          tags: expect.objectContaining({ approvalPolicy: ["on-request"], model: ["gpt-probe-model"] })
        }),
        expect.objectContaining({
          direction: "server_to_client",
          kind: "client_response",
          method: "turn/start",
          correlation: "client_request_1",
          tags: expect.objectContaining({ status: ["inProgress"] })
        }),
        expect.objectContaining({
          direction: "server_to_client",
          kind: "server_request",
          method: "item/commandExecution/requestApproval",
          correlation: "server_request_1"
        }),
        expect.objectContaining({
          direction: "client_to_server",
          kind: "server_response",
          method: "item/commandExecution/requestApproval",
          correlation: "server_request_1",
          tags: expect.objectContaining({ decision: ["decline"] })
        })
      ])
    );
    expect(snapshot.timeline.some((entry) => entry.method === "item/agentMessage/delta")).toBe(false);
    expect(snapshot.aggregates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "item/agentMessage/delta", count: 1 })
      ])
    );
    recording.dispose();
  });

  it("bounds the significant timeline while aggregating every observed frame", async () => {
    const inner = new ScriptedCodexTransport();
    const recording = createCodexSemanticRecordingTransport(inner, { timeline_limit: 2 });
    await recording.transport.connect();

    for (let index = 0; index < 5; index += 1) {
      inner.receive(
        JSON.stringify({
          method: "turn/started",
          params: { threadId: `thread-${index}`, turn: { id: `turn-${index}`, status: "inProgress" } }
        })
      );
    }

    const snapshot = recording.snapshot();
    expect(snapshot).toMatchObject({ total_frames: 5, timeline_limit: 2, timeline_dropped: 3 });
    expect(snapshot.timeline).toHaveLength(2);
    expect(snapshot.aggregates).toEqual([expect.objectContaining({ method: "turn/started", count: 5 })]);
    recording.dispose();
  });

  it("records malformed frame size without retaining malformed content", async () => {
    const inner = new ScriptedCodexTransport();
    const recording = createCodexSemanticRecordingTransport(inner);
    await recording.transport.connect();
    inner.receive("not-json-private-content");

    const snapshot = recording.snapshot();
    expect(snapshot).toMatchObject({ total_frames: 1, malformed_frames: 1 });
    expect(snapshot.timeline[0]).toMatchObject({ kind: "invalid_json" });
    expect(JSON.stringify(snapshot)).not.toContain("not-json-private-content");
    recording.dispose();
  });

  it("rejects invalid timeline limits", () => {
    expect(() => createCodexSemanticRecordingTransport(new ScriptedCodexTransport(), { timeline_limit: 0 })).toThrow(
      "timeline_limit"
    );
  });
});
