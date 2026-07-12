import { randomBytes } from "node:crypto";
import {
  type AuthDeviceRecord,
  assertResolvedResourceBudget,
  type PairingClaimRateGlobalRecord,
  type PairingClaimRateSourceRecord,
  type PairingCodeRecord,
  pairingClaimRateGlobalRecordSchema,
  pairingClaimRateSourceRecordSchema,
  pairingClaimSourceKeySchema,
  pairingClientLabelSchema,
  pairingCodeRecordSchema,
  type ResourceBudget,
  selectedRawPairingCodeSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import {
  type AuthRepositoryErrorCode,
  createAuthDeviceRepository,
  HostDeckAuthRepositoryError,
  hashSecret
} from "./auth-repository.js";

export interface IssuePairingCodeInput {
  readonly id: string;
  readonly permission: PairingCodeRecord["permission"];
  readonly clientLabel?: string | null;
  readonly createdAt: Date;
}

export interface ClaimSelectedPairingCodeInput {
  readonly rawCode: string;
  readonly sourceKey: string;
  readonly now: Date;
  readonly clientLabel?: string | null;
  readonly deviceExpiresAt?: Date | null;
}

export interface IssuedPairingCode {
  readonly pairingCode: PairingCodeRecord;
  readonly rawCode: string;
}

export interface SelectedPairingClaim {
  readonly pairingCode: PairingCodeRecord;
  readonly device: AuthDeviceRecord;
  readonly rawDeviceToken: string;
  readonly rawCsrfToken: string;
}

export interface PairingClaimRateSnapshot {
  readonly source: PairingClaimRateSourceRecord | null;
  readonly global: PairingClaimRateGlobalRecord | null;
}

export interface PairingCodeRepository {
  readonly get: (pairingId: string) => PairingCodeRecord | null;
  readonly require: (pairingId: string) => PairingCodeRecord;
  readonly issue: (input: IssuePairingCodeInput) => IssuedPairingCode;
  readonly claim: (input: ClaimSelectedPairingCodeInput) => SelectedPairingClaim;
  readonly revoke: (pairingId: string, input: { readonly now: Date }) => PairingCodeRecord;
  readonly getRateSnapshot: (sourceKey: string) => PairingClaimRateSnapshot;
}

export interface PairingCodeRepositoryOptions {
  readonly policy: ResourceBudget;
  readonly generatePairingCode?: () => string;
  readonly generateDeviceId?: () => string;
  readonly generateDeviceToken?: () => string;
  readonly generateCsrfToken?: () => string;
}

interface PairingCodeRow {
  readonly id: unknown;
  readonly code_hash: unknown;
  readonly permission: unknown;
  readonly client_label: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly used_at: unknown;
  readonly revoked_at: unknown;
  readonly claim_contract_version: unknown;
  readonly claimed_device_id: unknown;
}

interface RateSourceRow {
  readonly source_key: unknown;
  readonly window_started_at: unknown;
  readonly attempt_count: unknown;
  readonly last_attempt_at: unknown;
}

interface RateGlobalRow {
  readonly id: unknown;
  readonly window_started_at: unknown;
  readonly attempt_count: unknown;
  readonly last_attempt_at: unknown;
}

interface PreparedIssueInput {
  readonly id: string;
  readonly permission: PairingCodeRecord["permission"];
  readonly clientLabel: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface PreparedClaimInput {
  readonly rawCode: string;
  readonly sourceKey: string;
  readonly now: string;
  readonly nowMs: number;
  readonly clientLabel: string | null;
  readonly deviceExpiresAt: Date | null;
}

interface FixedWindow {
  readonly windowStartedAt: string;
  readonly attemptCount: number;
  readonly retryAt: string;
}

interface ClaimRejection {
  readonly kind: "rejected";
  readonly code:
    | "pairing_claim_capacity"
    | "pairing_claim_rate_limited"
    | "pairing_code_expired"
    | "pairing_code_legacy"
    | "pairing_code_not_found"
    | "pairing_code_revoked"
    | "pairing_code_used";
  readonly message: string;
  readonly retryAt?: string;
}

interface ClaimSuccess {
  readonly kind: "success";
  readonly pairingCode: PairingCodeRecord;
  readonly device: AuthDeviceRecord;
  readonly rawDeviceToken: string;
  readonly rawCsrfToken: string;
}

type ClaimTransactionResult = ClaimRejection | ClaimSuccess;

const selectedPairingCodeBytes = 16;
const selectedDeviceSecretBytes = 32;
const selectedDeviceIdBytes = 18;
const selectedDeviceIdPattern = /^client_[A-Za-z0-9_-]{24}$/u;
const selectedDeviceSecretPattern = /^[A-Za-z0-9_-]{43}$/u;
const maxSafeInteger = 9_007_199_254_740_991;

export function createPairingCodeRepository(
  db: Database.Database,
  options: PairingCodeRepositoryOptions
): PairingCodeRepository {
  const resolvedOptions = parseRepositoryOptions(options);
  const policy = resolvedOptions.policy;
  const generatePairingCode = resolvedOptions.generatePairingCode;
  const generateDeviceId = resolvedOptions.generateDeviceId;
  const generateDeviceToken = resolvedOptions.generateDeviceToken;
  const generateCsrfToken = resolvedOptions.generateCsrfToken;
  const authDevices = createAuthDeviceRepository(db);

  const issueTransaction = db.transaction((input: PreparedIssueInput): IssuedPairingCode => {
    const rawCode = generateSelectedValue(
      generatePairingCode,
      (candidate) => selectedRawPairingCodeSchema.safeParse(candidate).success,
      "pairing_issue_failed",
      "Pairing-code generation failed."
    );
    const codeHash = hashSelectedPairingCode(rawCode);
    assertSecretSeparation(
      [rawCode],
      [input.id, input.clientLabel, input.createdAt, input.expiresAt, codeHash],
      "pairing_issue_failed",
      "Generated pairing code conflicts with durable metadata."
    );
    const pairingCode = parseSelectedPairingCode({
      id: input.id,
      code_hash: codeHash,
      permission: input.permission,
      client_label: input.clientLabel,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      used_at: null,
      revoked_at: null,
      claim_contract_version: 1,
      claimed_device_id: null
    });
    insertPairingCode(db, pairingCode);
    return freezeIssuedPairingCode(pairingCode, rawCode);
  }).immediate;

  const claimTransaction = db.transaction((input: PreparedClaimInput): ClaimTransactionResult => {
    pruneExpiredSources(
      db,
      input.nowMs,
      policy.admission_state_ttl_ms,
      policy.admission_max_tracked_keys
    );
    const source = readRateSource(db, input.sourceKey);
    const global = readRateGlobal(db);
    assertNonRegressingRateTime(source, global, input.nowMs);

    if (source === null) {
      const tracked = readTrackedSourceCount(db);
      if (tracked >= policy.admission_max_tracked_keys) {
        return {
          kind: "rejected",
          code: "pairing_claim_capacity",
          message: "Pair-claim source capacity is exhausted.",
          retryAt: readSourceCapacityRetryAt(db, policy.admission_state_ttl_ms)
        };
      }
    }

    const sourceWindow = currentWindow(source, input.now, input.nowMs, policy.pair_claim_window_ms);
    const globalWindow = currentWindow(global, input.now, input.nowMs, policy.pair_claim_window_ms);
    if (sourceWindow.attemptCount >= policy.pair_claim_max_attempts_per_source) {
      return {
        kind: "rejected",
        code: "pairing_claim_rate_limited",
        message: "Pair-claim source attempt limit is exhausted.",
        retryAt: sourceWindow.retryAt
      };
    }
    if (globalWindow.attemptCount >= policy.pair_claim_max_attempts_global) {
      return {
        kind: "rejected",
        code: "pairing_claim_rate_limited",
        message: "Global pair-claim attempt limit is exhausted.",
        retryAt: globalWindow.retryAt
      };
    }

    writeRateSource(db, {
      source_key: input.sourceKey,
      window_started_at: sourceWindow.windowStartedAt,
      attempt_count: sourceWindow.attemptCount + 1,
      last_attempt_at: input.now
    });
    writeRateGlobal(db, {
      id: "pair_claim_global",
      window_started_at: globalWindow.windowStartedAt,
      attempt_count: globalWindow.attemptCount + 1,
      last_attempt_at: input.now
    });

    const pairingCode = readPairingCodeByHash(db, hashSelectedPairingCode(input.rawCode));
    if (pairingCode === null) return claimRejection("pairing_code_not_found", "Pairing code is not recognized.");
    if (pairingCode.claim_contract_version !== 1) {
      return claimRejection("pairing_code_legacy", "Pairing code is not valid for the selected claim path.");
    }
    if (pairingCode.revoked_at !== null) return claimRejection("pairing_code_revoked", "Pairing code has been revoked.");
    if (pairingCode.used_at !== null) return claimRejection("pairing_code_used", "Pairing code has already been used.");
    if (input.nowMs < Date.parse(pairingCode.created_at)) {
      throw selectedError("pairing_claim_time_conflict", "Pair-claim time precedes pairing-code creation.");
    }
    if (Date.parse(pairingCode.expires_at) <= input.nowMs) {
      return claimRejection("pairing_code_expired", "Pairing code has expired.");
    }

    const deviceId = generateSelectedValue(
      generateDeviceId,
      (candidate) => selectedDeviceIdPattern.test(candidate),
      "pairing_claim_failed",
      "Pair-claim device-id generation failed."
    );
    const rawDeviceToken = generateSelectedValue(
      generateDeviceToken,
      (candidate) => selectedDeviceSecretPattern.test(candidate),
      "pairing_claim_failed",
      "Pair-claim device-token generation failed."
    );
    const rawCsrfToken = generateSelectedValue(
      generateCsrfToken,
      (candidate) => selectedDeviceSecretPattern.test(candidate),
      "pairing_claim_failed",
      "Pair-claim CSRF generation failed."
    );
    const clientLabel = input.clientLabel ?? pairingCode.client_label;
    assertSecretSeparation(
      [input.rawCode, rawDeviceToken, rawCsrfToken],
      [
        input.sourceKey,
        input.now,
        pairingCode.id,
        pairingCode.code_hash,
        pairingCode.client_label,
        deviceId,
        clientLabel,
        hashSecret(rawDeviceToken, { label: "Selected device token", minLength: 43 }),
        hashSecret(rawCsrfToken, { label: "Selected CSRF token", minLength: 43 })
      ],
      "pairing_claim_failed",
      "Generated pair-claim credentials conflict with durable metadata."
    );
    const device = authDevices.create({
      id: deviceId,
      rawDeviceToken,
      rawCsrfToken,
      permission: pairingCode.permission,
      clientLabel,
      createdAt: new Date(input.nowMs),
      expiresAt: input.deviceExpiresAt
    });
    const update = db
      .prepare(
        `
          UPDATE pairing_codes
          SET used_at = @used_at, claimed_device_id = @claimed_device_id
          WHERE id = @id
            AND claim_contract_version = 1
            AND used_at IS NULL
            AND revoked_at IS NULL
        `
      )
      .run({ claimed_device_id: device.id, id: pairingCode.id, used_at: input.now });
    if (update.changes !== 1) {
      throw selectedError("pairing_claim_failed", "Pair-claim ownership changed before commit.");
    }
    const claimed = requirePairingCode(db, pairingCode.id);
    return {
      kind: "success",
      pairingCode: claimed,
      device,
      rawDeviceToken,
      rawCsrfToken
    };
  }).immediate;

  const revokeTransaction = db.transaction((pairingId: string, now: string, nowMs: number): PairingCodeRecord => {
    const current = requirePairingCode(db, pairingId);
    if (current.claim_contract_version !== 1) {
      throw selectedError("pairing_code_legacy", "Legacy pairing codes cannot use the selected revoke path.");
    }
    if (current.used_at !== null) {
      throw selectedError("pairing_code_used", "A used pairing code cannot be revoked.");
    }
    if (current.revoked_at !== null) return current;
    if (nowMs < Date.parse(current.created_at)) {
      throw selectedError("invalid_time", "Pairing-code revocation time cannot precede creation.");
    }
    const update = db
      .prepare("UPDATE pairing_codes SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL")
      .run(now, pairingId);
    if (update.changes !== 1) {
      throw selectedError("pairing_claim_failed", "Pairing-code revoke state changed before commit.");
    }
    return requirePairingCode(db, pairingId);
  }).immediate;

  return {
    get(pairingId) {
      try {
        return readPairingCodeById(db, parsePairingId(pairingId));
      } catch (error) {
        throw sanitizeSelectedError(error, "pairing_claim_failed", "Unable to read selected pairing storage.");
      }
    },
    require(pairingId) {
      try {
        return requirePairingCode(db, parsePairingId(pairingId));
      } catch (error) {
        throw sanitizeSelectedError(error, "pairing_claim_failed", "Unable to read selected pairing storage.");
      }
    },
    issue(input) {
      try {
        return issueTransaction(prepareIssueInput(input, policy));
      } catch (error) {
        throw sanitizeSelectedError(error, "pairing_issue_failed", "Pairing-code issuance failed.");
      }
    },
    claim(input) {
      try {
        const result = claimTransaction(prepareClaimInput(input));
        if (result.kind === "rejected") {
          throw selectedError(result.code, result.message, result.retryAt);
        }
        return freezeSelectedClaim(result);
      } catch (error) {
        throw sanitizeSelectedError(error, "pairing_claim_failed", "Pairing-code claim failed.");
      }
    },
    revoke(pairingId, input) {
      try {
        const id = parsePairingId(pairingId);
        const now = prepareRevokeInput(input);
        return Object.freeze({ ...revokeTransaction(id, now.at, now.time) });
      } catch (error) {
        throw sanitizeSelectedError(error, "pairing_claim_failed", "Pairing-code revoke failed.");
      }
    },
    getRateSnapshot(sourceKey) {
      try {
        const source = parseSourceKey(sourceKey);
        const sourceRecord = readRateSource(db, source);
        const globalRecord = readRateGlobal(db);
        return Object.freeze({
          source: sourceRecord === null ? null : Object.freeze({ ...sourceRecord }),
          global: globalRecord === null ? null : Object.freeze({ ...globalRecord })
        });
      } catch (error) {
        throw sanitizeSelectedError(error, "pairing_claim_failed", "Unable to read pair-claim rate state.");
      }
    }
  };
}

function parseRepositoryOptions(options: unknown): Required<PairingCodeRepositoryOptions> {
  const values = readExactInput(
    options,
    ["generateCsrfToken", "generateDeviceId", "generateDeviceToken", "generatePairingCode", "policy"],
    ["policy"],
    "invalid_pairing_policy",
    "Selected pairing repository options are invalid."
  );
  return {
    policy: parsePolicy(values.policy),
    generatePairingCode: parseGenerator(values.generatePairingCode, defaultPairingCodeGenerator),
    generateDeviceId: parseGenerator(values.generateDeviceId, defaultDeviceIdGenerator),
    generateDeviceToken: parseGenerator(values.generateDeviceToken, defaultDeviceSecretGenerator),
    generateCsrfToken: parseGenerator(values.generateCsrfToken, defaultDeviceSecretGenerator)
  };
}

function parseGenerator(candidate: unknown, fallback: () => string): () => string {
  if (candidate === undefined) return fallback;
  if (typeof candidate !== "function") {
    throw selectedError("invalid_pairing_policy", "Selected pairing repository generators must be functions.");
  }
  return candidate as () => string;
}

function parsePolicy(candidate: unknown): ResourceBudget {
  try {
    assertResolvedResourceBudget(candidate);
    return candidate;
  } catch {
    throw selectedError("invalid_pairing_policy", "Selected pairing policy must be one resolved resource budget.");
  }
}

function prepareIssueInput(input: IssuePairingCodeInput, policy: ResourceBudget): PreparedIssueInput {
  const values = readExactInput(
    input,
    ["clientLabel", "createdAt", "id", "permission"],
    ["createdAt", "id", "permission"]
  );
  const createdAt = parseDate(values.createdAt, "Pairing-code creation time");
  return {
    id: parsePairingId(values.id),
    permission: parsePermission(values.permission),
    clientLabel: parseClientLabel(values.clientLabel),
    createdAt: createdAt.at,
    expiresAt: addMilliseconds(createdAt.time, policy.pairing_code_lifetime_ms, "Pairing-code expiry")
  };
}

function prepareClaimInput(input: ClaimSelectedPairingCodeInput): PreparedClaimInput {
  const values = readExactInput(
    input,
    ["clientLabel", "deviceExpiresAt", "now", "rawCode", "sourceKey"],
    ["now", "rawCode", "sourceKey"]
  );
  const rawCode = selectedRawPairingCodeSchema.safeParse(values.rawCode);
  if (!rawCode.success) throw selectedError("invalid_secret", "Selected pairing code is invalid.");
  const now = parseDate(values.now, "Pair-claim time");
  const deviceExpiresAt = values.deviceExpiresAt === undefined || values.deviceExpiresAt === null
    ? null
    : new Date(parseDate(values.deviceExpiresAt, "Pair-claim device expiry").time);
  if (deviceExpiresAt !== null && deviceExpiresAt.getTime() <= now.time) {
    throw selectedError("invalid_time", "Pair-claim device expiry must follow claim time.");
  }
  return {
    rawCode: rawCode.data,
    sourceKey: parseSourceKey(values.sourceKey),
    now: now.at,
    nowMs: now.time,
    clientLabel: parseClientLabel(values.clientLabel),
    deviceExpiresAt
  };
}

function prepareRevokeInput(input: unknown): { readonly at: string; readonly time: number } {
  const values = readExactInput(input, ["now"], ["now"]);
  return parseDate(values.now, "Pairing-code revoke time");
}

function readExactInput(
  candidate: unknown,
  allowed: readonly string[],
  required: readonly string[],
  code: AuthRepositoryErrorCode = "invalid_pairing_code",
  message = "Selected pairing input has unsupported or missing fields."
): Readonly<Record<string, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError();
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError();
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    throw selectedError(code, message);
  }
}

function parsePairingId(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 120 || !/^[A-Za-z0-9_.:-]+$/u.test(candidate)) {
    throw selectedError("invalid_pairing_code", "Selected pairing id is invalid.");
  }
  return candidate;
}

function parsePermission(candidate: unknown): PairingCodeRecord["permission"] {
  if (candidate !== "read" && candidate !== "write") {
    throw selectedError("invalid_pairing_code", "Selected pairing permission is invalid.");
  }
  return candidate;
}

function parseClientLabel(candidate: unknown): string | null {
  const parsed = pairingClientLabelSchema.safeParse(candidate ?? null);
  if (!parsed.success) throw selectedError("invalid_pairing_code", "Selected pairing client label is invalid.");
  return parsed.data;
}

function parseSourceKey(candidate: unknown): string {
  const parsed = pairingClaimSourceKeySchema.safeParse(candidate);
  if (!parsed.success) throw selectedError("invalid_pairing_source", "Pair-claim source key is invalid.");
  return parsed.data;
}

function parseDate(candidate: unknown, label: string): { readonly at: string; readonly time: number } {
  if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) {
    throw selectedError("invalid_time", `${label} is invalid.`);
  }
  return { at: candidate.toISOString(), time: candidate.getTime() };
}

function addMilliseconds(time: number, milliseconds: number, label: string): string {
  const result = time + milliseconds;
  if (!Number.isSafeInteger(result)) throw selectedError("invalid_time", `${label} is outside the supported range.`);
  try {
    return new Date(result).toISOString();
  } catch {
    throw selectedError("invalid_time", `${label} is outside the supported range.`);
  }
}

function generateSelectedValue(
  generator: () => string,
  valid: (candidate: string) => boolean,
  code: "pairing_claim_failed" | "pairing_issue_failed",
  message: string
): string {
  let candidate: unknown;
  try {
    candidate = generator();
  } catch {
    throw selectedError(code, message);
  }
  if (typeof candidate !== "string" || !valid(candidate)) {
    throw selectedError(code, message);
  }
  return candidate;
}

function defaultPairingCodeGenerator(): string {
  return randomBytes(selectedPairingCodeBytes).toString("base64url");
}

function defaultDeviceIdGenerator(): string {
  return `client_${randomBytes(selectedDeviceIdBytes).toString("base64url")}`;
}

function defaultDeviceSecretGenerator(): string {
  return randomBytes(selectedDeviceSecretBytes).toString("base64url");
}

function hashSelectedPairingCode(rawCode: string): string {
  return hashSecret(rawCode, { label: "Selected pairing code", minLength: 22 });
}

function insertPairingCode(db: Database.Database, record: PairingCodeRecord): void {
  db.prepare(
    `
      INSERT INTO pairing_codes (
        id, code_hash, permission, client_label, created_at, expires_at,
        used_at, revoked_at, claim_contract_version, claimed_device_id
      ) VALUES (
        @id, @code_hash, @permission, @client_label, @created_at, @expires_at,
        @used_at, @revoked_at, @claim_contract_version, @claimed_device_id
      )
    `
  ).run(record);
}

function readPairingCodeById(db: Database.Database, id: string): PairingCodeRecord | null {
  const row = db.prepare("SELECT * FROM pairing_codes WHERE id = ?").get(id) as PairingCodeRow | undefined;
  return row === undefined ? null : assertClaimedDeviceOwnerExists(db, parseStoredPairingCode(row));
}

function requirePairingCode(db: Database.Database, id: string): PairingCodeRecord {
  const record = readPairingCodeById(db, id);
  if (record === null) throw selectedError("pairing_code_not_found", "Pairing code does not exist.");
  return record;
}

function readPairingCodeByHash(db: Database.Database, codeHash: string): PairingCodeRecord | null {
  const row = db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").get(codeHash) as PairingCodeRow | undefined;
  return row === undefined ? null : assertClaimedDeviceOwnerExists(db, parseStoredPairingCode(row));
}

function parseStoredPairingCode(row: PairingCodeRow): PairingCodeRecord {
  const result = pairingCodeRecordSchema.safeParse({
    id: row.id,
    code_hash: row.code_hash,
    permission: row.permission,
    client_label: row.client_label,
    created_at: row.created_at,
    expires_at: row.expires_at,
    used_at: row.used_at,
    revoked_at: row.revoked_at,
    claim_contract_version: row.claim_contract_version,
    claimed_device_id: row.claimed_device_id
  });
  if (!result.success) throw selectedError("invalid_pairing_code", "Stored selected pairing-code row is invalid.");
  return result.data;
}

function assertClaimedDeviceOwnerExists(db: Database.Database, record: PairingCodeRecord): PairingCodeRecord {
  if (record.claimed_device_id === null) return record;
  const owner = db.prepare("SELECT id FROM auth_devices WHERE id = ?").get(record.claimed_device_id) as
    | { readonly id: unknown }
    | undefined;
  if (owner === undefined || owner.id !== record.claimed_device_id) {
    throw selectedError("invalid_pairing_code", "Stored selected pairing-code owner is invalid.");
  }
  return record;
}

function parseSelectedPairingCode(candidate: unknown): PairingCodeRecord {
  const result = pairingCodeRecordSchema.safeParse(candidate);
  if (!result.success || result.data.claim_contract_version !== 1) {
    throw selectedError("invalid_pairing_code", "Selected pairing-code record is invalid.");
  }
  return result.data;
}

function pruneExpiredSources(db: Database.Database, nowMs: number, ttlMs: number, limit: number): void {
  const cutoff = addMilliseconds(nowMs, -ttlMs, "Pair-claim source cutoff");
  db.prepare(
    `
      DELETE FROM pairing_claim_rate_sources
      WHERE source_key IN (
        SELECT source_key
        FROM pairing_claim_rate_sources
        WHERE last_attempt_at <= ?
        ORDER BY last_attempt_at, source_key
        LIMIT ?
      )
    `
  ).run(cutoff, limit);
}

function readTrackedSourceCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM pairing_claim_rate_sources").get() as { readonly count: unknown };
  if (!Number.isSafeInteger(row.count) || (row.count as number) < 0) {
    throw selectedError("invalid_pairing_rate_state", "Stored pair-claim source count is invalid.");
  }
  return row.count as number;
}

function readSourceCapacityRetryAt(db: Database.Database, ttlMs: number): string {
  const row = db
    .prepare("SELECT last_attempt_at FROM pairing_claim_rate_sources ORDER BY last_attempt_at, source_key LIMIT 1")
    .get() as { readonly last_attempt_at: unknown } | undefined;
  if (row === undefined || typeof row.last_attempt_at !== "string") {
    throw selectedError("invalid_pairing_rate_state", "Stored pair-claim capacity state is invalid.");
  }
  const parsed = Date.parse(row.last_attempt_at);
  if (!Number.isFinite(parsed)) throw selectedError("invalid_pairing_rate_state", "Stored pair-claim capacity time is invalid.");
  return addMilliseconds(parsed, ttlMs, "Pair-claim capacity retry time");
}

function readRateSource(db: Database.Database, sourceKey: string): PairingClaimRateSourceRecord | null {
  const row = db.prepare("SELECT * FROM pairing_claim_rate_sources WHERE source_key = ?").get(sourceKey) as RateSourceRow | undefined;
  if (row === undefined) return null;
  const result = pairingClaimRateSourceRecordSchema.safeParse(row);
  if (!result.success) throw selectedError("invalid_pairing_rate_state", "Stored pair-claim source state is invalid.");
  return result.data;
}

function readRateGlobal(db: Database.Database): PairingClaimRateGlobalRecord | null {
  const row = db.prepare("SELECT * FROM pairing_claim_rate_global WHERE id = 'pair_claim_global'").get() as RateGlobalRow | undefined;
  if (row === undefined) return null;
  const result = pairingClaimRateGlobalRecordSchema.safeParse(row);
  if (!result.success) throw selectedError("invalid_pairing_rate_state", "Stored global pair-claim state is invalid.");
  return result.data;
}

function assertNonRegressingRateTime(
  source: PairingClaimRateSourceRecord | null,
  global: PairingClaimRateGlobalRecord | null,
  nowMs: number
): void {
  if (
    (source !== null && nowMs < Date.parse(source.last_attempt_at)) ||
    (global !== null && nowMs < Date.parse(global.last_attempt_at))
  ) {
    throw selectedError("pairing_claim_time_conflict", "Pair-claim time regressed behind durable rate state.");
  }
}

function currentWindow(
  current: PairingClaimRateSourceRecord | PairingClaimRateGlobalRecord | null,
  now: string,
  nowMs: number,
  windowMs: number
): FixedWindow {
  if (current === null || nowMs - Date.parse(current.window_started_at) >= windowMs) {
    return { windowStartedAt: now, attemptCount: 0, retryAt: addMilliseconds(nowMs, windowMs, "Pair-claim retry time") };
  }
  return {
    windowStartedAt: current.window_started_at,
    attemptCount: current.attempt_count,
    retryAt: addMilliseconds(Date.parse(current.window_started_at), windowMs, "Pair-claim retry time")
  };
}

function writeRateSource(db: Database.Database, record: unknown): void {
  const parsed = pairingClaimRateSourceRecordSchema.safeParse(record);
  if (!parsed.success || parsed.data.attempt_count > maxSafeInteger) {
    throw selectedError("invalid_pairing_rate_state", "Pair-claim source state is invalid.");
  }
  db.prepare(
    `
      INSERT INTO pairing_claim_rate_sources (source_key, window_started_at, attempt_count, last_attempt_at)
      VALUES (@source_key, @window_started_at, @attempt_count, @last_attempt_at)
      ON CONFLICT(source_key) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        attempt_count = excluded.attempt_count,
        last_attempt_at = excluded.last_attempt_at
    `
  ).run(parsed.data);
}

function writeRateGlobal(db: Database.Database, record: unknown): void {
  const parsed = pairingClaimRateGlobalRecordSchema.safeParse(record);
  if (!parsed.success || parsed.data.attempt_count > maxSafeInteger) {
    throw selectedError("invalid_pairing_rate_state", "Global pair-claim state is invalid.");
  }
  db.prepare(
    `
      INSERT INTO pairing_claim_rate_global (id, window_started_at, attempt_count, last_attempt_at)
      VALUES (@id, @window_started_at, @attempt_count, @last_attempt_at)
      ON CONFLICT(id) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        attempt_count = excluded.attempt_count,
        last_attempt_at = excluded.last_attempt_at
    `
  ).run(parsed.data);
}

function claimRejection(code: ClaimRejection["code"], message: string): ClaimRejection {
  return { kind: "rejected", code, message };
}

function freezeIssuedPairingCode(pairingCode: PairingCodeRecord, rawCode: string): IssuedPairingCode {
  return Object.freeze({ pairingCode: Object.freeze({ ...pairingCode }), rawCode });
}

function freezeSelectedClaim(result: ClaimSuccess): SelectedPairingClaim {
  return Object.freeze({
    pairingCode: Object.freeze({ ...result.pairingCode }),
    device: Object.freeze({ ...result.device }),
    rawDeviceToken: result.rawDeviceToken,
    rawCsrfToken: result.rawCsrfToken
  });
}

function assertSecretSeparation(
  rawSecrets: readonly string[],
  durableValues: readonly (string | null)[],
  code: "pairing_claim_failed" | "pairing_issue_failed",
  message: string
): void {
  if (new Set(rawSecrets).size !== rawSecrets.length) throw selectedError(code, message);
  for (const rawSecret of rawSecrets) {
    if (durableValues.some((value) => value?.includes(rawSecret))) {
      throw selectedError(code, message);
    }
  }
}

function selectedError(
  code: ConstructorParameters<typeof HostDeckAuthRepositoryError>[0],
  message: string,
  retryAt?: string
): HostDeckAuthRepositoryError {
  return new HostDeckAuthRepositoryError(code, message, retryAt === undefined ? undefined : { retryAt });
}

function sanitizeSelectedError(
  error: unknown,
  fallbackCode: ConstructorParameters<typeof HostDeckAuthRepositoryError>[0],
  fallbackMessage: string
): HostDeckAuthRepositoryError {
  if (error instanceof HostDeckAuthRepositoryError) {
    const selectedMessages: Partial<Record<AuthRepositoryErrorCode, string>> = {
      device_exists: "Generated pair-claim device id already exists.",
      duplicate_secret: "Generated pair-claim credential already exists.",
      invalid_auth_device: "Generated pair-claim device state is invalid.",
      invalid_pairing_code: "Selected pairing-code state is invalid.",
      invalid_pairing_policy: "Selected pairing policy is invalid.",
      invalid_pairing_rate_state: "Stored pair-claim rate state is invalid.",
      invalid_pairing_source: "Pair-claim source key is invalid.",
      invalid_secret: "Selected pairing credential is invalid.",
      invalid_time: "Selected pairing time is invalid.",
      pairing_claim_capacity: "Pair-claim source capacity is exhausted.",
      pairing_claim_failed: "Pairing-code claim failed.",
      pairing_claim_rate_limited: "Pair-claim attempt limit is exhausted.",
      pairing_claim_time_conflict: "Pair-claim time conflicts with durable state.",
      pairing_code_expired: "Pairing code has expired.",
      pairing_code_legacy: "Pairing code is not valid for the selected path.",
      pairing_code_not_found: "Pairing code is not available.",
      pairing_code_revoked: "Pairing code has been revoked.",
      pairing_code_used: "Pairing code has already been used.",
      pairing_issue_failed: "Pairing-code issuance failed."
    };
    const selectedMessage = selectedMessages[error.code];
    if (selectedMessage !== undefined) {
      return selectedError(error.code, selectedMessage, sanitizeRetryAt(error.retryAt));
    }
  }
  return selectedError(fallbackCode, fallbackMessage);
}

function sanitizeRetryAt(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  const time = Date.parse(candidate);
  if (!Number.isFinite(time)) return undefined;
  try {
    return new Date(time).toISOString() === candidate ? candidate : undefined;
  } catch {
    return undefined;
  }
}
