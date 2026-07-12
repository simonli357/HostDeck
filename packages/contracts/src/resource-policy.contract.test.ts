import { isErrorCode } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  assertResolvedResourceBudget,
  defaultResourceBudget,
  type ResourceBudget,
  resolveResourceBudget,
  resourceBreachActions,
  resourceBudgetDefinitionByKey,
  resourceBudgetDefinitions,
  resourceBudgetOwners,
  resourceBudgetSchema,
  resourceBudgetUnits
} from "./index.js";

describe("selected V1 resource budget", () => {
  it("defines one complete, immutable, observable registry", () => {
    expect(resourceBudgetDefinitions).toHaveLength(79);
    expect(Object.isFrozen(resourceBudgetDefinitions)).toBe(true);
    expect(Object.isFrozen(defaultResourceBudget)).toBe(true);
    expect(Object.isFrozen(resourceBudgetDefinitionByKey)).toBe(true);

    const keys = resourceBudgetDefinitions.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(defaultResourceBudget).sort()).toEqual([...keys].sort());

    for (const definition of resourceBudgetDefinitions) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Number.isSafeInteger(definition.minimum)).toBe(true);
      expect(Number.isSafeInteger(definition.default_value)).toBe(true);
      expect(Number.isSafeInteger(definition.maximum)).toBe(true);
      expect(definition.minimum).toBeGreaterThan(0);
      expect(definition.default_value).toBeGreaterThanOrEqual(definition.minimum);
      expect(definition.default_value).toBeLessThanOrEqual(definition.maximum);
      expect(resourceBudgetUnits).toContain(definition.unit);
      expect(resourceBudgetOwners).toContain(definition.owner);
      expect(resourceBreachActions).toContain(definition.breach_action);
      expect(isErrorCode(definition.breach_code)).toBe(true);
      expect(definition.observation).toBe(`hostdeck.resource.${definition.key}`);
      expect(resourceBudgetDefinitionByKey[definition.key]).toBe(definition);
      expect(defaultResourceBudget[definition.key]).toBe(definition.default_value);
    }
  });

  it("freezes reviewed defaults for every selected boundary", () => {
    expect(defaultResourceBudget).toMatchObject({
      http_body_max_bytes: 65_536,
      http_headers_max_bytes: 16_384,
      http_request_receive_timeout_ms: 15_000,
      http_request_deadline_ms: 30_000,
      http_connection_idle_timeout_ms: 60_000,
      http_max_connections: 64,
      sse_heartbeat_interval_ms: 15_000,
      sse_max_subscribers: 32,
      sse_max_subscribers_per_device: 8,
      sse_queue_max_events: 256,
      sse_queue_max_bytes: 1_048_576,
      pairing_code_lifetime_ms: 300_000,
      paired_device_lifetime_ms: 7_776_000_000,
      pair_claim_max_attempts_per_source: 10,
      pair_claim_max_attempts_global: 100,
      pair_claim_max_in_flight_per_source: 1,
      mutation_max_in_flight_per_device: 2,
      mutation_max_in_flight_per_target: 1,
      protocol_connect_timeout_ms: 5_000,
      protocol_handshake_timeout_ms: 10_000,
      protocol_read_timeout_ms: 10_000,
      protocol_mutation_timeout_ms: 15_000,
      protocol_start_timeout_ms: 30_000,
      protocol_close_timeout_ms: 2_000,
      protocol_heartbeat_interval_ms: 15_000,
      protocol_heartbeat_timeout_ms: 5_000,
      protocol_max_frame_bytes: 1_048_576,
      protocol_max_buffered_bytes: 2_097_152,
      protocol_max_in_flight_requests: 32,
      protocol_max_pending_server_requests: 16,
      protocol_max_pending_notifications: 256,
      protocol_thread_page_size: 100,
      protocol_thread_max_pages: 100,
      protocol_thread_max_loaded_reads: 500,
      protocol_model_page_size: 100,
      protocol_model_max_pages: 10,
      protocol_model_max_entries: 128,
      protocol_usage_max_daily_buckets: 2_000,
      protocol_skills_max_entries_per_cwd: 256,
      protocol_skills_max_errors_per_cwd: 64,
      protocol_skills_max_dependencies_per_skill: 64,
      protocol_collaboration_max_entries: 8,
      control_prompt_max_tracked_turns: 128,
      control_interrupt_max_tracked_turns: 128,
      control_model_max_pending_selections: 128,
      control_plan_max_pending_selections: 128,
      control_goal_max_uncertain_mutations: 128,
      control_usage_max_tracked_threads: 128,
      control_compact_max_tracked_operations: 128,
      control_approval_expiry_ms: 300_000,
      lifecycle_startup_timeout_ms: 60_000,
      lifecycle_shutdown_timeout_ms: 10_000,
      lifecycle_cleanup_step_timeout_ms: 2_000,
      cli_connect_timeout_ms: 5_000,
      cli_request_timeout_ms: 35_000,
      cli_request_body_max_bytes: 65_536,
      cli_response_max_bytes: 1_048_576,
      cli_stream_idle_timeout_ms: 45_000,
      cli_max_in_flight_requests: 4
    });
  });

  it("rejects unknown, zero, fractional, non-finite, and out-of-range values", () => {
    expect(resourceBudgetSchema.safeParse({ unknown_limit: 1 }).success).toBe(false);

    for (const definition of resourceBudgetDefinitions) {
      for (const invalid of [0, definition.minimum - 1, definition.maximum + 1, 1.5, Number.POSITIVE_INFINITY]) {
        expect(
          resourceBudgetSchema.safeParse({ [definition.key]: invalid }).success,
          `${definition.key} accepted ${invalid}`
        ).toBe(false);
      }
    }
  });

  it("rejects policies whose limits defeat each other", () => {
    const contradictoryPolicies: readonly Partial<ResourceBudget>[] = [
      { http_headers_timeout_ms: 30_000, http_request_receive_timeout_ms: 10_000 },
      { http_request_receive_timeout_ms: 60_000, http_request_deadline_ms: 10_000 },
      {
        http_headers_timeout_ms: 1_000,
        http_request_receive_timeout_ms: 1_000,
        http_request_deadline_ms: 1_000,
        protocol_read_timeout_ms: 1_000,
        protocol_mutation_timeout_ms: 1_000,
        protocol_start_timeout_ms: 1_000
      },
      { http_keep_alive_timeout_ms: 60_000, http_connection_idle_timeout_ms: 60_000 },
      { sse_heartbeat_interval_ms: 60_000, http_connection_idle_timeout_ms: 60_000 },
      { sse_max_subscribers: 64, http_max_connections: 64 },
      { sse_max_subscribers_per_device: 64, sse_max_subscribers: 16 },
      { sse_max_subscribers_per_session: 32, sse_max_subscribers: 16 },
      { sse_event_max_bytes: 262_144, sse_queue_max_bytes: 65_536 },
      { sse_event_max_bytes: 262_144, sse_replay_max_bytes: 65_536 },
      { sse_queue_max_events: 2_048, sse_replay_max_events: 1 },
      { sse_queue_max_bytes: 8_388_608, sse_replay_max_bytes: 65_536 },
      { sse_disconnect_cleanup_timeout_ms: 10_000, lifecycle_shutdown_timeout_ms: 1_000 },
      { sse_shutdown_timeout_ms: 10_000, lifecycle_shutdown_timeout_ms: 1_000 },
      { pair_claim_window_ms: 300_000, admission_state_ttl_ms: 60_000 },
      { pair_claim_window_ms: 300_000, pairing_code_lifetime_ms: 60_000 },
      { pairing_code_lifetime_ms: 600_000, admission_state_ttl_ms: 60_000 },
      { pair_claim_max_attempts_per_source: 100, pair_claim_max_attempts_global: 1 },
      { mutation_window_ms: 300_000, admission_state_ttl_ms: 60_000 },
      { protocol_model_page_size: 128, protocol_model_max_entries: 64 },
      { pair_claim_max_in_flight_per_source: 4, pair_claim_max_in_flight: 1 },
      { mutation_max_in_flight_per_device: 16, mutation_max_in_flight_global: 1 },
      { mutation_max_in_flight_per_target: 8, mutation_max_in_flight_global: 1 },
      { pair_claim_max_in_flight: 32, http_max_in_flight_requests: 1 },
      { mutation_max_in_flight_global: 128, http_max_in_flight_requests: 1 },
      { protocol_heartbeat_timeout_ms: 30_000, protocol_heartbeat_interval_ms: 30_000 },
      { protocol_max_frame_bytes: 8_388_608, protocol_max_buffered_bytes: 1_024 },
      { http_body_max_bytes: 1_048_576, protocol_max_frame_bytes: 1_024 },
      { sse_event_max_bytes: 262_144, protocol_max_frame_bytes: 1_024 },
      { protocol_read_timeout_ms: 120_000, http_request_deadline_ms: 1_000 },
      { protocol_mutation_timeout_ms: 120_000, http_request_deadline_ms: 1_000 },
      { protocol_start_timeout_ms: 120_000, http_request_deadline_ms: 1_000 },
      { protocol_max_in_flight_requests: 256, http_max_in_flight_requests: 1 },
      { protocol_close_timeout_ms: 10_000, lifecycle_shutdown_timeout_ms: 1_000 },
      { lifecycle_cleanup_step_timeout_ms: 10_000, lifecycle_shutdown_timeout_ms: 1_000 },
      { cli_connect_timeout_ms: 30_000, cli_request_timeout_ms: 1_000 },
      { cli_request_timeout_ms: 1_000, http_request_deadline_ms: 120_000 },
      { cli_request_body_max_bytes: 1_048_576, http_body_max_bytes: 1_024 },
      { cli_stream_idle_timeout_ms: 5_000, sse_heartbeat_interval_ms: 5_000 },
      {
        protocol_connect_timeout_ms: 30_000,
        protocol_handshake_timeout_ms: 120_000,
        lifecycle_startup_timeout_ms: 1_000
      }
    ];

    for (const policy of contradictoryPolicies) {
      expect(resourceBudgetSchema.safeParse(policy).success, JSON.stringify(policy)).toBe(false);
    }
  });

  it("accepts a coherent bounded override without filling from a larger hidden fallback", () => {
    const parsed = resolveResourceBudget({
      http_body_max_bytes: 32_768,
      http_max_connections: 32,
      sse_max_subscribers: 16,
      protocol_max_frame_bytes: 524_288,
      protocol_max_buffered_bytes: 1_048_576,
      cli_request_body_max_bytes: 32_768,
      cli_response_max_bytes: 524_288
    });

    expect(parsed.http_body_max_bytes).toBe(32_768);
    expect(parsed.http_max_connections).toBe(32);
    expect(parsed.sse_max_subscribers).toBe(16);
    expect(parsed.protocol_max_frame_bytes).toBe(524_288);
    expect(parsed.protocol_max_buffered_bytes).toBe(1_048_576);
    expect(parsed.cli_request_body_max_bytes).toBe(32_768);
    expect(parsed.cli_response_max_bytes).toBe(524_288);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => assertResolvedResourceBudget(parsed)).not.toThrow();
  });

  it("distinguishes a resolved policy from partial or mutable configuration input", () => {
    expect(() => assertResolvedResourceBudget(Object.freeze({}))).toThrow(
      "Resolved resource budget must contain every selected resource key exactly once."
    );
    expect(() => assertResolvedResourceBudget({ ...defaultResourceBudget })).toThrow(
      "Resolved resource budget must be frozen."
    );
    expect(() =>
      assertResolvedResourceBudget(
        Object.freeze({
          ...defaultResourceBudget,
          http_body_max_bytes: 0
        })
      )
    ).toThrow("Resolved resource budget is invalid.");
  });
});
