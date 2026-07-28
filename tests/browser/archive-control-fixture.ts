import type { Page, Request } from "@playwright/test";
import {
  type ArchiveSessionRequest,
  archiveSessionRequestSchema,
  selectedOperationDispatchSchema
} from "../../packages/contracts/src/index.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

export type ArchiveApiOutcome =
  | "success"
  | "blocked"
  | "not_completed"
  | "not_found"
  | "incompatible"
  | "timeout"
  | "conflict"
  | "storage"
  | "malformed"
  | "mismatch"
  | "pending";

export interface ArchiveApiController {
  readonly hasPendingRequest: () => boolean;
  readonly release: (outcome?: Exclude<ArchiveApiOutcome, "pending">) => void;
  readonly requests: () => readonly Request[];
  readonly setCloseStreamBeforeResponse: (enabled: boolean) => void;
  readonly setOutcome: (outcome: ArchiveApiOutcome) => void;
}

const timestamp = "2026-07-27T22:00:00.000Z";
const threadId = "thread-private-browser-detail";

export async function installArchiveApi(page: Page): Promise<ArchiveApiController> {
  let outcome: ArchiveApiOutcome = "success";
  let closeStreamBeforeResponse = false;
  let pendingResolution: ((result: Exclude<ArchiveApiOutcome, "pending">) => void) | null = null;
  const captured: Request[] = [];
  const path = `/api/v1/sessions/${sessionDetailBrowserSessionId}/archive`;

  await page.route(`**${path}`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== path || request.method() !== "POST") {
      await route.fallback();
      return;
    }
    captured.push(request);
    let requestBody: ArchiveSessionRequest;
    try {
      requestBody = archiveSessionRequestSchema.parse(request.postDataJSON());
    } catch {
      await fulfillJson(
        route,
        {
          error: {
            code: "validation_error",
            message: "Archive request fixture validation failed.",
            retryable: false
          }
        },
        400
      );
      return;
    }

    let selectedOutcome = outcome;
    if (selectedOutcome === "pending") {
      if (pendingResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending archive request" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<ArchiveApiOutcome, "pending">>((resolve) => {
        pendingResolution = resolve;
      });
      pendingResolution = null;
    }
    if (selectedOutcome === "success" && closeStreamBeforeResponse) {
      await page.evaluate(() => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionDetailSse?: { readonly dropStream: () => void };
          }
        ).__hostdeckSessionDetailSse;
        if (runtime === undefined) {
          throw new TypeError("Archive fixture Session Detail SSE owner is missing.");
        }
        runtime.dropStream();
      });
    }
    await fulfillOutcome(route, requestBody, selectedOutcome);
  });

  return Object.freeze({
    hasPendingRequest: () => pendingResolution !== null,
    release(selectedOutcome: Exclude<ArchiveApiOutcome, "pending"> = "success") {
      if (pendingResolution === null) {
        throw new TypeError("No pending archive request exists.");
      }
      pendingResolution(selectedOutcome);
    },
    requests: () => Object.freeze([...captured]),
    setCloseStreamBeforeResponse(enabled: boolean) {
      if (pendingResolution !== null) {
        throw new TypeError("An archive request is already pending.");
      }
      closeStreamBeforeResponse = enabled;
    },
    setOutcome(selectedOutcome: ArchiveApiOutcome) {
      if (pendingResolution !== null) {
        throw new TypeError("An archive request is already pending.");
      }
      outcome = selectedOutcome;
    }
  });
}

async function fulfillOutcome(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  request: ArchiveSessionRequest,
  outcome: Exclude<ArchiveApiOutcome, "pending">
): Promise<void> {
  const error = errorForOutcome(outcome);
  if (error !== null) {
    await fulfillJson(route, { error: error.body }, error.status);
    return;
  }
  const operationId = outcome === "mismatch"
    ? "op_browser_archive_11111111111141118111111111111111"
    : request.operation_id;
  const response = {
    operation_id: operationId,
    kind: "archive",
    target: {
      type: "managed_session",
      session_id: sessionDetailBrowserSessionId,
      codex_thread_id: threadId
    },
    state: "accepted",
    accepted_at: timestamp,
    audit_record_id: "audit-private-browser-archive"
  };
  if (outcome === "malformed") {
    await fulfillJson(route, { ...response, private_extra: true }, 202);
    return;
  }
  await fulfillJson(route, selectedOperationDispatchSchema.parse(response), 202);
}

function errorForOutcome(
  outcome: Exclude<ArchiveApiOutcome, "pending">
): Readonly<{
  body: Readonly<{ code: string; message: string; retryable: boolean }>;
  status: number;
}> | null {
  const privateMessage = "PRIVATE archive fixture path /workspace/archive must never render.";
  switch (outcome) {
    case "success":
    case "malformed":
    case "mismatch":
      return null;
    case "blocked":
      return Object.freeze({
        body: Object.freeze({ code: "host_locked", message: privateMessage, retryable: false }),
        status: 423
      });
    case "not_completed":
      return Object.freeze({
        body: Object.freeze({ code: "stale_session", message: privateMessage, retryable: false }),
        status: 409
      });
    case "not_found":
      return Object.freeze({
        body: Object.freeze({ code: "session_not_found", message: privateMessage, retryable: false }),
        status: 404
      });
    case "incompatible":
      return Object.freeze({
        body: Object.freeze({ code: "incompatible_runtime", message: privateMessage, retryable: false }),
        status: 409
      });
    case "timeout":
      return Object.freeze({
        body: Object.freeze({ code: "operation_timeout", message: privateMessage, retryable: false }),
        status: 504
      });
    case "conflict":
      return Object.freeze({
        body: Object.freeze({ code: "operation_conflict", message: privateMessage, retryable: false }),
        status: 409
      });
    case "storage":
      return Object.freeze({
        body: Object.freeze({ code: "storage_error", message: privateMessage, retryable: false }),
        status: 500
      });
  }
}

async function fulfillJson(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: unknown,
  status = 200
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}
