import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  assertResolvedResourceBudget,
  type ResourceBudget
} from "@hostdeck/contracts";
import { createOperationDeadlineView, type OperationDeadline } from "@hostdeck/core";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
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
import {
  assertHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy,
  installHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  assertHostDeckRequestTrustPolicy,
  type HostDeckRequestTrustPolicy,
  installHostDeckRequestTrustGate
} from "./fastify-request-trust.js";
import { fastifyResourceOptionsFromBudget } from "./fastify-resource-options.js";
import {
  assertHostDeckApiResponseSchemas,
  assertHostDeckRouteSchemas,
  type HostDeckZodTypeProvider,
  installHostDeckZodCompilers
} from "./fastify-zod.js";
import {
  assertHostDeckLanTlsInput,
  type HostDeckLanTlsInput
} from "./lan-certificate-policy.js";
import {
  assertTailscaleServeProxyTrustPolicy,
  type TailscaleServeProxyTrustPolicy
} from "./tailscale-serve-proxy-trust.js";
import { installTailscaleServeRequestAuthorization } from "./tailscale-serve-request-authorization.js";

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

export const hostDeckNoStoreRouteConfig = Object.freeze({
  hostDeckNoStore: true as const
});

export interface CreateHostDeckFastifyAppInput {
  readonly resourceBudget: ResourceBudget;
  readonly requestAuthenticationPolicy: HostDeckRequestAuthenticationPolicy;
  readonly requestTrustPolicy: HostDeckRequestTrustPolicy;
  readonly routePlugins: readonly HostDeckRoutePluginRegistration[];
  readonly observeInternalError: HostDeckInternalErrorObserver;
  readonly tls?: HostDeckLanTlsInput;
}

export interface CreateHostDeckTailscaleServeFastifyAppInput {
  readonly resourceBudget: ResourceBudget;
  readonly requestAuthenticationPolicy: HostDeckRequestAuthenticationPolicy;
  readonly routePlugins: readonly HostDeckRoutePluginRegistration[];
  readonly observeInternalError: HostDeckInternalErrorObserver;
  readonly tailscaleServeProxyTrustPolicy: TailscaleServeProxyTrustPolicy;
}

export interface HostDeckFastifyResourceSnapshot {
  readonly aborted_requests: number;
  readonly in_flight_requests: number;
  readonly max_in_flight_requests: number;
  readonly rejected_header_count_requests: number;
  readonly rejected_overload_requests: number;
  readonly timed_out_requests: number;
}

interface AppRuntimeState {
  readonly registeredMethods: Set<string>;
  readonly resourceBudget: ResourceBudget;
  abortedRequests: number;
  inFlightRequests: number;
  rejectedHeaderCountRequests: number;
  rejectedOverloadRequests: number;
  timedOutRequests: number;
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
  assertHostDeckRequestAuthenticationPolicy(input.requestAuthenticationPolicy);
  assertHostDeckRequestTrustPolicy(input.requestTrustPolicy);
  return createHostDeckFastifyAppWithRequestBoundary(input, (app) => {
    installHostDeckRequestTrustGate(
      app,
      input.requestTrustPolicy,
      input.observeInternalError
    );
    installHostDeckRequestAuthentication(app, input.requestAuthenticationPolicy);
  });
}

export function createHostDeckTailscaleServeFastifyApp(
  input: CreateHostDeckTailscaleServeFastifyAppInput
): HostDeckFastifyInstance {
  assertTailscaleServeFactoryInput(input);
  assertResolvedResourceBudget(input.resourceBudget);
  assertHostDeckRequestAuthenticationPolicy(input.requestAuthenticationPolicy);
  assertTailscaleServeProxyTrustPolicy(input.tailscaleServeProxyTrustPolicy);
  return createHostDeckFastifyAppWithRequestBoundary(input, (app) => {
    installTailscaleServeRequestAuthorization(
      app,
      input.tailscaleServeProxyTrustPolicy,
      input.requestAuthenticationPolicy,
      input.observeInternalError
    );
  });
}

function createHostDeckFastifyAppWithRequestBoundary(
  input: Omit<CreateHostDeckFastifyAppInput, "requestTrustPolicy">,
  installRequestBoundary: (app: HostDeckFastifyInstance) => void
): HostDeckFastifyInstance {
  const registrations = parseRoutePluginRegistrations(input.routePlugins);
  const resourceOptions = fastifyResourceOptionsFromBudget(input.resourceBudget);
  const commonOptions = {
    ...resourceOptions.factory,
    frameworkErrors: (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply
    ) =>
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
  } as const;
  const nodeOptions = {
    connectionsCheckingInterval: resourceOptions.node.connectionsCheckingInterval,
    keepAliveTimeoutBuffer: resourceOptions.node.keepAliveTimeoutBuffer,
    maxHeaderSize: resourceOptions.node.parserMaxHeaderSize
  } as const;
  const rawApp =
    input.tls === undefined
      ? Fastify({ ...commonOptions, http: nodeOptions })
      : Fastify({
          ...commonOptions,
          https: {
            ...nodeOptions,
            cert: input.tls.tls.certificate_chain_pem,
            key: input.tls.tls.private_key_pem,
            minVersion: "TLSv1.2"
          }
        });
  const app = rawApp.withTypeProvider<HostDeckZodTypeProvider>() as HostDeckFastifyInstance;
  const runtime: AppRuntimeState = {
    abortedRequests: 0,
    inFlightRequests: 0,
    registeredMethods: new Set<string>(),
    rejectedHeaderCountRequests: 0,
    rejectedOverloadRequests: 0,
    resourceBudget: input.resourceBudget,
    timedOutRequests: 0
  };
  appRuntimeStates.set(app, runtime);

  installHostDeckZodCompilers(app);
  installHostDeckErrorPolicy(app, input.observeInternalError);
  app.removeContentTypeParser("text/plain");
  installRoutePolicy(app, runtime);
  installRequestPolicy(app, runtime);
  installRequestBoundary(app);
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
    aborted_requests: runtime.abortedRequests,
    in_flight_requests: runtime.inFlightRequests,
    max_in_flight_requests: runtime.resourceBudget.http_max_in_flight_requests,
    rejected_header_count_requests: runtime.rejectedHeaderCountRequests,
    rejected_overload_requests: runtime.rejectedOverloadRequests,
    timed_out_requests: runtime.timedOutRequests
  });
}

function installRoutePolicy(app: HostDeckFastifyInstance, runtime: AppRuntimeState): void {
  app.addHook("onRoute", (routeOptions) => {
    assertHostDeckRouteSchemas(routeOptions.schema);
    if (routeOptions.validatorCompiler !== undefined || routeOptions.serializerCompiler !== undefined) {
      throw new TypeError("HostDeck routes cannot replace the global Zod compilers.");
    }
    enforceRouteCeiling(routeOptions.bodyLimit, runtime.resourceBudget.http_body_max_bytes, "bodyLimit");
    enforceRouteHandlerTimeout(
      routeOptions.handlerTimeout,
      runtime.resourceBudget.http_request_receive_timeout_ms,
      runtime.resourceBudget.http_request_deadline_ms
    );
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
    applyPreAdmissionResponsePolicy(request, reply);
    reply.header("x-request-id", request.id);
    if (rawHeaderCount(request.raw.rawHeaders) > runtime.resourceBudget.http_headers_max_count) {
      runtime.rejectedHeaderCountRequests += 1;
      reply.header("connection", "close");
      return sendHostDeckError(reply, request, 431, {
        code: "malformed_request",
        message: "Request header count exceeds its configured limit.",
        retryable: false
      });
    }
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
    finishTerminatedRequest(request, "abort");
  });
  app.addHook("onTimeout", async (request) => {
    finishTerminatedRequest(request, "timeout");
  });
}

function applyPreAdmissionResponsePolicy(
  request: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply
): void {
  const config: unknown = request.routeOptions.config;
  if (config === null || typeof config !== "object") return;
  const descriptor = Object.getOwnPropertyDescriptor(config, "hostDeckNoStore");
  if (descriptor === undefined || !("value" in descriptor) || descriptor.value !== true) {
    return;
  }
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
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
  const expected = [
    "observeInternalError",
    "requestAuthenticationPolicy",
    "requestTrustPolicy",
    "resourceBudget",
    "routePlugins"
  ];
  const expectedWithTls = [...expected, "tls"].sort();
  if (
    (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])) &&
    (keys.length !== expectedWithTls.length ||
      keys.some((key, index) => key !== expectedWithTls[index]))
  ) {
    throw new TypeError("HostDeck Fastify app input fields are invalid.");
  }
  const candidate = input as Partial<CreateHostDeckFastifyAppInput>;
  if (candidate.tls !== undefined) assertHostDeckLanTlsInput(candidate.tls);
  if (!Array.isArray(candidate.routePlugins)) throw new TypeError("HostDeck routePlugins must be an array.");
  if (typeof candidate.observeInternalError !== "function") {
    throw new TypeError("HostDeck observeInternalError must be a function.");
  }
}

function assertTailscaleServeFactoryInput(
  input: unknown
): asserts input is CreateHostDeckTailscaleServeFastifyAppInput {
  const expected = [
    "observeInternalError",
    "requestAuthenticationPolicy",
    "resourceBudget",
    "routePlugins",
    "tailscaleServeProxyTrustPolicy"
  ] as const;
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError("HostDeck Tailscale Serve Fastify app input must be an object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length) {
    throw new TypeError("HostDeck Tailscale Serve Fastify app input fields are invalid.");
  }
  for (const key of keys) {
    if (typeof key !== "string" || !(expected as readonly string[]).includes(key)) {
      throw new TypeError("HostDeck Tailscale Serve Fastify app input fields are invalid.");
    }
  }
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("HostDeck Tailscale Serve Fastify app input fields are invalid.");
    }
  }
  const candidate = input as Partial<CreateHostDeckTailscaleServeFastifyAppInput>;
  if (!Array.isArray(candidate.routePlugins)) {
    throw new TypeError("HostDeck routePlugins must be an array.");
  }
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

function enforceRouteHandlerTimeout(value: number | undefined, receiveTimeout: number, maximum: number): void {
  if (value === undefined) return;
  enforceRouteCeiling(value, maximum, "handlerTimeout");
  if (value <= receiveTimeout) {
    throw new TypeError(`Fastify route handlerTimeout must be greater than the ${receiveTimeout}ms request receive timeout.`);
  }
}

function hasOversizedRouteParameter(params: unknown, maximumBytes: number): boolean {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return false;
  return Object.values(params).some(
    (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") > maximumBytes
  );
}

function rawHeaderCount(rawHeaders: readonly string[]): number {
  if (rawHeaders.length % 2 !== 0) throw new Error("Node HTTP raw headers have an invalid key/value shape.");
  return rawHeaders.length / 2;
}

function finishTerminatedRequest(
  request: import("fastify").FastifyRequest,
  reason: "abort" | "timeout"
): void {
  const state = (request as RequestWithRuntimeState)[requestRuntimeState];
  if (state !== undefined && !state.responseFinished) {
    if (reason === "abort") state.owner.abortedRequests += 1;
    else state.owner.timedOutRequests += 1;
  }
  finishResponse(request);
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
