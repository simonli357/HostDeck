import type { AddressInfo } from "node:net";
import {
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteServeDescriptorSchema
} from "@hostdeck/contracts";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createTailscaleObserver } from "./tailscale-observer.js";
import { createTailscaleServeManager } from "./tailscale-serve-manager.js";
import {
  createTailscaleServeProxyTrustPolicy,
  installTailscaleServeProxyTrustGate,
  type TailscaleServeRemoteAdmissionSnapshot,
  tailscaleServeProxyTrustSnapshot,
  tailscaleServeRequestIngressProvenance
} from "./tailscale-serve-proxy-trust.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_TAILSCALE_PROXY_TRUST_SMOKE === "1";
const describeSmoke = requireSmoke ? describe : describe.skip;
const cookie = "hostdeck_probe=opaque; Path=/; Secure; HttpOnly; SameSite=Strict";

describeSmoke("real Tailscale Serve proxy trust", () => {
  it("proves external context, overwrite behavior, rejection, cookie policy, and exact cleanup", async () => {
    const controller = new AbortController();
    let admission: TailscaleServeRemoteAdmissionSnapshot = closedAdmission(0);
    let handlerCalls = 0;
    let internalErrorCount = 0;
    const app = Fastify({ logger: false, trustProxy: false });
    const policy = createTailscaleServeProxyTrustPolicy({
      localOrigin: "http://127.0.0.1:3777",
      readRemoteAdmission: () => admission
    });
    installTailscaleServeProxyTrustGate(app, policy, () => {
      internalErrorCount += 1;
    });
    app.get("/probe", async (request, reply) => {
      handlerCalls += 1;
      const provenance = tailscaleServeRequestIngressProvenance(request);
      if (provenance.kind === "admitted_remote") reply.header("set-cookie", cookie);
      return {
        app_authorization: provenance.app_authorization,
        generation_matches: provenance.remote_generation === admission.generation,
        kind: provenance.kind,
        origin_matches: provenance.origin === admission.external_origin,
        source_key_valid: provenance.source_key?.startsWith("sha256:") ?? false,
        tailnet_identity_present: provenance.tailnet_identity_present,
        transport: provenance.transport
      };
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const observer = createTailscaleObserver({ signal: controller.signal });
    const manager = createTailscaleServeManager({ observer, signal: controller.signal });
    let descriptor: RemoteServeDescriptor | null = null;
    let expectedProfileKey: string | null = null;

    try {
      const port = listeningPort(app.server.address());
      const proxyOrigin = `http://127.0.0.1:${port}`;
      const local = await app.inject({
        headers: { host: "127.0.0.1:3777" },
        method: "GET",
        url: "/probe"
      });
      expect(local.statusCode, local.body).toBe(200);
      expect(local.json()).toMatchObject({
        app_authorization: "not_evaluated",
        kind: "local_loopback",
        transport: "loopback_http"
      });
      expect(local.headers["set-cookie"]).toBeUndefined();

      const candidate = await observer.observeCandidate();
      expect(candidate).toMatchObject({
        client: "available",
        failure: null,
        profile: { state: "dedicated", comparison: { relation: "match" } },
        serve: "absent"
      });
      expect(candidate.external_origin).not.toBeNull();
      expect(candidate.profile.comparison.active_profile_key).not.toBeNull();

      expectedProfileKey = candidate.profile.comparison.active_profile_key;
      descriptor = remoteServeDescriptorSchema.parse({
        external_origin: candidate.external_origin,
        https_port: 443,
        path: "/",
        proxy_origin: proxyOrigin,
        visibility: "private"
      });
      const enabled = await manager.enable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(enabled).toMatchObject({
        outcome: "succeeded",
        serve_result: "applied",
        reason: null,
        after: { serve: "exact", failure: null }
      });
      admission = openAdmission(descriptor.external_origin, 1);

      const normal = await externalFetch(descriptor.external_origin, "/probe");
      expect(normal.status).toBe(200);
      expect(await normal.json()).toMatchObject({
        app_authorization: "not_evaluated",
        generation_matches: true,
        kind: "admitted_remote",
        origin_matches: true,
        source_key_valid: true,
        transport: "tailscale_serve_https"
      });
      expectCookie(normal);

      const spoofed = await externalFetch(descriptor.external_origin, "/probe", {
        "tailscale-user-login": "partial-spoof@example.test",
        "x-forwarded-for": "192.0.2.10",
        "x-forwarded-host": "spoof.invalid",
        "x-forwarded-proto": "http"
      });
      expect(spoofed.status).toBe(200);
      expect(await spoofed.json()).toMatchObject({
        generation_matches: true,
        kind: "admitted_remote",
        origin_matches: true,
        source_key_valid: true
      });
      expectCookie(spoofed);

      const funnelSpoof = await externalFetch(descriptor.external_origin, "/probe", {
        "tailscale-funnel-request": "?1"
      });
      expect(funnelSpoof.status).toBe(200);
      expect(await funnelSpoof.json()).toMatchObject({ kind: "admitted_remote" });

      const lookalike = await externalFetch(descriptor.external_origin, "/probe", {
        "x-tailscale-user-login": "surviving-spoof@example.test"
      });
      expectRejected(lookalike);

      const wrongOrigin = await externalFetch(descriptor.external_origin, "/probe", {
        origin: "https://wrong.invalid"
      });
      expectRejected(wrongOrigin);

      const preflight = await fetch(new URL("/probe", descriptor.external_origin), {
        cache: "no-store",
        headers: {
          "access-control-request-method": "POST",
          connection: "close",
          origin: descriptor.external_origin
        },
        method: "OPTIONS",
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      expectRejected(preflight);

      expect(handlerCalls).toBe(4);
      expect(internalErrorCount).toBe(0);
      expect(tailscaleServeProxyTrustSnapshot(app)).toMatchObject({
        accepted_local_requests: 1,
        accepted_remote_requests: 3,
        cors_response_violations: 0,
        rejected_requests: {
          origin_mismatch: 1,
          unknown_proxy_context: 1,
          untrusted_tailscale_lookalike: 1
        }
      });

      admission = closedAdmission(2);
      const disabled = await manager.disable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(disabled).toMatchObject({
        outcome: "succeeded",
        serve_result: "removed",
        reason: null,
        after: { serve: "absent", failure: null }
      });
    } finally {
      admission = closedAdmission(admission.generation + 1);
      try {
        if (descriptor !== null && expectedProfileKey !== null) {
          await proveOrRestoreAbsent(observer, manager, expectedProfileKey, descriptor);
        }
      } finally {
        controller.abort();
        await app.close();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(process.getActiveResourcesInfo()).not.toContain("ChildProcess");
      }
    }
  });
});

async function externalFetch(
  origin: string,
  path: string,
  headers: Readonly<Record<string, string>> = {}
): Promise<Response> {
  return await fetch(new URL(path, origin), {
    cache: "no-store",
    headers: { connection: "close", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
}

function expectCookie(response: Response): void {
  const value = response.headers.get("set-cookie");
  expect(value).toBe(cookie);
  expect(value).toContain("Secure");
  expect(value).toContain("HttpOnly");
  expect(value).toContain("SameSite=Strict");
  expect(value).not.toMatch(/Domain=/iu);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

function expectRejected(response: Response): void {
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

function openAdmission(externalOrigin: string, generation: number): TailscaleServeRemoteAdmissionSnapshot {
  return Object.freeze({ admission: "open", external_origin: externalOrigin, generation });
}

function closedAdmission(generation: number): TailscaleServeRemoteAdmissionSnapshot {
  return Object.freeze({ admission: "closed", external_origin: null, generation });
}

function listeningPort(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") {
    throw new TypeError("Tailscale proxy trust smoke listener has no TCP address.");
  }
  return address.port;
}

async function proveOrRestoreAbsent(
  observer: ReturnType<typeof createTailscaleObserver>,
  manager: ReturnType<typeof createTailscaleServeManager>,
  expectedProfileKey: string,
  descriptor: RemoteServeDescriptor
): Promise<void> {
  const current = await observer.observeConfigured({
    expected_profile_key: expectedProfileKey,
    expected_serve: descriptor
  });
  assertOwnedCleanupState(current);
  if (current.serve === "exact") {
    const cleanup = await manager.disable({
      expected_profile_key: expectedProfileKey,
      expected_serve: descriptor
    });
    expect(cleanup).toMatchObject({
      outcome: "succeeded",
      serve_result: "removed",
      after: { serve: "absent", failure: null }
    });
    return;
  }
  expect(current.serve).toBe("absent");
}

function assertOwnedCleanupState(snapshot: RemoteIngressObservationSnapshot): void {
  expect(snapshot).toMatchObject({
    client: "available",
    failure: null,
    profile: { state: "dedicated", comparison: { relation: "match" } }
  });
  expect(["absent", "exact"]).toContain(snapshot.serve);
}
