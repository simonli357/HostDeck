import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanningModel, extractRequirementIds, extractTaskIds } from "./planning-graph.mjs";

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
