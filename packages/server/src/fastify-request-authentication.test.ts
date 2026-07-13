import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type SelectedRequestAuthenticationContext,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createDeviceRevocationRepository,
  HostDeckAuthRepositoryError,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckFastifyApp,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import { HostDeckHttpError, type HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  hostDeckRequestAuthenticationSnapshot,
  requireHostDeckAuthenticationContext,
  requireHostDeckRequestAuthentication,
  requireHostDeckRequestWritePermission,
  resolveHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  type HostDeckRequestTrustPolicy
} from "./fastify-request-trust.js";

const tempDirs: string[] = [];
const createdAt = new Date("2026-07-11T20:00:00.000Z");
const firstUseAt = new Date("2026-07-11T20:01:00.000Z");
const revokeAt = new Date("2026-07-11T20:02:00.000Z");
const laterUseAt = new Date("2026-07-11T20:03:00.000Z");
const writeToken = "W".repeat(43);
const readToken = "A".repeat(43);
const expiredToken = "E".repeat(43);
const revokedToken = "R".repeat(43);
const unknownToken = "U".repeat(43);
const csrfToken = "C".repeat(43);

const loopbackOrigin = "http://localhost";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: [loopbackOrigin],
  mode: "loopback",
  transport: "http"
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected Fastify request authentication policy", () => {
  it("requires one exact branded frozen port and clock policy", async () => {
    const authenticateDeviceToken = () => authenticatedResult();
    const now = () => firstUseAt;
    const policy = createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken,
      now
    });
    expect(policy).toMatchObject({ authenticateDeviceToken, now });
    expect(Object.keys(policy).sort()).toEqual([
      "activeDeviceAuthority",
      "authenticateDeviceToken",
      "now"
    ]);
    expect(Object.isFrozen(policy.activeDeviceAuthority)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => assertHostDeckRequestAuthenticationPolicy(policy)).not.toThrow();
    expect(() =>
      assertHostDeckRequestAuthenticationPolicy(
        Object.freeze({ authenticateDeviceToken, now })
      )
    ).toThrow("must be created by createHostDeckRequestAuthenticationPolicy");

    const accessor = Object.defineProperty({ now }, "authenticateDeviceToken", {
      enumerable: true,
      get() {
        throw new Error("policy-accessor-private-sentinel");
      }
    });
    for (const candidate of [
      null,
      {},
      { authenticateDeviceToken, now, extra: true },
      Object.assign(Object.create({ inherited: true }), { authenticateDeviceToken, now }),
      { authenticateDeviceToken: null, now },
      { authenticateDeviceToken, now: null },
      accessor
    ]) {
      expect(() => createHostDeckRequestAuthenticationPolicy(candidate as never)).toThrow();
    }

    expect(() =>
      createHostDeckFastifyApp({
        observeInternalError: () => undefined,
        requestAuthenticationPolicy: Object.freeze({
          authenticateDeviceToken,
          now
        }) as unknown as HostDeckRequestAuthenticationPolicy,
        requestTrustPolicy: loopbackTrustPolicy,
        resourceBudget: defaultResourceBudget,
        routePlugins: []
      })
    ).toThrow("must be created by createHostDeckRequestAuthenticationPolicy");
  });

  it("does no auth work for unresolved routes and resolves a valid request exactly once", async () => {
    let authCalls = 0;
    let clockCalls = 0;
    const observations: SelectedRequestAuthenticationContext[] = [];
    const app = createAuthenticationApp(
      createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken() {
          authCalls += 1;
          return authenticatedResult();
        },
        now() {
          clockCalls += 1;
          return firstUseAt;
        }
      }),
      { observations }
    );
    await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: "/public" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/missing" })).statusCode).toBe(404);
      expect(authCalls).toBe(0);
      expect(clockCalls).toBe(0);

      const unpaired = await app.inject({ method: "GET", url: "/optional" });
      expect(unpaired.statusCode, unpaired.body).toBe(200);
      expect(unpaired.json()).toMatchObject({
        state: "unpaired",
        network_mode: "loopback",
        origin_kind: "safe_no_origin"
      });
      expect(authCalls).toBe(0);
      expect(clockCalls).toBe(0);

      const paired = await app.inject({
        method: "GET",
        url: "/twice",
        headers: deviceCookie(writeToken)
      });
      expect(paired.statusCode, paired.body).toBe(200);
      expect(paired.json()).toMatchObject({
        state: "paired_device",
        device_id: "client_auth_write",
        permission: "write",
        csrf_generation: 2,
        last_used_at: firstUseAt.toISOString()
      });
      expect(authCalls).toBe(1);
      expect(clockCalls).toBe(1);
      expect(observations).toHaveLength(3);
      expect(observations[1]).toBe(observations[2]);
      expect(Object.isFrozen(observations[1])).toBe(true);
      expect(JSON.stringify(observations[1])).not.toMatch(/token|hash|cookie|client label/iu);
      expect(hostDeckRequestAuthenticationSnapshot(app)).toEqual({
        authentication_conflicts: 0,
        authentication_storage_failures: 0,
        expired_device_contexts: 0,
        invalid_device_contexts: 0,
        local_admin_contexts: 0,
        read_device_contexts: 0,
        revoked_device_contexts: 0,
        unpaired_contexts: 1,
        write_device_contexts: 1
      });
    } finally {
      await app.close();
    }
  });

  it("parses canonical cookies without alternate decoding and grants no cookie fallback to local admin", async () => {
    let authCalls = 0;
    let clockCalls = 0;
    const app = createAuthenticationApp(
      createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          authCalls += 1;
          if (rawDeviceToken === writeToken) return authenticatedResult();
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Auth device token is not recognized."
          );
        },
        now() {
          clockCalls += 1;
          return firstUseAt;
        }
      })
    );
    await app.ready();
    try {
      const malformed = [
        `${hostDeckDeviceCookieName}=`,
        `${hostDeckDeviceCookieName}=${"Q".repeat(42)}`,
        `${hostDeckDeviceCookieName}=${"Q".repeat(44)}`,
        `${hostDeckDeviceCookieName}=${"Q".repeat(42)}%41`,
        `${hostDeckDeviceCookieName}="${writeToken}"`,
        `${hostDeckDeviceCookieName}=${"Q".repeat(42)} `,
        `${hostDeckDeviceCookieName}=${"Q".repeat(42)}\u00e9`,
        `${hostDeckDeviceCookieName}=${writeToken}; ${hostDeckDeviceCookieName}=${writeToken}`
      ];
      for (const cookie of malformed) {
        const response = await app.inject({
          method: "GET",
          url: "/optional",
          headers: { cookie }
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ state: "invalid_device" });
      }
      expect(authCalls).toBe(0);
      expect(clockCalls).toBe(0);

      for (const cookie of [
        "other=value",
        `${hostDeckDeviceCookieName.toUpperCase()}=${writeToken}`
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/optional",
          headers: { cookie }
        });
        expect(response.json()).toMatchObject({ state: "unpaired" });
      }

      const localAdmin = await app.inject({ method: "POST", url: "/optional" });
      expect(localAdmin.json()).toMatchObject({
        state: "local_admin",
        permission: "local_admin",
        origin_kind: "local_non_browser"
      });
      const sameOrigin = await app.inject({
        method: "POST",
        url: "/optional",
        headers: { origin: loopbackOrigin }
      });
      expect(sameOrigin.json()).toMatchObject({ state: "unpaired" });

      const paired = await app.inject({
        method: "POST",
        url: "/optional",
        headers: {
          cookie: `other=value; ${hostDeckDeviceCookieName}=${writeToken}`
        }
      });
      expect(paired.json()).toMatchObject({ state: "paired_device" });
      const unknown = await app.inject({
        method: "GET",
        url: "/optional",
        headers: deviceCookie(unknownToken)
      });
      expect(unknown.json()).toMatchObject({ state: "invalid_device" });
      expect(authCalls).toBe(2);
      expect(clockCalls).toBe(2);

      const browserLike = await app.inject({
        method: "POST",
        url: "/optional",
        headers: { "sec-fetch-site": "same-origin" }
      });
      expect(browserLike.statusCode).toBe(403);
      expect(browserLike.json()).toMatchObject({ error: { code: "invalid_origin" } });
      expect(authCalls).toBe(2);
      expect(clockCalls).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("maps real missing, expired, revoked, read, and write devices to exact non-secret contexts", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => createdAt });
    try {
      const auth = createAuthDeviceRepository(open.db);
      createDevice(auth, "client_auth_write", writeToken, "write");
      createDevice(auth, "client_auth_read", readToken, "read");
      createDevice(auth, "client_auth_expired", expiredToken, "write", revokeAt);
      createDevice(auth, "client_auth_revoked", revokedToken, "write");
      createDeviceRevocationRepository(open.db).revoke({
        deviceId: "client_auth_revoked",
        now: revokeAt
      });
      const before = rawDeviceRows(open.db);
      const observed: SelectedRequestAuthenticationContext[] = [];
      const app = createAuthenticationApp(
        createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
          now: () => laterUseAt
        }),
        { observations: observed }
      );
      await app.ready();
      try {
        const cases = [
          [unknownToken, "invalid_device", null],
          [expiredToken, "expired_device", null],
          [revokedToken, "revoked_device", null],
          [readToken, "paired_device", "read"],
          [writeToken, "paired_device", "write"]
        ] as const;
        for (const [token, state, permission] of cases) {
          const response = await app.inject({
            method: "GET",
            url: "/optional",
            headers: deviceCookie(token)
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({ state, permission });
          expect(response.body).not.toContain(token);
        }
        expect(observed.every((context) => Object.isFrozen(context))).toBe(true);
        expect(rawDeviceRow(open.db, "client_auth_read").last_used_at).toBe(
          laterUseAt.toISOString()
        );
        expect(rawDeviceRow(open.db, "client_auth_write").last_used_at).toBe(
          laterUseAt.toISOString()
        );
        expect(rawDeviceRow(open.db, "client_auth_expired")).toEqual(
          before.find((row) => row.id === "client_auth_expired")
        );
        expect(rawDeviceRow(open.db, "client_auth_revoked")).toEqual(
          before.find((row) => row.id === "client_auth_revoked")
        );
        expect(hostDeckRequestAuthenticationSnapshot(app)).toMatchObject({
          expired_device_contexts: 1,
          invalid_device_contexts: 1,
          read_device_contexts: 1,
          revoked_device_contexts: 1,
          write_device_contexts: 1
        });
      } finally {
        await app.close();
      }
    } finally {
      open.db.close();
    }
  });

  it("enforces manifest auth mechanisms and write permission before protected handlers", async () => {
    const calls: Record<string, number> = Object.create(null) as Record<string, number>;
    const app = createAuthenticationApp(
      createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedResult({
              deviceId: "client_auth_read",
              permission: "read"
            });
          }
          if (rawDeviceToken === writeToken) return authenticatedResult();
          if (rawDeviceToken === expiredToken) {
            throw new HostDeckAuthRepositoryError(
              "device_expired",
              "Auth device token has expired."
            );
          }
          if (rawDeviceToken === revokedToken) {
            throw new HostDeckAuthRepositoryError(
              "device_revoked",
              "Auth device token has been revoked."
            );
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Auth device token is not recognized."
          );
        },
        now: () => firstUseAt
      }),
      { handlerCalls: calls }
    );
    await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: "/loopback" })).statusCode).toBe(
        200
      );
      for (const [token, message] of [
        [null, "authentication is required"],
        [unknownToken, "is invalid"],
        [expiredToken, "has expired"],
        [revokedToken, "has been revoked"]
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url: "/device",
          ...(token === null ? {} : { headers: deviceCookie(token) })
        });
        expectAuthError(response, 401, "permission_denied", message);
      }
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/device",
            headers: deviceCookie(readToken)
          })
        ).statusCode
      ).toBe(200);

      expect((await app.inject({ method: "POST", url: "/admin" })).statusCode).toBe(
        200
      );
      expectAuthError(
        await app.inject({
          method: "POST",
          url: "/admin",
          headers: { origin: loopbackOrigin }
        }),
        403,
        "permission_denied",
        "local-admin"
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/either",
            headers: { ...deviceCookie(readToken), origin: loopbackOrigin }
          })
        ).statusCode
      ).toBe(200);

      expectAuthError(
        await app.inject({
          method: "POST",
          url: "/write",
          headers: { ...deviceCookie(readToken), origin: loopbackOrigin }
        }),
        403,
        "read_only",
        "read-only"
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/write",
            headers: { ...deviceCookie(writeToken), origin: loopbackOrigin }
          })
        ).statusCode
      ).toBe(200);
      expect((await app.inject({ method: "POST", url: "/write" })).statusCode).toBe(
        200
      );
      expect(calls).toMatchObject({
        admin: 1,
        device: 1,
        either: 1,
        loopback: 1,
        write: 2
      });

      const lanUnpaired = selectedRequestAuthenticationContextSchema.parse({
        state: "unpaired",
        configured_origin: "https://192.168.0.29:8443",
        network_mode: "lan",
        origin_kind: "safe_no_origin",
        transport: "https",
        device_id: null,
        permission: null,
        csrf_generation: null,
        last_used_at: null,
        expires_at: null
      });
      expectHttpError(
        () =>
          requireHostDeckAuthenticationContext(
            lanUnpaired,
            "loopback_or_device_cookie"
          ),
        401,
        "permission_denied"
      );
    } finally {
      await app.close();
    }
  });

  it("sanitizes conflict, invalid result, clock, and storage failures without retry", async () => {
    const sentinel = "request-auth-private-failure-sentinel";
    const calls = new Map<string, number>();
    const internal: HostDeckInternalErrorObservation[] = [];
    const app = createAuthenticationApp(
      createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          calls.set(rawDeviceToken, (calls.get(rawDeviceToken) ?? 0) + 1);
          if (rawDeviceToken === "K".repeat(43)) {
            throw new HostDeckAuthRepositoryError(
              "authentication_conflict",
              `${sentinel}:${rawDeviceToken}`
            );
          }
          if (rawDeviceToken === "I".repeat(43)) {
            return { trusted: true, readOnly: false, device: { token_hash: sentinel } };
          }
          if (rawDeviceToken === "P".repeat(43)) {
            return Promise.resolve(authenticatedResult());
          }
          throw new Error(`${sentinel}:${rawDeviceToken}`);
        },
        now: () => firstUseAt
      }),
      { internal }
    );
    await app.ready();
    try {
      const cases = [
        ["K".repeat(43), 409, "operation_conflict"],
        ["I".repeat(43), 500, "storage_error"],
        ["P".repeat(43), 500, "storage_error"],
        ["F".repeat(43), 500, "storage_error"]
      ] as const;
      for (const [token, status, code] of cases) {
        const response = await app.inject({
          method: "GET",
          url: "/device",
          headers: deviceCookie(token)
        });
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        expect(response.body).not.toContain(token);
        expect(response.body).not.toContain(sentinel);
        expect(calls.get(token)).toBe(1);
      }
      expect(internal).toEqual([]);
      expect(hostDeckRequestAuthenticationSnapshot(app)).toMatchObject({
        authentication_conflicts: 1,
        authentication_storage_failures: 3
      });
    } finally {
      await app.close();
    }

    const clockApp = createAuthenticationApp(
      createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken() {
          throw new Error("port must not run after clock failure");
        },
        now() {
          throw new Error(sentinel);
        }
      })
    );
    await clockApp.ready();
    try {
      const response = await clockApp.inject({
        method: "GET",
        url: "/device",
        headers: deviceCookie(writeToken)
      });
      expectAuthError(response, 500, "storage_error", "storage failed");
      expect(response.body).not.toContain(sentinel);
    } finally {
      await clockApp.close();
    }
  });

  it("preserves real equal-time truth and sanitizes monotonic conflict, corruption, and closed storage", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => createdAt });
    const conflictToken = "K".repeat(43);
    const corruptToken = "Z".repeat(43);
    const closedToken = "D".repeat(43);
    const sentinel = "request-auth-real-storage-private-sentinel";
    try {
      const auth = createAuthDeviceRepository(open.db);
      createDevice(auth, "client_auth_conflict", conflictToken, "write");
      createDevice(auth, "client_auth_corrupt", corruptToken, "write");
      createDevice(auth, "client_auth_closed", closedToken, "write");
      auth.authenticateDeviceToken({
        rawDeviceToken: conflictToken,
        now: laterUseAt
      });
      const greatest = rawDeviceRow(open.db, "client_auth_conflict");

      let conflictCalls = 0;
      const conflictApp = createAuthenticationApp(
        createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken(input) {
            conflictCalls += 1;
            return auth.authenticateDeviceToken(input);
          },
          now: () => firstUseAt
        })
      );
      await conflictApp.ready();
      try {
        const response = await conflictApp.inject({
          method: "GET",
          url: "/device",
          headers: deviceCookie(conflictToken)
        });
        expectAuthError(response, 409, "operation_conflict", "newer state");
        expect(response.body).not.toContain(conflictToken);
        expect(conflictCalls).toBe(1);
        expect(rawDeviceRow(open.db, "client_auth_conflict")).toEqual(greatest);
      } finally {
        await conflictApp.close();
      }

      const equalApp = createAuthenticationApp(
        createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
          now: () => laterUseAt
        })
      );
      await equalApp.ready();
      try {
        const response = await equalApp.inject({
          method: "GET",
          url: "/device",
          headers: deviceCookie(conflictToken)
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          state: "paired_device",
          last_used_at: laterUseAt.toISOString()
        });
        expect(rawDeviceRow(open.db, "client_auth_conflict")).toEqual(greatest);
      } finally {
        await equalApp.close();
      }

      open.db.pragma("ignore_check_constraints = ON");
      open.db
        .prepare("UPDATE auth_devices SET client_label = ? WHERE id = ?")
        .run("", "client_auth_corrupt");
      const unavailableApp = createAuthenticationApp(
        createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
          now: () => laterUseAt
        })
      );
      await unavailableApp.ready();
      try {
        const corrupt = await unavailableApp.inject({
          method: "GET",
          url: "/device",
          headers: deviceCookie(corruptToken)
        });
        expectAuthError(corrupt, 500, "storage_error", "storage failed");
        expect(corrupt.body).not.toMatch(/client_auth_corrupt|token_hash|zod|client_label/iu);

        open.db.close();
        const closed = await unavailableApp.inject({
          method: "GET",
          url: "/device",
          headers: deviceCookie(closedToken)
        });
        expectAuthError(closed, 500, "storage_error", "storage failed");
        expect(closed.body).not.toContain(closedToken);
        expect(closed.body).not.toContain(sentinel);
        expect(hostDeckRequestAuthenticationSnapshot(unavailableApp)).toMatchObject({
          authentication_storage_failures: 2
        });
      } finally {
        await unavailableApp.close();
      }
    } finally {
      if (open.db.open) open.db.close();
    }
  });

  it("observes revoke before lazy resolution and closes a paired snapshot after live invalidation", async () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => createdAt });
    try {
      const auth = createAuthDeviceRepository(open.db);
      createDevice(auth, "client_auth_write", writeToken, "write");
      const revoke = createDeviceRevocationRepository(open.db);

      let beforeResolveCalls = 0;
      const revokedApp = createAuthenticationApp(
        createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
          now: () => laterUseAt
        }),
        {
          beforeAuthentication() {
            beforeResolveCalls += 1;
            revoke.revoke({ deviceId: "client_auth_write", now: revokeAt });
          }
        }
      );
      await revokedApp.ready();
      try {
        const response = await revokedApp.inject({
          method: "GET",
          url: "/device-after-prevalidation",
          headers: deviceCookie(writeToken)
        });
        expectAuthError(response, 401, "permission_denied", "revoked");
        expect(beforeResolveCalls).toBe(1);
        expect(rawDeviceRow(open.db, "client_auth_write")).toMatchObject({
          last_used_at: null,
          revoked_at: revokeAt.toISOString()
        });
      } finally {
        await revokedApp.close();
      }

      const secondOpen = openMigratedDatabase(tempDbPath(), { now: () => createdAt });
      try {
        const secondAuth = createAuthDeviceRepository(secondOpen.db);
        createDevice(secondAuth, "client_auth_write", writeToken, "write");
        const secondRevoke = createDeviceRevocationRepository(secondOpen.db);
        const snapshots: SelectedRequestAuthenticationContext[] = [];
        const cachedPolicy = createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) =>
            secondAuth.authenticateDeviceToken(input),
          now: () => firstUseAt
        });
        const cachedApp = createAuthenticationApp(
          cachedPolicy,
          {
            afterAuthentication(context) {
              snapshots.push(context);
              secondRevoke.revoke({
                deviceId: "client_auth_write",
                now: revokeAt
              });
              cachedPolicy.activeDeviceAuthority.invalidate(
                "client_auth_write"
              );
            },
            observations: snapshots
          }
        );
        await cachedApp.ready();
        try {
          const response = await cachedApp.inject({
            method: "GET",
            url: "/resolve-return-after-revoke",
            headers: deviceCookie(writeToken)
          });
          expectAuthError(response, 401, "permission_denied", "revoked");
          expect(response.body).not.toContain("paired_device");
          expect(snapshots).toHaveLength(1);
          expect(cachedPolicy.activeDeviceAuthority.snapshot()).toMatchObject({
            active_leases: 0,
            signaled_leases: 1,
            tracked_revocations: 1
          });
          expect(rawDeviceRow(secondOpen.db, "client_auth_write")).toMatchObject({
            last_used_at: firstUseAt.toISOString(),
            revoked_at: revokeAt.toISOString()
          });
        } finally {
          await cachedApp.close();
        }
      } finally {
        secondOpen.db.close();
      }
    } finally {
      open.db.close();
    }
  });

  it("preserves authentication across WAL restart without raw credential or error persistence", async () => {
    const path = tempDbPath();
    const rawToken = "P".repeat(43);
    const rawCsrf = "S".repeat(43);
    const sentinel = "request-auth-wal-private-sentinel";
    const first = openMigratedDatabase(path, { now: () => createdAt });
    first.db.pragma("journal_mode = WAL");
    first.db.pragma("wal_autocheckpoint = 0");
    try {
      const auth = createAuthDeviceRepository(first.db);
      createDevice(auth, "client_auth_restart", rawToken, "write", null, rawCsrf);
      const app = createAuthenticationApp(
        createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
          now: () => firstUseAt
        })
      );
      await app.ready();
      try {
        const response = await app.inject({
          method: "GET",
          url: "/device",
          headers: deviceCookie(rawToken)
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body).not.toContain(rawToken);
        expect(response.body).not.toContain(rawCsrf);
        expect(response.body).not.toContain(sentinel);
        assertSecretsAbsent(path, [rawToken, rawCsrf, sentinel]);
      } finally {
        await app.close();
      }
    } finally {
      first.db.close();
    }
    assertSecretsAbsent(path, [rawToken, rawCsrf, sentinel]);

    const reopened = openMigratedDatabase(path, { now: () => createdAt });
    try {
      const auth = createAuthDeviceRepository(reopened.db);
      const app = createAuthenticationApp(
        createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
          now: () => laterUseAt
        })
      );
      await app.ready();
      try {
        const response = await app.inject({
          method: "GET",
          url: "/device",
          headers: deviceCookie(rawToken)
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          state: "paired_device",
          device_id: "client_auth_restart",
          last_used_at: laterUseAt.toISOString()
        });
      } finally {
        await app.close();
      }
    } finally {
      reopened.db.close();
    }
  });

  it("proves valid, duplicate, malformed, browser-like, and local-admin raw listener boundaries", async () => {
    const port = await getAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    const handlerCalls: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    let authCalls = 0;
    const app = createAuthenticationApp(
      createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          authCalls += 1;
          if (rawDeviceToken !== writeToken) throw new Error("raw auth mismatch");
          return authenticatedResult();
        },
        now: () => firstUseAt
      }),
      {
        handlerCalls,
        trustPolicy: createHostDeckRequestTrustPolicy({
          allowedOrigins: [origin],
          mode: "loopback",
          transport: "http"
        })
      }
    );
    await app.listen({ host: "127.0.0.1", port, listenTextResolver: () => "" });
    try {
      const valid = await rawExchange(
        port,
        `GET /device HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${hostDeckDeviceCookieName}=${writeToken}\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(valid)).toBe(200);
      expect(valid).not.toContain(writeToken);

      const duplicate = await rawExchange(
        port,
        `GET /device HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${hostDeckDeviceCookieName}=${writeToken}\r\nCookie: ${hostDeckDeviceCookieName}=${writeToken}\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(duplicate)).toBe(401);
      expect(duplicate).not.toContain(writeToken);

      const malformed = await rawExchange(
        port,
        `GET /device HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${hostDeckDeviceCookieName}=${"M".repeat(42)}%41\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(malformed)).toBe(401);

      const localAdmin = await rawExchange(
        port,
        `POST /admin HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(localAdmin)).toBe(200);

      const cookieBlockedAdmin = await rawExchange(
        port,
        `POST /admin HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: other=value\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(cookieBlockedAdmin)).toBe(403);

      const browserLike = await rawExchange(
        port,
        `POST /admin HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nSec-Fetch-Site: same-origin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );
      expect(statusCode(browserLike)).toBe(403);
      expect(browserLike).toContain('"code":"invalid_origin"');
      expect(authCalls).toBe(1);
      expect(handlerCalls).toMatchObject({ admin: 1, device: 1 });
    } finally {
      await app.close();
    }
  });
});

interface AuthenticationAppOptions {
  readonly afterAuthentication?: (
    context: SelectedRequestAuthenticationContext
  ) => void;
  readonly beforeAuthentication?: () => void;
  readonly handlerCalls?: Record<string, number>;
  readonly internal?: HostDeckInternalErrorObservation[];
  readonly observations?: SelectedRequestAuthenticationContext[];
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createAuthenticationApp(
  requestAuthenticationPolicy: HostDeckRequestAuthenticationPolicy,
  options: AuthenticationAppOptions = {}
) {
  const observations = options.observations ?? [];
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => options.internal?.push(observation),
    requestAuthenticationPolicy,
    requestTrustPolicy: options.trustPolicy ?? loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [authenticationRoutes(options, observations)]
  });
}

function authenticationRoutes(
  options: AuthenticationAppOptions,
  observations: SelectedRequestAuthenticationContext[]
): HostDeckRoutePluginRegistration {
  const contextRoute = (
    path: string,
    mechanism:
      | "optional_device_cookie"
      | "loopback_or_device_cookie"
      | "device_cookie"
      | "local_admin"
      | "local_admin_or_device_cookie",
    method: "get" | "post" = "get"
  ) =>
    ({
      method,
      path,
      mechanism
    }) as const;
  const routes = [
    contextRoute("/optional", "optional_device_cookie"),
    contextRoute("/optional", "optional_device_cookie", "post"),
    contextRoute("/loopback", "loopback_or_device_cookie"),
    contextRoute("/device", "device_cookie"),
    contextRoute("/admin", "local_admin", "post"),
    contextRoute("/either", "local_admin_or_device_cookie", "post")
  ];
  return {
    id: "request-authentication-fixture",
    surface: "api",
    register(scope) {
      scope.get(
        "/public",
        { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } },
        async () => ({ ok: true as const })
      );
      for (const route of routes) {
        scope[route.method](
          route.path,
          {
            async preHandler(request) {
              requireHostDeckRequestAuthentication(request, route.mechanism);
            },
            schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
          },
          async (request) => {
            incrementHandler(options.handlerCalls, route.path.slice(1));
            const context = resolveHostDeckRequestAuthentication(request);
            observations.push(context);
            return context;
          }
        );
      }
      scope.get(
        "/twice",
        { schema: { response: { 200: selectedRequestAuthenticationContextSchema } } },
        async (request) => {
          const first = resolveHostDeckRequestAuthentication(request);
          const second = resolveHostDeckRequestAuthentication(request);
          observations.push(first, second);
          return second;
        }
      );
      scope.post(
        "/write",
        {
          async preHandler(request) {
            requireHostDeckRequestWritePermission(
              requireHostDeckRequestAuthentication(
                request,
                "local_admin_or_device_cookie"
              )
            );
          },
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => {
          incrementHandler(options.handlerCalls, "write");
          return resolveHostDeckRequestAuthentication(request);
        }
      );
      scope.get(
        "/device-after-prevalidation",
        {
          async preValidation() {
            options.beforeAuthentication?.();
          },
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => {
          incrementHandler(options.handlerCalls, "device-after-prevalidation");
          return resolveHostDeckRequestAuthentication(request);
        }
      );
      scope.get(
        "/resolve-then-revoke",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => {
          const before = resolveHostDeckRequestAuthentication(request);
          options.afterAuthentication?.(before);
          const after = resolveHostDeckRequestAuthentication(request);
          observations.push(after);
          return after;
        }
      );
      scope.get(
        "/resolve-return-after-revoke",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: selectedRequestAuthenticationContextSchema } }
        },
        async (request) => {
          const before = resolveHostDeckRequestAuthentication(request);
          options.afterAuthentication?.(before);
          return before;
        }
      );
    }
  };
}

function authenticatedResult(
  overrides: {
    readonly deviceId?: string;
    readonly permission?: "read" | "write";
    readonly lastUsedAt?: string;
  } = {}
) {
  const permission = overrides.permission ?? "write";
  return {
    trusted: true as const,
    readOnly: permission === "read",
    device: {
      id: overrides.deviceId ?? "client_auth_write",
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 2,
      csrf_rotated_at: createdAt.toISOString(),
      client_label: "Android phone",
      permission,
      created_at: createdAt.toISOString(),
      last_used_at: overrides.lastUsedAt ?? firstUseAt.toISOString(),
      expires_at: null,
      revoked_at: null
    }
  };
}

function createDevice(
  auth: ReturnType<typeof createAuthDeviceRepository>,
  id: string,
  rawDeviceToken: string,
  permission: "read" | "write",
  expiresAt: Date | null = null,
  rawCsrfToken: string = csrfToken
): void {
  auth.create({
    id,
    rawDeviceToken,
    rawCsrfToken,
    permission,
    clientLabel: `Android ${id}`,
    createdAt,
    expiresAt
  });
}

function rawDeviceRows(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return db.prepare("SELECT * FROM auth_devices ORDER BY id ASC").all() as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
}

function rawDeviceRow(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  id: string
): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Missing auth device ${id}.`);
  return row as Readonly<Record<string, unknown>>;
}

function deviceCookie(token: string): { readonly cookie: string } {
  return { cookie: `${hostDeckDeviceCookieName}=${token}` };
}

function incrementHandler(
  calls: Record<string, number> | undefined,
  route: string
): void {
  if (calls !== undefined) calls[route] = (calls[route] ?? 0) + 1;
}

function expectAuthError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  message: string
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({
    error: { code, message: expect.stringContaining(message) }
  });
}

function expectHttpError(
  fn: () => unknown,
  status: number,
  code: string
): HostDeckHttpError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckHttpError);
  expect(caught).toMatchObject({ code, statusCode: status });
  expect((caught as HostDeckHttpError).cause).toBeUndefined();
  return caught as HostDeckHttpError;
}

function assertSecretsAbsent(path: string, secrets: readonly string[]): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    for (const secret of secrets) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  }
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
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.end(request);
    });
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
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-request-auth-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}
