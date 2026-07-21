import { Buffer } from "node:buffer";
import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions
} from "node:http";
import type { Socket } from "node:net";
import { TextDecoder } from "node:util";
import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  apiRouteErrorBodySchema,
  assertResolvedResourceBudget,
  defaultResourceBudget,
  type ResourceBudget,
} from "@hostdeck/contracts";
import type { HttpFetch, HttpRequestInit, HttpResponse } from "./api-client.js";
import {
  apiFailure,
  CliFailure,
  clientOperationFailure,
  configFailure,
  daemonUnavailableFailure,
  internalFailure
} from "./errors.js";

type LoopbackRequestPort = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void
) => ClientRequest;

export interface CreateBoundedLoopbackFetchOptions {
  readonly budget?: ResourceBudget;
  readonly request?: LoopbackRequestPort;
  readonly signal?: AbortSignal;
}

export interface CliJsonResponse {
  readonly payload: unknown;
  readonly response: HttpResponse;
}

interface LoopbackLimits {
  readonly connectTimeoutMs: number;
  readonly maxInFlight: number;
  readonly requestBodyMaxBytes: number;
  readonly requestTimeoutMs: number;
  readonly responseHeadersMaxBytes: number;
  readonly responseHeadersMaxCount: number;
  readonly responseIdleTimeoutMs: number;
  readonly responseMaxBytes: number;
}

interface PreparedLoopbackRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "GET" | "POST";
  readonly url: URL;
}

const optionKeys = ["budget", "request", "signal"] as const;
const allowedRequestHeaders = new Set([
  "accept",
  "cache-control",
  "content-type",
  "x-hostdeck-local-admin"
]);
const jsonMediaTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const canonicalDecimalPattern = /^(?:0|[1-9]\d*)$/u;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const defaultRequestPort: LoopbackRequestPort = (url, options, callback) =>
  httpRequest(url, options, callback);

let processInFlightRequests = 0;

export function createBoundedLoopbackFetch(
  input: CreateBoundedLoopbackFetchOptions = {}
): HttpFetch {
  const options = readExactTransportOptions(input);
  const budget = readBudget(options.budget);
  const limits: LoopbackLimits = Object.freeze({
    connectTimeoutMs: budget.cli_connect_timeout_ms,
    maxInFlight: budget.cli_max_in_flight_requests,
    requestBodyMaxBytes: budget.cli_request_body_max_bytes,
    requestTimeoutMs: budget.cli_request_timeout_ms,
    responseHeadersMaxBytes: budget.http_headers_max_bytes,
    responseHeadersMaxCount: budget.http_headers_max_count,
    responseIdleTimeoutMs: budget.cli_stream_idle_timeout_ms,
    responseMaxBytes: budget.cli_response_max_bytes
  });
  const requestPort = options.request ?? defaultRequestPort;
  const signal = options.signal;

  return async (rawUrl, init) => {
    const prepared = prepareLoopbackRequest(rawUrl, init, limits);
    if (signal?.aborted === true) {
      throw cancelledRequestFailure(prepared.method);
    }
    if (processInFlightRequests >= limits.maxInFlight) {
      throw clientOperationFailure(
        "service_overloaded",
        "Too many HostDeck CLI requests are active.",
        true
      );
    }

    processInFlightRequests += 1;
    try {
      return await executeLoopbackRequest(
        prepared,
        limits,
        requestPort,
        signal
      );
    } finally {
      processInFlightRequests -= 1;
    }
  };
}

export async function requestCliJson(input: {
  readonly baseUrl: URL;
  readonly context: string;
  readonly expectedStatus: number;
  readonly fetch: HttpFetch;
  readonly init: HttpRequestInit;
  readonly invalidSuccessStatusMessage: string;
  readonly url: URL;
}): Promise<CliJsonResponse> {
  let response: HttpResponse;
  try {
    response = await Reflect.apply(input.fetch, undefined, [
      input.url.toString(),
      input.init
    ]);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(input.baseUrl, error);
  }

  assertCliHttpResponse(response, input.context);
  const payload = await readCliJsonPayload(response);
  if (response.ok && response.status !== input.expectedStatus) {
    throw internalFailure(input.invalidSuccessStatusMessage);
  }
  return Object.freeze({ payload, response });
}

export function throwCliApiFailure(input: {
  readonly context: string;
  readonly payload: unknown;
  readonly sanitize: (error: ApiErrorEnvelope) => ApiErrorEnvelope;
  readonly status: number;
}): never {
  let parsed: ReturnType<typeof apiRouteErrorBodySchema.safeParse>;
  try {
    parsed = apiRouteErrorBodySchema.safeParse(input.payload);
  } catch {
    throw untypedApiFailure(input.status, input.context);
  }
  if (!parsed.success) throw untypedApiFailure(input.status, input.context);

  let sanitized: ReturnType<typeof apiErrorEnvelopeSchema.safeParse>;
  try {
    sanitized = apiErrorEnvelopeSchema.safeParse(
      input.sanitize(parsed.data.error)
    );
  } catch {
    throw internalFailure(
      `HostDeck CLI ${input.context} error sanitizer failed.`
    );
  }
  if (
    !sanitized.success ||
    sanitized.data.details !== undefined ||
    sanitized.data.session_id !== undefined
  ) {
    throw internalFailure(
      `HostDeck CLI ${input.context} error sanitizer failed.`
    );
  }
  throw apiFailure(input.status, sanitized.data);
}

export function requireLoopbackBaseUrl(url: URL): void {
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
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
  const message = `${context} HTTP response is invalid.`;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw internalFailure(message);
  }

  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    const status = dataValue(descriptors.status);
    const ok = dataValue(descriptors.ok);
    const json = dataValue(descriptors.json);
    const text = dataValue(descriptors.text);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !["json", "ok", "status", "text"].includes(key)
      ) ||
      keys.some(
        (key) =>
          typeof key !== "string" || descriptors[key]?.enumerable !== true
      ) ||
      typeof status !== "number" ||
      !Number.isSafeInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof ok !== "boolean" ||
      typeof json !== "function" ||
      (text !== undefined && typeof text !== "function") ||
      ok !== (status >= 200 && status < 300)
    ) {
      throw internalFailure(message);
    }
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw internalFailure(message);
  }
}

export async function readCliJsonPayload(
  response: HttpResponse
): Promise<unknown> {
  try {
    return await Reflect.apply(response.json, undefined, []);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw internalFailure(
      `HostDeck daemon returned invalid JSON for HTTP ${response.status}.`
    );
  }
}

function prepareLoopbackRequest(
  rawUrl: string,
  init: HttpRequestInit,
  limits: LoopbackLimits
): PreparedLoopbackRequest {
  if (typeof rawUrl !== "string") {
    throw configFailure(
      "Local HostDeck control requires one exact loopback API request URL.",
      "--api-url"
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw configFailure(
      "Local HostDeck control requires one exact loopback API request URL.",
      "--api-url"
    );
  }
  requireLoopbackRequestUrl(url);

  const values = readExactRequestInit(init);
  const method = values.method;
  const body = values.body ?? "";
  const headers = readRequestHeaders(values.headers, method, body.length > 0);
  if ((method === "GET" && body.length !== 0) || (method === "POST" && body.length === 0)) {
    throw internalFailure("HostDeck CLI HTTP request body is invalid.");
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > limits.requestBodyMaxBytes) {
    throw clientOperationFailure(
      "request_too_large",
      "HostDeck CLI request body exceeds its selected limit."
    );
  }
  if (method === "POST") {
    try {
      JSON.parse(body);
    } catch {
      throw internalFailure("HostDeck CLI HTTP request body is invalid.");
    }
  }

  return Object.freeze({
    body,
    headers: Object.freeze({
      ...headers,
      "accept-encoding": "identity",
      connection: "close",
      ...(body.length === 0 ? {} : { "content-length": String(bodyBytes) })
    }),
    method,
    url
  });
}

function executeLoopbackRequest(
  prepared: PreparedLoopbackRequest,
  limits: LoopbackLimits,
  requestPort: LoopbackRequestPort,
  signal: AbortSignal | undefined
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let request: ClientRequest | null = null;
    let response: IncomingMessage | null = null;
    let socket: Socket | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let requestTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let connectListener: (() => void) | null = null;
    let requestSocketListener: ((assignedSocket: Socket) => void) | null = null;
    let requestErrorListener: ((error: Error) => void) | null = null;
    let responseDataListener:
      | ((chunk: Buffer | Uint8Array | string) => void)
      | null = null;
    let responseEndListener: (() => void) | null = null;
    let responseAbortedListener: (() => void) | null = null;
    let responseErrorListener: ((error: Error) => void) | null = null;
    let responseCloseListener: (() => void) | null = null;

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer !== null) clearTimeout(timer);
    };
    const cleanup = () => {
      clearTimer(connectTimer);
      clearTimer(requestTimer);
      clearTimer(idleTimer);
      connectTimer = null;
      requestTimer = null;
      idleTimer = null;
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      if (socket !== null && connectListener !== null) {
        socket.off("connect", connectListener);
      }
      if (request !== null) {
        if (requestSocketListener !== null) {
          request.off("socket", requestSocketListener);
        }
        if (requestErrorListener !== null) {
          request.off("error", requestErrorListener);
        }
      }
      if (response !== null) {
        if (responseDataListener !== null) response.off("data", responseDataListener);
        if (responseEndListener !== null) response.off("end", responseEndListener);
        if (responseAbortedListener !== null) {
          response.off("aborted", responseAbortedListener);
        }
        if (responseErrorListener !== null) response.off("error", responseErrorListener);
        if (responseCloseListener !== null) response.off("close", responseCloseListener);
      }
      connectListener = null;
      requestSocketListener = null;
      requestErrorListener = null;
      responseDataListener = null;
      responseEndListener = null;
      responseAbortedListener = null;
      responseErrorListener = null;
      responseCloseListener = null;
      socket = null;
    };
    const destroyOwnedIo = () => {
      if (response !== null && !response.destroyed) response.destroy();
      if (request !== null && !request.destroyed) request.destroy();
    };
    const settleReject = (error: CliFailure) => {
      if (settled) return;
      settled = true;
      destroyOwnedIo();
      cleanup();
      reject(error);
    };
    const settleResolve = (value: HttpResponse) => {
      if (settled) return;
      settled = true;
      destroyOwnedIo();
      cleanup();
      resolve(value);
    };
    const startIdleTimer = () => {
      clearTimer(idleTimer);
      idleTimer = setTimeout(() => {
        settleReject(timeoutFailure(prepared.method, "response stalled"));
      }, limits.responseIdleTimeoutMs);
      idleTimer.unref();
    };
    const markConnected = () => {
      if (settled || connected) return;
      connected = true;
      clearTimer(connectTimer);
      connectTimer = null;
    };
    const onAbort = () => {
      settleReject(cancelledRequestFailure(prepared.method));
    };

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
    connectTimer = setTimeout(() => {
      settleReject(
        daemonUnavailableFailure(
          new URL(prepared.url.origin),
          new Error("connect timeout")
        )
      );
    }, limits.connectTimeoutMs);
    connectTimer.unref();
    requestTimer = setTimeout(() => {
      settleReject(timeoutFailure(prepared.method, "request deadline"));
    }, limits.requestTimeoutMs);
    requestTimer.unref();

    try {
      request = requestPort(
        prepared.url,
        {
          agent: false,
          headers: prepared.headers,
          maxHeaderSize: limits.responseHeadersMaxBytes,
          method: prepared.method
        },
        (incoming) => {
          if (settled) {
            incoming.destroy();
            return;
          }
          markConnected();
          response = incoming;
          let framing: ReturnType<typeof readResponseFraming>;
          try {
            framing = readResponseFraming(incoming, limits);
          } catch {
            settleReject(
              internalFailure("HostDeck daemon returned invalid HTTP framing.")
            );
            return;
          }
          if (framing instanceof CliFailure) {
            settleReject(framing);
            return;
          }

          const bodyBuffer = Buffer.alloc(
            framing.contentLength ?? limits.responseMaxBytes
          );
          let bytes = 0;
          responseDataListener = (chunk: Buffer | Uint8Array | string) => {
            if (settled) return;
            const buffer =
              typeof chunk === "string"
                ? Buffer.from(chunk, "utf8")
                : Buffer.from(chunk);
            if (buffer.byteLength === 0) return;
            if (buffer.byteLength > limits.responseMaxBytes - bytes) {
              settleReject(oversizedResponseFailure());
              return;
            }
            buffer.copy(bodyBuffer, bytes);
            bytes += buffer.byteLength;
            startIdleTimer();
          };
          responseEndListener = () => {
            if (settled) return;
            if (incoming.rawTrailers.length !== 0) {
              settleReject(
                internalFailure("HostDeck daemon returned invalid HTTP framing.")
              );
              return;
            }
            if (
              !incoming.complete ||
              (framing.contentLength !== null && framing.contentLength !== bytes)
            ) {
              settleReject(incompleteResponseFailure(prepared.method));
              return;
            }
            let text: string;
            let payload: unknown;
            try {
              text = fatalUtf8Decoder.decode(bodyBuffer.subarray(0, bytes));
              payload = JSON.parse(text) as unknown;
            } catch {
              settleReject(
                internalFailure(
                  `HostDeck daemon returned invalid JSON for HTTP ${framing.status}.`
                )
              );
              return;
            }
            settleResolve(
              Object.freeze({
                json: async () => payload,
                ok: framing.status >= 200 && framing.status < 300,
                status: framing.status,
                text: async () => text
              })
            );
          };
          responseAbortedListener = () => {
            settleReject(incompleteResponseFailure(prepared.method));
          };
          responseErrorListener = (error) => {
            settleReject(
              isHttpParserError(error)
                ? internalFailure("HostDeck daemon returned invalid HTTP framing.")
                : incompleteResponseFailure(prepared.method)
            );
          };
          responseCloseListener = () => {
            if (!incoming.complete) {
              settleReject(incompleteResponseFailure(prepared.method));
            }
          };
          incoming.on("data", responseDataListener);
          incoming.on("end", responseEndListener);
          incoming.on("aborted", responseAbortedListener);
          incoming.on("error", responseErrorListener);
          incoming.on("close", responseCloseListener);
          startIdleTimer();
        }
      );
    } catch {
      settleReject(internalFailure("HostDeck CLI HTTP request could not be constructed."));
      return;
    }

    if (settled) {
      if (!request.destroyed) request.destroy();
      return;
    }

    requestSocketListener = (assignedSocket) => {
      if (settled) {
        assignedSocket.destroy();
        return;
      }
      if (socket !== null && connectListener !== null) {
        socket.off("connect", connectListener);
      }
      socket = assignedSocket;
      if (!assignedSocket.connecting) {
        markConnected();
        return;
      }
      connectListener = markConnected;
      assignedSocket.once("connect", connectListener);
    };
    requestErrorListener = (error) => {
      if (isHttpParserError(error)) {
        settleReject(internalFailure("HostDeck daemon returned invalid HTTP framing."));
        return;
      }
      settleReject(
        connected || response !== null
          ? incompleteResponseFailure(prepared.method)
          : daemonUnavailableFailure(new URL(prepared.url.origin), error)
      );
    };
    request.on("socket", requestSocketListener);
    request.on("error", requestErrorListener);

    try {
      if (prepared.body.length === 0) request.end();
      else request.end(prepared.body);
    } catch {
      settleReject(internalFailure("HostDeck CLI HTTP request could not be written."));
    }
  });
}

function readResponseFraming(
  response: IncomingMessage,
  limits: LoopbackLimits
):
  | { readonly contentLength: number | null; readonly status: number }
  | CliFailure {
  const status = response.statusCode;
  if (
    status === undefined ||
    !Number.isSafeInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    return internalFailure("HostDeck daemon returned an invalid HTTP status.");
  }
  if (!hasValidBoundedRawHeaders(response.rawHeaders, limits)) {
    return internalFailure("HostDeck daemon returned invalid HTTP framing.");
  }

  const contentTypes = rawHeaderValues(response.rawHeaders, "content-type");
  const contentEncodings = rawHeaderValues(response.rawHeaders, "content-encoding");
  const contentLengths = rawHeaderValues(response.rawHeaders, "content-length");
  const transferEncodings = rawHeaderValues(response.rawHeaders, "transfer-encoding");
  if (
    contentTypes.length !== 1 ||
    !jsonMediaTypePattern.test(contentTypes[0] ?? "") ||
    contentEncodings.length > 1 ||
    (contentEncodings.length === 1 && contentEncodings[0]?.toLowerCase() !== "identity") ||
    contentLengths.length > 1 ||
    transferEncodings.length > 1 ||
    contentLengths.length + transferEncodings.length !== 1 ||
    (transferEncodings.length === 1 &&
      transferEncodings[0]?.toLowerCase() !== "chunked")
  ) {
    return internalFailure("HostDeck daemon returned invalid HTTP framing.");
  }

  let contentLength: number | null = null;
  const declared = contentLengths[0];
  if (declared !== undefined) {
    if (!canonicalDecimalPattern.test(declared)) {
      return internalFailure("HostDeck daemon returned invalid HTTP framing.");
    }
    contentLength = Number(declared);
    if (!Number.isSafeInteger(contentLength)) {
      return internalFailure("HostDeck daemon returned invalid HTTP framing.");
    }
    if (contentLength > limits.responseMaxBytes) {
      return oversizedResponseFailure();
    }
  }

  return Object.freeze({ contentLength, status });
}

function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      const value = rawHeaders[index + 1];
      if (value !== undefined) values.push(value.trim());
    }
  }
  return values;
}

function hasValidBoundedRawHeaders(
  rawHeaders: readonly string[],
  limits: LoopbackLimits
): boolean {
  if (
    !Array.isArray(rawHeaders) ||
    rawHeaders.length % 2 !== 0 ||
    rawHeaders.length / 2 > limits.responseHeadersMaxCount ||
    rawHeaders.some((value) => typeof value !== "string")
  ) {
    return false;
  }
  let bytes = 2;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    bytes +=
      Buffer.byteLength(rawHeaders[index] ?? "", "latin1") +
      Buffer.byteLength(rawHeaders[index + 1] ?? "", "latin1") +
      4;
    if (bytes > limits.responseHeadersMaxBytes) return false;
  }
  return true;
}

function readExactTransportOptions(
  candidate: unknown
): Readonly<{
  budget: ResourceBudget | undefined;
  request: LoopbackRequestPort | undefined;
  signal: AbortSignal | undefined;
}> {
  const message = "HostDeck CLI loopback transport options are invalid.";
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
      })
    ) {
      throw new TypeError(message);
    }
    const budget = dataValue(descriptors.budget);
    const request = dataValue(descriptors.request);
    const signal = dataValue(descriptors.signal);
    if (
      (request !== undefined && typeof request !== "function") ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) {
      throw new TypeError(message);
    }
    return Object.freeze({
      budget: budget as ResourceBudget | undefined,
      request: request as LoopbackRequestPort | undefined,
      signal: signal as AbortSignal | undefined
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}

function readBudget(candidate: ResourceBudget | undefined): ResourceBudget {
  if (candidate === undefined) return defaultResourceBudget;
  try {
    assertResolvedResourceBudget(candidate);
    return candidate;
  } catch {
    throw new TypeError("HostDeck CLI loopback transport budget is invalid.");
  }
}

function readExactRequestInit(
  candidate: unknown
): Readonly<{
  body: string | undefined;
  headers: Readonly<Record<string, string>>;
  method: "GET" | "POST";
}> {
  const message = "HostDeck CLI HTTP request is invalid.";
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw internalFailure(message);
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length < 2 ||
      keys.length > 3 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !["body", "headers", "method"].includes(key) ||
          descriptors[key]?.enumerable !== true ||
          !("value" in (descriptors[key] ?? {}))
      )
    ) {
      throw internalFailure(message);
    }
    const method = dataValue(descriptors.method);
    const headers = dataValue(descriptors.headers);
    const body = dataValue(descriptors.body);
    const hasBody = Object.hasOwn(descriptors, "body");
    if (
      (method !== "GET" && method !== "POST") ||
      headers === null ||
      typeof headers !== "object" ||
      (body !== undefined && typeof body !== "string") ||
      (method === "GET" && hasBody) ||
      (method === "POST" && !hasBody)
    ) {
      throw internalFailure(message);
    }
    return Object.freeze({
      body: body as string | undefined,
      headers: headers as Readonly<Record<string, string>>,
      method
    });
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw internalFailure(message);
  }
}

function readRequestHeaders(
  candidate: Readonly<Record<string, string>>,
  method: "GET" | "POST",
  hasBody: boolean
): Readonly<Record<string, string>> {
  const message = "HostDeck CLI HTTP request headers are invalid.";
  try {
    if (Array.isArray(candidate)) throw internalFailure(message);
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length < 2 ||
      keys.length > 4 ||
      keys.some((key) => {
        if (
          typeof key !== "string" ||
          key !== key.toLowerCase() ||
          !allowedRequestHeaders.has(key)
        ) {
          return true;
        }
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "string" ||
          /[\r\n\0]/u.test(descriptor.value)
        );
      })
    ) {
      throw internalFailure(message);
    }
    const values = Object.fromEntries(
      keys.map((key) => [key as string, dataValue(descriptors[key as string])])
    ) as Record<string, string>;
    if (
      values.accept !== "application/json" ||
      values["cache-control"] !== "no-store" ||
      (method === "POST" && hasBody) !==
        (values["content-type"] === "application/json") ||
      (values["x-hostdeck-local-admin"] !== undefined &&
        values["x-hostdeck-local-admin"] !== "cli-v1")
    ) {
      throw internalFailure(message);
    }
    return Object.freeze(values);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw internalFailure(message);
  }
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

function timeoutFailure(
  method: "GET" | "POST",
  _stage: "request deadline" | "response stalled"
): CliFailure {
  return clientOperationFailure(
    "operation_timeout",
    "HostDeck CLI request timed out.",
    method === "GET"
  );
}

function cancelledRequestFailure(method: "GET" | "POST"): CliFailure {
  return clientOperationFailure(
    "unknown_error",
    "HostDeck CLI request was cancelled.",
    method === "GET"
  );
}

function incompleteResponseFailure(method: "GET" | "POST"): CliFailure {
  return clientOperationFailure(
    "unknown_error",
    "HostDeck CLI response ended before completion.",
    method === "GET"
  );
}

function oversizedResponseFailure(): CliFailure {
  return clientOperationFailure(
    "service_overloaded",
    "HostDeck CLI response exceeds its selected limit."
  );
}

function untypedApiFailure(status: number, context: string): CliFailure {
  return internalFailure(
    `HostDeck daemon returned an untyped HTTP ${status} ${context} error.`
  );
}

function isHttpParserError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" && code.startsWith("HPE_");
  } catch {
    return false;
  }
}

function dataValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}
