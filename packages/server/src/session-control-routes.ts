import { randomBytes } from "node:crypto";
import {
  type ApiErrorEnvelope,
  type ApiRouteErrorBody,
  apiErrorEnvelopeSchema,
  type StartSessionResponse,
  startSessionRequestSchema,
  startSessionResponseSchema
} from "@hostdeck/contracts";
import { createErrorEnvelope, type ErrorCode, parseSessionId, type SessionId } from "@hostdeck/core";
import {
  captureGitBranchMetadata,
  HostDeckSessionRepositoryError,
  type SessionMetadataRepository,
  type SessionRepository
} from "@hostdeck/storage";
import { HostDeckTmuxAdapterError, type TmuxAdapter, type TmuxTarget } from "@hostdeck/tmux-adapter";
import { apiSession } from "./read-routes.js";

export interface SessionControlRouteResult<TBody> {
  readonly status: number;
  readonly body: TBody;
}

export interface StartSessionRouteInput {
  readonly body: unknown;
}

export interface CreateSessionControlRouteHandlersInput {
  readonly sessions: SessionRepository;
  readonly metadata: SessionMetadataRepository;
  readonly tmux: Pick<TmuxAdapter, "startSession" | "stopSession">;
  readonly command?: readonly string[];
  readonly now?: () => Date;
  readonly createSessionId?: () => SessionId;
  readonly captureBranch?: (cwd: string) => string | null;
  readonly startOutputReader?: (target: TmuxTarget) => Promise<void> | void;
}

export interface SessionControlRouteHandlers {
  readonly startSession: (input: StartSessionRouteInput) => Promise<SessionControlRouteResult<StartSessionResponse | ApiRouteErrorBody>>;
}

const defaultCommand = ["codex"] as const;

export function createSessionControlRouteHandlers(input: CreateSessionControlRouteHandlersInput): SessionControlRouteHandlers {
  const now = input.now ?? (() => new Date());
  const createSessionId = input.createSessionId ?? defaultSessionId;
  const captureBranch = input.captureBranch ?? captureGitBranchMetadata;
  const command = input.command ?? defaultCommand;

  return {
    async startSession(routeInput) {
      const request = startSessionRequestSchema.safeParse(routeInput.body);

      if (!request.success) {
        const field = firstIssueField(request.error.issues.map((issue) => issue.path[0]));
        return routeError(
          400,
          field === "cwd" ? "invalid_cwd" : "validation_error",
          field === "cwd" ? "Start session working directory is invalid." : "Start session request is malformed.",
          { field }
        );
      }

      try {
        if (input.sessions.list().some((session) => session.name === request.data.name)) {
          return routeError(409, "duplicate_session_name", `Session name ${request.data.name} already exists.`, { field: "name" });
        }
      } catch (error) {
        return routeError(500, "storage_error", "Session registry could not be checked before start.", { details: errorDetails(error) });
      }

      let target: TmuxTarget;

      try {
        target = await input.tmux.startSession({
          sessionId: createSessionId(),
          sessionName: request.data.name,
          cwd: request.data.cwd,
          command
        });
      } catch (error) {
        return startFailure(error);
      }

      try {
        input.sessions.create({
          id: target.sessionId,
          name: target.sessionName,
          cwd: target.cwd,
          backend: {
            type: "tmux",
            tmux_session: target.tmuxSession,
            tmux_window: target.tmuxWindow,
            tmux_pane: target.tmuxPane
          },
          lifecycle_state: target.lifecycleState,
          created_at: target.createdAt,
          updated_at: target.updatedAt,
          stale_reason: target.staleReason
        });

        input.metadata.upsert({
          session_id: target.sessionId,
          branch: captureBranch(target.cwd),
          last_activity_at: null,
          status: "unknown",
          attention: "unknown",
          summary: null,
          last_output_cursor: null,
          updated_at: now().toISOString()
        });
      } catch (error) {
        await cleanupStartedTarget(input, target);
        return storageFailure(error);
      }

      try {
        await input.startOutputReader?.(target);
      } catch (error) {
        await cleanupStartedTarget(input, target);
        return routeError(500, "internal_error", `Output reader failed to start for ${target.sessionId}.`, {
          details: errorDetails(error)
        });
      }

      try {
        return {
          status: 201,
          body: startSessionResponseSchema.parse({ session: apiSession(input, target.sessionId) })
        };
      } catch (error) {
        return routeError(500, "internal_error", `Started session ${target.sessionId} failed response validation.`, {
          details: errorDetails(error)
        });
      }
    }
  };
}

function firstIssueField(fields: readonly unknown[]): "body" | "cwd" | "name" {
  for (const field of fields) {
    if (field === "cwd" || field === "name") {
      return field;
    }
  }

  return "body";
}

function defaultSessionId(): SessionId {
  const candidate = `sess_${randomBytes(10).toString("hex")}`;
  const result = parseSessionId(candidate);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

async function cleanupStartedTarget(input: CreateSessionControlRouteHandlersInput, target: TmuxTarget): Promise<void> {
  try {
    const stopped = await input.tmux.stopSession({ sessionId: target.sessionId });
    const session = input.sessions.get(target.sessionId);

    if (session !== null) {
      input.sessions.update({
        ...session,
        lifecycle_state: stopped.lifecycleState,
        stale_reason: stopped.staleReason,
        updated_at: stopped.updatedAt
      });
    }
  } catch {
    try {
      input.sessions.markStale(target.sessionId, "start cleanup failed");
    } catch {
      // The route still fails loudly; cleanup errors are bounded in the returned primary failure.
    }
  }
}

function startFailure(error: unknown): SessionControlRouteResult<ApiRouteErrorBody> {
  if (!(error instanceof HostDeckTmuxAdapterError)) {
    return routeError(500, "internal_error", "Session start failed before tmux returned a typed error.", { details: errorDetails(error) });
  }

  switch (error.code) {
    case "command_unavailable":
      return routeError(500, "missing_binary", "Codex executable is unavailable for session start.", {
        field: "command",
        details: { tmux_code: error.code, reason: error.message }
      });
    case "invalid_cwd":
      return routeError(400, "invalid_cwd", error.message, {
        field: "cwd",
        details: { tmux_code: error.code }
      });
    case "duplicate_session_name":
      return routeError(409, "duplicate_session_name", error.message, {
        field: "name",
        details: { tmux_code: error.code }
      });
    case "duplicate_session":
      return routeError(500, "invalid_session_id", error.message, {
        field: "session_id",
        details: { tmux_code: error.code }
      });
    case "missing_target":
    case "start_failed":
    case "stale_target":
    case "target_not_running":
    case "tmux_unavailable":
      return routeError(502, "tmux_error", error.message, {
        retryable: true,
        details: { tmux_code: error.code }
      });
    case "invalid_output_cursor":
    case "invalid_start_command":
    case "invalid_target":
      return routeError(500, "internal_error", error.message, {
        details: { tmux_code: error.code }
      });
  }
}

function storageFailure(error: unknown): SessionControlRouteResult<ApiRouteErrorBody> {
  if (!(error instanceof HostDeckSessionRepositoryError)) {
    return routeError(500, "storage_error", "Session registry update failed after tmux start.", { details: errorDetails(error) });
  }

  switch (error.code) {
    case "duplicate_session_name":
      return routeError(409, "duplicate_session_name", error.message, { field: "name" });
    case "session_exists":
      return routeError(500, "invalid_session_id", error.message, { field: "session_id" });
    case "invalid_session":
      return routeError(400, "validation_error", error.message, { field: "body" });
    case "invalid_metadata":
    case "metadata_missing":
    case "session_not_found":
      return routeError(500, "storage_error", error.message);
  }
}

function routeError(
  status: number,
  code: ErrorCode,
  message: string,
  options: {
    readonly field?: string;
    readonly sessionId?: NonNullable<ApiErrorEnvelope["session_id"]>;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {}
): SessionControlRouteResult<ApiRouteErrorBody> {
  return {
    status,
    body: {
      error: envelope(code, message, options)
    }
  };
}

function envelope(
  code: ErrorCode,
  message: string,
  options: {
    readonly field?: string;
    readonly sessionId?: NonNullable<ApiErrorEnvelope["session_id"]>;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {}
): ApiErrorEnvelope {
  const error = createErrorEnvelope({
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.field !== undefined ? { field: options.field } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.details !== undefined ? { details: boundedDetails(options.details) } : {})
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
