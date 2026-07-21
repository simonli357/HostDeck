import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type AuthDeviceRecord,
  authDeviceRecordSchema,
  positiveSafeIntegerSchema,
  selectedDeviceIdSchema,
  selectedRawCsrfTokenSchema
} from "@hostdeck/contracts";
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
  | "device_list_failed"
  | "device_not_found"
  | "device_revoke_failed"
  | "device_revoke_time_conflict"
  | "device_revoked"
  | "duplicate_secret"
  | "invalid_auth_device"
  | "invalid_csrf_authorization"
  | "invalid_device_list"
  | "invalid_device_revoke"
  | "invalid_secret"
  | "invalid_time"
  | "invalid_pairing_code"
  | "pairing_code_exists"
  | "pairing_code_expired"
  | "pairing_code_legacy"
  | "pairing_code_not_found"
  | "pairing_code_revoked"
  | "pairing_code_used"
  | "pairing_claim_capacity"
  | "pairing_claim_failed"
  | "pairing_claim_rate_limited"
  | "pairing_claim_time_conflict"
  | "pairing_issue_failed"
  | "invalid_pairing_policy"
  | "invalid_pairing_rate_state"
  | "invalid_pairing_source"
  | "read_only";

export interface HashSecretOptions {
  readonly label?: string;
  readonly minLength?: number;
}

export class HostDeckAuthRepositoryError extends Error {
  constructor(
    readonly code: AuthRepositoryErrorCode,
    message: string,
    options?: ErrorOptions & { readonly retryAt?: string }
  ) {
    super(message, options);
    this.name = "HostDeckAuthRepositoryError";
    this.retryAt = options?.retryAt;
  }

  readonly retryAt: string | undefined;
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

export interface AuthenticateDeviceInput {
  readonly rawDeviceToken: string;
  readonly now: Date;
}

export interface CsrfBootstrapRotation {
  readonly deviceId: string;
  readonly rawCsrfToken: string;
  readonly csrfGeneration: number;
  readonly rotatedAt: string;
}

export interface SelectedCsrfAuthorizationRepositoryOptions {
  readonly generateCsrfToken?: () => string;
}

export interface RotateSelectedCsrfBootstrapInput {
  readonly deviceId: string;
  readonly expectedCsrfGeneration: number;
  readonly now: Date;
}

export interface AuthorizeSelectedBrowserWriteInput
  extends RotateSelectedCsrfBootstrapInput {
  readonly rawCsrfToken: string;
}

export interface SelectedCsrfAuthorizationRepository {
  readonly rotateBootstrap: (
    input: RotateSelectedCsrfBootstrapInput
  ) => CsrfBootstrapRotation;
  readonly authorizeBrowserWrite: (
    input: AuthorizeSelectedBrowserWriteInput
  ) => AuthDeviceAuthentication;
}

export interface AuthDeviceAuthentication {
  readonly trusted: true;
  readonly readOnly: boolean;
  readonly device: AuthDeviceRecord;
}

export interface AuthDeviceRepository {
  readonly get: (deviceId: string) => AuthDeviceRecord | null;
  readonly require: (deviceId: string) => AuthDeviceRecord;
  readonly create: (input: CreateAuthDeviceInput) => AuthDeviceRecord;
  readonly authenticateDeviceToken: (input: AuthenticateDeviceInput) => AuthDeviceAuthentication;
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

interface PreparedSelectedCsrfAuthority {
  readonly deviceId: string;
  readonly expectedCsrfGeneration: number;
  readonly now: string;
  readonly nowMs: number;
}

interface PreparedSelectedBrowserWrite extends PreparedSelectedCsrfAuthority {
  readonly rawCsrfToken: string;
}

const defaultSecretMinLength = 6;
const deviceSecretMinLength = 24;
const rawSecretMaxLength = 512;
const csrfTokenBytes = 32;

export function createAuthDeviceRepository(
  db: Database.Database
): AuthDeviceRepository {
  const authenticateDeviceToken = createDeviceAuthenticationTransaction(db);

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
    }
  };
}

export function createSelectedCsrfAuthorizationRepository(
  db: Database.Database,
  options: SelectedCsrfAuthorizationRepositoryOptions = {}
): SelectedCsrfAuthorizationRepository {
  const generateCsrfToken = readSelectedCsrfRepositoryOptions(options);
  const rotate = createSelectedCsrfRotationTransaction(db, generateCsrfToken);
  const authorize = createSelectedBrowserWriteTransaction(db);

  return Object.freeze({
    rotateBootstrap(input: RotateSelectedCsrfBootstrapInput) {
      try {
        return rotate(prepareSelectedCsrfAuthority(input));
      } catch (error) {
        if (error instanceof HostDeckAuthRepositoryError) throw error;
        throw new HostDeckAuthRepositoryError(
          "csrf_rotation_failed",
          "Selected CSRF bootstrap rotation failed."
        );
      }
    },
    authorizeBrowserWrite(input: AuthorizeSelectedBrowserWriteInput) {
      try {
        const device = authorize(prepareSelectedBrowserWrite(input));
        const frozenDevice = Object.freeze({ ...device });
        return Object.freeze({
          trusted: true,
          readOnly: false,
          device: frozenDevice
        });
      } catch (error) {
        if (error instanceof HostDeckAuthRepositoryError) throw error;
        throw new HostDeckAuthRepositoryError(
          "authentication_failed",
          "Selected browser-write authorization failed."
        );
      }
    }
  });
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

function createSelectedCsrfRotationTransaction(
  db: Database.Database,
  generateCsrfToken: () => string
): (input: PreparedSelectedCsrfAuthority) => CsrfBootstrapRotation {
  return db.transaction(
    (input: PreparedSelectedCsrfAuthority): CsrfBootstrapRotation => {
      const current = requireUsableDeviceById(db, input.deviceId, input.nowMs);
      if (current.csrf_generation !== input.expectedCsrfGeneration) {
        throw new HostDeckAuthRepositoryError(
          "csrf_rotation_conflict",
          "CSRF bootstrap authority changed before rotation."
        );
      }
      return rotateCurrentCsrf(db, current, input.now, generateCsrfToken);
    }
  ).immediate;
}

function createSelectedBrowserWriteTransaction(
  db: Database.Database
): (input: PreparedSelectedBrowserWrite) => AuthDeviceRecord {
  return db.transaction((input: PreparedSelectedBrowserWrite): AuthDeviceRecord => {
    const current = requireUsableDeviceById(db, input.deviceId, input.nowMs);

    if (current.permission === "read") {
      throw new HostDeckAuthRepositoryError(
        "read_only",
        "Read-only auth devices cannot write."
      );
    }
    if (
      current.csrf_generation !== input.expectedCsrfGeneration ||
      !hashMatches(current.csrf_token_hash, input.rawCsrfToken)
    ) {
      throw new HostDeckAuthRepositoryError(
        "csrf_mismatch",
        "Selected browser-write CSRF authority does not match."
      );
    }

    return advanceLastUsedAt(db, current, input.now);
  }).immediate;
}

function rotateCurrentCsrf(
  db: Database.Database,
  current: AuthDeviceRecord,
  rotatedAt: string,
  generateCsrfToken: () => string
): CsrfBootstrapRotation {

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

function requireUsableDeviceById(
  db: Database.Database,
  deviceId: string,
  nowMs: number
): AuthDeviceRecord {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(deviceId) as
    | AuthDeviceRow
    | undefined;
  if (row === undefined) {
    throw new HostDeckAuthRepositoryError(
      "device_not_found",
      "Authenticated device does not exist."
    );
  }
  const device = parseAuthDeviceRow(row);
  if (device.revoked_at !== null) {
    throw new HostDeckAuthRepositoryError(
      "device_revoked",
      "Authenticated device has been revoked."
    );
  }
  if (device.expires_at !== null && Date.parse(device.expires_at) <= nowMs) {
    throw new HostDeckAuthRepositoryError(
      "device_expired",
      "Authenticated device has expired."
    );
  }
  return device;
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

function parseAuthDevice(candidate: unknown): AuthDeviceRecord {
  const result = authDeviceRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckAuthRepositoryError("invalid_auth_device", "Auth device record is invalid.", { cause: result.error });
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

function readSelectedCsrfRepositoryOptions(
  options: unknown
): () => string {
  const values = readExactDataObject(
    options,
    ["generateCsrfToken"],
    true
  );
  const generator = values.generateCsrfToken;
  if (generator !== undefined && typeof generator !== "function") {
    throw invalidSelectedCsrfInput();
  }
  const selectedGenerator =
    (generator as (() => string) | undefined) ?? defaultCsrfTokenGenerator;
  return () => {
    const generated = generateCsrfTokenSafely(selectedGenerator);
    const parsed = selectedRawCsrfTokenSchema.safeParse(generated);
    if (!parsed.success) {
      throw new HostDeckAuthRepositoryError(
        "csrf_rotation_failed",
        "Selected CSRF token generation failed."
      );
    }
    return parsed.data;
  };
}

function prepareSelectedCsrfAuthority(
  input: unknown
): PreparedSelectedCsrfAuthority {
  const values = readExactDataObject(
    input,
    ["deviceId", "expectedCsrfGeneration", "now"],
    false
  );
  return prepareSelectedCsrfAuthorityValues(values);
}

function prepareSelectedBrowserWrite(
  input: unknown
): PreparedSelectedBrowserWrite {
  const values = readExactDataObject(
    input,
    ["deviceId", "expectedCsrfGeneration", "now", "rawCsrfToken"],
    false
  );
  const authority = prepareSelectedCsrfAuthorityValues(values);
  const rawCsrfToken = selectedRawCsrfTokenSchema.safeParse(values.rawCsrfToken);
  if (!rawCsrfToken.success) throw invalidSelectedCsrfInput();
  return Object.freeze({ ...authority, rawCsrfToken: rawCsrfToken.data });
}

function prepareSelectedCsrfAuthorityValues(
  values: Readonly<Record<string, unknown>>
): PreparedSelectedCsrfAuthority {
  const deviceId = selectedDeviceIdSchema.safeParse(values.deviceId);
  const generation = positiveSafeIntegerSchema.safeParse(
    values.expectedCsrfGeneration
  );
  if (!deviceId.success || !generation.success || !(values.now instanceof Date)) {
    throw invalidSelectedCsrfInput();
  }
  let nowMs: number;
  try {
    nowMs = Date.prototype.getTime.call(values.now);
  } catch {
    throw invalidSelectedCsrfInput();
  }
  if (!Number.isFinite(nowMs)) throw invalidSelectedCsrfInput();
  return Object.freeze({
    deviceId: deviceId.data,
    expectedCsrfGeneration: generation.data,
    now: new Date(nowMs).toISOString(),
    nowMs
  });
}

function readExactDataObject(
  candidate: unknown,
  expectedKeys: readonly string[],
  optionalKeys: boolean
): Readonly<Record<string, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
      (!optionalKeys && keys.length !== expectedKeys.length) ||
      (optionalKeys && keys.length > expectedKeys.length)
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        if (optionalKeys) {
          values[key] = undefined;
          continue;
        }
        throw new TypeError();
      }
      if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError();
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    throw invalidSelectedCsrfInput();
  }
}

function invalidSelectedCsrfInput(): HostDeckAuthRepositoryError {
  return new HostDeckAuthRepositoryError(
    "invalid_csrf_authorization",
    "Selected CSRF authorization input is invalid."
  );
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
  const minLength = options.minLength ?? defaultSecretMinLength;

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
