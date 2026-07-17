import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteServeDescriptorSchema,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createPairingCodeRepository,
  createSelectedAuditRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  requireHostDeckRequestAuthentication,
  resolveHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration
} from "./pairing-routes.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import { createTailscaleObserver } from "./tailscale-observer.js";
import { createTailscaleServeManager } from "./tailscale-serve-manager.js";
import {
  createTailscaleServeProxyTrustPolicy,
  type TailscaleServeRemoteAdmissionSnapshot
} from "./tailscale-serve-proxy-trust.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_TAILSCALE_AUTHORIZATION_SMOKE === "1";
const describeSmoke = requireSmoke ? describe : describe.skip;
const localOrigin = "http://127.0.0.1:3777";
const now = new Date("2026-07-13T23:00:00.000Z");
const rawPairingCode = "abcdefghijklmnopqrstuv";
const rawDeviceToken = "D".repeat(43);
const rawCsrfToken = "C".repeat(43);

describeSmoke("real Tailscale Serve request authorization", () => {
  it("proves remote pairing, paired read, identity non-authority, closure, and cleanup", async () => {
    const controller = new AbortController();
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-real-remote-auth-"));
    const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(now)
    });
    let admission: TailscaleServeRemoteAdmissionSnapshot = closedAdmission(0);
    const auth = createAuthDeviceRepository(opened.db);
    const pairing = createPairingCodeRepository(opened.db, {
      policy: defaultResourceBudget,
      generatePairingCode: () => rawPairingCode,
      generateDeviceId: () => "client_ABCDEFGHIJKLMNOPQRSTUVWX",
      generateDeviceToken: () => rawDeviceToken,
      generateCsrfToken: () => rawCsrfToken
    });
    const audit = createSelectedAuditRepository(opened.db);
    let auditIndex = 0;
    const auditExecutor = createSecurityMutationAuditExecutor({
      repository: audit,
      now: () => new Date(now.getTime() + auditIndex * 1_000).toISOString(),
      create_record_id: () => `audit:real:remote-auth:${auditIndex++}`
    });
    const pairingPolicy = createHostDeckPairingPolicy({
      pairing: {
        issue: (input) => pairing.issue(input),
        claim: (input) => pairing.claim(input)
      },
      now: () => new Date(now),
      createPairingId: () => "pair_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    const remoteRequestAuthority =
      createHostDeckRemoteIngressRequestAuthorityPolicy();
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
        now: () => new Date(now.getTime() + 1_000)
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        createHostDeckPairingRouteRegistration({
          audit: auditExecutor,
          pairing: pairingPolicy
        }),
        protectedRoute()
      ],
      remoteIngressRequestAuthority: remoteRequestAuthority,
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin,
        readRemoteAdmission: () =>
          remoteRequestAuthority.synchronize(admission)
      })
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const observer = createTailscaleObserver({ signal: controller.signal });
    const manager = createTailscaleServeManager({
      observer,
      signal: controller.signal
    });
    let descriptor: RemoteServeDescriptor | null = null;
    let expectedProfileKey: string | null = null;

    try {
      const issued = await app.inject({
        headers: {
          host: new URL(localOrigin).host,
          "content-type": "application/json"
        },
        method: "POST",
        payload: {
          operation_id: "op_real_remote_pair_issue_01",
          permission: "write",
          client_label: "Physical Android phone"
        },
        url: "/api/v1/access/pairing-codes"
      });
      expect(issued.statusCode, issued.body).toBe(200);
      expect(issued.json()).toMatchObject({ code: rawPairingCode });

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
        proxy_origin: `http://127.0.0.1:${listeningPort(app.server.address())}`,
        visibility: "private"
      });
      const enabled = await manager.enable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(enabled).toMatchObject({
        outcome: "succeeded",
        serve_result: "applied",
        after: { serve: "exact", failure: null }
      });
      admission = openAdmission(descriptor.external_origin, 1);

      const identityOnly = await externalFetch(
        descriptor.external_origin,
        "/protected"
      );
      expect(identityOnly.status).toBe(401);
      expect(identityOnly.headers.get("set-cookie")).toBeNull();

      const claim = await externalFetch(
        descriptor.external_origin,
        "/api/v1/access/pairing-claims",
        {
          method: "POST",
          origin: descriptor.external_origin,
          payload: {
            operation_id: "op_real_remote_pair_claim_01",
            code: rawPairingCode,
            client_label: "Physical Android phone"
          }
        }
      );
      expect(claim.status, await claim.clone().text()).toBe(200);
      const cookie = claim.headers.get("set-cookie");
      expect(cookie).not.toBeNull();
      expect(cookie).toContain(`${hostDeckDeviceCookieName}=${rawDeviceToken}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toMatch(/Domain=/iu);
      expect(await claim.text()).not.toContain(rawDeviceToken);
      if (cookie === null) throw new TypeError("Pair claim returned no device cookie.");
      const requestCookie = cookie.split(";", 1)[0];
      if (requestCookie === undefined) {
        throw new TypeError("Pair claim returned an invalid device cookie.");
      }

      const paired = await externalFetch(
        descriptor.external_origin,
        "/protected",
        { cookie: requestCookie }
      );
      expect(paired.status, await paired.clone().text()).toBe(200);
      expect(await paired.json()).toMatchObject({
        state: "paired_device",
        network_mode: "remote",
        permission: "write",
        transport: "https"
      });

      expect(
        opened.db
          .prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources")
          .get()
      ).toEqual({ count: 1 });
      admission = closedAdmission(2);
      const closed = await externalFetch(
        descriptor.external_origin,
        "/protected",
        { cookie: requestCookie }
      );
      expect(closed.status).toBe(403);
      expect(closed.headers.get("set-cookie")).toBeNull();

      const disabled = await manager.disable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(disabled).toMatchObject({
        outcome: "succeeded",
        serve_result: "removed",
        after: { serve: "absent", failure: null }
      });
    } finally {
      admission = closedAdmission(admission.generation + 1);
      try {
        if (descriptor !== null && expectedProfileKey !== null) {
          await proveOrRestoreAbsent(
            observer,
            manager,
            expectedProfileKey,
            descriptor
          );
        }
      } finally {
        controller.abort();
        await app.close();
        opened.db.close();
        rmSync(directory, { force: true, recursive: true });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(process.getActiveResourcesInfo()).not.toContain("ChildProcess");
      }
    }
  });
});

function protectedRoute(): HostDeckRoutePluginRegistration {
  return {
    id: "real-remote-authorization-protected",
    surface: "api",
    register(app) {
      app.get(
        "/protected",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => resolveHostDeckRequestAuthentication(request)
      );
    }
  };
}

async function externalFetch(
  origin: string,
  path: string,
  options: {
    readonly cookie?: string;
    readonly method?: "GET" | "POST";
    readonly origin?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = { connection: "close" };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.payload !== undefined) headers["content-type"] = "application/json";
  return await fetch(new URL(path, origin), {
    cache: "no-store",
    headers,
    method: options.method ?? "GET",
    ...(options.payload === undefined
      ? {}
      : { body: JSON.stringify(options.payload) }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
}

function openAdmission(
  externalOrigin: string,
  generation: number
): TailscaleServeRemoteAdmissionSnapshot {
  return Object.freeze({
    admission: "open",
    external_origin: externalOrigin,
    generation
  });
}

function closedAdmission(generation: number): TailscaleServeRemoteAdmissionSnapshot {
  return Object.freeze({ admission: "closed", external_origin: null, generation });
}

function listeningPort(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") {
    throw new TypeError("Tailscale authorization smoke listener has no TCP address.");
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
