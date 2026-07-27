import type { Page, Request, Route } from "@playwright/test";
import {
  type SelectedProjectionEvent,
  selectedEventPageResponseSchema,
  selectedProjectionEventSchema
} from "../../packages/contracts/src/index.js";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  type SessionDetailApiVariant,
  type SessionDetailEventFixture,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type EventDiagnosticsReadOutcome =
  | "success"
  | "pending"
  | "overloaded"
  | "permission"
  | "pruned"
  | "empty"
  | "malformed"
  | "mismatch"
  | "transport";

export interface EventDiagnosticsApiController {
  readonly detail: SessionDetailApiController;
  readonly events: readonly SelectedProjectionEvent[];
  readonly hasPendingRead: () => boolean;
  readonly requests: () => readonly Request[];
  readonly releaseRead: (
    outcome?: Exclude<EventDiagnosticsReadOutcome, "pending">
  ) => void;
  readonly setReadOutcome: (outcome: EventDiagnosticsReadOutcome) => void;
}

export interface EventDiagnosticsApiInput {
  readonly events?: readonly SessionDetailEventFixture[];
  readonly retentionBoundaryCursor?: number;
  readonly sessionVariant?: SessionDetailApiVariant;
  readonly streamEvents?: readonly SessionDetailEventFixture[];
}

export interface EventDiagnosticsEventOptions {
  readonly action?: string;
  readonly boundaryAfter?: number | null;
  readonly contentState?: SelectedProjectionEvent["content_state"];
  readonly itemId?: string | null;
  readonly notice?: string;
  readonly phase?: "delta" | "completed";
  readonly requestId?: string;
  readonly role?: "user" | "agent";
  readonly text?: string;
}

const eventPath = `/api/v1/sessions/${sessionDetailBrowserSessionId}/events`;
const timestamp = "2026-07-27T20:00:00.000Z";

export async function installEventDiagnosticsApi(
  page: Page,
  input: EventDiagnosticsApiInput = {}
): Promise<EventDiagnosticsApiController> {
  const events = Object.freeze(
    (input.events ?? eventDiagnosticsMatrixEvents()).map((event) =>
      selectedProjectionEventSchema.parse(event)
    )
  );
  const detail = await installSessionDetailApi(
    page,
    input.sessionVariant ?? "active",
    {
      initialEvents: events,
      ...(input.retentionBoundaryCursor === undefined
        ? {}
        : { retentionBoundaryCursor: input.retentionBoundaryCursor }),
      ...(input.streamEvents === undefined ? {} : { streamEvents: input.streamEvents })
    }
  );
  let outcome: EventDiagnosticsReadOutcome = "success";
  let pendingResolution:
    | ((next: Exclude<EventDiagnosticsReadOutcome, "pending">) => void)
    | null = null;
  const reads: Request[] = [];

  await page.route((url) => url.pathname === eventPath, async (route) => {
    const request = route.request();
    reads.push(request);
    if (request.method() !== "GET") {
      await route.fulfill({ status: 405, body: "unexpected event diagnostics method" });
      return;
    }
    const selectedEvent = selectedEventForRequest(request, events);
    if (selectedEvent === null) {
      await route.fulfill({ status: 400, body: "unexpected event diagnostics cursor" });
      return;
    }
    let selectedOutcome = outcome;
    if (selectedOutcome === "pending") {
      if (pendingResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending event read" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<EventDiagnosticsReadOutcome, "pending">>(
        (resolve) => {
          pendingResolution = resolve;
        }
      );
      pendingResolution = null;
    }
    await fulfillOutcome(route, selectedOutcome, selectedEvent);
  });

  return Object.freeze({
    detail,
    events,
    hasPendingRead: () => pendingResolution !== null,
    requests: () => reads,
    releaseRead(next: Exclude<EventDiagnosticsReadOutcome, "pending"> = "success") {
      if (pendingResolution === null) {
        throw new TypeError("No pending event diagnostics read exists.");
      }
      outcome = next;
      pendingResolution(next);
    },
    setReadOutcome(next: EventDiagnosticsReadOutcome) {
      if (pendingResolution !== null) {
        throw new TypeError("Cannot replace a pending event diagnostics read.");
      }
      outcome = next;
    }
  });
}

export function eventDiagnosticsMatrixEvents(): readonly SelectedProjectionEvent[] {
  return Object.freeze([
    eventDiagnosticsEvent("replay_boundary", 1, {
      boundaryAfter: 0,
      contentState: "truncated",
      notice: "Earlier retained projections are outside this bounded window."
    }),
    eventDiagnosticsEvent("message", 2),
    eventDiagnosticsEvent("turn", 3, {
      contentState: "redacted",
      notice: "Sensitive turn detail was redacted at projection time."
    }),
    eventDiagnosticsEvent("activity", 4, {
      contentState: "truncated",
      notice: "Activity detail reached the bounded projection limit."
    }),
    eventDiagnosticsEvent("approval", 5, {
      contentState: "redacted_and_truncated",
      notice: "Sensitive approval detail was redacted and bounded."
    }),
    eventDiagnosticsEvent("control", 6),
    eventDiagnosticsEvent("runtime", 7),
    eventDiagnosticsEvent("unknown_optional", 8)
  ]);
}

export function eventDiagnosticsEvent(
  type: SelectedProjectionEvent["type"],
  cursor: number,
  options: EventDiagnosticsEventOptions = {}
): SelectedProjectionEvent {
  const contentState = options.contentState ?? "complete";
  const base = {
    session_id: sessionDetailBrowserSessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: cursor % 2 === 0 ? "2026-07-27T19:59:58.000Z" : null,
    codex_event_id: cursor % 3 === 0 ? null : `codex-browser-event-${cursor}`,
    codex_event_type: cursor % 3 === 0 ? null : `browser/${type}`,
    content_state: contentState,
    content_notice: contentState === "complete"
      ? null
      : options.notice ?? "This normalized projection is limited."
  };
  switch (type) {
    case "message":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        role: options.role ?? "agent",
        phase: options.phase ?? "completed",
        item_id: options.itemId === undefined ? `item-browser-${cursor}` : options.itemId,
        text: options.text ?? "Exact bounded message projection."
      });
    case "turn":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        turn_id: `turn-browser-${cursor}`,
        state: "failed",
        error: {
          code: "runtime_unavailable",
          message: "The selected runtime stopped before completion."
        }
      });
    case "activity":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        activity: "tool",
        state: "completed",
        item_id: null,
        title: "Inspect exact event projection",
        detail: "Bounded activity detail.\nUnicode remains visible: data-\u6570\u636e."
      });
    case "approval":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        request_id: options.requestId ?? `request-browser-${cursor}`,
        state: "pending",
        action: options.action ?? "Run exact mobile validation",
        scope: "Connected validation phone",
        reason: null,
        risk: "elevated",
        expires_at: "2026-07-27T23:00:00.000Z",
        decision: null
      });
    case "control":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        control: "plan",
        state: "active",
        value_summary: ""
      });
    case "runtime":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        state: "degraded",
        message: "Structured runtime diagnostics remain available."
      });
    case "replay_boundary":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        after: options.boundaryAfter === undefined ? cursor - 1 : options.boundaryAfter,
        next_cursor: cursor,
        reason: "retention"
      });
    case "unknown_optional":
      return selectedProjectionEventSchema.parse({
        ...base,
        type,
        upstream_type: "future/bounded-event",
        summary: "A future optional event was retained as one bounded summary."
      });
  }
}

async function fulfillOutcome(
  route: Route,
  outcome: Exclude<EventDiagnosticsReadOutcome, "pending">,
  event: SelectedProjectionEvent
): Promise<void> {
  if (outcome === "transport") {
    await route.abort("connectionrefused");
    return;
  }
  if (outcome === "overloaded") {
    await fulfillApiError(route, 503, "service_overloaded", true);
    return;
  }
  if (outcome === "permission") {
    await fulfillApiError(route, 403, "permission_denied", false);
    return;
  }
  if (outcome === "pruned") {
    await fulfillApiError(route, 409, "stale_session", false);
    return;
  }
  if (outcome === "empty") {
    await fulfillJson(route, {
      session_id: sessionDetailBrowserSessionId,
      events: [],
      next_cursor: event.cursor,
      truncated: false
    });
    return;
  }
  if (outcome === "malformed") {
    await fulfillJson(route, {
      ...eventPage(event),
      private_storage_path: "/home/private/event-store.sqlite"
    });
    return;
  }
  if (outcome === "mismatch") {
    const replacement = selectedProjectionEventSchema.parse({
      ...event,
      codex_event_id: "codex-browser-mismatched-event"
    });
    await fulfillJson(route, eventPage(replacement));
    return;
  }
  await fulfillJson(route, eventPage(event));
}

function selectedEventForRequest(
  request: Request,
  events: readonly SelectedProjectionEvent[]
): SelectedProjectionEvent | null {
  const url = new URL(request.url());
  const afterText = url.searchParams.get("after");
  if (afterText === null) {
    return events.find(
      (event) => event.type === "replay_boundary" && event.after === null
    ) ?? null;
  }
  const after = Number(afterText);
  return events.find((event) => event.cursor === after + 1) ?? null;
}

function eventPage(event: SelectedProjectionEvent) {
  return selectedEventPageResponseSchema.parse({
    session_id: sessionDetailBrowserSessionId,
    events: [event],
    next_cursor: event.cursor,
    truncated: event.type === "replay_boundary"
  });
}

async function fulfillApiError(
  route: Route,
  status: number,
  code: "service_overloaded" | "permission_denied" | "stale_session",
  retryable: boolean
): Promise<void> {
  await fulfillJson(
    route,
    {
      error: {
        code,
        message: "Private event fixture detail from /home/private must not render.",
        retryable
      }
    },
    status
  );
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}
