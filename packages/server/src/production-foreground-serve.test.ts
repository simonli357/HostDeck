import { defaultResourceBudget } from "@hostdeck/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRuntimeProcessExitObservation } from "./codex-runtime-supervisor.js";
import type {
  HostDeckFastifyLifecycle,
  HostDeckFastifyLifecycleSnapshot,
  StartHostDeckTailscaleServeFastifyLifecycleInput
} from "./fastify-host-lifecycle.js";
import type { HostDeckForegroundResources } from "./foreground-resource-bootstrap.js";
import type {
  HostDeckProductionApplication,
  HostDeckProductionApplicationSnapshot
} from "./production-application-composition.js";
import {
  assertHostDeckProductionForegroundServe,
  type HostDeckProcessTerminationSignal,
  type HostDeckProductionForegroundServeDependencies,
  HostDeckProductionForegroundServeError,
  type StartHostDeckProductionForegroundServeInput,
  startHostDeckProductionForegroundServe,
  subscribeHostDeckProcessTerminationSignals
} from "./production-foreground-serve.js";

const openHarnesses: FakeServeHarness[] = [];

afterEach(async () => {
  for (const harness of openHarnesses.splice(0).reverse()) {
    try {
      await harness.service?.close();
    } catch {
      // Individual failure tests assert their retained close error.
    }
  }
});

describe("IFC-V1-083 production foreground serve owner", () => {
  it("rejects hostile preflight data before signals or resources", async () => {
    const harness = createHarness();
    let accessorRead = false;
    const hostile = Object.defineProperty(
      { ...validInput() },
      "codex_bin",
      {
        enumerable: true,
        get() {
          accessorRead = true;
          return "/private/codex";
        }
      }
    );
    const cases: unknown[] = [
      { ...validInput(), unexpected: true },
      { ...validInput(), resource_budget: { ...defaultResourceBudget } },
      { ...validInput(), browser_routes: "/" },
      { ...validInput(), static_build_root: "relative/build" },
      hostile
    ];

    for (const candidate of cases) {
      const error = await expectServeFailure(
        startHostDeckProductionForegroundServe(
          candidate as StartHostDeckProductionForegroundServeInput,
          harness.dependencies
        )
      );
      expect(error).toMatchObject({ code: "invalid_input", stage: "preflight" });
    }
    expect(accessorRead).toBe(false);
    expect(harness.events).toEqual([]);
  });

  it("publishes one consistent ready owner and closes once in exact outer order", async () => {
    const harness = createHarness();
    const service = await harness.start();

    expect(Object.isFrozen(service)).toBe(true);
    expect(() => assertHostDeckProductionForegroundServe(service)).not.toThrow();
    expect(() =>
      assertHostDeckProductionForegroundServe(Object.freeze({ ...service }))
    ).toThrow(TypeError);
    expect(service.local_origin).toBe(`http://127.0.0.1:${harness.port}`);
    expect(service.snapshot()).toMatchObject({
      phase: "ready",
      termination_trigger: null,
      listener: { listening: true, phase: "ready" },
      listener_health: "ready",
      remote_phase: "running",
      reported_issue_count: 0,
      observer_failure_count: 0
    });
    expect(harness.events).toEqual([
      "signals:subscribe",
      "resources:start",
      "application:create",
      "listener:start",
      "listener:health-ready"
    ]);
    expect(harness.startupSignal).toBeInstanceOf(AbortSignal);
    expect(harness.startupSignal?.aborted).toBe(false);

    const firstClose = service.close();
    const secondClose = service.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    await expect(service.terminated).resolves.toMatchObject({
      phase: "closed",
      termination_trigger: "manual",
      listener_health: "closed",
      remote_phase: "closed"
    });
    expect(harness.events.slice(-5)).toEqual([
      "listener:close",
      "listener:health-draining",
      "listener:health-closed",
      "resources:close",
      "signals:unsubscribe"
    ]);
    expect(harness.resourceCloseCalls).toBe(1);
    expect(harness.listenerCloseCalls).toBe(1);
    expect(harness.signalUnsubscribeCalls).toBe(1);
  });

  it("coalesces repeated process signals and caller abort into one clean shutdown", async () => {
    const signalHarness = createHarness({ holdClose: true });
    const signaled = await signalHarness.start();
    signalHarness.emitSignal("SIGTERM");
    signalHarness.emitSignal("SIGINT");
    expect(signaled.snapshot()).toMatchObject({
      phase: "draining",
      termination_trigger: "sigterm"
    });
    signalHarness.releaseClose();
    await expect(signaled.terminated).resolves.toMatchObject({
      phase: "closed",
      termination_trigger: "sigterm"
    });
    expect(signalHarness.listenerCloseCalls).toBe(1);

    const caller = new AbortController();
    const callerHarness = createHarness();
    const callerService = await callerHarness.start({ signal: caller.signal });
    caller.abort(new Error("private caller abort"));
    await expect(callerService.terminated).resolves.toMatchObject({
      phase: "closed",
      termination_trigger: "caller_abort"
    });
    expect(callerHarness.listenerCloseCalls).toBe(1);
  });

  it("marks unexpected child exit failure, fails listener health, and removes residue", async () => {
    const harness = createHarness();
    const issues: unknown[] = [];
    const service = await harness.start({
      observe_issue: (issue) => issues.push(issue)
    });
    harness.resolveProcessExit({
      kind: "exited",
      expected: false,
      code: 17,
      signal: null
    });

    await expect(service.terminated).resolves.toMatchObject({
      phase: "failed",
      termination_trigger: "runtime_exit",
      listener_health: "failed",
      reported_issue_count: 1,
      last_issue: { source: "serve", code: "runtime_exit" }
    });
    expect(issues).toEqual([{ source: "serve", code: "runtime_exit" }]);
    expect(harness.resourceCloseCalls).toBe(1);
    expect(harness.signalUnsubscribeCalls).toBe(1);
  });

  it("cancels startup on child exit and fails closed on rejected exit observation", async () => {
    const duringStartup = createHarness({ holdStartup: true });
    const pending = duringStartup.start();
    await eventually(() => {
      expect(duringStartup.events).toContain("listener:start");
    });
    duringStartup.resolveProcessExit({
      kind: "exited",
      expected: false,
      code: 19,
      signal: null
    });
    const startupError = await expectServeFailure(pending);
    expect(startupError).toMatchObject({
      code: "startup_aborted",
      stage: "listener"
    });
    expect(duringStartup.events).toContain("listener:health-failed");
    expect(duringStartup.resourceCloseCalls).toBe(1);
    expect(duringStartup.signalUnsubscribeCalls).toBe(1);

    const rejected = createHarness();
    const service = await rejected.start({
      observe_issue: async () => undefined
    });
    rejected.rejectProcessExit(new Error("private exit observation"));
    await expect(service.terminated).resolves.toMatchObject({
      phase: "failed",
      termination_trigger: "runtime_exit_observation_failed",
      listener_health: "failed",
      reported_issue_count: 1,
      observer_failure_count: 1,
      last_issue: {
        source: "serve",
        code: "runtime_exit_observation_failed"
      }
    });
    expect(rejected.listenerCloseCalls).toBe(1);
    expect(rejected.resourceCloseCalls).toBe(1);
    expect(rejected.signalUnsubscribeCalls).toBe(1);
  });

  it("classifies every outer startup stage and reverse-cleans acquired owners", async () => {
    const privateSentinel = "/private/hostdeck/startup-stage";
    const signalFailure = createHarness({
      signalSubscribeError: new Error(privateSentinel)
    });
    expect(await expectServeFailure(signalFailure.start())).toMatchObject({
      code: "signal_ownership_failed",
      stage: "signals"
    });
    expect(signalFailure.events).toEqual(["signals:subscribe"]);

    const resourceFailure = createHarness({
      resourceStartError: new Error(privateSentinel)
    });
    expect(await expectServeFailure(resourceFailure.start())).toMatchObject({
      code: "resource_start_failed",
      stage: "resources"
    });
    expect(resourceFailure.events).toEqual([
      "signals:subscribe",
      "resources:start",
      "signals:unsubscribe"
    ]);

    const applicationFailure = createHarness({
      applicationCreateError: new Error(privateSentinel)
    });
    expect(await expectServeFailure(applicationFailure.start())).toMatchObject({
      code: "application_composition_failed",
      stage: "application"
    });
    expect(applicationFailure.events.slice(-2)).toEqual([
      "resources:close",
      "signals:unsubscribe"
    ]);

    const readinessFailure = createHarness({
      listenerReadyError: new Error(privateSentinel)
    });
    const readinessError = await expectServeFailure(readinessFailure.start());
    expect(readinessError).toMatchObject({
      code: "readiness_failed",
      stage: "readiness"
    });
    expect(String(readinessError)).not.toContain(privateSentinel);
    expect(readinessFailure.listenerCloseCalls).toBe(1);
    expect(readinessFailure.resourceCloseCalls).toBe(1);
    expect(readinessFailure.signalUnsubscribeCalls).toBe(1);
  });

  it("rolls back listener startup, readiness, cancellation, and close failures without private output", async () => {
    const privateSentinel = "/private/hostdeck/serve-sentinel";
    const listenerFailure = createHarness({
      listenerStartError: new Error(privateSentinel)
    });
    const listenerError = await expectServeFailure(listenerFailure.start());
    expect(listenerError).toMatchObject({
      code: "listener_start_failed",
      stage: "listener"
    });
    expect(String(listenerError)).not.toContain(privateSentinel);
    expect(JSON.stringify(listenerError)).not.toContain(privateSentinel);
    expect(listenerFailure.resourceCloseCalls).toBe(1);
    expect(listenerFailure.signalUnsubscribeCalls).toBe(1);

    const inconsistent = createHarness({ inconsistentReadiness: true });
    const readinessError = await expectServeFailure(inconsistent.start());
    expect(readinessError).toMatchObject({
      code: "readiness_failed",
      stage: "readiness"
    });
    expect(inconsistent.listenerCloseCalls).toBe(1);
    expect(inconsistent.resourceCloseCalls).toBe(1);

    const controller = new AbortController();
    const canceled = createHarness({ holdStartup: true });
    const pending = canceled.start({ signal: controller.signal });
    await eventually(() => {
      expect(canceled.events).toContain("listener:start");
    });
    controller.abort(new Error(privateSentinel));
    const canceledError = await expectServeFailure(pending);
    expect(canceledError).toMatchObject({
      code: "startup_aborted",
      stage: "listener"
    });
    expect(String(canceledError)).not.toContain(privateSentinel);
    expect(canceled.resourceCloseCalls).toBe(1);
    expect(canceled.signalUnsubscribeCalls).toBe(1);

    const closeFailure = createHarness({
      listenerCloseError: new Error(privateSentinel),
      resourceCloseError: new Error(`${privateSentinel}:resource`)
    });
    const failingService = await closeFailure.start();
    const firstFailure = failingService.close();
    expect(failingService.close()).toBe(firstFailure);
    const shutdownError = await expectServeFailure(firstFailure);
    expect(shutdownError).toMatchObject({
      code: "shutdown_failed",
      stage: "shutdown"
    });
    expect(String(shutdownError)).not.toContain(privateSentinel);
    await expect(failingService.terminated).resolves.toMatchObject({
      phase: "failed",
      termination_trigger: "manual"
    });
    expect(closeFailure.listenerCloseCalls).toBe(1);
    expect(closeFailure.resourceCloseCalls).toBe(1);
    expect(closeFailure.signalUnsubscribeCalls).toBe(1);
  });

  it("owns and releases only its two real process-signal listeners", () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const observed: HostDeckProcessTerminationSignal[] = [];
    const unsubscribe = subscribeHostDeckProcessTerminationSignals((signal) =>
      observed.push(signal)
    );
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm + 1);
    process.emit("SIGINT");
    process.emit("SIGTERM");
    expect(observed).toEqual(["SIGINT", "SIGTERM"]);
    unsubscribe();
    unsubscribe();
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });
});

interface HarnessOptions {
  readonly applicationCreateError?: Error;
  readonly holdClose?: boolean;
  readonly holdStartup?: boolean;
  readonly inconsistentReadiness?: boolean;
  readonly listenerCloseError?: Error;
  readonly listenerReadyError?: Error;
  readonly listenerStartError?: Error;
  readonly resourceCloseError?: Error;
  readonly resourceStartError?: Error;
  readonly signalSubscribeError?: Error;
}

interface FakeServeHarness {
  readonly dependencies: HostDeckProductionForegroundServeDependencies;
  readonly events: string[];
  readonly port: number;
  readonly emitSignal: (signal: HostDeckProcessTerminationSignal) => void;
  readonly releaseClose: () => void;
  readonly rejectProcessExit: (cause: unknown) => void;
  readonly resolveProcessExit: (
    observation: CodexRuntimeProcessExitObservation
  ) => void;
  readonly start: (
    overrides?: Partial<StartHostDeckProductionForegroundServeInput>
  ) => Promise<ReturnTypeOwner>;
  readonly resourceCloseCalls: number;
  readonly listenerCloseCalls: number;
  readonly signalUnsubscribeCalls: number;
  readonly startupSignal: AbortSignal | null;
  service: ReturnTypeOwner | null;
}

type ReturnTypeOwner = Awaited<
  ReturnType<typeof startHostDeckProductionForegroundServe>
>;

function createHarness(options: HarnessOptions = {}): FakeServeHarness {
  const events: string[] = [];
  const port = 46_321 + openHarnesses.length;
  const processExit = deferred<CodexRuntimeProcessExitObservation>();
  const closeRelease = deferred<void>();
  const state = {
    applicationPhase: "runtime_ready" as HostDeckProductionApplicationSnapshot["phase"],
    listenerHealth: "not_ready" as ReturnType<
      HostDeckProductionApplication["listener"]["snapshot"]
    >,
    listenerPhase: "ready" as HostDeckFastifyLifecycleSnapshot["phase"],
    listening: true,
    remotePhase: "running" as ReturnType<
      HostDeckProductionApplication["remote"]["snapshot"]
    >["phase"],
    resourcePhase: "ready" as ReturnType<
      HostDeckForegroundResources["snapshot"]
    >["phase"]
  };
  let signalListener: ((signal: HostDeckProcessTerminationSignal) => void) | null =
    null;
  let resourceCloseCalls = 0;
  let listenerCloseCalls = 0;
  let signalUnsubscribeCalls = 0;
  let startupSignal: AbortSignal | null = null;
  let service: ReturnTypeOwner | null = null;

  const resources = {
    bind: Object.freeze({
      host: "127.0.0.1" as const,
      port,
      transport: "http" as const
    }),
    resource_budget: defaultResourceBudget,
    runtime: Object.freeze({ process_exit: processExit.promise }),
    snapshot: () =>
      Object.freeze({
        phase: state.resourcePhase,
        database_open: state.resourcePhase === "ready",
        lease_held: state.resourcePhase === "ready",
        runtime: Object.freeze({ phase: state.resourcePhase })
      }),
    async close() {
      resourceCloseCalls += 1;
      events.push("resources:close");
      state.resourcePhase = options.resourceCloseError === undefined ? "closed" : "failed";
      if (options.resourceCloseError !== undefined) {
        throw options.resourceCloseError;
      }
    }
  } as unknown as HostDeckForegroundResources;

  const listener = Object.freeze({
    beginDrain() {
      events.push("listener:health-draining");
      if (state.listenerHealth !== "failed") state.listenerHealth = "draining";
    },
    closed() {
      events.push("listener:health-closed");
      if (state.listenerHealth !== "failed") state.listenerHealth = "closed";
    },
    failed() {
      events.push("listener:health-failed");
      state.listenerHealth = "failed";
    },
    ready() {
      events.push("listener:health-ready");
      if (options.listenerReadyError !== undefined) {
        throw options.listenerReadyError;
      }
      state.listenerHealth = "ready";
    },
    snapshot: () => state.listenerHealth
  });
  const application = {
    authentication: Object.freeze({}),
    bind: resources.bind,
    health: Object.freeze({
      localSnapshot: () =>
        Object.freeze({
          readiness:
            options.inconsistentReadiness === true ? "not_ready" : "ready",
          mutation_admission:
            options.inconsistentReadiness === true ? "closed" : "open"
        }),
      remoteSnapshot: () =>
        Object.freeze({
          availability: "unknown",
          reason: "not_observed"
        })
    }),
    listener,
    remote: Object.freeze({
      snapshot: () => Object.freeze({ phase: state.remotePhase })
    }),
    resource_budget: defaultResourceBudget,
    route_registrations: Object.freeze([]),
    runtime: Object.freeze({}),
    shutdown: Object.freeze({}),
    snapshot: () =>
      Object.freeze({
        phase: state.applicationPhase,
        route_registration_count: 23,
        api_registration_count: 21,
        sse_registration_count: 1,
        static_registration_count: 1,
        reported_issue_count: 0,
        observer_failure_count: 0,
        last_issue: null,
        startup_maintenance: null,
        reconnect: Object.freeze({ phase: "ready" }),
        reconciliation: Object.freeze({ phase: "ready" }),
        shutdown: Object.freeze({ phase: state.applicationPhase === "closed" ? "closed" : "idle" })
      })
  } as unknown as HostDeckProductionApplication;
  const listenerSnapshot = (): HostDeckFastifyLifecycleSnapshot =>
    Object.freeze({
      bound: state.listening
        ? Object.freeze({
            host: "127.0.0.1" as const,
            port,
            transport: "http" as const
          })
        : null,
      configured: Object.freeze({
        host: "127.0.0.1" as const,
        port,
        transport: "http" as const
      }),
      connections: Object.freeze({
        active_connections: 0,
        dropped_connections: 0,
        dropped_requests: 0,
        forced_shutdown_connections: 0
      }),
      listening: state.listening,
      node_limits: Object.freeze({}) as HostDeckFastifyLifecycleSnapshot["node_limits"],
      phase: state.listenerPhase
    });
  const lifecycle = {
    app: Object.freeze({}),
    baseUrl: new URL(`http://127.0.0.1:${port}/`),
    context: application,
    async close() {
      listenerCloseCalls += 1;
      events.push("listener:close");
      state.listenerPhase = "draining";
      state.listening = false;
      listener.beginDrain();
      if (options.holdClose === true) await closeRelease.promise;
      state.remotePhase = "closed";
      state.applicationPhase = "closed";
      listener.closed();
      state.listenerPhase =
        options.listenerCloseError === undefined ? "closed" : "failed";
      if (options.listenerCloseError !== undefined) {
        throw options.listenerCloseError;
      }
    },
    snapshot: listenerSnapshot
  } as unknown as HostDeckFastifyLifecycle<HostDeckProductionApplication>;

  const dependencies: HostDeckProductionForegroundServeDependencies = {
    create_application() {
      events.push("application:create");
      if (options.applicationCreateError !== undefined) {
        throw options.applicationCreateError;
      }
      return application;
    },
    async start_fastify_lifecycle(
      _input: StartHostDeckTailscaleServeFastifyLifecycleInput<HostDeckProductionApplication>,
      signal?: AbortSignal
    ) {
      events.push("listener:start");
      startupSignal = signal ?? null;
      if (options.listenerStartError !== undefined) {
        throw options.listenerStartError;
      }
      if (options.holdStartup === true) {
        await rejectOnAbort(signal);
      }
      return lifecycle;
    },
    async start_foreground_resources() {
      events.push("resources:start");
      if (options.resourceStartError !== undefined) {
        throw options.resourceStartError;
      }
      return resources;
    },
    subscribe_termination_signals(listener) {
      events.push("signals:subscribe");
      if (options.signalSubscribeError !== undefined) {
        throw options.signalSubscribeError;
      }
      signalListener = listener;
      return () => {
        signalUnsubscribeCalls += 1;
        events.push("signals:unsubscribe");
        signalListener = null;
      };
    }
  };

  const harness: FakeServeHarness = {
    dependencies,
    events,
    port,
    emitSignal(signal) {
      signalListener?.(signal);
    },
    releaseClose: () => closeRelease.resolve(),
    rejectProcessExit: (cause) => processExit.reject(cause),
    resolveProcessExit: (observation) => processExit.resolve(observation),
    async start(overrides = {}) {
      service = await startHostDeckProductionForegroundServe(
        { ...validInput(), ...overrides },
        dependencies
      );
      harness.service = service;
      return service;
    },
    get resourceCloseCalls() {
      return resourceCloseCalls;
    },
    get listenerCloseCalls() {
      return listenerCloseCalls;
    },
    get signalUnsubscribeCalls() {
      return signalUnsubscribeCalls;
    },
    get startupSignal() {
      return startupSignal;
    },
    service
  };
  openHarnesses.push(harness);
  return harness;
}

function validInput(): StartHostDeckProductionForegroundServeInput {
  return {
    browser_routes: ["/"],
    codex_bin: "/tmp/hostdeck-production-serve-codex",
    config_dir: "/tmp/hostdeck-production-serve-config",
    database_path: "/tmp/hostdeck-production-serve-state/hostdeck.sqlite",
    loopback_port: 46_321,
    observe_issue: () => undefined,
    resource_budget: defaultResourceBudget,
    runtime_dir: "/tmp/hostdeck-production-serve-runtime",
    state_dir: "/tmp/hostdeck-production-serve-state",
    static_build_root: "/tmp/hostdeck-production-serve-build"
  };
}

async function expectServeFailure(
  promise: Promise<unknown>
): Promise<HostDeckProductionForegroundServeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckProductionForegroundServeError);
    return error as HostDeckProductionForegroundServeError;
  }
  throw new Error("Expected production foreground serve failure.");
}

function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return Promise.reject(new Error("Expected production startup signal."));
  }
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (cause?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { interval: 5, timeout: 1_000 });
}
