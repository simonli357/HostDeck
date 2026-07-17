export const operationDeadlineLimits = {
  minimumTimeoutMs: 1,
  maximumTimeoutMs: 300_000
} as const;

export interface MonotonicClock {
  readonly now: () => number;
}

export interface MonotonicDeadlineClock extends MonotonicClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface CreateOperationDeadlineInput {
  readonly timeoutMs: number;
  readonly parentSignal?: AbortSignal;
  readonly clock?: MonotonicDeadlineClock;
}

export interface CreateOperationDeadlineViewInput {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly clock?: MonotonicClock;
}

export interface OperationDeadline {
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
  readonly timeoutMs: (maximumMs?: number) => number;
  readonly throwIfAborted: () => void;
  readonly dispose: () => void;
}

export class OperationDeadlineExceededError extends Error {
  readonly code = "operation_timeout" as const;

  constructor() {
    super("Operation deadline exceeded.");
    this.name = "OperationDeadlineExceededError";
  }
}

export class OperationDeadlineDisposedError extends Error {
  constructor() {
    super("Operation deadline owner is disposed.");
    this.name = "OperationDeadlineDisposedError";
  }
}

export class OperationAbortedError extends Error {
  constructor(cause: unknown) {
    super("Operation was aborted.", { cause });
    this.name = "AbortError";
  }
}

const defaultDeadlineClock: MonotonicDeadlineClock = {
  now: () => globalThis.performance.now(),
  setTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    if (
      typeof handle === "object" &&
      handle !== null &&
      "unref" in handle &&
      typeof (handle as { unref?: unknown }).unref === "function"
    ) {
      (handle as { unref: () => void }).unref();
    }
    return handle;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  }
};
const noDeadlineTimer = Symbol("noDeadlineTimer");

export function createOperationDeadline(input: CreateOperationDeadlineInput): OperationDeadline {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Operation deadline input must be an object.");
  }
  const timeoutMs = parseTimeout(input.timeoutMs, "Operation deadline timeout");
  validateParentSignal(input.parentSignal);
  const clock = input.clock ?? defaultDeadlineClock;
  validateDeadlineClock(clock);
  const startedAtMs = readInitialNow(clock);
  const expiresAtMs = startedAtMs + timeoutMs;
  if (!Number.isFinite(expiresAtMs)) throw new TypeError("Operation deadline expiry must be finite.");

  const owner = new DefaultOperationDeadline({
    clock,
    expiresAtMs,
    parentSignal: input.parentSignal,
    startedAtMs,
    timeoutMs
  });
  return Object.freeze({
    startedAtMs: owner.startedAtMs,
    expiresAtMs: owner.expiresAtMs,
    signal: owner.signal,
    remainingMs: owner.remainingMs,
    timeoutMs: owner.timeoutMs,
    throwIfAborted: owner.throwIfAborted,
    dispose: owner.dispose
  });
}

export function createOperationDeadlineView(input: CreateOperationDeadlineViewInput): OperationDeadline {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Operation deadline view input must be an object.");
  }
  const timeoutMs = parseTimeout(input.timeoutMs, "Operation deadline timeout");
  validateParentSignal(input.signal);
  const clock = input.clock ?? defaultDeadlineClock;
  const startedAtMs = readInitialNow(clock);
  const expiresAtMs = startedAtMs + timeoutMs;
  if (!Number.isFinite(expiresAtMs)) throw new TypeError("Operation deadline expiry must be finite.");

  let disposed = false;
  let lastNowMs = startedAtMs;
  const assertUsable = () => {
    if (disposed) throw new OperationDeadlineDisposedError();
  };
  const remainingMs = (): number => {
    assertUsable();
    if (input.signal.aborted) return 0;
    const now = readMonotonicNow(clock, lastNowMs);
    lastNowMs = now;
    return Math.min(timeoutMs, Math.max(0, expiresAtMs - now));
  };
  const throwIfAborted = (): void => {
    assertUsable();
    if (input.signal.aborted) throwAbortReason(input.signal.reason);
    if (remainingMs() <= 0) throw new OperationDeadlineExceededError();
  };

  return Object.freeze({
    startedAtMs,
    expiresAtMs,
    signal: input.signal,
    remainingMs,
    timeoutMs(maximumMs?: number) {
      assertUsable();
      const cap = maximumMs === undefined ? operationDeadlineLimits.maximumTimeoutMs : parseTimeout(maximumMs, "Operation timeout cap");
      throwIfAborted();
      return Math.min(Math.ceil(remainingMs()), cap);
    },
    throwIfAborted,
    dispose() {
      disposed = true;
    }
  });
}

interface DefaultOperationDeadlineInput {
  readonly clock: MonotonicDeadlineClock;
  readonly expiresAtMs: number;
  readonly parentSignal: AbortSignal | undefined;
  readonly startedAtMs: number;
  readonly timeoutMs: number;
}

class DefaultOperationDeadline implements OperationDeadline {
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly clock: MonotonicDeadlineClock;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly timeoutMsLimit: number;
  private timer: unknown = noDeadlineTimer;
  private lastNowMs: number;
  private disposed = false;

  constructor(input: DefaultOperationDeadlineInput) {
    this.clock = input.clock;
    this.parentSignal = input.parentSignal;
    this.timeoutMsLimit = input.timeoutMs;
    this.startedAtMs = input.startedAtMs;
    this.expiresAtMs = input.expiresAtMs;
    this.lastNowMs = input.startedAtMs;
    this.signal = this.controller.signal;

    if (isSignalAborted(this.parentSignal)) {
      this.controller.abort(this.parentSignal?.reason);
      return;
    }

    this.parentSignal?.addEventListener("abort", this.abortFromParent, { once: true });
    if (isSignalAborted(this.parentSignal)) {
      this.abortFromParent();
      return;
    }

    try {
      const timer = this.clock.setTimeout(this.expire, input.timeoutMs);
      if (timer === undefined) throw new TypeError("Operation deadline clock returned no timer handle.");
      if (this.signal.aborted) {
        this.clock.clearTimeout(timer);
        return;
      }
      this.timer = timer;
    } catch (cause) {
      this.parentSignal?.removeEventListener("abort", this.abortFromParent);
      throw new TypeError("Operation deadline clock could not schedule expiry.", { cause });
    }
  }

  remainingMs = (): number => {
    this.assertUsable();
    if (this.signal.aborted) return 0;

    const now = this.readNow();
    if (now >= this.expiresAtMs) {
      this.expire();
      return 0;
    }
    return Math.min(this.timeoutMsLimit, this.expiresAtMs - now);
  };

  timeoutMs = (maximumMs?: number): number => {
    this.assertUsable();
    const cap = maximumMs === undefined ? operationDeadlineLimits.maximumTimeoutMs : parseTimeout(maximumMs, "Operation timeout cap");
    this.throwIfAborted();
    const remaining = Math.ceil(this.remainingMs());
    if (remaining < 1) {
      this.expire();
      this.throwIfAborted();
    }
    return Math.min(remaining, cap);
  };

  throwIfAborted = (): void => {
    this.assertUsable();
    if (!this.signal.aborted) this.remainingMs();
    if (!this.signal.aborted) return;

    const reason: unknown = this.signal.reason;
    throw reason instanceof Error ? reason : new OperationAbortedError(reason);
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.parentSignal?.removeEventListener("abort", this.abortFromParent);
  };

  private readonly abortFromParent = (): void => {
    if (this.disposed || this.signal.aborted) return;
    this.clearTimer();
    this.parentSignal?.removeEventListener("abort", this.abortFromParent);
    this.controller.abort(this.parentSignal?.reason);
  };

  private readonly expire = (): void => {
    if (this.disposed || this.signal.aborted) return;
    this.clearTimer();
    this.parentSignal?.removeEventListener("abort", this.abortFromParent);
    this.controller.abort(new OperationDeadlineExceededError());
  };

  private clearTimer(): void {
    if (this.timer === noDeadlineTimer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = noDeadlineTimer;
  }

  private readNow(): number {
    const now = readMonotonicNow(this.clock, this.lastNowMs);
    this.lastNowMs = now;
    return now;
  }

  private assertUsable(): void {
    if (this.disposed) throw new OperationDeadlineDisposedError();
  }
}

function parseTimeout(candidate: unknown, label: string): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < operationDeadlineLimits.minimumTimeoutMs ||
    candidate > operationDeadlineLimits.maximumTimeoutMs
  ) {
    throw new TypeError(
      `${label} must be a safe integer between ${operationDeadlineLimits.minimumTimeoutMs} and ${operationDeadlineLimits.maximumTimeoutMs} milliseconds.`
    );
  }
  return candidate;
}

function readInitialNow(clock: MonotonicClock): number {
  if (
    clock === null ||
    typeof clock !== "object" ||
    typeof clock.now !== "function"
  ) {
    throw new TypeError("Operation deadline clock is invalid.");
  }
  const now = clock.now();
  if (!Number.isFinite(now) || now < 0) throw new TypeError("Monotonic deadline clock must return a non-negative finite number.");
  return now;
}

function validateDeadlineClock(clock: MonotonicDeadlineClock): void {
  if (
    clock === null ||
    typeof clock !== "object" ||
    typeof clock.now !== "function" ||
    typeof clock.setTimeout !== "function" ||
    typeof clock.clearTimeout !== "function"
  ) {
    throw new TypeError("Operation deadline clock is invalid.");
  }
}

function readMonotonicNow(clock: MonotonicClock, previous: number): number {
  const now = clock.now();
  if (!Number.isFinite(now) || now < 0) throw new TypeError("Monotonic deadline clock must return a non-negative finite number.");
  if (now < previous) throw new RangeError("Monotonic deadline clock moved backwards.");
  return now;
}

function validateParentSignal(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("Operation deadline parent signal is invalid.");
  }
}

function throwAbortReason(reason: unknown): never {
  throw reason instanceof Error ? reason : new OperationAbortedError(reason);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
