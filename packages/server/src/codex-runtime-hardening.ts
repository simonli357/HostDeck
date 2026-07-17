import { relative, resolve } from "node:path";
import { codexBindingDescriptor } from "@hostdeck/codex-adapter";
import { z } from "zod";
import { runtimeHardeningDeterministicTests } from "./codex-runtime-hardening-manifest.js";
import { parseRuntimeLifecycleAcceptanceEvidence } from "./codex-runtime-lifecycle-acceptance.js";
import { parseStructuredVerticalReport } from "./codex-structured-vertical-report.js";

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
const fullCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const vitestAssertionSchema = z
  .object({
    ancestorTitles: z.array(z.string().min(1).max(256)).max(8),
    duration: z.number().finite().min(0).max(180_000),
    failureMessages: z.array(z.string()).length(0),
    fullName: z.string().min(1).max(2_048),
    meta: z.record(z.string(), z.unknown()),
    status: z.literal("passed"),
    tags: z.array(z.unknown()).length(0),
    title: z.string().min(1).max(1_024)
  })
  .strict();

const vitestFileSchema = z
  .object({
    assertionResults: z.array(vitestAssertionSchema).min(1).max(2_048),
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

const deterministicVitestReportSchema = z
  .object({
    numFailedTestSuites: z.literal(0),
    numFailedTests: z.literal(0),
    numPassedTestSuites: positiveCountSchema,
    numPassedTests: positiveCountSchema,
    numPendingTestSuites: z.literal(0),
    numPendingTests: z.literal(0),
    numTodoTests: z.literal(0),
    numTotalTestSuites: positiveCountSchema,
    numTotalTests: positiveCountSchema,
    snapshot: vitestSnapshotSchema,
    startTime: safeCountSchema,
    success: z.literal(true),
    testResults: z
      .array(vitestFileSchema)
      .length(runtimeHardeningDeterministicTests.length)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.numPassedTestSuites !== value.numTotalTestSuites ||
      value.numTotalTestSuites !== countVitestSuites(value.testResults) ||
      value.numPassedTests !== value.numTotalTests
    ) {
      context.addIssue({
        code: "custom",
        message: "Deterministic Vitest suite or test counts differ."
      });
    }
    const assertionCount = value.testResults.reduce(
      (total, file) => total + file.assertionResults.length,
      0
    );
    if (assertionCount !== value.numTotalTests) {
      context.addIssue({
        code: "custom",
        message: "Deterministic Vitest assertion count differs."
      });
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

const runtimeHardeningEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-091"),
    observed_at: z.string().datetime({ offset: true }),
    hostdeck_commit: fullCommitSchema,
    binding: z
      .object({
        runtime_version: z.literal("0.144.0"),
        binding_id: z.string().min(1).max(256),
        experimental_api: z.literal(true),
        file_count: z.literal(671),
        tree_sha256: z.string().regex(/^[0-9a-f]{64}$/u)
      })
      .strict(),
    execution: z
      .object({
        scenario_count: z.literal(6),
        deterministic_file_count: z.literal(
          runtimeHardeningDeterministicTests.length
        ),
        deterministic_test_count: positiveCountSchema,
        total_test_file_count: positiveCountSchema,
        exact_scenario_count: z.literal(4),
        exact_app_server_lifetime_count: z.literal(7),
        model_turn_count: z.literal(5),
        compact_start_count: z.literal(1),
        retry_count: z.literal(0)
      })
      .strict(),
    structured_vertical: z
      .object({
        managed_thread_count: z.literal(2),
        selected_cwd_count: z.literal(2),
        request_count: positiveCountSchema,
        notification_count: positiveCountSchema,
        observer_count: positiveCountSchema,
        durable_publication_count: positiveCountSchema,
        proof_count: z.literal(16),
        proof_source_count: z.literal(8),
        managed_thread_lifecycle: z.literal(true),
        prompt_model_plan: z.literal(true),
        goal_usage_skills: z.literal(true),
        approval_interrupt_compact: z.literal(true),
        tui_resume: z.literal(true)
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
        vertical_pipeline_failure_count: z.literal(0),
        vertical_protocol_issue_count: z.literal(0),
        vertical_isolated_thread_turn_count: z.literal(0),
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
    privacy: z
      .object({
        contains_pid: z.literal(false),
        contains_path: z.literal(false),
        contains_socket_or_process_identity: z.literal(false),
        contains_thread_turn_session_request_or_operation_id: z.literal(false),
        contains_model_effort_prompt_goal_command_tui_or_auth: z.literal(false),
        contains_raw_protocol_output_audit_or_error: z.literal(false)
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
      value.execution.total_test_file_count !==
      value.execution.deterministic_file_count + 6
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime hardening total test-file count differs."
      });
    }
    if (
      value.integrity.coexistence_publication_count !==
      value.integrity.coexistence_retained_event_count
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime hardening publication and retention counts differ."
      });
    }
  });

export interface RuntimeHardeningInput {
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly repository_root: string;
  readonly deterministic_report: unknown;
  readonly structured_vertical_report: unknown;
  readonly lifecycle_evidence: unknown;
  readonly outer_cleanup: unknown;
}

export interface DeterministicRuntimeEvidence {
  readonly file_count: number;
  readonly test_count: number;
}

export type RuntimeHardeningEvidence = z.infer<
  typeof runtimeHardeningEvidenceSchema
>;

export function parseDeterministicRuntimeReport(
  candidate: unknown,
  repositoryRoot: string
): DeterministicRuntimeEvidence {
  const parsed = deterministicVitestReportSchema.parse(candidate);
  const root = resolve(repositoryRoot);
  const observed = parsed.testResults
    .map((result) => {
      const relationship = relative(root, resolve(result.name));
      if (
        relationship === "" ||
        relationship === ".." ||
        relationship.startsWith("../") ||
        resolve(root, relationship) !== resolve(result.name)
      ) {
        throw new TypeError(
          "Deterministic runtime report contains a foreign test path."
        );
      }
      return relationship;
    })
    .sort();
  if (
    JSON.stringify(observed) !==
    JSON.stringify([...runtimeHardeningDeterministicTests])
  ) {
    throw new TypeError("Deterministic runtime test inventory differs.");
  }
  return Object.freeze({
    file_count: observed.length,
    test_count: parsed.numTotalTests
  });
}

export function createRuntimeHardeningEvidence(
  input: RuntimeHardeningInput
): RuntimeHardeningEvidence {
  const deterministic = parseDeterministicRuntimeReport(
    input.deterministic_report,
    input.repository_root
  );
  const vertical = parseStructuredVerticalReport(
    input.structured_vertical_report,
    input.hostdeck_commit
  );
  const lifecycle = parseRuntimeLifecycleAcceptanceEvidence(
    input.lifecycle_evidence
  );
  if (lifecycle.hostdeck_commit !== input.hostdeck_commit) {
    throw new TypeError("Runtime lifecycle evidence commit does not match.");
  }
  const cleanup = outerCleanupSchema.parse(input.outer_cleanup);

  return parseRuntimeHardeningEvidence({
    schema_version: 1,
    task: "INT-V1-091",
    observed_at: input.observed_at,
    hostdeck_commit: input.hostdeck_commit,
    binding: {
      runtime_version: codexBindingDescriptor.codex_version,
      binding_id: codexBindingDescriptor.binding_id,
      experimental_api: codexBindingDescriptor.experimental_api,
      file_count: codexBindingDescriptor.file_count,
      tree_sha256: codexBindingDescriptor.tree_sha256
    },
    execution: {
      scenario_count: 6,
      deterministic_file_count: deterministic.file_count,
      deterministic_test_count: deterministic.test_count,
      total_test_file_count: deterministic.file_count + 6,
      exact_scenario_count: 4,
      exact_app_server_lifetime_count:
        vertical.runtime.app_server_process_count +
        lifecycle.runtime.exact_app_server_lifetime_count,
      model_turn_count:
        vertical.execution.turn_start_count +
        lifecycle.execution.model_turn_count,
      compact_start_count: vertical.execution.compact_start_count,
      retry_count: lifecycle.execution.retry_count
    },
    structured_vertical: {
      managed_thread_count: vertical.execution.managed_thread_count,
      selected_cwd_count: vertical.execution.selected_cwd_count,
      request_count: vertical.execution.request_count,
      notification_count: vertical.execution.notification_count,
      observer_count: vertical.execution.observer_count,
      durable_publication_count:
        vertical.execution.durable_publication_count,
      proof_count: vertical.execution.proof_count,
      proof_source_count: vertical.execution.proof_source_count,
      managed_thread_lifecycle:
        vertical.operations.managed_thread_lifecycle,
      prompt_model_plan: vertical.operations.prompt_model_and_plan,
      goal_usage_skills:
        vertical.operations.passive_goal &&
        vertical.operations.usage_and_skills,
      approval_interrupt_compact:
        vertical.operations.approval_and_side_effect &&
        vertical.operations.interrupt &&
        vertical.operations.compact,
      tui_resume: vertical.operations.tui_resume
    },
    lifecycle: lifecycle.lifecycle,
    integrity: {
      vertical_pipeline_failure_count:
        vertical.integrity.pipeline_failure_count,
      vertical_protocol_issue_count: vertical.integrity.protocol_issue_count,
      vertical_isolated_thread_turn_count:
        vertical.integrity.isolated_thread_turn_event_count +
        vertical.integrity.isolated_thread_turn_start_request_count,
      exact_restart_boundary_count:
        lifecycle.integrity.exact_restart_boundary_count,
      exact_no_override_resume_count:
        lifecycle.integrity.exact_no_override_resume_count,
      coexistence_pipeline_failure_count:
        lifecycle.integrity.coexistence_pipeline_failure_count,
      coexistence_duplicate_turn_event_count:
        lifecycle.integrity.coexistence_duplicate_turn_event_count,
      coexistence_foreign_mapping_count:
        lifecycle.integrity.coexistence_foreign_mapping_count,
      coexistence_publication_count:
        lifecycle.integrity.coexistence_publication_count,
      coexistence_retained_event_count:
        lifecycle.integrity.coexistence_retained_event_count,
      maximum_inbound_message_bytes:
        lifecycle.integrity.maximum_inbound_message_bytes
    },
    privacy: {
      contains_pid: false,
      contains_path: false,
      contains_socket_or_process_identity: false,
      contains_thread_turn_session_request_or_operation_id: false,
      contains_model_effort_prompt_goal_command_tui_or_auth: false,
      contains_raw_protocol_output_audit_or_error: false
    },
    cleanup: {
      process_groups_remaining: cleanup.process_groups_remaining,
      app_servers_remaining:
        vertical.cleanup.app_servers_remaining +
        lifecycle.cleanup.app_servers_remaining,
      tui_processes_remaining:
        vertical.cleanup.tui_processes_remaining +
        lifecycle.cleanup.tui_processes_remaining,
      tmux_sockets_remaining:
        vertical.cleanup.tmux_sockets_remaining +
        lifecycle.cleanup.tmux_sockets_remaining,
      unix_sockets_remaining:
        vertical.cleanup.unix_sockets_remaining +
        lifecycle.cleanup.unix_sockets_remaining,
      temporary_roots_remaining: cleanup.temporary_roots_remaining,
      child_reports_remaining: cleanup.child_reports_remaining
    }
  });
}

export function parseRuntimeHardeningEvidence(
  candidate: unknown
): RuntimeHardeningEvidence {
  const parsed = runtimeHardeningEvidenceSchema.parse(candidate);
  if (
    parsed.binding.runtime_version !== codexBindingDescriptor.codex_version ||
    parsed.binding.binding_id !== codexBindingDescriptor.binding_id ||
    parsed.binding.file_count !== codexBindingDescriptor.file_count ||
    parsed.binding.tree_sha256 !== codexBindingDescriptor.tree_sha256
  ) {
    throw new TypeError("Runtime hardening binding identity differs.");
  }
  return deepFreeze(parsed);
}

function countVitestSuites(
  files: readonly z.infer<typeof vitestFileSchema>[]
): number {
  return files.reduce((total, file) => {
    const nestedSuites = new Set<string>();
    for (const assertion of file.assertionResults) {
      for (let depth = 1; depth <= assertion.ancestorTitles.length; depth += 1) {
        nestedSuites.add(JSON.stringify(assertion.ancestorTitles.slice(0, depth)));
      }
    }
    return total + 1 + nestedSuites.size;
  }, 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
