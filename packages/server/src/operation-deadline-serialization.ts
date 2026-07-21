import type { OperationDeadline } from "@hostdeck/core";

export type OperationDeadlineFailureFactory = (cause: unknown) => Error;

export function requireOpenOperationDeadline(
  candidate: unknown,
  failure: OperationDeadlineFailureFactory,
  invalid: OperationDeadlineFailureFactory = failure
): OperationDeadline {
  try {
    assertOperationDeadlineContract(candidate);
  } catch (cause) {
    throw invalid(cause);
  }
  try {
    candidate.throwIfAborted();
    if (candidate.remainingMs() <= 0) {
      candidate.throwIfAborted();
      throw new TypeError("Operation deadline reported no remaining time without aborting.");
    }
  } catch (cause) {
    throw failure(cause);
  }
  return candidate;
}

export function runSerializedWithDeadline<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  deadline: OperationDeadline,
  failure: OperationDeadlineFailureFactory,
  operation: () => Promise<T>,
  invalid: OperationDeadlineFailureFactory = failure
): Promise<T> {
  requireOpenOperationDeadline(deadline, failure, invalid);
  if (!(tails instanceof Map) || typeof key !== "string" || key.length === 0 || typeof operation !== "function") {
    throw new TypeError("Deadline-aware serialization input is invalid.");
  }

  const prior = tails.get(key) ?? Promise.resolve();
  const settledPrior = prior.then(
    () => undefined,
    () => undefined
  );
  let started = false;
  let queuedFailure: Error | null = null;
  let rejectQueuedAbort: ((error: Error) => void) | null = null;

  const onAbort = (): void => {
    if (started || queuedFailure !== null) return;
    queuedFailure = deadlineFailure(deadline, failure);
    deadline.signal.removeEventListener("abort", onAbort);
    rejectQueuedAbort?.(queuedFailure);
  };
  const queuedAbort = new Promise<never>((_resolve, reject) => {
    rejectQueuedAbort = reject;
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    if (deadline.signal.aborted) onAbort();
  });

  const execution = settledPrior.then(async () => {
    deadline.signal.removeEventListener("abort", onAbort);
    if (queuedFailure !== null) throw queuedFailure;
    requireOpenOperationDeadline(deadline, failure, invalid);
    started = true;
    return operation();
  });
  const tail = execution.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);
  void tail.then(() => {
    deadline.signal.removeEventListener("abort", onAbort);
    if (tails.get(key) === tail) tails.delete(key);
  });

  return Promise.race([execution, queuedAbort]);
}

function deadlineFailure(
  deadline: OperationDeadline,
  failure: OperationDeadlineFailureFactory
): Error {
  try {
    deadline.throwIfAborted();
  } catch (cause) {
    return failure(cause);
  }
  return failure(new TypeError("Operation deadline aborted without a usable reason."));
}

function assertOperationDeadlineContract(
  candidate: unknown
): asserts candidate is OperationDeadline {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Operation deadline contract is invalid.");
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
    throw new TypeError("Operation deadline contract is invalid.");
  }
}
