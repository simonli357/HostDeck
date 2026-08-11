import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexTextTransport,
  type CodexTransportEvent,
  createCodexLocalWebSocketTransport
} from "./transport.js";
import {
  codexRemoteAuthEnvironmentVariable,
  createCodexUnixSocketEndpoint,
  parseCodexLocalEndpoint
} from "./transport-endpoint.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("cross-platform Codex transport native contract", () => {
  it("parses both endpoint families identically on every supported host", () => {
    expect(
      parseCodexLocalEndpoint({
        schema_version: 1,
        target: "linux-x64",
        kind: "unix_socket",
        address: "unix:///tmp/hostdeck-native-contract.sock",
        credential_source: "none"
      })
    ).toMatchObject({ target: "linux-x64", kind: "unix_socket" });
    expect(
      parseCodexLocalEndpoint({
        schema_version: 1,
        target: "windows-x64",
        kind: "authenticated_loopback_websocket",
        address: "ws://127.0.0.1:43871",
        port_allocation: "ephemeral_random",
        credential_source: "protected_environment"
      })
    ).toMatchObject({
      target: "windows-x64",
      kind: "authenticated_loopback_websocket"
    });
    expect(() =>
      parseCodexLocalEndpoint({
        schema_version: 1,
        target: "windows-x64",
        kind: "authenticated_loopback_websocket",
        address: "ws://localhost:43871",
        port_allocation: "ephemeral_random",
        credential_source: "protected_environment"
      })
    ).toThrow(HostDeckCodexAdapterError);
  });

  it("exchanges bounded text through only the native endpoint family", async () => {
    expect(process.arch).toBe("x64");
    if (process.platform === "linux") {
      assertOppositeTargetRejectedOnLinux();
      await verifyNativeUnixTransport();
      return;
    }
    if (process.platform === "win32") {
      assertOppositeTargetRejectedOnWindows();
      await verifyNativeAuthenticatedLoopbackTransport();
      return;
    }
    throw new Error("Codex native transport contract ran on an unsupported host.");
  });
});

function assertOppositeTargetRejectedOnLinux(): void {
  let credentialReads = 0;
  expect(() =>
    createCodexLocalWebSocketTransport({
      host_target: "windows-x64",
      endpoint: {
        schema_version: 1,
        target: "windows-x64",
        kind: "authenticated_loopback_websocket",
        address: "ws://127.0.0.1:43871",
        port_allocation: "ephemeral_random",
        credential_source: "protected_environment"
      },
      credential: {
        kind: "protected_environment",
        environment_variable: codexRemoteAuthEnvironmentVariable,
        read: () => {
          credentialReads += 1;
          return "A".repeat(64);
        }
      }
    })
  ).toThrow(HostDeckCodexAdapterError);
  expect(credentialReads).toBe(0);
}

function assertOppositeTargetRejectedOnWindows(): void {
  expect(() =>
    createCodexLocalWebSocketTransport({
      host_target: "linux-x64",
      endpoint: createCodexUnixSocketEndpoint(
        "/tmp/hostdeck-wrong-native-target.sock"
      )
    })
  ).toThrow(HostDeckCodexAdapterError);
}

async function verifyNativeUnixTransport(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-native-transport-"));
  const socketPath = join(directory, "codex.sock");
  const server = createServer();
  const webSocketServer = new WebSocketServer({
    server,
    perMessageDeflate: false
  });
  let authorizationHeader: string | undefined;
  webSocketServer.on("connection", (socket, request) => {
    authorizationHeader = request.headers.authorization;
    socket.on("message", (data) => socket.send(data.toString("utf8")));
  });
  await listen(server, socketPath);
  cleanup.push(async () => {
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    rmSync(directory, { force: true, recursive: true });
  });

  const transport = createCodexLocalWebSocketTransport({
    host_target: "linux-x64",
    endpoint: createCodexUnixSocketEndpoint(socketPath)
  });
  await assertTextExchange(transport);
  expect(authorizationHeader).toBeUndefined();
}

async function verifyNativeAuthenticatedLoopbackTransport(): Promise<void> {
  const acceptedCredential = "A".repeat(64);
  const rejectedCredential = "B".repeat(64);
  const server = createServer();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false
  });
  let acceptedUpgrades = 0;
  let rejectedUpgrades = 0;
  let acceptedConnections = 0;
  let resolveSecondPeerClose: ((reason: string) => void) | undefined;
  const secondPeerClose = new Promise<string>((resolve) => {
    resolveSecondPeerClose = resolve;
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${acceptedCredential}`) {
      rejectedUpgrades += 1;
      rejectUpgrade(socket);
      return;
    }
    acceptedUpgrades += 1;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (socket) => {
    acceptedConnections += 1;
    socket.on("message", (data) => socket.send(data.toString("utf8")));
    if (acceptedConnections === 2) {
      socket.once("close", (_code, reason) => {
        resolveSecondPeerClose?.(reason.toString("utf8"));
      });
    }
  });
  await listen(server, 0, "127.0.0.1");
  cleanup.push(async () => {
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback server did not expose an IP address.");
  }
  expect(address.address).toBe("127.0.0.1");
  expect(address.port).toBeGreaterThanOrEqual(1_024);
  const endpoint = parseCodexLocalEndpoint({
    schema_version: 1,
    target: "windows-x64",
    kind: "authenticated_loopback_websocket",
    address: `ws://127.0.0.1:${address.port}`,
    port_allocation: "ephemeral_random",
    credential_source: "protected_environment"
  });
  if (endpoint.kind !== "authenticated_loopback_websocket") {
    throw new Error("Expected an authenticated loopback endpoint.");
  }

  const rejectedTransport = createCodexLocalWebSocketTransport({
    host_target: "windows-x64",
    endpoint,
    credential: {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => rejectedCredential
    }
  });
  const rejection = await captureAdapterRejection(rejectedTransport.connect());
  expect(rejection.code).toBe("transport_connect_failed");
  assertErrorDoesNotContain(rejection, acceptedCredential);
  assertErrorDoesNotContain(rejection, rejectedCredential);

  let credentialReads = 0;
  const transport = createCodexLocalWebSocketTransport({
    host_target: "windows-x64",
    endpoint,
    credential: {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: (name) => {
        credentialReads += 1;
        expect(name).toBe(codexRemoteAuthEnvironmentVariable);
        return acceptedCredential;
      }
    }
  });
  expect(credentialReads).toBe(1);
  await transport.connect();
  await assertEcho(transport, 1);
  const remoteClose = waitForTransportEvent(
    transport,
    (event) => event.type === "close"
  );
  const firstPeer = [...webSocketServer.clients][0];
  if (firstPeer === undefined) {
    throw new Error("Authenticated peer was not connected.");
  }
  firstPeer.close(4_000, `server close ${acceptedCredential}`);
  const remoteCloseEvent = await remoteClose;
  expect(remoteCloseEvent.type).toBe("close");
  if (remoteCloseEvent.type !== "close") {
    throw new Error("Expected a remote close event.");
  }
  expect(remoteCloseEvent.reason).toContain("[credential redacted]");
  expect(remoteCloseEvent.reason).not.toContain(acceptedCredential);

  await transport.connect();
  await assertEcho(transport, 2);
  await transport.close(`client close ${acceptedCredential}`);
  const peerCloseReason = await secondPeerClose;
  expect(peerCloseReason).toContain("[credential redacted]");
  expect(peerCloseReason).not.toContain(acceptedCredential);
  expect(credentialReads).toBe(1);
  expect(rejectedUpgrades).toBe(1);
  expect(acceptedUpgrades).toBe(2);
}

async function assertTextExchange(transport: CodexTextTransport): Promise<void> {
  await transport.connect();
  expect(transport.state).toBe("open");
  await assertEcho(transport, 1);
  await transport.close("native contract complete");
  expect(transport.state).toBe("closed");
}

async function assertEcho(
  transport: CodexTextTransport,
  generation: number
): Promise<void> {
  const message = waitForTransportEvent(
    transport,
    (event) => event.type === "message"
  );
  await transport.sendText('{"id":1,"result":{"native":true}}');
  await expect(message).resolves.toMatchObject({
    type: "message",
    generation,
    text: '{"id":1,"result":{"native":true}}'
  });
}

function waitForTransportEvent(
  transport: CodexTextTransport,
  predicate: (event: CodexTransportEvent) => boolean
): Promise<CodexTransportEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for native transport event."));
    }, 5_000);
    const unsubscribe = transport.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

async function listen(
  server: Server,
  endpoint: number | string,
  host?: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (typeof endpoint === "number") server.listen(endpoint, host, resolve);
    else server.listen(endpoint, resolve);
  });
}

function rejectUpgrade(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
  );
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function captureAdapterRejection(
  promise: Promise<unknown>
): Promise<HostDeckCodexAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    return error as HostDeckCodexAdapterError;
  }
  throw new Error("Expected HostDeckCodexAdapterError rejection.");
}

function assertErrorDoesNotContain(
  error: HostDeckCodexAdapterError,
  forbidden: string
): void {
  expect(error.message).not.toContain(forbidden);
  expect(error.stack ?? "").not.toContain(forbidden);
  expect(JSON.stringify(error)).not.toContain(forbidden);
}
