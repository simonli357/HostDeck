import {
  isoTimestampSchema,
  selectedPairingClientLabelSchema,
  selectedPairingDeviceIdSchema,
  selectedPairingPermissionSchema,
  selectedRawCsrfTokenSchema
} from "@hostdeck/contracts";
import {
  type BrowserConnectionCoordinatorFactory,
  createProductionBrowserConnectionCoordinator
} from "./browser-runtime.js";
import type { BrowserConnectionStateCoordinator } from "./connection-state.js";
import {
  type BrowserPairingBootstrapResult,
  bootstrapWindowPairing
} from "./pairing-bootstrap.js";

export const browserAppStartupPhases = Object.freeze([
  "checking",
  "claiming",
  "paired",
  "ready",
  "invalid_link",
  "secure_entry_failed",
  "link_not_accepted",
  "origin_rejected",
  "rate_limited",
  "claim_unavailable",
  "claim_unknown",
  "paired_csrf_unavailable",
  "startup_failed",
  "reloading",
  "closed"
] as const);

export type BrowserAppStartupPhase = (typeof browserAppStartupPhases)[number];

export interface BrowserAppPairingSummary {
  readonly permission: "read" | "write";
  readonly clientLabel: string | null;
  readonly deviceExpiresAt: string;
}

export interface BrowserAppStartupSnapshot {
  readonly phase: BrowserAppStartupPhase;
  readonly pairing: BrowserAppPairingSummary | null;
}

export interface CreateBrowserAppStartupOptions {
  readonly bootstrapPairing: () => Promise<BrowserPairingBootstrapResult>;
  readonly createCoordinator: BrowserConnectionCoordinatorFactory;
  readonly reload: () => void;
}

export interface BrowserAppStartupController {
  readonly snapshot: () => BrowserAppStartupSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly coordinator: () => BrowserConnectionStateCoordinator | null;
  readonly continueToApp: () => BrowserAppStartupSnapshot;
  readonly reload: () => BrowserAppStartupSnapshot;
  readonly close: () => BrowserAppStartupSnapshot;
}

const optionKeys = ["bootstrapPairing", "createCoordinator", "reload"] as const;
const coordinatorKeys = [
  "snapshot",
  "subscribe",
  "setTarget",
  "refresh",
  "loadMoreSessions",
  "connectSessionStream",
  "disconnectSessionStream",
  "bootstrapCsrf",
  "adoptCsrfBootstrap",
  "requestProtected",
  "close"
] as const;
const maximumSubscribers = 16;
const reloadablePhases: readonly BrowserAppStartupPhase[] = Object.freeze([
  "claim_unknown",
  "paired_csrf_unavailable",
  "startup_failed"
]);

export function createBrowserAppStartupController(
  input: CreateBrowserAppStartupOptions
): BrowserAppStartupController {
  const options = readOptions(input);
  const subscribers = new Set<() => void>();
  let closed = false;
  let coordinatorOwner: BrowserConnectionStateCoordinator | null = null;
  let currentSnapshot = startupSnapshot("checking", null);

  const publish = (
    phase: BrowserAppStartupPhase,
    pairing: BrowserAppPairingSummary | null = null
  ): BrowserAppStartupSnapshot => {
    const next = startupSnapshot(phase, pairing);
    if (sameSnapshot(currentSnapshot, next)) return currentSnapshot;
    currentSnapshot = next;
    for (const listener of [...subscribers]) {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    return currentSnapshot;
  };

  const failStartup = (): void => {
    coordinatorOwner?.close();
    coordinatorOwner = null;
    if (!closed) publish("startup_failed");
  };

  const acceptPairingResult = (candidate: unknown): void => {
    if (closed) return;
    const result = readPairingResult(candidate);
    if (result === null) {
      failStartup();
      return;
    }
    switch (result.state) {
      case "no_fragment":
        try {
          coordinatorOwner = createCoordinator(options.createCoordinator);
          publish("ready");
        } catch {
          failStartup();
        }
        return;
      case "entry_rejected":
        publish(
          result.reason === "history_unavailable"
            ? "secure_entry_failed"
            : "invalid_link"
        );
        return;
      case "claim_rejected":
        publish(
          result.reason === "origin_rejected"
            ? "origin_rejected"
            : "link_not_accepted"
        );
        return;
      case "claim_rate_limited":
        publish("rate_limited");
        return;
      case "claim_unavailable":
        publish("claim_unavailable");
        return;
      case "claim_unknown":
        publish("claim_unknown");
        return;
      case "paired_csrf_unavailable":
        publish("paired_csrf_unavailable", pairingSummary(result));
        return;
      case "paired": {
        let nextCoordinator: BrowserConnectionStateCoordinator | null = null;
        try {
          nextCoordinator = createCoordinator(options.createCoordinator);
          nextCoordinator.adoptCsrfBootstrap({
            csrf_token: result.csrf_token,
            csrf_generation: result.csrf_generation,
            rotated_at: result.csrf_rotated_at
          });
          if (closed) {
            nextCoordinator.close();
            return;
          }
          coordinatorOwner = nextCoordinator;
          publish("paired", pairingSummary(result));
        } catch {
          nextCoordinator?.close();
          failStartup();
        }
        return;
      }
    }
  };

  let pending: Promise<BrowserPairingBootstrapResult>;
  try {
    pending = startPairing(options.bootstrapPairing);
  } catch {
    pending = Promise.reject(new TypeError("HostDeck pairing startup failed."));
  }
  void pending.then(acceptPairingResult, failStartup);
  queueMicrotask(() => {
    if (!closed && currentSnapshot.phase === "checking") publish("claiming");
  });

  return Object.freeze({
    snapshot: () => currentSnapshot,
    subscribe(listener: () => void): () => void {
      if (closed) throw new TypeError("HostDeck app startup is closed.");
      if (typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck app startup listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck app startup listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    coordinator: () =>
      !closed && currentSnapshot.phase === "ready" ? coordinatorOwner : null,
    continueToApp(): BrowserAppStartupSnapshot {
      if (
        closed ||
        currentSnapshot.phase !== "paired" ||
        coordinatorOwner === null
      ) {
        throw new TypeError("HostDeck app startup cannot continue.");
      }
      return publish("ready");
    },
    reload(): BrowserAppStartupSnapshot {
      if (closed || !reloadablePhases.includes(currentSnapshot.phase)) {
        throw new TypeError("HostDeck app startup cannot reload.");
      }
      publish("reloading", currentSnapshot.pairing);
      try {
        Reflect.apply(options.reload, undefined, []);
      } catch {
        publish("startup_failed");
      }
      return currentSnapshot;
    },
    close(): BrowserAppStartupSnapshot {
      if (closed) return currentSnapshot;
      closed = true;
      coordinatorOwner?.close();
      coordinatorOwner = null;
      const snapshot = publish("closed");
      subscribers.clear();
      return snapshot;
    }
  });
}

export function createProductionBrowserAppStartup(): BrowserAppStartupController {
  return createBrowserAppStartupController({
    bootstrapPairing: bootstrapWindowPairing,
    createCoordinator: createProductionBrowserConnectionCoordinator,
    reload: () => {
      if (typeof globalThis.location?.reload !== "function") {
        throw new TypeError("HostDeck browser reload is unavailable.");
      }
      globalThis.location.reload();
    }
  });
}

function readOptions(input: unknown): CreateBrowserAppStartupOptions {
  const values = readExactObject(input, optionKeys);
  if (
    values === null ||
    typeof values.bootstrapPairing !== "function" ||
    typeof values.createCoordinator !== "function" ||
    typeof values.reload !== "function"
  ) {
    throw new TypeError("HostDeck app startup options are invalid.");
  }
  return Object.freeze({
    bootstrapPairing: values.bootstrapPairing as CreateBrowserAppStartupOptions["bootstrapPairing"],
    createCoordinator: values.createCoordinator as BrowserConnectionCoordinatorFactory,
    reload: values.reload as CreateBrowserAppStartupOptions["reload"]
  });
}

function startPairing(
  port: CreateBrowserAppStartupOptions["bootstrapPairing"]
): Promise<BrowserPairingBootstrapResult> {
  const candidate = Reflect.apply(port, undefined, []) as unknown;
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError("HostDeck pairing startup result is invalid.");
  }
  const then = Reflect.get(candidate, "then") as unknown;
  if (typeof then !== "function") {
    throw new TypeError("HostDeck pairing startup result is invalid.");
  }
  return Promise.resolve(candidate as Promise<BrowserPairingBootstrapResult>);
}

function createCoordinator(
  port: BrowserConnectionCoordinatorFactory
): BrowserConnectionStateCoordinator {
  const candidate = Reflect.apply(port, undefined, []) as unknown;
  const values = readExactObject(candidate, coordinatorKeys);
  let frozen = false;
  try {
    frozen = candidate !== null && typeof candidate === "object" && Object.isFrozen(candidate);
  } catch {
    frozen = false;
  }
  if (
    values === null ||
    !frozen ||
    coordinatorKeys.some((key) => typeof values[key] !== "function")
  ) {
    throw new TypeError("HostDeck browser coordinator startup failed.");
  }
  return candidate as BrowserConnectionStateCoordinator;
}

function readPairingResult(candidate: unknown): BrowserPairingBootstrapResult | null {
  const stateRecord = readRecord(candidate);
  if (stateRecord === null || typeof stateRecord.state !== "string") return null;
  switch (stateRecord.state) {
    case "no_fragment":
      return exactKeys(stateRecord, ["state"])
        ? Object.freeze({ state: "no_fragment" })
        : null;
    case "entry_rejected":
      return exactKeys(stateRecord, ["state", "reason"]) &&
        ["history_unavailable", "invalid_fragment", "invalid_origin", "invalid_route"].includes(
          String(stateRecord.reason)
        )
        ? Object.freeze({
            state: "entry_rejected",
            reason: stateRecord.reason as Extract<
              BrowserPairingBootstrapResult,
              { state: "entry_rejected" }
            >["reason"]
          })
        : null;
    case "claim_rejected":
      return exactKeys(stateRecord, ["state", "reason"]) &&
        ["not_accepted", "origin_rejected"].includes(String(stateRecord.reason))
        ? Object.freeze({
            state: "claim_rejected",
            reason: stateRecord.reason as "not_accepted" | "origin_rejected"
          })
        : null;
    case "claim_rate_limited":
    case "claim_unavailable":
    case "claim_unknown":
      return exactKeys(stateRecord, ["state"])
        ? Object.freeze({ state: stateRecord.state }) as BrowserPairingBootstrapResult
        : null;
    case "paired_csrf_unavailable": {
      if (!exactKeys(stateRecord, [
        "state",
        "reason",
        "device_id",
        "permission",
        "client_label",
        "device_expires_at"
      ])) return null;
      if (
        !["bootstrap_rejected", "bootstrap_unavailable", "bootstrap_unknown"].includes(
          String(stateRecord.reason)
        ) ||
        !pairedDeviceFieldsAreValid(stateRecord)
      ) return null;
      return Object.freeze({
        state: "paired_csrf_unavailable",
        reason: stateRecord.reason as "bootstrap_rejected" | "bootstrap_unavailable" | "bootstrap_unknown",
        device_id: stateRecord.device_id as string,
        permission: stateRecord.permission as "read" | "write",
        client_label: stateRecord.client_label as string | null,
        device_expires_at: stateRecord.device_expires_at as string
      });
    }
    case "paired": {
      if (!exactKeys(stateRecord, [
        "state",
        "device_id",
        "permission",
        "client_label",
        "device_expires_at",
        "csrf_token",
        "csrf_generation",
        "csrf_rotated_at"
      ])) return null;
      if (
        !pairedDeviceFieldsAreValid(stateRecord) ||
        !selectedRawCsrfTokenSchema.safeParse(stateRecord.csrf_token).success ||
        !Number.isSafeInteger(stateRecord.csrf_generation) ||
        Number(stateRecord.csrf_generation) < 1 ||
        !isoTimestampSchema.safeParse(stateRecord.csrf_rotated_at).success
      ) return null;
      return Object.freeze({
        state: "paired",
        device_id: stateRecord.device_id as string,
        permission: stateRecord.permission as "read" | "write",
        client_label: stateRecord.client_label as string | null,
        device_expires_at: stateRecord.device_expires_at as string,
        csrf_token: stateRecord.csrf_token as string,
        csrf_generation: stateRecord.csrf_generation as number,
        csrf_rotated_at: stateRecord.csrf_rotated_at as string
      });
    }
    default:
      return null;
  }
}

function pairedDeviceFieldsAreValid(record: Readonly<Record<string, unknown>>): boolean {
  return (
    selectedPairingDeviceIdSchema.safeParse(record.device_id).success &&
    selectedPairingPermissionSchema.safeParse(record.permission).success &&
    selectedPairingClientLabelSchema.nullable().safeParse(record.client_label).success &&
    isoTimestampSchema.safeParse(record.device_expires_at).success
  );
}

function pairingSummary(
  result: Extract<
    BrowserPairingBootstrapResult,
    { state: "paired" | "paired_csrf_unavailable" }
  >
): BrowserAppPairingSummary {
  return Object.freeze({
    permission: result.permission,
    clientLabel: result.client_label,
    deviceExpiresAt: result.device_expires_at
  });
}

function startupSnapshot(
  phase: BrowserAppStartupPhase,
  pairing: BrowserAppPairingSummary | null
): BrowserAppStartupSnapshot {
  return Object.freeze({ phase, pairing });
}

function sameSnapshot(
  left: BrowserAppStartupSnapshot,
  right: BrowserAppStartupSnapshot
): boolean {
  return (
    left.phase === right.phase &&
    left.pairing?.permission === right.pairing?.permission &&
    left.pairing?.clientLabel === right.pairing?.clientLabel &&
    left.pairing?.deviceExpiresAt === right.pairing?.deviceExpiresAt
  );
}

function readExactObject(
  candidate: unknown,
  keys: readonly string[]
): Record<string, unknown> | null {
  const record = readRecord(candidate);
  return record !== null && exactKeys(record, keys) ? record : null;
}

function readRecord(candidate: unknown): Record<string, unknown> | null {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
