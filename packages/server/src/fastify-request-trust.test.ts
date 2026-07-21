import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  assertHostDeckRequestTrustPolicy,
  createHostDeckRequestTrustPolicy,
  deriveHostDeckPairClaimSourceKey,
  evaluateHostDeckRequestTrust,
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue,
  hostDeckRequestTrustContext,
  hostDeckRequestTrustSnapshot,
  installHostDeckRequestTrustGate
} from "./fastify-request-trust.js";

const origin = "http://127.0.0.1:3777";
const policy = createHostDeckRequestTrustPolicy({ allowedOrigin: origin });

describe("selected loopback request trust policy", () => {
  it("creates one exact frozen IPv4 loopback HTTP policy", () => {
    expect(policy).toEqual({ allowedOrigin: origin });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => assertHostDeckRequestTrustPolicy(policy)).not.toThrow();
    expect(() =>
      assertHostDeckRequestTrustPolicy(
        Object.freeze({ allowedOrigin: origin })
      )
    ).toThrow(TypeError);

    let accessorReads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "allowedOrigin", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return origin;
      }
    });
    for (const candidate of [
      null,
      {},
      { allowedOrigin: origin, extra: true },
      { allowedOrigin: [origin] },
      { allowedOrigin: "https://127.0.0.1:3777" },
      { allowedOrigin: "http://localhost:3777" },
      { allowedOrigin: "http://[::1]:3777" },
      { allowedOrigin: "http://127.0.0.2:3777" },
      { allowedOrigin: "http://192.168.0.29:3777" },
      { allowedOrigin: "http://0.0.0.0:3777" },
      { allowedOrigin: "http://127.0.0.1" },
      { allowedOrigin: "http://127.0.0.1:80" },
      { allowedOrigin: "http://127.0.0.1:0" },
      { allowedOrigin: "http://user@127.0.0.1:3777" },
      { allowedOrigin: "http://127.0.0.1:3777/path" },
      { allowedOrigin: "http://127.0.0.1:3777?query=1" },
      { allowedOrigin: "http://127.0.0.1:3777#fragment" },
      accessor
    ]) {
      expect(() =>
        createHostDeckRequestTrustPolicy(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorReads).toBe(0);
  });

  it("admits only exact loopback HTTP authority and canonical browser provenance", () => {
    expect(evaluateHostDeckRequestTrust(policy, probe())).toEqual({
      authority: "127.0.0.1:3777",
      configured_origin: origin,
      network_mode: "loopback",
      origin_kind: "safe_no_origin",
      transport: "http"
    });
    expect(
      evaluateHostDeckRequestTrust(
        policy,
        probe({ method: "POST", rawHeaders: ["host", "127.0.0.1:3777", "origin", origin] })
      ).origin_kind
    ).toBe("same_origin");
    expect(
      evaluateHostDeckRequestTrust(
        policy,
        probe({ method: "POST" })
      ).origin_kind
    ).toBe("local_non_browser");

    for (const candidate of [
      probe({ secure: true }),
      probe({ remoteAddress: "192.168.0.29" }),
      probe({ remoteAddress: undefined }),
      probe({ rawHeaders: ["host", "localhost:3777"] }),
      probe({ rawHeaders: ["host", "127.0.0.1:3778"] }),
      probe({ rawHeaders: ["host", "127.0.0.1:3777", "host", "127.0.0.1:3777"] }),
      probe({ rawHeaders: ["host", "127.0.0.1:3777", "origin", "http://127.0.0.1:3778"] }),
      probe({ rawHeaders: ["host", "127.0.0.1:3777", "x-forwarded-for", "100.80.70.60"] }),
      probe({ requestTarget: "http://127.0.0.1:3777/fixture" }),
      probe({ requestTarget: "//127.0.0.1:3777/fixture" }),
      probe({ requestTarget: "/%2fescape" }),
      probe({ rawHeaders: ["host", "127.0.0.1:3777", "access-control-request-method", "POST"] })
    ]) {
      expect(() => evaluateHostDeckRequestTrust(policy, candidate)).toThrow();
    }
  });

  it("admits the exact non-browser local-admin signal for selected GET and POST routes", () => {
    for (const method of ["GET", "POST"] as const) {
      expect(
        evaluateHostDeckRequestTrust(
          policy,
          probe({
            method,
            rawHeaders: [
              "host",
              "127.0.0.1:3777",
              hostDeckLocalAdminRequestHeaderName,
              hostDeckLocalAdminRequestHeaderValue
            ]
          })
        ).origin_kind
      ).toBe("local_non_browser");
    }
    for (const rawHeaders of [
      ["host", "127.0.0.1:3777", hostDeckLocalAdminRequestHeaderName, "wrong"],
      ["host", "127.0.0.1:3777", hostDeckLocalAdminRequestHeaderName, hostDeckLocalAdminRequestHeaderValue, "origin", origin],
      ["host", "127.0.0.1:3777", hostDeckLocalAdminRequestHeaderName, hostDeckLocalAdminRequestHeaderValue, "cookie", "device=private"],
      ["host", "127.0.0.1:3777", hostDeckLocalAdminRequestHeaderName, hostDeckLocalAdminRequestHeaderValue, "sec-fetch-mode", "cors"]
    ]) {
      expect(() =>
        evaluateHostDeckRequestTrust(policy, probe({ rawHeaders }))
      ).toThrow();
    }
  });

  it("derives canonical domain-separated pair-claim source keys", () => {
    const ipv4 = deriveHostDeckPairClaimSourceKey("127.0.0.1");
    expect(ipv4).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(deriveHostDeckPairClaimSourceKey("::ffff:127.0.0.1")).toBe(ipv4);
    expect(deriveHostDeckPairClaimSourceKey("::1")).not.toBe(ipv4);
    for (const candidate of [undefined, "", "0.0.0.0", "::", "127.0.0.1%lo", "not-an-ip"] as const) {
      expect(() => deriveHostDeckPairClaimSourceKey(candidate)).toThrow();
    }
  });
});

describe("selected loopback request trust gate", () => {
  it("rejects before handlers and exposes only the frozen admitted context", async () => {
    const app = Fastify();
    let handlerCalls = 0;
    installHostDeckRequestTrustGate(app, policy, () => undefined);
    app.get("/fixture", async (request) => {
      handlerCalls += 1;
      const context = hostDeckRequestTrustContext(request);
      expect(Object.isFrozen(context)).toBe(true);
      return context;
    });
    await app.ready();
    try {
      const accepted = await app.inject({
        headers: { host: "127.0.0.1:3777" },
        method: "GET",
        url: "/fixture"
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toMatchObject({
        configured_origin: origin,
        network_mode: "loopback",
        transport: "http"
      });

      const rejected = await app.inject({
        headers: { host: "localhost:3777" },
        method: "GET",
        url: "/fixture"
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toMatchObject({
        error: { code: "invalid_origin", retryable: false }
      });
      expect(rejected.body).not.toContain("localhost:3777");
      expect(handlerCalls).toBe(1);
      expect(hostDeckRequestTrustSnapshot(app)).toEqual({
        accepted_requests: 1,
        rejected_forbidden_cors: 0,
        rejected_insecure_transport_requests: 0,
        rejected_invalid_origin_requests: 1
      });
    } finally {
      await app.close();
    }
  });
});

function probe(
  overrides: Partial<Parameters<typeof evaluateHostDeckRequestTrust>[1]> = {}
) {
  return {
    method: "GET",
    rawHeaders: ["host", "127.0.0.1:3777"],
    remoteAddress: "127.0.0.1",
    requestTarget: "/fixture",
    secure: false,
    ...overrides
  };
}
