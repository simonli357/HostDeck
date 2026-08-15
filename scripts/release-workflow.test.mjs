import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  releaseWorkflowPath,
  verifyReleaseWorkflow
} from "./release-workflow.mjs";

const githubTokenExpression = ["$", "{{ github.token }}"].join("");
const releaseTokenExpression = ["$", "{{ secrets.RELEASE_TOKEN }}"].join("");

test("accepts the exact pinned attestation-before-draft workflow", () => {
  assert.deepEqual(verifyReleaseWorkflow(), {
    actionCount: 3,
    stepCount: 14,
    subjectCount: 11
  });
});

test("rejects permission, trigger, mutable-action, secret, and publication-order drift", () => {
  const source = readFileSync(releaseWorkflowPath, "utf8");
  const mutations = [
    source.replace("id-token: write", "id-token: read"),
    source.replace('      - "v*"', '      - "release-*"'),
    source.replace(
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
      "actions/attest@v4"
    ),
    source.replace(`GH_TOKEN: ${githubTokenExpression}`, `GH_TOKEN: ${releaseTokenExpression}`),
    source.replace("--draft \\", "--latest \\") ,
    source.replace("      - name: Attest verified release assets", "      - name: Create draft release early"),
    `${source}\n# \${{ secrets.RELEASE_KEY }}\n`
  ];
  const root = mkdtempSync(join(tmpdir(), "hostdeck-release-workflow-"));
  try {
    for (const [index, mutation] of mutations.entries()) {
      const path = join(root, `${index}.yml`);
      writeFileSync(path, mutation, { mode: 0o600 });
      assert.throws(() => verifyReleaseWorkflow(path));
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
