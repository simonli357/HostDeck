import { randomBytes } from "node:crypto";
import {
  type ApiErrorEnvelope,
  type AuthDeviceRecord,
  apiErrorEnvelopeSchema,
  promptInputRequestSchema,
  rawInputRequestSchema,
  sessionIdParamsSchema,
  sessionIdSchema,
  slashCommandRequestSchema,
  stopSessionRequestSchema,
  type WriteResponse,
  writeResponseSchema
} from "@hostdeck/contracts";
import { checkWriteEligibility, createErrorEnvelope, type ErrorCode, isAllowedSlashCommand, type WriteAction } from "@hostdeck/core";
import {
  type AuditEventRepository,
  type AuthDeviceRepository,
  HostDeckAuditRepositoryError,
  HostDeckAuthRepositoryError,
  type SessionRepository,
  type SettingsRepository
} from "@hostdeck/storage";
import { HostDeckTmuxAdapterError, type TmuxAdapter } from "@hostdeck/tmux-adapter";

export interface WriteAuthInput {
  readonly rawDeviceToken?: string | null;
  readonly rawCsrfToken?: string | null;
  readonly localAdmin?: boolean;
}

export interface WriteRouteInput extends WriteAuthInput {
  readonly params: unknown;
  readonly body: unknown;
  readonly targetSessionIds?: unknown;
}

export interface WriteRouteResult {
  readonly status: number;
  readonly body: WriteResponse;
}

export interface WriteRouteHandlers {
  readonly promptInput: (input: WriteRouteInput) => Promise<WriteRouteResult>;
  readonly slashCommand: (input: WriteRouteInput) => Promise<WriteRouteResult>;
  readonly stopSession: (input: WriteRouteInput) => Promise<WriteRouteResult>;
  readonly rawInput: (input: WriteRouteInput) => Promise<WriteRouteResult>;
}

export interface CreateWriteRouteHandlersInput {
  readonly sessions: SessionRepository;
  readonly settings: SettingsRepository;
  readonly authDevices: AuthDeviceRepository;
  readonly auditEvents: AuditEventRepository;
  readonly tmux: Pick<TmuxAdapter, "sendInput" | "stopSession">;
  readonly now?: () => Date;
  readonly createAuditId?: () => string;
}

type ParsedWriteRequest =
  | { readonly action: "prompt"; readonly text: string }
  | { readonly action: "slash"; readonly command: string; readonly argument?: string }
  | { readonly action: "stop" }
  | { readonly action: "raw_input"; readonly text: string; readonly confirmed: true };

type ParsedRouteInput =
  | {
      readonly ok: true;
      readonly sessionId: NonNullable<ApiErrorEnvelope["session_id"]>;
      readonly targetSessionIds: readonly NonNullable<ApiErrorEnvelope["session_id"]>[];
      readonly request: ParsedWriteRequest;
    }
  | { readonly ok: false; readonly error: WriteRouteResult };

type AuditActor = {
  readonly type: "cli" | "dashboard";
  readonly client_id: string | null;
  readonly permission: "write";
};

export function createWriteRouteHandlers(input: CreateWriteRouteHandlersInput): WriteRouteHandlers {
  const now = input.now ?? (() => new Date());
  const createAuditId = input.createAuditId ?? (() => `audit_${randomBytes(10).toString("hex")}`);

  return {
    promptInput(routeInput) {
      return handleWrite(input, now, createAuditId, "prompt", routeInput);
    },
    slashCommand(routeInput) {
      return handleWrite(input, now, createAuditId, "slash", routeInput);
    },
    stopSession(routeInput) {
      return handleWrite(input, now, createAuditId, "stop", routeInput);
    },
    rawInput(routeInput) {
      return handleWrite(input, now, createAuditId, "raw_input", routeInput);
    }
  };
}

async function handleWrite(
  input: CreateWriteRouteHandlersInput,
  now: () => Date,
  createAuditId: () => string,
  action: WriteAction,
  routeInput: WriteRouteInput
): Promise<WriteRouteResult> {
  const parsed = parseRouteInput(action, routeInput);

  if (!parsed.ok) {
    return parsed.error;
  }

  const auth = authorizeWriteActor(input.authDevices, routeInput, now);

  if (!auth.ok) {
    return auth.error;
  }

  const sessionResult = loadSession(input.sessions, parsed.sessionId);

  if (!sessionResult.ok) {
    return sessionResult.error;
  }

  const settingsResult = loadHostLocked(input.settings);

  if (!settingsResult.ok) {
    return settingsResult.error;
  }

  const eligibility = checkWriteEligibility({
    action,
    sessionId: parsed.sessionId,
    targetSessionIds: parsed.targetSessionIds,
    lifecycleState: sessionResult.session.lifecycle_state,
    trusted: true,
    readOnly: false,
    hostLocked: settingsResult.locked,
    auditAvailable: true,
    ...(parsed.request.action === "slash" ? { slashCommand: parsed.request.command } : {}),
    ...(parsed.request.action === "raw_input" ? { rawInputConfirmed: parsed.request.confirmed } : {})
  });
  const actor = auth.actor;

  if (!eligibility.allowed) {
    const audit = appendWriteAudit(input.auditEvents, createAuditId, now, {
      actor,
      request: parsed.request,
      sessionId: parsed.sessionId,
      result: "rejected",
      errorCode: eligibility.errorCode
    });

    if (!audit.ok) {
      return audit.error;
    }

    return routeError(statusForErrorCode(eligibility.errorCode), eligibility.errorCode, eligibility.message, {
      sessionId: parsed.sessionId,
      retryable: eligibility.retryable,
      details: {
        denial_code: eligibility.code
      }
    });
  }

  const preflight = appendWriteAudit(input.auditEvents, createAuditId, now, {
    actor,
    request: parsed.request,
    sessionId: parsed.sessionId,
    result: "accepted",
    errorCode: null
  });

  if (!preflight.ok) {
    return preflight.error;
  }

  try {
    await dispatchWrite(input, now, parsed);
  } catch (error) {
    const failedAudit = appendWriteAudit(input.auditEvents, createAuditId, now, {
      actor,
      request: parsed.request,
      sessionId: parsed.sessionId,
      result: "failed",
      errorCode: errorCodeForDispatchFailure(error)
    });
    const details =
      failedAudit.ok
        ? errorDetails(error)
        : {
            ...errorDetails(error),
            audit_failure_code: failedAudit.error.body.accepted === false ? failedAudit.error.body.error.code : "unknown_error"
          };

    return routeError(statusForDispatchFailure(error), errorCodeForDispatchFailure(error), messageForDispatchFailure(error, parsed.sessionId), {
      sessionId: parsed.sessionId,
      retryable: retryableDispatchFailure(error),
      details
    });
  }

  return {
    status: 202,
    body: writeResponseSchema.parse({
      accepted: true,
      session_id: parsed.sessionId,
      action,
      audit_required: true
    })
  };
}

function parseRouteInput(action: WriteAction, input: WriteRouteInput): ParsedRouteInput {
  const parsedParams = sessionIdParamsSchema.safeParse(input.params);

  if (!parsedParams.success) {
    return {
      ok: false,
      error: routeError(400, "validation_error", "Session id parameter is malformed.", { field: "session_id" })
    };
  }

  const parsedRequest = parseWriteRequest(action, input.body);

  if (!parsedRequest.ok) {
    return parsedRequest;
  }

  const targetSessionIds = parseTargetSessionIds(input.targetSessionIds, parsedParams.data.session_id);

  if (!targetSessionIds.ok) {
    return targetSessionIds;
  }

  return {
    ok: true,
    sessionId: parsedParams.data.session_id,
    targetSessionIds: targetSessionIds.value,
    request: parsedRequest.value
  };
}

function parseWriteRequest(action: WriteAction, body: unknown): { readonly ok: true; readonly value: ParsedWriteRequest } | { readonly ok: false; readonly error: WriteRouteResult } {
  switch (action) {
    case "prompt": {
      const request = promptInputRequestSchema.safeParse(body);
      return request.success
        ? { ok: true, value: { action, text: request.data.text } }
        : { ok: false, error: routeError(400, "validation_error", "Prompt request is malformed.", { field: "body" }) };
    }
    case "slash": {
      const request = parseSlashCandidate(body);
      return request.ok ? { ok: true, value: { action, ...request.value } } : { ok: false, error: request.error };
    }
    case "stop": {
      const request = stopSessionRequestSchema.safeParse(body);
      return request.success
        ? { ok: true, value: { action } }
        : { ok: false, error: routeError(400, "validation_error", "Stop request is malformed.", { field: "body" }) };
    }
    case "raw_input": {
      const request = rawInputRequestSchema.safeParse(body);
      return request.success
        ? { ok: true, value: { action, text: request.data.text, confirmed: request.data.confirmed } }
        : { ok: false, error: routeError(400, "validation_error", "Raw input request is malformed.", { field: "body" }) };
    }
  }
}

function parseSlashCandidate(body: unknown): { readonly ok: true; readonly value: { readonly command: string; readonly argument?: string } } | { readonly ok: false; readonly error: WriteRouteResult } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: routeError(400, "validation_error", "Slash command request is malformed.", { field: "body" }) };
  }

  const candidate = body as Readonly<Record<string, unknown>>;
  const command = candidate.command;
  const argument = candidate.argument;
  const keys = Object.keys(candidate);

  if (keys.some((key) => key !== "command" && key !== "argument") || typeof command !== "string" || command.length === 0 || command.length > 120) {
    return { ok: false, error: routeError(400, "validation_error", "Slash command request is malformed.", { field: "body" }) };
  }

  if (argument !== undefined && (typeof argument !== "string" || argument.length > 4_000)) {
    return { ok: false, error: routeError(400, "validation_error", "Slash command argument is malformed.", { field: "argument" }) };
  }

  if (isAllowedSlashCommand(command)) {
    const request = slashCommandRequestSchema.parse({
      command,
      ...(argument !== undefined ? { argument } : {})
    });
    return {
      ok: true,
      value: {
        command: request.command,
        ...(request.argument !== undefined ? { argument: request.argument } : {})
      }
    };
  }

  return {
    ok: true,
    value: {
      command,
      ...(argument !== undefined ? { argument } : {})
    }
  };
}

function parseTargetSessionIds(
  targetSessionIds: unknown,
  fallbackSessionId: NonNullable<ApiErrorEnvelope["session_id"]>
): { readonly ok: true; readonly value: readonly NonNullable<ApiErrorEnvelope["session_id"]>[] } | { readonly ok: false; readonly error: WriteRouteResult } {
  if (targetSessionIds === undefined) {
    return { ok: true, value: [fallbackSessionId] };
  }

  if (!Array.isArray(targetSessionIds)) {
    return {
      ok: false,
      error: routeError(400, "validation_error", "Target session list is malformed.", { field: "target_session_ids" })
    };
  }

  const parsedIds: NonNullable<ApiErrorEnvelope["session_id"]>[] = [];

  for (const candidate of targetSessionIds) {
    const parsed = sessionIdSchema.safeParse(candidate);

    if (!parsed.success) {
      return {
        ok: false,
        error: routeError(400, "validation_error", "Target session list is malformed.", { field: "target_session_ids" })
      };
    }

    parsedIds.push(parsed.data);
  }

  return { ok: true, value: parsedIds };
}

function authorizeWriteActor(
  authDevices: AuthDeviceRepository,
  input: WriteAuthInput,
  now: () => Date
): { readonly ok: true; readonly actor: AuditActor; readonly device?: AuthDeviceRecord } | { readonly ok: false; readonly error: WriteRouteResult } {
  if (input.localAdmin === true) {
    return {
      ok: true,
      actor: {
        type: "cli",
        client_id: "local_admin",
        permission: "write"
      }
    };
  }

  if (input.rawDeviceToken === undefined || input.rawDeviceToken === null || input.rawCsrfToken === undefined || input.rawCsrfToken === null) {
    return {
      ok: false,
      error: routeError(401, "permission_denied", "Browser writes require a paired device cookie and CSRF header.")
    };
  }

  try {
    const device = authDevices.authorizeBrowserWrite({
      rawDeviceToken: input.rawDeviceToken,
      rawCsrfToken: input.rawCsrfToken,
      now: now()
    });

    return {
      ok: true,
      device,
      actor: {
        type: "dashboard",
        client_id: device.id,
        permission: "write"
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: routeErrorForAuth(error)
    };
  }
}

function loadSession(
  sessions: SessionRepository,
  sessionId: NonNullable<ApiErrorEnvelope["session_id"]>
):
  | { readonly ok: true; readonly session: ReturnType<SessionRepository["require"]> }
  | { readonly ok: false; readonly error: WriteRouteResult } {
  try {
    const session = sessions.get(sessionId);

    if (session === null) {
      return {
        ok: false,
        error: routeError(404, "session_not_found", `Session ${sessionId} does not exist.`, {
          sessionId,
          details: { session_id: sessionId }
        })
      };
    }

    return { ok: true, session };
  } catch (error) {
    return {
      ok: false,
      error: routeError(500, "storage_error", `Session ${sessionId} could not be read.`, {
        sessionId,
        details: errorDetails(error)
      })
    };
  }
}

function loadHostLocked(settings: SettingsRepository): { readonly ok: true; readonly locked: boolean } | { readonly ok: false; readonly error: WriteRouteResult } {
  try {
    return { ok: true, locked: settings.require().locked };
  } catch (error) {
    return {
      ok: false,
      error: routeError(500, "storage_error", "Host settings could not be read.", { details: errorDetails(error) })
    };
  }
}

async function dispatchWrite(
  input: CreateWriteRouteHandlersInput,
  now: () => Date,
  parsed: Extract<ParsedRouteInput, { readonly ok: true }>
): Promise<void> {
  switch (parsed.request.action) {
    case "prompt":
      await input.tmux.sendInput({ sessionId: parsed.sessionId, text: parsed.request.text, enter: true });
      return;
    case "slash":
      await input.tmux.sendInput({ sessionId: parsed.sessionId, text: slashText(parsed.request), enter: true });
      return;
    case "raw_input":
      await input.tmux.sendInput({ sessionId: parsed.sessionId, text: parsed.request.text, enter: false });
      return;
    case "stop": {
      const stopped = await input.tmux.stopSession({ sessionId: parsed.sessionId });
      const session = input.sessions.require(parsed.sessionId);
      input.sessions.update({
        ...session,
        lifecycle_state: stopped.lifecycleState,
        stale_reason: stopped.staleReason,
        updated_at: now().toISOString()
      });
    }
  }
}

function slashText(request: Extract<ParsedWriteRequest, { readonly action: "slash" }>): string {
  return request.argument === undefined || request.argument.length === 0 ? request.command : `${request.command} ${request.argument}`;
}

function appendWriteAudit(
  auditEvents: AuditEventRepository,
  createAuditId: () => string,
  now: () => Date,
  input: {
    readonly actor: AuditActor;
    readonly request: ParsedWriteRequest;
    readonly sessionId: NonNullable<ApiErrorEnvelope["session_id"]>;
    readonly result: "accepted" | "rejected" | "failed";
    readonly errorCode: ErrorCode | null;
  }
): { readonly ok: true } | { readonly ok: false; readonly error: WriteRouteResult } {
  try {
    auditEvents.append({
      id: createAuditId(),
      at: now().toISOString(),
      actor: input.actor,
      action: input.request.action,
      session_id: input.sessionId,
      payload_summary: payloadSummary(input.request),
      result: input.result,
      error_code: input.errorCode
    });

    return { ok: true };
  } catch (error) {
    const code = error instanceof HostDeckAuditRepositoryError && error.code === "audit_unavailable" ? "audit_unavailable" : "storage_error";
    return {
      ok: false,
      error: routeError(statusForErrorCode(code), code, "Write action cannot continue because audit logging is unavailable.", {
        sessionId: input.sessionId,
        retryable: code === "audit_unavailable",
        details: errorDetails(error)
      })
    };
  }
}

function payloadSummary(request: ParsedWriteRequest): Readonly<Record<string, string | number | boolean | null>> {
  switch (request.action) {
    case "prompt":
      return {
        text_length: request.text.length,
        text_preview: preview(request.text)
      };
    case "slash":
      return {
        command: request.command,
        argument_length: request.argument?.length ?? 0
      };
    case "stop":
      return {
        confirmed: true
      };
    case "raw_input":
      return {
        text_length: request.text.length,
        confirmed: request.confirmed
      };
  }
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function routeErrorForAuth(error: unknown): WriteRouteResult {
  if (!(error instanceof HostDeckAuthRepositoryError)) {
    return routeError(500, "storage_error", "Auth storage failed.", { details: errorDetails(error) });
  }

  switch (error.code) {
    case "invalid_secret":
    case "invalid_auth_device":
      return routeError(400, "validation_error", error.message);
    case "read_only":
      return routeError(403, "read_only", error.message);
    case "csrf_mismatch":
      return routeError(403, "permission_denied", error.message);
    case "device_expired":
    case "device_not_found":
    case "device_revoked":
      return routeError(401, "permission_denied", error.message);
    case "device_exists":
    case "duplicate_secret":
    case "invalid_pairing_code":
    case "pairing_code_exists":
    case "pairing_code_expired":
    case "pairing_code_not_found":
    case "pairing_code_revoked":
    case "pairing_code_used":
      return routeError(500, "storage_error", error.message);
  }
}

function errorCodeForDispatchFailure(error: unknown): ErrorCode {
  if (error instanceof HostDeckTmuxAdapterError) {
    return "tmux_error";
  }

  return "storage_error";
}

function statusForDispatchFailure(error: unknown): number {
  if (error instanceof HostDeckTmuxAdapterError) {
    return 502;
  }

  return 500;
}

function retryableDispatchFailure(error: unknown): boolean {
  return error instanceof HostDeckTmuxAdapterError && (error.code === "missing_target" || error.code === "target_not_running" || error.code === "tmux_unavailable");
}

function messageForDispatchFailure(error: unknown, sessionId: NonNullable<ApiErrorEnvelope["session_id"]>): string {
  if (error instanceof HostDeckTmuxAdapterError) {
    return `Tmux write dispatch failed for ${sessionId}.`;
  }

  return `Write dispatch failed for ${sessionId}.`;
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
): WriteRouteResult {
  return {
    status,
    body: writeResponseSchema.parse({
      accepted: false,
      error: envelope(code, message, options)
    })
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

function statusForErrorCode(code: ErrorCode): number {
  switch (code) {
    case "validation_error":
    case "malformed_request":
    case "unsupported_slash":
      return 400;
    case "permission_denied":
      return 403;
    case "read_only":
      return 403;
    case "host_locked":
      return 423;
    case "session_not_found":
      return 404;
    case "stale_session":
    case "session_not_writable":
      return 409;
    case "audit_unavailable":
    case "daemon_unavailable":
      return 503;
    case "tmux_error":
      return 502;
    case "storage_error":
    case "internal_error":
    case "unknown_error":
    case "invalid_config":
    case "missing_binary":
    case "invalid_cwd":
    case "duplicate_session_name":
    case "invalid_session_id":
      return 500;
  }
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
