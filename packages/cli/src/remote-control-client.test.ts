import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  defaultResourceBudget,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpRequestInit, HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { createHostDeckRemoteControlClient } from "./remote-control-client.js";

const servers: Server[] = [];
const externalOrigin = "https://private-laptop.fixture-tailnet.ts.net";
const observedAt = "2026-07-13T21:00:00.000Z";
const disabledState = {
  generation: 0,
  availability: "disabled",
  reason: "remote_disabled",
  external_origin: null,
  laptop_action_required: true,
  observed_at: null
} as const;
const readyState = {
  generation: 2,
  availability: "ready",
  reason: null,
  external_origin: externalOrigin,
  laptop_action_required: false,
  observed_at: observedAt
} as const;

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

describe("selected remote-control CLI client", () => {
  it("sends the exact status and one-shot mutation requests", async () => {
    const requests: Array<{
      readonly init: HttpRequestInit;
      readonly url: string;
    }> = [];
    const client = createHostDeckRemoteControlClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async (url, init) => {
        requests.push({ init, url });
        return jsonResponse(
          200,
          url.endsWith("/status") ? disabledState : readyState
        );
      }
    });
    const enable = remoteEnableRequestSchema.parse({
      operation_id: "op_remote_client_enable_001",
      confirmed: true
    });
    const disable = remoteDisableRequestSchema.parse({
      operation_id: "op_remote_client_disable_001",
      confirmed: true
    });

    await expect(client.status()).resolves.toEqual(disabledState);
    await expect(client.enable(enable)).resolves.toEqual(readyState);
    await expect(client.disable(disable)).resolves.toEqual(readyState);

    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:3777/api/v1/remote/status",
      init: {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          [hostDeckLocalAdminRequestHeaderName]:
            hostDeckLocalAdminRequestHeaderValue
        }
      }
    });
    expect(requests[1]).toEqual({
      url: "http://127.0.0.1:3777/api/v1/remote/enable",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json"
        },
        body: JSON.stringify(enable)
      }
    });
    expect(requests[2]).toEqual({
      url: "http://127.0.0.1:3777/api/v1/remote/disable",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json"
        },
        body: JSON.stringify(disable)
      }
    });
    expect(Object.isFrozen(requests[0]?.init.headers)).toBe(true);
  });

  it("snapshots one exact loopback HTTP URL and rejects every alternate transport", async () => {
    const baseUrl = new URL("http://127.0.0.1:3777");
    const observed: string[] = [];
    const client = createHostDeckRemoteControlClient({
      baseUrl,
      fetch: async (url) => {
        observed.push(url);
        return jsonResponse(200, disabledState);
      }
    });
    baseUrl.hostname = "203.0.113.9";
    await client.status();
    expect(observed).toEqual([
      "http://127.0.0.1:3777/api/v1/remote/status"
    ]);

    for (const value of [
      "http://localhost:3777",
      "http://[::1]:3777",
      "http://127.9.8.7:3777",
      "http://0.0.0.0:3777",
      "http://192.168.1.20:3777",
      "https://127.0.0.1:3777",
      "https://private-laptop.fixture-tailnet.ts.net",
      "http://127.0.0.1:1023",
      "http://127.0.0.1:3777/base",
      "http://127.0.0.1:3777/?query=1",
      "http://user@127.0.0.1:3777"
    ]) {
      expect(
        () =>
          createHostDeckRemoteControlClient({ baseUrl: new URL(value) }),
        value
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_config",
          exitCode: cliExitCodes.config
        })
      );
    }
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return new URL("http://127.0.0.1:3777");
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: new URL("http://127.0.0.1:3777"), extra: true },
      { baseUrl: "http://127.0.0.1:3777" },
      { baseUrl: new URL("http://127.0.0.1:3777"), fetch: true },
      accessor
    ]) {
      expect(() =>
        createHostDeckRemoteControlClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("sanitizes typed API errors and never retries uncertain outcomes", async () => {
    let calls = 0;
    const client = createHostDeckRemoteControlClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        return jsonResponse(409, {
          error: {
            code: "operation_conflict",
            message: "private profile account and node identity",
            retryable: false,
            details: { request_id: "req_remote_private" }
          }
        });
      }
    });

    await expect(
      client.enable(
        remoteEnableRequestSchema.parse({
          operation_id: "op_remote_client_uncertain_001",
          confirmed: true
        })
      )
    ).rejects.toMatchObject({
      code: "operation_conflict",
      message: "Remote control conflicts with current laptop state.",
      status: 409
    });
    expect(calls).toBe(1);
  });

  it("rejects invalid input, malformed responses, and fetch failure without a second call", async () => {
    let calls = 0;
    const invalidInput = createHostDeckRemoteControlClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, readyState);
      }
    });
    await expect(
      invalidInput.enable({
        operation_id: "bad",
        confirmed: true
      } as never)
    ).rejects.toMatchObject({ code: "internal_error" });
    expect(calls).toBe(0);

    const malformed = createHostDeckRemoteControlClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, { ...readyState, private_profile: "secret" });
      }
    });
    await expect(malformed.status()).rejects.toMatchObject({
      code: "internal_error",
      message: "HostDeck daemon returned an invalid remote-control state."
    });
    expect(calls).toBe(1);

    calls = 0;
    const unavailable = createHostDeckRemoteControlClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        throw new Error("private socket failure");
      }
    });
    await expect(unavailable.status()).rejects.toMatchObject({
      code: "daemon_unavailable",
      exitCode: cliExitCodes.daemonUnavailable
    });
    expect(calls).toBe(1);
  });

  it("uses raw bounded HTTP without browser, cookie, or origin authority headers", async () => {
    const exchanges: Array<{
      readonly body: string;
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
      readonly method: string | undefined;
      readonly rawHeaders: readonly string[];
      readonly url: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        exchanges.push({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: request.headers,
          method: request.method,
          rawHeaders: request.rawHeaders,
          url: request.url
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(disabledState));
      });
    });
    const baseUrl = await listen(server);
    const client = createHostDeckRemoteControlClient({ baseUrl });

    await client.status();
    await client.enable(
      remoteEnableRequestSchema.parse({
        operation_id: "op_remote_client_raw_enable_001",
        confirmed: true
      })
    );

    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]).toMatchObject({
      body: "",
      method: "GET",
      url: "/api/v1/remote/status"
    });
    expect(exchanges[0]?.headers[hostDeckLocalAdminRequestHeaderName]).toBe(
      hostDeckLocalAdminRequestHeaderValue
    );
    expect(exchanges[1]).toMatchObject({
      body: JSON.stringify({
        operation_id: "op_remote_client_raw_enable_001",
        confirmed: true
      }),
      method: "POST",
      url: "/api/v1/remote/enable"
    });
    expect(exchanges[1]?.headers[hostDeckLocalAdminRequestHeaderName]).toBeUndefined();
    for (const exchange of exchanges) {
      const names = exchange.rawHeaders
        .filter((_value, index) => index % 2 === 0)
        .map((name) => name.toLowerCase());
      expect(names).not.toContain("origin");
      expect(names).not.toContain("cookie");
      expect(names.some((name) => name.startsWith("sec-fetch-"))).toBe(false);
    }
  });

  it("rejects a declared oversized response before parsing or retrying", async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(200, {
        "content-length": String(
          defaultResourceBudget.cli_response_max_bytes + 1
        ),
        "content-type": "application/json"
      });
      response.end();
    });
    const baseUrl = await listen(server);
    const client = createHostDeckRemoteControlClient({ baseUrl });

    await expect(client.status()).rejects.toMatchObject({
      code: "service_overloaded",
      exitCode: cliExitCodes.apiError
    });
    expect(calls).toBe(1);
  });

  it("fails an incomplete response immediately without retry", async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(200, {
        "content-length": "200",
        "content-type": "application/json"
      });
      response.flushHeaders();
      response.write('{"generation":');
      setImmediate(() => response.destroy());
    });
    const baseUrl = await listen(server);
    const client = createHostDeckRemoteControlClient({ baseUrl });

    await expect(client.status()).rejects.toMatchObject({
      code: "unknown_error",
      exitCode: cliExitCodes.apiError
    });
    expect(calls).toBe(1);
  });

  it("rejects above the selected in-flight limit without queuing another request", async () => {
    const responses: ServerResponse[] = [];
    const server = createServer((_request, response) => {
      responses.push(response);
    });
    const baseUrl = await listen(server);
    const client = createHostDeckRemoteControlClient({ baseUrl });
    const admitted = Array.from(
      { length: defaultResourceBudget.cli_max_in_flight_requests },
      () => client.status()
    );
    const rejected = client.status();

    await expect(rejected).rejects.toMatchObject({
      code: "service_overloaded",
      exitCode: cliExitCodes.apiError,
      retryable: true
    });
    await eventually(() =>
      expect(responses).toHaveLength(
        defaultResourceBudget.cli_max_in_flight_requests
      )
    );
    for (const response of responses) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(disabledState));
    }
    await expect(Promise.all(admitted)).resolves.toHaveLength(
      defaultResourceBudget.cli_max_in_flight_requests
    );
    expect(responses).toHaveLength(
      defaultResourceBudget.cli_max_in_flight_requests
    );
  });
});

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

async function listen(server: Server): Promise<URL> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}`);
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw failure;
}
