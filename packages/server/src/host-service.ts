import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type ApiErrorEnvelope, type HostStatusResponse, hostStatusResponseSchema } from "@hostdeck/contracts";
import { createErrorEnvelope, type ErrorCode } from "@hostdeck/core";
import { type HostStartupResult, type StartHostAgentInput, startHostAgent } from "./startup.js";

export interface StartHostHttpServiceInput extends StartHostAgentInput {}

export interface HostHttpService {
  readonly baseUrl: URL;
  readonly startup: HostStartupResult;
  readonly server: Server;
  readonly status: () => HostStatusResponse;
  readonly close: () => Promise<void>;
}

type ApiRouteErrorBody = { readonly error: ApiErrorEnvelope };

export async function startHostHttpService(input: StartHostHttpServiceInput): Promise<HostHttpService> {
  const startup = await startHostAgent(input);
  const status = () => currentStatus(startup);
  const server = createServer((request, response) => handleRequest(request, response, status));

  try {
    const bind = status().bind;
    server.listen({
      host: bind.host,
      port: bind.port,
      exclusive: true
    });
    await once(server, "listening");
  } catch (error) {
    startup.close();
    await closeServer(server);
    throw error;
  }

  return {
    baseUrl: baseUrlForStatus(status()),
    startup,
    server,
    status,
    async close() {
      try {
        await closeServer(server);
      } finally {
        startup.close();
      }
    }
  };
}

function handleRequest(request: IncomingMessage, response: ServerResponse, status: () => HostStatusResponse): void {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/api/host/status") {
    if (method !== "GET") {
      writeJson(response, 405, routeError("validation_error", "Host status only supports GET.", "method"));
      return;
    }

    writeJson(response, 200, status());
    return;
  }

  writeJson(response, 404, routeError("malformed_request", `Route ${method} ${url.pathname} is not available.`, "route"));
}

function currentStatus(startup: HostStartupResult): HostStatusResponse {
  const settings = startup.settings.require();

  return hostStatusResponseSchema.parse({
    ...startup.status,
    bind: {
      mode: settings.bind_mode,
      host: settings.bind_host,
      port: settings.bind_port
    },
    locked: settings.locked,
    lan_enabled: settings.lan_enabled
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function routeError(code: ErrorCode, message: string, field?: string): ApiRouteErrorBody {
  return {
    error: createErrorEnvelope({
      code,
      message,
      retryable: false,
      ...(field !== undefined ? { field } : {})
    })
  };
}

function baseUrlForStatus(status: HostStatusResponse): URL {
  const host = status.bind.host === "0.0.0.0" ? "127.0.0.1" : status.bind.host;
  return new URL(`http://${host}:${status.bind.port}`);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}

export function listeningPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("HostDeck service does not have a TCP address.");
  }

  return (address as AddressInfo).port;
}
