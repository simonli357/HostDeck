import { defaultResourceBudget } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  type CodexResourceOptions,
  codexResourceBudgetKeys,
  codexResourceOptionsFromBudget
} from "./resource-options.js";

describe("Codex resource options", () => {
  it("maps every protocol budget value without a local fallback", () => {
    const options = codexResourceOptionsFromBudget(defaultResourceBudget);
    const mapped = mappedProtocolValues(options);

    expect(Object.keys(mapped).sort()).toEqual([...codexResourceBudgetKeys].sort());
    for (const key of codexResourceBudgetKeys) expect(mapped[key]).toBe(defaultResourceBudget[key]);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.transport)).toBe(true);
    expect(Object.isFrozen(options.connection)).toBe(true);
    expect(Object.isFrozen(options.thread)).toBe(true);
  });

  it("preserves a coherent lower policy exactly", () => {
    const options = codexResourceOptionsFromBudget({
      http_request_deadline_ms: 20_000,
      protocol_read_timeout_ms: 4_000,
      protocol_mutation_timeout_ms: 8_000,
      protocol_start_timeout_ms: 20_000,
      protocol_max_frame_bytes: 524_288,
      protocol_max_buffered_bytes: 1_048_576,
      protocol_max_in_flight_requests: 8,
      protocol_max_pending_server_requests: 4,
      protocol_thread_page_size: 50,
      protocol_thread_max_pages: 20,
      protocol_thread_max_loaded_reads: 100
    });

    expect(options).toMatchObject({
      transport: {
        max_frame_bytes: 524_288,
        max_buffered_bytes: 1_048_576
      },
      connection: {
        max_in_flight: 8,
        max_server_requests: 4
      },
      thread: {
        page_size: 50,
        max_pages: 20,
        max_loaded_reads: 100,
        read_timeout_ms: 4_000,
        mutation_timeout_ms: 8_000,
        start_timeout_ms: 20_000
      }
    });
  });

  it("rejects an invalid policy before producing partial adapter options", () => {
    expect(() => codexResourceOptionsFromBudget({ protocol_max_in_flight_requests: 0 })).toThrow();
    expect(() =>
      codexResourceOptionsFromBudget({
        protocol_start_timeout_ms: 120_000,
        http_request_deadline_ms: 1_000
      })
    ).toThrow();
  });
});

function mappedProtocolValues(options: CodexResourceOptions) {
  return {
    protocol_connect_timeout_ms: options.transport.handshake_timeout_ms,
    protocol_handshake_timeout_ms: options.connection.handshake_timeout_ms,
    protocol_read_timeout_ms: options.thread.read_timeout_ms,
    protocol_mutation_timeout_ms: options.thread.mutation_timeout_ms,
    protocol_start_timeout_ms: options.thread.start_timeout_ms,
    protocol_close_timeout_ms: options.transport.close_timeout_ms,
    protocol_heartbeat_interval_ms: options.transport.heartbeat_interval_ms,
    protocol_heartbeat_timeout_ms: options.transport.heartbeat_timeout_ms,
    protocol_max_frame_bytes: options.transport.max_frame_bytes,
    protocol_max_buffered_bytes: options.transport.max_buffered_bytes,
    protocol_max_in_flight_requests: options.connection.max_in_flight,
    protocol_max_pending_server_requests: options.connection.max_server_requests,
    protocol_thread_page_size: options.thread.page_size,
    protocol_thread_max_pages: options.thread.max_pages,
    protocol_thread_max_loaded_reads: options.thread.max_loaded_reads
  } as const;
}
