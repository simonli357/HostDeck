import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { defaultResourceBudget } from "@hostdeck/contracts";
import type { HttpFetch, HttpRequestInit, HttpResponse } from "./api-client.js";
import {
  CliFailure,
  clientOperationFailure,
  configFailure,
  daemonUnavailableFailure,
  internalFailure
} from "./errors.js";

const loopbackHostnames = new Set(["::1"]);
const limits = Object.freeze({
  connectTimeoutMs: defaultResourceBudget.cli_connect_timeout_ms,
  maxInFlight: defaultResourceBudget.cli_max_in_flight_requests,
  requestBodyMaxBytes: defaultResourceBudget.cli_request_body_max_bytes,
  requestTimeoutMs: defaultResourceBudget.cli_request_timeout_ms,
  responseMaxBytes: defaultResourceBudget.cli_response_max_bytes
});

export function createBoundedLoopbackFetch(): HttpFetch {
  let inFlight = 0;
  return async (url, init) => {
    if (inFlight >= limits.maxInFlight) {
      throw clientOperationFailure(
        "service_overloaded",
        "Too many HostDeck CLI requests are active.",
        true
      );
    }
    inFlight += 1;
    try {
      return await rawLoopbackRequest(url, init);
    } finally {
      inFlight -= 1;
    }
  };
}

export function requireLoopbackBaseUrl(url: URL): void {
  const hostname = stripIpv6Brackets(url.hostname);
  const ipv4 = isIP(hostname) === 4 ? hostname.split(".").map(Number) : null;
  const loopback =
    loopbackHostnames.has(hostname) ||
    (ipv4 !== null && ipv4.length === 4 && ipv4[0] === 127);
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw configFailure(
      "Local HostDeck control requires the direct loopback HTTP API.",
      "--api-url"
    );
  }
}

export function assertCliHttpResponse(
  candidate: unknown,
  context: string
): asserts candidate is HttpResponse {
  const response = candidate as Partial<HttpResponse>;
  const status = response?.status;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    status < 100 ||
    status > 599 ||
    typeof response.ok !== "boolean" ||
    typeof response.json !== "function" ||
    response.ok !== (status >= 200 && status < 300)
  ) {
    throw internalFailure(`${context} HTTP response is invalid.`);
  }
}

export async function readCliJsonPayload(response: HttpResponse): Promise<unknown> {
  try {
    return await Reflect.apply(response.json, undefined, []);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw internalFailure(
      `HostDeck daemon returned invalid JSON for HTTP ${response.status}.`,
      error
    );
  }
}

function rawLoopbackRequest(rawUrl: string, init: HttpRequestInit): Promise<HttpResponse> {
  const url = new URL(rawUrl);
  requireLoopbackRequestUrl(url);
  const body = init.body ?? "";
  if (Buffer.byteLength(body, "utf8") > limits.requestBodyMaxBytes) {
    return Promise.reject(
      clientOperationFailure(
        "request_too_large",
        "HostDeck CLI request body exceeds its selected limit."
      )
    );
  }

  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let requestTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (
      outcome:
        | { readonly kind: "resolve"; readonly response: HttpResponse }
        | { readonly error: unknown; readonly kind: "reject" }
    ) => {
      if (settled) return;
      settled = true;
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (requestTimer !== null) clearTimeout(requestTimer);
      if (outcome.kind === "resolve") resolve(outcome.response);
      else reject(outcome.error);
    };
    const request = httpRequest(
      url,
      {
        agent: false,
        headers: init.headers,
        method: init.method
      },
      (response) => {
        if (connectTimer !== null) clearTimeout(connectTimer);
        const declaredLength = response.headers["content-length"];
        if (
          typeof declaredLength === "string" &&
          /^\d+$/u.test(declaredLength) &&
          Number(declaredLength) > limits.responseMaxBytes
        ) {
          response.destroy();
          finish({
            error: clientOperationFailure(
              "service_overloaded",
              "HostDeck CLI response exceeds its selected limit."
            ),
            kind: "reject"
          });
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > limits.responseMaxBytes) {
            response.destroy();
            finish({
              error: clientOperationFailure(
                "service_overloaded",
                "HostDeck CLI response exceeds its selected limit."
              ),
              kind: "reject"
            });
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          const status = response.statusCode;
          if (
            status === undefined ||
            !Number.isSafeInteger(status) ||
            status < 100 ||
            status > 599
          ) {
            finish({
              error: internalFailure("HostDeck daemon returned an invalid HTTP status."),
              kind: "reject"
            });
            return;
          }
          const text = Buffer.concat(chunks, bytes).toString("utf8");
          finish({
            kind: "resolve",
            response: Object.freeze({
              json: async () => JSON.parse(text) as unknown,
              ok: status >= 200 && status < 300,
              status,
              text: async () => text
            })
          });
        });
        response.on("error", (error) => {
          finish({ error, kind: "reject" });
        });
        response.on("aborted", () => {
          finish({ error: incompleteResponseFailure(), kind: "reject" });
        });
        response.on("close", () => {
          if (!response.complete) {
            finish({ error: incompleteResponseFailure(), kind: "reject" });
          }
        });
      }
    );
    request.on("socket", (socket) => {
      if (!socket.connecting) {
        if (connectTimer !== null) clearTimeout(connectTimer);
        return;
      }
      socket.once("connect", () => {
        if (connectTimer !== null) clearTimeout(connectTimer);
      });
    });
    request.on("error", (error) => {
      finish({ error, kind: "reject" });
    });
    connectTimer = setTimeout(() => {
      const error = daemonUnavailableFailure(
        new URL(url.origin),
        new Error("connect timeout")
      );
      request.destroy();
      finish({ error, kind: "reject" });
    }, limits.connectTimeoutMs);
    requestTimer = setTimeout(() => {
      const error = clientOperationFailure(
        "operation_timeout",
        "HostDeck CLI request timed out."
      );
      request.destroy();
      finish({ error, kind: "reject" });
    }, limits.requestTimeoutMs);
    request.end(body);
  });
}

function requireLoopbackRequestUrl(url: URL): void {
  requireLoopbackBaseUrl(new URL(url.origin));
  if (
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    !url.pathname.startsWith("/api/") ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw configFailure(
      "Local HostDeck control requires one exact loopback API request URL.",
      "--api-url"
    );
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function incompleteResponseFailure(): CliFailure {
  return clientOperationFailure(
    "unknown_error",
    "HostDeck CLI response ended before completion."
  );
}
