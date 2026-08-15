import type { Page, Request, Route } from "@playwright/test";
import {
  type ApiErrorEnvelope,
  type ApprovalResponseRequest,
  approvalResponseRequestSchema,
  type PendingApproval,
  type PendingApprovalListResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  selectedProjectionEventSchema
} from "../../packages/contracts/src/index.js";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  type SessionDetailApiVariant,
  type SessionDetailEventFixture,
  sessionDetailBrowserCodexThreadId,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type ApprovalSnapshotVariant =
  | "empty"
  | "normal"
  | "elevated"
  | "broad"
  | "responding"
  | "approved"
  | "denied"
  | "expired"
  | "superseded"
  | "session_grant"
  | "list_only"
  | "conflict"
  | "multiple"
  | "long_multiple";

export type ApprovalReadOutcome = "success" | "pending" | "unsupported" | "known_failure";

export type ApprovalRespondOutcome =
  | "terminal"
  | "pending"
  | "unsupported"
  | "known_failure"
  | "ambiguous"
  | "correlation_mismatch";

export interface ApprovalDecisionsApiController {
  readonly session: SessionDetailApiController;
  readonly approvalReadRequests: () => readonly Request[];
  readonly approvalRespondRequests: () => readonly Request[];
  readonly hasPendingRead: () => boolean;
  readonly hasPendingResponse: () => boolean;
  readonly releaseRead: (outcome?: Exclude<ApprovalReadOutcome, "pending">) => void;
  readonly releaseResponse: (outcome?: Exclude<ApprovalRespondOutcome, "pending">) => void;
  readonly setReadOutcome: (outcome: ApprovalReadOutcome) => void;
  readonly setRespondOutcome: (outcome: ApprovalRespondOutcome) => void;
  readonly setSessionVariant: (variant: SessionDetailApiVariant) => void;
  readonly setSnapshotVariant: (variant: ApprovalSnapshotVariant) => void;
}

const sessionId = sessionDetailBrowserSessionId;
const threadId = sessionDetailBrowserCodexThreadId;
const eventRequestId = "request-private-browser-detail";
const normalRequestId = "string:approval-browser-normal-001";
const broadRequestId = "string:approval-browser-broad-001";
const policyRequestId = "string:approval-browser-policy-001";
const longRequestId = "string:approval-browser-long-001";
const timestamp = "2026-07-22T18:06:00.000Z";
const expiry = "2026-07-22T23:00:00.000Z";
const listPath = `/api/v1/sessions/${sessionId}/approvals`;

export function broadApprovalRequestEvent(cursor: number): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: `2026-07-22T18:${String(cursor).padStart(2, "0")}:00.000Z`,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "approval",
    request_id: broadRequestId,
    state: "pending",
    action: "Publish the signed Android validation package",
    scope: "Selected Android release channel",
    reason: "Verify the current mobile release candidate.",
    risk: "broad",
    expires_at: expiry,
    decision: null
  });
}

export async function installApprovalDecisionsApi(
  page: Page,
  input: Readonly<{
    sessionVariant?: SessionDetailApiVariant;
    snapshotVariant?: ApprovalSnapshotVariant;
    readOutcome?: ApprovalReadOutcome;
    respondOutcome?: ApprovalRespondOutcome;
  }> = {}
): Promise<ApprovalDecisionsApiController> {
  const session = await installSessionDetailApi(page, input.sessionVariant ?? "active");
  let approvals = approvalsForVariant(input.snapshotVariant ?? "elevated");
  let readOutcome = input.readOutcome ?? "success";
  let respondOutcome = input.respondOutcome ?? "terminal";
  let pendingReadResolution: (() => void) | null = null;
  let pendingResponseResolution: (() => void) | null = null;
  const requests: Request[] = [];

  await page.route(`**${listPath}`, async (route) => {
    const request = route.request();
    requests.push(request);
    if (request.method() !== "GET") {
      await route.fulfill({ status: 405, body: "unexpected approval-list method" });
      return;
    }
    if (readOutcome === "pending") {
      if (pendingReadResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending approval read" });
        return;
      }
      await new Promise<void>((resolve) => {
        pendingReadResolution = resolve;
      });
      pendingReadResolution = null;
    }
    if (readOutcome === "unsupported") {
      await fulfillApiError(route, 409, "capability_unavailable", false);
      return;
    }
    if (readOutcome === "known_failure") {
      await fulfillApiError(route, 503, "service_overloaded", true);
      return;
    }
    await fulfillJson(route, approvalList(approvals));
  });

  await page.route(`**${listPath}/*/respond`, async (route) => {
    const request = route.request();
    requests.push(request);
    if (request.method() !== "POST") {
      await route.fulfill({ status: 405, body: "unexpected approval-response method" });
      return;
    }
    const responseRequest = parseResponseRequest(request);
    const requestId = responseRequest === null ? null : requestIdFrom(request);
    const baseline = requestId === null
      ? undefined
      : approvals.find((approval) => approval.target.request_id === requestId);
    if (
      responseRequest === null ||
      baseline === undefined ||
      baseline.state !== "pending" ||
      baseline.decision !== null
    ) {
      await fulfillApiError(route, 409, "operation_conflict", true);
      return;
    }

    if (respondOutcome === "pending") {
      if (pendingResponseResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending approval response" });
        return;
      }
      await new Promise<void>((resolve) => {
        pendingResponseResolution = resolve;
      });
      pendingResponseResolution = null;
    }
    if (respondOutcome === "known_failure") {
      await fulfillApiError(route, 503, "service_overloaded", true);
      return;
    }
    if (respondOutcome === "unsupported") {
      await fulfillApiError(route, 409, "capability_unavailable", false);
      return;
    }
    if (respondOutcome === "ambiguous") {
      await fulfillApiError(route, 504, "operation_timeout", false);
      return;
    }
    if (respondOutcome === "correlation_mismatch") {
      await fulfillJson(
        route,
        terminalResponse(
          baseline,
          "op_browser_approval_11111111111141118111111111111111",
          responseRequest.decision
        )
      );
      return;
    }

    const terminal = terminalApproval(baseline, responseRequest.decision);
    approvals = Object.freeze(
      approvals.map((approval) =>
        approval.target.request_id === baseline.target.request_id ? terminal : approval
      )
    );
    await fulfillJson(
      route,
      terminalResponse(baseline, responseRequest.operation_id, responseRequest.decision)
    );
  });

  return Object.freeze({
    session,
    approvalReadRequests: () =>
      requests.filter((request) => request.method() === "GET"),
    approvalRespondRequests: () =>
      requests.filter((request) => request.method() === "POST"),
    hasPendingRead: () => pendingReadResolution !== null,
    hasPendingResponse: () => pendingResponseResolution !== null,
    releaseRead(outcome: Exclude<ApprovalReadOutcome, "pending"> = "success") {
      if (pendingReadResolution === null) throw new TypeError("No pending approval read exists.");
      readOutcome = outcome;
      pendingReadResolution();
    },
    releaseResponse(outcome: Exclude<ApprovalRespondOutcome, "pending"> = "terminal") {
      if (pendingResponseResolution === null) {
        throw new TypeError("No pending approval response exists.");
      }
      respondOutcome = outcome;
      pendingResponseResolution();
    },
    setReadOutcome(outcome: ApprovalReadOutcome) {
      if (pendingReadResolution !== null) {
        throw new TypeError("Cannot replace a pending approval read outcome.");
      }
      readOutcome = outcome;
    },
    setRespondOutcome(outcome: ApprovalRespondOutcome) {
      if (pendingResponseResolution !== null) {
        throw new TypeError("Cannot replace a pending approval response outcome.");
      }
      respondOutcome = outcome;
    },
    setSessionVariant(variant: SessionDetailApiVariant) {
      session.setVariant(variant);
    },
    setSnapshotVariant(variant: ApprovalSnapshotVariant) {
      approvals = approvalsForVariant(variant);
    }
  });
}

function approvalsForVariant(variant: ApprovalSnapshotVariant): readonly PendingApproval[] {
  switch (variant) {
    case "empty":
      return Object.freeze([]);
    case "normal":
      return Object.freeze([listOnlyApproval({ risk: "normal" })]);
    case "elevated":
      return Object.freeze([eventApproval()]);
    case "broad":
      return Object.freeze([broadApproval()]);
    case "responding":
      return Object.freeze([eventApproval({ state: "responding" })]);
    case "approved":
      return Object.freeze([eventApproval({ state: "approved", decision: "approve" })]);
    case "denied":
      return Object.freeze([eventApproval({ state: "denied", decision: "deny" })]);
    case "expired":
      return Object.freeze([eventApproval({ state: "expired" })]);
    case "superseded":
      return Object.freeze([eventApproval({ state: "superseded" })]);
    case "session_grant":
      return Object.freeze([
        listOnlyApproval({ requestId: policyRequestId, grantScope: "session" })
      ]);
    case "list_only":
      return Object.freeze([listOnlyApproval({ risk: "elevated" })]);
    case "conflict":
      return Object.freeze([eventApproval({ scope: "A conflicting process-live scope" })]);
    case "multiple":
      return Object.freeze([
        eventApproval(),
        listOnlyApproval({ risk: "normal" }),
        broadApproval()
      ]);
    case "long_multiple":
      return Object.freeze([
        listOnlyApproval({ risk: "normal" }),
        broadApproval(),
        listOnlyApproval({
          requestId: longRequestId,
          risk: "broad",
          action:
            "Publish the signed Android validation package after completing every bounded release-readiness check for the connected phone",
          scope:
            "The selected release channel and the connected Xiaomi validation device with an intentionally extended display label",
          reason:
            "The release operator requested one exact deployment after responsive layout, accessibility, package integrity, authority, and privacy evidence were reviewed."
        })
      ]);
  }
}

function broadApproval(): PendingApproval {
  return listOnlyApproval({
    requestId: broadRequestId,
    risk: "broad",
    action: "Publish the signed Android validation package",
    scope: "Selected Android release channel"
  });
}

function eventApproval(input: Readonly<{
  state?: PendingApproval["state"];
  decision?: "approve" | "deny" | null;
  scope?: string;
}> = {}): PendingApproval {
  return approval({
    requestId: eventRequestId,
    action: "Install the Android validation package",
    scope: input.scope ?? "Connected test phone",
    reason: "Continue the bounded release validation on the selected device.",
    risk: "elevated",
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.decision === undefined ? {} : { decision: input.decision })
  });
}

function listOnlyApproval(input: Readonly<{
  requestId?: string;
  action?: string;
  scope?: string;
  reason?: string | null;
  risk?: "normal" | "elevated" | "broad";
  grantScope?: "one_time" | "session";
}> = {}): PendingApproval {
  return approval({
    requestId: input.requestId ?? normalRequestId,
    action: input.action ?? "Run the focused Android release validation",
    scope: input.scope ?? "Selected workspace and connected phone",
    reason: input.reason === undefined
      ? "Verify the current mobile release candidate."
      : input.reason,
    risk: input.risk ?? "elevated",
    ...(input.grantScope === undefined ? {} : { grantScope: input.grantScope })
  });
}

function approval(input: Readonly<{
  requestId: string;
  action: string;
  scope: string;
  reason: string | null;
  risk: "normal" | "elevated" | "broad";
  grantScope?: "one_time" | "session";
  state?: PendingApproval["state"];
  decision?: "approve" | "deny" | null;
}>): PendingApproval {
  const state = input.state ?? "pending";
  const parsed = pendingApprovalListResponseSchema.parse({
    target: { type: "managed_session", session_id: sessionId, codex_thread_id: threadId },
    approvals: [{
      target: {
        type: "approval",
        session_id: sessionId,
        codex_thread_id: threadId,
        request_id: input.requestId
      },
      action: input.action,
      scope: input.scope,
      reason: input.reason,
      risk: input.risk,
      grant_scope: input.grantScope ?? "one_time",
      state,
      created_at: timestamp,
      expires_at: expiry,
      decision: input.decision ?? null
    }]
  }).approvals[0];
  if (parsed === undefined) throw new TypeError("Approval browser fixture did not parse.");
  return parsed;
}

function approvalList(approvals: readonly PendingApproval[]): PendingApprovalListResponse {
  return pendingApprovalListResponseSchema.parse({
    target: { type: "managed_session", session_id: sessionId, codex_thread_id: threadId },
    approvals
  });
}

function terminalApproval(
  baseline: PendingApproval,
  decision: ApprovalResponseRequest["decision"]
): PendingApproval {
  return {
    ...baseline,
    state: decision === "approve" ? "approved" : "denied",
    decision
  } as PendingApproval;
}

function terminalResponse(
  baseline: PendingApproval,
  operationId: string,
  decision: ApprovalResponseRequest["decision"]
) {
  return pendingApprovalResponseSchema.parse({
    operation_id: operationId,
    requested_decision: decision,
    approval: terminalApproval(baseline, decision)
  });
}

function parseResponseRequest(request: Request): ApprovalResponseRequest | null {
  try {
    return approvalResponseRequestSchema.parse(request.postDataJSON());
  } catch {
    return null;
  }
}

function requestIdFrom(request: Request): string | null {
  const pathname = new URL(request.url()).pathname;
  const prefix = `${listPath}/`;
  const suffix = "/respond";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const encoded = pathname.slice(prefix.length, -suffix.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return {
    code,
    message: "Private approval fixture detail must not reach the UI.",
    retryable
  };
}

async function fulfillApiError(
  route: Route,
  status: number,
  code: ApiErrorEnvelope["code"],
  retryable: boolean
): Promise<void> {
  await fulfillJson(route, { error: apiError(code, retryable) }, status);
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}
