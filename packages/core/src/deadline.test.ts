import { describe, expect, it } from "vitest";
import {
  createOperationDeadline,
  createOperationDeadlineView,
  type MonotonicDeadlineClock,
  OperationAbortedError,
  OperationDeadlineDisposedError,
  OperationDeadlineExceededError,
  operationDeadlineLimits
} from "./deadline.js";

describe("monotonic operation deadline", () => {
  it("expires exactly once and never returns a larger downstream timeout", () => {
    const clock = new FakeDeadlineClock(100);
    const deadline = createOperationDeadline({ timeoutMs: 1_000, clock });
    const sharedSignal = deadline.signal;

    expect(deadline.startedAtMs).toBe(100);
    expect(deadline.expiresAtMs).toBe(1_100);
    expect(Object.isFrozen(deadline)).toBe(true);
    expect(deadline.remainingMs()).toBe(1_000);
    expect(deadline.timeoutMs()).toBe(1_000);
    expect(deadline.timeoutMs(200)).toBe(200);
    expect(clock.pendingCount).toBe(1);

    clock.advanceBy(400);
    expect(deadline.signal).toBe(sharedSignal);
    expect(deadline.remainingMs()).toBe(600);
    expect(deadline.timeoutMs(800)).toBe(600);

    clock.advanceBy(599);
    expect(deadline.remainingMs()).toBe(1);
    expect(deadline.signal.aborted).toBe(false);

    clock.advanceBy(1);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(OperationDeadlineExceededError);
    expect(deadline.signal.reason).toMatchObject({ code: "operation_timeout" });
    expect(() => deadline.throwIfAborted()).toThrow(OperationDeadlineExceededError);
    expect(clock.pendingCount).toBe(0);
  });

  it("propagates parent abort once with the original reason and clears its timer", () => {
    const clock = new FakeDeadlineClock();
    const parent = new AbortController();
    const deadline = createOperationDeadline({ timeoutMs: 5_000, parentSignal: parent.signal, clock });
    const reason = new Error("client disconnected");

    parent.abort(reason);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    expect(() => deadline.throwIfAborted()).toThrow(reason);
    expect(clock.pendingCount).toBe(0);

    clock.advanceBy(5_000);
    expect(deadline.signal.reason).toBe(reason);
  });

  it("starts aborted without scheduling when the parent is already aborted", () => {
    const clock = new FakeDeadlineClock();
    const parent = new AbortController();
    parent.abort("request gone");

    const deadline = createOperationDeadline({ timeoutMs: 1_000, parentSignal: parent.signal, clock });
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("request gone");
    expect(deadline.remainingMs()).toBe(0);
    expect(clock.pendingCount).toBe(0);
    expect(() => deadline.throwIfAborted()).toThrow(OperationAbortedError);

    try {
      deadline.throwIfAborted();
    } catch (error) {
      expect(error).toMatchObject({ name: "AbortError", cause: "request gone" });
    }
  });

  it("disposes timer and parent-listener ownership without inventing an abort", () => {
    const clock = new FakeDeadlineClock();
    const parent = new AbortController();
    const deadline = createOperationDeadline({ timeoutMs: 1_000, parentSignal: parent.signal, clock });

    deadline.dispose();
    deadline.dispose();
    expect(clock.pendingCount).toBe(0);
    expect(deadline.signal.aborted).toBe(false);
    expect(() => deadline.remainingMs()).toThrow(OperationDeadlineDisposedError);
    expect(() => deadline.timeoutMs()).toThrow(OperationDeadlineDisposedError);
    expect(() => deadline.throwIfAborted()).toThrow(OperationDeadlineDisposedError);

    parent.abort(new Error("late parent abort"));
    clock.advanceBy(1_000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it("fails loudly for invalid durations, clocks, and monotonic rollback", () => {
    const invalidTimeouts: unknown[] = [
      undefined,
      null,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      operationDeadlineLimits.maximumTimeoutMs + 1
    ];

    for (const timeoutMs of invalidTimeouts) {
      expect(() => createOperationDeadline({ timeoutMs } as { timeoutMs: number })).toThrow(TypeError);
    }

    expect(() => createOperationDeadline(null as unknown as { timeoutMs: number })).toThrow(
      "Operation deadline input must be an object."
    );
    expect(() =>
      createOperationDeadline({
        timeoutMs: 100,
        clock: { now: () => Number.NaN } as MonotonicDeadlineClock
      })
    ).toThrow("Operation deadline clock is invalid.");
    expect(() =>
      createOperationDeadline({
        timeoutMs: 100,
        parentSignal: {} as AbortSignal
      })
    ).toThrow("Operation deadline parent signal is invalid.");
    expect(() =>
      createOperationDeadline({
        timeoutMs: 100,
        clock: {
          now: () => 0,
          setTimeout: () => undefined,
          clearTimeout: () => undefined
        }
      })
    ).toThrow("Operation deadline clock could not schedule expiry.");

    const clock = new FakeDeadlineClock(100);
    const deadline = createOperationDeadline({ timeoutMs: 1_000, clock });
    clock.setNow(99);
    expect(() => deadline.remainingMs()).toThrow("Monotonic deadline clock moved backwards.");
    deadline.dispose();
  });

  it("rejects an invalid local cap instead of substituting the global maximum", () => {
    const clock = new FakeDeadlineClock();
    const deadline = createOperationDeadline({ timeoutMs: 1_000, clock });

    for (const cap of [0, -1, 1.5, operationDeadlineLimits.maximumTimeoutMs + 1]) {
      expect(() => deadline.timeoutMs(cap)).toThrow(TypeError);
    }
    expect(deadline.timeoutMs(500)).toBe(500);
    deadline.dispose();
  });

  it("observes an external cancellation owner without creating a second signal or timer", () => {
    const clock = new FakeDeadlineClock(50);
    const owner = new AbortController();
    const deadline = createOperationDeadlineView({ timeoutMs: 1_000, signal: owner.signal, clock });

    expect(deadline.signal).toBe(owner.signal);
    expect(Object.isFrozen(deadline)).toBe(true);
    expect(deadline.startedAtMs).toBe(50);
    expect(deadline.expiresAtMs).toBe(1_050);
    expect(clock.pendingCount).toBe(0);

    clock.advanceBy(400);
    expect(deadline.remainingMs()).toBe(600);
    expect(deadline.timeoutMs(800)).toBe(600);

    clock.advanceBy(600);
    expect(deadline.remainingMs()).toBe(0);
    expect(owner.signal.aborted).toBe(false);
    expect(() => deadline.throwIfAborted()).toThrow(OperationDeadlineExceededError);

    const reason = new Error("Fastify handler timeout");
    owner.abort(reason);
    expect(() => deadline.throwIfAborted()).toThrow(reason);

    deadline.dispose();
    expect(() => deadline.remainingMs()).toThrow(OperationDeadlineDisposedError);
  });
});

interface FakeTimer {
  readonly id: number;
  readonly dueAtMs: number;
  readonly callback: () => void;
}

class FakeDeadlineClock implements MonotonicDeadlineClock {
  private currentMs: number;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(startMs = 0) {
    this.currentMs = startMs;
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  now = (): number => this.currentMs;

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { id, dueAtMs: this.currentMs + delayMs, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  setNow(nowMs: number): void {
    this.currentMs = nowMs;
  }

  advanceBy(milliseconds: number): void {
    this.currentMs += milliseconds;
    const due = [...this.timers.values()]
      .filter((timer) => timer.dueAtMs <= this.currentMs)
      .sort((left, right) => left.dueAtMs - right.dueAtMs || left.id - right.id);
    for (const timer of due) {
      if (!this.timers.delete(timer.id)) continue;
      timer.callback();
    }
  }
}
