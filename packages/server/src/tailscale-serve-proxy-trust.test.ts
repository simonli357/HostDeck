import { type AddressInfo, createConnection } from "node:net";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import {
  assertTailscaleServeProxyTrustPolicy,
  type CreateTailscaleServeProxyTrustPolicyInput,
  createTailscaleServeProxyTrustPolicy,
  evaluateTailscaleServeProxyTrust,
  installTailscaleServeProxyTrustGate,
  type TailscaleServeProxyTrustPolicy,
  type TailscaleServeProxyTrustProbe,
  tailscaleServeProxyTrustSnapshot,
  tailscaleServeRequestIngressProvenance
} from "./tailscale-serve-proxy-trust.js";

const localOrigin = "http://127.0.0.1:3777";
const localAuthority = "127.0.0.1:3777";
const externalOrigin = "https://laptop.hostdeck.ts.net";
const externalAuthority = "laptop.hostdeck.ts.net";
const sourceAddress = "100.64.0.1";
const sourceKey = "sha256:7769e31068cdc6d95b4062fa205e587c7dcaa14179eaf75d89371e6fb7553986";
const identityHeaders = [
  "Tailscale-Headers-Info",
  "https://tailscale.com/s/serve-headers",
  "Tailscale-User-Login",
  "person@example.test",
  "Tailscale-User-Name",
  "Test Person",
  "Tailscale-User-Profile-Pic",
  "https://images.example.test/person.png"
] as const;

describe("Tailscale Serve proxy trust policy", () => {
  it("creates one exact deeply frozen policy while keeping its reader private", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = createTailscaleServeProxyTrustPolicy({ localOrigin, readRemoteAdmission: reader });

    expect(policy).toEqual({
      limits: {
        http_headers_max_bytes: 16_384,
        http_headers_max_count: 64,
        http_url_max_bytes: 2_048
      },
      local_origin: localOrigin
    });
    expect(Object.keys(policy).sort()).toEqual(["limits", "local_origin"]);
    expect(JSON.stringify(policy)).not.toContain("readRemoteAdmission");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.limits)).toBe(true);
    expect(() => assertTailscaleServeProxyTrustPolicy(policy)).not.toThrow();
    expect(reader).not.toHaveBeenCalled();

    expect(() =>
      assertTailscaleServeProxyTrustPolicy(Object.freeze({ ...policy }))
    ).toThrow("must be created by createTailscaleServeProxyTrustPolicy");
  });

  it("accepts only selected resource ranges and rejects malformed policy input", () => {
    const minimum = createTailscaleServeProxyTrustPolicy({
      limits: {
        http_headers_max_bytes: 4_096,
        http_headers_max_count: 16,
        http_url_max_bytes: 256
      },
      localOrigin,
      readRemoteAdmission: () => openAdmission()
    });
    const maximum = createTailscaleServeProxyTrustPolicy({
      limits: {
        http_headers_max_bytes: 65_536,
        http_headers_max_count: 256,
        http_url_max_bytes: 8_192
      },
      localOrigin,
      readRemoteAdmission: () => openAdmission()
    });
    expect(minimum.limits.http_headers_max_count).toBe(16);
    expect(maximum.limits.http_headers_max_bytes).toBe(65_536);

    const invalid: unknown[] = [
      null,
      {},
      { localOrigin, readRemoteAdmission: () => openAdmission(), unknown: true },
      { localOrigin, readRemoteAdmission: "not-a-function" },
      { localOrigin: "http://localhost:3777", readRemoteAdmission: () => openAdmission() },
      { localOrigin: "https://127.0.0.1:3777", readRemoteAdmission: () => openAdmission() },
      { localOrigin: "http://127.0.0.1", readRemoteAdmission: () => openAdmission() },
      { localOrigin: `${localOrigin}/`, readRemoteAdmission: () => openAdmission() },
      { localOrigin, limits: null, readRemoteAdmission: () => openAdmission() },
      { localOrigin, limits: { unknown: 1 }, readRemoteAdmission: () => openAdmission() },
      { localOrigin, limits: { http_headers_max_bytes: 4_095 }, readRemoteAdmission: () => openAdmission() },
      { localOrigin, limits: { http_headers_max_bytes: 65_537 }, readRemoteAdmission: () => openAdmission() },
      { localOrigin, limits: { http_headers_max_count: 16.5 }, readRemoteAdmission: () => openAdmission() },
      { localOrigin, limits: { http_url_max_bytes: Number.NaN }, readRemoteAdmission: () => openAdmission() }
    ];
    for (const candidate of invalid) {
      expect(() => createPolicy(candidate), JSON.stringify(candidate)).toThrow();
    }
  });
});

describe("Tailscale Serve proxy trust evaluator", () => {
  it("keeps direct local requests separate and never reads remote admission", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = policyWith(reader);
    const decisions = [
      evaluateTailscaleServeProxyTrust(policy, localProbe()),
      evaluateTailscaleServeProxyTrust(policy, localProbe({ method: "POST" })),
      evaluateTailscaleServeProxyTrust(policy, localProbe({
        method: "POST",
        rawHeaders: ["Host", localAuthority, "Origin", localOrigin]
      })),
      evaluateTailscaleServeProxyTrust(policy, localProbe({ remoteAddress: "::ffff:127.0.0.1" }))
    ];

    for (const decision of decisions) {
      expect(decision).toEqual({
        decision: "admitted",
        provenance: {
          kind: "local_loopback",
          transport: "loopback_http",
          origin: localOrigin,
          remote_generation: null,
          source_key: null,
          tailnet_identity_present: false,
          app_authorization: "not_evaluated"
        },
        headers: {
          forwarding: "absent",
          standard_identity: "absent",
          untrusted_lookalike_present: false
        },
        reason: null
      });
      expect(Object.isFrozen(decision)).toBe(true);
      expect(Object.isFrozen(decision.provenance)).toBe(true);
      expect(Object.isFrozen(decision.headers)).toBe(true);
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it("keeps the explicit local-admin read signal local to the direct loopback form", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = policyWith(reader);
    const signal = [
      hostDeckLocalAdminRequestHeaderName,
      hostDeckLocalAdminRequestHeaderValue
    ];

    expect(
      evaluateTailscaleServeProxyTrust(
        policy,
        localProbe({ rawHeaders: ["Host", localAuthority, ...signal] })
      )
    ).toMatchObject({
      decision: "admitted",
      provenance: { kind: "local_loopback" }
    });
    expect(reader).not.toHaveBeenCalled();

    expectDecision(
      evaluateTailscaleServeProxyTrust(
        policy,
        remoteProbe({ rawHeaders: [...remoteHeaders(), ...signal] })
      ),
      "unknown_proxy_context",
      "exact"
    );
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("admits exact remote shape with optional identity and no application authority", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = policyWith(reader);
    const withoutIdentity = evaluateTailscaleServeProxyTrust(policy, remoteProbe());
    const withIdentity = evaluateTailscaleServeProxyTrust(policy, remoteProbe({
      rawHeaders: [...remoteHeaders(), ...identityHeaders]
    }));

    expect(withoutIdentity).toEqual({
      decision: "admitted",
      provenance: {
        kind: "admitted_remote",
        transport: "tailscale_serve_https",
        origin: externalOrigin,
        remote_generation: 7,
        source_key: sourceKey,
        tailnet_identity_present: false,
        app_authorization: "not_evaluated"
      },
      headers: {
        forwarding: "exact",
        standard_identity: "absent",
        untrusted_lookalike_present: false
      },
      reason: null
    });
    expect(withIdentity).toMatchObject({
      decision: "admitted",
      provenance: {
        tailnet_identity_present: true,
        app_authorization: "not_evaluated"
      },
      headers: { standard_identity: "present" }
    });
    expect(JSON.stringify(withIdentity)).not.toContain("person@example.test");
    expect(JSON.stringify(withIdentity)).not.toContain(sourceAddress);
    expect(Object.keys(withIdentity.provenance ?? {}).sort()).toEqual([
      "app_authorization",
      "kind",
      "origin",
      "remote_generation",
      "source_key",
      "tailnet_identity_present",
      "transport"
    ]);
    expect(JSON.stringify(withIdentity)).not.toMatch(/csrf|device|local_admin|permission/u);
    expect(reader).toHaveBeenCalledTimes(4);
  });

  it("preserves precedence across the combined forwarding, identity, lookalike, and unknown grid", () => {
    const policy = policyWith(() => openAdmission());
    const forwardingCases = [
      { id: "exact", headers: remoteHeaders(), assessment: "exact" },
      {
        id: "partial",
        headers: ["Host", externalAuthority, "X-Forwarded-For", sourceAddress],
        assessment: "invalid"
      },
      { id: "absent", headers: ["Host", externalAuthority], assessment: "absent" }
    ] as const;
    const identityCases = [
      { id: "absent", headers: [], assessment: "absent" },
      { id: "present", headers: [...identityHeaders], assessment: "present" },
      {
        id: "invalid",
        headers: ["Tailscale-User-Login", "partial@example.test"],
        assessment: "invalid"
      }
    ] as const;

    for (const forwarding of forwardingCases) {
      for (const identity of identityCases) {
        for (const lookalike of [false, true]) {
          for (const unknown of [false, true]) {
            const rawHeaders = [
              ...forwarding.headers,
              ...identity.headers,
              ...(lookalike ? ["X-Tailscale-User-Login", "spoof@example.test"] : []),
              ...(unknown ? ["Tailscale-Funnel-Request", "?1"] : [])
            ];
            const decision = evaluateTailscaleServeProxyTrust(policy, remoteProbe({ rawHeaders }));
            const expectedReason = lookalike
              ? "untrusted_tailscale_lookalike"
              : unknown
                ? "unknown_proxy_context"
                : identity.id === "invalid"
                  ? "standard_identity_invalid"
                  : forwarding.id === "partial"
                    ? "missing_forwarding_header"
                    : forwarding.id === "absent"
                      ? identity.id === "present"
                        ? "missing_forwarding_header"
                        : "unknown_proxy_context"
                      : null;
            const id = `${forwarding.id}/${identity.id}/lookalike=${lookalike}/unknown=${unknown}`;

            expect(decision.headers, id).toEqual({
              forwarding: forwarding.assessment,
              standard_identity: identity.assessment,
              untrusted_lookalike_present: lookalike
            });
            if (expectedReason === null) {
              expect(decision.decision, id).toBe("admitted");
              expect(decision.reason, id).toBeNull();
            } else {
              expect(decision.decision, id).toBe("rejected");
              expect(decision.reason, id).toBe(expectedReason);
            }
          }
        }
      }
    }
  });

  it("allows safe remote reads without Origin and requires exact Origin for unsafe methods", () => {
    const policy = policyWith(() => openAdmission());
    for (const method of ["GET", "get", "HEAD"] as const) {
      expect(evaluateTailscaleServeProxyTrust(policy, remoteProbe({ method })).decision).toBe("admitted");
    }
    expectDecision(
      evaluateTailscaleServeProxyTrust(policy, remoteProbe({ method: "POST" })),
      "origin_mismatch",
      "exact"
    );
    expect(
      evaluateTailscaleServeProxyTrust(policy, remoteProbe({
        method: "POST",
        rawHeaders: [...remoteHeaders(), "Origin", externalOrigin]
      })).decision
    ).toBe("admitted");
    for (const origin of [
      "https://evil.example",
      `${externalOrigin}/`,
      externalOrigin.toUpperCase(),
      "https://laptop.hostdeck.ts.net:443",
      "null"
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({
          method: "POST",
          rawHeaders: [...remoteHeaders(), "Origin", origin]
        })),
        "origin_mismatch",
        "exact"
      );
    }
  });

  it("rejects external Host and forwarded-host aliases without DNS rebinding", () => {
    const policy = policyWith(() => openAdmission());
    for (const host of [
      externalAuthority.toUpperCase(),
      `${externalAuthority}.`,
      `${externalAuthority}:443`,
      `user@${externalAuthority}`,
      `${externalAuthority}, evil.example`,
      `${externalAuthority}.evil.example`
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({
          rawHeaders: replaceHeader(remoteHeaders(), "Host", host)
        })),
        "host_mismatch",
        "exact"
      );
    }
    expectDecision(
      evaluateTailscaleServeProxyTrust(policy, remoteProbe({
        rawHeaders: [...remoteHeaders(), "Host", externalAuthority]
      })),
      "host_mismatch",
      "exact"
    );
    for (const forwardedHost of [
      externalAuthority.toUpperCase(),
      `${externalAuthority}:443`,
      `user@${externalAuthority}`,
      `${externalAuthority}, evil.example`
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({
          rawHeaders: replaceHeader(remoteHeaders(), "X-Forwarded-Host", forwardedHost)
        })),
        "unknown_proxy_context",
        "invalid"
      );
    }
  });

  it("classifies forwarding absence, partial shape, duplication, proto, source, and host exactly", () => {
    const policy = policyWith(() => openAdmission());
    const cases: readonly [
      readonly string[],
      string,
      "absent" | "exact" | "invalid",
      ("absent" | "present" | "invalid")?
    ][] = [
      [["Host", externalAuthority, "Tailscale-User-Login", "person@example.test"], "standard_identity_invalid", "absent", "invalid"],
      [["Host", externalAuthority, "X-Forwarded-For", sourceAddress], "missing_forwarding_header", "invalid"],
      [[...remoteHeaders(), "X-Forwarded-For", sourceAddress], "duplicate_forwarding_header", "invalid"],
      [replaceHeader(remoteHeaders(), "X-Forwarded-Proto", "http"), "invalid_forwarded_proto", "invalid"],
      [replaceHeader(remoteHeaders(), "X-Forwarded-For", "192.168.1.2"), "source_invalid", "invalid"],
      [replaceHeader(remoteHeaders(), "X-Forwarded-Host", "other.hostdeck.ts.net"), "host_mismatch", "exact"],
      [replaceHeader(remoteHeaders(), "Host", "other.hostdeck.ts.net"), "host_mismatch", "exact"],
      [replaceHeader(remoteHeaders(), "X-Forwarded-Host", externalAuthority.toUpperCase()), "unknown_proxy_context", "invalid"]
    ];
    for (const [rawHeaders, reason, forwarding, identity] of cases) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({ rawHeaders })),
        reason,
        forwarding,
        identity
      );
    }
  });

  it("accepts only canonical IPv4 Tailscale CGNAT source boundaries", () => {
    const policy = policyWith(() => openAdmission());
    for (const source of ["100.64.0.0", "100.64.0.1", "100.127.255.255"]) {
      expect(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({
          rawHeaders: replaceHeader(remoteHeaders(), "X-Forwarded-For", source)
        })).decision,
        source
      ).toBe("admitted");
    }
    for (const source of [
      "100.63.255.255",
      "100.128.0.0",
      "100.064.0.1",
      "100.64.0.1, 100.64.0.2",
      "100.64.0.1:443",
      "fd7a:115c:a1e0::1",
      " 100.64.0.1"
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({
          rawHeaders: replaceHeader(remoteHeaders(), "X-Forwarded-For", source)
        })),
        "source_invalid",
        "invalid"
      );
    }
  });

  it("requires the exact all-or-none standard identity bundle", () => {
    const policy = policyWith(() => openAdmission());
    for (let index = 0; index < identityHeaders.length; index += 2) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({
          rawHeaders: [...remoteHeaders(), identityHeaders[index] as string, identityHeaders[index + 1] as string]
        })),
        "standard_identity_invalid",
        "exact",
        "invalid"
      );
    }
    for (const rawHeaders of [
      [...remoteHeaders(), ...identityHeaders, "Tailscale-User-Login", "duplicate@example.test"],
      replaceHeader([...remoteHeaders(), ...identityHeaders], "Tailscale-Headers-Info", "https://example.test"),
      replaceHeader([...remoteHeaders(), ...identityHeaders], "Tailscale-User-Name", "\t"),
      replaceHeader([...remoteHeaders(), ...identityHeaders], "Tailscale-User-Profile-Pic", " ")
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({ rawHeaders })),
        "standard_identity_invalid",
        "exact",
        "invalid"
      );
    }
  });

  it("gives hostile namespace signals deterministic precedence without falsifying assessments", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = policyWith(reader);
    const combinedLookalike = [
      "Host",
      externalAuthority,
      "X-Forwarded-For",
      sourceAddress,
      "Tailscale-User-Login",
      "partial@example.test",
      "X-Tailscale-User-Login",
      "spoof@example.test"
    ];
    const lookalike = evaluateTailscaleServeProxyTrust(policy, remoteProbe({ rawHeaders: combinedLookalike }));
    expectDecision(lookalike, "untrusted_tailscale_lookalike", "invalid", "invalid", true);

    const unknown = evaluateTailscaleServeProxyTrust(policy, remoteProbe({
      rawHeaders: [...remoteHeaders(), "Tailscale-Funnel-Request", "?1", "Tailscale-User-Login", "partial@example.test"]
    }));
    expectDecision(unknown, "unknown_proxy_context", "exact", "invalid");
    expect(reader).toHaveBeenCalledTimes(4);

    for (const name of [
      "Forwarded",
      "Via",
      "X-Forwarded-Port",
      "X-Original-Host",
      "X-Real-IP",
      "Proxy-Connection",
      "Tailscale-Unknown",
      "Tailscale-Funnel-Request"
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({ rawHeaders: [...remoteHeaders(), name, "hostile"] })),
        "unknown_proxy_context",
        "exact"
      );
    }
  });

  it("rejects preflight, non-loopback transport, TLS backend, and ambiguous targets", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = policyWith(reader);
    expectDecision(
      evaluateTailscaleServeProxyTrust(policy, localProbe({ method: "OPTIONS" })),
      "unknown_proxy_context",
      "absent"
    );
    expectDecision(
      evaluateTailscaleServeProxyTrust(policy, localProbe({
        rawHeaders: ["Host", localAuthority, "Access-Control-Request-Method", "POST"]
      })),
      "unknown_proxy_context",
      "absent"
    );
    expect(reader).not.toHaveBeenCalled();

    for (const remoteAddress of ["192.168.1.3", "::1", undefined]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({ remoteAddress })),
        "direct_non_loopback",
        "exact"
      );
    }
    expectDecision(
      evaluateTailscaleServeProxyTrust(policy, remoteProbe({ secure: true })),
      "unknown_proxy_context",
      "exact"
    );
    for (const requestTarget of [
      "https://laptop.hostdeck.ts.net/probe",
      "laptop.hostdeck.ts.net:443",
      "*",
      "//evil.test/probe",
      "/%2fevil.test/probe",
      "/probe%5cchild",
      "/probe%00child",
      "/probe#fragment"
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, remoteProbe({ requestTarget })),
        "unknown_proxy_context",
        "exact"
      );
    }
  });

  it("brackets every remote parse and rejects closed, malformed, throwing, or changed admission", () => {
    const cases: readonly [string, () => unknown][] = [
      ["closed", () => closedAdmission()],
      ["malformed", () => ({ ...openAdmission(), extra: true })],
      ["throwing", () => { throw new Error("private reader failure"); }]
    ];
    for (const [id, reader] of cases) {
      const observed = vi.fn(reader);
      expectDecision(
        evaluateTailscaleServeProxyTrust(policyWith(observed), remoteProbe()),
        "remote_generation_stale",
        "exact"
      );
      expect(observed, id).toHaveBeenCalledTimes(2);
    }

    for (const pair of [
      [openAdmission(), openAdmission({ generation: 8 })],
      [openAdmission(), openAdmission({ external_origin: "https://other.hostdeck.ts.net" })],
      [openAdmission(), closedAdmission()]
    ] as const) {
      const reads = [...pair];
      const reader = vi.fn(() => reads.shift());
      expectDecision(
        evaluateTailscaleServeProxyTrust(policyWith(reader), remoteProbe()),
        "remote_generation_stale",
        "exact"
      );
      expect(reader).toHaveBeenCalledTimes(2);
    }

    const hostileReader = vi.fn(() => {
      throw new Error("private reader failure");
    });
    expectDecision(
      evaluateTailscaleServeProxyTrust(policyWith(hostileReader), remoteProbe({
        rawHeaders: [...remoteHeaders(), "X-Tailscale-User-Login", "spoof@example.test"]
      })),
      "untrusted_tailscale_lookalike",
      "exact",
      "absent",
      true
    );
    expect(hostileReader).toHaveBeenCalledTimes(2);
  });

  it("enforces configured raw header and URL budgets before admission", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = createTailscaleServeProxyTrustPolicy({
      limits: {
        http_headers_max_bytes: 4_096,
        http_headers_max_count: 16,
        http_url_max_bytes: 256
      },
      localOrigin,
      readRemoteAdmission: reader
    });
    const tooManyHeaders = ["Host", localAuthority];
    for (let index = 0; index < 16; index += 1) tooManyHeaders.push(`X-Test-${index}`, "ok");

    for (const probe of [
      localProbe({ rawHeaders: tooManyHeaders }),
      localProbe({ rawHeaders: ["Host", localAuthority, "X-Fill", "a".repeat(4_096)] }),
      localProbe({ requestTarget: `/${"a".repeat(256)}` }),
      { ...localProbe(), rawHeaders: ["Host"] },
      { ...localProbe(), rawHeaders: ["Bad Header", "value"] },
      { ...localProbe(), rawHeaders: ["Host", localAuthority, "X-Test", "bad\u0001value"] },
      { ...localProbe(), method: "GET POST" },
      { ...localProbe(), unknown: true }
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, probe as TailscaleServeProxyTrustProbe),
        "unknown_proxy_context",
        "invalid"
      );
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects local Host/Origin rebinding without consulting remote admission", () => {
    const reader = vi.fn(() => openAdmission());
    const policy = policyWith(reader);
    for (const rawHeaders of [
      [],
      ["Host", "localhost:3777"],
      ["Host", `${localAuthority}.evil.test`],
      ["Host", localAuthority, "Host", localAuthority],
      ["Host", localAuthority, "Origin", externalOrigin],
      ["Host", localAuthority, "Origin", localOrigin, "Origin", localOrigin],
      ["Host", localAuthority, "Sec-Fetch-Site", "same-origin"]
    ]) {
      expectDecision(
        evaluateTailscaleServeProxyTrust(policy, localProbe({ method: "POST", rawHeaders })),
        "unknown_proxy_context",
        "absent"
      );
    }
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("Tailscale Serve Fastify gate", () => {
  it("admits frozen local/remote provenance and rejects before handlers with reason-only diagnostics", async () => {
    const policy = policyWith(() => openAdmission());
    const observations: unknown[] = [];
    const app = Fastify({ logger: false, trustProxy: false });
    let handlerCalls = 0;
    installTailscaleServeProxyTrustGate(app, policy, (observation) => {
      observations.push(observation);
    });
    app.get("/context", async (request) => {
      handlerCalls += 1;
      return tailscaleServeRequestIngressProvenance(request);
    });
    app.get("/cors", async (_request, reply) => {
      handlerCalls += 1;
      reply.raw.setHeader("access-control-allow-origin", "*");
      return { ok: true };
    });
    await app.ready();

    try {
      const local = await app.inject({
        method: "GET",
        url: "/context",
        headers: { host: localAuthority }
      });
      expect(local.statusCode, local.body).toBe(200);
      expect(local.json()).toMatchObject({ kind: "local_loopback", app_authorization: "not_evaluated" });

      const remote = await app.inject({
        method: "GET",
        url: "/context",
        headers: remoteHeaderObject()
      });
      expect(remote.statusCode, remote.body).toBe(200);
      expect(remote.json()).toEqual({
        kind: "admitted_remote",
        transport: "tailscale_serve_https",
        origin: externalOrigin,
        remote_generation: 7,
        source_key: sourceKey,
        tailnet_identity_present: false,
        app_authorization: "not_evaluated"
      });

      const hostile = await app.inject({
        method: "GET",
        url: "/context",
        headers: { ...remoteHeaderObject(), "x-tailscale-user-login": "private@example.test" }
      });
      expect(hostile.statusCode).toBe(403);
      expect(hostile.headers.connection).toBe("close");
      expect(hostile.json()).toMatchObject({ error: { code: "invalid_origin", retryable: false } });
      expect(hostile.body).not.toContain("private@example.test");
      expect(hostile.body).not.toContain(externalAuthority);
      expect(handlerCalls).toBe(2);

      const cors = await app.inject({ method: "GET", url: "/cors", headers: { host: localAuthority } });
      expect(cors.statusCode, cors.body).toBe(500);
      expect(cors.headers["access-control-allow-origin"]).toBeUndefined();
      expect(observations).toHaveLength(1);

      const snapshot = tailscaleServeProxyTrustSnapshot(app);
      expect(snapshot).toMatchObject({
        accepted_local_requests: 2,
        accepted_remote_requests: 1,
        cors_response_violations: 1,
        rejected_requests: { untrusted_tailscale_lookalike: 1 }
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.rejected_requests)).toBe(true);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(sourceAddress);
      expect(serialized).not.toContain(externalAuthority);
    } finally {
      await app.close();
    }
  });

  it("rejects forged policies, duplicate installation, and context access before admission", async () => {
    const policy = policyWith(() => openAdmission());
    const app = Fastify({ logger: false, trustProxy: false });
    expect(() => tailscaleServeRequestIngressProvenance({} as never)).toThrow("unavailable before trust admission");
    expect(() => tailscaleServeProxyTrustSnapshot(app)).toThrow("has no Tailscale Serve proxy trust gate");
    expect(() =>
      installTailscaleServeProxyTrustGate(app, Object.freeze({ ...policy }) as TailscaleServeProxyTrustPolicy, () => undefined)
    ).toThrow("must be created by createTailscaleServeProxyTrustPolicy");
    installTailscaleServeProxyTrustGate(app, policy, () => undefined);
    expect(() => installTailscaleServeProxyTrustGate(app, policy, () => undefined)).toThrow("already installed");
    await app.close();
  });

  it("enforces direct and proxy trust over real raw loopback sockets", async () => {
    const app = Fastify({ logger: false, trustProxy: false });
    let handlerCalls = 0;
    installTailscaleServeProxyTrustGate(app, policyWith(() => openAdmission()), () => undefined);
    app.get("/context", async (request) => {
      handlerCalls += 1;
      return tailscaleServeRequestIngressProvenance(request);
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Raw trust test server has no TCP address.");
    const port = (address as AddressInfo).port;

    try {
      const local = await rawHttp(port, [
        "GET /context HTTP/1.1",
        `Host: ${localAuthority}`,
        "Connection: close"
      ]);
      expect(local).toMatch(/^HTTP\/1\.1 200 /u);
      expect(local).toContain('"kind":"local_loopback"');

      const remote = await rawHttp(port, [
        "GET /context HTTP/1.1",
        `Host: ${externalAuthority}`,
        `X-Forwarded-For: ${sourceAddress}`,
        `X-Forwarded-Host: ${externalAuthority}`,
        "X-Forwarded-Proto: https",
        "Connection: close"
      ]);
      expect(remote).toMatch(/^HTTP\/1\.1 200 /u);
      expect(remote).toContain('"kind":"admitted_remote"');
      expect(remote).not.toContain(sourceAddress);

      const duplicate = await rawHttp(port, [
        "GET /context HTTP/1.1",
        `Host: ${externalAuthority}`,
        `X-Forwarded-For: ${sourceAddress}`,
        `X-Forwarded-For: ${sourceAddress}`,
        `X-Forwarded-Host: ${externalAuthority}`,
        "X-Forwarded-Proto: https",
        "Connection: close"
      ]);
      expect(duplicate).toMatch(/^HTTP\/1\.1 403 /u);
      expect(duplicate.toLowerCase()).toContain("connection: close");
      expect(duplicate).not.toContain(sourceAddress);

      const lookalike = await rawHttp(port, [
        "GET /context HTTP/1.1",
        `Host: ${externalAuthority}`,
        `X-Forwarded-For: ${sourceAddress}`,
        `X-Forwarded-Host: ${externalAuthority}`,
        "X-Forwarded-Proto: https",
        "X-Tailscale-User-Login: private@example.test",
        "Connection: close"
      ]);
      expect(lookalike).toMatch(/^HTTP\/1\.1 403 /u);
      expect(lookalike).not.toContain("private@example.test");
      expect(handlerCalls).toBe(2);
    } finally {
      await app.close();
    }
  });
});

function policyWith(reader: () => unknown): TailscaleServeProxyTrustPolicy {
  return createTailscaleServeProxyTrustPolicy({ localOrigin, readRemoteAdmission: reader });
}

function createPolicy(candidate: unknown): TailscaleServeProxyTrustPolicy {
  return createTailscaleServeProxyTrustPolicy(candidate as CreateTailscaleServeProxyTrustPolicyInput);
}

function openAdmission(
  overrides: Partial<{ readonly external_origin: string; readonly generation: number }> = {}
) {
  return {
    admission: "open" as const,
    external_origin: externalOrigin,
    generation: 7,
    ...overrides
  };
}

function closedAdmission() {
  return { admission: "closed" as const, external_origin: null, generation: 7 };
}

function localProbe(overrides: Partial<TailscaleServeProxyTrustProbe> = {}): TailscaleServeProxyTrustProbe {
  return {
    method: "GET",
    rawHeaders: ["Host", localAuthority],
    remoteAddress: "127.0.0.1",
    requestTarget: "/probe",
    secure: false,
    ...overrides
  };
}

function remoteProbe(overrides: Partial<TailscaleServeProxyTrustProbe> = {}): TailscaleServeProxyTrustProbe {
  return {
    method: "GET",
    rawHeaders: remoteHeaders(),
    remoteAddress: "127.0.0.1",
    requestTarget: "/probe",
    secure: false,
    ...overrides
  };
}

function remoteHeaders(): string[] {
  return [
    "Host",
    externalAuthority,
    "X-Forwarded-For",
    sourceAddress,
    "X-Forwarded-Host",
    externalAuthority,
    "X-Forwarded-Proto",
    "https"
  ];
}

function remoteHeaderObject(): Record<string, string> {
  return {
    host: externalAuthority,
    "x-forwarded-for": sourceAddress,
    "x-forwarded-host": externalAuthority,
    "x-forwarded-proto": "https"
  };
}

function replaceHeader(headers: readonly string[], name: string, value: string): string[] {
  const copy = [...headers];
  const index = copy.findIndex((candidate, candidateIndex) => candidateIndex % 2 === 0 && candidate.toLowerCase() === name.toLowerCase());
  if (index < 0) throw new Error(`Missing test header ${name}.`);
  copy[index + 1] = value;
  return copy;
}

function expectDecision(
  decision: ReturnType<typeof evaluateTailscaleServeProxyTrust>,
  reason: string,
  forwarding: "absent" | "exact" | "invalid",
  standardIdentity: "absent" | "present" | "invalid" = "absent",
  lookalike = false
): void {
  expect(decision).toEqual({
    decision: "rejected",
    provenance: null,
    headers: {
      forwarding,
      standard_identity: standardIdentity,
      untrusted_lookalike_present: lookalike
    },
    reason
  });
  expect(Object.isFrozen(decision)).toBe(true);
  expect(Object.isFrozen(decision.headers)).toBe(true);
}

async function rawHttp(port: number, lines: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(5_000);
    socket.once("connect", () => socket.end(`${lines.join("\r\n")}\r\n\r\n`));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("timeout", () => socket.destroy(new Error("Raw trust request timed out.")));
    socket.once("error", reject);
  });
}
