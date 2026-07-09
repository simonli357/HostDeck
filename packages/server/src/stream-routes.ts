import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  outputQuerySchema,
  type SessionStreamEvent,
  sessionIdParamsSchema,
  sessionStreamEventSchema
} from "@hostdeck/contracts";
import { createErrorEnvelope, type ErrorCode, type OutputCursor } from "@hostdeck/core";
import type { SessionRepository } from "@hostdeck/storage";
import type { OutputReader } from "./output-reader.js";
import type { ReadAuthInput, ReadAuthorizationInput, ReadAuthorizationResult, ReadRouteErrorBody, ReadRouteResult } from "./read-routes.js";

export interface SessionStreamRouteInput extends ReadAuthInput {
  readonly params: unknown;
  readonly query?: unknown;
}

export interface SessionStreamLiveSource {
  readonly subscribe: (input: SessionStreamSubscribeInput) => AsyncIterable<unknown>;
}

export interface SessionStreamSubscribeInput {
  readonly sessionId: string;
  readonly after: OutputCursor | null;
}

export interface CreateStreamRouteHandlersInput {
  readonly sessions: SessionRepository;
  readonly outputReader: Pick<OutputReader, "replaySession">;
  readonly liveSource: SessionStreamLiveSource;
  readonly authorizeRead?: (input: ReadAuthorizationInput) => ReadAuthorizationResult;
}

export interface SessionStreamRouteSuccess {
  readonly status: 200;
  readonly stream: AsyncIterable<SessionStreamEvent>;
}

export type SessionStreamRouteResult = SessionStreamRouteSuccess | ReadRouteResult<ReadRouteErrorBody>;

export interface StreamRouteHandlers {
  readonly sessionStream: (input: SessionStreamRouteInput) => SessionStreamRouteResult;
}

export function createStreamRouteHandlers(input: CreateStreamRouteHandlersInput): StreamRouteHandlers {
  return {
    sessionStream(routeInput) {
      const parsedParams = sessionIdParamsSchema.safeParse(routeInput.params);

      if (!parsedParams.success) {
        return routeError(400, "validation_error", "Session id parameter is malformed.", "session_id");
      }

      const parsedQuery = outputQuerySchema.safeParse(routeInput.query ?? {});

      if (!parsedQuery.success) {
        return routeError(400, "validation_error", "Output cursor query is malformed.", "after");
      }

      const sessionId = parsedParams.data.session_id;
      const authorized = authorizeRead(input, { ...routeInput, route: "session_stream", sessionId });

      if (!authorized.ok) {
        return authorizationError(authorized);
      }

      const session = input.sessions.get(sessionId);

      if (session === null) {
        return routeError(404, "session_not_found", `Session ${sessionId} does not exist.`, undefined, { session_id: sessionId });
      }

      if (session.lifecycle_state === "stale") {
        return routeError(409, "stale_session", `Session ${sessionId} is stale and cannot stream output.`, undefined, {
          session_id: sessionId,
          stale_reason: session.stale_reason ?? "unknown"
        });
      }

      return {
        status: 200,
        stream: sessionStream(input, sessionId, parsedQuery.data.after ?? null)
      };
    }
  };
}

async function* sessionStream(
  input: CreateStreamRouteHandlersInput,
  sessionId: string,
  requestedAfter: OutputCursor | null
): AsyncGenerator<SessionStreamEvent> {
  let lastCursor = requestedAfter;

  yield streamStatusEvent(sessionId, "connected");

  try {
    const replay = input.outputReader.replaySession({
      sessionId,
      ...(requestedAfter !== null ? { after: requestedAfter } : {})
    });

    for (const replayEvent of replay.events) {
      const event = normalizeReplayBoundary(replayEvent, requestedAfter);
      const order = validateEventForSession(event, sessionId, lastCursor);

      if (!order.ok) {
        yield streamErrorEvent(sessionId, order.code, order.message, order.details);
        yield streamStatusEvent(sessionId, "closed", "Stream closed after invalid replay event.");
        return;
      }

      lastCursor = order.lastCursor;
      yield event;
    }
  } catch (error) {
    yield streamErrorEvent(sessionId, "storage_error", `Output replay failed for ${sessionId}.`, errorDetails(error), true);
    yield streamStatusEvent(sessionId, "closed", "Stream closed after replay failure.");
    return;
  }

  try {
    for await (const rawEvent of input.liveSource.subscribe({ sessionId, after: lastCursor })) {
      const parsed = sessionStreamEventSchema.safeParse(rawEvent);

      if (!parsed.success) {
        yield streamErrorEvent(sessionId, "internal_error", "Live stream event failed contract validation.", errorDetails(parsed.error));
        yield streamStatusEvent(sessionId, "closed", "Stream closed after invalid live event.");
        return;
      }

      const order = validateEventForSession(parsed.data, sessionId, lastCursor);

      if (!order.ok) {
        yield streamErrorEvent(sessionId, order.code, order.message, order.details);
        yield streamStatusEvent(sessionId, "closed", "Stream closed after invalid live event.");
        return;
      }

      lastCursor = order.lastCursor;
      yield parsed.data;
    }
  } catch (error) {
    yield streamErrorEvent(sessionId, "daemon_unavailable", `Live stream failed for ${sessionId}.`, errorDetails(error), true);
  }

  yield streamStatusEvent(sessionId, "closed");
}

function normalizeReplayBoundary(
  event: SessionStreamEvent,
  requestedAfter: OutputCursor | null
): SessionStreamEvent {
  if (event.type !== "replay_boundary" || event.reason !== "retention" || requestedAfter === null) {
    return event;
  }

  return sessionStreamEventSchema.parse({
    ...event,
    reason: "stale_cursor"
  });
}

type EventValidationResult =
  | { readonly ok: true; readonly lastCursor: OutputCursor | null }
  | {
      readonly ok: false;
      readonly code: Extract<ErrorCode, "internal_error">;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

function validateEventForSession(
  event: SessionStreamEvent,
  sessionId: string,
  previousCursor: OutputCursor | null
): EventValidationResult {
  const eventSessionId = "session_id" in event ? event.session_id : null;

  if (eventSessionId !== sessionId) {
    return {
      ok: false,
      code: "internal_error",
      message: "Stream event identified a different session.",
      details: {
        expected_session_id: sessionId,
        actual_session_id: eventSessionId ?? "missing"
      }
    };
  }

  const eventCursor = cursorForOrder(event);

  if (eventCursor === null) {
    return { ok: true, lastCursor: previousCursor };
  }

  if (previousCursor !== null && eventCursor < previousCursor) {
    return {
      ok: false,
      code: "internal_error",
      message: "Stream event cursors moved backward.",
      details: {
        previous_cursor: previousCursor,
        event_cursor: eventCursor
      }
    };
  }

  return { ok: true, lastCursor: eventCursor };
}

function cursorForOrder(event: SessionStreamEvent): OutputCursor | null {
  if (event.type === "output") {
    return event.cursor;
  }

  if (event.type === "replay_boundary") {
    return event.next_cursor;
  }

  return null;
}

function streamStatusEvent(
  sessionId: string,
  status: "connected" | "reconnecting" | "closed",
  message?: string
): SessionStreamEvent {
  return sessionStreamEventSchema.parse({
    type: "stream_status",
    session_id: sessionId,
    status,
    ...(message !== undefined ? { message } : {})
  });
}

function streamErrorEvent(
  sessionId: string,
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  retryable = false
): SessionStreamEvent {
  return sessionStreamEventSchema.parse({
    type: "error",
    session_id: sessionId,
    error: envelope(code, message, undefined, details, retryable)
  });
}

function authorizeRead(input: CreateStreamRouteHandlersInput, authorization: ReadAuthorizationInput): ReadAuthorizationResult {
  return input.authorizeRead?.(authorization) ?? { ok: true };
}

function authorizationError(result: Exclude<ReadAuthorizationResult, { readonly ok: true }>): ReadRouteResult<ReadRouteErrorBody> {
  return routeError(result.status ?? 403, result.code ?? "permission_denied", result.message ?? "Read access is not permitted.");
}

function routeError(
  status: number,
  code: ErrorCode,
  message: string,
  field?: string,
  details?: Readonly<Record<string, unknown>>
): ReadRouteResult<ReadRouteErrorBody> {
  return {
    status,
    body: {
      error: envelope(code, message, field, details)
    }
  };
}

function envelope(
  code: ErrorCode,
  message: string,
  field?: string,
  details?: Readonly<Record<string, unknown>>,
  retryable = false
): ApiErrorEnvelope {
  const error = createErrorEnvelope({
    code,
    message,
    retryable,
    ...(field !== undefined ? { field } : {}),
    ...(details !== undefined ? { details: boundedDetails(details) } : {})
  });

  return apiErrorEnvelopeSchema.parse({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.field !== undefined ? { field: error.field } : {}),
    ...(error.sessionId !== undefined ? { session_id: error.sessionId } : {}),
    ...(error.details !== undefined ? { details: error.details } : {})
  });
}

function errorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      reason: error.message
    };
  }

  return {
    reason: String(error)
  };
}

function boundedDetails(details: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number | boolean | null>> {
  const bounded: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") {
      bounded[key] = value.length > 256 ? `${value.slice(0, 253)}...` : value;
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      bounded[key] = value;
      continue;
    }

    if (typeof value === "boolean" || value === null) {
      bounded[key] = value;
      continue;
    }

    bounded[key] = String(value).slice(0, 256);
  }

  return bounded;
}
