import { createHash } from "node:crypto";
import {
  defaultResourceBudget,
  type SelectedRequestAuthenticationIngressContext,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import {
  assertHostDeckRequestAuthenticationIngressPolicy,
  createHostDeckRequestAuthenticationIngressPolicy,
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  hostDeckRequestAuthenticationIngressContext,
  hostDeckRequestAuthenticationSnapshot,
  requireHostDeckRequestAuthentication,
  requireHostDeckRequestWritePermission,
  resolveHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import {
  createTailscaleServeProxyTrustPolicy,
  type TailscaleServeRemoteAdmissionSnapshot,
  tailscaleServeProxyTrustSnapshot
} from "./tailscale-serve-proxy-trust.js";

const localOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-fixture.fixture-tailnet.ts.net";
const sourceAddress = "100.100.101.102";
const sourceKey = `sha256:${createHash("sha256")
  .update(`hostdeck:tailscale-serve-source:v1\0ipv4\0${sourceAddress}`, "ascii")
  .digest("hex")}`;
const rawDeviceToken = "D".repeat(43);
const now = new Date("2026-07-13T20:00:00.000Z");
const openApps: HostDeckFastifyInstance[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
});

describe("Tailscale Serve request authorization composition", () => {
  it("brands immutable authentication-ingress adapters from exact data inputs", () => {
    const assertCurrent = () => undefined;
    const resolve = () => ({
      configured_origin: localOrigin,
      network_mode: "loopback",
      origin_kind: "safe_no_origin",
      transport: "http",
      source_key: null,
      remote_generation: null
    });
    const input = { assertCurrent, resolve };
    const policy = createHostDeckRequestAuthenticationIngressPolicy(input);
    input.resolve = () => {
      throw new Error("mutated ingress resolver must not run");
    };
    expect(policy).toMatchObject({ assertCurrent, resolve });
    expect(Object.keys(policy).sort()).toEqual(["assertCurrent", "resolve"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => assertHostDeckRequestAuthenticationIngressPolicy(policy)).not.toThrow();
    expect(() =>
      assertHostDeckRequestAuthenticationIngressPolicy(
        Object.freeze({ assertCurrent, resolve })
      )
    ).toThrow("must be created by createHostDeckRequestAuthenticationIngressPolicy");

    let accessorCalls = 0;
    const accessor = Object.defineProperty({ resolve }, "assertCurrent", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("ingress-policy-accessor-private-sentinel");
      }
    });
    for (const candidate of [
      null,
      {},
      { assertCurrent, resolve, extra: true },
      Object.assign(Object.create({ inherited: true }), { assertCurrent, resolve }),
      { assertCurrent: null, resolve },
      { assertCurrent, resolve: null },
      accessor
    ]) {
      expect(() =>
        createHostDeckRequestAuthenticationIngressPolicy(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("keeps local admin separate and ignores optional tailnet identity for remote authority", async () => {
    let admissionReads = 0;
    let authenticationCalls = 0;
    const ingress: SelectedRequestAuthenticationIngressContext[] = [];
    const app = createSelectedApp({
      ingress,
      readAdmission() {
        admissionReads += 1;
        return openAdmission(7);
      },
      authenticateDeviceToken({ rawDeviceToken: candidate }) {
        authenticationCalls += 1;
        if (candidate !== rawDeviceToken) throw new Error("unexpected token");
        return authenticatedDevice("read");
      }
    });
    await app.ready();

    const local = await app.inject({
      headers: { host: new URL(localOrigin).host },
      method: "POST",
      url: "/admin"
    });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json()).toMatchObject({
      state: "local_admin",
      network_mode: "loopback",
      transport: "http",
      permission: "local_admin"
    });
    expect(admissionReads).toBe(0);

    const localSignaledRead = await app.inject({
      headers: {
        host: new URL(localOrigin).host,
        [hostDeckLocalAdminRequestHeaderName]:
          hostDeckLocalAdminRequestHeaderValue
      },
      method: "GET",
      url: "/admin-read"
    });
    expect(localSignaledRead.statusCode, localSignaledRead.body).toBe(200);
    expect(localSignaledRead.json()).toMatchObject({
      state: "local_admin",
      network_mode: "loopback",
      origin_kind: "local_non_browser",
      transport: "http",
      permission: "local_admin"
    });
    expect(admissionReads).toBe(0);

    const unpaired = await app.inject({
      headers: remoteHeaders(),
      method: "GET",
      url: "/optional"
    });
    expect(unpaired.statusCode, unpaired.body).toBe(200);
    expect(unpaired.json()).toEqual({
      state: "unpaired",
      configured_origin: externalOrigin,
      network_mode: "remote",
      origin_kind: "safe_no_origin",
      transport: "https",
      device_id: null,
      permission: null,
      csrf_generation: null,
      last_used_at: null,
      expires_at: null
    });
    expect(unpaired.body).not.toMatch(/source_key|remote_generation|tailnet_identity/iu);
    expect(ingress.at(-1)).toEqual({
      configured_origin: externalOrigin,
      network_mode: "remote",
      origin_kind: "safe_no_origin",
      transport: "https",
      source_key: sourceKey,
      remote_generation: 7
    });

    const identityUnpaired = await app.inject({
      headers: remoteHeaders({ identity: true }),
      method: "GET",
      url: "/optional"
    });
    expect(identityUnpaired.statusCode, identityUnpaired.body).toBe(200);
    expect(identityUnpaired.json()).toEqual(unpaired.json());
    expect(authenticationCalls).toBe(0);

    const protectedWithoutCookie = await app.inject({
      headers: remoteHeaders(),
      method: "GET",
      url: "/protected"
    });
    expect(protectedWithoutCookie.statusCode).toBe(401);
    expect(protectedWithoutCookie.body).not.toContain(sourceAddress);

    const protectedWithIdentity = await app.inject({
      headers: remoteHeaders({ cookie: rawDeviceToken, identity: true }),
      method: "GET",
      url: "/protected"
    });
    expect(protectedWithIdentity.statusCode, protectedWithIdentity.body).toBe(200);
    expect(protectedWithIdentity.json()).toMatchObject({
      state: "paired_device",
      network_mode: "remote",
      permission: "read",
      transport: "https"
    });
    expect(authenticationCalls).toBe(1);

    const remoteAdmin = await app.inject({
      headers: remoteHeaders({ origin: true }),
      method: "POST",
      url: "/admin"
    });
    expect(remoteAdmin.statusCode).toBe(403);
    expect(remoteAdmin.json()).toMatchObject({ error: { code: "permission_denied" } });

    const lookalike = await app.inject({
      headers: {
        ...remoteHeaders(),
        "x-tailscale-user-login": "untrusted@example.test"
      },
      method: "GET",
      url: "/optional"
    });
    expect(lookalike.statusCode).toBe(403);
    expect(lookalike.headers.connection).toBe("close");
    expect(lookalike.body).not.toContain("untrusted@example.test");

    const missingSourceHeaders = remoteHeaders();
    delete missingSourceHeaders["x-forwarded-for"];
    const missingSource = await app.inject({
      headers: missingSourceHeaders,
      method: "GET",
      url: "/optional"
    });
    expect(missingSource.statusCode).toBe(403);
    expect(authenticationCalls).toBe(1);

    const authSnapshot = hostDeckRequestAuthenticationSnapshot(app);
    expect(authSnapshot.ingress_rejections).toBe(0);
    expect(JSON.stringify(authSnapshot)).not.toMatch(
      /source_key|remote_generation|tailnet_identity/iu
    );
    expect(tailscaleServeProxyTrustSnapshot(app)).toMatchObject({
      stale_remote_context_rejections: 0,
      rejected_requests: {
        missing_forwarding_header: 1,
        untrusted_tailscale_lookalike: 1
      }
    });
  });

  it("rejects when admission changes between proxy admission and auth installation", async () => {
    let reads = 0;
    let authenticationCalls = 0;
    let handlerCalls = 0;
    const app = createSelectedApp({
      readAdmission() {
        reads += 1;
        return reads <= 2
          ? openAdmission(31)
          : Object.freeze({
              admission: "closed" as const,
              external_origin: null,
              generation: 32
            });
      },
      authenticateDeviceToken() {
        authenticationCalls += 1;
        return authenticatedDevice("read");
      },
      handlerCall() {
        handlerCalls += 1;
      }
    });
    await app.ready();

    const response = await app.inject({
      headers: remoteHeaders({ cookie: rawDeviceToken }),
      method: "GET",
      url: "/protected"
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.headers.connection).toBe("close");
    expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    expect(authenticationCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(hostDeckRequestAuthenticationSnapshot(app).ingress_rejections).toBe(1);
    expect(tailscaleServeProxyTrustSnapshot(app)).toMatchObject({
      accepted_remote_requests: 1,
      stale_remote_context_rejections: 1
    });
  });

  it("maps throwing, malformed, and split current-admission reads to one generic rejection", async () => {
    for (const failure of ["throw", "malformed", "split"] as const) {
      let reads = 0;
      let authenticationCalls = 0;
      const app = createSelectedApp({
        readAdmission() {
          reads += 1;
          if (reads <= 2) return openAdmission(41);
          if (failure === "throw") throw new Error("private admission failure");
          if (failure === "malformed") {
            return { admission: "open", external_origin: externalOrigin };
          }
          return reads === 3 ? openAdmission(41) : openAdmission(42);
        },
        authenticateDeviceToken() {
          authenticationCalls += 1;
          return authenticatedDevice("read");
        }
      });
      await app.ready();
      const response = await app.inject({
        headers: remoteHeaders({ cookie: rawDeviceToken }),
        method: "GET",
        url: "/protected"
      });
      expect(response.statusCode, `${failure}: ${response.body}`).toBe(403);
      expect(response.headers.connection).toBe("close");
      expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
      expect(response.body).not.toMatch(/private admission|fixture-tailnet/iu);
      expect(authenticationCalls).toBe(0);
      expect(hostDeckRequestAuthenticationSnapshot(app).ingress_rejections).toBe(1);
      expect(
        tailscaleServeProxyTrustSnapshot(app).stale_remote_context_rejections
      ).toBe(1);
    }
  });

  it("rejects a generation change during device authentication before handler access", async () => {
    let admission = openAdmission(11);
    let authenticationCalls = 0;
    let handlerCalls = 0;
    const app = createSelectedApp({
      handlerCall() {
        handlerCalls += 1;
      },
      readAdmission: () => admission,
      authenticateDeviceToken() {
        authenticationCalls += 1;
        admission = openAdmission(12);
        return authenticatedDevice("read");
      }
    });
    await app.ready();

    const response = await app.inject({
      headers: remoteHeaders({ cookie: rawDeviceToken }),
      method: "GET",
      url: "/protected"
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.headers.connection).toBe("close");
    expect(response.json()).toMatchObject({
      error: { code: "invalid_origin", retryable: false }
    });
    expect(authenticationCalls).toBe(1);
    expect(handlerCalls).toBe(0);
    expect(response.body).not.toMatch(
      /source_key|remote_generation|tailnet_identity|fixture-tailnet/iu
    );
    expect(hostDeckRequestAuthenticationSnapshot(app).ingress_rejections).toBe(1);
    expect(tailscaleServeProxyTrustSnapshot(app).stale_remote_context_rejections).toBe(
      1
    );
  });

  it("withholds a successful body when generation changes after authorization", async () => {
    let admission = openAdmission(21);
    let handlerCalls = 0;
    const app = createSelectedApp({
      readAdmission: () => admission,
      authenticateDeviceToken: () => authenticatedDevice("read"),
      handlerCall(path) {
        handlerCalls += 1;
        if (path === "/change-before-send") admission = openAdmission(22);
      }
    });
    await app.ready();

    const response = await app.inject({
      headers: remoteHeaders({ cookie: rawDeviceToken }),
      method: "GET",
      url: "/change-before-send"
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.headers.connection).toBe("close");
    expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    expect(response.body).not.toContain("paired_device");
    expect(handlerCalls).toBe(1);
    expect(hostDeckRequestAuthenticationSnapshot(app).ingress_rejections).toBe(1);
    expect(tailscaleServeProxyTrustSnapshot(app).stale_remote_context_rejections).toBe(
      1
    );
  });

  it("keeps selected factory inputs exclusive from historical trust and TLS fields", () => {
    const common = {
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => authenticatedDevice("read"),
        now: () => new Date(now)
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [],
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin,
        readRemoteAdmission: () => openAdmission(1)
      })
    };
    expect(() =>
      createHostDeckTailscaleServeFastifyApp({
        ...common,
        requestTrustPolicy: "historical"
      } as never)
    ).toThrow("input fields are invalid");
    expect(() =>
      createHostDeckTailscaleServeFastifyApp({ ...common, tls: {} } as never)
    ).toThrow("input fields are invalid");
    expect(() =>
      createHostDeckTailscaleServeFastifyApp({
        ...common,
        tailscaleServeProxyTrustPolicy: Object.freeze({
          ...common.tailscaleServeProxyTrustPolicy
        })
      } as never)
    ).toThrow("must be created by createTailscaleServeProxyTrustPolicy");

    let accessorCalls = 0;
    const accessor = Object.defineProperty(
      { ...common },
      "tailscaleServeProxyTrustPolicy",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("selected-factory-accessor-private-sentinel");
        }
      }
    );
    const inherited = Object.assign(Object.create({ inherited: true }), common);
    const symbolKeyed = { ...common, [Symbol("private")]: true };
    for (const candidate of [accessor, inherited, symbolKeyed]) {
      expect(() =>
        createHostDeckTailscaleServeFastifyApp(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });
});

interface SelectedAppOptions {
  readonly authenticateDeviceToken: (input: {
    readonly rawDeviceToken: string;
    readonly now: Date;
  }) => unknown;
  readonly handlerCall?: (path: string) => void;
  readonly ingress?: SelectedRequestAuthenticationIngressContext[];
  readonly readAdmission: () => unknown;
}

function createSelectedApp(options: SelectedAppOptions): HostDeckFastifyInstance {
  const app = createHostDeckTailscaleServeFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: options.authenticateDeviceToken,
      now: () => new Date(now)
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [authorizationRoutes(options)],
    tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
      localOrigin,
      readRemoteAdmission: options.readAdmission
    })
  });
  openApps.push(app);
  return app;
}

function authorizationRoutes(
  options: SelectedAppOptions
): HostDeckRoutePluginRegistration {
  return {
    id: "tailscale-serve-request-authorization-fixture",
    surface: "api",
    register(app) {
      app.get(
        "/optional",
        {
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => {
          options.ingress?.push(hostDeckRequestAuthenticationIngressContext(request));
          options.handlerCall?.("/optional");
          return resolveHostDeckRequestAuthentication(request);
        }
      );
      for (const path of ["/protected", "/change-before-send"] as const) {
        app.get(
          path,
          {
            async preHandler(request) {
              requireHostDeckRequestAuthentication(request, "device_cookie");
            },
            schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
          },
          async (request) => {
            options.handlerCall?.(path);
            return resolveHostDeckRequestAuthentication(request);
          }
        );
      }
      app.post(
        "/admin",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "local_admin");
          },
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => resolveHostDeckRequestAuthentication(request)
      );
      app.get(
        "/admin-read",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "local_admin");
          },
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => resolveHostDeckRequestAuthentication(request)
      );
      app.post(
        "/write",
        {
          async preHandler(request) {
            requireHostDeckRequestWritePermission(
              requireHostDeckRequestAuthentication(request, "device_cookie")
            );
          },
          schema: {
            response: { 200: z.strictObject({ ok: z.literal(true) }) }
          }
        },
        async () => ({ ok: true as const })
      );
    }
  };
}

function remoteHeaders(
  options: {
    readonly cookie?: string;
    readonly identity?: boolean;
    readonly origin?: boolean;
  } = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    host: new URL(externalOrigin).host,
    "x-forwarded-for": sourceAddress,
    "x-forwarded-host": new URL(externalOrigin).host,
    "x-forwarded-proto": "https"
  };
  if (options.origin) headers.origin = externalOrigin;
  if (options.cookie !== undefined) {
    headers.cookie = `${hostDeckDeviceCookieName}=${options.cookie}`;
  }
  if (options.identity) {
    headers["tailscale-headers-info"] = "https://tailscale.com/s/serve-headers";
    headers["tailscale-user-login"] = "fixture@example.test";
    headers["tailscale-user-name"] = "Fixture User";
    headers["tailscale-user-profile-pic"] = "https://example.test/avatar";
  }
  return headers;
}

function openAdmission(generation: number): TailscaleServeRemoteAdmissionSnapshot {
  return Object.freeze({
    admission: "open",
    external_origin: externalOrigin,
    generation
  });
}

function authenticatedDevice(permission: "read" | "write") {
  return {
    trusted: true as const,
    readOnly: permission === "read",
    device: {
      id: `client_remote_${permission}`,
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: now.toISOString(),
      client_label: "Remote phone",
      permission,
      created_at: now.toISOString(),
      last_used_at: new Date(now.getTime() + 1).toISOString(),
      expires_at: null,
      revoked_at: null
    }
  };
}
