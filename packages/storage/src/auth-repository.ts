import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type AuthDeviceRecord, authDeviceRecordSchema, type PairingCodeRecord, pairingCodeRecordSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type AuthRepositoryErrorCode =
  | "authentication_conflict"
  | "authentication_failed"
  | "csrf_generation_exhausted"
  | "csrf_mismatch"
  | "csrf_rotation_conflict"
  | "csrf_rotation_failed"
  | "device_exists"
  | "device_expired"
  | "device_not_found"
  | "device_revoked"
  | "duplicate_secret"
  | "invalid_auth_device"
  | "invalid_secret"
  | "invalid_time"
  | "invalid_pairing_code"
  | "pairing_code_exists"
  | "pairing_code_expired"
  | "pairing_code_not_found"
  | "pairing_code_revoked"
  | "pairing_code_used"
  | "read_only";

export interface HashSecretOptions {
  readonly label?: string;
  readonly minLength?: number;
}

export class HostDeckAuthRepositoryError extends Error {
  constructor(
    readonly code: AuthRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckAuthRepositoryError";
  }
}

export interface CreateAuthDeviceInput {
  readonly id: string;
  readonly rawDeviceToken: string;
  readonly rawCsrfToken: string;
  readonly permission: AuthDeviceRecord["permission"];
  readonly clientLabel?: string | null;
  readonly createdAt: Date;
  readonly expiresAt?: Date | null;
}

export interface CreatePairingCodeInput {
  readonly id: string;
  readonly rawCode: string;
  readonly permission: PairingCodeRecord["permission"];
  readonly clientLabel?: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface ClaimPairingCodeInput {
  readonly rawCode: string;
  readonly deviceId: string;
  readonly rawDeviceToken: string;
  readonly rawCsrfToken: string;
  readonly now: Date;
  readonly clientLabel?: string | null;
  readonly deviceExpiresAt?: Date | null;
}

export interface AuthenticateDeviceInput {
  readonly rawDeviceToken: string;
  readonly now: Date;
}

export type RotateCsrfBootstrapInput = AuthenticateDeviceInput;

export interface CsrfBootstrapRotation {
  readonly deviceId: string;
  readonly rawCsrfToken: string;
  readonly csrfGeneration: number;
  readonly rotatedAt: string;
}

export interface AuthDeviceRepositoryOptions {
  readonly generateCsrfToken?: () => string;
}

export interface AuthorizeBrowserWriteInput extends AuthenticateDeviceInput {
  readonly rawCsrfToken: string;
}

export interface AuthDeviceAuthentication {
  readonly trusted: true;
  readonly readOnly: boolean;
  readonly device: AuthDeviceRecord;
}

export interface PairingClaim {
  readonly pairingCode: PairingCodeRecord;
  readonly device: AuthDeviceRecord;
}

export interface AuthDeviceRepository {
  readonly get: (deviceId: string) => AuthDeviceRecord | null;
  readonly require: (deviceId: string) => AuthDeviceRecord;
  readonly list: () => readonly AuthDeviceRecord[];
  readonly create: (input: CreateAuthDeviceInput) => AuthDeviceRecord;
  readonly authenticateDeviceToken: (input: AuthenticateDeviceInput) => AuthDeviceAuthentication;
  readonly rotateCsrfBootstrap: (input: RotateCsrfBootstrapInput) => CsrfBootstrapRotation;
  readonly authorizeBrowserWrite: (input: AuthorizeBrowserWriteInput) => AuthDeviceRecord;
  readonly revoke: (deviceId: string, input: { readonly now: Date }) => AuthDeviceRecord;
}

export interface PairingCodeRepository {
  readonly get: (pairingId: string) => PairingCodeRecord | null;
  readonly require: (pairingId: string) => PairingCodeRecord;
  readonly create: (input: CreatePairingCodeInput) => PairingCodeRecord;
  readonly claim: (input: ClaimPairingCodeInput) => PairingClaim;
  readonly revoke: (pairingId: string, input: { readonly now: Date }) => PairingCodeRecord;
}

interface AuthDeviceRow {
  readonly id: string;
  readonly token_hash: string;
  readonly csrf_token_hash: string;
  readonly csrf_generation: number;
  readonly csrf_rotated_at: string;
  readonly client_label: string | null;
  readonly permission: AuthDeviceRecord["permission"];
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

interface PairingCodeRow {
  readonly id: string;
  readonly code_hash: string;
  readonly permission: PairingCodeRecord["permission"];
  readonly client_label: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly revoked_at: string | null;
}

const pairingCodeMinLength = 6;
const deviceSecretMinLength = 24;
const rawSecretMaxLength = 512;
const csrfTokenBytes = 32;

export function createAuthDeviceRepository(
  db: Database.Database,
  options: AuthDeviceRepositoryOptions = {}
): AuthDeviceRepository {
  const generateCsrfToken = options.generateCsrfToken ?? defaultCsrfTokenGenerator;
  const authenticateDeviceToken = createDeviceAuthenticationTransaction(db);
  const authorizeBrowserWrite = createBrowserWriteAuthorizationTransaction(db);
  const rotateCsrfBootstrap = createCsrfBootstrapTransaction(db, generateCsrfToken);

  return {
    get(deviceId) {
      const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(deviceId) as AuthDeviceRow | undefined;
      return row === undefined ? null : parseAuthDeviceRow(row);
    },
    require(deviceId) {
      const device = this.get(deviceId);

      if (device === null) {
        throw new HostDeckAuthRepositoryError("device_not_found", `Auth device ${deviceId} does not exist.`);
      }

      return device;
    },
    list() {
      return (db.prepare("SELECT * FROM auth_devices ORDER BY created_at ASC, id ASC").all() as AuthDeviceRow[]).map(parseAuthDeviceRow);
    },
    create(input) {
      return insertAuthDevice(db, authDeviceFromInput(input));
    },
    authenticateDeviceToken(input) {
      const touched = runAuthenticationTransaction(() => authenticateDeviceToken(input));

      return {
        trusted: true,
        readOnly: touched.permission === "read",
        device: touched
      };
    },
    rotateCsrfBootstrap(input) {
      try {
        return rotateCsrfBootstrap(input);
      } catch (error) {
        if (error instanceof HostDeckAuthRepositoryError) {
          throw error;
        }

        throw new HostDeckAuthRepositoryError("csrf_rotation_failed", "CSRF bootstrap rotation failed.");
      }
    },
    authorizeBrowserWrite(input) {
      return runAuthenticationTransaction(() => authorizeBrowserWrite(input));
    },
    revoke(deviceId, input) {
      const current = this.require(deviceId);

      if (current.revoked_at !== null) {
        return current;
      }

      db.prepare("UPDATE auth_devices SET revoked_at = ? WHERE id = ?").run(nowIso(input.now), deviceId);
      return this.require(deviceId);
    }
  };
}

function createDeviceAuthenticationTransaction(
  db: Database.Database
): (input: AuthenticateDeviceInput) => AuthDeviceRecord {
  return db.transaction((input: AuthenticateDeviceInput): AuthDeviceRecord => {
    const observedAt = nowIso(input.now);
    const current = requireUsableDeviceByToken(db, input.rawDeviceToken, input.now);
    return advanceLastUsedAt(db, current, observedAt);
  }).immediate;
}

function createBrowserWriteAuthorizationTransaction(
  db: Database.Database
): (input: AuthorizeBrowserWriteInput) => AuthDeviceRecord {
  return db.transaction((input: AuthorizeBrowserWriteInput): AuthDeviceRecord => {
    const observedAt = nowIso(input.now);
    const current = requireUsableDeviceByToken(db, input.rawDeviceToken, input.now);

    if (current.permission === "read") {
      throw new HostDeckAuthRepositoryError("read_only", "Read-only auth devices cannot write.");
    }

    if (!hashMatches(current.csrf_token_hash, input.rawCsrfToken)) {
      throw new HostDeckAuthRepositoryError("csrf_mismatch", "Browser write rejected because the CSRF token does not match.");
    }

    return advanceLastUsedAt(db, current, observedAt);
  }).immediate;
}

function advanceLastUsedAt(
  db: Database.Database,
  current: AuthDeviceRecord,
  observedAt: string
): AuthDeviceRecord {
  const observedAtMs = Date.parse(observedAt);
  if (observedAtMs < Date.parse(current.created_at)) {
    throw new HostDeckAuthRepositoryError("invalid_time", "Authentication time cannot precede device creation.");
  }

  if (current.last_used_at !== null) {
    const currentLastUsedAtMs = Date.parse(current.last_used_at);
    if (observedAtMs < currentLastUsedAtMs) {
      throw new HostDeckAuthRepositoryError(
        "authentication_conflict",
        "Authentication observation is older than current device state."
      );
    }
    if (observedAtMs === currentLastUsedAtMs) return current;
  }

  const update = db
    .prepare(
      `
        UPDATE auth_devices
        SET last_used_at = ?
        WHERE id = ?
          AND token_hash = ?
          AND csrf_token_hash = ?
          AND csrf_generation = ?
          AND permission = ?
          AND expires_at IS ?
          AND revoked_at IS ?
          AND last_used_at IS ?
      `
    )
    .run(
      observedAt,
      current.id,
      current.token_hash,
      current.csrf_token_hash,
      current.csrf_generation,
      current.permission,
      current.expires_at,
      current.revoked_at,
      current.last_used_at
    );
  if (update.changes !== 1) {
    throw new HostDeckAuthRepositoryError(
      "authentication_conflict",
      "Auth device authority changed before authentication committed."
    );
  }

  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(current.id) as AuthDeviceRow | undefined;
  if (row === undefined) {
    throw new HostDeckAuthRepositoryError("authentication_conflict", "Auth device disappeared before authentication committed.");
  }
  return parseAuthDeviceRow(row);
}

function runAuthenticationTransaction<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HostDeckAuthRepositoryError) throw error;
    throw new HostDeckAuthRepositoryError("authentication_failed", "Auth device authentication failed.");
  }
}

function createCsrfBootstrapTransaction(
  db: Database.Database,
  generateCsrfToken: () => string
): (input: RotateCsrfBootstrapInput) => CsrfBootstrapRotation {
  return db.transaction((input: RotateCsrfBootstrapInput): CsrfBootstrapRotation => {
    const rotatedAt = nowIso(input.now);
    const current = requireUsableDeviceByToken(db, input.rawDeviceToken, input.now);

    if (Date.parse(rotatedAt) < Date.parse(current.csrf_rotated_at)) {
      throw new HostDeckAuthRepositoryError(
        "csrf_rotation_conflict",
        "CSRF bootstrap rotation time cannot move backward."
      );
    }

    if (current.csrf_generation >= Number.MAX_SAFE_INTEGER) {
      throw new HostDeckAuthRepositoryError(
        "csrf_generation_exhausted",
        "CSRF bootstrap generation is exhausted."
      );
    }

    const rawCsrfToken = generateCsrfTokenSafely(generateCsrfToken);
    const csrfTokenHash = hashCsrfToken(rawCsrfToken);
    const duplicate = db
      .prepare("SELECT id FROM auth_devices WHERE csrf_token_hash = ? LIMIT 1")
      .get(csrfTokenHash) as { readonly id: string } | undefined;

    if (duplicate !== undefined) {
      throw new HostDeckAuthRepositoryError("duplicate_secret", "Generated CSRF token already exists.");
    }

    const csrfGeneration = current.csrf_generation + 1;
    const update = db
      .prepare(
        `
          UPDATE auth_devices
          SET csrf_token_hash = ?, csrf_generation = ?, csrf_rotated_at = ?
          WHERE id = ? AND csrf_generation = ?
        `
      )
      .run(csrfTokenHash, csrfGeneration, rotatedAt, current.id, current.csrf_generation);

    if (update.changes !== 1) {
      throw new HostDeckAuthRepositoryError(
        "csrf_rotation_conflict",
        "CSRF bootstrap state changed before rotation committed."
      );
    }

    return Object.freeze({
      deviceId: current.id,
      rawCsrfToken,
      csrfGeneration,
      rotatedAt
    });
  }).immediate;
}

export function createPairingCodeRepository(db: Database.Database): PairingCodeRepository {
  return {
    get(pairingId) {
      const row = db.prepare("SELECT * FROM pairing_codes WHERE id = ?").get(pairingId) as PairingCodeRow | undefined;
      return row === undefined ? null : parsePairingCodeRow(row);
    },
    require(pairingId) {
      const pairingCode = this.get(pairingId);

      if (pairingCode === null) {
        throw new HostDeckAuthRepositoryError("pairing_code_not_found", `Pairing code ${pairingId} does not exist.`);
      }

      return pairingCode;
    },
    create(input) {
      const pairingCode = parsePairingCode({
        id: input.id,
        code_hash: hashPairingCode(input.rawCode),
        permission: input.permission,
        client_label: input.clientLabel ?? null,
        created_at: nowIso(input.createdAt),
        expires_at: nowIso(input.expiresAt),
        used_at: null,
        revoked_at: null
      });

      try {
        db.prepare(`
          INSERT INTO pairing_codes (
            id,
            code_hash,
            permission,
            client_label,
            created_at,
            expires_at,
            used_at,
            revoked_at
          ) VALUES (
            @id,
            @code_hash,
            @permission,
            @client_label,
            @created_at,
            @expires_at,
            @used_at,
            @revoked_at
          )
        `).run(pairingCodeToRow(pairingCode));
      } catch (error) {
        throw mapPairingConstraint(error);
      }

      return pairingCode;
    },
    claim(input) {
      const claimPairing = db.transaction(() => {
        const pairingCode = requireClaimablePairingCode(db, input.rawCode, input.now);
        const device = insertAuthDevice(
          db,
          authDeviceFromInput({
            id: input.deviceId,
            rawDeviceToken: input.rawDeviceToken,
            rawCsrfToken: input.rawCsrfToken,
            permission: pairingCode.permission,
            clientLabel: input.clientLabel ?? pairingCode.client_label,
            createdAt: input.now,
            expiresAt: input.deviceExpiresAt ?? null
          })
        );

        db.prepare("UPDATE pairing_codes SET used_at = ? WHERE id = ?").run(nowIso(input.now), pairingCode.id);

        return {
          pairingCode: parsePairingCode({
            ...pairingCode,
            used_at: nowIso(input.now)
          }),
          device
        };
      });

      return claimPairing();
    },
    revoke(pairingId, input) {
      const current = this.require(pairingId);

      if (current.revoked_at !== null) {
        return current;
      }

      db.prepare("UPDATE pairing_codes SET revoked_at = ? WHERE id = ?").run(nowIso(input.now), pairingId);
      return this.require(pairingId);
    }
  };
}

function authDeviceFromInput(input: CreateAuthDeviceInput): AuthDeviceRecord {
  const createdAt = nowIso(input.createdAt);

  return parseAuthDevice({
    id: input.id,
    token_hash: hashDeviceToken(input.rawDeviceToken),
    csrf_token_hash: hashCsrfToken(input.rawCsrfToken),
    csrf_generation: 1,
    csrf_rotated_at: createdAt,
    client_label: input.clientLabel ?? null,
    permission: input.permission,
    created_at: createdAt,
    last_used_at: null,
    expires_at: input.expiresAt === null || input.expiresAt === undefined ? null : nowIso(input.expiresAt),
    revoked_at: null
  });
}

function insertAuthDevice(db: Database.Database, device: AuthDeviceRecord): AuthDeviceRecord {
  try {
    db.prepare(`
      INSERT INTO auth_devices (
        id,
        token_hash,
        csrf_token_hash,
        csrf_generation,
        csrf_rotated_at,
        client_label,
        permission,
        created_at,
        last_used_at,
        expires_at,
        revoked_at
      ) VALUES (
        @id,
        @token_hash,
        @csrf_token_hash,
        @csrf_generation,
        @csrf_rotated_at,
        @client_label,
        @permission,
        @created_at,
        @last_used_at,
        @expires_at,
        @revoked_at
      )
    `).run(authDeviceToRow(device));
  } catch (error) {
    throw mapAuthDeviceConstraint(error);
  }

  return device;
}

function requireUsableDeviceByToken(db: Database.Database, rawDeviceToken: string, now: Date): AuthDeviceRecord {
  const row = db.prepare("SELECT * FROM auth_devices WHERE token_hash = ?").get(hashDeviceToken(rawDeviceToken)) as AuthDeviceRow | undefined;

  if (row === undefined) {
    throw new HostDeckAuthRepositoryError("device_not_found", "Auth device token is not recognized.");
  }

  const device = parseAuthDeviceRow(row);

  if (device.revoked_at !== null) {
    throw new HostDeckAuthRepositoryError("device_revoked", "Auth device token has been revoked.");
  }

  if (device.expires_at !== null && Date.parse(device.expires_at) <= now.getTime()) {
    throw new HostDeckAuthRepositoryError("device_expired", "Auth device token has expired.");
  }

  return device;
}

function requireClaimablePairingCode(db: Database.Database, rawCode: string, now: Date): PairingCodeRecord {
  const row = db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").get(hashPairingCode(rawCode)) as PairingCodeRow | undefined;

  if (row === undefined) {
    throw new HostDeckAuthRepositoryError("pairing_code_not_found", "Pairing code is not recognized.");
  }

  const pairingCode = parsePairingCodeRow(row);

  if (pairingCode.revoked_at !== null) {
    throw new HostDeckAuthRepositoryError("pairing_code_revoked", "Pairing code has been revoked.");
  }

  if (pairingCode.used_at !== null) {
    throw new HostDeckAuthRepositoryError("pairing_code_used", "Pairing code has already been used.");
  }

  if (Date.parse(pairingCode.expires_at) <= now.getTime()) {
    throw new HostDeckAuthRepositoryError("pairing_code_expired", "Pairing code has expired.");
  }

  return pairingCode;
}

function parseAuthDeviceRow(row: AuthDeviceRow): AuthDeviceRecord {
  return parseAuthDevice({
    id: row.id,
    token_hash: row.token_hash,
    csrf_token_hash: row.csrf_token_hash,
    csrf_generation: row.csrf_generation,
    csrf_rotated_at: row.csrf_rotated_at,
    client_label: row.client_label,
    permission: row.permission,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at
  });
}

function parsePairingCodeRow(row: PairingCodeRow): PairingCodeRecord {
  return parsePairingCode({
    id: row.id,
    code_hash: row.code_hash,
    permission: row.permission,
    client_label: row.client_label,
    created_at: row.created_at,
    expires_at: row.expires_at,
    used_at: row.used_at,
    revoked_at: row.revoked_at
  });
}

function parseAuthDevice(candidate: unknown): AuthDeviceRecord {
  const result = authDeviceRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckAuthRepositoryError("invalid_auth_device", "Auth device record is invalid.", { cause: result.error });
  }

  return result.data;
}

function parsePairingCode(candidate: unknown): PairingCodeRecord {
  const result = pairingCodeRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckAuthRepositoryError("invalid_pairing_code", "Pairing code record is invalid.", { cause: result.error });
  }

  return result.data;
}

function authDeviceToRow(device: AuthDeviceRecord): AuthDeviceRow {
  return {
    id: device.id,
    token_hash: device.token_hash,
    csrf_token_hash: device.csrf_token_hash,
    csrf_generation: device.csrf_generation,
    csrf_rotated_at: device.csrf_rotated_at,
    client_label: device.client_label,
    permission: device.permission,
    created_at: device.created_at,
    last_used_at: device.last_used_at,
    expires_at: device.expires_at,
    revoked_at: device.revoked_at
  };
}

function pairingCodeToRow(pairingCode: PairingCodeRecord): PairingCodeRow {
  return {
    id: pairingCode.id,
    code_hash: pairingCode.code_hash,
    permission: pairingCode.permission,
    client_label: pairingCode.client_label,
    created_at: pairingCode.created_at,
    expires_at: pairingCode.expires_at,
    used_at: pairingCode.used_at,
    revoked_at: pairingCode.revoked_at
  };
}

function mapAuthDeviceConstraint(error: unknown): HostDeckAuthRepositoryError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("auth_devices.token_hash")) {
    return new HostDeckAuthRepositoryError("duplicate_secret", "Auth device token already exists.", { cause: error });
  }

  if (message.includes("auth_devices.id")) {
    return new HostDeckAuthRepositoryError("device_exists", "Auth device id already exists.", { cause: error });
  }

  return new HostDeckAuthRepositoryError("invalid_auth_device", "Auth device record violates SQLite constraints.", { cause: error });
}

function mapPairingConstraint(error: unknown): HostDeckAuthRepositoryError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("pairing_codes.id") || message.includes("pairing_codes.code_hash")) {
    return new HostDeckAuthRepositoryError("pairing_code_exists", "Pairing code already exists.", { cause: error });
  }

  return new HostDeckAuthRepositoryError("invalid_pairing_code", "Pairing code record violates SQLite constraints.", { cause: error });
}

function defaultCsrfTokenGenerator(): string {
  return randomBytes(csrfTokenBytes).toString("base64url");
}

function generateCsrfTokenSafely(generateCsrfToken: () => string): string {
  try {
    return generateCsrfToken();
  } catch {
    throw new HostDeckAuthRepositoryError("csrf_rotation_failed", "CSRF token generation failed.");
  }
}

export function hashSecret(secret: string, options: HashSecretOptions = {}): string {
  assertRawSecret(secret, options);
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function hashMatches(expectedHash: string, secret: string): boolean {
  const actualHash = hashCsrfToken(secret);
  const expected = Buffer.from(expectedHash);
  const actual = Buffer.from(actualHash);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashPairingCode(rawCode: string): string {
  return hashSecret(rawCode, {
    label: "Pairing code",
    minLength: pairingCodeMinLength
  });
}

function hashDeviceToken(rawDeviceToken: string): string {
  return hashSecret(rawDeviceToken, {
    label: "Device token",
    minLength: deviceSecretMinLength
  });
}

function hashCsrfToken(rawCsrfToken: string): string {
  return hashSecret(rawCsrfToken, {
    label: "CSRF token",
    minLength: deviceSecretMinLength
  });
}

function assertRawSecret(secret: string, options: HashSecretOptions): void {
  const label = options.label ?? "Secret";
  const minLength = options.minLength ?? pairingCodeMinLength;

  if (typeof secret !== "string" || secret.length < minLength || secret.length > rawSecretMaxLength || /\s/u.test(secret)) {
    throw new HostDeckAuthRepositoryError(
      "invalid_secret",
      `${label} must be ${minLength} to ${rawSecretMaxLength} non-whitespace characters.`
    );
  }
}

function nowIso(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new HostDeckAuthRepositoryError("invalid_time", "Auth repository time must be a valid Date.");
  }

  return now.toISOString();
}
