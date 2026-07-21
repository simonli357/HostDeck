import type { InjectOptions, LightMyRequestResponse } from "fastify";
import type { HostDeckFastifyInstance } from "./fastify-app.js";

export const hostDeckLoopbackTestAuthority = "127.0.0.1:3777";
export const hostDeckLoopbackTestOrigin = `http://${hostDeckLoopbackTestAuthority}`;

export function injectHostDeckLoopback(
  app: HostDeckFastifyInstance,
  input: InjectOptions | string
): Promise<LightMyRequestResponse> {
  const request: InjectOptions = typeof input === "string"
    ? { method: "GET", url: input }
    : input;
  return app.inject({
    ...request,
    headers: {
      host: hostDeckLoopbackTestAuthority,
      ...request.headers
    }
  });
}
