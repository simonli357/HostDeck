import { fastifySSE } from "@fastify/sse";
import { outputCursorSchema } from "@hostdeck/contracts";
import { type OutputCursor, parseOutputCursor } from "@hostdeck/core";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { HostDeckRoutePluginRegistration } from "./fastify-app.js";
import { createHostDeckErrorBody, HostDeckHttpError } from "./fastify-error-policy.js";
import { hostDeckRequestDeviceAuthoritySignal } from "./fastify-request-authentication.js";
import {
  createHostDeckSseReadable,
  HostDeckSseAbortError,
  type HostDeckSseFailureObserver,
  HostDeckSseTransportError,
  hostDeckSseSourceLifecycleSignal,
  normalizeSseTransportError,
  observeSseFailure,
  serializeSseJson
} from "./fastify-sse-source.js";

export {
  type HostDeckSseFailureCode,
  type HostDeckSseFailureObservation,
  type HostDeckSseFailureObserver,
  hostDeckSseFailureCodes
} from "./fastify-sse-source.js";

export interface HostDeckSseSourceInput {
  readonly after: OutputCursor | null;
  readonly params: unknown;
  readonly request: FastifyRequest;
  readonly signal: AbortSignal;
}

export interface HostDeckSseEventSource {
  readonly open: (
    input: HostDeckSseSourceInput
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

export interface CreateHostDeckSseTransportRegistrationInput {
  readonly id: string;
  readonly observeError: HostDeckSseFailureObserver;
  readonly paramsSchema?: z.ZodType;
  readonly path: `/${string}`;
  readonly source: HostDeckSseEventSource;
}

const cursorTextSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/u)
  .transform(Number)
  .pipe(outputCursorSchema);
const cursorQuerySchema = z.object({ after: cursorTextSchema.optional() }).strict();
const registrationIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const routePathPattern = /^\/[a-zA-Z0-9_./:-]{1,255}$/u;

export function createHostDeckSseTransportRegistration(
  input: CreateHostDeckSseTransportRegistrationInput
): HostDeckRoutePluginRegistration {
  const parsed = parseRegistrationInput(input);
  const registration: HostDeckRoutePluginRegistration = {
    id: parsed.id,
    surface: "sse",
    async register(app, context) {
      await app.register(fastifySSE, {
        heartbeatInterval: context.resourceBudget.sse_heartbeat_interval_ms,
        serializer: serializeSseJson
      });
      app.addHook("onSend", async (request, reply, payload) => {
        if (
          reply.statusCode === 406 &&
          (reply as { readonly sse?: unknown }).sse === undefined
        ) {
          reply.header("x-request-id", request.id).type("application/json; charset=utf-8");
          return JSON.stringify(
            createHostDeckErrorBody(
              {
                code: "not_acceptable",
                message: "This route produces only text/event-stream.",
                retryable: false
              },
              request.id
            )
          );
        }
        return payload;
      });

      app.get(
        parsed.path,
        {
          sse: "only",
          schema: {
            querystring: cursorQuerySchema,
            ...(parsed.paramsSchema !== undefined ? { params: parsed.paramsSchema } : {})
          }
        },
        async (request, reply) => {
          const after = resolveRequestedCursor(request);
          const requestSignal = AbortSignal.any([
            request.signal,
            hostDeckRequestDeviceAuthoritySignal(request)
          ]);
          let iterable: AsyncIterable<unknown>;
          try {
            iterable = await awaitWithAbort(
              Promise.resolve(
                parsed.openSource(Object.freeze({
                  after,
                  params: request.params,
                  request,
                  signal: requestSignal
                }))
              ),
              requestSignal
            );
            assertAsyncIterable(iterable);
          } catch (cause) {
            if (requestSignal.aborted || cause instanceof HostDeckSseAbortError) return;
            if (cause instanceof HostDeckHttpError) throw cause;
            const error = normalizeSseTransportError(
              cause,
              "source_open_failed",
              "SSE event source failed to open."
            );
            observeSseFailure(parsed.observeError, request, error);
            throw new HostDeckHttpError({
              status: 500,
              code: "internal_error",
              message: "Event stream is unavailable."
            });
          }

          const sourceSignal = hostDeckSseSourceLifecycleSignal(iterable);
          const deliverySignal =
            sourceSignal === null
              ? requestSignal
              : AbortSignal.any([requestSignal, sourceSignal]);

          const readable = createHostDeckSseReadable({
            after,
            cleanupTimeoutMs: context.resourceBudget.sse_disconnect_cleanup_timeout_ms,
            eventMaxBytes: context.resourceBudget.sse_event_max_bytes,
            expectedSessionId: optionalSessionId(request.params),
            iterable,
            onCleanupFailure: (error) => observeSseFailure(parsed.observeError, request, error),
            signal: deliverySignal
          });
          const destroyReadable = () => {
            if (!readable.destroyed) {
              readable.destroy(new HostDeckSseAbortError(deliverySignal.reason));
            }
            if (reply.sse.isConnected) reply.sse.close();
          };
          let readableFailure: Error | undefined;
          const captureReadableFailure = (error: Error) => {
            readableFailure = error;
          };
          const finishFiniteResponse = () => {
            if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
          };
          readable.once("error", captureReadableFailure);
          readable.once("end", finishFiniteResponse);
          deliverySignal.addEventListener("abort", destroyReadable, { once: true });
          reply.sse.onClose(destroyReadable);
          if (deliverySignal.aborted) destroyReadable();

          try {
            await reply.sse.send(readable);
            if (readableFailure !== undefined) {
              if (!deliverySignal.aborted && !(readableFailure instanceof HostDeckSseAbortError)) {
                const error = normalizeSseTransportError(
                  readableFailure,
                  "transport_send_failed",
                  "SSE transport failed while sending."
                );
                observeSseFailure(parsed.observeError, request, error);
              }
              if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
            } else if (reply.sse.isConnected) {
              reply.sse.close();
            }
          } catch (cause) {
            if (!deliverySignal.aborted && !(cause instanceof HostDeckSseAbortError)) {
              const error = normalizeSseTransportError(
                cause,
                "transport_send_failed",
                "SSE transport failed while sending."
              );
              observeSseFailure(parsed.observeError, request, error);
              if (!reply.sent) {
                throw new HostDeckHttpError({
                  status: 500,
                  code: "internal_error",
                  message: "Event stream is unavailable."
                });
              }
            }
            if (reply.sse.isConnected) reply.sse.close();
          } finally {
            deliverySignal.removeEventListener("abort", destroyReadable);
            readable.removeListener("error", captureReadableFailure);
            readable.removeListener("end", finishFiniteResponse);
            readable.destroy();
          }
        }
      );
    }
  };
  return Object.freeze(registration);
}

interface ParsedRegistrationInput {
  readonly id: string;
  readonly observeError: HostDeckSseFailureObserver;
  readonly openSource: HostDeckSseEventSource["open"];
  readonly paramsSchema: z.ZodType | undefined;
  readonly path: `/${string}`;
}

function parseRegistrationInput(input: unknown): ParsedRegistrationInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("HostDeck SSE transport registration input must be an object.");
  }
  const value = input as Partial<CreateHostDeckSseTransportRegistrationInput>;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("HostDeck SSE transport registration input must be a plain object.");
  }
  const keys = Object.keys(value).sort();
  const allowedKeys = ["id", "observeError", "paramsSchema", "path", "source"];
  const requiredKeys = ["id", "observeError", "path", "source"];
  if (
    keys.some((key) => !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("HostDeck SSE transport registration fields are invalid.");
  }
  if (typeof value.id !== "string" || !registrationIdPattern.test(value.id)) {
    throw new TypeError("HostDeck SSE transport registration id is invalid.");
  }
  if (
    typeof value.path !== "string" ||
    !routePathPattern.test(value.path) ||
    value.path.includes("//") ||
    value.path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("HostDeck SSE transport route path is invalid.");
  }
  if (value.paramsSchema !== undefined && !(value.paramsSchema instanceof z.ZodType)) {
    throw new TypeError("HostDeck SSE transport params schema must be a Zod schema.");
  }
  if (value.path.includes(":") && value.paramsSchema === undefined) {
    throw new TypeError("HostDeck SSE parameterized routes require a Zod params schema.");
  }
  if (value.source === null || typeof value.source !== "object" || typeof value.source.open !== "function") {
    throw new TypeError("HostDeck SSE transport requires an event source.");
  }
  if (typeof value.observeError !== "function") {
    throw new TypeError("HostDeck SSE transport requires an error observer.");
  }
  return Object.freeze({
    id: value.id,
    observeError: value.observeError,
    openSource: value.source.open.bind(value.source),
    paramsSchema: value.paramsSchema,
    path: value.path as `/${string}`
  });
}

function resolveRequestedCursor(request: FastifyRequest): OutputCursor | null {
  const query = request.query as { readonly after?: number };
  const queryCursor = query.after === undefined ? null : requireOutputCursor(query.after);
  const headerValue = request.headers["last-event-id"];
  const headerCursor = headerValue === undefined ? null : parseCursorText(headerValue, "last-event-id");
  if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor) {
    throw new HostDeckHttpError({
      status: 400,
      code: "validation_error",
      message: "Cursor query conflicts with Last-Event-ID.",
      field: "after"
    });
  }
  return queryCursor ?? headerCursor;
}

function parseCursorText(value: unknown, field: string): OutputCursor {
  const result = cursorTextSchema.safeParse(value);
  if (!result.success) {
    throw new HostDeckHttpError({
      status: 400,
      code: "validation_error",
      message: "Event cursor is malformed.",
      field
    });
  }
  return requireOutputCursor(result.data);
}

function requireOutputCursor(value: number): OutputCursor {
  const result = parseOutputCursor(value);
  if (!result.ok) throw new TypeError("Validated SSE cursor could not be normalized.");
  return result.value;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
    promise.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause))
    );
  });
}

function assertAsyncIterable(value: unknown): asserts value is AsyncIterable<unknown> {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) {
    throw new HostDeckSseTransportError(
      "source_open_failed",
      "SSE event source did not return an AsyncIterable."
    );
  }
}

function optionalSessionId(params: unknown): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const value: unknown = (params as { readonly session_id?: unknown }).session_id;
  return typeof value === "string" ? value : null;
}
