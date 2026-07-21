import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { createOperationDeadlineView } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import {
  type CodexCompactRequestPort,
  createCodexCompactClient
} from "./compact-client.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";

const acceptedAt = "2026-07-11T18:30:00.000Z";
const input = {
  operation_id: "op_compact_adapter_0001",
  thread_id: "thread-compact-adapter"
} as const;

describe("Codex compact client", () => {
  it("sends one exact mutation and returns a frozen accepted-only result", async () => {
    const controller = new AbortController();
    const deadline = createOperationDeadlineView({
      timeoutMs: 4_000,
      signal: controller.signal,
      clock: { now: () => 0 }
    });
    const port = fakePort((request) => {
      expect(request).toEqual({
        method: "thread/compact/start",
        params: { threadId: input.thread_id },
        kind: "mutation",
        timeout_ms: 4_000,
        signal: controller.signal
      });
      return {};
    });
    const client = createCodexCompactClient(port, {
      mutation_timeout_ms: 4_000,
      now: () => acceptedAt
    });

    const result = await client.compactThread({ ...input, deadline });
    expect(result).toEqual({
      runtime_version: "0.144.0",
      connection_generation: 3,
      thread_id: input.thread_id,
      state: "accepted",
      accepted_at: acceptedAt
    });
    expect(result).not.toHaveProperty("turn_id");
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(port.requests).toHaveLength(1);
  });

  it("treats every malformed post-send response or clock as an unknown outcome", async () => {
    for (const candidate of [null, [], { accepted: true }, new Date()]) {
      const port = fakePort(() => candidate);
      const error = await expectAdapterError(createCodexCompactClient(port).compactThread(input), "invalid_protocol_message");
      expect(error).toMatchObject({ outcome: "unknown", retry_safe: false });
      expect(port.requests).toHaveLength(1);
    }

    const clockPort = fakePort(() => ({}));
    const clockError = await expectAdapterError(
      createCodexCompactClient(clockPort, { now: () => "invalid" }).compactThread(input),
      "invalid_protocol_message"
    );
    expect(clockError).toMatchObject({ outcome: "unknown", retry_safe: false });
    expect(clockPort.requests).toHaveLength(1);
  });

  it("fails a generation race as unknown and never retries", async () => {
    const port = fakePort(() => {
      port.currentGeneration += 1;
      return {};
    });
    const error = await expectAdapterError(createCodexCompactClient(port).compactThread(input), "transport_closed");
    expect(error).toMatchObject({ outcome: "unknown", retry_safe: false });
    expect(port.requests).toHaveLength(1);
  });

  it("keeps unavailable capability, disconnected runtime, and invalid generation distinct before send", async () => {
    const unavailable = fakePort(() => ({}), compatibilityWithCompactState("unavailable"));
    const unsupported = await expectAdapterError(createCodexCompactClient(unavailable).compactThread(input), "unsupported_method");
    expect(unsupported.outcome).toBe("not_sent");
    expect(unavailable.requests).toHaveLength(0);

    const disconnected = fakePort(() => ({}), disconnectedCompatibility());
    await expectAdapterError(createCodexCompactClient(disconnected).compactThread(input), "handshake_failed");
    expect(disconnected.requests).toHaveLength(0);

    const invalidGeneration = fakePort(() => ({}));
    invalidGeneration.currentGeneration = 0;
    await expectAdapterError(createCodexCompactClient(invalidGeneration).compactThread(input), "protocol_violation");
    expect(invalidGeneration.requests).toHaveLength(0);
  });

  it("rejects invalid input and options before dispatch", async () => {
    const port = fakePort(() => ({}));
    await expectAdapterError(
      createCodexCompactClient(port).compactThread({ ...input, extra: true } as never),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexCompactClient(port).compactThread({ ...input, operation_id: "bad" }),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexCompactClient(port).compactThread({ ...input, signal: "bad" } as never),
      "invalid_protocol_message"
    );
    expect(port.requests).toHaveLength(0);

    expect(() => createCodexCompactClient(fakePort(() => ({})), { mutation_timeout_ms: 0 })).toThrow(
      HostDeckCodexAdapterError
    );
    expect(() => createCodexCompactClient(fakePort(() => ({})), { unknown: true } as never)).toThrow(
      HostDeckCodexAdapterError
    );
    expect(() => createCodexCompactClient(null as never)).toThrow(TypeError);
  });

  it("propagates known rejection and possible-send timeout once without fallback", async () => {
    const rejectedPort = fakePort(() => {
      throw new HostDeckCodexAdapterError("remote_error", "compact rejected", {
        outcome: "remote_rejected",
        retry_safe: true,
        rpc_code: -32_600
      });
    });
    const rejected = await expectAdapterError(createCodexCompactClient(rejectedPort).compactThread(input), "remote_error");
    expect(rejected).toMatchObject({ outcome: "remote_rejected", retry_safe: true, rpc_code: -32_600 });
    expect(rejectedPort.requests).toHaveLength(1);

    const timeoutPort = fakePort(() => {
      throw new HostDeckCodexAdapterError("request_timeout", "compact timed out", {
        outcome: "unknown",
        retry_safe: false
      });
    });
    const timeout = await expectAdapterError(createCodexCompactClient(timeoutPort).compactThread(input), "request_timeout");
    expect(timeout).toMatchObject({ outcome: "unknown", retry_safe: false });
    expect(timeoutPort.requests).toHaveLength(1);
  });
});

interface FakePort extends CodexCompactRequestPort {
  readonly requests: CodexRequestInput[];
  currentGeneration: number;
}

function fakePort(
  handler: (request: CodexRequestInput) => unknown | Promise<unknown>,
  compatibility = readyCompatibility()
): FakePort {
  const requests: CodexRequestInput[] = [];
  const port: FakePort = {
    compatibility,
    currentGeneration: 3,
    get generation() {
      return port.currentGeneration;
    },
    requests,
    async request(request) {
      requests.push(request);
      return handler(request);
    }
  };
  return port;
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: acceptedAt,
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function compatibilityWithCompactState(state: "unavailable" | "unknown"): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === "compact" ? { ...capability, state, reason: "test compact capability" } : capability
    )
  };
}

function disconnectedCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: acceptedAt,
    handshake: { state: "not_attempted" }
  });
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: HostDeckCodexAdapterError["code"]
): Promise<HostDeckCodexAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexAdapterError;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
