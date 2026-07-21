import type { AddressInfo, Socket } from "node:net";
import {
  assertResolvedResourceBudget,
  type ResourceBudget
} from "@hostdeck/contracts";
import {
  createOperationDeadline,
  type OperationDeadline,
  OperationDeadlineExceededError
} from "@hostdeck/core";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import type { HostDeckInternalErrorObserver } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { fastifyResourceOptionsFromBudget } from "./fastify-resource-options.js";
import {
  assertHostDeckRemoteIngressLifecycle,
  type HostDeckRemoteIngressLifecycle
} from "./remote-ingress-lifecycle.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

export const hostDeckFastifyLifecyclePhases = [
  "ready",
  "draining",
  "closed",
  "failed"
] as const;
export type HostDeckFastifyLifecyclePhase = (typeof hostDeckFastifyLifecyclePhases)[number];

export const hostDeckFastifyLifecycleErrorCodes = [
  "runtime_start_failed",
  "runtime_contract_invalid",
  "route_composition_failed",
  "app_creation_failed",
  "app_ready_failed",
  "listener_bind_failed",
  "listener_mismatch",
  "remote_start_failed",
  "startup_timeout",
  "shutdown_failed"
] as const;
export type HostDeckFastifyLifecycleErrorCode =
  (typeof hostDeckFastifyLifecycleErrorCodes)[number];

export const hostDeckFastifyLifecycleStages = [
  "runtime",
  "runtime_contract",
  "routes",
  "app",
  "ready",
  "listen",
  "verify",
  "remote",
  "shutdown"
] as const;
export type HostDeckFastifyLifecycleStage =
  (typeof hostDeckFastifyLifecycleStages)[number];

export interface HostDeckFastifyListenerBind {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly transport: "http";
}

export interface HostDeckFastifyStartedRuntime<TContext> {
  readonly bind: HostDeckFastifyListenerBind;
  readonly context: TContext;
}

export interface HostDeckFastifyRuntimeOwner<TContext> {
  readonly beginDrain: () => void;
  readonly closeRuntime: (deadline: OperationDeadline) => void | Promise<void>;
  readonly closeSse: (deadline: OperationDeadline) => void | Promise<void>;
  readonly closeStartup: (deadline: OperationDeadline) => void | Promise<void>;
  readonly start: (
    input: HostDeckFastifyRuntimeStartInput
  ) => HostDeckFastifyStartedRuntime<TContext> | Promise<HostDeckFastifyStartedRuntime<TContext>>;
}

export interface HostDeckFastifyRuntimeStartInput {
  readonly deadline: OperationDeadline;
  readonly resourceBudget: ResourceBudget;
}

export interface StartHostDeckFastifyLifecycleInput<TContext> {
  readonly createRequestAuthenticationPolicy: (
    context: TContext
  ) => HostDeckRequestAuthenticationPolicy;
  readonly createRoutePlugins: (
    context: TContext
  ) => readonly HostDeckRoutePluginRegistration[];
  readonly observeInternalError: HostDeckInternalErrorObserver;
  readonly resourceBudget: ResourceBudget;
  readonly runtime: HostDeckFastifyRuntimeOwner<TContext>;
}

export interface StartHostDeckTailscaleServeFastifyLifecycleInput<TContext>
  extends StartHostDeckFastifyLifecycleInput<TContext> {
  readonly selectRemoteIngressLifecycle: (
    context: TContext
  ) => HostDeckRemoteIngressLifecycle;
}

export interface HostDeckFastifyNodeLimitSnapshot {
  readonly connections_check_interval_ms: number;
  readonly connection_idle_timeout_ms: number;
  readonly headers_max_bytes: number;
  readonly headers_max_count: number;
  readonly headers_parser_max_bytes: number;
  readonly headers_parser_max_count: number;
  readonly headers_timeout_ms: number;
  readonly keep_alive_timeout_buffer_ms: number;
  readonly keep_alive_timeout_ms: number;
  readonly max_connections: number;
  readonly max_requests_per_socket: number;
  readonly request_receive_timeout_ms: number;
}

export interface HostDeckFastifyConnectionSnapshot {
  readonly active_connections: number;
  readonly dropped_connections: number;
  readonly dropped_requests: number;
  readonly forced_shutdown_connections: number;
}

export interface HostDeckFastifyLifecycleSnapshot {
  readonly bound: HostDeckFastifyListenerBind | null;
  readonly configured: HostDeckFastifyListenerBind;
  readonly connections: HostDeckFastifyConnectionSnapshot;
  readonly listening: boolean;
  readonly node_limits: HostDeckFastifyNodeLimitSnapshot;
  readonly phase: HostDeckFastifyLifecyclePhase;
}

export interface HostDeckFastifyLifecycle<TContext> {
  readonly app: HostDeckFastifyInstance;
  readonly baseUrl: URL;
  readonly context: TContext;
  readonly close: () => Promise<void>;
  readonly snapshot: () => HostDeckFastifyLifecycleSnapshot;
}

export class HostDeckFastifyLifecycleError extends Error {
  readonly code: HostDeckFastifyLifecycleErrorCode;
  readonly stage: HostDeckFastifyLifecycleStage;

  constructor(
    code: HostDeckFastifyLifecycleErrorCode,
    stage: HostDeckFastifyLifecycleStage,
    message: string,
    cause: unknown
  ) {
    super(message, { cause });
    this.name = "HostDeckFastifyLifecycleError";
    this.code = code;
    this.stage = stage;
  }
}

type ParsedLifecycleInput<TContext> = StartHostDeckFastifyLifecycleInput<TContext>;

type ParsedTailscaleServeLifecycleInput<TContext> =
  StartHostDeckTailscaleServeFastifyLifecycleInput<TContext>;

type ParsedRuntimeOwner<TContext> = HostDeckFastifyRuntimeOwner<TContext>;

interface CleanupRuntimeOwner {
  readonly beginDrain: () => void;
  readonly closeRuntime: (deadline: OperationDeadline) => void | Promise<void>;
  readonly closeSse: (deadline: OperationDeadline) => void | Promise<void>;
  readonly closeStartup: (deadline: OperationDeadline) => void | Promise<void>;
}

interface PreparedLifecycleBoundary {
  readonly cleanupOwner: CleanupRuntimeOwner;
  readonly createApp: (
    requestAuthenticationPolicy: HostDeckRequestAuthenticationPolicy,
    routePlugins: readonly HostDeckRoutePluginRegistration[]
  ) => HostDeckFastifyInstance;
  readonly startAfterListen: () => void;
}

interface LifecycleBoundary<TContext> {
  readonly prepare: (
    owner: HostDeckFastifyStartedRuntime<TContext>
  ) => PreparedLifecycleBoundary;
}

interface HttpConnectionRuntime {
  readonly activeSockets: Set<Socket>;
  readonly emptyWaiters: Set<() => void>;
  droppedConnections: number;
  droppedRequests: number;
  forcedShutdownConnections: number;
}

type CleanupStep =
  | "drain"
  | "listener"
  | "sse"
  | "runtime"
  | "app"
  | "startup";

class HostDeckFastifyCleanupError extends Error {
  readonly step: CleanupStep;
  readonly timedOut: boolean;

  constructor(step: CleanupStep, timedOut: boolean, cause: unknown) {
    super(
      timedOut
        ? `HostDeck ${step} cleanup exceeded its configured deadline.`
        : `HostDeck ${step} cleanup failed.`,
      { cause }
    );
    this.name = "HostDeckFastifyCleanupError";
    this.step = step;
    this.timedOut = timedOut;
  }
}

const inputKeys = [
  "createRequestAuthenticationPolicy",
  "createRoutePlugins",
  "observeInternalError",
  "resourceBudget",
  "runtime"
];
const tailscaleServeInputKeys = [
  ...inputKeys,
  "selectRemoteIngressLifecycle"
];
const runtimeOwnerKeys = [
  "beginDrain",
  "closeRuntime",
  "closeSse",
  "closeStartup",
  "start"
];
const startedRuntimeKeys = ["bind", "context"];
const bindKeys = ["host", "port", "transport"];
const httpConnectionRuntimes = new WeakMap<HostDeckFastifyInstance, HttpConnectionRuntime>();

export async function startHostDeckFastifyLifecycle<TContext>(
  input: StartHostDeckFastifyLifecycleInput<TContext>
): Promise<HostDeckFastifyLifecycle<TContext>> {
  const parsed = parseLifecycleInput<TContext>(input);
  return startParsedLifecycle<TContext>(parsed, {
    prepare(owner: HostDeckFastifyStartedRuntime<TContext>) {
      return Object.freeze({
        cleanupOwner: parsed.runtime,
        createApp(
          requestAuthenticationPolicy: HostDeckRequestAuthenticationPolicy,
          routePlugins: readonly HostDeckRoutePluginRegistration[]
        ) {
          return createHostDeckFastifyApp({
            observeInternalError: parsed.observeInternalError,
            requestAuthenticationPolicy,
            requestTrustPolicy: createHostDeckRequestTrustPolicy({
              allowedOrigin: baseUrlForBind(owner.bind).origin
            }),
            resourceBudget: parsed.resourceBudget,
            routePlugins
          });
        },
        startAfterListen() {
          // The historical request-trust lifecycle has no post-listen owner.
        }
      });
    }
  });
}

export async function startHostDeckTailscaleServeFastifyLifecycle<TContext>(
  input: StartHostDeckTailscaleServeFastifyLifecycleInput<TContext>
): Promise<HostDeckFastifyLifecycle<TContext>> {
  const parsed = parseTailscaleServeLifecycleInput<TContext>(input);
  return startParsedLifecycle<TContext>(parsed, {
    prepare(owner: HostDeckFastifyStartedRuntime<TContext>) {
      const remote = parsed.selectRemoteIngressLifecycle(owner.context);
      assertHostDeckRemoteIngressLifecycle(remote);
      const cleanupOwner = composeRemoteCleanupOwner(
        parsed.runtime,
        remote,
        parsed.resourceBudget
      );
      return Object.freeze({
        cleanupOwner,
        createApp(
          requestAuthenticationPolicy: HostDeckRequestAuthenticationPolicy,
          routePlugins: readonly HostDeckRoutePluginRegistration[]
        ) {
          if (
            owner.bind.host !== "127.0.0.1" ||
            owner.bind.transport !== "http"
          ) {
            throw new TypeError(
              "HostDeck Tailscale Serve lifecycle requires IPv4 loopback HTTP."
            );
          }
          return createHostDeckTailscaleServeFastifyApp({
            observeInternalError: parsed.observeInternalError,
            remoteIngressRequestAuthority: remote.requestAuthority,
            requestAuthenticationPolicy,
            resourceBudget: parsed.resourceBudget,
            routePlugins,
            tailscaleServeProxyTrustPolicy:
              createTailscaleServeProxyTrustPolicy({
                localOrigin: baseUrlForBind(owner.bind).origin,
                readRemoteAdmission: remote.readAdmission
              })
          });
        },
        startAfterListen() {
          remote.start();
        }
      });
    }
  });
}

async function startParsedLifecycle<TContext>(
  parsed: ParsedLifecycleInput<TContext>,
  boundary: LifecycleBoundary<TContext>
): Promise<HostDeckFastifyLifecycle<TContext>> {
  assertResolvedResourceBudget(parsed.resourceBudget);
  const startupDeadline = createOperationDeadline({
    timeoutMs: parsed.resourceBudget.lifecycle_startup_timeout_ms
  });
  let stage: HostDeckFastifyLifecycleStage = "runtime";
  let app: HostDeckFastifyInstance | null = null;
  let cleanupOwner: CleanupRuntimeOwner = parsed.runtime;

  try {
    const runtimePromise = Promise.resolve().then(() =>
      parsed.runtime.start(
        Object.freeze({
          deadline: startupDeadline,
          resourceBudget: parsed.resourceBudget
        })
      )
    );
    const rawOwner = await awaitWithSignal(runtimePromise, startupDeadline.signal);
    stage = "runtime_contract";
    const owner = parseStartedRuntime<TContext>(rawOwner);
    const preparedBoundary = boundary.prepare(owner);
    cleanupOwner = preparedBoundary.cleanupOwner;

    startupDeadline.throwIfAborted();
    stage = "routes";
    const requestAuthenticationPolicy = parsed.createRequestAuthenticationPolicy(
      owner.context
    );
    assertHostDeckRequestAuthenticationPolicy(requestAuthenticationPolicy);
    const routePlugins = parsed.createRoutePlugins(owner.context);

    startupDeadline.throwIfAborted();
    stage = "app";
    app = preparedBoundary.createApp(
      requestAuthenticationPolicy,
      routePlugins
    );
    installHttpConnectionRuntime(app);
    applyNodeServerLimits(app, parsed.resourceBudget);

    stage = "ready";
    await awaitWithSignal(Promise.resolve(app.ready()), startupDeadline.signal);
    if (app.server.listening) {
      throw new TypeError("HostDeck Fastify app listened before explicit lifecycle binding.");
    }

    startupDeadline.throwIfAborted();
    stage = "listen";
    await awaitWithSignal(
      Promise.resolve(
        app.listen({
          host: owner.bind.host,
          port: owner.bind.port,
          listenTextResolver: () => ""
        })
      ),
      startupDeadline.signal
    );

    stage = "verify";
    const bound = requireMatchingBoundAddress(app, owner.bind);
    startupDeadline.throwIfAborted();
    stage = "remote";
    preparedBoundary.startAfterListen();
    const readyApp = app;
    let phase: HostDeckFastifyLifecyclePhase = "ready";
    let closePromise: Promise<void> | null = null;
    const snapshot = () =>
      createLifecycleSnapshot(readyApp, owner.bind, parsed.resourceBudget, phase);
    const close = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      phase = "draining";
      closePromise = (async () => {
        const errors = await closeLifecycleResources(
          readyApp,
          cleanupOwner,
          parsed.resourceBudget
        );
        if (errors.length > 0) {
          phase = "failed";
          throw new HostDeckFastifyLifecycleError(
            "shutdown_failed",
            "shutdown",
            "HostDeck Fastify lifecycle did not close cleanly.",
            new AggregateError(errors, "HostDeck Fastify cleanup failed.")
          );
        }
        phase = "closed";
      })();
      return closePromise;
    };

    return Object.freeze({
      app: readyApp,
      baseUrl: baseUrlForBind(bound),
      close,
      context: owner.context,
      snapshot
    });
  } catch (cause) {
    const cleanupErrors = await closeLifecycleResources(
      app,
      cleanupOwner,
      parsed.resourceBudget
    );
    throw createStartupError(stage, cause, startupDeadline.signal.aborted, cleanupErrors);
  } finally {
    startupDeadline.dispose();
  }
}

function parseLifecycleInput<TContext>(input: unknown): ParsedLifecycleInput<TContext> {
  assertPlainExactObject(input, inputKeys, "HostDeck Fastify lifecycle input");
  const value = input as Partial<StartHostDeckFastifyLifecycleInput<TContext>>;
  if (typeof value.createRequestAuthenticationPolicy !== "function") {
    throw new TypeError(
      "HostDeck Fastify createRequestAuthenticationPolicy must be a function."
    );
  }
  if (typeof value.createRoutePlugins !== "function") {
    throw new TypeError("HostDeck Fastify createRoutePlugins must be a function.");
  }
  if (typeof value.observeInternalError !== "function") {
    throw new TypeError("HostDeck Fastify observeInternalError must be a function.");
  }
  const runtime = parseRuntimeOwner<TContext>(value.runtime);
  return Object.freeze({
    createRequestAuthenticationPolicy:
      value.createRequestAuthenticationPolicy.bind(value),
    createRoutePlugins: value.createRoutePlugins.bind(value),
    observeInternalError: value.observeInternalError,
    resourceBudget: value.resourceBudget as ResourceBudget,
    runtime
  });
}

function parseTailscaleServeLifecycleInput<TContext>(
  input: unknown
): ParsedTailscaleServeLifecycleInput<TContext> {
  assertPlainExactObject(
    input,
    tailscaleServeInputKeys,
    "HostDeck Tailscale Serve Fastify lifecycle input"
  );
  const value = input as Partial<
    StartHostDeckTailscaleServeFastifyLifecycleInput<TContext>
  >;
  if (typeof value.createRequestAuthenticationPolicy !== "function") {
    throw new TypeError(
      "HostDeck Fastify createRequestAuthenticationPolicy must be a function."
    );
  }
  if (typeof value.createRoutePlugins !== "function") {
    throw new TypeError("HostDeck Fastify createRoutePlugins must be a function.");
  }
  if (typeof value.observeInternalError !== "function") {
    throw new TypeError("HostDeck Fastify observeInternalError must be a function.");
  }
  if (typeof value.selectRemoteIngressLifecycle !== "function") {
    throw new TypeError(
      "HostDeck Tailscale Serve remote lifecycle selector must be a function."
    );
  }
  const runtime = parseRuntimeOwner<TContext>(value.runtime);
  return Object.freeze({
    createRequestAuthenticationPolicy:
      value.createRequestAuthenticationPolicy.bind(value),
    createRoutePlugins: value.createRoutePlugins.bind(value),
    observeInternalError: value.observeInternalError,
    resourceBudget: value.resourceBudget as ResourceBudget,
    runtime,
    selectRemoteIngressLifecycle:
      value.selectRemoteIngressLifecycle.bind(value)
  });
}

function composeRemoteCleanupOwner(
  runtime: CleanupRuntimeOwner,
  remote: HostDeckRemoteIngressLifecycle,
  budget: ResourceBudget
): CleanupRuntimeOwner {
  return Object.freeze({
    beginDrain() {
      const errors: unknown[] = [];
      try {
        remote.beginDrain();
      } catch (error) {
        errors.push(error);
      }
      try {
        runtime.beginDrain();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "HostDeck remote and application admission drain failed."
        );
      }
    },
    closeRuntime: runtime.closeRuntime,
    closeSse: runtime.closeSse,
    async closeStartup(deadline: OperationDeadline) {
      const errors: unknown[] = [];
      const remoteDeadline = createOperationDeadline({
        timeoutMs: budget.lifecycle_cleanup_step_timeout_ms,
        parentSignal: deadline.signal
      });
      try {
        await remote.close(remoteDeadline);
      } catch (error) {
        errors.push(error);
      } finally {
        remoteDeadline.dispose();
      }
      try {
        await runtime.closeStartup(deadline);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "HostDeck remote and startup cleanup failed."
        );
      }
    }
  });
}

function parseRuntimeOwner<TContext>(input: unknown): ParsedRuntimeOwner<TContext> {
  assertPlainExactObject(input, runtimeOwnerKeys, "HostDeck Fastify runtime owner");
  const value = input as Partial<HostDeckFastifyRuntimeOwner<TContext>>;
  if (
    typeof value.beginDrain !== "function" ||
    typeof value.closeRuntime !== "function" ||
    typeof value.closeSse !== "function" ||
    typeof value.closeStartup !== "function" ||
    typeof value.start !== "function"
  ) {
    throw new TypeError(
      "HostDeck Fastify runtime owner requires start, drain, SSE-close, runtime-close, and startup-close functions."
    );
  }
  return Object.freeze({
    beginDrain: value.beginDrain.bind(value),
    closeRuntime: value.closeRuntime.bind(value),
    closeSse: value.closeSse.bind(value),
    closeStartup: value.closeStartup.bind(value),
    start: value.start.bind(value)
  });
}

function parseStartedRuntime<TContext>(input: unknown): HostDeckFastifyStartedRuntime<TContext> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("HostDeck Fastify started runtime must be an object.");
  }
  const value = input as Partial<HostDeckFastifyStartedRuntime<TContext>>;
  const bind = parseListenerBind(value.bind);
  assertPlainExactObject(
    input,
    startedRuntimeKeys,
    "HostDeck Fastify started runtime"
  );
  return Object.freeze({ bind, context: value.context as TContext });
}

function parseListenerBind(input: unknown): HostDeckFastifyListenerBind {
  assertPlainExactObject(input, bindKeys, "HostDeck Fastify listener bind");
  const value = input as Partial<HostDeckFastifyListenerBind>;
  if (value.host !== "127.0.0.1" || value.transport !== "http") {
    throw new TypeError(
      "HostDeck listener must use exact IPv4 loopback HTTP."
    );
  }
  const port = value.port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new TypeError("HostDeck Fastify listener port must be an integer from 1024 through 65535.");
  }
  return Object.freeze({ host: "127.0.0.1", port, transport: "http" });
}

function assertPlainExactObject(input: unknown, expectedKeys: readonly string[], label: string): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function installHttpConnectionRuntime(app: HostDeckFastifyInstance): void {
  if (httpConnectionRuntimes.has(app)) throw new Error("HostDeck HTTP connection runtime is already installed.");
  const runtime: HttpConnectionRuntime = {
    activeSockets: new Set<Socket>(),
    droppedConnections: 0,
    droppedRequests: 0,
    emptyWaiters: new Set<() => void>(),
    forcedShutdownConnections: 0
  };
  httpConnectionRuntimes.set(app, runtime);
  app.server.on("connection", (socket) => {
    runtime.activeSockets.add(socket);
    socket.once("close", () => {
      runtime.activeSockets.delete(socket);
      if (runtime.activeSockets.size === 0) {
        for (const waiter of [...runtime.emptyWaiters]) waiter();
      }
    });
  });
  app.server.on("drop", () => {
    runtime.droppedConnections += 1;
  });
  app.server.on("dropRequest", () => {
    runtime.droppedRequests += 1;
  });
}

function applyNodeServerLimits(app: HostDeckFastifyInstance, budget: ResourceBudget): void {
  const limits = fastifyResourceOptionsFromBudget(budget).node;
  app.server.headersTimeout = limits.headersTimeout;
  app.server.keepAliveTimeoutBuffer = limits.keepAliveTimeoutBuffer;
  app.server.maxConnections = limits.maxConnections;
  app.server.maxHeadersCount = limits.parserMaxHeadersCount;
  if (
    app.server.headersTimeout !== limits.headersTimeout ||
    app.server.keepAliveTimeoutBuffer !== limits.keepAliveTimeoutBuffer ||
    app.server.maxConnections !== limits.maxConnections ||
    requireAppliedMaxHeaderSize(app) !== limits.parserMaxHeaderSize ||
    app.server.maxHeadersCount !== limits.parserMaxHeadersCount ||
    app.server.keepAliveTimeout !== budget.http_keep_alive_timeout_ms ||
    app.server.maxRequestsPerSocket !== budget.http_max_requests_per_socket ||
    app.server.requestTimeout !== budget.http_request_receive_timeout_ms ||
    app.server.timeout !== budget.http_connection_idle_timeout_ms
  ) {
    throw new TypeError("HostDeck Node HTTP resource limits did not apply exactly.");
  }
}

function requireMatchingBoundAddress(
  app: HostDeckFastifyInstance,
  configured: HostDeckFastifyListenerBind
): HostDeckFastifyListenerBind {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("HostDeck Fastify listener did not expose a TCP address.");
  }
  if (address.address !== configured.host || address.port !== configured.port) {
    throw new TypeError("HostDeck Fastify listener address differs from validated startup policy.");
  }
  return Object.freeze({
    host: configured.host,
    port: address.port,
    transport: configured.transport
  });
}

function createLifecycleSnapshot(
  app: HostDeckFastifyInstance,
  configured: HostDeckFastifyListenerBind,
  budget: ResourceBudget,
  phase: HostDeckFastifyLifecyclePhase
): HostDeckFastifyLifecycleSnapshot {
  const address = app.server.address();
  const bound = toBoundAddress(address, configured.transport);
  return Object.freeze({
    bound,
    configured,
    connections: connectionSnapshot(app),
    listening: app.server.listening,
    node_limits: Object.freeze({
      connections_check_interval_ms: fastifyResourceOptionsFromBudget(budget).node.connectionsCheckingInterval,
      connection_idle_timeout_ms: app.server.timeout,
      headers_max_bytes: budget.http_headers_max_bytes,
      headers_max_count: budget.http_headers_max_count,
      headers_parser_max_bytes: requireAppliedMaxHeaderSize(app),
      headers_parser_max_count: requireAppliedInteger(app.server.maxHeadersCount, "maxHeadersCount"),
      headers_timeout_ms: app.server.headersTimeout,
      keep_alive_timeout_buffer_ms: app.server.keepAliveTimeoutBuffer,
      keep_alive_timeout_ms: app.server.keepAliveTimeout,
      max_connections: app.server.maxConnections,
      max_requests_per_socket: requireAppliedInteger(
        app.server.maxRequestsPerSocket,
        "maxRequestsPerSocket"
      ),
      request_receive_timeout_ms: app.server.requestTimeout
    }),
    phase
  });
}

function connectionSnapshot(app: HostDeckFastifyInstance): HostDeckFastifyConnectionSnapshot {
  const runtime = requireHttpConnectionRuntime(app);
  return Object.freeze({
    active_connections: runtime.activeSockets.size,
    dropped_connections: runtime.droppedConnections,
    dropped_requests: runtime.droppedRequests,
    forced_shutdown_connections: runtime.forcedShutdownConnections
  });
}

function requireHttpConnectionRuntime(app: HostDeckFastifyInstance): HttpConnectionRuntime {
  const runtime = httpConnectionRuntimes.get(app);
  if (runtime === undefined) throw new Error("HostDeck HTTP connection runtime is unavailable.");
  return runtime;
}

function toBoundAddress(
  address: AddressInfo | string | null,
  transport: "http"
): HostDeckFastifyListenerBind | null {
  if (
    address === null ||
    typeof address === "string" ||
    address.address !== "127.0.0.1"
  ) {
    return null;
  }
  return Object.freeze({ host: "127.0.0.1", port: address.port, transport });
}

function baseUrlForBind(bind: HostDeckFastifyListenerBind): URL {
  return new URL(`http://127.0.0.1:${bind.port}/`);
}

function requireAppliedMaxHeaderSize(app: HostDeckFastifyInstance): number {
  const server = app.server as typeof app.server & { readonly maxHeaderSize?: unknown };
  return requireAppliedInteger(server.maxHeaderSize, "maxHeaderSize");
}

function requireAppliedInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`HostDeck Node HTTP ${name} is not applied.`);
  }
  return value;
}

async function closeLifecycleResources(
  app: HostDeckFastifyInstance | null,
  owner: CleanupRuntimeOwner,
  budget: ResourceBudget
): Promise<HostDeckFastifyCleanupError[]> {
  const errors: HostDeckFastifyCleanupError[] = [];
  const shutdownDeadline = createOperationDeadline({
    timeoutMs: budget.lifecycle_shutdown_timeout_ms
  });
  let listenerClose: Promise<void> | null = null;
  try {
    const drainError = runSynchronousCleanupStep("drain", owner.beginDrain);
    if (drainError !== null) errors.push(drainError);

    if (app !== null) {
      try {
        listenerClose = beginListenerClose(app);
        void listenerClose.catch(() => undefined);
      } catch (cause) {
        errors.push(new HostDeckFastifyCleanupError("listener", false, cause));
      }
    }

    const sseError = await runCleanupStep(
      "sse",
      owner.closeSse,
      shutdownDeadline,
      budget.sse_shutdown_timeout_ms
    );
    if (sseError !== null) errors.push(sseError);

    const runtimeError = await runCleanupStep(
      "runtime",
      owner.closeRuntime,
      shutdownDeadline,
      budget.lifecycle_shutdown_timeout_ms
    );
    if (runtimeError !== null) errors.push(runtimeError);

    if (app !== null) {
      try {
        app.server.closeIdleConnections();
      } catch (cause) {
        errors.push(new HostDeckFastifyCleanupError("listener", false, cause));
      }
    }

    if (listenerClose !== null && app !== null) {
      const listenerApp = app;
      const listenerCompletion = listenerClose;
      const listenerError = await runCleanupStep(
        "listener",
        (deadline) =>
          waitForListenerCloseWithForce(
            listenerApp,
            listenerCompletion,
            deadline
          ),
        shutdownDeadline,
        budget.lifecycle_cleanup_step_timeout_ms
      );
      if (listenerError !== null) errors.push(listenerError);
    }

    if (app !== null) {
      const appError = await runCleanupStep(
        "app",
        () => app.close(),
        shutdownDeadline,
        budget.lifecycle_cleanup_step_timeout_ms
      );
      if (appError !== null) errors.push(appError);
    }

    const startupError = await runCleanupStep(
      "startup",
      owner.closeStartup,
      shutdownDeadline,
      budget.lifecycle_shutdown_timeout_ms
    );
    if (startupError !== null) errors.push(startupError);
  } finally {
    shutdownDeadline.dispose();
  }
  return errors;
}

function runSynchronousCleanupStep(
  step: "drain",
  operation: () => void
): HostDeckFastifyCleanupError | null {
  try {
    const result: unknown = operation();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError("HostDeck drain cleanup must complete synchronously.");
    }
    return null;
  } catch (cause) {
    return new HostDeckFastifyCleanupError(step, false, cause);
  }
}

function beginListenerClose(app: HostDeckFastifyInstance): Promise<void> {
  if (!app.server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    app.server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForListenerCloseWithForce(
  app: HostDeckFastifyInstance,
  completion: Promise<void>,
  deadline: OperationDeadline
): Promise<void> {
  const remainingMs = Math.max(1, Math.floor(deadline.remainingMs()));
  const forceReserveMs = Math.max(10, Math.min(100, Math.floor(remainingMs / 4)));
  const graceDeadline = createOperationDeadline({
    timeoutMs: Math.max(1, remainingMs - forceReserveMs),
    parentSignal: deadline.signal
  });
  let gracefulCause: unknown = null;
  let gracefulTimedOut = false;
  try {
    await waitForListenerClose(app, completion, graceDeadline.signal);
    await waitForHttpConnectionsClosed(app, graceDeadline.signal);
    return;
  } catch (cause) {
    gracefulCause = cause;
    gracefulTimedOut =
      graceDeadline.signal.aborted &&
      !deadline.signal.aborted &&
      graceDeadline.signal.reason instanceof OperationDeadlineExceededError;
  } finally {
    graceDeadline.dispose();
  }

  try {
    forceCloseHttpConnections(app);
  } catch (forceCause) {
    throw new AggregateError([gracefulCause, forceCause], "HostDeck listener grace and forced close failed.");
  }
  if (deadline.signal.aborted) throw gracefulCause;
  try {
    await waitForListenerClose(app, completion, deadline.signal);
    await waitForHttpConnectionsClosed(app, deadline.signal);
  } catch (forceCause) {
    throw new AggregateError([gracefulCause, forceCause], "HostDeck listener did not close after forced cleanup.");
  }
  if (!gracefulTimedOut) throw gracefulCause;
}

function forceCloseHttpConnections(app: HostDeckFastifyInstance): void {
  const runtime = requireHttpConnectionRuntime(app);
  runtime.forcedShutdownConnections += runtime.activeSockets.size;
  app.server.closeAllConnections();
}

function waitForHttpConnectionsClosed(app: HostDeckFastifyInstance, signal: AbortSignal): Promise<void> {
  const runtime = requireHttpConnectionRuntime(app);
  if (runtime.activeSockets.size === 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      runtime.emptyWaiters.delete(onEmpty);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onEmpty = () => finish(resolve);
    const onAbort = () => finish(() => reject(signal.reason));
    runtime.emptyWaiters.add(onEmpty);
    signal.addEventListener("abort", onAbort, { once: true });
    if (runtime.activeSockets.size === 0) onEmpty();
  });
}

function waitForListenerClose(
  app: HostDeckFastifyInstance,
  completion: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(idleReaper);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const reapIdleConnections = () => {
      try {
        app.server.closeIdleConnections();
      } catch (cause) {
        finish(() => reject(cause));
      }
    };
    const idleReaper = setInterval(reapIdleConnections, 10);
    idleReaper.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      () => finish(resolve),
      (cause) => finish(() => reject(cause))
    );
    reapIdleConnections();
  });
}

async function runCleanupStep(
  step: CleanupStep,
  operation: (deadline: OperationDeadline) => void | Promise<void>,
  shutdownDeadline: OperationDeadline,
  maximumMs: number
): Promise<HostDeckFastifyCleanupError | null> {
  const remainingMs = shutdownDeadline.signal.aborted
    ? 1
    : Math.max(1, Math.ceil(shutdownDeadline.remainingMs()));
  const stepDeadline = createOperationDeadline({
    timeoutMs: Math.max(1, Math.min(maximumMs, remainingMs)),
    parentSignal: shutdownDeadline.signal
  });
  try {
    let result: void | Promise<void>;
    try {
      result = operation(stepDeadline);
    } catch (cause) {
      return new HostDeckFastifyCleanupError(
        step,
        isCleanupTimeout(cause, stepDeadline),
        cause
      );
    }
    try {
      await awaitWithSignal(Promise.resolve(result), stepDeadline.signal);
      return null;
    } catch (cause) {
      return new HostDeckFastifyCleanupError(
        step,
        isCleanupTimeout(cause, stepDeadline),
        cause
      );
    }
  } finally {
    stepDeadline.dispose();
  }
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause))
    );
    if (signal.aborted) onAbort();
  });
}

function isCleanupTimeout(
  cause: unknown,
  deadline: OperationDeadline
): boolean {
  return (
    cause instanceof OperationDeadlineExceededError ||
    deadline.signal.reason instanceof OperationDeadlineExceededError
  );
}

function createStartupError(
  stage: HostDeckFastifyLifecycleStage,
  cause: unknown,
  timedOut: boolean,
  cleanupErrors: readonly HostDeckFastifyCleanupError[]
): HostDeckFastifyLifecycleError {
  const code = timedOut ? "startup_timeout" : errorCodeForStage(stage);
  const message = timedOut
    ? "HostDeck Fastify startup exceeded its configured deadline."
    : startupMessageForStage(stage);
  const combinedCause =
    cleanupErrors.length === 0
      ? cause
      : new AggregateError([cause, ...cleanupErrors], "HostDeck Fastify startup and cleanup failed.");
  return new HostDeckFastifyLifecycleError(code, stage, message, combinedCause);
}

function errorCodeForStage(
  stage: HostDeckFastifyLifecycleStage
): HostDeckFastifyLifecycleErrorCode {
  switch (stage) {
    case "runtime":
      return "runtime_start_failed";
    case "runtime_contract":
      return "runtime_contract_invalid";
    case "routes":
      return "route_composition_failed";
    case "app":
      return "app_creation_failed";
    case "ready":
      return "app_ready_failed";
    case "listen":
      return "listener_bind_failed";
    case "verify":
      return "listener_mismatch";
    case "remote":
      return "remote_start_failed";
    case "shutdown":
      return "shutdown_failed";
  }
}

function startupMessageForStage(stage: HostDeckFastifyLifecycleStage): string {
  switch (stage) {
    case "runtime":
      return "HostDeck runtime startup failed.";
    case "runtime_contract":
      return "HostDeck runtime startup returned an invalid ownership contract.";
    case "routes":
      return "HostDeck route composition failed.";
    case "app":
      return "HostDeck Fastify app creation failed.";
    case "ready":
      return "HostDeck Fastify app failed readiness.";
    case "listen":
      return "HostDeck Fastify listener failed to bind.";
    case "verify":
      return "HostDeck Fastify listener bound outside validated startup policy.";
    case "remote":
      return "HostDeck remote ingress lifecycle failed to start.";
    case "shutdown":
      return "HostDeck Fastify shutdown failed.";
  }
}
