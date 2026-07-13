import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clientOperationIdSchema,
  defaultResourceBudget,
  type ResourceBudget,
  type SelectedRequestAuthenticationContext,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createDeviceListingRepository,
  createDeviceRevocationRepository,
  createHostDeckLanConfigurationRepository,
  createPairingCodeRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  requireHostDeckRequestCsrfWriteAuthorization
} from "./csrf-routes.js";
import { createHostDeckDeviceListRouteRegistration } from "./device-list-routes.js";
import {
  createHostDeckDeviceRevokeRouteRegistration,
  hostDeckDeviceRevokeRouteSnapshot
} from "./device-revoke-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { createHostDeckSseTransportRegistration } from "./fastify-sse-transport.js";
import {
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  hostDeckHostLockPolicySnapshot,
  requireHostDeckHostUnlocked
} from "./host-lock-routes.js";
import {
  createHostDeckLanCertificatePolicy,
  type HostDeckLanEnrollment
} from "./lan-certificate-policy.js";
import { createHostDeckLanNetworkRouteRegistration } from "./lan-network-routes.js";
import { createHostDeckLanNetworkService } from "./lan-network-service.js";
import {
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  hostDeckPairingPolicySnapshot
} from "./pairing-routes.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";

const sentinelReadPath = "/__acceptance/v1/read";
const sentinelWritePath = "/__acceptance/v1/write";
const sentinelSsePath = "/__acceptance/v1/events";
export const securityAcceptanceDriverPath = "/__acceptance/v1/driver";

const sentinelReadResponseSchema = z
  .object({ protected_marker: z.literal("hostdeck-protected-acceptance-marker") })
  .strict();
const sentinelWriteRequestSchema = z
  .object({ operation_id: clientOperationIdSchema })
  .strict();
const sentinelWriteResponseSchema = z
  .object({ dispatch_count: z.number().int().positive() })
  .strict();
const noQuerySchema = z.object({}).strict();
const phoneDriverQuerySchema = z
  .object({
    run: z
      .string()
      .regex(/^(?:[0-9a-f]{12}|return|trust-removed)-[0-9]{13}$/u)
      .optional()
  })
  .strict();

export interface SecurityAcceptanceClock {
  readonly advance: (milliseconds: number) => void;
  readonly now: () => Date;
  readonly peek: () => Date;
}

export interface SecurityAcceptanceSeedDevice {
  readonly clientLabel: string;
  readonly expiresAt?: Date | null;
  readonly id: string;
  readonly permission: "read" | "write";
  readonly rawCsrfToken: string;
  readonly rawDeviceToken: string;
}

export interface CreateSecurityAcceptanceHarnessInput {
  readonly bindHost: string;
  readonly bindPort: number;
  readonly initialNow: Date;
  readonly holdFirstClaim?: boolean;
  readonly holdFirstSseOpen?: boolean;
  readonly rootDirectory: string;
  readonly resourceBudget?: ResourceBudget;
  readonly seedDevices?: readonly SecurityAcceptanceSeedDevice[];
  readonly startListener?: boolean;
}

export interface SecurityAcceptanceRuntimeSnapshot {
  readonly aborted_sse_opens: number;
  readonly active_authority_leases: number;
  readonly active_sse_sources: number;
  readonly closed_sse_sources: number;
  readonly cookie_response_observations: number;
  readonly deletion_cookie_metadata_observed: boolean;
  readonly device_revoke_attempts: number;
  readonly lock_gate_rejections: number;
  readonly pairing_claim_successes: number;
  readonly pairing_cookie_metadata_observed: boolean;
  readonly sentinel_write_dispatches: number;
}

export interface SecurityAcceptancePrivacySnapshot {
  readonly files_checked: number;
  readonly leaks_found: number;
  readonly secrets_checked: number;
}

export interface SecurityAcceptanceHarness {
  readonly app: HostDeckFastifyInstance;
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly auth: ReturnType<typeof createAuthDeviceRepository>;
  readonly baseUrl: string;
  readonly bindHost: string;
  readonly bindPort: number;
  readonly certificates: ReturnType<typeof createHostDeckLanCertificatePolicy>;
  readonly clock: SecurityAcceptanceClock;
  readonly databasePath: string;
  readonly driverUrl: string;
  readonly enrollment: HostDeckLanEnrollment;
  readonly internalErrors: readonly unknown[];
  readonly origin: string;
  readonly pairing: ReturnType<typeof createPairingCodeRepository>;
  readonly claimStarted: Promise<void>;
  readonly sseOpenStarted: Promise<void>;
  readonly rootDirectory: string;
  readonly settings: ReturnType<typeof createSettingsRepository>;
  readonly close: () => Promise<void>;
  readonly releaseHeldClaim: () => void;
  readonly releaseHeldSseOpen: () => void;
  readonly scanPrivacy: () => SecurityAcceptancePrivacySnapshot;
  readonly snapshot: () => SecurityAcceptanceRuntimeSnapshot;
}

export async function createSecurityAcceptanceHarness(
  input: CreateSecurityAcceptanceHarnessInput
): Promise<SecurityAcceptanceHarness> {
  assertHarnessInput(input);
  const clock = createSecurityAcceptanceClock(input.initialNow);
  const resourceBudget = input.resourceBudget ?? defaultResourceBudget;
  const databasePath = join(input.rootDirectory, "hostdeck-security-acceptance.sqlite");
  const certificateDirectory = join(input.rootDirectory, "certificates");
  const stateDirectory = join(input.rootDirectory, "state");
  mkdirSync(certificateDirectory, { mode: 0o700 });
  mkdirSync(stateDirectory, { mode: 0o700 });

  const opened = openMigratedDatabase(databasePath, { now: clock.now });
  opened.db.pragma("busy_timeout = 2000");
  const settings = createSettingsRepository(opened.db);
  settings.getOrCreateDefault({
    bindPort: input.bindPort,
    now: clock.now,
    stateDir: stateDirectory
  });
  const audit = createSelectedAuditRepository(opened.db);
  let auditIndex = 0;
  const auditExecutor = createSecurityMutationAuditExecutor({
    repository: audit,
    now: () => clock.now().toISOString(),
    create_record_id: () => `audit:security-acceptance:${++auditIndex}`
  });
  const certificates = createHostDeckLanCertificatePolicy({
    assignedAddresses: () => [input.bindHost],
    certificateDirectory,
    now: clock.now
  });
  const network = createHostDeckLanConfigurationRepository(opened.db);
  const networkService = createHostDeckLanNetworkService({
    audit: auditExecutor,
    certificates,
    network,
    now: clock.now
  });
  const loopbackAdmin = localAdminContext({
    configuredOrigin: `http://127.0.0.1:${input.bindPort}`,
    networkMode: "loopback",
    transport: "http"
  });
  await networkService.configure(loopbackAdmin, {
    operation_id: clientOperationIdSchema.parse("op_acceptance_lan_configure_0001"),
    confirmed: true,
    bind_host: input.bindHost,
    bind_port: input.bindPort,
    certificate_action: "issue_leaf"
  });
  await networkService.enable(loopbackAdmin, {
    operation_id: clientOperationIdSchema.parse("op_acceptance_lan_enable_0001"),
    confirmed: true
  });

  const auth = createAuthDeviceRepository(opened.db);
  const transientSecrets = new Set<string>();
  for (const device of input.seedDevices ?? []) {
    transientSecrets.add(device.rawCsrfToken);
    transientSecrets.add(device.rawDeviceToken);
    auth.create({
      clientLabel: device.clientLabel,
      createdAt: clock.now(),
      ...(device.expiresAt === undefined ? {} : { expiresAt: device.expiresAt }),
      id: device.id,
      permission: device.permission,
      rawCsrfToken: device.rawCsrfToken,
      rawDeviceToken: device.rawDeviceToken
    });
  }
  const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: (candidate) => {
      transientSecrets.add(candidate.rawDeviceToken);
      return auth.authenticateDeviceToken(candidate);
    },
    now: clock.now
  });
  const pairing = createPairingCodeRepository(opened.db, {
    policy: resourceBudget
  });
  let claimHeld = false;
  let markClaimStarted: () => void = () => undefined;
  const claimStarted = new Promise<void>((resolve) => {
    markClaimStarted = resolve;
  });
  let releaseClaim: () => void = () => undefined;
  const claimRelease = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  if (input.holdFirstClaim !== true) markClaimStarted();
  const pairingPolicy = createHostDeckPairingPolicy({
    pairing: {
      claim: (candidate) => {
        transientSecrets.add(candidate.rawCode);
        const result = pairing.claim(candidate);
        transientSecrets.add(result.rawCsrfToken);
        transientSecrets.add(result.rawDeviceToken);
        if (input.holdFirstClaim !== true || claimHeld) return result;
        claimHeld = true;
        markClaimStarted();
        return claimRelease.then(() => result);
      },
      issue: (candidate) => {
        const result = pairing.issue(candidate);
        transientSecrets.add(result.rawCode);
        return result;
      }
    },
    now: clock.now
  });
  const csrfRepository = createSelectedCsrfAuthorizationRepository(opened.db);
  const csrfPolicy = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (candidate) =>
        csrfRepository.authorizeBrowserWrite(candidate),
      rotateBootstrap: (candidate) => {
        const result = csrfRepository.rotateBootstrap(candidate);
        transientSecrets.add(result.rawCsrfToken);
        return result;
      }
    },
    now: clock.now
  });
  const lockPolicy = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings.require(),
      transition: (candidate) => settings.transitionHostLock(candidate)
    },
    now: clock.now
  });
  const deviceListing = createDeviceListingRepository(opened.db);
  const deviceRevocation = createDeviceRevocationRepository(opened.db);
  const revokeRegistration = createHostDeckDeviceRevokeRouteRegistration({
    activeDeviceAuthority: authenticationPolicy.activeDeviceAuthority,
    audit: auditExecutor,
    csrf: csrfPolicy,
    devices: { revoke: (candidate) => deviceRevocation.revoke(candidate) },
    lock: lockPolicy,
    now: clock.now
  });
  let markSseOpenStarted: () => void = () => undefined;
  const sseOpenStarted = new Promise<void>((resolve) => {
    markSseOpenStarted = resolve;
  });
  let releaseSseOpen: () => void = () => undefined;
  const sseOpenRelease = new Promise<void>((resolve) => {
    releaseSseOpen = resolve;
  });
  if (input.holdFirstSseOpen !== true) markSseOpenStarted();
  const sentinelRuntime = {
    activeSseSources: 0,
    abortedSseOpens: 0,
    closedSseSources: 0,
    cookieResponseObservations: 0,
    heldSseOpenUsed: false,
    openingSseSources: 0,
    pairingCookieMetadataObserved: false,
    deletionCookieMetadataObserved: false,
    writeDispatches: 0
  };
  const origin = `https://${input.bindHost}:${input.bindPort}`;
  const routePlugins: HostDeckRoutePluginRegistration[] = [
    createHostDeckPairingRouteRegistration({
      audit: auditExecutor,
      pairing: pairingPolicy
    }),
    createHostDeckCsrfRouteRegistration({
      audit: auditExecutor,
      csrf: csrfPolicy
    }),
    createHostDeckHostLockRouteRegistration({
      audit: auditExecutor,
      csrf: csrfPolicy,
      lock: lockPolicy
    }),
    createHostDeckDeviceListRouteRegistration({
      devices: { list: (candidate) => deviceListing.list(candidate) }
    }),
    revokeRegistration,
    createHostDeckLanNetworkRouteRegistration({ service: networkService }),
    createSentinelRouteRegistration({
      csrfPolicy,
      lockPolicy,
      runtime: sentinelRuntime
    }),
    createSentinelSseRegistration({
      holdFirstOpen: input.holdFirstSseOpen === true,
      markOpenStarted: markSseOpenStarted,
      openRelease: sseOpenRelease,
      runtime: sentinelRuntime
    }),
    createPhoneDriverRegistration()
  ];
  const internalErrors: unknown[] = [];
  const app = createHostDeckFastifyApp({
    observeInternalError: (observation) => internalErrors.push(observation),
    requestAuthenticationPolicy: authenticationPolicy,
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigins: [origin],
      mode: "lan",
      transport: "https"
    }),
    resourceBudget,
    routePlugins,
    tls: certificates.loadTls({
      bind_host: input.bindHost,
      bind_port: input.bindPort
    })
  });
  app.server.prependListener("request", (request, response) => {
    const writeHead = response.writeHead;
    response.writeHead = function observeAcceptanceCookieHeader(
      this: typeof response,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(writeHead, this, args);
      const setCookie =
        response.getHeader("set-cookie") ?? setCookieFromWriteHeadArguments(args);
      observeAcceptanceCookieMetadata(
        request.url,
        response.statusCode,
        setCookie,
        sentinelRuntime
      );
      return result;
    } as typeof response.writeHead;
  });
  await app.ready();
  if (input.startListener !== false) {
    await app.listen({
      host: input.bindHost,
      port: input.bindPort,
      listenTextResolver: () => ""
    });
  }
  const enrollment = certificates.enrollment({
    bind_host: input.bindHost,
    bind_port: input.bindPort
  });
  let closed = false;
  return Object.freeze({
    app,
    audit,
    auth,
    baseUrl: origin,
    bindHost: input.bindHost,
    bindPort: input.bindPort,
    certificates,
    claimStarted,
    clock,
    databasePath,
    driverUrl: `${origin}${securityAcceptanceDriverPath}`,
    enrollment,
    internalErrors,
    origin,
    pairing,
    releaseHeldClaim: releaseClaim,
    releaseHeldSseOpen: releaseSseOpen,
    rootDirectory: input.rootDirectory,
    settings,
    sseOpenStarted,
    async close() {
      if (closed) return;
      closed = true;
      releaseClaim();
      releaseSseOpen();
      await app.close();
      if (opened.db.open) opened.db.close();
      transientSecrets.clear();
    },
    scanPrivacy() {
      return scanAcceptancePrivacy(databasePath, internalErrors, transientSecrets);
    },
    snapshot() {
      const authority = authenticationPolicy.activeDeviceAuthority.snapshot();
      const lock = hostDeckHostLockPolicySnapshot(lockPolicy);
      const pairingSnapshot = hostDeckPairingPolicySnapshot(pairingPolicy);
      const revoke = hostDeckDeviceRevokeRouteSnapshot(revokeRegistration);
      return Object.freeze({
        aborted_sse_opens: sentinelRuntime.abortedSseOpens,
        active_authority_leases: authority.active_leases,
        active_sse_sources: sentinelRuntime.activeSseSources,
        closed_sse_sources: sentinelRuntime.closedSseSources,
        cookie_response_observations: sentinelRuntime.cookieResponseObservations,
        deletion_cookie_metadata_observed:
          sentinelRuntime.deletionCookieMetadataObserved,
        device_revoke_attempts: revoke.attempts,
        lock_gate_rejections: lock.gate_rejections,
        pairing_claim_successes: pairingSnapshot.claim_successes,
        pairing_cookie_metadata_observed:
          sentinelRuntime.pairingCookieMetadataObserved,
        sentinel_write_dispatches: sentinelRuntime.writeDispatches
      });
    }
  });
}

export function createSecurityAcceptanceClock(initialNow: Date): SecurityAcceptanceClock {
  let epochMilliseconds = initialNow.getTime();
  if (!Number.isFinite(epochMilliseconds)) {
    throw new TypeError("Security acceptance clock requires a valid initial time.");
  }
  return Object.freeze({
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new TypeError("Security acceptance clock advance is invalid.");
      }
      epochMilliseconds += milliseconds;
      if (!Number.isSafeInteger(epochMilliseconds)) {
        throw new TypeError("Security acceptance clock exceeded its supported range.");
      }
    },
    now() {
      const value = new Date(epochMilliseconds);
      epochMilliseconds += 1;
      return value;
    },
    peek() {
      return new Date(epochMilliseconds);
    }
  });
}

function createSentinelRouteRegistration(input: {
  readonly csrfPolicy: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lockPolicy: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly runtime: { writeDispatches: number };
}): HostDeckRoutePluginRegistration {
  return Object.freeze({
    id: "security-acceptance-sentinel",
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      app.get(
        sentinelReadPath,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async onRequest(request: FastifyRequest) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            querystring: noQuerySchema,
            response: { 200: sentinelReadResponseSchema }
          }
        },
        async () => ({
          protected_marker: "hostdeck-protected-acceptance-marker" as const
        })
      );
      app.post(
        sentinelWritePath,
        {
          config: hostDeckNoStoreRouteConfig,
          schema: {
            body: sentinelWriteRequestSchema,
            querystring: noQuerySchema,
            response: { 200: sentinelWriteResponseSchema }
          }
        },
        async (request: FastifyRequest) => {
          requireHostDeckRequestCsrfWriteAuthorization(
            request,
            "device_cookie",
            input.csrfPolicy
          );
          requireHostDeckHostUnlocked(input.lockPolicy);
          input.runtime.writeDispatches += 1;
          return { dispatch_count: input.runtime.writeDispatches };
        }
      );
    }
  });
}

function createSentinelSseRegistration(input: {
  readonly holdFirstOpen: boolean;
  readonly markOpenStarted: () => void;
  readonly openRelease: Promise<void>;
  readonly runtime: {
    activeSseSources: number;
    abortedSseOpens: number;
    closedSseSources: number;
    heldSseOpenUsed: boolean;
    openingSseSources: number;
  };
}): HostDeckRoutePluginRegistration {
  return createHostDeckSseTransportRegistration({
    id: "security-acceptance-sse",
    path: sentinelSsePath,
    observeError: () => undefined,
    source: {
      async open({ request, signal }) {
        requireHostDeckRequestAuthentication(request, "device_cookie");
        if (input.holdFirstOpen && !input.runtime.heldSseOpenUsed) {
          input.runtime.heldSseOpenUsed = true;
          input.runtime.openingSseSources += 1;
          input.markOpenStarted();
          await waitForReleaseOrAbort(input.openRelease, signal);
          input.runtime.openingSseSources -= 1;
          if (signal.aborted) {
            input.runtime.abortedSseOpens += 1;
            throw new Error("Security acceptance SSE authority closed while opening.");
          }
        }
        input.runtime.activeSseSources += 1;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          input.runtime.activeSseSources -= 1;
          input.runtime.closedSseSources += 1;
        };
        const iterator = sentinelEventIterator(signal, close);
        return Object.freeze({ [Symbol.asyncIterator]: () => iterator });
      }
    }
  });
}

function waitForReleaseOrAbort(
  release: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void release.then(finish);
  });
}

function observeAcceptanceCookieMetadata(
  url: string | undefined,
  statusCode: number,
  setCookie: string | number | readonly string[] | undefined,
  runtime: {
    cookieResponseObservations: number;
    deletionCookieMetadataObserved: boolean;
    pairingCookieMetadataObserved: boolean;
  }
): void {
  if (statusCode < 200 || statusCode >= 300) return;
  if (url === "/api/v1/access/pairing-claims") {
    runtime.cookieResponseObservations += 1;
    runtime.pairingCookieMetadataObserved = hasExactDeviceCookieMetadata(
      setCookie,
      false
    );
  }
  if (
    url?.startsWith("/api/v1/access/devices/") === true &&
    url.endsWith("/revoke")
  ) {
    runtime.cookieResponseObservations += 1;
    runtime.deletionCookieMetadataObserved = hasExactDeviceCookieMetadata(
      setCookie,
      true
    );
  }
}

function setCookieFromWriteHeadArguments(
  args: readonly unknown[]
): string | number | readonly string[] | undefined {
  for (const candidate of args.toReversed()) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    for (const [name, value] of Object.entries(candidate)) {
      if (
        name.toLowerCase() === "set-cookie" &&
        (typeof value === "string" ||
          typeof value === "number" ||
          (Array.isArray(value) && value.every((item) => typeof item === "string")))
      ) {
        return value as string | number | readonly string[];
      }
    }
  }
  return undefined;
}

function hasExactDeviceCookieMetadata(
  candidate: string | number | readonly string[] | undefined,
  deletion: boolean
): boolean {
  const raw = Array.isArray(candidate)
    ? candidate.length === 1
      ? candidate[0]
      : undefined
    : candidate;
  if (
    typeof raw !== "string" ||
    raw.includes("\r") ||
    raw.includes("\n")
  ) {
    return false;
  }
  const segments = raw.split(";").map((segment) => segment.trim());
  const cookie = segments.shift();
  if (cookie === undefined) return false;
  const prefix = `${hostDeckDeviceCookieName}=`;
  if (!cookie.startsWith(prefix)) return false;
  const value = cookie.slice(prefix.length);
  if (deletion ? value !== "" : !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    return false;
  }
  const attributes = segments.map((segment) => segment.toLowerCase());
  const expires = attributes.filter((attribute) => attribute.startsWith("expires="));
  return (
    attributes.includes("path=/") &&
    attributes.includes("httponly") &&
    attributes.includes("secure") &&
    attributes.includes("samesite=strict") &&
    !attributes.some((attribute) => attribute.startsWith("domain=")) &&
    expires.length === 1 &&
    (deletion
      ? attributes.includes("max-age=0") &&
        expires[0] === "expires=thu, 01 jan 1970 00:00:00 gmt"
      : !attributes.some((attribute) => attribute.startsWith("max-age=")) &&
        Number.isFinite(Date.parse(expires[0]?.slice("expires=".length) ?? "")))
  );
}

function scanAcceptancePrivacy(
  databasePath: string,
  internalErrors: readonly unknown[],
  secrets: ReadonlySet<string>
): SecurityAcceptancePrivacySnapshot {
  const surfaces: Buffer[] = [];
  let filesChecked = 0;
  for (const suffix of ["", "-wal", "-shm"] as const) {
    try {
      surfaces.push(readFileSync(`${databasePath}${suffix}`));
      filesChecked += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  surfaces.push(Buffer.from(JSON.stringify(internalErrors), "utf8"));
  let leaksFound = 0;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    const bytes = Buffer.from(secret, "utf8");
    for (const surface of surfaces) {
      if (surface.includes(bytes)) leaksFound += 1;
    }
  }
  return Object.freeze({
    files_checked: filesChecked,
    leaks_found: leaksFound,
    secrets_checked: secrets.size
  });
}

function sentinelEventIterator(
  signal: AbortSignal,
  close: () => void
): AsyncIterator<unknown> {
  let emitted = false;
  let pending: (() => void) | null = null;
  const abort = () => pending?.();
  signal.addEventListener("abort", abort, { once: true });
  return {
    async next() {
      if (!emitted) {
        emitted = true;
        return {
          done: false as const,
          value: selectedProjectionEventSchema.parse({
            captured_at: "2026-07-13T12:00:00.000Z",
            codex_event_id: "security-acceptance-event-1",
            codex_event_type: "item/agentMessage/delta",
            content_notice: null,
            content_state: "complete",
            cursor: 1,
            item_id: null,
            phase: "delta",
            role: "agent",
            session_id: "sess_security_acceptance",
            text: "hostdeck-protected-acceptance-marker",
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
      signal.removeEventListener("abort", abort);
      pending?.();
      pending = null;
      close();
      return { done: true as const, value: undefined };
    }
  };
}

function createPhoneDriverRegistration(): HostDeckRoutePluginRegistration {
  const html = phoneDriverHtml();
  return Object.freeze({
    id: "security-acceptance-phone-driver",
    surface: "static" as const,
    register(app: HostDeckFastifyInstance) {
      app.get(
        securityAcceptanceDriverPath,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          schema: {
            querystring: phoneDriverQuerySchema,
            response: { 200: z.string() }
          }
        },
        async (_request: FastifyRequest, reply: FastifyReply) => {
          reply
            .type("text/html; charset=utf-8")
            .header("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
            .header("x-content-type-options", "nosniff")
            .header("referrer-policy", "no-referrer");
          return html;
        }
      );
    }
  });
}

function phoneDriverHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>HostDeck Security Acceptance</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 20px; max-width: 42rem; }
    h1 { font-size: 1.25rem; margin: 0 0 16px; }
    section { border-top: 1px solid #8886; padding: 16px 0; }
    label { display: block; font-weight: 650; margin-bottom: 6px; }
    input, button { box-sizing: border-box; font: inherit; min-height: 44px; }
    input { width: 100%; padding: 8px 10px; }
    .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    button { padding: 8px 10px; }
    output { display: block; min-height: 8rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <h1>HostDeck Security Acceptance</h1>
  <section>
    <label for="pairing-code">Pairing code</label>
    <input id="pairing-code" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false">
    <button id="pair" type="button">Pair writer</button>
  </section>
  <section class="actions">
    <button id="refresh" type="button">Refresh access</button>
    <button id="bootstrap" type="button">Bootstrap CSRF</button>
    <button id="stale" type="button">Check stale CSRF</button>
    <button id="write" type="button">Sentinel write</button>
    <button id="lock" type="button">Lock host</button>
    <button id="sse" type="button">Open SSE</button>
    <button id="self-revoke" type="button">Self revoke</button>
  </section>
  <section><output id="status" aria-live="polite"></output></section>
  <script>
    (() => {
      "use strict";
      const codeInput = document.querySelector("#pairing-code");
      const status = document.querySelector("#status");
      let csrfToken = null;
      let csrfGeneration = null;
      let deviceId = null;
      let eventSource = null;
      let operationCounter = 0;
      const operationSession = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const operationIds = [];
      const lines = [];
      const operationId = (label) => {
        operationCounter += 1;
        const value = "op_physical_" + label + "_" + operationSession + "_" + String(operationCounter).padStart(4, "0");
        operationIds.push(value);
        return value;
      };
      const report = (label, value) => {
        lines.push(label + ": " + value);
        while (lines.length > 18) lines.shift();
        status.textContent = lines.join("\n");
      };
      const request = async (method, path, body, csrfOverride) => {
        const headers = { accept: "application/json" };
        if (body !== undefined) headers["content-type"] = "application/json";
        const token = csrfOverride === undefined ? csrfToken : csrfOverride.token;
        const generation = csrfOverride === undefined ? csrfGeneration : csrfOverride.generation;
        if (token !== null && generation !== null) {
          headers["x-hostdeck-csrf"] = token;
          headers["x-hostdeck-csrf-generation"] = String(generation);
        }
        const response = await fetch(path, {
          method,
          headers,
          credentials: "include",
          cache: "no-store",
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        let value = null;
        try { value = await response.json(); } catch { value = null; }
        return { response, value };
      };
      const refresh = async () => {
        const { response, value } = await request("GET", "/api/v1/access");
        if (value && typeof value.device_id === "string") deviceId = value.device_id;
        report("access", String(response.status) + " " + (value?.authentication_state ?? "unknown"));
        return response.status;
      };
      const pair = async () => {
        const code = codeInput.value;
        codeInput.value = "";
        const { response, value } = await request("POST", "/api/v1/access/pairing-claims", {
          operation_id: operationId("pair"),
          code,
          client_label: "Physical Android Chrome"
        });
        if (response.ok && typeof value?.device_id === "string") deviceId = value.device_id;
        report("pair", response.status);
        return response.status;
      };
      const bootstrap = async () => {
        const { response, value } = await request("POST", "/api/v1/access/csrf", {
          operation_id: operationId("csrf")
        });
        if (response.ok) {
          csrfToken = value.csrf_token;
          csrfGeneration = value.csrf_generation;
        }
        report("csrf", response.status);
        return response.status;
      };
      const write = async (override) => {
        const { response } = await request("POST", "${sentinelWritePath}", {
          operation_id: operationId("write")
        }, override);
        report("write", response.status);
        return response.status;
      };
      const stale = async () => {
        const previous = { token: csrfToken, generation: csrfGeneration };
        const rotated = await bootstrap();
        if (rotated !== 200) return rotated;
        const result = await write(previous);
        report("stale-csrf", result);
        return result;
      };
      const lock = async () => {
        const { response } = await request("POST", "/api/v1/access/lock", {
          operation_id: operationId("lock"), confirmed: true
        });
        report("lock", response.status);
        return response.status;
      };
      const openSse = () => {
        eventSource?.close();
        eventSource = new EventSource("${sentinelSsePath}", { withCredentials: true });
        eventSource.onmessage = () => report("sse", "message");
        eventSource.onerror = () => report("sse", "closed");
        report("sse", "opening");
      };
      const selfRevoke = async () => {
        if (deviceId === null) await refresh();
        if (deviceId === null) { report("self-revoke", "missing-device"); return 0; }
        const { response } = await request("POST", "/api/v1/access/devices/" + encodeURIComponent(deviceId) + "/revoke", {
          operation_id: operationId("revoke"), confirmed: true
        });
        csrfToken = null;
        csrfGeneration = null;
        report("self-revoke", response.status);
        return response.status;
      };
      document.querySelector("#pair").addEventListener("click", () => void pair());
      document.querySelector("#refresh").addEventListener("click", () => void refresh());
      document.querySelector("#bootstrap").addEventListener("click", () => void bootstrap());
      document.querySelector("#stale").addEventListener("click", () => void stale());
      document.querySelector("#write").addEventListener("click", () => void write());
      document.querySelector("#lock").addEventListener("click", () => void lock());
      document.querySelector("#sse").addEventListener("click", openSse);
      document.querySelector("#self-revoke").addEventListener("click", () => void selfRevoke());
      window.__hostDeckAcceptance = Object.freeze({
        bootstrap, lock, openSse, pair, refresh, selfRevoke, stale, write,
        snapshot: () => Object.freeze({
          csrfGeneration,
          deviceId,
          operationIds: Object.freeze(operationIds.slice()),
          sseOpen: eventSource !== null
        })
      });
      void refresh();
    })();
  </script>
</body>
</html>`;
}

function localAdminContext(input: {
  readonly configuredOrigin: string;
  readonly networkMode: "lan" | "loopback";
  readonly transport: "http" | "https";
}): SelectedRequestAuthenticationContext {
  return Object.freeze({
    state: "local_admin",
    configured_origin: input.configuredOrigin,
    network_mode: input.networkMode,
    origin_kind: "local_non_browser",
    transport: input.transport,
    device_id: null,
    permission: "local_admin",
    csrf_generation: null,
    last_used_at: null,
    expires_at: null
  });
}

function assertHarnessInput(input: CreateSecurityAcceptanceHarnessInput): void {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.bindHost !== "string" ||
    !Number.isInteger(input.bindPort) ||
    input.bindPort < 1 ||
    input.bindPort > 65_535 ||
    !(input.initialNow instanceof Date) ||
    !Number.isFinite(input.initialNow.getTime()) ||
    typeof input.rootDirectory !== "string" ||
    input.rootDirectory.length === 0
  ) {
    throw new TypeError("Security acceptance harness input is invalid.");
  }
}

export function securityAcceptanceOperationId(label: string): string {
  const normalized = label.toLowerCase().replace(/[^a-z0-9_-]/gu, "_").slice(0, 40);
  return `op_${normalized}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
