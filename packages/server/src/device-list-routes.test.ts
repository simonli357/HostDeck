import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  encodeSelectedDeviceListCursor,
  type SelectedDeviceListInput
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createDeviceListingRepository,
  createDeviceRevocationRepository,
  HostDeckAuthRepositoryError,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckDeviceListRouteRegistration,
  type HostDeckDeviceListPort,
  hostDeckDeviceListRouteRegistrationId
} from "./device-list-routes.js";
import { createHostDeckFastifyApp } from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckDeviceAuthenticationPort,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  type HostDeckRequestTrustPolicy
} from "./fastify-request-trust.js";

const tempDirs: string[] = [];
const createdAt = new Date("2026-07-12T12:00:00.000Z");
const usedAt = new Date("2026-07-12T12:01:00.000Z");
const revokedAt = new Date("2026-07-12T12:02:00.000Z");
const readToken = "A".repeat(43);
const writeToken = "W".repeat(43);
const expiredToken = "E".repeat(43);
const revokedToken = "R".repeat(43);
const unknownToken = "U".repeat(43);
const conflictToken = "C".repeat(43);
const storageToken = "S".repeat(43);
const csrfToken = "F".repeat(43);
const loopbackOrigin = "http://localhost";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: [loopbackOrigin],
  mode: "loopback",
  transport: "http"
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected paired-device list route", () => {
  it("requires one exact accessor-free input and snapshots one detached list port", async () => {
    let observedThis: unknown = "not-called";
    const list = function list(this: void, input: SelectedDeviceListInput) {
      observedThis = this;
      expect(input).toEqual({ limit: 100, afterDeviceId: null });
      return frozenPage(["client_factory"]);
    };
    const registration = createHostDeckDeviceListRouteRegistration({ devices: { list } });
    expect(registration.id).toBe(hostDeckDeviceListRouteRegistrationId);
    expect(registration.surface).toBe("api");
    expect(Object.isFrozen(registration)).toBe(true);

    const mutablePort = { list };
    const snapshotted = createHostDeckDeviceListRouteRegistration({ devices: mutablePort });
    mutablePort.list = () => {
      throw new Error("mutated-port-private-sentinel");
    };
    const app = createAppFromRegistration(snapshotted);
    await app.ready();
    try {
      const response = await injectPaired(app, {
        method: "GET",
        url: "/api/v1/access/devices"
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(observedThis).toBeUndefined();
    } finally {
      await app.close();
    }

    const nullPort = Object.assign(Object.create(null) as Record<string, unknown>, { list });
    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      devices: nullPort
    });
    expect(() => createHostDeckDeviceListRouteRegistration(nullInput as never)).not.toThrow();

    let accessorCalls = 0;
    const inputAccessor = Object.defineProperty({}, "devices", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("route-input-private-sentinel");
      }
    });
    const portAccessor = Object.defineProperty({}, "list", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("route-port-private-sentinel");
      }
    });
    const hostileProxy = new Proxy(
      { devices: { list } },
      {
        ownKeys() {
          throw new Error("route-proxy-private-sentinel");
        }
      }
    );
    for (const candidate of [
      null,
      [],
      {},
      { devices: { list }, extra: true },
      Object.assign(Object.create({ inherited: true }), { devices: { list } }),
      { devices: null },
      { devices: {} },
      { devices: { list, extra: true } },
      { devices: Object.assign(Object.create({ inherited: true }), { list }) },
      { devices: { list: null } },
      inputAccessor,
      { devices: portAccessor },
      hostileProxy
    ]) {
      expect(() => createHostDeckDeviceListRouteRegistration(candidate as never)).toThrow();
    }
    expect(accessorCalls).toBe(0);
  });

  it("binds the exact route, canonical query, strict response, cache policy, and method surface", async () => {
    const calls: SelectedDeviceListInput[] = [];
    const port: HostDeckDeviceListPort = {
      list(input) {
        calls.push(input);
        return input.afterDeviceId === null
          ? frozenPage(["client_alpha"])
          : frozenPage(["client_bravo"]);
      }
    };
    const app = createDeviceListApp(port);
    await app.ready();
    try {
      const first = await injectPaired(app, {
        method: "GET",
        url: "/api/v1/access/devices"
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.headers["content-type"]).toContain("application/json");
      expect(first.json()).toEqual({
        devices: [apiDevice("client_alpha")],
        next_cursor: null,
        has_more: false
      });
      expect(calls[0]).toEqual({ limit: 100, afterDeviceId: null });
      expect(Object.isFrozen(calls[0])).toBe(true);

      const cursor = encodeSelectedDeviceListCursor("client_alpha");
      const second = await injectPaired(app, {
        method: "GET",
        url: `/api/v1/access/devices?limit=1&cursor=${cursor}`
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual({
        devices: [apiDevice("client_bravo")],
        next_cursor: null,
        has_more: false
      });
      expect(calls[1]).toEqual({ limit: 1, afterDeviceId: "client_alpha" });

      for (const url of [
        "/api/v1/access/devices?limit=0",
        "/api/v1/access/devices?limit=01",
        "/api/v1/access/devices?limit=101",
        "/api/v1/access/devices?limit=1&limit=2",
        `/api/v1/access/devices?cursor=${cursor}&cursor=${cursor}`,
        "/api/v1/access/devices?cursor=client_alpha",
        "/api/v1/access/devices?offset=0"
      ]) {
        const response = await injectPaired(app, { method: "GET", url });
        expectStableError(response, 400, "validation_error", "query");
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(calls).toHaveLength(2);

      expectStableError(
        await injectPaired(app, { method: "POST", url: "/api/v1/access/devices" }),
        405,
        "method_not_allowed"
      );
      const head = await injectPaired(app, {
        method: "HEAD",
        url: "/api/v1/access/devices"
      });
      expectStableError(head, 405, "method_not_allowed");
      expect(head.headers.allow).toBe("GET");
      expectStableError(
        await injectPaired(app, { method: "GET", url: "/api/v1/access/devices/" }),
        404,
        "route_not_found"
      );
      expectStableError(
        await injectPaired(app, { method: "GET", url: "/api/v1/access/Devices" }),
        404,
        "route_not_found"
      );
    } finally {
      await app.close();
    }
  });

  it("admits paired read/write without elevating safe loopback GETs and rejects every other credential state before listing", async () => {
    let listCalls = 0;
    let authCalls = 0;
    const app = createDeviceListApp(
      {
        list() {
          listCalls += 1;
          return frozenPage([]);
        }
      },
      {
        authenticateDeviceToken({ rawDeviceToken }) {
          authCalls += 1;
          if (rawDeviceToken === readToken) return authenticatedResult("read", "client_read");
          if (rawDeviceToken === writeToken) return authenticatedResult("write", "client_write");
          if (rawDeviceToken === expiredToken) {
            throw new HostDeckAuthRepositoryError("device_expired", "private expired detail");
          }
          if (rawDeviceToken === revokedToken) {
            throw new HostDeckAuthRepositoryError("device_revoked", "private revoked detail");
          }
          if (rawDeviceToken === unknownToken) {
            throw new HostDeckAuthRepositoryError("device_not_found", "private unknown detail");
          }
          if (rawDeviceToken === conflictToken) {
            throw new HostDeckAuthRepositoryError("authentication_conflict", "private conflict detail");
          }
          if (rawDeviceToken === storageToken) throw new Error("auth-storage-private-sentinel");
          throw new HostDeckAuthRepositoryError("invalid_secret", "private invalid detail");
        }
      }
    );
    await app.ready();
    try {
      const safeLoopback = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices"
      });
      expectStableError(safeLoopback, 401, "permission_denied");
      const read = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices",
        headers: deviceCookie(readToken)
      });
      expect(read.statusCode, read.body).toBe(200);
      const write = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices",
        headers: deviceCookie(writeToken)
      });
      expect(write.statusCode, write.body).toBe(200);
      expect(listCalls).toBe(2);

      const rejections = [
        await app.inject({
          method: "GET",
          url: "/api/v1/access/devices",
          headers: { origin: loopbackOrigin }
        }),
        await app.inject({
          method: "GET",
          url: "/api/v1/access/devices",
          headers: { cookie: "other=value" }
        }),
        await app.inject({
          method: "GET",
          url: "/api/v1/access/devices",
          headers: { cookie: `${hostDeckDeviceCookieName}=short` }
        }),
        await app.inject({
          method: "GET",
          url: "/api/v1/access/devices",
          headers: {
            cookie: `${hostDeckDeviceCookieName}=${readToken}; ${hostDeckDeviceCookieName}=${readToken}`
          }
        }),
        await app.inject({
          method: "GET",
          url: "/api/v1/access/devices",
          headers: deviceCookie(expiredToken)
        }),
        await app.inject({
          method: "GET",
          url: "/api/v1/access/devices",
          headers: deviceCookie(revokedToken)
        }),
        await app.inject({
          method: "GET",
          url: "/api/v1/access/devices",
          headers: deviceCookie(unknownToken)
        })
      ];
      for (const response of rejections) {
        expectStableError(response, 401, "permission_denied");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toMatch(/private|token|cookie/iu);
      }

      const conflict = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices",
        headers: deviceCookie(conflictToken)
      });
      expectStableError(conflict, 409, "operation_conflict");
      const storage = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices",
        headers: deviceCookie(storageToken)
      });
      expectStableError(storage, 500, "storage_error");
      expect(storage.body).not.toContain("auth-storage-private-sentinel");

      const unpairedMalformed = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices?limit=0",
        headers: { origin: loopbackOrigin }
      });
      expectStableError(unpairedMalformed, 401, "permission_denied");
      const pairedMalformed = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices?limit=0",
        headers: deviceCookie(readToken)
      });
      expectStableError(pairedMalformed, 400, "validation_error", "query");
      expect(listCalls).toBe(2);
      expect(authCalls).toBe(8);
    } finally {
      await app.close();
    }
  });

  it("maps storage failures and impossible repository errors without causes, details, retries, or partial data", async () => {
    const sentinel = "device-list-storage-private-sentinel";
    const cases = [
      {
        error: new HostDeckAuthRepositoryError("invalid_auth_device", sentinel),
        code: "storage_error",
        observed: false
      },
      {
        error: new HostDeckAuthRepositoryError("device_list_failed", sentinel),
        code: "storage_error",
        observed: false
      },
      { error: new Error(sentinel), code: "storage_error", observed: false },
      {
        error: new HostDeckAuthRepositoryError("invalid_device_list", sentinel),
        code: "internal_error",
        observed: true
      },
      {
        error: new HostDeckAuthRepositoryError("read_only", sentinel),
        code: "internal_error",
        observed: true
      }
    ] as const;

    for (const testCase of cases) {
      const observations: HostDeckInternalErrorObservation[] = [];
      const app = createDeviceListApp(
        {
          list() {
            throw testCase.error;
          }
        },
        { observations }
      );
      await app.ready();
      try {
        const response = await injectPaired(app, {
          method: "GET",
          url: "/api/v1/access/devices"
        });
        expectStableError(response, 500, testCase.code);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toContain(sentinel);
        expect(response.body).not.toContain("devices");
        expect(observations).toHaveLength(testCase.observed ? 1 : 0);
        if (testCase.observed) {
          expect(observations[0]?.error).toMatchObject({
            name: "HostDeckDeviceListContractError",
            message: "Selected device-list route contract failed."
          });
          expect(String(observations[0]?.error)).not.toContain(sentinel);
        }
      } finally {
        await app.close();
      }
    }
  });

  it("rejects hostile, mutable, asynchronous, over-limit, and request-incoherent returned pages before reading accessors", async () => {
    const sentinel = "device-list-result-private-sentinel";
    let accessorCalls = 0;
    const accessorItem = Object.freeze(
      Object.defineProperty(
        {
          clientLabel: "Phone",
          permission: "read",
          createdAt: createdAt.toISOString(),
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null
        },
        "deviceId",
        {
          enumerable: true,
          get() {
            accessorCalls += 1;
            throw new Error(sentinel);
          }
        }
      )
    );
    const accessorItems = [accessorItem];
    Object.freeze(accessorItems);
    const accessorPage = Object.freeze({
      devices: accessorItems,
      nextAfterDeviceId: null,
      hasMore: false
    });
    const accessorArray = [frozenDevice("client_accessor_array")];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error(sentinel);
      }
    });
    Object.freeze(accessorArray);
    const targetPage = frozenPage(["client_proxy"]);
    const proxyPage = new Proxy(targetPage, {
      ownKeys() {
        throw new Error(sentinel);
      }
    });
    const overLimitItems = Array.from({ length: 101 }, (_, index) =>
      frozenDevice(`client_over_${index.toString().padStart(3, "0")}`)
    );
    Object.freeze(overLimitItems);

    const cases: readonly { readonly value: unknown; readonly url?: string }[] = [
      { value: { devices: [], nextAfterDeviceId: null, hasMore: false } },
      { value: Promise.resolve(frozenPage([])) },
      { value: Object.freeze({ ...frozenPage([]), extra: sentinel }) },
      { value: frozenPage(["client_b", "client_a"]) },
      {
        value: frozenPage(["client_before"]),
        url: `/api/v1/access/devices?cursor=${encodeSelectedDeviceListCursor("client_cursor")}`
      },
      { value: frozenPage(["client_one"], true), url: "/api/v1/access/devices?limit=2" },
      { value: accessorPage },
      {
        value: Object.freeze({
          devices: accessorArray,
          nextAfterDeviceId: null,
          hasMore: false
        })
      },
      { value: proxyPage },
      {
        value: Object.freeze({
          devices: overLimitItems,
          nextAfterDeviceId: null,
          hasMore: false
        })
      }
    ];

    for (const testCase of cases) {
      const observations: HostDeckInternalErrorObservation[] = [];
      const app = createDeviceListApp({ list: () => testCase.value }, { observations });
      await app.ready();
      try {
        const response = await injectPaired(app, {
          method: "GET",
          url: testCase.url ?? "/api/v1/access/devices"
        });
        expectStableError(response, 500, "internal_error");
        expect(response.body).not.toContain(sentinel);
        expect(response.body).not.toContain("client_");
        expect(observations).toHaveLength(1);
        expect(String(observations[0]?.error)).toBe(
          "HostDeckDeviceListContractError: Selected device-list route contract failed."
        );
      } finally {
        await app.close();
      }
    }
    expect(accessorCalls).toBe(0);
  });

  it("traverses 250 real SQLite devices through bounded HTTP pages, deleted cursors, query-only mode, and reopen", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: () => createdAt });
    const auth = createAuthDeviceRepository(open.db);
    const expectedIds = Array.from(
      { length: 250 },
      (_, index) => `client_bulk_${index.toString().padStart(3, "0")}`
    );
    open.db.transaction(() => {
      for (let index = expectedIds.length - 1; index >= 0; index -= 1) {
        const id = expectedIds[index];
        if (id === undefined) throw new Error("Missing fixture id.");
        createStoredDevice(auth, id, fixtureToken("D", index), fixtureToken("F", index));
      }
    })();

    const app = createDeviceListApp(createDeviceListingRepository(open.db));
    await app.ready();
    let firstCursor: string | null = null;
    try {
      const observedIds: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | null = null;
      do {
        const response = await injectPaired(app, {
          method: "GET",
          url:
            cursor === null
              ? "/api/v1/access/devices"
              : `/api/v1/access/devices?limit=100&cursor=${cursor}`
        });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json() as {
          devices: { device_id: string }[];
          next_cursor: string | null;
          has_more: boolean;
        };
        pageSizes.push(body.devices.length);
        observedIds.push(...body.devices.map((device) => device.device_id));
        if (firstCursor === null) firstCursor = body.next_cursor;
        cursor = body.next_cursor;
        if (!body.has_more) expect(cursor).toBeNull();
      } while (cursor !== null);

      expect(pageSizes).toEqual([100, 100, 50]);
      expect(observedIds).toEqual(expectedIds);
      expect(new Set(observedIds).size).toBe(250);
      expect(firstCursor).toBe(encodeSelectedDeviceListCursor("client_bulk_099"));

      const exactTerminal = await injectPaired(app, {
        method: "GET",
        url: `/api/v1/access/devices?limit=50&cursor=${encodeSelectedDeviceListCursor("client_bulk_199")}`
      });
      expect(exactTerminal.statusCode, exactTerminal.body).toBe(200);
      expect(exactTerminal.json()).toMatchObject({
        devices: Array.from({ length: 50 }, (_, index) => ({
          device_id: `client_bulk_${(index + 200).toString().padStart(3, "0")}`
        })),
        next_cursor: null,
        has_more: false
      });

      const afterEnd = await injectPaired(app, {
        method: "GET",
        url: `/api/v1/access/devices?limit=1&cursor=${encodeSelectedDeviceListCursor("client_bulk_999")}`
      });
      expect(afterEnd.statusCode, afterEnd.body).toBe(200);
      expect(afterEnd.json()).toEqual({ devices: [], next_cursor: null, has_more: false });

      open.db.prepare("DELETE FROM auth_devices WHERE id = ?").run("client_bulk_099");
      const afterDeleted = await injectPaired(app, {
        method: "GET",
        url: `/api/v1/access/devices?limit=2&cursor=${firstCursor}`
      });
      expect(afterDeleted.statusCode, afterDeleted.body).toBe(200);
      expect(afterDeleted.json()).toMatchObject({
        devices: [
          { device_id: "client_bulk_100" },
          { device_id: "client_bulk_101" }
        ],
        has_more: true
      });

      open.db.pragma("query_only = ON");
      const queryOnly = await injectPaired(app, {
        method: "GET",
        url: "/api/v1/access/devices?limit=1"
      });
      expect(queryOnly.statusCode, queryOnly.body).toBe(200);
      expect(queryOnly.json()).toMatchObject({ devices: [{ device_id: "client_bulk_000" }] });
      open.db.pragma("query_only = OFF");
    } finally {
      await app.close();
      open.db.close();
    }

    const reopened = openMigratedDatabase(path, { now: () => usedAt });
    const reopenedApp = createDeviceListApp(createDeviceListingRepository(reopened.db));
    await reopenedApp.ready();
    try {
      const response = await injectPaired(reopenedApp, {
        method: "GET",
        url: "/api/v1/access/devices?limit=2"
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        devices: [
          { device_id: "client_bulk_000" },
          { device_id: "client_bulk_001" }
        ],
        has_more: true
      });
    } finally {
      await reopenedApp.close();
      reopened.db.close();
    }
  });

  it("composes real authentication last-used truth, revoke-before-auth denial, and corrupt-lookahead no-partial failure", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => createdAt });
    const auth = createAuthDeviceRepository(open.db);
    createStoredDevice(auth, "client_actual_read", readToken, csrfToken, "read");
    createStoredDevice(auth, "client_actual_write", writeToken, "G".repeat(43));
    let listCalls = 0;
    const listing = createDeviceListingRepository(open.db);
    const app = createDeviceListApp(
      {
        list(input) {
          listCalls += 1;
          return listing.list(input);
        }
      },
      {
        authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
        now: () => usedAt
      }
    );
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices",
        headers: deviceCookie(readToken)
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { devices: Record<string, unknown>[] };
      expect(body.devices.find((device) => device.device_id === "client_actual_read")).toMatchObject({
        device_id: "client_actual_read",
        permission: "read",
        last_used_at: usedAt.toISOString()
      });
      expect(listCalls).toBe(1);

      createDeviceRevocationRepository(open.db).revoke({
        deviceId: "client_actual_read",
        now: revokedAt
      });
      const revoked = await app.inject({
        method: "GET",
        url: "/api/v1/access/devices",
        headers: deviceCookie(readToken)
      });
      expectStableError(revoked, 401, "permission_denied");
      expect(listCalls).toBe(1);
    } finally {
      await app.close();
      open.db.close();
    }

    const corrupt = openMigratedDatabase(tempDbPath(), { now: () => createdAt });
    const corruptAuth = createAuthDeviceRepository(corrupt.db);
    for (const id of ["client_corrupt_001", "client_corrupt_002", "client_corrupt_003"]) {
      createStoredDevice(corruptAuth, id, fixtureToken("T", Number(id.at(-1))), fixtureToken("X", Number(id.at(-1))));
    }
    corrupt.db.pragma("ignore_check_constraints = ON");
    corrupt.db
      .prepare("UPDATE auth_devices SET permission = ? WHERE id = ?")
      .run("admin", "client_corrupt_003");
    const corruptApp = createDeviceListApp(createDeviceListingRepository(corrupt.db));
    await corruptApp.ready();
    try {
      const response = await injectPaired(corruptApp, {
        method: "GET",
        url: "/api/v1/access/devices?limit=2"
      });
      expectStableError(response, 500, "storage_error");
      expect(response.body).not.toContain("client_corrupt_001");
      expect(response.body).not.toContain("client_corrupt_002");
      expect(response.body).not.toContain("admin");
    } finally {
      await corruptApp.close();
      corrupt.db.close();
    }
  });

  it("keeps credentials, hashes, CSRF state, and unrelated data out of a real raw loopback response", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => createdAt });
    const auth = createAuthDeviceRepository(open.db);
    const rawDeviceToken = "P".repeat(43);
    const rawCsrfToken = "Q".repeat(43);
    createStoredDevice(auth, "client_raw_phone", rawDeviceToken, rawCsrfToken);
    const row = open.db
      .prepare("SELECT token_hash, csrf_token_hash FROM auth_devices WHERE id = ?")
      .get("client_raw_phone") as { token_hash: string; csrf_token_hash: string };
    const port = await getAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = createDeviceListApp(createDeviceListingRepository(open.db), {
      authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
      now: () => usedAt,
      trustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigins: [origin],
        mode: "loopback",
        transport: "http"
      })
    });
    await app.listen({ host: "127.0.0.1", port, listenTextResolver: () => "" });
    try {
      const response = await rawExchange(
        port,
        `GET /api/v1/access/devices HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${hostDeckDeviceCookieName}=${rawDeviceToken}\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(response)).toBe(200);
      expect(response).toMatch(/cache-control: no-store/iu);
      expect(response).toContain('"device_id":"client_raw_phone"');
      for (const privateValue of [
        rawDeviceToken,
        rawCsrfToken,
        row.token_hash,
        row.csrf_token_hash,
        "token_hash",
        "csrf_token_hash",
        "csrf_generation",
        "session_id"
      ]) {
        expect(response).not.toContain(privateValue);
      }

      const unpaired = await rawExchange(
        port,
        `GET /api/v1/access/devices HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(unpaired)).toBe(401);
      expect(unpaired).toMatch(/cache-control: no-store/iu);
      expect(unpaired).not.toContain("client_raw_phone");

      const head = await rawExchange(
        port,
        `HEAD /api/v1/access/devices HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${hostDeckDeviceCookieName}=${rawDeviceToken}\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(head)).toBe(405);
      expect(head).not.toContain("client_raw_phone");
    } finally {
      await app.close();
      open.db.close();
    }
  });
});

interface CreateDeviceListAppOptions {
  readonly authenticateDeviceToken?: HostDeckDeviceAuthenticationPort;
  readonly now?: () => Date;
  readonly observations?: HostDeckInternalErrorObservation[];
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createDeviceListApp(
  devices: HostDeckDeviceListPort,
  options: CreateDeviceListAppOptions = {}
) {
  return createAppFromRegistration(
    createHostDeckDeviceListRouteRegistration({ devices }),
    options
  );
}

function createAppFromRegistration(
  registration: ReturnType<typeof createHostDeckDeviceListRouteRegistration>,
  options: CreateDeviceListAppOptions = {}
) {
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => options.observations?.push(observation),
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken:
        options.authenticateDeviceToken ??
        (({ rawDeviceToken }) => {
          if (rawDeviceToken === readToken) {
            return authenticatedResult("read", "client_test_reader");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Device authentication failed."
          );
        }),
      now: options.now ?? (() => usedAt)
    }),
    requestTrustPolicy: options.trustPolicy ?? loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
}

function authenticatedResult(permission: "read" | "write", deviceId: string) {
  return {
    trusted: true as const,
    readOnly: permission === "read",
    device: {
      id: deviceId,
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: createdAt.toISOString(),
      client_label: "Phone",
      permission,
      created_at: createdAt.toISOString(),
      last_used_at: usedAt.toISOString(),
      expires_at: null,
      revoked_at: null
    }
  };
}

function frozenPage(deviceIds: readonly string[], hasMore = false) {
  const devices = deviceIds.map(frozenDevice);
  Object.freeze(devices);
  return Object.freeze({
    devices,
    nextAfterDeviceId: hasMore ? deviceIds.at(-1) ?? null : null,
    hasMore
  });
}

function frozenDevice(deviceId: string) {
  return Object.freeze({
    deviceId,
    clientLabel: "Phone",
    permission: "read" as const,
    createdAt: createdAt.toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null
  });
}

function apiDevice(deviceId: string) {
  return {
    device_id: deviceId,
    client_label: "Phone",
    permission: "read",
    created_at: createdAt.toISOString(),
    last_used_at: null,
    expires_at: null,
    revoked_at: null
  };
}

function deviceCookie(rawDeviceToken: string): Readonly<Record<string, string>> {
  return { cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}` };
}

function injectPaired(
  app: ReturnType<typeof createDeviceListApp>,
  input: {
    readonly method: "GET" | "HEAD" | "POST";
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
  }
) {
  return app.inject({
    method: input.method,
    url: input.url,
    headers: { ...deviceCookie(readToken), ...input.headers }
  });
}

function createStoredDevice(
  repository: ReturnType<typeof createAuthDeviceRepository>,
  deviceId: string,
  rawDeviceToken: string,
  rawCsrfToken: string,
  permission: "read" | "write" = "write"
): void {
  repository.create({
    id: deviceId,
    rawDeviceToken,
    rawCsrfToken,
    permission,
    clientLabel: "Android phone",
    createdAt
  });
}

function fixtureToken(prefix: string, index: number): string {
  const suffix = Math.max(0, index).toString().padStart(6, "0");
  return `${prefix}${suffix}${"A".repeat(36)}`;
}

function expectStableError(
  response: Awaited<ReturnType<ReturnType<typeof createDeviceListApp>["inject"]>>,
  status: number,
  code: string,
  field?: string
): void {
  const requestId = response.headers["x-request-id"];
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.json()).toMatchObject({
    error: {
      code,
      retryable: false,
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
  if (address === null || typeof address === "string") throw new Error("Missing probe address.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function statusCode(response: string): number {
  const match = /^HTTP\/1\.1 (\d{3}) /u.exec(response);
  if (match?.[1] === undefined) throw new Error("Raw response has no status line.");
  return Number(match[1]);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-device-list-route-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}
