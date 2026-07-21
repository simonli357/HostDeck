import {
  type ApiErrorEnvelope,
  type InterruptRequest,
  type InterruptResponse,
  interruptRequestSchema,
  interruptResponseSchema,
  sessionTurnParamsSchema
} from "@hostdeck/contracts";
import type { HttpFetch } from "./api-client.js";
import { CliFailure, internalFailure, usageFailure } from "./errors.js";
import {
  createBoundedLoopbackFetch,
  requestCliJson,
  requireLoopbackBaseUrl,
  throwCliApiFailure
} from "./loopback-http.js";

const interruptClientRequestSchema = sessionTurnParamsSchema.extend(interruptRequestSchema.shape);

export interface HostDeckInterruptClientRequest extends InterruptRequest {
  readonly session_id: string;
  readonly turn_id: string;
}

export interface HostDeckInterruptClient {
  readonly interrupt: (request: HostDeckInterruptClientRequest) => Promise<InterruptResponse>;
}

export interface CreateHostDeckInterruptClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckInterruptClient(input: CreateHostDeckInterruptClientOptions): HostDeckInterruptClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) throw new TypeError("HostDeck interrupt-client base URL is invalid.");
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck interrupt-client fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort = values.fetch === undefined ? createBoundedLoopbackFetch() : (values.fetch as HttpFetch);
  return Object.freeze({
    async interrupt(candidate: HostDeckInterruptClientRequest) {
      const parsed = interruptClientRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        throw usageFailure("Interrupt requires valid session and turn ids, an operation id, and confirmation.", "interrupt");
      }
      return await requestInterrupt(baseUrl, fetchPort, parsed.data);
    }
  });
}

async function requestInterrupt(
  baseUrl: URL,
  fetchPort: HttpFetch,
  request: HostDeckInterruptClientRequest
): Promise<InterruptResponse> {
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(request.session_id)}/turns/${encodeURIComponent(request.turn_id)}/interrupt`,
    baseUrl
  );
  const { payload, response } = await requestCliJson({
    baseUrl,
    context: "HostDeck interrupt-client",
    expectedStatus: 200,
    invalidSuccessStatusMessage:
      "HostDeck daemon returned invalid managed-session interrupt data.",
    fetch: fetchPort,
    init: {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json"
      }),
      body: JSON.stringify(
        interruptRequestSchema.parse({
          operation_id: request.operation_id,
          kind: request.kind,
          confirm: request.confirm
        })
      )
    },
    url
  });
  if (!response.ok) {
    throwCliApiFailure({
      context: "interrupt",
      payload,
      sanitize: sanitizeInterruptApiError,
      status: response.status
    });
  }
  try {
    const parsed = interruptResponseSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.operation_id !== request.operation_id ||
      parsed.data.target.session_id !== request.session_id ||
      parsed.data.target.turn_id !== request.turn_id ||
      parsed.data.turn_id !== request.turn_id
    ) {
      throw invalidResponse();
    }
    return deepFreeze(parsed.data);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw invalidResponse();
  }
}

function sanitizeInterruptApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({ code: error.code, message: interruptErrorMessage(error.code), retryable: error.retryable });
}

function interruptErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "validation_error":
      return "Interrupt request is invalid.";
    case "session_not_found":
      return "Managed session was not found.";
    case "session_not_writable":
      return "Managed session cannot provide interrupt control.";
    case "stale_session":
    case "invalid_session_id":
      return "Managed session requires reconciliation before interrupt control.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "Structured interrupt control is unavailable for the selected runtime.";
    case "operation_conflict":
      return "Interrupt conflicts with current turn state.";
    case "unknown_error":
      return "Interrupt outcome is unknown and requires reconciliation.";
    case "protocol_error":
      return "Codex interrupt state failed protocol validation.";
    case "operation_timeout":
      return "Interrupt timed out before terminal proof.";
    case "runtime_unavailable":
      return "Codex interrupt control is unavailable.";
    case "audit_unavailable":
      return "Interrupt audit is unavailable.";
    case "service_overloaded":
      return "Interrupt control capacity is exhausted.";
    case "storage_error":
      return "Managed session storage is unavailable.";
    case "read_only":
      return "Write permission is required to interrupt a turn.";
    case "permission_denied":
    case "invalid_origin":
    case "insecure_transport":
      return "Interrupt control is not permitted.";
    default:
      return "Interrupt operation failed.";
  }
}

function invalidResponse(): CliFailure {
  return internalFailure("HostDeck daemon returned invalid managed-session interrupt data.");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(candidate: unknown): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck interrupt-client options are invalid.";
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
