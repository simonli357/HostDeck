import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  type SkillsSnapshot,
  sessionIdParamsSchema,
  skillsSnapshotSchema
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

export interface HostDeckSkillsClient {
  readonly list: (sessionId: string) => Promise<SkillsSnapshot>;
}

export interface CreateHostDeckSkillsClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckSkillsClient(
  input: CreateHostDeckSkillsClientOptions
): HostDeckSkillsClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck skills-client base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck skills-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);

  const client: HostDeckSkillsClient = {
    async list(sessionIdCandidate) {
      const params = sessionIdParamsSchema.safeParse({
        session_id: sessionIdCandidate
      });
      if (!params.success) {
        throw usageFailure(
          "Skills requires one valid managed session id.",
          "session"
        );
      }
      return await requestSkills(baseUrl, fetchPort, params.data.session_id);
    }
  };
  return Object.freeze(client);
}

async function requestSkills(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string
): Promise<SkillsSnapshot> {
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/skills`,
    baseUrl
  );
  let response: HttpResponse;
  try {
    response = await Reflect.apply(fetchPort, undefined, [url.toString(), {
      method: "GET",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store"
      })
    }]);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(baseUrl, error);
  }

  assertCliHttpResponse(response, "HostDeck skills-client");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    let parsedError: ReturnType<typeof apiRouteErrorBodySchema.safeParse>;
    try {
      parsedError = apiRouteErrorBodySchema.safeParse(payload);
    } catch {
      throw internalFailure(
        `HostDeck daemon returned an untyped HTTP ${response.status} skills error.`
      );
    }
    if (!parsedError.success) {
      throw internalFailure(
        `HostDeck daemon returned an untyped HTTP ${response.status} skills error.`
      );
    }
    throw apiFailure(
      response.status,
      sanitizeSkillsApiError(parsedError.data.error)
    );
  }

  let parsed: ReturnType<typeof skillsSnapshotSchema.safeParse>;
  try {
    parsed = skillsSnapshotSchema.safeParse(payload);
  } catch {
    throw internalFailure(
      "HostDeck daemon returned invalid managed-session skills data."
    );
  }
  if (!parsed.success || parsed.data.target.session_id !== sessionId) {
    throw internalFailure(
      "HostDeck daemon returned invalid managed-session skills data."
    );
  }
  return deepFreeze(parsed.data);
}

function sanitizeSkillsApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: skillsErrorMessage(error.code),
    retryable: error.retryable
  });
}

function skillsErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "session_not_found":
      return "Managed session was not found.";
    case "stale_session":
      return "Managed session skills state is stale.";
    case "session_not_writable":
      return "Managed session is not readable for skills.";
    case "invalid_session_id":
      return "Managed session identity changed during the skills read.";
    case "capability_unavailable":
    case "incompatible_runtime":
      return "Structured skills are unavailable for the selected runtime.";
    case "runtime_unavailable":
      return "Codex skills are unavailable.";
    case "protocol_error":
      return "Codex skills data failed protocol validation.";
    case "storage_error":
      return "Managed session state is unavailable.";
    case "operation_timeout":
      return "Skills request timed out.";
    case "service_overloaded":
      return "Skills read capacity is exhausted.";
    case "permission_denied":
    case "invalid_origin":
      return "Skills request is not permitted.";
    default:
      return "Skills request failed.";
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
  const message = "HostDeck skills-client options are invalid.";
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
