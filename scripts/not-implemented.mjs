const [scriptName, ...taskIds] = process.argv.slice(2);

if (!scriptName || taskIds.length === 0) {
  console.error("Usage: node scripts/not-implemented.mjs <script> <blocking-task-id> [additional-task-id...]");
  process.exit(2);
}

console.error(
  `${scriptName} is planned but not implemented yet. Blocking task(s): ${taskIds.join(", ")}. ` +
    "This placeholder exits nonzero so the scaffold cannot report fake readiness."
);

process.exit(1);
