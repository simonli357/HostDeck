import { Buffer } from "node:buffer";
import {
  type ClientRequest,
  get as httpGet,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { fastifySSE } from "@fastify/sse";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

describe("patched Fastify SSE heartbeat backpressure", () => {
  it("allows only one blocked heartbeat write and one drain listener", async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifySSE, { heartbeatInterval: 10 });
    let rawResponse: ServerResponse | undefined;
    let heartbeatWrites = 0;
    let baselineCloseListeners = 0;
    let baselineDrainListeners = 0;
    let baselineErrorListeners = 0;
    let closeFromServer: (() => void) | undefined;

    app.get("/events", { sse: "only" }, async (_request, reply) => {
      const raw = reply.raw;
      rawResponse = raw;
      baselineCloseListeners = raw.listenerCount("close");
      baselineDrainListeners = raw.listenerCount("drain");
      baselineErrorListeners = raw.listenerCount("error");
      const originalWrite = raw.write;
      const patchedWrite = (...args: unknown[]): boolean => {
        const result = Reflect.apply(originalWrite, raw, args) as boolean;
        if (wireText(args[0]) !== ": heartbeat\n\n") return result;
        heartbeatWrites += 1;
        return false;
      };
      raw.write = patchedWrite as typeof raw.write;
      reply.sse.sendHeaders();
      reply.sse.keepAlive();
      closeFromServer = () => reply.sse.close();
    });

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    try {
      ({ request, response } = await openResponse(`${address}/events`));
      await waitUntil(() => heartbeatWrites === 1);
      await wait(50);

      expect(heartbeatWrites).toBe(1);
      expect(rawResponse?.listenerCount("drain")).toBe(
        baselineDrainListeners + 1
      );
      expect(rawResponse?.listenerCount("close")).toBe(baselineCloseListeners);
      expect(rawResponse?.listenerCount("error")).toBe(baselineErrorListeners);

      rawResponse?.emit("drain");
      await waitUntil(() => heartbeatWrites === 2);
      await wait(50);
      expect(heartbeatWrites).toBe(2);
      expect(rawResponse?.listenerCount("drain")).toBe(
        baselineDrainListeners + 1
      );
      expect(rawResponse?.listenerCount("close")).toBe(baselineCloseListeners);
      expect(rawResponse?.listenerCount("error")).toBe(baselineErrorListeners);

      closeFromServer?.();
      await waitUntil(
        () => rawResponse?.listenerCount("drain") === baselineDrainListeners
      );
      const writesAfterClose = heartbeatWrites;
      await wait(30);
      expect(heartbeatWrites).toBe(writesAfterClose);
    } finally {
      response?.destroy();
      request?.destroy();
      await app.close();
    }
  });
});

function wireText(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function openResponse(url: string): Promise<{
  readonly request: ClientRequest;
  readonly response: IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers: { accept: "text/event-stream" } });
    request.once("error", reject);
    request.once("response", (response) => resolve({ request, response }));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for heartbeat state.");
    await wait(5);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
