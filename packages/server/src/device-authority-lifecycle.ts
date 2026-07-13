import { selectedDeviceIdSchema } from "@hostdeck/contracts";

export type HostDeckDeviceAuthorityErrorCode =
  | "device_revoked"
  | "invalid_device_id"
  | "invalid_lease"
  | "lease_closed";

export class HostDeckDeviceAuthorityError extends Error {
  constructor(readonly code: HostDeckDeviceAuthorityErrorCode) {
    super(errorMessages[code]);
    this.name = "HostDeckDeviceAuthorityError";
    Object.freeze(this);
  }
}

export interface HostDeckActiveDeviceAuthorityLease {
  readonly deviceId: string;
  readonly signal: AbortSignal;
}

export interface HostDeckDeviceAuthorityInvalidationResult {
  readonly alreadyInvalidated: boolean;
  readonly closedLeases: number;
}

export interface HostDeckActiveDeviceAuthoritySnapshot {
  readonly acquired_leases: number;
  readonly active_leases: number;
  readonly invalidations: number;
  readonly rejected_acquisitions: number;
  readonly released_leases: number;
  readonly signaled_leases: number;
  readonly tracked_revocations: number;
}

export interface HostDeckActiveDeviceAuthorityPolicy {
  readonly acquire: (deviceId: string) => HostDeckActiveDeviceAuthorityLease;
  readonly assertActive: (lease: HostDeckActiveDeviceAuthorityLease) => void;
  readonly invalidate: (deviceId: string) => HostDeckDeviceAuthorityInvalidationResult;
  readonly release: (lease: HostDeckActiveDeviceAuthorityLease) => void;
  readonly snapshot: () => HostDeckActiveDeviceAuthoritySnapshot;
}

interface LeaseState {
  readonly controller: AbortController;
  readonly deviceId: string;
  active: boolean;
  invalidated: boolean;
}

interface MutableCounters {
  acquiredLeases: number;
  activeLeases: number;
  invalidations: number;
  rejectedAcquisitions: number;
  releasedLeases: number;
  signaledLeases: number;
}

const acceptedPolicies = new WeakSet<object>();
const errorMessages: Record<HostDeckDeviceAuthorityErrorCode, string> = {
  device_revoked: "Paired-device authority has been revoked.",
  invalid_device_id: "Paired-device authority id is invalid.",
  invalid_lease: "Paired-device authority lease is invalid.",
  lease_closed: "Paired-device authority lease is closed."
};
const invalidationReason = Object.freeze(
  new HostDeckDeviceAuthorityError("device_revoked")
);

export function createHostDeckActiveDeviceAuthorityPolicy(): HostDeckActiveDeviceAuthorityPolicy {
  const activeByDevice = new Map<string, Set<HostDeckActiveDeviceAuthorityLease>>();
  const leaseStates = new WeakMap<HostDeckActiveDeviceAuthorityLease, LeaseState>();
  const revokedDeviceIds = new Set<string>();
  const counters: MutableCounters = {
    acquiredLeases: 0,
    activeLeases: 0,
    invalidations: 0,
    rejectedAcquisitions: 0,
    releasedLeases: 0,
    signaledLeases: 0
  };

  const policy: HostDeckActiveDeviceAuthorityPolicy = Object.freeze({
    acquire(deviceId: string) {
      const parsedDeviceId = parseDeviceId(deviceId);
      if (revokedDeviceIds.has(parsedDeviceId)) {
        counters.rejectedAcquisitions = increment(counters.rejectedAcquisitions);
        throw new HostDeckDeviceAuthorityError("device_revoked");
      }
      const state: LeaseState = {
        active: true,
        controller: new AbortController(),
        deviceId: parsedDeviceId,
        invalidated: false
      };
      const lease: HostDeckActiveDeviceAuthorityLease = Object.freeze({
        deviceId: parsedDeviceId,
        signal: state.controller.signal
      });
      leaseStates.set(lease, state);
      const active = activeByDevice.get(parsedDeviceId) ?? new Set();
      active.add(lease);
      activeByDevice.set(parsedDeviceId, active);
      counters.acquiredLeases = increment(counters.acquiredLeases);
      counters.activeLeases = increment(counters.activeLeases);
      return lease;
    },
    assertActive(lease: HostDeckActiveDeviceAuthorityLease) {
      const state = requireLeaseState(leaseStates, lease);
      if (state.invalidated) throw new HostDeckDeviceAuthorityError("device_revoked");
      if (!state.active) throw new HostDeckDeviceAuthorityError("lease_closed");
    },
    invalidate(deviceId: string) {
      const parsedDeviceId = parseDeviceId(deviceId);
      const alreadyInvalidated = revokedDeviceIds.has(parsedDeviceId);
      revokedDeviceIds.add(parsedDeviceId);
      counters.invalidations = increment(counters.invalidations);
      const active = activeByDevice.get(parsedDeviceId);
      let closedLeases = 0;
      if (active !== undefined) {
        activeByDevice.delete(parsedDeviceId);
        for (const lease of active) {
          const state = requireLeaseState(leaseStates, lease);
          if (!state.active || state.invalidated) continue;
          state.active = false;
          state.invalidated = true;
          closedLeases = increment(closedLeases);
          counters.activeLeases = decrement(counters.activeLeases);
          counters.signaledLeases = increment(counters.signaledLeases);
          state.controller.abort(invalidationReason);
        }
      }
      return Object.freeze({ alreadyInvalidated, closedLeases });
    },
    release(lease: HostDeckActiveDeviceAuthorityLease) {
      const state = requireLeaseState(leaseStates, lease);
      if (!state.active) return;
      state.active = false;
      activeByDevice.get(state.deviceId)?.delete(lease);
      if (activeByDevice.get(state.deviceId)?.size === 0) {
        activeByDevice.delete(state.deviceId);
      }
      counters.activeLeases = decrement(counters.activeLeases);
      counters.releasedLeases = increment(counters.releasedLeases);
    },
    snapshot() {
      return Object.freeze({
        acquired_leases: counters.acquiredLeases,
        active_leases: counters.activeLeases,
        invalidations: counters.invalidations,
        rejected_acquisitions: counters.rejectedAcquisitions,
        released_leases: counters.releasedLeases,
        signaled_leases: counters.signaledLeases,
        tracked_revocations: revokedDeviceIds.size
      });
    }
  });
  acceptedPolicies.add(policy);
  return policy;
}

export function assertHostDeckActiveDeviceAuthorityPolicy(
  candidate: unknown
): asserts candidate is HostDeckActiveDeviceAuthorityPolicy {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedPolicies.has(candidate)
  ) {
    throw new TypeError(
      "HostDeck active device-authority policy must be created by createHostDeckActiveDeviceAuthorityPolicy."
    );
  }
}

function parseDeviceId(candidate: unknown): string {
  const parsed = selectedDeviceIdSchema.safeParse(candidate);
  if (!parsed.success) throw new HostDeckDeviceAuthorityError("invalid_device_id");
  return parsed.data;
}

function requireLeaseState(
  states: WeakMap<HostDeckActiveDeviceAuthorityLease, LeaseState>,
  candidate: unknown
): LeaseState {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate)
  ) {
    throw new HostDeckDeviceAuthorityError("invalid_lease");
  }
  const state = states.get(candidate as HostDeckActiveDeviceAuthorityLease);
  if (state === undefined) throw new HostDeckDeviceAuthorityError("invalid_lease");
  return state;
}

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function decrement(value: number): number {
  return value > 0 ? value - 1 : 0;
}
