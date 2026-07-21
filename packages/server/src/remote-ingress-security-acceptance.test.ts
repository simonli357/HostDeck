import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage
} from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  codexThreadIdSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  type PromptTurnControlSnapshot,
  type RemoteIngressObservationSnapshot,
  type ResourceBudget,
  type RuntimeCompatibility,
  remoteIngressObservationSnapshotSchema,
  resolveResourceBudget,
  runtimeCompatibilitySchema,
  selectedProjectionEventSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { runtimeCapabilities } from "@hostdeck/core";
import {
  createAuthDeviceRepository,
  createDeviceListingRepository,
  createDeviceRevocationRepository,
  createPairingCodeRepository,
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSettingsRepository,
  openMigratedDatabase,
  type SelectedSessionState
} from "@hostdeck/storage";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration
} from "./csrf-routes.js";
import { createHostDeckDeviceListRouteRegistration } from "./device-list-routes.js";
import { createHostDeckDeviceRevokeRouteRegistration } from "./device-revoke-routes.js";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import {
  type HostDeckFastifyLifecycle,
  startHostDeckTailscaleServeFastifyLifecycle
} from "./fastify-host-lifecycle.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import { createHostDeckSseTransportRegistration } from "./fastify-sse-transport.js";
import { createHostDeckHostHealthService } from "./host-health.js";
import {
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration
} from "./host-lock-routes.js";
import {
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  hostDeckPairingPolicySnapshot
} from "./pairing-routes.js";
import { createHostDeckPromptRouteRegistration } from "./prompt-routes.js";
import { createRemoteIngressControlService } from "./remote-ingress-control-service.js";
import {
  createHostDeckRemoteIngressLifecycle,
  type HostDeckRemoteIngressLifecycle
} from "./remote-ingress-lifecycle.js";
import { createHostDeckRemoteIngressRouteRegistration } from "./remote-ingress-routes.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";
import type { TailscaleObserver } from "./tailscale-observer.js";
import type {
  TailscaleServeManager,
  TailscaleServeManagerResult,
  TailscaleServeMutationInput
} from "./tailscale-serve-manager.js";

const externalOrigin = "https://hostdeck-acceptance.fixture-tailnet.ts.net";
const profileKey = `sha256:${"1".repeat(64)}`;
const otherProfileKey = `sha256:${"2".repeat(64)}`;
const sourceAddress = "100.64.0.42";
const otherSourceAddress = "100.64.0.43";
const timestamp = "2026-07-16T16:00:00.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_remote_acceptance_001";
const threadId = codexThreadIdSchema.parse("thread-remote-acceptance-001");
const protectedMarker = "hostdeck-remote-acceptance-marker";
const protectedReadPath = "/__acceptance/v1/read";
const protectedSsePath = "/__acceptance/v1/events";
const promptPath = `/api/v1/sessions/${sessionId}/prompts`;
const roots: string[] = [];
const harnesses: RemoteAcceptanceHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close();
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-079 selected remote ingress aggregate acceptance", () => {
  it("composes enable, pairing, CSRF, exact write, profile recovery, lock, revoke, SSE, and shutdown", async () => {
    const harness = await createHarness();
    expect(harness.host.snapshot()).toMatchObject({
      bound: { host: "127.0.0.1", transport: "http" },
      listening: true,
      phase: "ready"
    });
    expect(harness.remote.snapshot()).toMatchObject({
      phase: "running",
      authority: { active_leases: 0 }
    });

    const disabled = await harness.local("GET", "/api/v1/remote/status");
    expect(disabled.status).toBe(200);
    expect(disabled.json()).toMatchObject({ availability: "disabled" });
    expect(harness.calls.manager).toBe(0);

    const enable = await harness.local("POST", "/api/v1/remote/enable", {
      operation_id: "op_remote_acceptance_enable_0001",
      confirmed: true
    });
    expect(enable.status, enable.body).toBe(200);
    expect(enable.json()).toMatchObject({ availability: "ready" });
    expect(harness.calls.manager).toBe(1);
    expect(harness.remote.readAdmission()).toMatchObject({
      admission: "open",
      external_origin: externalOrigin
    });

    const unpaired = await harness.remoteRequest("GET", protectedReadPath);
    expect(unpaired.status).toBe(401);
    expect(unpaired.body).not.toContain(protectedMarker);
    expect(unpaired.headers["access-control-allow-origin"]).toBeUndefined();

    const issue = await harness.local("POST", "/api/v1/access/pairing-codes", {
      operation_id: "op_remote_acceptance_pair_issue_0001",
      permission: "write",
      client_label: "Aggregate Android"
    });
    expect(issue.status, issue.body).toBe(200);
    const pairingCode = requireString(issue.json().code);
    harness.secrets.add(pairingCode);
    const claim = await harness.remoteRequest(
      "POST",
      "/api/v1/access/pairing-claims",
      {
        operation_id: "op_remote_acceptance_pair_claim_0001",
        code: pairingCode,
        client_label: "Aggregate Android"
      }
    );
    expect(claim.status, claim.body).toBe(200);
    const deviceId = requireString(claim.json().device_id);
    const setCookie = singleSetCookie(claim.headers);
    assertHardenedDeviceCookie(setCookie, false);
    const cookie = cookiePair(setCookie);
    harness.secrets.add(cookie.slice(cookie.indexOf("=") + 1));

    const bootstrap = await harness.remoteRequest(
      "POST",
      "/api/v1/access/csrf",
      { operation_id: "op_remote_acceptance_csrf_0001" },
      { cookie }
    );
    expect(bootstrap.status, bootstrap.body).toBe(200);
    const csrf = Object.freeze({
      generation: requireNumber(bootstrap.json().csrf_generation),
      token: requireString(bootstrap.json().csrf_token)
    });
    harness.secrets.add(csrf.token);

    const read = await harness.remoteRequest("GET", protectedReadPath, undefined, {
      cookie
    });
    expect(read.status).toBe(200);
    expect(read.json()).toEqual({ protected_marker: protectedMarker });

    const prompt = await harness.remoteRequest(
      "POST",
      promptPath,
      {
        operation_id: "op_remote_acceptance_prompt_0001",
        kind: "prompt",
        text: "Run one bounded aggregate acceptance write."
      },
      { cookie, csrf }
    );
    expect(
      prompt.status,
      `${prompt.body}\n${JSON.stringify(harness.internalErrors)}`
    ).toBe(202);
    expect(prompt.json()).toMatchObject({
      operation_id: "op_remote_acceptance_prompt_0001",
      state: "accepted"
    });
    expect(harness.calls.promptDispatch).toBe(1);
    expect(
      harness.audit.require("op_remote_acceptance_prompt_0001").records.map((row) => [
        row.phase,
        row.outcome
      ])
    ).toEqual([
      ["accepted", "accepted"],
      ["terminal", "succeeded"]
    ]);

    const firstStream = harness.openRemoteSse(cookie);
    expect((await firstStream.firstEvent).body).toContain("event: message");
    expect(harness.sse.active).toBe(1);
    const managerCallsBeforeAway = harness.calls.manager;
    harness.environment.setProfile("other");
    const away = await harness.remote.control.readStatus();
    expect(away).toMatchObject({
      availability: "unavailable",
      reason: "profile_other"
    });
    await firstStream.closed;
    expect(harness.remote.snapshot().authority.active_leases).toBe(0);
    expect(harness.sse.active).toBe(0);
    expect(harness.calls.manager).toBe(managerCallsBeforeAway);
    expect(
      await harness.remoteRequest("GET", protectedReadPath, undefined, { cookie })
    ).toMatchObject({ status: 403 });
    expect(
      await harness.local("GET", "/api/v1/remote/status")
    ).toMatchObject({ status: 200 });

    harness.environment.setProfile("dedicated");
    const recovered = await harness.remote.control.readStatus();
    expect(recovered).toMatchObject({ availability: "ready", reason: null });
    expect(harness.calls.manager).toBe(managerCallsBeforeAway);
    expect(
      await harness.remoteRequest("GET", protectedReadPath, undefined, { cookie })
    ).toMatchObject({ status: 200 });

    harness.environment.setServe("drifted");
    expect(await harness.remote.control.readStatus()).toMatchObject({
      availability: "unavailable",
      reason: "serve_drifted"
    });
    expect(harness.calls.manager).toBe(managerCallsBeforeAway);
    expect(
      await harness.remoteRequest("GET", protectedReadPath, undefined, { cookie })
    ).toMatchObject({ status: 403 });
    harness.environment.setServe("exact");
    expect(await harness.remote.control.readStatus()).toMatchObject({
      availability: "ready",
      reason: null
    });
    expect(harness.calls.manager).toBe(managerCallsBeforeAway);

    const lock = await harness.remoteRequest(
      "POST",
      "/api/v1/access/lock",
      { operation_id: "op_remote_acceptance_lock_0001", confirmed: true },
      { cookie, csrf }
    );
    expect(lock.status, lock.body).toBe(200);
    const lockedPrompt = await harness.remoteRequest(
      "POST",
      promptPath,
      {
        operation_id: "op_remote_acceptance_prompt_locked_0001",
        kind: "prompt",
        text: "This must not dispatch."
      },
      { cookie, csrf }
    );
    expect(lockedPrompt.status).toBe(423);
    expect(harness.calls.promptDispatch).toBe(1);
    expect(harness.audit.get("op_remote_acceptance_prompt_locked_0001")).toBeNull();
    expect(
      await harness.remoteRequest(
        "POST",
        "/api/v1/access/unlock",
        { operation_id: "op_remote_acceptance_remote_unlock_0001", confirmed: true },
        { cookie, csrf }
      )
    ).toMatchObject({ status: 403 });
    expect(
      await harness.local("POST", "/api/v1/access/unlock", {
        operation_id: "op_remote_acceptance_local_unlock_0001",
        confirmed: true
      })
    ).toMatchObject({ status: 200 });

    const secondStream = harness.openRemoteSse(cookie);
    await secondStream.firstEvent;
    expect(harness.sse.active).toBe(1);
    const revoke = await harness.remoteRequest(
      "POST",
      `/api/v1/access/devices/${deviceId}/revoke`,
      { operation_id: "op_remote_acceptance_revoke_0001", confirmed: true },
      { cookie, csrf }
    );
    expect(revoke.status, revoke.body).toBe(200);
    expect(revoke.json()).toMatchObject({ self_revoked: true });
    assertHardenedDeviceCookie(singleSetCookie(revoke.headers), true);
    await secondStream.closed;
    expect(harness.sse.active).toBe(0);
    expect(
      await harness.remoteRequest("GET", protectedReadPath, undefined, { cookie })
    ).toMatchObject({ status: 401 });

    const disable = await harness.local("POST", "/api/v1/remote/disable", {
      operation_id: "op_remote_acceptance_disable_0001",
      confirmed: true
    });
    expect(disable.status, disable.body).toBe(200);
    expect(disable.json()).toMatchObject({ availability: "disabled" });
    expect(harness.calls.manager).toBe(2);
    expect(harness.remote.readAdmission()).toMatchObject({ admission: "closed" });
    expect(hostDeckPairingPolicySnapshot(harness.pairingPolicy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      claim_successes: 1
    });
    expect(harness.scanSecrets()).toEqual({ checked: 4, leaks: 0 });

    await harness.close();
    expect(harness.remote.snapshot()).toMatchObject({
      phase: "closed",
      authority: { active_leases: 0 }
    });
    expect(harness.host.snapshot()).toMatchObject({ listening: false, phase: "closed" });
    expect(harness.closedDatabase()).toBe(true);
  }, 30_000);

  it("rejects combined proxy, origin, identity, and credential attacks before protected work", async () => {
    const harness = await createHarness();
    await enableHarness(harness, "op_remote_acceptance_hostile_enable_0001");
    const seeded = harness.seedWriter();
    const baseline = Object.freeze({
      auth: harness.calls.authentication,
      dispatch: harness.calls.promptDispatch,
      audit: harness.auditCount()
    });

    const hostile = [
      { host: "attacker.invalid" },
      { origin: "https://attacker.invalid" },
      { origin: "null" },
      { forwardedFor: "127.0.0.1" },
      { forwardedProto: "http" },
      { forwardedHost: "attacker.invalid" },
      { extra: { "x-tailscale-user-login": "spoofed@example.test" } },
      {
        extra: {
          "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
          "tailscale-user-login": "partial@example.test"
        }
      },
      { extra: { "x-forwarded-port": "443" } },
      { extra: { "tailscale-funnel-request": "1" } }
    ] as const;

    for (const attack of hostile) {
      const response = await harness.remoteRequest(
        "POST",
        promptPath,
        {
          operation_id: "op_remote_acceptance_hostile_prompt_0001",
          kind: "prompt",
          text: "Rejected hostile request."
        },
        {
          cookie: seeded.cookie,
          csrf: seeded.csrf,
          ...attack
        }
      );
      expect([400, 403]).toContain(response.status);
      expect(response.body).not.toContain(protectedMarker);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["set-cookie"]).toBeUndefined();
    }

    const unsafeMissingOrigin = await harness.remoteRequest(
      "POST",
      promptPath,
      {
        operation_id: "op_remote_acceptance_missing_origin_0001",
        kind: "prompt",
        text: "Rejected missing origin."
      },
      {
        cookie: seeded.cookie,
        csrf: seeded.csrf,
        origin: null,
        extra: { "sec-fetch-site": "same-origin" }
      }
    );
    expect(unsafeMissingOrigin.status).toBe(403);
    expect(harness.calls.promptDispatch).toBe(baseline.dispatch);
    expect(harness.audit.get("op_remote_acceptance_hostile_prompt_0001")).toBeNull();
    expect(harness.audit.get("op_remote_acceptance_missing_origin_0001")).toBeNull();
    expect(harness.auditCount()).toBe(baseline.audit);
    expect(harness.calls.authentication).toBeGreaterThanOrEqual(baseline.auth);
    expect(harness.remote.snapshot().authority.active_leases).toBe(0);
  }, 30_000);

  it("enforces source/global claim concurrency and keeps foreign profile state mutation-free", async () => {
    const harness = await createHarness({
      holdFirstClaim: true,
      resourceBudget: resolveResourceBudget({
        pair_claim_max_in_flight: 1,
        pair_claim_max_in_flight_per_source: 1
      })
    });
    await enableHarness(harness, "op_remote_acceptance_limits_enable_0001");
    const firstCode = await issueCode(
      harness,
      "op_remote_acceptance_limits_issue_0001"
    );
    const firstClaim = harness.remoteRequest(
      "POST",
      "/api/v1/access/pairing-claims",
      {
        operation_id: "op_remote_acceptance_limits_claim_0001",
        code: firstCode,
        client_label: "Held claim"
      },
      { source: sourceAddress }
    );
    await harness.claimStarted;
    const overlap = await harness.remoteRequest(
      "POST",
      "/api/v1/access/pairing-claims",
      {
        operation_id: "op_remote_acceptance_limits_claim_0002",
        code: firstCode,
        client_label: "Overlap claim"
      },
      { source: sourceAddress }
    );
    expect(overlap.status).toBe(503);
    expect(overlap.headers["set-cookie"]).toBeUndefined();
    const otherSource = await harness.remoteRequest(
      "POST",
      "/api/v1/access/pairing-claims",
      {
        operation_id: "op_remote_acceptance_limits_claim_0003",
        code: firstCode,
        client_label: "Global overlap"
      },
      { source: otherSourceAddress }
    );
    expect(otherSource.status).toBe(503);
    expect(otherSource.headers["set-cookie"]).toBeUndefined();
    harness.releaseClaim();
    expect((await firstClaim).status).toBe(200);
    expect(hostDeckPairingPolicySnapshot(harness.pairingPolicy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      global_admission_rejections: 1,
      source_admission_rejections: 1
    });

    const managerCalls = harness.calls.manager;
    const foreignBefore = harness.environment.foreignServeBytes();
    harness.environment.setProfile("other");
    expect(await harness.remote.control.readStatus()).toMatchObject({
      availability: "unavailable",
      reason: "profile_other"
    });
    expect(harness.calls.manager).toBe(managerCalls);
    expect(harness.environment.foreignServeBytes()).toBe(foreignBefore);
    const remoteEnable = await harness.remoteRequest(
      "POST",
      "/api/v1/remote/enable",
      {
        operation_id: "op_remote_acceptance_remote_enable_denied_0001",
        confirmed: true
      }
    );
    expect(remoteEnable.status).toBe(403);
    expect(harness.calls.manager).toBe(managerCalls);
    expect(harness.environment.foreignServeBytes()).toBe(foreignBefore);
  }, 30_000);

  it("fails closed on a profile-switch disable race without retry or foreign Serve mutation", async () => {
    const harness = await createHarness();
    await enableHarness(harness, "op_remote_acceptance_race_enable_0001");
    const callsBeforeDisable = harness.calls.manager;
    const foreignBefore = harness.environment.foreignServeBytes();
    harness.environment.setProfile("other");

    const disable = await harness.local("POST", "/api/v1/remote/disable", {
      operation_id: "op_remote_acceptance_race_disable_0001",
      confirmed: true
    });
    expect(disable.status).toBe(409);
    expect(disable.json()).toMatchObject({
      error: { code: "operation_conflict", retryable: false }
    });
    expect(harness.calls.manager).toBe(callsBeforeDisable + 1);
    expect(harness.remote.readAdmission()).toMatchObject({ admission: "closed" });
    expect(harness.environment.foreignServeBytes()).toBe(foreignBefore);

    const firstStatus = await harness.local("GET", "/api/v1/remote/status");
    const secondStatus = await harness.local("GET", "/api/v1/remote/status");
    expect(firstStatus.status).toBe(200);
    expect(firstStatus.json()).toMatchObject({
      availability: "disabled",
      reason: "cleanup_incomplete"
    });
    expect(secondStatus.json()).toMatchObject({
      availability: "disabled",
      reason: "cleanup_incomplete"
    });
    expect(harness.calls.manager).toBe(callsBeforeDisable + 1);
    expect(harness.environment.foreignServeBytes()).toBe(foreignBefore);
    expect(
      harness.audit.require("op_remote_acceptance_race_disable_0001")
    ).toMatchObject({
      state: "terminal",
      records: [
        { phase: "accepted", outcome: "accepted" },
        { phase: "terminal", outcome: "incomplete" }
      ]
    });
  }, 30_000);
});

interface RemoteAcceptanceHarness {
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly calls: {
    authentication: number;
    candidate: number;
    configured: number;
    manager: number;
    promptDispatch: number;
  };
  readonly claimStarted: Promise<void>;
  readonly closedDatabase: () => boolean;
  readonly environment: FakeTailscaleEnvironment;
  readonly host: HostDeckFastifyLifecycle<{ readonly remote: HostDeckRemoteIngressLifecycle }>;
  readonly internalErrors: readonly unknown[];
  readonly pairingPolicy: ReturnType<typeof createHostDeckPairingPolicy>;
  readonly remote: HostDeckRemoteIngressLifecycle;
  readonly secrets: Set<string>;
  readonly sse: { active: number; closed: number };
  readonly auditCount: () => number;
  readonly close: () => Promise<void>;
  readonly local: (
    method: "GET" | "POST",
    path: string,
    body?: Readonly<Record<string, unknown>>
  ) => Promise<HttpResponse>;
  readonly openRemoteSse: (cookie: string) => OpenSse;
  readonly releaseClaim: () => void;
  readonly remoteRequest: (
    method: "GET" | "OPTIONS" | "POST",
    path: string,
    body?: Readonly<Record<string, unknown>>,
    options?: RemoteRequestOptions
  ) => Promise<HttpResponse>;
  readonly scanSecrets: () => { readonly checked: number; readonly leaks: number };
  readonly seedWriter: () => {
    readonly cookie: string;
    readonly csrf: CsrfHeaders;
  };
}

interface CreateHarnessOptions {
  readonly holdFirstClaim?: boolean;
  readonly resourceBudget?: ResourceBudget;
}

interface CsrfHeaders {
  readonly generation: number;
  readonly token: string;
}

interface RemoteRequestOptions {
  readonly cookie?: string;
  readonly csrf?: CsrfHeaders;
  readonly extra?: Readonly<Record<string, string>>;
  readonly forwardedFor?: string;
  readonly forwardedHost?: string;
  readonly forwardedProto?: string;
  readonly host?: string;
  readonly origin?: string | null;
  readonly source?: string;
}

interface HttpResponse {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly status: number;
  readonly json: () => Record<string, unknown>;
}

interface OpenSse {
  readonly closed: Promise<void>;
  readonly firstEvent: Promise<{ readonly body: string }>;
}

async function createHarness(
  options: CreateHarnessOptions = {}
): Promise<RemoteAcceptanceHarness> {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-remote-acceptance-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  const databasePath = join(stateDirectory, "hostdeck.sqlite");
  let wallTime = Date.parse(timestamp);
  const now = () => new Date(wallTime++);
  const opened = openMigratedDatabase(databasePath, { now });
  const port = await reserveLoopbackPort();
  const localOrigin = `http://127.0.0.1:${port}`;
  const resourceBudget = options.resourceBudget ?? defaultResourceBudget;
  const settings = createSettingsRepository(opened.db);
  settings.getOrCreateDefault({ bindPort: port, now, stateDir: stateDirectory });

  const audit = createSelectedAuditRepository(opened.db);
  let auditId = 0;
  const securityAudit = createSecurityMutationAuditExecutor({
    repository: audit,
    now: () => now().toISOString(),
    create_record_id: () => `audit:remote-acceptance:security:${++auditId}`
  });
  const selectedWriteAudit = createHostDeckSelectedWriteAuditExecutor({
    repository: audit,
    now: () => now().toISOString(),
    create_record_id: () => `audit:remote-acceptance:write:${++auditId}`
  });
  const states = createRemoteIngressStateRepository(opened.db);
  const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
  const environment = createFakeTailscaleEnvironment(localOrigin);
  const calls = {
    authentication: 0,
    candidate: 0,
    configured: 0,
    manager: 0,
    promptDispatch: 0
  };
  const observer: TailscaleObserver = Object.freeze({
    poll_interval_ms: 60_000,
    async observeCandidate() {
      calls.candidate += 1;
      return environment.observe();
    },
    async observeConfigured() {
      calls.configured += 1;
      return environment.observe();
    }
  });
  const manager: TailscaleServeManager = Object.freeze({
    async enable(input: TailscaleServeMutationInput) {
      calls.manager += 1;
      return environment.enable(input);
    },
    async disable(input: TailscaleServeMutationInput) {
      calls.manager += 1;
      return environment.disable(input);
    },
    snapshot() {
      return Object.freeze({
        active: false,
        busy_rejections: 0,
        command_attempts: calls.manager,
        failed_operations: 0,
        incomplete_operations: 0,
        rejected_operations: 0,
        started_operations: calls.manager,
        succeeded_operations: calls.manager
      });
    }
  });
  const health = createHostDeckHostHealthService({ now });
  const remote = createHostDeckRemoteIngressLifecycle({
    createControl(input) {
      return createRemoteIngressControlService({
        admissionProofs: proofs,
        audit: securityAudit,
        localOrigin,
        manager,
        monotonicNow: input.monotonicNow,
        now,
        observer,
        states
      });
    },
    health
  });

  const secrets = new Set<string>();
  const auth = createAuthDeviceRepository(opened.db);
  const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken(input) {
      calls.authentication += 1;
      secrets.add(input.rawDeviceToken);
      return auth.authenticateDeviceToken(input);
    },
    now
  });
  let secretIndex = 0;
  const nextSecret = (prefix: string, length: number): string => {
    secretIndex += 1;
    const suffix = String(secretIndex);
    return `${prefix.repeat(length)}${suffix}`.slice(-length);
  };
  const pairing = createPairingCodeRepository(opened.db, {
    policy: resourceBudget,
    generatePairingCode: () => nextSecret("P", 22),
    generateDeviceId: () => `client_${nextSecret("d", 24)}`,
    generateDeviceToken: () => nextSecret("D", 43),
    generateCsrfToken: () => nextSecret("C", 43)
  });
  let releaseClaim: () => void = () => undefined;
  let markClaimStarted: () => void = () => undefined;
  const claimRelease = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const claimStarted = new Promise<void>((resolve) => {
    markClaimStarted = resolve;
  });
  let heldClaim = false;
  if (options.holdFirstClaim !== true) markClaimStarted();
  let pairingId = 0;
  const pairingPolicy = createHostDeckPairingPolicy({
    pairing: {
      issue(input) {
        const result = pairing.issue(input);
        secrets.add(result.rawCode);
        return result;
      },
      claim(input) {
        secrets.add(input.rawCode);
        const result = pairing.claim(input);
        secrets.add(result.rawDeviceToken);
        secrets.add(result.rawCsrfToken);
        if (options.holdFirstClaim !== true || heldClaim) return result;
        heldClaim = true;
        markClaimStarted();
        return claimRelease.then(() => result);
      }
    },
    now,
    createPairingId: () => `pair_${String(++pairingId).padStart(24, "0")}`
  });
  const csrfRepository = createSelectedCsrfAuthorizationRepository(opened.db, {
    generateCsrfToken: () => nextSecret("R", 43)
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) =>
        csrfRepository.authorizeBrowserWrite(input),
      rotateBootstrap(input) {
        const result = csrfRepository.rotateBootstrap(input);
        secrets.add(result.rawCsrfToken);
        return result;
      }
    },
    now
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings.readHostLock(),
      transition: (input) => settings.transitionHostLock(input)
    },
    now
  });
  const admission = createHostDeckSelectedWriteAdmissionPolicy({
    resourceBudget,
    now: () => performance.now()
  });
  const deviceListing = createDeviceListingRepository(opened.db);
  const deviceRevocation = createDeviceRevocationRepository(opened.db);
  const sse = { active: 0, closed: 0 };
  const internalErrors: unknown[] = [];
  const routePlugins: HostDeckRoutePluginRegistration[] = [
    createHostDeckRemoteIngressRouteRegistration({ service: remote.control }),
    createHostDeckPairingRouteRegistration({
      audit: securityAudit,
      pairing: pairingPolicy
    }),
    createHostDeckCsrfRouteRegistration({ audit: securityAudit, csrf }),
    createHostDeckHostLockRouteRegistration({
      audit: securityAudit,
      csrf,
      lock
    }),
    createHostDeckDeviceListRouteRegistration({
      devices: { list: (input) => deviceListing.list(input) }
    }),
    createHostDeckDeviceRevokeRouteRegistration({
      activeDeviceAuthority: authenticationPolicy.activeDeviceAuthority,
      admission,
      audit: securityAudit,
      csrf,
      devices: { revoke: (input) => deviceRevocation.revoke(input) },
      lock,
      now
    }),
    createProtectedReadRegistration(),
    createAcceptanceSseRegistration(sse),
    createHostDeckPromptRouteRegistration({
      admission,
      audit: selectedWriteAudit,
      csrf,
      lock,
      prompts: {
        async snapshot() {
          return promptSnapshot();
        },
        async dispatch() {
          calls.promptDispatch += 1;
          return {
            thread_id: threadId,
            turn_id: codexTurnIdSchema.parse(
              `turn-remote-acceptance-${calls.promptDispatch}`
            ),
            state: "accepted" as const,
            action: "start" as const,
            model_revision: null,
            plan_revision: null,
            steerable: false
          };
        }
      },
      runtime: { read: () => runtimeCandidate() },
      sessions: { read: () => selectedState() }
    })
  ];

  let databaseClosed = false;
  const host = await startHostDeckTailscaleServeFastifyLifecycle({
    createRequestAuthenticationPolicy: () => authenticationPolicy,
    createRoutePlugins: () => routePlugins,
    observeInternalError: (observation) => internalErrors.push(observation),
    resourceBudget,
    runtime: {
      beginDrain() {
        // Remote authority owns request admission; no extra runtime gate exists here.
      },
      closeRuntime() {
        // The acceptance prompt port has no external runtime process.
      },
      closeSse() {
        // Remote and device authority abort the selected SSE source first.
      },
      closeStartup() {
        if (opened.db.open) opened.db.close();
        databaseClosed = true;
      },
      start() {
        return Object.freeze({
          bind: Object.freeze({
            host: "127.0.0.1" as const,
            port,
            transport: "http" as const
          }),
          context: Object.freeze({ remote })
        });
      }
    },
    selectRemoteIngressLifecycle: (context) => context.remote
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let closed = false;
  const harness: RemoteAcceptanceHarness = {
    audit,
    calls,
    claimStarted,
    closedDatabase: () => databaseClosed,
    environment,
    host,
    internalErrors,
    pairingPolicy,
    remote,
    secrets,
    sse,
    auditCount() {
      return (
        opened.db
          .prepare("SELECT COUNT(*) AS count FROM selected_audit_events")
          .get() as { readonly count: number }
      ).count;
    },
    async close() {
      if (closed) return;
      closed = true;
      releaseClaim();
      await host.close();
    },
    local(method, path, body) {
      return exchange({
        ...(body === undefined ? {} : { body }),
        headers:
          method === "GET"
            ? {
                host: new URL(localOrigin).host,
                [hostDeckLocalAdminRequestHeaderName]:
                  hostDeckLocalAdminRequestHeaderValue
              }
            : { host: new URL(localOrigin).host },
        method,
        path,
        port
      });
    },
    openRemoteSse(cookie) {
      return openSse(port, remoteHeaders("GET", { cookie }));
    },
    releaseClaim,
    remoteRequest(method, path, body, requestOptions = {}) {
      return exchange({
        ...(body === undefined ? {} : { body }),
        headers: remoteHeaders(method, requestOptions),
        method,
        path,
        port
      });
    },
    scanSecrets() {
      const surfaces: Buffer[] = [];
      for (const suffix of ["", "-wal", "-shm"] as const) {
        try {
          surfaces.push(readFileSync(`${databasePath}${suffix}`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      let leaks = 0;
      for (const secret of secrets) {
        for (const surface of surfaces) {
          if (surface.includes(Buffer.from(secret))) leaks += 1;
        }
      }
      return Object.freeze({ checked: secrets.size, leaks });
    },
    seedWriter() {
      const rawDeviceToken = "W".repeat(43);
      const rawCsrfToken = "X".repeat(43);
      secrets.add(rawDeviceToken);
      secrets.add(rawCsrfToken);
      auth.create({
        clientLabel: "Seeded hostile writer",
        createdAt: now(),
        id: "client_seeded_remote_writer",
        permission: "write",
        rawCsrfToken,
        rawDeviceToken
      });
      return Object.freeze({
        cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
        csrf: Object.freeze({ generation: 1, token: rawCsrfToken })
      });
    }
  };
  harnesses.push(harness);
  return harness;
}

interface FakeTailscaleEnvironment {
  readonly disable: (
    input: TailscaleServeMutationInput
  ) => Promise<TailscaleServeManagerResult>;
  readonly enable: (
    input: TailscaleServeMutationInput
  ) => Promise<TailscaleServeManagerResult>;
  readonly foreignServeBytes: () => string;
  readonly observe: () => RemoteIngressObservationSnapshot;
  readonly setProfile: (profile: "dedicated" | "other") => void;
  readonly setServe: (
    serve: Exclude<RemoteIngressObservationSnapshot["serve"], null>
  ) => void;
}

function createFakeTailscaleEnvironment(
  localOrigin: string
): FakeTailscaleEnvironment {
  let profile: "dedicated" | "other" = "dedicated";
  let serve: Exclude<RemoteIngressObservationSnapshot["serve"], null> =
    "absent";
  const foreignServe = JSON.stringify({ TCP: { "443": { HTTPS: true } } });
  const observe = () => observation({ localOrigin, profile, serve });
  return Object.freeze({
    async disable(input: TailscaleServeMutationInput) {
      const before = observe();
      if (profile !== "dedicated") {
        return Object.freeze({
          action: "disable" as const,
          outcome: "rejected" as const,
          serve_result: "not_attempted" as const,
          reason: "profile_other" as const,
          command_attempted: false,
          before,
          after: null
        });
      }
      expect(input.expected_profile_key).toBe(profileKey);
      serve = "absent";
      return managerResult("disable", before, observe(), "removed");
    },
    async enable(input: TailscaleServeMutationInput) {
      const before = observe();
      if (profile !== "dedicated") {
        throw new Error("Acceptance manager must not enable a foreign profile.");
      }
      expect(input.expected_profile_key).toBe(profileKey);
      serve = "exact";
      return managerResult("enable", before, observe(), "applied");
    },
    foreignServeBytes: () => foreignServe,
    observe,
    setProfile(next: "dedicated" | "other") {
      profile = next;
    },
    setServe(
      next: Exclude<RemoteIngressObservationSnapshot["serve"], null>
    ) {
      serve = next;
    }
  });
}

function managerResult(
  action: "disable" | "enable",
  before: RemoteIngressObservationSnapshot,
  after: RemoteIngressObservationSnapshot,
  serveResult: "applied" | "removed"
): TailscaleServeManagerResult {
  return Object.freeze({
    action,
    outcome: "succeeded" as const,
    serve_result: serveResult,
    reason: null,
    command_attempted: true,
    before,
    after
  });
}

function observation(input: {
  readonly localOrigin: string;
  readonly profile: "dedicated" | "other";
  readonly serve: Exclude<RemoteIngressObservationSnapshot["serve"], null>;
}): RemoteIngressObservationSnapshot {
  const other = input.profile === "other";
  return remoteIngressObservationSnapshotSchema.parse({
    schema_version: 1,
    client: "available",
    profile: {
      state: other ? "other" : "dedicated",
      comparison: {
        relation: other ? "different" : "match",
        expected_profile_key: profileKey,
        active_profile_key: other ? otherProfileKey : profileKey
      }
    },
    serve: other ? null : input.serve,
    external_origin: other ? null : externalOrigin,
    failure: null,
    observed_at: timestamp
  });
}

function createProtectedReadRegistration(): HostDeckRoutePluginRegistration {
  return Object.freeze({
    id: "remote-acceptance-protected-read",
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      app.get(
        protectedReadPath,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async onRequest(request: FastifyRequest) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            querystring: z.object({}).strict(),
            response: {
              200: z.object({ protected_marker: z.literal(protectedMarker) }).strict()
            }
          }
        },
        async () => ({ protected_marker: protectedMarker as typeof protectedMarker })
      );
    }
  });
}

function createAcceptanceSseRegistration(runtime: {
  active: number;
  closed: number;
}): HostDeckRoutePluginRegistration {
  return createHostDeckSseTransportRegistration({
    id: "remote-acceptance-sse",
    path: protectedSsePath,
    observeError: () => undefined,
    source: {
      async open({ request, signal }) {
        requireHostDeckRequestAuthentication(request, "device_cookie");
        runtime.active += 1;
        let emitted = false;
        let closed = false;
        let pending: (() => void) | null = null;
        const finish = () => pending?.();
        signal.addEventListener("abort", finish, { once: true });
        const close = () => {
          if (closed) return;
          closed = true;
          runtime.active -= 1;
          runtime.closed += 1;
          signal.removeEventListener("abort", finish);
        };
        return Object.freeze({
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (!emitted) {
                  emitted = true;
                  return {
                    done: false as const,
                    value: selectedProjectionEventSchema.parse({
                      captured_at: timestamp,
                      codex_event_id: "remote-acceptance-event-1",
                      codex_event_type: "item/agentMessage/delta",
                      content_notice: null,
                      content_state: "complete",
                      cursor: 1,
                      item_id: null,
                      phase: "delta",
                      role: "agent",
                      session_id: sessionId,
                      text: protectedMarker,
                      type: "message",
                      upstream_at: null
                    })
                  };
                }
                if (!signal.aborted) {
                  await new Promise<void>((resolve) => {
                    pending = resolve;
                  });
                }
                pending = null;
                close();
                return { done: true as const, value: undefined };
              },
              async return() {
                pending?.();
                pending = null;
                close();
                return { done: true as const, value: undefined };
              }
            };
          }
        });
      }
    }
  });
}

function remoteHeaders(
  method: "GET" | "OPTIONS" | "POST",
  options: RemoteRequestOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    host: options.host ?? new URL(externalOrigin).host,
    "x-forwarded-for": options.forwardedFor ?? options.source ?? sourceAddress,
    "x-forwarded-host": options.forwardedHost ?? new URL(externalOrigin).host,
    "x-forwarded-proto": options.forwardedProto ?? "https",
    ...options.extra
  };
  if (method === "POST" || options.origin !== undefined) {
    if (options.origin !== null) headers.origin = options.origin ?? externalOrigin;
  }
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.csrf !== undefined) {
    headers["x-hostdeck-csrf"] = options.csrf.token;
    headers["x-hostdeck-csrf-generation"] = String(options.csrf.generation);
  }
  return headers;
}

function exchange(input: {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "GET" | "OPTIONS" | "POST";
  readonly path: string;
  readonly port: number;
}): Promise<HttpResponse> {
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const headers: Record<string, string | number> = { ...input.headers };
  if (body.length > 0) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method,
        path: input.path,
        headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 128 * 1024) {
            request.destroy(new Error("Acceptance response exceeded its bound."));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: responseBody,
            headers: response.headers,
            status: response.statusCode ?? 0,
            json: () => JSON.parse(responseBody) as Record<string, unknown>
          });
        });
      }
    );
    request.once("error", reject);
    if (body.length > 0) request.write(body);
    request.end();
  });
}

function openSse(port: number, headers: Record<string, string>): OpenSse {
  let resolveClosed!: () => void;
  let resolveFirst!: (value: { readonly body: string }) => void;
  let rejectFirst!: (error: unknown) => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const firstEvent = new Promise<{ readonly body: string }>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: "GET",
      path: protectedSsePath,
      headers: { ...headers, accept: "text/event-stream" }
    },
    (response: IncomingMessage) => {
      let body = "";
      let firstResolved = false;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (!firstResolved && body.includes("\n\n")) {
          firstResolved = true;
          resolveFirst({ body });
        }
      });
      const finish = () => {
        if (!firstResolved) rejectFirst(new Error("SSE closed before its first event."));
        resolveClosed();
      };
      response.once("close", finish);
      response.once("end", finish);
      response.once("error", finish);
    }
  );
  request.once("error", (error) => {
    rejectFirst(error);
    resolveClosed();
  });
  request.end();
  return Object.freeze({ closed, firstEvent });
}

async function enableHarness(
  harness: RemoteAcceptanceHarness,
  operationId: string
): Promise<void> {
  const response = await harness.local("POST", "/api/v1/remote/enable", {
    operation_id: operationId,
    confirmed: true
  });
  expect(
    response.status,
    `${response.body}\n${JSON.stringify(harness.internalErrors)}\n${JSON.stringify(harness.remote.control.snapshot())}`
  ).toBe(200);
  expect(response.json()).toMatchObject({ availability: "ready" });
}

async function issueCode(
  harness: RemoteAcceptanceHarness,
  operationId: string
): Promise<string> {
  const response = await harness.local("POST", "/api/v1/access/pairing-codes", {
    operation_id: operationId,
    permission: "write",
    client_label: "Aggregate limits"
  });
  expect(response.status, response.body).toBe(200);
  return requireString(response.json().code);
}

function selectedState(): SelectedSessionState {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "remote-acceptance-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-remote-acceptance",
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: "selected",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
    session: {
      id: mapping.id,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Remote acceptance session.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function runtimeCandidate(): RuntimeCompatibility {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-remote-acceptance-001",
    capabilities: runtimeCapabilities.map((name) => ({
      name,
      state: "available",
      reason: null
    })),
    checked_at: timestamp,
    reason: null
  });
}

function promptSnapshot(): PromptTurnControlSnapshot {
  return {
    phase: "idle",
    last_action: null,
    operation_id: null,
    turn_id: null,
    model_revision: null,
    plan_revision: null,
    requested_at: null,
    accepted_at: null,
    started_at: null,
    error: null
  };
}

function singleSetCookie(headers: IncomingHttpHeaders): string {
  const values = headers["set-cookie"];
  if (!Array.isArray(values) || values.length !== 1 || values[0] === undefined) {
    throw new Error("Expected one Set-Cookie header.");
  }
  return values[0];
}

function cookiePair(setCookie: string): string {
  const pair = setCookie.split(";", 1)[0];
  if (pair === undefined || !pair.startsWith(`${hostDeckDeviceCookieName}=`)) {
    throw new Error("Device cookie pair is invalid.");
  }
  return pair;
}

function assertHardenedDeviceCookie(setCookie: string, deletion: boolean): void {
  const lower = setCookie.toLowerCase();
  expect(lower).toContain("; path=/");
  expect(lower).toContain("; httponly");
  expect(lower).toContain("; secure");
  expect(lower).toContain("; samesite=strict");
  expect(lower).not.toContain("domain=");
  if (deletion) {
    expect(lower).toContain("max-age=0");
  } else {
    expect(cookiePair(setCookie).split("=")[1]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  }
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string value.");
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Expected a safe integer value.");
  }
  return value;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a loopback port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
