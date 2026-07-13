import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { defaultResourceBudget, resolveResourceBudget } from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { hostDeckDeviceCookieName } from "./fastify-request-authentication.js";
import {
  createSecurityAcceptanceHarness,
  type SecurityAcceptanceHarness,
  securityAcceptanceDriverPath
} from "./security-acceptance-harness.js";

const initialNow = new Date("2026-07-13T16:00:00.000Z");
const openedHarnesses: SecurityAcceptanceHarness[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const harness of openedHarnesses.splice(0).reverse()) {
    await harness.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("IFC-V1-033 aggregate browser security acceptance", () => {
  it("enforces trust, cookie, CSRF, lock, revoke, SSE, audit, and plaintext boundaries together", async () => {
    const harness = await createHarness();
    const address = harness.app.server.address();
    expect(address).toMatchObject({ address: harness.bindHost, port: harness.bindPort });

    const unpairedAccess = await browserJson(harness, {
      method: "GET",
      path: "/api/v1/access"
    });
    expect(unpairedAccess.status).toBe(200);
    expect(unpairedAccess.json()).toMatchObject({
      authentication_state: "unpaired",
      network_mode: "lan",
      transport: "https",
      can_read_sessions: false,
      can_write_sessions: false
    });
    const unpairedRead = await browserJson(harness, {
      method: "GET",
      path: "/__acceptance/v1/read"
    });
    expect(unpairedRead.status).toBe(401);
    expect(unpairedRead.body).not.toContain("hostdeck-protected-acceptance-marker");
    expect(harness.snapshot().sentinel_write_dispatches).toBe(0);

    const reader = await issueAndClaim(harness, "read", "Reader Android");
    const usedReaderCode = await claimPairingCode(
      harness,
      reader.pairingCode,
      "op_acceptance_claim_reader_used_0001",
      "Used Reader Android"
    );
    expect(usedReaderCode.status).toBe(401);
    expect(usedReaderCode.json()).toMatchObject({
      error: { code: "permission_denied" }
    });
    expect(usedReaderCode.headers["set-cookie"]).toBeUndefined();
    const readerRead = await browserJson(harness, {
      cookie: reader.cookie,
      method: "GET",
      path: "/__acceptance/v1/read"
    });
    expect(readerRead.status).toBe(200);
    expect(readerRead.json()).toEqual({
      protected_marker: "hostdeck-protected-acceptance-marker"
    });
    const readerWrite = await browserJson(harness, {
      cookie: reader.cookie,
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_reader_write_0001" }
    });
    expect(readerWrite.status).toBe(403);
    expect(readerWrite.json()).toMatchObject({ error: { code: "read_only" } });
    expect(harness.snapshot().sentinel_write_dispatches).toBe(0);

    const writer = await issueAndClaim(harness, "write", "Writer Android");
    assertDeviceCookie(writer.setCookie);
    expect(harness.snapshot()).toMatchObject({
      cookie_response_observations: 2,
      pairing_cookie_metadata_observed: true
    });
    expect(writer.claimBody).not.toHaveProperty("rawDeviceToken");
    expect(writer.claimBody).not.toHaveProperty("csrf_token");
    const firstCsrf = await bootstrapCsrf(
      harness,
      writer.cookie,
      "op_acceptance_csrf_writer_0001"
    );
    const acceptedWrite = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: firstCsrf,
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_writer_write_0001" }
    });
    expect(acceptedWrite.status).toBe(200);
    expect(acceptedWrite.json()).toEqual({ dispatch_count: 1 });

    const missingCsrf = await browserJson(harness, {
      cookie: writer.cookie,
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_missing_csrf_0001" }
    });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "permission_denied" } });
    const secondCsrf = await bootstrapCsrf(
      harness,
      writer.cookie,
      "op_acceptance_csrf_writer_0002"
    );
    const staleCsrf = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: firstCsrf,
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_stale_csrf_0001" }
    });
    expect(staleCsrf.status).toBe(403);
    expect(staleCsrf.json()).toMatchObject({ error: { code: "permission_denied" } });
    expect(harness.snapshot().sentinel_write_dispatches).toBe(1);

    const foreignOrigin = await browserJson(harness, {
      cookie: writer.cookie,
      method: "GET",
      origin: "https://attacker.invalid",
      path: "/__acceptance/v1/read"
    });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.body).not.toContain("hostdeck-protected-acceptance-marker");
    assertNoCors(foreignOrigin.headers);
    const foreignHost = await browserJson(harness, {
      cookie: writer.cookie,
      hostHeader: "attacker.invalid",
      method: "GET",
      path: "/__acceptance/v1/read"
    });
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.body).not.toContain("hostdeck-protected-acceptance-marker");
    assertNoCors(foreignHost.headers);

    const lock = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: secondCsrf,
      method: "POST",
      path: "/api/v1/access/lock",
      payload: { operation_id: "op_acceptance_lock_writer_0001", confirmed: true }
    });
    expect(lock.status).toBe(200);
    expect(lock.json()).toMatchObject({ locked: true, can_write_sessions: false });
    const lockedWrite = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: secondCsrf,
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_locked_write_0001" }
    });
    expect(lockedWrite.status).toBe(423);
    expect(lockedWrite.json()).toMatchObject({ error: { code: "host_locked" } });
    expect(harness.snapshot()).toMatchObject({
      lock_gate_rejections: 1,
      sentinel_write_dispatches: 1
    });
    const remoteUnlock = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: secondCsrf,
      method: "POST",
      path: "/api/v1/access/unlock",
      payload: { operation_id: "op_acceptance_remote_unlock_0001", confirmed: true }
    });
    expect(remoteUnlock.status).toBe(403);
    const localUnlock = await localAdminJson(harness, {
      method: "POST",
      path: "/api/v1/access/unlock",
      payload: { operation_id: "op_acceptance_local_unlock_0001", confirmed: true }
    });
    expect(localUnlock.statusCode, localUnlock.body).toBe(200);
    expect(localUnlock.json()).toMatchObject({ locked: false });
    const restoredWrite = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: secondCsrf,
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_restored_write_0001" }
    });
    expect(restoredWrite.status).toBe(200);
    expect(restoredWrite.json()).toEqual({ dispatch_count: 2 });

    const list = await browserJson(harness, {
      cookie: writer.cookie,
      method: "GET",
      path: "/api/v1/access/devices?limit=50"
    });
    expect(list.status).toBe(200);
    expect(list.json()).toMatchObject({
      devices: expect.arrayContaining([
        expect.objectContaining({ device_id: reader.deviceId, permission: "read" }),
        expect.objectContaining({ device_id: writer.deviceId, permission: "write" })
      ])
    });
    expect(list.body).not.toContain(reader.rawCookieValue);
    expect(list.body).not.toContain(writer.rawCookieValue);

    const readerStream = openSse(harness, reader.cookie);
    await readerStream.firstEvent;
    expect(harness.snapshot().active_sse_sources).toBe(1);
    const revokeReader = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: secondCsrf,
      method: "POST",
      path: `/api/v1/access/devices/${reader.deviceId}/revoke`,
      payload: { operation_id: "op_acceptance_revoke_reader_0001", confirmed: true }
    });
    expect(revokeReader.status).toBe(200);
    expect(revokeReader.json()).toMatchObject({
      device_id: reader.deviceId,
      self_revoked: false,
      authority_invalidated: true
    });
    await readerStream.closed;
    expect(harness.snapshot()).toMatchObject({
      active_sse_sources: 0,
      closed_sse_sources: 1
    });
    const revokedReader = await browserJson(harness, {
      cookie: reader.cookie,
      method: "GET",
      path: "/__acceptance/v1/read"
    });
    expect(revokedReader.status).toBe(401);

    const selfRevoke = await browserJson(harness, {
      cookie: writer.cookie,
      csrf: secondCsrf,
      method: "POST",
      path: `/api/v1/access/devices/${writer.deviceId}/revoke`,
      payload: { operation_id: "op_acceptance_revoke_self_0001", confirmed: true }
    });
    expect(selfRevoke.status).toBe(200);
    expect(selfRevoke.json()).toMatchObject({ self_revoked: true });
    assertDeletionCookie(singleSetCookie(selfRevoke.headers));
    expect(harness.snapshot().deletion_cookie_metadata_observed).toBe(true);
    for (const request of [
      { method: "GET" as const, path: "/__acceptance/v1/read" },
      {
        method: "POST" as const,
        path: "/api/v1/access/csrf",
        payload: { operation_id: "op_acceptance_revoked_csrf_0001" }
      },
      {
        method: "POST" as const,
        path: "/__acceptance/v1/write",
        payload: { operation_id: "op_acceptance_revoked_write_0001" }
      }
    ]) {
      const denied = await browserJson(harness, {
        ...request,
        cookie: writer.cookie,
        csrf: secondCsrf
      });
      expect(denied.status).toBe(401);
      expect(denied.body).not.toContain("hostdeck-protected-acceptance-marker");
    }

    for (const operationId of [
      "op_acceptance_lan_configure_0001",
      "op_acceptance_lan_enable_0001",
      "op_acceptance_issue_reader_0001",
      "op_acceptance_claim_reader_0001",
      "op_acceptance_issue_writer_0001",
      "op_acceptance_claim_writer_0001",
      "op_acceptance_csrf_writer_0001",
      "op_acceptance_csrf_writer_0002",
      "op_acceptance_lock_writer_0001",
      "op_acceptance_local_unlock_0001",
      "op_acceptance_revoke_reader_0001",
      "op_acceptance_revoke_self_0001"
    ]) {
      expect(harness.audit.require(operationId)).toMatchObject({
        operation_id: operationId,
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "succeeded", error_code: null }
        ]
      });
    }
    expect(harness.audit.require("op_acceptance_claim_reader_used_0001")).toMatchObject({
      state: "terminal",
      records: [
        { phase: "accepted", outcome: "accepted" },
        {
          phase: "terminal",
          outcome: "failed",
          error_code: "permission_denied"
        }
      ]
    });
    expect(harness.audit.get("op_acceptance_remote_unlock_0001")).toBeNull();
    expect(harness.internalErrors).toEqual([]);
    expect(await plaintextRequest(harness)).toMatchObject({ refused: true });
    const driver = await browserJson(harness, {
      method: "GET",
      path: securityAcceptanceDriverPath
    });
    expect(driver.status).toBe(200);
    expect(driver.headers["content-type"]).toContain("text/html");
    expect(driver.body).toContain("HostDeck Security Acceptance");
    assertNoCors(driver.headers);
    const cacheBustedDriver = await browserJson(harness, {
      method: "GET",
      path: `${securityAcceptanceDriverPath}?run=return-1752422400000`
    });
    expect(cacheBustedDriver.status).toBe(200);
    expect(cacheBustedDriver.body).toContain("window.__hostDeckAcceptance");
    for (const invalidPath of [
      `${securityAcceptanceDriverPath}?return=1752422400000`,
      `${securityAcceptanceDriverPath}?run=unbounded`,
      `${securityAcceptanceDriverPath}?run=return-1752422400000&extra=1`
    ]) {
      expect(
        (await browserJson(harness, { method: "GET", path: invalidPath })).status
      ).toBe(400);
    }

    scanDatabaseForSecrets(harness, [
      reader.rawCookieValue,
      writer.rawCookieValue,
      reader.pairingCode,
      writer.pairingCode,
      firstCsrf.token,
      secondCsrf.token
    ]);
    expect(harness.scanPrivacy()).toMatchObject({
      files_checked: expect.any(Number),
      leaks_found: 0,
      secrets_checked: expect.any(Number)
    });
    await harness.close();
    expect(harness.snapshot()).toMatchObject({
      active_authority_leases: 0,
      active_sse_sources: 0
    });
  }, 30_000);

  it("fails expired and malformed device credentials without protected data or dispatch", async () => {
    const expiringToken = "E".repeat(43);
    const expiringCsrf = "F".repeat(43);
    const expiresAt = new Date(initialNow.getTime() + 60_000);
    const harness = await createHarness({
      seedDevices: [{
        clientLabel: "Expiring Android",
        expiresAt,
        id: "client_expiring_security_01",
        permission: "write",
        rawCsrfToken: expiringCsrf,
        rawDeviceToken: expiringToken
      }]
    });
    harness.clock.advance(61_000);
    for (const cookie of [
      `${hostDeckDeviceCookieName}=${expiringToken}`,
      `${hostDeckDeviceCookieName}=malformed`,
      `${hostDeckDeviceCookieName}=${"U".repeat(43)}`,
      `${hostDeckDeviceCookieName}=${expiringToken}; ${hostDeckDeviceCookieName}=${expiringToken}`
    ]) {
      const response = await browserJson(harness, {
        cookie,
        method: "GET",
        path: "/__acceptance/v1/read"
      });
      expect(response.status).toBe(401);
      expect(response.body).not.toContain("hostdeck-protected-acceptance-marker");
      assertNoCors(response.headers);
    }
    expect(harness.snapshot().sentinel_write_dispatches).toBe(0);
  }, 30_000);

  it("keeps expired, rate-limited, and overlapping pairing claims generic and single-winner", async () => {
    const expiredHarness = await createHarness();
    const expiredCode = await issuePairingCode(
      expiredHarness,
      "write",
      "Expired Android",
      "op_acceptance_issue_expired_0001"
    );
    expiredHarness.clock.advance(defaultResourceBudget.pairing_code_lifetime_ms + 1);
    const expired = await claimPairingCode(
      expiredHarness,
      expiredCode,
      "op_acceptance_claim_expired_0001",
      "Expired Android"
    );
    expect(expired.status).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: "permission_denied" } });
    expect(expired.headers["set-cookie"]).toBeUndefined();

    const rateHarness = await createHarness();
    for (
      let attempt = 1;
      attempt <= defaultResourceBudget.pair_claim_max_attempts_per_source;
      attempt += 1
    ) {
      const response = await claimPairingCode(
        rateHarness,
        "Z".repeat(22),
        `op_acceptance_invalid_${String(attempt).padStart(4, "0")}`,
        "Invalid Android"
      );
      expect(response.status).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const limited = await claimPairingCode(
      rateHarness,
      "Y".repeat(22),
      "op_acceptance_rate_limited_0001",
      "Limited Android"
    );
    expect(limited.status).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(limited.headers["set-cookie"]).toBeUndefined();

    const overlapHarness = await createHarness({ holdFirstClaim: true });
    const overlapCode = await issuePairingCode(
      overlapHarness,
      "write",
      "Overlap Android",
      "op_acceptance_issue_overlap_0001"
    );
    const winnerPromise = claimPairingCode(
      overlapHarness,
      overlapCode,
      "op_acceptance_claim_overlap_0001",
      "Overlap Android"
    );
    await overlapHarness.claimStarted;
    const rejected = await claimPairingCode(
      overlapHarness,
      overlapCode,
      "op_acceptance_claim_overlap_0002",
      "Overlap Android"
    );
    expect(rejected.status).toBe(503);
    expect(rejected.json()).toMatchObject({ error: { code: "service_overloaded" } });
    expect(rejected.headers["set-cookie"]).toBeUndefined();
    overlapHarness.releaseHeldClaim();
    const winner = await winnerPromise;
    expect(winner.status).toBe(200);
    assertDeviceCookie(singleSetCookie(winner.headers));
    expect(overlapHarness.snapshot()).toMatchObject({
      pairing_claim_successes: 1
    });
  }, 30_000);

  it("rejects hostile Host, Origin, preflight, and duplicate-header forms before sentinel dispatch", async () => {
    const harness = await createHarness();
    const writer = await issueAndClaim(harness, "write", "Trust Android");
    const csrf = await bootstrapCsrf(
      harness,
      writer.cookie,
      "op_acceptance_csrf_trust_0001"
    );
    const initialDispatches = harness.snapshot().sentinel_write_dispatches;
    const hostileHosts = [
      "attacker.invalid",
      `${harness.bindHost}.attacker.invalid`,
      `${harness.bindHost}:${harness.bindPort + 1}`,
      `${harness.bindHost}.`,
      `user@${harness.bindHost}`,
      `${harness.bindHost},attacker.invalid`
    ];
    for (const hostHeader of hostileHosts) {
      const response = await browserJson(harness, {
        cookie: writer.cookie,
        hostHeader,
        method: "GET",
        path: "/__acceptance/v1/read"
      });
      expect([400, 403], `host=${hostHeader}`).toContain(response.status);
      expect(response.body).not.toContain("hostdeck-protected-acceptance-marker");
      assertNoCors(response.headers);
    }
    const hostileOrigins = [
      "null",
      "https://attacker.invalid",
      `http://${harness.bindHost}:${harness.bindPort}`,
      `${harness.origin}/`,
      `${harness.origin}?query=1`,
      `https://user@${harness.bindHost}:${harness.bindPort}`
    ];
    for (const origin of hostileOrigins) {
      const response = await browserJson(harness, {
        cookie: writer.cookie,
        method: "GET",
        origin,
        path: "/__acceptance/v1/read"
      });
      expect(response.status).toBe(403);
      expect(response.body).not.toContain("hostdeck-protected-acceptance-marker");
      assertNoCors(response.headers);
    }
    const browserMissingOrigin = await browserJson(harness, {
      cookie: writer.cookie,
      csrf,
      method: "POST",
      origin: null,
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_missing_origin_0001" },
      extraHeaders: { "sec-fetch-site": "same-origin" }
    });
    expect(browserMissingOrigin.status).toBe(403);
    const safeMissingOrigin = await browserJson(harness, {
      cookie: writer.cookie,
      method: "GET",
      origin: null,
      path: "/__acceptance/v1/read"
    });
    expect(safeMissingOrigin.status).toBe(200);

    const preflight = await browserJson(harness, {
      method: "OPTIONS",
      path: "/__acceptance/v1/write",
      extraHeaders: { "access-control-request-method": "POST" }
    });
    expect(preflight.status).toBe(403);
    assertNoCors(preflight.headers);

    const exactAuthority = `${harness.bindHost}:${harness.bindPort}`;
    for (const rawRequest of [
      "GET /__acceptance/v1/read HTTP/1.1\r\nConnection: close\r\n\r\n",
      `GET /__acceptance/v1/read HTTP/1.1\r\nHost: ${exactAuthority}\r\nHost: ${exactAuthority}\r\nConnection: close\r\n\r\n`,
      `GET /__acceptance/v1/read HTTP/1.1\r\nHost: ${exactAuthority}\r\nOrigin: ${harness.origin}\r\nOrigin: ${harness.origin}\r\nConnection: close\r\n\r\n`
    ]) {
      const response = await rawTlsRequest(harness, rawRequest);
      expect([400, 403]).toContain(response.status);
      expect(response.body).not.toContain("hostdeck-protected-acceptance-marker");
      assertNoCors(response.headers);
    }
    expect(harness.snapshot().sentinel_write_dispatches).toBe(initialDispatches);
    expect(harness.internalErrors).toEqual([]);
  }, 30_000);

  it("binds CSRF to the authenticated device and enforces the durable global claim ceiling", async () => {
    const firstToken = "A".repeat(43);
    const firstCsrf = "B".repeat(43);
    const secondToken = "C".repeat(43);
    const secondCsrf = "D".repeat(43);
    const csrfHarness = await createHarness({
      seedDevices: [
        {
          clientLabel: "First writer",
          id: "client_security_writer_01",
          permission: "write",
          rawCsrfToken: firstCsrf,
          rawDeviceToken: firstToken
        },
        {
          clientLabel: "Second writer",
          id: "client_security_writer_02",
          permission: "write",
          rawCsrfToken: secondCsrf,
          rawDeviceToken: secondToken
        }
      ]
    });
    const firstCookie = `${hostDeckDeviceCookieName}=${firstToken}`;
    const secondCookie = `${hostDeckDeviceCookieName}=${secondToken}`;
    const firstAccepted = await browserJson(csrfHarness, {
      cookie: firstCookie,
      csrf: { generation: 1, token: firstCsrf },
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_first_writer_0001" }
    });
    expect(firstAccepted.status).toBe(200);
    const wrongDevice = await browserJson(csrfHarness, {
      cookie: secondCookie,
      csrf: { generation: 1, token: firstCsrf },
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_wrong_device_0001" }
    });
    expect(wrongDevice.status).toBe(403);
    expect(wrongDevice.json()).toMatchObject({ error: { code: "permission_denied" } });
    expect(wrongDevice.body).not.toContain(firstCsrf);
    expect(csrfHarness.snapshot().sentinel_write_dispatches).toBe(1);
    const secondAccepted = await browserJson(csrfHarness, {
      cookie: secondCookie,
      csrf: { generation: 1, token: secondCsrf },
      method: "POST",
      path: "/__acceptance/v1/write",
      payload: { operation_id: "op_acceptance_second_writer_0001" }
    });
    expect(secondAccepted.status).toBe(200);
    expect(csrfHarness.snapshot().sentinel_write_dispatches).toBe(2);

    const rateHarness = await createHarness({
      resourceBudget: resolveResourceBudget({
        pair_claim_max_attempts_global: 2,
        pair_claim_max_attempts_per_source: 2
      })
    });
    const firstInvalid = await claimPairingCode(
      rateHarness,
      "Q".repeat(22),
      "op_acceptance_global_rate_0001",
      "Global rate one",
      "127.0.0.1"
    );
    const secondInvalid = await claimPairingCode(
      rateHarness,
      "R".repeat(22),
      "op_acceptance_global_rate_0002",
      "Global rate two",
      "127.0.0.2"
    );
    const globallyLimited = await claimPairingCode(
      rateHarness,
      "S".repeat(22),
      "op_acceptance_global_rate_0003",
      "Global rate three",
      "127.0.0.3"
    );
    expect(firstInvalid.status).toBe(401);
    expect(secondInvalid.status).toBe(401);
    expect(globallyLimited.status).toBe(429);
    expect(globallyLimited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(globallyLimited.headers["set-cookie"]).toBeUndefined();
  }, 30_000);

  it("aborts a paired SSE authority while its aggregate source is still opening", async () => {
    const actorToken = "G".repeat(43);
    const actorCsrf = "H".repeat(43);
    const targetToken = "I".repeat(43);
    const harness = await createHarness({
      holdFirstSseOpen: true,
      seedDevices: [
        {
          clientLabel: "SSE revoke actor",
          id: "client_security_sse_actor",
          permission: "write",
          rawCsrfToken: actorCsrf,
          rawDeviceToken: actorToken
        },
        {
          clientLabel: "SSE revoke target",
          id: "client_security_sse_target",
          permission: "read",
          rawCsrfToken: "J".repeat(43),
          rawDeviceToken: targetToken
        }
      ]
    });
    const stream = openSse(
      harness,
      `${hostDeckDeviceCookieName}=${targetToken}`
    );
    await harness.sseOpenStarted;
    expect(harness.snapshot()).toMatchObject({
      active_authority_leases: 1,
      active_sse_sources: 0,
      aborted_sse_opens: 0
    });
    const revoke = await browserJson(harness, {
      cookie: `${hostDeckDeviceCookieName}=${actorToken}`,
      csrf: { generation: 1, token: actorCsrf },
      method: "POST",
      path: "/api/v1/access/devices/client_security_sse_target/revoke",
      payload: {
        operation_id: "op_acceptance_revoke_open_sse_0001",
        confirmed: true
      }
    });
    expect(revoke.status).toBe(200);
    await stream.closed;
    expect(harness.snapshot()).toMatchObject({
      aborted_sse_opens: 1,
      active_authority_leases: 0,
      active_sse_sources: 0
    });
    expect(harness.audit.require("op_acceptance_revoke_open_sse_0001")).toMatchObject({
      state: "terminal",
      records: [
        { phase: "accepted", outcome: "accepted" },
        { phase: "terminal", outcome: "succeeded" }
      ]
    });
  }, 30_000);
});

async function createHarness(
  options: Pick<
    Parameters<typeof createSecurityAcceptanceHarness>[0],
    "holdFirstClaim" | "holdFirstSseOpen" | "resourceBudget" | "seedDevices"
  > = {}
): Promise<SecurityAcceptanceHarness> {
  const bindHost = requirePrivateIpv4();
  const bindPort = await reservePort(bindHost);
  const rootDirectory = mkdtempSync(join(tmpdir(), "hostdeck-security-acceptance-"));
  temporaryDirectories.push(rootDirectory);
  const harness = await createSecurityAcceptanceHarness({
    bindHost,
    bindPort,
    initialNow,
    rootDirectory,
    ...options
  });
  openedHarnesses.push(harness);
  return harness;
}

interface JsonRequestInput {
  readonly cookie?: string;
  readonly csrf?: { readonly generation: number; readonly token: string };
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly hostHeader?: string;
  readonly localAddress?: string;
  readonly method: "GET" | "OPTIONS" | "POST";
  readonly origin?: string | null;
  readonly path: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

interface HttpResponse {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly status: number;
  readonly json: () => Record<string, unknown>;
}

async function browserJson(
  harness: SecurityAcceptanceHarness,
  input: JsonRequestInput
): Promise<HttpResponse> {
  const body = input.payload === undefined ? "" : JSON.stringify(input.payload);
  const headers: Record<string, string | number> = {
    accept: input.path === "/__acceptance/v1/events" ? "text/event-stream" : "application/json",
    host: input.hostHeader ?? `${harness.bindHost}:${harness.bindPort}`,
    ...input.extraHeaders
  };
  if (input.origin !== null) headers.origin = input.origin ?? harness.origin;
  if (input.cookie !== undefined) headers.cookie = input.cookie;
  if (input.csrf !== undefined) {
    headers["x-hostdeck-csrf"] = input.csrf.token;
    headers["x-hostdeck-csrf-generation"] = String(input.csrf.generation);
  }
  if (body.length > 0) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return tlsExchange(
    harness,
    input.method,
    input.path,
    headers,
    body,
    input.localAddress
  );
}

async function localAdminJson(
  harness: SecurityAcceptanceHarness,
  input: Pick<JsonRequestInput, "method" | "path" | "payload">
) {
  const body = input.payload === undefined ? "" : JSON.stringify(input.payload);
  const response = await tlsExchange(
    harness,
    input.method,
    input.path,
    {
      accept: "application/json",
      host: `${harness.bindHost}:${harness.bindPort}`,
      ...(body.length === 0
        ? {}
        : {
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json"
          })
    },
    body,
    "127.0.0.1"
  );
  return {
    body: response.body,
    headers: response.headers,
    json: response.json,
    statusCode: response.status
  };
}

async function issueAndClaim(
  harness: SecurityAcceptanceHarness,
  permission: "read" | "write",
  clientLabel: string
): Promise<{
  readonly claimBody: Record<string, unknown>;
  readonly cookie: string;
  readonly deviceId: string;
  readonly rawCookieValue: string;
  readonly pairingCode: string;
  readonly setCookie: string;
}> {
  const suffix = permission === "read" ? "reader" : "writer";
  const issue = await localAdminJson(harness, {
    method: "POST",
    path: "/api/v1/access/pairing-codes",
    payload: {
      operation_id: `op_acceptance_issue_${suffix}_0001`,
      permission,
      client_label: clientLabel
    }
  });
  expect(issue.statusCode, issue.body).toBe(200);
  const issued = issue.json();
  expect(issued).toMatchObject({ permission, client_label: clientLabel });
  const code = String(issued.code);
  const claim = await browserJson(harness, {
    method: "POST",
    path: "/api/v1/access/pairing-claims",
    payload: {
      operation_id: `op_acceptance_claim_${suffix}_0001`,
      code,
      client_label: clientLabel
    }
  });
  expect(claim.status, claim.body).toBe(200);
  const claimBody = claim.json();
  const setCookie = singleSetCookie(claim.headers);
  const cookie = setCookie.split(";", 1)[0] ?? "";
  const rawCookieValue = cookie.slice(cookie.indexOf("=") + 1);
  expect(rawCookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return {
    claimBody,
    cookie,
    deviceId: String(claimBody.device_id),
    pairingCode: code,
    rawCookieValue,
    setCookie
  };
}

async function issuePairingCode(
  harness: SecurityAcceptanceHarness,
  permission: "read" | "write",
  clientLabel: string,
  operationId: string
): Promise<string> {
  const response = await localAdminJson(harness, {
    method: "POST",
    path: "/api/v1/access/pairing-codes",
    payload: {
      operation_id: operationId,
      permission,
      client_label: clientLabel
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  return String(response.json().code);
}

function claimPairingCode(
  harness: SecurityAcceptanceHarness,
  code: string,
  operationId: string,
  clientLabel: string,
  localAddress?: string
): Promise<HttpResponse> {
  return browserJson(harness, {
    method: "POST",
    ...(localAddress === undefined ? {} : { localAddress }),
    path: "/api/v1/access/pairing-claims",
    payload: {
      operation_id: operationId,
      code,
      client_label: clientLabel
    }
  });
}

async function bootstrapCsrf(
  harness: SecurityAcceptanceHarness,
  cookie: string,
  operationId: string
): Promise<{ readonly generation: number; readonly token: string }> {
  const response = await browserJson(harness, {
    cookie,
    method: "POST",
    path: "/api/v1/access/csrf",
    payload: { operation_id: operationId }
  });
  expect(response.status, response.body).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = response.json();
  return {
    generation: Number(body.csrf_generation),
    token: String(body.csrf_token)
  };
}

function tlsExchange(
  harness: SecurityAcceptanceHarness,
  method: "GET" | "OPTIONS" | "POST",
  path: string,
  headers: Readonly<Record<string, string | number>>,
  body: string,
  localAddress?: string
): Promise<HttpResponse> {
  const ca = new X509Certificate(Buffer.from(harness.enrollment.certificate_der)).toString();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        ca,
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(harness.bindHost, certificate),
        headers,
        host: harness.bindHost,
        ...(localAddress === undefined ? {} : { localAddress }),
        method,
        path,
        port: harness.bindPort,
        rejectUnauthorized: true,
        servername: ""
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: responseBody,
            headers: response.headers,
            status: response.statusCode ?? 0,
            json: () => JSON.parse(responseBody) as Record<string, unknown>
          });
        });
        response.once("error", reject);
      }
    );
    request.setTimeout(5000, () => request.destroy(new Error("Security acceptance HTTPS request timed out.")));
    request.once("error", reject);
    request.end(body.length === 0 ? undefined : body);
  });
}

function rawTlsRequest(
  harness: SecurityAcceptanceHarness,
  rawRequest: string
): Promise<HttpResponse> {
  const ca = new X509Certificate(Buffer.from(harness.enrollment.certificate_der)).toString();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = tlsConnect({
      ca,
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity(harness.bindHost, certificate),
      host: harness.bindHost,
      port: harness.bindPort,
      rejectUnauthorized: true,
      servername: ""
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("Raw security acceptance TLS request timed out.")));
    socket.once("secureConnect", () => socket.end(rawRequest));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(parseRawHttpResponse(raw));
    });
  });
}

function parseRawHttpResponse(raw: string): HttpResponse {
  const boundary = raw.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("Raw security acceptance response has no header boundary.");
  const headerLines = raw.slice(0, boundary).split("\r\n");
  const statusLine = headerLines.shift() ?? "";
  const statusMatch = /^HTTP\/1\.1 ([0-9]{3}) /u.exec(statusLine);
  if (statusMatch?.[1] === undefined) {
    throw new Error("Raw security acceptance response has no status.");
  }
  const headers: IncomingHttpHeaders = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  const body = raw.slice(boundary + 4);
  return {
    body,
    headers,
    status: Number(statusMatch[1]),
    json: () => JSON.parse(body) as Record<string, unknown>
  };
}

function openSse(harness: SecurityAcceptanceHarness, cookie: string): {
  readonly closed: Promise<void>;
  readonly firstEvent: Promise<void>;
} {
  let resolveClosed: () => void = () => undefined;
  let resolveFirstEvent: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const firstEvent = new Promise<void>((resolve) => {
    resolveFirstEvent = resolve;
  });
  const ca = new X509Certificate(Buffer.from(harness.enrollment.certificate_der)).toString();
  const request = httpsRequest({
    ca,
    headers: {
      accept: "text/event-stream",
      cookie,
      host: `${harness.bindHost}:${harness.bindPort}`,
      origin: harness.origin
    },
    host: harness.bindHost,
    method: "GET",
    path: "/__acceptance/v1/events",
    port: harness.bindPort,
    rejectUnauthorized: true
  });
  request.once("response", (response) => {
    let observed = "";
    response.on("data", (chunk: Buffer) => {
      observed += chunk.toString("utf8");
      if (observed.includes("event: message")) resolveFirstEvent();
    });
    response.once("end", resolveClosed);
    response.once("close", resolveClosed);
  });
  request.once("error", resolveClosed);
  request.end();
  return { closed, firstEvent };
}

function plaintextRequest(
  harness: SecurityAcceptanceHarness
): Promise<{ readonly refused: boolean }> {
  return new Promise((resolve) => {
    const request = httpGet(
      {
        agent: false,
        headers: { host: `${harness.bindHost}:${harness.bindPort}` },
        host: harness.bindHost,
        path: "/__acceptance/v1/read",
        port: harness.bindPort
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve({ refused: false }));
      }
    );
    request.setTimeout(3000, () => request.destroy());
    request.once("error", () => resolve({ refused: true }));
  });
}

function assertDeviceCookie(setCookie: string): void {
  expect(setCookie).toContain(`${hostDeckDeviceCookieName}=`);
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).not.toMatch(/(?:^|;)\s*Domain=/iu);
}

function assertDeletionCookie(setCookie: string): void {
  assertDeviceCookie(setCookie);
  expect(setCookie).toContain(`${hostDeckDeviceCookieName}=`);
  expect(setCookie).toContain("Max-Age=0");
  expect(setCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
}

function singleSetCookie(headers: IncomingHttpHeaders): string {
  const value = headers["set-cookie"];
  if (!Array.isArray(value) || value.length !== 1 || value[0] === undefined) {
    throw new Error("Security acceptance expected exactly one Set-Cookie header.");
  }
  return value[0];
}

function assertNoCors(headers: IncomingHttpHeaders): void {
  expect(headers["access-control-allow-origin"]).toBeUndefined();
  expect(headers["access-control-allow-credentials"]).toBeUndefined();
}

function scanDatabaseForSecrets(
  harness: SecurityAcceptanceHarness,
  secrets: readonly string[]
): void {
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const path = `${harness.databasePath}${suffix}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const secret of secrets) {
      expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
    }
  }
}

function requirePrivateIpv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const octets = address.address.split(".").map(Number);
      const first = octets[0];
      const second = octets[1];
      if (
        first === 10 ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      ) {
        return address.address;
      }
    }
  }
  throw new Error("Security acceptance requires one assigned private IPv4 address.");
}

function reservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Security acceptance port reservation failed."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolve(address.port) : reject(error)
      );
    });
  });
}
