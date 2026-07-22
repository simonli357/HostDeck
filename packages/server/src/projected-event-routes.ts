import { Buffer } from "node:buffer";
import {
  type SelectedEventPageInput,
  type SelectedEventPageParams,
  type SelectedEventPageResponse,
  selectedEventPageParamsSchema,
  selectedEventPageQuerySchema,
  selectedEventPageResponseSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import {
  HostDeckSelectedStateRepositoryError,
  type ListSelectedEventsInput
} from "@hostdeck/storage";
import type {
  HostDeckRoutePluginContext,
  HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { requireHostDeckRequestAuthentication } from "./fastify-request-authentication.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckProjectedEventRouteRegistrationId =
  "selected-projected-event-read";

export interface HostDeckProjectedEventStatePort {
  readonly listEvents: (
    sessionId: string,
    input: ListSelectedEventsInput
  ) => unknown;
  readonly require: (sessionId: string) => unknown;
}

export interface CreateHostDeckProjectedEventRouteRegistrationInput {
  readonly state: HostDeckProjectedEventStatePort;
}

type ListEventsFunction = HostDeckProjectedEventStatePort["listEvents"];
type RequireStateFunction = HostDeckProjectedEventStatePort["require"];

interface ParsedStatePort {
  readonly listEvents: ListEventsFunction;
  readonly require: RequireStateFunction;
}

interface EventLayout {
  readonly earliestCursor: number | null;
  readonly highWaterCursor: number | null;
  readonly retainedBytes: number;
  readonly retainedCount: number;
  readonly retentionBoundaryCursor: number | null;
}

const registrationInputKeys = ["state"] as const;
const statePortKeys = ["listEvents", "require"] as const;
const stateKeys = ["mapping", "projection"] as const;
const maximumConsistencyAttempts = 3;

export function createHostDeckProjectedEventRouteRegistration(
  input: CreateHostDeckProjectedEventRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const state = parseRegistrationInput(input);
  const manifest = requireProjectedEventManifestEntry();
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckProjectedEventRouteRegistrationId,
    surface: "api",
    register(app, context) {
      const responseMaxBytes = readResponseMaxBytes(context);
      app.get(
        manifest.path,
        {
          exposeHeadRoute: false,
          async onRequest(request, reply) {
            reply.header("cache-control", "no-store");
            requireHostDeckRequestAuthentication(
              request,
              "loopback_or_device_cookie"
            );
          },
          schema: {
            params: selectedEventPageParamsSchema,
            querystring: selectedEventPageQuerySchema,
            response: { 200: selectedEventPageResponseSchema }
          }
        },
        (request) => {
          const params = request.params as SelectedEventPageParams;
          const query = request.query as SelectedEventPageInput;
          const page = readConsistentPage(
            state,
            params.session_id,
            query
          );
          enforceResponseByteLimit(page, responseMaxBytes);
          return page;
        }
      );
    }
  };
  return Object.freeze(registration);
}

function parseRegistrationInput(input: unknown): ParsedStatePort {
  const values = readExactDataObject(
    input,
    registrationInputKeys,
    "HostDeck projected-event route input is invalid."
  );
  const state = readExactDataObject(
    values.state,
    statePortKeys,
    "HostDeck projected-event state port is invalid."
  );
  if (
    typeof state.listEvents !== "function" ||
    typeof state.require !== "function"
  ) {
    throw new TypeError("HostDeck projected-event state port is invalid.");
  }
  return Object.freeze({
    listEvents: state.listEvents as ListEventsFunction,
    require: state.require as RequireStateFunction
  });
}

function requireProjectedEventManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "session_events"
  );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.family !== "events" ||
    entry.method !== "GET" ||
    entry.path !== "/api/v1/sessions/:session_id/events" ||
    entry.transport !== "json" ||
    entry.request.params !== "session_id_params_v1" ||
    entry.request.query !== "selected_event_query_v1" ||
    entry.request.body !== null ||
    entry.response.success !== "selected_event_page_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "session_read" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "managed_session" ||
    entry.operation_kind !== null ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "events.page" ||
    entry.owner_task !== "IFC-V1-069"
  ) {
    throw new TypeError(
      "Selected projected-event route manifest entry is invalid."
    );
  }
  return entry;
}

function readResponseMaxBytes(context: HostDeckRoutePluginContext): number {
  if (
    context.surface !== "api" ||
    !Number.isSafeInteger(context.resourceBudget.http_response_max_bytes) ||
    context.resourceBudget.http_response_max_bytes < 1
  ) {
    throw new TypeError("HostDeck projected-event response budget is invalid.");
  }
  return context.resourceBudget.http_response_max_bytes;
}

function readConsistentPage(
  state: ParsedStatePort,
  sessionId: SelectedEventPageParams["session_id"],
  query: SelectedEventPageInput
): SelectedEventPageResponse {
  for (let attempt = 1; attempt <= maximumConsistencyAttempts; attempt += 1) {
    const before = readEventLayout(state.require, sessionId);
    assertCursorNotFuture(query.after, before.highWaterCursor, sessionId);
    const candidate = invokeListEvents(state.listEvents, sessionId, query);
    const after = readEventLayout(state.require, sessionId);
    if (!sameEventLayout(before, after)) continue;
    return parseAndValidatePage(candidate, sessionId, query, after);
  }
  throw unstableStorageFailure();
}

function readEventLayout(
  requireState: RequireStateFunction,
  sessionId: SelectedEventPageParams["session_id"]
): EventLayout {
  const candidate = invokeRequireState(requireState, sessionId);
  try {
    const state = readExactDataObject(
      candidate,
      stateKeys,
      "Selected projected-event state is invalid."
    );
    const mapping = selectedSessionMappingRecordSchema.safeParse(state.mapping);
    const projection = selectedSessionProjectionRecordSchema.safeParse(
      state.projection
    );
    if (!mapping.success || !projection.success) throw new TypeError();
    const session = projection.data.session;
    if (
      mapping.data.id !== sessionId ||
      session.id !== sessionId ||
      mapping.data.id !== session.id ||
      mapping.data.name !== session.name ||
      mapping.data.codex_thread_id !== session.codex_thread_id ||
      mapping.data.cwd !== session.cwd ||
      mapping.data.runtime_source !== session.runtime_source ||
      mapping.data.runtime_version !== session.runtime_version ||
      mapping.data.created_at !== session.created_at ||
      mapping.data.archived_at !== session.archived_at
    ) {
      throw new TypeError();
    }
    if (mapping.data.disposition !== "selected") {
      throw unavailableSession(
        sessionId,
        "Session event diagnostics are unavailable during recovery."
      );
    }
    if (mapping.data.archived_at !== null || session.session_state === "archived") {
      throw unavailableSession(
        sessionId,
        "Archived sessions do not expose event diagnostics."
      );
    }

    const layout = Object.freeze({
      earliestCursor: projection.data.earliest_retained_cursor,
      highWaterCursor: session.last_event_cursor,
      retainedBytes: projection.data.retained_event_bytes,
      retainedCount: projection.data.retained_event_count,
      retentionBoundaryCursor: projection.data.retention_boundary_cursor
    });
    assertEventLayout(layout);
    return layout;
  } catch (error) {
    if (error instanceof HostDeckHttpError) throw error;
    throw corruptStorageFailure();
  }
}

function assertEventLayout(layout: EventLayout): void {
  if (layout.retainedCount === 0) {
    if (
      layout.retainedBytes !== 0 ||
      layout.earliestCursor !== null ||
      layout.highWaterCursor !== null ||
      layout.retentionBoundaryCursor !== null
    ) {
      throw new TypeError();
    }
    return;
  }

  if (
    layout.retainedBytes < 1 ||
    layout.earliestCursor === null ||
    layout.highWaterCursor === null ||
    layout.earliestCursor > layout.highWaterCursor ||
    layout.retainedCount !== layout.highWaterCursor - layout.earliestCursor + 1 ||
    (layout.retentionBoundaryCursor !== null &&
      (layout.retentionBoundaryCursor >= layout.earliestCursor ||
        layout.retentionBoundaryCursor + 1 !== layout.earliestCursor))
  ) {
    throw new TypeError();
  }
}

function invokeRequireState(
  requireState: RequireStateFunction,
  sessionId: SelectedEventPageParams["session_id"]
): unknown {
  try {
    return Reflect.apply(requireState, undefined, [sessionId]);
  } catch (error) {
    throw mapRepositoryFailure(error, sessionId);
  }
}

function invokeListEvents(
  listEvents: ListEventsFunction,
  sessionId: SelectedEventPageParams["session_id"],
  query: SelectedEventPageInput
): unknown {
  try {
    return Reflect.apply(listEvents, undefined, [sessionId, query]);
  } catch (error) {
    if (
      error instanceof HostDeckSelectedStateRepositoryError &&
      error.code === "invalid_replay"
    ) {
      throw futureCursor(sessionId);
    }
    throw mapRepositoryFailure(error, sessionId);
  }
}

function mapRepositoryFailure(
  error: unknown,
  sessionId: SelectedEventPageParams["session_id"]
): HostDeckHttpError {
  if (
    error instanceof HostDeckSelectedStateRepositoryError &&
    error.code === "session_not_found"
  ) {
    return new HostDeckHttpError({
      code: "session_not_found",
      message: "Session was not found.",
      retryable: false,
      sessionId,
      status: 404
    });
  }
  return storageFailure();
}

function parseAndValidatePage(
  candidate: unknown,
  sessionId: SelectedEventPageParams["session_id"],
  query: SelectedEventPageInput,
  layout: EventLayout
): SelectedEventPageResponse {
  const parsed = selectedEventPageResponseSchema.safeParse(candidate);
  if (!parsed.success) throw corruptStorageFailure();
  const page = parsed.data;
  const events = page.events;
  const baseCursor = query.after ?? 0;
  const highWaterCursor = layout.highWaterCursor ?? 0;
  const first = events[0];
  const final = events.at(-1);

  if (
    page.session_id !== sessionId ||
    events.length > query.limit ||
    events.some(
      (event) =>
        event.session_id !== sessionId ||
        event.cursor <= baseCursor ||
        event.cursor > highWaterCursor
    )
  ) {
    throw corruptStorageFailure();
  }

  if (events.length === 0) {
    if (
      baseCursor < highWaterCursor ||
      page.next_cursor !== highWaterCursor ||
      page.truncated
    ) {
      throw corruptStorageFailure();
    }
    return deepFreeze(page);
  }

  const crossesRetentionBoundary =
    layout.retentionBoundaryCursor !== null &&
    baseCursor <= layout.retentionBoundaryCursor;
  if (crossesRetentionBoundary) {
    if (
      first?.type !== "replay_boundary" ||
      first.reason !== "retention" ||
      first.after !== layout.retentionBoundaryCursor ||
      first.cursor !== layout.retentionBoundaryCursor + 1 ||
      !page.truncated
    ) {
      throw corruptStorageFailure();
    }
  } else if (first?.cursor !== baseCursor + 1) {
    throw corruptStorageFailure();
  } else if (
    first.type === "replay_boundary" &&
    first.after !== query.after &&
    !(baseCursor === 0 && first.after === null)
  ) {
    throw corruptStorageFailure();
  }

  if (
    final === undefined ||
    page.next_cursor !== final.cursor ||
    (events.length < query.limit && final.cursor !== highWaterCursor)
  ) {
    throw corruptStorageFailure();
  }
  return deepFreeze(page);
}

function assertCursorNotFuture(
  after: number | null,
  highWaterCursor: number | null,
  sessionId: SelectedEventPageParams["session_id"]
): void {
  if (after !== null && after > (highWaterCursor ?? 0)) {
    throw futureCursor(sessionId);
  }
}

function sameEventLayout(left: EventLayout, right: EventLayout): boolean {
  return (
    left.earliestCursor === right.earliestCursor &&
    left.highWaterCursor === right.highWaterCursor &&
    left.retainedBytes === right.retainedBytes &&
    left.retainedCount === right.retainedCount &&
    left.retentionBoundaryCursor === right.retentionBoundaryCursor
  );
}

function enforceResponseByteLimit(
  page: SelectedEventPageResponse,
  maximumBytes: number
): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
  } catch {
    throw corruptStorageFailure();
  }
  if (bytes > maximumBytes) {
    throw new HostDeckHttpError({
      code: "service_overloaded",
      field: "limit",
      message: "Projected-event page exceeds the configured response limit.",
      retryable: false,
      status: 503
    });
  }
}

function unavailableSession(
  sessionId: SelectedEventPageParams["session_id"],
  message: string
): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "stale_session",
    message,
    retryable: false,
    sessionId,
    status: 409
  });
}

function futureCursor(
  sessionId: SelectedEventPageParams["session_id"]
): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "stale_session",
    field: "after",
    message: "Event cursor is ahead of the committed session state.",
    retryable: false,
    sessionId,
    status: 409
  });
}

function storageFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "storage_error",
    message: "Projected-event diagnostics are unavailable.",
    retryable: false,
    status: 500
  });
}

function corruptStorageFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "storage_error",
    message: "Projected-event storage is inconsistent.",
    retryable: false,
    status: 500
  });
}

function unstableStorageFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "storage_error",
    message: "Projected-event state changed during the bounded read.",
    retryable: true,
    status: 500
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(expectedKeys as readonly string[]).includes(key)
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values) as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}
