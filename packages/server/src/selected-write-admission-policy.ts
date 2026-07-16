import { createHash } from "node:crypto";
import {
  assertResolvedResourceBudget,
  clientOperationIdSchema,
  type ResourceBudget,
  resourceBudgetDefinitions,
  type SelectedAuditActor,
  type SelectedAuditTarget,
  selectedAuditActorSchema,
  selectedAuditTargetSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import { readExactDataObject } from "./selected-write-gate-contracts.js";

export type HostDeckSelectedWriteAdmissionErrorReason =
  | "capacity_reached"
  | "clock_invalid"
  | "configuration_invalid"
  | "contract_invalid"
  | "device_limit"
  | "global_limit"
  | "input_invalid"
  | "operation_conflict"
  | "rate_limit"
  | "request_aborted"
  | "target_limit";

export class HostDeckSelectedWriteAdmissionError extends Error {
  constructor(
    token: symbol,
    readonly reason: HostDeckSelectedWriteAdmissionErrorReason,
    readonly api_code: ErrorCode,
    readonly retry_safe: boolean
  ) {
    if (token !== admissionErrorToken) throw new TypeError("Invalid admission error construction.");
    super(admissionErrorMessages[reason]);
    this.name = "HostDeckSelectedWriteAdmissionError";
    Object.freeze(this);
  }
}

export interface BeginHostDeckSelectedWriteAdmissionInput {
  readonly operation_id: string;
  readonly actor: SelectedAuditActor;
  readonly route_id: string;
  readonly intent: unknown;
  readonly signal: AbortSignal;
}

export interface HostDeckSelectedWriteAdmissionOwner<T> {
  readonly state: "owner";
  readonly bindTarget: (target: SelectedAuditTarget) => void;
  readonly complete: (value: T) => T;
  readonly fail: (error: Error) => never;
  readonly abandon: (error: Error) => never;
}

export interface HostDeckSelectedWriteAdmissionReplay<T> {
  readonly state: "replay";
  readonly replay: () => Promise<T>;
}

export type HostDeckSelectedWriteAdmissionDecision<T> =
  | HostDeckSelectedWriteAdmissionOwner<T>
  | HostDeckSelectedWriteAdmissionReplay<T>;

export interface HostDeckSelectedWriteAdmissionSnapshot {
  readonly attempts: number;
  readonly owner_claims: number;
  readonly in_flight_replays: number;
  readonly terminal_replays: number;
  readonly operation_conflicts: number;
  readonly rate_rejections: number;
  readonly device_rejections: number;
  readonly target_rejections: number;
  readonly global_rejections: number;
  readonly capacity_rejections: number;
  readonly value_settlements: number;
  readonly error_settlements: number;
  readonly abandoned_owners: number;
  readonly replay_aborts: number;
  readonly contract_failures: number;
  readonly clock_failures: number;
  readonly active_owners: number;
  readonly active_targets: number;
  readonly active_waiters: number;
  readonly tracked_operations: number;
  readonly tracked_rate_buckets: number;
  readonly peak_active_owners: number;
  readonly peak_active_targets: number;
  readonly peak_active_waiters: number;
  readonly peak_tracked_keys: number;
}

export interface HostDeckSelectedWriteAdmissionPolicy {
  readonly begin: <T>(
    input: BeginHostDeckSelectedWriteAdmissionInput
  ) => HostDeckSelectedWriteAdmissionDecision<T>;
  readonly snapshot: () => HostDeckSelectedWriteAdmissionSnapshot;
}

export interface CreateHostDeckSelectedWriteAdmissionPolicyInput {
  readonly resourceBudget: ResourceBudget;
  readonly now: () => number;
}

interface ParsedAdmissionOptions {
  readonly budget: ResourceBudget;
  readonly now: () => number;
  readonly initialNow: number;
}

interface ParsedAdmissionInput {
  readonly operationId: string;
  readonly actorKey: string;
  readonly fingerprint: string;
  readonly signal: AbortSignal;
}

interface RateBucket {
  count: number;
  lastSeenAt: number;
  windowStartedAt: number;
}

interface AdmissionWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

type AdmissionSettlement =
  | Readonly<{ readonly type: "value"; readonly value: unknown }>
  | Readonly<{ readonly type: "error"; readonly error: Error }>;

interface AdmissionEntry {
  readonly actorKey: string;
  readonly fingerprint: string;
  readonly waiters: Set<AdmissionWaiter>;
  targetKey: string | null;
  terminalAt: number | null;
  settlement: AdmissionSettlement | null;
}

interface MutableAdmissionCounters {
  attempts: number;
  ownerClaims: number;
  inFlightReplays: number;
  terminalReplays: number;
  operationConflicts: number;
  rateRejections: number;
  deviceRejections: number;
  targetRejections: number;
  globalRejections: number;
  capacityRejections: number;
  valueSettlements: number;
  errorSettlements: number;
  abandonedOwners: number;
  replayAborts: number;
  contractFailures: number;
  clockFailures: number;
  peakActiveOwners: number;
  peakActiveTargets: number;
  peakActiveWaiters: number;
  peakTrackedKeys: number;
}

interface CanonicalLimits {
  readonly maximumBytes: number;
  readonly maximumNodes: number;
  readonly maximumDepth: number;
  readonly maximumArrayItems: number;
  readonly maximumObjectFields: number;
  readonly maximumKeyBytes: number;
}

interface CanonicalState {
  bytes: number;
  nodes: number;
  readonly seen: WeakSet<object>;
}

interface CanonicalArrayData {
  readonly descriptors: PropertyDescriptorMap;
  readonly length: number;
}

const acceptedAdmissionPolicies = new WeakSet<object>();
const acceptedAdmissionErrors = new WeakSet<object>();
const admissionErrorToken = Symbol("HostDeckSelectedWriteAdmissionError");
const admissionErrorMessages: Record<
  HostDeckSelectedWriteAdmissionErrorReason,
  string
> = Object.freeze({
  capacity_reached: "Selected mutation admission capacity is exhausted.",
  clock_invalid: "Selected mutation admission clock is invalid.",
  configuration_invalid: "Selected mutation admission configuration is invalid.",
  contract_invalid: "Selected mutation admission contract is invalid.",
  device_limit: "Selected mutation device concurrency is exhausted.",
  global_limit: "Selected mutation global concurrency is exhausted.",
  input_invalid: "Selected mutation admission input is invalid.",
  operation_conflict: "Selected mutation operation conflicts with retained state.",
  rate_limit: "Selected mutation request rate is exhausted.",
  request_aborted: "Selected mutation replay request was aborted.",
  target_limit: "Selected mutation target concurrency is exhausted."
});
const routeIdPattern = /^[a-z][a-z0-9_]{0,119}$/u;
const maximumCounter = Number.MAX_SAFE_INTEGER;

export function createHostDeckSelectedWriteAdmissionPolicy(
  input: CreateHostDeckSelectedWriteAdmissionPolicyInput
): HostDeckSelectedWriteAdmissionPolicy {
  const implementation = new DefaultHostDeckSelectedWriteAdmissionPolicy(
    parseAdmissionOptions(input)
  );
  const policy: HostDeckSelectedWriteAdmissionPolicy = Object.freeze({
    begin: <T>(execution: BeginHostDeckSelectedWriteAdmissionInput) =>
      implementation.begin<T>(execution),
    snapshot: () => implementation.snapshot()
  });
  acceptedAdmissionPolicies.add(policy);
  return policy;
}

export function assertHostDeckSelectedWriteAdmissionPolicy(
  candidate: unknown
): asserts candidate is HostDeckSelectedWriteAdmissionPolicy {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedAdmissionPolicies.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck selected-write admission policy must be created by its factory."
    );
  }
}

export function isHostDeckSelectedWriteAdmissionError(
  candidate: unknown
): candidate is HostDeckSelectedWriteAdmissionError {
  return (
    candidate instanceof HostDeckSelectedWriteAdmissionError &&
    acceptedAdmissionErrors.has(candidate)
  );
}

class DefaultHostDeckSelectedWriteAdmissionPolicy {
  private readonly operations = new Map<string, AdmissionEntry>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly activeActors = new Map<string, number>();
  private readonly activeTargets = new Map<string, number>();
  private readonly limits: CanonicalLimits;
  private activeGlobal = 0;
  private activeTargetClaims = 0;
  private lastNow: number;
  private readonly counters: MutableAdmissionCounters = {
    attempts: 0,
    ownerClaims: 0,
    inFlightReplays: 0,
    terminalReplays: 0,
    operationConflicts: 0,
    rateRejections: 0,
    deviceRejections: 0,
    targetRejections: 0,
    globalRejections: 0,
    capacityRejections: 0,
    valueSettlements: 0,
    errorSettlements: 0,
    abandonedOwners: 0,
    replayAborts: 0,
    contractFailures: 0,
    clockFailures: 0,
    peakActiveOwners: 0,
    peakActiveTargets: 0,
    peakActiveWaiters: 0,
    peakTrackedKeys: 0
  };

  constructor(private readonly options: ParsedAdmissionOptions) {
    this.lastNow = options.initialNow;
    this.limits = canonicalLimits(options.budget);
  }

  begin<T>(
    input: BeginHostDeckSelectedWriteAdmissionInput
  ): HostDeckSelectedWriteAdmissionDecision<T> {
    increment(this.counters, "attempts");
    let parsed: ParsedAdmissionInput;
    try {
      parsed = parseAdmissionInput(input, this.limits);
    } catch {
      increment(this.counters, "contractFailures");
      throw admissionError("input_invalid", "validation_error", true);
    }
    const now = this.readNow();
    if (parsed.signal.aborted) {
      throw admissionError("request_aborted", "operation_timeout", false);
    }
    this.prune(now);
    this.chargeRate(parsed.actorKey, now);

    const existing = this.operations.get(parsed.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== parsed.fingerprint) {
        increment(this.counters, "operationConflicts");
        throw admissionError("operation_conflict", "operation_conflict", false);
      }
      if (existing.settlement === null) {
        increment(this.counters, "inFlightReplays");
      } else {
        increment(this.counters, "terminalReplays");
      }
      return this.createReplayDecision<T>(existing, parsed.signal);
    }

    if (this.trackedKeys() >= this.options.budget.admission_max_tracked_keys) {
      increment(this.counters, "capacityRejections");
      throw admissionError("capacity_reached", "service_overloaded", true);
    }
    const actorCount = this.activeActors.get(parsed.actorKey) ?? 0;
    if (actorCount >= this.options.budget.mutation_max_in_flight_per_device) {
      increment(this.counters, "deviceRejections");
      throw admissionError("device_limit", "service_overloaded", true);
    }
    if (this.activeGlobal >= this.options.budget.mutation_max_in_flight_global) {
      increment(this.counters, "globalRejections");
      throw admissionError("global_limit", "service_overloaded", true);
    }

    const entry: AdmissionEntry = {
      actorKey: parsed.actorKey,
      fingerprint: parsed.fingerprint,
      waiters: new Set(),
      targetKey: null,
      terminalAt: null,
      settlement: null
    };
    this.operations.set(parsed.operationId, entry);
    this.activeActors.set(parsed.actorKey, actorCount + 1);
    this.activeGlobal += 1;
    increment(this.counters, "ownerClaims");
    this.updatePeaks();
    return this.createOwnerDecision<T>(parsed.operationId, entry);
  }

  snapshot(): HostDeckSelectedWriteAdmissionSnapshot {
    return Object.freeze({
      attempts: this.counters.attempts,
      owner_claims: this.counters.ownerClaims,
      in_flight_replays: this.counters.inFlightReplays,
      terminal_replays: this.counters.terminalReplays,
      operation_conflicts: this.counters.operationConflicts,
      rate_rejections: this.counters.rateRejections,
      device_rejections: this.counters.deviceRejections,
      target_rejections: this.counters.targetRejections,
      global_rejections: this.counters.globalRejections,
      capacity_rejections: this.counters.capacityRejections,
      value_settlements: this.counters.valueSettlements,
      error_settlements: this.counters.errorSettlements,
      abandoned_owners: this.counters.abandonedOwners,
      replay_aborts: this.counters.replayAborts,
      contract_failures: this.counters.contractFailures,
      clock_failures: this.counters.clockFailures,
      active_owners: this.activeGlobal,
      active_targets: this.activeTargetClaims,
      active_waiters: this.activeWaiterCount(),
      tracked_operations: this.operations.size,
      tracked_rate_buckets: this.rateBuckets.size,
      peak_active_owners: this.counters.peakActiveOwners,
      peak_active_targets: this.counters.peakActiveTargets,
      peak_active_waiters: this.counters.peakActiveWaiters,
      peak_tracked_keys: this.counters.peakTrackedKeys
    });
  }

  private createOwnerDecision<T>(
    operationId: string,
    entry: AdmissionEntry
  ): HostDeckSelectedWriteAdmissionOwner<T> {
    let open = true;
    const requireOpen = (): void => {
      if (!open || entry.settlement !== null) {
        increment(this.counters, "contractFailures");
        throw admissionError("contract_invalid", "internal_error", false);
      }
    };
    return Object.freeze({
      state: "owner" as const,
      bindTarget: (target: SelectedAuditTarget): void => {
        requireOpen();
        if (entry.targetKey !== null) {
          increment(this.counters, "contractFailures");
          const error = admissionError("contract_invalid", "internal_error", false);
          open = false;
          this.retainError(operationId, entry, error);
        }
        let targetKey: string;
        try {
          const safeTarget = cloneCanonicalData(
            target,
            this.limits
          );
          const parsedTarget = selectedAuditTargetSchema.parse(safeTarget);
          targetKey = canonicalDigest(parsedTarget, this.limits);
        } catch {
          increment(this.counters, "contractFailures");
          const error = admissionError("contract_invalid", "internal_error", false);
          open = false;
          this.abandonEntry(operationId, entry, error);
        }
        const count = this.activeTargets.get(targetKey) ?? 0;
        if (count >= this.options.budget.mutation_max_in_flight_per_target) {
          increment(this.counters, "targetRejections");
          const error = admissionError("target_limit", "service_overloaded", true);
          open = false;
          this.abandonEntry(operationId, entry, error);
        }
        entry.targetKey = targetKey;
        this.activeTargets.set(targetKey, count + 1);
        this.activeTargetClaims += 1;
        this.updatePeaks();
      },
      complete: (value: T): T => {
        requireOpen();
        if (entry.targetKey === null) {
          increment(this.counters, "contractFailures");
          const error = admissionError("contract_invalid", "internal_error", false);
          open = false;
          this.retainError(operationId, entry, error);
        }
        let replayValue: unknown;
        try {
          replayValue = cloneCanonicalData(value, this.limits);
        } catch {
          increment(this.counters, "contractFailures");
          const error = admissionError("contract_invalid", "internal_error", false);
          open = false;
          this.retainError(operationId, entry, error);
        }
        open = false;
        this.retainSettlement(operationId, entry, {
          type: "value",
          value: replayValue
        });
        increment(this.counters, "valueSettlements");
        return replayValue as T;
      },
      fail: (error: Error): never => {
        requireOpen();
        if (entry.targetKey === null) {
          increment(this.counters, "contractFailures");
          const contractError = admissionError("contract_invalid", "internal_error", false);
          open = false;
          this.retainError(operationId, entry, contractError);
        }
        const retained = this.requireRetainableError(error);
        open = false;
        this.retainError(operationId, entry, retained);
      },
      abandon: (error: Error): never => {
        requireOpen();
        const retained = this.requireRetainableError(error);
        open = false;
        this.abandonEntry(operationId, entry, retained);
      }
    });
  }

  private createReplayDecision<T>(
    entry: AdmissionEntry,
    signal: AbortSignal
  ): HostDeckSelectedWriteAdmissionReplay<T> {
    let used = false;
    return Object.freeze({
      state: "replay" as const,
      replay: async (): Promise<T> => {
        if (used) {
          increment(this.counters, "contractFailures");
          throw admissionError("contract_invalid", "internal_error", false);
        }
        used = true;
        if (signal.aborted) {
          increment(this.counters, "replayAborts");
          throw admissionError("request_aborted", "operation_timeout", false);
        }
        if (entry.settlement !== null) {
          return settlementValue<T>(entry.settlement);
        }
        return new Promise<T>((resolve, reject) => {
          const waiter: AdmissionWaiter = {
            signal,
            resolve: resolve as (value: unknown) => void,
            reject,
            onAbort: () => {
              if (!entry.waiters.delete(waiter)) return;
              signal.removeEventListener("abort", waiter.onAbort);
              increment(this.counters, "replayAborts");
              reject(admissionError("request_aborted", "operation_timeout", false));
            }
          };
          entry.waiters.add(waiter);
          signal.addEventListener("abort", waiter.onAbort, { once: true });
          this.updatePeaks();
        });
      }
    });
  }

  private chargeRate(actorKey: string, now: number): void {
    let bucket = this.rateBuckets.get(actorKey);
    if (bucket === undefined) {
      if (this.trackedKeys() >= this.options.budget.admission_max_tracked_keys) {
        increment(this.counters, "capacityRejections");
        throw admissionError("capacity_reached", "service_overloaded", true);
      }
      bucket = { count: 0, lastSeenAt: now, windowStartedAt: now };
      this.rateBuckets.set(actorKey, bucket);
      this.updatePeaks();
    } else if (now - bucket.windowStartedAt >= this.options.budget.mutation_window_ms) {
      bucket.count = 0;
      bucket.windowStartedAt = now;
    }
    bucket.lastSeenAt = now;
    if (bucket.count >= this.options.budget.mutation_max_requests_per_device) {
      increment(this.counters, "rateRejections");
      throw admissionError("rate_limit", "rate_limited", true);
    }
    bucket.count += 1;
  }

  private retainError(
    operationId: string,
    entry: AdmissionEntry,
    error: Error
  ): never {
    this.retainSettlement(operationId, entry, { type: "error", error });
    increment(this.counters, "errorSettlements");
    throw error;
  }

  private retainSettlement(
    operationId: string,
    entry: AdmissionEntry,
    settlement: AdmissionSettlement
  ): void {
    if (this.operations.get(operationId) !== entry || entry.settlement !== null) {
      increment(this.counters, "contractFailures");
      throw admissionError("contract_invalid", "internal_error", false);
    }
    let retainedSettlement = settlement;
    let terminalAt: number;
    let clockError: Error | null = null;
    try {
      terminalAt = this.readNow();
    } catch (error) {
      clockError = error as Error;
      terminalAt = this.lastNow;
      retainedSettlement = Object.freeze({ type: "error" as const, error: clockError });
    }
    entry.settlement = Object.freeze(retainedSettlement);
    entry.terminalAt = terminalAt;
    this.releaseOwner(entry);
    this.settleWaiters(entry);
    if (clockError !== null) {
      increment(this.counters, "errorSettlements");
      throw clockError;
    }
  }

  private abandonEntry(
    operationId: string,
    entry: AdmissionEntry,
    error: Error
  ): never {
    if (this.operations.get(operationId) !== entry || entry.settlement !== null) {
      increment(this.counters, "contractFailures");
      throw admissionError("contract_invalid", "internal_error", false);
    }
    entry.settlement = Object.freeze({ type: "error", error });
    this.releaseOwner(entry);
    this.operations.delete(operationId);
    this.settleWaiters(entry);
    increment(this.counters, "abandonedOwners");
    throw error;
  }

  private requireRetainableError(error: Error): Error {
    if (!(error instanceof Error) || !Object.isFrozen(error)) {
      increment(this.counters, "contractFailures");
      return admissionError("contract_invalid", "internal_error", false);
    }
    return error;
  }

  private releaseOwner(entry: AdmissionEntry): void {
    const actorCount = this.activeActors.get(entry.actorKey);
    if (actorCount === undefined || actorCount < 1 || this.activeGlobal < 1) {
      increment(this.counters, "contractFailures");
      throw admissionError("contract_invalid", "internal_error", false);
    }
    const targetKey = entry.targetKey;
    let targetCount = 0;
    if (targetKey !== null) {
      const currentTargetCount = this.activeTargets.get(targetKey);
      if (
        currentTargetCount === undefined ||
        currentTargetCount < 1 ||
        this.activeTargetClaims < 1
      ) {
        increment(this.counters, "contractFailures");
        throw admissionError("contract_invalid", "internal_error", false);
      }
      targetCount = currentTargetCount;
    }
    if (actorCount === 1) this.activeActors.delete(entry.actorKey);
    else this.activeActors.set(entry.actorKey, actorCount - 1);
    this.activeGlobal -= 1;
    if (targetKey !== null) {
      if (targetCount === 1) this.activeTargets.delete(targetKey);
      else this.activeTargets.set(targetKey, targetCount - 1);
      this.activeTargetClaims -= 1;
    }
  }

  private settleWaiters(entry: AdmissionEntry): void {
    const settlement = entry.settlement;
    if (settlement === null) {
      increment(this.counters, "contractFailures");
      throw admissionError("contract_invalid", "internal_error", false);
    }
    for (const waiter of entry.waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (settlement.type === "value") waiter.resolve(settlement.value);
      else waiter.reject(settlement.error);
    }
    entry.waiters.clear();
  }

  private prune(now: number): void {
    const ttl = this.options.budget.admission_state_ttl_ms;
    for (const [operationId, entry] of this.operations) {
      if (
        entry.settlement !== null &&
        entry.terminalAt !== null &&
        now - entry.terminalAt >= ttl
      ) {
        if (entry.waiters.size !== 0) {
          increment(this.counters, "contractFailures");
          throw admissionError("contract_invalid", "internal_error", false);
        }
        this.operations.delete(operationId);
      }
    }
    for (const [actorKey, bucket] of this.rateBuckets) {
      if (
        !this.activeActors.has(actorKey) &&
        now - bucket.lastSeenAt >= ttl
      ) {
        this.rateBuckets.delete(actorKey);
      }
    }
  }

  private readNow(): number {
    let now: unknown;
    try {
      now = Reflect.apply(this.options.now, undefined, []);
    } catch {
      increment(this.counters, "clockFailures");
      throw admissionError("clock_invalid", "internal_error", false);
    }
    if (typeof now !== "number" || !Number.isFinite(now) || now < this.lastNow) {
      increment(this.counters, "clockFailures");
      throw admissionError("clock_invalid", "internal_error", false);
    }
    this.lastNow = now;
    return now;
  }

  private trackedKeys(): number {
    return this.operations.size + this.rateBuckets.size;
  }

  private activeWaiterCount(): number {
    let count = 0;
    for (const entry of this.operations.values()) count += entry.waiters.size;
    return count;
  }

  private updatePeaks(): void {
    this.counters.peakActiveOwners = Math.max(
      this.counters.peakActiveOwners,
      this.activeGlobal
    );
    this.counters.peakActiveTargets = Math.max(
      this.counters.peakActiveTargets,
      this.activeTargetClaims
    );
    this.counters.peakActiveWaiters = Math.max(
      this.counters.peakActiveWaiters,
      this.activeWaiterCount()
    );
    this.counters.peakTrackedKeys = Math.max(
      this.counters.peakTrackedKeys,
      this.trackedKeys()
    );
  }

}

function canonicalLimits(budget: ResourceBudget): CanonicalLimits {
  return Object.freeze({
    maximumBytes: Math.max(
      budget.protocol_max_frame_bytes,
      budget.cli_response_max_bytes
    ),
    maximumNodes: 1_024,
    maximumDepth: 10,
    maximumArrayItems: 512,
    maximumObjectFields: 128,
    maximumKeyBytes: 256
  });
}

function parseAdmissionOptions(input: unknown): ParsedAdmissionOptions {
  try {
    const values = readExactDataObject(
      input,
      ["now", "resourceBudget"],
      "HostDeck selected-write admission options are invalid."
    );
    assertDescriptorSafeResourceBudget(values.resourceBudget);
    assertResolvedResourceBudget(values.resourceBudget);
    if (typeof values.now !== "function") throw new TypeError();
    const initialNow = Reflect.apply(values.now, undefined, []) as unknown;
    if (typeof initialNow !== "number" || !Number.isFinite(initialNow) || initialNow < 0) {
      throw new TypeError();
    }
    return Object.freeze({
      budget: values.resourceBudget,
      now: values.now as () => number,
      initialNow
    });
  } catch {
    throw admissionError("configuration_invalid", "internal_error", false);
  }
}

function parseAdmissionInput(
  input: unknown,
  limits: CanonicalLimits
): ParsedAdmissionInput {
  const values = readExactDataObject(
    input,
    ["actor", "intent", "operation_id", "route_id", "signal"],
    "HostDeck selected-write admission input is invalid."
  );
  const operationId = clientOperationIdSchema.parse(values.operation_id);
  if (
    typeof values.route_id !== "string" ||
    !routeIdPattern.test(values.route_id) ||
    !(values.signal instanceof AbortSignal)
  ) {
    throw new TypeError();
  }
  const safeActor = cloneCanonicalData(values.actor, limits);
  const actor = selectedAuditActorSchema.parse(safeActor);
  const actorKey = canonicalDigest(actor, limits);
  const fingerprint = canonicalDigest(
    Object.freeze({
      actor,
      route_id: values.route_id,
      intent: values.intent
    }),
    limits
  );
  return Object.freeze({
    operationId,
    actorKey,
    fingerprint,
    signal: values.signal
  });
}

function assertDescriptorSafeResourceBudget(candidate: unknown): void {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== resourceBudgetDefinitions.length ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw new TypeError();
  }
  for (const definition of resourceBudgetDefinitions) {
    const descriptor = descriptors[definition.key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError();
    }
  }
}

function canonicalDigest(candidate: unknown, limits: CanonicalLimits): string {
  const hash = createHash("sha256");
  const state: CanonicalState = {
    bytes: 0,
    nodes: 0,
    seen: new WeakSet()
  };
  visitCanonical(candidate, 0, limits, state, (chunk) => hash.update(chunk));
  return hash.digest("hex");
}

function cloneCanonicalData(candidate: unknown, limits: CanonicalLimits): unknown {
  const state: CanonicalState = {
    bytes: 0,
    nodes: 0,
    seen: new WeakSet()
  };
  const clone = (value: unknown, depth: number): unknown => {
    chargeCanonicalNode(value, depth, limits, state);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return value;
    if (typeof value === "number") return value;
    if (typeof value !== "object") throw new TypeError();
    state.seen.add(value);
    try {
      if (Array.isArray(value)) {
        const array = canonicalArrayDescriptors(value, limits);
        const result: unknown[] = [];
        for (let index = 0; index < array.length; index += 1) {
          const descriptor = array.descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
          result.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const descriptors = canonicalObjectDescriptors(value, limits);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(descriptors).sort()) {
        chargeCanonicalBytes(key, limits, state);
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: clone(descriptor.value, depth + 1),
          writable: true
        });
      }
      return Object.freeze(result);
    } finally {
      state.seen.delete(value);
    }
  };
  return clone(candidate, 0);
}

function visitCanonical(
  value: unknown,
  depth: number,
  limits: CanonicalLimits,
  state: CanonicalState,
  emit: (chunk: string) => void
): void {
  chargeCanonicalNode(value, depth, limits, state);
  if (value === null) {
    emit("n;");
    return;
  }
  if (typeof value === "boolean") {
    emit(value ? "b1;" : "b0;");
    return;
  }
  if (typeof value === "string") {
    emit(`s${Buffer.byteLength(value, "utf8")}:`);
    emit(value);
    emit(";");
    return;
  }
  if (typeof value === "number") {
    emit(`d${Object.is(value, -0) ? "-0" : String(value)};`);
    return;
  }
  if (typeof value !== "object") throw new TypeError();
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const array = canonicalArrayDescriptors(value, limits);
      emit(`a${array.length}[`);
      for (let index = 0; index < array.length; index += 1) {
        const descriptor = array.descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
        visitCanonical(descriptor.value, depth + 1, limits, state, emit);
      }
      emit("];");
      return;
    }
    const descriptors = canonicalObjectDescriptors(value, limits);
    const keys = Object.keys(descriptors).sort();
    emit(`o${keys.length}{`);
    for (const key of keys) {
      chargeCanonicalBytes(key, limits, state);
      emit(`k${Buffer.byteLength(key, "utf8")}:`);
      emit(key);
      emit("=");
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
      visitCanonical(descriptor.value, depth + 1, limits, state, emit);
    }
    emit("};");
  } finally {
    state.seen.delete(value);
  }
}

function chargeCanonicalNode(
  value: unknown,
  depth: number,
  limits: CanonicalLimits,
  state: CanonicalState
): void {
  state.nodes += 1;
  if (state.nodes > limits.maximumNodes || depth > limits.maximumDepth) {
    throw new TypeError();
  }
  if (typeof value === "string") chargeCanonicalBytes(value, limits, state);
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError();
  if (
    value !== null &&
    typeof value === "object" &&
    state.seen.has(value)
  ) {
    throw new TypeError();
  }
}

function chargeCanonicalBytes(
  value: string,
  limits: CanonicalLimits,
  state: CanonicalState
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  state.bytes += bytes;
  if (state.bytes > limits.maximumBytes) throw new TypeError();
}

function canonicalArrayDescriptors(
  value: unknown[],
  limits: CanonicalLimits
): CanonicalArrayData {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const descriptorMap = descriptors as unknown as PropertyDescriptorMap;
  const keys = Reflect.ownKeys(descriptorMap);
  const lengthDescriptor = descriptorMap.length;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    lengthDescriptor.enumerable !== false ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > limits.maximumArrayItems
  ) {
    throw new TypeError();
  }
  const length = lengthDescriptor.value;
  const expected = Array.from({ length }, (_value, index) => String(index));
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    keys.length !== expected.length + 1 ||
    keys.some((key) => typeof key !== "string") ||
    !Object.hasOwn(descriptorMap, "length") ||
    expected.some((key) => !Object.hasOwn(descriptorMap, key))
  ) {
    throw new TypeError();
  }
  for (const key of expected) assertCanonicalDescriptor(descriptorMap[key]);
  return Object.freeze({
    descriptors: descriptorMap,
    length
  });
}

function canonicalObjectDescriptors(
  value: object,
  limits: CanonicalLimits
): PropertyDescriptorMap {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length > limits.maximumObjectFields ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        Buffer.byteLength(key, "utf8") > limits.maximumKeyBytes
    )
  ) {
    throw new TypeError();
  }
  for (const key of keys as string[]) assertCanonicalDescriptor(descriptors[key]);
  return descriptors;
}

function assertCanonicalDescriptor(
  descriptor: PropertyDescriptor | undefined
): asserts descriptor is PropertyDescriptor & { readonly value: unknown } {
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    throw new TypeError();
  }
}

function settlementValue<T>(settlement: AdmissionSettlement): T {
  if (settlement.type === "error") throw settlement.error;
  return settlement.value as T;
}

function admissionError(
  reason: HostDeckSelectedWriteAdmissionErrorReason,
  apiCode: ErrorCode,
  retrySafe: boolean
): HostDeckSelectedWriteAdmissionError {
  const error = new HostDeckSelectedWriteAdmissionError(
    admissionErrorToken,
    reason,
    apiCode,
    retrySafe
  );
  acceptedAdmissionErrors.add(error);
  return error;
}

function increment(
  counters: MutableAdmissionCounters,
  key: keyof MutableAdmissionCounters
): void {
  if (counters[key] < maximumCounter) counters[key] += 1;
}
