import {
  projectRemoteIngressPublicState,
  remoteIngressAuditSummarySchema,
  remoteIngressStateSchema,
  remotePairingLinkIntentSchema,
  remoteProfileObservationSchema,
  remoteProxyTrustDecisionSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  readyRemoteIngressPublicState,
  readyRemoteIngressState,
  remoteFixtureOrigin,
  remoteFixtureOtherProfileKey,
  remoteFixtureProfileKey,
  remoteFixtureServeDescriptor,
  remoteFixtureSourceKey,
  remoteIngressAuditFixtures,
  remoteIngressFixtures,
  remotePairingLinkFixture,
  remoteProfileFixtures,
  remoteProxyFixtures,
  requiredRemoteIngressFixtureIds,
  requiredRemoteProfileFixtureIds,
  requiredRemoteProxyFixtureIds
} from "./remote-ingress.js";

describe("remote ingress fixture inventory", () => {
  it("contains every required profile, ingress, and proxy category exactly once", () => {
    expect(remoteProfileFixtures.map((fixture) => fixture.id)).toEqual(requiredRemoteProfileFixtureIds);
    expect(remoteIngressFixtures.map((fixture) => fixture.id)).toEqual(requiredRemoteIngressFixtureIds);
    expect(remoteProxyFixtures.map((fixture) => fixture.id)).toEqual(requiredRemoteProxyFixtureIds);
    expect(new Set(requiredRemoteProfileFixtureIds).size).toBe(requiredRemoteProfileFixtureIds.length);
    expect(new Set(requiredRemoteIngressFixtureIds).size).toBe(requiredRemoteIngressFixtureIds.length);
    expect(new Set(requiredRemoteProxyFixtureIds).size).toBe(requiredRemoteProxyFixtureIds.length);
  });

  it("round-trips every fixture through only public normalized contracts", () => {
    for (const fixture of remoteProfileFixtures) {
      expect(remoteProfileObservationSchema.parse(fixture.profile)).toEqual(fixture.profile);
    }
    for (const fixture of remoteIngressFixtures) {
      expect(remoteIngressStateSchema.parse(fixture.state)).toEqual(fixture.state);
      expect(projectRemoteIngressPublicState(fixture.state).availability).toBe(fixture.state.availability);
    }
    for (const fixture of remoteProxyFixtures) {
      expect(remoteProxyTrustDecisionSchema.parse(fixture.decision)).toEqual(fixture.decision);
    }
    expect(remotePairingLinkIntentSchema.parse(remotePairingLinkFixture)).toEqual(remotePairingLinkFixture);
    for (const fixture of remoteIngressAuditFixtures) {
      expect(remoteIngressAuditSummarySchema.parse(fixture)).toEqual(fixture);
    }
  });

  it("covers each frozen profile and Serve classification", () => {
    expect(new Set(remoteProfileFixtures.map((fixture) => fixture.profile.state))).toEqual(
      new Set(["absent", "stopped", "signed_out", "dedicated", "other", "unknown"])
    );
    expect(new Set(remoteIngressFixtures.map((fixture) => fixture.state.serve).filter((state) => state !== null))).toEqual(
      new Set(["absent", "exact", "foreign", "colliding", "drifted", "public"])
    );
  });

  it("covers disabled, ready, unavailable, operation-failure, and fail-closed cleanup truth", () => {
    expect(new Set(remoteIngressFixtures.map((fixture) => fixture.state.availability))).toEqual(
      new Set(["disabled", "ready", "unavailable"])
    );
    expect(remoteIngressFixtures.find((fixture) => fixture.id === "disabled_cleanup_incomplete")?.state).toMatchObject({
      intent: "disabled",
      admission: "closed",
      reason: "cleanup_incomplete"
    });
    for (const id of [
      "consent_required",
      "permission_denied",
      "command_failed",
      "command_timeout",
      "output_oversized",
      "schema_invalid",
      "profile_changed"
    ] as const) {
      expect(remoteIngressFixtures.find((fixture) => fixture.id === id)?.state).toMatchObject({
        availability: "unavailable",
        admission: "closed",
        operation_failure: id,
        reason: id
      });
    }
  });

  it("covers both audit actions, every terminal outcome, and idempotent Serve results", () => {
    expect(new Set(remoteIngressAuditFixtures.map((fixture) => fixture.action))).toEqual(new Set(["remote_enable", "remote_disable"]));
    expect(new Set(remoteIngressAuditFixtures.filter((fixture) => fixture.phase === "terminal").map((fixture) => fixture.outcome))).toEqual(
      new Set(["succeeded", "failed", "rejected", "incomplete"])
    );
    expect(
      remoteIngressAuditFixtures.some((fixture) => fixture.phase === "accepted" && fixture.action === "remote_enable" && fixture.serve_state === "exact")
    ).toBe(true);
    expect(
      new Set(remoteIngressAuditFixtures.flatMap((fixture) => (fixture.phase === "terminal" && fixture.outcome === "succeeded" ? [fixture.serve_result] : [])))
    ).toEqual(new Set(["applied", "unchanged", "removed"]));
  });

  it("keeps admitted ingress separate from application authorization", () => {
    const admitted = remoteProxyFixtures.filter((fixture) => fixture.decision.decision === "admitted");
    expect(admitted).toHaveLength(3);
    for (const fixture of admitted) {
      expect(fixture.decision.provenance?.app_authorization).toBe("not_evaluated");
    }
    expect(remoteProxyFixtures.find((fixture) => fixture.id === "reject_untrusted_lookalike")?.decision).toMatchObject({
      decision: "rejected",
      provenance: null,
      reason: "untrusted_tailscale_lookalike"
    });
  });

  it("contains no raw Tailscale payload, reusable identity, or pairing secret fields", () => {
    const fixtures = {
      profiles: remoteProfileFixtures,
      ingress: remoteIngressFixtures,
      proxy: remoteProxyFixtures,
      pairing: remotePairingLinkFixture,
      audit: remoteIngressAuditFixtures
    };
    const keys = collectKeys(fixtures);
    const strings = collectStrings(fixtures);

    for (const forbidden of [
      "AuthURL",
      "BackendState",
      "CertDomains",
      "CurrentTailnet",
      "HaveNodeKey",
      "MagicDNSSuffix",
      "TailscaleIPs",
      "account",
      "nickname",
      "node_key",
      "raw_output",
      "pairing_code",
      "cookie",
      "token"
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    for (const key of keys) {
      expect(key).not.toMatch(
        /^(?:account|auth_key|auth_url|cookie|credential|csrf_token|device_token|email|login|node_id|node_key|oauth|pairing_code|password|raw_output|refresh_token|secret|tailnet_id)$/iu
      );
    }
    expect(strings).toContain(remoteFixtureOrigin);
    expect(strings.some((value) => value.includes("@"))).toBe(false);
    expect(strings.some((value) => /^100\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(value))).toBe(false);
    const comparisonKeys = strings.filter((value) => value.startsWith("sha256:"));
    expect(new Set(comparisonKeys)).toEqual(new Set([remoteFixtureProfileKey, remoteFixtureOtherProfileKey, remoteFixtureSourceKey]));
  });

  it("deep-freezes every exported remote fixture graph", () => {
    for (const value of [
      remoteFixtureServeDescriptor,
      requiredRemoteProfileFixtureIds,
      requiredRemoteIngressFixtureIds,
      requiredRemoteProxyFixtureIds,
      remoteProfileFixtures,
      remoteIngressFixtures,
      remoteProxyFixtures,
      remotePairingLinkFixture,
      remoteIngressAuditFixtures,
      readyRemoteIngressState,
      readyRemoteIngressPublicState
    ]) {
      expect(isDeepFrozen(value)).toBe(true);
    }
  });

  it("parses repeatedly without mutating shared fixture state", async () => {
    const before = JSON.stringify(remoteIngressFixtures);
    const passes = await Promise.all(
      Array.from({ length: 32 }, async () => remoteIngressFixtures.map((fixture) => remoteIngressStateSchema.parse(fixture.state)))
    );
    expect(passes).toHaveLength(32);
    expect(passes.every((pass) => pass.length === requiredRemoteIngressFixtureIds.length)).toBe(true);
    expect(JSON.stringify(remoteIngressFixtures)).toBe(before);
  });
});

function collectKeys(value: unknown, keys: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const child of value) collectKeys(child, keys);
    return keys;
  }
  if (value === null || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
}

function collectStrings(value: unknown, strings: string[] = []): readonly string[] {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, strings);
    return strings;
  }
  if (value === null || typeof value !== "object") return strings;
  for (const child of Object.values(value)) collectStrings(child, strings);
  return strings;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeepFrozen(child));
}
