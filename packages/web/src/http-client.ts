import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  selectedCsrfGenerationHeaderName,
  selectedCsrfGenerationHeaderValueSchema,
  selectedCsrfTokenHeaderName,
  selectedRawCsrfTokenSchema
} from "@hostdeck/contracts";
import {
  type BrowserHttpClientLimits,
  browserHttpResourceRanges,
  defaultBrowserHttpClientLimits
} from "@hostdeck/contracts/browser-http-resource-policy";
import {
  type BrowserTransport,
  readSelectedBrowserOrigin
} from "./browser-origin.js";
import {
  type BrowserHttpRouteContract,
  type BrowserHttpRouteData,
  type BrowserHttpRouteId,
  type BrowserHttpRouteRequest,
  type BrowserHttpRouteRequestOptions,
  browserHttpRouteContracts
} from "./http-route-contracts.js";

export const browserHttpFailureReasons = [
  "request_contract",
  "request_too_large",
  "capacity_exhausted",
  "caller_aborted",
  "deadline_exceeded",
  "transport_unavailable",
  "invalid_response",
  "response_too_large",
  "api_error"
] as const;

export type BrowserHttpFailureReason =
  (typeof browserHttpFailureReasons)[number];
export type BrowserHttpTransport = BrowserTransport;

export interface BrowserHttpHeadersPort {
  readonly get: (name: string) => string | null;
}

export interface BrowserHttpBodyReaderPort {
  readonly read: () => Promise<{
    readonly done: boolean;
    readonly value?: Uint8Array;
  }>;
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly releaseLock: () => void;
}

export interface BrowserHttpBodyPort {
  readonly getReader: () => BrowserHttpBodyReaderPort;
}

export interface BrowserHttpResponsePort {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: BrowserHttpHeadersPort;
  readonly body: BrowserHttpBodyPort | null;
}

export interface BrowserHttpRequestInit {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly cache: "no-store";
  readonly credentials: "same-origin";
  readonly mode: "same-origin";
  readonly redirect: "error";
  readonly referrerPolicy: "no-referrer";
  readonly signal: AbortSignal;
}

export type BrowserHttpFetchPort = (
  path: string,
  init: BrowserHttpRequestInit
) => Promise<BrowserHttpResponsePort>;

export interface CreateBrowserHttpClientOptions {
  readonly origin?: string;
  readonly fetch?: BrowserHttpFetchPort;
  readonly limits?: BrowserHttpClientLimits;
}

export interface BrowserHttpRouteResponse<RouteId extends BrowserHttpRouteId> {
  readonly status: number;
  readonly data: BrowserHttpRouteData<RouteId>;
}

type BrowserHttpOptionsTuple<RouteId extends BrowserHttpRouteId> =
  BrowserHttpRouteContract<RouteId>["csrf"] extends "required_for_device"
    ? readonly [options: BrowserHttpRouteRequestOptions<RouteId>]
    : readonly [options?: BrowserHttpRouteRequestOptions<RouteId>];

export interface BrowserHttpClient {
  readonly request: <RouteId extends BrowserHttpRouteId>(
    routeId: RouteId,
    input: BrowserHttpRouteRequest<RouteId>,
    ...options: BrowserHttpOptionsTuple<RouteId>
  ) => Promise<BrowserHttpRouteResponse<RouteId>>;
}

export class HostDeckBrowserHttpError extends Error {
  readonly reason: BrowserHttpFailureReason;
  readonly routeId: BrowserHttpRouteId;
  readonly transport: BrowserHttpTransport;
  readonly status: number | null;
  readonly apiError: ApiErrorEnvelope | null;

  constructor(input: {
    readonly reason: BrowserHttpFailureReason;
    readonly routeId: BrowserHttpRouteId;
    readonly transport: BrowserHttpTransport;
    readonly status?: number | null;
    readonly apiError?: ApiErrorEnvelope | null;
  }) {
    super(messageForReason(input.reason));
    this.name = "HostDeckBrowserHttpError";
    this.reason = input.reason;
    this.routeId = input.routeId;
    this.transport = input.transport;
    this.status = input.status ?? null;
    this.apiError = input.apiError ?? null;
    Object.freeze(this);
  }
}

interface PreparedRequest {
  readonly body: string | null;
  readonly csrfGeneration: string | null;
  readonly csrfToken: string | null;
  readonly path: string;
  readonly callerSignal: AbortSignal | null;
}

interface ResponseSnapshot {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: BrowserHttpHeadersPort;
  readonly body: BrowserHttpBodyPort | null;
}

interface RequestScope {
  readonly signal: AbortSignal;
  readonly failureReason: () => "caller_aborted" | "deadline_exceeded" | null;
  readonly wait: <Value>(operation: PromiseLike<Value>) => Promise<Value>;
  readonly close: () => void;
}

type BodyReadSnapshot =
  | { readonly done: true }
  | {
      readonly done: false;
      readonly value: Uint8Array;
      readonly byteLength: number;
    };

const createOptionKeys = ["origin", "fetch", "limits"] as const;
const limitKeys = [
  "requestTimeoutMs",
  "requestBodyMaxBytes",
  "responseMaxBytes",
  "maxInFlightRequests"
] as const;
const requestOptionKeys = ["signal", "csrfToken", "csrfGeneration"] as const;
const jsonMediaTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/iu;
const canonicalDecimalPattern = /^(?:0|[1-9]\d*)$/u;
const pathParameterPattern = /:([a-z][a-z0-9_]*)/gu;
const maximumRequestTreeDepth = 20;
const maximumRequestTreeNodes = 20_000;

export function createBrowserHttpClient(
  input: CreateBrowserHttpClientOptions = {}
): BrowserHttpClient {
  const options = readCreateOptions(input);
  const origin = readSelectedBrowserOrigin(options.origin);
  const fetchPort = readFetchPort(options.fetch);
  const limits = readLimits(options.limits);
  let inFlightRequests = 0;

  return Object.freeze({
    async request<RouteId extends BrowserHttpRouteId>(
      routeId: RouteId,
      requestInput: BrowserHttpRouteRequest<RouteId>,
      ...optionArguments: BrowserHttpOptionsTuple<RouteId>
    ): Promise<BrowserHttpRouteResponse<RouteId>> {
      const contract = readRouteContract(routeId);
      const prepared = prepareRequest(
        contract,
        requestInput,
        optionArguments as readonly unknown[],
        limits,
        origin.transport
      );
      if (
        prepared.callerSignal !== null &&
        readAbortSignalState(prepared.callerSignal)
      ) {
        throw failure(routeId, origin.transport, "caller_aborted");
      }
      if (inFlightRequests >= limits.maxInFlightRequests) {
        throw failure(routeId, origin.transport, "capacity_exhausted");
      }

      inFlightRequests += 1;
      let scope: RequestScope | null = null;
      try {
        scope = createRequestScope(
          prepared.callerSignal,
          limits.requestTimeoutMs
        );
        const headers: Record<string, string> = {
          accept: "application/json",
          "cache-control": "no-store"
        };
        if (prepared.body !== null) headers["content-type"] = "application/json";
        if (prepared.csrfToken !== null && prepared.csrfGeneration !== null) {
          headers[selectedCsrfTokenHeaderName] = prepared.csrfToken;
          headers[selectedCsrfGenerationHeaderName] = prepared.csrfGeneration;
        }
        const requestInit: BrowserHttpRequestInit = {
          method: contract.method,
          headers: Object.freeze(headers),
          ...(prepared.body === null ? {} : { body: prepared.body }),
          cache: "no-store",
          credentials: "same-origin",
          mode: "same-origin",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: scope.signal
        };

        let responseCandidate: BrowserHttpResponsePort;
        try {
          const pending = Reflect.apply(fetchPort, undefined, [
            prepared.path,
            requestInit
          ]) as PromiseLike<BrowserHttpResponsePort>;
          responseCandidate = await scope.wait(pending);
        } catch (error) {
          if (error instanceof HostDeckBrowserHttpError) throw error;
          const aborted = scope.failureReason();
          throw failure(
            routeId,
            origin.transport,
            aborted ?? "transport_unavailable"
          );
        }

        const response = snapshotResponse(responseCandidate);
        if (response === null) {
          throw failure(routeId, origin.transport, "invalid_response");
        }
        const payload = await readBoundedJson(
          response,
          scope,
          limits.responseMaxBytes,
          routeId,
          origin.transport
        );
        if (contract.response.statuses.includes(response.status as never)) {
          const parsed = safeParse(contract.response.schema, payload);
          if (!parsed.ok) {
            throw failure(routeId, origin.transport, "invalid_response", response.status);
          }
          return deepFreeze({
            status: response.status,
            data: parsed.value
          }) as BrowserHttpRouteResponse<RouteId>;
        }
        if (response.status < 400 || response.status > 599) {
          throw failure(routeId, origin.transport, "invalid_response", response.status);
        }
        const errorBody = safeParse(apiRouteErrorBodySchema, payload);
        if (!errorBody.ok) {
          throw failure(routeId, origin.transport, "invalid_response", response.status);
        }
        throw failure(
          routeId,
          origin.transport,
          "api_error",
          response.status,
          deepFreeze(
            (errorBody.value as { readonly error: ApiErrorEnvelope }).error
          )
        );
      } finally {
        scope?.close();
        inFlightRequests -= 1;
      }
    }
  });
}

function prepareRequest<RouteId extends BrowserHttpRouteId>(
  contract: BrowserHttpRouteContract<RouteId>,
  input: unknown,
  optionArguments: readonly unknown[],
  limits: BrowserHttpClientLimits,
  transport: BrowserHttpTransport
): PreparedRequest {
  try {
    return prepareRequestValue(
      contract,
      input,
      optionArguments,
      limits,
      transport
    );
  } catch (error) {
    if (error instanceof HostDeckBrowserHttpError) throw error;
    throw failure(contract.id, transport, "request_contract");
  }
}

function prepareRequestValue<RouteId extends BrowserHttpRouteId>(
  contract: BrowserHttpRouteContract<RouteId>,
  input: unknown,
  optionArguments: readonly unknown[],
  limits: BrowserHttpClientLimits,
  transport: BrowserHttpTransport
): PreparedRequest {
  const requiredFields = [
    ...(contract.request.params === null ? [] : ["params"]),
    ...(contract.request.query === null ? [] : ["query"]),
    ...(contract.request.body === null ? [] : ["body"])
  ];
  const values = readExactRecord(input, requiredFields, requiredFields);
  if (values === null) {
    throw failure(contract.id, transport, "request_contract");
  }

  let path = contract.path as string;
  if (contract.request.params !== null) {
    const parameterKeys = [...path.matchAll(pathParameterPattern)].map(
      (match) => match[1]
    );
    if (parameterKeys.some((key) => key === undefined)) {
      throw failure(contract.id, transport, "request_contract");
    }
    const snapshot = snapshotJsonData(values.params);
    const params = safeParse(contract.request.params.schema, snapshot);
    if (!params.ok || params.value === null || typeof params.value !== "object") {
      throw failure(contract.id, transport, "request_contract");
    }
    for (const key of parameterKeys as string[]) {
      const value = (params.value as Record<string, unknown>)[key];
      if (typeof value !== "string") {
        throw failure(contract.id, transport, "request_contract");
      }
      path = path.replace(`:${key}`, encodeURIComponent(value));
    }
  }
  if (path.includes(":")) {
    throw failure(contract.id, transport, "request_contract");
  }

  if (contract.request.query !== null) {
    const queryKeys = contract.request.queryKeys as readonly string[];
    const query = readExactRecord(values.query, [], queryKeys);
    if (query === null) {
      throw failure(contract.id, transport, "request_contract");
    }
    const parsedQuery = safeParse(contract.request.query.schema, query);
    if (!parsedQuery.ok) {
      throw failure(contract.id, transport, "request_contract");
    }
    const search = new URLSearchParams();
    for (const key of queryKeys) {
      if (!Object.hasOwn(query, key)) continue;
      const value = query[key];
      if (typeof value !== "string") {
        throw failure(contract.id, transport, "request_contract");
      }
      search.append(key, value);
    }
    const serialized = search.toString();
    if (serialized.length > 0) path = `${path}?${serialized}`;
  }

  let body: string | null = null;
  if (contract.request.body !== null) {
    const snapshot = snapshotJsonData(values.body);
    const parsedBody = safeParse(contract.request.body.schema, snapshot);
    if (!parsedBody.ok) {
      throw failure(contract.id, transport, "request_contract");
    }
    try {
      body = JSON.stringify(parsedBody.value);
    } catch {
      throw failure(contract.id, transport, "request_contract");
    }
    if (new TextEncoder().encode(body).byteLength > limits.requestBodyMaxBytes) {
      body = null;
      throw failure(contract.id, transport, "request_too_large");
    }
  }

  const optionValue = optionArguments.length === 0 ? undefined : optionArguments[0];
  if (optionArguments.length > 1) {
    throw failure(contract.id, transport, "request_contract");
  }
  const requiresCsrf = contract.csrf === "required_for_device";
  const allowedOptionKeys = requiresCsrf
    ? requestOptionKeys
    : (["signal"] as const);
  const requiredOptionKeys = requiresCsrf
    ? (["csrfToken", "csrfGeneration"] as const)
    : ([] as const);
  const optionRecord: Readonly<Record<string, unknown>> | null =
    optionValue === undefined && !requiresCsrf
      ? Object.freeze({})
      : readExactRecord(optionValue, requiredOptionKeys, allowedOptionKeys);
  if (optionRecord === null) {
    throw failure(contract.id, transport, "request_contract");
  }
  const callerSignal = optionRecord.signal;
  if (callerSignal !== undefined && !isAbortSignal(callerSignal)) {
    throw failure(contract.id, transport, "request_contract");
  }

  let csrfToken: string | null = null;
  let csrfGeneration: string | null = null;
  if (requiresCsrf) {
    const token = selectedRawCsrfTokenSchema.safeParse(optionRecord.csrfToken);
    const generation = selectedCsrfGenerationHeaderValueSchema.safeParse(
      optionRecord.csrfGeneration
    );
    if (!token.success || !generation.success) {
      throw failure(contract.id, transport, "request_contract");
    }
    csrfToken = token.data;
    csrfGeneration = String(generation.data);
  }

  return Object.freeze({
    body,
    csrfGeneration,
    csrfToken,
    path,
    callerSignal: (callerSignal as AbortSignal | undefined) ?? null
  });
}

async function readBoundedJson(
  response: ResponseSnapshot,
  scope: RequestScope,
  maximumBytes: number,
  routeId: BrowserHttpRouteId,
  transport: BrowserHttpTransport
): Promise<unknown> {
  let contentType: string | null;
  let declaredLength: string | null;
  try {
    contentType = response.headers.get("content-type");
    declaredLength = response.headers.get("content-length");
  } catch {
    cancelBody(response.body);
    throw failure(routeId, transport, "invalid_response", response.status);
  }
  if (typeof contentType !== "string" || !jsonMediaTypePattern.test(contentType)) {
    cancelBody(response.body);
    throw failure(routeId, transport, "invalid_response", response.status);
  }
  if (declaredLength !== null) {
    if (
      !canonicalDecimalPattern.test(declaredLength) ||
      !Number.isSafeInteger(Number(declaredLength))
    ) {
      cancelBody(response.body);
      throw failure(routeId, transport, "invalid_response", response.status);
    }
    if (Number(declaredLength) > maximumBytes) {
      cancelBody(response.body);
      throw failure(routeId, transport, "response_too_large", response.status);
    }
  }
  if (response.body === null) {
    throw failure(routeId, transport, "invalid_response", response.status);
  }

  let reader: BrowserHttpBodyReaderPort;
  try {
    const candidate = response.body.getReader();
    const snapshot = snapshotBodyReader(candidate);
    if (snapshot === null) {
      throw new TypeError("HostDeck browser response reader is invalid.");
    }
    reader = snapshot;
  } catch {
    throw failure(routeId, transport, "invalid_response", response.status);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let terminalError: HostDeckBrowserHttpError | null = null;
  while (terminalError === null) {
    let chunk: BodyReadSnapshot | null;
    try {
      chunk = snapshotBodyRead(await scope.wait(reader.read()));
    } catch {
      const aborted = scope.failureReason();
      terminalError = failure(
        routeId,
        transport,
        aborted ?? "invalid_response",
        response.status
      );
      break;
    }
    if (chunk === null) {
      terminalError = failure(
        routeId,
        transport,
        "invalid_response",
        response.status
      );
      break;
    }
    if (chunk.done) break;
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      terminalError = failure(
        routeId,
        transport,
        "response_too_large",
        response.status
      );
      break;
    }
    chunks.push(chunk.value);
  }

  if (terminalError !== null) cancelReader(reader);
  const released = releaseReader(reader);
  if (terminalError !== null) {
    zeroChunks(chunks);
    throw terminalError;
  }
  if (!released) {
    zeroChunks(chunks);
    throw failure(routeId, transport, "invalid_response", response.status);
  }

  let joined: Uint8Array;
  try {
    joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += readUint8ArrayByteLength(chunk);
    }
  } catch {
    zeroChunks(chunks);
    throw failure(routeId, transport, "invalid_response", response.status);
  }
  zeroChunks(chunks);
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
    joined.fill(0);
    const value = JSON.parse(text) as unknown;
    text = "";
    return value;
  } catch {
    joined.fill(0);
    text = "";
    throw failure(routeId, transport, "invalid_response", response.status);
  }
}

function createRequestScope(
  callerSignal: AbortSignal | null,
  timeoutMs: number
): RequestScope {
  const controller = new AbortController();
  let reason: "caller_aborted" | "deadline_exceeded" | null = null;
  let closed = false;
  let rejectAbort: ((error: Error) => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onInternalAbort = () => {
    rejectAbort?.(new Error("HostDeck browser HTTP request ended."));
  };
  const onCallerAbort = () => {
    if (reason !== null || closed) return;
    reason = "caller_aborted";
    controller.abort();
  };
  controller.signal.addEventListener("abort", onInternalAbort, { once: true });
  if (callerSignal !== null) {
    addAbortSignalListener(callerSignal, onCallerAbort);
    if (readAbortSignalState(callerSignal)) onCallerAbort();
  }
  const timer = setTimeout(() => {
    if (reason !== null || closed) return;
    reason = "deadline_exceeded";
    controller.abort();
  }, timeoutMs);

  return Object.freeze({
    signal: controller.signal,
    failureReason: () => reason,
    async wait<Value>(operation: PromiseLike<Value>): Promise<Value> {
      return await Promise.race([Promise.resolve(operation), abortPromise]);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (callerSignal !== null) {
        removeAbortSignalListener(callerSignal, onCallerAbort);
      }
      controller.signal.removeEventListener("abort", onInternalAbort);
      rejectAbort = null;
    }
  });
}

function readRouteContract<RouteId extends BrowserHttpRouteId>(
  routeId: RouteId
): BrowserHttpRouteContract<RouteId> {
  if (
    typeof routeId !== "string" ||
    !Object.hasOwn(browserHttpRouteContracts, routeId)
  ) {
    throw new TypeError("HostDeck browser HTTP route id is invalid.");
  }
  return browserHttpRouteContracts[routeId];
}

function readFetchPort(candidate: unknown): BrowserHttpFetchPort {
  if (candidate !== undefined) {
    if (typeof candidate !== "function") {
      throw new TypeError("HostDeck browser fetch port is invalid.");
    }
    return candidate as BrowserHttpFetchPort;
  }
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("HostDeck browser fetch is unavailable.");
  }
  return (path, init) =>
    globalThis.fetch(path, init as RequestInit) as Promise<BrowserHttpResponsePort>;
}

function readCreateOptions(
  candidate: unknown
): Readonly<Record<(typeof createOptionKeys)[number], unknown>> {
  const values = readExactRecord(candidate, [], createOptionKeys);
  if (values === null) {
    throw new TypeError("HostDeck browser HTTP client options are invalid.");
  }
  return Object.freeze({
    origin: values.origin,
    fetch: values.fetch,
    limits: values.limits
  });
}

function readLimits(candidate: unknown): BrowserHttpClientLimits {
  if (candidate === undefined) return defaultBrowserHttpClientLimits;
  const values = readExactRecord(candidate, limitKeys, limitKeys);
  if (values === null) {
    throw new TypeError("HostDeck browser HTTP client limits are invalid.");
  }
  const limits = {
    requestTimeoutMs: values.requestTimeoutMs,
    requestBodyMaxBytes: values.requestBodyMaxBytes,
    responseMaxBytes: values.responseMaxBytes,
    maxInFlightRequests: values.maxInFlightRequests
  };
  const ranges = {
    requestTimeoutMs: browserHttpResourceRanges.requestTimeoutMs,
    requestBodyMaxBytes: browserHttpResourceRanges.requestBodyMaxBytes,
    responseMaxBytes: browserHttpResourceRanges.responseMaxBytes,
    maxInFlightRequests: browserHttpResourceRanges.maxInFlightRequests
  } as const;
  for (const key of limitKeys) {
    const value = limits[key];
    const range = ranges[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < range.minimum ||
      value > range.maximum
    ) {
      throw new TypeError("HostDeck browser HTTP client limits are invalid.");
    }
  }
  return Object.freeze(limits) as BrowserHttpClientLimits;
}

function snapshotResponse(candidate: unknown): ResponseSnapshot | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const value = candidate as Partial<BrowserHttpResponsePort>;
    const status = value.status;
    const ok = value.ok;
    const headers = value.headers;
    const body = value.body;
    if (
      typeof status !== "number" ||
      !Number.isSafeInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof ok !== "boolean" ||
      ok !== (status >= 200 && status < 300) ||
      headers === null ||
      typeof headers !== "object" ||
      body === undefined ||
      (body !== null && typeof body !== "object")
    ) {
      return null;
    }
    const getHeader = headers.get;
    const getReader = body === null ? null : body.getReader;
    if (
      typeof getHeader !== "function" ||
      (body !== null && typeof getReader !== "function")
    ) {
      return null;
    }
    return Object.freeze({
      status,
      ok,
      headers: Object.freeze({
        get: (name: string) =>
          Reflect.apply(getHeader, headers, [name]) as string | null
      }),
      body:
        body === null
          ? null
          : Object.freeze({
              getReader: () =>
                Reflect.apply(getReader as BrowserHttpBodyPort["getReader"], body, [])
            })
    });
  } catch {
    return null;
  }
}

function snapshotBodyReader(candidate: unknown): BrowserHttpBodyReaderPort | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const value = candidate as Partial<BrowserHttpBodyReaderPort>;
    const read = value.read;
    const cancel = value.cancel;
    const releaseLock = value.releaseLock;
    if (
      typeof read !== "function" ||
      typeof cancel !== "function" ||
      typeof releaseLock !== "function"
    ) {
      return null;
    }
    return Object.freeze({
      read: () =>
        Reflect.apply(read, candidate, []) as ReturnType<
          BrowserHttpBodyReaderPort["read"]
        >,
      cancel: (reason?: unknown) =>
        Reflect.apply(cancel, candidate, [reason]) as Promise<void>,
      releaseLock: () => {
        Reflect.apply(releaseLock, candidate, []);
      }
    });
  } catch {
    return null;
  }
}

function snapshotBodyRead(candidate: unknown): BodyReadSnapshot | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const value = candidate as {
      readonly done?: unknown;
      readonly value?: unknown;
    };
    const done = value.done;
    if (done === true) return Object.freeze({ done: true });
    if (done !== false || !(value.value instanceof Uint8Array)) return null;
    const byteLength = readUint8ArrayByteLength(value.value);
    if (byteLength <= 0) return null;
    return Object.freeze({
      done: false,
      value: value.value,
      byteLength
    });
  } catch {
    return null;
  }
}

function readUint8ArrayByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const getter = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "byteLength"
  )?.get;
  if (typeof getter !== "function") {
    throw new TypeError("Uint8Array byte length is unavailable.");
  }
  const byteLength = Reflect.apply(getter, value, []) as unknown;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength)) {
    throw new TypeError("Uint8Array byte length is invalid.");
  }
  return byteLength;
}

function snapshotJsonData(candidate: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > maximumRequestTreeNodes || depth > maximumRequestTreeDepth) {
      throw new TypeError("HostDeck browser HTTP request data is invalid.");
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value !== "object" || seen.has(value)) {
      throw new TypeError("HostDeck browser HTTP request data is invalid.");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const ownKeys = Reflect.ownKeys(descriptors);
        const length = value.length;
        if (
          !Number.isSafeInteger(length) ||
          length > maximumRequestTreeNodes ||
          ownKeys.length !== length + 1 ||
          ownKeys.some(
            (key) =>
              typeof key !== "string" ||
              (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))
          )
        ) {
          throw new TypeError("HostDeck browser HTTP request data is invalid.");
        }
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new TypeError("HostDeck browser HTTP request data is invalid.");
          }
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        ownKeys.some((key) => typeof key !== "string")
      ) {
        throw new TypeError("HostDeck browser HTTP request data is invalid.");
      }
      const result: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const key of ownKeys as string[]) {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          descriptor.value === undefined
        ) {
          throw new TypeError("HostDeck browser HTTP request data is invalid.");
        }
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  };
  return visit(candidate, 0);
}

function readExactRecord(
  candidate: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !allowedKeys.includes(key) ||
          descriptors[key] === undefined ||
          !descriptors[key].enumerable ||
          !("value" in descriptors[key])
      ) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => [key, descriptors[key as string]?.value])
      )
    );
  } catch {
    return null;
  }
}

function safeParse(
  schema: { readonly safeParse: (value: unknown) => unknown },
  value: unknown
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const result = schema.safeParse(value) as
      | { readonly success: true; readonly data: unknown }
      | { readonly success: false };
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  if (candidate === null || typeof candidate !== "object") return false;
  try {
    readAbortSignalState(candidate as AbortSignal);
    return true;
  } catch {
    return false;
  }
}

function readAbortSignalState(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted"
  )?.get;
  if (typeof getter !== "function") {
    throw new TypeError("AbortSignal state is unavailable.");
  }
  const aborted = Reflect.apply(getter, signal, []) as unknown;
  if (typeof aborted !== "boolean") {
    throw new TypeError("AbortSignal state is invalid.");
  }
  return aborted;
}

function addAbortSignalListener(
  signal: AbortSignal,
  listener: () => void
): void {
  Reflect.apply(EventTarget.prototype.addEventListener, signal, [
    "abort",
    listener,
    { once: true }
  ]);
}

function removeAbortSignalListener(
  signal: AbortSignal,
  listener: () => void
): void {
  try {
    Reflect.apply(EventTarget.prototype.removeEventListener, signal, [
      "abort",
      listener
    ]);
  } catch {
    // Scope cleanup must not replace the request's terminal result.
  }
}

function cancelBody(body: BrowserHttpBodyPort | null): void {
  if (body === null) return;
  let reader: BrowserHttpBodyReaderPort;
  try {
    const snapshot = snapshotBodyReader(body.getReader());
    if (snapshot === null) return;
    reader = snapshot;
  } catch {
    // The response is already rejected and no cancellation detail is public.
    return;
  }
  cancelReader(reader);
  releaseReader(reader);
}

function cancelReader(reader: BrowserHttpBodyReaderPort): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // The response is already rejected and no cancellation detail is public.
  }
}

function releaseReader(reader: BrowserHttpBodyReaderPort): boolean {
  try {
    reader.releaseLock();
    return true;
  } catch {
    return false;
  }
}

function zeroChunks(chunks: readonly Uint8Array[]): void {
  for (const chunk of chunks) {
    try {
      Uint8Array.prototype.fill.call(chunk, 0);
    } catch {
      // The response has already failed and detached bytes cannot be retained here.
    }
  }
}

function failure(
  routeId: BrowserHttpRouteId,
  transport: BrowserHttpTransport,
  reason: BrowserHttpFailureReason,
  status: number | null = null,
  apiError: ApiErrorEnvelope | null = null
): HostDeckBrowserHttpError {
  return new HostDeckBrowserHttpError({
    reason,
    routeId,
    transport,
    status,
    apiError
  });
}

function messageForReason(reason: BrowserHttpFailureReason): string {
  switch (reason) {
    case "request_contract":
      return "HostDeck browser request is invalid.";
    case "request_too_large":
      return "HostDeck browser request exceeds its selected limit.";
    case "capacity_exhausted":
      return "HostDeck browser request capacity is exhausted.";
    case "caller_aborted":
      return "HostDeck browser request was cancelled.";
    case "deadline_exceeded":
      return "HostDeck browser request timed out.";
    case "transport_unavailable":
      return "HostDeck browser transport is unavailable.";
    case "invalid_response":
      return "HostDeck returned an invalid browser response.";
    case "response_too_large":
      return "HostDeck browser response exceeds its selected limit.";
    case "api_error":
      return "HostDeck API rejected the browser request.";
  }
}

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
