import { describe, expect, it } from "vitest";
import { type CodexAppServerConnection, createCodexAppServerConnection } from "./connection.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { ScriptedCodexTransport } from "./testing.js";

const checkedAt = "2026-07-09T22:00:00.000Z";

describe("Codex app-server connection handshake", () => {
  it("becomes ready only after initialize, initialized, and the required mode catalog", async () => {
    const transport = respondingTransport();
    const connection = createConnection(transport);

    await expect(connection.request({ method: "thread/list", params: {}, kind: "read" })).rejects.toMatchObject({
      code: "transport_not_open"
    });
    await expect(connection.connect()).resolves.toMatchObject({ state: "ready", mutation_policy: "allowed" });
    expect(connection.state).toBe("ready");
    expect(sentMethods(transport)).toEqual(["initialize", "initialized", "collaborationMode/list"]);

    const request = connection.request({ method: "thread/list", params: {}, kind: "read" });
    await expect(request).resolves.toEqual({ data: [] });
  });

  it("accepts a server notification that races the initialized send callback", async () => {
    const notifications: string[] = [];
    const transport = respondingTransport({
      on_initialized_send(current) {
        current.receive('{"method":"thread/started","params":{"thread":{"id":"thread-1"}}}');
      }
    });
    const connection = createCodexAppServerConnection({
      transport,
      observed_version: "0.144.0",
      now: () => checkedAt,
      handshake_timeout_ms: 1_000,
      on_notification: (message) => notifications.push(message.method)
    });

    await connection.connect();
    expect(connection.state).toBe("ready");
    expect(notifications).toEqual(["thread/started"]);
  });

  it("buffers ordered notifications emitted after initialize response and before initialized acknowledgement", async () => {
    const notifications: string[] = [];
    const transport = respondingTransport({
      after_initialize_response(current) {
        current.receive('{"method":"configWarning","params":{"summary":"bounded warning","details":null}}');
        current.receive('{"method":"remoteControl/status/changed","params":{"status":"disabled"}}');
      }
    });
    const connection = createCodexAppServerConnection({
      transport,
      observed_version: "0.144.0",
      now: () => checkedAt,
      handshake_timeout_ms: 1_000,
      on_notification: (message) => notifications.push(message.method)
    });

    await connection.connect();
    expect(connection.state).toBe("ready");
    expect(notifications).toEqual(["configWarning", "remoteControl/status/changed"]);
    expect(sentMethods(transport)).toEqual(["initialize", "initialized", "collaborationMode/list"]);
  });

  it("buffers a supported server request in the initialize response/ack window", async () => {
    const requests: string[] = [];
    const transport = respondingTransport({
      after_initialize_response(current) {
        current.receive(
          '{"method":"item/fileChange/requestApproval","id":"approval-1","params":{"threadId":"thread-1"}}'
        );
      }
    });
    const connection = createCodexAppServerConnection({
      transport,
      observed_version: "0.144.0",
      now: () => checkedAt,
      handshake_timeout_ms: 1_000,
      on_server_request: (message) => requests.push(`${message.id}:${message.method}`)
    });

    await connection.connect();
    expect(requests).toEqual(["approval-1:item/fileChange/requestApproval"]);
    expect(connection.pending_server_request_count).toBe(1);
    await connection.respondToServerRequest("approval-1", { decision: "decline" });
    expect(connection.pending_server_request_count).toBe(0);
  });

  it("fails closed when the initialize response/ack message queue is exceeded", async () => {
    const transport = respondingTransport({
      after_initialize_response(current) {
        current.receive('{"method":"configWarning","params":{"summary":"one","details":null}}');
        current.receive('{"method":"configWarning","params":{"summary":"two","details":null}}');
      }
    });
    const connection = createCodexAppServerConnection({
      transport,
      observed_version: "0.144.0",
      now: () => checkedAt,
      handshake_timeout_ms: 1_000,
      max_server_requests: 1
    });

    await expectAdapterError(connection.connect(), "transport_closed");
    expect(connection.state).toBe("disconnected");
    expect(transport.state).toBe("closed");
  });

  it("rejects malformed initialize results and closes the transport", async () => {
    const transport = respondingTransport({ initialize_result: { userAgent: "hostdeck/0.144.0" } });
    const connection = createConnection(transport);

    await expectAdapterError(connection.connect(), "handshake_failed");
    expect(connection.state).toBe("disconnected");
    expect(connection.compatibility).toMatchObject({ state: "disconnected", mutation_policy: "blocked" });
    expect(transport.state).toBe("closed");
  });

  it("preserves the close reason when transport dies after the initialize response", async () => {
    const transport = new ScriptedCodexTransport({
      on_send(text, current) {
        const message = JSON.parse(text) as { readonly id?: number; readonly method: string };
        if (message.method !== "initialize") return;
        current.receive(
          JSON.stringify({
            id: message.id,
            result: {
              userAgent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "linux"
            }
          })
        );
        current.disconnect("runtime exited after initialize");
      }
    });
    const connection = createConnection(transport);

    try {
      await connection.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
      expect(error).toMatchObject({
        code: "transport_closed",
        message: expect.stringContaining("runtime exited after initialize")
      });
      expect(connection.compatibility).toMatchObject({
        state: "disconnected",
        reason: expect.stringContaining("runtime exited after initialize")
      });
      return;
    }
    throw new Error("Expected handshake transport close.");
  });

  it("rejects missing Plan semantics as incompatible", async () => {
    const transport = respondingTransport({ modes: ["Default"] });
    const connection = createConnection(transport);

    await expectAdapterError(connection.connect(), "handshake_failed");
    expect(connection.state).toBe("incompatible");
    expect(connection.compatibility).toMatchObject({
      state: "incompatible",
      mutation_policy: "blocked",
      reason: "Required Plan collaboration semantics are unavailable."
    });
    expect(transport.state).toBe("closed");
  });

  it("blocks unsupported versions before opening the socket", async () => {
    const transport = respondingTransport();
    const connection = createConnection(transport, "0.145.0");

    await expectAdapterError(connection.connect(), "handshake_failed");
    expect(connection.state).toBe("incompatible");
    expect(transport.state).toBe("idle");
    expect(transport.sent_frames).toHaveLength(0);
  });

  it.each(["notification", "server_request", "unsupported_server_request"] as const)(
    "terminates when a %s arrives before initialized",
    async (scenario) => {
      const transport = new ScriptedCodexTransport({
        on_send(text, current) {
          const message = JSON.parse(text) as { readonly method: string };
          if (message.method !== "initialize") return;
          current.receive(
            scenario === "notification"
              ? '{"method":"turn/started","params":{}}'
              : scenario === "server_request"
                ? '{"method":"item/fileChange/requestApproval","id":"approval-1","params":{}}'
                : '{"method":"attestation/generate","id":"attestation-1","params":{}}'
          );
        }
      });
      const connection = createConnection(transport);

      await expect(connection.connect()).rejects.toBeInstanceOf(HostDeckCodexAdapterError);
      expect(connection.state).toBe("disconnected");
      expect(transport.state).toBe("closed");
    }
  );

  it("rejects concurrent or repeated connect attempts", async () => {
    let releaseInitialize: (() => void) | undefined;
    const transport = respondingTransport({
      before_initialize_response: () => new Promise<void>((resolve) => (releaseInitialize = resolve))
    });
    const connection = createConnection(transport);
    const first = connection.connect();
    await waitFor(() => connection.state === "handshaking");
    await expectAdapterError(connection.connect(), "transport_connect_failed");
    releaseInitialize?.();
    await first;
    await expectAdapterError(connection.connect(), "transport_connect_failed");
  });

  it("supports an explicit reconnect after disconnect with a new transport generation", async () => {
    const transport = respondingTransport();
    const connection = createConnection(transport);
    await connection.connect();
    expect(connection.generation).toBe(1);
    transport.disconnect("app-server restart");
    expect(connection.state).toBe("disconnected");
    expect(connection.compatibility).toMatchObject({ state: "disconnected", mutation_policy: "blocked" });

    await connection.connect();
    expect(connection.state).toBe("ready");
    expect(connection.generation).toBe(2);
  });

  it("reconnects a degraded connection without retrying an in-flight mutation", async () => {
    const transport = respondingTransport();
    const connection = createConnection(transport);
    await connection.connect();
    const mutation = connection.request({
      method: "turn/start",
      params: { threadId: "thread-1", input: [] },
      kind: "mutation"
    });
    transport.receive('{"method":"future/required","params":{}}');
    expect(connection.state).toBe("degraded");

    await expect(connection.reconnect()).resolves.toMatchObject({ state: "ready", mutation_policy: "allowed" });
    await expectAdapterError(mutation, "unknown_outcome");
    expect(connection.generation).toBe(2);
    expect(sentMethods(transport).filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("blocks writes when unknown protocol semantics degrade a ready connection", async () => {
    const transport = respondingTransport();
    const connection = createConnection(transport);
    await connection.connect();

    transport.receive('{"method":"future/required","params":{}}');
    expect(connection.state).toBe("degraded");
    expect(connection.compatibility).toMatchObject({
      state: "degraded",
      mutation_policy: "blocked",
      reason: expect.stringContaining("future/required")
    });
    await expect(connection.request({ method: "thread/list", params: {}, kind: "read" })).rejects.toMatchObject({
      code: "transport_not_open"
    });
  });

  it("reports a late retired response as degraded without making safe reads unavailable", async () => {
    const transport = respondingTransport();
    const connection = createConnection(transport);
    await connection.connect();

    await expectAdapterError(connection.request({ method: "model/list", params: {}, kind: "read", timeout_ms: 50 }), "request_timeout");
    transport.receive('{"id":3,"result":{"data":[]}}');
    expect(connection.state).toBe("degraded");
    expect(connection.compatibility).toMatchObject({ state: "degraded", mutation_policy: "allowed" });
    await expect(connection.request({ method: "thread/list", params: {}, kind: "read" })).resolves.toEqual({ data: [] });
  });

  it("aborts an active handshake when explicitly closed", async () => {
    const transport = new ScriptedCodexTransport();
    const connection = createConnection(transport);
    const connecting = connection.connect();
    await waitFor(() => connection.pending_request_count === 1);
    await connection.close("test shutdown");

    await expectAdapterError(connecting, "request_aborted");
    expect(connection.state).toBe("disconnected");
    expect(connection.pending_request_count).toBe(0);
    await expectAdapterError(connection.connect(), "broker_closed");
    await connection.close("repeated shutdown");
  });
});

interface RespondingTransportOptions {
  readonly initialize_result?: unknown;
  readonly modes?: readonly string[];
  readonly before_initialize_response?: () => Promise<void>;
  readonly after_initialize_response?: (transport: ScriptedCodexTransport) => void;
  readonly on_initialized_send?: (transport: ScriptedCodexTransport) => void;
}

function respondingTransport(options: RespondingTransportOptions = {}): ScriptedCodexTransport {
  return new ScriptedCodexTransport({
    async on_send(text, transport) {
      const message = JSON.parse(text) as { readonly id?: number; readonly method: string };
      if (message.method === "initialize") {
        await options.before_initialize_response?.();
        transport.receive(
          JSON.stringify({
            id: message.id,
            result:
              options.initialize_result ??
              {
                userAgent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
                codexHome: "/tmp/codex-home",
                platformFamily: "unix",
                platformOs: "linux"
              }
          })
        );
        options.after_initialize_response?.(transport);
      } else if (message.method === "collaborationMode/list") {
        transport.receive(
          JSON.stringify({
            id: message.id,
            result: { data: (options.modes ?? ["Plan", "Default"]).map((name) => ({ name })) }
          })
        );
      } else if (message.method === "initialized") {
        options.on_initialized_send?.(transport);
      } else if (message.method === "thread/list") {
        transport.receive(JSON.stringify({ id: message.id, result: { data: [] } }));
      }
    }
  });
}

function createConnection(transport: ScriptedCodexTransport, observedVersion = "0.144.0"): CodexAppServerConnection {
  return createCodexAppServerConnection({
    transport,
    observed_version: observedVersion,
    now: () => checkedAt,
    handshake_timeout_ms: 1_000
  });
}

function sentMethods(transport: ScriptedCodexTransport): readonly string[] {
  return transport.sent_frames.map((frame) => (JSON.parse(frame) as { readonly method: string }).method);
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for connection state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
