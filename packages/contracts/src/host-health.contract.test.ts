import { describe, expect, it } from "vitest";
import {
  isSelectedHostLocalHealthCauseValid,
  selectedHostAccessModes,
  selectedHostAccessStatusSchema,
  selectedHostAggregateLocalHealthState,
  selectedHostLocalHealthCauses,
  selectedHostLocalHealthComponents,
  selectedHostLocalHealthStates,
  selectedHostRemoteObservationFailureCauses,
  selectedHostStatusResponseSchema,
  selectedHostWriteEligibilityCauses,
  selectedLivenessResponseSchema,
  selectedReadinessResponseSchema
} from "./host-health.js";

const timestamp = "2026-07-16T20:00:00.000Z";
const laterTimestamp = "2026-07-16T20:01:00.000Z";
const remoteOrigin = "https://hostdeck-health.fixture-tailnet.ts.net";

describe("selected host health contracts", () => {
  it("owns one frozen component, state, cause, remote-failure, access, and write vocabulary", () => {
    for (const values of [
      selectedHostLocalHealthComponents,
      selectedHostLocalHealthStates,
      selectedHostLocalHealthCauses,
      selectedHostRemoteObservationFailureCauses,
      selectedHostAccessModes,
      selectedHostWriteEligibilityCauses
    ]) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }

    expect(selectedHostLocalHealthComponents).toEqual([
      "storage",
      "runtime",
      "compatibility",
      "projector",
      "fanout",
      "listener",
      "lease"
    ]);
    expect(
      isSelectedHostLocalHealthCauseValid(
        "runtime",
        "degraded",
        "runtime_disconnected"
      )
    ).toBe(true);
    expect(
      isSelectedHostLocalHealthCauseValid(
        "storage",
        "degraded",
        "runtime_disconnected"
      )
    ).toBe(false);
    expect(
      isSelectedHostLocalHealthCauseValid(
        "runtime",
        "degraded",
        "__proto__" as never
      )
    ).toBe(false);
    expect(
      selectedHostAggregateLocalHealthState([
        "unknown",
        "stale",
        "degraded",
        "failed",
        "ready"
      ])
    ).toBe("failed");
    expect(
      selectedHostAggregateLocalHealthState(["ready", "unknown", "stale"])
    ).toBe("stale");
    expect(selectedHostAggregateLocalHealthState(["ready", "ready"])).toBe(
      "ready"
    );
    expect(() => selectedHostAggregateLocalHealthState([])).toThrow(TypeError);
    expect(() =>
      selectedHostAggregateLocalHealthState(["impossible" as never])
    ).toThrow(TypeError);
    expect(
      isSelectedHostLocalHealthCauseValid(
        "runtime",
        "degraded",
        "impossible" as never
      )
    ).toBe(false);
  });

  it("accepts only exact initial and all-ready local readiness truth", () => {
    const initial = readinessInitial();
    const ready = readinessReady();
    expect(selectedReadinessResponseSchema.parse(initial)).toEqual(initial);
    expect(selectedReadinessResponseSchema.parse(ready)).toEqual(ready);
    expect(selectedLivenessResponseSchema.parse({ status: "alive" })).toEqual({
      status: "alive"
    });

    const degraded = {
      ...ready,
      generation: 8,
      state: "degraded",
      readiness: "not_ready",
      updated_at: laterTimestamp,
      components: ready.components.map((component) =>
        component.component === "runtime"
          ? {
              ...component,
              state: "degraded",
              checked_at: laterTimestamp,
              causes: ["runtime_disconnected"]
            }
          : component
      )
    } as const;
    expect(selectedReadinessResponseSchema.parse(degraded)).toEqual(degraded);

    for (const candidate of [
      { ...initial, generation: 1 },
      { ...initial, readiness: "ready" },
      { ...initial, state: "ready" },
      { ...ready, generation: 0 },
      { ...ready, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...ready, state: "unknown" },
      { ...ready, readiness: "not_ready" },
      { ...degraded, state: "ready" },
      { ...degraded, readiness: "ready" },
      {
        ...degraded,
        components: [...degraded.components].reverse()
      },
      {
        ...degraded,
        components: degraded.components.map((component) =>
          component.component === "runtime"
            ? { ...component, causes: [] }
            : component
        )
      },
      {
        ...degraded,
        components: degraded.components.map((component) =>
          component.component === "runtime"
            ? { ...component, causes: ["storage_unavailable"] }
            : component
        )
      },
      {
        ...degraded,
        components: degraded.components.map((component) =>
          component.component === "runtime"
            ? {
                ...component,
                causes: ["runtime_disconnected", "runtime_disconnected"]
              }
            : component
        )
      },
      {
        ...degraded,
        components: degraded.components.map((component) =>
          component.component === "runtime"
            ? {
                ...component,
                causes: ["runtime_reconciling", "runtime_starting"]
              }
            : component
        )
      },
      {
        ...degraded,
        state: "unknown",
        components: degraded.components.map((component) =>
          component.component === "runtime"
            ? {
                ...component,
                state: "unknown",
                causes: ["not_observed", "source_unknown"]
              }
            : component
        )
      },
      {
        ...degraded,
        updated_at: timestamp
      },
      { ...ready, updated_at: laterTimestamp },
      {
        ...ready,
        components: ready.components.map((component, index) =>
          index === 0 ? { ...component, checked_at: "not-a-timestamp" } : component
        )
      },
      { status: "alive", generation: 0 }
    ]) {
      const schema = Object.hasOwn(candidate, "status")
        ? selectedLivenessResponseSchema
        : selectedReadinessResponseSchema;
      expect(schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects hostile object and array descriptors without invoking accessors", () => {
    let accessorCalls = 0;
    const accessor = Object.defineProperty(
      {
        generation: 0,
        state: "unknown",
        readiness: "not_ready",
        updated_at: timestamp,
        components: initialComponents()
      },
      "state",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return "unknown";
        }
      }
    );
    const accessorCauses: unknown[] = [];
    Object.defineProperty(accessorCauses, "0", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "not_observed";
      }
    });
    const extraCauses = ["not_observed"];
    Object.defineProperty(extraCauses, "extra", {
      enumerable: true,
      value: "private"
    });
    const symbolCauses = ["not_observed"];
    Object.defineProperty(symbolCauses, Symbol("private"), {
      enumerable: true,
      value: "private"
    });
    const sparseCauses = new Array(1);
    const inheritedCauses = ["not_observed"];
    Object.setPrototypeOf(inheritedCauses, { inherited: true });
    const revokedCauses = Proxy.revocable(["not_observed"], {});
    revokedCauses.revoke();
    const revokedObject = Proxy.revocable(readinessInitial(), {});
    revokedObject.revoke();
    const symbolCandidate = readinessInitial() as Record<PropertyKey, unknown>;
    symbolCandidate[Symbol("private")] = true;

    for (const candidate of [
      accessor,
      revokedObject.proxy,
      symbolCandidate,
      Object.assign(Object.create({ inherited: true }), readinessInitial()),
      {
        ...readinessInitial(),
        components: initialComponents().map((component, index) =>
          index === 0 ? { ...component, causes: accessorCauses } : component
        )
      },
      {
        ...readinessInitial(),
        components: initialComponents().map((component, index) =>
          index === 0 ? { ...component, causes: extraCauses } : component
        )
      },
      {
        ...readinessInitial(),
        components: initialComponents().map((component, index) =>
          index === 0 ? { ...component, causes: symbolCauses } : component
        )
      },
      {
        ...readinessInitial(),
        components: initialComponents().map((component, index) =>
          index === 0 ? { ...component, causes: sparseCauses } : component
        )
      },
      {
        ...readinessInitial(),
        components: initialComponents().map((component, index) =>
          index === 0 ? { ...component, causes: inheritedCauses } : component
        )
      },
      {
        ...readinessInitial(),
        components: initialComponents().map((component, index) =>
          index === 0 ? { ...component, causes: revokedCauses.proxy } : component
        )
      }
    ]) {
      expect(selectedReadinessResponseSchema.safeParse(candidate).success).toBe(
        false
      );
    }
    expect(accessorCalls).toBe(0);
  });

  it("preserves independent unknown, observed, and observer-failed remote truth", () => {
    for (const remote of [
      remoteUnknown(),
      {
        generation: 1,
        state_generation: 0,
        availability: "disabled",
        cause: "remote_disabled",
        external_origin: null,
        laptop_action_required: true,
        observed_at: null,
        checked_at: timestamp,
        updated_at: timestamp
      },
      remoteReady(),
      {
        generation: 3,
        state_generation: 3,
        availability: "unavailable",
        cause: "client_stopped",
        external_origin: null,
        laptop_action_required: true,
        observed_at: timestamp,
        checked_at: laterTimestamp,
        updated_at: laterTimestamp
      },
      remoteObserverFailure()
    ] as const) {
      const candidate = hostStatus({ remote });
      expect(selectedHostStatusResponseSchema.parse(candidate)).toEqual(candidate);
    }

    for (const remote of [
      { ...remoteUnknown(), generation: 1 },
      { ...remoteUnknown(), cause: "observation_failed" },
      { ...remoteReady(), state_generation: null },
      { ...remoteReady(), generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...remoteReady(), external_origin: null },
      { ...remoteReady(), external_origin: "http://hostdeck.example.test" },
      { ...remoteReady(), cause: "client_stopped" },
      { ...remoteReady(), observed_at: laterTimestamp },
      { ...remoteReady(), updated_at: laterTimestamp },
      { ...remoteObserverFailure(), external_origin: remoteOrigin },
      { ...remoteObserverFailure(), cause: "client_stopped" },
      {
        ...remoteObserverFailure(),
        availability: "ready",
        laptop_action_required: false
      },
      {
        ...remoteObserverFailure(),
        state_generation: 4,
        cause: "remote_disabled"
      }
    ]) {
      expect(
        selectedHostStatusResponseSchema.safeParse(hostStatus({ remote })).success
      ).toBe(false);
    }
  });

  it("derives scoped write eligibility from access authority and local health only", () => {
    const ready = localReady();
    const degraded = localDegraded();
    const cases = [
      ["local_admin", ready, true, []],
      ["paired_write", ready, true, []],
      ["loopback_read", ready, false, ["read_only_access"]],
      ["paired_read", ready, false, ["read_only_access"]],
      ["local_admin", degraded, false, ["host_not_ready"]],
      ["paired_write", degraded, false, ["host_not_ready"]],
      [
        "paired_read",
        degraded,
        false,
        ["read_only_access", "host_not_ready"]
      ]
    ] as const;

    for (const [mode, local, eligible, causes] of cases) {
      const candidate = hostStatus({
        local,
        access: access(mode, eligible, causes)
      });
      expect(selectedHostAccessStatusSchema.parse(candidate.access)).toEqual(
        candidate.access
      );
      expect(selectedHostStatusResponseSchema.parse(candidate)).toEqual(candidate);
      expect(
        selectedHostStatusResponseSchema.parse({
          ...candidate,
          remote: remoteObserverFailure()
        }).access.write_eligibility
      ).toEqual(candidate.access.write_eligibility);
    }

    for (const invalidAccess of [
      access("paired_read", true, []),
      access("paired_read", false, ["host_not_ready"]),
      access("local_admin", false, ["read_only_access"]),
      access("paired_read", false, ["read_only_access", "read_only_access"]),
      access("paired_read", false, ["host_not_ready", "read_only_access"]),
      access("paired_write", true, ["host_not_ready"])
    ]) {
      expect(selectedHostAccessStatusSchema.safeParse(invalidAccess).success).toBe(
        false
      );
    }

    for (const candidate of [
      hostStatus({
        access: access("local_admin", false, ["host_not_ready"])
      }),
      hostStatus({
        access: access("paired_read", true, [])
      }),
      hostStatus({
        access: access("paired_read", false, ["host_not_ready", "read_only_access"])
      }),
      hostStatus({
        access: access("paired_read", false, ["read_only_access", "read_only_access"])
      }),
      hostStatus({
        access: {
          ...access("local_admin", true, []),
          network_mode: "remote"
        }
      }),
      hostStatus({
        access: {
          ...access("paired_write", true, []),
          network_mode: "remote",
          transport: "http"
        }
      }),
      {
        ...hostStatus(),
        session_id: "sess_private",
        cwd: "/private/project",
        raw_token: "secret"
      }
    ]) {
      expect(selectedHostStatusResponseSchema.safeParse(candidate).success).toBe(
        false
      );
    }
  });
});

function initialComponents() {
  return selectedHostLocalHealthComponents.map((component) => ({
    component,
    state: "unknown" as const,
    checked_at: null,
    causes: ["not_observed" as const]
  }));
}

function readyComponents() {
  return selectedHostLocalHealthComponents.map((component) => ({
    component,
    state: "ready" as const,
    checked_at: timestamp,
    causes: []
  }));
}

function readinessInitial() {
  return {
    generation: 0,
    state: "unknown" as const,
    readiness: "not_ready" as const,
    updated_at: timestamp,
    components: initialComponents()
  };
}

function readinessReady() {
  return {
    generation: 7,
    state: "ready" as const,
    readiness: "ready" as const,
    updated_at: timestamp,
    components: readyComponents()
  };
}

function localReady() {
  return {
    ...readinessReady(),
    mutation_admission: "open" as const
  };
}

function localDegraded() {
  return {
    ...readinessReady(),
    generation: 8,
    state: "degraded" as const,
    readiness: "not_ready" as const,
    mutation_admission: "closed" as const,
    updated_at: laterTimestamp,
    components: readyComponents().map((component) =>
      component.component === "runtime"
        ? {
            ...component,
            state: "degraded" as const,
            checked_at: laterTimestamp,
            causes: ["runtime_disconnected" as const]
          }
        : component
    )
  };
}

function remoteUnknown() {
  return {
    generation: 0,
    state_generation: null,
    availability: "unknown" as const,
    cause: "not_observed" as const,
    external_origin: null,
    laptop_action_required: true,
    observed_at: null,
    checked_at: null,
    updated_at: timestamp
  };
}

function remoteReady() {
  return {
    generation: 2,
    state_generation: 2,
    availability: "ready" as const,
    cause: null,
    external_origin: remoteOrigin,
    laptop_action_required: false,
    observed_at: timestamp,
    checked_at: timestamp,
    updated_at: timestamp
  };
}

function remoteObserverFailure() {
  return {
    generation: 4,
    state_generation: null,
    availability: "unavailable" as const,
    cause: "observation_failed" as const,
    external_origin: null,
    laptop_action_required: true,
    observed_at: null,
    checked_at: laterTimestamp,
    updated_at: laterTimestamp
  };
}

function access(
  mode: "local_admin" | "loopback_read" | "paired_read" | "paired_write",
  eligible: boolean,
  causes: readonly ("read_only_access" | "host_not_ready")[]
) {
  const local = mode === "local_admin" || mode === "loopback_read";
  return {
    mode,
    network_mode: local ? ("loopback" as const) : ("remote" as const),
    transport: local ? ("http" as const) : ("https" as const),
    write_eligibility: {
      scope: "host_health_and_authority" as const,
      eligible,
      causes: [...causes]
    }
  };
}

function hostStatus(
  overrides: Partial<{
    local: ReturnType<typeof localReady> | ReturnType<typeof localDegraded>;
    remote:
      | ReturnType<typeof remoteUnknown>
      | ReturnType<typeof remoteReady>
      | ReturnType<typeof remoteObserverFailure>
      | Record<string, unknown>;
    access: ReturnType<typeof access>;
  }> = {}
) {
  return {
    local: overrides.local ?? localReady(),
    remote: overrides.remote ?? remoteUnknown(),
    access: overrides.access ?? access("local_admin", true, [])
  };
}
