import type { AddressInfo } from "node:net";
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
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import type { HostDeckInternalErrorObserver } from "./fastify-error-policy.js";
import { fastifyResourceOptionsFromBudget } from "./fastify-resource-options.js";

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
  "shutdown"
] as const;
export type HostDeckFastifyLifecycleStage =
  (typeof hostDeckFastifyLifecycleStages)[number];

export interface HostDeckFastifyListenerBind {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly transport: "http";
}

export interface HostDeckFastifyStartedRuntime<TContext> {
  readonly bind: HostDeckFastifyListenerBind;
  readonly context: TContext;
}

export interface HostDeckFastifyRuntimeOwner<TContext> {
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
  readonly createRoutePlugins: (
    context: TContext
  ) => readonly HostDeckRoutePluginRegistration[];
  readonly observeInternalError: HostDeckInternalErrorObserver;
  readonly resourceBudget: ResourceBudget;
  readonly runtime: HostDeckFastifyRuntimeOwner<TContext>;
}

export interface HostDeckFastifyNodeLimitSnapshot {
  readonly connection_idle_timeout_ms: number;
  readonly headers_max_bytes: number;
  readonly headers_max_count: number;
  readonly headers_timeout_ms: number;
  readonly keep_alive_timeout_ms: number;
  readonly max_connections: number;
  readonly max_requests_per_socket: number;
  readonly request_receive_timeout_ms: number;
}

export interface HostDeckFastifyLifecycleSnapshot {
  readonly bound: HostDeckFastifyListenerBind | null;
  readonly configured: HostDeckFastifyListenerBind;
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

type ParsedRuntimeOwner<TContext> = HostDeckFastifyRuntimeOwner<TContext>;

interface CleanupRuntimeOwner {
  readonly closeSse: (deadline: OperationDeadline) => void | Promise<void>;
  readonly closeStartup: (deadline: OperationDeadline) => void | Promise<void>;
}

type CleanupStep = "listener" | "sse" | "app" | "startup";

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
  "createRoutePlugins",
  "observeInternalError",
  "resourceBudget",
  "runtime"
];
const runtimeOwnerKeys = ["closeSse", "closeStartup", "start"];
const startedRuntimeKeys = ["bind", "context"];
const bindKeys = ["host", "port", "transport"];

export async function startHostDeckFastifyLifecycle<TContext>(
  input: StartHostDeckFastifyLifecycleInput<TContext>
): Promise<HostDeckFastifyLifecycle<TContext>> {
  const parsed = parseLifecycleInput(input);
  assertResolvedResourceBudget(parsed.resourceBudget);
  const startupDeadline = createOperationDeadline({
    timeoutMs: parsed.resourceBudget.lifecycle_startup_timeout_ms
  });
  let stage: HostDeckFastifyLifecycleStage = "runtime";
  let app: HostDeckFastifyInstance | null = null;

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

    startupDeadline.throwIfAborted();
    stage = "routes";
    const routePlugins = parsed.createRoutePlugins(owner.context);

    startupDeadline.throwIfAborted();
    stage = "app";
    app = createHostDeckFastifyApp({
      observeInternalError: parsed.observeInternalError,
      resourceBudget: parsed.resourceBudget,
      routePlugins
    });
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
          parsed.runtime,
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
      parsed.runtime,
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
  if (typeof value.createRoutePlugins !== "function") {
    throw new TypeError("HostDeck Fastify createRoutePlugins must be a function.");
  }
  if (typeof value.observeInternalError !== "function") {
    throw new TypeError("HostDeck Fastify observeInternalError must be a function.");
  }
  const runtime = parseRuntimeOwner<TContext>(value.runtime);
  return Object.freeze({
    createRoutePlugins: value.createRoutePlugins.bind(value),
    observeInternalError: value.observeInternalError,
    resourceBudget: value.resourceBudget as ResourceBudget,
    runtime
  });
}

function parseRuntimeOwner<TContext>(input: unknown): ParsedRuntimeOwner<TContext> {
  assertPlainExactObject(input, runtimeOwnerKeys, "HostDeck Fastify runtime owner");
  const value = input as Partial<HostDeckFastifyRuntimeOwner<TContext>>;
  if (
    typeof value.closeSse !== "function" ||
    typeof value.closeStartup !== "function" ||
    typeof value.start !== "function"
  ) {
    throw new TypeError("HostDeck Fastify runtime owner requires start, SSE-close, and startup-close functions.");
  }
  return Object.freeze({
    closeSse: value.closeSse.bind(value),
    closeStartup: value.closeStartup.bind(value),
    start: value.start.bind(value)
  });
}

function parseStartedRuntime<TContext>(input: unknown): HostDeckFastifyStartedRuntime<TContext> {
  assertPlainExactObject(input, startedRuntimeKeys, "HostDeck Fastify started runtime");
  const value = input as Partial<HostDeckFastifyStartedRuntime<TContext>>;
  return Object.freeze({
    bind: parseListenerBind(value.bind),
    context: value.context as TContext
  });
}

function parseListenerBind(input: unknown): HostDeckFastifyListenerBind {
  assertPlainExactObject(input, bindKeys, "HostDeck Fastify listener bind");
  const value = input as Partial<HostDeckFastifyListenerBind>;
  if (value.transport !== "http") {
    throw new TypeError("HostDeck Fastify listener transport is unsupported before HTTPS selection.");
  }
  if (value.host !== "127.0.0.1" && value.host !== "::1") {
    throw new TypeError("HostDeck plaintext HTTP listener must use an explicit loopback address.");
  }
  const port = value.port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("HostDeck Fastify listener port must be an integer from 1 through 65535.");
  }
  return Object.freeze({ host: value.host, port, transport: "http" });
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

function applyNodeServerLimits(app: HostDeckFastifyInstance, budget: ResourceBudget): void {
  const limits = fastifyResourceOptionsFromBudget(budget).node;
  app.server.headersTimeout = limits.headersTimeout;
  app.server.maxConnections = limits.maxConnections;
  app.server.maxHeadersCount = limits.maxHeadersCount;
  if (
    app.server.headersTimeout !== limits.headersTimeout ||
    app.server.maxConnections !== limits.maxConnections ||
    app.server.maxHeadersCount !== limits.maxHeadersCount ||
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
    listening: app.server.listening,
    node_limits: Object.freeze({
      connection_idle_timeout_ms: app.server.timeout,
      headers_max_bytes: budget.http_headers_max_bytes,
      headers_max_count: requireAppliedInteger(app.server.maxHeadersCount, "maxHeadersCount"),
      headers_timeout_ms: app.server.headersTimeout,
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

function toBoundAddress(
  address: AddressInfo | string | null,
  transport: "http"
): HostDeckFastifyListenerBind | null {
  if (address === null || typeof address === "string") return null;
  if (address.address !== "127.0.0.1" && address.address !== "::1") return null;
  return Object.freeze({ host: address.address, port: address.port, transport });
}

function baseUrlForBind(bind: HostDeckFastifyListenerBind): URL {
  const host = bind.host === "::1" ? "[::1]" : bind.host;
  return new URL(`${bind.transport}://${host}:${bind.port}/`);
}

function requireAppliedInteger(value: number | null, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`HostDeck Node HTTP ${name} is not applied.`);
  }
  return value as number;
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
      Math.min(
        budget.lifecycle_cleanup_step_timeout_ms,
        budget.sse_shutdown_timeout_ms
      )
    );
    if (sseError !== null) errors.push(sseError);

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
          waitForListenerClose(
            listenerApp,
            listenerCompletion,
            deadline.signal
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
      budget.lifecycle_cleanup_step_timeout_ms
    );
    if (startupError !== null) errors.push(startupError);
  } finally {
    shutdownDeadline.dispose();
  }
  return errors;
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
      return new HostDeckFastifyCleanupError(step, false, cause);
    }
    try {
      await awaitWithSignal(Promise.resolve(result), stepDeadline.signal);
      return null;
    } catch (cause) {
      return new HostDeckFastifyCleanupError(
        step,
        stepDeadline.signal.aborted || cause instanceof OperationDeadlineExceededError,
        cause
      );
    }
  } finally {
    stepDeadline.dispose();
  }
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
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
  });
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
    case "shutdown":
      return "HostDeck Fastify shutdown failed.";
  }
}
