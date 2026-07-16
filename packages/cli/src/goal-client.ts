import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  type GoalControlSnapshot,
  type GoalMutationRequest,
  goalControlSnapshotSchema,
  goalMutationRequestSchema,
  sessionIdParamsSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { apiFailure, CliFailure, daemonUnavailableFailure, internalFailure, usageFailure } from "./errors.js";
import {
  assertCliHttpResponse,
  createBoundedLoopbackFetch,
  readCliJsonPayload,
  requireLoopbackBaseUrl
} from "./loopback-http.js";

const goalClientMutationRequestSchema = goalMutationRequestSchema.extend({
  session_id: sessionIdSchema
});

export interface HostDeckGoalClientMutationRequest extends GoalMutationRequest {
  readonly session_id: string;
}

export interface HostDeckGoalClient {
  readonly read: (sessionId: string) => Promise<GoalControlSnapshot>;
  readonly mutate: (request: HostDeckGoalClientMutationRequest) => Promise<GoalControlSnapshot>;
}

export interface CreateHostDeckGoalClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckGoalClient(input: CreateHostDeckGoalClientOptions): HostDeckGoalClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) throw new TypeError("HostDeck goal-client base URL is invalid.");
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck goal-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort = values.fetch === undefined ? createBoundedLoopbackFetch() : (values.fetch as HttpFetch);
  const client: HostDeckGoalClient = {
    async read(sessionIdCandidate) {
      const params = sessionIdParamsSchema.safeParse({ session_id: sessionIdCandidate });
      if (!params.success) throw usageFailure("Goal requires one valid managed session id.", "session");
      return await requestGoal(baseUrl, fetchPort, params.data.session_id, null);
    },
    async mutate(candidate) {
      const parsed = goalClientMutationRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure(
          "Goal mutation requires one valid session, operation id, action, objective, and expected revision.",
          "goal"
        );
      }
      return await requestGoal(baseUrl, fetchPort, parsed.data.session_id, parsed.data);
    }
  };
  return Object.freeze(client);
}

async function requestGoal(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string,
  request: HostDeckGoalClientMutationRequest | null
): Promise<GoalControlSnapshot> {
  const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, baseUrl);
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
            goalMutationRequestSchema.parse({
              operation_id: request.operation_id,
              kind: request.kind,
              action: request.action,
              objective: request.objective,
              expected_goal_revision: request.expected_goal_revision
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

  assertCliHttpResponse(response, "HostDeck goal-client");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    let parsedError: ReturnType<typeof apiRouteErrorBodySchema.safeParse>;
    try {
      parsedError = apiRouteErrorBodySchema.safeParse(payload);
    } catch {
      throw untypedError(response.status);
    }
    if (!parsedError.success) throw untypedError(response.status);
    throw apiFailure(response.status, sanitizeGoalApiError(parsedError.data.error));
  }
  if (response.status !== 200) throw invalidResponse();

  let parsed: ReturnType<typeof goalControlSnapshotSchema.safeParse>;
  try {
    parsed = goalControlSnapshotSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (!parsed.success) throw invalidResponse();
  if (request !== null) assertMutationCorrelation(parsed.data, request);
  return deepFreeze(parsed.data);
}

function assertMutationCorrelation(snapshot: GoalControlSnapshot, request: GoalMutationRequest): void {
  if (snapshot.uncertain_mutation !== null) throw invalidResponse();
  if (request.action === "clear") {
    if (snapshot.goal !== null) throw invalidResponse();
    return;
  }
  const goal = snapshot.goal;
  if (goal === null) throw invalidResponse();
  const expectedStatus =
    request.action === "resume" ? "active" : request.action === "complete" ? "complete" : "paused";
  if (goal.status !== expectedStatus) throw invalidResponse();
  if (request.action === "set" && goal.objective !== request.objective) throw invalidResponse();
  if (
    request.action === "resume" &&
    request.expected_goal_revision !== null &&
    goal.revision === request.expected_goal_revision
  ) {
    throw invalidResponse();
  }
}

function sanitizeGoalApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: goalErrorMessage(error.code),
    retryable: error.retryable
  });
}

function goalErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "validation_error":
      return "Goal action is invalid for the current goal state.";
    case "session_not_found":
      return "Managed session was not found.";
    case "session_not_writable":
      return "Managed session cannot provide goal control.";
    case "stale_session":
    case "invalid_session_id":
      return "Managed session requires reconciliation before goal control.";
    case "host_locked":
      return "The HostDeck host is locked.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "Structured goal control is unavailable for the selected runtime.";
    case "operation_conflict":
      return "Goal state changed or cannot perform this action.";
    case "unknown_error":
      return "Goal mutation outcome is unknown and requires reconciliation.";
    case "protocol_error":
      return "Codex goal state failed protocol validation.";
    case "runtime_unavailable":
      return "Codex goal control is unavailable.";
    case "audit_unavailable":
      return "Goal mutation audit is unavailable.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "operation_timeout":
      return "Goal operation timed out.";
    case "service_overloaded":
      return "Goal control capacity is exhausted.";
    case "read_only":
      return "Write permission is required to mutate a goal.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Goal control is not permitted.";
    default:
      return "Goal operation failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure("HostDeck daemon returned invalid managed-session goal data.");
}

function untypedError(status: number): CliFailure {
  return internalFailure(`HostDeck daemon returned an untyped HTTP ${status} goal error.`);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(candidate: unknown): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck goal-client options are invalid.";
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
