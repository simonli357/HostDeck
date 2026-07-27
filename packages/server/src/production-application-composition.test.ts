import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline, type OperationDeadline } from "@hostdeck/core";
import {
  createRuntimeCompatibilityRepository,
  createSelectedStateRepository,
  createSettingsRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodexRuntimeProcessExitObservation,
  CodexRuntimeSupervisorSnapshot,
  CreateCodexRuntimeSupervisorInput,
  createCodexRuntimeSupervisor,
  HostDeckCodexRuntimeSupervisor,
  StartedCodexRuntime
} from "./codex-runtime-supervisor.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  hostDeckFastifyRouteInventory
} from "./fastify-app.js";
import {
  createHostDeckRequestTrustPolicy,
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import {
  type HostDeckForegroundResources,
  startHostDeckForegroundResources
} from "./foreground-resource-bootstrap.js";
import {
  assertHostDeckProductionApplication,
  type CreateHostDeckProductionApplicationInput,
  createHostDeckProductionApplication,
  type HostDeckProductionApplication,
  hostDeckProductionStaticRegistrationId
} from "./production-application-composition.js";
import { hostDeckSelectedApiRouteCompositionDescriptor } from "./selected-api-route-composition.js";
import { selectedApiRouteManifest } from "./selected-api-route-manifest.js";

const fixtures: CompositionFixture[] = [];
const fastifyApps = new Set<HostDeckFastifyInstance>();
const indexSentinel = "HOSTDECK_PRODUCTION_COMPOSITION_STATIC_SENTINEL";
const diagnosticSessionId = "sess_production_diagnostic_001";

afterEach(async () => {
  const errors: unknown[] = [];
  for (const app of [...fastifyApps].reverse()) {
    try {
      await app.close();
    } catch (error) {
      errors.push(error);
    }
  }
  fastifyApps.clear();
  for (const fixture of fixtures.splice(0).reverse()) {
    try {
      await closeFixture(fixture);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Production composition fixture cleanup failed.");
  }
});

describe("IFC-V1-082 production application composition", () => {
  it("assembles one frozen real graph with the exact selected and static inventory", async () => {
    const fixture = await createFixture("graph");
    const issues: unknown[] = [];
    const application = compose(fixture, (issue) => issues.push(issue));

    expect(Object.isFrozen(application)).toBe(true);
    expect(() => assertHostDeckProductionApplication(application)).not.toThrow();
    expect(() =>
      assertHostDeckProductionApplication(Object.freeze({ ...application }))
    ).toThrow(TypeError);
    expect(application.resource_budget).toBe(defaultResourceBudget);
    expect(application.bind).toBe(fixture.resources.bind);
    expect(application.route_registrations).toHaveLength(23);
    expect(Object.isFrozen(application.route_registrations)).toBe(true);
    expect(
      application.route_registrations.map(({ id, surface }) => ({ id, surface }))
    ).toEqual([
      ...hostDeckSelectedApiRouteCompositionDescriptor.map((entry) => ({
        id: entry.registrationId,
        surface: entry.surface
      })),
      { id: hostDeckProductionStaticRegistrationId, surface: "static" }
    ]);
    expect(
      application.route_registrations.every((registration) =>
        Object.isFrozen(registration)
      )
    ).toBe(true);

    expect(application.snapshot()).toMatchObject({
      phase: "assembled",
      route_registration_count: 23,
      api_registration_count: 21,
      sse_registration_count: 1,
      static_registration_count: 1,
      reported_issue_count: 0,
      observer_failure_count: 0,
      startup_maintenance: null,
      reconnect: { phase: "idle" }
    });
    expect(application.listener.snapshot()).toBe("not_ready");
    expect(application.remote.snapshot()).toMatchObject({
      phase: "idle",
      poll_cycles: 0,
      poll_failures: 0,
      health_updates: 0
    });
    expect(application.health.localSnapshot()).toMatchObject({
      readiness: "not_ready",
      mutation_admission: "closed"
    });
    expect(application.health.remoteSnapshot()).toMatchObject({
      availability: "unknown",
      reason: "not_observed"
    });
    expect(createSettingsRepository(fixture.resources.database).require()).toMatchObject({
      bind_port: fixture.resources.bind.port,
      state_dir: fixture.stateDir
    });

    const app = createLocalApp(application);
    await app.ready();
    const selectedInventory = hostDeckFastifyRouteInventory(app)
      .filter((entry) => entry.path.startsWith("/api/"))
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    expect(selectedInventory).toEqual(
      selectedApiRouteManifest
        .map((entry) => `${entry.method} ${entry.path}`)
        .sort()
    );
    expect(selectedInventory).toHaveLength(35);
    expect(
      hostDeckFastifyRouteInventory(app).some((entry) =>
        /\/(?:acceptance|certificates?|lan|network|raw|tmux)(?:\/|$)/u.test(
          entry.path
        )
      )
    ).toBe(false);
    const staticResponse = await app.inject({
      headers: { host: `127.0.0.1:${fixture.resources.bind.port}` },
      method: "GET",
      url: "/"
    });
    expect(staticResponse.statusCode, staticResponse.body).toBe(200);
    expect(staticResponse.body).toContain(indexSentinel);
    expect(issues).toEqual([]);
    expect(fixture.runtime.startCalls).toBe(1);
    expect(fixture.runtime.closeCalls).toBe(0);
  });

  it("rejects hostile or invalid graph input before durable settings mutation", async () => {
    const fixture = await createFixture("invalid-input");
    const issues: unknown[] = [];
    const observe = (issue: unknown) => issues.push(issue);
    const base: CreateHostDeckProductionApplicationInput = {
      browser_routes: ["/"],
      observe_issue: observe,
      resources: fixture.resources,
      static_build_root: fixture.buildRoot
    };
    let topLevelAccessorRead = false;
    const topLevelAccessor = Object.defineProperty(
      { ...base },
      "browser_routes",
      {
        enumerable: true,
        get() {
          topLevelAccessorRead = true;
          return ["/"];
        }
      }
    );
    let routeAccessorRead = false;
    const accessorRoutes = ["/"];
    Object.defineProperty(accessorRoutes, "0", {
      configurable: true,
      enumerable: true,
      get() {
        routeAccessorRead = true;
        return "/";
      }
    });
    const sparseRoutes = new Array<string>(1);
    const candidates: unknown[] = [
      { ...base, unexpected: true },
      topLevelAccessor,
      { ...base, browser_routes: accessorRoutes },
      { ...base, browser_routes: sparseRoutes },
      { ...base, browser_routes: ["/settings"] },
      { ...base, static_build_root: "relative/build" },
      { ...base, resources: Object.freeze({ ...fixture.resources }) }
    ];

    for (const candidate of candidates) {
      expect(() =>
        createHostDeckProductionApplication(
          candidate as CreateHostDeckProductionApplicationInput
        )
      ).toThrow(TypeError);
      expect(createSettingsRepository(fixture.resources.database).get()).toBeNull();
    }
    expect(topLevelAccessorRead).toBe(false);
    expect(routeAccessorRead).toBe(false);
    expect(issues).toEqual([]);
  });

  it("fails closed when durable settings contradict the foreground owner", async () => {
    const fixture = await createFixture("settings-conflict");
    createSettingsRepository(fixture.resources.database).getOrCreateDefault({
      bindPort: fixture.resources.bind.port + 1,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      stateDir: fixture.stateDir
    });

    expect(() => compose(fixture)).toThrow(
      "Durable HostDeck settings contradict the foreground bind or state directory."
    );
    expect(fixture.resources.snapshot()).toMatchObject({
      phase: "ready",
      database_open: true,
      lease_held: true
    });
  });

  it("defers asset inspection to Fastify readiness and fails before any listener", async () => {
    const fixture = await createFixture("invalid-static");
    const application = compose(fixture);
    rmSync(join(fixture.buildRoot, "assets"), { force: true, recursive: true });
    const app = createLocalApp(application);

    let failure: unknown;
    try {
      await app.ready();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(errorCauseMessages(failure)).toContain(
      `HostDeck route plugin "${hostDeckProductionStaticRegistrationId}" failed registration.`
    );
    expect(app.server.listening).toBe(false);
    expect(app.server.address()).toBeNull();
    expect(application.snapshot().phase).toBe("assembled");
    expect(application.listener.snapshot()).toBe("not_ready");
    expect(application.remote.snapshot()).toMatchObject({
      phase: "idle",
      poll_cycles: 0
    });
  });

  it("drains every owner in order and records listener terminal state exactly once", async () => {
    const fixture = await createFixture("shutdown");
    const application = compose(fixture);

    expect(() => application.listener.ready()).toThrow(
      "HostDeck listener cannot become ready before the production application boundary."
    );
    application.runtime.beginDrain();
    expect(application.snapshot().phase).toBe("draining");
    expect(application.listener.snapshot()).toBe("draining");
    expect(
      application.health.localSnapshot().components.find(
        (component) => component.component === "listener"
      )
    ).toMatchObject({ state: "degraded", reasons: ["listener_draining"] });

    await withDeadline((deadline) => application.runtime.closeSse(deadline));
    expect(fixture.resources.database.open).toBe(true);
    await withDeadline((deadline) => application.runtime.closeRuntime(deadline));
    expect(fixture.resources.database.open).toBe(true);
    await withDeadline((deadline) => application.runtime.closeStartup(deadline));

    expect(application.snapshot()).toMatchObject({
      phase: "closed",
      shutdown: {
        phase: "closed",
        completed_stage_count: 10,
        failed_stage_count: 0,
        active_write_operations: 0,
        pending_audit_operations: 0,
        pending_projection_notifications: 0
      }
    });
    expect(
      application.snapshot().shutdown.stages.every(
        (stage) => stage.state === "succeeded" && stage.failure === null
      )
    ).toBe(true);
    expect(application.listener.snapshot()).toBe("closed");
    expect(fixture.resources.snapshot()).toMatchObject({
      phase: "closed",
      database_open: false,
      lease_held: false
    });
    expect(fixture.runtime.closeCalls).toBe(1);
    expect(JSON.stringify(application.snapshot())).not.toContain(fixture.root);

    application.runtime.beginDrain();
    await withDeadline((deadline) => application.runtime.closeSse(deadline));
    await withDeadline((deadline) => application.runtime.closeRuntime(deadline));
    await withDeadline((deadline) => application.runtime.closeStartup(deadline));
    expect(fixture.runtime.closeCalls).toBe(1);
    expect(application.listener.snapshot()).toBe("closed");
  });

  it("preserves listener failure while allowing complete resource cleanup", async () => {
    const fixture = await createFixture("listener-failure");
    const application = compose(fixture);

    application.listener.failed();
    expect(application.listener.snapshot()).toBe("failed");
    expect(
      application.health.localSnapshot().components.find(
        (component) => component.component === "listener"
      )
    ).toMatchObject({ state: "failed", reasons: ["listener_failed"] });

    application.runtime.beginDrain();
    await withDeadline((deadline) => application.runtime.closeSse(deadline));
    await withDeadline((deadline) => application.runtime.closeRuntime(deadline));
    await withDeadline((deadline) => application.runtime.closeStartup(deadline));

    expect(application.snapshot()).toMatchObject({
      phase: "closed",
      shutdown: { phase: "closed", failed_stage_count: 0 }
    });
    expect(application.listener.snapshot()).toBe("failed");
    expect(fixture.resources.snapshot()).toMatchObject({
      phase: "closed",
      database_open: false,
      lease_held: false
    });
  });

  it("reports bounded runtime-start failure without opening mutation or remote ingress", async () => {
    const fixture = await createFixture("runtime-failure");
    const application = compose(fixture, () => {
      throw new Error("observer-private-sentinel");
    });
    const deadline = createOperationDeadline({ timeoutMs: 100 });
    let failure: unknown;
    try {
      await application.runtime.start({
        deadline,
        resourceBudget: defaultResourceBudget
      });
    } catch (error) {
      failure = error;
    } finally {
      deadline.dispose();
    }

    expect(failure).toBeDefined();
    expect(application.snapshot()).toMatchObject({
      phase: "failed",
      reported_issue_count: 1,
      observer_failure_count: 1,
      last_issue: { source: "reconnect", code: "operation_timeout" },
      reconnect: {
        phase: "failed",
        connection_state: "disconnected",
        admitted_generation: null
      }
    });
    expect(JSON.stringify(application.snapshot())).not.toContain(
      "observer-private-sentinel"
    );
    expect(application.health.localSnapshot()).toMatchObject({
      readiness: "not_ready",
      mutation_admission: "closed"
    });
    expect(application.listener.snapshot()).toBe("not_ready");
    expect(application.remote.snapshot()).toMatchObject({
      phase: "idle",
      poll_cycles: 0
    });
  });

  it("serves mutation-closed diagnostics for a real observed version mismatch", async () => {
    const fixture = await createFixture("version-drift", {
      codexVersion: "0.145.0"
    });
    const stateRepository = createSelectedStateRepository(
      fixture.resources.database
    );
    stateRepository.create(diagnosticRuntimeSession());
    const issues: unknown[] = [];
    const application = compose(fixture, (issue) => issues.push(issue));

    await withDeadline((deadline) =>
      application.runtime.start({
        deadline,
        resourceBudget: defaultResourceBudget
      })
    );

    expect(fixture.runtime.startCalls).toBe(0);
    expect(fixture.resources.snapshot()).toMatchObject({
      phase: "ready",
      codex_version: "0.145.0",
      runtime_preparation: "version_incompatible",
      runtime: {
        phase: "idle",
        process_state: "not_started",
        claim_held: false,
        socket_ready: false
      }
    });
    expect(application.snapshot()).toMatchObject({
      phase: "diagnostic_ready",
      reconnect: {
        phase: "incompatible",
        connection_state: "disconnected",
        admitted_generation: null,
        last_failure: { code: "incompatible", stage: "connect" }
      },
      reconciliation: {
        phase: "gap_prepared",
        gap_reason: "restart",
        durable_session_count: 1
      },
      startup_maintenance: { status: "ready" }
    });
    expect(application.health.localSnapshot()).toMatchObject({
      readiness: "not_ready",
      mutation_admission: "closed",
      components: expect.arrayContaining([
        expect.objectContaining({
          component: "compatibility",
          state: "failed",
          reasons: ["runtime_incompatible"]
        }),
        expect.objectContaining({
          component: "runtime",
          state: "failed",
          reasons: ["runtime_failed"]
        }),
        expect.objectContaining({ component: "storage", state: "ready" })
      ])
    });
    expect(
      createRuntimeCompatibilityRepository(fixture.resources.database).get()
    ).toMatchObject({
      id: "hostdeck_runtime",
      compatibility: {
        state: "incompatible",
        mutation_policy: "blocked",
        observed_version: "0.145.0"
      }
    });
    expect(issues).toEqual([{ source: "reconnect", code: "incompatible" }]);
    expect(
      stateRepository.require(diagnosticSessionId).projection.session
    ).toMatchObject({
      freshness: "disconnected",
      freshness_reason:
        "HostDeck restarted; runtime reconciliation is required.",
      turn_state: "in_progress"
    });
    const diagnosticEvents = stateRepository.listEvents(
      diagnosticSessionId
    ).events;
    expect(diagnosticEvents).toHaveLength(1);
    expect(diagnosticEvents[0]).toMatchObject({
      state: "disconnected",
      type: "runtime"
    });

    application.listener.ready();
    const app = createLocalApp(application);
    await app.ready();
    const staticResponse = await app.inject({
      headers: { host: `127.0.0.1:${fixture.resources.bind.port}` },
      method: "GET",
      url: "/"
    });
    expect(staticResponse.statusCode, staticResponse.body).toBe(200);
    expect(staticResponse.body).toContain(indexSentinel);

    const requestHeaders = {
      host: `127.0.0.1:${fixture.resources.bind.port}`,
      [hostDeckLocalAdminRequestHeaderName]:
        hostDeckLocalAdminRequestHeaderValue
    };
    const statusResponse = await app.inject({
      headers: requestHeaders,
      method: "GET",
      url: "/api/v1/host/status"
    });
    expect(statusResponse.statusCode, statusResponse.body).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      local: { readiness: "not_ready", mutation_admission: "closed" },
      compatibility: {
        state: "version_drift",
        evidence: "current",
        observed_version: "0.145.0",
        supported_version: "0.144.0",
        capability_state: "blocked"
      }
    });
    expect(statusResponse.headers["cache-control"]).toBe("no-store");
    expect(statusResponse.body).not.toMatch(
      /binding_id|capabilities|reason|socket|codex_bin|private|user_agent/iu
    );

    const readinessResponse = await app.inject({
      headers: requestHeaders,
      method: "GET",
      url: "/api/v1/health/ready"
    });
    expect(readinessResponse.statusCode, readinessResponse.body).toBe(503);
    const streamResponse = await app.inject({
      headers: {
        accept: "text/event-stream",
        host: `127.0.0.1:${fixture.resources.bind.port}`
      },
      method: "GET",
      url: `/api/v1/sessions/${diagnosticSessionId}/events/stream`
    });
    expect(streamResponse.statusCode, streamResponse.body).toBe(503);
    expect(streamResponse.json()).toMatchObject({
      error: { code: "service_overloaded", retryable: false }
    });
    const operationId = "op_diagnostic_start_001";
    const mutationResponse = await app.inject({
      headers: requestHeaders,
      method: "POST",
      payload: {
        operation_id: operationId,
        name: "diagnostic-blocked",
        cwd: "/tmp/hostdeck-diagnostic-blocked"
      },
      url: "/api/v1/sessions"
    });
    expect(mutationResponse.statusCode, mutationResponse.body).toBe(409);
    expect(mutationResponse.json()).toMatchObject({
      error: { code: "incompatible_runtime", retryable: false }
    });
    const auditCount = fixture.resources.database
      .prepare(
        "SELECT COUNT(*) AS count FROM selected_audit_events WHERE operation_id = ?"
      )
      .get(operationId) as { readonly count: number };
    expect(auditCount.count).toBe(0);
    expect(fixture.runtime.startCalls).toBe(0);
  });

  it("turns a rejected runtime-exit observation into bounded terminal diagnostics", async () => {
    const fixture = await createFixture("exit-observation");
    const issues: unknown[] = [];
    const application = compose(fixture, (issue) => issues.push(issue));

    fixture.runtime.rejectExit();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(application.snapshot()).toMatchObject({
      phase: "failed",
      reported_issue_count: 1,
      observer_failure_count: 0,
      last_issue: {
        source: "process",
        code: "runtime_exit_observation_failed"
      }
    });
    expect(issues).toEqual([
      { source: "process", code: "runtime_exit_observation_failed" }
    ]);
    expect(JSON.stringify(application.snapshot())).not.toContain(
      "private-runtime-exit-rejection"
    );
    expect(application.health.localSnapshot()).toMatchObject({
      readiness: "not_ready",
      mutation_admission: "closed"
    });
  });
});

interface FakeRuntimeHarness {
  factory: typeof createCodexRuntimeSupervisor;
  closeCalls: number;
  startCalls: number;
  readonly rejectExit: () => void;
}

interface CompositionFixture {
  readonly root: string;
  readonly stateDir: string;
  readonly buildRoot: string;
  readonly resources: HostDeckForegroundResources;
  readonly runtime: FakeRuntimeHarness;
  application: HostDeckProductionApplication | null;
}

async function createFixture(
  label: string,
  options: Readonly<{ readonly codexVersion?: string }> = {}
): Promise<CompositionFixture> {
  const root = mkdtempSync(join(tmpdir(), `hd-pa-${label}-`));
  chmodSync(root, 0o700);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const executable = join(root, "codex-fixture");
  const buildRoot = join(root, "build");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf 'codex-cli ${options.codexVersion ?? "0.144.0"}\\n'\n`,
    { mode: 0o700 }
  );
  mkdirSync(join(buildRoot, "assets"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(buildRoot, "index.html"),
    `<!doctype html><html><body>${indexSentinel}</body></html>\n`,
    { mode: 0o600 }
  );
  writeFileSync(join(buildRoot, "assets", "app-12345678.js"), "export {};\n", {
    mode: 0o600
  });
  const runtime = fakeRuntime();
  const resources = await startHostDeckForegroundResources(
    {
      config_dir: configDir,
      state_dir: stateDir,
      runtime_dir: runtimeDir,
      database_path: join(stateDir, "hostdeck.sqlite"),
      codex_bin: executable,
      loopback_port: 46_217,
      resource_budget: defaultResourceBudget
    },
    { runtimeSupervisorFactory: runtime.factory }
  );
  const fixture: CompositionFixture = {
    root,
    stateDir,
    buildRoot,
    resources,
    runtime,
    application: null
  };
  fixtures.push(fixture);
  return fixture;
}

function compose(
  fixture: CompositionFixture,
  observeIssue: CreateHostDeckProductionApplicationInput["observe_issue"] = () =>
    undefined
): HostDeckProductionApplication {
  const application = createHostDeckProductionApplication({
    browser_routes: ["/"],
    observe_issue: observeIssue,
    resources: fixture.resources,
    static_build_root: fixture.buildRoot
  });
  fixture.application = application;
  return application;
}

function createLocalApp(
  application: HostDeckProductionApplication
): HostDeckFastifyInstance {
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: application.authentication,
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigin: `http://${application.bind.host}:${application.bind.port}`
    }),
    resourceBudget: application.resource_budget,
    routePlugins: application.route_registrations
  });
  fastifyApps.add(app);
  return app;
}

function fakeRuntime(): FakeRuntimeHarness {
  let phase: CodexRuntimeSupervisorSnapshot["phase"] = "idle";
  let settled = false;
  let resolveExit: ((observation: CodexRuntimeProcessExitObservation) => void) | null =
    null;
  let rejectExit: ((reason: unknown) => void) | null = null;
  const processExit = new Promise<CodexRuntimeProcessExitObservation>(
    (resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    }
  );
  const harness: FakeRuntimeHarness = {
    closeCalls: 0,
    startCalls: 0,
    rejectExit() {
      if (settled) return;
      settled = true;
      rejectExit?.(new Error("private-runtime-exit-rejection"));
      rejectExit = null;
      resolveExit = null;
    },
    factory: (() => {
      throw new Error("Uninitialized production-composition runtime fixture.");
    }) as typeof createCodexRuntimeSupervisor
  };
  harness.factory = ((input: CreateCodexRuntimeSupervisorInput) => {
    const started: StartedCodexRuntime = Object.freeze({
      mode: "foreground_child",
      ownership: "foreground_child",
      process_exit: processExit,
      socket_mode_repaired: true,
      socket_path: input.socket_path,
      stale_socket_removed: false
    });
    const supervisor: HostDeckCodexRuntimeSupervisor = Object.freeze({
      async start() {
        harness.startCalls += 1;
        phase = "ready";
        return started;
      },
      async close() {
        harness.closeCalls += 1;
        phase = "closed";
        if (!settled) {
          settled = true;
          resolveExit?.({
            kind: "exited",
            expected: true,
            code: 0,
            signal: null
          });
        }
        resolveExit = null;
        rejectExit = null;
      },
      snapshot: () => runtimeSnapshot(phase)
    });
    return supervisor;
  }) as typeof createCodexRuntimeSupervisor;
  return harness;
}

function runtimeSnapshot(
  phase: CodexRuntimeSupervisorSnapshot["phase"]
): CodexRuntimeSupervisorSnapshot {
  return Object.freeze({
    mode: "foreground_child",
    phase,
    ownership: "foreground_child",
    claim_held: phase === "ready",
    socket_ready: phase === "ready",
    socket_mode_repaired: phase === "ready",
    stale_socket_removed: false,
    process_state: phase === "ready" ? "running" : "not_started",
    process_exit: null,
    spawn_attempts: phase === "idle" ? 0 : 1,
    startup_retries: 0,
    term_signals: 0,
    kill_signals: 0,
    cleanup_failures: 0
  });
}

function diagnosticRuntimeSession(): Readonly<Record<string, unknown>> {
  const createdAt = "2026-07-20T12:00:00.000Z";
  const mapping = {
    id: diagnosticSessionId,
    name: "production-diagnostic",
    codex_thread_id: "thread-production-diagnostic-001",
    cwd: "/tmp/hostdeck-production-diagnostic",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null
  } as const;
  return Object.freeze({
    mapping,
    projection: {
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: mapping.archived_at,
        session_state: "active",
        turn_state: "in_progress",
        attention: "watch",
        freshness: "current",
        freshness_reason: null,
        updated_at: mapping.updated_at,
        last_activity_at: createdAt,
        branch: "main",
        model: null,
        settings: null,
        goal: null,
        recent_summary: "Managed projection created.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  });
}

async function closeFixture(fixture: CompositionFixture): Promise<void> {
  try {
    const application = fixture.application;
    if (application !== null && application.snapshot().phase !== "closed") {
      application.runtime.beginDrain();
      await withDeadline((deadline) => application.runtime.closeSse(deadline));
      await withDeadline((deadline) => application.runtime.closeRuntime(deadline));
      await withDeadline((deadline) => application.runtime.closeStartup(deadline));
    }
    await fixture.resources.close();
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
}

async function withDeadline<T>(
  operation: (deadline: OperationDeadline) => T | Promise<T>
): Promise<T> {
  const deadline = createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_cleanup_step_timeout_ms
  });
  try {
    return await operation(deadline);
  } finally {
    deadline.dispose();
  }
}

function errorCauseMessages(failure: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current = failure;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    messages.push(current.message);
    current = (current as Error & { readonly cause?: unknown }).cause;
  }
  return messages.join(" <- ");
}
