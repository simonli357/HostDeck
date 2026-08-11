import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const safeTokenPattern = /^[A-Za-z0-9._+-]{1,128}$/u;
const codexVersion = "0.144.0";
const codexBindingId =
  "codex-app-server-0.144.0-experimental:sha256:e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24";
const codexPackageIntegrity =
  "sha512-QFh6f+v5QUx/Vg0HjIl9HB94p7aDLBDkZjc4IXX5RXUcXHPVCZNb6Hl2R49Og/fqW7orgZkeDcgWfRANUa1WoQ==";
const codexWindowsPackageIntegrity =
  "sha512-QiholLCYqNeYvNM77HOmPtrOFrY0rQc/N9nXt+sQGXO3rEGmcWjpLzujY4Oegl3CLRHoieWqlep3EqEvFBjoIA==";
const codexWindowsBinarySha256 =
  "2b3c18d9393ed794531ae3da13f43a6de3bcd91dc577222bd31a17c59f7de0aa";

export const windowsCodexSpikeRuntimePolicy = Object.freeze({
  binding_id: codexBindingId,
  cli_version: codexVersion,
  native_binary_sha256: codexWindowsBinarySha256,
  native_package_integrity: codexWindowsPackageIntegrity,
  package_integrity: codexPackageIntegrity,
  target: "x86_64-pc-windows-msvc"
});

export function createWindowsCodexSpikeEvidence(input) {
  const value = exactRecord(
    input,
    ["generated_at", "observations", "runner", "runtime", "source", "workflow"],
    "input"
  );
  const source = exactRecord(value.source, ["commit", "lockfile_sha256"], "source");
  requirePattern(source.commit, commitPattern, "source.commit");
  requirePattern(source.lockfile_sha256, sha256Pattern, "source.lockfile_sha256");
  const workflow = exactRecord(
    value.workflow,
    ["run_attempt", "run_id"],
    "workflow"
  );
  exactInteger(workflow.run_attempt, 1, 1_000, "workflow.run_attempt");
  requirePattern(workflow.run_id, /^[1-9][0-9]{0,19}$/u, "workflow.run_id");
  const runner = exactRecord(
    value.runner,
    ["architecture", "image_version", "label", "node_platform", "os_release"],
    "runner"
  );
  exactString(runner.architecture, "x64", "runner.architecture");
  requirePattern(runner.image_version, safeTokenPattern, "runner.image_version");
  exactString(runner.label, "windows-2022", "runner.label");
  exactString(runner.node_platform, "win32", "runner.node_platform");
  requirePattern(runner.os_release, safeTokenPattern, "runner.os_release");
  const runtime = exactRecord(
    value.runtime,
    [
      "binding_id",
      "cli_version",
      "native_binary_sha256",
      "native_package_integrity",
      "package_integrity",
      "target"
    ],
    "runtime"
  );
  for (const [key, expected] of Object.entries(windowsCodexSpikeRuntimePolicy)) {
    exactString(runtime[key], expected, `runtime.${key}`);
  }
  const observations = parseObservations(value.observations);
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
    task_id: "INT-V1-100",
    status: "passed",
    generated_at: value.generated_at,
    workflow: { ...workflow },
    source: { ...source },
    runner: { ...runner },
    runtime: { ...runtime },
    observations
  });
}

export function parseWindowsCodexSpikeEvidence(candidate) {
  const value = exactRecord(
    candidate,
    [
      "generated_at",
      "observations",
      "runner",
      "runtime",
      "schema_version",
      "source",
      "status",
      "task_id",
      "workflow"
    ],
    "evidence"
  );
  exactInteger(value.schema_version, 1, 1, "evidence.schema_version");
  exactString(value.task_id, "INT-V1-100", "evidence.task_id");
  exactString(value.status, "passed", "evidence.status");
  return createWindowsCodexSpikeEvidence({
    generated_at: value.generated_at,
    observations: value.observations,
    runner: value.runner,
    runtime: value.runtime,
    source: value.source,
    workflow: value.workflow
  });
}

export function serializeWindowsCodexSpikeEvidence(candidate) {
  const serialized = `${JSON.stringify(
    parseWindowsCodexSpikeEvidence(candidate),
    null,
    2
  )}\n`;
  if (
    Buffer.byteLength(serialized, "utf8") > 32 * 1024 ||
    /https?:\/\/|[A-Za-z]:\\|\/(?:home|Users)\/|bearer\s+|\.ts\.net/iu.test(
      serialized
    )
  ) {
    throw new TypeError(
      "Windows Codex spike evidence contains private material or exceeds its bound."
    );
  }
  return serialized;
}

export function writeWindowsCodexSpikeEvidence(path, candidate) {
  const outputPath = resolve(path);
  const evidence = createWindowsCodexSpikeEvidence(candidate);
  const serialized = serializeWindowsCodexSpikeEvidence(evidence);
  const digest = createHash("sha256").update(serialized).digest("hex");
  mkdirSync(dirname(outputPath), { mode: 0o700, recursive: true });
  writeFileSync(outputPath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  writeFileSync(`${outputPath}.sha256`, `${digest}  ${basename(outputPath)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze({ digest, evidence, path: outputPath });
}

export function verifyWindowsCodexSpikeEvidenceFile(path) {
  const outputPath = resolve(path);
  const bytes = readFileSync(outputPath);
  if (bytes.byteLength < 2 || bytes.byteLength > 32 * 1024) {
    throw new TypeError("Windows Codex spike evidence file size is invalid.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const evidence = parseWindowsCodexSpikeEvidence(JSON.parse(text));
  if (serializeWindowsCodexSpikeEvidence(evidence) !== text) {
    throw new TypeError("Windows Codex spike evidence is not canonical.");
  }
  const digest = createHash("sha256").update(text).digest("hex");
  const sidecar = readFileSync(`${outputPath}.sha256`, "utf8");
  if (sidecar !== `${digest}  ${basename(outputPath)}\n`) {
    throw new TypeError("Windows Codex spike evidence digest is invalid.");
  }
  return evidence;
}

function parseObservations(candidate) {
  const value = exactRecord(
    candidate,
    [
      "authentication",
      "capabilities",
      "initialization",
      "multi_client",
      "privacy",
      "process",
      "resume",
      "shutdown"
    ],
    "observations"
  );
  const authentication = exactRecord(
    value.authentication,
    ["accepted", "invalid_status", "missing_status", "origin_status"],
    "observations.authentication"
  );
  exactBoolean(authentication.accepted, true, "observations.authentication.accepted");
  exactInteger(authentication.invalid_status, 401, 401, "observations.authentication.invalid_status");
  exactInteger(authentication.missing_status, 401, 401, "observations.authentication.missing_status");
  exactInteger(authentication.origin_status, 403, 403, "observations.authentication.origin_status");
  const capabilities = exactRecord(
    value.capabilities,
    ["collaboration_modes", "experimental_api"],
    "observations.capabilities"
  );
  exactArray(capabilities.collaboration_modes, ["default", "plan"], "observations.capabilities.collaboration_modes");
  exactBoolean(capabilities.experimental_api, true, "observations.capabilities.experimental_api");
  const initialization = exactRecord(
    value.initialization,
    ["client_name", "platform_family", "platform_os", "version_corroborated"],
    "observations.initialization"
  );
  exactString(initialization.client_name, "hostdeck-windows-spike", "observations.initialization.client_name");
  exactString(initialization.platform_family, "windows", "observations.initialization.platform_family");
  exactString(initialization.platform_os, "windows", "observations.initialization.platform_os");
  exactBoolean(initialization.version_corroborated, true, "observations.initialization.version_corroborated");
  const multiClient = exactRecord(
    value.multi_client,
    ["initialized_clients", "survived_peer_close"],
    "observations.multi_client"
  );
  exactInteger(multiClient.initialized_clients, 2, 2, "observations.multi_client.initialized_clients");
  exactBoolean(multiClient.survived_peer_close, true, "observations.multi_client.survived_peer_close");
  const processObservation = exactRecord(
    value.process,
    ["address", "argv_clean", "credential_acl", "listener_count"],
    "observations.process"
  );
  exactString(processObservation.address, "127.0.0.1", "observations.process.address");
  exactBoolean(processObservation.argv_clean, true, "observations.process.argv_clean");
  exactString(processObservation.credential_acl, "current-user-only", "observations.process.credential_acl");
  exactInteger(processObservation.listener_count, 1, 1, "observations.process.listener_count");
  const resume = exactRecord(
    value.resume,
    ["credential_via_environment", "rendered_thread", "thread_turn_count"],
    "observations.resume"
  );
  exactBoolean(resume.credential_via_environment, true, "observations.resume.credential_via_environment");
  exactBoolean(resume.rendered_thread, true, "observations.resume.rendered_thread");
  exactInteger(resume.thread_turn_count, 0, 0, "observations.resume.thread_turn_count");
  const privacy = exactRecord(
    value.privacy,
    ["capture_scanned", "credential_value_found"],
    "observations.privacy"
  );
  exactBoolean(privacy.capture_scanned, true, "observations.privacy.capture_scanned");
  exactBoolean(privacy.credential_value_found, false, "observations.privacy.credential_value_found");
  const shutdown = exactRecord(
    value.shutdown,
    ["credential_file_removed", "listener_closed", "process_exited"],
    "observations.shutdown"
  );
  exactBoolean(shutdown.credential_file_removed, true, "observations.shutdown.credential_file_removed");
  exactBoolean(shutdown.listener_closed, true, "observations.shutdown.listener_closed");
  exactBoolean(shutdown.process_exited, true, "observations.shutdown.process_exited");
  return deepFreeze({
    authentication: { ...authentication },
    capabilities: {
      collaboration_modes: [...capabilities.collaboration_modes],
      experimental_api: capabilities.experimental_api
    },
    initialization: { ...initialization },
    multi_client: { ...multiClient },
    process: { ...processObservation },
    resume: { ...resume },
    privacy: { ...privacy },
    shutdown: { ...shutdown }
  });
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
  if (!Array.isArray(candidate) || JSON.stringify(candidate) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function exactBoolean(candidate, expected, label) {
  if (candidate !== expected) throw new TypeError(`${label} is invalid.`);
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
    throw new TypeError(
      "Usage: node scripts/windows-codex-spike-evidence.mjs verify <evidence.json>"
    );
  }
  const evidence = verifyWindowsCodexSpikeEvidenceFile(process.argv[3]);
  process.stdout.write(
    `Windows Codex spike evidence verified: ${evidence.runtime.cli_version}.\n`
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
      `${error instanceof Error ? error.message : "Windows Codex spike evidence verification failed."}\n`
    );
    process.exitCode = 1;
  }
}
