import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { secureHostDeckRegularFile } from "@hostdeck/storage";
import { z } from "zod";

export const windowsStructuredVerticalReportName =
  "windows-structured-vertical-report.json";

const boundedCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCount = boundedCount.min(1);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const windowsStructuredVerticalReportSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-104"),
    scenario: z.literal("exact_windows_structured_vertical"),
    observed_at: z.string().datetime({ offset: true }),
    hostdeck_commit: commitSchema,
    runner: z
      .object({
        target: z.literal("windows-x64"),
        node_platform: z.literal("win32"),
        architecture: z.literal("x64")
      })
      .strict(),
    runtime: z
      .object({
        version: z.literal("0.144.0"),
        binding_id: z.literal(
          "codex-app-server-0.144.0-experimental:sha256:e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24"
        ),
        exact_binding: z.literal(true),
        app_server_process_count: z.literal(2),
        connection_generation_count: z.literal(2),
        endpoint_rotation_count: z.literal(1),
        credential_rotation_count: z.literal(1)
      })
      .strict(),
    execution: z
      .object({
        duration_ms: positiveCount.max(600_000),
        managed_thread_count: z.literal(2),
        selected_cwd_count: z.literal(2),
        request_count: positiveCount.max(10_000),
        notification_count: positiveCount.max(100_000),
        observer_count: positiveCount.max(100_000),
        durable_publication_count: positiveCount.max(100_000),
        durable_publication_sessions: z.literal(2),
        turn_start_count: z.literal(3),
        compact_start_count: z.literal(1),
        server_request_count: z.literal(1),
        proof_count: z.literal(17),
        proof_source_count: z.literal(8),
        aggregate_retry_count: z.literal(0)
      })
      .strict(),
    operations: z
      .object({
        managed_thread_lifecycle: z.literal(true),
        prompt_model_and_plan: z.literal(true),
        passive_goal: z.literal(true),
        usage_and_skills: z.literal(true),
        approval_and_side_effect: z.literal(true),
        interrupt: z.literal(true),
        compact: z.literal(true),
        concurrent_tui_resume: z.literal(true),
        forced_process_restart: z.literal(true),
        durable_reconciliation: z.literal(true),
        post_reconnect_readmission: z.literal(true)
      })
      .strict(),
    continuity: z
      .object({
        completed_reconnects: z.literal(1),
        disconnect_cleanups: z.literal(1),
        reconciliation_cycles: z.literal(2),
        durable_session_count: z.literal(2),
        boundary_count: z.literal(2),
        ready_count: z.literal(2),
        stale_authority_rejections: z.literal(1)
      })
      .strict(),
    integrity: z
      .object({
        pipeline_failure_count: z.literal(0),
        protocol_issue_count: z.literal(0),
        background_error_count: z.literal(0),
        callback_failure_count: z.literal(0),
        isolated_thread_turn_event_count: z.literal(0),
        isolated_thread_turn_start_request_count: z.literal(0)
      })
      .strict(),
    privacy: z
      .object({
        contains_pid: z.literal(false),
        contains_path: z.literal(false),
        contains_endpoint_or_process_identity: z.literal(false),
        contains_thread_turn_session_request_or_operation_id: z.literal(false),
        contains_model_effort_prompt_goal_command_tui_or_auth: z.literal(false),
        contains_raw_protocol_output_audit_or_error: z.literal(false)
      })
      .strict(),
    cleanup: z
      .object({
        runtime_thread_archive_count: z.literal(2),
        app_servers_remaining: z.literal(0),
        listeners_remaining: z.literal(0),
        credential_files_remaining: z.literal(0),
        tui_processes_remaining: z.literal(0),
        database_closed: z.literal(true),
        temporary_roots_remaining: z.literal(0)
      })
      .strict()
  })
  .strict();

export interface WindowsStructuredVerticalReportInput {
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly duration_ms: number;
  readonly request_count: number;
  readonly notification_count: number;
  readonly observer_count: number;
  readonly durable_publication_count: number;
}

export type WindowsStructuredVerticalReport = z.infer<
  typeof windowsStructuredVerticalReportSchema
>;

export function createWindowsStructuredVerticalReport(
  input: WindowsStructuredVerticalReportInput
): WindowsStructuredVerticalReport {
  return parseWindowsStructuredVerticalReport({
    schema_version: 1,
    task: "INT-V1-104",
    scenario: "exact_windows_structured_vertical",
    observed_at: input.observed_at,
    hostdeck_commit: input.hostdeck_commit,
    runner: {
      target: "windows-x64",
      node_platform: "win32",
      architecture: "x64"
    },
    runtime: {
      version: "0.144.0",
      binding_id:
        "codex-app-server-0.144.0-experimental:sha256:e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24",
      exact_binding: true,
      app_server_process_count: 2,
      connection_generation_count: 2,
      endpoint_rotation_count: 1,
      credential_rotation_count: 1
    },
    execution: {
      duration_ms: input.duration_ms,
      managed_thread_count: 2,
      selected_cwd_count: 2,
      request_count: input.request_count,
      notification_count: input.notification_count,
      observer_count: input.observer_count,
      durable_publication_count: input.durable_publication_count,
      durable_publication_sessions: 2,
      turn_start_count: 3,
      compact_start_count: 1,
      server_request_count: 1,
      proof_count: 17,
      proof_source_count: 8,
      aggregate_retry_count: 0
    },
    operations: {
      managed_thread_lifecycle: true,
      prompt_model_and_plan: true,
      passive_goal: true,
      usage_and_skills: true,
      approval_and_side_effect: true,
      interrupt: true,
      compact: true,
      concurrent_tui_resume: true,
      forced_process_restart: true,
      durable_reconciliation: true,
      post_reconnect_readmission: true
    },
    continuity: {
      completed_reconnects: 1,
      disconnect_cleanups: 1,
      reconciliation_cycles: 2,
      durable_session_count: 2,
      boundary_count: 2,
      ready_count: 2,
      stale_authority_rejections: 1
    },
    integrity: {
      pipeline_failure_count: 0,
      protocol_issue_count: 0,
      background_error_count: 0,
      callback_failure_count: 0,
      isolated_thread_turn_event_count: 0,
      isolated_thread_turn_start_request_count: 0
    },
    privacy: {
      contains_pid: false,
      contains_path: false,
      contains_endpoint_or_process_identity: false,
      contains_thread_turn_session_request_or_operation_id: false,
      contains_model_effort_prompt_goal_command_tui_or_auth: false,
      contains_raw_protocol_output_audit_or_error: false
    },
    cleanup: {
      runtime_thread_archive_count: 2,
      app_servers_remaining: 0,
      listeners_remaining: 0,
      credential_files_remaining: 0,
      tui_processes_remaining: 0,
      database_closed: true,
      temporary_roots_remaining: 0
    }
  });
}

export function parseWindowsStructuredVerticalReport(
  candidate: unknown,
  expectedCommit?: string
): WindowsStructuredVerticalReport {
  const parsed = windowsStructuredVerticalReportSchema.parse(candidate);
  if (
    expectedCommit !== undefined &&
    parsed.hostdeck_commit !== expectedCommit
  ) {
    throw new TypeError("Windows structured vertical report commit does not match.");
  }
  return deepFreeze(parsed);
}

export function requireWindowsStructuredVerticalReportPath(
  candidate: string,
  expectedRoot: string
): string {
  if (!isAbsolute(candidate) || !isAbsolute(expectedRoot)) {
    throw new TypeError("Windows structured vertical report paths are invalid.");
  }
  const path = resolve(candidate);
  const root = resolve(expectedRoot);
  const rootMetadata = lstatSync(root);
  if (
    basename(path) !== windowsStructuredVerticalReportName ||
    dirname(path) !== root ||
    existsSync(path) ||
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink()
  ) {
    throw new TypeError("Windows structured vertical report path is invalid.");
  }
  return path;
}

export function publishWindowsStructuredVerticalReport(
  path: string,
  report: WindowsStructuredVerticalReport
): WindowsStructuredVerticalReport {
  const parsed = parseWindowsStructuredVerticalReport(report);
  writeFileSync(path, `${JSON.stringify(parsed)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  secureHostDeckRegularFile(path, {
    label: "Windows structured vertical report",
    mode: 0o600,
    repair_mode: true
  });
  return readWindowsStructuredVerticalReport(path);
}

export function readWindowsStructuredVerticalReport(
  path: string,
  expectedCommit?: string
): WindowsStructuredVerticalReport {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 2 ||
    metadata.size > 64 * 1_024
  ) {
    throw new TypeError("Windows structured vertical report file is invalid.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TypeError("Windows structured vertical report is not valid JSON.", {
      cause: error
    });
  }
  return parseWindowsStructuredVerticalReport(decoded, expectedCommit);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
