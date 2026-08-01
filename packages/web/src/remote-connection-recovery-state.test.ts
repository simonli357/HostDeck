import {
  isoTimestampSchema,
  remoteIngressPublicStateSchema,
  type SelectedHostRemoteStatus,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "@hostdeck/contracts";
import { remoteIngressUnavailableReasons } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import type { BrowserConnectionSnapshot } from "./connection-state.js";
import {
  createRemoteConnectionRecoveryController,
  projectRemoteConnectionRecovery
} from "./remote-connection-recovery-state.js";

const timestamp = "2026-07-26T16:00:00.000Z";
const observedAt = isoTimestampSchema.parse(timestamp);
const remoteOrigin = "https://hostdeck-recovery.fixture-tailnet.ts.net";
const loopbackOrigin = "http://127.0.0.1:3777";

describe("remote connection recovery state", () => {
  it("projects every bounded laptop reason as distinct current local recovery", () => {
    const reasons = ["remote_disabled", ...remoteIngressUnavailableReasons] as const;
    const phases = new Set<string>();

    for (const reason of reasons) {
      const projected = projectRemoteConnectionRecovery(
        snapshot({ network: "loopback", remote: reason })
      );
      expect(projected.phase, reason).toBe(reason);
      expect(projected.reason, reason).toBe(reason);
      expect(projected.source, reason).toBe("current_laptop_observation");
      expect(projected.ownerLabel, reason).toBe("LOCAL LAPTOP");
      expect(projected.title, reason).not.toBe("");
      expect(projected.detail, reason).not.toBe("");
      expect(projected.laptopActionRequired, reason).toBe(true);
      expect(projected.externalOrigin, reason).toBeNull();
      expect(projected.actionEnabled, reason).toBe(true);
      expect(JSON.stringify(projected), reason).not.toMatch(
        /device_recovery|profile-key|account@example|csrf|cookie|command output/iu
      );
      phases.add(projected.phase);
    }

    expect(phases.size).toBe(reasons.length);
  });

  it("keeps ready, unobserved, stale, transport, and access evidence distinct", () => {
    const ready = projectRemoteConnectionRecovery(
      snapshot({ network: "remote", remote: "ready" })
    );
    expect(ready).toMatchObject({
      phase: "ready",
      source: "current_laptop_observation",
      ownerLabel: "PRIVATE CONNECTION",
      externalOrigin: remoteOrigin,
      current: true,
      actionLabel: "Check again"
    });

    const runtimeIncompatible = projectRemoteConnectionRecovery(
      snapshot({ network: "remote", remote: "ready", phase: "incompatible" })
    );
    expect(runtimeIncompatible).toMatchObject({
      phase: "ready",
      source: "current_laptop_observation",
      externalOrigin: remoteOrigin,
      current: true
    });

    const unknown = projectRemoteConnectionRecovery(
      snapshot({ network: "loopback", remote: "not_observed" })
    );
    expect(unknown).toMatchObject({
      phase: "not_observed",
      source: "not_observed",
      externalOrigin: null,
      current: false
    });

    const stale = projectRemoteConnectionRecovery(
      snapshot({ network: "loopback", remote: "ready", hostState: "stale" })
    );
    expect(stale).toMatchObject({
      phase: "last_known",
      source: "last_laptop_observation",
      title: "Remote status is stale",
      externalOrigin: null,
      current: false
    });
    expect(stale.detail).toContain("last laptop report was remote ready");

    const unreachable = projectRemoteConnectionRecovery(
      snapshot({
        network: "remote",
        remote: "profile_other",
        accessState: "stale",
        hostState: "stale",
        phase: "unreachable"
      })
    );
    expect(unreachable).toMatchObject({
      phase: "browser_unreachable",
      source: "browser_connection",
      ownerLabel: "BROWSER",
      reason: null,
      externalOrigin: null
    });
    expect(unreachable.detail).not.toMatch(/profile|serve|certificate/iu);

    const denied = projectRemoteConnectionRecovery(
      snapshot({ network: "remote", readable: false, remote: null })
    );
    expect(denied).toMatchObject({
      phase: "access_limited",
      action: null,
      externalOrigin: null
    });
  });

  it("uses one local refresh and coalesces duplicate activation", async () => {
    const pendingRefresh = deferred<BrowserConnectionSnapshot>();
    let current = snapshot({ network: "loopback", remote: "serve_absent" });
    const requestRemoteStatus = vi.fn();
    const refresh = vi.fn(() => pendingRefresh.promise);
    const controller = createRemoteConnectionRecoveryController({
      port: { snapshot: () => current, requestRemoteStatus, refresh }
    });

    const first = controller.check();
    const duplicate = controller.check();
    expect(duplicate).toBe(first);
    expect(controller.snapshot()).toMatchObject({
      phase: "checking",
      busy: true,
      actionEnabled: false
    });
    await flushMicrotasks();
    expect(requestRemoteStatus).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);

    current = snapshot({ network: "loopback", remote: "ready", epoch: 2 });
    pendingRefresh.resolve(current);
    await expect(first).resolves.toMatchObject({
      phase: "ready",
      source: "current_laptop_observation"
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it("uses one paired status read before one lifecycle-backed refresh", async () => {
    const order: string[] = [];
    let current = snapshot({ network: "remote", remote: "ready" });
    const requestRemoteStatus = vi.fn(async (options?: { signal?: AbortSignal }) => {
      order.push("status");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return {
        status: 200,
        data: remoteIngressPublicStateSchema.parse({
          generation: 4,
          availability: "ready",
          reason: null,
          external_origin: remoteOrigin,
          laptop_action_required: false,
          observed_at: timestamp
        })
      };
    });
    const refresh = vi.fn(async () => {
      order.push("refresh");
      current = snapshot({ network: "remote", remote: "ready", epoch: 2 });
      return current;
    });
    const controller = createRemoteConnectionRecoveryController({
      port: { snapshot: () => current, requestRemoteStatus, refresh }
    });

    await expect(controller.check()).resolves.toMatchObject({ phase: "ready" });
    expect(order).toEqual(["status", "refresh"]);
    expect(requestRemoteStatus).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it("fails one remote check without refresh, retry, or stale ready reuse", async () => {
    const current = snapshot({ network: "remote", remote: "ready" });
    const requestRemoteStatus = vi.fn(async () => {
      throw new Error("private raw failure");
    });
    const refresh = vi.fn();
    const controller = createRemoteConnectionRecoveryController({
      port: { snapshot: () => current, requestRemoteStatus, refresh }
    });

    const failed = await controller.check();
    expect(failed).toMatchObject({
      phase: "check_failed",
      externalOrigin: null,
      current: false,
      busy: false,
      actionEnabled: true
    });
    expect(JSON.stringify(failed)).not.toContain("private raw failure");
    expect(requestRemoteStatus).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    await controller.check();
    expect(requestRemoteStatus).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it.each([
    ["wrong status", { status: 201, data: readyPublicStatus() }],
    ["invalid data", { status: 200, data: {} }],
    ["extra envelope field", { status: 200, data: readyPublicStatus(), private: true }],
    ["accessor envelope", accessorRemoteStatusResponse()]
  ])("rejects a malformed resolved status response before refresh: %s", async (_label, response) => {
    const current = snapshot({ network: "remote", remote: "ready" });
    const requestRemoteStatus = vi.fn(async () => response as never);
    const refresh = vi.fn();
    const controller = createRemoteConnectionRecoveryController({
      port: { snapshot: () => current, requestRemoteStatus, refresh }
    });

    await expect(controller.check()).resolves.toMatchObject({
      phase: "check_failed",
      current: false,
      externalOrigin: null
    });
    expect(requestRemoteStatus).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    controller.close();
  });

  it("suppresses replaced authority and aborts close without late publication", async () => {
    const pendingStatus = deferred<{
      readonly status: 200;
      readonly data: ReturnType<typeof remoteIngressPublicStateSchema.parse>;
    }>();
    let current = snapshot({ network: "remote", remote: "ready" });
    const capture: { signal: AbortSignal | null } = { signal: null };
    const requestRemoteStatus = vi.fn((options?: { signal?: AbortSignal }) => {
      capture.signal = options?.signal ?? null;
      return pendingStatus.promise;
    });
    const refresh = vi.fn();
    const controller = createRemoteConnectionRecoveryController({
      port: { snapshot: () => current, requestRemoteStatus, refresh }
    });
    const pending = controller.check();
    await flushMicrotasks();
    current = snapshot({
      network: "remote",
      remote: "ready",
      deviceId: "device_recovery_replaced",
      epoch: 2
    });
    const replaced = controller.synchronize();
    expect(capture.signal?.aborted).toBe(true);
    await expect(pending).resolves.toBe(replaced);
    expect(refresh).not.toHaveBeenCalled();
    pendingStatus.resolve({ status: 200, data: readyPublicStatus() });
    await flushMicrotasks();
    expect(controller.snapshot()).toBe(replaced);

    const secondStatus = deferred<{
      readonly status: 200;
      readonly data: ReturnType<typeof remoteIngressPublicStateSchema.parse>;
    }>();
    requestRemoteStatus.mockImplementationOnce((options?: { signal?: AbortSignal }) => {
      capture.signal = options?.signal ?? null;
      return secondStatus.promise;
    });
    const second = controller.check();
    await flushMicrotasks();
    const closed = controller.close();
    expect(capture.signal?.aborted).toBe(true);
    await expect(second).resolves.toBe(closed);
    secondStatus.resolve({ status: 200, data: readyPublicStatus() });
    await flushMicrotasks();
    expect(controller.snapshot()).toBe(closed);
    expect(closed.phase).toBe("closed");
  });

  it("clears a failed latch only after newer current host truth", async () => {
    let current = snapshot({ network: "remote", remote: "ready" });
    const requestRemoteStatus = vi.fn(async () => {
      throw new Error("failed");
    });
    const controller = createRemoteConnectionRecoveryController({
      port: { snapshot: () => current, requestRemoteStatus, refresh: vi.fn() }
    });
    await controller.check();
    expect(controller.snapshot().phase).toBe("check_failed");

    current = snapshot({ network: "remote", remote: "serve_drifted", epoch: 2 });
    expect(controller.synchronize()).toMatchObject({
      phase: "serve_drifted",
      source: "current_laptop_observation"
    });
    controller.close();
  });

  it("rejects malformed ownership and bounds subscriptions", () => {
    const current = snapshot({ network: "loopback", remote: "not_observed" });
    expect(() =>
      createRemoteConnectionRecoveryController({
        port: { snapshot: () => ({ ...current }), requestRemoteStatus: vi.fn(), refresh: vi.fn() }
      })
    ).toThrow(TypeError);
    expect(() =>
      createRemoteConnectionRecoveryController({
        port: { snapshot: () => current, requestRemoteStatus: vi.fn(), refresh: vi.fn() },
        extra: true
      } as never)
    ).toThrow(TypeError);

    const controller = createRemoteConnectionRecoveryController({
      port: { snapshot: () => current, requestRemoteStatus: vi.fn(), refresh: vi.fn() }
    });
    const listener = () => undefined;
    const release = controller.subscribe(listener);
    expect(() => controller.subscribe(listener)).toThrow(TypeError);
    const releases = Array.from({ length: 31 }, () =>
      controller.subscribe(() => undefined)
    );
    expect(() => controller.subscribe(() => undefined)).toThrow(TypeError);
    release();
    for (const unsubscribe of releases) unsubscribe();
    controller.close();
    expect(() => controller.subscribe(() => undefined)).toThrow(TypeError);
  });
});

type RemoteFixture =
  | "ready"
  | "not_observed"
  | "remote_disabled"
  | (typeof remoteIngressUnavailableReasons)[number];

function snapshot(options: {
  readonly network: "loopback" | "remote";
  readonly remote: RemoteFixture | null;
  readonly readable?: boolean;
  readonly accessState?: BrowserConnectionSnapshot["access"]["state"];
  readonly hostState?: BrowserConnectionSnapshot["host"]["state"];
  readonly phase?: BrowserConnectionSnapshot["phase"];
  readonly epoch?: number;
  readonly deviceId?: string;
}): BrowserConnectionSnapshot {
  const readable = options.readable ?? true;
  const remoteNetwork = options.network === "remote";
  const access = selectedAccessStateResponseSchema.parse({
    authentication_state: remoteNetwork
      ? readable
        ? "paired_device"
        : "unpaired"
      : "unpaired",
    device_id: remoteNetwork && readable
      ? options.deviceId ?? "device_recovery_fixture"
      : null,
    permission: remoteNetwork && readable ? "read" : null,
    device_expires_at: remoteNetwork && readable
      ? "2026-10-26T16:00:00.000Z"
      : null,
    configured_origin: remoteNetwork ? remoteOrigin : loopbackOrigin,
    network_mode: options.network,
    transport: remoteNetwork ? "https" : "http",
    locked: false,
    can_read_sessions: readable,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
  const host = readable && options.remote !== null
    ? hostStatus(access.network_mode, options.remote)
    : null;
  const target = Object.freeze({ kind: "mission_control" as const });
  const targetData = readable
    ? Object.freeze({
        kind: "mission_control" as const,
        access: Object.freeze({ mode: remoteNetwork ? "paired_read" as const : "loopback_read" as const }),
        sessions: Object.freeze([]),
        nextCursor: null,
        hasMore: false,
        pageCount: 1
      })
    : null;
  return Object.freeze({
    epoch: options.epoch ?? 1,
    target,
    phase: options.phase ?? (readable ? "ready" : "access_limited"),
    access: resource(options.accessState ?? "current", access),
    host: resource(options.hostState ?? (host === null ? "blocked" : "current"), host),
    targetState: resource(readable ? "current" : "blocked", targetData) as BrowserConnectionSnapshot["targetState"],
    stream: Object.freeze({
      state: "not_applicable" as const,
      snapshot: null,
      continuity: "not_applicable" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "idle" as const,
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: "not_bootstrapped" as const
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: false,
      causes: Object.freeze(["read_only_access" as const])
    }),
    lastFailure: null
  });
}

function hostStatus(
  network: "loopback" | "remote",
  remoteFixture: RemoteFixture
) {
  const mode = network === "remote" ? "paired_read" : "loopback_read";
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: "ready",
      readiness: "ready",
      updated_at: timestamp,
      components: selectedHostLocalHealthComponents.map((component) => ({
        component,
        state: "ready",
        checked_at: timestamp,
        causes: []
      })),
      mutation_admission: "open"
    },
    compatibility: {
      state: "supported",
      evidence: "current",
      observed_version: "0.144.0",
      supported_version: "0.144.0",
      capability_state: "verified",
      checked_at: timestamp,
      recorded_at: timestamp
    },
    remote: remoteStatus(remoteFixture),
    access: {
      mode,
      network_mode: network,
      transport: network === "remote" ? "https" : "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: false,
        causes: ["read_only_access"]
      }
    }
  });
}

function remoteStatus(fixture: RemoteFixture): SelectedHostRemoteStatus {
  if (fixture === "not_observed") {
    return {
      generation: 0,
      state_generation: null,
      availability: "unknown",
      cause: "not_observed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null,
      checked_at: null,
      updated_at: observedAt
    };
  }
  if (fixture === "ready") {
    return {
      generation: 4,
      state_generation: 4,
      availability: "ready",
      cause: null,
      external_origin: remoteOrigin,
      laptop_action_required: false,
      observed_at: observedAt,
      checked_at: observedAt,
      updated_at: observedAt
    };
  }
  const disabled = fixture === "remote_disabled" || fixture === "cleanup_incomplete";
  return {
    generation: 4,
    state_generation: 4,
    availability: disabled ? "disabled" : "unavailable",
    cause: fixture,
    external_origin: null,
    laptop_action_required: true,
    observed_at: observedAt,
    checked_at: observedAt,
    updated_at: observedAt
  };
}

function readyPublicStatus() {
  return remoteIngressPublicStateSchema.parse({
    generation: 4,
    availability: "ready",
    reason: null,
    external_origin: remoteOrigin,
    laptop_action_required: false,
    observed_at: timestamp
  });
}

function accessorRemoteStatusResponse(): object {
  const response = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(response, {
    status: { enumerable: true, value: 200 },
    data: { enumerable: true, get: () => readyPublicStatus() }
  });
  return response;
}

function resource<Data>(
  state: BrowserConnectionSnapshot["access"]["state"],
  data: Data | null
) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
