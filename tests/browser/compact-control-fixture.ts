import type { Page, Request, Route } from "@playwright/test";
import {
  type ApiErrorEnvelope,
  type CompactProgressResponse,
  type CompactStartRequest,
  compactProgressResponseSchema,
  compactStartRequestSchema,
  selectedOperationProgressSchema
} from "../../packages/contracts/src/index.js";
import {
  type SessionDetailApiVariant,
  sessionDetailBrowserCodexThreadId,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";
import {
  installUsageControlApi,
  type UsageControlApiController
} from "./usage-control-fixture.js";

export type CompactProgressVariant =
  | "absent"
  | "accepted"
  | "running"
  | "completed"
  | "interrupted"
  | "failed_retryable"
  | "failed_terminal"
  | "incomplete";

export type CompactReadOutcome =
  | "success"
  | "pending"
  | "unsupported"
  | "known_failure"
  | "malformed";

export type CompactStartOutcome =
  | "success"
  | "pending"
  | "conflict"
  | "known_failure"
  | "unknown"
  | "malformed";

export interface CompactControlApiController {
  readonly usage: UsageControlApiController;
  readonly hasPendingRead: () => boolean;
  readonly hasPendingStart: () => boolean;
  readonly readRequests: () => readonly Request[];
  readonly releaseRead: (outcome?: Exclude<CompactReadOutcome, "pending">) => void;
  readonly releaseStart: (outcome?: Exclude<CompactStartOutcome, "pending">) => void;
  readonly setProgressVariant: (variant: CompactProgressVariant) => void;
  readonly setReadOutcome: (outcome: CompactReadOutcome) => void;
  readonly setSessionVariant: (variant: SessionDetailApiVariant) => void;
  readonly setStartOutcome: (outcome: CompactStartOutcome) => void;
  readonly startRequests: () => readonly Request[];
}

const timestamp = "2026-07-27T16:00:00.000Z";
const compactPath = `/api/v1/sessions/${sessionDetailBrowserSessionId}/compact`;
const fixtureOperationId = "op_server_compact_browser_fixture_001";
const threadId = sessionDetailBrowserCodexThreadId;

export async function installCompactControlApi(
  page: Page,
  input: Readonly<{
    progressVariant?: CompactProgressVariant;
    sessionVariant?: SessionDetailApiVariant;
  }> = {}
): Promise<CompactControlApiController> {
  const usage = await installUsageControlApi(page, {
    sessionVariant: input.sessionVariant ?? "writable"
  });
  let progress = compactResponse(input.progressVariant ?? "absent");
  let readOutcome: CompactReadOutcome = "success";
  let startOutcome: CompactStartOutcome = "success";
  let pendingReadResolution:
    | ((outcome: Exclude<CompactReadOutcome, "pending">) => void)
    | null = null;
  let pendingStartResolution:
    | ((outcome: Exclude<CompactStartOutcome, "pending">) => void)
    | null = null;
  const reads: Request[] = [];
  const starts: Request[] = [];

  await page.route(`**${compactPath}`, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      reads.push(request);
      let selectedOutcome = readOutcome;
      if (selectedOutcome === "pending") {
        if (pendingReadResolution !== null) {
          await route.fulfill({ status: 500, body: "duplicate pending Compact read" });
          return;
        }
        selectedOutcome = await new Promise<Exclude<CompactReadOutcome, "pending">>(
          (resolve) => {
            pendingReadResolution = resolve;
          }
        );
        pendingReadResolution = null;
      }
      await fulfillReadOutcome(route, progress, selectedOutcome);
      return;
    }
    if (request.method() === "POST") {
      starts.push(request);
      let body: CompactStartRequest;
      try {
        body = compactStartRequestSchema.parse(request.postDataJSON());
      } catch {
        await fulfillApiError(route, 400, "validation_error", false);
        return;
      }
      let selectedOutcome = startOutcome;
      if (selectedOutcome === "pending") {
        if (pendingStartResolution !== null) {
          await route.fulfill({ status: 500, body: "duplicate pending Compact start" });
          return;
        }
        selectedOutcome = await new Promise<Exclude<CompactStartOutcome, "pending">>(
          (resolve) => {
            pendingStartResolution = resolve;
          }
        );
        pendingStartResolution = null;
      }
      if (selectedOutcome === "success") {
        progress = compactResponse("accepted", body.operation_id);
        await fulfillJson(route, progress, 202);
        return;
      }
      if (selectedOutcome === "conflict") {
        await fulfillApiError(route, 409, "operation_conflict", true);
        return;
      }
      if (selectedOutcome === "known_failure") {
        await fulfillApiError(route, 400, "validation_error", false);
        return;
      }
      if (selectedOutcome === "unknown") {
        await fulfillApiError(route, 504, "operation_timeout", true);
        return;
      }
      await fulfillJson(
        route,
        compactResponse("accepted", "op_server_compact_browser_mismatch_001"),
        202
      );
      return;
    }
    await route.fulfill({ status: 405, body: "unexpected Compact method" });
  });

  return Object.freeze({
    usage,
    hasPendingRead: () => pendingReadResolution !== null,
    hasPendingStart: () => pendingStartResolution !== null,
    readRequests: () => reads,
    releaseRead(outcome: Exclude<CompactReadOutcome, "pending"> = "success") {
      if (pendingReadResolution === null) throw new TypeError("No pending Compact read exists.");
      readOutcome = outcome;
      pendingReadResolution(outcome);
    },
    releaseStart(outcome: Exclude<CompactStartOutcome, "pending"> = "success") {
      if (pendingStartResolution === null) throw new TypeError("No pending Compact start exists.");
      startOutcome = outcome;
      pendingStartResolution(outcome);
    },
    setProgressVariant(variant: CompactProgressVariant) {
      progress = compactResponse(variant);
    },
    setReadOutcome(outcome: CompactReadOutcome) {
      if (pendingReadResolution !== null) throw new TypeError("Cannot replace a pending Compact read.");
      readOutcome = outcome;
    },
    setSessionVariant(variant: SessionDetailApiVariant) {
      usage.setSessionVariant(variant);
    },
    setStartOutcome(outcome: CompactStartOutcome) {
      if (pendingStartResolution !== null) throw new TypeError("Cannot replace a pending Compact start.");
      startOutcome = outcome;
    },
    startRequests: () => starts
  });
}

export function compactResponse(
  variant: CompactProgressVariant,
  operationId = fixtureOperationId
): CompactProgressResponse {
  if (variant === "absent") return compactProgressResponseSchema.parse({ progress: null });
  const state = variant === "failed_retryable" || variant === "failed_terminal"
    ? "failed"
    : variant;
  const turnId = ["running", "completed", "interrupted", "failed"].includes(state)
    ? "turn-private-browser-compact"
    : null;
  const error = state === "failed" || state === "incomplete"
    ? {
        code: state === "failed" ? "runtime_unavailable" as const : "unknown_error" as const,
        message: "Private Compact progress fixture detail.",
        retryable: variant === "failed_retryable"
      }
    : null;
  return compactProgressResponseSchema.parse({
    progress: selectedOperationProgressSchema.parse({
      operation_id: operationId,
      kind: "compact",
      target: {
        type: "managed_session",
        session_id: sessionDetailBrowserSessionId,
        codex_thread_id: threadId
      },
      state,
      updated_at: timestamp,
      turn_id: turnId,
      error
    })
  });
}

async function fulfillReadOutcome(
  route: Route,
  progress: CompactProgressResponse,
  outcome: Exclude<CompactReadOutcome, "pending">
): Promise<void> {
  if (outcome === "unsupported") {
    await fulfillApiError(route, 409, "capability_unavailable", false);
    return;
  }
  if (outcome === "known_failure") {
    await fulfillApiError(route, 503, "service_overloaded", true);
    return;
  }
  if (outcome === "malformed") {
    await fulfillJson(route, { ...progress, private_extension: true });
    return;
  }
  await fulfillJson(route, progress);
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

async function fulfillApiError(
  route: Route,
  status: number,
  code: ApiErrorEnvelope["code"],
  retryable: boolean
): Promise<void> {
  await fulfillJson(
    route,
    {
      error: {
        code,
        message: "Private Compact fixture detail.",
        retryable
      }
    },
    status
  );
}
