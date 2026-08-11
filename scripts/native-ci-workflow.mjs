import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const nativeCiWorkflowPath = resolve(
  scriptDirectory,
  "..",
  ".github",
  "workflows",
  "native-ci.yml"
);

const actionPins = Object.freeze({
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
});
const githubExpression = (value) => ["$", "{{ ", value, " }}"].join("");
const matrixRunnerExpression = githubExpression("matrix.runner");
const matrixTargetExpression = githubExpression("matrix.target");
const runnerTempExpression = githubExpression("runner.temp");

export function verifyNativeCiWorkflow(path = nativeCiWorkflowPath) {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 100 || bytes.byteLength > 16 * 1024) {
    throw new TypeError("Native CI workflow size is invalid.");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /pull_request_target|continue-on-error|permissions:\s*write|secrets\.|@[A-Za-z0-9_.-]*v[0-9]|(?:ubuntu|windows)-latest/iu.test(
      source
    )
  ) {
    throw new TypeError("Native CI workflow contains an unsafe policy.");
  }
  const workflow = exactRecord(
    parse(source, { maxAliasCount: 0, uniqueKeys: true }),
    ["concurrency", "jobs", "name", "on", "permissions"],
    "workflow"
  );
  exactString(workflow.name, "native-ci", "workflow.name");
  const triggers = exactRecord(
    workflow.on,
    ["pull_request", "push", "workflow_dispatch"],
    "workflow.on"
  );
  const push = exactRecord(triggers.push, ["branches"], "workflow.on.push");
  exactArray(push.branches, ["main"], "workflow.on.push.branches");
  requireCondition(triggers.pull_request === null, "workflow.on.pull_request is invalid.");
  requireCondition(triggers.workflow_dispatch === null, "workflow.on.workflow_dispatch is invalid.");
  const permissions = exactRecord(workflow.permissions, ["contents"], "workflow.permissions");
  exactString(permissions.contents, "read", "workflow.permissions.contents");
  const concurrency = exactRecord(
    workflow.concurrency,
    ["cancel-in-progress", "group"],
    "workflow.concurrency"
  );
  requireCondition(concurrency["cancel-in-progress"] === true, "Workflow cancellation is invalid.");
  exactString(
    concurrency.group,
    `native-ci-${githubExpression("github.workflow")}-${githubExpression(
      "github.event.pull_request.number || github.ref"
    )}`,
    "workflow.concurrency.group"
  );
  const jobs = exactRecord(workflow.jobs, ["native"], "workflow.jobs");
  const job = exactRecord(
    jobs.native,
    ["env", "name", "runs-on", "steps", "strategy", "timeout-minutes"],
    "workflow.jobs.native"
  );
  exactString(job.name, `Native ${matrixTargetExpression}`, "workflow.jobs.native.name");
  exactString(job["runs-on"], matrixRunnerExpression, "workflow.jobs.native.runs-on");
  requireCondition(job["timeout-minutes"] === 30, "Native CI timeout is invalid.");
  const strategy = exactRecord(job.strategy, ["fail-fast", "matrix"], "workflow strategy");
  requireCondition(strategy["fail-fast"] === false, "Native CI fail-fast policy is invalid.");
  const matrix = exactRecord(strategy.matrix, ["include"], "workflow matrix");
  requireCondition(
    JSON.stringify(matrix.include) ===
      JSON.stringify([
        { target: "linux-x64", runner: "ubuntu-24.04" },
        { target: "windows-x64", runner: "windows-2022" }
      ]),
    "Native CI matrix is invalid."
  );
  const env = exactRecord(job.env, ["HOSTDECK_NATIVE_RUNNER_LABEL"], "workflow job env");
  exactString(
    env.HOSTDECK_NATIVE_RUNNER_LABEL,
    matrixRunnerExpression,
    "workflow job runner label"
  );
  const steps = job.steps;
  requireCondition(Array.isArray(steps) && steps.length === 7, "Native CI step count is invalid.");
  verifyCheckoutStep(steps[0]);
  verifySetupNodeStep(steps[1]);
  verifyRunStep(
    steps[2],
    "Activate exact pnpm",
    "corepack enable\ncorepack prepare pnpm@10.29.2 --activate\n"
  );
  verifyRunStep(steps[3], "Install frozen dependencies", "pnpm install --frozen-lockfile");
  verifyRunStep(
    steps[4],
    "Run native checks",
    `node scripts/run-native-ci.mjs --target "${matrixTargetExpression}" --output "${runnerTempExpression}/hostdeck-native-ci/${matrixTargetExpression}.json"`
  );
  verifyRunStep(
    steps[5],
    "Verify sanitized evidence",
    `node scripts/native-ci-evidence.mjs verify "${runnerTempExpression}/hostdeck-native-ci/${matrixTargetExpression}.json"`
  );
  verifyUploadStep(steps[6]);
  return Object.freeze({
    action_count: 3,
    check_count: 2,
    runner_count: 2,
    step_count: steps.length
  });
}

function verifyCheckoutStep(candidate) {
  const step = exactRecord(candidate, ["name", "uses", "with"], "checkout step");
  exactString(step.name, "Check out exact source", "checkout step name");
  exactString(step.uses, actionPins.checkout, "checkout action");
  const input = exactRecord(
    step.with,
    ["fetch-depth", "persist-credentials", "submodules"],
    "checkout input"
  );
  requireCondition(input["fetch-depth"] === 1, "Checkout depth is invalid.");
  requireCondition(input["persist-credentials"] === false, "Checkout credentials are persistent.");
  requireCondition(input.submodules === false, "Checkout submodule policy is invalid.");
}

function verifySetupNodeStep(candidate) {
  const step = exactRecord(candidate, ["name", "uses", "with"], "setup-node step");
  exactString(step.name, "Install exact Node", "setup-node step name");
  exactString(step.uses, actionPins.setupNode, "setup-node action");
  const input = exactRecord(
    step.with,
    ["check-latest", "node-version", "package-manager-cache"],
    "setup-node input"
  );
  requireCondition(input["check-latest"] === false, "Node latest-check policy is invalid.");
  exactString(input["node-version"], "22.22.2", "Node version");
  requireCondition(input["package-manager-cache"] === false, "Package-manager cache is enabled.");
}

function verifyRunStep(candidate, name, command) {
  const step = exactRecord(candidate, ["name", "run"], `${name} step`);
  exactString(step.name, name, `${name} step name`);
  exactString(step.run, command, `${name} command`);
}

function verifyUploadStep(candidate) {
  const step = exactRecord(candidate, ["name", "uses", "with"], "upload step");
  exactString(step.name, "Upload sanitized evidence", "upload step name");
  exactString(step.uses, actionPins.uploadArtifact, "upload action");
  const input = exactRecord(
    step.with,
    [
      "compression-level",
      "if-no-files-found",
      "include-hidden-files",
      "name",
      "overwrite",
      "path",
      "retention-days"
    ],
    "upload input"
  );
  requireCondition(input["compression-level"] === 9, "Artifact compression is invalid.");
  exactString(input["if-no-files-found"], "error", "Missing artifact policy");
  requireCondition(input["include-hidden-files"] === false, "Hidden artifact files are enabled.");
  exactString(input.name, `hostdeck-native-ci-${matrixTargetExpression}`, "Artifact name");
  requireCondition(input.overwrite === false, "Artifact overwrite is enabled.");
  exactString(input.path, `${runnerTempExpression}/hostdeck-native-ci`, "Artifact path");
  requireCondition(input["retention-days"] === 14, "Artifact retention is invalid.");
}

function exactRecord(candidate, keys, label) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid.`);
  }
  return candidate;
}

function exactArray(candidate, expected, label) {
  requireCondition(
    Array.isArray(candidate) && JSON.stringify(candidate) === JSON.stringify(expected),
    `${label} is invalid.`
  );
}

function exactString(candidate, expected, label) {
  requireCondition(candidate === expected, `${label} is invalid.`);
}

function requireCondition(condition, message) {
  if (!condition) throw new TypeError(message);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = verifyNativeCiWorkflow();
    process.stdout.write(
      `HostDeck native CI workflow verified: ${result.runner_count} runners, ${result.step_count} steps.\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Native CI workflow verification failed."}\n`
    );
    process.exitCode = 1;
  }
}
