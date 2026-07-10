import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type ResourceBudget,
  resolveResourceBudget,
  resourceBudgetSchema,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import {
  parseSessionIdFromTmuxSessionName,
  type RealTmuxTargetDiscovery,
  tmuxSessionNameForSession
} from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { HostDeckRoutePluginRegistration } from "./fastify-app.js";
import {
  HostDeckFastifyLifecycleError,
  type HostDeckFastifyRuntimeOwner,
  type HostDeckFastifyRuntimeStartInput,
  type HostDeckFastifyStartedRuntime,
  startHostDeckFastifyLifecycle
} from "./fastify-host-lifecycle.js";
import { createHostDeckSseTransportRegistration } from "./fastify-sse-transport.js";
import { createHostDeckStaticBoundaryRegistration } from "./fastify-static-boundary.js";
import { type HostStartupResult, startHostAgent } from "./startup.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("selected Fastify host lifecycle", () => {
  it("rejects unresolved input and unsupported runtime ownership before listening", async () => {
    let startCalls = 0;
    const base = {
      createRoutePlugins: () => [],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: syntheticOwner(37_771, [], {}, () => undefined, () => {
        startCalls += 1;
      })
    };

    await expect(
      startHostDeckFastifyLifecycle({ ...base, unexpected: true } as unknown as typeof base)
    ).rejects.toThrow("fields are invalid");
    await expect(
      startHostDeckFastifyLifecycle({
        ...base,
        resourceBudget: resourceBudgetSchema.parse({}) as ResourceBudget
      })
    ).rejects.toThrow("Resolved resource budget must be frozen");
    expect(startCalls).toBe(0);

    const invalidCases: readonly [unknown, string][] = [
      [
        {
          bind: { host: "0.0.0.0", port: 37_771, transport: "http" },
          context: {}
        },
        "explicit loopback"
      ],
      [
        {
          bind: { host: "127.0.0.1", port: 37_771, transport: "https" },
          context: {}
        },
        "unsupported before HTTPS selection"
      ],
      [
        {
          bind: { host: "127.0.0.1", port: 0, transport: "http" },
          context: {}
        },
        "integer from 1"
      ],
      [
        {
          bind: { host: "127.0.0.1", port: 37_771, transport: "http" },
          context: {},
          hiddenOwner: true
        },
        "fields are invalid"
      ]
    ];

    for (const [owner, message] of invalidCases) {
      const cleanupEvents: string[] = [];
      const error = await expectLifecycleFailure(
        startHostDeckFastifyLifecycle({
          createRoutePlugins: () => [],
          observeInternalError: () => undefined,
          resourceBudget: defaultResourceBudget,
          runtime: {
            closeSse() {
              cleanupEvents.push("sse");
            },
            closeStartup() {
              cleanupEvents.push("startup");
            },
            start() {
              return owner as HostDeckFastifyStartedRuntime<unknown>;
            }
          }
        })
      );
      expect(error).toMatchObject({ code: "runtime_contract_invalid", stage: "runtime_contract" });
      expect(errorCauseMessages(error)).toContain(message);
      expect(cleanupEvents).toEqual(["sse", "startup"]);
    }

    const startupTimeoutBudget = resolveResourceBudget({
      lifecycle_startup_timeout_ms: 1_500,
      protocol_connect_timeout_ms: 500,
      protocol_handshake_timeout_ms: 1_000
    });
    const timeoutCleanup: string[] = [];
    const timeoutError = await expectLifecycleFailure(
      startHostDeckFastifyLifecycle({
        createRoutePlugins: () => [],
        observeInternalError: () => undefined,
        resourceBudget: startupTimeoutBudget,
        runtime: {
          closeSse() {
            timeoutCleanup.push("sse");
          },
          closeStartup() {
            timeoutCleanup.push("startup");
          },
          start({ deadline }) {
            return new Promise<HostDeckFastifyStartedRuntime<unknown>>((_resolve, reject) => {
              const rejectFromDeadline = () => reject(deadline.signal.reason);
              if (deadline.signal.aborted) {
                rejectFromDeadline();
                return;
              }
              deadline.signal.addEventListener("abort", rejectFromDeadline, { once: true });
            });
          }
        }
      })
    );
    expect(timeoutError).toMatchObject({ code: "startup_timeout", stage: "runtime" });
    expect(timeoutCleanup).toEqual(["sse", "startup"]);
  });

  it("readies before exact loopback bind, applies Node limits, and closes idempotently in order", async () => {
    const port = await getAvailablePort();
    const events: string[] = [];
    const staticBuild = staticBuildFixture();
    let service: Awaited<ReturnType<typeof startHostDeckFastifyLifecycle<{ value: string }>>>;
    service = await startHostDeckFastifyLifecycle({
      createRoutePlugins(context) {
        events.push(`routes:${context.value}`);
        return [
          probeRegistration(events),
          createHostDeckStaticBoundaryRegistration({
            browserRoutes: ["/"],
            buildRoot: staticBuild,
            id: "lifecycle-static"
          })
        ];
      },
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: syntheticOwner(port, events, { value: "selected" }, () => {
        events.push(`sse-state:${service.snapshot().phase}:${service.app.server.listening}`);
      }, (input) => {
        expect(Object.isFrozen(input)).toBe(true);
        expect(input.resourceBudget).toBe(defaultResourceBudget);
        input.deadline.throwIfAborted();
        events.push("runtime");
      })
    });

    expect(events).toEqual(["runtime", "routes:selected", "plugin-register", "app-ready:false"]);
    expect(service.baseUrl.href).toBe(`http://127.0.0.1:${port}/`);
    expect(service.snapshot()).toEqual({
      bound: { host: "127.0.0.1", port, transport: "http" },
      configured: { host: "127.0.0.1", port, transport: "http" },
      listening: true,
      node_limits: {
        connection_idle_timeout_ms: defaultResourceBudget.http_connection_idle_timeout_ms,
        headers_max_bytes: defaultResourceBudget.http_headers_max_bytes,
        headers_max_count: defaultResourceBudget.http_headers_max_count,
        headers_timeout_ms: defaultResourceBudget.http_headers_timeout_ms,
        keep_alive_timeout_ms: defaultResourceBudget.http_keep_alive_timeout_ms,
        max_connections: defaultResourceBudget.http_max_connections,
        max_requests_per_socket: defaultResourceBudget.http_max_requests_per_socket,
        request_receive_timeout_ms: defaultResourceBudget.http_request_receive_timeout_ms
      },
      phase: "ready"
    });
    expect(Object.isFrozen(service.snapshot())).toBe(true);
    expect(Object.isFrozen(service.snapshot().node_limits)).toBe(true);

    const response = await fetch(new URL("/api/lifecycle", service.baseUrl));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const shell = await fetch(service.baseUrl);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("LIFECYCLE_STATIC_SHELL");
    const asset = await fetch(new URL("/assets/app-12345678.js", service.baseUrl));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(
      await rawHeaderStatus(port, defaultResourceBudget.http_headers_max_bytes + 1_024)
    ).toBe(431);

    const firstClose = service.close();
    const secondClose = service.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(events.slice(-4)).toEqual([
      "sse-state:draining:false",
      "close-sse",
      "app-close",
      "close-startup"
    ]);
    expect(service.snapshot()).toMatchObject({
      bound: null,
      listening: false,
      phase: "closed"
    });
    await expect(fetch(new URL("/api/lifecycle", service.baseUrl))).rejects.toThrow();
  });

  it("releases each later owner after route, readiness, listen, close, and timeout failures", async () => {
    const routeEvents: string[] = [];
    const routePort = await getAvailablePort();
    const routeError = await expectLifecycleFailure(
      startHostDeckFastifyLifecycle({
        createRoutePlugins() {
          throw new Error("route-composition-secret");
        },
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        runtime: syntheticOwner(routePort, routeEvents)
      })
    );
    expect(routeError).toMatchObject({ code: "route_composition_failed", stage: "routes" });
    expect(routeEvents).toEqual(["close-sse", "close-startup"]);

    const readyEvents: string[] = [];
    const readyPort = await getAvailablePort();
    const readyError = await expectLifecycleFailure(
      startHostDeckFastifyLifecycle({
        createRoutePlugins: () => [failingRegistration(readyEvents)],
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        runtime: syntheticOwner(readyPort, readyEvents)
      })
    );
    expect(readyError).toMatchObject({ code: "app_ready_failed", stage: "ready" });
    expect(readyEvents).toEqual(["plugin-register", "close-sse", "app-close", "close-startup"]);

    const blocker = await listenOn(0);
    const blockedAddress = requireAddress(blocker);
    const listenEvents: string[] = [];
    try {
      const listenError = await expectLifecycleFailure(
        startHostDeckFastifyLifecycle({
          createRoutePlugins: () => [probeRegistration(listenEvents)],
          observeInternalError: () => undefined,
          resourceBudget: defaultResourceBudget,
          runtime: syntheticOwner(blockedAddress.port, listenEvents)
        })
      );
      expect(listenError).toMatchObject({ code: "listener_bind_failed", stage: "listen" });
      expect(listenEvents).toEqual([
        "plugin-register",
        "app-ready:false",
        "close-sse",
        "app-close",
        "close-startup"
      ]);
    } finally {
      await closeServer(blocker);
    }

    const closeEvents: string[] = [];
    const closePort = await getAvailablePort();
    const closeService = await startHostDeckFastifyLifecycle({
      createRoutePlugins: () => [throwingCloseRegistration(closeEvents)],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: {
        closeSse() {
          closeEvents.push("close-sse");
          throw new Error("sse-close-secret");
        },
        closeStartup() {
          closeEvents.push("close-startup");
          throw new Error("startup-close-secret");
        },
        start() {
          return {
            bind: { host: "127.0.0.1", port: closePort, transport: "http" },
            context: {}
          } as const;
        }
      }
    });
    const rejectedClose = closeService.close();
    expect(closeService.close()).toBe(rejectedClose);
    const closeError = await expectLifecycleFailure(rejectedClose);
    expect(closeError).toMatchObject({ code: "shutdown_failed", stage: "shutdown" });
    expect(closeEvents).toEqual(["close-sse", "app-close", "close-startup"]);
    expect(closeService.snapshot()).toMatchObject({ listening: false, phase: "failed" });

    const timeoutEvents: string[] = [];
    const timeoutBudget = resolveResourceBudget({
      lifecycle_cleanup_step_timeout_ms: 50,
      sse_disconnect_cleanup_timeout_ms: 50,
      sse_shutdown_timeout_ms: 50
    });
    const timeoutPort = await getAvailablePort();
    const timeoutService = await startHostDeckFastifyLifecycle({
      createRoutePlugins: () => [probeRegistration(timeoutEvents)],
      observeInternalError: () => undefined,
      resourceBudget: timeoutBudget,
      runtime: {
        closeSse() {
          timeoutEvents.push("close-sse-pending");
          return new Promise<void>(() => undefined);
        },
        closeStartup() {
          timeoutEvents.push("close-startup");
        },
        start() {
          return {
            bind: { host: "127.0.0.1", port: timeoutPort, transport: "http" },
            context: {}
          } as const;
        }
      }
    });
    const timeoutStarted = Date.now();
    const timeoutError = await expectLifecycleFailure(timeoutService.close());
    expect(timeoutError).toMatchObject({ code: "shutdown_failed", stage: "shutdown" });
    expect(Date.now() - timeoutStarted).toBeLessThan(1_000);
    expect(timeoutEvents.slice(-3)).toEqual(["close-sse-pending", "app-close", "close-startup"]);
  });

  it("releases the real secure startup lease after registration/listen failures and clean restart", async () => {
    const port = await getAvailablePort();
    const paths = secureLocalPaths("hostdeck-fastify-secure-");
    const failedReady = await expectLifecycleFailure(
      startSecureLifecycle(paths, port, [failingRegistration([])])
    );
    expect(failedReady.code).toBe("app_ready_failed");

    const recovered = await startSecureLifecycle(paths, port, [probeRegistration([])]);
    await expect(fetch(new URL("/api/lifecycle", recovered.baseUrl))).resolves.toMatchObject({
      status: 200
    });
    await recovered.close();

    const restarted = await startSecureLifecycle(paths, port, [probeRegistration([])], laterNow);
    await expect(fetch(new URL("/api/lifecycle", restarted.baseUrl))).resolves.toMatchObject({
      status: 200
    });
    await restarted.close();

    const blockedPort = await getAvailablePort();
    const blockedPaths = secureLocalPaths("hostdeck-fastify-blocked-");
    const blocker = await listenOn(blockedPort);
    try {
      const listenFailure = await expectLifecycleFailure(
        startSecureLifecycle(
          blockedPaths,
          blockedPort,
          [probeRegistration([])],
          fixedNow,
          () => undefined
        )
      );
      expect(listenFailure.code).toBe("listener_bind_failed");
    } finally {
      await closeServer(blocker);
    }

    const bindRecovered = await startSecureLifecycle(
      blockedPaths,
      blockedPort,
      [probeRegistration([])],
      laterNow
    );
    await bindRecovered.close();
  });

  it("stops accepting, closes an active finite SSE source, and restarts on the same port", async () => {
    const port = await getAvailablePort();
    const release = deferred<void>();
    const sourceOpened = deferred<void>();
    const clientReceived = deferred<void>();
    const events: string[] = [];
    let service: Awaited<ReturnType<typeof startHostDeckFastifyLifecycle<object>>>;
    const source = {
      async *open() {
        try {
          sourceOpened.resolve();
          yield projectionEvent(1, "active before shutdown");
          await release.promise;
        } finally {
          events.push("source-finally");
        }
      }
    };
    service = await startHostDeckFastifyLifecycle({
      createRoutePlugins: () => [
        createHostDeckSseTransportRegistration({
          id: "lifecycle-sse",
          observeError: () => undefined,
          path: "/api/events",
          source
        }),
        closeProbeRegistration(events)
      ],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: {
        closeSse(deadline) {
          events.push(`close-sse:${service.snapshot().phase}:${service.app.server.listening}`);
          deadline.throwIfAborted();
          release.resolve();
        },
        closeStartup() {
          events.push("close-startup");
        },
        start() {
          return {
            bind: { host: "127.0.0.1", port, transport: "http" },
            context: {}
          } as const;
        }
      }
    });

    const client = openSse(service.baseUrl, clientReceived);
    await sourceOpened.promise;
    await clientReceived.promise;
    const closePromise = service.close();
    await closePromise;
    await client.ended;
    expect(events).toEqual([
      "close-sse:draining:false",
      "source-finally",
      "app-close",
      "close-startup"
    ]);
    expect(service.snapshot()).toMatchObject({ listening: false, phase: "closed" });

    const restarted = await startHostDeckFastifyLifecycle({
      createRoutePlugins: () => [probeRegistration([])],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: syntheticOwner(port, [])
    });
    await restarted.close();
  });
});

function syntheticOwner<TContext>(
  port: number,
  events: string[],
  context: TContext = {} as TContext,
  beforeSseClose: () => void = () => undefined,
  onStart: (input: HostDeckFastifyRuntimeStartInput) => void = () => undefined
): HostDeckFastifyRuntimeOwner<TContext> {
  return {
    closeSse() {
      beforeSseClose();
      events.push("close-sse");
    },
    closeStartup() {
      events.push("close-startup");
    },
    start(input) {
      onStart(input);
      return {
        bind: { host: "127.0.0.1", port, transport: "http" },
        context
      };
    }
  };
}

function probeRegistration(events: string[]): HostDeckRoutePluginRegistration {
  return {
    id: "lifecycle-probe",
    surface: "api",
    register(app) {
      events.push("plugin-register");
      app.addHook("onReady", async () => {
        events.push(`app-ready:${app.server.listening}`);
      });
      app.addHook("onClose", async () => {
        events.push("app-close");
      });
      app.get(
        "/api/lifecycle",
        { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
        async () => ({ ok: true as const })
      );
    }
  };
}

function failingRegistration(events: string[]): HostDeckRoutePluginRegistration {
  return {
    id: "failing-registration",
    surface: "static",
    register(app) {
      events.push("plugin-register");
      app.addHook("onClose", async () => {
        events.push("app-close");
      });
      throw new Error("registration-secret");
    }
  };
}

function throwingCloseRegistration(events: string[]): HostDeckRoutePluginRegistration {
  return {
    id: "throwing-close",
    surface: "static",
    register(app) {
      app.addHook("onClose", async () => {
        events.push("app-close");
        throw new Error("app-close-secret");
      });
    }
  };
}

function closeProbeRegistration(events: string[]): HostDeckRoutePluginRegistration {
  return {
    id: "close-probe",
    surface: "static",
    register(app) {
      app.addHook("onClose", async () => {
        events.push("app-close");
      });
    }
  };
}

interface SecureLocalPaths {
  readonly configDir: string;
  readonly runtimeDir: string;
  readonly stateDir: string;
}

function secureLocalPaths(prefix: string): SecureLocalPaths {
  const root = temporaryDirectory(prefix);
  const runtimeParent = temporaryDirectory(`${prefix}runtime-`);
  return {
    configDir: join(root, "config"),
    runtimeDir: join(runtimeParent, "hostdeck"),
    stateDir: join(root, "state")
  };
}

function startSecureLifecycle(
  paths: SecureLocalPaths,
  port: number,
  routePlugins: readonly HostDeckRoutePluginRegistration[],
  now: () => Date = fixedNow,
  checkNetworkBind?: () => void
) {
  let startup: HostStartupResult | null = null;
  return startHostDeckFastifyLifecycle<HostStartupResult>({
    createRoutePlugins: () => routePlugins,
    observeInternalError: () => undefined,
    resourceBudget: defaultResourceBudget,
    runtime: {
      closeSse: () => undefined,
      closeStartup() {
        const owned = startup;
        startup = null;
        owned?.close();
      },
      async start(input) {
        input.deadline.throwIfAborted();
        startup = await startHostAgent({
          version: "0.0.0-fastify-lifecycle",
          ...paths,
          bindPort: port,
          ...(checkNetworkBind !== undefined ? { checkNetworkBind } : {}),
          discovery: emptyDiscovery(),
          now,
          startOutputReader: () => undefined
        });
        input.deadline.throwIfAborted();
        return {
          bind: {
            host: startup.status.bind.host as "127.0.0.1",
            port: startup.status.bind.port,
            transport: "http" as const
          },
          context: startup
        };
      }
    }
  });
}

function emptyDiscovery(): RealTmuxTargetDiscovery {
  return {
    tmuxSessionNameForSession,
    parseSessionIdFromTmuxSessionName,
    async listTargets() {
      return [];
    },
    async getTargetBySessionId() {
      return null;
    },
    async reconcileTargets() {
      return { liveTargets: [], staleTargets: [], unmanagedTargets: [] };
    }
  };
}

function projectionEvent(cursor: number, text: string) {
  return selectedProjectionEventSchema.parse({
    captured_at: "2026-07-09T08:00:00.000Z",
    codex_event_id: `event-${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_notice: null,
    content_state: "complete",
    cursor,
    item_id: null,
    phase: "delta",
    role: "agent",
    session_id: "sess_lifecycle_sse_01",
    text,
    type: "message",
    upstream_at: null
  });
}

function openSse(baseUrl: URL, received: Deferred<void>): { readonly ended: Promise<void> } {
  let settleEnded!: () => void;
  let rejectEnded!: (cause: unknown) => void;
  const ended = new Promise<void>((resolve, reject) => {
    settleEnded = resolve;
    rejectEnded = reject;
  });
  const request = httpRequest(
    new URL("/api/events", baseUrl),
    { headers: { accept: "text/event-stream" }, method: "GET" },
    (response) => {
      response.once("data", () => received.resolve());
      response.once("end", settleEnded);
      response.once("error", rejectEnded);
      response.resume();
    }
  );
  request.once("error", rejectEnded);
  request.end();
  return { ended };
}

async function rawHeaderStatus(port: number, valueBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { "x-hostdeck-large": "x".repeat(valueBytes) },
        host: "127.0.0.1",
        method: "GET",
        path: "/api/lifecycle",
        port
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.once("error", reject);
    request.end();
  });
}

async function expectLifecycleFailure(
  promise: Promise<unknown>
): Promise<HostDeckFastifyLifecycleError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckFastifyLifecycleError);
    return error as HostDeckFastifyLifecycleError;
  }
  throw new Error("Expected HostDeck Fastify lifecycle failure.");
}

function errorCauseMessages(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = (current as Error & { readonly cause?: unknown }).cause;
  }
  return messages.join(" <- ");
}

async function getAvailablePort(): Promise<number> {
  const server = await listenOn(0);
  const port = requireAddress(server).port;
  await closeServer(server);
  return port;
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ exclusive: true, host: "127.0.0.1", port }, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requireAddress(server: Server) {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an allocated TCP address.");
  }
  return address;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function staticBuildFixture(): string {
  const root = temporaryDirectory("hostdeck-lifecycle-static-");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><p>LIFECYCLE_STATIC_SHELL</p>", {
    mode: 0o600
  });
  writeFileSync(join(root, "assets", "app-12345678.js"), "globalThis.hostDeck = true;\n", {
    mode: 0o600
  });
  return root;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixedNow(): Date {
  return new Date("2026-07-09T08:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-09T08:30:00.000Z");
}
