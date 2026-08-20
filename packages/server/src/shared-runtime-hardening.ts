import { relative, resolve } from "node:path";
import { codexBindingDescriptor } from "@hostdeck/codex-adapter";
import { z } from "zod";
import { sharedRuntimeHardeningDeterministicTests } from "./shared-runtime-hardening-manifest.js";

const fullCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const safeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = safeCountSchema.min(1);
const timestampSchema = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const zeroCleanupSchema = z
  .object({
    app_servers_remaining: z.literal(0),
    browser_processes_remaining: z.literal(0),
    temporary_roots_remaining: z.literal(0),
    tmux_servers_remaining: z.literal(0),
    tui_processes_remaining: z.literal(0),
    unix_sockets_remaining: z.literal(0)
  })
  .strict();

const sharedRuntimeRealReportSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-114-real"),
    hostdeck_commit: fullCommitSchema,
    runtime: z
      .object({
        runtime_version: z.literal("0.148.0"),
        standard_socket: z.literal(true),
        socket_mode: z.literal(0o600)
      })
      .strict(),
    execution: z
      .object({
        project_count: z.literal(3),
        loaded_before_count: z.literal(2),
        created_after_count: z.literal(1),
        resumed_existing_count: z.literal(1),
        enrolled_count: z.literal(3),
        reconnect_enrolled_count: z.literal(3),
        hostdeck_connection_count: z.literal(2),
        tui_lifetime_count: z.literal(4),
        turn_start_count: z.literal(0),
        retry_count: z.literal(0)
      })
      .strict(),
    continuity: z
      .object({
        broker_pid_stable_after_hostdeck_detach: z.literal(true),
        socket_inode_stable_after_hostdeck_detach: z.literal(true),
        loaded_tui_survived_hostdeck_detach: z.literal(true),
        native_resume_identity_preserved: z.literal(true)
      })
      .strict(),
    integrity: z
      .object({
        unique_mapping_count: z.literal(3),
        unique_native_identity_count: z.literal(3),
        catalog_session_count: z.literal(3),
        catalog_ordered: z.literal(true),
        protocol_issue_count: z.literal(0),
        enrollment_failure_count: z.literal(0),
        desktop_window_process_count: z.literal(0),
        superseded_command_count: z.literal(0)
      })
      .strict(),
    privacy: z
      .object({
        contains_native_or_internal_id: z.literal(false),
        contains_path_or_socket: z.literal(false),
        contains_pid_or_process_identity: z.literal(false),
        contains_prompt_goal_or_transcript: z.literal(false),
        contains_credential_or_raw_protocol: z.literal(false)
      })
      .strict(),
    cleanup: zeroCleanupSchema
  })
  .strict();

const vitestAssertionSchema = z
  .object({
    ancestorTitles: z.array(z.string()),
    duration: z.number().finite().min(0).max(240_000),
    failureMessages: z.array(z.string()).length(0),
    fullName: z.string().min(1).max(4_096),
    meta: z.record(z.string(), z.unknown()),
    status: z.literal("passed"),
    tags: z.array(z.unknown()).length(0),
    title: z.string().min(1).max(2_048)
  })
  .strict();

const vitestFileSchema = z
  .object({
    assertionResults: z.array(vitestAssertionSchema).min(1).max(4_096),
    endTime: timestampSchema,
    message: z.literal(""),
    name: z.string().min(1).max(8_192),
    startTime: timestampSchema,
    status: z.literal("passed")
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endTime < value.startTime) {
      context.addIssue({ code: "custom", message: "Vitest file time regressed." });
    }
  });

const deterministicReportSchema = z
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
    snapshot: z
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
      .strict(),
    startTime: safeCountSchema,
    success: z.literal(true),
    testResults: z
      .array(vitestFileSchema)
      .length(sharedRuntimeHardeningDeterministicTests.length)
  })
  .strict();

const sharedRuntimeHardeningEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-114"),
    observed_at: z.string().datetime({ offset: true }),
    hostdeck_commit: fullCommitSchema,
    binding: z
      .object({
        runtime_version: z.literal("0.148.0"),
        binding_id: z.string().min(1).max(256),
        file_count: z.literal(723),
        tree_sha256: z.string().regex(/^[0-9a-f]{64}$/u)
      })
      .strict(),
    execution: z
      .object({
        scenario_count: z.literal(2),
        deterministic_file_count: z.literal(
          sharedRuntimeHardeningDeterministicTests.length
        ),
        deterministic_test_count: positiveCountSchema,
        exact_scenario_count: z.literal(1),
        project_count: z.literal(3),
        native_thread_count: z.literal(3),
        ordinary_tui_lifetime_count: z.literal(4),
        retry_count: z.literal(0)
      })
      .strict(),
    criteria: z
      .object({
        exact_binding_and_clean_commit: z.literal(true),
        standard_socket_ownership: z.literal(true),
        ordinary_start_and_resume: z.literal(true),
        idempotent_enrollment: z.literal(true),
        bounded_invalid_and_race_handling: z.literal(true),
        bounded_history_and_privacy: z.literal(true),
        catalog_and_browser_continuity: z.literal(true),
        detach_reconnect_and_failure_truth: z.literal(true),
        dual_identity_and_legacy_absence: z.literal(true),
        resource_and_cleanup_bounds: z.literal(true),
        no_desktop_window_launch: z.literal(true)
      })
      .strict(),
    real: sharedRuntimeRealReportSchema,
    privacy: sharedRuntimeRealReportSchema.shape.privacy,
    cleanup: zeroCleanupSchema
  })
  .strict();

export type SharedRuntimeRealReport = z.infer<
  typeof sharedRuntimeRealReportSchema
>;
export type SharedRuntimeHardeningEvidence = z.infer<
  typeof sharedRuntimeHardeningEvidenceSchema
>;

export function parseSharedRuntimeRealReport(
  candidate: unknown
): SharedRuntimeRealReport {
  return deepFreeze(sharedRuntimeRealReportSchema.parse(candidate));
}

export function parseSharedRuntimeHardeningEvidence(
  candidate: unknown
): SharedRuntimeHardeningEvidence {
  return deepFreeze(sharedRuntimeHardeningEvidenceSchema.parse(candidate));
}

export function parseSharedRuntimeDeterministicReport(
  candidate: unknown,
  repositoryRoot: string
): Readonly<{ file_count: number; test_count: number }> {
  const parsed = deterministicReportSchema.parse(candidate);
  if (
    parsed.numPassedTestSuites !== parsed.numTotalTestSuites ||
    parsed.numPassedTests !== parsed.numTotalTests ||
    parsed.testResults.reduce(
      (count, file) => count + file.assertionResults.length,
      0
    ) !== parsed.numTotalTests
  ) {
    throw new TypeError("Shared runtime deterministic test counts differ.");
  }
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
        throw new TypeError("Shared runtime report contains a foreign test path.");
      }
      return relationship;
    })
    .sort();
  if (
    JSON.stringify(observed) !==
    JSON.stringify([...sharedRuntimeHardeningDeterministicTests])
  ) {
    throw new TypeError("Shared runtime deterministic test inventory differs.");
  }
  return Object.freeze({
    file_count: observed.length,
    test_count: parsed.numTotalTests
  });
}

export function createSharedRuntimeHardeningEvidence(input: {
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly repository_root: string;
  readonly deterministic_report: unknown;
  readonly real_report: unknown;
  readonly cleanup: unknown;
}): SharedRuntimeHardeningEvidence {
  const deterministic = parseSharedRuntimeDeterministicReport(
    input.deterministic_report,
    input.repository_root
  );
  const real = parseSharedRuntimeRealReport(input.real_report);
  if (real.hostdeck_commit !== input.hostdeck_commit) {
    throw new TypeError("Shared runtime real report commit differs.");
  }
  const cleanup = zeroCleanupSchema.parse(input.cleanup);
  return parseSharedRuntimeHardeningEvidence({
    schema_version: 1,
    task: "INT-V1-114",
    observed_at: input.observed_at,
    hostdeck_commit: input.hostdeck_commit,
    binding: {
      runtime_version: codexBindingDescriptor.codex_version,
      binding_id: codexBindingDescriptor.binding_id,
      file_count: codexBindingDescriptor.file_count,
      tree_sha256: codexBindingDescriptor.tree_sha256
    },
    execution: {
      scenario_count: 2,
      deterministic_file_count: deterministic.file_count,
      deterministic_test_count: deterministic.test_count,
      exact_scenario_count: 1,
      project_count: real.execution.project_count,
      native_thread_count: real.execution.enrolled_count,
      ordinary_tui_lifetime_count: real.execution.tui_lifetime_count,
      retry_count: real.execution.retry_count
    },
    criteria: {
      exact_binding_and_clean_commit: true,
      standard_socket_ownership: true,
      ordinary_start_and_resume: true,
      idempotent_enrollment: true,
      bounded_invalid_and_race_handling: true,
      bounded_history_and_privacy: true,
      catalog_and_browser_continuity: true,
      detach_reconnect_and_failure_truth: true,
      dual_identity_and_legacy_absence: true,
      resource_and_cleanup_bounds: true,
      no_desktop_window_launch: true
    },
    real,
    privacy: real.privacy,
    cleanup
  });
}

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
