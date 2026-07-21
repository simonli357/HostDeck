import {
  createOperationDeadlineView,
  OperationDeadlineDisposedError
} from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import { HostDeckCodexAdapterError } from "./errors.js";
import { codexRequestOptionsFromDeadline } from "./request-deadline.js";

describe("Codex request deadline derivation", () => {
  it("uses the configured cap when no parent deadline exists", () => {
    expect(codexRequestOptionsFromDeadline(undefined, 4_000)).toEqual({ timeout_ms: 4_000 });
  });

  it("derives only decreasing timeouts down to the final millisecond", () => {
    let now = 100;
    const controller = new AbortController();
    const deadline = createOperationDeadlineView({
      timeoutMs: 1_000,
      signal: controller.signal,
      clock: { now: () => now }
    });

    expect(codexRequestOptionsFromDeadline(deadline, 700)).toEqual({
      signal: controller.signal,
      timeout_ms: 700
    });
    now = 600;
    expect(codexRequestOptionsFromDeadline(deadline, 700)).toEqual({
      signal: controller.signal,
      timeout_ms: 500
    });
    now = 1_099;
    expect(codexRequestOptionsFromDeadline(deadline, 700)).toEqual({
      signal: controller.signal,
      timeout_ms: 1
    });
  });

  it("maps elapsed and externally aborted work to proven no-send errors", () => {
    let now = 0;
    const elapsed = createOperationDeadlineView({
      timeoutMs: 10,
      signal: new AbortController().signal,
      clock: { now: () => now }
    });
    now = 10;
    expectAdapterError(() => codexRequestOptionsFromDeadline(elapsed, 10), "request_timeout");

    const controller = new AbortController();
    const aborted = createOperationDeadlineView({
      timeoutMs: 10,
      signal: controller.signal,
      clock: { now: () => 0 }
    });
    controller.abort(new Error("private abort reason"));
    expectAdapterError(() => codexRequestOptionsFromDeadline(aborted, 10), "request_aborted");
  });

  it("fails loudly for invalid or disposed deadline contracts", () => {
    expect(() => codexRequestOptionsFromDeadline({}, 100)).toThrow(TypeError);
    expect(() => codexRequestOptionsFromDeadline(undefined, 0)).toThrow(TypeError);

    const deadline = createOperationDeadlineView({
      timeoutMs: 100,
      signal: new AbortController().signal,
      clock: { now: () => 0 }
    });
    deadline.dispose();
    expect(() => codexRequestOptionsFromDeadline(deadline, 100)).toThrow(
      OperationDeadlineDisposedError
    );
  });
});

function expectAdapterError(
  callback: () => unknown,
  code: HostDeckCodexAdapterError["code"]
): void {
  try {
    callback();
    throw new Error("Expected Codex request deadline derivation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code, outcome: "not_sent", retry_safe: true });
  }
}
