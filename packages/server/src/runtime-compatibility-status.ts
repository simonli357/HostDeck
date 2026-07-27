import { codexBindingDescriptor } from "@hostdeck/codex-adapter";
import {
  type SelectedHostCompatibilityStatus,
  type SelectedRuntimeCompatibilityRecord,
  selectedHostCompatibilityStatusSchema,
  selectedRuntimeCompatibilityRecordSchema
} from "@hostdeck/contracts";
import { requiredRuntimeCapabilities } from "@hostdeck/core";
import type {
  HostDeckLocalComponentHealthSnapshot,
  HostDeckLocalHealthSnapshot
} from "./host-health.js";

export interface HostDeckRuntimeCompatibilityRecordReader {
  readonly read: () => SelectedRuntimeCompatibilityRecord | null;
}

export interface CreateHostDeckRuntimeCompatibilityRecordReaderInput {
  readonly read: () => SelectedRuntimeCompatibilityRecord | null;
}

const acceptedReaders = new WeakSet<object>();

export function createHostDeckRuntimeCompatibilityRecordReader(
  input: CreateHostDeckRuntimeCompatibilityRecordReaderInput
): HostDeckRuntimeCompatibilityRecordReader {
  const read = readExactFunction(input, "read");
  const reader: HostDeckRuntimeCompatibilityRecordReader = Object.freeze({
    read: () => Reflect.apply(read, undefined, [])
  });
  acceptedReaders.add(reader);
  return reader;
}

export function assertHostDeckRuntimeCompatibilityRecordReader(
  candidate: unknown
): asserts candidate is HostDeckRuntimeCompatibilityRecordReader {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedReaders.has(candidate)
  ) {
    throw new TypeError(
      "Runtime compatibility reader must be created by its selected factory."
    );
  }
}

export function projectHostDeckRuntimeCompatibilityStatus(
  local: HostDeckLocalHealthSnapshot,
  recordCandidate: SelectedRuntimeCompatibilityRecord | null
): SelectedHostCompatibilityStatus {
  const compatibilityHealth = requireComponent(local, "compatibility");
  const runtimeHealth = requireComponent(local, "runtime");
  const record = parseRecord(recordCandidate);

  if (record === null) {
    if (
      (compatibilityHealth.state !== "unknown" &&
        compatibilityHealth.state !== "stale") ||
      !hasOnlyReason(compatibilityHealth, [
        "not_observed",
        "source_unknown",
        "source_stale",
        "compatibility_unchecked"
      ])
    ) {
      throw projectionFailure();
    }
    return project({
      state: "unknown",
      evidence: "unobserved",
      observed_version: null,
      supported_version: codexBindingDescriptor.codex_version,
      capability_state: "unverified",
      checked_at: null,
      recorded_at: null
    });
  }

  const compatibility = record.compatibility;
  const checkedAt = timestamp(compatibility.checked_at);
  const recordedAt = timestamp(record.recorded_at);
  if (recordedAt < checkedAt) throw projectionFailure();
  const evidence = {
    observed_version: compatibility.observed_version,
    supported_version: codexBindingDescriptor.codex_version,
    checked_at: compatibility.checked_at,
    recorded_at: record.recorded_at
  } as const;
  const healthEstablishedAfterRecord =
    observedAfter(compatibilityHealth, recordedAt) &&
    observedAfter(runtimeHealth, recordedAt);

  if (
    compatibilityHealth.state === "ready" &&
    runtimeHealth.state === "ready" &&
    compatibilityHealth.reasons.length === 0 &&
    runtimeHealth.reasons.length === 0
  ) {
    if (
      !healthEstablishedAfterRecord ||
      compatibility.state !== "ready" ||
      compatibility.mutation_policy !== "allowed" ||
      compatibility.observed_version !== codexBindingDescriptor.codex_version ||
      compatibility.binding_id !== codexBindingDescriptor.binding_id ||
      !requiredCapabilitiesAreAvailable(compatibility)
    ) {
      throw projectionFailure();
    }
    return project({
      state: "supported",
      evidence: "current",
      capability_state: "verified",
      ...evidence
    });
  }

  if (
    compatibilityHealth.state === "failed" &&
    runtimeHealth.state === "failed" &&
    hasExactReason(compatibilityHealth, "runtime_incompatible") &&
    hasExactReason(runtimeHealth, "runtime_failed")
  ) {
    if (
      !healthEstablishedAfterRecord ||
      compatibility.state !== "incompatible" ||
      compatibility.mutation_policy !== "blocked"
    ) {
      throw projectionFailure();
    }
    return project({
      state:
        compatibility.observed_version !== null &&
        compatibility.observed_version !== codexBindingDescriptor.codex_version
          ? "version_drift"
          : "incompatible",
      evidence: "current",
      capability_state: "blocked",
      ...evidence
    });
  }

  if (
    compatibilityHealth.state === "degraded" &&
    runtimeHealth.state === "degraded" &&
    hasExactReason(compatibilityHealth, "compatibility_degraded")
  ) {
    if (!healthEstablishedAfterRecord) throw projectionFailure();
    if (hasExactReason(runtimeHealth, "runtime_disconnected")) {
      return project({
        state: "disconnected",
        evidence: "last_known",
        capability_state: "unverified",
        ...evidence
      });
    }
    if (
      !hasOnlyReason(runtimeHealth, ["runtime_reconciling", "runtime_starting"])
    ) {
      throw projectionFailure();
    }
    const current =
      compatibility.state === "degraded" &&
      compatibility.mutation_policy === "blocked" &&
      compatibility.observed_version === codexBindingDescriptor.codex_version &&
      compatibility.binding_id === codexBindingDescriptor.binding_id &&
      requiredCapabilitiesAreAvailable(compatibility);
    return project({
      state: "degraded",
      evidence: current ? "current" : "last_known",
      capability_state: current ? "limited" : "unverified",
      ...evidence
    });
  }

  if (
    (compatibilityHealth.state === "unknown" ||
      compatibilityHealth.state === "stale") &&
    hasOnlyReason(compatibilityHealth, [
      "not_observed",
      "source_unknown",
      "source_stale",
      "compatibility_unchecked"
    ]) &&
    (compatibilityHealth.checked_at === null ||
      observedAfter(compatibilityHealth, recordedAt))
  ) {
    return project({
      state: "unknown",
      evidence: "last_known",
      capability_state: "unverified",
      ...evidence
    });
  }

  throw projectionFailure();
}

function parseRecord(
  candidate: SelectedRuntimeCompatibilityRecord | null
): SelectedRuntimeCompatibilityRecord | null {
  if (candidate === null) return null;
  const parsed = selectedRuntimeCompatibilityRecordSchema.safeParse(candidate);
  if (!parsed.success) throw projectionFailure();
  return parsed.data;
}

function requireComponent(
  local: HostDeckLocalHealthSnapshot,
  name: "compatibility" | "runtime"
): HostDeckLocalComponentHealthSnapshot {
  const matches = local.components.filter((component) => component.component === name);
  const component = matches[0];
  if (matches.length !== 1 || component === undefined) throw projectionFailure();
  return component;
}

function requiredCapabilitiesAreAvailable(
  compatibility: SelectedRuntimeCompatibilityRecord["compatibility"]
): boolean {
  const states = new Map(
    compatibility.capabilities.map((capability) => [
      capability.name,
      capability.state
    ])
  );
  return requiredRuntimeCapabilities.every((name) => states.get(name) === "available");
}

function observedAfter(
  component: HostDeckLocalComponentHealthSnapshot,
  recordedAt: number
): boolean {
  return (
    component.checked_at !== null && timestamp(component.checked_at) >= recordedAt
  );
}

function hasExactReason(
  component: HostDeckLocalComponentHealthSnapshot,
  reason: HostDeckLocalComponentHealthSnapshot["reasons"][number]
): boolean {
  return component.reasons.length === 1 && component.reasons[0] === reason;
}

function hasOnlyReason(
  component: HostDeckLocalComponentHealthSnapshot,
  allowed: readonly HostDeckLocalComponentHealthSnapshot["reasons"][number][]
): boolean {
  return (
    component.reasons.length === 1 &&
    component.reasons[0] !== undefined &&
    allowed.includes(component.reasons[0])
  );
}

function timestamp(candidate: string): number {
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) throw projectionFailure();
  return parsed;
}

function project(
  candidate: SelectedHostCompatibilityStatus
): SelectedHostCompatibilityStatus {
  const parsed = selectedHostCompatibilityStatusSchema.safeParse(candidate);
  if (!parsed.success) throw projectionFailure();
  return deepFreeze(parsed.data);
}

function readExactFunction(
  candidate: unknown,
  key: "read"
): () => SelectedRuntimeCompatibilityRecord | null {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new TypeError("Runtime compatibility reader input is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const descriptor = descriptors[key];
  if (
    keys.length !== 1 ||
    keys[0] !== key ||
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    !descriptor.enumerable
  ) {
    throw new TypeError("Runtime compatibility reader input is invalid.");
  }
  return descriptor.value as () => SelectedRuntimeCompatibilityRecord | null;
}

function projectionFailure(): TypeError {
  return new TypeError("Runtime compatibility status projection is contradictory.");
}

function deepFreeze<T>(candidate: T): T {
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    !Object.isFrozen(candidate)
  ) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
