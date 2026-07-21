import {
  type ApiErrorEnvelope,
  type SelectedHostStatusResponse,
  selectedHostStatusResponseSchema
} from "@hostdeck/contracts";
import type { HttpFetch } from "./api-client.js";
import { internalFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

export interface HostDeckHostStatusClient {
  readonly read: () => Promise<SelectedHostStatusResponse>;
}

export interface CreateHostDeckHostStatusClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckHostStatusClient(
  input: CreateHostDeckHostStatusClientOptions
): HostDeckHostStatusClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck host-status base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck host-status fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  return Object.freeze({
    async read() {
      return await requestHostStatus(baseUrl, fetchPort);
    }
  });
}

async function requestHostStatus(
  baseUrl: URL,
  fetchPort: HttpFetch
): Promise<SelectedHostStatusResponse> {
  const url = new URL("/api/v1/host/status", baseUrl);
  const { payload, response } = await requestCliJson({
    baseUrl,
    context: "HostDeck host-status",
    expectedStatus: 200,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned invalid or uncorrelated host status.",
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
      context: "host-status",
      payload,
      sanitize: sanitizeHostStatusApiError,
      status: response.status
    });
  }

  let parsed: ReturnType<typeof selectedHostStatusResponseSchema.safeParse>;
  try {
    parsed = selectedHostStatusResponseSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (
    !parsed.success ||
    parsed.data.access.mode !== "loopback_read" ||
    parsed.data.access.network_mode !== "loopback" ||
    parsed.data.access.transport !== "http"
  ) {
    throw invalidResponse();
  }
  return deepFreeze(parsed.data);
}

function sanitizeHostStatusApiError(
  error: ApiErrorEnvelope
): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: hostStatusErrorMessage(error.code),
    retryable: error.retryable
  });
}

function hostStatusErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Host status request is not permitted.";
    case "storage_error":
      return "Host status storage is unavailable.";
    case "runtime_unavailable":
    case "protocol_error":
      return "Host status is unavailable.";
    case "operation_timeout":
      return "Host status request timed out.";
    case "service_overloaded":
      return "Host status read capacity is exhausted.";
    default:
      return "Host status request failed.";
  }
}

function invalidResponse() {
  return internalFailure(
    "HostDeck daemon returned invalid or uncorrelated host status."
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
  const message = "HostDeck host-status client options are invalid.";
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
