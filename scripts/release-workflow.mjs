import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const releaseWorkflowPath = resolve(
  scriptDirectory,
  "..",
  ".github",
  "workflows",
  "release.yml"
);

const actionPins = Object.freeze({
  attest: "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
});
const githubExpression = (value) => ["$", "{{ ", value, " }}"].join("");
const runnerTempExpression = githubExpression("runner.temp");
const githubWorkspaceExpression = githubExpression("github.workspace");
const githubRefNameExpression = githubExpression("github.ref_name");

export function verifyReleaseWorkflow(path = releaseWorkflowPath) {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 100 || bytes.byteLength > 32 * 1024) {
    throw new TypeError("Release workflow size is invalid.");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /pull_request_target|workflow_dispatch|continue-on-error|secrets\.|@[A-Za-z0-9_.-]*v[0-9]|ubuntu-latest|curl\b|wget\b|sudo\b/iu.test(
      source
    )
  ) {
    throw new TypeError("Release workflow contains an unsafe policy.");
  }
  const workflow = exactRecord(
    parse(source, { maxAliasCount: 0, uniqueKeys: true }),
    ["concurrency", "jobs", "name", "on", "permissions"],
    "workflow"
  );
  exactString(workflow.name, "release", "workflow.name");
  const triggers = exactRecord(workflow.on, ["push"], "workflow.on");
  const push = exactRecord(triggers.push, ["tags"], "workflow.on.push");
  exactArray(push.tags, ["v*"], "workflow.on.push.tags");
  exactRecord(workflow.permissions, [], "workflow.permissions");
  const concurrency = exactRecord(
    workflow.concurrency,
    ["cancel-in-progress", "group"],
    "workflow.concurrency"
  );
  exactString(
    concurrency.group,
    `release-${githubExpression("github.ref")}`,
    "workflow.concurrency.group"
  );
  requireCondition(
    concurrency["cancel-in-progress"] === false,
    "Release cancellation policy is invalid."
  );
  const jobs = exactRecord(workflow.jobs, ["ubuntu"], "workflow.jobs");
  const job = exactRecord(
    jobs.ubuntu,
    ["env", "if", "name", "permissions", "runs-on", "steps", "timeout-minutes"],
    "workflow.jobs.ubuntu"
  );
  exactString(job.name, "Ubuntu release", "release job name");
  exactString(
    job.if,
    "github.repository == 'simonli357/HostDeck'",
    "release repository condition"
  );
  exactString(job["runs-on"], "ubuntu-24.04", "release runner");
  requireCondition(job["timeout-minutes"] === 60, "Release timeout is invalid.");
  const permissions = exactRecord(
    job.permissions,
    ["artifact-metadata", "attestations", "contents", "id-token"],
    "release permissions"
  );
  for (const name of ["artifact-metadata", "attestations", "contents", "id-token"]) {
    exactString(permissions[name], "write", `release permission ${name}`);
  }
  const env = exactRecord(job.env, ["HOSTDECK_NATIVE_RUNNER_LABEL"], "release env");
  exactString(env.HOSTDECK_NATIVE_RUNNER_LABEL, "ubuntu-24.04", "native runner label");
  const steps = job.steps;
  requireCondition(Array.isArray(steps) && steps.length === 14, "Release step count is invalid.");
  verifyCheckoutStep(steps[0]);
  verifySetupNodeStep(steps[1]);
  verifyRunStep(
    steps[2],
    "Activate exact pnpm",
    "corepack enable\ncorepack prepare pnpm@10.29.2 --activate\n"
  );
  verifyRunStep(steps[3], "Install frozen dependencies", "pnpm install --frozen-lockfile");
  verifyRunStep(steps[4], "Verify release workflow policy", "pnpm check:release-workflow");
  verifyRunStep(
    steps[5],
    "Run Ubuntu native release checks",
    `node scripts/run-native-ci.mjs --target linux-x64 --output "${runnerTempExpression}/hostdeck-native-ci/linux-x64.json"`
  );
  verifyRunStep(
    steps[6],
    "Verify native release evidence",
    `node scripts/native-ci-evidence.mjs verify "${runnerTempExpression}/hostdeck-native-ci/linux-x64.json"`
  );
  verifyRunStep(steps[7], "Build verified Ubuntu package", "pnpm build");
  const commonReleaseArguments = `--package "${githubWorkspaceExpression}/dist/hostdeck" --evidence "${runnerTempExpression}/hostdeck-native-ci/linux-x64.json"`;
  verifyRunStep(
    steps[8],
    "Generate supply-chain metadata",
    `pnpm release:metadata ${commonReleaseArguments} --output "${runnerTempExpression}/hostdeck-release-metadata" --repository "${githubWorkspaceExpression}"`
  );
  verifyRunStep(
    steps[9],
    "Verify supply-chain metadata",
    `pnpm verify:release-metadata ${commonReleaseArguments} --output "${runnerTempExpression}/hostdeck-release-metadata" --repository "${githubWorkspaceExpression}"`
  );
  const commonBundleArguments = `--package "${githubWorkspaceExpression}/dist/hostdeck" --metadata "${runnerTempExpression}/hostdeck-release-metadata" --evidence "${runnerTempExpression}/hostdeck-native-ci/linux-x64.json" --output "${runnerTempExpression}/hostdeck-release" --repository "${githubWorkspaceExpression}" --tag "${githubRefNameExpression}"`;
  verifyRunStep(
    steps[10],
    "Generate deterministic release bundle",
    `pnpm release:bundle ${commonBundleArguments}`
  );
  verifyRunStep(
    steps[11],
    "Verify deterministic release bundle",
    `pnpm verify:release-bundle ${commonBundleArguments}`
  );
  verifyAttestationStep(steps[12]);
  verifyPublicationStep(steps[13]);
  return Object.freeze({ actionCount: 3, stepCount: steps.length, subjectCount: 11 });
}

function verifyCheckoutStep(candidate) {
  const step = exactRecord(candidate, ["name", "uses", "with"], "checkout step");
  exactString(step.name, "Check out exact tag", "checkout step name");
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

function verifyAttestationStep(candidate) {
  const step = exactRecord(candidate, ["id", "name", "uses", "with"], "attestation step");
  exactString(step.id, "attest", "attestation id");
  exactString(step.name, "Attest verified release assets", "attestation step name");
  exactString(step.uses, actionPins.attest, "attestation action");
  const input = exactRecord(step.with, ["show-summary", "subject-path"], "attestation input");
  exactString(
    input["subject-path"],
    `${runnerTempExpression}/hostdeck-release/*`,
    "attestation subject path"
  );
  requireCondition(input["show-summary"] === false, "Attestation summary policy is invalid.");
}

function verifyPublicationStep(candidate) {
  const step = exactRecord(candidate, ["env", "name", "run"], "publication step");
  exactString(step.name, "Create draft release", "publication step name");
  const env = exactRecord(step.env, ["GH_REPO", "GH_TOKEN"], "publication env");
  exactString(env.GH_REPO, "simonli357/HostDeck", "publication repository");
  exactString(env.GH_TOKEN, githubExpression("github.token"), "publication token");
  exactString(
    step.run,
    `test -f "${githubExpression("steps.attest.outputs.bundle-path")}"\nversion="\${GITHUB_REF_NAME#v}"\nnotes="$RUNNER_TEMP/hostdeck-release/hostdeck-\${version}-linux-x64.release-notes.md"\ntest -f "$notes"\ngh release create "$GITHUB_REF_NAME" \\\n  "$RUNNER_TEMP"/hostdeck-release/* \\\n  "${githubExpression("steps.attest.outputs.bundle-path")}" \\\n  --draft \\\n  --verify-tag \\\n  --title "HostDeck $GITHUB_REF_NAME" \\\n  --notes-file "$notes"\n`,
    "publication command"
  );
}

function verifyRunStep(candidate, name, command) {
  const step = exactRecord(candidate, ["name", "run"], `${name} step`);
  exactString(step.name, name, `${name} step name`);
  exactString(step.run, command, `${name} command`);
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

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = verifyReleaseWorkflow();
    process.stdout.write(
      `HostDeck release workflow verified: ${result.actionCount} pinned actions, ${result.stepCount} ordered steps.\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release workflow verification failed."}\n`
    );
    process.exitCode = 1;
  }
}
