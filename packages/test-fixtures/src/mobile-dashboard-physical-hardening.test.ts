import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mobileWorkflowPaths } from "./copy-workflow-matrix.js";
import {
  createMobileDashboardPhysicalHardeningLedger,
  mobileDashboardLocalLaptopInteractionIds,
  mobileDashboardPackageBrowserInteractionIds,
  mobileDashboardPhysicalHardeningCriterionIds,
  mobileDashboardPhysicalHardeningEvidence,
  mobileDashboardPhysicalHardeningRequirementIds,
  mobileDashboardPhysicalInteractionIds,
  mobileDashboardPhysicalStateIds
} from "./mobile-dashboard-physical-hardening.js";
import {
  mobileInteractionIds,
  mobileJourneyIds,
  mobileStateTraceIds,
  mobileSurfaceIds
} from "./mobile-design-contract.js";
import { uiFidelityTargets } from "./ui-fidelity-matrix.js";

const repositoryRoot = resolve(process.cwd());
const criteriaPath = resolve(
  repositoryRoot,
  "artifacts/fe-v1-090-mobile-dashboard-physical-hardening.md"
);
const ledgerPath = resolve(
  repositoryRoot,
  "artifacts/fe-v1-090-mobile-dashboard-physical-hardening/ledger.json"
);
const requirementsPath = resolve(repositoryRoot, "docs/planning/02-requirements.md");
const browserManifestPath = resolve(
  repositoryRoot,
  "tests/browser/supported-browser-manifest.json"
);

describe("FE-V1-090 physical mobile-dashboard hardening ledger", () => {
  it("binds the stored ledger to the complete selected mobile contract", () => {
    const expected = createMobileDashboardPhysicalHardeningLedger();
    if (process.env.HOSTDECK_WRITE_MOBILE_DASHBOARD_HARDENING_LEDGER === "1") {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, `${JSON.stringify(expected, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644
      });
    }
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual(expected);
    expect(Object.isFrozen(expected)).toBe(true);
    expect(mobileJourneyIds).toHaveLength(12);
    expect(mobileWorkflowPaths).toHaveLength(17);
    expect(mobileSurfaceIds).toHaveLength(15);
    expect(mobileStateTraceIds).toHaveLength(141);
    expect(mobileInteractionIds).toHaveLength(39);
    expect(uiFidelityTargets).toHaveLength(7);
  });

  it("requires every interaction physically and every state in current package coverage", () => {
    expect(mobileDashboardPhysicalInteractionIds).toEqual(mobileInteractionIds);
    expect(new Set(mobileDashboardPhysicalInteractionIds).size).toBe(39);
    expect(mobileDashboardPackageBrowserInteractionIds).toHaveLength(34);
    expect(mobileDashboardLocalLaptopInteractionIds).toHaveLength(5);
    expect(
      [...mobileDashboardPackageBrowserInteractionIds, ...mobileDashboardLocalLaptopInteractionIds]
        .sort()
    ).toEqual([...mobileInteractionIds].sort());
    expect(new Set(mobileDashboardPhysicalStateIds).size).toBe(
      mobileDashboardPhysicalStateIds.length
    );
    for (const id of mobileDashboardPhysicalStateIds) {
      expect(mobileStateTraceIds).toContain(id);
    }
  });

  it("matches the accepted package-browser interaction owner exactly", () => {
    const manifest = JSON.parse(readFileSync(browserManifestPath, "utf8")) as {
      automated_interaction_ids: string[];
      package: Record<string, string>;
      projects: unknown[];
      scenarios: unknown[];
    };
    expect(manifest.automated_interaction_ids).toEqual(
      mobileDashboardPackageBrowserInteractionIds
    );
    expect(manifest.projects).toHaveLength(4);
    expect(manifest.scenarios).toHaveLength(19);
    for (const [key, value] of Object.entries(manifest.package)) {
      if (key.endsWith("sha256")) expect(value, key).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("freezes criteria, requirements, selected assets, and evidence ownership", () => {
    const criteria = readFileSync(criteriaPath, "utf8");
    const requirements = readFileSync(requirementsPath, "utf8");
    expect(mobileDashboardPhysicalHardeningCriterionIds).toHaveLength(24);
    for (const id of mobileDashboardPhysicalHardeningCriterionIds) {
      expect(criteria.split(`| \`${id}\` |`)).toHaveLength(2);
    }
    for (const id of mobileDashboardPhysicalHardeningRequirementIds) {
      expect(requirements).toContain(`| ${id} |`);
    }
    for (const target of uiFidelityTargets) {
      const bytes = readFileSync(resolve(repositoryRoot, target.path));
      expect(createHash("sha256").update(bytes).digest("hex"), target.id).toBe(
        target.sha256
      );
    }
    for (const owner of mobileDashboardPhysicalHardeningEvidence) {
      if (owner.status === "complete") {
        expect(existsSync(resolve(repositoryRoot, owner.path)), owner.id).toBe(true);
      }
    }
  });
});
