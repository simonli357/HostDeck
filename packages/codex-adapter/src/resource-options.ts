import { type ResourceBudget, resourceBudgetSchema } from "@hostdeck/contracts";

export const codexResourceBudgetKeys = [
  "protocol_connect_timeout_ms",
  "protocol_handshake_timeout_ms",
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
  "protocol_thread_max_loaded_reads"
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

export interface CodexResourceOptions {
  readonly transport: CodexTransportResourceOptions;
  readonly connection: CodexConnectionResourceOptions;
  readonly event_pipeline: CodexEventPipelineResourceOptions;
  readonly thread: CodexThreadResourceOptions;
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
    })
  });
}
