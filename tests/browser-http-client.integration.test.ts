import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultResourceBudget } from "../packages/contracts/src/index.js";
import {
  createHostDeckFastifyApp,
  createHostDeckHealthRouteRegistration,
  createHostDeckHostHealthService,
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckTailscaleServeFastifyApp,
  createTailscaleServeProxyTrustPolicy,
  type HostDeckFastifyInstance,
  hostDeckDeviceCookieName,
  tailscaleServeProxyTrustSnapshot
} from "../packages/server/src/index.js";
import {
  type BrowserHttpFetchPort,
  createBrowserHttpClient,
  HostDeckBrowserHttpError
} from "../packages/web/src/http-client.js";

const externalOrigin =
  "https://hostdeck-browser-client.fixture-tailnet.ts.net";
const deviceToken = "R".repeat(43);
const checkedAt = "2026-07-22T15:00:00.000Z";
const apps: HostDeckFastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

describe("FE-V1-019 real selected API browser client", () => {
  it("reads the real selected API through loopback and admitted Serve contexts", async () => {
    const localPort = await reservePort();
    const localOrigin = `http://127.0.0.1:${localPort}`;
    const localHealth = readyHealth();
    const localApp = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: authenticationPolicy(),
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigin: localOrigin
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        createHostDeckHealthRouteRegistration({ health: localHealth })
      ]
    });
    apps.push(localApp);
    await localApp.listen({ host: "127.0.0.1", port: localPort });

    const localClient = createBrowserHttpClient({
      origin: localOrigin,
      fetch: nativeSameOriginFetch(localOrigin)
    });
    await expect(localClient.request("health_liveness", {})).resolves.toEqual({
      status: 200,
      data: { status: "alive" }
    });
    const localStatus = await localClient.request("host_status", {});
    expect(localStatus).toMatchObject({
      status: 200,
      data: {
        access: {
          mode: "loopback_read",
          network_mode: "loopback",
          transport: "http"
        }
      }
    });

    const remotePort = await reservePort();
    const proxyOrigin = `http://127.0.0.1:${remotePort}`;
    const remoteHealth = readyHealth();
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    const remoteApp = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: authenticationPolicy(),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        createHostDeckHealthRouteRegistration({ health: remoteHealth })
      ],
      remoteIngressRequestAuthority: authority,
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: proxyOrigin,
        readRemoteAdmission: () =>
          authority.synchronize({
            admission: "open",
            external_origin: externalOrigin,
            generation: 11
          })
      })
    });
    apps.push(remoteApp);
    await remoteApp.listen({ host: "127.0.0.1", port: remotePort });

    const unpairedClient = createBrowserHttpClient({
      origin: externalOrigin,
      fetch: admittedServeFetch(proxyOrigin, null)
    });
    const denied = await captureFailure(
      unpairedClient.request("host_status", {})
    );
    expect(
      denied,
      JSON.stringify(tailscaleServeProxyTrustSnapshot(remoteApp))
    ).toMatchObject({
      reason: "api_error",
      status: 401,
      transport: "https",
      apiError: { code: "permission_denied" }
    });

    const pairedClient = createBrowserHttpClient({
      origin: externalOrigin,
      fetch: admittedServeFetch(proxyOrigin, deviceToken)
    });
    const remoteStatus = await pairedClient.request("host_status", {});
    expect(remoteStatus).toMatchObject({
      status: 200,
      data: {
        access: {
          mode: "paired_read",
          network_mode: "remote",
          transport: "https",
          write_eligibility: {
            eligible: false,
            causes: ["read_only_access"]
          }
        }
      }
    });
    expect(JSON.stringify(remoteStatus)).not.toContain(deviceToken);
    expect(tailscaleServeProxyTrustSnapshot(remoteApp)).toMatchObject({
      accepted_remote_requests: 2,
      accepted_local_requests: 0,
      stale_remote_context_rejections: 0
    });
  });
});

function readyHealth() {
  const health = createHostDeckHostHealthService({
    now: () => new Date(checkedAt)
  });
  for (const component of [
    "storage",
    "runtime",
    "compatibility",
    "projector",
    "fanout",
    "listener",
    "lease"
  ] as const) {
    health.updateLocal({
      component,
      source_generation: 1,
      state: "ready",
      reasons: []
    });
  }
  return health;
}

function authenticationPolicy() {
  return createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken({ rawDeviceToken }) {
      if (rawDeviceToken !== deviceToken) {
        throw new Error("Private browser authentication failure.");
      }
      return {
        trusted: true as const,
        readOnly: true,
        device: {
          id: "client_browser_http_reader",
          token_hash: `sha256:${"a".repeat(64)}`,
          csrf_token_hash: `sha256:${"b".repeat(64)}`,
          csrf_generation: 1,
          csrf_rotated_at: checkedAt,
          client_label: "Browser HTTP phone",
          permission: "read" as const,
          created_at: checkedAt,
          last_used_at: checkedAt,
          expires_at: null,
          revoked_at: null
        }
      };
    },
    now: () => new Date(checkedAt)
  });
}

function nativeSameOriginFetch(origin: string): BrowserHttpFetchPort {
  return async (path, init) => {
    return (await fetch(new URL(path, origin), init as RequestInit)) as never;
  };
}

function admittedServeFetch(
  proxyOrigin: string,
  rawDeviceToken: string | null
): BrowserHttpFetchPort {
  return async (path, init) => {
    const authority = new URL(externalOrigin).host;
    const headers: Record<string, string> = {
      ...init.headers,
      host: authority,
      "x-forwarded-for": "100.91.82.73",
      "x-forwarded-host": authority,
      "x-forwarded-proto": "https"
    };
    if (rawDeviceToken !== null) {
      headers.cookie = `${hostDeckDeviceCookieName}=${rawDeviceToken}`;
    }
    if (init.body !== undefined) {
      headers["content-length"] = String(
        new TextEncoder().encode(init.body).byteLength
      );
    }
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
      const abort = () => request.destroy(new Error("Browser test request aborted."));
      init.signal.addEventListener("abort", abort, { once: true });
      request.once("close", () =>
        init.signal.removeEventListener("abort", abort)
      );
      if (init.body !== undefined) request.write(init.body);
      request.end();
    });
  };
}

async function captureFailure(
  operation: Promise<unknown>
): Promise<HostDeckBrowserHttpError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckBrowserHttpError);
    return error as HostDeckBrowserHttpError;
  }
  throw new Error("Expected a browser HTTP failure.");
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
