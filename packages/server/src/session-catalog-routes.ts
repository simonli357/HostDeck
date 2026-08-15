import { sessionCatalogEventSchema } from "@hostdeck/contracts";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { requireHostDeckRequestAuthentication } from "./fastify-request-authentication.js";
import { HostDeckSseAbortError } from "./fastify-sse-source.js";
import {
  createHostDeckSseTransportRegistration,
  type HostDeckSseFailureObserver,
  type HostDeckSseSourceInput
} from "./fastify-sse-transport.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
import {
  assertSessionCatalogHub,
  HostDeckSessionCatalogHubError,
  type SessionCatalogHub
} from "./session-catalog-hub.js";

export const hostDeckSessionCatalogRouteRegistrationId =
  "selected-session-catalog-stream";

export interface CreateHostDeckSessionCatalogRouteRegistrationInput {
  readonly catalog: SessionCatalogHub;
  readonly observe_error: HostDeckSseFailureObserver;
}

export function createHostDeckSessionCatalogRouteRegistration(
  input: CreateHostDeckSessionCatalogRouteRegistrationInput
) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 2 ||
    !Object.hasOwn(input, "catalog") ||
    !Object.hasOwn(input, "observe_error") ||
    typeof input.observe_error !== "function"
  ) {
    throw new TypeError("HostDeck session-catalog route input is invalid.");
  }
  assertSessionCatalogHub(input.catalog);
  const manifest = requireCatalogManifestEntry();
  const catalog = input.catalog;
  return createHostDeckSseTransportRegistration({
    eventSchema: sessionCatalogEventSchema,
    id: hostDeckSessionCatalogRouteRegistrationId,
    observeError: input.observe_error,
    path: manifest.path,
    source: {
      open(sourceInput: HostDeckSseSourceInput) {
        const authentication = requireHostDeckRequestAuthentication(
          sourceInput.request,
          "loopback_or_device_cookie"
        );
        const deviceId =
          authentication.state === "paired_device"
            ? authentication.device_id
            : null;
        if (authentication.state === "paired_device" && deviceId === null) {
          throw internalFailure();
        }
        try {
          return catalog.open({
            after: sourceInput.after,
            authorization: authentication,
            device_id: deviceId,
            signal: sourceInput.signal,
            subscriber_id: `catalog-stream:${sourceInput.request.id}`
          });
        } catch (error) {
          throw mapCatalogOpenFailure(error);
        }
      }
    }
  });
}

function requireCatalogManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "session_catalog_stream"
  );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    entry.family !== "sessions" ||
    entry.method !== "GET" ||
    entry.path !== "/api/v1/sessions/catalog/stream" ||
    entry.transport !== "sse" ||
    entry.request.params !== null ||
    entry.request.query !== "selected_stream_cursor_query_v1" ||
    entry.request.body !== null ||
    entry.response.success !== "session_catalog_event_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "session_read" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "host" ||
    entry.operation_kind !== null ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "sessions.catalogStream" ||
    entry.owner_task !== "IFC-V1-112"
  ) {
    throw new TypeError("Selected session-catalog route manifest entry is invalid.");
  }
  return entry;
}

function mapCatalogOpenFailure(error: unknown): Error {
  if (!(error instanceof HostDeckSessionCatalogHubError)) {
    return internalFailure();
  }
  switch (error.code) {
    case "aborted":
      return new HostDeckSseAbortError(error);
    case "authorization_failed":
      return new HostDeckHttpError({
        code: "permission_denied",
        message: "Session catalog read is not authorized.",
        retryable: false,
        status: 403
      });
    case "future_cursor":
      return new HostDeckHttpError({
        code: "stale_session",
        field: "after",
        message: "Catalog cursor is ahead of current state.",
        retryable: false,
        status: 409
      });
    case "event_too_large":
    case "replay_limit":
    case "subscriber_device_limit":
    case "subscriber_exists":
    case "subscriber_global_limit":
      return new HostDeckHttpError({
        code: "service_overloaded",
        message: "Session catalog stream capacity is unavailable.",
        retryable: false,
        status: 503
      });
    case "storage_unavailable":
      return new HostDeckHttpError({
        code: "storage_error",
        message: "Session catalog storage is unavailable.",
        retryable: false,
        status: 500
      });
    case "catalog_closed":
    case "catalog_failed":
    case "invalid_config":
    case "invalid_input":
    case "publication_failed":
      return internalFailure();
  }
}

function internalFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "internal_error",
    message: "Session catalog stream is unavailable.",
    retryable: false,
    status: 500
  });
}
