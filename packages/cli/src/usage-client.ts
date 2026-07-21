import {
  type ApiErrorEnvelope,
  sessionIdParamsSchema,
  type UsageSnapshot,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import type { HttpFetch } from "./api-client.js";
import { internalFailure, usageFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

export interface HostDeckUsageClient {
  readonly read: (sessionId: string) => Promise<UsageSnapshot>;
}

export interface CreateHostDeckUsageClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckUsageClient(
  input: CreateHostDeckUsageClientOptions
): HostDeckUsageClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck usage-client base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck usage-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  const client: HostDeckUsageClient = {
    async read(sessionIdCandidate) {
      const params = sessionIdParamsSchema.safeParse({
        session_id: sessionIdCandidate
      });
      if (!params.success) {
        throw usageFailure(
          "Usage requires one valid managed session id.",
          "session"
        );
      }
      return await requestUsage(baseUrl, fetchPort, params.data.session_id);
    }
  };
  return Object.freeze(client);
}

async function requestUsage(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string
): Promise<UsageSnapshot> {
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/usage`,
    baseUrl
  );
  const { payload, response } = await requestCliJson({
    baseUrl,
    context: "HostDeck usage-client",
    expectedStatus: 200,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned invalid managed-session usage data.",
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
      context: "usage",
      payload,
      sanitize: sanitizeUsageApiError,
      status: response.status
    });
  }

  let parsed: ReturnType<typeof usageSnapshotSchema.safeParse>;
  try {
    parsed = usageSnapshotSchema.safeParse(payload);
  } catch {
    throw internalFailure(
      "HostDeck daemon returned invalid managed-session usage data."
    );
  }
  if (
    !parsed.success ||
    parsed.data.target.session_id !== sessionId
  ) {
    throw internalFailure(
      "HostDeck daemon returned invalid managed-session usage data."
    );
  }
  return deepFreeze(parsed.data);
}

function sanitizeUsageApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: usageErrorMessage(error.code),
    retryable: error.retryable
  });
}

function usageErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "session_not_found":
      return "Managed session was not found.";
    case "stale_session":
      return "Managed session usage state is stale.";
    case "session_not_writable":
      return "Managed session is not readable for usage.";
    case "invalid_session_id":
      return "Managed session identity changed during the usage read.";
    case "capability_unavailable":
    case "incompatible_runtime":
      return "Structured usage is unavailable for the selected runtime.";
    case "runtime_unavailable":
      return "Codex usage is unavailable.";
    case "protocol_error":
      return "Codex usage data failed protocol validation.";
    case "storage_error":
      return "Managed session state is unavailable.";
    case "operation_timeout":
      return "Usage request timed out.";
    case "service_overloaded":
      return "Usage read capacity is exhausted.";
    case "permission_denied":
    case "invalid_origin":
      return "Usage request is not permitted.";
    default:
      return "Usage request failed.";
  }
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
  const message = "HostDeck usage-client options are invalid.";
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
