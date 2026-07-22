import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultResourceBudget } from "../packages/contracts/src/index.js";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckTailscaleServeFastifyApp,
  createSecurityMutationAuditExecutor,
  createTailscaleServeProxyTrustPolicy,
  type HostDeckFastifyInstance,
  hostDeckCsrfPolicySnapshot,
  hostDeckDeviceCookieName,
  hostDeckHostLockPolicySnapshot,
  tailscaleServeProxyTrustSnapshot
} from "../packages/server/src/index.js";
import {
  createAuthDeviceRepository,
  createDeviceRevocationRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";
import {
  type BrowserCsrfClient,
  createBrowserCsrfClient,
  HostDeckBrowserCsrfError
} from "../packages/web/src/csrf-client.js";
import {
  type BrowserHttpFetchPort,
  createBrowserHttpClient
} from "../packages/web/src/http-client.js";

const externalOrigin =
  "https://hostdeck-browser-csrf.fixture-tailnet.ts.net";
const deviceId = `client_${"c".repeat(24)}`;
const rawDeviceToken = "D".repeat(43);
const initialCsrfToken = "I".repeat(43);
const startedAt = "2026-07-22T18:00:00.000Z";
const harnesses: BrowserCsrfServerHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.close();
});

describe("FE-V1-024 real browser CSRF lifecycle", () => {
  it("bootstraps over native loopback and preserves authority after the secure-write guard", async () => {
    const harness = await createHarness("loopback");
    const page = harness.createClient();

    expect(page.client.snapshot()).toEqual({
      phase: "idle",
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: "not_bootstrapped"
    });
    await expect(page.client.bootstrap()).resolves.toMatchObject({
      phase: "ready",
      generation: 2
    });
    expect(harness.requests).toEqual([
      {
        path: "/api/v1/access/csrf",
        hasCsrfToken: false,
        csrfGeneration: null
      }
    ]);

    const denied = await captureCsrfFailure(
      page.client.request("host_lock", {
        body: {
          operation_id: "op_browser_csrf_loopback_lock_0001",
          confirmed: true
        }
      })
    );
    expect(denied).toMatchObject({
      reason: "api_error",
      status: 426,
      apiError: { code: "insecure_transport", retryable: false }
    });
    expect(page.client.snapshot()).toMatchObject({
      phase: "ready",
      generation: 2,
      failure: null
    });
    expect(harness.settings.readHostLock().locked).toBe(false);
    expect(hostDeckCsrfPolicySnapshot(harness.csrf)).toMatchObject({
      bootstrap_rotations: 1,
      write_authorizations: 0
    });
    expect(hostDeckHostLockPolicySnapshot(harness.lock)).toMatchObject({
      transitions: 0
    });
    expect(harness.scanSecrets()).toEqual({ checked: 3, leaks: 0 });

    page.client.close();
    await harness.close();
    expect(harness.closed()).toBe(true);
  });

  it("rotates on reload, rejects a stale page, locks, invalidates, and denies a revoked device over admitted Serve", async () => {
    const harness = await createHarness("serve");
    const oldPage = harness.createClient();
    await expect(oldPage.client.bootstrap()).resolves.toMatchObject({
      phase: "ready",
      generation: 2
    });

    const reloadedPage = harness.createClient();
    expect(reloadedPage.client.snapshot()).toMatchObject({
      phase: "idle",
      generation: null,
      invalidationReason: "not_bootstrapped"
    });
    await expect(reloadedPage.client.bootstrap()).resolves.toMatchObject({
      phase: "ready",
      generation: 3
    });

    const stale = await captureCsrfFailure(
      oldPage.client.request("host_lock", {
        body: {
          operation_id: "op_browser_csrf_serve_stale_lock_0001",
          confirmed: true
        }
      })
    );
    expect(stale).toMatchObject({
      reason: "authority_rejected",
      status: 403,
      apiError: { code: "permission_denied", retryable: false }
    });
    expect(oldPage.client.snapshot()).toMatchObject({
      phase: "failed",
      generation: null,
      failure: { reason: "authority_rejected" }
    });

    const locked = await reloadedPage.client.request("host_lock", {
      body: {
        operation_id: "op_browser_csrf_serve_lock_0001",
        confirmed: true
      }
    });
    expect(locked).toMatchObject({
      status: 200,
      data: {
        authentication_state: "paired_device",
        permission: "write",
        network_mode: "remote",
        transport: "https",
        locked: true
      }
    });
    expect(harness.settings.readHostLock().locked).toBe(true);
    expect(
      harness.audit
        .require("op_browser_csrf_serve_lock_0001")
        .records.map((record) => [record.phase, record.outcome])
    ).toEqual([
      ["accepted", "accepted"],
      ["terminal", "succeeded"]
    ]);

    const requestsBeforeInvalidation = harness.requests.length;
    expect(reloadedPage.client.invalidate("remote_authority_changed")).toMatchObject({
      phase: "idle",
      generation: null,
      invalidationReason: "remote_authority_changed"
    });
    const notReady = await captureCsrfFailure(
      reloadedPage.client.request("host_lock", {
        body: {
          operation_id: "op_browser_csrf_serve_invalidated_lock_0001",
          confirmed: true
        }
      })
    );
    expect(notReady.reason).toBe("not_ready");
    expect(harness.requests).toHaveLength(requestsBeforeInvalidation);

    await expect(reloadedPage.client.bootstrap()).resolves.toMatchObject({
      phase: "ready",
      generation: 4
    });
    harness.revoke();
    const revoked = await captureCsrfFailure(
      reloadedPage.client.request("host_lock", {
        body: {
          operation_id: "op_browser_csrf_serve_revoked_lock_0001",
          confirmed: true
        }
      })
    );
    expect(revoked).toMatchObject({
      reason: "authority_rejected",
      status: 401,
      apiError: { code: "permission_denied", retryable: false }
    });
    expect(reloadedPage.client.snapshot()).toMatchObject({
      phase: "failed",
      generation: null,
      failure: { reason: "authority_rejected" }
    });

    const revokedReload = harness.createClient();
    const revokedBootstrap = await captureCsrfFailure(
      revokedReload.client.bootstrap()
    );
    expect(revokedBootstrap).toMatchObject({
      reason: "authority_rejected",
      status: 401,
      apiError: { code: "permission_denied", retryable: false }
    });
    const publicState = JSON.stringify({
      stale,
      revoked,
      revokedBootstrap,
      oldPage: oldPage.client.snapshot(),
      reloadedPage: reloadedPage.client.snapshot(),
      revokedReload: revokedReload.client.snapshot()
    });
    for (const secret of harness.secrets) expect(publicState).not.toContain(secret);

    expect(hostDeckCsrfPolicySnapshot(harness.csrf)).toMatchObject({
      bootstrap_rotations: 3,
      write_authorizations: 1
    });
    expect(hostDeckHostLockPolicySnapshot(harness.lock)).toMatchObject({
      lock_changes: 1,
      transitions: 1
    });
    expect(tailscaleServeProxyTrustSnapshot(harness.app)).toMatchObject({
      accepted_local_requests: 0,
      accepted_remote_requests: 7,
      stale_remote_context_rejections: 0
    });
    expect(harness.scanSecrets()).toEqual({ checked: 5, leaks: 0 });

    oldPage.client.close();
    reloadedPage.client.close();
    revokedReload.client.close();
    await harness.close();
    expect(harness.closed()).toBe(true);
  });
});

type HarnessMode = "loopback" | "serve";

interface RequestObservation {
  readonly path: string;
  readonly hasCsrfToken: boolean;
  readonly csrfGeneration: string | null;
}

interface BrowserCsrfServerHarness {
  readonly app: HostDeckFastifyInstance;
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly requests: RequestObservation[];
  readonly secrets: ReadonlySet<string>;
  readonly settings: ReturnType<typeof createSettingsRepository>;
  readonly close: () => Promise<void>;
  readonly closed: () => boolean;
  readonly createClient: () => {
    readonly client: BrowserCsrfClient;
  };
  readonly revoke: () => void;
  readonly scanSecrets: () => { readonly checked: number; readonly leaks: number };
}

async function createHarness(mode: HarnessMode): Promise<BrowserCsrfServerHarness> {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-browser-csrf-"));
  const databasePath = join(root, "hostdeck.sqlite");
  let wallTime = Date.parse(startedAt);
  const now = () => new Date(++wallTime);
  const opened = openMigratedDatabase(databasePath, { now });
  const port = await reservePort();
  const localOrigin = `http://127.0.0.1:${port}`;
  const settings = createSettingsRepository(opened.db);
  settings.getOrCreateDefault({ stateDir: root, bindPort: port, now });

  const auth = createAuthDeviceRepository(opened.db);
  auth.create({
    id: deviceId,
    rawDeviceToken,
    rawCsrfToken: initialCsrfToken,
    permission: "write",
    clientLabel: "Browser CSRF integration phone",
    createdAt: now()
  });
  const rotatedTokens = ["R", "S", "T"].map((value) => value.repeat(43));
  const secrets = new Set([rawDeviceToken, initialCsrfToken]);
  let tokenIndex = 0;
  const csrfRepository = createSelectedCsrfAuthorizationRepository(opened.db, {
    generateCsrfToken() {
      const token = rotatedTokens[tokenIndex++];
      if (token === undefined) throw new Error("CSRF integration entropy exhausted.");
      secrets.add(token);
      return token;
    }
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) =>
        csrfRepository.authorizeBrowserWrite(input),
      rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
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
  const audit = createSelectedAuditRepository(opened.db);
  let auditId = 0;
  const securityAudit = createSecurityMutationAuditExecutor({
    repository: audit,
    now: () => now().toISOString(),
    create_record_id: () => `audit:browser-csrf:${++auditId}`
  });
  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
    now
  });
  const routePlugins = [
    createHostDeckCsrfRouteRegistration({ audit: securityAudit, csrf }),
    createHostDeckHostLockRouteRegistration({
      audit: securityAudit,
      csrf,
      lock
    })
  ];
  const app =
    mode === "loopback"
      ? createHostDeckFastifyApp({
          observeInternalError: () => undefined,
          requestAuthenticationPolicy: authentication,
          requestTrustPolicy: createHostDeckRequestTrustPolicy({
            allowedOrigin: localOrigin
          }),
          resourceBudget: defaultResourceBudget,
          routePlugins
        })
      : (() => {
          const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
          return createHostDeckTailscaleServeFastifyApp({
            observeInternalError: () => undefined,
            requestAuthenticationPolicy: authentication,
            resourceBudget: defaultResourceBudget,
            routePlugins,
            remoteIngressRequestAuthority: authority,
            tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
              localOrigin,
              readRemoteAdmission: () =>
                authority.synchronize({
                  admission: "open",
                  external_origin: externalOrigin,
                  generation: 37
                })
            })
          });
        })();
  await app.listen({ host: "127.0.0.1", port });

  const requests: RequestObservation[] = [];
  let operationId = 0;
  let isClosed = false;
  const observeRequest = (path: string, headers: Readonly<Record<string, string>>) => {
    requests.push(
      Object.freeze({
        path,
        hasCsrfToken: Object.hasOwn(headers, "x-hostdeck-csrf"),
        csrfGeneration: headers["x-hostdeck-csrf-generation"] ?? null
      })
    );
  };
  const fetchPort =
    mode === "loopback"
      ? nativeLoopbackFetch(localOrigin, rawDeviceToken, observeRequest)
      : admittedServeFetch(localOrigin, rawDeviceToken, observeRequest);

  const harness: BrowserCsrfServerHarness = {
    app,
    audit,
    csrf,
    lock,
    requests,
    secrets,
    settings,
    async close() {
      if (isClosed) return;
      isClosed = true;
      await app.close();
      opened.db.close();
      rmSync(root, { force: true, recursive: true });
    },
    closed: () => isClosed && !opened.db.open,
    createClient() {
      return Object.freeze({
        client: createBrowserCsrfClient({
          httpClient: createBrowserHttpClient({
            origin: mode === "loopback" ? localOrigin : externalOrigin,
            fetch: fetchPort
          }),
          createOperationId: () =>
            `op_browser_csrf_${mode}_${String(++operationId).padStart(4, "0")}`
        })
      });
    },
    revoke() {
      createDeviceRevocationRepository(opened.db).revoke({
        deviceId,
        now: now()
      });
    },
    scanSecrets: () => scanSecrets(databasePath, secrets)
  };
  harnesses.push(harness);
  return harness;
}

function nativeLoopbackFetch(
  origin: string,
  token: string,
  observe: (path: string, headers: Readonly<Record<string, string>>) => void
): BrowserHttpFetchPort {
  return async (path, init) => {
    const headers = {
      ...init.headers,
      cookie: `${hostDeckDeviceCookieName}=${token}`,
      origin
    };
    observe(path, headers);
    return (await fetch(new URL(path, origin), {
      ...init,
      headers
    } as RequestInit)) as never;
  };
}

function admittedServeFetch(
  proxyOrigin: string,
  token: string,
  observe: (path: string, headers: Readonly<Record<string, string>>) => void
): BrowserHttpFetchPort {
  return async (path, init) => {
    const authority = new URL(externalOrigin).host;
    const headers: Record<string, string> = {
      ...init.headers,
      cookie: `${hostDeckDeviceCookieName}=${token}`,
      host: authority,
      origin: externalOrigin,
      "x-forwarded-for": "100.91.82.74",
      "x-forwarded-host": authority,
      "x-forwarded-proto": "https"
    };
    if (init.body !== undefined) {
      headers["content-length"] = String(
        new TextEncoder().encode(init.body).byteLength
      );
    }
    observe(path, headers);
    return await new Promise((resolve, reject) => {
      const request = httpRequest(
        new URL(path, proxyOrigin),
        { method: init.method, headers },
        (response) => {
          const chunks: Uint8Array[] = [];
          response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () => {
            const status = response.statusCode;
            if (status === undefined) {
              reject(new Error("Serve fixture response has no status code."));
              return;
            }
            const responseHeaders = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              const name = response.rawHeaders[index];
              const value = response.rawHeaders[index + 1];
              if (name !== undefined && value !== undefined) {
                responseHeaders.append(name, value);
              }
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status,
                headers: responseHeaders
              }) as never
            );
          });
        }
      );
      request.once("error", reject);
      const abort = () => request.destroy(new Error("Browser CSRF request aborted."));
      init.signal.addEventListener("abort", abort, { once: true });
      request.once("close", () =>
        init.signal.removeEventListener("abort", abort)
      );
      if (init.body !== undefined) request.write(init.body);
      request.end();
    });
  };
}

async function captureCsrfFailure(
  operation: Promise<unknown>
): Promise<HostDeckBrowserCsrfError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckBrowserCsrfError);
    return error as HostDeckBrowserCsrfError;
  }
  throw new Error("Expected a browser CSRF failure.");
}

function scanSecrets(
  databasePath: string,
  secrets: ReadonlySet<string>
): { readonly checked: number; readonly leaks: number } {
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
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
