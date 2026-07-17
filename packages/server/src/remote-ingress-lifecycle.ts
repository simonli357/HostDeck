import { performance } from "node:perf_hooks";
import {
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  type RemoteIngressPublicState,
  remoteExternalOriginSchema
} from "@hostdeck/contracts";
import type { OperationDeadline } from "@hostdeck/core";
import {
  assertHostDeckHostHealthService,
  type HostDeckHostHealthService
} from "./host-health.js";
import {
  assertRemoteIngressControlService,
  HostDeckRemoteIngressControlServiceError,
  type RemoteIngressControlAdmissionLeaseSnapshot,
  type RemoteIngressControlService,
  type RemoteIngressControlServiceSnapshot
} from "./remote-ingress-control-service.js";
import {
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  type HostDeckRemoteIngressRequestAuthorityPolicy,
  type HostDeckRemoteIngressRequestAuthoritySnapshot
} from "./remote-ingress-request-authority.js";
import type { TailscaleServeRemoteAdmissionSnapshot } from "./tailscale-serve-proxy-trust.js";

export type HostDeckRemoteIngressLifecyclePhase =
  | "idle"
  | "running"
  | "draining"
  | "closed"
  | "failed";

export type HostDeckRemoteIngressLifecycleErrorCode =
  | "clock_invalid"
  | "contract_invalid"
  | "lifecycle_closed"
  | "remote_health_failed"
  | "scheduler_failed"
  | "shutdown_timeout";

export class HostDeckRemoteIngressLifecycleError extends Error {
  constructor(readonly code: HostDeckRemoteIngressLifecycleErrorCode) {
    super(errorMessages[code]);
    this.name = "HostDeckRemoteIngressLifecycleError";
    Object.freeze(this);
  }
}

export interface HostDeckRemoteIngressLifecycleClock {
  readonly monotonicNow: () => number;
  readonly sleep: (
    milliseconds: number,
    signal: AbortSignal
  ) => Promise<void>;
}

export interface CreateHostDeckRemoteIngressLifecycleControlInput {
  readonly monotonicNow: () => number;
  readonly signal: AbortSignal;
}

export interface CreateHostDeckRemoteIngressLifecycleInput {
  readonly clock?: HostDeckRemoteIngressLifecycleClock;
  readonly createControl: (
    input: CreateHostDeckRemoteIngressLifecycleControlInput
  ) => RemoteIngressControlService;
  readonly health: HostDeckHostHealthService;
}

export interface HostDeckRemoteIngressLifecycleControl {
  readonly disable: (
    request: RemoteDisableRequest
  ) => Promise<RemoteIngressPublicState>;
  readonly enable: (
    request: RemoteEnableRequest
  ) => Promise<RemoteIngressPublicState>;
  readonly readStatus: () => Promise<RemoteIngressPublicState>;
  readonly snapshot: () => RemoteIngressControlServiceSnapshot;
}

export interface HostDeckRemoteIngressLifecycleSnapshot {
  readonly active_control_operations: number;
  readonly authority: HostDeckRemoteIngressRequestAuthoritySnapshot;
  readonly control_failures: number;
  readonly guard_armed: boolean;
  readonly guard_expirations: number;
  readonly health_failures: number;
  readonly health_updates: number;
  readonly observation_interval_ms: number;
  readonly phase: HostDeckRemoteIngressLifecyclePhase;
  readonly poll_cycles: number;
  readonly poll_failures: number;
  readonly refresh_delay_ms: number;
  readonly source_generation: number;
}

export interface HostDeckRemoteIngressLifecycle {
  readonly beginDrain: () => void;
  readonly close: (deadline: OperationDeadline) => Promise<void>;
  readonly control: HostDeckRemoteIngressLifecycleControl;
  readonly readAdmission: () => TailscaleServeRemoteAdmissionSnapshot;
  readonly requestAuthority: HostDeckRemoteIngressRequestAuthorityPolicy;
  readonly snapshot: () => HostDeckRemoteIngressLifecycleSnapshot;
  readonly start: () => void;
}

interface MutableCounters {
  controlFailures: number;
  guardExpirations: number;
  healthFailures: number;
  healthUpdates: number;
  pollCycles: number;
  pollFailures: number;
}

interface ParsedClock {
  readonly monotonicNow: () => number;
  readonly sleep: (
    milliseconds: number,
    signal: AbortSignal
  ) => Promise<void>;
}

const acceptedControls = new WeakSet<object>();
const acceptedLifecycles = new WeakSet<object>();
const inputKeys = ["clock", "createControl", "health"] as const;
const requiredInputKeys = ["createControl", "health"] as const;
const clockKeys = ["monotonicNow", "sleep"] as const;
const leaseKeys = [
  "admission",
  "external_origin",
  "generation",
  "valid_until"
] as const;
const maximumGeneration = Number.MAX_SAFE_INTEGER;
const errorMessages: Readonly<
  Record<HostDeckRemoteIngressLifecycleErrorCode, string>
> = Object.freeze({
  clock_invalid: "Remote ingress lifecycle clock is invalid.",
  contract_invalid: "Remote ingress lifecycle contract is invalid.",
  lifecycle_closed: "Remote ingress lifecycle is not running.",
  remote_health_failed: "Remote ingress health update failed.",
  scheduler_failed: "Remote ingress lifecycle scheduler failed.",
  shutdown_timeout: "Remote ingress lifecycle shutdown timed out."
});
const lifecycleClosedReason = new HostDeckRemoteIngressLifecycleError(
  "lifecycle_closed"
);

export function createHostDeckRemoteIngressLifecycle(
  rawInput: CreateHostDeckRemoteIngressLifecycleInput
): HostDeckRemoteIngressLifecycle {
  const input = parseInput(rawInput);
  const rootController = new AbortController();
  const clock = input.clock;
  let lastMonotonic: number | null = null;
  const monotonicNow = (): number => {
    let value: unknown;
    try {
      value = input.clock.monotonicNow();
    } catch {
      throw new HostDeckRemoteIngressLifecycleError("clock_invalid");
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (lastMonotonic !== null && value < lastMonotonic)
    ) {
      throw new HostDeckRemoteIngressLifecycleError("clock_invalid");
    }
    lastMonotonic = value;
    return value;
  };
  const initialized = (() => {
    try {
      const control = input.createControl(
        Object.freeze({
          monotonicNow,
          signal: rootController.signal
        })
      );
      assertRemoteIngressControlService(control);
      const interval = control.observation_interval_ms;
      if (!Number.isSafeInteger(interval) || interval <= 0) {
        throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
      }
      const healthSourceGeneration =
        input.health.remoteSnapshot().source_generation;
      if (
        !Number.isSafeInteger(healthSourceGeneration) ||
        healthSourceGeneration < 0 ||
        healthSourceGeneration >= maximumGeneration
      ) {
        throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
      }
      const controlClockFailures = readCounter(
        control.snapshot().clock_failures
      );
      return Object.freeze({
        control,
        controlClockFailures,
        healthSourceGeneration,
        interval
      });
    } catch (error) {
      if (!rootController.signal.aborted) {
        rootController.abort(toLifecycleFailure(error));
      }
      throw error;
    }
  })();
  const rawControl = initialized.control;
  const observationInterval = initialized.interval;
  const refreshDelay = Math.max(1, Math.floor(observationInterval / 3));
  const initialSourceGeneration = initialized.healthSourceGeneration;

  const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
  const counters: MutableCounters = {
    controlFailures: 0,
    guardExpirations: 0,
    healthFailures: 0,
    healthUpdates: 0,
    pollCycles: 0,
    pollFailures: 0
  };
  const activeControlOperations = new Set<Promise<unknown>>();
  const guardTasks = new Set<Promise<void>>();
  let phase: HostDeckRemoteIngressLifecyclePhase = "idle";
  let sourceGeneration = initialSourceGeneration;
  let lastAdmissionGeneration = 0;
  let guardController: AbortController | null = null;
  let guardDeadline: number | null = null;
  let guardToken = 0;
  let loopPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let observedControlClockFailures = initialized.controlClockFailures;

  const nextSourceGeneration = (): number => {
    if (sourceGeneration >= maximumGeneration) {
      throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
    }
    sourceGeneration += 1;
    return sourceGeneration;
  };

  const cancelGuard = (): void => {
    guardToken = increment(guardToken);
    const controller = guardController;
    guardController = null;
    guardDeadline = null;
    if (controller !== null && !controller.signal.aborted) {
      controller.abort(lifecycleClosedReason);
    }
  };

  const failPermanently = (
    error: unknown,
    publishTerminalHealth = true
  ): void => {
    if (phase === "closed" || phase === "draining" || phase === "failed") return;
    phase = "failed";
    cancelGuard();
    authority.close();
    if (!rootController.signal.aborted) {
      rootController.abort(
        error instanceof HostDeckRemoteIngressLifecycleError
          ? error
          : new HostDeckRemoteIngressLifecycleError("contract_invalid")
      );
    }
    if (!publishTerminalHealth) return;
    try {
      input.health.failRemote({
        reason: "observation_failed",
        source_generation: nextSourceGeneration()
      });
      counters.healthFailures = increment(counters.healthFailures);
    } catch {
      // The failed phase and closed authority remain the observable terminal state.
    }
  };

  const publishFailure = (): void => {
    try {
      input.health.failRemote({
        reason: "observation_failed",
        source_generation: nextSourceGeneration()
      });
      counters.healthFailures = increment(counters.healthFailures);
    } catch {
      const failure = new HostDeckRemoteIngressLifecycleError(
        "remote_health_failed"
      );
      failPermanently(failure, false);
      throw failure;
    }
  };

  const publishState = (state: RemoteIngressPublicState): void => {
    try {
      input.health.updateRemote({
        source_generation: nextSourceGeneration(),
        state
      });
      counters.healthUpdates = increment(counters.healthUpdates);
    } catch {
      const failure = new HostDeckRemoteIngressLifecycleError(
        "remote_health_failed"
      );
      failPermanently(failure, false);
      throw failure;
    }
  };

  const synchronizeAdmission = (): RemoteIngressControlAdmissionLeaseSnapshot => {
    const lease = parseAdmissionLease(rawControl.readAdmissionLease());
    const currentClockFailures = readCounter(
      rawControl.snapshot().clock_failures
    );
    if (currentClockFailures < observedControlClockFailures) {
      throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
    }
    if (currentClockFailures > observedControlClockFailures) {
      observedControlClockFailures = currentClockFailures;
      throw new HostDeckRemoteIngressLifecycleError("clock_invalid");
    }
    lastAdmissionGeneration = Math.max(
      lastAdmissionGeneration,
      lease.generation
    );
    const synchronized = authority.synchronize({
      admission: lease.admission,
      external_origin: lease.external_origin,
      generation: lease.generation
    });
    if (
      synchronized.admission !== lease.admission ||
      synchronized.external_origin !== lease.external_origin ||
      synchronized.generation !== lease.generation
    ) {
      throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
    }
    return lease;
  };

  const runGuard = async (
    token: number,
    deadline: number,
    signal: AbortSignal
  ): Promise<void> => {
    for (;;) {
      const remaining = deadline - monotonicNow();
      if (remaining <= 0) break;
      await clock.sleep(Math.max(1, Math.ceil(remaining)), signal);
      if (signal.aborted) return;
    }
    if (phase !== "running" || token !== guardToken) return;
    counters.guardExpirations = increment(counters.guardExpirations);
    const lease = synchronizeAdmission();
    if (lease.admission === "open") {
      armGuard(lease.valid_until);
      return;
    }
    publishFailure();
  };

  const armGuard = (deadline: number | null): void => {
    if (
      phase === "running" &&
      deadline !== null &&
      guardController !== null &&
      guardDeadline === deadline
    ) {
      return;
    }
    cancelGuard();
    if (phase !== "running" || deadline === null) return;
    const now = monotonicNow();
    if (!Number.isFinite(deadline) || deadline <= now) {
      throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
    }
    const controller = new AbortController();
    guardController = controller;
    guardDeadline = deadline;
    const token = guardToken;
    const signal = AbortSignal.any([
      rootController.signal,
      controller.signal
    ]);
    const task = runGuard(token, deadline, signal).catch((error: unknown) => {
      if (signal.aborted) return;
      const failure =
        error instanceof HostDeckRemoteIngressLifecycleError
          ? error
          : new HostDeckRemoteIngressLifecycleError("scheduler_failed");
      failPermanently(failure);
    });
    guardTasks.add(task);
    void task.finally(() => {
      guardTasks.delete(task);
      if (guardController === controller && guardToken === token) {
        guardController = null;
        guardDeadline = null;
      }
    });
  };

  const reconcileSuccess = (state: RemoteIngressPublicState): void => {
    if (phase !== "running") return;
    const lease = synchronizeAdmission();
    if (lease.admission === "open") {
      if (state.availability !== "ready") {
        throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
      }
      armGuard(lease.valid_until);
      publishState(state);
      return;
    }
    cancelGuard();
    if (state.availability === "ready") {
      publishFailure();
      return;
    }
    publishState(state);
  };

  const reconcileFailure = (error: unknown): void => {
    if (phase !== "running") return;
    counters.controlFailures = increment(counters.controlFailures);
    const lease = synchronizeAdmission();
    if (lease.admission === "open") {
      armGuard(lease.valid_until);
      return;
    }
    cancelGuard();
    if (
      error instanceof HostDeckRemoteIngressControlServiceError &&
      (error.code === "invalid_input" || error.code === "operation_busy")
    ) {
      return;
    }
    publishFailure();
  };

  const runControl = <T extends RemoteIngressPublicState>(
    operation: () => Promise<T>
  ): Promise<T> => {
    if (phase !== "running") {
      return Promise.reject(
        new HostDeckRemoteIngressLifecycleError("lifecycle_closed")
      );
    }
    const promise = Promise.resolve()
      .then(operation)
      .then(
        (state) => {
          try {
            reconcileSuccess(state);
          } catch (error) {
            if (phase === "running") {
              failPermanently(toLifecycleFailure(error));
            }
            throw error;
          }
          return state;
        },
        (error: unknown) => {
          if (phase === "running" && isPermanentControlFailure(error)) {
            failPermanently(toLifecycleFailure(error));
            throw error;
          }
          try {
            reconcileFailure(error);
          } catch (reconciliationError) {
            if (phase === "running") {
              failPermanently(toLifecycleFailure(reconciliationError));
            }
            throw reconciliationError;
          }
          throw error;
        }
      );
    activeControlOperations.add(promise);
    void promise.finally(() => activeControlOperations.delete(promise)).catch(
      () => undefined
    );
    return promise;
  };

  const control: HostDeckRemoteIngressLifecycleControl = Object.freeze({
    disable(request: RemoteDisableRequest) {
      return runControl(() => rawControl.disable(request));
    },
    enable(request: RemoteEnableRequest) {
      return runControl(() => rawControl.enable(request));
    },
    readStatus() {
      return runControl(() => rawControl.readStatus());
    },
    snapshot() {
      return rawControl.snapshot();
    }
  });
  acceptedControls.add(control);

  const runPollLoop = async (): Promise<void> => {
    while (phase === "running") {
      counters.pollCycles = increment(counters.pollCycles);
      try {
        await control.readStatus();
      } catch {
        counters.pollFailures = increment(counters.pollFailures);
      }
      if (phase !== "running") return;
      try {
        await clock.sleep(refreshDelay, rootController.signal);
      } catch {
        if (rootController.signal.aborted) return;
        const failure = new HostDeckRemoteIngressLifecycleError(
          "scheduler_failed"
        );
        failPermanently(failure);
        return;
      }
    }
  };

  const beginDrain = (): void => {
    if (phase === "closed" || phase === "draining") return;
    if (phase !== "failed") phase = "draining";
    cancelGuard();
    authority.close();
    if (!rootController.signal.aborted) {
      rootController.abort(lifecycleClosedReason);
    }
  };

  const close = (deadline: OperationDeadline): Promise<void> => {
    assertOperationDeadline(deadline);
    if (closePromise !== null) return closePromise;
    beginDrain();
    closePromise = (async () => {
      const pending = [
        ...(loopPromise === null ? [] : [loopPromise]),
        ...guardTasks,
        ...activeControlOperations
      ];
      try {
        await awaitWithAbort(Promise.allSettled(pending), deadline.signal);
      } catch {
        phase = "failed";
        throw new HostDeckRemoteIngressLifecycleError("shutdown_timeout");
      }
      if (phase !== "failed") phase = "closed";
    })();
    return closePromise;
  };

  const lifecycle: HostDeckRemoteIngressLifecycle = Object.freeze({
    beginDrain,
    close,
    control,
    readAdmission() {
      if (phase !== "running") return closedSnapshot(lastAdmissionGeneration);
      try {
        const lease = synchronizeAdmission();
        if (lease.admission === "closed") {
          cancelGuard();
          return closedSnapshot(lease.generation);
        }
        armGuard(lease.valid_until);
        return Object.freeze({
          admission: "open" as const,
          external_origin: lease.external_origin,
          generation: lease.generation
        });
      } catch (error) {
        failPermanently(error);
        return closedSnapshot(lastAdmissionGeneration);
      }
    },
    requestAuthority: authority,
    snapshot() {
      return Object.freeze({
        active_control_operations: activeControlOperations.size,
        authority: authority.snapshot(),
        control_failures: counters.controlFailures,
        guard_armed: guardController !== null,
        guard_expirations: counters.guardExpirations,
        health_failures: counters.healthFailures,
        health_updates: counters.healthUpdates,
        observation_interval_ms: observationInterval,
        phase,
        poll_cycles: counters.pollCycles,
        poll_failures: counters.pollFailures,
        refresh_delay_ms: refreshDelay,
        source_generation: sourceGeneration
      });
    },
    start() {
      if (phase === "running") return;
      if (phase !== "idle") {
        throw new HostDeckRemoteIngressLifecycleError("lifecycle_closed");
      }
      phase = "running";
      loopPromise = Promise.resolve()
        .then(runPollLoop)
        .catch((error: unknown) => {
          if (phase === "running") {
            failPermanently(toLifecycleFailure(error));
          }
        });
    }
  });
  acceptedLifecycles.add(lifecycle);
  return lifecycle;
}

export function assertHostDeckRemoteIngressLifecycle(
  candidate: unknown
): asserts candidate is HostDeckRemoteIngressLifecycle {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedLifecycles.has(candidate)
  ) {
    throw new TypeError(
      "Remote ingress lifecycle must be created by its factory."
    );
  }
}

export function assertHostDeckRemoteIngressLifecycleControl(
  candidate: unknown
): asserts candidate is HostDeckRemoteIngressLifecycleControl {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    !acceptedControls.has(candidate)
  ) {
    throw new TypeError(
      "Remote ingress lifecycle control must be created by its lifecycle."
    );
  }
}

function parseInput(
  input: unknown
): Readonly<{
  readonly clock: ParsedClock;
  readonly createControl: CreateHostDeckRemoteIngressLifecycleInput["createControl"];
  readonly health: HostDeckHostHealthService;
}> {
  const values = readAllowedDataObject(
    input,
    inputKeys,
    requiredInputKeys,
    "Remote ingress lifecycle input"
  );
  if (typeof values.createControl !== "function") {
    throw new TypeError("Remote ingress lifecycle control factory is invalid.");
  }
  assertHostDeckHostHealthService(values.health);
  return Object.freeze({
    clock: parseClock(values.clock),
    createControl: values.createControl as CreateHostDeckRemoteIngressLifecycleInput["createControl"],
    health: values.health
  });
}

function parseClock(input: unknown): ParsedClock {
  if (input === undefined) {
    return Object.freeze({
      monotonicNow: () => performance.now(),
      sleep: abortableSleep
    });
  }
  const values = readAllowedDataObject(
    input,
    clockKeys,
    clockKeys,
    "Remote ingress lifecycle clock"
  );
  if (
    typeof values.monotonicNow !== "function" ||
    typeof values.sleep !== "function"
  ) {
    throw new TypeError("Remote ingress lifecycle clock is invalid.");
  }
  return Object.freeze({
    monotonicNow: values.monotonicNow as () => number,
    sleep: values.sleep as ParsedClock["sleep"]
  });
}

function parseAdmissionLease(
  input: unknown
): RemoteIngressControlAdmissionLeaseSnapshot {
  const values = readAllowedDataObject(
    input,
    leaseKeys,
    leaseKeys,
    "Remote ingress admission lease"
  );
  if (
    !Number.isSafeInteger(values.generation) ||
    (values.generation as number) < 0 ||
    (values.admission !== "open" && values.admission !== "closed")
  ) {
    throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
  }
  if (values.admission === "closed") {
    if (values.external_origin !== null || values.valid_until !== null) {
      throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
    }
    return Object.freeze({
      admission: "closed",
      external_origin: null,
      generation: values.generation as number,
      valid_until: null
    });
  }
  if (
    (values.generation as number) === 0 ||
    !remoteExternalOriginSchema.safeParse(values.external_origin).success ||
    typeof values.valid_until !== "number" ||
    !Number.isFinite(values.valid_until) ||
    values.valid_until < 0
  ) {
    throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
  }
  return Object.freeze({
    admission: "open",
    external_origin: values.external_origin as string,
    generation: values.generation as number,
    valid_until: values.valid_until
  });
}

function assertOperationDeadline(
  deadline: unknown
): asserts deadline is OperationDeadline {
  if (
    deadline === null ||
    typeof deadline !== "object" ||
    !(deadline as OperationDeadline).signal ||
    !isAbortSignal((deadline as OperationDeadline).signal)
  ) {
    throw new TypeError(
      "Remote ingress lifecycle close requires an operation deadline."
    );
  }
}

function readAllowedDataObject<
  const AllowedKey extends string,
  const RequiredKey extends AllowedKey
>(
  input: unknown,
  allowedKeys: readonly AllowedKey[],
  requiredKeys: readonly RequiredKey[],
  label: string
): Readonly<Record<AllowedKey, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(allowedKeys as readonly string[]).includes(key)
      ) ||
      requiredKeys.some((key) => !(key in descriptors))
    ) {
      throw new TypeError();
    }
    const output = Object.create(null) as Record<AllowedKey, unknown>;
    for (const key of allowedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        output[key] = undefined;
        continue;
      }
      if (
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    !isAbortSignal(signal)
  ) {
    throw new TypeError("Remote ingress lifecycle sleep input is invalid.");
  }
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finishResolve, milliseconds);
    function cleanup(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finishReject);
    }
    function finishResolve(): void {
      cleanup();
      resolve();
    }
    function finishReject(): void {
      cleanup();
      reject(signal.reason);
    }
    signal.addEventListener("abort", finishReject, { once: true });
  });
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  return (
    candidate instanceof AbortSignal ||
    (candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as AbortSignal).aborted === "boolean" &&
      typeof (candidate as AbortSignal).addEventListener === "function" &&
      typeof (candidate as AbortSignal).removeEventListener === "function")
  );
}

function closedSnapshot(
  generation: number
): TailscaleServeRemoteAdmissionSnapshot {
  return Object.freeze({
    admission: "closed",
    external_origin: null,
    generation:
      Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
  });
}

function isPermanentControlFailure(error: unknown): boolean {
  return (
    error instanceof HostDeckRemoteIngressControlServiceError &&
    (error.code === "clock_invalid" || error.code === "contract_violation")
  );
}

function toLifecycleFailure(
  error: unknown
): HostDeckRemoteIngressLifecycleError {
  if (error instanceof HostDeckRemoteIngressLifecycleError) return error;
  if (
    error instanceof HostDeckRemoteIngressControlServiceError &&
    error.code === "clock_invalid"
  ) {
    return new HostDeckRemoteIngressLifecycleError("clock_invalid");
  }
  return new HostDeckRemoteIngressLifecycleError("contract_invalid");
}

function readCounter(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HostDeckRemoteIngressLifecycleError("contract_invalid");
  }
  return value as number;
}

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}
