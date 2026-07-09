import { createHash, timingSafeEqual } from "node:crypto";
import { type AuthDeviceRecord, authDeviceRecordSchema, type PairingCodeRecord, pairingCodeRecordSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type AuthRepositoryErrorCode =
  | "csrf_mismatch"
  | "device_exists"
  | "device_expired"
  | "device_not_found"
  | "device_revoked"
  | "duplicate_secret"
  | "invalid_auth_device"
  | "invalid_pairing_code"
  | "pairing_code_exists"
  | "pairing_code_expired"
  | "pairing_code_not_found"
  | "pairing_code_used"
  | "read_only";

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
  readonly deviceExpiresAt?: Date | null;
}

export interface AuthenticateDeviceInput {
  readonly rawDeviceToken: string;
  readonly now: Date;
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
  readonly authorizeBrowserWrite: (input: AuthorizeBrowserWriteInput) => AuthDeviceRecord;
  readonly revoke: (deviceId: string, input: { readonly now: Date }) => AuthDeviceRecord;
}

export interface PairingCodeRepository {
  readonly get: (pairingId: string) => PairingCodeRecord | null;
  readonly require: (pairingId: string) => PairingCodeRecord;
  readonly create: (input: CreatePairingCodeInput) => PairingCodeRecord;
  readonly claim: (input: ClaimPairingCodeInput) => PairingClaim;
}

interface AuthDeviceRow {
  readonly id: string;
  readonly token_hash: string;
  readonly csrf_token_hash: string;
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
}

export function createAuthDeviceRepository(db: Database.Database): AuthDeviceRepository {
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
      const device = requireUsableDeviceByToken(db, input.rawDeviceToken, input.now);
      const touched = touchDevice(db, device.id, input.now);

      return {
        trusted: true,
        readOnly: touched.permission === "read",
        device: touched
      };
    },
    authorizeBrowserWrite(input) {
      const device = requireUsableDeviceByToken(db, input.rawDeviceToken, input.now);

      if (device.permission === "read") {
        throw new HostDeckAuthRepositoryError("read_only", "Read-only auth devices cannot write.");
      }

      if (!hashMatches(device.csrf_token_hash, input.rawCsrfToken)) {
        throw new HostDeckAuthRepositoryError("csrf_mismatch", "Browser write rejected because the CSRF token does not match.");
      }

      return touchDevice(db, device.id, input.now);
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
        code_hash: hashSecret(input.rawCode),
        permission: input.permission,
        client_label: input.clientLabel ?? null,
        created_at: nowIso(input.createdAt),
        expires_at: nowIso(input.expiresAt),
        used_at: null
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
            used_at
          ) VALUES (
            @id,
            @code_hash,
            @permission,
            @client_label,
            @created_at,
            @expires_at,
            @used_at
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
            clientLabel: pairingCode.client_label,
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
    }
  };
}

function authDeviceFromInput(input: CreateAuthDeviceInput): AuthDeviceRecord {
  return parseAuthDevice({
    id: input.id,
    token_hash: hashSecret(input.rawDeviceToken),
    csrf_token_hash: hashSecret(input.rawCsrfToken),
    client_label: input.clientLabel ?? null,
    permission: input.permission,
    created_at: nowIso(input.createdAt),
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
  const row = db.prepare("SELECT * FROM auth_devices WHERE token_hash = ?").get(hashSecret(rawDeviceToken)) as AuthDeviceRow | undefined;

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
  const row = db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").get(hashSecret(rawCode)) as PairingCodeRow | undefined;

  if (row === undefined) {
    throw new HostDeckAuthRepositoryError("pairing_code_not_found", "Pairing code is not recognized.");
  }

  const pairingCode = parsePairingCodeRow(row);

  if (pairingCode.used_at !== null) {
    throw new HostDeckAuthRepositoryError("pairing_code_used", "Pairing code has already been used.");
  }

  if (Date.parse(pairingCode.expires_at) <= now.getTime()) {
    throw new HostDeckAuthRepositoryError("pairing_code_expired", "Pairing code has expired.");
  }

  return pairingCode;
}

function touchDevice(db: Database.Database, deviceId: string, now: Date): AuthDeviceRecord {
  db.prepare("UPDATE auth_devices SET last_used_at = ? WHERE id = ?").run(nowIso(now), deviceId);
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(deviceId) as AuthDeviceRow | undefined;

  if (row === undefined) {
    throw new HostDeckAuthRepositoryError("device_not_found", `Auth device ${deviceId} does not exist.`);
  }

  return parseAuthDeviceRow(row);
}

function parseAuthDeviceRow(row: AuthDeviceRow): AuthDeviceRecord {
  return parseAuthDevice({
    id: row.id,
    token_hash: row.token_hash,
    csrf_token_hash: row.csrf_token_hash,
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
    used_at: row.used_at
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
    used_at: pairingCode.used_at
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

export function hashSecret(secret: string): string {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function hashMatches(expectedHash: string, secret: string): boolean {
  const actualHash = hashSecret(secret);
  const expected = Buffer.from(expectedHash);
  const actual = Buffer.from(actualHash);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function nowIso(now: Date): string {
  return now.toISOString();
}
