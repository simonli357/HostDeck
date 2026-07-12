import {
  type AuthDeviceRecord,
  authDeviceRecordSchema,
  type SelectedDeviceRevocationResult,
  selectedDeviceIdSchema,
  selectedDeviceRevocationResultSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import {
  type AuthRepositoryErrorCode,
  HostDeckAuthRepositoryError
} from "./auth-repository.js";

export interface RevokeSelectedDeviceInput {
  readonly deviceId: string;
  readonly now: Date;
}

export interface DeviceRevocationRepository {
  readonly revoke: (input: RevokeSelectedDeviceInput) => SelectedDeviceRevocationResult;
}

interface AuthDeviceRow {
  readonly id: unknown;
  readonly token_hash: unknown;
  readonly csrf_token_hash: unknown;
  readonly csrf_generation: unknown;
  readonly csrf_rotated_at: unknown;
  readonly client_label: unknown;
  readonly permission: unknown;
  readonly created_at: unknown;
  readonly last_used_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
}

interface PreparedRevokeInput {
  readonly deviceId: string;
  readonly now: string;
  readonly nowMs: number;
}

interface StoredAuthDevice {
  readonly record: AuthDeviceRecord;
  readonly row: AuthDeviceRow;
}

export function createDeviceRevocationRepository(db: Database.Database): DeviceRevocationRepository {
  const revokeTransaction = db.transaction((input: PreparedRevokeInput): SelectedDeviceRevocationResult => {
    const storedCurrent = requireDevice(db, input.deviceId);
    const current = storedCurrent.record;
    assertNonRegressingRevocationTime(current, input.nowMs);
    if (current.revoked_at !== null) {
      return revocationResult(current.id, current.revoked_at, true);
    }

    const update = db
      .prepare(
        `
          UPDATE auth_devices
          SET revoked_at = @revoked_at
          WHERE id = @id
            AND token_hash = @token_hash
            AND csrf_token_hash = @csrf_token_hash
            AND csrf_generation = @csrf_generation
            AND csrf_rotated_at = @csrf_rotated_at
            AND client_label IS @client_label
            AND permission = @permission
            AND created_at = @created_at
            AND last_used_at IS @last_used_at
            AND expires_at IS @expires_at
            AND revoked_at IS NULL
        `
      )
      .run({ ...storedCurrent.row, revoked_at: input.now });
    if (update.changes !== 1) {
      throw selectedError("device_revoke_failed", "Device authority changed before revocation committed.");
    }
    const revoked = requireDevice(db, input.deviceId).record;
    if (revoked.revoked_at !== input.now || !sameAuthorityState(current, revoked)) {
      throw selectedError("device_revoke_failed", "Device revocation did not persist the selected time.");
    }
    return revocationResult(revoked.id, revoked.revoked_at, false);
  }).immediate;

  return {
    revoke(input) {
      try {
        return Object.freeze({ ...revokeTransaction(prepareRevokeInput(input)) });
      } catch (error) {
        throw sanitizeRevocationError(error);
      }
    }
  };
}

function sameAuthorityState(before: AuthDeviceRecord, after: AuthDeviceRecord): boolean {
  return (
    before.id === after.id &&
    before.token_hash === after.token_hash &&
    before.csrf_token_hash === after.csrf_token_hash &&
    before.csrf_generation === after.csrf_generation &&
    before.csrf_rotated_at === after.csrf_rotated_at &&
    before.client_label === after.client_label &&
    before.permission === after.permission &&
    before.created_at === after.created_at &&
    before.last_used_at === after.last_used_at &&
    before.expires_at === after.expires_at
  );
}

function prepareRevokeInput(input: unknown): PreparedRevokeInput {
  const values = readExactInput(input);
  const deviceId = selectedDeviceIdSchema.safeParse(values.deviceId);
  if (!deviceId.success) throw selectedError("invalid_device_revoke", "Selected device id is invalid.");
  if (!(values.now instanceof Date)) {
    throw selectedError("invalid_time", "Device revocation time is invalid.");
  }
  const nowMs = Date.prototype.getTime.call(values.now);
  if (!Number.isFinite(nowMs)) throw selectedError("invalid_time", "Device revocation time is invalid.");
  return { deviceId: deviceId.data, now: new Date(nowMs).toISOString(), nowMs };
}

function readExactInput(input: unknown): Readonly<Record<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError();
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 2 ||
      keys.some((key) => typeof key !== "string" || (key !== "deviceId" && key !== "now")) ||
      !Object.hasOwn(descriptors, "deviceId") ||
      !Object.hasOwn(descriptors, "now")
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
    throw selectedError("invalid_device_revoke", "Selected device revocation input is invalid.");
  }
}

function requireDevice(db: Database.Database, deviceId: string): StoredAuthDevice {
  const row = db.prepare("SELECT * FROM auth_devices WHERE id = ?").get(deviceId) as AuthDeviceRow | undefined;
  if (row === undefined) throw selectedError("device_not_found", "Auth device does not exist.");
  const parsed = authDeviceRecordSchema.safeParse(row);
  if (!parsed.success) throw selectedError("invalid_auth_device", "Stored auth-device state is invalid.");
  return { record: parsed.data, row };
}

function assertNonRegressingRevocationTime(device: AuthDeviceRecord, nowMs: number): void {
  const minimum = Math.max(
    Date.parse(device.created_at),
    Date.parse(device.csrf_rotated_at),
    device.last_used_at === null ? Number.NEGATIVE_INFINITY : Date.parse(device.last_used_at),
    device.revoked_at === null ? Number.NEGATIVE_INFINITY : Date.parse(device.revoked_at)
  );
  if (nowMs < minimum) {
    throw selectedError("device_revoke_time_conflict", "Device revocation time regressed behind durable authority.");
  }
}

function revocationResult(
  deviceId: string,
  revokedAt: string,
  previouslyRevoked: boolean
): SelectedDeviceRevocationResult {
  const parsed = selectedDeviceRevocationResultSchema.safeParse({
    deviceId,
    revokedAt,
    previouslyRevoked,
    authorityInvalidated: true
  });
  if (!parsed.success) throw selectedError("device_revoke_failed", "Device revocation result is invalid.");
  return parsed.data;
}

function selectedError(code: AuthRepositoryErrorCode, message: string): HostDeckAuthRepositoryError {
  return new HostDeckAuthRepositoryError(code, message);
}

function sanitizeRevocationError(error: unknown): HostDeckAuthRepositoryError {
  if (error instanceof HostDeckAuthRepositoryError) {
    const messages: Partial<Record<AuthRepositoryErrorCode, string>> = {
      device_not_found: "Auth device does not exist.",
      device_revoke_failed: "Device revocation failed.",
      device_revoke_time_conflict: "Device revocation time conflicts with durable authority.",
      invalid_auth_device: "Stored auth-device state is invalid.",
      invalid_device_revoke: "Selected device revocation input is invalid.",
      invalid_time: "Device revocation time is invalid."
    };
    const message = messages[error.code];
    if (message !== undefined) return selectedError(error.code, message);
  }
  return selectedError("device_revoke_failed", "Device revocation failed.");
}
