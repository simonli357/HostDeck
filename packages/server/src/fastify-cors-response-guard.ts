import { Buffer } from "node:buffer";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createHostDeckErrorBody,
  type HostDeckInternalErrorObserver
} from "./fastify-error-policy.js";

interface CorsResponseGuardState {
  body: string | null;
  readonly mark: () => void;
}

type ReplyWithCorsResponseGuard = FastifyReply & {
  [corsResponseGuard]?: CorsResponseGuardState;
};

export type HostDeckCorsViolationObserver = (request: FastifyRequest) => void;

const corsResponseGuard = Symbol("hostdeckCorsResponseGuard");
const guardedApps = new WeakSet<FastifyInstance>();

export function installHostDeckCorsResponseGuard(
  app: FastifyInstance,
  observeInternalError: HostDeckInternalErrorObserver,
  observeViolation: HostDeckCorsViolationObserver
): void {
  if (typeof observeInternalError !== "function") {
    throw new TypeError("HostDeck CORS internal-error observer must be a function.");
  }
  if (typeof observeViolation !== "function") {
    throw new TypeError("HostDeck CORS violation observer must be a function.");
  }
  if (guardedApps.has(app)) throw new TypeError("HostDeck CORS response guard is already installed.");

  app.addHook("onRequest", async (request, reply) => {
    installRawCorsResponseGuard(request, reply, observeInternalError, observeViolation);
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    const forbidden = Object.keys(reply.getHeaders()).filter(isForbiddenCorsResponseHeader);
    if (forbidden.length === 0) return payload;
    for (const header of forbidden) reply.removeHeader(header);
    requireCorsResponseGuard(reply).mark();
    return payload;
  });
  guardedApps.add(app);
}

function installRawCorsResponseGuard(
  request: FastifyRequest,
  reply: FastifyReply,
  observeInternalError: HostDeckInternalErrorObserver,
  observeViolation: HostDeckCorsViolationObserver
): void {
  const state: CorsResponseGuardState = {
    body: null,
    mark() {
      if (state.body !== null) return;
      observeCorsViolationCount(observeViolation, request);
      const error = new Error("HostDeck routes cannot emit CORS response headers.");
      state.body = JSON.stringify(
        createHostDeckErrorBody(
          {
            code: "internal_error",
            message: "Internal server error.",
            retryable: false
          },
          request.id
        )
      );
      observeCorsViolation(observeInternalError, request, error);
    }
  };
  (reply as ReplyWithCorsResponseGuard)[corsResponseGuard] = state;

  const originalReplyHeader = reply.header;
  reply.header = ((name: string, value: unknown) => {
    if (isForbiddenCorsResponseHeader(name)) {
      state.mark();
      return reply;
    }
    return originalReplyHeader.call(reply, name, value);
  }) as typeof reply.header;

  const originalReplyHeaders = reply.headers;
  reply.headers = ((headers: Record<string, unknown>) => {
    if (headerContainerHasForbiddenCors(headers)) {
      state.mark();
      return reply;
    }
    return Reflect.apply(originalReplyHeaders, reply, [headers]) as FastifyReply;
  }) as typeof reply.headers;

  const raw = reply.raw;
  const originalSetHeader = raw.setHeader;
  raw.setHeader = ((name: string, value: string | number | readonly string[]) => {
    if (isForbiddenCorsResponseHeader(name)) {
      state.mark();
      return raw;
    }
    return originalSetHeader.call(raw, name, value);
  }) as typeof raw.setHeader;

  const originalAppendHeader = raw.appendHeader;
  raw.appendHeader = ((name: string, value: string | readonly string[]) => {
    if (isForbiddenCorsResponseHeader(name)) {
      state.mark();
      return raw;
    }
    return originalAppendHeader.call(raw, name, value);
  }) as typeof raw.appendHeader;

  const responseWithSetHeaders = raw as typeof raw & {
    setHeaders?: (headers: Headers | Map<string, unknown>) => typeof raw;
  };
  if (typeof responseWithSetHeaders.setHeaders === "function") {
    const originalSetHeaders = responseWithSetHeaders.setHeaders;
    responseWithSetHeaders.setHeaders = ((headers: Headers | Map<string, unknown>) => {
      if (headerContainerHasForbiddenCors(headers)) {
        state.mark();
        return raw;
      }
      return originalSetHeaders.call(raw, headers);
    }) as typeof originalSetHeaders;
  }

  const originalWriteHead = raw.writeHead;
  raw.writeHead = ((...args: unknown[]) => {
    const headers = typeof args[1] === "string" ? args[2] : args[1];
    if (headerContainerHasForbiddenCors(headers)) state.mark();
    if (state.body === null) return Reflect.apply(originalWriteHead, raw, args) as typeof raw;
    prepareCorsErrorResponse(raw, originalSetHeader, request.id, state.body);
    return Reflect.apply(originalWriteHead, raw, [500]) as typeof raw;
  }) as typeof raw.writeHead;

  const originalEnd = raw.end;
  raw.end = ((...args: unknown[]) => {
    if (state.body === null) return Reflect.apply(originalEnd, raw, args) as typeof raw;
    prepareCorsErrorResponse(raw, originalSetHeader, request.id, state.body);
    const callback = args.find((argument) => typeof argument === "function");
    const errorArgs: unknown[] = request.method === "HEAD" ? [] : [state.body, "utf8"];
    if (callback !== undefined) errorArgs.push(callback);
    return Reflect.apply(originalEnd, raw, errorArgs) as typeof raw;
  }) as typeof raw.end;
}

function requireCorsResponseGuard(reply: FastifyReply): CorsResponseGuardState {
  const state = (reply as ReplyWithCorsResponseGuard)[corsResponseGuard];
  if (state === undefined) throw new Error("HostDeck CORS response guard is unavailable.");
  return state;
}

function prepareCorsErrorResponse(
  raw: FastifyReply["raw"],
  originalSetHeader: FastifyReply["raw"]["setHeader"],
  requestId: string,
  body: string
): void {
  if (raw.headersSent) return;
  for (const name of raw.getHeaderNames()) raw.removeHeader(name);
  raw.statusCode = 500;
  originalSetHeader.call(raw, "content-type", "application/json; charset=utf-8");
  originalSetHeader.call(raw, "content-length", Buffer.byteLength(body, "utf8"));
  originalSetHeader.call(raw, "x-request-id", requestId);
}

function observeCorsViolation(
  observer: HostDeckInternalErrorObserver,
  request: FastifyRequest,
  error: Error
): void {
  try {
    const result: unknown = (observer as (observation: {
      readonly error: unknown;
      readonly request_id: string;
    }) => unknown)({
      error,
      request_id: request.id
    });
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => recordCorsObserverFailure(request));
  } catch {
    recordCorsObserverFailure(request);
  }
}

function observeCorsViolationCount(observer: HostDeckCorsViolationObserver, request: FastifyRequest): void {
  try {
    observer(request);
  } catch {
    recordCorsObserverFailure(request);
  }
}

function recordCorsObserverFailure(request: FastifyRequest): void {
  request.log.error(
    { event: "hostdeck.internal_error_observer_failed", request_id: request.id },
    "HostDeck internal error observer failed"
  );
}

function headerContainerHasForbiddenCors(headers: unknown): boolean {
  if (headers === undefined || headers === null) return false;
  if (headers instanceof Headers || headers instanceof Map) {
    return [...headers.keys()].some((name) => isForbiddenCorsResponseHeader(String(name)));
  }
  if (Array.isArray(headers)) {
    if (!headers.some(Array.isArray)) {
      return headers.some(
        (value, index) => index % 2 === 0 && typeof value === "string" && isForbiddenCorsResponseHeader(value)
      );
    }
    return headers.some(
      (entry) => Array.isArray(entry) && typeof entry[0] === "string" && isForbiddenCorsResponseHeader(entry[0])
    );
  }
  if (typeof headers === "object") return Object.keys(headers).some(isForbiddenCorsResponseHeader);
  return false;
}

function isForbiddenCorsResponseHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("access-control-") || normalized === "timing-allow-origin";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}
