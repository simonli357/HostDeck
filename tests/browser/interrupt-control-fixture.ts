import type { Page, Request } from "@playwright/test";
import {
  type InterruptRequest,
  interruptRequestSchema,
  interruptResponseSchema
} from "../../packages/contracts/src/index.js";
import {
  sessionDetailBrowserCodexThreadId,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type InterruptApiOutcome =
  | "success"
  | "blocked"
  | "unknown"
  | "malformed"
  | "mismatch"
  | "pending";

export interface InterruptApiController {
  readonly hasPendingRequest: () => boolean;
  readonly release: (outcome?: Exclude<InterruptApiOutcome, "pending">) => void;
  readonly requests: () => readonly Request[];
  readonly setOutcome: (outcome: InterruptApiOutcome) => void;
}

export const interruptBrowserTurnId = "turn-browser-interrupt-001";

const timestamp = "2026-07-27T20:00:00.000Z";
const threadId = sessionDetailBrowserCodexThreadId;

export async function installInterruptApi(
  page: Page,
  turnId = interruptBrowserTurnId
): Promise<InterruptApiController> {
  let outcome: InterruptApiOutcome = "success";
  let pendingResolution: ((result: Exclude<InterruptApiOutcome, "pending">) => void) | null = null;
  const captured: Request[] = [];
  const path = `/api/v1/sessions/${sessionDetailBrowserSessionId}/turns/${turnId}/interrupt`;

  await page.route(`**${path}`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== path || request.method() !== "POST") {
      await route.fallback();
      return;
    }
    captured.push(request);
    let requestBody: InterruptRequest;
    try {
      requestBody = interruptRequestSchema.parse(request.postDataJSON());
    } catch {
      await fulfillJson(route, {
        error: {
          code: "validation_error",
          message: "Interrupt request fixture validation failed.",
          retryable: false
        }
      }, 400);
      return;
    }

    let selectedOutcome = outcome;
    if (selectedOutcome === "pending") {
      if (pendingResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending interrupt request" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<InterruptApiOutcome, "pending">>((resolve) => {
        pendingResolution = resolve;
      });
      pendingResolution = null;
    }
    await fulfillOutcome(route, requestBody, selectedOutcome, turnId);
  });

  return Object.freeze({
    hasPendingRequest: () => pendingResolution !== null,
    release(selectedOutcome: Exclude<InterruptApiOutcome, "pending"> = "success") {
      if (pendingResolution === null) {
        throw new TypeError("No pending interrupt request exists.");
      }
      pendingResolution(selectedOutcome);
    },
    requests: () => Object.freeze([...captured]),
    setOutcome(selectedOutcome: InterruptApiOutcome) {
      if (pendingResolution !== null) {
        throw new TypeError("An interrupt request is already pending.");
      }
      outcome = selectedOutcome;
    }
  });
}

async function fulfillOutcome(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  request: InterruptRequest,
  outcome: Exclude<InterruptApiOutcome, "pending">,
  turnId: string
): Promise<void> {
  if (outcome === "blocked") {
    await fulfillJson(route, {
      error: {
        code: "host_locked",
        message: "PRIVATE fixture path /workspace/interrupt must never render.",
        retryable: false
      }
    }, 423);
    return;
  }
  if (outcome === "unknown") {
    await fulfillJson(route, {
      error: {
        code: "operation_timeout",
        message: "PRIVATE timeout origin and runtime detail must never render.",
        retryable: true
      }
    }, 504);
    return;
  }
  const operationId = outcome === "mismatch"
    ? "op_browser_interrupt_11111111111141118111111111111111"
    : request.operation_id;
  const response = {
    operation_id: operationId,
    kind: "interrupt",
    target: {
      type: "turn",
      session_id: sessionDetailBrowserSessionId,
      codex_thread_id: threadId,
      turn_id: turnId
    },
    state: "interrupted",
    updated_at: timestamp,
    turn_id: turnId,
    error: null
  };
  if (outcome === "malformed") {
    await fulfillJson(route, { ...response, private_extra: true });
    return;
  }
  await fulfillJson(route, interruptResponseSchema.parse(response));
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
