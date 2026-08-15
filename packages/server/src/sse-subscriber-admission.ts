import {
  assertResolvedResourceBudget,
  type ResourceBudget,
  selectedDeviceIdSchema
} from "@hostdeck/contracts";

export type SseSubscriberAdmissionErrorCode =
  | "device_limit"
  | "duplicate_subscriber"
  | "global_limit"
  | "invalid_config"
  | "invalid_input";

export class HostDeckSseSubscriberAdmissionError extends Error {
  constructor(readonly code: SseSubscriberAdmissionErrorCode) {
    super(messages[code]);
    this.name = "HostDeckSseSubscriberAdmissionError";
    Object.freeze(this);
  }
}

export interface SseSubscriberAdmissionLease {
  readonly active: boolean;
  readonly device_id: string | null;
  readonly release: () => boolean;
  readonly subscriber_id: string;
}

export interface SseSubscriberAdmissionSnapshot {
  readonly active_device_buckets: number;
  readonly active_subscribers: number;
  readonly rejected_subscribers: number;
}

export interface SseSubscriberAdmissionService {
  readonly reserve: (input: unknown) => SseSubscriberAdmissionLease;
  readonly snapshot: () => SseSubscriberAdmissionSnapshot;
}

interface LeaseRecord {
  readonly deviceId: string | null;
  readonly id: string;
  readonly token: symbol;
}

const acceptedServices = new WeakSet<object>();
const subscriberIdPattern = /^[a-zA-Z0-9_.:-]{1,120}$/u;
const messages: Readonly<Record<SseSubscriberAdmissionErrorCode, string>> =
  Object.freeze({
    device_limit: "SSE device subscriber capacity is exhausted.",
    duplicate_subscriber: "SSE subscriber id already exists.",
    global_limit: "SSE global subscriber capacity is exhausted.",
    invalid_config: "SSE subscriber admission configuration is invalid.",
    invalid_input: "SSE subscriber admission input is invalid."
  });

export function createSseSubscriberAdmissionService(
  resourceBudget: ResourceBudget
): SseSubscriberAdmissionService {
  try {
    assertResolvedResourceBudget(resourceBudget);
  } catch {
    throw new HostDeckSseSubscriberAdmissionError("invalid_config");
  }
  const subscribers = new Map<string, LeaseRecord>();
  const deviceCounts = new Map<string, number>();
  let rejectedSubscribers = 0;

  const service = Object.freeze({
    reserve(candidate: unknown): SseSubscriberAdmissionLease {
      const input = parseInput(candidate);
      let code: SseSubscriberAdmissionErrorCode | null = null;
      if (subscribers.has(input.id)) code = "duplicate_subscriber";
      else if (subscribers.size >= resourceBudget.sse_max_subscribers) {
        code = "global_limit";
      } else if (
        input.deviceId !== null &&
        (deviceCounts.get(input.deviceId) ?? 0) >=
          resourceBudget.sse_max_subscribers_per_device
      ) {
        code = "device_limit";
      }
      if (code !== null) {
        rejectedSubscribers = increment(rejectedSubscribers);
        throw new HostDeckSseSubscriberAdmissionError(code);
      }

      const record: LeaseRecord = {
        deviceId: input.deviceId,
        id: input.id,
        token: Symbol(input.id)
      };
      subscribers.set(record.id, record);
      if (record.deviceId !== null) {
        deviceCounts.set(
          record.deviceId,
          (deviceCounts.get(record.deviceId) ?? 0) + 1
        );
      }
      return createLease(subscribers, deviceCounts, record);
    },
    snapshot(): SseSubscriberAdmissionSnapshot {
      return Object.freeze({
        active_device_buckets: deviceCounts.size,
        active_subscribers: subscribers.size,
        rejected_subscribers: rejectedSubscribers
      });
    }
  });
  acceptedServices.add(service);
  return service;
}

export function assertSseSubscriberAdmissionService(
  candidate: unknown
): asserts candidate is SseSubscriberAdmissionService {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedServices.has(candidate)
  ) {
    throw new HostDeckSseSubscriberAdmissionError("invalid_config");
  }
}

function createLease(
  subscribers: Map<string, LeaseRecord>,
  deviceCounts: Map<string, number>,
  record: LeaseRecord
): SseSubscriberAdmissionLease {
  const release = (): boolean => {
    if (subscribers.get(record.id)?.token !== record.token) return false;
    subscribers.delete(record.id);
    if (record.deviceId !== null) {
      const count = deviceCounts.get(record.deviceId);
      if (count === undefined || count < 1) {
        throw new Error("SSE device admission accounting is inconsistent.");
      }
      if (count === 1) deviceCounts.delete(record.deviceId);
      else deviceCounts.set(record.deviceId, count - 1);
    }
    return true;
  };
  return Object.freeze({
    device_id: record.deviceId,
    release,
    subscriber_id: record.id,
    get active() {
      return subscribers.get(record.id)?.token === record.token;
    }
  });
}

function parseInput(candidate: unknown): {
  readonly deviceId: string | null;
  readonly id: string;
} {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new HostDeckSseSubscriberAdmissionError("invalid_input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const id = descriptors.subscriber_id;
  const device = descriptors.device_id;
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "device_id" && key !== "subscriber_id") ||
    id === undefined ||
    device === undefined ||
    !("value" in id) ||
    !("value" in device) ||
    typeof id.value !== "string" ||
    !subscriberIdPattern.test(id.value)
  ) {
    throw new HostDeckSseSubscriberAdmissionError("invalid_input");
  }
  const parsedDevice =
    device.value === null
      ? null
      : selectedDeviceIdSchema.safeParse(device.value);
  if (parsedDevice !== null && !parsedDevice.success) {
    throw new HostDeckSseSubscriberAdmissionError("invalid_input");
  }
  return Object.freeze({
    deviceId: parsedDevice === null ? null : parsedDevice.data,
    id: id.value
  });
}

function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("SSE subscriber admission counter is exhausted.");
  }
  return value + 1;
}
