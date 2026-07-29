import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProductionInterfaceHardeningLedger,
  productionInterfaceHardeningCriteria,
  productionInterfaceHardeningCriterionIds,
  productionInterfaceHardeningDimensions,
  productionInterfaceHardeningEvidence,
  productionInterfaceHardeningRequirementIds
} from "./production-interface-hardening-manifest.js";
import { hostDeckSelectedApiRouteCompositionDescriptor } from "./selected-api-route-composition.js";
import { selectedApiRouteManifest } from "./selected-api-route-manifest.js";

const repositoryRoot = resolve(process.cwd());
const criteriaPath = resolve(
  repositoryRoot,
  "artifacts/ifc-v1-091-selected-production-interface-hardening.md"
);
const ledgerPath = resolve(
  repositoryRoot,
  "artifacts/ifc-v1-091-selected-production-interface-hardening/ledger.json"
);
const requirementPath = resolve(repositoryRoot, "docs/planning/02-requirements.md");
const forbiddenEvidencePattern =
  /(?:ifc-v1-0(?:15|33)|direct[-_ ]lan|custom[-_ ]ca|certificate|tmux)/iu;

describe("IFC-V1-091 production interface hardening ledger", () => {
  it("binds the stored ledger to exact production routes and registrations", () => {
    const expected = createProductionInterfaceHardeningLedger();
    if (process.env.HOSTDECK_WRITE_INTERFACE_HARDENING_LEDGER === "1") {
      mkdirSync(dirname(ledgerPath), { mode: 0o755, recursive: true });
      writeFileSync(ledgerPath, `${JSON.stringify(expected, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644
      });
    }
    expect(existsSync(ledgerPath)).toBe(true);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual(expected);
    expect(Object.isFrozen(expected)).toBe(true);
    expect(selectedApiRouteManifest).toHaveLength(35);
    expect(hostDeckSelectedApiRouteCompositionDescriptor).toHaveLength(22);
    expect(
      hostDeckSelectedApiRouteCompositionDescriptor.flatMap((entry) => entry.manifestIds)
    ).toHaveLength(35);
  });

  it("covers every frozen criterion, dimension, requirement, and evidence owner once", () => {
    expect(productionInterfaceHardeningCriteria.map((entry) => entry.id)).toEqual(
      productionInterfaceHardeningCriterionIds
    );
    expect(new Set(productionInterfaceHardeningCriterionIds).size).toBe(24);
    expect(new Set(productionInterfaceHardeningRequirementIds).size).toBe(38);
    expect(new Set(productionInterfaceHardeningDimensions).size).toBe(16);

    const evidenceIds = productionInterfaceHardeningEvidence.map((entry) => entry.id);
    expect(new Set(evidenceIds).size).toBe(evidenceIds.length);
    const evidenceIdSet = new Set(evidenceIds);
    const criteria = readFileSync(criteriaPath, "utf8");
    const requirements = readFileSync(requirementPath, "utf8");
    const usedRequirements = new Set<string>();
    const usedDimensions = new Set<string>();

    for (const criterion of productionInterfaceHardeningCriteria) {
      expect(criteria.split(`| \`${criterion.id}\` |`)).toHaveLength(2);
      expect(criterion.requirements.length).toBeGreaterThan(0);
      expect(criterion.dimensions.length).toBeGreaterThan(0);
      expect(criterion.evidence_ids.length).toBeGreaterThan(0);
      for (const requirement of criterion.requirements) usedRequirements.add(requirement);
      for (const dimension of criterion.dimensions) usedDimensions.add(dimension);
      for (const evidenceId of criterion.evidence_ids) {
        expect(evidenceIdSet.has(evidenceId), `${criterion.id}: ${evidenceId}`).toBe(true);
      }
    }
    expect([...usedRequirements].sort()).toEqual(
      [...productionInterfaceHardeningRequirementIds].sort()
    );
    expect([...usedDimensions].sort()).toEqual(
      [...productionInterfaceHardeningDimensions].sort()
    );
    for (const requirement of productionInterfaceHardeningRequirementIds) {
      expect(requirements).toContain(`| ${requirement} |`);
    }
  });

  it("accepts only present selected-path evidence and current ancestor commits", () => {
    const levels = new Set<string>();
    for (const evidence of productionInterfaceHardeningEvidence) {
      expect(evidence.path).not.toMatch(forbiddenEvidencePattern);
      expect(existsSync(resolve(repositoryRoot, evidence.path)), evidence.path).toBe(true);
      levels.add(evidence.level);
      if (evidence.disposition !== "accepted_input") continue;
      const stored = JSON.parse(
        readFileSync(resolve(repositoryRoot, evidence.path), "utf8")
      ) as Record<string, unknown>;
      expect(stored[evidence.task_field]).toBe(evidence.task);
      expect(stored[evidence.commit_field]).toBe(evidence.commit);
      expect(() =>
        execFileSync("git", ["merge-base", "--is-ancestor", evidence.commit, "HEAD"], {
          cwd: repositoryRoot,
          stdio: "ignore",
          timeout: 10_000
        })
      ).not.toThrow();
    }
    expect([...levels].sort()).toEqual(["L1", "L2", "L3", "L4"]);
  });
});
