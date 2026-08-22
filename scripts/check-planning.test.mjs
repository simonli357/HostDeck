import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanningModel, extractRequirementIds, extractTaskIds } from "./planning-graph.mjs";
import { checkTechnicalPlanFacts, technicalPlanFacts } from "./technical-plan-facts.mjs";

const header = `| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |`;

const requirements = `# Requirements

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| FR-001 | First behavior. | Must | Test. |
| FR-002 | Second behavior. | Must | Test. |

## Traceability

| Requirement | Block refs | Task refs | Evidence route |
| --- | --- | --- | --- |
| \`FR-001\` | \`BLK-V1-01\` | \`FND-V1-001\` | Unit evidence. |
| \`FR-002\` | \`BLK-V1-01\` | \`FND-V1-002\` | Unit evidence. |`;

const queue = `# Tasks

| Order | Task | Status | Blocked by | Why next |
| --- | --- | --- | --- | --- |
| 1 | \`FND-V1-002\` Ready task | ready | none | Next. |`;

function modelFor(rows, requirementsText = requirements, queueText = queue) {
  return buildPlanningModel({
    taskDocuments: [{ source: "tasks.md", text: `${header}\n${rows}` }],
    requirementsText,
    queueText,
    blockIds: new Set(["BLK-V1-01"])
  });
}

test("accepts a valid dependency and trace graph", () => {
  const model = modelFor(`| \`FND-V1-001\` | done | \`BLK-V1-01\`, \`FR-001\` | none | none | \`FND-V1-002\` | First. | Done. | Evidence: artifacts/one.md. |
| \`FND-V1-002\` | ready | \`BLK-V1-01\`, \`FR-002\` | none | \`FND-V1-001\` | none | Second. | Ready. | Planned test. |`);
  assert.deepEqual(model.errors, []);
});

test("rejects duplicate tasks and dependency cycles", () => {
  const cycleQueue = queue.replace("ready", "todo");
  const model = modelFor(`| \`FND-V1-001\` | todo | \`BLK-V1-01\`, \`FR-001\` | none | \`FND-V1-002\` | \`FND-V1-002\` | First. | Done. | Planned. |
| \`FND-V1-002\` | todo | \`BLK-V1-01\`, \`FR-002\` | none | \`FND-V1-001\` | \`FND-V1-001\` | Second. | Done. | Planned. |
| \`FND-V1-002\` | todo | \`BLK-V1-01\`, \`FR-002\` | none | none | none | Duplicate. | Done. | Planned. |`, requirements, cycleQueue);
  assert(model.errors.some((error) => error.includes("duplicates FND-V1-002")));
  assert(model.errors.some((error) => error.includes("dependency cycle")));
});

test("rejects uncovered requirements and invalid ready dependencies", () => {
  const incompleteRequirements = requirements.replace(
    "| `FR-002` | `BLK-V1-01` | `FND-V1-002` | Unit evidence. |",
    ""
  );
  const model = modelFor(`| \`FND-V1-001\` | todo | \`BLK-V1-01\`, \`FR-001\` | none | none | \`FND-V1-002\` | First. | Done. | Planned. |
| \`FND-V1-002\` | ready | \`BLK-V1-01\`, \`FR-002\` | none | \`FND-V1-001\` | none | Second. | Ready. | Planned. |`, incompleteRequirements);
  assert(model.errors.some((error) => error.includes("requirement FR-002 has no trace row")));
  assert(model.errors.some((error) => error.includes("before FND-V1-001 is done")));
});

test("expands requirement and task ranges", () => {
  assert.deepEqual(extractRequirementIds("FR-001 to FR-003"), ["FR-001", "FR-002", "FR-003"]);
  assert.deepEqual(extractTaskIds("`INT-V1-003` to `INT-V1-005`"), [
    "INT-V1-003",
    "INT-V1-004",
    "INT-V1-005"
  ]);
});

test("rejects todo work with no unfinished dependency", () => {
  const todoQueue = queue.replace("ready", "todo");
  const model = modelFor(`| \`FND-V1-001\` | done | \`BLK-V1-01\`, \`FR-001\` | none | none | \`FND-V1-002\` | First. | Done. | Evidence: artifacts/one.md. |
| \`FND-V1-002\` | todo | \`BLK-V1-01\`, \`FR-002\` | none | \`FND-V1-001\` | none | Second. | Ready. | Planned. |`, requirements, todoQueue);
  assert(model.errors.some((error) => error.includes("mark it ready")));
});

const planSources = {
  planText: [
    "| Runtime | Pinned Node.js 22.22.2 and strict TypeScript; release packages bundle the native Node runtime. |",
    "| Host API | Exact `fastify` 5.10.0, `cookie` 1.1.1, and `zod` 4.4.3 with HostDeck-owned local type-provider/validator/serializer compilers. |",
    "- one strict flat `resourceBudgetSchema` with 2 integer limits",
    "currently 638 source modules across `core`"
  ].join("\n"),
  rootManifest: { engines: { node: "22.22.2" } },
  manifests: {
    "@hostdeck/server": { dependencies: { fastify: "5.10.0", cookie: "1.1.1" } },
    "@hostdeck/contracts": { dependencies: { zod: "4.4.3" } }
  },
  resourcePolicy: 'defineResource("http_one"...)\ndefineResource(\n  "browser_two"...)',
  codexResourceOptions: "",
  codexBindingManifest: "",
  tailscaleObserver: "",
  verifyProductionPackage: "export const productionPackageSourceCount = 638;",
  packageSmoke: ""
};

const planFactIds = ["fastify", "cookie", "zod", "node-runtime", "resource-budget-count", "source-module-count"];

function planFactsFor(overrides = {}) {
  return checkTechnicalPlanFacts({ ...planSources, ...overrides });
}

function planFactErrors(result) {
  return result.errors.filter((error) => planFactIds.some((id) => error.includes(`(${id})`)));
}

test("accepts a technical plan whose versions and counts match the workspace", () => {
  assert.deepEqual(planFactErrors(planFactsFor()), []);
});

test("declares every checked fact with a single-capture claim pattern", () => {
  for (const entry of technicalPlanFacts) {
    assert.equal(typeof entry.id, "string", `${entry.id} needs an id`);
    assert.equal(new RegExp(`|${entry.claim.source}`).exec("").length - 1, 1, `${entry.id} needs exactly one capture group`);
  }
});

test("rejects a technical plan whose dependency version drifted from the manifest", () => {
  const { errors } = planFactsFor({
    manifests: {
      ...planSources.manifests,
      "@hostdeck/server": { dependencies: { fastify: "5.11.0", cookie: "1.1.1" } }
    }
  });
  assert(errors.some((error) => error.includes("(fastify) claims 5.10.0 but the workspace has 5.11.0")));
});

test("rejects a technical plan whose counted fact drifted from code", () => {
  const { errors } = planFactsFor({
    verifyProductionPackage: "export const productionPackageSourceCount = 700;"
  });
  assert(errors.some((error) => error.includes("(source-module-count) claims 638 but the workspace has 700")));
});

test("rejects a dependency the plan pins but the workspace no longer has", () => {
  const { errors } = planFactsFor({
    manifests: { ...planSources.manifests, "@hostdeck/server": { dependencies: { fastify: "5.10.0" } } }
  });
  assert(errors.some((error) => error.includes("(cookie) is claimed as 1.1.1 but is absent from the workspace")));
});

test("rejects a reworded claim instead of silently skipping it", () => {
  const { errors } = planFactsFor({
    planText: planSources.planText.replace("with 2 integer limits", "holding 2 integer limits")
  });
  assert(errors.some((error) => error.includes("no claim found for resourceBudgetSchema limit count")));
});

test("counts multi-line defineResource declarations that a naive grep misses", () => {
  const { errors } = planFactsFor();
  assert(!errors.some((error) => error.includes("(resource-budget-count)")));
});
