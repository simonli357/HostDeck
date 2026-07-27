import {
  assessCodexCompatibility,
  codexBindingDescriptor
} from "@hostdeck/codex-adapter";
import {
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedRuntimeCompatibilityRecord,
  selectedRuntimeCompatibilityRecordSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  createHostDeckHostHealthService,
  type HostDeckHostHealthService,
  type HostDeckLocalHealthComponent,
  type HostDeckLocalHealthState,
  type HostDeckReportedLocalHealthReason
} from "./host-health.js";
import {
  assertHostDeckRuntimeCompatibilityRecordReader,
  createHostDeckRuntimeCompatibilityRecordReader,
  projectHostDeckRuntimeCompatibilityStatus
} from "./runtime-compatibility-status.js";

const checkedAt = "2026-07-27T12:00:00.000Z";
const recordedAt = "2026-07-27T12:00:01.000Z";
const observedAt = "2026-07-27T12:00:02.000Z";

describe("IFC-V1-087 runtime compatibility status projection", () => {
  it("projects supported, version-drift, and exact-version incompatibility distinctly", () => {
    const supportedHealth = healthWith([
      ["runtime", "ready", []],
      ["compatibility", "ready", []]
    ]);
    const supported = projectHostDeckRuntimeCompatibilityStatus(
      supportedHealth.localSnapshot(),
      compatibilityRecord(readyCompatibility())
    );
    expect(supported).toEqual({
      state: "supported",
      evidence: "current",
      observed_version: "0.144.0",
      supported_version: "0.144.0",
      capability_state: "verified",
      checked_at: checkedAt,
      recorded_at: recordedAt
    });
    expect(Object.keys(supported)).toEqual([
      "state",
      "evidence",
      "observed_version",
      "supported_version",
      "capability_state",
      "checked_at",
      "recorded_at"
    ]);
    expect(Object.isFrozen(supported)).toBe(true);

    const incompatibleHealth = healthWith([
      ["runtime", "failed", ["runtime_failed"]],
      ["compatibility", "failed", ["runtime_incompatible"]]
    ]);
    expect(
      projectHostDeckRuntimeCompatibilityStatus(
        incompatibleHealth.localSnapshot(),
        compatibilityRecord(versionDriftCompatibility())
      )
    ).toMatchObject({
      state: "version_drift",
      evidence: "current",
      observed_version: "0.145.0",
      capability_state: "blocked"
    });
    expect(
      projectHostDeckRuntimeCompatibilityStatus(
        incompatibleHealth.localSnapshot(),
        compatibilityRecord(exactIncompatibleCompatibility())
      )
    ).toMatchObject({
      state: "incompatible",
      evidence: "current",
      observed_version: "0.144.0",
      capability_state: "blocked"
    });
  });

  it("projects disconnected, degraded, and unknown evidence without verifying capability", () => {
    const prior = compatibilityRecord(readyCompatibility());
    const disconnected = healthWith([
      ["runtime", "degraded", ["runtime_disconnected"]],
      ["compatibility", "degraded", ["compatibility_degraded"]]
    ]);
    expect(
      projectHostDeckRuntimeCompatibilityStatus(
        disconnected.localSnapshot(),
        prior
      )
    ).toMatchObject({
      state: "disconnected",
      evidence: "last_known",
      capability_state: "unverified",
      observed_version: "0.144.0"
    });

    const degraded = healthWith([
      ["runtime", "degraded", ["runtime_reconciling"]],
      ["compatibility", "degraded", ["compatibility_degraded"]]
    ]);
    expect(
      projectHostDeckRuntimeCompatibilityStatus(
        degraded.localSnapshot(),
        compatibilityRecord(degradedCompatibility())
      )
    ).toMatchObject({
      state: "degraded",
      evidence: "current",
      capability_state: "limited"
    });
    expect(
      projectHostDeckRuntimeCompatibilityStatus(degraded.localSnapshot(), prior)
    ).toMatchObject({
      state: "degraded",
      evidence: "last_known",
      capability_state: "unverified"
    });

    const initial = createHostDeckHostHealthService({
      now: () => new Date(observedAt)
    });
    expect(
      projectHostDeckRuntimeCompatibilityStatus(initial.localSnapshot(), null)
    ).toEqual({
      state: "unknown",
      evidence: "unobserved",
      observed_version: null,
      supported_version: "0.144.0",
      capability_state: "unverified",
      checked_at: null,
      recorded_at: null
    });
    const checking = healthWith([
      ["runtime", "degraded", ["runtime_starting"]],
      ["compatibility", "unknown", ["compatibility_unchecked"]]
    ]);
    expect(
      projectHostDeckRuntimeCompatibilityStatus(checking.localSnapshot(), prior)
    ).toMatchObject({
      state: "unknown",
      evidence: "last_known",
      capability_state: "unverified"
    });
  });

  it("rejects stale, missing, malformed, or health-contradictory evidence", () => {
    const ready = healthWith([
      ["runtime", "ready", []],
      ["compatibility", "ready", []]
    ]).localSnapshot();
    const incompatible = healthWith([
      ["runtime", "failed", ["runtime_failed"]],
      ["compatibility", "failed", ["runtime_incompatible"]]
    ]).localSnapshot();
    const disconnected = healthWith([
      ["runtime", "degraded", ["runtime_disconnected"]],
      ["compatibility", "degraded", ["compatibility_degraded"]]
    ]).localSnapshot();
    const readyRecord = compatibilityRecord(readyCompatibility());
    const driftRecord = compatibilityRecord(versionDriftCompatibility());
    const regressed = {
      ...readyRecord,
      recorded_at: "2026-07-27T11:59:59.000Z"
    } as SelectedRuntimeCompatibilityRecord;

    for (const [local, record] of [
      [ready, null],
      [ready, driftRecord],
      [incompatible, readyRecord],
      [disconnected, null],
      [ready, regressed],
      [ready, { ...readyRecord, private_path: "/private/codex" }]
    ] as const) {
      expect(() =>
        projectHostDeckRuntimeCompatibilityStatus(
          local,
          record as SelectedRuntimeCompatibilityRecord | null
        )
      ).toThrow("Runtime compatibility status projection is contradictory.");
    }

    const staleHealth = healthWith(
      [
        ["runtime", "ready", []],
        ["compatibility", "ready", []]
      ],
      "2026-07-27T12:00:00.500Z"
    );
    expect(() =>
      projectHostDeckRuntimeCompatibilityStatus(
        staleHealth.localSnapshot(),
        readyRecord
      )
    ).toThrow(TypeError);
  });

  it("brands one exact synchronous reader and does not inspect hostile accessors", () => {
    let reads = 0;
    const record = compatibilityRecord(readyCompatibility());
    const reader = createHostDeckRuntimeCompatibilityRecordReader({
      read() {
        reads += 1;
        return record;
      }
    });
    expect(() => assertHostDeckRuntimeCompatibilityRecordReader(reader)).not.toThrow();
    expect(reader.read()).toBe(record);
    expect(reads).toBe(1);
    expect(() =>
      assertHostDeckRuntimeCompatibilityRecordReader(Object.freeze({ ...reader }))
    ).toThrow(TypeError);

    let accessorReads = 0;
    const accessor = Object.defineProperty({}, "read", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return () => null;
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { read: () => null, extra: true },
      accessor
    ]) {
      expect(() =>
        createHostDeckRuntimeCompatibilityRecordReader(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorReads).toBe(0);
  });
});

type HealthObservation = readonly [
  HostDeckLocalHealthComponent,
  HostDeckLocalHealthState,
  readonly HostDeckReportedLocalHealthReason[]
];

function healthWith(
  observations: readonly HealthObservation[],
  time = observedAt
): HostDeckHostHealthService {
  const health = createHostDeckHostHealthService({ now: () => new Date(time) });
  for (const [component, state, reasons] of observations) {
    health.updateLocal({
      component,
      state,
      reasons,
      source_generation: 1
    });
  }
  return health;
}

function compatibilityRecord(
  compatibility: RuntimeCompatibility
): SelectedRuntimeCompatibilityRecord {
  return selectedRuntimeCompatibilityRecordSchema.parse({
    id: "hostdeck_runtime",
    compatibility,
    recorded_at: recordedAt
  });
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: codexBindingDescriptor.codex_version,
    checked_at: checkedAt,
    handshake: initializedHandshake()
  });
}

function versionDriftCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.145.0",
    checked_at: checkedAt,
    handshake: { state: "not_attempted" }
  });
}

function exactIncompatibleCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: codexBindingDescriptor.codex_version,
    checked_at: checkedAt,
    handshake: initializedHandshake(),
    binding: {
      ...codexBindingDescriptor,
      surface: {
        ...codexBindingDescriptor.surface,
        client_methods: codexBindingDescriptor.surface.client_methods.filter(
          (method) => method !== "turn/start"
        )
      }
    }
  });
}

function degradedCompatibility(): RuntimeCompatibility {
  return runtimeCompatibilitySchema.parse({
    ...readyCompatibility(),
    state: "degraded",
    mutation_policy: "blocked",
    reason: "Runtime compatibility is being re-established."
  });
}

function initializedHandshake() {
  return {
    state: "initialized" as const,
    user_agent: `hostdeck/${codexBindingDescriptor.codex_version}`,
    platform_family: "unix",
    platform_os: "linux",
    collaboration_modes: ["Plan", "Default"]
  };
}
