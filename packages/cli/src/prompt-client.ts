import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  type PromptDispatchResponse,
  type PromptSessionRequest,
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
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

const promptClientRequestSchema = promptSessionRequestSchema.extend({
  session_id: sessionIdSchema
});

export interface HostDeckPromptClientRequest extends PromptSessionRequest {
  readonly session_id: string;
}

export interface HostDeckPromptClient {
  readonly send: (
    request: HostDeckPromptClientRequest
  ) => Promise<PromptDispatchResponse>;
}

export interface CreateHostDeckPromptClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckPromptClient(
  input: CreateHostDeckPromptClientOptions
): HostDeckPromptClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck prompt-client base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck prompt-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);
  const client: HostDeckPromptClient = {
    async send(candidate) {
      const parsed = promptClientRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure(
          "Send requires one valid managed session id, operation id, and prompt text.",
          "send"
        );
      }
      return await requestPrompt(baseUrl, fetchPort, parsed.data);
    }
  };
  return Object.freeze(client);
}

async function requestPrompt(
  baseUrl: URL,
  fetchPort: HttpFetch,
  request: HostDeckPromptClientRequest
): Promise<PromptDispatchResponse> {
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(request.session_id)}/prompts`,
    baseUrl
  );
  const body = promptSessionRequestSchema.parse({
    operation_id: request.operation_id,
    kind: request.kind,
    text: request.text
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

  assertCliHttpResponse(response, "HostDeck prompt-client");
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
      sanitizePromptApiError(parsedError.data.error)
    );
  }
  if (response.status !== 202) throw invalidResponse();

  let parsed: ReturnType<typeof promptDispatchResponseSchema.safeParse>;
  try {
    parsed = promptDispatchResponseSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (
    !parsed.success ||
    parsed.data.state !== "accepted" ||
    parsed.data.kind !== "prompt" ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.target.session_id !== request.session_id
  ) {
    throw invalidResponse();
  }
  return deepFreeze(parsed.data);
}

function sanitizePromptApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: promptErrorMessage(error.code),
    retryable: error.retryable
  });
}

function promptErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "session_not_found":
      return "The managed session does not exist.";
    case "session_not_writable":
      return "The managed session cannot accept a prompt now.";
    case "stale_session":
      return "The managed session requires reconciliation before prompt dispatch.";
    case "host_locked":
      return "The HostDeck host is locked.";
    case "incompatible_runtime":
    case "capability_unavailable":
    case "protocol_error":
      return "The selected runtime cannot safely dispatch this prompt.";
    case "runtime_unavailable":
      return "The selected runtime is unavailable.";
    case "operation_conflict":
      return "Another prompt operation is active for this managed session.";
    case "unknown_error":
      return "Prompt outcome is unknown; wait for session events before another attempt.";
    case "audit_unavailable":
      return "Managed session audit is unavailable.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "operation_timeout":
      return "Prompt dispatch timed out.";
    case "service_overloaded":
      return "Prompt dispatch capacity is exhausted.";
    case "read_only":
      return "Write permission is required to dispatch a prompt.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Prompt dispatch is not permitted.";
    default:
      return "Prompt dispatch failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure(
    "HostDeck daemon returned invalid managed-session prompt data."
  );
}

function untypedError(status: number): CliFailure {
  return internalFailure(
    `HostDeck daemon returned an untyped HTTP ${status} prompt error.`
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
  const message = "HostDeck prompt-client options are invalid.";
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
