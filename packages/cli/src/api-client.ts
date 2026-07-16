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
