import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastifySSE } from "@fastify/sse";
import fastifyStatic from "@fastify/static";
import {
  defaultResourceBudget,
  type ResourceBudget,
  resolveResourceBudget,
  resourceBudgetSchema
} from "@hostdeck/contracts";
import { type OperationDeadline, OperationDeadlineDisposedError } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckFastifyApp,
  type HostDeckRoutePluginRegistration,
  hostDeckFastifyResourceSnapshot,
  hostDeckRequestDeadline
} from "./fastify-app.js";
import { HostDeckHttpError, type HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  hostDeckLoopbackTestAuthority,
  hostDeckLoopbackTestOrigin,
  injectHostDeckLoopback
} from "./fastify-loopback-test-request.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { testRequestAuthenticationPolicy } from "./test-request-authentication.js";

const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigin: hostDeckLoopbackTestOrigin
});

describe("side-effect-free HostDeck Fastify app factory", () => {
  it("applies local Zod validation, stable global errors, explicit plugins, and request ids", async () => {
    const observations: HostDeckInternalErrorObservation[] = [];
    const app = createTestApp(
      [
        routePlugin("fixtures", (typedApp, context) => {
          typedApp.post(
            "/echo",
            {
              schema: {
                body: z.strictObject({ value: z.string().trim().min(1).max(32) }),
                response: { 200: z.strictObject({ value: z.string().max(32) }) }
              }
            },
            async (request) => ({ value: request.body.value })
          );
          typedApp.get(
            "/deadline",
            {
              handlerTimeout: 20_000,
              schema: {
                response: {
                  200: z.strictObject({
                    duration_ms: z.number().positive(),
                    same_signal: z.boolean(),
                    remaining_ms: z.number().positive()
                  })
                }
              }
            },
            async (request) => {
              const deadline = hostDeckRequestDeadline(request);
              return {
                duration_ms: deadline.expiresAtMs - deadline.startedAtMs,
                same_signal: deadline.signal === request.signal,
                remaining_ms: deadline.remainingMs()
              };
            }
          );
          typedApp.get(
            "/broken-response",
            { schema: { response: { 200: z.strictObject({ value: z.string() }) } } },
            async () => ({ value: 42 as unknown as string })
          );
          typedApp.get(
            "/throw",
            { schema: { response: { 200: z.strictObject({ unreachable: z.boolean() }) } } },
            async () => {
              throw new Error("super-secret-handler-detail");
            }
          );
          typedApp.get(
            "/conflict",
            { schema: { response: { 200: z.strictObject({ unreachable: z.boolean() }) } } },
            async () => {
              throw new HostDeckHttpError({
                status: 409,
                code: "operation_conflict",
                message: "Operation is already active.",
                details: { reason: "busy" }
              });
            }
          );
          typedApp.get(
            "/get-only",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async () => ({ ok: true as const })
          );
          typedApp.post(
            "/body-boundary",
            {
              schema: {
                body: z.string().max(context.resourceBudget.http_body_max_bytes),
                response: { 200: z.strictObject({ bytes: z.number().int().positive() }) }
              }
            },
            async (request) => ({ bytes: Buffer.byteLength(JSON.stringify(request.body), "utf8") })
          );
        })
      ],
      defaultResourceBudget,
      observations
    );

    expect(app.server.listening).toBe(false);
    expect(app.addresses()).toEqual([]);
    await app.ready();
    expect(app.server.listening).toBe(false);

    try {
      const valid = await injectHostDeckLoopback(app, {
        method: "POST",
        url: "/echo",
        headers: { "content-type": "application/json; charset=UTF-8", "x-request-id": "attacker-selected" },
        payload: { value: "  ok  " }
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ value: "ok" });
      expect(valid.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/u);
      expect(valid.headers["x-request-id"]).not.toBe("attacker-selected");

      const deadline = await injectHostDeckLoopback(app, { method: "GET", url: "/deadline" });
      expect(deadline.statusCode, deadline.body).toBe(200);
      const deadlineBody = deadline.json<{ duration_ms: number; remaining_ms: number; same_signal: boolean }>();
      expect(deadlineBody).toMatchObject({ same_signal: true });
      expect(deadlineBody.duration_ms).toBeCloseTo(20_000, 6);
      expect(deadlineBody.remaining_ms).toBeGreaterThan(0);
      expect(deadlineBody.remaining_ms).toBeLessThanOrEqual(20_000);

      const invalid = await injectHostDeckLoopback(app, {
        method: "POST",
        url: "/echo",
        payload: { value: "", unexpected: "rejected" }
      });
      expectStableError(invalid, 400, "validation_error", "body");

      const malformed = await injectHostDeckLoopback(app, {
        method: "POST",
        url: "/echo",
        headers: { "content-type": "application/json" },
        payload: '{"value":'
      });
      expectStableError(malformed, 400, "malformed_request");

      const unsupported = await injectHostDeckLoopback(app, {
        method: "POST",
        url: "/echo",
        headers: { "content-type": "text/plain" },
        payload: "hello"
      });
      expectStableError(unsupported, 415, "unsupported_media_type");

      const exactBody = JSON.stringify("x".repeat(defaultResourceBudget.http_body_max_bytes - 2));
      expect(Buffer.byteLength(exactBody, "utf8")).toBe(defaultResourceBudget.http_body_max_bytes);
      const exactBodyResponse = await injectHostDeckLoopback(app, {
        method: "POST",
        url: "/body-boundary",
        headers: { "content-type": "application/json" },
        payload: exactBody
      });
      expect(exactBodyResponse.statusCode, exactBodyResponse.body).toBe(200);
      expect(exactBodyResponse.json()).toEqual({ bytes: defaultResourceBudget.http_body_max_bytes });

      const overBody = await injectHostDeckLoopback(app, {
        method: "POST",
        url: "/body-boundary",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify("x".repeat(defaultResourceBudget.http_body_max_bytes - 1))
      });
      expectStableError(overBody, 413, "request_too_large");

      const oversized = await injectHostDeckLoopback(app, {
        method: "POST",
        url: "/echo",
        payload: { value: "x".repeat(defaultResourceBudget.http_body_max_bytes) }
      });
      expectStableError(oversized, 413, "request_too_large");

      const missing = await injectHostDeckLoopback(app, { method: "GET", url: "/missing" });
      expectStableError(missing, 404, "route_not_found");
      expect((await injectHostDeckLoopback(app, { method: "GET", url: "/api/host/status" })).json()).toMatchObject({
        error: { code: "route_not_found" }
      });

      const wrongMethod = await injectHostDeckLoopback(app, { method: "POST", url: "/get-only" });
      expectStableError(wrongMethod, 405, "method_not_allowed");
      expect(wrongMethod.headers.allow).toBe("GET, HEAD");

      const conflict = await injectHostDeckLoopback(app, { method: "GET", url: "/conflict" });
      expectStableError(conflict, 409, "operation_conflict");
      expect(conflict.json()).toMatchObject({ error: { details: { reason: "busy" } } });

      const broken = await injectHostDeckLoopback(app, { method: "GET", url: "/broken-response" });
      expectStableError(broken, 500, "internal_error");
      expect(broken.body).not.toContain("ZodError");
      expect(broken.body).not.toContain("broken-response");

      const thrown = await injectHostDeckLoopback(app, { method: "GET", url: "/throw" });
      expectStableError(thrown, 500, "internal_error");
      expect(thrown.body).not.toContain("super-secret-handler-detail");
      expect(thrown.body).not.toContain("stack");

      expect(observations).toHaveLength(2);
      expect(observations[0]?.error).toBeInstanceOf(z.ZodError);
      expect(observations[1]?.error).toMatchObject({ message: "super-secret-handler-detail" });
      expect(observations.map((observation) => observation.request_id)).toEqual([
        broken.headers["x-request-id"],
        thrown.headers["x-request-id"]
      ]);
      expect(hostDeckFastifyResourceSnapshot(app)).toEqual({
        aborted_requests: 0,
        in_flight_requests: 0,
        max_in_flight_requests: 64,
        rejected_header_count_requests: 0,
        rejected_overload_requests: 0,
        timed_out_requests: 0
      });
    } finally {
      await app.close();
    }
  });

  it("enforces configured URL and parameter bytes through both app and router guards", async () => {
    const budget = resolveResourceBudget({
      http_url_max_bytes: 256,
      http_route_param_max_bytes: 64
    });
    const app = createTestApp(
      [
        routePlugin("bounded-params", (typedApp) => {
          typedApp.get(
            "/items/:id",
            {
              schema: {
                params: z.strictObject({ id: z.string() }),
                response: { 200: z.strictObject({ id: z.string() }) }
              }
            },
            async (request) => ({ id: request.params.id })
          );
        })
      ],
      budget
    );
    await app.ready();

    try {
      expect((await injectHostDeckLoopback(app, `/items/${"a".repeat(64)}`)).statusCode).toBe(200);

      const routerRejected = await injectHostDeckLoopback(app, `/items/${"a".repeat(65)}`);
      expectStableError(routerRejected, 414, "validation_error", "params");
      expect(routerRejected.body).not.toContain("/items/");

      const byteRejected = await injectHostDeckLoopback(app,
        `/items/${encodeURIComponent("x".repeat(48) + "\u00e9".repeat(9))}`
      );
      expectStableError(byteRejected, 414, "validation_error", "params");

      const malformedUrl = await injectHostDeckLoopback(app, "/items/%E0%A4%A");
      expectStableError(malformedUrl, 400, "malformed_request");
      expect(malformedUrl.body).not.toContain("%E0%A4%A");

      const longQuery = await injectHostDeckLoopback(app, `/items/ok?value=${"q".repeat(300)}`);
      expectStableError(longQuery, 414, "malformed_request");

      const longMissing = await injectHostDeckLoopback(app, `/${"m".repeat(300)}`);
      expectStableError(longMissing, 414, "malformed_request");
    } finally {
      await app.close();
    }
  });

  it("holds one in-flight slot until the underlying handler settles", async () => {
    const budget = singleRequestBudget();
    const entered = deferred<void>();
    const release = deferred<void>();
    const responseEntered = deferred<void>();
    const releaseResponse = deferred<void>();
    let deadline: OperationDeadline | undefined;
    let contextBudget: ResourceBudget | undefined;
    const app = createTestApp(
      [
        routePlugin("capacity", (typedApp, context) => {
          contextBudget = context.resourceBudget;
          typedApp.addHook("onSend", async (request, reply, payload) => {
            if (request.url === "/hold" && reply.statusCode === 200) {
              responseEntered.resolve();
              await releaseResponse.promise;
            }
            return payload;
          });
          typedApp.get(
            "/hold",
            { schema: { response: { 200: z.strictObject({ released: z.literal(true) }) } } },
            async (request) => {
              deadline = hostDeckRequestDeadline(request);
              entered.resolve();
              await release.promise;
              return { released: true as const };
            }
          );
        })
      ],
      budget
    );
    await app.ready();

    try {
      expect(contextBudget).toBe(budget);
      const first = injectHostDeckLoopback(app, { method: "GET", url: "/hold" });
      await entered.promise;
      expect(deadline?.signal).toBeDefined();
      expect(hostDeckFastifyResourceSnapshot(app)).toMatchObject({ in_flight_requests: 1 });

      const rejected = await injectHostDeckLoopback(app, { method: "GET", url: "/hold" });
      expectStableError(rejected, 503, "service_overloaded");
      expect(hostDeckFastifyResourceSnapshot(app)).toEqual({
        aborted_requests: 0,
        in_flight_requests: 1,
        max_in_flight_requests: 1,
        rejected_header_count_requests: 0,
        rejected_overload_requests: 1,
        timed_out_requests: 0
      });

      release.resolve();
      await responseEntered.promise;
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(1);
      const responsePhaseRejected = await injectHostDeckLoopback(app, { method: "GET", url: "/hold" });
      expectStableError(responsePhaseRejected, 503, "service_overloaded");
      expect(hostDeckFastifyResourceSnapshot(app).rejected_overload_requests).toBe(2);

      releaseResponse.resolve();
      expect((await first).statusCode).toBe(200);
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
      expect(() => deadline?.remainingMs()).toThrow(OperationDeadlineDisposedError);
    } finally {
      release.resolve();
      releaseResponse.resolve();
      await app.close();
    }
  });

  it("normalizes the real Fastify handler timeout while retaining capacity until cooperative settlement", async () => {
    const budget = boundedRequestTimeoutBudget();
    const settle = deferred<void>();
    const aborted = deferred<void>();
    let deadline: OperationDeadline | undefined;
    const app = createTestApp(
      [
        routePlugin("timeout", (typedApp) => {
          typedApp.get(
            "/timeout",
            { schema: { response: { 200: z.strictObject({ late: z.literal(true) }) } } },
            async (request) => {
              deadline = hostDeckRequestDeadline(request);
              request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
              await aborted.promise;
              await settle.promise;
              return { late: true as const };
            }
          );
        })
      ],
      budget
    );
    await app.ready();

    try {
      const response = await injectHostDeckLoopback(app, { method: "GET", url: "/timeout" });
      expectStableError(response, 504, "operation_timeout");
      expect(deadline?.signal.aborted).toBe(true);
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(1);

      settle.resolve();
      await waitUntil(() => hostDeckFastifyResourceSnapshot(app).in_flight_requests === 0);
      expect(() => deadline?.remainingMs()).toThrow(OperationDeadlineDisposedError);
    } finally {
      settle.resolve();
      await app.close();
    }
  });

  it("keeps managed request signals open after a real POST body completes", async () => {
    const app = createTestApp([
      routePlugin("post-signal", (typedApp) => {
        typedApp.post(
          "/post-signal",
          {
            schema: {
              body: z.strictObject({ value: z.literal("accepted") }),
              response: {
                200: z.strictObject({
                  deadline_signal_aborted: z.boolean(),
                  request_signal_aborted: z.boolean(),
                  same_signal: z.boolean()
                })
              }
            }
          },
          async (request) => {
            const deadline = hostDeckRequestDeadline(request);
            await new Promise((resolve) => setImmediate(resolve));
            return {
              deadline_signal_aborted: deadline.signal.aborted,
              request_signal_aborted: request.signal.aborted,
              same_signal: deadline.signal === request.signal
            };
          }
        );
      })
    ]);

    try {
      await app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
      const address = app.server.address() as AddressInfo;
      const response = await rawHttpPost(address.port, "/post-signal", { value: "accepted" });

      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        deadline_signal_aborted: false,
        request_signal_aborted: false,
        same_signal: true
      });
      expect(hostDeckFastifyResourceSnapshot(app)).toMatchObject({
        aborted_requests: 0,
        in_flight_requests: 0,
        timed_out_requests: 0
      });
    } finally {
      await app.close();
    }
  });

  it("fails composition for unresolved config, duplicate plugins, non-Zod schemas, or raised route ceilings", async () => {
    expect(() =>
      createHostDeckFastifyApp({
        observeInternalError: undefined,
        requestAuthenticationPolicy: testRequestAuthenticationPolicy,
        requestTrustPolicy: loopbackTrustPolicy,
        resourceBudget: defaultResourceBudget,
        routePlugins: []
      } as unknown as Parameters<typeof createHostDeckFastifyApp>[0])
    ).toThrow("HostDeck observeInternalError must be a function.");
    expect(() =>
      createTestApp([], resourceBudgetSchema.parse({}) as ResourceBudget)
    ).toThrow("Resolved resource budget must be frozen.");
    expect(() =>
      createTestApp([routePlugin("duplicate", () => undefined), routePlugin("duplicate", () => undefined)])
    ).toThrow('HostDeck route plugin id "duplicate" is duplicated.');
    expect(() =>
      createTestApp([
        {
          id: "invalid-surface",
          register: () => undefined,
          surface: "worker" as unknown as HostDeckRoutePluginRegistration["surface"]
        }
      ])
    ).toThrow("HostDeck route plugin surface is invalid.");

    const missingApiSchema = createTestApp([
      routePlugin("missing-api-schema", (typedApp) => {
        typedApp.get("/unvalidated", async () => ({ unvalidated: true }));
      })
    ]);
    await expect(missingApiSchema.ready()).rejects.toThrow(
      'HostDeck route plugin "missing-api-schema" failed registration.'
    );
    await missingApiSchema.close();

    const nonZod = createTestApp([
      routePlugin("non-zod", (typedApp) => {
        typedApp.get("/invalid-schema", {
          schema: { response: { 200: { type: "object" } as unknown as z.ZodType } },
          handler: async () => ({ unreachable: true })
        });
      })
    ]);
    await expect(nonZod.ready()).rejects.toThrow('HostDeck route plugin "non-zod" failed registration.');
    await nonZod.close();

    const customErrorOwner = createTestApp([
      routePlugin("custom-error-owner", (typedApp) => {
        typedApp.get("/custom-error", {
          errorHandler: (_error, _request, reply) => reply.code(500).send({ leaked: true }),
          schema: {
            response: {
              200: z.strictObject({ unreachable: z.boolean() }),
              500: z.strictObject({ leaked: z.boolean() })
            }
          },
          handler: async () => ({ unreachable: true })
        });
      })
    ]);
    await expect(customErrorOwner.ready()).rejects.toThrow(
      'HostDeck route plugin "custom-error-owner" failed registration.'
    );
    await customErrorOwner.close();

    const raisedBody = createTestApp([
      routePlugin("raised-body", (typedApp, context) => {
        typedApp.post("/raised", {
          bodyLimit: context.resourceBudget.http_body_max_bytes + 1,
          schema: { response: { 200: z.strictObject({ unreachable: z.boolean() }) } },
          handler: async () => ({ unreachable: true })
        });
      })
    ]);
    await expect(raisedBody.ready()).rejects.toThrow('HostDeck route plugin "raised-body" failed registration.');
    await raisedBody.close();

    const raisedDeadline = createTestApp([
      routePlugin("raised-deadline", (typedApp, context) => {
        typedApp.get("/raised", {
          handlerTimeout: context.resourceBudget.http_request_deadline_ms + 1,
          schema: { response: { 200: z.strictObject({ unreachable: z.boolean() }) } },
          handler: async () => ({ unreachable: true })
        });
      })
    ]);
    await expect(raisedDeadline.ready()).rejects.toThrow(
      'HostDeck route plugin "raised-deadline" failed registration.'
    );
    await raisedDeadline.close();

    const competingDeadline = createTestApp([
      routePlugin("competing-deadline", (typedApp, context) => {
        typedApp.get("/competing", {
          handlerTimeout: context.resourceBudget.http_request_receive_timeout_ms,
          schema: { response: { 200: z.strictObject({ unreachable: z.boolean() }) } },
          handler: async () => ({ unreachable: true })
        });
      })
    ]);
    await expect(competingDeadline.ready()).rejects.toThrow(
      'HostDeck route plugin "competing-deadline" failed registration.'
    );
    await competingDeadline.close();

    const stableError = new HostDeckHttpError({
      status: 409,
      code: "operation_conflict",
      message: "Stable conflict."
    });
    expect(Object.isFrozen(stableError)).toBe(true);
    expect(Object.isFrozen(stableError.envelope)).toBe(true);
    expect(() =>
      new HostDeckHttpError({
        status: 500,
        code: "internal_error",
        message: "Too many details.",
        details: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field_${index}`, index]))
      })
    ).toThrow("HostDeck HTTP error details must leave one of 12 fields for request_id.");
  });

  it("admits the pinned SSE and static plugins through explicit registrations", async () => {
    const assetRoot = mkdtempSync(join(tmpdir(), "hostdeck-fastify-factory-"));
    writeFileSync(join(assetRoot, "probe.txt"), "factory-compatible", { mode: 0o600 });
    const app = createTestApp([
      routePlugin("selected-sse", async (typedApp) => {
        await typedApp.register(fastifySSE, { heartbeatInterval: 15_000 });
        typedApp.get("/events", { sse: "only" }, async (_request, reply) => {
          await reply.sse.send({ id: "probe-1", data: { compatible: true } });
        });
      }, "sse"),
      routePlugin("selected-static", async (typedApp) => {
        await typedApp.register(fastifyStatic, {
          allowedPath: (pathName) => pathName.split("/").every((segment) => !segment.startsWith(".")),
          dotfiles: "deny",
          index: false,
          prefix: "/assets/",
          root: assetRoot,
          serveDotFiles: false
        });
      }, "static")
    ]);

    try {
      await app.ready();
      const asset = await injectHostDeckLoopback(app, { method: "GET", url: "/assets/probe.txt" });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe("factory-compatible");
      expectStableError(await injectHostDeckLoopback(app, { method: "GET", url: "/assets/missing.txt" }), 404, "route_not_found");

      const events = await injectHostDeckLoopback(app, {
        method: "GET",
        url: "/events",
        headers: { accept: "text/event-stream" }
      });
      expect(events.statusCode).toBe(200);
      expect(events.headers["content-type"]).toBe("text/event-stream");
      expect(events.body).toContain("id: probe-1");
      expect(events.body).toContain('data: {"compatible":true}');
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
      rmSync(assetRoot, { force: true, recursive: true });
    }
  });
});

function createTestApp(
  routePlugins: readonly HostDeckRoutePluginRegistration[],
  resourceBudget: ResourceBudget = defaultResourceBudget,
  observations: HostDeckInternalErrorObservation[] = []
) {
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => observations.push(observation),
    requestAuthenticationPolicy: testRequestAuthenticationPolicy,
    requestTrustPolicy: loopbackTrustPolicy,
    resourceBudget,
    routePlugins
  });
}

function routePlugin(
  id: string,
  register: HostDeckRoutePluginRegistration["register"],
  surface: HostDeckRoutePluginRegistration["surface"] = "api"
): HostDeckRoutePluginRegistration {
  return { id, register, surface };
}

function expectStableError(
  response: Awaited<ReturnType<ReturnType<typeof createTestApp>["inject"]>>,
  status: number,
  code: string,
  field?: string
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/u);
  const body = response.json();
  expect(body).toMatchObject({
    error: {
      code,
      retryable: false,
      details: { request_id: response.headers["x-request-id"] },
      ...(field !== undefined ? { field } : {})
    }
  });
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.message.length).toBeLessThanOrEqual(240);
}

function singleRequestBudget(): ResourceBudget {
  return resolveResourceBudget({
    browser_max_in_flight_requests: 1,
    http_max_in_flight_requests: 1,
    mutation_max_in_flight_global: 1,
    mutation_max_in_flight_per_device: 1,
    mutation_max_in_flight_per_target: 1,
    pair_claim_max_in_flight: 1,
    pair_claim_max_in_flight_per_source: 1,
    protocol_max_in_flight_requests: 1
  });
}

function boundedRequestTimeoutBudget(): ResourceBudget {
  return resolveResourceBudget({
    cli_connect_timeout_ms: 500,
    cli_request_timeout_ms: 2_000,
    http_headers_timeout_ms: 1_000,
    http_request_deadline_ms: 2_000,
    http_request_receive_timeout_ms: 1_000,
    protocol_mutation_timeout_ms: 1_000,
    protocol_read_timeout_ms: 1_000,
    protocol_start_timeout_ms: 1_000
  });
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const expiresAt = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= expiresAt) throw new Error("Condition did not settle within one second.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface RawHttpResponse {
  readonly body: string;
  readonly statusCode: number;
}

function rawHttpPost(port: number, path: string, payload: unknown): Promise<RawHttpResponse> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          host: hostDeckLoopbackTestAuthority
        },
        host: "127.0.0.1",
        method: "POST",
        path,
        port
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            statusCode: response.statusCode ?? 0
          });
        });
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}
