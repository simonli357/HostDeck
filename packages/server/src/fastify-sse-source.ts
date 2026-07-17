import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import type { SSEMessage } from "@fastify/sse";
import {
  type SelectedProjectionEvent,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import type { OutputCursor } from "@hostdeck/core";
import type { FastifyRequest } from "fastify";

export const hostDeckSseFailureCodes = [
  "source_open_failed",
  "source_iteration_failed",
  "invalid_event",
  "invalid_cursor_order",
  "event_too_large",
  "source_cleanup_failed",
  "source_cleanup_timeout",
  "transport_send_failed"
] as const;
export type HostDeckSseFailureCode = (typeof hostDeckSseFailureCodes)[number];

export interface HostDeckSseFailureObservation {
  readonly code: HostDeckSseFailureCode;
  readonly error: Error;
  readonly request_id: string;
}

export type HostDeckSseFailureObserver = (observation: HostDeckSseFailureObservation) => void;

export class HostDeckSseTransportError extends Error {
  readonly code: HostDeckSseFailureCode;

  constructor(code: HostDeckSseFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HostDeckSseTransportError";
    this.code = code;
  }
}

export class HostDeckSseAbortError extends Error {
  constructor(cause: unknown) {
    super("SSE request was aborted.", { cause });
    this.name = "AbortError";
  }
}

export interface CreateHostDeckSseReadableInput {
  readonly after: OutputCursor | null;
  readonly cleanupTimeoutMs: number;
  readonly eventMaxBytes: number;
  readonly expectedSessionId: string | null;
  readonly iterable: AsyncIterable<unknown>;
  readonly onCleanupFailure: (error: HostDeckSseTransportError) => void;
  readonly signal: AbortSignal;
}

export interface RegisterHostDeckSseSourceLifecycleInput<
  T extends AsyncIterable<unknown> = AsyncIterable<unknown>
> {
  readonly iterable: T;
  readonly signal: AbortSignal;
}

const sourceLifecycleSignals = new WeakMap<object, AbortSignal>();

export function registerHostDeckSseSourceLifecycle<T extends AsyncIterable<unknown>>(
  input: RegisterHostDeckSseSourceLifecycleInput<T>
): T {
  const values = readExactLifecycleInput(input);
  if (!isAsyncIterable(values.iterable)) {
    throw new TypeError("HostDeck SSE source lifecycle iterable is invalid.");
  }
  if (!(values.signal instanceof AbortSignal)) {
    throw new TypeError("HostDeck SSE source lifecycle signal is invalid.");
  }
  if (sourceLifecycleSignals.has(values.iterable)) {
    throw new TypeError("HostDeck SSE source lifecycle is already registered.");
  }
  sourceLifecycleSignals.set(values.iterable, values.signal);
  return values.iterable as T;
}

export function hostDeckSseSourceLifecycleSignal(
  iterable: AsyncIterable<unknown>
): AbortSignal | null {
  return sourceLifecycleSignals.get(iterable as object) ?? null;
}

export function createHostDeckSseReadable(input: CreateHostDeckSseReadableInput): Readable {
  return Readable.from(managedSseMessages(input), { highWaterMark: 1, objectMode: true });
}

async function* managedSseMessages(input: CreateHostDeckSseReadableInput): AsyncGenerator<SSEMessage> {
  const iterator = input.iterable[Symbol.asyncIterator]();
  let completed = false;
  let lastCursor = input.after;
  try {
    while (true) {
      const next = await nextWithAbort(iterator, input.signal);
      if (next.done) {
        completed = true;
        return;
      }
      const event = parseSelectedEvent(next.value);
      if (input.expectedSessionId !== null && event.session_id !== input.expectedSessionId) {
        throw new HostDeckSseTransportError(
          "invalid_event",
          "SSE source emitted an event for a different session."
        );
      }
      if (lastCursor !== null && event.cursor <= lastCursor) {
        throw new HostDeckSseTransportError(
          "invalid_cursor_order",
          "SSE event cursor did not advance."
        );
      }
      const message = toBoundedSseMessage(event, input.eventMaxBytes);
      lastCursor = event.cursor;
      yield message;
    }
  } catch (cause) {
    throw normalizeSseTransportError(
      cause,
      "source_iteration_failed",
      "SSE event source iteration failed."
    );
  } finally {
    if (!completed) {
      const cleanupError = await closeIterator(iterator, input.cleanupTimeoutMs);
      if (cleanupError !== null) input.onCleanupFailure(cleanupError);
    }
  }
}

function parseSelectedEvent(value: unknown): SelectedProjectionEvent {
  const result = selectedProjectionEventSchema.safeParse(value);
  if (!result.success) {
    throw new HostDeckSseTransportError(
      "invalid_event",
      "SSE source emitted an invalid selected projection event.",
      result.error
    );
  }
  return result.data;
}

function toBoundedSseMessage(event: SelectedProjectionEvent, maximumBytes: number): SSEMessage {
  const id = String(event.cursor);
  const data = serializeSseJson(event);
  const wireBytes = serializedSseWireByteLength(event, data);
  if (wireBytes > maximumBytes) {
    throw new HostDeckSseTransportError(
      "event_too_large",
      "Serialized SSE event exceeds its configured byte limit."
    );
  }
  return { data: event, event: event.type, id };
}

export function selectedProjectionSseWireByteLength(candidate: unknown): number {
  const event = parseSelectedEvent(candidate);
  return serializedSseWireByteLength(event, serializeSseJson(event));
}

function serializedSseWireByteLength(event: SelectedProjectionEvent, data: string): number {
  return Buffer.byteLength(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${data}\n\n`, "utf8");
}

async function nextWithAbort(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) throw new HostDeckSseAbortError(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new HostDeckSseAbortError(signal.reason)));
    signal.addEventListener("abort", onAbort, { once: true });
    let result: PromiseLike<IteratorResult<unknown>> | IteratorResult<unknown>;
    try {
      result = iterator.next();
    } catch (cause) {
      finish(() =>
        reject(
          normalizeSseTransportError(
            cause,
            "source_iteration_failed",
            "SSE event source iteration failed."
          )
        )
      );
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(() => resolve(value)),
      (cause) =>
        finish(() =>
          reject(
            normalizeSseTransportError(
              cause,
              "source_iteration_failed",
              "SSE event source iteration failed."
            )
          )
        )
    );
  });
}

async function closeIterator(
  iterator: AsyncIterator<unknown>,
  timeoutMs: number
): Promise<HostDeckSseTransportError | null> {
  if (iterator.return === undefined) return null;
  let cleanup: Promise<IteratorResult<unknown>>;
  try {
    cleanup = Promise.resolve(iterator.return());
  } catch (cause) {
    return new HostDeckSseTransportError(
      "source_cleanup_failed",
      "SSE source cleanup failed.",
      cause
    );
  }
  try {
    await withTimeout(cleanup, timeoutMs);
    return null;
  } catch (cause) {
    if (cause instanceof HostDeckSseTransportError) return cause;
    return new HostDeckSseTransportError(
      "source_cleanup_failed",
      "SSE source cleanup failed.",
      cause
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new HostDeckSseTransportError(
              "source_cleanup_timeout",
              "SSE source cleanup exceeded its configured timeout."
            )
          );
        }, timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function serializeSseJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new HostDeckSseTransportError(
      "invalid_event",
      "SSE event could not be serialized."
    );
  }
  return serialized;
}

export function normalizeSseTransportError(
  cause: unknown,
  code: HostDeckSseFailureCode,
  message: string
): HostDeckSseTransportError | HostDeckSseAbortError {
  if (cause instanceof HostDeckSseTransportError || cause instanceof HostDeckSseAbortError) return cause;
  return new HostDeckSseTransportError(code, message, cause);
}

export function observeSseFailure(
  observer: HostDeckSseFailureObserver,
  request: FastifyRequest,
  error: Error
): void {
  const code = error instanceof HostDeckSseTransportError ? error.code : "transport_send_failed";
  try {
    const result: unknown = observer(Object.freeze({ code, error, request_id: request.id }));
    if (isPromiseLike(result)) {
      recordObserverFailure(request);
      void Promise.resolve(result).catch(() => recordObserverFailure(request));
    }
  } catch {
    recordObserverFailure(request);
  }
}

function recordObserverFailure(request: FastifyRequest): void {
  request.log.error(
    { event: "hostdeck.sse_error_observer_failed", request_id: request.id },
    "HostDeck SSE error observer failed"
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function readExactLifecycleInput(
  candidate: unknown
): Readonly<Record<"iterable" | "signal", unknown>> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("HostDeck SSE source lifecycle input must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const iterableDescriptor = descriptors.iterable;
  const signalDescriptor = descriptors.signal;
  if (
    keys.length !== 2 ||
    iterableDescriptor === undefined ||
    signalDescriptor === undefined ||
    !("value" in iterableDescriptor) ||
    !("value" in signalDescriptor)
  ) {
    throw new TypeError("HostDeck SSE source lifecycle fields are invalid.");
  }
  return Object.freeze({
    iterable: iterableDescriptor.value,
    signal: signalDescriptor.value
  });
}

function isAsyncIterable(candidate: unknown): candidate is AsyncIterable<unknown> {
  return (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "function") &&
    typeof (candidate as { readonly [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}
