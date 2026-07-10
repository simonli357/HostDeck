import type { ErrorCode } from "@hostdeck/core";
import { z } from "zod";

export const resourceBudgetUnits = ["bytes", "count", "milliseconds"] as const;
export type ResourceBudgetUnit = (typeof resourceBudgetUnits)[number];

export const resourceBudgetOwners = [
  "cli_client",
  "codex_broker",
  "codex_event_pipeline",
  "codex_transport",
  "fastify_app",
  "host_service",
  "runtime_supervisor",
  "sse_transport",
  "turn_control",
  "trust_service"
] as const;
export type ResourceBudgetOwner = (typeof resourceBudgetOwners)[number];

export const resourceBreachActions = [
  "abort_operation",
  "close_connection",
  "close_subscriber",
  "continue_cleanup",
  "evict_state",
  "reject_operation",
  "reject_request",
  "terminate_resource"
] as const;
export type ResourceBreachAction = (typeof resourceBreachActions)[number];

export interface ResourceBudgetDefinition<Key extends string = string> {
  readonly key: Key;
  readonly unit: ResourceBudgetUnit;
  readonly minimum: number;
  readonly default_value: number;
  readonly maximum: number;
  readonly owner: ResourceBudgetOwner;
  readonly breach_code: ErrorCode;
  readonly breach_action: ResourceBreachAction;
  readonly observation: `hostdeck.resource.${Key}`;
}

function defineResource<const Key extends string>(
  key: Key,
  unit: ResourceBudgetUnit,
  minimum: number,
  defaultValue: number,
  maximum: number,
  owner: ResourceBudgetOwner,
  breachCode: ErrorCode,
  breachAction: ResourceBreachAction
): ResourceBudgetDefinition<Key> {
  return Object.freeze({
    key,
    unit,
    minimum,
    default_value: defaultValue,
    maximum,
    owner,
    breach_code: breachCode,
    breach_action: breachAction,
    observation: `hostdeck.resource.${key}`
  });
}

export const resourceBudgetDefinitions = Object.freeze([
  defineResource("http_body_max_bytes", "bytes", 1_024, 65_536, 1_048_576, "fastify_app", "request_too_large", "reject_request"),
  defineResource("http_headers_max_bytes", "bytes", 4_096, 16_384, 65_536, "host_service", "malformed_request", "close_connection"),
  defineResource("http_headers_max_count", "count", 16, 64, 256, "host_service", "malformed_request", "close_connection"),
  defineResource("http_url_max_bytes", "bytes", 256, 2_048, 8_192, "fastify_app", "malformed_request", "reject_request"),
  defineResource("http_route_param_max_bytes", "bytes", 64, 128, 512, "fastify_app", "validation_error", "reject_request"),
  defineResource("http_headers_timeout_ms", "milliseconds", 1_000, 10_000, 30_000, "host_service", "operation_timeout", "close_connection"),
  defineResource("http_request_receive_timeout_ms", "milliseconds", 1_000, 15_000, 60_000, "host_service", "operation_timeout", "close_connection"),
  defineResource("http_request_deadline_ms", "milliseconds", 1_000, 30_000, 120_000, "fastify_app", "operation_timeout", "abort_operation"),
  defineResource("http_connection_idle_timeout_ms", "milliseconds", 5_000, 60_000, 300_000, "host_service", "operation_timeout", "close_connection"),
  defineResource("http_keep_alive_timeout_ms", "milliseconds", 1_000, 5_000, 60_000, "host_service", "operation_timeout", "close_connection"),
  defineResource("http_max_connections", "count", 1, 64, 1_024, "host_service", "service_overloaded", "close_connection"),
  defineResource("http_max_in_flight_requests", "count", 1, 64, 1_024, "fastify_app", "service_overloaded", "reject_request"),
  defineResource("http_max_requests_per_socket", "count", 1, 1_000, 10_000, "host_service", "service_overloaded", "close_connection"),

  defineResource("sse_heartbeat_interval_ms", "milliseconds", 1_000, 15_000, 60_000, "sse_transport", "operation_timeout", "close_subscriber"),
  defineResource("sse_max_subscribers", "count", 1, 32, 512, "sse_transport", "service_overloaded", "reject_request"),
  defineResource("sse_max_subscribers_per_device", "count", 1, 8, 64, "sse_transport", "service_overloaded", "reject_request"),
  defineResource("sse_max_subscribers_per_session", "count", 1, 4, 32, "sse_transport", "service_overloaded", "reject_request"),
  defineResource("sse_queue_max_events", "count", 8, 256, 2_048, "sse_transport", "service_overloaded", "close_subscriber"),
  defineResource("sse_queue_max_bytes", "bytes", 65_536, 1_048_576, 8_388_608, "sse_transport", "service_overloaded", "close_subscriber"),
  defineResource("sse_event_max_bytes", "bytes", 1_024, 65_536, 262_144, "sse_transport", "service_overloaded", "close_subscriber"),
  defineResource("sse_replay_max_events", "count", 1, 2_000, 10_000, "sse_transport", "service_overloaded", "close_subscriber"),
  defineResource("sse_replay_max_bytes", "bytes", 65_536, 8_388_608, 33_554_432, "sse_transport", "service_overloaded", "close_subscriber"),
  defineResource("sse_disconnect_cleanup_timeout_ms", "milliseconds", 50, 2_000, 10_000, "sse_transport", "operation_timeout", "abort_operation"),
  defineResource("sse_shutdown_timeout_ms", "milliseconds", 50, 2_000, 10_000, "sse_transport", "operation_timeout", "abort_operation"),

  defineResource("pair_claim_window_ms", "milliseconds", 1_000, 60_000, 300_000, "trust_service", "rate_limited", "reject_request"),
  defineResource("pair_claim_max_attempts_per_source", "count", 1, 10, 100, "trust_service", "rate_limited", "reject_request"),
  defineResource("pair_claim_max_in_flight_per_source", "count", 1, 1, 4, "trust_service", "service_overloaded", "reject_request"),
  defineResource("pair_claim_max_in_flight", "count", 1, 4, 32, "trust_service", "service_overloaded", "reject_request"),
  defineResource("mutation_window_ms", "milliseconds", 1_000, 60_000, 300_000, "trust_service", "rate_limited", "reject_request"),
  defineResource("mutation_max_requests_per_device", "count", 1, 60, 600, "trust_service", "rate_limited", "reject_request"),
  defineResource("mutation_max_in_flight_per_device", "count", 1, 2, 16, "trust_service", "service_overloaded", "reject_request"),
  defineResource("mutation_max_in_flight_per_target", "count", 1, 1, 8, "trust_service", "service_overloaded", "reject_request"),
  defineResource("mutation_max_in_flight_global", "count", 1, 16, 128, "trust_service", "service_overloaded", "reject_request"),
  defineResource("admission_max_tracked_keys", "count", 64, 1_024, 16_384, "trust_service", "service_overloaded", "reject_request"),
  defineResource("admission_state_ttl_ms", "milliseconds", 60_000, 600_000, 3_600_000, "trust_service", "service_overloaded", "evict_state"),

  defineResource("protocol_connect_timeout_ms", "milliseconds", 500, 5_000, 30_000, "codex_transport", "runtime_unavailable", "abort_operation"),
  defineResource("protocol_handshake_timeout_ms", "milliseconds", 1_000, 10_000, 120_000, "codex_broker", "incompatible_runtime", "abort_operation"),
  defineResource("protocol_read_timeout_ms", "milliseconds", 1_000, 10_000, 120_000, "codex_broker", "operation_timeout", "abort_operation"),
  defineResource("protocol_mutation_timeout_ms", "milliseconds", 1_000, 15_000, 120_000, "codex_broker", "operation_timeout", "abort_operation"),
  defineResource("protocol_start_timeout_ms", "milliseconds", 1_000, 30_000, 120_000, "codex_broker", "operation_timeout", "abort_operation"),
  defineResource("protocol_close_timeout_ms", "milliseconds", 100, 2_000, 10_000, "codex_transport", "operation_timeout", "terminate_resource"),
  defineResource("protocol_heartbeat_interval_ms", "milliseconds", 1_000, 15_000, 120_000, "codex_transport", "runtime_unavailable", "terminate_resource"),
  defineResource("protocol_heartbeat_timeout_ms", "milliseconds", 100, 5_000, 30_000, "codex_transport", "runtime_unavailable", "terminate_resource"),
  defineResource("protocol_max_frame_bytes", "bytes", 1_024, 1_048_576, 8_388_608, "codex_transport", "runtime_unavailable", "terminate_resource"),
  defineResource("protocol_max_buffered_bytes", "bytes", 1_024, 2_097_152, 16_777_216, "codex_transport", "service_overloaded", "reject_operation"),
  defineResource("protocol_max_in_flight_requests", "count", 1, 32, 256, "codex_broker", "service_overloaded", "reject_operation"),
  defineResource("protocol_max_pending_server_requests", "count", 1, 16, 64, "codex_broker", "service_overloaded", "reject_operation"),
  defineResource(
    "protocol_max_pending_notifications",
    "count",
    8,
    256,
    2_048,
    "codex_event_pipeline",
    "service_overloaded",
    "terminate_resource"
  ),
  defineResource("protocol_thread_page_size", "count", 1, 100, 500, "codex_broker", "service_overloaded", "abort_operation"),
  defineResource("protocol_thread_max_pages", "count", 1, 100, 100, "codex_broker", "service_overloaded", "abort_operation"),
  defineResource("protocol_thread_max_loaded_reads", "count", 1, 500, 5_000, "codex_broker", "service_overloaded", "abort_operation"),
  defineResource("protocol_model_page_size", "count", 1, 100, 128, "codex_broker", "service_overloaded", "abort_operation"),
  defineResource("protocol_model_max_pages", "count", 1, 10, 100, "codex_broker", "service_overloaded", "abort_operation"),
  defineResource("protocol_model_max_entries", "count", 1, 128, 128, "codex_broker", "service_overloaded", "abort_operation"),
  defineResource("protocol_collaboration_max_entries", "count", 2, 8, 32, "codex_broker", "service_overloaded", "abort_operation"),
  defineResource("control_model_max_pending_selections", "count", 1, 128, 4_096, "turn_control", "service_overloaded", "reject_operation"),
  defineResource("control_plan_max_pending_selections", "count", 1, 128, 4_096, "turn_control", "service_overloaded", "reject_operation"),
  defineResource("control_goal_max_uncertain_mutations", "count", 1, 128, 4_096, "turn_control", "service_overloaded", "reject_operation"),

  defineResource("lifecycle_startup_timeout_ms", "milliseconds", 1_000, 60_000, 300_000, "runtime_supervisor", "operation_timeout", "abort_operation"),
  defineResource("lifecycle_shutdown_timeout_ms", "milliseconds", 1_000, 10_000, 60_000, "host_service", "operation_timeout", "terminate_resource"),
  defineResource("lifecycle_cleanup_step_timeout_ms", "milliseconds", 50, 2_000, 10_000, "host_service", "operation_timeout", "continue_cleanup"),

  defineResource("cli_connect_timeout_ms", "milliseconds", 500, 5_000, 30_000, "cli_client", "daemon_unavailable", "abort_operation"),
  defineResource("cli_request_timeout_ms", "milliseconds", 1_000, 35_000, 180_000, "cli_client", "operation_timeout", "abort_operation"),
  defineResource("cli_request_body_max_bytes", "bytes", 1_024, 65_536, 1_048_576, "cli_client", "request_too_large", "reject_operation"),
  defineResource("cli_response_max_bytes", "bytes", 1_024, 1_048_576, 8_388_608, "cli_client", "service_overloaded", "abort_operation"),
  defineResource("cli_stream_idle_timeout_ms", "milliseconds", 5_000, 45_000, 300_000, "cli_client", "operation_timeout", "abort_operation"),
  defineResource("cli_max_in_flight_requests", "count", 1, 4, 32, "cli_client", "service_overloaded", "reject_operation")
] as const);

export type ResourceBudgetKey = (typeof resourceBudgetDefinitions)[number]["key"];

const resourceBudgetShape = Object.fromEntries(
  resourceBudgetDefinitions.map((definition) => [
    definition.key,
    z.number().int().min(definition.minimum).max(definition.maximum).default(definition.default_value)
  ])
) as { readonly [Key in ResourceBudgetKey]: z.ZodDefault<z.ZodNumber> };

export const resourceBudgetSchema = z
  .object(resourceBudgetShape)
  .strict()
  .superRefine((value, context) => {
    const atMost = (left: ResourceBudgetKey, right: ResourceBudgetKey, message: string) => {
      if (value[left] > value[right]) context.addIssue({ code: "custom", path: [left], message });
    };
    const lessThan = (left: ResourceBudgetKey, right: ResourceBudgetKey, message: string) => {
      if (value[left] >= value[right]) context.addIssue({ code: "custom", path: [left], message });
    };
    const atLeast = (left: ResourceBudgetKey, right: ResourceBudgetKey, message: string) => {
      if (value[left] < value[right]) context.addIssue({ code: "custom", path: [left], message });
    };

    atMost("http_headers_timeout_ms", "http_request_receive_timeout_ms", "Header timeout must fit within the HTTP receive timeout.");
    atMost("http_request_receive_timeout_ms", "http_request_deadline_ms", "HTTP receive timeout must fit within the route deadline.");
    lessThan("http_keep_alive_timeout_ms", "http_connection_idle_timeout_ms", "Keep-alive timeout must be shorter than the connection idle timeout.");
    lessThan("sse_heartbeat_interval_ms", "http_connection_idle_timeout_ms", "SSE heartbeat must occur before the HTTP connection idle timeout.");
    lessThan("sse_max_subscribers", "http_max_connections", "SSE subscribers must leave at least one HTTP connection available.");
    atMost("sse_max_subscribers_per_device", "sse_max_subscribers", "Per-device SSE subscribers cannot exceed the global subscriber cap.");
    atMost("sse_max_subscribers_per_session", "sse_max_subscribers", "Per-session SSE subscribers cannot exceed the global subscriber cap.");
    atMost("sse_event_max_bytes", "sse_queue_max_bytes", "One SSE event must fit in a subscriber queue.");
    atMost("sse_event_max_bytes", "sse_replay_max_bytes", "One SSE event must fit in a replay response.");
    atMost("sse_queue_max_events", "sse_replay_max_events", "Replay capacity must cover at least one full subscriber queue.");
    atMost("sse_queue_max_bytes", "sse_replay_max_bytes", "Replay byte capacity must cover at least one full subscriber queue.");
    atMost("sse_disconnect_cleanup_timeout_ms", "lifecycle_shutdown_timeout_ms", "SSE disconnect cleanup must fit within shutdown.");
    atMost("sse_shutdown_timeout_ms", "lifecycle_shutdown_timeout_ms", "SSE shutdown must fit within host shutdown.");

    atMost("pair_claim_window_ms", "admission_state_ttl_ms", "Pair-claim state must outlive its rate window.");
    atMost("mutation_window_ms", "admission_state_ttl_ms", "Mutation admission state must outlive its rate window.");
    atMost("pair_claim_max_in_flight_per_source", "pair_claim_max_in_flight", "Per-source pair-claim concurrency cannot exceed global concurrency.");
    atMost("mutation_max_in_flight_per_device", "mutation_max_in_flight_global", "Per-device mutation concurrency cannot exceed global concurrency.");
    atMost("mutation_max_in_flight_per_target", "mutation_max_in_flight_global", "Per-target mutation concurrency cannot exceed global concurrency.");
    atMost("pair_claim_max_in_flight", "http_max_in_flight_requests", "Pair-claim concurrency must fit within HTTP request concurrency.");
    atMost("mutation_max_in_flight_global", "http_max_in_flight_requests", "Mutation concurrency must fit within HTTP request concurrency.");

    lessThan("protocol_heartbeat_timeout_ms", "protocol_heartbeat_interval_ms", "Protocol heartbeat timeout must be shorter than its interval.");
    atMost("protocol_max_frame_bytes", "protocol_max_buffered_bytes", "One protocol frame must fit in the outbound buffer.");
    lessThan("http_body_max_bytes", "protocol_max_frame_bytes", "An HTTP body plus protocol envelope must fit in one protocol frame.");
    atMost("sse_event_max_bytes", "protocol_max_frame_bytes", "A projected SSE event cannot exceed the protocol frame bound.");
    atMost("protocol_read_timeout_ms", "http_request_deadline_ms", "Protocol reads must fit within the HTTP request deadline.");
    atMost("protocol_mutation_timeout_ms", "http_request_deadline_ms", "Protocol mutations must fit within the HTTP request deadline.");
    atMost("protocol_start_timeout_ms", "http_request_deadline_ms", "Protocol session start must fit within the HTTP request deadline.");
    atMost("protocol_max_in_flight_requests", "http_max_in_flight_requests", "Protocol in-flight requests cannot exceed HTTP request concurrency.");
    atMost("protocol_model_page_size", "protocol_model_max_entries", "One model page must fit within the model catalog entry bound.");
    atMost("protocol_close_timeout_ms", "lifecycle_shutdown_timeout_ms", "Protocol close must fit within host shutdown.");
    atMost("lifecycle_cleanup_step_timeout_ms", "lifecycle_shutdown_timeout_ms", "One cleanup step must fit within host shutdown.");
    atMost("cli_connect_timeout_ms", "cli_request_timeout_ms", "CLI connect timeout must fit within its request timeout.");
    atLeast("cli_request_timeout_ms", "http_request_deadline_ms", "CLI timeout cannot expire before the server request deadline.");
    atMost("cli_request_body_max_bytes", "http_body_max_bytes", "CLI request body must fit within the server body limit.");
    lessThan("sse_heartbeat_interval_ms", "cli_stream_idle_timeout_ms", "CLI stream idle timeout must allow an SSE heartbeat.");

    if (value.protocol_connect_timeout_ms + value.protocol_handshake_timeout_ms > value.lifecycle_startup_timeout_ms) {
      context.addIssue({
        code: "custom",
        path: ["lifecycle_startup_timeout_ms"],
        message: "Startup timeout must cover protocol connect plus handshake."
      });
    }
  });

export type ResourceBudget = z.output<typeof resourceBudgetSchema>;

export function resolveResourceBudget(input: unknown): ResourceBudget {
  return Object.freeze(resourceBudgetSchema.parse(input));
}

export function assertResolvedResourceBudget(input: unknown): asserts input is ResourceBudget {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Resolved resource budget must be an object.");
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Resolved resource budget must be a plain object.");
  }
  if (!Object.isFrozen(input)) {
    throw new TypeError("Resolved resource budget must be frozen.");
  }
  const keys = Object.keys(input);
  if (
    keys.length !== resourceBudgetDefinitions.length ||
    resourceBudgetDefinitions.some((definition) => !Object.hasOwn(input, definition.key))
  ) {
    throw new TypeError("Resolved resource budget must contain every selected resource key exactly once.");
  }
  const result = resourceBudgetSchema.safeParse(input);
  if (!result.success) {
    throw new TypeError("Resolved resource budget is invalid.", { cause: result.error });
  }
}

export const defaultResourceBudget: ResourceBudget = resolveResourceBudget({});

export const resourceBudgetDefinitionByKey = Object.freeze(
  Object.fromEntries(resourceBudgetDefinitions.map((definition) => [definition.key, definition]))
) as Readonly<Record<ResourceBudgetKey, ResourceBudgetDefinition>>;
