import {
  decodeSelectedDeviceListCursor,
  encodeSelectedDeviceListCursor,
  type SelectedDeviceListPage,
  type SelectedDeviceListResponse,
  selectedDeviceListCursorSchema,
  selectedDeviceListDefaultPageSize,
  selectedDeviceListMaxPageSize,
  selectedDeviceListPageSchema,
  selectedDeviceListResponseSchema
} from "@hostdeck/contracts";
import {
  createDeviceListingRepository,
  HostDeckAuthRepositoryError,
  HostDeckLocalPathError,
  HostDeckMigrationError,
  openExistingHostDeckReadOnlyDatabase
} from "@hostdeck/storage";
import {
  CliFailure,
  clientOperationFailure,
  configFailure,
  internalFailure
} from "./errors.js";

export interface HostDeckLocalDeviceListInput {
  readonly limit: number | null;
  readonly cursor: string | null;
}

export interface HostDeckLocalDeviceList {
  readonly list: (
    input: HostDeckLocalDeviceListInput
  ) => SelectedDeviceListResponse;
}

export interface CreateHostDeckLocalDeviceListOptions {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly openDatabase?: typeof openExistingHostDeckReadOnlyDatabase;
}

const optionKeys = ["stateDir", "databasePath", "openDatabase"] as const;
const inputKeys = ["limit", "cursor"] as const;

export function createHostDeckLocalDeviceList(
  input: CreateHostDeckLocalDeviceListOptions
): HostDeckLocalDeviceList {
  const options = readExactDataObject(
    input,
    optionKeys,
    "HostDeck local device-list options are invalid.",
    false
  );
  if (
    typeof options.stateDir !== "string" ||
    typeof options.databasePath !== "string" ||
    (options.openDatabase !== undefined &&
      typeof options.openDatabase !== "function")
  ) {
    throw new TypeError("HostDeck local device-list options are invalid.");
  }
  const stateDir = options.stateDir;
  const databasePath = options.databasePath;
  const openDatabase =
    (options.openDatabase as
      | typeof openExistingHostDeckReadOnlyDatabase
      | undefined) ?? openExistingHostDeckReadOnlyDatabase;

  return Object.freeze({
    list(input: HostDeckLocalDeviceListInput) {
      const request = parseListInput(input);
      return listDevices(
        stateDir,
        databasePath,
        openDatabase,
        request
      );
    }
  });
}

function listDevices(
  stateDir: string,
  databasePath: string,
  openDatabase: typeof openExistingHostDeckReadOnlyDatabase,
  request: HostDeckLocalDeviceListInput
): SelectedDeviceListResponse {
  let opened: ReturnType<typeof openExistingHostDeckReadOnlyDatabase> | null =
    null;
  let result: SelectedDeviceListResponse | null = null;
  let operationError: unknown;
  try {
    opened = Reflect.apply(openDatabase, undefined, [
      Object.freeze({
        state_dir: stateDir,
        database_path: databasePath
      })
    ]);
    const repository = createDeviceListingRepository(opened.db);
    const page = parsePage(
      Reflect.apply(repository.list, undefined, [
        Object.freeze({
          limit: request.limit ?? selectedDeviceListDefaultPageSize,
          afterDeviceId:
            request.cursor === null
              ? null
              : decodeSelectedDeviceListCursor(request.cursor)
        })
      ]),
      request
    );
    opened.verifyPath();
    result = prepareResponse(page);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    opened?.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined || closeError !== undefined) {
    throw mapLocalDeviceListFailure(operationError, closeError);
  }
  if (result === null) {
    throw internalFailure("HostDeck local device listing returned no result.");
  }
  return result;
}

function parseListInput(candidate: unknown): HostDeckLocalDeviceListInput {
  let values: Readonly<Record<(typeof inputKeys)[number], unknown>>;
  try {
    values = readExactDataObject(
      candidate,
      inputKeys,
      "HostDeck local device-list input is invalid."
    );
  } catch {
    throw internalFailure("HostDeck local device-list input is invalid.");
  }
  const limit = values.limit;
  const cursor = values.cursor;
  let cursorValid = cursor === null;
  if (cursor !== null) {
    try {
      cursorValid = selectedDeviceListCursorSchema.safeParse(cursor).success;
    } catch {
      cursorValid = false;
    }
  }
  if (
    (limit !== null &&
      (typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > selectedDeviceListMaxPageSize)) ||
    !cursorValid
  ) {
    throw internalFailure("HostDeck local device-list input is invalid.");
  }
  return Object.freeze({ limit, cursor }) as HostDeckLocalDeviceListInput;
}

function parsePage(
  candidate: unknown,
  request: HostDeckLocalDeviceListInput
): SelectedDeviceListPage {
  let parsed: ReturnType<typeof selectedDeviceListPageSchema.safeParse>;
  try {
    parsed = selectedDeviceListPageSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck device repository returned invalid data.");
  }
  if (!parsed.success) {
    throw internalFailure("HostDeck device repository returned invalid data.");
  }
  const limit = request.limit ?? selectedDeviceListDefaultPageSize;
  let afterDeviceId: string | null = null;
  try {
    afterDeviceId =
      request.cursor === null
        ? null
        : decodeSelectedDeviceListCursor(request.cursor);
  } catch {
    throw internalFailure("HostDeck device repository returned invalid data.");
  }
  if (
    parsed.data.devices.length > limit ||
    (parsed.data.hasMore && parsed.data.devices.length !== limit) ||
    (afterDeviceId !== null &&
      parsed.data.devices.some((device) => device.deviceId <= afterDeviceId))
  ) {
    throw internalFailure("HostDeck device repository returned invalid data.");
  }
  return parsed.data;
}

function prepareResponse(
  page: SelectedDeviceListPage
): SelectedDeviceListResponse {
  let parsed: ReturnType<typeof selectedDeviceListResponseSchema.safeParse>;
  try {
    parsed = selectedDeviceListResponseSchema.safeParse({
      devices: page.devices.map((device) => ({
        device_id: device.deviceId,
        client_label: device.clientLabel,
        permission: device.permission,
        created_at: device.createdAt,
        last_used_at: device.lastUsedAt,
        expires_at: device.expiresAt,
        revoked_at: device.revokedAt
      })),
      next_cursor:
        page.nextAfterDeviceId === null
          ? null
          : encodeSelectedDeviceListCursor(page.nextAfterDeviceId),
      has_more: page.hasMore
    });
  } catch {
    throw internalFailure("HostDeck device repository returned invalid data.");
  }
  if (!parsed.success) {
    throw internalFailure("HostDeck device repository returned invalid data.");
  }
  const devices = parsed.data.devices.map((device) =>
    Object.freeze({ ...device })
  );
  Object.freeze(devices);
  return Object.freeze({ ...parsed.data, devices });
}

function mapLocalDeviceListFailure(
  operationError: unknown,
  closeError: unknown
) {
  if (
    closeError === undefined &&
    isErrorInstance(operationError, CliFailure)
  ) {
    return operationError;
  }
  const errors = [operationError, closeError].filter(
    (error) => error !== undefined
  );
  if (
    errors.some(
      (error) =>
        containsError(error, HostDeckLocalPathError) ||
        containsError(error, HostDeckMigrationError)
    )
  ) {
    return configFailure(
      "HostDeck device database must already exist with secure paths and the current schema.",
      "database_path"
    );
  }
  if (
    errors.some((error) => containsError(error, HostDeckAuthRepositoryError))
  ) {
    return clientOperationFailure(
      "storage_error",
      "HostDeck device listing storage is unavailable."
    );
  }
  if (closeError !== undefined) {
    return internalFailure(
      "HostDeck device database could not be closed safely."
    );
  }
  return internalFailure("HostDeck local device listing failed.");
}

function containsError(
  candidate: unknown,
  errorType: abstract new (...args: never[]) => Error,
  seen = new Set<unknown>()
): boolean {
  if (isErrorInstance(candidate, errorType)) return true;
  if (!isAggregateError(candidate) || seen.has(candidate)) {
    return false;
  }
  seen.add(candidate);
  let errors: readonly unknown[];
  try {
    errors = Array.from(candidate.errors);
  } catch {
    return false;
  }
  return errors.some((error) => containsError(error, errorType, seen));
}

function isErrorInstance(
  candidate: unknown,
  errorType: abstract new (...args: never[]) => Error
): boolean {
  try {
    return candidate instanceof errorType;
  } catch {
    return false;
  }
}

function isAggregateError(candidate: unknown): candidate is AggregateError {
  try {
    return candidate instanceof AggregateError;
  } catch {
    return false;
  }
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string,
  requireEveryKey = true
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      (requireEveryKey
        ? keys.length !== expectedKeys.length
        : keys.length < 2 || keys.length > expectedKeys.length) ||
      keys.some(
        (key) =>
          typeof key !== "string" || !expectedKeys.includes(key as Key)
      )
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
        if (!requireEveryKey) continue;
        throw new TypeError();
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values) as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}
