import type { Page, Request } from "@playwright/test";
import {
  type SelectedProjectionEvent,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema
} from "../../packages/contracts/src/index.js";

export type SessionDetailApiVariant =
  | "active"
  | "boundary"
  | "long"
  | "empty"
  | "denied"
  | "unavailable";

export interface SessionDetailApiController {
  readonly requests: readonly Request[];
  readonly breakStream: () => Promise<void>;
  readonly dropStream: () => Promise<void>;
  readonly pushEvent: (event: SessionDetailEventFixture) => Promise<void>;
  readonly setVariant: (variant: SessionDetailApiVariant) => void;
  readonly streamRequestUrls: () => Promise<readonly string[]>;
}

type SessionDetailEventFixture = SelectedProjectionEvent;

const origin = "http://127.0.0.1:4175";
const sessionId = "sess_detail_browser_active";
const timestamp = "2026-07-22T18:00:00.000Z";
const components = [
  "storage",
  "runtime",
  "compatibility",
  "projector",
  "fanout",
  "listener",
  "lease"
] as const;

export const sessionDetailBrowserSessionId = sessionId;

export async function installSessionDetailApi(
  page: Page,
  initialVariant: SessionDetailApiVariant = "active"
): Promise<SessionDetailApiController> {
  let variant = initialVariant;
  const requests: Request[] = [];
  const initialEvents = eventsForVariant(initialVariant);

  await installSessionEventStream(page, initialEvents);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());

    if (variant === "unavailable") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          error: {
            code: "daemon_unavailable",
            message: "HostDeck is temporarily unavailable.",
            retryable: true
          }
        })
      });
      return;
    }

    if (url.pathname === "/api/v1/access" && request.method() === "GET") {
      await fulfillJson(route, variant === "denied" ? deniedAccess() : pairedWriterAccess());
      return;
    }
    if (variant === "denied") {
      await route.fulfill({ status: 500, body: "unexpected protected request" });
      return;
    }
    if (url.pathname === "/api/v1/host/status" && request.method() === "GET") {
      await fulfillJson(route, readyHostStatus());
      return;
    }
    if (
      url.pathname === `/api/v1/sessions/${sessionId}` &&
      request.method() === "GET"
    ) {
      await fulfillJson(route, sessionDetail(variant, eventsForVariant(variant).length));
      return;
    }
    if (url.pathname === "/api/v1/sessions" && request.method() === "GET") {
      await fulfillJson(route, sessionList(variant, eventsForVariant(variant).length));
      return;
    }
    if (url.pathname === "/api/v1/access/csrf" && request.method() === "POST") {
      await fulfillJson(route, {
        csrf_token: "D".repeat(43),
        csrf_generation: 1,
        rotated_at: timestamp
      });
      return;
    }

    await route.fulfill({ status: 404, body: "unexpected route" });
  });

  return Object.freeze({
    requests,
    async breakStream() {
      await page.evaluate(() => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionDetailSse?: { readonly breakStream: () => void };
          }
        ).__hostdeckSessionDetailSse;
        if (runtime === undefined) throw new TypeError("Session Detail SSE fixture is missing.");
        runtime.breakStream();
      });
    },
    async dropStream() {
      await page.evaluate(() => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionDetailSse?: { readonly dropStream: () => void };
          }
        ).__hostdeckSessionDetailSse;
        if (runtime === undefined) throw new TypeError("Session Detail SSE fixture is missing.");
        runtime.dropStream();
      });
    },
    setVariant(nextVariant: SessionDetailApiVariant) {
      variant = nextVariant;
    },
    async pushEvent(event: SessionDetailEventFixture) {
      await page.evaluate((nextEvent) => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionDetailSse?: {
              readonly push: (candidate: SessionDetailEventFixture) => void;
            };
          }
        ).__hostdeckSessionDetailSse;
        if (runtime === undefined) throw new TypeError("Session Detail SSE fixture is missing.");
        runtime.push(nextEvent);
      }, event);
    },
    async streamRequestUrls() {
      return page.evaluate(() => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionDetailSse?: {
              readonly requests: readonly string[];
            };
          }
        ).__hostdeckSessionDetailSse;
        if (runtime === undefined) throw new TypeError("Session Detail SSE fixture is missing.");
        return [...runtime.requests];
      });
    }
  });
}

export function sessionDetailRequestPaths(controller: SessionDetailApiController): string[] {
  return controller.requests.map((request) => new URL(request.url()).pathname);
}

export function liveActivityEvent(cursor: number): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "activity",
    activity: "tool",
    state: "completed",
    item_id: null,
    title: "Device validation completed",
    detail: "The connected Android viewport passed the current checks."
  });
}

async function installSessionEventStream(
  page: Page,
  initialEvents: readonly SessionDetailEventFixture[]
): Promise<void> {
  await page.addInitScript((seedEvents) => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const requests: string[] = [];
    let stallConnections = false;
    const frame = (event: SessionDetailEventFixture) =>
      `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const enqueue = (event: SessionDetailEventFixture) => {
      const bytes = encoder.encode(frame(event));
      for (const controller of [...controllers]) {
        try {
          controller.enqueue(bytes);
        } catch {
          controllers.delete(controller);
        }
      }
    };

    Object.defineProperty(window, "__hostdeckSessionDetailSse", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        requests,
        push: enqueue,
        breakStream() {
          const bytes = encoder.encode("data: malformed\n\n");
          for (const controller of [...controllers]) controller.enqueue(bytes);
        },
        dropStream() {
          stallConnections = true;
          for (const controller of [...controllers]) {
            try {
              controller.close();
            } catch {
              // The stream may already be closed by the browser reader.
            }
          }
          controllers.clear();
        }
      })
    });

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string"
          ? new URL(input, window.location.href)
          : input instanceof URL
            ? input
            : new URL(input.url, window.location.href);
      if (!requestUrl.pathname.endsWith("/events/stream")) {
        return originalFetch(input, init);
      }

      const seedConnection = requests.length === 0;
      requests.push(requestUrl.href);
      if (stallConnections) {
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (init?.signal?.aborted === true) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      let activeController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          activeController = controller;
          controllers.add(controller);
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          if (seedConnection) {
            for (const event of seedEvents) controller.enqueue(encoder.encode(frame(event)));
          }
        },
        cancel() {
          if (activeController !== null) controllers.delete(activeController);
        }
      });
      const abort = () => {
        if (activeController === null) return;
        controllers.delete(activeController);
        try {
          activeController.close();
        } catch {
          // The stream may already be closed by the browser reader.
        }
      };
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/event-stream"
          }
        })
      );
    };
  }, initialEvents);
}

async function fulfillJson(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: unknown
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function pairedWriterAccess() {
  return {
    authentication_state: "paired_device",
    device_id: "device_detail_phone",
    permission: "write",
    device_expires_at: "2026-10-22T18:00:00.000Z",
    configured_origin: origin,
    network_mode: "loopback",
    transport: "http",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
    can_unlock: false
  };
}

function deniedAccess() {
  return {
    authentication_state: "revoked_device",
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: origin,
    network_mode: "loopback",
    transport: "http",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  };
}

function readyHostStatus() {
  return {
    local: {
      generation: 1,
      state: "ready",
      readiness: "ready",
      updated_at: timestamp,
      components: components.map((component) => ({
        component,
        state: "ready",
        checked_at: timestamp,
        causes: []
      })),
      mutation_admission: "open"
    },
    remote: {
      generation: 0,
      state_generation: null,
      availability: "unknown",
      cause: "not_observed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null,
      checked_at: null,
      updated_at: timestamp
    },
    access: {
      mode: "paired_write",
      network_mode: "loopback",
      transport: "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: true,
        causes: []
      }
    }
  };
}

function sessionDetail(variant: SessionDetailApiVariant, eventCount: number) {
  const empty = variant === "empty";
  const long = variant === "long";
  const bounded = variant === "boundary";
  return selectedSessionDetailResponseSchema.parse({
    access: {
      mode: "paired_write",
      network_mode: "loopback",
      transport: "http"
    },
    session: {
      session: {
        id: sessionId,
        name: long ? "android-release-validation-long-session-name-2026" : "android-release",
        codex_thread_id: "thread-private-browser-detail",
        cwd: long
          ? `/workspace/${"deep-mobile-project-segment-".repeat(8)}release`
          : "/workspace/hostdeck-mobile",
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        created_at: timestamp,
        archived_at: null,
        session_state: "active",
        turn_state: "waiting_for_approval",
        attention: "needs_approval",
        freshness: "current",
        freshness_reason: null,
        updated_at: timestamp,
        last_activity_at: timestamp,
        branch: long
          ? `feature/${"responsive-session-detail-".repeat(7)}android`
          : "feat/mobile-session-detail",
        model: "gpt-5.5-codex",
        settings: null,
        goal: null,
        recent_summary: "Validate the structured mobile session feed.",
        last_event_cursor: empty ? null : eventCount
      },
      event_window: empty
        ? {
            state: "empty",
            retained_event_count: 0,
            earliest_retained_cursor: null,
            boundary_cursor: null
          }
        : {
            state: bounded ? "bounded" : "contiguous",
            retained_event_count: eventCount,
            earliest_retained_cursor: 1,
            boundary_cursor: bounded ? 0 : null
          }
    }
  });
}

function sessionList(variant: SessionDetailApiVariant, eventCount: number) {
  const detail = sessionDetail(variant, eventCount);
  return {
    access: detail.access,
    sessions: [detail.session],
    next_cursor: null,
    has_more: false
  };
}

function eventsForVariant(variant: SessionDetailApiVariant): readonly SessionDetailEventFixture[] {
  if (variant === "empty" || variant === "denied" || variant === "unavailable") return [];
  if (variant === "boundary") {
    return [
      boundaryEvent(1),
      messageEvent(2, "user", "completed", "Continue from retained history.", "item-boundary-user"),
      approvalEvent(3),
      runtimeEvent(4)
    ];
  }
  if (variant === "long") {
    return [
      messageEvent(
        1,
        "user",
        "completed",
        `Review ${"the complete mobile release boundary without clipping any content. ".repeat(9)}`,
        "item-long-user"
      ),
      activityEvent(
        2,
        "command",
        "completed",
        "Run the complete release-readiness validation command",
        `${"Validated responsive behavior, accessibility, package integrity, and privacy boundaries. ".repeat(8)}`
      ),
      approvalEvent(3),
      messageEvent(
        4,
        "agent",
        "completed",
        `${"The bounded mobile validation remains readable at narrow widths. ".repeat(10)}`,
        "item-long-agent"
      )
    ];
  }
  return [
    messageEvent(1, "user", "completed", "Review the mobile session boundary.", "item-user-1"),
    messageEvent(2, "agent", "delta", "I reviewed ", "item-agent-1"),
    messageEvent(3, "agent", "delta", "the structured session contracts.", "item-agent-1"),
    activityEvent(4, "tool", "completed", "Read selected contracts", "Reviewed the bounded event and access schemas."),
    activityEvent(5, "command", "completed", "Run focused tests", "The Session Detail unit suite passed."),
    approvalEvent(6),
    controlEvent(7),
    messageEvent(
      8,
      "agent",
      "completed",
      "The structured mobile session feed is ready for device validation.",
      "item-agent-1"
    ),
    runtimeEvent(9)
  ];
}

function eventBase(cursor: number) {
  return {
    session_id: sessionId,
    cursor,
    captured_at: `2026-07-22T18:${String(cursor).padStart(2, "0")}:00.000Z`,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null
  };
}

function messageEvent(
  cursor: number,
  role: "user" | "agent",
  phase: "delta" | "completed",
  text: string,
  itemId: string
): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "message",
    role,
    phase,
    item_id: itemId,
    text
  });
}

function activityEvent(
  cursor: number,
  activity: "command" | "tool",
  state: "completed",
  title: string,
  detail: string
): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "activity",
    activity,
    state,
    item_id: null,
    title,
    detail
  });
}

function approvalEvent(cursor: number): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "approval",
    request_id: "request-private-browser-detail",
    state: "pending",
    action: "Install the Android validation package",
    scope: "Connected test phone",
    reason: "Continue the bounded release validation on the selected device.",
    risk: "elevated",
    expires_at: "2026-07-22T19:00:00.000Z",
    decision: null
  });
}

function controlEvent(cursor: number): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "control",
    control: "model",
    state: "active",
    value_summary: "gpt-5.5-codex"
  });
}

function runtimeEvent(cursor: number): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "runtime",
    state: "ready",
    message: null
  });
}

function boundaryEvent(cursor: number): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "replay_boundary",
    after: 0,
    next_cursor: cursor,
    reason: "retention"
  });
}
