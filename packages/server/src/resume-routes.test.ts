import { Buffer } from "node:buffer";
import { createConnection, createServer } from "node:net";
import {
  defaultResourceBudget,
  selectedResumeMetadataResponseSchema
} from "@hostdeck/contracts";
import { HostDeckAuthRepositoryError } from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import { hostDeckLoopbackTestOrigin, injectHostDeckLoopback } from "./fastify-loopback-test-request.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckDeviceAuthenticationPort,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  type HostDeckRequestTrustPolicy
} from "./fastify-request-trust.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import {
  HostDeckResumeMetadataError,
  type HostDeckResumeMetadataReader
} from "./resume-metadata.js";
import {
  createHostDeckResumeRouteRegistration,
  hostDeckResumeRouteRegistrationId
} from "./resume-routes.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

const apps: HostDeckFastifyInstance[] = [];
const sessionId = "sess_resume_route_001";
const threadId = "thread-resume-route-001";
const socketPath = "/run/user/1000/hostdeck/app-server.sock";
const createdAt = "2026-07-15T12:00:00.000Z";
const readToken = "R".repeat(43);
const writeToken = "W".repeat(43);
const expiredToken = "E".repeat(43);
const revokedToken = "V".repeat(43);
const storageToken = "S".repeat(43);
const loopbackOrigin = hostDeckLoopbackTestOrigin;
const remoteLocalOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-resume.fixture-tailnet.ts.net";
const remoteSource = "100.90.80.70";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigin: loopbackOrigin
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

describe("selected managed-thread resume route", () => {
  it("requires one exact accessor-free snapshotted reader port", async () => {
    let observedThis: unknown = "not-called";
    const mutable: { read: HostDeckResumeMetadataReader["read"] } = {
      read: function readResume(this: void) {
        observedThis = this;
        return availableResponse()
      }
    };
    const registration = createHostDeckResumeRouteRegistration({
      resume: mutable
    });
    expect(registration).toMatchObject({
      id: hostDeckResumeRouteRegistrationId,
      surface: "api"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    mutable.read = () => {
      throw new Error("mutated-reader-private-sentinel");
    };
    const app = createResumeAppFromRegistration(registration);
    await app.ready();
    expect(
      (
        await injectHostDeckLoopback(app, {
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/resume`
        })
      ).statusCode
    ).toBe(200);
    expect(observedThis).toBeUndefined();

    const nullPort = Object.assign(Object.create(null) as Record<string, unknown>, {
      read: () => availableResponse()
    });
    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      resume: nullPort
    });
    expect(() =>
      createHostDeckResumeRouteRegistration(nullInput as never)
    ).not.toThrow();

    let accessorCalls = 0;
    const inputAccessor = Object.defineProperty({}, "resume", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("route-input-accessor-private-sentinel");
      }
    });
    const portAccessor = Object.defineProperty({}, "read", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("route-port-accessor-private-sentinel");
      }
    });
    const hostileProxy = new Proxy(
      { resume: { read: () => availableResponse() } },
      {
        ownKeys() {
          throw new Error("route-input-proxy-private-sentinel");
        }
      }
    );
    for (const candidate of [
      null,
      [],
      {},
      { resume: { read: () => availableResponse() }, extra: true },
      Object.assign(Object.create({ inherited: true }), {
        resume: { read: () => availableResponse() }
      }),
      { resume: null },
      { resume: {} },
      { resume: { read: null } },
      { resume: { read: () => availableResponse(), extra: true } },
      inputAccessor,
      { resume: portAccessor },
      hostileProxy
    ]) {
      expect(() =>
        createHostDeckResumeRouteRegistration(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("binds only the exact canonical no-store GET surface", async () => {
    const requested: string[] = [];
    const app = createResumeApp({
      read(requestedSessionId) {
        requested.push(requestedSessionId);
        return availableResponse();
      }
    });
    await app.ready();

    const response = await injectHostDeckLoopback(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/resume`
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(availableResponse());
    expect(requested).toEqual([sessionId]);
    for (const forbidden of [
      "codex_thread_id",
      '"cwd"',
      "binding_id",
      "runtime_version",
      "cookie",
      "token",
      "raw_shell"
    ]) {
      expect(response.body).not.toContain(forbidden);
    }

    const unavailableApp = createResumeApp({
      read: () => unavailableResponse()
    });
    await unavailableApp.ready();
    const unavailable = await injectHostDeckLoopback(unavailableApp, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/resume`
    });
    expect(unavailable.statusCode, unavailable.body).toBe(200);
    expect(unavailable.json()).toEqual(unavailableResponse());

    expectStableError(
      await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/resume?thread_id=${threadId}`
      }),
      400,
      "validation_error",
      "query"
    );
    expectStableError(
      await injectHostDeckLoopback(app, {
        method: "GET",
        url: "/api/v1/sessions/session%20with%20spaces/resume"
      }),
      400,
      "validation_error",
      "params"
    );
    expectStableError(
      await injectHostDeckLoopback(app, {
        method: "HEAD",
        url: `/api/v1/sessions/${sessionId}/resume`
      }),
      405,
      "method_not_allowed"
    );
    expectStableError(
      await injectHostDeckLoopback(app, {
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/resume`
      }),
      405,
      "method_not_allowed"
    );
    expectStableError(
      await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/resume/`
      }),
      404,
      "route_not_found"
    );
    expectStableError(
      await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/Resume`
      }),
      404,
      "route_not_found"
    );
    expect(requested).toEqual([sessionId]);
  });

  it("authenticates before validation and reader access for paired credential states", async () => {
    let readCalls = 0;
    const app = createResumeApp(
      {
        read() {
          readCalls += 1;
          return availableResponse();
        }
      },
      {
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_resume_reader");
          }
          if (rawDeviceToken === writeToken) {
            return authenticatedDevice("write", "client_resume_writer");
          }
          if (rawDeviceToken === expiredToken) {
            throw new HostDeckAuthRepositoryError(
              "device_expired",
              "expired-auth-private-sentinel"
            );
          }
          if (rawDeviceToken === revokedToken) {
            throw new HostDeckAuthRepositoryError(
              "device_revoked",
              "revoked-auth-private-sentinel"
            );
          }
          if (rawDeviceToken === storageToken) {
            throw new Error("auth-storage-private-sentinel");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "unknown-auth-private-sentinel"
          );
        }
      }
    );
    await app.ready();

    expect(
      (
        await injectHostDeckLoopback(app, {
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/resume`
        })
      ).statusCode
    ).toBe(200);
    for (const token of [readToken, writeToken]) {
      const paired = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/resume`,
        headers: deviceCookie(token)
      });
      expect(paired.statusCode, paired.body).toBe(200);
    }
    expect(readCalls).toBe(3);

    for (const token of [expiredToken, revokedToken, "U".repeat(43)]) {
      const denied = await injectHostDeckLoopback(app, {
        method: "GET",
        url: "/api/v1/sessions/bad%20target/resume?thread_id=private",
        headers: deviceCookie(token)
      });
      expectStableError(denied, 401, "permission_denied");
      expect(denied.body).not.toMatch(/private|auth|cookie|token/iu);
    }
    const storage = await injectHostDeckLoopback(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/resume`,
      headers: deviceCookie(storageToken)
    });
    expectStableError(storage, 500, "storage_error");
    expect(storage.body).not.toContain("auth-storage-private-sentinel");

    const duplicate = await injectHostDeckLoopback(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/resume`,
      headers: {
        cookie: `${hostDeckDeviceCookieName}=${readToken}; ${hostDeckDeviceCookieName}=${readToken}`
      }
    });
    expectStableError(duplicate, 401, "permission_denied");
    expect(readCalls).toBe(3);
  });

  it("requires HostDeck pairing inside admitted Tailscale Serve context", async () => {
    let readCalls = 0;
    const remoteRequestAuthority =
      createHostDeckRemoteIngressRequestAuthorityPolicy();
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_remote_resume_reader");
          }
          if (rawDeviceToken === writeToken) {
            return authenticatedDevice("write", "client_remote_resume_writer");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "remote-auth-private-sentinel"
          );
        },
        now: () => new Date(createdAt)
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        createHostDeckResumeRouteRegistration({
          resume: {
            read() {
              readCalls += 1;
              return availableResponse();
            }
          }
        })
      ],
      remoteIngressRequestAuthority: remoteRequestAuthority,
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: remoteLocalOrigin,
        readRemoteAdmission: () =>
          remoteRequestAuthority.synchronize({
            admission: "open",
            external_origin: externalOrigin,
            generation: 7
          })
      })
    });
    apps.push(app);
    await app.ready();

    const identityOnly = await injectHostDeckLoopback(app, {
      method: "GET",
      url: "/api/v1/sessions/bad%20target/resume?thread_id=private",
      headers: remoteHeaders({ identity: true })
    });
    expectStableError(identityOnly, 401, "permission_denied");
    expect(readCalls).toBe(0);
    for (const forbidden of [
      "identity-does-not-authorize@example.test",
      "Identity Does Not Authorize",
      "remote-auth-private-sentinel",
      remoteSource,
      externalOrigin
    ]) {
      expect(identityOnly.body).not.toContain(forbidden);
    }

    for (const token of [readToken, writeToken]) {
      const paired = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/resume`,
        headers: remoteHeaders({ cookie: token, identity: true })
      });
      expect(paired.statusCode, paired.body).toBe(200);
      expect(paired.headers["cache-control"]).toBe("no-store");
    }
    expect(readCalls).toBe(2);
  });

  it("maps reader failures to bounded selected errors without leaking causes", async () => {
    const cases = [
      {
        code: "session_not_found" as const,
        retryable: false,
        status: 404,
        apiCode: "session_not_found"
      },
      {
        code: "stale_session" as const,
        retryable: false,
        status: 409,
        apiCode: "stale_session"
      },
      {
        code: "runtime_unavailable" as const,
        retryable: true,
        status: 503,
        apiCode: "runtime_unavailable"
      },
      {
        code: "runtime_unavailable" as const,
        retryable: false,
        status: 503,
        apiCode: "runtime_unavailable"
      },
      {
        code: "state_unavailable" as const,
        retryable: false,
        status: 500,
        apiCode: "storage_error"
      },
      {
        code: "unstable_state" as const,
        retryable: true,
        status: 503,
        apiCode: "runtime_unavailable"
      }
    ];
    for (const testCase of cases) {
      const app = createResumeApp({
        read() {
          throw new HostDeckResumeMetadataError(
            testCase.code,
            `${testCase.code}-private-sentinel`,
            testCase.retryable,
            { cause: new Error("reader-cause-private-sentinel") }
          );
        }
      });
      await app.ready();
      const response = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/resume`
      });
      expectStableError(
        response,
        testCase.status,
        testCase.apiCode,
        undefined,
        testCase.code === "unstable_state" ? true : testCase.retryable
      );
      expect(response.json()).toMatchObject({
        error: { session_id: sessionId }
      });
      expect(response.body).not.toMatch(/private-sentinel|reader-cause/iu);
    }
  });

  it("treats malformed, cross-target, and unexpected reader output as internal failures", async () => {
    const observations: HostDeckInternalErrorObservation[] = [];
    const candidates: Array<() => unknown> = [
      () => ({ ...availableResponse(), session_id: "sess_resume_route_other" }),
      () => ({ ...availableResponse(), command: "codex resume arbitrary" }),
      () => ({ ...availableResponse(), codex_thread_id: threadId }),
      () => {
        throw new Error("unexpected-reader-private-sentinel");
      }
    ];

    for (const candidate of candidates) {
      const app = createResumeApp(
        { read: candidate as HostDeckResumeMetadataReader["read"] },
        { observations }
      );
      await app.ready();
      const response = await injectHostDeckLoopback(app, {
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/resume`
      });
      expectStableError(response, 500, "internal_error");
      expect(response.body).not.toMatch(
        /arbitrary|codex_thread_id|private-sentinel|thread-resume/iu
      );
    }
    expect(observations).toHaveLength(candidates.length);
  });

  it("serves one bounded raw loopback response without executing or exposing private state", async () => {
    const port = await getAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    let readCalls = 0;
    const app = createResumeApp(
      {
        read() {
          readCalls += 1;
          return availableResponse();
        }
      },
      {
        trustPolicy: createHostDeckRequestTrustPolicy({
          allowedOrigin: origin
        })
      }
    );
    await app.listen({
      host: "127.0.0.1",
      port,
      listenTextResolver: () => ""
    });

    const response = await rawExchange(
      port,
      `GET /api/v1/sessions/${sessionId}/resume HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
    );
    expect(statusCode(response)).toBe(200);
    expect(response).toMatch(/cache-control: no-store/iu);
    expect(response).toContain(`"session_id":"${sessionId}"`);
    expect(response).toContain('"local_only":true');
    expect(response).toContain(`"executable":"codex"`);
    for (const forbidden of [
      "codex_thread_id",
      '"cwd"',
      "runtime_version",
      "binding_id",
      "raw_shell",
      "cookie",
      "token"
    ]) {
      expect(response).not.toContain(forbidden);
    }
    expect(readCalls).toBe(1);

    const head = await rawExchange(
      port,
      `HEAD /api/v1/sessions/${sessionId}/resume HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
    );
    expect(statusCode(head)).toBe(405);
    expect(head).not.toContain('"launch"');
    expect(readCalls).toBe(1);
  });
});

interface ResumeAppOptions {
  readonly authenticateDeviceToken?: HostDeckDeviceAuthenticationPort;
  readonly observations?: HostDeckInternalErrorObservation[];
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createResumeApp(
  resume: Pick<HostDeckResumeMetadataReader, "read">,
  options: ResumeAppOptions = {}
): HostDeckFastifyInstance {
  return createResumeAppFromRegistration(
    createHostDeckResumeRouteRegistration({ resume }),
    options
  );
}

function createResumeAppFromRegistration(
  registration: ReturnType<typeof createHostDeckResumeRouteRegistration>,
  options: ResumeAppOptions = {}
): HostDeckFastifyInstance {
  const app = createHostDeckFastifyApp({
    observeInternalError(observation) {
      options.observations?.push(observation);
    },
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken:
        options.authenticateDeviceToken ??
        (({ rawDeviceToken }) => {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_resume_reader");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Device authentication failed."
          );
        }),
      now: () => new Date(createdAt)
    }),
    requestTrustPolicy: options.trustPolicy ?? loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  apps.push(app);
  return app;
}

function availableResponse() {
  return selectedResumeMetadataResponseSchema.parse({
    session_id: sessionId,
    local_only: true,
    available: true,
    command: `codex resume --remote unix://${socketPath} ${threadId}`,
    launch: {
      executable: "codex",
      args: ["resume", "--remote", `unix://${socketPath}`, threadId]
    },
    unavailable_reason: null
  });
}

function unavailableResponse() {
  return selectedResumeMetadataResponseSchema.parse({
    session_id: sessionId,
    local_only: true,
    available: false,
    command: null,
    launch: null,
    unavailable_reason: "The selected Codex runtime is not available."
  });
}

function authenticatedDevice(permission: "read" | "write", deviceId: string) {
  return {
    trusted: true as const,
    readOnly: permission === "read",
    device: {
      id: deviceId,
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: createdAt,
      client_label: "Phone",
      permission,
      created_at: createdAt,
      last_used_at: createdAt,
      expires_at: null,
      revoked_at: null
    }
  };
}

function deviceCookie(rawDeviceToken: string): Readonly<Record<string, string>> {
  return { cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}` };
}

function remoteHeaders(options: {
  readonly cookie?: string;
  readonly identity?: boolean;
}): Record<string, string> {
  const authority = new URL(externalOrigin).host;
  const headers: Record<string, string> = {
    host: authority,
    "x-forwarded-for": remoteSource,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (options.cookie !== undefined) {
    headers.cookie = `${hostDeckDeviceCookieName}=${options.cookie}`;
  }
  if (options.identity) {
    headers["tailscale-headers-info"] = "https://tailscale.com/s/serve-headers";
    headers["tailscale-user-login"] =
      "identity-does-not-authorize@example.test";
    headers["tailscale-user-name"] = "Identity Does Not Authorize";
    headers["tailscale-user-profile-pic"] = "https://example.test/avatar";
  }
  return headers;
}

function expectStableError(
  response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>,
  status: number,
  code: string,
  field?: string,
  retryable = false
): void {
  const requestId = response.headers["x-request-id"];
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.json()).toMatchObject({
    error: {
      code,
      retryable,
      details: { request_id: requestId },
      ...(field === undefined ? {} : { field })
    }
  });
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Missing loopback probe address.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error === undefined ? resolve() : reject(error)
    );
  });
  return address.port;
}

function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () =>
      socket.end(request)
    );
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function statusCode(response: string): number {
  const match = /^HTTP\/1\.1 (\d{3}) /u.exec(response);
  if (match?.[1] === undefined) {
    throw new Error("Raw response has no status line.");
  }
  return Number(match[1]);
}
