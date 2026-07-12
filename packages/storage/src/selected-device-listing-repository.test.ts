import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { SelectedDeviceListPage } from "@hostdeck/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthRepositoryErrorCode,
  createAuthDeviceRepository,
  HostDeckAuthRepositoryError
} from "./auth-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { createDeviceListingRepository } from "./selected-device-listing-repository.js";

const tempDirs: string[] = [];
const betterSqlite3Path = createRequire(import.meta.url).resolve("better-sqlite3");
const baseCreatedAt = new Date("2026-07-11T20:00:00.000Z");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected device listing repository", () => {
  it("handles empty, terminal, exact-boundary, plus-one, subsequent, and missing-cursor pages", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => baseCreatedAt });
    try {
      const repository = createDeviceListingRepository(open.db);
      expect(repository.list({ limit: 2, afterDeviceId: null })).toEqual({
        devices: [],
        nextAfterDeviceId: null,
        hasMore: false
      });

      seedDevices(open.db, ["client_page_001"]);
      expect(repository.list({ limit: 2, afterDeviceId: null })).toMatchObject({
        devices: [{ deviceId: "client_page_001" }],
        nextAfterDeviceId: null,
        hasMore: false
      });

      seedDevices(open.db, ["client_page_002"]);
      expect(repository.list({ limit: 2, afterDeviceId: null })).toMatchObject({
        devices: [{ deviceId: "client_page_001" }, { deviceId: "client_page_002" }],
        nextAfterDeviceId: null,
        hasMore: false
      });

      seedDevices(open.db, ["client_page_003"]);
      const first = repository.list({ limit: 2, afterDeviceId: null });
      expect(first).toMatchObject({
        devices: [{ deviceId: "client_page_001" }, { deviceId: "client_page_002" }],
        nextAfterDeviceId: "client_page_002",
        hasMore: true
      });
      expect(repository.list({ limit: 2, afterDeviceId: first.nextAfterDeviceId })).toMatchObject({
        devices: [{ deviceId: "client_page_003" }],
        nextAfterDeviceId: null,
        hasMore: false
      });
      expect(repository.list({ limit: 2, afterDeviceId: "client_page_003" })).toEqual({
        devices: [],
        nextAfterDeviceId: null,
        hasMore: false
      });

      open.db.prepare("DELETE FROM auth_devices WHERE id = ?").run("client_page_002");
      expect(repository.list({ limit: 2, afterDeviceId: "client_page_002" })).toMatchObject({
        devices: [{ deviceId: "client_page_003" }],
        nextAfterDeviceId: null,
        hasMore: false
      });
      expect(repository.list({ limit: 2, afterDeviceId: "client_page_002z" })).toMatchObject({
        devices: [{ deviceId: "client_page_003" }],
        nextAfterDeviceId: null,
        hasMore: false
      });
    } finally {
      open.db.close();
    }
  });

  it("uses immutable id order independently of insertion and creation time while canonicalizing metadata", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => baseCreatedAt });
    try {
      const auth = createAuthDeviceRepository(open.db);
      createDevice(auth, "client_order_c", new Date("2026-07-11T20:00:00.000Z"));
      createDevice(auth, "client_order_a", new Date("2026-07-11T20:02:00.000Z"));
      createDevice(auth, "client_order_b", new Date("2026-07-11T20:01:00.000Z"));
      open.db
        .prepare("UPDATE auth_devices SET created_at = ?, csrf_rotated_at = ? WHERE id = ?")
        .run(
          "2026-07-11T16:02:00.000-04:00",
          "2026-07-11T16:02:00.000-04:00",
          "client_order_a"
        );

      const page = createDeviceListingRepository(open.db).list({ limit: 10, afterDeviceId: null });
      expect(page.devices.map(({ deviceId }) => deviceId)).toEqual([
        "client_order_a",
        "client_order_b",
        "client_order_c"
      ]);
      expect(page.devices.map(({ createdAt }) => createdAt)).toEqual([
        "2026-07-11T20:02:00.000Z",
        "2026-07-11T20:01:00.000Z",
        "2026-07-11T20:00:00.000Z"
      ]);
    } finally {
      open.db.close();
    }
  });

  it("traverses 250 devices once in bounded frozen pages without exposing authority secrets", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => baseCreatedAt });
    try {
      const expectedIds = Array.from(
        { length: 250 },
        (_, index) => `client_bulk_${index.toString().padStart(3, "0")}`
      );
      const insertAll = open.db.transaction(() => seedDevices(open.db, [...expectedIds].reverse()));
      insertAll();
      const repository = createDeviceListingRepository(open.db);
      const pages: SelectedDeviceListPage[] = [];
      const observedIds: string[] = [];
      let afterDeviceId: string | null = null;

      do {
        const page = repository.list({ limit: 100, afterDeviceId });
        pages.push(page);
        observedIds.push(...page.devices.map(({ deviceId }) => deviceId));
        afterDeviceId = page.nextAfterDeviceId;
      } while (pages.at(-1)?.hasMore === true);

      expect(pages.map(({ devices }) => devices.length)).toEqual([100, 100, 50]);
      expect(pages.map(({ nextAfterDeviceId }) => nextAfterDeviceId)).toEqual([
        "client_bulk_099",
        "client_bulk_199",
        null
      ]);
      expect(observedIds).toEqual(expectedIds);
      expect(new Set(observedIds).size).toBe(250);
      expect(rawDeviceRows(open.db)).toHaveLength(250);

      for (const page of pages) {
        expect(Object.isFrozen(page)).toBe(true);
        expect(Object.isFrozen(page.devices)).toBe(true);
        for (const device of page.devices) {
          expect(Object.isFrozen(device)).toBe(true);
          expect(Object.keys(device).sort()).toEqual([
            "clientLabel",
            "createdAt",
            "deviceId",
            "expiresAt",
            "lastUsedAt",
            "permission",
            "revokedAt"
          ]);
        }
      }
      expect(JSON.stringify(pages)).not.toMatch(/token|hash|csrf|generation|rotation|totalCount/iu);
    } finally {
      open.db.close();
    }
  });

  it("rejects non-exact and hostile input cause-free before reading or mutating storage", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: () => baseCreatedAt });
    const sentinel = "device-list-input-private-sentinel";
    try {
      seedDevices(open.db, ["client_input_001"]);
      const repository = createDeviceListingRepository(open.db);
      const before = rawDeviceRows(open.db);
      const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
        limit: 1,
        afterDeviceId: null
      });
      expect(repository.list(nullPrototype as never).devices).toHaveLength(1);

      const accessor = Object.defineProperty({ afterDeviceId: null }, "limit", {
        enumerable: true,
        get() {
          throw new Error(sentinel);
        }
      });
      const nonEnumerable = Object.defineProperty({ afterDeviceId: null }, "limit", {
        enumerable: false,
        value: 1
      });
      const symbolKey = { limit: 1, afterDeviceId: null, [Symbol("private")]: sentinel };
      const hostileProxy = new Proxy(
        { limit: 1, afterDeviceId: null },
        {
          ownKeys() {
            throw new Error(sentinel);
          }
        }
      );
      const invalid = [
        undefined,
        null,
        [],
        {},
        { limit: 1 },
        { afterDeviceId: null },
        { limit: 1, afterDeviceId: null, extra: sentinel },
        Object.assign(Object.create({ inherited: sentinel }), { limit: 1, afterDeviceId: null }),
        accessor,
        nonEnumerable,
        symbolKey,
        hostileProxy,
        { limit: 0, afterDeviceId: null },
        { limit: -1, afterDeviceId: null },
        { limit: 1.5, afterDeviceId: null },
        { limit: 101, afterDeviceId: null },
        { limit: Number.NaN, afterDeviceId: null },
        { limit: Number.POSITIVE_INFINITY, afterDeviceId: null },
        { limit: Number.MAX_SAFE_INTEGER + 1, afterDeviceId: null },
        { limit: 1, afterDeviceId: "" },
        { limit: 1, afterDeviceId: "client with spaces" }
      ];
      for (const candidate of invalid) {
        const error = expectAuthError(() => repository.list(candidate as never), "invalid_device_list");
        expect(error.message).toBe("Selected device-list input is invalid.");
        expectErrorIsCauseFree(error, sentinel);
      }
      expect(rawDeviceRows(open.db)).toEqual(before);
    } finally {
      open.db.close();
    }
  });

  it("validates every fetched row including lookahead and returns no partial page for corrupt state", () => {
    const corruptions = [
      ["id", "client_corrupt_003 invalid"],
      ["token_hash", "short"],
      ["csrf_generation", 0],
      ["permission", "admin"],
      ["client_label", ""],
      ["created_at", "not-a-time"],
      ["last_used_at", "2026-07-11T19:59:59.999Z"],
      ["revoked_at", "2026-07-11T19:59:59.999Z"]
    ] as const;

    for (const [column, value] of corruptions) {
      const open = openMigratedDatabase(tempDbPath(), { now: () => baseCreatedAt });
      try {
        seedDevices(open.db, ["client_corrupt_001", "client_corrupt_002", "client_corrupt_003"]);
        open.db.pragma("ignore_check_constraints = ON");
        open.db.prepare(`UPDATE auth_devices SET ${column} = ? WHERE id = ?`).run(value, "client_corrupt_003");
        const before = rawDeviceRows(open.db);

        const error = expectAuthError(
          () => createDeviceListingRepository(open.db).list({ limit: 2, afterDeviceId: null }),
          "invalid_auth_device"
        );
        expect(error.message).toBe("Stored auth-device state is invalid.");
        const privateValue = String(value);
        expectErrorIsCauseFree(error, ...(privateValue.length === 0 ? [] : [privateValue]));
        expect(rawDeviceRows(open.db)).toEqual(before);
      } finally {
        open.db.close();
      }
    }
  });

  it("reads a valid database in read-only mode and fails cause-free after the handle closes", () => {
    const path = tempDbPath();
    const writable = openMigratedDatabase(path, { now: () => baseCreatedAt });
    seedDevices(writable.db, ["client_readonly_001"]);
    const closedRepository = createDeviceListingRepository(writable.db);
    writable.db.close();

    const closedError = expectAuthError(
      () => closedRepository.list({ limit: 1, afterDeviceId: null }),
      "device_list_failed"
    );
    expect(closedError.message).toBe("Device listing failed.");
    expectErrorIsCauseFree(closedError);

    const readOnlyDb = new Database(path, { fileMustExist: true, readonly: true });
    try {
      expect(createDeviceListingRepository(readOnlyDb).list({ limit: 1, afterDeviceId: null })).toMatchObject({
        devices: [{ deviceId: "client_readonly_001" }],
        nextAfterDeviceId: null,
        hasMore: false
      });
    } finally {
      readOnlyDb.close();
    }
  });

  it("preserves traversal across WAL restart without returning or persisting raw credentials and sentinels", () => {
    const path = tempDbPath();
    const sentinel = "device-list-error-private-sentinel";
    let firstPage: SelectedDeviceListPage;
    const first = openMigratedDatabase(path, { now: () => baseCreatedAt });
    first.db.pragma("journal_mode = WAL");
    first.db.pragma("wal_autocheckpoint = 0");
    const ids = ["client_restart_001", "client_restart_002", "client_restart_003"];
    const rawCredentials = ids.flatMap((id) => [rawDeviceToken(id), rawCsrfToken(id)]);
    try {
      seedDevices(first.db, ids);
      const repository = createDeviceListingRepository(first.db);
      firstPage = repository.list({ limit: 2, afterDeviceId: null });
      const storedHashes = rawDeviceRows(first.db).flatMap((row) => [row.token_hash, row.csrf_token_hash]);
      const serialized = JSON.stringify(firstPage);
      for (const privateValue of [...rawCredentials, ...storedHashes]) {
        expect(serialized).not.toContain(String(privateValue));
      }

      const hostile = new Proxy(
        { limit: 2, afterDeviceId: null },
        {
          ownKeys() {
            throw new Error(sentinel);
          }
        }
      );
      expectErrorIsCauseFree(
        expectAuthError(() => repository.list(hostile), "invalid_device_list"),
        sentinel
      );
      assertSecretsAbsent(path, [...rawCredentials, sentinel]);
    } finally {
      first.db.close();
    }
    assertSecretsAbsent(path, [...rawCredentials, sentinel]);

    const reopened = openMigratedDatabase(path, { now: () => baseCreatedAt });
    try {
      const repository = createDeviceListingRepository(reopened.db);
      expect(repository.list({ limit: 2, afterDeviceId: null })).toEqual(firstPage);
      expect(repository.list({ limit: 2, afterDeviceId: firstPage.nextAfterDeviceId })).toMatchObject({
        devices: [{ deviceId: "client_restart_003" }],
        nextAfterDeviceId: null,
        hasMore: false
      });
    } finally {
      reopened.db.close();
    }
  });

  it("observes one statement snapshot while a revocation commits and sees the commit on the next page read", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: () => baseCreatedAt });
    open.db.pragma("busy_timeout = 2000");
    const revokedAt = "2026-07-11T20:03:00.000Z";
    try {
      seedDevices(open.db, ["client_snapshot_001", "client_snapshot_002"]);
      const writer = startRevocationWriter(path, "client_snapshot_002", revokedAt);
      await writer.updated;

      const repository = createDeviceListingRepository(open.db);
      const beforeCommit = repository.list({ limit: 2, afterDeviceId: null });
      expect(beforeCommit.devices.map(({ deviceId, revokedAt: observed }) => [deviceId, observed])).toEqual([
        ["client_snapshot_001", null],
        ["client_snapshot_002", null]
      ]);

      await writer.completed;
      const afterCommit = repository.list({ limit: 2, afterDeviceId: null });
      expect(afterCommit.devices.map(({ deviceId }) => deviceId)).toEqual([
        "client_snapshot_001",
        "client_snapshot_002"
      ]);
      expect(afterCommit.devices.at(-1)?.revokedAt).toBe(revokedAt);
    } finally {
      open.db.close();
    }
  });

  it("executes one bounded query per page and uses the primary-key traversal plan without count or offset", () => {
    const path = tempDbPath();
    const seed = openMigratedDatabase(path, { now: () => baseCreatedAt });
    seedDevices(seed.db, ["client_query_003", "client_query_001", "client_query_002"]);
    seed.db.close();

    const statements: string[] = [];
    const db = new Database(path, {
      fileMustExist: true,
      verbose(sql) {
        statements.push(String(sql));
      }
    });
    try {
      const repository = createDeviceListingRepository(db);
      statements.length = 0;
      repository.list({ limit: 2, afterDeviceId: "client_query_001" });
      const pageStatements = statements.filter((sql) => /auth_devices/iu.test(sql));
      expect(pageStatements).toHaveLength(1);
      expect(pageStatements[0]).toMatch(/WHERE id > ['"]?client_query_001['"]? ORDER BY id ASC LIMIT 3/iu);
      expect(pageStatements[0]).not.toMatch(/COUNT|OFFSET/iu);

      const continuationPlan = db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM auth_devices WHERE id > ? ORDER BY id ASC LIMIT ?")
        .all("client_query_001", 3) as Array<{ readonly detail: string }>;
      expect(continuationPlan.some(({ detail }) => /SEARCH auth_devices USING INDEX .+ \(id>\?\)/u.test(detail))).toBe(
        true
      );
      expect(continuationPlan.every(({ detail }) => !/USE TEMP B-TREE/iu.test(detail))).toBe(true);
    } finally {
      db.close();
    }
  });
});

function seedDevices(db: Database.Database, ids: readonly string[]): void {
  const auth = createAuthDeviceRepository(db);
  for (const id of ids) createDevice(auth, id, baseCreatedAt);
}

function createDevice(
  auth: ReturnType<typeof createAuthDeviceRepository>,
  id: string,
  createdAt: Date
): void {
  auth.create({
    id,
    rawDeviceToken: rawDeviceToken(id),
    rawCsrfToken: rawCsrfToken(id),
    permission: id.endsWith("1") ? "read" : "write",
    clientLabel: `Android ${id}`,
    createdAt
  });
}

function rawDeviceToken(id: string): string {
  return `device-token:${id}:${"D".repeat(24)}`;
}

function rawCsrfToken(id: string): string {
  return `csrf-token:${id}:${"C".repeat(24)}`;
}

function rawDeviceRows(db: Database.Database): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return db.prepare("SELECT * FROM auth_devices ORDER BY id ASC").all() as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
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

function startRevocationWriter(
  path: string,
  deviceId: string,
  revokedAt: string
): { readonly updated: Promise<void>; readonly completed: Promise<void> } {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      const update = db.prepare("UPDATE auth_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(workerData.revokedAt, workerData.deviceId);
      if (update.changes !== 1) throw new Error("worker revocation lost");
      parentPort.postMessage("updated");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: {
        databaseModule: betterSqlite3Path,
        deviceId,
        path,
        revokedAt
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
      else reject(new Error(`Device-list revocation writer exited with code ${code}.`));
    });
  });
  return { updated, completed };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-device-list-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}
