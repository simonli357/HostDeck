import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type ResourceBudget,
  resourceBudgetSchema,
  type SelectedSessionListInput,
  type SelectedSessionListPage,
  type SelectedSessionReadItem,
  selectedSessionListPageSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import {
  createSelectedSessionReadRepository,
  HostDeckAuthRepositoryError,
  HostDeckSelectedSessionReadRepositoryError,
  openMigratedDatabase,
  type SelectedSessionReadRepository,
  type SelectedSessionReadRepositoryErrorCode
} from "@hostdeck/storage";
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
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import {
  createHostDeckSessionReadRouteRegistration,
  hostDeckSessionReadRouteRegistrationId
} from "./session-read-routes.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

const apps: HostDeckFastifyInstance[] = [];
const tempDirs: string[] = [];
const timestamp = "2026-07-16T12:00:00.000Z";
const updatedAt = "2026-07-16T12:01:00.000Z";
const now = new Date("2026-07-16T12:10:00.000Z");
const snapshot = "b".repeat(64);
const loopbackOrigin = hostDeckLoopbackTestOrigin;
const externalOrigin = "https://hostdeck-session-read.fixture-tailnet.ts.net";
const remoteLocalOrigin = "http://127.0.0.1:3777";
const remoteSource = "100.91.82.73";
const readToken = "R".repeat(43);
const writeToken = "W".repeat(43);
const invalidToken = "I".repeat(43);
const storageToken = "S".repeat(43);

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected session list/detail routes", () => {
  it("requires one exact immutable single-owner port and returns one immutable registration", () => {
    const sessionPort = portHarness().port;
    const registration = createHostDeckSessionReadRouteRegistration({ sessions: sessionPort });
    expect(registration).toMatchObject({
      id: hostDeckSessionReadRouteRegistrationId,
      surface: "api"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    expect(() => createHostDeckSessionReadRouteRegistration({ sessions: sessionPort })).toThrow(
      "already owns"
    );

    let reads = 0;
    const accessor = Object.defineProperty({}, "sessions", {
      enumerable: true,
      get() {
        reads += 1;
        return portHarness().port;
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { sessions: portHarness().port, extra: true },
      Object.assign(Object.create({ inherited: true }), { sessions: portHarness().port }),
      { sessions: { get() {}, list() {} } },
      { sessions: Object.freeze({ get() {} }) },
      accessor
    ]) {
      expect(() => createHostDeckSessionReadRouteRegistration(candidate as never)).toThrow(TypeError);
    }
    expect(reads).toBe(0);
  });

  it("returns exact frozen no-store list/detail payloads for every loopback authority mode", async () => {
    const port = portHarness({
      items: [readItem("sess_access_01")]
    });
    const harness = createLoopbackApp(port.port);
    const payloads: unknown[] = [];
    harness.app.addHook("preSerialization", async (request, reply, payload) => {
      if (reply.statusCode === 200 && request.url.startsWith("/api/v1/sessions")) {
        payloads.push(payload);
      }
      return payload;
    });
    await harness.app.ready();

    for (const [headers, mode] of [
      [{}, "loopback_read"],
      [localAdminHeaders(), "local_admin"],
      [deviceCookie(readToken), "paired_read"],
      [deviceCookie(writeToken), "paired_write"]
    ] as const) {
      const response = await injectHostDeckLoopback(harness.app, {
        headers,
        method: "GET",
        url: "/api/v1/sessions?limit=1"
      });
      expect(response.statusCode, response.body).toBe(200);
      expectNoStore(response);
      expect(response.json()).toMatchObject({
        access: { mode, network_mode: "loopback", transport: "http" },
        has_more: false,
        next_cursor: null,
        sessions: [{ session: { id: "sess_access_01" } }]
      });
      expect(Object.keys(response.json()).sort()).toEqual([
        "access",
        "has_more",
        "next_cursor",
        "sessions"
      ]);
    }

    const detail = await injectHostDeckLoopback(harness.app, {
      headers: deviceCookie(readToken),
      method: "GET",
      url: "/api/v1/sessions/sess_access_01"
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      access: { mode: "paired_read", network_mode: "loopback", transport: "http" },
      session: { session: { id: "sess_access_01" } }
    });
    expect(detail.body).not.toMatch(
      /events|pending_approvals|device_id|cookie|csrf|write_eligibility|source_key|ingress_generation/iu
    );
    expect(port.listCalls()).toBe(4);
    expect(port.getCalls()).toBe(1);
    expect(payloads).toHaveLength(5);
    for (const payload of payloads) expectDeepFrozenData(payload);
    expect(harness.observations).toEqual([]);
  });

  it("returns paired read/write access over admitted remote HTTPS and rejects unpaired identity", async () => {
    const port = portHarness({ items: [readItem("sess_remote_01")] });
    const harness = createRemoteApp(port.port, () => 7);
    await harness.app.ready();

    for (const [token, mode] of [
      [readToken, "paired_read"],
      [writeToken, "paired_write"]
    ] as const) {
      const response = await injectHostDeckLoopback(harness.app, {
        headers: remoteHeaders({ cookie: token, identity: true }),
        method: "GET",
        url: "/api/v1/sessions?limit=1"
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().access).toEqual({
        mode,
        network_mode: "remote",
        transport: "https"
      });
    }

    const unpaired = await injectHostDeckLoopback(harness.app, {
      headers: remoteHeaders({ identity: true }),
      method: "GET",
      url: "/api/v1/sessions?limit=1"
    });
    expectStableError(unpaired, 401, "permission_denied");
    expect(unpaired.body).not.toContain("sess_remote_01");
    expect(port.listCalls()).toBe(2);
  });

  it("authenticates before malformed query/params and before every repository call", async () => {
    const port = portHarness({ items: [readItem("sess_auth_01")] });
    const harness = createLoopbackApp(port.port);
    await harness.app.ready();

    for (const [token, expectedStatus, expectedCode] of [
      [invalidToken, 401, "permission_denied"],
      [storageToken, 500, "storage_error"]
    ] as const) {
      const response = await injectHostDeckLoopback(harness.app, {
        headers: deviceCookie(token),
        method: "GET",
        url: "/api/v1/sessions?limit=00&private=sentinel"
      });
      expectStableError(response, expectedStatus, expectedCode);
      expect(response.body).not.toMatch(/sess_auth_01|sentinel/iu);
    }
    const invalidDetail = await injectHostDeckLoopback(harness.app, {
      headers: deviceCookie(invalidToken),
      method: "GET",
      url: "/api/v1/sessions/not-a-session?private=sentinel"
    });
    expectStableError(invalidDetail, 401, "permission_denied");
    expect(port.listCalls()).toBe(0);
    expect(port.getCalls()).toBe(0);
    expect(harness.authCalls()).toBe(3);
  });

  it("rejects noncanonical query, body, params, method, and path without repository access", async () => {
    const port = portHarness({ items: [readItem("sess_http_01")] });
    const harness = createLoopbackApp(port.port);
    await harness.app.ready();

    for (const url of [
      "/api/v1/sessions?limit=0",
      "/api/v1/sessions?limit=01",
      "/api/v1/sessions?limit=1&limit=2",
      "/api/v1/sessions?unknown=1",
      "/api/v1/sessions?cursor=invalid",
      "/api/v1/sessions/sess_http_01?unknown=1",
      "/api/v1/sessions/not-valid"
    ]) {
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url }),
        400,
        "validation_error"
      );
    }

    const body = await injectHostDeckLoopback(harness.app, {
      method: "GET",
      payload: { private: true },
      url: "/api/v1/sessions"
    });
    expectStableError(body, 400, "validation_error");
    expect(body.json().error.field).toBe("body");

    for (const [method, url, status, code] of [
      ["HEAD", "/api/v1/sessions", 405, "method_not_allowed"],
      ["POST", "/api/v1/sessions/sess_http_01", 405, "method_not_allowed"],
      ["GET", "/api/v1/sessions/", 404, "route_not_found"],
      ["GET", "/api/v1/sessions/sess_http_01/", 404, "route_not_found"]
    ] as const) {
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method, url }),
        status,
        code
      );
    }
    expect(port.listCalls()).toBe(0);
    expect(port.getCalls()).toBe(0);
  });

  it("maps missing, archived, recovery, stale cursor, overload, and storage failures exactly", async () => {
    const cases: Array<{
      readonly code: SelectedSessionReadRepositoryErrorCode | "missing";
      readonly expectedCode: string;
      readonly status: number;
      readonly target: "detail" | "list";
    }> = [
      { code: "missing", expectedCode: "session_not_found", status: 404, target: "detail" },
      { code: "session_archived", expectedCode: "stale_session", status: 409, target: "detail" },
      {
        code: "session_recovery_required",
        expectedCode: "stale_session",
        status: 409,
        target: "detail"
      },
      { code: "session_list_changed", expectedCode: "stale_session", status: 409, target: "list" },
      { code: "session_list_overflow", expectedCode: "service_overloaded", status: 503, target: "list" },
      { code: "invalid_state", expectedCode: "storage_error", status: 500, target: "list" },
      { code: "read_failed", expectedCode: "storage_error", status: 500, target: "detail" }
    ];

    for (const testCase of cases) {
      const port = failingPort(testCase.target, testCase.code);
      const harness = createLoopbackApp(port);
      await harness.app.ready();
      const response = await injectHostDeckLoopback(harness.app, {
        method: "GET",
        url:
          testCase.target === "list"
            ? "/api/v1/sessions?limit=1"
            : "/api/v1/sessions/sess_error_01"
      });
      expectStableError(response, testCase.status, testCase.expectedCode);
      expectNoStore(response);
      expect(response.body).not.toMatch(/repository-private|SELECT|selected_sessions/iu);
      await harness.app.close();
      apps.splice(apps.indexOf(harness.app), 1);
    }
  });

  it("rejects mutable, accessor, extra, wrong-identity, and query-incoherent port results atomically", async () => {
    let getterReads = 0;
    const validItem = readItem("sess_hostile_01");
    const validPage = page([validItem]);
    const accessorPage = Object.freeze(
      Object.defineProperty(
        {
          has_more: false,
          next_after: null,
          order_snapshot: snapshot
        },
        "sessions",
        {
          enumerable: true,
          get() {
            getterReads += 1;
            return [validItem];
          }
        }
      )
    );
    const mismatchedQueryPage = page([
      readItem("sess_hostile_01"),
      readItem("sess_hostile_02")
    ]);
    const cases = [
      { get: validItem, list: { ...validPage }, url: "/api/v1/sessions?limit=1" },
      { get: validItem, list: accessorPage, url: "/api/v1/sessions?limit=1" },
      {
        get: validItem,
        list: Object.freeze({ ...validPage, private: "sentinel" }),
        url: "/api/v1/sessions?limit=1"
      },
      {
        get: readItem("sess_hostile_other"),
        list: validPage,
        url: "/api/v1/sessions/sess_hostile_01"
      },
      {
        get: validItem,
        list: mismatchedQueryPage,
        url: "/api/v1/sessions?limit=1"
      }
    ];

    for (const candidate of cases) {
      const port = Object.freeze({
        get: () => candidate.get,
        list: () => candidate.list as never
      });
      const harness = createLoopbackApp(port);
      await harness.app.ready();
      const response = await injectHostDeckLoopback(harness.app, { method: "GET", url: candidate.url });
      expectStableError(response, 500, "internal_error");
      expect(response.body).not.toMatch(/sentinel|sess_hostile_other|accessor/iu);
      expect(harness.observations).toHaveLength(1);
      expect(harness.observations[0]?.error).toMatchObject({
        name: "HostDeckSessionReadContractError",
        message: "Selected session-read route contract failed."
      });
      await harness.app.close();
      apps.splice(apps.indexOf(harness.app), 1);
    }
    expect(getterReads).toBe(0);
  });

  it("enforces the configured response ceiling before publishing a partial success", async () => {
    const oversized = readItem("sess_bytes_01", { cwd: `/${"a".repeat(4_000)}` });
    const port = portHarness({ items: [oversized] });
    const budget = Object.freeze(
      resourceBudgetSchema.parse({
        ...defaultResourceBudget,
        http_response_max_bytes: 1_024,
        browser_response_max_bytes: 1_024,
        cli_response_max_bytes: 1_024
      })
    );
    const harness = createLoopbackApp(port.port, budget);
    await harness.app.ready();

    for (const url of ["/api/v1/sessions?limit=1", "/api/v1/sessions/sess_bytes_01"]) {
      const response = await injectHostDeckLoopback(harness.app, { method: "GET", url });
      expectStableError(response, 503, "service_overloaded");
      expect(response.body).not.toMatch(/sess_bytes_01|aaaaa/iu);
    }
  });

  it("suppresses both success and not-found bodies when remote ingress closes before onSend", async () => {
    for (const target of ["success", "missing"] as const) {
      let generation = 7;
      const port = portHarness({ items: [readItem("sess_revalidate_01")] });
      const harness = createRemoteApp(port.port, () => generation);
      let invalidated = false;
      harness.app.addHook("preSerialization", async (request, _reply, payload) => {
        if (!invalidated && request.url.includes("sess_revalidate")) {
          generation = 8;
          invalidated = true;
        }
        return payload;
      });
      await harness.app.ready();
      const response = await injectHostDeckLoopback(harness.app, {
        headers: remoteHeaders({ cookie: readToken, identity: true }),
        method: "GET",
        url:
          target === "success"
            ? "/api/v1/sessions/sess_revalidate_01"
            : "/api/v1/sessions/sess_revalidate_missing"
      });
      expectStableError(response, 403, "invalid_origin");
      expect(response.body).not.toMatch(/sess_revalidate|Bounded public summary/iu);
      expect(invalidated).toBe(true);
      await harness.app.close();
      apps.splice(apps.indexOf(harness.app), 1);
    }
  });

  it("composes the exact routes with the real migrated SQLite repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-session-route-"));
    tempDirs.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.db"), { now: () => now });
    try {
      seedRealSession(open.db, "sess_sqlite_01");
      const repository = createSelectedSessionReadRepository(open.db);
      const harness = createLoopbackApp(repository);
      await harness.app.ready();

      const list = await injectHostDeckLoopback(harness.app, { method: "GET", url: "/api/v1/sessions?limit=1" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().sessions).toMatchObject([{ session: { id: "sess_sqlite_01" } }]);
      const detail = await injectHostDeckLoopback(harness.app, {
        method: "GET",
        url: "/api/v1/sessions/sess_sqlite_01"
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().session).toMatchObject({
        event_window: { state: "empty", retained_event_count: 0 },
        session: { id: "sess_sqlite_01", codex_thread_id: "thread-sess_sqlite_01" }
      });
      expect(harness.observations).toEqual([]);
    } finally {
      open.db.close();
    }
  });
});

interface PortHarness {
  readonly getCalls: () => number;
  readonly listCalls: () => number;
  readonly port: SelectedSessionReadRepository;
}

function portHarness(options: { readonly items?: readonly SelectedSessionReadItem[] } = {}): PortHarness {
  const items = options.items ?? [];
  let getCalls = 0;
  let listCalls = 0;
  const port: SelectedSessionReadRepository = Object.freeze({
    get(sessionId: string) {
      getCalls += 1;
      return items.find((item) => item.session.id === sessionId) ?? null;
    },
    list(_input: SelectedSessionListInput) {
      listCalls += 1;
      return page(items);
    }
  });
  return { getCalls: () => getCalls, listCalls: () => listCalls, port };
}

function failingPort(
  target: "detail" | "list",
  code: SelectedSessionReadRepositoryErrorCode | "missing"
): SelectedSessionReadRepository {
  return Object.freeze({
    get() {
      if (target !== "detail" || code === "missing") return null;
      throw new HostDeckSelectedSessionReadRepositoryError(code, "repository-private-sentinel");
    },
    list() {
      if (target !== "list") return page([]);
      if (code === "missing") throw new Error("repository-private-sentinel");
      throw new HostDeckSelectedSessionReadRepositoryError(code, "repository-private-sentinel");
    }
  });
}

function page(items: readonly SelectedSessionReadItem[]): SelectedSessionListPage {
  const sessions = [...items].sort((left, right) =>
    left.session.id < right.session.id ? -1 : left.session.id === right.session.id ? 0 : 1
  );
  return selectedSessionListPageSchema.parse({
    has_more: false,
    next_after: null,
    order_snapshot: snapshot,
    sessions
  });
}

function readItem(
  id: string,
  options: { readonly cwd?: string } = {}
): SelectedSessionReadItem {
  return selectedSessionReadItemSchema.parse({
    event_window: {
      boundary_cursor: null,
      earliest_retained_cursor: null,
      retained_event_count: 0,
      state: "empty"
    },
    session: {
      archived_at: null,
      attention: "none",
      branch: "main",
      codex_thread_id: `thread-${id}`,
      created_at: timestamp,
      cwd: options.cwd ?? "/workspace/hostdeck",
      freshness: "current",
      freshness_reason: null,
      goal: { objective: "Complete the selected task.", state: "active" },
      id,
      last_activity_at: timestamp,
      last_event_cursor: null,
      model: "gpt-5.5-codex",
      name: id.slice(5),
      recent_summary: "Bounded public summary.",
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      session_state: "active",
      settings: {
        collaboration_mode: "default",
        observed_at: timestamp,
        reasoning_effort: "high",
        runtime_model: "gpt-5.5-codex"
      },
      turn_state: "idle",
      updated_at: updatedAt
    }
  });
}

function createLoopbackApp(
  sessions: SelectedSessionReadRepository,
  resourceBudget: ResourceBudget = defaultResourceBudget
): {
  readonly app: HostDeckFastifyInstance;
  readonly authCalls: () => number;
  readonly observations: HostDeckInternalErrorObservation[];
} {
  let authCalls = 0;
  const observations: HostDeckInternalErrorObservation[] = [];
  const app = createHostDeckFastifyApp({
    observeInternalError: (observation) => observations.push(observation),
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken({ rawDeviceToken }) {
        authCalls += 1;
        return authenticateToken(rawDeviceToken);
      },
      now: () => now
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigin: loopbackOrigin
    }),
    resourceBudget,
    routePlugins: [createHostDeckSessionReadRouteRegistration({ sessions })]
  });
  apps.push(app);
  return { app, authCalls: () => authCalls, observations };
}

function createRemoteApp(
  sessions: SelectedSessionReadRepository,
  generation: () => number
): {
  readonly app: HostDeckFastifyInstance;
  readonly observations: HostDeckInternalErrorObservation[];
} {
  const observations: HostDeckInternalErrorObservation[] = [];
  const remoteRequestAuthority =
    createHostDeckRemoteIngressRequestAuthorityPolicy();
  const app = createHostDeckTailscaleServeFastifyApp({
    observeInternalError: (observation) => observations.push(observation),
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: ({ rawDeviceToken }) => authenticateToken(rawDeviceToken),
      now: () => now
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [createHostDeckSessionReadRouteRegistration({ sessions })],
    remoteIngressRequestAuthority: remoteRequestAuthority,
    tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
      localOrigin: remoteLocalOrigin,
      readRemoteAdmission: () =>
        remoteRequestAuthority.synchronize({
          admission: "open",
          external_origin: externalOrigin,
          generation: generation()
        })
    })
  });
  apps.push(app);
  return { app, observations };
}

function authenticateToken(rawDeviceToken: string) {
  if (rawDeviceToken === readToken) return authenticatedDevice("read", "client_session_reader");
  if (rawDeviceToken === writeToken) return authenticatedDevice("write", "client_session_writer");
  if (rawDeviceToken === storageToken) throw new Error("auth-storage-private-sentinel");
  throw new HostDeckAuthRepositoryError("device_not_found", "auth-missing-private-sentinel");
}

function authenticatedDevice(permission: "read" | "write", id: string) {
  return {
    device: {
      client_label: "Session Phone",
      created_at: timestamp,
      csrf_generation: 1,
      csrf_rotated_at: timestamp,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      expires_at: null,
      id,
      last_used_at: now.toISOString(),
      permission,
      revoked_at: null,
      token_hash: `sha256:${"a".repeat(64)}`
    },
    readOnly: permission === "read",
    trusted: true as const
  };
}

function deviceCookie(rawDeviceToken: string): Readonly<Record<string, string>> {
  return { cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}` };
}

function localAdminHeaders(): Readonly<Record<string, string>> {
  return {
    [hostDeckLocalAdminRequestHeaderName]: hostDeckLocalAdminRequestHeaderValue
  };
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
    headers["tailscale-user-login"] = "identity-does-not-authorize@example.test";
    headers["tailscale-user-name"] = "Identity Does Not Authorize";
    headers["tailscale-user-profile-pic"] = "https://example.test/avatar";
  }
  return headers;
}

function seedRealSession(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  id: string
): void {
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, '/workspace/hostdeck', 'codex_app_server', '0.144.0', 'selected', ?, ?, NULL)
    `
  ).run(id, id.slice(5), `thread-${id}`, timestamp, updatedAt);
  db.prepare(
    `
      INSERT INTO selected_session_projections (
        session_id, session_state, turn_state, attention, freshness, freshness_reason,
        updated_at, last_activity_at, branch, model, settings_json, goal_json,
        recent_summary, last_event_cursor, retained_event_count, retained_event_bytes,
        earliest_retained_cursor, retention_boundary_cursor
      ) VALUES (?, 'active', 'idle', 'none', 'current', NULL, ?, ?, 'main', 'gpt-5.5-codex', ?, ?, ?, NULL, 0, 0, NULL, NULL)
    `
  ).run(
    id,
    updatedAt,
    timestamp,
    JSON.stringify({
      collaboration_mode: "default",
      observed_at: timestamp,
      reasoning_effort: "high",
      runtime_model: "gpt-5.5-codex"
    }),
    JSON.stringify({ objective: "Complete the selected task.", state: "active" }),
    "Bounded public summary."
  );
}

function expectNoStore(
  response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>
): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers.pragma).toBe("no-cache");
}

function expectStableError(
  response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>,
  status: number,
  code: string
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.json()).toMatchObject({
    error: {
      code,
      details: { request_id: response.headers["x-request-id"] },
      retryable: false
    }
  });
}

function expectDeepFrozenData(candidate: unknown, seen = new Set<object>()): void {
  if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
  seen.add(candidate);
  expect(Object.isFrozen(candidate)).toBe(true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
    if (!("value" in descriptor)) throw new TypeError("Public session payload contains an accessor.");
    expectDeepFrozenData(descriptor.value, seen);
  }
}
