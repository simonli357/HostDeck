import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthRepositoryErrorCode,
  createAuthDeviceRepository,
  createSelectedCsrfAuthorizationRepository,
  HostDeckAuthRepositoryError,
  hashSecret
} from "./auth-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { createDeviceRevocationRepository } from "./selected-device-revocation-repository.js";

const tempDirs: string[] = [];
const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve("better-sqlite3");
const rawDeviceToken = "device_token_for_monotonic_auth_123456";
const rawCsrfToken = "C".repeat(43);
const readRawCsrfToken = "R".repeat(43);
const wrongRawCsrfToken = "W".repeat(43);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("monotonic auth-device last-used repository", () => {
  it("advances only last-used for valid read and write authentication and no-ops at equal time", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      const repository = createAuthDeviceRepository(open.db);
      const csrfAuthorization = createSelectedCsrfAuthorizationRepository(open.db);
      createDevice(repository);
      createDevice(repository, {
        id: "client_read_auth",
        rawDeviceToken: "device_token_for_read_monotonic_123456",
        rawCsrfToken: readRawCsrfToken,
        permission: "read"
      });
      const writeBefore = rawDeviceRow(open.db, "client_monotonic_auth");
      const readBefore = rawDeviceRow(open.db, "client_read_auth");

      const first = repository.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() });
      expect(first).toMatchObject({ trusted: true, readOnly: false, device: { last_used_at: firstUseAt().toISOString() } });
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual({
        ...writeBefore,
        last_used_at: firstUseAt().toISOString()
      });

      const equal = repository.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() });
      expect(equal.device.last_used_at).toBe(firstUseAt().toISOString());
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual({
        ...writeBefore,
        last_used_at: firstUseAt().toISOString()
      });

      const write = csrfAuthorization.authorizeBrowserWrite({
        deviceId: "client_monotonic_auth",
        expectedCsrfGeneration: 1,
        rawCsrfToken,
        now: laterUseAt()
      }).device;
      expect(write.last_used_at).toBe(laterUseAt().toISOString());
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual({
        ...writeBefore,
        last_used_at: laterUseAt().toISOString()
      });

      const read = repository.authenticateDeviceToken({
        rawDeviceToken: "device_token_for_read_monotonic_123456",
        now: laterUseAt()
      });
      expect(read).toMatchObject({ trusted: true, readOnly: true, device: { last_used_at: laterUseAt().toISOString() } });
      expect(rawDeviceRow(open.db, "client_read_auth")).toEqual({ ...readBefore, last_used_at: laterUseAt().toISOString() });
    } finally {
      open.db.close();
    }
  });

  it("rejects regressing and pre-creation observations without changing the greatest committed time", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      const repository = createAuthDeviceRepository(open.db);
      const csrfAuthorization = createSelectedCsrfAuthorizationRepository(open.db);
      createDevice(repository);
      const initial = rawDeviceRow(open.db, "client_monotonic_auth");

      expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: new Date("2026-07-08T21:59:59.999Z") }),
        "invalid_time"
      );
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual(initial);

      repository.authenticateDeviceToken({ rawDeviceToken, now: laterUseAt() });
      const greatest = rawDeviceRow(open.db, "client_monotonic_auth");
      expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() }),
        "authentication_conflict"
      );
      expectAuthError(
        () =>
          csrfAuthorization.authorizeBrowserWrite({
            deviceId: "client_monotonic_auth",
            expectedCsrfGeneration: 1,
            rawCsrfToken,
            now: firstUseAt()
          }),
        "authentication_conflict"
      );
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual(greatest);
    } finally {
      open.db.close();
    }
  });

  it("rejects invalid authority, permission, CSRF, time, and corrupt rows without touch", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      const repository = createAuthDeviceRepository(open.db);
      const csrfAuthorization = createSelectedCsrfAuthorizationRepository(open.db);
      createDevice(repository);
      createDevice(repository, {
        id: "client_read_auth",
        rawDeviceToken: "device_token_for_read_monotonic_123456",
        rawCsrfToken: readRawCsrfToken,
        permission: "read"
      });
      createDevice(repository, {
        id: "client_expired_auth",
        rawDeviceToken: "device_token_for_expired_monotonic_123",
        rawCsrfToken: "csrf_token_for_expired_monotonic_123",
        expiresAt: laterUseAt()
      });
      createDevice(repository, {
        id: "client_revoked_auth",
        rawDeviceToken: "device_token_for_revoked_monotonic_123",
        rawCsrfToken: "csrf_token_for_revoked_monotonic_123"
      });
      createDeviceRevocationRepository(open.db).revoke({
        deviceId: "client_revoked_auth",
        now: firstUseAt()
      });
      const before = allDeviceRows(open.db);

      expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken: "missing_device_token_monotonic_12345", now: firstUseAt() }),
        "device_not_found"
      );
      expectAuthError(() => repository.authenticateDeviceToken({ rawDeviceToken: "short", now: firstUseAt() }), "invalid_secret");
      expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: new Date(Number.NaN) }),
        "invalid_time"
      );
      expectAuthError(
        () =>
          csrfAuthorization.authorizeBrowserWrite({
            deviceId: "client_read_auth",
            expectedCsrfGeneration: 1,
            rawCsrfToken: readRawCsrfToken,
            now: firstUseAt()
          }),
        "read_only"
      );
      expectAuthError(
        () =>
          csrfAuthorization.authorizeBrowserWrite({
            deviceId: "client_monotonic_auth",
            expectedCsrfGeneration: 1,
            rawCsrfToken: wrongRawCsrfToken,
            now: firstUseAt()
          }),
        "csrf_mismatch"
      );
      for (const now of [laterUseAt(), new Date("2026-07-08T22:05:00.001Z")]) {
        expectAuthError(
          () =>
            repository.authenticateDeviceToken({
              rawDeviceToken: "device_token_for_expired_monotonic_123",
              now
            }),
          "device_expired"
        );
      }
      expectAuthError(
        () =>
          repository.authenticateDeviceToken({
            rawDeviceToken: "device_token_for_revoked_monotonic_123",
            now: laterUseAt()
          }),
        "device_revoked"
      );
      expect(allDeviceRows(open.db)).toEqual(before);

      open.db
        .prepare("UPDATE auth_devices SET last_used_at = ? WHERE id = ?")
        .run("2026-07-08T21:59:59.999Z", "client_monotonic_auth");
      const corruptBefore = rawDeviceRow(open.db, "client_monotonic_auth");
      expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: laterUseAt() }),
        "invalid_auth_device"
      );
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual(corruptBefore);
    } finally {
      open.db.close();
    }
  });

  it("maps update failure to a generic secret-free error, rolls back, and performs no equal-time update", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: createdAt });
    try {
      const repository = createAuthDeviceRepository(open.db);
      createDevice(repository);
      repository.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() });
      const before = rawDeviceRow(open.db, "client_monotonic_auth");
      open.db.exec(`
        CREATE TRIGGER fail_last_used_update
        BEFORE UPDATE OF last_used_at ON auth_devices
        BEGIN
          SELECT RAISE(ABORT, 'forced auth touch failure');
        END;
      `);

      expect(repository.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() }).device.last_used_at).toBe(
        firstUseAt().toISOString()
      );
      const failure = expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: laterUseAt() }),
        "authentication_failed"
      );
      expect(failure.cause).toBeUndefined();
      expect(JSON.stringify(failure)).not.toMatch(/forced auth touch|device_token|csrf_token/iu);
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual(before);
      expect(readFileSync(path).includes(Buffer.from(rawDeviceToken))).toBe(false);
      expect(readFileSync(path).includes(Buffer.from(rawCsrfToken))).toBe(false);
    } finally {
      open.db.close();
    }
  });

  it("maps commit failure to a generic error and rolls back both the touch and deferred side effect", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      const repository = createAuthDeviceRepository(open.db);
      createDevice(repository);
      const before = rawDeviceRow(open.db, "client_monotonic_auth");
      open.db.exec(`
        CREATE TABLE auth_commit_failure_probe (
          missing_device_id TEXT NOT NULL,
          FOREIGN KEY (missing_device_id) REFERENCES auth_devices(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_auth_touch_commit
        AFTER UPDATE OF last_used_at ON auth_devices
        BEGIN
          INSERT INTO auth_commit_failure_probe (missing_device_id) VALUES ('missing_auth_device');
        END;
      `);

      const failure = expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() }),
        "authentication_failed"
      );
      expect(failure.cause).toBeUndefined();
      expect(JSON.stringify(failure)).not.toMatch(/foreign key|missing_auth_device|device_token|csrf_token/iu);
      expect(open.db.inTransaction).toBe(false);
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toEqual(before);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM auth_commit_failure_probe").get()).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });

  it("serializes newer-first then rejects an older real connection without regression", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: createdAt });
    try {
      open.db.pragma("busy_timeout = 2000");
      createDevice(createAuthDeviceRepository(open.db));
      const worker = startAuthWriter(path, "touch", newerUseAt().toISOString());
      await worker.updated;

      expectAuthError(
        () => createAuthDeviceRepository(open.db).authenticateDeviceToken({ rawDeviceToken, now: laterUseAt() }),
        "authentication_conflict"
      );
      await worker.completed;
      expect(rawDeviceRow(open.db, "client_monotonic_auth").last_used_at).toBe(newerUseAt().toISOString());
    } finally {
      open.db.close();
    }
  });

  it("serializes older-first then advances a newer real connection to the greatest observation", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: createdAt });
    try {
      open.db.pragma("busy_timeout = 2000");
      createDevice(createAuthDeviceRepository(open.db));
      const worker = startAuthWriter(path, "touch", firstUseAt().toISOString());
      await worker.updated;

      const authenticated = createAuthDeviceRepository(open.db).authenticateDeviceToken({ rawDeviceToken, now: newerUseAt() });
      await worker.completed;
      expect(authenticated.device.last_used_at).toBe(newerUseAt().toISOString());
      expect(rawDeviceRow(open.db, "client_monotonic_auth").last_used_at).toBe(newerUseAt().toISOString());
    } finally {
      open.db.close();
    }
  });

  it("treats equal observations from concurrent real connections as idempotent", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: createdAt });
    try {
      open.db.pragma("busy_timeout = 2000");
      createDevice(createAuthDeviceRepository(open.db));
      const worker = startAuthWriter(path, "touch", firstUseAt().toISOString());
      await worker.updated;

      const authenticated = createAuthDeviceRepository(open.db).authenticateDeviceToken({
        rawDeviceToken,
        now: firstUseAt()
      });
      await worker.completed;
      expect(authenticated.device.last_used_at).toBe(firstUseAt().toISOString());
      expect(rawDeviceRow(open.db, "client_monotonic_auth").last_used_at).toBe(firstUseAt().toISOString());
    } finally {
      open.db.close();
    }
  });

  it("observes a worker-committed revoke before authentication and never returns trusted authority", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: createdAt });
    try {
      open.db.pragma("busy_timeout = 2000");
      createDevice(createAuthDeviceRepository(open.db));
      const worker = startAuthWriter(path, "revoke", firstUseAt().toISOString());
      await worker.updated;

      expectAuthError(
        () => createAuthDeviceRepository(open.db).authenticateDeviceToken({ rawDeviceToken, now: laterUseAt() }),
        "device_revoked"
      );
      await worker.completed;
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toMatchObject({
        last_used_at: null,
        revoked_at: firstUseAt().toISOString()
      });
      expectAuthError(
        () => createAuthDeviceRepository(open.db).authenticateDeviceToken({ rawDeviceToken, now: newerUseAt() }),
        "device_revoked"
      );
    } finally {
      open.db.close();
    }
  });

  it("allows an authentication serialized first, then commits revoke and rejects every future observation", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: createdAt });
    try {
      open.db.pragma("busy_timeout = 2000");
      const repository = createAuthDeviceRepository(open.db);
      createDevice(repository);
      const worker = startAuthWriter(path, "touch", firstUseAt().toISOString());
      await worker.updated;

      const revoked = createDeviceRevocationRepository(open.db).revoke({
        deviceId: "client_monotonic_auth",
        now: laterUseAt()
      });
      await worker.completed;
      expect(revoked).toEqual({
        authorityInvalidated: true,
        deviceId: "client_monotonic_auth",
        previouslyRevoked: false,
        revokedAt: laterUseAt().toISOString()
      });
      expect(rawDeviceRow(open.db, "client_monotonic_auth")).toMatchObject({
        last_used_at: firstUseAt().toISOString(),
        revoked_at: laterUseAt().toISOString()
      });
      expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: newerUseAt() }),
        "device_revoked"
      );
    } finally {
      open.db.close();
    }
  });

  it("preserves the greatest time across reopen with indexed hash lookup and no raw secret bytes", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: createdAt });
    try {
      const repository = createAuthDeviceRepository(first.db);
      createDevice(repository);
      repository.authenticateDeviceToken({ rawDeviceToken, now: laterUseAt() });
      const plan = first.db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM auth_devices WHERE token_hash = ?")
        .all(hashSecret(rawDeviceToken, { minLength: 24 })) as Array<{ readonly detail: string }>;
      expect(plan.some(({ detail }) => /SEARCH auth_devices USING INDEX .+ \(token_hash=\?\)/u.test(detail))).toBe(true);
    } finally {
      first.db.close();
    }

    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from(rawDeviceToken))).toBe(false);
    expect(bytes.includes(Buffer.from(rawCsrfToken))).toBe(false);

    const reopened = openMigratedDatabase(path, { now: createdAt });
    try {
      const repository = createAuthDeviceRepository(reopened.db);
      expect(repository.require("client_monotonic_auth").last_used_at).toBe(laterUseAt().toISOString());
      expectAuthError(
        () => repository.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() }),
        "authentication_conflict"
      );
      expect(repository.authenticateDeviceToken({ rawDeviceToken, now: newerUseAt() }).device.last_used_at).toBe(
        newerUseAt().toISOString()
      );
    } finally {
      reopened.db.close();
    }
  });
});

function createDevice(
  repository: ReturnType<typeof createAuthDeviceRepository>,
  overrides: Partial<Parameters<ReturnType<typeof createAuthDeviceRepository>["create"]>[0]> = {}
) {
  return repository.create({
    id: "client_monotonic_auth",
    rawDeviceToken,
    rawCsrfToken,
    permission: "write",
    clientLabel: "monotonic-phone",
    createdAt: createdAt(),
    ...overrides
  });
}

function rawDeviceRow(db: Database.Database, id: string): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Missing auth device ${id}.`);
  return row as Readonly<Record<string, unknown>>;
}

function allDeviceRows(db: Database.Database): readonly Readonly<Record<string, unknown>>[] {
  return db.prepare("SELECT * FROM auth_devices ORDER BY id").all() as Readonly<Record<string, unknown>>[];
}

function expectAuthError(fn: () => unknown, code: AuthRepositoryErrorCode): HostDeckAuthRepositoryError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckAuthRepositoryError);
  expect((caught as HostDeckAuthRepositoryError).code).toBe(code);
  return caught as HostDeckAuthRepositoryError;
}

function startAuthWriter(
  path: string,
  operation: "revoke" | "touch",
  at: string
): { readonly updated: Promise<void>; readonly completed: Promise<void> } {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      const column = workerData.operation === "touch" ? "last_used_at" : "revoked_at";
      const update = db.prepare("UPDATE auth_devices SET " + column + " = ? WHERE id = ?")
        .run(workerData.at, "client_monotonic_auth");
      if (update.changes !== 1) throw new Error("worker auth write lost");
      parentPort.postMessage("updated");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: { at, databaseModule: betterSqlite3Path, operation, path }
    }
  );
  const updated = new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (message === "updated") resolve();
    });
    worker.once("error", reject);
  });
  const completed = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Auth writer exited with code ${code}.`));
    });
  });
  return { completed, updated };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-auth-last-used-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function createdAt(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function firstUseAt(): Date {
  return new Date("2026-07-08T22:01:00.000Z");
}

function laterUseAt(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}

function newerUseAt(): Date {
  return new Date("2026-07-08T22:10:00.000Z");
}
