import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  type CompactProgressResponse,
  type CompactStartRequest,
  compactProgressResponseSchema,
  compactStartRequestSchema,
  sessionIdParamsSchema,
  sessionIdSchema
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

const compactClientStartRequestSchema = compactStartRequestSchema.extend({
  session_id: sessionIdSchema
});

export interface HostDeckCompactClientStartRequest extends CompactStartRequest {
  readonly session_id: string;
}

export interface HostDeckCompactClient {
  readonly read: (sessionId: string) => Promise<CompactProgressResponse>;
  readonly start: (request: HostDeckCompactClientStartRequest) => Promise<CompactProgressResponse>;
}

export interface CreateHostDeckCompactClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckCompactClient(input: CreateHostDeckCompactClientOptions): HostDeckCompactClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) throw new TypeError("HostDeck compact-client base URL is invalid.");
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck compact-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort = values.fetch === undefined ? createBoundedLoopbackFetch() : (values.fetch as HttpFetch);
  const client: HostDeckCompactClient = {
    async read(sessionIdCandidate) {
      const params = sessionIdParamsSchema.safeParse({ session_id: sessionIdCandidate });
      if (!params.success) throw usageFailure("Compact requires one valid managed session id.", "session");
      return await requestCompact(baseUrl, fetchPort, params.data.session_id, null);
    },
    async start(candidate) {
      const parsed = compactClientStartRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure("Compact start requires one valid session, operation id, and confirmation.", "compact");
      }
      return await requestCompact(baseUrl, fetchPort, parsed.data.session_id, parsed.data);
    }
  };
  return Object.freeze(client);
}

async function requestCompact(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string,
  request: HostDeckCompactClientStartRequest | null
): Promise<CompactProgressResponse> {
  const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/compact`, baseUrl);
  const init =
    request === null
      ? {
          method: "GET",
          headers: Object.freeze({
            accept: "application/json",
            "cache-control": "no-store"
          })
        }
      : {
          method: "POST",
          headers: Object.freeze({
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          }),
          body: JSON.stringify(
            compactStartRequestSchema.parse({
              operation_id: request.operation_id,
              kind: request.kind,
              confirm: request.confirm
            })
          )
        };
  let response: HttpResponse;
  try {
    response = await Reflect.apply(fetchPort, undefined, [url.toString(), init]);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(baseUrl, error);
  }

  assertCliHttpResponse(response, "HostDeck compact-client");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    let parsedError: ReturnType<typeof apiRouteErrorBodySchema.safeParse>;
    try {
      parsedError = apiRouteErrorBodySchema.safeParse(payload);
    } catch {
      throw untypedError(response.status);
    }
    if (!parsedError.success) throw untypedError(response.status);
    throw apiFailure(response.status, sanitizeCompactApiError(parsedError.data.error));
  }
  const expectedStatus = request === null ? 200 : 202;
  if (response.status !== expectedStatus) throw invalidResponse();

  let parsed: ReturnType<typeof compactProgressResponseSchema.safeParse>;
  try {
    parsed = compactProgressResponseSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (!parsed.success) throw invalidResponse();
  const progress = parsed.data.progress;
  if (progress !== null && progress.target.session_id !== sessionId) throw invalidResponse();
  if (request !== null) assertStartCorrelation(parsed.data, request);
  if (progress === null || progress.error === null) return deepFreeze(parsed.data);
  return deepFreeze(
    compactProgressResponseSchema.parse({
      progress: {
        ...progress,
        error: {
          code: progress.error.code,
          message: compactProgressErrorMessage(progress.error.code),
          retryable: progress.error.retryable
        }
      }
    })
  );
}

function assertStartCorrelation(response: CompactProgressResponse, request: CompactStartRequest): void {
  const progress = response.progress;
  if (
    progress === null ||
    progress.operation_id !== request.operation_id ||
    progress.kind !== "compact" ||
    progress.state !== "accepted" ||
    progress.turn_id !== null ||
    progress.error !== null
  ) {
    throw invalidResponse();
  }
}

function sanitizeCompactApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: compactErrorMessage(error.code),
    retryable: error.retryable
  });
}

function compactErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "validation_error":
      return "Compact start request is invalid.";
    case "session_not_found":
      return "Managed session was not found.";
    case "session_not_writable":
      return "Managed session cannot provide compact control.";
    case "stale_session":
    case "invalid_session_id":
      return "Managed session requires reconciliation before compact control.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "Structured compact control is unavailable for the selected runtime.";
    case "operation_conflict":
      return "Compaction conflicts with the current turn or prior compact state.";
    case "unknown_error":
      return "Compact start outcome is unknown and requires reconciliation.";
    case "protocol_error":
      return "Codex compact state failed protocol validation.";
    case "runtime_unavailable":
      return "Codex compact control is unavailable.";
    case "audit_unavailable":
      return "Compact audit is unavailable.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "operation_timeout":
      return "Compact operation timed out.";
    case "service_overloaded":
      return "Compact control capacity is exhausted.";
    case "read_only":
      return "Write permission is required to start compaction.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Compact control is not permitted.";
    default:
      return "Compact operation failed.";
  }
}

function compactProgressErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "unknown_error":
      return "Compact outcome is unknown and requires reconciliation.";
    case "operation_conflict":
      return "Compact progress conflicts with observed runtime state.";
    case "protocol_error":
      return "Codex compact lifecycle failed protocol validation.";
    case "runtime_unavailable":
      return "Codex compact lifecycle lost runtime continuity.";
    case "session_not_writable":
      return "Managed session became unavailable during compaction.";
    default:
      return "Compact progress could not be verified.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure("HostDeck daemon returned invalid managed-session compact data.");
}

function untypedError(status: number): CliFailure {
  return internalFailure(`HostDeck daemon returned an untyped HTTP ${status} compact error.`);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(candidate: unknown): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck compact-client options are invalid.";
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError(message);
  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length < 1 ||
      keys.length > optionKeys.length ||
      keys.some((key) => {
        if (typeof key !== "string" || !optionKeys.includes(key as (typeof optionKeys)[number])) return true;
        const descriptor = descriptors[key];
        return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
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
