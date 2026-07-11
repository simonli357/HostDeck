import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  type ResourceBudget,
  resolveResourceBudget
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type HostDeckRoutePluginRegistration,
  hostDeckFastifyResourceSnapshot,
  hostDeckRequestDeadline
} from "./fastify-app.js";
import {
  type HostDeckFastifyLifecycle,
  startHostDeckFastifyLifecycle
} from "./fastify-host-lifecycle.js";

describe("real HostDeck HTTP resource limits", () => {
  it("rejects excess header count through HostDeck and excess header bytes through Node before handlers", async () => {
    const probe = await startProbe(headerBudget());
    try {
      const exact = await rawExchange(
        probe.port,
        requestWithHeaderCount(16),
        2_000
      );
      expect(statusCodes(exact.text)).toEqual([200]);
      expect(probe.handlerCalls).toBe(1);

      const overCount = await rawExchange(
        probe.port,
        requestWithHeaderCount(17),
        2_000
      );
      expect(statusCodes(overCount.text)).toEqual([431]);
      expect(overCount.text).toContain('"code":"malformed_request"');
      expect(overCount.text).toContain("x-request-id: req_");
      expect(overCount.text.toLowerCase()).toContain("connection: close");
      expect(probe.handlerCalls).toBe(1);
      expect(hostDeckFastifyResourceSnapshot(probe.service.app)).toMatchObject({
        in_flight_requests: 0,
        rejected_header_count_requests: 1
      });

      const exactBytes = await rawExchange(
        probe.port,
        requestWithNodeHeaderBytes(4_096),
        2_000
      );
      expect(statusCodes(exactBytes.text)).toEqual([200]);
      expect(probe.handlerCalls).toBe(2);

      const overBytes = await rawExchange(
        probe.port,
        requestWithNodeHeaderBytes(4_097),
        2_000
      );
      expect(statusCodes(overBytes.text)).toEqual([431]);
      expect(Buffer.byteLength(overBytes.text, "utf8")).toBeLessThan(1_024);
      expect(probe.handlerCalls).toBe(2);
      expect(probe.service.snapshot().node_limits).toMatchObject({
        headers_max_bytes: 4_096,
        headers_parser_max_bytes: 4_097
      });
      expect(probe.service.snapshot().connections.active_connections).toBe(0);
    } finally {
      await probe.service.close();
    }
  });

  it("times out incomplete headers and bodies natively without handler side effects or retained slots", async () => {
    const probe = await startProbe(slowReceiveBudget());
    try {
      const slowHeaders = await rawExchange(
        probe.port,
        "GET /probe HTTP/1.1\r\nHost: 127.0.0.1",
        3_500
      );
      expect(statusCodes(slowHeaders.text)).toEqual([408]);
      expect(slowHeaders.elapsed_ms).toBeGreaterThanOrEqual(900);
      expect(slowHeaders.elapsed_ms).toBeLessThan(3_200);
      expect(probe.handlerCalls).toBe(0);

      const slowBody = await rawExchange(
        probe.port,
        "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
        3_500
      );
      expect(statusCodes(slowBody.text)).toEqual([408]);
      expect(slowBody.elapsed_ms).toBeGreaterThanOrEqual(900);
      expect(slowBody.elapsed_ms).toBeLessThan(3_200);
      expect(probe.handlerCalls).toBe(0);
      await waitUntil(() => hostDeckFastifyResourceSnapshot(probe.service.app).in_flight_requests === 0);
      expect(probe.service.snapshot().connections.active_connections).toBe(0);
      const resources = hostDeckFastifyResourceSnapshot(probe.service.app);
      expect(resources.aborted_requests + resources.timed_out_requests).toBeGreaterThanOrEqual(1);
    } finally {
      await probe.service.close();
    }
  }, 10_000);

  it("enforces request-per-socket, exact keep-alive expiry, connection cap, and aborted-upload release", async () => {
    const probe = await startProbe(connectionBudget());
    const sockets = new Set<Socket>();
    try {
      const pipelined = await rawExchange(
        probe.port,
        "GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        2_000
      );
      expect(statusCodes(pipelined.text)).toEqual([200, 200, 503]);
      expect(probe.handlerCalls).toBe(2);
      expect(probe.service.snapshot().connections.dropped_requests).toBe(1);

      const keepAlive = await rawExchange(
        probe.port,
        "GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        2_500
      );
      expect(statusCodes(keepAlive.text)).toEqual([200]);
      expect(keepAlive.elapsed_ms).toBeGreaterThanOrEqual(900);
      expect(keepAlive.elapsed_ms).toBeLessThan(1_800);
      expect(probe.handlerCalls).toBe(3);

      const first = await connectSocket(probe.port);
      const second = await connectSocket(probe.port);
      sockets.add(first);
      sockets.add(second);
      await waitUntil(() => probe.service.snapshot().connections.active_connections === 2);
      const third = await connectSocket(probe.port);
      sockets.add(third);
      await waitForSocketClose(third, 1_000);
      sockets.delete(third);
      await waitUntil(() => probe.service.snapshot().connections.dropped_connections === 1);
      expect(probe.service.snapshot().connections.active_connections).toBe(2);
      first.destroy();
      second.destroy();
      sockets.delete(first);
      sockets.delete(second);
      await waitUntil(() => probe.service.snapshot().connections.active_connections === 0);

      const upload = await connectSocket(probe.port);
      sockets.add(upload);
      upload.write(
        "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"
      );
      await waitUntil(() => hostDeckFastifyResourceSnapshot(probe.service.app).in_flight_requests === 1);
      upload.destroy();
      sockets.delete(upload);
      await waitUntil(() => hostDeckFastifyResourceSnapshot(probe.service.app).in_flight_requests === 0);
      await waitUntil(() => probe.service.snapshot().connections.active_connections === 0);
      expect(hostDeckFastifyResourceSnapshot(probe.service.app).aborted_requests).toBe(1);
      expect(probe.handlerCalls).toBe(3);

      const idle = await connectSocket(probe.port);
      sockets.add(idle);
      const idleStartedAt = Date.now();
      expect(await collectUntilClose(idle, 7_000)).toBe("");
      sockets.delete(idle);
      const idleElapsedMs = Date.now() - idleStartedAt;
      expect(idleElapsedMs).toBeGreaterThanOrEqual(4_800);
      expect(idleElapsedMs).toBeLessThan(6_500);
      expect(probe.handlerCalls).toBe(3);
      await waitUntil(() => probe.service.snapshot().connections.active_connections === 0);
      expect(probe.service.snapshot().connections.active_connections).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await probe.service.close();
    }
  }, 15_000);

  it("applies a real handler deadline and retains its slot only until cooperative settlement", async () => {
    const release = deferred<void>();
    const probe = await startProbe(handlerDeadlineBudget(), { hangRelease: release.promise });
    try {
      const response = rawExchange(
        probe.port,
        "GET /hang HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        3_000
      );
      await waitUntil(() => probe.handlerCalls === 1);
      const terminal = await response;
      expect(statusCodes(terminal.text)).toEqual([504]);
      expect(terminal.text).toContain('"code":"operation_timeout"');
      expect(hostDeckFastifyResourceSnapshot(probe.service.app).in_flight_requests).toBe(1);
      release.resolve();
      await waitUntil(() => hostDeckFastifyResourceSnapshot(probe.service.app).in_flight_requests === 0);
    } finally {
      release.resolve();
      await probe.service.close();
    }
  }, 6_000);

  it("force-closes a partial upload after graceful drain, runs later owners, and restarts on the same port", async () => {
    const events: string[] = [];
    const budget = shutdownBudget();
    const port = await getAvailablePort();
    const first = await startProbe(budget, { events, port });
    const upload = await connectSocket(port);
    upload.write(
      "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"
    );
    await waitUntil(() => hostDeckFastifyResourceSnapshot(first.service.app).in_flight_requests === 1);

    const startedAt = Date.now();
    await first.service.close();
    expect(Date.now() - startedAt).toBeLessThan(900);
    await waitForSocketClose(upload, 1_000);
    expect(first.service.snapshot()).toMatchObject({
      connections: { active_connections: 0, forced_shutdown_connections: 1 },
      listening: false,
      phase: "closed"
    });
    expect(hostDeckFastifyResourceSnapshot(first.service.app)).toMatchObject({
      aborted_requests: 1,
      in_flight_requests: 0
    });
    expect(first.handlerCalls).toBe(0);
    expect(events).toEqual(["close-sse", "close-startup"]);
    expect(first.service.app.server.address()).toBeNull();
    expect(first.service.app.server.listening).toBe(false);

    const restarted = await startProbe(budget, { port });
    try {
      const response = await rawExchange(
        port,
        "GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        2_000
      );
      expect(statusCodes(response.text)).toEqual([200]);
    } finally {
      await restarted.service.close();
    }
    expect(restarted.service.snapshot().connections.active_connections).toBe(0);
    expect(restarted.service.app.server.address()).toBeNull();
    expect(restarted.service.app.server.listening).toBe(false);
  }, 6_000);
});

interface ProbeOptions {
  readonly events?: string[];
  readonly hangRelease?: Promise<void>;
  readonly port?: number;
}

interface Probe {
  readonly port: number;
  readonly service: HostDeckFastifyLifecycle<object>;
  readonly handlerCalls: number;
}

async function startProbe(budget: ResourceBudget, options: ProbeOptions = {}): Promise<Probe> {
  const port = options.port ?? (await getAvailablePort());
  let handlerCalls = 0;
  const service = await startHostDeckFastifyLifecycle({
    createRoutePlugins: () => [
      probeRoutes({
        incrementHandler() {
          handlerCalls += 1;
        },
        hangRelease: options.hangRelease
      })
    ],
    observeInternalError: () => undefined,
    resourceBudget: budget,
    runtime: {
      closeSse() {
        options.events?.push("close-sse");
      },
      closeStartup() {
        options.events?.push("close-startup");
      },
      start() {
        return {
          bind: { host: "127.0.0.1", port, transport: "http" },
          context: {}
        } as const;
      }
    }
  });
  return {
    port,
    service,
    get handlerCalls() {
      return handlerCalls;
    }
  };
}

function probeRoutes(state: {
  readonly hangRelease: Promise<void> | undefined;
  readonly incrementHandler: () => void;
}): HostDeckRoutePluginRegistration {
  return {
    id: "http-resource-probe",
    surface: "api",
    register(app) {
      app.get(
        "/probe",
        { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
        async () => {
          state.incrementHandler();
          return { ok: true as const };
        }
      );
      app.post(
        "/upload",
        {
          schema: {
            body: z.strictObject({ value: z.string().max(32) }),
            response: { 200: z.strictObject({ ok: z.literal(true) }) }
          }
        },
        async () => {
          state.incrementHandler();
          return { ok: true as const };
        }
      );
      app.get(
        "/hang",
        { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
        async (request) => {
          state.incrementHandler();
          const deadline = hostDeckRequestDeadline(request);
          if (state.hangRelease === undefined) return { ok: true as const };
          await new Promise<void>((resolve) => {
            if (deadline.signal.aborted) resolve();
            else deadline.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await state.hangRelease;
          return { ok: true as const };
        }
      );
    }
  };
}

function headerBudget(): ResourceBudget {
  return resolveResourceBudget({ http_headers_max_bytes: 4_096, http_headers_max_count: 16 });
}

function slowReceiveBudget(): ResourceBudget {
  return resolveResourceBudget({
    http_headers_timeout_ms: 1_000,
    http_request_deadline_ms: 3_000,
    http_request_receive_timeout_ms: 1_000,
    protocol_mutation_timeout_ms: 1_000,
    protocol_read_timeout_ms: 1_000,
    protocol_start_timeout_ms: 1_000
  });
}

function handlerDeadlineBudget(): ResourceBudget {
  return resolveResourceBudget({
    http_headers_timeout_ms: 1_000,
    http_request_deadline_ms: 2_000,
    http_request_receive_timeout_ms: 1_000,
    protocol_mutation_timeout_ms: 1_000,
    protocol_read_timeout_ms: 1_000,
    protocol_start_timeout_ms: 1_000
  });
}

function connectionBudget(): ResourceBudget {
  return resolveResourceBudget({
    http_connection_idle_timeout_ms: 5_000,
    http_keep_alive_timeout_ms: 1_000,
    http_max_connections: 2,
    http_max_requests_per_socket: 2,
    sse_heartbeat_interval_ms: 1_000,
    sse_max_subscribers: 1,
    sse_max_subscribers_per_device: 1,
    sse_max_subscribers_per_session: 1
  });
}

function shutdownBudget(): ResourceBudget {
  return resolveResourceBudget({
    lifecycle_cleanup_step_timeout_ms: 200,
    lifecycle_shutdown_timeout_ms: 1_000,
    protocol_close_timeout_ms: 1_000,
    sse_disconnect_cleanup_timeout_ms: 100,
    sse_shutdown_timeout_ms: 100
  });
}

function requestWithHeaderCount(count: number): string {
  const headers = ["Host: 127.0.0.1", "Connection: close"];
  while (headers.length < count) headers.push(`X-Probe-${headers.length}: value`);
  return `GET /probe HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`;
}

function requestWithNodeHeaderBytes(bytes: number): string {
  const host = "Host: 127.0.0.1";
  const connection = "Connection: close";
  const paddingPrefix = "X-Pad: ";
  const fixedBytes = [host, connection, paddingPrefix].reduce(
    (total, line) => total + Buffer.byteLength(line, "utf8"),
    0
  );
  if (!Number.isSafeInteger(bytes) || bytes < fixedBytes) throw new TypeError("Invalid Node header byte fixture size.");
  const headers = [host, connection, `${paddingPrefix}${"x".repeat(bytes - fixedBytes)}`];
  return `GET /probe HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`;
}

interface RawTranscript {
  readonly elapsed_ms: number;
  readonly text: string;
}

async function rawExchange(port: number, payload: string, timeoutMs: number): Promise<RawTranscript> {
  const socket = await connectSocket(port);
  const startedAt = Date.now();
  const completion = collectUntilClose(socket, timeoutMs);
  socket.write(payload);
  const text = await completion;
  return { elapsed_ms: Date.now() - startedAt, text };
}

function collectUntilClose(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Raw HTTP socket did not close within its test deadline."));
    }, timeoutMs);
    timeout.unref();
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 64 * 1_024) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error("Raw HTTP transcript exceeded its test bound."));
      }
    });
    socket.once("error", (error) => {
      if (settled) return;
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(output);
    });
  });
}

function statusCodes(transcript: string): number[] {
  return [...transcript.matchAll(/HTTP\/1\.1 (\d{3})/gu)].map((match) => Number(match[1]));
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForSocketClose(socket: Socket, timeoutMs: number): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Socket remained open beyond its test deadline."));
    }, timeoutMs);
    timeout.unref();
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function getAvailablePort(): Promise<number> {
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = createServer();
    candidate.once("error", reject);
    candidate.listen({ host: "127.0.0.1", port: 0 }, () => resolve(candidate));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected an allocated TCP port.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const expiresAt = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= expiresAt) throw new Error("HTTP resource condition did not settle within two seconds.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
