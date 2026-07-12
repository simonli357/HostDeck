import {
  encodeSelectedDeviceListCursor,
  type SelectedDeviceListInput,
  type SelectedDeviceListPage,
  type SelectedDeviceListResponse,
  selectedDeviceListMaxPageSize,
  selectedDeviceListPageSchema,
  selectedDeviceListQuerySchema,
  selectedDeviceListResponseSchema
} from "@hostdeck/contracts";
import { HostDeckAuthRepositoryError } from "@hostdeck/storage";
import type { HostDeckRoutePluginRegistration } from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { requireHostDeckRequestAuthentication } from "./fastify-request-authentication.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckDeviceListRouteRegistrationId = "selected-device-list";

export interface HostDeckDeviceListPort {
  readonly list: (input: SelectedDeviceListInput) => unknown;
}

export interface CreateHostDeckDeviceListRouteRegistrationInput {
  readonly devices: HostDeckDeviceListPort;
}

type DeviceListFunction = HostDeckDeviceListPort["list"];

const routeInputKeys = ["devices"] as const;
const deviceListPortKeys = ["list"] as const;
const pageKeys = ["devices", "nextAfterDeviceId", "hasMore"] as const;
const itemKeys = [
  "deviceId",
  "clientLabel",
  "permission",
  "createdAt",
  "lastUsedAt",
  "expiresAt",
  "revokedAt"
] as const;

class HostDeckDeviceListContractError extends Error {
  constructor() {
    super("Selected device-list route contract failed.");
    this.name = "HostDeckDeviceListContractError";
  }
}

export function createHostDeckDeviceListRouteRegistration(
  input: CreateHostDeckDeviceListRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const list = parseRegistrationInput(input);
  const manifest = requireDeviceListManifestEntry();
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckDeviceListRouteRegistrationId,
    surface: "api",
    register(app) {
      app.get(
        manifest.path,
        {
          exposeHeadRoute: false,
          async onRequest(request, reply) {
            reply.header("cache-control", "no-store");
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            querystring: selectedDeviceListQuerySchema,
            response: { 200: selectedDeviceListResponseSchema }
          }
        },
        (request) => {
          const query = request.query as SelectedDeviceListInput;
          const page = parseReturnedPage(invokeDeviceList(list, query));
          assertPageMatchesQuery(page, query);
          return prepareResponse(page);
        }
      );
    }
  };
  return Object.freeze(registration);
}

function parseRegistrationInput(input: unknown): DeviceListFunction {
  const values = readExactDataObject(
    input,
    routeInputKeys,
    "HostDeck device-list route input is invalid."
  );
  const port = readExactDataObject(
    values.devices,
    deviceListPortKeys,
    "HostDeck device-list port is invalid."
  );
  if (typeof port.list !== "function") {
    throw new TypeError("HostDeck device-list port is invalid.");
  }
  return port.list as DeviceListFunction;
}

function requireDeviceListManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === "device_list");
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.family !== "access" ||
    entry.method !== "GET" ||
    entry.path !== "/api/v1/access/devices" ||
    entry.transport !== "json" ||
    entry.request.params !== null ||
    entry.request.query !== "device_list_query_v1" ||
    entry.request.body !== null ||
    entry.response.success !== "device_list_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "device_cookie" ||
    entry.authority !== "device_admin" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "none" ||
    entry.operation_kind !== null ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "access.listDevices" ||
    entry.owner_task !== "IFC-V1-029"
  ) {
    throw new TypeError("Selected device-list route manifest entry is invalid.");
  }
  return entry;
}

function invokeDeviceList(
  list: DeviceListFunction,
  query: SelectedDeviceListInput
): unknown {
  try {
    return Reflect.apply(list, undefined, [query]);
  } catch (error) {
    if (error instanceof HostDeckAuthRepositoryError) {
      switch (error.code) {
        case "invalid_auth_device":
        case "device_list_failed":
          throw storageFailure();
        case "invalid_device_list":
          throw contractFailure();
        default:
          throw contractFailure();
      }
    }
    throw storageFailure();
  }
}

function parseReturnedPage(candidate: unknown): SelectedDeviceListPage {
  try {
    const page = readExactFrozenDataObject(candidate, pageKeys);
    const devices = readExactFrozenArray(page.devices, selectedDeviceListMaxPageSize).map(
      (item) => readExactFrozenDataObject(item, itemKeys)
    );
    const parsed = selectedDeviceListPageSchema.safeParse({
      devices,
      nextAfterDeviceId: page.nextAfterDeviceId,
      hasMore: page.hasMore
    });
    if (!parsed.success) throw new TypeError();
    return parsed.data;
  } catch {
    throw contractFailure();
  }
}

function assertPageMatchesQuery(
  page: SelectedDeviceListPage,
  query: SelectedDeviceListInput
): void {
  const afterDeviceId = query.afterDeviceId;
  if (
    page.devices.length > query.limit ||
    (page.hasMore && page.devices.length !== query.limit) ||
    (afterDeviceId !== null &&
      page.devices.some((device) => device.deviceId <= afterDeviceId))
  ) {
    throw contractFailure();
  }
}

function prepareResponse(page: SelectedDeviceListPage): SelectedDeviceListResponse {
  try {
    const devices = page.devices.map((device) =>
      Object.freeze({
        device_id: device.deviceId,
        client_label: device.clientLabel,
        permission: device.permission,
        created_at: device.createdAt,
        last_used_at: device.lastUsedAt,
        expires_at: device.expiresAt,
        revoked_at: device.revokedAt
      })
    );
    Object.freeze(devices);
    const parsed = selectedDeviceListResponseSchema.safeParse({
      devices,
      next_cursor:
        page.nextAfterDeviceId === null
          ? null
          : encodeSelectedDeviceListCursor(page.nextAfterDeviceId),
      has_more: page.hasMore
    });
    if (!parsed.success) throw new TypeError();
    const frozenDevices = parsed.data.devices.map((device) => Object.freeze({ ...device }));
    Object.freeze(frozenDevices);
    return Object.freeze({ ...parsed.data, devices: frozenDevices });
  } catch {
    throw contractFailure();
  }
}

function storageFailure(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "storage_error",
    message: "Paired-device listing is unavailable.",
    retryable: false,
    status: 500
  });
}

function contractFailure(): HostDeckDeviceListContractError {
  return new HostDeckDeviceListContractError();
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(expectedKeys as readonly string[]).includes(key)
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values) as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}

function readExactFrozenDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> {
  if (!Object.isFrozen(candidate)) throw new TypeError();
  return readExactDataObject(candidate, expectedKeys, "Selected device-list result is invalid.");
}

function readExactFrozenArray(candidate: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype) {
    throw new TypeError();
  }
  if (!Object.isFrozen(candidate)) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const keys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    keys.length !== length + 1
  ) {
    throw new TypeError();
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError();
    }
    values.push(descriptor.value);
  }
  return Object.freeze(values);
}
