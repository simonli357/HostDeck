import {
  assertResolvedResourceBudget,
  type ResourceBudget
} from "@hostdeck/contracts";
import type { CodexRuntimeProcessExitObservation } from "./codex-runtime-supervisor.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  type HostDeckFastifyLifecycle,
  type HostDeckFastifyLifecycleSnapshot,
  type StartHostDeckTailscaleServeFastifyLifecycleInput,
  startHostDeckTailscaleServeFastifyLifecycle
} from "./fastify-host-lifecycle.js";
import {
  createHostDeckStaticBoundaryRegistration,
  hostDeckStaticBoundaryLimits
} from "./fastify-static-boundary.js";
import {
  type HostDeckForegroundResources,
  type StartHostDeckForegroundResourcesInput,
  startHostDeckForegroundResources
} from "./foreground-resource-bootstrap.js";
import type { HostDeckRemoteHealthSnapshot } from "./host-health.js";
import {
  type CreateHostDeckProductionApplicationInput,
  createHostDeckProductionApplication,
  type HostDeckProductionApplication,
  type HostDeckProductionApplicationSnapshot,
  hostDeckProductionApplicationIssueSources,
  hostDeckProductionStaticRegistrationId
} from "./production-application-composition.js";

export const hostDeckProductionForegroundServePhases = Object.freeze([
  "ready",
  "draining",
  "closed",
  "failed"
] as const);
export type HostDeckProductionForegroundServePhase =
  (typeof hostDeckProductionForegroundServePhases)[number];

export const hostDeckProductionForegroundServeTerminationTriggers =
  Object.freeze([
    "manual",
    "caller_abort",
    "sigint",
    "sigterm",
    "runtime_exit",
    "runtime_exit_observation_failed"
  ] as const);
export type HostDeckProductionForegroundServeTerminationTrigger =
  (typeof hostDeckProductionForegroundServeTerminationTriggers)[number];

export const hostDeckProductionForegroundServeIssueSources = Object.freeze([
  ...hostDeckProductionApplicationIssueSources,
  "http",
  "serve"
] as const);
export type HostDeckProductionForegroundServeIssueSource =
  (typeof hostDeckProductionForegroundServeIssueSources)[number];

export const hostDeckProductionForegroundServeErrorCodes = Object.freeze([
  "invalid_input",
  "signal_ownership_failed",
  "resource_start_failed",
  "application_composition_failed",
  "listener_start_failed",
  "readiness_failed",
  "startup_aborted",
  "shutdown_failed"
] as const);
export type HostDeckProductionForegroundServeErrorCode =
  (typeof hostDeckProductionForegroundServeErrorCodes)[number];

export const hostDeckProductionForegroundServeErrorStages = Object.freeze([
  "preflight",
  "signals",
  "resources",
  "application",
  "listener",
  "readiness",
  "shutdown"
] as const);
export type HostDeckProductionForegroundServeErrorStage =
  (typeof hostDeckProductionForegroundServeErrorStages)[number];

export type HostDeckProcessTerminationSignal = "SIGINT" | "SIGTERM";

export interface HostDeckProductionForegroundServeIssue {
  readonly source: HostDeckProductionForegroundServeIssueSource;
  readonly code: string;
}

export interface StartHostDeckProductionForegroundServeInput
  extends StartHostDeckForegroundResourcesInput {
  readonly browser_routes: readonly `/${string}`[];
  readonly observe_issue: (
    issue: HostDeckProductionForegroundServeIssue
  ) => void;
  readonly static_build_root: string;
}

export interface HostDeckProductionForegroundServeSnapshot {
  readonly phase: HostDeckProductionForegroundServePhase;
  readonly termination_trigger: HostDeckProductionForegroundServeTerminationTrigger | null;
  readonly application: HostDeckProductionApplicationSnapshot;
  readonly listener: HostDeckFastifyLifecycleSnapshot;
  readonly listener_health: "not_ready" | "ready" | "draining" | "closed" | "failed";
  readonly remote_phase: "idle" | "running" | "draining" | "closed" | "failed";
  readonly remote_availability: HostDeckRemoteHealthSnapshot["availability"];
  readonly remote_reason: HostDeckRemoteHealthSnapshot["reason"];
  readonly reported_issue_count: number;
  readonly observer_failure_count: number;
  readonly last_issue: HostDeckProductionForegroundServeIssue | null;
}

export interface HostDeckProductionForegroundServe {
  readonly local_origin: string;
  readonly close: () => Promise<void>;
  readonly snapshot: () => HostDeckProductionForegroundServeSnapshot;
  readonly terminated: Promise<HostDeckProductionForegroundServeSnapshot>;
}

export interface HostDeckProductionForegroundServeDependencies {
  readonly create_application?: (
    input: CreateHostDeckProductionApplicationInput
  ) => HostDeckProductionApplication;
  readonly start_fastify_lifecycle?: (
    input: StartHostDeckTailscaleServeFastifyLifecycleInput<HostDeckProductionApplication>,
    startupSignal?: AbortSignal
  ) => Promise<HostDeckFastifyLifecycle<HostDeckProductionApplication>>;
  readonly start_foreground_resources?: (
    input: StartHostDeckForegroundResourcesInput
  ) => Promise<HostDeckForegroundResources>;
  readonly subscribe_termination_signals?: (
    listener: (signal: HostDeckProcessTerminationSignal) => void
  ) => () => void;
}

export class HostDeckProductionForegroundServeError extends Error {
  constructor(
    readonly code: HostDeckProductionForegroundServeErrorCode,
    readonly stage: HostDeckProductionForegroundServeErrorStage,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckProductionForegroundServeError";
  }
}

interface ParsedServeInput {
  readonly browserRoutes: readonly `/${string}`[];
  readonly codexBin: string;
  readonly configDir: string;
  readonly databasePath: string;
  readonly loopbackPort: number;
  readonly observeIssue: StartHostDeckProductionForegroundServeInput["observe_issue"];
  readonly resourceBudget: ResourceBudget;
  readonly runtimeDir: string;
  readonly signal: AbortSignal | undefined;
  readonly stateDir: string;
  readonly staticBuildRoot: string;
}

interface ParsedServeDependencies {
  readonly createApplication: NonNullable<
    HostDeckProductionForegroundServeDependencies["create_application"]
  >;
  readonly startFastifyLifecycle: NonNullable<
    HostDeckProductionForegroundServeDependencies["start_fastify_lifecycle"]
  >;
  readonly startForegroundResources: NonNullable<
    HostDeckProductionForegroundServeDependencies["start_foreground_resources"]
  >;
  readonly subscribeTerminationSignals: NonNullable<
    HostDeckProductionForegroundServeDependencies["subscribe_termination_signals"]
  >;
}

interface ServeIssueRuntime {
  count: number;
  observerFailures: number;
  last: HostDeckProductionForegroundServeIssue | null;
}

const acceptedForegroundServeOwners = new WeakSet<object>();
const inputKeys = [
  "browser_routes",
  "codex_bin",
  "config_dir",
  "database_path",
  "loopback_port",
  "observe_issue",
  "resource_budget",
  "runtime_dir",
  "signal",
  "state_dir",
  "static_build_root"
] as const;
const requiredInputKeys = inputKeys.filter((key) => key !== "signal");
const dependencyKeys = [
  "create_application",
  "start_fastify_lifecycle",
  "start_foreground_resources",
  "subscribe_termination_signals"
] as const;
const issueCodePattern = /^[a-z][a-z0-9_]{0,119}$/u;
const maximumCounter = Number.MAX_SAFE_INTEGER;

export async function startHostDeckProductionForegroundServe(
  input: StartHostDeckProductionForegroundServeInput,
  dependencies: HostDeckProductionForegroundServeDependencies = {}
): Promise<HostDeckProductionForegroundServe> {
  let parsed: ParsedServeInput;
  let ports: ParsedServeDependencies;
  try {
    parsed = parseServeInput(input);
    ports = parseServeDependencies(dependencies);
  } catch (cause) {
    throw serveError(
      "invalid_input",
      "preflight",
      "HostDeck production foreground serve input is invalid.",
      cause
    );
  }
  if (parsed.signal?.aborted === true) {
    throw serveError(
      "startup_aborted",
      "preflight",
      "HostDeck production foreground serve startup was aborted.",
      parsed.signal.reason
    );
  }

  const issues: ServeIssueRuntime = {
    count: 0,
    observerFailures: 0,
    last: null
  };
  const report = createIssueReporter(parsed.observeIssue, issues);
  const startupController = new AbortController();
  let stage: HostDeckProductionForegroundServeErrorStage = "signals";
  let terminationTrigger: HostDeckProductionForegroundServeTerminationTrigger | null = null;
  let fatalTermination = false;
  let resources: HostDeckForegroundResources | null = null;
  let application: HostDeckProductionApplication | null = null;
  let lifecycle: HostDeckFastifyLifecycle<HostDeckProductionApplication> | null = null;
  let unsubscribeSignals: (() => void) | null = null;
  let callerAbortListener: (() => void) | null = null;
  let startAutomaticClose: (() => void) | null = null;

  const requestTermination = (
    trigger: HostDeckProductionForegroundServeTerminationTrigger,
    fatal: boolean
  ): void => {
    if (terminationTrigger === null) terminationTrigger = trigger;
    fatalTermination ||= fatal;
    if (!startupController.signal.aborted) {
      startupController.abort(
        new HostDeckProductionForegroundServeError(
          "startup_aborted",
          stage,
          "HostDeck production foreground serve termination was requested."
        )
      );
    }
    startAutomaticClose?.();
  };

  try {
    if (parsed.signal !== undefined) {
      const onCallerAbort = () => requestTermination("caller_abort", false);
      parsed.signal.addEventListener("abort", onCallerAbort, { once: true });
      callerAbortListener = () =>
        parsed.signal?.removeEventListener("abort", onCallerAbort);
      if (parsed.signal.aborted) onCallerAbort();
    }
    unsubscribeSignals = ports.subscribeTerminationSignals((signal) => {
      requestTermination(signal === "SIGINT" ? "sigint" : "sigterm", false);
    });
    if (typeof unsubscribeSignals !== "function") {
      throw new TypeError(
        "HostDeck termination-signal subscription did not return cleanup ownership."
      );
    }
    startupController.signal.throwIfAborted();

    stage = "resources";
    resources = await ports.startForegroundResources({
      codex_bin: parsed.codexBin,
      config_dir: parsed.configDir,
      database_path: parsed.databasePath,
      loopback_port: parsed.loopbackPort,
      resource_budget: parsed.resourceBudget,
      runtime_dir: parsed.runtimeDir,
      signal: startupController.signal,
      state_dir: parsed.stateDir
    });
    const processExit = requireProcessExitObservation(resources);
    void processExit.then(
      (observation) => {
        if (observation.expected || isClosingPhase(application, lifecycle)) {
          return;
        }
        report("serve", "runtime_exit");
        attemptListenerFailure(application, report);
        requestTermination("runtime_exit", true);
      },
      () => {
        if (isClosingPhase(application, lifecycle)) return;
        report("serve", "runtime_exit_observation_failed");
        attemptListenerFailure(application, report);
        requestTermination("runtime_exit_observation_failed", true);
      }
    );
    startupController.signal.throwIfAborted();

    stage = "application";
    application = ports.createApplication({
      browser_routes: parsed.browserRoutes,
      observe_issue: (issue) => report(issue.source, issue.code),
      resources,
      static_build_root: parsed.staticBuildRoot
    });

    stage = "listener";
    lifecycle = await ports.startFastifyLifecycle(
      {
        createRequestAuthenticationPolicy: (context) =>
          context.authentication,
        createRoutePlugins: (context) => context.route_registrations,
        observeInternalError: (observation) =>
          reportHttpIssue(observation, report),
        resourceBudget: parsed.resourceBudget,
        runtime: application.runtime,
        selectRemoteIngressLifecycle: (context) => context.remote
      },
      startupController.signal
    );
    startupController.signal.throwIfAborted();

    stage = "readiness";
    application.listener.ready();
    assertReadyProductionServe(resources, application, lifecycle);

    const owner = createForegroundServeOwner({
      application,
      fatalTermination: () => fatalTermination,
      issues,
      lifecycle,
      localOrigin: lifecycle.baseUrl.origin,
      releaseSignalOwnership: () => {
        const errors: unknown[] = [];
        try {
          callerAbortListener?.();
        } catch (error) {
          errors.push(error);
        } finally {
          callerAbortListener = null;
        }
        try {
          unsubscribeSignals?.();
        } catch (error) {
          errors.push(error);
        } finally {
          unsubscribeSignals = null;
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            "HostDeck termination-signal cleanup failed."
          );
        }
      },
      report,
      requestShutdownAbort: () => {
        if (!startupController.signal.aborted) {
          startupController.abort(
            new HostDeckProductionForegroundServeError(
              "startup_aborted",
              "shutdown",
              "HostDeck production foreground serve is shutting down."
            )
          );
        }
      },
      resources,
      terminationTrigger: () => terminationTrigger,
      setManualTermination: () => {
        if (terminationTrigger === null) terminationTrigger = "manual";
      }
    });
    startAutomaticClose = () => {
      void owner.close().catch(() => undefined);
    };
    if (startupController.signal.aborted) {
      startAutomaticClose();
      throw startupController.signal.reason;
    }
    acceptedForegroundServeOwners.add(owner);
    return owner;
  } catch (cause) {
    const startupWasAborted =
      terminationTrigger !== null || startupController.signal.aborted;
    if (!startupController.signal.aborted) {
      startupController.abort(
        new HostDeckProductionForegroundServeError(
          "startup_aborted",
          stage,
          "HostDeck production foreground serve startup failed."
        )
      );
    }
    const cleanupErrors: unknown[] = [];
    if (lifecycle !== null) {
      try {
        await lifecycle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (resources !== null) {
      try {
        await resources.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      callerAbortListener?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      unsubscribeSignals?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    const primary = createStartupServeError(
      stage,
      cause,
      startupWasAborted
    );
    if (cleanupErrors.length === 0) throw primary;
    throw serveError(
      primary.code,
      primary.stage,
      primary.message,
      new AggregateError(
        [primary, ...cleanupErrors],
        "HostDeck production foreground serve startup cleanup failed."
      )
    );
  }
}

export function assertHostDeckProductionForegroundServe(
  candidate: unknown
): asserts candidate is HostDeckProductionForegroundServe {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedForegroundServeOwners.has(candidate)
  ) {
    throw new TypeError(
      "HostDeck production foreground serve owner must be created by its factory."
    );
  }
}

export function subscribeHostDeckProcessTerminationSignals(
  listener: (signal: HostDeckProcessTerminationSignal) => void
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError(
      "HostDeck process termination listener must be a function."
    );
  }
  const onSigint = () => listener("SIGINT");
  const onSigterm = () => listener("SIGTERM");
  let subscribed = false;
  try {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    subscribed = true;
  } catch (error) {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    throw error;
  }
  let closed = false;
  return () => {
    if (closed || !subscribed) return;
    closed = true;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
}

function createForegroundServeOwner(input: {
  readonly application: HostDeckProductionApplication;
  readonly fatalTermination: () => boolean;
  readonly issues: ServeIssueRuntime;
  readonly lifecycle: HostDeckFastifyLifecycle<HostDeckProductionApplication>;
  readonly localOrigin: string;
  readonly releaseSignalOwnership: () => void;
  readonly report: (
    source: HostDeckProductionForegroundServeIssueSource,
    code: string
  ) => void;
  readonly requestShutdownAbort: () => void;
  readonly resources: HostDeckForegroundResources;
  readonly terminationTrigger: () => HostDeckProductionForegroundServeTerminationTrigger | null;
  readonly setManualTermination: () => void;
}): HostDeckProductionForegroundServe {
  let phase: HostDeckProductionForegroundServePhase = "ready";
  let closePromise: Promise<void> | null = null;
  let resolveTerminated!: (
    snapshot: HostDeckProductionForegroundServeSnapshot
  ) => void;
  const terminated = new Promise<HostDeckProductionForegroundServeSnapshot>(
    (resolve) => {
      resolveTerminated = resolve;
    }
  );
  const snapshot = (): HostDeckProductionForegroundServeSnapshot =>
    (() => {
      const remoteHealth = input.application.health.remoteSnapshot();
      return Object.freeze({
        phase,
        termination_trigger: input.terminationTrigger(),
        application: input.application.snapshot(),
        listener: input.lifecycle.snapshot(),
        listener_health: input.application.listener.snapshot(),
        remote_phase: input.application.remote.snapshot().phase,
        remote_availability: remoteHealth.availability,
        remote_reason: remoteHealth.reason,
        reported_issue_count: input.issues.count,
        observer_failure_count: input.issues.observerFailures,
        last_issue: input.issues.last
      });
    })();
  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    input.setManualTermination();
    if (phase === "ready") phase = "draining";
    input.requestShutdownAbort();
    closePromise = (async () => {
      const errors: unknown[] = [];
      try {
        await input.lifecycle.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await input.resources.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        input.releaseSignalOwnership();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        phase = "failed";
        input.report("serve", "shutdown_failed");
      } else {
        phase = input.fatalTermination() ? "failed" : "closed";
      }
      resolveTerminated(snapshot());
      if (errors.length > 0) {
        throw serveError(
          "shutdown_failed",
          "shutdown",
          "HostDeck production foreground serve did not close cleanly.",
          new AggregateError(
            errors,
            "HostDeck production foreground serve cleanup failed."
          )
        );
      }
    })();
    void closePromise.catch(() => undefined);
    return closePromise;
  };
  const owner: HostDeckProductionForegroundServe = Object.freeze({
    close,
    local_origin: input.localOrigin,
    snapshot,
    terminated
  });
  return owner;
}

function parseServeInput(input: unknown): ParsedServeInput {
  const values = readAllowedDataObject(
    input,
    inputKeys,
    requiredInputKeys,
    "HostDeck production foreground serve input"
  );
  const stringKeys = [
    "codex_bin",
    "config_dir",
    "database_path",
    "runtime_dir",
    "state_dir",
    "static_build_root"
  ] as const;
  for (const key of stringKeys) {
    if (typeof values[key] !== "string") {
      throw new TypeError(
        "HostDeck production foreground serve path input is invalid."
      );
    }
  }
  if (
    typeof values.loopback_port !== "number" ||
    !Number.isSafeInteger(values.loopback_port)
  ) {
    throw new TypeError(
      "HostDeck production foreground serve port is invalid."
    );
  }
  if (typeof values.observe_issue !== "function") {
    throw new TypeError(
      "HostDeck production foreground serve issue observer is invalid."
    );
  }
  assertResolvedResourceBudget(values.resource_budget as ResourceBudget);
  if (
    values.signal !== undefined &&
    !(values.signal instanceof AbortSignal)
  ) {
    throw new TypeError(
      "HostDeck production foreground serve signal is invalid."
    );
  }
  const browserRoutes = copyBrowserRoutes(values.browser_routes);
  createHostDeckStaticBoundaryRegistration({
    browserRoutes,
    buildRoot: values.static_build_root as string,
    id: hostDeckProductionStaticRegistrationId
  });
  return Object.freeze({
    browserRoutes,
    codexBin: values.codex_bin as string,
    configDir: values.config_dir as string,
    databasePath: values.database_path as string,
    loopbackPort: values.loopback_port,
    observeIssue:
      values.observe_issue as StartHostDeckProductionForegroundServeInput["observe_issue"],
    resourceBudget: values.resource_budget as ResourceBudget,
    runtimeDir: values.runtime_dir as string,
    signal: values.signal as AbortSignal | undefined,
    stateDir: values.state_dir as string,
    staticBuildRoot: values.static_build_root as string
  });
}

function parseServeDependencies(
  input: unknown
): ParsedServeDependencies {
  const values = readAllowedDataObject(
    input,
    dependencyKeys,
    [],
    "HostDeck production foreground serve dependencies"
  );
  const createApplication =
    values.create_application ?? createHostDeckProductionApplication;
  const startFastifyLifecycle =
    values.start_fastify_lifecycle ??
    startHostDeckTailscaleServeFastifyLifecycle;
  const startForegroundResources =
    values.start_foreground_resources ?? startHostDeckForegroundResources;
  const subscribeTerminationSignals =
    values.subscribe_termination_signals ??
    subscribeHostDeckProcessTerminationSignals;
  if (
    typeof createApplication !== "function" ||
    typeof startFastifyLifecycle !== "function" ||
    typeof startForegroundResources !== "function" ||
    typeof subscribeTerminationSignals !== "function"
  ) {
    throw new TypeError(
      "HostDeck production foreground serve dependencies are invalid."
    );
  }
  return Object.freeze({
    createApplication:
      createApplication as ParsedServeDependencies["createApplication"],
    startFastifyLifecycle:
      startFastifyLifecycle as ParsedServeDependencies["startFastifyLifecycle"],
    startForegroundResources:
      startForegroundResources as ParsedServeDependencies["startForegroundResources"],
    subscribeTerminationSignals:
      subscribeTerminationSignals as ParsedServeDependencies["subscribeTerminationSignals"]
  });
}

function copyBrowserRoutes(input: unknown): readonly `/${string}`[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) {
    throw new TypeError(
      "HostDeck production foreground serve browser routes are invalid."
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > hostDeckStaticBoundaryLimits.maxBrowserRoutes
  ) {
    throw new TypeError(
      "HostDeck production foreground serve browser routes are invalid."
    );
  }
  const expectedKeys = new Set<PropertyKey>([
    "length",
    ...Array.from({ length }, (_, index) => String(index))
  ]);
  if (
    Reflect.ownKeys(descriptors).length !== expectedKeys.size ||
    Reflect.ownKeys(descriptors).some((key) => !expectedKeys.has(key))
  ) {
    throw new TypeError(
      "HostDeck production foreground serve browser routes are invalid."
    );
  }
  const routes: `/${string}`[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError(
        "HostDeck production foreground serve browser routes are invalid."
      );
    }
    routes.push(descriptor.value as `/${string}`);
  }
  return Object.freeze(routes);
}

function readAllowedDataObject<
  const TAllowed extends string,
  const TRequired extends TAllowed
>(
  input: unknown,
  allowedKeys: readonly TAllowed[],
  requiredKeys: readonly TRequired[],
  label: string
): Readonly<Record<TAllowed, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(allowedKeys as readonly string[]).includes(key)
      ) ||
      requiredKeys.some((key) => !(key in descriptors))
    ) {
      throw new TypeError();
    }
    const output = Object.create(null) as Record<TAllowed, unknown>;
    for (const key of allowedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        output[key] = undefined;
        continue;
      }
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError();
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function createIssueReporter(
  observer: StartHostDeckProductionForegroundServeInput["observe_issue"],
  runtime: ServeIssueRuntime
): (
  source: HostDeckProductionForegroundServeIssueSource,
  code: string
) => void {
  return (source, code) => {
    const issue = Object.freeze({
      source,
      code: issueCodePattern.test(code) ? code : "internal_error"
    });
    runtime.count = increment(runtime.count);
    runtime.last = issue;
    try {
      const result: unknown = observer(issue);
      if (isPromiseLike(result)) {
        runtime.observerFailures = increment(runtime.observerFailures);
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      runtime.observerFailures = increment(runtime.observerFailures);
    }
  };
}

function reportHttpIssue(
  observation: HostDeckInternalErrorObservation,
  report: (
    source: HostDeckProductionForegroundServeIssueSource,
    code: string
  ) => void
): void {
  report(
    "http",
    observation.framework_code === undefined
      ? "internal_error"
      : "framework_error"
  );
}

function requireProcessExitObservation(
  resources: HostDeckForegroundResources
): Promise<CodexRuntimeProcessExitObservation> {
  const processExit = resources.runtime.process_exit;
  if (processExit === null || !isPromiseLike(processExit)) {
    throw new TypeError(
      "HostDeck foreground runtime requires one process-exit observation."
    );
  }
  return Promise.resolve(processExit);
}

function assertReadyProductionServe(
  resources: HostDeckForegroundResources,
  application: HostDeckProductionApplication,
  lifecycle: HostDeckFastifyLifecycle<HostDeckProductionApplication>
): void {
  const resourceSnapshot = resources.snapshot();
  const applicationSnapshot = application.snapshot();
  const listenerSnapshot = lifecycle.snapshot();
  const localHealth = application.health.localSnapshot();
  const remoteSnapshot = application.remote.snapshot();
  if (
    lifecycle.context !== application ||
    lifecycle.baseUrl.origin !==
      `http://${application.bind.host}:${application.bind.port}` ||
    resourceSnapshot.phase !== "ready" ||
    !resourceSnapshot.database_open ||
    !resourceSnapshot.lease_held ||
    applicationSnapshot.phase !== "runtime_ready" ||
    application.listener.snapshot() !== "ready" ||
    localHealth.readiness !== "ready" ||
    localHealth.mutation_admission !== "open" ||
    listenerSnapshot.phase !== "ready" ||
    !listenerSnapshot.listening ||
    listenerSnapshot.bound?.host !== "127.0.0.1" ||
    listenerSnapshot.bound.port !== application.bind.port ||
    listenerSnapshot.bound.transport !== "http" ||
    remoteSnapshot.phase !== "running"
  ) {
    throw new TypeError(
      "HostDeck production foreground serve readiness is inconsistent."
    );
  }
}

function attemptListenerFailure(
  application: HostDeckProductionApplication | null,
  report: (
    source: HostDeckProductionForegroundServeIssueSource,
    code: string
  ) => void
): void {
  if (application === null) return;
  try {
    application.listener.failed();
  } catch {
    report("serve", "listener_failure_update_failed");
  }
}

function isClosingPhase(
  application: HostDeckProductionApplication | null,
  lifecycle: HostDeckFastifyLifecycle<HostDeckProductionApplication> | null
): boolean {
  const applicationPhase = application?.snapshot().phase;
  const listenerPhase = lifecycle?.snapshot().phase;
  return (
    applicationPhase === "draining" ||
    applicationPhase === "closed" ||
    listenerPhase === "draining" ||
    listenerPhase === "closed"
  );
}

function createStartupServeError(
  stage: HostDeckProductionForegroundServeErrorStage,
  cause: unknown,
  aborted: boolean
): HostDeckProductionForegroundServeError {
  if (cause instanceof HostDeckProductionForegroundServeError) return cause;
  if (aborted) {
    return serveError(
      "startup_aborted",
      stage,
      "HostDeck production foreground serve startup was aborted.",
      cause
    );
  }
  switch (stage) {
    case "signals":
      return serveError(
        "signal_ownership_failed",
        stage,
        "HostDeck production foreground serve could not own termination signals.",
        cause
      );
    case "resources":
      return serveError(
        "resource_start_failed",
        stage,
        "HostDeck production foreground resources failed to start.",
        cause
      );
    case "application":
      return serveError(
        "application_composition_failed",
        stage,
        "HostDeck production application composition failed.",
        cause
      );
    case "listener":
      return serveError(
        "listener_start_failed",
        stage,
        "HostDeck production listener failed to start.",
        cause
      );
    case "readiness":
      return serveError(
        "readiness_failed",
        stage,
        "HostDeck production foreground serve readiness failed.",
        cause
      );
    case "preflight":
      return serveError(
        "invalid_input",
        stage,
        "HostDeck production foreground serve input is invalid.",
        cause
      );
    case "shutdown":
      return serveError(
        "shutdown_failed",
        stage,
        "HostDeck production foreground serve did not close cleanly.",
        cause
      );
  }
}

function serveError(
  code: HostDeckProductionForegroundServeErrorCode,
  stage: HostDeckProductionForegroundServeErrorStage,
  message: string,
  cause: unknown
): HostDeckProductionForegroundServeError {
  return new HostDeckProductionForegroundServeError(code, stage, message, {
    cause
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function increment(value: number): number {
  return value < maximumCounter ? value + 1 : value;
}
