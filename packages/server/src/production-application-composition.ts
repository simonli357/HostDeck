import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  type CodexReconnectLifecyclePort,
  type CodexRuntimeReconnectController,
  codexBindingDescriptor,
  codexResourceOptionsFromBudget,
  createCodexApprovalClient,
  createCodexCompactClient,
  createCodexGoalClient,
  createCodexModelClient,
  createCodexPlanClient,
  createCodexRuntimeReconnectController,
  createCodexSkillsClient,
  createCodexThreadClient,
  createCodexTurnClient,
  createCodexUnixWebSocketTransport,
  createCodexUsageClient,
  type HostDeckCodexReconnectError
} from "@hostdeck/codex-adapter";
import {
  assertResolvedResourceBudget,
  type ResourceBudget,
  type RuntimeCompatibility,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import type { OperationDeadline } from "@hostdeck/core";
import {
  type CommittedProjectionAppend,
  createAuthDeviceRepository,
  createDeviceListingRepository,
  createDeviceRevocationRepository,
  createPairingCodeRepository,
  createProductionProjectionAppendPort,
  createProductionProjectionContinuityPort,
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createRuntimeCompatibilityRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSelectedSessionReadRepository,
  createSelectedStateRepository,
  createSettingsRepository,
  type RuntimeCompatibilityRepository,
  runStartupAuditOrphanReconciliation,
  runStartupRetentionMaintenance
} from "@hostdeck/storage";
import {
  createHostDeckApplicationShutdown,
  createHostDeckSelectedWriteShutdownPort,
  type HostDeckApplicationShutdown
} from "./application-shutdown.js";
import {
  type CodexApprovalControlService,
  createCodexApprovalControlService
} from "./codex-approval-control-service.js";
import { createCodexCompactControlService } from "./codex-compact-control-service.js";
import { createCodexControlEventObserver } from "./codex-control-event-observer.js";
import {
  type CodexEventPipeline,
  createCodexEventPipeline
} from "./codex-event-pipeline.js";
import { createCodexGoalControlService } from "./codex-goal-control-service.js";
import { createCodexInterruptControlService } from "./codex-interrupt-control-service.js";
import { createCodexModelControlService } from "./codex-model-control-service.js";
import { createCodexPlanControlService } from "./codex-plan-control-service.js";
import { createCodexPromptControlService } from "./codex-prompt-control-service.js";
import {
  type CodexRuntimeAuditReconciliationInput,
  type CodexRuntimeEventBarrierPort,
  type CodexRuntimeReconciliationLifecycle,
  createCodexRuntimeReconciliationLifecycle
} from "./codex-runtime-reconciliation-lifecycle.js";
import { createCodexSkillsControlService } from "./codex-skills-control-service.js";
import { createCodexUsageControlService } from "./codex-usage-control-service.js";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import type { HostDeckRoutePluginRegistration } from "./fastify-app.js";
import type {
  HostDeckFastifyRuntimeOwner,
  HostDeckFastifyRuntimeStartInput
} from "./fastify-host-lifecycle.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy
} from "./fastify-request-authentication.js";
import {
  createHostDeckStaticBoundaryRegistration,
  hostDeckStaticBoundaryLimits
} from "./fastify-static-boundary.js";
import {
  assertHostDeckProductionResources,
  type HostDeckForegroundBind,
  type HostDeckProductionResources
} from "./foreground-resource-bootstrap.js";
import {
  createHostDeckHostHealthService,
  type HostDeckHostHealthService,
  type HostDeckLocalHealthComponent,
  type HostDeckLocalHealthState,
  type HostDeckReportedLocalHealthReason
} from "./host-health.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import {
  createHostDeckStartupMaintenancePorts,
  type HostDeckStartupMaintenanceSummary,
  runHostDeckStartupMaintenance
} from "./host-startup-maintenance.js";
import { createManagedCodexThreadService } from "./managed-thread-service.js";
import { createHostDeckPairingPolicy } from "./pairing-routes.js";
import { combinePendingTurnSettingsReaders } from "./pending-turn-settings.js";
import {
  createProjectionFanoutHub,
  type ProjectionFanoutHub
} from "./projection-fanout-hub.js";
import { createProjectionReplayLiveHandoffService } from "./projection-replay-live-handoff.js";
import {
  createProjectionSubscriberStreamService,
  type ProjectionSubscriberStreamService
} from "./projection-subscriber-stream.js";
import { createRemoteIngressControlService } from "./remote-ingress-control-service.js";
import {
  createHostDeckRemoteIngressLifecycle,
  type HostDeckRemoteIngressLifecycle
} from "./remote-ingress-lifecycle.js";
import { createHostDeckResumeMetadataReader } from "./resume-metadata.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import {
  createHostDeckSelectedApiRouteComposition,
  hostDeckSelectedApiRouteCompositionDescriptor
} from "./selected-api-route-composition.js";
import {
  createHostDeckSelectedWriteAdmissionPolicy
} from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";
import { createTailscaleObserver } from "./tailscale-observer.js";
import { createTailscaleServeManager } from "./tailscale-serve-manager.js";

export const hostDeckProductionStaticRegistrationId =
  "hostdeck-production-static" as const;

export const hostDeckProductionApplicationPhases = Object.freeze([
  "assembled",
  "starting",
  "runtime_ready",
  "draining",
  "closed",
  "failed"
] as const);

export type HostDeckProductionApplicationPhase =
  (typeof hostDeckProductionApplicationPhases)[number];

export const hostDeckProductionApplicationIssueSources = Object.freeze([
  "approval",
  "fanout",
  "process",
  "projection",
  "protocol",
  "reconnect",
  "sse",
  "subscriber"
] as const);

export type HostDeckProductionApplicationIssueSource =
  (typeof hostDeckProductionApplicationIssueSources)[number];

export interface HostDeckProductionApplicationIssue {
  readonly source: HostDeckProductionApplicationIssueSource;
  readonly code: string;
}

export interface CreateHostDeckProductionApplicationInput {
  readonly browser_routes: readonly `/${string}`[];
  readonly observe_issue: (issue: HostDeckProductionApplicationIssue) => void;
  readonly resources: HostDeckProductionResources;
  readonly static_build_root: string;
}

export interface HostDeckProductionListenerHealthPort {
  readonly beginDrain: () => void;
  readonly closed: () => void;
  readonly ready: () => void;
  readonly failed: () => void;
  readonly snapshot: () => "not_ready" | "ready" | "draining" | "closed" | "failed";
}

export interface HostDeckProductionApplicationSnapshot {
  readonly phase: HostDeckProductionApplicationPhase;
  readonly route_registration_count: 23;
  readonly api_registration_count: 21;
  readonly sse_registration_count: 1;
  readonly static_registration_count: 1;
  readonly reported_issue_count: number;
  readonly observer_failure_count: number;
  readonly last_issue: HostDeckProductionApplicationIssue | null;
  readonly startup_maintenance: HostDeckStartupMaintenanceSummary | null;
  readonly reconnect: ReturnType<CodexRuntimeReconnectController["snapshot"]>;
  readonly reconciliation: ReturnType<CodexRuntimeReconciliationLifecycle["snapshot"]>;
  readonly shutdown: ReturnType<HostDeckApplicationShutdown["snapshot"]>;
}

export interface HostDeckProductionApplication {
  readonly authentication: HostDeckRequestAuthenticationPolicy;
  readonly bind: HostDeckForegroundBind;
  readonly health: HostDeckHostHealthService;
  readonly listener: HostDeckProductionListenerHealthPort;
  readonly remote: HostDeckRemoteIngressLifecycle;
  readonly resource_budget: ResourceBudget;
  readonly route_registrations: readonly HostDeckRoutePluginRegistration[];
  readonly runtime: HostDeckFastifyRuntimeOwner<HostDeckProductionApplication>;
  readonly shutdown: HostDeckApplicationShutdown;
  readonly snapshot: () => HostDeckProductionApplicationSnapshot;
}

interface ParsedCompositionInput {
  readonly browserRoutes: readonly `/${string}`[];
  readonly observeIssue: CreateHostDeckProductionApplicationInput["observe_issue"];
  readonly resources: HostDeckProductionResources;
  readonly staticBuildRoot: string;
}

interface IssueRuntime {
  count: number;
  observerFailures: number;
  last: HostDeckProductionApplicationIssue | null;
}

interface LocalHealthSource {
  readonly update: (
    component: HostDeckLocalHealthComponent,
    state: HostDeckLocalHealthState,
    reasons: readonly HostDeckReportedLocalHealthReason[]
  ) => void;
}

const acceptedApplications = new WeakSet<object>();
const inputKeys = [
  "browser_routes",
  "observe_issue",
  "resources",
  "static_build_root"
] as const;
const runtimeStartKeys = ["deadline", "resourceBudget"] as const;
const issueCodePattern = /^[a-z][a-z0-9_]{0,119}$/u;
const maximumCounter = Number.MAX_SAFE_INTEGER;

export function createHostDeckProductionApplication(
  input: CreateHostDeckProductionApplicationInput
): HostDeckProductionApplication {
  const parsed = parseCompositionInput(input);
  const staticRoute = createHostDeckStaticBoundaryRegistration({
    browserRoutes: parsed.browserRoutes,
    buildRoot: parsed.staticBuildRoot,
    id: hostDeckProductionStaticRegistrationId
  });
  const resources = parsed.resources;
  const budget = resources.resource_budget;
  const db = resources.database;
  const issues: IssueRuntime = {
    count: 0,
    observerFailures: 0,
    last: null
  };
  const report = (
    source: HostDeckProductionApplicationIssueSource,
    code: string
  ): void => {
    const issue = Object.freeze({
      source,
      code: issueCodePattern.test(code) ? code : "internal_error"
    });
    issues.count = increment(issues.count);
    issues.last = issue;
    try {
      parsed.observeIssue(issue);
    } catch {
      issues.observerFailures = increment(issues.observerFailures);
    }
  };
  const auditTimestamp = createAuditTimestampClock();

  const settingsRepository = createSettingsRepository(db);
  const settings = settingsRepository.getOrCreateDefault({
    bindPort: resources.bind.port,
    now: readNow,
    stateDir: resources.paths.state_dir
  });
  if (
    settings.bind_port !== resources.bind.port ||
    settings.state_dir !== resources.paths.state_dir
  ) {
    throw new TypeError(
      "Durable HostDeck settings contradict the foreground bind or state directory."
    );
  }

  const stateRepository = createSelectedStateRepository(db);
  const sessionReadRepository = createSelectedSessionReadRepository(db);
  const auditRepository = createSelectedAuditRepository(db);
  const compatibilityRepository = createRuntimeCompatibilityRepository(db);
  const authRepository = createAuthDeviceRepository(db);
  const csrfRepository = createSelectedCsrfAuthorizationRepository(db);
  const pairingRepository = createPairingCodeRepository(db, { policy: budget });
  const deviceListingRepository = createDeviceListingRepository(db);
  const deviceRevocationRepository = createDeviceRevocationRepository(db);
  const remoteStateRepository = createRemoteIngressStateRepository(db);
  const remoteAdmissionRepository =
    createRemoteIngressAdmissionProofRepository(db);

  const health = createHostDeckHostHealthService({ now: readNow });
  const localHealth = createLocalHealthSource(health);
  const attemptLocalHealthUpdate = (
    component: HostDeckLocalHealthComponent,
    state: HostDeckLocalHealthState,
    reasons: readonly HostDeckReportedLocalHealthReason[],
    source: HostDeckProductionApplicationIssueSource
  ): void => {
    try {
      localHealth.update(component, state, reasons);
    } catch (error) {
      report(source, errorCode(error, "health_update_failed"));
    }
  };
  localHealth.update("lease", "ready", []);
  localHealth.update("projector", "ready", []);
  localHealth.update("fanout", "ready", []);
  localHealth.update("runtime", "degraded", ["runtime_starting"]);
  localHealth.update("compatibility", "unknown", [
    "compatibility_unchecked"
  ]);
  localHealth.update("listener", "degraded", ["listener_not_ready"]);

  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: (authenticationInput) =>
      authRepository.authenticateDeviceToken(authenticationInput),
    now: readNow
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: csrfRepository,
    now: readNow
  });
  const lock = createHostDeckHostLockPolicy({
    settings: Object.freeze({
      read: () => settingsRepository.readHostLock(),
      transition: (
        transition: Parameters<typeof settingsRepository.transitionHostLock>[0]
      ) =>
        settingsRepository.transitionHostLock(transition)
    }),
    now: readNow
  });
  const pairing = createHostDeckPairingPolicy({
    pairing: Object.freeze({
      issue: (pairingInput: Parameters<typeof pairingRepository.issue>[0]) =>
        pairingRepository.issue(pairingInput),
      claim: (claimInput: Parameters<typeof pairingRepository.claim>[0]) =>
        pairingRepository.claim(claimInput)
    }),
    now: readNow
  });
  const selectedAudit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: auditTimestamp,
    create_record_id: createAuditRecordId
  });
  const securityAudit = createSecurityMutationAuditExecutor({
    repository: auditRepository,
    now: auditTimestamp,
    create_record_id: createAuditRecordId
  });
  const admission = createHostDeckSelectedWriteAdmissionPolicy({
    resourceBudget: budget,
    now: () => performance.now(),
    health
  });

  const fanout = createProjectionFanoutHub({
    max_subscribers: budget.sse_max_subscribers,
    max_subscribers_per_session: budget.sse_max_subscribers_per_session
  });
  const publish = (committed: CommittedProjectionAppend): void => {
    try {
      fanout.publish(committed);
    } catch (error) {
      attemptLocalHealthUpdate(
        "fanout",
        "failed",
        ["fanout_failed"],
        "fanout"
      );
      report("fanout", errorCode(error, "publication_failed"));
      throw error;
    }
  };
  const projection = createProductionProjectionAppendPort({
    repository: stateRepository,
    publish
  });
  const continuity = createProductionProjectionContinuityPort({
    repository: stateRepository,
    publish
  });
  const handoff = createProjectionReplayLiveHandoffService({
    authorize: ({ authorization }) => {
      const result = selectedRequestAuthenticationContextSchema.safeParse(
        authorization
      );
      return result.success &&
          (result.data.state === "local_admin" ||
            result.data.state === "paired_device")
        ? Object.freeze({ ok: true as const })
        : Object.freeze({ ok: false as const });
    },
    fanout,
    resource_budget: budget,
    state: stateRepository
  });
  const subscribers = createProjectionSubscriberStreamService({
    handoff,
    observe_failure: (failure) => report("subscriber", failure.code),
    resource_budget: budget
  });

  const lifecycleRelay = createLifecycleRelay();
  let eventPipeline: CodexEventPipeline | null = null;
  let approvalControl: CodexApprovalControlService | null = null;
  let reconnect: CodexRuntimeReconnectController | null = null;
  const resourceOptions = codexResourceOptionsFromBudget(budget);
  const transport = createCodexUnixWebSocketTransport({
    socket_path: resources.runtime.socket_path,
    ...resourceOptions.transport
  });
  reconnect = createCodexRuntimeReconnectController({
    transport,
    observed_version: codexBindingDescriptor.codex_version,
    resource_budget: budget,
    lifecycle: lifecycleRelay.lifecycle,
    on_notification: (notification) => {
      const pipeline = requireBound(eventPipeline, "Codex event pipeline");
      const controller = requireBound(reconnect, "Codex reconnect controller");
      void pipeline.consume(notification, controller.generation).catch((error: unknown) => {
        attemptLocalHealthUpdate(
          "projector",
          "failed",
          ["projector_failed"],
          "projection"
        );
        report("projection", errorCode(error, "event_pipeline_failed"));
      });
    },
    on_server_request: (request) => {
      try {
        requireBound(approvalControl, "Codex approval control").register(
          request
        );
      } catch (error) {
        report("approval", errorCode(error, "registration_failed"));
        throw error;
      }
    },
    on_protocol_issue: (issue) => report("protocol", issue.code),
    on_background_error: (error) => reportReconnectFailure(report, error)
  });
  const reconnectController = reconnect;

  const threadClient = createCodexThreadClient(
    reconnectController,
    resourceOptions.thread
  );
  const turnClient = createCodexTurnClient(reconnectController, {
    interrupt_timeout_ms: budget.protocol_mutation_timeout_ms,
    start_timeout_ms: budget.protocol_start_timeout_ms,
    steer_timeout_ms: budget.protocol_mutation_timeout_ms
  });
  const modelClient = createCodexModelClient(
    reconnectController,
    resourceOptions.model
  );
  const goalClient = createCodexGoalClient(reconnectController, {
    mutation_timeout_ms: budget.protocol_mutation_timeout_ms,
    read_timeout_ms: budget.protocol_read_timeout_ms
  });
  const planClient = createCodexPlanClient(
    reconnectController,
    resourceOptions.plan
  );
  const compactClient = createCodexCompactClient(
    reconnectController,
    resourceOptions.compact
  );
  const usageClient = createCodexUsageClient(
    reconnectController,
    resourceOptions.usage
  );
  const skillsClient = createCodexSkillsClient(
    reconnectController,
    resourceOptions.skills
  );
  const approvalClient = createCodexApprovalClient(
    reconnectController,
    resourceOptions.approval
  );

  const modelControl = createCodexModelControlService({
    models: modelClient,
    states: stateRepository,
    max_pending_selections: budget.control_model_max_pending_selections,
    now: auditTimestamp
  });
  const planControl = createCodexPlanControlService({
    plans: planClient,
    models: modelControl,
    states: stateRepository,
    max_pending_selections: budget.control_plan_max_pending_selections,
    now: auditTimestamp
  });
  const pendingSettings = combinePendingTurnSettingsReaders([
    modelControl,
    planControl
  ]);
  const goalControl = createCodexGoalControlService({
    goals: goalClient,
    states: stateRepository,
    pending_settings: pendingSettings,
    max_uncertain_mutations: budget.control_goal_max_uncertain_mutations,
    now: auditTimestamp
  });
  const promptControl = createCodexPromptControlService({
    turns: turnClient,
    models: modelControl,
    plans: planControl,
    states: stateRepository,
    max_tracked_turns: budget.control_prompt_max_tracked_turns,
    now: auditTimestamp
  });
  const compactControl = createCodexCompactControlService({
    compact: compactClient,
    states: stateRepository,
    max_tracked_operations: budget.control_compact_max_tracked_operations,
    now: auditTimestamp
  });
  const usageControl = createCodexUsageControlService({
    usage: usageClient,
    states: stateRepository,
    max_tracked_threads: budget.control_usage_max_tracked_threads
  });
  const skillsControl = createCodexSkillsControlService({
    skills: skillsClient,
    states: stateRepository
  });
  approvalControl = createCodexApprovalControlService({
    approvals: approvalClient,
    states: stateRepository,
    expiry_ms: budget.control_approval_expiry_ms,
    max_tracked_approvals: budget.protocol_max_pending_server_requests,
    now: auditTimestamp,
    on_background_error: (error) =>
      report("approval", errorCode(error, "background_failure"))
  });
  const interruptControl = createCodexInterruptControlService({
    turns: turnClient,
    states: stateRepository,
    max_tracked_turns: budget.control_interrupt_max_tracked_turns,
    now: auditTimestamp
  });
  const controlsObserver = createCodexControlEventObserver({
    approvals: approvalControl,
    compact: compactControl,
    goals: goalControl,
    interrupts: interruptControl,
    plans: planControl,
    prompts: promptControl,
    usage: usageControl
  });
  eventPipeline = createCodexEventPipeline({
    repository: stateRepository,
    append_port: projection,
    max_pending_notifications:
      resourceOptions.event_pipeline.max_pending_notifications,
    async observe_event(event, generation) {
      await controlsObserver.observe(event, generation);
    }
  });
  const pipeline = eventPipeline;

  const reconciliation = createCodexRuntimeReconciliationLifecycle({
    approvals: approvalControl,
    audit: Object.freeze({
      reconcile: ({
        eligible_before,
        reconciled_at,
        deadline
      }: CodexRuntimeAuditReconciliationInput) =>
        runStartupAuditOrphanReconciliation({
          db,
          eligible_before,
          reconciled_at,
          signal: deadline.signal,
          timeout_ms: deadline.timeoutMs()
        })
    }),
    continuity,
    events: Object.freeze({
      async barrier({
        signal
      }: Parameters<CodexRuntimeEventBarrierPort["barrier"]>[0]) {
        return pipeline.barrier(signal);
      },
      async reconcile({
        threads,
        signal
      }: Parameters<CodexRuntimeEventBarrierPort["reconcile"]>[0]) {
        return pipeline.reconcile(threads, signal);
      }
    }),
    now: auditTimestamp,
    plans: planControl,
    projection,
    repository: stateRepository,
    resource_budget: budget
  });
  lifecycleRelay.bind(
    createHealthAwareReconciliationLifecycle({
      compatibilityRepository,
      health: localHealth,
      reconciliation,
      report
    })
  );

  const managedSessions = createManagedCodexThreadService({
    threads: threadClient,
    states: stateRepository,
    now: readNow
  });
  const runtimeView = Object.freeze({
    read: () => reconnectController.compatibility
  });
  const resume = createHostDeckResumeMetadataReader({
    codexBin: resources.codex_bin,
    runtime: runtimeView,
    socketPath: resources.runtime.socket_path,
    state: functionView(stateRepository, ["require"])
  });

  const remote = createHostDeckRemoteIngressLifecycle({
    health,
    createControl: ({ monotonicNow, signal }) => {
      const observer = createTailscaleObserver({
        signal,
        resourceBudget: budget,
        now: readNow,
        monotonicNow
      });
      const manager = createTailscaleServeManager({
        observer,
        signal,
        resourceBudget: budget
      });
      return createRemoteIngressControlService({
        admissionProofs: remoteAdmissionRepository,
        audit: securityAudit,
        localOrigin: `http://${resources.bind.host}:${resources.bind.port}`,
        manager,
        monotonicNow,
        now: readNow,
        observer,
        states: remoteStateRepository
      });
    }
  });

  const selectedRoutes = createHostDeckSelectedApiRouteComposition({
    admission,
    audit: selectedAudit,
    authentication,
    controls: Object.freeze({
      approvals: functionView(approvalControl, [
        "list",
        "respond",
        "snapshot",
        "waitForTerminal"
      ]),
      compact: functionView(compactControl, ["compact", "snapshot"]),
      goals: functionView(goalControl, ["mutate", "snapshot"]),
      interrupts: functionView(interruptControl, [
        "interrupt",
        "requireInterruptible",
        "waitForTerminal"
      ]),
      models: functionView(modelControl, ["select", "snapshot"]),
      plans: functionView(planControl, ["select", "snapshot"]),
      prompts: functionView(promptControl, ["dispatch", "snapshot"]),
      skills: functionView(skillsControl, ["list"]),
      usage: functionView(usageControl, ["read"])
    }),
    csrf,
    devices: Object.freeze({
      list: deviceListingRepository.list,
      revoke: deviceRevocationRepository.revoke
    }),
    health,
    lock,
    now: readNow,
    observeSseError: (observation) => report("sse", observation.code),
    pairing,
    remote: remote.control,
    runtimes: Object.freeze({
      approvals: runtimeView,
      compact: runtimeView,
      goals: runtimeView,
      interrupts: runtimeView,
      models: runtimeView,
      plans: runtimeView,
      prompts: runtimeView,
      sessionArchive: runtimeView,
      sessionStart: runtimeView
    }),
    securityAudit,
    sessions: Object.freeze({
      managed: functionView(managedSessions, ["archive", "read", "start"]),
      read: sessionReadRepository,
      resume,
      subscribers
    }),
    state: functionView(stateRepository, ["get", "listEvents", "require"])
  });
  const routeRegistrations = Object.freeze([
    ...selectedRoutes,
    staticRoute
  ]) as readonly HostDeckRoutePluginRegistration[];
  assertRouteInventory(routeRegistrations);

  const startupMaintenancePorts = createHostDeckStartupMaintenancePorts({
    reconcileAuditOrphans: ({
      eligible_before,
      reconciled_at,
      signal
    }) =>
      runStartupAuditOrphanReconciliation({
        db,
        eligible_before,
        reconciled_at,
        signal,
        timeout_ms: budget.lifecycle_startup_timeout_ms
      }),
    runRetention: ({ cutoff_at, signal }) =>
      runStartupRetentionMaintenance({
        db,
        now: () => new Date(cutoff_at),
        retention: settings.retention,
        signal,
        timeout_ms: budget.lifecycle_startup_timeout_ms
      })
  });
  const writeShutdown = createHostDeckSelectedWriteShutdownPort({ admission });
  const shutdown = createHostDeckApplicationShutdown({
    approvals: Object.freeze({
      close(deadline: OperationDeadline) {
        deadline.throwIfAborted();
        approvalControl.close();
      }
    }),
    audit: createAuditShutdownPort(db, auditTimestamp),
    lease: resources.shutdown.lease,
    projection: createProjectionShutdownPort({
      fanout,
      health: localHealth,
      pipeline
    }),
    reconnect: Object.freeze({
      async close(deadline: OperationDeadline) {
        deadline.throwIfAborted();
        await reconnectController.close();
      }
    }),
    resource_budget: budget,
    storage: resources.shutdown.storage,
    subscribers: createSubscriberShutdownPort(subscribers),
    supervisor: resources.shutdown.supervisor,
    writes: writeShutdown
  });

  let phase: HostDeckProductionApplicationPhase = "assembled";
  let startupMaintenance: HostDeckStartupMaintenanceSummary | null = null;
  let startPromise: Promise<void> | null = null;
  let application: HostDeckProductionApplication;
  const listener = createListenerHealthPort(localHealth, () => phase);

  const start = (deadline: OperationDeadline): Promise<void> => {
    if (startPromise !== null) return startPromise;
    assertOperationDeadline(deadline);
    if (phase !== "assembled") {
      return Promise.reject(
        new TypeError("HostDeck production application can start only once.")
      );
    }
    phase = "starting";
    startPromise = (async () => {
      try {
        await reconnectController.start(deadline.signal);
        deadline.throwIfAborted();
        startupMaintenance = await runHostDeckStartupMaintenance({
          now: readNow,
          ports: startupMaintenancePorts,
          signal: deadline.signal
        });
        localHealth.update(
          "storage",
          startupMaintenance.storage_observation.state,
          startupMaintenance.storage_observation.reasons
        );
        if (startupMaintenance.status !== "ready") {
          throw new TypeError(
            "HostDeck startup maintenance did not establish ready storage."
          );
        }
        if (pipeline.failure !== null || fanout.failure !== null || fanout.closed) {
          throw new TypeError(
            "HostDeck projection graph is unavailable before listener startup."
          );
        }
        phase = "runtime_ready";
      } catch (error) {
        phase = "failed";
        attemptLocalHealthUpdate(
          "runtime",
          "failed",
          ["runtime_failed"],
          "reconnect"
        );
        report("reconnect", errorCode(error, "startup_failed"));
        throw error;
      }
    })();
    return startPromise;
  };

  const runtime: HostDeckFastifyRuntimeOwner<HostDeckProductionApplication> =
    Object.freeze({
      beginDrain() {
        if (phase !== "closed") phase = "draining";
        const errors: unknown[] = [];
        try {
          shutdown.beginDrain();
        } catch (error) {
          errors.push(error);
        }
        try {
          listener.beginDrain();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            "HostDeck application admission and listener drain failed."
          );
        }
      },
      closeSse: shutdown.closeSse,
      closeRuntime: shutdown.closeRuntime,
      async closeStartup(deadline: OperationDeadline) {
        try {
          await shutdown.closeStartup(deadline);
          phase = "closed";
          listener.closed();
        } catch (error) {
          phase = "failed";
          listener.failed();
          throw error;
        }
      },
      async start(rawInput: HostDeckFastifyRuntimeStartInput) {
        const startInput = parseRuntimeStartInput(rawInput, budget);
        await start(startInput.deadline);
        return Object.freeze({ bind: resources.bind, context: application });
      }
    });

  const snapshot = (): HostDeckProductionApplicationSnapshot =>
    Object.freeze({
      phase,
      route_registration_count: 23 as const,
      api_registration_count: 21 as const,
      sse_registration_count: 1 as const,
      static_registration_count: 1 as const,
      reported_issue_count: issues.count,
      observer_failure_count: issues.observerFailures,
      last_issue: issues.last,
      startup_maintenance: startupMaintenance,
      reconnect: reconnectController.snapshot(),
      reconciliation: reconciliation.snapshot(),
      shutdown: shutdown.snapshot()
    });

  application = Object.freeze({
    authentication,
    bind: resources.bind,
    health,
    listener,
    remote,
    resource_budget: budget,
    route_registrations: routeRegistrations,
    runtime,
    shutdown,
    snapshot
  });
  acceptedApplications.add(application);

  if (resources.runtime.process_exit !== null) {
    const failRuntimeExit = (code: string): void => {
      if (phase === "closed" || phase === "draining") return;
      phase = "failed";
      attemptLocalHealthUpdate(
        "runtime",
        "failed",
        ["runtime_failed"],
        "process"
      );
      report("process", code);
    };
    void resources.runtime.process_exit.then(
      (observation) => {
        if (
          observation.expected ||
          phase === "closed" ||
          phase === "draining"
        ) {
          return;
        }
        failRuntimeExit("runtime_exited");
      },
      () => failRuntimeExit("runtime_exit_observation_failed")
    );
  }

  return application;
}

export function assertHostDeckProductionApplication(
  candidate: unknown
): asserts candidate is HostDeckProductionApplication {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedApplications.has(candidate)
  ) {
    throw new TypeError(
      "HostDeck production application must be created by its composition factory."
    );
  }
}

function parseCompositionInput(input: unknown): ParsedCompositionInput {
  const values = readExactDataObject(
    input,
    inputKeys,
    "HostDeck production application input is invalid."
  );
  assertHostDeckProductionResources(values.resources);
  const resources = values.resources;
  assertResolvedResourceBudget(resources.resource_budget);
  const resourceSnapshot = resources.snapshot();
  if (
    resourceSnapshot.phase !== "ready" ||
    !resourceSnapshot.database_open ||
    !resourceSnapshot.lease_held ||
    !resources.database.open
  ) {
    throw new TypeError(
      "HostDeck production resources are not ready for application composition."
    );
  }
  if (typeof values.observe_issue !== "function") {
    throw new TypeError(
      "HostDeck production application issue observer is invalid."
    );
  }
  if (typeof values.static_build_root !== "string") {
    throw new TypeError("HostDeck production static build root is invalid.");
  }
  return Object.freeze({
    browserRoutes: copyBrowserRoutes(values.browser_routes),
    observeIssue: values.observe_issue as ParsedCompositionInput["observeIssue"],
    resources,
    staticBuildRoot: values.static_build_root
  });
}

function copyBrowserRoutes(candidate: unknown): readonly `/${string}`[] {
  try {
    return copyBrowserRouteData(candidate);
  } catch {
    throw new TypeError("HostDeck production browser routes are invalid.");
  }
}

function copyBrowserRouteData(candidate: unknown): readonly `/${string}`[] {
  if (
    !Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Array.prototype
  ) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(
    candidate
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  const lengthValue: unknown = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthValue !== "number" ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 1 ||
    lengthValue > hostDeckStaticBoundaryLimits.maxBrowserRoutes
  ) {
    throw new TypeError();
  }
  const length = lengthValue;
  const expectedKeys = new Set<string>([
    "length",
    ...Array.from({ length }, (_, index) => String(index))
  ]);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.size ||
    keys.some(
      (key) => typeof key !== "string" || !expectedKeys.has(key)
    )
  ) {
    throw new TypeError();
  }
  const routes: `/${string}`[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError();
    }
    routes.push(descriptor.value as `/${string}`);
  }
  return Object.freeze(routes);
}

function parseRuntimeStartInput(
  input: unknown,
  expectedBudget: ResourceBudget
): Readonly<{
  readonly deadline: OperationDeadline;
  readonly resourceBudget: ResourceBudget;
}> {
  const values = readExactDataObject(
    input,
    runtimeStartKeys,
    "HostDeck production runtime-start input is invalid."
  );
  assertOperationDeadline(values.deadline);
  assertResolvedResourceBudget(values.resourceBudget);
  if (values.resourceBudget !== expectedBudget) {
    throw new TypeError(
      "HostDeck production runtime must use its composed resource budget."
    );
  }
  return Object.freeze({
    deadline: values.deadline,
    resourceBudget: values.resourceBudget
  });
}

function createLocalHealthSource(
  health: HostDeckHostHealthService
): LocalHealthSource {
  const generations = new Map<HostDeckLocalHealthComponent, number>();
  return Object.freeze({
    update(
      component: HostDeckLocalHealthComponent,
      state: HostDeckLocalHealthState,
      reasons: readonly HostDeckReportedLocalHealthReason[]
    ) {
      const sourceGeneration = (generations.get(component) ?? 0) + 1;
      health.updateLocal({
        component,
        state,
        reasons,
        source_generation: sourceGeneration
      });
      generations.set(component, sourceGeneration);
    }
  });
}

function createLifecycleRelay(): Readonly<{
  readonly bind: (lifecycle: CodexReconnectLifecyclePort) => void;
  readonly lifecycle: CodexReconnectLifecyclePort;
}> {
  let target: CodexReconnectLifecyclePort | null = null;
  const requireTarget = (): CodexReconnectLifecyclePort =>
    requireBound(target, "Codex reconnect lifecycle");
  const lifecycle: CodexReconnectLifecyclePort = Object.freeze({
    disconnected: (
      input: Parameters<CodexReconnectLifecyclePort["disconnected"]>[0]
    ) => requireTarget().disconnected(input),
    reconcile: (
      input: Parameters<CodexReconnectLifecyclePort["reconcile"]>[0]
    ) => requireTarget().reconcile(input),
    resubscribe: (
      input: Parameters<CodexReconnectLifecyclePort["resubscribe"]>[0]
    ) => requireTarget().resubscribe(input),
    ready: (input: Parameters<CodexReconnectLifecyclePort["ready"]>[0]) =>
      requireTarget().ready(input)
  });
  return Object.freeze({
    lifecycle,
    bind(candidate) {
      if (target !== null) {
        throw new TypeError("Codex reconnect lifecycle is already bound.");
      }
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        typeof candidate.disconnected !== "function" ||
        typeof candidate.reconcile !== "function" ||
        typeof candidate.resubscribe !== "function" ||
        typeof candidate.ready !== "function"
      ) {
        throw new TypeError("Codex reconnect lifecycle binding is invalid.");
      }
      target = candidate;
    }
  });
}

function createHealthAwareReconciliationLifecycle(input: {
  readonly compatibilityRepository: RuntimeCompatibilityRepository;
  readonly health: LocalHealthSource;
  readonly reconciliation: CodexRuntimeReconciliationLifecycle;
  readonly report: (
    source: HostDeckProductionApplicationIssueSource,
    code: string
  ) => void;
}): CodexReconnectLifecyclePort {
  const failRuntime = (error: unknown): void => {
    try {
      input.health.update("runtime", "failed", ["runtime_failed"]);
    } catch (healthError) {
      input.report(
        "reconnect",
        errorCode(healthError, "health_update_failed")
      );
    }
    input.report("reconnect", errorCode(error, "reconciliation_failed"));
  };
  return Object.freeze({
    async disconnected(
      disconnectedInput: Parameters<
        CodexReconnectLifecyclePort["disconnected"]
      >[0]
    ) {
      try {
        input.health.update("runtime", "degraded", ["runtime_disconnected"]);
        input.health.update("compatibility", "degraded", [
          "compatibility_degraded"
        ]);
        await input.reconciliation.disconnected(disconnectedInput);
      } catch (error) {
        failRuntime(error);
        throw error;
      }
    },
    async reconcile(
      reconcileInput: Parameters<CodexReconnectLifecyclePort["reconcile"]>[0]
    ) {
      try {
        input.health.update("runtime", "degraded", ["runtime_reconciling"]);
        input.health.update("compatibility", "unknown", [
          "compatibility_unchecked"
        ]);
        return await input.reconciliation.reconcile(reconcileInput);
      } catch (error) {
        failRuntime(error);
        throw error;
      }
    },
    async resubscribe(
      resubscribeInput: Parameters<
        CodexReconnectLifecyclePort["resubscribe"]
      >[0]
    ) {
      try {
        await input.reconciliation.resubscribe(resubscribeInput);
      } catch (error) {
        failRuntime(error);
        throw error;
      }
    },
    async ready(
      readyInput: Parameters<CodexReconnectLifecyclePort["ready"]>[0]
    ) {
      try {
        await input.reconciliation.ready(readyInput);
        persistCompatibility(
          input.compatibilityRepository,
          readyInput.compatibility
        );
        if (
          readyInput.compatibility.state !== "ready" ||
          readyInput.compatibility.mutation_policy !== "allowed" ||
          readyInput.compatibility.binding_id !==
            codexBindingDescriptor.binding_id ||
          readyInput.compatibility.observed_version !==
            codexBindingDescriptor.codex_version
        ) {
          input.health.update("compatibility", "failed", [
            "runtime_incompatible"
          ]);
          throw new TypeError(
            "Codex compatibility is not exact after runtime reconciliation."
          );
        }
        input.health.update("compatibility", "ready", []);
        input.health.update("runtime", "ready", []);
      } catch (error) {
        failRuntime(error);
        throw error;
      }
    }
  });
}

function persistCompatibility(
  repository: RuntimeCompatibilityRepository,
  compatibility: RuntimeCompatibility
): void {
  const checkedAt = Date.parse(compatibility.checked_at);
  const now = readNow().getTime();
  if (!Number.isFinite(checkedAt) || now < checkedAt) {
    throw new TypeError(
      "Runtime compatibility recording time contradicts its check time."
    );
  }
  const current = repository.get();
  const currentRecordedAt =
    current === null ? Number.NEGATIVE_INFINITY : Date.parse(current.recorded_at);
  if (now < currentRecordedAt) {
    throw new TypeError(
      "Runtime compatibility recording time regressed behind durable state."
    );
  }
  repository.put({
    id: "hostdeck_runtime",
    compatibility,
    recorded_at: new Date(
      current !== null && now === currentRecordedAt ? now + 1 : now
    ).toISOString()
  });
}

function createAuditShutdownPort(
  db: HostDeckProductionResources["database"],
  timestamp: () => string
): Readonly<{
  readonly barrier: (deadline: OperationDeadline) => Readonly<{
    readonly pending_operations: 0;
    readonly reconciled_operations: number;
  }>;
}> {
  return Object.freeze({
    barrier(deadline) {
      deadline.throwIfAborted();
      const cutoff = timestamp();
      const result = runStartupAuditOrphanReconciliation({
        db,
        eligible_before: cutoff,
        reconciled_at: cutoff,
        signal: deadline.signal,
        timeout_ms: deadline.timeoutMs()
      });
      deadline.throwIfAborted();
      if (
        result.status !== "complete" ||
        !result.scan_complete ||
        result.actionable_remaining !== false ||
        result.total_pending_operation_count !== 0
      ) {
        throw new TypeError(
          "HostDeck audit shutdown barrier retained pending operations."
        );
      }
      return Object.freeze({
        pending_operations: 0 as const,
        reconciled_operations: result.reconciled_operation_count
      });
    }
  });
}

function createProjectionShutdownPort(input: {
  readonly fanout: ProjectionFanoutHub;
  readonly health: LocalHealthSource;
  readonly pipeline: CodexEventPipeline;
}): Readonly<{
  readonly barrier: (deadline: OperationDeadline) => Promise<Readonly<{
    readonly last_sequence: number;
    readonly pending_notifications: 0;
  }>>;
}> {
  return Object.freeze({
    async barrier(deadline) {
      deadline.throwIfAborted();
      const barrier = await input.pipeline.barrier(deadline.signal);
      deadline.throwIfAborted();
      if (input.pipeline.pending_count !== 0) {
        throw new TypeError(
          "HostDeck projection shutdown barrier retained notifications."
        );
      }
      input.fanout.close();
      input.health.update("fanout", "failed", ["fanout_closed"]);
      return Object.freeze({
        last_sequence: barrier.last_sequence,
        pending_notifications: 0 as const
      });
    }
  });
}

function createSubscriberShutdownPort(
  subscribers: ProjectionSubscriberStreamService
): Readonly<{ readonly close: (deadline: OperationDeadline) => void }> {
  return Object.freeze({
    close(deadline) {
      deadline.throwIfAborted();
      subscribers.close();
    }
  });
}

function createListenerHealthPort(
  health: LocalHealthSource,
  applicationPhase: () => HostDeckProductionApplicationPhase
): HostDeckProductionListenerHealthPort {
  let state: ReturnType<HostDeckProductionListenerHealthPort["snapshot"]> =
    "not_ready";
  return Object.freeze({
    beginDrain() {
      if (state === "draining" || state === "closed" || state === "failed") {
        return;
      }
      health.update("listener", "degraded", ["listener_draining"]);
      state = "draining";
    },
    closed() {
      if (state === "closed" || state === "failed") return;
      if (state !== "draining") {
        throw new TypeError(
          "HostDeck listener cannot close before application drain."
        );
      }
      health.update("listener", "failed", ["listener_closed"]);
      state = "closed";
    },
    ready() {
      if (state !== "not_ready" || applicationPhase() !== "runtime_ready") {
        throw new TypeError(
          "HostDeck listener cannot become ready before the production runtime."
        );
      }
      health.update("listener", "ready", []);
      state = "ready";
    },
    failed() {
      if (state === "failed" || state === "closed") return;
      health.update("listener", "failed", ["listener_failed"]);
      state = "failed";
    },
    snapshot: () => state
  });
}

function assertRouteInventory(
  registrations: readonly HostDeckRoutePluginRegistration[]
): void {
  const selectedCount = hostDeckSelectedApiRouteCompositionDescriptor.length;
  if (
    registrations.length !== 23 ||
    selectedCount !== 22 ||
    registrations.slice(0, selectedCount).some((registration, index) => {
      const expected = hostDeckSelectedApiRouteCompositionDescriptor[index];
      return (
        expected === undefined ||
        registration.id !== expected.registrationId ||
        registration.surface !== expected.surface
      );
    }) ||
    registrations.at(-1)?.id !== hostDeckProductionStaticRegistrationId ||
    registrations.at(-1)?.surface !== "static" ||
    new Set(registrations.map((registration) => registration.id)).size !== 23 ||
    registrations.filter((registration) => registration.surface === "api")
      .length !== 21 ||
    registrations.filter((registration) => registration.surface === "sse")
      .length !== 1 ||
    registrations.filter((registration) => registration.surface === "static")
      .length !== 1
  ) {
    throw new TypeError(
      "HostDeck production route registration inventory is invalid."
    );
  }
}

function functionView<
  TSource extends object,
  const TKey extends keyof TSource & string
>(source: TSource, keys: readonly TKey[]): Pick<TSource, TKey> {
  const view: Partial<Pick<TSource, TKey>> = Object.create(null) as Partial<
    Pick<TSource, TKey>
  >;
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "function") {
      throw new TypeError(`HostDeck production function port ${key} is invalid.`);
    }
    view[key] = value;
  }
  return Object.freeze(view) as Pick<TSource, TKey>;
}

function readExactDataObject<const TKey extends string>(
  input: unknown,
  expectedKeys: readonly TKey[],
  message: string
): Readonly<Record<TKey, unknown>> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new TypeError(message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !(expectedKeys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError(message);
  }
  const values: Partial<Record<TKey, unknown>> = Object.create(null) as Partial<
    Record<TKey, unknown>
  >;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(message);
    }
    values[key] = descriptor.value;
  }
  return Object.freeze(values) as Readonly<Record<TKey, unknown>>;
}

function assertOperationDeadline(
  candidate: unknown
): asserts candidate is OperationDeadline {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as Partial<OperationDeadline>).remainingMs !==
      "function" ||
    typeof (candidate as Partial<OperationDeadline>).timeoutMs !== "function" ||
    typeof (candidate as Partial<OperationDeadline>).throwIfAborted !==
      "function" ||
    typeof (candidate as Partial<OperationDeadline>).dispose !== "function" ||
    !isAbortSignal((candidate as Partial<OperationDeadline>).signal)
  ) {
    throw new TypeError("HostDeck production operation deadline is invalid.");
  }
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as Partial<AbortSignal>).aborted === "boolean" &&
    typeof (candidate as Partial<AbortSignal>).addEventListener === "function" &&
    typeof (candidate as Partial<AbortSignal>).removeEventListener === "function"
  );
}

function requireBound<T>(candidate: T | null, label: string): T {
  if (candidate === null) {
    throw new TypeError(`${label} was used before production graph binding.`);
  }
  return candidate;
}

function reportReconnectFailure(
  report: (
    source: HostDeckProductionApplicationIssueSource,
    code: string
  ) => void,
  error: HostDeckCodexReconnectError
): void {
  report("reconnect", `${error.stage}_${error.code}`);
}

function errorCode(error: unknown, fallback: string): string {
  if (error !== null && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      issueCodePattern.test(descriptor.value)
    ) {
      return descriptor.value;
    }
  }
  return fallback;
}

function readNow(): Date {
  const now = new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("HostDeck production wall clock is invalid.");
  }
  return now;
}

function createAuditTimestampClock(): () => string {
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  return () => {
    const now = readNow().getTime();
    const selected = Math.max(now, lastTimestamp + 1);
    lastTimestamp = selected;
    return new Date(selected).toISOString();
  };
}

function createAuditRecordId(): string {
  return `audit_${randomBytes(18).toString("base64url")}`;
}

function increment(value: number): number {
  return value < maximumCounter ? value + 1 : value;
}
