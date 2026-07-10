import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  assertResolvedResourceBudget,
  type ResourceBudget
} from "@hostdeck/contracts";
import { createOperationDeadlineView, type OperationDeadline } from "@hostdeck/core";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type HTTPMethods,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault
} from "fastify";
import {
  type HostDeckInternalErrorObserver,
  handleHostDeckFastifyError,
  installHostDeckErrorPolicy,
  sendHostDeckError
} from "./fastify-error-policy.js";
import { fastifyResourceOptionsFromBudget } from "./fastify-resource-options.js";
import {
  assertHostDeckApiResponseSchemas,
  assertHostDeckRouteSchemas,
  type HostDeckZodTypeProvider,
  installHostDeckZodCompilers
} from "./fastify-zod.js";

export type HostDeckFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  HostDeckZodTypeProvider
>;

export interface HostDeckRoutePluginContext {
  readonly resourceBudget: ResourceBudget;
  readonly surface: HostDeckRoutePluginSurface;
}

export const hostDeckRoutePluginSurfaces = ["api", "sse", "static"] as const;
export type HostDeckRoutePluginSurface = (typeof hostDeckRoutePluginSurfaces)[number];

export interface HostDeckRoutePluginRegistration {
  readonly id: string;
  readonly surface: HostDeckRoutePluginSurface;
  readonly register: (
    app: HostDeckFastifyInstance,
    context: HostDeckRoutePluginContext
  ) => void | Promise<void>;
}

export interface CreateHostDeckFastifyAppInput {
  readonly resourceBudget: ResourceBudget;
  readonly routePlugins: readonly HostDeckRoutePluginRegistration[];
  readonly observeInternalError: HostDeckInternalErrorObserver;
}

export interface HostDeckFastifyResourceSnapshot {
  readonly in_flight_requests: number;
  readonly max_in_flight_requests: number;
  readonly rejected_overload_requests: number;
}

interface AppRuntimeState {
  readonly registeredMethods: Set<string>;
  readonly resourceBudget: ResourceBudget;
  inFlightRequests: number;
  rejectedOverloadRequests: number;
}

interface RequestRuntimeState {
  readonly deadline: OperationDeadline;
  readonly owner: AppRuntimeState;
  finalized: boolean;
  handlerStarted: boolean;
  handlerSettled: boolean;
  responseFinished: boolean;
}

const appRuntimeStates = new WeakMap<FastifyInstance, AppRuntimeState>();
const requestRuntimeState = Symbol("hostdeckRequestRuntimeState");
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const routePluginIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const methodOrder = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

type RequestWithRuntimeState = import("fastify").FastifyRequest & {
  [requestRuntimeState]?: RequestRuntimeState;
};

export function createHostDeckFastifyApp(input: CreateHostDeckFastifyAppInput): HostDeckFastifyInstance {
  assertFactoryInput(input);
  assertResolvedResourceBudget(input.resourceBudget);
  const registrations = parseRoutePluginRegistrations(input.routePlugins);
  const resourceOptions = fastifyResourceOptionsFromBudget(input.resourceBudget);
  const app = Fastify({
    ...resourceOptions.factory,
    frameworkErrors: (error, request, reply) =>
      handleHostDeckFastifyError(error, request, reply, input.observeInternalError),
    genReqId: () => `req_${randomUUID()}`,
    onConstructorPoisoning: "error",
    onProtoPoisoning: "error",
    requestIdHeader: false,
    return503OnClosing: true,
    routerOptions: {
      ...resourceOptions.factory.routerOptions,
      allowUnsafeRegex: false,
      caseSensitive: true,
      ignoreDuplicateSlashes: false,
      ignoreTrailingSlash: false
    },
    trustProxy: false
  }).withTypeProvider<HostDeckZodTypeProvider>();
  const runtime: AppRuntimeState = {
    inFlightRequests: 0,
    registeredMethods: new Set<string>(),
    rejectedOverloadRequests: 0,
    resourceBudget: input.resourceBudget
  };
  appRuntimeStates.set(app, runtime);

  installHostDeckZodCompilers(app);
  installHostDeckErrorPolicy(app, input.observeInternalError);
  app.removeContentTypeParser("text/plain");
  installRoutePolicy(app, runtime);
  installRequestPolicy(app, runtime);
  installNotFoundPolicy(app, runtime);

  for (const registration of registrations) {
    app.register(async (scope) => {
      try {
        const typedScope = scope.withTypeProvider<HostDeckZodTypeProvider>();
        installSurfaceRoutePolicy(typedScope, registration.surface);
        const pluginContext: HostDeckRoutePluginContext = Object.freeze({
          resourceBudget: input.resourceBudget,
          surface: registration.surface
        });
        await registration.register(typedScope, pluginContext);
      } catch (cause) {
        throw new TypeError(`HostDeck route plugin "${registration.id}" failed registration.`, { cause });
      }
    });
  }

  return app;
}

export function hostDeckRequestDeadline(request: import("fastify").FastifyRequest): OperationDeadline {
  const state = (request as RequestWithRuntimeState)[requestRuntimeState];
  if (state === undefined) throw new Error("HostDeck request deadline is unavailable outside the managed route lifecycle.");
  return state.deadline;
}

export function hostDeckFastifyResourceSnapshot(app: FastifyInstance): HostDeckFastifyResourceSnapshot {
  const runtime = appRuntimeStates.get(app);
  if (runtime === undefined) throw new TypeError("Fastify instance is not owned by the HostDeck app factory.");
  return Object.freeze({
    in_flight_requests: runtime.inFlightRequests,
    max_in_flight_requests: runtime.resourceBudget.http_max_in_flight_requests,
    rejected_overload_requests: runtime.rejectedOverloadRequests
  });
}

function installRoutePolicy(app: HostDeckFastifyInstance, runtime: AppRuntimeState): void {
  app.addHook("onRoute", (routeOptions) => {
    assertHostDeckRouteSchemas(routeOptions.schema);
    if (routeOptions.validatorCompiler !== undefined || routeOptions.serializerCompiler !== undefined) {
      throw new TypeError("HostDeck routes cannot replace the global Zod compilers.");
    }
    enforceRouteCeiling(routeOptions.bodyLimit, runtime.resourceBudget.http_body_max_bytes, "bodyLimit");
    enforceRouteCeiling(routeOptions.handlerTimeout, runtime.resourceBudget.http_request_deadline_ms, "handlerTimeout");
    for (const method of Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]) {
      runtime.registeredMethods.add(method.toUpperCase());
    }

    const originalHandler = routeOptions.handler;
    routeOptions.handler = function hostDeckBoundedRouteHandler(request, reply) {
      const state = (request as RequestWithRuntimeState)[requestRuntimeState];
      if (state === undefined) throw new Error("HostDeck route handler started without request resource ownership.");
      state.handlerStarted = true;
      try {
        const result = originalHandler.call(this, request, reply);
        if (result instanceof Promise) {
          return result.finally(() => settleHandler(state));
        }
        settleHandler(state);
        return result;
      } catch (error) {
        settleHandler(state);
        throw error;
      }
    };
  });
}

function installSurfaceRoutePolicy(app: HostDeckFastifyInstance, surface: HostDeckRoutePluginSurface): void {
  app.addHook("onRoute", (routeOptions) => {
    if (surface === "api") assertHostDeckApiResponseSchemas(routeOptions.schema);
    if (surface !== "static" && (routeOptions.attachValidation === true || routeOptions.errorHandler !== undefined)) {
      throw new TypeError(`HostDeck ${surface} routes cannot replace global validation or error handling.`);
    }
  });
}

function installRequestPolicy(app: HostDeckFastifyInstance, runtime: AppRuntimeState): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const rawUrl = request.raw.url ?? request.url;
    if (Buffer.byteLength(rawUrl, "utf8") > runtime.resourceBudget.http_url_max_bytes) {
      return sendHostDeckError(reply, request, 414, {
        code: "malformed_request",
        message: "Request target exceeds its configured limit.",
        retryable: false
      });
    }

    const contentType = request.headers["content-type"];
    if (contentType !== undefined && (typeof contentType !== "string" || !jsonContentTypePattern.test(contentType))) {
      return sendHostDeckError(reply, request, 415, {
        code: "unsupported_media_type",
        message: "Request content type is not supported.",
        retryable: false
      });
    }

    if (runtime.inFlightRequests >= runtime.resourceBudget.http_max_in_flight_requests) {
      runtime.rejectedOverloadRequests += 1;
      return sendHostDeckError(reply, request, 503, {
        code: "service_overloaded",
        message: "Request capacity is exhausted.",
        retryable: false
      });
    }

    runtime.inFlightRequests += 1;
    try {
      (request as RequestWithRuntimeState)[requestRuntimeState] = {
        deadline: createOperationDeadlineView({
          timeoutMs: request.routeOptions.handlerTimeout ?? runtime.resourceBudget.http_request_deadline_ms,
          signal: request.signal
        }),
        finalized: false,
        handlerStarted: false,
        handlerSettled: false,
        owner: runtime,
        responseFinished: false
      };
    } catch (error) {
      runtime.inFlightRequests -= 1;
      throw error;
    }
  });

  app.addHook("preValidation", async (request, reply) => {
    if (hasOversizedRouteParameter(request.params, runtime.resourceBudget.http_route_param_max_bytes)) {
      return sendHostDeckError(reply, request, 414, {
        code: "validation_error",
        message: "Route parameter exceeds its configured limit.",
        retryable: false,
        field: "params"
      });
    }
  });

  app.addHook("onResponse", async (request) => {
    finishResponse(request);
  });
  app.addHook("onRequestAbort", async (request) => {
    finishResponse(request);
  });
  app.addHook("onTimeout", async (request) => {
    finishResponse(request);
  });
}

function installNotFoundPolicy(app: HostDeckFastifyInstance, runtime: AppRuntimeState): void {
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    if (Buffer.byteLength(rawUrl, "utf8") > runtime.resourceBudget.http_url_max_bytes) {
      return sendHostDeckError(reply, request, 414, {
        code: "malformed_request",
        message: "Request target exceeds its configured limit.",
        retryable: false
      });
    }

    const allowedMethods = allowedMethodsForUrl(app, runtime.registeredMethods, request.method, rawUrl);
    if (allowedMethods.length > 0) {
      reply.header("allow", allowedMethods.join(", "));
      return sendHostDeckError(reply, request, 405, {
        code: "method_not_allowed",
        message: "Request method is not allowed for this route.",
        retryable: false
      });
    }
    return sendHostDeckError(reply, request, 404, {
      code: "route_not_found",
      message: "Route not found.",
      retryable: false
    });
  });
}

function assertFactoryInput(input: unknown): asserts input is CreateHostDeckFastifyAppInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("HostDeck Fastify app input must be an object.");
  }
  const keys = Object.keys(input).sort();
  const expected = ["observeInternalError", "resourceBudget", "routePlugins"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("HostDeck Fastify app input fields are invalid.");
  }
  const candidate = input as Partial<CreateHostDeckFastifyAppInput>;
  if (!Array.isArray(candidate.routePlugins)) throw new TypeError("HostDeck routePlugins must be an array.");
  if (typeof candidate.observeInternalError !== "function") {
    throw new TypeError("HostDeck observeInternalError must be a function.");
  }
}

function parseRoutePluginRegistrations(
  input: readonly HostDeckRoutePluginRegistration[]
): readonly HostDeckRoutePluginRegistration[] {
  if (input.length > 64) throw new TypeError("HostDeck supports at most 64 explicit route plugins.");
  const ids = new Set<string>();
  const parsed: HostDeckRoutePluginRegistration[] = [];
  for (const candidate of input) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("HostDeck route plugin registration must be an object.");
    }
    const keys = Object.keys(candidate).sort();
    if (keys.length !== 3 || keys[0] !== "id" || keys[1] !== "register" || keys[2] !== "surface") {
      throw new TypeError("HostDeck route plugin registration fields are invalid.");
    }
    if (typeof candidate.id !== "string" || !routePluginIdPattern.test(candidate.id)) {
      throw new TypeError("HostDeck route plugin id is invalid.");
    }
    if (ids.has(candidate.id)) throw new TypeError(`HostDeck route plugin id "${candidate.id}" is duplicated.`);
    if (typeof candidate.register !== "function") throw new TypeError("HostDeck route plugin register must be a function.");
    if (!(hostDeckRoutePluginSurfaces as readonly unknown[]).includes(candidate.surface)) {
      throw new TypeError("HostDeck route plugin surface is invalid.");
    }
    ids.add(candidate.id);
    parsed.push(Object.freeze({ id: candidate.id, register: candidate.register, surface: candidate.surface }));
  }
  return Object.freeze(parsed);
}

function enforceRouteCeiling(value: number | undefined, maximum: number, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`Fastify route ${label} must be a positive integer no greater than ${maximum}.`);
  }
}

function hasOversizedRouteParameter(params: unknown, maximumBytes: number): boolean {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return false;
  return Object.values(params).some(
    (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") > maximumBytes
  );
}

function finishResponse(request: import("fastify").FastifyRequest): void {
  const state = (request as RequestWithRuntimeState)[requestRuntimeState];
  if (state === undefined) return;
  state.responseFinished = true;
  if (!state.handlerStarted || state.handlerSettled) finalizeRequest(state);
}

function settleHandler(state: RequestRuntimeState): void {
  state.handlerSettled = true;
  if (state.responseFinished) finalizeRequest(state);
}

function finalizeRequest(state: RequestRuntimeState): void {
  if (state.finalized) return;
  state.finalized = true;
  state.deadline.dispose();
  if (state.owner.inFlightRequests < 1) throw new Error("HostDeck in-flight request accounting underflowed.");
  state.owner.inFlightRequests -= 1;
}

function allowedMethodsForUrl(
  app: HostDeckFastifyInstance,
  registeredMethods: ReadonlySet<string>,
  requestMethod: string,
  url: string
): string[] {
  try {
    if (app.findRoute({ method: requestMethod.toUpperCase() as HTTPMethods, url }) !== null) return [];
  } catch {
    return [];
  }
  const allowed: string[] = [];
  for (const method of registeredMethods) {
    if (method === requestMethod.toUpperCase()) continue;
    try {
      if (app.findRoute({ method: method as HTTPMethods, url }) !== null) allowed.push(method);
    } catch {
      return [];
    }
  }
  return allowed.sort((left, right) => methodRank(left) - methodRank(right) || left.localeCompare(right));
}

function methodRank(method: string): number {
  const index = methodOrder.indexOf(method as (typeof methodOrder)[number]);
  return index === -1 ? methodOrder.length : index;
}
