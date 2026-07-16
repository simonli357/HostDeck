import {
  existsSync,
  lstatSync,
  readFileSync
} from "node:fs";
import {
  type CodexAppServerConnection,
  type CodexRuntimeReconnectController,
  codexBindingDescriptor,
  createCodexApprovalClient,
  createCodexAppServerConnection,
  createCodexModelClient,
  createCodexPlanClient,
  createCodexReconciliationReadClient,
  createCodexRuntimeReconnectController,
  createCodexThreadClient,
  createCodexTurnClient,
  createCodexUnixWebSocketTransport
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  type ModelCatalogEntry,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import {
  acquireHostDeckDaemonLease,
  createProductionProjectionAppendPort,
  createProductionProjectionContinuityPort,
  createSelectedStateRepository,
  type HostDeckDaemonLease,
  openMigratedDatabase,
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPathsAfterLease,
  resolveHostDeckLocalPaths,
  runStartupAuditOrphanReconciliation
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexApprovalControlService,
  createCodexApprovalControlService
} from "./codex-approval-control-service.js";
import {
  type CodexEventPipeline,
  createCodexEventPipeline
} from "./codex-event-pipeline.js";
import {
  type HostDeckRestartWorkerEnvironment,
  isProcessAlive,
  parseHostDeckRestartWorkerEnvironment,
  readBoundedProcessCommandLine,
  readDirectChildProcessIds,
  readHostDeckRestartPrivateJson,
  socketIdentity,
  writeHostDeckRestartPrivateJson,
  writeHostDeckRestartWorkerReport
} from "./codex-hostdeck-restart-smoke-support.js";
import {
  type CodexModelControlService,
  createCodexModelControlService
} from "./codex-model-control-service.js";
import {
  type CodexPlanControlService,
  createCodexPlanControlService
} from "./codex-plan-control-service.js";
import {
  createCodexRuntimeReconciliationLifecycle
} from "./codex-runtime-reconciliation-lifecycle.js";
import {
  createCodexRuntimeSupervisor,
  type HostDeckCodexRuntimeSupervisor
} from "./codex-runtime-supervisor.js";

const rawWorkerMode = process.env.HOSTDECK_RESTART_WORKER_MODE;
const workerEnabled = rawWorkerMode !== undefined && rawWorkerMode !== "";
const sessionId = "sess_restart_continuity_001";
const operationId = "op_restart_continuity_0001";
const turnOperationId = "op_restart_continuity_turn_0001";

describe.skipIf(!workerEnabled)("HostDeck restart continuity worker", () => {
  it(
    "executes one bounded process-lifetime phase",
    async () => {
      const environment = parseHostDeckRestartWorkerEnvironment(process.env);
      expect(codexBindingDescriptor.codex_version).toBe("0.144.0");
      if (environment.mode === "service_initial") {
        await runServiceInitial(environment);
      } else if (environment.mode === "service_restart") {
        await runServiceRestart(environment);
      } else {
        await runForeground(environment);
      }
    },
    180_000
  );
});

interface WorkerResources {
  readonly lease: HostDeckDaemonLease;
  readonly open: ReturnType<typeof openMigratedDatabase>;
  readonly repository: ReturnType<typeof createSelectedStateRepository>;
  readonly supervisor: HostDeckCodexRuntimeSupervisor;
  readonly runtime_pid: number;
  readonly started_socket_path: string;
}

interface SharedServiceState {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
}

async function runServiceInitial(
  environment: HostDeckRestartWorkerEnvironment
): Promise<void> {
  const resources = await startWorkerResources(environment);
  let connection: CodexAppServerConnection | null = null;
  let pipeline: CodexEventPipeline | null = null;
  let databaseClosed = false;
  let connectionClosed = false;
  let cleanupFailures = 0;
  try {
    const backgroundErrors: Error[] = [];
    const pending = new Set<Promise<unknown>>();
    const append = createProductionProjectionAppendPort({
      repository: resources.repository,
      publish() {}
    });
    pipeline = createCodexEventPipeline({
      repository: resources.repository,
      append_port: append
    });
    connection = createCodexAppServerConnection({
      transport: createCodexUnixWebSocketTransport({
        socket_path: resources.started_socket_path
      }),
      observed_version: codexBindingDescriptor.codex_version,
      on_notification(message) {
        if (pipeline === null) return;
        trackPipeline(pipeline.consume(message), pending, backgroundErrors);
      }
    });
    await connection.connect(AbortSignal.timeout(10_000));
    expect(connection.compatibility).toMatchObject({
      state: "ready",
      observed_version: "0.144.0",
      mutation_policy: "allowed"
    });

    const threads = createCodexThreadClient(connection);
    const started = await threads.start({
      operation_id: operationId,
      cwd: environment.project_dir
    });
    const thread = await threads.ensureMaterialized({
      thread_id: started.thread.id,
      operation_id: operationId,
      cwd: environment.project_dir,
      name: "restart-continuity"
    });
    const selectedModel = selectBoundedModel(
      (await createCodexModelClient(connection).listCatalog()).models
    );
    resources.repository.create(
      selectedState(
        thread.id,
        environment.project_dir,
        selectedModel.model.runtime_model
      )
    );

    const accepted = await createCodexTurnClient(connection).startTurn({
      operation_id: turnOperationId,
      thread_id: thread.id,
      text: restartPrompt(environment.marker_path),
      settings: {
        kind: "model",
        runtime_model: selectedModel.model.runtime_model,
        reasoning_effort: selectedModel.reasoning_effort
      }
    });
    writeHostDeckRestartPrivateJson(environment.shared_path, {
      schema_version: 1,
      session_id: sessionId,
      thread_id: accepted.thread_id,
      turn_id: accepted.turn_id
    } satisfies SharedServiceState);

    await waitFor(
      async () => {
        await pipeline?.barrier();
        assertNoBackgroundErrors(backgroundErrors);
        return (
          resources.repository.require(sessionId).projection.session
            .turn_state === "in_progress" &&
          readMarker(environment.marker_path) === "started"
        );
      },
      90_000,
      "The real restart turn did not enter its started command interval."
    );
    await pipeline.barrier();
    assertNoBackgroundErrors(backgroundErrors);
    writeReadyReport(environment, resources, {
      thread_id: accepted.thread_id,
      turn_id: accepted.turn_id,
      generation: null,
      boundary_count: 0,
      resumed_count: 0,
      ready_count: 0
    });

    await waitForRelease(environment);
    await pipeline.barrier();
    await connection.close("HostDeck service worker A is stopping.");
    connectionClosed = true;
    await closeSupervisor(resources.supervisor);
    resources.open.db.close();
    databaseClosed = true;
    resources.lease.release();

    expect(isProcessAlive(resources.runtime_pid)).toBe(true);
    expect(existsSync(resources.started_socket_path)).toBe(true);
    writeResultReport(environment, resources, {
      runtime_alive_after_close: true,
      socket_present_after_close: true,
      lease_released: resources.lease.released,
      database_closed: databaseClosed,
      controller_closed: connectionClosed,
      cleanup_failures: cleanupFailures
    });
  } catch (error) {
    cleanupFailures += await emergencyCleanup({
      connection,
      controller: null,
      approval: null,
      resources,
      databaseClosed,
      connectionClosed
    });
    throw error;
  }
}

async function runServiceRestart(
  environment: HostDeckRestartWorkerEnvironment
): Promise<void> {
  const shared = parseSharedState(
    readHostDeckRestartPrivateJson(environment.shared_path)
  );
  const resources = await startWorkerResources(environment);
  let controller: CodexRuntimeReconnectController | null = null;
  let approval: CodexApprovalControlService | null = null;
  let modelControl: CodexModelControlService | null = null;
  let planControl: CodexPlanControlService | null = null;
  let databaseClosed = false;
  let controllerClosed = false;
  let cleanupFailures = 0;
  try {
    expect(resources.repository.list()).toHaveLength(1);
    expect(resources.repository.require(shared.session_id).mapping).toMatchObject({
      id: shared.session_id,
      codex_thread_id: shared.thread_id,
      cwd: environment.project_dir,
      runtime_version: "0.144.0",
      archived_at: null
    });

    const backgroundErrors: Error[] = [];
    const lifecycleErrors: Array<{
      readonly stage: string;
      readonly name: string;
      readonly code: string | null;
      readonly message: string;
    }> = [];
    const pending = new Set<Promise<unknown>>();
    const now = monotonicIsoClock();
    const append = createProductionProjectionAppendPort({
      repository: resources.repository,
      publish() {}
    });
    const continuity = createProductionProjectionContinuityPort({
      repository: resources.repository,
      publish() {}
    });
    const pipeline = createCodexEventPipeline({
      repository: resources.repository,
      append_port: append,
      async observe_event(event) {
        await modelControl?.observeSettings(event);
        await planControl?.observeEvent(event);
        await approval?.observeEvent(event);
      }
    });
    const lifecycle = createCodexRuntimeReconciliationLifecycle({
      approvals: {
        async disconnect(generation) {
          if (approval === null) {
            throw new Error("Restart approval control is not initialized.");
          }
          return approval.disconnect(generation);
        }
      },
      audit: {
        reconcile(input) {
          return runStartupAuditOrphanReconciliation({
            db: resources.open.db,
            eligible_before: input.eligible_before,
            reconciled_at: input.reconciled_at,
            signal: input.deadline.signal,
            timeout_ms: input.deadline.timeoutMs(2_000)
          });
        }
      },
      continuity,
      events: {
        barrier: (input) => pipeline.barrier(input.signal),
        reconcile: (input) => pipeline.reconcile(input.threads, input.signal)
      },
      now,
      plans: {
        async rehydrate(target) {
          if (planControl === null) {
            throw new Error("Restart Plan control is not initialized.");
          }
          return planControl.rehydrate(target);
        }
      },
      projection: append,
      repository: resources.repository,
      resource_budget: defaultResourceBudget
    });
    controller = createCodexRuntimeReconnectController({
      transport: createCodexUnixWebSocketTransport({
        socket_path: resources.started_socket_path
      }),
      observed_version: codexBindingDescriptor.codex_version,
      resource_budget: defaultResourceBudget,
      lifecycle: {
        disconnected: captureLifecycleFailure(
          "disconnected",
          lifecycle.disconnected,
          lifecycleErrors
        ),
        reconcile: captureLifecycleFailure(
          "reconcile",
          lifecycle.reconcile,
          lifecycleErrors
        ),
        resubscribe: captureLifecycleFailure(
          "resubscribe",
          lifecycle.resubscribe,
          lifecycleErrors
        ),
        ready: captureLifecycleFailure(
          "ready",
          lifecycle.ready,
          lifecycleErrors
        )
      },
      random: () => 0,
      on_notification(message) {
        if (controller === null) return;
        trackPipeline(
          pipeline.consume(message, controller.generation),
          pending,
          backgroundErrors
        );
      },
      on_server_request(message) {
        if (approval === null) {
          backgroundErrors.push(
            new Error("Restart approval control is not initialized.")
          );
          return;
        }
        try {
          approval.register(message);
        } catch (error) {
          backgroundErrors.push(asError(error));
        }
      },
      on_background_error(error) {
        backgroundErrors.push(error);
      }
    });
    modelControl = createCodexModelControlService({
      models: createCodexModelClient(controller),
      states: resources.repository,
      now
    });
    planControl = createCodexPlanControlService({
      plans: createCodexPlanClient(controller),
      models: modelControl,
      states: resources.repository,
      now
    });
    approval = createCodexApprovalControlService({
      approvals: createCodexApprovalClient(controller),
      states: resources.repository,
      now,
      on_background_error(error) {
        backgroundErrors.push(error);
      }
    });

    let ready: Awaited<ReturnType<typeof controller.start>>;
    try {
      ready = await controller.start(AbortSignal.timeout(20_000));
    } catch (error) {
      throw new Error(
        `Restart controller startup failed (lifecycle=${JSON.stringify(
          lifecycle.snapshot()
        )}, controller=${JSON.stringify(
          controller.snapshot()
        )}, background=${JSON.stringify(
          backgroundErrors.map((failure) => ({
            name: failure.name,
            message: failure.message
          }))
        )}, lifecycle_errors=${JSON.stringify(
          lifecycleErrors
        )}).`,
        { cause: error }
      );
    }
    await pipeline.barrier();
    assertNoBackgroundErrors(backgroundErrors);
    expect(ready).toMatchObject({
      generation: 1,
      continuity: "boundary_required",
      reconnected: false
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      admitted_generation: 1
    });
    expect(lifecycle.snapshot()).toMatchObject({
      phase: "ready",
      generation: 1,
      continuity: "boundary_required",
      gap_reason: "restart",
      boundary_count: 1,
      resumed_count: 1,
      ready_count: 1
    });
    const current = resources.repository.require(shared.session_id);
    expect(current.projection.session).toMatchObject({
      turn_state: "in_progress",
      freshness: "current"
    });
    const retained = resources.repository.listEvents(shared.session_id);
    expect(retained.events[0]).toMatchObject({
      type: "replay_boundary",
      reason: "restart"
    });

    const reconciliationReads = createCodexReconciliationReadClient(
      {
        get compatibility() {
          if (controller === null) {
            throw new Error("Restart controller is unavailable.");
          }
          return controller.compatibility;
        },
        get generation() {
          if (controller === null) {
            throw new Error("Restart controller is unavailable.");
          }
          return controller.generation;
        },
        request(input) {
          if (controller === null) {
            throw new Error("Restart controller is unavailable.");
          }
          return controller.request(input);
        }
      },
      defaultResourceBudget
    );
    expect(await reconciliationReads.readLatestTurn(shared.thread_id)).toMatchObject({
      turn_id: shared.turn_id,
      status: "in_progress"
    });
    writeReadyReport(environment, resources, {
      thread_id: shared.thread_id,
      turn_id: shared.turn_id,
      generation: 1,
      boundary_count: 1,
      resumed_count: 1,
      ready_count: 1
    });

    await waitFor(
      async () => {
        await pipeline.barrier();
        assertNoBackgroundErrors(backgroundErrors);
        if (readMarker(environment.marker_path) !== "finished") return false;
        const latest = await reconciliationReads.readLatestTurn(
          shared.thread_id
        );
        return (
          latest?.turn_id === shared.turn_id &&
          latest.status === "completed" &&
          resources.repository.require(shared.session_id).projection.session
            .turn_state === "completed"
        );
      },
      120_000,
      "The original real turn did not complete after HostDeck restart."
    );
    const finalEvents = resources.repository.listEvents(shared.session_id);
    expect(finalEvents.events[0]).toMatchObject({
      type: "replay_boundary",
      reason: "restart"
    });
    expect(finalEvents.events.length).toBeGreaterThan(1);
    await pipeline.barrier();
    assertNoBackgroundErrors(backgroundErrors);

    approval.close();
    await controller.close();
    controllerClosed = true;
    await closeSupervisor(resources.supervisor);
    resources.open.db.close();
    databaseClosed = true;
    resources.lease.release();
    expect(isProcessAlive(resources.runtime_pid)).toBe(true);
    expect(existsSync(resources.started_socket_path)).toBe(true);
    writeResultReport(environment, resources, {
      runtime_alive_after_close: true,
      socket_present_after_close: true,
      lease_released: resources.lease.released,
      database_closed: databaseClosed,
      controller_closed: controllerClosed,
      cleanup_failures: cleanupFailures
    });
  } catch (error) {
    cleanupFailures += await emergencyCleanup({
      connection: null,
      controller,
      approval,
      resources,
      databaseClosed,
      connectionClosed: controllerClosed
    });
    throw error;
  }
}

async function runForeground(
  environment: HostDeckRestartWorkerEnvironment
): Promise<void> {
  const childrenBefore = new Set(readDirectChildProcessIds());
  const resources = await startWorkerResources(environment);
  let connection: CodexAppServerConnection | null = null;
  let databaseClosed = false;
  let connectionClosed = false;
  let cleanupFailures = 0;
  try {
    const runtimePid = await waitForForegroundChild(
      childrenBefore,
      resources.started_socket_path
    );
    expect(runtimePid).toBe(resources.runtime_pid);
    connection = createCodexAppServerConnection({
      transport: createCodexUnixWebSocketTransport({
        socket_path: resources.started_socket_path
      }),
      observed_version: codexBindingDescriptor.codex_version
    });
    await connection.connect(AbortSignal.timeout(10_000));
    expect(connection.compatibility).toMatchObject({
      state: "ready",
      observed_version: "0.144.0"
    });
    writeReadyReport(environment, resources, {
      thread_id: null,
      turn_id: null,
      generation: null,
      boundary_count: 0,
      resumed_count: 0,
      ready_count: 0
    });

    await waitForRelease(environment);
    await connection.close("HostDeck foreground worker is stopping.");
    connectionClosed = true;
    await closeSupervisor(resources.supervisor);
    resources.open.db.close();
    databaseClosed = true;
    resources.lease.release();

    await waitFor(
      () => !isProcessAlive(runtimePid),
      5_000,
      "The foreground-owned exact runtime remained alive after HostDeck close."
    );
    expect(existsSync(resources.started_socket_path)).toBe(false);
    writeResultReport(environment, resources, {
      runtime_alive_after_close: false,
      socket_present_after_close: false,
      lease_released: resources.lease.released,
      database_closed: databaseClosed,
      controller_closed: connectionClosed,
      cleanup_failures: cleanupFailures
    });
  } catch (error) {
    cleanupFailures += await emergencyCleanup({
      connection,
      controller: null,
      approval: null,
      resources,
      databaseClosed,
      connectionClosed
    });
    throw error;
  }
}

async function startWorkerResources(
  environment: HostDeckRestartWorkerEnvironment
): Promise<WorkerResources> {
  const paths = resolveHostDeckLocalPaths({
    state_dir: environment.state_dir,
    config_dir: environment.config_dir,
    runtime_dir: environment.runtime_dir,
    database_path: environment.database_path
  });
  prepareHostDeckDaemonLeasePath(paths);
  const lease = acquireHostDeckDaemonLease({ lease_path: paths.lease_path });
  try {
    prepareHostDeckLocalPathsAfterLease(paths);
    const open = openMigratedDatabase(paths.database_path);
    const repository = createSelectedStateRepository(open.db);
    const foreground = environment.mode.startsWith("foreground_");
    const supervisor = createCodexRuntimeSupervisor(
      foreground
        ? {
            mode: "foreground_child",
            codex_bin: environment.codex_bin,
            socket_path: paths.app_server_socket_path
          }
        : {
            mode: "service_owned",
            socket_path: paths.app_server_socket_path
          }
    );
    try {
      const started = await startSupervisor(supervisor);
      const runtimePid = foreground
        ? await findForegroundRuntimePid(paths.app_server_socket_path)
        : requireServicePid(environment);
      expect(isProcessAlive(runtimePid)).toBe(true);
      return {
        lease,
        open,
        repository,
        supervisor,
        runtime_pid: runtimePid,
        started_socket_path: started.socket_path
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await closeSupervisor(supervisor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        open.db.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "HostDeck restart worker setup and cleanup failed."
        );
      }
      throw error;
    }
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function startSupervisor(
  supervisor: HostDeckCodexRuntimeSupervisor
) {
  const deadline = createOperationDeadline({ timeoutMs: 10_000 });
  try {
    return await supervisor.start({
      deadline,
      resourceBudget: defaultResourceBudget
    });
  } finally {
    deadline.dispose();
  }
}

async function closeSupervisor(
  supervisor: HostDeckCodexRuntimeSupervisor
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs: 5_000 });
  try {
    await supervisor.close({ deadline });
  } finally {
    deadline.dispose();
  }
}

function writeReadyReport(
  environment: HostDeckRestartWorkerEnvironment,
  resources: WorkerResources,
  facts: {
    readonly thread_id: string | null;
    readonly turn_id: string | null;
    readonly generation: number | null;
    readonly boundary_count: number;
    readonly resumed_count: number;
    readonly ready_count: number;
  }
): void {
  const snapshot = resources.supervisor.snapshot();
  expect(snapshot).toMatchObject({
    phase: "ready",
    cleanup_failures: 0
  });
  writeHostDeckRestartWorkerReport(environment.ready_path, {
    schema_version: 1,
    phase: "ready",
    mode: environment.mode,
    hostdeck_pid: process.pid,
    runtime_pid: resources.runtime_pid,
    lease_pid: resources.lease.pid,
    lease_replaced_stale_metadata: resources.lease.replaced_stale_metadata,
    socket_identity: socketIdentity(resources.started_socket_path),
    thread_id: facts.thread_id,
    turn_id: facts.turn_id,
    turn_state: facts.thread_id === null ? null : "in_progress",
    compatibility_state: "ready",
    generation: facts.generation,
    boundary_count: facts.boundary_count,
    resumed_count: facts.resumed_count,
    ready_count: facts.ready_count,
    supervisor: {
      mode: snapshot.mode,
      phase: "ready",
      spawn_attempts: snapshot.spawn_attempts,
      term_signals: snapshot.term_signals,
      kill_signals: snapshot.kill_signals,
      cleanup_failures: snapshot.cleanup_failures
    }
  });
}

function writeResultReport(
  environment: HostDeckRestartWorkerEnvironment,
  resources: WorkerResources,
  facts: {
    readonly runtime_alive_after_close: boolean;
    readonly socket_present_after_close: boolean;
    readonly lease_released: boolean;
    readonly database_closed: boolean;
    readonly controller_closed: boolean;
    readonly cleanup_failures: number;
  }
): void {
  const snapshot = resources.supervisor.snapshot();
  expect(snapshot).toMatchObject({ phase: "closed", cleanup_failures: 0 });
  if (environment.mode.startsWith("service_")) {
    expect(snapshot).toMatchObject({
      mode: "service_owned",
      spawn_attempts: 0,
      term_signals: 0,
      kill_signals: 0
    });
  }
  writeHostDeckRestartWorkerReport(environment.result_path, {
    schema_version: 1,
    phase: "completed",
    mode: environment.mode,
    hostdeck_pid: process.pid,
    runtime_pid: resources.runtime_pid,
    runtime_alive_after_close: facts.runtime_alive_after_close,
    socket_present_after_close: facts.socket_present_after_close,
    lease_released: facts.lease_released,
    database_closed: facts.database_closed,
    controller_closed: facts.controller_closed,
    supervisor_phase: "closed",
    cleanup_failures: facts.cleanup_failures
  });
}

function selectedState(
  threadId: string,
  cwd: string,
  model: string
) {
  const now = new Date().toISOString();
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "restart-continuity",
    codex_thread_id: threadId,
    cwd,
    runtime_source: "codex_app_server",
    runtime_version: codexBindingDescriptor.codex_version,
    disposition: "selected",
    created_at: now,
    updated_at: now,
    archived_at: null
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
    session: {
      id: sessionId,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: now,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: now,
      last_activity_at: now,
      branch: "main",
      model,
      settings: null,
      goal: null,
      recent_summary: "Managed restart-continuity proof.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function selectBoundedModel(models: readonly ModelCatalogEntry[]): {
  readonly model: ModelCatalogEntry;
  readonly reasoning_effort: string;
} {
  const model =
    models.find((candidate) =>
      /mini/iu.test(
        `${candidate.id} ${candidate.runtime_model} ${candidate.label}`
      )
    ) ??
    models.find((candidate) =>
      /spark/iu.test(
        `${candidate.id} ${candidate.runtime_model} ${candidate.label}`
      )
    );
  if (model === undefined) {
    throw new Error(
      "Exact Codex exposes no bounded mini or spark model for restart proof."
    );
  }
  const effort =
    model.reasoning_efforts.find((candidate) => candidate.is_default) ??
    model.reasoning_efforts[0];
  if (effort === undefined) {
    throw new Error("Selected restart-proof model has no reasoning effort.");
  }
  return { model, reasoning_effort: effort.id };
}

function restartPrompt(markerPath: string): string {
  const quoted = `'${markerPath.replaceAll("'", `'"'"'`)}'`;
  return [
    "Use the shell tool exactly once to run this command:",
    `printf started > ${quoted}; sleep 30; printf finished > ${quoted}`,
    "Wait for it to finish, then reply with exactly RESTART_DONE."
  ].join("\n");
}

function parseSharedState(candidate: unknown): SharedServiceState {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new TypeError("HostDeck restart shared state must be a plain object.");
  }
  const record = candidate as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "schema_version,session_id,thread_id,turn_id" ||
    record.schema_version !== 1 ||
    record.session_id !== sessionId ||
    typeof record.thread_id !== "string" ||
    record.thread_id.length < 1 ||
    record.thread_id.length > 256 ||
    typeof record.turn_id !== "string" ||
    record.turn_id.length < 1 ||
    record.turn_id.length > 256
  ) {
    throw new TypeError("HostDeck restart shared state is invalid.");
  }
  return Object.freeze({
    schema_version: 1,
    session_id: sessionId,
    thread_id: record.thread_id,
    turn_id: record.turn_id
  });
}

function monotonicIsoClock(): () => string {
  let last = Date.now();
  return () => {
    last = Math.max(last + 1, Date.now());
    return new Date(last).toISOString();
  };
}

function trackPipeline(
  operation: Promise<unknown>,
  pending: Set<Promise<unknown>>,
  errors: Error[]
): void {
  pending.add(operation);
  void operation.then(
    () => pending.delete(operation),
    (error: unknown) => {
      pending.delete(operation);
      errors.push(asError(error));
    }
  );
}

function assertNoBackgroundErrors(errors: readonly Error[]): void {
  if (errors.length > 0) {
    throw new AggregateError(errors, "HostDeck restart worker background work failed.");
  }
}

async function waitForRelease(
  environment: HostDeckRestartWorkerEnvironment
): Promise<void> {
  if (environment.release_path === null) {
    throw new Error("HostDeck restart worker release path is missing.");
  }
  await waitFor(
    () => {
      if (!existsSync(environment.release_path as string)) return false;
      const metadata = lstatSync(environment.release_path as string);
      return (
        metadata.isFile() &&
        metadata.nlink === 1 &&
        (metadata.mode & 0o077) === 0 &&
        (process.getuid === undefined || metadata.uid === process.getuid())
      );
    },
    30_000,
    "HostDeck restart worker release was not published."
  );
}

async function findForegroundRuntimePid(socketPath: string): Promise<number> {
  return waitForValue(
    () => {
      const matching = readDirectChildProcessIds().filter((pid) => {
        try {
          const commandLine = readBoundedProcessCommandLine(pid);
          return (
            commandLine.includes("app-server") &&
            commandLine.includes(socketPath)
          );
        } catch (error) {
          if (isErrno(error, "ENOENT")) return false;
          throw error;
        }
      });
      if (matching.length > 1) {
        throw new Error("Foreground HostDeck worker has multiple matching runtimes.");
      }
      return matching[0] ?? null;
    },
    5_000,
    "Foreground HostDeck worker did not expose one matching child."
  );
}

async function waitForForegroundChild(
  childrenBefore: ReadonlySet<number>,
  socketPath: string
): Promise<number> {
  return waitForValue(
    () => {
      const matching = readDirectChildProcessIds().filter(
        (pid) =>
          !childrenBefore.has(pid) &&
          readBoundedProcessCommandLine(pid).includes("app-server") &&
          readBoundedProcessCommandLine(pid).includes(socketPath)
      );
      if (matching.length > 1) {
        throw new Error("Foreground restart proof found multiple new runtimes.");
      }
      return matching[0] ?? null;
    },
    5_000,
    "Foreground restart proof did not find its exact child."
  );
}

function requireServicePid(
  environment: HostDeckRestartWorkerEnvironment
): number {
  if (environment.service_pid === null) {
    throw new Error("Service restart worker requires an external runtime pid.");
  }
  return environment.service_pid;
}

function readMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > 32
  ) {
    throw new Error("Restart continuity marker is invalid.");
  }
  return readFileSync(path, "utf8").trim();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started >= timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForValue<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs: number,
  message: string
): Promise<T> {
  const started = Date.now();
  while (true) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() - started >= timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function emergencyCleanup(input: {
  readonly connection: CodexAppServerConnection | null;
  readonly controller: CodexRuntimeReconnectController | null;
  readonly approval: CodexApprovalControlService | null;
  readonly resources: WorkerResources;
  readonly databaseClosed: boolean;
  readonly connectionClosed: boolean;
}): Promise<number> {
  let failures = 0;
  input.approval?.close();
  if (input.controller !== null && !input.connectionClosed) {
    try {
      await input.controller.close();
    } catch {
      failures += 1;
    }
  }
  if (input.connection !== null && !input.connectionClosed) {
    try {
      await input.connection.close("HostDeck restart worker failed.");
    } catch {
      failures += 1;
    }
  }
  try {
    await closeSupervisor(input.resources.supervisor);
  } catch {
    failures += 1;
  }
  if (!input.databaseClosed) {
    try {
      input.resources.open.db.close();
    } catch {
      failures += 1;
    }
  }
  if (!input.resources.lease.released) {
    try {
      input.resources.lease.release();
    } catch {
      failures += 1;
    }
  }
  return failures;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String(error.code) === code
  );
}

function captureLifecycleFailure<TInput, TResult>(
  stage: string,
  callback: (input: TInput) => TResult | Promise<TResult>,
  errors: Array<{
    readonly stage: string;
    readonly name: string;
    readonly code: string | null;
    readonly message: string;
  }>
): (input: TInput) => Promise<TResult> {
  return async (input) => {
    try {
      return await callback(input);
    } catch (error) {
      const failure = asError(error);
      errors.push({
        stage,
        name: failure.name,
        code:
          "code" in failure && typeof failure.code === "string"
            ? failure.code
            : null,
        message: failure.message
      });
      throw error;
    }
  };
}
