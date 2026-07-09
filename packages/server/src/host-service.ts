import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type ApiErrorEnvelope, type HostStatusResponse, hostStatusResponseSchema } from "@hostdeck/contracts";
import { createErrorEnvelope, type ErrorCode } from "@hostdeck/core";
import {
  createAuditEventRepository,
  createAuthDeviceRepository,
  createPairingCodeRepository,
  createRetentionRepository,
  createSessionMetadataRepository
} from "@hostdeck/storage";
import { createRealTmuxAdapter, type TmuxAdapter } from "@hostdeck/tmux-adapter";
import { createOutputReader, type OutputReader } from "./output-reader.js";
import { createReadRouteHandlers, type ReadAuthInput, type ReadRouteHandlers } from "./read-routes.js";
import {
  type BrowserAuthInput,
  createSecurityRouteHandlers,
  type HttpCookie,
  type JsonRouteResult,
  type SecurityRouteHandlers
} from "./security-routes.js";
import { createSessionControlRouteHandlers, type SessionControlRouteHandlers } from "./session-control-routes.js";
import { type HostStartupResult, type StartHostAgentInput, startHostAgent } from "./startup.js";
import { createStreamRouteHandlers, type SessionStreamLiveSource, type StreamRouteHandlers } from "./stream-routes.js";
import { createWriteRouteHandlers, type WriteRouteHandlers } from "./write-routes.js";

type ServiceTmuxAdapter = Pick<TmuxAdapter, "readOutput" | "sendInput" | "startSession" | "stopSession">;
type ServiceOutputReader = Pick<OutputReader, "drainSession" | "replaySession">;

export interface StartHostHttpServiceInput extends StartHostAgentInput {
  readonly tmux?: ServiceTmuxAdapter;
  readonly outputReader?: ServiceOutputReader;
  readonly liveSource?: SessionStreamLiveSource;
}

export interface HostHttpService {
  readonly baseUrl: URL;
  readonly startup: HostStartupResult;
  readonly server: Server;
  readonly status: () => HostStatusResponse;
  readonly close: () => Promise<void>;
}

type ApiRouteErrorBody = { readonly error: ApiErrorEnvelope };

interface ServiceRouteHandlers {
  readonly read: ReadRouteHandlers;
  readonly control: SessionControlRouteHandlers;
  readonly write: WriteRouteHandlers;
  readonly security: SecurityRouteHandlers;
  readonly stream: StreamRouteHandlers;
}

const maxJsonBodyBytes = 64 * 1024;
const deviceCookieName = "hostdeck_device";
const csrfHeaderName = "x-hostdeck-csrf";

export async function startHostHttpService(input: StartHostHttpServiceInput): Promise<HostHttpService> {
  const startup = await startHostAgent(input);
  const status = () => currentStatus(startup);
  let routes: ServiceRouteHandlers;

  try {
    routes = createServiceRouteHandlers(startup, status, input);
  } catch (error) {
    startup.close();
    throw error;
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, routes).catch((error) => {
      if (error instanceof HttpRequestError && !response.headersSent) {
        writeJson(response, error.status, routeError(error.code, error.message, error.field));
        return;
      }

      if (!response.headersSent) {
        writeJson(response, 500, routeError("internal_error", "HostDeck service request handling failed.", undefined, errorDetails(error)));
        return;
      }

      response.destroy(error instanceof Error ? error : undefined);
    });
  });

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

function createServiceRouteHandlers(
  startup: HostStartupResult,
  status: () => HostStatusResponse,
  input: StartHostHttpServiceInput
): ServiceRouteHandlers {
  const metadata = createSessionMetadataRepository(startup.db);
  const retention = createRetentionRepository(startup.db);
  const authDevices = createAuthDeviceRepository(startup.db);
  const pairingCodes = createPairingCodeRepository(startup.db);
  const auditEvents = createAuditEventRepository(startup.db);
  const tmux =
    input.tmux ??
    createRealTmuxAdapter({
      ...(input.tmuxBinary !== undefined ? { tmuxBinary: input.tmuxBinary } : {}),
      ...(input.tmuxSocketName !== undefined ? { socketName: input.tmuxSocketName } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
      expectedTargets: startup.reconciliation.liveTargets
    });
  const outputReader =
    input.outputReader ??
    createOutputReader({
      retention,
      capture: {
        async captureOutput(captureInput) {
          const events = await tmux.readOutput({ sessionId: captureInput.sessionId, limit: 1_000 });
          return events.map((event) => event.text).join("\n");
        }
      },
      ...(input.now !== undefined ? { now: input.now } : {})
    });

  return {
    read: createReadRouteHandlers({
      status,
      sessions: startup.sessions,
      metadata,
      outputReader
    }),
    control: createSessionControlRouteHandlers({
      sessions: startup.sessions,
      metadata,
      tmux,
      ...(input.now !== undefined ? { now: input.now } : {}),
      startOutputReader:
        input.startOutputReader ??
        ((target) => outputReader.drainSession({ sessionId: target.sessionId }).then(() => undefined))
    }),
    write: createWriteRouteHandlers({
      sessions: startup.sessions,
      settings: startup.settings,
      authDevices,
      auditEvents,
      tmux,
      ...(input.now !== undefined ? { now: input.now } : {})
    }),
    security: createSecurityRouteHandlers({
      authDevices,
      pairingCodes,
      settings: startup.settings,
      ...(input.now !== undefined ? { now: input.now } : {})
    }),
    stream: createStreamRouteHandlers({
      sessions: startup.sessions,
      outputReader,
      liveSource: input.liveSource ?? emptyLiveSource()
    })
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, routes: ServiceRouteHandlers): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const segments = pathSegments(url.pathname);

  if (segments === null) {
    writeJson(response, 400, routeError("malformed_request", "Request path is malformed.", "route"));
    return;
  }

  if (matches(segments, "api", "host", "status")) {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
      return;
    }

    writeRouteResult(response, routes.read.hostStatus(readAuth(request)));
    return;
  }

  if (matches(segments, "api", "sessions")) {
    if (method === "GET") {
      writeRouteResult(response, routes.read.listSessions(readAuth(request)));
      return;
    }

    if (method === "POST") {
      const localAdmin = localAdminRequest(request);

      if (!localAdmin) {
        writeJson(response, 403, routeError("permission_denied", "Session start requires a loopback local-admin CLI request.", "authorization"));
        return;
      }

      writeRouteResult(response, await routes.control.startSession({ body: await readJsonBody(request) }));
      return;
    }

    methodNotAllowed(response, "GET", "POST");
    return;
  }

  if (segments.length >= 3 && segments[0] === "api" && segments[1] === "sessions") {
    const sessionId = segments[2];

    if (sessionId === undefined || sessionId.length === 0) {
      writeJson(response, 400, routeError("validation_error", "Session id parameter is malformed.", "session_id"));
      return;
    }

    if (segments.length === 3) {
      if (method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }

      writeRouteResult(response, routes.read.sessionDetail({ ...readAuth(request), params: { session_id: sessionId } }));
      return;
    }

    if (matches(segments, "api", "sessions", sessionId, "output")) {
      if (method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }

      writeRouteResult(
        response,
        routes.read.sessionOutput({
          ...readAuth(request),
          params: { session_id: sessionId },
          query: queryObject(url)
        })
      );
      return;
    }

    if (matches(segments, "api", "sessions", sessionId, "stream")) {
      if (method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }

      await writeStreamResult(
        response,
        routes.stream.sessionStream({
          ...readAuth(request),
          params: { session_id: sessionId },
          query: queryObject(url)
        })
      );
      return;
    }

    if (matches(segments, "api", "sessions", sessionId, "input")) {
      if (method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }

      if (!allowBrowserOrigin(request, response)) {
        return;
      }

      writeRouteResult(
        response,
        await routes.write.promptInput({
          ...writeAuth(request),
          params: { session_id: sessionId },
          body: await readJsonBody(request)
        })
      );
      return;
    }

    if (matches(segments, "api", "sessions", sessionId, "slash")) {
      if (method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }

      if (!allowBrowserOrigin(request, response)) {
        return;
      }

      writeRouteResult(
        response,
        await routes.write.slashCommand({
          ...writeAuth(request),
          params: { session_id: sessionId },
          body: await readJsonBody(request)
        })
      );
      return;
    }

    if (matches(segments, "api", "sessions", sessionId, "stop")) {
      if (method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }

      if (!allowBrowserOrigin(request, response)) {
        return;
      }

      writeRouteResult(
        response,
        await routes.write.stopSession({
          ...writeAuth(request),
          params: { session_id: sessionId },
          body: await readJsonBody(request)
        })
      );
      return;
    }

    if (matches(segments, "api", "sessions", sessionId, "raw-input")) {
      if (method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }

      if (!allowBrowserOrigin(request, response)) {
        return;
      }

      writeRouteResult(
        response,
        await routes.write.rawInput({
          ...writeAuth(request),
          params: { session_id: sessionId },
          body: await readJsonBody(request)
        })
      );
      return;
    }
  }

  if (matches(segments, "api", "pair", "claim")) {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
      return;
    }

    if (!allowBrowserOrigin(request, response)) {
      return;
    }

    writeJsonRouteResult(response, routes.security.claimPairingCode({ body: await readJsonBody(request) }));
    return;
  }

  if (matches(segments, "api", "pair", "status")) {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
      return;
    }

    writeJsonRouteResult(response, routes.security.pairStatus(browserAuth(request)));
    return;
  }

  if (matches(segments, "api", "security", "state")) {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
      return;
    }

    writeJsonRouteResult(response, routes.security.securityState(browserAuth(request)));
    return;
  }

  if (matches(segments, "api", "security", "lock")) {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
      return;
    }

    if (!allowBrowserOrigin(request, response)) {
      return;
    }

    writeJsonRouteResult(response, routes.security.lockFromDashboard({ ...browserAuth(request), body: await readJsonBody(request) }));
    return;
  }

  if (matches(segments, "api", "security", "unlock")) {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
      return;
    }

    writeJsonRouteResult(response, routes.security.unlockFromDashboard());
    return;
  }

  if (matches(segments, "api", "network", "state")) {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
      return;
    }

    writeJsonRouteResult(response, routes.security.networkState());
    return;
  }

  if (matches(segments, "api", "network", "lan")) {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
      return;
    }

    writeJsonRouteResult(response, routes.security.mutateLanFromDashboard());
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
    lan_enabled: settings.lan_enabled,
    stale_session_count: startup.sessions.list().filter((session) => session.lifecycle_state === "stale").length
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;

    if (byteLength > maxJsonBodyBytes) {
      throw new HttpRequestError(413, "malformed_request", "Request body is too large.", "body");
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (raw.length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new HttpRequestError(400, "malformed_request", "Request body must be valid JSON.", "body", error);
  }
}

function readAuth(request: IncomingMessage): ReadAuthInput {
  return browserAuth(request);
}

function writeAuth(request: IncomingMessage): BrowserAuthInput & { readonly localAdmin?: boolean } {
  if (localAdminRequest(request)) {
    return { localAdmin: true };
  }

  return browserAuth(request);
}

function browserAuth(request: IncomingMessage): BrowserAuthInput {
  return {
    rawDeviceToken: cookieValue(request, deviceCookieName),
    rawCsrfToken: headerValue(request, csrfHeaderName)
  };
}

function localAdminRequest(request: IncomingMessage): boolean {
  return isLoopbackAddress(request.socket.remoteAddress ?? null) && !hasBrowserRequestHeaders(request);
}

function allowBrowserOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = headerValue(request, "origin");

  if (origin === null) {
    return true;
  }

  const host = headerValue(request, "host");

  try {
    if (host !== null && new URL(origin).host.toLowerCase() === host.toLowerCase()) {
      return true;
    }
  } catch {
    // Fall through to the typed rejection below.
  }

  writeJson(response, 403, routeError("permission_denied", "Browser write origin does not match the HostDeck service origin.", "origin"));
  return false;
}

function isLoopbackAddress(address: string | null): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasBrowserRequestHeaders(request: IncomingMessage): boolean {
  return headerValue(request, "origin") !== null;
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  const cookie = headerValue(request, "cookie");

  if (cookie === null) {
    return null;
  }

  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");

    if (rawName !== name) {
      continue;
    }

    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return rawValue.join("=");
    }
  }

  return null;
}

function queryObject(url: URL): Readonly<Record<string, unknown>> {
  const query: Record<string, unknown> = {};

  for (const [key, value] of url.searchParams.entries()) {
    query[key] = key === "after" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  }

  return query;
}

function pathSegments(pathname: string): readonly string[] | null {
  try {
    return pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function matches(segments: readonly string[], ...expected: readonly string[]): boolean {
  return segments.length === expected.length && expected.every((segment, index) => segments[index] === segment);
}

function writeRouteResult(response: ServerResponse, result: { readonly status: number; readonly body: unknown }): void {
  writeJson(response, result.status, result.body);
}

function writeJsonRouteResult(response: ServerResponse, result: JsonRouteResult<unknown>): void {
  writeJson(response, result.status, result.body, result.cookies);
}

async function writeStreamResult(
  response: ServerResponse,
  result: ReturnType<StreamRouteHandlers["sessionStream"]>
): Promise<void> {
  if (!("stream" in result)) {
    writeRouteResult(response, result);
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });

  for await (const event of result.stream) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  response.end();
}

function methodNotAllowed(response: ServerResponse, ...allowed: readonly string[]): void {
  writeJson(response, 405, routeError("validation_error", `Route only supports ${allowed.join(" or ")}.`, "method"), undefined, {
    allow: allowed.join(", ")
  });
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  cookies?: readonly HttpCookie[],
  headers: Readonly<Record<string, string>> = {}
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
    ...(cookies !== undefined && cookies.length > 0 ? { "set-cookie": cookies.map(serializeCookie) } : {})
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function serializeCookie(cookie: HttpCookie): string {
  return [
    `${cookie.name}=${encodeURIComponent(cookie.value)}`,
    `Path=${cookie.path}`,
    "HttpOnly",
    `SameSite=${cookie.sameSite === "strict" ? "Strict" : "Lax"}`,
    ...(cookie.secure ? ["Secure"] : []),
    ...(cookie.expiresAt !== null ? [`Expires=${new Date(cookie.expiresAt).toUTCString()}`] : [])
  ].join("; ");
}

function routeError(
  code: ErrorCode,
  message: string,
  field?: string,
  details?: Readonly<Record<string, unknown>>
): ApiRouteErrorBody {
  return {
    error: createErrorEnvelope({
      code,
      message,
      retryable: false,
      ...(field !== undefined ? { field } : {}),
      ...(details !== undefined ? { details: boundedDetails(details) } : {})
    })
  };
}

function baseUrlForStatus(status: HostStatusResponse): URL {
  const host = status.bind.host === "0.0.0.0" ? "127.0.0.1" : status.bind.host;
  return new URL(`http://${host}:${status.bind.port}`);
}

function emptyLiveSource(): SessionStreamLiveSource {
  return {
    subscribe() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined };
            }
          };
        }
      };
    }
  };
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

function errorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      reason: error.message
    };
  }

  return {
    reason: String(error)
  };
}

function boundedDetails(details: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number | boolean | null>> {
  const bounded: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") {
      bounded[key] = value.length > 256 ? `${value.slice(0, 253)}...` : value;
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      bounded[key] = value;
      continue;
    }

    if (typeof value === "boolean" || value === null) {
      bounded[key] = value;
      continue;
    }

    bounded[key] = String(value).slice(0, 256);
  }

  return bounded;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpRequestError";
  }
}

export function listeningPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("HostDeck service does not have a TCP address.");
  }

  return (address as AddressInfo).port;
}
