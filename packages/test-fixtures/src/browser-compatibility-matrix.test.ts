import { describe, expect, it } from "vitest";
import { readSupportedBrowserManifest } from "../../../scripts/browser-support-manifest.mjs";
import {
  browserInteractionCoverageLedger,
  browserPortabilityDispositionIds,
  browserPortabilityFamilyIds,
  supportedBrowserProjectIds
} from "./browser-compatibility-matrix.js";
import {
  mobileInteractionIds,
  mobileInteractionTraces,
  mobileJourneyIds
} from "./mobile-design-contract.js";

describe("supported browser interaction coverage ledger", () => {
  it("owns all 39 canonical interactions exactly once", () => {
    expect(browserInteractionCoverageLedger.map(({ interactionId }) => interactionId))
      .toEqual(mobileInteractionIds);
    expect(browserInteractionCoverageLedger).toHaveLength(39);
    expect(new Set(browserInteractionCoverageLedger.map(({ interactionId }) => interactionId)))
      .toHaveLength(39);
  });

  it("covers every portability family, browser project, and mobile journey", () => {
    expect(unique(browserInteractionCoverageLedger.map(({ family }) => family)))
      .toEqual(unique(browserPortabilityFamilyIds));
    expect(unique(browserInteractionCoverageLedger.flatMap(({ projectIds }) => projectIds)))
      .toEqual(unique(supportedBrowserProjectIds));
    expect(unique(browserInteractionCoverageLedger.flatMap(({ journeys }) => journeys)))
      .toEqual(unique(mobileJourneyIds));
  });

  it("keeps local laptop actions outside automated browser projects", () => {
    const localIds = [
      "create_pairing_link",
      "enable_remote_local",
      "disable_remote_local",
      "switch_tailscale_profile_local",
      "unlock_host_local"
    ];
    for (const entry of browserInteractionCoverageLedger) {
      expect(browserPortabilityDispositionIds).toContain(entry.disposition);
      if (localIds.includes(entry.interactionId)) {
        expect(entry.disposition, entry.interactionId).toBe("contract_only_local_boundary");
        expect(entry.projectIds, entry.interactionId).toEqual([]);
      } else {
        expect(entry.disposition, entry.interactionId).toBe("automated_all_projects");
        expect(entry.projectIds, entry.interactionId).toEqual(supportedBrowserProjectIds);
      }
    }
    expect(readSupportedBrowserManifest().automated_interaction_ids).toEqual(
      browserInteractionCoverageLedger
        .filter(({ disposition }) => disposition === "automated_all_projects")
        .map(({ interactionId }) => interactionId)
    );
  });

  it("retains exact behavior ownership and mutation truth", () => {
    for (const entry of browserInteractionCoverageLedger) {
      const trace = mobileInteractionTraces.find(({ id }) => id === entry.interactionId);
      expect(trace, entry.interactionId).toBeDefined();
      expect(entry.behaviorOwner, entry.interactionId).toBe(trace?.downstreamTask);
      expect(entry.mutation, entry.interactionId).toBe(trace?.mutation);
      expect(Object.isFrozen(entry), entry.interactionId).toBe(true);
      expect(Object.isFrozen(entry.projectIds), entry.interactionId).toBe(true);
      expect(Object.isFrozen(entry.journeys), entry.interactionId).toBe(true);
    }
    expect(Object.isFrozen(browserInteractionCoverageLedger)).toBe(true);
  });
});

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
