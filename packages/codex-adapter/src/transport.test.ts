import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexTextTransport,
  type CodexTransportEvent,
  createCodexUnixWebSocketTransport
} from "./transport.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("Codex Unix WebSocket transport configuration", () => {
  it.each([
    null,
    {},
    { socket_path: "relative.sock" },
    { socket_path: "ws://127.0.0.1:4500" },
    { socket_path: "/tmp/hostdeck:bad.sock" },
    { socket_path: "/tmp/hostdeck%2fsocket.sock" },
    { socket_path: "/tmp/hostdeck\n.sock" },
    { socket_path: `/tmp/${"x".repeat(108)}` },
    { socket_path: "/tmp/hostdeck.sock", handshake_timeout_ms: 0 },
    { socket_path: "/tmp/hostdeck.sock", max_frame_bytes: 512 },
    { socket_path: "/tmp/hostdeck.sock", max_frame_bytes: 2_048, max_buffered_bytes: 1_024 },
    { socket_path: "/tmp/hostdeck.sock", heartbeat_interval_ms: 49 },
    { socket_path: "/tmp/hostdeck.sock", heartbeat_timeout_ms: 30_001 },
    { socket_path: "/tmp/hostdeck.sock", tcp_fallback: true }
  ])("rejects invalid or non-Unix transport config %#", (candidate) => {
    expectAdapterError(() => createCodexUnixWebSocketTransport(candidate), "invalid_transport_config");
  });
});

describe("Codex Unix WebSocket transport lifecycle", () => {
  it("connects only through the Unix socket, exchanges text, closes, and reconnects with a new generation", async () => {
    const server = await openUnixWebSocketServer();
    const transport = createCodexUnixWebSocketTransport({ socket_path: server.socketPath });
    const events: CodexTransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    server.webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(data.toString("utf8")));
    });

    await transport.connect();
    expect(transport.state).toBe("open");
    expect(transport.generation).toBe(1);
    const firstReply = waitForTransportEvent(transport, (event) => event.type === "message");
    await transport.sendText('{"id":1,"result":{}}');
    await expect(firstReply).resolves.toMatchObject({ type: "message", text: '{"id":1,"result":{}}', generation: 1 });
    await transport.close("🙂".repeat(100));
    expect(transport.state).toBe("closed");

    await transport.connect();
    expect(transport.generation).toBe(2);
    await transport.close("second close");
    expect(events.filter((event) => event.type === "open")).toHaveLength(2);
    expect(events.filter((event) => event.type === "close")).toHaveLength(2);
    expect(events.filter((event) => event.type === "close").every((event) => event.clean)).toBe(true);
  });

  it("rejects outbound frames above the configured bound before server delivery", async () => {
    const server = await openUnixWebSocketServer();
    const transport = createCodexUnixWebSocketTransport({ socket_path: server.socketPath, max_frame_bytes: 1_024 });
    let received = 0;
    server.webSocketServer.on("connection", (socket) => socket.on("message", () => (received += 1)));

    await transport.connect();
    await expectAdapterRejection(transport.sendText("x".repeat(1_025)), "transport_overloaded");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toBe(0);
    await transport.close("done");
  });

  it("closes when the app-server exceeds the inbound frame bound", async () => {
    const server = await openUnixWebSocketServer();
    const transport = createCodexUnixWebSocketTransport({ socket_path: server.socketPath, max_frame_bytes: 1_024 });
    const transportError = waitForTransportEvent(
      transport,
      (event) => event.type === "error" && event.error.code === "transport_closed"
    );
    const closed = waitForTransportEvent(transport, (event) => event.type === "close");
    server.webSocketServer.on("connection", (socket) => socket.send("x".repeat(1_025)));

    await transport.connect();
    await expect(transportError).resolves.toMatchObject({ type: "error", error: { code: "transport_closed" } });
    await expect(closed).resolves.toMatchObject({ type: "close", clean: false });
  });

  it("accepts exact-runtime-sized inbound messages within the default bound", async () => {
    const server = await openUnixWebSocketServer();
    const transport = createCodexUnixWebSocketTransport({
      socket_path: server.socketPath
    });
    const payload = "x".repeat(3_000_000);
    const message = waitForTransportEvent(
      transport,
      (event) => event.type === "message"
    );
    server.webSocketServer.on("connection", (socket) => socket.send(payload));

    await transport.connect();
    const received = await message;
    expect(received.type).toBe("message");
    if (received.type !== "message") {
      throw new Error("Expected the bounded payload as a text message.");
    }
    expect(received.text.length).toBe(payload.length);
    await transport.close("done");
  });

  it("reserves outbound bytes before concurrent writes can exceed the queue bound", async () => {
    const server = await openUnixWebSocketServer();
    const transport = createCodexUnixWebSocketTransport({
      socket_path: server.socketPath,
      max_frame_bytes: 1_024,
      max_buffered_bytes: 1_024
    });
    await transport.connect();

    const first = transport.sendText("x".repeat(700));
    await expectAdapterRejection(transport.sendText("y".repeat(700)), "transport_overloaded");
    await first;
    await transport.close("done");
  });

  it("terminates a half-open peer that misses the heartbeat deadline", async () => {
    const server = await openUnixWebSocketServer();
    server.webSocketServer.on("connection", (socket) => {
      (socket as unknown as { readonly _socket: Socket })._socket.pause();
    });
    const transport = createCodexUnixWebSocketTransport({
      socket_path: server.socketPath,
      heartbeat_interval_ms: 50,
      heartbeat_timeout_ms: 50
    });
    const heartbeatError = waitForTransportEvent(
      transport,
      (event) => event.type === "error" && event.error.code === "transport_closed"
    );
    const closed = waitForTransportEvent(transport, (event) => event.type === "close");

    await transport.connect();
    await expect(heartbeatError).resolves.toMatchObject({
      type: "error",
      error: { code: "transport_closed", message: "Codex heartbeat timed out." }
    });
    await expect(closed).resolves.toMatchObject({ type: "close", clean: false });
  });

  it("terminates on binary app-server frames", async () => {
    const server = await openUnixWebSocketServer();
    const transport = createCodexUnixWebSocketTransport({ socket_path: server.socketPath });
    const protocolError = waitForTransportEvent(
      transport,
      (event) => event.type === "error" && event.error.code === "protocol_violation"
    );
    const closed = waitForTransportEvent(transport, (event) => event.type === "close");
    server.webSocketServer.on("connection", (socket) => socket.send(Buffer.from([1, 2, 3]), { binary: true }));

    await transport.connect();
    await expect(protocolError).resolves.toMatchObject({ type: "error", error: { code: "protocol_violation" } });
    await expect(closed).resolves.toMatchObject({
      type: "close",
      clean: false
    });
  });

  it("bounds stalled handshakes and honors pre-aborted connection attempts", async () => {
    const socketPath = tempSocketPath();
    const server = createNetServer();
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await closeNodeServer(server);
    });
    const transport = createCodexUnixWebSocketTransport({ socket_path: socketPath, handshake_timeout_ms: 50 });

    await expectAdapterRejection(transport.connect(), "transport_connect_failed");
    const controller = new AbortController();
    controller.abort();
    await expectAdapterRejection(transport.connect(controller.signal), "transport_aborted");
  });
});

interface OpenUnixServer {
  readonly socketPath: string;
  readonly webSocketServer: WebSocketServer;
}

async function openUnixWebSocketServer(): Promise<OpenUnixServer> {
  const socketPath = tempSocketPath();
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(socketPath, resolve);
  });
  cleanup.push(async () => {
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await closeNodeServer(httpServer);
  });
  return { socketPath, webSocketServer };
}

function tempSocketPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-codex-ipc-"));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  return join(directory, "app-server.sock");
}

async function closeNodeServer(server: Server | ReturnType<typeof createNetServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
}

function waitForTransportEvent(
  transport: CodexTextTransport,
  predicate: (event: CodexTransportEvent) => boolean,
  timeoutMs = 2_000
): Promise<CodexTransportEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for Codex transport event."));
    }, timeoutMs);
    const unsubscribe = transport.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

function expectAdapterError(fn: () => unknown, code: HostDeckCodexAdapterError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect((error as HostDeckCodexAdapterError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}

async function expectAdapterRejection(promise: Promise<unknown>, code: HostDeckCodexAdapterError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect((error as HostDeckCodexAdapterError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
