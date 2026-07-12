import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const betterSqlite3Path = createRequire(import.meta.url).resolve("better-sqlite3");
const deviceId = `client_${"c".repeat(24)}`;
const readDeviceId = `client_${"r".repeat(24)}`;
const rawDeviceToken = "D".repeat(43);
const initialCsrfToken = "C".repeat(43);
const rotatedCsrfToken = "R".repeat(43);
const nextCsrfToken = "N".repeat(43);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("selected authenticated-device CSRF repository", () => {
  it("rotates and authorizes exact contextual authority across restart without raw durable secrets", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: createdAt });
    try {
      createDevice(first.db);
      const repository = createSelectedCsrfAuthorizationRepository(first.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      expect(Object.isFrozen(repository)).toBe(true);
      const rotation = repository.rotateBootstrap({
        deviceId,
        expectedCsrfGeneration: 1,
        now: rotationAt()
      });
      expect(rotation).toEqual({
        deviceId,
        rawCsrfToken: rotatedCsrfToken,
        csrfGeneration: 2,
        rotatedAt: rotationAt().toISOString()
      });
      expect(Object.isFrozen(rotation)).toBe(true);
      expect(rawDeviceRow(first.db, deviceId)).toMatchObject({
        csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 }),
        csrf_generation: 2,
        csrf_rotated_at: rotationAt().toISOString(),
        last_used_at: null
      });

      expectAuthError(
        () =>
          repository.authorizeBrowserWrite({
            deviceId,
            expectedCsrfGeneration: 1,
            rawCsrfToken: initialCsrfToken,
            now: useAt()
          }),
        "csrf_mismatch"
      );
      const authorization = repository.authorizeBrowserWrite({
        deviceId,
        expectedCsrfGeneration: 2,
        rawCsrfToken: rotatedCsrfToken,
        now: useAt()
      });
      expect(authorization).toMatchObject({
        trusted: true,
        readOnly: false,
        device: {
          id: deviceId,
          csrf_generation: 2,
          last_used_at: useAt().toISOString()
        }
      });
      expect(Object.isFrozen(authorization)).toBe(true);
      expect(Object.isFrozen(authorization.device)).toBe(true);
      const plan = first.db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM auth_devices WHERE id = ?")
        .all(deviceId) as Array<{ readonly detail: string }>;
      expect(plan.some(({ detail }) => /INDEX .+ \(id=\?\)/u.test(detail))).toBe(true);
    } finally {
      first.db.close();
    }

    for (const file of sqliteFiles(path)) {
      const bytes = readFileSync(file);
      for (const secret of [rawDeviceToken, initialCsrfToken, rotatedCsrfToken]) {
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
      }
    }

    const reopened = openMigratedDatabase(path, { now: createdAt });
    try {
      const repository = createSelectedCsrfAuthorizationRepository(reopened.db, {
        generateCsrfToken: () => nextCsrfToken
      });
      expectAuthError(
        () =>
          repository.authorizeBrowserWrite({
            deviceId,
            expectedCsrfGeneration: 2,
            rawCsrfToken: rotatedCsrfToken,
            now: rotationAt()
          }),
        "authentication_conflict"
      );
      expect(
        repository.rotateBootstrap({
          deviceId,
          expectedCsrfGeneration: 2,
          now: laterAt()
        }).csrfGeneration
      ).toBe(3);
      expect(rawDeviceRow(reopened.db, deviceId)).toMatchObject({
        csrf_generation: 3,
        csrf_token_hash: hashSecret(nextCsrfToken, { minLength: 24 }),
        last_used_at: useAt().toISOString()
      });
    } finally {
      reopened.db.close();
    }
  });

  it("lets read devices rotate but never authorize a selected browser write", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      createDevice(open.db, {
        id: readDeviceId,
        permission: "read",
        rawDeviceToken: "E".repeat(43),
        rawCsrfToken: "F".repeat(43)
      });
      const repository = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      expect(
        repository.rotateBootstrap({
          deviceId: readDeviceId,
          expectedCsrfGeneration: 1,
          now: rotationAt()
        }).csrfGeneration
      ).toBe(2);
      const before = rawDeviceRow(open.db, readDeviceId);
      expectAuthError(
        () =>
          repository.authorizeBrowserWrite({
            deviceId: readDeviceId,
            expectedCsrfGeneration: 2,
            rawCsrfToken: rotatedCsrfToken,
            now: useAt()
          }),
        "read_only"
      );
      expect(rawDeviceRow(open.db, readDeviceId)).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("rejects exact-input and entropy failures before mutating selected authority", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    let entropyCalls = 0;
    try {
      createDevice(open.db);
      const before = rawDeviceRow(open.db, deviceId);
      expectAuthError(
        () =>
          createSelectedCsrfAuthorizationRepository(open.db, {
            generateCsrfToken: "not-a-function" as never
          }),
        "invalid_csrf_authorization"
      );
      const repository = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => {
          entropyCalls += 1;
          return rotatedCsrfToken;
        }
      });
      const accessor = Object.defineProperty({}, "deviceId", {
        enumerable: true,
        get() {
          throw new Error("private-accessor-sentinel");
        }
      });
      const invalid = [
        null,
        {},
        accessor,
        { deviceId, expectedCsrfGeneration: 1 },
        { deviceId, expectedCsrfGeneration: 1, now: rotationAt(), extra: true },
        Object.assign(Object.create({ inherited: true }), {
          deviceId,
          expectedCsrfGeneration: 1,
          now: rotationAt()
        }),
        { deviceId: "client invalid", expectedCsrfGeneration: 1, now: rotationAt() },
        { deviceId, expectedCsrfGeneration: 0, now: rotationAt() },
        { deviceId, expectedCsrfGeneration: 1.5, now: rotationAt() },
        { deviceId, expectedCsrfGeneration: 1, now: new Date(Number.NaN) }
      ];
      for (const candidate of invalid) {
        const error = expectAuthError(
          () => repository.rotateBootstrap(candidate as never),
          "invalid_csrf_authorization"
        );
        expect(JSON.stringify(error)).not.toContain("private-accessor-sentinel");
      }
      expect(entropyCalls).toBe(0);
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);

      for (const generated of ["short", `${"A".repeat(42)}=`, "A".repeat(44)]) {
        const malformed = createSelectedCsrfAuthorizationRepository(open.db, {
          generateCsrfToken: () => generated
        });
        expectAuthError(
          () =>
            malformed.rotateBootstrap({
              deviceId,
              expectedCsrfGeneration: 1,
              now: rotationAt()
            }),
          "csrf_rotation_failed"
        );
        expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      }
    } finally {
      open.db.close();
    }
  });

  it("rejects missing, expired, revoked, stale-generation, and wrong-token authority without touch", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      createDevice(open.db);
      createDevice(open.db, {
        id: `client_${"e".repeat(24)}`,
        rawDeviceToken: "X".repeat(43),
        rawCsrfToken: "Y".repeat(43),
        expiresAt: rotationAt()
      });
      createDevice(open.db, {
        id: `client_${"v".repeat(24)}`,
        rawDeviceToken: "V".repeat(43),
        rawCsrfToken: "W".repeat(43)
      });
      createDeviceRevocationRepository(open.db).revoke({
        deviceId: `client_${"v".repeat(24)}`,
        now: rotationAt()
      });
      const repository = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      const before = allDeviceRows(open.db);

      const cases: ReadonlyArray<
        readonly [() => unknown, AuthRepositoryErrorCode]
      > = [
        [
          () =>
            repository.rotateBootstrap({
              deviceId: `client_${"m".repeat(24)}`,
              expectedCsrfGeneration: 1,
              now: rotationAt()
            }),
          "device_not_found"
        ],
        [
          () =>
            repository.rotateBootstrap({
              deviceId: `client_${"e".repeat(24)}`,
              expectedCsrfGeneration: 1,
              now: rotationAt()
            }),
          "device_expired"
        ],
        [
          () =>
            repository.rotateBootstrap({
              deviceId: `client_${"v".repeat(24)}`,
              expectedCsrfGeneration: 1,
              now: useAt()
            }),
          "device_revoked"
        ],
        [
          () =>
            repository.rotateBootstrap({
              deviceId,
              expectedCsrfGeneration: 2,
              now: rotationAt()
            }),
          "csrf_rotation_conflict"
        ],
        [
          () =>
            repository.authorizeBrowserWrite({
              deviceId,
              expectedCsrfGeneration: 2,
              rawCsrfToken: initialCsrfToken,
              now: useAt()
            }),
          "csrf_mismatch"
        ],
        [
          () =>
            repository.authorizeBrowserWrite({
              deviceId,
              expectedCsrfGeneration: 1,
              rawCsrfToken: "Z".repeat(43),
              now: useAt()
            }),
          "csrf_mismatch"
        ]
      ];
      for (const [work, code] of cases) expectAuthError(work, code);
      expect(allDeviceRows(open.db)).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("serializes a real competing generation writer and preserves its winner", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: createdAt });
    try {
      open.db.pragma("busy_timeout = 2000");
      createDevice(open.db);
      const winnerAt = rotationAt().toISOString();
      const winnerHash = hashSecret(rotatedCsrfToken, { minLength: 24 });
      const worker = startGenerationWriter(path, winnerHash, winnerAt);
      await worker.updated;

      expectAuthError(
        () =>
          createSelectedCsrfAuthorizationRepository(open.db, {
            generateCsrfToken: () => nextCsrfToken
          }).rotateBootstrap({
            deviceId,
            expectedCsrfGeneration: 1,
            now: useAt()
          }),
        "csrf_rotation_conflict"
      );
      await worker.completed;
      expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
        csrf_generation: 2,
        csrf_token_hash: winnerHash,
        csrf_rotated_at: winnerAt
      });
    } finally {
      open.db.close();
    }
  });

  it("preserves rotate-then-revoke ordering and rejects exhausted generation before entropy", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    let entropyCalls = 0;
    try {
      createDevice(open.db);
      const exhaustedId = `client_${"x".repeat(24)}`;
      createDevice(open.db, {
        id: exhaustedId,
        rawDeviceToken: "Q".repeat(43),
        rawCsrfToken: "S".repeat(43)
      });
      open.db
        .prepare("UPDATE auth_devices SET csrf_generation = ? WHERE id = ?")
        .run(Number.MAX_SAFE_INTEGER, exhaustedId);
      const repository = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => {
          entropyCalls += 1;
          return rotatedCsrfToken;
        }
      });

      expect(
        repository.rotateBootstrap({
          deviceId,
          expectedCsrfGeneration: 1,
          now: rotationAt()
        }).csrfGeneration
      ).toBe(2);
      expect(entropyCalls).toBe(1);
      createDeviceRevocationRepository(open.db).revoke({
        deviceId,
        now: useAt()
      });
      expectAuthError(
        () =>
          repository.authorizeBrowserWrite({
            deviceId,
            expectedCsrfGeneration: 2,
            rawCsrfToken: rotatedCsrfToken,
            now: laterAt()
          }),
        "device_revoked"
      );
      expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
        csrf_generation: 2,
        csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 }),
        revoked_at: useAt().toISOString()
      });

      const exhaustedBefore = rawDeviceRow(open.db, exhaustedId);
      expectAuthError(
        () =>
          repository.rotateBootstrap({
            deviceId: exhaustedId,
            expectedCsrfGeneration: Number.MAX_SAFE_INTEGER,
            now: rotationAt()
          }),
        "csrf_generation_exhausted"
      );
      expect(entropyCalls).toBe(1);
      expect(rawDeviceRow(open.db, exhaustedId)).toEqual(exhaustedBefore);
    } finally {
      open.db.close();
    }
  });

  it("rolls back forced rotation, touch, and deferred commit failures", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      createDevice(open.db);
      const repository = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      const before = rawDeviceRow(open.db, deviceId);
      open.db.exec(`
        CREATE TRIGGER fail_selected_csrf_rotation
        BEFORE UPDATE OF csrf_generation ON auth_devices
        BEGIN
          SELECT RAISE(ABORT, 'forced selected rotation failure');
        END;
      `);
      const rotationError = expectAuthError(
        () =>
          repository.rotateBootstrap({
            deviceId,
            expectedCsrfGeneration: 1,
            now: rotationAt()
          }),
        "csrf_rotation_failed"
      );
      expect(rotationError.cause).toBeUndefined();
      expect(JSON.stringify(rotationError)).not.toContain(rotatedCsrfToken);
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      open.db.exec("DROP TRIGGER fail_selected_csrf_rotation");

      open.db.exec(`
        CREATE TRIGGER fail_selected_csrf_touch
        BEFORE UPDATE OF last_used_at ON auth_devices
        BEGIN
          SELECT RAISE(ABORT, 'forced selected touch failure');
        END;
      `);
      const touchError = expectAuthError(
        () =>
          repository.authorizeBrowserWrite({
            deviceId,
            expectedCsrfGeneration: 1,
            rawCsrfToken: initialCsrfToken,
            now: useAt()
          }),
        "authentication_failed"
      );
      expect(touchError.cause).toBeUndefined();
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      open.db.exec("DROP TRIGGER fail_selected_csrf_touch");

      open.db.exec(`
        CREATE TABLE selected_csrf_commit_probe (
          missing_device_id TEXT NOT NULL,
          FOREIGN KEY (missing_device_id) REFERENCES auth_devices(id)
            DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_selected_csrf_commit
        AFTER UPDATE OF last_used_at ON auth_devices
        BEGIN
          INSERT INTO selected_csrf_commit_probe (missing_device_id)
          VALUES ('missing_selected_csrf_device');
        END;
      `);
      expectAuthError(
        () =>
          repository.authorizeBrowserWrite({
            deviceId,
            expectedCsrfGeneration: 1,
            rawCsrfToken: initialCsrfToken,
            now: useAt()
          }),
        "authentication_failed"
      );
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      expect(
        open.db.prepare("SELECT COUNT(*) AS count FROM selected_csrf_commit_probe").get()
      ).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });

  it("fails loudly for corrupt, closed, and read-only storage", () => {
    const path = tempDbPath();
    const writable = openMigratedDatabase(path, { now: createdAt });
    createDevice(writable.db);
    const corrupt = createSelectedCsrfAuthorizationRepository(writable.db, {
      generateCsrfToken: () => rotatedCsrfToken
    });
    writable.db
      .prepare("UPDATE auth_devices SET csrf_rotated_at = 'not-a-time' WHERE id = ?")
      .run(deviceId);
    expectAuthError(
      () =>
        corrupt.rotateBootstrap({
          deviceId,
          expectedCsrfGeneration: 1,
          now: rotationAt()
        }),
      "invalid_auth_device"
    );
    writable.db
      .prepare("UPDATE auth_devices SET csrf_rotated_at = ? WHERE id = ?")
      .run(createdAt().toISOString(), deviceId);
    const closed = createSelectedCsrfAuthorizationRepository(writable.db, {
      generateCsrfToken: () => rotatedCsrfToken
    });
    writable.db.close();
    expectAuthError(
      () =>
        closed.rotateBootstrap({
          deviceId,
          expectedCsrfGeneration: 1,
          now: rotationAt()
        }),
      "csrf_rotation_failed"
    );

    const readOnly = openMigratedDatabase(path, { now: createdAt, readonly: true });
    try {
      const repository = createSelectedCsrfAuthorizationRepository(readOnly.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      expectAuthError(
        () =>
          repository.rotateBootstrap({
            deviceId,
            expectedCsrfGeneration: 1,
            now: rotationAt()
          }),
        "csrf_rotation_failed"
      );
      expectAuthError(
        () =>
          repository.authorizeBrowserWrite({
            deviceId,
            expectedCsrfGeneration: 1,
            rawCsrfToken: initialCsrfToken,
            now: useAt()
          }),
        "authentication_failed"
      );
    } finally {
      readOnly.db.close();
    }
  });
});

function createDevice(
  db: Database.Database,
  overrides: Partial<
    Parameters<ReturnType<typeof createAuthDeviceRepository>["create"]>[0]
  > = {}
): void {
  createAuthDeviceRepository(db).create({
    id: deviceId,
    rawDeviceToken,
    rawCsrfToken: initialCsrfToken,
    permission: "write",
    clientLabel: "selected-csrf-phone",
    createdAt: createdAt(),
    ...overrides
  });
}

function rawDeviceRow(
  db: Database.Database,
  id: string
): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Missing auth device ${id}.`);
  return row as Readonly<Record<string, unknown>>;
}

function allDeviceRows(
  db: Database.Database
): readonly Readonly<Record<string, unknown>>[] {
  return db.prepare("SELECT * FROM auth_devices ORDER BY id").all() as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
}

function expectAuthError(
  work: () => unknown,
  code: AuthRepositoryErrorCode
): HostDeckAuthRepositoryError {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckAuthRepositoryError);
  expect((caught as HostDeckAuthRepositoryError).code).toBe(code);
  return caught as HostDeckAuthRepositoryError;
}

function startGenerationWriter(
  path: string,
  csrfHash: string,
  rotatedAt: string
): { readonly updated: Promise<void>; readonly completed: Promise<void> } {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      const update = db.prepare(
        "UPDATE auth_devices SET csrf_token_hash = ?, csrf_generation = 2, csrf_rotated_at = ? WHERE id = ?"
      ).run(workerData.csrfHash, workerData.rotatedAt, workerData.deviceId);
      if (update.changes !== 1) throw new Error("worker selected CSRF write lost");
      parentPort.postMessage("updated");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: {
        csrfHash,
        databaseModule: betterSqlite3Path,
        deviceId,
        path,
        rotatedAt
      }
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
      else reject(new Error(`Selected CSRF writer exited with code ${code}.`));
    });
  });
  return { completed, updated };
}

function sqliteFiles(path: string): readonly string[] {
  return [path, `${path}-wal`, `${path}-shm`].filter(existsSync);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-selected-csrf-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function createdAt(): Date {
  return new Date("2026-07-12T15:00:00.000Z");
}

function rotationAt(): Date {
  return new Date("2026-07-12T15:01:00.000Z");
}

function useAt(): Date {
  return new Date("2026-07-12T15:02:00.000Z");
}

function laterAt(): Date {
  return new Date("2026-07-12T15:03:00.000Z");
}
