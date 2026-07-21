import {
  type ApiErrorEnvelope,
  type SelectedDeviceRevokeRequest,
  type SelectedDeviceRevokeResponse,
  selectedDeviceRevokeParamsSchema,
  selectedDeviceRevokeRequestSchema,
  selectedDeviceRevokeResponseSchema
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

export interface HostDeckDeviceRevokeClientRequest
  extends SelectedDeviceRevokeRequest {
  readonly device_id: string;
}

export interface HostDeckDeviceRevokeClient {
  readonly revoke: (
    input: HostDeckDeviceRevokeClientRequest
  ) => Promise<SelectedDeviceRevokeResponse>;
}

export interface CreateHostDeckDeviceRevokeClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;
const requestKeys = ["device_id", "operation_id", "confirmed"] as const;

export function createHostDeckDeviceRevokeClient(
  input: CreateHostDeckDeviceRevokeClientOptions
): HostDeckDeviceRevokeClient {
  const values = readExactDataObject(
    input,
    optionKeys,
    "HostDeck device-revoke client options are invalid.",
    false
  );
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck device-revoke base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck device-revoke fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  return Object.freeze({
    async revoke(input: HostDeckDeviceRevokeClientRequest) {
      const request = parseRevokeRequest(input);
      return await requestDeviceRevoke(baseUrl, fetchPort, request);
    }
  });
}

async function requestDeviceRevoke(
  baseUrl: URL,
  fetchPort: HttpFetch,
  request: HostDeckDeviceRevokeClientRequest
): Promise<SelectedDeviceRevokeResponse> {
  const url = new URL(
    `/api/v1/access/devices/${encodeURIComponent(request.device_id)}/revoke`,
    baseUrl
  );
  const body = selectedDeviceRevokeRequestSchema.parse({
    operation_id: request.operation_id,
    confirmed: request.confirmed
  });
  const { payload, response } = await requestCliJson({
    baseUrl,
    context: "HostDeck device-revoke",
    expectedStatus: 200,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned invalid or uncorrelated device-revoke data.",
    fetch: fetchPort,
    init: {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json",
        [hostDeckLocalAdminRequestHeaderName]:
          hostDeckLocalAdminRequestHeaderValue
      }),
      body: JSON.stringify(body)
    },
    url
  });
  if (!response.ok) {
    throwCliApiFailure({
      context: "device-revoke",
      payload,
      sanitize: sanitizeDeviceRevokeApiError,
      status: response.status
    });
  }

  let parsed: ReturnType<typeof selectedDeviceRevokeResponseSchema.safeParse>;
  try {
    parsed = selectedDeviceRevokeResponseSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (
    !parsed.success ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.device_id !== request.device_id ||
    parsed.data.self_revoked
  ) {
    throw invalidResponse();
  }
  return deepFreeze(parsed.data);
}

function parseRevokeRequest(
  candidate: unknown
): HostDeckDeviceRevokeClientRequest {
  let values: Readonly<Record<(typeof requestKeys)[number], unknown>>;
  try {
    values = readExactDataObject(
      candidate,
      requestKeys,
      "HostDeck device-revoke input is invalid."
    );
  } catch {
    throw internalFailure("HostDeck device-revoke input is invalid.");
  }
  const params = selectedDeviceRevokeParamsSchema.safeParse({
    device_id: values.device_id
  });
  const body = selectedDeviceRevokeRequestSchema.safeParse({
    operation_id: values.operation_id,
    confirmed: values.confirmed
  });
  if (!params.success || !body.success) {
    throw internalFailure("HostDeck device-revoke input is invalid.");
  }
  return Object.freeze({
    device_id: params.data.device_id,
    operation_id: body.data.operation_id,
    confirmed: body.data.confirmed
  });
}

function sanitizeDeviceRevokeApiError(
  error: ApiErrorEnvelope
): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: deviceRevokeErrorMessage(error.code),
    retryable: error.retryable
  });
}

function deviceRevokeErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "operation_conflict":
      return "Device revocation conflicts with current authority state.";
    case "read_only":
      return "Write permission is required to revoke a device.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Device revocation is not permitted.";
    case "audit_unavailable":
      return "Device revocation audit is unavailable.";
    case "storage_error":
      return "Device revocation storage is unavailable.";
    case "operation_timeout":
      return "Device revocation timed out; reconcile before retrying.";
    case "service_overloaded":
      return "Device revocation capacity is exhausted.";
    default:
      return "Device revocation failed.";
  }
}

function invalidResponse() {
  return internalFailure(
    "HostDeck daemon returned invalid or uncorrelated device-revoke data."
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string,
  allowMissingFinalKey = false
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
      (allowMissingFinalKey
        ? keys.length < expectedKeys.length - 1 || keys.length > expectedKeys.length
        : keys.length !== expectedKeys.length) ||
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
    for (const [index, key] of expectedKeys.entries()) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined &&
        allowMissingFinalKey &&
        index === expectedKeys.length - 1
      ) {
        continue;
      }
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
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
