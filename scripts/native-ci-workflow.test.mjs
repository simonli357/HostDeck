import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  nativeCiWorkflowPath,
  verifyNativeCiWorkflow
} from "./native-ci-workflow.mjs";

test("accepts the exact least-privilege two-runner workflow", () => {
  assert.deepEqual(verifyNativeCiWorkflow(), {
    action_count: 3,
    check_count: 2,
    runner_count: 2,
    step_count: 7
  });
});

test("rejects permission, action pin, runner, and secret-policy drift", () => {
  const source = readFileSync(nativeCiWorkflowPath, "utf8");
  const mutations = [
    source.replace("contents: read", "contents: write"),
    source.replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v7"
    ),
    source.replace("windows-2022", "windows-latest"),
    `${source}\n# \${{ secrets.RELEASE_KEY }}\n`,
    source.replace("persist-credentials: false", "persist-credentials: true")
  ];
  const root = mkdtempSync(join(tmpdir(), "hostdeck-native-ci-workflow-"));
  try {
    for (const [index, mutation] of mutations.entries()) {
      const path = join(root, `${index}.yml`);
      writeFileSync(path, mutation, { mode: 0o600 });
      assert.throws(() => verifyNativeCiWorkflow(path));
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
