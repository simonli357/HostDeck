import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clientOperationIdSchema,
  defaultResourceBudget,
  managedSessionTargetSchema
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createDeviceRevocationRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSettingsRepository,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration
} from "./csrf-routes.js";
import { createHostDeckDeviceRevokeRouteRegistration } from "./device-revoke-routes.js";
import {
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  hostDeckHostLockPolicySnapshot
} from "./host-lock-routes.js";
import {
  createSecurityMutationAuditExecutor,
  HostDeckSecurityMutationAuditExecutorError
} from "./security-mutation-audit-executor.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
import {
  createHostDeckSelectedWriteAuditPort,
  createHostDeckSelectedWriteGate,
  createHostDeckSelectedWriteMutation,
  createHostDeckSelectedWriteTargetResolution
} from "./selected-write-gate.js";
import {
  createTailscaleServeProxyTrustPolicy,
  type TailscaleServeRemoteAdmissionSnapshot
} from "./tailscale-serve-proxy-trust.js";

const baseTime = new Date("2026-07-13T22:00:00.000Z");
const localOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-fixture.fixture-tailnet.ts.net";
const remoteSource = "100.90.80.70";
const writerId = "client_remote_security_writer";
const readerId = "client_remote_security_reader";
const expiredId = "client_remote_security_expired";
const writerToken = "W".repeat(43);
const readerToken = "R".repeat(43);
const expiredToken = "E".repeat(43);
const initialWriterCsrf = "C".repeat(43);
const initialReaderCsrf = "Q".repeat(43);
const rotatedWriterCsrf = "N".repeat(43);
const writeTarget = Object.freeze(
  managedSessionTargetSchema.parse({
    type: "managed_session",
    session_id: "sess_remote_security",
    codex_thread_id: "thread_remote_security"
  })
);
const openApps: HostDeckFastifyInstance[] = [];
const openDatabases: Array<ReturnType<typeof openMigratedDatabase>["db"]> = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Tailscale Serve application security authorization", () => {
  it("composes protected reads, CSRF, lock, local-only unlock, and revoke", async () => {
    const harness = createHarness();
    await harness.app.ready();

    const accessState = await request(harness.app, {
      method: "GET",
      path: "/api/v1/access"
    });
    expect(accessState.statusCode, accessState.body).toBe(200);
    expect(accessState.json()).toMatchObject({
      authentication_state: "unpaired",
      configured_origin: externalOrigin,
      network_mode: "remote",
      transport: "https",
      permission: null,
      can_read_sessions: false,
      can_write_sessions: false,
      can_unlock: false
    });
    expect(accessState.body).not.toMatch(
      /source_key|remote_generation|tailnet_identity/iu
    );

    const unpaired = await request(harness.app, {
      method: "GET",
      path: "/fixture/protected"
    });
    expect(unpaired.statusCode).toBe(401);
    expect(harness.protectedReads()).toBe(0);

    const invalid = await request(harness.app, {
      method: "GET",
      path: "/fixture/protected",
      token: "I".repeat(43)
    });
    expect(invalid.statusCode).toBe(401);
    expect(harness.protectedReads()).toBe(0);

    const expired = await request(harness.app, {
      method: "GET",
      path: "/fixture/protected",
      token: expiredToken
    });
    expect(expired.statusCode).toBe(401);
    expect(harness.protectedReads()).toBe(0);

    const reader = await request(harness.app, {
      method: "GET",
      path: "/fixture/protected",
      token: readerToken
    });
    expect(reader.statusCode, reader.body).toBe(200);
    expect(reader.json()).toEqual({ protected: true });
    expect(harness.protectedReads()).toBe(1);

    const identityOnly = await request(harness.app, {
      identity: true,
      method: "GET",
      path: "/fixture/protected"
    });
    expect(identityOnly.statusCode).toBe(401);
    expect(harness.protectedReads()).toBe(1);

    const readOnlyWrite = await request(harness.app, {
      csrfGeneration: 1,
      csrfToken: initialReaderCsrf,
      method: "POST",
      path: "/fixture/write",
      payload: { operation_id: "op_remote_read_only_write_01" },
      token: readerToken
    });
    expect(readOnlyWrite.statusCode).toBe(403);
    expect(readOnlyWrite.json()).toMatchObject({ error: { code: "read_only" } });
    expect(harness.dispatches()).toBe(0);

    const missingCsrf = await request(harness.app, {
      method: "POST",
      path: "/fixture/write",
      payload: { operation_id: "op_remote_missing_csrf_01" },
      token: writerToken
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(harness.dispatches()).toBe(0);

    const bootstrap = await request(harness.app, {
      method: "POST",
      path: "/api/v1/access/csrf",
      payload: { operation_id: "op_remote_csrf_bootstrap_01" },
      token: writerToken
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.headers["set-cookie"]).toBeUndefined();
    expect(bootstrap.json()).toMatchObject({
      csrf_token: rotatedWriterCsrf,
      csrf_generation: 2
    });
    expect(bootstrap.body).not.toContain(writerToken);

    const staleCsrf = await request(harness.app, {
      csrfGeneration: 1,
      csrfToken: initialWriterCsrf,
      method: "POST",
      path: "/fixture/write",
      payload: { operation_id: "op_remote_stale_csrf_01" },
      token: writerToken
    });
    expect(staleCsrf.statusCode).toBe(403);
    expect(harness.dispatches()).toBe(0);

    harness.advance(1_000);
    const writable = await request(harness.app, {
      csrfGeneration: 2,
      csrfToken: rotatedWriterCsrf,
      method: "POST",
      path: "/fixture/write",
      payload: { operation_id: "op_remote_write_01" },
      token: writerToken
    });
    expect(writable.statusCode, writable.body).toBe(200);
    expect(writable.json()).toEqual({ dispatch_count: 1 });

    harness.advance(1_000);
    const lock = await request(harness.app, {
      csrfGeneration: 2,
      csrfToken: rotatedWriterCsrf,
      method: "POST",
      path: "/api/v1/access/lock",
      payload: { operation_id: "op_remote_lock_01", confirmed: true },
      token: writerToken
    });
    expect(lock.statusCode, lock.body).toBe(200);
    expect(lock.json()).toMatchObject({
      authentication_state: "paired_device",
      network_mode: "remote",
      permission: "write",
      locked: true,
      can_write_sessions: false,
      can_unlock: false
    });

    const lockedWrite = await request(harness.app, {
      csrfGeneration: 2,
      csrfToken: rotatedWriterCsrf,
      method: "POST",
      path: "/fixture/write",
      payload: { operation_id: "op_remote_locked_write_01" },
      token: writerToken
    });
    expect(lockedWrite.statusCode).toBe(423);
    expect(lockedWrite.json()).toMatchObject({ error: { code: "host_locked" } });
    expect(harness.dispatches()).toBe(1);

    const remoteUnlock = await request(harness.app, {
      csrfGeneration: 2,
      csrfToken: rotatedWriterCsrf,
      method: "POST",
      path: "/api/v1/access/unlock",
      payload: { operation_id: "op_remote_unlock_denied_01", confirmed: true },
      token: writerToken
    });
    expect(remoteUnlock.statusCode).toBe(403);
    expect(harness.audit.get("op_remote_unlock_denied_01")).toBeNull();

    harness.advance(1_000);
    const localUnlock = await harness.app.inject({
      headers: {
        host: new URL(localOrigin).host,
        "content-type": "application/json"
      },
      method: "POST",
      payload: { operation_id: "op_local_unlock_01", confirmed: true },
      url: "/api/v1/access/unlock"
    });
    expect(localUnlock.statusCode, localUnlock.body).toBe(200);
    expect(localUnlock.json()).toMatchObject({
      authentication_state: "local_admin",
      network_mode: "loopback",
      locked: false,
      can_unlock: true
    });

    harness.advance(1_000);
    const revokeReader = await request(harness.app, {
      csrfGeneration: 2,
      csrfToken: rotatedWriterCsrf,
      method: "POST",
      path: `/api/v1/access/devices/${readerId}/revoke`,
      payload: { operation_id: "op_remote_revoke_reader_01", confirmed: true },
      token: writerToken
    });
    expect(revokeReader.statusCode, revokeReader.body).toBe(200);
    expect(revokeReader.json()).toMatchObject({
      device_id: readerId,
      authority_invalidated: true,
      self_revoked: false
    });
    const revokedReader = await request(harness.app, {
      method: "GET",
      path: "/fixture/protected",
      token: readerToken
    });
    expect(revokedReader.statusCode).toBe(401);
    expect(harness.protectedReads()).toBe(1);

    harness.advance(1_000);
    const selfRevoke = await request(harness.app, {
      csrfGeneration: 2,
      csrfToken: rotatedWriterCsrf,
      method: "POST",
      path: `/api/v1/access/devices/${writerId}/revoke`,
      payload: { operation_id: "op_remote_revoke_self_01", confirmed: true },
      token: writerToken
    });
    expect(selfRevoke.statusCode, selfRevoke.body).toBe(200);
    expect(selfRevoke.json()).toMatchObject({
      device_id: writerId,
      authority_invalidated: true,
      self_revoked: true
    });
    const deletionCookie = selfRevoke.headers["set-cookie"];
    expect(deletionCookie).toBe(
      `${hostDeckDeviceCookieName}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`
    );
    const revokedWriter = await request(harness.app, {
      method: "GET",
      path: "/fixture/protected",
      token: writerToken
    });
    expect(revokedWriter.statusCode).toBe(401);

    expect(hostDeckHostLockPolicySnapshot(harness.lock)).toMatchObject({
      lock_changes: 2,
      transitions: 2
    });
    const serialized = JSON.stringify({
      audit: harness.db
        .prepare("SELECT * FROM selected_audit_events ORDER BY operation_id, phase")
        .all(),
      lock: lock.json(),
      revoke: selfRevoke.json()
    });
    for (const secret of [
      writerToken,
      readerToken,
      initialWriterCsrf,
      initialReaderCsrf,
      rotatedWriterCsrf,
      remoteSource
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("rejects a changed generation immediately before protected dispatch", async () => {
    const harness = createHarness({ changeBeforeDispatch: true });
    await harness.app.ready();
    const response = await request(harness.app, {
      csrfGeneration: 1,
      csrfToken: initialWriterCsrf,
      method: "POST",
      path: "/fixture/write",
      payload: { operation_id: "op_remote_stale_dispatch_01" },
      token: writerToken
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.headers.connection).toBe("close");
    expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    expect(harness.dispatches()).toBe(0);
    expect(response.body).not.toMatch(
      /source_key|remote_generation|tailnet_identity|fixture-tailnet/iu
    );
  });

  it("rejects stale CSRF, lock, and revoke transitions after accepted audit", async () => {
    const cases = [
      {
        action: "csrf_bootstrap" as const,
        operationId: "op_remote_stale_csrf_transition_01",
        request: {
          method: "POST" as const,
          path: "/api/v1/access/csrf",
          payload: { operation_id: "op_remote_stale_csrf_transition_01" },
          token: writerToken
        },
        unchanged(db: Harness["db"]) {
          expect(
            db
              .prepare("SELECT csrf_generation FROM auth_devices WHERE id = ?")
              .get(writerId)
          ).toEqual({ csrf_generation: 1 });
        }
      },
      {
        action: "lock" as const,
        operationId: "op_remote_stale_lock_transition_01",
        request: {
          csrfGeneration: 1,
          csrfToken: initialWriterCsrf,
          method: "POST" as const,
          path: "/api/v1/access/lock",
          payload: {
            operation_id: "op_remote_stale_lock_transition_01",
            confirmed: true
          },
          token: writerToken
        },
        unchanged(db: Harness["db"]) {
          expect(
            db
              .prepare("SELECT locked FROM settings WHERE id = 'hostdeck_settings'")
              .get()
          ).toEqual({ locked: 0 });
        }
      },
      {
        action: "device_revoke" as const,
        operationId: "op_remote_stale_revoke_transition_01",
        request: {
          csrfGeneration: 1,
          csrfToken: initialWriterCsrf,
          method: "POST" as const,
          path: `/api/v1/access/devices/${readerId}/revoke`,
          payload: {
            operation_id: "op_remote_stale_revoke_transition_01",
            confirmed: true
          },
          token: writerToken
        },
        unchanged(db: Harness["db"]) {
          expect(
            db.prepare("SELECT revoked_at FROM auth_devices WHERE id = ?").get(readerId)
          ).toEqual({ revoked_at: null });
        }
      }
    ];

    for (const fixtureCase of cases) {
      const harness = createHarness({
        changeAfterAcceptedAction: fixtureCase.action
      });
      await harness.app.ready();
      const response = await request(harness.app, fixtureCase.request);
      expect(response.statusCode, `${fixtureCase.action}: ${response.body}`).toBe(
        403
      );
      expect(response.headers.connection).toBe("close");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.json()).toMatchObject({
        error: { code: "invalid_origin", retryable: false }
      });
      fixtureCase.unchanged(harness.db);
      expect(harness.audit.require(fixtureCase.operationId).records).toMatchObject([
        { phase: "accepted", outcome: "accepted" },
        { phase: "terminal", outcome: "incomplete", error_code: "internal_error" }
      ]);
    }
  });
});

interface HarnessOptions {
  readonly changeAfterAcceptedAction?:
    | "csrf_bootstrap"
    | "device_revoke"
    | "lock";
  readonly changeBeforeDispatch?: boolean;
}

interface Harness {
  readonly advance: (milliseconds: number) => void;
  readonly app: HostDeckFastifyInstance;
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly dispatches: () => number;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly protectedReads: () => number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-remote-security-"));
  tempDirectories.push(directory);
  const databasePath = join(directory, "hostdeck.sqlite");
  const opened = openMigratedDatabase(databasePath, {
    now: () => new Date(baseTime)
  });
  openDatabases.push(opened.db);
  let clockMs = baseTime.getTime() + 1_000;
  const now = () => new Date(clockMs);
  let admission: TailscaleServeRemoteAdmissionSnapshot = openAdmission(7);

  const settings = createSettingsRepository(opened.db);
  settings.getOrCreateDefault({
    bindPort: 3777,
    now: () => new Date(baseTime),
    stateDir: directory
  });
  const auth = createAuthDeviceRepository(opened.db);
  auth.create({
    clientLabel: "Remote writer",
    createdAt: new Date(baseTime),
    id: writerId,
    permission: "write",
    rawCsrfToken: initialWriterCsrf,
    rawDeviceToken: writerToken
  });
  auth.create({
    clientLabel: "Remote reader",
    createdAt: new Date(baseTime),
    id: readerId,
    permission: "read",
    rawCsrfToken: initialReaderCsrf,
    rawDeviceToken: readerToken
  });
  auth.create({
    clientLabel: "Expired remote device",
    createdAt: new Date(baseTime),
    expiresAt: new Date(baseTime.getTime() + 500),
    id: expiredId,
    permission: "read",
    rawCsrfToken: "X".repeat(43),
    rawDeviceToken: expiredToken
  });
  const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
    now
  });
  const audit = createSelectedAuditRepository(opened.db);
  const auditRepository: SelectedAuditRepository =
    options.changeAfterAcceptedAction === undefined
      ? audit
      : {
          ...audit,
          recordAccepted(record) {
            const trail = audit.recordAccepted(record);
            if (
              record !== null &&
              typeof record === "object" &&
              Object.getOwnPropertyDescriptor(record, "action")?.value ===
                options.changeAfterAcceptedAction
            ) {
              admission = openAdmission(8);
            }
            return trail;
          }
        };
  let auditIndex = 0;
  const auditExecutor = createSecurityMutationAuditExecutor({
    repository: auditRepository,
    now: () => now().toISOString(),
    create_record_id: () => `audit:remote:security:${auditIndex++}`
  });
  const csrfRepository = createSelectedCsrfAuthorizationRepository(opened.db, {
    generateCsrfToken: () => rotatedWriterCsrf
  });
  const csrfPolicy = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) =>
        csrfRepository.authorizeBrowserWrite(input),
      rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
    },
    now
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings.require(),
      transition: (input) => settings.transitionHostLock(input)
    },
    now
  });
  const writeAudit = createHostDeckSelectedWriteAuditPort<"prompt">({
    executor: "selected_write_gate",
    async execute(execution) {
      const transition = execution.transition;
      let result: Awaited<ReturnType<typeof transition>>;
      try {
        if (options.changeBeforeDispatch) admission = openAdmission(8);
        result = await transition(Object.freeze({ audit_state: "accepted" }));
      } catch {
        throw new HostDeckSecurityMutationAuditExecutorError(
          "transition_failed",
          "internal_error",
          "Test selected-write transition failed.",
          "transition",
          "incomplete",
          "terminal",
          false
        );
      }
      if (result.outcome !== "succeeded") {
        return Object.freeze({
          outcome: result.outcome,
          error_code: result.error_code
        });
      }
      const prepareResponse = execution.prepare_response;
      return Object.freeze({
        outcome: "succeeded" as const,
        response: await prepareResponse(result.response)
      });
    }
  });
  const writeGate = createHostDeckSelectedWriteGate({
    audit: writeAudit,
    csrf: csrfPolicy,
    lock,
    manifest: manifest("prompt_dispatch")
  });
  const revocation = createDeviceRevocationRepository(opened.db);
  let protectedReadCount = 0;
  let dispatchCount = 0;
  const routePlugins: HostDeckRoutePluginRegistration[] = [
    createHostDeckCsrfRouteRegistration({ audit: auditExecutor, csrf: csrfPolicy }),
    createHostDeckHostLockRouteRegistration({
      audit: auditExecutor,
      csrf: csrfPolicy,
      lock
    }),
    createHostDeckDeviceRevokeRouteRegistration({
      activeDeviceAuthority: authenticationPolicy.activeDeviceAuthority,
      audit: auditExecutor,
      csrf: csrfPolicy,
      devices: { revoke: (input) => revocation.revoke(input) },
      lock,
      now
    }),
    securityFixtureRoutes({
      dispatch() {
        dispatchCount += 1;
        return dispatchCount;
      },
      protectedRead() {
        protectedReadCount += 1;
      },
      writeGate
    })
  ];
  const app = createHostDeckTailscaleServeFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authenticationPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins,
    tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
      localOrigin,
      readRemoteAdmission: () => admission
    })
  });
  openApps.push(app);
  return {
    advance(milliseconds) {
      clockMs += milliseconds;
    },
    app,
    audit,
    db: opened.db,
    dispatches: () => dispatchCount,
    lock,
    protectedReads: () => protectedReadCount
  };
}

function securityFixtureRoutes(input: {
  readonly dispatch: () => number;
  readonly protectedRead: () => void;
  readonly writeGate: ReturnType<typeof createHostDeckSelectedWriteGate<"prompt">>;
}): HostDeckRoutePluginRegistration {
  return {
    id: "remote-security-authorization-fixture",
    surface: "api",
    register(app) {
      app.get(
        "/fixture/protected",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            response: {
              200: z.object({ protected: z.literal(true) }).strict()
            }
          }
        },
        async () => {
          input.protectedRead();
          return { protected: true as const };
        }
      );
      app.post(
        "/fixture/write",
        {
          schema: {
            body: z.object({ operation_id: clientOperationIdSchema }).strict(),
            response: {
              200: z.object({ dispatch_count: z.number().int().positive() }).strict()
            }
          }
        },
        async (request) => {
          const result = await input.writeGate.execute({
            request,
            candidate: request.body,
            parse(candidate) {
              const parsed = z
                .object({ operation_id: clientOperationIdSchema })
                .strict()
                .parse(candidate);
              return createHostDeckSelectedWriteMutation({
                operation_id: parsed.operation_id,
                action: "prompt",
                target: writeTarget,
                accepted_summary: { schema_version: 1, text_length: 1 },
                value: parsed
              });
            },
            resolve_target(mutation) {
              return createHostDeckSelectedWriteTargetResolution({
                target: mutation.target,
                capability: "turn_input",
                value: { runtime_state: "ready" }
              });
            },
            dispatch() {
              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1,
                  accepted: true
                }),
                response: Object.freeze({ dispatch_count: input.dispatch() })
              });
            },
            prepare_response(response: { readonly dispatch_count: number }) {
              return Object.freeze({ ...response });
            }
          });
          if (result.outcome === "succeeded") return result.response;
          throw new Error("Selected fixture write did not succeed.");
        }
      );
    }
  };
}

function manifest(id: string): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new TypeError(`Missing selected manifest entry ${id}.`);
  }
  return matches[0];
}

interface RequestInput {
  readonly csrfGeneration?: number;
  readonly csrfToken?: string;
  readonly identity?: boolean;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly token?: string;
}

function request(app: HostDeckFastifyInstance, input: RequestInput) {
  const headers = remoteHeaders({
    ...(input.token === undefined ? {} : { cookie: input.token }),
    ...(input.csrfGeneration === undefined
      ? {}
      : { csrfGeneration: input.csrfGeneration }),
    ...(input.csrfToken === undefined ? {} : { csrfToken: input.csrfToken }),
    ...(input.identity === undefined ? {} : { identity: input.identity }),
    origin: input.method === "POST"
  });
  if (input.payload !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    headers,
    method: input.method,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    url: input.path
  });
}

function remoteHeaders(options: {
  readonly cookie?: string;
  readonly csrfGeneration?: number;
  readonly csrfToken?: string;
  readonly identity?: boolean;
  readonly origin?: boolean;
}): Record<string, string> {
  const authority = new URL(externalOrigin).host;
  const headers: Record<string, string> = {
    host: authority,
    "x-forwarded-for": remoteSource,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (options.origin) headers.origin = externalOrigin;
  if (options.cookie !== undefined) {
    headers.cookie = `${hostDeckDeviceCookieName}=${options.cookie}`;
  }
  if (options.csrfToken !== undefined) {
    headers["x-hostdeck-csrf"] = options.csrfToken;
  }
  if (options.csrfGeneration !== undefined) {
    headers["x-hostdeck-csrf-generation"] = String(options.csrfGeneration);
  }
  if (options.identity) {
    headers["tailscale-headers-info"] = "https://tailscale.com/s/serve-headers";
    headers["tailscale-user-login"] = "identity-does-not-authorize@example.test";
    headers["tailscale-user-name"] = "Identity Does Not Authorize";
    headers["tailscale-user-profile-pic"] = "https://example.test/avatar";
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
