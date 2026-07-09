import { apiRouteErrorBodySchema, type HostStatusResponse, hostStatusResponseSchema } from "@hostdeck/contracts";
import { apiFailure, daemonUnavailableFailure, internalFailure } from "./errors.js";

export interface HostDeckApiClient {
  readonly getStatus: () => Promise<HostStatusResponse>;
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
      })
  };
}

async function requestJson<T>(options: {
  readonly baseUrl: URL;
  readonly fetch: HttpFetch;
  readonly method: "GET" | "POST";
  readonly path: `/api/${string}`;
  readonly responseSchema: RuntimeSchema<T>;
}): Promise<T> {
  const url = new URL(options.path, options.baseUrl);
  let response: HttpResponse;

  try {
    response = await options.fetch(url.toString(), {
      method: options.method,
      headers: {
        accept: "application/json"
      }
    });
  } catch (error) {
    throw daemonUnavailableFailure(options.baseUrl, error);
  }

  const payload = await readJsonPayload(response);

  if (!response.ok) {
    const parsedError = apiRouteErrorBodySchema.safeParse(payload);

    if (!parsedError.success) {
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
