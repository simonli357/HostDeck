import {
  type OperationDeadline,
  OperationDeadlineExceededError,
  operationDeadlineLimits
} from "@hostdeck/core";
import { HostDeckCodexAdapterError } from "./errors.js";

export interface CodexRequestDeadlineOptions {
  readonly signal?: AbortSignal;
  readonly timeout_ms: number;
}

export function codexRequestOptionsFromDeadline(
  candidate: unknown,
  maximumTimeoutMs: number
): CodexRequestDeadlineOptions {
  const cap = parseTimeoutCap(maximumTimeoutMs);
  if (candidate === undefined) return Object.freeze({ timeout_ms: cap });
  const deadline = parseDeadline(candidate);

  try {
    deadline.throwIfAborted();
    const timeoutMs = deadline.timeoutMs(cap);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < operationDeadlineLimits.minimumTimeoutMs ||
      timeoutMs > cap
    ) {
      throw new TypeError("Operation deadline returned an invalid child timeout.");
    }
    return Object.freeze({ signal: deadline.signal, timeout_ms: timeoutMs });
  } catch (cause) {
    if (cause instanceof OperationDeadlineExceededError) {
      throw new HostDeckCodexAdapterError(
        "request_timeout",
        "Codex request deadline elapsed before protocol dispatch.",
        { cause, outcome: "not_sent", retry_safe: true }
      );
    }
    if (deadline.signal.aborted) {
      throw new HostDeckCodexAdapterError(
        "request_aborted",
        "Codex request was aborted before protocol dispatch.",
        { cause, outcome: "not_sent", retry_safe: true }
      );
    }
    throw cause;
  }
}

function parseDeadline(candidate: unknown): OperationDeadline {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Codex request deadline must be an OperationDeadline.");
  }
  const deadline = candidate as Partial<OperationDeadline>;
  if (
    !Number.isFinite(deadline.startedAtMs) ||
    !Number.isFinite(deadline.expiresAtMs) ||
    (deadline.expiresAtMs as number) < (deadline.startedAtMs as number) ||
    !(deadline.signal instanceof AbortSignal) ||
    typeof deadline.remainingMs !== "function" ||
    typeof deadline.timeoutMs !== "function" ||
    typeof deadline.throwIfAborted !== "function" ||
    typeof deadline.dispose !== "function"
  ) {
    throw new TypeError("Codex request deadline must be an OperationDeadline.");
  }
  return deadline as OperationDeadline;
}

function parseTimeoutCap(candidate: unknown): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < operationDeadlineLimits.minimumTimeoutMs ||
    candidate > operationDeadlineLimits.maximumTimeoutMs
  ) {
    throw new TypeError(
      `Codex request timeout cap must be between ${operationDeadlineLimits.minimumTimeoutMs} and ${operationDeadlineLimits.maximumTimeoutMs} milliseconds.`
    );
  }
  return candidate;
}
