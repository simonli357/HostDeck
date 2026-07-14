import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  defaultResourceBudget,
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  type RemoteIngressPublicState,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  remoteIngressPublicStateSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import type {
  HttpFetch,
  HttpRequestInit,
  HttpResponse
} from "./api-client.js";
import {
  apiFailure,
  CliFailure,
  clientOperationFailure,
  configFailure,
  daemonUnavailableFailure,
  internalFailure
} from "./errors.js";

export interface HostDeckRemoteControlClient {
  readonly disable: (
    input: RemoteDisableRequest
  ) => Promise<RemoteIngressPublicState>;
  readonly enable: (
    input: RemoteEnableRequest
  ) => Promise<RemoteIngressPublicState>;
  readonly status: () => Promise<RemoteIngressPublicState>;
}

export interface CreateHostDeckRemoteControlClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;
const loopbackHostnames = new Set(["::1"]);
const limits = Object.freeze({
  connectTimeoutMs: defaultResourceBudget.cli_connect_timeout_ms,
  maxInFlight: defaultResourceBudget.cli_max_in_flight_requests,
  requestBodyMaxBytes: defaultResourceBudget.cli_request_body_max_bytes,
  requestTimeoutMs: defaultResourceBudget.cli_request_timeout_ms,
  responseMaxBytes: defaultResourceBudget.cli_response_max_bytes
});

export function createHostDeckRemoteControlClient(
  input: CreateHostDeckRemoteControlClientOptions
): HostDeckRemoteControlClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck remote-control base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck remote-control fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  return Object.freeze({
    async disable(input: RemoteDisableRequest) {
      const request = parseMutationRequest(input, "disable");
      return await requestRemoteState({
        baseUrl,
        body: request,
        fetch: fetchPort,
        method: "POST",
        path: "/api/v1/remote/disable"
      });
    },
    async enable(input: RemoteEnableRequest) {
      const request = parseMutationRequest(input, "enable");
      return await requestRemoteState({
        baseUrl,
        body: request,
        fetch: fetchPort,
        method: "POST",
        path: "/api/v1/remote/enable"
      });
    },
    async status() {
      return await requestRemoteState({
        baseUrl,
        fetch: fetchPort,
        headers: {
          [hostDeckLocalAdminRequestHeaderName]:
            hostDeckLocalAdminRequestHeaderValue
        },
        method: "GET",
        path: "/api/v1/remote/status"
      });
    }
  });
}

async function requestRemoteState(input: {
  readonly baseUrl: URL;
  readonly body?: RemoteDisableRequest | RemoteEnableRequest;
  readonly fetch: HttpFetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: "GET" | "POST";
  readonly path:
    | "/api/v1/remote/disable"
    | "/api/v1/remote/enable"
    | "/api/v1/remote/status";
}): Promise<RemoteIngressPublicState> {
  const url = new URL(input.path, input.baseUrl);
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  let response: HttpResponse;
  try {
    response = await input.fetch(url.toString(), {
      method: input.method,
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...input.headers
      }),
      ...(body === undefined ? {} : { body })
    });
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(input.baseUrl, error);
  }

  assertHttpResponse(response);
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    const parsed = apiRouteErrorBodySchema.safeParse(payload);
    if (!parsed.success) {
      throw internalFailure(
        `HostDeck daemon returned an untyped HTTP ${response.status} remote-control error.`
      );
    }
    throw apiFailure(response.status, sanitizeRemoteApiError(parsed.data.error));
  }

  const parsed = remoteIngressPublicStateSchema.safeParse(payload);
  if (!parsed.success) {
    throw internalFailure(
      "HostDeck daemon returned an invalid remote-control state."
    );
  }
  return parsed.data;
}

function parseMutationRequest(
  candidate: unknown,
  action: "disable" | "enable"
): RemoteDisableRequest | RemoteEnableRequest {
  const parsed =
    action === "enable"
      ? remoteEnableRequestSchema.safeParse(candidate)
      : remoteDisableRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("HostDeck remote-control mutation input is invalid.");
  }
  return parsed.data;
}

function requireLoopbackBaseUrl(url: URL): void {
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
      "Remote control commands require the direct loopback HostDeck HTTP API.",
      "--api-url"
    );
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function sanitizeRemoteApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: remoteErrorMessage(error.code),
    retryable: error.retryable
  });
}

function remoteErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "permission_denied":
    case "invalid_origin":
      return "Remote control request is not permitted.";
    case "operation_conflict":
    case "capability_unavailable":
      return "Remote control conflicts with current laptop state.";
    case "operation_timeout":
      return "Remote control request timed out.";
    case "service_overloaded":
      return "Another remote control operation is active.";
    case "audit_unavailable":
      return "Remote control audit is unavailable.";
    case "storage_error":
      return "Remote control storage is unavailable.";
    case "runtime_unavailable":
    case "incompatible_runtime":
    case "missing_binary":
      return "Remote control client is unavailable.";
    default:
      return "Remote control request failed.";
  }
}

function createBoundedLoopbackFetch(): HttpFetch {
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

function rawLoopbackRequest(
  rawUrl: string,
  init: HttpRequestInit
): Promise<HttpResponse> {
  const url = new URL(rawUrl);
  requireLoopbackBaseUrl(new URL(url.origin));
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
              error: internalFailure(
                "HostDeck daemon returned an invalid HTTP status."
              ),
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

function incompleteResponseFailure(): CliFailure {
  return clientOperationFailure(
    "unknown_error",
    "HostDeck CLI response ended before completion."
  );
}

function assertHttpResponse(
  candidate: unknown
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
    throw internalFailure("HostDeck remote-control HTTP response is invalid.");
  }
}

async function readJsonPayload(response: HttpResponse): Promise<unknown> {
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

function readExactOptions(
  candidate: unknown
): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck remote-control client options are invalid.";
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new TypeError(message);
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length < 1 ||
      keys.length > optionKeys.length ||
      keys.some((key) => {
        if (
          typeof key !== "string" ||
          !optionKeys.includes(key as (typeof optionKeys)[number])
        ) {
          return true;
        }
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      }) ||
      !Object.hasOwn(descriptors, "baseUrl")
    ) {
      throw new TypeError(message);
    }
    return Object.freeze({
      baseUrl: descriptors.baseUrl?.value,
      fetch: descriptors.fetch?.value
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}
