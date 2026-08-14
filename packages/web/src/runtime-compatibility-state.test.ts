import {
  type SelectedAccessStateResponse,
  type SelectedHostCompatibilityState,
  type SelectedHostLocalHealthCause,
  type SelectedHostLocalHealthComponent,
  type SelectedHostLocalHealthState,
  type SelectedHostStatusResponse,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionPhase,
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionTarget
} from "./connection-state.js";
import {
  createRuntimeCompatibilityController,
  projectRuntimeCompatibility
} from "./runtime-compatibility-state.js";

const remoteOrigin = "https://hostdeck-compatibility.fixture-tailnet.ts.net";
const firstTimestamp = "2026-07-27T15:00:00.000Z";
const secondTimestamp = "2026-07-27T15:01:00.000Z";

describe("runtime compatibility state", () => {
  it("projects all six selected states without inferring a favorable result", () => {
    const expected = {
      supported: {
        title: "Codex compatible",
        tone: "connected",
        evidence: "current",
        capability: "Verified",
        visible: false
      },
      degraded: {
        title: "Codex compatibility limited",
        tone: "attention",
        evidence: "current",
        capability: "Limited",
        visible: true
      },
      incompatible: {
        title: "Codex interface incompatible",
        tone: "danger",
        evidence: "current",
        capability: "Blocked",
        visible: true
      },
      unknown: {
        title: "Codex compatibility not checked",
        tone: "attention",
        evidence: "unobserved",
        capability: "Unverified",
        visible: true
      },
      disconnected: {
        title: "Codex runtime disconnected",
        tone: "attention",
        evidence: "last_known",
        capability: "Unverified",
        visible: true
      },
      version_drift: {
        title: "Codex update required",
        tone: "danger",
        evidence: "current",
        capability: "Blocked",
        visible: true
      }
    } as const;

    for (const state of compatibilityStates) {
      const view = projectRuntimeCompatibility(snapshot({ state }));
      expect(view.phase, state).toBe(state);
      expect(view.state, state).toBe(state);
      expect(view.title, state).toBe(expected[state].title);
      expect(view.tone, state).toBe(expected[state].tone);
      expect(view.evidence, state).toBe(expected[state].evidence);
      expect(view.capabilityLabel, state).toBe(expected[state].capability);
      expect(view.routeVisible, state).toBe(expected[state].visible);
      expect(view.action, state).toBe("check_compatibility");
      expect(view.actionEnabled, state).toBe(true);
      expect(Object.isFrozen(view), state).toBe(true);
    }
  });

  it("keeps version drift distinct from exact-version interface incompatibility", () => {
    const drift = projectRuntimeCompatibility(snapshot({ state: "version_drift" }));
    expect(drift).toMatchObject({
      observedVersion: "0.145.0",
      supportedVersion: "0.147.0",
      observedVersionLabel: "0.145.0",
      supportedVersionLabel: "0.147.0"
    });
    expect(drift.detail).toContain("This laptop has Codex 0.145.0");
    expect(drift.detail).toContain("HostDeck supports 0.147.0");

    const incompatible = projectRuntimeCompatibility(snapshot({ state: "incompatible" }));
    expect(incompatible).toMatchObject({
      observedVersion: "0.147.0",
      supportedVersion: "0.147.0",
      title: "Codex interface incompatible"
    });
    expect(incompatible.detail).toContain("required HostDeck controls");
    expect(incompatible.detail).not.toContain("This laptop has Codex");
    expect(incompatible.title).not.toContain("update required");
  });

  it("distinguishes degraded and unknown evidence products", () => {
    const retainedDegraded = projectRuntimeCompatibility(
      snapshot({ state: "degraded", evidence: "last_known" })
    );
    expect(retainedDegraded).toMatchObject({
      phase: "degraded",
      evidence: "last_known",
      capabilityState: "unverified",
      title: "Codex compatibility is stale",
      current: false
    });

    const retainedUnknown = projectRuntimeCompatibility(
      snapshot({ state: "unknown", evidence: "last_known" })
    );
    expect(retainedUnknown).toMatchObject({
      phase: "unknown",
      evidence: "last_known",
      observedVersionLabel: "0.147.0",
      title: "Codex compatibility unknown"
    });

    const unobserved = projectRuntimeCompatibility(snapshot({ state: "unknown" }));
    expect(unobserved).toMatchObject({
      evidence: "unobserved",
      observedVersion: null,
      observedVersionLabel: "Not observed",
      checkedAt: null,
      recordedAt: null,
      checkedLabel: "Not checked"
    });
  });

  it("downgrades every retained host report when browser freshness is stale", () => {
    for (const state of compatibilityStates) {
      const view = projectRuntimeCompatibility(
        snapshot({ state, hostState: "stale", phase: "degraded" })
      );
      expect(view.current, state).toBe(false);
      expect(view.tone, state).toBe("attention");
      expect(view.routeVisible, state).toBe(true);
      expect(view.capabilityState, state).toBe("unverified");
      expect(view.capabilityLabel, state).toBe("Unverified");
      expect(view.sourceLabel, state).toBe("Last known browser data");
      expect(view.title.toLowerCase(), state).toContain("stale");
    }
  });

  it("hides and purges protected detail after authority loss or close", () => {
    const denied = projectRuntimeCompatibility(
      snapshot({ state: "version_drift", readable: false, host: null })
    );
    expect(denied).toMatchObject({
      phase: "hidden",
      state: null,
      observedVersion: null,
      supportedVersion: null,
      action: null,
      routeVisible: false
    });
    expect(JSON.stringify(denied)).not.toContain("0.145.0");

    const localAdmin = projectRuntimeCompatibility(
      snapshot({ state: "version_drift", authority: "local_admin" })
    );
    expect(localAdmin.phase).toBe("hidden");
    expect(localAdmin.observedVersion).toBeNull();

    const closed = projectRuntimeCompatibility(
      snapshot({ state: "version_drift", phase: "closed" })
    );
    expect(closed).toMatchObject({
      phase: "closed",
      observedVersion: null,
      supportedVersion: null,
      action: null
    });
  });

  it("keeps loading and unavailable host status non-healthy", () => {
    const loading = projectRuntimeCompatibility(
      snapshot({ host: null, hostState: "loading", phase: "loading" })
    );
    expect(loading).toMatchObject({
      phase: "loading",
      state: null,
      current: false,
      routeVisible: false,
      actionEnabled: true
    });

    const unavailable = projectRuntimeCompatibility(
      snapshot({ host: null, hostState: "failed", phase: "degraded" })
    );
    expect(unavailable).toMatchObject({
      phase: "unavailable",
      current: false,
      routeVisible: true,
      tone: "danger",
      actionEnabled: true
    });
  });

  it("formats only bounded public fields and rejects invalid host contracts", () => {
    const view = projectRuntimeCompatibility(snapshot({ state: "supported" }));
    expect(view.checkedLabel).toBe("Checked Jul 27, 2026, 3:00 PM UTC");
    expect(JSON.stringify(view)).not.toMatch(
      /binding_id|capabilities|runtime_incompatible|\/home\/private|socket|process|operation_id|device_fixture_phone/iu
    );

    const valid = snapshot({ state: "supported" });
    const invalidHost = {
      ...valid.host.data,
      compatibility: {
        ...valid.host.data?.compatibility,
        private_reason: "/home/private/codex"
      }
    } as unknown as SelectedHostStatusResponse;
    expect(() => projectRuntimeCompatibility(
      Object.freeze({
        ...valid,
        host: resource("current", invalidHost, firstTimestamp)
      })
    )).toThrow("HostDeck compatibility host status is invalid.");
  });

  it("uses one refresh, coalesces duplicates, and accepts a newer supported recovery", async () => {
    const start = snapshot({ state: "version_drift", timestamp: firstTimestamp });
    const next = snapshot({ state: "supported", timestamp: secondTimestamp, epoch: 2 });
    const harness = refreshHarness(start);
    const controller = createRuntimeCompatibilityController({ port: harness.port });

    const first = controller.check();
    const duplicate = controller.check();
    expect(duplicate).toBe(first);
    expect(controller.snapshot()).toMatchObject({
      phase: "checking",
      busy: true,
      actionEnabled: false
    });
    await flushMicrotasks();
    expect(harness.refresh).toHaveBeenCalledTimes(1);

    harness.resolve(next);
    await expect(first).resolves.toMatchObject({
      phase: "supported",
      title: "Codex compatibility restored",
      current: true,
      recordedAt: secondTimestamp
    });
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it("does not call a same or older revision a recovery", async () => {
    for (const resultTimestamp of [firstTimestamp, "2026-07-27T14:59:00.000Z"]) {
      const start = snapshot({ state: "incompatible", timestamp: firstTimestamp });
      const next = snapshot({ state: "supported", timestamp: resultTimestamp, epoch: 2 });
      const harness = refreshHarness(start);
      const controller = createRuntimeCompatibilityController({ port: harness.port });
      const pending = controller.check();
      await flushMicrotasks();
      harness.resolve(next);
      await expect(pending).resolves.toMatchObject({
        phase: "recovery_unconfirmed",
        state: "incompatible",
        title: "Compatibility recovery not confirmed",
        observedVersion: "0.147.0",
        actionEnabled: true
      });
      expect(controller.snapshot().detail).toContain("newer supported laptop record");
      controller.close();
    }
  });

  it("allows unobserved recovery and does not label a supported recheck as recovery", async () => {
    const unknownHarness = refreshHarness(snapshot({ state: "unknown" }));
    const unknownController = createRuntimeCompatibilityController({
      port: unknownHarness.port
    });
    const unknownCheck = unknownController.check();
    await flushMicrotasks();
    unknownHarness.resolve(snapshot({ state: "supported", timestamp: secondTimestamp, epoch: 2 }));
    await expect(unknownCheck).resolves.toMatchObject({
      title: "Codex compatibility restored"
    });
    unknownController.close();

    const supportedHarness = refreshHarness(snapshot({ state: "supported" }));
    const supportedController = createRuntimeCompatibilityController({
      port: supportedHarness.port
    });
    const supportedCheck = supportedController.check();
    await flushMicrotasks();
    supportedHarness.resolve(snapshot({ state: "supported", epoch: 2 }));
    await expect(supportedCheck).resolves.toMatchObject({
      title: "Codex compatible",
      actionLabel: "Recheck compatibility"
    });
    supportedController.close();
  });

  it("completes a current host read even when capability evidence stays last known", async () => {
    const harness = refreshHarness(snapshot({ state: "disconnected" }));
    const controller = createRuntimeCompatibilityController({ port: harness.port });
    const pending = controller.check();
    await flushMicrotasks();
    harness.resolve(snapshot({ state: "disconnected", epoch: 2 }));
    await expect(pending).resolves.toMatchObject({
      phase: "disconnected",
      evidence: "last_known",
      current: false,
      title: "Codex runtime disconnected"
    });
    controller.close();
  });

  it("shows one private-free failure and requires a new human retry", async () => {
    const harness = refreshHarness(snapshot({ state: "version_drift" }));
    const controller = createRuntimeCompatibilityController({ port: harness.port });
    const first = controller.check();
    await flushMicrotasks();
    harness.publish(snapshot({
      state: "version_drift",
      epoch: 2,
      hostState: "failed",
      phase: "degraded"
    }));
    harness.reject(new Error("PRIVATE /home/private/codex output"));
    await expect(first).resolves.toMatchObject({
      phase: "check_failed",
      title: "Compatibility check not confirmed",
      actionEnabled: true
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("PRIVATE");
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(harness.refresh).toHaveBeenCalledTimes(1);

    const retry = controller.check();
    await flushMicrotasks();
    expect(harness.refresh).toHaveBeenCalledTimes(2);
    harness.resolve(snapshot({ state: "version_drift", epoch: 3 }));
    await expect(retry).resolves.toMatchObject({ phase: "version_drift" });
    controller.close();
  });

  it("suppresses target and authority races without starting another read", async () => {
    const targetHarness = refreshHarness(snapshot({ state: "incompatible" }));
    const targetController = createRuntimeCompatibilityController({
      port: targetHarness.port
    });
    const targetCheck = targetController.check();
    await flushMicrotasks();
    targetHarness.publish(snapshot({
      state: "incompatible",
      epoch: 3,
      target: Object.freeze({ kind: "session_detail", sessionId: "sess_other" })
    }));
    targetController.synchronize();
    await expect(targetCheck).resolves.toMatchObject({ phase: "incompatible" });
    expect(targetHarness.refresh).toHaveBeenCalledTimes(1);
    targetHarness.reject(new Error("suppressed"));
    targetController.close();

    const authorityHarness = refreshHarness(snapshot({ state: "version_drift" }));
    const authorityController = createRuntimeCompatibilityController({
      port: authorityHarness.port
    });
    const authorityCheck = authorityController.check();
    await flushMicrotasks();
    authorityHarness.publish(snapshot({
      state: "version_drift",
      epoch: 2,
      readable: false,
      host: null
    }));
    authorityController.synchronize();
    await expect(authorityCheck).resolves.toMatchObject({
      phase: "hidden",
      observedVersion: null,
      supportedVersion: null
    });
    authorityHarness.reject(new Error("suppressed private"));
    authorityController.close();
  });

  it("settles close, bounds listeners, and rejects hostile ports", async () => {
    const harness = refreshHarness(snapshot({ state: "supported" }));
    const controller = createRuntimeCompatibilityController({ port: harness.port });
    const listener = vi.fn();
    const releases = [controller.subscribe(listener)];
    expect(() => controller.subscribe(listener)).toThrow("listener is invalid");
    for (let index = 1; index < 32; index += 1) {
      releases.push(controller.subscribe(vi.fn()));
    }
    expect(() => controller.subscribe(vi.fn())).toThrow("capacity is exhausted");
    releases.forEach((release) => {
      release();
    });

    const pending = controller.check();
    await flushMicrotasks();
    expect(controller.close()).toMatchObject({
      phase: "closed",
      observedVersion: null,
      supportedVersion: null
    });
    await expect(pending).resolves.toMatchObject({ phase: "closed" });
    harness.reject(new Error("closed private"));
    expect(() => controller.subscribe(vi.fn())).toThrow("listener is invalid");

    expect(() => createRuntimeCompatibilityController({} as never)).toThrow(
      "compatibility options are invalid"
    );
    expect(() => createRuntimeCompatibilityController({
      port: { snapshot: () => snapshot(), refresh: (() => undefined) as never },
      extra: true
    } as never)).toThrow("compatibility options are invalid");
    const throwingPort = Object.defineProperty({}, "snapshot", {
      enumerable: true,
      get: () => {
        throw new Error("private getter");
      }
    });
    Object.defineProperty(throwingPort, "refresh", {
      enumerable: true,
      value: vi.fn()
    });
    expect(() => createRuntimeCompatibilityController({ port: throwingPort } as never))
      .toThrow("compatibility options are invalid");
  });

  it("rejects mutable projector snapshots and non-promise refresh results", async () => {
    expect(() => projectRuntimeCompatibility({ ...snapshot() })).toThrow(
      "compatibility snapshot is invalid"
    );
    let current = snapshot();
    const controller = createRuntimeCompatibilityController({
      port: {
        snapshot: () => current,
        refresh: (() => {
          current = snapshot({ epoch: 2 });
          return undefined;
        }) as never
      }
    });
    await expect(controller.check()).resolves.toMatchObject({ phase: "check_failed" });
    controller.close();
  });
});

const compatibilityStates = [
  "supported",
  "degraded",
  "incompatible",
  "unknown",
  "disconnected",
  "version_drift"
] as const satisfies readonly SelectedHostCompatibilityState[];

function snapshot(options: {
  readonly state?: SelectedHostCompatibilityState;
  readonly evidence?: "current" | "last_known";
  readonly timestamp?: string;
  readonly epoch?: number;
  readonly hostState?: BrowserConnectionResourceState;
  readonly phase?: BrowserConnectionPhase;
  readonly readable?: boolean;
  readonly authority?: "paired" | "local_admin";
  readonly host?: SelectedHostStatusResponse | null;
  readonly target?: BrowserConnectionTarget;
} = {}): BrowserConnectionSnapshot {
  const state = options.state ?? "supported";
  const timestamp = options.timestamp ?? firstTimestamp;
  const readable = options.readable ?? true;
  const authority = options.authority ?? "paired";
  const access = accessState(readable, authority);
  const host = options.host === undefined && readable
    ? hostStatus(state, timestamp, options.evidence)
    : options.host ?? null;
  const hostState = options.hostState ?? (host === null ? "blocked" : "current");
  const nonReady = state !== "supported" || hostState !== "current";
  return Object.freeze({
    epoch: options.epoch ?? 1,
    target: options.target ?? Object.freeze({ kind: "mission_control" as const }),
    phase: options.phase ?? phaseFor(state, readable, hostState),
    access: resource("current", access, timestamp),
    host: resource(hostState, host, timestamp),
    targetState: resource(
      readable ? "current" : "blocked",
      readable
        ? Object.freeze({
            kind: "mission_control" as const,
            access: Object.freeze({
              mode: "paired_write" as const,
              network_mode: "remote" as const,
              transport: "https" as const
            }),
            sessions: Object.freeze([]),
            nextCursor: null,
            hasMore: false,
            pageCount: 1
          })
        : null,
      timestamp
    ) as BrowserConnectionSnapshot["targetState"],
    stream: Object.freeze({
      state: "not_applicable" as const,
      snapshot: null,
      continuity: "not_applicable" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "ready" as const,
      generation: 1,
      rotatedAt: timestamp,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: readable && !nonReady,
      causes: Object.freeze(
        readable ? (nonReady ? ["host_not_ready" as const] : []) : ["permission_denied" as const]
      )
    }),
    lastFailure: null
  });
}

function phaseFor(
  state: SelectedHostCompatibilityState,
  readable: boolean,
  hostState: BrowserConnectionResourceState
): BrowserConnectionPhase {
  if (!readable) return "access_limited";
  if (hostState === "loading") return "loading";
  if (hostState !== "current") return "degraded";
  if (state === "version_drift" || state === "incompatible") return "incompatible";
  if (state === "disconnected") return "offline";
  if (state === "supported") return "ready";
  return "degraded";
}

function accessState(
  readable: boolean,
  authority: "paired" | "local_admin"
): SelectedAccessStateResponse {
  const localAdmin = authority === "local_admin";
  return selectedAccessStateResponseSchema.parse({
    authentication_state: localAdmin ? "local_admin" : readable ? "paired_device" : "revoked_device",
    device_id: localAdmin || !readable ? null : "device_fixture_phone",
    permission: localAdmin ? "local_admin" : readable ? "write" : null,
    device_expires_at: localAdmin || !readable ? null : "2026-08-27T15:00:00.000Z",
    configured_origin: localAdmin ? "http://127.0.0.1:4175" : remoteOrigin,
    network_mode: localAdmin ? "loopback" : "remote",
    transport: localAdmin ? "http" : "https",
    locked: false,
    can_read_sessions: readable,
    can_write_sessions: readable,
    can_lock: readable,
    can_unlock: localAdmin
  });
}

function hostStatus(
  state: SelectedHostCompatibilityState,
  timestamp: string,
  requestedEvidence?: "current" | "last_known"
): SelectedHostStatusResponse {
  const evidence = requestedEvidence ?? defaultEvidence(state);
  const componentOverrides = healthOverrides(state);
  const components = selectedHostLocalHealthComponents.map((component) => {
    const override = componentOverrides.get(component);
    return {
      component,
      state: override?.state ?? "ready",
      checked_at: timestamp,
      causes: override === undefined ? [] : [override.cause]
    };
  });
  const localState = aggregateState(components.map(({ state: value }) => value));
  const localReady = localState === "ready";
  const unobserved = state === "unknown" && requestedEvidence === undefined;
  const capabilityState = state === "supported"
    ? "verified"
    : state === "version_drift" || state === "incompatible"
      ? "blocked"
      : state === "degraded" && evidence === "current"
        ? "limited"
        : "unverified";
  const observedVersion = unobserved ? null : state === "version_drift" ? "0.145.0" : "0.147.0";

  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: localState,
      readiness: localReady ? "ready" : "not_ready",
      updated_at: timestamp,
      components,
      mutation_admission: localReady ? "open" : "closed"
    },
    compatibility: {
      state,
      evidence: unobserved ? "unobserved" : evidence,
      observed_version: observedVersion,
      supported_version: "0.147.0",
      capability_state: capabilityState,
      checked_at: unobserved ? null : timestamp,
      recorded_at: unobserved ? null : timestamp
    },
    remote: {
      generation: 1,
      state_generation: 1,
      availability: "ready",
      cause: null,
      external_origin: remoteOrigin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode: "paired_write",
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: localReady,
        causes: localReady ? [] : ["host_not_ready"]
      }
    }
  });
}

function defaultEvidence(
  state: SelectedHostCompatibilityState
): "current" | "last_known" {
  return state === "disconnected" ? "last_known" : "current";
}

function healthOverrides(state: SelectedHostCompatibilityState): Map<
  SelectedHostLocalHealthComponent,
  Readonly<{ state: SelectedHostLocalHealthState; cause: SelectedHostLocalHealthCause }>
> {
  const overrides = new Map<
    SelectedHostLocalHealthComponent,
    Readonly<{ state: SelectedHostLocalHealthState; cause: SelectedHostLocalHealthCause }>
  >();
  if (state === "version_drift" || state === "incompatible") {
    overrides.set("runtime", { state: "failed", cause: "runtime_failed" });
    overrides.set("compatibility", { state: "failed", cause: "runtime_incompatible" });
  } else if (state === "disconnected") {
    overrides.set("runtime", { state: "degraded", cause: "runtime_disconnected" });
    overrides.set("compatibility", { state: "degraded", cause: "compatibility_degraded" });
  } else if (state === "degraded") {
    overrides.set("runtime", { state: "degraded", cause: "runtime_reconciling" });
    overrides.set("compatibility", { state: "degraded", cause: "compatibility_degraded" });
  } else if (state === "unknown") {
    overrides.set("compatibility", { state: "unknown", cause: "compatibility_unchecked" });
  }
  return overrides;
}

function aggregateState(states: readonly SelectedHostLocalHealthState[]): SelectedHostLocalHealthState {
  for (const state of ["failed", "degraded", "stale", "unknown"] as const) {
    if (states.includes(state)) return state;
  }
  return "ready";
}

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null,
  observedAt: string
) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : observedAt
  });
}

function refreshHarness(initial: BrowserConnectionSnapshot) {
  let current = initial;
  let pending = deferred<BrowserConnectionSnapshot>();
  const refresh = vi.fn(() => {
    current = Object.freeze({
      ...current,
      epoch: current.epoch + 1,
      phase: "loading" as const,
      access: resource("loading", current.access.data, firstTimestamp),
      host: resource("loading", current.host.data, firstTimestamp),
      targetState: resource("loading", current.targetState.data, firstTimestamp)
    });
    return pending.promise;
  });
  return {
    port: Object.freeze({ snapshot: () => current, refresh }),
    refresh,
    publish(next: BrowserConnectionSnapshot) {
      current = next;
    },
    resolve(next: BrowserConnectionSnapshot) {
      current = next;
      pending.resolve(next);
      pending = deferred<BrowserConnectionSnapshot>();
    },
    reject(error: unknown) {
      pending.reject(error);
      pending = deferred<BrowserConnectionSnapshot>();
    }
  };
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
