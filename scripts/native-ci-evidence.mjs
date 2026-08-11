import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const safeTokenPattern = /^[A-Za-z0-9._+-]{1,128}$/u;
const eventNames = Object.freeze(["pull_request", "push", "workflow_dispatch"]);

export const nativeCiTargetPolicies = Object.freeze({
  "linux-x64": Object.freeze({
    architecture: "x64",
    checks: Object.freeze([
      "scaffold",
      "planning",
      "runtime_boundary",
      "typecheck",
      "lint",
      "contract",
      "native_lock",
      "native_storage",
      "state_hardening",
      "windows_paths",
      "tailscale_adapter",
      "codex_tui_resume_smoke",
      "platform_tui_resume",
      "integration",
      "web_build",
      "native_modules",
      "package",
      "supply_chain"
    ]),
    node_platform: "linux",
    runner_label: "ubuntu-24.04"
  }),
  "windows-x64": Object.freeze({
    architecture: "x64",
    checks: Object.freeze([
      "scaffold",
      "planning",
      "runtime_boundary",
      "typecheck",
      "lint",
      "contract",
      "native_lock",
      "native_storage",
      "state_hardening",
      "windows_paths",
      "tailscale_adapter",
      "codex_transport_spike",
      "windows_supervisor",
      "platform_tui_resume",
      "web_build",
      "native_modules",
      "supply_chain"
    ]),
    node_platform: "win32",
    runner_label: "windows-2022"
  })
});

export function createNativeCiEvidence(input) {
  const value = exactRecord(
    input,
    [
      "checks",
      "generated_at",
      "native_dependencies",
      "runner",
      "source",
      "target",
      "toolchain",
      "workflow"
    ],
    "input"
  );
  const target = parseTarget(value.target);
  const policy = nativeCiTargetPolicies[target];
  const checks = exactArray(value.checks, policy.checks.length, "checks").map(
    (candidate, index) => {
      const value = exactRecord(candidate, ["duration_ms", "id", "status"], `checks[${index}]`);
      exactInteger(value.duration_ms, 0, 3_600_000, `checks[${index}].duration_ms`);
      exactString(value.id, policy.checks[index], `checks[${index}].id`);
      exactString(value.status, "passed", `checks[${index}].status`);
      return Object.freeze({
        duration_ms: value.duration_ms,
        id: value.id,
        status: value.status
      });
    }
  );
  const dependencies = exactArray(value.native_dependencies, 3, "native_dependencies");
  const expectedDependencies = [
    ["better-sqlite3", "12.11.1"],
    ["fs-native-extensions", "1.3.4"],
    ["koffi", "3.1.4"]
  ];
  const parsedDependencies = dependencies.map((candidate, index) => {
    const value = exactRecord(candidate, ["name", "version"], `native_dependencies[${index}]`);
    exactString(value.name, expectedDependencies[index][0], `native_dependencies[${index}].name`);
    exactString(value.version, expectedDependencies[index][1], `native_dependencies[${index}].version`);
    return Object.freeze({ name: value.name, version: value.version });
  });
  const source = exactRecord(value.source, ["commit", "lockfile_sha256"], "source");
  requirePattern(source.commit, commitPattern, "source.commit");
  requirePattern(source.lockfile_sha256, sha256Pattern, "source.lockfile_sha256");
  const runner = exactRecord(
    value.runner,
    ["architecture", "image_version", "label", "node_platform", "os_release"],
    "runner"
  );
  exactString(runner.architecture, policy.architecture, "runner.architecture");
  requirePattern(runner.image_version, safeTokenPattern, "runner.image_version");
  exactString(runner.label, policy.runner_label, "runner.label");
  exactString(runner.node_platform, policy.node_platform, "runner.node_platform");
  requirePattern(runner.os_release, safeTokenPattern, "runner.os_release");
  const toolchain = exactRecord(
    value.toolchain,
    ["node_module_abi", "node_napi", "node_version", "pnpm_version"],
    "toolchain"
  );
  exactString(toolchain.node_module_abi, "127", "toolchain.node_module_abi");
  exactString(toolchain.node_napi, "10", "toolchain.node_napi");
  exactString(toolchain.node_version, "22.22.2", "toolchain.node_version");
  exactString(toolchain.pnpm_version, "10.29.2", "toolchain.pnpm_version");
  const workflow = exactRecord(
    value.workflow,
    ["event", "name", "run_attempt", "run_id"],
    "workflow"
  );
  if (!eventNames.includes(workflow.event)) throw new TypeError("workflow.event is invalid.");
  exactString(workflow.name, "native-ci", "workflow.name");
  exactInteger(workflow.run_attempt, 1, 1_000, "workflow.run_attempt");
  requirePattern(workflow.run_id, /^[1-9][0-9]{0,19}$/u, "workflow.run_id");
  const generatedAt = new Date(value.generated_at);
  if (
    typeof value.generated_at !== "string" ||
    !Number.isFinite(generatedAt.getTime()) ||
    generatedAt.toISOString() !== value.generated_at
  ) {
    throw new TypeError("generated_at is invalid.");
  }

  return deepFreeze({
    schema_version: 1,
    task_id: "REL-V1-101",
    status: "passed",
    target,
    generated_at: value.generated_at,
    workflow: { ...workflow },
    source: { ...source },
    runner: { ...runner },
    toolchain: { ...toolchain },
    native_dependencies: parsedDependencies,
    checks
  });
}

export function parseNativeCiEvidence(candidate) {
  const value = exactRecord(
    candidate,
    [
      "checks",
      "generated_at",
      "native_dependencies",
      "runner",
      "schema_version",
      "source",
      "status",
      "target",
      "task_id",
      "toolchain",
      "workflow"
    ],
    "evidence"
  );
  exactInteger(value.schema_version, 1, 1, "evidence.schema_version");
  exactString(value.task_id, "REL-V1-101", "evidence.task_id");
  exactString(value.status, "passed", "evidence.status");
  return createNativeCiEvidence({
    checks: value.checks,
    generated_at: value.generated_at,
    native_dependencies: value.native_dependencies,
    runner: value.runner,
    source: value.source,
    target: value.target,
    toolchain: value.toolchain,
    workflow: value.workflow
  });
}

export function serializeNativeCiEvidence(candidate) {
  const serialized = `${JSON.stringify(parseNativeCiEvidence(candidate), null, 2)}\n`;
  if (
    Buffer.byteLength(serialized, "utf8") > 64 * 1024 ||
    /https?:\/\/|[A-Za-z]:\\|\/(?:home|Users)\/|authorization|password|secret|token|\.ts\.net/iu.test(
      serialized
    )
  ) {
    throw new TypeError("Native CI evidence contains private material or exceeds its bound.");
  }
  return serialized;
}

export function writeNativeCiEvidence(path, candidate) {
  const outputPath = resolve(path);
  const evidence = createNativeCiEvidence(candidate);
  const serialized = serializeNativeCiEvidence(evidence);
  const digest = createHash("sha256").update(serialized).digest("hex");
  mkdirSync(dirname(outputPath), { mode: 0o700, recursive: true });
  writeFileSync(outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(`${outputPath}.sha256`, `${digest}  ${basename(outputPath)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze({ digest, evidence, path: outputPath });
}

export function verifyNativeCiEvidenceFile(path) {
  const outputPath = resolve(path);
  const bytes = readFileSync(outputPath);
  if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024) {
    throw new TypeError("Native CI evidence file size is invalid.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const evidence = parseNativeCiEvidence(JSON.parse(text));
  if (serializeNativeCiEvidence(evidence) !== text) {
    throw new TypeError("Native CI evidence is not canonical.");
  }
  const digest = createHash("sha256").update(text).digest("hex");
  const sidecar = readFileSync(`${outputPath}.sha256`, "utf8");
  if (sidecar !== `${digest}  ${basename(outputPath)}\n`) {
    throw new TypeError("Native CI evidence digest is invalid.");
  }
  return evidence;
}

function parseTarget(candidate) {
  if (!Object.hasOwn(nativeCiTargetPolicies, candidate)) {
    throw new TypeError("Native CI target is invalid.");
  }
  return candidate;
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

function exactArray(candidate, length, label) {
  if (!Array.isArray(candidate) || candidate.length !== length) {
    throw new TypeError(`${label} length is invalid.`);
  }
  return candidate;
}

function exactInteger(candidate, minimum, maximum, label) {
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function exactString(candidate, expected, label) {
  if (candidate !== expected) throw new TypeError(`${label} is invalid.`);
}

function requirePattern(candidate, pattern, label) {
  if (typeof candidate !== "string" || !pattern.test(candidate)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function runCli() {
  if (process.argv.length !== 4 || process.argv[2] !== "verify") {
    throw new TypeError("Usage: node scripts/native-ci-evidence.mjs verify <evidence.json>");
  }
  const evidence = verifyNativeCiEvidenceFile(process.argv[3]);
  process.stdout.write(
    `HostDeck native CI evidence verified: ${evidence.target}, ${evidence.checks.length} checks.\n`
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Native CI evidence verification failed."}\n`
    );
    process.exitCode = 1;
  }
}
