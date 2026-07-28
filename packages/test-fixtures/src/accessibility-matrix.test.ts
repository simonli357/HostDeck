import { describe, expect, it } from "vitest";
import {
  accessibilityAuditTierIds,
  accessibilityFamilyIds,
  accessibilityInteractionCoverageLedger,
  accessibilityKeyboardPolicyByFamily,
  accessibilityKeyboardPolicyIds,
  accessibilitySemanticPolicyByFamily,
  accessibilitySemanticPolicyIds,
  accessibilityStateCoverageLedger
} from "./accessibility-matrix.js";
import {
  mobileInteractionIds,
  mobileInteractionTraces,
  mobileJourneyIds,
  mobileReferenceViewports,
  mobileStateTraceIds,
  mobileStateTraces,
  mobileSurfaceIds
} from "./mobile-design-contract.js";

describe("semantic accessibility coverage ledger", () => {
  it("owns every canonical state and interaction exactly once", () => {
    expect(accessibilityStateCoverageLedger.map(({ id }) => id)).toEqual(
      mobileStateTraceIds
    );
    expect(accessibilityStateCoverageLedger).toHaveLength(141);
    expect(new Set(accessibilityStateCoverageLedger.map(({ id }) => id))).toHaveLength(141);

    expect(accessibilityInteractionCoverageLedger.map(({ id }) => id)).toEqual(
      mobileInteractionIds
    );
    expect(accessibilityInteractionCoverageLedger).toHaveLength(39);
    expect(new Set(accessibilityInteractionCoverageLedger.map(({ id }) => id))).toHaveLength(
      39
    );
  });

  it("covers all frozen surfaces, families, journeys, and viewports", () => {
    expect(unique(accessibilityStateCoverageLedger.map(({ surface }) => surface))).toEqual(
      unique(mobileSurfaceIds)
    );
    expect(unique(accessibilityStateCoverageLedger.map(({ family }) => family))).toEqual(
      unique(accessibilityFamilyIds)
    );
    expect(unique(accessibilityStateCoverageLedger.flatMap(({ journeys }) => journeys))).toEqual(
      unique(mobileJourneyIds)
    );
    expect(unique(accessibilityStateCoverageLedger.flatMap(({ viewports }) => viewports))).toEqual(
      unique(mobileReferenceViewports)
    );
  });

  it("retains one declared existing behavior owner per entry", () => {
    for (const entry of accessibilityStateCoverageLedger) {
      const trace = mobileStateTraces.find(({ id }) => id === entry.id);
      expect(trace, entry.id).toBeDefined();
      expect(trace?.downstreamTasks, entry.id).toContain(entry.behaviorOwner);
      expect(entry.behaviorOwner, entry.id).not.toBe("FE-V1-039");
    }
    for (const entry of accessibilityInteractionCoverageLedger) {
      const trace = mobileInteractionTraces.find(({ id }) => id === entry.id);
      expect(trace, entry.id).toBeDefined();
      expect(entry.behaviorOwner, entry.id).toBe(trace?.downstreamTask);
      expect(entry.behaviorOwner, entry.id).not.toBe("FE-V1-039");
    }
  });

  it("assigns explicit semantic, keyboard, announcement, and audit policies", () => {
    expect(Object.keys(accessibilitySemanticPolicyByFamily).sort()).toEqual(
      [...accessibilityFamilyIds].sort()
    );
    expect(Object.keys(accessibilityKeyboardPolicyByFamily).sort()).toEqual(
      [...accessibilityFamilyIds].sort()
    );
    for (const entry of [
      ...accessibilityStateCoverageLedger,
      ...accessibilityInteractionCoverageLedger
    ]) {
      expect(accessibilitySemanticPolicyIds, entry.id).toContain(entry.semanticPolicy);
      expect(accessibilityKeyboardPolicyIds, entry.id).toContain(entry.keyboardPolicy);
      expect(accessibilityAuditTierIds, entry.id).toContain(entry.auditTier);
      expect(entry.semanticPolicy, entry.id).toBe(
        accessibilitySemanticPolicyByFamily[entry.family]
      );
      expect(entry.keyboardPolicy, entry.id).toBe(
        accessibilityKeyboardPolicyByFamily[entry.family]
      );
      expect(entry.announcementPolicy, entry.id).not.toHaveLength(0);
    }
  });

  it("freezes ledgers and state coverage arrays", () => {
    expect(Object.isFrozen(accessibilityStateCoverageLedger)).toBe(true);
    expect(Object.isFrozen(accessibilityInteractionCoverageLedger)).toBe(true);
    for (const entry of accessibilityStateCoverageLedger) {
      expect(Object.isFrozen(entry), entry.id).toBe(true);
      expect(Object.isFrozen(entry.journeys), entry.id).toBe(true);
      expect(Object.isFrozen(entry.viewports), entry.id).toBe(true);
    }
    for (const entry of accessibilityInteractionCoverageLedger) {
      expect(Object.isFrozen(entry), entry.id).toBe(true);
    }
  });
});

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
