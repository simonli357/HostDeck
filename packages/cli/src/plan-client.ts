import {
  type ApiErrorEnvelope,
  type PlanControlSnapshot,
  type PlanSelectionRequest,
  planControlSnapshotSchema,
  planSelectionRequestSchema,
  sessionIdParamsSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { HttpFetch, HttpRequestInit } from "./api-client.js";
import { type CliFailure, internalFailure, usageFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

const planClientSelectionRequestSchema = planSelectionRequestSchema.extend({
  session_id: sessionIdSchema
});

export interface HostDeckPlanClientSelectionRequest extends PlanSelectionRequest {
  readonly session_id: string;
}

export interface HostDeckPlanClient {
  readonly read: (sessionId: string) => Promise<PlanControlSnapshot>;
  readonly select: (request: HostDeckPlanClientSelectionRequest) => Promise<PlanControlSnapshot>;
}

export interface CreateHostDeckPlanClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckPlanClient(input: CreateHostDeckPlanClientOptions): HostDeckPlanClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) throw new TypeError("HostDeck plan-client base URL is invalid.");
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck plan-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort = values.fetch === undefined ? createBoundedLoopbackFetch() : (values.fetch as HttpFetch);
  const client: HostDeckPlanClient = {
    async read(sessionIdCandidate) {
      const params = sessionIdParamsSchema.safeParse({ session_id: sessionIdCandidate });
      if (!params.success) throw usageFailure("Plan requires one valid managed session id.", "session");
      return await requestPlan(baseUrl, fetchPort, params.data.session_id, null);
    },
    async select(candidate) {
      const parsed = planClientSelectionRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure(
          "Plan selection requires one valid session, operation id, action, and expected revision.",
          "plan"
        );
      }
      return await requestPlan(baseUrl, fetchPort, parsed.data.session_id, parsed.data);
    }
  };
  return Object.freeze(client);
}

async function requestPlan(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string,
  request: HostDeckPlanClientSelectionRequest | null
): Promise<PlanControlSnapshot> {
  const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/plan`, baseUrl);
  const init: HttpRequestInit =
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
            planSelectionRequestSchema.parse({
              operation_id: request.operation_id,
              kind: request.kind,
              action: request.action,
              expected_pending_revision: request.expected_pending_revision
            })
          )
        };
  const { payload, response } = await requestCliJson({
    baseUrl,
    context: "HostDeck plan-client",
    expectedStatus: 200,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned invalid managed-session Plan data.",
    fetch: fetchPort,
    init,
    url
  });
  if (!response.ok) {
    throwCliApiFailure({
      context: "Plan",
      payload,
      sanitize: sanitizePlanApiError,
      status: response.status
    });
  }
  let parsed: ReturnType<typeof planControlSnapshotSchema.safeParse>;
  try {
    parsed = planControlSnapshotSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (!parsed.success) throw invalidResponse();
  if (request !== null) assertSelectionCorrelation(parsed.data, request);
  return deepFreeze(parsed.data);
}

function assertSelectionCorrelation(snapshot: PlanControlSnapshot, request: PlanSelectionRequest): void {
  const desiredMode = request.action === "enter" ? "plan" : "default";
  if (!snapshot.modes.some((entry) => entry.mode === desiredMode)) throw invalidResponse();
  if (snapshot.pending !== null) {
    if (
      snapshot.pending.selection_operation_id !== request.operation_id ||
      snapshot.pending.mode !== desiredMode ||
      snapshot.pending.catalog_state !== "available" ||
      snapshot.pending.phase !== "pending" ||
      snapshot.pending.turn_id !== null ||
      snapshot.pending.resolved_settings !== null ||
      snapshot.pending.error !== null ||
      (request.expected_pending_revision !== null &&
        snapshot.pending.revision <= request.expected_pending_revision)
    ) {
      throw invalidResponse();
    }
    return;
  }
  if (snapshot.current.state !== "confirmed" || snapshot.current.mode !== desiredMode) {
    throw invalidResponse();
  }
}

function sanitizePlanApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: planErrorMessage(error.code),
    retryable: error.retryable
  });
}

function planErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "validation_error":
      return "Plan selection is invalid for the current state.";
    case "session_not_found":
      return "Managed session was not found.";
    case "session_not_writable":
      return "Managed session cannot provide Plan control.";
    case "stale_session":
    case "invalid_session_id":
      return "Managed session requires reconciliation before Plan control.";
    case "host_locked":
      return "The HostDeck host is locked.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "Structured Plan control is unavailable for the selected runtime.";
    case "operation_conflict":
      return "Pending Plan state changed or cannot be replaced.";
    case "unknown_error":
      return "Plan selection state is unknown and requires reconciliation.";
    case "protocol_error":
      return "Codex Plan state failed protocol validation.";
    case "runtime_unavailable":
      return "Codex Plan control is unavailable.";
    case "audit_unavailable":
      return "Plan selection audit is unavailable.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "operation_timeout":
      return "Plan operation timed out.";
    case "service_overloaded":
      return "Plan control capacity is exhausted.";
    case "read_only":
      return "Write permission is required to select Plan mode.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Plan control is not permitted.";
    default:
      return "Plan operation failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure("HostDeck daemon returned invalid managed-session Plan data.");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(candidate: unknown): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck plan-client options are invalid.";
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
