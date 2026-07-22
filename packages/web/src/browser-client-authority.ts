const httpClientOrigins = new WeakMap<object, string>();
const sseClientOrigins = new WeakMap<object, string>();
const csrfClientHttpClients = new WeakMap<object, object>();

export function registerBrowserHttpClientAuthority(
  client: object,
  origin: string
): void {
  httpClientOrigins.set(client, origin);
}

export function browserHttpClientOrigin(client: object): string | null {
  return httpClientOrigins.get(client) ?? null;
}

export function registerBrowserSseClientAuthority(
  client: object,
  origin: string
): void {
  sseClientOrigins.set(client, origin);
}

export function browserSseClientOrigin(client: object): string | null {
  return sseClientOrigins.get(client) ?? null;
}

export function registerBrowserCsrfClientAuthority(
  client: object,
  httpClient: object
): void {
  csrfClientHttpClients.set(client, httpClient);
}

export function browserCsrfClientHttpClient(client: object): object | null {
  return csrfClientHttpClients.get(client) ?? null;
}
