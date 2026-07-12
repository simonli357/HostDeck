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
  HostDeckAuthRepositoryError,
  hashSecret
} from "./auth-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";

const tempDirs: string[] = [];
const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve("better-sqlite3");
const rawDeviceToken = "device_token_for_csrf_bootstrap_123456";
const initialCsrfToken = "csrf_initial_for_bootstrap_123456";
const rotatedCsrfTokenA = "csrf_rotated_a_for_bootstrap_123456";
const rotatedCsrfTokenB = "csrf_rotated_b_for_bootstrap_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("CSRF bootstrap rotation repository", () => {
  it("initializes generation one and returns one frozen CSPRNG bootstrap result without durable raw data", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });

    try {
      const repository = createAuthDeviceRepository(open.db);
      const created = createDevice(repository);
      expect(created).toMatchObject({
        csrf_generation: 1,
        csrf_rotated_at: fixedNow().toISOString(),
        last_used_at: null
      });

      const rotation = repository.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() });
      expect(Object.isFrozen(rotation)).toBe(true);
      expect(Object.keys(rotation).sort()).toEqual(["csrfGeneration", "deviceId", "rawCsrfToken", "rotatedAt"]);
      expect(rotation).toMatchObject({
        deviceId: "client_csrf",
        csrfGeneration: 2,
        rotatedAt: laterNow().toISOString()
      });
      expect(rotation.rawCsrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      const stored = rawDeviceRow(open.db, "client_csrf");
      expect(stored).toMatchObject({
        csrf_token_hash: hashSecret(rotation.rawCsrfToken, { minLength: 24 }),
        csrf_generation: 2,
        csrf_rotated_at: laterNow().toISOString(),
        last_used_at: null
      });
      expect(JSON.stringify(stored)).not.toContain(rawDeviceToken);
      expect(JSON.stringify(stored)).not.toContain(initialCsrfToken);
      expect(JSON.stringify(stored)).not.toContain(rotation.rawCsrfToken);

      expectAuthError(
        () => repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: initialCsrfToken, now: laterNow() }),
        "csrf_mismatch"
      );
      expect(
        repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: rotation.rawCsrfToken, now: laterNow() }).id
      ).toBe("client_csrf");
    } finally {
      open.db.close();
    }
  });

  it("rotates repeatedly at one clock tick and keeps only the newest token current", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    const tokens = [rotatedCsrfTokenA, rotatedCsrfTokenB];

    try {
      const repository = createAuthDeviceRepository(open.db, {
        generateCsrfToken: () => {
          const token = tokens.shift();
          if (token === undefined) throw new Error("token fixture exhausted");
          return token;
        }
      });
      createDevice(repository);

      const first = repository.rotateCsrfBootstrap({ rawDeviceToken, now: fixedNow() });
      const second = repository.rotateCsrfBootstrap({ rawDeviceToken, now: fixedNow() });
      expect(first).toMatchObject({ csrfGeneration: 2, rotatedAt: fixedNow().toISOString() });
      expect(second).toMatchObject({ csrfGeneration: 3, rotatedAt: fixedNow().toISOString() });
      expectAuthError(
        () => repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: rotatedCsrfTokenA, now: laterNow() }),
        "csrf_mismatch"
      );
      expect(
        repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: rotatedCsrfTokenB, now: laterNow() })
          .csrf_generation
      ).toBe(3);
    } finally {
      open.db.close();
    }
  });

  it("allows read-only devices to bootstrap but rejects missing, revoked, and expired devices before entropy use", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    let generated = 0;

    try {
      const repository = createAuthDeviceRepository(open.db, {
        generateCsrfToken: () => {
          generated += 1;
          return `${rotatedCsrfTokenA}_${generated}`;
        }
      });
      createDevice(repository, {
        id: "client_read_csrf",
        rawDeviceToken: "device_token_for_read_csrf_bootstrap_123",
        rawCsrfToken: "csrf_initial_for_read_bootstrap_123456",
        permission: "read"
      });
      expect(
        repository.rotateCsrfBootstrap({
          rawDeviceToken: "device_token_for_read_csrf_bootstrap_123",
          now: laterNow()
        }).csrfGeneration
      ).toBe(2);
      expect(generated).toBe(1);

      expectAuthError(
        () => repository.rotateCsrfBootstrap({ rawDeviceToken: "missing_device_token_for_bootstrap_123", now: laterNow() }),
        "device_not_found"
      );

      createDevice(repository, {
        id: "client_revoked_csrf",
        rawDeviceToken: "device_token_for_revoked_bootstrap_123",
        rawCsrfToken: "csrf_initial_for_revoked_bootstrap_123",
        permission: "write"
      });
      repository.revokeLegacy("client_revoked_csrf", { now: laterNow() });
      expectAuthError(
        () =>
          repository.rotateCsrfBootstrap({
            rawDeviceToken: "device_token_for_revoked_bootstrap_123",
            now: laterNow()
          }),
        "device_revoked"
      );

      createDevice(repository, {
        id: "client_expired_csrf",
        rawDeviceToken: "device_token_for_expired_bootstrap_123",
        rawCsrfToken: "csrf_initial_for_expired_bootstrap_123",
        permission: "write",
        expiresAt: fixedNow()
      });
      expectAuthError(
        () =>
          repository.rotateCsrfBootstrap({
            rawDeviceToken: "device_token_for_expired_bootstrap_123",
            now: fixedNow()
          }),
        "device_expired"
      );

      createDevice(repository, {
        id: "client_corrupt_csrf",
        rawDeviceToken: "device_token_for_corrupt_bootstrap_123",
        rawCsrfToken: "csrf_initial_for_corrupt_bootstrap_123",
        permission: "write"
      });
      open.db
        .prepare("UPDATE auth_devices SET csrf_rotated_at = 'not-a-time' WHERE id = ?")
        .run("client_corrupt_csrf");
      const corruptBefore = rawDeviceRow(open.db, "client_corrupt_csrf");
      expectAuthError(
        () =>
          repository.rotateCsrfBootstrap({
            rawDeviceToken: "device_token_for_corrupt_bootstrap_123",
            now: laterNow()
          }),
        "invalid_auth_device"
      );
      expect(generated).toBe(1);
      expect(rawDeviceRow(open.db, "client_corrupt_csrf")).toEqual(corruptBefore);
    } finally {
      open.db.close();
    }
  });

  it("rejects invalid or regressing time before entropy generation and preserves the prior row", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    let generated = 0;

    try {
      const repository = createAuthDeviceRepository(open.db, {
        generateCsrfToken: () => {
          generated += 1;
          return rotatedCsrfTokenA;
        }
      });
      createDevice(repository);
      repository.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() });
      const before = rawDeviceRow(open.db, "client_csrf");

      expectAuthError(
        () => repository.rotateCsrfBootstrap({ rawDeviceToken, now: new Date(Number.NaN) }),
        "invalid_time"
      );
      expectAuthError(
        () => repository.rotateCsrfBootstrap({ rawDeviceToken, now: new Date("2026-07-08T22:04:59.999Z") }),
        "csrf_rotation_conflict"
      );
      expect(generated).toBe(1);
      expect(rawDeviceRow(open.db, "client_csrf")).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed, throwing, duplicate, and exhausted generation without mutation or secret-bearing errors", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createDevice(createAuthDeviceRepository(open.db));
      const before = rawDeviceRow(open.db, "client_csrf");

      const throwing = createAuthDeviceRepository(open.db, {
        generateCsrfToken: () => {
          throw new Error(`generator leaked ${rotatedCsrfTokenA}`);
        }
      });
      const generationError = expectAuthError(
        () => throwing.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() }),
        "csrf_rotation_failed"
      );
      expect(JSON.stringify(generationError)).not.toContain(rotatedCsrfTokenA);

      const malformed = createAuthDeviceRepository(open.db, { generateCsrfToken: () => "short" });
      expectAuthError(
        () => malformed.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() }),
        "invalid_secret"
      );

      const duplicate = createAuthDeviceRepository(open.db, { generateCsrfToken: () => initialCsrfToken });
      expectAuthError(
        () => duplicate.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() }),
        "duplicate_secret"
      );
      expect(rawDeviceRow(open.db, "client_csrf")).toEqual(before);

      open.db
        .prepare("UPDATE auth_devices SET csrf_generation = ? WHERE id = ?")
        .run(Number.MAX_SAFE_INTEGER, "client_csrf");
      let exhaustionGeneratorCalled = false;
      const exhausted = createAuthDeviceRepository(open.db, {
        generateCsrfToken: () => {
          exhaustionGeneratorCalled = true;
          return rotatedCsrfTokenB;
        }
      });
      const exhaustedBefore = rawDeviceRow(open.db, "client_csrf");
      expectAuthError(
        () => exhausted.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() }),
        "csrf_generation_exhausted"
      );
      expect(exhaustionGeneratorCalled).toBe(false);
      expect(rawDeviceRow(open.db, "client_csrf")).toEqual(exhaustedBefore);
    } finally {
      open.db.close();
    }
  });

  it("rolls back a forced update failure and keeps the prior token usable", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });

    try {
      const repository = createAuthDeviceRepository(open.db, { generateCsrfToken: () => rotatedCsrfTokenA });
      createDevice(repository);
      const before = rawDeviceRow(open.db, "client_csrf");
      open.db.exec(`
        CREATE TRIGGER fail_csrf_rotation
        BEFORE UPDATE OF csrf_token_hash ON auth_devices
        BEGIN
          SELECT RAISE(ABORT, 'forced csrf rotation failure');
        END;
      `);

      expectAuthError(
        () => repository.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() }),
        "csrf_rotation_failed"
      );
      expect(rawDeviceRow(open.db, "client_csrf")).toEqual(before);
      expect(readFileSync(path).includes(Buffer.from(rotatedCsrfTokenA))).toBe(false);

      open.db.exec("DROP TRIGGER fail_csrf_rotation");
      expect(
        repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: initialCsrfToken, now: laterNow() }).id
      ).toBe("client_csrf");
    } finally {
      open.db.close();
    }
  });

  it("serializes a real worker-held writer and preserves one monotonic newest token", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });

    try {
      open.db.pragma("busy_timeout = 2000");
      createDevice(createAuthDeviceRepository(open.db));
      const worker = startConcurrentCsrfRotation(path, rotatedCsrfTokenA, laterNow().toISOString());
      await worker.updated;

      const repository = createAuthDeviceRepository(open.db, { generateCsrfToken: () => rotatedCsrfTokenB });
      const rotation = repository.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() });
      await worker.completed;

      expect(rotation.csrfGeneration).toBe(3);
      expect(rawDeviceRow(open.db, "client_csrf")).toMatchObject({
        csrf_token_hash: hashSecret(rotatedCsrfTokenB, { minLength: 24 }),
        csrf_generation: 3,
        csrf_rotated_at: laterNow().toISOString()
      });
      expectAuthError(
        () => repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: rotatedCsrfTokenA, now: laterNow() }),
        "csrf_mismatch"
      );
      expect(
        repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: rotatedCsrfTokenB, now: laterNow() }).id
      ).toBe("client_csrf");
    } finally {
      open.db.close();
    }
  });

  it("persists generation across reopen while raw bearer and CSRF values stay absent from SQLite bytes", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });

    try {
      const repository = createAuthDeviceRepository(first.db, { generateCsrfToken: () => rotatedCsrfTokenA });
      createDevice(repository);
      repository.rotateCsrfBootstrap({ rawDeviceToken, now: laterNow() });
    } finally {
      first.db.close();
    }

    const bytes = readFileSync(path);
    for (const rawSecret of [rawDeviceToken, initialCsrfToken, rotatedCsrfTokenA]) {
      expect(bytes.includes(Buffer.from(rawSecret))).toBe(false);
    }

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createAuthDeviceRepository(reopened.db, { generateCsrfToken: () => rotatedCsrfTokenB });
      expect(repository.require("client_csrf")).toMatchObject({
        csrf_generation: 2,
        csrf_rotated_at: laterNow().toISOString()
      });
      expect(
        repository.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken: rotatedCsrfTokenA, now: laterNow() }).id
      ).toBe("client_csrf");
      expect(
        repository.rotateCsrfBootstrap({ rawDeviceToken, now: new Date("2026-07-08T22:06:00.000Z") })
          .csrfGeneration
      ).toBe(3);
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
    id: "client_csrf",
    rawDeviceToken,
    rawCsrfToken: initialCsrfToken,
    permission: "write",
    clientLabel: "csrf-phone",
    createdAt: fixedNow(),
    ...overrides
  });
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

function rawDeviceRow(db: Database.Database, deviceId: string): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(deviceId);
  if (row === undefined) throw new Error(`Missing auth device ${deviceId}.`);
  return row as Readonly<Record<string, unknown>>;
}

function startConcurrentCsrfRotation(
  path: string,
  rawCsrfToken: string,
  rotatedAt: string
): { readonly updated: Promise<void>; readonly completed: Promise<void> } {
  const worker = new Worker(
    `
      const { createHash } = require("node:crypto");
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      const current = db.prepare("SELECT csrf_generation FROM auth_devices WHERE id = ?").get("client_csrf");
      const hash = "sha256:" + createHash("sha256").update(workerData.rawCsrfToken).digest("hex");
      const update = db.prepare(
        "UPDATE auth_devices SET csrf_token_hash = ?, csrf_generation = ?, csrf_rotated_at = ? " +
        "WHERE id = ? AND csrf_generation = ?"
      ).run(hash, current.csrf_generation + 1, workerData.rotatedAt, "client_csrf", current.csrf_generation);
      if (update.changes !== 1) throw new Error("worker rotation lost");
      parentPort.postMessage("updated");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: {
        databaseModule: betterSqlite3Path,
        path,
        rawCsrfToken,
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
      else reject(new Error(`CSRF rotation worker exited with code ${code}.`));
    });
  });
  return { updated, completed };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-csrf-bootstrap-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
