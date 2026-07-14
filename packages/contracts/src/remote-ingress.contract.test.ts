import { describe, expect, it } from "vitest";
import {
  hostDeckLoopbackOriginSchema,
  projectRemoteIngressPublicState,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  remoteExternalOriginSchema,
  remoteIngressAuditSummarySchema,
  remoteIngressStateSchema,
  remotePairingLinkIntentSchema,
  remoteProfileObservationSchema,
  remoteProxyTrustDecisionSchema,
  remoteServeDescriptorSchema,
  tailscaleForwardingHeaderNames,
  tailscaleStandardIdentityHeaderNames,
  tailscaleUntrustedHeaderPrefix,
  tailscaleUntrustedLookalikeHeaderNames
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

describe("remote origin and Serve contracts", () => {
  it("accepts only canonical private Tailscale HTTPS origins and exact loopback targets", () => {
    expect(remoteExternalOriginSchema.parse(origin)).toBe(origin);
    expect(hostDeckLoopbackOriginSchema.parse("http://127.0.0.1:3777")).toBe("http://127.0.0.1:3777");
    expect(remoteServeDescriptorSchema.parse(descriptor)).toEqual(descriptor);

    for (const candidate of [
      "http://hostdeck-fixture.fixture-tailnet.ts.net",
      `${origin}/path`,
      `${origin}?query=1`,
      `${origin}#fragment`,
      "https://hostdeck-fixture.fixture-tailnet.ts.net:443",
      "https://HOSTDECK-FIXTURE.fixture-tailnet.ts.net",
      "https://fixture.invalid",
      "https://127.0.0.1",
      "https://user@hostdeck-fixture.fixture-tailnet.ts.net"
    ]) {
      expect(remoteExternalOriginSchema.safeParse(candidate).success, candidate).toBe(false);
    }
    for (const candidate of [
      "http://127.0.0.1",
      "http://localhost:3777",
      "http://0.0.0.0:3777",
      "https://127.0.0.1:3777",
      "http://127.0.0.1:3777/path"
    ]) {
      expect(hostDeckLoopbackOriginSchema.safeParse(candidate).success, candidate).toBe(false);
    }
    expect(remoteServeDescriptorSchema.safeParse({ ...descriptor, path: "/hostdeck" }).success).toBe(false);
    expect(remoteServeDescriptorSchema.safeParse({ ...descriptor, https_port: 8443 }).success).toBe(false);
    expect(remoteServeDescriptorSchema.safeParse({ ...descriptor, allow_funnel: true }).success).toBe(false);
  });
});

describe("remote route mutation contracts", () => {
  it("accepts only one confirmed operation id and no caller-supplied remote identity", () => {
    const enable = {
      operation_id: "op_remote_enable_contract_001",
      confirmed: true
    } as const;
    const disable = {
      operation_id: "op_remote_disable_contract_001",
      confirmed: true
    } as const;

    expect(remoteEnableRequestSchema.parse(enable)).toEqual(enable);
    expect(remoteDisableRequestSchema.parse(disable)).toEqual(disable);
    for (const candidate of [
      { ...enable, confirmed: false },
      { ...enable, operation_id: "remote-enable" },
      { ...enable, profile: "company" },
      { ...enable, tailscale_identity: "private@example.test" },
      { ...enable, node_key: "secret" },
      { ...enable, pairing_code: "secret" },
      { ...enable, external_origin: origin },
      { ...enable, repair: true }
    ]) {
      expect(remoteEnableRequestSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("remote profile comparison", () => {
  it.each([
    ["absent", "missing", expectedProfile, null],
    ["stopped", "match", expectedProfile, expectedProfile],
    ["signed_out", "unknown", expectedProfile, null],
    ["dedicated", "match", expectedProfile, expectedProfile],
    ["other", "different", expectedProfile, otherProfile],
    ["unknown", "unknown", expectedProfile, null]
  ] as const)("accepts the %s normalized profile state", (state, relation, expected, active) => {
    expect(
      remoteProfileObservationSchema.parse({
        state,
        comparison: { relation, expected_profile_key: expected, active_profile_key: active }
      }).state
    ).toBe(state);
  });

  it("rejects raw, malformed, and contradictory profile identity", () => {
    const candidates = [
      profile("dedicated", "different", expectedProfile, otherProfile),
      profile("other", "match", expectedProfile, expectedProfile),
      profile("absent", "match", expectedProfile, expectedProfile),
      profile("signed_out", "match", expectedProfile, expectedProfile),
      profile("unknown", "unknown", expectedProfile, otherProfile),
      profile("dedicated", "match", "profile-id", "profile-id"),
      { ...profile("dedicated", "match", expectedProfile, expectedProfile), account: "private@example.test" }
    ];
    for (const candidate of candidates) expect(remoteProfileObservationSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("remote ingress state", () => {
  it("accepts ready, disabled, fail-closed cleanup, and each unavailable evidence class", () => {
    expect(remoteIngressStateSchema.parse(state()).availability).toBe("ready");
    expect(
      remoteIngressStateSchema.parse(state({ intent: "disabled", availability: "disabled", admission: "closed" }))
    ).toMatchObject({ availability: "disabled", admission: "closed", reason: null });
    expect(
      remoteIngressStateSchema.parse(
        state({
          intent: "disabled",
          availability: "disabled",
          admission: "closed",
          operation_failure: "cleanup_incomplete",
          reason: "cleanup_incomplete"
        })
      )
    ).toMatchObject({ availability: "disabled", admission: "closed", serve: "exact" });

    const unavailable = [
      state({ availability: "unavailable", admission: "closed", profile: profile("stopped", "match", expectedProfile, expectedProfile), reason: "client_stopped" }),
      state({ availability: "unavailable", admission: "closed", profile: profile("signed_out", "unknown", expectedProfile, null), serve: null, reason: "client_signed_out" }),
      state({ availability: "unavailable", admission: "closed", profile: profile("other", "different", expectedProfile, otherProfile), serve: null, reason: "profile_other" }),
      state({ availability: "unavailable", admission: "closed", serve: "absent", reason: "serve_absent" }),
      state({ availability: "unavailable", admission: "closed", serve: "foreign", reason: "serve_foreign" }),
      state({ availability: "unavailable", admission: "closed", serve: "colliding", reason: "serve_colliding" }),
      state({ availability: "unavailable", admission: "closed", serve: "drifted", reason: "serve_drifted" }),
      state({ availability: "unavailable", admission: "closed", serve: "public", reason: "serve_public" }),
      state({ availability: "unavailable", admission: "closed", serve: "absent", operation_failure: "consent_required", reason: "consent_required" }),
      state({ availability: "unavailable", admission: "closed", serve: "absent", operation_failure: "permission_denied", reason: "permission_denied" })
    ];
    for (const candidate of unavailable) expect(remoteIngressStateSchema.parse(candidate).availability).toBe("unavailable");
  });

  it("rejects invented readiness, stale truth, raw output, secrets, and unknown required state", () => {
    const candidates = [
      state({ profile: profile("other", "different", expectedProfile, otherProfile) }),
      state({ availability: "ready", admission: "closed" }),
      state({ availability: "unavailable", admission: "closed", serve: "absent", reason: "serve_drifted" }),
      state({ observation: "stale" }),
      state({ observation: "failed", profile: profile("unknown", "unknown", expectedProfile, null), serve: null, observed_at: null }),
      state({ intent: "enabled", expected_serve: null, external_origin: null }),
      state({ client: "not_installed", profile: profile("dedicated", "match", expectedProfile, expectedProfile) }),
      state({ operation_failure: "cleanup_incomplete" }),
      state({ observed_at: "2026-07-13T16:00:01.000Z" }),
      { ...state(), BackendState: "Running" },
      { ...state(), node_key: "secret" },
      { ...state(), profile: { state: "future", comparison: profile("dedicated", "match", expectedProfile, expectedProfile).comparison } }
    ];
    for (const candidate of candidates) expect(remoteIngressStateSchema.safeParse(candidate).success).toBe(false);
  });

  it("projects only bounded actionable state for phone consumers", () => {
    expect(projectRemoteIngressPublicState(remoteIngressStateSchema.parse(state()))).toEqual({
      generation: 7,
      availability: "ready",
      reason: null,
      external_origin: origin,
      laptop_action_required: false,
      observed_at: timestamp
    });
    const disabled = remoteIngressStateSchema.parse(
      state({ intent: "disabled", availability: "disabled", admission: "closed" })
    );
    expect(projectRemoteIngressPublicState(disabled)).toMatchObject({
      availability: "disabled",
      reason: "remote_disabled",
      laptop_action_required: true
    });
    const cleanupIncomplete = remoteIngressStateSchema.parse(
      state({
        intent: "disabled",
        availability: "disabled",
        admission: "closed",
        operation_failure: "cleanup_incomplete",
        reason: "cleanup_incomplete"
      })
    );
    expect(projectRemoteIngressPublicState(cleanupIncomplete)).toMatchObject({
      availability: "disabled",
      reason: "cleanup_incomplete",
      laptop_action_required: true
    });
  });
});

describe("remote proxy provenance", () => {
  it("freezes exact standard names and keeps lookalikes separate", () => {
    expect(tailscaleForwardingHeaderNames).toEqual(["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);
    expect(tailscaleStandardIdentityHeaderNames).toEqual([
      "tailscale-headers-info",
      "tailscale-user-login",
      "tailscale-user-name",
      "tailscale-user-profile-pic"
    ]);
    expect(tailscaleUntrustedLookalikeHeaderNames).toEqual(["x-tailscale-user-login", "x-tailscale-user-name"]);
    expect(tailscaleUntrustedHeaderPrefix).toBe("x-tailscale-");
    expect(
      tailscaleUntrustedLookalikeHeaderNames.some((name) =>
        (tailscaleStandardIdentityHeaderNames as readonly string[]).includes(name)
      )
    ).toBe(false);
  });

  it("admits local and remote provenance without treating tailnet identity as authorization", () => {
    const local = remoteProxyTrustDecisionSchema.parse({
      decision: "admitted",
      provenance: {
        kind: "local_loopback",
        transport: "loopback_http",
        origin: "http://127.0.0.1:3777",
        remote_generation: null,
        source_key: null,
        tailnet_identity_present: false,
        app_authorization: "not_evaluated"
      },
      headers: { forwarding: "absent", standard_identity: "absent", untrusted_lookalike_present: false },
      reason: null
    });
    const remote = remoteProxyTrustDecisionSchema.parse(admittedRemote());

    expect(local.provenance?.kind).toBe("local_loopback");
    expect(remote.provenance).toMatchObject({
      kind: "admitted_remote",
      tailnet_identity_present: true,
      app_authorization: "not_evaluated"
    });
  });

  it("rejects lookalikes, missing provenance, identity contradictions, and raw source identity", () => {
    const candidates = [
      { ...admittedRemote(), headers: { forwarding: "exact", standard_identity: "present", untrusted_lookalike_present: true } },
      { ...admittedRemote(), provenance: null },
      { ...admittedRemote(), headers: { forwarding: "absent", standard_identity: "present", untrusted_lookalike_present: false } },
      { ...admittedRemote(), headers: { forwarding: "exact", standard_identity: "invalid", untrusted_lookalike_present: false } },
      { ...admittedRemote(), provenance: { ...admittedRemote().provenance, source_key: "100.64.0.1" } },
      {
        decision: "rejected",
        provenance: null,
        headers: { forwarding: "exact", standard_identity: "present", untrusted_lookalike_present: true },
        reason: "host_mismatch"
      },
      { ...admittedRemote(), identity_login: "private@example.test" }
    ];
    for (const candidate of candidates) expect(remoteProxyTrustDecisionSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("remote pairing and audit summaries", () => {
  it("requires fragment-only pairing intent without embedding the raw code", () => {
    const intent = {
      external_origin: origin,
      claim_path: "/pair",
      code_placement: "url_fragment",
      fragment_key: "code",
      strip_fragment_before_request: true,
      referrer_contains_code: false
    } as const;
    expect(remotePairingLinkIntentSchema.parse(intent)).toEqual(intent);
    for (const candidate of [
      { ...intent, code_placement: "query" },
      { ...intent, claim_path: "/pair?code=secret" },
      { ...intent, strip_fragment_before_request: false },
      { ...intent, raw_code: "abcdefghijklmnopqrstuv" },
      { ...intent, url: `${origin}/pair#code=abcdefghijklmnopqrstuv` }
    ]) {
      expect(remotePairingLinkIntentSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("keeps enable/disable audit truth bounded, secret-free, and fail-closed", () => {
    expect(
      remoteIngressAuditSummarySchema.parse({
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
        reason: null
      })
    ).toMatchObject({ outcome: "succeeded", admission: "open" });
    expect(
      remoteIngressAuditSummarySchema.parse({
        schema_version: 1,
        action: "remote_disable",
        requested_intent: "disabled",
        profile_state: "other",
        serve_state: null,
        phase: "terminal",
        outcome: "incomplete",
        admission: "closed",
        intent_persisted: true,
        serve_result: "unknown",
        reason: "cleanup_incomplete"
      })
    ).toMatchObject({ admission: "closed", reason: "cleanup_incomplete" });

    const invalid = [
      acceptedAudit({ action: "remote_enable", requested_intent: "disabled" }),
      terminalAudit({ action: "remote_disable", requested_intent: "disabled", admission: "open" }),
      terminalAudit({ outcome: "failed", reason: null }),
      terminalAudit({ outcome: "succeeded", intent_persisted: false }),
      { ...acceptedAudit(), account: "private@example.test" }
    ];
    for (const candidate of invalid) expect(remoteIngressAuditSummarySchema.safeParse(candidate).success).toBe(false);
  });
});

function profile(state: string, relation: string, expected: string | null, active: string | null) {
  return {
    state,
    comparison: { relation, expected_profile_key: expected, active_profile_key: active }
  };
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
