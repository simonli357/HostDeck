import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildPlanningModel } from "./planning-graph.mjs";
import { checkTechnicalPlanFacts } from "./technical-plan-facts.mjs";

const backlogDirectory = "docs/tracking/backlog";
const taskDocuments = readdirSync(backlogDirectory)
  .filter(
    (name) => name.endsWith(".md") && name !== "00-index.md" && !name.endsWith("-template.md")
  )
  .sort()
  .map((name) => {
    const source = join(backlogDirectory, name);
    return { source, text: readFileSync(source, "utf8") };
  });

const blockIds = new Set(
  readdirSync("docs/planning/05-blocks")
    .map((name) => /^BLK-V1-(\d{2})-/.exec(name)?.[1])
    .filter(Boolean)
    .map((number) => `BLK-V1-${number}`)
);

const model = buildPlanningModel({
  taskDocuments,
  requirementsText: readFileSync("docs/planning/02-requirements.md", "utf8"),
  queueText: readFileSync("docs/tracking/06-tasks.md", "utf8"),
  blockIds
});

const packageNames = [
  "@hostdeck/core",
  "@hostdeck/contracts",
  "@hostdeck/codex-adapter",
  "@hostdeck/storage",
  "@hostdeck/server",
  "@hostdeck/cli",
  "@hostdeck/web",
  "@hostdeck/test-fixtures"
];
const manifests = Object.fromEntries(
  readdirSync("packages")
    .map((directory) => join("packages", directory, "package.json"))
    .map((source) => JSON.parse(readFileSync(source, "utf8")))
    .map((manifest) => [manifest.name, manifest])
);
for (const name of packageNames) {
  if (manifests[name] === undefined) {
    throw new Error(`Planning check cannot resolve workspace package ${name}.`);
  }
}

const planFacts = checkTechnicalPlanFacts({
  planText: readFileSync("docs/planning/04-technical-plan.md", "utf8"),
  rootManifest: JSON.parse(readFileSync("package.json", "utf8")),
  manifests,
  resourcePolicy: readFileSync("packages/contracts/src/resource-policy.ts", "utf8"),
  codexResourceOptions: readFileSync("packages/codex-adapter/src/resource-options.ts", "utf8"),
  codexBindingManifest: readFileSync("packages/codex-adapter/src/binding-manifest.generated.ts", "utf8"),
  tailscaleObserver: readFileSync("packages/server/src/tailscale-observer.ts", "utf8"),
  verifyProductionPackage: readFileSync("scripts/verify-production-package.mjs", "utf8"),
  packageSmoke: readFileSync("scripts/run-production-package-smoke.mjs", "utf8")
});

const errors = [...model.errors, ...planFacts.errors];

if (errors.length > 0) {
  console.error(`Planning check failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const dependencyCount = [...model.dependencies.values()].reduce(
    (total, dependencies) => total + dependencies.length,
    0
  );
  console.log(
    `Planning OK: ${model.tasks.size} tasks, ${model.requirements.size} requirements, ${dependencyCount} dependencies, ${model.queue.length} queued, ${planFacts.checked} technical-plan facts.`
  );
}
