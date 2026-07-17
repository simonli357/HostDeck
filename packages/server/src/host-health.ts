import { isDeepStrictEqual } from "node:util";
import {
  isoTimestampSchema,
  isSelectedHostLocalHealthCauseValid,
  type RemoteIngressPublicState,
  remoteIngressPublicStateSchema,
  type SelectedHostLocalHealthCause,
  type SelectedHostLocalHealthComponent,
  type SelectedHostLocalHealthState,
  type SelectedHostRemoteObservationFailureCause,
  selectedHostAggregateLocalHealthState,
  selectedHostLocalHealthCauses,
  selectedHostLocalHealthComponents,
  selectedHostLocalHealthStates,
  selectedHostRemoteObservationFailureCauses
} from "@hostdeck/contracts";
import {
  type ErrorCode,
  remoteIngressUnavailableReasons
} from "@hostdeck/core";

export const hostDeckLocalHealthComponents = selectedHostLocalHealthComponents;
export type HostDeckLocalHealthComponent =
  SelectedHostLocalHealthComponent;

export const hostDeckLocalHealthStates = selectedHostLocalHealthStates;
export type HostDeckLocalHealthState =
  SelectedHostLocalHealthState;

export const hostDeckLocalHealthReasons = selectedHostLocalHealthCauses;
export type HostDeckLocalHealthReason =
  SelectedHostLocalHealthCause;
export type HostDeckReportedLocalHealthReason = Exclude<
  HostDeckLocalHealthReason,
  "not_observed"
>;

export const hostDeckRemoteHealthObservationFailureReasons =
  selectedHostRemoteObservationFailureCauses;
export type HostDeckRemoteHealthObservationFailureReason =
  SelectedHostRemoteObservationFailureCause;

export const hostDeckHostHealthErrorCodes = [
  "clock_invalid",
  "configuration_invalid",
  "generation_exhausted",
  "invalid_mutation_proof",
  "invalid_update",
  "mutation_not_ready",
  "mutation_state_changed",
  "source_conflict",
  "source_regression"
] as const;
export type HostDeckHostHealthErrorCode =
  (typeof hostDeckHostHealthErrorCodes)[number];

export class HostDeckHostHealthError extends Error {
  constructor(
    token: symbol,
    readonly code: HostDeckHostHealthErrorCode,
    readonly api_code: ErrorCode,
    readonly retryable: boolean
  ) {
    if (token !== healthErrorToken) {
      throw new TypeError("Invalid host-health error construction.");
    }
    super(healthErrorMessages[code]);
    this.name = "HostDeckHostHealthError";
    Object.freeze(this);
  }
}

export interface HostDeckLocalHealthObservation {
  readonly component: HostDeckLocalHealthComponent;
  readonly state: HostDeckLocalHealthState;
  readonly reasons: readonly HostDeckReportedLocalHealthReason[];
}

export interface UpdateHostDeckLocalHealthInput
  extends HostDeckLocalHealthObservation {
  readonly source_generation: number;
}

export interface UpdateHostDeckRemoteHealthInput {
  readonly source_generation: number;
  readonly state: RemoteIngressPublicState;
}

export interface FailHostDeckRemoteHealthInput {
  readonly source_generation: number;
  readonly reason: HostDeckRemoteHealthObservationFailureReason;
}

export interface CreateHostDeckHostHealthServiceInput {
  readonly now: () => Date;
}

export interface HostDeckLocalComponentHealthSnapshot {
  readonly component: HostDeckLocalHealthComponent;
  readonly state: HostDeckLocalHealthState;
  readonly source_generation: number;
  readonly checked_at: string | null;
  readonly reasons: readonly HostDeckLocalHealthReason[];
}

export interface HostDeckLocalHealthSnapshot {
  readonly generation: number;
  readonly state: HostDeckLocalHealthState;
  readonly readiness: "not_ready" | "ready";
  readonly mutation_admission: "closed" | "open";
  readonly updated_at: string;
  readonly components: readonly HostDeckLocalComponentHealthSnapshot[];
}

export interface HostDeckRemoteHealthSnapshot {
  readonly generation: number;
  readonly source_generation: number;
  readonly state_generation: number | null;
  readonly availability: "unknown" | "disabled" | "ready" | "unavailable";
  readonly reason:
    | "not_observed"
    | RemoteIngressPublicState["reason"];
  readonly external_origin: string | null;
  readonly laptop_action_required: boolean;
  readonly observed_at: string | null;
  readonly checked_at: string | null;
  readonly updated_at: string;
}

export interface HostDeckLocalMutationHealthProof {
  readonly generation: number;
}

export interface HostDeckHostHealthService {
  readonly updateLocal: (
    input: UpdateHostDeckLocalHealthInput
  ) => HostDeckLocalHealthSnapshot;
  readonly updateRemote: (
    input: UpdateHostDeckRemoteHealthInput
  ) => HostDeckRemoteHealthSnapshot;
  readonly failRemote: (
    input: FailHostDeckRemoteHealthInput
  ) => HostDeckRemoteHealthSnapshot;
  readonly localSnapshot: () => HostDeckLocalHealthSnapshot;
  readonly remoteSnapshot: () => HostDeckRemoteHealthSnapshot;
  readonly admitMutation: () => HostDeckLocalMutationHealthProof;
  readonly assertMutation: (
    proof: HostDeckLocalMutationHealthProof
  ) => HostDeckLocalHealthSnapshot;
}

interface ParsedLocalObservation {
  readonly component: HostDeckLocalHealthComponent;
  readonly state: HostDeckLocalHealthState;
  readonly reasons: readonly HostDeckReportedLocalHealthReason[];
  readonly sourceGeneration: number;
}

type RemoteObservationFingerprint =
  | Readonly<{
      readonly kind: "observed";
      readonly state: RemoteIngressPublicState;
    }>
  | Readonly<{
      readonly kind: "failed";
      readonly reason: HostDeckRemoteHealthObservationFailureReason;
    }>;

interface MutationProofState {
  readonly generation: number;
  readonly owner: symbol;
}

const acceptedServices = new WeakSet<object>();
const acceptedErrors = new WeakSet<object>();
const mutationProofStates = new WeakMap<object, MutationProofState>();
const healthErrorToken = Symbol("HostDeckHostHealthError");
const maximumGeneration = Number.MAX_SAFE_INTEGER;
const maximumReasonsPerObservation = 4;
const componentSet = new Set<string>(hostDeckLocalHealthComponents);
const stateSet = new Set<string>(hostDeckLocalHealthStates);
const reasonSet = new Set<string>(hostDeckLocalHealthReasons);
const remoteFailureReasonSet = new Set<string>(
  hostDeckRemoteHealthObservationFailureReasons
);
const remoteUnavailableReasonSet = new Set<string>(
  remoteIngressUnavailableReasons
);

const healthErrorMessages: Readonly<
  Record<HostDeckHostHealthErrorCode, string>
> = Object.freeze({
  clock_invalid: "Host health clock is invalid.",
  configuration_invalid: "Host health configuration is invalid.",
  generation_exhausted: "Host health generation capacity is exhausted.",
  invalid_mutation_proof: "Host health mutation proof is invalid.",
  invalid_update: "Host health update is invalid.",
  mutation_not_ready: "Host health does not permit mutations.",
  mutation_state_changed: "Host health changed after mutation admission.",
  source_conflict: "Host health source generation conflicts with current truth.",
  source_regression: "Host health source generation regressed."
});

export function createHostDeckHostHealthService(
  input: CreateHostDeckHostHealthServiceInput
): HostDeckHostHealthService {
  const values = readExactObject(input, ["now"], "configuration_invalid");
  if (typeof values.now !== "function") {
    throw healthError("configuration_invalid");
  }
  const initial = readWallClock(
    values.now as () => Date,
    null,
    "configuration_invalid"
  );
  const implementation = new DefaultHostDeckHostHealthService(
    values.now as () => Date,
    initial
  );
  const service: HostDeckHostHealthService = Object.freeze({
    updateLocal: (update: UpdateHostDeckLocalHealthInput) =>
      implementation.updateLocal(update),
    updateRemote: (update: UpdateHostDeckRemoteHealthInput) =>
      implementation.updateRemote(update),
    failRemote: (update: FailHostDeckRemoteHealthInput) =>
      implementation.failRemote(update),
    localSnapshot: () => implementation.localSnapshot(),
    remoteSnapshot: () => implementation.remoteSnapshot(),
    admitMutation: () => implementation.admitMutation(),
    assertMutation: (proof: HostDeckLocalMutationHealthProof) =>
      implementation.assertMutation(proof)
  });
  acceptedServices.add(service);
  return service;
}

export function assertHostDeckHostHealthService(
  candidate: unknown
): asserts candidate is HostDeckHostHealthService {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedServices.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "Host health service must be created by createHostDeckHostHealthService."
    );
  }
}

export function isHostDeckHostHealthError(
  candidate: unknown
): candidate is HostDeckHostHealthError {
  return (
    candidate instanceof HostDeckHostHealthError &&
    acceptedErrors.has(candidate)
  );
}

class DefaultHostDeckHostHealthService {
  private readonly owner = Symbol("HostDeckHostHealthServiceOwner");
  private readonly components = new Map<
    HostDeckLocalHealthComponent,
    HostDeckLocalComponentHealthSnapshot
  >();
  private local: HostDeckLocalHealthSnapshot;
  private remote: HostDeckRemoteHealthSnapshot;
  private lastWallTime: number;
  private remoteFingerprint: RemoteObservationFingerprint | null = null;
  private highestRemoteStateGeneration = 0;
  private highestRemoteState: RemoteIngressPublicState | null = null;

  constructor(
    private readonly now: () => Date,
    initial: Readonly<{ readonly milliseconds: number; readonly timestamp: string }>
  ) {
    this.lastWallTime = initial.milliseconds;
    for (const component of hostDeckLocalHealthComponents) {
      this.components.set(
        component,
        Object.freeze({
          component,
          state: "unknown" as const,
          source_generation: 0,
          checked_at: null,
          reasons: Object.freeze(["not_observed" as const])
        })
      );
    }
    this.local = this.buildLocalSnapshot(0, initial.timestamp);
    this.remote = Object.freeze({
      generation: 0,
      source_generation: 0,
      state_generation: null,
      availability: "unknown",
      reason: "not_observed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null,
      checked_at: null,
      updated_at: initial.timestamp
    });
  }

  updateLocal(input: UpdateHostDeckLocalHealthInput): HostDeckLocalHealthSnapshot {
    const parsed = parseLocalUpdate(input);
    const current = this.requireComponent(parsed.component);
    const ordering = compareSourceGeneration(
      parsed.sourceGeneration,
      current.source_generation
    );
    if (ordering === "regressed") throw healthError("source_regression");
    if (ordering === "exhausted") throw healthError("generation_exhausted");
    if (ordering === "equal") {
      if (
        current.state === parsed.state &&
        isDeepStrictEqual(current.reasons, parsed.reasons)
      ) {
        return this.local;
      }
      throw healthError("source_conflict");
    }
    const nextGeneration = incrementGeneration(this.local.generation);
    const clock = this.readClock();
    const nextComponent: HostDeckLocalComponentHealthSnapshot = Object.freeze({
      component: parsed.component,
      state: parsed.state,
      source_generation: parsed.sourceGeneration,
      checked_at: clock.timestamp,
      reasons: parsed.reasons
    });
    this.components.set(parsed.component, nextComponent);
    this.local = this.buildLocalSnapshot(nextGeneration, clock.timestamp);
    this.lastWallTime = clock.milliseconds;
    return this.local;
  }

  updateRemote(
    input: UpdateHostDeckRemoteHealthInput
  ): HostDeckRemoteHealthSnapshot {
    const values = readExactObject(
      input,
      ["source_generation", "state"],
      "invalid_update"
    );
    const sourceGeneration = requirePositiveSafeInteger(
      values.source_generation,
      "invalid_update"
    );
    const clonedState = clonePlainData(values.state, "invalid_update");
    const parsedState = remoteIngressPublicStateSchema.safeParse(clonedState);
    if (!parsedState.success) throw healthError("invalid_update");
    const state = deepFreeze(parsedState.data);
    const fingerprint: RemoteObservationFingerprint = Object.freeze({
      kind: "observed",
      state
    });
    return this.applyRemote(sourceGeneration, fingerprint);
  }

  failRemote(
    input: FailHostDeckRemoteHealthInput
  ): HostDeckRemoteHealthSnapshot {
    const values = readExactObject(
      input,
      ["reason", "source_generation"],
      "invalid_update"
    );
    const sourceGeneration = requirePositiveSafeInteger(
      values.source_generation,
      "invalid_update"
    );
    if (
      typeof values.reason !== "string" ||
      !remoteFailureReasonSet.has(values.reason)
    ) {
      throw healthError("invalid_update");
    }
    const fingerprint: RemoteObservationFingerprint = Object.freeze({
      kind: "failed",
      reason: values.reason as HostDeckRemoteHealthObservationFailureReason
    });
    return this.applyRemote(sourceGeneration, fingerprint);
  }

  localSnapshot(): HostDeckLocalHealthSnapshot {
    return this.local;
  }

  remoteSnapshot(): HostDeckRemoteHealthSnapshot {
    return this.remote;
  }

  admitMutation(): HostDeckLocalMutationHealthProof {
    if (this.local.mutation_admission !== "open") {
      throw this.mutationError("mutation_not_ready");
    }
    const proof: HostDeckLocalMutationHealthProof = Object.freeze({
      generation: this.local.generation
    });
    mutationProofStates.set(proof, {
      generation: this.local.generation,
      owner: this.owner
    });
    return proof;
  }

  assertMutation(
    proof: HostDeckLocalMutationHealthProof
  ): HostDeckLocalHealthSnapshot {
    const state = requireMutationProof(proof);
    if (state.owner !== this.owner) {
      throw healthError("invalid_mutation_proof");
    }
    if (
      this.local.mutation_admission !== "open" ||
      this.local.generation !== state.generation
    ) {
      throw this.mutationError("mutation_state_changed");
    }
    return this.local;
  }

  private applyRemote(
    sourceGeneration: number,
    fingerprint: RemoteObservationFingerprint
  ): HostDeckRemoteHealthSnapshot {
    const ordering = compareSourceGeneration(
      sourceGeneration,
      this.remote.source_generation
    );
    if (ordering === "regressed") throw healthError("source_regression");
    if (ordering === "exhausted") throw healthError("generation_exhausted");
    if (ordering === "equal") {
      if (
        this.remoteFingerprint !== null &&
        isDeepStrictEqual(this.remoteFingerprint, fingerprint)
      ) {
        return this.remote;
      }
      throw healthError("source_conflict");
    }
    if (
      fingerprint.kind === "observed" &&
      fingerprint.state.generation < this.highestRemoteStateGeneration
    ) {
      throw healthError("source_regression");
    }
    if (
      fingerprint.kind === "observed" &&
      fingerprint.state.generation === this.highestRemoteStateGeneration &&
      this.highestRemoteState !== null &&
      !isDeepStrictEqual(fingerprint.state, this.highestRemoteState)
    ) {
      throw healthError("source_conflict");
    }
    const nextGeneration = incrementGeneration(this.remote.generation);
    const clock = this.readClock();
    this.remote = fingerprint.kind === "observed"
      ? remoteSnapshotFromState(
          nextGeneration,
          sourceGeneration,
          fingerprint.state,
          clock.timestamp
        )
      : Object.freeze({
          generation: nextGeneration,
          source_generation: sourceGeneration,
          state_generation: null,
          availability: "unavailable",
          reason: fingerprint.reason,
          external_origin: null,
          laptop_action_required: true,
          observed_at: null,
          checked_at: clock.timestamp,
          updated_at: clock.timestamp
        });
    this.remoteFingerprint = fingerprint;
    if (fingerprint.kind === "observed") {
      this.highestRemoteStateGeneration = fingerprint.state.generation;
      this.highestRemoteState = fingerprint.state;
    }
    this.lastWallTime = clock.milliseconds;
    return this.remote;
  }

  private requireComponent(
    component: HostDeckLocalHealthComponent
  ): HostDeckLocalComponentHealthSnapshot {
    const current = this.components.get(component);
    if (current === undefined) throw healthError("configuration_invalid");
    return current;
  }

  private readClock(): Readonly<{
    readonly milliseconds: number;
    readonly timestamp: string;
  }> {
    return readWallClock(this.now, this.lastWallTime, "clock_invalid");
  }

  private buildLocalSnapshot(
    generation: number,
    updatedAt: string
  ): HostDeckLocalHealthSnapshot {
    const components = Object.freeze(
      hostDeckLocalHealthComponents.map((component) =>
        this.requireComponent(component)
      )
    );
    const state = selectedHostAggregateLocalHealthState(
      components.map((component) => component.state)
    );
    const ready = state === "ready";
    return Object.freeze({
      generation,
      state,
      readiness: ready ? "ready" : "not_ready",
      mutation_admission: ready ? "open" : "closed",
      updated_at: updatedAt,
      components
    });
  }

  private mutationError(
    code: "mutation_not_ready" | "mutation_state_changed"
  ): HostDeckHostHealthError {
    const apiCode = mutationApiCode(this.local);
    return healthError(code, apiCode, apiCode !== "incompatible_runtime");
  }
}

function parseLocalUpdate(input: unknown): ParsedLocalObservation {
  const values = readExactObject(
    input,
    ["component", "reasons", "source_generation", "state"],
    "invalid_update"
  );
  if (
    typeof values.component !== "string" ||
    !componentSet.has(values.component) ||
    typeof values.state !== "string" ||
    !stateSet.has(values.state)
  ) {
    throw healthError("invalid_update");
  }
  const component = values.component as HostDeckLocalHealthComponent;
  const state = values.state as HostDeckLocalHealthState;
  const reasons = parseReasons(values.reasons);
  const sourceGeneration = requirePositiveSafeInteger(
    values.source_generation,
    "invalid_update"
  );
  if (state === "ready") {
    if (reasons.length !== 0) throw healthError("invalid_update");
  } else if (reasons.length === 0) {
    throw healthError("invalid_update");
  }
  for (const reason of reasons) {
    if (!isSelectedHostLocalHealthCauseValid(component, state, reason)) {
      throw healthError("invalid_update");
    }
  }
  return Object.freeze({ component, state, reasons, sourceGeneration });
}

function parseReasons(
  candidate: unknown
): readonly HostDeckReportedLocalHealthReason[] {
  const values = readExactArray(candidate, "invalid_update");
  if (values.length > maximumReasonsPerObservation) {
    throw healthError("invalid_update");
  }
  const parsed: HostDeckReportedLocalHealthReason[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      !reasonSet.has(value) ||
      value === "not_observed" ||
      seen.has(value)
    ) {
      throw healthError("invalid_update");
    }
    seen.add(value);
    parsed.push(value as HostDeckReportedLocalHealthReason);
  }
  parsed.sort(
    (left, right) =>
      hostDeckLocalHealthReasons.indexOf(left) -
      hostDeckLocalHealthReasons.indexOf(right)
  );
  return Object.freeze(parsed);
}

function remoteSnapshotFromState(
  generation: number,
  sourceGeneration: number,
  state: RemoteIngressPublicState,
  checkedAt: string
): HostDeckRemoteHealthSnapshot {
  if (
    state.reason !== null &&
    state.reason !== "remote_disabled" &&
    !remoteUnavailableReasonSet.has(state.reason)
  ) {
    throw healthError("invalid_update");
  }
  if (
    state.observed_at !== null &&
    Date.parse(state.observed_at) > Date.parse(checkedAt)
  ) {
    throw healthError("invalid_update");
  }
  return Object.freeze({
    generation,
    source_generation: sourceGeneration,
    state_generation: state.generation,
    availability: state.availability,
    reason: state.reason,
    external_origin: state.external_origin,
    laptop_action_required: state.laptop_action_required,
    observed_at: state.observed_at,
    checked_at: checkedAt,
    updated_at: checkedAt
  });
}

function compareSourceGeneration(
  candidate: number,
  current: number
): "equal" | "exhausted" | "newer" | "regressed" {
  if (candidate === current) return "equal";
  if (current === maximumGeneration) return "exhausted";
  return candidate > current ? "newer" : "regressed";
}

function incrementGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= maximumGeneration) {
    throw healthError("generation_exhausted");
  }
  return current + 1;
}

function mutationApiCode(snapshot: HostDeckLocalHealthSnapshot): ErrorCode {
  const storage = snapshot.components.find(
    (component) => component.component === "storage"
  );
  if (storage?.state !== "ready") return "storage_error";
  const compatibility = snapshot.components.find(
    (component) => component.component === "compatibility"
  );
  if (compatibility?.reasons.includes("runtime_incompatible")) {
    return "incompatible_runtime";
  }
  return "runtime_unavailable";
}

function requireMutationProof(
  proof: unknown
): MutationProofState {
  if (
    proof === null ||
    typeof proof !== "object" ||
    !Object.isFrozen(proof)
  ) {
    throw healthError("invalid_mutation_proof");
  }
  const values = readExactObject(
    proof,
    ["generation"],
    "invalid_mutation_proof"
  );
  const state = mutationProofStates.get(proof);
  if (
    state === undefined ||
    values.generation !== state.generation ||
    !Number.isSafeInteger(values.generation) ||
    (values.generation as number) < 1
  ) {
    throw healthError("invalid_mutation_proof");
  }
  return state;
}

function readWallClock(
  now: () => Date,
  previous: number | null,
  errorCode: "clock_invalid" | "configuration_invalid"
): Readonly<{ readonly milliseconds: number; readonly timestamp: string }> {
  try {
    const candidate = Reflect.apply(now, undefined, []);
    if (!(candidate instanceof Date)) throw new TypeError();
    const milliseconds = Date.prototype.getTime.call(candidate);
    if (!Number.isFinite(milliseconds) || (previous !== null && milliseconds < previous)) {
      throw new TypeError();
    }
    const timestamp = new Date(milliseconds).toISOString();
    if (!isoTimestampSchema.safeParse(timestamp).success) throw new TypeError();
    return Object.freeze({ milliseconds, timestamp });
  } catch {
    throw healthError(errorCode);
  }
}

function readExactObject(
  candidate: unknown,
  expectedKeys: readonly string[],
  code: "configuration_invalid" | "invalid_mutation_proof" | "invalid_update"
): Readonly<Record<string, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string") ||
      expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return values;
  } catch (error) {
    if (isHostDeckHostHealthError(error)) throw error;
    throw healthError(code);
  }
}

function readExactArray(
  candidate: unknown,
  code: "invalid_update"
): readonly unknown[] {
  try {
    if (!Array.isArray(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as
      Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      Reflect.ownKeys(descriptors).length !== (length as number) + 1
    ) {
      throw new TypeError();
    }
    const values: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      values.push(descriptor.value);
    }
    return values;
  } catch (error) {
    if (isHostDeckHostHealthError(error)) throw error;
    throw healthError(code);
  }
}

function clonePlainData(candidate: unknown, code: "invalid_update"): unknown {
  const seen = new WeakSet<object>();
  const clone = (value: unknown, depth: number): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value !== "object" || depth > 6 || seen.has(value)) {
      throw new TypeError();
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = readPlainArray(value);
        if (items.length > 32) throw new TypeError();
        return Object.freeze(items.map((item) => clone(item, depth + 1)));
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > 16 || keys.some((key) => typeof key !== "string")) {
        throw new TypeError();
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) {
          throw new TypeError();
        }
        result[key] = clone(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(value);
    }
  };
  try {
    return clone(candidate, 0);
  } catch {
    throw healthError(code);
  }
}

function readPlainArray(candidate: readonly unknown[]): readonly unknown[] {
  const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as
    Record<string, PropertyDescriptor>;
  const length = descriptors.length?.value;
  if (
    Object.getPrototypeOf(candidate) !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) {
    throw new TypeError();
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError();
    }
    values.push(descriptor.value);
  }
  return values;
}

function requirePositiveSafeInteger(
  candidate: unknown,
  code: "invalid_update"
): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw healthError(code);
  }
  return candidate as number;
}

function healthError(
  code: HostDeckHostHealthErrorCode,
  apiCode: ErrorCode = apiCodeForHealthError(code),
  retryable: boolean = retryableHealthError(code)
): HostDeckHostHealthError {
  const error = new HostDeckHostHealthError(
    healthErrorToken,
    code,
    apiCode,
    retryable
  );
  acceptedErrors.add(error);
  return error;
}

function apiCodeForHealthError(code: HostDeckHostHealthErrorCode): ErrorCode {
  switch (code) {
    case "configuration_invalid":
      return "invalid_config";
    case "invalid_update":
      return "validation_error";
    case "source_conflict":
    case "source_regression":
    case "mutation_state_changed":
      return "operation_conflict";
    case "mutation_not_ready":
      return "runtime_unavailable";
    case "clock_invalid":
    case "generation_exhausted":
    case "invalid_mutation_proof":
      return "internal_error";
  }
}

function retryableHealthError(code: HostDeckHostHealthErrorCode): boolean {
  return code === "mutation_not_ready" || code === "mutation_state_changed";
}

function deepFreeze<T>(candidate: T): T {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
