import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNativeCiEvidence,
  nativeCiTargetPolicies,
  parseNativeCiEvidence,
  serializeNativeCiEvidence,
  verifyNativeCiEvidenceFile,
  writeNativeCiEvidence
} from "./native-ci-evidence.mjs";

test("accepts exact Linux and Windows native CI evidence", () => {
  for (const target of Object.keys(nativeCiTargetPolicies)) {
    const evidence = createNativeCiEvidence(fixture(target));
    assert.equal(evidence.target, target);
    assert.equal(evidence.status, "passed");
    assert.deepEqual(
      evidence.checks.map(({ id }) => id),
      nativeCiTargetPolicies[target].checks
    );
    assert.equal(Object.isFrozen(evidence), true);
    assert.deepEqual(parseNativeCiEvidence(evidence), evidence);
    assert.equal(serializeNativeCiEvidence(evidence).endsWith("\n"), true);
  }
});

test("rejects skipped, partial, mismatched, and secret-bearing evidence", () => {
  const baseline = fixture("windows-x64");
  const mutations = [
    { ...baseline, checks: baseline.checks.slice(1) },
    {
      ...baseline,
      checks: baseline.checks.map((check, index) =>
        index === 0 ? { ...check, status: "skipped" } : check
      )
    },
    {
      ...baseline,
      runner: { ...baseline.runner, node_platform: "linux" }
    },
    {
      ...baseline,
      runner: { ...baseline.runner, image_version: "private/token" }
    },
    { ...baseline, private_path: "C:\\Users\\private" }
  ];
  for (const mutation of mutations) {
    assert.throws(() => createNativeCiEvidence(mutation));
  }
});

test("writes and independently verifies one canonical digest-bound artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-native-ci-evidence-"));
  try {
    const path = join(root, "linux-x64.json");
    const expected = createNativeCiEvidence(fixture("linux-x64"));
    writeNativeCiEvidence(path, fixture("linux-x64"));
    assert.deepEqual(verifyNativeCiEvidenceFile(path), expected);
    assert.match(readFileSync(`${path}.sha256`, "utf8"), /^[a-f0-9]{64} {2}linux-x64\.json\n$/u);

    writeFileSync(`${path}.sha256`, `${"0".repeat(64)}  linux-x64.json\n`);
    assert.throws(() => verifyNativeCiEvidenceFile(path), /digest is invalid/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(target) {
  const policy = nativeCiTargetPolicies[target];
  return {
    target,
    generated_at: "2026-08-11T04:00:00.000Z",
    workflow: {
      event: "push",
      name: "native-ci",
      run_attempt: 1,
      run_id: "123456789"
    },
    source: {
      commit: "1".repeat(40),
      lockfile_sha256: "2".repeat(64)
    },
    runner: {
      architecture: policy.architecture,
      image_version: "20260810.1.0",
      label: policy.runner_label,
      node_platform: policy.node_platform,
      os_release: policy.node_platform === "win32" ? "10.0.20348" : "6.8.0-azure"
    },
    toolchain: {
      node_module_abi: "127",
      node_napi: "10",
      node_version: "22.22.2",
      pnpm_version: "10.29.2"
    },
    native_dependencies: [
      { name: "better-sqlite3", version: "12.11.1" },
      { name: "fs-native-extensions", version: "1.3.4" }
    ],
    checks: policy.checks.map((id, index) => ({
      duration_ms: index + 1,
      id,
      status: "passed"
    }))
  };
}
