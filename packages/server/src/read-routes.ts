import {
  type ApiErrorEnvelope,
  type ApiSession,
  apiErrorEnvelopeSchema,
  type HostStatusResponse,
  hostStatusResponseSchema,
  outputQuerySchema,
  type SessionDetailResponse,
  type SessionListResponse,
  type SessionOutputResponse,
  sessionDetailResponseSchema,
  sessionIdParamsSchema,
  sessionListResponseSchema,
  sessionOutputResponseSchema
} from "@hostdeck/contracts";
import { attentionPriority, createErrorEnvelope, type ErrorCode } from "@hostdeck/core";
import type {
  SessionMetadataRepository,
  SessionRepository
} from "@hostdeck/storage";
import type { OutputReader } from "./output-reader.js";

export interface ReadAuthInput {
  readonly rawDeviceToken?: string | null;
  readonly rawCsrfToken?: string | null;
}

export interface ReadRouteResult<TBody> {
  readonly status: number;
  readonly body: TBody;
}

export interface ReadRouteErrorBody {
  readonly error: ApiErrorEnvelope;
}

export type ReadRouteName = "host_status" | "session_list" | "session_detail" | "session_output" | "session_stream";

export type ReadAuthorizationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status?: 401 | 403;
      readonly code?: Extract<ErrorCode, "permission_denied" | "read_only">;
      readonly message?: string;
    };

export interface ReadAuthorizationInput extends ReadAuthInput {
  readonly route: ReadRouteName;
  readonly sessionId?: string;
}

export interface SessionParamsRouteInput extends ReadAuthInput {
  readonly params: unknown;
}

export interface SessionOutputRouteInput extends SessionParamsRouteInput {
  readonly query?: unknown;
}

export interface CreateReadRouteHandlersInput {
  readonly status: () => HostStatusResponse;
  readonly sessions: SessionRepository;
  readonly metadata: SessionMetadataRepository;
  readonly outputReader: Pick<OutputReader, "replaySession">;
  readonly authorizeRead?: (input: ReadAuthorizationInput) => ReadAuthorizationResult;
}

export interface ReadRouteHandlers {
  readonly hostStatus: (input?: ReadAuthInput) => ReadRouteResult<HostStatusResponse | ReadRouteErrorBody>;
  readonly listSessions: (input?: ReadAuthInput) => ReadRouteResult<SessionListResponse | ReadRouteErrorBody>;
  readonly sessionDetail: (input: SessionParamsRouteInput) => ReadRouteResult<SessionDetailResponse | ReadRouteErrorBody>;
  readonly sessionOutput: (input: SessionOutputRouteInput) => ReadRouteResult<SessionOutputResponse | ReadRouteErrorBody>;
}

const maxRecentOutputLength = 12_000;

export function createReadRouteHandlers(input: CreateReadRouteHandlersInput): ReadRouteHandlers {
  return {
    hostStatus(routeInput = {}) {
      const authorized = authorizeRead(input, { ...routeInput, route: "host_status" });

      if (!authorized.ok) {
        return authorizationError(authorized);
      }

      try {
        return {
          status: 200,
          body: hostStatusResponseSchema.parse(input.status())
        };
      } catch (error) {
        return routeError(500, "internal_error", "Host status response failed contract validation.", undefined, errorDetails(error));
      }
    },
    listSessions(routeInput = {}) {
      const authorized = authorizeRead(input, { ...routeInput, route: "session_list" });

      if (!authorized.ok) {
        return authorizationError(authorized);
      }

      try {
        const sessions = input.sessions.list().map((session) => apiSession(input, session.id)).sort(compareApiSessions);

        return {
          status: 200,
          body: sessionListResponseSchema.parse({ sessions })
        };
      } catch (error) {
        return routeError(500, "storage_error", "Session list could not be read.", undefined, errorDetails(error));
      }
    },
    sessionDetail(routeInput) {
      const parsedParams = sessionIdParamsSchema.safeParse(routeInput.params);

      if (!parsedParams.success) {
        return routeError(400, "validation_error", "Session id parameter is malformed.", "session_id");
      }

      const sessionId = parsedParams.data.session_id;
      const authorized = authorizeRead(input, { ...routeInput, route: "session_detail", sessionId });

      if (!authorized.ok) {
        return authorizationError(authorized);
      }

      const session = input.sessions.get(sessionId);

      if (session === null) {
        return routeError(404, "session_not_found", `Session ${sessionId} does not exist.`, undefined, { session_id: sessionId });
      }

      try {
        return {
          status: 200,
          body: sessionDetailResponseSchema.parse({ session: apiSession(input, session.id) })
        };
      } catch (error) {
        return routeError(500, "storage_error", `Session ${sessionId} could not be read.`, undefined, errorDetails(error));
      }
    },
    sessionOutput(routeInput) {
      const parsedParams = sessionIdParamsSchema.safeParse(routeInput.params);

      if (!parsedParams.success) {
        return routeError(400, "validation_error", "Session id parameter is malformed.", "session_id");
      }

      const parsedQuery = outputQuerySchema.safeParse(routeInput.query ?? {});

      if (!parsedQuery.success) {
        return routeError(400, "validation_error", "Output cursor query is malformed.", "after");
      }

      const sessionId = parsedParams.data.session_id;
      const authorized = authorizeRead(input, { ...routeInput, route: "session_output", sessionId });

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

      try {
        const response = input.outputReader.replaySession({
          sessionId,
          ...(parsedQuery.data.after !== undefined ? { after: parsedQuery.data.after } : {})
        });

        return {
          status: 200,
          body: sessionOutputResponseSchema.parse(response)
        };
      } catch (error) {
        return routeError(500, "storage_error", `Output replay failed for ${sessionId}.`, undefined, errorDetails(error));
      }
    }
  };
}

function authorizeRead(input: CreateReadRouteHandlersInput, authorization: ReadAuthorizationInput): ReadAuthorizationResult {
  return input.authorizeRead?.(authorization) ?? { ok: true };
}

export function apiSession(input: Pick<CreateReadRouteHandlersInput, "metadata" | "sessions">, sessionId: string): ApiSession {
  const session = input.sessions.require(sessionId);
  const metadata = input.metadata.get(sessionId);
  const isStale = session.lifecycle_state === "stale";
  const status = isStale ? "disconnected" : (metadata?.status ?? "unknown");
  const attention = isStale ? "unknown" : (metadata?.attention ?? "unknown");

  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    backend: {
      type: "tmux",
      tmux: {
        session_name: session.backend.tmux_session,
        ...(session.backend.tmux_window !== null ? { window_name: session.backend.tmux_window } : {}),
        ...(session.backend.tmux_pane !== null ? { pane_id: session.backend.tmux_pane } : {})
      }
    },
    lifecycle_state: session.lifecycle_state,
    status,
    attention,
    created_at: session.created_at,
    updated_at: session.updated_at,
    last_activity_at: isStale ? null : (metadata?.last_activity_at ?? null),
    branch: metadata?.branch ?? null,
    recent_output: recentOutput(metadata?.summary ?? null, metadata?.last_output_cursor ?? null)
  };
}

function recentOutput(summary: string | null, cursor: ApiSession["recent_output"]["cursor"]): ApiSession["recent_output"] {
  if (summary === null || summary.length === 0) {
    return {
      text: "",
      cursor: null,
      line_count: 0,
      truncated: false
    };
  }

  const text =
    summary.length > maxRecentOutputLength
      ? summary.slice(summary.length - maxRecentOutputLength)
      : summary;

  return {
    text,
    cursor,
    line_count: text.split(/\r?\n/u).length,
    truncated: summary.length > maxRecentOutputLength
  };
}

function compareApiSessions(left: ApiSession, right: ApiSession): number {
  const attentionDelta = attentionPriority(right.attention) - attentionPriority(left.attention);

  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const leftActivity = timestampSortValue(left.last_activity_at ?? left.updated_at);
  const rightActivity = timestampSortValue(right.last_activity_at ?? right.updated_at);

  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }

  return left.name.localeCompare(right.name);
}

function timestampSortValue(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
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
  const error = createErrorEnvelope({
    code,
    message,
    ...(field !== undefined ? { field } : {}),
    ...(details !== undefined ? { details: boundedDetails(details) } : {})
  });

  return {
    status,
    body: {
      error: apiErrorEnvelopeSchema.parse({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.field !== undefined ? { field: error.field } : {}),
        ...(error.sessionId !== undefined ? { session_id: error.sessionId } : {}),
        ...(error.details !== undefined ? { details: error.details } : {})
      })
    }
  };
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
