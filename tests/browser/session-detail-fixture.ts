import type { Page, Request } from "@playwright/test";
import {
  type PromptDispatchResponse,
  type PromptSessionRequest,
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
  type SelectedProjectionEvent,
  selectedHostStatusResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema
} from "../../packages/contracts/src/index.js";

export type SessionDetailApiVariant =
  | "active"
  | "writable"
  | "writable_long"
  | "read_only"
  | "locked"
  | "csrf_failed"
  | "waiting_input"
  | "turn_unknown"
  | "stale_session"
  | "boundary"
  | "long"
  | "empty"
  | "expired"
  | "denied"
  | "unavailable";

export type SessionDetailPromptOutcome =
  | "accepted_start"
  | "accepted_steer"
  | "retryable_rejection"
  | "nonretryable_rejection"
  | "correlation_mismatch"
  | "stale_generation"
  | "pending";

export type SessionDetailCsrfOutcome = "success" | "failure" | "pending";
export type SessionDetailAccessOutcome = "success" | "failure";

export interface SessionDetailApiController {
  readonly requests: readonly Request[];
  readonly breakStream: () => Promise<void>;
  readonly dropStream: () => Promise<void>;
  readonly hasPendingPrompt: () => boolean;
  readonly hasPendingAccess: () => boolean;
  readonly hasPendingCsrf: () => boolean;
  readonly pushEvent: (event: SessionDetailEventFixture) => Promise<void>;
  readonly promptRequests: () => readonly Request[];
  readonly releasePendingPrompt: (
    outcome?: Exclude<SessionDetailPromptOutcome, "pending">
  ) => void;
  readonly releasePendingAccess: (outcome?: SessionDetailAccessOutcome) => void;
  readonly releasePendingCsrf: (
    outcome?: Exclude<SessionDetailCsrfOutcome, "pending">
  ) => void;
  readonly resumeStream: () => Promise<void>;
  readonly holdNextAccess: () => void;
  readonly setCsrfOutcome: (outcome: SessionDetailCsrfOutcome | null) => void;
  readonly setPromptOutcome: (outcome: SessionDetailPromptOutcome) => void;
  readonly setSessionListEmpty: (empty: boolean) => void;
  readonly setTurnState: (state: SessionDetailTurnState | undefined) => void;
  readonly setVariant: (variant: SessionDetailApiVariant) => void;
  readonly streamRequestUrls: () => Promise<readonly string[]>;
}

export type SessionDetailEventFixture = SelectedProjectionEvent;
export type SessionDetailTurnState =
  | "idle"
  | "in_progress"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "completed"
  | "interrupted"
  | "failed"
  | "unknown";

export interface SessionDetailApiOptions {
  readonly configuredOrigin?: string;
  readonly initialEvents?: readonly SessionDetailEventFixture[];
  readonly retentionBoundaryCursor?: number;
  readonly streamEvents?: readonly SessionDetailEventFixture[];
  readonly turnState?: SessionDetailTurnState;
}

const origin = "http://127.0.0.1:4175";
const sessionId = "sess_detail_browser_active";
const timestamp = "2026-07-22T18:00:00.000Z";
const promptTurnId = "turn-private-browser-prompt";
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
  initialVariant: SessionDetailApiVariant = "active",
  options: SessionDetailApiOptions = {}
): Promise<SessionDetailApiController> {
  let variant = initialVariant;
  let promptOutcome: SessionDetailPromptOutcome = "accepted_start";
  let pendingPromptResolution:
    | ((outcome: Exclude<SessionDetailPromptOutcome, "pending">) => void)
    | null = null;
  let holdAccess = false;
  let pendingAccessResolution: ((outcome: SessionDetailAccessOutcome) => void) | null = null;
  let csrfOutcomeOverride: SessionDetailCsrfOutcome | null = null;
  let sessionListEmpty = false;
  let turnStateOverride = options.turnState;
  let pendingCsrfResolution:
    | ((outcome: Exclude<SessionDetailCsrfOutcome, "pending">) => void)
    | null = null;
  const requests: Request[] = [];
  const configuredOrigin = options.configuredOrigin ?? origin;
  const initialEvents = options.initialEvents === undefined
    ? eventsForVariant(initialVariant)
    : Object.freeze(
        options.initialEvents.map((event) => selectedProjectionEventSchema.parse(event))
      );
  const streamEvents = options.streamEvents === undefined
    ? initialEvents
    : Object.freeze(
        options.streamEvents.map((event) => selectedProjectionEventSchema.parse(event))
      );
  const selectedEvents = () =>
    options.initialEvents !== undefined &&
      variant !== "empty" &&
      variant !== "expired" &&
      variant !== "denied" &&
      variant !== "unavailable"
      ? initialEvents
      : eventsForVariant(variant);
  const selectedRetentionBoundary = () =>
    options.initialEvents !== undefined && selectedEvents() === initialEvents
      ? options.retentionBoundaryCursor
      : undefined;

  await installSessionEventStream(page, streamEvents);
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
      let accessOutcome: SessionDetailAccessOutcome = "success";
      if (holdAccess) {
        holdAccess = false;
        accessOutcome = await new Promise<SessionDetailAccessOutcome>((resolve) => {
          pendingAccessResolution = resolve;
        });
        pendingAccessResolution = null;
      }
      if (accessOutcome === "failure") {
        await fulfillJson(route, serviceUnavailable(), 503);
        return;
      }
      await fulfillJson(
        route,
        variant === "denied"
          ? deniedAccess("revoked_device", configuredOrigin)
          : variant === "expired"
            ? deniedAccess("expired_device", configuredOrigin)
            : pairedAccess(variant, configuredOrigin)
      );
      return;
    }
    if (variant === "denied" || variant === "expired") {
      await route.fulfill({ status: 500, body: "unexpected protected request" });
      return;
    }
    if (url.pathname === "/api/v1/access/devices" && request.method() === "GET") {
      await fulfillJson(route, {
        devices: [],
        next_cursor: null,
        has_more: false
      });
      return;
    }
    if (url.pathname === "/api/v1/host/status" && request.method() === "GET") {
      await fulfillJson(route, readyHostStatus(variant));
      return;
    }
    if (
      url.pathname === `/api/v1/sessions/${sessionId}` &&
      request.method() === "GET"
    ) {
      await fulfillJson(
        route,
        sessionDetail(
          variant,
          selectedEvents(),
          selectedRetentionBoundary(),
          turnStateOverride
        )
      );
      return;
    }
    if (
      url.pathname === `/api/v1/sessions/${sessionId}/approvals` &&
      request.method() === "GET"
    ) {
      await fulfillJson(route, emptyApprovalList());
      return;
    }
    if (url.pathname === "/api/v1/sessions" && request.method() === "GET") {
      if (sessionListEmpty) {
        const detail = sessionDetail(
          variant,
          selectedEvents(),
          selectedRetentionBoundary(),
          turnStateOverride
        );
        await fulfillJson(route, {
          access: detail.access,
          sessions: [],
          next_cursor: null,
          has_more: false
        });
        return;
      }
      await fulfillJson(
        route,
        sessionList(
          variant,
          selectedEvents(),
          selectedRetentionBoundary(),
          turnStateOverride
        )
      );
      return;
    }
    if (url.pathname === "/api/v1/access/csrf" && request.method() === "POST") {
      let csrfOutcome = csrfOutcomeOverride ?? (variant === "csrf_failed" ? "failure" : "success");
      if (csrfOutcome === "pending") {
        if (pendingCsrfResolution !== null) {
          await route.fulfill({ status: 500, body: "duplicate pending CSRF request" });
          return;
        }
        csrfOutcome = await new Promise<Exclude<SessionDetailCsrfOutcome, "pending">>(
          (resolve) => {
            pendingCsrfResolution = resolve;
          }
        );
        pendingCsrfResolution = null;
      }
      if (csrfOutcome === "failure") {
        await fulfillJson(
          route,
          {
            error: {
              code: "service_overloaded",
              message: "Secure write setup is temporarily unavailable.",
              retryable: true
            }
          },
          503
        );
        return;
      }
      await fulfillJson(route, {
        csrf_token: "D".repeat(43),
        csrf_generation: 1,
        rotated_at: timestamp
      });
      return;
    }
    if (
      url.pathname === `/api/v1/sessions/${sessionId}/prompts` &&
      request.method() === "POST"
    ) {
      let selectedOutcome = promptOutcome;
      if (selectedOutcome === "pending") {
        if (pendingPromptResolution !== null) {
          await route.fulfill({ status: 500, body: "duplicate pending prompt request" });
          return;
        }
        selectedOutcome = await new Promise<Exclude<SessionDetailPromptOutcome, "pending">>(
          (resolve) => {
            pendingPromptResolution = resolve;
          }
        );
        pendingPromptResolution = null;
      }
      await fulfillPromptOutcome(route, request, selectedOutcome);
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
    hasPendingPrompt() {
      return pendingPromptResolution !== null;
    },
    hasPendingAccess() {
      return pendingAccessResolution !== null;
    },
    hasPendingCsrf() {
      return pendingCsrfResolution !== null;
    },
    promptRequests() {
      return requests.filter((request) => {
        const url = new URL(request.url());
        return (
          request.method() === "POST" &&
          url.pathname === `/api/v1/sessions/${sessionId}/prompts`
        );
      });
    },
    releasePendingPrompt(
      outcome: Exclude<SessionDetailPromptOutcome, "pending"> = "accepted_start"
    ) {
      if (pendingPromptResolution === null) {
        throw new TypeError("No pending Session Detail prompt request exists.");
      }
      pendingPromptResolution(outcome);
    },
    releasePendingAccess(outcome: SessionDetailAccessOutcome = "success") {
      if (pendingAccessResolution === null) {
        throw new TypeError("No pending Session Detail access request exists.");
      }
      pendingAccessResolution(outcome);
    },
    releasePendingCsrf(
      outcome: Exclude<SessionDetailCsrfOutcome, "pending"> = "success"
    ) {
      if (pendingCsrfResolution === null) {
        throw new TypeError("No pending Session Detail CSRF request exists.");
      }
      pendingCsrfResolution(outcome);
    },
    async resumeStream() {
      await page.evaluate(() => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionDetailSse?: { readonly resumeStream: () => void };
          }
        ).__hostdeckSessionDetailSse;
        if (runtime === undefined) throw new TypeError("Session Detail SSE fixture is missing.");
        runtime.resumeStream();
      });
    },
    holdNextAccess() {
      if (holdAccess || pendingAccessResolution !== null) {
        throw new TypeError("A Session Detail access request is already held.");
      }
      holdAccess = true;
    },
    setCsrfOutcome(outcome: SessionDetailCsrfOutcome | null) {
      if (pendingCsrfResolution !== null) {
        throw new TypeError("A Session Detail CSRF request is already pending.");
      }
      csrfOutcomeOverride = outcome;
    },
    setPromptOutcome(nextOutcome: SessionDetailPromptOutcome) {
      promptOutcome = nextOutcome;
    },
    setSessionListEmpty(empty: boolean) {
      sessionListEmpty = empty;
    },
    setTurnState(state: SessionDetailTurnState | undefined) {
      turnStateOverride = state;
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

export function promptTurnEvent(
  cursor: number,
  state:
    | "idle"
    | "in_progress"
    | "waiting_for_input"
    | "waiting_for_approval"
    | "completed"
    | "interrupted"
    | "failed"
    | "unknown",
  turnId = promptTurnId
): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    codex_event_id: `codex-private-browser-prompt-${cursor}`,
    codex_event_type: "thread/turn/state",
    type: "turn",
    turn_id: turnId,
    state,
    error:
      state === "failed"
        ? { code: "runtime_unavailable", message: "Runtime work stopped safely." }
        : null
  });
}

export function replayBoundaryEvent(
  cursor: number,
  after: number | null,
  reason: "retention" | "disconnect" | "restart" | "schema_change" = "disconnect"
): SessionDetailEventFixture {
  return selectedProjectionEventSchema.parse({
    ...eventBase(cursor),
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason
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
        },
        resumeStream() {
          stallConnections = false;
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

      const afterParameter = requestUrl.searchParams.get("after");
      const after = afterParameter === null ? null : Number(afterParameter);
      if (after !== null && (!Number.isSafeInteger(after) || after < 0)) {
        throw new TypeError("Session detail fixture received an invalid event cursor.");
      }
      const replayEvents = seedEvents.filter(
        (event) => after === null || event.cursor > after
      );
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
          for (const event of replayEvents) {
            controller.enqueue(encoder.encode(frame(event)));
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

async function fulfillPromptOutcome(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  request: Request,
  outcome: Exclude<SessionDetailPromptOutcome, "pending">
): Promise<void> {
  let body: PromptSessionRequest;
  try {
    body = promptSessionRequestSchema.parse(request.postDataJSON());
  } catch {
    await fulfillJson(
      route,
      {
        error: {
          code: "validation_error",
          message: "The prompt request is invalid.",
          retryable: false
        }
      },
      400
    );
    return;
  }

  if (outcome === "retryable_rejection") {
    await fulfillJson(
      route,
      {
        error: {
          code: "service_overloaded",
          message: "HostDeck is temporarily too busy.",
          retryable: true
        }
      },
      503
    );
    return;
  }
  if (outcome === "nonretryable_rejection") {
    await fulfillJson(
      route,
      {
        error: {
          code: "session_not_writable",
          message: "This session cannot accept a prompt now.",
          retryable: false
        }
      },
      409
    );
    return;
  }
  if (outcome === "stale_generation") {
    await fulfillJson(
      route,
      {
        error: {
          code: "operation_conflict",
          message: "Page authority changed before the operation completed.",
          retryable: false
        }
      },
      409
    );
    return;
  }

  const operationId =
    outcome === "correlation_mismatch"
      ? "op_browser_prompt_11111111111141118111111111111111"
      : body.operation_id;
  const response: PromptDispatchResponse = promptDispatchResponseSchema.parse({
    operation_id: operationId,
    kind: "prompt",
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: "thread-private-browser-prompt"
    },
    state: "accepted",
    accepted_at: timestamp,
    audit_record_id: "audit-private-browser-prompt",
    turn_id: promptTurnId,
    action: outcome === "accepted_steer" ? "steer" : "start"
  });
  await fulfillJson(route, response, 202);
}

function pairedAccess(
  variant: SessionDetailApiVariant,
  configuredOrigin: string
) {
  const readOnly = variant === "read_only";
  const locked = variant === "locked";
  return {
    authentication_state: "paired_device",
    device_id: "device_detail_phone",
    permission: readOnly ? "read" : "write",
    device_expires_at: "2026-10-22T18:00:00.000Z",
    configured_origin: configuredOrigin,
    network_mode: "loopback",
    transport: "http",
    locked,
    can_read_sessions: true,
    can_write_sessions: !readOnly && !locked,
    can_lock: !readOnly,
    can_unlock: false
  };
}

function deniedAccess(
  authenticationState: "expired_device" | "revoked_device",
  configuredOrigin: string
) {
  return {
    authentication_state: authenticationState,
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: configuredOrigin,
    network_mode: "loopback",
    transport: "http",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  };
}

function serviceUnavailable() {
  return {
    error: {
      code: "daemon_unavailable",
      message: "HostDeck is temporarily unavailable.",
      retryable: true
    }
  };
}

function readyHostStatus(variant: SessionDetailApiVariant) {
  const readOnly = variant === "read_only";
  const writeCauses = readOnly ? ["read_only_access"] : [];
  return selectedHostStatusResponseSchema.parse({
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
    compatibility: {
      state: "supported",
      evidence: "current",
      observed_version: "0.144.0",
      supported_version: "0.144.0",
      capability_state: "verified",
      checked_at: timestamp,
      recorded_at: timestamp
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
      mode: readOnly ? "paired_read" : "paired_write",
      network_mode: "loopback",
      transport: "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: writeCauses.length === 0,
        causes: writeCauses
      }
    }
  });
}

function sessionDetail(
  variant: SessionDetailApiVariant,
  events: readonly SessionDetailEventFixture[],
  retentionBoundaryCursor?: number,
  turnStateOverride?: SessionDetailTurnState
) {
  const firstEvent = events[0] ?? null;
  const lastEvent = events.at(-1) ?? null;
  const eventCount = events.length;
  const empty = eventCount === 0;
  const readOnly = variant === "read_only";
  const writable = isComposerFixtureVariant(variant);
  const long = variant === "long" || variant === "writable_long";
  const derivedBoundaryCursor = firstEvent?.type === "replay_boundary"
    ? firstEvent.after
    : null;
  const boundaryCursor = retentionBoundaryCursor ?? derivedBoundaryCursor;
  const bounded = boundaryCursor !== null;
  const turnState = turnStateOverride ?? (
    variant === "waiting_input"
      ? "waiting_for_input"
      : variant === "turn_unknown"
        ? "unknown"
        : writable
          ? "idle"
          : "waiting_for_approval"
  );
  const attention =
    turnState === "waiting_for_input"
      ? "needs_input"
      : turnState === "waiting_for_approval"
        ? "needs_approval"
        : turnState === "unknown"
          ? "unknown"
          : variant === "stale_session"
            ? "watch"
            : "none";
  const freshness = variant === "stale_session" ? "stale" : "current";
  return selectedSessionDetailResponseSchema.parse({
    access: {
      mode: readOnly ? "paired_read" : "paired_write",
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
        turn_state: turnState,
        attention,
        freshness,
        freshness_reason: freshness === "current" ? null : "Projection requires refresh.",
        updated_at: timestamp,
        last_activity_at: timestamp,
        branch: long
          ? `feature/${"responsive-session-detail-".repeat(7)}android`
          : "feat/mobile-session-detail",
        model: "gpt-5.5-codex",
        settings: null,
        goal: null,
        recent_summary: "Validate the structured mobile session feed.",
        last_event_cursor: lastEvent?.cursor ?? null
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
            earliest_retained_cursor: firstEvent?.cursor ?? null,
            boundary_cursor: boundaryCursor
          }
    }
  });
}

function sessionList(
  variant: SessionDetailApiVariant,
  events: readonly SessionDetailEventFixture[],
  retentionBoundaryCursor?: number,
  turnStateOverride?: SessionDetailTurnState
) {
  const detail = sessionDetail(variant, events, retentionBoundaryCursor, turnStateOverride);
  return {
    access: detail.access,
    sessions: [detail.session],
    next_cursor: null,
    has_more: false
  };
}

function emptyApprovalList() {
  return {
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: "thread-private-browser-detail"
    },
    approvals: []
  };
}

function eventsForVariant(variant: SessionDetailApiVariant): readonly SessionDetailEventFixture[] {
  if (
    variant === "empty" ||
    variant === "expired" ||
    variant === "denied" ||
    variant === "unavailable"
  ) {
    return [];
  }
  if (isComposerFixtureVariant(variant)) {
    return [
      messageEvent(
        1,
        "user",
        "completed",
        "Prepare the selected mobile prompt workflow.",
        "item-prompt-user"
      ),
      messageEvent(
        2,
        "agent",
        "completed",
        "The selected session is ready for one bounded prompt.",
        "item-prompt-agent"
      ),
      runtimeEvent(3)
    ];
  }
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

function isComposerFixtureVariant(variant: SessionDetailApiVariant): boolean {
  return (
    variant === "writable" ||
    variant === "writable_long" ||
    variant === "read_only" ||
    variant === "locked" ||
    variant === "csrf_failed" ||
    variant === "waiting_input" ||
    variant === "turn_unknown" ||
    variant === "stale_session"
  );
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
    expires_at: "2026-07-22T23:00:00.000Z",
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
  return replayBoundaryEvent(cursor, 0, "retention");
}
