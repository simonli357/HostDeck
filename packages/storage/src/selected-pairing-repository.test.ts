import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { defaultResourceBudget, type ResourceBudget, resolveResourceBudget } from "@hostdeck/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthRepositoryErrorCode,
  createAuthDeviceRepository,
  createLegacyPairingCodeRepository,
  HostDeckAuthRepositoryError,
  hashSecret
} from "./auth-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createPairingCodeRepository,
  type PairingCodeRepository,
  type PairingCodeRepositoryOptions
} from "./selected-pairing-repository.js";

const tempDirs: string[] = [];
const betterSqlite3Path = createRequire(import.meta.url).resolve("better-sqlite3");
const rawCodeA = "A".repeat(22);
const rawCodeB = "B".repeat(22);
const rawCodeC = "C".repeat(22);
const rawCodeD = "D".repeat(22);
const rawCodeE = "E".repeat(22);
const rawCodeF = "G".repeat(22);
const rawDeviceToken = "T".repeat(43);
const rawCsrfToken = "X".repeat(43);
const selectedDeviceId = `client_${"d".repeat(24)}`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected pairing issuance", () => {
  it("generates one policy-lived 128-bit code and returns it only in a frozen post-commit result", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const repository = createPairingCodeRepository(open.db, { policy: defaultResourceBudget });
      const issued = repository.issue(issueInput("pair_default_entropy"));

      expect(issued.rawCode).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      expect(issued.pairingCode).toMatchObject({
        id: "pair_default_entropy",
        permission: "write",
        client_label: "Android phone",
        created_at: baseTime().toISOString(),
        expires_at: plus(baseTime(), defaultResourceBudget.pairing_code_lifetime_ms).toISOString(),
        used_at: null,
        revoked_at: null,
        claim_contract_version: 1,
        claimed_device_id: null
      });
      expect(issued.pairingCode.code_hash).toBe(hashSecret(issued.rawCode, { minLength: 22 }));
      expect(Object.isFrozen(issued)).toBe(true);
      expect(Object.isFrozen(issued.pairingCode)).toBe(true);
      expect(open.db.prepare("SELECT * FROM pairing_codes WHERE id = ?").get(issued.pairingCode.id)).not.toHaveProperty(
        "raw_code"
      );
      expect(JSON.stringify(open.db.prepare("SELECT * FROM pairing_codes").all())).not.toContain(issued.rawCode);
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed policy, options, inputs, and entropy without mutation or secret-bearing causes", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    const sentinel = "issue-generator-private-sentinel";
    try {
      expectAuthError(
        () =>
          createPairingCodeRepository(open.db, {
            policy: { ...defaultResourceBudget } as ResourceBudget
          }),
        "invalid_pairing_policy"
      );
      expectAuthError(
        () =>
          createPairingCodeRepository(
            open.db,
            { policy: defaultResourceBudget, extra: true } as unknown as PairingCodeRepositoryOptions
          ),
        "invalid_pairing_policy"
      );
      const hostileOptions = Object.defineProperty({}, "policy", {
        enumerable: true,
        get() {
          throw new Error(sentinel);
        }
      });
      const optionsError = expectAuthError(
        () =>
          createPairingCodeRepository(
            open.db,
            hostileOptions as unknown as PairingCodeRepositoryOptions
          ),
        "invalid_pairing_policy"
      );
      expectErrorIsCauseFree(optionsError, sentinel);

      let generatorCalls = 0;
      const repository = fixedRepository(open.db, {
        generatePairingCode: () => {
          generatorCalls += 1;
          return rawCodeA;
        }
      });
      const accessorInput = Object.defineProperty({}, "id", {
        enumerable: true,
        get() {
          throw new Error(sentinel);
        }
      });
      const invalidInputs: unknown[] = [
        null,
        {},
        { ...issueInput("pair_extra"), extra: true },
        accessorInput,
        issueInput("invalid id"),
        { ...issueInput("pair_permission"), permission: "admin" },
        { ...issueInput("pair_label"), clientLabel: "x".repeat(121) },
        { ...issueInput("pair_time"), createdAt: new Date(Number.NaN) }
      ];
      for (const input of invalidInputs) {
        const error = captureAuthError(() => repository.issue(input as never));
        expect(["invalid_pairing_code", "invalid_time"]).toContain(error.code);
        expectErrorIsCauseFree(error, sentinel);
      }
      expect(generatorCalls).toBe(0);

      const throwing = fixedRepository(open.db, {
        generatePairingCode: () => {
          throw new Error(`${sentinel}:${rawCodeB}`);
        }
      });
      expectErrorIsCauseFree(
        expectAuthError(() => throwing.issue(issueInput("pair_throwing_entropy")), "pairing_issue_failed"),
        sentinel,
        rawCodeB
      );
      const malformed = fixedRepository(open.db, { generatePairingCode: () => "short" });
      expectAuthError(() => malformed.issue(issueInput("pair_malformed_entropy")), "pairing_issue_failed");
      const metadataCollision = fixedRepository(open.db, { generatePairingCode: () => rawCodeC });
      expectErrorIsCauseFree(
        expectAuthError(
          () =>
            metadataCollision.issue({
              ...issueInput("pair_issue_metadata_collision"),
              clientLabel: `phone-${rawCodeC}`
            }),
          "pairing_issue_failed"
        ),
        rawCodeC
      );
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM pairing_codes").get()).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });

  it("rolls back duplicate, statement, and deferred-commit failures without returning generated codes", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: baseTime });
    try {
      fixedRepository(open.db, { generatePairingCode: () => rawCodeA }).issue(issueInput("pair_issue_existing"));
      expectErrorIsCauseFree(
        expectAuthError(
          () =>
            fixedRepository(open.db, { generatePairingCode: () => rawCodeB }).issue(
              issueInput("pair_issue_existing")
            ),
          "pairing_issue_failed"
        ),
        rawCodeB
      );
      expectErrorIsCauseFree(
        expectAuthError(
          () => fixedRepository(open.db, { generatePairingCode: () => rawCodeA }).issue(issueInput("pair_hash_collision")),
          "pairing_issue_failed"
        ),
        rawCodeA
      );

      open.db.exec(`
        CREATE TRIGGER fail_selected_pairing_insert
        BEFORE INSERT ON pairing_codes
        WHEN NEW.claim_contract_version = 1
        BEGIN
          SELECT RAISE(ABORT, 'forced selected pairing insert failure');
        END;
      `);
      expectErrorIsCauseFree(
        expectAuthError(
          () => fixedRepository(open.db, { generatePairingCode: () => rawCodeC }).issue(issueInput("pair_insert_failure")),
          "pairing_issue_failed"
        ),
        rawCodeC
      );
      open.db.exec("DROP TRIGGER fail_selected_pairing_insert");

      open.db.exec(`
        CREATE TABLE pairing_issue_commit_parent (id TEXT PRIMARY KEY);
        CREATE TABLE pairing_issue_commit_probe (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES pairing_issue_commit_parent(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_selected_pairing_commit
        AFTER INSERT ON pairing_codes
        WHEN NEW.claim_contract_version = 1
        BEGIN
          INSERT INTO pairing_issue_commit_probe (id, parent_id) VALUES (NEW.id, 'missing-parent');
        END;
      `);
      expectErrorIsCauseFree(
        expectAuthError(
          () => fixedRepository(open.db, { generatePairingCode: () => rawCodeD }).issue(issueInput("pair_commit_failure")),
          "pairing_issue_failed"
        ),
        rawCodeD
      );
      expect(open.db.prepare("SELECT id FROM pairing_codes ORDER BY id").all()).toEqual([
        { id: "pair_issue_existing" }
      ]);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM pairing_issue_commit_probe").get()).toEqual({ count: 0 });
      for (const rawCode of [rawCodeB, rawCodeC, rawCodeD]) {
        expect(readFileSync(path).includes(Buffer.from(rawCode))).toBe(false);
      }
    } finally {
      open.db.close();
    }
  });
});

describe("selected pairing claim and rate state", () => {
  it("atomically creates one hash-only device, owns the spent code, and returns frozen credentials post-commit", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const repository = fixedRepository(open.db);
      repository.issue(issueInput("pair_claim_success"));
      const claimAt = plus(baseTime(), 1_000);
      const result = repository.claim({
        ...claimInput(rawCodeA, sourceKey(1), claimAt),
        clientLabel: "Claiming Android",
        deviceExpiresAt: plus(claimAt, 86_400_000)
      });

      expect(result).toMatchObject({
        rawDeviceToken,
        rawCsrfToken,
        pairingCode: {
          id: "pair_claim_success",
          used_at: claimAt.toISOString(),
          claimed_device_id: selectedDeviceId
        },
        device: {
          id: selectedDeviceId,
          permission: "write",
          client_label: "Claiming Android",
          created_at: claimAt.toISOString(),
          csrf_generation: 1,
          csrf_rotated_at: claimAt.toISOString(),
          expires_at: plus(claimAt, 86_400_000).toISOString()
        }
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.pairingCode)).toBe(true);
      expect(Object.isFrozen(result.device)).toBe(true);
      expect(rawPairingRow(open.db, "pair_claim_success")).toMatchObject({
        used_at: claimAt.toISOString(),
        claimed_device_id: selectedDeviceId
      });
      expect(rawDeviceRow(open.db, selectedDeviceId)).toMatchObject({
        token_hash: hashSecret(rawDeviceToken, { minLength: 24 }),
        csrf_token_hash: hashSecret(rawCsrfToken, { minLength: 24 })
      });
      expect(repository.getRateSnapshot(sourceKey(1))).toEqual({
        source: {
          source_key: sourceKey(1),
          window_started_at: claimAt.toISOString(),
          attempt_count: 1,
          last_attempt_at: claimAt.toISOString()
        },
        global: {
          id: "pair_claim_global",
          window_started_at: claimAt.toISOString(),
          attempt_count: 1,
          last_attempt_at: claimAt.toISOString()
        }
      });
      const auth = createAuthDeviceRepository(open.db);
      expect(auth.authenticateDeviceToken({ rawDeviceToken, now: claimAt }).device.id).toBe(selectedDeviceId);
      expect(auth.authorizeBrowserWrite({ rawDeviceToken, rawCsrfToken, now: claimAt }).id).toBe(selectedDeviceId);
    } finally {
      open.db.close();
    }
  });

  it("charges exactly one slot for not-found, expired, revoked, used, and legacy outcomes but none for malformed input", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const repository = fixedRepository(open.db, {
        generatePairingCode: sequenceGenerator([rawCodeA, rawCodeB, rawCodeC])
      });
      repository.issue(issueInput("pair_used", plus(baseTime(), 240_000)));
      repository.issue(issueInput("pair_expired", baseTime()));
      repository.issue(issueInput("pair_revoked", plus(baseTime(), 240_000)));
      createLegacyPairingCodeRepository(open.db).createLegacy({
        id: "pair_legacy",
        rawCode: rawCodeD,
        permission: "write",
        createdAt: plus(baseTime(), 240_000),
        expiresAt: plus(baseTime(), 600_000)
      });

      const firstUseAt = plus(baseTime(), 285_000);
      repository.claim(claimInput(rawCodeA, sourceKey(10), firstUseAt));
      repository.revoke("pair_revoked", { now: plus(baseTime(), 270_000) });
      const failureAt = plus(baseTime(), 300_000);
      const failures = [
        [rawCodeA, sourceKey(11), "pairing_code_used"],
        [rawCodeB, sourceKey(12), "pairing_code_expired"],
        [rawCodeC, sourceKey(13), "pairing_code_revoked"],
        [rawCodeE, sourceKey(14), "pairing_code_not_found"],
        [rawCodeD, sourceKey(15), "pairing_code_legacy"]
      ] as const;
      for (const [rawCode, source, code] of failures) {
        expectAuthError(() => repository.claim(claimInput(rawCode, source, failureAt)), code);
        expect(repository.getRateSnapshot(source).source?.attempt_count).toBe(1);
      }
      expectAuthError(
        () => repository.claim(claimInput("short", sourceKey(16), failureAt)),
        "invalid_secret"
      );
      expect(repository.getRateSnapshot(sourceKey(16)).source).toBeNull();
      expect(repository.getRateSnapshot(sourceKey(10)).global?.attempt_count).toBe(6);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()).toEqual({ count: 1 });
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed claim boundaries before counters, lookup results, or credential entropy", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    const sentinel = "claim-input-private-sentinel";
    let generatorCalls = 0;
    try {
      const repository = fixedRepository(open.db, {
        generateDeviceId: countedGenerator(() => selectedDeviceId, () => {
          generatorCalls += 1;
        })
      });
      repository.issue(issueInput("pair_claim_boundary"));
      const valid = claimInput(rawCodeA, sourceKey(17), plus(baseTime(), 1_000));
      const accessor = Object.defineProperty({}, "rawCode", {
        enumerable: true,
        get() {
          throw new Error(sentinel);
        }
      });
      const invalid: ReadonlyArray<readonly [unknown, AuthRepositoryErrorCode]> = [
        [null, "invalid_pairing_code"],
        [{ ...valid, extra: true }, "invalid_pairing_code"],
        [{ ...valid, sourceKey: "203.0.113.77" }, "invalid_pairing_source"],
        [{ ...valid, sourceKey: `sha256:${"A".repeat(64)}` }, "invalid_pairing_source"],
        [{ ...valid, rawCode: "short" }, "invalid_secret"],
        [{ ...valid, now: new Date(Number.NaN) }, "invalid_time"],
        [{ ...valid, clientLabel: "x".repeat(121) }, "invalid_pairing_code"],
        [{ ...valid, deviceExpiresAt: valid.now }, "invalid_time"],
        [accessor, "invalid_pairing_code"]
      ];
      for (const [candidate, code] of invalid) {
        const error = expectAuthError(() => repository.claim(candidate as never), code);
        expectErrorIsCauseFree(error, sentinel);
      }
      expect(generatorCalls).toBe(0);
      expectUnclaimed(open.db, "pair_claim_boundary", sourceKey(17));
      expect(repository.getRateSnapshot(sourceKey(17)).global).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("enforces exact per-source and global fixed windows with boundary-equal reset and fixed retry time", () => {
    const policy = pairingPolicy({
      pair_claim_window_ms: 1_000,
      pairing_code_lifetime_ms: 60_000,
      pair_claim_max_attempts_per_source: 2,
      pair_claim_max_attempts_global: 3,
      admission_state_ttl_ms: 60_000
    });
    const first = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const repository = fixedRepository(first.db, { policy });
      expectAuthError(() => repository.claim(claimInput(rawCodeE, sourceKey(20), baseTime())), "pairing_code_not_found");
      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(20), plus(baseTime(), 999))),
        "pairing_code_not_found"
      );
      const limited = expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(20), plus(baseTime(), 999))),
        "pairing_claim_rate_limited"
      );
      expect(limited.retryAt).toBe(plus(baseTime(), 1_000).toISOString());
      expect(repository.getRateSnapshot(sourceKey(20)).source?.attempt_count).toBe(2);
      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(20), plus(baseTime(), 1_000))),
        "pairing_code_not_found"
      );
      expect(repository.getRateSnapshot(sourceKey(20))).toMatchObject({
        source: { window_started_at: plus(baseTime(), 1_000).toISOString(), attempt_count: 1 },
        global: { window_started_at: plus(baseTime(), 1_000).toISOString(), attempt_count: 1 }
      });
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const repository = fixedRepository(second.db, {
        policy: pairingPolicy({ ...policy, pair_claim_max_attempts_per_source: 3 })
      });
      for (let index = 0; index < 3; index += 1) {
        expectAuthError(
          () => repository.claim(claimInput(rawCodeE, sourceKey(30 + index), baseTime())),
          "pairing_code_not_found"
        );
      }
      const globalLimit = expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(40), baseTime())),
        "pairing_claim_rate_limited"
      );
      expect(globalLimit.retryAt).toBe(plus(baseTime(), 1_000).toISOString());
      expect(repository.getRateSnapshot(sourceKey(40)).source).toBeNull();
      expect(repository.getRateSnapshot(sourceKey(30)).global?.attempt_count).toBe(3);
    } finally {
      second.db.close();
    }
  });

  it("rejects saturated source and global state before code lookup or credential generation", () => {
    for (const limit of ["source", "global"] as const) {
      const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
      let generatorCalls = 0;
      try {
        const targetCode = limit === "source" ? rawCodeA : rawCodeB;
        const targetSource = sourceKey(limit === "source" ? 50 : 51);
        insertCorruptSelectedCode(open.db, `pair_corrupt_${limit}`, targetCode);
        open.db
          .prepare(
            "INSERT INTO pairing_claim_rate_sources " +
              "(source_key, window_started_at, attempt_count, last_attempt_at) VALUES (?, ?, ?, ?)"
          )
          .run(
            targetSource,
            baseTime().toISOString(),
            limit === "source" ? Number.MAX_SAFE_INTEGER : 1,
            baseTime().toISOString()
          );
        open.db
          .prepare(
            "INSERT INTO pairing_claim_rate_global " +
              "(id, window_started_at, attempt_count, last_attempt_at) VALUES ('pair_claim_global', ?, ?, ?)"
          )
          .run(
            baseTime().toISOString(),
            limit === "global" ? Number.MAX_SAFE_INTEGER : 1,
            baseTime().toISOString()
          );
        const repository = fixedRepository(open.db, {
          policy: pairingPolicy({
            pair_claim_max_attempts_per_source: 100,
            pair_claim_max_attempts_global: 1_000
          }),
          generateDeviceId: countedGenerator(() => selectedDeviceId, () => {
            generatorCalls += 1;
          }),
          generateDeviceToken: countedGenerator(() => rawDeviceToken, () => {
            generatorCalls += 1;
          }),
          generateCsrfToken: countedGenerator(() => rawCsrfToken, () => {
            generatorCalls += 1;
          })
        });
        expectAuthError(
          () => repository.claim(claimInput(targetCode, targetSource, baseTime())),
          "pairing_claim_rate_limited"
        );
        expect(generatorCalls).toBe(0);
        expect(repository.getRateSnapshot(targetSource)).toMatchObject({
          source: { attempt_count: limit === "source" ? Number.MAX_SAFE_INTEGER : 1 },
          global: { attempt_count: limit === "global" ? Number.MAX_SAFE_INTEGER : 1 }
        });
      } finally {
        open.db.close();
      }
    }
  });

  it("bounds tracked sources, keeps existing sources serviceable, and frees only TTL-expired entries", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const policy = pairingPolicy({
        pair_claim_window_ms: 1_000,
        pairing_code_lifetime_ms: 60_000,
        pair_claim_max_attempts_per_source: 100,
        pair_claim_max_attempts_global: 1_000,
        admission_max_tracked_keys: 64,
        admission_state_ttl_ms: 60_000
      });
      const repository = fixedRepository(open.db, { policy });
      for (let index = 0; index < 64; index += 1) {
        expectAuthError(
          () => repository.claim(claimInput(rawCodeE, sourceKey(100 + index), baseTime())),
          "pairing_code_not_found"
        );
      }
      const capacity = expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(200), baseTime())),
        "pairing_claim_capacity"
      );
      expect(capacity.retryAt).toBe(plus(baseTime(), 60_000).toISOString());
      expect(repository.getRateSnapshot(sourceKey(100)).global?.attempt_count).toBe(64);
      expect(repository.getRateSnapshot(sourceKey(200)).source).toBeNull();

      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(100), plus(baseTime(), 1))),
        "pairing_code_not_found"
      );
      expect(repository.getRateSnapshot(sourceKey(100)).source?.attempt_count).toBe(2);
      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(200), plus(baseTime(), 60_000))),
        "pairing_code_not_found"
      );
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources").get()).toEqual({ count: 2 });
      expect(repository.getRateSnapshot(sourceKey(100)).source).not.toBeNull();
      expect(repository.getRateSnapshot(sourceKey(101)).source).toBeNull();
      expect(repository.getRateSnapshot(sourceKey(200)).source?.attempt_count).toBe(1);
    } finally {
      open.db.close();
    }
  });

  it("bounds one stale-cleanup pass when a reopened policy lowers tracked-source capacity", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: baseTime });
    try {
      const repository = fixedRepository(first.db, {
        policy: pairingPolicy({
          pair_claim_window_ms: 1_000,
          pairing_code_lifetime_ms: 60_000,
          pair_claim_max_attempts_per_source: 100,
          pair_claim_max_attempts_global: 1_000,
          admission_max_tracked_keys: 128,
          admission_state_ttl_ms: 60_000
        })
      });
      for (let index = 0; index < 80; index += 1) {
        expectAuthError(
          () => repository.claim(claimInput(rawCodeE, sourceKey(500 + index), baseTime())),
          "pairing_code_not_found"
        );
      }
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: baseTime });
    try {
      const repository = fixedRepository(second.db, {
        policy: pairingPolicy({
          pair_claim_window_ms: 1_000,
          pairing_code_lifetime_ms: 60_000,
          pair_claim_max_attempts_per_source: 100,
          pair_claim_max_attempts_global: 1_000,
          admission_max_tracked_keys: 64,
          admission_state_ttl_ms: 60_000
        })
      });
      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(600), plus(baseTime(), 60_000))),
        "pairing_code_not_found"
      );
      expect(second.db.prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources").get()).toEqual({ count: 17 });
      expect(repository.getRateSnapshot(sourceKey(500)).source).toBeNull();
      expect(repository.getRateSnapshot(sourceKey(563)).source).toBeNull();
      expect(repository.getRateSnapshot(sourceKey(564)).source).not.toBeNull();
      expect(repository.getRateSnapshot(sourceKey(600)).source?.attempt_count).toBe(1);
    } finally {
      second.db.close();
    }
  });

  it("preserves durable windows across reopen and applies changed policy without accepting regressing time", () => {
    const path = tempDbPath();
    const initialPolicy = pairingPolicy({
      pair_claim_window_ms: 60_000,
      pairing_code_lifetime_ms: 60_000,
      pair_claim_max_attempts_per_source: 2,
      pair_claim_max_attempts_global: 100,
      admission_state_ttl_ms: 60_000
    });
    const first = openMigratedDatabase(path, { now: baseTime });
    try {
      const repository = fixedRepository(first.db, { policy: initialPolicy });
      for (const at of [baseTime(), plus(baseTime(), 1)]) {
        expectAuthError(
          () => repository.claim(claimInput(rawCodeE, sourceKey(210), at)),
          "pairing_code_not_found"
        );
      }
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: baseTime });
    try {
      const lowerLimit = fixedRepository(second.db, {
        policy: pairingPolicy({ ...initialPolicy, pair_claim_max_attempts_per_source: 1 })
      });
      expectAuthError(
        () => lowerLimit.claim(claimInput(rawCodeE, sourceKey(210), plus(baseTime(), 2))),
        "pairing_claim_rate_limited"
      );
      const shorterWindow = fixedRepository(second.db, {
        policy: pairingPolicy({ ...initialPolicy, pair_claim_window_ms: 1_000, pair_claim_max_attempts_per_source: 3 })
      });
      expectAuthError(
        () => shorterWindow.claim(claimInput(rawCodeE, sourceKey(210), plus(baseTime(), 1_000))),
        "pairing_code_not_found"
      );
      expect(shorterWindow.getRateSnapshot(sourceKey(210)).source).toMatchObject({
        window_started_at: plus(baseTime(), 1_000).toISOString(),
        attempt_count: 1
      });
      expectAuthError(
        () => shorterWindow.claim(claimInput(rawCodeE, sourceKey(210), plus(baseTime(), 999))),
        "pairing_claim_time_conflict"
      );
      expect(shorterWindow.getRateSnapshot(sourceKey(210)).source).toMatchObject({
        attempt_count: 1,
        last_attempt_at: plus(baseTime(), 1_000).toISOString()
      });
    } finally {
      second.db.close();
    }
  });

  it("rejects a claim observation before selected code creation without counters or entropy", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    let generatorCalls = 0;
    try {
      const repository = fixedRepository(open.db, {
        generateDeviceId: countedGenerator(() => selectedDeviceId, () => {
          generatorCalls += 1;
        })
      });
      repository.issue(issueInput("pair_future_creation", plus(baseTime(), 1_000)));
      expectAuthError(
        () => repository.claim(claimInput(rawCodeA, sourceKey(220), baseTime())),
        "pairing_claim_time_conflict"
      );
      expect(generatorCalls).toBe(0);
      expectUnclaimed(open.db, "pair_future_creation", sourceKey(220));
    } finally {
      open.db.close();
    }
  });
});

describe("selected pairing rollback, corruption, and privacy", () => {
  it("rolls back malformed or throwing credential generation and duplicate device authority", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    const generatorSentinel = "claim-generator-private-sentinel";
    const existingToken = "Q".repeat(43);
    const existingCsrf = "R".repeat(43);
    try {
      fixedRepository(open.db, { generatePairingCode: () => rawCodeA }).issue(issueInput("pair_throwing_claim"));
      const throwing = fixedRepository(open.db, {
        generateDeviceId: () => {
          throw new Error(`${generatorSentinel}:${rawDeviceToken}`);
        }
      });
      expectErrorIsCauseFree(
        expectAuthError(
          () => throwing.claim(claimInput(rawCodeA, sourceKey(300), plus(baseTime(), 1_000))),
          "pairing_claim_failed"
        ),
        generatorSentinel,
        rawDeviceToken
      );
      expectUnclaimed(open.db, "pair_throwing_claim", sourceKey(300));

      fixedRepository(open.db, { generatePairingCode: () => rawCodeB }).issue(issueInput("pair_malformed_claim"));
      const malformed = fixedRepository(open.db, { generateDeviceToken: () => "short" });
      expectAuthError(
        () => malformed.claim(claimInput(rawCodeB, sourceKey(301), plus(baseTime(), 1_000))),
        "pairing_claim_failed"
      );
      expectUnclaimed(open.db, "pair_malformed_claim", sourceKey(301));

      createAuthDeviceRepository(open.db).create({
        id: selectedDeviceId,
        rawDeviceToken: existingToken,
        rawCsrfToken: existingCsrf,
        permission: "write",
        createdAt: baseTime()
      });
      fixedRepository(open.db, { generatePairingCode: () => rawCodeC }).issue(issueInput("pair_device_id_collision"));
      expectAuthError(
        () =>
          fixedRepository(open.db).claim(
            claimInput(rawCodeC, sourceKey(302), plus(baseTime(), 1_000))
          ),
        "device_exists"
      );
      expectUnclaimed(open.db, "pair_device_id_collision", sourceKey(302), 1);

      fixedRepository(open.db, { generatePairingCode: () => rawCodeD }).issue(issueInput("pair_token_collision"));
      const duplicateToken = fixedRepository(open.db, {
        generateDeviceId: () => `client_${"e".repeat(24)}`,
        generateDeviceToken: () => existingToken
      });
      expectAuthError(
        () => duplicateToken.claim(claimInput(rawCodeD, sourceKey(303), plus(baseTime(), 1_000))),
        "duplicate_secret"
      );
      expectUnclaimed(open.db, "pair_token_collision", sourceKey(303), 1);

      fixedRepository(open.db, { generatePairingCode: () => rawCodeE }).issue(issueInput("pair_metadata_collision"));
      const metadataCollision = fixedRepository(open.db, {
        generateDeviceId: () => `client_${rawCodeE}zz`
      });
      expectAuthError(
        () => metadataCollision.claim(claimInput(rawCodeE, sourceKey(304), plus(baseTime(), 1_000))),
        "pairing_claim_failed"
      );
      expectUnclaimed(open.db, "pair_metadata_collision", sourceKey(304), 1);

      fixedRepository(open.db, { generatePairingCode: () => rawCodeF }).issue(issueInput("pair_equal_credentials"));
      const equalCredential = "S".repeat(43);
      const equalCredentials = fixedRepository(open.db, {
        generateDeviceId: () => `client_${"s".repeat(24)}`,
        generateDeviceToken: () => equalCredential,
        generateCsrfToken: () => equalCredential
      });
      expectAuthError(
        () => equalCredentials.claim(claimInput(rawCodeF, sourceKey(305), plus(baseTime(), 1_000))),
        "pairing_claim_failed"
      );
      expectUnclaimed(open.db, "pair_equal_credentials", sourceKey(305), 1);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()).toEqual({ count: 1 });
    } finally {
      open.db.close();
    }
  });

  it("rolls back device, owner, and counters on update-count and deferred-commit failure", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const repository = fixedRepository(open.db);
      repository.issue(issueInput("pair_claim_rollback"));
      open.db.exec(`
        CREATE TRIGGER ignore_selected_pairing_owner_update
        BEFORE UPDATE OF used_at ON pairing_codes
        WHEN NEW.id = 'pair_claim_rollback'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      expectAuthError(
        () => repository.claim(claimInput(rawCodeA, sourceKey(310), plus(baseTime(), 1_000))),
        "pairing_claim_failed"
      );
      expectUnclaimed(open.db, "pair_claim_rollback", sourceKey(310));
      open.db.exec("DROP TRIGGER ignore_selected_pairing_owner_update");

      open.db.exec(`
        CREATE TABLE pairing_claim_commit_parent (id TEXT PRIMARY KEY);
        CREATE TABLE pairing_claim_commit_probe (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES pairing_claim_commit_parent(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_selected_claim_commit
        AFTER INSERT ON auth_devices
        WHEN NEW.id = '${selectedDeviceId}'
        BEGIN
          INSERT INTO pairing_claim_commit_probe (id, parent_id) VALUES (NEW.id, 'missing-parent');
        END;
      `);
      expectAuthError(
        () => repository.claim(claimInput(rawCodeA, sourceKey(311), plus(baseTime(), 2_000))),
        "pairing_claim_failed"
      );
      expectUnclaimed(open.db, "pair_claim_rollback", sourceKey(311));
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM pairing_claim_commit_probe").get()).toEqual({ count: 0 });
      open.db.exec("DROP TRIGGER fail_selected_claim_commit");

      expect(
        repository.claim(claimInput(rawCodeA, sourceKey(312), plus(baseTime(), 3_000))).pairingCode.claimed_device_id
      ).toBe(selectedDeviceId);
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()).toEqual({ count: 1 });
    } finally {
      open.db.close();
    }
  });

  it("serializes selected revoke state, rejects impossible time and legacy/used codes, and remains idempotent", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    const sentinel = "revoke-input-private-sentinel";
    try {
      const repository = fixedRepository(open.db, {
        generatePairingCode: sequenceGenerator([rawCodeA, rawCodeB])
      });
      repository.issue(issueInput("pair_revoke"));
      expectAuthError(
        () => repository.revoke("pair_revoke", { now: plus(baseTime(), -1) }),
        "invalid_time"
      );
      const revokedAt = plus(baseTime(), 1_000);
      const revoked = repository.revoke("pair_revoke", { now: revokedAt });
      expect(Object.isFrozen(revoked)).toBe(true);
      expect(revoked.revoked_at).toBe(revokedAt.toISOString());
      expect(repository.revoke("pair_revoke", { now: plus(baseTime(), 2_000) })).toEqual(revoked);
      expectAuthError(
        () => repository.claim(claimInput(rawCodeA, sourceKey(320), plus(baseTime(), 2_000))),
        "pairing_code_revoked"
      );

      repository.issue(issueInput("pair_used_before_revoke"));
      repository.claim(claimInput(rawCodeB, sourceKey(321), plus(baseTime(), 2_000)));
      expectAuthError(
        () => repository.revoke("pair_used_before_revoke", { now: plus(baseTime(), 3_000) }),
        "pairing_code_used"
      );
      const legacyRepository = createLegacyPairingCodeRepository(open.db);
      legacyRepository.createLegacy({
        id: "pair_legacy_revoke",
        rawCode: rawCodeC,
        permission: "write",
        createdAt: baseTime(),
        expiresAt: plus(baseTime(), 60_000)
      });
      expectAuthError(
        () => repository.revoke("pair_legacy_revoke", { now: plus(baseTime(), 1_000) }),
        "pairing_code_legacy"
      );
      fixedRepository(open.db, { generatePairingCode: () => rawCodeD }).issue(
        issueInput("pair_selected_legacy_boundary")
      );
      expectAuthError(
        () =>
          legacyRepository.claimLegacy({
            rawCode: rawCodeD,
            deviceId: `client_${"l".repeat(24)}`,
            rawDeviceToken: "L".repeat(43),
            rawCsrfToken: "M".repeat(43),
            now: plus(baseTime(), 1_000)
          }),
        "pairing_code_legacy"
      );
      expectAuthError(
        () => legacyRepository.revokeLegacy("pair_selected_legacy_boundary", { now: plus(baseTime(), 1_000) }),
        "pairing_code_legacy"
      );
      expect(rawPairingRow(open.db, "pair_selected_legacy_boundary")).toMatchObject({
        used_at: null,
        revoked_at: null,
        claimed_device_id: null
      });

      const hostileInput = Object.defineProperty({}, "now", {
        enumerable: true,
        get() {
          throw new Error(sentinel);
        }
      });
      expectErrorIsCauseFree(
        captureAuthError(() => repository.revoke("pair_revoke", hostileInput as never)),
        sentinel
      );
    } finally {
      open.db.close();
    }
  });

  it("fails loudly for corrupt pairing provenance, owner linkage, chronology, and rate rows", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: baseTime });
    try {
      const repository = fixedRepository(open.db, {
        generatePairingCode: sequenceGenerator([rawCodeA, rawCodeB, rawCodeC])
      });
      repository.issue(issueInput("pair_missing_owner"));
      repository.claim(claimInput(rawCodeA, sourceKey(330), plus(baseTime(), 1_000)));
      open.db.pragma("foreign_keys = OFF");
      open.db.prepare("DELETE FROM auth_devices WHERE id = ?").run(selectedDeviceId);
      expectAuthError(() => repository.require("pair_missing_owner"), "invalid_pairing_code");

      repository.issue(issueInput("pair_corrupt_chronology"));
      repository.issue(issueInput("pair_corrupt_hash"));
      open.db.pragma("ignore_check_constraints = ON");
      open.db
        .prepare("UPDATE pairing_codes SET revoked_at = ? WHERE id = ?")
        .run(plus(baseTime(), -1).toISOString(), "pair_corrupt_chronology");
      open.db.prepare("UPDATE pairing_codes SET code_hash = 'bad' WHERE id = ?").run("pair_corrupt_hash");
      open.db.pragma("ignore_check_constraints = OFF");
      expectAuthError(() => repository.require("pair_corrupt_chronology"), "invalid_pairing_code");
      expectAuthError(() => repository.require("pair_corrupt_hash"), "invalid_pairing_code");

      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(331), plus(baseTime(), 2_000))),
        "pairing_code_not_found"
      );
      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(332), plus(baseTime(), 2_000))),
        "pairing_code_not_found"
      );
      open.db.pragma("ignore_check_constraints = ON");
      open.db
        .prepare("UPDATE pairing_claim_rate_sources SET attempt_count = 0 WHERE source_key = ?")
        .run(sourceKey(331));
      open.db
        .prepare("UPDATE pairing_claim_rate_sources SET last_attempt_at = 'not-a-time' WHERE source_key = ?")
        .run(sourceKey(332));
      open.db.pragma("ignore_check_constraints = OFF");
      expectAuthError(() => repository.getRateSnapshot(sourceKey(331)), "invalid_pairing_rate_state");
      expectAuthError(
        () => repository.claim(claimInput(rawCodeE, sourceKey(332), plus(baseTime(), 3_000))),
        "invalid_pairing_rate_state"
      );
    } finally {
      open.db.close();
    }
  });

  it("fails cause-free on closed and read-only storage without inventing a successful write", () => {
    const path = tempDbPath();
    const writable = openMigratedDatabase(path, { now: baseTime });
    const closedRepository = fixedRepository(writable.db);
    closedRepository.issue(issueInput("pair_unavailable"));
    writable.db.close();

    expectAuthError(() => closedRepository.get("pair_unavailable"), "pairing_claim_failed");
    expectAuthError(
      () => closedRepository.issue(issueInput("pair_closed_issue")),
      "pairing_issue_failed"
    );
    expectAuthError(
      () => closedRepository.claim(claimInput(rawCodeE, sourceKey(340), plus(baseTime(), 1_000))),
      "pairing_claim_failed"
    );
    expectAuthError(() => closedRepository.getRateSnapshot(sourceKey(340)), "pairing_claim_failed");

    const readOnlyDb = new Database(path, { readonly: true });
    try {
      readOnlyDb.pragma("foreign_keys = ON");
      const readOnly = fixedRepository(readOnlyDb, { generatePairingCode: () => rawCodeB });
      expect(readOnly.require("pair_unavailable").id).toBe("pair_unavailable");
      expectAuthError(
        () => readOnly.issue(issueInput("pair_read_only_issue")),
        "pairing_issue_failed"
      );
      expectAuthError(
        () => readOnly.claim(claimInput(rawCodeE, sourceKey(341), plus(baseTime(), 1_000))),
        "pairing_claim_failed"
      );
    } finally {
      readOnlyDb.close();
    }
    const reopened = openMigratedDatabase(path, { now: baseTime });
    try {
      expect(reopened.db.prepare("SELECT id FROM pairing_codes ORDER BY id").all()).toEqual([
        { id: "pair_unavailable" }
      ]);
      expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources").get()).toEqual({ count: 0 });
    } finally {
      reopened.db.close();
    }
  });

  it("survives reopen while raw codes, credentials, peer material, and failed entropy stay out of SQLite files and errors", () => {
    const path = tempDbPath();
    const failedToken = "F".repeat(43);
    const rawPeer = "203.0.113.77:private-peer-sentinel";
    const first = openMigratedDatabase(path, { now: baseTime });
    first.db.pragma("journal_mode = WAL");
    first.db.pragma("wal_autocheckpoint = 0");
    try {
      const repository = fixedRepository(first.db, {
        generatePairingCode: sequenceGenerator([rawCodeA, rawCodeB])
      });
      repository.issue(issueInput("pair_private_success"));
      repository.claim(claimInput(rawCodeA, sourceKey(350), plus(baseTime(), 1_000)));
      repository.issue(issueInput("pair_private_failure"));
      const failing = fixedRepository(first.db, {
        generateDeviceId: () => `client_${"f".repeat(24)}`,
        generateDeviceToken: () => {
          throw new Error(`${failedToken}:${rawPeer}`);
        }
      });
      const error = expectAuthError(
        () => failing.claim(claimInput(rawCodeB, sourceKey(351), plus(baseTime(), 2_000))),
        "pairing_claim_failed"
      );
      expectErrorIsCauseFree(error, failedToken, rawPeer);
      expectUnclaimed(first.db, "pair_private_failure", sourceKey(351), 1);

      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (!existsSync(file)) continue;
        const bytes = readFileSync(file);
        for (const secret of [rawCodeA, rawCodeB, rawDeviceToken, rawCsrfToken, failedToken, rawPeer]) {
          expect(bytes.includes(Buffer.from(secret))).toBe(false);
        }
      }
    } finally {
      first.db.close();
    }

    const mainBytes = readFileSync(path);
    for (const secret of [rawCodeA, rawCodeB, rawDeviceToken, rawCsrfToken, failedToken, rawPeer]) {
      expect(mainBytes.includes(Buffer.from(secret))).toBe(false);
    }
    const reopened = openMigratedDatabase(path, { now: baseTime });
    try {
      const repository = fixedRepository(reopened.db);
      expect(repository.require("pair_private_success")).toMatchObject({
        used_at: plus(baseTime(), 1_000).toISOString(),
        claimed_device_id: selectedDeviceId
      });
      expect(repository.require("pair_private_failure")).toMatchObject({ used_at: null, claimed_device_id: null });
      expect(repository.getRateSnapshot(sourceKey(350))).toMatchObject({
        source: { attempt_count: 1 },
        global: { attempt_count: 1 }
      });
      expect(repository.getRateSnapshot(sourceKey(351)).source).toBeNull();
      expect(
        createAuthDeviceRepository(reopened.db).authenticateDeviceToken({
          rawDeviceToken,
          now: plus(baseTime(), 2_000)
        }).device.id
      ).toBe(selectedDeviceId);
    } finally {
      reopened.db.close();
    }
  });
});

describe("selected pairing real SQLite ordering", () => {
  it("has one durable same-code winner for same-source and different-source contenders", async () => {
    for (const sameSource of [true, false]) {
      const path = tempDbPath();
      const open = openMigratedDatabase(path, { now: baseTime });
      open.db.pragma("busy_timeout = 2000");
      try {
        const repository = fixedRepository(open.db);
        repository.issue(issueInput(`pair_worker_race_${sameSource ? "same" : "different"}`));
        const workerSource = sourceKey(sameSource ? 400 : 401);
        const mainSource = sameSource ? workerSource : sourceKey(402);
        const claimAt = plus(baseTime(), 1_000).toISOString();
        const worker = startPairingWriter(path, {
          operation: "claim",
          rawCode: rawCodeA,
          sourceKey: workerSource,
          at: claimAt
        });
        await worker.updated;
        expectAuthError(
          () => repository.claim(claimInput(rawCodeA, mainSource, new Date(claimAt))),
          "pairing_code_used"
        );
        await worker.completed;

        expect(open.db.prepare("SELECT id FROM auth_devices").all()).toEqual([{ id: workerDeviceId }]);
        expect(repository.require(`pair_worker_race_${sameSource ? "same" : "different"}`)).toMatchObject({
          used_at: claimAt,
          claimed_device_id: workerDeviceId
        });
        expect(repository.getRateSnapshot(workerSource).global?.attempt_count).toBe(2);
        if (sameSource) {
          expect(repository.getRateSnapshot(workerSource).source?.attempt_count).toBe(2);
        } else {
          expect(repository.getRateSnapshot(workerSource).source?.attempt_count).toBe(1);
          expect(repository.getRateSnapshot(mainSource).source?.attempt_count).toBe(1);
        }
      } finally {
        open.db.close();
      }
    }
  });

  it("serializes both revoke-first and claim-first ordering without partial credentials", async () => {
    const revokePath = tempDbPath();
    const revokeOpen = openMigratedDatabase(revokePath, { now: baseTime });
    revokeOpen.db.pragma("busy_timeout = 2000");
    try {
      const repository = fixedRepository(revokeOpen.db);
      repository.issue(issueInput("pair_revoke_worker_wins"));
      const at = plus(baseTime(), 1_000).toISOString();
      const worker = startPairingWriter(revokePath, { operation: "revoke", at });
      await worker.updated;
      expectAuthError(
        () => repository.claim(claimInput(rawCodeA, sourceKey(410), new Date(at))),
        "pairing_code_revoked"
      );
      await worker.completed;
      expect(repository.require("pair_revoke_worker_wins")).toMatchObject({ revoked_at: at, used_at: null });
      expect(revokeOpen.db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()).toEqual({ count: 0 });
      expect(repository.getRateSnapshot(sourceKey(410)).source?.attempt_count).toBe(1);
    } finally {
      revokeOpen.db.close();
    }

    const claimPath = tempDbPath();
    const claimOpen = openMigratedDatabase(claimPath, { now: baseTime });
    claimOpen.db.pragma("busy_timeout = 2000");
    try {
      const repository = fixedRepository(claimOpen.db, { generatePairingCode: () => rawCodeB });
      repository.issue(issueInput("pair_claim_worker_wins"));
      const at = plus(baseTime(), 1_000).toISOString();
      const worker = startPairingWriter(claimPath, {
        operation: "claim",
        rawCode: rawCodeB,
        sourceKey: sourceKey(411),
        at
      });
      await worker.updated;
      expectAuthError(
        () => repository.revoke("pair_claim_worker_wins", { now: new Date(at) }),
        "pairing_code_used"
      );
      await worker.completed;
      expect(repository.require("pair_claim_worker_wins")).toMatchObject({
        used_at: at,
        revoked_at: null,
        claimed_device_id: workerDeviceId
      });
      expect(claimOpen.db.prepare("SELECT id FROM auth_devices").all()).toEqual([{ id: workerDeviceId }]);
      expect(repository.getRateSnapshot(sourceKey(411)).global?.attempt_count).toBe(1);
    } finally {
      claimOpen.db.close();
    }
  });
});

interface FixedRepositoryOptions {
  readonly policy?: ResourceBudget;
  readonly generatePairingCode?: () => string;
  readonly generateDeviceId?: () => string;
  readonly generateDeviceToken?: () => string;
  readonly generateCsrfToken?: () => string;
}

const workerDeviceId = `client_${"w".repeat(24)}`;
const workerDeviceToken = "W".repeat(43);
const workerCsrfToken = "Y".repeat(43);

function fixedRepository(db: Database.Database, options: FixedRepositoryOptions = {}): PairingCodeRepository {
  return createPairingCodeRepository(db, {
    policy: options.policy ?? defaultResourceBudget,
    generatePairingCode: options.generatePairingCode ?? (() => rawCodeA),
    generateDeviceId: options.generateDeviceId ?? (() => selectedDeviceId),
    generateDeviceToken: options.generateDeviceToken ?? (() => rawDeviceToken),
    generateCsrfToken: options.generateCsrfToken ?? (() => rawCsrfToken)
  });
}

function pairingPolicy(overrides: Partial<ResourceBudget>): ResourceBudget {
  return resolveResourceBudget(overrides);
}

function issueInput(id: string, createdAt = baseTime()) {
  return {
    id,
    permission: "write" as const,
    clientLabel: "Android phone",
    createdAt
  };
}

function claimInput(rawCode: string, source: string, now: Date) {
  return { rawCode, sourceKey: source, now };
}

function sourceKey(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function baseTime(): Date {
  return new Date("2026-07-11T20:00:00.000Z");
}

function plus(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function sequenceGenerator(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("Pairing test sequence exhausted.");
    index += 1;
    return value;
  };
}

function countedGenerator(generator: () => string, onCall: () => void): () => string {
  return () => {
    onCall();
    return generator();
  };
}

function captureAuthError(fn: () => unknown): HostDeckAuthRepositoryError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckAuthRepositoryError);
  return caught as HostDeckAuthRepositoryError;
}

function expectAuthError(fn: () => unknown, code: AuthRepositoryErrorCode): HostDeckAuthRepositoryError {
  const error = captureAuthError(fn);
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  return error;
}

function expectErrorIsCauseFree(error: HostDeckAuthRepositoryError, ...sentinels: readonly string[]): void {
  expect(error.cause).toBeUndefined();
  const serialized = `${error.name}:${error.code}:${error.message}:${error.retryAt ?? ""}:${JSON.stringify(error)}`;
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
}

function rawPairingRow(db: Database.Database, id: string): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM pairing_codes WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Missing pairing row ${id}.`);
  return row as Readonly<Record<string, unknown>>;
}

function rawDeviceRow(db: Database.Database, id: string): Readonly<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Missing auth-device row ${id}.`);
  return row as Readonly<Record<string, unknown>>;
}

function expectUnclaimed(
  db: Database.Database,
  pairingId: string,
  source: string,
  expectedDeviceCount = 0
): void {
  expect(rawPairingRow(db, pairingId)).toMatchObject({ used_at: null, claimed_device_id: null });
  expect(db.prepare("SELECT COUNT(*) AS count FROM auth_devices").get()).toEqual({ count: expectedDeviceCount });
  expect(db.prepare("SELECT source_key FROM pairing_claim_rate_sources WHERE source_key = ?").get(source)).toBeUndefined();
}

function insertCorruptSelectedCode(db: Database.Database, id: string, rawCode: string): void {
  db.pragma("ignore_check_constraints = ON");
  try {
    db.prepare(
      `
        INSERT INTO pairing_codes (
          id, code_hash, permission, client_label, created_at, expires_at,
          used_at, revoked_at, claim_contract_version, claimed_device_id
        ) VALUES (?, ?, 'write', NULL, ?, ?, NULL, NULL, 1, NULL)
      `
    ).run(
      id,
      hashSecret(rawCode, { minLength: 22 }),
      baseTime().toISOString(),
      baseTime().toISOString()
    );
  } finally {
    db.pragma("ignore_check_constraints = OFF");
  }
}

interface PairingWriterInput {
  readonly operation: "claim" | "revoke";
  readonly at: string;
  readonly rawCode?: string;
  readonly sourceKey?: string;
}

function startPairingWriter(
  path: string,
  input: PairingWriterInput
): { readonly updated: Promise<void>; readonly completed: Promise<void> } {
  const worker = new Worker(
    `
      const { createHash } = require("node:crypto");
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      if (workerData.operation === "claim") {
        db.prepare(
          "INSERT INTO pairing_claim_rate_sources " +
          "(source_key, window_started_at, attempt_count, last_attempt_at) VALUES (?, ?, 1, ?)"
        ).run(workerData.sourceKey, workerData.at, workerData.at);
        db.prepare(
          "INSERT INTO pairing_claim_rate_global " +
          "(id, window_started_at, attempt_count, last_attempt_at) " +
          "VALUES ('pair_claim_global', ?, 1, ?)"
        ).run(workerData.at, workerData.at);
        const pair = db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").get(hash(workerData.rawCode));
        if (!pair || pair.used_at !== null || pair.revoked_at !== null || pair.claim_contract_version !== 1) {
          throw new Error("worker did not find one claimable selected code");
        }
        db.prepare(
          "INSERT INTO auth_devices (" +
          "id, token_hash, csrf_token_hash, csrf_generation, csrf_rotated_at, client_label, permission, " +
          "created_at, last_used_at, expires_at, revoked_at" +
          ") VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL)"
        ).run(
          workerData.deviceId,
          hash(workerData.rawDeviceToken),
          hash(workerData.rawCsrfToken),
          workerData.at,
          pair.client_label,
          pair.permission,
          workerData.at
        );
        const update = db.prepare(
          "UPDATE pairing_codes SET used_at = ?, claimed_device_id = ? " +
          "WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL"
        ).run(workerData.at, workerData.deviceId, pair.id);
        if (update.changes !== 1) throw new Error("worker claim lost");
      } else {
        const update = db.prepare(
          "UPDATE pairing_codes SET revoked_at = ? WHERE used_at IS NULL AND revoked_at IS NULL"
        ).run(workerData.at);
        if (update.changes !== 1) throw new Error("worker revoke lost");
      }
      parentPort.postMessage("updated");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: {
        ...input,
        databaseModule: betterSqlite3Path,
        path,
        deviceId: workerDeviceId,
        rawDeviceToken: workerDeviceToken,
        rawCsrfToken: workerCsrfToken
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
      else reject(new Error(`Pairing writer exited with code ${code}.`));
    });
  });
  return { updated, completed };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-selected-pairing-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}
