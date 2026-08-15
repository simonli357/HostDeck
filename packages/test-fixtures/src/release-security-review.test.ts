import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createReleaseSecurityReviewLedger,
  releaseSecurityReviewCriteria,
  releaseSecurityReviewCriterionIds,
  releaseSecurityReviewEvidence,
  releaseSecurityReviewRequirementIds,
  releaseSecurityReviewThreatClasses,
  releaseSecurityReviewTrustBoundaries
} from "./release-security-review.js";

const repositoryRoot = resolve(process.cwd());
const criteriaPath = resolve(
  repositoryRoot,
  "artifacts/rel-v1-005-security-privacy-release-review.md"
);
const ledgerPath = resolve(
  repositoryRoot,
  "artifacts/rel-v1-005-security-privacy-release-review/ledger.json"
);
const evidencePath = resolve(
  repositoryRoot,
  "artifacts/rel-v1-005-security-privacy-release-review/evidence.json"
);
const requirementsPath = resolve(repositoryRoot, "docs/planning/02-requirements.md");
const userGuidePath = resolve(repositoryRoot, "docs/delivery/08-user-guide.md");
const commandReferencePath = resolve(
  repositoryRoot,
  "docs/delivery/11-command-reference.md"
);
const interfaceEvidencePath = resolve(
  repositoryRoot,
  "artifacts/ifc-v1-091-selected-production-interface-hardening/evidence.json"
);
const routeManifestPath = resolve(
  repositoryRoot,
  "packages/server/src/selected-api-route-manifest.ts"
);
const forbiddenEvidencePath =
  /(?:direct[-_ ]lan|custom[-_ ]ca|certificate|tmux|ifc-v1-0(?:15|33))/iu;
const privateEvidencePattern =
  /(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+\.ts\.net)/iu;

describe("REL-V1-005 security and privacy release review ledger", () => {
  it("binds one immutable stored ledger to every frozen security dimension", () => {
    const expected = createReleaseSecurityReviewLedger();
    if (process.env.HOSTDECK_WRITE_RELEASE_SECURITY_LEDGER === "1") {
      mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o755 });
      writeFileSync(ledgerPath, `${JSON.stringify(expected, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644
      });
    }
    expect(existsSync(ledgerPath)).toBe(true);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual(expected);
    expect(Object.isFrozen(expected)).toBe(true);
    expect(releaseSecurityReviewCriterionIds).toHaveLength(24);
    expect(releaseSecurityReviewRequirementIds).toHaveLength(20);
    expect(releaseSecurityReviewThreatClasses).toHaveLength(16);
    expect(releaseSecurityReviewTrustBoundaries).toHaveLength(9);
  });

  it("covers every criterion, requirement, threat, boundary, and evidence owner", () => {
    expect(releaseSecurityReviewCriteria.map((entry) => entry.id)).toEqual(
      releaseSecurityReviewCriterionIds
    );
    expect(new Set(releaseSecurityReviewCriterionIds).size).toBe(24);
    expect(new Set(releaseSecurityReviewRequirementIds).size).toBe(20);
    expect(new Set(releaseSecurityReviewThreatClasses).size).toBe(16);
    expect(new Set(releaseSecurityReviewTrustBoundaries).size).toBe(9);

    const criteria = readFileSync(criteriaPath, "utf8");
    const requirements = readFileSync(requirementsPath, "utf8");
    const evidenceIds = new Set(releaseSecurityReviewEvidence.map((entry) => entry.id));
    const usedRequirements = new Set<string>();
    const usedThreats = new Set<string>();
    const usedBoundaries = new Set<string>();

    expect(evidenceIds.size).toBe(releaseSecurityReviewEvidence.length);
    for (const criterion of releaseSecurityReviewCriteria) {
      expect(criteria.split(`| \`${criterion.id}\` |`)).toHaveLength(2);
      expect(criterion.requirements.length).toBeGreaterThan(0);
      expect(criterion.threat_classes.length).toBeGreaterThan(0);
      expect(criterion.trust_boundaries.length).toBeGreaterThan(0);
      expect(criterion.evidence_ids.length).toBeGreaterThan(0);
      for (const requirement of criterion.requirements) usedRequirements.add(requirement);
      for (const threat of criterion.threat_classes) usedThreats.add(threat);
      for (const boundary of criterion.trust_boundaries) usedBoundaries.add(boundary);
      for (const evidenceId of criterion.evidence_ids) {
        expect(evidenceIds.has(evidenceId), `${criterion.id}: ${evidenceId}`).toBe(true);
      }
    }
    expect([...usedRequirements].sort()).toEqual(
      [...releaseSecurityReviewRequirementIds].sort()
    );
    expect([...usedThreats].sort()).toEqual(
      [...releaseSecurityReviewThreatClasses].sort()
    );
    expect([...usedBoundaries].sort()).toEqual(
      [...releaseSecurityReviewTrustBoundaries].sort()
    );
    for (const requirement of releaseSecurityReviewRequirementIds) {
      expect(requirements).toContain(`| ${requirement} |`);
    }
  });

  it("uses only present selected-path evidence and exact accepted L4 ancestors", () => {
    const levels = new Set<string>();
    for (const evidence of releaseSecurityReviewEvidence) {
      expect(evidence.path).not.toMatch(forbiddenEvidencePath);
      if (evidence.id !== "release_review_evidence") {
        expect(existsSync(resolve(repositoryRoot, evidence.path)), evidence.id).toBe(true);
      }
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

  it("binds the selected route graph and excludes alternate product surfaces", () => {
    const interfaceEvidence = JSON.parse(
      readFileSync(interfaceEvidencePath, "utf8")
    ) as { production_identity: Record<string, unknown> };
    expect(interfaceEvidence.production_identity.route_count).toBe(35);
    expect(interfaceEvidence.production_identity.registration_count).toBe(22);
    const routeManifest = readFileSync(routeManifestPath, "utf8");
    expect(routeManifest).not.toMatch(
      /(?:\/lan|\/terminal|\/shell|\/files|\/editor|\/git|app-server)/iu
    );
    expect(routeManifest.match(/^ {2}route\(/gmu)).toHaveLength(36);
    expect(routeManifest).not.toMatch(/owner_task: "IFC-V1-110"/gu);
  });

  it("keeps release-facing recovery guidance on the selected safe boundary", () => {
    const userGuide = readFileSync(userGuidePath, "utf8");
    const commands = readFileSync(commandReferencePath, "utf8");
    expect(userGuide).toContain("Tailscale grants private network reachability, not HostDeck application access.");
    expect(userGuide).toContain("Never install a HostDeck CA or bypass the warning.");
    expect(userGuide).toContain("Do not use `tailscale serve reset`");
    expect(userGuide).toContain("Remote unlock is intentionally unavailable.");
    expect(userGuide).toContain("no new QR scan is required");
    expect(commands).not.toMatch(/tailscale\s+serve\s+(?:reset|funnel)/iu);
    expect(commands).not.toMatch(/codexdeck\s+lan\b/iu);
    expect(commands).not.toMatch(/(?:certutil|update-ca-certificates|adb\s+reverse)/iu);
  });

  it.runIf(process.env.HOSTDECK_REQUIRE_RELEASE_SECURITY_EVIDENCE === "1")(
    "requires a private-free final all-pass record under the exact ledger",
    () => {
      const raw = readFileSync(evidencePath, "utf8");
      expect(raw).not.toMatch(privateEvidencePattern);
      const evidence = JSON.parse(raw) as {
        task: string;
        status: string;
        criteria: Array<{ id: string; status: string }>;
        requirements: string[];
        unresolved_security_blockers: number;
        accepted_l4_inputs: Array<{ task: string; commit: string }>;
      };
      expect(evidence.task).toBe("REL-V1-005");
      expect(evidence.status).toBe("pass");
      expect(evidence.criteria).toEqual(
        releaseSecurityReviewCriterionIds.map((id) => ({ id, status: "pass" }))
      );
      expect(evidence.requirements).toEqual(releaseSecurityReviewRequirementIds);
      expect(evidence.unresolved_security_blockers).toBe(0);
      expect(evidence.accepted_l4_inputs).toEqual([
        {
          task: "IFC-V1-058",
          commit: "eb77647e8b1e77e42b16fef21b65da0d1b65ea8e"
        },
        {
          task: "IFC-V1-079",
          commit: "b4078b6d411267dec9701ed5ae67037567a9dee9"
        }
      ]);
    }
  );
});
