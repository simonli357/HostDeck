import { sessionIdParamsSchema } from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import { HostDeckSseAbortError } from "./fastify-sse-source.js";
import {
  createHostDeckSseTransportRegistration,
  type HostDeckSseFailureObserver,
  type HostDeckSseSourceInput
} from "./fastify-sse-transport.js";
import {
  HostDeckProjectionHandoffError
} from "./projection-replay-live-handoff.js";
import {
  assertProjectionSubscriberStreamService,
  HostDeckProjectionSubscriberError,
  type ProjectionSubscriberStreamService
} from "./projection-subscriber-stream.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckProjectionStreamRouteRegistrationId =
  "selected-projection-event-stream";

export interface CreateHostDeckProjectionStreamRouteRegistrationInput {
  readonly observe_error: HostDeckSseFailureObserver;
  readonly subscribers: ProjectionSubscriberStreamService;
}

const routeInputKeys = ["observe_error", "subscribers"] as const;

export function createHostDeckProjectionStreamRouteRegistration(
  input: CreateHostDeckProjectionStreamRouteRegistrationInput
) {
  const values = readExactRouteInput(input);
  if (typeof values.observe_error !== "function") {
    throw new TypeError("HostDeck projection-stream error observer is invalid.");
  }
  assertProjectionSubscriberStreamService(values.subscribers);
  const manifest = requireProjectionStreamManifestEntry();
  const subscribers = values.subscribers;
  return createHostDeckSseTransportRegistration({
    id: hostDeckProjectionStreamRouteRegistrationId,
    observeError: values.observe_error as HostDeckSseFailureObserver,
    paramsSchema: sessionIdParamsSchema,
    path: manifest.path,
    source: {
      open(sourceInput: HostDeckSseSourceInput) {
        const params = sessionIdParamsSchema.safeParse(sourceInput.params);
        if (!params.success) {
          throw new HostDeckHttpError({
            code: "validation_error",
            field: "params",
            message: "Session event-stream target is invalid.",
            retryable: false,
            status: 400
          });
        }
        const authentication = requireHostDeckRequestAuthentication(
          sourceInput.request,
          "loopback_or_device_cookie"
        );
        const deviceId =
          authentication.state === "paired_device"
            ? authentication.device_id
            : null;
        if (authentication.state === "paired_device" && deviceId === null) {
          throw new HostDeckHttpError({
            code: "internal_error",
            message: "Paired stream authority is inconsistent.",
            retryable: false,
            status: 500
          });
        }
        try {
          return subscribers.open({
            after: sourceInput.after,
            authorization: authentication,
            device_id: deviceId,
            session_id: params.data.session_id,
            signal: sourceInput.signal,
            subscriber_id: `stream:${sourceInput.request.id}`
          });
        } catch (error) {
          throw mapStreamOpenFailure(error, params.data.session_id);
        }
      }
    }
  });
}

function requireProjectionStreamManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "session_event_stream"
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
    entry.path !== "/api/v1/sessions/:session_id/events/stream" ||
    entry.transport !== "sse" ||
    entry.request.params !== "session_id_params_v1" ||
    entry.request.query !== "selected_stream_cursor_query_v1" ||
    entry.request.body !== null ||
    entry.response.success !== "selected_projection_event_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "session_read" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "managed_session" ||
    entry.operation_kind !== null ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "events.stream" ||
    entry.owner_task !== "IFC-V1-035"
  ) {
    throw new TypeError("Selected projection-stream route manifest entry is invalid.");
  }
  return entry;
}

function mapStreamOpenFailure(error: unknown, sessionId: SessionId): Error {
  if (error instanceof HostDeckHttpError) return error;
  if (error instanceof HostDeckProjectionSubscriberError) {
    switch (error.code) {
      case "aborted":
        return new HostDeckSseAbortError(error);
      case "subscriber_device_limit":
      case "subscriber_exists":
      case "subscriber_global_limit":
      case "subscriber_session_limit":
      case "queue_overflow":
      case "service_closed":
        return new HostDeckHttpError({
          code: "service_overloaded",
          message: "Session event-stream capacity is unavailable.",
          retryable: false,
          status: 503
        });
      case "session_archived":
        return staleSession(sessionId, "Archived sessions cannot open an event stream.");
      case "concurrent_iteration":
      case "invalid_config":
      case "invalid_input":
      case "source_failed":
        return internalStreamFailure();
    }
  }
  if (error instanceof HostDeckProjectionHandoffError) {
    switch (error.code) {
      case "aborted":
        return new HostDeckSseAbortError(error);
      case "authorization_failed":
        return new HostDeckHttpError({
          code: "permission_denied",
          message: "Session event-stream read is not authorized.",
          retryable: false,
          status: 403
        });
      case "session_not_found":
        return new HostDeckHttpError({
          code: "session_not_found",
          message: "Session was not found.",
          retryable: false,
          sessionId,
          status: 404
        });
      case "future_cursor":
        return new HostDeckHttpError({
          code: "stale_session",
          field: "after",
          message: "Event cursor is ahead of the committed session state.",
          retryable: false,
          sessionId,
          status: 409
        });
      case "session_archived":
        return staleSession(sessionId, "Archived sessions cannot open an event stream.");
      case "event_too_large":
      case "paused_queue_overflow":
      case "replay_limit":
        return new HostDeckHttpError({
          code: "service_overloaded",
          message: "Session event replay exceeds configured capacity.",
          retryable: false,
          status: 503
        });
      case "storage_unavailable":
        return new HostDeckHttpError({
          code: "storage_error",
          message: "Session event storage is unavailable.",
          retryable: false,
          status: 500
        });
      case "activation_reentrant":
      case "already_activated":
      case "fanout_unavailable":
      case "handoff_closed":
      case "handoff_failed":
      case "invalid_config":
      case "invalid_input":
      case "invalid_live_sink":
      case "live_delivery_failed":
      case "replay_inconsistent":
        return internalStreamFailure();
    }
  }
  return internalStreamFailure();
}

function staleSession(sessionId: SessionId, message: string): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "stale_session",
    message,
    retryable: false,
    sessionId,
    status: 409
  });
}

function internalStreamFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "internal_error",
    message: "Session event stream is unavailable.",
    retryable: false,
    status: 500
  });
}

function readExactRouteInput(
  candidate: unknown
): Readonly<{
  observe_error: unknown;
  subscribers: unknown;
}> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("HostDeck projection-stream route input must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const observeError = descriptors.observe_error;
  const subscribers = descriptors.subscribers;
  if (
    keys.length !== routeInputKeys.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !routeInputKeys.includes(key as (typeof routeInputKeys)[number])
    ) ||
    observeError === undefined ||
    subscribers === undefined ||
    !("value" in observeError) ||
    !("value" in subscribers)
  ) {
    throw new TypeError("HostDeck projection-stream route fields are invalid.");
  }
  return Object.freeze({
    observe_error: observeError.value,
    subscribers: subscribers.value
  });
}
