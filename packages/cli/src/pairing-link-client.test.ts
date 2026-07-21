import { Buffer } from "node:buffer";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defaultResourceBudget, selectedPairRequestSchema } from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue,
  selectedApiRouteManifest
} from "@hostdeck/server";
import QRCode from "qrcode";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpRequestInit, HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { createHostDeckPairingLinkClient } from "./pairing-link-client.js";
import { renderPairingLink } from "./render.js";

const servers: Server[] = [];
const origin = "https://private-laptop.fixture-tailnet.ts.net";
const code = "AbCdEfGhIjKlMnOpQrSt_1";
const link = `${origin}/#pair=${code}`;
const readyState = {
  generation: 4,
  availability: "ready",
  reason: null,
  external_origin: origin,
  laptop_action_required: false,
  observed_at: "2026-07-13T22:00:00.000Z"
} as const;
const disabledState = {
  generation: 5,
  availability: "disabled",
  reason: "remote_disabled",
  external_origin: null,
  laptop_action_required: true,
  observed_at: null
} as const;
const request = selectedPairRequestSchema.parse({
  operation_id: "op_pair_request_client_0001",
  permission: "write",
  client_label: "Android phone"
});
const issued = {
  pairing_id: "pair_abcdefghijklmnopqrstuvwx",
  code,
  permission: "write",
  client_label: "Android phone",
  created_at: "2026-07-13T22:00:00.000Z",
  expires_at: "2026-07-13T22:05:00.000Z"
} as const;

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

describe("selected pairing-link CLI client", () => {
  it("checks one ready generation around one issue request and returns only renderable metadata", async () => {
    const exchanges: Array<{ readonly init: HttpRequestInit; readonly url: string }> = [];
    const client = createHostDeckPairingLinkClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async (url, init) => {
        exchanges.push({ url, init });
        return jsonResponse(url.endsWith("/pairing-codes") ? issued : readyState);
      }
    });

    const result = await client.issue(request);

    expect(result).toEqual({
      link,
      permission: "write",
      client_label: "Android phone",
      expires_at: issued.expires_at
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("code");
    expect(result).not.toHaveProperty("pairing_id");
    expect(exchanges.map((exchange) => exchange.url)).toEqual([
      "http://127.0.0.1:3777/api/v1/remote/status",
      "http://127.0.0.1:3777/api/v1/access/pairing-codes",
      "http://127.0.0.1:3777/api/v1/remote/status"
    ]);
    expect(exchanges[1]?.init).toEqual({
      method: "POST",
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json",
        [hostDeckLocalAdminRequestHeaderName]:
          hostDeckLocalAdminRequestHeaderValue
      },
      body: JSON.stringify(request)
    });
    expect(Object.isFrozen(exchanges[1]?.init.headers)).toBe(true);
  });

  it("uses the exact selected manifest routes", () => {
    const routes = selectedApiRouteManifest.filter((entry) =>
      ["pair_request", "remote_status"].includes(entry.id)
    );
    expect(routes.map(({ id, method, path }) => ({ id, method, path }))).toEqual([
      { id: "pair_request", method: "POST", path: "/api/v1/access/pairing-codes" },
      { id: "remote_status", method: "GET", path: "/api/v1/remote/status" }
    ]);
  });

  it("does not issue when the first state is not exactly ready", async () => {
    let calls = 0;
    const client = createHostDeckPairingLinkClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        return jsonResponse(disabledState);
      }
    });

    await expect(client.issue(request)).rejects.toMatchObject({
      code: "capability_unavailable",
      exitCode: cliExitCodes.apiError
    });
    expect(calls).toBe(1);
  });

  it("suppresses an issued code when readiness changes and never retries", async () => {
    let calls = 0;
    const client = createHostDeckPairingLinkClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse(readyState);
        if (calls === 2) return jsonResponse(issued);
        return jsonResponse(disabledState);
      }
    });

    const error = await captureFailure(client.issue(request));
    expect(error).toMatchObject({ code: "operation_conflict" });
    expect(errorText(error)).not.toContain(code);
    expect(calls).toBe(3);
  });

  it("rejects generation or origin drift after issue without revealing the link", async () => {
    for (const after of [
      { ...readyState, generation: readyState.generation + 1 },
      { ...readyState, external_origin: "https://other-laptop.fixture-tailnet.ts.net" }
    ]) {
      let calls = 0;
      const client = createHostDeckPairingLinkClient({
        baseUrl: new URL("http://127.0.0.1:3777"),
        fetch: async () => {
          calls += 1;
          return jsonResponse(calls === 1 ? readyState : calls === 2 ? issued : after);
        }
      });
      const error = await captureFailure(client.issue(request));
      expect(error).toMatchObject({ code: "operation_conflict" });
      expect(errorText(error)).not.toContain(code);
      expect(calls).toBe(3);
    }
  });

  it("rejects inconsistent or malformed issue responses before the second status read", async () => {
    for (const response of [
      { ...issued, permission: "read" },
      { ...issued, client_label: "Different phone" },
      { ...issued, private_token: code },
      { ...issued, code: "short" }
    ]) {
      let calls = 0;
      const client = createHostDeckPairingLinkClient({
        baseUrl: new URL("http://127.0.0.1:3777"),
        fetch: async () => {
          calls += 1;
          return jsonResponse(calls === 1 ? readyState : response);
        }
      });
      const error = await captureFailure(client.issue(request));
      expect(error).toMatchObject({ code: "internal_error" });
      expect(errorText(error)).not.toContain(code);
      expect(calls).toBe(2);
    }
  });

  it("sanitizes typed server errors and performs no retry", async () => {
    let calls = 0;
    const client = createHostDeckPairingLinkClient({
      baseUrl: new URL("http://127.0.0.1:3777"),
      fetch: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse(readyState);
        return jsonResponse(
          {
            error: {
              code: "storage_error",
              message: `private response ${code}`,
              retryable: false,
              details: { request_id: `req_${code}` }
            }
          },
          500
        );
      }
    });

    const error = await captureFailure(client.issue(request));
    expect(error).toMatchObject({
      code: "storage_error",
      message: "Pairing storage is unavailable.",
      status: 500
    });
    expect(errorText(error)).not.toContain(code);
    expect(calls).toBe(2);
  });

  it("snapshots one direct loopback base URL and rejects alternate or accessor input", async () => {
    const baseUrl = new URL("http://127.0.0.1:3777");
    const seen: string[] = [];
    const client = createHostDeckPairingLinkClient({
      baseUrl,
      fetch: async (url) => {
        seen.push(url);
        return jsonResponse(url.endsWith("/pairing-codes") ? issued : readyState);
      }
    });
    baseUrl.hostname = "203.0.113.8";
    await client.issue(request);
    expect(seen.every((url) => url.startsWith("http://127.0.0.1:3777/"))).toBe(true);

    for (const value of [
      "http://localhost:3777",
      "http://127.9.8.7:3777",
      "http://[::1]:3777",
      "http://127.0.0.1:1023",
      "https://127.0.0.1:3777",
      "http://192.168.1.8:3777",
      "http://127.0.0.1:3777/base",
      "http://user@127.0.0.1:3777"
    ]) {
      expect(() => createHostDeckPairingLinkClient({ baseUrl: new URL(value) }), value).toThrow();
    }
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        return new URL("http://127.0.0.1:3777");
      }
    });
    for (const candidate of [null, [], {}, accessor, { baseUrl: "bad" }, { baseUrl, extra: true }]) {
      expect(() => createHostDeckPairingLinkClient(candidate as never)).toThrow(TypeError);
    }
  });

  it("uses bounded raw HTTP with explicit local-admin authority", async () => {
    const exchanges: Array<{
      readonly body: string;
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
      readonly method: string | undefined;
      readonly rawHeaders: readonly string[];
      readonly url: string | undefined;
    }> = [];
    const server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        exchanges.push({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: incoming.headers,
          method: incoming.method,
          rawHeaders: incoming.rawHeaders,
          url: incoming.url
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(incoming.url?.endsWith("/pairing-codes") ? issued : readyState));
      });
    });
    const baseUrl = await listen(server);
    const client = createHostDeckPairingLinkClient({ baseUrl });

    await expect(client.issue(request)).resolves.toMatchObject({ link });
    expect(exchanges).toHaveLength(3);
    expect(exchanges.map((exchange) => `${exchange.method} ${exchange.url}`)).toEqual([
      "GET /api/v1/remote/status",
      "POST /api/v1/access/pairing-codes",
      "GET /api/v1/remote/status"
    ]);
    expect(exchanges[0]?.headers[hostDeckLocalAdminRequestHeaderName]).toBe(
      hostDeckLocalAdminRequestHeaderValue
    );
    expect(exchanges[1]?.headers[hostDeckLocalAdminRequestHeaderName]).toBe(
      hostDeckLocalAdminRequestHeaderValue
    );
    expect(exchanges[2]?.headers[hostDeckLocalAdminRequestHeaderName]).toBe(
      hostDeckLocalAdminRequestHeaderValue
    );
    for (const exchange of exchanges) {
      const names = exchange.rawHeaders
        .filter((_value, index) => index % 2 === 0)
        .map((name) => name.toLowerCase());
      expect(names).not.toContain("origin");
      expect(names).not.toContain("cookie");
      expect(names.some((name) => name.startsWith("sec-fetch-"))).toBe(false);
    }
  });
});

describe("terminal pairing-link rendering", () => {
  const result = {
    link,
    permission: "write",
    client_label: "Android phone",
    expires_at: issued.expires_at
  } as const;

  it("encodes the exact canonical link in a bounded terminal QR and text fallback", async () => {
    const output = await renderPairingLink(result);
    const symbol = QRCode.create(link, { errorCorrectionLevel: "M" });

    expect(
      symbol.segments
        .map((segment) =>
          typeof segment.data === "string"
            ? segment.data
            : Buffer.from(segment.data).toString("utf8")
        )
        .join("")
    ).toBe(link);
    expect(output).toContain("\u001B[");
    expect(output).toContain(link);
    expect(output).not.toContain("Code:");
    expect(output.split(code)).toHaveLength(2);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(
      defaultResourceBudget.cli_response_max_bytes
    );
  });

  it("rejects failed, empty, NUL, and oversized QR output without reflecting the link", async () => {
    const renderers = [
      async () => {
        throw new Error(link);
      },
      async () => "",
      async () => "bad\0qr",
      async () => "x".repeat(defaultResourceBudget.cli_response_max_bytes + 1)
    ];
    for (const renderer of renderers) {
      const error = await captureFailure(renderPairingLink(result, renderer));
      expect(error).toMatchObject({ code: "internal_error" });
      expect(errorText(error)).not.toContain(code);
    }
  });

  it("validates result metadata before invoking the QR renderer", async () => {
    let calls = 0;
    const error = await captureFailure(
      renderPairingLink(
        { ...result, link: `${origin}/?pair=${code}` as never },
        async () => {
          calls += 1;
          return "qr";
        }
      )
    );
    expect(error).toMatchObject({ code: "internal_error" });
    expect(calls).toBe(0);
  });
});

function jsonResponse(body: unknown, status = 200): HttpResponse {
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

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

function errorText(error: unknown): string {
  const candidate = error as { readonly message?: unknown; readonly apiError?: unknown; readonly cause?: unknown };
  return [candidate.message, JSON.stringify(candidate.apiError), String(candidate.cause ?? "")].join(" ");
}
