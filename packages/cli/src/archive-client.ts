import {
  type ApiErrorEnvelope,
  type ArchiveSessionRequest,
  apiRouteErrorBodySchema,
  archiveSessionRequestSchema,
  type SelectedOperationDispatch,
  selectedOperationDispatchSchema,
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

const archiveClientRequestSchema = archiveSessionRequestSchema.extend({
  session_id: sessionIdSchema
});

export interface HostDeckArchiveClientRequest extends ArchiveSessionRequest {
  readonly session_id: string;
}

export interface HostDeckArchiveClient {
  readonly archive: (
    request: HostDeckArchiveClientRequest
  ) => Promise<SelectedOperationDispatch>;
}

export interface CreateHostDeckArchiveClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckArchiveClient(
  input: CreateHostDeckArchiveClientOptions
): HostDeckArchiveClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck archive-client base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck archive-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);
  const client: HostDeckArchiveClient = {
    async archive(candidate) {
      const parsed = archiveClientRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure(
          "Archive requires one valid managed session id and operation id.",
          "archive"
        );
      }
      return await requestArchive(baseUrl, fetchPort, parsed.data);
    }
  };
  return Object.freeze(client);
}

async function requestArchive(
  baseUrl: URL,
  fetchPort: HttpFetch,
  request: HostDeckArchiveClientRequest
): Promise<SelectedOperationDispatch> {
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(request.session_id)}/archive`,
    baseUrl
  );
  const body = archiveSessionRequestSchema.parse({
    operation_id: request.operation_id,
    kind: request.kind,
    confirm: request.confirm
  });
  let response: HttpResponse;
  try {
    response = await Reflect.apply(fetchPort, undefined, [url.toString(), {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json"
      }),
      body: JSON.stringify(body)
    }]);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(baseUrl, error);
  }

  assertCliHttpResponse(response, "HostDeck archive-client");
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
      sanitizeArchiveApiError(parsedError.data.error)
    );
  }
  if (response.status !== 202) throw invalidResponse();

  let parsed: ReturnType<typeof selectedOperationDispatchSchema.safeParse>;
  try {
    parsed = selectedOperationDispatchSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (
    !parsed.success ||
    parsed.data.state !== "accepted" ||
    parsed.data.kind !== "archive" ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.target.type !== "managed_session" ||
    parsed.data.target.session_id !== request.session_id
  ) {
    throw invalidResponse();
  }
  return deepFreeze(parsed.data);
}

function sanitizeArchiveApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: archiveErrorMessage(error.code),
    retryable: error.retryable
  });
}

function archiveErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "session_not_found":
      return "The managed session does not exist.";
    case "session_not_writable":
      return "The managed session is not current and idle for archive.";
    case "stale_session":
      return "The managed session requires reconciliation before archive.";
    case "host_locked":
      return "The HostDeck host is locked.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The selected runtime cannot archive this managed session.";
    case "runtime_unavailable":
      return "The selected runtime is unavailable.";
    case "operation_conflict":
      return "Managed session archive requires reconciliation before another attempt.";
    case "audit_unavailable":
      return "Managed session audit is unavailable.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "operation_timeout":
      return "Managed session archive timed out.";
    case "service_overloaded":
      return "Managed session archive capacity is exhausted.";
    case "read_only":
      return "Write permission is required to archive a managed session.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Managed session archive is not permitted.";
    default:
      return "Managed session archive failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure(
    "HostDeck daemon returned invalid managed-session archive data."
  );
}

function untypedError(status: number): CliFailure {
  return internalFailure(
    `HostDeck daemon returned an untyped HTTP ${status} session-archive error.`
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
  const message = "HostDeck archive-client options are invalid.";
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
