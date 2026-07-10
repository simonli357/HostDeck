import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type ClientRequest, get as httpGet, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fastifySSE } from "@fastify/sse";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
  type FastifyTypeProvider
} from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

interface ProbeZodTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends z.ZodType ? z.output<this["schema"]> : unknown;
  serializer: this["schema"] extends z.ZodType ? z.input<this["schema"]> : unknown;
}

describe("IFC-V1-016 Fastify stack probes", () => {
  it("uses one Zod schema for typed request parsing, response validation, and bounded stable errors", async () => {
    const app = Fastify({
      bodyLimit: 128,
      connectionTimeout: 1_000,
      keepAliveTimeout: 1_000,
      requestTimeout: 1_000,
      trustProxy: false
    });
    app.setValidatorCompiler(({ schema }) => {
      const zodSchema = requireZodSchema(schema);
      return (data) => {
        const result = zodSchema.safeParse(data);
        return result.success
          ? { value: result.data }
          : {
              error: Object.assign(new Error("Request failed validation"), {
                cause: result.error,
                code: "HOSTDECK_INVALID_REQUEST",
                statusCode: 400
              })
            };
      };
    });
    app.setSerializerCompiler(({ schema }) => {
      const zodSchema = requireZodSchema(schema);
      return (data) => JSON.stringify(zodSchema.parse(data));
    });
    app.setNotFoundHandler((_request, reply) => {
      return reply.code(404).send(stableError("not_found", "Route not found"));
    });
    app.setErrorHandler((error, _request, reply) => {
      const fastifyError = error as Partial<FastifyError>;
      if (fastifyError.code === "HOSTDECK_INVALID_REQUEST") {
        return reply.code(400).send(stableError("invalid_request", "Request failed validation"));
      }
      if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.code(413).send(stableError("request_too_large", "Request body exceeds its limit"));
      }
      return reply.code(500).send(stableError("internal_error", "Internal server error"));
    });

    const typedApp = app.withTypeProvider<ProbeZodTypeProvider>();
    typedApp.post(
      "/echo",
      {
        schema: {
          body: z.strictObject({ value: z.string().trim().min(1).max(32) }),
          response: { 200: z.strictObject({ value: z.string().max(32) }) }
        }
      },
      async (request) => ({ value: request.body.value })
    );
    typedApp.get(
      "/broken-response",
      {
        schema: { response: { 200: z.strictObject({ value: z.string() }) } }
      },
      async () => ({ value: 42 as unknown as string })
    );

    try {
      const valid = await app.inject({ method: "POST", url: "/echo", payload: { value: "  ok  " } });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ value: "ok" });

      const invalid = await app.inject({
        method: "POST",
        url: "/echo",
        payload: { value: "", unexpected: "not allowed" }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual(stableError("invalid_request", "Request failed validation"));

      const oversized = await app.inject({
        method: "POST",
        url: "/echo",
        payload: { value: "x".repeat(256) }
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toEqual(
        stableError("request_too_large", "Request body exceeds its limit")
      );

      const broken = await app.inject({ method: "GET", url: "/broken-response" });
      expect(broken.statusCode).toBe(500);
      expect(broken.json()).toEqual(stableError("internal_error", "Internal server error"));
      expect(broken.body).not.toContain("broken-response");
      expect(broken.body).not.toContain("ZodError");

      const missing = await app.inject({ method: "GET", url: "/missing" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual(stableError("not_found", "Route not found"));
    } finally {
      await app.close();
    }
  });

  it("runs close hooks once when close is repeated", async () => {
    const app = Fastify();
    let closeCount = 0;
    app.addHook("onClose", async () => {
      closeCount += 1;
    });
    await app.ready();

    await app.close();
    await app.close();

    expect(closeCount).toBe(1);
    expect(app.addresses()).toEqual([]);
  });

  it("enforces SSE-only negotiation and exposes Last-Event-ID replay input", async () => {
    const app = Fastify();
    await app.register(fastifySSE, { heartbeatInterval: 10 });
    let replayCursor: string | null = null;
    app.get("/events", { sse: "only" }, async (_request, reply) => {
      await reply.sse.replay(async (lastEventId) => {
        replayCursor = lastEventId;
        if (lastEventId) {
          await reply.sse.send({ id: "cursor-2", event: "replay", data: { after: lastEventId } });
        }
      });
      await reply.sse.send({ id: "cursor-3", event: "live", data: { ready: true } });
    });

    try {
      const rejected = await app.inject({
        method: "GET",
        url: "/events",
        headers: { accept: "application/json" }
      });
      expect(rejected.statusCode).toBe(406);

      const streamed = await app.inject({
        method: "GET",
        url: "/events",
        headers: { accept: "text/event-stream", "last-event-id": "cursor-1" }
      });
      expect(streamed.statusCode).toBe(200);
      expect(streamed.headers["content-type"]).toBe("text/event-stream");
      expect(replayCursor).toBe("cursor-1");
      expect(streamed.body).toContain("id: cursor-2");
      expect(streamed.body).toContain('data: {"after":"cursor-1"}');
      expect(streamed.body).toContain("id: cursor-3");

      const wildcard = await app.inject({ method: "GET", url: "/events" });
      expect(wildcard.statusCode).toBe(200);
      expect(wildcard.headers["content-type"]).toBe("text/event-stream");
    } finally {
      await app.close();
    }
  });

  it("emits heartbeats after SSE commitment and closes finite keep-alive streams", async () => {
    const app = Fastify();
    await app.register(fastifySSE, { heartbeatInterval: 10 });
    app.get("/heartbeat", { sse: "only" }, async (_request, reply) => {
      reply.sse.keepAlive();
      await reply.sse.send({ id: "start", data: "ready" });
      await wait(35);
      reply.sse.close();
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/heartbeat",
        headers: { accept: "text/event-stream" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("id: start");
      expect(response.body).toContain(": heartbeat");
    } finally {
      await app.close();
    }
  });

  it("stops the selected Readable-backed SSE source under real slow-client backpressure", async () => {
    const app = Fastify();
    await app.register(fastifySSE, { heartbeatInterval: 10_000 });
    const disconnected = deferred<void>();
    const handlerSettled = deferred<void>();
    const disconnectController = new AbortController();
    let produced = 0;
    let sourceFinalized = false;
    let sourceObservedAbort = false;
    app.get("/pressure", { sse: "only" }, async (_request, reply) => {
      reply.sse.onClose(() => {
        disconnectController.abort(new Error("SSE client disconnected"));
        disconnected.resolve();
      });
      async function* source() {
        try {
          while (!disconnectController.signal.aborted && produced < 512) {
            produced += 1;
            yield { id: String(produced), data: "x".repeat(64 * 1024) };
          }
        } finally {
          sourceObservedAbort = disconnectController.signal.aborted;
          sourceFinalized = true;
        }
      }
      try {
        // The plugin's direct AsyncIterable path does not settle a backpressured write on close.
        await reply.sse.send(Readable.from(source(), { objectMode: true }));
      } catch (error) {
        if (reply.sse.isConnected) throw error;
      } finally {
        handlerSettled.resolve();
      }
    });

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    try {
      ({ request, response } = await openPausedResponse(`${address}/pressure`));
      await wait(30);
      response.destroy();
      request.destroy();
      await withTimeout(disconnected.promise, 1_000, "SSE disconnect cleanup");
      await withTimeout(waitUntil(() => sourceFinalized), 1_000, "SSE source finalization");
      await withTimeout(handlerSettled.promise, 1_000, "SSE handler settlement");

      expect(produced).toBeGreaterThan(0);
      expect(produced).toBeLessThan(512);
      expect(sourceFinalized).toBe(true);
      expect(sourceObservedAbort).toBe(true);
    } finally {
      response?.destroy();
      request?.destroy();
      await app.close();
    }
  });

  it("keeps static assets, explicit browser fallbacks, and API misses in separate boundaries", async () => {
    const root = tempDir("hostdeck-fastify-static-");
    const assets = join(root, "assets");
    mkdirSync(assets, { mode: 0o700 });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>HostDeck</title>", {
      mode: 0o600
    });
    writeFileSync(join(assets, "app.abc123.js"), "globalThis.hostDeckProbe = true;", {
      mode: 0o600
    });
    writeFileSync(join(assets, ".secret"), "not served", { mode: 0o600 });

    const app = Fastify();
    await app.register(fastifyStatic, {
      root: assets,
      prefix: "/assets/",
      allowedPath: (pathName) => pathName.split("/").every((segment) => !segment.startsWith(".")),
      dotfiles: "deny",
      immutable: true,
      index: false,
      maxAge: "1y",
      serveDotFiles: false
    });
    const sendIndex = (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      return reply.sendFile("index.html", root, { cacheControl: false });
    };
    app.get("/", sendIndex);
    app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId", sendIndex);
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).type("application/json").send(stableError("not_found", "Route not found"));
      }
      return reply.code(404).type("text/plain").send("Not found");
    });

    try {
      const asset = await app.inject({ method: "GET", url: "/assets/app.abc123.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("javascript");
      expect(asset.headers["cache-control"]).toContain("max-age=31536000");
      expect(asset.headers["cache-control"]).toContain("immutable");

      const head = await app.inject({ method: "HEAD", url: "/assets/app.abc123.js" });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-type"]).toContain("javascript");

      const browser = await app.inject({ method: "GET", url: "/sessions/session_01" });
      expect(browser.statusCode).toBe(200);
      expect(browser.headers["cache-control"]).toBe("no-store");
      expect(browser.headers["content-type"]).toContain("text/html");

      const apiMissing = await app.inject({ method: "GET", url: "/api/missing" });
      expect(apiMissing.statusCode).toBe(404);
      expect(apiMissing.headers["content-type"]).toContain("application/json");
      expect(apiMissing.json()).toEqual(stableError("not_found", "Route not found"));

      const dotfile = await app.inject({ method: "GET", url: "/assets/.secret" });
      expect(dotfile.statusCode).toBe(404);
      expect(dotfile.body).not.toContain("not served");

      const traversal = await app.inject({ method: "GET", url: "/assets/%2e%2e/index.html" });
      expect(traversal.statusCode).toBe(404);
      expect(traversal.body).not.toContain("HostDeck");
    } finally {
      await app.close();
    }
  });
});

function requireZodSchema(schema: unknown): z.ZodType {
  if (!(schema instanceof z.ZodType)) {
    throw new TypeError("Fastify route schema must be a Zod schema");
  }
  return schema;
}

function stableError(code: string, message: string) {
  return { error: { code, message, retryable: false } };
}

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function openPausedResponse(url: string): Promise<{
  request: ClientRequest;
  response: IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers: { accept: "text/event-stream" } });
    request.once("error", reject);
    request.once("response", (response) => {
      response.pause();
      resolve({ request, response });
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await wait(5);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
