import { describe, expect, it } from "vitest";
import {
  mobileInteractionTraces,
  mobileJourneyIds,
  mobileReferenceViewports,
  mobileStateTraces,
  mobileSurfaceIds
} from "./mobile-design-contract.js";
import {
  uiFidelityDivergenceIds,
  uiFidelityEvidenceTierIds,
  uiFidelityInteractionCoverageLedger,
  uiFidelityLandmarkIds,
  uiFidelityStateCoverageLedger,
  uiFidelityTargetIds,
  uiFidelityTargets
} from "./ui-fidelity-matrix.js";

describe("selected-target UI fidelity coverage", () => {
  it("binds exactly the seven selected Focus Rail assets", () => {
    expect(uiFidelityTargets.map(({ id }) => id)).toEqual(uiFidelityTargetIds);
    expect(new Set(uiFidelityTargets.map(({ path }) => path))).toHaveLength(7);
    expect(uiFidelityTargets.every(({ path }) => path.includes("/option-b/"))).toBe(true);
    expect(
      uiFidelityTargets.every(
        ({ path }) => !path.includes("option-a") && !path.includes("control-room-board")
      )
    ).toBe(true);
    for (const target of uiFidelityTargets) {
      expect(target.width).toBeGreaterThan(0);
      expect(target.height).toBeGreaterThan(0);
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(target.landmarks.length).toBeGreaterThan(0);
      expect(new Set(target.landmarks).size).toBe(target.landmarks.length);
      expect(target.landmarks.every((landmark) => uiFidelityLandmarkIds.includes(landmark)))
        .toBe(true);
      expect(Object.isFrozen(target)).toBe(true);
      expect(Object.isFrozen(target.landmarks)).toBe(true);
    }
  });

  it("maps all canonical states once without inventing coverage", () => {
    expect(uiFidelityStateCoverageLedger).toHaveLength(141);
    expect(uiFidelityStateCoverageLedger.map(({ id }) => id)).toEqual(
      mobileStateTraces.map(({ id }) => id)
    );
    expect(new Set(uiFidelityStateCoverageLedger.map(({ id }) => id))).toHaveLength(141);
    expect(new Set(uiFidelityStateCoverageLedger.map(({ surface }) => surface))).toEqual(
      new Set(mobileSurfaceIds)
    );
    expect(new Set(uiFidelityStateCoverageLedger.flatMap(({ journeys }) => journeys))).toEqual(
      new Set(mobileJourneyIds)
    );
    expect(new Set(uiFidelityStateCoverageLedger.flatMap(({ viewports }) => viewports)))
      .toEqual(new Set(mobileReferenceViewports));

    for (const entry of uiFidelityStateCoverageLedger) {
      const trace = mobileStateTraces.find(({ id }) => id === entry.id);
      expect(trace).toBeDefined();
      expect(entry.surface).toBe(trace?.surface);
      expect(trace?.downstreamTasks).toContain(entry.behaviorOwner);
      expect(uiFidelityTargetIds).toContain(entry.target);
      expect(uiFidelityEvidenceTierIds).toContain(entry.evidenceTier);
      expect(entry.landmarks.length).toBeGreaterThan(0);
      expect(entry.allowedDivergences.length).toBeGreaterThan(0);
      expect(
        entry.allowedDivergences.every((id) => uiFidelityDivergenceIds.includes(id))
      ).toBe(true);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.landmarks)).toBe(true);
      expect(Object.isFrozen(entry.allowedDivergences)).toBe(true);
    }
  });

  it("maps all interactions and preserves browser and local ownership", () => {
    expect(uiFidelityInteractionCoverageLedger).toHaveLength(39);
    expect(uiFidelityInteractionCoverageLedger.map(({ id }) => id)).toEqual(
      mobileInteractionTraces.map(({ id }) => id)
    );
    expect(new Set(uiFidelityInteractionCoverageLedger.map(({ id }) => id))).toHaveLength(39);

    for (const entry of uiFidelityInteractionCoverageLedger) {
      const trace = mobileInteractionTraces.find(({ id }) => id === entry.id);
      expect(trace).toBeDefined();
      expect(entry.surface).toBe(trace?.uiOwner);
      expect(entry.behaviorOwner).toBe(trace?.downstreamTask);
      expect(uiFidelityTargetIds).toContain(entry.target);
      expect(entry.evidenceTier).toBe(
        trace?.uiOwner === "local_only"
          ? "local_only_boundary"
          : "existing_behavior_evidence"
      );
    }
  });

  it("uses every selected family and records the frozen authoritative divergences", () => {
    const allTargets = new Set([
      ...uiFidelityStateCoverageLedger.map(({ target }) => target),
      ...uiFidelityInteractionCoverageLedger.map(({ target }) => target)
    ]);
    expect(allTargets).toEqual(new Set(uiFidelityTargetIds));

    const preload = uiFidelityStateCoverageLedger.filter(
      ({ surface }) => surface === "browser_preload"
    );
    expect(preload).toHaveLength(2);
    expect(preload.every(({ evidenceTier }) => evidenceTier === "browser_boundary")).toBe(true);
    expect(
      preload.every(({ allowedDivergences }) =>
        allowedDivergences.includes("browser_owned_preload_error")
      )
    ).toBe(true);

    const pairing = uiFidelityStateCoverageLedger.filter(({ surface }) => surface === "pairing");
    expect(pairing).not.toHaveLength(0);
    expect(
      pairing.every(({ allowedDivergences }) =>
        allowedDivergences.includes("fragment_scrubbed_automatic_claim")
      )
    ).toBe(true);

    const createLink = uiFidelityInteractionCoverageLedger.find(
      ({ id }) => id === "create_pairing_link"
    );
    expect(createLink).toMatchObject({
      surface: "local_only",
      target: "pairing_journey",
      evidenceTier: "local_only_boundary"
    });
    expect(createLink?.allowedDivergences).toContain("local_cli_qr_creation");
  });

  it("requires fresh captures for every flagship target state", () => {
    const fresh = uiFidelityStateCoverageLedger
      .filter(({ evidenceTier }) => evidenceTier === "fresh_capture")
      .map(({ id }) => id);
    expect(fresh).toEqual([
      "mission_mixed_attention",
      "mission_desktop_expansion",
      "detail_active_writable",
      "detail_replay_boundary",
      "detail_desktop_expansion",
      "access_locked",
      "access_remote_disabled",
      "access_tailscale_stopped",
      "access_profile_mismatch",
      "access_serve_conflict",
      "pair_claiming",
      "pair_paired",
      "model_current",
      "goal_current",
      "plan_current",
      "approval_pending",
      "approval_elevated_confirmation"
    ]);
  });
});
