import { selectedAccessStateResponseSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type {
  BrowserConnectionCatalogState,
  BrowserConnectionPhase,
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionTargetData
} from "./connection-state.js";
import { synchronizeResponsiveMissionContext } from "./responsive-layout-state.js";

const observedAt = "2026-07-27T18:00:00.000Z";
const remoteOrigin = "https://hostdeck-responsive.example.ts.net";

describe("responsive Mission navigation context", () => {
  it("captures one immutable coordinator-owned Mission snapshot", () => {
    const source = missionSnapshot();
    const context = synchronizeResponsiveMissionContext(null, source);

    expect(context).toEqual({
      data: source.targetState.data,
      observedAt,
      sourceEpoch: 1,
      freshness: "current"
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(context?.data).toBe(source.targetState.data);
  });

  it("preserves identity for an unchanged source and marks retained loading data stale", () => {
    const source = missionSnapshot();
    const current = synchronizeResponsiveMissionContext(null, source);

    expect(synchronizeResponsiveMissionContext(current, source)).toBe(current);

    const loading = missionSnapshot({
      epoch: 2,
      targetState: "loading",
      targetData: source.targetState.data
    });
    const next = synchronizeResponsiveMissionContext(current, loading);
    expect(next).not.toBe(current);
    expect(next).toMatchObject({ sourceEpoch: 2, freshness: "stale" });
  });

  it("retains the exact context across detail, unreachable, and degraded targeting", () => {
    const current = synchronizeResponsiveMissionContext(null, missionSnapshot());

    for (const phase of ["loading", "ready", "unreachable", "degraded"] as const) {
      expect(
        synchronizeResponsiveMissionContext(current, detailSnapshot({ phase }))
      ).toBe(current);
    }
  });

  it("updates retained navigation directly from the app-wide catalog on detail routes", () => {
    const data = missionData();
    if (data.kind !== "mission_control") {
      throw new TypeError("Responsive catalog fixture is invalid.");
    }
    const source = Object.freeze({
      ...detailSnapshot(),
      catalog: responsiveCatalog("current", data)
    });
    const current = synchronizeResponsiveMissionContext(null, source);
    expect(current).toMatchObject({
      data,
      observedAt,
      freshness: "current"
    });

    const resetting = Object.freeze({
      ...detailSnapshot({ phase: "degraded" }),
      catalog: responsiveCatalog("resetting", data)
    });
    expect(synchronizeResponsiveMissionContext(current, resetting)).toMatchObject({
      data,
      freshness: "stale"
    });
  });

  it.each(["access_limited", "closed"] as const)(
    "purges retained context for phase %s",
    (phase) => {
      const current = synchronizeResponsiveMissionContext(null, missionSnapshot());
      expect(
        synchronizeResponsiveMissionContext(current, detailSnapshot({ phase }))
      ).toBeNull();
    }
  );

  it.each(["blocked", "idle", "failed"] as const)(
    "purges retained context when access is %s without readable authority",
    (accessState) => {
      const current = synchronizeResponsiveMissionContext(null, missionSnapshot());
      expect(
        synchronizeResponsiveMissionContext(
          current,
          detailSnapshot({ access: deniedAccess("revoked_device"), accessState })
        )
      ).toBeNull();
    }
  );

  it.each([
    "unpaired",
    "invalid_device",
    "expired_device",
    "revoked_device"
  ] as const)("purges retained context for %s authority", (authenticationState) => {
    const current = synchronizeResponsiveMissionContext(null, missionSnapshot());
    expect(
      synchronizeResponsiveMissionContext(
        current,
        detailSnapshot({
          access: deniedAccess(authenticationState),
          phase: "access_limited"
        })
      )
    ).toBeNull();
  });

  it("rejects invalid source epochs and observation times", () => {
    expect(() =>
      synchronizeResponsiveMissionContext(null, missionSnapshot({ epoch: 0 }))
    ).toThrow(/source epoch/u);
    expect(() =>
      synchronizeResponsiveMissionContext(
        null,
        missionSnapshot({ observedAt: "2026-02-30T18:00:00.000Z" })
      )
    ).toThrow(/observation time/u);
    expect(() =>
      synchronizeResponsiveMissionContext(null, missionSnapshot({ observedAt: null }))
    ).toThrow(/observation time/u);
  });

  it("does not admit non-Mission data as a new context", () => {
    expect(synchronizeResponsiveMissionContext(null, detailSnapshot())).toBeNull();
  });

  it("fails loudly for a malformed coordinator-owned Mission list", () => {
    const malformed = Object.freeze({
      kind: "mission_control" as const,
      access: Object.freeze({
        mode: "paired_write" as const,
        network_mode: "remote" as const,
        transport: "https" as const
      })
    }) as BrowserConnectionTargetData;

    expect(() =>
      synchronizeResponsiveMissionContext(null, missionSnapshot({ targetData: malformed }))
    ).toThrow(/invalid list contract/u);
  });
});

function missionSnapshot(
  options: Readonly<{
    epoch?: number;
    observedAt?: string | null;
    targetData?: BrowserConnectionTargetData | null;
    targetState?: BrowserConnectionResourceState;
  }> = {}
): BrowserConnectionSnapshot {
  const targetData = options.targetData ?? missionData();
  return snapshot({
    epoch: options.epoch ?? 1,
    target: Object.freeze({ kind: "mission_control" as const }),
    phase: "ready",
    access: pairedAccess(),
    accessState: "current",
    targetData,
    targetState: options.targetState ?? "current",
    observedAt: options.observedAt === undefined ? observedAt : options.observedAt
  });
}

function detailSnapshot(
  options: Readonly<{
    access?: ReturnType<typeof pairedAccess>;
    accessState?: BrowserConnectionResourceState;
    phase?: BrowserConnectionPhase;
  }> = {}
): BrowserConnectionSnapshot {
  return snapshot({
    epoch: 2,
    target: Object.freeze({ kind: "session_detail" as const, sessionId: "sess_rsp_detail" }),
    phase: options.phase ?? "ready",
    access: options.access ?? pairedAccess(),
    accessState: options.accessState ?? "current",
    targetData: null,
    targetState: "loading",
    observedAt
  });
}

function snapshot(input: {
  readonly epoch: number;
  readonly target: BrowserConnectionSnapshot["target"];
  readonly phase: BrowserConnectionPhase;
  readonly access: ReturnType<typeof pairedAccess>;
  readonly accessState: BrowserConnectionResourceState;
  readonly targetData: BrowserConnectionTargetData | null;
  readonly targetState: BrowserConnectionResourceState;
  readonly observedAt: string | null;
}): BrowserConnectionSnapshot {
  return Object.freeze({
    epoch: input.epoch,
    target: input.target,
    phase: input.phase,
    access: Object.freeze({
      state: input.accessState,
      data: input.access,
      failure: null,
      observedAt
    }),
    host: Object.freeze({ state: "current", data: null, failure: null, observedAt }),
    targetState: Object.freeze({
      state: input.targetState,
      data: input.targetData,
      failure: null,
      observedAt: input.observedAt
    }),
    stream: Object.freeze({
      state: input.target?.kind === "session_detail" ? "idle" : "not_applicable",
      snapshot: null,
      continuity: "not_applicable",
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "ready",
      generation: 1,
      rotatedAt: observedAt,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell",
      eligible: true,
      causes: Object.freeze([])
    }),
    lastFailure: null
  });
}

function missionData(): BrowserConnectionTargetData {
  return Object.freeze({
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
  });
}

function responsiveCatalog(
  state: BrowserConnectionCatalogState["state"],
  data: Extract<BrowserConnectionTargetData, { kind: "mission_control" }>
): BrowserConnectionCatalogState {
  return Object.freeze({
    state,
    data,
    snapshot: null,
    boundary: null,
    failure: null,
    observedAt
  });
}

function pairedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_responsive_phone",
    permission: "write",
    device_expires_at: "2026-10-27T18:00:00.000Z",
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
    can_unlock: false
  });
}

function deniedAccess(
  authenticationState: "unpaired" | "invalid_device" | "expired_device" | "revoked_device"
): ReturnType<typeof pairedAccess> {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: authenticationState,
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
}
