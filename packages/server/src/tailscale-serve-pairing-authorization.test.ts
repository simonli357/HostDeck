import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  resolveResourceBudget,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createPairingCodeRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserPairingResponsePort,
  bootstrapBrowserPairing,
  browserCsrfBootstrapPath,
  browserPairClaimPath
} from "../../web/src/pairing-bootstrap.js";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration
} from "./csrf-routes.js";
import {
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  hostDeckRequestAuthenticationSnapshot,
  requireHostDeckRequestAuthentication,
  resolveHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  type HostDeckPairingPolicy,
  hostDeckPairingPolicySnapshot
} from "./pairing-routes.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import {
  createSecurityMutationAuditExecutor,
  type SecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";
import {
  createTailscaleServeProxyTrustPolicy,
  type TailscaleServeRemoteAdmissionSnapshot,
  tailscaleServeProxyTrustSnapshot
} from "./tailscale-serve-proxy-trust.js";

const baseTime = new Date("2026-07-13T21:00:00.000Z");
const localOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-fixture.fixture-tailnet.ts.net";
const sourceA = "100.64.10.20";
const sourceB = "100.127.30.40";
const rawPairingCode = "abcdefghijklmnopqrstuv";
const rawDeviceToken = "D".repeat(43);
const rawCsrfToken = "C".repeat(43);
const rotatedCsrfToken = "R".repeat(43);
const identityLogin = "private-fixture@example.test";
const tempDirectories: string[] = [];
const openApps: HostDeckFastifyInstance[] = [];
const openDatabases: Array<ReturnType<typeof openMigratedDatabase>["db"]> = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Tailscale Serve pairing authorization composition", () => {
  it("composes fragment bootstrap through remote claim, hardened cookie, CSRF, audit, and SQLite", async () => {
    const harness = createHarness();
    await harness.app.ready();
    const issued = await issueCode(
      harness.app,
      "op_remote_browser_issue_01",
      "write"
    );
    const location = {
      origin: externalOrigin,
      pathname: "/",
      search: "",
      hash: `#pair=${issued.code}`
    };
    const order: string[] = [];
    const requests: Array<{
      readonly path: string;
      readonly body: string;
      readonly referrerPolicy: string;
    }> = [];
    let deviceCookie: string | null = null;
    let operationIndex = 0;

    const result = await bootstrapBrowserPairing({
      location,
      history: {
        state: { retained: true },
        replaceState(data, _unused, path) {
          expect(data).toEqual({ retained: true });
          order.push(`history:${path}`);
          location.hash = "";
        }
      },
      createOperationId(operation) {
        operationIndex += 1;
        order.push(`id:${operation}`);
        return `op_remote_browser_${operation}_${String(operationIndex).padStart(2, "0")}`;
      },
      fetch: async (path, init) => {
        order.push(`fetch:${path}`);
        expect(location.hash).toBe("");
        const body = init.body;
        requests.push({ path, body, referrerPolicy: init.referrerPolicy });
        const response = await harness.app.inject({
          headers: {
            ...remoteHeaders(sourceA, {
              contentType: true,
              origin: true,
              ...(deviceCookie === null ? {} : { cookie: deviceCookie })
            }),
            accept: "application/json",
            "cache-control": "no-store"
          },
          method: "POST",
          payload: body,
          url: path
        });
        const setCookie = response.headers["set-cookie"];
        if (setCookie !== undefined) {
          const cookie = requireSingleHeader(setCookie);
          const match = new RegExp(`^${hostDeckDeviceCookieName}=([^;]+)`, "u").exec(cookie);
          if (match?.[1] !== undefined) deviceCookie = match[1];
        }
        return browserResponse(response.statusCode, response.headers, response.body);
      }
    });

    expect(result).toMatchObject({
      state: "paired",
      permission: "write",
      client_label: "Android phone",
      csrf_token: rotatedCsrfToken,
      csrf_generation: 2
    });
    expect(JSON.stringify(result)).not.toContain(issued.code);
    expect(JSON.stringify(result)).not.toContain(rawDeviceToken);
    expect(deviceCookie).toBe(rawDeviceToken);
    expect(order).toEqual([
      "history:/",
      "id:pair_claim",
      `fetch:${browserPairClaimPath}`,
      "id:csrf_bootstrap",
      `fetch:${browserCsrfBootstrapPath}`
    ]);
    expect(requests.map(({ path }) => path)).toEqual([
      browserPairClaimPath,
      browserCsrfBootstrapPath
    ]);
    expect(requests.every(({ path }) => !path.includes(issued.code))).toBe(true);
    expect(requests.every(({ referrerPolicy }) => referrerPolicy === "no-referrer")).toBe(true);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()
    ).toEqual({ count: 1 });
    expect(harness.pairing.require(issued.pairing_id)).toMatchObject({
      used_at: baseTime.toISOString(),
      claimed_device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    expect(
      harness.audit.require("op_remote_browser_issue_01").records.at(-1)
    ).toMatchObject({ phase: "terminal", outcome: "succeeded" });
    expect(
      harness.audit.require("op_remote_browser_pair_claim_01").records.at(-1)
    ).toMatchObject({ phase: "terminal", outcome: "succeeded" });
    expect(
      harness.audit.require("op_remote_browser_csrf_bootstrap_02").records.at(-1)
    ).toMatchObject({ phase: "terminal", outcome: "succeeded" });

    const auditRows = JSON.stringify(
      harness.db
        .prepare("SELECT * FROM selected_audit_events ORDER BY operation_id, phase")
        .all()
    );
    for (const secret of [issued.code, rawDeviceToken, rawCsrfToken, rotatedCsrfToken]) {
      expect(auditRows).not.toContain(secret);
    }
    assertSecretsAbsentFromSqlite(harness.dbPath, [
      issued.code,
      rawDeviceToken,
      rawCsrfToken,
      rotatedCsrfToken
    ]);
  });

  it("uses admitted source hashing for SQLite limits and issues only a hardened device cookie", async () => {
    const harness = createHarness();
    await harness.app.ready();
    const issued = await issueCode(harness.app, "op_remote_pair_issue_01", "write");
    expect(issued.code).toBe(rawPairingCode);
    expect(harness.admissionReads()).toBe(0);

    const claim = await injectClaim(
      harness.app,
      "op_remote_pair_claim_01",
      issued.code,
      sourceA,
      true
    );
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json()).toMatchObject({
      permission: "write",
      csrf_bootstrap_required: true
    });
    const cookie = requireSingleHeader(claim.headers["set-cookie"]);
    expect(cookie).toContain(`${hostDeckDeviceCookieName}=${rawDeviceToken}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toMatch(/Domain=/iu);

    const protectedRead = await harness.app.inject({
      headers: remoteHeaders(sourceA, {
        cookie: rawDeviceToken,
        identity: true
      }),
      method: "GET",
      url: "/protected"
    });
    expect(protectedRead.statusCode, protectedRead.body).toBe(200);
    expect(protectedRead.json()).toMatchObject({
      state: "paired_device",
      network_mode: "remote",
      permission: "write",
      transport: "https"
    });
    expect(protectedRead.body).not.toMatch(
      /source_key|remote_generation|tailnet_identity/iu
    );

    const expectedSourceKey = deriveSourceKey(sourceA);
    expect(
      harness.db
        .prepare(
          "SELECT source_key, attempt_count FROM pairing_claim_rate_sources ORDER BY source_key"
        )
        .all()
    ).toEqual([{ source_key: expectedSourceKey, attempt_count: 1 }]);
    expect(
      harness.db
        .prepare(
          "SELECT id, attempt_count FROM pairing_claim_rate_global ORDER BY id"
        )
        .all()
    ).toEqual([{ id: "pair_claim_global", attempt_count: 1 }]);

    const auditRows = harness.db
      .prepare("SELECT * FROM selected_audit_events ORDER BY operation_id, phase")
      .all();
    const serializedAudit = JSON.stringify(auditRows);
    expect(serializedAudit).toContain(externalOrigin);
    expect(serializedAudit).not.toContain(expectedSourceKey);
    expect(serializedAudit).not.toContain(sourceA);
    expect(serializedAudit).not.toContain(identityLogin);
    expect(serializedAudit).not.toContain(rawDeviceToken);
    expect(serializedAudit).not.toContain(rawCsrfToken);

    assertSecretsAbsentFromSqlite(harness.dbPath, [
      sourceA,
      identityLogin,
      rawPairingCode,
      rawDeviceToken,
      rawCsrfToken
    ]);
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      claim_successes: 1,
      issue_successes: 1
    });
  });

  it("shares durable reconnect buckets, separates changed sources, and preserves the global cap", async () => {
    const harness = createHarness({
      budget: resolveResourceBudget({
        pair_claim_max_attempts_per_source: 2,
        pair_claim_max_attempts_global: 3
      })
    });
    await harness.app.ready();

    const first = await injectClaim(
      harness.app,
      "op_remote_rate_01",
      "Z".repeat(22),
      sourceA
    );
    const second = await injectClaim(
      harness.app,
      "op_remote_rate_02",
      "Y".repeat(22),
      sourceA,
      true
    );
    const sourceLimited = await injectClaim(
      harness.app,
      "op_remote_rate_03",
      "X".repeat(22),
      sourceA
    );
    const changedSource = await injectClaim(
      harness.app,
      "op_remote_rate_04",
      "W".repeat(22),
      sourceB
    );
    const globallyLimited = await injectClaim(
      harness.app,
      "op_remote_rate_05",
      "V".repeat(22),
      sourceB
    );

    expect([first.statusCode, second.statusCode, changedSource.statusCode]).toEqual([
      401,
      401,
      401
    ]);
    expect(sourceLimited.statusCode).toBe(429);
    expect(sourceLimited.json()).toMatchObject({
      error: { code: "rate_limited", retryable: true }
    });
    expect(globallyLimited.statusCode).toBe(429);
    expect(globallyLimited.json()).toMatchObject({
      error: { code: "rate_limited", retryable: true }
    });
    expect(
      harness.db
        .prepare(
          "SELECT source_key, attempt_count FROM pairing_claim_rate_sources ORDER BY source_key"
        )
        .all()
    ).toEqual(
      [
        { source_key: deriveSourceKey(sourceA), attempt_count: 2 },
        { source_key: deriveSourceKey(sourceB), attempt_count: 1 }
      ].sort((left, right) => left.source_key.localeCompare(right.source_key))
    );
    expect(
      harness.db
        .prepare("SELECT attempt_count FROM pairing_claim_rate_global")
        .get()
    ).toEqual({ attempt_count: 3 });
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0
    });
  });

  it("enforces per-source and global in-flight limits with exact release", async () => {
    const sameSource = createHarness({ deferFirstClaim: true });
    await sameSource.app.ready();
    const firstCode = await issueCode(
      sameSource.app,
      "op_remote_overlap_issue_01",
      "write"
    );
    const secondCode = await issueCode(
      sameSource.app,
      "op_remote_overlap_issue_02",
      "write"
    );
    const firstPromise = injectClaim(
      sameSource.app,
      "op_remote_overlap_claim_01",
      firstCode.code,
      sourceA
    );
    await sameSource.claimStarted;
    const rejectedSameSource = await injectClaim(
      sameSource.app,
      "op_remote_overlap_claim_02",
      secondCode.code,
      sourceA
    );
    sameSource.releaseClaim();
    const acceptedSameSource = await firstPromise;
    expect(acceptedSameSource.statusCode, acceptedSameSource.body).toBe(200);
    expect(rejectedSameSource.statusCode).toBe(503);
    expect(rejectedSameSource.json()).toMatchObject({
      error: { code: "service_overloaded", retryable: true }
    });
    expect(hostDeckPairingPolicySnapshot(sameSource.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      source_admission_rejections: 1
    });

    const global = createHarness({
      budget: resolveResourceBudget({ pair_claim_max_in_flight: 1 }),
      deferFirstClaim: true
    });
    await global.app.ready();
    const globalFirstCode = await issueCode(
      global.app,
      "op_remote_global_issue_01",
      "read"
    );
    const globalSecondCode = await issueCode(
      global.app,
      "op_remote_global_issue_02",
      "read"
    );
    const globalFirstPromise = injectClaim(
      global.app,
      "op_remote_global_claim_01",
      globalFirstCode.code,
      sourceA
    );
    await global.claimStarted;
    const rejectedGlobal = await injectClaim(
      global.app,
      "op_remote_global_claim_02",
      globalSecondCode.code,
      sourceB
    );
    global.releaseClaim();
    const acceptedGlobal = await globalFirstPromise;
    expect(acceptedGlobal.statusCode, acceptedGlobal.body).toBe(200);
    expect(rejectedGlobal.statusCode).toBe(503);
    expect(hostDeckPairingPolicySnapshot(global.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      global_admission_rejections: 1,
      source_admission_rejections: 0
    });
  });

  it("does not claim when generation changes after accepted audit but before durable transition", async () => {
    const harness = createHarness({ changeAfterPairAccepted: true });
    await harness.app.ready();
    const issued = await issueCode(
      harness.app,
      "op_remote_stale_issue_01",
      "write"
    );

    const response = await injectClaim(
      harness.app,
      "op_remote_stale_claim_01",
      issued.code,
      sourceA
    );
    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.connection).toBe("close");
    expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    expect(response.body).not.toContain(rawDeviceToken);
    expect(harness.claimCalls()).toBe(0);
    expect(harness.pairing.require(issued.pairing_id)).toMatchObject({
      used_at: null,
      claimed_device_id: null
    });
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()
    ).toEqual({ count: 0 });
    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources")
        .get()
    ).toEqual({ count: 0 });
    expect(
      harness.audit.require("op_remote_stale_claim_01").records.at(-1)
    ).toMatchObject({ phase: "terminal", outcome: "incomplete" });
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      claim_successes: 0
    });
  });

  it("keeps a committed claim truthful but withholds its credential after generation changes", async () => {
    const harness = createHarness({ changeAfterStoredClaim: true });
    await harness.app.ready();
    const issued = await issueCode(
      harness.app,
      "op_remote_commit_issue_01",
      "write"
    );

    const response = await injectClaim(
      harness.app,
      "op_remote_commit_claim_01",
      issued.code,
      sourceA
    );
    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.connection).toBe("close");
    expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    expect(response.body).not.toContain(rawDeviceToken);
    expect(harness.claimCalls()).toBe(1);
    expect(harness.pairing.require(issued.pairing_id)).toMatchObject({
      used_at: baseTime.toISOString(),
      claimed_device_id: "client_ABCDEFGHIJKLMNOPQRSTUVWX"
    });
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()
    ).toEqual({ count: 1 });
    expect(
      harness.audit.require("op_remote_commit_claim_01").records.at(-1)
    ).toMatchObject({
      phase: "terminal",
      outcome: "succeeded",
      payload_summary: { device_created: true }
    });
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      claim_successes: 1
    });
    expect(hostDeckRequestAuthenticationSnapshot(harness.app).ingress_rejections).toBe(
      1
    );
    expect(
      tailscaleServeProxyTrustSnapshot(harness.app).stale_remote_context_rejections
    ).toBe(1);
  });

  it("revalidates immediately before cookie attachment", async () => {
    const harness = createHarness({ changeBeforeCookieOnSend: true });
    await harness.app.ready();
    const issued = await issueCode(
      harness.app,
      "op_remote_cookie_issue_01",
      "write"
    );

    const response = await injectClaim(
      harness.app,
      "op_remote_cookie_claim_01",
      issued.code,
      sourceA
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.connection).toBe("close");
    expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    expect(response.body).not.toContain(rawDeviceToken);
    expect(
      harness.audit.require("op_remote_cookie_claim_01").records.at(-1)
    ).toMatchObject({ phase: "terminal", outcome: "succeeded" });
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      claim_successes: 1
    });
  });

  it("fails closed and releases limiter state when claim storage is unavailable", async () => {
    const harness = createHarness({ failClaim: true });
    await harness.app.ready();
    const issued = await issueCode(
      harness.app,
      "op_remote_storage_issue_01",
      "write"
    );
    const response = await injectClaim(
      harness.app,
      "op_remote_storage_claim_01",
      issued.code,
      sourceA
    );
    expect(response.statusCode).toBe(500);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain("private claim storage failure");
    expect(harness.pairing.require(issued.pairing_id)).toMatchObject({
      used_at: null,
      claimed_device_id: null
    });
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()
    ).toEqual({ count: 0 });
    expect(hostDeckPairingPolicySnapshot(harness.policy)).toMatchObject({
      active_claims: 0,
      active_sources: 0,
      claim_failures: 1,
      storage_failures: 1
    });
  });
});

interface HarnessOptions {
  readonly budget?: typeof defaultResourceBudget;
  readonly changeAfterPairAccepted?: boolean;
  readonly changeAfterStoredClaim?: boolean;
  readonly changeBeforeCookieOnSend?: boolean;
  readonly deferFirstClaim?: boolean;
  readonly failClaim?: boolean;
}

interface Harness {
  readonly admissionReads: () => number;
  readonly app: HostDeckFastifyInstance;
  readonly audit: SelectedAuditRepository;
  readonly claimCalls: () => number;
  readonly claimStarted: Promise<void>;
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly dbPath: string;
  readonly pairing: ReturnType<typeof createPairingCodeRepository>;
  readonly policy: HostDeckPairingPolicy;
  readonly releaseClaim: () => void;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-remote-pairing-"));
  tempDirectories.push(directory);
  const dbPath = join(directory, "hostdeck.sqlite");
  const opened = openMigratedDatabase(dbPath, { now: () => new Date(baseTime) });
  openDatabases.push(opened.db);
  const budget = options.budget ?? defaultResourceBudget;
  let admission: TailscaleServeRemoteAdmissionSnapshot = openAdmission(7);
  let admissionReadCount = 0;
  let claimCallCount = 0;

  const pairingCodes = [
    rawPairingCode,
    "bcdefghijklmnopqrstuvw",
    "cdefghijklmnopqrstuvwx",
    "defghijklmnopqrstuvwxy"
  ] as const;
  const pairingIds = [
    "pair_ABCDEFGHIJKLMNOPQRSTUVWX",
    "pair_ZYXWVUTSRQPONMLKJIHGFEDC",
    "pair_BCDEFGHIJKLMNOPQRSTUVWXY",
    "pair_CDEFGHIJKLMNOPQRSTUVWXYZ"
  ] as const;
  const deviceIds = [
    "client_ABCDEFGHIJKLMNOPQRSTUVWX",
    "client_ZYXWVUTSRQPONMLKJIHGFEDC",
    "client_BCDEFGHIJKLMNOPQRSTUVWXY"
  ] as const;
  const deviceTokens = [rawDeviceToken, "E".repeat(43), "F".repeat(43)] as const;
  const csrfTokens = [rawCsrfToken, "G".repeat(43), "H".repeat(43)] as const;
  let pairingCodeIndex = 0;
  let deviceIdIndex = 0;
  let deviceTokenIndex = 0;
  let csrfTokenIndex = 0;
  const pairing = createPairingCodeRepository(opened.db, {
    policy: budget,
    generatePairingCode: () => pairingCodes[pairingCodeIndex++] ?? "z".repeat(22),
    generateDeviceId: () =>
      deviceIds[deviceIdIndex++] ?? `client_fixture_${String(deviceIdIndex).padStart(2, "0")}`,
    generateDeviceToken: () => deviceTokens[deviceTokenIndex++] ?? "I".repeat(43),
    generateCsrfToken: () => csrfTokens[csrfTokenIndex++] ?? "J".repeat(43)
  });

  let markClaimStarted: () => void = () => undefined;
  const claimStarted = new Promise<void>((resolve) => {
    markClaimStarted = resolve;
  });
  let releaseClaim: () => void = () => undefined;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  let deferred = false;
  const claim = (input: Parameters<typeof pairing.claim>[0]) => {
    claimCallCount += 1;
    if (options.failClaim) throw new Error("private claim storage failure");
    const result = pairing.claim(input);
    if (options.changeAfterStoredClaim) admission = openAdmission(8);
    if (!options.deferFirstClaim || deferred) return result;
    deferred = true;
    markClaimStarted();
    return claimGate.then(() => result);
  };
  if (!options.deferFirstClaim) markClaimStarted();

  const auth = createAuthDeviceRepository(opened.db);
  const audit = createSelectedAuditRepository(opened.db);
  const auditPort = options.changeAfterPairAccepted
    ? repositoryWith(audit, {
        recordAccepted(record) {
          const result = audit.recordAccepted(record);
          if ((record as { readonly action?: unknown }).action === "pair_claim") {
            admission = openAdmission(8);
          }
          return result;
        }
      })
    : audit;
  const executor = createAuditExecutor(auditPort);
  let pairingIdIndex = 0;
  const policy = createHostDeckPairingPolicy({
    pairing: {
      issue: (input) => pairing.issue(input),
      claim
    },
    now: () => new Date(baseTime),
    createPairingId: () =>
      pairingIds[pairingIdIndex++] ??
      `pair_fixture_${String(pairingIdIndex).padStart(2, "0")}`
  });
  const pairingRegistration = createHostDeckPairingRouteRegistration({
    audit: executor,
    pairing: policy
  });
  const csrfRepository = createSelectedCsrfAuthorizationRepository(opened.db, {
    generateCsrfToken: () => rotatedCsrfToken
  });
  const csrfPolicy = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) =>
        csrfRepository.authorizeBrowserWrite(input),
      rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
    },
    now: () => new Date(baseTime.getTime() + 1_000)
  });
  const remoteRequestAuthority =
    createHostDeckRemoteIngressRequestAuthorityPolicy();
  const app = createHostDeckTailscaleServeFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
      now: () => new Date(baseTime.getTime() + 1_000)
    }),
    resourceBudget: budget,
    routePlugins: [
      pairingRegistration,
      createHostDeckCsrfRouteRegistration({ audit: executor, csrf: csrfPolicy }),
      protectedRoute()
    ],
    remoteIngressRequestAuthority: remoteRequestAuthority,
    tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
      localOrigin,
      readRemoteAdmission() {
        admissionReadCount += 1;
        return remoteRequestAuthority.synchronize(admission);
      }
    })
  });
  if (options.changeBeforeCookieOnSend) {
    let changed = false;
    app.addHook("onSend", async (request, reply, payload) => {
      if (
        !changed &&
        request.url === "/api/v1/access/pairing-claims" &&
        reply.statusCode >= 200 &&
        reply.statusCode < 300
      ) {
        changed = true;
        admission = openAdmission(8);
      }
      return payload;
    });
  }
  openApps.push(app);
  return {
    admissionReads: () => admissionReadCount,
    app,
    audit,
    claimCalls: () => claimCallCount,
    claimStarted,
    db: opened.db,
    dbPath,
    pairing,
    policy,
    releaseClaim
  };
}

function protectedRoute(): HostDeckRoutePluginRegistration {
  return {
    id: "remote-pairing-protected-fixture",
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

function createAuditExecutor(
  repository: SelectedAuditRepository
): SecurityMutationAuditExecutor {
  let clockIndex = 0;
  let recordIndex = 0;
  return createSecurityMutationAuditExecutor({
    repository,
    now: () =>
      new Date(baseTime.getTime() + clockIndex++ * 1_000).toISOString(),
    create_record_id: () => `audit:remote:pair:${recordIndex++}`
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

async function issueCode(
  app: HostDeckFastifyInstance,
  operationId: string,
  permission: "read" | "write"
): Promise<{ readonly code: string; readonly pairing_id: string }> {
  const response = await app.inject({
    headers: {
      host: new URL(localOrigin).host,
      "content-type": "application/json"
    },
    method: "POST",
    payload: {
      operation_id: operationId,
      permission,
      client_label: "Android phone"
    },
    url: "/api/v1/access/pairing-codes"
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

function injectClaim(
  app: HostDeckFastifyInstance,
  operationId: string,
  code: string,
  source: string,
  identity = false
) {
  return app.inject({
    headers: remoteHeaders(source, {
      contentType: true,
      identity,
      origin: true
    }),
    method: "POST",
    payload: { operation_id: operationId, code },
    url: "/api/v1/access/pairing-claims"
  });
}

function remoteHeaders(
  source: string,
  options: {
    readonly contentType?: boolean;
    readonly cookie?: string;
    readonly identity?: boolean;
    readonly origin?: boolean;
  } = {}
): Record<string, string> {
  const authority = new URL(externalOrigin).host;
  const headers: Record<string, string> = {
    host: authority,
    "x-forwarded-for": source,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (options.contentType) headers["content-type"] = "application/json";
  if (options.cookie !== undefined) {
    headers.cookie = `${hostDeckDeviceCookieName}=${options.cookie}`;
  }
  if (options.origin) headers.origin = externalOrigin;
  if (options.identity) {
    headers["tailscale-headers-info"] = "https://tailscale.com/s/serve-headers";
    headers["tailscale-user-login"] = identityLogin;
    headers["tailscale-user-name"] = "Private Fixture";
    headers["tailscale-user-profile-pic"] = "https://example.test/private-avatar";
  }
  return headers;
}

function openAdmission(generation: number): TailscaleServeRemoteAdmissionSnapshot {
  return Object.freeze({
    admission: "open",
    external_origin: externalOrigin,
    generation
  });
}

function deriveSourceKey(source: string): string {
  return `sha256:${createHash("sha256")
    .update(`hostdeck:tailscale-serve-source:v1\0ipv4\0${source}`, "ascii")
    .digest("hex")}`;
}

function requireSingleHeader(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new TypeError("Expected one response header.");
  return value;
}

function browserResponse(
  status: number,
  headers: Readonly<Record<string, number | string | string[] | undefined>>,
  body: string
): BrowserPairingResponsePort {
  const encoded = new TextEncoder().encode(body);
  let read = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const value = headers[name.toLowerCase()];
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);
        if (name.toLowerCase() === "content-length") {
          return String(encoded.byteLength);
        }
        return null;
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true };
            read = true;
            return { done: false, value: encoded };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function assertSecretsAbsentFromSqlite(
  dbPath: string,
  secrets: readonly string[]
): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const secret of secrets) {
      expect(
        bytes.includes(Buffer.from(secret, "utf8")),
        `${path} contains ${secret.length}-byte private input`
      ).toBe(false);
    }
  }
}
