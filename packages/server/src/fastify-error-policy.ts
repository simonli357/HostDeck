import { type ApiRouteErrorBody, apiRouteErrorBodySchema } from "@hostdeck/contracts";
import {
  createErrorEnvelope,
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
  type ErrorEnvelopeInput,
  errorEnvelopeLimits
} from "@hostdeck/core";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { HostDeckRequestValidationError, hostDeckRequestValidationErrorCode } from "./fastify-zod.js";

export interface HostDeckHttpErrorInput extends ErrorEnvelopeInput {
  readonly status: number;
}

export interface HostDeckInternalErrorObservation {
  readonly error: unknown;
  readonly request_id: string;
  readonly framework_code?: string;
}

export type HostDeckInternalErrorObserver = (observation: HostDeckInternalErrorObservation) => void;

export class HostDeckHttpError extends Error {
  readonly code: ErrorCode;
  readonly envelope: ErrorEnvelope;
  readonly statusCode: number;

  constructor(input: HostDeckHttpErrorInput) {
    if (!Number.isSafeInteger(input.status) || input.status < 400 || input.status > 599) {
      throw new TypeError("HostDeck HTTP error status must be an integer from 400 through 599.");
    }
    if (input.details !== undefined && Object.hasOwn(input.details, "request_id")) {
      throw new TypeError("HostDeck HTTP error details cannot override the request_id field.");
    }
    if (
      input.details !== undefined &&
      Object.keys(input.details).length >= errorEnvelopeLimits.detailFieldCount
    ) {
      throw new TypeError(
        `HostDeck HTTP error details must leave one of ${errorEnvelopeLimits.detailFieldCount} fields for request_id.`
      );
    }
    const parsedEnvelope = createErrorEnvelope(input);
    const envelope: ErrorEnvelope = Object.freeze({
      ...parsedEnvelope,
      ...(parsedEnvelope.details !== undefined
        ? { details: Object.freeze({ ...parsedEnvelope.details }) }
        : {})
    });
    super(envelope.message);
    this.name = "HostDeckHttpError";
    this.code = envelope.code;
    this.envelope = envelope;
    this.statusCode = input.status;
    Object.freeze(this);
  }
}

export function installHostDeckErrorPolicy(
  app: import("fastify").FastifyInstance,
  observeInternalError: HostDeckInternalErrorObserver
): void {
  app.setErrorHandler((error, request, reply) => {
    return handleHostDeckFastifyError(error, request, reply, observeInternalError);
  });
}

export function handleHostDeckFastifyError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  observeInternalError: HostDeckInternalErrorObserver
): FastifyReply {
  if (error instanceof HostDeckHttpError) {
    return sendHostDeckError(reply, request, error.statusCode, error.envelope);
  }

  const frameworkCode = fastifyErrorCode(error);
  if (error instanceof HostDeckRequestValidationError || frameworkCode === hostDeckRequestValidationErrorCode) {
    const field = error instanceof HostDeckRequestValidationError ? error.field : "request";
    return sendHostDeckError(reply, request, 400, {
      code: "validation_error",
      message: "Request failed validation.",
      retryable: false,
      field
    });
  }

  switch (frameworkCode) {
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return sendHostDeckError(reply, request, 413, {
        code: "request_too_large",
        message: "Request body exceeds its configured limit.",
        retryable: false
      });
    case "FST_ERR_MAX_PARAM_LENGTH":
      return sendHostDeckError(reply, request, 414, {
        code: "validation_error",
        message: "Route parameter exceeds its configured limit.",
        retryable: false,
        field: "params"
      });
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return sendHostDeckError(reply, request, 415, {
        code: "unsupported_media_type",
        message: "Request content type is not supported.",
        retryable: false
      });
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_BAD_URL":
      return sendHostDeckError(reply, request, 400, {
        code: "malformed_request",
        message: "Request syntax is invalid.",
        retryable: false
      });
    case "FST_ERR_HANDLER_TIMEOUT":
      return sendHostDeckError(reply, request, 504, {
        code: "operation_timeout",
        message: "Request deadline exceeded.",
        retryable: false
      });
  }

  observeInternalFailure(observeInternalError, error, request, frameworkCode);
  return sendHostDeckError(reply, request, 500, {
    code: "internal_error",
    message: "Internal server error.",
    retryable: false
  });
}

export function sendHostDeckError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  input: ErrorEnvelopeInput | ErrorEnvelope
): FastifyReply {
  if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
    throw new TypeError("HostDeck error response status must be an integer from 400 through 599.");
  }
  const envelope = createErrorEnvelope(input);
  const body = errorBody(envelope, request.id);
  return reply
    .code(status)
    .header("x-request-id", request.id)
    .type("application/json; charset=utf-8")
    .serializer((payload) => JSON.stringify(payload))
    .send(body);
}

function errorBody(envelope: ErrorEnvelope, requestId: string): ApiRouteErrorBody {
  const currentDetails = envelope.details ?? {};
  const canAddRequestId =
    Object.hasOwn(currentDetails, "request_id") ||
    Object.keys(currentDetails).length < errorEnvelopeLimits.detailFieldCount;
  const details: ErrorDetails = Object.freeze(
    canAddRequestId ? { ...currentDetails, request_id: requestId } : currentDetails
  );
  return apiRouteErrorBodySchema.parse({
    error: {
      code: envelope.code,
      message: envelope.message,
      retryable: envelope.retryable,
      ...(envelope.field !== undefined ? { field: envelope.field } : {}),
      ...(envelope.sessionId !== undefined ? { session_id: envelope.sessionId } : {}),
      details
    }
  });
}

function fastifyErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code: unknown = (error as Partial<FastifyError>).code;
  return typeof code === "string" ? code : undefined;
}

function observeInternalFailure(
  observer: HostDeckInternalErrorObserver,
  error: unknown,
  request: FastifyRequest,
  frameworkCode: string | undefined
): void {
  try {
    const result: unknown = observer({
      error,
      request_id: request.id,
      ...(frameworkCode !== undefined ? { framework_code: frameworkCode } : {})
    });
    if (isPromiseLike(result)) {
      recordObserverFailure(request);
      void Promise.resolve(result).catch(() => recordObserverFailure(request));
    }
  } catch {
    recordObserverFailure(request);
  }
}

function recordObserverFailure(request: FastifyRequest): void {
  request.log.error(
    {
      event: "hostdeck.internal_error_observer_failed",
      request_id: request.id
    },
    "HostDeck internal error observer failed"
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
