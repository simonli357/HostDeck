import {
  type ApiErrorEnvelope,
  compareSelectedSessionListSortKeys,
  decodeSelectedSessionListCursor,
  type SelectedSessionListResponse,
  selectedSessionListCursorSchema,
  selectedSessionListDefaultPageSize,
  selectedSessionListMaxPageSize,
  selectedSessionListResponseSchema,
  selectedSessionListSortKey
} from "@hostdeck/contracts";
import type { HttpFetch } from "./api-client.js";
import { internalFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

export interface HostDeckSessionListClientInput {
  readonly limit: number | null;
  readonly cursor: string | null;
}

export interface HostDeckSessionListClient {
  readonly list: (
    input: HostDeckSessionListClientInput
  ) => Promise<SelectedSessionListResponse>;
}

export interface CreateHostDeckSessionListClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;
const inputKeys = ["limit", "cursor"] as const;

export function createHostDeckSessionListClient(
  input: CreateHostDeckSessionListClientOptions
): HostDeckSessionListClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck session-list base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck session-list fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  return Object.freeze({
    async list(input: HostDeckSessionListClientInput) {
      const request = parseListInput(input);
      return await requestSessionList(baseUrl, fetchPort, request);
    }
  });
}

async function requestSessionList(
  baseUrl: URL,
  fetchPort: HttpFetch,
  request: HostDeckSessionListClientInput
): Promise<SelectedSessionListResponse> {
  const url = new URL("/api/v1/sessions", baseUrl);
  if (request.limit !== null) {
    url.searchParams.set("limit", String(request.limit));
  }
  if (request.cursor !== null) {
    url.searchParams.set("cursor", request.cursor);
  }
  const { payload, response } = await requestCliJson({
    baseUrl,
    context: "HostDeck session-list",
    expectedStatus: 200,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned invalid or uncorrelated session-list data.",
    fetch: fetchPort,
    init: {
      method: "GET",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store"
      })
    },
    url
  });
  if (!response.ok) {
    throwCliApiFailure({
      context: "session-list",
      payload,
      sanitize: sanitizeSessionListApiError,
      status: response.status
    });
  }

  let parsed: ReturnType<typeof selectedSessionListResponseSchema.safeParse>;
  try {
    parsed = selectedSessionListResponseSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (!parsed.success || !responseMatchesRequest(parsed.data, request)) {
    throw invalidResponse();
  }
  return deepFreeze(parsed.data);
}

function parseListInput(candidate: unknown): HostDeckSessionListClientInput {
  let values: Readonly<Record<(typeof inputKeys)[number], unknown>>;
  try {
    values = readExactDataObject(
      candidate,
      inputKeys,
      "HostDeck session-list input is invalid."
    );
  } catch {
    throw internalFailure("HostDeck session-list input is invalid.");
  }
  const limit = values.limit;
  const cursor = values.cursor;
  if (
    (limit !== null &&
      (typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > selectedSessionListMaxPageSize)) ||
    (cursor !== null && !selectedSessionListCursorSchema.safeParse(cursor).success)
  ) {
    throw internalFailure("HostDeck session-list input is invalid.");
  }
  return Object.freeze({ limit, cursor }) as HostDeckSessionListClientInput;
}

function responseMatchesRequest(
  response: SelectedSessionListResponse,
  request: HostDeckSessionListClientInput
): boolean {
  if (
    response.access.mode !== "loopback_read" ||
    response.access.network_mode !== "loopback" ||
    response.access.transport !== "http" ||
    response.sessions.length >
      (request.limit ?? selectedSessionListDefaultPageSize)
  ) {
    return false;
  }
  if (request.cursor === null) return true;

  let inputCursor: ReturnType<typeof decodeSelectedSessionListCursor>;
  try {
    inputCursor = decodeSelectedSessionListCursor(request.cursor);
  } catch {
    return false;
  }
  if (
    response.sessions.some(
      (item) =>
        compareSelectedSessionListSortKeys(
          inputCursor.after,
          selectedSessionListSortKey(item.session)
        ) >= 0
    )
  ) {
    return false;
  }
  if (response.next_cursor === null) return true;
  try {
    return (
      decodeSelectedSessionListCursor(response.next_cursor).order_snapshot ===
      inputCursor.order_snapshot
    );
  } catch {
    return false;
  }
}

function sanitizeSessionListApiError(
  error: ApiErrorEnvelope
): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: sessionListErrorMessage(error.code),
    retryable: error.retryable
  });
}

function sessionListErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "stale_session":
      return "Session ordering changed; request the first page again.";
    case "storage_error":
      return "Managed-session listing storage is unavailable.";
    case "operation_timeout":
      return "Managed-session listing timed out.";
    case "service_overloaded":
      return "Managed-session listing exceeds the selected capacity.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Managed-session listing is not permitted.";
    default:
      return "Managed-session listing failed.";
  }
}

function invalidResponse() {
  return internalFailure(
    "HostDeck daemon returned invalid or uncorrelated session-list data."
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(
  candidate: unknown
): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck session-list client options are invalid.";
  const values = readExactDataObject(candidate, optionKeys, message, false);
  if (!Object.hasOwn(values, "baseUrl")) {
    throw new TypeError(message);
  }
  return values;
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string,
  requireEveryKey = true
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      (requireEveryKey
        ? keys.length !== expectedKeys.length
        : keys.length < 1 || keys.length > expectedKeys.length) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !expectedKeys.includes(key as Key)
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        if (!requireEveryKey) continue;
        throw new TypeError();
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
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
