import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  type ModelControlSnapshot,
  type ModelSelectionRequest,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema,
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

const modelClientSelectionRequestSchema = modelSelectionRequestSchema.extend({
  session_id: sessionIdSchema
});

export interface HostDeckModelClientSelectionRequest extends ModelSelectionRequest {
  readonly session_id: string;
}

export interface HostDeckModelClient {
  readonly read: (sessionId: string) => Promise<ModelControlSnapshot>;
  readonly select: (request: HostDeckModelClientSelectionRequest) => Promise<ModelControlSnapshot>;
}

export interface CreateHostDeckModelClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckModelClient(input: CreateHostDeckModelClientOptions): HostDeckModelClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) throw new TypeError("HostDeck model-client base URL is invalid.");
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck model-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort = values.fetch === undefined ? createBoundedLoopbackFetch() : (values.fetch as HttpFetch);
  const client: HostDeckModelClient = {
    async read(sessionIdCandidate) {
      const params = sessionIdParamsSchema.safeParse({ session_id: sessionIdCandidate });
      if (!params.success) throw usageFailure("Model requires one valid managed session id.", "session");
      return await requestModel(baseUrl, fetchPort, params.data.session_id, null);
    },
    async select(candidate) {
      const parsed = modelClientSelectionRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure(
          "Model selection requires one valid session, operation id, catalog model, effort, and expected revision.",
          "model"
        );
      }
      return await requestModel(baseUrl, fetchPort, parsed.data.session_id, parsed.data);
    }
  };
  return Object.freeze(client);
}

async function requestModel(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string,
  request: HostDeckModelClientSelectionRequest | null
): Promise<ModelControlSnapshot> {
  const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/model`, baseUrl);
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
            modelSelectionRequestSchema.parse({
              operation_id: request.operation_id,
              kind: request.kind,
              model_id: request.model_id,
              reasoning_effort: request.reasoning_effort,
              expected_pending_revision: request.expected_pending_revision
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

  assertCliHttpResponse(response, "HostDeck model-client");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    let parsedError: ReturnType<typeof apiRouteErrorBodySchema.safeParse>;
    try {
      parsedError = apiRouteErrorBodySchema.safeParse(payload);
    } catch {
      throw untypedError(response.status);
    }
    if (!parsedError.success) throw untypedError(response.status);
    throw apiFailure(response.status, sanitizeModelApiError(parsedError.data.error));
  }
  if (response.status !== 200) throw invalidResponse();

  let parsed: ReturnType<typeof modelControlSnapshotSchema.safeParse>;
  try {
    parsed = modelControlSnapshotSchema.safeParse(payload);
  } catch {
    throw invalidResponse();
  }
  if (!parsed.success) throw invalidResponse();
  if (request !== null) assertSelectionCorrelation(parsed.data, request);
  return deepFreeze(parsed.data);
}

function assertSelectionCorrelation(snapshot: ModelControlSnapshot, request: ModelSelectionRequest): void {
  const model = snapshot.models.find((candidate) => candidate.id === request.model_id);
  const resolvedEffort =
    request.reasoning_effort ?? model?.reasoning_efforts.find((candidate) => candidate.is_default)?.id;
  if (model === undefined || resolvedEffort === undefined) throw invalidResponse();
  if (snapshot.pending !== null) {
    if (
      snapshot.pending.selection_operation_id !== request.operation_id ||
      snapshot.pending.model_id !== request.model_id ||
      snapshot.pending.runtime_model !== model.runtime_model ||
      snapshot.pending.reasoning_effort !== resolvedEffort ||
      snapshot.pending.catalog_state !== "available" ||
      snapshot.pending.phase !== "pending" ||
      snapshot.pending.turn_id !== null ||
      snapshot.pending.error !== null ||
      (request.expected_pending_revision !== null &&
        snapshot.pending.revision <= request.expected_pending_revision)
    ) {
      throw invalidResponse();
    }
    return;
  }
  if (
    snapshot.current.catalog_state !== "available" ||
    snapshot.current.model_id !== request.model_id ||
    snapshot.current.runtime_model !== model.runtime_model ||
    snapshot.current.reasoning_effort !== resolvedEffort
  ) {
    throw invalidResponse();
  }
}

function sanitizeModelApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: modelErrorMessage(error.code),
    retryable: error.retryable
  });
}

function modelErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "validation_error":
      return "Requested model is absent from the live catalog.";
    case "session_not_found":
      return "Managed session was not found.";
    case "session_not_writable":
      return "Managed session cannot provide model control.";
    case "stale_session":
    case "invalid_session_id":
      return "Managed session requires reconciliation before model control.";
    case "host_locked":
      return "The HostDeck host is locked.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "Structured model control is unavailable for the selected runtime.";
    case "operation_conflict":
      return "Pending model state changed or cannot be replaced.";
    case "unknown_error":
      return "Model selection state is unknown and requires reconciliation.";
    case "protocol_error":
      return "Codex model state failed protocol validation.";
    case "runtime_unavailable":
      return "Codex model control is unavailable.";
    case "audit_unavailable":
      return "Model selection audit is unavailable.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "operation_timeout":
      return "Model operation timed out.";
    case "service_overloaded":
      return "Model control capacity is exhausted.";
    case "read_only":
      return "Write permission is required to select a model.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Model control is not permitted.";
    default:
      return "Model operation failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure("HostDeck daemon returned invalid managed-session model data.");
}

function untypedError(status: number): CliFailure {
  return internalFailure(`HostDeck daemon returned an untyped HTTP ${status} model error.`);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(candidate: unknown): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck model-client options are invalid.";
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
