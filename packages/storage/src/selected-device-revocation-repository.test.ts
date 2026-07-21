import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
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
const rawDeviceToken = "D".repeat(43);
const initialCsrfToken = "C".repeat(43);
const rotatedCsrfToken = "R".repeat(43);
const deviceId = "client_selected_revoke";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected device revocation repository", () => {
  it("commits one minimal frozen result and invalidates bearer, browser-write, and bootstrap authority", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    let bootstrapEntropyCalls = 0;
    try {
      const auth = createAuthDeviceRepository(open.db);
      const csrf = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      createDevice(auth);
      auth.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() });
      csrf.rotateBootstrap({ deviceId, expectedCsrfGeneration: 1, now: rotationAt() });
      const before = rawDeviceRow(open.db, deviceId);
      const unrelatedBefore = unrelatedTableCounts(open.db);

      const repository = createDeviceRevocationRepository(open.db);
      const result = repository.revoke({ deviceId, now: revokeAt() });
      expect(result).toEqual({
        deviceId,
        revokedAt: revokeAt().toISOString(),
        previouslyRevoked: false,
        authorityInvalidated: true
      });
      expect(Object.keys(result).sort()).toEqual([
        "authorityInvalidated",
        "deviceId",
        "previouslyRevoked",
        "revokedAt"
      ]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/hash|token|generation|permission|label|expires|lastUsed/iu);
      expect(rawDeviceRow(open.db, deviceId)).toEqual({ ...before, revoked_at: revokeAt().toISOString() });
      expect(unrelatedTableCounts(open.db)).toEqual(unrelatedBefore);

      const revokedAuth = createAuthDeviceRepository(open.db);
      const revokedCsrf = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => {
          bootstrapEntropyCalls += 1;
          return "N".repeat(43);
        }
      });
      expectAuthError(
        () => revokedAuth.authenticateDeviceToken({ rawDeviceToken, now: afterRevokeAt() }),
        "device_revoked"
      );
      expectAuthError(
        () =>
          revokedCsrf.authorizeBrowserWrite({
            deviceId,
            expectedCsrfGeneration: 2,
            rawCsrfToken: rotatedCsrfToken,
            now: afterRevokeAt()
          }),
        "device_revoked"
      );
      expectAuthError(
        () => revokedCsrf.rotateBootstrap({ deviceId, expectedCsrfGeneration: 2, now: afterRevokeAt() }),
        "device_revoked"
      );
      expect(bootstrapEntropyCalls).toBe(0);

      const plan = open.db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM auth_devices WHERE id = ?")
        .all(deviceId) as Array<{ readonly detail: string }>;
      expect(plan.some(({ detail }) => /SEARCH auth_devices USING INDEX .+ \(id=\?\)/u.test(detail))).toBe(true);
    } finally {
      open.db.close();
    }
  });

  it("preserves first-winner time across equal/later repeats and permits expired read-only revocation", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      const auth = createAuthDeviceRepository(open.db);
      createDevice(auth, {
        id: "client_expired_read_revoke",
        rawDeviceToken: "E".repeat(43),
        rawCsrfToken: "F".repeat(43),
        permission: "read",
        expiresAt: firstUseAt()
      });
      const repository = createDeviceRevocationRepository(open.db);
      const first = repository.revoke({ deviceId: "client_expired_read_revoke", now: rotationAt() });
      expect(first).toMatchObject({
        revokedAt: rotationAt().toISOString(),
        previouslyRevoked: false,
        authorityInvalidated: true
      });
      for (const now of [rotationAt(), revokeAt(), afterRevokeAt()]) {
        expect(repository.revoke({ deviceId: "client_expired_read_revoke", now })).toEqual({
          deviceId: "client_expired_read_revoke",
          revokedAt: rotationAt().toISOString(),
          previouslyRevoked: true,
          authorityInvalidated: true
        });
      }
      expectAuthError(
        () => repository.revoke({ deviceId: "client_expired_read_revoke", now: firstUseAt() }),
        "device_revoke_time_conflict"
      );
      expect(rawDeviceRow(open.db, "client_expired_read_revoke").revoked_at).toBe(rotationAt().toISOString());

      createDevice(auth, {
        id: "client_zero_lifetime_revoke",
        rawDeviceToken: "Z".repeat(43),
        rawCsrfToken: "Y".repeat(43),
        expiresAt: createdAt()
      });
      expect(
        repository.revoke({ deviceId: "client_zero_lifetime_revoke", now: createdAt() }).revokedAt
      ).toBe(createdAt().toISOString());

      createDevice(auth, {
        id: "client_offset_revoke",
        rawDeviceToken: "O".repeat(43),
        rawCsrfToken: "P".repeat(43)
      });
      open.db
        .prepare("UPDATE auth_devices SET created_at = ?, csrf_rotated_at = ? WHERE id = ?")
        .run(
          "2026-07-11T16:00:00.000-04:00",
          "2026-07-11T16:00:00.000-04:00",
          "client_offset_revoke"
        );
      expect(
        repository.revoke({ deviceId: "client_offset_revoke", now: firstUseAt() })
      ).toMatchObject({ revokedAt: firstUseAt().toISOString(), previouslyRevoked: false });
      expect(rawDeviceRow(open.db, "client_offset_revoke")).toMatchObject({
        created_at: "2026-07-11T16:00:00.000-04:00",
        csrf_rotated_at: "2026-07-11T16:00:00.000-04:00",
        revoked_at: firstUseAt().toISOString()
      });
    } finally {
      open.db.close();
    }
  });

  it("rejects an observation behind current use or CSRF rotation without changing the row", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      const auth = createAuthDeviceRepository(open.db);
      const csrf = createSelectedCsrfAuthorizationRepository(open.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      createDevice(auth);
      auth.authenticateDeviceToken({ rawDeviceToken, now: firstUseAt() });
      csrf.rotateBootstrap({ deviceId, expectedCsrfGeneration: 1, now: rotationAt() });
      const before = rawDeviceRow(open.db, deviceId);

      expectAuthError(
        () => createDeviceRevocationRepository(open.db).revoke({ deviceId, now: firstUseAt() }),
        "device_revoke_time_conflict"
      );
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed, inherited, accessor, missing, and unknown-device inputs cause-free before mutation", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    const sentinel = "device-revoke-input-private-sentinel";
    try {
      createDevice(createAuthDeviceRepository(open.db));
      const repository = createDeviceRevocationRepository(open.db);
      const before = rawDeviceRow(open.db, deviceId);
      const accessor = Object.defineProperty({}, "deviceId", {
        enumerable: true,
        get() {
          throw new Error(sentinel);
        }
      });
      const invalid: ReadonlyArray<readonly [unknown, AuthRepositoryErrorCode]> = [
        [null, "invalid_device_revoke"],
        [{}, "invalid_device_revoke"],
        [{ deviceId, now: revokeAt(), extra: true }, "invalid_device_revoke"],
        [Object.assign(Object.create({ inherited: true }), { deviceId, now: revokeAt() }), "invalid_device_revoke"],
        [accessor, "invalid_device_revoke"],
        [{ deviceId: "client with spaces", now: revokeAt() }, "invalid_device_revoke"],
        [{ deviceId, now: new Date(Number.NaN) }, "invalid_time"]
      ];
      for (const [input, code] of invalid) {
        const error = expectAuthError(() => repository.revoke(input as never), code);
        expectErrorIsCauseFree(error, sentinel);
      }
      const missingId = "client_missing_private_sentinel";
      expectErrorIsCauseFree(
        expectAuthError(
          () => repository.revoke({ deviceId: missingId, now: revokeAt() }),
          "device_not_found"
        ),
        missingId
      );
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("fails loudly without repair for every corrupt authority chronology and scalar class", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    try {
      const auth = createAuthDeviceRepository(open.db);
      const corruptions = [
        ["client_corrupt_expiry", "expires_at", beforeCreatedAt().toISOString()],
        ["client_corrupt_rotation", "csrf_rotated_at", rotationAt().toISOString()],
        ["client_corrupt_revoke", "revoked_at", beforeCreatedAt().toISOString()],
        ["client_corrupt_hash", "token_hash", "short"],
        ["client_corrupt_time", "csrf_rotated_at", "not-a-time"]
      ] as const;
      for (const [id, column, value] of corruptions) {
        createDevice(auth, {
          id,
          rawDeviceToken: `${id}_device_token_123456789`,
          rawCsrfToken: `${id}_csrf_token_123456789`,
          expiresAt: column === "csrf_rotated_at" && id === "client_corrupt_rotation" ? firstUseAt() : null
        });
        open.db.prepare(`UPDATE auth_devices SET ${column} = ? WHERE id = ?`).run(value, id);
      }
      createDevice(auth, {
        id: "client_corrupt_revoke_rotation",
        rawDeviceToken: "corrupt_revoke_rotation_device_token_123456",
        rawCsrfToken: "corrupt_revoke_rotation_csrf_token_123456"
      });
      open.db
        .prepare("UPDATE auth_devices SET csrf_rotated_at = ?, revoked_at = ? WHERE id = ?")
        .run(rotationAt().toISOString(), firstUseAt().toISOString(), "client_corrupt_revoke_rotation");
      createDevice(auth, {
        id: "client_corrupt_revoke_use",
        rawDeviceToken: "corrupt_revoke_use_device_token_123456789",
        rawCsrfToken: "corrupt_revoke_use_csrf_token_123456789"
      });
      open.db
        .prepare("UPDATE auth_devices SET last_used_at = ?, revoked_at = ? WHERE id = ?")
        .run(rotationAt().toISOString(), firstUseAt().toISOString(), "client_corrupt_revoke_use");
      createDevice(auth, {
        id: "client_corrupt_generation",
        rawDeviceToken: "corrupt_generation_device_token_123456789",
        rawCsrfToken: "corrupt_generation_csrf_token_123456789"
      });
      open.db.pragma("ignore_check_constraints = ON");
      open.db.prepare("UPDATE auth_devices SET csrf_generation = 0 WHERE id = ?").run("client_corrupt_generation");
      open.db.pragma("ignore_check_constraints = OFF");

      const repository = createDeviceRevocationRepository(open.db);
      const ids = [
        ...corruptions.map(([id]) => id),
        "client_corrupt_revoke_rotation",
        "client_corrupt_revoke_use",
        "client_corrupt_generation"
      ];
      for (const id of ids) {
        const before = rawDeviceRow(open.db, id);
        expectAuthError(() => repository.revoke({ deviceId: id, now: revokeAt() }), "invalid_auth_device");
        expect(rawDeviceRow(open.db, id)).toEqual(before);
      }
    } finally {
      open.db.close();
    }
  });

  it("rolls back ignored, cross-field, aborted, and deferred-commit updates", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: createdAt });
    const sqliteSentinel = "forced-device-revoke-private-sentinel";
    try {
      createDevice(createAuthDeviceRepository(open.db));
      const repository = createDeviceRevocationRepository(open.db);
      const before = rawDeviceRow(open.db, deviceId);

      open.db.exec(`
        CREATE TRIGGER ignore_selected_device_revoke
        BEFORE UPDATE OF revoked_at ON auth_devices
        WHEN NEW.id = '${deviceId}'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      expectAuthError(() => repository.revoke({ deviceId, now: revokeAt() }), "device_revoke_failed");
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      open.db.exec("DROP TRIGGER ignore_selected_device_revoke");

      open.db.exec(`
        CREATE TRIGGER mutate_selected_device_revoke
        BEFORE UPDATE OF revoked_at ON auth_devices
        WHEN NEW.id = '${deviceId}'
        BEGIN
          UPDATE auth_devices SET client_label = 'tampered' WHERE id = NEW.id;
        END;
      `);
      expectAuthError(() => repository.revoke({ deviceId, now: revokeAt() }), "device_revoke_failed");
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      open.db.exec("DROP TRIGGER mutate_selected_device_revoke");

      open.db.exec(`
        CREATE TRIGGER abort_selected_device_revoke
        BEFORE UPDATE OF revoked_at ON auth_devices
        WHEN NEW.id = '${deviceId}'
        BEGIN
          SELECT RAISE(ABORT, '${sqliteSentinel}');
        END;
      `);
      expectErrorIsCauseFree(
        expectAuthError(() => repository.revoke({ deviceId, now: revokeAt() }), "device_revoke_failed"),
        sqliteSentinel
      );
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      open.db.exec("DROP TRIGGER abort_selected_device_revoke");

      open.db.exec(`
        CREATE TABLE device_revoke_commit_parent (id TEXT PRIMARY KEY);
        CREATE TABLE device_revoke_commit_probe (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES device_revoke_commit_parent(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_selected_device_revoke_commit
        AFTER UPDATE OF revoked_at ON auth_devices
        WHEN NEW.id = '${deviceId}'
        BEGIN
          INSERT INTO device_revoke_commit_probe (id, parent_id) VALUES (NEW.id, 'missing-parent');
        END;
      `);
      expectAuthError(() => repository.revoke({ deviceId, now: revokeAt() }), "device_revoke_failed");
      expect(rawDeviceRow(open.db, deviceId)).toEqual(before);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM device_revoke_commit_probe").get()).toEqual({ count: 0 });
      open.db.exec("DROP TRIGGER fail_selected_device_revoke_commit");

      expect(repository.revoke({ deviceId, now: revokeAt() }).previouslyRevoked).toBe(false);
    } finally {
      open.db.close();
    }
  });

  it("fails cause-free on closed and read-only storage without a durable transition", () => {
    const path = tempDbPath();
    const writable = openMigratedDatabase(path, { now: createdAt });
    createDevice(createAuthDeviceRepository(writable.db));
    const closedRepository = createDeviceRevocationRepository(writable.db);
    writable.db.close();
    expectAuthError(
      () => closedRepository.revoke({ deviceId, now: revokeAt() }),
      "device_revoke_failed"
    );

    const readOnlyDb = new Database(path, { readonly: true });
    try {
      const readOnly = createDeviceRevocationRepository(readOnlyDb);
      expectAuthError(() => readOnly.revoke({ deviceId, now: revokeAt() }), "device_revoke_failed");
    } finally {
      readOnlyDb.close();
    }
    const reopened = openMigratedDatabase(path, { now: createdAt });
    try {
      expect(rawDeviceRow(reopened.db, deviceId).revoked_at).toBeNull();
    } finally {
      reopened.db.close();
    }
  });

  it("preserves idempotent truth across reopen with no raw credentials or error sentinels in SQLite files", () => {
    const path = tempDbPath();
    const inputSentinel = "device-revoke-error-private-sentinel";
    const first = openMigratedDatabase(path, { now: createdAt });
    first.db.pragma("journal_mode = WAL");
    first.db.pragma("wal_autocheckpoint = 0");
    try {
      const auth = createAuthDeviceRepository(first.db);
      const csrf = createSelectedCsrfAuthorizationRepository(first.db, {
        generateCsrfToken: () => rotatedCsrfToken
      });
      createDevice(auth);
      csrf.rotateBootstrap({ deviceId, expectedCsrfGeneration: 1, now: rotationAt() });
      const repository = createDeviceRevocationRepository(first.db);
      repository.revoke({ deviceId, now: revokeAt() });
      const hostile = Object.defineProperty({}, "now", {
        enumerable: true,
        get() {
          throw new Error(inputSentinel);
        }
      });
      expectErrorIsCauseFree(
        expectAuthError(() => repository.revoke(hostile as never), "invalid_device_revoke"),
        inputSentinel
      );
      assertSecretsAbsent(path, [rawDeviceToken, initialCsrfToken, rotatedCsrfToken, inputSentinel]);
    } finally {
      first.db.close();
    }
    assertSecretsAbsent(path, [rawDeviceToken, initialCsrfToken, rotatedCsrfToken, inputSentinel]);

    const reopened = openMigratedDatabase(path, { now: createdAt });
    try {
      expect(createDeviceRevocationRepository(reopened.db).revoke({ deviceId, now: afterRevokeAt() })).toEqual({
        deviceId,
        revokedAt: revokeAt().toISOString(),
        previouslyRevoked: true,
        authorityInvalidated: true
      });
      expectAuthError(
        () => createAuthDeviceRepository(reopened.db).authenticateDeviceToken({ rawDeviceToken, now: afterRevokeAt() }),
        "device_revoked"
      );
    } finally {
      reopened.db.close();
    }
  });
});

describe("selected device revocation real SQLite ordering", () => {
  it("observes auth-first and bootstrap-first commits before revoking the newest authority state", async () => {
    for (const operation of ["authenticate", "bootstrap"] as const) {
      const path = tempDbPath();
      const open = openMigratedDatabase(path, { now: createdAt });
      open.db.pragma("busy_timeout = 2000");
      try {
        createDevice(createAuthDeviceRepository(open.db));
        const at = operation === "authenticate" ? firstUseAt() : rotationAt();
        const worker = startAuthorityWriter(path, operation, at.toISOString());
        await worker.updated;
        const result = createDeviceRevocationRepository(open.db).revoke({ deviceId, now: revokeAt() });
        await worker.completed;
        expect(result.previouslyRevoked).toBe(false);
        const row = rawDeviceRow(open.db, deviceId);
        expect(row.revoked_at).toBe(revokeAt().toISOString());
        if (operation === "authenticate") {
          expect(row.last_used_at).toBe(firstUseAt().toISOString());
        } else {
          expect(row).toMatchObject({
            csrf_generation: 2,
            csrf_rotated_at: rotationAt().toISOString(),
            csrf_token_hash: hashSecret(rotatedCsrfToken, { minLength: 24 })
          });
        }
      } finally {
        open.db.close();
      }
    }
  });

  it("makes revoke-first bearer and bootstrap operations reject without touch or entropy", async () => {
    for (const operation of ["authenticate", "bootstrap"] as const) {
      const path = tempDbPath();
      const open = openMigratedDatabase(path, { now: createdAt });
      open.db.pragma("busy_timeout = 2000");
      let entropyCalls = 0;
      try {
        createDevice(createAuthDeviceRepository(open.db));
        const worker = startAuthorityWriter(path, "revoke", firstUseAt().toISOString());
        await worker.updated;
        const auth = createAuthDeviceRepository(open.db);
        const csrf = createSelectedCsrfAuthorizationRepository(open.db, {
          generateCsrfToken: () => {
            entropyCalls += 1;
            return rotatedCsrfToken;
          }
        });
        if (operation === "authenticate") {
          expectAuthError(
            () => auth.authenticateDeviceToken({ rawDeviceToken, now: rotationAt() }),
            "device_revoked"
          );
        } else {
          expectAuthError(
            () => csrf.rotateBootstrap({ deviceId, expectedCsrfGeneration: 1, now: rotationAt() }),
            "device_revoked"
          );
        }
        await worker.completed;
        expect(entropyCalls).toBe(0);
        expect(rawDeviceRow(open.db, deviceId)).toMatchObject({
          last_used_at: null,
          csrf_generation: 1,
          csrf_rotated_at: createdAt().toISOString(),
          revoked_at: firstUseAt().toISOString()
        });
      } finally {
        open.db.close();
      }
    }
  });

  it("keeps one concurrent revoke winner and rejects a regressing loser", async () => {
    for (const mainAt of [revokeAt(), firstUseAt()]) {
      const path = tempDbPath();
      const open = openMigratedDatabase(path, { now: createdAt });
      open.db.pragma("busy_timeout = 2000");
      try {
        createDevice(createAuthDeviceRepository(open.db));
        const worker = startAuthorityWriter(path, "revoke", rotationAt().toISOString());
        await worker.updated;
        const repository = createDeviceRevocationRepository(open.db);
        if (mainAt.getTime() >= rotationAt().getTime()) {
          expect(repository.revoke({ deviceId, now: mainAt })).toMatchObject({
            revokedAt: rotationAt().toISOString(),
            previouslyRevoked: true
          });
        } else {
          expectAuthError(
            () => repository.revoke({ deviceId, now: mainAt }),
            "device_revoke_time_conflict"
          );
        }
        await worker.completed;
        expect(rawDeviceRow(open.db, deviceId).revoked_at).toBe(rotationAt().toISOString());
      } finally {
        open.db.close();
      }
    }
  });
});

function createDevice(
  repository: ReturnType<typeof createAuthDeviceRepository>,
  overrides: Partial<Parameters<ReturnType<typeof createAuthDeviceRepository>["create"]>[0]> = {}
) {
  return repository.create({
    id: deviceId,
    rawDeviceToken,
    rawCsrfToken: initialCsrfToken,
    permission: "write",
    clientLabel: "Android phone",
    createdAt: createdAt(),
    ...overrides
  });
}

function rawDeviceRow(db: Database.Database, id: string): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Missing auth device ${id}.`);
  return row as Readonly<Record<string, unknown>>;
}

function unrelatedTableCounts(db: Database.Database): Readonly<Record<string, number>> {
  const tables = ["pairing_codes", "sessions", "selected_audit_events", "settings"] as const;
  return Object.fromEntries(
    tables.map((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: number };
      return [table, row.count];
    })
  );
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
  expect((caught as HostDeckAuthRepositoryError).cause).toBeUndefined();
  return caught as HostDeckAuthRepositoryError;
}

function expectErrorIsCauseFree(error: HostDeckAuthRepositoryError, ...sentinels: readonly string[]): void {
  expect(error.cause).toBeUndefined();
  const serialized = `${error.name}:${error.code}:${error.message}:${JSON.stringify(error)}`;
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
}

function assertSecretsAbsent(path: string, secrets: readonly string[]): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    for (const secret of secrets) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  }
}

type AuthorityWriterOperation = "authenticate" | "bootstrap" | "revoke";

function startAuthorityWriter(
  path: string,
  operation: AuthorityWriterOperation,
  at: string
): { readonly updated: Promise<void>; readonly completed: Promise<void> } {
  const worker = new Worker(
    `
      const { createHash } = require("node:crypto");
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      let update;
      if (workerData.operation === "authenticate") {
        update = db.prepare("UPDATE auth_devices SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(workerData.at, workerData.deviceId);
      } else if (workerData.operation === "bootstrap") {
        const current = db.prepare("SELECT csrf_generation FROM auth_devices WHERE id = ? AND revoked_at IS NULL")
          .get(workerData.deviceId);
        if (!current) throw new Error("worker bootstrap device unavailable");
        update = db.prepare(
          "UPDATE auth_devices SET csrf_token_hash = ?, csrf_generation = ?, csrf_rotated_at = ? " +
          "WHERE id = ? AND revoked_at IS NULL"
        ).run(hash(workerData.rawCsrfToken), current.csrf_generation + 1, workerData.at, workerData.deviceId);
      } else {
        update = db.prepare("UPDATE auth_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(workerData.at, workerData.deviceId);
      }
      if (update.changes !== 1) throw new Error("worker authority write lost");
      parentPort.postMessage("updated");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: {
        at,
        databaseModule: betterSqlite3Path,
        deviceId,
        operation,
        path,
        rawCsrfToken: rotatedCsrfToken
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
      else reject(new Error(`Authority writer exited with code ${code}.`));
    });
  });
  return { updated, completed };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-device-revoke-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function beforeCreatedAt(): Date {
  return new Date("2026-07-11T19:59:59.999Z");
}

function createdAt(): Date {
  return new Date("2026-07-11T20:00:00.000Z");
}

function firstUseAt(): Date {
  return new Date("2026-07-11T20:01:00.000Z");
}

function rotationAt(): Date {
  return new Date("2026-07-11T20:02:00.000Z");
}

function revokeAt(): Date {
  return new Date("2026-07-11T20:03:00.000Z");
}

function afterRevokeAt(): Date {
  return new Date("2026-07-11T20:04:00.000Z");
}
