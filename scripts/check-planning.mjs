import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildPlanningModel } from "./planning-graph.mjs";

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

if (model.errors.length > 0) {
  console.error(`Planning check failed with ${model.errors.length} error(s):`);
  for (const error of model.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const dependencyCount = [...model.dependencies.values()].reduce(
    (total, dependencies) => total + dependencies.length,
    0
  );
  console.log(
    `Planning OK: ${model.tasks.size} tasks, ${model.requirements.size} requirements, ${dependencyCount} dependencies, ${model.queue.length} queued.`
  );
}
