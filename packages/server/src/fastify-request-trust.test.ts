import { createConnection, createServer } from "node:net";
import { defaultResourceBudget } from "@hostdeck/contracts";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckFastifyApp,
  type HostDeckRoutePluginRegistration,
  hostDeckFastifyResourceSnapshot
} from "./fastify-app.js";
import type { HostDeckInternalErrorObservation, HostDeckInternalErrorObserver } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestTrustPolicy,
  type CreateHostDeckRequestTrustPolicyInput,
  createHostDeckRequestTrustPolicy,
  deriveHostDeckPairClaimSourceKey,
  evaluateHostDeckRequestTrust,
  HostDeckRequestTrustError,
  type HostDeckRequestTrustPolicy,
  type HostDeckRequestTrustProbe,
  hostDeckPairClaimSourceKey,
  hostDeckRequestTrustContext,
  hostDeckRequestTrustSnapshot
} from "./fastify-request-trust.js";
import { testRequestAuthenticationPolicy } from "./test-request-authentication.js";

const loopbackOrigin = "http://localhost";
const loopbackPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: [loopbackOrigin],
  mode: "loopback",
  transport: "http"
});
const contextSchema = z.strictObject({
  authority: z.string(),
  configured_origin: z.string().url(),
  network_mode: z.enum(["loopback", "lan"]),
  origin_kind: z.enum(["same_origin", "safe_no_origin", "local_non_browser"]),
  transport: z.enum(["http", "https"])
});

describe("Fastify request trust policy", () => {
  it("creates one copied deeply frozen exact policy and rejects unsafe configuration", () => {
    const origins = [loopbackOrigin];
    const policy = createHostDeckRequestTrustPolicy({ allowedOrigins: origins, mode: "loopback", transport: "http" });
    origins[0] = "http://evil.test";

    expect(policy).toEqual({ allowedOrigins: [loopbackOrigin], mode: "loopback", transport: "http" });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedOrigins)).toBe(true);
    expect(() => assertHostDeckRequestTrustPolicy(policy)).not.toThrow();
    expect(() =>
      assertHostDeckRequestTrustPolicy(
        Object.freeze({ allowedOrigins: Object.freeze([loopbackOrigin]), mode: "loopback", transport: "http" })
      )
    ).toThrow("must be created by createHostDeckRequestTrustPolicy");

    const lan = createHostDeckRequestTrustPolicy({
      allowedOrigins: ["https://192.168.0.29:8443", "https://hostdeck.example:8443"],
      mode: "lan",
      transport: "https"
    });
    expect(lan.allowedOrigins).toEqual(["https://192.168.0.29:8443", "https://hostdeck.example:8443"]);

    const invalid: unknown[] = [
      null,
      {},
      { allowedOrigins: [loopbackOrigin], mode: "loopback", transport: "http", unexpected: true },
      { allowedOrigins: [], mode: "loopback", transport: "http" },
      { allowedOrigins: Array.from({ length: 9 }, (_, index) => `http://127.0.0.${index + 1}:8080`), mode: "loopback", transport: "http" },
      { allowedOrigins: [loopbackOrigin], mode: "remote", transport: "http" },
      { allowedOrigins: ["http://192.168.0.29:8443"], mode: "lan", transport: "http" },
      { allowedOrigins: ["https://localhost:8443"], mode: "lan", transport: "https" },
      { allowedOrigins: ["http://example.test"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://localhost/"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["HTTP://localhost"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://user@localhost"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://localhost/path"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://localhost?query=1"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://localhost#fragment"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://*.localhost"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://localhost:80"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["http://localhost:0"], mode: "loopback", transport: "http" },
      { allowedOrigins: [loopbackOrigin, loopbackOrigin], mode: "loopback", transport: "http" },
      { allowedOrigins: [`http://${"a".repeat(520)}`], mode: "loopback", transport: "http" },
      { allowedOrigins: [`https://${"a".repeat(254)}:8443`], mode: "lan", transport: "https" },
      { allowedOrigins: ["http://localh\u00f6st"], mode: "loopback", transport: "http" },
      { allowedOrigins: ["https://192.168.0.29:8443"], mode: "lan", transport: "http" },
      { allowedOrigins: ["https://0.0.0.0:8443"], mode: "lan", transport: "https" }
    ];
    for (const candidate of invalid) expect(() => parsePolicy(candidate)).toThrow();
  });

  it("evaluates same-origin, safe no-origin, local non-browser, and LAN HTTPS contexts headlessly", () => {
    const sameOrigin = evaluateHostDeckRequestTrust(loopbackPolicy, probe({
      method: "POST",
      rawHeaders: ["Host", "localhost", "Origin", loopbackOrigin]
    }));
    expect(sameOrigin).toEqual({
      authority: "localhost",
      configured_origin: loopbackOrigin,
      network_mode: "loopback",
      origin_kind: "same_origin",
      transport: "http"
    });
    expect(Object.isFrozen(sameOrigin)).toBe(true);
    expect(Object.keys(sameOrigin).sort()).toEqual([
      "authority",
      "configured_origin",
      "network_mode",
      "origin_kind",
      "transport"
    ]);

    expect(evaluateHostDeckRequestTrust(loopbackPolicy, probe()).origin_kind).toBe("safe_no_origin");
    expect(evaluateHostDeckRequestTrust(loopbackPolicy, probe({ method: "POST" })).origin_kind).toBe("local_non_browser");
    expect(evaluateHostDeckRequestTrust(loopbackPolicy, probe({ rawHeaders: ["Host", "localhost:80"] })).authority).toBe("localhost");

    const lanPolicy = createHostDeckRequestTrustPolicy({
      allowedOrigins: ["https://192.168.0.29:8443"],
      mode: "lan",
      transport: "https"
    });
    expect(evaluateHostDeckRequestTrust(lanPolicy, probe({
      rawHeaders: ["Host", "192.168.0.29:8443", "Origin", "https://192.168.0.29:8443"],
      remoteAddress: "192.168.0.59",
      secure: true
    }))).toEqual({
      authority: "192.168.0.29:8443",
      configured_origin: "https://192.168.0.29:8443",
      network_mode: "lan",
      origin_kind: "same_origin",
      transport: "https"
    });
    expect(evaluateHostDeckRequestTrust(lanPolicy, probe({
      rawHeaders: ["Host", "192.168.0.29:8443"],
      remoteAddress: "192.168.0.59",
      secure: true
    })).origin_kind).toBe("safe_no_origin");
  });

  it("derives one canonical domain-separated pair-claim source from admitted socket addresses", () => {
    const ipv4 = deriveHostDeckPairClaimSourceKey("127.0.0.1");
    expect(ipv4).toBe("sha256:d7cfc2cf0f158c30d50ca26c1e99a4cb15d692907d12fb69e2a18f93ea6e1adb");
    expect(deriveHostDeckPairClaimSourceKey("::ffff:127.0.0.1")).toBe(ipv4);
    expect(deriveHostDeckPairClaimSourceKey("0:0:0:0:0:0:0:1")).toBe(
      deriveHostDeckPairClaimSourceKey("::1")
    );
    expect(deriveHostDeckPairClaimSourceKey("192.168.0.59")).not.toBe(ipv4);
    expect(ipv4).toMatch(/^sha256:[a-f0-9]{64}$/u);

    for (const candidate of [undefined, null, "", "not-an-ip", "127.0.0.1:80", "fe80::1%eth0", "0.0.0.0", "::"]) {
      expectTrustError(() => deriveHostDeckPairClaimSourceKey(candidate), "invalid_origin");
    }
  });

  it("rejects spoofed transport, non-loopback peers, and ambiguous request-target forms", () => {
    const lanPolicy = createHostDeckRequestTrustPolicy({
      allowedOrigins: ["https://192.168.0.29:8443"],
      mode: "lan",
      transport: "https"
    });
    expectTrustError(
      () => evaluateHostDeckRequestTrust(lanPolicy, probe({ rawHeaders: ["Host", "192.168.0.29:8443"], remoteAddress: "192.168.0.59" })),
      "insecure_transport"
    );
    expectTrustError(() => evaluateHostDeckRequestTrust(loopbackPolicy, probe({ remoteAddress: "192.168.0.59" })), "invalid_origin");

    for (const requestTarget of [
      "http://localhost/probe",
      "localhost:80",
      "*",
      "//evil.test/probe",
      "/%2fevil.test/probe",
      "/probe%5cchild",
      "/probe%00child",
      "/probe#fragment",
      "/probe\\child"
    ]) {
      expectTrustError(() => evaluateHostDeckRequestTrust(loopbackPolicy, probe({ requestTarget })), "invalid_origin");
    }

    for (const [name, value] of [
      ["Forwarded", "for=192.168.0.59;proto=https"],
      ["X-Forwarded-Host", "localhost"],
      ["X-Forwarded-Proto", "https"],
      ["X-Forwarded-For", "127.0.0.1"],
      ["X-Real-IP", "127.0.0.1"],
      ["X-Original-Host", "localhost"]
    ] as const) {
      expectTrustError(
        () => evaluateHostDeckRequestTrust(loopbackPolicy, probe({ rawHeaders: ["Host", "localhost", name, value] })),
        "invalid_origin"
      );
    }

    for (const invalidProbe of [
      null,
      {},
      { ...probe(), method: 42 },
      { ...probe(), rawHeaders: ["Host"] },
      { ...probe(), rawHeaders: ["Host", 42] },
      { ...probe(), remoteAddress: "" },
      { ...probe(), requestTarget: 42 },
      { ...probe(), secure: "yes" },
      { ...probe(), unexpected: true }
    ]) {
      expectTrustError(
        () => evaluateHostDeckRequestTrust(loopbackPolicy, invalidProbe as HostDeckRequestTrustProbe),
        "invalid_origin"
      );
    }
  });

  it("requires one exact canonical configured Host and rejects DNS-rebinding forms", () => {
    const invalidHeaders: readonly (readonly string[])[] = [
      [],
      ["Host", ""],
      ["Host", "localhost", "Host", "localhost"],
      ["Host", "evil.test"],
      ["Host", "localhost.evil.test"],
      ["Host", "localhost."],
      ["Host", "localhost:81"],
      ["Host", "LOCALHOST"],
      ["Host", "user@localhost"],
      ["Host", "localhost/path"],
      ["Host", "localhost, evil.test"],
      ["Host", "2130706433"],
      ["Host", "127.1"],
      ["Host", "local host"]
    ];
    for (const rawHeaders of invalidHeaders) {
      expectTrustError(() => evaluateHostDeckRequestTrust(loopbackPolicy, probe({ rawHeaders })), "invalid_origin");
    }

    const ipv6Policy = createHostDeckRequestTrustPolicy({
      allowedOrigins: ["http://[::1]:8787"],
      mode: "loopback",
      transport: "http"
    });
    expect(evaluateHostDeckRequestTrust(ipv6Policy, probe({
      rawHeaders: ["Host", "[::1]:8787"],
      remoteAddress: "::1"
    })).authority).toBe("[::1]:8787");
  });

  it("requires exact canonical Origin and rejects browser-like missing Origin and all preflight", () => {
    for (const origin of [
      "null",
      "https://evil.test",
      "http://localhost/",
      "HTTP://localhost",
      "http://user@localhost",
      "http://localhost/path",
      "http://localhost?query=1",
      "http://localhost#fragment",
      "http://localhost:80"
    ]) {
      expectTrustError(
        () => evaluateHostDeckRequestTrust(loopbackPolicy, probe({ rawHeaders: ["Host", "localhost", "Origin", origin] })),
        "invalid_origin"
      );
    }
    expectTrustError(
      () => evaluateHostDeckRequestTrust(loopbackPolicy, probe({ rawHeaders: ["Host", "localhost", "Origin", loopbackOrigin, "Origin", loopbackOrigin] })),
      "invalid_origin"
    );
    expectTrustError(
      () => evaluateHostDeckRequestTrust(loopbackPolicy, probe({
        method: "POST",
        rawHeaders: ["Host", "localhost", "Sec-Fetch-Site", "same-origin"]
      })),
      "invalid_origin"
    );
    expectTrustError(
      () => evaluateHostDeckRequestTrust(loopbackPolicy, probe({
        method: "OPTIONS",
        rawHeaders: ["Host", "localhost", "Origin", loopbackOrigin, "Access-Control-Request-Method", "POST"]
      })),
      "forbidden_cors"
    );
  });
});

describe("Fastify request trust gate", () => {
  it("makes the parsed policy mandatory and exposes only frozen admitted context", async () => {
    expect(() =>
      createHostDeckFastifyApp({
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        routePlugins: []
      } as unknown as Parameters<typeof createHostDeckFastifyApp>[0])
    ).toThrow("input fields are invalid");
    expect(() =>
      createHostDeckFastifyApp({
        observeInternalError: () => undefined,
        requestAuthenticationPolicy: testRequestAuthenticationPolicy,
        requestTrustPolicy: Object.freeze({
          allowedOrigins: Object.freeze([loopbackOrigin]),
          mode: "loopback",
          transport: "http"
        }) as HostDeckRequestTrustPolicy,
        resourceBudget: defaultResourceBudget,
        routePlugins: []
      })
    ).toThrow("must be created by createHostDeckRequestTrustPolicy");
    expect(() => hostDeckRequestTrustContext({} as FastifyRequest)).toThrow("unavailable before trust admission");
    expect(() => hostDeckPairClaimSourceKey({} as FastifyRequest)).toThrow("unavailable before trust admission");

    const app = createTrustApp([
      routePlugin("context", (scope) => {
        scope.get("/context", { schema: { response: { 200: contextSchema } } }, async (request) => hostDeckRequestTrustContext(request));
        scope.post("/context", { schema: { response: { 200: contextSchema } } }, async (request) => hostDeckRequestTrustContext(request));
        scope.get(
          "/source",
          { schema: { response: { 200: z.strictObject({ source_key: z.string() }) } } },
          async (request) => ({ source_key: hostDeckPairClaimSourceKey(request) })
        );
      })
    ]);
    await app.ready();
    try {
      const safe = await app.inject({ method: "GET", url: "/context" });
      expect(safe.statusCode, safe.body).toBe(200);
      expect(safe.json()).toMatchObject({ origin_kind: "safe_no_origin" });

      const sameOrigin = await app.inject({ method: "POST", url: "/context", headers: { origin: loopbackOrigin } });
      expect(sameOrigin.statusCode, sameOrigin.body).toBe(200);
      expect(sameOrigin.json()).toMatchObject({ origin_kind: "same_origin" });

      const local = await app.inject({ method: "POST", url: "/context" });
      expect(local.statusCode, local.body).toBe(200);
      expect(local.json()).toEqual({
        authority: "localhost",
        configured_origin: loopbackOrigin,
        network_mode: "loopback",
        origin_kind: "local_non_browser",
        transport: "http"
      });
      const source = await app.inject({ method: "GET", url: "/source" });
      expect(source.statusCode, source.body).toBe(200);
      expect(source.json()).toEqual({
        source_key: "sha256:d7cfc2cf0f158c30d50ca26c1e99a4cb15d692907d12fb69e2a18f93ea6e1adb"
      });
      expect(hostDeckRequestTrustSnapshot(app)).toEqual({
        accepted_requests: 4,
        rejected_forbidden_cors: 0,
        rejected_insecure_transport_requests: 0,
        rejected_invalid_origin_requests: 0
      });
    } finally {
      await app.close();
    }
  });

  it("rejects hostile trust inputs before handlers with bounded non-reflective errors and exact counters", async () => {
    let handlerCalls = 0;
    const app = createTrustApp([
      routePlugin("protected", (scope) => {
        scope.post(
          "/protected",
          { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
          async () => {
            handlerCalls += 1;
            return { ok: true as const };
          }
        );
      })
    ]);
    await app.ready();
    try {
      const cases = [
        await app.inject({ method: "POST", url: "/protected", headers: { host: "attacker-host.test" } }),
        await app.inject({ method: "POST", url: "/protected", headers: { origin: "https://attacker-origin.test" } }),
        await app.inject({ method: "POST", url: "/protected", headers: { "sec-fetch-site": "cross-site" } }),
        await app.inject({ method: "POST", url: "/protected", headers: { "x-forwarded-proto": "https" } })
      ];
      for (const response of cases) {
        expectTrustResponse(response, 403, "invalid_origin");
        expect(response.body).not.toMatch(/attacker|cross-site|x-forwarded/iu);
      }

      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/protected",
        headers: { "access-control-request-method": "POST", origin: loopbackOrigin }
      });
      expectTrustResponse(preflight, 403, "invalid_origin");
      expect(handlerCalls).toBe(0);
      expect(hostDeckRequestTrustSnapshot(app)).toEqual({
        accepted_requests: 0,
        rejected_forbidden_cors: 1,
        rejected_insecure_transport_requests: 0,
        rejected_invalid_origin_requests: 4
      });
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("returns stable 426 and increments only the transport counter for plaintext LAN admission", async () => {
    let handlerCalls = 0;
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: testRequestAuthenticationPolicy,
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigins: ["https://192.168.0.29:8443"],
        mode: "lan",
        transport: "https"
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        routePlugin("lan-transport", (scope) => {
          scope.get(
            "/lan",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async () => {
              handlerCalls += 1;
              return { ok: true as const };
            }
          );
        })
      ]
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/lan", headers: { host: "192.168.0.29:8443" } });
      expectTrustResponse(response, 426, "insecure_transport");
      expect(handlerCalls).toBe(0);
      expect(hostDeckRequestTrustSnapshot(app)).toEqual({
        accepted_requests: 0,
        rejected_forbidden_cors: 0,
        rejected_insecure_transport_requests: 1,
        rejected_invalid_origin_requests: 0
      });
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("removes and fails route-added CORS response headers through the internal-error path", async () => {
    const observations: HostDeckInternalErrorObservation[] = [];
    const app = createTrustApp(
      [
        routePlugin("cors-violation", (scope) => {
          scope.addHook("onSend", async (request, reply, payload) => {
            if (request.url === "/cors-hook-violation") reply.header("access-control-allow-origin", "*");
            return payload;
          });
          scope.get(
            "/cors-violation",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async (_request, reply) => {
              reply.header("access-control-allow-origin", "*");
              reply.header("access-control-allow-credentials", "true");
              reply.header("timing-allow-origin", "*");
              return { ok: true as const };
            }
          );
          scope.get(
            "/cors-hook-violation",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async () => ({ ok: true as const })
          );
          scope.get(
            "/cors-raw-violation",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async (_request, reply) => {
              reply.raw.setHeader("access-control-allow-origin", "*");
              return { ok: true as const };
            }
          );
          scope.get(
            "/cors-write-head-violation",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async (_request, reply) => {
              reply.hijack();
              reply.raw.writeHead(200, {
                "access-control-allow-origin": "*",
                "content-type": "text/plain"
              });
              reply.raw.end("sensitive-success-body");
              return reply;
            }
          );
          scope.get(
            "/cors-write-head-array-violation",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async (_request, reply) => {
              reply.hijack();
              (reply.raw.writeHead as unknown as (status: number, headers: readonly unknown[]) => unknown)(200, [
                "access-control-allow-origin",
                "*",
                "content-length",
                22
              ]);
              reply.raw.end("array-sensitive-success");
              return reply;
            }
          );
        })
      ],
      observations
    );
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/cors-violation" });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(response.headers["timing-allow-origin"]).toBeUndefined();

      for (const path of [
        "/cors-hook-violation",
        "/cors-raw-violation",
        "/cors-write-head-violation",
        "/cors-write-head-array-violation"
      ]) {
        const violation = await app.inject({ method: "GET", url: path });
        expect(violation.statusCode, violation.body).toBe(500);
        expect(violation.json()).toMatchObject({ error: { code: "internal_error" } });
        expect(violation.headers["access-control-allow-origin"]).toBeUndefined();
        expect(violation.body).not.toMatch(/sensitive-success|array-sensitive/iu);
      }
      expect(observations).toHaveLength(5);
      for (const observation of observations) {
        expect(observation.error).toMatchObject({ message: "HostDeck routes cannot emit CORS response headers." });
      }
      expect(hostDeckRequestTrustSnapshot(app)).toMatchObject({ accepted_requests: 5, rejected_forbidden_cors: 5 });
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("keeps the CORS failure bounded when the internal observer throws or rejects", async () => {
    const observers: HostDeckInternalErrorObserver[] = [
      () => {
        throw new Error("observer-sync-secret");
      },
      (() => Promise.reject(new Error("observer-async-secret"))) as unknown as HostDeckInternalErrorObserver
    ];
    for (const observeInternalError of observers) {
      const app = createHostDeckFastifyApp({
        observeInternalError,
        requestAuthenticationPolicy: testRequestAuthenticationPolicy,
        requestTrustPolicy: loopbackPolicy,
        resourceBudget: defaultResourceBudget,
        routePlugins: [
          routePlugin("observer-cors", (scope) => {
            scope.get(
              "/observer-cors",
              { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
              async (_request, reply) => {
                reply.header("access-control-allow-origin", "*");
                return { ok: true as const };
              }
            );
          })
        ]
      });
      await app.ready();
      try {
        const response = await app.inject({ method: "GET", url: "/observer-cors" });
        expect(response.statusCode, response.body).toBe(500);
        expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(response.body).not.toMatch(/observer|secret/iu);
      } finally {
        await app.close();
      }
    }
  });

  it("gates API, SSE, and static route surfaces at the root before any fixture side effect", async () => {
    const calls = { api: 0, sse: 0, static: 0 };
    const plugins = (Object.keys(calls) as Array<keyof typeof calls>).map((surface) =>
      routePlugin(
        `${surface}-surface`,
        (scope) => {
          scope.get(
            `/${surface}`,
            { schema: { response: { 200: z.strictObject({ surface: z.literal(surface) }) } } },
            async () => {
              calls[surface] += 1;
              return { surface };
            }
          );
        },
        surface
      )
    );
    const app = createTrustApp(plugins);
    await app.ready();
    try {
      for (const surface of Object.keys(calls) as Array<keyof typeof calls>) {
        expectTrustResponse(
          await app.inject({ method: "GET", url: `/${surface}`, headers: { origin: "https://foreign.test" } }),
          403,
          "invalid_origin"
        );
      }
      expect(calls).toEqual({ api: 0, sse: 0, static: 0 });
      expect((await app.inject({ method: "GET", url: "/api", headers: { origin: loopbackOrigin } })).statusCode).toBe(200);
      expect(calls).toEqual({ api: 1, sse: 0, static: 0 });
    } finally {
      await app.close();
    }
  });

  it("proves raw-listener Host, Origin, forwarding, target-form, and parser boundaries", async () => {
    const port = await getAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    let handlerCalls = 0;
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: testRequestAuthenticationPolicy,
      requestTrustPolicy: createHostDeckRequestTrustPolicy({ allowedOrigins: [origin], mode: "loopback", transport: "http" }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        routePlugin("raw-probe", (scope) => {
          scope.get(
            "/probe",
            { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
            async () => {
              handlerCalls += 1;
              return { ok: true as const };
            }
          );
        })
      ]
    });
    await app.listen({ host: "127.0.0.1", port });
    const host = `127.0.0.1:${port}`;
    try {
      const valid = await rawExchange(port, `GET /probe HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      expect(statusCode(valid)).toBe(200);
      expect(handlerCalls).toBe(1);

      const hookRejected = [
        `GET /probe HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://foreign-origin.test\r\nConnection: close\r\n\r\n`,
        `GET /probe HTTP/1.1\r\nHost: ${host}\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`,
        `GET http://${host}/probe HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        `GET //foreign-target.test/probe HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
      ];
      for (const request of hookRejected) {
        const response = await rawExchange(port, request);
        expect(statusCode(response)).toBe(403);
        expect(response).toContain('"code":"invalid_origin"');
        expect(response).not.toMatch(/foreign-origin|foreign-target|x-forwarded/iu);
        expect(response.toLowerCase()).not.toContain("access-control-allow-");
      }

      const missingHost = await rawExchange(port, "GET /probe HTTP/1.1\r\nConnection: close\r\n\r\n");
      expect(statusCode(missingHost)).toBe(400);
      expect(missingHost).not.toContain('"code":"invalid_origin"');

      const duplicateHost = await rawExchange(
        port,
        `GET /probe HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(duplicateHost)).toBe(403);
      expect(duplicateHost).toContain('"code":"invalid_origin"');
      expect(handlerCalls).toBe(1);
      expect(hostDeckRequestTrustSnapshot(app)).toMatchObject({
        accepted_requests: 1,
        rejected_invalid_origin_requests: 5
      });
    } finally {
      await app.close();
    }
  });
});

function parsePolicy(input: unknown): HostDeckRequestTrustPolicy {
  return createHostDeckRequestTrustPolicy(input as CreateHostDeckRequestTrustPolicyInput);
}

function probe(overrides: Partial<HostDeckRequestTrustProbe> = {}): HostDeckRequestTrustProbe {
  return {
    method: "GET",
    rawHeaders: ["Host", "localhost"],
    remoteAddress: "127.0.0.1",
    requestTarget: "/probe",
    secure: false,
    ...overrides
  };
}

function expectTrustError(fn: () => unknown, kind: HostDeckRequestTrustError["kind"]): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckRequestTrustError);
  expect((caught as HostDeckRequestTrustError).kind).toBe(kind);
  expect(JSON.stringify(caught)).not.toMatch(/localhost|192\.168|evil|forwarded/iu);
}

function createTrustApp(
  routePlugins: readonly HostDeckRoutePluginRegistration[],
  observations: HostDeckInternalErrorObservation[] = []
) {
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => observations.push(observation),
    requestAuthenticationPolicy: testRequestAuthenticationPolicy,
    requestTrustPolicy: loopbackPolicy,
    resourceBudget: defaultResourceBudget,
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

function expectTrustResponse(
  response: Awaited<ReturnType<ReturnType<typeof createTrustApp>["inject"]>>,
  status: number,
  code: string
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  expect(response.json()).toMatchObject({
    error: {
      code,
      retryable: false,
      details: { request_id: response.headers["x-request-id"] }
    }
  });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve raw trust probe port."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let output = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw trust probe timed out."));
    }, 2_000);
    timeout.unref();
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 32_768) {
        socket.destroy();
        reject(new Error("Raw trust probe response exceeded its bound."));
      }
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(output);
    });
    socket.once("connect", () => socket.write(payload));
  });
}

function statusCode(transcript: string): number {
  const match = /HTTP\/1\.1 (\d{3})/u.exec(transcript);
  if (match?.[1] === undefined) throw new Error("Raw trust probe response has no HTTP status.");
  return Number(match[1]);
}
