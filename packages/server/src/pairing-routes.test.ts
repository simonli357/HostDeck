import "reflect-metadata";

import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget, resolveResourceBudget } from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createPairingCodeRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import {
  BasicConstraintsExtension,
  cryptoProvider,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator
} from "@peculiar/x509";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration
} from "./csrf-routes.js";
import type { HostDeckFastifyInstance } from "./fastify-app.js";
import { installHostDeckErrorPolicy } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  installHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  installHostDeckRequestTrustGate
} from "./fastify-request-trust.js";
import { installHostDeckZodCompilers } from "./fastify-zod.js";
import {
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  type HostDeckPairingPolicy, 
  hostDeckPairingPolicySnapshot,
  hostDeckPairingRouteRegistrationId
} from "./pairing-routes.js";
import {
  createSecurityMutationAuditExecutor,
  type SecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";

const baseTime = new Date("2026-07-12T20:00:00.000Z");
const httpsOrigin = "https://localhost";
const rawPairingCode = "abcdefghijklmnopqrstuv";
const rawDeviceToken = "D".repeat(43);
const rawCsrfToken = "C".repeat(43);
const tempDirs: string[] = [];
const openApps: HostDeckFastifyInstance[] = [];
const openDatabases: Array<ReturnType<typeof openMigratedDatabase>["db"]> = [];

cryptoProvider.set(globalThis.crypto);

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected pairing route", () => {
  it("requires exact detached ports, brands the policy, and freezes count-only diagnostics", async () => {
    let observedThis: unknown = "not-called";
    const issue = function issue(this: void) {
      observedThis = this;
      throw new Error("fixture issue stop");
    };
    const port = { issue, claim: () => undefined };
    const policy = createHostDeckPairingPolicy({
      pairing: port,
      now: () => new Date(baseTime),
      createPairingId: () => "pair_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    port.issue = () => {
      throw new Error("mutated port should not run");
    };
    expect(Object.isFrozen(policy)).toBe(true);
    expect(hostDeckPairingPolicySnapshot(policy)).toEqual({
      active_claims: 0,
      active_sources: 0,
      audit_failures: 0,
      claim_failures: 0,
      claim_successes: 0,
      global_admission_rejections: 0,
      issue_failures: 0,
      issue_successes: 0,
      source_admission_rejections: 0,
      storage_failures: 0
    });
    expect(Object.isFrozen(hostDeckPairingPolicySnapshot(policy))).toBe(true);

    const audit = fixtureAuditExecutor();
    const registration = createHostDeckPairingRouteRegistration({ audit, pairing: policy });
    expect(registration.id).toBe(hostDeckPairingRouteRegistrationId);
    expect(registration.surface).toBe("api");
    expect(Object.isFrozen(registration)).toBe(true);
    expect(() => createHostDeckPairingRouteRegistration({ audit, pairing: policy })).toThrow(
      "already owns a route registration"
    );

    const invalidPolicies: unknown[] = [
      null,
      {},
      { pairing: { issue, claim: () => undefined }, now: () => new Date(), extra: true },
      { pairing: { issue }, now: () => new Date() },
      { pairing: { issue, claim: 1 }, now: () => new Date() },
      { pairing: { issue, claim: () => undefined }, now: new Date() },
      Object.defineProperty(
        { now: () => new Date() },
        "pairing",
        { enumerable: true, get: () => ({ issue, claim: () => undefined }) }
      )
    ];
    for (const candidate of invalidPolicies) {
      expect(() => createHostDeckPairingPolicy(candidate as never)).toThrow();
    }
    expect(observedThis).toBe("not-called");
  });

  it("issues and claims one selected code with exact audit, expiry, and secure cookie truth", async () => {
    const harness = await createHarness();
    const issue = await harness.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-codes",
      headers: { host: "localhost", "content-type": "application/json" },
      payload: {
        operation_id: "op_pair_issue_0001",
        permission: "write",
        client_label: "Android phone"
      }
    });
    expect(issue.statusCode, issue.body).toBe(200);
    expect(issue.headers["cache-control"]).toBe("no-store");
    expect(issue.headers.pragma).toBe("no-cache");
    expect(issue.headers["set-cookie"]).toBeUndefined();
    const issued = issue.json<{
      pairing_id: string;
      code: string;
      expires_at: string;
    }>();
    expect(issued.pairing_id).toBe("pair_ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(issued.code).toBe(rawPairingCode);
    expect(issued.expires_at).toBe("2026-07-12T20:05:00.000Z");

    const claim = await harness.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-claims",
      headers: {
        host: "localhost",
        origin: httpsOrigin,
        cookie: `${hostDeckDeviceCookieName}=${"O".repeat(43)}`,
        "content-type": "application/json"
      },
      payload: {
        operation_id: "op_pair_claim_0001",
        code: issued.code,
        client_label: "Pixel phone"
      }
    });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.headers["cache-control"]).toBe("no-store");
    expect(claim.headers.pragma).toBe("no-cache");
    expect(claim.headers["access-control-allow-origin"]).toBeUndefined();
    expect(claim.json()).toEqual({
      device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      client_label: "Pixel phone",
      created_at: "2026-07-12T20:00:00.000Z",
      expires_at: "2026-10-10T20:00:00.000Z",
      csrf_bootstrap_required: true
    });
    const cookie = requireSingleHeader(claim.headers["set-cookie"]);
    expect(cookie).toBe(
      `${hostDeckDeviceCookieName}=${rawDeviceToken}; Path=/; Expires=Sat, 10 Oct 2026 20:00:00 GMT; HttpOnly; Secure; SameSite=Strict`
    );
    expect(claim.body).not.toContain(rawDeviceToken);
    expect(claim.body).not.toContain(rawCsrfToken);

    const bootstrap = await harness.app.inject({
      method: "POST",
      url: "/api/v1/access/csrf",
      headers: {
        host: "localhost",
        origin: httpsOrigin,
        cookie,
        "content-type": "application/json"
      },
      payload: { operation_id: "op_pair_bootstrap_01" }
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.headers["set-cookie"]).toBeUndefined();
    expect(bootstrap.json()).toEqual({
      csrf_token: "N".repeat(43),
      csrf_generation: 2,
      rotated_at: "2026-07-12T20:00:01.000Z"
    });

    expect(harness.pairing.require(issued.pairing_id)).toMatchObject({
      used_at: "2026-07-12T20:00:00.000Z",
      claimed_device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    expect(harness.auth.require("client_ABCDEFGHIJKLMNOPQRSTUVWX")).toMatchObject({
      client_label: "Pixel phone",
      expires_at: "2026-10-10T20:00:00.000Z",
      csrf_generation: 2,
      csrf_rotated_at: "2026-07-12T20:00:01.000Z"
    });

    const issueTrail = harness.audit.require("op_pair_issue_0001");
    expect(issueTrail.state).toBe("terminal");
    expect(issueTrail.records).toHaveLength(2);
    expect(issueTrail.records[0]?.payload_summary).toEqual({
      schema_version: 1,
      permission: "write",
      client_label_present: true,
      expires_at: "2026-07-12T20:05:00.000Z"
    });
    expect(issueTrail.records[1]?.payload_summary).toEqual({
      schema_version: 1,
      pairing_id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX"
    });

    const claimTrail = harness.audit.require("op_pair_claim_0001");
    expect(claimTrail.state).toBe("terminal");
    expect(claimTrail.records[0]?.payload_summary).toEqual({
      schema_version: 1,
      client_label_present: true
    });
    expect(claimTrail.records[1]?.payload_summary).toEqual({
      schema_version: 1,
      permission: "write",
      device_created: true,
      device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      claim_successes: 1,
      issue_successes: 1
    });
  });

  it("maps lifecycle denials generically and enforces the durable source rate ceiling", async () => {
    const harness = await createHarness({
      budget: resolveResourceBudget({
        pair_claim_max_attempts_per_source: 2,
        pair_claim_max_attempts_global: 2
      })
    });
    const issue = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "read",
      clientLabel: null,
      createdAt: baseTime
    });
    const first = await injectClaim(harness.app, "op_pair_invalid_0001", "Z".repeat(22));
    const second = await injectClaim(harness.app, "op_pair_invalid_0002", issue.rawCode);
    const limited = await injectClaim(harness.app, "op_pair_invalid_0003", "Y".repeat(22));

    expect(first.statusCode, first.body).toBe(401);
    expect(second.statusCode, second.body).toBe(200);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(first.json()).toMatchObject({
      error: { code: "permission_denied", message: "Pairing claim was not accepted.", retryable: false }
    });
    expect(limited.json()).toMatchObject({
      error: { code: "rate_limited", retryable: true }
    });
    expect(first.headers["set-cookie"]).toBeUndefined();
    expect(limited.headers["set-cookie"]).toBeUndefined();
    expect(harness.pairing.getRateSnapshot("sha256:d7cfc2cf0f158c30d50ca26c1e99a4cb15d692907d12fb69e2a18f93ea6e1adb")).toMatchObject({
      source: { attempt_count: 2 },
      global: { attempt_count: 2 }
    });
    expect(harness.audit.require("op_pair_invalid_0001").records[1]).toMatchObject({
      outcome: "failed",
      error_code: "permission_denied",
      payload_summary: { schema_version: 1 }
    });
    expect(harness.audit.require("op_pair_invalid_0003").records[1]).toMatchObject({
      outcome: "failed",
      error_code: "rate_limited"
    });
  });

  it("does not distinguish unknown, expired, revoked, or used selected codes", async () => {
    const harness = await createHarness();
    const used = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      clientLabel: null,
      createdAt: baseTime
    });
    const expired = harness.pairing.issue({
      id: "pair_ZYXWVUTSRQPONMLKJIHGFEDC",
      permission: "read",
      clientLabel: null,
      createdAt: new Date(baseTime.getTime() - 600_000)
    });
    const revoked = harness.pairing.issue({
      id: "pair_BCDEFGHIJKLMNOPQRSTUVWXY",
      permission: "read",
      clientLabel: null,
      createdAt: baseTime
    });
    harness.pairing.revoke(revoked.pairingCode.id, {
      now: new Date(baseTime.getTime() + 1_000)
    });
    expect(
      (await injectClaim(harness.app, "op_pair_used_owner_01", used.rawCode)).statusCode
    ).toBe(200);

    const denied = [];
    for (const [operationId, code] of [
      ["op_pair_unknown_0001", "Y".repeat(22)],
      ["op_pair_expired_0001", expired.rawCode],
      ["op_pair_revoked_0001", revoked.rawCode],
      ["op_pair_used_retry_01", used.rawCode]
    ] as const) {
      denied.push(await injectClaim(harness.app, operationId, code));
    }
    const publicErrors = denied.map((response) => {
      expect(response.statusCode, response.body).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      const body = response.json<{
        error: { code: string; message: string; retryable: boolean };
      }>();
      return {
        code: body.error.code,
        message: body.error.message,
        retryable: body.error.retryable
      };
    });
    expect(new Set(publicErrors.map((error) => JSON.stringify(error)))).toEqual(
      new Set([
        JSON.stringify({
          code: "permission_denied",
          message: "Pairing claim was not accepted.",
          retryable: false
        })
      ])
    );
  });

  it("fails stale or regressing issue dispatch before id/code entropy or storage", async () => {
    for (const [name, second, status, code] of [
      ["stale", new Date(baseTime.getTime() + 240_001), 504, "operation_timeout"],
      ["regressing", new Date(baseTime.getTime() - 1), 409, "operation_conflict"]
    ] as const) {
      let clockIndex = 0;
      const times = [baseTime, second] as const;
      const harness = await createHarness({
        pairingNow: () => new Date(times[clockIndex++] ?? second)
      });
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/v1/access/pairing-codes",
        headers: { host: "localhost", "content-type": "application/json" },
        payload: {
          operation_id: `op_pair_${name}_issue_01`,
          permission: "write"
        }
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      expect(response.body).not.toContain(rawPairingCode);
      expect(
        harness.db.prepare("SELECT COUNT(*) AS count FROM pairing_codes").get()
      ).toEqual({ count: 0 });
      expect(harness.audit.require(`op_pair_${name}_issue_01`).records[1]).toMatchObject({
        phase: "terminal",
        outcome: "failed",
        error_code: code
      });
    }
  });

  it("rejects plaintext, foreign origin, malformed bodies, and browser pair issuance before side effects", async () => {
    const secure = await createHarness();
    const browserIssue = await secure.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-codes",
      headers: {
        host: "localhost",
        origin: httpsOrigin,
        "content-type": "application/json"
      },
      payload: { operation_id: "op_pair_browser_0001", permission: "write" }
    });
    expect(browserIssue.statusCode, browserIssue.body).toBe(403);

    const malformed = await secure.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-claims",
      headers: {
        host: "localhost",
        origin: httpsOrigin,
        "content-type": "application/json"
      },
      payload: { operation_id: "op_pair_malformed_01", code: "123456" }
    });
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: "validation_error", field: "body" } });

    const foreign = await secure.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-claims",
      headers: {
        host: "localhost",
        origin: "https://foreign.test",
        "content-type": "application/json"
      },
      payload: { operation_id: "op_pair_foreign_0001", code: rawPairingCode }
    });
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect(foreign.body).not.toContain("foreign.test");

    const plaintext = await createHarness({ secure: false });
    const plainClaim = await plaintext.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-claims",
      headers: {
        host: "localhost",
        origin: "http://localhost",
        "content-type": "application/json"
      },
      payload: { operation_id: "op_pair_plain_0001", code: rawPairingCode }
    });
    expect(plainClaim.statusCode, plainClaim.body).toBe(426);
    expect(plainClaim.headers["set-cookie"]).toBeUndefined();

    expect(secure.db.prepare("SELECT COUNT(*) AS count FROM pairing_codes").get()).toEqual({ count: 0 });
    expect(secure.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 0 });
    expect(plaintext.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 0 });
  });

  it("suppresses the cookie when terminal audit fails after a durable claim", async () => {
    const harness = await createHarness({ terminalAuditFailure: true });
    const issued = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      clientLabel: null,
      createdAt: baseTime
    });
    const response = await injectClaim(harness.app, "op_pair_audit_fail_01", issued.rawCode);
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(rawDeviceToken);
    expect(response.body).not.toContain(rawCsrfToken);
    expect(harness.pairing.require("pair_ABCDEFGHIJKLMNOPQRSTUVWX")).toMatchObject({
      used_at: "2026-07-12T20:00:00.000Z",
      claimed_device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    expect(harness.audit.require("op_pair_audit_fail_01")).toMatchObject({
      state: "pending",
      records: [{ phase: "accepted", outcome: "accepted" }]
    });
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      audit_failures: 1,
      claim_successes: 1
    });
  });

  it("blocks issue and claim before mutation when accepted audit is unavailable", async () => {
    const harness = await createHarness({ acceptedAuditFailure: true });
    const issue = await harness.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-codes",
      headers: { host: "localhost", "content-type": "application/json" },
      payload: {
        operation_id: "op_pair_audit_pre_issue",
        permission: "write"
      }
    });
    expect(issue.statusCode).toBeGreaterThanOrEqual(500);
    expect(issue.body).not.toContain(rawPairingCode);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM pairing_codes").get()
    ).toEqual({ count: 0 });

    const issued = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      clientLabel: null,
      createdAt: baseTime
    });
    const claim = await injectClaim(
      harness.app,
      "op_pair_audit_pre_claim",
      issued.rawCode
    );
    expect(claim.statusCode).toBeGreaterThanOrEqual(500);
    expect(claim.headers["set-cookie"]).toBeUndefined();
    expect(harness.pairing.require(issued.pairingCode.id)).toMatchObject({
      used_at: null,
      claimed_device_id: null
    });
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources").get()
    ).toEqual({ count: 0 });
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()
    ).toEqual({ count: 0 });
  });

  it("suppresses a raw issued code after terminal audit failure", async () => {
    const harness = await createHarness({ terminalAuditFailure: true });
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-codes",
      headers: { host: "localhost", "content-type": "application/json" },
      payload: {
        operation_id: "op_pair_issue_terminal",
        permission: "read"
      }
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.body).not.toContain(rawPairingCode);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(harness.pairing.require("pair_ABCDEFGHIJKLMNOPQRSTUVWX")).toMatchObject({
      permission: "read",
      used_at: null
    });
    expect(harness.audit.require("op_pair_issue_terminal")).toMatchObject({
      state: "pending",
      records: [{ phase: "accepted", outcome: "accepted" }]
    });
  });

  it("fails closed on corrupt post-commit issue and claim results", async () => {
    const issueHarness = await createHarness({ corruptIssueResult: true });
    const issue = await issueHarness.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-codes",
      headers: { host: "localhost", "content-type": "application/json" },
      payload: {
        operation_id: "op_pair_corrupt_issue",
        permission: "write"
      }
    });
    expect(issue.statusCode, issue.body).toBe(500);
    expect(issue.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(issue.body).not.toContain(rawPairingCode);
    expect(issueHarness.pairing.require("pair_ABCDEFGHIJKLMNOPQRSTUVWX")).toMatchObject({
      used_at: null
    });
    expect(issueHarness.audit.require("op_pair_corrupt_issue").records[1]).toMatchObject({
      outcome: "incomplete",
      error_code: "internal_error"
    });

    const claimHarness = await createHarness({ corruptClaimResult: true });
    const issued = claimHarness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      clientLabel: null,
      createdAt: baseTime
    });
    const claim = await injectClaim(
      claimHarness.app,
      "op_pair_corrupt_claim",
      issued.rawCode
    );
    expect(claim.statusCode, claim.body).toBe(500);
    expect(claim.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(claim.headers["set-cookie"]).toBeUndefined();
    expect(claim.body).not.toContain(rawDeviceToken);
    expect(claim.body).not.toContain(rawCsrfToken);
    expect(claimHarness.pairing.require(issued.pairingCode.id)).toMatchObject({
      used_at: "2026-07-12T20:00:00.000Z",
      claimed_device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    expect(claimHarness.audit.require("op_pair_corrupt_claim").records[1]).toMatchObject({
      outcome: "incomplete",
      error_code: "internal_error"
    });
  });

  it("removes the prepared cookie when response delivery fails after terminal success", async () => {
    const harness = await createHarness({ failPairClaimOnSend: true });
    const issued = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      clientLabel: null,
      createdAt: baseTime
    });
    const response = await injectClaim(
      harness.app,
      "op_pair_send_failure",
      issued.rawCode
    );
    expect(response.statusCode, response.body).toBe(500);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(rawDeviceToken);
    expect(response.body).not.toContain(rawCsrfToken);
    expect(harness.pairing.require(issued.pairingCode.id)).toMatchObject({
      used_at: "2026-07-12T20:00:00.000Z",
      claimed_device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    expect(harness.audit.require("op_pair_send_failure").records[1]).toMatchObject({
      outcome: "succeeded",
      error_code: null
    });
  });

  it("admits only one overlapping claim per source and releases all limiter state", async () => {
    const harness = await createHarness({ deferFirstClaim: true });
    const first = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "write",
      clientLabel: null,
      createdAt: baseTime
    });
    const second = harness.pairing.issue({
      id: "pair_ZYXWVUTSRQPONMLKJIHGFEDC",
      permission: "write",
      clientLabel: null,
      createdAt: baseTime
    });
    const leftPromise = injectClaim(
      harness.app,
      "op_pair_overlap_0001",
      first.rawCode
    );
    await harness.claimStarted;
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 1,
      active_sources: 1
    });
    const right = await injectClaim(
      harness.app,
      "op_pair_overlap_0002",
      second.rawCode
    );
    harness.releaseClaim();
    const left = await leftPromise;
    expect([left.statusCode, right.statusCode].sort((a, b) => a - b)).toEqual([200, 503]);
    const rejected = left.statusCode === 503 ? left : right;
    expect(rejected.json()).toMatchObject({
      error: { code: "service_overloaded", retryable: true }
    });
    expect(rejected.headers["set-cookie"]).toBeUndefined();
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      source_admission_rejections: 1
    });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources").get()).toEqual({ count: 1 });
  });

  it("enforces global overlap independently from canonical per-source admission", async () => {
    const harness = await createHarness({
      budget: resolveResourceBudget({
        pair_claim_max_in_flight: 1
      }),
      deferFirstClaim: true
    });
    const first = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "read",
      clientLabel: null,
      createdAt: baseTime
    });
    const second = harness.pairing.issue({
      id: "pair_ZYXWVUTSRQPONMLKJIHGFEDC",
      permission: "read",
      clientLabel: null,
      createdAt: baseTime
    });
    const firstPromise = injectClaim(
      harness.app,
      "op_pair_global_0001",
      first.rawCode,
      "127.0.0.1"
    );
    await harness.claimStarted;
    const rejected = await injectClaim(
      harness.app,
      "op_pair_global_0002",
      second.rawCode,
      "127.0.0.2"
    );
    harness.releaseClaim();
    const accepted = await firstPromise;
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(rejected.statusCode, rejected.body).toBe(503);
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      global_admission_rejections: 1,
      source_admission_rejections: 0
    });
  });

  it("emits the selected cookie over a real TLS listener with exact Host and Origin", async () => {
    const port = await getAvailablePort();
    const origin = `https://localhost:${port}`;
    const harness = await createHarness({ origin, realTls: true });
    const issued = harness.pairing.issue({
      id: "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
      permission: "read",
      clientLabel: "TLS phone",
      createdAt: baseTime
    });
    await harness.app.listen({ host: "127.0.0.1", port });
    const response = await realTlsJsonRequest(port, origin, {
      operation_id: "op_pair_real_tls_01",
      code: issued.rawCode
    });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toEqual([
      `${hostDeckDeviceCookieName}=${rawDeviceToken}; Path=/; Expires=Sat, 10 Oct 2026 20:00:00 GMT; HttpOnly; Secure; SameSite=Strict`
    ]);
    expect(JSON.parse(response.body)).toMatchObject({
      permission: "read",
      client_label: "TLS phone",
      expires_at: "2026-10-10T20:00:00.000Z"
    });
    expect(response.body).not.toContain(rawDeviceToken);
    expect(response.body).not.toContain(rawCsrfToken);
  });

  it("reopens claimed authority while raw credentials and peer identity stay out of SQLite bytes", async () => {
    const harness = await createHarness();
    const issue = await harness.app.inject({
      method: "POST",
      url: "/api/v1/access/pairing-codes",
      headers: { host: "localhost", "content-type": "application/json" },
      payload: {
        operation_id: "op_pair_restart_issue",
        permission: "write"
      }
    });
    expect(issue.statusCode, issue.body).toBe(200);
    const issued = issue.json<{ code: string; pairing_id: string }>();
    const claim = await injectClaim(
      harness.app,
      "op_pair_restart_claim",
      issued.code
    );
    expect(claim.statusCode, claim.body).toBe(200);
    const cookie = requireSingleHeader(claim.headers["set-cookie"]);
    assertSecretsAbsentFromSqlite(harness.dbPath, [
      issued.code,
      rawDeviceToken,
      rawCsrfToken,
      cookie,
      "127.0.0.1"
    ]);

    harness.db.close();
    const reopened = openMigratedDatabase(harness.dbPath, {
      now: () => new Date(baseTime.getTime() + 2_000)
    });
    openDatabases.push(reopened.db);
    const reopenedPairing = createPairingCodeRepository(reopened.db, {
      policy: defaultResourceBudget
    });
    expect(reopenedPairing.require(issued.pairing_id)).toMatchObject({
      claimed_device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX",
      used_at: "2026-07-12T20:00:00.000Z"
    });
    const reopenedAuth = createAuthDeviceRepository(reopened.db);
    expect(
      reopenedAuth.authenticateDeviceToken({
        rawDeviceToken,
        now: new Date(baseTime.getTime() + 2_000)
      })
    ).toMatchObject({
      trusted: true,
      readOnly: false,
      device: {
        id: "client_ABCDEFGHIJKLMNOPQRSTUVWX",
        expires_at: "2026-10-10T20:00:00.000Z"
      }
    });
    let expiryFailure: unknown;
    try {
      reopenedAuth.authenticateDeviceToken({
        rawDeviceToken,
        now: new Date("2026-10-10T20:00:00.000Z")
      });
    } catch (error) {
      expiryFailure = error;
    }
    expect(expiryFailure).toMatchObject({ code: "device_expired" });
    assertSecretsAbsentFromSqlite(harness.dbPath, [
      issued.code,
      rawDeviceToken,
      rawCsrfToken,
      cookie,
      "127.0.0.1"
    ]);
  });
});

interface HarnessOptions {
  readonly acceptedAuditFailure?: boolean;
  readonly budget?: typeof defaultResourceBudget;
  readonly corruptClaimResult?: boolean;
  readonly corruptIssueResult?: boolean;
  readonly deferFirstClaim?: boolean;
  readonly failPairClaimOnSend?: boolean;
  readonly origin?: string;
  readonly pairingNow?: () => Date;
  readonly realTls?: boolean;
  readonly secure?: boolean;
  readonly terminalAuditFailure?: boolean;
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly auth: ReturnType<typeof createAuthDeviceRepository>;
  readonly claimStarted: Promise<void>;
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly dbPath: string;
  readonly pairing: ReturnType<typeof createPairingCodeRepository>;
  readonly policy: HostDeckPairingPolicy;
  readonly releaseClaim: () => void;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-pair-route-"));
  tempDirs.push(directory);
  const dbPath = join(directory, "hostdeck.sqlite");
  const open = openMigratedDatabase(dbPath, {
    now: () => new Date(baseTime)
  });
  openDatabases.push(open.db);
  const budget = options.budget ?? defaultResourceBudget;
  let pairingCodeIndex = 0;
  const pairingCodes = [
    rawPairingCode,
    "bcdefghijklmnopqrstuvw",
    "cdefghijklmnopqrstuvwx"
  ] as const;
  const pairing = createPairingCodeRepository(open.db, {
    policy: budget,
    generatePairingCode: () => pairingCodes[pairingCodeIndex++] ?? "z".repeat(22),
    generateDeviceId: () => "client_ABCDEFGHIJKLMNOPQRSTUVWX",
    generateDeviceToken: () => rawDeviceToken,
    generateCsrfToken: () => rawCsrfToken
  });
  let markClaimStarted: () => void = () => undefined;
  const claimStarted = new Promise<void>((resolve) => {
    markClaimStarted = resolve;
  });
  let releaseClaimGate: () => void = () => undefined;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaimGate = resolve;
  });
  let firstClaimDeferred = false;
  const claimPort = (input: Parameters<typeof pairing.claim>[0]) => {
    const stored = pairing.claim(input);
    const result = options.corruptClaimResult
      ? Object.freeze({
          ...stored,
          rawDeviceToken: "E".repeat(43),
          rawCsrfToken: "F".repeat(43)
        })
      : stored;
    if (!options.deferFirstClaim || firstClaimDeferred) return result;
    firstClaimDeferred = true;
    markClaimStarted();
    return claimGate.then(() => result);
  };
  if (!options.deferFirstClaim) markClaimStarted();
  const auth = createAuthDeviceRepository(open.db);
  const csrf = createSelectedCsrfAuthorizationRepository(open.db, {
    generateCsrfToken: () => "N".repeat(43)
  });
  const audit = createSelectedAuditRepository(open.db);
  const auditPort = options.acceptedAuditFailure
    ? repositoryWith(audit, {
        recordAccepted() {
          throw new HostDeckSelectedAuditRepositoryError(
            "audit_write_failed",
            "accepted-audit-private-sentinel"
          );
        }
      })
    : options.terminalAuditFailure
      ? repositoryWith(audit, {
        recordTerminal() {
          throw new HostDeckSelectedAuditRepositoryError(
            "audit_write_failed",
            "terminal-audit-private-sentinel"
          );
        }
        })
      : audit;
  const executor = fixtureAuditExecutor(auditPort);
  let pairingIdIndex = 0;
  const pairingIds = [
    "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
    "pair_ZYXWVUTSRQPONMLKJIHGFEDC",
    "pair_BCDEFGHIJKLMNOPQRSTUVWXY"
  ] as const;
  const policy = createHostDeckPairingPolicy({
    pairing: {
      issue: (input) => {
        const result = pairing.issue(input);
        return options.corruptIssueResult
          ? Object.freeze({ ...result, rawCode: "x".repeat(22) })
          : result;
      },
      claim: claimPort
    },
    now: options.pairingNow ?? (() => new Date(baseTime)),
    createPairingId: () => pairingIds[pairingIdIndex++] ?? "pair_zabcdefghijklmnopqrstuvw"
  });
  const registration = createHostDeckPairingRouteRegistration({
    audit: executor,
    pairing: policy
  });
  const secure = options.secure ?? true;
  const origin = options.origin ?? (secure ? httpsOrigin : "http://localhost");
  const tls = options.realTls ? await generateTestTlsMaterial() : null;
  const app = Fastify({
    logger: false,
    ...(tls === null ? {} : { https: { cert: tls.certificate, key: tls.privateKey } })
  }).withTypeProvider() as HostDeckFastifyInstance;
  openApps.push(app);
  installHostDeckZodCompilers(app);
  installHostDeckErrorPolicy(app, () => undefined);
  if (secure && !options.realTls) {
    app.addHook("onRequest", async (request) => {
      Object.defineProperty(request.raw.socket, "encrypted", {
        configurable: true,
        value: true
      });
    });
  }
  installHostDeckRequestTrustGate(
    app,
    createHostDeckRequestTrustPolicy({
      allowedOrigins: [origin],
      mode: "loopback",
      transport: secure ? "https" : "http"
    }),
    () => undefined
  );
  installHostDeckRequestAuthentication(
    app,
    createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
      now: () => new Date(baseTime)
    })
  );
  if (options.failPairClaimOnSend) {
    app.addHook("onSend", async (request, reply, payload) => {
      if (
        request.url === "/api/v1/access/pairing-claims" &&
        reply.statusCode >= 200 &&
        reply.statusCode < 300
      ) {
        throw new Error("pair-claim-on-send-private-sentinel");
      }
      return payload;
    });
  }
  await registration.register(
    app,
    Object.freeze({ resourceBudget: budget, surface: "api" })
  );
  await createHostDeckCsrfRouteRegistration({
    audit: executor,
    csrf: createHostDeckCsrfPolicy({
      csrf,
      now: () => new Date(baseTime.getTime() + 1_000)
    })
  }).register(app, Object.freeze({ resourceBudget: budget, surface: "api" }));
  await app.ready();
  return {
    app,
    audit,
    auth,
    claimStarted,
    db: open.db,
    dbPath,
    pairing,
    policy,
    releaseClaim: releaseClaimGate
  };
}

function fixtureAuditExecutor(
  repository?: SelectedAuditRepository
): SecurityMutationAuditExecutor {
  let owned: ReturnType<typeof openMigratedDatabase> | null = null;
  if (repository === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-pair-audit-"));
    tempDirs.push(directory);
    owned = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(baseTime)
    });
    openDatabases.push(owned.db);
  }
  const selected = repository ?? createSelectedAuditRepository(owned?.db as never);
  let clockIndex = 0;
  let recordIndex = 0;
  return createSecurityMutationAuditExecutor({
    repository: selected,
    now: () => new Date(baseTime.getTime() + clockIndex++ * 1_000).toISOString(),
    create_record_id: () => `audit:pair:route:${recordIndex++}`
  });
}

function repositoryWith(
  repository: SelectedAuditRepository,
  overrides: Partial<SelectedAuditRepository>
): SelectedAuditRepository {
  return {
    get: overrides.get ?? ((operationId) => repository.get(operationId)),
    require: overrides.require ?? ((operationId) => repository.require(operationId)),
    recordAccepted:
      overrides.recordAccepted ?? ((record) => repository.recordAccepted(record)),
    recordRejected:
      overrides.recordRejected ?? ((record) => repository.recordRejected(record)),
    recordTerminal:
      overrides.recordTerminal ?? ((record) => repository.recordTerminal(record))
  };
}

function injectClaim(
  app: HostDeckFastifyInstance,
  operationId: string,
  code: string,
  remoteAddress = "127.0.0.1"
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/access/pairing-claims",
    headers: {
      host: "localhost",
      origin: httpsOrigin,
      "content-type": "application/json"
    },
    payload: { operation_id: operationId, code },
    remoteAddress
  });
}

function requireSingleHeader(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new TypeError("Expected one response header.");
  return value;
}

function assertSecretsAbsentFromSqlite(
  dbPath: string,
  secrets: readonly string[]
): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const secret of secrets) {
      expect(bytes.includes(Buffer.from(secret, "utf8")), `${path} contains ${secret.length}-byte sentinel`).toBe(false);
    }
  }
}

async function generateTestTlsMaterial(): Promise<{
  readonly certificate: string;
  readonly privateKey: string;
}> {
  const algorithm = {
    hash: "SHA-256",
    modulusLength: 2_048,
    name: "RSASSA-PKCS1-v1_5",
    publicExponent: new Uint8Array([1, 0, 1])
  } as const;
  const keys = await globalThis.crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify"
  ]);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(
        KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment,
        true
      ),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension([{ type: "dns", value: "localhost" }])
    ],
    keys,
    name: "CN=HostDeck Pairing Test",
    notAfter: new Date(baseTime.getTime() + 86_400_000),
    notBefore: new Date(baseTime.getTime() - 86_400_000),
    serialNumber: "0123456789abcdef",
    signingAlgorithm: { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" }
  });
  const der = Buffer.from(
    await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey)
  );
  const body = der.toString("base64").match(/.{1,64}/gu)?.join("\n");
  if (body === undefined) throw new TypeError("Test TLS private key did not encode.");
  return Object.freeze({
    certificate: certificate.toString("pem"),
    privateKey: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
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
        reject(new TypeError("Unable to reserve pairing TLS port."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function realTlsJsonRequest(
  port: number,
  origin: string,
  payload: Readonly<Record<string, unknown>>
): Promise<{
  readonly body: string;
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly status: number;
}> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/access/pairing-claims",
        rejectUnauthorized: false,
        servername: "localhost",
        headers: {
          host: `localhost:${port}`,
          origin,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body, "utf8"),
          connection: "close"
        }
      },
      (response) => {
        let output = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          output += chunk;
          if (output.length > 65_536) request.destroy(new Error("TLS response exceeded its bound."));
        });
        response.once("end", () => {
          resolve({
            body: output,
            headers: response.headers,
            status: response.statusCode ?? 0
          });
        });
      }
    );
    request.setTimeout(5_000, () => request.destroy(new Error("TLS pairing request timed out.")));
    request.once("error", reject);
    request.end(body);
  });
}
