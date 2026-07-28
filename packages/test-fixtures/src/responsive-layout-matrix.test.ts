import { describe, expect, it } from "vitest";
import {
  mobileJourneyIds,
  mobileReferenceViewports,
  mobileStateTraceIds,
  mobileStateTraces,
  mobileSurfaceIds
} from "./mobile-design-contract.js";
import {
  responsiveLayoutCoverageLedger,
  responsiveLayoutFamilyBySurface,
  responsiveLayoutFamilyIds
} from "./responsive-layout-matrix.js";

describe("responsive layout coverage ledger", () => {
  it("assigns every canonical state trace exactly once without invented entries", () => {
    expect(responsiveLayoutCoverageLedger.map(({ traceId }) => traceId)).toEqual(
      mobileStateTraceIds
    );
    expect(responsiveLayoutCoverageLedger).toHaveLength(141);
    expect(new Set(responsiveLayoutCoverageLedger.map(({ traceId }) => traceId)).size).toBe(
      141
    );
  });

  it("assigns all 15 surfaces to exactly one of the eight frozen layout families", () => {
    expect(Object.keys(responsiveLayoutFamilyBySurface).sort()).toEqual(
      [...mobileSurfaceIds].sort()
    );
    expect(new Set(Object.values(responsiveLayoutFamilyBySurface))).toEqual(
      new Set(responsiveLayoutFamilyIds)
    );
    for (const entry of responsiveLayoutCoverageLedger) {
      expect(entry.family, entry.traceId).toBe(
        responsiveLayoutFamilyBySurface[entry.surface]
      );
    }
  });

  it("retains complete journey and reference-viewport ownership", () => {
    expect(
      unique(responsiveLayoutCoverageLedger.flatMap(({ journeys }) => journeys))
    ).toEqual(unique(mobileJourneyIds));
    expect(
      unique(responsiveLayoutCoverageLedger.flatMap(({ viewports }) => viewports))
    ).toEqual(unique(mobileReferenceViewports));
  });

  it("points every trace at one declared existing behavior owner", () => {
    for (const entry of responsiveLayoutCoverageLedger) {
      const trace = mobileStateTraces.find(({ id }) => id === entry.traceId);
      expect(trace, entry.traceId).toBeDefined();
      expect(trace?.surface, entry.traceId).toBe(entry.surface);
      expect(trace?.downstreamTasks, entry.traceId).toContain(entry.behaviorOwner);
      expect(entry.behaviorOwner, entry.traceId).not.toBe("FE-V1-016");
      expect(entry.behaviorOwner, entry.traceId).not.toBe("FE-V1-039");
      expect(entry.behaviorOwner, entry.traceId).not.toBe("FE-V1-040");
    }
  });

  it("freezes entries and nested coverage arrays", () => {
    expect(Object.isFrozen(responsiveLayoutFamilyBySurface)).toBe(true);
    expect(Object.isFrozen(responsiveLayoutCoverageLedger)).toBe(true);
    for (const entry of responsiveLayoutCoverageLedger) {
      expect(Object.isFrozen(entry), entry.traceId).toBe(true);
      expect(Object.isFrozen(entry.journeys), entry.traceId).toBe(true);
      expect(Object.isFrozen(entry.viewports), entry.traceId).toBe(true);
    }
  });
});

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
