import {
  type ApiErrorEnvelope,
  type ApprovalResponseRequest,
  apiRouteErrorBodySchema,
  approvalResponseRequestSchema,
  type PendingApprovalListResponse,
  type PendingApprovalResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  runtimeRequestIdSchema,
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

const approvalClientResponseRequestSchema = approvalResponseRequestSchema.extend({
  session_id: sessionIdSchema,
  request_id: runtimeRequestIdSchema
});

export interface HostDeckApprovalClientResponseRequest extends ApprovalResponseRequest {
  readonly session_id: string;
  readonly request_id: string;
}

export interface HostDeckApprovalClient {
  readonly list: (sessionId: string) => Promise<PendingApprovalListResponse>;
  readonly respond: (request: HostDeckApprovalClientResponseRequest) => Promise<PendingApprovalResponse>;
}

export interface CreateHostDeckApprovalClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckApprovalClient(input: CreateHostDeckApprovalClientOptions): HostDeckApprovalClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) throw new TypeError("HostDeck approval-client base URL is invalid.");
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck approval-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort = values.fetch === undefined ? createBoundedLoopbackFetch() : (values.fetch as HttpFetch);
  return Object.freeze({
    async list(sessionIdCandidate: string) {
      const params = sessionIdParamsSchema.safeParse({ session_id: sessionIdCandidate });
      if (!params.success) throw usageFailure("Approvals requires one valid managed session id.", "session");
      return await requestApprovals(baseUrl, fetchPort, params.data.session_id, null);
    },
    async respond(candidate: HostDeckApprovalClientResponseRequest) {
      const parsed = approvalClientResponseRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure("Approval response requires a valid session, request, decision, operation id, and confirmation.", "approvals");
      }
      return await requestApprovals(baseUrl, fetchPort, parsed.data.session_id, parsed.data);
    }
  });
}

async function requestApprovals(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string,
  request: null
): Promise<PendingApprovalListResponse>;
async function requestApprovals(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string,
  request: HostDeckApprovalClientResponseRequest
): Promise<PendingApprovalResponse>;
async function requestApprovals(
  baseUrl: URL,
  fetchPort: HttpFetch,
  sessionId: string,
  request: HostDeckApprovalClientResponseRequest | null
): Promise<PendingApprovalListResponse | PendingApprovalResponse> {
  const path =
    request === null
      ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals`
      : `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(request.request_id)}/respond`;
  const url = new URL(path, baseUrl);
  const init =
    request === null
      ? {
          method: "GET",
          headers: Object.freeze({ accept: "application/json", "cache-control": "no-store" })
        }
      : {
          method: "POST",
          headers: Object.freeze({
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json"
          }),
          body: JSON.stringify(
            approvalResponseRequestSchema.parse({
              operation_id: request.operation_id,
              kind: request.kind,
              decision: request.decision,
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

  assertCliHttpResponse(response, "HostDeck approval-client");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    let parsedError: ReturnType<typeof apiRouteErrorBodySchema.safeParse>;
    try {
      parsedError = apiRouteErrorBodySchema.safeParse(payload);
    } catch {
      throw untypedError(response.status);
    }
    if (!parsedError.success) throw untypedError(response.status);
    throw apiFailure(response.status, sanitizeApprovalApiError(parsedError.data.error));
  }
  if (response.status !== 200) throw invalidResponse();

  try {
    if (request === null) {
      const parsed = pendingApprovalListResponseSchema.safeParse(payload);
      if (!parsed.success || parsed.data.target.session_id !== sessionId) throw invalidResponse();
      return deepFreeze(parsed.data);
    }
    const parsed = pendingApprovalResponseSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.operation_id !== request.operation_id ||
      parsed.data.requested_decision !== request.decision ||
      parsed.data.approval.target.session_id !== sessionId ||
      parsed.data.approval.target.request_id !== request.request_id
    ) {
      throw invalidResponse();
    }
    return deepFreeze(parsed.data);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw invalidResponse();
  }
}

function sanitizeApprovalApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({ code: error.code, message: approvalErrorMessage(error.code), retryable: error.retryable });
}

function approvalErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "validation_error":
      return "Approval response request is invalid.";
    case "session_not_found":
      return "Managed session was not found.";
    case "approval_not_pending":
      return "Approval request is not pending.";
    case "session_not_writable":
      return "Managed session cannot provide approval control.";
    case "stale_session":
    case "invalid_session_id":
      return "Managed session requires reconciliation before approval control.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "Structured approval control is unavailable for the selected runtime.";
    case "operation_conflict":
      return "Approval response conflicts with current request state.";
    case "unknown_error":
      return "Approval response outcome is unknown and requires reconciliation.";
    case "protocol_error":
      return "Codex approval state failed protocol validation.";
    case "operation_timeout":
      return "Approval response timed out before terminal proof.";
    case "runtime_unavailable":
      return "Codex approval control is unavailable.";
    case "audit_unavailable":
      return "Approval audit is unavailable.";
    case "service_overloaded":
      return "Approval control capacity is exhausted.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "read_only":
      return "Write permission is required to respond to an approval.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Approval control is not permitted.";
    default:
      return "Approval operation failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure("HostDeck daemon returned invalid managed-session approval data.");
}

function untypedError(status: number): CliFailure {
  return internalFailure(`HostDeck daemon returned an untyped HTTP ${status} approval error.`);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(candidate: unknown): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck approval-client options are invalid.";
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
    return Object.freeze({ baseUrl: descriptors.baseUrl?.value, fetch: descriptors.fetch?.value });
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}
