import { describe, expect, it, vi } from "vitest";
import { type CodexProtocolIssue, createCodexRequestBroker } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { ScriptedCodexTransport } from "./testing.js";

describe("Codex request broker correlation and bounds", () => {
  it("correlates out-of-order responses to monotonic request ids", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport);
    const first = broker.request({ method: "thread/list", params: { limit: 10 }, kind: "read" });
    const second = broker.request({ method: "model/list", params: {}, kind: "read" });
    expect(requestIds(transport)).toEqual([1, 2]);

    transport.receive('{"id":2,"result":{"data":["model-a"]}}');
    transport.receive('{"id":1,"result":{"data":["thread-a"]}}');
    await expect(first).resolves.toEqual({ data: ["thread-a"] });
    await expect(second).resolves.toEqual({ data: ["model-a"] });
    expect(broker.pending_request_count).toBe(0);
  });

  it("rejects excess in-flight requests without dispatching them", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport, { max_in_flight: 1 });
    const first = broker.request({ method: "thread/list", params: {}, kind: "read" });
    await expectBrokerError(broker.request({ method: "model/list", params: {}, kind: "read" }), "broker_overloaded", {
      outcome: "not_sent",
      retry_safe: true
    });
    expect(transport.sent_frames).toHaveLength(1);
    transport.receive('{"id":1,"result":{}}');
    await first;
  });

  it("returns invalid per-request deadlines as promise rejections", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport);
    let request: Promise<unknown> | undefined;
    expect(() => {
      request = broker.request({ method: "thread/list", params: {}, kind: "read", timeout_ms: 0 });
    }).not.toThrow();
    await expectBrokerError(request as Promise<unknown>, "protocol_violation", { outcome: "not_sent" });
  });

  it("accepts a final one-millisecond child deadline", async () => {
    vi.useFakeTimers();
    try {
      const transport = await openTransport();
      const broker = createCodexRequestBroker(transport);
      const timedOut = expectBrokerError(
        broker.request({ method: "thread/list", params: {}, kind: "read", timeout_ms: 1 }),
        "request_timeout",
        { outcome: "unknown", retry_safe: true }
      );
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
      expect(transport.sent_frames).toHaveLength(1);
      expect(broker.pending_request_count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans a synchronously rejected transport send without leaking pending ownership", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    Object.defineProperty(transport, "sendText", {
      configurable: true,
      value() {
        throw new HostDeckCodexAdapterError("transport_overloaded", "test queue full", {
          outcome: "not_sent",
          retry_safe: true
        });
      }
    });

    await expectBrokerError(
      broker.request({
        method: "thread/list",
        params: {},
        kind: "read",
        signal: controller.signal
      }),
      "transport_overloaded",
      { outcome: "not_sent", retry_safe: true }
    );
    expect(broker.pending_request_count).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("times out and aborts dispatched mutations with unknown non-retryable outcome", async () => {
    const transport = await openTransport();
    const issues: CodexProtocolIssue[] = [];
    const broker = createCodexRequestBroker(transport, { request_timeout_ms: 50, on_protocol_issue: (issue) => issues.push(issue) });

    await expectBrokerError(
      broker.request({ method: "turn/start", params: { threadId: "thread-1", input: [] }, kind: "mutation" }),
      "request_timeout",
      { outcome: "unknown", retry_safe: false }
    );

    const controller = new AbortController();
    const aborted = broker.request({
      method: "thread/archive",
      params: { threadId: "thread-1" },
      kind: "mutation",
      signal: controller.signal
    });
    controller.abort();
    await expectBrokerError(aborted, "request_aborted", { outcome: "unknown", retry_safe: false });
    transport.receive('{"id":2,"result":{}}');
    expect(issues).toContainEqual(expect.objectContaining({ severity: "degraded", code: "late_response" }));
    expect(transport.state).toBe("open");
  });

  it("classifies read and mutation outcomes conservatively on disconnect", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport);
    const read = broker.request({ method: "thread/list", params: {}, kind: "read" });
    const mutation = broker.request({ method: "turn/start", params: { threadId: "thread-1", input: [] }, kind: "mutation" });
    transport.disconnect("runtime restart");

    await expectBrokerError(read, "transport_closed", { outcome: "unknown", retry_safe: true });
    await expectBrokerError(mutation, "unknown_outcome", { outcome: "unknown", retry_safe: false });
    expect(broker.pending_request_count).toBe(0);
  });

  it("maps remote errors without claiming local success", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport);
    const request = broker.request({ method: "thread/list", params: {}, kind: "read" });
    transport.receive('{"id":1,"error":{"code":-32001,"message":"Server overloaded; retry later."}}');
    await expectBrokerError(request, "remote_error", { outcome: "remote_rejected", retry_safe: true, rpc_code: -32001 });
  });
});

describe("Codex request broker hostile inbound handling", () => {
  it("terminates the connection for malformed, unknown-id, or duplicate responses", async () => {
    for (const scenario of ["malformed", "unknown", "duplicate"] as const) {
      const transport = await openTransport();
      const issues: CodexProtocolIssue[] = [];
      const broker = createCodexRequestBroker(transport, { on_protocol_issue: (issue) => issues.push(issue) });
      if (scenario === "malformed") transport.receive("not-json");
      if (scenario === "unknown") transport.receive('{"id":99,"result":{}}');
      if (scenario === "duplicate") {
        const request = broker.request({ method: "thread/list", params: {}, kind: "read" });
        transport.receive('{"id":1,"result":{}}');
        await request;
        transport.receive('{"id":1,"result":{}}');
      }
      expect(transport.state).toBe("closed");
      expect(issues).toContainEqual(expect.objectContaining({ severity: "fatal", code: "protocol_violation" }));
    }
  });

  it("terminates a response that crosses transport generations", async () => {
    const transport = await openTransport();
    const issues: CodexProtocolIssue[] = [];
    const broker = createCodexRequestBroker(transport, { on_protocol_issue: (issue) => issues.push(issue) });
    const request = broker.request({ method: "thread/list", params: {}, kind: "read" });
    transport.receiveFromGeneration('{"id":1,"result":{}}', 0);

    await expectBrokerError(request, "transport_closed");
    expect(transport.state).toBe("closed");
    expect(issues).toContainEqual(expect.objectContaining({ severity: "fatal", code: "protocol_violation" }));
  });

  it.each([
    ["notification", '{"method":"turn/started","params":{}}'],
    ["server request", '{"method":"item/fileChange/requestApproval","id":"approval-stale","params":{}}']
  ])("rejects a stale-generation %s before application delivery", async (_label, frame) => {
    const transport = await openTransport();
    const notifications: string[] = [];
    const requests: string[] = [];
    const issues: CodexProtocolIssue[] = [];
    const broker = createCodexRequestBroker(transport, {
      on_notification: (message) => notifications.push(message.method),
      on_server_request: (message) => requests.push(message.method),
      on_protocol_issue: (issue) => issues.push(issue)
    });

    transport.receiveFromGeneration(frame, 0);

    expect(transport.state).toBe("closed");
    expect(notifications).toEqual([]);
    expect(requests).toEqual([]);
    expect(broker.pending_server_request_count).toBe(0);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "fatal", code: "protocol_violation" }));
  });

  it("routes generated notifications and reports truly unknown notifications", async () => {
    const transport = await openTransport();
    const notifications: string[] = [];
    const issues: CodexProtocolIssue[] = [];
    createCodexRequestBroker(transport, {
      on_notification: (message) => notifications.push(`${message.method}:${message.classification}`),
      on_protocol_issue: (issue) => issues.push(issue)
    });

    transport.receive('{"method":"turn/started","params":{}}');
    transport.receive('{"method":"account/updated","params":{}}');
    transport.receive('{"method":"future/required","params":{}}');
    expect(notifications).toEqual([
      "turn/started:selected",
      "account/updated:generated_unhandled",
      "future/required:unknown"
    ]);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "degraded", code: "unknown_notification" }));
    expect(transport.state).toBe("open");
  });

  it("tracks supported server requests until one exact response and rejects duplicates", async () => {
    const transport = await openTransport();
    const requests: Array<{ readonly id: number | string; readonly method: string }> = [];
    const issues: CodexProtocolIssue[] = [];
    const broker = createCodexRequestBroker(transport, {
      on_server_request: (message) => requests.push({ id: message.id, method: message.method }),
      on_protocol_issue: (issue) => issues.push(issue)
    });

    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-1","params":{}}');
    expect(requests).toEqual([{ id: "approval-1", method: "item/fileChange/requestApproval" }]);
    expect(broker.pending_server_request_count).toBe(1);
    const frameCountBeforeResponse = transport.sent_frames.length;
    await broker.respondToServerRequest("approval-1", { decision: "decline" });
    expect(transport.sent_frames).toHaveLength(frameCountBeforeResponse + 1);
    expect(JSON.parse(transport.sent_frames.at(-1) ?? "null")).toEqual({ id: "approval-1", result: { decision: "decline" } });
    expect(broker.pending_server_request_count).toBe(0);
    await expectBrokerError(Promise.resolve().then(() => broker.respondToServerRequest("approval-1", {})), "protocol_violation");

    transport.receive('{"method":"attestation/generate","id":7,"params":{}}');
    await waitFor(() => transport.sent_frames.some((frame) => frame.includes('"id":7')));
    expect(JSON.parse(transport.sent_frames.at(-1) ?? "null")).toMatchObject({ id: 7, error: { code: -32601 } });
    expect(issues).toContainEqual(expect.objectContaining({ severity: "degraded", code: "unsupported_server_request" }));
  });

  it("bounds unresolved supported server requests", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport, { max_server_requests: 1 });
    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-1","params":{}}');
    transport.receive('{"method":"item/commandExecution/requestApproval","id":"approval-2","params":{}}');
    await waitFor(() => transport.sent_frames.some((frame) => frame.includes('"approval-2"')));
    expect(broker.pending_server_request_count).toBe(1);
    expect(JSON.parse(transport.sent_frames.at(-1) ?? "null")).toMatchObject({ id: "approval-2", error: { code: -32001 } });
  });

  it("restores server-request ownership only when a response is provably not sent", async () => {
    let rejectWrite = true;
    const transport = new ScriptedCodexTransport({
      on_send(text) {
        const message = JSON.parse(text) as { readonly result?: unknown };
        if (message.result !== undefined && rejectWrite) {
          throw new HostDeckCodexAdapterError("transport_overloaded", "test queue full", {
            outcome: "not_sent",
            retry_safe: true
          });
        }
      }
    });
    await transport.connect();
    const broker = createCodexRequestBroker(transport);
    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-1","params":{}}');

    await expectBrokerError(broker.respondToServerRequest("approval-1", { decision: "decline" }), "transport_overloaded");
    expect(broker.pending_server_request_count).toBe(1);
    rejectWrite = false;
    await broker.respondToServerRequest("approval-1", { decision: "decline" });
    expect(broker.pending_server_request_count).toBe(0);
  });

  it("rejects a pre-aborted server response without sending and preserves one retry", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport);
    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-abort","params":{}}');
    const sentBefore = transport.sent_frames.length;
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));

    await expectBrokerError(
      broker.respondToServerRequest(
        "approval-abort",
        { decision: "decline" },
        { signal: controller.signal, timeout_ms: 50 }
      ),
      "request_aborted",
      { outcome: "not_sent", retry_safe: true }
    );
    expect(transport.sent_frames).toHaveLength(sentBefore);
    expect(broker.pending_server_request_count).toBe(1);

    await broker.respondToServerRequest("approval-abort", { decision: "decline" });
    expect(broker.pending_server_request_count).toBe(0);
  });

  it("bounds a possible server-response send and never permits a second decision", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    try {
      const transport = new ScriptedCodexTransport({
        async on_send(text) {
          const message = JSON.parse(text) as { readonly result?: unknown };
          if (message.result !== undefined) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        }
      });
      await transport.connect();
      const broker = createCodexRequestBroker(transport);
      transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-timeout","params":{}}');
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const timedOut = expectBrokerError(
        broker.respondToServerRequest(
          "approval-timeout",
          { decision: "decline" },
          { signal: controller.signal, timeout_ms: 5 }
        ),
        "request_timeout",
        { outcome: "unknown", retry_safe: false }
      );
      expect(release).toBeTypeOf("function");
      await vi.advanceTimersByTimeAsync(5);
      await timedOut;
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(broker.pending_server_request_count).toBe(0);
      await expectBrokerError(
        broker.respondToServerRequest("approval-timeout", { decision: "accept" }),
        "protocol_violation",
        { outcome: "not_sent" }
      );
      release?.();
      await Promise.resolve();
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it("normalizes a synchronous server-response send throw and restores only proven no-send state", async () => {
    const transport = await openTransport();
    const broker = createCodexRequestBroker(transport);
    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-sync","params":{}}');
    const sendText = transport.sendText.bind(transport);
    Object.defineProperty(transport, "sendText", {
      configurable: true,
      value() {
        throw new HostDeckCodexAdapterError("transport_overloaded", "test queue full", {
          outcome: "not_sent",
          retry_safe: true
        });
      }
    });

    await expectBrokerError(
      broker.respondToServerRequest("approval-sync", { decision: "decline" }, { timeout_ms: 50 }),
      "transport_overloaded",
      { outcome: "not_sent", retry_safe: true }
    );
    expect(broker.pending_server_request_count).toBe(1);
    Object.defineProperty(transport, "sendText", { configurable: true, value: sendText });
    await broker.respondToServerRequest("approval-sync", { decision: "decline" });
    expect(broker.pending_server_request_count).toBe(0);
  });

  it("prevents concurrent or repeated server responses when write outcome is unknown", async () => {
    let release: (() => void) | undefined;
    let mode: "pending" | "unknown" = "pending";
    const transport = new ScriptedCodexTransport({
      async on_send(text) {
        const message = JSON.parse(text) as { readonly result?: unknown };
        if (message.result === undefined) return;
        if (mode === "pending") await new Promise<void>((resolve) => (release = resolve));
        else {
          throw new HostDeckCodexAdapterError("transport_send_failed", "test write outcome unknown", {
            outcome: "unknown",
            retry_safe: false
          });
        }
      }
    });
    await transport.connect();
    const broker = createCodexRequestBroker(transport);
    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-1","params":{}}');
    const first = broker.respondToServerRequest("approval-1", { decision: "decline" });
    await waitFor(() => release !== undefined);
    await expectBrokerError(broker.respondToServerRequest("approval-1", { decision: "accept" }), "protocol_violation");
    release?.();
    await first;

    transport.receive('{"method":"item/fileChange/requestApproval","id":"approval-2","params":{}}');
    mode = "unknown";
    await expectBrokerError(broker.respondToServerRequest("approval-2", { decision: "decline" }), "transport_send_failed");
    expect(broker.pending_server_request_count).toBe(0);
    await expectBrokerError(broker.respondToServerRequest("approval-2", { decision: "decline" }), "protocol_violation");
  });
});

async function openTransport(): Promise<ScriptedCodexTransport> {
  const transport = new ScriptedCodexTransport();
  await transport.connect();
  return transport;
}

function requestIds(transport: ScriptedCodexTransport): readonly number[] {
  return transport.sent_frames.map((frame) => (JSON.parse(frame) as { readonly id: number }).id);
}

async function expectBrokerError(
  promise: Promise<unknown>,
  code: HostDeckCodexAdapterError["code"],
  expected: Partial<HostDeckCodexAdapterError> = {}
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code, ...expected });
    return;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for broker side effect.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
