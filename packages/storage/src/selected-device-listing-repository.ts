import {
  type AuthDeviceRecord,
  authDeviceRecordSchema,
  type SelectedDeviceListInput,
  type SelectedDeviceListItem,
  type SelectedDeviceListPage,
  selectedDeviceListInputSchema,
  selectedDeviceListItemSchema,
  selectedDeviceListPageSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import {
  type AuthRepositoryErrorCode,
  HostDeckAuthRepositoryError
} from "./auth-repository.js";

export interface DeviceListingRepository {
  readonly list: (input: SelectedDeviceListInput) => SelectedDeviceListPage;
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

export function createDeviceListingRepository(db: Database.Database): DeviceListingRepository {
  return {
    list(input) {
      try {
        const parsedInput = prepareListInput(input);
        const fetchLimit = parsedInput.limit + 1;
        const rows = parsedInput.afterDeviceId === null
          ? (db
              .prepare("SELECT * FROM auth_devices ORDER BY id ASC LIMIT ?")
              .all(fetchLimit) as AuthDeviceRow[])
          : (db
              .prepare("SELECT * FROM auth_devices WHERE id > ? ORDER BY id ASC LIMIT ?")
              .all(parsedInput.afterDeviceId, fetchLimit) as AuthDeviceRow[]);
        const fetchedItems = rows.map(parseListItem);
        const devices = fetchedItems.slice(0, parsedInput.limit);
        const hasMore = fetchedItems.length > parsedInput.limit;
        const nextAfterDeviceId = hasMore ? devices.at(-1)?.deviceId ?? null : null;
        return freezePage({ devices, nextAfterDeviceId, hasMore });
      } catch (error) {
        throw sanitizeListingError(error);
      }
    }
  };
}

function prepareListInput(input: unknown): SelectedDeviceListInput {
  const values = readExactInput(input);
  const parsed = selectedDeviceListInputSchema.safeParse(values);
  if (!parsed.success) throw selectedError("invalid_device_list", "Selected device-list input is invalid.");
  return parsed.data;
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
      keys.some((key) => typeof key !== "string" || (key !== "afterDeviceId" && key !== "limit")) ||
      !Object.hasOwn(descriptors, "afterDeviceId") ||
      !Object.hasOwn(descriptors, "limit")
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
    throw selectedError("invalid_device_list", "Selected device-list input is invalid.");
  }
}

function parseListItem(row: AuthDeviceRow): SelectedDeviceListItem {
  const parsed = authDeviceRecordSchema.safeParse(row);
  if (!parsed.success) throw selectedError("invalid_auth_device", "Stored auth-device state is invalid.");
  return projectListItem(parsed.data);
}

function projectListItem(record: AuthDeviceRecord): SelectedDeviceListItem {
  const parsed = selectedDeviceListItemSchema.safeParse({
    deviceId: record.id,
    clientLabel: record.client_label,
    permission: record.permission,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
    expiresAt: record.expires_at,
    revokedAt: record.revoked_at
  });
  if (!parsed.success) throw selectedError("invalid_auth_device", "Stored auth-device state is invalid.");
  return parsed.data;
}

function freezePage(candidate: unknown): SelectedDeviceListPage {
  const parsed = selectedDeviceListPageSchema.safeParse(candidate);
  if (!parsed.success) throw selectedError("device_list_failed", "Selected device-list result is invalid.");
  const devices = parsed.data.devices.map((device) => Object.freeze({ ...device }));
  Object.freeze(devices);
  return Object.freeze({ ...parsed.data, devices });
}

function selectedError(code: AuthRepositoryErrorCode, message: string): HostDeckAuthRepositoryError {
  return new HostDeckAuthRepositoryError(code, message);
}

function sanitizeListingError(error: unknown): HostDeckAuthRepositoryError {
  if (error instanceof HostDeckAuthRepositoryError) {
    const messages: Partial<Record<AuthRepositoryErrorCode, string>> = {
      device_list_failed: "Device listing failed.",
      invalid_auth_device: "Stored auth-device state is invalid.",
      invalid_device_list: "Selected device-list input is invalid."
    };
    const message = messages[error.code];
    if (message !== undefined) return selectedError(error.code, message);
  }
  return selectedError("device_list_failed", "Device listing failed.");
}
