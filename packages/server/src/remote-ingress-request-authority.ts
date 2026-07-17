import { remoteExternalOriginSchema } from "@hostdeck/contracts";
import type { TailscaleServeRemoteAdmissionSnapshot } from "./tailscale-serve-proxy-trust.js";

export type HostDeckRemoteIngressRequestAuthorityErrorCode =
  | "authority_closed"
  | "generation_stale"
  | "invalid_admission"
  | "invalid_lease"
  | "lease_closed";

export class HostDeckRemoteIngressRequestAuthorityError extends Error {
  constructor(readonly code: HostDeckRemoteIngressRequestAuthorityErrorCode) {
    super(errorMessages[code]);
    this.name = "HostDeckRemoteIngressRequestAuthorityError";
    Object.freeze(this);
  }
}

export interface HostDeckRemoteIngressRequestAuthorityLease {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface HostDeckRemoteIngressRequestAuthorityLeaseInput {
  readonly external_origin: string;
  readonly generation: number;
}

export interface HostDeckRemoteIngressRequestAuthoritySnapshot {
  readonly acquired_leases: number;
  readonly active_leases: number;
  readonly admission_failures: number;
  readonly generation: number;
  readonly invalidations: number;
  readonly phase: "open" | "closed";
  readonly refreshes: number;
  readonly rejected_acquisitions: number;
  readonly released_leases: number;
  readonly signaled_leases: number;
}

export interface HostDeckRemoteIngressRequestAuthorityPolicy {
  readonly acquire: (
    input: HostDeckRemoteIngressRequestAuthorityLeaseInput
  ) => HostDeckRemoteIngressRequestAuthorityLease;
  readonly assertActive: (
    lease: HostDeckRemoteIngressRequestAuthorityLease
  ) => void;
  readonly close: () => void;
  readonly release: (
    lease: HostDeckRemoteIngressRequestAuthorityLease
  ) => void;
  readonly snapshot: () => HostDeckRemoteIngressRequestAuthoritySnapshot;
  readonly synchronize: (
    admission: unknown
  ) => TailscaleServeRemoteAdmissionSnapshot;
}

interface LeaseState {
  readonly controller: AbortController;
  readonly generation: number;
  active: boolean;
  invalidated: boolean;
}

interface MutableCounters {
  acquiredLeases: number;
  admissionFailures: number;
  invalidations: number;
  refreshes: number;
  rejectedAcquisitions: number;
  releasedLeases: number;
  signaledLeases: number;
}

const acceptedPolicies = new WeakSet<object>();
const admissionKeys = ["admission", "external_origin", "generation"] as const;
const leaseInputKeys = ["external_origin", "generation"] as const;
const errorMessages: Readonly<
  Record<HostDeckRemoteIngressRequestAuthorityErrorCode, string>
> = Object.freeze({
  authority_closed: "Remote ingress request authority is closed.",
  generation_stale: "Remote ingress request generation is no longer current.",
  invalid_admission: "Remote ingress admission is invalid.",
  invalid_lease: "Remote ingress request authority lease is invalid.",
  lease_closed: "Remote ingress request authority lease is closed."
});
const invalidationReason = new HostDeckRemoteIngressRequestAuthorityError(
  "generation_stale"
);
const closedAdmission: TailscaleServeRemoteAdmissionSnapshot = Object.freeze({
  admission: "closed",
  external_origin: null,
  generation: 0
});

export function createHostDeckRemoteIngressRequestAuthorityPolicy(): HostDeckRemoteIngressRequestAuthorityPolicy {
  const activeLeases = new Set<HostDeckRemoteIngressRequestAuthorityLease>();
  const leaseStates = new WeakMap<
    HostDeckRemoteIngressRequestAuthorityLease,
    LeaseState
  >();
  const counters: MutableCounters = {
    acquiredLeases: 0,
    admissionFailures: 0,
    invalidations: 0,
    refreshes: 0,
    rejectedAcquisitions: 0,
    releasedLeases: 0,
    signaledLeases: 0
  };
  let closed = false;
  let currentGeneration = 0;
  let currentOrigin: string | null = null;
  let highestGeneration = 0;
  let highestGenerationOrigin: string | null = null;

  const invalidateCurrent = (): void => {
    if (currentOrigin === null) return;
    currentOrigin = null;
    counters.invalidations = increment(counters.invalidations);
    for (const lease of activeLeases) {
      const state = requireLeaseState(leaseStates, lease);
      if (!state.active || state.invalidated) continue;
      state.active = false;
      state.invalidated = true;
      counters.signaledLeases = increment(counters.signaledLeases);
      state.controller.abort(invalidationReason);
    }
    activeLeases.clear();
  };

  const synchronize = (
    input: unknown
  ): TailscaleServeRemoteAdmissionSnapshot => {
    counters.refreshes = increment(counters.refreshes);
    if (closed) return closedSnapshot(highestGeneration);

    const admission = parseAdmission(input);
    if (
      admission === null ||
      admission.generation < highestGeneration ||
      (admission.admission === "open" &&
        admission.generation === highestGeneration &&
        highestGenerationOrigin !== null &&
        admission.external_origin !== highestGenerationOrigin)
    ) {
      counters.admissionFailures = increment(counters.admissionFailures);
      invalidateCurrent();
      return closedSnapshot(highestGeneration);
    }

    if (admission.generation > highestGeneration) {
      highestGeneration = admission.generation;
      highestGenerationOrigin =
        admission.admission === "open" ? admission.external_origin : null;
    } else if (
      admission.admission === "open" &&
      highestGenerationOrigin === null
    ) {
      highestGenerationOrigin = admission.external_origin;
    }
    currentGeneration = admission.generation;
    if (admission.admission === "closed") {
      invalidateCurrent();
      return closedSnapshot(currentGeneration);
    }
    if (currentOrigin !== null && currentOrigin === admission.external_origin) {
      return admission;
    }
    invalidateCurrent();
    currentOrigin = admission.external_origin;
    return admission;
  };

  const policy: HostDeckRemoteIngressRequestAuthorityPolicy = Object.freeze({
    acquire(input: HostDeckRemoteIngressRequestAuthorityLeaseInput) {
      const parsed = parseLeaseInput(input);
      if (
        closed ||
        currentOrigin === null ||
        parsed.generation !== currentGeneration ||
        parsed.external_origin !== currentOrigin
      ) {
        counters.rejectedAcquisitions = increment(
          counters.rejectedAcquisitions
        );
        throw new HostDeckRemoteIngressRequestAuthorityError(
          closed ? "authority_closed" : "generation_stale"
        );
      }
      const state: LeaseState = {
        active: true,
        controller: new AbortController(),
        generation: parsed.generation,
        invalidated: false
      };
      const lease: HostDeckRemoteIngressRequestAuthorityLease = Object.freeze({
        generation: parsed.generation,
        signal: state.controller.signal
      });
      leaseStates.set(lease, state);
      activeLeases.add(lease);
      counters.acquiredLeases = increment(counters.acquiredLeases);
      return lease;
    },
    assertActive(lease: HostDeckRemoteIngressRequestAuthorityLease) {
      const state = requireLeaseState(leaseStates, lease);
      if (state.invalidated) {
        throw new HostDeckRemoteIngressRequestAuthorityError(
          "generation_stale"
        );
      }
      if (!state.active) {
        throw new HostDeckRemoteIngressRequestAuthorityError("lease_closed");
      }
      if (
        closed ||
        currentOrigin === null ||
        state.generation !== currentGeneration
      ) {
        throw new HostDeckRemoteIngressRequestAuthorityError(
          "generation_stale"
        );
      }
    },
    close() {
      if (closed) return;
      closed = true;
      invalidateCurrent();
    },
    release(lease: HostDeckRemoteIngressRequestAuthorityLease) {
      const state = requireLeaseState(leaseStates, lease);
      if (!state.active) return;
      state.active = false;
      activeLeases.delete(lease);
      counters.releasedLeases = increment(counters.releasedLeases);
    },
    snapshot() {
      return Object.freeze({
        acquired_leases: counters.acquiredLeases,
        active_leases: activeLeases.size,
        admission_failures: counters.admissionFailures,
        generation: currentGeneration,
        invalidations: counters.invalidations,
        phase: !closed && currentOrigin !== null ? "open" : "closed",
        refreshes: counters.refreshes,
        rejected_acquisitions: counters.rejectedAcquisitions,
        released_leases: counters.releasedLeases,
        signaled_leases: counters.signaledLeases
      });
    },
    synchronize
  });
  acceptedPolicies.add(policy);
  return policy;
}

export function assertHostDeckRemoteIngressRequestAuthorityPolicy(
  candidate: unknown
): asserts candidate is HostDeckRemoteIngressRequestAuthorityPolicy {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedPolicies.has(candidate)
  ) {
    throw new TypeError(
      "Remote ingress request authority must be created by its factory."
    );
  }
}

function parseAdmission(
  input: unknown
): TailscaleServeRemoteAdmissionSnapshot | null {
  const values = readExactDataObject(input, admissionKeys);
  if (values === null) return null;
  if (
    !Number.isSafeInteger(values.generation) ||
    (values.generation as number) < 0 ||
    (values.admission !== "open" && values.admission !== "closed")
  ) {
    return null;
  }
  const generation = values.generation as number;
  if (values.admission === "closed") {
    if (values.external_origin !== null) return null;
    return closedSnapshot(generation);
  }
  if (
    generation === 0 ||
    !remoteExternalOriginSchema.safeParse(values.external_origin).success
  ) {
    return null;
  }
  return Object.freeze({
    admission: "open",
    external_origin: values.external_origin as string,
    generation
  });
}

function parseLeaseInput(
  input: unknown
): HostDeckRemoteIngressRequestAuthorityLeaseInput {
  const values = readExactDataObject(input, leaseInputKeys);
  if (
    values === null ||
    !Number.isSafeInteger(values.generation) ||
    (values.generation as number) <= 0 ||
    !remoteExternalOriginSchema.safeParse(values.external_origin).success
  ) {
    throw new HostDeckRemoteIngressRequestAuthorityError("invalid_admission");
  }
  return Object.freeze({
    external_origin: values.external_origin as string,
    generation: values.generation as number
  });
}

function requireLeaseState(
  states: WeakMap<HostDeckRemoteIngressRequestAuthorityLease, LeaseState>,
  candidate: unknown
): LeaseState {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate)
  ) {
    throw new HostDeckRemoteIngressRequestAuthorityError("invalid_lease");
  }
  const state = states.get(
    candidate as HostDeckRemoteIngressRequestAuthorityLease
  );
  if (state === undefined) {
    throw new HostDeckRemoteIngressRequestAuthorityError("invalid_lease");
  }
  return state;
}

function readExactDataObject<const Key extends string>(
  input: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(expectedKeys as readonly string[]).includes(key)
      )
    ) {
      return null;
    }
    const output = Object.create(null) as Record<Key, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function closedSnapshot(
  generation: number
): TailscaleServeRemoteAdmissionSnapshot {
  if (generation === 0) return closedAdmission;
  return Object.freeze({
    admission: "closed",
    external_origin: null,
    generation
  });
}

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}
