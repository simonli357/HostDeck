import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  type SelectedSessionStartResponse,
  type SelectedStartSessionRequest,
  selectedSessionStartResponseSchema,
  selectedStartSessionRequestSchema
} from "@hostdeck/contracts";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import {
  apiFailure,
  CliFailure,
  daemonUnavailableFailure,
  internalFailure,
  usageFailure
} from "./errors.js";
import {
  assertCliHttpResponse,
  createBoundedLoopbackFetch,
  readCliJsonPayload,
  requireLoopbackBaseUrl
} from "./loopback-http.js";

export interface HostDeckStartClient {
  readonly start: (
    request: SelectedStartSessionRequest
  ) => Promise<SelectedSessionStartResponse>;
}

export interface CreateHostDeckStartClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckStartClient(
  input: CreateHostDeckStartClientOptions
): HostDeckStartClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck start-client base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck start-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);
  const client: HostDeckStartClient = {
    async start(candidate) {
      const parsed = selectedStartSessionRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure(
          "Start requires a valid operation id, name, and absolute working directory.",
          "start"
        );
      }
      return await requestStart(baseUrl, fetchPort, parsed.data);
    }
  };
  return Object.freeze(client);
}

async function requestStart(
  baseUrl: URL,
  fetchPort: HttpFetch,
  request: SelectedStartSessionRequest
): Promise<SelectedSessionStartResponse> {
  const url = new URL("/api/v1/sessions", baseUrl);
  let response: HttpResponse;
  try {
    response = await Reflect.apply(fetchPort, undefined, [url.toString(), {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json"
      }),
      body: JSON.stringify(request)
    }]);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(baseUrl, error);
  }

  assertCliHttpResponse(response, "HostDeck start-client");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    let parsedError: ReturnType<typeof apiRouteErrorBodySchema.safeParse>;
    try {
      parsedError = apiRouteErrorBodySchema.safeParse(payload);
    } catch {
      throw untypedError(response.status);
    }
    if (!parsedError.success) throw untypedError(response.status);
    throw apiFailure(
      response.status,
      sanitizeStartApiError(parsedError.data.error)
    );
  }
  if (response.status !== 201) throw invalidResponse();

  let parsed: ReturnType<typeof selectedSessionStartResponseSchema.safeParse>;
  try {
    parsed = selectedSessionStartResponseSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (
    !parsed.success ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.session.name !== request.name ||
    parsed.data.session.cwd !== request.cwd
  ) {
    throw invalidResponse();
  }
  return deepFreeze(parsed.data);
}

function sanitizeStartApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: startErrorMessage(error.code),
    retryable: error.retryable
  });
}

function startErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "duplicate_session_name":
      return "A managed session with this name already exists.";
    case "invalid_cwd":
      return "The managed session working directory is unavailable.";
    case "host_locked":
      return "The HostDeck host is locked.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The selected runtime cannot start managed sessions.";
    case "runtime_unavailable":
      return "The selected runtime is unavailable.";
    case "operation_conflict":
      return "Managed session start requires recovery before another attempt.";
    case "audit_unavailable":
      return "Managed session audit is unavailable.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "operation_timeout":
      return "Managed session start timed out.";
    case "service_overloaded":
      return "Managed session start capacity is exhausted.";
    case "read_only":
      return "Write permission is required to start a managed session.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Managed session start is not permitted.";
    default:
      return "Managed session start failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure(
    "HostDeck daemon returned invalid managed-session start data."
  );
}

function untypedError(status: number): CliFailure {
  return internalFailure(
    `HostDeck daemon returned an untyped HTTP ${status} session-start error.`
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
  const message = "HostDeck start-client options are invalid.";
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
