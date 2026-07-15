import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  type SelectedResumeMetadataResponse,
  selectedResumeMetadataResponseSchema,
  selectedResumeParamsSchema
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

export interface HostDeckResumeClient {
  readonly read: (sessionId: string) => Promise<SelectedResumeMetadataResponse>;
}

export interface CreateHostDeckResumeClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckResumeClient(
  input: CreateHostDeckResumeClientOptions
): HostDeckResumeClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck resume-client base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck resume-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  const client: HostDeckResumeClient = {
    async read(sessionIdCandidate) {
      const params = selectedResumeParamsSchema.safeParse({
        session_id: sessionIdCandidate
      });
      if (!params.success) {
        throw usageFailure(
          "Laptop resume requires one valid managed session id.",
          "session"
        );
      }
      return await requestResumeMetadata(
        baseUrl,
        fetchPort,
        params.data.session_id
      );
    }
  };
  return Object.freeze(client);
}

async function requestResumeMetadata(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string
): Promise<SelectedResumeMetadataResponse> {
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/resume`,
    baseUrl
  );
  let response: HttpResponse;
  try {
    response = await fetchPort(url.toString(), {
      method: "GET",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store"
      })
    });
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(baseUrl, error);
  }

  assertCliHttpResponse(response, "HostDeck resume-client");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    const parsedError = apiRouteErrorBodySchema.safeParse(payload);
    if (!parsedError.success) {
      throw internalFailure(
        `HostDeck daemon returned an untyped HTTP ${response.status} resume error.`
      );
    }
    throw apiFailure(
      response.status,
      sanitizeResumeApiError(parsedError.data.error)
    );
  }

  const parsed = selectedResumeMetadataResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.session_id !== sessionId) {
    throw internalFailure(
      "HostDeck daemon returned invalid managed-thread resume metadata."
    );
  }
  return deepFreeze(parsed.data);
}

function sanitizeResumeApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: resumeErrorMessage(error.code),
    retryable: error.retryable
  });
}

function resumeErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "session_not_found":
      return "Managed session was not found.";
    case "stale_session":
    case "session_not_writable":
      return "Managed session is not eligible for laptop resume.";
    case "runtime_unavailable":
    case "incompatible_runtime":
    case "missing_binary":
    case "capability_unavailable":
      return "Laptop resume is unavailable for the selected runtime.";
    case "storage_error":
      return "Managed session state is unavailable.";
    case "operation_timeout":
      return "Laptop resume metadata request timed out.";
    case "service_overloaded":
      return "Laptop resume metadata is temporarily unavailable.";
    case "permission_denied":
    case "invalid_origin":
      return "Laptop resume metadata request is not permitted.";
    default:
      return "Laptop resume metadata request failed.";
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
  const message = "HostDeck resume-client options are invalid.";
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
