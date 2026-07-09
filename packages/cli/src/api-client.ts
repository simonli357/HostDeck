import {
  apiRouteErrorBodySchema,
  type HostStatusResponse,
  hostStatusResponseSchema,
  type SessionDetailResponse,
  type SessionListResponse,
  type StartSessionResponse,
  sessionDetailResponseSchema,
  sessionListResponseSchema,
  startSessionResponseSchema,
  type WriteResponse,
  writeResponseSchema
} from "@hostdeck/contracts";
import { apiFailure, daemonUnavailableFailure, internalFailure } from "./errors.js";

export interface HostDeckApiClient {
  readonly getStatus: () => Promise<HostStatusResponse>;
  readonly startSession: (input: { readonly name: string; readonly cwd: string }) => Promise<StartSessionResponse>;
  readonly listSessions: () => Promise<SessionListResponse>;
  readonly getSession: (sessionId: string) => Promise<SessionDetailResponse>;
  readonly sendPrompt: (sessionId: string, text: string) => Promise<WriteResponse>;
  readonly stopSession: (sessionId: string) => Promise<WriteResponse>;
}

export interface HostDeckApiClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

export interface HttpRequestInit {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}

export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

interface RuntimeSchema<T> {
  readonly safeParse: (input: unknown) => { readonly success: true; readonly data: T } | { readonly success: false };
}

export function createHostDeckApiClient(options: HostDeckApiClientOptions): HostDeckApiClient {
  const httpFetch = options.fetch ?? globalFetch;

  return {
    getStatus: () =>
      requestJson({
        baseUrl: options.baseUrl,
        fetch: httpFetch,
        method: "GET",
        path: "/api/host/status",
        responseSchema: hostStatusResponseSchema
      }),
    startSession: (input) =>
      requestJson({
        baseUrl: options.baseUrl,
        fetch: httpFetch,
        method: "POST",
        path: "/api/sessions",
        body: input,
        responseSchema: startSessionResponseSchema
      }),
    listSessions: () =>
      requestJson({
        baseUrl: options.baseUrl,
        fetch: httpFetch,
        method: "GET",
        path: "/api/sessions",
        responseSchema: sessionListResponseSchema
      }),
    getSession: (sessionId) =>
      requestJson({
        baseUrl: options.baseUrl,
        fetch: httpFetch,
        method: "GET",
        path: `/api/sessions/${encodeURIComponent(sessionId)}`,
        responseSchema: sessionDetailResponseSchema
      }),
    sendPrompt: async (sessionId, text) => {
      const response = await requestJson({
        baseUrl: options.baseUrl,
        fetch: httpFetch,
        method: "POST",
        path: `/api/sessions/${encodeURIComponent(sessionId)}/input`,
        body: { text },
        responseSchema: writeResponseSchema
      });

      return acceptedWriteOrThrow(response, 409);
    },
    stopSession: async (sessionId) => {
      const response = await requestJson({
        baseUrl: options.baseUrl,
        fetch: httpFetch,
        method: "POST",
        path: `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
        body: { confirm: true },
        responseSchema: writeResponseSchema
      });

      return acceptedWriteOrThrow(response, 409);
    }
  };
}

async function requestJson<T>(options: {
  readonly baseUrl: URL;
  readonly fetch: HttpFetch;
  readonly method: "GET" | "POST";
  readonly path: `/api/${string}`;
  readonly body?: unknown;
  readonly responseSchema: RuntimeSchema<T>;
}): Promise<T> {
  const url = new URL(options.path, options.baseUrl);
  let response: HttpResponse;

  try {
    response = await options.fetch(url.toString(), {
      method: options.method,
      headers: {
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
  } catch (error) {
    throw daemonUnavailableFailure(options.baseUrl, error);
  }

  const payload = await readJsonPayload(response);

  if (!response.ok) {
    const parsedError = apiRouteErrorBodySchema.safeParse(payload);

    if (!parsedError.success) {
      const parsedWriteRejection = writeResponseSchema.safeParse(payload);

      if (parsedWriteRejection.success && !parsedWriteRejection.data.accepted) {
        throw apiFailure(response.status, parsedWriteRejection.data.error);
      }

      throw internalFailure(`HostDeck daemon returned an untyped HTTP ${response.status} error.`);
    }

    throw apiFailure(response.status, parsedError.data.error);
  }

  const parsedResponse = options.responseSchema.safeParse(payload);

  if (!parsedResponse.success) {
    throw internalFailure(`HostDeck daemon returned a response that does not match ${options.path}.`);
  }

  return parsedResponse.data;
}

function acceptedWriteOrThrow(response: WriteResponse, status: number): WriteResponse {
  if (!response.accepted) {
    throw apiFailure(status, response.error);
  }

  return response;
}

async function readJsonPayload(response: HttpResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw internalFailure(`HostDeck daemon returned invalid JSON for HTTP ${response.status}.`, error);
  }
}

const globalFetch: HttpFetch = async (url, init) => {
  const response = await fetch(url, init);

  return {
    status: response.status,
    ok: response.ok,
    json: () => response.json(),
    text: () => response.text()
  };
};
