import { Buffer } from "node:buffer";
import {
  compareSelectedSessionListSortKeys,
  encodeSelectedSessionListCursor,
  type SelectedRequestAuthenticationContext,
  type SelectedSessionDetailResponse,
  type SelectedSessionListInput,
  type SelectedSessionListPage,
  type SelectedSessionListResponse,
  type SelectedSessionReadAccess,
  type SelectedSessionReadItem,
  selectedSessionDetailResponseSchema,
  selectedSessionListPageSchema,
  selectedSessionListQuerySchema,
  selectedSessionListResponseSchema,
  selectedSessionListSortKey,
  selectedSessionReadAccessSchema,
  selectedSessionReadItemSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import {
  HostDeckSelectedSessionReadRepositoryError,
  type SelectedSessionReadRepository
} from "@hostdeck/storage";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type HostDeckRoutePluginContext,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { createHostDeckErrorBody, HostDeckHttpError } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationCurrent,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckSessionReadRouteRegistrationId = "selected-session-read";

export interface CreateHostDeckSessionReadRouteRegistrationInput {
  readonly sessions: SelectedSessionReadRepository;
}

type SessionGetFunction = SelectedSessionReadRepository["get"];
type SessionListFunction = SelectedSessionReadRepository["list"];

interface SessionReadFunctions {
  readonly get: SessionGetFunction;
  readonly list: SessionListFunction;
}

const registrationInputKeys = ["sessions"] as const;
const sessionReadPortKeys = ["get", "list"] as const;
const noQuerySchema = z.object({}).strict();
const registeredSessionReadPorts = new WeakSet<object>();

class HostDeckSessionReadContractError extends Error {
  constructor() {
    super("Selected session-read route contract failed.");
    this.name = "HostDeckSessionReadContractError";
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

export function createHostDeckSessionReadRouteRegistration(
  input: CreateHostDeckSessionReadRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const parsedInput = readExactDataObject(
    input,
    registrationInputKeys,
    "HostDeck session-read route input is invalid."
  );
  const portCandidate = parsedInput.sessions;
  const functions = parseSessionReadPort(portCandidate);
  if (
    portCandidate === null ||
    typeof portCandidate !== "object" ||
    registeredSessionReadPorts.has(portCandidate)
  ) {
    throw new TypeError("HostDeck session-read port already owns a route registration.");
  }
  const manifests = requireSessionReadManifestEntries();
  const responseContexts = new WeakMap<
    FastifyRequest,
    SelectedRequestAuthenticationContext
  >();
  const responseInvalidations = new WeakSet<FastifyRequest>();
  let registered = false;

  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckSessionReadRouteRegistrationId,
    surface: "api",
    register(app, context) {
      if (registered) throw new TypeError("HostDeck session-read routes are already registered.");
      registered = true;
      const responseMaximumBytes = readResponseMaximumBytes(context);
      const authenticate = currentSessionReadAuthentication(responseContexts);
      const revalidate = currentSessionReadResponse(
        responseContexts,
        responseInvalidations
      );

      app.get(
        manifests.list.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          onRequest: authenticate,
          onSend: revalidate,
          schema: {
            querystring: selectedSessionListQuerySchema,
            response: { 200: selectedSessionListResponseSchema }
          }
        },
        (request) => {
          rejectReadBody(request);
          const authentication = requireCapturedAuthentication(request, responseContexts);
          const query = request.query as SelectedSessionListInput;
          const page = readListPage(functions.list, query);
          assertPageMatchesQuery(page, query);
          const response = prepareListResponse(page, authentication);
          enforceResponseByteLimit(response, responseMaximumBytes);
          return response;
        }
      );

      app.get(
        manifests.detail.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          onRequest: authenticate,
          onSend: revalidate,
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            response: { 200: selectedSessionDetailResponseSchema }
          }
        },
        (request) => {
          rejectReadBody(request);
          const authentication = requireCapturedAuthentication(request, responseContexts);
          const params = sessionIdParamsSchema.parse(request.params);
          const session = readDetail(functions.get, params.session_id);
          if (session === null) throw sessionNotFound(params.session_id);
          const response = prepareDetailResponse(session, authentication);
          enforceResponseByteLimit(response, responseMaximumBytes);
          return response;
        }
      );
    }
  };

  registeredSessionReadPorts.add(portCandidate);
  return Object.freeze(registration);
}

function parseSessionReadPort(candidate: unknown): SessionReadFunctions {
  if (!Object.isFrozen(candidate)) {
    throw new TypeError("HostDeck session-read port must be immutable.");
  }
  const values = readExactDataObject(
    candidate,
    sessionReadPortKeys,
    "HostDeck session-read port is invalid."
  );
  if (typeof values.get !== "function" || typeof values.list !== "function") {
    throw new TypeError("HostDeck session-read port is invalid.");
  }
  return Object.freeze({
    get: values.get as SessionGetFunction,
    list: values.list as SessionListFunction
  });
}

function currentSessionReadAuthentication(
  contexts: WeakMap<FastifyRequest, SelectedRequestAuthenticationContext>
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    applyNoStore(reply);
    const context = requireHostDeckRequestAuthentication(
      request,
      "loopback_or_device_cookie"
    );
    contexts.set(request, context);
    if ((request.raw.url ?? request.url).split("?", 1)[0]?.endsWith("/")) {
      throw routeNotFound();
    }
  };
}

function currentSessionReadResponse(
  contexts: WeakMap<FastifyRequest, SelectedRequestAuthenticationContext>,
  invalidations: WeakSet<FastifyRequest>
): (request: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown> {
  return async (request, reply, payload) => {
    if (invalidations.has(request)) return payload;
    const context = contexts.get(request);
    if (context !== undefined) {
      try {
        assertHostDeckRequestAuthenticationCurrent(request, context);
      } catch (error) {
        invalidations.add(request);
        if (error instanceof HostDeckHttpError) {
          reply
            .code(error.statusCode)
            .header("x-request-id", request.id)
            .type("application/json; charset=utf-8");
          return JSON.stringify(createHostDeckErrorBody(error.envelope, request.id));
        }
        throw error;
      }
    }
    return payload;
  };
}

function requireCapturedAuthentication(
  request: FastifyRequest,
  contexts: WeakMap<FastifyRequest, SelectedRequestAuthenticationContext>
): SelectedRequestAuthenticationContext {
  const context = contexts.get(request);
  if (context === undefined) throw contractFailure();
  assertHostDeckRequestAuthenticationCurrent(request, context);
  return context;
}

function readListPage(
  list: SessionListFunction,
  input: SelectedSessionListInput
): SelectedSessionListPage {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(list, undefined, [input]);
  } catch (error) {
    throw mapRepositoryFailure(error);
  }
  try {
    assertDeepFrozenDataTree(candidate);
    const parsed = selectedSessionListPageSchema.safeParse(candidate);
    if (!parsed.success) throw new TypeError();
    return parsed.data;
  } catch {
    throw contractFailure();
  }
}

function readDetail(
  get: SessionGetFunction,
  sessionId: SelectedSessionReadItem["session"]["id"]
): SelectedSessionReadItem | null {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(get, undefined, [sessionId]);
  } catch (error) {
    throw mapRepositoryFailure(error, sessionId);
  }
  if (candidate === null) return null;
  try {
    assertDeepFrozenDataTree(candidate);
    const parsed = selectedSessionReadItemSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.session.id !== sessionId) throw new TypeError();
    return parsed.data;
  } catch {
    throw contractFailure();
  }
}

function assertPageMatchesQuery(
  page: SelectedSessionListPage,
  input: SelectedSessionListInput
): void {
  if (
    page.sessions.length > input.limit ||
    (page.has_more && page.sessions.length !== input.limit) ||
    (input.expected_order_snapshot !== null &&
      page.order_snapshot !== input.expected_order_snapshot) ||
    (input.after !== null &&
      page.sessions.some(
        (item) =>
          input.after !== null &&
          compareSelectedSessionListSortKeys(
            input.after,
            selectedSessionListSortKey(item.session)
          ) >= 0
      ))
  ) {
    throw contractFailure();
  }
}

function prepareListResponse(
  page: SelectedSessionListPage,
  authentication: SelectedRequestAuthenticationContext
): SelectedSessionListResponse {
  const nextCursor =
    page.next_after === null
      ? null
      : encodeSelectedSessionListCursor({
          after: page.next_after,
          order_snapshot: page.order_snapshot
        });
  const parsed = selectedSessionListResponseSchema.safeParse({
    access: publicAccess(authentication),
    has_more: page.has_more,
    next_cursor: nextCursor,
    sessions: page.sessions
  });
  if (!parsed.success) throw contractFailure();
  return parsed.data;
}

function prepareDetailResponse(
  session: SelectedSessionReadItem,
  authentication: SelectedRequestAuthenticationContext
): SelectedSessionDetailResponse {
  const parsed = selectedSessionDetailResponseSchema.safeParse({
    access: publicAccess(authentication),
    session
  });
  if (!parsed.success) throw contractFailure();
  return parsed.data;
}

function publicAccess(
  context: SelectedRequestAuthenticationContext
): SelectedSessionReadAccess {
  let mode: SelectedSessionReadAccess["mode"];
  if (context.state === "local_admin") {
    mode = "local_admin";
  } else if (context.state === "unpaired" && context.network_mode === "loopback") {
    mode = "loopback_read";
  } else if (context.state === "paired_device" && context.permission === "read") {
    mode = "paired_read";
  } else if (context.state === "paired_device" && context.permission === "write") {
    mode = "paired_write";
  } else {
    throw contractFailure();
  }
  const parsed = selectedSessionReadAccessSchema.safeParse({
    mode,
    network_mode: context.network_mode,
    transport: context.transport
  });
  if (!parsed.success) throw contractFailure();
  return parsed.data;
}

function rejectReadBody(request: FastifyRequest): void {
  const contentLength = request.headers["content-length"];
  const transferEncoding = request.headers["transfer-encoding"];
  if (
    request.body !== undefined ||
    transferEncoding !== undefined ||
    (contentLength !== undefined && !/^0+$/u.test(contentLength.trim()))
  ) {
    throw new HostDeckHttpError({
      code: "validation_error",
      field: "body",
      message: "Session read request cannot contain a body.",
      retryable: false,
      status: 400
    });
  }
}

function mapRepositoryFailure(
  error: unknown,
  sessionId?: SelectedSessionReadItem["session"]["id"]
): HostDeckHttpError {
  if (error instanceof HostDeckSelectedSessionReadRepositoryError) {
    switch (error.code) {
      case "session_archived":
        return unavailableSession("Archived sessions are unavailable.", sessionId);
      case "session_recovery_required":
        return unavailableSession("Session state requires recovery.", sessionId);
      case "session_list_changed":
        return new HostDeckHttpError({
          code: "stale_session",
          field: "cursor",
          message: "Session ordering changed; refresh the first page.",
          retryable: false,
          status: 409
        });
      case "session_list_overflow":
        return new HostDeckHttpError({
          code: "service_overloaded",
          field: "limit",
          message: "Managed-session listing exceeds the supported bound.",
          retryable: false,
          status: 503
        });
      case "invalid_input":
      case "invalid_state":
      case "read_failed":
        return storageFailure();
    }
  }
  return storageFailure();
}

function sessionNotFound(
  sessionId: SelectedSessionReadItem["session"]["id"]
): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "session_not_found",
    message: "Session was not found.",
    retryable: false,
    sessionId,
    status: 404
  });
}

function routeNotFound(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "route_not_found",
    message: "Route was not found.",
    retryable: false,
    status: 404
  });
}

function unavailableSession(
  message: string,
  sessionId?: SelectedSessionReadItem["session"]["id"]
): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "stale_session",
    message,
    retryable: false,
    ...(sessionId === undefined ? {} : { sessionId }),
    status: 409
  });
}

function storageFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "storage_error",
    message: "Managed-session diagnostics are unavailable.",
    retryable: false,
    status: 500
  });
}

function enforceResponseByteLimit(
  response: SelectedSessionListResponse | SelectedSessionDetailResponse,
  maximumBytes: number
): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  } catch {
    throw contractFailure();
  }
  if (bytes > maximumBytes) {
    throw new HostDeckHttpError({
      code: "service_overloaded",
      field: "limit",
      message: "Managed-session response exceeds the configured limit.",
      retryable: false,
      status: 503
    });
  }
}

function readResponseMaximumBytes(context: HostDeckRoutePluginContext): number {
  if (
    context.surface !== "api" ||
    !Number.isSafeInteger(context.resourceBudget.http_response_max_bytes) ||
    context.resourceBudget.http_response_max_bytes < 1
  ) {
    throw new TypeError("HostDeck session-read response budget is invalid.");
  }
  return context.resourceBudget.http_response_max_bytes;
}

function requireSessionReadManifestEntries(): Readonly<{
  detail: SelectedApiRouteManifestEntry;
  list: SelectedApiRouteManifestEntry;
}> {
  const list = requireManifestEntry("session_list");
  const detail = requireManifestEntry("session_detail");
  if (
    list.path !== "/api/v1/sessions" ||
    list.request.params !== null ||
    list.request.query !== "session_list_query_v1" ||
    list.response.success !== "selected_session_list_response_v1" ||
    list.target !== "none" ||
    list.handler !== "sessions.list" ||
    detail.path !== "/api/v1/sessions/:session_id" ||
    detail.request.params !== "session_id_params_v1" ||
    detail.request.query !== null ||
    detail.response.success !== "selected_session_detail_response_v1" ||
    detail.target !== "managed_session" ||
    detail.handler !== "sessions.detail"
  ) {
    throw new TypeError("Selected session-read route manifest entries are invalid.");
  }
  return Object.freeze({ detail, list });
}

function requireManifestEntry(
  id: "session_detail" | "session_list"
): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.family !== "sessions" ||
    entry.method !== "GET" ||
    entry.transport !== "json" ||
    entry.request.body !== null ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "session_read" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.operation_kind !== null ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.owner_task !== "IFC-V1-068"
  ) {
    throw new TypeError("Selected session-read route manifest entry is invalid.");
  }
  return entry;
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
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
    const values = Object.create(null) as Record<Key, unknown>;
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
    return Object.freeze(values);
  } catch {
    throw new TypeError(message);
  }
}

function assertDeepFrozenDataTree(candidate: unknown): void {
  try {
    visitFrozenData(candidate, new WeakSet<object>(), { nodes: 0 }, 0);
  } catch {
    throw contractFailure();
  }
}

function visitFrozenData(
  candidate: unknown,
  active: WeakSet<object>,
  state: { nodes: number },
  depth: number
): void {
  if (candidate === null || typeof candidate !== "object") return;
  if (depth > 64 || state.nodes >= 8_192 || active.has(candidate) || !Object.isFrozen(candidate)) {
    throw new TypeError();
  }
  state.nodes += 1;
  active.add(candidate);
  try {
    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) throw new TypeError();
      const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<
        string,
        PropertyDescriptor | undefined
      >;
      const length = descriptors.length?.value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        Reflect.ownKeys(descriptors).length !== length + 1
      ) {
        throw new TypeError();
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError();
        }
        visitFrozenData(descriptor.value, active, state, depth + 1);
      }
      return;
    }

    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      visitFrozenData(descriptor.value, active, state, depth + 1);
    }
  } finally {
    active.delete(candidate);
  }
}

function applyNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function contractFailure(): HostDeckSessionReadContractError {
  return new HostDeckSessionReadContractError();
}
