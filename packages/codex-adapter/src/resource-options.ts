import { type ResourceBudget, resourceBudgetSchema } from "@hostdeck/contracts";

export const codexResourceBudgetKeys = [
  "protocol_connect_timeout_ms",
  "protocol_handshake_timeout_ms",
  "protocol_reconnect_initial_delay_ms",
  "protocol_reconnect_max_delay_ms",
  "protocol_read_timeout_ms",
  "protocol_mutation_timeout_ms",
  "protocol_start_timeout_ms",
  "protocol_close_timeout_ms",
  "protocol_heartbeat_interval_ms",
  "protocol_heartbeat_timeout_ms",
  "protocol_max_frame_bytes",
  "protocol_max_buffered_bytes",
  "protocol_max_in_flight_requests",
  "protocol_max_pending_server_requests",
  "protocol_max_pending_notifications",
  "protocol_thread_page_size",
  "protocol_thread_max_pages",
  "protocol_thread_max_loaded_reads",
  "protocol_model_page_size",
  "protocol_model_max_pages",
  "protocol_model_max_entries",
  "protocol_usage_max_daily_buckets",
  "protocol_skills_max_entries_per_cwd",
  "protocol_skills_max_errors_per_cwd",
  "protocol_skills_max_dependencies_per_skill",
  "protocol_collaboration_max_entries"
] as const;

export interface CodexTransportResourceOptions {
  readonly handshake_timeout_ms: number;
  readonly close_timeout_ms: number;
  readonly heartbeat_interval_ms: number;
  readonly heartbeat_timeout_ms: number;
  readonly max_frame_bytes: number;
  readonly max_buffered_bytes: number;
}

export interface CodexConnectionResourceOptions {
  readonly handshake_timeout_ms: number;
  readonly max_in_flight: number;
  readonly max_server_requests: number;
}

export interface CodexReconnectResourceOptions {
  readonly initial_delay_ms: number;
  readonly max_delay_ms: number;
}

export interface CodexThreadResourceOptions {
  readonly page_size: number;
  readonly max_pages: number;
  readonly max_loaded_reads: number;
  readonly read_timeout_ms: number;
  readonly mutation_timeout_ms: number;
  readonly start_timeout_ms: number;
}

export interface CodexEventPipelineResourceOptions {
  readonly max_pending_notifications: number;
}

export interface CodexModelResourceOptions {
  readonly page_size: number;
  readonly max_pages: number;
  readonly max_entries: number;
  readonly read_timeout_ms: number;
  readonly start_timeout_ms: number;
}

export interface CodexPlanResourceOptions {
  readonly max_entries: number;
  readonly read_timeout_ms: number;
  readonly start_timeout_ms: number;
}

export interface CodexUsageResourceOptions {
  readonly max_daily_buckets: number;
  readonly read_timeout_ms: number;
}

export interface CodexCompactResourceOptions {
  readonly mutation_timeout_ms: number;
}

export interface CodexApprovalResourceOptions {
  readonly mutation_timeout_ms: number;
}

export interface CodexSkillsResourceOptions {
  readonly max_entries_per_cwd: number;
  readonly max_errors_per_cwd: number;
  readonly max_dependencies_per_skill: number;
  readonly read_timeout_ms: number;
}

export interface CodexResourceOptions {
  readonly transport: CodexTransportResourceOptions;
  readonly connection: CodexConnectionResourceOptions;
  readonly reconnect: CodexReconnectResourceOptions;
  readonly event_pipeline: CodexEventPipelineResourceOptions;
  readonly thread: CodexThreadResourceOptions;
  readonly model: CodexModelResourceOptions;
  readonly plan: CodexPlanResourceOptions;
  readonly usage: CodexUsageResourceOptions;
  readonly compact: CodexCompactResourceOptions;
  readonly approval: CodexApprovalResourceOptions;
  readonly skills: CodexSkillsResourceOptions;
}

export function codexResourceOptionsFromBudget(input: unknown): CodexResourceOptions {
  const budget: ResourceBudget = resourceBudgetSchema.parse(input);
  return Object.freeze({
    transport: Object.freeze({
      handshake_timeout_ms: budget.protocol_connect_timeout_ms,
      close_timeout_ms: budget.protocol_close_timeout_ms,
      heartbeat_interval_ms: budget.protocol_heartbeat_interval_ms,
      heartbeat_timeout_ms: budget.protocol_heartbeat_timeout_ms,
      max_frame_bytes: budget.protocol_max_frame_bytes,
      max_buffered_bytes: budget.protocol_max_buffered_bytes
    }),
    connection: Object.freeze({
      handshake_timeout_ms: budget.protocol_handshake_timeout_ms,
      max_in_flight: budget.protocol_max_in_flight_requests,
      max_server_requests: budget.protocol_max_pending_server_requests
    }),
    reconnect: Object.freeze({
      initial_delay_ms: budget.protocol_reconnect_initial_delay_ms,
      max_delay_ms: budget.protocol_reconnect_max_delay_ms
    }),
    event_pipeline: Object.freeze({
      max_pending_notifications: budget.protocol_max_pending_notifications
    }),
    thread: Object.freeze({
      page_size: budget.protocol_thread_page_size,
      max_pages: budget.protocol_thread_max_pages,
      max_loaded_reads: budget.protocol_thread_max_loaded_reads,
      read_timeout_ms: budget.protocol_read_timeout_ms,
      mutation_timeout_ms: budget.protocol_mutation_timeout_ms,
      start_timeout_ms: budget.protocol_start_timeout_ms
    }),
    model: Object.freeze({
      page_size: budget.protocol_model_page_size,
      max_pages: budget.protocol_model_max_pages,
      max_entries: budget.protocol_model_max_entries,
      read_timeout_ms: budget.protocol_read_timeout_ms,
      start_timeout_ms: budget.protocol_start_timeout_ms
    }),
    plan: Object.freeze({
      max_entries: budget.protocol_collaboration_max_entries,
      read_timeout_ms: budget.protocol_read_timeout_ms,
      start_timeout_ms: budget.protocol_start_timeout_ms
    }),
    usage: Object.freeze({
      max_daily_buckets: budget.protocol_usage_max_daily_buckets,
      read_timeout_ms: budget.protocol_read_timeout_ms
    }),
    compact: Object.freeze({
      mutation_timeout_ms: budget.protocol_mutation_timeout_ms
    }),
    approval: Object.freeze({
      mutation_timeout_ms: budget.protocol_mutation_timeout_ms
    }),
    skills: Object.freeze({
      max_entries_per_cwd: budget.protocol_skills_max_entries_per_cwd,
      max_errors_per_cwd: budget.protocol_skills_max_errors_per_cwd,
      max_dependencies_per_skill: budget.protocol_skills_max_dependencies_per_skill,
      read_timeout_ms: budget.protocol_read_timeout_ms
    })
  });
}
