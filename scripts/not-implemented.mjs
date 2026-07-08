const [scriptName, taskId] = process.argv.slice(2);

if (!scriptName || !taskId) {
  console.error("Usage: node scripts/not-implemented.mjs <script> <blocking-task-id>");
  process.exit(2);
}

console.error(
  `${scriptName} is planned but not implemented yet. Blocking task: ${taskId}. ` +
    "This placeholder exits nonzero so the scaffold cannot report fake readiness."
);

process.exit(1);
