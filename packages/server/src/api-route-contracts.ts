import {
  apiRouteErrorBodySchema,
  hostStatusResponseSchema,
  lockRequestSchema,
  networkStateResponseSchema,
  outputQuerySchema,
  pairClaimRequestSchema,
  pairClaimResponseSchema,
  pairStatusResponseSchema,
  promptInputRequestSchema,
  rawInputRequestSchema,
  securityStateResponseSchema,
  sessionDetailResponseSchema,
  sessionIdParamsSchema,
  sessionListResponseSchema,
  sessionOutputResponseSchema,
  sessionStreamEventSchema,
  slashCommandRequestSchema,
  startSessionRequestSchema,
  startSessionResponseSchema,
  stopSessionRequestSchema,
  writeResponseSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";

/** @deprecated Historical tmux-shaped manifest retained until IFC-V1-067. */
export type ApiRouteMethod = "GET" | "POST";

/** @deprecated Historical tmux-shaped manifest retained until IFC-V1-067. */
export type ApiRouteAuthMode =
  | "local_read_policy"
  | "local_admin"
  | "dashboard_write_cookie_csrf"
  | "dashboard_write_cookie_csrf_or_local_admin"
  | "pairing_code"
  | "optional_device_cookie"
  | "none"
  | "admin_only_rejected";

/** @deprecated Historical tmux-shaped manifest retained until IFC-V1-067. */
export type ApiRouteFamily = "host" | "sessions" | "stream" | "writes" | "pairing" | "security" | "network";

export interface RuntimeSchema {
  readonly parse: (input: unknown) => unknown;
}

export interface ApiRouteErrorContract {
  readonly status: number;
  readonly code: ErrorCode;
  readonly sample: unknown;
}

/** @deprecated Historical tmux-shaped manifest retained until IFC-V1-067. */
export interface ApiRouteContract {
  readonly id: string;
  readonly family: ApiRouteFamily;
  readonly operation: string;
  readonly handler: string;
  readonly method: ApiRouteMethod;
  readonly path: `/api/${string}`;
  readonly auth: ApiRouteAuthMode;
  readonly paramsSchema?: RuntimeSchema;
  readonly querySchema?: RuntimeSchema;
  readonly bodySchema?: RuntimeSchema;
  readonly successResponseSchema?: RuntimeSchema;
  readonly streamEventSchema?: RuntimeSchema;
  readonly errorResponseSchema: RuntimeSchema;
  readonly samples: {
    readonly params?: unknown;
    readonly query?: unknown;
    readonly body?: unknown;
    readonly successResponse?: unknown;
    readonly streamEvent?: unknown;
  };
  readonly typedErrors: readonly ApiRouteErrorContract[];
}

const sessionId = "sess_route_contract_01";
const timestamp = "2026-07-09T08:00:00.000Z";
const csrfToken = "csrf_token_for_route_contract_123456";

const apiSessionSample = {
  id: sessionId,
  name: "route-contract-demo",
  cwd: "/home/simonli/HostDeck",
  backend: {
    type: "tmux",
    tmux: {
      session_name: `hostdeck_${sessionId}`,
      window_name: "codex",
      pane_id: "%1"
    }
  },
  lifecycle_state: "running",
  status: "running",
  attention: "watch",
  created_at: timestamp,
  updated_at: timestamp,
  last_activity_at: timestamp,
  branch: "main",
  recent_output: {
    text: "working",
    cursor: 4,
    line_count: 1,
    truncated: false
  }
} as const;

const hostStatusSample = {
  version: "0.0.0",
  bind: {
    mode: "localhost",
    host: "127.0.0.1",
    port: 3777
  },
  locked: false,
  lan_enabled: false,
  storage: {
    state: "ok",
    checked_at: timestamp
  },
  tmux: {
    state: "ok",
    checked_at: timestamp
  },
  stream: {
    state: "ok",
    checked_at: timestamp
  },
  startup_checks: [{ name: "state_dir", state: "ok" }],
  stale_session_count: 0,
  last_error: null
} as const;

const trustStateSample = {
  trusted: true,
  read_only: false,
  locked: false,
  lan_enabled: false,
  client_id: "client_route_contract",
  auth_transport: "http_only_cookie",
  csrf_token: csrfToken
} as const;

/** @deprecated Historical 17-route tmux manifest. Use selectedApiRouteManifest. */
export const apiRouteContracts: readonly ApiRouteContract[] = [
  {
    id: "host_status",
    family: "host",
    operation: "Host status",
    handler: "read.hostStatus",
    method: "GET",
    path: "/api/host/status",
    auth: "local_read_policy",
    successResponseSchema: hostStatusResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      successResponse: hostStatusSample
    },
    typedErrors: [errorContract(403, "permission_denied"), errorContract(500, "internal_error")]
  },
  {
    id: "session_list",
    family: "sessions",
    operation: "Session list",
    handler: "read.listSessions",
    method: "GET",
    path: "/api/sessions",
    auth: "local_read_policy",
    successResponseSchema: sessionListResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      successResponse: { sessions: [apiSessionSample] }
    },
    typedErrors: [errorContract(403, "permission_denied"), errorContract(500, "storage_error")]
  },
  {
    id: "session_start",
    family: "sessions",
    operation: "Start session",
    handler: "control.startSession",
    method: "POST",
    path: "/api/sessions",
    auth: "local_admin",
    bodySchema: startSessionRequestSchema,
    successResponseSchema: startSessionResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      body: { name: "route-contract-demo", cwd: "/home/simonli/HostDeck" },
      successResponse: { session: apiSessionSample }
    },
    typedErrors: [
      errorContract(400, "invalid_cwd", "cwd"),
      errorContract(400, "validation_error", "name"),
      errorContract(409, "duplicate_session_name", "name"),
      errorContract(500, "missing_binary", "command"),
      errorContract(502, "tmux_error"),
      errorContract(500, "storage_error"),
      errorContract(500, "internal_error")
    ]
  },
  {
    id: "session_detail",
    family: "sessions",
    operation: "Session detail",
    handler: "read.sessionDetail",
    method: "GET",
    path: "/api/sessions/:session_id",
    auth: "local_read_policy",
    paramsSchema: sessionIdParamsSchema,
    successResponseSchema: sessionDetailResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      params: { session_id: sessionId },
      successResponse: { session: apiSessionSample }
    },
    typedErrors: [errorContract(400, "validation_error", "session_id"), errorContract(403, "permission_denied"), errorContract(404, "session_not_found")]
  },
  {
    id: "session_output",
    family: "sessions",
    operation: "Session output",
    handler: "read.sessionOutput",
    method: "GET",
    path: "/api/sessions/:session_id/output",
    auth: "local_read_policy",
    paramsSchema: sessionIdParamsSchema,
    querySchema: outputQuerySchema,
    successResponseSchema: sessionOutputResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      params: { session_id: sessionId },
      query: { after: 3 },
      successResponse: {
        session_id: sessionId,
        events: [{ type: "output", session_id: sessionId, cursor: 4, captured_at: timestamp, text: "line" }],
        next_cursor: 5,
        truncated: false
      }
    },
    typedErrors: [
      errorContract(400, "validation_error", "after"),
      errorContract(403, "permission_denied"),
      errorContract(404, "session_not_found"),
      errorContract(409, "stale_session"),
      errorContract(500, "storage_error")
    ]
  },
  {
    id: "session_stream",
    family: "stream",
    operation: "Session stream",
    handler: "stream.sessionStream",
    method: "GET",
    path: "/api/sessions/:session_id/stream",
    auth: "local_read_policy",
    paramsSchema: sessionIdParamsSchema,
    querySchema: outputQuerySchema,
    streamEventSchema: sessionStreamEventSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      params: { session_id: sessionId },
      query: { after: 3 },
      streamEvent: {
        type: "replay_boundary",
        session_id: sessionId,
        after: 1,
        next_cursor: 4,
        reason: "stale_cursor"
      }
    },
    typedErrors: [
      errorContract(400, "validation_error", "after"),
      errorContract(403, "permission_denied"),
      errorContract(404, "session_not_found"),
      errorContract(409, "stale_session"),
      errorContract(500, "storage_error"),
      errorContract(503, "daemon_unavailable")
    ]
  },
  {
    id: "prompt_input",
    family: "writes",
    operation: "Prompt input",
    handler: "write.promptInput",
    method: "POST",
    path: "/api/sessions/:session_id/input",
    auth: "dashboard_write_cookie_csrf_or_local_admin",
    paramsSchema: sessionIdParamsSchema,
    bodySchema: promptInputRequestSchema,
    successResponseSchema: writeResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      params: { session_id: sessionId },
      body: { text: "Continue" },
      successResponse: acceptedWrite("prompt")
    },
    typedErrors: writeTypedErrors()
  },
  {
    id: "slash_command",
    family: "writes",
    operation: "Slash command",
    handler: "write.slashCommand",
    method: "POST",
    path: "/api/sessions/:session_id/slash",
    auth: "dashboard_write_cookie_csrf_or_local_admin",
    paramsSchema: sessionIdParamsSchema,
    bodySchema: slashCommandRequestSchema,
    successResponseSchema: writeResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      params: { session_id: sessionId },
      body: { command: "/plan", argument: "next" },
      successResponse: acceptedWrite("slash")
    },
    typedErrors: [...writeTypedErrors(), errorContract(400, "unsupported_slash")]
  },
  {
    id: "stop_session",
    family: "writes",
    operation: "Stop session",
    handler: "write.stopSession",
    method: "POST",
    path: "/api/sessions/:session_id/stop",
    auth: "dashboard_write_cookie_csrf_or_local_admin",
    paramsSchema: sessionIdParamsSchema,
    bodySchema: stopSessionRequestSchema,
    successResponseSchema: writeResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      params: { session_id: sessionId },
      body: { confirm: true },
      successResponse: acceptedWrite("stop")
    },
    typedErrors: writeTypedErrors()
  },
  {
    id: "raw_input",
    family: "writes",
    operation: "Raw input",
    handler: "write.rawInput",
    method: "POST",
    path: "/api/sessions/:session_id/raw-input",
    auth: "dashboard_write_cookie_csrf_or_local_admin",
    paramsSchema: sessionIdParamsSchema,
    bodySchema: rawInputRequestSchema,
    successResponseSchema: writeResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      params: { session_id: sessionId },
      body: { text: "q", confirmed: true },
      successResponse: acceptedWrite("raw_input")
    },
    typedErrors: [...writeTypedErrors(), errorContract(409, "session_not_writable")]
  },
  {
    id: "pair_claim",
    family: "pairing",
    operation: "Pair claim",
    handler: "security.claimPairingCode",
    method: "POST",
    path: "/api/pair/claim",
    auth: "pairing_code",
    bodySchema: pairClaimRequestSchema,
    successResponseSchema: pairClaimResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      body: { code: "123456", client_label: "phone" },
      successResponse: trustStateSample
    },
    typedErrors: [errorContract(400, "validation_error", "body"), errorContract(401, "permission_denied"), errorContract(500, "storage_error")]
  },
  {
    id: "pair_status",
    family: "pairing",
    operation: "Pair status",
    handler: "security.pairStatus",
    method: "GET",
    path: "/api/pair/status",
    auth: "optional_device_cookie",
    successResponseSchema: pairStatusResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      successResponse: trustStateSample
    },
    typedErrors: [errorContract(500, "storage_error")]
  },
  {
    id: "security_state",
    family: "security",
    operation: "Security state",
    handler: "security.securityState",
    method: "GET",
    path: "/api/security/state",
    auth: "optional_device_cookie",
    successResponseSchema: securityStateResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      successResponse: trustStateSample
    },
    typedErrors: [errorContract(500, "storage_error")]
  },
  {
    id: "dashboard_lock",
    family: "security",
    operation: "Dashboard lock",
    handler: "security.lockFromDashboard",
    method: "POST",
    path: "/api/security/lock",
    auth: "dashboard_write_cookie_csrf",
    bodySchema: lockRequestSchema,
    successResponseSchema: securityStateResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      body: { lock: true, reason: "operator request" },
      successResponse: { ...trustStateSample, locked: true, csrf_token: null }
    },
    typedErrors: [errorContract(400, "validation_error", "body"), errorContract(401, "permission_denied"), errorContract(403, "permission_denied"), errorContract(500, "storage_error")]
  },
  {
    id: "dashboard_unlock_rejected",
    family: "security",
    operation: "Dashboard unlock rejection",
    handler: "security.unlockFromDashboard",
    method: "POST",
    path: "/api/security/unlock",
    auth: "admin_only_rejected",
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {},
    typedErrors: [errorContract(403, "permission_denied")]
  },
  {
    id: "network_state",
    family: "network",
    operation: "Network state",
    handler: "security.networkState",
    method: "GET",
    path: "/api/network/state",
    auth: "none",
    successResponseSchema: networkStateResponseSchema,
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {
      successResponse: {
        mode: "localhost",
        host: "127.0.0.1",
        port: 3777,
        lan_enabled: false
      }
    },
    typedErrors: [errorContract(500, "storage_error")]
  },
  {
    id: "dashboard_lan_mutation_rejected",
    family: "network",
    operation: "Dashboard LAN mutation rejection",
    handler: "security.mutateLanFromDashboard",
    method: "POST",
    path: "/api/network/lan",
    auth: "admin_only_rejected",
    errorResponseSchema: apiRouteErrorBodySchema,
    samples: {},
    typedErrors: [errorContract(403, "permission_denied")]
  }
];

function acceptedWrite(action: "prompt" | "slash" | "stop" | "raw_input") {
  return {
    accepted: true,
    session_id: sessionId,
    action,
    audit_required: true
  } as const;
}

function errorContract(status: number, code: ErrorCode, field?: string): ApiRouteErrorContract {
  return {
    status,
    code,
    sample: {
      error: {
        code,
        message: `${code} sample.`,
        retryable: code === "audit_unavailable" || code === "daemon_unavailable" || code === "session_not_writable",
        ...(field !== undefined ? { field } : {}),
        ...(code === "session_not_found" || code === "stale_session" || code === "session_not_writable" ? { session_id: sessionId } : {})
      }
    }
  };
}

function writeTypedErrors(): readonly ApiRouteErrorContract[] {
  return [
    errorContract(400, "validation_error", "body"),
    errorContract(401, "permission_denied"),
    errorContract(403, "permission_denied"),
    errorContract(403, "read_only"),
    errorContract(404, "session_not_found"),
    errorContract(409, "stale_session"),
    errorContract(409, "session_not_writable"),
    errorContract(423, "host_locked"),
    errorContract(502, "tmux_error"),
    errorContract(503, "audit_unavailable")
  ];
}
