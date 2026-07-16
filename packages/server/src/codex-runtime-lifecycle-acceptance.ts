import { basename, resolve } from "node:path";
import { z } from "zod";

const fullCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const observedAtSchema = z.string().datetime({ offset: true });
const safeCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = safeCountSchema.min(1);
const highResolutionTimestampSchema = z
  .number()
  .finite()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const noPrivacySchema = z
  .object({
    contains_pid: z.literal(false),
    contains_path: z.literal(false),
    contains_socket_identity: z.literal(false),
    contains_thread_or_turn_id: z.literal(false)
  })
  .strict();

const supervisorScenarioEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    scenario: z.literal("exact_supervisor"),
    observed_at: observedAtSchema,
    hostdeck_commit: fullCommitSchema,
    runtime: z
      .object({
        version: z.literal("0.144.0"),
        exact_binding: z.literal(true),
        app_server_process_count: z.literal(2)
      })
      .strict(),
    foreground_child: z
      .object({
        compatibility_ready: z.literal(true),
        runtime_process_count: z.literal(1),
        owned_runtime_exit_count: z.literal(1),
        owned_socket_cleanup_count: z.literal(1)
      })
      .strict(),
    service_owned: z
      .object({
        compatibility_ready: z.literal(true),
        runtime_process_count: z.literal(1),
        hostdeck_spawn_count: z.literal(0),
        hostdeck_signal_count: z.literal(0),
        sibling_survived_hostdeck_close: z.literal(true),
        outer_owner_stopped_runtime: z.literal(true),
        owned_socket_cleanup_count: z.literal(1)
      })
      .strict(),
    privacy: noPrivacySchema
      .extend({
        contains_model_prompt_output_or_auth: z.literal(false)
      })
      .strict(),
    cleanup: z
      .object({
        app_server_processes_remaining: z.literal(0),
        unix_sockets_remaining: z.literal(0),
        temporary_roots_remaining: z.literal(0)
      })
      .strict()
  })
  .strict();

const restartEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-030"),
    observed_at: observedAtSchema,
    hostdeck_commit: fullCommitSchema,
    process_boundary: z
      .object({
        hostdeck_process_count: z.literal(4),
        hostdeck_processes_distinct: z.literal(true)
      })
      .strict(),
    runtime: z
      .object({
        version: z.literal("0.144.0"),
        exact_binding: z.literal(true),
        service_runtime_pid_stable: z.literal(true),
        service_socket_identity_stable: z.literal(true),
        foreground_runtime_pid_replaced: z.literal(true),
        foreground_socket_identity_replaced: z.literal(true)
      })
      .strict(),
    service_owned: z
      .object({
        hostdeck_process_count: z.literal(2),
        hostdeck_processes_distinct: z.literal(true),
        lease_contention_proven: z.literal(true),
        lease_reacquired: z.literal(true),
        runtime_spawn_count_by_hostdeck: z.literal(0),
        runtime_signal_count_by_hostdeck: z.literal(0),
        managed_thread_identity_stable: z.literal(true),
        active_turn_identity_stable: z.literal(true),
        active_turn_observed_after_restart: z.literal(true),
        completion_observed_after_restart: z.literal(true),
        restart_boundary_count: z.literal(1),
        no_override_resume_count: z.literal(1),
        ready_count: z.literal(1),
        turn_start_request_count: z.literal(1),
        model_turn_count: z.literal(1),
        mutation_retry_count: z.literal(0)
      })
      .strict(),
    foreground_child: z
      .object({
        hostdeck_process_count: z.literal(2),
        hostdeck_processes_distinct: z.literal(true),
        lease_contention_proven: z.literal(true),
        lease_reacquired: z.literal(true),
        runtime_process_count: z.literal(2),
        runtime_processes_distinct: z.literal(true),
        owned_runtime_exit_count: z.literal(2),
        owned_socket_cleanup_count: z.literal(2)
      })
      .strict(),
    privacy: noPrivacySchema
      .extend({
        contains_model_prompt_output_or_auth: z.literal(false)
      })
      .strict(),
    cleanup: z
      .object({
        workers_remaining: z.literal(0),
        foreground_runtimes_remaining: z.literal(0),
        foreground_sockets_remaining: z.literal(0),
        service_runtime_stopped_by_outer_owner: z.literal(true),
        service_socket_remaining: z.literal(false),
        temporary_root_removed: z.literal(true)
      })
      .strict()
  })
  .strict();

const coexistenceEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-031"),
    observed_at: observedAtSchema,
    hostdeck_commit: fullCommitSchema,
    runtime: z
      .object({
        version: z.literal("0.144.0"),
        exact_binding: z.literal(true),
        app_server_process_count: z.literal(1),
        app_server_identity_stable: z.literal(true),
        private_unix_socket_stable: z.literal(true),
        maximum_inbound_message_bytes: positiveCountSchema.max(8_388_608)
      })
      .strict(),
    clients: z
      .object({
        hostdeck_connection_count: z.literal(2),
        tui_process_count: z.literal(2),
        tui_processes_distinct: z.literal(true),
        managed_thread_identity_stable: z.literal(true),
        managed_cwd_identity_stable: z.literal(true)
      })
      .strict(),
    shared_turn: z
      .object({
        model_turn_count: z.literal(1),
        turn_start_request_count: z.literal(1),
        normalized_start_count: z.literal(1),
        normalized_completion_count: z.literal(1),
        durable_turn_event_count: z.literal(2),
        started_while_tui_alive: z.literal(true),
        tui_rendered_shared_turn: z.literal(true),
        completed_after_tui_close: z.literal(true),
        marker_start_and_finish_observed: z.literal(true)
      })
      .strict(),
    teardown: z
      .object({
        tui_close_preserved_hostdeck_generation: z.literal(true),
        tui_close_preserved_hostdeck_pipeline: z.literal(true),
        hostdeck_close_preserved_tui: z.literal(true),
        hostdeck_close_preserved_runtime: z.literal(true),
        replacement_hostdeck_read_same_thread: z.literal(true),
        second_tui_close_preserved_hostdeck: z.literal(true)
      })
      .strict(),
    integrity: z
      .object({
        pipeline_failure_count: z.literal(0),
        replay_boundary_count: z.literal(0),
        duplicate_turn_event_count: z.literal(0),
        unmanaged_observation_count: positiveCountSchema.max(1_024),
        durable_mapping_count: z.literal(1),
        foreign_mapping_count: z.literal(0),
        publication_count: positiveCountSchema,
        retained_event_count: positiveCountSchema
      })
      .strict(),
    privacy: noPrivacySchema
      .extend({
        contains_model_prompt_tui_output_or_auth: z.literal(false)
      })
      .strict(),
    cleanup: z
      .object({
        tui_processes_remaining: z.literal(0),
        tmux_sockets_remaining: z.literal(0),
        hostdeck_connections_closed: z.literal(2),
        runtime_threads_archived: z.literal(2),
        database_closed: z.literal(true),
        app_server_stopped_by_outer_owner: z.literal(true),
        app_server_socket_remaining: z.literal(false),
        temporary_root_removed: z.literal(true)
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.integrity.publication_count !== value.integrity.retained_event_count) {
      context.addIssue({
        code: "custom",
        message: "Coexistence publication and retention counts differ."
      });
    }
  });

const vitestAssertionSchema = z
  .object({
    ancestorTitles: z.array(z.string().min(1).max(256)).min(1).max(4),
    duration: z.number().finite().min(0).max(120_000),
    failureMessages: z.array(z.string()).length(0),
    fullName: z.string().min(1).max(1_024),
    meta: z.record(z.string(), z.unknown()),
    status: z.literal("passed"),
    tags: z.array(z.unknown()).length(0),
    title: z.string().min(1).max(512)
  })
  .strict();

const vitestFileResultSchema = z
  .object({
    assertionResults: z.array(vitestAssertionSchema).length(1),
    endTime: highResolutionTimestampSchema,
    message: z.literal(""),
    name: z.string().min(1).max(4_096),
    startTime: highResolutionTimestampSchema,
    status: z.literal("passed")
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endTime < value.startTime) {
      context.addIssue({ code: "custom", message: "Vitest file time regressed." });
    }
  });

const vitestSnapshotSchema = z
  .object({
    added: z.literal(0),
    failure: z.literal(false),
    filesAdded: z.literal(0),
    filesRemoved: z.literal(0),
    filesRemovedList: z.array(z.never()).length(0),
    filesUnmatched: z.literal(0),
    filesUpdated: z.literal(0),
    matched: z.literal(0),
    total: z.literal(0),
    unchecked: z.literal(0),
    uncheckedKeysByFile: z.array(z.never()).length(0),
    unmatched: z.literal(0),
    updated: z.literal(0),
    didUpdate: z.literal(false)
  })
  .strict();

const vitestJsonReportSchema = z
  .object({
    numFailedTestSuites: z.literal(0),
    numFailedTests: z.literal(0),
    numPassedTestSuites: positiveCountSchema,
    numPassedTests: z.literal(2),
    numPendingTestSuites: z.literal(0),
    numPendingTests: z.literal(0),
    numTodoTests: z.literal(0),
    numTotalTestSuites: positiveCountSchema,
    numTotalTests: z.literal(2),
    snapshot: vitestSnapshotSchema,
    startTime: safeCountSchema,
    success: z.literal(true),
    testResults: z.array(vitestFileResultSchema).length(2)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.numPassedTestSuites !== value.numTotalTestSuites) {
      context.addIssue({ code: "custom", message: "Vitest suite counts differ." });
    }
  });

const outerCleanupSchema = z
  .object({
    process_groups_remaining: z.literal(0),
    special_files_remaining: z.literal(0),
    temporary_roots_remaining: z.literal(0),
    child_reports_remaining: z.literal(0)
  })
  .strict();

const aggregateEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-032"),
    observed_at: observedAtSchema,
    hostdeck_commit: fullCommitSchema,
    runtime: z
      .object({
        version: z.literal("0.144.0"),
        exact_binding: z.literal(true),
        exact_scenario_count: z.literal(3),
        exact_app_server_lifetime_count: z.literal(6)
      })
      .strict(),
    execution: z
      .object({
        scenario_count: z.literal(4),
        test_file_count: z.literal(5),
        deterministic_test_count: z.literal(2),
        model_turn_count: z.literal(2),
        retry_count: z.literal(0)
      })
      .strict(),
    clients: z
      .object({
        hostdeck_os_process_count: z.literal(4),
        hostdeck_connection_count: z.literal(2),
        tui_process_count: z.literal(2),
        foreground_runtime_count: z.literal(3),
        service_runtime_count: z.literal(2)
      })
      .strict(),
    lifecycle: z
      .object({
        foreground_ownership: z.literal(true),
        service_nonownership: z.literal(true),
        duplicate_owner_rejected: z.literal(true),
        reconnect_backoff_and_cancellation: z.literal(true),
        crash_reconciliation: z.literal(true),
        hostdeck_restart_continuity: z.literal(true),
        approval_and_incomplete_truth: z.literal(true),
        continuity_boundaries: z.literal(true),
        tui_multi_client_coexistence: z.literal(true),
        mutation_replay_absent: z.literal(true)
      })
      .strict(),
    integrity: z
      .object({
        exact_restart_boundary_count: z.literal(1),
        exact_no_override_resume_count: z.literal(1),
        coexistence_pipeline_failure_count: z.literal(0),
        coexistence_duplicate_turn_event_count: z.literal(0),
        coexistence_foreign_mapping_count: z.literal(0),
        coexistence_publication_count: positiveCountSchema,
        coexistence_retained_event_count: positiveCountSchema,
        maximum_inbound_message_bytes: positiveCountSchema.max(8_388_608)
      })
      .strict(),
    privacy: noPrivacySchema
      .extend({
        contains_process_command: z.literal(false),
        contains_session_or_request_id: z.literal(false),
        contains_model_prompt_tui_output_or_auth: z.literal(false),
        contains_raw_protocol_audit_or_error: z.literal(false)
      })
      .strict(),
    cleanup: z
      .object({
        process_groups_remaining: z.literal(0),
        app_servers_remaining: z.literal(0),
        tui_processes_remaining: z.literal(0),
        tmux_sockets_remaining: z.literal(0),
        unix_sockets_remaining: z.literal(0),
        temporary_roots_remaining: z.literal(0),
        child_reports_remaining: z.literal(0)
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.integrity.coexistence_publication_count !==
      value.integrity.coexistence_retained_event_count
    ) {
      context.addIssue({
        code: "custom",
        message: "Aggregate publication and retention counts differ."
      });
    }
  });

export const lifecycleIntegrationTests = Object.freeze([
  "tests/codex-reconnect-controller.integration.test.ts",
  "tests/codex-runtime-crash-reconciliation.integration.test.ts"
] as const);

const expectedIntegrationTitles = Object.freeze(
  new Map([
    [
      "codex-reconnect-controller.integration.test.ts",
      "orders real approval supersession, read-only reconciliation, resubscription, and write readmission"
    ],
    [
      "codex-runtime-crash-reconciliation.integration.test.ts",
      "reconciles audit, turn, approval, boundary, held-event, model, mode, and write-admission truth"
    ]
  ])
);

export interface RuntimeLifecycleAcceptanceInput {
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly repository_root: string;
  readonly vitest_report: unknown;
  readonly supervisor_report: unknown;
  readonly restart_report: unknown;
  readonly coexistence_report: unknown;
  readonly outer_cleanup: unknown;
}

export type SupervisorScenarioEvidence = z.infer<
  typeof supervisorScenarioEvidenceSchema
>;
export type RuntimeLifecycleAcceptanceEvidence = z.infer<
  typeof aggregateEvidenceSchema
>;

export function parseSupervisorScenarioEvidence(
  candidate: unknown,
  expectedCommit: string
): SupervisorScenarioEvidence {
  const parsed = parseEvidence(
    supervisorScenarioEvidenceSchema,
    candidate,
    "supervisor"
  );
  requireCommit(parsed.hostdeck_commit, expectedCommit, "supervisor");
  return deepFreeze(parsed);
}

export function createRuntimeLifecycleAcceptanceEvidence(
  input: RuntimeLifecycleAcceptanceInput
): RuntimeLifecycleAcceptanceEvidence {
  const commit = parseEvidence(fullCommitSchema, input.hostdeck_commit, "commit");
  const observedAt = parseEvidence(observedAtSchema, input.observed_at, "timestamp");
  const vitest = parseVitestReport(input.vitest_report, input.repository_root);
  const supervisor = parseSupervisorScenarioEvidence(
    input.supervisor_report,
    commit
  );
  const restart = parseEvidence(restartEvidenceSchema, input.restart_report, "restart");
  requireCommit(restart.hostdeck_commit, commit, "restart");
  const coexistence = parseEvidence(
    coexistenceEvidenceSchema,
    input.coexistence_report,
    "coexistence"
  );
  requireCommit(coexistence.hostdeck_commit, commit, "coexistence");
  const cleanup = parseEvidence(outerCleanupSchema, input.outer_cleanup, "cleanup");

  const evidence = {
    schema_version: 1,
    task: "INT-V1-032",
    observed_at: observedAt,
    hostdeck_commit: commit,
    runtime: {
      version: supervisor.runtime.version,
      exact_binding: true,
      exact_scenario_count: 3,
      exact_app_server_lifetime_count:
        supervisor.runtime.app_server_process_count +
        restart.foreground_child.runtime_process_count +
        1 +
        coexistence.runtime.app_server_process_count
    },
    execution: {
      scenario_count: 4,
      test_file_count: vitest.file_count + 3,
      deterministic_test_count: vitest.test_count,
      model_turn_count:
        coexistence.shared_turn.model_turn_count +
        restart.service_owned.model_turn_count,
      retry_count:
        restart.service_owned.mutation_retry_count +
        coexistence.shared_turn.turn_start_request_count -
        coexistence.shared_turn.model_turn_count
    },
    clients: {
      hostdeck_os_process_count: restart.process_boundary.hostdeck_process_count,
      hostdeck_connection_count: coexistence.clients.hostdeck_connection_count,
      tui_process_count: coexistence.clients.tui_process_count,
      foreground_runtime_count:
        supervisor.foreground_child.runtime_process_count +
        restart.foreground_child.runtime_process_count,
      service_runtime_count:
        supervisor.service_owned.runtime_process_count + 1
    },
    lifecycle: {
      foreground_ownership: true,
      service_nonownership: true,
      duplicate_owner_rejected: restart.service_owned.lease_contention_proven,
      reconnect_backoff_and_cancellation: true,
      crash_reconciliation: true,
      hostdeck_restart_continuity:
        restart.service_owned.completion_observed_after_restart,
      approval_and_incomplete_truth: true,
      continuity_boundaries: true,
      tui_multi_client_coexistence:
        coexistence.teardown.hostdeck_close_preserved_tui,
      mutation_replay_absent: true
    },
    integrity: {
      exact_restart_boundary_count:
        restart.service_owned.restart_boundary_count,
      exact_no_override_resume_count:
        restart.service_owned.no_override_resume_count,
      coexistence_pipeline_failure_count:
        coexistence.integrity.pipeline_failure_count,
      coexistence_duplicate_turn_event_count:
        coexistence.integrity.duplicate_turn_event_count,
      coexistence_foreign_mapping_count:
        coexistence.integrity.foreign_mapping_count,
      coexistence_publication_count:
        coexistence.integrity.publication_count,
      coexistence_retained_event_count:
        coexistence.integrity.retained_event_count,
      maximum_inbound_message_bytes:
        coexistence.runtime.maximum_inbound_message_bytes
    },
    privacy: {
      contains_pid: false,
      contains_path: false,
      contains_socket_identity: false,
      contains_thread_or_turn_id: false,
      contains_process_command: false,
      contains_session_or_request_id: false,
      contains_model_prompt_tui_output_or_auth: false,
      contains_raw_protocol_audit_or_error: false
    },
    cleanup: {
      process_groups_remaining: cleanup.process_groups_remaining,
      app_servers_remaining: 0,
      tui_processes_remaining:
        coexistence.cleanup.tui_processes_remaining,
      tmux_sockets_remaining: coexistence.cleanup.tmux_sockets_remaining,
      unix_sockets_remaining: cleanup.special_files_remaining,
      temporary_roots_remaining: cleanup.temporary_roots_remaining,
      child_reports_remaining: cleanup.child_reports_remaining
    }
  };
  return deepFreeze(
    parseEvidence(aggregateEvidenceSchema, evidence, "aggregate")
  );
}

export function parseRuntimeLifecycleAcceptanceEvidence(
  candidate: unknown
): RuntimeLifecycleAcceptanceEvidence {
  return deepFreeze(
    parseEvidence(aggregateEvidenceSchema, candidate, "aggregate")
  );
}

function parseVitestReport(
  candidate: unknown,
  repositoryRoot: string
): { readonly file_count: 2; readonly test_count: 2 } {
  const root = resolve(repositoryRoot);
  const parsed = parseEvidence(vitestJsonReportSchema, candidate, "Vitest");
  const expectedPaths = lifecycleIntegrationTests
    .map((path) => resolve(root, path))
    .sort();
  const observedPaths = parsed.testResults
    .map((result) => resolve(result.name))
    .sort();
  if (
    observedPaths.length !== expectedPaths.length ||
    observedPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw acceptanceError("Vitest report does not contain the fixed files.");
  }
  for (const result of parsed.testResults) {
    const expectedTitle = expectedIntegrationTitles.get(basename(result.name));
    if (
      expectedTitle === undefined ||
      result.assertionResults[0]?.title !== expectedTitle
    ) {
      throw acceptanceError("Vitest report does not contain the fixed tests.");
    }
  }
  return Object.freeze({ file_count: 2, test_count: 2 });
}

function requireCommit(
  observed: string,
  expected: string,
  label: string
): void {
  const parsedExpected = parseEvidence(fullCommitSchema, expected, "commit");
  if (observed !== parsedExpected) {
    throw acceptanceError(`The ${label} report is from a different commit.`);
  }
}

function parseEvidence<Schema extends z.ZodType>(
  schema: Schema,
  candidate: unknown,
  label: string
): z.infer<Schema> {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw acceptanceError(`Invalid ${label} lifecycle evidence.`);
  }
  return parsed.data;
}

function acceptanceError(message: string): TypeError {
  return new TypeError(message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
