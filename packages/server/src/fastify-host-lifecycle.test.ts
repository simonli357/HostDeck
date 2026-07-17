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
  acquireHostDeckDaemonLease,
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPathsAfterLease,
  resolveHostDeckLocalPaths
} from "@hostdeck/storage";
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
import { testRequestAuthenticationPolicy } from "./test-request-authentication.js";

const temporaryDirectories = new Set<string>();
const createRequestAuthenticationPolicy = () => testRequestAuthenticationPolicy;

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
      createRequestAuthenticationPolicy,
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
        createRequestAuthenticationPolicy: undefined as never
      })
    ).rejects.toThrow("createRequestAuthenticationPolicy must be a function");
    await expect(
      startHostDeckFastifyLifecycle({
        ...base,
        resourceBudget: resourceBudgetSchema.parse({}) as ResourceBudget
      })
    ).rejects.toThrow("Resolved resource budget must be frozen");
    expect(startCalls).toBe(0);

    const forgedPolicyCleanup: string[] = [];
    let forgedPolicyRouteCalls = 0;
    const forgedPolicyError = await expectLifecycleFailure(
      startHostDeckFastifyLifecycle({
        createRequestAuthenticationPolicy: () =>
          Object.freeze({
            authenticateDeviceToken:
              testRequestAuthenticationPolicy.authenticateDeviceToken,
            now: testRequestAuthenticationPolicy.now
          }) as typeof testRequestAuthenticationPolicy,
        createRoutePlugins() {
          forgedPolicyRouteCalls += 1;
          return [];
        },
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        runtime: syntheticOwner(37_771, forgedPolicyCleanup)
      })
    );
    expect(forgedPolicyError).toMatchObject({
      code: "route_composition_failed",
      stage: "routes"
    });
    expect(forgedPolicyRouteCalls).toBe(0);
    expect(forgedPolicyCleanup).toEqual([
      "begin-drain",
      "close-sse",
      "close-runtime",
      "close-startup"
    ]);

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
        "explicit private LAN address"
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
          createRequestAuthenticationPolicy,
          createRoutePlugins: () => [],
          observeInternalError: () => undefined,
          resourceBudget: defaultResourceBudget,
          runtime: {
            beginDrain() {
              cleanupEvents.push("drain");
            },
            closeRuntime() {
              cleanupEvents.push("runtime");
            },
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
      expect(cleanupEvents).toEqual(["drain", "sse", "runtime", "startup"]);
    }

    const startupTimeoutBudget = resolveResourceBudget({
      lifecycle_startup_timeout_ms: 1_500,
      protocol_connect_timeout_ms: 500,
      protocol_handshake_timeout_ms: 1_000
    });
    const timeoutCleanup: string[] = [];
    const timeoutError = await expectLifecycleFailure(
      startHostDeckFastifyLifecycle({
        createRequestAuthenticationPolicy,
        createRoutePlugins: () => [],
        observeInternalError: () => undefined,
        resourceBudget: startupTimeoutBudget,
        runtime: {
          beginDrain() {
            timeoutCleanup.push("drain");
          },
          closeRuntime() {
            timeoutCleanup.push("runtime");
          },
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
    expect(timeoutCleanup).toEqual(["drain", "sse", "runtime", "startup"]);
  });

  it("readies before exact loopback bind, applies Node limits, and closes idempotently in order", async () => {
    const port = await getAvailablePort();
    const events: string[] = [];
    const staticBuild = staticBuildFixture();
    let service: Awaited<ReturnType<typeof startHostDeckFastifyLifecycle<{ value: string }>>>;
    service = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy(context) {
        events.push(`auth:${context.value}`);
        return testRequestAuthenticationPolicy;
      },
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

    expect(events).toEqual([
      "runtime",
      "auth:selected",
      "routes:selected",
      "plugin-register",
      "app-ready:false"
    ]);
    expect(service.baseUrl.href).toBe(`http://127.0.0.1:${port}/`);
    expect(service.snapshot()).toEqual({
      bound: { host: "127.0.0.1", port, transport: "http" },
      configured: { host: "127.0.0.1", port, transport: "http" },
      connections: {
        active_connections: 0,
        dropped_connections: 0,
        dropped_requests: 0,
        forced_shutdown_connections: 0
      },
      listening: true,
      node_limits: {
        connections_check_interval_ms: 1_000,
        connection_idle_timeout_ms: defaultResourceBudget.http_connection_idle_timeout_ms,
        headers_max_bytes: defaultResourceBudget.http_headers_max_bytes,
        headers_max_count: defaultResourceBudget.http_headers_max_count,
        headers_parser_max_bytes: defaultResourceBudget.http_headers_max_bytes + 1,
        headers_parser_max_count: defaultResourceBudget.http_headers_max_count + 1,
        headers_timeout_ms: defaultResourceBudget.http_headers_timeout_ms,
        keep_alive_timeout_buffer_ms: 0,
        keep_alive_timeout_ms: defaultResourceBudget.http_keep_alive_timeout_ms,
        max_connections: defaultResourceBudget.http_max_connections,
        max_requests_per_socket: defaultResourceBudget.http_max_requests_per_socket,
        request_receive_timeout_ms: defaultResourceBudget.http_request_receive_timeout_ms
      },
      phase: "ready"
    });
    expect(Object.isFrozen(service.snapshot())).toBe(true);
    expect(Object.isFrozen(service.snapshot().connections)).toBe(true);
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
    expect(events.slice(-6)).toEqual([
      "begin-drain",
      "sse-state:draining:false",
      "close-sse",
      "close-runtime",
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
        createRequestAuthenticationPolicy,
        createRoutePlugins() {
          throw new Error("route-composition-secret");
        },
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        runtime: syntheticOwner(routePort, routeEvents)
      })
    );
    expect(routeError).toMatchObject({ code: "route_composition_failed", stage: "routes" });
    expect(routeEvents).toEqual([
      "begin-drain",
      "close-sse",
      "close-runtime",
      "close-startup"
    ]);

    const readyEvents: string[] = [];
    const readyPort = await getAvailablePort();
    const readyError = await expectLifecycleFailure(
      startHostDeckFastifyLifecycle({
        createRequestAuthenticationPolicy,
        createRoutePlugins: () => [failingRegistration(readyEvents)],
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        runtime: syntheticOwner(readyPort, readyEvents)
      })
    );
    expect(readyError).toMatchObject({ code: "app_ready_failed", stage: "ready" });
    expect(readyEvents).toEqual([
      "plugin-register",
      "begin-drain",
      "close-sse",
      "close-runtime",
      "app-close",
      "close-startup"
    ]);

    const blocker = await listenOn(0);
    const blockedAddress = requireAddress(blocker);
    const listenEvents: string[] = [];
    try {
      const listenError = await expectLifecycleFailure(
        startHostDeckFastifyLifecycle({
          createRequestAuthenticationPolicy,
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
        "begin-drain",
        "close-sse",
        "close-runtime",
        "app-close",
        "close-startup"
      ]);
    } finally {
      await closeServer(blocker);
    }

    const closeEvents: string[] = [];
    const closePort = await getAvailablePort();
    const closeService = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy,
      createRoutePlugins: () => [throwingCloseRegistration(closeEvents)],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: {
        beginDrain() {
          closeEvents.push("begin-drain");
          throw new Error("drain-close-secret");
        },
        closeRuntime() {
          closeEvents.push("close-runtime");
          throw new Error("runtime-close-secret");
        },
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
    expect(closeError.cause).toBeInstanceOf(AggregateError);
    expect(
      (closeError.cause as AggregateError).errors.map(
        (error: { readonly step?: unknown }) => error.step
      )
    ).toEqual(["drain", "sse", "runtime", "app", "startup"]);
    expect(closeEvents).toEqual([
      "begin-drain",
      "close-sse",
      "close-runtime",
      "app-close",
      "close-startup"
    ]);
    expect(closeService.snapshot()).toMatchObject({ listening: false, phase: "failed" });

    const asyncDrainEvents: string[] = [];
    const asyncDrainPort = await getAvailablePort();
    const asyncDrainOwner = {
      beginDrain() {
        asyncDrainEvents.push("begin-drain");
        return Promise.reject(new Error("private async drain rejection"));
      },
      closeRuntime() {
        asyncDrainEvents.push("close-runtime");
      },
      closeSse() {
        asyncDrainEvents.push("close-sse");
      },
      closeStartup() {
        asyncDrainEvents.push("close-startup");
      },
      start() {
        return {
          bind: {
            host: "127.0.0.1",
            port: asyncDrainPort,
            transport: "http"
          },
          context: {}
        } as const;
      }
    } as unknown as HostDeckFastifyRuntimeOwner<object>;
    const asyncDrainService = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy,
      createRoutePlugins: () => [closeProbeRegistration(asyncDrainEvents)],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: asyncDrainOwner
    });
    const asyncDrainError = await expectLifecycleFailure(
      asyncDrainService.close()
    );
    expect(asyncDrainError).toMatchObject({
      code: "shutdown_failed",
      stage: "shutdown"
    });
    expect(asyncDrainEvents).toEqual([
      "begin-drain",
      "close-sse",
      "close-runtime",
      "app-close",
      "close-startup"
    ]);
    expect(asyncDrainService.snapshot()).toMatchObject({
      listening: false,
      phase: "failed"
    });

    const timeoutEvents: string[] = [];
    const timeoutBudget = resolveResourceBudget({
      lifecycle_cleanup_step_timeout_ms: 50,
      sse_disconnect_cleanup_timeout_ms: 50,
      sse_shutdown_timeout_ms: 50
    });
    const timeoutPort = await getAvailablePort();
    const timeoutService = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy,
      createRoutePlugins: () => [probeRegistration(timeoutEvents)],
      observeInternalError: () => undefined,
      resourceBudget: timeoutBudget,
      runtime: {
        beginDrain() {
          timeoutEvents.push("begin-drain");
        },
        closeRuntime() {
          timeoutEvents.push("close-runtime");
        },
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
    expect(timeoutEvents.slice(-5)).toEqual([
      "begin-drain",
      "close-sse-pending",
      "close-runtime",
      "app-close",
      "close-startup"
    ]);
  });

  it("releases the real secure startup lease after registration/listen failures and clean restart", async () => {
    const port = await getAvailablePort();
    const paths = secureLocalPaths("hostdeck-fastify-secure-");
    const failedReady = await expectLifecycleFailure(
      startSecureLifecycle(paths, port, [failingRegistration([])])
    );
    expect(failedReady.code).toBe("app_ready_failed");

    const recovered = await startSecureLifecycle(paths, port, [probeRegistration([])]);
    await expect(
      fetch(new URL("/api/lifecycle", recovered.baseUrl), { headers: { connection: "close" } })
    ).resolves.toMatchObject({
      status: 200
    });
    await recovered.close();

    const restarted = await startSecureLifecycle(paths, port, [probeRegistration([])], laterNow);
    await expect(
      fetch(new URL("/api/lifecycle", restarted.baseUrl), { headers: { connection: "close" } })
    ).resolves.toMatchObject({
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
          fixedNow
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

  it("closes admission before refusal and runtime before an active request settles", async () => {
    const port = await getAvailablePort();
    const entered = deferred<void>();
    const release = deferred<void>();
    const events: string[] = [];
    let requestSettled = false;
    let runtimeBudgetMs = 0;
    let startupBudgetMs = 0;
    let service: Awaited<ReturnType<typeof startHostDeckFastifyLifecycle<object>>>;
    service = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy,
      createRoutePlugins: () => [
        blockingRequestRegistration(entered, release, events, () => {
          requestSettled = true;
        }),
        closeProbeRegistration(events)
      ],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: {
        beginDrain() {
          events.push(
            `begin-drain:${service.snapshot().phase}:${service.app.server.listening}`
          );
        },
        closeRuntime(deadline) {
          runtimeBudgetMs = deadline.remainingMs();
          events.push(
            `close-runtime:${service.app.server.listening}:${requestSettled}`
          );
          release.resolve();
        },
        closeSse() {
          events.push("close-sse");
        },
        closeStartup(deadline) {
          startupBudgetMs = deadline.remainingMs();
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

    const response = fetch(new URL("/api/blocking", service.baseUrl));
    await entered.promise;
    const closing = service.close();
    expect(service.snapshot()).toMatchObject({ phase: "draining", listening: false });
    await expect(fetch(new URL("/api/lifecycle", service.baseUrl))).rejects.toThrow();
    await expect(response).resolves.toMatchObject({ status: 200 });
    await closing;

    expect(runtimeBudgetMs).toBeGreaterThan(
      defaultResourceBudget.lifecycle_cleanup_step_timeout_ms
    );
    expect(startupBudgetMs).toBeGreaterThan(
      defaultResourceBudget.lifecycle_cleanup_step_timeout_ms
    );
    expect(events).toEqual([
      "request-entered",
      "begin-drain:draining:true",
      "close-sse",
      "close-runtime:false:false",
      "request-settled",
      "app-close",
      "close-startup"
    ]);
    expect(service.snapshot()).toMatchObject({
      connections: { active_connections: 0, forced_shutdown_connections: 0 },
      listening: false,
      phase: "closed"
    });
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
      createRequestAuthenticationPolicy,
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
        beginDrain() {
          events.push(
            `begin-drain:${service.snapshot().phase}:${service.app.server.listening}`
          );
        },
        closeRuntime() {
          events.push("close-runtime");
        },
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
      "begin-drain:draining:true",
      "close-sse:draining:false",
      "source-finally",
      "close-runtime",
      "app-close",
      "close-startup"
    ]);
    expect(service.snapshot()).toMatchObject({ listening: false, phase: "closed" });

    const restarted = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy,
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
    beginDrain() {
      events.push("begin-drain");
    },
    closeRuntime() {
      events.push("close-runtime");
    },
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

function blockingRequestRegistration(
  entered: Deferred<void>,
  release: Deferred<void>,
  events: string[],
  settle: () => void
): HostDeckRoutePluginRegistration {
  return {
    id: "blocking-request",
    surface: "api",
    register(app) {
      app.get(
        "/api/blocking",
        { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
        async () => {
          events.push("request-entered");
          entered.resolve();
          await release.promise;
          settle();
          events.push("request-settled");
          return { ok: true as const };
        }
      );
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
  now: () => Date = fixedNow
) {
  let startup: { readonly close: () => void } | null = null;
  return startHostDeckFastifyLifecycle<{ readonly close: () => void }>({
    createRequestAuthenticationPolicy,
    createRoutePlugins: () => routePlugins,
    observeInternalError: () => undefined,
    resourceBudget: defaultResourceBudget,
    runtime: {
      beginDrain() {},
      closeRuntime() {},
      closeSse: () => undefined,
      closeStartup() {
        const owned = startup;
        startup = null;
        owned?.close();
      },
      async start(input) {
        input.deadline.throwIfAborted();
        const resolved = resolveHostDeckLocalPaths({
          config_dir: paths.configDir,
          state_dir: paths.stateDir,
          runtime_dir: paths.runtimeDir,
          database_path: join(paths.stateDir, "hostdeck.sqlite")
        });
        prepareHostDeckDaemonLeasePath(resolved);
        const lease = acquireHostDeckDaemonLease({ lease_path: resolved.lease_path, now });
        try {
          prepareHostDeckLocalPathsAfterLease(resolved);
          input.deadline.throwIfAborted();
          startup = Object.freeze({ close: () => lease.release() });
          return {
            bind: {
              host: "127.0.0.1",
              port,
              transport: "http" as const
            },
            context: startup
          };
        } catch (error) {
          lease.release();
          throw error;
        }
      }
    }
  });
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
