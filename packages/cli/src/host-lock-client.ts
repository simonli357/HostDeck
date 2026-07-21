import {
  type ApiErrorEnvelope,
  type SelectedHostLockRequest,
  type SelectedHostLockStateResponse,
  type SelectedHostUnlockRequest,
  selectedHostLockRequestSchema,
  selectedHostLockStateResponseSchema,
  selectedHostUnlockRequestSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import type { HttpFetch } from "./api-client.js";
import { internalFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

export interface HostDeckHostLockClient {
  readonly lock: (
    input: SelectedHostLockRequest
  ) => Promise<SelectedHostLockStateResponse>;
  readonly unlock: (
    input: SelectedHostUnlockRequest
  ) => Promise<SelectedHostLockStateResponse>;
}

export interface CreateHostDeckHostLockClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckHostLockClient(
  input: CreateHostDeckHostLockClientOptions
): HostDeckHostLockClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck host-lock base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck host-lock fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  return Object.freeze({
    async lock(input: SelectedHostLockRequest) {
      const request = parseRequest(input, true);
      return await mutateHostLock({
        baseUrl,
        expectedLocked: true,
        fetch: fetchPort,
        path: "/api/v1/access/lock",
        request
      });
    },
    async unlock(input: SelectedHostUnlockRequest) {
      const request = parseRequest(input, false);
      return await mutateHostLock({
        baseUrl,
        expectedLocked: false,
        fetch: fetchPort,
        path: "/api/v1/access/unlock",
        request
      });
    }
  });
}

async function mutateHostLock(input: {
  readonly baseUrl: URL;
  readonly expectedLocked: boolean;
  readonly fetch: HttpFetch;
  readonly path: "/api/v1/access/lock" | "/api/v1/access/unlock";
  readonly request: SelectedHostLockRequest | SelectedHostUnlockRequest;
}): Promise<SelectedHostLockStateResponse> {
  const url = new URL(input.path, input.baseUrl);
  const { payload, response } = await requestCliJson({
    baseUrl: input.baseUrl,
    context: "HostDeck host-lock",
    expectedStatus: 200,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned an invalid or uncorrelated host-lock response.",
    fetch: input.fetch,
    init: {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json",
        [hostDeckLocalAdminRequestHeaderName]:
          hostDeckLocalAdminRequestHeaderValue
      }),
      body: JSON.stringify(input.request)
    },
    url
  });
  if (!response.ok) {
    throwCliApiFailure({
      context: "host-lock",
      payload,
      sanitize: sanitizeHostLockApiError,
      status: response.status
    });
  }

  const parsed = selectedHostLockStateResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.locked !== input.expectedLocked ||
    parsed.data.authentication_state !== "local_admin" ||
    parsed.data.permission !== "local_admin" ||
    parsed.data.network_mode !== "loopback" ||
    parsed.data.transport !== "http" ||
    parsed.data.configured_origin !== input.baseUrl.origin
  ) {
    throw internalFailure(
      "HostDeck daemon returned an invalid or uncorrelated host-lock response."
    );
  }
  return parsed.data;
}

function parseRequest(
  candidate: unknown,
  locked: boolean
): SelectedHostLockRequest | SelectedHostUnlockRequest {
  const parsed = locked
    ? selectedHostLockRequestSchema.safeParse(candidate)
    : selectedHostUnlockRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("HostDeck host-lock mutation input is invalid.");
  }
  return parsed.data;
}

function sanitizeHostLockApiError(
  error: ApiErrorEnvelope
): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: hostLockErrorMessage(error.code),
    retryable: error.retryable
  });
}

function hostLockErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "permission_denied":
    case "invalid_origin":
      return "Host lock request is not permitted.";
    case "operation_conflict":
    case "host_locked":
      return "Host lock conflicts with current laptop state.";
    case "operation_timeout":
      return "Host lock request timed out.";
    case "service_overloaded":
      return "Another host lock operation is active.";
    case "audit_unavailable":
      return "Host lock audit is unavailable.";
    case "storage_error":
      return "Host lock storage is unavailable.";
    default:
      return "Host lock request failed.";
  }
}

function readExactOptions(
  candidate: unknown
): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck host-lock client options are invalid.";
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
