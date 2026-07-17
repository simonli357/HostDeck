import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  type RemoteIngressObservationSnapshot,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  remoteIngressObservationSnapshotSchema
} from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import {
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckHostHealthService } from "./host-health.js";
import { createRemoteIngressControlService } from "./remote-ingress-control-service.js";
import {
  assertHostDeckRemoteIngressLifecycle,
  assertHostDeckRemoteIngressLifecycleControl,
  createHostDeckRemoteIngressLifecycle,
  HostDeckRemoteIngressLifecycleError
} from "./remote-ingress-lifecycle.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import type { TailscaleObserver } from "./tailscale-observer.js";
import type {
  TailscaleServeManager,
  TailscaleServeManagerResult,
  TailscaleServeMutationInput
} from "./tailscale-serve-manager.js";

const roots: string[] = [];
const databases: ReturnType<typeof openMigratedDatabase>["db"][] = [];
const origin = "https://hostdeck-control.fixture-tailnet.ts.net";
const localOrigin = "http://127.0.0.1:3777";
const profileKey = `sha256:${"1".repeat(64)}`;
const otherProfileKey = `sha256:${"2".repeat(64)}`;
const observedAt = "2026-07-16T06:00:00.000Z";
const baseWallTime = Date.parse("2026-07-16T07:00:00.000Z");

afterEach(() => {
  for (const db of databases.splice(0).reverse()) {
    if (db.open) db.close();
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("remote ingress lifecycle", () => {
  it("closes before start without observing or permitting a later restart", async () => {
    const harness = createHarness();
    await closeLifecycle(harness);

    expect(harness.rootSignal.aborted).toBe(true);
    expect(harness.calls).toEqual({
      candidate: 0,
      configured: 0,
      disable: 0,
      enable: 0
    });
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unknown",
      reason: "not_observed",
      source_generation: 0
    });
    expect(() => harness.lifecycle.start()).toThrowError(
      new HostDeckRemoteIngressLifecycleError("lifecycle_closed")
    );
  });

  it("constructs without Tailscale work and starts one local-independent poll after start", async () => {
    const harness = createHarness();
    assertHostDeckRemoteIngressLifecycle(harness.lifecycle);
    assertHostDeckRemoteIngressLifecycleControl(harness.lifecycle.control);
    expect(() =>
      assertHostDeckRemoteIngressLifecycle({ ...harness.lifecycle })
    ).toThrow(TypeError);
    expect(harness.calls).toEqual({
      candidate: 0,
      configured: 0,
      disable: 0,
      enable: 0
    });
    expect(harness.lifecycle.readAdmission()).toEqual(closed(0));
    expect(harness.lifecycle.snapshot()).toMatchObject({
      phase: "idle",
      poll_cycles: 0,
      refresh_delay_ms: 1_666,
      source_generation: 0
    });

    harness.lifecycle.start();
    harness.lifecycle.start();
    expect(harness.lifecycle.snapshot().phase).toBe("running");
    expect(harness.lifecycle.snapshot().poll_cycles).toBe(0);
    await flushMicrotasks();

    expect(harness.calls.candidate).toBe(0);
    expect(harness.calls.configured).toBe(0);
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "disabled",
      reason: "remote_disabled",
      source_generation: 1
    });
    expect(harness.lifecycle.snapshot()).toMatchObject({
      health_updates: 1,
      phase: "running",
      poll_cycles: 1
    });

    await closeLifecycle(harness);
    expect(harness.lifecycle.snapshot()).toMatchObject({
      active_control_operations: 0,
      guard_armed: false,
      phase: "closed"
    });
  });

  it("refreshes early, expires exact old authority during a slow poll, and recovers", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(1));

    expect(harness.lifecycle.readAdmission()).toEqual(openAdmission(2));
    const oldLease = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "ready",
      state_generation: 2
    });

    const delayed = createDeferred<RemoteIngressObservationSnapshot>();
    harness.setConfiguredHandler(() => delayed.promise);
    harness.clock.advanceTo(1_666);
    await flushMicrotasks();
    expect(harness.calls.configured).toBe(1);
    expect(harness.lifecycle.snapshot().active_control_operations).toBe(1);

    harness.clock.advanceTo(5_000);
    await flushMicrotasks();
    expect(oldLease.signal.aborted).toBe(true);
    expect(harness.lifecycle.readAdmission()).toEqual(closed(2));
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unavailable",
      reason: "observation_failed"
    });
    expect(harness.lifecycle.snapshot()).toMatchObject({
      guard_expirations: 1,
      health_failures: 1
    });

    delayed.resolve(snapshot({ serve: "exact" }));
    await flushMicrotasks();
    expect(harness.lifecycle.readAdmission()).toEqual(openAdmission(2));
    const recovered = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });
    expect(recovered.signal.aborted).toBe(false);
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "ready",
      state_generation: 2
    });
    expect(harness.lifecycle.snapshot()).toMatchObject({
      active_control_operations: 0,
      guard_armed: true,
      health_updates: 3,
      poll_cycles: 2
    });

    await closeLifecycle(harness);
    expect(recovered.signal.aborted).toBe(true);
  });

  it("renews the same generation early without interrupting active requests", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(20));
    const lease = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });

    harness.clock.advanceTo(1_666);
    await flushMicrotasks();
    expect(harness.calls.configured).toBe(1);
    expect(lease.signal.aborted).toBe(false);
    expect(harness.lifecycle.snapshot()).toMatchObject({
      guard_armed: true,
      guard_expirations: 0,
      poll_cycles: 2
    });

    harness.clock.advanceTo(5_000);
    await flushMicrotasks();
    harness.lifecycle.requestAuthority.assertActive(lease);
    expect(lease.signal.aborted).toBe(false);
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "ready",
      state_generation: 2
    });
    await closeLifecycle(harness);
  });

  it("invalidates changed profile generations, recovers by observation only, and never mutates Serve", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(2));
    const lease = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });

    harness.queueConfigured(
      snapshot({ profile: "other", serve: null }),
      snapshot({ serve: "exact" })
    );
    await expect(harness.lifecycle.control.readStatus()).resolves.toMatchObject({
      availability: "unavailable",
      generation: 3,
      reason: "profile_other"
    });
    expect(lease.signal.aborted).toBe(true);
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unavailable",
      state_generation: 3
    });
    expect(harness.calls.enable).toBe(1);
    expect(harness.calls.disable).toBe(0);

    await expect(harness.lifecycle.control.readStatus()).resolves.toMatchObject({
      availability: "ready",
      generation: 4
    });
    expect(harness.lifecycle.readAdmission()).toEqual(openAdmission(4));
    expect(harness.calls.enable).toBe(1);
    expect(harness.calls.disable).toBe(0);
    await closeLifecycle(harness);
  });

  it("fails closed on observer rejection and reopens only after a fresh exact observation", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(21));
    const lease = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });
    const managerCalls = {
      disable: harness.calls.disable,
      enable: harness.calls.enable
    };

    harness.setConfiguredHandler(() =>
      Promise.reject(new Error("private observer failure"))
    );
    await expect(harness.lifecycle.control.readStatus()).rejects.toMatchObject({
      code: "observation_unavailable"
    });
    expect(lease.signal.aborted).toBe(true);
    expect(harness.lifecycle.readAdmission()).toEqual(closed(2));
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unavailable",
      reason: "observation_failed"
    });

    harness.setConfiguredHandler(() =>
      Promise.resolve(snapshot({ serve: "exact" }))
    );
    await expect(harness.lifecycle.control.readStatus()).resolves.toMatchObject({
      availability: "ready",
      generation: 2
    });
    expect(harness.lifecycle.readAdmission()).toEqual(openAdmission(2));
    expect(harness.calls).toMatchObject(managerCalls);
    expect(JSON.stringify(harness.lifecycle.snapshot())).not.toContain(
      "private observer failure"
    );
    await closeLifecycle(harness);
  });

  it("does not let malformed or pre-ownership busy calls invent global degradation", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(3));
    const readyHealth = harness.health.remoteSnapshot();

    await expect(
      harness.lifecycle.control.enable({} as RemoteEnableRequest)
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.health.remoteSnapshot()).toBe(readyHealth);
    expect(harness.lifecycle.readAdmission()).toEqual(openAdmission(2));

    const delayed = createDeferred<RemoteIngressObservationSnapshot>();
    harness.setConfiguredHandler(() => delayed.promise);
    const activeStatus = harness.lifecycle.control.readStatus();
    await flushMicrotasks();
    await expect(
      harness.lifecycle.control.enable(enableRequest(4))
    ).rejects.toMatchObject({ code: "operation_busy" });
    expect(harness.health.remoteSnapshot()).toBe(readyHealth);
    expect(harness.lifecycle.readAdmission()).toEqual(openAdmission(2));

    delayed.resolve(snapshot({ serve: "exact" }));
    await activeStatus;
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "ready",
      state_generation: 2
    });
    expect(harness.lifecycle.snapshot()).toMatchObject({
      control_failures: 2,
      health_failures: 0
    });
    await closeLifecycle(harness);
  });

  it("aborts observation and request authority during bounded idempotent shutdown without post-close health", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(5));
    const lease = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });
    const healthBefore = harness.health.remoteSnapshot();

    const delayed = abortOnSignal<RemoteIngressObservationSnapshot>(
      harness.rootSignal
    );
    harness.setConfiguredHandler(() => delayed.promise);
    harness.clock.advanceTo(1_666);
    await flushMicrotasks();
    expect(harness.lifecycle.snapshot().active_control_operations).toBe(1);

    const deadline = createOperationDeadline({ timeoutMs: 1_000 });
    const first = harness.lifecycle.close(deadline);
    const second = harness.lifecycle.close(deadline);
    expect(first).toBe(second);
    await first;
    deadline.dispose();

    expect(harness.rootSignal.aborted).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(harness.health.remoteSnapshot()).toBe(healthBefore);
    expect(harness.lifecycle.readAdmission()).toEqual(closed(2));
    expect(harness.lifecycle.snapshot()).toMatchObject({
      active_control_operations: 0,
      guard_armed: false,
      phase: "closed"
    });
    await expect(harness.lifecycle.control.readStatus()).rejects.toThrowError(
      new HostDeckRemoteIngressLifecycleError("lifecycle_closed")
    );
    expect(harness.managerCallsAfterAbort).toBe(0);
  });

  it("aborts one active remote mutation during shutdown without retry or post-close health", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(31));
    const lease = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });
    const healthBefore = harness.health.remoteSnapshot();
    harness.setDisableHandler(() =>
      abortPromiseOnSignal<TailscaleServeManagerResult>(harness.rootSignal)
    );

    const mutation = harness.lifecycle.control.disable(disableRequest(31));
    let mutationSettled = false;
    void mutation
      .finally(() => {
        mutationSettled = true;
      })
      .catch(() => undefined);
    await flushMicrotasks();
    expect(harness.rootSignal.aborted).toBe(false);
    expect(mutationSettled).toBe(false);
    expect(harness.calls.disable).toBe(1);
    expect(harness.lifecycle.snapshot().active_control_operations).toBe(1);

    await closeLifecycle(harness);
    await Promise.allSettled([mutation]);
    expect(lease.signal.aborted).toBe(true);
    expect(harness.calls).toMatchObject({ disable: 1, enable: 1 });
    expect(harness.lifecycle.snapshot()).toMatchObject({
      active_control_operations: 0,
      phase: "closed"
    });
    expect(harness.health.remoteSnapshot()).toBe(healthBefore);
  });

  it("permanently closes authority and remote health after monotonic clock regression", async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await flushMicrotasks();
    await harness.lifecycle.control.enable(enableRequest(32));
    const lease = harness.lifecycle.requestAuthority.acquire({
      external_origin: origin,
      generation: 2
    });

    harness.clock.advanceTo(100);
    await expect(harness.lifecycle.control.readStatus()).resolves.toMatchObject({
      availability: "ready",
      generation: 2
    });
    harness.clock.regressTo(50);
    await expect(harness.lifecycle.control.readStatus()).rejects.toMatchObject({
      code: "clock_invalid"
    });

    expect(lease.signal.aborted).toBe(true);
    expect(harness.rootSignal.aborted).toBe(true);
    expect(harness.lifecycle.readAdmission()).toEqual(closed(2));
    expect(harness.lifecycle.snapshot()).toMatchObject({
      active_control_operations: 0,
      guard_armed: false,
      health_failures: 1,
      phase: "failed"
    });
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unavailable",
      reason: "observation_failed"
    });
    await closeLifecycle(harness, "failed");
  });

  it("fails remote lifecycle closed on scheduler failure while retaining local health", async () => {
    const harness = createHarness();
    harness.clock.failNextSleep();
    const localBefore = harness.health.localSnapshot();
    harness.lifecycle.start();
    await flushMicrotasks();

    expect(harness.lifecycle.snapshot()).toMatchObject({
      health_failures: 1,
      health_updates: 1,
      phase: "failed",
      poll_cycles: 1
    });
    expect(harness.lifecycle.readAdmission()).toEqual(closed(0));
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unavailable",
      reason: "observation_failed"
    });
    expect(harness.health.localSnapshot()).toBe(localBefore);
    expect(harness.rootSignal.aborted).toBe(true);
    await closeLifecycle(harness, "failed");
  });
});

interface Harness {
  readonly calls: {
    candidate: number;
    configured: number;
    disable: number;
    enable: number;
  };
  readonly clock: ManualClock;
  readonly health: ReturnType<typeof createHostDeckHostHealthService>;
  readonly lifecycle: ReturnType<typeof createHostDeckRemoteIngressLifecycle>;
  readonly managerCallsAfterAbort: number;
  readonly queueConfigured: (...values: RemoteIngressObservationSnapshot[]) => void;
  readonly rootSignal: AbortSignal;
  readonly setDisableHandler: (
    handler: (
      input: TailscaleServeMutationInput
    ) => Promise<TailscaleServeManagerResult>
  ) => void;
  readonly setConfiguredHandler: (
    handler: () => Promise<RemoteIngressObservationSnapshot>
  ) => void;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-remote-lifecycle-"));
  roots.push(root);
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(baseWallTime)
  });
  databases.push(opened.db);
  const states = createRemoteIngressStateRepository(opened.db);
  const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
  const audit = createSelectedAuditRepository(opened.db);
  const calls = { candidate: 0, configured: 0, disable: 0, enable: 0 };
  const configuredQueue: RemoteIngressObservationSnapshot[] = [];
  const clock = new ManualClock();
  let configuredHandler: (() => Promise<RemoteIngressObservationSnapshot>) | null = null;
  let disableHandler: (
    input: TailscaleServeMutationInput
  ) => Promise<TailscaleServeManagerResult> = () =>
    Promise.resolve(disableSuccess());
  let wallTime = baseWallTime;
  let auditId = 0;
  let rootSignal: AbortSignal | null = null;
  let managerCallsAfterAbort = 0;
  const nextDate = () => {
    wallTime += 1_000;
    return new Date(wallTime);
  };
  const health = createHostDeckHostHealthService({ now: nextDate });
  const executor = createSecurityMutationAuditExecutor({
    repository: audit,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit:remote-lifecycle:${++auditId}`
  });

  const lifecycle = createHostDeckRemoteIngressLifecycle({
    clock: {
      monotonicNow: () => clock.now,
      sleep: (milliseconds, signal) => clock.sleep(milliseconds, signal)
    },
    createControl(input) {
      rootSignal = input.signal;
      const observer: TailscaleObserver = Object.freeze({
        poll_interval_ms: 5_000,
        async observeCandidate() {
          calls.candidate += 1;
          if (input.signal.aborted) throw input.signal.reason;
          return snapshot({ serve: "absent" });
        },
        async observeConfigured() {
          calls.configured += 1;
          if (input.signal.aborted) throw input.signal.reason;
          if (configuredHandler !== null) return configuredHandler();
          return configuredQueue.shift() ?? snapshot({ serve: "exact" });
        }
      });
      const manager: TailscaleServeManager = Object.freeze({
        async disable(mutation: TailscaleServeMutationInput) {
          calls.disable += 1;
          if (input.signal.aborted) {
            managerCallsAfterAbort += 1;
            throw input.signal.reason;
          }
          return disableHandler(mutation);
        },
        async enable(mutation: TailscaleServeMutationInput) {
          calls.enable += 1;
          if (input.signal.aborted) {
            managerCallsAfterAbort += 1;
            throw input.signal.reason;
          }
          return enableSuccess(mutation.expected_profile_key);
        },
        snapshot() {
          return Object.freeze({
            active: false,
            busy_rejections: 0,
            command_attempts: calls.disable + calls.enable,
            failed_operations: 0,
            incomplete_operations: 0,
            rejected_operations: 0,
            started_operations: calls.disable + calls.enable,
            succeeded_operations: calls.disable + calls.enable
          });
        }
      });
      return createRemoteIngressControlService({
        admissionProofs: proofs,
        audit: executor,
        localOrigin,
        manager,
        monotonicNow: input.monotonicNow,
        now: nextDate,
        observer,
        states
      });
    },
    health
  });
  if (rootSignal === null) throw new Error("Lifecycle did not create control.");

  return {
    calls,
    clock,
    health,
    lifecycle,
    get managerCallsAfterAbort() {
      return managerCallsAfterAbort;
    },
    queueConfigured(...values) {
      configuredQueue.push(...values);
    },
    rootSignal,
    setDisableHandler(handler) {
      disableHandler = handler;
    },
    setConfiguredHandler(handler) {
      configuredHandler = handler;
    }
  };
}

class ManualClock {
  now = 0;
  private readonly sleepers = new Set<{
    readonly deadline: number;
    readonly reject: (error: unknown) => void;
    readonly resolve: () => void;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
  }>();
  private failSleep = false;

  advanceTo(value: number): void {
    if (value < this.now) throw new Error("Manual clock cannot regress.");
    this.now = value;
    for (const sleeper of [...this.sleepers]) {
      if (sleeper.deadline <= this.now) this.resolveSleeper(sleeper);
    }
  }

  failNextSleep(): void {
    this.failSleep = true;
  }

  regressTo(value: number): void {
    if (value >= this.now || value < 0) {
      throw new Error("Manual clock regression must move backward.");
    }
    this.now = value;
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (this.failSleep) {
      this.failSleep = false;
      return Promise.reject(new Error("scripted scheduler failure"));
    }
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const sleeper = {
        deadline: this.now + milliseconds,
        onAbort: () => {
          this.sleepers.delete(sleeper);
          reject(signal.reason);
        },
        reject,
        resolve,
        signal
      };
      this.sleepers.add(sleeper);
      signal.addEventListener("abort", sleeper.onAbort, { once: true });
    });
  }

  private resolveSleeper(sleeper: {
    readonly deadline: number;
    readonly reject: (error: unknown) => void;
    readonly resolve: () => void;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
  }): void {
    if (!this.sleepers.delete(sleeper)) return;
    sleeper.signal.removeEventListener("abort", sleeper.onAbort);
    sleeper.resolve();
  }
}

function enableSuccess(selectedProfileKey: string): TailscaleServeManagerResult {
  return Object.freeze({
    action: "enable",
    outcome: "succeeded",
    serve_result: "applied",
    reason: null,
    command_attempted: true,
    before: snapshot({ selectedProfileKey, serve: "absent" }),
    after: snapshot({ selectedProfileKey, serve: "exact" })
  });
}

function disableSuccess(): TailscaleServeManagerResult {
  return Object.freeze({
    action: "disable",
    outcome: "succeeded",
    serve_result: "removed",
    reason: null,
    command_attempted: true,
    before: snapshot({ serve: "exact" }),
    after: snapshot({ serve: "absent" })
  });
}

function snapshot(input: {
  readonly profile?: "dedicated" | "other";
  readonly selectedProfileKey?: string;
  readonly serve: RemoteIngressObservationSnapshot["serve"];
}): RemoteIngressObservationSnapshot {
  const other = input.profile === "other";
  const selectedProfileKey = input.selectedProfileKey ?? profileKey;
  return remoteIngressObservationSnapshotSchema.parse({
    schema_version: 1,
    client: "available",
    profile: {
      state: other ? "other" : "dedicated",
      comparison: {
        relation: other ? "different" : "match",
        expected_profile_key: selectedProfileKey,
        active_profile_key: other ? otherProfileKey : selectedProfileKey
      }
    },
    serve: other ? null : input.serve,
    external_origin: other ? null : origin,
    failure: null,
    observed_at: observedAt
  });
}

function enableRequest(index: number): RemoteEnableRequest {
  return remoteEnableRequestSchema.parse({
    operation_id: `op_remote_lifecycle_enable_${index
      .toString()
      .padStart(3, "0")}`,
    confirmed: true
  });
}

function disableRequest(index: number): RemoteDisableRequest {
  return remoteDisableRequestSchema.parse({
    operation_id: `op_remote_lifecycle_disable_${index
      .toString()
      .padStart(3, "0")}`,
    confirmed: true
  });
}

function openAdmission(generation: number) {
  return Object.freeze({
    admission: "open" as const,
    external_origin: origin,
    generation
  });
}

function closed(generation: number) {
  return Object.freeze({
    admission: "closed" as const,
    external_origin: null,
    generation
  });
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function abortPromiseOnSignal<Value>(signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true
    });
  });
}

function abortOnSignal<Value>(signal: AbortSignal): {
  readonly promise: Promise<Value>;
} {
  return {
    promise: new Promise<Value>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    })
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function closeLifecycle(
  harness: Harness,
  expectedPhase: "closed" | "failed" = "closed"
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs: 1_000 });
  try {
    await harness.lifecycle.close(deadline);
  } finally {
    deadline.dispose();
  }
  expect(harness.lifecycle.snapshot().phase).toBe(expectedPhase);
}
