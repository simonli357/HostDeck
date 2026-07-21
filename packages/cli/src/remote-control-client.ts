import {
  type ApiErrorEnvelope,
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
import type { HttpFetch } from "./api-client.js";
import { internalFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

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
  const { payload, response } = await requestCliJson({
    baseUrl: input.baseUrl,
    context: "HostDeck remote-control",
    expectedStatus: 200,
    invalidSuccessStatusMessage: "HostDeck daemon returned an invalid remote-control state.",
    fetch: input.fetch,
    init: {
      method: input.method,
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...input.headers
      }),
      ...(body === undefined ? {} : { body })
    },
    url
  });
  if (!response.ok) {
    throwCliApiFailure({
      context: "remote-control",
      payload,
      sanitize: sanitizeRemoteApiError,
      status: response.status
    });
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
