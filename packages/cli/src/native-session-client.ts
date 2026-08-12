import {
  type ApiErrorEnvelope,
  type NativeSessionAdoptRequest,
  type NativeSessionAdoptResponse,
  type NativeSessionDiscoveryResponse,
  type NativeSessionUnmanageRequest,
  type NativeSessionUnmanageResponse,
  nativeSessionAdoptRequestSchema,
  nativeSessionAdoptResponseSchema,
  nativeSessionContractLimits,
  nativeSessionDiscoveryRequestSchema,
  nativeSessionDiscoveryResponseSchema,
  nativeSessionUnmanageRequestSchema,
  nativeSessionUnmanageResponseSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import type { HttpFetch, HttpRequestInit } from "./api-client.js";
import { internalFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

export interface HostDeckNativeSessionDiscoveryInput {
  readonly limit: number | null;
}

export interface HostDeckNativeSessionUnmanageRequest
  extends NativeSessionUnmanageRequest {
  readonly session_id: string;
}

export interface HostDeckNativeSessionClient {
  readonly adopt: (
    request: NativeSessionAdoptRequest
  ) => Promise<NativeSessionAdoptResponse>;
  readonly discover: (
    input: HostDeckNativeSessionDiscoveryInput
  ) => Promise<NativeSessionDiscoveryResponse>;
  readonly unmanage: (
    request: HostDeckNativeSessionUnmanageRequest
  ) => Promise<NativeSessionUnmanageResponse>;
}

export interface CreateHostDeckNativeSessionClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

type NativeSessionOperation = "adopt" | "discover" | "unmanage";

interface PreparedNativeRequest {
  readonly expectedStatus: 200 | 201;
  readonly init: HttpRequestInit;
  readonly operation: NativeSessionOperation;
  readonly url: URL;
}

const optionKeys = ["baseUrl", "fetch"] as const;
const discoveryInputKeys = ["limit"] as const;
const adoptRequestKeys = ["operation_id", "thread_id", "name", "confirm_handoff"] as const;
const unmanageRequestKeys = ["session_id", "operation_id", "confirm"] as const;
const localAdminHeaders = Object.freeze({
  accept: "application/json",
  "cache-control": "no-store",
  [hostDeckLocalAdminRequestHeaderName]: hostDeckLocalAdminRequestHeaderValue
});

export function createHostDeckNativeSessionClient(
  input: CreateHostDeckNativeSessionClientOptions
): HostDeckNativeSessionClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck native-session base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck native-session fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  return Object.freeze({
    async adopt(candidate: NativeSessionAdoptRequest) {
      const request = parseAdoptRequest(candidate);
      const response = await requestNativeSession(baseUrl, fetchPort, {
        expectedStatus: 201,
        init: postInit(request),
        operation: "adopt",
        url: new URL("/api/v1/native-sessions", baseUrl)
      });
      const parsed = nativeSessionAdoptResponseSchema.safeParse(response);
      if (
        !parsed.success ||
        parsed.data.operation_id !== request.operation_id ||
        parsed.data.session.codex_thread_id !== request.thread_id ||
        parsed.data.session.name !== request.name
      ) {
        throw invalidResponse("adopt");
      }
      return deepFreeze(parsed.data);
    },

    async discover(candidate: HostDeckNativeSessionDiscoveryInput) {
      const request = parseDiscoveryInput(candidate);
      const url = new URL("/api/v1/native-sessions", baseUrl);
      if (request.limit !== undefined) {
        url.searchParams.set("limit", String(request.limit));
      }
      const response = await requestNativeSession(baseUrl, fetchPort, {
        expectedStatus: 200,
        init: Object.freeze({ method: "GET" as const, headers: localAdminHeaders }),
        operation: "discover",
        url
      });
      const parsed = nativeSessionDiscoveryResponseSchema.safeParse(response);
      if (
        !parsed.success ||
        parsed.data.limit !==
          (request.limit ?? nativeSessionContractLimits.discoveryDefaultLimit)
      ) {
        throw invalidResponse("discover");
      }
      return deepFreeze(parsed.data);
    },

    async unmanage(candidate: HostDeckNativeSessionUnmanageRequest) {
      const request = parseUnmanageRequest(candidate);
      const response = await requestNativeSession(baseUrl, fetchPort, {
        expectedStatus: 200,
        init: postInit({
          operation_id: request.operation_id,
          confirm: request.confirm
        }),
        operation: "unmanage",
        url: new URL(
          `/api/v1/sessions/${encodeURIComponent(request.session_id)}/unmanage`,
          baseUrl
        )
      });
      const parsed = nativeSessionUnmanageResponseSchema.safeParse(response);
      if (
        !parsed.success ||
        parsed.data.operation_id !== request.operation_id ||
        parsed.data.session_id !== request.session_id
      ) {
        throw invalidResponse("unmanage");
      }
      return deepFreeze(parsed.data);
    }
  });
}

async function requestNativeSession(
  baseUrl: URL,
  fetchPort: HttpFetch,
  input: PreparedNativeRequest
): Promise<unknown> {
  const { payload, response } = await requestCliJson({
    baseUrl,
    context: `HostDeck native-session ${input.operation}`,
    expectedStatus: input.expectedStatus,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned invalid or uncorrelated native-session data.",
    fetch: fetchPort,
    init: input.init,
    url: input.url
  });
  if (!response.ok) {
    throwCliApiFailure({
      context: `native-session-${input.operation}`,
      payload,
      sanitize: sanitizeNativeSessionApiError,
      status: response.status
    });
  }
  return payload;
}

function postInit(body: NativeSessionAdoptRequest | NativeSessionUnmanageRequest): HttpRequestInit {
  return Object.freeze({
    method: "POST" as const,
    headers: Object.freeze({
      ...localAdminHeaders,
      "content-type": "application/json"
    }),
    body: JSON.stringify(body)
  });
}

function parseDiscoveryInput(candidate: unknown) {
  const message = "HostDeck native-session discovery input is invalid.";
  let values: Readonly<Record<(typeof discoveryInputKeys)[number], unknown>>;
  try {
    values = readExactDataObject(candidate, discoveryInputKeys, message);
  } catch {
    throw internalFailure(message);
  }
  const parsed = nativeSessionDiscoveryRequestSchema.safeParse(
    values.limit === null ? {} : { limit: values.limit }
  );
  if (!parsed.success) {
    throw internalFailure(message);
  }
  return parsed.data;
}

function parseAdoptRequest(candidate: unknown): NativeSessionAdoptRequest {
  const message = "HostDeck native-session adoption input is invalid.";
  let values: Readonly<Record<(typeof adoptRequestKeys)[number], unknown>>;
  try {
    values = readExactDataObject(candidate, adoptRequestKeys, message);
  } catch {
    throw internalFailure(message);
  }
  const parsed = nativeSessionAdoptRequestSchema.safeParse(values);
  if (!parsed.success) {
    throw internalFailure(message);
  }
  return parsed.data;
}

function parseUnmanageRequest(
  candidate: unknown
): HostDeckNativeSessionUnmanageRequest {
  const message = "HostDeck native-session unmanage input is invalid.";
  let values: Readonly<Record<(typeof unmanageRequestKeys)[number], unknown>>;
  try {
    values = readExactDataObject(candidate, unmanageRequestKeys, message);
  } catch {
    throw internalFailure(message);
  }
  const params = sessionIdParamsSchema.safeParse({ session_id: values.session_id });
  const body = nativeSessionUnmanageRequestSchema.safeParse({
    operation_id: values.operation_id,
    confirm: values.confirm
  });
  if (!params.success || !body.success) {
    throw internalFailure(message);
  }
  return Object.freeze({ session_id: params.data.session_id, ...body.data });
}

function sanitizeNativeSessionApiError(
  error: ApiErrorEnvelope
): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: nativeSessionErrorMessage(error.code),
    retryable: error.retryable
  });
}

function nativeSessionErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "duplicate_session_name":
      return "A managed session with this name already exists.";
    case "session_not_found":
      return "Managed session does not exist.";
    case "session_not_writable":
      return "Managed session must be quiet before it can be unmanaged.";
    case "stale_session":
      return "The native session was adopted but activation requires reconciliation. Do not retry adoption.";
    case "operation_conflict":
      return "Native session state conflicts with this operation.";
    case "host_locked":
      return "The HostDeck host is locked.";
    case "incompatible_runtime":
      return "Native session administration requires a compatible Codex runtime.";
    case "runtime_unavailable":
      return "Native session administration is temporarily unavailable.";
    case "protocol_error":
      return "Codex rejected the native session operation.";
    case "operation_timeout":
      return "Native session administration timed out.";
    case "service_overloaded":
      return "Native session administration capacity is exhausted.";
    case "audit_unavailable":
      return "Native session audit is unavailable.";
    case "storage_error":
      return "Native session storage is unavailable.";
    case "permission_denied":
    case "read_only":
    case "invalid_origin":
    case "insecure_transport":
      return "Native session administration requires local CLI authority.";
    default:
      return "Native session administration failed.";
  }
}

function invalidResponse(operation: NativeSessionOperation) {
  return internalFailure(
    `HostDeck daemon returned invalid or uncorrelated native-session ${operation} data.`
  );
}

function readExactOptions(
  candidate: unknown
): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck native-session client options are invalid.";
  const values = readExactDataObject(candidate, optionKeys, message, true);
  if (!Object.hasOwn(values, "baseUrl")) throw new TypeError(message);
  return values;
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string,
  allowMissingFinalKey = false
): Readonly<Record<Key, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      (allowMissingFinalKey
        ? keys.length < expectedKeys.length - 1 || keys.length > expectedKeys.length
        : keys.length !== expectedKeys.length) ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as Key))
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [index, key] of expectedKeys.entries()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined && allowMissingFinalKey && index === expectedKeys.length - 1) {
        continue;
      }
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values) as Readonly<Record<Key, unknown>>;
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
