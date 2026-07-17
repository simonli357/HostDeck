import {
  type RemoteIngressPublicState,
  remoteIngressPublicStateSchema
} from "@hostdeck/contracts";
import { remoteIngressUnavailableReasons } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  assertHostDeckHostHealthService,
  createHostDeckHostHealthService,
  type HostDeckHostHealthService,
  type HostDeckLocalHealthComponent,
  type HostDeckLocalHealthState,
  type HostDeckReportedLocalHealthReason,
  hostDeckLocalHealthComponents,
  hostDeckRemoteHealthObservationFailureReasons,
  isHostDeckHostHealthError
} from "./host-health.js";

interface FakeClock {
  value: number;
  fail: boolean;
  calls: number;
}

const initialTime = Date.parse("2026-07-16T18:00:00.000Z");
const remoteOrigin = "https://hostdeck-laptop.tail295ac2.ts.net";

describe("mutable host health", () => {
  it("starts closed with exactly seven unknown local sources and independent unknown remote truth", () => {
    const { service, clock } = createService();
    const local = service.localSnapshot();
    const remote = service.remoteSnapshot();

    expect(clock.calls).toBe(1);
    expect(local).toEqual({
      generation: 0,
      state: "unknown",
      readiness: "not_ready",
      mutation_admission: "closed",
      updated_at: "2026-07-16T18:00:00.000Z",
      components: hostDeckLocalHealthComponents.map((component) => ({
        component,
        state: "unknown",
        source_generation: 0,
        checked_at: null,
        reasons: ["not_observed"]
      }))
    });
    expect(remote).toEqual({
      generation: 0,
      source_generation: 0,
      state_generation: null,
      availability: "unknown",
      reason: "not_observed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null,
      checked_at: null,
      updated_at: "2026-07-16T18:00:00.000Z"
    });
    expectDeepFrozen(local);
    expectDeepFrozen(remote);
    expect(Object.isFrozen(service)).toBe(true);
    expect(() => assertHostDeckHostHealthService(service)).not.toThrow();
    expect(() => assertHostDeckHostHealthService(Object.freeze({ ...service }))).toThrow(
      TypeError
    );
    expect(() => service.admitMutation()).toThrow(
      expect.objectContaining({
        code: "mutation_not_ready",
        api_code: "storage_error",
        retryable: true
      })
    );
  });

  it("requires every local source to be explicitly ready and invalidates proofs on any newer local check", () => {
    const { service } = createService();
    for (const [index, component] of hostDeckLocalHealthComponents.entries()) {
      const snapshot = service.updateLocal(localUpdate(component, index + 1));
      expect(snapshot.generation).toBe(index + 1);
      expect(snapshot.state).toBe(
        index === hostDeckLocalHealthComponents.length - 1 ? "ready" : "unknown"
      );
    }
    const ready = service.localSnapshot();
    expect(ready).toMatchObject({
      generation: 7,
      state: "ready",
      readiness: "ready",
      mutation_admission: "open"
    });
    expect(ready.components.every((component) => component.reasons.length === 0)).toBe(
      true
    );

    const proof = service.admitMutation();
    expect(proof).toEqual({ generation: 7 });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(service.assertMutation(proof)).toBe(ready);

    const rechecked = service.updateLocal(localUpdate("runtime", 20));
    expect(rechecked).toMatchObject({ generation: 8, state: "ready" });
    expect(() => service.assertMutation(proof)).toThrow(
      expect.objectContaining({ code: "mutation_state_changed" })
    );
    const freshProof = service.admitMutation();
    expect(freshProof.generation).toBe(8);
    expect(() => service.assertMutation(Object.freeze({ ...freshProof }))).toThrow(
      expect.objectContaining({ code: "invalid_mutation_proof" })
    );
  });

  it("uses deterministic failed, degraded, stale, unknown, ready aggregate precedence", () => {
    const { service } = createService();
    makeReady(service);

    expect(
      service.updateLocal(
        localUpdate("runtime", 2, "stale", ["source_stale"])
      ).state
    ).toBe("stale");
    expect(
      service.updateLocal(
        localUpdate("storage", 2, "degraded", ["retention_degraded"])
      ).state
    ).toBe("degraded");
    expect(
      service.updateLocal(
        localUpdate("listener", 2, "failed", ["listener_failed"])
      ).state
    ).toBe("failed");
    expect(
      service.updateLocal(localUpdate("listener", 3)).state
    ).toBe("degraded");
    expect(service.updateLocal(localUpdate("storage", 3)).state).toBe("stale");
    expect(
      service.updateLocal(
        localUpdate("runtime", 3, "unknown", ["source_unknown"])
      ).state
    ).toBe("unknown");
    expect(service.updateLocal(localUpdate("runtime", 4))).toMatchObject({
      state: "ready",
      readiness: "ready",
      mutation_admission: "open"
    });
  });

  it.each([
    ["storage", "degraded", "audit_reconciliation_degraded"],
    ["storage", "degraded", "retention_degraded"],
    ["storage", "failed", "startup_maintenance_failed"],
    ["storage", "failed", "storage_unavailable"],
    ["runtime", "degraded", "runtime_starting"],
    ["runtime", "degraded", "runtime_disconnected"],
    ["runtime", "degraded", "runtime_reconciling"],
    ["runtime", "failed", "runtime_failed"],
    ["compatibility", "unknown", "compatibility_unchecked"],
    ["compatibility", "degraded", "compatibility_degraded"],
    ["compatibility", "failed", "runtime_incompatible"],
    ["projector", "degraded", "projector_not_ready"],
    ["projector", "failed", "projector_failed"],
    ["fanout", "degraded", "fanout_not_ready"],
    ["fanout", "failed", "fanout_closed"],
    ["fanout", "failed", "fanout_failed"],
    ["listener", "degraded", "listener_not_ready"],
    ["listener", "degraded", "listener_draining"],
    ["listener", "failed", "listener_closed"],
    ["listener", "failed", "listener_failed"],
    ["lease", "failed", "lease_not_held"],
    ["lease", "failed", "lease_lost"],
    ["lease", "failed", "lease_failed"]
  ] satisfies ReadonlyArray<
    readonly [
      HostDeckLocalHealthComponent,
      HostDeckLocalHealthState,
      HostDeckReportedLocalHealthReason
    ]
  >)("accepts the bounded %s %s/%s source reason", (component, state, reason) => {
    const { service } = createService();
    const snapshot = service.updateLocal(localUpdate(component, 1, state, [reason]));
    expect(snapshot.components.find((entry) => entry.component === component)).toMatchObject({
      state,
      reasons: [reason]
    });
    expect(snapshot.mutation_admission).toBe("closed");
  });

  it("rejects malformed and contradictory local updates before clock or accessor evaluation", () => {
    const { service, clock } = createService();
    const calls = clock.calls;
    const invalid = [
      null,
      {},
      { ...localUpdate("storage", 1), extra: true },
      localUpdate("storage", 0),
      localUpdate("storage", 1, "ready", ["retention_degraded"]),
      localUpdate("storage", 1, "degraded", []),
      localUpdate("storage", 1, "degraded", ["runtime_disconnected"]),
      localUpdate("runtime", 1, "failed", ["runtime_disconnected"]),
      localUpdate("runtime", 1, "unknown", ["not_observed" as never]),
      localUpdate("runtime", 1, "unknown", ["source_unknown", "source_unknown"]),
      Object.assign(Object.create({}), localUpdate("storage", 1))
    ];
    for (const candidate of invalid) {
      expect(() => service.updateLocal(candidate as never)).toThrow(
        expect.objectContaining({ code: "invalid_update" })
      );
    }

    let accessorCalls = 0;
    const accessor = Object.defineProperty(
      {
        component: "storage",
        reasons: [],
        source_generation: 1
      },
      "state",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return "ready";
        }
      }
    );
    expect(() => service.updateLocal(accessor as never)).toThrow(
      expect.objectContaining({ code: "invalid_update" })
    );
    expect(accessorCalls).toBe(0);
    expect(clock.calls).toBe(calls);
    expect(service.localSnapshot().generation).toBe(0);
  });

  it("makes newer source completion authoritative and treats equal truth as idempotent", () => {
    const { service, clock } = createService();
    const first = service.updateLocal(localUpdate("runtime", 10));
    const calls = clock.calls;
    expect(service.updateLocal(localUpdate("runtime", 10))).toBe(first);
    expect(clock.calls).toBe(calls);
    expect(() =>
      service.updateLocal(
        localUpdate("runtime", 10, "degraded", ["runtime_disconnected"])
      )
    ).toThrow(expect.objectContaining({ code: "source_conflict" }));
    expect(() => service.updateLocal(localUpdate("runtime", 9))).toThrow(
      expect.objectContaining({ code: "source_regression" })
    );

    const newerFailure = service.updateLocal(
      localUpdate("runtime", 12, "degraded", ["runtime_disconnected"])
    );
    expect(newerFailure.components[1]).toMatchObject({
      source_generation: 12,
      state: "degraded",
      reasons: ["runtime_disconnected"]
    });
    expect(() => service.updateLocal(localUpdate("runtime", 11))).toThrow(
      expect.objectContaining({ code: "source_regression" })
    );
    const recovered = service.updateLocal(localUpdate("runtime", 13));
    expect(recovered.components[1]).toMatchObject({
      source_generation: 13,
      state: "ready",
      reasons: []
    });
    expect(JSON.stringify(recovered)).not.toContain("runtime_disconnected");

    const exhausted = createService().service;
    exhausted.updateLocal(
      localUpdate("runtime", Number.MAX_SAFE_INTEGER)
    );
    expect(() =>
      exhausted.updateLocal(
        localUpdate("runtime", Number.MAX_SAFE_INTEGER - 1)
      )
    ).toThrow(expect.objectContaining({ code: "generation_exhausted" }));
  });

  it("rejects clock regression and failure atomically while allowing equal timestamps", () => {
    const { service, clock } = createService();
    const first = service.updateLocal(localUpdate("storage", 1));
    expect(first.generation).toBe(1);
    const callsAfterFirst = clock.calls;

    clock.value = initialTime - 1;
    expect(() => service.updateLocal(localUpdate("runtime", 1))).toThrow(
      expect.objectContaining({ code: "clock_invalid" })
    );
    expect(service.localSnapshot()).toBe(first);
    expect(clock.calls).toBe(callsAfterFirst + 1);

    clock.value = initialTime;
    expect(service.updateLocal(localUpdate("runtime", 1)).generation).toBe(2);
    const beforeFailure = service.localSnapshot();
    clock.fail = true;
    expect(() => service.updateLocal(localUpdate("compatibility", 1))).toThrow(
      expect.objectContaining({ code: "clock_invalid" })
    );
    expect(service.localSnapshot()).toBe(beforeFailure);
  });

  it("blocks fake dispatch after a local failure and maps compatibility failure distinctly", () => {
    const { service } = createService();
    makeReady(service);
    const proof = service.admitMutation();
    service.updateLocal(
      localUpdate("compatibility", 2, "failed", ["runtime_incompatible"])
    );

    let dispatchCalls = 0;
    try {
      service.assertMutation(proof);
      dispatchCalls += 1;
    } catch (error) {
      expect(error).toMatchObject({
        code: "mutation_state_changed",
        api_code: "incompatible_runtime",
        retryable: false
      });
    }
    expect(dispatchCalls).toBe(0);
    expect(() => service.admitMutation()).toThrow(
      expect.objectContaining({
        code: "mutation_not_ready",
        api_code: "incompatible_runtime",
        retryable: false
      })
    );

    const other = createService().service;
    makeReady(other);
    expect(() => other.assertMutation(proof)).toThrow(
      expect.objectContaining({ code: "invalid_mutation_proof" })
    );
  });

  it("updates remote disabled, ready, failure, and recovery without touching local truth or proof", () => {
    const { service } = createService();
    makeReady(service);
    const local = service.localSnapshot();
    const proof = service.admitMutation();

    expect(service.updateRemote({ source_generation: 1, state: disabledRemote() })).toMatchObject({
      generation: 1,
      source_generation: 1,
      state_generation: 0,
      availability: "disabled",
      reason: "remote_disabled",
      external_origin: null
    });
    const ready = service.updateRemote({
      source_generation: 2,
      state: readyRemote(4)
    });
    expect(ready).toMatchObject({
      generation: 2,
      source_generation: 2,
      state_generation: 4,
      availability: "ready",
      reason: null,
      external_origin: remoteOrigin
    });
    const failed = service.failRemote({
      source_generation: 3,
      reason: "observation_failed"
    });
    expect(failed).toMatchObject({
      generation: 3,
      state_generation: null,
      availability: "unavailable",
      reason: "observation_failed",
      external_origin: null,
      observed_at: null
    });
    expect(JSON.stringify(failed)).not.toContain(remoteOrigin);
    expect(() =>
      service.updateRemote({ source_generation: 2, state: readyRemote(4) })
    ).toThrow(expect.objectContaining({ code: "source_regression" }));
    expect(
      service.updateRemote({ source_generation: 4, state: readyRemote(4) })
    ).toMatchObject({ availability: "ready", external_origin: remoteOrigin });

    expect(service.localSnapshot()).toBe(local);
    expect(service.assertMutation(proof)).toBe(local);
  });

  it.each(
    remoteIngressUnavailableReasons.filter(
      (reason) => reason !== "cleanup_incomplete"
    )
  )("retains bounded remote-unavailable reason %s without local degradation", (reason) => {
    const { service } = createService();
    makeReady(service);
    const local = service.localSnapshot();
    const proof = service.admitMutation();
    const remote = service.updateRemote({
      source_generation: 1,
      state: unavailableRemote(reason)
    });
    expect(remote).toMatchObject({
      availability: "unavailable",
      reason,
      external_origin: null,
      laptop_action_required: true
    });
    expect(service.localSnapshot()).toBe(local);
    expect(service.assertMutation(proof)).toBe(local);
  });

  it.each(hostDeckRemoteHealthObservationFailureReasons)(
    "clears prior remote ready fields for observer failure %s",
    (reason) => {
      const { service } = createService();
      service.updateRemote({ source_generation: 1, state: readyRemote(2) });
      const failed = service.failRemote({ source_generation: 2, reason });
      expect(failed).toMatchObject({
        availability: "unavailable",
        reason,
        state_generation: null,
        external_origin: null,
        observed_at: null
      });
      expect(JSON.stringify(failed)).not.toContain(remoteOrigin);
    }
  );

  it("applies remote source ordering, conflict, exhaustion, and nested accessor rejection", () => {
    const { service, clock } = createService();
    const state = readyRemote(1);
    const first = service.updateRemote({ source_generation: 10, state });
    const calls = clock.calls;
    expect(service.updateRemote({ source_generation: 10, state: readyRemote(1) })).toBe(
      first
    );
    expect(clock.calls).toBe(calls);
    expect(() =>
      service.failRemote({ source_generation: 10, reason: "observation_failed" })
    ).toThrow(expect.objectContaining({ code: "source_conflict" }));
    expect(() =>
      service.updateRemote({ source_generation: 9, state: readyRemote(1) })
    ).toThrow(expect.objectContaining({ code: "source_regression" }));
    service.updateRemote({ source_generation: 11, state: readyRemote(3) });
    const beforeDurableRegression = service.remoteSnapshot();
    expect(() =>
      service.updateRemote({ source_generation: 12, state: readyRemote(2) })
    ).toThrow(expect.objectContaining({ code: "source_regression" }));
    expect(service.remoteSnapshot()).toBe(beforeDurableRegression);

    let accessorCalls = 0;
    const hostile = Object.defineProperty(
      {
        availability: "ready",
        external_origin: remoteOrigin,
        generation: 2,
        laptop_action_required: false,
        observed_at: "2026-07-16T18:00:00.000Z",
        reason: null
      },
      "generation",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return 2;
        }
      }
    );
    expect(() =>
      service.updateRemote({ source_generation: 12, state: hostile as never })
    ).toThrow(expect.objectContaining({ code: "invalid_update" }));
    expect(accessorCalls).toBe(0);

    const exhausted = createService().service;
    exhausted.updateRemote({
      source_generation: Number.MAX_SAFE_INTEGER,
      state: disabledRemote()
    });
    expect(() =>
      exhausted.updateRemote({
        source_generation: Number.MAX_SAFE_INTEGER - 1,
        state: disabledRemote()
      })
    ).toThrow(expect.objectContaining({ code: "generation_exhausted" }));
  });

  it("keeps snapshots and errors bounded, frozen, and free of private source data", () => {
    const { service } = createService();
    service.updateLocal(
      localUpdate("runtime", 1, "degraded", ["runtime_disconnected"])
    );
    const error = captureError(() => service.updateLocal(localUpdate("runtime", 0)));
    expect(isHostDeckHostHealthError(error)).toBe(true);
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.hasOwn(error as object, "cause")).toBe(false);

    const serialized = JSON.stringify({
      local: service.localSnapshot(),
      remote: service.remoteSnapshot(),
      error
    });
    for (const sentinel of [
      "private prompt",
      "tskey-",
      "nodekey:",
      "sha256:private-profile",
      "dev_private",
      "sess_private"
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expectDeepFrozen(service.localSnapshot());
    expectDeepFrozen(service.remoteSnapshot());
  });

  it("rejects invalid factory clocks and option accessors without invoking them", () => {
    const invalid = [
      null,
      {},
      { now: () => new Date(initialTime), extra: true },
      { now: 1 },
      { now: () => "2026-07-16T18:00:00.000Z" },
      { now: () => new Date(Number.NaN) }
    ];
    for (const candidate of invalid) {
      expect(() => createHostDeckHostHealthService(candidate as never)).toThrow(
        expect.objectContaining({ code: "configuration_invalid" })
      );
    }
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "now", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return () => new Date(initialTime);
      }
    });
    expect(() => createHostDeckHostHealthService(accessor as never)).toThrow(
      expect.objectContaining({ code: "configuration_invalid" })
    );
    expect(accessorCalls).toBe(0);
  });
});

function createService(): {
  readonly service: HostDeckHostHealthService;
  readonly clock: FakeClock;
} {
  const clock: FakeClock = { value: initialTime, fail: false, calls: 0 };
  const service = createHostDeckHostHealthService({
    now: () => {
      clock.calls += 1;
      if (clock.fail) throw new Error("private clock failure");
      return new Date(clock.value);
    }
  });
  return { service, clock };
}

function localUpdate(
  component: HostDeckLocalHealthComponent,
  sourceGeneration: number,
  state: HostDeckLocalHealthState = "ready",
  reasons: readonly HostDeckReportedLocalHealthReason[] = []
) {
  return {
    component,
    reasons: [...reasons],
    source_generation: sourceGeneration,
    state
  };
}

function makeReady(service: HostDeckHostHealthService): void {
  for (const component of hostDeckLocalHealthComponents) {
    service.updateLocal(localUpdate(component, 1));
  }
}

function disabledRemote(): RemoteIngressPublicState {
  return remoteIngressPublicStateSchema.parse({
    generation: 0,
    availability: "disabled",
    reason: "remote_disabled",
    external_origin: null,
    laptop_action_required: true,
    observed_at: null
  });
}

function readyRemote(generation: number): RemoteIngressPublicState {
  return remoteIngressPublicStateSchema.parse({
    generation,
    availability: "ready",
    reason: null,
    external_origin: remoteOrigin,
    laptop_action_required: false,
    observed_at: "2026-07-16T18:00:00.000Z"
  });
}

function unavailableRemote(
  reason: Exclude<
    (typeof remoteIngressUnavailableReasons)[number],
    "cleanup_incomplete"
  >
): RemoteIngressPublicState {
  return remoteIngressPublicStateSchema.parse({
    generation: 2,
    availability: "unavailable",
    reason,
    external_origin: null,
    laptop_action_required: true,
    observed_at: null
  });
}

function expectDeepFrozen(candidate: unknown): void {
  if (candidate === null || typeof candidate !== "object") return;
  expect(Object.isFrozen(candidate)).toBe(true);
  for (const value of Object.values(candidate)) expectDeepFrozen(value);
}

function captureError(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}
