import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  readCodexSmokePrivateJson,
  writeCodexSmokePrivateJson
} from "./codex-hostdeck-restart-smoke-support.js";
import { assertPrivateLifecycleDirectory } from "./codex-runtime-lifecycle-files.js";

export const structuredVerticalReportName = "structured-vertical-report.json";

const safeCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = safeCountSchema.min(1);
const fullCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const privacySchema = z
  .object({
    contains_pid: z.literal(false),
    contains_path: z.literal(false),
    contains_socket_or_process_identity: z.literal(false),
    contains_thread_turn_session_request_or_operation_id: z.literal(false),
    contains_model_effort_prompt_goal_command_tui_or_auth: z.literal(false),
    contains_raw_protocol_output_audit_or_error: z.literal(false)
  })
  .strict();

const structuredVerticalReportSchema = z
  .object({
    schema_version: z.literal(1),
    task: z.literal("INT-V1-027"),
    scenario: z.literal("exact_structured_vertical"),
    observed_at: z.string().datetime({ offset: true }),
    hostdeck_commit: fullCommitSchema,
    runtime: z
      .object({
        version: z.literal("0.144.0"),
        exact_binding: z.literal(true),
        app_server_process_count: z.literal(1),
        connection_generation_count: z.literal(1)
      })
      .strict(),
    execution: z
      .object({
        duration_ms: positiveCountSchema.max(600_000),
        managed_thread_count: z.literal(2),
        selected_cwd_count: z.literal(2),
        request_count: positiveCountSchema.max(10_000),
        notification_count: positiveCountSchema.max(100_000),
        observer_count: positiveCountSchema.max(100_000),
        durable_publication_count: positiveCountSchema.max(100_000),
        durable_publication_sessions: z.literal(2),
        turn_start_count: z.literal(3),
        compact_start_count: z.literal(1),
        server_request_count: z.literal(1),
        proof_count: z.literal(16),
        proof_source_count: z.literal(8)
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
        tui_resume: z.literal(true)
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
    privacy: privacySchema,
    cleanup: z
      .object({
        runtime_thread_archive_count: z.literal(2),
        app_servers_remaining: z.literal(0),
        tui_processes_remaining: z.literal(0),
        tmux_sockets_remaining: z.literal(0),
        unix_sockets_remaining: z.literal(0),
        database_closed: z.literal(true),
        temporary_root_removed: z.literal(true)
      })
      .strict()
  })
  .strict();

export interface StructuredVerticalReportInput {
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly duration_ms: number;
  readonly request_count: number;
  readonly notification_count: number;
  readonly observer_count: number;
  readonly durable_publication_count: number;
}

export type StructuredVerticalReport = z.infer<
  typeof structuredVerticalReportSchema
>;

export function createStructuredVerticalReport(
  input: StructuredVerticalReportInput
): StructuredVerticalReport {
  return parseStructuredVerticalReport({
    schema_version: 1,
    task: "INT-V1-027",
    scenario: "exact_structured_vertical",
    observed_at: input.observed_at,
    hostdeck_commit: input.hostdeck_commit,
    runtime: {
      version: "0.144.0",
      exact_binding: true,
      app_server_process_count: 1,
      connection_generation_count: 1
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
      proof_count: 16,
      proof_source_count: 8
    },
    operations: {
      managed_thread_lifecycle: true,
      prompt_model_and_plan: true,
      passive_goal: true,
      usage_and_skills: true,
      approval_and_side_effect: true,
      interrupt: true,
      compact: true,
      tui_resume: true
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
      contains_socket_or_process_identity: false,
      contains_thread_turn_session_request_or_operation_id: false,
      contains_model_effort_prompt_goal_command_tui_or_auth: false,
      contains_raw_protocol_output_audit_or_error: false
    },
    cleanup: {
      runtime_thread_archive_count: 2,
      app_servers_remaining: 0,
      tui_processes_remaining: 0,
      tmux_sockets_remaining: 0,
      unix_sockets_remaining: 0,
      database_closed: true,
      temporary_root_removed: true
    }
  });
}

export function parseStructuredVerticalReport(
  candidate: unknown,
  expectedCommit?: string
): StructuredVerticalReport {
  const parsed = structuredVerticalReportSchema.parse(candidate);
  if (expectedCommit !== undefined && parsed.hostdeck_commit !== expectedCommit) {
    throw new TypeError("Structured vertical report commit does not match.");
  }
  return deepFreeze(parsed);
}

export function requireStructuredVerticalReportPath(
  candidate: string,
  expectedRoot: string
): string {
  if (!isAbsolute(candidate) || !isAbsolute(expectedRoot)) {
    throw new TypeError("Structured vertical report paths must be absolute.");
  }
  const path = resolve(candidate);
  const root = resolve(expectedRoot);
  if (
    basename(path) !== structuredVerticalReportName ||
    dirname(path) !== root ||
    existsSync(path)
  ) {
    throw new TypeError("Structured vertical report path is invalid.");
  }
  assertPrivateLifecycleDirectory(root);
  return path;
}

export function publishStructuredVerticalReport(
  path: string,
  report: StructuredVerticalReport
): StructuredVerticalReport {
  writeCodexSmokePrivateJson(path, parseStructuredVerticalReport(report));
  return readStructuredVerticalReport(path);
}

export function readStructuredVerticalReport(
  path: string,
  expectedCommit?: string
): StructuredVerticalReport {
  return parseStructuredVerticalReport(
    readCodexSmokePrivateJson(path),
    expectedCommit
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
