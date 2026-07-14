import { remoteProfileRelations, remoteProfileStates } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  hostDeckLoopbackOriginSchema,
  projectRemoteIngressPublicState,
  remoteExternalOriginSchema,
  remoteIngressAuditSummarySchema,
  remoteIngressStateSchema,
  remoteProfileObservationSchema,
  remoteProxyTrustDecisionSchema,
  remoteProxyTrustRejectionReasons
} from "./remote-ingress.js";

const timestamp = "2026-07-13T16:00:00.000Z";
const origin = "https://hostdeck-fixture.fixture-tailnet.ts.net";
const expectedProfile = `sha256:${"1".repeat(64)}`;
const otherProfile = `sha256:${"2".repeat(64)}`;
const sourceKey = `sha256:${"3".repeat(64)}`;
const descriptor = {
  external_origin: origin,
  https_port: 443,
  path: "/",
  proxy_origin: "http://127.0.0.1:3777",
  visibility: "private"
} as const;

describe("remote ingress hardening boundaries", () => {
  it("accepts only the exact private Serve DNS shape and canonical loopback port", () => {
    const maxDnsName = `${"a".repeat(63)}.${"b".repeat(63)}.ts.net`;
    const invalidOrigins = [
      `https://extra.${maxDnsName}`,
      `https://${"a".repeat(64)}.fixture-tailnet.ts.net`,
      "https://hostdeck-fixture.fixture-tailnet.ts.net.",
      "https://hostdeck-fixture%2Efixture-tailnet.ts.net"
    ];

    expect(maxDnsName).toHaveLength(134);
    expect(remoteExternalOriginSchema.parse(`https://${maxDnsName}`)).toBe(`https://${maxDnsName}`);
    for (const candidate of invalidOrigins) expect(remoteExternalOriginSchema.safeParse(candidate).success, candidate).toBe(false);
    expect(hostDeckLoopbackOriginSchema.parse("http://127.0.0.1:65535")).toBe("http://127.0.0.1:65535");
    expect(hostDeckLoopbackOriginSchema.safeParse("http://127.0.0.1:65536").success).toBe(false);
    expect(hostDeckLoopbackOriginSchema.safeParse("http://127.0.0.1:03777").success).toBe(false);
  });

  it("accepts only the reviewed profile-state and comparison-relation matrix", () => {
    const validPairs = new Set([
      "absent/unconfigured",
      "absent/missing",
      "stopped/match",
      "stopped/different",
      "stopped/unknown",
      "signed_out/unknown",
      "dedicated/match",
      "other/different",
      "unknown/unknown"
    ]);

    for (const state of remoteProfileStates) {
      for (const relation of remoteProfileRelations) {
        const candidate = { state, comparison: comparisonFor(relation) };
        expect(remoteProfileObservationSchema.safeParse(candidate).success, `${state}/${relation}`).toBe(
          validPairs.has(`${state}/${relation}`)
        );
      }
    }
  });

  it("does not classify Serve state from absent, unknown, or foreign selected profiles", () => {
    const candidates = [
      state({
        availability: "unavailable",
        admission: "closed",
        profile: profile("other", "different", expectedProfile, otherProfile),
        serve: "exact",
        reason: "profile_other"
      }),
      state({
        availability: "unavailable",
        admission: "closed",
        profile: profile("stopped", "different", expectedProfile, otherProfile),
        serve: "exact",
        reason: "client_stopped"
      }),
      state({
        availability: "unavailable",
        admission: "closed",
        client: "unsupported",
        profile: profile("unknown", "unknown", expectedProfile, null),
        serve: "exact",
        reason: "client_unsupported"
      })
    ];
    for (const candidate of candidates) expect(remoteIngressStateSchema.safeParse(candidate).success).toBe(false);
  });

  it("preserves failed observation causes without hiding them behind unknown profile state", () => {
    const failedObservation = state({
      availability: "unavailable",
      admission: "closed",
      observation: "failed",
      client: "error",
      profile: profile("unknown", "unknown", expectedProfile, null),
      serve: null,
      operation_failure: "command_timeout",
      reason: "command_timeout",
      observed_at: null
    });
    expect(remoteIngressStateSchema.parse(failedObservation)).toMatchObject({
      observation: "failed",
      profile: { state: "unknown" },
      reason: "command_timeout"
    });
    expect(
      remoteIngressStateSchema.safeParse({ ...failedObservation, observation: "current", observed_at: timestamp }).success
    ).toBe(false);
    expect(
      remoteIngressStateSchema.safeParse(
        state({
          availability: "unavailable",
          admission: "closed",
          client: "not_installed",
          profile: profile("absent", "missing", expectedProfile, null),
          serve: null,
          operation_failure: "schema_invalid",
          reason: "client_not_installed"
        })
      ).success
    ).toBe(false);
  });

  it("enforces generation and normalized timestamp boundaries", () => {
    expect(remoteIngressStateSchema.parse(state({ generation: Number.MAX_SAFE_INTEGER })).generation).toBe(Number.MAX_SAFE_INTEGER);
    for (const generation of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(remoteIngressStateSchema.safeParse(state({ generation })).success, String(generation)).toBe(false);
    }
    expect(
      remoteIngressStateSchema.parse(
        state({ observed_at: "2026-07-13T12:00:00.000-04:00", updated_at: timestamp })
      ).observed_at
    ).toBe(timestamp);
    expect(remoteIngressStateSchema.safeParse(state({ observed_at: "2026-07-13T16:00:00.001Z" })).success).toBe(false);
  });

  it("rejects hostile object shapes without invoking accessors or throwing from safeParse", () => {
    let getterCalls = 0;
    const accessor = { ...state() };
    Object.defineProperty(accessor, "generation", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 7;
      }
    });
    const hidden = { ...state() };
    Object.defineProperty(hidden, "raw_output", { enumerable: false, value: "secret" });
    const symbol = { ...state(), [Symbol("future")]: true };
    const customPrototype = Object.assign(Object.create({ inherited: true }), state());
    const nestedComparison = { relation: "match", expected_profile_key: expectedProfile, active_profile_key: expectedProfile };
    Object.defineProperty(nestedComparison, "active_profile_key", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return expectedProfile;
      }
    });
    const nestedAccessor = state({ profile: { state: "dedicated", comparison: nestedComparison } });
    const hostileProxy = new Proxy(state(), {
      ownKeys() {
        throw new TypeError("hostile ownKeys trap");
      }
    });
    const readTrapProxy = new Proxy(state(), {
      get() {
        throw new TypeError("unexpected property read");
      }
    });

    for (const candidate of [accessor, hidden, symbol, customPrototype, nestedAccessor]) {
      expect(remoteIngressStateSchema.safeParse(candidate).success).toBe(false);
    }
    expect(getterCalls).toBe(0);
    expect(() => remoteIngressStateSchema.safeParse(hostileProxy)).not.toThrow();
    expect(remoteIngressStateSchema.safeParse(hostileProxy).success).toBe(false);
    expect(remoteIngressStateSchema.parse(readTrapProxy)).toMatchObject({ availability: "ready", admission: "open" });
    expect(remoteIngressStateSchema.parse(Object.assign(Object.create(null), state()))).toMatchObject({
      availability: "ready",
      admission: "open"
    });
  });

  it("revalidates full evidence before projecting public readiness", () => {
    expect(projectRemoteIngressPublicState(remoteIngressStateSchema.parse(state()))).toMatchObject({
      generation: 7,
      availability: "ready"
    });
    const invented = state({ profile: profile("other", "different", expectedProfile, otherProfile) });
    expect(() =>
      projectRemoteIngressPublicState(invented as Parameters<typeof projectRemoteIngressPublicState>[0])
    ).toThrow();
  });
});

describe("remote proxy hardening", () => {
  it("binds every rejection reason to coherent normalized header evidence", () => {
    const forwardingByReason = {
      direct_non_loopback: "absent",
      missing_forwarding_header: "absent",
      duplicate_forwarding_header: "invalid",
      invalid_forwarded_proto: "invalid",
      host_mismatch: "exact",
      origin_mismatch: "exact",
      source_invalid: "invalid",
      standard_identity_invalid: "absent",
      untrusted_tailscale_lookalike: "absent",
      remote_generation_stale: "exact",
      unknown_proxy_context: "invalid"
    } as const;

    for (const reason of remoteProxyTrustRejectionReasons) {
      expect(remoteProxyTrustDecisionSchema.parse(rejectedProxy(reason, forwardingByReason[reason]))).toMatchObject({
        decision: "rejected",
        reason
      });
    }
    for (const forwarding of ["absent", "invalid"] as const) {
      expect(remoteProxyTrustDecisionSchema.parse(rejectedProxy("missing_forwarding_header", forwarding))).toMatchObject({
        headers: { forwarding }
      });
    }
    for (const reason of [
      "standard_identity_invalid",
      "untrusted_tailscale_lookalike",
      "unknown_proxy_context"
    ] as const) {
      for (const forwarding of ["absent", "exact", "invalid"] as const) {
        expect(remoteProxyTrustDecisionSchema.parse(rejectedProxy(reason, forwarding))).toMatchObject({
          headers: { forwarding },
          reason
        });
      }
    }
    for (const [reason, wrongForwarding] of [
      ["host_mismatch", "invalid"],
      ["origin_mismatch", "absent"],
      ["source_invalid", "exact"],
      ["missing_forwarding_header", "exact"],
      ["duplicate_forwarding_header", "exact"],
      ["invalid_forwarded_proto", "exact"],
      ["remote_generation_stale", "invalid"],
    ] as const) {
      expect(remoteProxyTrustDecisionSchema.safeParse(rejectedProxy(reason, wrongForwarding)).success, reason).toBe(false);
    }
  });

  it("preserves truthful assessments when hostile proxy signals are combined", () => {
    const lookalikeAndInvalidIdentity = {
      ...rejectedProxy("untrusted_tailscale_lookalike", "absent"),
      headers: {
        forwarding: "absent",
        standard_identity: "invalid",
        untrusted_lookalike_present: true
      }
    } as const;
    const unknownAndInvalidIdentity = {
      ...rejectedProxy("unknown_proxy_context", "invalid"),
      headers: {
        forwarding: "invalid",
        standard_identity: "invalid",
        untrusted_lookalike_present: false
      }
    } as const;
    const identityAndMissingForwarding = {
      ...rejectedProxy("standard_identity_invalid", "absent"),
      headers: {
        forwarding: "absent",
        standard_identity: "invalid",
        untrusted_lookalike_present: false
      }
    } as const;

    expect(remoteProxyTrustDecisionSchema.parse(lookalikeAndInvalidIdentity)).toEqual(lookalikeAndInvalidIdentity);
    expect(remoteProxyTrustDecisionSchema.parse(unknownAndInvalidIdentity)).toEqual(unknownAndInvalidIdentity);
    expect(remoteProxyTrustDecisionSchema.parse(identityAndMissingForwarding)).toEqual(identityAndMissingForwarding);

    expect(
      remoteProxyTrustDecisionSchema.safeParse({
        ...lookalikeAndInvalidIdentity,
        reason: "standard_identity_invalid"
      }).success
    ).toBe(false);
    expect(
      remoteProxyTrustDecisionSchema.safeParse({
        ...identityAndMissingForwarding,
        reason: "missing_forwarding_header"
      }).success
    ).toBe(false);
    expect(
      remoteProxyTrustDecisionSchema.safeParse({
        ...identityAndMissingForwarding,
        headers: { ...identityAndMissingForwarding.headers, standard_identity: "absent" }
      }).success
    ).toBe(false);
  });

  it("enforces safe remote-generation bounds while retaining only a source hash", () => {
    expect(
      remoteProxyTrustDecisionSchema.parse({
        ...admittedRemote(),
        provenance: { ...admittedRemote().provenance, remote_generation: Number.MAX_SAFE_INTEGER }
      }).provenance
    ).toMatchObject({ remote_generation: Number.MAX_SAFE_INTEGER, source_key: sourceKey });
    expect(
      remoteProxyTrustDecisionSchema.safeParse({
        ...admittedRemote(),
        provenance: { ...admittedRemote().provenance, remote_generation: Number.MAX_SAFE_INTEGER + 1 }
      }).success
    ).toBe(false);
  });
});

describe("remote audit hardening", () => {
  it("covers idempotent enable, verified disable, rejection, and unknown external outcomes", () => {
    expect(remoteIngressAuditSummarySchema.parse(acceptedAudit({ serve_state: "exact" }))).toMatchObject({
      action: "remote_enable",
      serve_state: "exact",
      outcome: "accepted"
    });
    expect(remoteIngressAuditSummarySchema.safeParse(acceptedAudit({ serve_state: "foreign" })).success).toBe(false);
    expect(
      remoteIngressAuditSummarySchema.safeParse(
        acceptedAudit({
          action: "remote_disable",
          requested_intent: "disabled",
          profile_state: "other",
          serve_state: null
        })
      ).success
    ).toBe(false);

    const successfulDisable = terminalAudit({
      action: "remote_disable",
      requested_intent: "disabled",
      profile_state: "dedicated",
      serve_state: "absent",
      admission: "closed",
      serve_result: "removed"
    });
    expect(remoteIngressAuditSummarySchema.parse(successfulDisable)).toMatchObject({
      action: "remote_disable",
      outcome: "succeeded",
      admission: "closed",
      serve_state: "absent"
    });
    expect(remoteIngressAuditSummarySchema.safeParse({ ...successfulDisable, profile_state: "other" }).success).toBe(false);
    expect(remoteIngressAuditSummarySchema.safeParse({ ...successfulDisable, serve_state: "exact" }).success).toBe(false);

    const rejected = terminalAudit({
      outcome: "rejected",
      admission: "closed",
      intent_persisted: false,
      serve_result: "not_attempted",
      reason: "profile_other",
      profile_state: "other",
      serve_state: null
    });
    expect(remoteIngressAuditSummarySchema.parse(rejected)).toMatchObject({ outcome: "rejected", admission: "closed" });
    expect(remoteIngressAuditSummarySchema.safeParse({ ...rejected, intent_persisted: true }).success).toBe(false);
    expect(remoteIngressAuditSummarySchema.safeParse({ ...rejected, serve_result: "applied" }).success).toBe(false);

    const incomplete = terminalAudit({
      outcome: "incomplete",
      admission: "closed",
      serve_result: "unknown",
      reason: "command_timeout"
    });
    expect(remoteIngressAuditSummarySchema.parse(incomplete)).toMatchObject({ outcome: "incomplete", serve_result: "unknown" });
    expect(remoteIngressAuditSummarySchema.safeParse({ ...incomplete, outcome: "failed" }).success).toBe(false);
    expect(
      remoteIngressAuditSummarySchema.safeParse({
        ...incomplete,
        action: "remote_disable",
        requested_intent: "disabled",
        reason: "cleanup_incomplete",
        outcome: "failed"
      }).success
    ).toBe(false);
    expect(
      remoteIngressAuditSummarySchema.safeParse({
        ...incomplete,
        action: "remote_disable",
        requested_intent: "disabled",
        reason: "cleanup_incomplete",
        intent_persisted: false
      }).success
    ).toBe(false);
  });
});

function comparisonFor(relation: (typeof remoteProfileRelations)[number]) {
  switch (relation) {
    case "unconfigured":
      return { relation, expected_profile_key: null, active_profile_key: null };
    case "missing":
      return { relation, expected_profile_key: expectedProfile, active_profile_key: null };
    case "match":
      return { relation, expected_profile_key: expectedProfile, active_profile_key: expectedProfile };
    case "different":
      return { relation, expected_profile_key: expectedProfile, active_profile_key: otherProfile };
    case "unknown":
      return { relation, expected_profile_key: expectedProfile, active_profile_key: null };
  }
}

function profile(state: string, relation: string, expected: string | null, active: string | null) {
  return { state, comparison: { relation, expected_profile_key: expected, active_profile_key: active } };
}

function state(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schema_version: 1,
    generation: 7,
    intent: "enabled",
    availability: "ready",
    admission: "open",
    observation: "current",
    client: "available",
    profile: profile("dedicated", "match", expectedProfile, expectedProfile),
    serve: "exact",
    expected_serve: descriptor,
    external_origin: origin,
    operation_failure: null,
    reason: null,
    observed_at: timestamp,
    updated_at: timestamp,
    ...overrides
  };
}

function admittedRemote() {
  return {
    decision: "admitted",
    provenance: {
      kind: "admitted_remote",
      transport: "tailscale_serve_https",
      origin,
      remote_generation: 7,
      source_key: sourceKey,
      tailnet_identity_present: true,
      app_authorization: "not_evaluated"
    },
    headers: { forwarding: "exact", standard_identity: "present", untrusted_lookalike_present: false },
    reason: null
  };
}

function rejectedProxy(
  reason: (typeof remoteProxyTrustRejectionReasons)[number],
  forwarding: "absent" | "exact" | "invalid"
) {
  return {
    decision: "rejected",
    provenance: null,
    headers: {
      forwarding,
      standard_identity: reason === "standard_identity_invalid" ? "invalid" : "absent",
      untrusted_lookalike_present: reason === "untrusted_tailscale_lookalike"
    },
    reason
  };
}

function acceptedAudit(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schema_version: 1,
    action: "remote_enable",
    requested_intent: "enabled",
    profile_state: "dedicated",
    serve_state: "absent",
    phase: "accepted",
    outcome: "accepted",
    ...overrides
  };
}

function terminalAudit(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schema_version: 1,
    action: "remote_enable",
    requested_intent: "enabled",
    profile_state: "dedicated",
    serve_state: "exact",
    phase: "terminal",
    outcome: "succeeded",
    admission: "open",
    intent_persisted: true,
    serve_result: "applied",
    reason: null,
    ...overrides
  };
}
